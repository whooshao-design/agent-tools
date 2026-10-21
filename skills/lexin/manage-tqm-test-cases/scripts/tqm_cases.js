#!/usr/bin/env node
'use strict';
// Query and create test cases on the 质量管理平台 (TQM, tqm.oa.fenqile.com) for one 乐效 requirement version.
// Every API call runs inside a logged-in TQM page via fetch(credentials: 'include');
// cookies never leave the browser and are never printed or written to disk.
// Supported writes: create cases (test_case/add.json, at most MAX_CASES per run) and record execution results of a
// test stage (test_plan_case/edit.json, at most MAX_RESULTS per run). No case edit, no delete, no stage transition.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const BROWSER_SESSION_DIR = '/home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts';
const { launchLockedContext, resolvePaths } = require(path.join(BROWSER_SESSION_DIR, 'browser_session.js'));
const { buildBrowserEnv, chromiumArgsFor } = require(path.join(BROWSER_SESSION_DIR, 'browser_network.js'));

const TQM_HOST = 'tqm.oa.fenqile.com';
const TQM_HOME = `https://${TQM_HOST}/`;
const API_BASE = 'https://fql_api.oa.fenqile.com/';
const API = {
  version: 'oa/test_track/web/project_version/plan_list_detail.json',
  modules: 'oa/test_track/web/test_case/get_test_case_module_list.json',
  list: 'oa/test_track/web/test_case/list_test_case.json',
  add: 'oa/test_track/web/test_case/add.json',
  planCases: 'oa/test_track/web/test_plan_case/get_test_plan_cases.json',
  planCaseEdit: 'oa/test_track/web/test_plan_case/edit.json',
};
const SESSION_URL = `${API_BASE}oa/api/user/session.json?resource_sn=RD_OA`;
const MAX_CASES = 10;
const MAX_NAME_LENGTH = 255;
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const MAX_RESULTS = 30;
// Stages that hold executable plan cases; key is the plan_list_detail `stage` value.
const TEST_STAGES = { project_test: '项目环境测试', pre_test: '预发布环境测试', product_test: '线上验证' };
// Execution result values used by the page's 执行结果 select; Chinese labels are accepted as input.
const RESULT_STATUS = { Pass: '通过', Failure: '失败', Blocking: '阻塞', Skip: '跳过', Prepare: '未开始' };
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 50;
// The page keeps long-polling requests open, so `networkidle` never settles; load the DOM and give the SPA a moment.
const PAGE_SETTLE_MS = 3000;

const USAGE = `Usage:
  node tqm_cases.js version --url=<TQM 版本页链接>
  node tqm_cases.js modules --url=<链接> --match=<关键字> [--sample]
  node tqm_cases.js list    --url=<链接>
  node tqm_cases.js create  --url=<链接> --file=<cases.json> [--node-id=<模块id>] [--maintainer=<OA用户名>] [--dry-run]
  node tqm_cases.js plan-cases --url=<链接> [--stage=project_test|pre_test|product_test]
  node tqm_cases.js execute --url=<链接> --file=<results.json> [--stage=...] [--overwrite] [--dry-run]

Common: [--profile <dir>] (default: get-browser-session main profile)
create writes at most ${MAX_CASES} cases, skips names that already exist in the version, and re-reads the list afterwards.
execute records at most ${MAX_RESULTS} results in one test stage (default: the version's current stage), skips cases that
already have a different result unless --overwrite, and re-reads the stage afterwards.`;

class TqmError extends Error {}

