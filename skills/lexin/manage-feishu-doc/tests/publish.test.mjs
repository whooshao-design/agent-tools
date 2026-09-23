import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compareCounts,
  countPublished,
  MERMAID_WIDGET_TYPE,
  publishMarkdown,
  readState,
  replaceBlocks,
  replaceDiagramPlaceholders,
  statePathFor,
} from "../scripts/lib/publish.mjs";
import { readRegistry } from "../scripts/lib/cleanup.mjs";

// 发布会把新建的文档记进 $XDG_DATA_HOME 下的清单，测试一律写到临时目录
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "feishu-xdg-"));

const SAMPLE = "---\ntitle: 手册\n---\n# 手册\n\n## 步骤\n\n> [!NOTE]\n> 先登录\n\n```mermaid\nflowchart LR\n  A-->B\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
const PUBLISHED_XML = '<title>手册</title><h2>步骤</h2><callout emoji="📝"><p>先登录</p></callout><readonly-block id="w1" type="isv"></readonly-block><table></table>';

function workspace(markdown = SAMPLE) {
  const dir = mkdtempSync(join(tmpdir(), "feishu-publish-"));
  const file = join(dir, "manual.md");
  writeFileSync(file, markdown);
  return { dir, file, backupRoot: join(dir, "backups") };
}

// 按 publish 实际发出的调用最小模拟飞书：一篇文档、根下的占位段落、评论和版本号
function fakeFeishu({ comments = [], remoteMarkdown = "published", revision = 5, widgetFails = false, whiteboardFallback = true } = {}) {
  const log = [];
  const doc = { id: "D1", revision, markdown: remoteMarkdown };
  const root = [{ block_id: "p0", block_type: 2, parent_id: "D1", text: { elements: [{ text_run: { content: "步骤说明" } }] } }];
  const placeholder = () => ({ block_id: "ph1", block_type: 2, parent_id: "D1", text: { elements: [{ text_run: { content: "[[feishu-mermaid:1]]" } }] } });
  const transport = {
    async shortcut(args, options = {}) {
      log.push({ shortcut: args.slice(0, 2).join(" "), args, input: options.input, cwd: options.cwd });
      if (args[1] === "+create") {
        root.push(placeholder());
        return { document: { document_id: "D1", url: "https://lexin.feishu.cn/docx/D1", revision_id: 1 }, warnings: [] };
      }
      if (args[1] === "+fetch") {
        const format = args[args.indexOf("--doc-format") + 1];
        return { document: { content: format === "xml" ? PUBLISHED_XML : doc.markdown, revision_id: doc.revision } };
      }
      if (args[1] === "+update") {
        const command = args[args.indexOf("--command") + 1];
        if (command === "overwrite") {
          root.splice(1, root.length, placeholder());
          return { result: "success", warnings: [] };
        }
        if (command === "block_insert_after") {
          const whiteboard = whiteboardFallback && options.input.startsWith("```mermaid");
          return { result: "success", warnings: whiteboard ? [] : ["degrade"], document: { new_blocks: whiteboard ? [{ block_type: "whiteboard" }] : [] } };
        }
        return { result: "success" };
      }
      throw new Error(`unexpected shortcut ${args.join(" ")}`);
    },
    async call(name, args) {
      log.push({ call: name, args });
      if (name === "docx.v1.documentBlock.list") return { items: structuredClone(root) };
      if (name === "docx.v1.documentBlockChildren.get") return { items: structuredClone(root) };
      if (name === "docx.v1.documentBlockChildren.create") {
        if (widgetFails) throw new Error("1770001 invalid param");
        return {};
      }
      if (name === "docx.v1.documentBlockChildren.batchDelete") return {};
      if (name === "docx.v1.document.get") return { document: { revision_id: doc.revision } };
      if (name === "drive.v1.fileComment.list") return { items: comments, has_more: false };
      if (name === "docx.v1.documentBlock.batchUpdate") return {};
      throw new Error(`unexpected call ${name}`);
    },
  };
  return { transport, log, doc };
}

const folder = { kind: "folder", token: "FOLDER" };

