#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const {
  buildBrowserEnv,
  chromiumArgsFor,
  validateWebShellUrl,
} = require('../../get-browser-session/scripts/browser_network');

const TOOL_DIR = path.join(os.homedir(), 'tools/lexiao-browser');
const CHROME_PATH = path.join(TOOL_DIR, 'browsers/chrome-linux64/chrome');
const RUNTIME_LIB_DIR = path.join(TOOL_DIR, 'runtime-libs/usr/lib/x86_64-linux-gnu');
const chromium = createRequire(path.join(TOOL_DIR, 'package.json'))('playwright').chromium;

const LEXIAO_URL = 'https://lexiao.oa.fenqile.com/#/new-workbench';
const API_BASE = 'https://lexiao-api.oa.fenqile.com';
const DEFAULT_PROFILES = [
  '/home/joney/.local/state/agent-tools/browser-profiles/healthy',
  path.join(os.homedir(), '.local/state/agent-tools/browser-profiles/main'),
];
const DEFAULT_ENV = 'pre';
const DEFAULT_LIMIT = 100;
const MAX_PAGES = 50;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq !== -1) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args[item.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      args[item.slice(2)] = true;
    }
  }
  return args;
}

function usage() {
  console.log(`Usage:
  query_app_instances.js [--app=<app-name> | --app-id=<id>] [--env=pre] [--type=all] [--json]

Defaults:
  --app       omitted -> infer application.name from current directory
  --env       omitted -> pre
  --type      omitted -> all
  --profile   omitted -> try /home/joney/.local/state/agent-tools/browser-profiles/healthy, then ~/.local/state/agent-tools/browser-profiles/main

Options:
  --app          Lexiao app name, app_name, or project_name
  --app-id       Lexiao application fid/app_id
  --env          pre|prod|gray|oa|stable|all, supports Chinese aliases and comma list
  --type         all|vm|pod, supports aliases machine/container
  --cwd          Directory used to infer current app, default process.cwd()
  --profile      Browser profile with Lexiao login state
  --headed       Open browser headed for debugging
  --json         Same as --format=json
  --format       table|json, default table
  --limit        Page size for Lexiao machine APIs, default ${DEFAULT_LIMIT}
  --show-login-url Include pod login_pod_addr in table output
  --help         Print this help
`);
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[-_\s]/g, '');
}

function hyphenize(value) {
  return String(value || '').replace(/_/g, '-');
}

function envOf(value) {
  const raw = String(value || '').trim().toLowerCase();
  const map = {
    pre: 'pre',
    prerelease: 'pre',
    '预发布': 'pre',
    prod: 'prod',
    online: 'prod',
    production: 'prod',
    '线上': 'prod',
    '生产': 'prod',
    gray: 'gray',
    grey: 'gray',
    '灰度': 'gray',
    oa: 'oa',
    stable: 'stable',
    test: 'stable',
    '稳定': 'stable',
    '测试': 'stable',
    all: 'all',
    '*': 'all',
    '全部': 'all',
  };
  return map[raw] || raw;
}

function typeOf(value) {
  const raw = String(value || 'all').trim().toLowerCase();
  const map = {
    all: 'all',
    '*': 'all',
    vm: 'vm',
    kvm: 'vm',
    machine: 'vm',
    host: 'vm',
    '虚拟机': 'vm',
    pod: 'pod',
    container: 'pod',
    k8s: 'pod',
    '容器': 'pod',
  };
  return map[raw] || raw;
}

function appNameCandidates(value) {
  const result = [];
  const add = (item) => {
    if (item && !result.includes(item)) result.push(item);
  };
  add(value);
  add(hyphenize(value));
  return result;
}

function readProperties(file) {
  const props = {};
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eq = line.search(/[:=]/);
    if (eq === -1) continue;
    props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return props;
}

