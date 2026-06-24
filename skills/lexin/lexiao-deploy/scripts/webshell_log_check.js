#!/usr/bin/env node
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const TOOL_DIR = path.join(os.homedir(), 'tools/lexiao-browser');
const DEFAULT_PROFILE = path.join(os.homedir(), '.cache/lexiao-browser-profile');
const CHROME_PATH = path.join(TOOL_DIR, 'browsers/chrome-linux64/chrome');
const RUNTIME_LIB_DIR = path.join(TOOL_DIR, 'runtime-libs/usr/lib/x86_64-linux-gnu');
const chromium = createRequire(path.join(TOOL_DIR, 'package.json'))('playwright').chromium;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq !== -1) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[item.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args[item.slice(2)] = true;
    }
  }
  return args;
}

async function openContext(args) {
  const ldLibraryPath = [RUNTIME_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return chromium.launchPersistentContext(args.profile || DEFAULT_PROFILE, {
    executablePath: args.chrome || CHROME_PATH,
    headless: !args.headed,
    viewport: { width: Number(args.width || 1800), height: Number(args.height || 1200) },
    env: { ...process.env, LD_LIBRARY_PATH: ldLibraryPath },
    args: ['--no-sandbox'],
  });
}

function buildCommand(appName, lines) {
  const logDir = `/home/product/logs/${appName}_logs`;
  const startupPattern = 'Dubbo run OK|Dubbo service.*started|Started .*Application|Started .* in [0-9].* seconds|启动成功|项目启动成功|init finished.*cost[=: ]*[0-9]+|duration[=: ]*[0-9]+|耗时 *[0-9]+';
  const errorPattern = 'ERROR|Exception|Throwable|Caused by';
  const since = process.env.LEXIAO_LOG_SINCE || '';
  const version = process.env.LEXIAO_LOG_VERSION || '';
  const startupLimit = Math.max(2, Math.min(lines, 4));
  const errorLimit = Math.max(2, Math.min(lines, 5));
  const publishRoot = `/home/publish_product/server_java/${appName}`;
  const stdoutPath = version ? `${publishRoot}/${version}/logs/stdout.log` : '';
  const prefix = since
    ? `awk -v s='${since.replace(/'/g, "'\\''")}' 'match($0,/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]/){ts=substr($0,RSTART,16); if (ts>=s) print}'`
    : 'cat';
  const sample = `awk '{print substr($0,1,160)}'`;
  return [
    'clear',
    'echo __LEXIAO_WEB_SHELL_LOG_BEGIN__',
    'pwd',
    'hostname',
    'whoami',
    `echo __LOG_SCOPE__ app=${appName} since=${since || 'ALL'} version=${version || 'AUTO'}`,
    `echo __LOG_FILES__; ls -l ${logDir}/ 2>/dev/null | tail -12 | ${sample}`,
    `echo __VERSION_STDOUT__; stdout='${stdoutPath}'; if [ -z "$stdout" ]; then stdout=$(find ${publishRoot} -maxdepth 3 -name stdout.log 2>/dev/null | sort | tail -1); fi; echo "$stdout"; if [ -f "$stdout" ]; then echo "count=$(${prefix} "$stdout" | grep -E -i '${startupPattern}|${errorPattern}' | wc -l)"; ${prefix} "$stdout" | grep -E -n -i '${startupPattern}|${errorPattern}' | tail -${startupLimit} | ${sample}; else echo NO_STDOUT_LOG; fi`,
    `echo __ERROR_RECENT__`,
    `for f in error.log debug.log info.log; do echo "## $f"; if [ -f ${logDir}/$f ]; then echo "count=$(${prefix} ${logDir}/$f | grep -E -i '${errorPattern}' | wc -l)"; ${prefix} ${logDir}/$f | grep -E -n -i '${errorPattern}' | tail -${errorLimit} | ${sample}; else echo MISSING; fi; done`,
    `echo __STARTUP_MARKERS__`,
    `for f in debug.log info.log; do echo "## $f"; if [ -f ${logDir}/$f ]; then echo "count=$(${prefix} ${logDir}/$f | grep -E -i '${startupPattern}' | wc -l)"; ${prefix} ${logDir}/$f | grep -E -n -i '${startupPattern}' | tail -${startupLimit} | ${sample}; else echo MISSING; fi; done`,
    `echo __HEALTH_RECENT__`,
    `grep -E -n -i 'service port|serverResource' ${logDir}/info.log 2>/dev/null | tail -1 | ${sample}`,
    'echo __LEXIAO_WEB_SHELL_LOG_END__',
  ].join('; ') + '\n';
}

async function terminalText(frame) {
  return frame.evaluate(() => Array.from(document.querySelectorAll('x-row')).map((row) => row.innerText || row.textContent || '').join('\n')).catch(() => null);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) throw new Error('missing --url=<login_pod_addr>');
  if (!args.app) throw new Error('missing --app=<log_app_name>');
  const lines = Number(args.lines || 120);
  const context = await openContext(args);
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(Number(args['connect-wait-ms'] || 8000));
    const frame = page.frames().find((item) => item.url() === 'about:blank') || page.frames()[1];
    if (!frame) throw new Error('cannot find webshell terminal frame');
    await frame.locator('textarea').focus({ timeout: 10000 }).catch(async () => {
      await frame.locator('x-screen').click({ timeout: 10000 });
    });
    if (args.since) process.env.LEXIAO_LOG_SINCE = args.since;
    if (args.version) process.env.LEXIAO_LOG_VERSION = args.version;
    await page.keyboard.type(buildCommand(args.app, lines), { delay: Number(args.delay || 1) });
    let text = null;
    for (let i = 0; i < Number(args.polls || 40); i += 1) {
      await page.waitForTimeout(1000);
      text = await terminalText(frame);
      if (text && text.includes('__LEXIAO_WEB_SHELL_LOG_END__')) break;
    }
    if (args.screenshot) {
      await page.screenshot({ path: args.screenshot, fullPage: true });
    }
    console.log(JSON.stringify({
      url: args.url,
      app: args.app,
      completed: Boolean(text && text.includes('__LEXIAO_WEB_SHELL_LOG_END__')),
      text,
    }, null, 2));
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
