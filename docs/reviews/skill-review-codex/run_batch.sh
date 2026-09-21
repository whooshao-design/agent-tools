#!/usr/bin/env bash
# 用法: run_batch.sh <round-dir> <prompt-file>   在仓库根目录以 codex-reviewer 跑一批评审
set -uo pipefail
ROUND="$1"; PROMPT="$2"; NAME="$(basename "$PROMPT" .md)"
mkdir -p "$ROUND"
cd /home/joney/projects/ai/agent-tools
start=$(date +%s)
/home/joney/bin/codex-reviewer "$(cat "$PROMPT")" </dev/null > "$ROUND/$NAME.md" 2> "$ROUND/$NAME.log"
rc=$?
echo "rc=$rc seconds=$(( $(date +%s) - start ))" > "$ROUND/$NAME.status"
