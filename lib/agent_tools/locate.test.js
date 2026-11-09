'use strict';
// node --test lib/agent_tools/locate.test.js
// 对 locate.js 的 repoRoot() 与 bootstrap.js / bootstrap.mjs 两份模板副本各跑一遍 locate.cases.json。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '../..');
const locate = require('./locate.js');
const CASES = JSON.parse(fs.readFileSync(path.join(HERE, 'locate.cases.json'), 'utf8')).cases;
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

function substitute(value, tree) {
  return typeof value === 'string' ? value.split('${TREE}').join(tree) : value;
}

// 按用例的 tree 建临时目录；返回 {tree, home, pointerFile, cleanup}
function buildTree(testCase) {
  const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'locate-case-')));
  const dirsWithMode = [];
  for (const [relative, spec] of Object.entries(testCase.tree)) {
    const target = path.join(tree, relative);
    if (typeof spec === 'string') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, spec);
    } else {
      fs.mkdirSync(target, { recursive: true });
      if (spec.mode !== undefined) dirsWithMode.push([target, parseInt(spec.mode, 8)]);
    }
  }
  const home = path.join(tree, 'home');
  fs.mkdirSync(home, { recursive: true });
  const pointerFile = path.join(home, '.config/agent-tools/root');
  if (testCase.pointer !== null) {
    fs.mkdirSync(path.dirname(pointerFile), { recursive: true });
    fs.writeFileSync(pointerFile, substitute(testCase.pointer, tree) + '\n');
  }
  for (const [target, mode] of dirsWithMode) fs.chmodSync(target, mode);
  const cleanup = () => {
    for (const [target] of dirsWithMode) fs.chmodSync(target, 0o700);
    fs.rmSync(tree, { recursive: true, force: true });
  };
  return { tree, home, pointerFile, cleanup };
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ['AGENT_TOOLS_ROOT', 'HOME']) saved[key] = process.env[key];
  delete process.env.AGENT_TOOLS_ROOT;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function checkTried(tried, testCase, tree) {
  for (const needle of testCase.expect.tried_contains || []) {
    assert.ok(tried.includes(substitute(needle, tree)), `tried 应含 ${needle}:\n${tried}`);
  }
}

for (const testCase of CASES) {
  test(`locate.js repoRoot: ${testCase.name}`, (t) => {
    if (testCase.requires_non_root && IS_ROOT) return t.skip('以 root 运行时权限用例不成立');
    const { tree, pointerFile, cleanup } = buildTree(testCase);
    try {
      const env = Object.fromEntries(Object.entries(testCase.env).map(([k, v]) => [k, substitute(v, tree)]));
      withEnv(env, () => {
        const start = path.join(tree, testCase.start);
        if (testCase.expect.root !== undefined) {
          const root = locate.repoRoot(start, pointerFile);
          assert.equal(fs.realpathSync(root), path.join(tree, testCase.expect.root));
          if (testCase.expect.tried_contains) {
            // 命中后 tried 不对外暴露：去掉指针文件再跑，仍命中（env 有效）就再去掉 env，失败后取 tried 比对
            const missingPointer = path.join(tree, 'no-pointer-here');
            let tried = '';
            try { locate.repoRoot(start, missingPointer); } catch (error) { tried = error.tried.join('\n'); }
            if (!tried) {
              delete process.env.AGENT_TOOLS_ROOT;
              assert.throws(() => locate.repoRoot(start, missingPointer), (error) => { tried = error.tried.join('\n'); return true; });
            }
            checkTried(tried, testCase, tree);
          }
        } else {
          assert.throws(() => locate.repoRoot(start, pointerFile), (error) => {
            assert.equal(error.code, testCase.expect.error);
            checkTried(error.tried.join('\n'), testCase, tree);
            return true;
          });
        }
      });
    } finally {
      cleanup();
    }
  });
}

// 模板副本：把模板原文加一行打印 root 写进 start 目录，按用例 env 运行
const TEMPLATES = [
  { file: 'bootstrap.js', script: 'probe.js', tail: '\nconsole.log(root);\n', run: ['node'] },
  { file: 'bootstrap.mjs', script: 'probe.mjs', tail: '\nconsole.log(root);\n', run: ['node'] },
  { file: 'bootstrap.py', script: 'probe.py', tail: '\nprint(_root)\n', run: ['python3', '-I'] },
];

