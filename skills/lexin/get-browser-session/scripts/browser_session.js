#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const {
  buildBrowserEnv,
  chromiumArgsFor,
  isWebShellUrl,
  redactUrl,
} = require('./browser_network');

const DEFAULT_URL = 'https://lexiao.oa.fenqile.com/#/app-publish/51303';
const DEFAULT_SUCCESS_TEXT = '当前环境';
const DEFAULT_WEBSHELL_PROFILE = '~/.codex/webshell-direct-profile';
const DEFAULT_LOGIN_PATTERN = [
  'Work Happy',
  'QR Code',
  'Use MOA',
  '\\bMOA\\b',
  'Account Login',
  'Password Login',
  'Sign in',
  '登录',
  '扫码',
  '账号',
  '密码',
  'SSO',
  'OAuth',
  '乐空间传送门',
  'ATrust',
].join('|');
const DEFAULT_PORTAL_PATTERN = '乐空间传送门|ATrust';
const FORBIDDEN_PATTERN = '403|Forbidden|无权限|拒绝访问';

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

function resolvePaths(args, url = DEFAULT_URL) {
  const toolDir = expandHome(args['tool-dir'] || process.env.BROWSER_SESSION_TOOL_DIR || '~/tools/lexiao-browser');
  const defaultProfile = isWebShellUrl(url) ? DEFAULT_WEBSHELL_PROFILE : '~/.cache/lexiao-browser-profile';
  return {
    toolDir,
    profileDir: expandHome(args.profile || process.env.BROWSER_SESSION_PROFILE || defaultProfile),
    chromePath: expandHome(args.chrome || path.join(toolDir, 'browsers/chrome-linux64/chrome')),
    runtimeLibDir: expandHome(args['runtime-lib-dir'] || path.join(toolDir, 'runtime-libs/usr/lib/x86_64-linux-gnu')),
    playwrightPackage: path.join(toolDir, 'package.json'),
  };
}

function loadPlaywright(paths) {
  if (!fs.existsSync(paths.playwrightPackage)) {
    throw new Error(`未找到 Playwright 工具目录：${paths.toolDir}`);
  }
  if (!fs.existsSync(paths.chromePath)) {
    throw new Error(`未找到 Chrome 可执行文件：${paths.chromePath}`);
  }
  const requireFromTool = createRequire(paths.playwrightPackage);
  return requireFromTool('playwright').chromium;
}

function inferWslgEnv(baseEnv) {
  const env = { ...baseEnv };
  if (!env.DISPLAY && fs.existsSync('/tmp/.X11-unix/X0')) {
    env.DISPLAY = ':0';
  }
  if (!env.WAYLAND_DISPLAY && fs.existsSync('/mnt/wslg/runtime-dir/wayland-0')) {
    env.WAYLAND_DISPLAY = 'wayland-0';
  }
  if (!env.XDG_RUNTIME_DIR && fs.existsSync('/mnt/wslg/runtime-dir')) {
    env.XDG_RUNTIME_DIR = '/mnt/wslg/runtime-dir';
  }
  if (!env.PULSE_SERVER && fs.existsSync('/mnt/wslg/PulseServer')) {
    env.PULSE_SERVER = '/mnt/wslg/PulseServer';
  }
  return env;
}

function looksLikeDisplayLaunchError(error) {
  const message = String(error?.stack || error?.message || error);
  return /Missing X server|DISPLAY|ozone_platform_x11|platform failed to initialize/i.test(message);
}

function loginScreenshotPath(url) {
  let host = 'page';
  try {
    host = new URL(url).hostname || host;
  } catch (_) {
    host = 'page';
  }
  const safeHost = host.replace(/[^a-zA-Z0-9.-]/g, '_');
  return path.join(os.tmpdir(), `browser-session-login-${safeHost}.png`);
}

