#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TextDecoder } = require('util');
const { createRequire } = require('module');
const {
  buildBrowserEnv,
  chromiumArgsFor,
} = require('../../get-browser-session/scripts/browser_network');

const BASE_URL = 'http://hippo.oa.fenqile.com';
const DASHBOARD_URL = `${BASE_URL}/#/app/dashboard`;
const DEFAULT_PROFILE = '/tmp/healthy-dashboard-profile';
const DEFAULT_TOOL_DIR = path.join(os.homedir(), 'tools/lexiao-browser');
const COMMANDS = new Set(['doctor', 'status', 'plan', 'upsert', 'verify', 'self-test', 'help']);
const ENV_ALIASES = {
  pre: 'fql_pre',
  '预发': 'fql_pre',
  '预发布': 'fql_pre',
  gray: 'fql_gray',
  '灰度': 'fql_gray',
  oa: 'fql_oa',
  prod: 'fql_prod',
  production: 'fql_prod',
  '生产': 'fql_prod',
  '线上': 'fql_prod',
};

class HippoError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HippoError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new HippoError(code, message, details);
}

function assert(condition, code, message, details) {
  if (!condition) fail(code, message, details);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (String(value || '').startsWith('~/')) return path.join(os.homedir(), String(value).slice(2));
  return value;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    if (equals >= 0) {
      args[token.slice(2, equals)] = token.slice(equals + 1);
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args[token.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      args[token.slice(2)] = true;
    }
  }
  return args;
}

function normalizeEnv(value) {
  const raw = String(value || 'fql_pre').trim().toLowerCase();
  return ENV_ALIASES[raw] || raw;
}

function readUtf8File(filePath, label, allowEmpty = true) {
  const absolute = path.resolve(expandHome(filePath));
  assert(fs.existsSync(absolute), 'FILE_NOT_FOUND', `${label}文件不存在`, { file: absolute });
  const buffer = fs.readFileSync(absolute);
  let value;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    fail('FILE_NOT_UTF8', `${label}必须是 UTF-8 文件`, { file: absolute });
  }
  if (!allowEmpty) {
    assert(value.length > 0, 'EMPTY_VALUE_REJECTED', '配置值文件为空；明确需要空值时传 --allow-empty-value');
  }
  return value;
}

function parseApplicationName(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*application\.name\s*[=:]\s*(.*?)\s*$/);
    if (match && match[1] && !match[1].includes('${')) return match[1];
  }
  return '';
}

function discoverAppNames(projectDir) {
  const root = path.resolve(expandHome(projectDir || process.cwd()));
  const values = new Map();
  const ignored = new Set(['.git', '.idea', '.gradle', 'node_modules', 'target', 'dist', 'build']);
  const queue = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < 10000) {
    const current = queue.shift();
    visited += 1;
    let entries;
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current.directory, entry.name);
      if (entry.isFile() && entry.name === 'app.properties') {
        const appName = parseApplicationName(fullPath);
        if (appName) {
          if (!values.has(appName)) values.set(appName, []);
          values.get(appName).push(fullPath);
        }
      } else if (entry.isDirectory() && current.depth < 7 && !ignored.has(entry.name)) {
        queue.push({ directory: fullPath, depth: current.depth + 1 });
      }
    }
  }
  return { root, values };
}

function resolveAppId(args) {
  if (args['app-id']) return String(args['app-id']).trim();
  const discovered = discoverAppNames(args['project-dir']);
  const names = [...discovered.values.keys()].sort();
  assert(names.length > 0, 'APP_ID_NOT_FOUND', '未找到 application.name，请传 --app-id', {
    projectDir: discovered.root,
  });
  assert(names.length === 1, 'APP_ID_AMBIGUOUS', '发现多个 application.name，请传 --app-id 明确选择', {
    projectDir: discovered.root,
    candidates: names,
  });
  return names[0];
}

function encodeSegment(value) {
  return encodeURIComponent(String(value));
}

function buildPaths(target) {
  const root = `/apps/${encodeSegment(target.appId)}`
    + `/envs/${encodeSegment(target.env)}`
    + `/clusters/${encodeSegment(target.cluster)}`
    + `/namespaces/${encodeSegment(target.namespaceName)}`;
  return {
    items: `${root}/items?orderBy=key`,
    item: `${root}/item`,
    active: `${root}/releases/active?page=0&size=1`,
  };
}

