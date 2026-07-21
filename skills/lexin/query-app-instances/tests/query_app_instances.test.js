'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePod } = require('../scripts/query_app_instances');

test('Pod normalization preserves Lexiao login URL and records its source', () => {
  const loginUrl = 'https://webshell.oa.fenqile.com/?ns=prod-ns&pod=app-1&container=app&cluster=prod-cluster&command=/bin/bash';
  const pod = normalizePod({
    env: 'prod',
    pod_name: 'app-1',
    pod_ip: '10.0.0.1',
    namespace: 'prod-ns',
    cluster_id: 'prod-cluster',
    login_pod_addr: loginUrl,
  });

  assert.equal(pod.login_pod_addr, loginUrl);
  assert.equal(pod.login_url_source, 'lexiao');
  assert.equal(pod.login_url_validation.valid, true);
  assert.equal(pod.container, 'app');
});

test('missing Lexiao login URL is explicit and never synthesized', () => {
  const pod = normalizePod({ pod_name: 'app-1', namespace: 'prod-ns', cluster_id: 'prod-cluster' });
  assert.equal(pod.login_pod_addr, '');
  assert.equal(pod.login_url_source, 'missing');
  assert.deepEqual(pod.login_url_validation.errors, ['LOGIN_URL_MISSING']);
});
