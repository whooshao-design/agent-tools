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

const DEFAULT_BUSINESS_LINE = '风控研发中心';
const DEFAULT_CLUSTER = 'Default';
const DEFAULT_LANGUAGE = 'zh';
const DEFAULT_PROFILE = '/tmp/healthy-metrics-profile';
const DEFAULT_TOOL_DIR = '~/tools/lexiao-browser';

const APP_LABELS = {
  server_hawk_decision_dispatcher: '米霍克dispatcher主应用',
  server_hawk_decision_dispatcher_ec: '米霍克dispatcher EC应用',
  server_hawk_decision_dispatcher_batch: '米霍克dispatcher批跑应用',
  server_hawk_decision_dispatcher_simulate: '米霍克dispatcher仿真应用',
};

const SUFFIX_LABELS = {
  dubbo_active_count: '活跃线程数',
  dubbo_pool_size: '当前线程数',
  dubbo_queue_size: '队列大小',
  dubbo_queue_remaining_capacity: '队列剩余容量',
};

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

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
  register_metrics.js --env=stable --metrics=fql_fk_xxx_dubbo_active_count [--token=...] [--apply]
  register_metrics.js --env=prod --apps=app1,app2 --suffixes=dubbo_active_count,dubbo_pool_size --profile=/tmp/profile --apply
  register_metrics.js --env=stable --metrics-file=/tmp/metrics.json --desc-map=/tmp/desc-map.json --plan-only

Options:
  --env              stable|test|prod|online
  --base-url         Override API base URL
  --metrics          Comma or newline separated metric names
  --metrics-file     JSON array of metric strings/objects, or {"metrics":[...],"descMap":{...}}
  --apps             Comma separated app names, used with --suffixes
  --suffixes         Comma separated suffixes, used with --apps
  --desc-map         JSON object. Keys may be metric, app:suffix, or suffix
  --app-label-map    JSON object for app display names used by generated desc
  --business-line    Defaults to 风控研发中心
  --token            Bearer token. Also supports env HEALTHY_METRIC_TOKEN
  --profile          Browser profile with Healthy login state
  --tool-dir         Local Playwright tool dir, defaults to ~/tools/lexiao-browser
  --apply            POST missing metrics. Without --apply only dry-runs
  --plan-only        Only expand fields, no network access
  --retry-times      Verification retries after registration, default 3
  --retry-delay-ms   Verification delay, default 3000
