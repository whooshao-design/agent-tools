import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

import { CHECK_MERMAID, lintFile, lintMarkdown } from "../scripts/lib/lint.mjs";
import { preparePublishMarkdown } from "../scripts/lib/markdown.mjs";
import { tempDir } from "./temp.mjs";

const found = (markdown) => lintMarkdown(markdown).map((issue) => `${issue.level}:${issue.rule}:${issue.line}`);
const fence = (code, lang = "mermaid") => `\`\`\`${lang}\n${code}\n\`\`\``;

test("mermaid: unquoted Chinese in quadrant/xychart/sankey blocks publishing, all-quoted flowcharts warn", () => {
  const markdown = [
    "# 标题",
    "",
    fence('quadrantChart\n  title 用户分布\n  x-axis "低" --> "高"'),
    "",
    fence('xychart-beta\n  title "月度"\n  x-axis ["一月", "二月"]\n  bar [1, 2]'),
    "",
    fence('flowchart LR\n  A["开始"] --> B["结束"]'),
    "",
    fence('flowchart LR\n  A[开始] --> B["结束 (x)"]'),
  ].join("\n");
  assert.deepEqual(found(markdown), ["error:mermaid-unquoted-cjk:5", "warning:mermaid-all-quoted:17"]);

  const messages = "A->>B: 1\nB->>C: 2\nC->>D: 3\nD->>E: 4\nE->>F: 5\nF-->>G: 6";
  assert.deepEqual(found(fence(`sequenceDiagram\n${messages}`)), ["warning:sequence-too-large:2"]);
  assert.deepEqual(found(fence("sequenceDiagram\nparticipant U as 用户\nU->>S: 登录\nS-->>U: 成功")), []);
});

test("headings: skipped levels, more than four levels, mixed numbering and headings inside quotes", () => {
  const markdown = [
    "# 文档标题",
    "",
    "## 一、背景",
    "",
    "#### 跳级",
    "",
    "## 2. 方案",
    "",
    "### 2.1 细节",
    "",
    "#### a",
    "",
    "##### b",
    "",
    "###### c",
    "",
    "> ## 引用里的标题",
  ].join("\n");
  assert.deepEqual(found(markdown), [
    "warning:heading-skip:5",
    "warning:heading-numbering-mixed:9",
    "warning:heading-too-deep:15",
    "warning:heading-in-callout:17",
  ]);
  assert.deepEqual(found("---\ntitle: T\n---\n# T\n\n## 概览\n\n设置\n---\n\n### 细节\n"), [], "the title H1 and a Setext H2 are fine");
  assert.deepEqual(found("## 一、背景\n\n### （一）现状\n\n#### 1. 问题\n"), [], "official-style numbering is one system");
});

test("tables wider than six columns or with long cells, and one callout per chapter", () => {
  const wide = "| a | b | c | d | e | f | g |\n|---|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 |";
  const long = "| 项 | 说明 |\n|:--|:--:|\n| x | 第一句。第二句。第三句。 |\n| y | 一句话 |";
  assert.deepEqual(found(`${wide}\n\n${long}`), ["warning:table-too-wide:1", "warning:table-long-cell:7"]);

  const callouts = "## 一\n\n> [!NOTE]\n> a\n\n> [!TIP]\n> b\n\n## 二\n\n> [!WARNING]\n> c\n";
  assert.deepEqual(found(callouts), ["warning:callouts-per-section:6"]);
});

test("inline hazards: formulas by accident, local links, HTML tags, public renderers and mojibake", () => {
  const markdown = [
    "费用 $x 元$，区间 $100 到 $200，公式 $E=mc^2$",
    "见 [设计](./design.md)、[官网](https://x.com)、[跳转](#标题)",
    "<details>折叠</details> 和 `<div>` 代码",
    "![图](https://mermaid.ink/img/abc)",
    "乱码\uFFFD",
  ].join("\n");
  assert.deepEqual(found(markdown), [
    "warning:math-dollar:1",
    "warning:local-link:2",
    "warning:html-tag:3",
    "error:public-renderer:4",
    "error:replacement-char:5",
  ]);
});

test("table rows get the same line checks as paragraphs", () => {
  const table = "| 图 | 说明 |\n|---|---|\n| ![图](https://mermaid.ink/img/abc) | 乱码\uFFFD |\n| <details> | 见 [设计](./d.md) |";
  assert.deepEqual(found(table), ["error:replacement-char:3", "error:public-renderer:3", "warning:html-tag:4", "warning:local-link:4"]);
});

