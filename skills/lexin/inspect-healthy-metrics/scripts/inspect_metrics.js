#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, resolveBaseUrl, withHealthyClient } = require('../../healthy-dashboard-config/scripts/healthy_client');

const DEFAULT_RANGE = '30m';
const DEFAULT_LOOKBACK = '2h';
const DEFAULT_FRESHNESS = '10m';
const DEFAULT_STEP = '60s';

function usage() {
  console.log(`Usage:
  inspect_metrics.js --env=stable --metrics=fql_fk_xxx [--profile=/tmp/profile] [--check-registry]
  inspect_metrics.js --env=prod --apps=app1,app2 --suffixes=dubbo_active_count,dubbo_pool_size --profile=/tmp/profile
  inspect_metrics.js --env=stable --promql='count(up)' --profile=/tmp/profile

Options:
  --env              stable|test|prod|online
  --base-url         Known Healthy site override only
  --metrics          Comma or newline separated metric names
  --metrics-file     JSON array of metric strings/objects, or {"metrics":[...]}
  --apps             Comma separated app names, used with --suffixes
  --suffixes         Comma separated suffixes, used with --apps
  --range            Window for range_series/range_samples, default 30m
  --lookback         Window for last sample lookup, default 2h
  --freshness        OK freshness threshold, default 10m
  --step             Range query step, default 60s
  --check-registry   Also query /api/n9e/metric-manage
  --promql           Run one raw instant PromQL query
  --queries-file     JSON array of {name,expr}; one browser session for the whole batch
  --queries-json     Inline JSON array, alternative to --queries-file
  --query-type       instant|range, default range for batches
  --start/--end       Optional epoch seconds for a historical range (default now minus --range)
  --output           Save full JSON results; stdout includes a compact query summary
  --format           table|json, default table
  --token            Bearer token. Also supports env HEALTHY_METRIC_TOKEN
  --profile          Browser profile with Healthy login state, default browser-profiles/healthy
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
  const seconds = amount * multipliers[unit];
  if (seconds <= 0) throw new Error('Duration must be positive');
  return seconds;
}

function prometheusDuration(value) {
  const text = String(value || '').trim();
  if (!/^(\d+)(ms|s|m|h|d)?$/.test(text)) {
    throw new Error(`Invalid Prometheus duration: ${value}`);
  }
  return /^\d+$/.test(text) ? `${text}s` : text;
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

async function promQuery(client, query) {
  const json = (await client.request('POST', promQueryUrl(client.baseUrl, query))).json;
  if (json.status !== 'success') {
    throw new Error(`Prometheus query failed: ${query}; status=${json.status || ''} error=${json.error || ''}`);
  }
  return json.data?.result || [];
}

async function promRange(client, query, start, end, step) {
  const json = (await client.request('POST', promRangeUrl(client.baseUrl, query, start, end, step))).json;
  if (json.status !== 'success') {
    throw new Error(`Prometheus range query failed: ${query}; status=${json.status || ''} error=${json.error || ''}`);
  }
  return json.data?.result || [];
}

async function queryRegistry(client, metric) {
  const json = (await client.request('GET', metricManageUrl(client.baseUrl, metric))).json;
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

async function inspectMetric(client, args, metric, options) {
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
      const hits = await queryRegistry(client, metric);
      row.registered = hits.length > 0;
      row.registry_ids = hits.map((hit) => hit.id).filter(Boolean).join(',');
      if (!row.registered) {
        row.status = 'UNREGISTERED';
        return row;
      }
    }

    const range = options.range;
    const lookback = options.lookback;
    row.current_series = vectorNumber(await promQuery(client, `count(${metric})`));
    row.range_series = vectorNumber(await promQuery(client, `count(count_over_time(${metric}[${range}]))`));
    row.range_samples = vectorNumber(await promQuery(client, `sum(count_over_time(${metric}[${range}]))`));
    row.lookback_series = vectorNumber(await promQuery(client, `count(count_over_time(${metric}[${lookback}]))`));

    const timestampSeries = await promRange(client, `timestamp(${metric})`, options.start, options.end, options.step);
    const valueSeries = await promRange(client, metric, options.start, options.end, options.step);
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

function loadQueries(args) {
  if (args['queries-file'] && args['queries-json']) throw new Error('queries-file 与 queries-json 只能选择一个');
  if (!args['queries-file'] && !args['queries-json']) return null;
  const queries = args['queries-json'] ? JSON.parse(args['queries-json']) : readJsonFile(args['queries-file']);
  if (!Array.isArray(queries) || !queries.length || queries.some(item =>
    !item || typeof item.name !== 'string' || !item.name.trim() || typeof item.expr !== 'string' || !item.expr.trim())) {
    throw new Error('queries 必须是非空的 {name,expr} 数组');
  }
  return queries;
}

function parseBatchResults(queries, json) {
  if (json.err || !Array.isArray(json.dat) || json.dat.length !== queries.length || json.dat.some(item => !Array.isArray(item))) {
    throw new Error('query-range-batch 失败或响应数量不匹配，不能按无数据处理');
  }
  return queries.map((item, index) => ({ ...item, series_count: json.dat[index].length, result: json.dat[index] }));
}

async function runQueries(client, args, queries) {
  const type = args['query-type'] || 'range';
  if (!['instant', 'range'].includes(type)) throw new Error('query-type 必须是 instant 或 range');
  if (type === 'instant') {
    // 同一页面适度并行，避免为每个表达式重新拉起浏览器。
    const results = [];
    for (let index = 0; index < queries.length; index += 4) {
      results.push(...await Promise.all(queries.slice(index, index + 4).map(async item => {
        const result = await promQuery(client, item.expr);
        return { ...item, series_count: result.length, result };
      })));
    }
    return { query_type: type, results };
  }
  const end = args.end === undefined ? Math.floor(Date.now() / 1000) : Number(args.end);
  const start = args.start === undefined ? end - parseDuration(args.range || DEFAULT_RANGE) : Number(args.start);
  const step = parseDuration(args.step || DEFAULT_STEP);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('start/end 必须是有效时间区间');
  const response = await client.request('POST', '/api/n9e/query-range-batch', {
    queries: queries.map(item => ({ query: item.expr, start, end, step })),
  });
  return { query_type: type, start, end, step, results: parseBatchResults(queries, response.json) };
}

function outputJson(output, args) {
  if (!args.output) return console.log(JSON.stringify(output, null, 2));
  fs.writeFileSync(expandHome(args.output), JSON.stringify(output, null, 2), { flag: 'wx' });
  const summary = { ...output, output: expandHome(args.output) };
  if (summary.results) summary.results = summary.results.map(({ result, ...item }) => ({
    ...item, series: result.map(series => ({ metric: series.metric, first: series.values?.[0] || series.value,
      last: series.values?.at(-1) || series.value, points: series.values?.length || 1 })),
  }));
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) return usage();
  args.env = args.env || 'stable';
  const baseUrl = resolveBaseUrl(args, 'stable');
  const queries = loadQueries(args);
  if (queries && args.promql) throw new Error('promql 与 queries 只能选择一个');
  const metrics = args.promql || queries ? [] : loadMetrics(args);
  if (!args.promql && !queries && !metrics.length) throw new Error('请提供 metrics、promql 或 queries');
  if (args['plan-only']) {
    if (queries) console.log(JSON.stringify({ base_url: baseUrl, query_type: args['query-type'] || 'range', queries }, null, 2));
    else printPlan(baseUrl, args, metrics);
    return;
  }
  // 保留显式 token 的旧入口，但凭据只在当前已限定站点的浏览器会话中使用。
  args.token = args.token || process.env.HEALTHY_METRIC_TOKEN;
  await withHealthyClient(args, async client => {
    const now = Math.floor(Date.now() / 1000);
    const common = { checked_at: formatTime(now), env: args.env, base_url: baseUrl };
    if (queries) return outputJson({ ...common, ...await runQueries(client, args, queries) }, args);
    if (args.promql) {
      const result = await promQuery(client, args.promql);
      const output = { ...common, promql: args.promql, series_count: result.length, result };
      const breakdown = seriesBreakdown(result);
      if (breakdown) output.multi_series_warning = breakdown;
      return outputJson(output, args);
    }
    const lookback = prometheusDuration(args.lookback || DEFAULT_LOOKBACK);
    const options = {
      range: prometheusDuration(args.range || DEFAULT_RANGE), lookback,
      freshnessSeconds: parseDuration(args.freshness || DEFAULT_FRESHNESS),
      step: prometheusDuration(args.step || DEFAULT_STEP), end: now, start: now - parseDuration(lookback),
    };
    const rows = [];
    for (const metric of metrics) rows.push(await inspectMetric(client, args, metric, options));
    const summary = { ...common, range: options.range, lookback: options.lookback,
      freshness: args.freshness || DEFAULT_FRESHNESS, status_counts: countByStatus(rows), rows };
    if (args.output || String(args.format || 'table').toLowerCase() === 'json') outputJson(summary, args);
    else printTable(summary);
    if (rows.some(row => row.status === 'QUERY_ERROR')) process.exitCode = 1;
  });
}

module.exports = { inspectMetric, loadMetrics, loadQueries, parseBatchResults, parseDuration, runQueries, statusFor };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
