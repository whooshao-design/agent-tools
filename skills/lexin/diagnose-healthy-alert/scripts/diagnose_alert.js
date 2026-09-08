#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const BASE_URLS = {
  stable: 'https://stable-eye.oa.fenqile.com',
  test: 'https://stable-eye.oa.fenqile.com',
  prod: 'https://healthy.lexincloud.com',
  online: 'https://healthy.lexincloud.com',
};

const DEFAULT_CLUSTER = 'Default';
const DEFAULT_LANGUAGE = 'zh';
const DEFAULT_PROFILE = '/home/joney/.local/state/agent-tools/browser-profiles/healthy';
const DEFAULT_TOOL_DIR = '~/tools/lexiao-browser';
const DEFAULT_WINDOW = '30m';
const DEFAULT_STEP = '60s';
const DEFAULT_CODE_ROOT = '/home/joney/projects';
const DEFAULT_BASELINE = '24h';
const DEFAULT_BASELINE_STEP = '300s';
// Alert timestamps are UTC; the app servers write logs in UTC+8, so every
// log-query time window has to be shifted before it is handed to a log tool.
const LOG_TZ_OFFSET_HOURS = 8;
const WEBSHELL_PROFILE = '/home/joney/.local/state/agent-tools/browser-profiles/main';
// Every browser launch costs 30-40s. The token is already stored in the browser
// profile, so caching it in a 0600 file next to it adds no new exposure and
// removes that cost from every follow-up query in the same investigation.
const TOKEN_CACHE_FILE = path.join(os.homedir(), '.cache', 'healthy-alert-token.json');

// PromQL builtins that must not be mistaken for the alert metric name.
const PROMQL_FUNCTIONS = new Set([
  'sum', 'min', 'max', 'avg', 'count', 'stddev', 'stdvar', 'topk', 'bottomk', 'quantile',
  'rate', 'irate', 'increase', 'delta', 'idelta', 'deriv', 'predict_linear', 'resets', 'changes',
  'sum_over_time', 'avg_over_time', 'min_over_time', 'max_over_time', 'count_over_time',
  'quantile_over_time', 'stddev_over_time', 'stdvar_over_time', 'last_over_time', 'present_over_time',
  'absent', 'absent_over_time', 'histogram_quantile', 'label_replace', 'label_join', 'clamp',
  'clamp_max', 'clamp_min', 'round', 'abs', 'ceil', 'floor', 'exp', 'ln', 'log2', 'log10', 'sqrt',
  'time', 'timestamp', 'vector', 'scalar', 'sort', 'sort_desc', 'group', 'by', 'without', 'on',
  'ignoring', 'group_left', 'group_right', 'offset', 'and', 'or', 'unless',
]);

// Suffixes appended by the Hawk/Healthy reporting helpers, stripped to reach the code infix.
const METRIC_SUFFIXES = ['counter', 'average', 'sum', 'gauge', 'histogram', 'summary', 'total', 'count'];

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
  diagnose_alert.js --alert 16343328 [--env prod] [--with-rule] [--replay]
  diagnose_alert.js --alert https://healthy.lexincloud.com/alert-show-detail/16343328 --with-rule --replay
  diagnose_alert.js --alert 16343328 --code-hint-only

Options:
  --alert            Alert event id, or a full alert-show-detail URL
  --env              stable|test|prod|online, default prod
  --base-url         Override API base URL
  --with-rule        Also fetch /api/n9e/alert-rule/{rule_id}
  --replay           Replay prom_ql over the trigger window via query_range
  --window           Padding before trigger / after recover for replay, default 30m
  --baseline         Second replay window for recurrence, default 24h, "off" to skip
  --baseline-step    Step for the baseline pass, default 300s
  --log-pad          Padding around the alert for the suggested log window, default 10m
  --step             query_range step, default 60s
  --code-root        Root dir scanned for candidate repos, default /home/joney/projects
  --no-code-hint     Skip the metric-to-code hint section
  --code-hint-only   Print code hints from a locally supplied metric, no network
  --metric           Metric name, only used with --code-hint-only
  --app              App name, only used with --code-hint-only
  --format           table|json, default table
  --token            Bearer token. Also supports env HEALTHY_METRIC_TOKEN
  --no-token-cache   Do not read or write ~/.cache/healthy-alert-token.json
  --profile          Browser profile with Healthy login state
  --tool-dir         Local Playwright tool dir, defaults to ~/tools/lexiao-browser
