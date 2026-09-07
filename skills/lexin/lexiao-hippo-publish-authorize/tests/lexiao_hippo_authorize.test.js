const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRequest, rowsOf, main } = require('../scripts/lexiao_hippo_authorize');

const input = ['add', '--demand-id=123', '--namespace=orders', '--apps=app_a'];
const row = { resource_id: 'app_a', resource_instance: 'orders', resource_type: 'hippo' };
const response = (rows) => ({ status: 200, text: JSON.stringify({ retcode: 0, result_rows: rows }) });

function browser(responses) {
  const calls = [];
  let closed = false;
  const page = {
    goto: async () => {}, waitForTimeout: async () => {},
    evaluate: async (_fn, request) => { calls.push(request); return responses.shift(); },
  };
  return {
    calls, get closed() { return closed; },
    open: async () => ({ pages: () => [page], close: async () => { closed = true; } }),
  };
}

test('add requires an explicit namespace; list defaults remain read-only', () => {
  assert.equal(parseRequest(['--demand-id=123']).command, 'list');
  assert.throws(() => parseRequest(input.filter((v) => !v.startsWith('--namespace'))), /namespace/);
  assert.equal(parseRequest(input).namespace, 'orders');
});

test('invalid command, id, and duplicate apps fail before opening a browser', async () => {
  for (const argv of [
    ['delete', '--demand-id=123'], ['list', '--demand-id=1&other=2'],
    ['list', '--demand-id=9007199254740992'], [...input, '--apps=app_a,app_a'],
  ]) {
    let opened = false;
    await assert.rejects(main(argv, async () => { opened = true; }));
    assert.equal(opened, false);
  }
});

test('only a successful structured empty result is an empty set', () => {
  assert.deepEqual(rowsOf({ status: 200, json: { result_rows: [] } }), []);
  for (const res of [
    { status: 403, json: { result_rows: [] } }, { status: 200, json: null },
    { status: 200, json: {} }, { status: 200, json: { retcode: 123, result_rows: [] } },
    { status: 200, json: { result_rows: [{}] } },
    { status: 200, json: { result_rows: Array(200).fill(row) } },
  ]) assert.throws(() => rowsOf(res));
});

test('failed before-query sends no POST and closes browser', async () => {
  for (const res of [{ status: 403, text: '{}' }, { status: 200, text: '<html>Login</html>' }, response(Array(200).fill(row))]) {
    const b = browser([res]);
    await assert.rejects(main(input, b.open));
    assert.deepEqual(b.calls.map((c) => c.method), ['GET']);
    assert.equal(b.closed, true);
  }
});

test('already registered request does not write', async () => {
  const b = browser([response([row])]);
  await main(input, b.open);
  assert.deepEqual(b.calls.map((c) => c.method), ['GET']);
  assert.equal(b.closed, true);
});

test('only the explicit namespace and apps are written, then reread', async () => {
  const b = browser([response([{ ...row, resource_type: 'other' }]), { status: 200, text: '{}' }, response([row])]);
  await main(input, b.open);
  assert.deepEqual(b.calls.map((c) => c.method), ['GET', 'POST', 'GET']);
  assert.deepEqual(b.calls[1].body.app_namespace_list, [{
    demand_id: 123, resource_id: 'app_a', resource_name: 'app_a',
    resource_instance: 'orders', instance_type: '1', resource_type: 'hippo',
  }]);
});

test('unverified POST is not retried and always releases the browser', async () => {
  const b = browser([response([]), { status: 200, text: '{}' }, response([])]);
  await assert.rejects(main(input, b.open), /未验证成功/);
  assert.deepEqual(b.calls.map((c) => c.method), ['GET', 'POST', 'GET']);
  assert.equal(b.closed, true);
});

test('failed POST plus concurrent successful registration is not our success', async () => {
  for (const post of [
    { status: 200, text: JSON.stringify({ retcode: 30281040 }) },
    { status: 200, text: '<html>Login</html>' },
    { status: 403, text: '{}' },
  ]) {
    const b = browser([response([]), post, response([row])]);
    await assert.rejects(main(input, b.open), /未验证成功/);
    assert.deepEqual(b.calls.map((c) => c.method), ['GET', 'POST', 'GET']);
    assert.equal(b.closed, true);
  }
});
