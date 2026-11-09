'use strict';
// namespace-create 的默认授权名单来自 env/credentials.env 的 HIPPO_DEFAULT_GRANT_USERS（经 bin/with-env 加载），仓库里不写死账号。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DEFAULT_GRANT_USERS_ENV, defaultGrantUsers, resolveAutoGrantUsers } = require('../scripts/hippo_draft_config');

const REPO = path.resolve(__dirname, '../../../..');

function withEnv(value, fn) {
  const saved = process.env[DEFAULT_GRANT_USERS_ENV];
  if (value === undefined) delete process.env[DEFAULT_GRANT_USERS_ENV]; else process.env[DEFAULT_GRANT_USERS_ENV] = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[DEFAULT_GRANT_USERS_ENV]; else process.env[DEFAULT_GRANT_USERS_ENV] = saved;
  }
}

test('no HIPPO_DEFAULT_GRANT_USERS: namespace-create grants nobody by default', () => {
  withEnv(undefined, () => {
    assert.deepEqual(defaultGrantUsers(), []);
    assert.deepEqual(resolveAutoGrantUsers({}), []);
  });
  withEnv('   ', () => assert.deepEqual(resolveAutoGrantUsers({}), []));
});

test('HIPPO_DEFAULT_GRANT_USERS is a comma list, de-duplicated, explicit --grant-users still needs authorization', () => {
  withEnv('alice, bob,alice', () => {
    assert.deepEqual(resolveAutoGrantUsers({}), ['alice', 'bob']);
    assert.deepEqual(resolveAutoGrantUsers({ 'no-auto-grant': true }), []);
    assert.throws(() => resolveAutoGrantUsers({ 'grant-users': 'carol' }), /GRANT_AUTHORIZATION_REQUIRED|明确授权/);
  });
  assert.deepEqual(defaultGrantUsers({ [DEFAULT_GRANT_USERS_ENV]: 'dave' }), ['dave']);
});

test('bin/with-env loads the key from the credentials file into the child process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-with-env-'));
  try {
    const envFile = path.join(dir, 'credentials.env');
    fs.writeFileSync(envFile, `${DEFAULT_GRANT_USERS_ENV}=alice,bob\n`);
    fs.chmodSync(envFile, 0o600);
    const run = spawnSync(path.join(REPO, 'bin/with-env'), ['node', '-e', `console.log(process.env.${DEFAULT_GRANT_USERS_ENV} || '')`], {
      encoding: 'utf8', env: { ...process.env, AGENT_TOOLS_ENV_FILE: envFile, [DEFAULT_GRANT_USERS_ENV]: '' },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'alice,bob');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
