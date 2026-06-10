#!/usr/bin/env node
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const TOOL_DIR = path.join(os.homedir(), 'tools/lexiao-browser');
const DEFAULT_PROFILE = path.join(os.homedir(), '.cache/lexiao-browser-profile');
const CHROME_PATH = path.join(TOOL_DIR, 'browsers/chrome-linux64/chrome');
const RUNTIME_LIB_DIR = path.join(TOOL_DIR, 'runtime-libs/usr/lib/x86_64-linux-gnu');
const chromium = createRequire(path.join(TOOL_DIR, 'package.json'))('playwright').chromium;

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

function versionIdFromUrl(url) {
  const match = String(url || '').match(/app-publish\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function normText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function compactText(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

function parseCsv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function maybeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeAppName(value) {
  return String(value || '').toLowerCase().replace(/[-_]/g, '');
}

function pipelineMatchesApp(pipeline, appName) {
  if (!pipeline || !appName) return false;
  const wanted = normalizeAppName(appName);
  if (normalizeAppName(pipeline.app_name) === wanted) return true;
  if (normalizeAppName(pipeline.project_name) === wanted) return true;
  const jobUrl = String(pipeline.pipeline_job_url || '');
  const match = jobUrl.match(/job\/integration-pipeline-([^/]+?)-rel[_-]/i);
  if (match && normalizeAppName(match[1]) === wanted) return true;
  return normalizeAppName(jobUrl).includes(wanted);
}

async function openContext(args) {
  const ldLibraryPath = [RUNTIME_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return chromium.launchPersistentContext(args.profile || DEFAULT_PROFILE, {
    executablePath: args.chrome || CHROME_PATH,
    headless: !args.headed,
    env: { ...process.env, LD_LIBRARY_PATH: ldLibraryPath },
    args: ['--no-sandbox'],
  });
}

async function fetchJson(page, url, options = {}) {
  return page.evaluate(async ({ url, options }) => {
    const response = await fetch(url, { credentials: 'include', ...options });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: response.status, json, text: json ? undefined : text.slice(0, 1000) };
  }, { url, options });
}

function envLabel(env) {
  return {
    pre: '预发布',
    gray: '灰度',
    oa: 'OA',
    prod: '线上',
    online: '线上',
  }[env] || env;
}

async function selectEnvTab(page, env) {
  const label = envLabel(env);
  const result = await page.evaluate((label) => {
    const norm = (text) => String(text || '').replace(/\s+/g, '').trim();
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('[role="tab"],.el-tabs__item,button,a,[role="button"]'))
      .filter(visible)
      .map((el) => ({ el, text: norm(el.innerText || el.textContent), className: String(el.className || '') }))
      .filter((item) => item.text === norm(label))
      .sort((a, b) => {
        const aTab = /tab|tabs/.test(a.className) || a.el.getAttribute('role') === 'tab';
        const bTab = /tab|tabs/.test(b.className) || b.el.getAttribute('role') === 'tab';
        if (aTab !== bTab) return aTab ? -1 : 1;
        return a.text.length - b.text.length;
      });
    const target = candidates[0]?.el;
    if (!target) return { clicked: false, reason: 'not-found', label };
    const beforeClass = String(target.className || '');
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return { clicked: true, label, beforeClass };
  }, label);
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1000);
  return result;
}

async function gotoLexiao(page, url, env = 'pre') {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const envClick = await selectEnvTab(page, env);
  return { envClick };
}

async function visibleDialogs(page) {
  return page.evaluate(() => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return Array.from(document.querySelectorAll('.el-message-box,.el-dialog,.el-drawer,[role="dialog"],.el-message,.el-notification'))
      .filter(visible)
      .map((el) => ({
        text: norm(el.innerText || el.textContent),
        buttons: Array.from(el.querySelectorAll('button,a,[role="button"]')).filter(visible).map((button) => ({
          text: norm(button.innerText || button.textContent),
          disabled: !!(button.disabled || button.classList.contains('is-disabled')),
        })),
      }))
      .filter((item) => item.text);
  });
}

