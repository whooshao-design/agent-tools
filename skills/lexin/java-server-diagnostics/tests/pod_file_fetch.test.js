'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildScript, parseArgs, parseOutput, resolveMaxBytes, validateTarget } = require('../scripts/pod_file_fetch');

const MARKERS = { begin: '__BEGIN__', end: '__END__' };

test('validateTarget only accepts plain absolute paths under the app publish directory', () => {
  const root = '/home/publish_product/server_java/demo_app';
  assert.equal(validateTarget('demo_app', `${root}/decision_ser_file/a.ser`), `${root}/decision_ser_file/a.ser`);
  assert.equal(validateTarget('demo_app', `${root}//x/`), `${root}/x/`);
  assert.equal(validateTarget('demo_app', root), root);
  for (const bad of [`${root}/../other/x`, '/etc/passwd', `${root}_evil/x`, `${root}/a b`, `${root}/$(id)`, `${root}/a;rm`, `${root}/a'b`, 'relative/x', `${root}/a\nb`]) {
    assert.throws(() => validateTarget('demo_app', bad), /--path/, bad);
  }
  assert.throws(() => validateTarget('demo app', `${root}/x`), /--app/);
  assert.throws(() => validateTarget('../x', '/home/publish_product/server_java/../x/y'), /--app/);
});

test('resolveMaxBytes has a default and a hard ceiling', () => {
  assert.equal(resolveMaxBytes(undefined), 20 * 1024 * 1024);
  assert.equal(resolveMaxBytes('1024'), 1024);
  for (const bad of ['0', '-1', 'abc', String(32 * 1024 * 1024 + 1)]) assert.throws(() => resolveMaxBytes(bad), /--max-bytes/);
});

test('buildScript rejects unknown actions and embeds nothing but the fixed template and the path', () => {
  assert.throws(() => buildScript('exec', '/x', MARKERS), /--action/);
  const script = buildScript('fetch', '/home/publish_product/server_java/a/f.ser', MARKERS, 1000);
  assert.ok(script.startsWith("p='/home/publish_product/server_java/a/f.ser'\nroot='/'\necho __BEGIN__\n"));
  assert.ok(script.includes('-le 1000 ]'));
  assert.ok(!buildScript('stat', '/x', MARKERS).includes('base64 -w'));
});