`);
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveBaseUrl(args) {
  if (args['base-url']) return String(args['base-url']).replace(/\/+$/, '');
  const env = String(args.env || 'prod').toLowerCase();
  const base = BASE_URLS[env];
  if (!base) throw new Error(`Unknown env: ${args.env}`);
  return base;
}

function resolveAlertId(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return text;
  const match = text.match(/alert-show-detail\/(\d+)/);
  if (match) return match[1];
  throw new Error(`Cannot resolve alert id from: ${value}`);
}

function parseDuration(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] || 's';
  const multipliers = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
  return amount * multipliers[unit];
}

function fmtTime(epoch) {
  if (!epoch) return '-';
  return new Date(Number(epoch) * 1000).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function fmtDurationSec(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function fmtLogTime(epoch, padSec = 0) {
  if (!epoch) return '-';
  const shifted = (Number(epoch) + padSec + LOG_TZ_OFFSET_HOURS * 3600) * 1000;
  return new Date(shifted).toISOString().replace('T', ' ').replace(/\..+Z$/, '');
}

const SEVERITY_TEXT = { 1: '1-紧急', 2: '2-严重', 3: '3-普通' };

/* ---------- auth ---------- */

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
    throw new Error(`Playwright tool dir not found: ${paths.toolDir}`);
  }
  return createRequire(paths.playwrightPackage)('playwright').chromium;
}

// Opening the alert page also lets the SPA run its /auth/refresh, so an expired
// access_token in the profile is renewed before we read it back.
async function extractAuthFromProfile(args, baseUrl, alertId) {
  const paths = resolvePaths(args);
  const chromium = loadPlaywright(paths);
  const ldLibraryPath = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const context = await chromium.launchPersistentContext(paths.profileDir, {
    executablePath: paths.chromePath,
    headless: true,
    env: { ...process.env, LD_LIBRARY_PATH: ldLibraryPath },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    const authUrl = args['auth-url'] || `${baseUrl}/alert-show-detail/${alertId}`;
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const auth = await page.evaluate(() => {
      const keys = Object.keys(localStorage);
      const tokenKey = keys.find((key) => /access.?token|token/i.test(key) && localStorage.getItem(key));
      const ticketKey = keys.find((key) => /ticket/i.test(key) && localStorage.getItem(key));
      return {
        token: tokenKey ? localStorage.getItem(tokenKey) : '',
        ticket: ticketKey ? localStorage.getItem(ticketKey) : '',
        title: document.title,
        snippet: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 200),
      };
    });
    if (!auth.token) {
      throw new Error(`No access token in profile. Page title=${auth.title}, snippet=${auth.snippet}`);
    }
    return { token: auth.token, ticket: auth.ticket || '' };
  } finally {
    await context.close().catch(() => {});
  }
}

function readTokenCache(baseUrl, args) {
  if (args['no-token-cache']) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'))[baseUrl];
    if (entry && entry.token) return { token: entry.token, ticket: entry.ticket || '', fromCache: true };
  } catch (error) {
    // no usable cache yet
  }
  return null;
}

function writeTokenCache(baseUrl, auth, args) {
  if (args['no-token-cache']) return;
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
  } catch (error) {
    all = {};
  }
  all[baseUrl] = { token: auth.token, ticket: auth.ticket || '', cachedAt: Math.floor(Date.now() / 1000) };
  try {
    fs.mkdirSync(path.dirname(TOKEN_CACHE_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(all), { mode: 0o600 });
    fs.chmodSync(TOKEN_CACHE_FILE, 0o600);
  } catch (error) {
    // caching is best effort, never fail the query because of it
  }
}

async function resolveAuth(args, baseUrl, alertId) {
  const token = args.token || process.env.HEALTHY_METRIC_TOKEN;
  if (token) return { token, ticket: args.ticket || '' };
  const cached = readTokenCache(baseUrl, args);
  if (cached) return cached;
  const fresh = await extractAuthFromProfile(args, baseUrl, alertId);
  writeTokenCache(baseUrl, fresh, args);
  return fresh;
}

function authHeaders(auth, args) {
  const headers = {
    accept: 'application/json',
    'x-cluster': args.cluster || DEFAULT_CLUSTER,
    'x-language': args.language || DEFAULT_LANGUAGE,
  };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth.ticket) headers.ticket = auth.ticket;
  return headers;
}

function redactUrl(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

async function requestJson(url, auth, args, redirectsLeft = 3) {
  const response = await fetch(url, { headers: authHeaders(auth, args), redirect: 'manual' });
  if ([301, 302, 307, 308].includes(response.status) && response.headers.get('location') && redirectsLeft > 0) {
    const nextUrl = new URL(response.headers.get('location'), url).toString();
    return requestJson(nextUrl, auth, args, redirectsLeft - 1);
  }
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`GET ${redactUrl(url)} returned non-json status=${response.status}: ${text.slice(0, 200)}`);
  }
  if (!response.ok || json.err) {
    throw new Error(`GET ${redactUrl(url)} failed status=${response.status} err=${json.err || ''}`);
  }
  return json;
}

/* ---------- metric -> code hints ---------- */

function extractMetricName(promQl) {
  const text = String(promQl || '');
  const candidates = [];
  const re = /([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(?=[{[])/g;
  let match = re.exec(text);
  while (match) {
    if (!PROMQL_FUNCTIONS.has(match[1])) candidates.push(match[1]);
    match = re.exec(text);
  }
  if (candidates.length) return candidates[0];
  const bare = text.match(/\b(fql_[a-zA-Z0-9_]+)\b/);
  return bare ? bare[1] : '';
}

function tagsToMap(tags) {
  const map = {};
  for (const item of tags || []) {
    const idx = String(item).indexOf('=');
    if (idx > 0) map[String(item).slice(0, idx)] = String(item).slice(idx + 1);
  }
  return map;
}

// fql_fk_<app_snake>_<infix>_<suffix> -> infix, e.g. nodeRoute.
// The infix is what the reporting-constant file spells as a string literal.
function deriveMetricInfix(metric, appSnake) {
  let rest = String(metric || '');
  if (!rest) return { infix: '', suffix: '', stripped: '' };
  rest = rest.replace(/^fql_(fk_)?/, '');
  if (appSnake && rest.startsWith(`${appSnake}_`)) rest = rest.slice(appSnake.length + 1);
  let suffix = '';
  for (const candidate of METRIC_SUFFIXES) {
    if (rest.endsWith(`_${candidate}`)) {
      suffix = candidate;
      rest = rest.slice(0, -(candidate.length + 1));
      break;
    }
  }
  return { infix: rest, suffix, stripped: rest };
}

function countJavaFiles(dir, limit = 40) {
  let total = 0;
  const stack = [dir];
  while (stack.length && total < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'target' || entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.java')) {
        total += 1;
        if (total >= limit) break;
      }
    }
  }
  return total;
}

// An app repo may be a thin launcher (only Main.java); the reported metric then
// lives in a sibling repo of the same group, so siblings are reported too.
function findCandidateRepos(codeRoot, appNames) {
  const root = expandHome(codeRoot);
  const wanted = new Set();
  for (const name of appNames) {
    if (!name) continue;
    wanted.add(name);
    wanted.add(name.replace(/-/g, '_'));
    wanted.add(name.replace(/_/g, '-'));
  }
  const hits = [];
  const groups = new Set();
  const scan = (dir, depth) => {
    if (depth > 2) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (wanted.has(entry.name)) {
        const javaFiles = countJavaFiles(full);
        hits.push({ path: full, javaFiles, thin: javaFiles < 10 });
        groups.add(dir);
      }
      scan(full, depth + 1);
    }
  };
  scan(root, 0);
  const siblings = [];
  for (const group of groups) {
    let entries = [];
    try {
      entries = fs.readdirSync(group, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const full = path.join(group, entry.name);
      if (!hits.some((hit) => hit.path === full)) siblings.push(full);
    }
  }
  return { hits, siblings, groups: [...groups] };
}

function gitBaseline(repoPath) {
  const { execFileSync } = require('child_process');
  const run = (cmdArgs) => {
    try {
      return execFileSync('git', ['-C', repoPath, ...cmdArgs], { encoding: 'utf8', timeout: 10000 }).trim();
    } catch (error) {
      return '';
    }
  };
  return {
    branch: run(['branch', '--show-current']),
    head: run(['log', '-1', '--format=%h %ad', '--date=short']),
    remote: run(['remote', 'get-url', 'origin']),
  };
}

function buildCodeHints(event, args) {
  const tags = tagsToMap(event.tags);
  const metric = extractMetricName(event.prom_ql);
  const app = event.instance_name || (event.apps && event.apps[0]) || tags.instanceName || '';
  const appSnake = app.replace(/-/g, '_');
  const { infix, suffix } = deriveMetricInfix(metric, appSnake);
  const repos = args['code-root'] === false
    ? { hits: [], siblings: [], groups: [] }
    : findCandidateRepos(args['code-root'] || DEFAULT_CODE_ROOT, [app, appSnake]);
  const baselines = repos.hits.map((hit) => ({ ...hit, git: gitBaseline(hit.path) }));
  const searchTerms = [infix, tags.type, tags.module].filter(Boolean);
  return {
    metric,
    app,
    infix,
    suffix,
    module: tags.module || '',
    method: tags.method || '',
    type: tags.type || '',
    repos: baselines,
    siblings: repos.siblings,
    searchTerms,
    commands: [
      infix ? `rg -n '"${infix}"' --glob '*.java' <repo>   # locate the reporting constant` : '',
      tags.module ? `rg -n 'class ${tags.module}' --glob '*.java' <repo>` : '',
      tags.type ? `rg -n '${tags.type}' --glob '*.java' <repo>   # the tag literal at the report site` : '',
    ].filter(Boolean),
  };
}