async function clickVisibleButton(page, label) {
  const result = await page.evaluate((label) => {
    const wanted = String(label || '').replace(/\s+/g, '').trim();
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const roots = Array.from(document.querySelectorAll('.el-message-box,.el-dialog,.el-drawer,body'))
      .filter(visible)
      .sort((a, b) => Number(getComputedStyle(b).zIndex || 0) - Number(getComputedStyle(a).zIndex || 0));
    for (const root of roots) {
      const button = Array.from(root.querySelectorAll('button,a,[role="button"]')).filter(visible)
        .find((item) => String(item.innerText || item.textContent || '').replace(/\s+/g, '').trim() === wanted);
      if (!button) continue;
      if (button.disabled || button.classList.contains('is-disabled')) {
        return { clicked: false, reason: 'disabled', text: wanted };
      }
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return {
        clicked: true,
        text: String(button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim(),
        rootText: String(root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
      };
    }
    return { clicked: false, reason: 'not-found', text: wanted };
  }, label);
  await page.waitForTimeout(1200);
  return result;
}

async function clickRowButton(page, rowNeedle, buttonText) {
  const result = await page.evaluate(({ rowNeedle, buttonText }) => {
    const norm = (text) => String(text || '').replace(/\s+/g, '').trim();
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const rows = Array.from(document.querySelectorAll('tr,.el-table__row,[class*="row"]'))
      .filter(visible)
      .filter((el) => norm(el.innerText || el.textContent).includes(norm(rowNeedle)))
      .sort((a, b) => norm(a.innerText || a.textContent).length - norm(b.innerText || b.textContent).length);
    const row = rows[0];
    if (!row) return { clicked: false, reason: 'row-not-found', rowNeedle };
    const rowText = String(row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
    const button = Array.from(row.querySelectorAll('button,a,[role="button"]')).filter(visible)
      .find((item) => norm(item.innerText || item.textContent) === norm(buttonText));
    if (!button) return { clicked: false, reason: 'button-not-found', rowText };
    if (button.disabled || button.classList.contains('is-disabled')) return { clicked: false, reason: 'button-disabled', rowText };
    row.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    return { clicked: true, rowText };
  }, { rowNeedle, buttonText });
  await page.waitForTimeout(1500);
  return result;
}

async function confirmIfNeeded(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await visibleDialogs(page);
    const text = last.map((item) => item.text).join(' ');
    if (/发布正在执行|部署正在执行|操作成功|发布成功|推送中|发布中/.test(text)) {
      return { confirmed: true, reason: 'already-running-or-success', dialogs: last.slice(0, 2) };
    }
    for (const label of ['确定', '确认']) {
      const clicked = await clickVisibleButton(page, label);
      if (clicked.clicked) return { confirmed: true, clicked, dialogs: last.slice(0, 2) };
    }
    await page.waitForTimeout(1000);
  }
  return { confirmed: false, reason: 'timeout', dialogs: last.slice(0, 2) };
}

async function listApps(page, url, versionId, env) {
  await gotoLexiao(page, url, env);
  const domRows = await page.evaluate(() => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const rows = Array.from(document.querySelectorAll('tr,.el-table__row')).filter(visible);
    return rows.map((row) => {
      const cells = Array.from(row.querySelectorAll('td .cell,td,[role="cell"]'))
        .filter(visible)
        .map((cell) => norm(cell.innerText || cell.textContent))
        .filter(Boolean);
      const buttons = Array.from(row.querySelectorAll('button,a,[role="button"]'))
        .filter(visible)
        .map((button) => norm(button.innerText || button.textContent))
        .filter(Boolean);
      return { text: norm(row.innerText || row.textContent), cells, buttons };
    }).filter((row) => row.buttons.includes('构建') && row.buttons.includes('部署详情'));
  });

  const ci = await fetchJson(page, 'https://lexiao-api.oa.fenqile.com/oa/lexiao/pipeline/ci_pipeline_status_batch.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version_id: versionId, env }),
  });
  const pipelineRows = ci.json?.result_rows || [];

  const apps = domRows.map((row) => {
    const cells = row.cells;
    const appName = cells.find((cell) => /^server[-_a-zA-Z0-9]+$/.test(cell)) || '';
    const orderIndex = cells.findIndex((cell) => cell === appName) - 1;
    const publishOrder = maybeNumber(cells[orderIndex]) ?? maybeNumber(cells.find((cell) => /^\d+$/.test(cell)));
    const pipeline = pipelineRows.find((item) => pipelineMatchesApp(item, appName)) || null;
    const envArtifact = pipeline?.artifact_status_list?.find((item) => item.env === env) || null;
    return {
      publish_order: publishOrder,
      app_name: appName,
      row_text: row.text,
      cells,
      pipeline: pipeline && {
        project_id: pipeline.project_id,
        app_id: pipeline.app_id,
        project_name: pipeline.project_name,
        app_name: pipeline.app_name,
        pipeline_status_desc: pipeline.pipeline_status_desc,
        pipeline_job_url: pipeline.pipeline_job_url,
        env_artifact_status_desc: envArtifact?.artifact_status_desc,
      },
    };
  }).filter((item) => item.app_name);

  apps.sort((a, b) => (a.publish_order ?? 999999) - (b.publish_order ?? 999999) || a.app_name.localeCompare(b.app_name));
  return { apps, pipeline_rows: pipelineRows };
}

