'use strict';

const INTERNAL_HOST_SUFFIXES = [
  '.oa.fenqile.com',
  '.lexincloud.com',
  '.fql.com',
];
const INTERNAL_NO_PROXY = [
  '.oa.fenqile.com',
  '.lexincloud.com',
  '.fql.com',
  'localhost',
  '127.0.0.1',
];
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];
const WEBSHELL_HOSTS = new Set(['webshell.oa.fenqile.com']);
const SENSITIVE_QUERY_PATTERN = /ticket|token|auth|session|cookie|code/i;

function urlOf(value) {
  try {
    return new URL(String(value || ''));
  } catch (_) {
    return null;
  }
}

function hostMatchesSuffix(host, suffix) {
  const root = suffix.startsWith('.') ? suffix.slice(1) : suffix;
  return host === root || host.endsWith(suffix);
}

function isInternalUrl(value) {
  const parsed = urlOf(value);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return INTERNAL_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(host, suffix));
}

function isWebShellUrl(value) {
  const parsed = urlOf(value);
  return Boolean(parsed && WEBSHELL_HOSTS.has(parsed.hostname.toLowerCase()));
}

function mergeNoProxy(current, additions = INTERNAL_NO_PROXY) {
  const values = String(current || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of additions) {
    if (!values.includes(item)) values.push(item);
  }
  return values.join(',');
}

function buildBrowserEnv(targetUrl, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (!isInternalUrl(targetUrl)) {
    return { env, networkPolicy: 'default-proxy' };
  }
  for (const key of PROXY_ENV_KEYS) delete env[key];
  const noProxy = mergeNoProxy(env.NO_PROXY || env.no_proxy);
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  return { env, networkPolicy: 'direct-internal' };
}

function chromiumArgsFor(targetUrl, baseArgs = []) {
  const args = [...baseArgs];
  if (isInternalUrl(targetUrl) && !args.includes('--no-proxy-server')) {
    args.push('--no-proxy-server');
  }
  return args;
}

function redactUrl(value) {
  const parsed = urlOf(value);
  if (!parsed) return String(value || '');
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (SENSITIVE_QUERY_PATTERN.test(key)) parsed.searchParams.set(key, '<redacted>');
  }
  return parsed.toString();
}

function validateWebShellUrl(value, target = {}) {
  const errors = [];
  const warnings = [];
  const parsed = urlOf(value);
  if (!parsed) {
    return {
      valid: false,
      mode: 'invalid',
      errors: ['URL_PARSE_FAILED'],
      warnings,
      container: target.container || '',
      redactedUrl: String(value || ''),
    };
  }

  if (parsed.protocol !== 'https:') errors.push('URL_SCHEME_NOT_HTTPS');
  if (!WEBSHELL_HOSTS.has(parsed.hostname.toLowerCase())) errors.push('URL_HOST_NOT_ALLOWED');

  const values = {
    namespace: parsed.searchParams.get('ns') || '',
    podName: parsed.searchParams.get('pod') || '',
    container: parsed.searchParams.get('container') || target.container || '',
    clusterId: parsed.searchParams.get('cluster') || '',
    command: parsed.searchParams.get('command') || '',
  };
  const hasCanonicalParameter = ['ns', 'pod', 'container', 'cluster', 'command']
    .some((name) => parsed.searchParams.has(name));
  const hasLegacyArg = parsed.searchParams.has('arg');
  let mode = 'canonical';

  if (hasCanonicalParameter) {
    const required = [
      ['ns', values.namespace],
      ['pod', values.podName],
      ['container', values.container],
      ['cluster', values.clusterId],
      ['command', values.command],
    ];
    for (const [name, current] of required) {
      if (!current) errors.push(`URL_PARAM_MISSING_${name.toUpperCase()}`);
    }
    if (values.command && !['/bin/bash', '/bin/sh'].includes(values.command)) {
      errors.push('URL_COMMAND_NOT_ALLOWED');
    }
  } else if (hasLegacyArg) {
    mode = 'legacy-arg';
    warnings.push('LEGACY_ARG_NOT_FIELD_VERIFIABLE');
  } else {
    mode = 'unknown';
    errors.push('URL_REQUIRED_PARAMS_MISSING');
  }

  const expected = {
    namespace: target.namespace || '',
    podName: target.pod_name || target.podName || '',
    clusterId: target.cluster_id || target.clusterId || '',
    container: target.container || '',
  };
  for (const name of ['namespace', 'podName', 'clusterId', 'container']) {
    if (mode === 'canonical' && expected[name] && values[name] && expected[name] !== values[name]) {
      errors.push(`URL_TARGET_MISMATCH_${name.toUpperCase()}`);
    }
  }

  return {
    valid: errors.length === 0,
    mode,
    errors,
    warnings,
    ...values,
    redactedUrl: redactUrl(parsed.toString()),
  };
}

module.exports = {
  INTERNAL_NO_PROXY,
  PROXY_ENV_KEYS,
  WEBSHELL_HOSTS,
  buildBrowserEnv,
  chromiumArgsFor,
  isInternalUrl,
  isWebShellUrl,
  mergeNoProxy,
  redactUrl,
  validateWebShellUrl,
};
