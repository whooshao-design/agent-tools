#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const DEFAULT_URL = 'https://lexiao.oa.fenqile.com/#/app-publish/51303';
const DEFAULT_SUCCESS_TEXT = '当前环境';

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
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

function resolvePaths(args) {
  const toolDir = expandHome(args['tool-dir'] || process.env.BROWSER_SESSION_TOOL_DIR || '~/tools/lexiao-browser');
  return {
    toolDir,
    profileDir: expandHome(args.profile || process.env.BROWSER_SESSION_PROFILE || '~/.cache/lexiao-browser-profile'),
    chromePath: expandHome(args.chrome || path.join(toolDir, 'browsers/chrome-linux64/chrome')),
    runtimeLibDir: expandHome(args['runtime-lib-dir'] || path.join(toolDir, 'runtime-libs/usr/lib/x86_64-linux-gnu')),
    playwrightPackage: path.join(toolDir, 'package.json'),
  };
}

function loadPlaywright(paths) {
  if (!fs.existsSync(paths.playwrightPackage)) {
    throw new Error(`未找到 Playwright 工具目录：${paths.toolDir}`);
  }
  if (!fs.existsSync(paths.chromePath)) {
    throw new Error(`未找到 Chrome 可执行文件：${paths.chromePath}`);
  }
  const requireFromTool = createRequire(paths.playwrightPackage);
  return requireFromTool('playwright').chromium;
}

function redact(value, showSecrets) {
  if (showSecrets) return value;
  if (!value) return value;
  if (value.length <= 8) return '<redacted>';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function collectStatus(page, options = {}) {
  const status = await page.evaluate(({ successText, loginPattern }) => {
    const bodyText = document.body.innerText.replace(/\s+/g, ' ').trim();
    const loginRegex = new RegExp(loginPattern, 'i');
    const buttons = Array.from(document.querySelectorAll('button')).map((button) => ({
      text: button.innerText.replace(/\s+/g, ' ').trim(),
      disabled: button.disabled || button.classList.contains('is-disabled'),
      className: String(button.className || ''),
    })).filter((button) => button.text);
    return {
      title: document.title,
      url: location.href,
      hasSuccessText: successText ? bodyText.includes(successText) : false,
      hasLoginText: loginRegex.test(bodyText),
      snippet: bodyText.slice(0, 1200),
      buttons,
    };
  }, options);
  status.sessionReady = Boolean(status.hasSuccessText || !status.hasLoginText);
  return status;
}

async function clickNormalizedText(page, label) {
  return page.evaluate((wantedText) => {
    const normalize = (text) => (text || '').replace(/\s+/g, '').trim();
    const wanted = normalize(wantedText);
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const elements = Array.from(document.querySelectorAll(
      'button,a,[role="button"],.el-button,.ant-btn,.ant-tabs-tab,.el-tabs__item,li,span,div'
    )).filter(visible);
    const target = elements
      .map((el) => ({ el, text: normalize(el.innerText || el.textContent), className: String(el.className || '') }))
      .filter((item) => item.text === wanted || item.text.includes(wanted))
      .sort((a, b) => {
        const aInteractive = /^(BUTTON|A)$/.test(a.el.tagName) || a.el.getAttribute('role') === 'button' || /button|btn|tab|item/.test(a.className);
        const bInteractive = /^(BUTTON|A)$/.test(b.el.tagName) || b.el.getAttribute('role') === 'button' || /button|btn|tab|item/.test(b.className);
        if (aInteractive !== bInteractive) return aInteractive ? -1 : 1;
        return (a.text.length - wanted.length) - (b.text.length - wanted.length);
      })[0]?.el;
    if (!target) return { clicked: false, reason: 'not-found' };
    if (target.disabled || target.classList.contains('is-disabled')) return { clicked: false, reason: 'disabled' };
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return { clicked: true };
  }, label);
}

async function openContext(paths, chromium, headless) {
  const ldLibraryPath = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return chromium.launchPersistentContext(paths.profileDir, {
    executablePath: paths.chromePath,
    headless,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: ldLibraryPath,
    },
    args: ['--no-sandbox'],
  });
}

async function waitForSession(page, options) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const status = await collectStatus(page, options);
    if (status.sessionReady) return status;
    await page.waitForTimeout(options.pollMs);
  }
  return collectStatus(page, options);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolvePaths(args);
  const mode = args.ensure ? 'ensure' : args.cookies ? 'cookies' : args.doctor ? 'doctor' : 'status';
  const url = args.url || DEFAULT_URL;
  const successText = args['success-text'] === 'none' ? '' : (args['success-text'] || DEFAULT_SUCCESS_TEXT);
  const loginPattern = args['login-pattern'] || '登录|扫码|账号|密码|SSO|OAuth';
  const timeoutMs = Number(args.timeout || 300000);
  const pollMs = Number(args.poll || 2000);
  const headless = mode !== 'ensure' && !args.headed;

  if (mode === 'doctor') {
    console.log(JSON.stringify({
      toolDir: paths.toolDir,
      profileDir: paths.profileDir,
      chromePath: paths.chromePath,
      hasToolPackage: fs.existsSync(paths.playwrightPackage),
      hasChrome: fs.existsSync(paths.chromePath),
      hasProfile: fs.existsSync(paths.profileDir),
    }, null, 2));
    return;
  }

  const chromium = loadPlaywright(paths);
  const context = await openContext(paths, chromium, headless);
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const options = { successText, loginPattern, timeoutMs, pollMs };
    let status = mode === 'ensure' ? await waitForSession(page, options) : await collectStatus(page, options);

    if (args['click-text']) {
      status.clickText = await clickNormalizedText(page, args['click-text']);
      await page.waitForTimeout(1000);
    }
    if (args['click-button']) {
      status.clickButton = await clickNormalizedText(page, args['click-button']);
      await page.waitForTimeout(1000);
    }

    if (mode === 'cookies') {
      const domain = args.domain || new URL(status.url).hostname;
      const showSecrets = Boolean(args['show-secrets']);
      const cookies = (await context.cookies()).filter((cookie) => cookie.domain.includes(domain)).map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
        value: redact(cookie.value, showSecrets),
      }));
      status.cookies = cookies;
      status.valuesRedacted = !showSecrets;
    }

    console.log(JSON.stringify(status, null, 2));
    await context.close();
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
