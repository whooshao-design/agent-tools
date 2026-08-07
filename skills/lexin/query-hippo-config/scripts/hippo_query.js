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
} = require('../../configure-hippo/scripts/hippo_draft_config');
const {
  buildBrowserEnv,
  chromiumArgsFor,
} = require('../../get-browser-session/scripts/browser_network');

const DEFAULT_PROFILE = '/tmp/healthy-dashboard-profile';
const DEFAULT_TOOL_DIR = path.join(os.homedir(), 'tools/lexiao-browser');
const DEFAULT_ENV = 'prod';
const DEFAULT_CLUSTER = 'default';
const DEFAULT_NAMESPACE = 'application';
const COMMANDS = new Set(['get', 'list', 'dump', 'self-test', 'help']);

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

function resolveTarget(args) {
  const requestedEnv = args.env === undefined || args.env === true ? DEFAULT_ENV : String(args.env);
  const env = normalizeEnv(requestedEnv);
  const baseUrl = resolveBaseUrl(env, requestedEnv, args['hippo-site']);
  const toolDir = path.resolve(expandHome(args['tool-dir'] || DEFAULT_TOOL_DIR));
  return {
    appId: resolveAppId(args),
    env,
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
  node hippo_query.js self-test

命令：
  get        查目标 key 的生效值，只输出命中项与 missingKeys
  list       只列 key 名与总数，不输出 value
  dump       输出整个 namespace 的 key/value（确认需要整包时才用）
  self-test  纯逻辑自检，不联网

参数：
  --app-id=<应用名>        省略时从当前目录 app.properties 的 application.name 推断
  --env=prod               默认 prod；也接受 pre/gray/oa/stable/test/prj 及 fql_* 完整 env
  --hippo-site=stable|standard  显式 env（如 pdwl_pre）需要 stable 域名时传 stable
  --cluster=default        默认 default
  --namespace=application  默认 application
  --key=a,b                get 必填之一；多个 key 用英文逗号分隔
  --key-prefix=<前缀>      get/list 可用，按前缀匹配
  --profile=${DEFAULT_PROFILE}

失败码：
  LOGIN_REQUIRED  登录态失效或被门户拦截，按 details.ensureCommand 刷新后重试
  PROFILE_IN_USE  profile 被其它 Chromium 占用
  FORBIDDEN       当前账号无该应用查看权限
  ACTIVE_RESPONSE_INVALID / ACTIVE_CONFIG_INVALID  响应或 configurations 不是预期结构
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
  remapFetchError,
  resolveTarget,
  selectKeys,
  splitKeys,
};