function findAppProperties(root) {
  const found = [];
  const start = path.resolve(root || process.cwd());
  const skip = new Set(['.git', 'target', 'dist', 'node_modules', '.idea', '.gradle', 'build']);

  function visit(dir, depth) {
    if (depth > 5 || found.length > 20) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'app.properties') {
        found.push(full);
      } else if (entry.isDirectory() && !skip.has(entry.name)) {
        visit(full, depth + 1);
      }
    }
  }

  const direct = path.join(start, 'src/main/resources/app.properties');
  if (fs.existsSync(direct)) return [direct];
  visit(start, 0);
  return found;
}

function inferAppNameFromCwd(cwd) {
  const files = findAppProperties(cwd);
  const candidates = [];
  for (const file of files) {
    try {
      const props = readProperties(file);
      if (props['application.name']) {
        candidates.push({ file, app: props['application.name'] });
      }
    } catch (_) {
      // Ignore unreadable properties files and continue searching.
    }
  }
  const unique = Array.from(new Map(candidates.map((item) => [item.app, item])).values());
  if (unique.length === 1) return unique[0];
  if (unique.length === 0) {
    throw new Error(`Cannot infer app: no application.name found under ${path.resolve(cwd || process.cwd())}`);
  }
  throw new Error(`Cannot infer app: multiple application.name values found: ${unique.map((item) => `${item.app} (${item.file})`).join(', ')}`);
}

async function openContext(profile, args) {
  const ldLibraryPath = [RUNTIME_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const network = buildBrowserEnv(LEXIAO_URL, process.env);
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: args.chrome || CHROME_PATH,
    headless: !args.headed,
    env: { ...network.env, LD_LIBRARY_PATH: ldLibraryPath },
    args: chromiumArgsFor(LEXIAO_URL, ['--no-sandbox']),
  });
  return { context, networkPolicy: network.networkPolicy };
}

async function fetchJson(page, url, options = {}) {
  return page.evaluate(async ({ url, options }) => {
    const response = await fetch(url, { credentials: 'include', ...options });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return {
      status: response.status,
      ok: response.ok,
      url: response.url,
      json,
      text: json ? undefined : text.slice(0, 1000),
    };
  }, { url, options });
}