async function branchIntegrate(page, url) {
  await gotoLexiao(page, url, 'pre');
  const openIntegration = await clickVisibleButton(page, '分支集成详情');
  if (!openIntegration.clicked) {
    const fallback = await clickVisibleButton(page, '分支集成');
    if (!fallback.clicked) return { openIntegration, fallback, outcome: 'open-failed', dialogs: await visibleDialogs(page) };
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const batchClick = await clickVisibleButton(page, '批量集成分支');
  const confirm = batchClick.clicked ? await confirmIfNeeded(page, 20000) : null;
  await page.waitForTimeout(3000);
  return { openIntegration, batchClick, confirm, dialogs: await visibleDialogs(page), outcome: batchClick.clicked ? 'triggered' : 'not-triggered' };
}

async function waitBuild(page, versionId, appId, projectId, env, timeoutMs = 900000, pollMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const snapshots = [];
  let last = null;
  while (Date.now() < deadline) {
    const status = await fetchJson(page, 'https://lexiao-api.oa.fenqile.com/oa/lexiao/pipeline/ci_pipeline_status_batch.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version_id: versionId, env }),
    });
    const rows = status.json?.result_rows || [];
    const target = rows.find((item) => Number(item.app_id) === Number(appId) || Number(item.project_id) === Number(projectId)) || null;
    const envArtifact = target?.artifact_status_list?.find((item) => item.env === env) || null;
    last = {
      at: new Date().toISOString(),
      project_id: target?.project_id,
      app_id: target?.app_id,
      project_name: target?.project_name,
      app_name: target?.app_name,
      pipeline_status_desc: target?.pipeline_status_desc,
      pipeline_job_url: target?.pipeline_job_url,
      env_artifact_status_desc: envArtifact?.artifact_status_desc,
    };
    snapshots.push(last);
    const text = `${last.pipeline_status_desc || ''} ${last.env_artifact_status_desc || ''}`;
    if (/失败/.test(text)) return { outcome: 'failed', last, snapshots: snapshots.slice(-12) };
    if (last.pipeline_status_desc === '执行成功' && last.env_artifact_status_desc === '制作成功') {
      return { outcome: 'success', last, snapshots: snapshots.slice(-12) };
    }
    await page.waitForTimeout(pollMs);
  }
  return { outcome: 'timeout', last, snapshots: snapshots.slice(-12) };
}

