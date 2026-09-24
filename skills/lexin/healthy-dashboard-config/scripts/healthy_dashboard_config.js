#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { isDeepStrictEqual } = require('util');
const { parseArgs, resolveBaseUrl, withHealthyClient } = require('./healthy_client');

function usage() {
  console.log(`Usage:
  healthy_dashboard_config.js --board=<id> --env=stable|prod --read
  healthy_dashboard_config.js --board=<id> --configs-file=<path> --expected-sha256=<hash> --apply
  healthy_dashboard_config.js --board=<id> --mode=hawk-read-through --apply
  healthy_dashboard_config.js --board=<id> --verify-page --variables-json='{"env":["pre"],"ip":["all"]}'
Options:
  --configs-json       Full configs object, alternative to --configs-file
  --profile            Persistent browser profile (default browser-profiles/healthy)
  --output-dir         Evidence directory; defaults to a unique directory under /tmp/agent-work/healthy-dashboard (kept 7 days)
  --expected-sha256    Config hash from --read; required for full configs updates
  --verify-page        Capture actual panel queries, dropdown options and screenshot
`);
}

// 备份用于回滚和核对，保留 7 天；集中放一个目录，每次新建时清理过期的，避免在 /tmp 根目录堆积。
const EVIDENCE_ROOT = path.join(os.tmpdir(), 'agent-work', 'healthy-dashboard');
const EVIDENCE_TTL_MS = 7 * 24 * 3600 * 1000;

function newEvidenceDir(board, root = EVIDENCE_ROOT) {
  fs.mkdirSync(root, { recursive: true });
  const cutoff = Date.now() - EVIDENCE_TTL_MS;
  for (const name of fs.readdirSync(root)) {
    const entry = path.join(root, name);
    const info = fs.lstatSync(entry);
    if (info.isDirectory() && info.mtimeMs < cutoff) fs.rmSync(entry, { recursive: true, force: true });
  }
  return fs.mkdtempSync(path.join(root, `${board}-`));
}

function parseBoardConfigs(boardResp) {
  const data = boardResp.json?.dat || boardResp.json?.data || boardResp.json;
  const rawConfigs = data?.configs;
  if (!rawConfigs) {
    throw new Error('响应中没有 configs 字段');
  }
  return {
    board: data,
    configs: typeof rawConfigs === 'string' ? JSON.parse(rawConfigs) : rawConfigs,
  };
}

function panel(id, x, y, name, expr) {
  return {
    type: 'timeseries',
    id,
    layout: { h: 4, w: 12, x, y, i: id, isResizable: true },
    version: '2.0.0',
    datasourceCate: 'prometheus',
    targets: [{ refId: 'A', expr }],
    transformations: [{ id: 'organize', options: {} }],
    name,
    options: {
      tooltip: { mode: 'all', sort: 'none' },
      legend: { displayMode: 'table' },
      standardOptions: {},
      thresholds: { steps: [{ color: '#634CD9', value: null, type: 'base' }] },
    },
    custom: {
      drawStyle: 'lines',
      lineInterpolation: 'smooth',
      spanNulls: false,
      lineWidth: 1,
      fillOpacity: 0.5,
      gradientMode: 'none',
      stack: 'off',
      scaleDistribution: { type: 'linear' },
    },
  };
}

