#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');

const BASE_URL = 'https://healthy.lexincloud.com';
const DEFAULT_BOARD = '11147';
const DEFAULT_URL = 'https://healthy.lexincloud.com/show/dashboard/11147';
const DEFAULT_PROFILE = '/tmp/healthy-dashboard-profile';
const DEFAULT_TOOL_DIR = '/home/joney/tools/lexiao-browser';
const READ_SCRIPT = '/home/joney/projects/ai/agent-tools/skills/lexin/healthy-dashboard-config/scripts/healthy_dashboard_config.js';
const BROWSER_SCRIPT = '/home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js';

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

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function runNode(script, args, timeoutMs) {
  const result = spawnSync('node', [script, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `node ${script} failed`).trim());
  }
  return result.stdout.trim();
}

function readBoard(board, profile) {
  const stdout = runNode(READ_SCRIPT, [`--board=${board}`, `--profile=${profile}`, '--read'], 120000);
  const parsed = JSON.parse(stdout);
  return parsed.backup?.after || parsed.backup?.before || `/tmp/healthy-dashboard-${board}-after.json`;
}

function pageSnapshot(url, profile) {
  const stdout = runNode(BROWSER_SCRIPT, [
    `--url=${url}`,
    `--profile=${profile}`,
    '--success-text=none',
  ], 90000);
  const parsed = JSON.parse(stdout);
  return {
    title: parsed.title,
    url: parsed.url,
    sessionReady: parsed.sessionReady,
    snippet: parsed.snippet,
    buttons: (parsed.buttons || []).map((button) => button.text).filter(Boolean),
  };
}

function parseConfigs(boardJson) {
  const rawConfigs = boardJson.configs;
  if (!rawConfigs) {
    throw new Error('board json has no configs field');
  }
  return typeof rawConfigs === 'string' ? JSON.parse(rawConfigs) : rawConfigs;
}

