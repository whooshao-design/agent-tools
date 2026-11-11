#!/usr/bin/env node
'use strict';
// agent-tools bootstrap（模板 lib/agent_tools/bootstrap.js，lint 规则六校验逐字一致）
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
// probe 返回 'hit' | 'miss' | <异常码>：与 locate.py 同序先看 install.py（缺失即 miss），再看 skills/；用会抛错的 statSync，不用对一切错误都返回 false 的 existsSync
const probe = (d) => { if (!d) return 'miss'; try { const i = fs.statSync(path.join(d, 'install.py'), { throwIfNoEntry: false }); if (!i || !i.isFile()) return 'miss'; const s = fs.statSync(path.join(d, 'skills'), { throwIfNoEntry: false }); return s && s.isDirectory() ? 'hit' : 'miss'; } catch (e) { return e.code || 'error'; } };
const tried = []; let root = '', r = 'miss';
try { let d = fs.realpathSync(__dirname); tried.push(`上溯起点 ${d}`); while ((r = probe(d)) === 'miss' && path.dirname(d) !== d) d = path.dirname(d); if (r === 'hit') root = d; else tried[0] += r === 'miss' ? ' 未命中有效根（install.py 文件 + skills/ 目录）' : ` ${r}（放弃上溯）`; }
catch (e) { tried.push(`上溯起点 ${__dirname} ${e.code || e.message}`); }
if (!root) { const v = process.env.AGENT_TOOLS_ROOT || ''; r = probe(v); tried.push(`AGENT_TOOLS_ROOT=${v || '<unset>'}${r === 'hit' || r === 'miss' ? '' : ' ' + r}`); if (r === 'hit') root = v; }
if (!root) { const p = path.join(os.homedir(), '.config/agent-tools/root'); try { const v = fs.readFileSync(p, 'utf8').trim(); r = probe(v); tried.push(`${p} = ${v}${r === 'hit' || r === 'miss' ? '' : ' ' + r}`); if (r === 'hit') root = v; } catch (e) { tried.push(`${p} ${e.code === 'ENOENT' ? '<absent>' : e.code}`); } }
if (!root) { console.error(['agent-tools: 未找到仓库根', ...tried, '请在仓库目录运行 python3 install.py'].join('\n')); process.exit(2); }
// agent-tools bootstrap end
// Read-only search on the 架构日志服务 archLog API. Two transports reach the same backend:
//   gateway — OA AI gateway with the lxctl OAuth token (lxctl-gateway skill); no browser needed
//   browser — 日志平台 log.oa.fenqile.com through the shared browser session (get-browser-session)
// No credential is read or printed here.
const { createRequire } = require('module');
const { skillDir } = require(path.join(root, 'lib/agent_tools/locate.js'));

const gateway = require(skillDir('lxctl-gateway', 'scripts', 'lxctl_gateway.js'));
const GATEWAY_PAGE = { path: '/ai/archLog/page', appId: 'arch_log_service' };
const VIA = new Set(['auto', 'gateway', 'browser']);

// The browser transport's modules are loaded only when it is used, so the gateway transport works on a
// machine without Playwright.
let browserModules = null;
function browserDeps() {
  if (!browserModules) {
    const dir = skillDir('get-browser-session', 'scripts');
    browserModules = {
      ...require(path.join(dir, 'browser_session.js')),
      ...require(path.join(dir, 'browser_network.js')),
      sessionCache: require(path.join(dir, 'session_cache.js')),
    };
  }
  return browserModules;
}

