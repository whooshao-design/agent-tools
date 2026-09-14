const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = path.join(__dirname, 'inspect_call_topology.js');

function loadTopology(withHealthyClient, argv = [], env = {}, overrides = {}) {
  const source = fs.readFileSync(script, 'utf8');
  const exported = { exports: {} };
  const requireMock = name => {
    if (overrides[name]) return overrides[name];
    if (name.endsWith('/healthy_client')) return { withHealthyClient };
    if (name === 'module') return { createRequire: () => { throw new Error('独立鉴权不得启动浏览器'); } };
    return require(name);
  };
  vm.runInNewContext(source, {
    require: requireMock, module: exported,
    process: { argv: ['node', script, ...argv], env },
    console: { log() {}, error() {} }, URL, AbortController,
    setTimeout: fn => setTimeout(fn, 0), clearTimeout,
    fetch: () => { throw new Error('拓扑查询不得绕过公共客户端'); },
  }, { filename: script });
  return exported.exports;
}

test('整批查询只复用一次 Healthy 会话，站点与业务 env 分开传递', async () => {
  let sessions = 0;
  const queries = [];
  const argv = ['--app=demo', '--site=stable', '--env=gray', '--range=7d', '--no-html', '--http-timeout=1234'];
  const { main } = loadTopology(async (args, action) => {
    sessions++;
    assert.equal(args.env, 'stable');
    assert.equal(args.profile, undefined); // 交给公共客户端选择默认 Healthy profile。
    assert.equal(args['http-timeout'], 1234);
    return action({ baseUrl: 'https://stable-eye.oa.fenqile.com', request: async (method, url) => {
      assert.equal(method, 'POST');
      const query = new URL(url).searchParams.get('query');
      queries.push(query);
      const value = query.includes('_err_count') ? '0' : query.includes('_successrate') ? '100' : '1';
      return { json: { status: 'success', data: { result: [{
        metric: { app: 'demo', env: 'gray', service: 'com.example.DemoService', method: 'run', group: 'default', version: '1' },
        value: [1, value],
      }] } } };
    } });
  }, argv);
  assert.equal(await main(argv), 0);
  assert.equal(sessions, 1);
  assert.ok(queries.length >= 16);
  assert.ok(queries.some(q => q.includes('env="gray"') && q.includes('[7d]')));
});

// 模拟两个应用及一个共享下游，验证真实 main 编排和最终报告，而非重写查询逻辑。
async function runBatch(argv, { missingOwner = false, providerErrorApp = '' } = {}) {
  const calls = [];
  const files = new Map();
  let sessions = 0;
  const registryCalls = [];
  const providers = [
    { app: 'app-a', service: 'com.example.Foo', method: 'run', env: 'prod', count: 11 },
    { app: 'app_b', service: 'com.example.Bar', method: 'run', env: 'prod', count: 22 },
  ];
  const consumers = [
    { app: 'app-a', service: 'com.example.Bar', method: 'run', env: 'prod', count: 3 },
    { app: 'app-a', service: 'com.example.Remote', method: 'get', env: 'prod', count: 4 },
    { app: 'app_b', service: 'com.example.Remote', method: 'get', env: 'prod', count: 5 },
  ];
  const upstream = providers.map(row => ({ ...row, app: `caller-${row.app}` }));
  const owners = [
    { app: 'app_b', service: 'com.example.Bar', count: 22 },
    { app: 'other-provider', service: 'com.example.Bar', count: 1 },
    ...missingOwner ? [] : [{ app: 'remote', service: 'com.example.Remote', count: 9 }],
  ];
  const { main } = loadTopology(async (args, action) => {
    sessions++;
    return action({ baseUrl: 'https://healthy.lexincloud.com', request: async (method, route) => {
      const url = new URL(route);
      const query = url.searchParams.get('query');
      calls.push({ method, query, time: url.searchParams.get('time') });
      if (url.pathname.endsWith('/query_range')) {
        return { json: { status: 'success', data: { result: [{ metric: {}, values: [[Number(url.searchParams.get('end')), '1']] }] } } };
      }
      let rows;
      if (query.includes('by (ident,origins)')) {
        rows = [{ app: providerErrorApp, ident: 'test-instance', origins: 'test-origin', count: 22 }];
      } else if (query.includes('by (app,service)')) {
        // 低频提供方只存在于历史窗口，瞬时查询不能命中。
        rows = query.includes('sum_over_time(') ? owners : [];
      } else if (query.includes('by (app,env,service,method,src_set,dst_set)')) {
        rows = upstream;
      } else {
        rows = query.includes('_provider_monitor_') ? providers : consumers;
        const app = /app="([^"]+)"/.exec(query);
        if (app) rows = rows.filter(row => row.app === app[1]);
      }
      return { json: { status: 'success', data: { result: rows.map(({ count, ...metric }) => ({
        metric,
        value: [1, String(query.includes('_err_count') ? Number(metric.app === providerErrorApp && query.includes('_provider_')) : query.includes('_successrate') ? 100
          : query.includes('_cost_time') ? 1000 : count)],
      })) } } };
    } });
  }, [], {}, {
    fs: { ...fs, mkdirSync() {}, writeFileSync: (file, body) => files.set(file, body) },
    child_process: { execFile: (exe, args, options, done) => {
      registryCalls.push(args);
      done(null, JSON.stringify({ ownerMap: { 'com.example.Remote': ['registry-remote'] } }), '');
    } },
  });
  const code = await main(argv);
  return { code, calls, sessions, files, registryCalls };
}

