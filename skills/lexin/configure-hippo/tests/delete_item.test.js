'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deleteOptions, diffKeysAfterDelete, parseArgs, releaseDeletedItem, resolveRuntime,
} = require('../scripts/hippo_draft_config');

const target = { key: 'fastdfs_secret_id' };
const active = { configurations: { fastdfs_secret_id: 'abc', fastdfs_secret_key: 'def' } };

test('releaseDeletedItem encodes the Hippo release-modal delete payload', () => {
  const item = releaseDeletedItem(target, { id: 42 }, active);
  assert.deepEqual(item, { id: 0, key: 'fastdfs_secret_id', oldValue: 'abc', newValue: '', type: 'delete' });
});

test('releaseDeletedItem refuses keys that are not in the active release', () => {
  assert.throws(() => releaseDeletedItem({ key: 'missing' }, { id: 1 }, active), (error) => error.code === 'ACTIVE_KEY_MISSING');
});

test('diffKeysAfterDelete keeps the key pending when active still has it', () => {
  assert.deepEqual(diffKeysAfterDelete(['other'], target, active.configurations), ['fastdfs_secret_id', 'other']);
  assert.deepEqual(diffKeysAfterDelete(['fastdfs_secret_id', 'other'], target, { other: 'x' }), ['other']);
});

test('deleteOptions requires explicit authorization and the current token', () => {
  const summarized = { currentStateToken: 'tok', summary: { target: 'demo/fql_pre/default/encryption/k' } };
  assert.throws(() => deleteOptions(parseArgs(['delete-item']), summarized), (error) => error.code === 'DELETE_AUTHORIZATION_REQUIRED');
  assert.throws(() => deleteOptions(parseArgs(['delete-item', '--delete-authorization=explicit']), summarized),
    (error) => error.code === 'EXPECTED_TOKEN_REQUIRED_FOR_DELETE');
  assert.throws(() => deleteOptions(parseArgs(['delete-item', '--delete-authorization=explicit', '--expected-current-token=stale']), summarized),
    (error) => error.code === 'CONCURRENT_DRAFT_CHANGED');
  assert.throws(() => deleteOptions(parseArgs(['delete-item', '--delete-authorization=explicit', '--expected-current-token=tok', '--publish']), summarized),
    (error) => error.code === 'PUBLISH_AUTHORIZATION_REQUIRED');
  const options = deleteOptions(parseArgs(['delete-item', '--delete-authorization=explicit', '--expected-current-token=tok',
    '--publish', '--publish-authorization=explicit', '--release-comment=cleanup']), summarized);
  assert.equal(options.publish, true);
  assert.equal(options.releaseComment, 'cleanup');
});

test('delete-item outside the pre env needs --allow-non-pre', () => {
  assert.throws(() => resolveRuntime(parseArgs(['delete-item', '--app-id=demo', '--namespace=encryption', '--key=k', '--env=gray']), 'delete-item'),
    (error) => error.code === 'NON_PRE_WRITE_REJECTED');
  const runtime = resolveRuntime(parseArgs(['delete-item', '--app-id=demo', '--namespace=encryption', '--key=k', '--env=gray', '--allow-non-pre']), 'delete-item');
  assert.equal(runtime.env, 'fql_gray');
});