const PLATFORM_BASE = 'https://log.oa.fenqile.com';
const PAGE_URL = `${PLATFORM_BASE}/#/dashboard`;
const SESSION_URL = 'https://fql_api.oa.fenqile.com/oa/api/user/session.json?resource_sn=RD_OA';
const API = {
  page: '/api/archLog/page',
  hotDueDay: '/api/archLog/hotDueDay',
};
const LOG_TYPES = { all: 10, info: 0, error: 1, nginx: 2, dubbo: 3 };
const ENVS = { all: '', prod: 'prod', gray: 'gray', oa: 'oa', pre: 'pre' };
const KEYWORD_MODES = { and: 1, or: 2 };
const ORDERS = new Set(['desc', 'asc']);
// The platform renders and accepts Asia/Shanghai wall-clock times regardless of the local machine zone.
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_RANGE_MS = 60 * 60 * 1000;
// Apps differ in how many fields sit between the timestamp and the level: `time|thread|traceId||LEVEL|` or `time|pid|traceId|LEVEL|`.
const LEVEL_PATTERN = /^\d{4}-\d{2}-\d{2} [\d:.]+\|(?:[^|]*\|){2,3}(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\|/;

const USAGE = `Usage:
  node log_platform_query.js --app <app_name> [--last 1h | --from "2026-09-16 10:00:00" --to "2026-09-16 11:00:00"]
      [--type all|info|error|nginx|dubbo] [--env all|prod|gray|oa|pre]
      [--trace-id <tid>] [--ip <host>] [--service <class>] [--method <name>] [--uid <uid>]
      [--keyword <text>]... [--keyword-mode and|or] [--order desc|asc]
      [--page 1] [--page-size 100] [--max-pages 1] [--max-body 2000] [--output <file.json>] [--user-name <min>]
      [--via auto|gateway|browser]

--via auto (default) uses the OA gateway when an lxctl token exists and falls back to the browser session only when
the gateway itself is unusable (not logged in, token rejected, network); a query error is never retried elsewhere.

Times are Asia/Shanghai wall-clock ("YYYY-MM-DD HH:mm[:ss]"), ISO strings or epoch milliseconds.
Default window is the last hour. Output is JSON on stdout; log bodies are truncated to --max-body characters.`;

class PlatformError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

function parseArgs(argv) {
  const args = {};
  const put = (key, value) => {
    if (key === 'keyword') (args.keyword = args.keyword || []).push(String(value));
    else args[key] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq > 2) {
      put(item.slice(2, eq), item.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      put(item.slice(2), next);
      index += 1;
    } else {
      put(item.slice(2), true);
    }
  }
  return args;
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

function pickEnum(table, value, label) {
  const key = String(value || Object.keys(table)[0]).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(table, key)) {
    throw new Error(`unsupported ${label}: ${value} (use ${Object.keys(table).join('|')})`);
  }
  return key;
}

function parseDuration(text) {
  const match = String(text || '').trim().match(/^(\d+)\s*([smhd])$/i);
  if (!match) throw new Error(`invalid duration: ${text} (use e.g. 30m, 2h, 3d)`);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2].toLowerCase()];
  return Number(match[1]) * unit;
}

function parseTime(text, label) {
  const raw = String(text || '').trim();
  if (/^\d{12,}$/.test(raw)) return Number(raw);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?$/);
  if (match) {
    const [, year, month, day, hour = 0, minute = 0, second = 0, milli = 0] = match;
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
      Number(String(milli).padEnd(3, '0'))) - TZ_OFFSET_MS;
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`invalid ${label} time: ${text}`);
}

