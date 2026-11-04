#!/usr/bin/env python3
"""Check JavaDoc on methods and fields added since a base revision.

Only declarations whose first line is an added line in `git diff <base>` are
checked, so existing code is never reported. Reports:
  - method without JavaDoc, or JavaDoc without a purpose sentence
  - parameter without a non-empty `@param`, non-void method without `@return`
  - field or constant without JavaDoc
  - method body of at least --min-body lines without any // step comment
Exempt: getter/setter/one-line delegation bodies, `@Override` methods (doc is
on the interface), `serialVersionUID`, loggers and injected (`@Autowired`,
`@Resource`) fields.

Exit code 0 when clean, 1 when issues are found, 2 on usage errors.
"""
import argparse
import re
import subprocess
import sys

CONTROL = {"if", "for", "while", "switch", "catch", "return", "new", "else", "synchronized", "throw", "try"}
METHOD_RE = re.compile(
    r"^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?P<mods>(?:(?:public|protected|private|static|final|abstract|synchronized|default|native)\s+)*)"
    r"(?:<[^>]+>\s+)?(?P<type>[\w$.<>\[\],? ]+?)\s+(?P<name>[\w$]+)\s*\((?P<rest>.*)$")
CTOR_RE = re.compile(r"^\s*(?P<mods>(?:(?:public|protected|private)\s+)+)(?P<name>[A-Z][\w$]*)\s*\((?P<rest>.*)$")
FIELD_RE = re.compile(
    r"^\s*(?P<mods>(?:(?:public|protected|private|static|final|volatile|transient)\s+)*)"
    r"(?P<type>[\w$.<>\[\],? ]+?)\s+(?P<name>[\w$]+)\s*(?:=[^;]*)?;\s*(?://.*)?$")
INJECT = ("@Autowired", "@Resource", "@Inject", "@Value")
MIN_BODY = 12


def added_lines(repo, base, path):
    out = subprocess.run(["git", "-C", repo, "diff", "-U0", base, "--", path],
                         capture_output=True, text=True, check=True).stdout
    lines = set()
    for m in re.finditer(r"^@@ -\S+ \+(\d+)(?:,(\d+))? @@", out, re.M):
        start, count = int(m.group(1)), int(m.group(2) or 1)
        lines.update(range(start, start + count))
    return lines


def changed_files(repo, base):
    out = subprocess.run(["git", "-C", repo, "diff", "--name-only", "--diff-filter=AM", base, "--", "*.java"],
                         capture_output=True, text=True, check=True).stdout
    return [f for f in out.split() if "/src/test/" not in f]


def split_params(text):
    params, depth, cur = [], 0, ""
    for ch in text:
        if ch == "<":
            depth += 1
        elif ch == ">":
            depth -= 1
        if ch == "," and depth == 0:
            params.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        params.append(cur)
    names = []
    for p in params:
        p = re.sub(r"@\w+(\([^)]*\))?", "", p).strip()
        if p:
            names.append(p.split()[-1].replace("...", ""))
    return names


def doc_above(lines, idx):
    """Return (javadoc text or None, annotations) for the declaration at idx (0-based)."""
    annotations = []
    i = idx - 1
    while i >= 0 and (lines[i].strip().startswith("@") or not lines[i].strip()):
        if lines[i].strip():
            annotations.append(lines[i].strip())
        if not lines[i].strip() and annotations == [] and i < idx - 1:
            break
        i -= 1
    if i >= 0 and lines[i].strip().endswith("*/"):
        end = i
        while i >= 0 and "/**" not in lines[i]:
            if lines[i].strip().startswith("/*") and "/**" not in lines[i]:
                return None, annotations
            i -= 1
        if i >= 0:
            return "\n".join(lines[i:end + 1]), annotations
    return None, annotations


def doc_tags(doc):
    body = [re.sub(r"^\s*(/\*\*|\*/|\*)\s?", "", l).rstrip() for l in doc.splitlines()]
    body = [l.replace("*/", "").strip() for l in body]
    purpose = any(l and not l.startswith("@") for l in body)
    params, has_return = {}, False
    cur = None
    for l in body:
        m = re.match(r"@param\s+(\S+)\s*(.*)", l)
        if m:
            cur = m.group(1)
            params[cur] = m.group(2).strip()
            continue
        m = re.match(r"@return\s*(.*)", l)
        if m:
            has_return = bool(m.group(1).strip())
            cur = None
            continue
        if l.startswith("@"):
            cur = None
        elif cur and l:
            params[cur] = (params[cur] + " " + l).strip()
    return purpose, params, has_return


def body_lines(lines, idx):
    """Count statement lines in the method body starting at declaration idx."""
    depth, started, count = 0, False, 0
    for j in range(idx, min(len(lines), idx + 400)):
        line = lines[j]
        if started and line.strip() and line.strip() not in ("}",):
            count += 1
        for ch in line:
            if ch == "{":
                depth += 1
                started = True
            elif ch == "}":
                depth -= 1
                if started and depth == 0:
                    return count
        if not started and line.rstrip().endswith(";"):
            return 0
    return count


def strip_literals(line):
    line = re.sub(r'"(?:\\.|[^"\\])*"', '""', line)
    line = re.sub(r"'(?:\\.|[^'\\])'", "''", line)
    return line.split("//")[0]


