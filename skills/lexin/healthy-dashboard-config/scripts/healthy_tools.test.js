const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { apiUrl, openSessionPage, readPageAuth, requestJson, resolveBaseUrl } = require('./healthy_client');
const { configsHash, dashboardUrl, hawkReadThroughPatch, queryResponseSummary, updateBoard } = require('./healthy_dashboard_config');
const { inspectMetric, loadMetrics, loadQueries, parseBatchResults, parseDuration, runQueries } = require('../../inspect-healthy-metrics/scripts/inspect_metrics');
const { buildBrowserEnv, chromiumArgsFor } = require('../../get-browser-session/scripts/browser_network');

const base = 'https://healthy.lexincloud.com';
const queries = [{ name: 'current', expr: 'count(up)' }, { name: 'missing', expr: 'missing_metric' }];

test('鉴权只使用 access_token，与 refresh_token 的插入顺序无关', () => {
  for (const entries of [[['refresh_token', 'refresh'], ['access_token', 'access']], [['refresh_token', 'refresh']]]) {
    const values = new Map(entries);
    const auth = vm.runInNewContext(`(${readPageAuth.toString()})()`, { localStorage: { getItem: key => values.get(key) } });
    assert.equal(auth.token, values.get('access_token') || '');
    assert.notEqual(auth.token, 'refresh');
  }
});

test('站点映射和请求同源限制', () => {
  assert.equal(resolveBaseUrl({ env: 'stable' }), 'https://stable-eye.oa.fenqile.com');
  assert.equal(resolveBaseUrl({ env: 'pre' }), base);
  assert.throws(() => resolveBaseUrl({ 'base-url': 'https://example.com' }));
  for (const url of ['https://example.com/api/n9e/query', '//example.com/api/n9e/query', '/login']) {
    assert.throws(() => apiUrl(base, url));
  }
});

test('复用会话层的直连策略会移除代理变量', () => {
  const { env } = buildBrowserEnv(base, { HTTPS_PROXY: 'proxy', http_proxy: 'proxy', PATH: '/bin' });
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.http_proxy, undefined);
  assert.equal(env.PATH, '/bin');
  assert.ok(chromiumArgsFor(base).includes('--no-proxy-server'));
});

test('请求传递 JSON 和 access token，HTTP 401 不泄露凭据或响应正文', async () => {
  const page = { evaluate: async (fn, args) => {
    if (!args) return { token: 'test-access', ticket: 'test-ticket' };
    assert.equal(args.headers.authorization, 'Bearer test-access');
    assert.deepEqual(args.body, { queries: [] });
    return { status: 401, ok: false, json: { secret: 'test-secret' } };
  } };
  await assert.rejects(requestJson(page, base, {}, 'POST', '/api/n9e/query-range-batch', { queries: [] }), error => {
    assert.match(error.message, /401/);
    assert.equal(error.status, 401);
    assert.doesNotMatch(error.message, /test-access|test-ticket|test-secret/);
    return true;
  });
});

test('查询超时参数传到浏览器，网络错误类型保留且正文脱敏', async () => {
  for (const stage of ['fetch', 'body']) {
    const timeoutValues = [];
    const failure = Object.assign(new Error('sensitive error body'), { name: 'TimeoutError' });
    const page = { evaluate: async (fn, args) => {
      if (!args) return { token: 'test-access', ticket: '' };
      return vm.runInNewContext(`(${fn.toString()})(payload)`, {
        payload: args,
        AbortSignal: { timeout: ms => { timeoutValues.push(ms); return {}; } },
        fetch: async () => {
          if (stage === 'fetch') throw failure;
          return { status: 200, ok: true, json: async () => { throw failure; } };
        },
      });
    } };
    await assert.rejects(requestJson(page, base, { 'http-timeout': 1234 }, 'POST', '/api/n9e/prometheus/api/v1/query'), error => {
      assert.equal(error.name, 'TimeoutError');
      assert.doesNotMatch(error.message, /sensitive|test-access/);
      return true;
    });
    assert.deepEqual(timeoutValues, [1234]);
  }
});

