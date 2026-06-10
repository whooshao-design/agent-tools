# claude-code-skills

个人 skill 与 MCP 套件，Claude Code 和 Codex 共用的单一事实源。
两个工具的 skill 目录是指向本仓库的符号链接，MCP 注册直接指向本仓库源码——仓库内改动即双端生效。

## 技能列表

### dev-workflow

开发分层工作流（按任务阶段治理，单套分层）。

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
| `build-codeagent` | 执行后端 - 多后端 codeagent 处理大改动/并行子任务 |
| `verify-java-coverage` | 验证增强 - JaCoCo 覆盖率深挖与门控 |
| `verify-browser-qa` | 验证增强 - 浏览器/页面专项验收 |
| `review-db-change` | 评审增强 - 数据库变更专项 |
| `review-middleware-reliability` | 评审增强 - 中间件可靠性专项 |
| `lang-java-service-patterns` | Java 服务编码模式约定 |

**主线**: dev-clarify-task → dev-design-solution → design-tech-review → dev-build-change → dev-verify-change → dev-review-change → dev-finish-branch

### java-backend

Java 后端研发 MCP 与排障技能套件。

| Skill | 说明 |
|---|---|
| `java-server-diagnostics` | Java 应用服务器只读诊断：进程、端口、JVM、线程、GC/OOM、健康检查和日志 |
| `server-log` | 堡垒机日志排查（完整工作流） |
| `redis-query` | 通过 DevService.queryRedis 只读查询 Redis |
| `test-dubbo-api` | 通过 bianque 服务模拟器调用和编排 Dubbo 接口测试 |
| `get-browser-session` | 获取、检查和复用浏览器登录态（会话层，其他 skill 复用） |
| `query-mysql-test-data` | 查询测试/stable 环境 MySQL 只读数据 |
| `fix-sonarqube-issues` | 评估并修复 SonarQube 新代码周期 BLOCKER/CRITICAL 问题 |
| `lexiao-deploy` | 乐效构建、发布和验收流程 |
| `healthy-dashboard-config` | Healthy/Nightingale 大盘配置 |
| `jenkins-pipeline-fix` | Jenkins 流水线诊断与修复（默认只读诊断，修复需显式开启） |

### MCP

| 位置 | 说明 |
|---|---|
| `java-backend/mcp/java-backend-mcp/` | Java 后端只读 MCP 集合：gitlab、jenkins、java_app_diag、browser_session、mysql_readonly、dubbo_test、redis_query、sonarqube、lexiao、healthy、observability、k8s_readonly、mq_readonly、artifact_repo、cross_repo_search 等 |
| `mcp/bastion-mcp/` | 堡垒机 SSH 只读通道 MCP（`config.json` 本地化，不入 git） |

## 安装

```bash
git clone git@github.com:whooshao-design/claude-code-skills.git
cd claude-code-skills
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
PYTHONPATH 指向本仓库内对应 MCP 目录。凭据通过环境变量或本地 `.env` / `config.json` 提供，不入 git。

## 更新

```bash
cd ~/projects/ai/claude-code-skills && git pull
```

符号链接模式下无需重装；skill 改动对新会话生效，MCP 改动需重启 Claude/Codex。

## 添加新工作流组

在仓库根目录创建 `<group>/skills/<skill-name>/SKILL.md`，运行 `python3 install.py` 即可。
SKILL.md frontmatter 必须含 `name`、`description`、`version` 三字段；脚本引用写仓库绝对路径。
