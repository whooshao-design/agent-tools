#!/usr/bin/env node
'use strict';
// Read-only Hive/数仓 query through the 乐信大数据 portal 即席分析 HTTP API.
// Auth comes from the shared get-browser-session profile; no credential is read or printed here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const BROWSER_SESSION_DIR = '/home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts';
const {
  DEFAULT_LOGIN_PATTERN,
  DEFAULT_PORTAL_PATTERN,
  acquireProfileLock,
  classifyRequestSession,
  parseArgs,
  resolvePaths,
} = require(path.join(BROWSER_SESSION_DIR, 'browser_session.js'));
const { buildBrowserEnv, chromiumArgsFor } = require(path.join(BROWSER_SESSION_DIR, 'browser_network.js'));

const PORTAL_BASE = 'https://data.oa.fenqile.com';
const PAGE_URL = `${PORTAL_BASE}/microapps/data/portal/improvisationAnalysis`;
const API = {
  session: '/oa/api/user/session.json',
  folderList: '/oa/data/adhoc/management/folder/list.json',
  fileDetail: '/oa/data/adhoc/management/sql/detail.json',
  fileSave: '/oa/data/adhoc/management/file/saveorupdate.json',
  submit: '/oa/data/adhoc/management/sql/submit.json',
  result: '/oa/data/adhoc/management/sql/instance/getResult.json',
  log: '/oa/data/adhoc/management/sql/instance/log.json',
};
// submit.json refuses to run without a saved sqlId, so every query is written into one
// dedicated file under the user's temp folder instead of creating a new FILE<timestamp> per run.
const TEMP_FOLDER_NAME = '用户临时目录';
const SKILL_FILE_NAME = 'agent-tools-adhoc';
const SKILL_SQL_NAME = 'query';
const ENGINES = { presto: 'Presto', spark: 'Spark' };
const READ_ONLY_KEYWORDS = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN']);
const WRITE_KEYWORD_PATTERN = /\b(insert|update|delete|drop|create|alter|truncate|merge|grant|revoke)\b/i;
const INSTANCE_STATUS = { 0: 'RUNNING', 1: 'SUCCESS', 2: 'FAILED' };

const USAGE = `Usage:
  node hive_query.js --query "<read-only SQL>" [--engine presto|spark] [--timeout 600] [--poll 2]
                     [--max-rows 200] [--output <file.json>] [--user-name <oa-min>] [--folder-id <id>]
  node hive_query.js --query-file <path> [...]
  node hive_query.js --instance <sqlInstanceId> [--timeout 600]   # resume waiting for an earlier submission

Only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN are accepted. Output is JSON on stdout.
Browser profile follows get-browser-session (--profile / BROWSER_SESSION_PROFILE).`;

class PortalError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

