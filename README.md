# agent-tools

个人 agent 工具仓库（skill + MCP），Claude Code 和 Codex 共用的单一事实源。
两个工具的 skill 目录是指向本仓库的符号链接。MCP 注册需分别配置；已注册到本仓库的服务在重启后读取源码改动。skill 安装不等于 MCP 已注册或已认证。

维护约定见 [AGENTS.md](AGENTS.md)。

## skills/common — 跨分类复用的底层能力与方法论

| Skill | 说明 |
|---|---|
| `build-codeagent` | 执行后端 - 多后端 codeagent 处理大改动/并行子任务（被 dev-workflow 复用） |
| `debug-systematic` | 系统化调试方法论：复现→定位→根因→验证 |
| `skill-authoring` | 按仓库约定创建/维护 skill 的元技能 |

## skills/dev-workflow — 研发阶段主线与编排

| Skill | 说明 |
|---|---|
| `dev-clarify-task` | 需求澄清 - 收敛范围、非目标、稳定需求身份与验收标准 |
| `requirements-review` | 独立需求文档评审 - 检查 PRD/规格完整性并交接主线 |
| `dev-design-solution` | 方案设计 - 比较实现路径、识别影响与风险 |
| `dev-review-solution` | 技术方案评审 - 独立检查可行性、完整性与风险并给出评审结论 |
| `dev-derive-test-cases` | 编写测试清单 - 列清改完后检查什么、怎样算通过、需要什么证据 |
| `dev-review-test-cases` | 独立复核测试清单 - 由另一 agent 检查漏项、错项和可执行性，不执行测试 |
| `dev-build-change` | 代码开发 - 基于现有模式实施最小必要改动 |
| `dev-verify-change` | 验证 - 围绕变更做最小必要验证 |
| `dev-review-change` | 代码评审 - 基于变更证据评审正确性/架构/安全 |
| `dev-finish-branch` | 分支收尾 - 交付前核对变更、证据、评审与风险 |
| `dev-auto-loop` | 自动编排 - 用可恢复 checkpoint、独立预算和评审 agents 串联设计、测试清单准备与开发交付闭环 |

**主线**: dev-clarify-task → dev-design-solution → dev-review-solution → dev-derive-test-cases → dev-review-test-cases → dev-build-change → dev-verify-change → dev-review-change → dev-finish-branch

需求、方案、测试检查项、基线、代码修订和准入上下文统一遵循 [`skills/dev-workflow/references/artifact-identity.md`](skills/dev-workflow/references/artifact-identity.md)，防止评审或风险授权跨版本误用。

研发先选择 `governance_path`，交付阶段再形成同名的 `G.mode`：`approved` 用于完整阶段制流程，`direct` 用于边界清楚的普通开发任务，`waived` 仅表示明确豁免适用的正式门禁。`dev-auto-loop` 可在尚无方案/清单审批时按 `governance_path=approved` 启动，只有两项审批完成后才生成交付 `G.mode=approved`；它需显式调用 `$dev-auto-loop`。普通修复、测试或收尾不会为了满足格式伪造审批。

“测试清单”使用 `C` 和 `TC-*` 作为内部兼容标识，对用户统一称“检查项”。编写阶段产出待验证检查项，独立复核阶段只检查覆盖与可执行性；真正执行测试由 `dev-verify-change` 完成。正式审批写入 `rounds/round-<N>/approval-record.json`；direct/waived 分别使用不可变 `direct-record-v1` / `waiver-record-v1`。下游均以记录引用和指纹为准，不把可覆盖的 `review.md` 当审批事实源。

## agents/ 与 hooks/

- `agents/claude/`、`agents/codex/`：四类只读 reviewer，分别评审需求、方案、测试清单和代码。
- `hooks/subagent_result_guard.py`：在 reviewer 停止时校验 `delegation-result-v1` 结果信封；它不替代编排器对独立身份、实际工具面、有效沙箱、工作区写入和领域结论的核验。若 Codex 父会话权限覆盖 reviewer 配置，使其获得写入或危险 MCP 能力，本次结果不能作为正式独立评审。

## skills/dev-quality — 开发质量增强

