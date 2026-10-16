#!/usr/bin/env node
'use strict';

// 后端接口 / 网关 URL / MySQL 表 -> OA 网关规则 -> rc_fd 前端工程（product 分支）-> 线上页面地址。
// 只读：网关和 GitLab 只发查询请求；本地仓库只 clone/fetch，不切换已有工作区的分支。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');
const { acquireProfileLock, parseArgs, resolvePaths } = require('../../get-browser-session/scripts/browser_session');
const { buildBrowserEnv, chromiumArgsFor } = require('../../get-browser-session/scripts/browser_network');

const GATEWAY = 'https://gateway.oa.fenqile.com';
const GATEWAY_QUERY = `${GATEWAY}/rc_oa_gateway/application/url_interface_rule/query_page_list.json`;
const GITLAB = 'http://gitlab.fenqile.com';
const GITLAB_GROUP = 'rc_fd';
const GATEWAY_NOT_LOGGED_IN = '16051006';
const DEFAULT_FRONTEND_ROOT = '/home/joney/projects/frontend';
const DEFAULT_BACKEND_ROOT = '/home/joney/projects/backend';
const CACHE_FILE = path.join(os.homedir(), '.cache/agent-tools/locate-frontend-page/rc_fd-projects.json');
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const BRANCH = 'product';
const MAX_CLONES = 3;
const MAX_IMPORT_DEPTH = 8;
const MAX_TABLE_DEPTH = 6;

// ---------------------------------------------------------------- pure helpers

function str(value) {
  return value && value !== true ? String(value).trim() : '';
}

// 线上规则：域名不带 pre/stable/test/dev/gray/uat 环境段。
function isProdDomain(domain) {
  return Boolean(domain) && !/(^|[.-])(pre|stable|test|dev|gray|uat)([.-])/i.test(domain);
}

// 网关 url -> 前端代码里会出现的路径（拦截器统一补 rc_oa_gateway/ 前缀）。
function searchTerms(gatewayUrl) {
  let p = String(gatewayUrl || '').replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0].replace(/^\/+/, '');
  p = p.replace(/^rc_oa_gateway\//, '');
  const terms = new Set([p]);
  if (p.endsWith('.json')) terms.add(p.slice(0, -'.json'.length));
  return [...terms].filter(Boolean);
}

// grep 命中后排除 user_whitelist_page_v2 这类前缀误命中。
function lineHasTerm(line, term) {
  let from = 0;
  for (;;) {
    const at = line.indexOf(term, from);
    if (at === -1) return false;
    const next = line[at + term.length] || '';
    if (!/[\w-]/.test(next)) return true;
    from = at + 1;
  }
}

function normalizeRepoName(name) {
  return String(name).toLowerCase().replace(/[-_]/g, ' ').split(' ')
    .filter((part) => part && !['web', 'oa', 'fe'].includes(part)).join('');
}

// hawkeye.oa.fenqile.com -> hawkeye；精确匹配优先，其次包含匹配。
function rankRepos(domain, names) {
  const key = String(domain).split('.')[0].toLowerCase().replace(/[-_]/g, '');
  const exact = names.filter((n) => normalizeRepoName(n) === key);
  const partial = names.filter((n) => !exact.includes(n) && normalizeRepoName(n).includes(key));
  return [...exact, ...partial];
}