function expandHome(value) {
  const text = String(value || '');
  return text.startsWith('~/') ? path.join(os.homedir(), text.slice(2)) : text;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 字符串里的 -- 或 /* 不是注释：用 query-mysql-data 的顺序扫描器（字面量替换成 ''、注释去掉），
// 否则 WITH c AS (SELECT '--' AS x) INSERT ... 会把写语句藏在"注释"后面绕过下面的写关键字检查。
const { stripSqlLiteralsAndComments } = require('/home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly');

function stripSqlComments(sql, engineKey = 'presto') {
  // Presto/Spark：`--` 到行尾都是注释，不像 MySQL 要求后跟空白。
  // Presto 字符串只用 '' 转义、`\` 是普通字符；Spark 的 `\` 才是转义符。按引擎切换，否则字符串边界错位会把注释当 SQL。
  return stripSqlLiteralsAndComments(sql, { dashCommentNeedsSpace: false, backslashEscapes: engineKey === 'spark' });
}

function assertReadOnlySql(rawSql, engineKey = 'presto') {
  const sql = String(rawSql || '').trim().replace(/;+\s*$/, '').trim();
  if (!sql) throw new Error('SQL is empty');
  const stripped = stripSqlComments(sql, engineKey).trim();
  if (!stripped) throw new Error('SQL contains only comments');
  if (stripped.includes(';')) throw new Error('only a single SQL statement is allowed');
  const keyword = (stripped.match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
  if (!READ_ONLY_KEYWORDS.has(keyword)) {
    throw new Error(`only read-only SQL is allowed (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN), got: ${keyword || stripped.slice(0, 20)}`);
  }
  // EXPLAIN ANALYZE 会真正执行语句（Presto 文档明确），带写语句时等于执行写入；普通 EXPLAIN 只出计划。
  if (keyword === 'EXPLAIN' && /^explain\s+analyze\b/i.test(stripped)) {
    throw new Error('EXPLAIN ANALYZE executes the statement and is not allowed in read-only mode; use plain EXPLAIN');
  }
  // Spark accepts "WITH ... INSERT INTO"; SHOW CREATE TABLE / DESCRIBE / plain EXPLAIN never write.
  if (keyword === 'SELECT' || keyword === 'WITH') {
    const write = stripped.match(WRITE_KEYWORD_PATTERN);
    if (write) throw new Error(`write keyword is not allowed in read-only SQL: ${write[1].toUpperCase()}`);
  }
  return sql;
}

function resolveEngine(value) {
  const key = String(value || 'presto').trim().toLowerCase();
  if (!ENGINES[key]) throw new Error(`unsupported engine: ${value} (use presto or spark)`);
  return ENGINES[key];
}

function findTempFolder(folders, folderId) {
  const list = Array.isArray(folders) ? folders : [];
  if (folderId) {
    const folder = list.find((item) => String(item.id) === String(folderId));
    if (!folder) throw new PortalError(`folder id ${folderId} not found in folder list`);
    return folder;
  }
  const folder = list.find((item) => item.name === TEMP_FOLDER_NAME);
  if (!folder) {
    const names = list.map((item) => `${item.id}:${item.name}`).join(', ');
    throw new PortalError(`folder "${TEMP_FOLDER_NAME}" not found; available: ${names || '(none)'}; pass --folder-id`);
  }
  return folder;
}

function findSkillFile(folder) {
  return ((folder && folder.item_list) || [])
    .find((item) => item.name === SKILL_FILE_NAME && Number(item.type) === 3) || null;
}

function buildSavePayload({ userName, folderId, fileId, sqlId, sql, engine }) {
  const entry = { sqlName: SKILL_SQL_NAME, fileType: 2, sql, engine, cluster: '', userName, position: 1 };
  if (sqlId) entry.sqlId = sqlId;
  const payload = { fileType: 3, fileName: SKILL_FILE_NAME, folderId, userName, sqlList: [entry] };
  if (fileId) payload.fileId = fileId;
  return payload;
}

function buildSubmitPayload({ sql, userName, engine, sqlId }) {
  return {
    sql,
    wholeSql: sql,
    userName,
    engine,
    cluster: '',
    sqlName: SKILL_SQL_NAME,
    isSkipCheckSql: false,
    sqlId,
    executeTableName: '',
  };
}

function summarizeInstance(row) {
  const record = row || {};
  const status = Object.prototype.hasOwnProperty.call(INSTANCE_STATUS, Number(record.status))
    ? INSTANCE_STATUS[Number(record.status)]
    : `UNKNOWN_${record.status}`;
  const summary = {
    status,
    progress: record.progress ?? null,
    submitTime: record.submit_time ?? null,
    endTime: record.end_time ?? null,
  };
  if (record.message) summary.message = record.message;
  if (status === 'SUCCESS') {
    const data = record.data || {};
    summary.columns = Array.isArray(data.columns) ? data.columns : [];
    summary.rows = Array.isArray(data.datas) ? data.datas : [];
  }
  return summary;
}

function loadPlaywright(paths) {
  if (!fs.existsSync(paths.playwrightPackage)) throw new Error(`Playwright tool dir not found: ${paths.toolDir}`);
  if (!fs.existsSync(paths.chromePath)) throw new Error(`Chrome not found: ${paths.chromePath}`);
  return createRequire(paths.playwrightPackage)('playwright').chromium;
}

// Direct-only like get-browser-session: proxy variables are stripped and --no-proxy-server is forced.
async function openContext(paths, chromium) {
  const env = buildBrowserEnv(PAGE_URL, { ...process.env }).env;
  env.LD_LIBRARY_PATH = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return chromium.launchPersistentContext(paths.profileDir, {
    executablePath: paths.chromePath,
    headless: true,
    env,
    args: chromiumArgsFor(PAGE_URL, ['--no-sandbox']),
  });
}

async function postJson(context, apiPath, data) {
  const url = PORTAL_BASE + apiPath;
  const response = await context.request.post(url, {
    data,
    headers: { 'content-type': 'application/json' },
    timeout: 60000,
    failOnStatusCode: false,
  });
  const body = await response.text();
  const session = classifyRequestSession({
    status: response.status(),
    url: response.url(),
    body,
    contentType: response.headers()['content-type'] || '',
  }, { targetUrl: url, loginPattern: DEFAULT_LOGIN_PATTERN, portalPattern: DEFAULT_PORTAL_PATTERN });
  if (!session.sessionReady) {
    throw new PortalError(
      `browser session is not ready for ${PORTAL_BASE} (${session.sessionState}, HTTP ${response.status()}); `
      + `run get-browser-session ensure_session with url=${PAGE_URL}`,
      { sessionState: session.sessionState, httpStatus: response.status() },
    );
  }
  let json;
  try {
    json = JSON.parse(body);
  } catch (_) {
    throw new PortalError(`non-JSON response from ${apiPath}`);
  }
  if (String(json.retcode) !== '0') {
    throw new PortalError(`${apiPath} failed: retcode=${json.retcode} retmsg=${json.retmsg || ''}`);
  }
  return Array.isArray(json.result_rows) ? json.result_rows : [];
}

async function resolveUserName(context, override) {
  if (override) return String(override);
  const rows = await postJson(context, API.session, {});
  const min = rows[0] && rows[0].min;
  if (!min) throw new PortalError('cannot resolve the OA user from the portal session; pass --user-name');
  return min;
}

async function ensureSkillFile(context, { userName, folderId, sql, engine }) {
  const folders = await postJson(context, API.folderList, { type: 1, userName });
  const folder = findTempFolder(folders, folderId);
  const existing = findSkillFile(folder);
  let sqlId = null;
  if (existing) {
    const paragraphs = await postJson(context, API.fileDetail, { fileId: existing.id, userName, fileType: 3 });
    sqlId = (paragraphs[0] && paragraphs[0].id) || null;
  }
  const saved = await postJson(context, API.fileSave, buildSavePayload({
    userName,
    folderId: folder.id,
    fileId: existing ? existing.id : null,
    sqlId,
    sql,
    engine,
  }));
  const file = saved[0] || {};
  const entry = (file.sql_list || [])[0] || {};
  if (!entry.sql_id) throw new PortalError('file/saveorupdate did not return sql_id');
  return {
    folderId: folder.id,
    folderName: folder.name,
    fileId: file.file_id || (existing && existing.id) || null,
    fileName: file.file_name || SKILL_FILE_NAME,
    sqlId: entry.sql_id,
    created: !existing,
  };
}

async function submitSql(context, payload) {
  const rows = await postJson(context, API.submit, payload);
  const row = rows[0] || {};
  if (Number(row.result) !== 0 || !row.sql_instance_id) {
    throw new PortalError(`submit rejected: ${row.message || JSON.stringify(row)}`);
  }
  return { sqlInstanceId: row.sql_instance_id, engine: row.engine };
}

async function fetchLogs(context, sqlInstanceId, userName) {
  const rows = await postJson(context, API.log, { sqlInstanceId, userName, time: Date.now() }).catch(() => []);
  return rows
    .map((row) => ({ time: row.oper_time, status: row.status, description: row.description, cost: row.execute_cost }))
    .reverse();
}

async function waitForResult(context, { sqlInstanceId, userName, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const rows = await postJson(context, API.result, { sqlInstanceId, userName, time: Date.now() });
    const summary = summarizeInstance(rows[0]);
    if (summary.status !== 'RUNNING') return summary;
    if (Date.now() >= deadline) return { ...summary, status: 'TIMEOUT' };
    await sleep(pollMs);
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log(USAGE);
    return 0;
  }
  let sql = args.query || (args['query-file'] ? fs.readFileSync(expandHome(args['query-file']), 'utf8') : '');
  const instanceArg = args.instance ? Number(args.instance) : null;
  if (!sql && !instanceArg) {
    console.error(USAGE);
    return 1;
  }
  const engine = resolveEngine(args.engine);
  const timeoutMs = boundedNumber(args.timeout, 600, 5, 3600) * 1000;
  const pollMs = boundedNumber(args.poll, 2, 1, 30) * 1000;
  const maxRows = boundedNumber(args['max-rows'], 200, 1, 100000);
  if (sql) sql = assertReadOnlySql(sql, String(args.engine || 'presto').trim().toLowerCase());

  const paths = resolvePaths(args, PAGE_URL);
  const chromium = loadPlaywright(paths);
  const release = await acquireProfileLock(paths.profileDir, { timeoutMs: 60000 });
  let context;
  const startedAt = Date.now();
  try {
    context = await openContext(paths, chromium);
    const userName = await resolveUserName(context, args['user-name'] || process.env.DATA_PORTAL_USER_NAME);
    const output = { engine, userName };
    let sqlInstanceId = instanceArg;
    if (sql) {
      const file = await ensureSkillFile(context, { userName, folderId: args['folder-id'], sql, engine });
      output.sql = sql;
      output.file = file;
      const submitted = await submitSql(context, buildSubmitPayload({ sql, userName, engine, sqlId: file.sqlId }));
      sqlInstanceId = submitted.sqlInstanceId;
    }
    output.sqlInstanceId = sqlInstanceId;
    const result = await waitForResult(context, { sqlInstanceId, userName, timeoutMs, pollMs });
    output.status = result.status;
    output.elapsedMs = Date.now() - startedAt;
    if (result.status === 'SUCCESS') {
      output.columns = result.columns;
      output.rowCount = result.rows.length;
      output.rows = result.rows.slice(0, maxRows);
      output.truncated = result.rows.length > maxRows;
      if (args.output) {
        const target = expandHome(args.output);
        fs.writeFileSync(target, JSON.stringify({ sql: output.sql, columns: result.columns, rows: result.rows }, null, 2));
        output.resultFile = target;
      }
    } else {
      if (result.message) output.message = result.message;
      if (result.status === 'TIMEOUT') output.hint = `still running on the portal; rerun with --instance ${sqlInstanceId}`;
      output.logs = await fetchLogs(context, sqlInstanceId, userName);
    }
    console.log(JSON.stringify(output, null, 2));
    return output.status === 'SUCCESS' ? 0 : 1;
  } finally {
    if (context) await context.close().catch(() => {});
    release();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error && error.message ? error.message : String(error));
      process.exit(1);
    });
}

module.exports = {
  API,
  INSTANCE_STATUS,
  PAGE_URL,
  SKILL_FILE_NAME,
  TEMP_FOLDER_NAME,
  assertReadOnlySql,
  buildSavePayload,
  buildSubmitPayload,
  findSkillFile,
  findTempFolder,
  resolveEngine,
  stripSqlComments,
  summarizeInstance,
};
