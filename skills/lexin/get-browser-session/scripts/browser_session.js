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
const DEFAULT_WEBSHELL_PROFILE = '~/.local/state/agent-tools/browser-profiles/webshell';
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
const PROFILE_LOCK_STALE_MS = 60 * 60 * 1000;
const PROFILE_LOCK_WAIT_MS = 300000;
// The login state a read needs. Everything else in a profile (1.1G on main, mostly caches) is skipped.
const PROFILE_CLONE_PATHS = [
  'Local State',
  'Default/Cookies',
  'Default/Cookies-journal',
  'Default/Network/Cookies',
  'Default/Network/Cookies-journal',
  'Default/Local Storage',
];
const PROFILE_CLONE_ATTEMPTS = 3;
const PROFILE_CLONE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Copies remove the queue that used to throttle Chromium, so cap how many run at once on this machine.
const PROFILE_CLONE_SLOTS = 4;
// Short, because a caller that times out here then queues on the shared profile for up to 5 minutes.
const PROFILE_CLONE_SLOT_WAIT_MS = 30000;
// These SPAs call /auth/refresh from the page. If the server rotates the refresh token, a clone
// would spend it and leave the shared profile holding a dead one, so they stay on the shared profile.
const TOKEN_REFRESH_HOSTS = new Set(['healthy.lexincloud.com', 'stable-eye.oa.fenqile.com']);
const AUTH_COOKIE_NAMES = new Set(['oa_session', 'oa_token_id', 'mid', 'sessionId']);
const DEFAULT_AUTH_EXPIRY_THRESHOLD_SECONDS = 24 * 60 * 60;
const DEFAULT_WSLG_LOG_PATH = '/mnt/wslg/weston.log';
// OA gateway (rc_oa_gateway) answers HTTP 200 with this retcode when its own
// login cookie (rog_session, re-issued daily by SSO) is missing or expired.
const OA_GATEWAY_LOGIN_RETCODE = /"retcode"\s*:\s*"?16051006\b/;
const NAVIGATION_ERROR_PATTERN = /Execution context was destroyed|because of a navigation/i;

function summarizeAuthCookies(cookies, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const thresholdSeconds = Number.isFinite(options.thresholdSeconds)
    ? options.thresholdSeconds
    : DEFAULT_AUTH_EXPIRY_THRESHOLD_SECONDS;
  const entries = (cookies || [])
    .filter((cookie) => AUTH_COOKIE_NAMES.has(cookie.name))
    .map((cookie) => {
      const expires = Number(cookie.expires);
      const persistent = Number.isFinite(expires) && expires > 0;
      const expiresInSeconds = persistent ? Math.floor(expires - (nowMs / 1000)) : null;
      return {
        domain: cookie.domain,
        name: cookie.name,
        persistent,
        expiresAt: persistent ? new Date(expires * 1000).toISOString() : null,
        expiresInSeconds,
        expiresInDays: expiresInSeconds === null ? null : Math.round(expiresInSeconds / 864) / 100,
      };
    })
    .sort((left, right) => {
      if (left.expiresInSeconds === null) return 1;
      if (right.expiresInSeconds === null) return -1;
      return left.expiresInSeconds - right.expiresInSeconds;
    });
  const persistentEntries = entries.filter((entry) => entry.persistent);
  const earliest = persistentEntries[0] || null;
  return {
    thresholdSeconds,
    authCookieCount: entries.length,
    cookies: entries,
    earliestExpiresAt: earliest ? earliest.expiresAt : null,
    earliestExpiresInSeconds: earliest ? earliest.expiresInSeconds : null,
    earliestExpiresInDays: earliest ? earliest.expiresInDays : null,
    expiringSoon: Boolean(earliest && earliest.expiresInSeconds <= thresholdSeconds),
    expiredCookies: persistentEntries
      .filter((entry) => entry.expiresInSeconds <= 0)
      .map((entry) => ({ domain: entry.domain, name: entry.name })),
  };
}

