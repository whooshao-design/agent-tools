#!/usr/bin/env node
'use strict';
// Create and modify 普通应用发布 plans on publish3 (publish3.oa.fenqile.com) for 乐效 requirements.
// Reads go through fetch(credentials: 'include') inside a logged-in publish3 page; cookies never leave the browser and
// are never printed or written to disk. Writes fill the real page form and click 保存 / 修改 + 确定, so the page builds
// the payload itself. Only frontend plans are supported. Never clicks 发布申请 / 删除 and never creates 发布单.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const BROWSER_SESSION_DIR = '/home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts';
const { launchLockedContext, resolvePaths } = require(path.join(BROWSER_SESSION_DIR, 'browser_session.js'));
const { buildBrowserEnv, chromiumArgsFor } = require(path.join(BROWSER_SESSION_DIR, 'browser_network.js'));

const PUBLISH_HOST = 'publish3.oa.fenqile.com';
const PUBLISH_HOME = `https://${PUBLISH_HOST}/`;
const NEW_PAGE = `${PUBLISH_HOME}#/pubPlan/newPubPlan/NORMAL`;
const LIST_PAGE = `${PUBLISH_HOME}#/pubPlan`;
const MODIFY_PAGE = (id) => `${PUBLISH_HOME}#/pubPlan/pubPlanModify/${id}`;
const API_BASE = 'https://publish_server.oa.fenqile.com/';
const API = {
  list: 'publishPlan/list',
  detail: 'publishPlan/getPublishPlanDetailList',
  currentUser: 'loginInfo/currentUser',
};
// publish_server endpoints the read-only paths may call; any other publishPlan/* request is aborted unless the
// command is in an explicit write step. Endpoints that look like delete/apply are always aborted.
const READ_PLAN_PATHS = new Set(['publishPlan/list', 'publishPlan/get', 'publishPlan/getPublishPlanDetailList']);
const ALWAYS_BLOCKED = /(delete|remove|apply|approve|submit)/i;
// Page loads are slow: wait for a concrete element instead of a fixed sleep.
const READY_TIMEOUT_MS = 45000;
const TZ = 'Asia/Shanghai';
// A plan is valid from 00:00 of its online day until 06:00 of the next day.
const VALID_WINDOW_MS = 30 * 3600 * 1000;
const NOTIFY = {
  none: '无需通知',
  diy: 'diy',
  risk: '风控政策：涉及到授信、还款、账单、订单业务逻辑的修改',
  oracle: 'oracle凭证测试：需要增加或修改Oracle接口数据包',
  report: 'OA报表检查：需要增加或修改主数据',
};
// Backend release items do not belong in a frontend plan (Hippo, backend app names, SQL/DDL, database changes).
const BACKEND_TERMS = [
  /hippo/i,
  /namespace/i,
  /\bserver[_-][A-Za-z0-9_-]+/i,
  /\bSQL\b/i,
  /\bDDL\b/i,
  /\b(ALTER|CREATE|DROP)\s+TABLE\b/i,
  /数据库/,
  /建表|加字段|刷数/,
];
const HISTORY_DEFAULT_LIMIT = 10;
const LIST_PAGE_SIZE = 50;
const LIST_MAX_PAGES = 20;
const MODIFY_FIELDS = new Set(['description', 'notify']);

const USAGE = `Usage:
  node publish_plan.js history [--creator=<OA用户名>] [--limit=N]
  node publish_plan.js options [--biz=<业务名>]
  node publish_plan.js show    --id=<计划ID>
  node publish_plan.js create  --file=<plan.json> [--dry-run] [--allow-backend-terms] [--screenshot-dir=<dir>]
  node publish_plan.js modify  --id=<计划ID> --file=<patch.json> [--dry-run] [--allow-backend-terms] [--screenshot-dir=<dir>]

Common: [--profile <dir>] (default: get-browser-session main profile)
Only frontend plans. create refuses when the requirement already has a plan that is pending approval or still valid.
modify only changes description/notify of a plan that is 待审批 and still shows 修改 in the list.
Saving puts the plan into 待审批; this script never clicks 发布申请 or 删除.`;

class PlanError extends Error {}

function loadPlaywright(paths) {
  if (!fs.existsSync(paths.playwrightPackage)) throw new PlanError(`Playwright tool dir not found: ${paths.toolDir}`);
  if (!fs.existsSync(paths.chromePath)) throw new PlanError(`Chrome not found: ${paths.chromePath}`);
  return createRequire(paths.playwrightPackage)('playwright').chromium;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const eq = item.indexOf('=');
    if (eq > 2) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[item.slice(2)] = next;
      index += 1;
    } else {
      args[item.slice(2)] = true;
    }
  }
  return args;
}

function argText(value) {
  return value === undefined || value === true ? '' : String(value).trim();
}

// ---------- pure helpers ----------