function metricNames(expr) {
  const result = new Set();
  const regex = /([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{/g;
  let match = regex.exec(expr);
  while (match) {
    result.add(match[1]);
    match = regex.exec(expr);
  }
  return [...result];
}

function summarizePanels(panels) {
  const sections = [];
  let current = null;
  for (const panel of panels) {
    if (panel.type === 'row') {
      current = { name: panel.name, panels: [] };
      sections.push(current);
      continue;
    }
    const item = {
      name: panel.name,
      type: panel.type,
      exprs: (panel.targets || []).map((target) => target.expr).filter(Boolean),
    };
    if (!current) {
      current = { name: 'Ungrouped', panels: [] };
      sections.push(current);
    }
    current.panels.push(item);
  }
  return sections;
}

function summarizeBoard(boardPath) {
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  const configs = parseConfigs(board);
  const panels = configs.panels || [];
  const panelNames = panels.map((panel) => panel.name).filter(Boolean);
  const duplicatePanelNames = [...new Set(panelNames.filter((name, index) => panelNames.indexOf(name) !== index))];
  const exprs = panels.flatMap((panel) => (panel.targets || []).map((target) => target.expr).filter(Boolean));
  return {
    boardPath,
    id: board.id,
    name: board.name,
    groupId: board.group_id,
    tags: board.tags,
    version: configs.version,
    variables: (configs.var || []).map((item) => ({
      name: item.name,
      type: item.type,
      definition: item.definition,
      defaultValue: item.defaultValue,
      multi: Boolean(item.multi),
      allOption: Boolean(item.allOption),
    })),
    panelCount: panels.length,
    rowCount: panels.filter((panel) => panel.type === 'row').length,
    duplicatePanelNames,
    metrics: [...new Set(exprs.flatMap(metricNames))].sort(),
    sections: summarizePanels(panels),
  };
}

function loadPlaywright(toolDir) {
  const requireFromTool = createRequire(path.join(toolDir, 'package.json'));
  return requireFromTool('playwright').chromium;
}

async function openContext(profile, toolDir) {
  const chromium = loadPlaywright(toolDir);
  return chromium.launchPersistentContext(profile, {
    executablePath: path.join(toolDir, 'browsers/chrome-linux64/chrome'),
    headless: true,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: [path.join(toolDir, 'runtime-libs/usr/lib/x86_64-linux-gnu'), process.env.LD_LIBRARY_PATH]
        .filter(Boolean)
        .join(':'),
    },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

async function extractAuth(page) {
  await page.goto(`${BASE_URL}/dashboards`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1000);
  return page.evaluate(() => {
    const keys = Object.keys(localStorage);
    const tokenKey = keys.find((key) => /access.?token|token/i.test(key) && localStorage.getItem(key));
    const ticketKey = keys.find((key) => /ticket/i.test(key) && localStorage.getItem(key));
    return {
      token: tokenKey ? localStorage.getItem(tokenKey) : '',
      ticket: ticketKey ? localStorage.getItem(ticketKey) : '',
      title: document.title,
      snippet: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 300),
    };
  });
}

function headers(auth) {
  const result = {
    accept: 'application/json',
    'content-type': 'application/json;charset=UTF-8',
    'x-cluster': 'Default',
    'x-language': 'zh',
  };
  if (auth.token) result.authorization = `Bearer ${auth.token}`;
  if (auth.ticket) result.ticket = auth.ticket;
  return result;
}

async function promQuery(page, auth, query) {
  const response = await page.evaluate(async ({ baseUrl, headers, query }) => {
    const params = new URLSearchParams();
    params.set('query', query);
    const resp = await fetch(`${baseUrl}/api/n9e/prometheus/api/v1/query?${params.toString()}`, {
      method: 'POST',
      headers,
      credentials: 'include',
    });
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (error) {
      json = { parseError: error.message, text: text.slice(0, 1000) };
    }
    return { status: resp.status, ok: resp.ok, json };
  }, { baseUrl: BASE_URL, headers: headers(auth), query });
  if (!response.ok || response.json.status !== 'success') {
    throw new Error(`Prometheus query failed: ${query}; response=${JSON.stringify(response).slice(0, 1200)}`);
  }
  return response.json.data.result || [];
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function valueOf(item) {
  return Number(item.value && item.value[1]);
}

function timestampOf(item) {
  return Number(item.value && item.value[0]);
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function stats(vector, mapper = (value) => value) {
  const values = vector.map(valueOf).filter(Number.isFinite).map(mapper).sort((a, b) => a - b);
  if (!values.length) return { count: 0 };
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    count: values.length,
    min: round(values[0]),
    avg: round(sum / values.length),
    p50: round(percentile(values, 0.5)),
    p90: round(percentile(values, 0.9)),
    max: round(values[values.length - 1]),
  };
}

function bytesToGiB(value) {
  return value / 1024 / 1024 / 1024;
}

function top(vector, mapper = (value) => value, limit = 8) {
  return vector
    .map((item) => ({
      ident: item.metric.ident,
      set: item.metric.set,
      value: round(mapper(valueOf(item))),
    }))
    .filter((item) => item.ident && Number.isFinite(item.value))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function countByLabel(vector, label) {
  const counts = new Map();
  for (const item of vector) {
    const value = item.metric[label] || 'unknown';
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ [label]: value, count }))
    .sort((a, b) => b.count - a.count || String(a[label]).localeCompare(String(b[label])));
}

function fmtTime(seconds) {
  if (!Number.isFinite(seconds)) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(seconds * 1000));
}

async function inspectApp(profile, toolDir, app, env, range, ident) {
  const context = await openContext(profile, toolDir);
  const page = await context.newPage();
  try {
    const auth = await extractAuth(page);
    if (!auth.token) {
      throw new Error(`Healthy token not found. title=${auth.title}; snippet=${auth.snippet}`);
    }
    const identFilter = ident ? `, ident="${escapeLabel(ident)}"` : ', ident!=""';
    const match = `{app="${escapeLabel(app)}", env="${escapeLabel(env)}"${identFilter}}`;
    const queries = {
      oldGenRatio: `old_gen_mem_ratio${match}`,
      oldGenUsed: `old_gen_mem_used${match}`,
      edenRatio: `eden_gen_mem_ratio${match}`,
      edenUsed: `eden_gen_mem_used${match}`,
      newGenPromotion: `new_gen_promotion${match}`,
      gcThroughput: `gc_throughput${match}`,
      threadPeak: `thread_peak_count${match}`,
      threadActive: `thread_active_count${match}`,
      youngGcCount: `g1_young_generation_gc_count${match}`,
      youngGcAvgTime: `g1_young_generation_gc_avg_time${match}`,
      oldGcCount: `g1_old_generation_gc_count${match}`,
      oldGcAvgTime: `g1_old_generation_gc_avg_time${match}`,
    };
    const current = {};
    for (const [name, query] of Object.entries(queries)) {
      current[name] = await promQuery(page, auth, query);
    }
    const rangeMax = {};
    for (const [name, query] of Object.entries(queries)) {
      rangeMax[name] = await promQuery(page, auth, `max_over_time(${query}[${range}])`);
    }
    const timestamps = Object.values(current)
      .flat()
      .map(timestampOf)
      .filter(Number.isFinite);
    const sampleTime = timestamps.length ? Math.max(...timestamps) : null;
    return {
      app,
      env,
      ident: ident || null,
      range,
      sampleTimeAsiaShanghai: fmtTime(sampleTime),
      instanceCount: current.oldGenRatio.length,
      instanceCountBySet: countByLabel(current.oldGenRatio, 'set'),
      current: {
        oldGenRatioPercent: stats(current.oldGenRatio),
        oldGenUsedGiB: stats(current.oldGenUsed, bytesToGiB),
        edenRatioPercent: stats(current.edenRatio),
        edenUsedGiB: stats(current.edenUsed, bytesToGiB),
        newGenPromotionGiB: stats(current.newGenPromotion, bytesToGiB),
        gcThroughputPercent: stats(current.gcThroughput),
        threadPeakCount: stats(current.threadPeak),
        threadActiveCount: stats(current.threadActive),
        youngGcCountPerMinute: stats(current.youngGcCount),
        youngGcAvgTimeMs: stats(current.youngGcAvgTime),
        oldGcCountPerMinute: stats(current.oldGcCount),
        oldGcAvgTimeMs: stats(current.oldGcAvgTime),
      },
      maxInRange: {
        oldGenRatioPercent: stats(rangeMax.oldGenRatio),
        oldGenUsedGiB: stats(rangeMax.oldGenUsed, bytesToGiB),
        edenRatioPercent: stats(rangeMax.edenRatio),
        edenUsedGiB: stats(rangeMax.edenUsed, bytesToGiB),
        newGenPromotionGiB: stats(rangeMax.newGenPromotion, bytesToGiB),
        gcThroughputPercent: stats(rangeMax.gcThroughput),
        threadPeakCount: stats(rangeMax.threadPeak),
        threadActiveCount: stats(rangeMax.threadActive),
        youngGcCountPerMinute: stats(rangeMax.youngGcCount),
        youngGcAvgTimeMs: stats(rangeMax.youngGcAvgTime),
        oldGcCountPerMinute: stats(rangeMax.oldGcCount),
        oldGcAvgTimeMs: stats(rangeMax.oldGcAvgTime),
      },
      topCurrent: {
        oldGenRatioPercent: top(current.oldGenRatio),
        oldGenUsedGiB: top(current.oldGenUsed, bytesToGiB),
        edenUsedGiB: top(current.edenUsed, bytesToGiB),
        threadActiveCount: top(current.threadActive),
        youngGcCountPerMinute: top(current.youngGcCount),
      },
      topMaxInRange: {
        oldGenRatioPercent: top(rangeMax.oldGenRatio),
        oldGenUsedGiB: top(rangeMax.oldGenUsed, bytesToGiB),
        edenUsedGiB: top(rangeMax.edenUsed, bytesToGiB),
        threadActiveCount: top(rangeMax.threadActive),
        youngGcCountPerMinute: top(rangeMax.youngGcCount),
      },
      queryMatch: match,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const board = String(args.board || DEFAULT_BOARD);
  const url = args.url || (board === DEFAULT_BOARD ? DEFAULT_URL : `https://healthy.lexincloud.com/dashboards/${board}`);
  const profile = expandHome(args.profile || DEFAULT_PROFILE);
  const toolDir = expandHome(args['tool-dir'] || DEFAULT_TOOL_DIR);
  const boardPath = expandHome(args.from || readBoard(board, profile));
  const summary = summarizeBoard(boardPath);
  if (!args['no-page']) {
    summary.page = pageSnapshot(url, profile);
  }
  if (args.app) {
    summary.appInspection = await inspectApp(
      profile,
      toolDir,
      args.app,
      args.env || 'prod',
      args.range || '1h',
      args.ident,
    );
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
