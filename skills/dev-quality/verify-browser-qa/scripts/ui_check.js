#!/usr/bin/env node
'use strict';

// Visual self-check: render a page in a fresh headless Chromium (no saved profile, direct network),
// answer API calls from scenario mocks, run steps that open the UI under test, then measure the
// target element (padding to its border, overlap, clipped text, button rows, primary buttons,
// text left edges, icon/text alignment) at each viewport and save screenshots.
//
// Usage: node ui_check.js --scenario=<scenario.json> [--out=<dir>]
// Exit code: 0 = no "fail" findings, 1 = at least one "fail" finding, 2 = cannot run.

const fs = require('fs');
const os = require('os');
const path = require('path');

const BS = path.resolve(__dirname, '../../../lexin/get-browser-session/scripts/browser_session.js');
const PROXY_VARS = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'];
const DEFAULTS = {
  viewports: [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }],
  minPadding: 12,
  maxLeftEdges: 3,
  alignTolerance: 2,
  ignore: [],
};

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

// A scenario may name a base scenario with "extends" (path relative to the scenario file).
// Arrays from the scenario come before the base arrays, so scenario mocks win over base mocks;
// objects are merged key by key; scalars from the scenario replace base values.
function loadScenario(file) {
  const abs = path.resolve(file);
  const own = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!own.extends) return own;
  const base = loadScenario(path.resolve(path.dirname(abs), own.extends));
  return mergeScenario(base, own);
}

function mergeScenario(base, own) {
  const out = { ...base };
  for (const [k, v] of Object.entries(own)) {
    if (k === 'extends') continue;
    if (Array.isArray(v) && Array.isArray(base[k])) out[k] = [...v, ...base[k]];
    else if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') out[k] = { ...base[k], ...v };
    else out[k] = v;
  }
  return out;
}

// Decide what to do with one request URL: first matching rule wins.
// rewrite -> fetch the same path from another origin; mock -> fixed JSON; passthrough -> real network;
// anything else -> defaultMock when its pattern matches, otherwise abort.
function routeFor(url, scenario) {
  for (const r of scenario.rewrite || []) {
    const re = new RegExp(r.match);
    if (re.test(url)) return { action: 'rewrite', url: url.replace(re, r.to) };
  }
  for (const m of scenario.mocks || []) {
    if (new RegExp(m.match).test(url)) return { action: 'mock', status: m.status || 200, body: m.json };
  }
  for (const p of scenario.passthrough || []) {
    if (new RegExp(p).test(url)) return { action: 'continue' };
  }
  const d = scenario.defaultMock;
  if (d && new RegExp(d.match).test(url)) return { action: 'mock', status: 200, body: d.json, unmatched: true };
  return { action: 'abort' };
}