function loadPlaywright(paths) {
  if (!fs.existsSync(paths.playwrightPackage)) throw new TqmError(`Playwright tool dir not found: ${paths.toolDir}`);
  if (!fs.existsSync(paths.chromePath)) throw new TqmError(`Chrome not found: ${paths.chromePath}`);
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

// Version ids live in the hash query (#/testActive/testTracking/<route>?versionId=...&projectId=...);
// the route name differs between version states, so only the query parameters are trusted.
function parseVersionUrl(url) {
  const text = String(url || '').trim();
  if (!text) throw new TqmError('--url is required');
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_) {
    throw new TqmError(`invalid URL: ${text}`);
  }
  if (parsed.hostname !== TQM_HOST) throw new TqmError(`not a TQM link (expected host ${TQM_HOST}): ${parsed.hostname}`);
  const params = new URLSearchParams(parsed.search);
  const hash = parsed.hash || '';
  const queryIndex = hash.indexOf('?');
  if (queryIndex >= 0) {
    for (const [key, value] of new URLSearchParams(hash.slice(queryIndex + 1))) params.set(key, value);
  }
  const versionId = (params.get('versionId') || '').trim();
  const projectId = (params.get('projectId') || '').trim();
  if (!versionId || !projectId) throw new TqmError('link must carry versionId and projectId query parameters');
  return { versionId, projectId, versionName: params.get('versionName') || '' };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Rich-text fields are stored as HTML: one <p> per line, numbered when there are several steps.
function toParagraphs(value, { numbered = false } = {}) {
  const lines = (Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]))
    .map((line) => String(line).trim())
    .filter(Boolean);
  const number = numbered && lines.length > 1;
  return lines.map((line, index) => `<p>${escapeHtml(number ? `${index + 1}. ${line}` : line)}</p>`).join('');
}

function flag(value, field, label) {
  if (value === undefined || value === null || value === '') return 0;
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  throw new TqmError(`${label}: ${field} must be 0/1 or true/false`);
}

// Flattens the module tree into { id, name, path, isCaseNode, caseNum } entries; path joins names with "/".
function flattenModules(nodes, parentPath = '') {
  const result = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== 'object') continue;
    const name = String(node.name || '').trim();
    const nodePath = parentPath ? `${parentPath}/${name}` : name;
    result.push({
      id: String(node.id),
      name,
      path: nodePath,
      isCaseNode: node.is_case_node,
      caseNum: node.case_num,
    });
    result.push(...flattenModules(node.children, nodePath));
  }
  return result;
}

function buildCasePayloads(rawCases, options) {
  if (!Array.isArray(rawCases)) throw new TqmError('cases file must contain a JSON array');
  if (rawCases.length === 0) throw new TqmError('cases file is empty');
  if (rawCases.length > MAX_CASES) {
    throw new TqmError(`refusing to create ${rawCases.length} cases: at most ${MAX_CASES} per run`);
  }
  const modulesById = new Map(options.modules.map((item) => [item.id, item]));
  const seen = new Set();
  return rawCases.map((raw, index) => {
    const label = `case #${index + 1}`;
    if (!raw || typeof raw !== 'object') throw new TqmError(`${label}: must be an object`);
    const name = String(raw.name || '').trim();
    if (!name) throw new TqmError(`${label}: name is required`);
    if (name.length > MAX_NAME_LENGTH) throw new TqmError(`${label}: name exceeds ${MAX_NAME_LENGTH} characters`);
    if (seen.has(name)) throw new TqmError(`${label}: duplicate name in file: ${name}`);
    seen.add(name);
    const priority = String(raw.priority || '').trim().toUpperCase();
    if (!PRIORITIES.has(priority)) throw new TqmError(`${label}: priority must be one of ${[...PRIORITIES].join('/')}`);
    const steps = toParagraphs(raw.steps, { numbered: true });
    const expected = toParagraphs(raw.expected, { numbered: true });
    if (!steps) throw new TqmError(`${label}: steps is required`);
    if (!expected) throw new TqmError(`${label}: expected is required`);
    const nodeId = String(raw.node_id || options.nodeId || '').trim();
    if (!nodeId) throw new TqmError(`${label}: node_id missing (set it per case or pass --node-id)`);
    const moduleNode = modulesById.get(nodeId);
    if (!moduleNode) throw new TqmError(`${label}: node_id ${nodeId} is not in this project's module tree`);
    if (Number(moduleNode.isCaseNode) !== 1) {
      throw new TqmError(`${label}: module ${moduleNode.path} is not a case node (is_case_node=${moduleNode.isCaseNode}); pick a leaf module`);
    }
    return {
      versionId: options.versionId,
      projectId: options.projectId,
      nodePath: moduleNode.path,
      node_id: nodeId,
      name,
      prerequisite: toParagraphs(raw.prerequisite),
      step_model: 'TEXT',
      steps: '[]',
      step_description: steps,
      expected_result: expected,
      remark: toParagraphs(raw.remark),
      status: 'Prepare',
      maintainer: options.maintainer,
      priority,
      is_abnormal: flag(raw.is_abnormal, 'is_abnormal', label),
      is_user_case: flag(raw.is_user_case, 'is_user_case', label),
      is_auto_case: flag(raw.is_auto_case, 'is_auto_case', label),
      is_regress: flag(raw.is_regress, 'is_regress', label),
      type: 'functional',
    };
  });
}

