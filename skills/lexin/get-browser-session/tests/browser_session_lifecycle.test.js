'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acquireProfileLock,
  classifyRequestSession,
  collectSessionHealth,
  cookieMatchesDomain,
  inspectWslgHealth,
  resolvePaths,
  runPageFlow,
  runEnsureFlow,
  runRequestFlow,
  summarizeAuthCookies,
  diffAuthCookies,
  summarizeRenewalResult,
} = require('../scripts/browser_session');

function pageContext(targetUrl, overrides = {}) {
  const page = {
    goto: async () => ({ status: () => 200 }),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => targetUrl,
    screenshot: async () => {},
    evaluate: async () => ({
      title: 'Page',
      url: targetUrl,
      hasSuccessText: false,
      hasLoginText: false,
      hasLoginControl: false,
      hasPortalText: false,
      hasForbiddenText: false,
      terminalReady: false,
      snippet: '',
      buttons: [],
      ...overrides,
    }),
  };
  return {
    pages: () => [page],
    cookies: async () => [],
    close: async () => {},
  };
}

function ensureFlow(targetUrl) {
  return {
    args: {},
    mode: 'ensure',
    url: targetUrl,
    successText: '',
    loginPattern: 'Sign in',
    portalPattern: 'ATrust',
    forbiddenPattern: '403',
    timeoutMs: 1000,
    pollMs: 1,
    stablePolls: 1,
    stableDwellMs: 0,
    statusTimeoutMs: 1000,
    expiryThresholdSeconds: 900,
    wslgHealth: { available: false, copyMode: false, sharedMemoryFailure: false },
  };
}

