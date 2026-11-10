'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
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
} = require('../scripts/clone_app_repo');

function run(argv, cwd) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(result.status, 0, `${argv.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

function gitRepo(dir, remote) {
  fs.mkdirSync(dir, { recursive: true });
  run(['git', 'init', '-q', '-b', 'master', dir]);
  if (remote) run(['git', '-C', dir, 'remote', 'add', 'origin', remote]);
}

function commitAll(dir, message) {
  run(['git', '-C', dir, ...GIT_ID, 'add', '.']);
  run(['git', '-C', dir, ...GIT_ID, 'commit', '-q', '-m', message]);
}

// A bare repository with one commit on master, usable as a local "remote".
function bareOrigin(base) {
  const work = path.join(base, 'seed-work');
  gitRepo(work);
  fs.writeFileSync(path.join(work, 'README.md'), 'seed\n');
  commitAll(work, 'seed');
  const bare = path.join(base, 'origin.git');
  run(['git', 'clone', '-q', '--bare', work, bare]);
  return bare;
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-app-repo-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('normalizeRemote gives the same key for http, https, ssh and scp forms and keeps the port in authority', () => {
  const forms = [
    'http://gitlab.example.com/rc_comm/server-af-field-java.git',
    'https://gitlab.example.com/rc_comm/server-af-field-java',
    'ssh://git@gitlab.example.com/rc_comm/server-af-field-java.git',
    'git@gitlab.example.com:rc_comm/server-af-field-java.git',
    'https://user:secret@gitlab.example.com:8443/rc_comm/server-af-field-java.git/',
  ];
  const keys = new Set(forms.map((form) => normalizeRemote(form).key));
  assert.deepEqual([...keys], ['gitlab.example.com/rc_comm/server-af-field-java']);
  const withPort = normalizeRemote(forms[4]);
  assert.equal(withPort.authority, 'gitlab.example.com:8443');
  assert.equal(withPort.port, '8443');
  assert.equal(withPort.host, 'gitlab.example.com');
  assert.equal(normalizeRemote('rc_comm/server-af-field-java').host, '');
  assert.equal(normalizeRemote(''), null);
});

test('repository name, group and web url come from the project path; web url keeps http(s) ports only', () => {
  const url = 'http://gitlab.example.com:8080/credit_platform/sub/server-credit-api-java.git';
  assert.equal(repoNameFromUrl(url), 'server-credit-api-java');
  assert.equal(groupOf(url), 'credit_platform/sub');
  assert.equal(webUrlOf(url), 'http://gitlab.example.com:8080/credit_platform/sub/server-credit-api-java');
  assert.equal(webUrlOf('ssh://git@gitlab.example.com:2222/rc_comm/app.git'), 'https://gitlab.example.com/rc_comm/app');
  assert.equal(webUrlOf('git@gitlab.example.com:rc_comm/app.git'), 'https://gitlab.example.com/rc_comm/app');
});

test('rewriteProtocol keeps the url by default and converts between http, https and ssh without mixing ports', () => {
  const url = 'http://gitlab.example.com:8080/rc_comm/app.git';
  assert.equal(rewriteProtocol(url, undefined), url);
  assert.equal(rewriteProtocol(url, 'https'), 'https://gitlab.example.com:8080/rc_comm/app.git');
  assert.equal(rewriteProtocol(url, 'ssh'), 'git@gitlab.example.com:rc_comm/app.git');
  assert.equal(rewriteProtocol('ssh://git@gitlab.example.com:2222/rc_comm/app.git', 'https'), 'https://gitlab.example.com/rc_comm/app.git');
  assert.equal(rewriteProtocol('ssh://git@gitlab.example.com:2222/rc_comm/app.git', 'ssh'), 'ssh://git@gitlab.example.com:2222/rc_comm/app.git');
  assert.throws(() => rewriteProtocol(url, 'ftp'), /Unsupported --protocol/);
});

test('redact masks userinfo in every URL of a text but leaves other text alone', () => {
  const text = "fatal: unable to access 'https://bob:tok3n@gitlab.example.com/x/y.git/': 403\n{\"remote\": \"http://u@h/x\"} git@h:x/y.git";
  assert.equal(redact(text), "fatal: unable to access 'https://***@gitlab.example.com/x/y.git/': 403\n{\"remote\": \"http://***@h/x\"} git@h:x/y.git");
  assert.equal(redact('plain https://gitlab.example.com/x/y.git'), 'plain https://gitlab.example.com/x/y.git');
});

test('classifyGitFailure separates access, credential and network failures; 404 is access, 5xx is error', () => {
  assert.equal(classifyGitFailure("remote: The project you were looking for could not be found or you don't have permission to view it.\nfatal: repository 'http://g/x/y.git/' not found"), 'no_access');
  assert.equal(classifyGitFailure('remote: You are not allowed to download code from this project.\nfatal: unable to access: The requested URL returned error: 403'), 'no_access');
  assert.equal(classifyGitFailure("fatal: unable to access 'https://g/x/y.git/': The requested URL returned error: 404"), 'no_access');
  assert.equal(classifyGitFailure("fatal: could not read Username for 'https://g': terminal prompts disabled"), 'no_credential');
  assert.equal(classifyGitFailure("remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://g/x/y.git/'"), 'no_credential');
  assert.equal(classifyGitFailure('fatal: unable to access https://g/: Could not resolve host: g'), 'network');
  assert.equal(classifyGitFailure("fatal: unable to access 'https://g/': SSL certificate problem: self signed certificate"), 'network');
  assert.equal(classifyGitFailure('kex_exchange_identification: Connection closed by remote host'), 'network');
  assert.equal(classifyGitFailure("fatal: unable to access 'https://g/x/y.git/': The requested URL returned error: 502"), 'error');
  assert.equal(classifyGitFailure('fatal: something else'), 'error');
});

test('rankApps prefers exact app name, then exact project name, then normalized, then contains', () => {
  const rows = [
    { fid: 1, name: 'server-hawk-decision-executor', project_name: 'server_hawk_decision_executor' },
    { fid: 2, name: 'server-hawk-decision-executor-simulate', project_name: 'server_hawk_decision_executor_simulate' },
  ];
  assert.deepEqual(rankApps(rows, 'server-hawk-decision-executor').map((row) => row.fid), [1]);
  assert.deepEqual(rankApps(rows, 'server_hawk_decision_executor_simulate').map((row) => row.fid), [2]);
  assert.deepEqual(rankApps(rows, 'ServerHawkDecisionExecutor').map((row) => row.fid), [1]);
  assert.deepEqual(rankApps(rows, 'decision-executor').map((row) => row.fid), [1, 2]);
  assert.deepEqual(rankApps(rows, 'nothing'), []);
});

test('nameVariants tries both underscore and hyphen spellings once each', () => {
  assert.deepEqual(nameVariants('server_credit_api'), ['server_credit_api', 'server-credit-api']);
  assert.deepEqual(nameVariants('server-credit-api-java'), ['server-credit-api-java', 'server_credit_api_java']);
  assert.deepEqual(nameVariants('plain'), ['plain']);
});

test('positiveInt accepts omitted or positive integers and rejects the rest', () => {
  assert.equal(positiveInt(undefined, '--timeout', 600000), 600000);
  assert.equal(positiveInt('', '--timeout', 5), 5);
  assert.equal(positiveInt('30', '--timeout', 5), 30);
  for (const bad of ['abc', '0', '-1', '1.5']) assert.throws(() => positiveInt(bad, '--timeout', 5), /--timeout must be a positive integer/);
});

test('parseArgs enforces one selector, values for value options, no values for flags, safe --name', () => {
  assert.deepEqual(parseArgs(['--app=x', '--dir', 'backend/feature', '--json']), { app: 'x', dir: 'backend/feature', json: true });
  assert.throws(() => parseArgs(['--dir', '--branch=master']), /--dir requires a value/);
  assert.throws(() => parseArgs(['--app=x', '--depth']), /--depth requires a value/);
  assert.throws(() => parseArgs(['--app=x', '--repo=y']), /exactly one of --app, --app-id or --repo/);
  assert.throws(() => parseArgs(['--json']), /exactly one of/);
  assert.throws(() => parseArgs(['--app=x', '--bogus=1']), /unknown option --bogus/);
  assert.throws(() => parseArgs(['--app=x', '--json=1']), /--json takes no value/);
  assert.throws(() => parseArgs(['--app=x', 'stray']), /unexpected argument stray/);
  for (const bad of ['../repo', 'a/b', '.hidden', '..']) assert.throws(() => parseArgs(['--app=x', `--name=${bad}`]), /--name must be a single directory name/);
  assert.equal(parseArgs(['--app=x', '--name=my.repo-1_x']).name, 'my.repo-1_x');
});

test('appToRepo keeps only the documented Lexiao fields and derives app_id', () => {
  const repo = appToRepo({ fid: 584, name: 'server-credit-api-java', git_addr: 'http://g/credit_platform/server-credit-api-java.git', owner: 'alice', secret: 'x', jdk: '' });
  assert.deepEqual(repo, { name: 'server-credit-api-java', git_addr: 'http://g/credit_platform/server-credit-api-java.git', owner: 'alice', app_id: 584 });
});

test('scanLocalRepos finds clones (including linked worktrees) by their origin and skips node_modules, nested and hidden dirs', () => {
  withTempDir((workspace) => {
    gitRepo(path.join(workspace, 'backend/feature/server-af-field-java'), 'http://g/rc_comm/server-af-field-java.git');
    gitRepo(path.join(workspace, 'backend/feature/feature-api-compute'), 'https://g/rc_comm/feature-api-compute.git');
    gitRepo(path.join(workspace, 'backend/credit/server-credit-api-java'), 'http://g/credit_platform/server-credit-api-java.git');
    gitRepo(path.join(workspace, 'backend/feature/server-af-field-java/vendor/inner'), 'http://g/other/inner.git');
    gitRepo(path.join(workspace, 'node_modules/dep'), 'http://g/rc_comm/dep.git');
    gitRepo(path.join(workspace, '.hidden/repo'), 'http://g/rc_comm/hidden.git');
    gitRepo(path.join(workspace, 'no-origin'));
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true }); // empty .git at the root must not stop the scan
    // linked worktree: .git is a file pointing at the main repository
    const main = path.join(workspace, 'backend/credit/server-credit-api-java');
    fs.writeFileSync(path.join(main, 'f'), '1');
    commitAll(main, 'c');
    run(['git', '-C', main, 'worktree', 'add', '-q', path.join(workspace, 'backend/credit/credit-wt'), '-b', 'wt']);

    const repos = scanLocalRepos(workspace);
    const rel = repos.map((repo) => [path.relative(workspace, repo.path), repo.remote]).sort();
    assert.deepEqual(rel, [
      ['backend/credit/credit-wt', 'http://g/credit_platform/server-credit-api-java.git'],
      ['backend/credit/server-credit-api-java', 'http://g/credit_platform/server-credit-api-java.git'],
      ['backend/feature/feature-api-compute', 'https://g/rc_comm/feature-api-compute.git'],
      ['backend/feature/server-af-field-java', 'http://g/rc_comm/server-af-field-java.git'],
      ['no-origin', ''],
    ]);

    const clones = findLocalClones(repos, 'git@g:rc_comm/server-af-field-java.git');
    assert.deepEqual(clones.map((repo) => path.relative(workspace, repo.path)), ['backend/feature/server-af-field-java']);
    assert.deepEqual(findLocalClones(repos, 'http://g/rc_comm/new-app.git'), []);

    assert.deepEqual(suggestParentDirs(repos, 'http://g/rc_comm/new-app.git', workspace), [{ dir: 'backend/feature', count: 2 }]);
    assert.deepEqual(suggestParentDirs(repos, 'http://g/credit_platform/new.git', workspace), [{ dir: 'backend/credit', count: 2 }]);
    assert.deepEqual(suggestParentDirs(repos, 'http://g/unknown_group/new-app.git', workspace), []);
    assert.deepEqual(suggestParentDirs(repos, 'http://other-host/rc_comm/new-app.git', workspace), []);
  });
});

test('describePath distinguishes absent, empty dir, dir, file and symlink', () => {
  withTempDir((dir) => {
    assert.equal(describePath(path.join(dir, 'nope')), 'absent');
    fs.mkdirSync(path.join(dir, 'empty'));
    assert.equal(describePath(path.join(dir, 'empty')), 'empty-dir');
    fs.mkdirSync(path.join(dir, 'full'));
    fs.writeFileSync(path.join(dir, 'full/x'), '1');
    assert.equal(describePath(path.join(dir, 'full')), 'dir');
    fs.writeFileSync(path.join(dir, 'file'), '1');
    assert.equal(describePath(path.join(dir, 'file')), 'file');
    fs.symlinkSync(path.join(dir, 'full'), path.join(dir, 'link'));
    assert.equal(describePath(path.join(dir, 'link')), 'symlink');
  });
});

test('probeAccess reports ok for a reachable repository and classifies a missing one', () => {
  withTempDir((base) => {
    const origin = bareOrigin(base);
    const ok = probeAccess(origin, 60000);
    assert.equal(ok.access, 'ok');
    assert.match(ok.head, /^[0-9a-f]{40}$/);
    const missing = probeAccess(path.join(base, 'missing.git'), 60000);
    assert.equal(missing.access, 'error');
    assert.match(missing.detail, /does not appear to be a git repository|No such file/);
  });
});

test('cloneRepo clones through a temporary sibling, refuses existing targets, and leaves no temp dir on failure', () => {
  withTempDir((base) => {
    const origin = bareOrigin(base);
    const parent = path.join(base, 'ws/backend/feature');

    const cloned = cloneRepo(origin, parent, 'app', { depth: 1, timeoutMs: 60000 });
    assert.equal(cloned.status, 'cloned');
    assert.equal(cloned.target, path.join(parent, 'app'));
    assert.equal(cloned.branch, 'master');
    assert.deepEqual(cloned.command, ['git', 'clone', '--depth', '1', '--', origin, path.join(parent, 'app')]);
    assert.equal(fs.readFileSync(path.join(parent, 'app/README.md'), 'utf8'), 'seed\n');
    assert.deepEqual(staleTempDirs(parent), []);

    // non-empty target: refused, untouched
    const again = cloneRepo(origin, parent, 'app', { timeoutMs: 60000 });
    assert.equal(again.status, 'target_exists');
    assert.match(again.detail, /already exists \(dir\)/);
    assert.equal(fs.readFileSync(path.join(parent, 'app/README.md'), 'utf8'), 'seed\n');

    // file and symlink targets: refused
    fs.writeFileSync(path.join(parent, 'afile'), '1');
    assert.equal(cloneRepo(origin, parent, 'afile', { timeoutMs: 60000 }).status, 'target_exists');
    fs.symlinkSync(path.join(parent, 'app'), path.join(parent, 'alink'));
    assert.equal(cloneRepo(origin, parent, 'alink', { timeoutMs: 60000 }).status, 'target_exists');

    // empty directory target: filled in place
    fs.mkdirSync(path.join(parent, 'empty'));
    assert.equal(cloneRepo(origin, parent, 'empty', { timeoutMs: 60000 }).status, 'cloned');
    assert.ok(fs.existsSync(path.join(parent, 'empty/README.md')));

    // failure: nothing left behind, no target created
    const failed = cloneRepo(path.join(base, 'missing.git'), parent, 'broken', { timeoutMs: 60000 });
    assert.equal(failed.status, 'error');
    assert.equal(describePath(path.join(parent, 'broken')), 'absent');
    assert.deepEqual(staleTempDirs(parent), []);

    // an interrupted run's temp dir is reported, not deleted
    fs.mkdirSync(path.join(parent, `${TEMP_PREFIX}leftover`));
    assert.deepEqual(staleTempDirs(parent), [path.join(parent, `${TEMP_PREFIX}leftover`)]);
    assert.equal(cloneRepo(origin, parent, 'another', { timeoutMs: 60000 }).status, 'cloned');
    assert.ok(fs.existsSync(path.join(parent, `${TEMP_PREFIX}leftover`)));
  });
});