function splitByExisting(payloads, existingNames) {
  const existing = new Set([...existingNames].map((name) => String(name).trim()));
  return {
    toCreate: payloads.filter((item) => !existing.has(item.name)),
    skipped: payloads.filter((item) => existing.has(item.name)),
  };
}

function normalizeStatus(value, label) {
  const text = String(value || '').trim();
  const byValue = Object.keys(RESULT_STATUS).find((key) => key.toLowerCase() === text.toLowerCase());
  const byLabel = Object.keys(RESULT_STATUS).find((key) => RESULT_STATUS[key] === text);
  const status = byValue || byLabel;
  if (!status || status === 'Prepare') {
    throw new TqmError(`${label}: status must be one of Pass/Failure/Blocking/Skip (通过/失败/阻塞/跳过)`);
  }
  return status;
}

// Picks the plan (test stage) whose plan cases are executed: --stage wins, else the version's current stage.
function resolveStagePlan(version, stageArg) {
  const stage = String(stageArg && stageArg !== true ? stageArg : version.stage || '').trim();
  if (!TEST_STAGES[stage]) {
    throw new TqmError(`stage ${stage || '(none)'} has no executable cases; pass --stage=${Object.keys(TEST_STAGES).join('|')}`);
  }
  const plan = (version.stages || []).find((item) => item.stage === stage);
  if (!plan || !plan.id) throw new TqmError(`version has no plan for stage ${stage}`);
  return { stage, stageDesc: TEST_STAGES[stage], planId: String(plan.id), planStatus: plan.status || '-' };
}

// Maps result entries (by case number `num`, or exact `name`) onto the stage's plan cases.
function buildExecutionPayloads(rawResults, planRows, options) {
  if (!Array.isArray(rawResults)) throw new TqmError('results file must contain a JSON array');
  if (rawResults.length === 0) throw new TqmError('results file is empty');
  if (rawResults.length > MAX_RESULTS) {
    throw new TqmError(`refusing to record ${rawResults.length} results: at most ${MAX_RESULTS} per run`);
  }
  const byNum = new Map(planRows.map((row) => [String(row.num), row]));
  const byName = new Map(planRows.map((row) => [String(row.name).trim(), row]));
  const seen = new Set();
  const toWrite = [];
  const skipped = [];
  rawResults.forEach((raw, index) => {
    const label = `result #${index + 1}`;
    if (!raw || typeof raw !== 'object') throw new TqmError(`${label}: must be an object`);
    const key = raw.num !== undefined && raw.num !== null && raw.num !== '' ? String(raw.num).trim() : null;
    const row = key ? byNum.get(key) : byName.get(String(raw.name || '').trim());
    if (!row) throw new TqmError(`${label}: case ${key || raw.name || '(no num/name)'} is not in this stage`);
    if (seen.has(row.id)) throw new TqmError(`${label}: case ${row.num} listed twice`);
    seen.add(row.id);
    if (row.step_model && row.step_model !== 'TEXT') {
      throw new TqmError(`${label}: case ${row.num} uses step_model=${row.step_model}; only TEXT cases are supported, record it on the page`);
    }
    const status = normalizeStatus(raw.status, label);
    const actual = toParagraphs(raw.actual);
    if (!actual) throw new TqmError(`${label}: actual (实际结果) is required`);
    const current = row.status || 'Prepare';
    if (current !== 'Prepare' && current !== status && !options.overwrite) {
      skipped.push({ num: row.num, name: row.name, current, status });
      return;
    }
    toWrite.push({
      id: row.id,
      case_id: row.case_id,
      status,
      results: '[]',
      project_id: options.projectId,
      name: row.name,
      actual_result: actual,
      num: row.num,
      current,
    });
  });
  return { toWrite, skipped };
}

