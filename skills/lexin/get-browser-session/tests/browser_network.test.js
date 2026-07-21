'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBrowserEnv,
  chromiumArgsFor,
  redactUrl,
  validateWebShellUrl,
} = require('../scripts/browser_network');

const VALID_URL = 'https://webshell.oa.fenqile.com/?ns=fenqile-prod-gzydjdidc&pod=server-demo-1&container=server-demo&cluster=prod-cluster&command=/bin/bash';

test('internal browser environment removes proxy variables without mutating caller', () => {
  const original = {
    HTTP_PROXY: 'http://127.0.0.1:18181',
    https_proxy: 'http://127.0.0.1:18181',
    NO_PROXY: 'example.test',
  };
  const result = buildBrowserEnv(VALID_URL, original);

  assert.equal(result.networkPolicy, 'direct-internal');
  assert.equal(result.env.HTTP_PROXY, undefined);
  assert.equal(result.env.https_proxy, undefined);
  assert.match(result.env.NO_PROXY, /\.oa\.fenqile\.com/);
  assert.match(result.env.NO_PROXY, /example\.test/);
  assert.equal(original.HTTP_PROXY, 'http://127.0.0.1:18181');
});

test('external browser environment keeps proxy variables', () => {
  const result = buildBrowserEnv('https://example.com/', { HTTPS_PROXY: 'http://proxy' });
  assert.equal(result.networkPolicy, 'default-proxy');
  assert.equal(result.env.HTTPS_PROXY, 'http://proxy');
});

test('internal Chromium receives an isolated no-proxy flag', () => {
  assert.deepEqual(chromiumArgsFor(VALID_URL, ['--no-sandbox']), ['--no-sandbox', '--no-proxy-server']);
  assert.deepEqual(chromiumArgsFor('https://example.com/', ['--no-sandbox']), ['--no-sandbox']);
});

test('canonical Lexiao WebShell URL is validated against Pod metadata', () => {
  const result = validateWebShellUrl(VALID_URL, {
    namespace: 'fenqile-prod-gzydjdidc',
    pod_name: 'server-demo-1',
    cluster_id: 'prod-cluster',
  });
  assert.equal(result.valid, true);
  assert.equal(result.mode, 'canonical');
  assert.equal(result.container, 'server-demo');
});

test('WebShell URL is rejected when container is absent or Pod mismatches', () => {
  const missing = validateWebShellUrl('https://webshell.oa.fenqile.com/?ns=ns&pod=pod&cluster=cluster&command=/bin/bash');
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.includes('URL_PARAM_MISSING_CONTAINER'));

  const mismatch = validateWebShellUrl(VALID_URL, { pod_name: 'another-pod' });
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.errors.includes('URL_TARGET_MISMATCH_PODNAME'));
});

test('legacy arg URL remains usable but is explicitly marked unverifiable', () => {
  const result = validateWebShellUrl('https://webshell.oa.fenqile.com/?arg=opaque');
  assert.equal(result.valid, true);
  assert.equal(result.mode, 'legacy-arg');
  assert.deepEqual(result.warnings, ['LEGACY_ARG_NOT_FIELD_VERIFIABLE']);
});

test('sensitive URL parameters are redacted in diagnostics', () => {
  const value = redactUrl(`${VALID_URL}&ticket=secret-value`);
  assert.doesNotMatch(value, /secret-value/);
  assert.match(value, /ticket=%3Credacted%3E/);
});
