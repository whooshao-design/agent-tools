import assert from "node:assert/strict";
import test from "node:test";

import { alertToCallout, escapeTagLikeText, inlineToXml, preparePublishMarkdown } from "../scripts/lib/markdown.mjs";
import { splitUnits } from "../scripts/lib/structure.mjs";

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
  const [first, second] = prepared.diagrams;
  assert.deepEqual([first.code, second.code], ["flowchart LR\n  A-->B", "sequenceDiagram"]);
  const nonce = first.placeholder.match(/^\[\[feishu-mermaid:([0-9a-f]{8})-1\]\]$/)?.[1];
  assert.ok(nonce, first.placeholder);
  assert.equal(second.placeholder, `[[feishu-mermaid:${nonce}-2]]`, "one random prefix per run");
  assert.notEqual(preparePublishMarkdown(md, { fileName: "x.md" }).diagrams[0].placeholder, first.placeholder);
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

test("inline code keeps examples of images, comments and tags as written", () => {
  const line = "写法：`![说明](相对路径)`、`<!-- 注释 -->`、`<whiteboard>`、`<callout>`、`[文字](#标题)`";
  const prepared = preparePublishMarkdown(`# T\n\n${line}\n`, { fileName: "t.md", exists: () => false });
  assert.deepEqual([prepared.errors, prepared.warnings], [[], []]);
  assert.deepEqual([prepared.expected.images, prepared.expected.callouts], [0, 0]);
  assert.equal(prepared.body, `${line}\n`);
});

test("lark-cli's own @./ image syntax is checked and hashed like a relative path", () => {
  const options = { fileName: "t.md", baseDir: "/doc", exists: (path) => path === "/doc/chart.png", readFile: () => "v1" };
  const prepared = preparePublishMarkdown("# T\n\n![图](@./chart.png)\n", options);
  assert.deepEqual(prepared.errors, []);
  assert.equal(prepared.images[0].path, "/doc/chart.png");
  const changed = preparePublishMarkdown("# T\n\n![图](@./chart.png)\n", { ...options, readFile: () => "v2" });
  assert.notDeepEqual(Object.values(changed.imageHashes), Object.values(prepared.imageHashes), "same path, new picture");
  assert.match(preparePublishMarkdown("# T\n\n![图](@./missing.png)\n", options).errors[0], /图片不存在/);
});

test("an image whose caption contains inline code is still checked and hashed", () => {
  const options = { fileName: "t.md", baseDir: "/doc", exists: () => true, readFile: () => "v1" };
  const prepared = preparePublishMarkdown("# T\n\n![`chart` 图](@./chart.png)\n", options);
  assert.equal(prepared.expected.images, 1);
  assert.equal(Object.keys(prepared.imageHashes).length, 1);
  const changed = preparePublishMarkdown("# T\n\n![`chart` 图](@./chart.png)\n", { ...options, readFile: () => "v2" });
  const hashOf = (value) => splitUnits(value.body, { imageHashes: value.imageHashes })[0].hash;
  assert.notEqual(hashOf(changed), hashOf(prepared), "same path, new picture");
});

test("a caption that gets escaped does not hide a replaced picture", () => {
  const options = { fileName: "t.md", baseDir: "/doc", exists: () => true, readFile: () => "v1" };
  const md = "# T\n\n![List<String> 结构](@./chart.png)\n";
  const before = preparePublishMarkdown(md, options);
  assert.match(before.body, /List\\<String>/, "the caption is escaped in the body");
  const after = preparePublishMarkdown(md, { ...options, readFile: () => "v2" });
  const hashOf = (value) => splitUnits(value.body, { imageHashes: value.imageHashes })[0].hash;
  assert.notEqual(hashOf(after), hashOf(before));
});

test("a comment with backticks inside does not swallow the rest of the document", () => {
  const one = preparePublishMarkdown("# T\n\n<!-- TODO: `Foo` -->\n\n段落一\n\n段落二\n", { fileName: "t.md" });
  assert.equal(one.body, "段落一\n\n段落二\n");
  assert.match(one.warnings.join(), /去掉了 1 处 HTML 注释/);
  const multi = preparePublishMarkdown("# T\n\n<!-- 说明 `x`\n还是注释 -->段落一\n\n写法 `<!-- 保留 -->` 照抄\n", { fileName: "t.md" });
  assert.equal(multi.body, "段落一\n\n写法 `<!-- 保留 -->` 照抄\n");
});

test("text between two multi-line comments on the same line is kept", () => {
  const prepared = preparePublishMarkdown("# T\n\n<!-- a\n-->正文<!-- b\n-->\n\n后文\n", { fileName: "t.md" });
  assert.equal(prepared.body, "正文\n\n后文\n");
  const fenced = preparePublishMarkdown("# T\n\n```html\n<!-- 代码里的注释 -->\n```\n", { fileName: "t.md" });
  assert.match(fenced.body, /<!-- 代码里的注释 -->/, "comments inside code blocks stay");
});

test("each diagram remembers the line of its fence in the source file", () => {
  const md = "---\ntitle: T\n---\n# T\n\n段落\n\n```mermaid\nflowchart LR\n```\n\n~~~mermaid\nsequenceDiagram\n~~~\n";
  assert.deepEqual(preparePublishMarkdown(md, { fileName: "t.md" }).diagrams.map((diagram) => diagram.line), [8, 12]);
  assert.deepEqual(preparePublishMarkdown("段落\n\n```mermaid\nflowchart LR\n```\n", { fileName: "t.md" }).diagrams[0].line, 3);
});
