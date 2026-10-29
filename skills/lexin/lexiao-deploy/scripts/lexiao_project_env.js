#!/usr/bin/env node
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');
const { launchLockedContext } = require('../../get-browser-session/scripts/browser_session');

const TOOL_DIR = path.join(os.homedir(), 'tools/lexiao-browser');
const DEFAULT_PROFILE = process.env.BROWSER_SESSION_PROFILE
  || process.env.DEVTOOLS_BROWSER_PROFILE
  || path.join(os.homedir(), '.local/state/agent-tools/browser-profiles/main');

/** 统一展开 ~ 并转绝对路径：曾因未展开而落到字面量 "~" 目录，被误报为登录态失效。 */
function resolveProfilePath(value) {
  const raw = String(value || DEFAULT_PROFILE);
  const expanded = raw === '~' ? os.homedir()
      : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2))
      : raw;
  return path.resolve(expanded);
}

/** profile 目录不存在时必须与「未登录」区分开，否则排查方向会被带偏。 */
function profileDir(value) {
  const dir = resolveProfilePath(value);
  if (fs.existsSync(dir)) return dir;
  const candidates = [
    path.join(os.homedir(), '.local/state/agent-tools/browser-profiles/main'),
    path.join(os.homedir(), '.local/state/agent-tools/browser-profiles/webshell'),
    '/home/joney/.local/state/agent-tools/browser-profiles/healthy',
  ].filter((p) => fs.existsSync(p));
  throw new Error(`PROFILE_NOT_FOUND: ${dir} 不存在（这不是登录态失效）。`
    + `可用 profile: ${candidates.length ? candidates.join(', ') : '无'}`);
}

const CHROME_PATH = path.join(TOOL_DIR, 'browsers/chrome-linux64/chrome');
const RUNTIME_LIB_DIR = path.join(TOOL_DIR, 'runtime-libs/usr/lib/x86_64-linux-gnu');
const API_HOST = 'https://lexiao-api.oa.fenqile.com';
const DETAIL_API_PATTERN = /create_publish_order\.json|getPublishDetails\.json|getPublishProgress\.json|get_version_publish_status\.json|version_publish_detail_list\.json/;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq !== -1) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[item.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args[item.slice(2)] = true;
    }
  }
  return args;
}

function requireArg(args, name) {
  if (!args[name]) throw new Error(`missing --${name}`);
  return args[name];
}