function findAppByName(apps, appName) {
  const exact = apps.find((item) => item.app_name === appName);
  if (exact) return exact;
  const normalized = apps.filter((item) => normalizeAppName(item.app_name) === normalizeAppName(appName));
  return normalized.length === 1 ? normalized[0] : null;
}

async function resolveTargetApps(page, url, versionId, env, appNames) {
  const names = appNames.filter(Boolean);
  if (!names.length) throw new Error('missing --apps=<app1,app2>');
  const listed = await listApps(page, url, versionId, env);
  const targets = names.map((name) => {
    const app = findAppByName(listed.apps, name);
    if (!app) throw new Error(`target-app-not-found: ${name}`);
    return app;
  });
  return { targets, listed };
}

async function waitBuildMany(page, versionId, targets, env, timeoutMs = 900000, pollMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const snapshots = [];
  let last = [];
  while (Date.now() < deadline) {
    const status = await fetchJson(page, 'https://lexiao-api.oa.fenqile.com/oa/lexiao/pipeline/ci_pipeline_status_batch.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version_id: versionId, env }),
    });
    const rows = status.json?.result_rows || [];
    last = targets.map((targetApp) => {
      const target = rows.find((item) => {
        if (targetApp.pipeline?.app_id && Number(item.app_id) === Number(targetApp.pipeline.app_id)) return true;
        if (targetApp.pipeline?.project_id && Number(item.project_id) === Number(targetApp.pipeline.project_id)) return true;
        return pipelineMatchesApp(item, targetApp.app_name);
      }) || null;
      const envArtifact = target?.artifact_status_list?.find((item) => item.env === env) || null;
      return {
        app_name: targetApp.app_name,
        project_id: target?.project_id ?? targetApp.pipeline?.project_id,
        app_id: target?.app_id ?? targetApp.pipeline?.app_id,
        project_name: target?.project_name ?? targetApp.pipeline?.project_name,
        pipeline_status_desc: target?.pipeline_status_desc,
        pipeline_job_url: target?.pipeline_job_url,
        env_artifact_status_desc: envArtifact?.artifact_status_desc,
      };
    });
    snapshots.push({ at: new Date().toISOString(), targets: last });
    const failed = last.filter((item) => /失败/.test(`${item.pipeline_status_desc || ''} ${item.env_artifact_status_desc || ''}`));
    if (failed.length) return { outcome: 'failed', failed, last, snapshots: snapshots.slice(-12) };
    const allSuccess = last.every((item) => item.pipeline_status_desc === '执行成功' && item.env_artifact_status_desc === '制作成功');
    if (allSuccess) return { outcome: 'success', last, snapshots: snapshots.slice(-12) };
    await page.waitForTimeout(pollMs);
  }
  return { outcome: 'timeout', last, snapshots: snapshots.slice(-12) };
}

async function buildApp(page, url, versionId, appName, appId, projectId, env, timeoutMs = 900000, pollMs = 30000) {
  await gotoLexiao(page, url, env);
  const before = (await listApps(page, url, versionId, env)).apps.find((item) => item.app_name === appName) || null;
  const buildClick = await clickRowButton(page, appName, '构建');
  const confirm = buildClick.clicked ? await confirmIfNeeded(page, 20000) : null;
  const wait = appId || projectId ? await waitBuild(page, versionId, appId, projectId, env, timeoutMs, pollMs) : null;
  return { before, buildClick, confirm, wait };
}

async function buildMany(page, url, versionId, appNames, env, timeoutMs = 900000, pollMs = 30000) {
  await gotoLexiao(page, url, env);
  const { targets, listed } = await resolveTargetApps(page, url, versionId, env, appNames);
  const clicks = [];
  for (const target of targets) {
    const buildClick = await clickRowButton(page, target.app_name, '构建');
    const confirm = buildClick.clicked ? await confirmIfNeeded(page, 20000) : null;
    clicks.push({ app_name: target.app_name, buildClick, confirm });
    await page.waitForTimeout(1000);
  }
  const wait = await waitBuildMany(page, versionId, targets, env, timeoutMs, pollMs);
  return { before: targets, all_apps_count: listed.apps.length, clicks, wait };
}

