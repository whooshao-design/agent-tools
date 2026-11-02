'use strict';

const fs = require('fs');
const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  acquireProfileLock,
  canUseProfileClone,
  createProfileClone,
  launchReadOnlyContext,
  moveToReadOnlyContext,
  openProfileClone,
  pruneProfileClones,
  trackRequests,
} = require('../scripts/browser_session');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-clone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeProfile(base) {
  const profile = path.join(base, 'main');
  fs.mkdirSync(path.join(profile, 'Default/Local Storage/leveldb'), { recursive: true });
  fs.mkdirSync(path.join(profile, 'Default/Cache'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Local State'), '{}');
  fs.writeFileSync(path.join(profile, 'Default/Local Storage/leveldb/000.log'), 'ls');
  fs.writeFileSync(path.join(profile, 'Default/Cache/big'), 'cache');
  const db = new DatabaseSync(path.join(profile, 'Default/Cookies'));
  db.exec('CREATE TABLE cookies (name TEXT); INSERT INTO cookies VALUES (\'oa_session\')');
  db.close();
  return profile;
}

test('a clone holds only the login state, is private, and is removed', (t) => {
  const base = tempDir(t);
  const clone = createProfileClone(makeProfile(base), { root: path.join(base, 'clones') });
  assert.ok(fs.existsSync(path.join(clone.dir, 'Local State')));
  assert.ok(fs.existsSync(path.join(clone.dir, 'Default/Cookies')));
  assert.ok(fs.existsSync(path.join(clone.dir, 'Default/Local Storage/leveldb/000.log')));
  assert.equal(fs.existsSync(path.join(clone.dir, 'Default/Cache')), false);
  assert.equal(fs.statSync(clone.dir).mode & 0o777, 0o700);
  clone.remove();
  assert.equal(fs.existsSync(clone.dir), false);
});

test('a copy that raced a Cookies write is retried', (t) => {
  const base = tempDir(t);
  const profile = makeProfile(base);
  const cookies = path.join(profile, 'Default/Cookies');
  let cookieCopies = 0;
  const clone = createProfileClone(profile, {
    root: path.join(base, 'clones'),
    copy: (from, to) => {
      fs.cpSync(from, to, { recursive: true });
      if (from === cookies && (cookieCopies += 1) === 1) {
        fs.utimesSync(cookies, new Date(), new Date(Date.now() + 5000));
      }
    },
  });
  assert.equal(cookieCopies, 2);
  clone.remove();
});

test('a corrupt Cookies copy is rejected and leaves no clone behind', (t) => {
  const base = tempDir(t);
  const profile = makeProfile(base);
  fs.writeFileSync(path.join(profile, 'Default/Cookies'), 'not a sqlite database'.repeat(100));
  const root = path.join(base, 'clones');
  assert.throws(() => createProfileClone(profile, { root }));
  assert.deepEqual(fs.readdirSync(root), []);
});

test('pruning removes clones of dead processes and keeps live ones', (t) => {
  const root = tempDir(t);
  const dead = path.join(root, 'main-999999999-abc');
  const live = path.join(root, `main-${process.pid}-abc`);
  fs.mkdirSync(dead);
  fs.mkdirSync(live);
  pruneProfileClones(root);
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.existsSync(live), true);
  pruneProfileClones(root, Date.now() + 25 * 60 * 60 * 1000);
  assert.equal(fs.existsSync(live), false);
});

function fakeChromium(launched) {
  return {
    launchPersistentContext: async (dir) => {
      launched.push(dir);
      return { close: async () => {} };
    },
  };
}

test('readers run in parallel while the shared profile is locked', async (t) => {
  const base = tempDir(t);
  const profile = makeProfile(base);
  const release = await acquireProfileLock(profile, { timeoutMs: 100 });
  t.after(release);
  const launched = [];
  const options = { root: path.join(base, 'clones') };
  const contexts = await Promise.all([
    launchReadOnlyContext(fakeChromium(launched), profile, {}, options),
    launchReadOnlyContext(fakeChromium(launched), profile, {}, options),
  ]);
  assert.equal(new Set(launched).size, 2);
  assert.ok(!launched.includes(profile));
  await Promise.all(contexts.map((context) => context.close()));
  assert.deepEqual(fs.readdirSync(options.root), []);
});

test('a reader falls back to the shared profile when it cannot copy', async (t) => {
  const base = tempDir(t);
  const profile = path.join(base, 'empty');
  fs.mkdirSync(profile);
  const launched = [];
  const context = await launchReadOnlyContext(fakeChromium(launched), profile, {}, { root: path.join(base, 'clones') });
  assert.deepEqual(launched, [profile]);
  assert.ok(fs.existsSync(`${fs.realpathSync(profile)}.agent-tools.lock`));
  await context.close();
  assert.equal(fs.existsSync(`${fs.realpathSync(profile)}.agent-tools.lock`), false);
});

test('only flows that persist nothing may use a copy', () => {
  const url = 'https://lexiao.oa.fenqile.com/';
  const allowed = (extra) => canUseProfileClone({ mode: 'status', url, headless: true, ...extra });
  assert.equal(allowed({}), true);
  assert.equal(allowed({ mode: 'cookies' }), true);
  assert.equal(allowed({ mode: 'storage' }), true);
  assert.equal(allowed({ mode: 'request', requestMethod: 'GET' }), true);
  assert.equal(allowed({ mode: 'request', requestMethod: 'POST' }), false);
  for (const mode of ['ensure', 'renew', 'export']) assert.equal(allowed({ mode }), false, mode);
  assert.equal(allowed({ headless: false }), false);
  assert.equal(allowed({ args: { 'click-text': 'x' } }), false);
  assert.equal(allowed({ args: { 'click-button': 'x' } }), false);
  assert.equal(allowed({ url: 'https://webshell.oa.fenqile.com/?arg=1' }), false);
  assert.equal(allowed({ url: 'https://healthy.lexincloud.com/' }), false);
  assert.equal(allowed({ url: 'https://stable-eye.oa.fenqile.com/' }), false);
});

function fakePage() {
  const page = new EventEmitter();
  page.waitForTimeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return page;
}

test('trackRequests waits for a request started by a click to finish', async () => {
  const page = fakePage();
  const settled = trackRequests(page);
  const request = {};
  page.emit('request', request);
  let done = false;
  const waiting = settled({ graceMs: 5, timeoutMs: 1000, pollMs: 5 }).then((value) => { done = true; return value; });
  await page.waitForTimeout(40);
  assert.equal(done, false);
  page.emit('requestfinished', request);
  assert.equal(await waiting, true);
});

test('trackRequests ignores polling that starts after the grace period', async () => {
  const page = fakePage();
  const settled = trackRequests(page);
  const waiting = settled({ graceMs: 5, timeoutMs: 1000, pollMs: 5 });
  await page.waitForTimeout(20);
  page.emit('request', {}); // never finishes
  assert.equal(await waiting, true);
});

test('trackRequests reports false when a pending request never finishes', async () => {
  const page = fakePage();
  const settled = trackRequests(page);
  page.emit('request', {});
  assert.equal(await settled({ graceMs: 1, timeoutMs: 30, pollMs: 5 }), false);
});

test('trackRequests treats a failed request as finished', async () => {
  const page = fakePage();
  const settled = trackRequests(page);
  const request = {};
  page.emit('request', request);
  page.emit('requestfailed', request);
  assert.equal(await settled({ graceMs: 1, timeoutMs: 500, pollMs: 5 }), true);
});

test('slots cap concurrent copies and are freed on remove', async (t) => {
  const base = tempDir(t);
  const profile = makeProfile(base);
  const options = { root: path.join(base, 'clones'), slots: 2, slotPollMs: 5 };
  const first = await openProfileClone(profile, options);
  const second = await openProfileClone(profile, options);
  await assert.rejects(openProfileClone(profile, { ...options, slotWaitMs: 20 }), /slots are busy/);
  const third = openProfileClone(profile, { ...options, slotWaitMs: 2000 });
  first.remove();
  (await third).remove();
  second.remove();
  assert.deepEqual(fs.readdirSync(options.root), []);
  assert.deepEqual(fs.readdirSync(`${options.root}-slots`), []);
});

test('a slot is freed when the copy fails', async (t) => {
  const base = tempDir(t);
  const empty = path.join(base, 'empty');
  fs.mkdirSync(empty);
  const options = { root: path.join(base, 'clones'), slots: 1, slotWaitMs: 0 };
  await assert.rejects(openProfileClone(empty, options), /no Cookies database/);
  (await openProfileClone(makeProfile(base), options)).remove();
});

test('a reader queues on the shared profile when no slot is free', async (t) => {
  const base = tempDir(t);
  const profile = makeProfile(base);
  const options = { root: path.join(base, 'clones'), slots: 1, slotWaitMs: 0 };
  const held = await openProfileClone(profile, options);
  t.after(held.remove);
  const launched = [];
  const context = await launchReadOnlyContext(fakeChromium(launched), profile, {}, options);
  assert.deepEqual(launched, [profile]);
  await context.close();
});

function fakeContext(events, name) {
  return {
    pages: () => [{ name }],
    close: async () => { events.push(`close ${name}`); },
  };
}

test('moveToReadOnlyContext closes the shared context before opening the copy', async () => {
  const events = [];
  const session = { context: fakeContext(events, 'shared') };
  const next = await moveToReadOnlyContext(session, { name: 'old' }, {
    requestsSettled: async () => { events.push('settled'); return true; },
    openReadOnly: async () => { events.push('open'); return fakeContext(events, 'copy'); },
    prepare: async (page) => { events.push(`prepare ${page.name}`); },
    retryHint: 'x',
  });
  assert.deepEqual(events, ['settled', 'close shared', 'open', 'prepare copy']);
  assert.equal(next.name, 'copy');
  await session.context.close();
  assert.equal(events.at(-1), 'close copy');
});

test('moveToReadOnlyContext stays on the shared context while requests are pending', async () => {
  const events = [];
  const session = { context: fakeContext(events, 'shared') };
  const page = { name: 'old' };
  const opened = [];
  const result = await moveToReadOnlyContext(session, page, {
    requestsSettled: async () => false,
    openReadOnly: async () => { opened.push(1); },
    prepare: async () => {},
    retryHint: 'x',
  });
  assert.equal(result, page);
  assert.deepEqual(events, []);
  assert.deepEqual(opened, []);
});

test('moveToReadOnlyContext warns against re-triggering when polling cannot start', async () => {
  const session = { context: fakeContext([], 'shared') };
  await assert.rejects(moveToReadOnlyContext(session, {}, {
    requestsSettled: async () => true,
    openReadOnly: async () => { throw new Error('boom'); },
    prepare: async () => {},
    retryHint: '--action=status',
  }), /不要重复触发.*--action=status.*boom/);
});
