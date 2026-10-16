'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findModule, findRoutePath, htmlPathForModule, isProdDomain, lineHasTerm, pageUrl,
  parseGatewayRows, parseGroupProjects, parseImports, parseInput, rankRepos, resolveImport, searchTerms, summarize,
} = require('../scripts/locate_frontend_page');

test('only one entry is accepted and interface must be fully qualified', () => {
  assert.throws(() => parseInput({}));
  assert.throws(() => parseInput({ interface: 'a.B', table: 't_x' }));
  assert.throws(() => parseInput({ interface: 'UserWhitelistCgiService' }));
  assert.equal(parseInput({ table: 'rc_credit_ms_db.t_user_whitelist' }).table, 't_user_whitelist');
  assert.equal(parseInput({ interface: 'com.a.FooService', method: 'page' }).method, 'page');
});

test('non-prod gateway domains are excluded', () => {
  assert.equal(isProdDomain('hawkeye.oa.fenqile.com'), true);
  assert.equal(isProdDomain('mihawk.oa.fenqile.com'), true);
  for (const d of ['pre.hawkeye.oa.fql.com', 'stable-mihawk.oa.fenqile.com', 'test.x.oa.fenqile.com', 'gray-x.oa.fenqile.com']) {
    assert.equal(isProdDomain(d), false, d);
  }
});

test('gateway prefix is stripped because frontend interceptors add it back', () => {
  assert.deepEqual(searchTerms('/rc_oa_gateway/rc_mock/user_whitelist_page'), ['rc_mock/user_whitelist_page']);
  assert.deepEqual(searchTerms('https://mihawk.oa.fenqile.com/rc_oa_gateway/hawk_decision/a.json?x=1'),
    ['hawk_decision/a.json', 'hawk_decision/a']);
  assert.equal(lineHasTerm("postJson('/rc_mock/user_whitelist_page', {", 'rc_mock/user_whitelist_page'), true);
  assert.equal(lineHasTerm("postJson('/rc_mock/user_whitelist_page_v2')", 'rc_mock/user_whitelist_page'), false);
  assert.equal(lineHasTerm("x('/a/b_page-old') || x('/a/b_page')", 'a/b_page'), true);
});

test('repo ranking prefers exact domain name over partial match', () => {
  const names = ['web-hawkeye-oa-risk-loan', 'web_mihawk_oa', 'web_hawkeye_oa'];
  assert.deepEqual(rankRepos('hawkeye.oa.fenqile.com', names), ['web_hawkeye_oa', 'web-hawkeye-oa-risk-loan']);
  assert.deepEqual(rankRepos('mihawk.oa.fenqile.com', names), ['web_mihawk_oa']);
});

test('multi-page module names map to published html paths', () => {
  assert.equal(htmlPathForModule('InterestFreeWhitelistList'), 'interest-free-whitelist-list.html');
  assert.equal(htmlPathForModule('orderQuery/Index'), 'order-query/index.html');
  assert.equal(htmlPathForModule('Help'), 'help.html');
  assert.equal(htmlPathForModule(''), 'index.html');
  assert.equal(pageUrl('h.oa.fenqile.com', 'index.html', '/flow/x', false), 'https://h.oa.fenqile.com/#/flow/x');
  assert.equal(pageUrl('h.oa.fenqile.com', 'a-b.html', '/manage', false), 'https://h.oa.fenqile.com/a-b.html#/manage');
});

test('nearest main.js decides the module', () => {
  const files = new Set(['src/modules/Index/main.js', 'src/modules/orderQuery/Index/main.js', 'src/modules/Index/page/app/x.vue']);
  assert.deepEqual(findModule('src/modules/Index/page/app/x.vue', files), { dir: 'src/modules/Index', moduleRel: 'Index' });
  assert.deepEqual(findModule('src/modules/orderQuery/Index/page/a.vue', files), { dir: 'src/modules/orderQuery/Index', moduleRel: 'orderQuery/Index' });
});

test('imports resolve relative and alias paths with implicit extensions', () => {
  const files = new Set(['src/modules/Index/page/app/ChipFlowSetting.vue', 'src/modules/Index/page/app/components/chipFlow/index.vue']);
  const source = `
    const ChipFlowSetting = () =>
        import(/* webpackChunkName: "ChipFlowSetting" */ '../page/app/ChipFlowSetting');
    import ChipFlow from './components/chipFlow';
    import { a } from '@/utils/x';`;
  const imports = parseImports(source);
  assert.ok(imports.some((i) => i.name === 'ChipFlowSetting' && i.spec === '../page/app/ChipFlowSetting'));
  assert.equal(resolveImport('src/modules/Index/route/routes.js', '../page/app/ChipFlowSetting', files), 'src/modules/Index/page/app/ChipFlowSetting.vue');
  assert.equal(resolveImport('src/modules/Index/page/app/ChipFlowSetting.vue', './components/chipFlow', files), 'src/modules/Index/page/app/components/chipFlow/index.vue');
  assert.equal(resolveImport('a.js', 'vue', files), null);
});

test('route path is taken from the same route object as the component', () => {
  const source = `const routes = [
    { path: '/', redirect: '/index' },
    {
        path: '/flow/ab',
        component: AbSetting,
        meta: { title: 'AB' }
    },
    {
        path: '/flow/offer_list/chip_flow_setting',
        component: ChipFlowSetting,
        meta: { title: '流程引擎配置' }
    },
    { component: Tail, path: 'child' }
  ];`;
  assert.deepEqual(findRoutePath(source, 'ChipFlowSetting'), [{ path: '/flow/offer_list/chip_flow_setting', nested: false }]);
  assert.deepEqual(findRoutePath(source, 'Tail'), [{ path: 'child', nested: true }]);
  assert.deepEqual(findRoutePath(source, 'Missing'), []);
});

test('gateway not-logged-in is reported as login required, not as zero rules', () => {
  assert.throws(() => parseGatewayRows('{"retcode":"16051006","retmsg":"您还没登录或者登录已过期","result_rows":[]}'), (e) => e.code === 'LOGIN_REQUIRED');
  assert.throws(() => parseGatewayRows('<html>'));
  const ok = parseGatewayRows('{"retcode":"0","total_num":1,"total_page":1,"result_rows":[{"url":"/a"}]}');
  assert.equal(ok.rows.length, 1);
});

test('gitlab group page html yields project names', () => {
  const html = '<a href="/rc_fd/web_hawkeye_oa">x</a><a href="/rc_fd/web_hawkeye_oa">y</a><a href="/rc_fd/web-agent-oa">z</a><a href="/other/x">';
  assert.deepEqual(parseGroupProjects(html), ['web_hawkeye_oa', 'web-agent-oa']);
});

test('summary lists one row per rule', () => {
  const out = summarize({ results: [{
    rule: { interface_name: 'com.a.FooService', method: 'page', domain: 'h.oa.fenqile.com', url: '/rc_oa_gateway/a' },
    pages: [{ repo: '/x/web_h', ref: 'origin/product', file: 'src/a.vue', lines: [3], pageUrls: ['https://h/#/m'] }],
  }] });
  assert.deepEqual(out, [{
    backend: 'FooService#page', api: 'https://h.oa.fenqile.com/rc_oa_gateway/a',
    pageUrls: ['https://h/#/m'], callers: ['web_h@origin/product:src/a.vue:3'],
  }]);
});