async function openContext(profile) {
  // 延迟加载 playwright，单元测试 require 本文件时不依赖浏览器工具目录。
  const { chromium } = createRequire(path.join(TOOL_DIR, 'package.json'))('playwright');
  const ldLibraryPath = [RUNTIME_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return launchLockedContext(chromium, profileDir(profile), {
    executablePath: CHROME_PATH,
    headless: true,
    env: { ...process.env, LD_LIBRARY_PATH: ldLibraryPath },
    args: ['--no-sandbox'],
  });
}

async function gotoPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

/**
 * 在页面里执行（以源码字符串注入）：列出弹窗外各 el-table 主体行的直属单元格与按钮（含右侧固定列同一行的按钮）；
 * 传 click 时点该行指定文字的按钮。只看直属 td，外层容器行和同前缀应用行（process-engine 与 process-engine-ec）不会混进来。
 */
function pageAppRows(op) {
  const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const compact = (text) => norm(text).replace(/\s+/g, '');
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const rowsOf = (wrapper) => (wrapper ? Array.from(wrapper.querySelectorAll(':scope > table > tbody > tr.el-table__row')) : []);
  const rows = [];
  Array.from(document.querySelectorAll('.el-table')).filter((table) => !table.closest('.el-dialog')).forEach((table, t) => {
    const fixed = rowsOf(table.querySelector(':scope > .el-table__fixed-right > .el-table__fixed-body-wrapper'));
    rowsOf(table.querySelector(':scope > .el-table__body-wrapper')).forEach((tr, r) => rows.push({ t, r, tr, fixed: fixed[r] }));
  });
  const buttonsOf = (row) => [row.tr, row.fixed].filter(Boolean)
    .flatMap((el) => Array.from(el.querySelectorAll('button,a,[role="button"]'))).filter(visible);
  const cellsOf = (row) => Array.from(row.tr.querySelectorAll(':scope > td')).map((td) => norm(td.innerText || td.textContent));
  if (op && op.click) {
    const row = rows.find((item) => item.t === op.click.t && item.r === op.click.r);
    if (!row || !cellsOf(row).some((cell) => compact(cell) === compact(op.click.app))) return { clicked: false, reason: 'row-changed' };
    const button = buttonsOf(row).find((item) => compact(item.innerText || item.textContent) === compact(op.click.text));
    if (!button) return { clicked: false, reason: 'button-not-found', rowText: norm(row.tr.innerText) };
    if (button.disabled || button.classList.contains('is-disabled')) {
      return { clicked: false, reason: 'button-disabled', rowText: norm(row.tr.innerText) };
    }
    row.tr.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    return { clicked: true, rowText: norm(row.tr.innerText) };
  }
  return rows.filter((row) => visible(row.tr)).map((row) => {
    const seen = new Set();
    const buttons = buttonsOf(row).map((button) => ({
      text: norm(button.innerText || button.textContent),
      disabled: Boolean(button.disabled || button.classList.contains('is-disabled')),
      loading: button.classList.contains('is-loading') || /loading/i.test(String(button.className || '')),
      className: String(button.className || ''),
      redDot: Array.from((button.closest('.el-badge') || button).querySelectorAll('.el-badge__content,.is-dot'))
        .some((dot) => dot !== button && visible(dot)),
    })).filter((button) => button.text && !seen.has(button.text) && seen.add(button.text));
    return { t: row.t, r: row.r, text: norm(row.tr.innerText || row.tr.textContent), cells: cellsOf(row).filter(Boolean), buttons };
  });
}

/** 唯一一行有单元格与应用名完全相同时返回它，否则返回 row-not-found / row-ambiguous。 */
function pickAppRow(rows, appName) {
  const compact = (text) => String(text || '').replace(/\s+/g, '');
  const hits = rows.filter((row) => row.cells.some((cell) => compact(cell) === compact(appName)));
  if (hits.length === 1) return { row: hits[0] };
  return { error: hits.length ? 'row-ambiguous' : 'row-not-found', count: hits.length };
}

async function findRow(page, appName) {
  return pickAppRow(await page.evaluate(`(${pageAppRows})(null)`), appName);
}

async function readRow(page, appName) {
  return (await findRow(page, appName)).row || null;
}

async function clickRowButton(page, appName, buttonText) {
  const pick = await findRow(page, appName);
  if (!pick.row) return { clicked: false, reason: pick.error, count: pick.count };
  const op = { click: { t: pick.row.t, r: pick.row.r, app: appName, text: buttonText } };
  const result = await page.evaluate(`(${pageAppRows})(${JSON.stringify(op)})`);
  await page.waitForTimeout(1000);
  return result;
}

async function visibleDialogs(page) {
  return page.evaluate(() => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return Array.from(document.querySelectorAll('.el-message-box,.el-dialog,.el-message,.el-notification,[role="dialog"]'))
      .filter(visible)
      .map((el) => ({
        text: norm(el.innerText || el.textContent),
        buttons: Array.from(el.querySelectorAll('button,a,[role="button"]')).filter(visible).map((button) => ({
          text: norm(button.innerText || button.textContent),
          disabled: Boolean(button.disabled || button.classList.contains('is-disabled')),
        })),
      }))
      .filter((item) => item.text);
  });
}

