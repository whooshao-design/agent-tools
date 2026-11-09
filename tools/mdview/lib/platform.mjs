// 平台相关的外部命令定位：先查 PATH，查不到再用 WSL 上的绝对路径兜底（兜底常量登记在 tests/lint_allowlist.json）。
import fs from 'node:fs';
import path from 'node:path';

export const POWERSHELL_FALLBACK = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
export const CMD_FALLBACK = '/mnt/c/Windows/System32/cmd.exe';

// PATH 里第一个可执行的 <name>；没有返回 ''
export function findOnPath(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* 下一个目录 */ }
  }
  return '';
}

export function powershellExe(env = process.env) {
  return findOnPath('powershell.exe', env) || POWERSHELL_FALLBACK;
}

export function cmdExe(env = process.env) {
  return findOnPath('cmd.exe', env) || CMD_FALLBACK;
}

// VS Code 命令行：MDVIEW_CODE_CLI 显式指定优先，其次 PATH 里的 code；都没有返回 ''
export function codeCli(env = process.env) {
  return env.MDVIEW_CODE_CLI || findOnPath('code', env) || '';
}