for (const template of TEMPLATES) {
  const source = fs.readFileSync(path.join(HERE, template.file), 'utf8');
  for (const testCase of CASES) {
    test(`${template.file}: ${testCase.name}`, (t) => {
      if (testCase.requires_non_root && IS_ROOT) return t.skip('以 root 运行时权限用例不成立');
      const { tree, home, cleanup } = buildTree(testCase);
      try {
        const start = path.join(tree, testCase.start);
        const script = path.join(start, template.script);
        fs.writeFileSync(script, source + template.tail);
        const env = { ...process.env, HOME: home };
        delete env.AGENT_TOOLS_ROOT;
        for (const [k, v] of Object.entries(testCase.env)) env[k] = substitute(v, tree);
        const result = spawnSync(template.run[0], [...template.run.slice(1), script], { env, encoding: 'utf8' });
        if (testCase.expect.root !== undefined) {
          assert.equal(result.status, 0, result.stderr);
          assert.equal(fs.realpathSync(result.stdout.trim()), path.join(tree, testCase.expect.root));
          if (testCase.expect.tried_contains) {
            // 同一脚本在没有指针文件（必要时再去掉 env）的 HOME 下必须失败，失败输出含期望文字
            const emptyHome = path.join(tree, 'empty-home');
            fs.mkdirSync(emptyHome, { recursive: true });
            const failingEnv = { ...env, HOME: emptyHome };
            let failing = spawnSync(template.run[0], [...template.run.slice(1), script], { env: failingEnv, encoding: 'utf8' });
            if (failing.status === 0) {
              delete failingEnv.AGENT_TOOLS_ROOT;
              failing = spawnSync(template.run[0], [...template.run.slice(1), script], { env: failingEnv, encoding: 'utf8' });
            }
            assert.equal(failing.status, 2, failing.stdout + failing.stderr);
            checkTried(failing.stderr, testCase, tree);
          }
        } else {
          assert.equal(result.status, 2, result.stdout + result.stderr);
          checkTried(result.stderr, testCase, tree);
          assert.ok(result.stderr.includes('请在仓库目录运行 python3 install.py'));
        }
      } finally {
        cleanup();
      }
    });
  }
}

test('probe: 目录消失或无权限返回 miss / 异常码而不抛', () => {
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'locate-gone-'));
  fs.rmSync(gone, { recursive: true });
  assert.equal(locate.probe(gone), 'miss');
  assert.equal(locate.probe(''), 'miss');
  assert.equal(locate.probe(REPO), 'hit');
});

test('skillDir 按分类字典序解析到真实 skill 目录', () => {
  assert.equal(locate.skillDir('get-browser-session'), path.join(REPO, 'skills/lexin/get-browser-session'));
  assert.equal(locate.skillDir('dev-design-solution', 'scripts', 'check_mermaid.js'),
    path.join(REPO, 'skills/dev-workflow/dev-design-solution/scripts/check_mermaid.js'));
  assert.throws(() => locate.skillDir('no-such-skill-xyz'), (error) => error.code === 'SKILL_NOT_FOUND');
});

test('docsRoot / workspaceRoot：未设置与无效值都落到默认值', () => {
  withEnv({}, () => {
    delete process.env.AGENT_TOOLS_DOCS_ROOT;
    assert.equal(locate.docsRoot(), path.join(os.homedir(), 'docs'));
    process.env.AGENT_TOOLS_DOCS_ROOT = '~/docs';
    assert.equal(locate.docsRoot(), path.join(os.homedir(), 'docs'));
    process.env.AGENT_TOOLS_DOCS_ROOT = '/srv/docs';
    assert.equal(locate.docsRoot(), '/srv/docs');
    delete process.env.AGENT_TOOLS_DOCS_ROOT;
  });
});

test('platform 返回三值之一', () => {
  assert.ok(['darwin', 'wsl', 'linux'].includes(locate.platform()));
});

test('openExternal：自定义模板按首词可执行性生效，退出码非 0 返回 false', () => {
  const saved = process.env.AGENT_TOOLS_OPEN_CMD;
  try {
    process.env.AGENT_TOOLS_OPEN_CMD = '/bin/sh -c true {target}';
    assert.equal(locate.openExternal('https://example.invalid'), true);
    process.env.AGENT_TOOLS_OPEN_CMD = '/bin/sh -c false {target}';
    assert.equal(locate.openExternal('https://example.invalid'), false);
  } finally {
    if (saved === undefined) delete process.env.AGENT_TOOLS_OPEN_CMD;
    else process.env.AGENT_TOOLS_OPEN_CMD = saved;
  }
});