// Runs inside the page. Keep it self-contained: it is serialized by Playwright.
function measure(opts) {
  const root = document.querySelector(opts.target);
  if (!root) return { error: `target not found: ${opts.target}` };
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
  };
  if (!visible(root)) return { error: `target not visible: ${opts.target}` };
  const ignored = (e) => opts.ignore.some((sel) => e.closest(sel));
  const R = root.getBoundingClientRect();
  const rect = (e) => e.getBoundingClientRect();
  const label = (e) => {
    const cls = typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).join('.') : '';
    return `${e.tagName.toLowerCase()}${cls} "${(e.innerText || '').trim().slice(0, 20)}"`;
  };
  const round = (n) => Math.round(n * 10) / 10;

  const btnSel = 'button, .btn, .el-button, [role="button"]';
  const buttons = [...root.querySelectorAll(btnSel)]
    .filter((e) => visible(e) && !ignored(e) && !e.parentElement.closest(btnSel));
  // Text blocks: visible elements that own a non-empty text node, outside buttons.
  const texts = [...root.querySelectorAll('*')].filter((e) => visible(e) && !ignored(e) && !e.closest(btnSel)
    && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
  // Inline pieces (span/a inside a paragraph) wrap across lines, so their boxes overlap each other;
  // measure the nearest non-inline ancestor instead.
  const blockOf = (e) => {
    let x = e;
    while (x !== root && getComputedStyle(x).display === 'inline') x = x.parentElement;
    return x;
  };
  const blocks = [...new Set(texts.map(blockOf))].filter((e) => e !== root);
  const findings = [];
  const add = (level, check, detail) => findings.push({ level, check, detail });

  for (const e of [...buttons, ...blocks]) {
    const r = rect(e);
    const gaps = { left: r.left - R.left, right: R.right - r.right, top: r.top - R.top, bottom: R.bottom - r.bottom };
    const [side, gap] = Object.entries(gaps).sort((a, b) => a[1] - b[1])[0];
    if (gap < opts.minPadding) add('fail', 'cramped', `${label(e)} is ${round(gap)}px from the ${side} border (min ${opts.minPadding}px)`);
  }

  const items = [...buttons, ...blocks];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = rect(a);
      const rb = rect(b);
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 1 && h > 1) add('fail', 'overlap', `${label(a)} overlaps ${label(b)} by ${round(w)}x${round(h)}px`);
    }
  }

  for (const e of [root, ...root.querySelectorAll('*')]) {
    if (!visible(e) || ignored(e)) continue;
    const s = getComputedStyle(e);
    const clipsX = ['hidden', 'clip'].includes(s.overflowX) && e.scrollWidth > e.clientWidth + 1;
    const clipsY = ['hidden', 'clip'].includes(s.overflowY) && e.scrollHeight > e.clientHeight + 1;
    if (clipsX || clipsY) add('fail', 'clipped', `${label(e)} hides overflowing content (${e.scrollWidth}x${e.scrollHeight} in ${e.clientWidth}x${e.clientHeight})`);
  }

  const rows = [];
  for (const b of buttons) {
    const r = rect(b);
    const cy = (r.top + r.bottom) / 2;
    const row = rows.find((x) => Math.abs(x.cy - cy) <= 4);
    if (row) row.items.push(b); else rows.push({ cy, items: [b] });
  }
  for (const row of rows) {
    const hs = row.items.map((b) => rect(b).height);
    if (Math.max(...hs) - Math.min(...hs) > 2) add('warn', 'button-height', `buttons in one row differ in height: ${row.items.map((b, k) => `${label(b)}=${round(hs[k])}px`).join(', ')}`);
  }

  const primaries = buttons.filter((b) => b.matches('.btn-primary, .el-button--primary, .ant-btn-primary'));
  if (primaries.length > 1) add('warn', 'primary-count', `${primaries.length} primary buttons: ${primaries.map(label).join(', ')}`);

  const lefts = [];
  for (const e of blocks) {
    const l = rect(e).left;
    if (!lefts.some((x) => Math.abs(x - l) <= 2)) lefts.push(l);
  }
  if (lefts.length > opts.maxLeftEdges) add('warn', 'left-edges', `text starts at ${lefts.length} different left edges: ${lefts.map((l) => round(l - R.left)).join(', ')}px`);

  for (const pair of opts.align || []) {
    const icon = root.querySelector(pair.icon);
    const text = root.querySelector(pair.text);
    if (!icon || !text) { add('warn', 'align', `align selector not found: ${pair.icon} / ${pair.text}`); continue; }
    const range = document.createRange();
    range.selectNodeContents(text);
    const line = range.getClientRects()[0] || rect(text);
    const ri = rect(icon);
    const dy = Math.abs((ri.top + ri.bottom) / 2 - (line.top + line.bottom) / 2);
    if (dy > opts.alignTolerance) add('warn', 'align', `${pair.icon} center is ${round(dy)}px off the first line of ${pair.text} (tolerance ${opts.alignTolerance}px)`);
  }

  return {
    size: [round(R.width), round(R.height)],
    buttons: buttons.map((b) => {
      const r = rect(b);
      return { text: (b.innerText || '').trim(), toRight: round(R.right - r.right), toBottom: round(R.bottom - r.bottom), height: round(r.height) };
    }),
    findings,
  };
}

