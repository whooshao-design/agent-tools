#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { buildBrowserEnv, validateWebShellUrl } = require('../../get-browser-session/scripts/browser_network');
const { asBoolean, normalizeQuery, queryLogText } = require('./log_query');

const QUERY_SCRIPT = '/home/joney/projects/ai/agent-tools/skills/lexin/query-app-instances/scripts/query_app_instances.js';
const WEBSHELL_SCRIPT = '/home/joney/projects/ai/agent-tools/skills/lexin/java-server-diagnostics/scripts/webshell_log_check.js';

class DiagnosticError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const equalsIndex = item.indexOf('=');
    if (equalsIndex !== -1) {
      args[item.slice(2, equalsIndex)] = item.slice(equalsIndex + 1);
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args[item.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      args[item.slice(2)] = true;
    }
  }
  return args;
}

function usage() {
  console.log(`Usage:
  container_log_check.js --app=<app_name> --env=<env> [--pod=<pod>|--ip=<pod_ip>] [options]

Target and access:
  --profile=<browser-profile>
  --pod=<exact-pod-name> --ip=<exact-pod-ip>

Log query:
  --log-mode=quick|forensics
  --lines=120 --since-minutes=60
  --include-startup
  --from="YYYY-MM-DD HH:mm:ss" --to="YYYY-MM-DD HH:mm:ss"
  --trace-id=<id> --rule-id=<id> --keyword=<literal>
  --files=error.log,info.log --context=2 --include-rotated
  --max-lines=500 --max-bytes=1048576
`);
}

function runNode(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    env: options.env || process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim();
    throw new Error(`${script} failed with exit ${result.status}: ${message}`);
  }
  return result.stdout;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`failed to parse ${label} JSON: ${error.message}`);
  }
}

function isRunning(pod) {
  return String(pod.pod_status || '').toLowerCase() === 'running';
}

function choosePod(pods, wantedPod, wantedIp) {
  if (!Array.isArray(pods) || pods.length === 0) {
    throw new DiagnosticError('INSTANCE_NOT_FOUND', 'no pod instances returned');
  }
  if (wantedPod) {
    const matched = pods.find((pod) => pod.pod_name === wantedPod);
    if (!matched) throw new DiagnosticError('INSTANCE_NOT_FOUND', `pod not found: ${wantedPod}`);
    return matched;
  }
  if (wantedIp) {
    const matched = pods.filter((pod) => pod.pod_ip === wantedIp);
    if (matched.length === 1) return matched[0];
    if (matched.length === 0) throw new DiagnosticError('INSTANCE_NOT_FOUND', `pod ip not found: ${wantedIp}`);
    throw new DiagnosticError('AMBIGUOUS_TARGET', `multiple pods matched ip: ${wantedIp}`);
  }
  const running = pods.filter(isRunning);
  if (running.length === 1) return running[0];
  if (running.length === 0) throw new DiagnosticError('INSTANCE_NOT_FOUND', 'no running pod instances returned');
  throw new DiagnosticError('AMBIGUOUS_TARGET', 'multiple running pods found; pass --pod or --ip', {
    candidates: running.map((pod) => ({ pod_name: pod.pod_name, pod_ip: pod.pod_ip })),
  });
}

function checkKubectlContext(context) {
  const result = spawnSync('kubectl', ['config', 'get-contexts', '-o', 'name'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    return { kubectlAvailable: false, contextAvailable: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return {
      kubectlAvailable: true,
      contextAvailable: false,
      error: (result.stderr || result.stdout || '').trim(),
    };
  }
  const contexts = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    kubectlAvailable: true,
    contextAvailable: contexts.includes(context),
    context,
  };
}

function toRfc3339(value) {
  if (!value) return '';
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  if (!match) throw new DiagnosticError('INVALID_LOG_QUERY', `invalid timestamp: ${value}`);
  const date = new Date(`${match[1]}T${match[2]}+08:00`);
  if (Number.isNaN(date.getTime())) throw new DiagnosticError('INVALID_LOG_QUERY', `invalid timestamp: ${value}`);
  return date.toISOString();
}

function buildKubectlLogArgs(pod, container, args, query, logMode) {
  const command = [
    '--context', pod.cluster_id,
    '-n', pod.namespace,
    'logs', pod.pod_name,
  ];
  if (container) command.push('-c', container);
  if (query && query.from) {
    command.push('--since-time', toRfc3339(query.from));
  } else if (args['since-minutes']) {
    const minutes = Number(args['since-minutes']);
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 10080) {
      throw new DiagnosticError('INVALID_LOG_QUERY', '--since-minutes must be between 1 and 10080');
    }
    command.push('--since', `${minutes}m`);
  }

  const tail = logMode === 'forensics'
    ? Math.min(Math.max(query.maxLines * 10, 500), 5000)
    : Number(args.lines || 120);
  command.push('--tail', String(tail));
  return command;
}

