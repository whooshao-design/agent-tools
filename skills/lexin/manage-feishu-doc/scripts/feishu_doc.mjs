#!/usr/bin/env node
// 飞书云文档读写：经官方 lark-cli（用户身份）调用开放平台，写后回读校验。
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { blockText, elementsText, listAllBlocks, listChildren, TEXT_CONTAINER_KEYS } from "./lib/blocks.mjs";
import { buildCleanupList, cleanupChecklist, readRegistry, recordCreated, writeRegistry } from "./lib/cleanup.mjs";
import { editDocument } from "./lib/edit.mjs";
import { lintFile } from "./lib/lint.mjs";
import { preparePublishMarkdown } from "./lib/markdown.mjs";
import { listOpenComments, MERMAID_WIDGET_TYPE, publishMarkdown, readState, statePathFor } from "./lib/publish.mjs";
import { createTransport, LARK_CLI, LarkCliError, runLarkCli } from "./lib/transport.mjs";

export { blockText, listAllBlocks };

const SUPPORTED_HOSTS = new Set(["lexin.feishu.cn"]);
const JSON_CHUNK_SIZE = 40_000;
const MAX_CREATE_BLOCKS = 50;
const MAX_BATCH_UPDATES = 40;
const BLOCK_TYPE_TEXT = 2;
const BLOCK_TYPE_TABLE = 31;
const BLOCK_TYPE_TABLE_CELL = 32;

export const OPERATION_SCOPES = Object.freeze({
  read: ["docx:document:readonly", "offline_access"],
  "write-json": ["docx:document", "docx:document:readonly", "offline_access"],
  // 删行前要查挂在这些行上的评论
  "table-edit": ["docs:document.comment:read", "docx:document", "docx:document:readonly", "offline_access"],
  // Editing existing blocks (tables, paragraphs) needs exactly the same scopes as
  // write-json; the separate name keeps auth-check output honest about intent.
  "write-blocks": ["docx:document", "docx:document:readonly", "offline_access"],
  // 建空文档只需要 docx:document，不需要任何 drive 权限
  "create-doc": ["docx:document", "offline_access"],
  // docs_ai 写正文 + 块接口放小组件 + 覆盖前查评论；画板权限用于小组件失败时的回退
  publish: [
    "board:whiteboard:node:create",
    "docs:document.comment:read",
    "docs:document.media:upload",
    "docx:document",
    "docx:document.block:convert",
    "docx:document:create",
    "docx:document:readonly",
    "docx:document:write_only",
    "offline_access",
  ],
  // 局部修改：docs_ai 插入/替换/删除 + 块接口放小组件 + 查评论
  edit: [
    "board:whiteboard:node:create",
    "docs:document.comment:read",
    "docs:document.media:upload",
    "docx:document",
    "docx:document:readonly",
    "docx:document:write_only",
    "offline_access",
  ],
});

function fail(message, code = "INVALID_ARGUMENT") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function parseTarget(input) {
  if (typeof input !== "string" || input.trim() === "") {
    fail("target 不能为空");
  }
  const value = input.trim();
  if (!value.includes(":") && !value.includes("/")) {
    if (!/^[A-Za-z0-9_-]{8,}$/.test(value)) {
      fail("token 格式无效");
    }
    return { host: null, kind: "docx", token: value, source: "token" };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    fail("target 必须是 lexin.feishu.cn 文档链接或明确的 docx token");
  }
  if (url.protocol !== "https:" || !SUPPORTED_HOSTS.has(url.hostname.toLowerCase())) {
    fail(`不支持的飞书文档域名: ${url.hostname || "unknown"}`, "UNSUPPORTED_HOST");
  }
  // folder 只用于 create-doc；裸 token 一律按 docx 解析，不推断为目录，
  // 否则「在目录下建文档」和「改已有文档」会因为一个字符串歧义而互相误伤。
  const folder = url.pathname.match(/^\/drive\/folder\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if (folder) {
    return { host: url.hostname.toLowerCase(), kind: "folder", token: folder[1], source: "url" };
  }
  const match = url.pathname.match(/^\/(docx|wiki)\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if (!match) {
    fail(
      "仅支持 lexin.feishu.cn 的 /docx/<token>、/wiki/<token> 与 /drive/folder/<token>",
      "UNSUPPORTED_RESOURCE",
    );
  }
  return {
    host: url.hostname.toLowerCase(),
    kind: match[1],
    token: match[2],
    source: "url",
  };
}

/** 除 create-doc 外的命令都只接受文档目标；目录目标要给出明确指引而不是含糊报错 */
export function requireDocumentTarget(target, command) {
  if (target && target.kind === "folder") {
    fail(`${command} 需要文档链接，收到的是目录；在目录下新建文档请用 create-doc`, "UNSUPPORTED_RESOURCE");
  }
  return target;
}

export function requiredScopes(operation, target = null) {
  const base = OPERATION_SCOPES[operation];
  if (!base) {
    fail(`不支持的 operation: ${operation}`);
  }
  const scopes = new Set(base);
  if (target?.kind === "wiki") {
    scopes.add("wiki:wiki:readonly");
  }
  return [...scopes].sort();
}

// lark-cli auth status --json；token 不在输出里，只取状态、scope 和过期时间
export function parseAuthStatus(status, now = Date.now()) {
  const user = status?.identities?.user ?? {};
  // needs_refresh：访问令牌已过期但刷新令牌有效，lark-cli 会在下一次用户身份调用时自动续期
  if (!["ready", "needs_refresh"].includes(user.status)) {
    return { active: false, expired: false, scopes: [], hasRefreshToken: false, expiresAt: null, message: user.message ?? null };
  }
  const seconds = (value) => (value ? Math.floor(Date.parse(value) / 1000) : null);
  const expiresAt = seconds(user.expiresAt);
  const refreshExpiresAt = seconds(user.refreshExpiresAt);
  return {
    active: true,
    expired: user.tokenStatus !== "valid" || (expiresAt !== null && expiresAt * 1000 <= now),
    scopes: String(user.scope ?? "").split(/\s+/).filter(Boolean),
    hasRefreshToken: refreshExpiresAt !== null && refreshExpiresAt * 1000 > now,
    expiresAt,
    refreshExpiresAt,
  };
}

export function assessAuthorization(session, operation, target = null) {
  const needed = requiredScopes(operation, target);
  if (!session.active) {
    return {
      ready: false,
      failureClass: "AUTH_REQUIRED",
      requiredScopes: needed,
      missingScopes: needed,
      nextAction: "运行 authorize 完成一次用户身份 OAuth 授权",
    };
  }
  if (session.expired && !session.hasRefreshToken) {
    return {
      ready: false,
      failureClass: "TOKEN_EXPIRED",
      requiredScopes: needed,
      missingScopes: needed.filter((scope) => !session.scopes.includes(scope)),
      nextAction: "运行 authorize 重新授权，并确保包含 offline_access",
    };
  }
  const missingScopes = needed.filter((scope) => !session.scopes.includes(scope));
  if (missingScopes.length > 0) {
    return {
      ready: false,
      failureClass: "OAUTH_SCOPE_MISSING",
      requiredScopes: needed,
      missingScopes,
      nextAction: "确认应用已添加并发布这些用户身份权限，然后运行 authorize 一次性补授权",
    };
  }
  return {
    ready: true,
    failureClass: null,
    requiredScopes: needed,
    missingScopes: [],
    nextAction: "权限齐全，可直接执行文档操作",
  };
}

function collectSubjects(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectSubjects(item, output);
  } else if (value && typeof value === "object") {
    if (typeof value.subject === "string" && value.subject.includes(":")) output.add(value.subject);
    for (const item of Object.values(value)) collectSubjects(item, output);
  }
  return output;
}

function parseEmbeddedJson(text) {
  const candidates = [text];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue with the next candidate.
    }
  }
  return null;
}

