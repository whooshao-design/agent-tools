#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const {
  buildPaths,
  fetchJson,
  loadChromium,
  normalizeEnv,
  parseActive,
  parseArgs,
  resolveAppId,
  resolveBaseUrl,
  resolveSite,
} = require('../../configure-hippo/scripts/hippo_draft_config');
const {
  buildBrowserEnv,
  chromiumArgsFor,
} = require('../../get-browser-session/scripts/browser_network');

const DEFAULT_PROFILE = '/home/joney/.cache/healthy-dashboard-profile';
const DEFAULT_TOOL_DIR = path.join(os.homedir(), 'tools/lexiao-browser');
const DEFAULT_ENV = 'prod';
const DEFAULT_CLUSTER = 'default';
const DEFAULT_NAMESPACE = 'application';
const DEFAULT_APP_SCAN_LIMIT = 60;
const DEFAULT_MAX_APPS = 8;
const NAMESPACE_PAGE_SIZE = 100;
const VALUE_PREVIEW_CHARS = 200;
const SCAN_CONCURRENCY = 5;
const COMMANDS = new Set(['get', 'list', 'dump', 'apps', 'find', 'self-test', 'help']);

class QueryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new QueryError(code, message, details);
}

function assert(condition, code, message, details) {
  if (!condition) fail(code, message, details);
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (String(value || '').startsWith('~/')) return path.join(os.homedir(), String(value).slice(2));
  return value;
}

