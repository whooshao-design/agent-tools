import assert from "node:assert/strict";
import test from "node:test";

import { alertToCallout, escapeTagLikeText, inlineToXml, preparePublishMarkdown } from "../scripts/lib/markdown.mjs";

test("title comes from frontmatter or the leading H1, and the duplicate H1 is dropped", () => {
  const fromFront = preparePublishMarkdown("---\ntitle: 手册\n---\n# 手册\n\n正文\n", { fileName: "x.md" });
  assert.equal(fromFront.title, "手册");
  assert.equal(fromFront.body.trim(), "正文");
  const fromH1 = preparePublishMarkdown("# 标题\n\n## 小节\n", { fileName: "x.md" });
  assert.equal(fromH1.title, "标题");
  assert.equal(fromH1.expected.headings, 1);
  assert.equal(preparePublishMarkdown("正文\n", { fileName: "guide.md" }).title, "guide");
});

test("tag-like text outside code is escaped, DocxXML tags, <br>, autolinks and code spans are kept", () => {
  assert.equal(escapeTagLikeText("返回 List<String>"), "返回 List\\<String>");
  assert.equal(escapeTagLikeText("`Map<K,V>` 不动"), "`Map<K,V>` 不动");
  assert.equal(escapeTagLikeText("a<br>b <https://x.y> a < b"), "a<br>b <https://x.y> a < b");
  assert.equal(escapeTagLikeText('<table><tr><td colspan="2">x</td></tr></table>'), '<table><tr><td colspan="2">x</td></tr></table>');
  assert.equal(escapeTagLikeText("已转义 \\<T>"), "已转义 \\<T>");
});

test("alerts become callouts whose inline Markdown is rewritten to DocxXML", () => {
  assert.equal(
    inlineToXml("含 **粗**、`a<b`、[链](https://x.y/?a=1&b=2)"),
    '含 <b>粗</b>、<code>a&lt;b</code>、<a href="https://x.y/?a=1&amp;b=2">链</a>',
  );
  assert.equal(
    alertToCallout("warning", ["先确认：", "- 已登录", "- [ ] 待办"]),
    '<callout emoji="❗" background-color="light-orange" border-color="orange"><p>先确认：</p><ul><li>已登录</li></ul><checkbox done="false">待办</checkbox></callout>',
  );
  const prepared = preparePublishMarkdown("> [!TIP]\n> 用 `publish`\n\n> 普通引用\n", { fileName: "x.md" });
  assert.match(prepared.body, /^<callout emoji="💡"/);
  assert.match(prepared.body, /> 普通引用/);
  assert.equal(prepared.expected.callouts, 1);
});

test("mermaid fences become ordered placeholders and other fences stay untouched", () => {
  const md = "a\n```mermaid\nflowchart LR\n  A-->B\n```\n```java\nList<String> x;\n```\n~~~mermaid\nsequenceDiagram\n~~~\n";
  const prepared = preparePublishMarkdown(md, { fileName: "x.md" });
  assert.deepEqual(prepared.diagrams.map((item) => [item.placeholder, item.code]), [
    ["[[feishu-mermaid:1]]", "flowchart LR\n  A-->B"],
    ["[[feishu-mermaid:2]]", "sequenceDiagram"],
  ]);
  assert.match(prepared.body, /```java\nList<String> x;\n```/);
  assert.equal(prepared.expected.diagrams, 2);
});

test("HTML comments are removed, anchor links and <whiteboard> are reported", () => {
  const prepared = preparePublishMarkdown("<!-- a -->\n正文 <!-- b --> 继续\n<!--\n多行\n-->\n见 [x](#y)\n", { fileName: "x.md" });
  assert.doesNotMatch(prepared.body, /<!--|多行/);
  assert.match(prepared.body, /正文\s+继续/);
  assert.equal(prepared.warnings.length, 2);
  const whiteboard = preparePublishMarkdown('<whiteboard type="mermaid">x</whiteboard>\n', { fileName: "x.md" });
  assert.match(whiteboard.errors[0], /whiteboard/);
});

test("local images are rewritten to @./ paths inside the document directory, others are rejected", () => {
  const exists = (path) => !path.endsWith("missing.png");
  const prepared = preparePublishMarkdown(
    "![a](img/a.png)\n![b](img/sub%20dir/b.png)\n![c](https://x.y/c.png)\n![d](../d.png)\n![e](img/missing.png)\n![f](data:image/png;base64,AA)\n",
    { fileName: "x.md", baseDir: "/docs/manual", exists, readFile: (path) => `bytes of ${path}` },
  );
  assert.match(prepared.body, /!\[a\]\(@\.\/img\/a\.png\)/);
  assert.match(prepared.body, /!\[b\]\(<@\.\/img\/sub dir\/b\.png>\)/);
  assert.match(prepared.body, /!\[c\]\(https:\/\/x\.y\/c\.png\)/);
  assert.equal(prepared.errors.length, 3);
  assert.equal(prepared.expected.images, 3);
  assert.equal(Object.keys(prepared.imageHashes).length, 2, "local images carry a content hash for incremental publish");
});

test("Setext headings count as headings, and fragments can keep their leading H1", () => {
  assert.equal(preparePublishMarkdown("# 标题\n\n小节\n---\n\n正文\n", { fileName: "x.md" }).expected.headings, 1);
  const fragment = preparePublishMarkdown("# 片段标题\n\n正文\n", { fileName: "x.md", extractTitle: false });
  assert.match(fragment.body, /^# 片段标题/);
  assert.equal(fragment.expected.headings, 1);
});

test("tables are counted once per separator row", () => {
  const prepared = preparePublishMarkdown("| a | b |\n|---|:--:|\n| 1 | 2 |\n\n| c |\n| --- |\n| 3 |\n", { fileName: "x.md" });
  assert.equal(prepared.expected.tables, 2);
});

test("a thematic break after a line with a pipe is not counted as a table", () => {
  assert.equal(preparePublishMarkdown("a | b 是正文\n---\n", { fileName: "x.md" }).expected.tables, 0);
});
