#!/usr/bin/env bash
# 安装 mdview：链接 ~/.local/bin/mdview；Linux/WSL 另按模板生成 systemd user 单元（socket 激活、空闲退出）。
# macOS 没有 systemd：只装链接，mdview 直接前台运行（mdview <文件>）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "mdview/install.sh: PATH 中没有 node（需要 >= 22.5）" >&2; exit 2; }
DOCS="$("$NODE" -p "require('$ROOT/lib/agent_tools/locate.js').docsRoot()")"
PLATFORM="$("$NODE" -p "require('$ROOT/lib/agent_tools/locate.js').platform()")"

BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
ln -sfn "$ROOT/tools/mdview/mdview" "$BIN_DIR/mdview"
echo "mdview: $BIN_DIR/mdview -> $ROOT/tools/mdview/mdview"

if [[ "$PLATFORM" == "darwin" ]]; then
  echo "mdview: macOS 没有 systemd，不安装常驻单元；用 mdview <文件或目录> 前台运行（文档根 $DOCS）"
  exit 0
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
sed -e "s|@NODE@|$NODE|g" -e "s|@ROOT@|$ROOT|g" -e "s|@DOCS@|$DOCS|g" \
  "$ROOT/tools/mdview/systemd/mdview.service.in" >"$UNIT_DIR/mdview.service"
cp "$ROOT/tools/mdview/systemd/mdview.socket" "$UNIT_DIR/mdview.socket"
systemctl --user daemon-reload
systemctl --user enable --now mdview.socket
systemctl --user stop mdview.service 2>/dev/null || true   # 下次访问即用新单元
echo "mdview: systemd 单元已写入 $UNIT_DIR（node=$NODE，文档根=$DOCS），http://127.0.0.1:8321/ 按需拉起"
