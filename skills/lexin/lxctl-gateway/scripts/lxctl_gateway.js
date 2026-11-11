#!/usr/bin/env node
// agent-tools bootstrap（模板 lib/agent_tools/bootstrap.js，lint 规则六校验逐字一致）
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
// probe 返回 'hit' | 'miss' | <异常码>：与 locate.py 同序先看 install.py（缺失即 miss），再看 skills/；用会抛错的 statSync，不用对一切错误都返回 false 的 existsSync
const probe = (d) => { if (!d) return 'miss'; try { const i = fs.statSync(path.join(d, 'install.py'), { throwIfNoEntry: false }); if (!i || !i.isFile()) return 'miss'; const s = fs.statSync(path.join(d, 'skills'), { throwIfNoEntry: false }); return s && s.isDirectory() ? 'hit' : 'miss'; } catch (e) { return e.code || 'error'; } };
const tried = []; let root = '', r = 'miss';
try { let d = fs.realpathSync(__dirname); tried.push(`上溯起点 ${d}`); while ((r = probe(d)) === 'miss' && path.dirname(d) !== d) d = path.dirname(d); if (r === 'hit') root = d; else tried[0] += r === 'miss' ? ' 未命中有效根（install.py 文件 + skills/ 目录）' : ` ${r}（放弃上溯）`; }
catch (e) { tried.push(`上溯起点 ${__dirname} ${e.code || e.message}`); }
if (!root) { const v = process.env.AGENT_TOOLS_ROOT || ''; r = probe(v); tried.push(`AGENT_TOOLS_ROOT=${v || '<unset>'}${r === 'hit' || r === 'miss' ? '' : ' ' + r}`); if (r === 'hit') root = v; }
if (!root) { const p = path.join(os.homedir(), '.config/agent-tools/root'); try { const v = fs.readFileSync(p, 'utf8').trim(); r = probe(v); tried.push(`${p} = ${v}${r === 'hit' || r === 'miss' ? '' : ' ' + r}`); if (r === 'hit') root = v; } catch (e) { tried.push(`${p} ${e.code === 'ENOENT' ? '<absent>' : e.code}`); } }
if (!root) { console.error(['agent-tools: 未找到仓库根', ...tried, '请在仓库目录运行 python3 install.py'].join('\n')); process.exit(2); }
// agent-tools bootstrap end
const { spawnSync } = require('node:child_process');

// OA AI gateway client shared by skills (logs, monitoring, registry...). It reuses the OAuth2 token that the
// company CLI `lxctl auth login` stores in ~/.lxctl/tokens.json and calls the gateway over HTTPS directly, so
// callers get their own timeout, retries and structured errors instead of lxctl's fixed 30 s / text output.
// The token is never printed.
const LXCTL_HOME = process.env.LXCTL_HOME || path.join(os.homedir(), '.lxctl');
const TOKEN_FILE = path.join(LXCTL_HOME, 'tokens.json');
const CONFIG_FILE = path.join(LXCTL_HOME, 'config.json');
const DEFAULTS = {
  gatewayUrl: 'https://gateway.oa.fenqile.com',
  contextPath: '/rc_oa_gateway',
  accessPrefix: '/jiagouzhongxin',
  callerChannel: 'lxctl',
  callerInstance: 'lxctl-cli-instance',
};
const INSTALL_HINT = 'npm install -g @lx/lxctl --registry=http://registry.npm.frd.fenqile.com && lxctl config init --new && lxctl auth login';
// Gateway-level retcodes (strings starting with 16051); upstream services use their own retcode (0 / -1 ...).
const RETCODE_TOKEN_REJECTED = '16051001'; // "B端应用请求缺少 X-User-Min Header": the bearer token was not resolved to a user
const RETCODE_FORBIDDEN = '16051009'; // "抱歉，您暂无权限访问": X-AI-AppId is not authorised for this path
const RETCODE_UPSTREAM_HTTP = '16051000'; // "HTTP 调用失败，状态码：502": the service behind the gateway failed
const TRANSIENT_HTTP = new Set([502, 503, 504]);

class GatewayError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function gatewayBase() {
  const config = readJsonFile(CONFIG_FILE) || {};
  const url = String(config.gateway_url || DEFAULTS.gatewayUrl).replace(/\/+$/, '');
  return url + (config.gateway_context_path || DEFAULTS.contextPath) + (config.gateway_access_prefix || DEFAULTS.accessPrefix);
}

function decodeClaims(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')); } catch (_) { return {}; }
}

// { accessToken, userMin } or null when the user never logged in on this machine.
function readToken() {
  const token = readJsonFile(TOKEN_FILE);
  if (!token || !token.access_token) return null;
  return { accessToken: token.access_token, userMin: decodeClaims(token.id_token).userMin || '' };
}

