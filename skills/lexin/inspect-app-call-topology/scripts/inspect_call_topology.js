#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const { execFile } = require('child_process');

// 只验证过线上。stable/test 域名沿用 inspect-healthy-metrics 的映射，但未实跑，
// 指定时会打印未验证提示。
const BASE_URLS = {
  prod: 'https://healthy.lexincloud.com',
  online: 'https://healthy.lexincloud.com',
  stable: 'https://stable-eye.oa.fenqile.com',
  test: 'https://stable-eye.oa.fenqile.com',
};
const VERIFIED_SITES = new Set(['prod', 'online']);

const DEFAULT_SITE = 'prod';
// 默认不限制环境：gray/oa/pre/prod 全看，需要单看某个环境时才传 --env。
const DEFAULT_ENV = 'all';
const DEFAULT_RANGE = '1d';
const DEFAULT_OUT_DIR = '/home/joney/docs/service-relationships';
const DEFAULT_PROFILE = '/tmp/healthy-metrics-profile';
const DEFAULT_TOOL_DIR = '~/tools/lexiao-browser';
const DEFAULT_CLUSTER = 'Default';
const DEFAULT_LANGUAGE = 'zh';
const DEFAULT_SLOW_MS = 500;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_DRILLDOWN = 8;
// 一批 service 正则的最大字符数，避免 URL 过长被网关截断。
const MAX_REGEX_CHARS = 1500;

// fsof 监控指标后缀。指标名前缀是 app 名把非法字符换成下划线后的结果，
// 所以一律用 {__name__=~".*_<role>_monitor_<suffix>"} + app 标签选择，不要直接拼接 app 名。
const SUFFIX = {
  count: 'acc_count',
  err: 'err_count',
  avg: 'avr_cost_time',
  slow: 'slowest_cost_time',
  ok: 'successrate',
};

// avr_cost_time / slowest_cost_time 的原始单位是微秒，展示前统一除以 1000 转 ms。
// 判定依据：全局 provider avr_cost_time 分布 p50=6490 / p90=76617 / p99=667690 / max=1.83e9，
// 按 ms 解读意味着半数接口平均 6.5 秒、单次最大 21 天，不成立；按 µs 解读是标准同机房 RPC 分布。
// 另有交叉验证：同一次调用消费端 6579、提供端 5831，差值 748µs 正好是网络与序列化开销。
const US_PER_MS = 1000;

const UNIT_SECONDS = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

const PROVIDER_GROUP = ['env', 'service', 'method', 'group', 'version', 'set'];
const CONSUMER_GROUP = ['env', 'service', 'method', 'group', 'version', 'src_set', 'dst_set'];
const CLIENT_GROUP = ['app', 'env', 'service', 'method', 'src_set', 'dst_set'];

