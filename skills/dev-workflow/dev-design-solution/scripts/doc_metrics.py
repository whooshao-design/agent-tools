#!/usr/bin/env python3
"""Advisory readability metrics for a solution.md written under writing-principles.md.

usage: python3 doc_metrics.py <solution.md> [--traceability traceability.md] [--json]

Prints a metrics table plus a list of flags. Flags are structure-review signals, not gates;
the only hard checks are the ones the template itself requires (summary present and short,
related-docs block present, headings referenced by traceability exist).
Exit code 0 always, unless a file cannot be read.
"""
import argparse
import json
import re
import sys

NEGATION = re.compile(r"不得|不能|必须|禁止|严禁|不要|不应")
ID_REF = re.compile(r"\b(AC|DEC|CHG|RISK|TC|E|F|SR\d*)-\d+\b")
ID_WITH_NAME = re.compile(r"[一-鿿A-Za-z][^()（）\n]{1,40}[（(](AC|DEC|CHG|RISK|TC|E)-\d+")
REVISION_TRACE = re.compile(r"关闭 (F|SR\d*|TR)-\d+|v\d+ (订正|新增|修正|补)")
BOLD_LABEL = re.compile(r"^\s*[-*]?\s*\*\*[^*]{1,20}\*\*[：:]")
STOCK = re.compile(r"综合考虑|通过上述方案|需要注意的是|值得一提|值得注意的是|一句话总结|核心结论[:：]")
SENT_END = re.compile(r"[。！？；!?;]")
INLINE_CODE = re.compile(r"`[^`\n]+`")
GLOSSARY_HEADER = re.compile(r"代码中的名称|代码名称|代码对象|代码位置")
CHANGE_HEADER = re.compile(r"\|\s*变更(类型)?\s*\|")
CHANGE_MARK = re.compile(r"classDef\s+(new|mod)\b|【(新增|修改)】")
LONG_PARAGRAPH_CHARS = 200


def split_sections(lines):
    sections, cur, title = [], [], "(top)"
    for ln in lines:
        m = re.match(r"^(#{1,6})\s+(.*)", ln)
        if m:
            sections.append((title, cur)); title, cur = m.group(2).strip(), []
        else:
            cur.append(ln)
    sections.append((title, cur))
    return sections


def analyze(text):
    lines = text.split("\n")
    m = {"lines": len(lines), "chars": len(text)}
    in_code, code_lines, mermaid_blocks, text_diagrams = False, 0, 0, 0
    table_rows, max_cols, long_cells, prose, bullets, nested, bold_label = 0, 0, [], 0, 0, 0, 0
    max_heading_depth = 0
    paragraphs, cur_para = [], []
    prose_chars, prose_code, all_code, has_glossary = 0, 0, 0, False
    has_change_table, marked_diagrams, cur_block, cur_lang = False, 0, [], ""

    def end_para():
        if cur_para:
            paragraphs.append("".join(cur_para))
            cur_para.clear()

    for i, ln in enumerate(lines, 1):
        if ln.startswith("```"):
            end_para()
            if in_code and cur_lang == "mermaid" and CHANGE_MARK.search("\n".join(cur_block)):
                marked_diagrams += 1
            if not in_code:
                lang = ln[3:].strip().lower()
                cur_lang, cur_block = lang, []
                if lang == "mermaid":
                    mermaid_blocks += 1
                elif lang in ("text", "") and i + 1 < len(lines) and re.search(r"[│├└─|]|-->|->", lines[i]):
                    text_diagrams += 1
            in_code = not in_code
            continue
        if in_code:
            code_lines += 1
            cur_block.append(ln)
            continue
        all_code += len(INLINE_CODE.findall(ln))
        h = re.match(r"^(#{1,6})\s", ln)
        if h:
            end_para()
            max_heading_depth = max(max_heading_depth, len(h.group(1)))
            continue
        if ln.startswith("|"):
            end_para()
            if GLOSSARY_HEADER.search(ln):
                has_glossary = True
            if CHANGE_HEADER.search(ln):
                has_change_table = True
            cells = [c.strip() for c in ln.strip().strip("|").split("|")]
            if all(re.fullmatch(r":?-{3,}:?", c) for c in cells if c):
                continue
            table_rows += 1
            max_cols = max(max_cols, len(cells))
            for c in cells:
                if len(SENT_END.findall(c)) > 2 or len(c) > 120:
                    long_cells.append((i, c[:40]))
            continue
        if re.match(r"^\s*([-*]|\d+\.)\s", ln):
            end_para()
            prose_chars += len(ln.strip())
            prose_code += len(INLINE_CODE.findall(ln))
            bullets += 1
            if re.match(r"^\s{2,}([-*]|\d+\.)\s", ln):
                nested += 1
            if BOLD_LABEL.match(ln):
                bold_label += 1
            continue
        if BOLD_LABEL.match(ln):
            bold_label += 1
        if ln.strip() and not ln.startswith(">"):
            prose += 1
            prose_chars += len(ln.strip())
            prose_code += len(INLINE_CODE.findall(ln))
            cur_para.append(ln.strip())
        else:
            end_para()
    m.update(
        prose_paragraphs=prose, bullet_lines=bullets, nested_bullets=nested, table_rows=table_rows,
        max_table_columns=max_cols, long_cells=len(long_cells), code_lines=code_lines,
        mermaid_blocks=mermaid_blocks, text_diagrams=text_diagrams, bold_label_lines=bold_label,
        max_heading_depth=max_heading_depth,
    )
    end_para()
    m["long_paragraphs"] = sum(1 for p in paragraphs if len(p) > LONG_PARAGRAPH_CHARS)
    m["prose_chars"] = prose_chars
    m["prose_code_spans"] = prose_code
    m["prose_code_per_1k_chars"] = round(prose_code * 1000 / max(1, prose_chars), 1)
    m["inline_code_total"] = all_code
    m["has_glossary"] = has_glossary
    m["has_change_table"] = has_change_table
    m["marked_diagrams"] = marked_diagrams
    body = "\n".join(l for l in lines if not l.startswith("```"))
    ids = ID_REF.findall(body)
    m["id_refs"] = len(ids)
    m["negation_words"] = len(NEGATION.findall(body))
    m["negation_per_1k_chars"] = round(m["negation_words"] * 1000 / max(1, len(body)), 1)
    m["revision_traces"] = len(REVISION_TRACE.findall(body))
    m["stock_phrases"] = len(STOCK.findall(body))

    sections = split_sections(lines)
    summary = next((body for t, body in sections if t.startswith("摘要")), None)
    m["summary_present"] = summary is not None
    m["summary_chars"] = len("".join(l.strip() for l in summary)) if summary else 0
    head = "\n".join(lines[:40])
    m["related_docs_block"] = "相关文档" in head
    m["overview_has_diagram"] = any(
        (t.startswith("2.1") or "主图" in t) and any(l.startswith("```") for l in body) for t, body in sections
    )
    return m, long_cells, [t for t, _ in sections]