function valueMap(items) {
  return Object.fromEntries(items.map((item) => [String(item.key), String(item.value ?? '')]));
}

function diffKeys(items, activeConfig) {
  const draft = valueMap(items);
  const keys = new Set([...Object.keys(draft), ...Object.keys(activeConfig)]);
  return [...keys]
    .filter((key) => !hasOwn(draft, key) || !hasOwn(activeConfig, key) || draft[key] !== String(activeConfig[key] ?? ''))
    .sort();
}

function parseActive(activeRows) {
  assert(Array.isArray(activeRows), 'ACTIVE_RESPONSE_INVALID', 'active release 响应不是数组');
  if (!activeRows.length) return { release: null, configurations: {}, rawConfigurations: '' };
  const release = activeRows[0];
  const rawConfigurations = String(release.configurations || '{}');
  let configurations;
  try {
    configurations = JSON.parse(rawConfigurations);
  } catch (_) {
    fail('ACTIVE_CONFIG_INVALID', 'active release configurations 不是合法 JSON');
  }
  assert(configurations && typeof configurations === 'object' && !Array.isArray(configurations),
    'ACTIVE_CONFIG_INVALID', 'active release configurations 必须是对象');
  return { release, configurations, rawConfigurations };
}

function comparableItem(item) {
  return {
    id: item.id ?? null,
    namespaceId: item.namespaceId ?? null,
    key: String(item.key),
    value: String(item.value ?? ''),
    comment: String(item.comment ?? ''),
    plainText: item.plainText ?? null,
  };
}

function itemMap(items, excludedKey = '') {
  return new Map(items
    .filter((item) => String(item.key) !== excludedKey)
    .map((item) => [String(item.key), comparableItem(item)]));
}

function mapsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left.entries()) {
    if (!right.has(key) || JSON.stringify(value) !== JSON.stringify(right.get(key))) return false;
  }
  return true;
}

function assertTargetAfterMutation(beforeItem, afterItem, desired) {
  assert(afterItem, 'TARGET_ITEM_MISSING', '保存后目标配置项不存在');
  assert(String(afterItem.value ?? '') === desired.value, 'TARGET_ITEM_CHANGED',
    '保存后目标配置值与期望不一致');
  const expectedComment = desired.comment === undefined
    ? String(beforeItem?.comment ?? '')
    : desired.comment;
  assert(String(afterItem.comment ?? '') === expectedComment, 'TARGET_ITEM_CHANGED',
    '保存后目标配置备注与期望不一致');
  if (!beforeItem) return;
  for (const field of ['id', 'namespaceId', 'key', 'plainText']) {
    assert((afterItem[field] ?? null) === (beforeItem[field] ?? null), 'TARGET_ITEM_CHANGED',
      `保存后目标配置字段意外变化: ${field}`);
  }
}

function makeStateToken(target, targetItem, active) {
  const activeHasKey = hasOwn(active.configurations, target.key);
  const payload = {
    target,
    draft: targetItem ? {
      id: targetItem.id ?? null,
      namespaceId: targetItem.namespaceId ?? null,
      valueSha256: sha256(String(targetItem.value ?? '')),
      commentSha256: sha256(String(targetItem.comment ?? '')),
      modifiedTime: targetItem.dataChangeLastModifiedTime || '',
      modifiedBy: targetItem.dataChangeLastModifiedBy || '',
    } : { missing: true },
    active: {
      releaseKey: active.release?.releaseKey || '',
      hasKey: activeHasKey,
      valueSha256: activeHasKey ? sha256(String(active.configurations[target.key] ?? '')) : '',
    },
  };
  return sha256(JSON.stringify(payload));
}

