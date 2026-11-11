'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GatewayError, buildUrl, callGateway, decodeClaims, eyeQuery, isTransient, parseCli } = require('../scripts/lxctl_gateway');

function response(status, body) {
  return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

function deps(responses, extra = {}) {
  const calls = [];
  const state = { token: 'tok-1', refreshes: 0 };
  return {
    calls,
    state,
    base: 'https://gw.example/ctx/prefix',
    fetchImpl: async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization, appId: init.headers['X-AI-AppId'], method: init.method, body: init.body });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    readTokenImpl: () => (state.token ? { accessToken: state.token, userMin: 'u' } : null),
    refreshImpl: () => { state.refreshes += 1; state.token = 'tok-2'; return { ok: true }; },
    sleepImpl: async () => {},
    ...extra,
  };
}

test('buildUrl joins base, path and query parameters', () => {
  assert.equal(buildUrl('https://gw/ctx', '/api/eye', { query: 'up{app="a"}' }), 'https://gw/ctx/api/eye?query=up%7Bapp%3D%22a%22%7D');
  assert.equal(buildUrl('https://gw/ctx', 'ai/x', {}), 'https://gw/ctx/ai/x');
});

test('a successful call sends the token and app id and returns the body', async () => {
  const d = deps([response(200, { retcode: 0, resultRows: [1] })]);
  const json = await callGateway({ method: 'POST', path: '/ai/archLog/page', appId: 'arch_log_service', body: { app: 'a' } }, d);
  assert.deepEqual(json, { retcode: 0, resultRows: [1] });
  assert.deepEqual(d.calls, [{ url: 'https://gw.example/ctx/prefix/ai/archLog/page', auth: 'Bearer tok-1', appId: 'arch_log_service', method: 'POST', body: '{"app":"a"}' }]);
});

test('a rejected token is refreshed once and the call retried with the new token', async () => {
  const d = deps([response(200, { retcode: '16051001', retmsg: 'B端应用请求缺少 X-User-Min Header' }), response(200, { retcode: 0 })]);
  assert.deepEqual(await callGateway({ path: '/x', appId: 'a' }, d), { retcode: 0 });
  assert.equal(d.state.refreshes, 1);
  assert.deepEqual(d.calls.map((call) => call.auth), ['Bearer tok-1', 'Bearer tok-2']);
});

test('a token still rejected after the refresh, or a failed refresh, asks for a new login', async () => {
  const rejected = { retcode: '16051001', retmsg: 'no min' };
  await assert.rejects(callGateway({ path: '/x', appId: 'a' }, deps([response(200, rejected), response(200, rejected)])),
    (error) => error instanceof GatewayError && error.code === 'TOKEN_REJECTED' && /lxctl auth login/.test(error.message));
  await assert.rejects(callGateway({ path: '/x', appId: 'a' }, deps([response(200, rejected)], { refreshImpl: () => ({ ok: false, reason: 'expired' }) })),
    (error) => error.code === 'TOKEN_REJECTED' && /expired/.test(error.message));
});

test('missing token, forbidden app id and non-JSON bodies are reported without retrying', async () => {
  await assert.rejects(callGateway({ path: '/x', appId: 'a' }, deps([], { readTokenImpl: () => null })), (error) => error.code === 'NOT_LOGGED_IN');
  const forbidden = deps([response(200, { retcode: '16051009', retmsg: '抱歉，您暂无权限访问' })]);
  await assert.rejects(callGateway({ path: '/x', appId: 'a' }, forbidden), (error) => error.code === 'FORBIDDEN');
  assert.equal(forbidden.calls.length, 1);
  await assert.rejects(callGateway({ path: '/x', appId: 'a' }, deps([response(200, '<html>')])), (error) => error.code === 'BAD_RESPONSE');
});

test('transient failures are retried up to the limit, then surfaced', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const tls = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const ok = deps([timeout, response(502, 'bad gateway'), response(200, { retcode: 0 })]);
  assert.deepEqual(await callGateway({ path: '/x', appId: 'a' }, ok), { retcode: 0 });
  assert.equal(ok.calls.length, 3);
  const upstream = { retcode: '16051000', retmsg: 'HTTP 调用失败，状态码：502' };
  await assert.rejects(callGateway({ path: '/x', appId: 'a', retries: 1 }, deps([tls, response(200, upstream)])), (error) => error.code === 'UPSTREAM_FAILED');
  await assert.rejects(callGateway({ path: '/x', appId: 'a', retries: 0 }, deps([timeout])), (error) => error.code === 'NETWORK' && /no response within/.test(error.message));
  assert.equal(isTransient(new Error('bad argument')), false);
});

test('an upstream retcode that is not a gateway code is returned to the caller', async () => {
  const body = { retcode: -1, retmsg: '查询日志出错！' };
  assert.deepEqual(await callGateway({ path: '/x', appId: 'a' }, deps([response(200, body)])), body);
});

test('eyeQuery unwraps the Prometheus data and reports failures', async () => {
  const data = { resultType: 'vector', result: [{ metric: { ident: '10.0.0.1' }, value: [1, '72.01'] }] };
  const d = deps([response(200, { retcode: '0', resultRows: [{ status: 'success', data }] })]);
  assert.deepEqual(await eyeQuery('up', {}, d), data);
  assert.match(d.calls[0].url, /\/api\/eye\?query=up$/);
  assert.equal(d.calls[0].appId, 'eye');
  await assert.rejects(eyeQuery('up', {}, deps([response(200, { retcode: '0', resultRows: [{ status: 'error', error: 'parse error' }] })])), /parse error/);
});

test('decodeClaims reads the user from an id token and tolerates garbage', () => {
  const token = `x.${Buffer.from(JSON.stringify({ userMin: 'alice' })).toString('base64url')}.y`;
  assert.equal(decodeClaims(token).userMin, 'alice');
  assert.deepEqual(decodeClaims('not-a-jwt'), {});
});

test('parseCli collects positional command, values, flags and repeated params', () => {
  assert.deepEqual(parseCli(['call', '--path', '/a', '--app-id=x', '--param', 'k=v=1', '--param=n=2', '--probe']),
    { _: ['call'], query: { k: 'v=1', n: '2' }, path: '/a', 'app-id': 'x', probe: true });
  assert.throws(() => parseCli(['call', '--path']), /requires a value/);
  assert.throws(() => parseCli(['call', '--param', 'novalue']), /key=value/);
});
