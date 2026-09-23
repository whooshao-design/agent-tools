// 本地 Markdown → 飞书文档：首次发布新建，之后全量覆盖（增量更新在后续版本提供）。
// 发布状态记在 md 旁边的 <name>.feishu.json；覆盖前检查飞书上有无改动和未解决评论，并先备份。
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { elementsText, listAllBlocks, listChildren } from "./blocks.mjs";
import { MERMAID_PLACEHOLDER_PATTERN, preparePublishMarkdown } from "./markdown.mjs";

export const MERMAID_WIDGET_TYPE = "blk_631fefbbae02400430b8f9f4";
const STATE_SCHEMA = 1;

function fail(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = { failureClass: code, missingScopes: [], ...details };
  throw error;
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function statePathFor(mdPath) {
  return `${mdPath.replace(/\.(md|markdown)$/i, "")}.feishu.json`;
}

export function readState(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function writeState(path, state) {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function defaultBackupRoot() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "agent-tools/feishu-backups");
}

// 文本绘图小组件：view=chart 只显示图，读者可在小组件里切换到代码
export function widgetBlock(code) {
  return {
    block_type: 40,
    add_ons: {
      component_id: "",
      component_type_id: MERMAID_WIDGET_TYPE,
      record: JSON.stringify({ data: code, view: "chart" }),
    },
  };
}

export function countPublished(xml) {
  const count = (pattern) => (String(xml).match(pattern) ?? []).length;
  return {
    headings: count(/<h[1-9][\s>]/g),
    tables: count(/<table[\s>]/g),
    images: count(/<img[\s>]/g),
    callouts: count(/<callout[\s>]/g),
    widgets: count(/<readonly-block\b[^>]*type="isv"/g),
    whiteboards: count(/<whiteboard[\s>]/g),
    placeholders: count(/\[\[feishu-mermaid:\d+\]\]/g),
  };
}

export function compareCounts(expected, counts, codeFallbacks = 0) {
  const mismatches = [];
  for (const item of ["headings", "tables", "images", "callouts"]) {
    if (counts[item] !== expected[item]) mismatches.push({ item, expected: expected[item], actual: counts[item] });
  }
  const diagrams = counts.widgets + counts.whiteboards + codeFallbacks;
  if (diagrams !== expected.diagrams) mismatches.push({ item: "diagrams", expected: expected.diagrams, actual: diagrams });
  if (counts.placeholders > 0) mismatches.push({ item: "placeholders", expected: 0, actual: counts.placeholders });
  return mismatches;
}

async function deleteBlock(transport, documentToken, blockId) {
  await transport.shortcut(["docs", "+update", "--doc", documentToken, "--command", "block_delete", "--block-id", blockId]);
}

// 小组件建不出来时先退到画板（docs_ai 会把 mermaid 代码块转成画板），再不行就保留为代码块
async function fallbackDiagram(transport, documentToken, placeholderId, diagram, cause) {
  const insert = (markdown) =>
    transport.shortcut(
      ["docs", "+update", "--doc", documentToken, "--command", "block_insert_after", "--block-id", placeholderId,
        "--doc-format", "markdown", "--content", "-"],
      { input: markdown },
    );
  let warnings = [];
  try {
    const data = await insert(`\`\`\`mermaid\n${diagram.code}\n\`\`\`\n`);
    warnings = data.warnings ?? [];
    if ((data.document?.new_blocks ?? []).some((block) => block.block_type === "whiteboard")) {
      await deleteBlock(transport, documentToken, placeholderId);
      return { status: "whiteboard", reason: cause.message, warnings };
    }
  } catch (error) {
    warnings = [String(error.message)];
  }
  await insert(`\`\`\`text\n${diagram.code}\n\`\`\`\n`);
  await deleteBlock(transport, documentToken, placeholderId);
  return { status: "code", reason: cause.message, warnings };
}

// docs_ai 建不了小组件：正文里先放占位段落，这里在同一位置建小组件再删掉占位
export async function replaceDiagramPlaceholders(transport, documentToken, diagrams, { newToken = randomUUID } = {}) {
  if (diagrams.length === 0) return [];
  const placeholders = new Map();
  for (const block of await listAllBlocks(transport, documentToken)) {
    const match = block.block_type === 2 ? elementsText(block.text?.elements).trim().match(MERMAID_PLACEHOLDER_PATTERN) : null;
    if (match) placeholders.set(Number(match[1]), block);
  }
  const results = [];
  for (const diagram of diagrams) {
    const block = placeholders.get(diagram.index);
    if (!block) {
      results.push({ index: diagram.index, status: "placeholder_missing" });
      continue;
    }
    try {
      const siblings = await listChildren(transport, documentToken, block.parent_id);
      const index = siblings.findIndex((child) => child.block_id === block.block_id);
      if (index < 0) throw new Error("占位段落不在父块的子块列表里");
      await transport.call("docx.v1.documentBlockChildren.create", {
        path: { document_id: documentToken, block_id: block.parent_id },
        params: { document_revision_id: -1, client_token: newToken() },
        data: { index, children: [widgetBlock(diagram.code)] },
      });
      await transport.call("docx.v1.documentBlockChildren.batchDelete", {
        path: { document_id: documentToken, block_id: block.parent_id },
        params: { document_revision_id: -1, client_token: newToken() },
        data: { start_index: index + 1, end_index: index + 2 },
      });
      results.push({ index: diagram.index, status: "widget" });
    } catch (error) {
      results.push({ index: diagram.index, ...(await fallbackDiagram(transport, documentToken, block.block_id, diagram, error)) });
    }
  }
  return results;
}

async function fetchContent(transport, documentToken, format, detail = "simple") {
  const data = await transport.shortcut(["docs", "+fetch", "--doc", documentToken, "--doc-format", format, "--detail", detail]);
  return { content: data.document?.content ?? "", revision: data.document?.revision_id ?? null };
}

async function snapshot(transport, documentToken) {
  const { content, revision } = await fetchContent(transport, documentToken, "markdown");
  return { revision, contentSha256: sha256(content) };
}

export async function verifyPublished(transport, documentToken, expected, diagramResults) {
  const { content } = await fetchContent(transport, documentToken, "xml");
  const counts = countPublished(content);
  const codeFallbacks = diagramResults.filter((item) => item.status === "code").length;
  return { counts, expected, mismatches: compareCounts(expected, counts, codeFallbacks) };
}

// 只关心会被覆盖影响的评论：未解决、挂在某个块上（全文评论不受影响）
export async function listOpenComments(transport, documentToken) {
  const comments = [];
  let pageToken = null;
  do {
    const value = await transport.call("drive.v1.fileComment.list", {
      path: { file_token: documentToken },
      params: { file_type: "docx", page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    comments.push(...(value.items ?? []));
    pageToken = value.has_more ? value.page_token : null;
  } while (pageToken);
  return comments
    .filter((comment) => !comment.is_solved && !comment.is_whole)
    .map((comment) => ({ id: comment.comment_id, quote: String(comment.quote ?? "").slice(0, 80) }));
}

async function backupDocument(transport, documentToken, revision, backupRoot, now) {
  const dir = join(backupRoot, documentToken);
  mkdirSync(dir, { recursive: true });
  const stamp = now().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const base = join(dir, `${stamp}-r${revision}`);
  const xml = await fetchContent(transport, documentToken, "xml", "with-ids");
  const markdown = await fetchContent(transport, documentToken, "markdown");
  writeFileSync(`${base}.xml`, xml.content);
  writeFileSync(`${base}.md`, markdown.content);
  return { xml: `${base}.xml`, markdown: `${base}.md`, revision };
}

async function updateTitle(transport, documentToken, title) {
  await transport.call("docx.v1.documentBlock.batchUpdate", {
    path: { document_id: documentToken },
    params: { document_revision_id: -1, client_token: randomUUID() },
    data: { requests: [{ block_id: documentToken, update_text_elements: { elements: [{ text_run: { content: title } }] } }] },
  });
}

async function writeContent(transport, prepared, baseDir, args) {
  return transport.shortcut(["docs", ...args, "--doc-format", "markdown", "--content", "-"], {
    input: prepared.body,
    cwd: baseDir,
  });
}

async function finish(transport, context) {
  const { documentToken, prepared, statePath, state, now, source, extra } = context;
  const diagrams = await replaceDiagramPlaceholders(transport, documentToken, prepared.diagrams);
  const verification = await verifyPublished(transport, documentToken, prepared.expected, diagrams);
  const after = await snapshot(transport, documentToken);
  const next = {
    ...state,
    schema: STATE_SCHEMA,
    doc_token: documentToken,
    url: state.url ?? `https://lexin.feishu.cn/docx/${documentToken}`,
    title: prepared.title,
    mode: state.mode ?? "local-master",
    source: basename(context.mdPath),
    source_sha256: sha256(source),
    published_at: now().toISOString(),
    revision: after.revision,
    content_sha256: after.contentSha256,
  };
  writeState(statePath, next);
  const problems = verification.mismatches.length > 0 || (extra.serverWarnings ?? []).length > 0 ||
    diagrams.some((item) => item.status !== "widget");
  return {
    status: problems ? "published_with_issues" : "published",
    url: next.url,
    docToken: documentToken,
    statePath,
    diagrams,
    verification,
    ...extra,
  };
}

export async function publishMarkdown(transport, options) {
  const { file, target = null, doc = null, overwrite = false, dryRun = false, force = false, acceptCommentLoss = false } = options;
  const now = options.now ?? (() => new Date());
  const backupRoot = options.backupRoot ?? defaultBackupRoot();
  const mdPath = resolve(file);
  if (!existsSync(mdPath)) fail(`找不到文件 ${mdPath}`, "FILE_NOT_FOUND");
  const baseDir = dirname(mdPath);
  const source = readFileSync(mdPath, "utf8");
  const prepared = preparePublishMarkdown(source, { fileName: basename(mdPath), baseDir, exists: existsSync });
  if (prepared.errors.length > 0) fail(`发布前检查未通过：${prepared.errors.join("；")}`, "PUBLISH_PRECHECK_FAILED", { errors: prepared.errors });
  const statePath = statePathFor(mdPath);
  const state = readState(statePath);
  const plan = {
    file: mdPath,
    title: prepared.title,
    expected: prepared.expected,
    localWarnings: prepared.warnings,
  };

  if (!state && !doc) {
    if (overwrite) fail("没有发布记录，不能覆盖；首次发布去掉 --overwrite，要覆盖一篇已有文档请用 --doc 指定", "NO_PUBLISH_STATE");
    if (!target || !["folder", "wiki"].includes(target.kind)) {
      fail("首次发布要用 --target 指定飞书文件夹（/drive/folder/…）或知识库节点链接", "TARGET_REQUIRED");
    }
    if (dryRun) return { status: "dry_run", action: "create", parentToken: target.token, ...plan };
    const created = await writeContent(transport, prepared, baseDir, ["+create", "--title", prepared.title, "--parent-token", target.token]);
    const documentToken = created.document?.document_id;
    if (!documentToken) fail("docs +create 没有返回 document_id", "LARK_API_FAILED", { response: created });
    return finish(transport, {
      documentToken,
      prepared,
      statePath,
      mdPath,
      source,
      now,
      state: { url: created.document.url, parent_token: target.token, mode: "local-master" },
      extra: { action: "create", serverWarnings: created.warnings ?? [], ...plan },
    });
  }

  if (state?.mode === "feishu-master") {
    fail("这篇文档已标记为以飞书为准，不再从本地覆盖；要改请直接在飞书上改", "FEISHU_MASTER", { statePath });
  }
  if (state && doc && doc.token !== state.doc_token) {
    fail(`--doc 与发布记录里的文档不一致（记录是 ${state.doc_token}）`, "DOC_MISMATCH", { statePath });
  }
  const documentToken = doc?.token ?? state.doc_token;
  if (!overwrite) {
    return {
      status: "needs_mode",
      action: "update",
      docToken: documentToken,
      message: "这篇文档已经发布过。增量更新在后续版本提供；确认整篇覆盖请加 --overwrite，建议先加 --dry-run 看检查结果",
      ...plan,
    };
  }

  const info = await transport.call("docx.v1.document.get", { path: { document_id: documentToken } });
  const currentRevision = info.document?.revision_id ?? null;
  let remoteChanged = null;
  if (state) {
    remoteChanged = currentRevision === state.revision ? false : (await snapshot(transport, documentToken)).contentSha256 !== state.content_sha256;
  }
  const comments = await listOpenComments(transport, documentToken);
  const blockers = [];
  if (remoteChanged && !force) {
    blockers.push({ check: "remote_changed", message: "上次发布后飞书上有人改过正文：先用 read 看差异并合回本地，确认要丢弃这些改动再加 --force" });
  }
  if (comments.length > 0 && !acceptCommentLoss) {
    blockers.push({
      check: "open_comments",
      message: `有 ${comments.length} 条未解决评论挂在正文上，覆盖后会失去挂靠位置：先处理，或确认后加 --accept-comment-loss`,
      comments: comments.slice(0, 10),
    });
  }
  const checks = {
    currentRevision,
    publishedRevision: state?.revision ?? null,
    remoteChanged,
    openComments: comments.length,
    note: state ? null : "没有发布记录，无法判断飞书上是否有人改过；覆盖前会先备份",
  };
  if (blockers.length > 0 || dryRun) {
    return { status: blockers.length > 0 ? "blocked" : "dry_run", action: "overwrite", docToken: documentToken, checks, blockers, ...plan };
  }

  const backup = await backupDocument(transport, documentToken, currentRevision, backupRoot, now);
  const updated = await writeContent(transport, prepared, baseDir, ["+update", "--doc", documentToken, "--command", "overwrite"]);
  if (updated.result && updated.result !== "success") {
    fail(`覆盖未完全成功（result=${updated.result}），备份在 ${backup.xml}`, "OVERWRITE_PARTIAL", { warnings: updated.warnings ?? [], backup });
  }
  if (!state || state.title !== prepared.title) await updateTitle(transport, documentToken, prepared.title);
  return finish(transport, {
    documentToken,
    prepared,
    statePath,
    mdPath,
    source,
    now,
    state: { ...(state ?? { url: `https://lexin.feishu.cn/docx/${documentToken}`, parent_token: null, mode: "local-master" }), last_backup: backup },
    extra: { action: "overwrite", serverWarnings: updated.warnings ?? [], checks, backup, ...plan },
  });
}