function summarizeState(target, paths, state) {
  const active = parseActive(state.active);
  assert(Array.isArray(state.items), 'ITEMS_RESPONSE_INVALID', 'items 响应不是数组');
  const targets = state.items.filter((item) => String(item.key) === target.key);
  assert(targets.length <= 1, 'DUPLICATE_TARGET_ITEMS', '目标 key 在草稿 items 中出现多次', {
    count: targets.length,
  });
  const targetItem = targets[0] || null;
  const draftExists = Boolean(targetItem);
  const activeExists = hasOwn(active.configurations, target.key);
  const draftValue = draftExists ? String(targetItem.value ?? '') : '';
  const activeValue = activeExists ? String(active.configurations[target.key] ?? '') : '';
  const targetHasUnpublishedDraft = draftExists !== activeExists
    || (draftExists && activeExists && draftValue !== activeValue);
  return {
    targetItem,
    active,
    currentStateToken: makeStateToken(target, targetItem, active),
    summary: {
      target: `${target.appId}/${target.env}/${target.cluster}/${target.namespaceName}/${target.key}`,
      env: target.env,
      endpoints: paths,
      draftExists,
      activeExists,
      draftCharacters: draftExists ? draftValue.length : 0,
      draftLines: draftExists ? draftValue.split('\n').length : 0,
      draftSha256: draftExists ? sha256(draftValue) : null,
      activeCharacters: activeExists ? activeValue.length : 0,
      activeLines: activeExists ? activeValue.split('\n').length : 0,
      activeSha256: activeExists ? sha256(activeValue) : null,
      targetHasUnpublishedDraft,
      draftDiffKeys: diffKeys(state.items, active.configurations),
      currentStateToken: makeStateToken(target, targetItem, active),
      activeReleaseKey: active.release?.releaseKey || null,
      activeConfigurationsSha256: sha256(active.rawConfigurations),
      publishAttempted: false,
    },
  };
}

function desiredDiffKeys(beforeDiffKeys, target, activeConfig, desiredValue) {
  const result = new Set(beforeDiffKeys);
  result.delete(target.key);
  if (!hasOwn(activeConfig, target.key) || String(activeConfig[target.key] ?? '') !== desiredValue) {
    result.add(target.key);
  }
  return [...result].sort();
}

function readDesired(args) {
  assert(args['value-file'], 'VALUE_FILE_REQUIRED', 'plan/upsert/verify 必须传 --value-file');
  const value = readUtf8File(args['value-file'], '配置值', Boolean(args['allow-empty-value']));
  let comment;
  if (args['comment-file']) {
    comment = readUtf8File(args['comment-file'], '备注').trim();
  } else if (args.comment !== undefined) {
    comment = String(args.comment);
  }
  return { value, comment };
}

function planChange(target, summarized, desired, expectedToken) {
  const { targetItem, active, currentStateToken, summary } = summarized;
  if (expectedToken !== undefined) {
    assert(expectedToken === currentStateToken, 'CONCURRENT_DRAFT_CHANGED',
      '当前草稿与 plan 时不同，请重新运行 plan', { currentStateToken });
  }
  const draftEqualsDesired = Boolean(targetItem) && String(targetItem.value ?? '') === desired.value;
  const commentEqualsDesired = desired.comment === undefined
    || (Boolean(targetItem) && String(targetItem.comment ?? '') === desired.comment);
  const operation = draftEqualsDesired && commentEqualsDesired
    ? 'noop'
    : (targetItem ? 'update' : 'create');
  const guardRequired = operation !== 'noop' && summary.targetHasUnpublishedDraft;
  return {
    operation,
    guardRequired,
    draftEqualsDesired,
    commentWillChange: desired.comment !== undefined && !commentEqualsDesired,
    desiredCharacters: desired.value.length,
    desiredLines: desired.value.split('\n').length,
    desiredSha256: sha256(desired.value),
    expectedDraftDiffKeys: desiredDiffKeys(summary.draftDiffKeys, target, active.configurations, desired.value),
  };
}

function resolveRuntime(args, command) {
  const env = normalizeEnv(args.env);
  const target = command === 'doctor' ? null : {
    appId: resolveAppId(args),
    env,
    cluster: String(args.cluster || 'default'),
    namespaceName: String(args.namespace || 'application'),
    key: String(args.key || '').trim(),
  };
  if (target) assert(target.key, 'KEY_REQUIRED', `${command} 必须传 --key`);
  if (command === 'upsert' && env !== 'fql_pre') {
    assert(args['allow-non-pre'], 'NON_PRE_WRITE_REJECTED',
      `写入 ${env} 必须由用户明确指定环境并传 --allow-non-pre`);
  }
  const toolDir = path.resolve(expandHome(args['tool-dir'] || DEFAULT_TOOL_DIR));
  return {
    env,
    target,
    paths: target ? buildPaths(target) : null,
    profile: path.resolve(expandHome(args.profile || DEFAULT_PROFILE)),
    toolDir,
    chromePath: path.resolve(expandHome(args.chrome || path.join(toolDir, 'browsers/chrome-linux64/chrome'))),
    runtimeLibDir: path.resolve(expandHome(args['runtime-lib-dir']
      || path.join(toolDir, 'runtime-libs/usr/lib/x86_64-linux-gnu'))),
  };
}

