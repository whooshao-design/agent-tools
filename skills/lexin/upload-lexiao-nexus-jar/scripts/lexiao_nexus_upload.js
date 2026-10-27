#!/usr/bin/env node
/**
 * 乐效「包管理」上传 jar 到 Nexus：查包、建上传单、点上传并轮询结果。
 *
 * 复用浏览器 profile 的登录态，在页面上下文内 fetch(credentials:'include')，
 * 全程不经手、不落盘原始 Cookie。上传动作没有验证过的直调接口，沿用详情页「上传」按钮。
 */
const path = require('path');
const { launchLockedContext } = require('../../get-browser-session/scripts/browser_session');

const TOOL_DIR = '/home/joney/tools/lexiao-browser';
const CHROME_PATH = path.join(TOOL_DIR, 'browsers/chrome-linux64/chrome');
const RUNTIME_LIB_DIR = path.join(TOOL_DIR, 'runtime-libs/usr/lib/x86_64-linux-gnu');

const API = 'https://lexiao-api.oa.fenqile.com/oa';
const URLS = {
  infoList: `${API}/publish/nexus_info_list.json`,
  deployList: `${API}/publish/nexus_deploy_list.json`,
  deployAdd: `${API}/publish/nexus_deploy_add.json`,
  deployDetail: `${API}/publish/nexus_deploy_get_detail.json`,
  branches: `${API}/publish/gitlab_list_branch_by_jar.json`,
  demand: `${API}/lexiao/get_demand_detail.json`,
};
const DEFAULT_PROFILE = '/home/joney/.local/state/agent-tools/browser-profiles/main';
const HOME_PAGE = 'https://lexiao.oa.fenqile.com/';
const COMMANDS = ['list', 'history', 'create', 'upload', 'status'];
const DONE_STATUS = new Set(['DEPLOYED']);
const RUNNING_STATUS = new Set(['DEPLOY_INIT', 'DEPLOYING']);

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    const m = /^--([^=]+)=?(.*)$/.exec(item);
    if (m) args[m[1]] = m[2] === '' ? true : m[2];
  }
  return args;
}

function positiveInt(value, name) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`--${name} 必须是正整数`);
  }
  return Number(value);
}

function text(value, name) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new Error(`缺少 --${name}`);
  return v;
}

function parseRequest(argv) {
  const args = parseArgs(argv);
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list';
  if (!COMMANDS.includes(command)) throw new Error(`未知命令: ${command}（支持 ${COMMANDS.join(' / ')}）`);
  const req = { args, command, apply: args.apply === true };
  if (command === 'list') req.nameLike = text(args['name-like'], 'name-like');
  if (command === 'history') req.jarId = args['jar-id'] ? positiveInt(args['jar-id'], 'jar-id') : null;
  if (command === 'create') {
    req.jarId = positiveInt(args['jar-id'], 'jar-id');
    req.nameLike = text(args['name-like'], 'name-like');
    req.branch = text(args.branch, 'branch');
    req.demandId = positiveInt(args['demand-id'], 'demand-id');
    req.remark = text(args.remark, 'remark');
    req.versionType = args['version-type'] || 'snapshot';
    if (!['snapshot', 'release'].includes(req.versionType)) throw new Error('--version-type 只支持 snapshot / release');
  }
  if (command === 'upload') {
    req.deployId = positiveInt(args['deploy-id'], 'deploy-id');
    req.jarId = positiveInt(args['jar-id'], 'jar-id');
    req.noWait = args['no-wait'] === true;
  }
  if (command === 'status') {
    const ids = typeof args['deploy-id'] === 'string' ? args['deploy-id'].split(',').map((v) => v.trim()) : [];
    if (!ids.length) throw new Error('缺少 --deploy-id（多个用逗号分隔）');
    req.deployIds = ids.map((v) => positiveInt(v, 'deploy-id'));
    req.wait = args.wait === true;
  }
  if (command === 'upload' || command === 'status') req.timeoutSec = args.timeout ? positiveInt(args.timeout, 'timeout') : 1200;
  return req;
}