def is_method(m, line):
    name = m.group("name")
    ret = (m.groupdict().get("type") or "").strip()
    if name in CONTROL or ret.split()[-1:] and ret.split()[-1] in CONTROL:
        return False
    return "=" not in line.split("(")[0]


def check_file(repo, base, path):
    issues = []
    added = added_lines(repo, base, path)
    lines = open("%s/%s" % (repo, path), encoding="utf-8").read().split("\n")
    depth = 0
    type_depths = []
    in_comment = False
    for idx, line in enumerate(lines):
        stripped = line.strip()
        code = strip_literals(line)
        at_type_level = bool(type_depths) and depth == type_depths[-1]
        if in_comment or stripped.startswith("/*"):
            in_comment = "*/" not in stripped
            continue
        if re.search(r"\b(class|interface|enum)\s+\w+", code) and not stripped.startswith("*"):
            depth += code.count("{") - code.count("}")
            if "{" in code:
                type_depths.append(depth)
            continue
        if at_type_level and idx + 1 in added and not stripped.startswith(("//", "@", "}")):
            m = CTOR_RE.match(line) or METHOD_RE.match(line)
            f = FIELD_RE.match(line)
            if m and is_method(m, line):
                issues.extend(check_method(lines, idx, m, path))
            elif f:
                issues.extend(check_field(lines, idx, f, path))
        depth += code.count("{") - code.count("}")
        while type_depths and depth < type_depths[-1]:
            type_depths.pop()
    return issues


def check_method(lines, idx, m, path):
    sig = m.group("rest")
    j = idx
    while ")" not in sig and j + 1 < len(lines):
        j += 1
        sig += " " + lines[j].strip()
    names = split_params(sig.split(")")[0])
    name = m.group("name")
    ret = (m.groupdict().get("type") or "").strip()
    doc, annotations = doc_above(lines, idx)
    where = "%s:%d %s()" % (path, idx + 1, name)
    if any(a.startswith("@Override") for a in annotations):
        return []
    if re.match(r"(get|set|is)[A-Z]", name) and body_lines(lines, idx) <= 1:
        return []
    issues = []
    body, comments = body_stats(lines, idx)
    if body >= MIN_BODY and comments == 0:
        issues.append("%s 方法体 %d 行没有方法内注释，按步骤补充说明" % (where, body))
    if doc is None:
        return issues + [where + " 缺少 JavaDoc"]
    purpose, params, has_return = doc_tags(doc)
    if not purpose:
        issues.append(where + " JavaDoc 缺少用途说明")
    for p in names:
        if not params.get(p):
            issues.append("%s 缺少 @param %s 或描述为空" % (where, p))
    if ret and ret != "void" and not CTOR_RE.match(lines[idx]) and not has_return:
        issues.append(where + " 缺少 @return 或描述为空")
    return issues


def body_stats(lines, idx):
    """Return (non-blank statement lines, // comment lines) of the method body declared at idx."""
    depth, started, body, comments = 0, False, 0, 0
    for j in range(idx, len(lines)):
        stripped = lines[j].strip()
        if started and stripped and stripped != "}":
            body += 1
            if stripped.startswith("//"):
                comments += 1
        code = strip_literals(lines[j])
        depth += code.count("{") - code.count("}")
        if "{" in code:
            started = True
        if started and depth <= 0:
            break
        if not started and stripped.endswith(";"):
            break
    return body, comments


def check_field(lines, idx, f, path):
    name = f.group("name")
    if name == "serialVersionUID" or re.search(r"\b(Logger|Log)\b", f.group("type")):
        return []
    doc, annotations = doc_above(lines, idx)
    if any(a.startswith(INJECT) for a in annotations) or doc is not None:
        return []
    # 名称与含义完全一致的ID字段可省
    if re.search(r"Id$", name) and f.group("type").split()[-1] in ("Integer", "Long", "String", "int", "long"):
        return []
    if under_group_comment(lines, idx):
        return []
    return ["%s:%d 字段 %s 缺少 JavaDoc" % (path, idx + 1, name)]


def under_group_comment(lines, idx):
    """字段上方隔着同组字段和空行有一段 /* ... */ 分组注释（不是 JavaDoc）时，视为整组已说明"""
    i = idx - 1
    while i >= 0:
        stripped = lines[i].strip()
        if not stripped or FIELD_RE.match(lines[i]):
            i -= 1
            continue
        if stripped.endswith("*/"):
            while i >= 0 and not lines[i].strip().startswith("/*"):
                i -= 1
            if i >= 0 and lines[i].strip().startswith("/**"):
                # 组内其他字段自己的 JavaDoc，跳过继续向上找分组注释
                i -= 1
                continue
            return i >= 0
        return False
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=".")
    ap.add_argument("--base", required=True, help="base revision, e.g. origin/master or a merge-base commit")
    ap.add_argument("--min-body", type=int, default=12,
                    help="report methods whose body has at least this many lines and no // comment")
    ap.add_argument("files", nargs="*", help="limit to these repo-relative files")
    args = ap.parse_args()
    global MIN_BODY
    MIN_BODY = args.min_body
    try:
        files = args.files or changed_files(args.repo, args.base)
    except subprocess.CalledProcessError as e:
        print(e.stderr, file=sys.stderr)
        return 2
    issues = []
    for path in files:
        issues.extend(check_file(args.repo, args.base, path))
    for i in issues:
        print(i)
    print("checked %d file(s), %d issue(s)" % (len(files), len(issues)))
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
