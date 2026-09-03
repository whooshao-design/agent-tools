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
const { chromium } = require(path.join(TOOL_DIR, 'node_modules/playwright-core'));
const CHROME_PATH = path.join(TOOL_DIR, 'browsers/chrome-linux64/chrome');
const RUNTIME_LIB_DIR = path.join(TOOL_DIR, 'runtime-libs/usr/lib/x86_64-linux-gnu');

const API = 'https://lexiao-api.oa.fenqile.com/oa/lexiao';
const ADD_URL = `${API}/add_hippo_publish_authorize.json`;
const LIST_URL = `${API}/get_hippo_publish_authorize_list.json`;
const DEFAULT_PROFILE = '/home/joney/.cache/lexiao-browser-profile';
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
  const rows = (res.json && res.json.result_rows) || [];
  return rows.map((r) => ({
    app: r.resource_id || r.resourceId,
    namespace: r.resource_instance || r.resourceInstance,
    type: r.resource_type || r.resourceType,
  }));
}

async function list(page, demandId) {
  return rowsOf(await call(page, 'GET', `${LIST_URL}?demand_id=${demandId}&limit=200`));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'list';
  const demandId = args['demand-id'];
  if (!demandId) throw new Error('缺少 --demand-id');
  const namespace = args.namespace || 'encryption';
  const instanceType = args['instance-type'] || '1';
  const resourceType = args['resource-type'] || 'hippo';

  const ctx = await openContext(args.profile || DEFAULT_PROFILE);
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(args['page-url'] || DEFAULT_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);

    const before = await list(page, demandId);
    if (command === 'list') {
      console.log(JSON.stringify({ command, demandId, count: before.length, rows: before }, null, 2));
      return;
    }
    if (command !== 'add') throw new Error(`未知命令: ${command}（支持 list / add）`);

    const apps = String(args.apps || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!apps.length) throw new Error('缺少 --apps=app1,app2');
    if (new Set(apps).size !== apps.length) throw new Error('--apps 存在重复项');

    // 只提交尚未登记的，避免重复写入
    const has = new Set(before.filter((r) => r.namespace === namespace).map((r) => r.app));
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
    const got = new Set(after.filter((r) => r.namespace === namespace).map((r) => r.app));
    const stillMissing = apps.filter((a) => !got.has(a));
    const verified = stillMissing.length === 0;

    console.log(JSON.stringify({
      command, demandId, namespace,
      postStatus: res.status,
      alreadyRegistered: apps.filter((a) => has.has(a)),
      attempted: missing,
      stillMissing,
      verified,
      totalRowsAfter: after.length,
      rowsAfter: after,
    }, null, 2));
    if (!verified) process.exit(1);
  } finally {
    await ctx.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