| Skill | 说明 |
|---|---|
| `review-db-change` | 评审增强 - 数据库变更专项 |
| `review-middleware-reliability` | 评审增强 - 中间件可靠性专项 |
| `verify-java-coverage` | 验证增强 - JaCoCo 覆盖率深挖与门控 |
| `verify-browser-qa` | 验证增强 - 浏览器/页面专项验收 |
| `lang-java-service-patterns` | Java 服务编码模式约定 |

## skills/lexin — 乐信业务和内网平台访问

物理目录保持 `skills/lexin/<skill-name>/` 扁平结构，便于 `install.py` 自动发现；下表按业务域分组展示。

### 基础会话

| Skill | 说明 | 配套 MCP |
|---|---|---|
| `get-browser-session` | 浏览器登录态会话层（被多个内网页面 skill 复用） | `browser_session` |

### 文档协作

| Skill | 说明 | 配套 MCP |
|---|---|---|
| `manage-feishu-doc` | 读写 `lexin.feishu.cn` 飞书文档，预检权限并做幂等与回读校验 | `lark` |

### 发布与部署

| Skill | 说明 | 配套 MCP |
|---|---|---|
| `lexiao-deploy` | 乐效构建、发布和验收流程 | `lexiao` |
| `lexiao-hippo-publish-authorize` | 在乐效版本里登记需随版本发布的 hippo namespace | - |
| `query-app-instances` | 通过乐效只读查询应用各环境 VM 和容器实例地址 | `browser_session` |

### 米霍克 / OA

| Skill | 说明 | 配套 MCP |
|---|---|---|
| `handle-stable-hawk-approval` | 安全处理 stable 测试环境米霍克和流程引擎审批 | `mysql_readonly`, `dubbo_test` |
| `query-hawk-field-reference` | 查询米霍克字段被乐包、策略节点和规则引用的关系 | `browser_session` |
| `query-oa-gateway-interface` | 查询前端 URL 映射的后端接口和代码链路 | `browser_session` |
| `start-local-frontend` | 米霍克 OA 前端本地启动、whistle 网关切预发布/项目环境（IP 动态发现）与页面访问 | `browser_session` |

### 接口调用

| Skill | 说明 | 配套 MCP |
|---|---|---|
| `test-dubbo-api` | 通过 bianque 服务模拟器调用和编排 Dubbo 接口测试 | `dubbo_test` |
| `query-dubbo-registry` | 通过服务名查提供它的应用名，及 Dubbo/FSOF 注册中心只读查询 | `browser_session` |

### 数据与配置

| Skill | 说明 | 配套 MCP |
|---|---|---|
| `redis-query` | 通过 DevService.queryRedis 只读查询 Redis | `redis_query` |
| `query-mysql-data` | 从代码定位实例并只读查询 MySQL 测试/stable 与经授权线上数据 | `mysql_readonly` |
| `query-clickhouse-water` | 通过预发布/灰度/线上共用 DBA 堡垒机或 stable/测试 HTTP 接口查询 ClickHouse 流水 | `bastion_dba`、`browser_session` |
| `query-hippo-config` | 查看标准、stable 或墨西哥/印尼海外 Hippo 配置中心实际生效配置 | `browser_session` |
| `configure-hippo` | 新增、修改并在明确授权后发布标准、stable 或墨西哥/印尼海外 Hippo 配置 | `browser_session` |

### 监控与诊断

| Skill | 说明 | 配套 MCP |
|---|---|---|
| `java-server-diagnostics` | Java 应用服务器只读诊断：默认先查 `error.log`，再按线索递进排查 | `java_app_diag` |
| `healthy-dashboard-config` | Healthy/Nightingale 大盘配置 | `healthy` |
| `inspect-healthy-metrics` | 只读查看雷神指标上报状态、最后样本和注册辅助信息 | `browser_session` |
| `inspect-healthy-jvm-dashboard` | 只读查看雷神 JVM/G1 看板，整理变量、面板、PromQL 和页面快照 | `healthy`, `browser_session` |
| `register-healthy-metrics` | 查询、注册和复查 Healthy/雷神指标 | `browser_session` |
| `diagnose-healthy-alert` | 从雷神告警排查原因：事件、规则、指标回放、埋点代码到日志的证据链 | `browser_session` |
| `inspect-app-call-topology` | 只读排查应用 FSOF/Dubbo 上下游调用关系，异常下钻到实例与时间点，输出自包含 HTML 报告 | `browser_session` |

## skills/cicd — 构建与发布