function hawkReadThroughPatch(configs) {
  const next = JSON.parse(JSON.stringify(configs || {}));
  next.version = next.version || '2.0.0';
  const variables = [
    {
      name: 'app',
      label: '',
      type: 'textbox',
      definition: '',
      effect: 'default',
      datasource: { cate: 'prometheus' },
      defaultValue: 'server-hawk-decision-executor-simulate',
    },
    {
      name: 'env',
      label: '',
      type: 'query',
      definition: 'label_values(old_gen_mem_used{app="$app"},env)',
      effect: 'default',
      datasource: { cate: 'prometheus' },
    },
    {
      name: 'ip',
      label: '',
      type: 'query',
      definition: 'label_values(old_gen_mem_used{app="$app",env="$env"},ident)',
      effect: 'default',
      datasource: { cate: 'prometheus' },
      multi: true,
      allOption: true,
      allValue: '.*',
    },
  ];
  const replacingVarNames = new Set(variables.map((item) => item.name));
  const keptVars = Array.isArray(next.var) ? next.var.filter((item) => !replacingVarNames.has(item.name)) : [];
  next.var = keptVars.concat(variables);

  const panels = [
    panel('hawk-read-through-wait-timeout', 0, 0, '穿透加载 waitTimeout 次数',
      'sum by (app,module,method,entry) (fql_fk_hawk_executor_snapshot_read_through_counter{app="$app",env="$env",ident=~"$ip",outcome="failed",failureType="waitTimeout"})'),
    panel('hawk-read-through-failure-type', 12, 0, '穿透加载失败类型分布',
      'sum by (app,module,method,failureType) (fql_fk_hawk_executor_snapshot_read_through_counter{app="$app",env="$env",ident=~"$ip",outcome="failed"})'),
    panel('hawk-online-package-common-failure', 0, 4, '线上 package/commonNode 失败次数',
      'sum by (app,method,failureType) (fql_fk_hawk_executor_snapshot_read_through_counter{app="$app",env="$env",ident=~"$ip",module="online",method=~"package|commonNode",outcome="failed"})'),
    panel('hawk-read-through-action-outcome', 12, 4, '穿透加载动作结果',
      'sum by (app,module,method,action,outcome) (fql_fk_hawk_executor_snapshot_read_through_counter{app="$app",env="$env",ident=~"$ip"})'),
    panel('hawk-read-through-total-cost', 0, 8, '读穿 reload 总耗时',
      'avg by (app,module,method,action,outcome) (fql_fk_hawk_executor_snapshot_read_through_average{app="$app",env="$env",ident=~"$ip",stage="total"})'),
    panel('hawk-runtime-snapshot-load-cost', 12, 8, '快照加载总耗时(runtime)',
      'avg by (app,method) (fql_fk_hawk_executor_snapshotLoad_average{app="$app",env="$env",ident=~"$ip",module="runtime",stage="total"})'),
  ];

  const replacingNames = new Set(panels.map((item) => item.name));
  const kept = Array.isArray(next.panels) ? next.panels.filter((item) => !replacingNames.has(item.name)) : [];
  next.panels = kept.concat(panels);
  return next;
}

function summarize(configs) {
  return {
    version: configs.version,
    varNames: (configs.var || []).map((item) => item.name),
    panelCount: (configs.panels || []).length,
    panelNames: (configs.panels || []).map((item) => item.name),
  };
}

function configsHash(configs) {
  return createHash('sha256').update(JSON.stringify(configs)).digest('hex');
}

function validateConfigs(configs) {
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
    throw new Error('configs 必须是完整 JSON 对象');
  }
  return configs;
}

// 外部生成的全量配置必须绑定回读版本，避免覆盖其他人的编辑。
async function updateBoard(client, boardUrl, before, desired, expectedHash, saveAfter) {
  validateConfigs(desired);
  if (configsHash(before) !== expectedHash) throw new Error('大盘配置已变化，请重新回读并合并修改');
  if (isDeepStrictEqual(before, desired)) return { changed: false, configs: before };
  const current = parseBoardConfigs(await client.request('GET', boardUrl));
  if (configsHash(current.configs) !== expectedHash) throw new Error('写入前大盘配置已变化，请重新合并');
  await client.request('PUT', `${boardUrl}/configs`, { configs: JSON.stringify(desired) });
  const after = parseBoardConfigs(await client.request('GET', boardUrl));
  saveAfter(after.board);
  if (!isDeepStrictEqual(after.configs, desired)) throw new Error('写入后 configs 回读与目标不一致，请检查备份');
  return { changed: true, configs: after.configs };
}

function dashboardUrl(baseUrl, board, configs, variables) {
  const url = new URL(`/dashboards/${board}`, baseUrl);
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new Error('variables 必须是对象');
  for (const [name, value] of Object.entries(variables)) {
    const definition = (configs.var || []).find(item => item.name === name);
    if (!definition) throw new Error(`大盘不存在变量：${name}`);
    // query 的 defaultValue 无效；URL 的 JSON 值优先于浏览器保存的选择。
    const selected = definition.type === 'query' && !Array.isArray(value) ? [value] : value;
    url.searchParams.set(name, JSON.stringify(selected));
  }
  return url.toString();
}

function queryResponseSummary(url, status, request, body) {
  const queries = request?.queries?.map(item => item.query || item.expr || '') || [];
  const parsed = new URL(url);
  for (const key of ['query', 'match[]']) queries.push(...parsed.searchParams.getAll(key));
  const unresolved = queries.filter(query => /\$(?:[a-zA-Z_]\w*|\{[^}]+\})/.test(query));
  const failed = status < 200 || status >= 300 || !body || Boolean(body.err) || body.status === 'error';
  return { path: parsed.pathname, status, queries, unresolved, failed, body };
}

