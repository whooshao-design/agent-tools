// lark-cli 传输层：把「开放平台 API 名 + path/params/data」翻成 `lark-cli api` 调用，
// 统一错误分类、写入节流和限流重试。所有调用都用用户身份（--as user）。
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = join(LIB_DIR, "../../../../..");
export const LARK_CLI = process.env.FEISHU_DOC_LARK_CLI || join(REPO_DIR, "mcp/third-party-mcp/lark/bin/lark-cli");

// 单篇文档写入 3 次/秒、应用写接口 3 次/秒（开放平台文档），写请求之间至少间隔这么久
const MIN_WRITE_INTERVAL_MS = 350;
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export const API_ROUTES = Object.freeze({
  "wiki.v2.space.getNode": ["GET", "/open-apis/wiki/v2/spaces/get_node"],
  "docx.v1.document.create": ["POST", "/open-apis/docx/v1/documents"],
  "docx.v1.document.get": ["GET", "/open-apis/docx/v1/documents/:document_id"],
  "docx.v1.document.rawContent": ["GET", "/open-apis/docx/v1/documents/:document_id/raw_content"],
  "docx.v1.document.convert": ["POST", "/open-apis/docx/v1/documents/blocks/convert"],
  "docx.v1.documentBlock.list": ["GET", "/open-apis/docx/v1/documents/:document_id/blocks"],
  "docx.v1.documentBlock.get": ["GET", "/open-apis/docx/v1/documents/:document_id/blocks/:block_id"],
  "docx.v1.documentBlock.patch": ["PATCH", "/open-apis/docx/v1/documents/:document_id/blocks/:block_id"],
  "docx.v1.documentBlock.batchUpdate": ["PATCH", "/open-apis/docx/v1/documents/:document_id/blocks/batch_update"],
  "docx.v1.documentBlockChildren.get": ["GET", "/open-apis/docx/v1/documents/:document_id/blocks/:block_id/children"],
  "docx.v1.documentBlockChildren.create": ["POST", "/open-apis/docx/v1/documents/:document_id/blocks/:block_id/children"],
  "docx.v1.documentBlockChildren.batchDelete": [
    "DELETE",
    "/open-apis/docx/v1/documents/:document_id/blocks/:block_id/children/batch_delete",
  ],
  "docx.v1.documentBlockDescendant.create": ["POST", "/open-apis/docx/v1/documents/:document_id/blocks/:block_id/descendant"],
  "drive.v1.fileComment.list": ["GET", "/open-apis/drive/v1/files/:file_token/comments"],
});

export class LarkCliError extends Error {
  constructor(message, envelope, code) {
    super(message);
    this.name = "LarkCliError";
    this.envelope = envelope ?? null;
    this.code = code ?? envelope?.error?.code ?? envelope?.error?.subtype ?? "LARK_CLI_FAILED";
    this.details = classifyEnvelope(envelope);
  }
}

// lark-cli 把结果打印成一个 JSON 信封 {ok, identity, data | error}；设备码登录等命令会先打印事件行
export function parseEnvelope(...outputs) {
  for (const text of outputs) {
    const value = String(text ?? "").trim();
    if (!value) continue;
    try {
      return JSON.parse(value);
    } catch {
      // 退回到截取首个 { 到末个 } 之间的内容
    }
    const first = value.indexOf("{");
    const last = value.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(value.slice(first, last + 1));
      } catch {
        // 换下一个输出流再试
      }
    }
  }
  return null;
}

