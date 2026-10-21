#!/usr/bin/env node
'use strict';
// Query and create test cases on the 质量管理平台 (TQM, tqm.oa.fenqile.com) for one 乐效 requirement version.
// Every API call runs inside a logged-in TQM page via fetch(credentials: 'include');
// cookies never leave the browser and are never printed or written to disk.
// Supported writes: create only (test_case/add.json), at most MAX_CASES per run. No edit, no delete.
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
};
const SESSION_URL = `${API_BASE}oa/api/user/session.json?resource_sn=RD_OA`;
const MAX_CASES = 10;
const MAX_NAME_LENGTH = 255;
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 50;
// The page keeps long-polling requests open, so `networkidle` never settles; load the DOM and give the SPA a moment.
const PAGE_SETTLE_MS = 3000;

const USAGE = `Usage:
  node tqm_cases.js version --url=<TQM 版本页链接>
  node tqm_cases.js modules --url=<链接> --match=<关键字> [--sample]
  node tqm_cases.js list    --url=<链接>
  node tqm_cases.js create  --url=<链接> --file=<cases.json> [--node-id=<模块id>] [--maintainer=<OA用户名>] [--dry-run]

Common: [--profile <dir>] (default: get-browser-session main profile)
create writes at most ${MAX_CASES} cases, skips names that already exist in the version, and re-reads the list afterwards.`;

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

const COMMANDS = { version: cmdVersion, modules: cmdModules, list: cmdList, create: cmdCreate };

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
  buildCasePayloads,
  escapeHtml,
  flattenModules,
  formatCaseTable,
  parseArgs,
  parseVersionUrl,
  splitByExisting,
  toParagraphs,
};
