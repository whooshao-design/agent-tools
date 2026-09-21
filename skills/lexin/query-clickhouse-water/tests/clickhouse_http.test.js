'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertReadOnlySql, buildRequest, parseResponse, queryOptions, selectTransport, run } = require('../scripts/clickhouse_http');

test('instance defaults and explicit transport take precedence', () => {
  assert.equal(selectTransport('DecisionWaterHawkCK'), 'bastion_dba');
  for (const instance of ['RCbaseCK', 'ABTestCK', 'AnotherCK']) assert.equal(selectTransport(instance), 'http');
  assert.equal(selectTransport('DecisionWaterHawkCK', 'http'), 'http');
  assert.equal(selectTransport('RCbaseCK', 'bastion_dba'), 'bastion_dba');
  assert.throws(() => selectTransport('RCbaseCK', 'unknown'));
});

test('pre gray prod share online origin while stable remains separate', () => {
  for (const env of ['pre', '预发布', 'gray', '灰度', 'prod', 'online', '线上']) {
    assert.equal(queryOptions({ env, action: 'instances' }).baseUrl, 'https://lxcloud.lexincloud.com');
  }
  const stable = queryOptions({ env: 'stable', action: 'databases' });
  assert.equal(stable.baseUrl, 'https://stable-lxcloud.oa.fenqile.com');
  assert.equal(stable.instance, 'ABTestCK');
  assert.throws(() => queryOptions({ env: 'stable', instance: 'RCbaseCK', action: 'databases' }));
});

test('missing environment or instance is rejected rather than guessed', () => {
  assert.throws(() => queryOptions({ action: 'instances' }));
  assert.throws(() => queryOptions({ env: 'prod', query: 'SELECT 1' }));
  assert.throws(() => queryOptions({ env: 'prod', action: 'tables', instance: 'RCbaseCK' }));
});

test('HTTP runner refuses default DBA route before accessing a browser', async () => {
  await assert.rejects(run({ env: 'prod', instance: 'DecisionWaterHawkCK', query: 'SELECT 1' }), /bastion_dba/);
  await assert.rejects(run({ env: 'prod', instance: 'RCbaseCK', transport: 'bastion_dba', query: 'SELECT 1' }), /bastion_dba/);
  assert.equal(queryOptions({ env: 'prod', instance: 'DecisionWaterHawkCK', transport: 'http', query: 'SELECT 1' }).instance, 'DecisionWaterHawkCK');
});

test('query payload preserves user SQL without implicit environment filters', () => {
  const sql = "SELECT Fenv FROM risk_control_base_db.t_strategy_node_decision_water WHERE Fcreate_time >= '2026-09-21 00:00:00' LIMIT 1";
  const options = queryOptions({ env: 'pre', instance: 'RCbaseCK', query: sql });
  assert.deepEqual(buildRequest(options, 'example.user'), {
    path: '/v1/clickhouse/sql_exec/exec_query', method: 'POST',
    body: { clickhouse_type: 'RCbaseCK', user_name: 'example.user', sql },
  });
  assert.throws(() => buildRequest(options, ''));
});

test('metadata actions use correct endpoints and parameters', () => {
  assert.match(buildRequest({ action: 'instances' }, 'a+b').path, /user_name=a%2Bb$/);
  assert.deepEqual(buildRequest({ action: 'databases', instance: 'RCbaseCK' }, 'user').body, { clickhouse_type: 'RCbaseCK' });
  assert.deepEqual(buildRequest({ action: 'tables', instance: 'RCbaseCK', database: 'db' }, 'user').body, { clickhouse_type: 'RCbaseCK', db_name: 'db' });
});

test('read-only SQL accepts quoted text, comments, and SHOW CREATE TABLE', () => {
  for (const sql of [
    'SELECT 1;', '/* comment */ SELECT 1 -- comment', 'SHOW CREATE TABLE db.tab',
    "SELECT 'delete; -- text' AS value", "SELECT 'it''s; ok' AS value",
    "SELECT 'escaped\\';value' AS value", 'SELECT `drop` FROM `db`.`tab` LIMIT 1',
  ]) assert.doesNotThrow(() => assertReadOnlySql(sql), sql);
});

test('HTTP SQL rejects writes, multiple statements and unsupported DESCRIBE', () => {
  for (const sql of [
    '', 'DROP TABLE db.tab', 'SELECT 1; DELETE FROM db.tab', 'SELECT 1; SELECT 2',
    "SELECT 1 INTO OUTFILE '/tmp/out'", 'WITH 1 AS n SELECT n', 'DESCRIBE db.tab',
    'SELECT 1 /* unclosed', "SELECT 'unclosed", 'SHOW CREATE TABLE db.tab; DROP TABLE db.tab',
  ]) assert.throws(() => assertReadOnlySql(sql), undefined, sql);
});

const queryResponse = (rows = []) => ({ status: 200, body: {
  code: 200, data: { code: 200, query_code: 0, query_time: 0.01, data: { columns: [{ field: 'ok' }], data: rows } },
} });

test('successful queries and successful empty results remain distinct', () => {
  assert.equal(parseResponse(queryResponse([{ ok: 1 }]), 'query').rowCount, 1);
  assert.equal(parseResponse(queryResponse(), 'query').rowCount, 0);
});

test('HTTP 200 with inner 403 and query_code 0 is an error', () => {
  const response = queryResponse();
  response.body.data = { code: 403, query_code: 0, error: '没有实例查询权限', data: [] };
  assert.throws(() => parseResponse(response, 'query'), /没有实例查询权限/);
});

test('transport, outer, query and malformed-response failures cannot become zero rows', () => {
  const responses = [
    { status: 403, body: { code: 200 } }, { status: 200, body: null },
    { status: 200, body: { code: 401 } },
    { status: 200, body: { code: 200, data: { code: 200, query_code: 1, error: 'bad SQL' } } },
    { status: 200, body: { code: 200, data: { code: 200, query_code: 0, data: [] } } },
  ];
  for (const response of responses) assert.throws(() => parseResponse(response, 'query'));
});

test('instance output exposes names and descriptions but omits connection secrets', () => {
  const result = parseResponse({ status: 200, body: { code: 200, data: { count: 2, results: [
    { ftype: 'ExampleCK', ftype_memo: 'Example', host: 'private-host', password: 'secret' },
  ] } } }, 'instances');
  assert.deepEqual(result, { count: 2, truncated: true, instances: [{ instance: 'ExampleCK', description: 'Example' }] });
});

test('API errors redact credentials before returning them to the caller', () => {
  const response = { status: 403, body: { code: 403, error: 'Bearer fake-secret token=another-secret' } };
  assert.throws(() => parseResponse(response, 'query'), error => !error.message.includes('fake-secret') && !error.message.includes('another-secret'));
});