async function clickVisibleButton(page, label) {
  const result = await page.evaluate((label) => {
    const compact = (text) => String(text || '').replace(/\s+/g, '').trim();
    const wanted = compact(label);
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const roots = Array.from(document.querySelectorAll('.el-message-box,.el-dialog,[role="dialog"],body'))
      .filter(visible)
      .sort((a, b) => Number(getComputedStyle(b).zIndex || 0) - Number(getComputedStyle(a).zIndex || 0));
    for (const root of roots) {
      const button = Array.from(root.querySelectorAll('button,a,[role="button"]')).filter(visible)
        .find((item) => compact(item.innerText || item.textContent) === wanted || compact(item.innerText || item.textContent).endsWith(wanted));
      if (!button) continue;
      if (button.disabled || button.classList.contains('is-disabled')) {
        return { clicked: false, reason: 'disabled', text: compact(button.innerText || button.textContent) };
      }
      button.click();
      return {
        clicked: true,
        text: String(button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim(),
        rootText: String(root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1000),
      };
    }
    return { clicked: false, reason: 'not-found' };
  }, label);
  await page.waitForTimeout(1200);
  return result;
}

async function confirmDeploy(page) {
  const deadline = Date.now() + 30000;
  let lastDialogs = [];
  while (Date.now() < deadline) {
    lastDialogs = await visibleDialogs(page);
    const text = lastDialogs.map((item) => item.text).join(' ');
    if (/发布正在执行|部署正在执行|操作成功|发布中|推送中/.test(text)) {
      return { confirmed: true, reason: 'already-running-or-success', dialogs: lastDialogs.slice(0, 2) };
    }
    for (const label of ['确定', '确 定', '确认']) {
      const clicked = await clickVisibleButton(page, label);
      if (clicked.clicked) return { confirmed: true, clicked, dialogs: lastDialogs.slice(0, 2) };
    }
    await page.waitForTimeout(1000);
  }
  return { confirmed: false, reason: 'timeout', dialogs: lastDialogs.slice(0, 2) };
}

function rowSummary(row) {
  if (!row) return null;
  return {
    text: row.text,
    buttons: row.buttons,
  };
}

async function waitDeployDone(page, url, appName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const snapshots = [];
  while (Date.now() < deadline) {
    await gotoPage(page, url);
    const row = await readRow(page, appName);
    snapshots.push({ at: new Date().toISOString(), row: rowSummary(row) });
    if (!row) {
      await page.waitForTimeout(8000);
      continue;
    }
    const deploy = row.buttons.find((button) => button.text === '部署');
    const text = row.text;
    if (/发布失败|部署失败|回滚|异常/.test(text)) {
      return { outcome: 'failed', row, snapshots: snapshots.slice(-12) };
    }
    if (/已发布/.test(text) && deploy && deploy.disabled && !/发布中|部署中|制作中|执行中/.test(text)) {
      return { outcome: 'success', row, snapshots: snapshots.slice(-12) };
    }
    await page.waitForTimeout(8000);
  }
  return { outcome: 'timeout', row: await readRow(page, appName), snapshots: snapshots.slice(-12) };
}


// ---- 「部署详情」弹窗（2026-10 乐效改版：项目环境行不再出现「部署」，入口在弹窗集群行的「发布」） ----

const PUBLISH_FAILED = /失败|已回滚|回滚中/;
const BUILDING = /执行中|制作中|构建中|排队中/;

function queryOf(url) {
  try { return new URL(url).searchParams; } catch (_) { return new URLSearchParams(); }
}

/** 从打开弹窗时页面发出的接口响应中取发布单号、需求 ID 和应用行发布状态。 */
function summarizeResponses(responses, appName) {
  let createdOrderId = null;
  let detailsOrderId = null;
  let demandId = null;
  let rowStatus = null;
  for (const item of responses) {
    const query = queryOf(item.url);
    demandId = demandId || query.get('demand_id') || query.get('demandId') || null;
    const rows = item.json?.result_rows || [];
    if (item.url.includes('create_publish_order.json') && rows[0]?.order_id) createdOrderId = Number(rows[0].order_id);
    if (item.url.includes('getPublishDetails.json') && query.get('order_id')) detailsOrderId = Number(query.get('order_id'));
    if (item.url.includes('get_version_publish_status.json')) {
      const row = rows.find((r) => r.app_name === appName);
      if (row) {
        rowStatus = {
          publish_order_id: row.publish_order_id,
          version_publish_detail_id: row.version_publish_detail_id,
          version_tag: row.version_tag,
          publish_status: row.publish_status,
          publish_status_desc: row.publish_status_desc,
          need_show_deploy_red_dot: row.need_show_deploy_red_dot,
          need_show_build_red_dot: row.need_show_build_red_dot,
        };
      }
    }
  }
  return {
    order_id: createdOrderId || detailsOrderId || rowStatus?.publish_order_id || null,
    created_order_id: createdOrderId,
    details_order_id: detailsOrderId,
    demand_id: demandId,
    row_publish_status: rowStatus,
  };
}

/** 把弹窗里按表头抽出的表格转成集群行与 Pod 行。 */
function parseDetailDialog(dialog) {
  if (!dialog) return null;
  const text = dialog.text || '';
  const counter = (label) => {
    const match = text.match(new RegExp(`${label}[:：]\\s*\\((\\d+)\\s*/\\s*(\\d+)\\)`));
    return match ? { done: Number(match[1]), total: Number(match[2]) } : null;
  };
  const pick = (headers, cells, name) => {
    const index = headers.indexOf(name);
    return index === -1 ? '' : (cells[index] || '');
  };
  const clusters = [];
  const pods = [];
  for (const table of dialog.tables || []) {
    const headers = table.headers || [];
    if (headers.includes('发布状态') && headers.includes('集群')) {
      for (const row of table.rows || []) {
        clusters.push({
          status: pick(headers, row.cells, '发布状态'),
          app: pick(headers, row.cells, '应用名'),
          set: pick(headers, row.cells, '集群set'),
          cluster: pick(headers, row.cells, '集群'),
          room: pick(headers, row.cells, '逻辑机房'),
          replicas: pick(headers, row.cells, '副本数'),
          progress: pick(headers, row.cells, '实例发布进度'),
          publish_time: pick(headers, row.cells, '发布时间'),
          buttons: row.buttons || [],
        });
      }
    } else if (headers.includes('实例名称')) {
      for (const row of table.rows || []) {
        const name = pick(headers, row.cells, '实例名称');
        if (!name || pods.some((pod) => pod.name === name)) continue;
        pods.push({
          name,
          ip: pick(headers, row.cells, '容器ip'),
          version: pick(headers, row.cells, '版本号'),
          state: pick(headers, row.cells, '运行状态'),
          age: pick(headers, row.cells, '存活周期'),
        });
      }
    }
  }
  const version = text.match(/项目环境\s+(\S+)/);
  return {
    version_tag: version ? version[1] : null,
    published: counter('已发布机器数'),
    rolled_back: counter('已回滚机器数'),
    clusters,
    pods,
    deployable: clusters.some((c) => c.status === '待发布'),
  };
}

/** 选出唯一一个待发布集群行；多个且未指定 --cluster 时不猜。 */
function pickPublishCluster(clusters, filter) {
  let pending = (clusters || []).filter((c) => c.status === '待发布');
  if (filter) {
    pending = pending.filter((c) => c.cluster === filter || c.set === filter);
    if (!pending.length) return { error: 'cluster-not-found', filter, clusters };
  }
  if (!pending.length) return { error: 'no-pending-cluster', clusters };
  if (pending.length > 1) return { error: 'cluster-ambiguous', candidates: pending.map((c) => ({ set: c.set, cluster: c.cluster })) };
  const target = pending[0];
  const button = target.buttons.find((b) => b.text === '发布');
  if (!button || button.disabled) return { error: 'publish-button-unavailable', target };
  return { target };
}

/** 点「发布」后若弹确认框：只确认明确的发布/部署，回滚、灰度、批量一律不点。 */
function classifyConfirm(text) {
  if (/回滚|灰度|批量|删除|下线|停止/.test(text || '')) return 'reject';
  if (/发布|部署/.test(text || '')) return 'confirm';
  return 'unknown';
}

/** 按 getPublishDetails / getPublishProgress 判定目标集群的发布结果。Pod 刚起时短暂 FAILED 不算失败。 */
function classifyPublishProgress(detailsRoot, progressRoot, target) {
  const list = detailsRoot?.deployment_order_detail_list || [];
  const detail = list.find((d) => d.cluster_id === target.cluster && (!target.set || d.set === target.set))
    || (list.length === 1 ? list[0] : null);
  if (!detail) return { state: 'running', reason: 'cluster-detail-not-found' };
  const progress = (progressRoot?.progress_list || []).find((p) => p.order_detail_id === detail.order_detail_id)
    || (progressRoot?.progress_list || [])[0] || {};
  const published = Number(progressRoot?.published_num ?? NaN);
  const total = Number(progressRoot?.total_replicas ?? NaN);
  const summary = {
    version_tag: detail.version_tag,
    order_detail_id: detail.order_detail_id,
    deployment_id: detail.deployment_id,
    namespace: detail.namespace,
    publish_status: detail.publish_status,
    publish_status_desc: detail.publish_status_desc,
    publish_msg: detail.publish_msg,
    publish_time: detail.publish_time,
    published_num: Number.isNaN(published) ? null : published,
    total_replicas: Number.isNaN(total) ? null : total,
    pods: (progress.pod_info_list || []).map((pod) => ({
      name: pod.pod_name,
      ip: pod.pod_ip,
      version: pod.version,
      state: pod.pod_status,
      restart_count: pod.restart_count,
      age: pod.survival_time,
      image: pod.image,
      login_pod_addr: pod.login_pod_addr,
    })),
  };
  const statusText = `${detail.publish_status_desc || ''} ${detail.publish_msg || ''} ${progress.summary_status_desc || ''}`;
  if (PUBLISH_FAILED.test(statusText) || /FAIL/i.test(String(detail.publish_status || ''))) return { state: 'failed', ...summary };
  if (detail.publish_status_desc === '已发布' && total > 0 && published === total) return { state: 'success', ...summary };
  return { state: 'running', ...summary };
}

function detailsUrl(orderId, demandId) {
  const demand = demandId ? `&demand_id=${encodeURIComponent(demandId)}` : '';
  return `${API_HOST}/oa/publish/devops/deploymentOrder/getPublishDetails.json?version_id=0&order_id=${orderId}&env=prj&app_type=java${demand}`;
}

function progressUrl(orderId) {
  return `${API_HOST}/oa/publish/devops/deploymentOrder/getPublishProgress.json?order_id=${orderId}&env=prj`;
}

async function fetchJson(page, url) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'include' });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: response.status, json, text: json ? undefined : text.slice(0, 1000) };
  }, url);
}

