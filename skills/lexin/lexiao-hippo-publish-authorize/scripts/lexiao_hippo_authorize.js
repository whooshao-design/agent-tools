#!/usr/bin/env node
/**
 * 乐效「hippo 发布授权」登记：在版本/需求里标记哪些应用的 hippo namespace 需要随版本发布。
 *
 * 复用浏览器 profile 的登录态，在页面上下文内 fetch(credentials:'include')，
 * 全程不经手、不落盘原始 Cookie。
 */
const path = require('path');
const fs = require('fs');

const TOOL_DIR = '/home/joney/tools/lexiao-browser';
const CHROME_PATH = path.join(TOOL_DIR, 'browsers/chrome-linux64/chrome');
const RUNTIME_LIB_DIR = path.join(TOOL_DIR, 'runtime-libs/usr/lib/x86_64-linux-gnu');

const API = 'https://lexiao-api.oa.fenqile.com/oa/lexiao';
const ADD_URL = `${API}/add_hippo_publish_authorize.json`;
const LIST_URL = `${API}/get_hippo_publish_authorize_list.json`;
const DEFAULT_PROFILE = '/home/joney/.local/state/agent-tools/browser-profiles/main';
const DEFAULT_PAGE = 'https://lexiao.oa.fenqile.com/';

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    const m = /^--([^=]+)=?(.*)$/.exec(item);
    if (m) args[m[1]] = m[2] === '' ? true : m[2];
  }
  return args;
}

async function openContext(profile) {
  const { chromium } = require(path.join(TOOL_DIR, 'node_modules/playwright-core'));
  const ldLibraryPath = [RUNTIME_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return chromium.launchPersistentContext(profile, {
    executablePath: CHROME_PATH,
    headless: true,
    env: { ...process.env, LD_LIBRARY_PATH: ldLibraryPath },
    args: ['--no-sandbox'],
  });
}

// 页面上下文内发请求；响应完整返回，不截断（截断会切断 JSON 导致误判）
async function call(page, method, url, body) {
  const out = await page.evaluate(async ({ method, url, body }) => {
    const opt = { method, credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } };
    if (body) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const resp = await fetch(url, opt);
    return { status: resp.status, text: await resp.text() };
  }, { method, url, body });
  let json = null;
  try { json = JSON.parse(out.text); } catch (e) { /* 保留原文供排查 */ }
  return { status: out.status, json, text: out.text };
}

function rowsOf(res) {
  if (res.status < 200 || res.status >= 300 || !res.json ||
      (res.json.retcode !== undefined && String(res.json.retcode) !== '0') ||
      !Array.isArray(res.json.result_rows)) {
    throw new Error(`登记查询失败或响应结构异常（HTTP ${res.status}）；禁止按空集合写入，请检查登录态和接口结果`);
  }
  const rows = res.json.result_rows;
  // 此接口仅验证过 limit 参数；满页时不能证明全集，禁止猜测分页参数后写入。
  if (rows.length >= 200) throw new Error('登记查询达到 200 条上限，无法证明集合完整；请核对分页契约后继续');
  if (rows.some((r) => !r || !(r.resource_id || r.resourceId) ||
      !(r.resource_instance || r.resourceInstance) || !(r.resource_type || r.resourceType))) {
    throw new Error('登记行缺少应用、namespace 或类型；禁止按不完整集合写入');
  }
  return rows.map((r) => ({
    app: r.resource_id || r.resourceId,
    namespace: r.resource_instance || r.resourceInstance,
    type: r.resource_type || r.resourceType,
  }));
}

async function list(page, demandId) {
  return rowsOf(await call(page, 'GET', `${LIST_URL}?demand_id=${demandId}&limit=200`));
}

function parseRequest(argv) {
  const args = parseArgs(argv);
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list';
  if (!['list', 'add'].includes(command)) throw new Error(`未知命令: ${command}（支持 list / add）`);
  const demandId = args['demand-id'];
  if (typeof demandId !== 'string' || !/^[1-9]\d*$/.test(demandId) || !Number.isSafeInteger(Number(demandId))) {
    throw new Error('--demand-id 必须是正安全整数');
  }
  const namespace = typeof args.namespace === 'string' ? args.namespace.trim() : '';
  const instanceType = args['instance-type'] || '1';
  const resourceType = args['resource-type'] || 'hippo';
  if (instanceType !== '1' || resourceType !== 'hippo') throw new Error('仅支持 instance-type=1、resource-type=hippo');
  const apps = typeof args.apps === 'string' ? args.apps.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (command === 'add') {
    if (!namespace) throw new Error('add 必须显式提供 --namespace；不推断本次登记范围');
    if (!apps.length) throw new Error('缺少 --apps=app1,app2');
    if (new Set(apps).size !== apps.length) throw new Error('--apps 存在重复项');
  }
  return { args, command, demandId, namespace, instanceType, resourceType, apps };
}

async function main(argv = process.argv.slice(2), openBrowser = openContext) {
  const { args, command, demandId, namespace, instanceType, resourceType, apps } = parseRequest(argv);

  const ctx = await openBrowser(args.profile || DEFAULT_PROFILE);
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(args['page-url'] || DEFAULT_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);

    const before = await list(page, demandId);
    if (command === 'list') {
      console.log(JSON.stringify({ command, demandId, count: before.length, rows: before }, null, 2));
      return;
    }
    // 只提交尚未登记的，避免重复写入
    const has = new Set(before.filter((r) => r.namespace === namespace && r.type === resourceType).map((r) => r.app));
    const missing = apps.filter((a) => !has.has(a));
    if (!missing.length) {
      console.log(JSON.stringify({ command, demandId, namespace, added: [], alreadyRegistered: apps, verified: true }, null, 2));
      return;
    }

    const body = {
      app_namespace_list: missing.map((a) => ({
        demand_id: Number(demandId),
        resource_id: a,
        resource_name: a,
        resource_instance: namespace,
        instance_type: instanceType,
        resource_type: resourceType,
      })),
    };
    const res = await call(page, 'POST', ADD_URL, body);

    // 回读校验：POST 返回 200 不代表落库，必须做集合比对
    const after = await list(page, demandId);
    const got = new Set(after.filter((r) => r.namespace === namespace && r.type === resourceType).map((r) => r.app));
    const stillMissing = apps.filter((a) => !got.has(a));
    const postSucceeded = res.status >= 200 && res.status < 300 &&
      res.json !== null && typeof res.json === 'object' && !Array.isArray(res.json) &&
      (res.json.retcode === undefined || String(res.json.retcode) === '0');
    const verified = postSucceeded && stillMissing.length === 0;

    console.log(JSON.stringify({
      command, demandId, namespace,
      postStatus: res.status,
      postSucceeded,
      alreadyRegistered: apps.filter((a) => has.has(a)),
      attempted: missing,
      stillMissing,
      verified,
      totalRowsAfter: after.length,
      rowsAfter: after,
    }, null, 2));
    if (!verified) throw new Error('登记未验证成功；停止并核对，不自动重试写入');
  } finally {
    await ctx.close().catch(() => {});
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { parseRequest, rowsOf, main };
