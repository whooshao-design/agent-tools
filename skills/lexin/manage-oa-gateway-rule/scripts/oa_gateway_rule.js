#!/usr/bin/env node
'use strict';
// agent-tools bootstrap（模板 lib/agent_tools/bootstrap.js，lint 规则六校验逐字一致）
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
// probe 返回 'hit' | 'miss' | <异常码>：与 locate.py 同序先看 install.py（缺失即 miss），再看 skills/；用会抛错的 statSync，不用对一切错误都返回 false 的 existsSync
const probe = (d) => { if (!d) return 'miss'; try { const i = fs.statSync(path.join(d, 'install.py'), { throwIfNoEntry: false }); if (!i || !i.isFile()) return 'miss'; const s = fs.statSync(path.join(d, 'skills'), { throwIfNoEntry: false }); return s && s.isDirectory() ? 'hit' : 'miss'; } catch (e) { return e.code || 'error'; } };
const tried = []; let root = '', r = 'miss';
try { let d = fs.realpathSync(__dirname); tried.push(`上溯起点 ${d}`); while ((r = probe(d)) === 'miss' && path.dirname(d) !== d) d = path.dirname(d); if (r === 'hit') root = d; else tried[0] += r === 'miss' ? ' 未命中有效根（install.py 文件 + skills/ 目录）' : ` ${r}（放弃上溯）`; }
catch (e) { tried.push(`上溯起点 ${__dirname} ${e.code || e.message}`); }
if (!root) { const v = process.env.AGENT_TOOLS_ROOT || ''; r = probe(v); tried.push(`AGENT_TOOLS_ROOT=${v || '<unset>'}${r === 'hit' || r === 'miss' ? '' : ' ' + r}`); if (r === 'hit') root = v; }
if (!root) { const p = path.join(os.homedir(), '.config/agent-tools/root'); try { const v = fs.readFileSync(p, 'utf8').trim(); r = probe(v); tried.push(`${p} = ${v}${r === 'hit' || r === 'miss' ? '' : ' ' + r}`); if (r === 'hit') root = v; } catch (e) { tried.push(`${p} ${e.code === 'ENOENT' ? '<absent>' : e.code}`); } }
if (!root) { console.error(['agent-tools: 未找到仓库根', ...tried, '请在仓库目录运行 python3 install.py'].join('\n')); process.exit(2); }
// agent-tools bootstrap end

// OA 网关路由规则（url -> FSOF 接口方法）的查询、按模板新增与运行时探活。
// 所有控制台请求都在已登录的浏览器页面内发出（同源 fetch，Cookie 由浏览器管理，不导出）。
// 站点 --site cn|mx|id（国内、墨西哥、印尼）各有自己的控制台域名。
// prod：直连该站点控制台，新增可能触发审批；prj（仅 cn）：把国内控制台域名映射到项目环境控制台 IP，免审批直接保存。

const https = require('https');
const { createRequire } = require('module');
const { skillDir } = require(path.join(root, 'lib/agent_tools/locate.js'));
const SESSION_SCRIPTS = skillDir('get-browser-session', 'scripts');
const { acquireProfileLock, parseArgs, resolvePaths } = require(path.join(SESSION_SCRIPTS, 'browser_session'));
const { buildBrowserEnv, chromiumArgsFor } = require(path.join(SESSION_SCRIPTS, 'browser_network'));

// 三个站点的控制台接口路径与返回结构相同（2026-11-11 实测未登录时都返回 16051006），只有域名不同。
// probeDomain 是探活默认用的运行时域名（各站点米霍克规则的 domain 字段，2026-11-11 查询所得）；其他系统用 --domain 传该规则的 domain。
const SITES = {
  cn: { console: 'https://gateway.oa.fenqile.com', probeDomain: 'mihawk.oa.fenqile.com' },
  mx: { console: 'https://fk-gateway.oa.wowcredito.com', probeDomain: 'mihawk.oa.wowcredito.com' },
  id: { console: 'https://fk-gateway.oa.kredito.id', probeDomain: 'mihawk.oa.kredito.id' },
};
const SITE_ALIASES = {
  cn: 'cn', china: 'cn', '国内': 'cn', standard: 'cn',
  mx: 'mx', mexico: 'mx', '墨西哥': 'mx', wowcredito: 'mx',
  id: 'id', idn: 'id', indonesia: 'id', '印尼': 'id', kredito: 'id',
};

