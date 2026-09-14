'use strict';

const { createRequire } = require('module');
const { acquireProfileLock, parseArgs, resolvePaths } = require('../../get-browser-session/scripts/browser_session');
const { buildBrowserEnv, chromiumArgsFor } = require('../../get-browser-session/scripts/browser_network');

const DEFAULT_PROFILE = '/home/joney/.local/state/agent-tools/browser-profiles/healthy';
const BASE_URLS = {
  stable: 'https://stable-eye.oa.fenqile.com',
  prod: 'https://healthy.lexincloud.com',
};

function resolveBaseUrl(args, defaultEnv = 'prod') {
  const aliases = { test: 'stable', prj: 'stable', '测试': 'stable', pre: 'prod', online: 'prod', '线上': 'prod', '生产': 'prod' };
  const env = String(args.env || defaultEnv).toLowerCase();
  const baseUrl = args['base-url'] || BASE_URLS[aliases[env] || env];
  if (!Object.values(BASE_URLS).includes(baseUrl)) throw new Error(`不支持的 Healthy 环境或站点：${env}`);
  return baseUrl;
}

// 此函数在页面内执行；刷新令牌不能用作 API 的 Bearer 凭据。
function readPageAuth() {
  return { token: localStorage.getItem('access_token') || '', ticket: localStorage.getItem('ticket') || '' };
}

function apiUrl(baseUrl, route) {
  const url = new URL(route, baseUrl);
  if (url.origin !== baseUrl || !url.pathname.startsWith('/api/n9e/') || url.username || url.password) {
    throw new Error('Healthy 请求必须是当前站点的 /api/n9e/ 接口');
  }
  return url.toString();
}

async function requestJson(page, baseUrl, args, method, route, body) {
  const url = apiUrl(baseUrl, route);
  const auth = args.token ? { token: args.token, ticket: args.ticket || '' } : await page.evaluate(readPageAuth);
  if (!auth.token) throw new Error(`未获取 access_token；请用 get-browser-session 刷新 ${baseUrl} 的同一 profile`);
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json;charset=UTF-8',
    'x-cluster': args.cluster || 'Default',
    'x-language': args.language || 'zh',
    authorization: `Bearer ${auth.token}`,
  };
  if (auth.ticket) headers.ticket = auth.ticket;
  const timeoutMs = Number(args['http-timeout'] || 60000);
  const response = await page.evaluate(async ({ url, method, headers, body, timeoutMs }) => {
    let resp;
    try {
      resp = await fetch(url, {
        method, headers, credentials: 'include', redirect: 'error',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // 只传递错误类型，避免浏览器的错误正文泄露凭据，同时供只读调用方判定是否重试。
      return { transportError: error.name };
    }
    // 不把登录页正文或认证信息带入错误输出。
    let json = null;
    try { json = await resp.json(); } catch (error) {
      if (error.name !== 'SyntaxError') return { transportError: error.name };
      // 非 JSON 响应由调用端根据 HTTP 状态统一报告。
    }
    return { status: resp.status, ok: resp.ok, json };
  }, { url, method, headers, body, timeoutMs });
  if (response.transportError) {
    const error = new Error(`${method} ${new URL(url).pathname} 请求失败：${response.transportError}`);
    error.name = response.transportError;
    throw error;
  }
  if (!response.ok || !response.json || response.json.err || response.json.status === 'error') {
    const hint = [401, 403].includes(response.status) ? '；请刷新同一 profile 的登录态' : '';
    const error = new Error(`${method} ${new URL(url).pathname} 失败：HTTP ${response.status}${hint}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function openSessionPage(page, baseUrl, explicitToken) {
  if (explicitToken) {
    // 显式凭据模式无需浏览器已有登录态；本地空白文档只提供同源 fetch 上下文。
    const url = `${baseUrl}/__agent_tools_request__`;
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Healthy API</title>' }));
    try { await page.goto(url, { waitUntil: 'domcontentloaded' }); } finally { await page.unroute(url); }
    return;
  }
  await page.goto(`${baseUrl}/dashboards`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  if (new URL(page.url()).origin !== baseUrl) throw new Error(`Healthy 登录态失效；请刷新 ${baseUrl} 的同一 profile`);
}

// 一次任务共用一个持久会话。锁覆盖整个任务，防止多个工具同时打开同一 profile。
async function withHealthyClient(args, action) {
  const baseUrl = resolveBaseUrl(args);
  const paths = resolvePaths({ ...args, profile: args.profile || DEFAULT_PROFILE }, baseUrl);
  const release = await acquireProfileLock(paths.profileDir);
  let context;
  try {
    const chromium = createRequire(paths.playwrightPackage)('playwright').chromium;
    const env = buildBrowserEnv(baseUrl).env;
    env.LD_LIBRARY_PATH = [paths.runtimeLibDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    context = await chromium.launchPersistentContext(paths.profileDir, {
      executablePath: paths.chromePath, headless: true, env,
      args: chromiumArgsFor(baseUrl, ['--no-sandbox', '--disable-dev-shm-usage']),
    });
    const page = await context.newPage();
    await openSessionPage(page, baseUrl, Boolean(args.token));
    return await action({
      baseUrl, page,
      request: (method, route, body) => requestJson(page, baseUrl, args, method, route, body),
    });
  } finally {
    try { if (context) await context.close(); } finally { release(); }
  }
}

module.exports = { DEFAULT_PROFILE, apiUrl, openSessionPage, parseArgs, readPageAuth, requestJson, resolveBaseUrl, withHealthyClient };