async function latestDetails(page, versionId, orderId, env) {
  const details = await fetchJson(page, `https://lexiao-api.oa.fenqile.com/oa/publish/devops/deploymentOrder/getPublishDetails.json?version_id=${versionId}&order_id=${orderId}&env=${encodeURIComponent(env)}&app_type=java`);
  return { status: details.status, retcode: details.json?.retcode, retmsg: details.json?.retmsg, root: details.json?.result_rows?.[0] || {} };
}

function rootMatchesApp(root, appName) {
  return [
    ...(root.kvm_deployment_detail_list || []),
    ...(root.deployment_order_detail_list || []),
    ...(root.container_deployment_detail_list || []),
  ].some((item) => item.app_name === appName || item.deployment_id === appName);
}

async function findOrderFromResponses(page, versionId, responses, appName, env) {
  const candidates = responses
    .filter((item) => item.url.includes('getPublishDetails.json'))
    .map((item) => {
      const match = item.url.match(/[?&]order_id=(\d+)/);
      return match ? Number(match[1]) : null;
    })
    .filter(Boolean);
  const unique = [...new Set(candidates)].sort((a, b) => b - a);
  for (const orderId of unique) {
    const details = await latestDetails(page, versionId, orderId, env);
    if (rootMatchesApp(details.root, appName)) return { orderId, details };
  }
  return null;
}

async function openOrder(page, url, versionId, appName, responses, env) {
  responses.length = 0;
  await gotoLexiao(page, url, env);
  const detailClick = await clickRowButton(page, appName, '部署详情');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const dialogsBefore = await visibleDialogs(page);
  let createClick = null;
  if (dialogsBefore.some((dialog) => dialog.text.includes('存在新制品') && dialog.text.includes('创建新的发布单'))) {
    createClick = await clickVisibleButton(page, '创建新发布单');
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3500);
  }
  let found = await findOrderFromResponses(page, versionId, responses, appName, env);
  if (!found) {
    await page.waitForTimeout(2000);
    found = await findOrderFromResponses(page, versionId, responses, appName, env);
  }
  if (!found) {
    throw new Error(JSON.stringify({ message: 'cannot-find-publish-order', appName, detailClick, createClick, dialogs: await visibleDialogs(page) }, null, 2));
  }
  return { app_name: appName, detailClick, dialogsBefore, createClick, order_id: found.orderId, details: found.details.root };
}

async function waitKvm(page, versionId, orderId, machineIp, env, timeoutMs = 900000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const details = await latestDetails(page, versionId, orderId, env);
    const machine = (details.root.kvm_deployment_detail_list || []).find((item) => item.machine_ip === machineIp) || null;
    last = { at: new Date().toISOString(), machine };
    const text = `${machine?.machine_status || ''} ${machine?.publish_status || ''} ${machine?.publish_status_desc || ''} ${machine?.publish_msg || ''}`;
    if (/PUBLISH_FAIL|FAIL|发布失败|启动失败|健康检查.*超时|restart fail/i.test(text)) return { outcome: 'failed', last };
    if (/RUNNING/.test(text) && /(已发布|PUBLISHED|ROLL_INIT|has publish|Dubbo run OK)/i.test(text)) return { outcome: 'success', last };
    await page.waitForTimeout(8000);
  }
  return { outcome: 'timeout', last };
}

async function waitContainer(page, versionId, orderId, orderDetailId, env, timeoutMs = 900000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const details = await latestDetails(page, versionId, orderId, env);
    const target = (details.root.deployment_order_detail_list || []).find((item) => Number(item.order_detail_id) === Number(orderDetailId)) || null;
    last = { at: new Date().toISOString(), target };
    const text = `${target?.publish_status || ''} ${target?.publish_status_desc || ''} ${target?.publish_msg || ''}`;
    if (/PUBLISH_FAIL|FAIL|发布失败|启动失败|健康检查.*超时|restart fail/i.test(text)) return { outcome: 'failed', last };
    if (/(已发布|PUBLISHED|ROLL_INIT|发布成功|has publish)/i.test(text)) return { outcome: 'success', last };
    await page.waitForTimeout(8000);
  }
  return { outcome: 'timeout', last };
}

