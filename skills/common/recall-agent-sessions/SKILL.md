---
name: recall-agent-sessions
description: Use when 用户要找回以前在 Claude Code 或 Codex 会话里做过的事，例如"上次查 xx 查到哪了""之前那个结论是什么""在 codex 里改过的那个文件"，或要把某个历史会话交接到当前 agent 继续做；只读检索本机两边的会话记录，并为指定会话生成交接摘要。不用于检索 MEMORY.md 规则或代码仓库内容。
metadata:
  version: 1.2.0
---

# recall-agent-sessions

## 定位

Claude Code 和 Codex 都把完整会话记录存在本机。本 skill 用一个只读脚本跨两边检索这些记录，并把指定会话整理成交接材料，让当前 agent（不论是哪一边）接着做。

- 治理：按关键词、工作目录、时间找历史会话；为一个会话生成交接摘要。
- 不治理：长期规则和偏好（归 MEMORY.md / AGENTS.md）；代码检索（用 `rg`）；原生续聊（同一 agent 内直接用 `claude --resume` 或 `codex resume`）。
- 不会自动注入：只在用户问起时使用，不常驻、不额外消耗额度。

数据来源：

- Claude Code：`~/.claude/projects/<目录名>/<会话ID>.jsonl`，跳过更深层的子 agent 记录。
- Codex：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，跳过带 `parent_thread_id` 的子线程（如 guardian 自动审批）。
- 默认排除当前会话（按 `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`），`--include-current` 可关闭。
- 默认排除无人值守会话：Claude 记录里 `entrypoint` 为 `sdk-cli`（`claude -p`），Codex `originator` 为 `codex_exec`。这些多是 `build-codeagent` 等委派的评审者、读者测试和评测判官，`--include-headless` 可加回。

## 用法

```bash
S=/home/joney/projects/ai/agent-tools/skills/common/recall-agent-sessions/scripts/agent_sessions.py
python3 $S search "告警 超时" --cwd hawk          # 关键词须在同一条消息里全部出现
python3 $S search "流程负责人" "告警 负责人"       # 多组关键词一次搜，任一组命中即算
python3 $S search "rc_flow_version" --all-kinds   # 同时搜执行过的命令和改动过的文件
python3 $S list --agent codex --since 7           # 最近 7 天的 Codex 会话
python3 $S list --since 7 --limit 200 --json       # 机器可读：UTC 起止时间、全部提问、最后一条回复
python3 $S handoff 01a11f3b                       # 会话 ID 或唯一前缀
```

- 公共过滤：`--agent all|claude|codex`、`--cwd <子串>`、`--since <天数>`（默认 30，0 为不限）、`--limit`（默认 10）。
- `search` 默认只搜用户提问和助手回复；`--regex` 把每组查询当正则。输出先给一张总表（agent、会话 ID 前 8 位、最后活动时间、命中数、工作目录、首个提问），按“首个提问命中 > 命中数 > 最近时间”排序；再展开前 `--detail`（默认 3）个会话的恢复命令和最近 `--per-session`（默认 2）处命中。
- `handoff` 输出会话元信息、全部用户提问、改动过的文件、最近命令、中间回复（截断）和最后一条回复；长度用 `--prompt-chars`、`--commands`、`--replies`、`--last-chars` 调整。

## 流程

1. **找会话**：从用户的话里提取具体关键词（应用名、接口名、报错、文件名），把同义说法写成多组一次搜完（如 `"乐包 复制" "复制乐包"`）；用户没给时间时用 `--since 0`。没命中再去掉一个词、加 `--all-kinds`；仍未命中时说明检索范围，不要断言"没做过"。
2. **确认对象**：总表前几行通常就是主题会话；首问命中或命中数明显领先的直接采用。同一需求可能分在多个会话（如后端在 Claude、前端在 Codex），都列出并说明各自做了什么；只有分不清时才让用户选。
3. **回答或交接**：
   - 用户只问结论：从命中片段和 `handoff` 的最后一条回复里回答，注明来自哪个会话和时间。
   - 用户要接着做：跑 `handoff`，按下面的模板写交接摘要，再继续工作。
4. **核对现状**：会话结束后代码和环境可能已变化。接着做之前，对摘要里的关键文件跑 `git status` / `git diff` 或重新查询，确认状态仍成立。

交接摘要模板（中文，写给当前 agent 自己和用户看）：

- 来源：agent、会话 ID、工作目录、时间；同一 agent 可直接用的恢复命令。
- 目标：用户最初要什么，后续怎么变化。
- 已完成：做了什么，验证到什么程度（如"编译通过、未跑单测"）。
- 关键结论和证据：结论及其依据；会话里没有验证过的标为"未验证"。
- 改动文件：路径列表，以及当前 `git status` 是否还在。
- 未完成和下一步：明确的待办、被阻塞的点、需要用户做的事。

## 边界

- 只读：不修改、不删除、不移动任何会话文件。
- 会话里有内网日志、查询结果和 Cookie 等内容。检索只在本机进行，但抽出来的片段会进入当前对话；不要把交接材料原样写入仓库或发布到外部服务，需要落盘时只写摘要。
- 两个 CLI 升级都可能改记录格式。某一边突然检索不到内容时，先用 `head` 看一行原始记录，再修 `scripts/agent_sessions.py` 的 `parse_claude` / `parse_codex`。
- 关键词检索不做语义匹配，换说法可能漏掉；结论要基于实际命中的原文，不要靠记忆补全。
