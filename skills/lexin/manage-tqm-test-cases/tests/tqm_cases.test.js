'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  MAX_CASES,
  MAX_RESULTS,
  buildCasePayloads,
  buildExecutionPayloads,
  normalizeStatus,
  resolveStagePlan,
  flattenModules,
  parseArgs,
  parseVersionUrl,
  splitByExisting,
  toParagraphs,
} = require('../scripts/tqm_cases');

const LINK = 'https://tqm.oa.fenqile.com/#/testActive/testTracking/noTestVersionDetail?versionName=%E3%80%90x%E3%80%91&versionId=v-1&projectId=p-1';
const TREE = [{
  id: 'root', name: '决策支撑', is_case_node: 0, case_num: 3,
  children: [{ id: 'leaf', name: '乐包列表', is_case_node: 1, case_num: 3, children: [] }],
}];
const MODULES = flattenModules(TREE);
const OPTIONS = { versionId: 'v-1', projectId: 'p-1', maintainer: 'someone', modules: MODULES };
const CASE = { name: '用例', priority: 'p0', steps: ['a', 'b'], expected: ['ok'], node_id: 'leaf' };

test('parseVersionUrl reads ids from the hash query regardless of route', () => {
  assert.deepEqual(parseVersionUrl(LINK), { versionId: 'v-1', projectId: 'p-1', versionName: '【x】' });
  assert.equal(parseVersionUrl(LINK.replace('noTestVersionDetail', 'versionDetail')).versionId, 'v-1');
  assert.throws(() => parseVersionUrl('https://example.com/#/?versionId=1&projectId=2'), /not a TQM link/);
  assert.throws(() => parseVersionUrl(LINK.replace('&projectId=p-1', '')), /versionId and projectId/);
});

test('flattenModules joins names without a leading slash', () => {
  assert.deepEqual(MODULES.map((item) => item.path), ['决策支撑', '决策支撑/乐包列表']);
});

test('toParagraphs escapes HTML and numbers multi-line steps', () => {
  assert.equal(toParagraphs(['<a>', 'b&c'], { numbered: true }), '<p>1. &lt;a&gt;</p><p>2. b&amp;c</p>');
  assert.equal(toParagraphs('single', { numbered: true }), '<p>single</p>');
  assert.equal(toParagraphs(undefined), '');
});

test('buildCasePayloads fills defaults and resolves nodePath from the tree', () => {
  const [payload] = buildCasePayloads([{ ...CASE, is_user_case: true }], OPTIONS);
  assert.equal(payload.nodePath, '决策支撑/乐包列表');
  assert.equal(payload.priority, 'P0');
  assert.equal(payload.is_user_case, 1);
  assert.equal(payload.is_abnormal, 0);
  assert.equal(payload.step_model, 'TEXT');
  assert.equal(payload.steps, '[]');
  assert.equal(payload.status, 'Prepare');
  assert.equal(payload.type, 'functional');
  assert.equal(payload.maintainer, 'someone');
  assert.equal(payload.step_description, '<p>1. a</p><p>2. b</p>');
});

test('buildCasePayloads enforces the per-run limit and input checks', () => {
  const many = Array.from({ length: MAX_CASES + 1 }, (_, i) => ({ ...CASE, name: `c${i}` }));
  assert.throws(() => buildCasePayloads(many, OPTIONS), /at most 10/);
  assert.throws(() => buildCasePayloads([CASE, CASE], OPTIONS), /duplicate name/);
  assert.throws(() => buildCasePayloads([{ ...CASE, priority: 'high' }], OPTIONS), /priority/);
  assert.throws(() => buildCasePayloads([{ ...CASE, node_id: 'root' }], OPTIONS), /not a case node/);
  assert.throws(() => buildCasePayloads([{ ...CASE, node_id: 'nope' }], OPTIONS), /not in this project/);
  assert.throws(() => buildCasePayloads([{ ...CASE, node_id: undefined }], OPTIONS), /node_id missing/);
  assert.equal(buildCasePayloads([{ ...CASE, node_id: undefined }], { ...OPTIONS, nodeId: 'leaf' })[0].node_id, 'leaf');
  assert.throws(() => buildCasePayloads([{ ...CASE, is_abnormal: 2 }], OPTIONS), /0\/1/);
});

test('splitByExisting skips names already in the version', () => {
  const payloads = buildCasePayloads([CASE, { ...CASE, name: '新用例' }], OPTIONS);
  const { toCreate, skipped } = splitByExisting(payloads, [' 用例 ']);
  assert.deepEqual(toCreate.map((item) => item.name), ['新用例']);
  assert.deepEqual(skipped.map((item) => item.name), ['用例']);
});

