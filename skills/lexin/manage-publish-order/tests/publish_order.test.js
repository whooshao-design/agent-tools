'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_ENVS, assertFrontend, checkFormState, isForbiddenRequest, mergeMessage, openOrders, parseArgs, parseEnvs, parsePubType,
} = require('../scripts/publish_order');

const EXPECTED = { app: 'web_mihawk_oa', desc: 'feat: x tapdId: 1', pubType: 'version', envs: DEFAULT_ENVS, branch: 'product' };
const STATE = { app: 'web_mihawk_oa', envType: '线上', pubType: '版本', branch: 'product', tag: '1.65.0', envs: ['pre', 'gray', 'prod'], desc: 'feat: x tapdId: 1' };

test('only frontend orders are supported', () => {
  assert.doesNotThrow(() => assertFrontend(undefined));
  assert.doesNotThrow(() => assertFrontend('frontend'));
  assert.throws(() => assertFrontend('backend'), /后端发布单暂不支持/);
});

test('envs default to pre,gray,prod and reject unknown values', () => {
  assert.deepEqual(parseEnvs(undefined), ['pre', 'gray', 'prod']);
  assert.deepEqual(parseEnvs('prod,pre,prod'), ['prod', 'pre']);
  assert.throws(() => parseEnvs('pre,online'), /unknown env/);
});

test('pub type maps to 版本/补丁', () => {
  assert.equal(parsePubType(undefined), 'version');
  assert.equal(parsePubType('patch'), 'patch');
  assert.throws(() => parsePubType('release'), /version or patch/);
});

test('merge message follows the repository convention', () => {
  assert.equal(mergeMessage('rel_a_1', 'product'), "Merge branch 'rel_a_1' into product");
});

test('form state check catches every mismatch', () => {
  assert.deepEqual(checkFormState(STATE, EXPECTED), []);
  const bad = checkFormState({ ...STATE, envType: '项目', tag: '', envs: ['prod'], branch: 'master' }, EXPECTED);
  assert.equal(bad.length, 4);
  assert.ok(bad.some((item) => item.startsWith('tag=')));
});

test('push / rollback / close requests are treated as forbidden, create and list are not', () => {
  assert.ok(isForbiddenRequest('https://publish_server.oa.fenqile.com/publishOrder/pushEnv'));
  assert.ok(isForbiddenRequest('https://publish_server.oa.fenqile.com/publishOrder/rollback'));
  assert.ok(isForbiddenRequest('https://publish_server.oa.fenqile.com/publishOrder/closeOrder'));
  assert.ok(!isForbiddenRequest('https://publish_server.oa.fenqile.com/publishOrder/addIncrementOrder'));
  assert.ok(!isForbiddenRequest('https://publish_server.oa.fenqile.com/publishOrder/list'));
});

test('open orders are 未结单 rows of the same app', () => {
  const rows = [
    { appName: 'web_mihawk_oa', orderStatusValue: '未结单' },
    { appName: 'web_mihawk_oa', orderStatusValue: '已结单' },
    { appName: 'server_x', orderStatusValue: '未结单' },
  ];
  assert.equal(openOrders(rows, 'web_mihawk_oa').length, 1);
});

test('parseArgs handles flags and values', () => {
  assert.deepEqual(parseArgs(['create', '--app=web', '--dry-run', '--envs', 'pre']), { _: ['create'], app: 'web', 'dry-run': true, envs: 'pre' });
});