test("ordered lists: a new list that does not start at 1 warns, continuations and indented code do not", () => {
  assert.deepEqual(found("1. 第一步\n\n```bash\ncmd\n```\n\n2. 第二步\n"), ["warning:ordered-list-start:7"]);
  assert.deepEqual(found("1. 第一步\n\n   ```bash\n   cmd\n   ```\n\n2. 第二步\n"), []);
  assert.deepEqual(found("1. 第一步\n继续说明\n2. 第二步\n"), []);
  assert.deepEqual(found("说明\n\n3. 从 3 开始\n"), ["warning:ordered-list-start:3"]);
});

test("publish prechecks carry lint errors (blocking) and warnings with line numbers", () => {
  const prepared = preparePublishMarkdown(`# T\n\n${fence("sankey-beta\n用户,注册,10")}\n\n| a | b | c | d | e | f | g |\n|---|---|---|---|---|---|---|\n`, {
    fileName: "t.md",
  });
  assert.equal(prepared.errors.length, 1);
  assert.match(prepared.errors[0], /^第 5 行：sankey-beta 里的中文没加引号/);
  assert.ok(prepared.warnings.some((warning) => warning.startsWith("第 8 行：表格有 7 列")));
});

test("lintFile maps mermaid syntax results: mermaid 11 failures block, old-version-only failures warn", () => {
  const dir = tempDir("feishu-lint-test-");
  const file = join(dir, "doc.md");
  writeFileSync(file, `# T\n\n${fence("flowchart LR\n  A --> B")}\n\n${fence("sequenceDiagram\n  A->>B: hi")}\n`);
  const run = () => ({
    status: "checked",
    blocks: [
      { id: "D1", heading: "T", line: 3, results: { "8.13.0": "ERR: Lexical error", 11: "ok" } },
      { id: "D2", heading: "T", line: 8, results: { "8.13.0": "ok", 11: "ERR: Parse error on line 2" } },
    ],
  });
  const result = lintFile(file, { prepare: preparePublishMarkdown, out: join(dir, "out"), run });
  assert.equal(result.status, "errors");
  assert.deepEqual(result.errors, ["第 8 行：mermaid 图解析失败，飞书小组件不会出图：ERR: Parse error on line 2"]);
  assert.match(result.warnings[0], /^第 3 行：mermaid 图在 mermaid 8\.13\.0 解析失败/);
  assert.equal(result.mermaid.checked, 2);

  const skipped = lintFile(file, { prepare: preparePublishMarkdown, out: join(dir, "out2"), run: () => ({ status: "skipped", reason: "Chrome 不存在" }) });
  assert.equal(skipped.status, "warnings");
  assert.match(skipped.warnings[0], /mermaid 语法没校验（Chrome 不存在）：手动跑 node .*check_mermaid\.js/);

  const missed = lintFile(file, { prepare: preparePublishMarkdown, out: join(dir, "out3"), run: () => ({ status: "checked", blocks: [{ id: "D1", heading: "T", line: 3, results: { 11: "ok" } }] }) });
  assert.match(missed.warnings.at(-1), /发布会建 2 张图，语法校验只返回 1 张结果/);

  writeFileSync(file, "# T\n\n正文\n");
  const plain = lintFile(file, { prepare: preparePublishMarkdown, run: () => assert.fail("no diagrams, no browser") });
  assert.deepEqual([plain.status, plain.mermaid.status], ["ok", "no_diagrams"]);
});

test("the syntax checker finds exactly the diagrams that publishing turns into widgets", () => {
  const { extractMermaidBlocks } = createRequire(import.meta.url)(CHECK_MERMAID);
  const md = [
    "# T", "",
    fence("flowchart LR\n  A-->B"), "",
    "~~~mermaid\nflowchart LR\n  A[\n~~~", "",
    "````markdown\n```mermaid\nnot a diagram\n```\n````", "",
    "   ```Mermaid title\n   sequenceDiagram\n   A->>B: hi\n   ```",
  ].join("\n");
  const published = preparePublishMarkdown(md, { fileName: "t.md" }).diagrams;
  assert.equal(published.length, 3);
  assert.deepEqual(extractMermaidBlocks(md).map((block) => block.code), published.map((diagram) => diagram.code));
});

test("headings get the line checks too", () => {
  assert.deepEqual(found("## ![图](https://mermaid.ink/img/abc)"), ["error:public-renderer:1"]);
});

test("content inside HTML comments is not published, so it is not checked", () => {
  assert.deepEqual(found("<!-- old image https://mermaid.ink/img/abc -->\n\n正文\n"), []);
  assert.deepEqual(found("<!--\n| a | b | c | d | e | f | g |\n|---|---|---|---|---|---|---|\n-->\n正文\n"), []);
  assert.deepEqual(found("正文 ![图](https://mermaid.ink/img/abc) <!-- 注释 -->"), ["error:public-renderer:1"]);
  assert.deepEqual(found("写法 `<!-- 例子 -->` 和 <details>"), ["warning:html-tag:1"]);
  assert.deepEqual(preparePublishMarkdown("# T\n\n<!-- old image https://mermaid.ink/img/abc -->\n\n正文\n", { fileName: "t.md" }).errors, []);
});

