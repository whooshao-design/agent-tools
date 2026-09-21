#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const childProcess = require('child_process');

const LXCLOUD_SQL_PATH = '/v1/mysql/sql-query/exec-query/';
const LXCLOUD_ENV_BASE_URLS = {
  prod: 'https://lxcloud.lexincloud.com',
  stable: 'https://stable-lxcloud.lexincloud.com',
};
const LXCLOUD_ENV_ALIASES = {
  prod: 'prod',
  production: 'prod',
  online: 'prod',
  '线上': 'prod',
  stable: 'stable',
  test: 'stable',
  '测试': 'stable',
};
const DEFAULT_LXCLOUD_ENV = 'prod';
const LXCLOUD_DB_TYPE_MAX_LENGTH = 128;
const BROWSER_SESSION_SCRIPT = path.join(__dirname, '..', '..', 'get-browser-session', 'scripts', 'browser_session.js');

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--') {
      args._ = argv.slice(index + 1);
      break;
    }
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const equalsIndex = item.indexOf('=');
    if (equalsIndex !== -1) {
      args[item.slice(2, equalsIndex)] = item.slice(equalsIndex + 1);
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args[item.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      args[item.slice(2)] = true;
    }
  }
  return args;
}

function sanitize(text) {
  return String(text || '')
    .replace(/'[^']+'@'[^']+'/g, "'<user>'@'<host>'")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/password\s*=\s*[^&\s]+/gi, 'password=<stored>')
    .replace(/bearer\s+[a-z0-9._-]+/gi, 'Bearer <token>')
    .replace(/(cookie|authorization)\s*[:=]\s*[^,\n]+/gi, '$1=<redacted>');
}

function valueFrom(args, argName, envName) {
  return args[argName] || process.env[envName];
}

function resolveLxcloudEnv(raw) {
  if (!raw || raw === true) {
    return DEFAULT_LXCLOUD_ENV;
  }
  const env = LXCLOUD_ENV_ALIASES[String(raw).trim().toLowerCase()];
  if (!env) {
    throw new Error(`未知 lxcloud 环境：${raw}。仅支持 prod（线上）和 stable（测试/stable）。`);
  }
  return env;
}

function lxcloudBaseUrl(env) {
  return LXCLOUD_ENV_BASE_URLS[resolveLxcloudEnv(env)];
}

function lxcloudEndpoint(env) {
  return `${lxcloudBaseUrl(env)}${LXCLOUD_SQL_PATH}`;
}