function optionalString(value) {
  return value === undefined || value === true ? '' : String(value);
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function splitKeys(value) {
  return optionalString(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureCommandFor(baseUrl, profile) {
  return 'node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js'
    + ` --ensure --profile=${profile} --url=${baseUrl}/#/app/dashboard --success-text=Welcome`;
}

function resolveTarget(args, options = {}) {
  const requestedEnv = args.env === undefined || args.env === true ? DEFAULT_ENV : String(args.env);
  const site = resolveSite(requestedEnv, args['hippo-site']);
  const env = normalizeEnv(requestedEnv, site);
  const baseUrl = resolveBaseUrl(env, requestedEnv, args['hippo-site']);
  const toolDir = path.resolve(expandHome(args['tool-dir'] || DEFAULT_TOOL_DIR));
  return {
    appId: options.appId !== undefined ? options.appId : resolveAppId(args),
    env,
    site,
    cluster: String(args.cluster || DEFAULT_CLUSTER),
    namespaceName: String(args.namespace || DEFAULT_NAMESPACE),
    baseUrl,
    dashboardUrl: `${baseUrl}/#/app/dashboard`,
    expectedHost: new URL(baseUrl).hostname,
    profile: path.resolve(expandHome(args.profile || DEFAULT_PROFILE)),
    toolDir,
    chromePath: path.resolve(expandHome(args.chrome || path.join(toolDir, 'browsers/chrome-linux64/chrome'))),
    runtimeLibDir: path.resolve(expandHome(args['runtime-lib-dir']
      || path.join(toolDir, 'runtime-libs/usr/lib/x86_64-linux-gnu'))),
  };
}

// 页内 fetch 而不是 fetch_with_session：后者的响应字符上限是 100000，
// 而真实应用的 application namespace 可能超过该上限，被截断后无法判断 key 是否存在。
async function openHippoPage(target) {
  const chromium = loadChromium(target);
  const network = buildBrowserEnv(target.baseUrl, process.env);
  const env = { ...network.env };
  env.LD_LIBRARY_PATH = [target.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  let context;
  try {
    context = await chromium.launchPersistentContext(target.profile, {
      executablePath: target.chromePath,
      headless: true,
      env,
      args: chromiumArgsFor(target.baseUrl, ['--no-sandbox']),
    });
  } catch (error) {
    if (/ProcessSingleton|SingletonLock|profile.*use|already in use/i.test(String(error.stack || error))) {
      fail('PROFILE_IN_USE', '浏览器 profile 正被占用，请关闭对应 Chromium 后重试', { profile: target.profile });
    }
    throw error;
  }
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(target.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const host = new URL(page.url()).hostname;
    assert(host === target.expectedHost, 'LOGIN_REQUIRED', 'Hippo 登录态不可用或被门户拦截', {
      expectedHost: target.expectedHost,
      actualHost: host,
      ensureCommand: ensureCommandFor(target.baseUrl, target.profile),
    });
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

// fetchJson 在 !ok 或非 JSON 时抛 HIPPO_* 码；对只读查询来说这两种情况几乎都是登录态问题。
function remapFetchError(error, target) {
  if (error.code === 'HIPPO_GET_FAILED' && Number(error.details && error.details.status) === 403) {
    fail('FORBIDDEN', '当前账号无该应用配置的查看权限', { ...error.details, appId: target.appId });
  }
  if (error.code === 'HIPPO_GET_FAILED' || error.code === 'HIPPO_RESPONSE_NOT_JSON') {
    fail('LOGIN_REQUIRED', 'Hippo 未返回配置 JSON，通常是登录态失效', {
      ...error.details,
      ensureCommand: ensureCommandFor(target.baseUrl, target.profile),
    });
  }
  throw error;
}

function baseResult(command, target, url, active) {
  const release = active.release || {};
  return {
    ok: true,
    command,
    host: target.baseUrl,
    url,
    appId: target.appId,
    env: target.env,
    cluster: target.cluster,
    namespace: target.namespaceName,
    hasActiveRelease: Boolean(active.release),
    releaseKey: release.releaseKey || '',
    releasedBy: release.dataChangeCreatedBy || '',
    releasedTime: release.dataChangeCreatedTime || '',
    releaseComment: release.comment || '',
    totalKeys: Object.keys(active.configurations).length,
    configurationsChars: String(active.rawConfigurations || '').length,
  };
}

function selectKeys(configurations, keys, keyPrefix) {
  const names = Object.keys(configurations);
  const selected = new Set(keys.filter((key) => names.includes(key)));
  if (keyPrefix) names.filter((name) => name.startsWith(keyPrefix)).forEach((name) => selected.add(name));
  const matched = {};
  [...selected].sort().forEach((name) => { matched[name] = String(configurations[name] ?? ''); });
  return { matched, missingKeys: keys.filter((key) => !names.includes(key)).sort() };
}

function buildResult(command, target, url, active, args) {
  const result = baseResult(command, target, url, active);
  const keys = splitKeys(args.key);
  const keyPrefix = optionalString(args['key-prefix']);
  if (command === 'get') {
    assert(keys.length > 0 || keyPrefix, 'KEY_REQUIRED', 'get 必须传 --key 或 --key-prefix');
    return { ...result, requestedKeys: keys, ...selectKeys(active.configurations, keys, keyPrefix) };
  }
  if (command === 'list') {
    const names = Object.keys(active.configurations).sort()
      .filter((name) => !keyPrefix || name.startsWith(keyPrefix));
    return { ...result, keyPrefix: keyPrefix || undefined, keys: names };
  }
  const configurations = {};
  Object.keys(active.configurations).sort()
    .forEach((name) => { configurations[name] = String(active.configurations[name] ?? ''); });
  return { ...result, configurations };
}

// namespace 列表接口在不同 Hippo 版本里把名字放在不同层级，这里一次性兼容。
function namespaceNamesFrom(payload) {
  const rows = Array.isArray(payload) ? payload : (payload.elements || payload.content || []);
  const names = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = row?.namespace?.namespaceName || row?.namespaceName || row?.baseInfo?.namespaceName;
    if (name && !names.includes(String(name))) names.push(String(name));
  }
  return names;
}

function matchKeys(configurations, { keys = [], keyPrefix = '', keyContains = '' }) {
  const names = Object.keys(configurations);
  const selected = new Set(keys.filter((key) => names.includes(key)));
  if (keyPrefix) names.filter((name) => name.startsWith(keyPrefix)).forEach((name) => selected.add(name));
  if (keyContains) {
    const needle = keyContains.toLowerCase();
    names.filter((name) => name.toLowerCase().includes(needle)).forEach((name) => selected.add(name));
  }
  return [...selected].sort();
}

function previewValue(raw) {
  const value = String(raw ?? '');
  return {
    value: value.length > VALUE_PREVIEW_CHARS ? `${value.slice(0, VALUE_PREVIEW_CHARS)}…` : value,
    valueChars: value.length,
    valueTruncated: value.length > VALUE_PREVIEW_CHARS,
  };
}

function envsOfNavtree(navtree) {
  const envs = [];
  const clusters = new Set();
  for (const entity of navtree?.entities || []) {
    const name = entity?.body?.env?.name;
    if (name && !envs.includes(name)) envs.push(name);
    for (const cluster of entity?.body?.clusters || []) {
      if (cluster?.name) clusters.add(String(cluster.name));
    }
  }
  return { envs, clusters: [...clusters] };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// 只保留在目标 env 真正挂了 cluster 的应用：apps/list 是全站元数据，
// 海外站点尤其容易搜到一堆国内应用，直接拿去查 active release 只会得到 404。
async function searchApps(page, target, keyword, { limit, allEnvs }) {
  const payload = await fetchJson(page, `/apps/list?appId=${encodeURIComponent(keyword)}&page=0&size=${limit}`);
  const rows = payload.elements || payload.content || [];
  const candidates = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ appId: row.appId, name: row.name || '', ownerName: row.ownerName || '' }))
    .filter((row) => row.appId);
  const detailed = await mapWithConcurrency(candidates, SCAN_CONCURRENCY, async (candidate) => {
    let navtree;
    try {
      navtree = await fetchJson(page, `/apps/${encodeURIComponent(candidate.appId)}/navtree`);
    } catch (_) {
      return { ...candidate, envs: [], clusters: [] };
    }
    return { ...candidate, ...envsOfNavtree(navtree) };
  });
  const matched = detailed.filter((row) => (allEnvs ? row.envs.length > 0 : row.envs.includes(target.env)));
  return { scanned: candidates.length, matched };
}

async function scanNamespaces(page, target, appId, selector) {
  const root = `/apps/${encodeSegment(appId)}/envs/${encodeSegment(target.env)}/clusters/${encodeSegment(target.cluster)}`;
  const listPath = `${root}/namespacePubTypes/__app__/groupId/0/page/0/size/${NAMESPACE_PAGE_SIZE}?searchNamespace=`;
  const namespaces = namespaceNamesFrom(await fetchJson(page, listPath));
  const scans = await mapWithConcurrency(namespaces, SCAN_CONCURRENCY, async (namespaceName) => {
    const activePath = `${root}/namespaces/${encodeSegment(namespaceName)}/releases/active?page=0&size=1`;
    let active;
    try {
      active = parseActive(await fetchJson(page, activePath));
    } catch (_) {
      return { namespaceName, hits: [], unreadable: true };
    }
    if (!active.release) return { namespaceName, hits: [] };
    const release = active.release;
    const hits = matchKeys(active.configurations, selector).map((key) => ({
      appId,
      namespace: namespaceName,
      key,
      ...previewValue(active.configurations[key]),
      releaseKey: release.releaseKey || '',
      releasedBy: release.dataChangeCreatedBy || '',
      releasedTime: release.dataChangeCreatedTime || '',
      totalKeys: Object.keys(active.configurations).length,
      url: `${target.baseUrl}${activePath}`,
    }));
    return { namespaceName, hits };
  });
  return {
    namespaces,
    unreadable: scans.filter((scan) => scan.unreadable).map((scan) => scan.namespaceName),
    hits: scans.flatMap((scan) => scan.hits),
  };
}

async function runApps(args) {
  const target = resolveTarget(args, { appId: '' });
  const keyword = optionalString(args.keyword || args['app-keyword'] || args._[1]).trim();
  assert(keyword, 'KEYWORD_REQUIRED', 'apps 必须传 --keyword=<关键字>');
  const limit = Number(args.limit || DEFAULT_APP_SCAN_LIMIT);
  const allEnvs = Boolean(args['all-envs']);
  const browser = await openHippoPage(target);
  try {
    const found = await searchApps(browser.page, target, keyword, { limit, allEnvs });
    return {
      ok: true,
      command: 'apps',
      host: target.baseUrl,
      env: target.env,
      keyword,
      scannedApps: found.scanned,
      scanLimit: limit,
      scanTruncated: found.scanned >= limit,
      matched: found.matched,
      note: allEnvs
        ? '已列出在任意 env 有 cluster 的应用'
        : `已过滤为在 ${target.env} 有 cluster 的应用；加 --all-envs 可看全部 env`,
    };
  } catch (error) {
    return remapFetchError(error, target);
  } finally {
    await browser.context.close().catch(() => {});
  }
}

async function runFind(args) {
  const appKeyword = optionalString(args['app-keyword']).trim();
  const explicitAppId = optionalString(args['app-id']).trim();
  const target = appKeyword
    ? resolveTarget(args, { appId: explicitAppId })
    : resolveTarget(args);
  const selector = {
    keys: splitKeys(args.key),
    keyPrefix: optionalString(args['key-prefix']),
    keyContains: optionalString(args['key-contains']),
  };
  assert(selector.keys.length || selector.keyPrefix || selector.keyContains,
    'KEY_REQUIRED', 'find 必须传 --key、--key-prefix 或 --key-contains');
  assert(target.appId || appKeyword, 'APP_ID_REQUIRED', 'find 必须传 --app-id 或 --app-keyword');
  const maxApps = Number(args['max-apps'] || DEFAULT_MAX_APPS);
  const browser = await openHippoPage(target);
  try {
    let appIds = [target.appId].filter(Boolean);
    let appCandidates = null;
    if (!appIds.length) {
      const found = await searchApps(browser.page, target, appKeyword, {
        limit: Number(args.limit || DEFAULT_APP_SCAN_LIMIT),
        allEnvs: false,
      });
      appCandidates = found.matched.map((row) => row.appId);
      appIds = appCandidates.slice(0, maxApps);
    }
    assert(appIds.length, 'APP_NOT_FOUND', `${target.env} 下没有匹配 --app-keyword 的应用`, {
      appKeyword,
      env: target.env,
    });
    const scans = await mapWithConcurrency(appIds, 2,
      (appId) => scanNamespaces(browser.page, target, appId, selector));
    const hits = scans.flatMap((scan) => scan.hits);
    return {
      ok: true,
      command: 'find',
      host: target.baseUrl,
      env: target.env,
      cluster: target.cluster,
      selector: {
        key: selector.keys,
        keyPrefix: selector.keyPrefix || undefined,
        keyContains: selector.keyContains || undefined,
      },
      scannedApps: appIds,
      appCandidates: appCandidates && appCandidates.length > appIds.length ? appCandidates : undefined,
      appsTruncated: Boolean(appCandidates && appCandidates.length > appIds.length),
      scannedNamespaces: scans.flatMap((scan) => scan.namespaces),
      unreadableNamespaces: scans.flatMap((scan) => scan.unreadable),
      hitCount: hits.length,
      hits,
      note: hits.length
        ? '值来自各 namespace 的 active release；超长值已截断，需要完整值用 get'
        : '在扫描到的 namespace 里没有命中；可换 --key-contains 放宽，或确认 env/cluster',
    };
  } catch (error) {
    return remapFetchError(error, target);
  } finally {
    await browser.context.close().catch(() => {});
  }
}

async function runQuery(command, args) {
  const target = resolveTarget(args);
  const activePath = buildPaths(target).active;
  const url = `${target.baseUrl}${activePath}`;
  if (command === 'get') {
    assert(splitKeys(args.key).length > 0 || optionalString(args['key-prefix']),
      'KEY_REQUIRED', 'get 必须传 --key 或 --key-prefix');
  }
  const browser = await openHippoPage(target);
  try {
    let rows;
    try {
      rows = await fetchJson(browser.page, activePath);
    } catch (error) {
      return remapFetchError(error, target);
    }
    return buildResult(command, target, url, parseActive(rows), args);
  } finally {
    await browser.context.close().catch(() => {});
  }
}

function helpText() {
  return `hippo_query.js —— Hippo 只读查询，页内取数、本地过滤，只输出目标 key

用法：
  node hippo_query.js get  --app-id=<appId> [--env=prod] --key=<key1,key2>
  node hippo_query.js list --app-id=<appId> [--key-prefix=<前缀>]
  node hippo_query.js dump --app-id=<appId>
  node hippo_query.js apps --keyword=<关键字> [--env=prod] [--all-envs]
  node hippo_query.js find --app-id=<appId>|--app-keyword=<关键字> --key=<key>|--key-contains=<片段>
  node hippo_query.js self-test

命令：
  get        查目标 key 的生效值，只输出命中项与 missingKeys
  list       只列 key 名与总数，不输出 value
  dump       输出整个 namespace 的 key/value（确认需要整包时才用）
  apps       应用名不明确时用：按关键字搜应用，只保留在目标 env 真正有 cluster 的
  find       namespace 不明确时用：扫该应用全部 namespace 定位 key，输出命中 namespace 与值
  self-test  纯逻辑自检，不联网

参数：
  --app-id=<应用名>        省略时从当前目录 app.properties 的 application.name 推断
  --env=prod               默认 prod；也接受 pre/gray/oa/stable/test/prj 及 fql_*/mxyw_*/ynyw_* 完整 env
  --hippo-site=standard|stable|mx|id  standard=hippo.oa.fenqile.com，stable=stable-hippo.oa.fenqile.com，
                           mx=hippo.oa.wowcredito.com（墨西哥，env 前缀 mxyw），
                           id=hippo.oa.kredito.id（印尼，env 前缀 ynyw）；
                           显式 env（如 pdwl_pre）需要 stable 域名时传 stable
  --cluster=default        默认 default
  --namespace=application  默认 application
  --key=a,b                get 必填之一；多个 key 用英文逗号分隔
  --key-prefix=<前缀>      get/list/find 可用，按前缀匹配
  --key-contains=<片段>    find 可用，按 key 名子串模糊匹配（只记得业务语义时用）
  --keyword=<关键字>       apps 必填，匹配 appId
  --app-keyword=<关键字>   find 可选；应用名也不确定时先搜应用再扫 namespace
  --limit=60               apps/find 搜应用时的扫描上限
  --max-apps=8             find 用 --app-keyword 时最多扫描几个应用
  --all-envs               apps 可用，不按当前 env 过滤
  --profile=${DEFAULT_PROFILE}

失败码：
  LOGIN_REQUIRED  登录态失效或被门户拦截，按 details.ensureCommand 刷新后重试
  PROFILE_IN_USE  profile 被其它 Chromium 占用
  FORBIDDEN       当前账号无该应用查看权限
  ACTIVE_RESPONSE_INVALID / ACTIVE_CONFIG_INVALID  响应或 configurations 不是预期结构
  KEYWORD_REQUIRED / APP_ID_REQUIRED / APP_NOT_FOUND  apps/find 的入参或搜索结果为空
`;
}

function expectFailure(code, run) {
  let actual = '';
  try {
    run();
  } catch (error) {
    actual = error.code || '';
  }
  assert(actual === code, 'SELF_TEST_FAILED', `期望失败码 ${code}，实际 ${actual || '无异常'}`);
}

function runSelfTest() {
  assert(normalizeEnv(DEFAULT_ENV) === 'fql_prod', 'SELF_TEST_FAILED', '默认环境应为 fql_prod');
  assert(resolveBaseUrl('fql_prod', 'prod') === 'http://hippo.oa.fenqile.com',
    'SELF_TEST_FAILED', '标准域名映射失败');
  assert(resolveBaseUrl('fql_pre', 'stable') === 'http://stable-hippo.oa.fenqile.com',
    'SELF_TEST_FAILED', 'stable 域名映射失败');
  assert(resolveBaseUrl('pdwl_pre', 'pdwl_pre', 'stable') === 'http://stable-hippo.oa.fenqile.com',
    'SELF_TEST_FAILED', '显式 stable 站点映射失败');
  const mxTarget = resolveTarget({ 'app-id': 'demo', env: 'prod', 'hippo-site': 'mx' });
  assert(mxTarget.env === 'mxyw_prod' && mxTarget.baseUrl === 'https://hippo.oa.wowcredito.com',
    'SELF_TEST_FAILED', '墨西哥站点解析失败');
  const idTarget = resolveTarget({ 'app-id': 'demo', env: 'ynyw_prod' });
  assert(idTarget.env === 'ynyw_prod' && idTarget.baseUrl === 'https://hippo.oa.kredito.id',
    'SELF_TEST_FAILED', '印尼站点解析失败');
  assert(`${idTarget.baseUrl}${buildPaths(idTarget).active}`
    === 'https://hippo.oa.kredito.id/apps/demo/envs/ynyw_prod/clusters/default'
    + '/namespaces/application/releases/active?page=0&size=1',
    'SELF_TEST_FAILED', '印尼 active URL 拼接失败');
  assert(JSON.stringify(splitKeys(' a , b ,')) === JSON.stringify(['a', 'b']),
    'SELF_TEST_FAILED', 'key 拆分失败');
  assert(splitKeys(true).length === 0, 'SELF_TEST_FAILED', '空 --key 应解析为空列表');

  const target = resolveTarget({ 'app-id': 'demo', env: 'prod' });
  assert(target.env === 'fql_prod' && target.namespaceName === 'application' && target.cluster === 'default',
    'SELF_TEST_FAILED', '默认 target 解析失败');
  const url = `${target.baseUrl}${buildPaths(target).active}`;
  assert(url === 'http://hippo.oa.fenqile.com/apps/demo/envs/fql_prod/clusters/default'
    + '/namespaces/application/releases/active?page=0&size=1', 'SELF_TEST_FAILED', 'active URL 拼接失败');

  const rows = [{
    releaseKey: 'r-1',
    comment: 'demo',
    dataChangeCreatedBy: 'someone',
    dataChangeCreatedTime: '2026-08-05T10:00:00.000+0800',
    configurations: JSON.stringify({ 'a.switch': 'true', 'a.timeout': '200', 'b.switch': 'false' }),
  }];
  const active = parseActive(rows);
  const got = buildResult('get', target, url, active, { key: 'a.switch,missing.key' });
  assert(got.totalKeys === 3, 'SELF_TEST_FAILED', 'totalKeys 统计失败');
  assert(got.releaseKey === 'r-1' && got.releasedBy === 'someone', 'SELF_TEST_FAILED', 'release 元信息丢失');
  assert(JSON.stringify(got.matched) === JSON.stringify({ 'a.switch': 'true' }),
    'SELF_TEST_FAILED', 'get 命中项过滤失败');
  assert(JSON.stringify(got.missingKeys) === JSON.stringify(['missing.key']),
    'SELF_TEST_FAILED', 'missingKeys 计算失败');
  const prefixed = buildResult('get', target, url, active, { 'key-prefix': 'a.' });
  assert(JSON.stringify(Object.keys(prefixed.matched)) === JSON.stringify(['a.switch', 'a.timeout']),
    'SELF_TEST_FAILED', 'key-prefix 过滤失败');
  expectFailure('KEY_REQUIRED', () => buildResult('get', target, url, active, {}));
  const listed = buildResult('list', target, url, active, {});
  assert(JSON.stringify(listed.keys) === JSON.stringify(['a.switch', 'a.timeout', 'b.switch']),
    'SELF_TEST_FAILED', 'list key 排序失败');
  assert(!Object.prototype.hasOwnProperty.call(listed, 'configurations'),
    'SELF_TEST_FAILED', 'list 不应输出 value');
  const dumped = buildResult('dump', target, url, active, {});
  assert(dumped.configurations['b.switch'] === 'false', 'SELF_TEST_FAILED', 'dump 输出失败');

  const emptyResult = buildResult('get', target, url, parseActive([]), { key: 'a.switch' });
  assert(emptyResult.hasActiveRelease === false && emptyResult.totalKeys === 0,
    'SELF_TEST_FAILED', '空 active release 处理失败');
  assert(JSON.stringify(emptyResult.missingKeys) === JSON.stringify(['a.switch']),
    'SELF_TEST_FAILED', '空 active release 的 missingKeys 计算失败');

  expectFailure('FORBIDDEN', () => remapFetchError(
    Object.assign(new Error('x'), { code: 'HIPPO_GET_FAILED', details: { status: 403 } }), target));
  expectFailure('LOGIN_REQUIRED', () => remapFetchError(
    Object.assign(new Error('x'), { code: 'HIPPO_RESPONSE_NOT_JSON', details: { status: 200 } }), target));
  expectFailure('ACTIVE_CONFIG_INVALID', () => parseActive([{ configurations: 'not-json' }]));

  const nsPayload = {
    elements: [
      { namespace: { namespaceName: 'application' } },
      { namespaceName: 'test_task' },
      { baseInfo: { namespaceName: 'comm_strategy_node' } },
      { namespace: { namespaceName: 'application' } },
    ],
  };
  assert(JSON.stringify(namespaceNamesFrom(nsPayload))
    === JSON.stringify(['application', 'test_task', 'comm_strategy_node']),
    'SELF_TEST_FAILED', 'namespace 名解析或去重失败');
  const config = { use_append_for_simulate_report: 'true', simulate_report_size: '10', other: 'x' };
  assert(JSON.stringify(matchKeys(config, { keys: ['use_append_for_simulate_report'] }))
    === JSON.stringify(['use_append_for_simulate_report']), 'SELF_TEST_FAILED', 'find 精确匹配失败');
  assert(JSON.stringify(matchKeys(config, { keyContains: 'SIMULATE' }))
    === JSON.stringify(['simulate_report_size', 'use_append_for_simulate_report']),
    'SELF_TEST_FAILED', 'find 模糊匹配应忽略大小写');
  assert(JSON.stringify(matchKeys(config, { keyPrefix: 'simulate' }))
    === JSON.stringify(['simulate_report_size']), 'SELF_TEST_FAILED', 'find 前缀匹配失败');
  assert(matchKeys(config, {}).length === 0, 'SELF_TEST_FAILED', '空选择器不应命中任何 key');
  const long = previewValue('x'.repeat(VALUE_PREVIEW_CHARS + 50));
  assert(long.valueTruncated && long.valueChars === VALUE_PREVIEW_CHARS + 50
    && long.value.length === VALUE_PREVIEW_CHARS + 1, 'SELF_TEST_FAILED', '长 value 截断失败');
  assert(previewValue('true').valueTruncated === false, 'SELF_TEST_FAILED', '短 value 不应标记截断');
  const nav = envsOfNavtree({
    entities: [
      { body: { env: { name: 'mxyw_pre' }, clusters: [{ name: 'default' }] } },
      { body: { env: { name: 'mxyw_prod' }, clusters: [{ name: 'default' }] } },
      { body: {} },
    ],
  });
  assert(JSON.stringify(nav.envs) === JSON.stringify(['mxyw_pre', 'mxyw_prod'])
    && JSON.stringify(nav.clusters) === JSON.stringify(['default']),
    'SELF_TEST_FAILED', 'navtree env/cluster 解析失败');
  assert(envsOfNavtree({ entities: [] }).envs.length === 0, 'SELF_TEST_FAILED', '空 navtree 应返回空 env');
  process.stdout.write(`${JSON.stringify({ ok: true, command: 'self-test', checks: 'passed' }, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || (args.help ? 'help' : '');
  if (!command || command === 'help') {
    process.stdout.write(helpText());
    return;
  }
  assert(COMMANDS.has(command), 'COMMAND_INVALID', `不支持的 command: ${command}`);
  if (command === 'self-test') {
    runSelfTest();
    return;
  }
  if (command === 'apps') {
    process.stdout.write(`${JSON.stringify(await runApps(args), null, 2)}\n`);
    return;
  }
  if (command === 'find') {
    process.stdout.write(`${JSON.stringify(await runFind(args), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await runQuery(command, args), null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error.code || 'UNEXPECTED_ERROR',
      message: String(error.message || error),
      details: error.details || {},
    }, null, 2)}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildResult,
  envsOfNavtree,
  matchKeys,
  namespaceNamesFrom,
  previewValue,
  remapFetchError,
  resolveTarget,
  selectKeys,
  splitKeys,
};
