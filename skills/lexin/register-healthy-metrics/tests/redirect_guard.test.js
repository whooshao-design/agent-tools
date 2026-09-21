'use strict';
// 带 Bearer 的请求遇到跨源重定向必须停下，不能把凭据发给别的域名。
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestJson } = require('../scripts/register_metrics');

function fakeResponse(status, headers, body) {
  return { status, headers: new Map(Object.entries(headers)), text: async () => body, get ok() { return status >= 200 && status < 300; } };
}

test('cross-origin redirect is refused before a second request is sent', async () => {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return fakeResponse(302, { location: 'https://outside.example/next' }, '');
    return fakeResponse(200, {}, '{}');
  };
  try {
    await assert.rejects(requestJson('GET', 'https://healthy.lexincloud.com/api/n9e/metric-manage', 'token', {}, undefined), /another origin/);
    assert.equal(calls.length, 1);
  } finally {
    global.fetch = original;
  }
});

test('same-origin redirect is still followed', async () => {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return fakeResponse(302, { location: '/api/n9e/other' }, '');
    return fakeResponse(200, {}, '{"dat":1}');
  };
  try {
    await requestJson('GET', 'https://healthy.lexincloud.com/api/n9e/metric-manage', 'token', {}, undefined);
    assert.deepEqual(calls, ['https://healthy.lexincloud.com/api/n9e/metric-manage', 'https://healthy.lexincloud.com/api/n9e/other']);
  } finally {
    global.fetch = original;
  }
});
