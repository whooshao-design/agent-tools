#!/usr/bin/env node
'use strict';
// Frontend 发布单 on publish3 (publish3.oa.fenqile.com, 应用发布 > 应用版本发布):
//   merge  : merge the requirement branch into the frontend release branch (default product) in a temp worktree and push
//   list   : read the creator's release orders
//   create : fill the 新建前端发布单 form via the real page and click 创建 (no 打包 / 推送)
//   pack   : click 打包 on an existing order and confirm the page dialogs (never 推送 / 一键发布 / 回滚 / 结单)
// Reads run as fetch(credentials: 'include') inside a logged-in publish3 page; cookies never leave the browser.
// Only frontend orders are supported; backend orders are to be added later.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');

const BROWSER_SESSION_DIR = '/home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts';
const { launchLockedContext, resolvePaths } = require(path.join(BROWSER_SESSION_DIR, 'browser_session.js'));
const { buildBrowserEnv, chromiumArgsFor } = require(path.join(BROWSER_SESSION_DIR, 'browser_network.js'));

const PUBLISH_HOME = 'https://publish3.oa.fenqile.com/';
// #/verPub cannot be opened directly (the SPA redirects to #/); enter through the menu from the plan list.
const ENTRY_PAGE = `${PUBLISH_HOME}#/pubPlan`;
const DETAIL_PAGE = (id) => `${PUBLISH_HOME}#/verPub/FrontPubDetail?id=${id}`;
const API_BASE = 'https://publish_server.oa.fenqile.com/';
const READY_TIMEOUT_MS = 60000;
const PACK_TIMEOUT_MS = 15 * 60 * 1000;
const ENV_VALUES = ['pre', 'gray', 'prod', 'oa', 'stable', 'daily', 'mini_set', 'yinni_prod', 'yindu_prod'];
const DEFAULT_ENVS = ['pre', 'gray', 'prod'];
const PUB_TYPES = { version: '版本', patch: '补丁' };
// Best-effort guard: non-GET requests whose path looks like push / roll back / close are aborted in every command.
// The real protection is that the script never clicks 一键发布 / 推送发布 / 回滚 / 结单.
const FORBIDDEN_REQUEST = /(push|rollback|roll_back|finish|close|onekey|autopublish)/i;

const USAGE = `Usage:
  node publish_order.js merge  --repo=<前端仓库> [--branch=<需求分支，默认当前分支>] [--target=product] [--dry-run]
  node publish_order.js list   [--app=<应用名>] [--creator=<OA用户名>]
  node publish_order.js create --app=<应用名> --desc=<发布版本描述> [--pub-type=version|patch] [--envs=pre,gray,prod]
                               [--branch=product] [--repo=<前端仓库> --feature=<需求分支>] [--allow-open] [--dry-run]
  node publish_order.js pack   --id=<发布单号> [--dry-run]

Common: [--project-type=frontend] (backend 暂不支持) [--profile <dir>]
create clicks 创建 only; pack clicks 打包 and its confirmations only. Nothing here pushes, releases, rolls back or closes an order.`;

class OrderError extends Error {}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) { args._.push(item); continue; }
    const eq = item.indexOf('=');
    if (eq > 2) { args[item.slice(2, eq)] = item.slice(eq + 1); continue; }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) { args[item.slice(2)] = next; index += 1; } else { args[item.slice(2)] = true; }
  }
  return args;
}

function text(value) {
  return value === undefined || value === true ? '' : String(value).trim();
}

// ---------- pure helpers ----------

function assertFrontend(projectType) {
  const type = text(projectType) || 'frontend';
  if (type !== 'frontend') throw new OrderError('后端发布单暂不支持，后续补充');
}

function parseEnvs(value) {
  const envs = (text(value) || DEFAULT_ENVS.join(',')).split(',').map((item) => item.trim()).filter(Boolean);
  const unknown = envs.filter((env) => !ENV_VALUES.includes(env));
  if (unknown.length) throw new OrderError(`unknown env: ${unknown.join(',')} (allowed: ${ENV_VALUES.join(',')})`);
  if (!envs.length) throw new OrderError('--envs is empty');
  return [...new Set(envs)];
}

