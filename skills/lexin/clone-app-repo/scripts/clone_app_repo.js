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
const { skillDir, workspaceRoot } = require(path.join(root, 'lib/agent_tools/locate.js'));

// Lexiao list_simple_app row -> repository facts. Field names are the API's own (see references/lexiao-app-repo-fields.md).
const APP_FIELDS = ['app_name', 'name', 'project_name', 'group_name', 'git_addr', 'pom_path', 'interface_prefix',
  'owner', 'manager', 'app_type', 'jdk', 'port', 'biz_line'];
const DEFAULT_GITLAB_HOST = 'gitlab.fenqile.com';
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.venv', 'venv', '.m2', '__pycache__']);
const DEFAULT_SCAN_DEPTH = 4;
const DEFAULT_TIMEOUT_MS = 600000;
const TEMP_PREFIX = '.clone-app-repo-';
const EXIT = { ok: 0, error: 1, no_access: 3, no_credential: 4, network: 5, not_found: 6 };
const VALUE_OPTIONS = new Set(['app', 'app-id', 'repo', 'dir', 'name', 'branch', 'depth', 'protocol', 'workspace',
  'scan-depth', 'timeout', 'profile', 'format']);
const FLAG_OPTIONS = new Set(['json', 'no-probe', 'help', 'headed']);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function positiveInt(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer, got ${value}`);
  return parsed;
}

// --key=value or --key value for VALUE_OPTIONS, bare --flag for FLAG_OPTIONS; anything else is an error.
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`unexpected argument ${item}`);
    const eq = item.indexOf('=');
    const key = eq === -1 ? item.slice(2) : item.slice(2, eq);
    if (VALUE_OPTIONS.has(key)) {
      let value;
      if (eq !== -1) value = item.slice(eq + 1);
      else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) { value = argv[index + 1]; index += 1; }
      if (value === undefined || value === '') throw new Error(`--${key} requires a value`);
      args[key] = value;
    } else if (FLAG_OPTIONS.has(key)) {
      if (eq !== -1) throw new Error(`--${key} takes no value`);
      args[key] = true;
    } else {
      throw new Error(`unknown option --${key}`);
    }
  }
  const selectors = ['app', 'app-id', 'repo'].filter((key) => args[key] !== undefined);
  if (!args.help && selectors.length !== 1) throw new Error(`exactly one of --app, --app-id or --repo is required (got ${selectors.length ? selectors.map((key) => `--${key}`).join(', ') : 'none'})`);
  if (args.name !== undefined && !SAFE_NAME.test(args.name)) throw new Error(`--name must be a single directory name ([A-Za-z0-9._-], not starting with '.'), got ${args.name}`);
  return args;
}

function usage() {
  console.log(`Usage:
  clone_app_repo.js (--app=<name|project_name> | --app-id=<id> | --repo=<git url | group/project>) [options]

Lookup only (no --dir): resolve the app in Lexiao, print git_addr, owner/manager, matching local clones,
suggested parent directories (from existing clones of the same GitLab group) and an access probe.
Clone (with --dir): clone the single resolved repository into <dir>/<name> via a temporary sibling directory.

Options:
  --dir=<parent>        parent directory, absolute or relative to the workspace root; enables cloning
  --name=<dir name>     clone directory name (single path segment), default = repository name from the URL
  --branch=<name>       git clone --branch
  --depth=<n>           git clone --depth
  --protocol=keep|http|https|ssh   rewrite the clone URL scheme, default keep (Lexiao gives http)
  --workspace=<root>    override the workspace root (default AGENT_TOOLS_WORKSPACE_ROOT or ~/projects)
  --scan-depth=<n>      how deep to look for existing clones under the workspace root, default ${DEFAULT_SCAN_DEPTH}
  --no-probe            skip the git ls-remote access probe in lookup mode
  --timeout=<ms>        git clone timeout, default ${DEFAULT_TIMEOUT_MS}
  --profile=<dir>       Lexiao browser profile (passed to query-app-instances); --headed opens the browser visibly
  --format=json|table   default table; --json is a shortcut

Exit codes: 0 ok (lookup / cloned / already present), 1 error (bad arguments, ambiguous with --dir, target exists,
  timeout, other git failures), 2 agent-tools root or browser runtime missing, 3 no access to the repository,
  4 no usable git credential, 5 network, 6 no Lexiao app matched`);
}

// ---------- pure helpers (unit-tested) ----------

// Accepts https://host[:port]/a/b.git, ssh://git@host[:port]/a/b.git, git@host:a/b.git, host/a/b, a/b.
// authority keeps the port for building URLs; host (lower-case, no port) and key are for comparisons.
function normalizeRemote(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let scheme = '';
  let authority = '';
  let projectPath = '';
  const withScheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (withScheme) {
    scheme = withScheme[1].toLowerCase();
    const rest = withScheme[2].replace(/^[^@/]*@/, '');
    const slash = rest.indexOf('/');
    authority = slash === -1 ? rest : rest.slice(0, slash);
    projectPath = slash === -1 ? '' : rest.slice(slash + 1);
  } else {
    const scp = raw.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (scp) {
      scheme = 'scp';
      authority = scp[1];
      projectPath = scp[2];
    } else {
      projectPath = raw;
    }
  }
  const host = authority.replace(/:\d+$/, '').toLowerCase();
  const port = (authority.match(/:(\d+)$/) || [, ''])[1];
  projectPath = projectPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!projectPath) return null;
  return { scheme, authority, host, port, projectPath, key: `${host}/${projectPath.toLowerCase()}` };
}

function repoNameFromUrl(value) {
  const parsed = normalizeRemote(value);
  return parsed ? parsed.projectPath.split('/').pop() : '';
}

function groupOf(value) {
  const parsed = normalizeRemote(value);
  return parsed ? parsed.projectPath.split('/').slice(0, -1).join('/') : '';
}

// Web page of the project (where access is requested). Keeps the port for http(s) sources; ssh ports are not web ports.
function webUrlOf(value) {
  const parsed = normalizeRemote(value);
  if (!parsed || !parsed.host) return '';
  const web = parsed.scheme === 'http' || parsed.scheme === 'https';
  return `${web ? parsed.scheme : 'https'}://${web ? parsed.authority : parsed.host}/${parsed.projectPath}`;
}