async function runStep(page, step) {
  if (step.wait) await page.waitForTimeout(step.wait);
  if (step.waitFor) await page.waitForSelector(step.waitFor, { state: 'visible', timeout: step.timeout || 15000 });
  if (step.click) await page.click(step.click, { timeout: step.timeout || 15000 });
  if (step.fill) await page.fill(step.fill.selector, step.fill.value);
  if (step.css) await page.addStyleTag({ content: step.css });
  if (step.eval) {
    const result = await page.evaluate(`(async () => { ${step.eval} })()`);
    if (result !== undefined) console.error(`[step] eval returned: ${JSON.stringify(result)}`);
  }
}

async function run(scenario, outDir) {
  const { resolvePaths } = require(BS);
  const paths = resolvePaths({}, scenario.url);
  const { createRequire } = require('module');
  const chromium = createRequire(paths.playwrightPackage)('playwright').chromium;
  const env = { ...process.env, LD_LIBRARY_PATH: [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  for (const k of PROXY_VARS) delete env[k];
  const opts = { ...DEFAULTS, ...scenario.check, target: scenario.target };
  const viewports = scenario.viewports || DEFAULTS.viewports;

  const browser = await chromium.launch({ executablePath: paths.chromePath, headless: true, env, args: ['--no-sandbox', '--no-proxy-server'] });
  const unmatched = new Set();
  const pageErrors = [];
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: viewports[0] });
    if (scenario.cookies) await context.addCookies(scenario.cookies);
    if (scenario.sessionStorage || scenario.localStorage) {
      await context.addInitScript(({ ss, ls }) => {
        for (const [k, v] of Object.entries(ss || {})) sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
        for (const [k, v] of Object.entries(ls || {})) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      }, { ss: scenario.sessionStorage, ls: scenario.localStorage });
    }
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      const r = routeFor(url, scenario);
      if (r.action === 'rewrite') {
        try {
          return await route.fulfill({ response: await route.fetch({ url: r.url }) });
        } catch (e) {
          return route.abort();
        }
      }
      if (r.action === 'mock') {
        if (r.unmatched) unmatched.add(url.split('?')[0]);
        return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
      }
      if (r.action === 'continue') return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(scenario.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (const step of scenario.steps || []) await runStep(page, step);

    const results = [];
    for (const vp of viewports) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(300);
      const m = await page.evaluate(measure, opts);
      const tag = `${vp.width}x${vp.height}`;
      const shots = { page: path.join(outDir, `page-${tag}.png`) };
      await page.screenshot({ path: shots.page });
      const el = await page.$(scenario.target);
      if (el && !m.error) {
        shots.target = path.join(outDir, `target-${tag}.png`);
        await el.screenshot({ path: shots.target });
      }
      results.push({ viewport: tag, ...m, screenshots: shots });
    }
    return { results, unmatchedRequests: [...unmatched], pageErrors };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.scenario) {
    console.error('usage: node ui_check.js --scenario=<scenario.json> [--out=<dir>]');
    return 2;
  }
  const scenario = loadScenario(args.scenario);
  if (!scenario.url || !scenario.target) {
    console.error('scenario needs "url" and "target"');
    return 2;
  }
  // Default output is one fixed folder per scenario name, overwritten on each run, so it never piles up.
  const outDir = path.resolve(args.out || path.join(os.tmpdir(), 'agent-tools-ui-check', path.basename(args.scenario, '.json')));
  fs.mkdirSync(outDir, { recursive: true });
  const report = await run(scenario, outDir);
  const findings = report.results.flatMap((r) => (r.error ? [{ level: 'fail', check: 'target', detail: r.error }] : r.findings));
  const status = findings.some((f) => f.level === 'fail') ? 'fail' : (findings.length ? 'warn' : 'pass');
  console.log(JSON.stringify({ status, outDir, ...report }, null, 2));
  return status === 'fail' ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(2);
  });
}

module.exports = { loadScenario, mergeScenario, routeFor, measure, DEFAULTS };
