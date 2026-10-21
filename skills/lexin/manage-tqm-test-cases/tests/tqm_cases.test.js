'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  MAX_CASES,
  buildCasePayloads,
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