function rewriteProtocol(value, protocol) {
  const mode = String(protocol || 'keep').toLowerCase();
  if (mode === 'keep') return value;
  const parsed = normalizeRemote(value);
  if (!parsed || !parsed.host) throw new Error(`cannot rewrite protocol of ${value}: host missing`);
  const sourceIsWeb = parsed.scheme === 'http' || parsed.scheme === 'https';
  const sourceIsSsh = parsed.scheme === 'ssh' || parsed.scheme === 'scp';
  if (mode === 'http' || mode === 'https') return `${mode}://${sourceIsWeb ? parsed.authority : parsed.host}/${parsed.projectPath}.git`;
  if (mode === 'ssh') {
    if (sourceIsSsh && parsed.port) return `ssh://git@${parsed.authority}/${parsed.projectPath}.git`;
    return `git@${parsed.host}:${parsed.projectPath}.git`;
  }
  throw new Error(`Unsupported --protocol: ${protocol}`);
}

// Masks user:password@ in any URL inside text (output only; git still receives the original URL).
function redact(text) {
  return String(text).replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi, '$1***@');
}

// Maps git stderr to one of: no_access | no_credential | network | error. Checked in this order so a 403 body that
// also says "unable to access" is access, not network.
function classifyGitFailure(stderr) {
  const text = String(stderr || '');
  if (/could not read Username|terminal prompts disabled|Permission denied \(publickey|Authentication failed|HTTP 401|401 Unauthorized|returned error: 401|invalid username or password/i.test(text)) return 'no_credential';
  if (/could not be found or you don't have permission|You are not allowed to|HTTP 403|403 Forbidden|returned error: 40[34]|repository '[^']*' not found|Project .* not found/i.test(text)) return 'no_access';
  if (/Could not resolve host|Connection refused|Connection timed out|Network is unreachable|Failed to connect|Recv failure|kex_exchange_identification|Connection closed by remote host|Operation timed out|SSL_connect|SSL certificate problem|Timed out/i.test(text)) return 'network';
  return 'error';
}

// Same ordering as query_app_instances.resolveApp, but keeps every candidate so the caller can show them.
function rankApps(rows, query) {
  const wanted = String(query || '');
  const norm = (value) => String(value || '').toLowerCase().replace(/[-_\s]/g, '');
  const normalized = norm(wanted);
  const names = (row) => [row.app_name, row.name];
  const exactAppName = rows.filter((row) => names(row).some((value) => String(value || '') === wanted));
  if (exactAppName.length) return exactAppName;
  const exactProject = rows.filter((row) => String(row.project_name || '') === wanted);
  if (exactProject.length) return exactProject;
  const exactNormalized = rows.filter((row) => [...names(row), row.project_name].some((value) => norm(value) === normalized));
  if (exactNormalized.length) return exactNormalized;
  return rows.filter((row) => [...names(row), row.project_name].some((value) => norm(value).includes(normalized)));
}

// The value as given, plus its _→- and -→_ spellings (Lexiao app names and project names differ in this).
function nameVariants(value) {
  const result = [];
  for (const item of [value, String(value).replace(/_/g, '-'), String(value).replace(/-/g, '_')]) {
    if (item && !result.includes(item)) result.push(item);
  }
  return result;
}

function appToRepo(row) {
  const out = {};
  for (const field of APP_FIELDS) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') out[field] = row[field];
  }
  out.app_id = Number(row.fid || row.id || row.app_id) || undefined;
  return out;
}

// ---------- local repositories ----------

function git(argv, options = {}) {
  return spawnSync('git', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

// A repository is a directory whose .git is a file (linked worktree / submodule) or a directory with HEAD.
function isRepoDir(dir, entries) {
  const entry = entries.find((item) => item.name === '.git');
  if (!entry) return false;
  if (entry.isFile()) return true;
  return entry.isDirectory() && fs.existsSync(path.join(dir, '.git', 'HEAD'));
}

// git itself resolves worktrees and include.path, which parsing .git/config by hand would miss.
function originUrlOf(repoDir) {
  const run = git(['-C', repoDir, 'remote', 'get-url', 'origin']);
  return run.status === 0 ? String(run.stdout || '').trim() : '';
}

// Lists git repositories (dir + origin url) under rootDir, skipping dependency/build dirs, hidden dirs and symlinks.
function scanLocalRepos(rootDir, maxDepth = DEFAULT_SCAN_DEPTH) {
  const repos = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    if (isRepoDir(dir, entries)) {
      repos.push({ path: dir, remote: originUrlOf(dir) });
      if (depth > 0) return; // a workspace root that is itself a repository still holds other clones
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // Dirent reports symlinks as symlinks, so links to directories are skipped too
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.') || entry.name.includes(':')) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(rootDir, 0);
  return repos;
}

// Same host + project path; http/https/ssh spellings and ports do not make a different repository.
function findLocalClones(repos, remoteUrl) {
  const target = normalizeRemote(remoteUrl);
  if (!target) return [];
  return repos.filter((repo) => {
    const parsed = normalizeRemote(repo.remote);
    return Boolean(parsed) && parsed.key === target.key;
  });
}

// Parent directories (relative to workspaceDir) that already hold clones from the same GitLab group, most used first.
function suggestParentDirs(repos, remoteUrl, workspaceDir) {
  const target = normalizeRemote(remoteUrl);
  const group = groupOf(remoteUrl).toLowerCase();
  if (!target || !group) return [];
  const counts = new Map();
  for (const repo of repos) {
    const parsed = normalizeRemote(repo.remote);
    if (!parsed || groupOf(repo.remote).toLowerCase() !== group) continue;
    if (target.host && parsed.host && parsed.host !== target.host) continue;
    const parent = path.relative(workspaceDir, path.dirname(repo.path)) || '.';
    counts.set(parent, (counts.get(parent) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir));
}

// ---------- Lexiao lookup ----------

async function lookupApps(args) {
  const qai = require(skillDir('query-app-instances', 'scripts', 'query_app_instances.js'));
  const session = await qai.withLexiaoSession(args, async (page) => {
    if (args['app-id']) return qai.searchAppsByField(page, 'app_id', String(args['app-id']));
    const seen = new Map();
    for (const candidate of nameVariants(args.app)) {
      for (const field of ['project_name', 'name']) {
        for (const row of await qai.searchAppsByField(page, field, candidate)) {
          const id = row.fid || row.id || row.app_id;
          if (id) seen.set(String(id), row);
        }
      }
    }
    return Array.from(seen.values());
  });
  const rows = session.result;
  const ranked = args['app-id'] ? rows : rankApps(rows, args.app);
  return {
    candidates: ranked.map(appToRepo),
    searched: rows.length,
    session: { profile: session.profile, network_policy: session.networkPolicy, session_source: session.sessionSource },
  };
}

// ---------- git remote operations ----------

function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
}

function probeAccess(remoteUrl, timeoutMs) {
  const run = git(['ls-remote', '--exit-code', remoteUrl, 'HEAD'], { env: gitEnv(), timeout: Math.min(timeoutMs, 60000) });
  if (run.error) return { access: run.error.code === 'ETIMEDOUT' ? 'timeout' : 'error', detail: run.error.message };
  if (run.status === 0) return { access: 'ok', head: String(run.stdout || '').trim().split(/\s+/)[0] || '' };
  // --exit-code gives 2 with no stderr when the repository is reachable but has no HEAD yet (empty repository).
  if (run.status === 2 && !String(run.stderr || '').trim()) return { access: 'ok', head: '', detail: 'empty repository' };
  return { access: classifyGitFailure(run.stderr), detail: String(run.stderr || '').trim().slice(-800) };
}

// 'absent' | 'empty-dir' | 'dir' | 'file' | 'symlink' (lstat, so a dangling or directory symlink is reported as such).
function describePath(target) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  if (stat.isSymbolicLink()) return 'symlink';
  if (!stat.isDirectory()) return 'file';
  return fs.readdirSync(target).length ? 'dir' : 'empty-dir';
}

function staleTempDirs(parent) {
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEMP_PREFIX))
      .map((entry) => path.join(parent, entry.name));
  } catch (_) { return []; }
}

