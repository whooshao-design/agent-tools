'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SITES, approvalInfo, buildPayload, classifyProbe, consoleIp, normalizeRuleUrl, resolveSite, runAdd, sameRuleUrl, validateAddArgs,
} = require('../scripts/oa_gateway_rule');

const TEMPLATE = {
  index: 9, url: '/rc_oa_gateway/hawk_decision/manage/diff/diff_strategy_node.json', domain: 'mihawk.oa.fenqile.com',
  system_id: 76, protocol: 'fsof', interface_name: 'a.b.DiffService', interface_version: '2.0.0', interface_group: '*',
  lsf_app_name: 'server_x', method: 'diffStrategyNode', method_time_out: 6000, check_auth: 1, operator: 'someone',
  modify_time: 1, url_manager: 'someone',
};

test('rule urls normalize to the stored /rc_oa_gateway/ form', () => {
  assert.equal(normalizeRuleUrl('hawk/x.json'), '/rc_oa_gateway/hawk/x.json');
  assert.equal(normalizeRuleUrl('https://mihawk.oa.fenqile.com/rc_oa_gateway/hawk/x.json?a=1'), '/rc_oa_gateway/hawk/x.json');
  assert.ok(sameRuleUrl('/rc_oa_gateway/hawk/x.json', 'rc_oa_gateway/hawk/x.json'));
  assert.throws(() => normalizeRuleUrl(''));
});

test('payload copies template routing fields and drops identity fields', () => {
  const payload = buildPayload(TEMPLATE, {
    url: 'hawk/new.json', method: 'diffNew', timeout: '15000', urlManager: 'me', funcDesc: 'desc',
  });
  assert.equal(payload.url, '/rc_oa_gateway/hawk/new.json');
  assert.equal(payload.method, 'diffNew');
  assert.equal(payload.system_id, 76);
  assert.equal(payload.interface_name, 'a.b.DiffService');
  assert.equal(payload.method_time_out, 15000);
  assert.equal(payload.check_auth, 1);
  assert.equal(payload.url_manager, 'me');
  for (const key of ['index', 'operator', 'modify_time']) assert.equal(key in payload, false);
});

test('approval info treats empty result_rows as saved directly', () => {
  assert.deepEqual(approvalInfo({ result_rows: [] }), { needApproval: false, needApplyReason: false, needOutNetReason: false });
  assert.equal(approvalInfo({ result_rows: [{ need_approval: true, need_apply_reason: true }] }).needApplyReason, true);
});

test('runtime probe distinguishes unrouted urls from routed ones', () => {
  assert.equal(classifyProbe('{"retcode":"16051005","retmsg":"url 未配置路由规则"}').routed, false);
  assert.equal(classifyProbe('{"retcode":"16051006"}').routed, true);
  assert.equal(classifyProbe('<html>').routed, null);
});

function fakeCall(handlers) {
  const calls = [];
  const call = async (path, body) => {
    calls.push({ path, body });
    return handlers(path, body, calls);
  };
  return { call, calls };
}

function rulesResponse(rows) {
  return { retcode: '0', total_page: 1, result_rows: rows };
}

const ADD_ARGS = {
  'template-url': 'hawk_decision/manage/diff/diff_strategy_node.json', url: 'hawk/new.json', method: 'diffNew',
  'url-manager': 'me',
};

test('dry-run sends no write request', async () => {
  const { call, calls } = fakeCall((path, body) => rulesResponse(body.url === TEMPLATE.url ? [TEMPLATE] : []));
  const result = await runAdd(call, ADD_ARGS, 'prod');
  assert.equal(result.outcome, 'dry-run');
  assert.ok(calls.every((c) => c.path.endsWith('query_page_list.json')));
});

test('an existing url is never added again', async () => {
  const { call, calls } = fakeCall(() => rulesResponse([{ ...TEMPLATE, url: '/rc_oa_gateway/hawk/new.json' }]));
  const result = await runAdd(call, { ...ADD_ARGS, apply: true }, 'prod');
  assert.equal(result.outcome, 'exists');
  assert.equal(calls.length, 1);
});

test('approval-required stops before the second submit when a reason is needed', async () => {
  const { call, calls } = fakeCall((path, body) => {
    if (path.endsWith('add_with_approval.json')) return { retcode: '0', result_rows: [{ need_approval: true, need_apply_reason: true }] };
    return rulesResponse(body.url === TEMPLATE.url ? [TEMPLATE] : []);
  });
  const result = await runAdd(call, { ...ADD_ARGS, apply: true }, 'prod');
  assert.equal(result.outcome, 'approval-required');
  assert.equal(calls.filter((c) => c.path.endsWith('add_with_approval.json')).length, 1);
});