function parsePubType(value) {
  const key = text(value) || 'version';
  if (!PUB_TYPES[key]) throw new OrderError(`--pub-type must be version or patch (版本 for new features, 补丁 for fixes/optimizations)`);
  return key;
}

function mergeMessage(branch, target) {
  return `Merge branch '${branch}' into ${target}`;
}

function isForbiddenRequest(url) {
  return FORBIDDEN_REQUEST.test(String(url).replace(/^https?:\/\/[^/]+/, ''));
}

// Compares the form state read from the page with what was requested; returns a list of mismatches.
function checkFormState(state, expected) {
  const issues = [];
  if (state.app !== expected.app) issues.push(`app=${state.app}`);
  if (!String(state.envType).includes('线上')) issues.push(`envType=${state.envType}`);
  if (!String(state.pubType).includes(PUB_TYPES[expected.pubType])) issues.push(`pubType=${state.pubType}`);
  if (state.branch !== expected.branch) issues.push(`branch=${state.branch}`);
  if (!/^\d+\.\d+\.\d+$/.test(String(state.tag || ''))) issues.push(`tag=${state.tag || '(empty)'}`);
  if ([...state.envs].sort().join(',') !== [...expected.envs].sort().join(',')) issues.push(`envs=${state.envs.join(',')}`);
  if (state.desc !== expected.desc) issues.push('desc differs');
  return issues;
}

function openOrders(rows, app) {
  return rows.filter((row) => row.appName === app && row.orderStatusValue === '未结单');
}

// ---------- git (merge) ----------

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function gitRetry(repo, args) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return git(repo, args); } catch (error) { last = error; }
  }
  throw new OrderError(`git ${args.join(' ')} failed: ${String(last.stderr || last.message).trim()}`);
}

function isAncestor(repo, ancestor, ref) {
  try { git(repo, ['merge-base', '--is-ancestor', ancestor, ref]); return true; } catch (_) { return false; }
}

function cmdMerge(args) {
  const repo = path.resolve(text(args.repo) || process.cwd());
  const target = text(args.target) || 'product';
  const branch = text(args.branch) || git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD' || branch === target) throw new OrderError(`invalid requirement branch: ${branch || '(detached)'}`);
  gitRetry(repo, ['fetch', '-q', 'origin', target, branch]);
  const local = git(repo, ['rev-parse', branch]);
  const remote = git(repo, ['rev-parse', `origin/${branch}`]);
  if (local !== remote) throw new OrderError(`${branch} differs from origin/${branch}; push or pull it first (local ${local.slice(0, 8)}, remote ${remote.slice(0, 8)})`);
  if (isAncestor(repo, `origin/${branch}`, `origin/${target}`)) {
    console.log(`${branch} is already merged into origin/${target} (${git(repo, ['rev-parse', '--short', `origin/${target}`])}); nothing to do.`);
    return;
  }
  const commits = git(repo, ['log', '--oneline', `origin/${target}..origin/${branch}`]);
  const files = git(repo, ['diff', '--name-only', `origin/${target}...origin/${branch}`]);
  console.log(`将合并 ${branch} -> ${target}，提交:\n${commits}\n改动文件:\n${files}`);
  if (args['dry-run']) { console.log('\n--dry-run: 未合并。'); return; }
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-order-merge-'));
  try {
    git(repo, ['worktree', 'add', '-q', '--detach', worktree, `origin/${target}`]);
    try {
      git(worktree, ['merge', '--no-ff', '-q', '-m', mergeMessage(branch, target), `origin/${branch}`]);
    } catch (error) {
      try { git(worktree, ['merge', '--abort']); } catch (_) { /* nothing to abort */ }
      throw new OrderError(`merge conflict between ${branch} and ${target}; resolve it on ${branch} (merge origin/${target} into it) and retry:\n${String(error.stdout || error.stderr || error.message).trim()}`);
    }
    const head = git(worktree, ['rev-parse', '--short', 'HEAD']);
    gitRetry(worktree, ['push', 'origin', `HEAD:${target}`]);
    console.log(`已合并并推送: ${mergeMessage(branch, target)} (${head})`);
  } finally {
    try { git(repo, ['worktree', 'remove', '--force', worktree]); } catch (_) { fs.rmSync(worktree, { recursive: true, force: true }); }
  }
}

