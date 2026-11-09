#!/usr/bin/env bash
# 安装浏览器运行时：锁定版本的 Playwright 与平台 Chromium 到工具目录（BROWSER_SESSION_TOOL_DIR，默认 ~/.local/share/agent-tools/browser-tool）。
# 浏览器类脚本经 lib/agent_tools 的 browserRuntime() 从这里取 Playwright、Chromium 与运行库路径。
# 失败时不留半成品目录；Linux/WSL 缺系统共享库时安装算成功，但打印 install-deps 待办（需要 sudo，本脚本不自行执行）。
set -euo pipefail

PLAYWRIGHT_VERSION="1.60.0"   # 精确版本，不写范围；初值取自现有 WSL 机器 ~/tools/lexiao-browser 实际安装的版本

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
valid_root() { [ -n "$1" ] && [ -f "$1/install.py" ] && [ -d "$1/skills" ]; }
ROOT="$(cd "$SKILL_DIR/../../.." 2>/dev/null && pwd -P)"
valid_root "$ROOT" || ROOT="${AGENT_TOOLS_ROOT:-}"
valid_root "$ROOT" || ROOT="$(cat "$HOME/.config/agent-tools/root" 2>/dev/null)"
valid_root "$ROOT" || { echo "agent-tools: 未找到仓库根（上三层、AGENT_TOOLS_ROOT=${AGENT_TOOLS_ROOT:-<unset>}、$HOME/.config/agent-tools/root）；请在仓库目录运行 python3 install.py" >&2; exit 2; }
LOCATE="$ROOT/lib/agent_tools/locate.js"

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "setup_browser_tool: PATH 中没有 node（需要 >= 22.5）" >&2; exit 2; }
command -v npm >/dev/null 2>&1 || { echo "setup_browser_tool: PATH 中没有 npm" >&2; exit 2; }
PLATFORM="$("$NODE" -p "require('$LOCATE').platform()")"

TOOL_DIR="${BROWSER_SESSION_TOOL_DIR:-$HOME/.local/share/agent-tools/browser-tool}"
TOOL_DIR="${TOOL_DIR/#\~/$HOME}"
export BROWSER_SESSION_TOOL_DIR="$TOOL_DIR"

if [[ -f "$TOOL_DIR/node_modules/playwright/package.json" ]]; then
  echo "setup_browser_tool: 复用已有工具目录 $TOOL_DIR（playwright $("$NODE" -p "require('$TOOL_DIR/node_modules/playwright/package.json').version")）"
else
  FRESH=0
  [[ -d "$TOOL_DIR" ]] || FRESH=1
  cleanup() { if [[ "$FRESH" == 1 ]]; then rm -rf "$TOOL_DIR"; echo "setup_browser_tool: 安装失败，已删除未完成的 $TOOL_DIR" >&2; fi; }
  trap cleanup ERR
  mkdir -p "$TOOL_DIR"
  cd "$TOOL_DIR"
  [[ -f package.json ]] || npm init -y >/dev/null
  echo "setup_browser_tool: npm install playwright@$PLAYWRIGHT_VERSION -> $TOOL_DIR"
  npm install --no-audit --no-fund --save-exact "playwright@$PLAYWRIGHT_VERSION"
  trap - ERR
fi

cd "$TOOL_DIR"
echo "setup_browser_tool: npx playwright install chromium（下载到 Playwright 默认缓存目录）"
npx playwright install chromium

EXE="$("$NODE" -p "require('$LOCATE').browserRuntime().executablePath")"
echo "setup_browser_tool: platform=$PLATFORM toolDir=$TOOL_DIR chromium=$EXE"

if [[ "$PLATFORM" != "darwin" ]]; then
  if [[ "$PLATFORM" == "wsl" && -f "$HOME/tools/lexiao-browser/node_modules/playwright/package.json" ]]; then
    echo "setup_browser_tool: WSL 上已有 ~/tools/lexiao-browser（Chrome for Testing）；不设 BROWSER_SESSION_TOOL_DIR 且默认目录无效时脚本会自动改用它"
  fi
  if command -v ldd >/dev/null 2>&1; then
    MISSING="$(ldd "$EXE" 2>/dev/null | grep 'not found' || true)"
    if [[ -n "$MISSING" ]]; then
      echo "setup_browser_tool: Chromium 缺系统共享库（browser_session.js --doctor 会报启动失败）："
      echo "$MISSING"
      echo "待办（需要 sudo，本脚本不执行）：sudo npx --prefix \"$TOOL_DIR\" playwright install-deps chromium"
    fi
  fi
fi
echo "setup_browser_tool: 完成；检查：node $SCRIPT_DIR/browser_session.js --doctor"
