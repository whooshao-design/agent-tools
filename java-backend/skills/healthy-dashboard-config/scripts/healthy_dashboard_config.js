#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const BASE_URL = 'https://healthy.lexincloud.com';
const DEFAULT_PROFILE = '/tmp/healthy-dashboard-profile';
const DEFAULT_TOOL_DIR = '~/tools/lexiao-browser';

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq !== -1) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args[item.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      args[item.slice(2)] = true;
    }
  }
  return args;
}

function usage() {
  console.log(`Usage:
  healthy_dashboard_config.js --board=<id> --read [--profile=/tmp/healthy-dashboard-profile]
  healthy_dashboard_config.js --board=<id> --mode=hawk-read-through --apply [--profile=/tmp/healthy-dashboard-profile]

Options:
  --board          Healthy board id, for example 16761
  --read           Only read board configs and write /tmp backup
  --apply          Write generated configs back to Healthy
  --mode           Built-in mode. Currently supports: hawk-read-through
  --profile        Browser profile with Healthy login state
  --tool-dir       Local Playwright tool dir, defaults to ~/tools/lexiao-browser
`);
}

function resolvePaths(args) {
  const toolDir = expandHome(args['tool-dir'] || DEFAULT_TOOL_DIR);
  return {
    toolDir,
    profileDir: expandHome(args.profile || DEFAULT_PROFILE),
    chromePath: expandHome(args.chrome || path.join(toolDir, 'browsers/chrome-linux64/chrome')),
    runtimeLibDir: expandHome(args['runtime-lib-dir'] || path.join(toolDir, 'runtime-libs/usr/lib/x86_64-linux-gnu')),
    playwrightPackage: path.join(toolDir, 'package.json'),
  };
}

function loadPlaywright(paths) {
  if (!fs.existsSync(paths.playwrightPackage)) {
    throw new Error(`Playwright 工具目录不存在：${paths.toolDir}`);
  }
  const requireFromTool = createRequire(paths.playwrightPackage);
  return requireFromTool('playwright').chromium;
}

async function openContext(paths, chromium) {
  const ldLibraryPath = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return chromium.launchPersistentContext(paths.profileDir, {
    executablePath: paths.chromePath,
    headless: true,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: ldLibraryPath,
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
      tokenKey,
      ticketKey,
      title: document.title,
      snippet: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 400),
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

async function requestJson(page, method, url, auth, body) {
  return page.evaluate(async ({ method, url, headers, body }) => {
    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (error) {
      json = { parseError: error.message, text: text.slice(0, 1000) };
    }
    return { status: resp.status, ok: resp.ok, json };
  }, { method, url, headers: headers(auth), body });
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
      defaultValue: 'prod',
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
      defaultValue: ['all'],
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    process.exit(0);
  }
  if (!args.board) {
    usage();
    process.exit(1);
  }
  if (!args.read && !args.apply) {
    throw new Error('必须指定 --read 或 --apply');
  }

  const paths = resolvePaths(args);
  const chromium = loadPlaywright(paths);
  const context = await openContext(paths, chromium);
  const page = await context.newPage();
  try {
    const auth = await extractAuth(page);
    if (!auth.token) {
      throw new Error(`未从 Healthy localStorage 获取 access_token，可能是登录态失效。请使用 get-browser-session skill 刷新登录态，url=${BASE_URL}/dashboards/${args.board}, profile=${paths.profileDir}，完成登录后再重试。页面标题=${auth.title}，内容=${auth.snippet}`);
    }

    const boardUrl = `${BASE_URL}/api/n9e/board/${args.board}`;
    const boardResp = await requestJson(page, 'GET', boardUrl, auth);
    if (!boardResp.ok) {
      throw new Error(`GET board 失败：status=${boardResp.status}, body=${JSON.stringify(boardResp.json).slice(0, 500)}`);
    }

    const parsed = parseBoardConfigs(boardResp);
    const beforePath = `/tmp/healthy-dashboard-${args.board}-before.json`;
    fs.writeFileSync(beforePath, JSON.stringify(parsed.board, null, 2));

    let finalConfigs = parsed.configs;
    let putResp = null;
    if (args.apply) {
      if (args.mode !== 'hawk-read-through') {
        throw new Error(`未知 mode：${args.mode}`);
      }
      finalConfigs = hawkReadThroughPatch(parsed.configs);
      putResp = await requestJson(page, 'PUT', `${boardUrl}/configs`, auth, {
        configs: JSON.stringify(finalConfigs),
      });
      if (!putResp.ok || putResp.json?.err) {
        throw new Error(`PUT configs 失败：status=${putResp.status}, body=${JSON.stringify(putResp.json).slice(0, 800)}`);
      }
    }

    const afterResp = await requestJson(page, 'GET', boardUrl, auth);
    const after = parseBoardConfigs(afterResp);
    const afterPath = `/tmp/healthy-dashboard-${args.board}-after.json`;
    fs.writeFileSync(afterPath, JSON.stringify(after.board, null, 2));

    console.log(JSON.stringify({
      board: String(args.board),
      readStatus: boardResp.status,
      putStatus: putResp?.status || null,
      putErr: putResp?.json?.err || '',
      backup: { before: beforePath, after: afterPath },
      before: summarize(parsed.configs),
      after: summarize(after.configs),
    }, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