function usage() {
  console.log(`Usage:
  inspect_call_topology.js --app=server_strategy_decision_java [options]
  inspect_call_topology.js --service=com.fenqile.xxx.FooService [options]

Options:
  --app             目标应用名（app 标签值，可含连字符）
  --service         只看某个 service；不给 --app 时先反查它属于哪个应用
  --site            prod|online|stable|test，决定 Healthy 域名，默认 prod
  --env             限定 env 标签：prod|gray|pre|oa；默认 all，即四个环境全看
  --range           统计窗口，默认 1d，可传 1h / 3d / 7d 等
  --baseline        与多久之前的同长窗口对比，如 1d / 7d；不给则不做对比
  --slow-ms         平均耗时告警阈值（毫秒），默认 500，可传 0
  --max-drilldown   异常下钻的链路数上限，默认 8，传 0 关闭下钻
  --out-dir         HTML 输出目录，默认 /home/joney/docs/service-relationships
  --out             直接指定 HTML 输出路径，覆盖 --out-dir
  --json            额外把完整结果写到该 JSON 路径
  --no-html         只打印终端摘要，不写 HTML
  --fail-on-anomaly 存在异常条目时以退出码 2 结束
  --concurrency     并发查询数，默认 6
  --http-timeout    单次请求超时毫秒，默认 30000
  --retries         可重试错误的重试次数，默认 2
  --token           Bearer token，也可用环境变量 HEALTHY_METRIC_TOKEN
  --profile         浏览器 profile，默认 /tmp/healthy-metrics-profile
  --base-url        覆盖域名
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq !== -1) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[item.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args[item.slice(2)] = true;
    }
  }
  return args;
}

function expandHome(value) {
  if (!value) return value;
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}

function prometheusDuration(value) {
  const text = String(value || '').trim();
  if (!/^\d+(ms|s|m|h|d|w)?$/.test(text)) throw new Error(`时间长度格式不对: ${value}`);
  return /^\d+$/.test(text) ? `${text}s` : text;
}

function durationSeconds(value) {
  const match = /^(\d+)(ms|s|m|h|d|w)?$/.exec(String(value || '').trim());
  if (!match) throw new Error(`时间长度格式不对: ${value}`);
  return Number(match[1]) * UNIT_SECONDS[match[2] || 's'];
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// 只有显式传入才覆盖默认值，否则 --slow-ms=0 会被 falsy 判断吞掉。
function optionalNumber(raw, fallback) {
  if (raw === undefined || raw === true || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 有序并发：保持输入顺序返回结果，避免并发后 queryLog / 行序不稳定。
async function pMap(items, mapper, concurrency) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- auth

function resolvePaths(args) {
  const toolDir = expandHome(args['tool-dir'] || DEFAULT_TOOL_DIR);
  return {
    toolDir,
    profileDir: expandHome(args.profile || DEFAULT_PROFILE),
    chromePath: expandHome(args.chrome || path.join(toolDir, 'browsers/chrome-linux64/chrome')),
    runtimeLibDir: expandHome(args['runtime-lib-dir'] || path.join(toolDir, 'runtime-libs/usr/lib/x86_64-linux-gnu')),
    playwrightPackage: path.join(toolDir, 'package.json'),
  };
}

async function extractAuthFromProfile(args, baseUrl) {
  const paths = resolvePaths(args);
  if (!fs.existsSync(paths.playwrightPackage)) {
    throw new Error(`Playwright tool dir not found: ${paths.toolDir}`);
  }
  const chromium = createRequire(paths.playwrightPackage)('playwright').chromium;
  const ldLibraryPath = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const context = await chromium.launchPersistentContext(paths.profileDir, {
    executablePath: paths.chromePath,
    headless: true,
    env: { ...process.env, LD_LIBRARY_PATH: ldLibraryPath },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(args['auth-url'] || `${baseUrl}/sys-manage/metric-manage`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const auth = await page.evaluate(() => {
      const keys = Object.keys(localStorage);
      const tokenKey = keys.find((k) => /access.?token|token/i.test(k) && localStorage.getItem(k));
      const ticketKey = keys.find((k) => /ticket/i.test(k) && localStorage.getItem(k));
      return {
        token: tokenKey ? localStorage.getItem(tokenKey) : '',
        ticket: ticketKey ? localStorage.getItem(ticketKey) : '',
        title: document.title,
      };
    });
    if (!auth.token) throw new Error(`profile 中没有 access token，请先用 get-browser-session 登录。page=${auth.title}`);
    return { token: auth.token, ticket: auth.ticket || '' };
  } finally {
    await context.close().catch(() => {});
  }
}

async function resolveAuth(args, baseUrl) {
  const token = args.token || process.env.HEALTHY_METRIC_TOKEN;
  if (token) return { token, ticket: args.ticket || '' };
  return extractAuthFromProfile(args, baseUrl);
}

// ---------------------------------------------------------------- prometheus

function redactUrl(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

class RetryableError extends Error {}

// 超时 + 重试的公共外壳。Prometheus 与 bianque 是不同域名、不同认证，共用这一层。
async function fetchWithRetry(ctx, url, options) {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.httpTimeout);
    try {
      const response = await fetch(url, { ...options, redirect: 'follow', signal: controller.signal });
      const text = await response.text();
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableError(`HTTP ${response.status}: ${text.slice(0, 160)}`);
      }
      return { status: response.status, text };
    } catch (error) {
      // 超时被 AbortController 转成 AbortError，和网络抖动一样值得重试。
      const retryable = error instanceof RetryableError
        || error.name === 'AbortError'
        || error.name === 'TypeError';
      if (!retryable || attempt >= ctx.retries) {
        if (error.name === 'AbortError') {
          throw new Error(`请求超时（${ctx.httpTimeout}ms，已重试 ${attempt} 次）: ${redactUrl(url)}`);
        }
        throw error;
      }
      await delay(300 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

async function requestJson(ctx, url) {
  const { status, text } = await fetchWithRetry(ctx, url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'x-cluster': ctx.cluster,
      'x-language': ctx.language,
      ...(ctx.auth.token ? { authorization: `Bearer ${ctx.auth.token}` } : {}),
      ...(ctx.auth.ticket ? { ticket: ctx.auth.ticket } : {}),
    },
  });
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`POST ${redactUrl(url)} 返回非 JSON status=${status}: ${text.slice(0, 200)}`);
  }
}

async function promQuery(ctx, label, query) {
  const url = new URL('/api/n9e/prometheus/api/v1/query', ctx.baseUrl);
  url.searchParams.set('query', query);
  const json = await requestJson(ctx, url.toString());
  if (json.status !== 'success') {
    throw new Error(`PromQL 失败 [${label}] status=${json.status || ''} error=${json.error || ''}`);
  }
  ctx.queryLog.push({ label, query });
  return json.data && json.data.result ? json.data.result : [];
}

async function promRange(ctx, label, query, start, end, step) {
  const url = new URL('/api/n9e/prometheus/api/v1/query_range', ctx.baseUrl);
  url.searchParams.set('query', query);
  url.searchParams.set('start', String(start));
  url.searchParams.set('end', String(end));
  url.searchParams.set('step', String(step));
  const json = await requestJson(ctx, url.toString());
  if (json.status !== 'success') {
    throw new Error(`PromQL range 失败 [${label}] status=${json.status || ''} error=${json.error || ''}`);
  }
  ctx.queryLog.push({ label, query: `${query}   [range step=${step}s]` });
  return json.data && json.data.result ? json.data.result : [];
}

// 正则元字符要转义两次：PromQL 的标签值是双引号字符串字面量，
// 字面量里的 \. 是非法转义，必须写成 \\. 才能让正则引擎收到 \. 。
function escapeRe(text) {
  return String(text).replace(/[.+*?()|[\]{}^$\\]/g, '\\\\$&');
}

function labelEq(name, value) {
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${name}="${escaped}"`;
}

function selector(role, suffix, filters) {
  const parts = [`__name__=~".*_${role}_monitor_${suffix}"`].concat(filters.filter(Boolean));
  return `{${parts.join(',')}}`;
}

// 窗口选择器。offset 用于基线对比，直接落在 range selector 上。
function window(sel, range, offset) {
  return offset ? `${sel}[${range}] offset ${offset}` : `${sel}[${range}]`;
}

// 按正则总长度分批，而不是固定条数：service 全限定名长度差异很大。
function batchServices(services) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const service of services) {
    const cost = escapeRe(service).length + 1;
    if (current.length && size + cost > MAX_REGEX_CHARS) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(service);
    size += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

// group-by 标签拼 key 的分隔符：标签值理论上可以含空格，用空格拼会撞车。
// 用转义写法而不是字面控制字符，避免源文件被 grep 之类当成二进制。
const KEY_SEP = '\u001f';

function mergeSeries(target, result, field, groupKeys) {
  for (const series of result) {
    const metric = series.metric || {};
    const key = groupKeys.map((k) => metric[k] || '').join(KEY_SEP);
    if (!target.has(key)) {
      const row = {};
      for (const k of groupKeys) row[k] = metric[k] || '';
      target.set(key, row);
    }
    target.get(key)[field] = num(series.value && series.value[1]);
  }
}

function rowKey(row, groupKeys) {
  return groupKeys.map((k) => row[k] || '').join(KEY_SEP);
}

// minOk 缺省必须是 null 而不是 100：全局有少量接口只上报 acc_count 不上报 successrate，
// 默认成 100 会把"没有数据"渲染成"成功率 100%"的绿色正常态。
function normalizeRows(rows, groupKeys) {
  return [...rows.values()]
    .map((row) => ({
      count: 0, err: 0, avgCost: 0, slowCost: 0, minOk: null, ...row,
    }))
    .sort((a, b) => b.count - a.count || rowKey(a, groupKeys).localeCompare(rowKey(b, groupKeys)));
}

async function collectMetrics(ctx, role, filters, groupKeys, labelPrefix, offset) {
  const by = `(${groupKeys.join(',')})`;
  const w = (suffix) => window(selector(role, suffix, filters), ctx.range, offset);
  const plans = [
    ['count', `sum(sum_over_time(${w(SUFFIX.count)})) by ${by}`],
    ['err', `sum(sum_over_time(${w(SUFFIX.err)})) by ${by}`],
    ['avgCost', `(avg(avg_over_time(${w(SUFFIX.avg)})) by ${by}) / ${US_PER_MS}`],
    ['slowCost', `(max(max_over_time(${w(SUFFIX.slow)})) by ${by}) / ${US_PER_MS}`],
    ['minOk', `min(min_over_time(${w(SUFFIX.ok)})) by ${by}`],
  ];
  const results = await pMap(
    plans,
    ([field, query]) => promQuery(ctx, `${labelPrefix}.${field}`, query),
    ctx.concurrency,
  );
  const rows = new Map();
  plans.forEach(([field], index) => mergeSeries(rows, results[index], field, groupKeys));
  return normalizeRows(rows, groupKeys);
}

// service -> 提供它的应用。service 归属与 env 无关，这里刻意不加 env 过滤，
// 避免漏掉只在部分环境上报 provider 指标的应用。
async function resolveServiceOwners(ctx, services) {
  const batches = batchServices(services);
  const results = await pMap(batches, (batch) => {
    const re = batch.map(escapeRe).join('|');
    return promQuery(ctx, 'downstream.owner', `count(${selector('provider', SUFFIX.count, [`service=~"${re}"`])}) by (app,service)`);
  }, ctx.concurrency);
  const owners = new Map();
  for (const result of results) {
    for (const series of result) {
      const metric = series.metric || {};
      if (!metric.app || !metric.service) continue;
      if (!owners.has(metric.service)) owners.set(metric.service, new Set());
      owners.get(metric.service).add(metric.app);
    }
  }
  return owners;
}

// 指标只覆盖窗口内有流量的 provider，零流量或未接指标的服务查不到归属。
// 这类服务兜底问 Dubbo/FSOF 注册中心（query-dubbo-registry skill），拿不到就保持"未知应用"，
// 绝不让整个报告因为兜底失败而中断。
const REGISTRY_SCRIPT = '/home/joney/projects/ai/agent-tools/skills/lexin/query-dubbo-registry/scripts/query_dubbo_registry.js';

function runRegistry(services, site, timeoutMs) {
  return new Promise((resolve) => {
    if (!fs.existsSync(REGISTRY_SCRIPT)) {
      resolve({ ok: false, reason: '未安装 query-dubbo-registry skill' });
      return;
    }
    execFile(
      process.execPath,
      [REGISTRY_SCRIPT, `--services=${services.join(',')}`, '--format=json', `--site=${site}`],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, reason: (stderr || error.message || '').trim().split('\n').pop() || '调用失败' });
          return;
        }
        try {
          resolve({ ok: true, ownerMap: JSON.parse(stdout).ownerMap || {} });
        } catch (parseError) {
          resolve({ ok: false, reason: '注册中心返回无法解析' });
        }
      },
    );
  });
}

async function fillOwnersFromRegistry(ctx, ownerOf, services) {
  const missing = services.filter((s) => !ownerOf.has(s));
  if (!missing.length) return { used: false, filled: [], missing: [] };
  const result = await runRegistry(missing, ctx.registrySite, ctx.httpTimeout * 2);
  if (!result.ok) {
    console.log(`提示: ${missing.length} 个 service 的归属指标里查不到，注册中心兜底也没成功（${result.reason}），这些会显示为“未知应用”。`);
    return { used: false, filled: [], missing, reason: result.reason };
  }
  const filled = [];
  for (const service of missing) {
    const apps = result.ownerMap[service] || [];
    if (!apps.length) continue;
    ownerOf.set(service, new Set(apps));
    filled.push(service);
  }
  return { used: true, filled, missing: missing.filter((s) => !filled.includes(s)) };
}