// ---------- browser ----------

function loadPlaywright(paths) {
  if (!fs.existsSync(paths.playwrightPackage)) throw new OrderError(`Playwright tool dir not found: ${paths.toolDir}`);
  if (!fs.existsSync(paths.chromePath)) throw new OrderError(`Chrome not found: ${paths.chromePath}`);
  return createRequire(paths.playwrightPackage)('playwright').chromium;
}

async function withPage(args, fn) {
  const paths = resolvePaths(args, ENTRY_PAGE);
  const chromium = loadPlaywright(paths);
  const network = buildBrowserEnv(ENTRY_PAGE, { ...process.env });
  const env = { ...network.env, LD_LIBRARY_PATH: [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  const context = await launchLockedContext(chromium, paths.profileDir, {
    executablePath: paths.chromePath, headless: true, env, args: chromiumArgsFor(ENTRY_PAGE, ['--no-sandbox']), viewport: { width: 1700, height: 1300 },
  });
  try {
    await context.route('**/*', (route) => (isForbiddenRequest(route.request().url()) && route.request().method() !== 'GET'
      ? (console.error(`blocked request: ${route.request().url()}`), route.abort())
      : route.continue()));
    const page = await context.newPage();
    // publish3 drops connections intermittently; retry navigation.
    for (let attempt = 0; ; attempt += 1) {
      try { await page.goto(ENTRY_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 }); break; } catch (error) { if (attempt >= 2) throw error; }
    }
    await page.getByText('应用发布', { exact: true }).first().waitFor({ timeout: READY_TIMEOUT_MS });
    return await fn(page);
  } finally {
    await context.close().catch(() => {});
  }
}

async function postForm(page, apiPath, body) {
  const raw = await page.evaluate(async ({ url, data }) => (await fetch(url, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: data,
  })).text(), { url: API_BASE + apiPath, data: new URLSearchParams(body).toString() });
  const json = JSON.parse(raw);
  if (Number(json.status) !== 0) throw new OrderError(`${apiPath} failed: ${json.message || raw.slice(0, 200)}`);
  return json.data;
}

async function listOrders(page, { app = '', creator = '' } = {}) {
  const data = await postForm(page, 'publishOrder/list', {
    pageSize: 20, appName: app, begTime: '', endTime: '', creator, orderStatus: '', searchEnv: '', blur: 'true', pageNum: 1,
  });
  return data.list || [];
}

async function currentUser(page) {
  const raw = await page.evaluate(async (url) => (await fetch(url, { method: 'POST', credentials: 'include' })).text(), `${API_BASE}loginInfo/currentUser`);
  const match = String(JSON.parse(raw).data || '').match(/\(([^)]+)\)/);
  return match ? match[1] : '';
}

function printOrders(rows) {
  console.log('单号\t应用\t分支\ttag\t环境\t状态\t创建时间\t描述');
  for (const row of rows) {
    console.log(`${row.id}\t${row.appName}\t${row.branch}\t${row.versionTag}\t${row.envList}\t${row.orderStatusValue}\t${row.createTime}\t${row.desc}`);
  }
}

async function openNewOrderForm(page) {
  await page.getByText('应用发布', { exact: true }).first().click();
  await page.getByText('应用版本发布', { exact: true }).first().click();
  await page.getByText('新建发布单', { exact: true }).first().waitFor({ timeout: READY_TIMEOUT_MS });
  await page.getByText('新建发布单', { exact: true }).first().click();
  await page.getByText('选择应用', { exact: true }).first().waitFor({ timeout: READY_TIMEOUT_MS });
}

