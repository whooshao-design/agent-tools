'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertReadOnlySql,
  buildLxcloudPayload,
  inferLxcloudUserName,
  normalizeLxcloudDbType,
  userNameFromJwt,
  validateLxcloudDbType,
} = require('../scripts/mysql_readonly');

test('accepts an arbitrary authorized lxcloud instance without a static allowlist', () => {
  const payload = buildLxcloudPayload({
    'db-type': 'NewServiceMetaDB',
    query: 'SHOW DATABASES',
  });

  assert.equal(payload.db_type, 'NewServiceMetaDB');
  assert.equal(payload.sql, 'SHOW DATABASES');
});

test('normalizes only explicit instance aliases and does not guess from a broad domain name', () => {
  assert.equal(normalizeLxcloudDbType('process-manage'), 'ProcessmanageDB');
  assert.equal(normalizeLxcloudDbType('process-test'), 'ProcesstestDB');
  assert.equal(normalizeLxcloudDbType('process'), 'process');
  assert.equal(normalizeLxcloudDbType('process_engine_db'), 'process_engine_db');
});

test('requires a concrete and safe lxcloud db_type', () => {
  assert.throws(() => validateLxcloudDbType(''), /先从目标项目的运行时数据源配置中确认/);
  assert.throws(() => validateLxcloudDbType(true), /先从目标项目的运行时数据源配置中确认/);
  assert.throws(() => validateLxcloudDbType('bad\ninstance'), /控制字符/);
  assert.throws(() => validateLxcloudDbType('x'.repeat(129)), /128/);
});

test('read-only SQL validation remains enforced after opening instance selection', () => {
  assert.doesNotThrow(() => assertReadOnlySql('SELECT 1'));
  assert.doesNotThrow(() => assertReadOnlySql('SHOW CREATE TABLE demo.t_order'));
  assert.throws(() => assertReadOnlySql('UPDATE demo.t_order SET Fstate = 1'), /非只读 SQL/);
  assert.throws(() => assertReadOnlySql('SELECT 1; DELETE FROM demo.t_order'), /非只读 SQL/);
});

test('uses the browser session identity before falling back to the local system user', () => {
  const inferredUserName = inferLxcloudUserName({
    snippet: 'Lx Cloud 当前环境： 刷新 版本说明 joneyshao(邵鹏) 【公告】',
  }, 'opaque-token');
  const payload = buildLxcloudPayload({
    'db-type': 'ProcessmanageDB',
    query: "SHOW TABLE STATUS FROM process_engine_db LIKE 't_process'",
  }, inferredUserName);

  assert.equal(inferredUserName, 'joneyshao');
  assert.equal(payload.user_name, 'joneyshao');
});

test('prefers an explicit user name over the browser session identity', () => {
  const payload = buildLxcloudPayload({
    'db-type': 'ProcessmanageDB',
    'user-name': 'explicit-user',
    query: 'SHOW DATABASES',
  }, 'browser-user');

  assert.equal(payload.user_name, 'explicit-user');
});

test('extracts the lxcloud user name from a JWT claim when available', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ preferred_username: 'jwt-user' })).toString('base64url');

  assert.equal(userNameFromJwt(`Bearer ${header}.${body}.signature`), 'jwt-user');
});
