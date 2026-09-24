import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
import { tempDir } from "./temp.mjs";

// 发布会把新建的文档记进 $XDG_DATA_HOME 下的清单，测试一律写到临时目录
process.env.XDG_DATA_HOME = tempDir("feishu-xdg-");

const SAMPLE = "---\ntitle: 手册\n---\n# 手册\n\n## 步骤\n\n> [!NOTE]\n> 先登录\n\n```mermaid\nflowchart LR\n  A-->B\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
const PUBLISHED_XML = '<title>手册</title><h2>步骤</h2><callout emoji="📝"><p>先登录</p></callout><readonly-block id="w1" type="isv"></readonly-block><table></table>';

function workspace(markdown = SAMPLE) {
  const dir = tempDir("feishu-publish-");
  const file = join(dir, "manual.md");
  writeFileSync(file, markdown);
  return { dir, file, backupRoot: join(dir, "backups") };
}

// 按 publish 实际发出的调用最小模拟飞书：一篇文档、根下的占位段落、评论和版本号
function fakeFeishu({ comments = [], remoteMarkdown = "published", revision = 5, widgetFails = false, whiteboardFallback = true, title = "手册" } = {}) {
  const log = [];
  const doc = { id: "D1", revision, markdown: remoteMarkdown };
  const root = [{ block_id: "p0", block_type: 2, parent_id: "D1", text: { elements: [{ text_run: { content: "步骤说明" } }] } }];
  // 占位段落的文字取自这次写入的正文（带本次的随机前缀）
  const placeholder = (input) => {
    const content = String(input ?? "").match(/\[\[feishu-mermaid:[^\]]+\]\]/)?.[0] ?? "[[feishu-mermaid:1]]";
    return { block_id: "ph1", block_type: 2, parent_id: "D1", text: { elements: [{ text_run: { content } }] } };
  };
  const transport = {
    async shortcut(args, options = {}) {
      log.push({ shortcut: args.slice(0, 2).join(" "), args, input: options.input, cwd: options.cwd });
      if (args[1] === "+create") {
        root.push(placeholder(options.input));
        return { document: { document_id: "D1", url: "https://lexin.feishu.cn/docx/D1", revision_id: 1 }, warnings: [] };
      }
      if (args[1] === "+fetch") {
        const format = args[args.indexOf("--doc-format") + 1];
        return { document: { content: format === "xml" ? PUBLISHED_XML : doc.markdown, revision_id: doc.revision } };
      }
      if (args[1] === "+update") {
        const command = args[args.indexOf("--command") + 1];
        if (command === "overwrite") {
          root.splice(1, root.length, placeholder(options.input));
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
      if (name === "docx.v1.document.get") return { document: { revision_id: doc.revision, title } };
      if (name === "drive.v1.fileComment.list") return { items: comments, has_more: false };
      if (name === "docx.v1.documentBlock.batchUpdate") return {};
      if (name === "docx.v1.documentBlock.get") {
        return { block: { block_id: args.path.block_id, block_type: 40, add_ons: { component_type_id: MERMAID_WIDGET_TYPE, record: JSON.stringify({ data: "flowchart LR\n  A-->B", view: "chart" }) } } };
      }
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
  assert.match(create.input, /\[\[feishu-mermaid:[0-9a-f]{8}-1\]\]/);
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

// 一篇文档：+fetch 返回当前 XML；任何 +update 之后文档变成 after（默认 AFTER）。
// widgets 是小组件块 id → 图的源码；convertFails 让原地改写的转换失败
function fakeDocument(initialXml, { comments = [], after = AFTER, widgets = {}, convertFails = false, drift = null } = {}) {
  const log = [];
  let xml = initialXml;
  let xmlFetches = 0;
  let widgetReads = 0;
  const transport = {
    async shortcut(args, options = {}) {
      log.push({ shortcut: args.slice(0, 2).join(" "), args, input: options.input });
      if (args[1] === "+create") return { document: { document_id: "D1", url: "https://lexin.feishu.cn/docx/D1", revision_id: 1 }, warnings: [] };
      if (args[1] === "+fetch") {
        const format = args[args.indexOf("--doc-format") + 1];
        // drift：第一次读 XML 之后别人改了正文
        if (format === "xml" && drift && (xmlFetches += 1) > 1) xml = drift;
        return { document: { content: format === "xml" ? xml : `md:${xml}`, revision_id: xml === initialXml ? 5 : 6 } };
      }
      if (args[1] === "+update") {
        xml = after;
        return { result: "success", warnings: [] };
      }
      throw new Error(`unexpected shortcut ${args.join(" ")}`);
    },
    async call(name, args) {
      log.push({ call: name, args });
      if (name === "docx.v1.document.convert") {
        if (convertFails) throw new Error("convert failed");
        return { first_level_block_ids: ["x"], blocks: [{ block_id: "x", block_type: 2, text: { elements: [{ text_run: { content: args.data.content } }] } }] };
      }
      if (name === "docx.v1.documentBlock.get") {
        // widgets 为 null 时不返回源码，模拟 2.2.0 还不读小组件源码时存下的哈希
        if (!widgets) return { block: { block_id: args.path.block_id, block_type: 40 } };
        widgetReads += 1;
        const code = typeof widgets === "function" ? widgets(args.path.block_id, widgetReads) : widgets[args.path.block_id] ?? "";
        return { block: { block_id: args.path.block_id, block_type: 40, add_ons: { component_type_id: MERMAID_WIDGET_TYPE, record: JSON.stringify({ data: code, view: "chart" }) } } };
      }
      if (name === "docx.v1.documentBlock.batchUpdate") return {};
      if (name === "drive.v1.fileComment.list") return { items: comments, has_more: false };
      if (name === "docx.v1.documentBlock.list") return { items: [] };
      if (name === "docx.v1.document.get") return { document: { revision_id: xml === initialXml ? 5 : 6 } };
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

// ---- 第一轮评审（codex-vps）发现的问题 ----

test("a paragraph whose in-place rewrite cannot be converted is checked for comments before it is replaced", async () => {
  const { file, backupRoot } = await publishedV1();
  const onParagraph = [{ comment_id: "c1", quote: "段落一", is_solved: false, is_whole: false, extra: { content_anchor_id: "p1" } }];
  const kept = await publishMarkdown(fakeDocument(BEFORE, { comments: onParagraph }).transport, { file, backupRoot, dryRun: true });
  assert.equal(kept.status, "dry_run", "converted in place, the comment keeps its anchor");
  const blocked = await publishMarkdown(fakeDocument(BEFORE, { comments: onParagraph, convertFails: true }).transport, { file, backupRoot, dryRun: true });
  assert.deepEqual(blocked.blockers.map((item) => item.check), ["open_comments"]);
  assert.equal(blocked.summary.inPlace, 0);
});

const W1 = "# T\n\n段落一\n\n```mermaid\nflowchart LR\n  A-->B\n```\n";
const W_BEFORE = '<title id="t">T</title><p id="p1">段落一</p><readonly-block id="w1" type="isv"></readonly-block>';

async function publishedWidgetDoc() {
  const context = workspace(W1);
  const first = await publishMarkdown(fakeDocument(W_BEFORE, { widgets: { w1: "flowchart LR\n  A-->B" } }).transport, { file: context.file, target: folder, backupRoot: context.backupRoot });
  assert.equal(first.verification.incrementalReady, true);
  return context;
}

test("when the rewrite of a paragraph next to a widget falls back, the insert anchors before the whole range", async () => {
  const { file, backupRoot } = await publishedWidgetDoc();
  writeFileSync(file, W1.replace("段落一", "段落一（改）").replace("A-->B", "A-->C"));
  const after = '<title id="t">T</title><p id="p9">段落一（改）</p><readonly-block id="w9" type="isv"></readonly-block>';
  const { transport, log } = fakeDocument(W_BEFORE, { widgets: { w1: "flowchart LR\n  A-->B", w9: "flowchart LR\n  A-->C" }, convertFails: true, after });
  await publishMarkdown(transport, { file, backupRoot });
  const updates = log.filter((entry) => entry.shortcut === "docs +update").map((entry) => entry.args.slice(4, 8).join(" "));
  assert.deepEqual(updates.slice(0, 3), [
    "--command block_delete --block-id w1",
    "--command block_delete --block-id p1",
    "--command block_insert_after --block-id 0",
  ]);
});

test("a diagram edited in Feishu is a conflict when the local diagram changes too", async () => {
  const { file, backupRoot } = await publishedWidgetDoc();
  writeFileSync(file, W1.replace("A-->B", "A-->D"));
  const clean = await publishMarkdown(fakeDocument(W_BEFORE, { widgets: { w1: "flowchart LR\n  A-->B" } }).transport, { file, backupRoot, dryRun: true });
  assert.equal(clean.status, "dry_run");
  const edited = await publishMarkdown(fakeDocument(W_BEFORE, { widgets: { w1: "flowchart LR\n  A-->C" } }).transport, { file, backupRoot, dryRun: true });
  assert.deepEqual(edited.blockers.map((item) => item.check), ["remote_changed"]);
});

test("paragraphs reordered in Feishu block the publish, and a forced publish drops the block map", async () => {
  const { file, backupRoot } = await publishedV1();
  const swapped = BEFORE.replace('<p id="p1">段落一</p>', "#").replace('<p id="p2">段落二</p>', '<p id="p1">段落一</p>').replace("#", '<p id="p2">段落二</p>');
  const blocked = await publishMarkdown(fakeDocument(swapped).transport, { file, backupRoot, dryRun: true });
  assert.ok(blocked.blockers.some((item) => item.check === "remote_reordered"));
  const afterSwapped = AFTER.replace('<p id="p1">段落一（改）</p>', "#").replace('<p id="p2">段落二</p>', '<p id="p1">段落一（改）</p>').replace("#", '<p id="p2">段落二</p>');
  const forced = await publishMarkdown(fakeDocument(swapped, { after: afterSwapped }).transport, { file, backupRoot, force: true });
  assert.equal(forced.verification.incrementalReady, false);
  assert.match(forced.verification.alignmentNote, /调整过段落顺序/);
  assert.equal(readState(statePathFor(file)).units, null);
});

test("an edit made in Feishu and kept by one publish still conflicts when the local side changes it later", async () => {
  const { file, backupRoot } = await publishedV1();
  const remoteEdit = (xml) => xml.replace("段落二", "段落二（飞书上改过）");
  const first = await publishMarkdown(fakeDocument(remoteEdit(BEFORE), { after: remoteEdit(AFTER) }).transport, { file, backupRoot });
  assert.equal(first.checks.preservedRemoteEdits, 1);
  writeFileSync(file, V2.replace("段落二", "段落二（本地改）"));
  const second = await publishMarkdown(fakeDocument(remoteEdit(AFTER)).transport, { file, backupRoot, dryRun: true });
  assert.deepEqual(second.blockers.map((item) => item.check), ["remote_changed"]);
});

// ---- 第二轮评审发现的问题 ----

test("comments on blocks that Feishu recreated inside a replaced callout still block the replace", async () => {
  const context = workspace("# T\n\n> [!NOTE]\n> 提示\n");
  const before = '<title id="t">T</title><callout id="c1" emoji="📝"><p id="cp1">提示</p></callout>';
  await publishMarkdown(fakeDocument(before).transport, { file: context.file, target: folder, backupRoot: context.backupRoot });
  writeFileSync(context.file, "# T\n\n> [!NOTE]\n> 新提示\n");
  const recreated = before.replace('id="cp1"', 'id="cp9"');
  const comments = [{ comment_id: "c9", quote: "提示", is_solved: false, is_whole: false, extra: { content_anchor_id: "cp9" } }];
  const result = await publishMarkdown(fakeDocument(recreated, { comments }).transport, { file: context.file, backupRoot: context.backupRoot, dryRun: true });
  assert.deepEqual(result.blockers.map((item) => item.check), ["open_comments"]);
});

test("an overwrite after an incremental publish that kept Feishu edits is blocked until they are merged", async () => {
  const { file, backupRoot } = await publishedV1();
  const remoteEdit = (xml) => xml.replace("段落二", "段落二（飞书上改过）");
  await publishMarkdown(fakeDocument(remoteEdit(BEFORE), { after: remoteEdit(AFTER) }).transport, { file, backupRoot });
  assert.equal(readState(statePathFor(file)).unmerged_remote_edits.length, 1);
  const overwrite = await publishMarkdown(fakeDocument(remoteEdit(AFTER)).transport, { file, backupRoot, overwrite: true, dryRun: true });
  assert.equal(overwrite.checks.remoteChanged, false, "nothing changed since the last publish");
  assert.deepEqual(overwrite.blockers.map((item) => item.check), ["remote_changed"]);
});

test("a state written before diagram sources were hashed still catches a diagram edited in Feishu", async () => {
  const { file, backupRoot } = workspace(W1);
  await publishMarkdown(fakeDocument(W_BEFORE, { widgets: null }).transport, { file, target: folder, backupRoot });
  const state = readState(statePathFor(file));
  delete state.units_version;
  writeFileSync(statePathFor(file), JSON.stringify(state));
  writeFileSync(file, W1.replace("A-->B", "A-->D"));
  const clean = await publishMarkdown(fakeDocument(W_BEFORE, { widgets: { w1: "flowchart LR\n  A-->B" } }).transport, { file, backupRoot, dryRun: true });
  assert.equal(clean.status, "dry_run");
  const edited = await publishMarkdown(fakeDocument(W_BEFORE, { widgets: { w1: "flowchart LR\n  A-->C" } }).transport, { file, backupRoot, dryRun: true });
  assert.deepEqual(edited.blockers.map((item) => item.check), ["remote_changed"]);
});

// ---- 第三轮评审发现的问题 ----

test("only this run's placeholder turns into a widget; a paragraph with the same-looking text stays", async () => {
  const { transport, log } = fakeFeishu();
  await transport.shortcut(["docs", "+create"], { input: "[[feishu-mermaid:0a1b2c3d-1]]" });
  const diagrams = [{ index: 1, placeholder: "[[feishu-mermaid:0a1b2c3d-1]]", code: "flowchart LR\n  A-->B" }];
  const listed = await transport.call("docx.v1.documentBlock.list", {});
  listed.items.unshift({ block_id: "old", block_type: 2, parent_id: "D1", text: { elements: [{ text_run: { content: "[[feishu-mermaid:1]]" } }] } });
  const own = { ...transport, call: async (name, args) => (name === "docx.v1.documentBlock.list" ? listed : transport.call(name, args)) };
  const [result] = await replaceDiagramPlaceholders(own, "D1", diagrams);
  assert.equal(result.status, "widget");
  const removed = log.find((entry) => entry.call === "docx.v1.documentBlockChildren.batchDelete");
  assert.equal(removed.args.data.start_index, 2, "the new placeholder (after p0) is replaced, not the old paragraph");
});

test("an old state checks every diagram, so an untouched diagram edited in Feishu stays a conflict after the upgrade", async () => {
  const { file, backupRoot } = workspace(W1);
  await publishMarkdown(fakeDocument(W_BEFORE, { widgets: null }).transport, { file, target: folder, backupRoot });
  const state = readState(statePathFor(file));
  delete state.units_version;
  writeFileSync(statePathFor(file), JSON.stringify(state));
  const remote = { w1: "flowchart LR\n  A-->C" };
  writeFileSync(file, W1.replace("段落一", "段落一（改）"));
  const first = await publishMarkdown(fakeDocument(W_BEFORE, { widgets: remote, after: W_BEFORE.replace("段落一", "段落一（改）") }).transport, { file, backupRoot });
  assert.equal(first.checks.preservedRemoteEdits, 1);
  assert.equal(readState(statePathFor(file)).unmerged_remote_edits.length, 1);
  writeFileSync(file, W1.replace("段落一", "段落一（改）").replace("A-->B", "A-->D"));
  const second = await publishMarkdown(fakeDocument(W_BEFORE.replace("段落一", "段落一（改）"), { widgets: remote }).transport, { file, backupRoot, dryRun: true });
  assert.deepEqual(second.blockers.map((item) => item.check), ["remote_changed"]);
});

test("a title changed on both sides needs --force", async () => {
  const { file, backupRoot } = await publishedV1();
  writeFileSync(file, V2.replace("# 手册", "# 手册（本地）"));
  const renamed = (xml) => xml.replace('<title id="t">手册</title>', '<title id="t">手册（飞书）</title>');
  const blocked = await publishMarkdown(fakeDocument(renamed(BEFORE)).transport, { file, backupRoot, dryRun: true });
  assert.ok(blocked.blockers.some((item) => item.check === "remote_title_changed"));
  const same = await publishMarkdown(fakeDocument(BEFORE).transport, { file, backupRoot, dryRun: true });
  assert.equal(same.checks.titleConflict, false);
});

// ---- 第四轮评审发现的问题 ----

test("when the block to insert after was deleted in Feishu, new content goes after the nearest block still there", async () => {
  const { file, backupRoot } = await publishedWidgetDoc();
  writeFileSync(file, W1.replace("A-->B", "A-->C"));
  const withoutP1 = '<title id="t">T</title><readonly-block id="w1" type="isv"></readonly-block>';
  const { transport, log } = fakeDocument(withoutP1, { widgets: { w1: "flowchart LR\n  A-->B" }, after: '<title id="t">T</title><readonly-block id="w9" type="isv"></readonly-block>' });
  const result = await publishMarkdown(transport, { file, backupRoot });
  assert.equal(result.checks.preservedRemoteEdits, 1, "the deleted paragraph is kept as a Feishu-side change");
  const updates = log.filter((entry) => entry.shortcut === "docs +update").map((entry) => entry.args.slice(4, 8).join(" "));
  assert.deepEqual(updates.slice(0, 2), ["--command block_delete --block-id w1", "--command block_insert_after --block-id 0"]);
});

test("only this run's leftover placeholders count as leftovers", () => {
  const xml = "<p>[[feishu-mermaid:deadbeef-1]]</p><p>[[feishu-mermaid:0a1b2c3d-1]]</p>";
  assert.equal(countPublished(xml, ["[[feishu-mermaid:0a1b2c3d-1]]"]).placeholders, 1);
  assert.equal(countPublished(xml).placeholders, 0);
});

// ---- 第五轮评审发现的问题 ----

test("a forced publish re-inserts a paragraph that was deleted in Feishu instead of rewriting the missing block", async () => {
  const { file, backupRoot } = await publishedWidgetDoc();
  writeFileSync(file, W1.replace("段落一", "段落一（改）").replace("A-->B", "A-->C"));
  const withoutP1 = '<title id="t">T</title><readonly-block id="w1" type="isv"></readonly-block>';
  const blocked = await publishMarkdown(fakeDocument(withoutP1, { widgets: { w1: "flowchart LR\n  A-->B" } }).transport, { file, backupRoot, dryRun: true });
  assert.deepEqual(blocked.blockers.map((item) => item.check), ["remote_changed"]);
  const { transport, log } = fakeDocument(withoutP1, { widgets: { w1: "flowchart LR\n  A-->B" }, after: withoutP1 });
  await publishMarkdown(transport, { file, backupRoot, force: true });
  assert.equal(log.filter((entry) => entry.call === "docx.v1.documentBlock.batchUpdate").length, 0, "no in-place rewrite of the missing p1");
  const updates = log.filter((entry) => entry.shortcut === "docs +update");
  assert.deepEqual(updates.slice(0, 2).map((entry) => entry.args.slice(4, 8).join(" ")), ["--command block_delete --block-id w1", "--command block_insert_after --block-id 0"]);
  assert.match(updates[1].input, /^段落一（改）\n\n\[\[feishu-mermaid:[0-9a-f]{8}-1\]\]\n$/);
});

test("when the last item of a list was deleted in Feishu, new content goes after the item that is left", async () => {
  const L1 = "# T\n\n- 项一\n- 项二\n\n```mermaid\nflowchart LR\n  A-->B\n```\n";
  const L_BEFORE = '<title id="t">T</title><ul><li id="l1">项一</li><li id="l2">项二</li></ul><readonly-block id="w1" type="isv"></readonly-block>';
  const context = workspace(L1);
  await publishMarkdown(fakeDocument(L_BEFORE, { widgets: { w1: "flowchart LR\n  A-->B" } }).transport, { file: context.file, target: folder, backupRoot: context.backupRoot });
  writeFileSync(context.file, L1.replace("A-->B", "A-->C"));
  const withoutL2 = L_BEFORE.replace('<li id="l2">项二</li>', "");
  const { transport, log } = fakeDocument(withoutL2, { widgets: { w1: "flowchart LR\n  A-->B" }, after: withoutL2 });
  await publishMarkdown(transport, { file: context.file, backupRoot: context.backupRoot });
  const updates = log.filter((entry) => entry.shortcut === "docs +update").map((entry) => entry.args.slice(4, 8).join(" "));
  assert.deepEqual(updates.slice(0, 2), ["--command block_delete --block-id w1", "--command block_insert_after --block-id l1"]);
});

// ---- 第六轮评审发现的问题 ----

test("after list items were reordered and the last one deleted in Feishu, new content goes after the item now last", async () => {
  const L1 = "# T\n\n- 项一\n- 项二\n- 项三\n\n```mermaid\nflowchart LR\n  A-->B\n```\n";
  const L_BEFORE = '<title id="t">T</title><ul><li id="l1">项一</li><li id="l2">项二</li><li id="l3">项三</li></ul><readonly-block id="w1" type="isv"></readonly-block>';
  const context = workspace(L1);
  await publishMarkdown(fakeDocument(L_BEFORE, { widgets: { w1: "flowchart LR\n  A-->B" } }).transport, { file: context.file, target: folder, backupRoot: context.backupRoot });
  writeFileSync(context.file, L1.replace("A-->B", "A-->C"));
  const now = '<title id="t">T</title><ul><li id="l2">项二</li><li id="l1">项一</li></ul><readonly-block id="w1" type="isv"></readonly-block>';
  const blocked = await publishMarkdown(fakeDocument(now, { widgets: { w1: "flowchart LR\n  A-->B" } }).transport, { file: context.file, backupRoot: context.backupRoot, dryRun: true });
  assert.ok(blocked.blockers.some((item) => item.check === "remote_reordered"), "reordered list items block by default");
  const { transport, log } = fakeDocument(now, { widgets: { w1: "flowchart LR\n  A-->B" }, after: now });
  await publishMarkdown(transport, { file: context.file, backupRoot: context.backupRoot, force: true });
  const updates = log.filter((entry) => entry.shortcut === "docs +update").map((entry) => entry.args.slice(4, 8).join(" "));
  assert.deepEqual(updates.slice(0, 2), ["--command block_delete --block-id w1", "--command block_insert_after --block-id l1"]);
});

test("a paragraph deleted on both sides needs no request, and the diagram is still rebuilt", async () => {
  const P1 = "# T\n\n段落一\n\n## 小节\n\n```mermaid\nflowchart LR\n  A-->B\n```\n";
  const P_BEFORE = '<title id="t">T</title><p id="p1">段落一</p><h2 id="h1">小节</h2><readonly-block id="w1" type="isv"></readonly-block>';
  const context = workspace(P1);
  await publishMarkdown(fakeDocument(P_BEFORE, { widgets: { w1: "flowchart LR\n  A-->B" } }).transport, { file: context.file, target: folder, backupRoot: context.backupRoot });
  writeFileSync(context.file, P1.replace("段落一\n\n", "").replace("A-->B", "A-->C"));
  const withoutP1 = P_BEFORE.replace('<p id="p1">段落一</p>', "");
  const { transport, log } = fakeDocument(withoutP1, { widgets: { w1: "flowchart LR\n  A-->B" }, after: withoutP1 });
  await publishMarkdown(transport, { file: context.file, backupRoot: context.backupRoot, force: true });
  const updates = log.filter((entry) => entry.shortcut === "docs +update");
  assert.deepEqual(updates.map((entry) => entry.args.slice(4, 8).join(" ")), ["--command block_delete --block-id w1", "--command block_insert_after --block-id h1"]);
  assert.ok(updates.every((entry) => !entry.args.includes("block_insert_after") || entry.input !== undefined), "no insert without content");
});

// ---- 第七轮评审发现的问题 ----

const LIST3 = "# T\n\n- 项一\n- 项二\n- 项三\n";
const LIST3_XML = '<title id="t">T</title><ul><li id="l1">项一</li><li id="l2">项二</li><li id="l3">项三</li></ul>';

test("items reordered inside a list block the publish; forced, new content goes after the item that is last now", async () => {
  const context = workspace(LIST3);
  await publishMarkdown(fakeDocument(LIST3_XML).transport, { file: context.file, target: folder, backupRoot: context.backupRoot });
  writeFileSync(context.file, `${LIST3}\n段落 P\n`);
  const swapped = LIST3_XML.replace('<li id="l2">项二</li><li id="l3">项三</li>', '<li id="l3">项三</li><li id="l2">项二</li>');
  const blocked = await publishMarkdown(fakeDocument(swapped).transport, { file: context.file, backupRoot: context.backupRoot, dryRun: true });
  assert.deepEqual(blocked.blockers.map((item) => item.check), ["remote_reordered"]);
  const { transport, log } = fakeDocument(swapped, { after: swapped });
  await publishMarkdown(transport, { file: context.file, backupRoot: context.backupRoot, force: true });
  const insert = log.find((entry) => entry.shortcut === "docs +update");
  assert.deepEqual(insert.args.slice(4, 8), ["--command", "block_insert_after", "--block-id", "l2"]);
});

test("an item added in Feishu to a list counts as a block the local side does not have", async () => {
  const context = workspace(LIST3);
  await publishMarkdown(fakeDocument(LIST3_XML).transport, { file: context.file, target: folder, backupRoot: context.backupRoot });
  writeFileSync(context.file, `${LIST3}\n段落 P\n`);
  const added = LIST3_XML.replace("</ul>", '<li id="l4">项四</li></ul>');
  const result = await publishMarkdown(fakeDocument(added).transport, { file: context.file, backupRoot: context.backupRoot, dryRun: true });
  assert.ok(result.blockers.some((item) => item.check === "remote_inserted"));
  assert.equal(result.checks.remoteInserted, 1);
});

test("an overwrite that changes the title is blocked when Feishu renamed the document meanwhile", async () => {
  const { file, backupRoot } = workspace();
  const first = fakeFeishu();
  await publishMarkdown(first.transport, { file, target: folder, backupRoot });
  writeFileSync(file, SAMPLE.replace("title: 手册", "title: 手册（本地）").replace("# 手册", "# 手册（本地）"));
  const renamed = fakeFeishu({ remoteMarkdown: "published", revision: 5, title: "手册（飞书）" });
  const blocked = await publishMarkdown(renamed.transport, { file, backupRoot, overwrite: true, dryRun: true });
  assert.deepEqual(blocked.blockers.map((item) => item.check), ["remote_title_changed"]);
  const same = fakeFeishu({ remoteMarkdown: "published", revision: 5, title: "手册" });
  assert.equal((await publishMarkdown(same.transport, { file, backupRoot, overwrite: true, dryRun: true })).checks.titleConflict, false);
});

// ---- 第八轮评审发现的问题 ----

test("a forced publish after a reorder deletes only the chosen blocks, not what sits between them now", async () => {
  const ABC = "# T\n\n段落A\n\n段落B\n\n段落C\n";
  const ABC_XML = '<title id="t">T</title><p id="a">段落A</p><p id="b">段落B</p><p id="c">段落C</p>';
  const context = workspace(ABC);
  await publishMarkdown(fakeDocument(ABC_XML).transport, { file: context.file, target: folder, backupRoot: context.backupRoot });
  writeFileSync(context.file, "# T\n\n段落C\n");
  const reordered = '<title id="t">T</title><p id="a">段落A</p><p id="c">段落C</p><p id="b">段落B</p>';
  const { transport, log } = fakeDocument(reordered, { after: '<title id="t">T</title><p id="c">段落C</p>' });
  await publishMarkdown(transport, { file: context.file, backupRoot: context.backupRoot, force: true });
  const updates = log.filter((entry) => entry.shortcut === "docs +update").map((entry) => entry.args.slice(4).join(" "));
  assert.deepEqual(updates, ["--command block_delete --block-id b", "--command block_delete --block-id a"]);
});

// ---- 第九轮评审发现的问题 ----

test("the insert anchor never falls on a block that another step deletes", async () => {
  const doc = "# T\n\n段落A\n\n段落B\n\n段落C\n\n```mermaid\nflowchart LR\n  A-->B\n```\n";
  const before = '<title id="t">T</title><p id="a">段落A</p><p id="b">段落B</p><p id="c">段落C</p><readonly-block id="w" type="isv"></readonly-block>';
  const context = workspace(doc);
  await publishMarkdown(fakeDocument(before, { widgets: { w: "flowchart LR\n  A-->B" } }).transport, { file: context.file, target: folder, backupRoot: context.backupRoot });
  writeFileSync(context.file, "# T\n\n段落C\n\n```mermaid\nflowchart LR\n  A-->C\n```\n");
  const now = '<title id="t">T</title><p id="b">段落B</p><p id="a">段落A</p><readonly-block id="w" type="isv"></readonly-block>';
  const { transport, log } = fakeDocument(now, { widgets: { w: "flowchart LR\n  A-->B" }, after: now });
  await publishMarkdown(transport, { file: context.file, backupRoot: context.backupRoot, force: true });
  const updates = log.filter((entry) => entry.shortcut === "docs +update").map((entry) => entry.args.slice(4).join(" "));
  assert.match(updates[1], /^--command block_insert_after --block-id 0 /, "not after b, which the next step deletes");
  assert.deepEqual(updates.slice(2), ["--command block_delete --start-block-id b --end-block-id a"]);
});

test("after a forced reorder, comments on a block that stays are not in the way", async () => {
  const ABC = "# T\n\n段落A\n\n段落B\n\n段落C\n";
  const context = workspace(ABC);
  await publishMarkdown(fakeDocument('<title id="t">T</title><p id="a">段落A</p><p id="b">段落B</p><p id="c">段落C</p>').transport, { file: context.file, target: folder, backupRoot: context.backupRoot });
  writeFileSync(context.file, "# T\n\n段落C\n");
  const reordered = '<title id="t">T</title><p id="a">段落A</p><p id="c">段落C</p><p id="b">段落B</p>';
  const comments = [{ comment_id: "c1", quote: "段落C", is_solved: false, is_whole: false, extra: { content_anchor_id: "c" } }];
  const result = await publishMarkdown(fakeDocument(reordered, { comments }).transport, { file: context.file, backupRoot: context.backupRoot, force: true, dryRun: true });
  assert.equal(result.checks.commentsOnReplaced, 0);
  assert.equal(result.status, "dry_run");
});

// ---- 第十轮评审发现的问题 ----

test("when someone edits Feishu between the read and the write, nothing is written", async () => {
  const { file, backupRoot } = await publishedV1();
  const drift = BEFORE.replace('<p id="p2">段落二</p>', '<p id="p2">段落二</p><p id="x">别人刚加的一段</p>');
  const { transport, log } = fakeDocument(BEFORE, { drift });
  await assert.rejects(publishMarkdown(transport, { file, backupRoot }), (error) => error.code === "REMOTE_CHANGED_DURING_PUBLISH");
  assert.equal(log.filter((entry) => entry.shortcut === "docs +update").length, 0);
  assert.equal(log.filter((entry) => entry.call === "docx.v1.documentBlock.batchUpdate").length, 0);
});

// ---- 第十一轮评审发现的问题 ----

test("a child block recreated in Feishu between the read and the write also stops the publish", async () => {
  const context = workspace("# T\n\n> [!NOTE]\n> 提示\n");
  const before = '<title id="t">T</title><callout id="c1" emoji="📝"><p id="cp1">提示</p></callout>';
  await publishMarkdown(fakeDocument(before).transport, { file: context.file, target: folder, backupRoot: context.backupRoot });
  writeFileSync(context.file, "# T\n\n> [!NOTE]\n> 新提示\n");
  const { transport, log } = fakeDocument(before, { drift: before.replace('id="cp1"', 'id="cp9"') });
  await assert.rejects(publishMarkdown(transport, { file: context.file, backupRoot: context.backupRoot }), (error) => error.code === "REMOTE_CHANGED_DURING_PUBLISH");
  assert.equal(log.filter((entry) => entry.shortcut === "docs +update").length, 0);
});

// ---- 第十二轮评审发现的问题 ----

test("a diagram changed in Feishu between the read and the write stops the publish", async () => {
  const { file, backupRoot } = await publishedWidgetDoc();
  writeFileSync(file, W1.replace("A-->B", "A-->D"));
  const widgets = (id, reads) => (reads === 1 ? "flowchart LR\n  A-->B" : "flowchart LR\n  A-->C");
  const { transport, log } = fakeDocument(W_BEFORE, { widgets });
  await assert.rejects(publishMarkdown(transport, { file, backupRoot }), (error) => error.code === "REMOTE_CHANGED_DURING_PUBLISH");
  assert.equal(log.filter((entry) => entry.shortcut === "docs +update").length, 0);
});

// ---- 第十三轮评审发现的问题 ----

test("a rename in Feishu between the read and the write stops a publish that renames too", async () => {
  const { file, backupRoot } = await publishedV1();
  writeFileSync(file, V2.replace("# 手册", "# 手册（本地）"));
  const drift = BEFORE.replace('<title id="t">手册</title>', '<title id="t">手册（飞书）</title>');
  const { transport, log } = fakeDocument(BEFORE, { drift });
  await assert.rejects(publishMarkdown(transport, { file, backupRoot }), (error) => error.code === "REMOTE_CHANGED_DURING_PUBLISH");
  assert.equal(log.filter((entry) => entry.shortcut === "docs +update" || entry.call === "docx.v1.documentBlock.batchUpdate").length, 0);
});
