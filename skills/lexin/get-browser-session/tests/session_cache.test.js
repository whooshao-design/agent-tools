'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cache-test-'));
process.env.AGENT_TOOLS_SESSION_CACHE_DIR = path.join(cacheRoot, 'cache');
const sessionCache = require('../scripts/session_cache');
const { launchLockedContext } = require('../scripts/browser_session');

test.after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));

function fakeContext(cookies) {
  return { cookies: async () => cookies };
}

test('cookie header keeps only unexpired cookies that match host, path and scheme', () => {
  const now = Date.parse('2026-10-14T00:00:00Z');
  const header = sessionCache.cookieHeaderFrom([
    { name: 'sso', value: 'a', domain: '.fenqile.com', path: '/', expires: -1 },
    { name: 'api', value: 'b', domain: 'log.oa.fenqile.com', path: '/api', expires: now / 1000 + 60 },
    { name: 'old', value: 'c', domain: '.fenqile.com', path: '/', expires: now / 1000 - 1 },
    { name: 'other', value: 'd', domain: 'lexincloud.com', path: '/' },
    { name: 'deep', value: 'e', domain: '.fenqile.com', path: '/apix' },
    { name: 'tls', value: 'f', domain: '.fenqile.com', path: '/', secure: true },
  ], 'https://log.oa.fenqile.com/api/archLog/page', now);
  assert.equal(header, 'sso=a; api=b; tls=f');
});

test('snapshot round-trips per profile and origin with 0600 permissions', async () => {
  const profile = path.join(cacheRoot, 'profile-a');
  fs.mkdirSync(profile);
  await sessionCache.saveContextCookies(
    fakeContext([{ name: 'sid', value: 'v1', domain: 'lexiao-api.oa.fenqile.com', path: '/' }]),
    profile,
    'https://lexiao-api.oa.fenqile.com',
  );
  assert.equal(sessionCache.readCookieHeader(profile, 'https://lexiao-api.oa.fenqile.com/oa/x.json'), 'sid=v1');
  assert.equal(sessionCache.readCookieHeader(profile, 'https://log.oa.fenqile.com/'), null);
  assert.equal(sessionCache.readCookieHeader(path.join(cacheRoot, 'profile-b'), 'https://lexiao-api.oa.fenqile.com/'), null);
  const file = sessionCache.cacheFile(profile, 'https://lexiao-api.oa.fenqile.com');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  sessionCache.invalidate(profile, 'https://lexiao-api.oa.fenqile.com');
  assert.equal(sessionCache.readCookieHeader(profile, 'https://lexiao-api.oa.fenqile.com/'), null);
});

test('stale snapshots are ignored', async () => {
  const profile = path.join(cacheRoot, 'profile-stale');
  await sessionCache.saveContextCookies(
    fakeContext([{ name: 'sid', value: 'v', domain: 'a.fenqile.com', path: '/' }]),
    profile,
    'https://a.fenqile.com',
  );
  const file = sessionCache.cacheFile(profile, 'https://a.fenqile.com');
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...entry, savedAt: Date.now() - sessionCache.DEFAULT_MAX_AGE_MS - 1 }));
  assert.equal(sessionCache.readCookieHeader(profile, 'https://a.fenqile.com/'), null);
});

test('login redirects and HTML pages count as a rejected session', () => {
  assert.equal(sessionCache.looksUnauthenticated({ status: 302, contentType: '', text: '' }), true);
  assert.equal(sessionCache.looksUnauthenticated({ status: 401, contentType: 'application/json', text: '{}' }), true);
  assert.equal(sessionCache.looksUnauthenticated({ status: 200, contentType: 'text/html', text: '<html>' }), true);
  assert.equal(sessionCache.looksUnauthenticated({ status: 200, contentType: 'application/json', text: '{"retcode":0}' }), false);
  assert.equal(sessionCache.looksUnauthenticated({ status: 500, contentType: 'application/json', text: '{}' }), false);
});

test('launchLockedContext queues a second launcher until the first context closes', async () => {
  const profile = path.join(cacheRoot, 'profile-lock');
  fs.mkdirSync(profile);
  const events = [];
  const chromium = {
    launchPersistentContext: async () => {
      events.push('launch');
      return { close: async () => { events.push('close'); } };
    },
  };
  const first = await launchLockedContext(chromium, profile, {}, { timeoutMs: 2000, pollMs: 5 });
  const second = launchLockedContext(chromium, profile, {}, { timeoutMs: 2000, pollMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, ['launch']);
  await first.close();
  const secondContext = await second;
  assert.deepEqual(events, ['launch', 'close', 'launch']);
  await secondContext.close();
});

test('launchLockedContext releases the lock when the launch fails', async () => {
  const profile = path.join(cacheRoot, 'profile-fail');
  fs.mkdirSync(profile);
  const failing = { launchPersistentContext: async () => { throw new Error('boom'); } };
  await assert.rejects(launchLockedContext(failing, profile, {}, { timeoutMs: 100, pollMs: 5 }), /boom/);
  const ok = { launchPersistentContext: async () => ({ close: async () => {} }) };
  const context = await launchLockedContext(ok, profile, {}, { timeoutMs: 100, pollMs: 5 });
  await context.close();
});
