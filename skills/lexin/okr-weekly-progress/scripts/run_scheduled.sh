#!/usr/bin/env bash
# okr-weekly.service 的入口：无人值守地生成本周周报汇总并在 mdview 打开。
# 受限会话只放行 collect、open 和写 ~/docs/weekly-reports；write/restore 不在白名单内，定时段不可能写乐空间。
set -uo pipefail

SKILL_DIR=/home/joney/projects/ai/agent-tools/skills/lexin/okr-weekly-progress
CLI="$SKILL_DIR/scripts/okr_weekly.mjs"
STATE="$HOME/.local/state/agent-tools/okr-weekly"
OUT="$HOME/docs/weekly-reports"
CLAUDE_BIN="${OKR_WEEKLY_CLAUDE:-claude}"

mkdir -p "$STATE/runs" "$OUT"
# 运行记录、collect 素材和写入快照只留 60 天；脚本层面也禁止写入乐空间
find "$STATE/runs" "$STATE/collect" "$STATE/snapshots" -type f -mtime +60 -delete 2>/dev/null
export OKR_WEEKLY_READONLY=1
umask 077

# 定时会话可以写 weekly-reports，但不许改已有周报：运行前后比对已有文件的哈希
existing_sums() { find "$OUT" -maxdepth 1 -type f -name '*.md' -print0 2>/dev/null | sort -z | xargs -0 -r sha256sum; }

ts="$(date +%Y%m%dT%H%M%S)"
log="$STATE/runs/$ts.log"
mark="$STATE/runs/$ts.start"
touch "$mark"
before_sums="$(existing_sums)"

prompt="按 $SKILL_DIR/SKILL.md 的「定时段」执行一次：运行 node $CLI collect，读取它输出的 JSON 素材文件，按 $SKILL_DIR/references/archive-format.md 生成周报汇总，写到 collect 输出里 archive.path 指定的路径，最后运行 node $CLI open <该文件>。只做这些，不要调用 write 或 restore。"

cd "$OUT" || exit 1
# 文件写入只认 Edit(path) 规则；绝对路径要以 // 开头，"/$OUT" 展开后即 //home/...
timeout 25m "$CLAUDE_BIN" -p "$prompt" \
  --permission-mode dontAsk --strict-mcp-config --no-session-persistence \
  --add-dir "$STATE" --add-dir "$SKILL_DIR" \
  --allowedTools "Bash(node $CLI collect:*)" "Bash(node $CLI open:*)" "Read" "Edit(/$OUT/**)" \
  --disallowedTools "WebFetch" "WebSearch" "Bash(node $CLI write:*)" "Bash(node $CLI restore:*)" \
  >"$log" 2>&1
rc=$?

produced="$(find "$OUT" -maxdepth 1 -type f -name '*.md' -newer "$mark" | head -1)"
after_sums="$(printf '%s\n' "$before_sums" | awk '{print $2}' | xargs -r sha256sum 2>/dev/null)"
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
exit 0