async function readFormState(page) {
  return page.evaluate(() => {
    const item = (label) => Array.from(document.querySelectorAll('.el-form-item'))
      .find((f) => ((f.querySelector('.el-form-item__label') || {}).innerText || '').includes(label));
    const value = (label) => { const f = item(label); return f ? Array.from(f.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea')).map((i) => i.value).filter(Boolean).join('|') : ''; };
    const active = (label) => { const f = item(label); return f ? Array.from(f.querySelectorAll('.is-checked, .is-active')).map((e) => e.innerText.trim()).filter(Boolean).join(',') : ''; };
    return {
      app: value('应用名称'), envType: active('发布环境类型'), pubType: active('发布类型'), branch: value('发布分支'), tag: value('版本 tag'),
      envs: Array.from(document.querySelectorAll('.el-checkbox-group input[type=checkbox]')).filter((i) => i.checked).map((i) => i.value),
      desc: value('发布版本描述'),
    };
  });
}

async function fillNewOrder(page, order) {
  await openNewOrderForm(page);
  await page.getByText('选择应用', { exact: true }).first().click();
  let dialog = page.locator('.el-dialog__wrapper:visible').last();
  const search = dialog.locator('input').first();
  await search.fill(order.app);
  await search.press('Enter');
  const appRow = dialog.locator('tbody tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${order.app}$`) }) }).first();
  await appRow.waitFor({ timeout: 20000 });
  await appRow.click(); // the dialog closes on row click
  await page.waitForTimeout(2500);
  await page.locator('.el-radio, .el-radio-button').filter({ hasText: /^\s*线上\s*$/ }).first().click();
  await page.waitForTimeout(2500);
  await page.locator('.el-radio, .el-radio-button').filter({ hasText: new RegExp(`^\\s*${PUB_TYPES[order.pubType]}\\s*$`) }).first().click();
  await page.getByText('选择分支', { exact: true }).first().click();
  dialog = page.locator('.el-dialog__wrapper:visible').last();
  const branchRow = dialog.locator('tbody tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${order.branch}$`) }) }).first();
  await branchRow.waitFor({ timeout: 20000 });
  await branchRow.click();
  for (const env of ENV_VALUES) {
    const label = page.locator(`label.el-checkbox:has(input[value="${env}"])`).first();
    if (!(await label.count())) continue;
    const checked = ((await label.getAttribute('class')) || '').includes('is-checked');
    if (checked !== order.envs.includes(env)) await label.locator('.el-checkbox__input').click();
  }
  await page.locator('textarea[placeholder="请输入内容"]').fill(order.desc);
  // The version tag is generated asynchronously (tagLog/preGenerate) after the branch is picked.
  for (let waited = 0; waited < 20000; waited += 1000) {
    if (/^\d+\.\d+\.\d+$/.test((await readFormState(page)).tag)) break;
    await page.waitForTimeout(1000);
  }
  return readFormState(page);
}

async function cmdList(args) {
  await withPage(args, async (page) => {
    const creator = text(args.creator) || await currentUser(page);
    printOrders(await listOrders(page, { app: text(args.app), creator }));
  });
}

async function cmdCreate(args) {
  const order = {
    app: text(args.app), desc: text(args.desc), pubType: parsePubType(args['pub-type']), envs: parseEnvs(args.envs), branch: text(args.branch) || 'product',
  };
  if (!order.app) throw new OrderError('--app is required');
  if (!order.desc) throw new OrderError('--desc is required');
  const repo = text(args.repo);
  const feature = text(args.feature);
  if (repo && feature) {
    gitRetry(path.resolve(repo), ['fetch', '-q', 'origin', order.branch, feature]);
    if (!isAncestor(path.resolve(repo), `origin/${feature}`, `origin/${order.branch}`)) {
      throw new OrderError(`origin/${feature} is not merged into origin/${order.branch}; run merge first`);
    }
    console.log(`已确认 ${feature} 已合入 origin/${order.branch}`);
  }
  await withPage(args, async (page) => {
    const creator = await currentUser(page);
    const open = openOrders(await listOrders(page, { app: order.app, creator }), order.app);
    if (open.length && !args['allow-open']) {
      printOrders(open);
      throw new OrderError(`${order.app} already has 未结单 orders above; finish or close them first, or pass --allow-open after confirming with the user`);
    }
    const state = await fillNewOrder(page, order);
    console.log(`表单: ${JSON.stringify(state)}`);
    const issues = checkFormState(state, order);
    if (issues.length) throw new OrderError(`form state does not match, not creating: ${issues.join('; ')}`);
    if (args['dry-run']) { console.log('--dry-run: 未点击创建。'); return; }
    const created = page.waitForResponse((r) => /publishOrder\/add/i.test(r.url()) && r.request().method() === 'POST', { timeout: 30000 });
    await page.getByRole('button', { name: /^创\s*建$/ }).click();
    const response = await created;
    const body = await response.json();
    if (Number(body.status) !== 0 || !body.data) throw new OrderError(`create failed: ${JSON.stringify(body).slice(0, 300)}`);
    const row = (await listOrders(page, { app: order.app, creator })).find((item) => Number(item.id) === Number(body.data));
    console.log(`已创建发布单 ${body.data}: ${DETAIL_PAGE(body.data)}`);
    if (row) printOrders([row]);
  });
}

async function cmdPack(args) {
  const id = text(args.id);
  if (!/^\d+$/.test(id)) throw new OrderError('--id must be a release order number');
  await withPage(args, async (page) => {
    const creator = await currentUser(page);
    const row = (await listOrders(page, { creator })).find((item) => String(item.id) === id);
    if (!row) throw new OrderError(`order ${id} not found among ${creator}'s recent orders`);
    if (row.orderStatusValue !== '未结单') throw new OrderError(`order ${id} is ${row.orderStatusValue}; only 未结单 orders can be packed`);
    printOrders([row]);
    await page.goto(DETAIL_PAGE(id), { waitUntil: 'domcontentloaded', timeout: 60000 });
    // The button reads 打包 before packing and 已打包 afterwards.
    const anyPack = page.locator('button').filter({ hasText: /^\s*(打\s*包|已\s*打\s*包)\s*$/ }).first();
    await anyPack.waitFor({ timeout: READY_TIMEOUT_MS });
    const status = await page.evaluate(() => (document.body.innerText.match(/文件状态：\s*([^\n]+)/) || [])[1] || '');
    console.log(`文件状态: ${status}`);
    if (/已\s*打\s*包/.test(await anyPack.innerText())) { console.log(`发布单 ${id} 已打包，未重复打包。`); return; }
    const packButton = anyPack;
    if (args['dry-run']) { console.log('--dry-run: 未点击打包。'); return; }
    await packButton.click();
    // 打包确认: "确定执行打包？本次打包操作将打包当前发布单的所有已选择环境包"
    await page.locator('.el-message-box__btns button', { hasText: /确\s*定/ }).click({ timeout: 20000 });
    // Wait for the 打包成功 prompt, then the 更新文件 dialog; confirm both with 确定.
    const success = page.getByText(/打包成功|内容审核通过/).first();
    await success.waitFor({ timeout: PACK_TIMEOUT_MS });
    console.log(`打包结果: ${(await success.innerText()).trim()}`);
    for (let step = 0; step < 2; step += 1) {
      const ok = page.locator('.el-dialog__wrapper:visible button, .el-message-box__btns button').filter({ hasText: /^\s*确\s*定\s*$/ }).last();
      if (!(await ok.count())) break;
      await ok.click();
      await page.waitForTimeout(2000);
    }
    const after = await page.evaluate(() => (document.body.innerText.match(/文件状态：\s*([^\n]+)/) || [])[1] || '');
    console.log(`打包后文件状态: ${after}`);
    if (/冲突/.test(after)) console.log('文件状态提示冲突：点“查看详情”，按提示联系对应同事结单后再继续。');
    console.log('未推送任何环境；推送预发布 / 灰度 / 线上由用户操作。');
  });
}

const COMMANDS = { merge: cmdMerge, list: cmdList, create: cmdCreate, pack: cmdPack };

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || args.help) { console.log(USAGE); return command || args.help ? 0 : 1; }
  if (!COMMANDS[command]) throw new OrderError(`unknown command: ${command}\n\n${USAGE}`);
  assertFrontend(args['project-type']);
  await COMMANDS[command](args);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_ENVS, assertFrontend, checkFormState, isForbiddenRequest, mergeMessage, openOrders, parseArgs, parseEnvs, parsePubType,
};