function lxctlVersion() {
  const run = spawnSync('lxctl', ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (run.error || run.status !== 0) return '';
  const match = String(run.stdout).match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : 'unknown';
}

// `lxctl auth refresh` exchanges the refresh_token without a browser (verified 2026-11-11).
function refreshToken() {
  const run = spawnSync('lxctl', ['auth', 'refresh'], { encoding: 'utf8', timeout: 60000 });
  if (run.error && run.error.code === 'ENOENT') return { ok: false, reason: 'lxctl is not installed' };
  return run.status === 0 ? { ok: true } : { ok: false, reason: 'lxctl auth refresh failed (refresh token expired?)' };
}

function isTransient(error) {
  if (!error) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const code = (error.cause && error.cause.code) || error.code || '';
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|EPIPE/.test(String(code)) || /fetch failed|socket|TLS/i.test(String(error.message));
}

function buildUrl(base, apiPath, query) {
  const url = new URL(base + (apiPath.startsWith('/') ? apiPath : `/${apiPath}`));
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

// Calls <gateway><path> as the logged-in user and returns the parsed JSON body.
// Retries transient failures (network, timeout, 502/503/504, gateway "upstream HTTP failed"); on a rejected token
// refreshes once through lxctl and retries. Throws GatewayError with code:
//   NOT_LOGGED_IN | TOKEN_REJECTED | FORBIDDEN | UPSTREAM_FAILED | NETWORK | BAD_RESPONSE
// deps is for tests: { fetchImpl, readTokenImpl, refreshImpl, sleepImpl }.
async function callGateway(request, deps = {}) {
  const { method = 'GET', path: apiPath, appId, query, body, timeoutMs = 60000, retries = 2 } = request;
  if (!apiPath || !appId) throw new Error('callGateway needs path and appId');
  const fetchImpl = deps.fetchImpl || fetch;
  const readTokenImpl = deps.readTokenImpl || readToken;
  const refreshImpl = deps.refreshImpl || refreshToken;
  const sleepImpl = deps.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const url = buildUrl(deps.base || gatewayBase(), apiPath, query);

  let token = readTokenImpl();
  if (!token) throw new GatewayError('NOT_LOGGED_IN', `no lxctl token in ${TOKEN_FILE}; run: ${INSTALL_HINT}`);
  let refreshed = false;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleepImpl(1000 * attempt);
    let response;
    let text;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          'X-AI-AppId': appId,
          'X-AI-Caller-Channel': DEFAULTS.callerChannel,
          'X-AI-Caller-Instance': DEFAULTS.callerInstance,
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      if (!isTransient(error)) throw new GatewayError('NETWORK', `gateway request failed: ${error.message}`);
      lastError = new GatewayError('NETWORK', `gateway request failed after ${attempt + 1} attempt(s): ${error.name === 'TimeoutError' ? `no response within ${timeoutMs} ms` : error.message}`);
      continue;
    }
    if (TRANSIENT_HTTP.has(response.status)) {
      lastError = new GatewayError('UPSTREAM_FAILED', `gateway returned HTTP ${response.status}`, { httpStatus: response.status });
      continue;
    }
    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new GatewayError('BAD_RESPONSE', `gateway returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`, { httpStatus: response.status });
    }
    const retcode = String(json.retcode);
    if (response.status === 401 || retcode === RETCODE_TOKEN_REJECTED) {
      if (refreshed) throw new GatewayError('TOKEN_REJECTED', `gateway still rejects the token after a refresh; run: lxctl auth login (${json.retmsg || `HTTP ${response.status}`})`);
      const result = refreshImpl();
      refreshed = true;
      token = result.ok ? readTokenImpl() : null;
      if (!token) throw new GatewayError('TOKEN_REJECTED', `lxctl token expired and could not be refreshed (${result.reason || 'no token after refresh'}); run: lxctl auth login`);
      attempt -= 1; // the refresh does not consume a retry
      continue;
    }
    if (retcode === RETCODE_FORBIDDEN) {
      throw new GatewayError('FORBIDDEN', `gateway denied ${apiPath} for app id ${appId}: ${json.retmsg}`, { retcode });
    }
    if (retcode === RETCODE_UPSTREAM_HTTP) {
      lastError = new GatewayError('UPSTREAM_FAILED', `service behind the gateway failed: ${json.retmsg}`, { retcode });
      continue;
    }
    return json;
  }
  throw lastError;
}