// 谁在调这些 service：consumer 侧按 service 反查，app 标签就是客户端应用名。
async function resolveClients(ctx, services, envFilter, offset) {
  const by = `(${CLIENT_GROUP.join(',')})`;
  const batches = batchServices(services);
  const jobs = [];
  for (const batch of batches) {
    const re = batch.map(escapeRe).join('|');
    const filters = [`service=~"${re}"`, envFilter];
    const w = (suffix) => window(selector('consumer', suffix, filters), ctx.range, offset);
    jobs.push(
      ['count', `sum(sum_over_time(${w(SUFFIX.count)})) by ${by}`],
      ['err', `sum(sum_over_time(${w(SUFFIX.err)})) by ${by}`],
      ['avgCost', `(avg(avg_over_time(${w(SUFFIX.avg)})) by ${by}) / ${US_PER_MS}`],
      ['slowCost', `(max(max_over_time(${w(SUFFIX.slow)})) by ${by}) / ${US_PER_MS}`],
      ['minOk', `min(min_over_time(${w(SUFFIX.ok)})) by ${by}`],
    );
  }
  const results = await pMap(jobs, ([field, query]) => promQuery(ctx, `upstream.${field}`, query), ctx.concurrency);
  const rows = new Map();
  jobs.forEach(([field], index) => mergeSeries(rows, results[index], field, CLIENT_GROUP));
  return normalizeRows(rows, CLIENT_GROUP);
}

// ---------------------------------------------------------------- 异常判定

function isBad(row) {
  return num(row.err) > 0 || (row.minOk !== null && num(row.minOk) < 100);
}

function healthClass(row, slowMs) {
  if (isBad(row)) return 'bad';
  if (num(row.avgCost) > slowMs) return 'warn';
  return 'ok';
}

// ---------------------------------------------------------------- 异常下钻

// 时间桶宽度直接决定"错误发生在什么时候"的可用精度，不能按窗口比例缩放：
// 7d 按 1/240 算出来是 42 分钟一个桶，排查时等于没定位。
// 错误时间线只有一条聚合 series，点数便宜，固定给到分钟级即可（7d 也才 2016 个点）。
function drilldownStep(windowSec) {
  if (windowSec <= 6 * 3600) return 60;
  if (windowSec <= 2 * 86400) return 120;
  return 300;
}

async function drilldownLink(ctx, link) {
  const filters = [
    labelEq('app', link.app),
    labelEq('service', link.service),
    labelEq('method', link.method),
    link.env ? labelEq('env', link.env) : '',
  ];
  const w = (suffix) => window(selector(link.role, suffix, filters), ctx.range, '');
  const by = '(ident,origins)';

  const [countRes, errRes, okRes] = await pMap([
    ['count', `sum(sum_over_time(${w(SUFFIX.count)})) by ${by}`],
    ['err', `sum(sum_over_time(${w(SUFFIX.err)})) by ${by}`],
    ['minOk', `min(min_over_time(${w(SUFFIX.ok)})) by ${by}`],
  ], ([field, query]) => promQuery(ctx, `drilldown.${field}`, query), ctx.concurrency);

  const instances = new Map();
  mergeSeries(instances, countRes, 'count', ['ident', 'origins']);
  mergeSeries(instances, errRes, 'err', ['ident', 'origins']);
  mergeSeries(instances, okRes, 'minOk', ['ident', 'origins']);

  // 时间线必须用 sum_over_time 按 step 求和，不能裸采样：
  // 实测同一批错误 sum_over_time([7d]) 得到 3 次，而 query_range step=300 裸采样只看到 2 次。
  const step = drilldownStep(ctx.windowSec);
  const end = ctx.now;
  const start = end - ctx.windowSec;
  const timelineRes = await promRange(
    ctx, 'drilldown.timeline',
    `sum(sum_over_time(${selector(link.role, SUFFIX.err, filters)}[${step}s]))`,
    start, end, step,
  );
  const timeline = [];
  for (const series of timelineRes) {
    for (const [ts, value] of series.values || []) {
      if (num(value) > 0) timeline.push({ ts: Number(ts), err: num(value) });
    }
  }
  timeline.sort((a, b) => a.ts - b.ts);

  // 实例动辄几十台，表格只留异常的；但合计必须用全量算，否则一致性校验会失真。
  const allInstances = normalizeRows(instances, ['ident', 'origins']).filter((r) => r.count > 0 || r.err > 0);
  return {
    ...link,
    step,
    instanceTotal: allInstances.length,
    instErrTotal: allInstances.reduce((sum, r) => sum + num(r.err), 0),
    instances: allInstances.filter(isBad),
    timeline,
  };
}

async function runDrilldown(ctx, links) {
  if (!links.length) return [];
  // 下钻本身按链路并发，但每条链路内部已经有 3~4 个查询，这里降一档避免打爆网关。
  return pMap(links, (link) => drilldownLink(ctx, link), Math.max(1, Math.ceil(ctx.concurrency / 2)));
}

// ---------------------------------------------------------------- html

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtInt(value) {
  return Math.round(num(value)).toLocaleString('en-US');
}

// 入参已是 ms。亚毫秒接口不少，固定 1 位小数会全被压成 0.1，按量级给精度。
function fmtMs(value) {
  const parsed = num(value);
  if (!parsed) return '-';
  const digits = parsed < 1 ? 3 : parsed < 10 ? 2 : 1;
  return `${parsed.toFixed(digits)} ms`;
}

