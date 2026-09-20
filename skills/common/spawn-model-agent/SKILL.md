---
name: spawn-model-agent
description: Use when 用户点名用某个国内模型或其他后端（qwen、deepseek、kimi、glm 等）做一个子任务，例如"用 kimi 总结这个文件""让 deepseek 起草说明""用 qwen 联网查一下"，或显式调用 /spawn-model-agent；在 Claude Code 与 Codex 里都另起一个该模型的 agent 进程执行，主会话只读结果。不做模型自动路由。
metadata:
  version: 1.0.0
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

- `--backend`：`qwen` / `deepseek` / `kimi` / `glm` / `minimax` 这类短名按宿主自动补成 `claude-<名>` 或 `codex-<名>`；也可以写完整包装器名如 `claude-qwen`、`codex-vps`。
- `--task`：任务文本，或 `@文件路径` 从文件读。写清目标、输入位置、期望输出形式。
- `--cwd`：agent 的工作目录，默认当前目录。它能读写这个目录，和主会话的子 agent 权限一致。
- `--readonly`：可选，只读模式。
- `--wait`：前台等待结束；默认后台运行，命令立即返回作业目录。
- `--client claude|codex`：宿主自动检测失败时手动指定。
- `--status <作业目录>`：查看一个后台作业的状态和结果。

作业目录在 `~/.local/state/spawn-model-agent/<时间>-<后端>/`：`task.md` 是任务原文，`result.md` 是 agent 的最终回复，`meta.json` 记录模型、耗时、token、退出码，`raw.*` 是原始输出。

## 主会话的流程

1. 把用户的话整理成任务文本：要做什么、材料在哪、输出到哪、什么算完成。材料路径用绝对路径。
2. 运行脚本。默认后台，用 Monitor 或 `--status` 等它结束；短任务可以 `--wait`。
3. 读 `result.md`，核对它有没有按任务做（看 `meta.json` 的退出码和写入的文件），把结论转述给用户，附作业目录路径。
4. 结果不可用时告诉用户是哪个模型、什么原因，不静默换模型重跑。

## 边界

- 权限与主会话的子 agent 相同：Claude 侧 `--dangerously-skip-permissions`，Codex 侧 `-s workspace-write -c approval_policy="never"`，工作目录内可读写。要限制时加 `--readonly`。
- 两条通道都能联网：claude-* 有 WebSearch / WebFetch，codex-* 由脚本加上全局 `--search`，乐信网关实测能用原生 `web_search` 工具。
- 每次启动约 30–60 秒开销（加载全局说明、记忆和 skill 索引）；不适合几秒钟的小问题。
- 乐信网关约 20 分钟会断连，长任务让 agent 边做边写文件；`meta.json` 的 `subtype`/`exit_code` 不正常时看 `raw.*`。
- 后端能力与成本见 `build-codeagent/references/backend-evaluation.md` 与 `model-routing.json`。