/* ---------- replay ---------- */

function promRangeUrl(baseUrl, query, start, end, step) {
  const url = new URL('/api/n9e/prometheus/api/v1/query_range', baseUrl);
  url.searchParams.set('query', query);
  url.searchParams.set('start', String(start));
  url.searchParams.set('end', String(end));
  url.searchParams.set('step', step);
  return url.toString();
}

function labelSummary(labels) {
  const keep = ['ident', 'instanceName', 'env', 'set', 'method', 'type', 'module'];
  return keep.filter((key) => labels[key]).map((key) => `${key}=${labels[key]}`).join(' ');
}

async function replayPromQl(event, baseUrl, auth, args, opts = {}) {
  const windowSec = opts.windowSec !== undefined ? opts.windowSec : parseDuration(args.window || DEFAULT_WINDOW);
  const trigger = Number(event.trigger_time || 0);
  const end = Number(event.recover_time || event.last_eval_time || trigger) + windowSec;
  const start = trigger - windowSec;
  const step = opts.step || args.step || DEFAULT_STEP;
  const url = promRangeUrl(baseUrl, event.prom_ql, start, end, step);
  const json = await requestJson(url, auth, args);
  const result = (json.data && json.data.result) || [];
  const series = result.map((item) => {
    const values = item.values || [];
    const numeric = values.map((pair) => Number(pair[1])).filter((value) => Number.isFinite(value));
    return {
      labels: labelSummary(item.metric || {}),
      points: values.length,
      max: numeric.length ? Math.max(...numeric) : null,
      firstAt: values.length ? Number(values[0][0]) : null,
      lastAt: values.length ? Number(values[values.length - 1][0]) : null,
    };
  });
  return {
    label: opts.label || 'alert window',
    stepInflated: Boolean(opts.stepInflated),
    start,
    end,
    step,
    seriesCount: series.length,
    // The alert condition is already a boolean-ish expression, so every returned
    // point is a moment the rule would have fired.
    firingPoints: series.reduce((acc, item) => acc + item.points, 0),
    multiSeries: series.length > 1,
    series,
  };
}