function loadChromium(runtime) {
  const packageFile = path.join(runtime.toolDir, 'package.json');
  assert(fs.existsSync(packageFile), 'PLAYWRIGHT_NOT_FOUND', '未找到浏览器工具 package.json', {
    toolDir: runtime.toolDir,
  });
  assert(fs.existsSync(runtime.chromePath), 'CHROME_NOT_FOUND', '未找到 Chromium', {
    chromePath: runtime.chromePath,
  });
  return createRequire(packageFile)('playwright').chromium;
}

async function findInjector(page, timeoutMs) {
  try {
    await page.waitForFunction(() => {
      if (!window.angular) return false;
      const candidates = [
        document.documentElement,
        document.body,
        document.querySelector('#wrapper'),
        document.querySelector('.apollo-container'),
      ].filter(Boolean);
      return candidates.some((element) => {
        try {
          return Boolean(window.angular.element(element).injector());
        } catch (_) {
          return false;
        }
      });
    }, null, { timeout: timeoutMs });
    return true;
  } catch (_) {
    return false;
  }
}

async function pageDiagnosis(page) {
  return page.evaluate(() => ({
    title: document.title,
    url: location.href,
    host: location.hostname,
    hasPasswordInput: Boolean(document.querySelector('input[type="password"]')),
    hasPortalMarker: /atrust/i.test(location.hostname)
      || /Work Happy|QR Code|Use MOA|Account Login|Password Login|乐空间传送门|ATrust/i
        .test((document.body?.innerText || '').slice(0, 4000)),
  }));
}

async function serviceInfo(page) {
  return page.evaluate(() => {
    const candidates = [
      document.documentElement,
      document.body,
      document.querySelector('#wrapper'),
      document.querySelector('.apollo-container'),
    ].filter(Boolean);
    const injector = candidates.map((element) => {
      try {
        return window.angular.element(element).injector();
      } catch (_) {
        return null;
      }
    }).find(Boolean);
    if (!injector) return { injectorReady: false };
    let service;
    try {
      service = injector.get('ConfigService');
    } catch (_) {
      return { injectorReady: true, configServiceReady: false };
    }
    return {
      injectorReady: true,
      configServiceReady: true,
      createItemReady: typeof service.create_item === 'function',
      updateItemReady: typeof service.update_item === 'function',
      createItemArity: typeof service.create_item === 'function' ? service.create_item.length : null,
      updateItemArity: typeof service.update_item === 'function' ? service.update_item.length : null,
    };
  });
}

async function openHippo(runtime) {
  const chromium = loadChromium(runtime);
  const network = buildBrowserEnv(BASE_URL, process.env);
  const env = { ...network.env };
  env.LD_LIBRARY_PATH = [runtime.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  let context;
  try {
    context = await chromium.launchPersistentContext(runtime.profile, {
      executablePath: runtime.chromePath,
      headless: true,
      env,
      args: chromiumArgsFor(BASE_URL, ['--no-sandbox']),
    });
  } catch (error) {
    if (/ProcessSingleton|SingletonLock|profile.*use|already in use/i.test(String(error.stack || error))) {
      fail('PROFILE_IN_USE', '浏览器 profile 正被占用，请关闭对应 Chromium 后重试', {
        profile: runtime.profile,
      });
    }
    throw error;
  }
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const injectorReady = await findInjector(page, 30000);
    if (!injectorReady) {
      const diagnosis = await pageDiagnosis(page);
      const code = diagnosis.hasPasswordInput || diagnosis.hasPortalMarker || diagnosis.host !== 'hippo.oa.fenqile.com'
        ? 'LOGIN_REQUIRED'
        : 'ANGULAR_INJECTOR_UNAVAILABLE';
      fail(code, 'Hippo 登录态或页面初始化不可用，请用 get-browser-session 刷新登录态', diagnosis);
    }
    const services = await serviceInfo(page);
    assert(services.configServiceReady, 'CONFIG_SERVICE_UNAVAILABLE', '页面未提供 ConfigService');
    return { context, page, services, networkPolicy: network.networkPolicy };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function fetchJson(page, urlPath) {
  const result = await page.evaluate(async (requestPath) => {
    const response = await fetch(requestPath, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'Cache-Control': 'no-cache',
      },
    });
    let data = null;
    let json = true;
    try {
      data = await response.json();
    } catch (_) {
      json = false;
    }
    return { ok: response.ok, status: response.status, json, data };
  }, urlPath);
  assert(result.ok, 'HIPPO_GET_FAILED', `GET ${urlPath} 失败`, { status: result.status });
  assert(result.json, 'HIPPO_RESPONSE_NOT_JSON', `GET ${urlPath} 未返回 JSON`, { status: result.status });
  return result.data;
}