function fmtPct(value) {
  if (value === null || value === undefined) return '无数据';
  return `${num(value).toFixed(2)}%`;
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDelta(current, base, formatter) {
  if (base === null || base === undefined) return '-';
  const diff = num(current) - num(base);
  if (!diff) return '持平';
  const sign = diff > 0 ? '+' : '-';
  const cls = diff > 0 ? 'up' : 'down';
  const pct = num(base) ? ` (${diff > 0 ? '+' : ''}${((diff / num(base)) * 100).toFixed(0)}%)` : '';
  return `<span class="delta ${cls}">${sign}${formatter(Math.abs(diff))}${pct}</span>`;
}

function shortService(service) {
  const parts = String(service).split('.');
  return parts.length > 1 ? parts[parts.length - 1] : service;
}

const OWNER_SEP = ' | ';

// 同一个 service 可能由多个应用同时提供（分机构、分环境独立部署），
// 而 consumer 指标只有 service/method/dst_set，判定不了这次调用落到哪个提供方。
// 这类链路按"候选提供方"展示，不假装能归到某一个应用。
function ownerLabel(joined) {
  const list = String(joined).split(OWNER_SEP);
  return list.length > 1 ? `${list[0]} 等 ${list.length} 个候选` : list[0];
}

function isMultiOwner(joined) {
  return String(joined).includes(OWNER_SEP);
}

function groupByApp(rows, appKey) {
  const map = new Map();
  for (const row of rows) {
    const app = row[appKey] || '(unknown)';
    if (!map.has(app)) map.set(app, { app, count: 0, err: 0, minOk: null, links: [] });
    const entry = map.get(app);
    entry.count += num(row.count);
    entry.err += num(row.err);
    if (row.minOk !== null) entry.minOk = entry.minOk === null ? num(row.minOk) : Math.min(entry.minOk, num(row.minOk));
    entry.links.push(row);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function renderTopology(app, upstreamApps, downstreamApps, selfCall) {
  const rowH = 64;
  const boxW = 300;
  const boxH = 44;
  const colX = { left: 20, mid: 460, right: 900 };
  const width = 1220;
  const maxRows = Math.max(upstreamApps.length, downstreamApps.length, 1);
  const height = Math.max(maxRows * rowH + 130, 250);
  const midY = height / 2 - boxH / 2;
  const yOf = (index, total) => (height - total * rowH + rowH - boxH) / 2 + index * rowH;

  const parts = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="调用拓扑">`);
  parts.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>');
  parts.push(`<text x="${colX.left}" y="26" class="svg-col">上游客户端 (${upstreamApps.length})</text>`);
  parts.push(`<text x="${colX.mid}" y="26" class="svg-col">本应用</text>`);
  parts.push(`<text x="${colX.right}" y="26" class="svg-col">下游服务方 (${downstreamApps.length})</text>`);

  // 所有边都从本应用这一侧的同一个点扇出，标签放中点会在垂直方向叠在一起。
  // 改成沿曲线取 t 处的实际坐标：t 偏向节点多的那一侧，标签就跟着节点散开。
  const bezierAt = (t, a, c1, c2, b) => {
    const u = 1 - t;
    return u * u * u * a + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * b;
  };

  const edge = (x1, y1, x2, y2, entry, t) => {
    const cls = isBad(entry) ? 'edge bad' : 'edge';
    const mx = (x1 + x2) / 2;
    const detail = entry.links.slice(0, 12)
      .map((l) => `${shortService(l.service)}#${l.method}  ${fmtInt(l.count)}`).join('\n');
    const more = entry.links.length > 12 ? `\n… 其余 ${entry.links.length - 12} 个接口` : '';
    const lx = bezierAt(t, x1, mx, mx, x2);
    const ly = bezierAt(t, y1, y1, y2, y2);
    return `<g class="${cls}"><title>${esc(String(entry.app).split(OWNER_SEP).join('\n'))}\n${esc(detail)}${esc(more)}</title>`
      + `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" marker-end="url(#arrow)"/>`
      + `<text x="${lx.toFixed(1)}" y="${(ly - 7).toFixed(1)}" class="svg-edge-label">${fmtInt(entry.count)}${entry.err > 0 ? ` / 错 ${fmtInt(entry.err)}` : ''}</text>`
      + '</g>';
  };

  upstreamApps.forEach((entry, index) => {
    const y = yOf(index, upstreamApps.length);
    parts.push(edge(colX.left + boxW, y + boxH / 2, colX.mid, midY + boxH / 2, entry, 0.24));
  });
  downstreamApps.forEach((entry, index) => {
    const y = yOf(index, downstreamApps.length);
    parts.push(edge(colX.mid + boxW, midY + boxH / 2, colX.right, y + boxH / 2, entry, 0.76));
  });

  const box = (x, y, entry, cls) => `<g class="node ${cls}"><title>${esc(String(entry.app).split(OWNER_SEP).join('\n'))}</title>`
    + `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="8"/>`
    + `<text x="${x + 12}" y="${y + 20}" class="svg-app">${esc(ownerLabel(entry.app))}</text>`
    + `<text x="${x + 12}" y="${y + 35}" class="svg-sub">调用 ${fmtInt(entry.count)}${entry.err > 0 ? ` · 错误 ${fmtInt(entry.err)}` : ''} · 最低成功率 ${fmtPct(entry.minOk)}</text></g>`;

  upstreamApps.forEach((entry, index) => {
    parts.push(box(colX.left, yOf(index, upstreamApps.length), entry, isBad(entry) ? 'bad' : 'up'));
  });
  downstreamApps.forEach((entry, index) => {
    parts.push(box(colX.right, yOf(index, downstreamApps.length), entry, isBad(entry) ? 'bad' : 'down'));
  });
  parts.push(`<g class="node self"><rect x="${colX.mid}" y="${midY}" width="${boxW}" height="${boxH}" rx="8"/>`
    + `<text x="${colX.mid + 12}" y="${midY + 27}" class="svg-app">${esc(app)}</text></g>`);

  if (selfCall) {
    const cx = colX.mid + boxW / 2;
    parts.push('<g class="edge self-loop"><title>自调用</title>'
      + `<path d="M${cx - 40},${midY + boxH} C${cx - 90},${midY + boxH + 62} ${cx + 90},${midY + boxH + 62} ${cx + 40},${midY + boxH + 2}" marker-end="url(#arrow)"/>`
      + `<text x="${cx}" y="${midY + boxH + 78}" class="svg-edge-label">自调用 ${fmtInt(selfCall.count)}</text></g>`);
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function renderTable(caption, columns, rows, slowMs) {
  if (!rows.length) return `<h3>${esc(caption)}</h3><p class="empty">窗口内没有数据。</p>`;
  const head = columns.map((c) => `<th${c.numeric ? ' class="n"' : ''}>${esc(c.title)}</th>`).join('');
  const body = rows.map((row) => {
    const cells = columns.map((c) => {
      const value = c.render ? c.render(row) : esc(row[c.key]);
      return `<td${c.numeric ? ' class="n"' : ''}>${value}</td>`;
    }).join('');
    return `<tr class="${healthClass(row, slowMs)}">${cells}</tr>`;
  }).join('\n');
  return `<h3>${esc(caption)} <span class="muted">(${rows.length} 条)</span></h3>`
    + `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderDrilldown(drilldown, slowMs) {
  if (!drilldown.length) return '';
  const blocks = drilldown.map((link) => {
    const instCols = [
      { title: '实例 IP', key: 'ident' },
      { title: '来源', key: 'origins' },
      { title: '调用量', numeric: true, render: (r) => fmtInt(r.count) },
      { title: '错误数', numeric: true, render: (r) => fmtInt(r.err) },
      { title: '最低成功率', numeric: true, render: (r) => fmtPct(r.minOk) },
    ];
    const bad = link.instances;
    // 下钻的过滤条件比链路行宽（不带 group/version/src_set/dst_set），实例合计应当 >= 链路错误数。
    // 一旦小于，说明有实例的指标没被采到，必须让人看见，不能默默给个偏小的数。
    const mismatch = num(link.instErrTotal) < num(link.err)
      ? `　注意：实例错误合计 ${fmtInt(link.instErrTotal)} 小于链路错误数 ${fmtInt(link.err)}，有实例的指标没采到，下面的实例分布不完整。`
      : '';
    const hint = (bad.length
      ? `错误集中在 ${bad.length} / ${link.instanceTotal} 个实例：${bad.map((r) => r.ident).join('、')}`
      : '所有实例都没有错误，异常可能已随实例下线或重启消失。') + mismatch;
    const timeline = link.timeline.length
      ? `<div class="timeline">${link.timeline.slice(0, 40).map((p) => `<span class="tl"><b>${esc(fmtTime(p.ts))}</b> 错 ${fmtInt(p.err)}</span>`).join('')}`
        + `${link.timeline.length > 40 ? `<span class="tl muted">… 其余 ${link.timeline.length - 40} 个时间点</span>` : ''}</div>`
      : '<p class="empty">时间线上没有采到错误点（错误可能落在采集间隙）。</p>';
    return `<h3>[${esc(link.role === 'provider' ? '入口' : '出口')}] ${esc(link.app)} · <code>${esc(shortService(link.service))}#${esc(link.method)}</code>`
      + ` <span class="muted">env=${esc(link.env || 'all')} · 错误 ${fmtInt(link.err)}</span></h3>`
      + `<p class="hint">${esc(hint)}</p>`
      + renderTable(`异常实例（共 ${link.instanceTotal} 个实例，只列异常的）`, instCols, link.instances, slowMs)
      + `<h3 class="sub-h">错误发生时间点 <span class="muted">(按 ${link.step}s 聚合)</span></h3>${timeline}`;
  });
  return `<h2>异常下钻</h2><div class="note">下钻只针对错误数 &gt;0 或成功率 &lt;100% 的链路，按错误数排序取前 ${drilldown.length} 条。定位到实例后可接 <code>query-app-instances</code> 和 <code>java-server-diagnostics</code> 看日志。</div>${blocks.join('')}`;
}

function renderBaseline(baseline, slowMs) {
  if (!baseline) return '';
  const { label, added, removed, changed } = baseline;
  const keyCell = (r) => `<code>${esc(shortService(r.service))}#${esc(r.method)}</code>`;
  const sideCell = (r) => esc(r.side === 'provider' ? '对外提供' : '下游依赖');

  const addedCols = [
    { title: '方向', render: sideCell },
    { title: '接口', render: keyCell },
    { title: 'env', key: 'env' },
    { title: '当前调用量', numeric: true, render: (r) => fmtInt(r.count) },
  ];
  const removedCols = [
    { title: '方向', render: sideCell },
    { title: '接口', render: keyCell },
    { title: 'env', key: 'env' },
    { title: '基线调用量', numeric: true, render: (r) => fmtInt(r.baseCount) },
  ];
  const changedCols = [
    { title: '方向', render: sideCell },
    { title: '接口', render: keyCell },
    { title: 'env', key: 'env' },
    { title: '当前调用量', numeric: true, render: (r) => fmtInt(r.count) },
    { title: '调用量变化', numeric: true, render: (r) => fmtDelta(r.count, r.baseCount, fmtInt) },
    { title: '当前平均耗时', numeric: true, render: (r) => fmtMs(r.avgCost) },
    { title: '耗时变化', numeric: true, render: (r) => fmtDelta(r.avgCost, r.baseAvgCost, (v) => fmtMs(v)) },
    { title: '当前错误数', numeric: true, render: (r) => fmtInt(r.err) },
  ];

  return `<h2>对比基线</h2>`
    + `<div class="note">当前窗口 vs <b>${esc(label)}</b> 之前的同长窗口。用于判断发布前后接口是否新增、消失、量变或劣化。</div>`
    + renderTable('新增接口（基线窗口没有流量）', addedCols, added, slowMs)
    + renderTable('消失接口（当前窗口没有流量）', removedCols, removed, slowMs)
    + renderTable('变化最大的接口', changedCols, changed, slowMs);
}

function buildHtml(model) {
  const {
    app, site, baseUrl, env, range, baselineLabel, slowMs, generatedAt,
    provider, consumer, clients, ownerOf, registryFilled, stats, drilldown, baseline, queryLog,
  } = model;

  const upstreamApps = groupByApp(clients, 'app');
  const selfEntry = upstreamApps.find((e) => e.app === app);
  const downstreamRows = consumer.map((row) => ({
    ...row,
    ownerApp: [...(ownerOf.get(row.service) || ['(未知应用)'])].sort().join(OWNER_SEP),
  }));
  const downstreamApps = groupByApp(downstreamRows, 'ownerApp');

  const badge = (row) => {
    const cls = healthClass(row, slowMs);
    const text = cls === 'bad' ? '异常' : cls === 'warn' ? '偏慢' : '正常';
    return `<span class="badge ${cls}">${text}</span>`;
  };
  const chainCell = (from, via, to) => `<span class="chain"><b>${esc(from)}</b> → <code>${esc(via)}</code> → <b>${esc(to)}</b></span>`;

  const clientCols = [
    { title: '状态', render: badge },
    { title: '客户端应用', render: (r) => `<b>${esc(r.app)}</b>${r.app === app ? ' <span class="tag">自调用</span>' : ''}` },
    { title: '调用链路', render: (r) => chainCell(r.app, `${shortService(r.service)}#${r.method}`, app) },
    { title: 'service', render: (r) => `<code>${esc(r.service)}</code>` },
    { title: 'method', key: 'method' },
    { title: 'env', key: 'env' },
    { title: 'src_set → dst_set', render: (r) => esc(`${r.src_set || '-'} → ${r.dst_set || '-'}`) },
    { title: '调用量', numeric: true, render: (r) => fmtInt(r.count) },
    { title: '错误数', numeric: true, render: (r) => fmtInt(r.err) },
    { title: '最低成功率', numeric: true, render: (r) => fmtPct(r.minOk) },
    { title: '平均耗时', numeric: true, render: (r) => fmtMs(r.avgCost) },
    { title: '最慢耗时', numeric: true, render: (r) => fmtMs(r.slowCost) },
  ];

  const providerCols = [
    { title: '状态', render: badge },
    { title: 'service', render: (r) => `<code>${esc(r.service)}</code>` },
    { title: 'method', key: 'method' },
    { title: 'version', key: 'version' },
    { title: 'group', key: 'group' },
    { title: 'env', key: 'env' },
    { title: 'set', key: 'set' },
    { title: '调用量', numeric: true, render: (r) => fmtInt(r.count) },
    { title: '错误数', numeric: true, render: (r) => fmtInt(r.err) },
    { title: '最低成功率', numeric: true, render: (r) => fmtPct(r.minOk) },
    { title: '平均耗时', numeric: true, render: (r) => fmtMs(r.avgCost) },
    { title: '最慢耗时', numeric: true, render: (r) => fmtMs(r.slowCost) },
  ];

  const downstreamCols = [
    { title: '状态', render: badge },
    {
      title: '下游应用',
      render: (r) => `<b title="${esc(String(r.ownerApp).split(OWNER_SEP).join(' / '))}">${esc(ownerLabel(r.ownerApp))}</b>`
        + (r.ownerApp === app ? ' <span class="tag">自调用</span>' : '')
        + (isMultiOwner(r.ownerApp) ? ' <span class="tag">多候选</span>' : '')
        + (registryFilled && registryFilled.has(r.service) ? ' <span class="tag">注册中心</span>' : ''),
    },
    { title: '调用链路', render: (r) => chainCell(app, `${shortService(r.service)}#${r.method}`, ownerLabel(r.ownerApp)) },
    { title: 'service', render: (r) => `<code>${esc(r.service)}</code>` },
    { title: 'method', key: 'method' },
    { title: 'version', key: 'version' },
    { title: 'env', key: 'env' },
    { title: 'src_set → dst_set', render: (r) => esc(`${r.src_set || '-'} → ${r.dst_set || '-'}`) },
    { title: '调用量', numeric: true, render: (r) => fmtInt(r.count) },
    { title: '错误数', numeric: true, render: (r) => fmtInt(r.err) },
    { title: '最低成功率', numeric: true, render: (r) => fmtPct(r.minOk) },
    { title: '平均耗时', numeric: true, render: (r) => fmtMs(r.avgCost) },
    { title: '最慢耗时', numeric: true, render: (r) => fmtMs(r.slowCost) },
  ];

  const jsonModel = buildJsonModel(model, downstreamRows);
  const card = (label, value, note) => `<div class="card"><div class="card-v">${esc(value)}</div><div class="card-l">${esc(label)}</div>${note ? `<div class="card-n">${esc(note)}</div>` : ''}</div>`;

  const envNote = env === 'all'
    ? `<div class="note">默认不限制环境，本报告含 <b>${esc(model.envsSeen.join(' / ') || '无')}</b> 的流量。
拓扑按应用聚合，同一个应用的多个环境合成一个节点；下面三张明细表都有 <code>env</code> 列可以逐环境看，
只想看单个环境时传 <code>--env=prod</code>。</div>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(app)} 调用关系 · ${esc(env)} · ${esc(range)}</title>
<style>
:root{--bg:#f7f8fa;--fg:#1c2024;--muted:#6b7480;--line:#dfe3e8;--panel:#fff;--ok:#1f9254;--warn:#b8770b;--bad:#c2352b;--up:#2f6fb5;--down:#7a4bb5;--self:#1c2024;--code:#f2f4f7}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e9ed;--muted:#9aa4b0;--line:#2b3138;--panel:#1b1f24;--ok:#4cc38a;--warn:#e2a336;--bad:#f06a5f;--up:#63a0e0;--down:#b085e0;--self:#e6e9ed;--code:#22272d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"Segoe UI","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1440px;margin:0 auto;padding:28px 24px 64px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:34px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
h3{font-size:14px;margin:22px 0 8px;font-weight:600}
h3.sub-h{margin-top:14px}
.sub{color:var(--muted);margin:0 0 20px;font-size:13px}
.sub code{background:var(--code);padding:1px 6px;border-radius:4px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card-v{font-size:24px;font-weight:600;line-height:1.2}
.card-l{color:var(--muted);font-size:12px;margin-top:4px}
.card-n{color:var(--muted);font-size:11px;margin-top:2px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;overflow-x:auto}
svg{display:block;min-width:900px}
.svg-col{fill:var(--muted);font-size:12px;font-weight:600}
.svg-app{fill:var(--fg);font-size:13px;font-weight:600}
.svg-sub{fill:var(--muted);font-size:10.5px}
.svg-edge-label{fill:var(--muted);font-size:10.5px;text-anchor:middle}
.node rect{fill:var(--panel);stroke:var(--line);stroke-width:1.5}
.node.up rect{stroke:var(--up)}
.node.down rect{stroke:var(--down)}
.node.self rect{fill:var(--self);stroke:var(--self)}
.node.self .svg-app{fill:var(--panel)}
.node.bad rect{stroke:var(--bad);stroke-width:2}
.edge{color:var(--muted)}
.edge path{fill:none;stroke:currentColor;stroke-width:1.4}
.edge.bad{color:var(--bad)}
.edge.bad path{stroke-width:2}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:12.5px;white-space:nowrap}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left}
th{background:var(--code);color:var(--muted);font-weight:600;position:sticky;top:0}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:last-child td{border-bottom:0}
tr.bad td{background:color-mix(in srgb,var(--bad) 8%,transparent)}
tr.warn td{background:color-mix(in srgb,var(--warn) 8%,transparent)}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;font-weight:600;color:#fff}
.badge.ok{background:var(--ok)}.badge.warn{background:var(--warn)}.badge.bad{background:var(--bad)}
.tag{background:var(--code);color:var(--muted);padding:0 5px;border-radius:4px;font-size:10.5px;font-weight:400}
.delta.up{color:var(--bad)}.delta.down{color:var(--ok)}
.chain b{font-weight:600}
.muted{color:var(--muted);font-weight:400;font-size:12px}
.empty{color:var(--muted);padding:10px 0}
.hint{color:var(--fg);background:var(--code);padding:8px 12px;border-radius:8px;font-size:12.5px;margin:6px 0}
.timeline{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.tl{background:var(--code);border-radius:6px;padding:3px 8px;font-size:11.5px;font-variant-numeric:tabular-nums}
details{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-top:12px}
summary{cursor:pointer;font-weight:600;font-size:13px}
pre{overflow:auto;background:var(--code);padding:12px;border-radius:8px;font-size:11.5px;line-height:1.5;max-height:520px}
.note{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--warn);border-radius:0 8px 8px 0;padding:10px 14px;color:var(--muted);font-size:12.5px;margin-top:12px}
</style>
</head>
<body>
<div class="wrap">
<h1>${esc(app)} 调用关系</h1>
<p class="sub">
站点 <code>${esc(site)}</code> · 域名 <code>${esc(baseUrl)}</code> ·
env <code>${esc(env === 'all' ? `all (${model.envsSeen.join(',') || '-'})` : env)}</code> · 统计窗口 <code>${esc(range)}</code>${baselineLabel ? ` · 基线 <code>${esc(baselineLabel)}</code> 前` : ''} ·
生成时间 ${esc(generatedAt)} · 数据源 fsof provider/consumer 监控指标
</p>

<div class="cards">
${card('上游客户端应用', stats.upstreamApps)}
${card('对外提供接口', stats.providerInterfaces, 'service#method')}
${card('下游依赖接口', stats.downstreamInterfaces, 'service#method')}
${card('下游服务方应用', stats.downstreamApps, stats.multiOwnerServices ? `${stats.multiOwnerServices} 个 service 有多个候选提供方` : '')}
${card('入口调用量', fmtInt(stats.providerCount), `错误 ${fmtInt(stats.providerErr)}`)}
${card('出口调用量', fmtInt(stats.consumerCount), `错误 ${fmtInt(stats.consumerErr)}`)}
${card('异常条目', stats.anomalies, '错误>0 或成功率<100%')}
</div>

<h2>调用拓扑</h2>
<div class="panel">
${renderTopology(app, upstreamApps.filter((e) => e.app !== app), downstreamApps.filter((e) => e.app !== app), selfEntry)}
</div>
<div class="note">节点与连线可悬停查看接口明细。连线数字是窗口内调用量；标红表示该链路有错误或成功率不足 100%。</div>
${envNote}

${renderDrilldown(drilldown, slowMs)}

${renderBaseline(baseline, slowMs)}

<h2>上游：谁在调我</h2>
${renderTable('客户端 → 本应用接口', clientCols, clients, slowMs)}

<h2>本应用：对外提供的接口</h2>
${renderTable('provider 接口健康度', providerCols, provider, slowMs)}

<h2>下游：我调了谁</h2>
${renderTable('本应用 → 下游应用接口', downstreamCols, downstreamRows, slowMs)}

<h2>原始数据</h2>
<details><summary>完整 JSON（含 PromQL）</summary><pre>${esc(JSON.stringify(jsonModel, null, 2))}</pre></details>
<details><summary>本次执行的 PromQL（${queryLog.length} 条）</summary><pre>${esc(queryLog.map((q) => `# ${q.label}\n${q.query}`).join('\n\n'))}</pre></details>

<div class="note">
口径说明：<br>
1. 指标名前缀由 app 名把非法字符替换成下划线得到，所以一律用 <code>{__name__=~".*_provider_monitor_acc_count",app="…"}</code> 选择，不直接拼接 app 名。<br>
2. <code>acc_count</code> 是每 60s 采集周期的增量而非单调计数器，窗口总量用 <code>sum_over_time</code> 求和，不能靠调大 step。<br>
3. consumer 指标只有 <code>dst_set</code>（套名）没有目标应用名，下游应用是用 provider 侧按 service 反查得到；service 归属与 env 无关，反查刻意不加 env 过滤。<br>
4. <code>avr_cost_time</code> / <code>slowest_cost_time</code> 的源单位是<b>微秒</b>，报告里已除以 1000 转成 ms。
判定依据：全局 provider <code>avr_cost_time</code> 分布 p50=6490、p90=76617、p99=667690、max=1.83e9，
按 ms 解读意味着半数接口平均耗时 6.5 秒、单次调用最长 21 天，不成立；按 µs 解读是标准同机房 RPC 分布。
交叉验证：同一次调用消费端量到 6579、提供端量到 5831，差值 748µs 正好是网络与序列化开销。<br>
5. 这两个指标是<b>平均值</b>不是汇总耗时——实测同接口调用量从 1 变到 165 时 <code>avr_cost_time</code> 稳定在 21562~33182，与调用量无关联。<br>
6. 同一个 service 可能由多个应用同时提供（分机构、分环境独立部署），而 consumer 指标只有
<code>service</code>/<code>method</code>/<code>dst_set</code>，判定不了这次调用落到哪个提供方。
这类链路标为<b>多候选</b>，拓扑里合成一个节点，卡片「下游服务方应用」按去重后的应用总数计，两者数量本就不等。<br>
7. 指标只覆盖窗口内<b>有流量</b>的 provider，零流量或未接指标的服务查不到归属，这类会兜底问 Dubbo/FSOF
注册中心（<code>query-dubbo-registry</code>），标为<b>注册中心</b>；注册中心说明"应该由谁提供"，不代表窗口内有流量。<br>
8. 少量接口只上报 <code>acc_count</code> 不上报 <code>successrate</code>，这类的最低成功率显示为<b>无数据</b>，不按 100% 计，也不计入异常。<br>
9. 异常时间线用 <code>sum_over_time(...[step])</code> 按 step 求和，不用裸采样——实测同一批错误裸采样会漏掉落在采样间隙的事件。<br>
10. 平均耗时是各实例 <code>avr_cost_time</code> 的未加权平均，实例间流量不均时为近似值；最慢耗时取窗口内最大值。<br>
11. 只覆盖 FSOF/Dubbo RPC，不含 MySQL / Redis / MQ / HTTP 入口依赖。<br>
12. 只反映窗口内<b>有流量</b>的接口，零流量的已注册接口不会出现。<br>
13. 仅在线上站点（<code>healthy.lexincloud.com</code>）验证过；stable 站点未实跑。
</div>
</div>
</body>
</html>`;
}

function buildJsonModel(model, downstreamRows) {
  const {
    app, site, baseUrl, env, range, baselineLabel, slowMs, generatedAt,
    provider, consumer, clients, ownerOf, registryFilled, stats, drilldown, baseline, queryLog,
  } = model;
  return {
    meta: {
      app, site, baseUrl, env, range, slowMs, generatedAt,
      envs_seen: model.envsSeen || [],
      baseline: baselineLabel || null,
      cost_unit: 'ms（源指标 avr_cost_time / slowest_cost_time 单位为微秒，已在 PromQL 中除以 1000）',
      scope: 'FSOF/Dubbo RPC only',
    },
    stats,
    upstream_clients: clients,
    provider_interfaces: provider,
    downstream_dependencies: downstreamRows
      || consumer.map((row) => ({ ...row, ownerApp: [...(ownerOf.get(row.service) || ['(未知应用)'])].sort().join(OWNER_SEP) })),
    downstream_owner_map: Object.fromEntries([...ownerOf].map(([k, v]) => [k, [...v]])),
    downstream_owner_source: Object.fromEntries([...ownerOf].map(([k]) => [
      k, registryFilled && registryFilled.has(k) ? 'dubbo-registry' : 'metrics',
    ])),
    anomaly_drilldown: drilldown,
    baseline_diff: baseline,
    promql: queryLog,
  };
}

// ---------------------------------------------------------------- main

function summarize(rows) {
  return rows.reduce((acc, row) => {
    acc.count += num(row.count);
    acc.err += num(row.err);
    return acc;
  }, { count: 0, err: 0 });
}

function printTerminal(model) {
  const { app, env, range, stats, clients, provider, consumer, ownerOf, drilldown, baseline, outFile, jsonFile } = model;
  const line = (label, value) => console.log(`  ${label.padEnd(16)} ${value}`);
  const envText = env === 'all' ? `all (${stats.envsSeen.join(',') || '-'})` : env;
  console.log(`\n应用 ${app} · env=${envText} · 窗口=${range}`);
  line('上游客户端应用', stats.upstreamApps);
  line('对外提供接口', stats.providerInterfaces);
  line('下游依赖接口', stats.downstreamInterfaces);
  line('下游服务方应用', stats.downstreamApps);
  line('入口调用/错误', `${fmtInt(stats.providerCount)} / ${fmtInt(stats.providerErr)}`);
  line('出口调用/错误', `${fmtInt(stats.consumerCount)} / ${fmtInt(stats.consumerErr)}`);
  line('异常条目', stats.anomalies);

  const top = (title, rows, render) => {
    console.log(`\n  ${title}`);
    if (!rows.length) { console.log('    (无)'); return; }
    rows.slice(0, 8).forEach((row) => console.log(`    ${render(row)}`));
    if (rows.length > 8) console.log(`    … 其余 ${rows.length - 8} 条见 HTML`);
  };
  top('上游客户端 TOP', clients, (r) => `${r.app} → ${shortService(r.service)}#${r.method}  ${fmtInt(r.count)}${r.err ? ` 错${fmtInt(r.err)}` : ''}`);
  top('provider 接口 TOP', provider, (r) => `${shortService(r.service)}#${r.method} [${r.set}]  ${fmtInt(r.count)}  ${fmtMs(r.avgCost)}${r.err ? ` 错${fmtInt(r.err)}` : ''}`);
  top('下游依赖 TOP', consumer, (r) => `${[...(ownerOf.get(r.service) || ['(未知)'])].join(',')} ← ${shortService(r.service)}#${r.method}  ${fmtInt(r.count)}  ${fmtMs(r.avgCost)}${r.err ? ` 错${fmtInt(r.err)}` : ''}`);

  if (drilldown.length) {
    console.log('\n  异常下钻');
    for (const link of drilldown) {
      const bad = link.instances;
      const when = link.timeline.length
        ? `${fmtTime(link.timeline[0].ts)}${link.timeline.length > 1 ? ` … ${fmtTime(link.timeline[link.timeline.length - 1].ts)}（${link.timeline.length} 个时间点）` : ''}`
        : '时间线未采到';
      console.log(`    ${shortService(link.service)}#${link.method} 错${fmtInt(link.err)}`);
      const warn = num(link.instErrTotal) < num(link.err) ? `  [!] 实例合计 ${fmtInt(link.instErrTotal)} < 链路 ${fmtInt(link.err)}，实例分布不完整` : '';
      console.log(`      实例: ${bad.length ? `${bad.map((r) => `${r.ident}(错${fmtInt(r.err)})`).join(' ')}  (共 ${link.instanceTotal} 个实例)` : `${link.instanceTotal} 个实例均无错误`}${warn}`);
      console.log(`      时间: ${when}  [按 ${link.step}s 聚合]`);
    }
  }

  if (baseline) {
    console.log(`\n  对比基线（${baseline.label} 前）`);
    console.log(`    新增接口 ${baseline.added.length} · 消失接口 ${baseline.removed.length} · 有变化 ${baseline.changed.length}`);
    baseline.added.slice(0, 5).forEach((r) => console.log(`      + ${shortService(r.service)}#${r.method} ${fmtInt(r.count)}`));
    baseline.removed.slice(0, 5).forEach((r) => console.log(`      - ${shortService(r.service)}#${r.method} 基线 ${fmtInt(r.baseCount)}`));
  }

  if (outFile) console.log(`\n  HTML 报告: ${outFile}`);
  if (jsonFile) console.log(`  JSON 结果: ${jsonFile}`);
  console.log('');
}

// 应用名或 env 写错时，两侧都会是空。区分"应用不存在"和"该 env 没数据"，
// 不要静默输出一份全 0 的报告让人以为应用没流量。
async function explainEmpty(ctx, app, env) {
  const anyEnv = await promQuery(
    ctx, 'diagnose.any-env',
    `count(${selector('provider', SUFFIX.count, [labelEq('app', app)])} or ${selector('consumer', SUFFIX.count, [labelEq('app', app)])}) by (env)`,
  );
  if (!anyEnv.length) {
    const like = await promQuery(
      ctx, 'diagnose.similar',
      // 必须先转义再把 _ / - 放成通配，反过来会把通配点又转义回字面点。
      `count({__name__=~".*_provider_monitor_acc_count",app=~".*${escapeRe(app).replace(/[_-]/g, '.')}.*"}) by (app)`,
    ).catch(() => []);
    const hint = like.length
      ? `\n名字相近的应用: ${[...new Set(like.map((s) => s.metric.app))].slice(0, 8).join(', ')}`
      : '';
    throw new Error(`应用 "${app}" 在任何 env 下都没有 fsof provider/consumer 指标。`
      + `\n请核对应用名（app 标签值，可能带连字符），或确认该应用是否接入 fsof。${hint}`);
  }
  const envs = [...new Set(anyEnv.map((s) => s.metric.env).filter(Boolean))].sort();
  // env=all 是默认，这时候提示"改 --env"没有意义，只能是窗口太短。
  if (env === 'all') {
    throw new Error(`应用 "${app}" 有 fsof 指标（env: ${envs.join(', ')}），但 ${ctx.range} 窗口内没有任何流量。`
      + '\n请用 --range 拉长窗口，例如 --range=7d。');
  }
  throw new Error(`应用 "${app}" 在 env="${env}" 的 ${ctx.range} 窗口内没有数据。`
    + `\n该应用有数据的 env: ${envs.join(', ')}。请改 --env（不传即四个环境全看），或用 --range 拉长窗口。`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { usage(); return 0; }

  const site = String(args.site || DEFAULT_SITE).toLowerCase();
  const baseUrl = args['base-url'] || BASE_URLS[site];
  if (!baseUrl) throw new Error(`未知站点: ${site}，可选 ${Object.keys(BASE_URLS).join('|')}`);
  if (!VERIFIED_SITES.has(site) && !args['base-url']) {
    console.log(`提示: 站点 ${site} 未实跑验证过，仅线上 prod 已验证；如果报错请核对域名与登录态。`);
  }

  const env = String(args.env || DEFAULT_ENV);
  const envFilter = env === 'all' ? '' : labelEq('env', env);
  const range = prometheusDuration(args.range || DEFAULT_RANGE);
  const baselineOffset = args.baseline && args.baseline !== true ? prometheusDuration(args.baseline) : '';
  const slowMs = optionalNumber(args['slow-ms'], DEFAULT_SLOW_MS);
  const maxDrilldown = optionalNumber(args['max-drilldown'], DEFAULT_MAX_DRILLDOWN);
  const focusService = args.service && args.service !== true ? String(args.service) : '';

  const auth = await resolveAuth(args, baseUrl);
  const ctx = {
    baseUrl,
    auth,
    range,
    windowSec: durationSeconds(range),
    now: Math.floor(Date.now() / 1000),
    cluster: args.cluster || DEFAULT_CLUSTER,
    language: args.language || DEFAULT_LANGUAGE,
    concurrency: Math.max(1, optionalNumber(args.concurrency, DEFAULT_CONCURRENCY)),
    httpTimeout: Math.max(1000, optionalNumber(args['http-timeout'], DEFAULT_HTTP_TIMEOUT_MS)),
    retries: Math.max(0, optionalNumber(args.retries, DEFAULT_RETRIES)),
    // Healthy 的 prod/online 对应 bianque 的 pre（线上与预发共用同一套 bianque）。
    registrySite: args['registry-site'] || (VERIFIED_SITES.has(site) ? 'pre' : 'stable'),
    queryLog: [],
  };

  let app = args.app && args.app !== true ? String(args.app) : '';
  if (!app) {
    if (!focusService) { usage(); throw new Error('必须提供 --app 或 --service'); }
    const owners = await resolveServiceOwners(ctx, [focusService]);
    if (!owners.has(focusService)) await fillOwnersFromRegistry(ctx, owners, [focusService]);
    const list = [...(owners.get(focusService) || [])];
    if (!list.length) {
      throw new Error(`没查到提供 ${focusService} 的应用：窗口内没有 provider 指标，注册中心也没有记录。`
        + '\n请核对服务名（支持短名），或确认该服务是否已下线。');
    }
    if (list.length > 1) console.log(`注意: ${focusService} 有多个提供方 ${list.join(', ')}，取第一个继续`);
    app = list[0];
    console.log(`--service 反查到应用: ${app}`);
  }

  const appFilter = labelEq('app', app);
  const serviceFilter = focusService ? labelEq('service', focusService) : '';
  const providerFilters = [appFilter, envFilter, serviceFilter];
  const consumerFilters = [appFilter, envFilter];

  // 第一层：provider 与 consumer 互不依赖，并发。
  const [provider, consumer] = await Promise.all([
    collectMetrics(ctx, 'provider', providerFilters, PROVIDER_GROUP, 'provider', ''),
    collectMetrics(ctx, 'consumer', consumerFilters, CONSUMER_GROUP, 'consumer', ''),
  ]);

  if (!provider.length && !consumer.length) await explainEmpty(ctx, app, env);

  const providerServices = [...new Set(provider.map((r) => r.service).filter(Boolean))];
  const consumerServices = [...new Set(consumer.map((r) => r.service).filter(Boolean))];

  // 第二层：上游客户端与下游归属互不依赖，并发。
  const [clients, ownerOf] = await Promise.all([
    providerServices.length ? resolveClients(ctx, providerServices, envFilter, '') : Promise.resolve([]),
    consumerServices.length ? resolveServiceOwners(ctx, consumerServices) : Promise.resolve(new Map()),
  ]);

  const registryFill = await fillOwnersFromRegistry(ctx, ownerOf, consumerServices);
  const registryFilled = new Set(registryFill.filled);

  const providerSum = summarize(provider);
  const consumerSum = summarize(consumer);

  const downstreamAppSet = new Set();
  let multiOwnerServices = 0;
  for (const service of consumerServices) {
    const owners = ownerOf.get(service) || new Set(['(未知应用)']);
    for (const owner of owners) downstreamAppSet.add(owner);
    if (owners.size > 1) multiOwnerServices += 1;
  }

  const anomalyRows = [
    ...provider.filter(isBad).map((r) => ({ ...r, role: 'provider', app })),
    ...consumer.filter(isBad).map((r) => ({ ...r, role: 'consumer', app })),
    ...clients.filter(isBad).map((r) => ({ ...r, role: 'consumer' })),
  ];
  const envsSeen = [...new Set([...provider, ...consumer, ...clients].map((r) => r.env).filter(Boolean))].sort();
  const stats = {
    envsSeen,
    upstreamApps: new Set(clients.map((r) => r.app)).size,
    providerInterfaces: new Set(provider.map((r) => `${r.service}#${r.method}`)).size,
    downstreamInterfaces: new Set(consumer.map((r) => `${r.service}#${r.method}`)).size,
    downstreamApps: downstreamAppSet.size,
    multiOwnerServices,
    providerCount: providerSum.count,
    providerErr: providerSum.err,
    consumerCount: consumerSum.count,
    consumerErr: consumerSum.err,
    anomalies: anomalyRows.length,
  };

  const drilldownLinks = anomalyRows
    .sort((a, b) => num(b.err) - num(a.err) || num(b.count) - num(a.count))
    .slice(0, Math.max(0, maxDrilldown))
    .map((r) => ({ role: r.role, app: r.app, service: r.service, method: r.method, env: r.env, err: r.err }));

  // 第三层：异常下钻与基线对比互不依赖，并发。
  const [drilldown, baseline] = await Promise.all([
    runDrilldown(ctx, drilldownLinks),
    baselineOffset
      ? buildBaseline(ctx, { providerFilters, consumerFilters, baselineOffset, provider, consumer })
      : Promise.resolve(null),
  ]);

  ctx.queryLog.sort((a, b) => a.label.localeCompare(b.label) || a.query.localeCompare(b.query));

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const model = {
    app,
    site,
    baseUrl,
    env,
    envsSeen,
    range,
    baselineLabel: baselineOffset,
    slowMs,
    generatedAt: now.toLocaleString('zh-CN', { hour12: false }),
    provider,
    consumer,
    clients,
    ownerOf,
    registryFilled,
    stats,
    drilldown,
    baseline,
    queryLog: ctx.queryLog,
    outFile: '',
    jsonFile: '',
  };

  if (!args['no-html']) {
    const safeApp = app.replace(/[^A-Za-z0-9._-]/g, '_');
    const outFile = args.out && args.out !== true
      ? expandHome(String(args.out))
      : path.join(expandHome(args['out-dir'] || DEFAULT_OUT_DIR), `${safeApp}-${env}-${stamp}.html`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, buildHtml(model), 'utf8');
    model.outFile = outFile;
  }

  if (args.json && args.json !== true) {
    const jsonFile = expandHome(String(args.json));
    fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
    fs.writeFileSync(jsonFile, JSON.stringify(buildJsonModel(model, null), null, 2), 'utf8');
    model.jsonFile = jsonFile;
  }

  printTerminal(model);
  return args['fail-on-anomaly'] && stats.anomalies > 0 ? 2 : 0;
}

// 基线：把同样的窗口整体 offset 到过去，比较接口集合与量级的变化。
async function buildBaseline(ctx, opts) {
  const { providerFilters, consumerFilters, baselineOffset, provider, consumer } = opts;
  const [baseProvider, baseConsumer] = await Promise.all([
    collectMetrics(ctx, 'provider', providerFilters, PROVIDER_GROUP, 'baseline.provider', baselineOffset),
    collectMetrics(ctx, 'consumer', consumerFilters, CONSUMER_GROUP, 'baseline.consumer', baselineOffset),
  ]);

  const diff = (curRows, baseRows, groupKeys, side) => {
    const baseMap = new Map(baseRows.map((r) => [rowKey(r, groupKeys), r]));
    const curMap = new Map(curRows.map((r) => [rowKey(r, groupKeys), r]));
    const added = [];
    const removed = [];
    const changed = [];
    for (const [key, row] of curMap) {
      const base = baseMap.get(key);
      if (!base || !num(base.count)) {
        added.push({ ...row, side, baseCount: base ? num(base.count) : 0 });
        continue;
      }
      changed.push({
        ...row, side, baseCount: num(base.count), baseErr: num(base.err), baseAvgCost: num(base.avgCost),
      });
    }
    for (const [key, base] of baseMap) {
      if (!curMap.has(key) && num(base.count)) removed.push({ ...base, side, baseCount: num(base.count), count: 0 });
    }
    return { added, removed, changed };
  };

  const p = diff(provider, baseProvider, PROVIDER_GROUP, 'provider');
  const c = diff(consumer, baseConsumer, CONSUMER_GROUP, 'consumer');

  // 变化排序按"量级变化幅度"和"耗时劣化幅度"取较大者，避免只看绝对值淹没小接口的劣化。
  const score = (r) => {
    const countRatio = num(r.baseCount) ? Math.abs(num(r.count) - num(r.baseCount)) / num(r.baseCount) : 0;
    const costRatio = num(r.baseAvgCost) ? Math.abs(num(r.avgCost) - num(r.baseAvgCost)) / num(r.baseAvgCost) : 0;
    return Math.max(countRatio, costRatio);
  };

  return {
    label: baselineOffset,
    added: [...p.added, ...c.added].sort((a, b) => num(b.count) - num(a.count)),
    removed: [...p.removed, ...c.removed].sort((a, b) => num(b.baseCount) - num(a.baseCount)),
    changed: [...p.changed, ...c.changed].filter((r) => score(r) >= 0.2).sort((a, b) => score(b) - score(a)).slice(0, 40),
  };
}

main()
  .then((code) => { process.exitCode = code || 0; })
  .catch((error) => {
    console.error(`\n[inspect-app-call-topology] ${error.message}\n`);
    process.exit(1);
  });