// tags.origins tells VM from container. Bastion `go` cannot reach a pod IP and the
// physical host is usually not grantable, so containers must go through WebShell.
function buildAccessHint(event, args) {
  const tags = tagsToMap(event.tags);
  const origins = (tags.origins || '').toLowerCase();
  const ip = event.target_ident || tags.ident || '';
  const app = event.instance_name || (event.apps || [])[0] || '';
  const pad = parseDuration(args['log-pad'] || '10m');
  const from = fmtLogTime(event.trigger_time, -pad);
  const to = fmtLogTime(event.recover_time || event.last_eval_time || event.trigger_time, pad);
  const traceIds = (event.trace_data || [])
    .map((item) => (item.labels && item.labels.traceId) || item.traceId)
    .filter(Boolean);
  const container = origins === 'k8s' || origins === 'k8s-pod' || origins === 'container';
  const command = container
    ? [
      'node /home/joney/projects/ai/agent-tools/skills/lexin/java-server-diagnostics/scripts/container_log_check.js \\',
      `  --app=${app} --env=${event.env || 'prod'} --ip=${ip} \\`,
      `  --profile=${WEBSHELL_PROFILE} \\`,
      '  --log-mode=forensics --keyword="<from L3>" \\',
      '  --files=warn.log,info.log --include-rotated --context=2 \\',
      `  --from="${from}" --to="${to}"`,
    ]
    : [
      `# VM/KVM: java_app_diag or bastion to ${ip}`,
      `grep -B2 -A2 "<from L3>" /home/product/logs/${app}_logs/warn.log`,
      `# also grep info_YYYYMMDDHH.0.log for the same traceId: storage keys are logged at INFO`,
      `# window ${from} ~ ${to}`,
    ];
  return { origins: tags.origins || '-', container, ip, app, from, to, traceIds, command };
}