function formatDate(ms) {
  if (ms === null || ms === undefined || ms === '') return '-';
  const date = new Date(typeof ms === 'number' ? ms : Date.parse(ms));
  if (Number.isNaN(date.getTime())) return String(ms);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Milliseconds of 00:00 Asia/Shanghai (UTC+8, no DST) on YYYY-MM-DD.
function dayStartMs(day) {
  return Date.parse(`${day}T00:00:00+08:00`);
}

function descriptionText(value) {
  if (Array.isArray(value)) return value.map((line) => String(line)).join('\n').replace(/\s+$/, '');
  return value === undefined || value === null ? '' : String(value).replace(/\s+$/, '');
}

function lintDescription(text, projectType) {
  if (projectType !== 'frontend') return [];
  const hits = [];
  for (const pattern of BACKEND_TERMS) {
    const match = String(text).match(pattern);
    if (match) hits.push(match[0]);
  }
  return hits;
}

function assertLint(text, projectType, allow) {
  const hits = lintDescription(text, projectType);
  if (!hits.length) return;
  const message = `frontend plan description mentions backend items: ${hits.join(', ')}. `
    + 'Backend release items (Hippo, backend apps, configs, database) belong in the backend plan; '
    + 'keep at most one sentence such as "本版本需先于/后于后端发布".';
  if (!allow) throw new PlanError(`${message} Pass --allow-backend-terms only after the user confirms they are frontend content.`);
  console.warn(`WARNING (--allow-backend-terms): ${message}`);
}

function normalizeNotify(value, label = 'notify') {
  const text = String(value || '').trim();
  if (NOTIFY[text]) return NOTIFY[text];
  if (Object.values(NOTIFY).includes(text)) return text;
  throw new PlanError(`${label} must be one of ${Object.keys(NOTIFY).join('/')}`);
}

function normalizeDemandIds(value) {
  const list = (Array.isArray(value) ? value : String(value || '').split(','))
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (!list.length) throw new PlanError('demandIds is required');
  for (const id of list) if (!/^\d+$/.test(id)) throw new PlanError(`demandIds must be TAPD story ids: ${id}`);
  return [...new Set(list)];
}

function requiredText(raw, field) {
  const text = String(raw[field] === undefined || raw[field] === null ? '' : raw[field]).trim();
  if (!text) throw new PlanError(`${field} is required`);
  return text;
}

function validatePlan(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PlanError('plan file must contain a JSON object');
  const projectType = String(raw.projectType || '').trim().toLowerCase();
  if (projectType === 'backend') throw new PlanError('后端计划暂不支持，后续补充 (projectType=backend)');
  if (projectType !== 'frontend') throw new PlanError('projectType must be frontend');
  if (raw.crossTeam !== undefined && raw.crossTeam !== false) {
    throw new PlanError('crossTeam=true (跨团队项目) is not supported; only 业务线内项目');
  }
  if (raw.env !== undefined && !['prod', '线上'].includes(String(raw.env))) throw new PlanError('env must be prod (线上)');
  const onlineDate = requiredText(raw, 'onlineDate');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(onlineDate) || formatDate(dayStartMs(onlineDate)) !== onlineDate) {
    throw new PlanError(`onlineDate must be YYYY-MM-DD: ${onlineDate}`);
  }
  if (dayStartMs(onlineDate) + VALID_WINDOW_MS <= now) throw new PlanError(`onlineDate ${onlineDate} is already past`);
  const description = descriptionText(raw.description);
  if (!description.trim()) throw new PlanError('description is required');
  if (!Array.isArray(raw.apps) || !raw.apps.length) throw new PlanError('apps must be a non-empty array of app names');
  const apps = raw.apps.map((name) => String(name).trim());
  if (apps.some((name) => !name)) throw new PlanError('apps contains an empty name');
  if (new Set(apps).size !== apps.length) throw new PlanError('apps contains duplicates');
  return {
    biz: requiredText(raw, 'biz'),
    projectType,
    demandIds: normalizeDemandIds(raw.demandIds),
    onlineDate,
    test: requiredText(raw, 'test'),
    leader: requiredText(raw, 'leader'),
    director: requiredText(raw, 'director'),
    notify: normalizeNotify(raw.notify),
    description,
    apps,
  };
}

function validatePatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PlanError('patch file must contain a JSON object');
  const unknown = Object.keys(raw).filter((key) => !MODIFY_FIELDS.has(key));
  if (unknown.length) throw new PlanError(`modify only supports description/notify; unsupported: ${unknown.join(', ')}`);
  const patch = {};
  if (raw.description !== undefined) {
    patch.description = descriptionText(raw.description);
    if (!patch.description.trim()) throw new PlanError('description must not be empty');
  }
  if (raw.notify !== undefined) patch.notify = normalizeNotify(raw.notify);
  if (!Object.keys(patch).length) throw new PlanError('patch must change description or notify');
  return patch;
}

