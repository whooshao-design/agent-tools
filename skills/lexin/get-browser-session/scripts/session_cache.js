'use strict';

// Credential snapshot for scripts that only need cookies or a token, so they can call the
// target API directly instead of launching Chromium on the shared profile. Chromium holds an
// exclusive SingletonLock on a user-data-dir, so every browser launch serializes all sessions;
// a cache hit skips that entirely. The browser path stays the source of truth: it refreshes the
// snapshot after every successful run, and callers invalidate it when the API rejects it.
//
// Files live next to the profiles (same trust boundary as the profile's own cookie store),
// mode 0600, one file per (profile, origin).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function cacheDir() {
  return process.env.AGENT_TOOLS_SESSION_CACHE_DIR
    || path.join(os.homedir(), '.local/state/agent-tools/session-cache');
}

function disabled() {
  return /^(1|true|yes)$/i.test(process.env.AGENT_TOOLS_SESSION_CACHE_DISABLE || '');
}

function profileKey(profileDir) {
  try {
    return fs.realpathSync(profileDir);
  } catch (_) {
    return path.resolve(profileDir);
  }
}

function cacheFile(profileDir, url) {
  const origin = new URL(url).origin;
  const digest = crypto.createHash('sha256').update(`${profileKey(profileDir)}\n${origin}`).digest('hex').slice(0, 24);
  return path.join(cacheDir(), `${digest}.json`);
}

function readEntry(profileDir, url, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (disabled()) return null;
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(cacheFile(profileDir, url), 'utf8'));
  } catch (_) {
    return null;
  }
  if (!entry || !Number.isFinite(entry.savedAt) || Date.now() - entry.savedAt > maxAgeMs) return null;
  return entry;
}

function writeEntry(profileDir, url, patch) {
  if (disabled()) return;
  const file = cacheFile(profileDir, url);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (_) {
    // Missing or corrupt entries are simply replaced.
  }
  const entry = {
    ...previous,
    ...patch,
    origin: new URL(url).origin,
    savedAt: Date.now(),
  };
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function invalidate(profileDir, url) {
  try {
    fs.unlinkSync(cacheFile(profileDir, url));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function cookieAppliesTo(cookie, target, nowSeconds) {
  const expires = Number(cookie.expires);
  if (Number.isFinite(expires) && expires > 0 && expires <= nowSeconds) return false;
  if (cookie.secure && target.protocol !== 'https:') return false;
  const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  const host = target.hostname.toLowerCase();
  if (domain && host !== domain && !host.endsWith(`.${domain}`)) return false;
  const cookiePath = cookie.path || '/';
  return target.pathname === cookiePath
    || target.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
}

function cookieHeaderFrom(cookies, url, nowMs = Date.now()) {
  const target = new URL(url);
  const nowSeconds = nowMs / 1000;
  return (cookies || [])
    .filter((cookie) => cookie && cookie.name && cookieAppliesTo(cookie, target, nowSeconds))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

// Returns a Cookie header for `url`, or null when there is no fresh snapshot.
function readCookieHeader(profileDir, url, options = {}) {
  const entry = readEntry(profileDir, url, options.maxAgeMs);
  if (!entry || !Array.isArray(entry.cookies)) return null;
  return cookieHeaderFrom(entry.cookies, url) || null;
}

// Snapshot the cookies the browser would send to `url`. Call only after the browser path
// has proven the session works, otherwise a login-page cookie set gets cached.
async function saveContextCookies(context, profileDir, url) {
  if (disabled()) return;
  const cookies = await context.cookies([url]);
  if (!cookies.length) return;
  writeEntry(profileDir, url, {
    cookies: cookies.map(({ name, value, domain, path: cookiePath, expires, secure }) => ({
      name, value, domain, path: cookiePath, expires, secure,
    })),
  });
}

function readValue(profileDir, url, key, options = {}) {
  const entry = readEntry(profileDir, url, options.maxAgeMs);
  const values = entry && entry.values;
  return values && Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
}

function saveValue(profileDir, url, key, value) {
  if (disabled()) return;
  let values = {};
  try {
    values = JSON.parse(fs.readFileSync(cacheFile(profileDir, url), 'utf8')).values || {};
  } catch (_) {
    // Start a fresh values map.
  }
  writeEntry(profileDir, url, { values: { ...values, [key]: value } });
}

// fetch() with the cached cookies. Redirects are not followed so that an SSO bounce shows up
// as a 3xx instead of a 200 login page; callers treat 3xx/401/HTML as a stale snapshot.
async function fetchWithCookies(cookieHeader, url, options = {}) {
  const target = new URL(url);
  const response = await fetch(url, {
    method: options.method || 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs || 90000),
    headers: {
      accept: 'application/json, text/plain, */*',
      origin: target.origin,
      referer: options.referer || `${target.origin}/`,
      ...(options.headers || {}),
      cookie: cookieHeader,
    },
    body: options.body,
  });
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    url: response.url || url,
    contentType: response.headers.get('content-type') || '',
    text,
  };
}

// True when a direct response looks like the session was rejected rather than a real API answer.
function looksUnauthenticated(result) {
  if (!result) return true;
  if (result.status === 401 || result.status === 403) return true;
  if (result.status >= 300 && result.status < 400) return true;
  return /text\/html/i.test(result.contentType) || /^\s*</.test(result.text || '');
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  cacheFile,
  cookieHeaderFrom,
  fetchWithCookies,
  invalidate,
  looksUnauthenticated,
  readCookieHeader,
  readValue,
  saveContextCookies,
  saveValue,
};