function renderAccessHint(hint) {
  if (!hint) return '';
  const lines = [
    '',
    '== L5 log access ==',
    `origins         ${hint.origins}  ->  ${hint.container ? 'container: WebShell (bastion go cannot reach a pod IP)' : 'VM/KVM: java_app_diag or bastion'}`,
    `log window      ${hint.from} ~ ${hint.to}   (UTC+${LOG_TZ_OFFSET_HOURS}, already converted from the UTC alert time)`,
  ];
  if (hint.traceIds.length) lines.push(`traceId         ${hint.traceIds.join(', ')}`);
  lines.push('  ! --files must match the log level at the report site (log.warn -> warn.log, not error.log)');
  lines.push('  ! keep --context>=2: the root cause is usually the ERROR line right before the match');
  lines.push('  ! info.log rotates hourly -> --include-rotated, or matchedFiles comes back empty');
  lines.push('  ! matchedFiles=[] means no file matched (rotation/name), not \"keyword absent\"');
  lines.push('command');
  for (const item of hint.command) lines.push(`  ${item}`);
  return lines.join('\n');
}

/* ---------- render ---------- */

function renderEvent(event) {
  const tags = tagsToMap(event.tags);
  const duration = event.recover_time && event.trigger_time
    ? Number(event.recover_time) - Number(event.trigger_time)
    : null;
  const lines = [
    '== L0 alert event ==',
    `id              ${event.id}`,
    `rule            [${event.rule_id}] ${event.rule_name}`,
    `group           ${event.group_name || '-'} / ${event.business_line || '-'}`,
    `severity        ${SEVERITY_TEXT[event.severity] || event.severity}`,
    `state           ${event.is_recovered ? 'recovered' : 'FIRING'}${event.is_claim ? ' (claimed)' : ''}`,
    `trigger_time    ${fmtTime(event.trigger_time)}  value=${event.trigger_value}`,
    `first_trigger   ${fmtTime(event.first_trigger_time)}`,
    `recover_time    ${fmtTime(event.recover_time)}`,
    `duration        ${duration === null ? '-' : fmtDurationSec(duration)}`,
    `app             ${event.instance_name || '-'}  (apps=${(event.apps || []).join(',') || '-'})`,
    `target_ident    ${event.target_ident || tags.ident || '-'}`,
    `env / set       ${event.env || '-'} / ${event.set || '-'}`,
    `app_owner       ${event.app_owner || '-'}`,
    `notify          ${(event.notify_channels || []).join(',') || '-'}`,
    `prom_ql         ${event.prom_ql}`,
    `for / eval      ${event.prom_for_duration}s / ${event.prom_eval_interval}s`,
  ];
  const traces = (event.trace_data || [])
    .map((item) => `  traceId=${(item.labels && item.labels.traceId) || item.traceId || '-'} value=${item.value} at=${fmtTime(item.timestamp)}`);
  if (traces.length) lines.push('trace_data', ...traces);
  const tagLine = Object.entries(tags).map(([key, value]) => `${key}=${value}`).join(' ');
  lines.push(`tags            ${tagLine}`);
  return lines.join('\n');
}

