# AGENTS.md

## 项目概述

个人 agent 工具仓库（skill + MCP），是 Claude Code 和 Codex 的**单一事实源**：
两个工具的 skill 目录均为指向本仓库的符号链接，MCP 注册的 PYTHONPATH 直接指向本仓库源码。
在仓库里改动文件即双端生效（skill 改动对新会话生效，MCP 改动需重启工具进程）。

## 仓库结构

```
agent-tools/
├── skills/
│   ├── common/          # 跨分类复用的底层能力与通用方法论（3）
│   ├── dev-workflow/    # 研发阶段主线与编排（11）
│   ├── dev-quality/     # 开发质量增强：评审/验证维度 + 编码规范（5）
│   ├── cicd/            # 通用构建、流水线与质量门禁（2）
│   └── lexin/           # 乐信业务和内网平台访问（以 install.py --list 为准）
├── agents/
│   ├── claude/          # Claude Code 只读独立评审 subagents
│   └── codex/           # Codex 只读独立评审 agents
├── hooks/               # SubagentStop 结构化结果守卫及测试
├── mcp/
│   ├── devtools-mcp/    # 研发工具链 MCP（16 个 server；查询为主，部分工具可写）
│   ├── bastion-mcp/     # 堡垒机 SSH 通道 MCP（config.json 本地化）
│   └── third-party-mcp/ # 第三方通用 MCP wrapper/remote 配置（Context7、GitHub、MarkItDown、Sonatype）
├── install.py           # 符号链接安装脚本（claude + codex 双目标）
├── AGENTS.md            # 本文件（主文档）
└── CLAUDE.md            # 薄指针，指向本文件
```

## 安装机制

```bash
python3 install.py            # 符号链接安装到 ~/.claude/skills 和 ~/.codex/skills
python3 install.py --copy     # 复制模式兜底（符号链接不可用时）
python3 install.py --with-subagents  # 额外安装 reviewer agents 与结果守卫 hook
python3 install.py --with-subagents --dry-run
python3 install.py --list     # 查看分类与技能
python3 install.py --with-subagents --uninstall
```

- 符号链接已实测可用：Claude Code（2026-06 验证）与 Codex 都能发现 skill 目录下的符号链接。
  早期"符号链接不可靠"的结论已过时。
- 本仓库使用符号链接分发；不要手动修改 `~/.claude/plugins/local/` 或插件缓存来注册插件。需要插件打包时按当前客户端官方 CLI 与 manifest 约定另行实施，不沿用历史手工注册方式。
- `--with-subagents` 只合并 owner 为 `agent-tools-subagent-result-v1` 的 `SubagentStop` handler，
  不覆盖其他 settings/hooks；Codex 的 hook 信任由用户在 `/hooks` 中审查，安装器不代替确认。
- settings/hooks JSON 本身是符号链接时安装器会拒绝写入，避免破坏 dotfiles 管理关系。

## 独立评审约定

- 需求、方案、测试清单和代码的正式评审分别使用 `agent-tools-requirements-reviewer`、
  `agent-tools-solution-reviewer`、`agent-tools-test-design-reviewer`、`agent-tools-change-reviewer`。
- reviewer 的运行时身份必须与对应 `producer_agent_refs[]` 不相交，并保持实际有效的只读沙箱与最小工具面；
  写入即成为 producer，本轮评审失效。Codex 父会话权限可能覆盖 agent 静态沙箱，编排器必须核验生效配置，
  不能仅凭配置文件声明认定隔离成立。完整约定见 `skills/dev-workflow/references/delegation-contract.md`。
- hook 只校验 reviewer 的结构化结果信封；真实身份、有效权限、工作区写入与领域结论仍由编排器核验。
- `checks.write_set_empty` 必须引用平台可信的逐 agent 写入事件，或同一监视范围的派发前/stop 后快照；
  `changed_files: []` 和单次 `git status` 不能作为未写入证明。
- 正式审批以 `rounds/round-<N>/approval-record.json` 的引用和指纹为准；不得覆盖历史轮次，
  也不得把可变的 `review.md` 当作下游门禁事实源。
