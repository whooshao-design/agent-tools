#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const BASE_URLS = {
  stable: 'https://stable-eye.oa.fenqile.com',
  test: 'https://stable-eye.oa.fenqile.com',
  prod: 'https://healthy.lexincloud.com',
  online: 'https://healthy.lexincloud.com',
};

const DEFAULT_CLUSTER = 'Default';
const DEFAULT_LANGUAGE = 'zh';
const DEFAULT_PROFILE = '/tmp/healthy-metrics-profile';
const DEFAULT_TOOL_DIR = '~/tools/lexiao-browser';
const DEFAULT_RANGE = '30m';
const DEFAULT_LOOKBACK = '2h';
const DEFAULT_FRESHNESS = '10m';
const DEFAULT_STEP = '60s';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq !== -1) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args[item.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      args[item.slice(2)] = true;
    }
  }
  return args;
}

function usage() {
  console.log(`Usage:
  inspect_metrics.js --env=stable --metrics=fql_fk_xxx [--profile=/tmp/profile] [--check-registry]
  inspect_metrics.js --env=prod --apps=app1,app2 --suffixes=dubbo_active_count,dubbo_pool_size --profile=/tmp/profile
  inspect_metrics.js --env=stable --promql='count(up)' --profile=/tmp/profile

Options:
  --env              stable|test|prod|online
  --base-url         Override API base URL
  --metrics          Comma or newline separated metric names
  --metrics-file     JSON array of metric strings/objects, or {"metrics":[...]}
  --apps             Comma separated app names, used with --suffixes
  --suffixes         Comma separated suffixes, used with --apps
  --range            Window for range_series/range_samples, default 30m
  --lookback         Window for last sample lookup, default 2h
  --freshness        OK freshness threshold, default 10m
  --step             Range query step, default 60s
  --check-registry   Also query /api/n9e/metric-manage
  --promql           Run a raw instant PromQL query instead of metric inspection
  --format           table|json, default table
  --token            Bearer token. Also supports env HEALTHY_METRIC_TOKEN
  --profile          Browser profile with Healthy login state, default /tmp/healthy-metrics-profile
  --tool-dir         Local Playwright tool dir, defaults to ~/tools/lexiao-browser
  --plan-only        Only expand metrics/promql, no network access
`);
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readJsonFile(file) {
  if (!file) return null;
  return JSON.parse(fs.readFileSync(expandHome(file), 'utf8'));
}

function normalizeEnv(env) {
  const key = String(env || 'stable').toLowerCase();
  if (key === '测试') return 'stable';
  if (key === '线上' || key === '生产') return 'prod';
  if (!BASE_URLS[key]) {
    throw new Error(`Unsupported env: ${env}`);
  }
  return key;
}

function normalizeMetricItem(item) {
  if (typeof item === 'string') return String(item).trim();
  if (item && typeof item === 'object' && item.metric) return String(item.metric).trim();
  throw new Error(`Invalid metric item: ${JSON.stringify(item)}`);
}

function loadMetrics(args) {
  const metrics = [];
  const metricsFile = readJsonFile(args['metrics-file']);
  if (metricsFile) {
    if (Array.isArray(metricsFile)) {
      for (const item of metricsFile) metrics.push(normalizeMetricItem(item));
    } else if (Array.isArray(metricsFile.metrics)) {
      for (const item of metricsFile.metrics) metrics.push(normalizeMetricItem(item));
    } else {
      throw new Error('--metrics-file must be an array or an object with metrics array');
    }
  }

  metrics.push(...splitList(args.metrics));

  const apps = splitList(args.apps);
  const suffixes = splitList(args.suffixes);
  if (apps.length || suffixes.length) {
    if (!apps.length || !suffixes.length) {
      throw new Error('--apps and --suffixes must be provided together');
    }
    for (const app of apps) {
      for (const suffix of suffixes) {
        metrics.push(`fql_fk_${app}_${suffix}`);
      }
    }
  }

  const unique = [];
  const seen = new Set();
  for (const metric of metrics) {
    if (!metric || seen.has(metric)) continue;
    validateMetricName(metric);
    seen.add(metric);
    unique.push(metric);
  }
  return unique;
}

function validateMetricName(metric) {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metric)) {
    throw new Error(`Invalid metric name: ${metric}. Use --promql for raw expressions.`);
  }
}

function parseDuration(value) {
  const text = String(value || '').trim();
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(text);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] || 's';
  const multipliers = {
    ms: 0.001,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };
  return amount * multipliers[unit];
}

