'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deleteAuthorizationValue, deleteOptions, deletePlanSummary, diffKeysAfterDelete, isPublicNamespaceName,
  parseArgs, releaseDeletedItem, resolveRuntime,
} = require('../scripts/hippo_draft_config');

const target = { appId: 'demo', env: 'fql_pre', namespaceName: 'encryption', key: 'fastdfs_secret_id' };
const active = { release: { id: 9, releaseKey: 'r1' }, configurations: { fastdfs_secret_id: 'abc', fastdfs_secret_key: 'def' } };
const summarized = {
  currentStateToken: 'tok',
  active,
  summary: { target: 'demo/fql_pre/default/encryption/fastdfs_secret_id', draftExists: true, activeExists: true },
};
const impact = { activeReleaseId: 9, instancesOnActiveRelease: 4, instanceSample: [], instancesTruncated: false };
const good = ['delete-item', '--delete-authorization=demo/fql_pre/encryption/fastdfs_secret_id', '--confirm-env=fql_pre',
  '--expected-current-token=tok', '--expected-instances=4'];
const rejects = (argv, code, t = target, i = impact) => assert.throws(() => deleteOptions(parseArgs(argv), summarized, t, i), (error) => error.code === code);

test('releaseDeletedItem encodes the Hippo release-modal delete payload', () => {
  assert.deepEqual(releaseDeletedItem(target, { id: 42 }, active), { id: 0, key: 'fastdfs_secret_id', oldValue: 'abc', newValue: '', type: 'delete' });
  assert.throws(() => releaseDeletedItem({ key: 'missing' }, { id: 1 }, active), (error) => error.code === 'ACTIVE_KEY_MISSING');
});

test('diffKeysAfterDelete keeps the key pending when active still has it', () => {
  assert.deepEqual(diffKeysAfterDelete(['other'], target, active.configurations), ['fastdfs_secret_id', 'other']);
  assert.deepEqual(diffKeysAfterDelete(['fastdfs_secret_id', 'other'], target, { other: 'x' }), ['other']);
});

test('delete authorization must be the exact target path, never a constant', () => {
  assert.equal(deleteAuthorizationValue(target), 'demo/fql_pre/encryption/fastdfs_secret_id');
  rejects(['delete-item', '--delete-authorization=explicit', '--confirm-env=fql_pre', '--expected-current-token=tok', '--expected-instances=4'], 'DELETE_AUTHORIZATION_REQUIRED');
  rejects(['delete-item', '--delete-authorization=demo/fql_gray/encryption/fastdfs_secret_id', '--confirm-env=fql_pre', '--expected-current-token=tok', '--expected-instances=4'], 'DELETE_AUTHORIZATION_REQUIRED');
  rejects(['delete-item', '--delete-authorization=demo/fql_pre/encryption/fastdfs_secret_key', '--confirm-env=fql_pre', '--expected-current-token=tok', '--expected-instances=4'], 'DELETE_AUTHORIZATION_REQUIRED');
});

test('delete-item needs env confirmation, the plan token and the plan instance count', () => {
  rejects(['delete-item', '--delete-authorization=demo/fql_pre/encryption/fastdfs_secret_id', '--expected-current-token=tok', '--expected-instances=4'], 'DELETE_ENV_CONFIRMATION_REQUIRED');
  rejects(['delete-item', '--delete-authorization=demo/fql_pre/encryption/fastdfs_secret_id', '--confirm-env=fql_gray', '--expected-current-token=tok', '--expected-instances=4'], 'DELETE_ENV_CONFIRMATION_REQUIRED');
  rejects(['delete-item', '--delete-authorization=demo/fql_pre/encryption/fastdfs_secret_id', '--confirm-env=fql_pre', '--expected-instances=4'], 'EXPECTED_TOKEN_REQUIRED_FOR_DELETE');
  rejects(['delete-item', '--delete-authorization=demo/fql_pre/encryption/fastdfs_secret_id', '--confirm-env=fql_pre', '--expected-current-token=stale', '--expected-instances=4'], 'CONCURRENT_DRAFT_CHANGED');
  rejects(['delete-item', '--delete-authorization=demo/fql_pre/encryption/fastdfs_secret_id', '--confirm-env=fql_pre', '--expected-current-token=tok'], 'EXPECTED_INSTANCES_REQUIRED');
  rejects(['delete-item', '--delete-authorization=demo/fql_pre/encryption/fastdfs_secret_id', '--confirm-env=fql_pre', '--expected-current-token=tok', '--expected-instances=3'], 'INSTANCE_COUNT_CHANGED');
});

test('public namespaces are refused unless explicitly allowed', () => {
  assert.equal(isPublicNamespaceName('hippo.encryption'), true);
  assert.equal(isPublicNamespaceName('encryption'), false);
  const pub = { ...target, namespaceName: 'hippo.encryption' };
  rejects(['delete-item', '--delete-authorization=demo/fql_pre/hippo.encryption/fastdfs_secret_id', '--confirm-env=fql_pre', '--expected-current-token=tok', '--expected-instances=4'], 'PUBLIC_NAMESPACE_DELETE_REJECTED', pub);
  const ok = deleteOptions(parseArgs(['delete-item', '--delete-authorization=demo/fql_pre/hippo.encryption/fastdfs_secret_id', '--confirm-env=fql_pre',
    '--expected-current-token=tok', '--expected-instances=4', '--allow-public-namespace']), summarized, pub, impact);
  assert.equal(ok.publish, false);
});

test('publishing a deletion needs its own explicit publish authorization', () => {
  rejects([...good, '--publish'], 'PUBLISH_AUTHORIZATION_REQUIRED');
  const options = deleteOptions(parseArgs([...good, '--publish', '--publish-authorization=explicit', '--release-comment=cleanup']), summarized, target, impact);
  assert.equal(options.publish, true);
  assert.equal(options.releaseComment, 'cleanup');
});

test('delete-plan summary exposes the values the operator must echo back', () => {
  const plan = deletePlanSummary(target, summarized, impact);
  assert.equal(plan.deleteAuthorizationValue, 'demo/fql_pre/encryption/fastdfs_secret_id');
  assert.equal(plan.confirmEnvValue, 'fql_pre');
  assert.equal(plan.instancesOnActiveRelease, 4);
  assert.deepEqual(plan.activeKeysRemainingAfterDelete, ['fastdfs_secret_key']);
  assert.equal(plan.releaseNeededToTakeEffect, true);
});

test('delete-item outside the pre env needs --allow-non-pre', () => {
  assert.throws(() => resolveRuntime(parseArgs(['delete-item', '--app-id=demo', '--namespace=encryption', '--key=k', '--env=gray']), 'delete-item'),
    (error) => error.code === 'NON_PRE_WRITE_REJECTED');
  assert.equal(resolveRuntime(parseArgs(['delete-item', '--app-id=demo', '--namespace=encryption', '--key=k', '--env=gray', '--allow-non-pre']), 'delete-item').env, 'fql_gray');
});
