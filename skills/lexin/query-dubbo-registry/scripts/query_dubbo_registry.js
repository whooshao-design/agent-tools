#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

// bianque 服务治理平台。站点划分沿用 test-dubbo-api 的约定。
const BASE_URLS = {
  pre: 'https://bianque.lexinfintech.com',
  prod: 'https://bianque.lexinfintech.com',
  online: 'https://bianque.lexinfintech.com',
  gray: 'https://bianque.lexinfintech.com',
  stable: 'https://stable-bianque.lexinfintech.com',
  test: 'https://stable-bianque.lexinfintech.com',
};

const DEFAULT_SITE = 'pre';
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_TOOL_DIR = '~/tools/lexiao-browser';
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 2;

// 平台接口本身把 catogory 拼错了，这里必须照抄，不要"修正"成 category。
const CATEGORY_PARAM = 'catogory';

function usage() {
  console.log(`Usage:
  query_dubbo_registry.js --service=com.fenqile.xxx.FooService          # 谁提供这个服务
  query_dubbo_registry.js --service=FooService --role=consumer          # 谁在调这个服务
  query_dubbo_registry.js --app=server_xxx_java                         # 该应用注册了哪些服务
  query_dubbo_registry.js --services=a,b,c --format=json                # 批量解析归属，供其他脚本消费

Options:
  --service        服务名，支持短名模糊匹配（如 ExpressRuleRunnerService）
  --services       逗号分隔的多个服务名，批量查询
  --app            按应用名反查它注册的服务
  --role           provider（默认）| consumer
  --site           pre|prod|online|gray|stable|test，默认 pre（线上与预发共用 bianque）
  --instances      输出提供者实例地址明细
  --format         table（默认）| json
  --page-size      单次查询条数，默认 200
  --concurrency    批量查询并发数，默认 4
  --cookie         bianque Cookie，也可用环境变量 BIANQUE_COOKIE
  --profile        浏览器 profile，默认取 BROWSER_SESSION_PROFILE / DEVTOOLS_BROWSER_PROFILE / ~/.cache/lexiao-browser-profile
  --http-timeout   单次请求超时毫秒，默认 30000
  --retries        可重试错误的重试次数，默认 2
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

function str(value) {
  return value && value !== true ? String(value) : '';
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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

// ---------------------------------------------------------------- cookie

function resolvePaths(args) {
  const toolDir = expandHome(args['tool-dir'] || process.env.BROWSER_SESSION_TOOL_DIR || DEFAULT_TOOL_DIR);
  return {
    toolDir,
    profileDir: expandHome(
      args.profile
      || process.env.BROWSER_SESSION_PROFILE
      || process.env.DEVTOOLS_BROWSER_PROFILE
      || '~/.cache/lexiao-browser-profile',
    ),
    chromePath: expandHome(args.chrome || path.join(toolDir, 'browsers/chrome-linux64/chrome')),
    runtimeLibDir: expandHome(args['runtime-lib-dir'] || path.join(toolDir, 'runtime-libs/usr/lib/x86_64-linux-gnu')),
    playwrightPackage: path.join(toolDir, 'package.json'),
  };
}

async function extractCookieFromProfile(args, baseUrl) {
  const paths = resolvePaths(args);
  if (!fs.existsSync(paths.playwrightPackage)) {
    throw new Error(`没有找到 Playwright 工具目录: ${paths.toolDir}`);
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
    const cookies = await context.cookies(baseUrl);
    if (!cookies.length) {
      throw new Error(`profile 里没有 ${new URL(baseUrl).host} 的 Cookie，请先用 get-browser-session 登录 bianque。`);
    }
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } finally {
    await context.close().catch(() => {});
  }
}

async function resolveCookie(args, baseUrl) {
  const cookie = str(args.cookie) || process.env.BIANQUE_COOKIE;
  if (cookie) return cookie;
  return extractCookieFromProfile(args, baseUrl);
}

// ---------------------------------------------------------------- http

class RetryableError extends Error {}

async function fetchText(ctx, url) {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.httpTimeout);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain, */*',
          cookie: ctx.cookie,
          referer: `${ctx.baseUrl}/`,
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableError(`HTTP ${response.status}: ${text.slice(0, 160)}`);
      }
      return { status: response.status, text };
    } catch (error) {
      const retryable = error instanceof RetryableError
        || error.name === 'AbortError'
        || error.name === 'TypeError';
      if (!retryable || attempt >= ctx.retries) {
        if (error.name === 'AbortError') throw new Error(`bianque 请求超时（${ctx.httpTimeout}ms，已重试 ${attempt} 次）`);
        throw error;
      }
      await delay(300 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

// 治理平台原始查询。name 支持短名模糊匹配。
async function queryRegistry(ctx, { name = '', appName = '', role = 'provider' }) {
  const url = new URL('/governance/services/list', ctx.baseUrl);
  url.searchParams.set('name', name);
  url.searchParams.set('ip', '');
  url.searchParams.set('port', '');
  url.searchParams.set('appName', appName);
  url.searchParams.set('version', '');
  url.searchParams.set('group', '');
  url.searchParams.set(CATEGORY_PARAM, role);
  url.searchParams.set('pageIndex', '1');
  url.searchParams.set('pageSize', String(ctx.pageSize));

  const { status, text } = await fetchText(ctx, url.toString());
  // 登录态失效时平台返回 401 且响应体为空，不要让它掉进"返回非 JSON"的分支报出无意义的 status=undefined。
  if (status === 401 || status === 403) {
    throw new Error(`bianque 登录态失效（HTTP ${status}）。请用 get-browser-session 重新登录 bianque，或传 --cookie / 设置 BIANQUE_COOKIE。`);
  }
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`bianque 返回非 JSON（HTTP ${status}），通常是被重定向到登录页，请用 get-browser-session 重新登录。`);
  }
  if (json.status !== 0) {
    throw new Error(`bianque 查询失败: HTTP ${status} status=${json.status} message=${json.message || '(空响应)'}`);
  }
  const data = json.data || {};
  return { total: data.total || 0, list: data.list || [] };
}

// consumer 类目下 application 是逗号拼接的多个应用，必须拆开。
function splitApps(application) {
  return String(application || '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

function summarize(list) {
  const byService = new Map();
  for (const item of list) {
    const service = item.serviceName || '';
    if (!byService.has(service)) byService.set(service, new Map());
    const byApp = byService.get(service);
    for (const app of splitApps(item.application)) {
      const key = `${app}${item.version || ''}${item.group || ''}`;
      if (!byApp.has(key)) {
        byApp.set(key, {
          application: app, version: item.version || '', group: item.group || '', instances: [],
        });
      }
      if (item.ip) byApp.get(key).instances.push(item.ip);
    }
  }
  return [...byService.entries()].map(([service, byApp]) => ({
    service,
    entries: [...byApp.values()].sort((a, b) => a.application.localeCompare(b.application)),
    applications: [...new Set([...byApp.values()].map((e) => e.application))].sort(),
  })).sort((a, b) => a.service.localeCompare(b.service));
}

// ---------------------------------------------------------------- output

function printTable(role, results, showInstances) {
  if (!results.length) { console.log('  没有查到注册记录'); return; }
  for (const item of results) {
    console.log(`\n${item.service}`);
    if (!item.entries.length) { console.log('  (无注册记录)'); continue; }
    for (const entry of item.entries) {
      const inst = entry.instances.length;
      console.log(`  ${role === 'consumer' ? '消费方' : '提供方'} ${entry.application}`
        + `  version=${entry.version || '-'}  group=${entry.group || '-'}  实例数=${inst}`);
      if (showInstances && inst) {
        entry.instances.slice(0, 20).forEach((ip) => console.log(`      ${ip}`));
        if (inst > 20) console.log(`      … 其余 ${inst - 20} 个`);
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { usage(); return 0; }

  const site = String(args.site || DEFAULT_SITE).toLowerCase();
  const baseUrl = args['base-url'] || BASE_URLS[site];
  if (!baseUrl) throw new Error(`未知站点: ${site}，可选 ${Object.keys(BASE_URLS).join('|')}`);

  const role = String(args.role || 'provider').toLowerCase();
  if (!['provider', 'consumer'].includes(role)) throw new Error(`--role 只能是 provider 或 consumer，收到: ${role}`);

  const services = str(args.services) ? str(args.services).split(',').map((s) => s.trim()).filter(Boolean)
    : (str(args.service) ? [str(args.service)] : []);
  const appName = str(args.app);
  if (!services.length && !appName) { usage(); throw new Error('必须提供 --service / --services / --app'); }

  const ctx = {
    baseUrl,
    cookie: await resolveCookie(args, baseUrl),
    pageSize: Number(args['page-size']) || DEFAULT_PAGE_SIZE,
    httpTimeout: Number(args['http-timeout']) || DEFAULT_HTTP_TIMEOUT_MS,
    retries: args.retries === undefined ? DEFAULT_RETRIES : Math.max(0, Number(args.retries) || 0),
  };

  let results;
  if (appName) {
    const { list } = await queryRegistry(ctx, { appName, role });
    results = summarize(list);
  } else {
    const concurrency = Number(args.concurrency) || DEFAULT_CONCURRENCY;
    const pages = await pMap(services, (name) => queryRegistry(ctx, { name, role }), concurrency);
    results = summarize(pages.flatMap((p) => p.list));
  }

  if (String(args.format || 'table') === 'json') {
    // service -> 应用清单，供 inspect-app-call-topology 之类的脚本直接消费。
    const ownerMap = Object.fromEntries(results.map((r) => [r.service, r.applications]));
    console.log(JSON.stringify({
      site, baseUrl, role, query: { services, appName }, ownerMap, results,
    }, null, 2));
    return 0;
  }

  console.log(`\nbianque ${site} · ${baseUrl} · role=${role}`
    + (appName ? ` · app=${appName}` : ` · ${services.length} 个服务`));
  printTable(role, results, Boolean(args.instances));
  const apps = [...new Set(results.flatMap((r) => r.applications))].sort();
  console.log(`\n涉及应用（${apps.length}）: ${apps.join(', ') || '无'}\n`);
  return 0;
}

main()
  .then((code) => { process.exitCode = code || 0; })
  .catch((error) => {
    console.error(`\n[query-dubbo-registry] ${error.message}\n`);
    process.exit(1);
  });