function redact(value, showSecrets) {
  if (showSecrets) return value;
  if (!value) return value;
  if (value.length <= 8) return '<redacted>';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function hostname(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function classifyPageStatus(snapshot, options = {}) {
  const targetHost = hostname(options.targetUrl);
  const currentHost = hostname(snapshot.url);
  const webShell = isWebShellUrl(options.targetUrl);
  const onTargetHost = Boolean(targetHost && currentHost === targetHost);
  let sessionState = 'CONNECTING';
  let sessionReady = false;

  if (snapshot.hasForbiddenText) {
    sessionState = 'FORBIDDEN';
  } else if (snapshot.hasPortalText) {
    sessionState = 'PROXY_INTERCEPTED';
  } else if (snapshot.hasLoginText && (!webShell || !snapshot.terminalReady || snapshot.hasLoginControl)) {
    sessionState = 'LOGIN_REQUIRED';
  } else if (webShell) {
    sessionReady = onTargetHost && snapshot.terminalReady;
    sessionState = sessionReady ? 'READY' : 'CONNECTING';
  } else {
    sessionReady = onTargetHost && (options.successText ? snapshot.hasSuccessText : true);
    sessionState = sessionReady ? 'READY' : 'CONNECTING';
  }

  return {
    ...snapshot,
    targetHost,
    currentHost,
    isWebShell: webShell,
    onTargetHost,
    sessionState,
    sessionReady,
  };
}

async function collectStatus(page, options = {}) {
  const snapshot = await page.evaluate(({ successText, loginPattern, portalPattern, forbiddenPattern }) => {
    const bodyText = document.body ? document.body.innerText.replace(/\s+/g, ' ').trim() : '';
    const loginRegex = new RegExp(loginPattern, 'i');
    const portalRegex = new RegExp(portalPattern, 'i');
    const forbiddenRegex = new RegExp(forbiddenPattern, 'i');
    const hasPasswordInput = Boolean(document.querySelector('input[type="password"]'));
    const hasLoginControl = hasPasswordInput || Boolean(document.querySelector(
      'form[action*="login" i],input[name*="user" i],input[name*="account" i]'
    ));
    const terminalReady = Boolean(document.querySelector(
      'textarea,.xterm,.xterm-screen,x-screen,#terminal,[class*="xterm"]'
    ));
    const hasPortalText = /atrust/i.test(location.hostname) || (!terminalReady && portalRegex.test(bodyText));
    const hasForbiddenText = forbiddenRegex.test(document.title) || (!terminalReady && forbiddenRegex.test(bodyText));
    const buttons = Array.from(document.querySelectorAll('button')).map((button) => ({
      text: button.innerText.replace(/\s+/g, ' ').trim(),
      disabled: button.disabled || button.classList.contains('is-disabled'),
      className: String(button.className || ''),
    })).filter((button) => button.text);
    return {
      title: document.title,
      url: location.href,
      hasSuccessText: successText ? bodyText.includes(successText) : false,
      hasLoginText: loginRegex.test(bodyText) || hasPasswordInput,
      hasLoginControl,
      hasPortalText,
      hasForbiddenText,
      terminalReady,
      snippet: bodyText.slice(0, 1200),
      buttons,
    };
  }, options);
  return classifyPageStatus(snapshot, options);
}

async function collectStorage(page, options = {}) {
  const storage = await page.evaluate(({ keys, storageTypes }) => {
    const keySet = new Set(keys || []);
    const shouldInclude = (key) => keySet.size === 0 || keySet.has(key);
    const readStore = (type, store) => {
      const rows = [];
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (!shouldInclude(key)) continue;
        const value = store.getItem(key);
        rows.push({
          type,
          key,
          exists: value !== null,
          length: value ? value.length : 0,
          value,
        });
      }
      return rows;
    };

    const rows = [];
    if (storageTypes.includes('local')) rows.push(...readStore('local', localStorage));
    if (storageTypes.includes('session')) rows.push(...readStore('session', sessionStorage));

    if (keySet.size > 0) {
      for (const type of storageTypes) {
        for (const key of keySet) {
          if (!rows.some((item) => item.type === type && item.key === key)) {
            rows.push({ type, key, exists: false, length: 0, value: null });
          }
        }
      }
    }
    return rows;
  }, options);

  return storage.map((item) => ({
    ...item,
    value: redact(item.value, options.showSecrets),
  }));
}

async function clickNormalizedText(page, label) {
  return page.evaluate((wantedText) => {
    const normalize = (text) => (text || '').replace(/\s+/g, '').trim();
    const wanted = normalize(wantedText);
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const elements = Array.from(document.querySelectorAll(
      'button,a,[role="button"],.el-button,.ant-btn,.ant-tabs-tab,.el-tabs__item,li,span,div'
    )).filter(visible);
    const target = elements
      .map((el) => ({ el, text: normalize(el.innerText || el.textContent), className: String(el.className || '') }))
      .filter((item) => item.text === wanted || item.text.includes(wanted))
      .sort((a, b) => {
        const aInteractive = /^(BUTTON|A)$/.test(a.el.tagName) || a.el.getAttribute('role') === 'button' || /button|btn|tab|item/.test(a.className);
        const bInteractive = /^(BUTTON|A)$/.test(b.el.tagName) || b.el.getAttribute('role') === 'button' || /button|btn|tab|item/.test(b.className);
        if (aInteractive !== bInteractive) return aInteractive ? -1 : 1;
        return (a.text.length - wanted.length) - (b.text.length - wanted.length);
      })[0]?.el;
    if (!target) return { clicked: false, reason: 'not-found' };
    if (target.disabled || target.classList.contains('is-disabled')) return { clicked: false, reason: 'disabled' };
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return { clicked: true };
  }, label);
}

async function openContext(paths, chromium, headless, targetUrl) {
  const ldLibraryPath = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const network = buildBrowserEnv(targetUrl, process.env);
  const env = inferWslgEnv(network.env);
  env.LD_LIBRARY_PATH = ldLibraryPath;
  const context = await chromium.launchPersistentContext(paths.profileDir, {
    executablePath: paths.chromePath,
    headless,
    env,
    args: chromiumArgsFor(targetUrl, ['--no-sandbox']),
  });
  return { context, networkPolicy: network.networkPolicy };
}

async function waitForStableSession(page, options) {
  const deadline = Date.now() + options.timeoutMs;
  const requiredReadyPolls = isWebShellUrl(options.targetUrl)
    ? Number(options.stablePolls || 3)
    : 1;
  const stableDwellMs = isWebShellUrl(options.targetUrl)
    ? Number(options.stableDwellMs === undefined ? 2500 : options.stableDwellMs)
    : 0;
  let readyPolls = 0;
  let firstReadyAt = 0;
  let lastStatus = null;
  while (Date.now() < deadline) {
    let status;
    try {
      status = await collectStatus(page, options);
    } catch (error) {
      readyPolls = 0;
      firstReadyAt = 0;
      lastStatus = {
        sessionState: 'CONNECTING',
        sessionReady: false,
        statusError: String(error.message || error),
      };
      await page.waitForTimeout(options.pollMs);
      continue;
    }
    lastStatus = status;
    if (status.sessionReady) {
      if (readyPolls === 0) firstReadyAt = Date.now();
      readyPolls += 1;
    } else {
      readyPolls = 0;
      firstReadyAt = 0;
    }
    status.stableReadyPolls = readyPolls;
    status.requiredReadyPolls = requiredReadyPolls;
    status.stableReadyMs = firstReadyAt ? Date.now() - firstReadyAt : 0;
    status.requiredStableMs = stableDwellMs;
    if (readyPolls >= requiredReadyPolls && status.stableReadyMs >= stableDwellMs) return status;
    if (!options.waitForLogin && ['LOGIN_REQUIRED', 'PROXY_INTERCEPTED', 'FORBIDDEN'].includes(status.sessionState)) {
      return status;
    }
    await page.waitForTimeout(options.pollMs);
  }
  const status = lastStatus || await collectStatus(page, options);
  status.stableReadyPolls = readyPolls;
  status.requiredReadyPolls = requiredReadyPolls;
  status.stableReadyMs = firstReadyAt ? Date.now() - firstReadyAt : 0;
  status.requiredStableMs = stableDwellMs;
  if (readyPolls < requiredReadyPolls || status.stableReadyMs < stableDwellMs) {
    status.sessionReady = false;
    if (status.sessionState === 'READY') status.sessionState = 'CONNECTING';
    status.stabilityTimeout = true;
  }
  return status;
}

async function runPageFlow(paths, chromium, flow) {
  const launched = await openContext(paths, chromium, flow.headless, flow.url);
  const { context } = launched;
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(flow.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const options = {
      successText: flow.successText,
      loginPattern: flow.loginPattern,
      portalPattern: flow.portalPattern,
      forbiddenPattern: flow.forbiddenPattern,
      targetUrl: flow.url,
      stablePolls: flow.stablePolls,
      stableDwellMs: flow.stableDwellMs,
      waitForLogin: flow.waitForLogin,
      timeoutMs: flow.waitForLogin
        ? flow.timeoutMs
        : (isWebShellUrl(flow.url) ? Math.min(flow.timeoutMs, flow.statusTimeoutMs) : flow.timeoutMs),
      pollMs: flow.pollMs,
    };
    let status = (flow.waitForLogin || isWebShellUrl(flow.url))
      ? await waitForStableSession(page, options)
      : await collectStatus(page, options);
    status.browserMode = flow.headless ? 'headless' : 'headed';
    status.networkPolicy = launched.networkPolicy;
    status.profileDir = paths.profileDir;

    if (flow.screenshotOnLogin && !status.sessionReady) {
      const screenshot = loginScreenshotPath(flow.url);
      await page.screenshot({ path: screenshot, fullPage: true });
      status.loginScreenshot = screenshot;
      status.loginRequired = true;
    }

    if (flow.args['click-text']) {
      status.clickText = await clickNormalizedText(page, flow.args['click-text']);
      await page.waitForTimeout(1000);
    }
    if (flow.args['click-button']) {
      status.clickButton = await clickNormalizedText(page, flow.args['click-button']);
      await page.waitForTimeout(1000);
    }

    if (flow.mode === 'cookies') {
      const domain = flow.args.domain || new URL(status.url).hostname;
      const showSecrets = Boolean(flow.args['show-secrets']);
      const cookies = (await context.cookies()).filter((cookie) => cookie.domain.includes(domain)).map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
        value: redact(cookie.value, showSecrets),
      }));
      status.cookies = cookies;
      status.valuesRedacted = !showSecrets;
    }

    if (flow.mode === 'storage') {
      const showSecrets = Boolean(flow.args['show-secrets']);
      const storageType = String(flow.args['storage-type'] || 'local').toLowerCase();
      const storageTypes = storageType === 'both'
        ? ['local', 'session']
        : splitCsv(storageType).filter((item) => ['local', 'session'].includes(item));
      const keys = splitCsv(flow.args['storage-key'] || flow.args['storage-keys']);
      status.storage = await collectStorage(page, {
        keys,
        storageTypes: storageTypes.length ? storageTypes : ['local'],
        showSecrets,
      });
      status.valuesRedacted = !showSecrets;
    }

    status.requestedUrl = redactUrl(flow.url);
    status.url = redactUrl(status.url);
    return status;
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.ensure ? 'ensure' : args.cookies ? 'cookies' : args.storage ? 'storage' : args.doctor ? 'doctor' : 'status';
  const url = args.url || DEFAULT_URL;
  const paths = resolvePaths(args, url);
  const successText = args['success-text'] === 'none' ? '' : (args['success-text'] || DEFAULT_SUCCESS_TEXT);
  const loginPattern = args['login-pattern'] || DEFAULT_LOGIN_PATTERN;
  const portalPattern = args['portal-pattern'] || DEFAULT_PORTAL_PATTERN;
  const forbiddenPattern = args['forbidden-pattern'] || FORBIDDEN_PATTERN;
  const timeoutMs = Number(args.timeout || 300000);
  const pollMs = Number(args.poll || 2000);
  const stablePolls = Number(args['stable-polls'] || 3);
  const stableDwellMs = Number(args['stable-dwell-ms'] || 2500);
  const statusTimeoutMs = Number(args['status-timeout'] || 10000);
  const headless = mode !== 'ensure' && !args.headed;

  if (mode === 'doctor') {
    const inferredEnv = inferWslgEnv(process.env);
    console.log(JSON.stringify({
      toolDir: paths.toolDir,
      profileDir: paths.profileDir,
      chromePath: paths.chromePath,
      hasToolPackage: fs.existsSync(paths.playwrightPackage),
      hasChrome: fs.existsSync(paths.chromePath),
      hasProfile: fs.existsSync(paths.profileDir),
      displayEnv: {
        DISPLAY: inferredEnv.DISPLAY || '',
        WAYLAND_DISPLAY: inferredEnv.WAYLAND_DISPLAY || '',
        XDG_RUNTIME_DIR: inferredEnv.XDG_RUNTIME_DIR || '',
        PULSE_SERVER: inferredEnv.PULSE_SERVER || '',
      },
    }, null, 2));
    return;
  }

  const chromium = loadPlaywright(paths);

  const baseFlow = {
    args,
    mode,
    url,
    successText,
    loginPattern,
    portalPattern,
    forbiddenPattern,
    timeoutMs,
    pollMs,
    stablePolls,
    stableDwellMs,
    statusTimeoutMs,
  };
  if (mode === 'ensure') {
    const status = await runPageFlow(paths, chromium, {
      ...baseFlow,
      headless: true,
      waitForLogin: false,
      screenshotOnLogin: false,
    });
    if (status.sessionReady) {
      status.ensureStrategy = 'headless-fast-path';
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    try {
      const ensured = await runPageFlow(paths, chromium, {
        ...baseFlow,
        headless: false,
        waitForLogin: true,
        screenshotOnLogin: false,
      });
      ensured.ensureStrategy = 'headed-login';
      console.log(JSON.stringify(ensured, null, 2));
      return;
    } catch (error) {
      if (!looksLikeDisplayLaunchError(error)) {
        throw error;
      }
      const fallback = await runPageFlow(paths, chromium, {
        ...baseFlow,
        headless: true,
        waitForLogin: false,
        screenshotOnLogin: true,
      });
      fallback.ensureStrategy = 'headless-screenshot';
      fallback.headedLaunchError = 'headed Chromium unavailable; saved login screenshot for manual scan';
      console.log(JSON.stringify(fallback, null, 2));
      return;
    }
  }

  const status = await runPageFlow(paths, chromium, {
    ...baseFlow,
    headless,
    waitForLogin: false,
    screenshotOnLogin: false,
  });
  console.log(JSON.stringify(status, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_LOGIN_PATTERN,
  DEFAULT_PORTAL_PATTERN,
  classifyPageStatus,
  collectStatus,
  parseArgs,
  resolvePaths,
  waitForStableSession,
};