async function deployOne(page, url, versionId, appName, orderId, targetType, targetIp, deploymentId, env) {
  const before = await latestDetails(page, versionId, orderId, env);
  const vmTargets = before.root.kvm_deployment_detail_list || [];
  const containerTargets = before.root.deployment_order_detail_list || [];
  let selectedType = targetType === 'container' ? 'container' : 'vm';
  if (targetType === 'auto') selectedType = vmTargets.length ? 'vm' : 'container';
  if (selectedType === 'vm') {
    const target = targetIp ? vmTargets.find((item) => item.machine_ip === targetIp) : vmTargets[0];
    if (!target) throw new Error(`no-vm-target: ${appName}`);
    await gotoLexiao(page, url, env);
    await clickRowButton(page, appName, '部署详情');
    await page.waitForTimeout(2500);
    const deployClick = await clickRowButton(page, target.machine_ip, '部署');
    const confirm = deployClick.clicked ? await confirmIfNeeded(page) : null;
    const wait = deployClick.clicked ? await waitKvm(page, versionId, orderId, target.machine_ip, env) : null;
    return { app_name: appName, order_id: orderId, env, selected_type: 'vm', target, deployClick, confirm, wait, final: (await latestDetails(page, versionId, orderId, env)).root };
  }

  const target = deploymentId
    ? containerTargets.find((item) => item.deployment_id === deploymentId || Number(item.order_detail_id) === Number(deploymentId))
    : containerTargets[0];
  if (!target) throw new Error(`no-container-target: ${appName}`);
  const body = {
    version_id: versionId,
    versionId,
    order_id: orderId,
    env,
    app_type: 'java',
    order_detail_ids: [target.order_detail_id],
    deployment_type: 2,
  };
  const publish = await fetchJson(page, 'https://lexiao-api.oa.fenqile.com/oa/lexiao/publish_by_order_detail_id.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const wait = await waitContainer(page, versionId, orderId, target.order_detail_id, env);
  return { app_name: appName, order_id: orderId, env, selected_type: 'container', target, publish, wait, final: (await latestDetails(page, versionId, orderId, env)).root };
}

async function containerLogin(page, url, appName, env, podNeedle) {
  await gotoLexiao(page, url, env);
  const detailClick = await clickRowButton(page, appName, '部署详情');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const dialogsBefore = await visibleDialogs(page);
  const rowNeedle = podNeedle || await page.evaluate(() => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const rows = Array.from(document.querySelectorAll('tr,.el-table__row,[class*="row"]')).filter(visible);
    for (const row of rows) {
      const text = norm(row.innerText || row.textContent);
      if (text.includes('登录实例')) {
        const parts = text.split(/\s+/).filter(Boolean);
        return parts.find((part) => /^server[-_a-zA-Z0-9]+-[a-z0-9]+-[a-z0-9]+$/i.test(part))
          || parts.find((part) => /^\d+\.\d+\.\d+\.\d+$/.test(part))
          || text;
      }
    }
    return '';
  });
  if (!rowNeedle) throw new Error(JSON.stringify({ message: 'cannot-find-container-instance-row', appName, detailClick, dialogsBefore }, null, 2));

  const popupPromise = page.context().waitForEvent('page', { timeout: 15000 }).catch(() => null);
  const navigationPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
  const click = await clickRowButton(page, rowNeedle, '登录实例');
  const popup = await popupPromise;
  await navigationPromise;
  const targetPage = popup || page;
  await targetPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await targetPage.waitForTimeout(1500);
  return {
    app_name: appName,
    env,
    detailClick,
    rowNeedle,
    click,
    url: targetPage.url(),
    title: await targetPage.title().catch(() => ''),
    dialogsBefore,
  };
}