test('approval is submitted with apply_reason on the second call', async () => {
  const { call, calls } = fakeCall((path, body) => {
    if (path.endsWith('add_with_approval.json')) return { retcode: '0', result_rows: body.apply_reason ? [] : [{ need_approval: true, need_apply_reason: true }] };
    if (path.endsWith('persons.json')) return { retcode: '0', result_rows: [{ process: 'A -> B' }] };
    return rulesResponse(body.url === TEMPLATE.url ? [TEMPLATE] : []);
  });
  const result = await runAdd(call, { ...ADD_ARGS, apply: true, 'apply-reason': 'why' }, 'prod');
  assert.equal(result.outcome, 'approval-submitted');
  assert.equal(result.approvalProcess, 'A -> B');
  const adds = calls.filter((c) => c.path.endsWith('add_with_approval.json'));
  assert.equal(adds.length, 2);
  assert.equal(adds[1].body.apply_reason, 'why');
});

test('a direct save is read back', async () => {
  let saved = false;
  const { call } = fakeCall((path, body) => {
    if (path.endsWith('add_with_approval.json')) { saved = true; return { retcode: '0', result_rows: [] }; }
    if (body.url === TEMPLATE.url) return rulesResponse([TEMPLATE]);
    return rulesResponse(saved ? [{ ...TEMPLATE, url: '/rc_oa_gateway/hawk/new.json', method: 'diffNew' }] : []);
  });
  const result = await runAdd(call, { ...ADD_ARGS, apply: true }, 'prj');
  assert.equal(result.outcome, 'saved');
  assert.equal(result.rule.method, 'diffNew');
});

test('add arguments are validated before any console call', () => {
  assert.throws(() => validateAddArgs({ url: 'x.json' }), /--template-url、--method、--url-manager/);
  assert.throws(() => validateAddArgs({ ...ADD_ARGS, timeout: '15s' }), /--timeout/);
  assert.throws(() => validateAddArgs({ ...ADD_ARGS, 'check-auth': '2' }), /--check-auth/);
  assert.throws(() => validateAddArgs({ ...ADD_ARGS, interface: 'other.Service' }, TEMPLATE), /--lsf-app/);
  validateAddArgs({ ...ADD_ARGS, interface: 'other.Service', 'lsf-app': 'server_y' }, TEMPLATE);
  const payload = buildPayload(TEMPLATE, { url: 'a.json', method: 'm', interfaceName: 'other.Service', lsfApp: 'server_y', urlManager: 'me' });
  assert.equal(payload.lsf_app_name, 'server_y');
});

test('project console ip comes from the argument or local env and is required', () => {
  const saved = process.env.OA_GATEWAY_PRJ_CONSOLE_IP;
  try {
    delete process.env.OA_GATEWAY_PRJ_CONSOLE_IP;
    assert.throws(() => consoleIp({}), /OA_GATEWAY_PRJ_CONSOLE_IP/);
    process.env.OA_GATEWAY_PRJ_CONSOLE_IP = '192.0.2.1';
    assert.equal(consoleIp({}), '192.0.2.1');
    assert.equal(consoleIp({ 'console-ip': '192.0.2.2' }), '192.0.2.2');
  } finally {
    if (saved === undefined) delete process.env.OA_GATEWAY_PRJ_CONSOLE_IP;
    else process.env.OA_GATEWAY_PRJ_CONSOLE_IP = saved;
  }
});

test('sites resolve by code or alias to their own console and default probe domain', () => {
  assert.deepEqual(Object.keys(SITES), ['cn', 'mx', 'id']);
  assert.equal(resolveSite(undefined).key, 'cn');
  assert.equal(resolveSite(undefined).consoleHost, 'gateway.oa.fenqile.com');
  for (const alias of ['mx', 'MX', 'mexico', '墨西哥', 'wowcredito']) {
    const site = resolveSite(alias);
    assert.deepEqual([site.key, site.console, site.consoleHost, site.probeDomain],
      ['mx', 'https://fk-gateway.oa.wowcredito.com', 'fk-gateway.oa.wowcredito.com', 'mihawk.oa.wowcredito.com']);
  }
  for (const alias of ['id', 'idn', 'indonesia', '印尼', 'kredito']) {
    const site = resolveSite(alias);
    assert.deepEqual([site.key, site.console, site.probeDomain], ['id', 'https://fk-gateway.oa.kredito.id', 'mihawk.oa.kredito.id']);
  }
  assert.throws(() => resolveSite('us'), /--site 只支持/);
});