function runKubectlLogs(pod, container, args, query, logMode) {
  const command = buildKubectlLogArgs(pod, container, args, query, logMode);
  const result = spawnSync('kubectl', command, {
    encoding: 'utf8',
    maxBuffer: Math.max((query && query.maxBytes ? query.maxBytes : 1024 * 1024) * 4, 20 * 1024 * 1024),
  });
  if (result.error) {
    return { ok: false, command, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, command, error: (result.stderr || result.stdout || '').trim() };
  }

  const effectiveQuery = query || normalizeQuery({
    'max-lines': String(args.lines || 120),
    'max-bytes': String(args['max-bytes'] || 1024 * 1024),
  });
  return {
    ok: true,
    command,
    queryResult: queryLogText(result.stdout, effectiveQuery, 'kubectl-stdout'),
  };
}

function shouldFallbackFromKubectl(error) {
  return /context.*(not found|does not exist)|no context exists|kubeconfig|connection refused|unable to connect|i\/o timeout|not installed|not found in path/i
    .test(String(error || ''));
}

function hasForensicsArgs(args) {
  return ['from', 'to', 'trace-id', 'rule-id', 'keyword', 'files', 'context', 'context-before', 'context-after', 'include-rotated']
    .some((name) => args[name] !== undefined);
}