def flags_for(m):
    f = []
    if not m["related_docs_block"]:
        f.append("缺少头部'相关文档'列表")
    if not m["summary_present"]:
        f.append("缺少'摘要'节")
    elif m["summary_chars"] > 150:
        f.append(f"摘要 {m['summary_chars']} 字，超过 150")
    if not m["overview_has_diagram"]:
        f.append("2.1 没有主图（mermaid 或文本块）；无图需写豁免理由")
    if m["nested_bullets"]:
        f.append(f"{m['nested_bullets']} 行嵌套列表")
    if m["bold_label_lines"]:
        f.append(f"{m['bold_label_lines']} 处'**标签**：内容'连排")
    if m["max_table_columns"] > 6:
        f.append(f"表格最多 {m['max_table_columns']} 列，超过 6")
    if m["long_cells"]:
        f.append(f"{m['long_cells']} 个单元格超过两句或 120 字")
    if m["revision_traces"]:
        f.append(f"{m['revision_traces']} 处修订痕迹（关闭 F-xx / vN 订正）")
    if m["stock_phrases"]:
        f.append(f"{m['stock_phrases']} 处套话")
    if m["negation_per_1k_chars"] > 3:
        f.append(f"否定词密度 {m['negation_per_1k_chars']}/千字，偏防御")
    if m["long_paragraphs"]:
        f.append(f"{m['long_paragraphs']} 段超过 {LONG_PARAGRAPH_CHARS} 字，检查是否混入了流程、对比或清单")
    if m["prose_code_per_1k_chars"] > 12:
        f.append(f"正文行内代码 {m['prose_code_per_1k_chars']}/千字，检查是否把清单或对比写成了段落；代码名本身不需要换成中文名")
    if m["inline_code_total"] > 30 and not m["has_glossary"]:
        f.append("行内代码较多但没有术语对照表（名称 | 含义与代码位置）")
    if not m["has_change_table"]:
        f.append("缺少带'变更'列的变更总览表（2.4，标新增/修改/删除）")
    if m["mermaid_blocks"] > 0 and m["marked_diagrams"] == 0:
        f.append("图中没有新增/修改/现有标记，按 visualization-routing 第 4 节着色或加【新增】【修改】前缀")
    if m["mermaid_blocks"] + m["text_diagrams"] <= 1 and m["prose_chars"] > 2500:
        f.append("正文以文字为主且只有不超过 1 张图，按 visualization-routing 第 1 节核对漏画")
    if m["max_heading_depth"] > 4:
        f.append("出现五级以上标题")
    if m["lines"] > 300:
        f.append(f"{m['lines']} 行，超过 300 行的结构复核信号")
    return f


def check_traceability(trace_text, headings):
    """Every '设计位置' like 3.2 / 2.1 must match a heading number in solution.md."""
    nums = set()
    for h in headings:
        mm = re.match(r"^(\d+(?:\.\d+)*)\.?\s", h)
        if mm:
            nums.add(mm.group(1))
    missing = set()
    # section refs look like 2.1 / 3.4; skip version strings (4.0.0, 8.13.0) and decimals inside longer numbers
    for ref in re.findall(r"(?<![\w./-])(\d+\.\d+)(?![\w./-])", trace_text):
        if ref not in nums and not re.fullmatch(r"\d+\.\d{2,}", ref):
            missing.add(ref)
    return sorted(missing)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("solution")
    ap.add_argument("--traceability")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    text = open(a.solution, encoding="utf-8").read()
    m, long_cells, headings = analyze(text)
    flags = flags_for(m)
    if a.traceability:
        missing = check_traceability(open(a.traceability, encoding="utf-8").read(), headings)
        m["traceability_missing_sections"] = missing
        if missing:
            flags.append("traceability 引用了 solution.md 中不存在的章节号: " + ", ".join(missing))
    if a.json:
        print(json.dumps({"metrics": m, "flags": flags}, ensure_ascii=False, indent=1))
        return
    print("| 指标 | 值 |\n|---|---|")
    for k, v in m.items():
        print(f"| {k} | {v} |")
    print("\n提示：" + ("无" if not flags else ""))
    for fl in flags:
        print(f"- {fl}")
    for ln, cell in long_cells[:5]:
        print(f"  长单元格 行 {ln}: {cell}…")


if __name__ == "__main__":
    sys.exit(main())
