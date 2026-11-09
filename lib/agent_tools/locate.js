'use strict';
// 定位与平台库（CommonJS）。所有脚本经本库取仓库根、兄弟 skill 目录、本机配置变量、平台值与浏览器运行时，
// 不再各自写死路径。Python 版 locate.py 与本文件逐函数等价。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const POINTER_FILE = path.join(os.homedir(), '.config/agent-tools/root');
const LEGACY_BROWSER_TOOL_DIR = path.join(os.homedir(), 'tools/lexiao-browser');
const DEFAULT_BROWSER_TOOL_DIR = path.join(os.homedir(), '.local/share/agent-tools/browser-tool');
const ROOT_MISS_TEXT = '未命中有效根（install.py 文件 + skills/ 目录）';

class AgentToolsLocateError extends Error {
  /**
   * @param {'ROOT_NOT_FOUND'|'SKILL_NOT_FOUND'|'UNSUPPORTED_PLATFORM'|'BROWSER_TOOL_INVALID'} code
   * @param {string} message
   * @param {string[]} [tried] 仓库根三来源的逐行结果，只有 ROOT_NOT_FOUND 非空
   */
  constructor(code, message, tried = []) {
    super(message);
    this.name = 'AgentToolsLocateError';
    this.code = code;
    this.tried = tried;
  }
}

function warn(message) {
  process.stderr.write(`agent-tools: ${message}\n`);
}

// 'hit' | 'miss' | 异常码：有效根 = 同时含 install.py 文件与 skills/ 目录。
// 不存在（ENOENT）与路径中间不是目录（ENOTDIR）都算 miss，其他错误返回 e.code 交调用方记入 tried。
function probe(dir) {
  if (!dir) return 'miss';
  try {
    // 与 locate.py 同序：先看 install.py，缺失或不是普通文件即 miss，不再碰 skills/（它无权限时也不算异常）
    const installer = fs.statSync(path.join(dir, 'install.py'), { throwIfNoEntry: false });
    if (!installer || !installer.isFile()) return 'miss';
    const skills = fs.statSync(path.join(dir, 'skills'), { throwIfNoEntry: false });
    return skills && skills.isDirectory() ? 'hit' : 'miss';
  } catch (error) {
    return error.code || 'error';
  }
}

function readPointer(pointerFile) {
  return fs.readFileSync(pointerFile, 'utf8').trim();
}

/**
 * 按上溯、AGENT_TOOLS_ROOT、指针文件的顺序取第一个有效根。
 * @param {string} [startDir] 上溯起点，默认本文件所在目录；测试用
 * @param {string} [pointerFile] 指针文件路径，默认 ~/.config/agent-tools/root；测试用
 */
function repoRoot(startDir = __dirname, pointerFile = POINTER_FILE) {
  const tried = [];
  let root = '';
  let result = 'miss';
  try {
    let dir = fs.realpathSync(startDir);
    tried.push(`上溯起点 ${dir}`);
    while ((result = probe(dir)) === 'miss' && path.dirname(dir) !== dir) dir = path.dirname(dir);
    if (result === 'hit') root = dir;
    else tried[0] += result === 'miss' ? ` ${ROOT_MISS_TEXT}` : ` ${result}（放弃上溯）`;
  } catch (error) {
    tried.push(`上溯起点 ${startDir} ${error.code || error.message}`);
  }
  if (!root) {
    const value = process.env.AGENT_TOOLS_ROOT || '';
    result = probe(value);
    tried.push(`AGENT_TOOLS_ROOT=${value || '<unset>'}${result === 'hit' || result === 'miss' ? '' : ' ' + result}`);
    if (result === 'hit') root = value;
  }
  if (!root) {
    try {
      const value = readPointer(pointerFile);
      result = probe(value);
      tried.push(`${pointerFile} = ${value}${result === 'hit' || result === 'miss' ? '' : ' ' + result}`);
      if (result === 'hit') root = value;
    } catch (error) {
      tried.push(`${pointerFile} ${error.code === 'ENOENT' ? '<absent>' : error.code}`);
    }
  }
  if (!root) {
    throw new AgentToolsLocateError(
      'ROOT_NOT_FOUND',
      ['agent-tools: 未找到仓库根', ...tried, '请在仓库目录运行 python3 install.py'].join('\n'),
      tried,
    );
  }
  return root;
}

// skills/<分类>/<name>/<parts>；分类按目录名字典序取第一个存在的，与 install.py 的 sorted() 和 common.skill_path() 同规则。
function skillDir(name, ...parts) {
  const root = repoRoot();
  const skillsRoot = path.join(root, 'skills');
  let categories = [];
  try {
    categories = fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    throw new AgentToolsLocateError('SKILL_NOT_FOUND', `无法读取 ${skillsRoot}: ${error.code || error.message}`);
  }
  for (const category of categories) {
    const candidate = path.join(skillsRoot, category, name);
    try {
      if (fs.statSync(candidate).isDirectory()) return path.join(candidate, ...parts);
    } catch (error) {
      // 该分类下没有这个 skill，继续
    }
  }
  throw new AgentToolsLocateError('SKILL_NOT_FOUND', `skills/*/${name} 不存在（仓库根 ${root}）`);
}

// 路径键：环境变量值必须是绝对路径且不以 ~ 开头，否则按未设置处理并警告。
function pathSetting(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!path.isAbsolute(value) || value.startsWith('~')) {
    warn(`${name}=${value} 不是绝对路径，按未设置处理，使用默认值 ${fallback}`);
    return fallback;
  }
  return value;
}