function diffAuthCookies(before, after) {
  const keyOf = (cookie) => `${cookie.domain}|${cookie.name}`;
  const beforeMap = new Map((before || []).map((cookie) => [keyOf(cookie), cookie]));
  const renewed = [];
  const added = [];
  for (const cookie of after || []) {
    const previous = beforeMap.get(keyOf(cookie));
    if (!previous) {
      added.push({ domain: cookie.domain, name: cookie.name, expiresAt: cookie.expiresAt });
      continue;
    }
    if (cookie.expiresAt && previous.expiresAt !== cookie.expiresAt) {
      renewed.push({
        domain: cookie.domain,
        name: cookie.name,
        from: previous.expiresAt,
        to: cookie.expiresAt,
      });
    }
  }
  return { renewed, added, changedCount: renewed.length + added.length };
}

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
  const defaultProfile = isWebShellUrl(url) ? DEFAULT_WEBSHELL_PROFILE : '~/.local/state/agent-tools/browser-profiles/main';
  return {
    toolDir,
    profileDir: expandHome(
      args.profile
      || process.env.BROWSER_SESSION_PROFILE
      || process.env.DEVTOOLS_BROWSER_PROFILE
      || defaultProfile
    ),
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

function inspectWslgHealth(logPath = DEFAULT_WSLG_LOG_PATH) {
  if (!fs.existsSync(logPath)) {
    return {
      available: false,
      copyMode: false,
      sharedMemoryFailure: false,
      logPath,
    };
  }
  try {
    const log = fs.readFileSync(logPath, 'utf8');
    const sharedMemoryFailure = /rdp_allocate_shared_memory:[^\r\n]*Failed/i.test(log);
    const health = {
      available: true,
      copyMode: sharedMemoryFailure,
      sharedMemoryFailure,
      logPath,
    };
    if (sharedMemoryFailure) health.recoveryCommand = 'wsl.exe --shutdown';
    return health;
  } catch (error) {
    return {
      available: true,
      copyMode: false,
      sharedMemoryFailure: false,
      logPath,
      inspectionError: String(error.message || error),
    };
  }
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

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

function hostname(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
}

function cookieMatchesDomain(cookieDomain, requestDomain) {
  const cookieHost = normalizeDomain(cookieDomain);
  const requestHost = normalizeDomain(requestDomain);
  return Boolean(cookieHost && requestHost)
    && (requestHost === cookieHost || requestHost.endsWith(`.${cookieHost}`));
}

function classifyRequestSession(response, options = {}) {
  const targetHost = hostname(options.targetUrl);
  const responseHost = hostname(response.url);
  const body = String(response.body || '');
  const contentType = String(response.contentType || '').toLowerCase();
  const isHtml = contentType.includes('text/html');
  const hasPortalMarker = /atrust/i.test(responseHost)
    || (isHtml && new RegExp(options.portalPattern || DEFAULT_PORTAL_PATTERN, 'i').test(body));
  const hasLoginMarker = isHtml
    && new RegExp(options.loginPattern || DEFAULT_LOGIN_PATTERN, 'i').test(body);

  if (Number(response.status) === 403) {
    return { sessionState: 'FORBIDDEN', sessionReady: false };
  }
  if (Number(response.status) === 401) {
    return { sessionState: 'LOGIN_REQUIRED', sessionReady: false };
  }
  if (Number(response.status) >= 400) {
    return { sessionState: 'UPSTREAM_ERROR', sessionReady: false };
  }
  if (hasPortalMarker) {
    return { sessionState: 'PROXY_INTERCEPTED', sessionReady: false };
  }
  if (!targetHost || responseHost !== targetHost || hasLoginMarker) {
    return { sessionState: 'LOGIN_REQUIRED', sessionReady: false };
  }
  if (OA_GATEWAY_LOGIN_RETCODE.test(body)) {
    return { sessionState: 'LOGIN_REQUIRED', sessionReady: false, loginReason: 'oa-gateway-16051006' };
  }
  return { sessionState: 'READY', sessionReady: true };
}

function classifyPageStatus(snapshot, options = {}) {
  const targetHost = hostname(options.targetUrl);
  const currentHost = hostname(snapshot.url);
  const webShell = isWebShellUrl(options.targetUrl);
  const onTargetHost = Boolean(targetHost && currentHost === targetHost);
  let sessionState = 'CONNECTING';
  let sessionReady = false;

  if (snapshot.hasForbiddenText || Number(options.httpStatus) === 403) {
    sessionState = 'FORBIDDEN';
  } else if (snapshot.hasPortalText) {
    sessionState = 'PROXY_INTERCEPTED';
  } else if (Number(options.httpStatus) === 401) {
    sessionState = 'LOGIN_REQUIRED';
  } else if (Number(options.httpStatus) >= 400) {
    sessionState = 'UPSTREAM_ERROR';
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
    httpStatus: options.httpStatus || null,
    sessionState,
    sessionReady,
  };
}

// A page that is still finishing an SSO redirect destroys the evaluate context;
// wait for the navigation to settle and read again instead of failing the flow.
async function collectSettledStatus(page, options, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await collectStatus(page, options);
    } catch (error) {
      if (attempt >= attempts || !NAVIGATION_ERROR_PATTERN.test(String(error.message || error))) throw error;
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }
  }
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

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function removeStaleProfileLock(lockPath) {
  let ageMs;
  try {
    ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (_) {
    if (ageMs < 60000) return false;
  }
  if (ageMs < PROFILE_LOCK_STALE_MS && owner && isProcessAlive(Number(owner.pid))) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

async function acquireProfileLock(profileDir, options = {}) {
  // Old-path aliases and the new location must contend for the same lock.
  if (fs.existsSync(profileDir)) profileDir = fs.realpathSync(profileDir);
  const timeoutMs = boundedNumber(options.timeoutMs, 30000, 0, 1800000);
  const pollMs = boundedNumber(options.pollMs, 100, 5, 5000);
  const lockPath = `${profileDir}.agent-tools.lock`;
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }),
        { flag: 'wx', mode: 0o600 },
      );
      return () => {
        try {
          const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (owner.token === token) fs.unlinkSync(lockPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (removeStaleProfileLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`profile is busy: ${profileDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

// Chromium refuses a second process on the same user-data-dir (SingletonLock) and fails fast.
// Queue on the agent-tools lock instead, and release it when the context closes.
async function launchLockedContext(chromium, profileDir, launchOptions, lockOptions = {}) {
  const release = await acquireProfileLock(profileDir, {
    timeoutMs: boundedNumber(
      lockOptions.timeoutMs ?? (process.env.BROWSER_PROFILE_LOCK_TIMEOUT_MS || undefined),
      PROFILE_LOCK_WAIT_MS, 0, 1800000,
    ),
    pollMs: lockOptions.pollMs ?? 250,
  });
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch (error) {
    release();
    throw error;
  }
  const close = context.close.bind(context);
  context.close = async (...args) => {
    try {
      return await close(...args);
    } finally {
      release();
    }
  };
  return context;
}

// Before closing a browser after a click, the requests it started must finish or the action can be
// aborted. waitForLoadState('networkidle') cannot tell: it stays satisfied once the navigation
// reached it. Waiting for silence does not work either, because pages such as Lexiao poll every
// few seconds. So: give the click time to start its requests, then wait for those to finish.
function trackRequests(page) {
  const inflight = new Set();
  page.on('request', (request) => inflight.add(request));
  const finished = (request) => inflight.delete(request);
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
  return async ({ graceMs = 2000, timeoutMs = 20000, pollMs = 200 } = {}) => {
    await page.waitForTimeout(graceMs);
    const pending = [...inflight];
    const deadline = Date.now() + timeoutMs;
    while (pending.some((request) => inflight.has(request))) {
      if (Date.now() >= deadline) return false;
      await page.waitForTimeout(pollMs);
    }
    return true;
  };
}

function profileCloneRoot() {
  return path.join(os.homedir(), '.local/state/agent-tools/profile-clones');
}

// Removes clones left by processes that died before closing their context (SIGKILL, MCP timeout).
function pruneProfileClones(root, nowMs = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    const dir = path.join(root, name);
    const pid = Number((/-(\d+)-[^-]+$/.exec(name) || [])[1]);
    let ageMs;
    try {
      ageMs = nowMs - fs.statSync(dir).mtimeMs;
    } catch (_) {
      continue;
    }
    if (pid && isProcessAlive(pid) && ageMs < PROFILE_CLONE_MAX_AGE_MS) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cookieDbIsIntact(file) {
  let DatabaseSync;
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {}; // node:sqlite prints an ExperimentalWarning on load.
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_) {
    return true;
  } finally {
    process.emitWarning = emitWarning;
  }
  let db;
  try {
    db = new DatabaseSync(file);
    return db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
  } catch (_) {
    return false;
  } finally {
    if (db) db.close();
  }
}

function cookieDbPath(profileDir) {
  return ['Default/Network/Cookies', 'Default/Cookies']
    .map((item) => path.join(profileDir, item))
    .find((item) => fs.existsSync(item));
}

function fileSignature(file) {
  const stat = fs.statSync(file);
  return `${stat.mtimeMs}:${stat.size}`;
}

// Chromium allows one process per user-data-dir, so each reader gets its own short-lived copy.
// Copying takes no lock: the shared profile may be in use, in which case a copy that raced a
// write is detected (Cookies changed during the copy, or fails integrity_check) and retried.
function createProfileClone(profileDir, options = {}) {
  const source = fs.existsSync(profileDir) ? fs.realpathSync(profileDir) : profileDir;
  const cookies = cookieDbPath(source);
  if (!cookies) throw new Error(`no Cookies database in profile: ${source}`);
  const root = options.root || profileCloneRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  pruneProfileClones(root);
  const dir = fs.mkdtempSync(path.join(root, `${path.basename(source)}-${process.pid}-`));
  const remove = () => {
    process.off('exit', remove);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      // Runs in finally blocks: must not replace a result. The next clone prunes what is left.
      console.error(`could not remove profile copy ${dir}: ${error.message}`);
    }
  };
  process.on('exit', remove);
  const copyTo = options.copy || ((from, to) => fs.cpSync(from, to, { recursive: true }));
  let lastError = null;
  for (let attempt = 0; attempt < PROFILE_CLONE_ATTEMPTS; attempt += 1) {
    try {
      const before = fileSignature(cookies);
      for (const item of PROFILE_CLONE_PATHS) {
        const from = path.join(source, item);
        if (fs.existsSync(from)) copyTo(from, path.join(dir, item));
      }
      if (fileSignature(cookies) === before
        && cookieDbIsIntact(path.join(dir, path.relative(source, cookies)))) {
        return { dir, remove };
      }
      lastError = new Error('Cookies changed during copy or failed integrity_check');
    } catch (error) {
      lastError = error; // LevelDB files can vanish mid-copy during compaction.
    }
    for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  remove();
  throw lastError;
}

async function acquireCloneSlot(root, options = {}) {
  const slots = options.slots || PROFILE_CLONE_SLOTS;
  const dir = `${root}-slots`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (options.slotWaitMs ?? PROFILE_CLONE_SLOT_WAIT_MS);
  while (true) {
    for (let index = 0; index < slots; index += 1) {
      try {
        return await acquireProfileLock(path.join(dir, `slot-${index}`), { timeoutMs: 0 });
      } catch (error) {
        if (!/profile is busy/.test(error.message)) throw error;
      }
    }
    if (Date.now() >= deadline) throw new Error(`all ${slots} read-only browser slots are busy`);
    await new Promise((resolve) => setTimeout(resolve, options.slotPollMs || 500));
  }
}

// A copy plus one of the slots that cap concurrent read-only browsers; remove() frees both.
async function openProfileClone(profileDir, options = {}) {
  const root = options.root || profileCloneRoot();
  const releaseSlot = await acquireCloneSlot(root, options);
  let clone;
  try {
    clone = createProfileClone(profileDir, { ...options, root });
  } catch (error) {
    releaseSlot();
    throw error;
  }
  return {
    dir: clone.dir,
    remove: () => {
      clone.remove();
      try {
        releaseSlot();
      } catch (error) {
        console.error(`could not release browser slot: ${error.message}`);
      }
    },
  };
}

// Moves polling off the shared profile once a write action is confirmed, so other sessions need
// not queue behind a long job. Reads and replaces session.context; returns the page to poll on.
async function moveToReadOnlyContext(session, page, { requestsSettled, openReadOnly, prepare, retryHint }) {
  if (!await requestsSettled()) {
    console.error('page requests did not finish within 20s; polling stays on the shared profile');
    return page;
  }
  try {
    await session.context.close().catch(() => {});
    session.context = await openReadOnly();
    const next = session.context.pages()[0] || await session.context.newPage();
    await prepare(next);
    return next;
  } catch (error) {
    throw new Error(`操作已触发，但无法打开轮询页面，不要重复触发，改用 ${retryHint} 查结果：${error.message}`);
  }
}

// For callers that only read: runs on a private copy of the login state, so it neither waits for
// nor blocks the shared profile. Set-Cookie received here is discarded with the copy. Falls back
// to queueing on the shared profile when the copy cannot be made or launched.
async function launchReadOnlyContext(chromium, profileDir, launchOptions, options = {}) {
  let clone;
  let context;
  try {
    clone = await openProfileClone(profileDir, options);
    context = await chromium.launchPersistentContext(clone.dir, launchOptions);
  } catch (error) {
    if (clone) clone.remove();
    console.error(`read-only profile copy unavailable, queueing on ${profileDir}: ${error.message}`);
    return launchLockedContext(chromium, profileDir, launchOptions);
  }
  const close = context.close.bind(context);
  context.close = async (...args) => {
    try {
      return await close(...args);
    } finally {
      clone.remove();
    }
  };
  return context;
}

// Whether a browser_session.js invocation can run on a copy: it must not need to persist anything
// (login, renewal, export, page clicks) and must not show a window to the user.
function canUseProfileClone({ mode, args = {}, url, headless, requestMethod }) {
  if (!headless || args['click-text'] || args['click-button'] || isWebShellUrl(url)) return false;
  try {
    if (TOKEN_REFRESH_HOSTS.has(new URL(url).hostname)) return false;
  } catch (_) {
    return false;
  }
  if (mode === 'request') return requestMethod === 'GET';
  return ['status', 'cookies', 'storage'].includes(mode);
}

async function collectSessionHealth(context, targetUrl, expiryThresholdSeconds = 900) {
  const cookies = await context.cookies([targetUrl]);
  const auth = summarizeAuthCookies(await context.cookies());
  const persistentExpiries = cookies
    .map((cookie) => Number(cookie.expires))
    .filter((expires) => Number.isFinite(expires) && expires > 0)
    .sort((left, right) => left - right);
  const earliestExpiry = persistentExpiries[0] || null;
  const expiresInSeconds = earliestExpiry === null
    ? null
    : Math.floor(earliestExpiry - (Date.now() / 1000));
  return {
    checkedAt: new Date().toISOString(),
    cookieCount: cookies.length,
    persistentCookieCount: persistentExpiries.length,
    sessionCookieCount: cookies.length - persistentExpiries.length,
    earliestPersistentCookieExpiresAt: earliestExpiry === null ? null : new Date(earliestExpiry * 1000).toISOString(),
    earliestPersistentCookieExpiresInSeconds: expiresInSeconds,
    persistentCookieExpiringSoon: expiresInSeconds !== null && expiresInSeconds <= Number(expiryThresholdSeconds),
    auth,
  };
}

function summarizeRenewalResult(status) {
  const sessionReady = Boolean(status.sessionReady);
  const authRenewal = status.authRenewal || null;
  const renewedAuthCookies = Boolean(authRenewal && authRenewal.changedCount > 0);
  const renewalState = renewedAuthCookies
    ? 'SESSION_RENEWED'
    : (sessionReady ? 'SESSION_ACTIVE' : (status.sessionState || 'UNKNOWN'));
  return {
    renewalAttempted: true,
    renewalState,
    renewedAuthCookies,
    authRenewal,
    sessionState: status.sessionState || 'UNKNOWN',
    sessionReady,
    requestedUrl: status.requestedUrl,
    profileDir: status.profileDir,
    browserMode: status.browserMode,
    networkPolicy: status.networkPolicy,
    sessionHealth: status.sessionHealth,
    actionRequired: (sessionReady || renewedAuthCookies) ? null : 'run ensure_session interactively',
  };
}

// Direct-only by construction: buildBrowserEnv strips every proxy variable and
// chromiumArgsFor always passes --no-proxy-server. There is no caller-facing
// switch here on purpose -- see the note in browser_network.js.
async function openContext(paths, chromium, headless, targetUrl) {
  const ldLibraryPath = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const browserBaseEnv = { ...process.env };
  delete browserBaseEnv.BROWSER_SESSION_REQUEST_JSON;
  const network = buildBrowserEnv(targetUrl, browserBaseEnv);
  const env = inferWslgEnv(network.env);
  env.LD_LIBRARY_PATH = ldLibraryPath;
  const context = await chromium.launchPersistentContext(paths.launchDir || paths.profileDir, {
    executablePath: paths.chromePath,
    headless,
    env,
    args: chromiumArgsFor(targetUrl, ['--no-sandbox']),
  });
  return { context, networkPolicy: network.networkPolicy };
}

function gatewayRefreshUrl(targetUrl, headers = {}) {
  const referer = Object.entries(headers)
    .find(([name]) => ['referer', 'origin'].includes(name.toLowerCase()));
  try {
    return `${new URL(referer ? referer[1] : targetUrl).origin}/`;
  } catch (error) {
    return `${new URL(targetUrl).origin}/`;
  }
}

async function runRequestFlow(paths, chromium, flow) {
  const launched = await openContext(paths, chromium, true, flow.url);
  const { context } = launched;
  try {
    const requestOptions = {
      method: flow.request.method,
      headers: flow.request.headers,
      timeout: flow.request.timeoutMs,
      failOnStatusCode: false,
    };
    if (flow.request.bodyBase64) {
      requestOptions.data = Buffer.from(flow.request.bodyBase64, 'base64');
    }
    const send = async () => {
      const response = await context.request.fetch(flow.url, requestOptions);
      const responseBody = await response.text();
      const status = response.status();
      const requestSession = classifyRequestSession({
        status,
        url: response.url(),
        body: responseBody,
        contentType: response.headers()['content-type'] || '',
      }, {
        targetUrl: flow.url,
        loginPattern: flow.loginPattern,
        portalPattern: flow.portalPattern,
      });
      return { response, responseBody, status, requestSession };
    };
    let { response, responseBody, status, requestSession } = await send();
    let sessionRefresh = null;
    if (requestSession.loginReason === 'oa-gateway-16051006') {
      // Opening the console page lets SSO re-issue the gateway cookie in this
      // profile; the request is then retried once.
      const refreshUrl = gatewayRefreshUrl(flow.url, flow.request.headers);
      const page = context.pages()[0] || await context.newPage();
      await page.goto(refreshUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      ({ response, responseBody, status, requestSession } = await send());
      sessionRefresh = { url: redactUrl(refreshUrl), recovered: requestSession.sessionReady };
    }
    const result = {
      status,
      url: redactUrl(response.url()),
      body: responseBody.slice(0, status >= 400 ? 1000 : flow.request.maxChars),
      truncated: responseBody.length > (status >= 400 ? 1000 : flow.request.maxChars),
      profileDir: paths.profileDir,
      networkPolicy: launched.networkPolicy,
      ...requestSession,
      ...(sessionRefresh ? { sessionRefresh } : {}),
      sessionHealth: await collectSessionHealth(context, flow.url, flow.request.expiryThresholdSeconds),
    };
    if (status >= 400) result.error = 'HTTP request failed';
    else if (!requestSession.sessionReady) result.error = 'browser session is not ready';
    return result;
  } finally {
    await context.close().catch(() => {});
  }
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
    if (['FORBIDDEN', 'UPSTREAM_ERROR'].includes(status.sessionState)) return status;
    if (!options.waitForLogin && ['LOGIN_REQUIRED', 'PROXY_INTERCEPTED'].includes(status.sessionState)) {
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
    const trackAuthRenewal = flow.mode === 'renew';
    const authCookiesBefore = trackAuthRenewal
      ? summarizeAuthCookies(await context.cookies()).cookies
      : null;
    const response = await page.goto(flow.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const options = {
      successText: flow.successText,
      loginPattern: flow.loginPattern,
      portalPattern: flow.portalPattern,
      forbiddenPattern: flow.forbiddenPattern,
      targetUrl: flow.url,
      httpStatus: response?.status() || null,
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
      : await collectSettledStatus(page, options);
    status.browserMode = flow.headless ? 'headless' : 'headed';
    status.networkPolicy = launched.networkPolicy;
    status.profileDir = paths.profileDir;

    if (flow.screenshotOnLogin && !status.sessionReady) {
      const screenshot = loginScreenshotPath(flow.url);
      await page.screenshot({ path: screenshot, fullPage: true });
      status.loginScreenshot = screenshot;
      status.loginRequired = true;
    }

    const actions = {};
    const pageUrlBeforeActions = page.url();
    if (flow.args['click-text']) {
      actions.clickText = await clickNormalizedText(page, flow.args['click-text']);
      await page.waitForTimeout(1000);
    }
    if (flow.args['click-button']) {
      actions.clickButton = await clickNormalizedText(page, flow.args['click-button']);
      await page.waitForTimeout(1000);
    }
    if (Object.keys(actions).length > 0) {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      const postClickOptions = page.url() === pageUrlBeforeActions
        ? options
        : { ...options, httpStatus: null };
      status = await collectSettledStatus(page, postClickOptions);
      status.browserMode = flow.headless ? 'headless' : 'headed';
      status.networkPolicy = launched.networkPolicy;
      status.profileDir = paths.profileDir;
      Object.assign(status, actions);
    }

    if (flow.mode === 'cookies') {
      const domain = flow.args.domain || new URL(status.url).hostname;
      const showSecrets = Boolean(flow.args['show-secrets']);
      const cookies = (await context.cookies()).filter((cookie) => cookieMatchesDomain(cookie.domain, domain)).map((cookie) => ({
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

    if (flow.mode === 'export') {
      const exportPath = expandHome(flow.args['export-session']);
      fs.mkdirSync(path.dirname(exportPath), { recursive: true });
      await context.storageState({ path: exportPath });
      fs.chmodSync(exportPath, 0o600);
      status.exportedSessionPath = exportPath;
    }

    status.sessionHealth = await collectSessionHealth(
      context,
      flow.url,
      flow.expiryThresholdSeconds,
    );

    if (authCookiesBefore) {
      status.authRenewal = diffAuthCookies(authCookiesBefore, status.sessionHealth.auth.cookies);
    }

    status.requestedUrl = redactUrl(flow.url);
    status.url = redactUrl(status.url);
    return status;
  } finally {
    await context.close().catch(() => {});
  }
}

function requestConfigFromEnvironment(expiryThresholdSeconds) {
  const rawRequest = process.env.BROWSER_SESSION_REQUEST_JSON;
  if (!rawRequest) throw new Error('BROWSER_SESSION_REQUEST_JSON is required');
  const request = JSON.parse(rawRequest);
  request.method = String(request.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(request.method)) throw new Error('only GET/POST are supported');
  request.headers = request.headers && typeof request.headers === 'object' ? request.headers : {};
  request.timeoutMs = boundedNumber(request.timeoutMs, 60000, 5000, 300000);
  request.maxChars = boundedNumber(request.maxChars, 12000, 100, 100000);
  request.expiryThresholdSeconds = expiryThresholdSeconds;
  return request;
}

async function runHeadlessScreenshotFallback(paths, chromium, baseFlow, headedLaunchError, diagnostics = {}) {
  const fallback = await runPageFlow(paths, chromium, {
    ...baseFlow,
    headless: true,
    waitForLogin: false,
    screenshotOnLogin: true,
  });
  fallback.ensureStrategy = 'headless-screenshot';
  fallback.headedLaunchError = headedLaunchError;
  Object.assign(fallback, diagnostics);
  return fallback;
}

async function runEnsureFlow(paths, chromium, baseFlow) {
  // ensure_session exists to establish a login. Every leg of it -- including the
  // headless pre-check that writes into the same profile -- stays direct.
  const status = await runPageFlow(paths, chromium, {
    ...baseFlow,
    headless: true,
    waitForLogin: false,
    screenshotOnLogin: false,
  });
  if (status.sessionReady) {
    status.ensureStrategy = 'headless-fast-path';
    return status;
  }
  if (['FORBIDDEN', 'UPSTREAM_ERROR'].includes(status.sessionState)) {
    status.ensureStrategy = 'headless-terminal-state';
    return status;
  }

  const wslgHealth = baseFlow.wslgHealth || inspectWslgHealth();
  if (wslgHealth.copyMode) {
    return runHeadlessScreenshotFallback(
      paths,
      chromium,
      baseFlow,
      'WSLg COPY MODE detected; run "wsl.exe --shutdown" from Windows PowerShell after saving work, then reopen WSL',
      { wslgHealth },
    );
  }

  try {
    const ensured = await runPageFlow(paths, chromium, {
      ...baseFlow,
      headless: false,
      waitForLogin: true,
      screenshotOnLogin: false,
    });
    ensured.ensureStrategy = 'headed-login';
    return ensured;
  } catch (error) {
    if (!looksLikeDisplayLaunchError(error)) throw error;
    return runHeadlessScreenshotFallback(
      paths,
      chromium,
      baseFlow,
      'headed Chromium unavailable; saved login screenshot for manual scan',
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.request ? 'request' : args.ensure ? 'ensure' : args.renew ? 'renew' : args['export-session'] ? 'export' : args.cookies ? 'cookies' : args.storage ? 'storage' : args.doctor ? 'doctor' : 'status';
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
  const expiryThresholdSeconds = boundedNumber(args['expiry-threshold-seconds'], 900, 0, 86400);
  const headless = mode === 'renew' || mode === 'export' || (mode !== 'ensure' && !args.headed);

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
      wslgHealth: inspectWslgHealth(),
    }, null, 2));
    return;
  }

  try {
    // Bounds how long credentials of a killed process stay on disk: the renewal timer runs this daily.
    pruneProfileClones(profileCloneRoot());
  } catch (error) {
    console.error(`could not prune profile copies: ${error.message}`);
  }

  const request = mode === 'request' ? requestConfigFromEnvironment(expiryThresholdSeconds) : null;
  let clone = null;
  if (canUseProfileClone({ mode, args, url, headless, requestMethod: request && request.method })) {
    try {
      clone = await openProfileClone(paths.profileDir);
    } catch (error) {
      console.error(`read-only profile copy unavailable, queueing on ${paths.profileDir}: ${error.message}`);
    }
  }
  const releaseProfileLock = clone ? clone.remove : await acquireProfileLock(paths.profileDir, {
    timeoutMs: boundedNumber(args['lock-timeout'] ?? process.env.BROWSER_PROFILE_LOCK_TIMEOUT_MS, PROFILE_LOCK_WAIT_MS, 0, 1800000),
    pollMs: boundedNumber(args['lock-poll'], 100, 5, 5000),
  });
  try {
    const chromium = loadPlaywright(paths);
    const runPaths = clone ? { ...paths, launchDir: clone.dir } : paths;

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
      expiryThresholdSeconds,
    };
    let result;
    if (mode === 'request') {
      result = await runRequestFlow(runPaths, chromium, { ...baseFlow, request });
    } else if (mode === 'ensure') {
      result = await runEnsureFlow(paths, chromium, baseFlow);
    } else {
      const pageResult = await runPageFlow(runPaths, chromium, {
        ...baseFlow,
        headless,
        waitForLogin: false,
        screenshotOnLogin: false,
      });
      result = mode === 'renew' ? summarizeRenewalResult(pageResult) : pageResult;
    }
    result.profileMode = clone ? 'read-only-copy' : 'shared';
    console.log(JSON.stringify(result, null, 2));
  } finally {
    releaseProfileLock();
  }
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
  acquireProfileLock,
  canUseProfileClone,
  classifyPageStatus,
  classifyRequestSession,
  collectStatus,
  collectSessionHealth,
  cookieMatchesDomain,
  createProfileClone,
  diffAuthCookies,
  inspectWslgHealth,
  launchLockedContext,
  launchReadOnlyContext,
  main,
  moveToReadOnlyContext,
  openProfileClone,
  parseArgs,
  pruneProfileClones,
  resolvePaths,
  runPageFlow,
  runEnsureFlow,
  runRequestFlow,
  summarizeAuthCookies,
  summarizeRenewalResult,
  trackRequests,
  waitForStableSession,
};
