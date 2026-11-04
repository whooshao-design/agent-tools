'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { branchProblem, crGate, exactOptionIndex, nameList, parseArgs, summarizeRow, validateCreate } = require('../scripts/lexiao_cr');

const CREATE = {
  repo: '/tmp/web_mihawk_oa',
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
  assert.throws(() => validateCreate({ ...CREATE, repo: undefined }), /--repo is required/);
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

test('branchProblem refuses a branch already merged into or behind the compare branch', () => {
  const base = { branch: 'rel_x_1', compare: 'product' };
  assert.match(branchProblem({ ...base, branchInCompare: true, compareInBranch: true }), /无需CR/);
  assert.match(branchProblem({ ...base, branchInCompare: false, compareInBranch: false }), /merge origin\/product into rel_x_1/);
  assert.equal(branchProblem({ ...base, branchInCompare: false, compareInBranch: true }), '');
});

test('crGate needs a CR_PASS record created after the last commit, judged on the latest record of the branch', () => {
  const row = (id, statusCode, createTime, branch = 'rel_x_1') => ({ id, branch, statusCode, status: statusCode, createTime, url: '' });
  assert.match(crGate([], 'rel_x_1', 100).reason, /no Lexiao CR record/);
  assert.match(crGate([row(1, 'CR_PASS', 200, 'rel_other_1')], 'rel_x_1', 100).reason, /no Lexiao CR record/);
  assert.match(crGate([row(87001, 'NO_CR_NEEDED', 200)], 'rel_x_1', 100).reason, /not CR通过/);
  assert.match(crGate([row(2, 'CR_PASS', 50)], 'rel_x_1', 100).reason, /before the last commit/);
  assert.match(crGate([row(2, 'CR_PASS', 200), row(3, 'CRING', 300)], 'rel_x_1', 100).reason, /3 .*not CR通过/);
  // 增量 CR 只多了合入 product 的提交时为无需CR，之前有 CR通过 即可放行
  assert.equal(crGate([row(3, 'NO_CR_NEEDED', 300), row(2, 'CR_PASS', 200)], 'rel_x_1', 250).ok, true);
  assert.equal(crGate([row(3, 'NO_CR_NEEDED', 300), row(2, 'CRING', 200)], 'rel_x_1', 250).ok, false);
  const ok = crGate([row(2, 'CR_PASS', 200), row(1, 'NO_CR_NEEDED', 150)], 'rel_x_1', 100);
  assert.equal(ok.ok, true);
  assert.equal(ok.row.id, 2);
});
