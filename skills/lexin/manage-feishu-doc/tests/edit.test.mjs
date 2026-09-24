import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { editDocument, resolveTarget } from "../scripts/lib/edit.mjs";
import { parseTopLevel } from "../scripts/lib/structure.mjs";
import { tempDir } from "./temp.mjs";

// 两个同名标题「Linux」、一个空章节、一张独立图片、一个带子项的列表项
const DOC = [
  '<title id="t">手册</title>',
  '<h1 id="h1">安装</h1>',
  '<p id="p1">先下载。</p>',
  '<h2 id="h2">Linux</h2>',
  '<ul><li id="l1">apt 安装</li><li id="l2">yum 安装<ul><li id="l2a">CentOS 7</li></ul></li><li id="l3">源码编译</li></ul>',
  '<h2 id="h3">macOS</h2>',
  '<img id="i1" src="IMG"/>',
  '<h1 id="h4">常见问题</h1>',
  '<h2 id="h5">Linux</h2>',
  '<p id="p3">权限不足时加 sudo。</p>',
  '<h2 id="h6">空章节</h2>',
  '<h1 id="h7">附录</h1>',
].join("");
const MARKDOWN = "# 安装\n\n先下载。\n\n## Linux\n\n- apt 安装\n- yum 安装\n";

const elements = parseTopLevel(DOC);
const removedIds = (options) => {
  const target = resolveTarget(elements, options);
  return target.blocks.slice(target.removed.start, target.removed.end).map((block) => block.id);
};
const rejects = (options, code) => assert.throws(() => resolveTarget(elements, options), (error) => error.code === code);

test("a list item is its own top-level block, so --block replaces that item and not the whole list", () => {
  assert.deepEqual(removedIds({ op: "replace", block: "l2" }), ["l2"]);
  const target = resolveTarget(elements, { op: "replace", block: "l2" });
  assert.deepEqual(target.blocks[target.removed.start].allIds, ["l2", "l2a"], "the nested item goes with its parent");
  assert.deepEqual(removedIds({ op: "delete", block: "l3", "end-block": "i1" }), ["l3", "h3", "i1"]);
  rejects({ op: "delete", block: "i1", "end-block": "l3" }, "INVALID_ARGUMENT");
  rejects({ op: "replace", block: "l2a" }, "BLOCK_NOT_FOUND");
});

test("a section runs until the next heading of the same or higher level", () => {
  assert.deepEqual(removedIds({ op: "replace-section", heading: "安装" }), ["p1", "h2", "l1", "l2", "l3", "h3", "i1"]);
  assert.deepEqual(removedIds({ op: "delete-section", heading: "安装", "include-heading": true }).slice(0, 2), ["h1", "p1"]);
  assert.equal(resolveTarget(elements, { op: "insert-after", "after-heading": "安装" }).anchor, "i1");
  assert.equal(resolveTarget(elements, { op: "insert-after", "after-heading": "h2" }).anchor, "l3", "inserts after the last list item");
  assert.equal(resolveTarget(elements, { op: "insert-after", at: "start" }).anchor, "0");
  assert.equal(resolveTarget(elements, { op: "insert-after", at: "end" }).anchor, "-1");
});

test("duplicate heading text fails closed and names the ids; an empty section can be filled but not deleted", () => {
  assert.throws(
    () => resolveTarget(elements, { op: "replace-section", heading: "Linux" }),
    (error) => error.code === "AMBIGUOUS_HEADING" && /h2, h5/.test(error.message),
  );
  assert.deepEqual(removedIds({ op: "delete-section", heading: "h5" }), ["p3"]);
  const fill = resolveTarget(elements, { op: "replace-section", heading: "空章节" });
  assert.deepEqual([fill.anchor, fill.removed], ["h6", null]);
  rejects({ op: "delete-section", heading: "空章节" }, "EMPTY_SECTION");
  rejects({ op: "replace-section", heading: "不存在" }, "HEADING_NOT_FOUND");
});

function fakeDocument({ comments = [], drift = null } = {}) {
  const log = [];
  let xmlFetches = 0;
  const transport = {
    async shortcut(args, options = {}) {
      log.push({ args, input: options.input, cwd: options.cwd });
      if (args[1] === "+fetch") {
        const format = args[args.indexOf("--doc-format") + 1];
        const xml = drift && format === "xml" && (xmlFetches += 1) > 1 ? drift : DOC;
        return { document: { content: format === "xml" ? xml : MARKDOWN, revision_id: 5 } };
      }
      if (args[1] === "+update") return { result: "success", warnings: [] };
      throw new Error(`unexpected shortcut ${args.join(" ")}`);
    },
    async call(name) {
      if (name === "drive.v1.fileComment.list") return { items: comments, has_more: false };
      throw new Error(`unexpected call ${name}`);
    },
  };
  const updates = () => log.filter((entry) => entry.args[1] === "+update");
  return { transport, updates };
}

function fragment(markdown) {
  const dir = tempDir("feishu-edit-");
  writeFileSync(join(dir, "part.md"), markdown);
  return { dir, file: join(dir, "part.md") };
}