// Prometheus instant query through 雷神 (/api/eye). Returns the Prometheus `data` object ({ resultType, result }).
async function eyeQuery(promql, options = {}, deps = {}) {
  const json = await callGateway({ path: '/api/eye', appId: 'eye', query: { query: promql }, timeoutMs: options.timeoutMs }, deps);
  const row = Array.isArray(json.resultRows) ? json.resultRows[0] : null;
  if (String(json.retcode) !== '0' || !row || row.status !== 'success') {
    throw new GatewayError('UPSTREAM_FAILED', `eye query failed: ${json.retmsg || (row && row.error) || 'unexpected response'}`);
  }
  return row.data;
}

function status() {
  const token = readToken();
  const tokenFile = readJsonFile(TOKEN_FILE);
  let tokenAgeSeconds = null;
  try { tokenAgeSeconds = Math.round((Date.now() - fs.statSync(TOKEN_FILE).mtimeMs) / 1000); } catch (_) { /* absent */ }
  const expiresIn = tokenFile && Number(tokenFile.expires_in);
  return {
    lxctlVersion: lxctlVersion() || null,
    tokenFile: TOKEN_FILE,
    loggedIn: Boolean(token),
    userMin: token ? token.userMin : '',
    tokenAgeSeconds,
    accessTokenExpired: tokenAgeSeconds !== null && Number.isFinite(expiresIn) ? tokenAgeSeconds >= expiresIn : null,
    gatewayBase: gatewayBase(),
    installHint: token ? undefined : INSTALL_HINT,
  };
}

function parseCli(argv) {
  const args = { _: [], query: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) { args._.push(item); continue; }
    const eq = item.indexOf('=');
    const key = eq === -1 ? item.slice(2) : item.slice(2, eq);
    let value = eq === -1 ? argv[index + 1] : item.slice(eq + 1);
    if (key === 'probe' || key === 'help') { args[key] = true; continue; }
    if (eq === -1) index += 1;
    if (value === undefined) throw new Error(`--${key} requires a value`);
    if (key === 'param') {
      const split = value.indexOf('=');
      if (split <= 0) throw new Error('--param expects key=value');
      args.query[value.slice(0, split)] = value.slice(split + 1);
    } else {
      args[key] = value;
    }
  }
  return args;
}

const USAGE = `Usage:
  lxctl_gateway.js doctor [--probe]                 install / login state; --probe also calls the gateway once
  lxctl_gateway.js call --path <api path> --app-id <X-AI-AppId> [--method GET|POST] [--param k=v]... [--body '<json>'] [--timeout <ms>]
  lxctl_gateway.js eye --query '<PromQL>' [--timeout <ms>]   Prometheus instant query via 雷神

Output is JSON on stdout. Exit codes: 0 ok, 1 error, 2 agent-tools root missing, 3 not logged in / token rejected.`;

async function main(argv) {
  const args = parseCli(argv);
  const command = args._[0];
  if (args.help || !command) { console.log(USAGE); return command ? 0 : 1; }
  const timeoutMs = args.timeout ? Number(args.timeout) : undefined;
  if (command === 'doctor') {
    const report = status();
    if (args.probe && report.loggedIn) {
      try {
        const data = await eyeQuery('count(up)', { timeoutMs });
        report.probe = { ok: true, resultType: data.resultType };
      } catch (error) {
        report.probe = { ok: false, code: error.code || 'ERROR', message: error.message };
      }
    }
    console.log(JSON.stringify(report, null, 2));
    return report.loggedIn && (!report.probe || report.probe.ok) ? 0 : 3;
  }
  if (command === 'call') {
    const json = await callGateway({
      method: String(args.method || 'GET').toUpperCase(), path: args.path, appId: args['app-id'], query: args.query,
      body: args.body === undefined ? undefined : JSON.parse(args.body), timeoutMs,
    });
    console.log(JSON.stringify(json, null, 2));
    return 0;
  }
  if (command === 'eye') {
    const promql = args.promql;
    if (!promql) throw new Error("eye needs --query '<PromQL>'");
    console.log(JSON.stringify(await eyeQuery(promql, { timeoutMs }), null, 2));
    return 0;
  }
  throw new Error(`unknown command ${command}\n\n${USAGE}`);
}

if (require.main === module) {
  // `--query` is the PromQL for `eye`; keep it out of the generic key=value params.
  const argv = process.argv.slice(2).map((item) => (item === '--query' ? '--promql' : item.startsWith('--query=') ? `--promql=${item.slice(8)}` : item));
  main(argv).then((code) => process.exit(code)).catch((error) => {
    console.error(JSON.stringify({ error: error.message, code: error.code || 'ERROR' }, null, 2));
    process.exit(error.code === 'NOT_LOGGED_IN' || error.code === 'TOKEN_REJECTED' ? 3 : 1);
  });
}

module.exports = { GatewayError, INSTALL_HINT, TOKEN_FILE, buildUrl, callGateway, decodeClaims, eyeQuery, isTransient, parseCli, readToken, status };