function webShellArgs(args, pod, logMode) {
  const result = [
    '--url', pod.login_pod_addr,
    '--app', args.app,
    '--lines', String(args.lines || 120),
    '--mode', args.mode || 'auto',
    '--log-mode', logMode,
  ];
  const forwarded = [
    'profile', 'since', 'since-minutes', 'version', 'timeout', 'from', 'to',
    'trace-id', 'rule-id', 'keyword', 'files', 'context', 'context-before',
    'context-after', 'max-lines', 'max-bytes',
  ];
  for (const name of forwarded) {
    if (args[name] !== undefined) result.push(`--${name}`, String(args[name]));
  }
  if (asBoolean(args['include-rotated'], false)) result.push('--include-rotated');
  if (asBoolean(args['include-startup'], false)) result.push('--include-startup');
  if (!args.version && pod.version) result.push('--version', pod.version);
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.app) throw new Error('missing --app=<app_name>');
  if (!/^[a-zA-Z0-9_-]+$/.test(String(args.app))) {
    throw new DiagnosticError('INVALID_ARGUMENT', 'invalid --app value');
  }
  const lines = Number(args.lines || 120);
  if (!Number.isInteger(lines) || lines < 1 || lines > 500) {
    throw new DiagnosticError('INVALID_ARGUMENT', '--lines must be an integer between 1 and 500');
  }
  const env = args.env || 'pre';
  const logMode = args['log-mode'] || (hasForensicsArgs(args) ? 'forensics' : 'quick');
  if (!['quick', 'forensics'].includes(logMode)) {
    throw new DiagnosticError('INVALID_LOG_QUERY', '--log-mode must be quick or forensics');
  }
  const query = logMode === 'forensics'
    ? normalizeQuery({ ...args, files: args.files || 'error.log,info.log' })
    : null;
  const queryArgs = ['--app', args.app, '--env', env, '--type', 'pod', '--json'];
  if (args.profile) queryArgs.push('--profile', args.profile);
  let instances;
  try {
    instances = parseJson(runNode(QUERY_SCRIPT, queryArgs), 'query-app-instances');
  } catch (error) {
    throw new DiagnosticError('LEXIAO_FETCH_FAILED', error.message);
  }
  const pod = choosePod(instances.instances?.pod, args.pod, args.ip);
  const urlValidation = pod.login_pod_addr
    ? validateWebShellUrl(pod.login_pod_addr, pod)
    : { valid: false, mode: 'missing', errors: ['LOGIN_URL_MISSING'], warnings: [], container: pod.container || '' };
  const container = pod.container || urlValidation.container || '';
  const kube = checkKubectlContext(pod.cluster_id);
  const accessAttempts = [];

  if (kube.contextAvailable && container) {
    const kubeResult = runKubectlLogs(pod, container, args, query, logMode);
    accessAttempts.push({
      method: 'k8s',
      ok: kubeResult.ok,
      error: kubeResult.error || null,
    });
    if (kubeResult.ok) {
      const needsFileFallback = logMode === 'forensics'
        && (query.includeRotated || kubeResult.queryResult.matchedEvents === 0);
      if (!needsFileFallback || !urlValidation.valid) {
        console.log(JSON.stringify({
          app: args.app,
          env,
          selectedPod: {
            pod_name: pod.pod_name,
            pod_ip: pod.pod_ip,
            host_ip: pod.host_ip,
            namespace: pod.namespace,
            context: pod.cluster_id,
            container,
            status: pod.pod_status,
            version: pod.version,
          },
          targetSource: 'lexiao',
          loginUrlSource: pod.login_url_source || (pod.login_pod_addr ? 'lexiao' : 'missing'),
          loginUrlValidation: urlValidation,
          access: { method: 'k8s', reason: 'matching-context' },
          accessAttempts,
          logMode,
          result: kubeResult.queryResult,
          limitations: logMode === 'forensics'
            ? ['kubectl logs only covers container stdout; application log files and rotations were not read']
            : ['kubectl logs only covers container stdout; error.log was not read as a file'],
        }, null, 2));
        return;
      }
      accessAttempts[accessAttempts.length - 1].reason = query.includeRotated
        ? 'application rotations require webshell file query'
        : 'no matching stdout event; continue with application log files';
      accessAttempts[accessAttempts.length - 1].result = kubeResult.queryResult;
    } else if (!shouldFallbackFromKubectl(kubeResult.error)) {
      throw new DiagnosticError('KUBECTL_LOG_FAILED', kubeResult.error, { accessAttempts });
    }
  } else {
    accessAttempts.push({
      method: 'k8s',
      ok: false,
      error: kube.contextAvailable ? 'container is unknown' : (kube.error || 'matching context is unavailable'),
    });
  }

  if (!urlValidation.valid) {
    const code = pod.login_pod_addr ? 'LOGIN_URL_INVALID' : 'LOGIN_URL_MISSING';
    throw new DiagnosticError(code, `cannot use WebShell: ${urlValidation.errors.join(', ')}`, {
      loginUrlValidation: urlValidation,
      accessAttempts,
    });
  }

  const childNetwork = buildBrowserEnv(pod.login_pod_addr, process.env);
  const logResult = parseJson(runNode(WEBSHELL_SCRIPT, webShellArgs(args, pod, logMode), {
    env: childNetwork.env,
  }), 'webshell-log-check');
  accessAttempts.push({
    method: 'webshell',
    ok: Boolean(logResult.completed),
    error: logResult.errorCode || logResult.error || null,
  });
  console.log(JSON.stringify({
    ...logResult,
    app: args.app,
    env,
    selectedPod: {
      pod_name: pod.pod_name,
      pod_ip: pod.pod_ip,
      host_ip: pod.host_ip,
      namespace: pod.namespace,
      context: pod.cluster_id,
      container,
      status: pod.pod_status,
      version: pod.version,
    },
    targetSource: 'lexiao',
    loginUrlSource: pod.login_url_source || 'lexiao',
    loginUrlValidation: urlValidation,
    access: {
      method: 'webshell',
      reason: kube.contextAvailable ? 'file-forensics-fallback' : 'kube-context-unavailable',
      networkPolicy: childNetwork.networkPolicy,
    },
    accessAttempts,
    kube,
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: error.code || 'CONTAINER_LOG_CHECK_FAILED',
      error: error.message,
      details: error.details || {},
    }, null, 2));
    process.exit(1);
  }
}

module.exports = {
  buildKubectlLogArgs,
  choosePod,
  parseArgs,
  shouldFallbackFromKubectl,
  toRfc3339,
  webShellArgs,
};