export function runLarkCli(args, { input, cwd } = {}) {
  const result = spawnSync(LARK_CLI, args, {
    input,
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const envelope = parseEnvelope(result.stdout, result.stderr);
  if (!envelope) {
    const tail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().slice(0, 800);
    throw new LarkCliError(`lark-cli 输出无法解析（exit=${result.status}）：${tail}`, null, "LARK_CLI_OUTPUT");
  }
  return envelope;
}

// 把 lark-cli 的 type/subtype 映射到本 skill 沿用的失败分类
export function classifyEnvelope(envelope) {
  const error = envelope?.error ?? {};
  const subtype = error.subtype ?? "";
  const missingScopes = [...new Set(error.missing_scopes ?? [])].sort();
  const base = { code: error.code ?? null, logId: error.log_id ?? null, missingScopes };
  if (subtype === "app_scope_not_applied") {
    return {
      ...base,
      failureClass: "APP_PERMISSION_NOT_PUBLISHED",
      nextAction: "在飞书开放平台给应用添加这些用户身份权限并发布版本，然后运行 authorize",
    };
  }
  if (["missing_scope", "token_scope_insufficient", "user_unauthorized"].includes(subtype) || missingScopes.length > 0) {
    return { ...base, failureClass: "OAUTH_SCOPE_MISSING", nextAction: "运行 authorize 补授权这些 scope" };
  }
  if (error.type === "authentication" || /^(token_|refresh_token_)/.test(subtype)) {
    return { ...base, failureClass: "AUTH_REQUIRED", nextAction: "运行 authorize 重新登录（设备码，给用户链接确认）" };
  }
  if (error.type === "config" || ["not_configured", "invalid_config", "invalid_client"].includes(subtype)) {
    return {
      ...base,
      failureClass: "LARK_CLI_NOT_CONFIGURED",
      nextAction: "运行 mcp/third-party-mcp/lark/bin/lark-cli setup 绑定应用，再 authorize",
    };
  }
  if (subtype === "rate_limit" || error.code === 99991400 || error.code === 429) {
    return { ...base, failureClass: "RATE_LIMITED", nextAction: "稍后重试；批量写入要节流" };
  }
  if (["permission_denied", "access_denied"].includes(subtype)) {
    return { ...base, failureClass: "DOCUMENT_ACCESS_DENIED", nextAction: "请文档所有者授予当前用户阅读或编辑权限" };
  }
  return {
    ...base,
    failureClass: "LARK_API_FAILED",
    nextAction: "保留错误码与 log_id 检查接口返回，不要自动扩大权限",
  };
}

function larkError(envelope) {
  const error = envelope?.error ?? {};
  // docs +update 失败时信封里没有 error，原因在 data.warnings（如 degrade_code=1002）
  const failed = envelope?.data?.result === "failed" ? `docs +update 返回 failed：${(envelope.data.warnings ?? []).join("；") || "无说明"}` : null;
  const message = [error.message, error.hint].filter(Boolean).join("；") || failed || "lark-cli 调用失败";
  return new LarkCliError(message, envelope);
}

export function fillPath(template, values = {}) {
  return template.replace(/:([a-z_]+)/g, (_, key) => {
    const value = values[key];
    if (value === undefined || value === null || value === "") {
      throw new LarkCliError(`缺少路径参数 ${key}`, null, "INVALID_ARGUMENT");
    }
    return encodeURIComponent(String(value));
  });
}

export function createTransport({
  run = runLarkCli,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  retries = 3,
} = {}) {
  let lastWrite = 0;

  function unwrap(envelope) {
    if (!envelope?.ok) throw larkError(envelope);
    return envelope.data ?? {};
  }

  async function api(method, path, { params, data } = {}) {
    const args = ["api", method, path, "--as", "user"];
    if (params && Object.keys(params).length > 0) args.push("--params", JSON.stringify(params));
    const input = data === undefined ? undefined : JSON.stringify(data);
    if (input !== undefined) args.push("--data", "-");
    for (let attempt = 0; ; attempt += 1) {
      if (WRITE_METHODS.has(method)) {
        const wait = lastWrite + MIN_WRITE_INTERVAL_MS - now();
        if (wait > 0) await sleep(wait);
        lastWrite = now();
      }
      const envelope = run(args, { input });
      if (envelope?.ok) return envelope.data ?? {};
      const kind = classifyEnvelope(envelope).failureClass;
      if (kind === "RATE_LIMITED" && attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw larkError(envelope);
    }
  }

  // 兼容旧 MCP 调用形状：call(apiName, {path, params, data})，useUAT 等多余字段忽略
  async function call(apiName, { path = {}, params, data } = {}) {
    const route = API_ROUTES[apiName];
    if (!route) throw new LarkCliError(`未登记的接口 ${apiName}；用 call --method --path 直接调用`, null, "UNKNOWN_API");
    return api(route[0], fillPath(route[1], path), { params, data });
  }

  // docs / whiteboard 等快捷命令：返回信封的 data。读取（+fetch/+export）不节流，写入与 api 写请求共用间隔
  async function shortcut(args, { input, cwd } = {}) {
    if (!args.some((arg) => arg === "+fetch" || arg === "+export")) {
      const wait = lastWrite + MIN_WRITE_INTERVAL_MS - now();
      if (wait > 0) await sleep(wait);
      lastWrite = now();
    }
    return unwrap(run([...args, "--as", "user"], { input, cwd }));
  }

  return { api, call, shortcut, close: async () => {} };
}