async function readPublishApi(page, orderId, demandId) {
  const [details, progress] = await Promise.all([
    fetchJson(page, detailsUrl(orderId, demandId)),
    fetchJson(page, progressUrl(orderId)),
  ]);
  return {
    details_status: details.status,
    details_retcode: details.json?.retcode,
    progress_status: progress.status,
    progress_retcode: progress.json?.retcode,
    detailsRoot: details.json?.result_rows?.[0] || null,
    progressRoot: progress.json?.result_rows?.[0] || null,
  };
}

function collectResponses(page) {
  const responses = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!DETAIL_API_PATTERN.test(url)) return;
    let json = null;
    try { json = JSON.parse(await response.text()); } catch (_) {}
    responses.push({ url, status: response.status(), json });
  });
  return responses;
}

async function waitRow(page, appName, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await readRow(page, appName);
    if (row || Date.now() >= deadline) return row;
    await page.waitForTimeout(1000);
  }
}

async function extractDialog(page, appName) {
  return page.evaluate((appName) => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const dialog = Array.from(document.querySelectorAll('.el-dialog')).filter(visible)
      .find((el) => norm(el.innerText).includes(appName) && /发布进度|集群/.test(el.innerText || ''));
    if (!dialog) return null;
    const buttonsOf = (root) => Array.from(root.querySelectorAll('button')).filter(visible).map((button) => ({
      text: norm(button.innerText || button.textContent),
      disabled: Boolean(button.disabled || button.classList.contains('is-disabled')),
    }));
    // 只取本表直属的表头和行，嵌套的 Pod 表与右侧固定列各自单独处理。
    const tables = Array.from(dialog.querySelectorAll('.el-table')).map((table) => {
      const headers = Array.from(table.querySelectorAll(':scope > .el-table__header-wrapper th')).map((th) => norm(th.innerText));
      const bodyRows = (wrapper) => (wrapper ? Array.from(wrapper.querySelectorAll(':scope > table > tbody > tr.el-table__row')) : []);
      const fixedRows = bodyRows(table.querySelector(':scope > .el-table__fixed-right > .el-table__fixed-body-wrapper'));
      const rows = bodyRows(table.querySelector(':scope > .el-table__body-wrapper')).map((tr, index) => ({
        cells: Array.from(tr.querySelectorAll(':scope > td')).map((td) => norm(td.innerText)),
        buttons: [...buttonsOf(tr), ...(fixedRows[index] ? buttonsOf(fixedRows[index]) : [])],
      }));
      return { headers, rows };
    });
    return { text: norm(dialog.innerText).slice(0, 4000), tables };
  }, appName);
}

