"""Structural lint for skills (borrowed from addyosmani/agent-skills' skill-lint) plus the
portability rules (CHG-013):

- frontmatter name matches the directory; description exists, contains "Use when"
  and stays within 1024 characters;
- backticked skill-style references point at real skills (or a curated allowlist
  of non-skill identifiers);
- a SKILL.md whose content changed against HEAD carries a bumped metadata.version;
- six portability rules over the controlled scope (files `git ls-files -co --exclude-standard`
  lists under skills/ agents/ hooks/ bin/ tools/ mcp/ tests/ evals/ env/ lib/ plus install.py,
  AGENTS*.md, README.md; docs/, node_modules, vendor and gitignored files are out of scope):
  1. no machine-local path literal (the five prefixes in MACHINE_PATH_PREFIXES: Linux and macOS
     home directories, the two WSL Windows drive mounts, the systemd %h home specifier) or
     identifier (tests/lint_forbidden_identifiers.json, word-bounded), except the prefixes and
     per-file literals in tests/lint_allowlist.json; the two config files are not scanned;
  2. every `$AGENT_TOOLS_ROOT/<path>` and `{{AGENT_TOOLS_ROOT}}/<path>` reference exists in the repo;
  3. `scripts/...` and `references/...` references in SKILL.md and references/*.md exist in that skill
     (a bare `scripts/` or `references/` describes the layout and is skipped);
  4. scripts under skills/*/*/scripts/ reach other skills only via skillDir()/repoRoot(): no
     `skills/<category>/<other skill>` literal, and no `../` string literal climbing above the skill dir;
  5. scripts under skills/*/*/scripts/, tools/, bin/ do not spell `tools/lexiao-browser`,
     `chrome-linux64` or `runtime-libs` (setup_browser_tool.sh excepted);
  6. a bootstrap block (start marker to `agent-tools bootstrap end`) equals the template for the
     file's extension in lib/agent_tools/bootstrap.{js,mjs,py} byte for byte.

Rules 1-6 only print their hits unless AGENT_TOOLS_LINT_ENFORCE is set to a value other than
"0" (DEFAULT_ENFORCE flips to "1" in stage 4 of the migration).
"""

import json
import os
import sys
import re
import subprocess
from pathlib import Path
import unittest

REPO = Path(__file__).parents[1]
SKILLS = sorted(REPO.glob("skills/*/*/SKILL.md"))
FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---", re.S)
DESC = re.compile(r"^description:\s*(.*?)(?=^\w[\w-]*:|\Z)", re.S | re.M)
VERSION = re.compile(r"^\s+version:\s*\"?([0-9][\w.\-]*)\"?", re.M)
REF = re.compile(r"`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`")

# Identifiers that look like skill names but are gate names, categories, tools or
# schema names. Extend deliberately; do not silence a real dead reference here.
NOT_SKILLS = {
    "dev-workflow", "dev-quality", "solution-review", "test-design-review",
    "change-review", "requirements-review-round", "redis-cli", "query-range-batch",
    "java-backend-mcp", "verify-execute", "read-only", "write-set", "agent-tools",
    "direct-record-v1", "waiver-record-v1", "approval-record-v1", "repo-snapshot-v1",
    "delegation-result-v1", "producer-stage-result-v1", "auto-loop-run-v1",
    "inspect-sections",  # manage-feishu-doc 脚本的子命令
}
SKILL_PREFIXES = ("dev-", "query-", "review-", "verify-", "lang-", "inspect-", "configure-",
                  "register-", "lexiao-", "handle-", "diagnose-", "java-", "jenkins-", "fix-",
                  "start-", "test-", "redis-", "spawn-", "build-", "debug-", "skill-",
                  "convert-", "manage-", "healthy-", "requirements-")


def frontmatter(text: str) -> str:
    m = FRONTMATTER.match(text)
    return m.group(1) if m else ""


def description(text: str) -> str:
    m = DESC.search(frontmatter(text))
    if not m:
        return ""
    return " ".join(line.strip() for line in m.group(1).strip().splitlines()).strip().strip('"').strip("'")