test("first publish creates the doc from preprocessed Markdown, swaps the placeholder for a widget and records state", async () => {
  const { file, dir, backupRoot } = workspace();
  const { transport, log } = fakeFeishu();
  const result = await publishMarkdown(transport, { file, target: folder, backupRoot });
  assert.equal(result.status, "published");
  const create = log.find((entry) => entry.shortcut === "docs +create");
  assert.equal(create.cwd, dir);
  assert.deepEqual(create.args.slice(2, 6), ["--title", "手册", "--parent-token", "FOLDER"]);
  assert.match(create.input, /\[\[feishu-mermaid:1\]\]/);
  assert.match(create.input, /<callout emoji="📝"/);
  const widget = log.find((entry) => entry.call === "docx.v1.documentBlockChildren.create");
  assert.equal(widget.args.data.index, 1);
  assert.equal(widget.args.data.children[0].add_ons.component_type_id, MERMAID_WIDGET_TYPE);
  assert.deepEqual(JSON.parse(widget.args.data.children[0].add_ons.record), { data: "flowchart LR\n  A-->B", view: "chart" });
  const remove = log.find((entry) => entry.call === "docx.v1.documentBlockChildren.batchDelete");
  assert.deepEqual(remove.args.data, { start_index: 2, end_index: 3 });
  const state = readState(statePathFor(file));
  assert.equal(state.doc_token, "D1");
  assert.equal(state.mode, "local-master");
  assert.equal(state.revision, 5);
  assert.equal(state.parent_token, "FOLDER");
  assert.deepEqual(result.verification.mismatches, []);
  const recorded = readRegistry().find((entry) => entry.file === file);
  assert.deepEqual([recorded.doc_token, recorded.parent_token, recorded.source], ["D1", "FOLDER", "publish"]);
});

test("republishing an unchanged file is a no-op; old states without a block map need one overwrite", async () => {
  const { file, backupRoot } = workspace();
  await publishMarkdown(fakeFeishu().transport, { file, target: folder, backupRoot });
  const again = await publishMarkdown(fakeFeishu().transport, { file, backupRoot });
  assert.equal(again.status, "unchanged");

  const legacy = readState(statePathFor(file));
  writeFileSync(statePathFor(file), JSON.stringify({ ...legacy, units: null, units_note: undefined }));
  const withoutMap = await publishMarkdown(fakeFeishu().transport, { file, backupRoot });
  assert.equal(withoutMap.status, "needs_mode");
  assert.match(withoutMap.message, /--overwrite/);

  const state = readState(statePathFor(file));
  writeFileSync(statePathFor(file), JSON.stringify({ ...state, mode: "feishu-master" }));
  await assert.rejects(publishMarkdown(fakeFeishu().transport, { file, overwrite: true, backupRoot }), /以飞书为准/);
});

test("overwrite is blocked by remote edits and open comments unless explicitly accepted", async () => {
  const { file, backupRoot } = workspace();
  await publishMarkdown(fakeFeishu().transport, { file, target: folder, backupRoot });

  const unchanged = await publishMarkdown(fakeFeishu().transport, { file, overwrite: true, dryRun: true, backupRoot });
  assert.equal(unchanged.status, "dry_run");
  assert.equal(unchanged.checks.remoteChanged, false);

  const edited = fakeFeishu({ revision: 9, remoteMarkdown: "someone edited" });
  const blocked = await publishMarkdown(edited.transport, { file, overwrite: true, backupRoot });
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.blockers.map((item) => item.check), ["remote_changed"]);

  const commented = fakeFeishu({ comments: [{ comment_id: "c1", quote: "步骤", is_solved: false, is_whole: false }, { comment_id: "c2", is_solved: false, is_whole: true }] });
  const withComments = await publishMarkdown(commented.transport, { file, overwrite: true, backupRoot });
  assert.equal(withComments.status, "blocked");
  assert.equal(withComments.checks.openComments, 1);
  assert.equal(withComments.blockers[0].comments[0].id, "c1");
  assert.equal(existsSync(backupRoot), false, "blocked runs must not write anything");
});

test("overwrite backs up the current document, rewrites it and refreshes the state", async () => {
  const { file, backupRoot } = workspace();
  await publishMarkdown(fakeFeishu().transport, { file, target: folder, backupRoot });
  writeFileSync(file, SAMPLE.replace("title: 手册", "title: 手册 v2").replace("# 手册", "# 手册 v2"));

  const { transport, log } = fakeFeishu({ revision: 9, remoteMarkdown: "someone edited" });
  const result = await publishMarkdown(transport, { file, overwrite: true, force: true, backupRoot });
  assert.equal(result.status, "published");
  assert.ok(log.some((entry) => entry.shortcut === "docs +update" && entry.args.includes("overwrite")));
  const title = log.find((entry) => entry.call === "docx.v1.documentBlock.batchUpdate");
  assert.equal(title.args.data.requests[0].update_text_elements.elements[0].text_run.content, "手册 v2");
  const backups = readdirSync(join(backupRoot, "D1"));
  assert.equal(backups.length, 2);
  assert.ok(backups.every((name) => name.includes("-r9.")));
  const state = readState(statePathFor(file));
  assert.equal(state.title, "手册 v2");
  assert.equal(state.last_backup.revision, 9);
  assert.equal(readFileSync(result.backup.markdown, "utf8"), "someone edited");
});