function docsRoot() {
  return pathSetting('AGENT_TOOLS_DOCS_ROOT', path.join(os.homedir(), 'docs'));
}

function workspaceRoot() {
  return pathSetting('AGENT_TOOLS_WORKSPACE_ROOT', path.join(os.homedir(), 'projects'));
}

// 有效目录 = package.json 与 node_modules/playwright/package.json 都存在。
function browserToolDirValid(dir) {
  return fs.existsSync(path.join(dir, 'package.json'))
    && fs.existsSync(path.join(dir, 'node_modules/playwright/package.json'));
}

function browserToolDir() {
  const configured = pathSetting('BROWSER_SESSION_TOOL_DIR', '');
  if (configured) return configured;
  if (!browserToolDirValid(DEFAULT_BROWSER_TOOL_DIR) && browserToolDirValid(LEGACY_BROWSER_TOOL_DIR)) {
    return LEGACY_BROWSER_TOOL_DIR;
  }
  return DEFAULT_BROWSER_TOOL_DIR;
}

function describeMissing(dir) {
  const missing = ['package.json', 'node_modules/playwright/package.json']
    .filter((relative) => !fs.existsSync(path.join(dir, relative)));
  return missing.length ? `${dir} 缺 ${missing.join('、')}` : `${dir} 有效`;
}

// 浏览器运行时三项：Playwright 包目录、Chromium 可执行文件、Linux 运行库目录（darwin 为 null）。
function browserRuntime() {
  const toolDir = browserToolDir();
  if (!browserToolDirValid(toolDir)) {
    const lines = [
      `agent-tools: 浏览器工具目录无效：${describeMissing(toolDir)}`,
      `默认目录：${describeMissing(DEFAULT_BROWSER_TOOL_DIR)}`,
      `旧目录：${describeMissing(LEGACY_BROWSER_TOOL_DIR)}`,
      '请运行 skills/lexin/get-browser-session/scripts/setup_browser_tool.sh，或设置 BROWSER_SESSION_TOOL_DIR',
    ];
    throw new AgentToolsLocateError('BROWSER_TOOL_INVALID', lines.join('\n'));
  }
  const playwrightDir = path.join(toolDir, 'node_modules/playwright');
  const current = platform();
  let executablePath = '';
  let runtimeLibDir = null;
  if (current !== 'darwin') {
    const bundled = path.join(toolDir, 'browsers/chrome-linux64/chrome');
    if (fs.existsSync(bundled)) executablePath = bundled;
    const libs = path.join(toolDir, 'runtime-libs/usr/lib/x86_64-linux-gnu');
    if (fs.existsSync(libs)) runtimeLibDir = libs;
  }
  if (!executablePath) {
    // eslint-disable-next-line global-require
    executablePath = require(playwrightDir).chromium.executablePath();
  }
  return { toolDir, playwrightDir, executablePath, runtimeLibDir };
}

function platform() {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') {
    try {
      const release = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8');
      return /microsoft/i.test(release) ? 'wsl' : 'linux';
    } catch (error) {
      warn(`读取 /proc/sys/kernel/osrelease 失败（${error.code || error.message}），按 linux 处理`);
      return 'linux';
    }
  }
  throw new AgentToolsLocateError('UNSUPPORTED_PLATFORM', `不支持的平台：${process.platform}`);
}

function findExecutable(command) {
  if (path.isAbsolute(command)) return isExecutable(command) ? command : '';
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, command);
    if (isExecutable(candidate)) return candidate;
  }
  return '';
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (error) {
    return false;
  }
}

// 返回 [命令, 参数...]；AGENT_TOOLS_OPEN_CMD 为空或首词不可执行时按未设置处理并警告，用平台默认模板。
function openCommand(target) {
  const configured = (process.env.AGENT_TOOLS_OPEN_CMD || '').trim();
  if (configured) {
    const words = configured.split(/\s+/);
    const executable = findExecutable(words[0]);
    if (executable) {
      const args = words.slice(1);
      const filled = args.includes('{target}')
        ? args.map((word) => (word === '{target}' ? target : word))
        : [...args, target];
      return [executable, ...filled];
    }
    warn(`AGENT_TOOLS_OPEN_CMD 的首词 ${words[0]} 不是可执行命令，按未设置处理`);
  }
  const current = platform();
  if (current === 'darwin') return ['open', target];
  if (current === 'linux') return ['xdg-open', target];
  const script = `Start-Process '${target.replace(/'/g, "''")}'`;
  return ['powershell.exe', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

// 不经 shell 启动；成功启动且退出码 0 返回 true，命令不存在或退出码非 0 返回 false 并把错误写 stderr。
function openExternal(target) {
  const [command, ...args] = openCommand(target);
  const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error) {
    warn(`打开 ${target} 失败：${command} ${result.error.code || result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    warn(`打开 ${target} 失败：${command} 退出码 ${result.status} ${String(result.stderr || '').trim()}`);
    return false;
  }
  return true;
}

module.exports = {
  AgentToolsLocateError,
  probe,
  repoRoot,
  skillDir,
  docsRoot,
  workspaceRoot,
  browserToolDir,
  browserRuntime,
  platform,
  openExternal,
  ROOT_MISS_TEXT,
};