test('多应用合并查询只开一次会话，报告各自分组且保留全局多提供方', async () => {
  const result = await runBatch(['--apps=app-a,app_b', '--range=7d', '--env=prod',
    '--max-drilldown=0', '--out=/tmp/{app}.html', '--json=/tmp/{app}.json']);
  assert.equal(result.code, 0);
  assert.equal(result.sessions, 1);
  assert.equal(result.calls.length, 16); // 两应用仍是 10 个基础指标、5 个上游指标、1 个归属查询。
  assert.equal(result.registryCalls.length, 0);
  assert.equal(new Set(result.calls.map(call => call.time)).size, 1);
  assert.ok(result.calls.every(call => Number(call.time) > 0 && call.query.includes('[7d]')));
  const ownerQuery = result.calls.find(call => call.query.includes('by (app,service)')).query;
  assert.ok(ownerQuery.includes('com\\\\.example\\\\.Bar|com\\\\.example\\\\.Remote'));
  assert.ok(ownerQuery.includes('sum_over_time('));
  assert.ok(!ownerQuery.includes('env='));
  const a = JSON.parse(result.files.get('/tmp/app-a.json'));
  const b = JSON.parse(result.files.get('/tmp/app_b.json'));
  assert.equal(a.stats.providerCount, 11);
  assert.equal(b.stats.providerCount, 22);
  assert.equal(a.stats.consumerCount, 7);
  assert.equal(b.stats.consumerCount, 5);
  assert.deepEqual(a.upstream_clients.map(row => row.app), ['caller-app-a']);
  assert.deepEqual(b.upstream_clients.map(row => row.app), ['caller-app_b']);
  assert.deepEqual(a.downstream_owner_map['com.example.Bar'], ['app_b', 'other-provider']);
  assert.equal(a.stats.multiOwnerServices, 1);
  assert.equal(b.downstream_owner_map['com.example.Bar'], undefined);
  assert.equal(a.meta.window_end, b.meta.window_end);
  assert.equal(a.meta.window_end - a.meta.window_start, 7 * 86400);
  assert.ok(result.files.get('/tmp/app-a.html').includes('app-a 调用关系'));
  assert.ok(result.files.get('/tmp/app_b.html').includes('app_b 调用关系'));
});

test('同批多个应用缺失同一归属时仅兜底注册中心一次，并共享结果', async () => {
  const result = await runBatch(['--apps=app-a,app_b', '--no-html', '--json=/tmp/{app}.json'], { missingOwner: true });
  assert.equal(result.registryCalls.length, 1);
  assert.ok(result.registryCalls[0].includes('--services=com.example.Remote'));
  for (const app of ['app-a', 'app_b']) {
    const report = JSON.parse(result.files.get(`/tmp/${app}.json`));
    assert.deepEqual(report.downstream_owner_map['com.example.Remote'], ['registry-remote']);
    assert.equal(report.downstream_owner_source['com.example.Remote'], 'dubbo-registry');
  }
});

test('单应用沿用原参数，重复应用只输出一次，调用之间不复用上次结果', async () => {
  for (const target of ['--app=app-a', '--apps=app-a,app-a']) {
    const result = await runBatch([target, '--no-html', '--json=/tmp/one.json']);
    assert.equal(result.sessions, 1);
    assert.equal(result.files.size, 1);
    assert.equal(JSON.parse(result.files.get('/tmp/one.json')).stats.providerCount, 11);
    assert.equal(result.calls.length, 16);
  }
});

test('多应用参数冲突、空列表及可能覆盖的输出路径在启动浏览器前拒绝', async () => {
  const { main } = loadTopology(() => { throw new Error('不应启动浏览器'); });
  for (const [argv, message] of [
    [['--apps=app-a,app_b', '--app=app-a'], /不能同时使用/],
    [['--apps=app-a,app_b', '--service=com.example.Foo'], /不能同时使用/],
    [['--apps=, ,'], /非空 --apps/],
    [['--apps'], /非空 --apps/],
    [['--apps=app-a,app_b', '--out=/tmp/report.html'], /必须包含 \{app\}/],
    [['--apps=app-a,app_b', '--json=/tmp/report.json'], /必须包含 \{app\}/],
  ]) await assert.rejects(main(argv), message);
});