// A plan blocks a new one for the same requirement while it is valid, or pending/approved and not yet expired.
function findBlockingPlans(rows, demandIds, now = Date.now()) {
  const wanted = new Set(demandIds.map(String));
  return rows.filter((row) => {
    const ids = String(row.demandIds || '').split(',').map((item) => item.trim()).filter(Boolean);
    if (!ids.some((id) => wanted.has(id))) return false;
    if (row.validity === true) return true;
    const status = String(row.planApproveStatus || '');
    const online = Number(row.planOnlineTime);
    return ['WAIT', 'APPROVED'].includes(status) && (!Number.isFinite(online) || now < online + VALID_WINDOW_MS);
  });
}

function parseCurrentUser(data) {
  const text = String(data || '');
  const match = text.match(/\(([^)]+)\)\s*$/);
  return (match ? match[1] : text).trim();
}

function firstLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
}

function formatHistory(rows) {
  const lines = ['id\t创建时间\t上线日期\t需求\tbizLine\tapprovers\t通知\t状态\tvalidity\t应用\t需求名称'];
  for (const row of rows) {
    lines.push([
      row.id, row.createTime || '-', formatDate(row.planOnlineTime), row.demandIds || '-', row.bizLine || '-',
      row.approvers || '-', row.planNotify || '-', row.planApproveStatusDesc || row.planApproveStatus || '-',
      row.validity, (row.apps || []).join(',') || '-', firstLine(row.planName),
    ].join('\t'));
  }
  return lines.join('\n');
}

function formatPlan(row, details) {
  return [
    `计划ID: ${row.id}`,
    `需求名称: ${firstLine(row.planName)}`,
    `需求ID: ${row.demandIds || '-'}    需求链接: ${firstLine(row.planLink) || '-'}`,
    `bizLine: ${row.bizLine || '-'}    跨团队: ${row.crossTeam}    发布类型: ${row.typeDesc || row.type || '-'}    环境: ${(row.envValues || []).join(',') || row.envList || '-'}`,
    `上线日期: ${formatDate(row.planOnlineTime)}    validity: ${row.validity}`,
    `approvers: ${row.approvers || '-'}（首位为空表示抄送测试选了“无需测试”）`,
    `通知提醒: ${row.planNotify || '-'}`,
    `状态: ${row.planApproveStatusDesc || row.planApproveStatus || '-'}    version: ${row.version}    创建: ${row.creator} ${row.createTime}    修改: ${row.modifier} ${row.modifyTime}`,
    '版本描述:',
    String(row.planDesc || '').split('\n').map((line) => `  | ${line}`).join('\n'),
    '应用明细（发布顺序）:',
    'appId\tappName\tappType\tappDegree\tgitAddr',
    ...details.map((item) => `${item.appId}\t${item.appName}\t${item.appType}\t${item.appDegree}\t${item.gitAddr || '-'}`),
  ].join('\n');
}

function formatForm(model, apps) {
  return [
    `业务名(bizLine): ${model.bizLine || '-'}    跨团队: ${model.crossTeam}    项目类型: ${model.projectType}`,
    `需求ID: ${model.demandIds || '-'}`,
    `需求名称: ${firstLine(model.planName) || '-'}`,
    `需求链接: ${firstLine(model.planLink) || '-'}`,
    `上线日期: ${formatDate(model.planOnlineTime)}    发布类型: ${model.type}    环境: ${model.envList}`,
    `抄送测试: ${model.test_approver || '-'}    leader: ${model.direct_approver || '-'}    抄送总监: ${model.chief_approver || '-'}`,
    `通知提醒: ${model.planNotify || '-'}`,
    '版本描述:',
    String(model.planDesc || '').split('\n').map((line) => `  | ${line}`).join('\n'),
    '应用发布顺序列表:',
    ...apps.map((row, index) => `  ${index + 1}. ${row.join('\t')}`),
  ].join('\n');
}

function defaultScreenshotDir() {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()).replace(/-/g, '');
  return path.join('/tmp/agent-work', `${day}-publish-plan`);
}

function readJsonFile(file) {
  if (!file || file === true) throw new PlanError('--file is required');
  const text = fs.readFileSync(path.resolve(String(file)), 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PlanError(`file is not valid JSON: ${error.message}`);
  }
}

// ---------- browser ----------