async function openDetailDialog(page, appName, responses) {
  responses.length = 0;
  const click = await clickRowButton(page, appName, '部署详情');
  if (!click.clicked) return { click };
  const deadline = Date.now() + 30000;
  let parsed = null;
  while (Date.now() < deadline) {
    parsed = parseDetailDialog(await extractDialog(page, appName));
    const got = (name) => responses.some((item) => item.url.includes(name));
    // Pod 表和「已发布机器数」由 getPublishProgress 填充，晚于集群行出现。
    if (parsed && parsed.clusters.length && got('getPublishDetails.json') && got('getPublishProgress.json')) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(2000);
  parsed = parseDetailDialog(await extractDialog(page, appName)) || parsed;
  return { click, dialog: parsed, order: summarizeResponses(responses, appName) };
}

async function clickClusterPublish(page, appName, target) {
  const result = await page.evaluate(({ appName, target }) => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const compact = (text) => norm(text).replace(/\s+/g, '');
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const dialog = Array.from(document.querySelectorAll('.el-dialog')).filter(visible)
      .find((el) => norm(el.innerText).includes(appName) && /发布进度|集群/.test(el.innerText || ''));
    if (!dialog) return { clicked: false, reason: 'dialog-not-found' };
    for (const table of dialog.querySelectorAll('.el-table')) {
      const headers = Array.from(table.querySelectorAll(':scope > .el-table__header-wrapper th')).map((th) => norm(th.innerText));
      const statusIndex = headers.indexOf('发布状态');
      const clusterIndex = headers.indexOf('集群');
      const setIndex = headers.indexOf('集群set');
      if (statusIndex === -1 || clusterIndex === -1) continue;
      const rowsOf = (wrapper) => (wrapper ? Array.from(wrapper.querySelectorAll(':scope > table > tbody > tr.el-table__row')) : []);
      const fixedRows = rowsOf(table.querySelector(':scope > .el-table__fixed-right > .el-table__fixed-body-wrapper'));
      const rows = rowsOf(table.querySelector(':scope > .el-table__body-wrapper'));
      for (let i = 0; i < rows.length; i += 1) {
        const cells = Array.from(rows[i].querySelectorAll(':scope > td')).map((td) => norm(td.innerText));
        if (cells[clusterIndex] !== target.cluster || (setIndex !== -1 && target.set && cells[setIndex] !== target.set)) continue;
        if (cells[statusIndex] !== '待发布') return { clicked: false, reason: 'cluster-not-pending', cells };
        const button = [rows[i], fixedRows[i]].filter(Boolean)
          .flatMap((tr) => Array.from(tr.querySelectorAll('button')))
          .filter(visible)
          .find((item) => compact(item.innerText || item.textContent) === '发布');
        if (!button) return { clicked: false, reason: 'publish-button-not-found', cells };
        if (button.disabled || button.classList.contains('is-disabled')) return { clicked: false, reason: 'publish-button-disabled', cells };
        button.scrollIntoView({ block: 'center', inline: 'center' });
        button.click();
        return { clicked: true, cells };
      }
    }
    return { clicked: false, reason: 'cluster-row-not-found' };
  }, { appName, target: { cluster: target.cluster, set: target.set } });
  await page.waitForTimeout(1500);
  return result;
}

