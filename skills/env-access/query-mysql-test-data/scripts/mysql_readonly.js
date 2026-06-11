#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.config/codex-mysql-readonly');
const CONFIG_FILE = path.join(CONFIG_DIR, 'instances.json');
const DEFAULT_INSTANCE = 'default';
const MYSQL_BIN = process.env.MYSQL_BIN || path.join(os.homedir(), 'tools', 'mysql-client', 'root', 'usr', 'bin', 'mysql');

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--') {
      args._ = argv.slice(index + 1);
      break;
    }
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
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

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(CONFIG_DIR, 0o700);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return { version: 1, defaultInstance: DEFAULT_INSTANCE, instances: {} };
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(config) {
  ensureConfigDir();
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  fs.chmodSync(CONFIG_FILE, 0o600);
}

function redactInstance(instance) {
  return {
    ...instance,
    host: instance.host ? '<stored>' : '',
    port: instance.port ? '<stored>' : '',
    user: instance.user ? '<stored>' : '',
    password: instance.password ? '<stored>' : '',
  };
}

function sanitize(text) {
  return String(text || '')
    .replace(/'[^']+'@'[^']+'/g, "'<user>'@'<host>'")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/password\s*=\s*[^&\s]+/gi, 'password=<stored>');
}

function getInstance(config, name) {
  const instance = config.instances[name];
  if (!instance) {
    throw new Error(`未找到实例配置：${name}。可先运行 --add-instance ${name} 并提供只读连接参数。`);
  }
  return instance;
}

function valueFrom(args, argName, envName) {
  return args[argName] || process.env[envName];
}

function requireValue(args, argName, envName) {
  const value = valueFrom(args, argName, envName);
  if (!value) throw new Error(`缺少 ${argName}，可传 --${argName}=... 或环境变量 ${envName}`);
  return value;
}

function buildInstance(args, name) {
  return {
    displayName: args['display-name'] || args.displayName || name,
    host: requireValue(args, 'host', 'MYSQL_HOST'),
    port: String(valueFrom(args, 'port', 'MYSQL_PORT') || '3306'),
    user: requireValue(args, 'user', 'MYSQL_USER'),
    password: requireValue(args, 'password', 'MYSQL_PASSWORD'),
    mode: args.mode || 'readonly',
    source: args.source || 'manual',
    updatedAt: new Date().toISOString(),
  };
}

function quoteOptionValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '')}"`;
}

function writeDefaultsFile(instance) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mysql-readonly-'));
  const file = path.join(dir, 'client.cnf');
  fs.writeFileSync(file, [
    '[client]',
    `host=${quoteOptionValue(instance.host)}`,
    `port=${quoteOptionValue(instance.port)}`,
    `user=${quoteOptionValue(instance.user)}`,
    `password=${quoteOptionValue(instance.password)}`,
    'protocol=TCP',
    '',
  ].join('\n'), { mode: 0o600 });
  return { dir, file };
}

function cleanupTemp(temp) {
  if (temp) fs.rmSync(temp.dir, { recursive: true, force: true });
}

function assertReadOnlySql(sql) {
  const normalized = String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .trim()
    .toLowerCase();
  // 白名单 + 逐条语句校验（防多语句拼接绕过首关键字检查）；
  // 第二道防线是连接级 SET SESSION TRANSACTION READ ONLY
  const allowed = /^(select|show|desc|describe|explain|with|help)\b/;
  const statements = normalized.split(';').map((s) => s.trim()).filter(Boolean);
  if (!statements.length || !statements.every((s) => allowed.test(s))) {
    throw new Error('拒绝执行非只读 SQL。仅允许 SELECT/SHOW/DESCRIBE/EXPLAIN/WITH 等只读语句（逐条校验）。');
  }
}

function buildMysqlArgs(defaultsFile, args) {
  const base = [
    `--defaults-extra-file=${defaultsFile}`,
    '--connect-timeout=10',
    '--safe-updates',
    '--init-command=SET SESSION TRANSACTION READ ONLY',
  ];

  if (args.check) {
    return [...base, '--batch', '--skip-column-names', '-e', 'SELECT 1 AS ok'];
  }

  if (args.query) {
    assertReadOnlySql(args.query);
    return [...base, '--batch', '-e', args.query];
  }

  if (args._.length) {
    return [...base, ...args._];
  }

  return base;
}

function runMysql(instance, args) {
  if (!fs.existsSync(MYSQL_BIN)) {
    throw new Error(`未找到 mysql 客户端：${MYSQL_BIN}`);
  }
  const temp = writeDefaultsFile(instance);
  try {
    const mysqlArgs = buildMysqlArgs(temp.file, args);
    const child = childProcess.spawn(MYSQL_BIN, mysqlArgs, { stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      cleanupTemp(temp);
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 1);
    });
  } catch (error) {
    cleanupTemp(temp);
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const instanceName = String(args.instance || config.defaultInstance || DEFAULT_INSTANCE).toLowerCase();

  if (args.doctor) {
    console.log(JSON.stringify({
      configFile: CONFIG_FILE,
      configExists: fs.existsSync(CONFIG_FILE),
      mysqlExists: fs.existsSync(MYSQL_BIN),
      defaultInstance: config.defaultInstance || DEFAULT_INSTANCE,
      configuredInstances: Object.keys(config.instances || {}),
    }, null, 2));
    return;
  }

  if (args.list) {
    console.log(JSON.stringify({
      defaultInstance: config.defaultInstance || DEFAULT_INSTANCE,
      instances: Object.fromEntries(Object.entries(config.instances || {}).map(([name, instance]) => [name, redactInstance(instance)])),
    }, null, 2));
    return;
  }

  if (args['add-instance']) {
    const instanceNameToAdd = String(args['add-instance'] === true ? (args.instance || DEFAULT_INSTANCE) : args['add-instance']).toLowerCase();
    const instance = buildInstance(args, instanceNameToAdd);
    config.version = 1;
    config.instances = config.instances || {};
    config.instances[instanceNameToAdd] = instance;
    if (args['set-default'] || !config.defaultInstance) {
      config.defaultInstance = instanceNameToAdd;
    }
    saveConfig(config);
    console.log(JSON.stringify({
      stored: true,
      instance: instanceNameToAdd,
      displayName: instance.displayName,
      configFile: CONFIG_FILE,
      credentialsStored: true,
      mode: instance.mode,
      updatedAt: instance.updatedAt,
    }, null, 2));
    return;
  }

  const instance = getInstance(config, instanceName);
  if (args.status) {
    console.log(JSON.stringify({
      instance: instanceName,
      configFile: CONFIG_FILE,
      configured: true,
      details: redactInstance(instance),
    }, null, 2));
    return;
  }

  runMysql(instance, args);
}

main().catch((error) => {
  console.error(sanitize(error.stack || error.message));
  process.exit(1);
});