async function openBrowser(paths, chromium, guard) {
  const network = buildBrowserEnv(PUBLISH_HOME, { ...process.env });
  const env = { ...network.env, LD_LIBRARY_PATH: [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  const context = await launchLockedContext(chromium, paths.profileDir, {
    executablePath: paths.chromePath,
    headless: true,
    env,
    viewport: { width: 1440, height: 900 },
    args: chromiumArgsFor(PUBLISH_HOME, ['--no-sandbox']),
  });
  try {
    // Abort any publish_server write unless the command explicitly opened a write step.
    await context.route(`${API_BASE}**`, (route) => {
      const url = new URL(route.request().url());
      const apiPath = url.pathname.replace(/^\/+/, '');
      const isPlanWrite = apiPath.startsWith('publishPlan/') && !READ_PLAN_PATHS.has(apiPath);
      if (ALWAYS_BLOCKED.test(apiPath) || (isPlanWrite && !guard.allowWrite)) {
        guard.blocked.push(apiPath);
        return route.abort();
      }
      return route.continue();
    });
    const page = context.pages()[0] || await context.newPage();
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function gotoPage(page, url) {
  // The OA network drops connections intermittently (net::ERR_CONNECTION_CLOSED); navigation is safe to retry.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      break;
    } catch (error) {
      if (attempt >= 3 || !/net::ERR_/.test(String(error && error.message))) throw error;
      await page.waitForTimeout(3000 * attempt);
    }
  }
  const host = new URL(page.url()).hostname;
  if (host !== PUBLISH_HOST) {
    throw new PlanError(`publish3 login required (landed on ${host}); run get-browser-session ensure_session with url=${PUBLISH_HOME}`);
  }
}

async function postForm(page, apiPath, params) {
  const body = new URLSearchParams(params).toString();
  const call = () => page.evaluate(async ({ target, payload }) => {
    const response = await fetch(target, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json, text/plain, */*' },
      body: payload,
    });
    return { status: response.status, text: await response.text() };
  }, { target: API_BASE + apiPath, payload: body });
  let result;
  try {
    result = await call();
  } catch (error) {
    // Only read endpoints go through here; retry once when the SPA navigated or the connection dropped mid-request.
    if (!/Failed to fetch|Execution context was destroyed/.test(String(error && error.message))) throw error;
    await page.waitForTimeout(2000);
    result = await call();
  }
  let json;
  try {
    json = JSON.parse(result.text);
  } catch (_) {
    throw new PlanError(`non-JSON response (HTTP ${result.status}) from ${apiPath}; the session may have expired -- `
      + `run get-browser-session ensure_session with url=${PUBLISH_HOME}`);
  }
  if (Number(json.status) !== 0) throw new PlanError(`${apiPath} failed (HTTP ${result.status}): ${json.message || JSON.stringify(json).slice(0, 200)}`);
  return json.data;
}

async function currentUser(page) {
  return parseCurrentUser(await postForm(page, API.currentUser, {}));
}

async function listPlans(page, filter, { maxRows = LIST_PAGE_SIZE * LIST_MAX_PAGES } = {}) {
  const rows = [];
  const pageSize = Math.min(LIST_PAGE_SIZE, maxRows);
  for (let pageNum = 1; pageNum <= LIST_MAX_PAGES; pageNum += 1) {
    const data = await postForm(page, API.list, {
      id: filter.id || '', planName: filter.planName || '', planApproveStatus: '', creator: filter.creator || '',
      planType: '', pageSize, pageNum,
    });
    const batch = (data && Array.isArray(data.list)) ? data.list : [];
    rows.push(...batch);
    if (rows.length >= maxRows || batch.length < pageSize || (data && data.isLastPage)) return rows.slice(0, maxRows);
  }
  return rows;
}

async function getPlan(page, id) {
  const rows = await listPlans(page, { id }, { maxRows: LIST_PAGE_SIZE });
  const row = rows.find((item) => String(item.id) === String(id));
  if (!row) throw new PlanError(`plan ${id} not found`);
  return row;
}

async function getDetails(page, id) {
  const data = await postForm(page, API.detail, { id });
  return Array.isArray(data) ? data : [];
}

function formItem(page, label) {
  return page.locator('.el-form-item').filter({ has: page.locator('.el-form-item__label', { hasText: label }) }).first();
}

// Waits up to 45s for `ready`; the SPA occasionally stalls on first load, so reload once before giving up.
async function waitReady(page, ready, label) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.waitForFunction(ready, null, { timeout: READY_TIMEOUT_MS });
      return;
    } catch (_) {
      if (attempt === 2) throw new PlanError(`publish3 ${label} did not load within 45s (after one reload)`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    }
  }
}

async function waitForNewForm(page) {
  await waitReady(page,
    () => [...document.querySelectorAll('.el-form-item__label')].some((node) => node.textContent.includes('业务名')),
    'new-plan form');
}

async function readModel(page) {
  return page.evaluate(() => {
    const form = document.querySelector('.el-form');
    const vm = form && form.__vue__;
    return vm && vm.model ? JSON.parse(JSON.stringify(vm.model)) : null;
  });
}

async function readAppTable(page) {
  return page.evaluate(() => {
    const table = [...document.querySelectorAll('.el-table')].find((node) => node.textContent.includes('应用发布顺序列表'));
    if (!table) return [];
    return [...table.querySelectorAll('.el-table__body-wrapper tbody tr')]
      .map((tr) => [...tr.querySelectorAll('td')].slice(0, 5).map((td) => td.textContent.trim()))
      .filter((cells) => cells.some(Boolean));
  });
}

async function visibleMessages(page) {
  return page.evaluate(() => [...document.querySelectorAll('.el-message, .el-notification, .el-form-item__error')]
    .filter((node) => node.offsetParent !== null && node.textContent.trim())
    .map((node) => node.textContent.replace(/\s+/g, ' ').trim()));
}

// Opens an el-select inside a form item and clicks the option whose text equals `text`.
async function chooseOption(page, label, text) {
  await formItem(page, label).locator('input.el-input__inner').first().click();
  const option = page.locator('.el-select-dropdown:visible .el-select-dropdown__item:visible')
    .filter({ hasText: new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).first();
  try {
    await option.waitFor({ timeout: 10000 });
  } catch (_) {
    const choices = await page.locator('.el-select-dropdown:visible .el-select-dropdown__item:visible').allTextContents();
    await page.keyboard.press('Escape').catch(() => {});
    throw new PlanError(`${label}: option "${text}" not found; choices: ${choices.map((item) => item.trim()).join(', ') || '(none)'}`);
  }
  await option.click();
  await page.waitForTimeout(500);
}

async function selectOptions(page, label) {
  const texts = await formItem(page, label).locator('.el-select-dropdown__item').allTextContents();
  return texts.map((item) => item.trim()).filter(Boolean);
}

async function clickNotify(page, value) {
  const radio = formItem(page, '通知提醒').locator('label.el-radio').filter({ has: page.locator(`input[value="${value}"]`) }).first();
  if (!await radio.count()) throw new PlanError(`通知提醒 has no option ${value}`);
  await radio.click();
}

async function pollModel(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let model = await readModel(page);
  while (!predicate(model) && Date.now() < deadline) {
    await page.waitForTimeout(500);
    model = await readModel(page);
  }
  return model;
}

async function addApp(page, appName, index) {
  if (index > 0) {
    // New rows are inserted from the last row's 插入行; untested with more than one app, the table check below guards order.
    await page.locator('.el-table__body-wrapper tbody tr').last().getByText('插入行').click();
    await page.waitForTimeout(500);
  }
  await page.locator('.el-table__body-wrapper tbody tr').nth(index).getByText('选择应用').click();
  const dialog = page.locator('.el-dialog__wrapper:visible').filter({ hasText: '选择应用' }).last();
  await dialog.waitFor({ timeout: 20000 });
  const search = dialog.locator('input[placeholder="应用名称"]').first();
  await search.fill(appName);
  const searched = page.waitForResponse((res) => res.url().includes('/application/list')
    && (res.request().postData() || '').includes(`name=${encodeURIComponent(appName)}`), { timeout: 30000 }).catch(() => null);
  await search.press('Enter');
  await searched;
  await page.waitForTimeout(800);
  const cell = dialog.locator('.el-table__body-wrapper tbody tr td:first-child')
    .filter({ hasText: new RegExp(`^\\s*${appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).first();
  if (!await cell.count()) {
    const names = await dialog.locator('.el-table__body-wrapper tbody tr td:first-child').allTextContents();
    throw new PlanError(`app ${appName} not found (exact match); search returned: ${names.map((item) => item.trim()).join(', ') || '(none)'}`);
  }
  await cell.click();
  await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
}

async function screenshot(page, args, name) {
  const dir = argText(args['screenshot-dir']) || defaultScreenshotDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function confirmSave(page, buttonText, responseMatcher) {
  const button = page.locator('button:visible').filter({ hasText: new RegExp(`^\\s*${buttonText}\\s*$`) }).first();
  if (!await button.count()) throw new PlanError(`button ${buttonText} not found`);
  await button.click();
  const box = page.locator('.el-message-box__wrapper:visible').filter({ hasText: '确认保存发布计划' }).first();
  try {
    await box.waitFor({ timeout: 10000 });
  } catch (_) {
    throw new PlanError(`no confirm dialog after clicking ${buttonText}; form errors: ${(await visibleMessages(page)).join(' | ') || '(none)'}`);
  }
  const responsePromise = page.waitForResponse(responseMatcher, { timeout: 60000 });
  await box.locator('.el-message-box__btns button').filter({ hasText: '确定' }).first().click();
  const response = await responsePromise;
  let json = null;
  try {
    json = JSON.parse(await response.text());
  } catch (_) { /* reported below */ }
  if (!json || Number(json.status) !== 0) {
    throw new PlanError(`${new URL(response.url()).pathname} failed (HTTP ${response.status()}): ${json ? json.message : 'non-JSON response'}`);
  }
  await page.waitForFunction(() => /#\/pubPlan\/?(\?|$)/.test(window.location.hash), null, { timeout: 30000 }).catch(() => {});
  return json;
}

// ---------- commands ----------

async function cmdHistory(page, args) {
  await gotoPage(page, LIST_PAGE);
  const creator = argText(args.creator) || await currentUser(page);
  const limit = Math.max(1, Math.min(100, Number(argText(args.limit)) || HISTORY_DEFAULT_LIMIT));
  const rows = await listPlans(page, { creator }, { maxRows: limit });
  for (const row of rows) row.apps = (await getDetails(page, row.id)).map((item) => item.appName);
  console.log(`creator=${creator} 最近 ${rows.length} 个发布计划:`);
  console.log(formatHistory(rows));
}

async function cmdOptions(page, args) {
  await gotoPage(page, NEW_PAGE);
  await waitForNewForm(page);
  await page.waitForTimeout(1000);
  const biz = argText(args.biz);
  if (!biz) {
    console.log(`业务名可选项:\n${(await selectOptions(page, '业务名')).join('\n')}`);
    return;
  }
  await chooseOption(page, '业务名', biz);
  const model = await pollModel(page, (m) => m && m.bizLine, 10000);
  await page.waitForTimeout(1000);
  console.log(`业务名: ${biz} -> bizLine: ${(model && model.bizLine) || '-'}`);
  for (const label of ['抄送测试', 'leader审批', '抄送总监']) {
    console.log(`${label}: ${JSON.stringify(await selectOptions(page, label))}`);
  }
  console.log(`页面默认: leader=${model.direct_approver || '-'} 抄送总监=${model.chief_approver || '-'}`);
  console.log(`通知提醒(notify): ${Object.entries(NOTIFY).map(([key, value]) => `${key}=${value}`).join(' ; ')}`);
}

async function cmdShow(page, args) {
  const id = argText(args.id);
  if (!/^\d+$/.test(id)) throw new PlanError('--id=<计划ID> is required');
  await gotoPage(page, LIST_PAGE);
  console.log(formatPlan(await getPlan(page, id), await getDetails(page, id)));
}

async function fillNewPlan(page, plan) {
  await gotoPage(page, NEW_PAGE);
  await waitForNewForm(page);
  await page.waitForTimeout(1000);
  await formItem(page, '项目类型').locator('label.el-radio').filter({ hasText: '前端' }).first().click();
  await chooseOption(page, '业务名', plan.biz);
  let model = await pollModel(page, (m) => m && m.bizLine, 10000);
  if (!model.bizLine) throw new PlanError(`业务名 ${plan.biz} did not set bizLine`);

  const demand = formItem(page, '需求ID').locator('input').first();
  await demand.fill(plan.demandIds.join(','));
  await demand.press('Tab');
  model = await pollModel(page, (m) => m && m.planName, 20000);
  const demandMessages = await visibleMessages(page);
  if (!model.planName) throw new PlanError(`需求ID ${plan.demandIds.join(',')} did not fill 需求名称 from TAPD`);

  const date = formItem(page, '上线时间').locator('input').first();
  await date.fill(plan.onlineDate);
  await date.press('Enter');
  // publishWindow/getPublishType decides the release type for the date; outside the normal window the page switches to
  // 紧急发布 (extra 紧急原因类型 / 总监审批 / 抄送GM fields), which this skill does not support.
  await page.waitForTimeout(2500);
  if (await formItem(page, '紧急原因类型').count()) {
    throw new PlanError(`上线日期 ${plan.onlineDate} 不在正常发布窗口，页面切换为紧急发布（出现“紧急原因类型”“总监审批”“抄送GM”）；`
      + '本 skill 只支持正常发布，请换日期或由用户在页面上按紧急发布流程处理');
  }

  await chooseOption(page, '抄送测试', plan.test);
  await chooseOption(page, 'leader审批', plan.leader);
  await chooseOption(page, '抄送总监', plan.director);
  await clickNotify(page, plan.notify);
  await formItem(page, '版本描述').locator('textarea').first().fill(plan.description);
  for (let index = 0; index < plan.apps.length; index += 1) await addApp(page, plan.apps[index], index);
  await page.waitForTimeout(800);
  return { model: await readModel(page), apps: await readAppTable(page), demandMessages };
}

function checkFilledForm(plan, model, apps) {
  const problems = [];
  if (formatDate(model.planOnlineTime) !== plan.onlineDate) problems.push(`上线日期=${formatDate(model.planOnlineTime)}`);
  if (model.test_approver !== plan.test) problems.push(`抄送测试=${model.test_approver}`);
  if (model.direct_approver !== plan.leader) problems.push(`leader=${model.direct_approver}`);
  if (model.chief_approver !== plan.director) problems.push(`抄送总监=${model.chief_approver}`);
  if (model.planNotify !== plan.notify) problems.push(`通知提醒=${model.planNotify}`);
  if (descriptionText(model.planDesc) !== plan.description) problems.push('版本描述与文件不一致');
  if (model.projectType !== 'frontend') problems.push(`项目类型=${model.projectType}`);
  const names = apps.map((row) => row[1]);
  if (names.join(',') !== plan.apps.join(',')) problems.push(`应用顺序=${names.join(',') || '(空)'}`);
  if (problems.length) throw new PlanError(`form does not match the plan file: ${problems.join('; ')}`);
}

async function cmdCreate(page, args, guard) {
  const plan = args.plan;
  const dryRun = Boolean(args['dry-run']);
  await gotoPage(page, LIST_PAGE);
  const user = await currentUser(page);
  const mine = await listPlans(page, { creator: user });
  let blocking = findBlockingPlans(mine, plan.demandIds);
  if (blocking.length) {
    throw new PlanError(`requirement ${plan.demandIds.join(',')} already has plan(s) ${blocking.map((row) => `${row.id}(${row.planApproveStatusDesc}, 上线 ${formatDate(row.planOnlineTime)})`).join(', ')}; `
      + 'use modify instead of creating a duplicate');
  }

  const { model, apps, demandMessages } = await fillNewPlan(page, plan);
  // Plans created by other people for the same requirement show up under the TAPD name.
  const sameName = await listPlans(page, { planName: firstLine(model.planName) }, { maxRows: LIST_PAGE_SIZE * 2 });
  blocking = findBlockingPlans(sameName, plan.demandIds);
  if (blocking.length) {
    throw new PlanError(`requirement ${plan.demandIds.join(',')} already has plan(s) ${blocking.map((row) => `${row.id}(${row.creator}, ${row.planApproveStatusDesc})`).join(', ')}; use modify instead`);
  }
  checkFilledForm(plan, model, apps);
  console.log(`表单内容（操作人 ${user}）:`);
  console.log(formatForm(model, apps));
  if (demandMessages.length) console.log(`页面提示: ${demandMessages.join(' | ')}`);
  console.log(`截图: ${await screenshot(page, args, 'create')}`);
  console.log('注意: 保存后计划进入“待审批”；本脚本不点“发布申请”，不建发布单。');
  if (dryRun) {
    console.log('--dry-run: 未保存。');
    return;
  }

  guard.allowWrite = true;
  const json = await confirmSave(page, '保存', (res) => res.url().includes('/publishPlan/add') && res.request().method() === 'POST');
  guard.allowWrite = false;
  const id = String(json.data);
  console.log(`已保存，计划ID ${id}`);
  const row = await getPlan(page, id);
  const details = await getDetails(page, id);
  console.log(formatPlan(row, details));
  const problems = [];
  if (String(row.demandIds) !== plan.demandIds.join(',')) problems.push(`demandIds=${row.demandIds}`);
  if (descriptionText(row.planDesc) !== plan.description) problems.push('版本描述不一致');
  if (row.planNotify !== plan.notify) problems.push(`planNotify=${row.planNotify}`);
  if (formatDate(row.planOnlineTime) !== plan.onlineDate) problems.push(`上线日期=${formatDate(row.planOnlineTime)}`);
  if (details.map((item) => item.appName).join(',') !== plan.apps.join(',')) problems.push(`应用=${details.map((item) => item.appName).join(',')}`);
  if (problems.length) throw new PlanError(`re-read mismatch for plan ${id}: ${problems.join('; ')}`);
  console.log(`回读校验通过: 计划 ${id} ${row.planApproveStatusDesc}`);
}

async function rowHasModifyButton(page, id) {
  await gotoPage(page, LIST_PAGE);
  const idInput = page.locator('input[placeholder="计划ID"]').first();
  await idInput.waitFor({ timeout: READY_TIMEOUT_MS });
  await idInput.fill(String(id));
  const listed = page.waitForResponse((res) => res.url().includes('/publishPlan/list')
    && (res.request().postData() || '').includes(`id=${id}`), { timeout: 30000 }).catch(() => null);
  await idInput.press('Enter');
  if (!await listed) {
    const search = page.locator('button:visible').filter({ hasText: /查询|搜索/ }).first();
    if (await search.count()) await search.click();
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(1000);
  const actions = await page.evaluate((planId) => {
    const row = [...document.querySelectorAll('.el-table__body-wrapper tbody tr')]
      .find((tr) => (tr.querySelector('td') || {}).textContent?.trim() === planId);
    if (!row) return null;
    const cells = row.querySelectorAll('td');
    return cells[cells.length - 1].textContent.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  }, String(id));
  if (!actions) return { found: false, buttons: [] };
  return { found: true, buttons: actions, hasModify: actions.includes('修改') };
}

async function cmdModify(page, args, guard) {
  const id = argText(args.id);
  if (!/^\d+$/.test(id)) throw new PlanError('--id=<计划ID> is required');
  const patch = args.patch;
  const dryRun = Boolean(args['dry-run']);
  await gotoPage(page, LIST_PAGE);
  const before = await getPlan(page, id);
  const beforeDetails = await getDetails(page, id);
  if (before.planApproveStatus !== 'WAIT') {
    throw new PlanError(`plan ${id} is ${before.planApproveStatusDesc || before.planApproveStatus}; only 待审批 plans can be modified`);
  }
  const listRow = await rowHasModifyButton(page, id);
  if (!listRow.found || !listRow.hasModify) {
    throw new PlanError(`plan ${id} has no 修改 button in the list (buttons: ${listRow.buttons.join(',') || 'row not found'}); refusing`);
  }
  const description = patch.description !== undefined ? patch.description : descriptionText(before.planDesc);
  const notify = patch.notify !== undefined ? patch.notify : before.planNotify;
  if (!Object.values(NOTIFY).includes(notify)) throw new PlanError(`current planNotify ${notify} is not a known option; set notify in the patch`);
  // A patch description was linted before the browser started; an unchanged description is linted here.
  if (patch.description === undefined) assertLint(description, 'frontend', Boolean(args['allow-backend-terms']));

  await gotoPage(page, MODIFY_PAGE(id));
  await waitReady(page, () => {
    const area = [...document.querySelectorAll('textarea')].find((node) => node.placeholder === '请输入内容');
    return area && area.value;
  }, 'modify form');
  await page.waitForTimeout(1000);
  const loaded = await readModel(page);
  if (!loaded || String(loaded.id) !== id) throw new PlanError(`modify page did not load plan ${id}`);
  if (loaded.projectType && loaded.projectType !== 'frontend') throw new PlanError('后端计划暂不支持，后续补充');
  await formItem(page, '版本描述').locator('textarea').first().fill(description);
  // The radio state is not always rendered on the modify page; click the target value explicitly.
  await clickNotify(page, notify);
  await page.waitForTimeout(500);
  const model = await readModel(page);
  const apps = await readAppTable(page);
  if (descriptionText(model.planDesc) !== description) throw new PlanError('版本描述 did not take the new value');
  if (model.planNotify !== notify) throw new PlanError(`通知提醒 is ${model.planNotify}, expected ${notify}`);
  console.log(`修改计划 ${id}（当前 version ${before.version}，${before.planApproveStatusDesc}），其他字段保持原值:`);
  console.log(`  版本描述: ${descriptionText(before.planDesc) === description ? '不变' : '修改'}`);
  console.log(`  通知提醒: ${before.planNotify} -> ${notify}`);
  console.log(formatForm(model, apps));
  console.log(`截图: ${await screenshot(page, args, `modify-${id}`)}`);
  console.log('注意: 修改后计划仍为“待审批”；本脚本不点“发布申请”。');
  if (dryRun) {
    console.log('--dry-run: 未保存。');
    return;
  }

  guard.allowWrite = true;
  await confirmSave(page, '修改', (res) => {
    const apiPath = new URL(res.url()).pathname.replace(/^\/+/, '');
    return res.url().startsWith(API_BASE) && apiPath.startsWith('publishPlan/') && !READ_PLAN_PATHS.has(apiPath)
      && res.request().method() === 'POST';
  });
  guard.allowWrite = false;
  const after = await getPlan(page, id);
  const afterDetails = await getDetails(page, id);
  console.log(formatPlan(after, afterDetails));
  const problems = [];
  if (Number(after.version) !== Number(before.version) + 1) problems.push(`version ${before.version} -> ${after.version}`);
  if (descriptionText(after.planDesc) !== description) problems.push('版本描述不一致');
  if (after.planNotify !== notify) problems.push(`planNotify=${after.planNotify}`);
  const appNames = (rows) => rows.map((item) => item.appName).join(',');
  if (appNames(afterDetails) !== appNames(beforeDetails)) problems.push(`应用 ${appNames(beforeDetails)} -> ${appNames(afterDetails) || '(空)'}`);
  if (problems.length) throw new PlanError(`re-read mismatch for plan ${id}: ${problems.join('; ')}`);
  console.log(`回读校验通过: version ${before.version} -> ${after.version}，应用明细 ${appNames(afterDetails)}`);
}

const COMMANDS = { history: cmdHistory, options: cmdOptions, show: cmdShow, create: cmdCreate, modify: cmdModify };

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (args.help || args.h || !command) {
    console.log(USAGE);
    return command || args.help || args.h ? 0 : 1;
  }
  if (!COMMANDS[command]) throw new PlanError(`unknown command: ${command}\n\n${USAGE}`);
  // Validate files before the browser starts.
  if (command === 'create') {
    args.plan = validatePlan(readJsonFile(args.file));
    assertLint(args.plan.description, args.plan.projectType, Boolean(args['allow-backend-terms']));
  }
  if (command === 'modify') {
    args.patch = validatePatch(readJsonFile(args.file));
    if (args.patch.description !== undefined) assertLint(args.patch.description, 'frontend', Boolean(args['allow-backend-terms']));
  }
  const paths = resolvePaths(args, PUBLISH_HOME);
  const chromium = loadPlaywright(paths);
  const guard = { allowWrite: false, blocked: [] };
  const { context, page } = await openBrowser(paths, chromium, guard);
  try {
    await COMMANDS[command](page, args, guard);
  } finally {
    if (guard.blocked.length) console.warn(`aborted publish_server requests: ${[...new Set(guard.blocked)].join(', ')}`);
    await context.close().catch(() => {});
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error && error.message ? error.message : String(error));
      process.exit(1);
    });
}

module.exports = {
  NOTIFY,
  descriptionText,
  findBlockingPlans,
  formatDate,
  lintDescription,
  normalizeNotify,
  parseArgs,
  parseCurrentUser,
  validatePatch,
  validatePlan,
};