| Skill | 说明 | 配套 MCP |
|---|---|---|
| `jenkins-pipeline-fix` | Jenkins 流水线诊断与修复（默认只读诊断，修复需显式开启） | `jenkins` |
| `fix-sonarqube-issues` | 评估并修复 SonarQube 新代码周期 BLOCKER/CRITICAL 问题 | `sonarqube` |

带配套 MCP 的 skill 均为"MCP 优先、脚本兜底"双轨。

## mcp/

| 位置 | 说明 |
|---|---|
| `mcp/devtools-mcp/` | 查询为主、部分工具支持写入的 MCP 集合（Python 包 `devtools_mcp`）：gitlab、jenkins、java_app_diag、browser_session、mysql_readonly、dubbo_test、redis_query、sonarqube、lexiao、healthy、observability、k8s_readonly、mq_readonly、artifact_repo、config_registry、cross_repo_search |
| `mcp/bastion-mcp/` | 堡垒机 SSH 只读通道 MCP（`config.json` 本地化，不入 git） |
| `mcp/third-party-mcp/` | 第三方通用 MCP wrapper/remote 配置：Context7 最新库文档、GitHub 只读上下文、MarkItDown 文档转 Markdown、Sonatype 依赖情报 |

## 安装

双端只读复查入口：`python3 bin/toolchain_audit.py`（摘要）或加 `--json`（脱敏明细）。
它核对配置、共享链接、缺失环境变量与模型窗口覆盖，不联网，也不证明业务 API 权限或运行时全部加载状态。
常规 PR 评审使用 `dev-review-change` 的建议审查分支；只有正式准入才要求审批记录。
浏览器专项可使用 Microsoft `playwright-cli`，入口见 `verify-browser-qa`；内网登录态仍由 `get-browser-session` 管理。

共享浏览器状态与技能源码分开存放：`~/.local/state/agent-tools/browser-profiles/{main,healthy,webshell}` 保存隔离的登录态，`~/.local/state/agent-tools/session-snapshots/` 保存本机凭据快照，均不入 Git。主 profile 的参数/环境变量优先级见 `get-browser-session`；移动已有 profile 前必须停止浏览器和续期任务，整套备份迁移，不能把两个 Cookie 数据库合并。升级前已启动的 MCP 可能仍持有旧默认路径：迁移时可暂留旧 `.cache` 路径的软链接，重启所有客户端并确认没有旧引用后再移除链接。

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
python3 install.py --with-subagents        # 额外安装双端 reviewer agents 与结果守卫 hook
python3 install.py --with-subagents --dry-run
python3 install.py --list
python3 install.py --with-subagents --uninstall
```

`--with-subagents` 会先检查所有 reviewer 目标；若发现同名外部 agent，默认整次失败且不写入，只有显式 `--force` 才替换，避免“外部 reviewer + 官方 hook”的半安装状态。它只合并本仓库拥有的 `SubagentStop` handler，不覆盖其他 hooks 或设置。Codex 首次安装或 hook 内容变化后，按客户端提示使用 `/hooks` 审查并信任新定义；安装器不会绕过该安全确认。
若 `~/.claude/settings.json` 或 `~/.codex/hooks.json` 本身由符号链接管理，安装器会拒绝替换链接；请在真实配置源中手工合并或改用普通文件。

MCP 注册（每端一次）：Claude 用 `claude mcp add --scope user`，Codex 在 `~/.codex/config.toml`，
PYTHONPATH 指向本仓库内对应 MCP 目录，模块形如 `python3 -m devtools_mcp.jenkins_server`。
凭据通过环境变量或本地 `.env` / `config.json` 提供，不入 git。

## 更新

```bash
cd ~/projects/ai/agent-tools && git pull
```

符号链接模式下 skill 改动无需重装；agent/hook 清单变化后重新运行 `python3 install.py --with-subagents`。skill 与 agent 改动对新会话生效，MCP 改动需重启 Claude/Codex。

## 添加新内容

- 新 skill：在 `skills/<分类>/<skill-name>/SKILL.md` 创建（frontmatter 必须含 `name`、`description`；版本放在 `metadata.version`），跑 `python3 install.py`。
- 新分类：在 `skills/` 下建子目录即可被自动发现。
- 新 MCP server：在 `mcp/devtools-mcp/devtools_mcp/` 加 `<xxx>_server.py`，然后在两端各注册一条。