test("a fence right after a comment is recognized the same way publishing does", () => {
  const md = "<!-- demo -->~~~text\n![图](https://mermaid.ink/img/abc)\n~~~\n\n![图](https://mermaid.ink/img/xyz)\n";
  assert.deepEqual(found(md), ["error:public-renderer:5"], "the example inside the code block is not checked, the one after it is");
});

test("a broken diagram kept inside a comment does not fail the syntax check", () => {
  const dir = tempDir("feishu-lint-test-");
  const file = join(dir, "doc.md");
  writeFileSync(file, `# T\n\n<!--\n${fence("flowchart LR\nA[")}\n-->\n\n${fence("flowchart LR\n  A-->B")}\n`);
  let checkedInput = "";
  const run = (input) => {
    checkedInput = readFileSync(input, "utf8");
    return { status: "checked", blocks: [{ id: "D1", heading: "x", line: 3, results: { 11: "ok" } }] };
  };
  const result = lintFile(file, { prepare: preparePublishMarkdown, out: join(dir, "out"), run });
  assert.match(checkedInput, /A-->B/);
  assert.doesNotMatch(checkedInput, /A\[/, "the commented-out diagram is not sent to the checker");
  assert.deepEqual([result.errors, result.mermaid.checked], [[], 1]);
  assert.deepEqual(result.warnings, ["去掉了 1 处 HTML 注释（飞书不保留注释）"], "no coverage warning either");
});

test("syntax results map back to source lines, also for CRLF files", () => {
  const dir = tempDir("feishu-lint-test-");
  const file = join(dir, "doc.md");
  writeFileSync(file, "---\r\ntitle: T\r\n---\r\n# T\r\n\r\n```mermaid\r\nflowchart LR\r\nA[\r\n```\r\n");
  let checkedInput = "";
  const run = (input) => {
    checkedInput = readFileSync(input, "utf8");
    return { status: "checked", blocks: [{ id: "D1", heading: "x", line: 3, results: { 11: "ERR: Parse error on line 2" } }] };
  };
  const result = lintFile(file, { prepare: preparePublishMarkdown, out: join(dir, "out"), run });
  assert.doesNotMatch(checkedInput, /\r/);
  assert.deepEqual(result.errors, ["第 6 行：mermaid 图解析失败，飞书小组件不会出图：ERR: Parse error on line 2"]);
});

test("the checker input never overwrites a source file, and a ``` line inside a diagram survives", () => {
  const dir = tempDir("feishu-lint-test-");
  const file = join(dir, "diagrams.md");
  const source = "# 图\n\n正文\n\n~~~mermaid\nflowchart LR\nA-->B\n```\nA[\n~~~\n";
  writeFileSync(file, source);
  const { extractMermaidBlocks } = createRequire(import.meta.url)(CHECK_MERMAID);
  let extracted = [];
  const run = (input) => {
    extracted = extractMermaidBlocks(readFileSync(input, "utf8"));
    return { status: "checked", blocks: extracted.map((block) => ({ ...block, results: { 11: "ok" } })) };
  };
  lintFile(file, { prepare: preparePublishMarkdown, out: dir, run });
  assert.equal(readFileSync(file, "utf8"), source, "the source file is untouched");
  assert.deepEqual(extracted.map((block) => block.code), ["flowchart LR\nA-->B\n```\nA["]);
});


test("checker output goes into a new folder, so files already in --out are left alone", () => {
  const dir = tempDir("feishu-lint-test-");
  const file = join(dir, "results.md");
  const source = "# 结果\n\n```mermaid\nflowchart LR\n  A-->B\n```\n";
  writeFileSync(file, source);
  writeFileSync(join(dir, "D1.svg"), "mine");
  let usedOut = "";
  const run = (input, outDir) => {
    usedOut = outDir;
    writeFileSync(join(outDir, "results.md"), "report");
    writeFileSync(join(outDir, "D1.svg"), "<svg/>");
    return { status: "checked", blocks: [{ id: "D1", heading: "x", line: 3, results: { 11: "ok" } }] };
  };
  const result = lintFile(file, { prepare: preparePublishMarkdown, out: dir, run });
  assert.notEqual(usedOut, dir);
  assert.equal(result.mermaid.outDir, usedOut);
  assert.equal(readFileSync(file, "utf8"), source);
  assert.equal(readFileSync(join(dir, "D1.svg"), "utf8"), "mine");
});