test('parseArgs keeps the subcommand positional and boolean flags', () => {
  const args = parseArgs(['create', '--url=x', '--dry-run', '--file', 'a.json']);
  assert.deepEqual(args._, ['create']);
  assert.equal(args['dry-run'], true);
  assert.equal(args.file, 'a.json');
});

test('example cases file is valid input', () => {
  const file = path.join(__dirname, '../references/cases.example.json');
  const cases = JSON.parse(fs.readFileSync(file, 'utf8'));
  const modules = [{ id: '3357dd38-2815-4c3b-ad89-c48259a9e900', name: '乐包列表', path: '决策支撑/决策引擎/乐包管理/乐包列表', isCaseNode: 1 }];
  assert.equal(buildCasePayloads(cases, { ...OPTIONS, modules }).length, 7);
});

const PLAN_ROWS = [
  { id: 'pc-1', case_id: 'c-1', num: 101, name: '主流程', status: 'Prepare', step_model: 'TEXT' },
  { id: 'pc-2', case_id: 'c-2', num: 102, name: '取消', status: 'Failure', step_model: 'TEXT' },
  { id: 'pc-3', case_id: 'c-3', num: 103, name: '步骤用例', status: 'Prepare', step_model: 'STEP' },
];

test('normalizeStatus accepts values and Chinese labels, rejects 未开始', () => {
  assert.equal(normalizeStatus('pass', 'r'), 'Pass');
  assert.equal(normalizeStatus('阻塞', 'r'), 'Blocking');
  assert.throws(() => normalizeStatus('Prepare', 'r'), /status must be/);
  assert.throws(() => normalizeStatus('ok', 'r'), /status must be/);
});

test('resolveStagePlan uses --stage, else the current test stage', () => {
  const version = { stage: 'project_test', stages: [{ stage: 'project_test', id: 'plan-p' }, { stage: 'pre_test', id: 'plan-pre' }] };
  assert.equal(resolveStagePlan(version).planId, 'plan-p');
  assert.equal(resolveStagePlan(version, 'pre_test').planId, 'plan-pre');
  assert.throws(() => resolveStagePlan({ ...version, stage: 'case_design' }), /no executable cases/);
  assert.throws(() => resolveStagePlan(version, 'product_test'), /no plan for stage/);
});

test('buildExecutionPayloads maps by num or name and protects existing results', () => {
  const { toWrite, skipped } = buildExecutionPayloads([
    { num: 101, status: '通过', actual: ['a', '<b>'] },
    { name: '取消', status: 'Pass', actual: 'x' },
  ], PLAN_ROWS, { projectId: 'p-1', overwrite: false });
  assert.equal(toWrite.length, 1);
  assert.deepEqual(
    { id: toWrite[0].id, case_id: toWrite[0].case_id, status: toWrite[0].status, results: toWrite[0].results, project_id: toWrite[0].project_id },
    { id: 'pc-1', case_id: 'c-1', status: 'Pass', results: '[]', project_id: 'p-1' },
  );
  assert.equal(toWrite[0].actual_result, '<p>a</p><p>&lt;b&gt;</p>');
  assert.deepEqual(skipped.map((item) => item.num), [102]);
  const forced = buildExecutionPayloads([{ name: '取消', status: 'Pass', actual: 'x' }], PLAN_ROWS, { projectId: 'p-1', overwrite: true });
  assert.equal(forced.toWrite.length, 1);
});

test('buildExecutionPayloads rejects unknown, duplicate, STEP and oversized input', () => {
  const opts = { projectId: 'p-1' };
  assert.throws(() => buildExecutionPayloads([{ num: 999, status: 'Pass', actual: 'x' }], PLAN_ROWS, opts), /not in this stage/);
  assert.throws(() => buildExecutionPayloads([{ num: 101, status: 'Pass', actual: 'x' }, { name: '主流程', status: 'Pass', actual: 'y' }], PLAN_ROWS, opts), /listed twice/);
  assert.throws(() => buildExecutionPayloads([{ num: 103, status: 'Pass', actual: 'x' }], PLAN_ROWS, opts), /only TEXT/);
  assert.throws(() => buildExecutionPayloads([{ num: 101, status: 'Pass' }], PLAN_ROWS, opts), /actual/);
  const many = Array.from({ length: MAX_RESULTS + 1 }, (_, i) => ({ num: i, status: 'Pass', actual: 'x' }));
  assert.throws(() => buildExecutionPayloads(many, PLAN_ROWS, opts), /at most/);
});

test('results example file is well formed', () => {
  const results = JSON.parse(fs.readFileSync(path.join(__dirname, '../references/results.example.json'), 'utf8'));
  assert.ok(results.length > 0 && results.length <= MAX_RESULTS);
  for (const item of results) {
    assert.ok(item.num);
    assert.equal(normalizeStatus(item.status, 'example'), 'Pass');
    assert.ok(Array.isArray(item.actual) && item.actual.length);
  }
});