function formatTime(ms) {
  if (!Number.isFinite(Number(ms))) return null;
  const iso = new Date(Number(ms) + TZ_OFFSET_MS).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`;
}

function resolveRange(args, nowMs = Date.now()) {
  if (args.last) {
    const span = parseDuration(args.last);
    return { from: nowMs - span, to: nowMs };
  }
  const to = args.to ? parseTime(args.to, 'to') : nowMs;
  const from = args.from ? parseTime(args.from, 'from') : to - DEFAULT_RANGE_MS;
  if (from >= to) throw new Error('--from must be earlier than --to');
  return { from, to };
}

function buildPayload(query) {
  const keywords = Array.isArray(query.keywords) ? query.keywords.filter(Boolean) : [];
  return {
    start: query.from,
    end: query.to,
    type: LOG_TYPES[query.type],
    times: [new Date(query.from).toISOString(), new Date(query.to).toISOString()],
    tid: query.traceId || '',
    app: query.app,
    uid: query.uid || '',
    env: ENVS[query.env],
    ip: query.ip || '',
    cls: query.service || '',
    mth: query.method || '',
    keyword: '',
    page: query.page,
    limit: query.pageSize,
    domains: keywords.length ? keywords.map((value) => ({ value })) : [{ value: '' }],
    filters: keywords.map((value) => ({ type: 1, value })),
    filterType: KEYWORD_MODES[query.keywordMode],
    orderType: query.order === 'desc',
    min: query.userName || '',
  };
}

function parseLevel(body) {
  const match = String(body || '').match(LEVEL_PATTERN);
  return match ? match[1] : null;
}

function normalizeRow(row, maxBody) {
  const body = String((row && row.body) || '');
  return {
    time: formatTime(row.time),
    env: row.env || '',
    ip: row.ip || '',
    level: parseLevel(body),
    tid: row.tid || '',
    cls: row.cls || '',
    mth: row.mth || '',
    uid: row.uid || '',
    body: body.length > maxBody ? body.slice(0, maxBody) : body,
    bodyTruncated: body.length > maxBody,
  };
}

// A page can hold fewer rows than `limit`: the platform de-duplicates identical lines inside each page
// ("本页去重后 N 条"), so only totalPage / an empty page mark the end, never a short page.
function shouldFetchNextPage(state) {
  if (state.pagesFetched >= state.maxPages) return false;
  if (state.lastRowCount === 0) return false;
  if (Number.isFinite(state.totalPage) && state.nextPage > state.totalPage) return false;
  return true;
}

function loadPlaywright(paths) {
  if (!fs.existsSync(paths.playwrightPackage)) throw new Error(`Playwright tool dir not found: ${paths.toolDir}`);
  if (!fs.existsSync(paths.chromePath)) throw new Error(`Chrome not found: ${paths.chromePath}`);
  return createRequire(paths.playwrightPackage)('playwright').chromium;
}

// Direct-only like get-browser-session: proxy variables are stripped and --no-proxy-server is forced.
async function openContext(paths, chromium) {
  const { buildBrowserEnv, chromiumArgsFor, launchReadOnlyContext } = browserDeps();
  const env = buildBrowserEnv(PAGE_URL, { ...process.env }).env;
  env.LD_LIBRARY_PATH = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return launchReadOnlyContext(chromium, paths.profileDir, {
    executablePath: paths.chromePath,
    headless: true,
    env,
    args: chromiumArgsFor(PAGE_URL, ['--no-sandbox']),
  });
}

// Calls the API from Node with the cookie snapshot saved by the last successful browser run.
class DirectClient {
  constructor(profileDir) {
    this.profileDir = profileDir;
  }
}

// Calls the same API through the OA gateway with the lxctl token.
class GatewayClient {}

async function requestDirect(client, url, options) {
  const { sessionCache } = browserDeps();
  const cookieHeader = sessionCache.readCookieHeader(client.profileDir, url);
  if (!cookieHeader) throw new PlatformError(`no cached session for ${new URL(url).host}`);
  const result = await sessionCache.fetchWithCookies(cookieHeader, url, {
    method: options.method || 'GET',
    body: options.data ? JSON.stringify(options.data) : undefined,
    headers: options.data ? { 'content-type': 'application/json' } : {},
    timeoutMs: options.timeout || 90000,
    referer: `${PLATFORM_BASE}/`,
  });
  if (sessionCache.looksUnauthenticated(result)) {
    throw new PlatformError(`cached session rejected by ${new URL(url).host} (HTTP ${result.status})`);
  }
  try {
    return JSON.parse(result.text);
  } catch (_) {
    throw new PlatformError(`non-JSON response from ${url}`);
  }
}

async function requestJson(context, url, options = {}) {
  if (context instanceof DirectClient) return requestDirect(context, url, options);
  const { DEFAULT_LOGIN_PATTERN, DEFAULT_PORTAL_PATTERN, classifyRequestSession } = browserDeps();
  const response = await context.request.fetch(url, {
    method: options.method || 'GET',
    data: options.data,
    headers: { accept: 'application/json, text/plain, */*', ...(options.data ? { 'content-type': 'application/json' } : {}) },
    timeout: options.timeout || 90000,
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
    throw new PlatformError(
      `browser session is not ready for ${new URL(url).host} (${session.sessionState}, HTTP ${response.status()}); `
      + `run get-browser-session ensure_session with url=${PAGE_URL}`,
      { sessionState: session.sessionState, httpStatus: response.status() },
    );
  }
  try {
    return JSON.parse(body);
  } catch (_) {
    throw new PlatformError(`non-JSON response from ${url}`);
  }
}

async function resolveUserName(context, override) {
  if (override) return String(override);
  if (context instanceof GatewayClient) return (gateway.readToken() || {}).userMin || ''; // the gateway also derives the user from the token
  const json = await requestJson(context, SESSION_URL);
  const rows = (json && json.result_rows) || [];
  const min = rows[0] && rows[0].min;
  if (!min) throw new PlatformError('cannot resolve the OA user from the session endpoint; pass --user-name');
  return min;
}

async function fetchHotDueDay(context) {
  if (context instanceof GatewayClient) return null; // not exposed on the gateway
  const json = await requestJson(context, PLATFORM_BASE + API.hotDueDay).catch(() => null);
  const days = json && Number(json.data);
  return Number.isFinite(days) && days > 0 ? days : null;
}

async function fetchPage(context, payload) {
  const json = context instanceof GatewayClient
    ? await gateway.callGateway({ method: 'POST', ...GATEWAY_PAGE, body: payload, timeoutMs: 90000 })
    : await requestJson(context, PLATFORM_BASE + API.page, { method: 'POST', data: payload });
  if (Number(json.retcode) !== 0) {
    const detail = String(json.detail || '').trim().split('\n').filter(Boolean)[0] || '';
    throw new PlatformError(`log platform query failed: ${json.retmsg || 'unknown error'}${detail ? ` | ${detail.slice(0, 300)}` : ''}`, {
      retcode: json.retcode,
    });
  }
  return {
    rows: Array.isArray(json.resultRows) ? json.resultRows : [],
    totalNum: Number(json.totalNum),
    totalPage: Number(json.totalPage),
    cost: json.retmsg || '',
  };
}

function buildQuery(args, nowMs = Date.now()) {
  const app = String(args.app || '').trim();
  if (!app) throw new Error('--app is required');
  const range = resolveRange(args, nowMs);
  return {
    app,
    from: range.from,
    to: range.to,
    type: pickEnum(LOG_TYPES, args.type, 'type'),
    env: pickEnum(ENVS, args.env, 'env'),
    traceId: args['trace-id'] ? String(args['trace-id']).trim() : '',
    ip: args.ip ? String(args.ip).trim() : '',
    service: args.service ? String(args.service).trim() : '',
    method: args.method ? String(args.method).trim() : '',
    uid: args.uid ? String(args.uid).trim() : '',
    keywords: (args.keyword || []).map((item) => String(item).trim()).filter(Boolean),
    keywordMode: pickEnum(KEYWORD_MODES, args['keyword-mode'], 'keyword-mode'),
    order: (() => {
      const order = String(args.order || 'desc').toLowerCase();
      if (!ORDERS.has(order)) throw new Error(`unsupported order: ${args.order} (use desc|asc)`);
      return order;
    })(),
    page: boundedNumber(args.page, 1, 1, 100000),
    pageSize: boundedNumber(args['page-size'], 100, 1, 500),
    maxPages: boundedNumber(args['max-pages'], 1, 1, 50),
    maxBody: boundedNumber(args['max-body'], 2000, 200, 200000),
    via: (() => {
      const via = String(args.via || 'auto').toLowerCase();
      if (!VIA.has(via)) throw new Error(`unsupported via: ${args.via} (use auto|gateway|browser)`);
      return via;
    })(),
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log(USAGE);
    return 0;
  }
  let query;
  try {
    query = buildQuery(args);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 1;
  }

  const userNameOverride = args['user-name'] || process.env.LOG_PLATFORM_USER_NAME;
  const startedAt = Date.now();
  let result = null;
  let gatewayNote = '';
  if (query.via !== 'browser' && (query.via === 'gateway' || gateway.readToken())) {
    try {
      result = { ...await collectRows(new GatewayClient(), { ...query }, userNameOverride, startedAt), transport: 'gateway', sessionSource: 'lxctl-token' };
    } catch (error) {
      // Only an unusable gateway falls back; an error from the log service itself (PlatformError) is the answer.
      if (query.via === 'gateway' || !(error instanceof gateway.GatewayError)) throw error;
      gatewayNote = `gateway transport unavailable (${error.code}: ${error.message}); used the browser session instead`;
    }
  }
  if (!result) {
    const paths = browserDeps().resolvePaths(args, PAGE_URL);
    result = await collectWithCachedSession(paths, query, userNameOverride, startedAt)
      || await collectWithBrowser(paths, query, userNameOverride, startedAt);
    result.transport = 'browser';
    if (gatewayNote) result.warnings.unshift(gatewayNote);
  }
  const { rows, pagesFetched, totalNum, totalPage, cost, hotDueDay, warnings, sessionSource, transport } = result;
  const output = {
    app: query.app,
    from: formatTime(query.from),
    to: formatTime(query.to),
    type: query.type,
    env: query.env,
    filters: {
      traceId: query.traceId,
      ip: query.ip,
      service: query.service,
      method: query.method,
      uid: query.uid,
      keywords: query.keywords,
      keywordMode: query.keywordMode,
    },
    order: query.order,
    pageSize: query.pageSize,
    pagesFetched,
    totalNum,
    totalPage,
    hotDueDay,
    rowCount: rows.length,
    rows: rows.map((row) => normalizeRow(row, query.maxBody)),
    warnings,
    cost,
    transport,
    sessionSource,
    elapsedMs: Date.now() - startedAt,
  };
  if (args.output) {
    const target = expandHome(args.output);
    fs.writeFileSync(target, JSON.stringify({ ...output, rows: rows.map((row) => normalizeRow(row, Number.MAX_SAFE_INTEGER)) }, null, 2));
    output.resultFile = target;
  }
  console.log(JSON.stringify(output, null, 2));
  return 0;
}

async function collectRows(client, query, userNameOverride, startedAt) {
  query.userName = await resolveUserName(client, userNameOverride);
  const hotDueDay = await fetchHotDueDay(client);
  const warnings = [];
  if (hotDueDay && query.from < startedAt - hotDueDay * 86400000) {
    warnings.push(`start time is older than the hot retention (${hotDueDay} days); the service reads the history table for that range `
      + '(failed with "table doesn\'t exist" on 2026-09-16, returned rows 120 and 180 days back on 2026-11-11)');
  }

  const rows = [];
  const pagesFetched = [];
  let totalNum = null;
  let totalPage = null;
  let cost = '';
  let nextPage = query.page;
  while (true) {
    const result = await fetchPage(client, buildPayload({ ...query, page: nextPage }));
    pagesFetched.push(nextPage);
    rows.push(...result.rows);
    totalNum = Number.isFinite(result.totalNum) ? result.totalNum : totalNum;
    totalPage = Number.isFinite(result.totalPage) ? result.totalPage : totalPage;
    cost = result.cost;
    nextPage += 1;
    if (!shouldFetchNextPage({ pagesFetched: pagesFetched.length, maxPages: query.maxPages, lastRowCount: result.rows.length, nextPage, totalPage })) break;
  }
  if (Number.isFinite(totalNum) && totalNum > rows.length) {
    warnings.push(`only ${rows.length} of ${totalNum} matching rows were fetched; narrow the window/filters or raise --max-pages`);
  }
  return { rows, pagesFetched, totalNum, totalPage, cost, hotDueDay, warnings };
}

// Cache hit: no Chromium and no profile lock. Any failure (stale cookies or a real API error)
// falls back to the browser path, which reports real errors and refreshes the snapshot.
async function collectWithCachedSession(paths, query, userNameOverride, startedAt) {
  const { sessionCache } = browserDeps();
  if (!sessionCache.readCookieHeader(paths.profileDir, PLATFORM_BASE)) return null;
  try {
    const result = await collectRows(new DirectClient(paths.profileDir), { ...query }, userNameOverride, startedAt);
    return { ...result, sessionSource: 'cache' };
  } catch (_) {
    sessionCache.invalidate(paths.profileDir, PLATFORM_BASE);
    sessionCache.invalidate(paths.profileDir, SESSION_URL);
    return null;
  }
}

async function collectWithBrowser(paths, query, userNameOverride, startedAt) {
  const chromium = loadPlaywright(paths);
  let context;
  try {
    context = await openContext(paths, chromium);
    const { sessionCache } = browserDeps();
    const result = await collectRows(context, query, userNameOverride, startedAt);
    await sessionCache.saveContextCookies(context, paths.profileDir, PLATFORM_BASE);
    await sessionCache.saveContextCookies(context, paths.profileDir, SESSION_URL);
    return { ...result, sessionSource: 'browser' };
  } finally {
    if (context) await context.close().catch(() => {});
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
  GATEWAY_PAGE,
  ENVS,
  KEYWORD_MODES,
  LOG_TYPES,
  PAGE_URL,
  buildPayload,
  buildQuery,
  formatTime,
  normalizeRow,
  parseArgs,
  parseDuration,
  parseLevel,
  parseTime,
  resolveRange,
  shouldFetchNextPage,
};