function prometheusDuration(value) {
  const text = String(value || '').trim();
  if (!/^(\d+)(ms|s|m|h|d)?$/.test(text)) {
    throw new Error(`Invalid Prometheus duration: ${value}`);
  }
  return /^\d+$/.test(text) ? `${text}s` : text;
}

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

function loadPlaywright(paths) {
  if (!fs.existsSync(paths.playwrightPackage)) {
    throw new Error(`Playwright tool dir not found: ${paths.toolDir}`);
  }
  const requireFromTool = createRequire(paths.playwrightPackage);
  return requireFromTool('playwright').chromium;
}

async function extractAuthFromProfile(args, baseUrl) {
  const paths = resolvePaths(args);
  const chromium = loadPlaywright(paths);
  const ldLibraryPath = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const context = await chromium.launchPersistentContext(paths.profileDir, {
    executablePath: paths.chromePath,
    headless: true,
    env: { ...process.env, LD_LIBRARY_PATH: ldLibraryPath },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    const authUrl = args['auth-url'] || `${baseUrl}/sys-manage/metric-manage`;
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const auth = await page.evaluate(() => {
      const keys = Object.keys(localStorage);
      const tokenKey = keys.find((key) => /access.?token|token/i.test(key) && localStorage.getItem(key));
      const ticketKey = keys.find((key) => /ticket/i.test(key) && localStorage.getItem(key));
      return {
        token: tokenKey ? localStorage.getItem(tokenKey) : '',
        ticket: ticketKey ? localStorage.getItem(ticketKey) : '',
        tokenKey,
        ticketKey,
        title: document.title,
        snippet: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 200),
      };
    });
    if (!auth.token) {
      throw new Error(`No access token in profile. Page title=${auth.title}, snippet=${auth.snippet}`);
    }
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

function authHeaders(auth, args, hasBody) {
  const headers = {
    accept: 'application/json',
    'x-cluster': args.cluster || DEFAULT_CLUSTER,
    'x-language': args.language || DEFAULT_LANGUAGE,
  };
  if (hasBody) headers['content-type'] = 'application/json;charset=UTF-8';
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth.ticket) headers.ticket = auth.ticket;
  return headers;
}

async function requestJson(method, url, auth, args, body, redirectsLeft = 3) {
  const response = await fetch(url, {
    method,
    headers: authHeaders(auth, args, Boolean(body) || method === 'POST'),
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  if ([301, 302, 307, 308].includes(response.status) && response.headers.get('location') && redirectsLeft > 0) {
    const nextUrl = new URL(response.headers.get('location'), url).toString();
    return requestJson(method, nextUrl, auth, args, body, redirectsLeft - 1);
  }

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`${method} ${redactUrl(url)} returned non-json status=${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok || json.err) {
    throw new Error(`${method} ${redactUrl(url)} failed status=${response.status} err=${json.err || json.error || ''}`);
  }
  return json;
}

function redactUrl(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function promQueryUrl(baseUrl, query) {
  const url = new URL('/api/n9e/prometheus/api/v1/query', baseUrl);
  url.searchParams.set('query', query);
  return url.toString();
}

function promRangeUrl(baseUrl, query, start, end, step) {
  const url = new URL('/api/n9e/prometheus/api/v1/query_range', baseUrl);
  url.searchParams.set('query', query);
  url.searchParams.set('start', String(start));
  url.searchParams.set('end', String(end));
  url.searchParams.set('step', step);
  return url.toString();
}

function metricManageUrl(baseUrl, metric) {
  const url = new URL('/api/n9e/metric-manage', baseUrl);
  url.searchParams.set('query', metric);
  url.searchParams.set('exporter_type', '');
  url.searchParams.set('p', '1');
  url.searchParams.set('limit', '15');
  return url.toString();
}

async function promQuery(baseUrl, auth, args, query) {
  const json = await requestJson('POST', promQueryUrl(baseUrl, query), auth, args);
  if (json.status !== 'success') {
    throw new Error(`Prometheus query failed: ${query}; status=${json.status || ''} error=${json.error || ''}`);
  }
  return json.data?.result || [];
}

async function promRange(baseUrl, auth, args, query, start, end, step) {
  const json = await requestJson('POST', promRangeUrl(baseUrl, query, start, end, step), auth, args);
  if (json.status !== 'success') {
    throw new Error(`Prometheus range query failed: ${query}; status=${json.status || ''} error=${json.error || ''}`);
  }
  return json.data?.result || [];
}

async function queryRegistry(baseUrl, auth, args, metric) {
  const json = await requestJson('GET', metricManageUrl(baseUrl, metric), auth, args);
  const list = json.dat?.list || [];
  return list.filter((item) => item.metric === metric || item.standard_metric === metric);
}

// 只取第一条 series，调用方必须传已聚合的查询（用 count()/sum() 包住）。
// 同一逻辑指标会按上报实例的 ident label 拆成多条 series，未聚合时这里会静默丢弃其余实例。
function vectorNumber(result) {
  if (!result.length) return 0;
  const value = Number(result[0].value && result[0].value[1]);
  return Number.isFinite(value) ? value : 0;
}

// 多 series 检测：同一指标同一业务维度会按上报实例拆成多条 series，
// 不加 sum() 直接读第一条只能看到单台机器的数据
function seriesBreakdown(result) {
  if (!Array.isArray(result) || result.length <= 1) return null;
  const keys = new Set();
  for (const series of result) {
    for (const key of Object.keys(series.metric || {})) keys.add(key);
  }
  const varying = [...keys].filter(
    (key) => new Set(result.map((series) => (series.metric || {})[key])).size > 1,
  );
  return {
    series_count: result.length,
    varying_labels: varying,
    hint:
      `查询返回 ${result.length} 条 series，按 ${varying.join('/') || '未知 label'} 分裂。`
      + '要取跨实例的聚合值必须在外层加 sum()；直接读第一条只是单个上报实例的数据。',
  };
}

function latestValue(result) {
  let latest = null;
  for (const series of result) {
    for (const pair of series.values || []) {
      const ts = Number(pair[0]);
      const value = Number(pair[1]);
      if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
      if (!latest || ts > latest.evalEpoch) {
        latest = { evalEpoch: ts, value };
      }
    }
  }
  return latest;
}

function latestTimestampValue(result) {
  let latest = null;
  for (const series of result) {
    for (const pair of series.values || []) {
      const sampleEpoch = Number(pair[1]);
      if (!Number.isFinite(sampleEpoch)) continue;
      if (!latest || sampleEpoch > latest.sampleEpoch) {
        latest = { sampleEpoch };
      }
    }
  }
  return latest;
}

function formatTime(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(epochSeconds * 1000));
}

function formatAge(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const rounded = Math.max(0, Math.floor(seconds));
  const days = Math.floor(rounded / 86400);
  const hours = Math.floor((rounded % 86400) / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (days) return `${days}d${hours}h`;
  if (hours) return `${hours}h${minutes}m`;
  if (minutes) return `${minutes}m${secs}s`;
  return `${secs}s`;
}

function formatValue(value) {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 10000) / 10000);
}

function statusFor(row, freshnessSeconds) {
  if (row.error) return 'QUERY_ERROR';
  if (row.registered === false) return 'UNREGISTERED';
  if (row.current_series > 0) return 'OK';
  if (Number.isFinite(row.last_sample_age_seconds) && row.last_sample_age_seconds <= freshnessSeconds) return 'OK';
  if (row.lookback_series > 0) return 'STALE';
  return 'MISSING';
}

async function inspectMetric(baseUrl, auth, args, metric, options) {
  const row = {
    metric,
    registered: args['check-registry'] ? false : 'unknown',
    registry_ids: '',
    current_series: 0,
    range_series: 0,
    range_samples: 0,
    lookback_series: 0,
    last_sample_time: '',
    last_sample_age: '',
    last_sample_age_seconds: null,
    last_value: null,
    status: 'MISSING',
    error: '',
  };

  try {
    if (args['check-registry']) {
      const hits = await queryRegistry(baseUrl, auth, args, metric);
      row.registered = hits.length > 0;
      row.registry_ids = hits.map((hit) => hit.id).filter(Boolean).join(',');
      if (!row.registered) {
        row.status = 'UNREGISTERED';
        return row;
      }
    }

    const range = options.range;
    const lookback = options.lookback;
    row.current_series = vectorNumber(await promQuery(baseUrl, auth, args, `count(${metric})`));
    row.range_series = vectorNumber(await promQuery(baseUrl, auth, args, `count(count_over_time(${metric}[${range}]))`));
    row.range_samples = vectorNumber(await promQuery(baseUrl, auth, args, `sum(count_over_time(${metric}[${range}]))`));
    row.lookback_series = vectorNumber(await promQuery(baseUrl, auth, args, `count(count_over_time(${metric}[${lookback}]))`));

    const timestampSeries = await promRange(baseUrl, auth, args, `timestamp(${metric})`, options.start, options.end, options.step);
    const valueSeries = await promRange(baseUrl, auth, args, metric, options.start, options.end, options.step);
    const latestTimestamp = latestTimestampValue(timestampSeries);
    const latestMetricValue = latestValue(valueSeries);

    if (latestTimestamp) {
      row.last_sample_time = formatTime(latestTimestamp.sampleEpoch);
      row.last_sample_age_seconds = options.end - latestTimestamp.sampleEpoch;
      row.last_sample_age = formatAge(row.last_sample_age_seconds);
    }
    if (latestMetricValue) {
      row.last_value = latestMetricValue.value;
    }
    row.status = statusFor(row, options.freshnessSeconds);
    return row;
  } catch (error) {
    row.error = error.message;
    row.status = 'QUERY_ERROR';
    return row;
  }
}

function printPlan(baseUrl, args, metrics) {
  const range = prometheusDuration(args.range || DEFAULT_RANGE);
  const lookback = prometheusDuration(args.lookback || DEFAULT_LOOKBACK);
  const freshness = prometheusDuration(args.freshness || DEFAULT_FRESHNESS);
  if (args.promql) {
    console.log(`PLAN_PROMQL\tbase_url=${baseUrl}\tpromql=${args.promql}`);
    return;
  }
  for (const metric of metrics) {
    console.log(`PLAN\t${metric}\tbase_url=${baseUrl}\trange=${range}\tlookback=${lookback}\tfreshness=${freshness}`);
  }
}

function printTable(summary) {
  const columns = [
    'status',
    'metric',
    'registered',
    'current_series',
    'range_series',
    'range_samples',
    'lookback_series',
    'last_sample_time',
    'age',
    'last_value',
    'registry_ids',
    'error',
  ];
  console.log(columns.join('\t'));
  for (const row of summary.rows) {
    console.log([
      row.status,
      row.metric,
      String(row.registered),
      String(row.current_series),
      String(row.range_series),
      String(row.range_samples),
      String(row.lookback_series),
      row.last_sample_time || '',
      row.last_sample_age || '',
      formatValue(row.last_value),
      row.registry_ids || '',
      row.error || '',
    ].join('\t'));
  }
}

function countByStatus(rows) {
  const result = {};
  for (const row of rows) {
    result[row.status] = (result[row.status] || 0) + 1;
  }
  return result;
}

async function runRawPromql(baseUrl, auth, args) {
  const result = await promQuery(baseUrl, auth, args, args.promql);
  const output = {
    checked_at: formatTime(Math.floor(Date.now() / 1000)),
    env: args.env || 'stable',
    base_url: baseUrl,
    promql: args.promql,
    series_count: Array.isArray(result) ? result.length : 0,
    result,
  };
  const breakdown = seriesBreakdown(result);
  if (breakdown) output.multi_series_warning = breakdown;
  console.log(JSON.stringify(output, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }

  const env = normalizeEnv(args.env || 'stable');
  args.env = env;
  const baseUrl = args['base-url'] || BASE_URLS[env];
  const metrics = args.promql ? [] : loadMetrics(args);
  if (!args.promql && !metrics.length) {
    throw new Error('No metrics provided. Use --metrics, --metrics-file, or --apps with --suffixes.');
  }

  if (args['plan-only']) {
    printPlan(baseUrl, args, metrics);
    return;
  }

  const auth = await resolveAuth(args, baseUrl);
  if (args.promql) {
    await runRawPromql(baseUrl, auth, args);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const lookback = prometheusDuration(args.lookback || DEFAULT_LOOKBACK);
  const lookbackSeconds = parseDuration(lookback);
  const options = {
    range: prometheusDuration(args.range || DEFAULT_RANGE),
    lookback,
    freshnessSeconds: parseDuration(args.freshness || DEFAULT_FRESHNESS),
    step: prometheusDuration(args.step || DEFAULT_STEP),
    end: now,
    start: now - lookbackSeconds,
  };

  const rows = [];
  for (const metric of metrics) {
    rows.push(await inspectMetric(baseUrl, auth, args, metric, options));
  }

  const summary = {
    checked_at: formatTime(now),
    env,
    base_url: baseUrl,
    range: options.range,
    lookback: options.lookback,
    freshness: args.freshness || DEFAULT_FRESHNESS,
    status_counts: countByStatus(rows),
    rows,
  };

  if (String(args.format || 'table').toLowerCase() === 'json') {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printTable(summary);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
