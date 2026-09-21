'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SKILL_FILE_NAME,
  TEMP_FOLDER_NAME,
  assertReadOnlySql,
  buildSavePayload,
  buildSubmitPayload,
  findSkillFile,
  findTempFolder,
  resolveEngine,
  summarizeInstance,
} = require('../scripts/hive_query');

test('accepts read-only statements and strips the trailing semicolon', () => {
  assert.equal(assertReadOnlySql('SELECT 1;'), 'SELECT 1');
  assert.equal(assertReadOnlySql('  with t as (select 1) select * from t  '), 'with t as (select 1) select * from t');
  assert.equal(assertReadOnlySql('SHOW SCHEMAS'), 'SHOW SCHEMAS');
  assert.equal(assertReadOnlySql("SELECT '--' AS x, 'insert' AS y"), "SELECT '--' AS x, 'insert' AS y");
  assert.throws(() => assertReadOnlySql("WITH c AS (SELECT '--' AS x) INSERT INTO demo.t SELECT x FROM c"), /write keyword/);
  assert.equal(assertReadOnlySql('SELECT 1 --delete is only a comment'), 'SELECT 1 --delete is only a comment'); // Presto: -- 到行尾都是注释
  assert.equal(assertReadOnlySql('SELECT 1--1 INSERT INTO demo.t VALUES (1)'), 'SELECT 1--1 INSERT INTO demo.t VALUES (1)'); // 同上，--1... 是注释
  assert.equal(assertReadOnlySql('EXPLAIN SELECT 1'), 'EXPLAIN SELECT 1');
  // Presto: 反斜杠不是转义符，'\\' 是一个完整字符串，后面的注释里的 delete 不算写语句
  assert.equal(assertReadOnlySql("SELECT '\\' AS separator -- 'delete' is only a comment"), "SELECT '\\' AS separator -- 'delete' is only a comment");
  // Spark: 反斜杠转义引号，'a\\'; DELETE ...' 是一个字符串，但保守起见按写语句拒绝也可接受；这里只验证 Presto 不再误拦
  assert.throws(() => assertReadOnlySql("SELECT '\\'; DELETE FROM t", 'presto'), /single SQL statement|write keyword/);
  assert.throws(() => assertReadOnlySql('EXPLAIN ANALYZE INSERT INTO demo.t SELECT 1'), /EXPLAIN ANALYZE/);
  assert.equal(assertReadOnlySql('show create table dp_ods.t'), 'show create table dp_ods.t');
  assert.equal(assertReadOnlySql('DESCRIBE dp_ods.t'), 'DESCRIBE dp_ods.t');
  assert.equal(assertReadOnlySql('explain select 1'), 'explain select 1');
});

test('keeps comments in the submitted SQL but ignores them for validation', () => {
  const sql = '-- 说明\nselect count(*) from dp_ods.t where f_p_date = \'2026-09-01\'';
  assert.equal(assertReadOnlySql(sql), sql);
  assert.throws(() => assertReadOnlySql('-- only a comment'), /only comments/);
});

test('rejects write statements, hidden writes and multiple statements', () => {
  assert.throws(() => assertReadOnlySql(''), /empty/);
  assert.throws(() => assertReadOnlySql('INSERT INTO t SELECT 1'), /read-only/);
  assert.throws(() => assertReadOnlySql('drop table t'), /read-only/);
  assert.throws(() => assertReadOnlySql('with t as (select 1) insert into x select * from t'), /INSERT/);
  assert.throws(() => assertReadOnlySql('select 1; drop table t'), /single SQL statement/);
});

test('does not treat column names containing write keywords as writes', () => {
  assert.equal(assertReadOnlySql('select create_time, fupdate_flag from t'), 'select create_time, fupdate_flag from t');
});

test('resolves engines case-insensitively and rejects unknown ones', () => {
  assert.equal(resolveEngine(undefined), 'Presto');
  assert.equal(resolveEngine('SPARK'), 'Spark');
  assert.throws(() => resolveEngine('hive'), /unsupported engine/);
});

test('locates the temp folder by name or explicit id and the dedicated skill file', () => {
  const folders = [
    { id: 1, name: '米霍克元数据', item_list: [] },
    { id: 42766, name: TEMP_FOLDER_NAME, item_list: [{ id: 9, name: SKILL_FILE_NAME, type: 3 }, { id: 8, name: 'x', type: 3 }] },
  ];
  assert.equal(findTempFolder(folders).id, 42766);
  assert.equal(findTempFolder(folders, '1').id, 1);
  assert.throws(() => findTempFolder([{ id: 2, name: 'other' }]), /pass --folder-id/);
  assert.equal(findSkillFile(folders[1]).id, 9);
  assert.equal(findSkillFile(folders[0]), null);
});

test('builds create and update payloads for the dedicated file', () => {
  const created = buildSavePayload({ userName: 'u', folderId: 42766, fileId: null, sqlId: null, sql: 'select 1', engine: 'Presto' });
  assert.equal(created.fileName, SKILL_FILE_NAME);
  assert.equal(created.fileId, undefined);
  assert.equal(created.sqlList[0].sqlId, undefined);
  const updated = buildSavePayload({ userName: 'u', folderId: 42766, fileId: 5, sqlId: 7, sql: 'select 1', engine: 'Spark' });
  assert.equal(updated.fileId, 5);
  assert.deepEqual(updated.sqlList[0], { sqlName: 'query', fileType: 2, sql: 'select 1', engine: 'Spark', cluster: '', userName: 'u', position: 1, sqlId: 7 });
});

test('builds the submit payload the portal expects', () => {
  const payload = buildSubmitPayload({ sql: 'select 1', userName: 'u', engine: 'Presto', sqlId: 7 });
  assert.equal(payload.wholeSql, 'select 1');
  assert.equal(payload.isSkipCheckSql, false);
  assert.equal(payload.sqlId, 7);
  assert.equal(payload.executeTableName, '');
});

test('maps portal instance rows to RUNNING / SUCCESS / FAILED summaries', () => {
  assert.equal(summarizeInstance({ status: 0, progress: 0 }).status, 'RUNNING');
  const success = summarizeInstance({ status: 1, progress: 100, data: { columns: ['x'], datas: [['1']] } });
  assert.equal(success.status, 'SUCCESS');
  assert.deepEqual(success.columns, ['x']);
  assert.deepEqual(success.rows, [['1']]);
  const failed = summarizeInstance({ status: 2, message: 'sql执行失败' });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.message, 'sql执行失败');
  assert.equal(summarizeInstance({ status: 9 }).status, 'UNKNOWN_9');
  assert.equal(summarizeInstance(undefined).status, 'UNKNOWN_undefined');
});