test("first publish needs a folder or wiki target and never overwrites without state", async () => {
  const { file, backupRoot } = workspace();
  await assert.rejects(publishMarkdown(fakeFeishu().transport, { file, backupRoot }), /--target/);
  await assert.rejects(publishMarkdown(fakeFeishu().transport, { file, target: folder, overwrite: true, backupRoot }), /没有发布记录/);
  const plan = await publishMarkdown(fakeFeishu().transport, { file, target: folder, dryRun: true, backupRoot });
  assert.equal(plan.status, "dry_run");
  assert.equal(existsSync(statePathFor(file)), false);
});

test("a widget that cannot be created falls back to a whiteboard, then to a code block", async () => {
  const diagrams = [{ index: 1, placeholder: "[[feishu-mermaid:1]]", code: "flowchart LR\n  A-->B" }];
  const toWhiteboard = fakeFeishu({ widgetFails: true });
  await toWhiteboard.transport.shortcut(["docs", "+create"]);
  const [whiteboard] = await replaceDiagramPlaceholders(toWhiteboard.transport, "D1", diagrams);
  assert.equal(whiteboard.status, "whiteboard");
  assert.ok(toWhiteboard.log.some((entry) => Array.isArray(entry.args) && entry.args.includes("block_delete")));

  const toCode = fakeFeishu({ widgetFails: true, whiteboardFallback: false });
  await toCode.transport.shortcut(["docs", "+create"]);
  const [code] = await replaceDiagramPlaceholders(toCode.transport, "D1", diagrams);
  assert.equal(code.status, "code");
  assert.ok(toCode.log.some((entry) => entry.input?.startsWith("```text")));
});

test("published XML is counted and compared with what the Markdown promised", () => {
  const counts = countPublished(PUBLISHED_XML);
  assert.deepEqual(counts, { headings: 1, tables: 1, images: 0, callouts: 1, widgets: 1, whiteboards: 0, placeholders: 0 });
  assert.deepEqual(compareCounts({ headings: 1, tables: 1, images: 0, callouts: 1, diagrams: 1 }, counts), []);
  assert.deepEqual(compareCounts({ headings: 2, tables: 1, images: 0, callouts: 1, diagrams: 2 }, counts, 1), [
    { item: "headings", expected: 2, actual: 1 },
  ]);
});

// ---- 增量发布 ----

const V1 = "# 手册\n\n段落一\n\n## 步骤\n\n段落二\n\n- a\n- b\n";
const V2 = "# 手册\n\n段落一（改）\n\n## 步骤\n\n段落二\n\n- a\n- c\n\n段落三\n";
const BEFORE = '<title id="t">手册</title><p id="p1">段落一</p><h2 id="h1">步骤</h2><p id="p2">段落二</p><ul><li id="l1">a</li><li id="l2">b</li></ul>';
const AFTER = '<title id="t">手册</title><p id="p1">段落一（改）</p><h2 id="h1">步骤</h2><p id="p2">段落二</p><ul><li id="l3">a</li><li id="l4">c</li></ul><p id="p3">段落三</p>';

// 一篇文档：+fetch 返回当前 XML；任何 +update 之后文档变成 AFTER
function fakeDocument(initialXml, { comments = [] } = {}) {
  const log = [];
  let xml = initialXml;
  const transport = {
    async shortcut(args, options = {}) {
      log.push({ shortcut: args.slice(0, 2).join(" "), args, input: options.input });
      if (args[1] === "+create") return { document: { document_id: "D1", url: "https://lexin.feishu.cn/docx/D1", revision_id: 1 }, warnings: [] };
      if (args[1] === "+fetch") {
        const format = args[args.indexOf("--doc-format") + 1];
        return { document: { content: format === "xml" ? xml : `md:${xml}`, revision_id: xml === initialXml ? 5 : 6 } };
      }
      if (args[1] === "+update") {
        xml = AFTER;
        return { result: "success", warnings: [] };
      }
      throw new Error(`unexpected shortcut ${args.join(" ")}`);
    },
    async call(name, args) {
      log.push({ call: name, args });
      if (name === "docx.v1.document.convert") {
        return { first_level_block_ids: ["x"], blocks: [{ block_id: "x", block_type: 2, text: { elements: [{ text_run: { content: args.data.content } }] } }] };
      }
      if (name === "docx.v1.documentBlock.batchUpdate") return {};
      if (name === "drive.v1.fileComment.list") return { items: comments, has_more: false };
      if (name === "docx.v1.documentBlock.list") return { items: [] };
      throw new Error(`unexpected call ${name}`);
    },
  };
  return { transport, log };
}

async function publishedV1() {
  const context = workspace(V1);
  const first = await publishMarkdown(fakeDocument(BEFORE).transport, { file: context.file, target: folder, backupRoot: context.backupRoot });
  assert.equal(first.verification.incrementalReady, true);
  writeFileSync(context.file, V2);
  return context;
}