async function status(page, versionId, orderIds, env) {
  const rows = [];
  for (const orderId of orderIds) {
    const details = await latestDetails(page, versionId, Number(orderId), env);
    const root = details.root;
    rows.push({
      order_id: Number(orderId),
      version_tag: root.version_tag,
      kvm: (root.kvm_deployment_detail_list || []).map((item) => ({
        machine_ip: item.machine_ip,
        publish_status_desc: item.publish_status_desc,
        publish_status: item.publish_status,
        machine_status: item.machine_status,
        publish_time: item.publish_time,
        publish_msg: item.publish_msg,
      })),
      container: (root.deployment_order_detail_list || []).map((item) => ({
        deployment_id: item.deployment_id,
        order_detail_id: item.order_detail_id,
        publish_status_desc: item.publish_status_desc,
        publish_status: item.publish_status,
        publish_time: item.publish_time,
        pod_list: item.pod_list,
        login_pod_addr: item.login_pod_addr,
        publish_msg: item.publish_msg,
      })),
    });
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args.action || 'list-apps';
  const url = args.url || 'https://lexiao.oa.fenqile.com/#/app-publish/51303';
  const env = args.env || 'pre';
  const pollMs = Number(args['poll-ms'] || 30000);
  const versionId = Number(args['version-id'] || versionIdFromUrl(url));
  if (!versionId) throw new Error('missing --version-id or app-publish/<id> URL');

  const context = await openContext(args);
  const responses = [];
  try {
    const page = context.pages()[0] || await context.newPage();
    page.on('response', async (response) => {
      const responseUrl = response.url();
      if (!/lexiao-api\.oa\.fenqile\.com\/oa\/.*(Publish|publish|deployment|Deployment|order|Order)/.test(responseUrl)) return;
      responses.push({ status: response.status(), url: responseUrl, at: Date.now() });
      if (responses.length > 200) responses.shift();
    });

    let result;
    if (action === 'list-apps') {
      result = await listApps(page, url, versionId, env);
    } else if (action === 'branch-integrate') {
      result = await branchIntegrate(page, url);
    } else if (action === 'build') {
      result = await buildApp(page, url, versionId, args.app, args['app-id'], args['project-id'], env, Number(args.timeout || 900000), pollMs);
    } else if (action === 'build-many') {
      result = await buildMany(page, url, versionId, parseCsv(args.apps), env, Number(args.timeout || 900000), pollMs);
    } else if (action === 'wait-build') {
      await gotoLexiao(page, url, env);
      result = await waitBuild(page, versionId, args['app-id'], args['project-id'], env, Number(args.timeout || 900000), pollMs);
    } else if (action === 'wait-build-many') {
      await gotoLexiao(page, url, env);
      const { targets } = await resolveTargetApps(page, url, versionId, env, parseCsv(args.apps));
      result = await waitBuildMany(page, versionId, targets, env, Number(args.timeout || 900000), pollMs);
    } else if (action === 'open-order') {
      result = await openOrder(page, url, versionId, args.app, responses, env);
    } else if (action === 'deploy-one') {
      await gotoLexiao(page, url, env);
      result = await deployOne(page, url, versionId, args.app, Number(args['order-id']), args['target-type'] || 'auto', args['target-ip'], args['deployment-id'], env);
    } else if (action === 'container-login') {
      result = await containerLogin(page, url, args.app, env, args.pod || args['pod-ip'] || args['container-ip']);
    } else if (action === 'status') {
      await gotoLexiao(page, url, env);
      result = await status(page, versionId, parseCsv(args['order-ids'] || args['order-id']), env);
    } else {
      throw new Error(`unknown action: ${action}`);
    }
    console.log(JSON.stringify({ action, env, version_id: versionId, result }, null, 2));
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