`);
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

function loadInput(args) {
  const descMap = {};
  const appLabelMap = { ...APP_LABELS };
  const targets = [];

  const metricsFile = readJsonFile(args['metrics-file']);
  if (metricsFile) {
    if (Array.isArray(metricsFile)) {
      for (const item of metricsFile) targets.push(normalizeMetricItem(item));
    } else if (Array.isArray(metricsFile.metrics)) {
      for (const item of metricsFile.metrics) targets.push(normalizeMetricItem(item));
      Object.assign(descMap, metricsFile.descMap || {});
      Object.assign(appLabelMap, metricsFile.appLabelMap || {});
    } else {
      throw new Error('--metrics-file must be an array or an object with metrics array');
    }
  }

  for (const metric of splitList(args.metrics)) {
    targets.push({ metric });
  }

  const apps = splitList(args.apps);
  const suffixes = splitList(args.suffixes);
  if (apps.length || suffixes.length) {
    if (!apps.length || !suffixes.length) {
      throw new Error('--apps and --suffixes must be provided together');
    }
    for (const app of apps) {
      for (const suffix of suffixes) {
        targets.push({ metric: `fql_fk_${app}_${suffix}` });
      }
    }
  }

  Object.assign(descMap, readJsonFile(args['desc-map']) || {});
  Object.assign(appLabelMap, readJsonFile(args['app-label-map']) || {});

  const unique = [];
  const seen = new Set();
  for (const target of targets) {
    if (!target.metric || seen.has(target.metric)) continue;
    seen.add(target.metric);
    unique.push(target);
  }
  if (!unique.length) throw new Error('No metrics provided');
  return { targets: unique, descMap, appLabelMap, userSuffixes: suffixes };
}

function normalizeMetricItem(item) {
  if (typeof item === 'string') return { metric: item };
  if (item && typeof item === 'object' && item.metric) {
    return {
      metric: String(item.metric),
      desc: item.desc ? String(item.desc) : undefined,
      app: item.app ? String(item.app) : undefined,
    };
  }
  throw new Error(`Invalid metric item: ${JSON.stringify(item)}`);
}

function parseMetric(metric, suffixes) {
  if (!metric.startsWith('fql_fk_')) {
    throw new Error(`Metric must start with fql_fk_: ${metric}`);
  }
  const sortedSuffixes = Array.from(new Set([...Object.keys(SUFFIX_LABELS), ...suffixes]))
    .sort((a, b) => b.length - a.length);
  for (const suffix of sortedSuffixes) {
    const tail = `_${suffix}`;
    if (metric.endsWith(tail)) {
      const app = metric.slice('fql_fk_'.length, -tail.length);
      if (!app) throw new Error(`Cannot parse app from metric: ${metric}`);
      return { app, suffix };
    }
  }
  throw new Error(`Cannot parse known suffix from metric: ${metric}`);
}

function buildPlan(input, args) {
  const businessLine = args['business-line'] || DEFAULT_BUSINESS_LINE;
  return input.targets.map((target) => {
    const parsed = parseMetric(target.metric, input.userSuffixes);
    const app = target.app || parsed.app;
    const desc = resolveDesc(target, app, parsed.suffix, input.descMap, input.appLabelMap);
    return {
      metric: target.metric,
      app,
      suffix: parsed.suffix,
      body: {
        metric: target.metric,
        desc,
        business_line: businessLine,
        app,
        enable: true,
      },
      descSource: desc.source,
    };
  });
}

function resolveDesc(target, app, suffix, descMap, appLabelMap) {
  let value = target.desc;
  let source = 'metric-item';
  if (!value && descMap[target.metric]) {
    value = descMap[target.metric];
    source = 'desc-map:metric';
  }
  if (!value && descMap[`${app}:${suffix}`]) {
    value = descMap[`${app}:${suffix}`];
    source = 'desc-map:app-suffix';
  }
  if (!value && descMap[suffix]) {
    value = descMap[suffix];
    source = 'desc-map:suffix';
  }
  if (!value) {
    const suffixLabel = SUFFIX_LABELS[suffix];
    if (!suffixLabel) {
      throw new Error(`No desc mapping for suffix ${suffix}; provide --desc-map`);
    }
    value = `${appLabelMap[app] || app}Dubbo线程池${suffixLabel}`;
    source = 'generated';
  }
  const result = String(value);
  result.source = source;
  return result;
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

async function extractTokenFromProfile(args, baseUrl) {
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
      return {
        token: tokenKey ? localStorage.getItem(tokenKey) : '',
        tokenKey,
        title: document.title,
        snippet: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 200),
      };
    });
    if (!auth.token) {
      throw new Error(`No access token in profile. Page title=${auth.title}, snippet=${auth.snippet}`);
    }
    return auth.token;
  } finally {
    await context.close().catch(() => {});
  }
}

function authHeaders(token, url, hasBody, args) {
  const headers = {
    accept: 'application/json',
    'x-cluster': args.cluster || DEFAULT_CLUSTER,
    'x-language': args.language || DEFAULT_LANGUAGE,
  };
  if (hasBody) headers['content-type'] = 'application/json;charset=UTF-8';
  if (token) headers.authorization = `Bearer ${token}`;
  if (hasBody) {
    const origin = new URL(url).origin;
    headers.origin = origin;
    headers.referer = `${origin}/sys-manage/metric-manage`;
  }
  return headers;
}

async function requestJson(method, url, token, args, body, redirectsLeft = 3) {
  const response = await fetch(url, {
    method,
    headers: authHeaders(token, url, Boolean(body), args),
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  if ([301, 302, 307, 308].includes(response.status) && response.headers.get('location') && redirectsLeft > 0) {
    const nextUrl = new URL(response.headers.get('location'), url).toString();
    return requestJson(method, nextUrl, token, args, body, redirectsLeft - 1);
  }

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`${method} ${url} returned non-json status=${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok || json.err) {
    throw new Error(`${method} ${url} failed status=${response.status} err=${json.err || ''}`);
  }
  return json;
}