async function openContext(profile) {
  const { chromium } = require(path.join(TOOL_DIR, 'node_modules/playwright-core'));
  const ldLibraryPath = [RUNTIME_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return launchLockedContext(chromium, profile, {
    executablePath: CHROME_PATH,
    headless: true,
    env: { ...process.env, LD_LIBRARY_PATH: ldLibraryPath },
    args: ['--no-sandbox'],
  });
}

// 页面上下文内发请求；完整读取响应再解析，截断会切断 JSON
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

function rowsOf(res, what) {
  if (res.status < 200 || res.status >= 300 || !res.json ||
      (res.json.retcode !== undefined && String(res.json.retcode) !== '0') ||
      !Array.isArray(res.json.result_rows)) {
    const msg = res.json && res.json.retmsg ? `：${res.json.retmsg}` : '';
    throw new Error(`${what}失败或响应结构异常（HTTP ${res.status}${msg}）；检查登录态和接口结果，不要按空结果继续`);
  }
  return res.json.result_rows;
}

function brief(info) {
  return {
    jarId: info.id, name: info.name, groupId: info.group_id, artifactId: info.artifact_id,
    pomPath: info.pom_path, type: info.type, owner: info.owner, manager: info.manager, gitAddr: info.git_addr,
  };
}

function briefDeploy(d) {
  return {
    deployId: d.id, jarId: d.jar_id, jarName: d.jar_name, version: d.jar_version, versionType: d.jar_version_type,
    branch: d.branch, demandId: d.demand_id, status: d.deploy_status, statusDesc: d.deploy_status_desc,
    message: d.deploy_message, crState: d.cr_state_desc, pipeline: d.pipeline_task_id,
    createTime: d.create_time ? new Date(d.create_time).toISOString() : null,
  };
}

async function listInfo(page, nameLike, maxPages = 10) {
  const rows = [];
  for (let p = 1; p <= maxPages; p += 1) {
    const body = { nameLike, username: '', limit: 10, page: p, bizLine: '', groupId: '', artifactId: '', type: '' };
    const got = rowsOf(await call(page, 'POST', URLS.infoList, body), '包信息查询');
    rows.push(...got);
    if (got.length < 10) return rows;
  }
  throw new Error(`包信息超过 ${maxPages * 10} 条，请把 --name-like 写得更具体`);
}

/** 新建上传单的请求体，与页面「新建上传单 → 创建」发出的 nexus_deploy_add.json 一致；版本号由服务端从 pom 读取 */
function buildAddBody(info, req) {
  return {
    jar_id: info.id,
    jar_name: info.name,
    jar_type: info.type,
    jar_version: '',
    jar_version_type: req.versionType,
    remark: req.remark,
    direct_approver: '',
    safe_approver: '',
    approvers: '',
    branch: req.branch,
    demand_id: req.demandId,
    git_addr: info.git_addr,
  };
}

async function detail(page, deployId) {
  const rows = rowsOf(await call(page, 'GET', `${URLS.deployDetail}?deployId=${deployId}`), '上传单查询');
  if (!rows.length) throw new Error(`上传单 ${deployId} 不存在`);
  return rows[0];
}

async function create(page, req) {
  const info = (await listInfo(page, req.nameLike)).find((r) => r.id === req.jarId);
  if (!info) throw new Error(`按 --name-like=${req.nameLike} 没查到 jar_id=${req.jarId}；先用 list 核对`);
  const branches = rowsOf(await call(page, 'POST', URLS.branches, { jar_id: req.jarId }), '分支查询');
  const branch = branches.find((b) => b.name === req.branch);
  if (!branch) throw new Error(`仓库里没有分支 ${req.branch}；先推送分支`);
  const demands = rowsOf(await call(page, 'POST', URLS.demand, { branch_name: req.branch }), '需求查询');
  const demand = demands[0] ? { id: demands[0].id, name: demands[0].name } : null;
  const body = buildAddBody(info, req);
  const plan = {
    jar: brief(info),
    branchHead: branch.commit ? branch.commit.id : null,
    demandOfBranch: demand,
    demandIdMatches: demand ? String(demand.id) === String(req.demandId) : null,
    body,
  };
  if (!req.apply) return { command: 'create', applied: false, plan, note: '预览，未提交；确认后加 --apply' };
  const res = await call(page, 'POST', URLS.deployAdd, body);
  const ids = rowsOf(res, '新建上传单');
  const deployId = ids[0];
  if (!Number.isSafeInteger(deployId)) throw new Error(`新建上传单返回异常：${res.text.slice(0, 300)}`);
  // 回读：接口返回成功不代表落库
  const d = briefDeploy(await detail(page, deployId));
  const verified = d.jarId === req.jarId && d.branch === req.branch && String(d.demandId) === String(req.demandId);
  if (!verified) throw new Error(`上传单 ${deployId} 回读字段与请求不一致：${JSON.stringify(d)}`);
  return { command: 'create', applied: true, plan, deploy: d, verified };
}

/** 轮询多张上传单，直到都不在待上传/上传中或超时；超时仍在运行的单保持原状态返回 */
async function waitAll(page, deployIds, timeoutSec, sleep) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const all = [];
    for (const id of deployIds) all.push(briefDeploy(await detail(page, id)));
    if (all.every((d) => !RUNNING_STATUS.has(d.status)) || Date.now() > deadline) return all;
    await sleep(20000);
  }
}

