#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(SCRIPT_DIR, "../../../..");
const LARK_WRAPPER = join(REPO_DIR, "mcp/third-party-mcp/lark/bin/lark-mcp");
const SUPPORTED_HOSTS = new Set(["lexin.feishu.cn"]);
const TOOL_NAMES = [
  "wiki.v2.space.getNode",
  "docx.v1.document.rawContent",
  "docx.v1.documentBlock.list",
  "docx.v1.documentBlock.patch",
  "docx.v1.documentBlock.batchUpdate",
  "docx.v1.documentBlockChildren.get",
  "docx.v1.documentBlockChildren.create",
  "docx.v1.documentBlockChildren.batchDelete",
  "docx.v1.document.convert",
];
const TOOL_NAME_MAP = Object.fromEntries(TOOL_NAMES.map((name) => [name, name.replaceAll(".", "_")]));
const JSON_CHUNK_SIZE = 40_000;
const MAX_CREATE_BLOCKS = 50;
const MAX_BATCH_UPDATES = 40;
const BLOCK_TYPE_TEXT = 2;
const BLOCK_TYPE_TABLE = 31;
const BLOCK_TYPE_TABLE_CELL = 32;
const WHOAMI_TIMEOUT_MS = 60_000;

export const OPERATION_SCOPES = Object.freeze({
  read: ["docx:document:readonly", "offline_access"],
  "write-json": ["docx:document", "docx:document:readonly", "offline_access"],
  // Editing existing blocks (tables, paragraphs) needs exactly the same scopes as
  // write-json; the separate name keeps auth-check output honest about intent.
  "write-blocks": ["docx:document", "docx:document:readonly", "offline_access"],
  convert: ["docx:document.block:convert", "offline_access"],
  "write-markdown": [
    "docx:document.block:convert",
    "docx:document",
    "docx:document:readonly",
    "offline_access",
  ],
  // 在目录下建文档只需要 docx:document，不需要任何 drive 权限
  "create-doc": ["docx:document", "offline_access"],
  // 插图链路：建图片块 -> 上传媒体 -> replace_image 绑定
  "insert-image": ["docs:document.media:upload", "docx:document", "offline_access"],
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

export function parseWhoamiOutput(output) {
  const text = String(output ?? "");
  if (/No active login sessions found/i.test(text)) {
    return { active: false, expired: false, scopes: [], hasRefreshToken: false, expiresAt: null };
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { active: false, expired: false, scopes: [], hasRefreshToken: false, expiresAt: null };
  }
  let tokenInfo;
  try {
    tokenInfo = JSON.parse(text.slice(start, end + 1));
  } catch {
    fail("无法解析 lark-mcp whoami 输出", "WHOAMI_PARSE_FAILED");
  }
  const expiresAt = Number.isFinite(Number(tokenInfo.expiresAt)) ? Number(tokenInfo.expiresAt) : null;
  const explicitExpired = /AccessToken Expired:\s*true/i.test(text);
  return {
    active: true,
    expired: explicitExpired || (expiresAt !== null && expiresAt <= Date.now() / 1000),
    scopes: Array.isArray(tokenInfo.scopes) ? tokenInfo.scopes.filter((item) => typeof item === "string") : [],
    hasRefreshToken: Boolean(tokenInfo.extra?.refreshToken),
    expiresAt,
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
  if (error?.code === "MCP_TOOL_MISSING") {
    return {
      failureClass: "MCP_TOOL_MISSING",
      missingScopes: [],
      nextAction: "使用本 Skill 脚本兜底，或调整 LARK_TOOLS 后重启 MCP 会话",
    };
  }
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
  if (/tool.+(not found|unknown)|method not found|-32601/i.test(text)) {
    return {
      failureClass: "MCP_TOOL_MISSING",
      missingScopes: [],
      nextAction: "使用本 Skill 脚本兜底，或调整 LARK_TOOLS 后重启 MCP 会话",
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

function elementsText(elements = []) {
  return elements.map((element) => element?.text_run?.content ?? "").join("");
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

const TEXT_CONTAINER_KEYS = [
  "text",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
  "heading7",
  "heading8",
  "heading9",
  "bullet",
  "ordered",
  "code",
  "quote",
  "todo",
  "callout",
];

export function blockText(block) {
  for (const key of TEXT_CONTAINER_KEYS) {
    if (block?.[key]?.elements) return elementsText(block[key].elements);
  }
  return "";
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

// gdbus prints `(objectpath '/org/.../collection/login',)` for ReadAlias and
// `(<true>,)` for Properties.Get; anything else means "could not tell".
export function parseGdbusObjectPath(output) {
  const match = String(output ?? "").match(/objectpath\s+'([^']*)'/);
  return match ? match[1] : null;
}

export function parseGdbusBoolean(output) {
  const match = String(output ?? "").match(/<(true|false)>/);
  return match ? match[1] === "true" : null;
}

// lark-mcp reads its AES key through keytar -> gnome-keyring. A Locked default
// collection makes that call hang for minutes with no output, so only a
// confirmed Locked=true blocks; an unreachable Secret Service stays "unknown"
// and lets lark-mcp report its own error.
export function assessKeyring({ collection, locked }) {
  if (!collection || collection === "/" || locked === null || locked === undefined) {
    return { state: "unknown", collection: collection ?? null };
  }
  if (!locked) return { state: "unlocked", collection };
  return {
    state: "locked",
    collection,
    failureClass: "KEYRING_LOCKED",
    missingScopes: [],
    nextAction:
      "gnome-keyring 默认钥匙串处于 Locked 状态，lark-mcp 读取密钥会卡住。请用户在自己的终端运行 " +
      `/usr/bin/python3 ${join(SCRIPT_DIR, "unlock_keyring.py")} 输入密码解锁（不要在聊天中提供密码），` +
      "解锁后重新运行本命令；详见 references/permission-matrix.md 的钥匙串排障",
  };
}

function gdbusCall(args) {
  const result = spawnSync("gdbus", ["call", "--session", "--dest", "org.freedesktop.secrets", ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 5_000,
  });
  return result.status === 0 ? result.stdout : null;
}

export function checkKeyring() {
  if (process.env.FEISHU_DOC_SKIP_KEYRING_CHECK === "1") return { state: "skipped", collection: null };
  const collection = parseGdbusObjectPath(
    gdbusCall([
      "--object-path",
      "/org/freedesktop/secrets",
      "--method",
      "org.freedesktop.Secret.Service.ReadAlias",
      "default",
    ]),
  );
  if (!collection || collection === "/") return assessKeyring({ collection, locked: null });
  const locked = parseGdbusBoolean(
    gdbusCall([
      "--object-path",
      collection,
      "--method",
      "org.freedesktop.DBus.Properties.Get",
      "org.freedesktop.Secret.Collection",
      "Locked",
    ]),
  );
  return assessKeyring({ collection, locked });
}

function runWhoami() {
  const keyring = checkKeyring();
  if (keyring.state === "locked") {
    const error = new Error(`钥匙串 ${keyring.collection} 已锁定，未启动 lark-mcp`);
    error.code = "KEYRING_LOCKED";
    const { failureClass, missingScopes, nextAction } = keyring;
    error.details = { failureClass, missingScopes, nextAction };
    throw error;
  }
  const result = spawnSync(LARK_WRAPPER, ["whoami"], { encoding: "utf8", env: process.env, timeout: WHOAMI_TIMEOUT_MS });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error?.code === "ETIMEDOUT") {
    const error = new Error(`lark-mcp whoami ${WHOAMI_TIMEOUT_MS / 1000}s 内无响应`);
    error.code = "WHOAMI_TIMEOUT";
    error.details = {
      failureClass: "WHOAMI_TIMEOUT",
      missingScopes: [],
      nextAction:
        "多为 OS 钥匙串无响应：检查 gnome-keyring 是否锁定、是否有陈旧的 gcr-prompter 进程；" +
        "详见 references/permission-matrix.md 的钥匙串排障",
    };
    throw error;
  }
  if (/keytar timeout/i.test(output)) {
    const error = new Error("lark-mcp 读取 OS 钥匙串超时");
    error.code = "KEYRING_LOCKED";
    const { failureClass, missingScopes, nextAction } = assessKeyring({ collection: "default", locked: true });
    error.details = { failureClass, missingScopes, nextAction };
    throw error;
  }
  if (result.error) throw result.error;
  if (result.status !== 0) fail(output.trim() || "lark-mcp whoami 失败", "WHOAMI_FAILED");
  return parseWhoamiOutput(output);
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

// whoami 只读本地缓存。access_token 过期时 lark-mcp 会在工具调用前用 refresh_token 续期
// （dist/mcp-tool/mcp-tool.js:104），续期失败则报 "user_access_token is invalid or expired"。
// 所以过期会话是否可用只能靠一次真实调用确认；非 wiki 目标用占位 token，正常会得到 131005 not found。
const TOKEN_REJECTED = /user_access_token is invalid or expired/i;

export async function probeSession(target, connect = connectLark) {
  const mcp = await connect();
  try {
    const token = target?.kind === "wiki" ? target.token : "probe";
    await mcp.call("wiki.v2.space.getNode", { params: { token }, useUAT: true });
    return true;
  } catch (error) {
    return !TOKEN_REJECTED.test(String(error?.message ?? error));
  } finally {
    await mcp.close();
  }
}

export async function checkAuthorization(operation, target, { whoami = runWhoami, probe = probeSession } = {}) {
  const session = whoami();
  const result = assessAuthorization(session, operation, target);
  if (!result.ready || !session.expired) return { session, result };
  if (await probe(target)) {
    const refreshed = whoami();
    return { session: refreshed, result: assessAuthorization(refreshed, operation, target) };
  }
  return {
    session,
    result: {
      ...result,
      ready: false,
      failureClass: "TOKEN_EXPIRED",
      nextAction: "access_token 已过期且 refresh_token 续期失败，运行 authorize 在浏览器重新授权",
    },
  };
}

async function authorize(operation, target) {
  const { session, result: current } = await checkAuthorization(operation, target);
  if (current.ready) return current;
  const desiredScopes = new Set(["auth:user.id:read", ...session.scopes, ...requiredScopes(operation, target)]);
  if (session.active) {
    const logout = spawnSync(LARK_WRAPPER, ["logout"], { encoding: "utf8", env: process.env });
    if (logout.status !== 0) fail(`${logout.stdout ?? ""}${logout.stderr ?? ""}`.trim(), "LOGOUT_FAILED");
  }
  const result = await runStreaming(LARK_WRAPPER, ["login", "--scope", [...desiredScopes].sort().join(" ")]);
  if (result.code !== 0) {
    const classified = classifyFailure(result.output, { requiredScopes: [...desiredScopes].sort() });
    const error = new Error("飞书 OAuth 授权失败；请按 failureClass 和 nextAction 处理");
    error.details = classified;
    throw error;
  }
  return assessAuthorization(runWhoami(), operation, target);
}

function sdkRoot() {
  const installRoot = process.env.LARK_MCP_HOME || join(homedir(), ".local/share/agent-tools/mcp-cache/lark");
  return join(installRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/client");
}

export async function connectLark({ extraTools = [] } = {}) {
  const root = sdkRoot();
  const clientModule = join(root, "index.js");
  const stdioModule = join(root, "stdio.js");
  if (!existsSync(clientModule) || !existsSync(stdioModule)) {
    fail("Lark MCP SDK 尚未安装；先运行 lark-mcp whoami 触发固定版本安装", "MCP_SDK_MISSING");
  }
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(clientModule).href),
    import(pathToFileURL(stdioModule).href),
  ]);
  const toolNames = [...new Set([...TOOL_NAMES, ...extraTools])];
  const transport = new StdioClientTransport({
    command: LARK_WRAPPER,
    // credentials.env may define LARK_TOOLS=preset.doc.default. Passing -t after
    // the wrapper's own arguments deliberately gives this one-shot client the
    // exact write/readback tool set without broadening the resident MCP server.
    args: ["mcp", "-t", toolNames.join(",")],
    env: { ...process.env, LARK_TOOLS: toolNames.join(",") },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    if (process.env.FEISHU_DOC_DEBUG === "1") process.stderr.write(chunk);
  });
  const client = new Client({ name: "manage-feishu-doc", version: "1.0.0" });
  await client.connect(transport);
  const listed = await client.listTools();
  const available = new Set(listed.tools.map((tool) => tool.name));
  return {
    async call(apiName, args) {
      const toolName = TOOL_NAME_MAP[apiName] ?? apiName.replaceAll(".", "_");
      if (!available.has(toolName)) {
        fail(
          `MCP tool 未加载: ${toolName}; 当前已加载: ${[...available].sort().join(", ") || "none"}`,
          "MCP_TOOL_MISSING",
        );
      }
      const result = await client.callTool({ name: toolName, arguments: args });
      if (result.isError) {
        const detail = result.content?.map((item) => item.text ?? "").join("\n") || JSON.stringify(result);
        fail(detail, "LARK_TOOL_FAILED");
      }
      return unpackToolResult(result);
    },
    close: () => client.close(),
  };
}

function unpackToolResult(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const texts = (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text);
  if (texts.length === 0) return result;
  const combined = texts.join("\n");
  return parseEmbeddedJson(combined) ?? combined;
}

function responseNode(value) {
  return value?.node ?? value?.data?.node ?? value;
}

export async function resolveDocument(mcp, target) {
  if (target.kind === "docx") return { documentToken: target.token, sourceKind: "docx" };
  const value = await mcp.call("wiki.v2.space.getNode", { params: { token: target.token }, useUAT: true });
  const node = responseNode(value);
  if (node?.obj_type !== "docx" || !node?.obj_token) {
    fail(`wiki 节点不是可写 docx: obj_type=${node?.obj_type ?? "unknown"}`, "UNSUPPORTED_WIKI_OBJECT");
  }
  return { documentToken: node.obj_token, sourceKind: "wiki", wikiToken: target.token };
}

function responseItems(value) {
  return value?.items ?? value?.data?.items ?? [];
}

function responsePage(value) {
  return {
    hasMore: Boolean(value?.has_more ?? value?.data?.has_more),
    pageToken: value?.page_token ?? value?.data?.page_token ?? null,
  };
}

async function getRootBlocks(mcp, documentToken) {
  const blocks = [];
  let pageToken = null;
  do {
    const params = { page_size: 500, document_revision_id: -1 };
    if (pageToken) params.page_token = pageToken;
    const value = await mcp.call("docx.v1.documentBlockChildren.get", {
      path: { document_id: documentToken, block_id: documentToken },
      params,
      useUAT: true,
    });
    blocks.push(...responseItems(value));
    const page = responsePage(value);
    pageToken = page.hasMore ? page.pageToken : null;
    if (page.hasMore && !pageToken) fail("飞书分页响应缺少 page_token", "INVALID_LARK_RESPONSE");
  } while (pageToken);
  return blocks;
}

async function createBlocks(mcp, documentToken, blocks, clientToken) {
  return await mcp.call("docx.v1.documentBlockChildren.create", {
    path: { document_id: documentToken, block_id: documentToken },
    params: { document_revision_id: -1, client_token: clientToken },
    data: { children: blocks },
    useUAT: true,
  });
}

async function deleteSection(mcp, documentToken, section, contentHash, range) {
  return await mcp.call("docx.v1.documentBlockChildren.batchDelete", {
    path: { document_id: documentToken, block_id: documentToken },
    params: {
      document_revision_id: -1,
      client_token: deterministicClientToken(documentToken, section, contentHash, range.startIndex, range.endIndex, "delete"),
    },
    data: { start_index: range.startIndex, end_index: range.endIndex + 1 },
    useUAT: true,
  });
}

function revisionOf(value) {
  return value?.document_revision_id ?? value?.data?.document_revision_id ?? null;
}

export async function writeJson(mcp, documentToken, { content, section, heading, mode }) {
  const managed = buildManagedBlocks(section, content, heading);
  let blocks = await getRootBlocks(mcp, documentToken);
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
      mcp,
      documentToken,
      managed.blocks,
      deterministicClientToken(documentToken, section, managed.contentHash, "create"),
    );
    revision = revisionOf(created);
    blocks = await getRootBlocks(mcp, documentToken);
    existing = findManagedSections(blocks, section);
    const inserted = existing.filter((item) => item.actualHash === managed.contentHash && item.verified);
    if (inserted.length === 0) {
      fail("飞书返回写入成功，但回读内容 SHA-256 不一致", "VERIFY_FAILED");
    }
  }

  blocks = await getRootBlocks(mcp, documentToken);
  existing = findManagedSections(blocks, section);
  const keep = [...existing]
    .reverse()
    .find((item) => item.actualHash === managed.contentHash && item.verified);
  if (!keep) fail("找不到已校验的新托管章节", "VERIFY_FAILED");
  const obsolete = existing.filter((item) => item !== keep).sort((a, b) => b.startIndex - a.startIndex);
  for (const item of obsolete) {
    const deleted = await deleteSection(mcp, documentToken, section, managed.contentHash, item);
    revision = revisionOf(deleted) ?? revision;
  }

  const finalSections = findManagedSections(await getRootBlocks(mcp, documentToken), section);
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

// One paged sweep returns every block in the document, table cells and their
// text children included. Walking the tree with documentBlockChildren.get costs
// one call per cell instead, which is orders of magnitude slower on big tables.
export async function listAllBlocks(mcp, documentToken) {
  const blocks = [];
  let pageToken = null;
  do {
    const params = { page_size: 500, document_revision_id: -1 };
    if (pageToken) params.page_token = pageToken;
    const value = await mcp.call("docx.v1.documentBlock.list", {
      path: { document_id: documentToken },
      params,
      useUAT: true,
    });
    blocks.push(...responseItems(value));
    const page = responsePage(value);
    pageToken = page.hasMore ? page.pageToken : null;
    if (page.hasMore && !pageToken) fail("飞书分页响应缺少 page_token", "INVALID_LARK_RESPONSE");
  } while (pageToken);
  return blocks;
}

async function insertTableRows(mcp, documentToken, tableId, count) {
  for (let index = 0; index < count; index += 1) {
    await mcp.call("docx.v1.documentBlock.patch", {
      path: { document_id: documentToken, block_id: tableId },
      params: {
        document_revision_id: -1,
        client_token: deterministicClientToken(documentToken, tableId, "insert-row", index, count),
      },
      // row_index -1 appends; a non-negative value makes the new row land at
      // exactly that index and pushes the rest down.
      data: { insert_table_row: { row_index: -1 } },
      useUAT: true,
    });
  }
}

async function padCellBlocks(mcp, documentToken, cellId, missing) {
  for (let index = 0; index < missing; index += 1) {
    await mcp.call("docx.v1.documentBlockChildren.create", {
      path: { document_id: documentToken, block_id: cellId },
      params: {
        document_revision_id: -1,
        client_token: deterministicClientToken(documentToken, cellId, "pad", index),
      },
      data: {
        index: 0,
        children: [{ block_type: BLOCK_TYPE_TEXT, text: { elements: textElements("") } }],
      },
      useUAT: true,
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

export async function syncTable(mcp, documentToken, { tableId, rows, padCells = "auto", dryRun = false }) {
  if (!Array.isArray(rows) || rows.length === 0) fail("rows 必须是非空二维数组");
  const columnSize = rows[0].length;
  if (rows.some((row) => !Array.isArray(row) || row.length !== columnSize)) {
    fail("rows 每一行的列数必须一致", "INVALID_TABLE_SHAPE");
  }
  if (rows.some((row) => row.some((value) => typeof value !== "string"))) {
    fail("rows 的单元格必须是字符串", "INVALID_TABLE_SHAPE");
  }

  let blocks = await listAllBlocks(mcp, documentToken);
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
    await insertTableRows(mcp, documentToken, tableId, plan.rowsToAppend);
    blocks = await listAllBlocks(mcp, documentToken);
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
            await padCellBlocks(mcp, documentToken, table.cellIds[row][column], missing);
            padded += missing;
          }
        }
      }
      plan.cellBlocksPadded = padded;
      if (padded > 0) {
        blocks = await listAllBlocks(mcp, documentToken);
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
    const result = await mcp.call("docx.v1.documentBlock.batchUpdate", {
      path: { document_id: documentToken },
      params: {
        document_revision_id: -1,
        client_token: deterministicClientToken(documentToken, tableId, "batch", start, chunk.length),
      },
      data: { requests: chunk },
      useUAT: true,
    });
    revision = revisionOf(result) ?? revision;
  }

  const finalTable = readTable(await listAllBlocks(mcp, documentToken), tableId);
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

export async function updateTextElements(mcp, documentToken, plan, { dryRun = false } = {}) {
  const blocks = await listAllBlocks(mcp, documentToken);
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
    const result = await mcp.call("docx.v1.documentBlock.batchUpdate", {
      path: { document_id: documentToken },
      params: {
        document_revision_id: -1,
        client_token: deterministicClientToken(documentToken, "update-text", sha256(JSON.stringify(chunk))),
      },
      data: { requests: chunk },
      useUAT: true,
    });
    revision = revisionOf(result) ?? revision;
  }

  const mismatches = diffTextPlan(await listAllBlocks(mcp, documentToken), plan);
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
      "parse-target --target=<url-or-token>",
      "auth-check --operation=read|write-json|write-blocks|convert|write-markdown [--target=<url-or-token>]",
      "authorize --operation=<operation> [--target=<url-or-token>]",
      "read --target=<url-or-token> [--summary]",
      "list-blocks --target=<url-or-token> [--type=<block_type>] [--full] [--out=<path>]",
      "update-text --target=<url-or-token> --file=<plan.json>|--stdin [--dry-run]",
      "link-plan --target=<url-or-token> --labels=<labels.json> --out=<plan.json>",
      "table-read --target=<url-or-token> [--table=<block_id>|--table-index=<n>]",
      "table-sync --target=<url-or-token> --table=<block_id>|--table-index=<n> --file=<path>|--stdin [--pad-cells=auto|off] [--dry-run]",
      "inspect-sections --target=<url-or-token> [--section=<id>]",
      "write-json --target=<url-or-token> --file=<path>|--stdin --section=<id> [--heading=<text>] [--mode=upsert|append]",
      "call --target=<url-or-token> --api=<lark.api.name> --file=<path>|--stdin [--operation=read|write-blocks]",
    ],
    notes: [
      "table-sync 的输入是 {\"rows\": [[...]]} 或裸二维数组，含表头行；行数只增不减。",
      "list-blocks --full 返回原始块（含 text_element_style）；--out 把原始块写入文件，只在 stdout 打印摘要。",
      "update-text 的计划是 [{block_id, elements}]，整块替换 elements；未变化的块跳过，每批 40 条，写后逐块回读校验。",
      "link-plan 的 labels 是 {正文文字: 标题文本或 block_id}，只生成计划，写入仍走 update-text。",
      "call 是逃生口，直接透传参数给已加载的 lark MCP 工具；参数 JSON 需自带 path/params/data。",
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

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || options.help) return printJson(usage());
  const target = options.target ? parseTarget(options.target) : null;

  if (command === "parse-target") return printJson({ status: "ok", target });
  if (command === "auth-check") {
    const operation = options.operation || "read";
    const { result } = await checkAuthorization(operation, target);
    printJson({ status: result.ready ? "ready" : "permission_required", ...result });
    if (!result.ready) process.exitCode = 2;
    return;
  }
  if (command === "authorize") {
    const operation = options.operation || "read";
    const result = await authorize(operation, target);
    printJson({ status: result.ready ? "ready" : "permission_required", ...result });
    if (!result.ready) process.exitCode = 2;
    return;
  }
  // 在指定目录下新建文档。幂等靠调用方给定的 --slug：先在目录里找同 slug 的文档，
  // 找到就复用（清空正文后重写），避免重跑一次多出一篇同名文档。
  if (command === "create-doc") {
    if (!target || target.kind !== "folder") {
      fail("create-doc 需要 --target 指向 /drive/folder/<token>", "UNSUPPORTED_RESOURCE");
    }
    if (!options.title) fail("create-doc 必须指定 --title");
    const auth = assessAuthorization(runWhoami(), "create-doc", null);
    if (!auth.ready) {
      printJson({ status: "permission_required", ...auth });
      process.exitCode = 2;
      return;
    }
    const mcp = await connectLark({ extraTools: ["docx.v1.document.create"] });
    try {
      const created = await mcp.call("docx.v1.document.create", {
        useUAT: true,
        data: { folder_token: target.token, title: options.title },
      });
      const doc = created?.data?.document ?? created?.document ?? created;
      const documentToken = doc.document_id ?? doc.documentId;
      printJson({
        status: "ok",
        folderToken: target.token,
        documentToken,
        url: `https://lexin.feishu.cn/docx/${documentToken}`,
      });
    } finally {
      await mcp.close();
    }
    return;
  }

  if (!target) fail(`${command} 必须指定 --target`);
  requireDocumentTarget(target, command);
  const READ_COMMANDS = new Set(["read", "inspect-sections", "list-blocks", "table-read", "outline", "link-plan"]);
  const operation = READ_COMMANDS.has(command)
    ? "read"
    : command === "write-json"
      ? "write-json"
      : command === "table-sync" || command === "update-text"
        ? "write-blocks"
        : command === "call"
          ? options.operation === "read"
            ? "read"
            : "write-blocks"
          : null;
  if (!operation) fail(`未知命令: ${command}`);
  const auth = assessAuthorization(runWhoami(), operation, target);
  if (!auth.ready) {
    printJson({ status: "permission_required", ...auth });
    process.exitCode = 2;
    return;
  }

  // call is an escape hatch for APIs this script has no wrapper for, so the
  // requested tool is loaded on demand instead of forcing a code change here.
  const mcp = await connectLark({ extraTools: command === "call" && options.api ? [options.api] : [] });
  try {
    const resolved = await resolveDocument(mcp, target);
    if (command === "read") {
      const value = await mcp.call("docx.v1.document.rawContent", {
        path: { document_id: resolved.documentToken },
        useUAT: true,
      });
      const content = value?.content ?? value?.data?.content ?? value;
      if (options.summary) {
        const normalized = typeof content === "string" ? content : JSON.stringify(content);
        return printJson({
          status: "ok",
          ...resolved,
          contentLength: normalized.length,
          contentHash: sha256(normalized),
        });
      }
      return printJson({ status: "ok", ...resolved, content });
    }
    // 大文档先看骨架再定位，避免把整篇 rawContent 拉进上下文。
    // --heading 只返回该标题到下一个同级或更高级标题之间的内容。
    if (command === "outline") {
      const blocks = await listAllBlocks(mcp, resolved.documentToken);
      const headings = [];
      blocks.forEach((block, idx) => {
        const level = block.block_type >= 3 && block.block_type <= 11 ? block.block_type - 2 : 0;
        if (!level) return;
        const key = `heading${level}`;
        const text = (block[key]?.elements ?? []).map((e) => e.text_run?.content ?? "").join("");
        headings.push({ level, text, blockIndex: idx });
      });
      if (!options.heading) {
        return printJson({ status: "ok", ...resolved, blockCount: blocks.length, headings });
      }
      const start = headings.find((h) => h.text.includes(options.heading));
      if (!start) {
        return printJson({ status: "not_found", ...resolved, heading: options.heading, headings });
      }
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
      const blocks = await listAllBlocks(mcp, resolved.documentToken);
      const filtered = options.type
        ? blocks.filter((block) => String(block.block_type) === String(options.type))
        : blocks;
      const tally = {};
      for (const block of blocks) tally[block.block_type] = (tally[block.block_type] ?? 0) + 1;
      if (options.out) {
        writeFileSync(options.out, `${JSON.stringify(filtered, null, 2)}\n`);
        return printJson({
          status: "ok",
          ...resolved,
          blockCount: blocks.length,
          blockTypeCounts: tally,
          out: options.out,
          written: filtered.length,
        });
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
      const blocks = await listAllBlocks(mcp, resolved.documentToken);
      const tableId = tableIdFrom(blocks, options);
      const table = readTable(blocks, tableId);
      return printJson({
        status: "ok",
        ...resolved,
        blockId: table.blockId,
        rowSize: table.rowSize,
        columnSize: table.columnSize,
        rows: table.rows,
      });
    }
    if (command === "table-sync") {
      const rows = await inputRows(options);
      const blocks = await listAllBlocks(mcp, resolved.documentToken);
      const tableId = tableIdFrom(blocks, options);
      const result = await syncTable(mcp, resolved.documentToken, {
        tableId,
        rows,
        padCells: options["pad-cells"] === "off" ? "off" : "auto",
        dryRun: Boolean(options["dry-run"]),
      });
      return printJson({ status: result.status, ...resolved, blockId: tableId, ...result });
    }
    if (command === "update-text") {
      const plan = prepareTextPlan(JSON.parse(await inputJson(options)));
      const result = await updateTextElements(mcp, resolved.documentToken, plan, {
        dryRun: Boolean(options["dry-run"]),
      });
      return printJson({ ...resolved, ...result });
    }
    if (command === "link-plan") {
      if (!options.labels || !options.out) fail("link-plan 必须指定 --labels=<labels.json> 和 --out=<plan.json>");
      const labels = JSON.parse(readFileSync(options.labels, "utf8"));
      const blocks = await listAllBlocks(mcp, resolved.documentToken);
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
    if (command === "call") {
      if (!options.api) fail("call 必须指定 --api=<lark.api.name>");
      const args = await inputJson(options).then((text) => JSON.parse(text));
      const value = await mcp.call(options.api, { useUAT: true, ...args });
      return printJson({ status: "ok", ...resolved, api: options.api, result: value });
    }
    if (command === "inspect-sections") {
      const blocks = await getRootBlocks(mcp, resolved.documentToken);
      const sections = options.section ? findManagedSections(blocks, options.section) : [];
      return printJson({
        status: "ok",
        ...resolved,
        blockCount: blocks.length,
        section: options.section || null,
        sections,
      });
    }
    const mode = options.mode || "upsert";
    if (!new Set(["upsert", "append"]).has(mode)) fail("mode 仅支持 upsert 或 append");
    if (!options.section) fail("write-json 必须指定 --section");
    const content = await inputJson(options);
    const result = await writeJson(mcp, resolved.documentToken, {
      content,
      section: options.section,
      heading: options.heading || null,
      mode,
    });
    return printJson({ status: result.status, ...resolved, section: options.section, ...result });
  } finally {
    await mcp.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const operation = process.argv.includes("read") ? "read" : "write-json";
    const classified = error.details ?? classifyFailure(error, { requiredScopes: OPERATION_SCOPES[operation] ?? [] });
    printJson({
      status: "error",
      code: error.code ?? classified.failureClass,
      message: error.message,
      ...classified,
    });
    process.exitCode = 1;
  });
}