test('服务反查仍能定位应用，批量基线保持各应用的独立过滤条件', async () => {
  const single = await runBatch(['--service=com.example.Bar', '--no-html', '--json=/tmp/service.json']);
  assert.equal(JSON.parse(single.files.get('/tmp/service.json')).meta.app, 'app_b');
  const result = await runBatch(['--apps=app-a,app_b', '--baseline=7d', '--no-html', '--json=/tmp/{app}.json']);
  assert.equal(result.sessions, 1);
  assert.equal(result.calls.filter(call => call.query.includes('offset 7d')).length, 20);
  for (const app of ['app-a', 'app_b']) {
    const report = JSON.parse(result.files.get(`/tmp/${app}.json`));
    const queries = report.promql.filter(item => item.label.startsWith('baseline.'));
    assert.equal(queries.length, 10);
    assert.ok(queries.every(item => item.query.includes(`app="${app}"`)));
    assert.deepEqual(report.baseline_diff.added, []);
    assert.deepEqual(report.baseline_diff.removed, []);
  }
});

test('批量 fail-on-anomaly 汇总退出码，仍生成每个应用的独立报告', async () => {
  const result = await runBatch(['--apps=app-a,app_b', '--fail-on-anomaly', '--max-drilldown=0',
    '--no-html', '--json=/tmp/{app}.json'], { providerErrorApp: 'app_b' });
  assert.equal(result.code, 2);
  assert.equal(result.files.size, 2);
  assert.equal(JSON.parse(result.files.get('/tmp/app-a.json')).stats.providerErr, 0);
  assert.equal(JSON.parse(result.files.get('/tmp/app_b.json')).stats.providerErr, 1);
});

test('有异常也默认不下钻，显式正数才查询实例和时间线，错误统计始终保留', async () => {
  for (const limit of [undefined, 0, 1]) {
    const result = await runBatch(['--apps=app-a,app_b', '--fail-on-anomaly',
      '--out=/tmp/{app}.html', '--json=/tmp/{app}.json',
      ...(limit === undefined ? [] : [`--max-drilldown=${limit}`])], { providerErrorApp: 'app_b' });
    const report = JSON.parse(result.files.get('/tmp/app_b.json'));
    assert.equal(result.code, 2);
    assert.equal(report.stats.providerErr, 1);
    assert.equal(report.stats.anomalies, 1);
    assert.equal(report.promql.filter(q => q.label.startsWith('drilldown.')).length, limit ? 4 : 0);
    assert.equal(result.calls.length, limit ? 20 : 16);
    assert.equal(report.anomaly_drilldown.length, limit ? 1 : 0);
    assert.equal(result.files.get('/tmp/app_b.html').includes('<h2>异常下钻</h2>'), Boolean(limit));
    if (limit) {
      assert.equal(report.anomaly_drilldown[0].instances[0].ident, 'test-instance');
      assert.equal(report.anomaly_drilldown[0].timeline[0].err, 1);
    }
  }
});

test('显式 profile 和 token 保留优先级，环境 token 可复用', async () => {
  for (const explicit of [true, false]) {
    const argv = ['--app=demo', '--profile=/tmp/explicit-profile', ...(explicit ? ['--token=explicit-token'] : [])];
    const { main } = loadTopology(async (args) => {
      assert.equal(args.profile, '/tmp/explicit-profile');
      assert.equal(args.token, explicit ? 'explicit-token' : 'env-token');
      return 0;
    }, argv, { HEALTHY_METRIC_TOKEN: 'env-token' });
    assert.equal(await main(argv), 0);
  }
});

test('401 立即失败，不重复登录、不当成空流量', async () => {
  let calls = 0;
  const { requestJson } = loadTopology();
  const ctx = { retries: 2, client: { request: async () => {
    calls++;
    const error = new Error('HTTP 401'); error.status = 401; throw error;
  } } };
  await assert.rejects(requestJson(ctx, 'https://healthy.lexincloud.com/api/n9e/test'), /401/);
  assert.equal(calls, 1);
});

test('限流、5xx、网络和超时失败按原有重试上限重试', async () => {
  const { requestJson } = loadTopology();
  for (const failure of [{ status: 429 }, { status: 503 }, { name: 'TypeError' }, { name: 'TimeoutError' }]) {
    let calls = 0;
    const error = Object.assign(new Error('temporary failure'), failure);
    const ctx = { retries: 2, client: { request: async () => {
      calls++;
      if (calls < 3) throw error;
      return { json: { status: 'success' } };
    } } };
    assert.equal((await requestJson(ctx, 'https://healthy.lexincloud.com/api/n9e/test')).status, 'success');
    assert.equal(calls, 3);
    ctx.retries = 0; calls = 0;
    await assert.rejects(requestJson(ctx, 'https://healthy.lexincloud.com/api/n9e/test'), /temporary failure/);
    assert.equal(calls, 1);
  }
});