function kebab(segment) {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

// 多页面工程：src/modules/orderQuery/Index -> order-query/index.html（与已发布产物核对过的约定）。
function htmlPathForModule(moduleRel) {
  if (!moduleRel) return 'index.html';
  return `${moduleRel.split('/').map(kebab).join('/')}.html`;
}

function pageUrl(domain, htmlPath, route, historyMode) {
  const page = htmlPath === 'index.html' ? '' : htmlPath;
  if (!route) return `https://${domain}/${page}`;
  return historyMode ? `https://${domain}/${page.replace(/\.html$/, '')}${route}` : `https://${domain}/${page}#${route}`;
}

// 找离命中文件最近、含 main.js 的模块目录。
function findModule(file, fileSet) {
  let dir = path.posix.dirname(file);
  while (dir && dir !== '.' && dir !== '/') {
    if (fileSet.has(`${dir}/main.js`)) {
      const rel = dir.startsWith('src/modules/') ? dir.slice('src/modules/'.length) : (dir === 'src/modules' ? '' : null);
      return { dir, moduleRel: rel === null ? '' : rel };
    }
    if (dir === 'src') break;
    dir = path.posix.dirname(dir);
  }
  return { dir: 'src', moduleRel: '' };
}

function resolveImport(fromFile, spec, fileSet) {
  let base;
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  else return null;
  const candidates = [base, `${base}.vue`, `${base}.js`, `${base}/index.vue`, `${base}/index.js`];
  return candidates.find((c) => fileSet.has(c)) || null;
}

// 返回 [{ name, spec }]，覆盖 import X from '...'、const X = () => import('...')、require('...')。
function parseImports(source) {
  const out = [];
  const patterns = [
    /import\s+([\w$]+)[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:const|let|var)\s+([\w$]+)\s*=\s*\(?\s*\)?\s*=>\s*import\(\s*(?:\/\*[\s\S]*?\*\/\s*)?['"]([^'"]+)['"]/g,
    /import\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const [index, re] of patterns.entries()) {
    for (const m of source.matchAll(re)) {
      if (index < 2) out.push({ name: m[1], spec: m[2] });
      else out.push({ name: '', spec: m[1] });
    }
  }
  return out;
}

// 在路由文件里找 component 对应的 path；嵌套 children 时只给出叶子 path 并标注。
function findRoutePath(source, componentName) {
  const re = new RegExp(`component\\s*:\\s*${componentName.replace(/\$/g, '\\$')}\\b`, 'g');
  const routes = [];
  for (const m of source.matchAll(re)) {
    const before = source.slice(Math.max(0, m.index - 400), m.index);
    const objStart = before.lastIndexOf('{');
    const scope = objStart === -1 ? before : before.slice(objStart);
    const pathMatch = [...scope.matchAll(/path\s*:\s*['"`]([^'"`]*)['"`]/g)].pop();
    const after = source.slice(m.index, m.index + 400);
    const tail = after.slice(0, Math.max(0, after.indexOf('}')) || after.length);
    const pathAfter = pathMatch ? null : tail.match(/path\s*:\s*['"`]([^'"`]*)['"`]/);
    const value = pathMatch ? pathMatch[1] : (pathAfter ? pathAfter[1] : null);
    if (value !== null) routes.push({ path: value, nested: !value.startsWith('/') });
  }
  return routes;
}

function parseGatewayRows(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error('网关返回的不是 JSON'); }
  if (String(parsed.retcode) === GATEWAY_NOT_LOGGED_IN) {
    const error = new Error('网关返回未登录（16051006）；请求已带 Origin/Referer，请用 get-browser-session --ensure --url=https://gateway.oa.fenqile.com/ 刷新登录态');
    error.code = 'LOGIN_REQUIRED';
    throw error;
  }
  if (String(parsed.retcode) !== '0') throw new Error(`网关查询失败：retcode=${parsed.retcode} ${parsed.retmsg || ''}`);
  return { rows: parsed.result_rows || [], totalPage: Number(parsed.total_page || 1), total: Number(parsed.total_num || 0) };
}

function pickRule(row) {
  const keys = ['domain', 'url', 'protocol', 'interface_name', 'method', 'interface_version', 'lsf_app_name',
    'system_id', 'app_name', 'resource_sn', 'check_auth', 'modify_time'];
  return Object.fromEntries(keys.map((k) => [k, row[k]]));
}

function parseGroupProjects(html) {
  return [...new Set([...String(html).matchAll(new RegExp(`href="/${GITLAB_GROUP}/([\\w.-]+)"`, 'g'))].map((m) => m[1]))];
}

// ---------------------------------------------------------------- process helpers

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: options.timeout || 120000, cwd: options.cwd });
  return { code: result.status, stdout: result.stdout || '', stderr: (result.stderr || '') + (result.error ? String(result.error.message) : '') };
}

function git(repo, args, timeout) {
  return run('git', ['-C', repo, ...args], { timeout });
}

// ---------------------------------------------------------------- table -> interfaces (local code)

function javaClassName(file) {
  return path.basename(file, '.java');
}

// 用 grep 而不是 rg：本机 rg 只是 shell 函数，子进程里不可用。
function grepFiles(root, patterns, includes) {
  const args = ['-rlwF', '-s'];
  for (const p of patterns) args.push('-e', p);
  for (const g of includes) args.push(`--include=${g}`);
  for (const d of ['target', '.git', 'test', 'node_modules']) args.push(`--exclude-dir=${d}`);
  args.push(root);
  const result = run('grep', args, { timeout: 300000 });
  if (result.code !== 0 && result.code !== 1) throw new Error(`grep 失败：${result.stderr.trim().split('\n').pop()}`);
  return result.stdout.split('\n').filter(Boolean);
}

function gitRoot(file) {
  const r = git(path.dirname(file), ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.stdout.trim() : null;
}

function traceTable(table, backendRoot) {
  const hits = grepFiles(backendRoot, [table], ['*.xml', '*.java']);
  const byRepo = new Map();
  for (const file of hits) {
    const repo = gitRoot(file);
    if (!repo) continue;
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(file);
  }
  const repos = [];
  for (const [repo, files] of byRepo) {
    const seeds = new Set();
    for (const file of files) {
      if (file.endsWith('.java')) seeds.add(javaClassName(file));
      else {
        const ns = fs.readFileSync(file, 'utf8').match(/<mapper[^>]*namespace\s*=\s*"([^"]+)"/);
        if (ns) seeds.add(ns[1].split('.').pop());
      }
    }
    const visited = new Map(); // className -> file
    let frontier = [...seeds];
    for (let depth = 0; depth < MAX_TABLE_DEPTH && frontier.length; depth += 1) {
      const found = grepFiles(repo, frontier, ['*.java']);
      const next = [];
      for (const file of found) {
        const name = javaClassName(file);
        if (!visited.has(name)) { visited.set(name, file); next.push(name); }
      }
      frontier = next;
    }
    const providers = [];
    for (const xml of grepFiles(repo, ['dubbo:service'], ['*.xml'])) {
      for (const m of fs.readFileSync(xml, 'utf8').matchAll(/<dubbo:service[^>]*interface\s*=\s*"([^"]+)"/g)) providers.push(m[1]);
    }
    const interfaces = new Set();
    for (const file of visited.values()) {
      const impl = fs.readFileSync(file, 'utf8').match(/class\s+\w+[^{]*?implements\s+([^{]+)\{/);
      if (!impl) continue;
      const names = impl[1].split(',').map((s) => s.replace(/<.*$/, '').trim().split('.').pop());
      for (const fqn of providers) if (names.includes(fqn.split('.').pop())) interfaces.add(fqn);
    }
    const appProps = grepFiles(repo, ['application.name'], ['app.properties']);
    const apps = [...new Set(appProps.flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/^application\.name\s*=\s*(\S+)/gm)].map((m) => m[1])))];
    repos.push({
      repo, apps, tableFiles: files.map((f) => path.relative(repo, f)),
      visitedClasses: visited.size, interfaces: [...interfaces].sort(),
    });
  }
  return repos;
}

// ---------------------------------------------------------------- browser-backed queries

async function openContext(args) {
  const paths = resolvePaths(args, GATEWAY);
  const release = await acquireProfileLock(paths.profileDir, { timeoutMs: 60000, pollMs: 200 });
  try {
    const chromium = createRequire(paths.playwrightPackage)('playwright').chromium;
    const network = buildBrowserEnv(GATEWAY);
    network.env.LD_LIBRARY_PATH = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    const context = await chromium.launchPersistentContext(paths.profileDir, {
      executablePath: paths.chromePath, headless: true, env: network.env,
      args: chromiumArgsFor(GATEWAY, ['--no-sandbox']),
    });
    return { context, close: async () => { try { await context.close(); } finally { release(); } } };
  } catch (error) {
    release();
    throw error;
  }
}

async function queryGateway(context, filter) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const form = new URLSearchParams({
      page: String(page), limit: '50', system_id: '', url: filter.url || '',
      interface_name: filter.interface || '', method: filter.method || '', lsf_app_name: '',
    });
    const response = await context.request.post(GATEWAY_QUERY, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // 缺 Origin/Referer 时网关一律回 16051006 未登录，与登录态无关。
        Origin: GATEWAY, Referer: `${GATEWAY}/`,
      },
      data: form.toString(), timeout: 60000,
    });
    const parsed = parseGatewayRows(await response.text());
    rows.push(...parsed.rows);
    if (page >= parsed.totalPage) break;
  }
  return rows;
}