export function classifyFailure(error, context = {}) {
  if (error instanceof LarkCliError) return error.details;
  let text;
  if (typeof error === "string") {
    text = error;
  } else if (error instanceof Error) {
    text = JSON.stringify({
      name: error.name,
      message: error.message,
      code: error.code,
      details: error.details,
    });
  } else {
    text = JSON.stringify(error);
  }
  const parsed = parseEmbeddedJson(text);
  // Lark nests the real error as an escaped JSON string inside rawErrorText, so
  // the subjects only surface after peeling the escaping layers.
  const scopes = [...collectSubjects(parsed)];
  let candidate = text;
  for (let depth = 0; depth < 4; depth += 1) {
    scopes.push(...[...candidate.matchAll(/"subject"\s*:\s*"([^"]+)"/g)].map((match) => match[1]));
    const unescaped = candidate.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (unescaped === candidate) break;
    candidate = unescaped;
  }
  const missingScopes = [...new Set(scopes)].sort();
  if (text.includes("99991679") || missingScopes.length > 0) {
    return {
      failureClass: "OAUTH_SCOPE_MISSING",
      missingScopes,
      nextAction: "添加并发布列出的用户身份权限，然后重新 OAuth 一次",
    };
  }
  if (text.includes("20027")) {
    return {
      failureClass: "APP_PERMISSION_NOT_PUBLISHED",
      missingScopes: context.requiredScopes ?? [],
      nextAction: "在飞书开放平台添加所需用户身份权限并发布应用版本，然后重新授权",
    };
  }
  if (/no active login|token.+expired|unauthorized|invalid.+token/i.test(text)) {
    return {
      failureClass: "AUTH_REQUIRED",
      missingScopes: context.requiredScopes ?? [],
      nextAction: "运行 authorize 后复检一次",
    };
  }
  if (/forbidden|access denied|no permission|permission denied|无权限|禁止访问/i.test(text)) {
    return {
      failureClass: "DOCUMENT_ACCESS_DENIED",
      missingScopes: [],
      nextAction: "请文档所有者授予当前用户对应文档的阅读或编辑权限",
    };
  }
  return {
    failureClass: "LARK_API_FAILED",
    missingScopes: [],
    nextAction: "保留原始错误码并检查飞书 API 返回，不要自动扩大权限",
  };
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function deterministicClientToken(...parts) {
  const chars = sha256(parts.join("\0")).slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function splitText(value, size = JSON_CHUNK_SIZE) {
  const chunks = [];
  for (let start = 0; start < value.length; start += size) {
    let end = Math.min(start + size, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
    chunks.push(value.slice(start, end));
    start = end - size;
  }
  return chunks;
}

function textElements(content) {
  return [{ text_run: { content } }];
}

export function buildManagedBlocks(section, content, heading = null) {
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(section)) {
    fail("section 仅允许 1-80 位字母、数字、点、下划线、冒号或连字符");
  }
  const contentHash = sha256(content);
  const begin = `[[agent-tools/manage-feishu-doc section=${section} sha256=${contentHash} begin]]`;
  const end = `[[agent-tools/manage-feishu-doc section=${section} end]]`;
  const blocks = [{ block_type: 2, text: { elements: textElements(begin) } }];
  if (heading) blocks.push({ block_type: 4, heading2: { elements: textElements(heading) } });
  for (const chunk of splitText(content)) {
    blocks.push({
      block_type: 14,
      code: { style: { language: 28, wrap: true }, elements: textElements(chunk) },
    });
  }
  blocks.push({ block_type: 2, text: { elements: textElements(end) } });
  if (blocks.length > MAX_CREATE_BLOCKS) {
    fail(`JSON 过大：需要 ${blocks.length} 个块，单次安全写入最多 ${MAX_CREATE_BLOCKS} 个`, "CONTENT_TOO_LARGE");
  }
  return { blocks, contentHash, begin, end };
}

function markerText(block) {
  return block?.block_type === 2 ? elementsText(block.text?.elements) : "";
}

function codeText(block) {
  return block?.block_type === 14 ? elementsText(block.code?.elements) : "";
}

export function findManagedSections(blocks, section) {
  const prefix = `[[agent-tools/manage-feishu-doc section=${section} sha256=`;
  const suffix = " begin]]";
  const endMarker = `[[agent-tools/manage-feishu-doc section=${section} end]]`;
  const sections = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const value = markerText(blocks[index]);
    if (!value.startsWith(prefix) || !value.endsWith(suffix)) continue;
    const expectedHash = value.slice(prefix.length, -suffix.length);
    const endIndex = blocks.findIndex((block, candidate) => candidate > index && markerText(block) === endMarker);
    if (endIndex < 0) {
      sections.push({ startIndex: index, endIndex: null, expectedHash, actualHash: null, verified: false });
      continue;
    }
    const content = blocks.slice(index + 1, endIndex).map(codeText).join("");
    const actualHash = sha256(content);
    sections.push({
      startIndex: index,
      endIndex,
      expectedHash,
      actualHash,
      verified: expectedHash === actualHash,
    });
    index = endIndex;
  }
  return sections;
}

export function indexBlocks(blocks) {
  return new Map(blocks.map((block) => [block.block_id, block]));
}

function cellTextBlocks(blockMap, cellId) {
  const cell = blockMap.get(cellId);
  return (cell?.children ?? [])
    .map((childId) => blockMap.get(childId))
    .filter((child) => child?.block_type === BLOCK_TYPE_TEXT);
}

export function listTables(blocks) {
  return blocks
    .filter((block) => block.block_type === BLOCK_TYPE_TABLE)
    .map((block) => ({
      blockId: block.block_id,
      rowSize: block.table?.property?.row_size ?? 0,
      columnSize: block.table?.property?.column_size ?? 0,
    }));
}

// Reads one table into a plain 2-D string grid plus the per-cell text block ids
// needed to write it back. Cell text is the concatenation of every text child,
// which keeps read(write(x)) == x even for cells that carry filler paragraphs.
export function readTable(blocks, tableId) {
  const blockMap = indexBlocks(blocks);
  const table = blockMap.get(tableId);
  if (!table) fail(`找不到块 ${tableId}`, "BLOCK_NOT_FOUND");
  if (table.block_type !== BLOCK_TYPE_TABLE) {
    fail(`块 ${tableId} 不是表格（block_type=${table.block_type}）`, "NOT_A_TABLE");
  }
  const rowSize = table.table?.property?.row_size ?? 0;
  const columnSize = table.table?.property?.column_size ?? 0;
  const cells = table.table?.cells ?? [];
  if (cells.length !== rowSize * columnSize) {
    fail(`表格单元格数量异常: ${cells.length} != ${rowSize}x${columnSize}`, "INVALID_TABLE_SHAPE");
  }
  const rows = [];
  const cellIds = [];
  const cellBlockCounts = [];
  for (let row = 0; row < rowSize; row += 1) {
    const values = [];
    const ids = [];
    const counts = [];
    for (let column = 0; column < columnSize; column += 1) {
      const cellId = cells[row * columnSize + column];
      const textBlocks = cellTextBlocks(blockMap, cellId);
      values.push(textBlocks.map(blockText).join(""));
      ids.push(cellId);
      counts.push(textBlocks.length);
    }
    rows.push(values);
    cellIds.push(ids);
    cellBlockCounts.push(counts);
  }
  return { blockId: tableId, rowSize, columnSize, rows, cellIds, cellBlockCounts };
}

export function diffTable(currentRows, desiredRows) {
  const differences = [];
  for (let row = 0; row < desiredRows.length; row += 1) {
    for (let column = 0; column < desiredRows[row].length; column += 1) {
      const from = currentRows[row]?.[column];
      const to = desiredRows[row][column];
      if (from !== to) differences.push({ row, column, from: from ?? null, to });
    }
  }
  return differences;
}

// Rows created by insert_table_row start with a single empty paragraph, while
// hand-authored tables often carry a filler paragraph above the content one.
// Mixing both shapes makes row heights disagree, so new rows are padded to the
// shape the existing body rows already use.
export function cellBlockTarget(cellBlockCounts, existingRowSize) {
  const counts = cellBlockCounts.slice(1, existingRowSize).flat();
  if (counts.length === 0) return 1;
  const tally = new Map();
  for (const count of counts) tally.set(count, (tally.get(count) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

async function runStreaming(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: ["inherit", "pipe", "pipe"] });
    let output = "";
    const forward = (stream, destination) => {
      stream.on("data", (chunk) => {
        destination.write(chunk);
        if (output.length < 200_000) output += chunk.toString("utf8");
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

export function readAuthStatus(run = runLarkCli) {
  return parseAuthStatus(run(["auth", "status", "--json"]));
}

// lark-cli 在调用接口前会用 refresh token 自动续期，所以 access token 过期但 refresh token 有效时照常可用
export async function checkAuthorization(operation, target, { status = readAuthStatus } = {}) {
  const session = status();
  const usable = session.active && session.expired && session.hasRefreshToken ? { ...session, expired: false } : session;
  const result = assessAuthorization(usable, operation, target);
  if (result.ready && session.refreshExpiresAt && session.refreshExpiresAt * 1000 - Date.now() < 24 * 3600 * 1000) {
    result.warning = "refresh token 不到 24 小时就过期，之后需要重新 authorize";
  }
  return { session, result };
}

// 设备码登录：lark-cli 打印 verification_uri_complete 后阻塞到用户确认（最长约 10 分钟）。
// 在 agent 里要放到后台跑，把链接转给用户，确认后进程自然结束。
async function authorize(operation, target, options) {
  const { session, result: current } = await checkAuthorization(operation, target);
  if (current.ready && !options["device-code"]) return current;
  const args = ["auth", "login", "--json"];
  if (options["device-code"]) {
    args.push("--device-code", options["device-code"]);
  } else {
    const desired = new Set(["offline_access", ...session.scopes, ...requiredScopes(operation, target)]);
    args.push("--scope", [...desired].sort().join(" "));
    if (options["no-wait"]) args.push("--no-wait");
  }
  const result = await runStreaming(LARK_CLI, args);
  if (result.code !== 0) {
    const error = new Error("lark-cli 登录未完成；按输出里的提示处理");
    error.details = { failureClass: "AUTH_REQUIRED", missingScopes: [], nextAction: "重新运行 authorize，并在 10 分钟内让用户打开链接确认" };
    throw error;
  }
  if (options["no-wait"]) return { ready: false, failureClass: "AUTH_PENDING", nextAction: "把上面的 verification_uri_complete 发给用户，确认后运行 authorize --device-code=<device_code>" };
  return (await checkAuthorization(operation, target)).result;
}

function responseNode(value) {
  return value?.node ?? value?.data?.node ?? value;
}

export async function resolveDocument(transport, target) {
  if (target.kind === "docx") return { documentToken: target.token, sourceKind: "docx" };
  const value = await transport.call("wiki.v2.space.getNode", { params: { token: target.token } });
  const node = responseNode(value);
  if (node?.obj_type !== "docx" || !node?.obj_token) {
    fail(`wiki 节点不是可写 docx: obj_type=${node?.obj_type ?? "unknown"}`, "UNSUPPORTED_WIKI_OBJECT");
  }
  return { documentToken: node.obj_token, sourceKind: "wiki", wikiToken: target.token };
}

async function getRootBlocks(transport, documentToken) {
  return listChildren(transport, documentToken, documentToken);
}

async function createBlocks(transport, documentToken, blocks, clientToken) {
  return await transport.call("docx.v1.documentBlockChildren.create", {
    path: { document_id: documentToken, block_id: documentToken },
    params: { document_revision_id: -1, client_token: clientToken },
    data: { children: blocks },
  });
}

async function deleteSection(transport, documentToken, section, contentHash, range) {
  return await transport.call("docx.v1.documentBlockChildren.batchDelete", {
    path: { document_id: documentToken, block_id: documentToken },
    params: {
      document_revision_id: -1,
      client_token: deterministicClientToken(documentToken, section, contentHash, range.startIndex, range.endIndex, "delete"),
    },
    data: { start_index: range.startIndex, end_index: range.endIndex + 1 },
  });
}

function revisionOf(value) {
  return value?.document_revision_id ?? value?.data?.document_revision_id ?? null;
}

export async function writeJson(transport, documentToken, { content, section, heading, mode }) {
  const managed = buildManagedBlocks(section, content, heading);
  let blocks = await getRootBlocks(transport, documentToken);
  let existing = findManagedSections(blocks, section);
  if (existing.some((item) => item.endIndex === null)) {
    fail(`检测到未闭合的托管章节 ${section}，为避免误删已停止`, "PARTIAL_MANAGED_SECTION");
  }
  if (existing.some((item) => !item.verified)) {
    fail(`托管章节 ${section} 的标记哈希与内容不一致，已停止自动覆盖`, "MANAGED_SECTION_TAMPERED");
  }
  const matches = existing.filter((item) => item.actualHash === managed.contentHash);
  if (mode === "append" && existing.length > 0) {
    return {
      status: matches.length > 0 ? "unchanged" : "section_exists",
      verified: matches.length > 0,
      contentHash: managed.contentHash,
      revision: null,
    };
  }

  let revision = null;
  if (matches.length === 0) {
    const created = await createBlocks(
      transport,
      documentToken,
      managed.blocks,
      deterministicClientToken(documentToken, section, managed.contentHash, "create"),
    );
    revision = revisionOf(created);
    blocks = await getRootBlocks(transport, documentToken);
    existing = findManagedSections(blocks, section);
    const inserted = existing.filter((item) => item.actualHash === managed.contentHash && item.verified);
    if (inserted.length === 0) {
      fail("飞书返回写入成功，但回读内容 SHA-256 不一致", "VERIFY_FAILED");
    }
  }

  blocks = await getRootBlocks(transport, documentToken);
  existing = findManagedSections(blocks, section);
  const keep = [...existing]
    .reverse()
    .find((item) => item.actualHash === managed.contentHash && item.verified);
  if (!keep) fail("找不到已校验的新托管章节", "VERIFY_FAILED");
  const obsolete = existing.filter((item) => item !== keep).sort((a, b) => b.startIndex - a.startIndex);
  for (const item of obsolete) {
    const deleted = await deleteSection(transport, documentToken, section, managed.contentHash, item);
    revision = revisionOf(deleted) ?? revision;
  }

  const finalSections = findManagedSections(await getRootBlocks(transport, documentToken), section);
  const final = finalSections.filter((item) => item.actualHash === managed.contentHash && item.verified);
  if (final.length !== 1 || finalSections.length !== 1) {
    fail("写入后托管章节数量或内容校验失败", "VERIFY_FAILED");
  }
  return {
    status: matches.length > 0 && obsolete.length === 0 ? "unchanged" : "updated",
    verified: true,
    contentHash: managed.contentHash,
    revision,
  };
}

async function insertTableRows(transport, documentToken, tableId, count) {
  for (let index = 0; index < count; index += 1) {
    await transport.call("docx.v1.documentBlock.patch", {
      path: { document_id: documentToken, block_id: tableId },
      // client_token 会被飞书去重：内容无关的固定 token 会让下一次补行被当成重复请求而忽略（实测）
      params: { document_revision_id: -1, client_token: randomUUID() },
      // row_index -1 appends; a non-negative value makes the new row land at
      // exactly that index and pushes the rest down.
      data: { insert_table_row: { row_index: -1 } },
    });
  }
}

async function padCellBlocks(transport, documentToken, cellId, missing) {
  for (let index = 0; index < missing; index += 1) {
    await transport.call("docx.v1.documentBlockChildren.create", {
      path: { document_id: documentToken, block_id: cellId },
      params: {
        document_revision_id: -1,
        client_token: deterministicClientToken(documentToken, cellId, "pad", index),
      },
      data: {
        index: 0,
        children: [{ block_type: BLOCK_TYPE_TEXT, text: { elements: textElements("") } }],
      },
    });
  }
}

function cellWriteTarget(blockMap, cellId) {
  const textBlocks = cellTextBlocks(blockMap, cellId);
  if (textBlocks.length === 0) fail(`单元格 ${cellId} 没有可写入的文本块`, "CELL_NOT_WRITABLE");
  return textBlocks[textBlocks.length - 1];
}

// Keeping the existing run's style avoids silently stripping bold headers or
// inline code when only the text content changed.
function styleOf(block) {
  return block?.text?.elements?.[0]?.text_run?.text_element_style ?? undefined;
}

export async function syncTable(transport, documentToken, { tableId, rows, padCells = "auto", dryRun = false }) {
  if (!Array.isArray(rows) || rows.length === 0) fail("rows 必须是非空二维数组");
  const columnSize = rows[0].length;
  if (rows.some((row) => !Array.isArray(row) || row.length !== columnSize)) {
    fail("rows 每一行的列数必须一致", "INVALID_TABLE_SHAPE");
  }
  if (rows.some((row) => row.some((value) => typeof value !== "string"))) {
    fail("rows 的单元格必须是字符串", "INVALID_TABLE_SHAPE");
  }

  let blocks = await listAllBlocks(transport, documentToken);
  let table = readTable(blocks, tableId);
  if (table.columnSize !== columnSize) {
    fail(`列数不匹配：表格 ${table.columnSize} 列，输入 ${columnSize} 列`, "COLUMN_COUNT_MISMATCH");
  }
  if (rows.length < table.rowSize) {
    fail(
      `输入 ${rows.length} 行少于表格现有 ${table.rowSize} 行；本命令不会删除行，请人工确认`,
      "ROW_COUNT_SHRINK",
    );
  }

  const plan = {
    rowsToAppend: rows.length - table.rowSize,
    cellsToWrite: diffTable(table.rows, rows).length,
  };
  if (dryRun) {
    return { status: "dry_run", verified: false, ...plan, differences: diffTable(table.rows, rows) };
  }

  const existingRowSize = table.rowSize;
  if (plan.rowsToAppend > 0) {
    await insertTableRows(transport, documentToken, tableId, plan.rowsToAppend);
    blocks = await listAllBlocks(transport, documentToken);
    table = readTable(blocks, tableId);
    if (table.rowSize !== rows.length) {
      fail(`插入行后行数为 ${table.rowSize}，期望 ${rows.length}`, "ROW_INSERT_FAILED");
    }
    if (padCells === "auto") {
      const target = cellBlockTarget(table.cellBlockCounts, existingRowSize);
      let padded = 0;
      for (let row = existingRowSize; row < table.rowSize; row += 1) {
        for (let column = 0; column < table.columnSize; column += 1) {
          const missing = target - table.cellBlockCounts[row][column];
          if (missing > 0) {
            await padCellBlocks(transport, documentToken, table.cellIds[row][column], missing);
            padded += missing;
          }
        }
      }
      plan.cellBlocksPadded = padded;
      if (padded > 0) {
        blocks = await listAllBlocks(transport, documentToken);
        table = readTable(blocks, tableId);
      }
    }
  }

  const blockMap = indexBlocks(blocks);
  const differences = diffTable(table.rows, rows);
  const updates = differences.map(({ row, column, to }) => {
    const target = cellWriteTarget(blockMap, table.cellIds[row][column]);
    return {
      block_id: target.block_id,
      update_text_elements: {
        elements: [{ text_run: { content: to, text_element_style: styleOf(target) } }],
      },
    };
  });

  let revision = null;
  for (let start = 0; start < updates.length; start += MAX_BATCH_UPDATES) {
    const chunk = updates.slice(start, start + MAX_BATCH_UPDATES);
    const result = await transport.call("docx.v1.documentBlock.batchUpdate", {
      path: { document_id: documentToken },
      params: { document_revision_id: -1, client_token: randomUUID() },
      data: { requests: chunk },
    });
    revision = revisionOf(result) ?? revision;
  }

  const finalTable = readTable(await listAllBlocks(transport, documentToken), tableId);
  const remaining = diffTable(finalTable.rows, rows);
  if (remaining.length > 0) {
    const error = new Error(`回读校验失败：${remaining.length} 个单元格与输入不一致`);
    error.code = "VERIFY_FAILED";
    error.details = { failureClass: "VERIFY_FAILED", missingScopes: [], nextAction: "检查 mismatches 后重试", mismatches: remaining.slice(0, 10) };
    throw error;
  }
  return {
    status: plan.rowsToAppend === 0 && updates.length === 0 ? "unchanged" : "updated",
    verified: true,
    ...plan,
    cellsWritten: updates.length,
    rowSize: finalTable.rowSize,
    columnSize: finalTable.columnSize,
    contentHash: sha256(rows.map((row) => row.join("")).join("\n")),
    revision,
  };
}

// ---- 表格结构编辑：删行、合并/拆分单元格、调列宽 ----
// 实测（2026-09-23）：合并会把区域里各格的内容按行拼进左上角那一格、其余格清空；删掉与合并区域相交的行
// 会悄悄取消合并；拆分只认合并区域的左上角，给别的格不报错也不生效；列宽最小 50px。

const TABLE_EDIT_OPS = ["delete-rows", "merge", "unmerge", "widths"];

// 行列号从 0 开始（0 是表头行，与 table-read 的 rows 下标一致）；「a-b」含两端，返回左闭右开区间
export function parseIndexRange(value, label, size) {
  const match = String(value ?? "").trim().match(/^(\d+)(?:-(\d+))?$/);
  if (!match) fail(`--${label} 写成序号或「起-止」（从 0 开始，含两端）`, "INVALID_ARGUMENT");
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]) + 1;
  if (end <= start || end > size) fail(`--${label}=${value} 超出范围：序号是 0 到 ${size - 1}`, "INVALID_ARGUMENT");
  return { start, end };
}

// merge_info 按行优先、每格一项；返回合并区域的左上角与跨度
export function mergedRegions(property) {
  const columns = property.column_size;
  return (property.merge_info ?? []).flatMap((info, index) =>
    (info.row_span ?? 1) > 1 || (info.col_span ?? 1) > 1
      ? [{ row: Math.floor(index / columns), column: index % columns, rowSpan: info.row_span ?? 1, colSpan: info.col_span ?? 1 }]
      : []);
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const within = (inner, outer) => outer.start <= inner.start && inner.end <= outer.end;
const regionRows = (region) => ({ start: region.row, end: region.row + region.rowSpan });
const regionColumns = (region) => ({ start: region.column, end: region.column + region.colSpan });
const describeRegion = (region) => `第 ${region.row} 行第 ${region.column} 列起 ${region.rowSpan} 行 × ${region.colSpan} 列`;

function descendantIds(blockMap, id) {
  return [id, ...(blockMap.get(id)?.children ?? []).flatMap((child) => descendantIds(blockMap, child))];
}

function verifyTable(condition, message) {
  if (condition) return;
  const error = new Error(`回读校验失败：${message}`);
  error.code = "VERIFY_FAILED";
  error.details = { failureClass: "VERIFY_FAILED", missingScopes: [], nextAction: "用 table-read 看表格现状后再决定是否重试" };
  throw error;
}

export async function editTable(transport, documentToken, options) {
  const { tableId, op, dryRun = false, acceptCommentLoss = false } = options;
  if (!TABLE_EDIT_OPS.includes(op)) fail(`不支持的 --op=${op ?? ""}；可用：${TABLE_EDIT_OPS.join("、")}`, "INVALID_ARGUMENT");
  const blocks = await listAllBlocks(transport, documentToken);
  const blockMap = indexBlocks(blocks);
  const table = readTable(blocks, tableId);
  const property = blockMap.get(tableId).table.property;
  const regions = mergedRegions(property);
  // 写之前再读一次：行号、列号都是按刚才读到的表算的，这期间有人插删行列或改了合并，就不按旧位置写
  // 比对内容：单元格网格、每格整棵子块树的完整块内容（文字、链接、样式、父子关系都在里面；按原文重建也算）、合并信息和列宽
  const layout = (allBlocks) => {
    const map = indexBlocks(allBlocks);
    const current = readTable(allBlocks, tableId);
    const currentProperty = map.get(tableId).table.property;
    const tree = current.cellIds.flat().map((id) => descendantIds(map, id).map((child) => map.get(child) ?? child));
    return JSON.stringify([current.cellIds, tree, currentProperty.merge_info ?? [], currentProperty.column_width ?? []]);
  };
  const before = layout(blocks);
  const unchangedSinceRead = async () => {
    if (layout(await listAllBlocks(transport, documentToken)) !== before) {
      fail("读取之后表格被人改过（行列或合并变了），这次没有写入：重新运行（先 --dry-run 看新的行号）", "TABLE_CHANGED_DURING_EDIT");
    }
  };
  let checkedBeforeWrite = false;
  const patch = async (data) => {
    // 只在第一次写之前核对：改多列宽度要连续提交，后面几次比对的是自己刚改过的表
    if (!checkedBeforeWrite) await unchangedSinceRead();
    checkedBeforeWrite = true;
    return transport.call("docx.v1.documentBlock.patch", {
      path: { document_id: documentToken, block_id: tableId },
      // 每次操作用新 token：同一个 token 会被飞书当成重复请求（例如合并、拆分后再合并同一区域）
      params: { document_revision_id: -1, client_token: randomUUID() },
      data,
    });
  };
  const reread = async () => {
    const after = await listAllBlocks(transport, documentToken);
    return { table: readTable(after, tableId), property: indexBlocks(after).get(tableId).table.property };
  };

  if (op === "delete-rows") {
    const range = parseIndexRange(options.rows, "rows", table.rowSize);
    if (range.end - range.start >= table.rowSize) fail("不能删掉表格的全部行；要删整张表用 edit --op=delete --block=<表格块 id>", "INVALID_ARGUMENT");
    const crossing = regions.find((region) => overlaps(regionRows(region), range) && !within(regionRows(region), range));
    if (crossing) {
      fail(`要删的行和合并单元格（${describeRegion(crossing)}）相交：删除会取消合并，合并格的内容只在左上角那一格。先 --op=unmerge 再删，或调整范围`, "MERGED_CELLS_IN_RANGE");
    }
    const preview = { op, rows: `${range.start}-${range.end - 1}`, removedRows: table.rows.slice(range.start, range.end) };
    const ids = new Set(table.cellIds.slice(range.start, range.end).flat().flatMap((id) => descendantIds(blockMap, id)));
    const comments = (await listOpenComments(transport, documentToken)).filter((comment) => ids.has(comment.anchor));
    if (comments.length > 0 && !acceptCommentLoss) {
      const message = `有 ${comments.length} 条未解决评论挂在要删的行上：先处理，或确认后加 --accept-comment-loss`;
      return { status: "blocked", ...preview, blockers: [{ check: "open_comments", message, comments: comments.slice(0, 10) }] };
    }
    if (dryRun) return { status: "dry_run", ...preview };
    await patch({ delete_table_rows: { row_start_index: range.start, row_end_index: range.end } });
    const after = await reread();
    const expected = [...table.rows.slice(0, range.start), ...table.rows.slice(range.end)];
    verifyTable(JSON.stringify(after.table.rows) === JSON.stringify(expected), "删行后表格内容与预期不一致");
    return { status: "updated", ...preview, rowSize: after.table.rowSize };
  }

  if (op === "merge") {
    const rows = parseIndexRange(options.rows, "rows", table.rowSize);
    const columns = parseIndexRange(options.cols, "cols", table.columnSize);
    if ((rows.end - rows.start) * (columns.end - columns.start) < 2) fail("合并至少要两个格", "INVALID_ARGUMENT");
    const partial = regions.find((region) => {
      const r = regionRows(region);
      const c = regionColumns(region);
      if (!overlaps(r, rows) || !overlaps(c, columns)) return false;
      return !(within(r, rows) && within(c, columns)) && !(within(rows, r) && within(columns, c));
    });
    if (partial) fail(`合并范围和已有的合并单元格（${describeRegion(partial)}）部分重叠，飞书会拒绝：先 unmerge 或调整范围`, "MERGE_OVERLAP");
    const texts = [];
    for (let row = rows.start; row < rows.end; row += 1) {
      for (let column = columns.start; column < columns.end; column += 1) if (table.rows[row][column]) texts.push(table.rows[row][column]);
    }
    const preview = {
      op,
      rows: `${rows.start}-${rows.end - 1}`,
      cols: `${columns.start}-${columns.end - 1}`,
      mergedText: texts.join(""),
      warnings: texts.length > 1 ? [`${texts.length} 个格有内容，合并后按行拼进左上角那一格：「${texts.join("")}」`] : [],
    };
    if (dryRun) return { status: "dry_run", ...preview };
    await patch({ merge_table_cells: { row_start_index: rows.start, row_end_index: rows.end, column_start_index: columns.start, column_end_index: columns.end } });
    const after = await reread();
    const info = after.property.merge_info?.[rows.start * after.property.column_size + columns.start] ?? {};
    verifyTable(info.row_span === rows.end - rows.start && info.col_span === columns.end - columns.start, "合并区域的跨度与请求不一致");
    return { status: "updated", ...preview };
  }

  if (op === "unmerge") {
    const row = parseIndexRange(options.row, "row", table.rowSize).start;
    const column = parseIndexRange(options.col, "col", table.columnSize).start;
    const region = regions.find((item) => overlaps(regionRows(item), { start: row, end: row + 1 }) && overlaps(regionColumns(item), { start: column, end: column + 1 }));
    if (!region) fail(`第 ${row} 行第 ${column} 列不在合并单元格里`, "NOT_MERGED");
    const preview = { op, region: describeRegion(region), text: table.rows[region.row][region.column], note: "拆分后内容留在左上角那一格，其余格为空" };
    if (dryRun) return { status: "dry_run", ...preview };
    // 拆分只认左上角：给区域里别的格飞书不报错也不生效
    await patch({ unmerge_table_cells: { row_index: region.row, column_index: region.column } });
    const after = await reread();
    verifyTable(!mergedRegions(after.property).some((item) => item.row === region.row && item.column === region.column), "合并区域仍然存在");
    return { status: "updated", ...preview };
  }

  const values = String(options.widths ?? "").split(",").map((value) => value.trim());
  if (values.length !== table.columnSize) fail(`--widths 要给全部 ${table.columnSize} 列，用逗号分隔，不改的列写 *`, "INVALID_ARGUMENT");
  const current = property.column_width ?? [];
  const changes = [];
  values.forEach((value, column) => {
    if (value === "*") return;
    if (!/^\d+$/.test(value) || Number(value) < 50) fail(`第 ${column} 列的宽度「${value}」无效：写像素整数，最小 50`, "INVALID_ARGUMENT");
    if (Number(value) !== current[column]) changes.push({ column, from: current[column] ?? null, to: Number(value) });
  });
  if (changes.length === 0) return { status: "unchanged", op, changes };
  if (dryRun) return { status: "dry_run", op, changes };
  // 同一张表的多次改宽不能放进一个 batchUpdate（块 id 重复），逐列 patch
  for (const change of changes) await patch({ update_table_property: { column_index: change.column, column_width: change.to } });
  const after = await reread();
  verifyTable(changes.every((change) => after.property.column_width?.[change.column] === change.to), "列宽与请求不一致");
  return { status: "updated", op, changes };
}

// ---- 元素级文本编辑：update-text / link-plan ----

const HEADING_TYPES = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11]);
// Body blocks that link-plan rewrites: text, bullet and ordered list items.
// Headings and code blocks are never touched.
const LINKABLE_TYPES = new Set([BLOCK_TYPE_TEXT, 12, 13]);
const STYLE_FLAGS = ["bold", "italic", "strikethrough", "underline", "inline_code"];

function textContainerKey(block) {
  return TEXT_CONTAINER_KEYS.find((key) => Array.isArray(block?.[key]?.elements)) ?? null;
}

export function blockElements(block) {
  const key = textContainerKey(block);
  return key ? block[key].elements : null;
}

function decodeUrl(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

// text_element_style.link.url must be percent-encoded as a whole; an encoded
// value never contains ":" or "/", so a raw URL is detected and encoded once.
export function encodeLinkUrl(url) {
  return /[:/?#]/.test(url) ? encodeURIComponent(url) : url;
}

export function prepareTextPlan(input) {
  const items = Array.isArray(input) ? input : input?.updates;
  if (!Array.isArray(items) || items.length === 0) {
    fail('计划必须是非空数组 [{block_id, elements}] 或 {"updates": [...]}', "INVALID_PLAN");
  }
  const seen = new Set();
  return items.map((item, index) => {
    if (typeof item?.block_id !== "string" || item.block_id === "") fail(`第 ${index} 项缺少 block_id`, "INVALID_PLAN");
    if (seen.has(item.block_id)) fail(`block_id 重复: ${item.block_id}`, "INVALID_PLAN");
    seen.add(item.block_id);
    if (!Array.isArray(item.elements) || item.elements.length === 0) {
      fail(`${item.block_id} 的 elements 必须是非空数组`, "INVALID_PLAN");
    }
    const elements = item.elements.map((element) => {
      const url = element?.text_run?.text_element_style?.link?.url;
      if (typeof url !== "string") return element;
      const style = { ...element.text_run.text_element_style, link: { ...element.text_run.text_element_style.link, url: encodeLinkUrl(url) } };
      return { ...element, text_run: { ...element.text_run, text_element_style: style } };
    });
    return { block_id: item.block_id, elements };
  });
}

// Comparable projection of elements: adjacent runs with the same style are
// merged (Feishu may merge them on write), missing flags count as false and
// link URLs are compared decoded.
export function elementsSignature(elements = []) {
  const runs = [];
  for (const element of elements) {
    const run = element?.text_run;
    const entry = run
      ? {
          content: run.content ?? "",
          ...Object.fromEntries(STYLE_FLAGS.map((flag) => [flag, Boolean(run.text_element_style?.[flag])])),
          link: run.text_element_style?.link?.url ? decodeUrl(run.text_element_style.link.url) : null,
        }
      : { content: "", other: Object.keys(element ?? {}).sort().join(",") };
    const last = runs[runs.length - 1];
    const { content, ...style } = entry;
    if (last && JSON.stringify(last.style) === JSON.stringify(style) && !style.other) last.content += content;
    else runs.push({ content, style });
  }
  return runs.filter((run) => run.content !== "" || run.style.other);
}

export function diffTextPlan(blocks, plan) {
  const blockMap = indexBlocks(blocks);
  const mismatches = [];
  for (const item of plan) {
    const block = blockMap.get(item.block_id);
    const actual = block ? elementsSignature(blockElements(block) ?? []) : null;
    const expected = elementsSignature(item.elements);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      mismatches.push({ block_id: item.block_id, found: Boolean(block), expected, actual });
    }
  }
  return mismatches;
}

export async function updateTextElements(transport, documentToken, plan, { dryRun = false } = {}) {
  const blocks = await listAllBlocks(transport, documentToken);
  const blockMap = indexBlocks(blocks);
  for (const item of plan) {
    const block = blockMap.get(item.block_id);
    if (!block) fail(`找不到块 ${item.block_id}`, "BLOCK_NOT_FOUND");
    if (!textContainerKey(block)) fail(`块 ${item.block_id}（block_type=${block.block_type}）没有文本元素`, "BLOCK_NOT_TEXT");
  }
  const pendingIds = new Set(diffTextPlan(blocks, plan).map((item) => item.block_id));
  const pending = plan.filter((item) => pendingIds.has(item.block_id));
  const preview = pending.map((item) => ({
    block_id: item.block_id,
    block_type: blockMap.get(item.block_id).block_type,
    before: blockText(blockMap.get(item.block_id)).slice(0, 120),
    after: elementsText(item.elements).slice(0, 120),
    links: item.elements
      .map((element) => element?.text_run?.text_element_style?.link?.url)
      .filter(Boolean)
      .map(decodeUrl),
  }));
  if (dryRun) {
    return { status: "dry_run", verified: false, planned: plan.length, toWrite: pending.length, preview };
  }

  let revision = null;
  for (let start = 0; start < pending.length; start += MAX_BATCH_UPDATES) {
    const chunk = pending
      .slice(start, start + MAX_BATCH_UPDATES)
      .map((item) => ({ block_id: item.block_id, update_text_elements: { elements: item.elements } }));
    const result = await transport.call("docx.v1.documentBlock.batchUpdate", {
      path: { document_id: documentToken },
      params: {
        document_revision_id: -1,
        client_token: deterministicClientToken(documentToken, "update-text", sha256(JSON.stringify(chunk))),
      },
      data: { requests: chunk },
    });
    revision = revisionOf(result) ?? revision;
  }

  const mismatches = diffTextPlan(await listAllBlocks(transport, documentToken), plan);
  if (mismatches.length > 0) {
    const error = new Error(`回读校验失败：${mismatches.length} 个块与计划不一致`);
    error.code = "VERIFY_FAILED";
    error.details = {
      failureClass: "VERIFY_FAILED",
      missingScopes: [],
      nextAction: "检查 mismatches 后修正计划重试",
      mismatches: mismatches.slice(0, 10),
    };
    throw error;
  }
  return {
    status: pending.length === 0 ? "unchanged" : "updated",
    verified: true,
    planned: plan.length,
    blocksWritten: pending.length,
    revision,
  };
}

// Splits every plain run on label matches and links the matched substring,
// keeping the run's original style. Runs that already carry a link or are
// inline code are left alone, which also makes reruns idempotent.
export function linkRuns(elements, pattern, urlFor) {
  const out = [];
  let count = 0;
  for (const element of elements) {
    const run = element?.text_run;
    const style = run?.text_element_style ?? {};
    if (!run || style.link || style.inline_code) {
      out.push(element);
      continue;
    }
    const content = run.content ?? "";
    let position = 0;
    const piece = (text, extra = {}) => ({
      ...element,
      text_run: { ...run, content: text, text_element_style: { ...style, ...extra } },
    });
    for (const match of content.matchAll(pattern)) {
      if (match.index > position) out.push(piece(content.slice(position, match.index)));
      out.push(piece(match[0], { link: { url: encodeLinkUrl(urlFor(match[0])) } }));
      position = match.index + match[0].length;
      count += 1;
    }
    if (position === 0) out.push(element);
    else if (position < content.length) out.push(piece(content.slice(position)));
  }
  return { elements: out, count };
}

export function headingLinkUrl(documentToken, blockId) {
  return `https://lexin.feishu.cn/docx/${documentToken}#${blockId}`;
}

// labels: {"正文里出现的文字": "标题文本或标题 block_id"}
export function buildHeadingLinkPlan(blocks, documentToken, labels) {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) fail("labels 必须是非空对象 {标签: 标题文本或 block_id}", "INVALID_PLAN");
  const blockMap = indexBlocks(blocks);
  const headings = blocks.filter((block) => HEADING_TYPES.has(block.block_type));
  const targets = new Map();
  for (const [label, target] of entries) {
    if (typeof label !== "string" || label === "" || typeof target !== "string" || target === "") {
      fail(`labels 的键和值都必须是非空字符串: ${label}`, "INVALID_PLAN");
    }
    const direct = blockMap.get(target);
    let matched = direct && HEADING_TYPES.has(direct.block_type) ? [direct] : [];
    if (matched.length === 0) matched = headings.filter((block) => blockText(block).trim() === target.trim());
    if (matched.length === 0) fail(`找不到标题: ${target}`, "HEADING_NOT_FOUND");
    if (matched.length > 1) fail(`标题文本不唯一: ${target}，请改用 block_id`, "AMBIGUOUS_HEADING");
    targets.set(label, matched[0].block_id);
  }
  const escaped = [...targets.keys()]
    .sort((a, b) => b.length - a.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(escaped.join("|"), "g");
  const urlFor = (label) => headingLinkUrl(documentToken, targets.get(label));
  const plan = [];
  let linkCount = 0;
  for (const block of blocks) {
    if (!LINKABLE_TYPES.has(block.block_type)) continue;
    const elements = blockElements(block);
    if (!elements) continue;
    const linked = linkRuns(elements, pattern, urlFor);
    if (linked.count === 0) continue;
    linkCount += linked.count;
    plan.push({ block_id: block.block_id, elements: linked.elements, text: blockText(block).slice(0, 80) });
  }
  return { plan, linkCount, targets: Object.fromEntries(targets) };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) fail(`无法识别的参数: ${item}`);
    const equal = item.indexOf("=");
    if (equal > 2) {
      options[item.slice(2, equal)] = item.slice(equal + 1);
    } else {
      const key = item.slice(2);
      if (rest[index + 1] && !rest[index + 1].startsWith("--")) options[key] = rest[++index];
      else options[key] = true;
    }
  }
  return { command, options };
}

async function readStdin() {
  let content = "";
  for await (const chunk of process.stdin) content += chunk;
  return content;
}

async function inputJson(options) {
  let raw;
  if (options.file) raw = readFileSync(options.file, "utf8");
  else if (options.stdin) raw = await readStdin();
  else fail("必须指定 --file=<绝对路径> 或 --stdin");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`输入不是合法 JSON: ${error.message}`, "INVALID_JSON");
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return {
    usage: [
      "auth-check --operation=read|write-blocks|write-json|publish|edit|create-doc [--target=<url>]",
      "authorize --operation=<operation> [--target=<url>] [--no-wait | --device-code=<code>]",
      "read --target=<url> [--format=markdown|xml|text] [--scope=full|outline|section|range|keyword] [--keyword=<k>] [--start-block-id=<id>] [--end-block-id=<id>] [--with-ids] [--out=<path>]",
      "lint --file=<md> [--out=<mermaid 渲染输出目录>] [--no-render]",
      "publish --file=<md> [--target=<folder-or-wiki-url>] [--doc=<docx-url>] [--overwrite] [--dry-run] [--force] [--accept-comment-loss]",
      "edit --target=<url> --op=insert-after --file=<md> (--after=<块id> | --after-heading=<标题> | --at=start|end) [--dry-run]",
      "edit --target=<url> --op=replace|delete --block=<块id> [--end-block=<块id>] [--file=<md>] [--dry-run] [--allow-protected] [--accept-comment-loss]",
      "edit --target=<url> --op=replace-section|delete-section --heading=<标题或块id> [--include-heading] [--file=<md>] [--dry-run] [--allow-protected] [--accept-comment-loss]",
      "edit --target=<url> --op=replace-text --pattern=<原文> --content=<新文字> [--all] [--dry-run]",
      "outline --target=<url> [--heading=<text>]",
      "list-blocks --target=<url> [--type=<block_type>] [--full] [--out=<path>]",
      "table-read --target=<url> [--table=<block_id>|--table-index=<n>]",
      "table-sync --target=<url> --table=<block_id>|--table-index=<n> --file=<path>|--stdin [--pad-cells=auto|off] [--dry-run]",
      "table-edit --target=<url> --table=<block_id>|--table-index=<n> --op=delete-rows --rows=<a>[-<b>] [--dry-run] [--accept-comment-loss]",
      "table-edit --target=<url> --table=<block_id>|--table-index=<n> --op=merge --rows=<a>-<b> --cols=<c>-<d> [--dry-run]",
      "table-edit --target=<url> --table=<block_id>|--table-index=<n> --op=unmerge --row=<r> --col=<c> [--dry-run]",
      "table-edit --target=<url> --table=<block_id>|--table-index=<n> --op=widths --widths=<w0,w1,...|*> [--dry-run]",
      "update-text --target=<url> --file=<plan.json>|--stdin [--dry-run]",
      "link-plan --target=<url> --labels=<labels.json> --out=<plan.json>",
      "inspect-sections --target=<url> [--section=<id>]",
      "write-json --target=<url> --file=<path>|--stdin --section=<id> [--heading=<text>] [--mode=upsert|append]",
      "create-doc --target=<folder-url> --title=<title>",
      "cleanup-list [--docs=<url,url>] [--file=<md>] [--folder=<folder-url>] [--prune] [--out=<path>]",
      "call --method=GET|POST|PATCH|PUT|DELETE --path=/open-apis/... [--params=<json>] [--file=<body.json>|--stdin] [--operation=read|write-blocks]  或  call --api=<已登记接口名> --file=<{path,params,data}>",
      "parse-target --target=<url-or-token>",
    ],
    notes: [
      "read 默认输出 docs_ai 的 Markdown，文本绘图小组件会补成 ```mermaid 代码块；--format=text 是 rawContent 纯文本。",
      "publish 首次发布要 --target 指定文件夹或知识库节点；再次发布默认增量（只改变动的段落），整篇覆盖加 --overwrite；都可先 --dry-run 看计划和检查。",
      "table-sync 的输入是 {\"rows\": [[...]]} 或裸二维数组，含表头行；行数只增不减。删行、合并/拆分单元格、调列宽用 table-edit，行列号从 0 开始（0 是表头行，与 table-read 的 rows 下标一致），a-b 含两端。",
      "list-blocks --full 返回原始块（含 text_element_style）；--out 把原始块写入文件，只在 stdout 打印摘要。",
      "update-text 的计划是 [{block_id, elements}]，整块替换 elements；未变化的块跳过，每批 40 条，写后逐块回读校验。",
      "call 是逃生口，直接用 lark-cli 调任意开放平台接口（用户身份）。",
      "cleanup-list 默认列出本 skill 建过的全部文档；本 skill 不申请删除权限，删除由用户在飞书里手动完成。",
    ],
  };
}

function tableIdFrom(blocks, options) {
  if (options.table) return options.table;
  const tables = listTables(blocks);
  if (tables.length === 0) fail("文档中没有表格", "TABLE_NOT_FOUND");
  const index = options["table-index"] === undefined ? null : Number(options["table-index"]);
  if (index === null) {
    if (tables.length > 1) {
      fail(
        `文档中有 ${tables.length} 个表格，请用 --table=<block_id> 或 --table-index=<n> 指定`,
        "AMBIGUOUS_TABLE",
      );
    }
    return tables[0].blockId;
  }
  if (!Number.isInteger(index) || index < 0 || index >= tables.length) {
    fail(`table-index 超出范围: 0..${tables.length - 1}`, "TABLE_NOT_FOUND");
  }
  return tables[index].blockId;
}

async function inputRows(options) {
  let raw;
  if (options.file) raw = readFileSync(options.file, "utf8");
  else if (options.stdin) raw = await readStdin();
  else fail("table-sync 必须指定 --file=<绝对路径> 或 --stdin");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`输入不是合法 JSON: ${error.message}`, "INVALID_JSON");
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.rows;
  if (!Array.isArray(rows)) fail('输入必须是二维数组或 {"rows": [[...]]}', "INVALID_TABLE_SHAPE");
  return rows;
}

// docs_ai 读取里文本绘图小组件只是空的 <readonly-block type="isv">，源码要按块 id 从块接口取回
const ISV_BLOCK = /<readonly-block\b[^>]*type="isv"[^>]*>(?:<\/readonly-block>)?/g;

async function mermaidWidgetCode(transport, documentToken, blockId) {
  const value = await transport.call("docx.v1.documentBlock.get", { path: { document_id: documentToken, block_id: blockId } });
  const addOns = (value?.block ?? value)?.add_ons;
  if (addOns?.component_type_id !== MERMAID_WIDGET_TYPE) return null;
  try {
    return JSON.parse(addOns.record ?? "{}").data ?? null;
  } catch {
    return null;
  }
}

export async function readDocument(transport, documentToken, options = {}) {
  const format = options.format ?? "markdown";
  if (format === "text") {
    const value = await transport.call("docx.v1.document.rawContent", { path: { document_id: documentToken } });
    return { format, content: value?.content ?? "" };
  }
  if (!["markdown", "xml"].includes(format)) fail("--format 只支持 markdown、xml、text");
  const scopeArgs = [];
  if (options.scope) scopeArgs.push("--scope", options.scope);
  for (const key of ["keyword", "start-block-id", "end-block-id", "max-depth", "context-before", "context-after"]) {
    if (options[key] !== undefined && options[key] !== true) scopeArgs.push(`--${key}`, String(options[key]));
  }
  const detail = options["with-ids"] ? "with-ids" : "simple";
  const fetch = (fmt, level) => transport.shortcut(["docs", "+fetch", "--doc", documentToken, "--doc-format", fmt, "--detail", level, ...scopeArgs]);
  const data = await fetch(format, detail);
  let content = data.document?.content ?? "";
  const placeholders = content.match(ISV_BLOCK) ?? [];
  const widgets = { mermaid: 0, other: 0 };
  if (placeholders.length > 0) {
    const withIds = format === "xml" && detail === "with-ids" ? content : (await fetch("xml", "with-ids")).document?.content ?? "";
    const ids = (withIds.match(ISV_BLOCK) ?? []).map((tag) => tag.match(/\bid="([^"]+)"/)?.[1] ?? null);
    const codes = [];
    for (const id of ids) codes.push(id ? await mermaidWidgetCode(transport, documentToken, id) : null);
    let position = 0;
    content = content.replace(ISV_BLOCK, (tag) => {
      const code = codes[position];
      const id = ids[position];
      position += 1;
      if (code === null || code === undefined) {
        widgets.other += 1;
        return tag;
      }
      widgets.mermaid += 1;
      return format === "markdown"
        ? `\`\`\`mermaid\n${code}\n\`\`\``
        : `<mermaid-widget id="${id}">${code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</mermaid-widget>`;
    });
  }
  const { document, ...rest } = data;
  return { format, revision: document?.revision_id ?? null, widgets, content, ...rest };
}

async function ensureAuthorized(operation, target) {
  const { result } = await checkAuthorization(operation, target);
  if (result.ready) return true;
  printJson({ status: "permission_required", ...result });
  process.exitCode = 2;
  return false;
}

const READ_COMMANDS = new Set(["read", "inspect-sections", "list-blocks", "table-read", "outline", "link-plan"]);
const WRITE_BLOCK_COMMANDS = new Set(["table-sync", "update-text"]);

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || options.help) return printJson(usage());
  const target = options.target ? parseTarget(options.target) : null;

  if (command === "parse-target") return printJson({ status: "ok", target });
  // 写前检查只读本地文件，不需要飞书登录
  if (command === "lint") {
    if (!options.file) fail("lint 必须指定 --file=<md 路径>");
    const result = lintFile(options.file, { prepare: preparePublishMarkdown, out: options.out, render: !options["no-render"] });
    printJson(result);
    if (result.status === "errors") process.exitCode = 2;
    return;
  }
  if (command === "auth-check") {
    const { result } = await checkAuthorization(options.operation || "read", target);
    printJson({ status: result.ready ? "ready" : "permission_required", ...result });
    if (!result.ready) process.exitCode = 2;
    return;
  }
  if (command === "authorize") {
    const result = await authorize(options.operation || "read", target, options);
    printJson({ status: result.ready ? "ready" : "permission_required", ...result });
    if (!result.ready) process.exitCode = 2;
    return;
  }

  const transport = createTransport();

  // 本地 Markdown → 飞书：首次新建，之后全量覆盖；发布状态记在 md 旁的 <name>.feishu.json
  if (command === "publish") {
    if (!options.file) fail("publish 必须指定 --file=<本地 md 路径>");
    if (target && !["folder", "wiki"].includes(target.kind)) fail("publish 的 --target 必须是文件夹或知识库节点链接", "UNSUPPORTED_RESOURCE");
    if (!(await ensureAuthorized("publish", target?.kind === "wiki" ? target : null))) return;
    let doc = null;
    if (options.doc) {
      const docTarget = requireDocumentTarget(parseTarget(options.doc), command);
      doc = { token: (await resolveDocument(transport, docTarget)).documentToken };
    }
    const result = await publishMarkdown(transport, {
      file: options.file,
      target,
      doc,
      overwrite: Boolean(options.overwrite),
      dryRun: Boolean(options["dry-run"]),
      force: Boolean(options.force),
      acceptCommentLoss: Boolean(options["accept-comment-loss"]),
    });
    printJson(result);
    if (["blocked", "needs_mode"].includes(result.status)) process.exitCode = 2;
    if (result.status === "published_with_issues") process.exitCode = 3;
    return;
  }

  // 在指定目录下建空文档；要带正文用 publish
  if (command === "create-doc") {
    if (!target || target.kind !== "folder") fail("create-doc 需要 --target 指向 /drive/folder/<token>", "UNSUPPORTED_RESOURCE");
    if (!options.title) fail("create-doc 必须指定 --title");
    if (!(await ensureAuthorized("create-doc", null))) return;
    const created = await transport.call("docx.v1.document.create", { data: { folder_token: target.token, title: options.title } });
    const documentToken = created?.document?.document_id;
    const url = `https://lexin.feishu.cn/docx/${documentToken}`;
    recordCreated({ doc_token: documentToken, url, title: options.title, parent_token: target.token, source: "create-doc" });
    return printJson({ status: "ok", folderToken: target.token, documentToken, url });
  }

  // 不申请删除权限：列出「文档名 + 链接 + 所在目录」交给用户手动删，删完用 --prune 核对并清理记录
  if (command === "cleanup-list") {
    if (!(await ensureAuthorized("read", null))) return;
    const registry = readRegistry();
    const byToken = new Map(registry.map((entry) => [entry.doc_token, entry]));
    let candidates = [];
    if (options.docs) {
      for (const link of String(options.docs).split(",").map((item) => item.trim()).filter(Boolean)) {
        const docTarget = requireDocumentTarget(parseTarget(link), command);
        const { documentToken } = await resolveDocument(transport, docTarget);
        candidates.push(byToken.get(documentToken) ?? { doc_token: documentToken });
      }
    } else if (options.file) {
      const state = readState(statePathFor(options.file));
      if (!state) fail(`${options.file} 没有发布记录（${statePathFor(options.file)}）`, "NO_PUBLISH_STATE");
      candidates.push(byToken.get(state.doc_token) ?? { doc_token: state.doc_token, url: state.url, title: state.title, parent_token: state.parent_token, source: "publish" });
    } else {
      candidates = registry;
      if (options.folder) {
        const folder = parseTarget(options.folder);
        if (folder.kind !== "folder") fail("--folder 必须是 /drive/folder/<token> 链接", "UNSUPPORTED_RESOURCE");
        candidates = candidates.filter((entry) => entry.parent_token === folder.token);
      }
    }
    const testFolder = process.env.FEISHU_TEST_FOLDER ? parseTarget(process.env.FEISHU_TEST_FOLDER).token : null;
    const items = await buildCleanupList(transport, candidates, { testFolderToken: testFolder });
    const deleted = new Set(items.filter((item) => item.status === "deleted").map((item) => item.docToken));
    let pruned = 0;
    if (options.prune && deleted.size > 0) {
      const kept = registry.filter((entry) => !deleted.has(entry.doc_token));
      pruned = registry.length - kept.length;
      writeRegistry(kept);
    }
    // 已删文档如果是某个本地 md 发布的，它的状态文件也该删，否则下次发布会找不到文档
    const staleStateFiles = [...deleted]
      .map((token) => byToken.get(token)?.file)
      .filter(Boolean)
      .map((file) => statePathFor(file))
      .filter((path) => existsSync(path));
    const checklist = cleanupChecklist(items);
    if (options.out) writeFileSync(options.out, `${checklist}\n`);
    return printJson({ status: "ok", total: items.length, pending: items.length - deleted.size, deleted: deleted.size, pruned, staleStateFiles, items, checklist });
  }

  // 逃生口：本脚本没包装的接口直接透传给 lark-cli
  if (command === "call") {
    if (!options.api && (!options.method || !options.path)) fail("call 必须指定 --method 与 --path（/open-apis/...），或已登记的 --api");
    if (!(await ensureAuthorized(options.operation === "read" ? "read" : "write-blocks", target))) return;
    const body = options.file || options.stdin ? JSON.parse(await inputJson(options)) : undefined;
    // --api 沿用旧的 {path, params, data} 参数形状
    if (options.api) return printJson({ status: "ok", api: options.api, result: await transport.call(options.api, body ?? {}) });
    const params = options.params ? JSON.parse(options.params) : undefined;
    const result = await transport.api(String(options.method).toUpperCase(), options.path, { params, data: body });
    return printJson({ status: "ok", result });
  }

  if (!target) fail(`${command} 必须指定 --target`);
  requireDocumentTarget(target, command);
  const operation = READ_COMMANDS.has(command)
    ? "read"
    : command === "write-json"
      ? "write-json"
      : WRITE_BLOCK_COMMANDS.has(command)
        ? "write-blocks"
        : ["edit", "table-edit"].includes(command)
          ? command
          : null;
  if (!operation) fail(`未知命令: ${command}`);
  if (!(await ensureAuthorized(operation, target))) return;
  const resolved = await resolveDocument(transport, target);

  if (command === "edit") {
    // 以本地为准的文档在飞书上直接改，下次增量发布会因「飞书上被改过」而停下
    const origin = readRegistry().find((entry) => entry.doc_token === resolved.documentToken && entry.file);
    const originState = origin ? readState(statePathFor(origin.file)) : null;
    const result = await editDocument(transport, resolved.documentToken, {
      ...options,
      dryRun: Boolean(options["dry-run"]),
      allowProtected: Boolean(options["allow-protected"]),
      acceptCommentLoss: Boolean(options["accept-comment-loss"]),
      all: Boolean(options.all),
    });
    const warning = originState?.mode === "local-master"
      ? `这篇文档由本地文件 ${origin.file} 发布、以本地为准；在飞书上直接改会让它下次增量发布停下，建议改本地文件后 publish`
      : undefined;
    printJson({ ...resolved, ...result, ...(warning ? { warning } : {}) });
    if (result.status === "blocked") process.exitCode = 2;
    if (result.status === "updated_with_issues") process.exitCode = 3;
    return;
  }
  if (command === "read") {
    const result = await readDocument(transport, resolved.documentToken, options);
    if (options.out) {
      writeFileSync(options.out, result.content);
      const { content, ...summary } = result;
      return printJson({ status: "ok", ...resolved, ...summary, contentLength: content.length, out: options.out });
    }
    return printJson({ status: "ok", ...resolved, ...result });
  }
  // 大文档先看骨架再定位，避免把整篇正文拉进上下文。
  // --heading 只返回该标题到下一个同级或更高级标题之间的内容。
  if (command === "outline") {
    const blocks = await listAllBlocks(transport, resolved.documentToken);
    const headings = [];
    blocks.forEach((block, idx) => {
      const level = block.block_type >= 3 && block.block_type <= 11 ? block.block_type - 2 : 0;
      if (!level) return;
      headings.push({ level, text: blockText(block), blockId: block.block_id, blockIndex: idx });
    });
    if (!options.heading) return printJson({ status: "ok", ...resolved, blockCount: blocks.length, headings });
    const start = headings.find((h) => h.text.includes(options.heading));
    if (!start) return printJson({ status: "not_found", ...resolved, heading: options.heading, headings });
    const next = headings.find((h) => h.blockIndex > start.blockIndex && h.level <= start.level);
    const slice = blocks.slice(start.blockIndex, next ? next.blockIndex : blocks.length);
    return printJson({
      status: "ok",
      ...resolved,
      heading: start.text,
      blockCount: slice.length,
      content: slice.map(blockText).filter(Boolean).join("\n"),
    });
  }
  if (command === "list-blocks") {
    const blocks = await listAllBlocks(transport, resolved.documentToken);
    const filtered = options.type ? blocks.filter((block) => String(block.block_type) === String(options.type)) : blocks;
    const tally = {};
    for (const block of blocks) tally[block.block_type] = (tally[block.block_type] ?? 0) + 1;
    if (options.out) {
      writeFileSync(options.out, `${JSON.stringify(filtered, null, 2)}\n`);
      return printJson({ status: "ok", ...resolved, blockCount: blocks.length, blockTypeCounts: tally, out: options.out, written: filtered.length });
    }
    return printJson({
      status: "ok",
      ...resolved,
      blockCount: blocks.length,
      blockTypeCounts: tally,
      tables: listTables(blocks),
      blocks: options.full
        ? filtered
        : filtered.map((block) => ({
            block_id: block.block_id,
            block_type: block.block_type,
            parent_id: block.parent_id,
            text: blockText(block).slice(0, 120),
          })),
    });
  }
  if (command === "table-read") {
    const blocks = await listAllBlocks(transport, resolved.documentToken);
    const table = readTable(blocks, tableIdFrom(blocks, options));
    return printJson({ status: "ok", ...resolved, blockId: table.blockId, rowSize: table.rowSize, columnSize: table.columnSize, rows: table.rows });
  }
  if (command === "table-sync") {
    const rows = await inputRows(options);
    const blocks = await listAllBlocks(transport, resolved.documentToken);
    const tableId = tableIdFrom(blocks, options);
    const result = await syncTable(transport, resolved.documentToken, {
      tableId,
      rows,
      padCells: options["pad-cells"] === "off" ? "off" : "auto",
      dryRun: Boolean(options["dry-run"]),
    });
    return printJson({ status: result.status, ...resolved, blockId: tableId, ...result });
  }
  if (command === "table-edit") {
    const blocks = await listAllBlocks(transport, resolved.documentToken);
    const tableId = tableIdFrom(blocks, options);
    const result = await editTable(transport, resolved.documentToken, {
      tableId,
      op: options.op,
      rows: options.rows,
      cols: options.cols,
      row: options.row,
      col: options.col,
      widths: options.widths,
      dryRun: Boolean(options["dry-run"]),
      acceptCommentLoss: Boolean(options["accept-comment-loss"]),
    });
    printJson({ ...resolved, blockId: tableId, ...result });
    if (result.status === "blocked") process.exitCode = 2;
    return;
  }
  if (command === "update-text") {
    const plan = prepareTextPlan(JSON.parse(await inputJson(options)));
    const result = await updateTextElements(transport, resolved.documentToken, plan, { dryRun: Boolean(options["dry-run"]) });
    return printJson({ ...resolved, ...result });
  }
  if (command === "link-plan") {
    if (!options.labels || !options.out) fail("link-plan 必须指定 --labels=<labels.json> 和 --out=<plan.json>");
    const labels = JSON.parse(readFileSync(options.labels, "utf8"));
    const blocks = await listAllBlocks(transport, resolved.documentToken);
    const result = buildHeadingLinkPlan(blocks, resolved.documentToken, labels);
    writeFileSync(options.out, `${JSON.stringify(result.plan, null, 2)}\n`);
    return printJson({
      status: "ok",
      ...resolved,
      out: options.out,
      blocks: result.plan.length,
      linkCount: result.linkCount,
      targets: result.targets,
      preview: result.plan.slice(0, 10).map((item) => item.text),
    });
  }
  if (command === "inspect-sections") {
    const blocks = await getRootBlocks(transport, resolved.documentToken);
    const sections = options.section ? findManagedSections(blocks, options.section) : [];
    return printJson({ status: "ok", ...resolved, blockCount: blocks.length, section: options.section || null, sections });
  }
  const mode = options.mode || "upsert";
  if (!new Set(["upsert", "append"]).has(mode)) fail("mode 仅支持 upsert 或 append");
  if (!options.section) fail("write-json 必须指定 --section");
  const content = await inputJson(options);
  const result = await writeJson(transport, resolved.documentToken, { content, section: options.section, heading: options.heading || null, mode });
  return printJson({ status: result.status, ...resolved, section: options.section, ...result });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const command = process.argv[2];
    const operation = READ_COMMANDS.has(command) ? "read" : ["publish", "edit", "table-edit"].includes(command) ? command : "write-json";
    const classified = error.details ?? classifyFailure(error, { requiredScopes: OPERATION_SCOPES[operation] ?? [] });
    printJson({ status: "error", code: error.code ?? classified.failureClass, message: error.message, ...classified });
    process.exitCode = 1;
  });
}
