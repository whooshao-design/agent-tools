'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { exactOptionIndex, nameList, parseArgs, summarizeRow, validateCreate } = require('../scripts/lexiao_cr');

const CREATE = {
  demand: '1426731',
  group: 'rc_fd',
  project: 'web_mihawk_oa',
  branch: 'rel_strategyNodeRuleCodeDiff_1426731',
  compare: 'product',
  reviewers: 'jianquanma',
  cc: 'jaydeng,jensxu',
};

test('validateCreate accepts the 1426731 frontend CR and splits name lists', () => {
  const spec = validateCreate(CREATE);
  assert.deepEqual(spec.reviewers, ['jianquanma']);
  assert.deepEqual(spec.cc, ['jaydeng', 'jensxu']);
  assert.deepEqual(validateCreate({ ...CREATE, cc: undefined }).cc, []);
});

test('validateCreate rejects missing fields, bad demand and same branches', () => {
  assert.throws(() => validateCreate({ ...CREATE, group: '' }), /--group is required/);
  assert.throws(() => validateCreate({ ...CREATE, demand: 'abc' }), /TAPD/);
  assert.throws(() => validateCreate({ ...CREATE, compare: CREATE.branch }), /must differ/);
  assert.throws(() => validateCreate({ ...CREATE, reviewers: ' , ' }), /--reviewers is required/);
});

test('exactOptionIndex matches the first line only and refuses ambiguity', () => {
  const texts = ['jianquanma2', 'jianquanma\n开发SE应用负责人 职级符合', 'xjianquanma'];
  assert.deepEqual(exactOptionIndex(texts, 'jianquanma'), { index: 1, count: 1 });
  assert.deepEqual(exactOptionIndex(['product', 'product'], 'product'), { index: -1, count: 2 });
  assert.deepEqual(exactOptionIndex([], 'product'), { index: -1, count: 0 });
});

test('nameList, parseArgs and summarizeRow', () => {
  assert.deepEqual(nameList('a, b,a,'), ['a', 'b']);
  assert.deepEqual(parseArgs(['create', '--demand=1', '--dry-run']), { _: ['create'], demand: '1', 'dry-run': true });
  const row = summarizeRow({ code_review_id: 87001, project_name: 'web_mihawk_oa', front_code_review_status_desc: '发起中' });
  assert.equal(row.id, 87001);
  assert.equal(row.status, '发起中');
  assert.equal(row.url, '');
});