function renderRule(rule) {
  if (!rule) return '';
  const days = (rule.enable_days_of_week || []).join(',');
  return [
    '',
    '== L1 alert rule ==',
    `id / name       [${rule.id}] ${rule.name}`,
    `disabled        ${rule.disabled ? 'YES' : 'no'}`,
    `severity        ${SEVERITY_TEXT[rule.severity] || rule.severity}`,
    `for / eval      ${rule.prom_for_duration}s / ${rule.prom_eval_interval}s`,
    `condition_mode  ${rule.conditionMode || '-'}`,
    `effective       ${rule.enable_stime || '-'}~${rule.enable_etime || '-'} days=[${days}]`,
    `notify_repeat   ${rule.notify_repeat_step}min  max_number=${rule.notify_max_number}`,
    `notify_recover  ${rule.notify_recovered ? 'yes' : 'no'}  recover_duration=${rule.recover_duration}s`,
    `runbook         ${rule.runbook_url || '-'}`,
    `updated         ${rule.update_by || '-'} at ${fmtTime(rule.update_at)}`,
    `prom_ql         ${rule.prom_ql}`,
  ].join('\n');
}

function renderReplay(replay) {
  if (!replay) return '';
  const lines = [
    '',
    `== L2 promql replay (${replay.label}) ==`,
    `window          ${fmtTime(replay.start)} ~ ${fmtTime(replay.end)}  step=${replay.step}`,
    `series_count    ${replay.seriesCount}`,
    `firing_points   ${replay.firingPoints}   (each point = one evaluation matching the alert condition)`,
  ];
  for (const item of replay.series) {
    lines.push(`  - ${item.labels || '(no labels)'}`);
    lines.push(`    points=${item.points} max=${item.max} first=${fmtTime(item.firstAt)} last=${fmtTime(item.lastAt)}`);
  }
  if (replay.multiSeries) {
    lines.push('  ! multiple series returned: the alert fired on more than one reporting instance,');
    lines.push('    aggregate with sum() before reading a total.');
  }
  if (replay.stepInflated) {
    lines.push('  ! step is larger than the rule eval interval: several firings collapse into one');
    lines.push('    point, so read firing_points as "at least N".');
  }
  return lines.join('\n');
}

function renderCodeHints(hints) {
  if (!hints) return '';
  const lines = [
    '',
    '== L3 metric -> code ==',
    `metric          ${hints.metric || '-'}`,
    `infix / suffix  ${hints.infix || '-'} / ${hints.suffix || '-'}`,
    `module (class)  ${hints.module || '-'}`,
    `method (tag)    ${hints.method || '-'}   ! tag value comes from a constant, it may differ from the Java method name`,
    `type (branch)   ${hints.type || '-'}`,
  ];
  if (hints.repos.length) {
    lines.push('candidate repos');
    for (const repo of hints.repos) {
      lines.push(`  - ${repo.path}  java_files>=${repo.javaFiles}${repo.thin ? '  ! thin launcher, search sibling repos' : ''}`);
      lines.push(`    baseline: branch=${repo.git.branch || '-'} head=${repo.git.head || '-'}`);
    }
  } else {
    lines.push('candidate repos  none found locally -> report the code baseline as missing, do not guess');
  }
  if (hints.siblings.length) {
    lines.push(`sibling repos    ${hints.siblings.length} in same group: ${hints.siblings.slice(0, 12).map((item) => path.basename(item)).join(', ')}`);
  }
  if (hints.commands.length) {
    lines.push('search commands');
    for (const command of hints.commands) lines.push(`  ${command}`);
  }
  return lines.join('\n');
}

