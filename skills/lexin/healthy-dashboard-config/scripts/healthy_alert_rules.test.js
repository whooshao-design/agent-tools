const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildRuleBody, flattenCategories, matchRules, runCreate, runList, runSetDisabled, runUpdate } = require('./healthy_alert_rules');

const template = { id: 102001, create_by: 'x', notify_groups_obj: [{ id: 21 }], notify_groups: ['21'], notify_channels: ['wecom'], severity: 3, prom_ql: 'old', name: 'old', category_id: 1 };

function fakeRequest(routes) {
  const calls = [];
  const request = async (method, route, body) => {
    calls.push({ method, route, body });
    const handler = routes[`${method} ${route.split('?')[0]}`];
    if (!handler) throw new Error(`unexpected ${method} ${route}`);
    return { status: 200, json: { dat: typeof handler === 'function' ? handler(body, calls) : handler } };
  };
  return { request, calls };
}

function ruleFile(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rule-')), 'rule.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

test('分类树展开为平铺列表，子分类也在内', () => {
  assert.deepEqual(flattenCategories([{ id: 1, name: 'a', children: [{ id: 2, name: 'b' }] }]).map((c) => c.id), [1, 2]);
});

test('按指标匹配 prom_ql 与 multi_prom_ql', () => {
  const rules = [{ id: 1, prom_ql: 'x_error > 0' }, { id: 2, prom_ql: '', multi_prom_ql: [{ prom_ql: 'x_error' }] }, { id: 3, prom_ql: 'y' }];
  assert.deepEqual(matchRules(rules, 'x_error').map((r) => r.id), [1, 2]);
});

test('模板规则只保留通知配置，去掉 id 与审计字段，覆盖分组与分类', () => {
  const body = buildRuleBody(template, { name: 'new', prom_ql: 'q > 0' }, '88', '68');
  assert.equal(body.id, undefined);
  assert.equal(body.create_by, undefined);
  assert.equal(body.notify_groups_obj, undefined);
  assert.deepEqual([body.name, body.prom_ql, body.group_id, body.category_id, body.notify_groups[0]], ['new', 'q > 0', 88, 68, '21']);
  assert.throws(() => buildRuleBody(template, { name: 'new' }, 88, 68), /prom_ql/);
});

test('create 默认 dry-run，不发 POST', async () => {
  const { request, calls } = fakeRequest({
    'GET /api/n9e/alert-rule/102001': template,
    'GET /api/n9e/busi-group/88/category/68/alert-rules': [],
  });
  const result = await runCreate(request, { gid: '88', cid: '68', 'template-rule': '102001', 'rule-file': ruleFile({ name: 'new', prom_ql: 'q' }) });
  assert.equal(result.outcome, 'dry-run');
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

test('同名规则已存在时不新建', async () => {
  const { request, calls } = fakeRequest({ 'GET /api/n9e/busi-group/88/category/68/alert-rules': [{ id: 9, name: 'new' }] });
  const result = await runCreate(request, { gid: '88', cid: '68', apply: true, 'rule-file': ruleFile({ name: 'new', prom_ql: 'q' }) });
  assert.equal(result.outcome, 'exists');
  assert.ok(!calls.some((c) => c.method === 'POST'));
});

test('apply 时 POST 到分类接口并回读校验', async () => {
  let created = null;
  const { request, calls } = fakeRequest({
    'GET /api/n9e/busi-group/88/category/68/alert-rules': () => (created ? [{ id: 7, name: created.name }] : []),
    'POST /api/n9e/busi-group/88/category/68/alert-rules': (body) => { created = body[0]; return { success: [{ id: 7 }], failed: {} }; },
    'GET /api/n9e/alert-rule/7': () => ({ ...created, id: 7 }),
  });
  const result = await runCreate(request, { gid: '88', cid: '68', apply: true, 'rule-file': ruleFile({ name: 'new', prom_ql: 'q', severity: 2, disabled: 0 }) });
  assert.equal(result.outcome, 'created');
  assert.ok(Array.isArray(calls.find((c) => c.method === 'POST').body));
});

test('list 遍历业务组的全部分类并只返回命中的规则', async () => {
  const { request } = fakeRequest({
    'GET /api/n9e/busi-groups/88/categories': [{ id: 68, name: '米霍克' }, { id: 1077, name: '老决策引擎' }],
    'GET /api/n9e/busi-group/88/category/68/alert-rules': [{ id: 1, name: 'a', prom_ql: 'fql_fk_task_error > 0' }],
    'GET /api/n9e/busi-group/88/category/1077/alert-rules': [{ id: 2, name: 'b', prom_ql: 'other' }],
  });
  const result = await runList(request, { gid: '88', metric: 'fql_fk_task_error' });
  assert.equal(result.scanned_rules, 2);
  assert.deepEqual(result.hits.map((h) => [h.id, h.category]), [[1, '米霍克']]);
});

test('update 默认 dry-run，只列出有变化的字段，不发 PUT', async () => {
  const { request, calls } = fakeRequest({ 'GET /api/n9e/alert-rule/9': { id: 9, group_id: 88, name: 'a', prom_ql: 'old', severity: 3 } });
  const result = await runUpdate(request, { id: '9', 'rule-file': ruleFile({ name: 'a', prom_ql: 'new' }) });
  assert.equal(result.outcome, 'dry-run');
  assert.deepEqual(Object.keys(result.diff), ['prom_ql']);
  assert.ok(!calls.some((c) => c.method === 'PUT'));
});

test('update 拒绝修改归属与审计字段', async () => {
  const { request } = fakeRequest({});
  await assert.rejects(runUpdate(request, { id: '9', 'rule-file': ruleFile({ group_id: 1, prom_ql: 'q' }) }), /group_id/);
});

test('update apply 时 PUT 完整规则并回读校验', async () => {
  let stored = { id: 9, group_id: 88, name: 'a', prom_ql: 'old', notify_groups: ['21'], notify_groups_obj: [{ id: 21 }] };
  const { request, calls } = fakeRequest({
    'GET /api/n9e/alert-rule/9': () => stored,
    'PUT /api/n9e/busi-group/88/alert-rule/9': (body) => { stored = { ...body }; return null; },
  });
  const result = await runUpdate(request, { id: '9', apply: true, 'rule-file': ruleFile({ prom_ql: 'new' }) });
  assert.equal(result.outcome, 'updated');
  const put = calls.find((c) => c.method === 'PUT').body;
  assert.deepEqual([put.prom_ql, put.notify_groups[0], put.notify_groups_obj], ['new', '21', undefined]);
});

test('disable 已停用时不发请求，apply 时按列表开关接口停用并回读', async () => {
  const off = fakeRequest({ 'GET /api/n9e/alert-rule/9': { id: 9, group_id: 88, disabled: 1 } });
  assert.equal((await runSetDisabled(off.request, { id: '9', apply: true }, 1)).outcome, 'unchanged');
  let disabled = 0;
  const { request, calls } = fakeRequest({
    'GET /api/n9e/alert-rule/9': () => ({ id: 9, group_id: 88, disabled }),
    'PUT /api/n9e/busi-group/88/alert-rules/disabled': (body) => { disabled = body.disabled; return null; },
  });
  assert.equal((await runSetDisabled(request, { id: '9' }, 1)).outcome, 'dry-run');
  const result = await runSetDisabled(request, { id: '9', apply: true }, 1);
  assert.equal(result.outcome, 'disabled');
  assert.deepEqual(calls.find((c) => c.method === 'PUT').body, { id: 9, disabled: 1 });
});