async function gatewayRulesForUrl(context, rawUrl) {
  const p = String(rawUrl).replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0].replace(/^\/+/, '');
  const variants = [...new Set([p, `/${p}`, p.startsWith('rc_oa_gateway/') ? p.slice(14) : `rc_oa_gateway/${p}`])];
  for (const v of variants) {
    const rows = await queryGateway(context, { url: v });
    // 网关 url 参数是模糊匹配，只保留路径完全相同的规则。
    const exact = rows.filter((r) => String(r.url).replace(/^\/+/, '').replace(/^rc_oa_gateway\//, '') === p.replace(/^rc_oa_gateway\//, ''));
    if (exact.length) return exact;
  }
  return [];
}

async function listGroupProjects(context, refresh) {
  if (!refresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.projects.length) return cached.projects;
    } catch { /* 无缓存时重新拉取 */ }
  }
  const projects = [];
  for (let page = 1; page <= 30; page += 1) {
    const response = await context.request.get(`${GITLAB}/${GITLAB_GROUP}.json?page=${page}`, { timeout: 60000 });
    if (response.status() !== 200) throw new Error(`读取 GitLab ${GITLAB_GROUP} 工程列表失败：HTTP ${response.status()}`);
    let html;
    try { html = JSON.parse(await response.text()).html; } catch { throw new Error('GitLab 工程列表返回的不是 JSON，可能未登录 GitLab'); }
    const names = parseGroupProjects(html);
    if (!names.length) break;
    projects.push(...names);
  }
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), projects }));
  return projects;
}