test('非 JSON 响应保留 HTTP 状态，未指定超时时维持原默认值', async () => {
  const page = { evaluate: async (fn, args) => {
    if (!args) return { token: 'test-access', ticket: '' };
    assert.equal(args.timeoutMs, 60000);
    return vm.runInNewContext(`(${fn.toString()})(payload)`, {
      payload: args, AbortSignal: { timeout: () => ({}) },
      fetch: async () => ({ status: 503, ok: false, json: async () => { throw new SyntaxError('sensitive response'); } }),
    });
  } };
  await assert.rejects(requestJson(page, base, {}, 'POST', '/api/n9e/prometheus/api/v1/query'), error => {
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});

test('无 access token 不发起 API 请求', async () => {
  let calls = 0;
  const page = { evaluate: async () => { calls++; return { token: '' }; } };
  await assert.rejects(requestJson(page, base, {}, 'GET', '/api/n9e/board/1'), /access_token/);
  assert.equal(calls, 1);
});

test('显式凭据模式无需 profile 登录，临时页面路由在失败时仍释放', async () => {
  const calls = [];
  const page = {
    route: async url => { calls.push(['route', url]); },
    goto: async url => { calls.push(['goto', url]); throw new Error('navigation failed'); },
    unroute: async url => { calls.push(['unroute', url]); },
  };
  await assert.rejects(openSessionPage(page, base, true), /navigation failed/);
  assert.deepEqual(calls.map(item => item[0]), ['route', 'goto', 'unroute']);
  assert.ok(calls.every(item => new URL(item[1]).origin === base));
});

test('全量更新版本冲突或相同目标都不 PUT', async () => {
  const before = { panels: [] };
  const client = { request: async () => { throw new Error('不得请求'); } };
  await assert.rejects(updateBoard(client, '/board', before, { panels: [1] }, 'stale', () => {}), /已变化/);
  const result = await updateBoard(client, '/board', before, before, configsHash(before), () => {});
  assert.equal(result.changed, false);
});

test('写入前再次回读发现并发修改时终止', async () => {
  const before = { panels: [] };
  const methods = [];
  const client = { request: async method => { methods.push(method); return { json: { dat: { configs: { panels: ['other'] } } } }; } };
  await assert.rejects(updateBoard(client, '/board', before, { panels: [1] }, configsHash(before), () => {}), /写入前/);
  assert.deepEqual(methods, ['GET']);
});

test('写入格式保持 configs 字符串，回读完整验证并保留非目标字段', async () => {
  const before = { panels: [], var: [], unrelated: { keep: true } };
  const desired = { ...before, panels: [{ name: 'new' }] };
  let saved;
  const methods = [];
  const client = { request: async (method, url, body) => {
    methods.push(method);
    if (method === 'PUT') { assert.deepEqual(JSON.parse(body.configs), desired); return { json: {} }; }
    return { json: { dat: { configs: JSON.stringify(methods.length === 1 ? before : desired) } } };
  } };
  const result = await updateBoard(client, '/board', before, desired, configsHash(before), board => { saved = board; });
  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(saved.configs), desired);
  assert.deepEqual(methods, ['GET', 'PUT', 'GET']);
});

test('写入后回读不同不能报告成功', async () => {
  const before = { panels: [] };
  let saved = false;
  const client = { request: async () => ({ json: { dat: { configs: before } } }) };
  await assert.rejects(updateBoard(client, '/board', before, { panels: [1] }, configsHash(before), () => { saved = true; }), /回读/);
  assert.equal(saved, true);
});

test('query 变量通过 URL JSON 选择，textbox 保持字符串', () => {
  const configs = { var: [{ name: 'env', type: 'query' }, { name: 'ruleCode', type: 'textbox' }] };
  const url = new URL(dashboardUrl(base, 1, configs, { env: 'pre', ruleCode: '.*' }));
  assert.deepEqual(JSON.parse(url.searchParams.get('env')), ['pre']);
  assert.equal(JSON.parse(url.searchParams.get('ruleCode')), '.*');
  assert.throws(() => dashboardUrl(base, 1, configs, { unknown: 'x' }), /不存在变量/);
});

test('页面查询中的错误或未替换变量会被识别', () => {
  const url = `${base}/api/n9e/query-range-batch`;
  const request = { queries: [{ query: 'up{env="$env"}' }] };
  assert.equal(queryResponseSummary(url, 200, request, { dat: [[]] }).unresolved.length, 1);
  assert.equal(queryResponseSummary(url, 200, {}, { err: 'invalid promql' }).failed, true);
  assert.equal(queryResponseSummary(url, 401, {}, null).failed, true);
  assert.equal(queryResponseSummary(url, 200, {}, { dat: [] }).failed, false);
});

test('模板保留原有面板和字段，不写无效 query defaultValue', () => {
  const before = { panels: [{ name: 'existing' }], var: [{ name: 'other', type: 'textbox' }], keep: true };
  const next = hawkReadThroughPatch(before);
  assert.equal(next.keep, true);
  assert.equal(next.panels[0].name, 'existing');
  assert.equal(before.panels.length, 1);
  assert.ok(next.var.filter(item => item.type === 'query').every(item => !('defaultValue' in item)));
});

test('范围查询整批只调用一次 API，结果保持次序和空数据', async () => {
  let calls = 0;
  const client = { request: async (method, route, body) => {
    calls++;
    assert.equal(route, '/api/n9e/query-range-batch');
    assert.deepEqual(body.queries.map(item => item.query), queries.map(item => item.expr));
    assert.equal(body.queries[0].start, 100);
    assert.equal(body.queries[0].step, 60);
    return { json: { dat: [[{ metric: {}, values: [[110, '1']] }], []], err: '' } };
  } };
  const output = await runQueries(client, { start: '100', end: '200', step: '60s' }, queries);
  assert.equal(calls, 1);
  assert.deepEqual(output.results.map(item => [item.name, item.series_count]), [['current', 1], ['missing', 0]]);
});

test('批量响应缺项或服务端错误不能当作无数据', () => {
  for (const response of [{ dat: [[]] }, { dat: [[], {}] }, { dat: [[], []], err: 'timeout' }]) {
    assert.throws(() => parseBatchResults(queries, response), /不能按无数据/);
  }
});

test('instant 批量保持顺序并正确编码表达式', async () => {
  const client = { baseUrl: base, request: async (method, url) => {
    assert.ok(queries.some(item => item.expr === new URL(url).searchParams.get('query')));
    return { json: { status: 'success', data: { result: [] } } };
  } };
  const result = await runQueries(client, { 'query-type': 'instant' }, queries);
  assert.deepEqual(result.results.map(item => item.name), ['current', 'missing']);
});

test('错误参数在请求前拒绝', async () => {
  assert.throws(() => parseDuration('0s'));
  assert.throws(() => loadQueries({ 'queries-json': '[{"name":"empty"}]' }));
  await assert.rejects(runQueries({}, { 'query-type': 'wrong' }, queries));
  await assert.rejects(runQueries({}, { start: '200', end: '100' }, queries));
});

test('原指标展开与 QUERY_ERROR 语义保留', async () => {
  assert.deepEqual(loadMetrics({ apps: 'app', suffixes: 'count,size' }), ['fql_fk_app_count', 'fql_fk_app_size']);
  const client = { baseUrl: base, request: async () => { throw new Error('HTTP 401'); } };
  const row = await inspectMetric(client, {}, 'up', { range: '30m' });
  assert.equal(row.status, 'QUERY_ERROR');
  assert.match(row.error, /401/);
});
