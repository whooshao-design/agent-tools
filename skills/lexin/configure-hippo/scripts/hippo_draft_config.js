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

const SITE_BASE_URLS = {
  standard: 'http://hippo.oa.fenqile.com',
  stable: 'http://stable-hippo.oa.fenqile.com',
  mx: 'https://hippo.oa.wowcredito.com',
  id: 'https://hippo.oa.kredito.id',
};
const STANDARD_BASE_URL = SITE_BASE_URLS.standard;
const STABLE_BASE_URL = SITE_BASE_URLS.stable;
const DEFAULT_PROFILE = '/home/joney/.cache/healthy-dashboard-profile';
const DEFAULT_TOOL_DIR = path.join(os.homedir(), 'tools/lexiao-browser');
const COMMANDS = new Set([
  'doctor',
  'status',
  'plan',
  'upsert',
  'verify',
  'namespace-status',
  'namespace-plan',
  'namespace-create',
  'namespace-roles',
  'namespace-grant',
  'self-test',
  'help',
]);
// 新建 namespace 走 NamespaceService.createAppNamespace，是应用级动作，不针对单个 env。
const NAMESPACE_COMMANDS = new Set([
  'namespace-status',
  'namespace-plan',
  'namespace-create',
  'namespace-roles',
  'namespace-grant',
]);
// 新建 namespace 后授权：POST /apps/<appId>/namespaces/<ns>/roles/<roleType>，body 就是用户 id。
const NAMESPACE_ROLE_TYPES = { modify: 'ModifyNamespace', release: 'ReleaseNamespace' };
// 新建 namespace 默认就给这些人授修改权和发布权，不再单独询问；
// Hippo 通常已经把创建者自动加上，这里做兜底，也覆盖“换人创建”的情况。
const DEFAULT_NAMESPACE_GRANT_USERS = ['joneyshao'];
const PUBLISH_AUTHORIZATION_VALUE = 'explicit';
const CREATE_AUTHORIZATION_VALUE = 'explicit';
const GRANT_AUTHORIZATION_VALUE = 'explicit';
// 与 Hippo 页面 valdr 约束保持一致：名称只能是字母数字下划线且不超过 64 字符
// （公共 namespace 还要算上 orgId 前缀），备注 10-64 字符且必填。
const NAMESPACE_NAME_PATTERN = /^[0-9a-zA-Z_]+$/;
const NAMESPACE_NAME_MAX_LENGTH = 64;
const NAMESPACE_COMMENT_MIN_LENGTH = 10;
const NAMESPACE_COMMENT_MAX_LENGTH = 64;
const NAMESPACE_FORMATS = new Set(['properties', 'xml', 'sh', 'json', 'yml']);
const NAMESPACE_LIST_PAGE_SIZE = 500;
// namespacePubTypes 分 __app__（普通应用配置）和 __pub__（发布系统配置），本脚本只处理前者。
const NAMESPACE_PUB_TYPE = '__app__';
const STABLE_HOST_ALIASES = new Set([
  'stable',
  'test',
  'testing',
  '测试',
  '测试环境',
  'prj',
  'project',
  '项目',
  '项目环境',
]);
const OVERSEAS_HOST_ALIASES = new Map([
  ['mx', 'mx'],
  ['mex', 'mx'],
  ['mexico', 'mx'],
  ['墨西哥', 'mx'],
  ['wowcredito', 'mx'],
  ['hippo.oa.wowcredito.com', 'mx'],
  ['id', 'id'],
  ['idn', 'id'],
  ['indonesia', 'id'],
  ['印尼', 'id'],
  ['印度尼西亚', 'id'],
  ['kredito', 'id'],
  ['hippo.oa.kredito.id', 'id'],
]);
const STANDARD_HOST_ALIASES = new Set(['standard', 'online', 'prod', '生产', '线上', 'hippo']);
// env 名由站点前缀和环境后缀组成：国内是 fql_pre/fql_prod，
// 墨西哥站点是 mxyw_pre/mxyw_prod，印尼站点是 ynyw_prod。
const SITE_ENV_PREFIXES = {
  standard: 'fql',
  stable: 'fql',
  mx: 'mxyw',
  id: 'ynyw',
};
const ENV_PREFIX_SITES = {
  fql: 'standard',
  mxyw: 'mx',
  ynyw: 'id',
};
// 站点缺省环境：印尼只有 ynyw_prod，没有 pre，缺省用 pre 会得到一个必然 404 的 env。
const SITE_DEFAULT_SUFFIXES = {
  standard: 'pre',
  stable: 'pre',
  mx: 'pre',
  id: 'prod',
};
// 免二次确认即可写入的环境。印尼没有 pre，所以该站点任何写入都要 --allow-non-pre。
const SITE_UNGUARDED_WRITE_ENVS = {
  standard: 'fql_pre',
  stable: 'fql_pre',
  mx: 'mxyw_pre',
  id: null,
};
const ENV_SUFFIX_ALIASES = {
  pre: 'pre',
  '预发': 'pre',
  '预发布': 'pre',
  gray: 'gray',
  '灰度': 'gray',
  oa: 'oa',
  prod: 'prod',
  production: 'prod',
  '生产': 'prod',
  '线上': 'prod',
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

function flagEnabled(value) {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function normalizeEnv(value, site) {
  const raw = value === undefined || value === true ? '' : String(value).trim().toLowerCase();
  const resolvedSite = site || siteOfAlias(raw) || 'standard';
  const prefix = SITE_ENV_PREFIXES[resolvedSite] || SITE_ENV_PREFIXES.standard;
  if (!raw) return `${prefix}_${SITE_DEFAULT_SUFFIXES[resolvedSite] || 'pre'}`;
  // 海外站点以 prod 为主（印尼只有 ynyw_prod），只给国家别名时按线上解析，
  // 写入保护会强制用户再传 --allow-non-pre；stable 系别名仍按预发解析。
  if (OVERSEAS_HOST_ALIASES.has(raw)) return `${prefix}_prod`;
  if (STABLE_HOST_ALIASES.has(raw) || raw === 'stable-hippo') return `${prefix}_pre`;
  const suffix = ENV_SUFFIX_ALIASES[raw];
  return suffix ? `${prefix}_${suffix}` : raw;
}

function siteOfAlias(raw) {
  if (!raw) return '';
  if (OVERSEAS_HOST_ALIASES.has(raw)) return OVERSEAS_HOST_ALIASES.get(raw);
  if (STABLE_HOST_ALIASES.has(raw) || raw === 'stable-hippo') return 'stable';
  if (STANDARD_HOST_ALIASES.has(raw)) return 'standard';
  return '';
}

function normalizeSite(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const site = siteOfAlias(raw);
  if (site) return site;
  fail('HIPPO_SITE_INVALID', '不支持的 --hippo-site；只能传 standard、stable、mx 或 id', { hippoSite: value });
}

function resolveSite(requestedEnv, hippoSite) {
  const explicit = normalizeSite(hippoSite);
  if (explicit) return explicit;
  const raw = requestedEnv === undefined || requestedEnv === true ? '' : String(requestedEnv).trim().toLowerCase();
  const aliasSite = siteOfAlias(raw);
  if (aliasSite) return aliasSite;
  const prefix = raw.includes('_') ? raw.slice(0, raw.indexOf('_')) : '';
  return ENV_PREFIX_SITES[prefix] || 'standard';
}

function resolveBaseUrl(env, requestedEnv, hippoSite) {
  const requested = requestedEnv === undefined || requestedEnv === true || requestedEnv === '' ? env : requestedEnv;
  return SITE_BASE_URLS[resolveSite(requested, hippoSite)];
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
      baseUrl: target.baseUrl,
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

function activeValueMatches(active, target, desired) {
  return hasOwn(active.configurations, target.key)
    && String(active.configurations[target.key] ?? '') === desired.value;
}

function activeConfigChangedKeys(beforeConfig, afterConfig) {
  const keys = new Set([...Object.keys(beforeConfig), ...Object.keys(afterConfig)]);
  return [...keys]
    .filter((key) => !hasOwn(beforeConfig, key)
      || !hasOwn(afterConfig, key)
      || String(beforeConfig[key] ?? '') !== String(afterConfig[key] ?? ''))
    .sort();
}

function releaseSelectedItem(target, targetItem, active, desired) {
  assert(targetItem, 'TARGET_ITEM_MISSING', '发布前目标配置项不存在');
  assert(targetItem.id !== undefined && targetItem.id !== null, 'TARGET_ITEM_ID_MISSING',
    '发布前目标配置项缺少 id');
  const activeExists = hasOwn(active.configurations, target.key);
  return {
    id: targetItem.id,
    key: target.key,
    oldValue: activeExists ? String(active.configurations[target.key] ?? '') : null,
    newValue: desired.value,
    type: activeExists ? 'modify' : 'create',
  };
}

function summarizeReleaseSelectedItem(item) {
  return {
    id: item.id,
    key: item.key,
    type: item.type,
    oldValueSha256: item.oldValue === null ? null : sha256(item.oldValue),
    newValueSha256: sha256(item.newValue),
  };
}

function formatReleaseTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// stable 是测试环境，Hippo 前端在 stable 上发布也不走审批：保存后直接按 key 自动发布，
// 不要求 --publish 授权；--no-publish 才退回只存草稿。其它站点仍必须显式授权。
function publishOptions(args, summarized, site) {
  if (flagEnabled(args['no-publish'])) return { enabled: false, autoPublish: false };
  const autoPublish = site === 'stable';
  if (!autoPublish) {
    if (!flagEnabled(args.publish)) return { enabled: false, autoPublish: false };
    assert(String(args['publish-authorization'] || '') === PUBLISH_AUTHORIZATION_VALUE,
      'PUBLISH_AUTHORIZATION_REQUIRED',
      '发布必须由用户在当前对话中明确授权，并传 --publish-authorization=explicit');
    assert(args['expected-current-token'], 'EXPECTED_TOKEN_REQUIRED_FOR_PUBLISH',
      '发布必须携带本次 plan 返回的 currentStateToken', {
        currentStateToken: summarized.currentStateToken,
      });
  }
  return {
    enabled: true,
    autoPublish,
    releaseTitle: String(args['release-title'] || `${formatReleaseTimestamp()}-release`),
    releaseComment: String(args['release-comment']
      || `${autoPublish ? 'codex stable auto publish' : 'codex publish'} ${summarized.summary.target}`),
    isEmergencyPublish: flagEnabled(args['emergency-publish']),
  };
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

// namespace 列表接口在不同 Hippo 版本里把名字放在不同层级，这里一次性兼容。
function namespaceNamesFrom(payload) {
  const rows = Array.isArray(payload) ? payload : (payload?.elements ?? payload?.content);
  assert(Array.isArray(rows), 'NAMESPACE_LIST_INVALID',
    'namespace 列表结构异常；不能按空集合继续创建或授权');
  const names = [];
  for (const row of rows) {
    const name = row?.namespace?.namespaceName || row?.namespaceName || row?.baseInfo?.namespaceName;
    assert(typeof name === 'string' && name.length > 0, 'NAMESPACE_LIST_INVALID',
      'namespace 列表行缺少名称；不能验证非目标保护');
    if (name && !names.includes(String(name))) names.push(String(name));
  }
  return names.sort();
}

function navtreeEnvs(payload) {
  const entities = Array.isArray(payload?.entities) ? payload.entities : [];
  return entities
    .map((entity) => ({
      env: String(entity?.body?.env?.name || ''),
      clusters: (entity?.body?.clusters || []).map((cluster) => String(cluster?.name || '')).filter(Boolean),
    }))
    .filter((row) => row.env);
}

// 页面 LinkNamespaceController 的规则：实体应用(type=1)建私有 namespace，
// 虚拟应用(type=0)建公共 namespace，其它类型按私有处理；页面上该选项是只读的。
function resolveNamespacePublicity(app) {
  const appType = String(app?.type ?? '');
  return { appType, isPublic: appType === '0' };
}

function fullNamespaceName(name, isPublic, orgId) {
  return isPublic ? `${String(orgId || '')}.${name}` : name;
}

function normalizeNamespaceFormat(value) {
  const format = String(value === undefined || value === true ? 'properties' : value).trim().toLowerCase();
  assert(NAMESPACE_FORMATS.has(format), 'NAMESPACE_FORMAT_INVALID',
    `--format 只能是 ${[...NAMESPACE_FORMATS].join('/')}`, { format });
  return format;
}

function validateNamespaceName(name, fullName) {
  assert(NAMESPACE_NAME_PATTERN.test(name), 'NAMESPACE_NAME_INVALID',
    'namespace 名称只能包含字母、数字和下划线', { namespace: name });
  assert(fullName.length <= NAMESPACE_NAME_MAX_LENGTH, 'NAMESPACE_NAME_TOO_LONG',
    `namespace 名称（含部门前缀）不能超过 ${NAMESPACE_NAME_MAX_LENGTH} 个字符`, {
      namespace: fullName,
      length: fullName.length,
    });
}

function validateNamespaceComment(value) {
  const comment = String(value === undefined || value === true ? '' : value).trim();
  assert(comment.length >= NAMESPACE_COMMENT_MIN_LENGTH && comment.length <= NAMESPACE_COMMENT_MAX_LENGTH,
    'NAMESPACE_COMMENT_INVALID',
    `namespace 备注必须是 ${NAMESPACE_COMMENT_MIN_LENGTH}-${NAMESPACE_COMMENT_MAX_LENGTH} 个字符`,
    { commentCharacters: comment.length });
  return comment;
}

function readNamespaceDesired(args, namespace, app) {
  const { appType, isPublic } = resolveNamespacePublicity(app);
  const fullName = fullNamespaceName(namespace.name, isPublic, app?.orgId);
  validateNamespaceName(namespace.name, fullName);
  const format = normalizeNamespaceFormat(args.format);
  const isEncrypt = flagEnabled(args.encrypt);
  assert(!isEncrypt || format === 'properties', 'NAMESPACE_ENCRYPT_UNSUPPORTED',
    '只有 properties 格式的 namespace 支持加密存储', { format });
  const comment = validateNamespaceComment(args['comment-file']
    ? readUtf8File(args['comment-file'], '备注')
    : args.comment);
  const groupId = Number(args['group-id'] === undefined ? 0 : args['group-id']);
  assert(Number.isInteger(groupId), 'NAMESPACE_GROUP_INVALID', '--group-id 必须是整数', {
    groupId: args['group-id'],
  });
  return { name: namespace.name, fullName, appType, isPublic, format, isEncrypt, comment, groupId };
}

function namespaceCreationPayload(appId, desired) {
  return {
    appId,
    name: desired.name,
    comment: desired.comment,
    isPublic: desired.isPublic,
    format: desired.format,
    isEncrypt: desired.isEncrypt,
    groupId: desired.groupId,
  };
}

function namespaceDetailSummary(detail) {
  const comment = String(detail?.comment ?? '');
  return {
    namespaceName: String(detail?.baseInfo?.namespaceName || ''),
    namespaceId: detail?.baseInfo?.id ?? null,
    groupPath: String(detail?.baseInfo?.groupPath || ''),
    isEncrypt: Boolean(detail?.baseInfo?.isEncrypt),
    format: String(detail?.format || ''),
    isPublic: Boolean(detail?.isPublic),
    groupId: detail?.groupId ?? null,
    commentCharacters: comment.length,
    commentSha256: sha256(comment),
    itemCount: Array.isArray(detail?.items) ? detail.items.length : null,
  };
}

function namespaceOperation(envs) {
  const probed = envs.filter((row) => !row.clusterMissing);
  assert(probed.length > 0, 'NAMESPACE_ENV_NOT_FOUND',
    '该应用在当前站点没有可用的 env/cluster；请确认 --env、--cluster 和 --hippo-site');
  const existing = probed.filter((row) => row.exists);
  if (!existing.length) return 'create';
  return existing.length === probed.length ? 'exists' : 'partial';
}

function makeNamespaceStateToken(context) {
  return sha256(JSON.stringify({
    site: context.site,
    appId: context.appId,
    fullName: context.fullName,
    envs: context.envs.map((row) => ({
      env: row.env,
      cluster: row.cluster,
      clusterMissing: row.clusterMissing,
      exists: row.exists,
      namespaceId: row.namespaceId,
    })),
  }));
}

function normalizeRoleTypes(value) {
  const raw = value === undefined || value === true ? 'modify,release' : String(value);
  const roles = [];
  for (const token of raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)) {
    const roleType = ['modify', 'modifynamespace'].includes(token) ? NAMESPACE_ROLE_TYPES.modify
      : ['release', 'releasenamespace'].includes(token) ? NAMESPACE_ROLE_TYPES.release : '';
    assert(roleType, 'NAMESPACE_ROLE_INVALID', '--roles 只能是 modify、release 或两者', { role: token });
    if (!roles.includes(roleType)) roles.push(roleType);
  }
  assert(roles.length > 0, 'NAMESPACE_ROLE_INVALID', '--roles 不能为空');
  return roles;
}

function parseGrantUsers(value) {
  const users = String(value === undefined || value === true ? '' : value)
    .split(',').map((item) => item.trim()).filter(Boolean);
  assert(users.length > 0, 'GRANT_USERS_REQUIRED',
    'namespace-grant 必须传 --grant-users=<用户 id，逗号分隔>');
  const unique = [...new Set(users)];
  for (const user of unique) {
    assert(/^[0-9a-zA-Z._-]+$/.test(user), 'GRANT_USER_INVALID',
      '用户 id 只能包含字母、数字、点、下划线和中划线', { user });
  }
  return unique;
}

function appOwnersFrom(app) {
  return String(app?.ownerName || '').split(/[;,]/).map((owner) => owner.trim()).filter(Boolean);
}

// namespace-create 的自动授权名单：默认名单不需要额外授权，换成别人必须显式授权。
function resolveAutoGrantUsers(args) {
  if (flagEnabled(args['no-auto-grant'])) return [];
  if (args['grant-users'] === undefined) return [...DEFAULT_NAMESPACE_GRANT_USERS];
  assert(String(args['grant-authorization'] || '') === GRANT_AUTHORIZATION_VALUE,
    'GRANT_AUTHORIZATION_REQUIRED',
    '给默认名单以外的用户授权必须明确授权：加 --grant-authorization=explicit，或改用 namespace-grant');
  return parseGrantUsers(args['grant-users']);
}

// 角色接口用的 namespace 名：namespace 归到分组时页面会拼成 <groupPath>!<namespaceName>。
function roleNamespacePath(namespaceName, groupPath) {
  return groupPath ? `${groupPath}!${namespaceName}` : namespaceName;
}

function roleUsersSummary(payload) {
  const ids = (field) => (Array.isArray(payload?.[field]) ? payload[field] : [])
    .map((row) => String(row?.userId || '')).filter(Boolean).sort();
  return { modifyRoleUsers: ids('modifyRoleUsers'), releaseRoleUsers: ids('releaseRoleUsers') };
}

function roleUsersOf(roleUsers, roleType) {
  return roleType === NAMESPACE_ROLE_TYPES.release ? roleUsers.releaseRoleUsers : roleUsers.modifyRoleUsers;
}

function roleUsersDiff(before, after) {
  const diff = (field) => ({
    added: after[field].filter((user) => !before[field].includes(user)),
    removed: before[field].filter((user) => !after[field].includes(user)),
  });
  return { modify: diff('modifyRoleUsers'), release: diff('releaseRoleUsers') };
}

function pendingRoleGrants(roleUsers, roleTypes, users) {
  const pending = [];
  const already = [];
  for (const roleType of roleTypes) {
    for (const user of users) {
      (roleUsersOf(roleUsers, roleType).includes(user) ? already : pending).push({ roleType, user });
    }
  }
  return { pending, already };
}

function namespaceListDiff(beforeNames, afterNames) {
  const before = new Set(beforeNames);
  const after = new Set(afterNames);
  return {
    added: [...after].filter((name) => !before.has(name)).sort(),
    removed: [...before].filter((name) => !after.has(name)).sort(),
  };
}

function resolveRuntime(args, command) {
  const site = resolveSite(args.env, args['hippo-site']);
  const env = normalizeEnv(args.env, site);
  const baseUrl = SITE_BASE_URLS[site];
  const isNamespaceCommand = NAMESPACE_COMMANDS.has(command);
  const target = command === 'doctor' || isNamespaceCommand ? null : {
    appId: resolveAppId(args),
    env,
    baseUrl,
    cluster: String(args.cluster || 'default'),
    namespaceName: String(args.namespace || 'application'),
    key: String(args.key || '').trim(),
  };
  if (target) assert(target.key, 'KEY_REQUIRED', `${command} 必须传 --key`);
  const namespace = isNamespaceCommand ? {
    appId: resolveAppId(args),
    cluster: String(args.cluster || 'default'),
    name: String(args.namespace || '').trim(),
  } : null;
  if (namespace) {
    assert(namespace.name, 'NAMESPACE_NAME_REQUIRED', `${command} 必须传 --namespace=<namespace 名>`);
  }
  if (command === 'upsert' && env !== SITE_UNGUARDED_WRITE_ENVS[site]) {
    assert(args['allow-non-pre'], 'NON_PRE_WRITE_REJECTED',
      `写入 ${env} 必须由用户明确指定环境并传 --allow-non-pre`);
  }
  const toolDir = path.resolve(expandHome(args['tool-dir'] || DEFAULT_TOOL_DIR));
  return {
    env,
    site,
    baseUrl,
    dashboardUrl: `${baseUrl}/#/app/dashboard`,
    expectedHost: new URL(baseUrl).hostname,
    target,
    namespace,
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

async function pageDiagnosis(page, expectedHost) {
  return page.evaluate((targetHost) => ({
    title: document.title,
    url: location.href,
    host: location.hostname,
    expectedHost: targetHost,
    hasPasswordInput: Boolean(document.querySelector('input[type="password"]')),
    hasPortalMarker: /atrust/i.test(location.hostname)
      || /Work Happy|QR Code|Use MOA|Account Login|Password Login|乐空间传送门|ATrust/i
        .test((document.body?.innerText || '').slice(0, 4000)),
  }), expectedHost);
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
    let releaseService;
    try {
      service = injector.get('ConfigService');
    } catch (_) {
      return { injectorReady: true, configServiceReady: false };
    }
    try {
      releaseService = injector.get('ReleaseService');
    } catch (_) {
      releaseService = null;
    }
    return {
      injectorReady: true,
      configServiceReady: true,
      releaseServiceReady: Boolean(releaseService),
      createItemReady: typeof service.create_item === 'function',
      updateItemReady: typeof service.update_item === 'function',
      publishReady: Boolean(releaseService) && typeof releaseService.publish === 'function',
      createItemArity: typeof service.create_item === 'function' ? service.create_item.length : null,
      updateItemArity: typeof service.update_item === 'function' ? service.update_item.length : null,
    };
  });
}

async function openHippo(runtime) {
  const chromium = loadChromium(runtime);
  const network = buildBrowserEnv(runtime.baseUrl, process.env);
  const env = { ...network.env };
  env.LD_LIBRARY_PATH = [runtime.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  let context;
  try {
    context = await chromium.launchPersistentContext(runtime.profile, {
      executablePath: runtime.chromePath,
      headless: true,
      env,
      args: chromiumArgsFor(runtime.baseUrl, ['--no-sandbox']),
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
    await page.goto(runtime.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const injectorReady = await findInjector(page, 30000);
    if (!injectorReady) {
      const diagnosis = await pageDiagnosis(page, runtime.expectedHost);
      const code = diagnosis.hasPasswordInput || diagnosis.hasPortalMarker
        || diagnosis.host !== runtime.expectedHost
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

async function fetchRaw(page, urlPath) {
  return page.evaluate(async (requestPath) => {
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
}

async function fetchJson(page, urlPath) {
  const result = await fetchRaw(page, urlPath);
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

function buildNamespacePaths(namespace, env, fullName) {
  const root = `/apps/${encodeSegment(namespace.appId)}`
    + `/envs/${encodeSegment(env)}`
    + `/clusters/${encodeSegment(namespace.cluster)}`;
  return {
    detail: `${root}/namespaces/${encodeSegment(fullName)}`,
    active: `${root}/namespaces/${encodeSegment(fullName)}/releases/active?page=0&size=1`,
    list: `${root}/namespacePubTypes/${NAMESPACE_PUB_TYPE}/groupId/0`
      + `/page/0/size/${NAMESPACE_LIST_PAGE_SIZE}?searchNamespace=`,
  };
}

async function readNamespaceContext(page, appId) {
  const [app, navtree, groups, permission, pageSettings] = await Promise.all([
    fetchJson(page, `/apps/${encodeSegment(appId)}`),
    fetchJson(page, `/apps/${encodeSegment(appId)}/navtree`),
    fetchJson(page, `/apps/${encodeSegment(appId)}/findNamespaceGroupsByAppId`),
    fetchJson(page, `/apps/${encodeSegment(appId)}/permissions/createNamespace`),
    fetchJson(page, '/page-settings'),
  ]);
  assert(app && String(app.appId || '') === appId, 'APP_NOT_FOUND', 'Hippo 中找不到该应用', { appId });
  return {
    app,
    envs: navtreeEnvs(navtree),
    groups: (Array.isArray(groups) ? groups : [])
      .map((group) => ({ id: group?.id ?? null, name: String(group?.name || '') })),
    hasCreateNamespacePermission: Boolean(permission?.hasPermission),
    canAppAdminCreatePrivateNamespace: Boolean(pageSettings?.canAppAdminCreatePrivateNamespace),
  };
}

async function probeNamespaceEnvs(page, namespace, fullName, envRows) {
  const probes = [];
  for (const row of envRows) {
    if (!row.clusters.includes(namespace.cluster)) {
      probes.push({
        env: row.env,
        cluster: namespace.cluster,
        clusterMissing: true,
        exists: false,
        namespaceId: null,
        detail: null,
        namespaceNames: [],
      });
      continue;
    }
    const paths = buildNamespacePaths(namespace, row.env, fullName);
    // eslint-disable-next-line no-await-in-loop
    const [detail, list] = await Promise.all([fetchRaw(page, paths.detail), fetchRaw(page, paths.list)]);
    assert(detail.status === 200 || detail.status === 404, 'NAMESPACE_PROBE_FAILED',
      `读取 ${row.env} 的 namespace 状态失败`, { env: row.env, status: detail.status });
    if (detail.status === 200) {
      assert(detail.ok && detail.json && detail.data?.baseInfo?.namespaceName === fullName
        && Array.isArray(detail.data?.items), 'NAMESPACE_PROBE_FAILED',
      `读取 ${row.env} 的 namespace 详情结构异常`, { env: row.env, status: detail.status });
    }
    assert(list.ok && list.json, 'NAMESPACE_LIST_FAILED',
      `读取 ${row.env} 的 namespace 列表失败`, { env: row.env, status: list.status });
    const names = namespaceNamesFrom(list.data);
    assert(names.length < NAMESPACE_LIST_PAGE_SIZE, 'NAMESPACE_LIST_TRUNCATED',
      'namespace 列表可能被分页截断，无法做非目标保护', { env: row.env, count: names.length });
    probes.push({
      env: row.env,
      cluster: namespace.cluster,
      clusterMissing: false,
      exists: detail.status === 200,
      namespaceId: detail.status === 200 ? (detail.data?.baseInfo?.id ?? null) : null,
      detail: detail.status === 200 ? namespaceDetailSummary(detail.data) : null,
      namespaceNames: names,
    });
  }
  return probes;
}

async function createAppNamespaceOnPage(page, payload) {
  return page.evaluate(async ({ appId, appNamespace }) => {
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
    const namespaceService = injector.get('NamespaceService');
    if (!namespaceService || typeof namespaceService.createAppNamespace !== 'function') {
      throw new Error('NamespaceService.createAppNamespace unavailable');
    }
    const created = await namespaceService.createAppNamespace(appId, appNamespace);
    return {
      id: created?.id ?? null,
      appId: created?.appId ?? null,
      name: created?.name ?? null,
      format: created?.format ?? null,
      isPublic: created?.isPublic ?? null,
      isEncrypt: created?.isEncrypt ?? null,
      groupId: created?.groupId ?? null,
      dataChangeCreatedBy: created?.dataChangeCreatedBy ?? null,
      dataChangeCreatedTime: created?.dataChangeCreatedTime ?? null,
    };
  }, { appId: payload.appId, appNamespace: payload });
}

async function readNamespaceRoles(page, appId, roleNamespace) {
  const [roleUsers, assignPermission, currentUser] = await Promise.all([
    fetchJson(page, `/apps/${encodeSegment(appId)}/namespaces/${encodeSegment(roleNamespace)}/role_users`),
    fetchJson(page, `/apps/${encodeSegment(appId)}/permissions/AssignRole`),
    fetchJson(page, '/user'),
  ]);
  return {
    roleUsers: roleUsersSummary(roleUsers),
    hasAssignRolePermission: Boolean(assignPermission?.hasPermission),
    currentUser: String(currentUser?.userId || ''),
  };
}

async function assignNamespaceRoleOnPage(page, appId, roleNamespace, roleType, user) {
  return page.evaluate(async ({ targetAppId, namespaceName, targetRoleType, targetUser }) => {
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
    const permissionService = injector.get('PermissionService');
    if (!permissionService) throw new Error('PermissionService unavailable');
    if (targetRoleType === 'ReleaseNamespace') {
      if (typeof permissionService.assign_release_namespace_role !== 'function') {
        throw new Error('PermissionService.assign_release_namespace_role unavailable');
      }
      await permissionService.assign_release_namespace_role(targetAppId, namespaceName, targetUser);
    } else {
      if (typeof permissionService.assign_modify_namespace_role !== 'function') {
        throw new Error('PermissionService.assign_modify_namespace_role unavailable');
      }
      await permissionService.assign_modify_namespace_role(targetAppId, namespaceName, targetUser);
    }
    return { assigned: true };
  }, { targetAppId: appId, namespaceName: roleNamespace, targetRoleType: roleType, targetUser: user });
}

async function waitForRoleGrants(page, appId, roleNamespace, grants, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    latest = await readNamespaceRoles(page, appId, roleNamespace);
    const missing = grants.filter((grant) => !roleUsersOf(latest.roleUsers, grant.roleType).includes(grant.user));
    if (!missing.length) return latest;
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(500);
  }
  fail('GRANT_VERIFY_FAILED', '授权后回读没有看到目标用户的角色', {
    roleNamespace,
    missing: latest
      ? grants.filter((grant) => !roleUsersOf(latest.roleUsers, grant.roleType).includes(grant.user))
      : grants,
  });
}

async function readNamespacePermissions(page, appId, roleNamespace) {
  const root = `/apps/${encodeSegment(appId)}/namespaces/${encodeSegment(roleNamespace)}/permissions`;
  const [modify, release] = await Promise.all([
    fetchJson(page, `${root}/${NAMESPACE_ROLE_TYPES.modify}`),
    fetchJson(page, `${root}/${NAMESPACE_ROLE_TYPES.release}`),
  ]);
  return { hasModifyPermission: Boolean(modify?.hasPermission), hasReleasePermission: Boolean(release?.hasPermission) };
}

// 分组 namespace 的权限和角色接口都要用 <groupPath>!<namespaceName>，groupPath 只能回读得到。
async function lookupNamespaceGroupPath(page, target) {
  const listPath = `/apps/${encodeSegment(target.appId)}`
    + `/envs/${encodeSegment(target.env)}`
    + `/clusters/${encodeSegment(target.cluster)}`
    + `/namespacePubTypes/${NAMESPACE_PUB_TYPE}/groupId/0/page/0/size/${NAMESPACE_LIST_PAGE_SIZE}`
    + `?searchNamespace=${encodeURIComponent(target.namespaceName)}`;
  const list = await fetchRaw(page, listPath);
  if (!list.ok || !list.json) return '';
  const rows = Array.isArray(list.data?.elements) ? list.data.elements : [];
  const matched = rows.find((row) => String(row?.baseInfo?.namespaceName || '') === target.namespaceName);
  return String(matched?.baseInfo?.groupPath || '');
}

async function readNamespaceAccess(page, target) {
  let roleNamespace = target.namespaceName;
  let permissions = await readNamespacePermissions(page, target.appId, roleNamespace);
  if (!permissions.hasModifyPermission && !permissions.hasReleasePermission) {
    const groupPath = await lookupNamespaceGroupPath(page, target);
    if (groupPath) {
      roleNamespace = roleNamespacePath(target.namespaceName, groupPath);
      permissions = await readNamespacePermissions(page, target.appId, roleNamespace);
    }
  }
  return { roleNamespace, ...permissions };
}

// 公共（虚拟）应用的 namespace 真名带 <orgId>. 前缀。传不带前缀的名字时，权限查询查的是
// 一个不存在的 namespace，结果必然是「无权限」——但真实原因是名字写错，不是权限不足。
// 实测教训：据此去向 29 个应用负责人申请权限，而账号本就有 modify/release 权限。
async function publicNamePrefixHint(page, target) {
  if (String(target.namespaceName || '').includes('.')) return '';
  const app = await fetchJson(page, `/apps/${encodeSegment(target.appId)}`).catch(() => null);
  if (!app) return '';
  if (!resolveNamespacePublicity(app).isPublic) return '';
  const full = fullNamespaceName(target.namespaceName, true, app?.orgId);
  return `；注意该应用是公共（虚拟）应用，namespace 真名为 ${full}，`
    + `若传入的是不带前缀的名字，请先改用 --namespace=${full} 重试，再判断是否真的缺权限`;
}

async function namespacePermissionDetails(page, target, access) {
  const app = await fetchRaw(page, `/apps/${encodeSegment(target.appId)}`);
  const site = Object.entries(SITE_BASE_URLS).find(([, baseUrl]) => baseUrl === target.baseUrl)?.[0];
  assert(site, 'HIPPO_SITE_INVALID', '无法确定原请求站点，禁止生成默认站点的补授权命令');
  const grantArgv = [process.execPath, __filename, 'namespace-grant',
    `--hippo-site=${site}`, `--env=${target.env}`, `--cluster=${target.cluster}`,
    `--app-id=${target.appId}`, `--namespace=${target.namespaceName}`];
  return {
    site,
    env: target.env,
    cluster: target.cluster,
    appId: target.appId,
    namespace: target.namespaceName,
    roleNamespace: access.roleNamespace,
    appOwners: app.ok && app.json ? appOwnersFrom(app.data) : [],
    grantArgv,
    grantCommand: grantArgv.map((arg) => `'${String(arg).replace(/'/g, "'\\''")}'`).join(' '),
  };
}

// 没权限时先让上层去 namespace-grant 自助补权限；补不上就是没有该应用的 Hippo 权限，要用户去申请。
async function assertNamespaceWriteAccess(page, target, access, options) {
  if (options.requireModify && !access.hasModifyPermission) {
    fail('NAMESPACE_MODIFY_PERMISSION_DENIED',
      '当前账号没有该 namespace 的修改权限；先运行 namespace-grant 自助补授权，'
      + '若 namespace-grant 报 ASSIGN_ROLE_PERMISSION_DENIED，说明没有该应用的 Hippo 权限，需要向应用负责人申请后再重试'
      + await publicNamePrefixHint(page, target),
      await namespacePermissionDetails(page, target, access));
  }
  if (options.requirePublish && !access.hasReleasePermission) {
    fail('NAMESPACE_RELEASE_PERMISSION_DENIED',
      '当前账号没有该 namespace 的发布权限；先运行 namespace-grant 自助补授权，'
      + '若 namespace-grant 报 ASSIGN_ROLE_PERMISSION_DENIED，说明没有该应用的 Hippo 权限，需要向应用负责人申请后再重试',
      await namespacePermissionDetails(page, target, access));
  }
}

async function grantNamespaceRoles(page, appId, roleNamespace, roleTypes, users, before) {
  const { pending, already } = pendingRoleGrants(before.roleUsers, roleTypes, users);
  if (!pending.length) {
    return {
      granted: [],
      alreadyGranted: already,
      roleUsers: before.roleUsers,
      roleUsersUnchanged: true,
      nonTargetRoleUsersUnchanged: true,
    };
  }
  for (const grant of pending) {
    // eslint-disable-next-line no-await-in-loop
    await assignNamespaceRoleOnPage(page, appId, roleNamespace, grant.roleType, grant.user);
  }
  const after = await waitForRoleGrants(page, appId, roleNamespace,
    roleTypes.flatMap((roleType) => users.map((user) => ({ roleType, user }))));
  const diff = roleUsersDiff(before.roleUsers, after.roleUsers);
  assert(!diff.modify.removed.length && !diff.release.removed.length, 'NON_TARGET_ROLE_CHANGED',
    '授权期间发现已有授权用户被移除；立即停止并人工核对', { diff });
  const unexpectedAdded = [...diff.modify.added, ...diff.release.added]
    .filter((user) => !users.includes(user));
  assert(!unexpectedAdded.length, 'NON_TARGET_ROLE_CHANGED',
    '授权期间出现非目标用户的角色变化；立即停止并人工核对', { unexpectedAdded });
  return {
    granted: pending,
    alreadyGranted: already,
    roleUsers: after.roleUsers,
    roleUsersDiff: diff,
    nonTargetRoleUsersUnchanged: true,
  };
}

async function waitForNamespaceVisible(page, namespace, fullName, env, timeoutMs = 20000) {
  const paths = buildNamespacePaths(namespace, env, fullName);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const detail = await fetchRaw(page, paths.detail);
    if (detail.status === 200) return detail.data;
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(500);
  }
  fail('NAMESPACE_READBACK_TIMEOUT', '创建后回读没有看到新的 namespace', { env, namespace: fullName });
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

async function waitForPublishedState(page, target, paths, desired, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await readState(page, paths);
    const active = parseActive(latest.active);
    if (activeValueMatches(active, target, desired)) return latest;
    await page.waitForTimeout(500);
  }
  fail('PUBLISH_READBACK_TIMEOUT', '发布后 active release 未得到目标配置值');
}

async function publishDraft(page, target, selectedItem, options) {
  const result = await page.evaluate(async ({
    appId,
    env,
    cluster,
    namespaceName,
    releaseTitle,
    releaseComment,
    isEmergencyPublish,
    releaseSelectedItems,
  }) => {
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
    const releaseService = injector.get('ReleaseService');
    if (!releaseService || typeof releaseService.publish !== 'function') {
      throw new Error('ReleaseService.publish unavailable');
    }
    let stableEnv = false;
    try {
      const envService = injector.get('EnvService');
      const stableResult = await envService.is_stable_env();
      stableEnv = Boolean(stableResult?.isStableEnv);
    } catch (_) {
      stableEnv = false;
    }
    if (!stableEnv && typeof releaseService.checkIfWhiteApp === 'function') {
      const check = await releaseService.checkIfWhiteApp(
        appId,
        env,
        cluster,
        namespaceName,
        releaseTitle,
        releaseComment,
        isEmergencyPublish,
      );
      if (check?.isAbandoned === true) {
        return {
          approvalRequired: true,
          comment: check?.comment ?? null,
          result: check?.result ?? null,
          isAbandoned: true,
        };
      }
    }
    const release = await releaseService.publish(
      appId,
      env,
      cluster,
      namespaceName,
      releaseTitle,
      releaseComment,
      isEmergencyPublish,
      releaseSelectedItems,
    );
    return {
      approvalRequired: false,
      id: release?.id ?? null,
      releaseKey: release?.releaseKey ?? null,
      name: release?.name ?? null,
      comment: release?.comment ?? null,
      result: release?.result ?? null,
      isAbandoned: release?.isAbandoned ?? false,
      dataChangeCreatedBy: release?.dataChangeCreatedBy ?? null,
      dataChangeCreatedTime: release?.dataChangeCreatedTime ?? null,
    };
  }, {
    appId: target.appId,
    env: target.env,
    cluster: target.cluster,
    namespaceName: target.namespaceName,
    releaseTitle: options.releaseTitle,
    releaseComment: options.releaseComment,
    isEmergencyPublish: options.isEmergencyPublish,
    releaseSelectedItems: [selectedItem],
  });
  assert(!result.approvalRequired, 'PUBLISH_REQUIRES_APPROVAL',
    '该环境发布需要走 Hippo 审批流，脚本不会绕过审批直接发布', {
      comment: result.comment,
      result: result.result,
    });
  assert(!result.isAbandoned, 'PUBLISH_ABANDONED', 'Hippo 拒绝发布', {
    comment: result.comment,
    result: result.result,
  });
  return result;
}

async function publishTargetAndVerify(page, target, paths, targetItem, beforeActive, desired, options) {
  if (activeValueMatches(beforeActive, target, desired)) {
    return {
      publishAttempted: false,
      publishSkipped: true,
      publishSkipReason: 'active release already matches desired value',
      published: false,
    };
  }
  const selectedItem = releaseSelectedItem(target, targetItem, beforeActive, desired);
  const release = await publishDraft(page, target, selectedItem, options);
  const afterState = await waitForPublishedState(page, target, paths, desired);
  const afterSummarized = summarizeState(target, paths, afterState);
  const changedKeys = activeConfigChangedKeys(beforeActive.configurations, afterSummarized.active.configurations);
  assert(changedKeys.length === 1 && changedKeys[0] === target.key,
    'NON_TARGET_ACTIVE_CONFIG_CHANGED', '发布后 active release 出现非目标 key 变化', {
      changedKeys,
      targetKey: target.key,
    });
  assert(activeValueMatches(afterSummarized.active, target, desired),
    'PUBLISH_VERIFY_FAILED', '发布后 active release 目标值与期望不一致');
  return {
    publishAttempted: true,
    published: true,
    releaseTitle: options.releaseTitle,
    releaseCommentSha256: sha256(options.releaseComment),
    emergencyPublish: options.isEmergencyPublish,
    releaseSelectedItem: summarizeReleaseSelectedItem(selectedItem),
    activeChangedKeys: changedKeys,
    activeReleaseKeyBefore: beforeActive.release?.releaseKey || null,
    activeReleaseKeyAfter: afterSummarized.active.release?.releaseKey || null,
    activeReleaseIdBefore: beforeActive.release?.id ?? null,
    activeReleaseIdAfter: afterSummarized.active.release?.id ?? null,
    activeConfigurationsSha256AfterPublish: sha256(afterSummarized.active.rawConfigurations),
    afterDraftDiffKeys: afterSummarized.summary.draftDiffKeys,
    // 只发目标 key：namespace 里别人的未发布草稿原样留着，这里点名列出，方便上层确认没被带出去。
    otherDraftKeysLeftUnpublished: afterSummarized.summary.draftDiffKeys.filter((key) => key !== target.key),
    publishResult: release,
  };
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
  hippo_draft_config.js namespace-status --app-id=<app> --namespace=<new ns>
  hippo_draft_config.js namespace-plan --app-id=<app> --namespace=<new ns> --comment=<10-64 字符备注>
  hippo_draft_config.js namespace-create --app-id=<app> --namespace=<new ns> --comment=<备注>
      --create-authorization=explicit --expected-current-token=<namespace-plan token>
      [--no-auto-grant]
  hippo_draft_config.js namespace-roles --app-id=<app> --namespace=<ns>
  hippo_draft_config.js namespace-grant --app-id=<app> --namespace=<ns>
      [--grant-users=<id1,id2> --grant-authorization=explicit] [--roles=modify,release]
  hippo_draft_config.js self-test

Defaults: --env=fql_pre --cluster=default --namespace=application
Sites: --hippo-site=standard|stable|mx|id
  standard http://hippo.oa.fenqile.com, stable http://stable-hippo.oa.fenqile.com,
  mx https://hippo.oa.wowcredito.com, id https://hippo.oa.kredito.id
Stable aliases: stable/test/testing/prj/project/测试/项目/项目环境 -> env=fql_pre and stable Hippo host
Overseas: env prefixes are per site, mx -> mxyw_pre/mxyw_prod, id -> ynyw_prod (id has no pre env,
  so its default env is ynyw_prod and every id write needs --allow-non-pre).
  --env=prod --hippo-site=mx resolves to mxyw_prod; a full env such as mxyw_pre routes to its site by itself.
Use --hippo-site=stable with explicit envs such as pdwl_pre when navtree shows a stable env prefix.
Safety: upsert saves a draft by default. Publishing requires --publish, --publish-authorization=explicit,
and the current plan token via --expected-current-token. Publish selects only the target key.
Stable is the exception: on the stable site upsert publishes the target key automatically after the
draft is saved and verified (no approval flow exists there); pass --no-publish to keep a draft only.
Namespace creation (POST /apps/<app>/appnamespaces) is an app level action: Hippo creates the same
empty namespace in every env of the site, so it is never pre only. Namespaces and roles are per site:
standard, stable, mx and id are separate Hippo instances, so run the namespace-* commands once per
site with the same --env / --hippo-site switches as the config commands (stable usually has fql_pre only). It needs
--create-authorization=explicit plus the namespace-plan token, refuses to touch an existing namespace,
and creates nothing but an empty namespace (no items, no release).
Namespace options: --format=properties|xml|sh|json|yml (default properties), --encrypt (properties only),
--group-id=<namespace group id> (default 0), --comment=<10-64 chars> or --comment-file=<file>.
Namespace roles: POST /apps/<app>/namespaces/<ns>/roles/ModifyNamespace|ReleaseNamespace, one user
per request; roles are only added, never removed, and every grant is verified by reading role_users
back. Grouped namespaces use <groupPath>!<namespaceName> in the role path.
namespace-create auto grants the default owners (joneyshao) modify plus release right after the
namespace is verified - no extra prompt, since the create authorization already covers it. Pass
--no-auto-grant to skip it. namespace-grant with no --grant-users does the same self service grant
on an existing namespace; granting anyone else needs --grant-users with --grant-authorization=explicit.
Access: status/plan/upsert report hasModifyPermission and hasReleasePermission for the current user.
upsert refuses to write without modify permission (NAMESPACE_MODIFY_PERMISSION_DENIED) and refuses to
publish without release permission (NAMESPACE_RELEASE_PERMISSION_DENIED); both point at namespace-grant.
When namespace-grant itself fails with ASSIGN_ROLE_PERMISSION_DENIED the account has no Hippo rights on
the app at all, and the error lists the app owners to ask for access.
`;
}

function runSelfTest() {
  assert(normalizeEnv('pre') === 'fql_pre', 'SELF_TEST_FAILED', 'pre 环境映射失败');
  assert(normalizeEnv('prod') === 'fql_prod', 'SELF_TEST_FAILED', 'prod 环境映射失败');
  assert(normalizeEnv('stable') === 'fql_pre', 'SELF_TEST_FAILED', 'stable 环境映射失败');
  assert(normalizeEnv('test') === 'fql_pre', 'SELF_TEST_FAILED', 'test 环境映射失败');
  assert(normalizeEnv('项目环境') === 'fql_pre', 'SELF_TEST_FAILED', '项目环境映射失败');
  assert(resolveBaseUrl('fql_pre', 'stable') === STABLE_BASE_URL, 'SELF_TEST_FAILED', 'stable 域名映射失败');
  assert(resolveBaseUrl('fql_pre', 'test') === STABLE_BASE_URL, 'SELF_TEST_FAILED', 'test 域名映射失败');
  assert(resolveBaseUrl('pdwl_pre', 'pdwl_pre', 'stable') === STABLE_BASE_URL, 'SELF_TEST_FAILED', '显式 stable 站点映射失败');
  assert(resolveBaseUrl('fql_pre', 'pre') === STANDARD_BASE_URL, 'SELF_TEST_FAILED', '预发标准域名映射失败');
  assert(resolveBaseUrl('fql_prod', 'prod') === STANDARD_BASE_URL, 'SELF_TEST_FAILED', '标准域名映射失败');
  assert(normalizeEnv('prod', 'mx') === 'mxyw_prod', 'SELF_TEST_FAILED', '墨西哥线上环境映射失败');
  assert(normalizeEnv('pre', 'mx') === 'mxyw_pre', 'SELF_TEST_FAILED', '墨西哥预发环境映射失败');
  assert(normalizeEnv('prod', 'id') === 'ynyw_prod', 'SELF_TEST_FAILED', '印尼线上环境映射失败');
  assert(normalizeEnv('mx') === 'mxyw_prod', 'SELF_TEST_FAILED', '墨西哥别名默认线上失败');
  assert(normalizeEnv('印尼') === 'ynyw_prod', 'SELF_TEST_FAILED', '印尼别名默认线上失败');
  assert(normalizeEnv('mxyw_pre') === 'mxyw_pre', 'SELF_TEST_FAILED', '完整海外 env 应原样保留');
  assert(normalizeEnv(undefined, 'mx') === 'mxyw_pre', 'SELF_TEST_FAILED', '墨西哥缺省环境应为 mxyw_pre');
  assert(normalizeEnv(undefined, 'id') === 'ynyw_prod', 'SELF_TEST_FAILED', '印尼缺省环境应为 ynyw_prod');
  assert(SITE_UNGUARDED_WRITE_ENVS.id === null, 'SELF_TEST_FAILED', '印尼不应存在免保护写入环境');
  assert(resolveSite('墨西哥') === 'mx' && resolveSite('kredito') === 'id',
    'SELF_TEST_FAILED', '海外站点别名解析失败');
  assert(resolveSite('mxyw_prod') === 'mx' && resolveSite('ynyw_prod') === 'id',
    'SELF_TEST_FAILED', '海外 env 前缀路由失败');
  assert(resolveSite('fql_prod') === 'standard' && resolveSite('pdwl_pre') === 'standard',
    'SELF_TEST_FAILED', '国内 env 前缀路由失败');
  assert(resolveBaseUrl('mxyw_prod', 'mxyw_prod') === SITE_BASE_URLS.mx,
    'SELF_TEST_FAILED', '墨西哥域名映射失败');
  assert(resolveBaseUrl('ynyw_prod', undefined, 'id') === SITE_BASE_URLS.id,
    'SELF_TEST_FAILED', '印尼域名映射失败');
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
  assert(JSON.stringify(activeConfigChangedKeys({ same: '1', target: 'active' }, { same: '1', target: 'next' }))
    === JSON.stringify(['target']), 'SELF_TEST_FAILED', 'active changed keys 计算失败');
  const selected = releaseSelectedItem(target, items[1], summarized.active, desired);
  assert(selected.key === 'target' && selected.type === 'modify' && selected.id === 2,
    'SELF_TEST_FAILED', '发布选择项计算失败');
  const publish = publishOptions({
    publish: true,
    'publish-authorization': PUBLISH_AUTHORIZATION_VALUE,
    'expected-current-token': summarized.currentStateToken,
  }, summarized);
  assert(publish.enabled && publish.releaseTitle.endsWith('-release'),
    'SELF_TEST_FAILED', '发布选项计算失败');
  let publishRejected = false;
  try {
    publishOptions({ publish: true }, summarized);
  } catch (error) {
    publishRejected = error.code === 'PUBLISH_AUTHORIZATION_REQUIRED';
  }
  assert(publishRejected, 'SELF_TEST_FAILED', '发布授权缺失未被拒绝');
  const stablePublish = publishOptions({}, summarized, 'stable');
  assert(stablePublish.enabled && stablePublish.autoPublish
    && stablePublish.releaseComment.startsWith('codex stable auto publish'),
    'SELF_TEST_FAILED', 'stable 站点未默认自动发布');
  assert(publishOptions({ 'no-publish': true }, summarized, 'stable').enabled === false,
    'SELF_TEST_FAILED', 'stable 站点 --no-publish 未生效');
  assert(publishOptions({}, summarized, 'standard').enabled === false
    && publishOptions({}, summarized, 'mx').enabled === false,
    'SELF_TEST_FAILED', '非 stable 站点不应自动发布');
  assert(publishOptions({ publish: true, 'no-publish': true }, summarized, 'standard').enabled === false,
    'SELF_TEST_FAILED', '--no-publish 应优先于 --publish');
  assert(planChange(target, summarized, { value: 'draft', comment: undefined }).operation === 'noop',
    'SELF_TEST_FAILED', 'noop plan 计算失败');
  let staleRejected = false;
  try {
    planChange(target, summarized, desired, 'stale-token');
  } catch (error) {
    staleRejected = error.code === 'CONCURRENT_DRAFT_CHANGED';
  }
  assert(staleRejected, 'SELF_TEST_FAILED', '并发 token 未拒绝旧状态');
  assert(resolveNamespacePublicity({ type: 1 }).isPublic === false
    && resolveNamespacePublicity({ type: 0 }).isPublic === true,
    'SELF_TEST_FAILED', '应用类型到 namespace 公私有的映射失败');
  assert(fullNamespaceName('encryption', false, 'hippo') === 'encryption'
    && fullNamespaceName('encryption', true, 'hippo') === 'hippo.encryption',
    'SELF_TEST_FAILED', '公共 namespace 前缀拼接失败');
  const namespaceRejects = (fn, code) => {
    try {
      fn();
    } catch (error) {
      return error.code === code;
    }
    return false;
  };
  assert(namespaceRejects(() => validateNamespaceName('bad-name', 'bad-name'), 'NAMESPACE_NAME_INVALID'),
    'SELF_TEST_FAILED', '非法 namespace 名称未被拒绝');
  assert(namespaceRejects(() => validateNamespaceName('a'.repeat(65), 'a'.repeat(65)), 'NAMESPACE_NAME_TOO_LONG'),
    'SELF_TEST_FAILED', '超长 namespace 名称未被拒绝');
  assert(namespaceRejects(() => validateNamespaceComment('太短'), 'NAMESPACE_COMMENT_INVALID'),
    'SELF_TEST_FAILED', '过短备注未被拒绝');
  assert(validateNamespaceComment('  hawk 加解密配置  ') === 'hawk 加解密配置',
    'SELF_TEST_FAILED', '备注归一化失败');
  assert(namespaceRejects(() => normalizeNamespaceFormat('ini'), 'NAMESPACE_FORMAT_INVALID'),
    'SELF_TEST_FAILED', '非法 namespace 格式未被拒绝');
  const nsArgs = { namespace: 'encryption', comment: 'hawk 加解密相关配置' };
  const desiredNamespace = readNamespaceDesired(nsArgs, { name: 'encryption' }, { type: 1, orgId: 'hippo' });
  assert(desiredNamespace.fullName === 'encryption' && desiredNamespace.format === 'properties'
    && desiredNamespace.isPublic === false && desiredNamespace.isEncrypt === false
    && desiredNamespace.groupId === 0, 'SELF_TEST_FAILED', 'namespace 创建参数解析失败');
  assert(JSON.stringify(namespaceCreationPayload('demo', desiredNamespace))
    === JSON.stringify({
      appId: 'demo',
      name: 'encryption',
      comment: 'hawk 加解密相关配置',
      isPublic: false,
      format: 'properties',
      isEncrypt: false,
      groupId: 0,
    }), 'SELF_TEST_FAILED', 'namespace 创建请求体拼装失败');
  assert(namespaceRejects(
    () => readNamespaceDesired({ ...nsArgs, format: 'json', encrypt: true }, { name: 'encryption' }, { type: 1 }),
    'NAMESPACE_ENCRYPT_UNSUPPORTED'), 'SELF_TEST_FAILED', '非 properties 格式的加密未被拒绝');
  const nsProbes = [
    { env: 'fql_pre', cluster: 'default', clusterMissing: false, exists: false, namespaceId: null, namespaceNames: ['application'] },
    { env: 'fql_prod', cluster: 'default', clusterMissing: false, exists: false, namespaceId: null, namespaceNames: ['application'] },
  ];
  assert(namespaceOperation(nsProbes) === 'create', 'SELF_TEST_FAILED', 'namespace create 判定失败');
  assert(namespaceOperation([{ ...nsProbes[0], exists: true }, nsProbes[1]]) === 'partial',
    'SELF_TEST_FAILED', 'namespace partial 判定失败');
  assert(namespaceOperation(nsProbes.map((row) => ({ ...row, exists: true }))) === 'exists',
    'SELF_TEST_FAILED', 'namespace exists 判定失败');
  assert(namespaceRejects(() => namespaceOperation([{ ...nsProbes[0], clusterMissing: true }]),
    'NAMESPACE_ENV_NOT_FOUND'), 'SELF_TEST_FAILED', '无可用 env 未被拒绝');
  assert(JSON.stringify(namespaceListDiff(['application'], ['application', 'encryption']))
    === JSON.stringify({ added: ['encryption'], removed: [] }),
    'SELF_TEST_FAILED', 'namespace 列表差异计算失败');
  assert(JSON.stringify(namespaceNamesFrom({
    elements: [
      { baseInfo: { namespaceName: 'application' } },
      { namespace: { namespaceName: 'encryption' } },
      { namespaceName: 'application' },
    ],
  })) === JSON.stringify(['application', 'encryption']),
    'SELF_TEST_FAILED', 'namespace 名解析或去重失败');
  assert(JSON.stringify(normalizeRoleTypes(undefined)) === JSON.stringify(['ModifyNamespace', 'ReleaseNamespace']),
    'SELF_TEST_FAILED', '默认角色解析失败');
  assert(JSON.stringify(normalizeRoleTypes('release,ModifyNamespace,release'))
    === JSON.stringify(['ReleaseNamespace', 'ModifyNamespace']),
    'SELF_TEST_FAILED', '角色别名或去重失败');
  assert(namespaceRejects(() => normalizeRoleTypes('admin'), 'NAMESPACE_ROLE_INVALID'),
    'SELF_TEST_FAILED', '非法角色未被拒绝');
  assert(JSON.stringify(parseGrantUsers('joneyshao, peterzhong ,joneyshao'))
    === JSON.stringify(['joneyshao', 'peterzhong']), 'SELF_TEST_FAILED', '授权用户解析或去重失败');
  assert(namespaceRejects(() => parseGrantUsers(''), 'GRANT_USERS_REQUIRED'),
    'SELF_TEST_FAILED', '空授权用户未被拒绝');
  assert(namespaceRejects(() => parseGrantUsers('bad user'), 'GRANT_USER_INVALID'),
    'SELF_TEST_FAILED', '非法用户 id 未被拒绝');
  assert(JSON.stringify(appOwnersFrom({ ownerName: 'joneyshao;peterzhong, taurusjiang ;' }))
    === JSON.stringify(['joneyshao', 'peterzhong', 'taurusjiang']),
    'SELF_TEST_FAILED', '应用负责人解析失败');
  assert(JSON.stringify(appOwnersFrom({})) === '[]', 'SELF_TEST_FAILED', '空负责人解析失败');
  assert(JSON.stringify(resolveAutoGrantUsers({})) === JSON.stringify(DEFAULT_NAMESPACE_GRANT_USERS),
    'SELF_TEST_FAILED', '默认自动授权名单失败');
  assert(JSON.stringify(resolveAutoGrantUsers({ 'no-auto-grant': true })) === '[]',
    'SELF_TEST_FAILED', '--no-auto-grant 未生效');
  assert(namespaceRejects(() => resolveAutoGrantUsers({ 'grant-users': 'someoneelse' }),
    'GRANT_AUTHORIZATION_REQUIRED'), 'SELF_TEST_FAILED', '默认名单外的自动授权未要求明确授权');
  assert(JSON.stringify(resolveAutoGrantUsers({
    'grant-users': 'someoneelse',
    'grant-authorization': GRANT_AUTHORIZATION_VALUE,
  })) === JSON.stringify(['someoneelse']), 'SELF_TEST_FAILED', '显式授权的自动授权名单解析失败');
  assert(roleNamespacePath('encryption', '') === 'encryption'
    && roleNamespacePath('encryption', 'hawk') === 'hawk!encryption',
    'SELF_TEST_FAILED', '分组 namespace 角色路径拼接失败');
  const beforeRoles = roleUsersSummary({
    modifyRoleUsers: [{ userId: 'peterzhong' }, { userId: 'joneyshao' }],
    releaseRoleUsers: [{ userId: 'peterzhong' }],
  });
  assert(JSON.stringify(beforeRoles.modifyRoleUsers) === JSON.stringify(['joneyshao', 'peterzhong']),
    'SELF_TEST_FAILED', '角色用户解析失败');
  const rolePlan = pendingRoleGrants(beforeRoles, ['ModifyNamespace', 'ReleaseNamespace'], ['joneyshao']);
  assert(rolePlan.pending.length === 1 && rolePlan.pending[0].roleType === 'ReleaseNamespace'
    && rolePlan.already.length === 1, 'SELF_TEST_FAILED', '待授权项计算失败');
  const afterRoles = roleUsersSummary({
    modifyRoleUsers: [{ userId: 'peterzhong' }, { userId: 'joneyshao' }],
    releaseRoleUsers: [{ userId: 'peterzhong' }, { userId: 'joneyshao' }],
  });
  const rolesDiff = roleUsersDiff(beforeRoles, afterRoles);
  assert(JSON.stringify(rolesDiff.release.added) === JSON.stringify(['joneyshao'])
    && !rolesDiff.release.removed.length && !rolesDiff.modify.added.length,
    'SELF_TEST_FAILED', '角色变化计算失败');
  const nsTokenContext = { site: 'standard', appId: 'demo', fullName: 'encryption', envs: nsProbes };
  assert(makeNamespaceStateToken(nsTokenContext) === makeNamespaceStateToken(nsTokenContext),
    'SELF_TEST_FAILED', 'namespace 状态 token 不稳定');
  assert(makeNamespaceStateToken(nsTokenContext)
    !== makeNamespaceStateToken({ ...nsTokenContext, envs: [{ ...nsProbes[0], exists: true }, nsProbes[1]] }),
    'SELF_TEST_FAILED', 'namespace 状态 token 未反映存在性变化');
  process.stdout.write(`${JSON.stringify({ selfTest: 'passed', publishAttempted: false, created: false }, null, 2)}\n`);
}

function summarizeNamespaceState(runtime, context, fullName, publicity, probes) {
  const namespace = runtime.namespace;
  const probed = probes.filter((row) => !row.clusterMissing);
  const readbackEnv = probed.some((row) => row.env === runtime.env) ? runtime.env : probed[0]?.env || '';
  return {
    target: `${namespace.appId}/${fullName}`,
    appId: namespace.appId,
    site: runtime.site,
    baseUrl: runtime.baseUrl,
    env: runtime.env,
    readbackEnv,
    cluster: namespace.cluster,
    requestedNamespace: namespace.name,
    namespace: fullName,
    appType: publicity.appType,
    appOrgId: String(context.app?.orgId || ''),
    isPublic: publicity.isPublic,
    hasCreateNamespacePermission: context.hasCreateNamespacePermission,
    canAppAdminCreatePrivateNamespace: context.canAppAdminCreatePrivateNamespace,
    namespaceGroups: context.groups,
    envs: probes.map((row) => ({
      env: row.env,
      cluster: row.cluster,
      clusterMissing: row.clusterMissing,
      exists: row.exists,
      namespaceId: row.namespaceId,
      namespaceCount: row.namespaceNames.length,
      detail: row.detail,
    })),
    existsEnvs: probes.filter((row) => row.exists).map((row) => row.env),
    missingEnvs: probes.filter((row) => !row.exists && !row.clusterMissing).map((row) => row.env),
    skippedEnvs: probes.filter((row) => row.clusterMissing).map((row) => row.env),
    operation: namespaceOperation(probes),
    currentStateToken: makeNamespaceStateToken({
      site: runtime.site,
      appId: namespace.appId,
      fullName,
      envs: probes,
    }),
    publishAttempted: false,
    published: false,
  };
}

async function runNamespaceRoleCommand(command, args, page, state) {
  const { namespace, fullName, probes, summary } = state;
  const existing = probes.filter((row) => row.exists);
  // 公共应用（虚拟应用）的 namespace 真名带 <orgId>. 前缀；roles/grant 按原样使用传入的名字，
  // 传不带前缀的名字会查不到，报「不存在」会把用户引向重新创建，而实际只是名字写法不对。
  const publicHint = state.context && !namespace.name.includes('.')
    && resolveNamespacePublicity(state.context.app).isPublic
    ? `；该应用是公共（虚拟）应用，namespace 真名带前缀，请改用 --namespace=`
      + `${fullNamespaceName(namespace.name, true, state.context.app?.orgId)}`
    : '';
  assert(existing.length > 0, 'NAMESPACE_NOT_FOUND',
    `目标 namespace 不存在；先用 namespace-create 新建，再授权${publicHint}`,
    { namespace: fullName, publicAppHint: Boolean(publicHint) });
  const readbackRow = existing.find((row) => row.env === summary.readbackEnv) || existing[0];
  const groupPath = readbackRow.detail?.groupPath || '';
  const roleNamespace = roleNamespacePath(fullName, groupPath);
  const before = await readNamespaceRoles(page, namespace.appId, roleNamespace);
  const permissions = await readNamespacePermissions(page, namespace.appId, roleNamespace);
  const base = {
    command,
    target: summary.target,
    appId: namespace.appId,
    site: summary.site,
    baseUrl: summary.baseUrl,
    namespace: fullName,
    roleNamespace,
    groupPath,
    existsEnvs: summary.existsEnvs,
    hasAssignRolePermission: before.hasAssignRolePermission,
    hasModifyPermission: permissions.hasModifyPermission,
    hasReleasePermission: permissions.hasReleasePermission,
    appOwners: appOwnersFrom(state.context.app),
    currentUser: before.currentUser,
    modifyRoleUsers: before.roleUsers.modifyRoleUsers,
    releaseRoleUsers: before.roleUsers.releaseRoleUsers,
    publishAttempted: false,
    published: false,
  };
  if (command === 'namespace-roles') {
    return { ...base, granted: [], grantAuthorizationRequired: true };
  }

  const roleTypes = normalizeRoleTypes(args.roles);
  // 不传 --grant-users 就是给默认名单补授权，和 namespace-create 的自动授权同一条规则。
  const users = resolveAutoGrantUsers(args);
  assert(users.length > 0, 'GRANT_USERS_REQUIRED',
    'namespace-grant 的授权名单为空；去掉 --no-auto-grant 或显式传 --grant-users');
  assert(before.hasAssignRolePermission, 'ASSIGN_ROLE_PERMISSION_DENIED',
    '当前账号没有该应用的授权权限（AssignRole），无法自助补授权；'
    + '这说明你没有该应用的 Hippo 权限，需要向应用负责人申请后再重试', {
      appId: namespace.appId,
      namespace: fullName,
      roleNamespace,
      appOwners: appOwnersFrom(state.context.app),
      currentUser: before.currentUser,
    });
  const { roleUsers, ...result } = await grantNamespaceRoles(page, namespace.appId, roleNamespace,
    roleTypes, users, before);
  return {
    ...base,
    roleTypes,
    grantUsers: users,
    ...result,
    modifyRoleUsers: roleUsers.modifyRoleUsers,
    releaseRoleUsers: roleUsers.releaseRoleUsers,
    modifyRoleUsersBefore: before.roleUsers.modifyRoleUsers,
    releaseRoleUsersBefore: before.roleUsers.releaseRoleUsers,
  };
}

async function runNamespaceCommand(command, runtime, args, page) {
  const namespace = runtime.namespace;
  const needsDesired = command === 'namespace-plan' || command === 'namespace-create';
  // 全部纯授权参数校验必须发生在首笔创建写入之前。
  const autoGrantUsers = needsDesired ? resolveAutoGrantUsers(args) : [];
  const autoGrantRoles = needsDesired ? normalizeRoleTypes(args.roles) : [];
  const context = await readNamespaceContext(page, namespace.appId);
  const publicity = resolveNamespacePublicity(context.app);
  const desired = needsDesired ? readNamespaceDesired(args, namespace, context.app) : null;
  // plan/create/status 预测新建后的名字（公共应用会加 <orgId>. 前缀）；
  // roles/grant 操作的是已存在的 namespace，名字按页面上看到的原样使用，不加前缀也不套命名规则。
  const predictsCreatedName = command === 'namespace-status' && !namespace.name.includes('.');
  const fullName = desired
    ? desired.fullName
    : (predictsCreatedName
      ? fullNamespaceName(namespace.name, publicity.isPublic, context.app?.orgId)
      : namespace.name);
  const probes = await probeNamespaceEnvs(page, namespace, fullName, context.envs);
  const summary = summarizeNamespaceState(runtime, context, fullName, publicity, probes);
  if (command === 'namespace-status') return { command, ...summary };
  if (command === 'namespace-roles' || command === 'namespace-grant') {
    return runNamespaceRoleCommand(command, args, page, { namespace, fullName, probes, summary, context });
  }

  const plan = {
    command,
    ...summary,
    format: desired.format,
    isEncrypt: desired.isEncrypt,
    groupId: desired.groupId,
    commentCharacters: desired.comment.length,
    commentSha256: sha256(desired.comment),
  };
  if (command === 'namespace-plan') {
    return {
      ...plan,
      createAuthorizationRequired: true,
      autoGrantUsers,
      autoGrantRoles,
      created: false,
    };
  }

  assert(command === 'namespace-create', 'COMMAND_INVALID', `不支持的 command: ${command}`);
  assert(String(args['create-authorization'] || '') === CREATE_AUTHORIZATION_VALUE,
    'CREATE_AUTHORIZATION_REQUIRED',
    '新建 namespace 必须由用户在当前对话中明确授权，并传 --create-authorization=explicit');
  assert(args['expected-current-token'], 'EXPECTED_TOKEN_REQUIRED_FOR_CREATE',
    '新建 namespace 必须携带本次 namespace-plan 返回的 currentStateToken', {
      currentStateToken: summary.currentStateToken,
    });
  assert(String(args['expected-current-token']) === summary.currentStateToken,
    'CONCURRENT_NAMESPACE_CHANGED', '当前 namespace 状态与 plan 时不同，请重新运行 namespace-plan', {
      currentStateToken: summary.currentStateToken,
    });
  assert(summary.operation === 'create', 'NAMESPACE_ALREADY_EXISTS',
    '目标 namespace 已存在；本 skill 不修改或删除已有 namespace', {
      existsEnvs: summary.existsEnvs,
      operation: summary.operation,
    });
  assert(context.hasCreateNamespacePermission, 'CREATE_NAMESPACE_PERMISSION_DENIED',
    '当前账号没有该应用的新建 namespace 权限', { appId: namespace.appId });
  if (desired.groupId) {
    assert(context.groups.some((group) => Number(group.id) === desired.groupId), 'NAMESPACE_GROUP_NOT_FOUND',
      '--group-id 不在该应用的 namespace 分组里', {
        groupId: desired.groupId,
        groups: context.groups,
      });
  }

  const createResult = await createAppNamespaceOnPage(page, namespaceCreationPayload(namespace.appId, desired));
  await waitForNamespaceVisible(page, namespace, fullName, summary.readbackEnv);
  const afterProbes = await probeNamespaceEnvs(page, namespace, fullName, context.envs);
  const afterSummary = summarizeNamespaceState(runtime, context, fullName, publicity, afterProbes);
  const listDiffs = probes.map((before, index) => ({
    env: before.env,
    ...namespaceListDiff(before.namespaceNames, afterProbes[index].namespaceNames),
  }));
  const unexpectedDiffs = listDiffs.filter((diff) => diff.removed.length
    || diff.added.some((name) => name !== fullName));
  assert(!unexpectedDiffs.length, 'NON_TARGET_NAMESPACE_CHANGED',
    '创建期间发现非目标 namespace 变化；停止并人工核对', { unexpectedDiffs });

  const createdRows = afterProbes.filter((row) => row.exists);
  assert(createdRows.length > 0, 'NAMESPACE_READBACK_TIMEOUT', '创建后回读没有看到新的 namespace');
  assert(!afterSummary.missingEnvs.length, 'NAMESPACE_VERIFY_FAILED',
    '部分目标环境未完成创建；namespace 可能已创建，停止授权且不要自动重新创建', {
      missingEnvs: afterSummary.missingEnvs,
    });
  const fieldMismatches = [];
  for (const row of createdRows) {
    assert(row.detail.namespaceName === fullName, 'NAMESPACE_VERIFY_FAILED',
      '创建后回读的 namespace 名称与期望不一致', { env: row.env, actual: row.detail.namespaceName });
    assert(row.detail.itemCount === 0, 'NAMESPACE_NOT_EMPTY',
      '新建的 namespace 不应包含配置项', { env: row.env, itemCount: row.detail.itemCount });
    assert(row.detail.isPublic === desired.isPublic, 'NAMESPACE_VERIFY_FAILED',
      '创建后 namespace 的 public 属性与期望不一致', { env: row.env, actual: row.detail.isPublic });
    assert(row.detail.isEncrypt === desired.isEncrypt, 'NAMESPACE_VERIFY_FAILED',
      '创建后 namespace 的加密属性与期望不一致', { env: row.env, actual: row.detail.isEncrypt });
    assert(row.detail.format === desired.format, 'NAMESPACE_VERIFY_FAILED',
      '创建后 namespace 的格式与期望不一致', { env: row.env, actual: row.detail.format });
    if (row.detail.commentSha256 !== sha256(desired.comment)) fieldMismatches.push({ env: row.env, field: 'comment' });
    if (Number(row.detail.groupId ?? 0) !== desired.groupId) fieldMismatches.push({ env: row.env, field: 'groupId' });
  }
  assert(!fieldMismatches.length, 'NAMESPACE_VERIFY_FAILED',
    '创建后的字段与请求不一致；namespace 可能已创建，停止授权且不要自动重新创建', { fieldMismatches });
  const actives = await Promise.all(createdRows.map(async (row) => {
    const result = await fetchRaw(page, buildNamespacePaths(namespace, row.env, fullName).active);
    assert(result.ok && result.json && Array.isArray(result.data), 'NAMESPACE_ACTIVE_VERIFY_FAILED',
      '创建后无法验证 active release；namespace 可能已创建，停止授权且不要自动重新创建', {
        env: row.env, status: result.status,
      });
    return result.data;
  }));
  const envsWithRelease = createdRows
    .filter((row, index) => actives[index].length > 0)
    .map((row) => row.env);
  assert(!envsWithRelease.length, 'NAMESPACE_UNEXPECTED_RELEASE',
    '新建的 namespace 不应带有 active release；请人工核对', { envsWithRelease });

  // 新 namespace 默认要有人能改能发；创建授权已经覆盖这一步，不再单独询问。
  const roleNamespace = roleNamespacePath(fullName,
    createdRows.find((row) => row.env === summary.readbackEnv)?.detail?.groupPath
      || createdRows[0].detail?.groupPath || '');
  let autoGrant = { skipped: true, reason: 'disabled by --no-auto-grant', users: [], granted: [], alreadyGranted: [] };
  if (autoGrantUsers.length) {
    const beforeRoles = await readNamespaceRoles(page, namespace.appId, roleNamespace);
    const { pending } = pendingRoleGrants(beforeRoles.roleUsers, autoGrantRoles, autoGrantUsers);
    if (pending.length && !beforeRoles.hasAssignRolePermission) {
      // namespace 已经建好了，这里不再抛错，只把缺口报出来让上层决定。
      autoGrant = {
        skipped: true,
        reason: 'ASSIGN_ROLE_PERMISSION_DENIED',
        users: autoGrantUsers,
        roleTypes: autoGrantRoles,
        granted: [],
        alreadyGranted: [],
        pending,
        modifyRoleUsers: beforeRoles.roleUsers.modifyRoleUsers,
        releaseRoleUsers: beforeRoles.roleUsers.releaseRoleUsers,
      };
    } else {
      const { roleUsers, ...result } = await grantNamespaceRoles(page, namespace.appId, roleNamespace,
        autoGrantRoles, autoGrantUsers, beforeRoles);
      autoGrant = {
        skipped: false,
        users: autoGrantUsers,
        roleTypes: autoGrantRoles,
        roleNamespace,
        ...result,
        modifyRoleUsers: roleUsers.modifyRoleUsers,
        releaseRoleUsers: roleUsers.releaseRoleUsers,
      };
    }
  }

  return {
    autoGrant,
    ...plan,
    created: true,
    createResult,
    createdEnvs: afterSummary.existsEnvs,
    stillMissingEnvs: afterSummary.missingEnvs,
    skippedEnvs: afterSummary.skippedEnvs,
    envs: afterSummary.envs,
    operation: afterSummary.operation,
    currentStateToken: afterSummary.currentStateToken,
    otherNamespacesUnchanged: true,
    targetNamespaceEmpty: true,
    hasActiveRelease: false,
    fieldMismatches,
    publishAttempted: false,
    published: false,
  };
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
        defaultEnv: runtime.env,
        site: runtime.site,
        baseUrl: runtime.baseUrl,
        publishAttempted: false,
      };
    }

    if (NAMESPACE_COMMANDS.has(command)) {
      assert(!flagEnabled(args.publish), 'PUBLISH_COMMAND_INVALID',
        'namespace 命令不发布任何配置；新建 namespace 不需要 --publish');
      // 必须 await：finally 会关闭浏览器 context，直接 return promise 会在关闭后才继续执行。
      return await runNamespaceCommand(command, runtime, args, browser.page);
    }

    const state = await readState(browser.page, runtime.paths);
    const summarized = summarizeState(runtime.target, runtime.paths, state);
    assert(!flagEnabled(args.publish) || command === 'upsert', 'PUBLISH_COMMAND_INVALID',
      '只有 upsert 支持 --publish；plan/verify/status 不会发布');
    const access = await readNamespaceAccess(browser.page, runtime.target);
    const accessSummary = {
      roleNamespace: access.roleNamespace,
      hasModifyPermission: access.hasModifyPermission,
      hasReleasePermission: access.hasReleasePermission,
    };
    if (command === 'status') return { command, ...summarized.summary, ...accessSummary };

    const desired = readDesired(args);
    const plan = planChange(runtime.target, summarized, desired,
      args['expected-current-token'] === undefined ? undefined : String(args['expected-current-token']));
    const common = {
      command,
      ...summarized.summary,
      ...accessSummary,
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
        activeEqualsDesired: activeValueMatches(summarized.active, runtime.target, desired),
        published: activeValueMatches(summarized.active, runtime.target, desired),
      };
    }

    assert(command === 'upsert', 'COMMAND_INVALID', `不支持的 command: ${command}`);
    const publish = publishOptions(args, summarized, runtime.site);
    await assertNamespaceWriteAccess(browser.page, runtime.target, access, {
      requireModify: plan.operation !== 'noop',
      requirePublish: publish.enabled,
    });
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
      if (publish.enabled) {
        const publishResult = await publishTargetAndVerify(
          browser.page,
          runtime.target,
          runtime.paths,
          afterSummarized.targetItem,
          afterSummarized.active,
          desired,
          publish,
        );
        return {
          ...common,
          draftSaved: false,
          targetItemValidated: Boolean(afterSummarized.targetItem),
          otherDraftItemsUnchangedBeforePublish: true,
          nonTargetActiveConfigurationsUnchanged: true,
          autoPublish: publish.autoPublish,
          ...publishResult,
        };
      }
      return {
        ...common,
        draftSaved: false,
        afterDraftDiffKeys: afterSummarized.summary.draftDiffKeys,
        otherItemsUnchanged: true,
        activeReleaseKeyUnchanged: true,
        activeConfigurationsUnchanged: true,
        activeReleaseIdUnchanged: true,
        autoPublish: false,
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
    if (publish.enabled) {
      const publishResult = await publishTargetAndVerify(
        browser.page,
        runtime.target,
        runtime.paths,
        afterSummarized.targetItem,
        afterSummarized.active,
        desired,
        publish,
      );
      return {
        ...common,
        operation: mutation.operation,
        draftSaved: true,
        targetItemValidated: true,
        otherDraftItemsUnchangedBeforePublish: true,
        activeReleaseUnchangedBeforePublish: true,
        nonTargetActiveConfigurationsUnchanged: true,
        autoPublish: publish.autoPublish,
        ...publishResult,
      };
    }
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
      autoPublish: false,
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
  activeConfigChangedKeys,
  appOwnersFrom,
  buildNamespacePaths,
  buildPaths,
  desiredDiffKeys,
  diffKeys,
  fetchJson,
  flagEnabled,
  loadChromium,
  fullNamespaceName,
  makeNamespaceStateToken,
  makeStateToken,
  namespaceCreationPayload,
  namespaceListDiff,
  namespaceNamesFrom,
  namespaceOperation,
  namespacePermissionDetails,
  navtreeEnvs,
  normalizeRoleTypes,
  normalizeEnv,
  normalizeNamespaceFormat,
  parseActive,
  parseArgs,
  parseGrantUsers,
  pendingRoleGrants,
  planChange,
  publishOptions,
  readNamespaceDesired,
  releaseSelectedItem,
  resolveAppId,
  resolveBaseUrl,
  resolveNamespacePublicity,
  resolveAutoGrantUsers,
  resolveSite,
  resolveRuntime,
  roleNamespacePath,
  roleUsersDiff,
  roleUsersSummary,
  runNamespaceCommand,
  summarizeState,
  validateNamespaceComment,
  validateNamespaceName,
};