async function verifyPage(page, baseUrl, board, configs, variables, outputDir) {
  const url = dashboardUrl(baseUrl, board, configs, variables);
  const pending = [];
  const responses = [];
  const failures = [];
  const isQuery = value => {
    const parsed = new URL(value);
    return parsed.origin === baseUrl && parsed.pathname.startsWith('/api/n9e/') && /query|label|series/.test(parsed.pathname);
  };
  const onResponse = response => {
    if (!isQuery(response.url())) return;
    pending.push((async () => {
      let request = null;
      try { request = response.request().postDataJSON(); } catch (_) { /* GET 没有 JSON body。 */ }
      responses.push(queryResponseSummary(response.url(), response.status(), request, await response.json().catch(() => null)));
    })());
  };
  const onFailure = request => { if (isQuery(request.url())) failures.push(new URL(request.url()).pathname); };
  page.on('response', onResponse);
  page.on('requestfailed', onFailure);
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const missingPanels = [];
    for (const panel of configs.panels || []) {
      if (!panel.name) continue;
      const title = page.getByText(panel.name, { exact: true }).first();
      if (!await title.count()) { missingPanels.push(panel.name); continue; }
      await title.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.screenshot({ path: path.join(outputDir, 'dashboard.png'), fullPage: true });
    const options = [];
    const combos = page.getByRole('combobox');
    for (let index = 0; index < await combos.count(); index++) {
      await combos.nth(index).click();
      options.push({ index, options: await page.locator('.ant-select-dropdown:visible').allTextContents() });
      await page.keyboard.press('Escape');
    }
    await Promise.all(pending);
    const selected = await page.evaluate(({ board, names }) => Object.fromEntries(names.map(name =>
      [name, localStorage.getItem(`dashboard_${board}_${name}`)])), { board, names: (configs.var || []).map(item => item.name) });
    const queryCount = responses.reduce((count, item) => count + item.queries.length, 0);
    const result = {
      url, variables, selected, options, missingPanels, failures, queryCount,
      failedResponses: responses.filter(item => item.failed || item.unresolved.length),
      verified: new URL(page.url()).origin === baseUrl && queryCount > 0 && !missingPanels.length && !failures.length
        && responses.every(item => !item.failed && !item.unresolved.length),
      evidence: outputDir,
    };
    fs.writeFileSync(path.join(outputDir, 'page-query-responses.json'), JSON.stringify(responses, null, 2), { flag: 'wx' });
    fs.writeFileSync(path.join(outputDir, 'page-verification.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
    return result;
  } finally {
    page.off('response', onResponse);
    page.off('requestfailed', onFailure);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) return usage();
  if (!/^\d+$/.test(args.board || '') || Number(args.board) <= 0) throw new Error('--board 必须是正整数');
  if (!args.read && !args.apply && !args['verify-page']) throw new Error('必须指定 --read、--apply 或 --verify-page');
  if (args.read && args.apply) throw new Error('--read 不能与 --apply 同时使用');
  if (args['configs-file'] && args['configs-json']) throw new Error('configs-file 与 configs-json 只能选择一个');
  let desired;
  if (args.apply && (args['configs-file'] || args['configs-json'])) {
    desired = validateConfigs(JSON.parse(args['configs-json'] || fs.readFileSync(args['configs-file'], 'utf8')));
    if (!/^[a-f0-9]{64}$/.test(args['expected-sha256'] || '')) throw new Error('全量更新必须提供 --read 返回的 --expected-sha256');
  } else if (args.apply && args.mode !== 'hawk-read-through') {
    throw new Error('请指定 configs-file/configs-json 或 mode=hawk-read-through');
  }
  resolveBaseUrl(args);
  const outputDir = args['output-dir'] || newEvidenceDir(args.board);
  fs.mkdirSync(outputDir, { recursive: true });
  const save = (name, value) => fs.writeFileSync(path.join(outputDir, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  await withHealthyClient(args, async client => {
    const boardUrl = `/api/n9e/board/${args.board}`;
    const before = parseBoardConfigs(await client.request('GET', boardUrl));
    save('before.json', before.board);
    let configs = before.configs;
    let changed = false;
    if (args.apply) {
      const update = await updateBoard(client, boardUrl, before.configs,
        desired || hawkReadThroughPatch(before.configs),
        args['expected-sha256'] || configsHash(before.configs), board => save('after.json', board));
      ({ configs, changed } = update);
    }
    const verification = args['verify-page']
      ? await verifyPage(client.page, client.baseUrl, args.board, configs, JSON.parse(args['variables-json'] || '{}'), outputDir)
      : undefined;
    console.log(JSON.stringify({ board: args.board, baseUrl: client.baseUrl, changed, configsSha256: configsHash(configs),
      backupDir: outputDir, summary: summarize(configs), configs, verification }, null, 2));
    if (verification && !verification.verified) process.exitCode = 1;
  });
}

module.exports = { EVIDENCE_TTL_MS, configsHash, dashboardUrl, hawkReadThroughPatch, newEvidenceDir, queryResponseSummary, updateBoard };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
