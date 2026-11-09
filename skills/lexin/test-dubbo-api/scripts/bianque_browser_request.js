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
const { createRequire } = require('module');
const { skillDir, browserRuntime } = require(path.join(root, 'lib/agent_tools/locate.js'));
const SESSION_SCRIPTS = skillDir('get-browser-session', 'scripts');
const { launchLockedContext } = require(path.join(SESSION_SCRIPTS, 'browser_session'));
const sessionCache = require(path.join(SESSION_SCRIPTS, 'session_cache'));

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
    const equalsIndex = item.indexOf('=');
    if (equalsIndex !== -1) {
      args[item.slice(2, equalsIndex)] = item.slice(equalsIndex + 1);
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args[item.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      args[item.slice(2)] = true;
    }
  }
  return args;
}

function resolvePaths(args) {
  // 工具目录、Chromium 与运行库只经 browserRuntime() 取；--tool-dir 通过 BROWSER_SESSION_TOOL_DIR 传给它。
  if (args['tool-dir']) process.env.BROWSER_SESSION_TOOL_DIR = expandHome(args['tool-dir']);
  const runtime = browserRuntime();
  return {
    toolDir: runtime.toolDir,
    profileDir: expandHome(
      args.profile
      || process.env.BROWSER_SESSION_PROFILE
      || process.env.DEVTOOLS_BROWSER_PROFILE
      || '~/.local/state/agent-tools/browser-profiles/main'
    ),
    chromePath: expandHome(args.chrome) || runtime.executablePath,
    runtimeLibDir: expandHome(args['runtime-lib-dir']) || runtime.runtimeLibDir,
    playwrightPackage: path.join(runtime.toolDir, 'package.json'),
  };
}

function loadPlaywright(paths) {
  if (!fs.existsSync(paths.playwrightPackage)) {
    throw new Error(`missing Playwright tool dir: ${paths.toolDir}`);
  }
  if (!fs.existsSync(paths.chromePath)) {
    throw new Error(`missing Chrome executable: ${paths.chromePath}`);
  }
  const requireFromTool = createRequire(paths.playwrightPackage);
  return requireFromTool('playwright').chromium;
}

function required(args, name) {
  const value = args[name];
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolvePaths(args);
  const chromium = loadPlaywright(paths);
  const baseUrl = required(args, 'base-url').replace(/\/+$/, '');
  const routeEnv = required(args, 'route-env');
  const bianqueEnv = required(args, 'env');
  const service = required(args, 'service');
  const method = required(args, 'method');
  const ip = required(args, 'ip');
  const port = required(args, 'port');
  const group = args.group || 'default';
  const version = args.version || '2.0.0';
  const params = args.params || '[]';
  const timeoutMs = Number(args['timeout-ms'] || 120000);
  const form = { env: bianqueEnv, service, ip, port, group, version, method, params, comment: '', stringFlag: 'false' };
  const requestUrl = `${baseUrl}/serviceEmulator/request`;

  // Cache hit: post straight from Node and skip Chromium (and the profile lock) entirely.
  // The Dubbo method may write, so only a clear login rejection (request never ran) falls back to
  // the browser; timeouts and HTTP errors are reported instead of being re-sent.
  const cookieHeader = sessionCache.readCookieHeader(paths.profileDir, requestUrl);
  if (cookieHeader) {
    const result = await sessionCache.fetchWithCookies(cookieHeader, requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(form).toString(),
      timeoutMs,
      referer: `${baseUrl}/`,
    });
    if (!sessionCache.looksUnauthenticated(result)) {
      if (!result.ok) {
        throw new Error(`Bianque request failed: HTTP ${result.status} ${result.text.slice(0, 500)}`);
      }
      console.log(result.text);
      return;
    }
    sessionCache.invalidate(paths.profileDir, requestUrl);
  }

  const ldLibraryPath = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

  const context = await launchLockedContext(chromium, paths.profileDir, {
    executablePath: paths.chromePath,
    headless: !args.headed,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: ldLibraryPath,
      NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || '.fenqile.com,.lexinfintech.com,.lexincloud.com,localhost,127.0.0.1',
      no_proxy: process.env.no_proxy || process.env.NO_PROXY || '.fenqile.com,.lexinfintech.com,.lexincloud.com,localhost,127.0.0.1',
    },
    args: ['--no-sandbox', '--no-proxy-server'],
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    const route = `${baseUrl}/#/serviceEmulator/${encodeURIComponent(routeEnv)}/${encodeURIComponent(service)}/${encodeURIComponent(ip)}/${encodeURIComponent(port)}/${encodeURIComponent(group)}/${encodeURIComponent(version)}`;
    await page.goto(route, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 20000) }).catch(() => {});
    const result = await page.evaluate(async ({ form, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const body = new URLSearchParams(form);
        const response = await fetch('/serviceEmulator/request', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body,
          signal: controller.signal,
        });
        return {
          status: response.status,
          ok: response.ok,
          text: await response.text(),
        };
      } finally {
        clearTimeout(timer);
      }
    }, { form, timeoutMs });

    if (!result.ok) {
      throw new Error(`Bianque request failed: HTTP ${result.status} ${result.text.slice(0, 500)}`);
    }
    await sessionCache.saveContextCookies(context, paths.profileDir, requestUrl);
    console.log(result.text);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