/** 读取「部署详情」弹窗以外新出现的确认框（message-box 或另一个 el-dialog）。 */
async function readConfirmBoxes(page) {
  return page.evaluate(() => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return Array.from(document.querySelectorAll('.el-message-box,.el-dialog')).filter(visible)
      .filter((el) => !/容器化发布进度|已发布机器数/.test(el.innerText || ''))
      .map((el, index) => ({
        index,
        text: norm(el.innerText).slice(0, 500),
        buttons: Array.from(el.querySelectorAll('button')).filter(visible).map((b) => norm(b.innerText)),
      }));
  });
}

async function clickConfirmBox(page, index) {
  return page.evaluate((index) => {
    const norm = (text) => String(text || '').replace(/\s+/g, '').trim();
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const box = Array.from(document.querySelectorAll('.el-message-box,.el-dialog')).filter(visible)
      .filter((el) => !/容器化发布进度|已发布机器数/.test(el.innerText || ''))[index];
    const button = box && Array.from(box.querySelectorAll('button')).filter(visible)
      .find((b) => ['确定', '确认'].includes(norm(b.innerText)));
    if (!button) return { clicked: false, reason: 'confirm-button-not-found' };
    button.click();
    return { clicked: true, text: norm(button.innerText) };
  }, index);
}

async function confirmPublishIfAsked(page, waitMs = 6000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const boxes = await readConfirmBoxes(page);
    const box = boxes.find((item) => item.buttons.some((b) => /^确\s*[定认]$/.test(b)));
    if (box) {
      const verdict = classifyConfirm(box.text);
      if (verdict !== 'confirm') return { confirmed: false, reason: `unexpected-dialog-${verdict}`, dialog: box };
      const clicked = await clickConfirmBox(page, box.index);
      await page.waitForTimeout(1500);
      return { confirmed: clicked.clicked, clicked, dialog: box };
    }
    await page.waitForTimeout(1000);
  }
  return { confirmed: true, reason: 'no-confirm-dialog' };
}

async function waitPublishDone(page, orderId, demandId, target, timeoutMs, pollMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  const snapshots = [];
  let last = null;
  while (Date.now() < deadline) {
    const api = await readPublishApi(page, orderId, demandId);
    last = classifyPublishProgress(api.detailsRoot, api.progressRoot, target);
    snapshots.push({
      at: new Date().toISOString(),
      state: last.state,
      publish_status: last.publish_status,
      publish_status_desc: last.publish_status_desc,
      published: `${last.published_num}/${last.total_replicas}`,
      pods: (last.pods || []).map((pod) => `${pod.name} ${pod.version} ${pod.state}`),
      retcode: [api.details_retcode, api.progress_retcode],
    });
    if (last.state !== 'running') return { outcome: last.state, result: last, snapshots: snapshots.slice(-12) };
    await page.waitForTimeout(pollMs);
  }
  return { outcome: 'timeout', result: last, snapshots: snapshots.slice(-12) };
}

async function readStatus(page, appName, responses) {
  const row = await waitRow(page, appName);
  if (!row) return { row: null, reason: 'row-not-found' };
  const opened = await openDetailDialog(page, appName, responses);
  const status = { row, detail_click: opened.click, dialog: opened.dialog || null, publish_order: opened.order || null };
  const orderId = opened.order?.order_id;
  if (orderId) {
    const api = await readPublishApi(page, orderId, opened.order.demand_id);
    status.api = {
      version_tag: api.detailsRoot?.version_tag,
      clusters: (api.detailsRoot?.deployment_order_detail_list || []).map((d) => ({
        set: d.set, cluster_id: d.cluster_id, order_detail_id: d.order_detail_id, deployment_id: d.deployment_id,
        namespace: d.namespace, version_tag: d.version_tag, publish_status: d.publish_status,
        publish_status_desc: d.publish_status_desc, publish_time: d.publish_time,
      })),
      published_num: api.progressRoot?.published_num,
      total_replicas: api.progressRoot?.total_replicas,
      pods: (api.progressRoot?.progress_list || []).flatMap((p) => p.pod_info_list || []).map((pod) => ({
        name: pod.pod_name, ip: pod.pod_ip, version: pod.version, state: pod.pod_status,
        restart_count: pod.restart_count, age: pod.survival_time,
      })),
    };
  }
  status.deployable = Boolean(opened.dialog?.deployable);
  return status;
}