- `--with-subagents` 遇到同名外部 reviewer 时必须在写入前整体失败；仅在用户显式 `--force` 后替换，
  避免安装本仓库 hook 却继续运行未受控 reviewer。

## 研发流程模式

- 先选择 `governance_path`，构建、验证和收口时再形成对应的 `G.mode`；路径选择不等于门禁已通过。
- `approved`：完整阶段制流程；方案与测试清单的不可变审批记录齐全后才生成交付 `G`。
- `direct`：边界明确的普通修复、开发或验证；以不可变 `direct-record-v1` 保留最小可追踪上下文，不虚构正式审批。
- `waived`：用户明确豁免原本适用的正式门禁；`waiver-record-v1` 必须记录门禁闭包、逐项替代证据及残余风险。
- `dev-auto-loop` 仅适用于 `governance_path=approved`，并要求显式调用；不得隐式接管普通开发请求。
- `dev-auto-loop` 同一 run 的预算、补证次数和终态通过不可变 checkpoint 延续，恢复时不得重置；完整规则见 `skills/dev-workflow/dev-auto-loop/references/run-state-and-resume.md`。

## SKILL.md 约定

frontmatter 必须包含 `name` 和 `description`，缺一可能导致 skill 不被发现。需要记录版本时，放在系统校验器兼容的 `metadata.version` 中：

```yaml
---
name: skill-name
description: 何时触发此 skill 的描述
metadata:
  version: 1.0.0
---
```

- `agents/openai.yaml` 是 Codex 附加配置，Claude 忽略它，随 skill 目录一起维护。
- 不再使用顶层 `version` 字段；系统自带 `quick_validate.py` 不接受该字段。
- SKILL.md 中引用脚本一律使用仓库绝对路径
  （如 `/home/joney/projects/ai/agent-tools/skills/lexin/test-dubbo-api/scripts/dubbo_request.py`），
  不要写 `~/.claude/skills` 或 `~/.codex/skills`——两端符号链接共用同一份文件。
- skill 与 MCP 同能力双轨时，正文需注明"MCP 优先、脚本兜底"。

## MCP 注册

两端注册分别在 `~/.claude.json`（`claude mcp add --scope user`）和 `~/.codex/config.toml`，
PYTHONPATH 都指向本仓库内对应 MCP 目录。新增 MCP 服务器后需要在两处各加一条注册。

模块调用形式：`python3 -m devtools_mcp.<xxx>_server`、`python3 -m bastion_mcp.server`。
第三方 MCP 通过 `mcp/third-party-mcp/<name>/bin/<name>` wrapper 或官方 remote 配置注册，不在仓库提交依赖缓存。

## 凭据与本地文件

不入 git（gitignore 管理，留在本地工作区）：

- `mcp/bastion-mcp/config.json`（堡垒机机器配置，模板见 config.json.example）
- `mcp/devtools-mcp/.env`（GITLAB_TOKEN / JENKINS_COOKIE / SONARQUBE_COOKIE 等）
- `skills/lexin/test-dubbo-api/targets.json`（应用 IP:Port 实数据）

## 命名约定

- 名称必须准确反映内容范围，避免过窄或过宽（历史教训：`java-backend-mcp` 实际只有
  `java_app_diag` 与 Java 相关，已更名 `devtools-mcp`；`backend-ops` 杂物抽屉式分类已拆为
  env-access / cicd / observability）。
- skill 分类目录：`common`（跨分类复用的底层能力与方法论）、`dev-workflow`（阶段主线与编排）、
  `dev-quality`（质量增强）、`cicd`（通用构建、流水线与质量门禁）、`lexin`（乐信业务、内网平台、
  OA/Hawk/乐效/Hippo/Healthy/bianque/内网数据访问）；新增分类在 `skills/` 下建子目录即可被
  install.py 自动发现，MCP 侧 `skill_path()` 也会按分类自动搜索。
- 创建/修改 skill 的完整流程见 `skills/common/skill-authoring/SKILL.md`。
