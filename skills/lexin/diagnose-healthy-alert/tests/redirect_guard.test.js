"use strict";
// 告警链接只认两个 Healthy 站点；带凭据的请求不跟随跨源重定向。
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestJson, baseUrlFromAlertLink, resolveBaseUrl } = require('../scripts/diagnose_alert');

function fakeResponse(status, headers, body) {
  return { status, headers: new Map(Object.entries(headers)), text: async () => body };
}

test('alert links from unknown hosts are rejected; env conflicts are rejected', () => {
  assert.equal(baseUrlFromAlertLink('https://stable-eye.oa.fenqile.com/alert-show-detail/42'), 'https://stable-eye.oa.fenqile.com');
  assert.throws(() => baseUrlFromAlertLink('https://outside.example/alert-show-detail/42'), /not a supported Healthy site/);
  assert.equal(resolveBaseUrl({ alert: 'https://stable-eye.oa.fenqile.com/alert-show-detail/42' }), 'https://stable-eye.oa.fenqile.com');
  assert.throws(() => resolveBaseUrl({ alert: 'https://stable-eye.oa.fenqile.com/alert-show-detail/42', env: 'prod' }), /drop one of them/);
});

test('cross-origin redirect is refused before a second request is sent', async () => {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return fakeResponse(302, { location: 'https://outside.example/next' }, '');
    return fakeResponse(200, {}, '{}');
  };
  try {
    await assert.rejects(requestJson('https://healthy.lexincloud.com/api/n9e/alert-show-detail/1', { token: 't', ticket: '' }, {}), /another origin/);
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = original;
  }
});