async function readState(page, paths) {
  const [items, active] = await Promise.all([
    fetchJson(page, paths.items),
    fetchJson(page, paths.active),
  ]);
  return { items, active };
}

async function mutateDraft(page, target, targetItem, desired) {
  const item = targetItem
    ? { ...targetItem, value: desired.value }
    : { key: target.key, value: desired.value, comment: desired.comment || '', plainText: true };
  if (targetItem && desired.comment !== undefined) item.comment = desired.comment;
  return page.evaluate(async ({ appId, env, cluster, namespaceName, existing, itemPayload }) => {
    const candidates = [
      document.documentElement,
      document.body,
      document.querySelector('#wrapper'),
      document.querySelector('.apollo-container'),
    ].filter(Boolean);
    const injector = candidates.map((element) => {
      try {
        return window.angular.element(element).injector();
      } catch (_) {
        return null;
      }
    }).find(Boolean);
    if (!injector) throw new Error('Angular injector unavailable');
    const configService = injector.get('ConfigService');
    if (existing) {
      await configService.update_item(appId, env, cluster, namespaceName, itemPayload);
      return { operation: 'update' };
    }
    await configService.create_item(appId, env, cluster, namespaceName, itemPayload);
    return { operation: 'create' };
  }, {
    appId: target.appId,
    env: target.env,
    cluster: target.cluster,
    namespaceName: target.namespaceName,
    existing: Boolean(targetItem),
    itemPayload: item,
  });
}

async function waitForDesiredState(page, target, paths, desired, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await readState(page, paths);
    const item = latest.items.find((candidate) => String(candidate.key) === target.key);
    const valueMatches = item && String(item.value ?? '') === desired.value;
    const commentMatches = desired.comment === undefined || (item && String(item.comment ?? '') === desired.comment);
    if (valueMatches && commentMatches) return latest;
    await page.waitForTimeout(500);
  }
  fail('DRAFT_READBACK_TIMEOUT', '保存后回读未得到目标草稿值');
}

function releaseUnchanged(before, after) {
  const beforeId = before.release?.id ?? null;
  const afterId = after.release?.id ?? null;
  const beforeKey = before.release?.releaseKey ?? null;
  const afterKey = after.release?.releaseKey ?? null;
  return {
    releaseKey: beforeKey === afterKey,
    configurations: before.rawConfigurations === after.rawConfigurations,
    releaseId: beforeId === afterId,
  };
}

function helpText() {
  return `Usage:
  hippo_draft_config.js doctor [--profile=...]
  hippo_draft_config.js status --app-id=<app> --namespace=<ns> --key=<key>
  hippo_draft_config.js plan --app-id=<app> --namespace=<ns> --key=<key> --value-file=<file>
  hippo_draft_config.js upsert --app-id=<app> --namespace=<ns> --key=<key> --value-file=<file>
  hippo_draft_config.js verify --app-id=<app> --namespace=<ns> --key=<key> --value-file=<file>
  hippo_draft_config.js self-test

Defaults: --env=fql_pre --cluster=default --namespace=application
Safety: upsert only saves a draft. This script has no publish command or release mutation.
`;
}