// ---------------------------------------------------------------- frontend repo work

function ensureRepo(name, frontendRoot, state) {
  const dest = path.join(frontendRoot, name);
  if (state.prepared.has(dest)) return state.prepared.get(dest);
  let info;
  if (fs.existsSync(path.join(dest, '.git'))) {
    const fetched = git(dest, ['fetch', '-q', 'origin', BRANCH], 300000);
    info = { repo: dest, action: fetched.code === 0 ? 'fetched' : 'fetch-failed', note: fetched.code === 0 ? '' : fetched.stderr.trim().split('\n').pop() };
  } else if (state.clones >= MAX_CLONES) {
    info = { repo: dest, action: 'skipped', note: `本次已 clone ${MAX_CLONES} 个工程，未继续 clone` };
  } else {
    state.clones += 1;
    const url = `${GITLAB}/${GITLAB_GROUP}/${name}.git`;
    let cloned = run('git', ['clone', '-q', '-b', BRANCH, url, dest], { timeout: 600000 });
    let note = '';
    if (cloned.code !== 0 && /Remote branch .* not found/i.test(cloned.stderr)) {
      cloned = run('git', ['clone', '-q', url, dest], { timeout: 600000 });
      note = `远端没有 ${BRANCH} 分支，已按默认分支 clone`;
    }
    info = { repo: dest, action: cloned.code === 0 ? 'cloned' : 'clone-failed', note: cloned.code === 0 ? note : cloned.stderr.trim().split('\n').pop() };
  }
  if (info.action !== 'skipped' && info.action !== 'clone-failed') {
    const ref = git(dest, ['rev-parse', '--verify', '-q', `origin/${BRANCH}`]).code === 0 ? `origin/${BRANCH}` : 'origin/HEAD';
    if (ref !== `origin/${BRANCH}`) info.note = [info.note, `没有 origin/${BRANCH}，改用 origin/HEAD`].filter(Boolean).join('；');
    const log = git(dest, ['log', '-1', '--format=%h %ci', ref]).stdout.trim();
    info = { ...info, ref, commit: log };
  }
  state.prepared.set(dest, info);
  return info;
}

