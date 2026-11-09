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

const { createRequire } = require('module');
const { skillDir } = require(path.join(root, 'lib/agent_tools/locate.js'));
const SESSION_SCRIPTS = skillDir('get-browser-session', 'scripts');
const {
  launchReadOnlyContext, parseArgs, resolvePaths, waitForStableSession,
  DEFAULT_LOGIN_PATTERN, DEFAULT_PORTAL_PATTERN,
} = require(path.join(SESSION_SCRIPTS, 'browser_session'));
const { buildBrowserEnv, chromiumArgsFor } = require(path.join(SESSION_SCRIPTS, 'browser_network'));

const BASE_URLS = {
  pre: 'https://lxcloud.lexincloud.com',
  gray: 'https://lxcloud.lexincloud.com',
  prod: 'https://lxcloud.lexincloud.com',
  stable: 'https://stable-lxcloud.oa.fenqile.com',
};
const ALIASES = {
  pre: 'pre', '预发布': 'pre', gray: 'gray', '灰度': 'gray',
  prod: 'prod', online: 'prod', production: 'prod', '线上': 'prod', '生产': 'prod',
  stable: 'stable', test: 'stable', '测试': 'stable',
};
const PAGE_PATH = '/#/details_clickhouse/query_clickhouse';

function sanitize(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer <redacted>')
    .replace(/((?:password|token|cookie|authorization|oa_token_id|mid)\s*[=:]\s*)[^\s,;]+/gi, '$1<redacted>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>');
}

// Mask literals, quoted identifiers and comments before checking statement boundaries.
function sqlStructure(sql) {
  let result = '';
  for (let index = 0; index < sql.length;) {
    const char = sql[index];
    if (sql.startsWith('--', index) || char === '#') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end;
      result += ' ';
    } else if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) throw new Error('SQL 注释未闭合。');
      index = end + 2;
      result += ' ';
    } else if (['\'', '"', '`'].includes(char)) {
      let closed = false;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '\\') index += 2;
        else if (sql[index] === char && sql[index + 1] === char) index += 2;
        else if (sql[index++] === char) { closed = true; break; }
      }
      if (!closed) throw new Error('SQL 引号未闭合。');
      result += ' ';
    } else {
      result += char;
      index += 1;
    }
  }
  return result.trim();
}

function assertReadOnlySql(sql) {
  const structure = sqlStructure(String(sql || '')).replace(/;\s*$/, '').trim();
  if (!/^(SELECT|SHOW)\b/i.test(structure) || structure.includes(';')) {
    throw new Error('乐信云 HTTP 仅接受单条 SELECT/SHOW；查看表结构使用 SHOW CREATE TABLE。');
  }
  if (/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|RENAME|ATTACH|DETACH|GRANT|REVOKE|OPTIMIZE|KILL|INTO)\b/i.test(
    structure.replace(/^SHOW\s+CREATE\s+TABLE\b/i, 'SHOW TABLE')
  )) throw new Error('拒绝执行包含写入或管理操作的 SQL。');
}

function selectTransport(instance, requested) {
  if (requested && !['http', 'bastion_dba'].includes(requested)) throw new Error('通道仅支持 http 或 bastion_dba。');
  return requested || (instance === 'DecisionWaterHawkCK' ? 'bastion_dba' : 'http');
}

function queryOptions(args) {
  const env = ALIASES[String(args.env || '').toLowerCase()];
  if (!env) throw new Error('请显式指定 --env pre|gray|prod|stable。');
  const action = args.action || 'query';
  if (!['instances', 'databases', 'tables', 'query'].includes(action)) throw new Error('未知 --action。');
  const instance = args.instance || (env === 'stable' ? 'ABTestCK' : '');
  if (action !== 'instances' && (typeof instance !== 'string' || !instance.trim())) {
    throw new Error('缺少 --instance；先使用 --action instances 确认实例。');
  }
  if (env === 'stable' && instance !== 'ABTestCK') throw new Error('stable/测试流水使用 ABTestCK。');
  if (selectTransport(instance, args.transport) !== 'http') {
    throw new Error('本脚本仅执行 HTTP；DecisionWaterHawkCK 默认使用 bastion_dba MCP。用户显式指定 HTTP 或 DBA 通道不可用降级时传 --transport http。');
  }
  if (action === 'tables' && (typeof args.database !== 'string' || !args.database.trim())) {
    throw new Error('列出表需要 --database。');
  }
  if (args.query && args['sql-file']) throw new Error('--query 与 --sql-file 只能选择一个。');
  const sql = args['sql-file'] ? fs.readFileSync(args['sql-file'], 'utf8') : args.query;
  if (action === 'query') assertReadOnlySql(sql);
  else if (sql) throw new Error('SQL 仅适用于 --action query。');
  return { env, action, instance, database: args.database, sql, baseUrl: BASE_URLS[env] };
}