function runSelfTest() {
  assert(normalizeEnv('pre') === 'fql_pre', 'SELF_TEST_FAILED', 'pre 环境映射失败');
  assert(normalizeEnv('prod') === 'fql_prod', 'SELF_TEST_FAILED', 'prod 环境映射失败');
  const target = { appId: 'demo', env: 'fql_pre', cluster: 'default', namespaceName: 'application', key: 'target' };
  const items = [{ id: 1, key: 'same', value: '1' }, { id: 2, key: 'target', value: 'draft' }];
  const activeRows = [{ id: 9, releaseKey: 'r1', configurations: JSON.stringify({ same: '1', target: 'active' }) }];
  const paths = buildPaths(target);
  const summarized = summarizeState(target, paths, { items, active: activeRows });
  assert(JSON.stringify(summarized.summary.draftDiffKeys) === JSON.stringify(['target']),
    'SELF_TEST_FAILED', 'diffKeys 计算失败');
  assert(summarized.summary.targetHasUnpublishedDraft, 'SELF_TEST_FAILED', '未识别目标草稿差异');
  const desired = { value: 'next', comment: undefined };
  const plan = planChange(target, summarized, desired);
  assert(plan.operation === 'update' && plan.guardRequired, 'SELF_TEST_FAILED', 'update plan 计算失败');
  assertTargetAfterMutation(items[1], { ...items[1], value: 'next' }, desired);
  assert(planChange(target, summarized, { value: 'draft', comment: undefined }).operation === 'noop',
    'SELF_TEST_FAILED', 'noop plan 计算失败');
  let staleRejected = false;
  try {
    planChange(target, summarized, desired, 'stale-token');
  } catch (error) {
    staleRejected = error.code === 'CONCURRENT_DRAFT_CHANGED';
  }
  assert(staleRejected, 'SELF_TEST_FAILED', '并发 token 未拒绝旧状态');
  process.stdout.write(`${JSON.stringify({ selfTest: 'passed', publishAttempted: false }, null, 2)}\n`);
}

