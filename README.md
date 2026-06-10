# claude-code-skills

个人 Claude Code 技能套件，支持多工作流组管理与选择性部署。

## 技能列表

### dev-workflow

开发生命周期工作流技能套件。

| Skill | 说明 |
|---|---|
| `requirement-clarifier` | 需求澄清 - 结构化梳理需求，输出需求规格文档 |
| `spec-generator` | 方案设计 - 生成技术方案和开发计划 |
| `tech-review` | 方案评审 - 多维度评审技术方案 |
| `code-dev` | 代码开发 - 基于开发计划逐步实现代码 |
| `test-verify` | 测试验证 - 单元测试/集成测试执行、生成与覆盖率分析 |
| `dev-cr` | 代码评审 - 16 维度代码审查 |

**工作流**: requirement-clarifier → spec-generator → tech-review → code-dev → test-verify → dev-cr

### java-backend

Java 后端研发 MCP 与排障技能套件。

| Skill | 说明 |
|---|---|
| `java-server-diagnostics` | Java 应用服务器只读诊断：基础状态、进程、端口、JVM、线程、GC/OOM、健康检查和日志 |
| `server-log` | 旧日志排查兼容入口 |
| `redis-query` | 通过 DevService.queryRedis 只读查询 Redis |
| `test-dubbo-api` | 通过 bianque 服务模拟器调用和编排 Dubbo 接口测试 |
| `get-browser-session` | 获取、检查和复用浏览器登录态 |
| `chrome-cookie` | 通过 Playwright/Chromium 获取浏览器 Cookie |
| `query-mysql-test-data` | 查询测试/stable 环境 MySQL 只读数据 |
| `fix-sonarqube-issues` | 评估并修复 SonarQube 新代码周期 BLOCKER/CRITICAL 问题 |
| `lexiao-deploy` | 乐效构建、发布和验收流程 |
| `healthy-dashboard-config` | Healthy/Nightingale 大盘配置 |
| `jenkins-pipeline-fix` | Jenkins 流水线失败诊断和修复 |

MCP 代码位于 `java-backend/mcp/java-backend-mcp/`，包括 `java_app_diag`、`mysql_readonly`、`redis_query`、`dubbo_test`、`browser_session` 等 Java 后端研发工具。

## 安装

```bash
git clone https://github.com/whooshao-design/claude-code-skills.git
cd claude-code-skills
```

### 安装所有技能

```bash
python3 install.py
# 或
bash install.sh
```

### 安装指定工作流组

```bash
python3 install.py --groups dev-workflow
python3 install.py --groups java-backend
```

### 选择性安装

```bash
python3 install.py --groups dev-workflow --skills code-dev,test-verify,dev-cr
```

### 查看可用技能

```bash
python3 install.py --list
```

### 强制覆盖

```bash
python3 install.py --force
```

### 卸载

```bash
python3 install.py --uninstall
python3 install.py --uninstall --groups dev-workflow --skills code-dev
```

## 安装原理

安装脚本将 skill 目录复制到 `~/.claude/skills/`（User Skills 机制），重启 Claude Code 后自动发现。

不修改 `installed_plugins.json` 或 `settings.json`，简单可靠。

## 目录结构

```
claude-code-skills/
├── dev-workflow/                    # 工作流组: 开发工作流
│   ├── .claude-plugin/plugin.json  # 工作流元数据
│   └── skills/
│       ├── requirement-clarifier/
│       ├── spec-generator/
│       ├── tech-review/
│       ├── code-dev/
│       ├── test-verify/
│       └── dev-cr/
├── java-backend/                    # Java 后端研发组
│   ├── .claude-plugin/plugin.json
│   ├── mcp/
│   │   └── java-backend-mcp/
│   └── skills/
├── install.py
├── install.sh
├── CLAUDE.md
├── README.md
└── .gitignore
```

## 更新 Skills

```bash
cd ~/projects/ai/claude-code-skills
git pull
python3 install.py --force   # 重新复制更新后的 skills
```

## 添加新工作流组

在仓库根目录创建新子目录，包含 `skills/` 目录即可自动被安装脚本发现。
