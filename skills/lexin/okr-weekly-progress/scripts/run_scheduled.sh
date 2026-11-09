#!/usr/bin/env bash
# okr-weekly.service 的入口：无人值守地生成本周周报汇总，由本脚本（不是模型会话）把它写成乐空间草稿，再在 mdview 打开。
# 受限会话只放行 collect、open 和写 ~/docs/weekly-reports，write/restore 不在白名单内且 OKR_WEEKLY_READONLY=1；
# 只有会话成功、已有周报未被改动时，脚本才自己调用 write --confirm（只存草稿，不发布）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# 仓库根三来源（与 lib/agent_tools 同口径）：链接模式上三层即仓库；复制模式（~/.claude/skills/<skill>/scripts）上三层是 $HOME，
# 改用 systemd 单元写入的 AGENT_TOOLS_ROOT，再退到指针文件
valid_root() { [ -n "$1" ] && [ -f "$1/install.py" ] && [ -d "$1/skills" ]; }
ROOT="$(cd "$SKILL_DIR/../../.." 2>/dev/null && pwd -P)"
valid_root "$ROOT" || ROOT="${AGENT_TOOLS_ROOT:-}"
valid_root "$ROOT" || ROOT="$(cat "$HOME/.config/agent-tools/root" 2>/dev/null)"
valid_root "$ROOT" || { echo "agent-tools: 未找到仓库根（上三层 $SKILL_DIR/../../..、AGENT_TOOLS_ROOT=${AGENT_TOOLS_ROOT:-<unset>}、$HOME/.config/agent-tools/root 都不含 install.py + skills/）；请在仓库目录运行 python3 install.py" >&2; exit 2; }
# 定时会话没有交互 shell 的环境：从 env/credentials.env 取 OKR_WEEKLY_AUTHOR 等键（空值不覆盖；文件缺失只提示不中断）
# shellcheck source=/dev/null
source "$ROOT/bin/_load_env.sh" && load_agent_tools_env "$ROOT"
CLI="$SKILL_DIR/scripts/okr_weekly.mjs"
STATE="$HOME/.local/state/agent-tools/okr-weekly"
DOCS="${AGENT_TOOLS_DOCS_ROOT:-$HOME/docs}"
OUT="$DOCS/weekly-reports"
# macOS 没有 sha256sum，用 shasum -a 256（输出格式相同）
SUM256="$(command -v sha256sum || echo 'shasum -a 256')"
CLAUDE_BIN="${OKR_WEEKLY_CLAUDE:-claude}"

mkdir -p "$STATE/runs" "$OUT"
# 运行记录、collect 素材和写入快照只留 60 天；模型会话期间脚本层面也禁止写入乐空间
find "$STATE/runs" "$STATE/collect" "$STATE/snapshots" -type f -mtime +60 -delete 2>/dev/null
export OKR_WEEKLY_READONLY=1
umask 077

# 定时会话可以写 weekly-reports，但不许改已有周报：运行前后比对已有文件的哈希
existing_sums() { find "$OUT" -maxdepth 1 -type f -name '*.md' -print0 2>/dev/null | sort -z | xargs -0 -r $SUM256; }

ts="$(date +%Y%m%dT%H%M%S)"
log="$STATE/runs/$ts.log"
mark="$STATE/runs/$ts.start"
touch "$mark"
before_sums="$(existing_sums)"

prompt="按 $SKILL_DIR/SKILL.md 的「定时段」执行一次：运行 node $CLI collect，读取它输出的 JSON 素材文件，按 $SKILL_DIR/references/archive-format.md 生成周报汇总，写到 collect 输出里 archive.path 指定的路径。只做这些，不要调用 open、write 或 restore。"

cd "$OUT" || exit 1
# 文件写入只认 Edit(path) 规则；绝对路径要以 // 开头，"/$OUT" 展开后即 //home/...
timeout 22m "$CLAUDE_BIN" -p "$prompt" \
  --permission-mode dontAsk --strict-mcp-config --no-session-persistence \
  --add-dir "$STATE" --add-dir "$SKILL_DIR" --add-dir "$DOCS/requirements-development" \
  --allowedTools "Bash(node $CLI collect:*)" "Read" "Edit(/$OUT/**)" \
  --disallowedTools "WebFetch" "WebSearch" "Bash(node $CLI write:*)" "Bash(node $CLI restore:*)" \
  >"$log" 2>&1
rc=$?

produced="$(find "$OUT" -maxdepth 1 -type f -name '*.md' -newer "$mark" | head -1)"
after_sums="$(printf '%s\n' "$before_sums" | awk '{print $2}' | xargs -r $SUM256 2>/dev/null)"
rm -f "$mark"
if [ "$before_sums" != "$after_sums" ]; then
  rc=3
  echo "已有周报文件被改动或删除（只允许新建文件）" >>"$log"
fi
if [ "$rc" -ne 0 ] || [ -z "$produced" ]; then
  failed="$OUT/$(TZ=Asia/Shanghai date +%F).failed.md"
  {
    echo "# 周报汇总生成失败 $(TZ=Asia/Shanghai date '+%F %T')"
    echo
    echo "退出码 $rc；没有生成周报汇总文件。完整日志：\`$log\`，服务日志：\`journalctl --user -u okr-weekly.service\`。"
    echo
    echo "手动重跑：\`systemctl --user start okr-weekly.service\`，或在交互会话里说「生成本周 OKR 周报」。"
    echo
    echo '```text'
    tail -n 40 "$log"
    echo '```'
  } >"$failed"
  node "$CLI" open "$failed" >/dev/null 2>&1
  exit 1
fi

# 写入乐空间草稿：write 自己负责跳过本周已发布、去重、提交前比对和写后回读；结果不是 ok 时生成说明并打开
write_out="$(OKR_WEEKLY_READONLY=0 timeout 5m node "$CLI" write --file="$produced" --confirm 2>&1)"
printf '\n== write ==\n%s\n' "$write_out" >>"$log"
write_status="$(printf '%s' "$write_out" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).status)}catch{console.log("unparsable")}})')"
case "$write_status" in
  ok|nothing-to-write) node "$CLI" open "$produced" >/dev/null 2>&1 ;;
  *)
    notice="${produced%.md}.write-$write_status.md"
    {
      echo "# 周报汇总已生成，但写入乐空间草稿未完成 $(TZ=Asia/Shanghai date '+%F %T')"
      echo
      echo "周报汇总：\`$produced\`。write 结果 \`$write_status\`，处理方法见 okr-weekly-progress 的 SKILL.md「写入段」；确认后可在交互会话里说「写入 OKR」重试。完整日志：\`$log\`。"
      echo
      echo '```json'
      printf '%s\n' "$write_out" | tail -n 60
      echo '```'
    } >"$notice"
    node "$CLI" open "$notice" >/dev/null 2>&1
    exit 2
    ;;
esac
exit 0