function buildRequest(options, userName) {
  if (!userName || typeof userName !== 'string') throw new Error('页面未提供登录用户，请用 get-browser-session 检查登录态。');
  if (options.action === 'instances') {
    return { path: `/v1/clickhouse/instance_list/?page=1&size=2000&user_name=${encodeURIComponent(userName)}`, method: 'GET' };
  }
  const body = { clickhouse_type: options.instance };
  const endpoint = { databases: 'showdatabases', tables: 'showtables', query: 'exec_query' }[options.action];
  if (options.action === 'tables') body.db_name = options.database;
  if (options.action === 'query') Object.assign(body, { user_name: userName, sql: options.sql });
  return { path: `/v1/clickhouse/sql_exec/${endpoint}`, method: 'POST', body };
}

function parseResponse(response, action) {
  const payload = response.body;
  if (response.status !== 200 || !payload || payload.code !== 200) {
    throw new Error(`HTTP ${response.status} / code ${payload?.code ?? 'missing'}: ${sanitize(payload?.error || payload?.message || '非 JSON 或接口失败')}`);
  }
  const data = payload.data;
  if (action === 'instances') {
    if (!Array.isArray(data?.results)) throw new Error('实例列表响应格式异常。');
    return {
      count: data.count, truncated: data.count > data.results.length,
      instances: data.results.map(row => ({ instance: row.ftype, description: row.ftype_memo })),
    };
  }
  if (data?.code !== 200 || (action === 'query' && data.query_code !== 0)) {
    throw new Error(`ClickHouse code ${data?.code ?? 'missing'} / query_code ${data?.query_code ?? 'missing'}: ${sanitize(data?.error || payload.error || '查询失败')}`);
  }
  if (action !== 'query') return data.data;
  if (!Array.isArray(data.data?.columns) || !Array.isArray(data.data?.data)) {
    throw new Error('查询响应缺少 columns/data，不能视为空结果。');
  }
  return { columns: data.data.columns, rows: data.data.data, rowCount: data.data.data.length, queryTime: data.query_time };
}

async function run(args) {
  const options = queryOptions(args); // Validate before opening any browser or making requests.
  const url = options.baseUrl + PAGE_PATH;
  const paths = resolvePaths(args, url);
  let context;
  try {
    const chromium = createRequire(paths.playwrightPackage)('playwright').chromium;
    const network = buildBrowserEnv(url);
    network.env.LD_LIBRARY_PATH = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    context = await launchReadOnlyContext(chromium, paths.profileDir, {
      executablePath: paths.chromePath, headless: true, env: network.env,
      args: chromiumArgsFor(url, ['--no-sandbox']),
    });
    const page = context.pages()[0] || await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const status = await waitForStableSession(page, {
      targetUrl: url, httpStatus: response?.status(), successText: '',
      loginPattern: DEFAULT_LOGIN_PATTERN, portalPattern: DEFAULT_PORTAL_PATTERN,
      forbiddenPattern: '403|Forbidden|无权限|拒绝访问', timeoutMs: 10000, pollMs: 500,
    });
    if (!status.sessionReady) throw new Error(`浏览器 session 不可用：${status.sessionState}；请通过 get-browser-session 检查 ${url}`);
    const userName = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('userInfo') || '[]')[0]?.min || ''; }
      catch { return ''; }
    });
    const request = buildRequest(options, userName);
    // Keep token and cookies inside the browser; never export credentials to the caller.
    const result = await page.evaluate(async (request) => {
      const headers = { 'Content-Type': 'application/json' };
      const token = localStorage.getItem('token');
      if (token) headers.Authorization = /^Bearer\s/i.test(token) ? token : `Bearer ${token}`;
      const response = await fetch(request.path, {
        method: request.method, headers, credentials: 'same-origin', redirect: 'error',
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        signal: AbortSignal.timeout(120000),
      });
      let body = null;
      try { body = await response.json(); } catch { /* Reject non-JSON without echoing a login page. */ }
      return { status: response.status, body };
    }, request);
    return {
      env: options.env, transport: 'lxcloud-http', endpoint: options.baseUrl + request.path.split('?')[0],
      instance: options.instance || undefined, sql: options.sql,
      ...parseResponse(result, options.action),
    };
  } finally {
    if (context) await context.close();
  }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node clickhouse_http.js --env pre|gray|prod|stable --action instances|databases|tables|query [--instance NAME] [--database DB] [--query SQL | --sql-file PATH] [--profile PATH] [--transport http]');
  } else {
    run(args).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
      console.error(JSON.stringify({ error: sanitize(error.message) }));
      process.exitCode = 1;
    });
  }
}

module.exports = { assertReadOnlySql, buildRequest, parseResponse, queryOptions, run, selectTransport };