async function waitReadyForDeploy(page, url, appName, responses, timeoutMs, clusterFilter) {
  const deadline = Date.now() + timeoutMs;
  const snapshots = [];
  while (Date.now() < deadline) {
    await gotoPage(page, url);
    const row = await waitRow(page, appName);
    const snap = { at: new Date().toISOString(), row: rowSummary(row) };
    snapshots.push(snap);
    if (!row) {
      await page.waitForTimeout(10000);
      continue;
    }
    const deploy = row.buttons.find((button) => button.text === '部署');
    const text = row.text;
    if (/失败|异常|制作失败|执行失败|发布失败/.test(text)) {
      return { outcome: 'failed', row, snapshots: snapshots.slice(-12) };
    }
    if (deploy && !deploy.disabled) {
      return { outcome: 'ready', mode: 'row-deploy', row, snapshots: snapshots.slice(-12) };
    }
    if (BUILDING.test(text)) {
      await page.waitForTimeout(10000);
      continue;
    }
    const opened = await openDetailDialog(page, appName, responses);
    snap.dialog = opened.dialog ? { version_tag: opened.dialog.version_tag, published: opened.dialog.published,
      clusters: opened.dialog.clusters.map((c) => `${c.set} ${c.cluster} ${c.status}`) } : null;
    if (opened.click.clicked && opened.dialog) {
      const pick = pickPublishCluster(opened.dialog.clusters, clusterFilter);
      if (pick.target) {
        return { outcome: 'ready', mode: 'dialog-publish', row, target: pick.target, dialog: opened.dialog,
          order: opened.order, snapshots: snapshots.slice(-12) };
      }
      if (pick.error !== 'no-pending-cluster') {
        return { outcome: pick.error, row, pick, dialog: opened.dialog, snapshots: snapshots.slice(-12) };
      }
      if (/执行成功/.test(text) && /制作成功/.test(text)) {
        return { outcome: 'no-deployable-artifact', row, dialog: opened.dialog, order: opened.order, snapshots: snapshots.slice(-12) };
      }
    }
    await page.waitForTimeout(10000);
  }
  return { outcome: 'timeout', row: await readRow(page, appName), snapshots: snapshots.slice(-12) };
}

async function deployLegacy(page, url, appName, ready, args) {
  const deployClick = await clickRowButton(page, appName, '部署');
  const confirm = deployClick.clicked ? await confirmDeploy(page) : null;
  const done = deployClick.clicked ? await waitDeployDone(page, url, appName, Number(args['deploy-timeout'] || 900000)) : null;
  return { ok: Boolean(deployClick.clicked && done && done.outcome === 'success'), report: { ready, deployClick, confirm, done } };
}

async function deployFromDialog(page, appName, ready, args) {
  const orderId = ready.order?.order_id;
  if (!orderId) return { ok: false, report: { ready, publishClick: null, reason: 'order-id-missing' } };
  const publishClick = await clickClusterPublish(page, appName, ready.target);
  if (!publishClick.clicked) return { ok: false, report: { ready, publishClick } };
  const confirm = await confirmPublishIfAsked(page);
  if (!confirm.confirmed) return { ok: false, report: { ready, publishClick, confirm } };
  const done = await waitPublishDone(page, orderId, ready.order.demand_id, ready.target,
    Number(args['deploy-timeout'] || 900000), Number(args['poll-ms'] || 10000));
  return { ok: done.outcome === 'success', report: { ready, publishClick, confirm, done } };
}

// ---- 项目环境「构建」：推送会自动构建；依赖 jar 重新上传到 Nexus 而代码没推送时才需要手动点 ----

const PIPELINE_API_PATTERN = /ci_pipeline_status_batch\.json/;

/** 应用行里「<分支> 研发: <账号>」单元格的分支名。 */
function branchOfRow(row) {
  for (const cell of (row && row.cells) || []) {
    const match = /^(\S+)\s+研发[:：]/.exec(cell);
    if (match) return match[1];
  }
  return '';
}

/**
 * 从 ci_pipeline_status_batch 的 result_rows 取本应用的流水线：按 pipeline_job_url 的任务名
 * feature-pipeline-<应用名>-<分支> 精确匹配（结果行没有应用名字段；process-engine 与 process-engine-ec 共前缀，不能只比前缀）。
 */
function pickPipeline(resultRows, appName, branch, env = 'prj') {
  const job = `feature-pipeline-${appName}-${branch}`;
  for (const item of resultRows || []) {
    const match = /\/job\/([^/]+)\/(\d+)\/?$/.exec(String(item.pipeline_job_url || ''));
    if (!match || decodeURIComponent(match[1]) !== job) continue;
    const artifact = (item.artifact_status_list || []).find((a) => a.env === env) || null;
    return {
      job_url: item.pipeline_job_url, build_no: Number(match[2]),
      pipeline_status_desc: item.pipeline_status_desc, artifact_status_desc: artifact ? artifact.artifact_status_desc : null,
    };
  }
  return null;
}

/** 构建确认框只接受「是否进行构建」这类，出现回滚、灰度、批量、线上字样一律拒绝。 */
function classifyBuildConfirm(text) {
  const value = String(text || '');
  if (/回滚|灰度|批量|线上/.test(value)) return 'reject';
  return /构建/.test(value) ? 'confirm' : 'unknown';
}

function classifyBuild(before, now) {
  if (!now) return 'unknown';
  if (!before || now.build_no <= before.build_no) return 'not-started';
  if (/失败|异常|中止/.test(`${now.pipeline_status_desc} ${now.artifact_status_desc}`)) return 'failed';
  if (now.pipeline_status_desc === '执行成功' && now.artifact_status_desc === '制作成功') return 'success';
  return 'running';
}