def git_show_head(path: Path) -> str | None:
    rel = path.relative_to(REPO).as_posix()
    proc = subprocess.run(["git", "show", f"HEAD:{rel}"], cwd=REPO, capture_output=True, text=True)
    return proc.stdout if proc.returncode == 0 else None


class SkillLintTest(unittest.TestCase):
    def test_frontmatter_name_and_description(self):
        problems = []
        for path in SKILLS:
            text = path.read_text(encoding="utf-8")
            fm = frontmatter(text)
            name = re.search(r"^name:\s*(\S+)", fm, re.M)
            if not name or name.group(1) != path.parent.name:
                problems.append(f"{path.parent.name}: frontmatter name missing or != directory")
            desc = description(text)
            if not desc:
                problems.append(f"{path.parent.name}: description missing")
            elif "Use when" not in desc:
                problems.append(f"{path.parent.name}: description lacks 'Use when' trigger")
            if len(desc) > 1024:
                problems.append(f"{path.parent.name}: description is {len(desc)} chars (> 1024)")
        self.assertEqual([], problems, "\n".join(problems))

    def test_backticked_skill_references_exist(self):
        known = {p.parent.name for p in SKILLS} | {"get-browser-session", "tapd-download", "gstack"}
        files = SKILLS + sorted(REPO.glob("skills/**/references/**/*.md")) + sorted(REPO.glob("agents/*/*")) + [REPO / "AGENTS.md"]
        problems = []
        for path in files:
            text = path.read_text(encoding="utf-8", errors="ignore")
            for ref in set(REF.findall(text)):
                if ref in known or ref in NOT_SKILLS or not ref.startswith(SKILL_PREFIXES):
                    continue
                problems.append(f"{path.relative_to(REPO)}: `{ref}` is not a skill (add to NOT_SKILLS if it is a tool or gate name)")
        self.assertEqual([], problems, "\n".join(problems))

    def test_changed_skill_bumps_version(self):
        problems = []
        for path in SKILLS:
            head = git_show_head(path)
            if head is None:
                continue  # new, untracked skill
            current = path.read_text(encoding="utf-8")
            if current == head:
                continue
            old = VERSION.search(frontmatter(head))
            new = VERSION.search(frontmatter(current))
            if old and new and old.group(1) == new.group(1):
                problems.append(f"{path.parent.name}: content changed since HEAD but metadata.version is still {new.group(1)}")
        self.assertEqual([], problems, "\n".join(problems))



# ---------------------------------------------------------------------------
# Portability rules (CHG-013)

DEFAULT_ENFORCE = "0"  # 阶段 4（DEV-019）改为 "1"
ENFORCE = os.environ.get("AGENT_TOOLS_LINT_ENFORCE", DEFAULT_ENFORCE) != "0"
FORBIDDEN_FILE = REPO / "tests/lint_forbidden_identifiers.json"
ALLOWLIST_FILE = REPO / "tests/lint_allowlist.json"
SCOPE_PREFIXES = ("skills/", "agents/", "hooks/", "bin/", "tools/", "mcp/", "tests/", "evals/", "env/", "lib/")
SCOPE_FILES = ("install.py", "README.md")
EXCLUDED_PARTS = {"docs", "node_modules", "vendor"}
# 模式拼接而非字面量，使本文件自身不命中规则一
MACHINE_PATH_PREFIXES = ["/" + "home/", "/" + "Users/", "/" + "mnt/c/", "/" + "mnt/d/", "%h" + "/projects"]
TOKEN_CHARS = r"[^\s\"'`<>()\[\]{}，。；：、]"
MACHINE_PATH = re.compile("(?:" + "|".join(re.escape(p) for p in MACHINE_PATH_PREFIXES) + ")" + TOKEN_CHARS + "*")
ROOT_REF = re.compile(r"(?:\$AGENT_TOOLS_ROOT|\{\{AGENT_TOOLS_ROOT\}\})/(" + TOKEN_CHARS + "*)")
RELATIVE_REF = re.compile(r"(?<![\w/.\-])(?:\./)?((?:scripts|references)/[^\s`\"'()\[\]<>:，。；、]*)")
PARENT_LITERAL = re.compile(r"""['"`]((?:\.\./)+)""")
BOOTSTRAP_START = re.compile(r"^(?://|#) agent-tools bootstrap（")
BOOTSTRAP_END = re.compile(r"^(?://|#) agent-tools bootstrap end\s*$")
BOOTSTRAP_TEMPLATES = {".js": "bootstrap.js", ".mjs": "bootstrap.mjs", ".py": "bootstrap.py"}
BROWSER_LITERALS = ("tools/lexiao-browser", "chrome-linux64", "runtime-libs")
BROWSER_EXEMPT = {"skills/lexin/get-browser-session/scripts/setup_browser_tool.sh"}
TRAILING_PUNCT = ".,;:)"


