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

test("republishing requires an explicit mode and refuses documents handed over to Feishu", async () => {
  const { file, backupRoot } = workspace();
  await publishMarkdown(fakeFeishu().transport, { file, target: folder, backupRoot });
  const again = await publishMarkdown(fakeFeishu().transport, { file, backupRoot });
  assert.equal(again.status, "needs_mode");

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