test("replace sends one block_replace for the target with the fragment on stdin", async () => {
  const { dir, file } = fragment("- yum 安装（推荐改用 dnf）\n");
  const { transport, updates } = fakeDocument();
  const result = await editDocument(transport, "D1", { op: "replace", block: "l2", file });
  assert.equal(result.status, "updated");
  assert.deepEqual(result.removedPreview, ["li: yum 安装CentOS 7"]);
  const [update] = updates();
  assert.deepEqual(update.args.slice(4), ["--command", "block_replace", "--block-id", "l2", "--doc-format", "markdown", "--content", "-"]);
  assert.equal(update.input, "- yum 安装（推荐改用 dnf）\n");
  assert.equal(update.cwd, dir, "relative image paths resolve next to the fragment");

  const empty = fragment("\n");
  await assert.rejects(editDocument(fakeDocument().transport, "D1", { op: "replace", block: "l2", file: empty.file }), (error) => error.code === "EMPTY_FRAGMENT");
});

test("replace and delete stop on images and on comments anchored inside the range until confirmed", async () => {
  const image = await editDocument(fakeDocument().transport, "D1", { op: "delete-section", heading: "macOS" });
  assert.equal(image.status, "blocked");
  assert.deepEqual(image.blockers.map((item) => item.check), ["protected_blocks"]);
  const allowed = fakeDocument();
  assert.equal((await editDocument(allowed.transport, "D1", { op: "delete-section", heading: "macOS", allowProtected: true })).status, "updated");
  assert.deepEqual(allowed.updates()[0].args.slice(4), ["--command", "block_delete", "--block-id", "i1"]);

  const { file } = fragment("- yum 安装\n");
  const comments = [
    { comment_id: "c1", quote: "CentOS 7", is_solved: false, is_whole: false, extra: { content_anchor_id: "l2a" } },
    { comment_id: "c2", quote: "先下载", is_solved: false, is_whole: false, extra: { content_anchor_id: "p1" } },
  ];
  const blocked = await editDocument(fakeDocument({ comments }).transport, "D1", { op: "replace", block: "l2", file });
  assert.deepEqual(blocked.blockers.map((item) => item.check), ["open_comments"]);
  assert.deepEqual(blocked.blockers[0].comments.map((comment) => comment.id), ["c1"], "comments outside the range do not block");
  const accepted = fakeDocument({ comments });
  assert.equal((await editDocument(accepted.transport, "D1", { op: "replace", block: "l2", file, acceptCommentLoss: true })).status, "updated");

  const dry = fakeDocument();
  const preview = await editDocument(dry.transport, "D1", { op: "delete", block: "l1", "end-block": "l3", dryRun: true });
  assert.equal(preview.status, "dry_run");
  assert.equal(preview.removedBlocks, 3);
  assert.equal(dry.updates().length, 0);
});

test("replace-text counts matches in the Markdown export, needs --all for several and sends the new text on stdin", async () => {
  const edit = (options) => editDocument(fakeDocument().transport, "D1", { op: "replace-text", ...options });
  await assert.rejects(edit({ pattern: "安装", content: "部署" }), (error) => error.code === "AMBIGUOUS_PATTERN" && /3 次/.test(error.message));
  await assert.rejects(edit({ pattern: "卸载", content: "x" }), (error) => error.code === "PATTERN_NOT_FOUND");
  await assert.rejects(edit({ pattern: "安装\n先", content: "x" }), (error) => error.code === "INVALID_ARGUMENT");
  await assert.rejects(edit({ pattern: "先下载", content: true }), (error) => error.code === "INVALID_ARGUMENT");

  const { transport, updates } = fakeDocument();
  const result = await editDocument(transport, "D1", { op: "replace-text", pattern: "安装", content: "@部署", all: true });
  assert.equal(result.status, "updated");
  assert.equal(result.occurrences, 3);
  const [update] = updates();
  assert.deepEqual(update.args.slice(4), ["--command", "str_replace", "--doc-format", "markdown", "--pattern=安装", "--content", "-"]);
  assert.equal(update.input, "@部署", "a leading @ would make lark-cli read a file if passed as an argument");
});

test("an edit made in Feishu between the read and the write stops the edit before anything is written", async () => {
  const { file } = fragment("- yum 安装（改）\n");
  const drift = DOC.replace('<li id="l3">源码编译</li>', '<li id="l3">源码编译</li><li id="l9">别人刚加的一项</li>');
  const { transport, updates } = fakeDocument({ drift });
  await assert.rejects(editDocument(transport, "D1", { op: "replace", block: "l2", file }), (error) => error.code === "REMOTE_CHANGED_DURING_EDIT");
  assert.equal(updates().length, 0);
});

test("a nested item recreated in Feishu between the read and the write stops the edit too", async () => {
  const { file } = fragment("- yum 安装（改）\n");
  const { transport, updates } = fakeDocument({ drift: DOC.replace('id="l2a"', 'id="l2b"') });
  await assert.rejects(editDocument(transport, "D1", { op: "replace", block: "l2", file }), (error) => error.code === "REMOTE_CHANGED_DURING_EDIT");
  assert.equal(updates().length, 0);
});
