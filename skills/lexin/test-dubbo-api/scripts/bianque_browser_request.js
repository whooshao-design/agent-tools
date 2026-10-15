#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const { launchLockedContext } = require('../../get-browser-session/scripts/browser_session');
const sessionCache = require('../../get-browser-session/scripts/session_cache');

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

function resolvePaths(args) {
  const toolDir = expandHome(args['tool-dir'] || process.env.BROWSER_SESSION_TOOL_DIR || '~/tools/lexiao-browser');
  return {
    toolDir,
    profileDir: expandHome(
      args.profile
      || process.env.BROWSER_SESSION_PROFILE
      || process.env.DEVTOOLS_BROWSER_PROFILE
      || '~/.local/state/agent-tools/browser-profiles/main'
    ),
    chromePath: expandHome(args.chrome || path.join(toolDir, 'browsers/chrome-linux64/chrome')),
    runtimeLibDir: expandHome(args['runtime-lib-dir'] || path.join(toolDir, 'runtime-libs/usr/lib/x86_64-linux-gnu')),
    playwrightPackage: path.join(toolDir, 'package.json'),
  };
}

function loadPlaywright(paths) {
  if (!fs.existsSync(paths.playwrightPackage)) {
    throw new Error(`missing Playwright tool dir: ${paths.toolDir}`);
  }
  if (!fs.existsSync(paths.chromePath)) {
    throw new Error(`missing Chrome executable: ${paths.chromePath}`);
  }
  const requireFromTool = createRequire(paths.playwrightPackage);
  return requireFromTool('playwright').chromium;
}

function required(args, name) {
  const value = args[name];
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolvePaths(args);
  const chromium = loadPlaywright(paths);
  const baseUrl = required(args, 'base-url').replace(/\/+$/, '');
  const routeEnv = required(args, 'route-env');
  const bianqueEnv = required(args, 'env');
  const service = required(args, 'service');
  const method = required(args, 'method');
  const ip = required(args, 'ip');
  const port = required(args, 'port');
  const group = args.group || 'default';
  const version = args.version || '2.0.0';
  const params = args.params || '[]';
  const timeoutMs = Number(args['timeout-ms'] || 120000);
  const form = { env: bianqueEnv, service, ip, port, group, version, method, params, comment: '', stringFlag: 'false' };
  const requestUrl = `${baseUrl}/serviceEmulator/request`;

  // Cache hit: post straight from Node and skip Chromium (and the profile lock) entirely.
  // The Dubbo method may write, so only a clear login rejection (request never ran) falls back to
  // the browser; timeouts and HTTP errors are reported instead of being re-sent.
  const cookieHeader = sessionCache.readCookieHeader(paths.profileDir, requestUrl);
  if (cookieHeader) {
    const result = await sessionCache.fetchWithCookies(cookieHeader, requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(form).toString(),
      timeoutMs,
      referer: `${baseUrl}/`,
    });
    if (!sessionCache.looksUnauthenticated(result)) {
      if (!result.ok) {
        throw new Error(`Bianque request failed: HTTP ${result.status} ${result.text.slice(0, 500)}`);
      }
      console.log(result.text);
      return;
    }
    sessionCache.invalidate(paths.profileDir, requestUrl);
  }

  const ldLibraryPath = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

  const context = await launchLockedContext(chromium, paths.profileDir, {
    executablePath: paths.chromePath,
    headless: !args.headed,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: ldLibraryPath,
      NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || '.fenqile.com,.lexinfintech.com,.lexincloud.com,localhost,127.0.0.1',
      no_proxy: process.env.no_proxy || process.env.NO_PROXY || '.fenqile.com,.lexinfintech.com,.lexincloud.com,localhost,127.0.0.1',
    },
    args: ['--no-sandbox', '--no-proxy-server'],
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    const route = `${baseUrl}/#/serviceEmulator/${encodeURIComponent(routeEnv)}/${encodeURIComponent(service)}/${encodeURIComponent(ip)}/${encodeURIComponent(port)}/${encodeURIComponent(group)}/${encodeURIComponent(version)}`;
    await page.goto(route, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 20000) }).catch(() => {});
    const result = await page.evaluate(async ({ form, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const body = new URLSearchParams(form);
        const response = await fetch('/serviceEmulator/request', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body,
          signal: controller.signal,
        });
        return {
          status: response.status,
          ok: response.ok,
          text: await response.text(),
        };
      } finally {
        clearTimeout(timer);
      }
    }, { form, timeoutMs });

    if (!result.ok) {
      throw new Error(`Bianque request failed: HTTP ${result.status} ${result.text.slice(0, 500)}`);
    }
    await sessionCache.saveContextCookies(context, paths.profileDir, requestUrl);
    console.log(result.text);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