async function runBrowserCommand(command, args) {
  const runtime = resolveRuntime(args, command);
  const browser = await openHippo(runtime);
  try {
    if (command === 'doctor') {
      assert(browser.services.createItemReady && browser.services.updateItemReady,
        'CONFIG_MUTATION_METHODS_UNAVAILABLE', 'ConfigService 缺少 create_item/update_item');
      return {
        command,
        sessionReady: true,
        profile: runtime.profile,
        networkPolicy: browser.networkPolicy,
        ...browser.services,
        defaultEnv: 'fql_pre',
        publishAttempted: false,
      };
    }

    const state = await readState(browser.page, runtime.paths);
    const summarized = summarizeState(runtime.target, runtime.paths, state);
    if (command === 'status') return { command, ...summarized.summary };

    const desired = readDesired(args);
    const plan = planChange(runtime.target, summarized, desired,
      args['expected-current-token'] === undefined ? undefined : String(args['expected-current-token']));
    const common = {
      command,
      ...summarized.summary,
      operation: plan.operation,
      guardRequired: plan.guardRequired,
      desiredCharacters: plan.desiredCharacters,
      desiredLines: plan.desiredLines,
      desiredSha256: plan.desiredSha256,
      draftEqualsDesired: plan.draftEqualsDesired,
      commentWillChange: plan.commentWillChange,
      expectedDraftDiffKeys: plan.expectedDraftDiffKeys,
    };
    if (command === 'plan') return common;

    if (command === 'verify') {
      assert(plan.draftEqualsDesired && !plan.commentWillChange, 'VERIFY_FAILED',
        '当前 Hippo 草稿与目标文件不一致');
      return {
        ...common,
        verified: true,
        unpublishedDraft: summarized.summary.targetHasUnpublishedDraft,
        published: false,
      };
    }

    assert(command === 'upsert', 'COMMAND_INVALID', `不支持的 command: ${command}`);
    if (plan.operation === 'noop') {
      const afterState = await readState(browser.page, runtime.paths);
      const afterSummarized = summarizeState(runtime.target, runtime.paths, afterState);
      const afterPlan = planChange(runtime.target, afterSummarized, desired);
      const unchanged = releaseUnchanged(summarized.active, afterSummarized.active);
      assert(afterPlan.operation === 'noop', 'CONCURRENT_DRAFT_CHANGED',
        'noop 回读时目标草稿已变化，请重新运行 plan');
      assert(afterSummarized.currentStateToken === summarized.currentStateToken,
        'CONCURRENT_DRAFT_CHANGED', 'noop 回读时目标配置状态已变化，请重新运行 plan');
      assert(unchanged.releaseKey && unchanged.configurations && unchanged.releaseId,
        'ACTIVE_RELEASE_CHANGED', 'noop 回读期间 active release 发生变化；请重新核对', unchanged);
      assert(mapsEqual(itemMap(state.items, runtime.target.key), itemMap(afterState.items, runtime.target.key)),
        'NON_TARGET_ITEM_CHANGED', 'noop 回读期间发现非目标配置项变化；请重新核对');
      assert(JSON.stringify(afterSummarized.summary.draftDiffKeys) === JSON.stringify(plan.expectedDraftDiffKeys),
        'UNEXPECTED_DRAFT_DIFF', 'noop 回读后的草稿差异 key 不符合预期', {
          expected: plan.expectedDraftDiffKeys,
          actual: afterSummarized.summary.draftDiffKeys,
        });
      return {
        ...common,
        draftSaved: false,
        afterDraftDiffKeys: afterSummarized.summary.draftDiffKeys,
        otherItemsUnchanged: true,
        activeReleaseKeyUnchanged: true,
        activeConfigurationsUnchanged: true,
        activeReleaseIdUnchanged: true,
        publishAttempted: false,
        published: false,
      };
    }
    if (plan.guardRequired) {
      assert(args['expected-current-token'], 'EXPECTED_TOKEN_REQUIRED',
        '目标 key 已有未发布草稿；请把本次 plan 的 currentStateToken 传给 --expected-current-token', {
          currentStateToken: summarized.currentStateToken,
        });
    }
    const beforeOthers = itemMap(state.items, runtime.target.key);
    const mutation = await mutateDraft(browser.page, runtime.target, summarized.targetItem, desired);
    const afterState = await waitForDesiredState(browser.page, runtime.target, runtime.paths, desired);
    const afterSummarized = summarizeState(runtime.target, runtime.paths, afterState);
    assertTargetAfterMutation(summarized.targetItem, afterSummarized.targetItem, desired);
    const afterOthers = itemMap(afterState.items, runtime.target.key);
    const unchanged = releaseUnchanged(summarized.active, afterSummarized.active);
    assert(unchanged.releaseKey && unchanged.configurations && unchanged.releaseId,
      'ACTIVE_RELEASE_CHANGED', '保存草稿期间 active release 发生变化；停止后续写入并人工核对', unchanged);
    assert(mapsEqual(beforeOthers, afterOthers), 'NON_TARGET_ITEM_CHANGED',
      '保存草稿期间发现非目标配置项变化；停止后续写入并人工核对');
    assert(JSON.stringify(afterSummarized.summary.draftDiffKeys) === JSON.stringify(plan.expectedDraftDiffKeys),
      'UNEXPECTED_DRAFT_DIFF', '保存后的草稿差异 key 不符合预期', {
        expected: plan.expectedDraftDiffKeys,
        actual: afterSummarized.summary.draftDiffKeys,
      });
    return {
      ...common,
      operation: mutation.operation,
      afterDraftDiffKeys: afterSummarized.summary.draftDiffKeys,
      draftSaved: true,
      targetItemValidated: true,
      otherItemsUnchanged: true,
      activeReleaseKeyUnchanged: true,
      activeConfigurationsUnchanged: true,
      activeReleaseIdUnchanged: true,
      publishAttempted: false,
      published: false,
    };
  } finally {
    await browser.context.close().catch(() => {});
  }
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
  const result = await runBrowserCommand(command, args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const output = error instanceof HippoError
      ? { ok: false, code: error.code, message: error.message, details: error.details || {} }
      : { ok: false, code: 'UNEXPECTED_ERROR', message: String(error.message || error) };
    process.stderr.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildPaths,
  desiredDiffKeys,
  diffKeys,
  makeStateToken,
  normalizeEnv,
  parseArgs,
  planChange,
  summarizeState,
};