/* ---------- main ---------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }

  if (args['code-hint-only']) {
    const fakeEvent = {
      prom_ql: args.metric ? `${args.metric}{}` : '',
      instance_name: args.app || '',
      apps: args.app ? [args.app] : [],
      tags: [],
    };
    const hints = buildCodeHints(fakeEvent, args);
    console.log(args.format === 'json' ? JSON.stringify(hints, null, 2) : renderCodeHints(hints).trimStart());
    return;
  }

  if (!args.alert) {
    usage();
    throw new Error('--alert is required');
  }

  const baseUrl = resolveBaseUrl(args);
  const alertId = resolveAlertId(args.alert);
  let auth = await resolveAuth(args, baseUrl, alertId);

  const detailUrl = `${baseUrl}/api/n9e/alert-show-detail/${alertId}`;
  let detail;
  try {
    detail = await requestJson(detailUrl, auth, args);
  } catch (error) {
    if (!auth.fromCache) throw error;
    // A cached token can be expired or revoked; fall back to the browser once.
    auth = await extractAuthFromProfile(args, baseUrl, alertId);
    writeTokenCache(baseUrl, auth, args);
    detail = await requestJson(detailUrl, auth, args);
  }
  const list = (detail.dat && detail.dat.list) || [];
  if (!list.length) throw new Error(`Alert ${alertId} returned an empty event list`);

  const output = { alertId, env: args.env || 'prod', events: [] };
  const chunks = [];
  if (list.length > 1) chunks.push(`# alert ${alertId} contains ${list.length} events`);

  for (const event of list) {
    const record = { event };
    chunks.push(renderEvent(event));

    if (args['with-rule'] && event.rule_id) {
      try {
        const ruleJson = await requestJson(`${baseUrl}/api/n9e/alert-rule/${event.rule_id}`, auth, args);
        record.rule = ruleJson.dat || null;
        chunks.push(renderRule(record.rule));
      } catch (error) {
        record.ruleError = error.message;
        chunks.push(`\n== L1 alert rule ==\nerror: ${error.message}`);
      }
    }

    if (args.replay && event.prom_ql) {
      // Two windows in one browser session: the alert window answers "spike or
      // sustained", the baseline answers "one-off or recurring, one instance or
      // many". Reading only the narrow window has already produced a wrong
      // single-instance conclusion once.
      const passes = [{ label: 'alert window' }];
      if (args.baseline !== 'off') {
        const baselineSec = parseDuration(args.baseline || DEFAULT_BASELINE);
        const baselineStep = args['baseline-step'] || DEFAULT_BASELINE_STEP;
        passes.push({
          label: `baseline ${args.baseline || DEFAULT_BASELINE}`,
          windowSec: baselineSec,
          step: baselineStep,
          stepInflated: parseDuration(baselineStep) > Number(event.prom_eval_interval || 60),
        });
      }
      record.replays = [];
      for (const pass of passes) {
        try {
          const replay = await replayPromQl(event, baseUrl, auth, args, pass);
          record.replays.push(replay);
          chunks.push(renderReplay(replay));
        } catch (error) {
          record.replays.push({ label: pass.label, error: error.message });
          chunks.push(`\n== L2 promql replay (${pass.label}) ==\nerror: ${error.message}`);
        }
      }
    }

    if (!args['no-code-hint']) {
      record.codeHints = buildCodeHints(event, args);
      chunks.push(renderCodeHints(record.codeHints));
    }

    record.accessHint = buildAccessHint(event, args);
    chunks.push(renderAccessHint(record.accessHint));

    output.events.push(record);
  }

  if (args.format === 'json') {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(chunks.join('\n'));
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
