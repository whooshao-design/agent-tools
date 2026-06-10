# CLAUDE.md

## 项目概述

个人 skill 与 MCP 套件仓库，是 Claude Code 和 Codex 的**单一事实源**：
两个工具的 skill 目录均为指向本仓库的符号链接，MCP 注册的 PYTHONPATH 直接指向本仓库源码。
在仓库里改动文件即双端生效（skill 改动对新会话生效，MCP 改动需重启工具进程）。

## 安装机制

```bash
python3 install.py            # 符号链接安装到 ~/.claude/skills 和 ~/.codex/skills
python3 install.py --copy     # 复制模式兜底（符号链接不可用时）
python3 install.py --list     # 查看组与技能
python3 install.py --uninstall
```

- 符号链接已实测可用：Claude Code（2026-06 验证）与 Codex 都能发现 `~/.claude/skills/`、`~/.codex/skills/` 下的符号链接 skill。早期"符号链接不可靠"的结论已过时。
- ❌ Plugin System（`~/.claude/plugins/local/` 手动注册）依然不可行，不要尝试。

## SKILL.md frontmatter 必须包含三个字段

```yaml
---
name: skill-name
description: 何时触发此 skill 的描述
version: 1.0.0
---
```

缺少任一字段都可能导致 skill 不被发现。`agents/openai.yaml` 是 Codex 附加配置，Claude 忽略它，随 skill 目录一起维护。

## 路径约定

- SKILL.md 中引用脚本一律使用仓库绝对路径（如 `/home/joney/projects/ai/claude-code-skills/java-backend/skills/test-dubbo-api/scripts/dubbo_request.py`），不要写 `~/.claude/skills` 或 `~/.codex/skills`——两端符号链接共用同一份文件。
- 凭据与机器配置不入 git：`mcp/bastion-mcp/config.json`、`java-backend/skills/test-dubbo-api/targets.json`、`java-backend/mcp/java-backend-mcp/.env` 均被 gitignore，留在本地工作区。

## 仓库结构

```
claude-code-skills/
├── dev-workflow/skills/      # 开发分层工作流（dev-clarify-task → dev-review-change 等 15 个）
├── java-backend/
│   ├── skills/               # Java 后端排障/测试技能（10 个）
│   └── mcp/java-backend-mcp/ # Java 后端只读 MCP 集合
├── mcp/bastion-mcp/          # 堡垒机 MCP（config.json 本地化）
├── install.py                # 符号链接安装脚本（claude + codex 双目标）
└── CLAUDE.md                 # 本文件
```

## MCP 注册

两端注册分别在 `~/.claude.json`（`claude mcp add --scope user`）和 `~/.codex/config.toml`，
PYTHONPATH 都指向本仓库。新增 MCP 服务器后需要在两处各加一条注册。