def controlled_files() -> list[str]:
    out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=REPO, capture_output=True, check=True).stdout
    files = []
    for rel in out.decode("utf-8").split("\0"):
        if not rel:
            continue
        parts = rel.split("/")
        if EXCLUDED_PARTS.intersection(parts):
            continue
        is_agents_md = len(parts) == 1 and rel.startswith("AGENTS") and rel.endswith(".md")
        if not (rel.startswith(SCOPE_PREFIXES) or rel in SCOPE_FILES or is_agents_md):
            continue
        if (REPO / rel).is_file():
            files.append(rel)
    return files


def read_text(rel: str) -> str | None:
    data = (REPO / rel).read_bytes()
    if b"\0" in data:
        return None
    return data.decode("utf-8", errors="ignore")


def skill_of(rel: str) -> tuple[str, str] | None:
    parts = rel.split("/")
    if len(parts) >= 4 and parts[0] == "skills":
        return parts[1], parts[2]
    return None


def is_skill_script(rel: str) -> bool:
    parts = rel.split("/")
    if len(parts) < 5 or parts[0] != "skills" or parts[3] != "scripts":
        return False
    if "tests" in parts[4:] or not rel.endswith((".js", ".mjs", ".py")):
        return False
    name = parts[-1]
    return not (name.endswith((".test.js", ".test.mjs")) or name.startswith("test_"))


def strip_ref(ref: str) -> str:
    return ref.rstrip(TRAILING_PUNCT)


class PortabilityLintTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = controlled_files()
        cls.texts = {rel: text for rel in cls.files if (text := read_text(rel)) is not None}
        words = json.loads(FORBIDDEN_FILE.read_text(encoding="utf-8"))
        cls.identifier = re.compile(r"(?<![A-Za-z0-9_])(?:" + "|".join(re.escape(w) for w in words) + r")(?![A-Za-z0-9_])")
        allow = json.loads(ALLOWLIST_FILE.read_text(encoding="utf-8"))
        cls.allowed_prefixes = tuple(allow["allowed_prefixes"])
        cls.allowed_literals = {(item["file"], item["literal"]) for item in allow["allowed_literals"]}
        cls.categories = sorted(p.name for p in (REPO / "skills").iterdir() if p.is_dir())

    def report(self, rule: str, hits: list[str]) -> None:
        if not hits:
            return
        message = f"[lint {rule}] {len(hits)} hit(s):\n" + "\n".join(hits)
        if ENFORCE:
            self.fail(message)
        print(f"\n{message}\n  (warn mode; set AGENT_TOOLS_LINT_ENFORCE=1 to fail)", file=sys.stderr)

    def lines_with(self, rel: str, pattern: re.Pattern):
        for number, line in enumerate(self.texts[rel].splitlines(), 1):
            for match in pattern.finditer(line):
                yield number, match

    def test_no_machine_paths(self):
        config = {FORBIDDEN_FILE.relative_to(REPO).as_posix(), ALLOWLIST_FILE.relative_to(REPO).as_posix()}
        hits = []
        for rel in self.texts:
            if rel in config:
                continue
            for number, line in enumerate(self.texts[rel].splitlines(), 1):
                paths = list(MACHINE_PATH.finditer(line))
                spans = [m.span() for m in paths]
                # 标识符落在路径命中之内时（家目录里的用户名）只报路径这一次
                identifiers = [m for m in self.identifier.finditer(line) if not any(a <= m.start() < b for a, b in spans)]
                for match in paths + identifiers:
                    token = match.group(0)
                    if token.startswith(self.allowed_prefixes) or (rel, token) in self.allowed_literals:
                        continue
                    hits.append(f"{rel}:{number}: {token}")
        self.report("rule 1 machine path / identifier", hits)

    def test_agent_tools_root_references_exist(self):
        hits = []
        for rel in self.texts:
            for number, match in self.lines_with(rel, ROOT_REF):
                ref = strip_ref(match.group(1))
                if not ref or any(c in ref for c in "<>*"):
                    continue
                if not (REPO / ref).exists():
                    hits.append(f"{rel}:{number}: {match.group(0)}")
        self.report("rule 2 $AGENT_TOOLS_ROOT reference", hits)

    def test_relative_references_exist(self):
        hits = []
        for rel in self.texts:
            owner = skill_of(rel)
            if not owner or not rel.endswith(".md"):
                continue
            parts = rel.split("/")
            if not (parts[3] == "SKILL.md" or parts[3] == "references"):
                continue
            skill_dir = REPO / "skills" / owner[0] / owner[1]
            for number, match in self.lines_with(rel, RELATIVE_REF):
                ref = strip_ref(match.group(1))
                if any(c in ref for c in "<>*") or ref in ("scripts/", "references/"):
                    continue  # 光秃的目录名是在描述 skill 布局，不是文件引用
                if not (skill_dir / ref).exists():
                    hits.append(f"{rel}:{number}: {ref}")
        self.report("rule 3 scripts/ references/ reference", hits)

    def test_scripts_reach_other_skills_via_skill_dir(self):
        other_skill = re.compile(r"skills/(?:" + "|".join(map(re.escape, self.categories)) + r")/([A-Za-z0-9_\-]+)")
        hits = []
        for rel in self.texts:
            if not is_skill_script(rel):
                continue
            own = skill_of(rel)[1]
            depth = len(rel.split("/")) - 4  # scripts/x.py -> 1, scripts/lib/x.py -> 2
            for number, match in self.lines_with(rel, other_skill):
                if match.group(1) != own:
                    hits.append(f"{rel}:{number}: {match.group(0)} (use skillDir)")
            for number, match in self.lines_with(rel, PARENT_LITERAL):
                climbs = match.group(1).count("../")
                if climbs > depth:
                    hits.append(f"{rel}:{number}: {match.group(0)} climbs {climbs} > depth {depth}")
        self.report("rule 4 cross-skill reference", hits)

    def test_browser_scripts_have_no_linux_path_literals(self):
        hits = []
        for rel in self.texts:
            parts = rel.split("/")
            in_scope = rel.startswith(("tools/", "bin/")) or (parts[0] == "skills" and len(parts) >= 5 and parts[3] == "scripts")
            if not in_scope or rel in BROWSER_EXEMPT:
                continue
            for number, line in enumerate(self.texts[rel].splitlines(), 1):
                for literal in BROWSER_LITERALS:
                    if literal in line:
                        hits.append(f"{rel}:{number}: {literal}")
        self.report("rule 5 browser path literal", hits)

    def test_bootstrap_blocks_match_template(self):
        hits = []
        for rel in self.texts:
            ext = Path(rel).suffix
            if ext not in BOOTSTRAP_TEMPLATES or rel.startswith("lib/agent_tools/bootstrap."):
                continue
            lines = self.texts[rel].splitlines()
            starts = [i for i, line in enumerate(lines) if BOOTSTRAP_START.match(line)]
            if not starts:
                continue
            ends = [i for i, line in enumerate(lines) if BOOTSTRAP_END.match(line)]
            if len(starts) != 1 or len(ends) != 1 or ends[0] < starts[0]:
                hits.append(f"{rel}: bootstrap markers malformed (starts={len(starts)}, ends={len(ends)})")
                continue
            block = "\n".join(lines[starts[0]:ends[0] + 1])
            template = (REPO / "lib/agent_tools" / BOOTSTRAP_TEMPLATES[ext]).read_text(encoding="utf-8").rstrip("\n")
            if block != template:
                hits.append(f"{rel}:{starts[0] + 1}: bootstrap block differs from lib/agent_tools/{BOOTSTRAP_TEMPLATES[ext]}")
        self.report("rule 6 bootstrap template", hits)


if __name__ == "__main__":
    unittest.main()
