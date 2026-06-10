# agent-tools

个人 agent 工具仓库（skill + MCP），Claude Code 和 Codex 共用的单一事实源。
两个工具的 skill 目录是指向本仓库的符号链接，MCP 注册直接指向本仓库源码——仓库内改动即双端生效。

维护约定见 [AGENTS.md](AGENTS.md)。

## skills/common — 跨分类复用的底层能力与方法论

| Skill | 说明 |
|---|---|
| `get-browser-session` | 浏览器登录态会话层（被 env-access/cicd 多个 skill 复用） |
| `build-codeagent` | 执行后端 - 多后端 codeagent 处理大改动/并行子任务（被 dev-workflow 复用） |
| `debug-systematic` | 系统化调试方法论：复现→定位→根因→验证 |
| `skill-authoring` | 按仓库约定创建/维护 skill 的元技能 |

## skills/dev-workflow — 研发阶段主线与编排

| Skill | 说明 |
|---|---|
| `dev-clarify-task` | 需求澄清 - 收敛范围、非目标、验收标准 |
| `requirements-review` | 需求评审 - 评审 PRD/需求文档完整性 |
| `dev-design-solution` | 方案设计 - 比较实现路径、识别影响与风险 |
| `design-tech-review` | 方案评审 - 边界/异常/一致性检查 |
| `dev-build-change` | 代码开发 - 基于现有模式实施最小必要改动 |
| `dev-verify-change` | 验证 - 围绕变更做最小必要验证 |
| `dev-review-change` | 代码评审 - 基于变更证据评审正确性/架构/安全 |
| `dev-finish-branch` | 分支收尾 - 提交、推送、收尾检查 |
| `dev-auto-loop` | 自动编排 - 串联多个开发阶段持续推进 |

**主线**: dev-clarify-task → dev-design-solution → design-tech-review → dev-build-change → dev-verify-change → dev-review-change → dev-finish-branch

## skills/dev-quality — 开发质量增强

| Skill | 说明 |
|---|---|
| `review-db-change` | 评审增强 - 数据库变更专项 |
| `review-middleware-reliability` | 评审增强 - 中间件可靠性专项 |
| `verify-java-coverage` | 验证增强 - JaCoCo 覆盖率深挖与门控 |
| `verify-browser-qa` | 验证增强 - 浏览器/页面专项验收 |
| `lang-java-service-patterns` | Java 服务编码模式约定 |

## skills/env-access — 测试环境接口/数据/会话访问

| Skill | 说明 | 配套 MCP |
|---|---|---|
| `test-dubbo-api` | 通过 bianque 服务模拟器调用和编排 Dubbo 接口测试 | `dubbo_test` |
| `redis-query` | 通过 DevService.queryRedis 只读查询 Redis | `redis_query` |
| `query-mysql-test-data` | 查询测试/stable 环境 MySQL 只读数据 | `mysql_readonly` |

## skills/cicd — 构建与发布

| Skill | 说明 | 配套 MCP |
|---|---|---|
| `jenkins-pipeline-fix` | Jenkins 流水线诊断与修复（默认只读诊断，修复需显式开启） | `jenkins` |
| `fix-sonarqube-issues` | 评估并修复 SonarQube 新代码周期 BLOCKER/CRITICAL 问题 | `sonarqube` |
| `lexiao-deploy` | 乐效构建、发布和验收流程 | `lexiao` |

## skills/observability — 运行时观测

| Skill | 说明 | 配套 MCP |
|---|---|---|
| `java-server-diagnostics` | Java 应用服务器只读诊断：进程、端口、JVM、线程、GC/OOM、健康检查和日志 | `java_app_diag` |
| `healthy-dashboard-config` | Healthy/Nightingale 大盘配置 | `healthy` |

带配套 MCP 的 skill 均为"MCP 优先、脚本兜底"双轨。

## mcp/

| 位置 | 说明 |
|---|---|
| `mcp/devtools-mcp/` | 研发工具链只读 MCP 集合（Python 包 `devtools_mcp`）：gitlab、jenkins、java_app_diag、browser_session、mysql_readonly、dubbo_test、redis_query、sonarqube、lexiao、healthy、observability、k8s_readonly、mq_readonly、artifact_repo、config_registry、cross_repo_search |
| `mcp/bastion-mcp/` | 堡垒机 SSH 只读通道 MCP（`config.json` 本地化，不入 git） |

## 安装

```bash
git clone git@github.com:whooshao-design/agent-tools.git ~/projects/ai/agent-tools
cd ~/projects/ai/agent-tools
python3 install.py           # 符号链接到 ~/.claude/skills 和 ~/.codex/skills
```

选择性安装与卸载：

```bash
python3 install.py --groups dev-workflow
python3 install.py --skills dev-build-change,dev-review-change
python3 install.py --targets claude        # 只装 Claude
python3 install.py --copy                  # 复制模式兜底
python3 install.py --list
python3 install.py --uninstall
```

MCP 注册（每端一次）：Claude 用 `claude mcp add --scope user`，Codex 在 `~/.codex/config.toml`，
PYTHONPATH 指向本仓库内对应 MCP 目录，模块形如 `python3 -m devtools_mcp.jenkins_server`。
凭据通过环境变量或本地 `.env` / `config.json` 提供，不入 git。

## 更新

```bash
cd ~/projects/ai/agent-tools && git pull
```

符号链接模式下无需重装；skill 改动对新会话生效，MCP 改动需重启 Claude/Codex。

## 添加新内容

- 新 skill：在 `skills/<分类>/<skill-name>/SKILL.md` 创建（frontmatter 必须含 `name`、`description`、`version`），跑 `python3 install.py`。
- 新分类：在 `skills/` 下建子目录即可被自动发现。
- 新 MCP server：在 `mcp/devtools-mcp/devtools_mcp/` 加 `<xxx>_server.py`，然后在两端各注册一条。