function metricManageUrl(baseUrl, metric) {
  const url = new URL('/api/n9e/metric-manage', baseUrl);
  if (metric) {
    url.searchParams.set('query', metric);
    url.searchParams.set('exporter_type', '');
    url.searchParams.set('p', '1');
    url.searchParams.set('limit', '15');
  }
  return url.toString();
}

async function queryMetric(baseUrl, token, args, metric) {
  const json = await requestJson('GET', metricManageUrl(baseUrl, metric), token, args);
  const list = json.dat?.list || [];
  return list.filter((item) => item.metric === metric || item.standard_metric === metric);
}

async function registerMetric(baseUrl, token, args, body) {
  await requestJson('POST', metricManageUrl(baseUrl), token, args, body);
}

function metadataMismatch(plan, hit) {
  const mismatches = [];
  if ((hit.app || '') !== plan.body.app) {
    mismatches.push(`app existing=${hit.app || ''} expected=${plan.body.app}`);
  }
  if ((hit.desc || '') !== plan.body.desc) {
    mismatches.push(`desc existing=${hit.desc || ''} expected=${plan.body.desc}`);
  }
  return mismatches;
}

function printPlan(plan) {
  for (const item of plan) {
    console.log(`PLAN\t${item.metric}\tapp=${item.body.app}\tdesc=${item.body.desc}\tbusiness_line=${item.body.business_line}\tenable=${item.body.enable}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }

  const env = normalizeEnv(args.env || 'stable');
  const baseUrl = args['base-url'] || BASE_URLS[env];
  const input = loadInput(args);
  const plan = buildPlan(input, args);

  if (args['plan-only']) {
    printPlan(plan);
    return;
  }

  const token = args.token || process.env.HEALTHY_METRIC_TOKEN
    || (args.profile ? await extractTokenFromProfile(args, baseUrl) : '');
  if (!token) {
    throw new Error('Missing auth. Provide --token, HEALTHY_METRIC_TOKEN, or --profile with Healthy login state.');
  }

  const created = [];
  for (const item of plan) {
    const hits = await queryMetric(baseUrl, token, args, item.metric);
    if (hits.length) {
      const mismatch = metadataMismatch(item, hits[0]);
      if (mismatch.length) {
        console.log(`EXISTS_MISMATCH\t${item.metric}\tids=${hits.map((hit) => hit.id).join(',')}\t${mismatch.join('\t')}`);
      } else {
        console.log(`SKIP_EXISTS\t${item.metric}\tids=${hits.map((hit) => hit.id).join(',')}`);
      }
      continue;
    }

    if (!args.apply) {
      console.log(`PLAN_REGISTER\t${item.metric}\tapp=${item.body.app}\tdesc=${item.body.desc}`);
      continue;
    }

    await registerMetric(baseUrl, token, args, item.body);
    created.push(item);
    console.log(`REGISTER_OK\t${item.metric}`);
  }

  if (!args.apply || !created.length) return;

  const retryTimes = Number(args['retry-times'] || 3);
  const retryDelayMs = Number(args['retry-delay-ms'] || 3000);
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));

  for (const item of created) {
    let hits = [];
    for (let attempt = 0; attempt < retryTimes; attempt += 1) {
      hits = await queryMetric(baseUrl, token, args, item.metric);
      if (hits.length) break;
      if (attempt + 1 < retryTimes) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    if (hits.length) {
      console.log(`VERIFY_FOUND\t${item.metric}\tids=${hits.map((hit) => hit.id).join(',')}\tapp=${hits[0].app || ''}\tdesc=${hits[0].desc || ''}`);
    } else {
      console.log(`VERIFY_MISSING\t${item.metric}`);
      process.exitCode = 2;
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
