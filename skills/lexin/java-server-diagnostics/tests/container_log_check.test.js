'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildKubectlLogArgs,
  choosePod,
  shouldFallbackFromKubectl,
  toRfc3339,
  webShellArgs,
} = require('../scripts/container_log_check');
const { normalizeQuery } = require('../scripts/log_query');

const PODS = [
  { pod_name: 'app-a', pod_ip: '10.0.0.1', pod_status: 'RUNNING' },
  { pod_name: 'app-b', pod_ip: '10.0.0.2', pod_status: 'Running' },
];

test('Pod selection requires an exact selector when multiple Pods run', () => {
  assert.equal(choosePod(PODS, 'app-a').pod_ip, '10.0.0.1');
  assert.equal(choosePod(PODS, null, '10.0.0.2').pod_name, 'app-b');
  assert.throws(() => choosePod(PODS), (error) => error.code === 'AMBIGUOUS_TARGET');
});

test('kubectl logs command uses exact context, namespace, Pod, and container', () => {
  const pod = { cluster_id: 'prod-cluster', namespace: 'prod-ns', pod_name: 'app-a' };
  const query = normalizeQuery({ from: '2026-07-13 11:39:00', 'max-lines': '500' });
  const args = buildKubectlLogArgs(pod, 'app', {}, query, 'forensics');
  assert.deepEqual(args.slice(0, 8), [
    '--context', 'prod-cluster', '-n', 'prod-ns', 'logs', 'app-a', '-c', 'app',
  ]);
  assert.ok(args.includes('--since-time'));
  assert.ok(args.includes('2026-07-13T03:39:00.000Z'));
});

test('local timestamps are converted to RFC3339 for Kubernetes', () => {
  assert.equal(toRfc3339('2026-07-13 11:39:00'), '2026-07-13T03:39:00.000Z');
});

test('only known Kubernetes context failures permit WebShell fallback', () => {
  assert.equal(shouldFallbackFromKubectl('context prod not found'), true);
  assert.equal(shouldFallbackFromKubectl('Unable to connect to the server'), true);
  assert.equal(shouldFallbackFromKubectl('pods is forbidden: user lacks permission'), false);
});

test('forensics flags are forwarded to WebShell without shell composition', () => {
  const args = webShellArgs({
    app: 'server_demo',
    'trace-id': 'TRACE-1',
    files: 'error.log,info.log',
    'include-rotated': true,
  }, {
    login_pod_addr: 'https://webshell.oa.fenqile.com/?arg=opaque',
    version: 'v1',
  }, 'forensics');
  assert.ok(args.includes('--trace-id'));
  assert.ok(args.includes('--include-rotated'));
  assert.ok(args.includes('error.log,info.log'));
});
