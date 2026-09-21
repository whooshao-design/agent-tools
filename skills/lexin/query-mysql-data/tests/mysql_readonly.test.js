'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertReadOnlySql,
  buildLxcloudPayload,
  inferLxcloudUserName,
  lxcloudBaseUrl,
  lxcloudEndpoint,
  normalizeLxcloudDbType,
  resolveLxcloudEnv,
  userNameFromJwt,
  validateLxcloudDbType,
} = require('../scripts/mysql_readonly');

test('read-only SQL guard rejects writes hidden behind WITH, INTO OUTFILE and FOR UPDATE', () => {
  for (const sql of ['SELECT 1', 'WITH c AS (SELECT 1) SELECT * FROM c', "SELECT * FROM t WHERE note = 'delete me' AND `update_time` > 0", 'EXPLAIN SELECT 1', 'SHOW CREATE TABLE demo.t_order', "SELECT REPLACE('abc','a','x') AS cleaned, INSERT('abc',1,1,'z'), TRUNCATE(1.23, 1)", "SELECT 'it''s -- not a comment', \"/* not a comment */\" FROM t", 'SELECT 1 -- trailing comment', 'SELECT 1 --\ttab comment']) {
    assert.doesNotThrow(() => assertReadOnlySql(sql), sql);
  }
  for (const sql of ['WITH c AS (SELECT 1) DELETE FROM demo WHERE id = 1', "SELECT 1 INTO OUTFILE '/tmp/x'", 'SELECT * FROM t FOR UPDATE', 'SELECT 1; DROP TABLE t', 'UPDATE t SET a = 1', "SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */", 'REPLACE INTO t VALUES (1)', "SELECT '-- ' INTO OUTFILE '/tmp/x'", "SELECT '/*' , 1 INTO DUMPFILE '/tmp/y'", "SELECT 1--1 INTO OUTFILE '/tmp/r4'"]) {
    assert.throws(() => assertReadOnlySql(sql), /非只读/, sql);
  }
});

test('routes stable and prod to their own lxcloud domains over the same HTTP SQL path', () => {
  assert.equal(resolveLxcloudEnv(undefined), 'prod');
  assert.equal(resolveLxcloudEnv(''), 'prod');
  assert.equal(resolveLxcloudEnv('online'), 'prod');
  assert.equal(resolveLxcloudEnv('stable'), 'stable');
  assert.equal(resolveLxcloudEnv('test'), 'stable');
  assert.equal(resolveLxcloudEnv('STABLE'), 'stable');
  assert.throws(() => resolveLxcloudEnv('pre'), /未知 lxcloud 环境/);

  assert.equal(lxcloudBaseUrl('prod'), 'https://lxcloud.lexincloud.com');
  assert.equal(lxcloudBaseUrl('stable'), 'https://stable-lxcloud.lexincloud.com');
  assert.equal(lxcloudEndpoint('prod'), 'https://lxcloud.lexincloud.com/v1/mysql/sql-query/exec-query/');
  assert.equal(lxcloudEndpoint('stable'), 'https://stable-lxcloud.lexincloud.com/v1/mysql/sql-query/exec-query/');
});

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

test('normalizes the newly registered PostrealDB and StrategypfmDB aliases', () => {
  assert.equal(normalizeLxcloudDbType('postreal'), 'PostrealDB');
  assert.equal(normalizeLxcloudDbType('post-real'), 'PostrealDB');
  assert.equal(normalizeLxcloudDbType('PostrealDB'), 'PostrealDB');
  assert.equal(normalizeLxcloudDbType('strategypfm'), 'StrategypfmDB');
  assert.equal(normalizeLxcloudDbType('strategy-pfm'), 'StrategypfmDB');
  assert.equal(normalizeLxcloudDbType('StrategypfmDB'), 'StrategypfmDB');
  assert.equal(normalizeLxcloudDbType('creditpfm'), 'CreditpfmDB');
  assert.equal(normalizeLxcloudDbType('credit-pfm'), 'CreditpfmDB');
  assert.equal(normalizeLxcloudDbType('CreditpfmDB'), 'CreditpfmDB');
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