function resolveSite(value) {
  const key = SITE_ALIASES[String(value || 'cn').trim().toLowerCase()];
  if (!key) throw new Error(`--site 只支持 cn|mx|id（或 墨西哥/印尼 等别名），收到 ${value}`);
  return { key, ...SITES[key], consoleHost: new URL(SITES[key].console).host };
}
const RULE_API = '/rc_oa_gateway/application/url_interface_rule';
const NOT_LOGGED_IN = '16051006';
const NOT_ROUTED = '16051005';
// 从模板规则复制的字段；url/method 及显式覆盖项另行设置，其余（index、创建人、时间等）不复制。
const TEMPLATE_FIELDS = [
  'system_id', 'domain', 'protocol', 'interface_name', 'interface_version', 'interface_group', 'lsf_app_name',
  'method_time_out', 'check_auth', 'sensitive_interface', 'cloud_desktop_url', 'fallback_condition',
  'url_remove_null_value_and_empty_string', 'url_request_protocol', 'url_response_protocol',
];

function normalizeRuleUrl(raw) {
  let p = String(raw || '').trim().replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0].replace(/^\/+/, '');
  if (!p) throw new Error('url 不能为空');
  if (!p.startsWith('rc_oa_gateway/')) p = `rc_oa_gateway/${p}`;
  return `/${p}`;
}

function sameRuleUrl(a, b) {
  return normalizeRuleUrl(a) === normalizeRuleUrl(b);
}

function validateAddArgs(args, template) {
  const missing = ['template-url', 'url', 'method', 'url-manager'].filter((key) => !args[key] || args[key] === true);
  if (missing.length) throw new Error(`add 缺少参数：${missing.map((key) => `--${key}`).join('、')}`);
  if (args.timeout !== undefined && !/^[1-9]\d*$/.test(String(args.timeout))) throw new Error('--timeout 必须是正整数毫秒');
  if (args['check-auth'] !== undefined && !['0', '1'].includes(String(args['check-auth']))) throw new Error('--check-auth 只能是 0 或 1');
  // 换接口但不换应用时，lsf_app_name 会沿用模板而指错提供方。
  if (template && args.interface && args.interface !== template.interface_name && !args['lsf-app']) {
    throw new Error('--interface 与模板不同，需同时给 --lsf-app（提供该接口的应用名）');
  }
}

function buildPayload(template, options) {
  const payload = {};
  for (const key of TEMPLATE_FIELDS) {
    if (template[key] !== undefined && template[key] !== null) payload[key] = template[key];
  }
  Object.assign(payload, {
    url: normalizeRuleUrl(options.url),
    method: options.method,
    wsdl_url: '',
    func_desc: options.funcDesc || '',
    mask_and_fc_bean: { mask_list: [], encrypt_list: [] },
    url_manager: options.urlManager,
  });
  if (options.interfaceName) payload.interface_name = options.interfaceName;
  if (options.lsfApp) payload.lsf_app_name = options.lsfApp;
  if (options.timeout !== undefined) payload.method_time_out = Number(options.timeout);
  if (options.checkAuth !== undefined) payload.check_auth = Number(options.checkAuth);
  return payload;
}

