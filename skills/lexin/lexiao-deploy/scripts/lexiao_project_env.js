#!/usr/bin/env node
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const TOOL_DIR = path.join(os.homedir(), 'tools/lexiao-browser');
const DEFAULT_PROFILE = path.join(os.homedir(), '.codex/lexiao-browser-profile');
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

function requireArg(args, name) {
  if (!args[name]) throw new Error(`missing --${name}`);
  return args[name];
}

async function openContext(profile) {
  const ldLibraryPath = [RUNTIME_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return chromium.launchPersistentContext(profile || DEFAULT_PROFILE, {
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

async function readRow(page, appName) {
  return page.evaluate((appName) => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const compact = (text) => norm(text).replace(/\s+/g, '');
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const rows = Array.from(document.querySelectorAll('tr,.el-table__row')).filter(visible)
      .filter((row) => compact(row.innerText || row.textContent).includes(compact(appName)))
      .sort((a, b) => compact(a.innerText || a.textContent).length - compact(b.innerText || b.textContent).length);
    const row = rows[0];
    if (!row) return null;
    const buttons = Array.from(row.querySelectorAll('button,a,[role="button"]')).filter(visible).map((button) => ({
      text: norm(button.innerText || button.textContent),
      disabled: Boolean(button.disabled || button.classList.contains('is-disabled')),
      loading: button.classList.contains('is-loading') || /loading/i.test(String(button.className || '')),
      className: String(button.className || ''),
    }));
    return {
      text: norm(row.innerText || row.textContent),
      cells: Array.from(row.querySelectorAll('td .cell,td,[role="cell"]')).filter(visible)
        .map((cell) => norm(cell.innerText || cell.textContent)).filter(Boolean),
      buttons,
    };
  }, appName);
}

async function clickRowButton(page, appName, buttonText) {
  const result = await page.evaluate(({ appName, buttonText }) => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const compact = (text) => norm(text).replace(/\s+/g, '');
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const rows = Array.from(document.querySelectorAll('tr,.el-table__row')).filter(visible)
      .filter((row) => compact(row.innerText || row.textContent).includes(compact(appName)))
      .sort((a, b) => compact(a.innerText || a.textContent).length - compact(b.innerText || b.textContent).length);
    const row = rows[0];
    if (!row) return { clicked: false, reason: 'row-not-found' };
    const button = Array.from(row.querySelectorAll('button,a,[role="button"]')).filter(visible)
      .find((item) => compact(item.innerText || item.textContent) === compact(buttonText));
    if (!button) return { clicked: false, reason: 'button-not-found', rowText: norm(row.innerText || row.textContent) };
    if (button.disabled || button.classList.contains('is-disabled')) {
      return { clicked: false, reason: 'button-disabled', rowText: norm(row.innerText || row.textContent) };
    }
    row.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    return { clicked: true, rowText: norm(row.innerText || row.textContent) };
  }, { appName, buttonText });
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

async function waitReadyForDeploy(page, url, appName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const snapshots = [];
  while (Date.now() < deadline) {
    await gotoPage(page, url);
    const row = await readRow(page, appName);
    snapshots.push({ at: new Date().toISOString(), row: rowSummary(row) });
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
      return { outcome: 'ready', row, snapshots: snapshots.slice(-12) };
    }
    if (/执行成功/.test(text) && /制作成功/.test(text) && /已发布/.test(text) && deploy && deploy.disabled) {
      return { outcome: 'no-deployable-artifact', row, snapshots: snapshots.slice(-12) };
    }
    await page.waitForTimeout(10000);
  }
  return { outcome: 'timeout', row: await readRow(page, appName), snapshots: snapshots.slice(-12) };
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args.action || 'status';
  const url = requireArg(args, 'url');
  const appName = requireArg(args, 'app');
  const context = await openContext(args.profile || DEFAULT_PROFILE);
  try {
    const page = context.pages()[0] || await context.newPage();
    await gotoPage(page, url);
    if (action === 'status') {
      console.log(JSON.stringify({ action, row: await readRow(page, appName), dialogs: await visibleDialogs(page) }, null, 2));
      return;
    }
    if (action !== 'deploy') throw new Error(`unknown action: ${action}`);

    const ready = await waitReadyForDeploy(page, url, appName, Number(args['build-timeout'] || 900000));
    if (ready.outcome !== 'ready') {
      console.log(JSON.stringify({ action, ready }, null, 2));
      process.exit(ready.outcome === 'no-deployable-artifact' ? 2 : 1);
    }
    const deployClick = await clickRowButton(page, appName, '部署');
    const confirm = deployClick.clicked ? await confirmDeploy(page) : null;
    const done = deployClick.clicked ? await waitDeployDone(page, url, appName, Number(args['deploy-timeout'] || 900000)) : null;
    console.log(JSON.stringify({ action, ready, deployClick, confirm, done }, null, 2));
    if (!deployClick.clicked || !done || done.outcome !== 'success') process.exit(1);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
