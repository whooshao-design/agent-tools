'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPageStatus, waitForStableSession } = require('../scripts/browser_session');

const TARGET = 'https://webshell.oa.fenqile.com/?ns=ns&pod=pod&container=app&cluster=cluster&command=/bin/bash';

function snapshot(overrides = {}) {
  return {
    title: 'GoTTY',
    url: TARGET,
    hasSuccessText: false,
    hasLoginText: false,
    hasLoginControl: false,
    hasPortalText: false,
    hasForbiddenText: false,
    terminalReady: false,
    snippet: '',
    buttons: [],
    ...overrides,
  };
}

test('WebShell is ready only when terminal DOM exists on the target host', () => {
  const connecting = classifyPageStatus(snapshot(), { targetUrl: TARGET, successText: '' });
  assert.equal(connecting.sessionState, 'CONNECTING');
  assert.equal(connecting.sessionReady, false);

  const ready = classifyPageStatus(snapshot({ terminalReady: true }), { targetUrl: TARGET, successText: '' });
  assert.equal(ready.sessionState, 'READY');
  assert.equal(ready.sessionReady, true);
});

test('ATrust portal has priority over transient Gotty terminal markers', () => {
  const result = classifyPageStatus(snapshot({
    url: 'https://atrust.example.invalid/portal',
    terminalReady: true,
    hasPortalText: true,
  }), { targetUrl: TARGET, successText: '' });
  assert.equal(result.sessionState, 'PROXY_INTERCEPTED');
  assert.equal(result.sessionReady, false);
});

test('login and forbidden states are never treated as ready', () => {
  const login = classifyPageStatus(snapshot({ hasLoginText: true, hasLoginControl: true, terminalReady: true }), { targetUrl: TARGET });
  assert.equal(login.sessionState, 'LOGIN_REQUIRED');

  const forbidden = classifyPageStatus(snapshot({ hasForbiddenText: true, terminalReady: true }), { targetUrl: TARGET });
  assert.equal(forbidden.sessionState, 'FORBIDDEN');
});

test('application log words inside an active terminal do not become login markers', () => {
  const result = classifyPageStatus(snapshot({
    hasLoginText: true,
    hasLoginControl: false,
    terminalReady: true,
  }), { targetUrl: TARGET });
  assert.equal(result.sessionState, 'READY');
  assert.equal(result.sessionReady, true);
});

test('generic pages still require the target host and configured success text', () => {
  const target = 'https://lexiao.oa.fenqile.com/#/home';
  const result = classifyPageStatus(snapshot({
    url: target,
    hasSuccessText: true,
  }), { targetUrl: target, successText: '当前环境' });
  assert.equal(result.sessionState, 'READY');
  assert.equal(result.sessionReady, true);
});

test('generic pages with an HTTP error are never treated as ready', () => {
  const target = 'https://lexiao.oa.fenqile.com/#/home';
  const result = classifyPageStatus(snapshot({
    url: target,
  }), { targetUrl: target, successText: '', httpStatus: 500 });
  assert.equal(result.sessionState, 'UPSTREAM_ERROR');
  assert.equal(result.sessionReady, false);

  const unauthorized = classifyPageStatus(snapshot({ url: target }), {
    targetUrl: target,
    successText: '',
    httpStatus: 401,
  });
  assert.equal(unauthorized.sessionState, 'LOGIN_REQUIRED');

  const forbidden = classifyPageStatus(snapshot({ url: target }), {
    targetUrl: target,
    successText: '',
    httpStatus: 403,
  });
  assert.equal(forbidden.sessionState, 'FORBIDDEN');
});

test('a transient terminal followed by delayed portal redirect never becomes stable READY', async () => {
  const snapshots = [
    snapshot({ terminalReady: true }),
    snapshot({
      url: 'https://atrust.example.invalid/portal',
      terminalReady: false,
      hasPortalText: true,
    }),
  ];
  const page = {
    evaluate: async () => snapshots.shift() || snapshots[snapshots.length - 1],
    waitForTimeout: async () => {},
  };
  const result = await waitForStableSession(page, {
    targetUrl: TARGET,
    successText: '',
    loginPattern: '登录',
    portalPattern: 'ATrust',
    forbiddenPattern: '403',
    stablePolls: 3,
    stableDwellMs: 0,
    waitForLogin: false,
    timeoutMs: 1000,
    pollMs: 1,
  });
  assert.equal(result.sessionState, 'PROXY_INTERCEPTED');
  assert.equal(result.sessionReady, false);
});