test("incremental publish rewrites the edited paragraph in place, replaces the changed list and appends the new paragraph", async () => {
  const { file, backupRoot } = await publishedV1();
  const { transport, log } = fakeDocument(BEFORE);
  const result = await publishMarkdown(transport, { file, backupRoot });
  assert.equal(result.status, "published", JSON.stringify(result.verification));
  assert.deepEqual(result.summary, { unchanged: 2, inPlace: 1, replacedOrDeleted: 1, inserted: 2, titleChanged: false, suggestion: null });
  const inplace = log.find((entry) => entry.call === "docx.v1.documentBlock.batchUpdate");
  assert.equal(inplace.args.data.requests[0].block_id, "p1");
  const updates = log.filter((entry) => entry.shortcut === "docs +update");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].args.slice(4, 9), ["--command", "block_replace", "--start-block-id", "l1", "--end-block-id"]);
  assert.equal(updates[0].args[9], "l2");
  assert.equal(updates[0].input, "- a\n- c\n\n段落三\n");
  const state = readState(statePathFor(file));
  assert.deepEqual(state.units.at(-2).blockIds, ["l3", "l4"]);
  assert.deepEqual(state.units.at(-1).blockIds, ["p3"]);
});

test("incremental publish stops when a paragraph it must change was edited in Feishu, keeps untouched remote edits", async () => {
  const { file, backupRoot } = await publishedV1();
  const conflict = await publishMarkdown(fakeDocument(BEFORE.replace("段落一", "段落一（飞书上改过）")).transport, { file, backupRoot });
  assert.equal(conflict.status, "blocked");
  assert.deepEqual(conflict.blockers.map((item) => item.check), ["remote_changed"]);

  const elsewhere = await publishMarkdown(fakeDocument(BEFORE.replace("段落二", "段落二（飞书上改过）")).transport, { file, backupRoot, dryRun: true });
  assert.equal(elsewhere.status, "dry_run");
  assert.equal(elsewhere.checks.preservedRemoteEdits, 1);

  const inserted = await publishMarkdown(fakeDocument(BEFORE.replace("</ul>", '</ul><p id="zz">飞书上新加的段落</p>')).transport, { file, backupRoot, dryRun: true });
  assert.deepEqual(inserted.blockers.map((item) => item.check), ["remote_inserted"]);
});

test("incremental publish only blocks on comments anchored to blocks it will replace", async () => {
  const { file, backupRoot } = await publishedV1();
  const onParagraph = [{ comment_id: "c1", quote: "段落一", is_solved: false, is_whole: false, extra: { content_anchor_id: "p1" } }];
  const kept = await publishMarkdown(fakeDocument(BEFORE, { comments: onParagraph }).transport, { file, backupRoot, dryRun: true });
  assert.equal(kept.status, "dry_run", "an in-place edit keeps the comment");

  const onList = [{ comment_id: "c2", quote: "b", is_solved: false, is_whole: false, extra: { content_anchor_id: "l2" } }];
  const blocked = await publishMarkdown(fakeDocument(BEFORE, { comments: onList }).transport, { file, backupRoot });
  assert.deepEqual(blocked.blockers.map((item) => item.check), ["open_comments"]);
  const accepted = await publishMarkdown(fakeDocument(BEFORE, { comments: onList }).transport, { file, backupRoot, acceptCommentLoss: true });
  assert.equal(accepted.status, "published");
});

test("a range with a text-drawing widget is deleted piecewise and refilled after the anchor", async () => {
  const log = [];
  const transport = {
    async shortcut(args, options = {}) {
      log.push([...args.slice(4), ...(options.input === undefined ? [] : [options.input])].join(" "));
      return { result: "success", warnings: [] };
    },
  };
  await replaceBlocks(transport, "D1", { ids: ["a", "w", "b", "c"], readonly: new Set(["w"]), anchor: "z", markdown: "新\n" });
  assert.deepEqual(log, [
    "--command block_delete --start-block-id b --end-block-id c",
    "--command block_delete --block-id w",
    "--command block_delete --block-id a",
    "--command block_insert_after --block-id z --doc-format markdown --content - 新\n",
  ]);
  log.length = 0;
  await replaceBlocks(transport, "D1", { ids: ["a", "b"], anchor: "z", markdown: "新\n" });
  assert.deepEqual(log, ["--command block_replace --start-block-id a --end-block-id b --doc-format markdown --content - 新\n"]);
  log.length = 0;
  await replaceBlocks(transport, "D1", { ids: ["w"], readonly: new Set(["w"]), anchor: null });
  assert.deepEqual(log, ["--command block_delete --block-id w"]);
});
