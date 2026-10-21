'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  NOTIFY,
  descriptionText,
  findBlockingPlans,
  formatDate,
  lintDescription,
  normalizeNotify,
  parseArgs,
  parseCurrentUser,
  validatePatch,
  validatePlan,
} = require('../scripts/publish_plan');

const EXAMPLE = require(path.join(__dirname, '../references/plan.frontend.example.json'));
const NOW = Date.parse('2026-10-21T12:00:00+08:00');

test('example frontend plan validates and passes the backend-term lint', () => {
  const plan = validatePlan(EXAMPLE, { now: NOW });
  assert.equal(plan.projectType, 'frontend');
  assert.deepEqual(plan.demandIds, ['1426731']);
  assert.equal(plan.notify, '无需通知');
  assert.deepEqual(plan.apps, ['web_mihawk_oa']);
  assert.ok(plan.description.includes('\n\n4、 影响分析'));
  assert.deepEqual(lintDescription(plan.description, 'frontend'), []);
});

test('validatePlan rejects backend plans and unsupported options', () => {
  assert.throws(() => validatePlan({ ...EXAMPLE, projectType: 'backend' }, { now: NOW }), /后端计划暂不支持，后续补充/);
  assert.throws(() => validatePlan({ ...EXAMPLE, projectType: '' }, { now: NOW }), /frontend/);
  assert.throws(() => validatePlan({ ...EXAMPLE, crossTeam: true }, { now: NOW }), /crossTeam/);
  assert.throws(() => validatePlan({ ...EXAMPLE, env: 'pre' }, { now: NOW }), /env/);
  assert.throws(() => validatePlan({ ...EXAMPLE, notify: 'email' }, { now: NOW }), /notify/);
  assert.throws(() => validatePlan({ ...EXAMPLE, onlineDate: '2026-13-01' }, { now: NOW }), /YYYY-MM-DD/);
  assert.throws(() => validatePlan({ ...EXAMPLE, onlineDate: '2026-10-19' }, { now: NOW }), /already past/);
  assert.throws(() => validatePlan({ ...EXAMPLE, demandIds: 'abc' }, { now: NOW }), /TAPD/);
  assert.throws(() => validatePlan({ ...EXAMPLE, apps: [] }, { now: NOW }), /apps/);
  assert.throws(() => validatePlan({ ...EXAMPLE, apps: ['a', 'a'] }, { now: NOW }), /duplicates/);
  assert.throws(() => validatePlan({ ...EXAMPLE, leader: '' }, { now: NOW }), /leader is required/);
  assert.throws(() => validatePlan({ ...EXAMPLE, description: [] }, { now: NOW }), /description/);
});

test('validatePlan accepts the valid window up to 06:00 of the next day', () => {
  assert.equal(validatePlan({ ...EXAMPLE, onlineDate: '2026-10-21' }, { now: NOW }).onlineDate, '2026-10-21');
  assert.equal(validatePlan({ ...EXAMPLE, demandIds: '1, 2,2' }, { now: NOW }).demandIds.join(','), '1,2');
});

test('lintDescription flags backend release items in a frontend plan', () => {
  const bad = '7、 其他事项：前端先发布，后端 server_hawk_decision_manage 后发布；Hippo 配置 package_copy_real_time_query_confirm 随版本发布';
  assert.deepEqual(lintDescription(bad, 'frontend'), ['Hippo', 'server_hawk_decision_manage']);
  assert.ok(lintDescription('ALTER TABLE t_x ADD COLUMN y', 'frontend').length >= 1);
  assert.ok(lintDescription('执行 SQL 刷数', 'frontend').length >= 1);
  assert.deepEqual(lintDescription('本前端版本需先于后端发布', 'frontend'), []);
});

test('normalizeNotify maps keys and raw radio values', () => {
  assert.equal(normalizeNotify('none'), '无需通知');
  assert.equal(normalizeNotify('无需通知'), '无需通知');
  assert.equal(normalizeNotify('diy'), 'diy');
  assert.equal(normalizeNotify('risk'), NOTIFY.risk);
  assert.throws(() => normalizeNotify(''), /notify/);
});

test('validatePatch only allows description and notify', () => {
  assert.deepEqual(validatePatch({ description: ['a', 'b'] }), { description: 'a\nb' });
  assert.deepEqual(validatePatch({ notify: 'none' }), { notify: '无需通知' });
  assert.throws(() => validatePatch({ apps: ['x'] }), /unsupported: apps/);
  assert.throws(() => validatePatch({}), /description or notify/);
  assert.throws(() => validatePatch({ description: '  ' }), /empty/);
});

test('findBlockingPlans blocks pending or valid plans for the same requirement', () => {
  const tomorrow = Date.parse('2026-10-22T00:00:00+08:00');
  const longAgo = Date.parse('2026-09-08T00:00:00+08:00');
  const rows = [
    { id: 44107, demandIds: '1426731', planApproveStatus: 'WAIT', validity: false, planOnlineTime: tomorrow },
    { id: 43973, demandIds: '1423729', planApproveStatus: 'APPROVED', validity: false, planOnlineTime: longAgo },
    { id: 1, demandIds: '9,1426731', planApproveStatus: 'APPROVED', validity: true, planOnlineTime: longAgo },
    { id: 2, demandIds: '1426731', planApproveStatus: 'WAIT', validity: false, planOnlineTime: longAgo },
    { id: 3, demandIds: '1426731', planApproveStatus: 'REJECT', validity: false, planOnlineTime: tomorrow },
  ];
  assert.deepEqual(findBlockingPlans(rows, ['1426731'], NOW).map((row) => row.id), [44107, 1]);
  assert.deepEqual(findBlockingPlans(rows, ['1423729'], NOW), []);
});

test('formatDate renders Asia/Shanghai dates and descriptionText trims trailing blanks', () => {
  assert.equal(formatDate(1792598400000), '2026-10-22');
  assert.equal(formatDate('2026-10-22T16:00:00.000Z'), '2026-10-23');
  assert.equal(descriptionText(['a', '', 'b', '']), 'a\n\nb');
});

test('parseCurrentUser and parseArgs', () => {
  assert.equal(parseCurrentUser('邵鹏(joneyshao)'), 'joneyshao');
  assert.equal(parseCurrentUser('someone'), 'someone');
  const args = parseArgs(['modify', '--id=44107', '--dry-run', '--file', 'p.json']);
  assert.deepEqual(args._, ['modify']);
  assert.equal(args.id, '44107');
  assert.equal(args['dry-run'], true);
  assert.equal(args.file, 'p.json');
});
