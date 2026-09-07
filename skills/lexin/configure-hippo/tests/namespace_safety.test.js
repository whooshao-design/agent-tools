'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  namespaceNamesFrom, namespacePermissionDetails, parseArgs, resolveRuntime, runNamespaceCommand,
} = require('../scripts/hippo_draft_config');

const args = {
  env: 'stable', 'app-id': 'demo', namespace: 'sample', comment: 'sample namespace config',
};
const ok = (data) => ({ ok: true, status: 200, json: true, data });

function mockPage(options = {}) {
  let created = false;
  const counts = { create: 0, grants: 0 };
  const roles = { modifyRoleUsers: [], releaseRoleUsers: [] };
  const page = {
    waitForTimeout: async () => {},
    evaluate: async (_callback, request) => {
      if (request && typeof request === 'object') {
        if (request.appNamespace) {
          counts.create += 1;
          created = true;
          return { id: 1, appId: 'demo', name: 'sample' };
        }
        if (request.targetRoleType) {
          counts.grants += 1;
          const field = request.targetRoleType === 'ModifyNamespace' ? 'modifyRoleUsers' : 'releaseRoleUsers';
          roles[field].push({ userId: request.targetUser });
          return {};
        }
        throw new Error('unexpected page action');
      }
      if (request === '/apps/demo') return ok({ appId: 'demo', type: 1, orgId: 'example', ownerName: 'owner' });
      if (request.endsWith('/navtree')) return ok({ entities: ['fql_pre', 'fql_prod'].map((env) => ({
        body: { env: { name: env }, clusters: [{ name: 'default' }] },
      })) });
      if (request.endsWith('/findNamespaceGroupsByAppId')) return ok([]);
      if (request.endsWith('/permissions/createNamespace') || request.endsWith('/permissions/AssignRole')) return ok({ hasPermission: true });
      if (request === '/page-settings') return ok({ canAppAdminCreatePrivateNamespace: true });
      if (request === '/user') return ok({ userId: 'owner' });
      if (request.endsWith('/role_users')) return ok(roles);
      const exists = created && !(options.missingProd && request.includes('/envs/fql_prod/'));
      if (request.includes('/namespacePubTypes/')) {
        if (options.badList && created) return ok({ error: 'upstream failed' });
        return ok({ elements: exists ? [{ namespaceName: 'sample' }] : [] });
      }
      if (request.includes('/releases/active')) return options.active || ok([]);
      if (request.endsWith('/namespaces/sample')) {
        if (!exists) return { ok: false, status: 404, json: true, data: {} };
        if (options.badDetail) return { ok: true, status: 200, json: false, data: null };
        return ok({ baseInfo: { id: 1, namespaceName: 'sample', groupPath: '', isEncrypt: false },
          format: 'properties', isPublic: false, items: [],
          groupId: options.badGroup ? 2 : 0,
          comment: options.badComment ? 'different comment' : args.comment });
      }
      throw new Error(`unexpected mock GET: ${request}`);
    },
  };
  return { page, counts };
}

async function createWith(options = {}, extra = {}) {
  const mock = mockPage(options);
  const runtime = resolveRuntime(args, 'namespace-create');
  const plan = await runNamespaceCommand('namespace-plan', runtime, args, mock.page);
  return { ...mock, run: () => runNamespaceCommand('namespace-create', runtime, {
    ...args, 'create-authorization': 'explicit', 'expected-current-token': plan.currentStateToken, ...extra,
  }, mock.page) };
}

test('namespace lists reject error objects and malformed rows, preserving known variants', () => {
  for (const invalid of [null, {}, { error: 'failed' }, { elements: {} }, [{}]]) {
    assert.throws(() => namespaceNamesFrom(invalid), { code: 'NAMESPACE_LIST_INVALID' });
  }
  assert.deepEqual(namespaceNamesFrom({ content: [{ namespaceName: 'a' }] }), ['a']);
  assert.deepEqual(namespaceNamesFrom({ elements: [] }), []);
});

for (const site of ['stable', 'mx', 'id']) {
  test(`grant command preserves ${site}, environment and custom cluster`, async () => {
    const runtime = resolveRuntime({ ...args, 'hippo-site': site, env: site === 'stable' ? 'fql_pre' : 'prod', cluster: "team'alpha", key: 'key' }, 'plan');
    const details = await namespacePermissionDetails(mockPage().page, runtime.target, { roleNamespace: 'sample' });
    const commandArgs = parseArgs(details.grantArgv.slice(2));
    const restored = resolveRuntime(commandArgs, 'namespace-grant');
    assert.equal(restored.site, runtime.site);
    assert.equal(restored.env, runtime.env);
    assert.equal(restored.baseUrl, runtime.baseUrl);
    assert.equal(restored.namespace.cluster, runtime.target.cluster);
    assert.ok(details.grantCommand.includes("'--cluster=team'\\''alpha'"));
  });
}

for (const [label, extra, code] of [
  ['invalid role', { roles: 'admin' }, 'NAMESPACE_ROLE_INVALID'],
  ['unauthorized user', { 'grant-users': 'someoneelse' }, 'GRANT_AUTHORIZATION_REQUIRED'],
  ['invalid user', { 'grant-users': 'bad user', 'grant-authorization': 'explicit' }, 'GRANT_USER_INVALID'],
]) {
  test(`${label} is rejected before the first creation`, async () => {
    const mock = await createWith({}, extra);
    await assert.rejects(mock.run, { code });
    assert.deepEqual(mock.counts, { create: 0, grants: 0 });
  });
}

for (const [label, options, code] of [
  ['active 403', { active: { ok: false, status: 403, json: true, data: {} } }, 'NAMESPACE_ACTIVE_VERIFY_FAILED'],
  ['active HTML', { active: { ok: true, status: 200, json: false, data: null } }, 'NAMESPACE_ACTIVE_VERIFY_FAILED'],
  ['active error JSON', { active: ok({ error: 'failed' }) }, 'NAMESPACE_ACTIVE_VERIFY_FAILED'],
  ['list error JSON', { badList: true }, 'NAMESPACE_LIST_INVALID'],
  ['detail HTML', { badDetail: true }, 'NAMESPACE_PROBE_FAILED'],
  ['missing prod', { missingProd: true }, 'NAMESPACE_VERIFY_FAILED'],
  ['comment mismatch', { badComment: true }, 'NAMESPACE_VERIFY_FAILED'],
  ['group mismatch', { badGroup: true }, 'NAMESPACE_VERIFY_FAILED'],
  ['unexpected release', { active: ok([{ releaseKey: 'unexpected' }]) }, 'NAMESPACE_UNEXPECTED_RELEASE'],
]) {
  test(`${label} stops after creation without granting roles or recreating`, async () => {
    const mock = await createWith(options);
    await assert.rejects(mock.run, { code });
    assert.deepEqual(mock.counts, { create: 1, grants: 0 });
  });
}

test('verified creation keeps the existing default grant policy and both environments', async () => {
  const mock = await createWith();
  const result = await mock.run();
  assert.equal(result.created, true);
  assert.deepEqual(result.createdEnvs, ['fql_pre', 'fql_prod']);
  assert.deepEqual(result.fieldMismatches, []);
  assert.equal(result.hasActiveRelease, false);
  assert.equal(result.autoGrant.nonTargetRoleUsersUnchanged, true);
  assert.deepEqual(mock.counts, { create: 1, grants: 2 });
});