// 顺序扫描：字符串字面量替换成 ''（-- 或 /* 出现在字符串里不算注释），注释去掉，
// MySQL 会执行的 /*! ... */ 只去标记、内容递归处理。正则分步替换做不到这三条同时成立。
// options.dashCommentNeedsSpace：MySQL 要求 `--` 后跟空白才是注释（默认）；Presto/Spark 的 `--` 到行尾都是注释。
// options.backslashEscapes：MySQL/Spark 字符串里 `\` 转义下一个字符（默认）；Presto 只用连续两个引号转义，`\` 是普通字符。
function stripSqlLiteralsAndComments(sql, options = {}) {
  const dashNeedsSpace = options.dashCommentNeedsSpace !== false;
  const backslashEscapes = options.backslashEscapes !== false;
  const src = String(sql || '');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (backslashEscapes && src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) { if (src[j + 1] === ch) { j += 2; continue; } break; }
        j += 1;
      }
      out += ch === '`' ? ' ' : "''";
      i = j + 1;
      continue;
    }
    // MySQL：`--` 后必须跟空白/控制字符（或行尾）才是注释，`1--1` 是表达式；`#` 到行尾都是注释。
    const dashComment = ch === '-' && next === '-' && (!dashNeedsSpace || i + 2 >= src.length || /[\s\x00-\x1f]/.test(src[i + 2]));
    if (dashComment || ch === '#') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i + 2, end === -1 ? src.length : end);
      out += body.startsWith('!') ? ` ${stripSqlLiteralsAndComments(body.replace(/^!\d*/, ''), options)} ` : ' ';
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function assertReadOnlySql(sql) {
  const normalized = stripSqlLiteralsAndComments(sql)
    .trim()
    .toLowerCase();
  // 白名单 + 逐条语句校验（防多语句拼接绕过首关键字检查）；最终访问权限由 lxcloud 服务端决定。
  const allowed = /^(select|show|desc|describe|explain|with|help)\b/;
  const statements = normalized.split(';').map((s) => s.trim()).filter(Boolean);
  if (!statements.length || !statements.every((s) => allowed.test(s))) {
    throw new Error('拒绝执行非只读 SQL。仅允许 SELECT/SHOW/DESCRIBE/EXPLAIN/WITH 等只读语句（逐条校验）。');
  }
  // 首关键字挡不住 WITH ... DELETE、SELECT ... INTO OUTFILE、SELECT ... FOR UPDATE：字面量已替换掉，再查写关键字。
  // INSERT()/REPLACE()/TRUNCATE() 是字符串或数学函数：后面紧跟 ( 的不算写语句。
  const forbidden = /\b(update|delete|create|alter|drop|rename|grant|revoke)\b|\b(insert|replace|truncate)\b(?!\s*\()|\binto\s+(outfile|dumpfile)\b|\bfor\s+update\b|\block\s+in\s+share\s+mode\b/;
  for (const statement of statements) {
    if (!/^(select|with)\b/.test(statement)) continue; // SHOW CREATE TABLE / DESC / EXPLAIN 不执行写操作
    const hit = statement.match(forbidden);
    if (hit) throw new Error(`拒绝执行非只读 SQL：语句里出现写操作或锁定/导出子句（${hit[0].trim()}）。`);
  }
}

function normalizeLxcloudDbType(raw) {
  const value = String(raw || '').trim();
  const lowered = value.toLowerCase();
  if (['process-test', 'process_test', 'processtestdb'].includes(lowered)) {
    return 'ProcesstestDB';
  }
  if (['process-manage', 'process_manage', 'processmanage', 'processmanagedb'].includes(lowered)) {
    return 'ProcessmanageDB';
  }
  if (['hawk', 'mihawk', 'mihuo', 'hawkdecisiondb'].includes(lowered)) {
    return 'HawkDecisionDB';
  }
  if (['credit', 'creditm', 'creditmdb', 'rc_credit_ms_db'].includes(lowered)) {
    return 'CreditmDB';
  }
  if (['postreal', 'post-real', 'post_real', 'postrealdb'].includes(lowered)) {
    return 'PostrealDB';
  }
  if (['strategypfm', 'strategy-pfm', 'strategy_pfm', 'strategypfmdb'].includes(lowered)) {
    return 'StrategypfmDB';
  }
  if (['creditpfm', 'credit-pfm', 'credit_pfm', 'creditpfmdb'].includes(lowered)) {
    return 'CreditpfmDB';
  }
  return value;
}

function validateLxcloudDbType(raw) {
  if (!raw || raw === true) {
    throw new Error('缺少实例 db_type。用户未明确提供时，应先从目标项目的运行时数据源配置中确认。');
  }
  const dbType = normalizeLxcloudDbType(raw);
  if (!dbType) {
    throw new Error('缺少实例 db_type。用户未明确提供时，应先从目标项目的运行时数据源配置中确认。');
  }
  if (dbType.length > LXCLOUD_DB_TYPE_MAX_LENGTH || /[\x00-\x1f\x7f]/.test(dbType)) {
    throw new Error(`非法实例 db_type：仅允许不超过 ${LXCLOUD_DB_TYPE_MAX_LENGTH} 个字符且不含控制字符。`);
  }
  return dbType;
}

function validateLxcloudQueryArgs(args) {
  const dbType = validateLxcloudDbType(valueFrom(args, 'db-type', 'LXCLOUD_DB_TYPE'));
  if (!args.query || args.query === true) {
    throw new Error('缺少 --query');
  }
  assertReadOnlySql(args.query);
  return dbType;
}

function normalizeAuthorization(raw) {
  if (!raw || raw === true) {
    return '';
  }
  const text = String(raw).trim();
  if (!text) return '';
  return text.toLowerCase().startsWith('bearer ') ? text : `Bearer ${text}`;
}

function normalizeLxcloudUserName(raw) {
  const value = String(raw || '').trim();
  if (!value || value.length > 128 || !/^[a-z0-9][a-z0-9._@-]*$/i.test(value)) {
    return '';
  }
  return value;
}

function userNameFromJwt(authorization) {
  const token = String(authorization || '').replace(/^bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length < 2) return '';

  try {
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (encoded.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(`${encoded}${padding}`, 'base64').toString('utf8'));
    const containers = [payload, payload.user, payload.userInfo, payload.data].filter(Boolean);
    const keys = ['user_name', 'username', 'userName', 'preferred_username', 'account', 'sub'];
    for (const container of containers) {
      for (const key of keys) {
        const userName = normalizeLxcloudUserName(container[key]);
        if (userName) return userName;
      }
    }
  } catch (_) {
    // The lxcloud token may be opaque rather than JWT; fall back to page identity.
  }
  return '';
}

function inferLxcloudUserName(session, authorization) {
  const jwtUserName = userNameFromJwt(authorization);
  if (jwtUserName) return jwtUserName;

  const snippet = String((session && session.snippet) || '');
  const versionMatch = snippet.match(/版本说明\s+([a-z0-9][a-z0-9._@-]*)\s*[（(]/i);
  if (versionMatch) return normalizeLxcloudUserName(versionMatch[1]);

  const accountMatch = snippet.match(/\b([a-z][a-z0-9._@-]*)\s*[（(][^()（）]{1,64}[)）]/i);
  return normalizeLxcloudUserName(accountMatch && accountMatch[1]);
}

function lxcloudAuthContextFromBrowserSession(args, baseUrl) {
  if (args['no-browser-session'] || process.env.LXCLOUD_DISABLE_BROWSER_SESSION) {
    return { authorization: '', userName: '' };
  }

  const browserSessionScript = valueFrom(args, 'browser-session-script', 'LXCLOUD_BROWSER_SESSION_SCRIPT') || BROWSER_SESSION_SCRIPT;
  if (!fs.existsSync(browserSessionScript)) {
    return { authorization: '', userName: '' };
  }

  const storageKey = String(valueFrom(args, 'browser-storage-key', 'LXCLOUD_TOKEN_STORAGE_KEY') || 'token');
  const browserUrl = String(valueFrom(args, 'browser-url', 'LXCLOUD_URL') || `${baseUrl}/`);
  const timeoutMs = Number(valueFrom(args, 'browser-timeout-ms', 'LXCLOUD_BROWSER_TIMEOUT_MS') || 60000);
  const childArgs = [
    browserSessionScript,
    '--storage',
    `--url=${browserUrl}`,
    '--success-text=none',
    `--storage-key=${storageKey}`,
    '--storage-type=local',
    '--show-secrets',
  ];

  const browserProfile = valueFrom(args, 'browser-profile', 'LXCLOUD_BROWSER_PROFILE');
  if (browserProfile && browserProfile !== true) childArgs.push(`--profile=${browserProfile}`);
  const browserToolDir = valueFrom(args, 'browser-tool-dir', 'BROWSER_SESSION_TOOL_DIR');
  if (browserToolDir && browserToolDir !== true) childArgs.push(`--tool-dir=${browserToolDir}`);
  const browserChrome = valueFrom(args, 'browser-chrome', 'BROWSER_SESSION_CHROME');
  if (browserChrome && browserChrome !== true) childArgs.push(`--chrome=${browserChrome}`);
  const runtimeLibDir = valueFrom(args, 'browser-runtime-lib-dir', 'BROWSER_SESSION_RUNTIME_LIB_DIR');
  if (runtimeLibDir && runtimeLibDir !== true) childArgs.push(`--runtime-lib-dir=${runtimeLibDir}`);

  const result = childProcess.spawnSync('node', childArgs, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 8,
  });
  if (result.error) {
    throw new Error(`缺少 lxcloud 授权，且浏览器 session token 获取失败：${sanitize(result.error.message)}`);
  }
  if (result.status !== 0) {
    const detail = sanitize(result.stderr || `browser_session exited with code ${result.status}`);
    throw new Error(`缺少 lxcloud 授权，且浏览器 session token 获取失败：${detail}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (_) {
    throw new Error('缺少 lxcloud 授权，且浏览器 session token 输出不是合法 JSON。');
  }
  if (!parsed.sessionReady) {
    throw new Error(`缺少 lxcloud 授权，且 ${browserUrl} 浏览器登录态不可用。请先刷新该环境的登录态。`);
  }
  const tokenRow = (parsed.storage || []).find((item) => item.type === 'local' && item.key === storageKey && item.exists && item.value);
  const authorization = normalizeAuthorization(tokenRow && tokenRow.value);
  return {
    authorization,
    userName: inferLxcloudUserName(parsed, authorization),
  };
}

function resolveLxcloudAuthContext(args, baseUrl) {
  const raw = valueFrom(args, 'authorization', 'LXCLOUD_AUTHORIZATION')
    || valueFrom(args, 'bearer-token', 'LXCLOUD_BEARER_TOKEN');
  const directAuth = normalizeAuthorization(raw);
  if (directAuth) {
    return {
      authorization: directAuth,
      userName: userNameFromJwt(directAuth),
    };
  }

  const browserAuthContext = lxcloudAuthContextFromBrowserSession(args, baseUrl);
  if (browserAuthContext.authorization) {
    return browserAuthContext;
  }

  throw new Error(`缺少 lxcloud 授权。可配置环境变量 LXCLOUD_BEARER_TOKEN/LXCLOUD_AUTHORIZATION，或先用浏览器登录 ${baseUrl}/ 后自动复用 localStorage token。`);
}

function buildLxcloudPayload(args, inferredUserName = '') {
  const dbType = validateLxcloudQueryArgs(args);
  return {
    db_type: dbType,
    user_name: String(valueFrom(args, 'user-name', 'LXCLOUD_USER_NAME') || inferredUserName || os.userInfo().username),
    sql: String(args.query),
    query_type: String(args['query-type'] || 'single'),
    query_role: String(args['query-role'] || 'masterbackup'),
    start_set: String(args['start-set'] || ''),
    end_set: String(args['end-set'] || ''),
  };
}

function postJson(url, originUrl, headers, payload, timeoutMs) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        origin: originUrl,
        referer: `${originUrl}/`,
        'user-agent': 'codex-agent-tools/mysql-readonly',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try {
          parsed = JSON.parse(text);
        } catch (_) {
          // Keep raw text when lxcloud returns non-JSON errors.
        }
        resolve({ statusCode: response.statusCode, body: parsed });
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error(`lxcloud query timeout after ${timeoutMs}ms`));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function runLxcloudQuery(args) {
  const env = resolveLxcloudEnv(valueFrom(args, 'env', 'LXCLOUD_ENV'));
  const baseUrl = LXCLOUD_ENV_BASE_URLS[env];
  const endpoint = `${baseUrl}${LXCLOUD_SQL_PATH}`;
  // 先校验实例和 SQL，避免在参数错误时白白拉起浏览器 session。
  validateLxcloudQueryArgs(args);
  const authContext = resolveLxcloudAuthContext(args, baseUrl);
  const payload = buildLxcloudPayload(args, authContext.userName);
  const cookie = valueFrom(args, 'cookie', 'LXCLOUD_COOKIE');
  const mid = valueFrom(args, 'mid', 'LXCLOUD_MID');
  const headers = {
    authorization: authContext.authorization,
  };
  if (cookie && cookie !== true) headers.cookie = String(cookie);
  if (mid && mid !== true) headers.mid = String(mid);

  const timeoutMs = Number(args['timeout-ms'] || process.env.LXCLOUD_TIMEOUT_MS || 120000);
  const response = await postJson(endpoint, baseUrl, headers, payload, timeoutMs);
  console.log(JSON.stringify({
    env,
    endpoint,
    db_type: payload.db_type,
    query_type: payload.query_type,
    query_role: payload.query_role,
    statusCode: response.statusCode,
    body: response.body,
  }, null, 2));
  // 请求失败不能以 0 退出：HTTP 4xx/5xx、业务错误码或 success=false 都算失败；只有成功响应里的空结果才是"零行"。
  const body = response.body;
  const isObject = Boolean(body) && typeof body === 'object';
  const okValues = ['0', 0, 200, '200', 'ok', 'success', 'succeed'];
  const codeFields = isObject ? ['code', 'retcode', 'errcode', 'status'].filter((k) => body[k] !== undefined) : [];
  const badCodes = codeFields.filter((k) => !okValues.includes(typeof body[k] === 'string' ? body[k].toLowerCase() : body[k]));
  const bizCode = badCodes.length ? `${badCodes[0]}=${body[badCodes[0]]}` : undefined;
  const bizFailed = badCodes.length > 0 || (isObject && body.success === false);
  const notJson = !isObject || !Object.keys(body).length; // 空对象不是查询结果
  // lxcloud 系列接口把结果放在 data（对象或数组）里；没有结果容器的 2xx（如 {message:'denied'}）不是查询成功。
  const hasResult = isObject && (Array.isArray(body.data) || (body.data && typeof body.data === 'object') || Array.isArray(body.rows) || Array.isArray(body.result));
  if (response.statusCode < 200 || response.statusCode >= 300 || notJson || bizFailed || !hasResult) {
    console.error(`lxcloud query failed: HTTP ${response.statusCode}${notJson ? ' (non-JSON body, usually a login/redirect page)' : (!hasResult ? ' (no data/rows/result container in response)' : '')}${bizCode !== undefined ? ` ${bizCode}` : ''}${body && typeof body === 'object' && (body.msg || body.message) ? ` msg=${body.msg || body.message}` : ''}`);
    process.exitCode = 2;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.doctor) {
    console.log(JSON.stringify({
      defaultEnv: DEFAULT_LXCLOUD_ENV,
      lxcloudEnvs: Object.fromEntries(Object.keys(LXCLOUD_ENV_BASE_URLS).map((env) => [env, {
        baseUrl: LXCLOUD_ENV_BASE_URLS[env],
        endpoint: lxcloudEndpoint(env),
      }])),
      lxcloudEnvAliases: LXCLOUD_ENV_ALIASES,
      lxcloudDbTypePolicy: 'no static allowlist; non-empty values up to 128 characters without control characters',
      lxcloudKnownDbTypes: ['ProcesstestDB', 'ProcessmanageDB', 'HawkDecisionDB', 'CreditmDB', 'PostrealDB', 'StrategypfmDB', 'CreditpfmDB'],
      lxcloudAuthConfigured: Boolean(process.env.LXCLOUD_AUTHORIZATION || process.env.LXCLOUD_BEARER_TOKEN),
      lxcloudBrowserSessionScript: BROWSER_SESSION_SCRIPT,
      lxcloudBrowserSessionScriptExists: fs.existsSync(BROWSER_SESSION_SCRIPT),
    }, null, 2));
    return;
  }

  await runLxcloudQuery(args);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(sanitize(error.stack || error.message));
    process.exit(1);
  });
}

module.exports = {
  LXCLOUD_ENV_BASE_URLS,
  assertReadOnlySql,
  stripSqlLiteralsAndComments,
  buildLxcloudPayload,
  inferLxcloudUserName,
  lxcloudBaseUrl,
  lxcloudEndpoint,
  normalizeLxcloudDbType,
  normalizeLxcloudUserName,
  parseArgs,
  resolveLxcloudEnv,
  userNameFromJwt,
  validateLxcloudDbType,
};