// add_with_approval 第一次调用的返回：result_rows 为空或 need_approval=false 表示已直接保存；
// need_approval=true 表示什么都没保存，需要带 apply_reason 再调用一次才提交审批（与控制台前端一致）。
function approvalInfo(response) {
  const row = (response.result_rows && response.result_rows[0]) || {};
  return {
    needApproval: Boolean(row.need_approval),
    needApplyReason: Boolean(row.need_apply_reason),
    needOutNetReason: Boolean(row.need_out_net_reason),
  };
}

function classifyProbe(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return { routed: null, note: `非 JSON 响应：${String(body).slice(0, 120)}` }; }
  const retcode = String(parsed.retcode);
  if (retcode === NOT_ROUTED) return { routed: false, retcode, retmsg: parsed.retmsg };
  return { routed: true, retcode, retmsg: parsed.retmsg };
}

function checkRetcode(response, what) {
  if (String(response.retcode) === NOT_LOGGED_IN) {
    const error = new Error(`${what}：控制台返回未登录（16051006）`);
    error.code = 'LOGIN_REQUIRED';
    throw error;
  }
  if (String(response.retcode) !== '0') throw new Error(`${what}失败：retcode=${response.retcode} ${response.retmsg || ''}`);
  return response;
}

async function openConsole(args, env, site) {
  const CONSOLE = site.console;
  const paths = resolvePaths(args, CONSOLE);
  const release = await acquireProfileLock(paths.profileDir, { timeoutMs: 60000, pollMs: 200 });
  let context;
  try {
    const network = buildBrowserEnv(CONSOLE);
    network.env.LD_LIBRARY_PATH = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    const extra = env === 'prj' ? [`--host-resolver-rules=MAP ${site.consoleHost} ${consoleIp(args)}`] : [];
    const chromium = createRequire(paths.playwrightPackage)('playwright').chromium;
    context = await chromium.launchPersistentContext(paths.profileDir, {
      executablePath: paths.chromePath, headless: true, env: network.env,
      args: chromiumArgsFor(CONSOLE, ['--no-sandbox', ...extra]),
    });
    const page = context.pages()[0] || await context.newPage();
    // 打开控制台首页让 SSO 签发或续期网关登录 Cookie（rog_session）。
    await page.goto(`${CONSOLE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    const call = async (path, body, form = false) => JSON.parse(await page.evaluate(async ({ path, body, form }) => {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      });
      return response.text();
    }, { path, body, form }));
    return { call, close: async () => { try { await context.close(); } finally { release(); } } };
  } catch (error) {
    if (context) await context.close().catch(() => {});
    release();
    throw error;
  }
}

function consoleIp(args) {
  // 项目环境控制台地址不入库，来自 env/credentials.env（bin/with-env 载入）或 --console-ip
  const ip = args['console-ip'] || process.env.OA_GATEWAY_PRJ_CONSOLE_IP;
  if (!ip) throw new Error('项目环境需要 OA_GATEWAY_PRJ_CONSOLE_IP 或 --console-ip');
  return ip;
}

async function queryRules(call, filter) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const response = checkRetcode(await call(`${RULE_API}/query_page_list.json`, {
      page: String(page), limit: '50', system_id: '', url: filter.url || '',
      interface_name: filter.interfaceName || '', method: filter.method || '', lsf_app_name: '',
    }, true), '查询规则');
    rows.push(...(response.result_rows || []));
    if (page >= Number(response.total_page || 1)) break;
  }
  return filter.url ? rows.filter((row) => sameRuleUrl(row.url, filter.url)) : rows;
}

function pickRule(row) {
  const keys = ['url', 'domain', 'system_id', 'app_name', 'protocol', 'interface_name', 'method', 'interface_version',
    'lsf_app_name', 'method_time_out', 'check_auth', 'url_manager'];
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

function probeRuntime(domain, url, ip) {
  return new Promise((resolve) => {
    const request = https.request({
      host: ip || domain, servername: domain, port: 443, method: 'POST', path: url,
      headers: { Host: domain, 'Content-Length': 0 }, timeout: 20000,
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ via: ip || domain, httpStatus: response.statusCode, ...classifyProbe(body) }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ via: ip || domain, routed: null, note: error.message }));
    request.end();
  });
}

async function runAdd(call, args, env, site = 'cn') {
  validateAddArgs(args);
  const url = normalizeRuleUrl(args.url);
  const existing = await queryRules(call, { url });
  if (existing.length) return { outcome: 'exists', rule: pickRule(existing[0]) };
  const templates = await queryRules(call, { url: normalizeRuleUrl(args['template-url']) });
  if (templates.length !== 1) throw new Error(`模板规则 ${args['template-url']} 命中 ${templates.length} 条，需要恰好 1 条`);
  validateAddArgs(args, templates[0]);
  const payload = buildPayload(templates[0], {
    url, method: args.method, interfaceName: args.interface, lsfApp: args['lsf-app'], timeout: args.timeout,
    checkAuth: args['check-auth'], funcDesc: args['func-desc'], urlManager: args['url-manager'],
  });
  const result = { site, env, template: pickRule(templates[0]), payload };
  if (!args.apply) return { ...result, outcome: 'dry-run' };

  const addPath = `${RULE_API}/add_with_approval.json`;
  const first = approvalInfo(checkRetcode(await call(addPath, payload), '新增规则'));
  if (!first.needApproval) {
    const saved = await queryRules(call, { url });
    return { ...result, outcome: saved.length ? 'saved' : 'saved-not-found', rule: saved[0] ? pickRule(saved[0]) : null };
  }
  if (first.needApplyReason && !args['apply-reason']) {
    return { ...result, outcome: 'approval-required', approval: first, note: '未保存；补 --apply-reason 重跑以提交审批' };
  }
  checkRetcode(await call(addPath, { ...payload, apply_reason: args['apply-reason'] || '', out_net_reason: '' }), '提交审批');
  const persons = await call('/rc_oa_gateway/approval/flow/persons.json', { approval_type: 2 });
  const flow = persons.result_rows && persons.result_rows[0] ? persons.result_rows[0].process : null;
  return { ...result, outcome: 'approval-submitted', approval: first, approvalProcess: flow };
}

async function main() {
  const [action] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(3));
  const env = args.env || 'prod';
  if (!['prod', 'prj'].includes(env)) throw new Error('--env 只支持 prod 或 prj');
  if (!['query', 'add', 'probe'].includes(action)) {
    throw new Error('用法: oa_gateway_rule.js <query|add|probe> [--site cn|mx|id] --env prod|prj ...（见 SKILL.md）');
  }
  const site = resolveSite(args.site);
  if (env === 'prj' && site.key !== 'cn') throw new Error('项目环境（--env prj）只有国内站点有，--site mx|id 只支持 --env prod');
  if (action === 'probe') {
    const domain = args.domain || site.probeDomain;
    if (env === 'prj' && !args['probe-ip']) throw new Error('prj 探活需要 --probe-ip（项目环境网关机 IP）');
    console.log(JSON.stringify(await probeRuntime(domain, normalizeRuleUrl(args.url), args['probe-ip']), null, 2));
    return;
  }
  if (action === 'add') validateAddArgs(args);
  const session = await openConsole(args, env, site);
  try {
    let result;
    if (action === 'query') {
      const rows = await queryRules(session.call, {
        url: args.url ? normalizeRuleUrl(args.url) : '', interfaceName: args.interface, method: args.method,
      });
      result = { site: site.key, console: site.console, env, total: rows.length, rules: rows.map(pickRule) };
    } else {
      result = await runAdd(session.call, args, env, site.key);
    }
    if (env === 'prj') result.consoleIp = consoleIp(args);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await session.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.code ? `${error.code}: ${error.message}` : error.message);
    process.exit(1);
  });
}

module.exports = { SITES, approvalInfo, buildPayload, classifyProbe, consoleIp, normalizeRuleUrl, resolveSite, runAdd, sameRuleUrl, validateAddArgs };
