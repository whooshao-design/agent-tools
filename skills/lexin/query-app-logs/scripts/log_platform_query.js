#!/usr/bin/env node
'use strict';
// Read-only search on the 日志平台 (log.oa.fenqile.com) archLog API through the shared browser session.
// No credential is read or printed here; the browser profile carries the OA login.
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
  resolvePaths,
} = require(path.join(BROWSER_SESSION_DIR, 'browser_session.js'));
const { buildBrowserEnv, chromiumArgsFor } = require(path.join(BROWSER_SESSION_DIR, 'browser_network.js'));

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
const LEVEL_PATTERN = /^\d{4}-\d{2}-\d{2} [\d:.]+\|[^|]*\|[^|]*\|[^|]*\|(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\|/;

const USAGE = `Usage:
  node log_platform_query.js --app <app_name> [--last 1h | --from "2026-09-16 10:00:00" --to "2026-09-16 11:00:00"]
      [--type all|info|error|nginx|dubbo] [--env all|prod|gray|oa|pre]
      [--trace-id <tid>] [--ip <host>] [--service <class>] [--method <name>] [--uid <uid>]
      [--keyword <text>]... [--keyword-mode and|or] [--order desc|asc]
      [--page 1] [--page-size 100] [--max-pages 1] [--max-body 2000] [--output <file.json>] [--user-name <min>]

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
  const env = buildBrowserEnv(PAGE_URL, { ...process.env }).env;
  env.LD_LIBRARY_PATH = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return chromium.launchPersistentContext(paths.profileDir, {
    executablePath: paths.chromePath,
    headless: true,
    env,
    args: chromiumArgsFor(PAGE_URL, ['--no-sandbox']),
  });
}

async function requestJson(context, url, options = {}) {
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
  const json = await requestJson(context, SESSION_URL);
  const rows = (json && json.result_rows) || [];
  const min = rows[0] && rows[0].min;
  if (!min) throw new PlatformError('cannot resolve the OA user from the session endpoint; pass --user-name');
  return min;
}

async function fetchHotDueDay(context) {
  const json = await requestJson(context, PLATFORM_BASE + API.hotDueDay).catch(() => null);
  const days = json && Number(json.data);
  return Number.isFinite(days) && days > 0 ? days : null;
}

async function fetchPage(context, payload) {
  const json = await requestJson(context, PLATFORM_BASE + API.page, { method: 'POST', data: payload });
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

  const paths = resolvePaths(args, PAGE_URL);
  const chromium = loadPlaywright(paths);
  const release = await acquireProfileLock(paths.profileDir, { timeoutMs: 60000 });
  let context;
  const startedAt = Date.now();
  try {
    context = await openContext(paths, chromium);
    query.userName = await resolveUserName(context, args['user-name'] || process.env.LOG_PLATFORM_USER_NAME);
    const hotDueDay = await fetchHotDueDay(context);
    const warnings = [];
    if (hotDueDay && query.from < startedAt - hotDueDay * 86400000) {
      warnings.push(`start time is older than the hot retention (${hotDueDay} days); the platform switches to the cold history table, `
        + 'which was returning "table doesn\'t exist" on 2026-09-16 -- expect an error or an empty result');
    }

    const rows = [];
    const pagesFetched = [];
    let totalNum = null;
    let totalPage = null;
    let cost = '';
    let nextPage = query.page;
    while (true) {
      const result = await fetchPage(context, buildPayload({ ...query, page: nextPage }));
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
      elapsedMs: Date.now() - startedAt,
    };
    if (args.output) {
      const target = expandHome(args.output);
      fs.writeFileSync(target, JSON.stringify({ ...output, rows: rows.map((row) => normalizeRow(row, Number.MAX_SAFE_INTEGER)) }, null, 2));
      output.resultFile = target;
    }
    console.log(JSON.stringify(output, null, 2));
    return 0;
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