async function loadPipeline(page, url, appName) {
  const captured = [];
  const listener = async (response) => {
    if (!PIPELINE_API_PATTERN.test(response.url())) return;
    try { captured.push(JSON.parse(await response.text())); } catch (_) {}
  };
  page.on('response', listener);
  try {
    await gotoPage(page, url);
    const row = await waitRow(page, appName);
    const deadline = Date.now() + 15000;
    while (!captured.length && Date.now() < deadline) await page.waitForTimeout(500);
    const branch = branchOfRow(row);
    const last = captured[captured.length - 1];
    return { row, branch, pipeline: last ? pickPipeline(last.result_rows, appName, branch) : null };
  } finally {
    page.off('response', listener);
  }
}

async function confirmBuild(page, waitMs = 10000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const boxes = await readConfirmBoxes(page);
    const box = boxes.find((item) => item.buttons.some((b) => /^确\s*[定认]$/.test(b)));
    if (box) {
      const verdict = classifyBuildConfirm(box.text);
      if (verdict !== 'confirm') return { confirmed: false, reason: `unexpected-dialog-${verdict}`, dialog: box };
      const clicked = await clickConfirmBox(page, box.index);
      return { confirmed: clicked.clicked, clicked, dialog: box };
    }
    await page.waitForTimeout(500);
  }
  return { confirmed: false, reason: 'no-confirm-dialog' };
}

async function buildApp(page, url, appName, args) {
  const start = await loadPipeline(page, url, appName);
  if (!start.row) return { ok: false, report: { outcome: 'row-not-found' } };
  if (!start.pipeline) return { ok: false, report: { outcome: 'pipeline-not-found', branch: start.branch, row: rowSummary(start.row) } };
  if (BUILDING.test(start.row.text)) return { ok: false, report: { outcome: 'already-building', before: start.pipeline, row: rowSummary(start.row) } };
  const click = await clickRowButton(page, appName, '构建');
  if (!click.clicked) return { ok: false, report: { outcome: 'click-failed', click, before: start.pipeline } };
  const confirm = await confirmBuild(page);
  if (!confirm.confirmed) return { ok: false, report: { outcome: 'not-confirmed', click, confirm, before: start.pipeline } };
  const timeoutMs = Number(args['build-timeout'] || 1200000);
  const pollMs = Number(args['poll-ms'] || 30000);
  const startWaitMs = Number(args['start-timeout'] || 180000);
  const begin = Date.now();
  const snapshots = [];
  let state = 'not-started';
  let now = null;
  while (Date.now() - begin < timeoutMs) {
    await page.waitForTimeout(pollMs);
    now = (await loadPipeline(page, url, appName)).pipeline;
    state = classifyBuild(start.pipeline, now);
    snapshots.push({ at: new Date().toISOString(), state, ...(now || {}) });
    if (state === 'success' || state === 'failed') break;
    if (state === 'not-started' && Date.now() - begin > startWaitMs) { state = 'not-triggered'; break; }
  }
  if (!['success', 'failed', 'not-triggered'].includes(state)) state = 'timeout';
  return { ok: state === 'success', report: { outcome: state, click, confirm, before: start.pipeline, after: now, snapshots: snapshots.slice(-12) } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args.action || 'status';
  const url = requireArg(args, 'url');
  const appName = requireArg(args, 'app');
  if (!['status', 'deploy', 'build'].includes(action)) throw new Error(`unknown action: ${action}`);
  const context = await openContext(args.profile || DEFAULT_PROFILE);
  try {
    const page = context.pages()[0] || await context.newPage();
    const responses = collectResponses(page);
    await gotoPage(page, url);
    if (action === 'status') {
      const status = await readStatus(page, appName, responses);
      console.log(JSON.stringify({ action, ...status, dialogs: await visibleDialogs(page) }, null, 2));
      if (!status.row) process.exitCode = 1;
      return;
    }

    if (action === 'build') {
      const result = await buildApp(page, url, appName, args);
      console.log(JSON.stringify({ action, ...result.report }, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }

    const clusterFilter = typeof args.cluster === 'string' ? args.cluster : '';
    const ready = await waitReadyForDeploy(page, url, appName, responses, Number(args['build-timeout'] || 900000), clusterFilter);
    if (ready.outcome !== 'ready') {
      console.log(JSON.stringify({ action, ready }, null, 2));
      process.exitCode = ready.outcome === 'no-deployable-artifact' ? 2 : 1;
      return;
    }
    const result = ready.mode === 'row-deploy'
      ? await deployLegacy(page, url, appName, ready, args)
      : await deployFromDialog(page, appName, ready, args);
    console.log(JSON.stringify({ action, mode: ready.mode, ...result.report }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  pickAppRow, branchOfRow, pickPipeline, classifyBuildConfirm, classifyBuild,
  parseArgs, summarizeResponses, parseDetailDialog, pickPublishCluster, classifyConfirm, classifyPublishProgress,
  detailsUrl, progressUrl, readRow, extractDialog, clickClusterPublish, confirmPublishIfAsked,
};