test('WSLg health detects shared-memory failures that force COPY MODE', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-session-wslg-'));
  const logPath = path.join(directory, 'weston.log');
  try {
    fs.writeFileSync(logPath, [
      'RDP backend: enable_copy_warning_title = 1',
      'rdp_allocate_shared_memory: Failed to open "/mnt/shared_memory/id" with error: Input/output error',
    ].join('\n'));

    const health = inspectWslgHealth(logPath);

    assert.equal(health.available, true);
    assert.equal(health.copyMode, true);
    assert.equal(health.sharedMemoryFailure, true);
    assert.equal(health.recoveryCommand, 'wsl.exe --shutdown');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('WSLg health remains healthy when the Weston log has no shared-memory failure', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-session-wslg-'));
  const logPath = path.join(directory, 'weston.log');
  try {
    fs.writeFileSync(logPath, 'RDP backend initialized\n');
    assert.deepEqual(inspectWslgHealth(logPath), {
      available: true,
      copyMode: false,
      sharedMemoryFailure: false,
      logPath,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('WSLg health reports an unavailable log without treating it as COPY MODE', () => {
  const logPath = path.join(os.tmpdir(), `missing-weston-${process.pid}-${Date.now()}.log`);
  assert.deepEqual(inspectWslgHealth(logPath), {
    available: false,
    copyMode: false,
    sharedMemoryFailure: false,
    logPath,
  });
});

test('WSLg health reports log inspection failures without blocking headless usage', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-session-wslg-'));
  try {
    const health = inspectWslgHealth(directory);
    assert.equal(health.available, true);
    assert.equal(health.copyMode, false);
    assert.equal(health.sharedMemoryFailure, false);
    assert.match(health.inspectionError, /EISDIR|illegal operation on a directory/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('all browser tools honor the shared profile environment variable', () => {
  const previousDevtools = process.env.DEVTOOLS_BROWSER_PROFILE;
  const previousBrowser = process.env.BROWSER_SESSION_PROFILE;
  delete process.env.BROWSER_SESSION_PROFILE;
  process.env.DEVTOOLS_BROWSER_PROFILE = '/tmp/shared-browser-profile';
  try {
    const paths = resolvePaths({}, 'https://lexiao.oa.fenqile.com/');
    assert.equal(paths.profileDir, '/tmp/shared-browser-profile');
  } finally {
    if (previousDevtools === undefined) delete process.env.DEVTOOLS_BROWSER_PROFILE;
    else process.env.DEVTOOLS_BROWSER_PROFILE = previousDevtools;
    if (previousBrowser === undefined) delete process.env.BROWSER_SESSION_PROFILE;
    else process.env.BROWSER_SESSION_PROFILE = previousBrowser;
  }
});

test('cookie domain matching follows browser suffix boundaries', () => {
  assert.equal(cookieMatchesDomain('.fenqile.com', 'lexiao.oa.fenqile.com'), true);
  assert.equal(cookieMatchesDomain('lexiao.oa.fenqile.com', 'lexiao.oa.fenqile.com'), true);
  assert.equal(cookieMatchesDomain('.example.com', 'notexample.com'), false);
  assert.equal(cookieMatchesDomain('.fenqile.com', 'com'), false);
});

test('authenticated requests detect login redirects and upstream errors', () => {
  const targetUrl = 'https://healthy.lexincloud.com/api/status';
  const redirect = classifyRequestSession({
    status: 200,
    url: 'https://atrust.example.invalid/login',
    body: '<html>Sign in</html>',
    contentType: 'text/html',
  }, { targetUrl });
  assert.equal(redirect.sessionState, 'PROXY_INTERCEPTED');
  assert.equal(redirect.sessionReady, false);

  const upstreamError = classifyRequestSession({
    status: 503,
    url: targetUrl,
    body: 'unavailable',
    contentType: 'text/plain',
  }, { targetUrl });
  assert.equal(upstreamError.sessionState, 'UPSTREAM_ERROR');
  assert.equal(upstreamError.sessionReady, false);

  const unauthorized = classifyRequestSession({
    status: 401,
    url: targetUrl,
    body: '',
    contentType: 'application/json',
  }, { targetUrl });
  assert.equal(unauthorized.sessionState, 'LOGIN_REQUIRED');

  const forbidden = classifyRequestSession({
    status: 403,
    url: targetUrl,
    body: '',
    contentType: 'application/json',
  }, { targetUrl });
  assert.equal(forbidden.sessionState, 'FORBIDDEN');

  const otherHost = classifyRequestSession({
    status: 200,
    url: 'https://login.example.invalid/',
    body: '',
    contentType: 'text/html',
  }, { targetUrl });
  assert.equal(otherHost.sessionState, 'LOGIN_REQUIRED');
});

test('session health reports expiry metadata without cookie values', async () => {
  const expiry = Math.floor(Date.now() / 1000) + 1200;
  const health = await collectSessionHealth({
    cookies: async () => [
      { name: 'persistent', value: 'secret', expires: expiry },
      { name: 'session', value: 'secret', expires: -1 },
    ],
  }, 'https://lexiao.oa.fenqile.com/', 900);

  assert.equal(health.cookieCount, 2);
  assert.equal(health.persistentCookieCount, 1);
  assert.equal(health.sessionCookieCount, 1);
  assert.equal(health.persistentCookieExpiringSoon, false);
  assert.equal(Number.isInteger(health.earliestPersistentCookieExpiresInSeconds), true);
  assert.equal('value' in health, false);
});

test('renewal summary reports active session without leaking page or credential data', () => {
  const result = summarizeRenewalResult({
    sessionState: 'READY',
    sessionReady: true,
    requestedUrl: 'https://lexiao.oa.fenqile.com/',
    profileDir: '/tmp/profile',
    browserMode: 'headless',
    networkPolicy: { proxyMode: 'direct' },
    sessionHealth: { cookieCount: 3 },
    snippet: 'sensitive page text',
    buttons: [{ text: 'secret' }],
    cookies: [{ name: 'session', value: 'secret' }],
    storage: [{ key: 'token', value: 'secret' }],
  });

  assert.deepEqual(result, {
    renewalAttempted: true,
    renewalState: 'SESSION_ACTIVE',
    renewedAuthCookies: false,
    authRenewal: null,
    sessionState: 'READY',
    sessionReady: true,
    requestedUrl: 'https://lexiao.oa.fenqile.com/',
    profileDir: '/tmp/profile',
    browserMode: 'headless',
    networkPolicy: { proxyMode: 'direct' },
    sessionHealth: { cookieCount: 3 },
    actionRequired: null,
  });
});

test('renewal summary requests interactive login without opening a headed browser', () => {
  const result = summarizeRenewalResult({
    sessionState: 'LOGIN_REQUIRED',
    sessionReady: false,
    requestedUrl: 'https://lexiao.oa.fenqile.com/',
    profileDir: '/tmp/profile',
    browserMode: 'headless',
    networkPolicy: { proxyMode: 'direct' },
    sessionHealth: { cookieCount: 0 },
  });

  assert.equal(result.renewalState, 'LOGIN_REQUIRED');
  assert.equal(result.actionRequired, 'run ensure_session interactively');
  assert.equal(result.browserMode, 'headless');
});

test('browser-context request returns session state and closes the context', async () => {
  const targetUrl = 'https://healthy.lexincloud.com/api/status';
  let closed = false;
  let requestData;
  const context = {
    request: {
      fetch: async (_url, options) => {
        requestData = options.data;
        return {
          status: () => 200,
          url: () => targetUrl,
          text: async () => '{"ok":true}',
          headers: () => ({ 'content-type': 'application/json' }),
        };
      },
    },
    cookies: async () => [],
    close: async () => { closed = true; },
  };
  const chromium = {
    launchPersistentContext: async () => context,
  };
  const result = await runRequestFlow({
    profileDir: '/tmp/profile',
    runtimeLibDir: '/tmp/runtime',
    chromePath: '/tmp/chrome',
  }, chromium, {
    url: targetUrl,
    loginPattern: 'Sign in',
    portalPattern: 'ATrust',
    request: {
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
      maxChars: 1000,
      expiryThresholdSeconds: 900,
      bodyBase64: Buffer.from('payload').toString('base64'),
    },
  });

  assert.equal(result.sessionState, 'READY');
  assert.equal(result.body, '{"ok":true}');
  assert.equal(requestData.toString(), 'payload');
  assert.equal(closed, true);
});

test('page actions return the recollected post-click state', async () => {
  const targetUrl = 'https://lexiao.oa.fenqile.com/#/home';
  const snapshots = ['Before', 'After'];
  let closed = false;
  const page = {
    goto: async () => ({ status: () => 200 }),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => targetUrl,
    evaluate: async (callback) => {
      if (callback.toString().includes('wantedText')) return { clicked: true };
      const title = snapshots.shift() || 'After';
      return {
        title,
        url: targetUrl,
        hasSuccessText: false,
        hasLoginText: false,
        hasLoginControl: false,
        hasPortalText: false,
        hasForbiddenText: false,
        terminalReady: false,
        snippet: title,
        buttons: [],
      };
    },
  };
  const context = {
    pages: () => [page],
    cookies: async () => [],
    close: async () => { closed = true; },
  };
  const chromium = {
    launchPersistentContext: async () => context,
  };
  const result = await runPageFlow({
    profileDir: '/tmp/profile',
    runtimeLibDir: '/tmp/runtime',
    chromePath: '/tmp/chrome',
  }, chromium, {
    args: { 'click-text': '刷新', 'click-button': '确认' },
    mode: 'status',
    url: targetUrl,
    successText: '',
    loginPattern: 'Sign in',
    portalPattern: 'ATrust',
    forbiddenPattern: '403',
    timeoutMs: 1000,
    pollMs: 1,
    stablePolls: 1,
    stableDwellMs: 0,
    statusTimeoutMs: 1000,
    expiryThresholdSeconds: 900,
    headless: true,
    waitForLogin: false,
    screenshotOnLogin: false,
  });

  assert.equal(result.title, 'After');
  assert.deepEqual(result.clickText, { clicked: true });
  assert.deepEqual(result.clickButton, { clicked: true });
  assert.equal(closed, true);
});

test('cookie mode applies suffix-boundary filtering', async () => {
  const targetUrl = 'https://lexiao.oa.fenqile.com/#/home';
  const context = pageContext(targetUrl);
  context.cookies = async () => [
    { name: 'target', domain: '.fenqile.com', path: '/', expires: -1, value: 'secret' },
    { name: 'other', domain: '.example.com', path: '/', expires: -1, value: 'secret' },
  ];
  const chromium = { launchPersistentContext: async () => context };
  const result = await runPageFlow({
    profileDir: '/tmp/profile',
    runtimeLibDir: '/tmp/runtime',
    chromePath: '/tmp/chrome',
  }, chromium, {
    ...ensureFlow(targetUrl),
    args: { domain: 'lexiao.oa.fenqile.com' },
    mode: 'cookies',
    headless: true,
    waitForLogin: false,
    screenshotOnLogin: false,
  });

  assert.deepEqual(result.cookies.map((cookie) => cookie.name), ['target']);
  assert.equal(result.cookies[0].value, '<redacted>');
});

test('ensure flow opens a headed browser after a failed fast path', async () => {
  const targetUrl = 'https://lexiao.oa.fenqile.com/#/home';
  const contexts = [
    pageContext(targetUrl, { hasLoginText: true, hasLoginControl: true }),
    pageContext(targetUrl),
  ];
  const launchModes = [];
  const chromium = {
    launchPersistentContext: async (_profile, options) => {
      launchModes.push(options.headless);
      return contexts.shift();
    },
  };
  const result = await runEnsureFlow({
    profileDir: '/tmp/profile',
    runtimeLibDir: '/tmp/runtime',
    chromePath: '/tmp/chrome',
  }, chromium, ensureFlow(targetUrl));

  assert.equal(result.ensureStrategy, 'headed-login');
  assert.deepEqual(launchModes, [true, false]);
});

test('ensure flow does not open a headed browser for an upstream error', async () => {
  const targetUrl = 'https://lexiao.oa.fenqile.com/#/home';
  let launches = 0;
  const context = pageContext(targetUrl);
  context.pages()[0].goto = async () => ({ status: () => 500 });
  const chromium = {
    launchPersistentContext: async () => {
      launches += 1;
      return context;
    },
  };
  const result = await runEnsureFlow({
    profileDir: '/tmp/profile',
    runtimeLibDir: '/tmp/runtime',
    chromePath: '/tmp/chrome',
  }, chromium, ensureFlow(targetUrl));

  assert.equal(result.ensureStrategy, 'headless-terminal-state');
  assert.equal(result.sessionState, 'UPSTREAM_ERROR');
  assert.equal(launches, 1);
});

test('ensure flow returns a screenshot fallback when headed Chromium is unavailable', async () => {
  const targetUrl = 'https://lexiao.oa.fenqile.com/#/home';
  let launches = 0;
  const chromium = {
    launchPersistentContext: async () => {
      launches += 1;
      if (launches === 2) throw new Error('Missing X server or $DISPLAY');
      return pageContext(targetUrl, { hasLoginText: true, hasLoginControl: true });
    },
  };
  const result = await runEnsureFlow({
    profileDir: '/tmp/profile',
    runtimeLibDir: '/tmp/runtime',
    chromePath: '/tmp/chrome',
  }, chromium, ensureFlow(targetUrl));

  assert.equal(result.ensureStrategy, 'headless-screenshot');
  assert.match(result.loginScreenshot, /browser-session-login-/);
  assert.equal(launches, 3);
});

test('ensure flow skips an unusable headed browser when WSLg is in COPY MODE', async () => {
  const targetUrl = 'https://lexiao.oa.fenqile.com/#/home';
  const launchModes = [];
  const chromium = {
    launchPersistentContext: async (_profile, options) => {
      launchModes.push(options.headless);
      return pageContext(targetUrl, { hasLoginText: true, hasLoginControl: true });
    },
  };
  const result = await runEnsureFlow({
    profileDir: '/tmp/profile',
    runtimeLibDir: '/tmp/runtime',
    chromePath: '/tmp/chrome',
  }, chromium, {
    ...ensureFlow(targetUrl),
    wslgHealth: {
      available: true,
      copyMode: true,
      sharedMemoryFailure: true,
      logPath: '/mnt/wslg/weston.log',
      recoveryCommand: 'wsl.exe --shutdown',
    },
  });

  assert.equal(result.ensureStrategy, 'headless-screenshot');
  assert.match(result.headedLaunchError, /WSLg COPY MODE/);
  assert.equal(result.wslgHealth.copyMode, true);
  assert.deepEqual(launchModes, [true, true]);
});

test('profile lock serializes callers and can be reacquired after release', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-session-lock-'));
  const profile = path.join(directory, 'profile');
  const release = await acquireProfileLock(profile, { timeoutMs: 50, pollMs: 5 });
  try {
    await assert.rejects(
      acquireProfileLock(profile, { timeoutMs: 20, pollMs: 5 }),
      /profile is busy/,
    );
  } finally {
    release();
  }

  const releaseAgain = await acquireProfileLock(profile, { timeoutMs: 50, pollMs: 5 });
  releaseAgain();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('profile lock recovers a lock owned by a dead process', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-session-stale-lock-'));
  const profile = path.join(directory, 'profile');
  const lockPath = `${profile}.agent-tools.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, token: 'stale' }));

  const release = await acquireProfileLock(profile, { timeoutMs: 50, pollMs: 5 });
  release();
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('profile lock recovers an old lock even when its pid was reused', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-session-old-lock-'));
  const profile = path.join(directory, 'profile');
  const lockPath = `${profile}.agent-tools.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'old' }));
  const oldTime = new Date(Date.now() - (2 * 60 * 60 * 1000));
  fs.utimesSync(lockPath, oldTime, oldTime);

  const release = await acquireProfileLock(profile, { timeoutMs: 50, pollMs: 5 });
  release();
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('auth cookie summary keeps only authentication cookies and sorts by remaining life', () => {
  const nowMs = Date.parse('2026-08-26T00:00:00.000Z');
  const day = 86400;
  const summary = summarizeAuthCookies([
    { domain: '.oa.fenqile.com', name: 'oa_session', expires: nowMs / 1000 + 10 * day },
    { domain: '.oa.fenqile.com', name: 'oa_token_id', expires: nowMs / 1000 + 3 * day },
    { domain: '.baidu.com', name: 'BAIDUID', expires: nowMs / 1000 + 365 * day },
    { domain: 'hippo.oa.fenqile.com', name: 'JSESSIONID', expires: -1 },
  ], { nowMs });

  assert.equal(summary.authCookieCount, 2);
  assert.deepEqual(summary.cookies.map((cookie) => cookie.name), ['oa_token_id', 'oa_session']);
  assert.equal(summary.earliestExpiresInDays, 3);
  assert.equal(summary.expiringSoon, false);
  assert.deepEqual(summary.expiredCookies, []);
});

test('auth cookie summary flags cookies inside the expiry threshold and already-expired ones', () => {
  const nowMs = Date.parse('2026-08-26T00:00:00.000Z');
  const summary = summarizeAuthCookies([
    { domain: '.oa.fenqile.com', name: 'oa_token_id', expires: nowMs / 1000 - 60 },
    { domain: '.lexincloud.com', name: 'oa_session', expires: nowMs / 1000 + 3600 },
  ], { nowMs });

  assert.equal(summary.expiringSoon, true);
  assert.deepEqual(summary.expiredCookies, [{ domain: '.oa.fenqile.com', name: 'oa_token_id' }]);
});

test('auth cookie diff separates resigned cookies from newly issued ones', () => {
  const before = [
    { domain: '.lexincloud.com', name: 'oa_session', expiresAt: '2026-08-27T09:32:51.000Z' },
  ];
  const after = [
    { domain: '.lexincloud.com', name: 'oa_session', expiresAt: '2026-09-05T02:11:52.000Z' },
    { domain: '.oa.fenqile.com', name: 'oa_token_id', expiresAt: '2026-08-29T02:33:24.000Z' },
  ];

  const diff = diffAuthCookies(before, after);
  assert.equal(diff.changedCount, 2);
  assert.deepEqual(diff.renewed, [{
    domain: '.lexincloud.com',
    name: 'oa_session',
    from: '2026-08-27T09:32:51.000Z',
    to: '2026-09-05T02:11:52.000Z',
  }]);
  assert.deepEqual(diff.added, [{
    domain: '.oa.fenqile.com',
    name: 'oa_token_id',
    expiresAt: '2026-08-29T02:33:24.000Z',
  }]);
});

test('renewal on the SSO endpoint counts as renewed even when the page itself looks like a login page', () => {
  const result = summarizeRenewalResult({
    sessionState: 'LOGIN_REQUIRED',
    sessionReady: false,
    requestedUrl: 'https://passport.lexincloud.com/',
    profileDir: '/tmp/profile',
    browserMode: 'headless',
    networkPolicy: { proxyMode: 'direct' },
    sessionHealth: { cookieCount: 4 },
    authRenewal: {
      renewed: [{ domain: '.lexincloud.com', name: 'oa_session', from: 'a', to: 'b' }],
      added: [],
      changedCount: 1,
    },
  });

  assert.equal(result.renewalState, 'SESSION_RENEWED');
  assert.equal(result.renewedAuthCookies, true);
  assert.equal(result.actionRequired, null);
});
