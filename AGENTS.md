# AGENTS.md

## 项目概述

个人 agent 工具仓库（skill + MCP），是 Claude Code 和 Codex 的**单一事实源**：
两个工具的 skill 目录均为指向本仓库的符号链接，MCP 注册的 PYTHONPATH 直接指向本仓库源码。
在仓库里改动文件即双端生效（skill 改动对新会话生效，MCP 改动需重启工具进程）。

## 仓库结构

```
agent-tools/
├── skills/
│   ├── dev-workflow/    # 研发阶段主线与编排（10）
│   ├── dev-quality/     # 开发质量增强：评审/验证维度 + 编码规范（5）
│   ├── env-access/      # 测试环境接口/数据/会话访问（4）
│   ├── cicd/            # 构建与发布（3）
│   └── observability/   # 运行时观测（2）
├── mcp/
│   ├── devtools-mcp/    # 研发工具链只读 MCP 集合（Python 包 devtools_mcp，16 个 server）
│   └── bastion-mcp/     # 堡垒机 SSH 通道 MCP（config.json 本地化）
├── install.py           # 符号链接安装脚本（claude + codex 双目标）
├── AGENTS.md            # 本文件（主文档）
└── CLAUDE.md            # 薄指针，指向本文件
```

## 安装机制

```bash
python3 install.py            # 符号链接安装到 ~/.claude/skills 和 ~/.codex/skills
python3 install.py --copy     # 复制模式兜底（符号链接不可用时）
python3 install.py --list     # 查看分类与技能
python3 install.py --uninstall
```

- 符号链接已实测可用：Claude Code（2026-06 验证）与 Codex 都能发现 skill 目录下的符号链接。
  早期"符号链接不可靠"的结论已过时。
- ❌ Plugin System（`~/.claude/plugins/local/` 手动注册）依然不可行，不要尝试。

## SKILL.md 约定

frontmatter 必须包含三个字段，缺一可能导致 skill 不被发现：

```yaml
---
name: skill-name
description: 何时触发此 skill 的描述
version: 1.0.0
---
```

- `agents/openai.yaml` 是 Codex 附加配置，Claude 忽略它，随 skill 目录一起维护。
- SKILL.md 中引用脚本一律使用仓库绝对路径
  （如 `/home/joney/projects/ai/agent-tools/skills/env-access/test-dubbo-api/scripts/dubbo_request.py`），
  不要写 `~/.claude/skills` 或 `~/.codex/skills`——两端符号链接共用同一份文件。
- skill 与 MCP 同能力双轨时，正文需注明"MCP 优先、脚本兜底"。

## MCP 注册

两端注册分别在 `~/.claude.json`（`claude mcp add --scope user`）和 `~/.codex/config.toml`，
PYTHONPATH 都指向本仓库内对应 MCP 目录。新增 MCP 服务器后需要在两处各加一条注册。

模块调用形式：`python3 -m devtools_mcp.<xxx>_server`、`python3 -m bastion_mcp.server`。

## 凭据与本地文件

不入 git（gitignore 管理，留在本地工作区）：

- `mcp/bastion-mcp/config.json`（堡垒机机器配置，模板见 config.json.example）
- `mcp/devtools-mcp/.env`（GITLAB_TOKEN / JENKINS_COOKIE / SONARQUBE_COOKIE 等）
- `skills/env-access/test-dubbo-api/targets.json`（应用 IP:Port 实数据）

## 命名约定

- 名称必须准确反映内容范围，避免过窄或过宽（历史教训：`java-backend-mcp` 实际只有
  `java_app_diag` 与 Java 相关，已更名 `devtools-mcp`；`backend-ops` 杂物抽屉式分类已拆为
  env-access / cicd / observability）。
- skill 分类目录：`dev-workflow`（阶段主线与编排）、`dev-quality`（质量增强）、
  `env-access`（环境访问）、`cicd`（构建发布）、`observability`（运行时观测）；
  新增分类在 `skills/` 下建子目录即可被 install.py 自动发现，MCP 侧 `skill_path()`
  也会按分类自动搜索。