function formatPlanTable(rows) {
  const lines = ['编号\t执行结果\t执行人\t等级\t名称'];
  for (const row of rows) {
    const status = row.status || 'Prepare';
    lines.push(`${row.num ?? '-'}\t${RESULT_STATUS[status] || status}\t${row.executor || '-'}\t${row.priority || '-'}\t${row.name}`);
  }
  return lines.join('\n');
}

function marks(row) {
  const result = [];
  if (Number(row.is_abnormal) === 1) result.push('异常');
  if (Number(row.is_user_case) === 1) result.push('线上验收');
  if (Number(row.is_regress) === 1) result.push('回归');
  if (Number(row.is_auto_case) === 1) result.push('自动化');
  return result.join(',') || '-';
}

function formatCaseTable(rows) {
  const lines = ['编号\t等级\t标记\t模块(node_path)\t名称'];
  for (const row of rows) {
    lines.push(`${row.num ?? '-'}\t${row.priority || '-'}\t${marks(row)}\t${row.node_path || '-'}\t${row.name}`);
  }
  return lines.join('\n');
}

// ---------- browser-side API ----------

async function openTqmPage(paths, chromium) {
  const network = buildBrowserEnv(TQM_HOME, { ...process.env });
  const env = { ...network.env, LD_LIBRARY_PATH: [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  const context = await launchLockedContext(chromium, paths.profileDir, {
    executablePath: paths.chromePath,
    headless: true,
    env,
    args: chromiumArgsFor(TQM_HOME, ['--no-sandbox']),
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(TQM_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(PAGE_SETTLE_MS);
    if (new URL(page.url()).hostname !== TQM_HOST) {
      throw new TqmError(`TQM login required (landed on ${new URL(page.url()).hostname}); `
        + `run get-browser-session ensure_session with url=${TQM_HOME}`);
    }
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function pageFetch(page, url, body) {
  const result = await page.evaluate(async ({ target, payload }) => {
    const init = { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } };
    if (payload !== null) {
      init.method = 'POST';
      init.headers['content-type'] = 'application/json;charset=UTF-8';
      init.body = JSON.stringify(payload);
    }
    const response = await fetch(target, init);
    return { status: response.status, text: await response.text() };
  }, { target: url, payload: body === undefined ? null : body });
  let json;
  try {
    json = JSON.parse(result.text);
  } catch (_) {
    throw new TqmError(`non-JSON response (HTTP ${result.status}) from ${url}; the session may have expired -- `
      + `run get-browser-session ensure_session with url=${TQM_HOME}`);
  }
  return { status: result.status, json };
}

async function callApi(page, name, body) {
  const { status, json } = await pageFetch(page, API_BASE + API[name], body);
  if (Number(json.retcode) !== 0) {
    throw new TqmError(`${API[name]} failed (HTTP ${status}, retcode ${json.retcode}): ${json.retmsg || 'unknown error'}`);
  }
  return json;
}

function firstRow(json) {
  const rows = json.result_rows;
  if (Array.isArray(rows)) return rows[0] || {};
  return rows && typeof rows === 'object' ? rows : {};
}

async function fetchVersion(page, ids) {
  const row = firstRow(await callApi(page, 'version', { id: ids.versionId, projectId: ids.projectId }));
  return {
    versionId: ids.versionId,
    projectId: ids.projectId,
    versionName: row.version_name || ids.versionName,
    tapdId: row.tapd_id ?? null,
    stage: row.stage ?? null,
    stageId: row.current_stage_id ?? null,
    needTest: row.is_need_test ?? null,
    stages: Array.isArray(row.list) ? row.list.map((item) => ({ stage: item.stage, id: item.id, status: item.status })) : [],
  };
}

async function fetchModules(page, projectId) {
  const json = await callApi(page, 'modules', { projectId });
  return flattenModules(json.result_rows);
}

async function fetchCases(page, body) {
  const rows = [];
  for (let pageNo = 1; pageNo <= LIST_MAX_PAGES; pageNo += 1) {
    const json = await callApi(page, 'list', { ...body, page: pageNo, limit: LIST_PAGE_SIZE });
    const batch = Array.isArray(json.result_rows) ? json.result_rows : [];
    rows.push(...batch);
    if (batch.length < LIST_PAGE_SIZE) return rows;
  }
  throw new TqmError(`more than ${LIST_PAGE_SIZE * LIST_MAX_PAGES} cases; refusing to continue with a partial list`);
}

function listVersionCases(page, ids) {
  return fetchCases(page, { name: '', versionId: ids.versionId, projectId: ids.projectId, latest: 0, nodeIds: [] });
}

async function listPlanCases(page, ids, planId) {
  const rows = [];
  for (let pageNo = 1; pageNo <= LIST_MAX_PAGES; pageNo += 1) {
    const json = await callApi(page, 'planCases', {
      planId, plan_id: planId, projectId: ids.projectId, name: '', nodeIds: [], page: pageNo, limit: LIST_PAGE_SIZE,
    });
    const batch = Array.isArray(json.result_rows) ? json.result_rows : [];
    rows.push(...batch);
    if (batch.length < LIST_PAGE_SIZE) return rows;
  }
  throw new TqmError(`more than ${LIST_PAGE_SIZE * LIST_MAX_PAGES} plan cases; refusing to continue with a partial list`);
}

async function resolveMaintainer(page, override) {
  if (override && override !== true) return String(override).trim();
  const { json } = await pageFetch(page, SESSION_URL).catch(() => ({ json: null }));
  const rows = json && json.result_rows;
  const row = Array.isArray(rows) ? rows[0] : rows;
  const min = row && row.min;
  if (!min) throw new TqmError('cannot resolve the logged-in OA user; pass --maintainer=<OA用户名>');
  return String(min);
}

// ---------- commands ----------

function printVersion(version) {
  console.log(`版本名: ${version.versionName}`);
  console.log(`versionId: ${version.versionId}`);
  console.log(`projectId: ${version.projectId}`);
  console.log(`tapd_id: ${version.tapdId ?? '-'}`);
  console.log(`当前阶段: ${version.stage ?? '-'} (current_stage_id ${version.stageId ?? '-'}, is_need_test ${version.needTest ?? '-'})`);
}

async function cmdVersion(page, ids) {
  printVersion(await fetchVersion(page, ids));
}

async function cmdModules(page, ids, args) {
  const keyword = String(args.match === true ? '' : (args.match || '')).trim();
  if (!keyword) throw new TqmError('--match is required');
  const matched = (await fetchModules(page, ids.projectId)).filter((item) => item.name.includes(keyword) || item.path.includes(keyword));
  console.log(`匹配 "${keyword}" 的模块 ${matched.length} 个:`);
  console.log('id\tis_case_node\tcase_num\t路径(nodePath)');
  for (const item of matched) console.log(`${item.id}\t${item.isCaseNode ?? '-'}\t${item.caseNum ?? '-'}\t${item.path}`);
  if (!args.sample) return;
  // Parent nodes (is_case_node=0) only aggregate case_num; their own list is empty.
  for (const item of matched.filter((node) => Number(node.isCaseNode) === 1 && Number(node.caseNum) > 0).slice(0, 3)) {
    const json = await callApi(page, 'list', { projectId: ids.projectId, page: 1, limit: 2, latest: 1, nodeIds: [item.id] });
    const rows = Array.isArray(json.result_rows) ? json.result_rows : [];
    console.log(`\n样例 ${item.path} (id ${item.id}):`);
    for (const row of rows) {
      console.log(`  ${row.num} ${row.name}`);
      console.log(`    node_path=${row.node_path} priority=${row.priority} 标记=${marks(row)} maintainer=${row.maintainer ?? '-'} status=${row.status ?? '-'} type=${row.type ?? '-'}`);
    }
  }
}

async function cmdList(page, ids) {
  const rows = await listVersionCases(page, ids);
  console.log(`版本下现有用例 ${rows.length} 条:`);
  console.log(formatCaseTable(rows));
}

function readCasesFile(file) {
  if (!file || file === true) throw new TqmError('--file is required');
  const text = fs.readFileSync(path.resolve(String(file)), 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TqmError(`cases file is not valid JSON: ${error.message}`);
  }
}

async function cmdCreate(page, ids, args) {
  const rawCases = args.cases;
  const dryRun = Boolean(args['dry-run']);
  const version = await fetchVersion(page, ids);
  const modules = await fetchModules(page, ids.projectId);
  let maintainer;
  try {
    maintainer = await resolveMaintainer(page, args.maintainer);
  } catch (error) {
    if (!dryRun) throw error;
    maintainer = '<未解析，正式创建需 --maintainer>';
  }
  const payloads = buildCasePayloads(rawCases, {
    versionId: ids.versionId,
    projectId: ids.projectId,
    nodeId: args['node-id'] === true ? '' : args['node-id'],
    maintainer,
    modules,
  });
  const existingRows = await listVersionCases(page, ids);
  const { toCreate, skipped } = splitByExisting(payloads, existingRows.map((row) => row.name));

  console.log(`目标版本: ${version.versionName} (tapd_id ${version.tapdId ?? '-'}, versionId ${ids.versionId})`);
  console.log(`文件用例 ${payloads.length} 条；版本下已有同名 ${skipped.length} 条（跳过）；待创建 ${toCreate.length} 条；maintainer=${maintainer}`);
  for (const item of skipped) console.log(`  跳过(同名已存在): ${item.name}`);
  for (const item of toCreate) {
    console.log(`  待创建: [${item.priority}] ${marks(item)} | ${item.nodePath} (node_id ${item.node_id}) | ${item.name}`);
  }
  if (dryRun) {
    console.log(`\n--dry-run: 未写入。payload 摘要${toCreate.length ? ':' : '：无待创建用例。'}`);
    for (const item of toCreate) {
      console.log(JSON.stringify({ ...item, step_description: item.step_description.slice(0, 200), expected_result: item.expected_result.slice(0, 200) }));
    }
    return;
  }
  if (toCreate.length === 0) {
    console.log('没有需要创建的用例。');
    return;
  }

  const created = [];
  for (const item of toCreate) {
    try {
      const json = await callApi(page, 'add', item);
      const row = firstRow(json);
      created.push(item.name);
      console.log(`  已创建: ${row.num ?? '-'} ${item.name}`);
    } catch (error) {
      console.error(`  创建失败，停止后续写入: ${item.name}: ${error.message}`);
      break;
    }
  }

  const after = await listVersionCases(page, ids);
  const afterNames = new Set(after.map((row) => String(row.name).trim()));
  const missing = created.filter((name) => !afterNames.has(name));
  const relevant = after.filter((row) => payloads.some((item) => item.name === String(row.name).trim()));
  console.log(`\n回读校验: 版本下共 ${after.length} 条；本次创建 ${created.length}/${toCreate.length} 条；回读缺失 ${missing.length} 条`);
  console.log(formatCaseTable(relevant));
  if (missing.length || created.length < toCreate.length) {
    throw new TqmError(`incomplete: created ${created.length}/${toCreate.length}, missing after re-read: ${missing.join(' | ') || 'none'}`);
  }
}

async function cmdPlanCases(page, ids, args) {
  const version = await fetchVersion(page, ids);
  const plan = resolveStagePlan(version, args.stage);
  const rows = await listPlanCases(page, ids, plan.planId);
  console.log(`${version.versionName} / ${plan.stageDesc}（${plan.stage}，计划状态 ${plan.planStatus}）用例 ${rows.length} 条:`);
  console.log(formatPlanTable(rows));
}

async function cmdExecute(page, ids, args) {
  const dryRun = Boolean(args['dry-run']);
  const version = await fetchVersion(page, ids);
  const plan = resolveStagePlan(version, args.stage);
  const rows = await listPlanCases(page, ids, plan.planId);
  const { toWrite, skipped } = buildExecutionPayloads(args.results, rows, { projectId: ids.projectId, overwrite: Boolean(args.overwrite) });

  console.log(`目标: ${version.versionName} / ${plan.stageDesc}（${plan.stage}，计划状态 ${plan.planStatus}）`);
  console.log(`文件结果 ${toWrite.length + skipped.length} 条；待写入 ${toWrite.length} 条；已有不同结果跳过 ${skipped.length} 条`);
  for (const item of skipped) {
    console.log(`  跳过(已是${RESULT_STATUS[item.current] || item.current}，需 --overwrite 才改为${RESULT_STATUS[item.status]}): ${item.num} ${item.name}`);
  }
  for (const item of toWrite) {
    console.log(`  待写入: ${item.num} ${RESULT_STATUS[item.current] || item.current} -> ${RESULT_STATUS[item.status]} | ${item.name}`);
  }
  if (dryRun) {
    console.log('\n--dry-run: 未写入。实际结果摘要:');
    for (const item of toWrite) console.log(`  ${item.num}: ${item.actual_result.slice(0, 200)}`);
    return;
  }
  if (toWrite.length === 0) {
    console.log('没有需要写入的结果。');
    return;
  }
  let written = 0;
  for (const item of toWrite) {
    const { num, current, ...payload } = item;
    try {
      await callApi(page, 'planCaseEdit', payload);
      written += 1;
      console.log(`  已写入: ${num} ${RESULT_STATUS[item.status]}`);
    } catch (error) {
      console.error(`  写入失败，停止后续写入: ${num} ${item.name}: ${error.message}`);
      break;
    }
  }
  const after = await listPlanCases(page, ids, plan.planId);
  const byId = new Map(after.map((row) => [row.id, row]));
  const mismatched = toWrite.slice(0, written).filter((item) => (byId.get(item.id) || {}).status !== item.status);
  console.log(`\n回读校验: 写入 ${written}/${toWrite.length} 条；状态不符 ${mismatched.length} 条`);
  console.log(formatPlanTable(after));
  if (mismatched.length || written < toWrite.length) {
    throw new TqmError(`incomplete: wrote ${written}/${toWrite.length}, status mismatch after re-read: ${mismatched.map((item) => item.num).join(', ') || 'none'}`);
  }
}

const COMMANDS = {
  version: cmdVersion, modules: cmdModules, list: cmdList, create: cmdCreate, 'plan-cases': cmdPlanCases, execute: cmdExecute,
};

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (args.help || args.h || !command) {
    console.log(USAGE);
    return command || args.help || args.h ? 0 : 1;
  }
  if (!COMMANDS[command]) throw new TqmError(`unknown command: ${command}\n\n${USAGE}`);
  const ids = parseVersionUrl(args.url);
  if (command === 'create') {
    // Reject oversized or malformed files before the browser starts.
    args.cases = readCasesFile(args.file);
    if (Array.isArray(args.cases) && args.cases.length > MAX_CASES) {
      throw new TqmError(`refusing to create ${args.cases.length} cases: at most ${MAX_CASES} per run`);
    }
  }
  if (command === 'execute') {
    args.results = readCasesFile(args.file);
    if (Array.isArray(args.results) && args.results.length > MAX_RESULTS) {
      throw new TqmError(`refusing to record ${args.results.length} results: at most ${MAX_RESULTS} per run`);
    }
  }
  const paths = resolvePaths(args, TQM_HOME);
  const chromium = loadPlaywright(paths);
  const { context, page } = await openTqmPage(paths, chromium);
  try {
    await COMMANDS[command](page, ids, args);
  } finally {
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
  MAX_CASES,
  MAX_RESULTS,
  buildCasePayloads,
  buildExecutionPayloads,
  normalizeStatus,
  resolveStagePlan,
  escapeHtml,
  flattenModules,
  formatCaseTable,
  parseArgs,
  parseVersionUrl,
  splitByExisting,
  toParagraphs,
};