async function postJson(page, pathName, body) {
  return fetchJson(page, `${API_BASE}${pathName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

function rowsOf(result) {
  const json = result && result.json;
  if (!json) return [];
  if (Array.isArray(json.result_rows)) return json.result_rows;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.dat)) return json.dat;
  if (Array.isArray(json.list)) return json.list;
  if (json.result_rows && typeof json.result_rows === 'object') return [json.result_rows];
  return [];
}

function ensureOk(result, label) {
  const retcode = result && result.json && result.json.retcode;
  if (!result || !result.ok || (retcode !== undefined && String(retcode) !== '0')) {
    const detail = result && (result.text || JSON.stringify(result.json || {}).slice(0, 500));
    throw new Error(`${label} failed: status=${result && result.status}, retcode=${retcode}, detail=${detail || ''}`);
  }
}

async function openLoggedInPage(args) {
  const profiles = args.profile ? [expandHome(args.profile)] : DEFAULT_PROFILES;
  const errors = [];
  for (const profile of profiles) {
    let context;
    try {
      const launched = await openContext(profile, args);
      context = launched.context;
      const page = context.pages()[0] || await context.newPage();
      await page.goto(LEXIAO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1500);
      const state = await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        return {
          title: document.title,
          url: location.href,
          text: text.slice(0, 500),
          hasLoginText: /Work Happy|QR Code|Use MOA|Account Login|Password Login|登录|密码|乐空间传送门|ATrust/i.test(text),
          hasPortalText: /乐空间传送门|ATrust/i.test(text) || /atrust/i.test(location.hostname),
          hasLexiaoText: /我的工作台|应用管理|当前环境|乐效/.test(text),
        };
      });
      if (state.hasLexiaoText && !state.hasLoginText && !state.hasPortalText) {
        return { context, page, profile, state, networkPolicy: launched.networkPolicy };
      }
      errors.push(`${profile}: not logged in (${state.title}, ${state.url})`);
      await context.close();
    } catch (error) {
      errors.push(`${profile}: ${error.message}`);
      if (context) {
        try { await context.close(); } catch (_) {}
      }
    }
  }
  throw new Error(`No usable Lexiao browser session. Tried: ${errors.join(' | ')}`);
}

async function getAppById(page, appId) {
  const result = await postJson(page, '/oa/publish/application/get.json', { id: String(appId) });
  ensureOk(result, 'application/get');
  const rows = rowsOf(result);
  const app = rows[0] || {};
  return {
    fid: Number(app.fid || app.id || app.app_id || appId),
    app_id: Number(app.app_id || app.id || app.fid || appId),
    app_name: app.app_name || app.name || app.project_name || String(appId),
    name: app.name || app.app_name || app.project_name || String(appId),
    project_name: app.project_name || '',
    raw: app,
  };
}

async function searchAppsByField(page, field, value) {
  const resultRows = [];
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
    const body = { page: pageNo, app_type: '', owner_or_manager: '', privatization: '' };
    body[field] = value;
    const result = await postJson(page, '/oa/publish/application/list_simple_app.json', body);
    ensureOk(result, `application/list_simple_app field=${field}`);
    const rows = rowsOf(result);
    resultRows.push(...rows);
    const totalPage = Number(result.json && result.json.total_page);
    if (!totalPage || pageNo >= totalPage || rows.length === 0) break;
  }
  return resultRows;
}

async function resolveApp(page, args) {
  if (args['app-id']) return getAppById(page, args['app-id']);

  let appQuery = args.app;
  let inferred = null;
  if (!appQuery) {
    inferred = inferAppNameFromCwd(args.cwd || process.cwd());
    appQuery = inferred.app;
  }

  const seen = new Map();
  for (const candidate of appNameCandidates(appQuery)) {
    for (const field of ['project_name', 'name']) {
      const apps = await searchAppsByField(page, field, candidate);
      for (const app of apps) {
        const id = app.fid || app.id || app.app_id;
        if (id) seen.set(String(id), app);
      }
    }
  }

  const apps = Array.from(seen.values());
  const wanted = normalizeName(appQuery);
  const exactAppName = apps.filter((app) => [app.app_name, app.name].some((value) => String(value || '') === String(appQuery)));
  const exactProjectName = apps.filter((app) => String(app.project_name || '') === String(appQuery));
  const exactNormalized = apps.filter((app) => [
    app.app_name,
    app.name,
    app.project_name,
  ].some((value) => normalizeName(value) === wanted));
  const contains = apps.filter((app) => [
    app.app_name,
    app.name,
    app.project_name,
  ].some((value) => normalizeName(value).includes(wanted)));
  const candidates = exactAppName.length
    ? exactAppName
    : (exactProjectName.length ? exactProjectName : (exactNormalized.length ? exactNormalized : contains));

  if (candidates.length === 1) {
    const app = candidates[0];
    return {
      fid: Number(app.fid || app.id || app.app_id),
      app_id: Number(app.app_id || app.id || app.fid),
      app_name: app.app_name || app.name || app.project_name,
      name: app.name || app.app_name || app.project_name,
      project_name: app.project_name || '',
      inferred_from: inferred,
      raw: app,
    };
  }

  if (candidates.length > 1) {
    throw new Error(`Multiple apps matched ${appQuery}: ${candidates.map((app) => `${app.app_name || app.name}(fid=${app.fid || app.id || app.app_id})`).join(', ')}`);
  }
  throw new Error(`No Lexiao app matched ${appQuery}`);
}

async function queryEnvs(page, appId) {
  const result = await postJson(page, '/oa/publish/appmachine/listAppMachineEnvs.json', { app_id: String(appId) });
  ensureOk(result, 'appmachine/listAppMachineEnvs');
  return rowsOf(result).map((item) => ({ env: item.env, count: Number(item.cnt || 0) }));
}

async function queryVmPage(page, appId, env, limit, pageNo) {
  return postJson(page, '/oa/publish/appMachine/getAppMachineDistinct.json', {
    limit,
    page: pageNo,
    env,
    ip: '',
    deployment_id: '',
    app_id: String(appId),
  });
}

async function queryVm(page, appId, env, limit) {
  const all = [];
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
    const result = await queryVmPage(page, appId, env, limit, pageNo);
    ensureOk(result, `appMachine/getAppMachineDistinct env=${env}`);
    const rows = rowsOf(result);
    all.push(...rows);
    const totalPage = Number(result.json && result.json.total_page);
    if (!totalPage || pageNo >= totalPage || rows.length < limit) break;
  }
  return all;
}

async function queryPodPage(page, appId, env, limit, pageNo) {
  const params = new URLSearchParams({
    limit: String(limit),
    page: String(pageNo),
    env,
    ip: '',
    deployment_id: '',
    app_id: String(appId),
  });
  return fetchJson(page, `${API_BASE}/oa/publish/devops/pod/getAppPodInfo.json?${params.toString()}`);
}

async function queryPod(page, appId, env, limit) {
  const all = [];
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
    const result = await queryPodPage(page, appId, env, limit, pageNo);
    ensureOk(result, `devops/pod/getAppPodInfo env=${env}`);
    const rows = rowsOf(result);
    all.push(...rows);
    const totalPage = Number(result.json && result.json.total_page);
    if ((totalPage && pageNo >= totalPage) || rows.length < limit) break;
  }
  return all;
}

async function queryJdkVersions(page, appName) {
  if (!appName) return new Map();
  const result = await postJson(page, '/oa/publish/appops/get_app_jdkversion.json', { app_name: appName });
  if (!result.ok || !result.json || String(result.json.retcode) !== '0') return new Map();
  const map = new Map();
  for (const item of rowsOf(result)) {
    map.set(`${item.env || ''}:${item.ip || ''}`, item.jdk_version || '');
  }
  return map;
}

function normalizeVm(item, jdkVersions) {
  const key = `${item.env || ''}:${item.ip || ''}`;
  return {
    type: 'vm',
    env: item.env || '',
    ip: item.ip || '',
    set: item.belong_set || '',
    set_name: item.belong_set_cn || '',
    biz_line: item.biz_line || '',
    run_status: item.run_status || '',
    target_status: item.target_status || '',
    app_version: item.app_version || item.version || '',
    jdk_version: item.jdk_version || jdkVersions.get(key) || '',
    enable: item.enable,
    bind_type: item.bind_type || '',
    raw: item,
  };
}

function normalizePod(item) {
  const loginPodAddr = item.login_pod_addr || '';
  const declaredContainer = item.container || item.container_name || '';
  const validation = loginPodAddr
    ? validateWebShellUrl(loginPodAddr, {
      namespace: item.namespace || '',
      pod_name: item.pod_name || '',
      cluster_id: item.cluster_id || '',
      container: declaredContainer,
    })
    : {
      valid: false,
      mode: 'missing',
      errors: ['LOGIN_URL_MISSING'],
      warnings: [],
      container: declaredContainer,
      redactedUrl: '',
    };
  return {
    type: 'pod',
    env: item.env || '',
    pod_name: item.pod_name || '',
    pod_ip: item.pod_ip || '',
    host_ip: item.host_ip || '',
    set: item.set || '',
    pod_status: item.pod_status || '',
    version: item.version || '',
    namespace: item.namespace || '',
    deployment_id: item.deployment_id || '',
    cluster_id: item.cluster_id || '',
    container: declaredContainer || validation.container || '',
    login_pod_addr: loginPodAddr,
    login_url_source: loginPodAddr ? 'lexiao' : 'missing',
    login_url_validation: validation,
    cpu_limit: item.cpu_limit || '',
    memory_limit: item.memory_limit || '',
    raw: item,
  };
}

function pickEnvs(allEnvs, envArg) {
  const requested = splitList(envArg || DEFAULT_ENV).map(envOf);
  if (requested.includes('all')) return allEnvs.map((item) => item.env);
  const available = new Set(allEnvs.map((item) => item.env));
  return requested.filter((env) => available.has(env));
}

function table(headers, rows) {
  const widths = headers.map((header, index) => Math.max(
    String(header).length,
    ...rows.map((row) => String(row[index] === undefined ? '' : row[index]).length),
  ));
  const fmt = (row) => row.map((cell, index) => String(cell === undefined ? '' : cell).padEnd(widths[index])).join('  ');
  return [fmt(headers), fmt(widths.map((width) => '-'.repeat(width))), ...rows.map(fmt)].join('\n');
}

function printTable(result, args) {
  console.log(`app: ${result.app.app_name} (fid=${result.app.fid}, project=${result.app.project_name || '-'})`);
  console.log(`profile: ${result.profile}`);
  console.log(`env: ${result.envs.join(', ') || '-'}`);
  console.log(`counts: vm=${result.instances.vm.length}, pod=${result.instances.pod.length}`);
  if (result.app.inferred_from) {
    console.log(`inferred_from: ${result.app.inferred_from.file}`);
  }

  const rows = [];
  for (const item of result.instances.vm) {
    rows.push([
      item.env,
      'vm',
      item.ip,
      item.set || item.set_name,
      item.run_status,
      item.app_version,
      item.jdk_version,
      item.biz_line,
    ]);
  }
  for (const item of result.instances.pod) {
    rows.push([
      item.env,
      'pod',
      item.pod_ip || item.pod_name,
      item.set || item.namespace,
      item.pod_status,
      item.version,
      item.host_ip,
      args['show-login-url'] ? item.login_pod_addr : item.namespace,
    ]);
  }
  if (!rows.length) {
    console.log('no instances found');
    return;
  }
  console.log(table(['env', 'type', 'address', 'set/namespace', 'status', 'version', 'jdk/host', 'extra'], rows));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const limit = Number(args.limit || DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error('--limit must be an integer between 1 and 500');
  }

  const selectedType = typeOf(args.type || 'all');
  if (!['all', 'vm', 'pod'].includes(selectedType)) {
    throw new Error(`Unsupported --type: ${args.type}`);
  }

  const { context, page, profile, networkPolicy } = await openLoggedInPage(args);
  try {
    const app = await resolveApp(page, args);
    await page.goto(`https://lexiao.oa.fenqile.com/#/editApp?app_id=${app.fid}&type=machine`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(800);

    const allEnvs = await queryEnvs(page, app.fid);
    const envs = pickEnvs(allEnvs, args.env || DEFAULT_ENV);
    if (!envs.length) {
      throw new Error(`No requested env found. requested=${args.env || DEFAULT_ENV}, available=${allEnvs.map((item) => item.env).join(',')}`);
    }

    const jdkVersions = selectedType !== 'pod' ? await queryJdkVersions(page, app.app_name || app.name) : new Map();
    const instances = { vm: [], pod: [] };
    for (const env of envs) {
      if (selectedType === 'all' || selectedType === 'vm') {
        const rows = await queryVm(page, app.fid, env, limit);
        instances.vm.push(...rows.map((item) => normalizeVm(item, jdkVersions)));
      }
      if (selectedType === 'all' || selectedType === 'pod') {
        const rows = await queryPod(page, app.fid, env, limit);
        instances.pod.push(...rows.map(normalizePod));
      }
    }

    const output = {
      queried_at: new Date().toISOString(),
      profile,
      network_policy: networkPolicy,
      defaults: {
        env: DEFAULT_ENV,
        app_inferred: !args.app && !args['app-id'],
      },
      app,
      available_envs: allEnvs,
      envs,
      type: selectedType,
      instances,
      counts: {
        vm: instances.vm.length,
        pod: instances.pod.length,
        total: instances.vm.length + instances.pod.length,
      },
      source_urls: {
        app_page: `https://lexiao.oa.fenqile.com/#/editApp?app_id=${app.fid}&type=machine`,
        envs: `${API_BASE}/oa/publish/appmachine/listAppMachineEnvs.json`,
        vm: `${API_BASE}/oa/publish/appMachine/getAppMachineDistinct.json`,
        pod: `${API_BASE}/oa/publish/devops/pod/getAppPodInfo.json`,
      },
    };

    if (args.json || args.format === 'json') {
      console.log(JSON.stringify(output, null, 2));
    } else {
      printTable(output, args);
    }
  } finally {
    await context.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  normalizePod,
  parseArgs,
  pickEnvs,
  resolveApp,
};