async function upload(page, req) {
  const before = briefDeploy(await detail(page, req.deployId));
  if (before.jarId !== req.jarId) throw new Error(`上传单 ${req.deployId} 属于 jar_id=${before.jarId}，不是 ${req.jarId}`);
  if (DONE_STATUS.has(before.status)) return { command: 'upload', clicked: false, before, after: before };
  if (before.status !== 'DEPLOY_INIT') {
    throw new Error(`上传单当前状态 ${before.status}（${before.statusDesc}），不是待上传；用 status 查看，不要重复点上传`);
  }
  await page.goto(`https://lexiao.oa.fenqile.com/#/upload-jar/${req.deployId}/${req.jarId}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  const button = page.getByRole('button', { name: /^上\s*传$/ });
  if (await button.count() !== 1) throw new Error('详情页没有唯一的「上传」按钮，停止');
  if (await button.isDisabled()) throw new Error('「上传」按钮不可用，停止');
  await button.click();
  await page.waitForTimeout(1500);
  const box = page.locator('.el-message-box:visible');
  if (await box.count()) await box.getByRole('button', { name: /确\s*定/ }).click();
  await page.waitForTimeout(3000);
  if (req.noWait) {
    // 只确认上传已触发就释放浏览器 profile，供同一层的其他上传单并行；结果用 status --wait 统一轮询
    const after = briefDeploy(await detail(page, req.deployId));
    return { command: 'upload', clicked: true, before, after, waited: false, success: after.status !== 'DEPLOY_INIT' };
  }
  const [after] = await waitAll(page, [req.deployId], req.timeoutSec, (ms) => page.waitForTimeout(ms));
  return { command: 'upload', clicked: true, before, after, waited: true, success: DONE_STATUS.has(after.status) };
}

async function main(argv = process.argv.slice(2), openBrowser = openContext) {
  const req = parseRequest(argv);
  const ctx = await openBrowser(req.args.profile || DEFAULT_PROFILE);
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(HOME_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    let out;
    if (req.command === 'list') {
      out = { command: 'list', rows: (await listInfo(page, req.nameLike)).map(brief) };
    } else if (req.command === 'history') {
      const body = { page: 1, limit: 10, jarName: '', jarVersion: '', begTime: '', endTime: '',
        creator: req.args.creator || '', isCr: '', blur: false, jar_id: req.jarId || '', artifact_id: '', group_id: '' };
      out = { command: 'history', rows: rowsOf(await call(page, 'POST', URLS.deployList, body), '上传记录查询').map(briefDeploy) };
    } else if (req.command === 'create') {
      out = await create(page, req);
    } else if (req.command === 'status') {
      const deploys = req.wait
        ? await waitAll(page, req.deployIds, req.timeoutSec, (ms) => page.waitForTimeout(ms))
        : await Promise.all(req.deployIds.map(async (id) => briefDeploy(await detail(page, id))));
      out = { command: 'status', allDone: deploys.every((d) => DONE_STATUS.has(d.status)), deploys };
    } else {
      out = await upload(page, req);
    }
    console.log(JSON.stringify(out, null, 2));
    if (out.command === 'upload' && out.clicked && !out.success) throw new Error(`上传未成功：${out.after.statusDesc} ${out.after.message || ''}`);
    if (out.command === 'status' && req.wait && !out.allDone) throw new Error('有上传单未成功或仍在上传，见上方 deploys');
  } finally {
    await ctx.close().catch(() => {});
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { parseRequest, rowsOf, buildAddBody, briefDeploy, main };