// Clones into <parent>/.clone-app-repo-XXXXXX/<name> and renames it into place, so a failed or killed clone never
// leaves a half-filled <parent>/<name>, and only the temporary directory this call created is ever removed.
function cloneRepo(remoteUrl, parent, name, options = {}) {
  const target = path.join(parent, name);
  const before = describePath(target);
  if (before !== 'absent' && before !== 'empty-dir') {
    return { status: 'target_exists', target, detail: `${target} already exists (${before}); pass --name or pick another --dir` };
  }
  fs.mkdirSync(parent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(parent, TEMP_PREFIX));
  const staging = path.join(temp, name);
  const cloneArgs = ['clone'];
  if (options.branch) cloneArgs.push('--branch', String(options.branch));
  if (options.depth) cloneArgs.push('--depth', String(options.depth));
  cloneArgs.push('--', remoteUrl, staging);
  const command = ['git', ...cloneArgs.slice(0, -1), target];
  try {
    const run = git(cloneArgs, { env: gitEnv(), timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS });
    if (run.error) return { status: run.error.code === 'ETIMEDOUT' ? 'timeout' : 'error', target, detail: run.error.message, command };
    if (run.status !== 0) return { status: classifyGitFailure(run.stderr), target, detail: String(run.stderr || '').trim().slice(-1500), command };
    try {
      fs.renameSync(staging, target); // replaces an empty directory atomically; fails if something appeared meanwhile
    } catch (error) {
      if (['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(error.code)) {
        return { status: 'target_exists', target, detail: `${target} was created by someone else while cloning (${error.code}); nothing overwritten`, command };
      }
      throw error;
    }
    const head = git(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD']);
    return { status: 'cloned', target, branch: String(head.stdout || '').trim(), command };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// ---------- output ----------

function printTable(output) {
  const lines = [];
  lines.push(`workspace: ${output.workspace}`);
  if (output.lexiao) lines.push(`lexiao: searched=${output.lexiao.searched} candidates=${output.candidates.length} session=${output.lexiao.session.session_source}`);
  for (const candidate of output.candidates) {
    lines.push(`- ${candidate.app_name || candidate.name || candidate.project_name || '?'}  app_id=${candidate.app_id || '-'}  project_name=${candidate.project_name || '-'}`);
    lines.push(`    git_addr=${candidate.git_addr || '<missing>'}  group=${candidate.group_name || groupOf(candidate.git_addr) || '-'}`);
    const meta = ['owner', 'manager', 'jdk', 'biz_line', 'pom_path'].filter((key) => candidate[key]).map((key) => `${key}=${candidate[key]}`);
    if (meta.length) lines.push(`    ${meta.join('  ')}`);
  }
  if (output.repo) {
    lines.push(`repo: ${output.repo.clone_url}  (web ${output.repo.web_url})`);
    if (output.access) lines.push(`access: ${output.access.access}${output.access.detail ? `  ${output.access.detail.split('\n').pop()}` : ''}`);
    lines.push(`local clones: ${output.local_clones.length ? output.local_clones.map((repo) => repo.path).join(', ') : 'none'}`);
    lines.push(`suggested parent dirs: ${output.suggested_parent_dirs.length ? output.suggested_parent_dirs.map((item) => `${item.dir} (${item.count})`).join(', ') : 'none (ask the user)'}`);
  }
  if (output.stale_temp_dirs && output.stale_temp_dirs.length) lines.push(`stale temp dirs from interrupted clones (check, then delete by hand): ${output.stale_temp_dirs.join(', ')}`);
  if (output.clone) {
    lines.push(`clone: ${output.clone.status}${output.clone.target ? `  ${output.clone.target}` : ''}${output.clone.branch ? `  branch=${output.clone.branch}` : ''}`);
    if (output.clone.detail) lines.push(output.clone.detail);
  }
  lines.push(`status: ${output.status}`);
  if (output.next_step) lines.push(`next: ${output.next_step}`);
  return lines.join('\n');
}

// Everything printed goes through redact(): URLs from Lexiao, local origins, git commands and stderr may carry userinfo.
function emit(output, args) {
  const text = args.json || args.format === 'json' ? JSON.stringify(output, null, 2) : printTable(output);
  console.log(redact(text));
}

function nextStepFor(status, output) {
  const web = output.repo ? output.repo.web_url : '';
  const people = output.candidates && output.candidates[0]
    ? ['owner', 'manager'].filter((key) => output.candidates[0][key]).map((key) => `${key} ${output.candidates[0][key]}`).join(', ')
    : '';
  switch (status) {
    case 'no_access': return `ask the user to request access to ${web}${people ? ` (${people})` : ''}; GitLab gives the same message for a missing project, so also confirm the address; do not retry until granted`;
    case 'no_credential': return 'git has no usable credential for this host (git credential store / ssh key); fix it with the user before cloning';
    case 'network': return 'git cannot reach the host; check VPN/aTrust, the proxy and certificates, then rerun';
    case 'timeout': return 'git did not finish within --timeout; rerun with a larger --timeout or with --depth=1 for a shallow clone';
    case 'ambiguous': return 'several Lexiao apps matched; pick one with --app-id=<id> or --repo=<git url>';
    case 'not_found': return 'no Lexiao app matched; check the app name (project_name is exact, name is fuzzy) or pass --repo';
    case 'exists': return 'repository already cloned; use the listed directory instead of cloning again';
    case 'lookup': return output.suggested_parent_dirs && output.suggested_parent_dirs.length === 1
      ? `rerun with --dir=${output.suggested_parent_dirs[0].dir} after confirming with the user if the workspace guide disagrees`
      : 'agree the target parent directory with the user, then rerun with --dir=<parent>';
    default: return '';
  }
}

async function main() {
  if (process.argv.slice(2).some((item) => item === '--help')) { usage(); return EXIT.ok; }
  const args = parseArgs(process.argv.slice(2));
  const workspace = args.workspace ? path.resolve(String(args.workspace)) : workspaceRoot();
  const timeoutMs = positiveInt(args.timeout, '--timeout', DEFAULT_TIMEOUT_MS);
  const scanDepth = positiveInt(args['scan-depth'], '--scan-depth', DEFAULT_SCAN_DEPTH);
  const depth = positiveInt(args.depth, '--depth', undefined);
  const output = { queried_at: new Date().toISOString(), workspace, candidates: [], status: 'lookup' };

  if (args.repo) {
    const parsed = normalizeRemote(args.repo);
    if (!parsed) throw new Error(`--repo is not a git url or group/project: ${args.repo}`);
    const url = parsed.host ? String(args.repo) : `https://${DEFAULT_GITLAB_HOST}/${parsed.projectPath}.git`;
    output.candidates = [{ git_addr: url, project_name: repoNameFromUrl(url), group_name: groupOf(url) }];
  } else {
    const lookup = await lookupApps(args);
    output.lexiao = { searched: lookup.searched, session: lookup.session };
    output.candidates = lookup.candidates;
    if (!lookup.candidates.length) {
      output.status = 'not_found';
      output.next_step = nextStepFor('not_found', output);
      emit(output, args);
      return EXIT.not_found;
    }
    if (lookup.candidates.length > 1) {
      output.status = 'ambiguous';
      output.next_step = nextStepFor('ambiguous', output);
      emit(output, args);
      return args.dir ? EXIT.error : EXIT.ok;
    }
  }

  const candidate = output.candidates[0];
  if (!candidate.git_addr) {
    output.status = 'error';
    output.next_step = 'Lexiao row has no git_addr; ask the app owner for the repository URL and pass --repo';
    emit(output, args);
    return EXIT.error;
  }
  const cloneUrl = rewriteProtocol(candidate.git_addr, args.protocol);
  output.repo = { git_addr: candidate.git_addr, clone_url: cloneUrl, web_url: webUrlOf(cloneUrl), name: repoNameFromUrl(cloneUrl), group: groupOf(cloneUrl) };

  const repos = scanLocalRepos(workspace, scanDepth);
  output.local_clones = findLocalClones(repos, cloneUrl);
  output.suggested_parent_dirs = suggestParentDirs(repos, cloneUrl, workspace);

  if (output.local_clones.length) {
    output.status = 'exists';
    output.next_step = nextStepFor('exists', output);
    emit(output, args);
    return EXIT.ok;
  }

  if (!args.dir) {
    if (!args['no-probe']) {
      output.access = probeAccess(cloneUrl, timeoutMs);
      if (output.access.access !== 'ok') {
        output.status = output.access.access;
        output.next_step = nextStepFor(output.status, output);
        emit(output, args);
        return EXIT[output.status] || EXIT.error;
      }
    }
    output.status = 'lookup';
    output.next_step = nextStepFor('lookup', output);
    emit(output, args);
    return EXIT.ok;
  }

  const parent = path.resolve(workspace, String(args.dir));
  output.stale_temp_dirs = staleTempDirs(parent);
  const clone = cloneRepo(cloneUrl, parent, String(args.name || output.repo.name), { branch: args.branch, depth, timeoutMs });
  output.clone = clone;
  output.status = clone.status === 'target_exists' ? 'error' : clone.status;
  output.next_step = clone.status === 'cloned'
    ? 'continue the code search inside the new clone; add the directory to the workspace guide if it keeps a directory map'
    : nextStepFor(clone.status, output);
  emit(output, args);
  return clone.status === 'cloned' ? EXIT.ok : (EXIT[clone.status] || EXIT.error);
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(JSON.stringify({ error: redact(error.message) }, null, 2));
    process.exit(EXIT.error);
  });
}

module.exports = {
  APP_FIELDS,
  TEMP_PREFIX,
  appToRepo,
  classifyGitFailure,
  cloneRepo,
  describePath,
  findLocalClones,
  groupOf,
  nameVariants,
  normalizeRemote,
  parseArgs,
  positiveInt,
  probeAccess,
  rankApps,
  redact,
  repoNameFromUrl,
  rewriteProtocol,
  scanLocalRepos,
  staleTempDirs,
  suggestParentDirs,
  webUrlOf,
};