function grepRepo(info, terms) {
  const args = ['grep', '-n', '-F'];
  for (const t of terms) args.push('-e', t);
  args.push(info.ref, '--', ':(exclude)htdocs', ':(exclude)dist', ':(exclude)**/node_modules/**', ':(exclude)*.map', ':(exclude)**/mock/**', ':(exclude)*.min.js');
  const result = git(info.repo, args);
  const hits = [];
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const m = line.match(/^[^:]+:([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    if (terms.some((t) => lineHasTerm(m[3], t))) hits.push({ file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 200) });
  }
  return hits;
}

function repoFiles(info) {
  return new Set(git(info.repo, ['ls-tree', '-r', '--name-only', info.ref]).stdout.split('\n').filter(Boolean));
}

function show(info, file) {
  return git(info.repo, ['show', `${info.ref}:${file}`]).stdout;
}

// 从命中文件沿 import 反向找到被路由引用的页面组件，再取 path。
function resolveRoutes(info, hitFile, mod, fileSet) {
  const moduleFiles = [...fileSet].filter((f) => f.startsWith(`${mod.dir}/`) && /\.(vue|js)$/.test(f));
  const routeFiles = moduleFiles.filter((f) => /(^|\/)(routes?|router)(\/|[\w.-]*\.js$)/.test(f));
  const routeSources = routeFiles.map((f) => ({ file: f, source: show(info, f) }));
  const results = [];
  const seen = new Set([hitFile]);
  let frontier = [hitFile];
  for (let depth = 0; depth <= MAX_IMPORT_DEPTH && frontier.length && !results.length; depth += 1) {
    for (const target of frontier) {
      for (const rf of routeSources) {
        for (const imp of parseImports(rf.source)) {
          if (!imp.name || resolveImport(rf.file, imp.spec, fileSet) !== target) continue;
          for (const r of findRoutePath(rf.source, imp.name)) results.push({ ...r, component: target, routeFile: rf.file, depth });
        }
      }
    }
    if (results.length) break;
    const next = [];
    for (const target of frontier) {
      const stem = path.posix.basename(target).replace(/\.(vue|js)$/, '');
      const needle = stem === 'index' ? path.posix.basename(path.posix.dirname(target)) : stem;
      const grep = git(info.repo, ['grep', '-l', '-F', '-e', needle, info.ref, '--', `${mod.dir}/`]);
      for (const line of grep.stdout.split('\n').filter(Boolean)) {
        const file = line.slice(line.indexOf(':') + 1);
        if (seen.has(file) || !/\.(vue|js)$/.test(file)) continue;
        const imports = parseImports(show(info, file));
        if (imports.some((imp) => resolveImport(file, imp.spec, fileSet) === target)) {
          seen.add(file);
          next.push(file);
        }
      }
    }
    frontier = next;
  }
  const historyMode = routeSources.some((rf) => /mode\s*:\s*['"]history['"]/.test(rf.source))
    || /mode\s*:\s*['"]history['"]/.test(fileSet.has(`${mod.dir}/main.js`) ? show(info, `${mod.dir}/main.js`) : '');
  return { routes: results, historyMode };
}

function moduleTitle(info, mod, fileSet) {
  const template = `${mod.dir}/template.html`;
  if (!fileSet.has(template)) return '';
  return (show(info, template).match(/<title>([^<]*)<\/title>/) || [])[1] || '';
}

function pagesForRule(rule, repoInfos) {
  const terms = searchTerms(rule.url);
  const pages = [];
  for (const info of repoInfos) {
    if (!info.ref) continue;
    const hits = grepRepo(info, terms);
    if (!hits.length) continue;
    const fileSet = repoFiles(info);
    const byFile = new Map();
    for (const hit of hits) {
      if (!byFile.has(hit.file)) byFile.set(hit.file, []);
      byFile.get(hit.file).push(hit);
    }
    for (const [file, fileHits] of byFile) {
      const mod = findModule(file, fileSet);
      const htmlPath = htmlPathForModule(mod.moduleRel);
      const { routes, historyMode } = resolveRoutes(info, file, mod, fileSet);
      const notes = [];
      if (!routes.length) notes.push('没在路由文件里找到引用该组件的路由，页面地址只到 HTML');
      if (routes.some((r) => r.nested)) notes.push('命中嵌套路由（path 不以 / 开头），需按父路由拼接');
      pages.push({
        repo: info.repo, ref: info.ref, commit: info.commit, file,
        lines: fileHits.map((h) => h.line), sample: fileHits[0].text,
        module: mod.dir, htmlPath, title: moduleTitle(info, mod, fileSet),
        routes: routes.map((r) => ({ path: r.path, component: r.component, routeFile: r.routeFile })),
        pageUrls: routes.length ? [...new Set(routes.map((r) => pageUrl(rule.domain, htmlPath, r.path, historyMode)))] : [pageUrl(rule.domain, htmlPath, '', historyMode)],
        notes,
      });
    }
  }
  return pages;
}

function localFrontendRepos(frontendRoot) {
  if (!fs.existsSync(frontendRoot)) return [];
  return fs.readdirSync(frontendRoot).filter((name) => {
    const dir = path.join(frontendRoot, name);
    if (!fs.existsSync(path.join(dir, '.git'))) return false;
    return git(dir, ['remote', 'get-url', 'origin']).stdout.includes(`/${GITLAB_GROUP}/`);
  });
}

async function verifyPages(context, results) {
  for (const item of results) {
    for (const page of item.pages) {
      page.verify = [];
      for (const url of page.pageUrls) {
        const response = await context.request.get(url.split('#')[0], { timeout: 60000 });
        const title = ((await response.text()).match(/<title>([^<]*)<\/title>/) || [])[1] || '';
        page.verify.push({ url, status: response.status(), title, titleMatchesTemplate: Boolean(page.title) && title === page.title });
      }
    }
  }
}

// ---------------------------------------------------------------- main

// 每条线上规则一行：后端方法、前端接口、页面地址、调用位置，便于直接打开浏览器。
function summarize(output) {
  return (output.results || []).map(({ rule, pages, note }) => ({
    backend: `${String(rule.interface_name).split('.').pop()}#${rule.method}`,
    api: `https://${rule.domain}${rule.url}`,
    pageUrls: [...new Set(pages.flatMap((p) => p.pageUrls))],
    callers: pages.map((p) => `${path.basename(p.repo)}@${p.ref}:${p.file}:${p.lines.join(',')}`),
    ...(note ? { note } : {}),
  }));
}

function parseInput(args) {
  const iface = str(args.interface);
  const url = str(args.url);
  const table = str(args.table);
  const given = [iface, url, table].filter(Boolean).length;
  if (given !== 1) throw new Error('必须且只能给一个入口：--interface=<全限定接口名> [--method=m]、--url=<网关 URL> 或 --table=<MySQL 表名>');
  if (iface && !/^[\w$]+(\.[\w$]+)+$/.test(iface)) throw new Error('--interface 需要全限定接口名，如 com.fenqile.rc.mock.service.UserWhitelistCgiService');
  if (table && !/^[\w.]+$/.test(table)) throw new Error('--table 只接受表名，可带库名前缀');
  return { iface, method: str(args.method), url, table: table.split('.').pop() };
}

async function main(args) {
  const input = parseInput(args);
  const frontendRoot = str(args['frontend-root']) || DEFAULT_FRONTEND_ROOT;
  const output = { input: { interface: input.iface || undefined, method: input.method || undefined, url: input.url || undefined, table: input.table || undefined }, branch: BRANCH };

  let interfaces = input.iface ? [input.iface] : [];
  if (input.table) {
    output.tableTrace = traceTable(input.table, str(args['backend-root']) || DEFAULT_BACKEND_ROOT);
    interfaces = [...new Set(output.tableTrace.flatMap((r) => r.interfaces))];
    if (!interfaces.length) {
      output.unresolved = ['本地后端代码里没找到经由 Dubbo 暴露、且调用链引用该表的接口'];
      return output;
    }
  }

  const session = await openContext(args);
  try {
    let rules = [];
    if (input.url) rules = await gatewayRulesForUrl(session.context, input.url);
    for (const iface of interfaces) rules.push(...await queryGateway(session.context, { interface: iface }));
    if (input.method) rules = rules.filter((r) => r.method === input.method);
    const seenRules = new Set();
    rules = rules.map(pickRule).filter((r) => {
      const key = `${r.domain}|${r.url}|${r.interface_name}|${r.method}`;
      if (seenRules.has(key)) return false;
      seenRules.add(key);
      return true;
    });
    output.nonProdRules = rules.filter((r) => !isProdDomain(r.domain)).map((r) => `${r.domain}${r.url} -> ${r.method}`);
    const prodRules = rules.filter((r) => isProdDomain(r.domain));
    if (!prodRules.length) {
      output.unresolved = [rules.length ? '只有非线上域名的网关规则' : '网关里没有匹配的规则'];
      return output;
    }

    const projects = await listGroupProjects(session.context, Boolean(args['refresh-projects']));
    const local = localFrontendRepos(frontendRoot);
    const state = { clones: 0, prepared: new Map() };
    output.repos = [];
    output.results = [];
    for (const domain of [...new Set(prodRules.map((r) => r.domain))]) {
      const candidates = rankRepos(domain, [...new Set([...local, ...projects])]);
      const domainRules = prodRules.filter((r) => r.domain === domain);
      const pending = new Set(domainRules);
      for (const name of candidates) {
        if (!pending.size) break;
        const info = ensureRepo(name, frontendRoot, state);
        if (!output.repos.some((r) => r.repo === info.repo)) output.repos.push(info);
        for (const rule of [...pending]) {
          const pages = pagesForRule(rule, [info]);
          if (!pages.length) continue;
          pending.delete(rule);
          output.results.push({ rule, pages });
        }
      }
      for (const rule of pending) {
        output.results.push({ rule, pages: [], note: candidates.length ? `候选工程（${candidates.join(', ')}）的 ${BRANCH} 分支里都没搜到调用` : `rc_fd 下没有名字和 ${domain} 对应的工程` });
      }
    }
    if (args.verify) await verifyPages(session.context, output.results);
  } finally {
    await session.close();
  }
  return output;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法：
  node locate_frontend_page.js --interface=<全限定接口名> [--method=<方法>]
  node locate_frontend_page.js --url=<网关 URL，如 /rc_oa_gateway/rc_mock/user_whitelist_page>
  node locate_frontend_page.js --table=<MySQL 表名，可带库名>
选项：--verify 用登录态 GET 页面并核对 <title>；--refresh-projects 刷新 rc_fd 工程清单缓存；
      --frontend-root 默认 ${DEFAULT_FRONTEND_ROOT}；--backend-root 默认 ${DEFAULT_BACKEND_ROOT}；--profile 浏览器 profile`);
  } else {
    main(args).then((out) => console.log(JSON.stringify({ summary: summarize(out), ...out }, null, 2))).catch((error) => {
      console.error(JSON.stringify({ error: error.message, code: error.code }));
      process.exitCode = 1;
    });
  }
}

module.exports = {
  findModule, findRoutePath, htmlPathForModule, isProdDomain, kebab, lineHasTerm, normalizeRepoName,
  pageUrl, parseGatewayRows, summarize, parseGroupProjects, parseImports, parseInput, rankRepos, resolveImport, searchTerms,
};
