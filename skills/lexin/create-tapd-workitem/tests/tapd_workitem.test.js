'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { addUrl, keepAccountTokens, matchOption, missingRequired, parseArgs, validateBugSpec } = require('../scripts/tapd_workitem');

const REF = path.join(__dirname, '../references');
const EXAMPLE = require(path.join(REF, 'bug.example.json'));

test('example bug spec validates and loads the description file', () => {
  const spec = validateBugSpec(EXAMPLE, REF);
  assert.equal(spec.workspace, '20061171');
  assert.equal(spec.template, '1120061171001000570');
  assert.ok(spec.description.includes('复现步骤'));
  assert.deepEqual(spec.fields.custom_field_11, ['基础研发组']);
});

test('validateBugSpec rejects missing or malformed keys', () => {
  assert.throws(() => validateBugSpec({ ...EXAMPLE, title: ' ' }, REF), /title is required/);
  assert.throws(() => validateBugSpec({ ...EXAMPLE, workspace: 'abc' }, REF), /workspace/);
  assert.throws(() => validateBugSpec({ ...EXAMPLE, template: 'x' }, REF), /template/);
  assert.throws(() => validateBugSpec({ ...EXAMPLE, owner: 'a;b' }, REF), /single TAPD account/);
  assert.throws(() => validateBugSpec({ ...EXAMPLE, description_file: undefined, description: '' }, REF), /description/);
  assert.throws(() => validateBugSpec({ ...EXAMPLE, fields: [] }, REF), /fields/);
});

test('keepAccountTokens drops prefix matches added by the user chooser', () => {
  assert.equal(keepAccountTokens('jojoduan段艳会;joneyshao邵鹏;', 'joneyshao'), 'joneyshao邵鹏;');
  assert.equal(keepAccountTokens('', 'joneyshao'), '');
});

test('matchOption accepts option value or visible text, nothing else', () => {
  const options = [{ value: 'medium', text: '中' }, { value: 'high', text: '高' }];
  assert.equal(matchOption(options, '中'), 'medium');
  assert.equal(matchOption(options, 'high'), 'high');
  assert.equal(matchOption(options, '中等'), null);
});

test('missingRequired lists only empty required items', () => {
  const items = [
    { name: 'severity', label: '严重程度', required: true, filled: true },
    { name: 'custom_field_11', label: '缺陷归属', required: true, filled: false },
    { name: 'custom_field_17', label: '所属功能', required: false, filled: false },
  ];
  assert.deepEqual(missingRequired(items), ['缺陷归属(custom_field_11)']);
});

test('parseArgs and addUrl', () => {
  assert.deepEqual(parseArgs(['create-bug', '--file=a.json', '--dry-run']), { _: ['create-bug'], file: 'a.json', 'dry-run': true });
  assert.equal(addUrl('20061171', '1120061171001000570'), 'https://www.tapd.cn/20061171/bugtrace/bugs/add?template_id=1120061171001000570');
  assert.equal(addUrl('20061171'), 'https://www.tapd.cn/20061171/bugtrace/bugs/add');
});
