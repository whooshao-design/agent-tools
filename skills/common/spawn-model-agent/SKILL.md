---
name: spawn-model-agent
description: Use when 用户点名用某个国内模型或其他后端（qwen、deepseek、kimi、glm 等）做一个子任务，例如"用 kimi 总结这个文件""让 deepseek 起草说明""用 qwen 联网查一下"，或显式调用 /spawn-model-agent；在 Claude Code 与 Codex 里都另起一个该模型的 agent 进程执行，主会话只读结果。不做模型自动路由。
metadata:
  version: 1.2.0
---

# spawn-model-agent

## 定位

主会话的原生子 agent 换不了 provider：Claude Code 的 subagent 只能选 Claude 模型，Codex 的 agent 文件没有 `model_provider`。要让国内模型干活，只能另起一个进程。本 skill 把这件事做成一条命令：按宿主客户端选包装器，在指定目录里以和主会话同等的权限跑完任务，结果落到作业目录，主会话读结果转述。

模型由用户指定，不做智能选择。开发流程里的正式派发（producer / reviewer、候选轮换、参与登记）仍由 `build-codeagent` 负责，本 skill 不替代它。

## 用法

```bash
python3 /home/joney/projects/ai/agent-tools/skills/common/spawn-model-agent/scripts/spawn_model_agent.py \
  --backend kimi --task "总结 docs/design.md 的前三章，写成 10 行以内的要点" --cwd /home/joney/projects/xxx
```

- `--backend`：短名（`qwen` / `deepseek` / `kimi` / `glm` / `minimax` / `doubao` / `vps`）按宿主补成 `claude-<名>` 或 `codex-<名>`；也可以写完整包装器名如 `claude-qwen`、`codex-vps`。可用列表来自 PATH 上指向 `claude-profile` / `codex-profile` 的包装器，不是写死的。
- `--list`：列出可用后端，附 `build-codeagent/model-routing.json` 里的评审分与备注（未评测的显示"未测"，仍可用）。
- `--task`：任务文本，或 `@文件路径` 从文件读。写清目标、输入位置、期望输出形式。
- `--cwd`：agent 的工作目录，默认当前目录。它能读写这个目录，和主会话的子 agent 权限一致。
- `--slim`：仅 claude-*。用空配置目录启动，不加载全局 CLAUDE.md、记忆、skill 索引和 MCP；实测同一小任务 20.7s/66k token 降到 10.6s/34k。任务不依赖全局规则或 MCP 时默认加上。
- `--resume <作业目录>`：在上一次的 agent 会话里继续追问（claude 用 `--resume session_id`，codex 用 `exec resume thread_id`），不用重发材料。
- `--readonly`：可选，只读模式。
- `--wait`：前台等待结束；默认后台运行，命令立即返回作业目录。
- `--client claude|codex`：宿主检测顺序是 `CLAUDECODE` / `CODEX_*` 环境变量、父进程链里的 claude / codex 进程；都判不出时短名报错，用完整名或加这个参数。
- `--status <作业目录>`：查看一个后台作业的状态和结果。

作业目录在 `~/.local/state/spawn-model-agent/<时间>-<后端>/`：`task.md` 是任务原文，`result.md` 是 agent 的最终回复，`meta.json` 记录模型、耗时、token、退出码、会话 ID（供 `--resume`），`raw.*` 是原始输出。

## 后端适用性判断

派发前先看 `--list` 的"适用性"列（来自 `build-codeagent/model-routing.json` 的 `fit` 字段），有内容的后端要按它判断任务是否合适；脚本启动时也会在 stderr 打同一条提醒。

目前只有 `codex-glm` 有限制：乐信网关给 glm-5.3 的单次响应上限是 8192 输出 token，codex 不发 `max_output_tokens`，思考段占满就截断重连，最多五次后失败（2026-09-20 实测；`model_reasoning_effort=low` 也压不短它的思考）。用户说"用 glm"时：

- 宿主是 Claude Code：短名解析为 `claude-glm`（32k 上限），直接派。
- 宿主是 Codex 且任务是轻任务（单步、回复 2k 字以内：总结、抽取、小改动、查资料）：派 `codex-glm`。
- 宿主是 Codex 且任务重（整份文档或长代码生成、多缺陷评审、多步深度推理）：改派 `--backend claude-glm`（脚本接受完整名，跨客户端可用），并在转述时说明改派原因；用户坚持 `codex-glm` 就照做，结果出现 `Reconnecting`/`turn.failed` 时如实报告。

## 主会话的流程

1. 把用户的话整理成任务文本：要做什么、材料在哪、输出到哪、什么算完成。材料路径用绝对路径。
2. 运行脚本。默认后台，用 Monitor 或 `--status` 等它结束；短任务可以 `--wait`。
3. 读 `result.md`，核对它有没有按任务做（看 `meta.json` 的退出码和写入的文件），把结论转述给用户，附作业目录路径。codex-* 的 `raw.jsonl` 里有 `Reconnecting`/`turn.failed` 时一并说明。
4. 结果不可用时告诉用户是哪个模型、什么原因，不静默换模型重跑。

## 边界

- 权限与主会话的子 agent 相同：Claude 侧 `--dangerously-skip-permissions`，MCP 按用户配置继承；Codex 侧 `-s workspace-write -c approval_policy="never"`，MCP 由 `codex-profile` 关闭（网关不支持）。要限制时加 `--readonly`（claude 侧同时不接 MCP）。
- 两条通道都能联网：claude-* 有 WebSearch / WebFetch，codex-* 由脚本加上全局 `--search`，乐信网关实测能用原生 `web_search` 工具。
- 启动开销：claude-* 默认约 20 秒 / 65k token，`--slim` 约 10 秒 / 34k；codex-* 约 20 秒 / 45k。几秒钟能答的小问题不值得派发；追问用 `--resume` 省掉重发材料。
- 乐信网关约 20 分钟会断连，长任务让 agent 边做边写文件；`meta.json` 的 `subtype`/`exit_code` 不正常时看 `raw.*`。
- 后端能力与成本见 `build-codeagent/references/backend-evaluation.md` 与 `model-routing.json`。