// Runs the generated script with local bash against a temp tree, the way the Pod would, and adds terminal noise.
function runLocally(action, target, maxBytes, root = '/') {
  const run = spawnSync('bash', ['-c', buildScript(action, target, MARKERS, maxBytes, root)], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return `$ base64 -d <<'X' | bash\n${run.stdout.replace(/\n/g, '\r\n')}`.replace(/\r/g, '');
}

test('list, stat and fetch round-trip a binary file through the generated script', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-file-fetch-'));
  try {
    const content = crypto.randomBytes(200000);
    const file = path.join(dir, 'pkg.ser');
    fs.writeFileSync(file, content);
    fs.writeFileSync(path.join(dir, 'other.txt'), 'x');
    const md5 = crypto.createHash('md5').update(content).digest('hex');

    const list = parseOutput('list', runLocally('list', dir), MARKERS);
    assert.equal(list.kind, 'dir');
    assert.equal(list.entries.length, 2);
    assert.equal(list.total, 2);
    assert.equal(list.truncated, false);
    assert.ok(list.entries.some((line) => line.endsWith('pkg.ser')));

    assert.deepEqual({ ...parseOutput('stat', runLocally('stat', file), MARKERS), mtime: '' }, { kind: 'file', size: 200000, mtime: '', md5 });

    const fetched = parseOutput('fetch', runLocally('fetch', file), MARKERS);
    assert.equal(fetched.errorCode, undefined);
    assert.ok(fetched.content.equals(content));

    assert.equal(parseOutput('fetch', runLocally('fetch', file, 1000), MARKERS).errorCode, 'FILE_TOO_LARGE');
    assert.equal(parseOutput('stat', runLocally('stat', path.join(dir, 'nope')), MARKERS).errorCode, 'PATH_MISSING');
    assert.equal(parseOutput('stat', runLocally('stat', dir), MARKERS).errorCode, 'NOT_A_FILE');
    assert.equal(parseOutput('list', runLocally('list', path.join(dir, 'nope')), MARKERS).errorCode, 'PATH_MISSING');
    assert.equal(parseOutput('list', runLocally('list', file), MARKERS).errorCode, 'NOT_A_DIR');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseOutput refuses truncated or corrupted transfers', () => {
  const content = Buffer.from('hello world');
  const md5 = crypto.createHash('md5').update(content).digest('hex');
  const head = `__BEGIN__\nKIND=file\nSIZE=${content.length}\nMTIME=x\nMD5=${md5}\n`;
  const good = `${head}__POD_FILE_B64_BEGIN__\n${content.toString('base64')}\n__POD_FILE_B64_END__\n__END__`;
  assert.ok(parseOutput('fetch', good, MARKERS).content.equals(content));
  const corrupted = good.replace(content.toString('base64'), Buffer.from('hello w0rld').toString('base64'));
  assert.equal(parseOutput('fetch', corrupted, MARKERS).errorCode, 'VERIFY_FAILED');
  assert.equal(parseOutput('fetch', `${head}__POD_FILE_B64_BEGIN__\naGVsbG8=\n__END__`, MARKERS).errorCode, 'OUTPUT_INCOMPLETE');
  assert.equal(parseOutput('fetch', good.replace('__END__', ''), MARKERS).errorCode, 'OUTPUT_INCOMPLETE');
  assert.equal(parseOutput('stat', '__BEGIN__\nMISSING_TOOL=md5sum\nKIND=file\n__END__', MARKERS).errorCode, 'REMOTE_TOOL_MISSING');
});

test('symlinks are resolved in the Pod: inside the root they work, outside the root they are refused', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-file-fetch-link-'));
  try {
    const root = path.join(base, 'app');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(root, 'v1'), { recursive: true });
    fs.mkdirSync(outside);
    const content = Buffer.from('inside-content');
    fs.writeFileSync(path.join(root, 'v1', 'a.ser'), content);
    fs.writeFileSync(path.join(root, 'v1', 'b.ser'), 'b');
    fs.writeFileSync(path.join(outside, 'secret'), 'secret-content');
    fs.symlinkSync(path.join(root, 'v1'), path.join(root, 'current'));          // dir link inside the root
    fs.symlinkSync(path.join(root, 'v1', 'a.ser'), path.join(root, 'latest'));  // file link inside the root
    fs.symlinkSync(outside, path.join(root, 'escape'));                         // dir link leaving the root
    fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'leak'));      // file link leaving the root
    const md5 = crypto.createHash('md5').update(content).digest('hex');

    const viaDir = parseOutput('stat', runLocally('stat', path.join(root, 'current', 'a.ser'), undefined, root), MARKERS);
    assert.deepEqual([viaDir.size, viaDir.md5], [content.length, md5]);
    const viaFile = parseOutput('fetch', runLocally('fetch', path.join(root, 'latest'), undefined, root), MARKERS);
    assert.ok(viaFile.content.equals(content)); // size is the target's, not the link's
    const listed = parseOutput('list', runLocally('list', path.join(root, 'current'), undefined, root), MARKERS);
    assert.deepEqual([listed.total, listed.truncated, listed.entries.length], [2, false, 2]);

    for (const [action, target] of [['stat', path.join(root, 'escape', 'secret')], ['fetch', path.join(root, 'leak')], ['list', path.join(root, 'escape')], ['stat', path.join(outside, 'secret')]]) {
      const result = parseOutput(action, runLocally(action, target, undefined, root), MARKERS);
      assert.equal(result.errorCode, 'PATH_OUTSIDE_ROOT', `${action} ${target}`);
      assert.equal(result.content, undefined);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an empty SIZE is not read as zero, and unknown options are rejected', () => {
  const md5 = 'd41d8cd98f00b204e9800998ecf8427e';
  assert.equal(parseOutput('stat', `__BEGIN__\nKIND=file\nSIZE=\nMTIME=x\nMD5=${md5}\n__END__`, MARKERS).errorCode, 'OUTPUT_INCOMPLETE');
  assert.equal(parseOutput('stat', `__BEGIN__\nKIND=file\nSIZE=0\nMTIME=x\nMD5=${md5}\n__END__`, MARKERS).size, 0);
  assert.throws(() => parseArgs(['--screenshot=/tmp/x']), /unknown option --screenshot/);
  assert.throws(() => parseArgs(['--chrome=/bin/sh']), /unknown option --chrome/);
  assert.equal(parseArgs(['--action=stat', '--headed']).headed, true);
});
