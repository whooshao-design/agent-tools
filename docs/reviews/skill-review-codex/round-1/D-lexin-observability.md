# lexin 观测与诊断（前缀 D）评审报告

## 1. 总体判断

整体职责划分较清楚，但存在会选错目标、误读查询结果的缺陷，需要优先修正。  
已逐个核对 13 个 skill 目录的 52 个文件，包括 references、脚本接口、附加配置和测试；未修改文件或调用内网业务接口。  
最大风险是 Dubbo 线路与部署环境混用，以及把不完整证据解释为确定结论。  
最值得先做的三件事：分离调用线路与目标环境；修正日志结果字段口径；阻止注册中心查询静默丢页或选择首个提供方。  
6 个测试文件通过，WebShell 解析相关选择测试通过；WebShell 全量测试停滞后中止，不计为通过。以下结论基于静态核对和离线模拟，未验证线上行为。

## 2. Findings

以下文件路径均相对于 `/home/joney/projects/ai/agent-tools/skills/lexin/`；行号对应本次读取的工作区内容。

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| D-01 | test-dubbo-api | `test-dubbo-api/SKILL.md:88`；`test-dubbo-api/scripts/dubbo_request.py:157` | High | 环境边界 | 站点线路归一后，被用于选择部署地址；请求生产环境可能实际调用预发布实例。 | 正文要求“环境……归一到 stable/pre”，随后查 `<app>.<env>`；脚本 `"prod": "pre"`（68 行），再执行 `.get(target_env)`。离线提供不同的 prod/pre 地址，prod 确实选中了 pre。 | 保留原始部署环境，线路单独归一；没有对应部署地址时要求明确 IP:Port，不借用 pre 地址。 | 确认 |
| D-02 | diagnose-healthy-alert | `diagnose-healthy-alert/SKILL.md:130`；`diagnose-healthy-alert/scripts/diagnose_alert.js:540` | High | 输出契约 | 将“没有命中事件的文件”误解释为“没有扫描文件”，会反复调整轮转文件路径并否定真实空结果。 | 正文：“`matchedFiles: []` 是没有文件被扫到”；下游 `java-server-diagnostics/scripts/webshell_log_check.js:479` 仅在 `role === 'match'` 时添加文件。离线结果可同时为 `fileCount=2, matchedFiles=[], matchedEvents=0`。 | 正文和脚本提示一起改为用 `fileCount`、`logDirExists`、错误码判断文件是否存在；`matchedFiles` 只表示命中文件。 | 确认 |
| D-03 | query-app-logs、java-server-diagnostics | `query-app-logs/SKILL.md:50`；`java-server-diagnostics/scripts/container_log_check.js:135` | High | 接口一致性 | 容器快检承诺只查 error.log，但 kubectl 成功分支实际查 stdout；可能漏掉只写文件的异常，却被当成 error.log 检查完成。 | 正文：“只看 `error.log`”；脚本构造的是 `'logs', pod.pod_name`，结果来源为 `'kubectl-stdout'`（179 行），quick 分支的 `limitations` 为空（284 行）。 | 文件快检走已有文件读取路径；stdout 查询明确标注来源及限制，不作为 error.log 已检查的证据。 | 确认 |
| D-04 | inspect-app-call-topology | `inspect-app-call-topology/scripts/inspect_call_topology.js:1091` | High | 目标歧义 | `--service` 命中多个提供方时自动选第一个，后续报告可能围绕错误应用展开。 | 脚本：“有多个提供方……取第一个继续”，随后 `apps.push(list[0])`；正文 177 行要求多提供方“标为多候选，不假装能归到某一个”。 | 返回候选并要求用已有 `--app` 参数明确目标，不自动选择第一项。 | 确认 |
| D-05 | query-dubbo-registry | `query-dubbo-registry/scripts/query_dubbo_registry.js:194`、`:291` | High | 结果完整性 | 注册中心只查第一页，输出又丢弃总数，应用服务清单和归属候选可能静默不全。 | 请求固定 `pageIndex='1'`；查询返回 `{total,list}`，主流程只使用 `list`；最终 JSON 没有 total 或截断标识。离线返回 total=201，仍只有一次第一页请求。 | 按总数翻页；若保留单页模式，必须输出截断标志，禁止据此声称候选或服务清单完整。 | 确认 |
| D-06 | query-hawk-field-reference | `query-hawk-field-reference/scripts/hawk_field_ref.py:205` | High | 失败语义 | 错误 JSON 可以被转换成“无引用”，影响字段删除或变更的影响面判断。 | 收到 payload 后直接读 `total_page` 和 `result_rows`，未检查错误状态；280–310 行最终正常返回。离线输入 `{"retcode":-1,"retmsg":"permission denied","result_rows":[]}` 得到 `[]`。 | 解析记录前校验接口成功状态和响应结构；错误响应非零退出，不输出正常空引用结论。 | 确认 |
| D-07 | test-dubbo-api | `test-dubbo-api/SKILL.md:76`、`:80` | High | 凭据边界 | 自动登录失败的两条指令互相冲突，其中一条要求把 Cookie 放进会话上下文。 | 76 行：“不要在聊天中索要……Cookie”；80–82 行又要求“手动复制……`JSESSIONID` 和 `ltrace_sessionId`”，且“Cookie 保存在会话上下文中”。 | 删除复制 Cookie 到会话的兜底，统一使用已有浏览器重新登录流程。 | 确认 |
| D-08 | diagnose-healthy-alert | `diagnose-healthy-alert/SKILL.md:152` | High | 诊断正确性 | 仅凭当前存在性和 TTL 无法区分缓存从未写入与已经过期，却被要求据此定性。 | 原文：“查存在性、TTL 即可区分‘没写入’和‘已过期’”。两种情况均可能表现为当前 key 不存在。 | 改为仅判断当前存在性与剩余有效期；区分未写入和过期需要写入日志或历史证据，否则保留未知。 | 确认 |
| D-09 | inspect-healthy-jvm-dashboard | `inspect-healthy-jvm-dashboard/SKILL.md:21`；`inspect-healthy-jvm-dashboard/scripts/inspect_dashboard.js:58` | Medium | 引用有效性 | JVM 看板入口仍消费旧备份路径，当前大盘工具返回值无法衔接；没有旧文件时失败，有旧文件时可能读取过期配置。 | 正文要求 `/tmp/healthy-dashboard-{boardId}-after.json`；脚本读取 `parsed.backup?.after`。实际 `healthy-dashboard-config/scripts/healthy_dashboard_config.js:260` 保存 `before.json`，272 行返回 `backupDir`。 | 从当前输出的 `backupDir/before.json` 或完整 `configs` 取数，同步修正离线示例。 | 确认 |
| D-10 | diagnose-healthy-alert、inspect-healthy-jvm-dashboard、register-healthy-metrics | `diagnose-healthy-alert/scripts/diagnose_alert.js:190`；`inspect-healthy-jvm-dashboard/scripts/inspect_dashboard.js:174`；`register-healthy-metrics/scripts/register_metrics.js:272` | Medium | 认证契约 | 三个入口仍模糊匹配 token，可能取到 refresh_token，导致已有登录态被误判失效。 | 三处均使用 `/access.?token\|token/i` 查找第一个键；而 `inspect-healthy-metrics/SKILL.md:46` 明确禁止此做法。离线按 refresh_token 在前的键顺序，确实选中 refresh_token。 | 三处改为精确读取 `access_token`，与现有公共客户端一致。 | 确认 |
| D-11 | inspect-healthy-metrics | `inspect-healthy-metrics/scripts/inspect_metrics.js:308` | Medium | 查询边界 | 开启辅助注册表检查后，未注册指标直接跳过全部 Prometheus 查询，无法回答它是否实际有上报。 | `if (!row.registered) ... return row`；离线结果为 `UNREGISTERED/current_series=0`，Prometheus 请求数为 0。`inspect-app-call-topology/SKILL.md:21` 已说明 fsof 指标“不在注册表里”。 | 注册状态作为独立字段保留，继续检查样本；未查询的数据不要填成已确认的 0。 | 确认 |
| D-12 | register-healthy-metrics | `register-healthy-metrics/SKILL.md:33`；`register-healthy-metrics/scripts/register_metrics.js:189` | Medium | 输入契约 | 文档提供通用指标注册入口，但显式给出 metric/app/desc 仍无法注册非内置后缀指标。 | 构建请求前无条件 `parseMetric(target.metric, input.userSuffixes)`；169–183 行只接受已知后缀。离线完整指定 `fql_fk_demo_requests_total` 的 app、desc，仍报 `Cannot parse known suffix`。 | 已显式提供 app、desc 时不强制推导；需要推导时明确限制与补参方式。 | 确认 |
| D-13 | query-app-logs | `query-app-logs/SKILL.md:53`、`:69` | Medium | 跨 skill 衔接 | 容器示例没有传 profile，下游默认使用 webshell profile，与本批次已记录的可用 main profile 不一致，容易产生伪登录失效。 | `java-server-diagnostics/scripts/webshell_log_check.js:20` 默认 `browser-profiles/webshell`；`diagnose-healthy-alert/references/log-forensics.md:45` 明确写“必须显式传 `--profile`”，否则会报 LOGIN_REQUIRED。 | 容器示例传入已验证的 profile，并将同一 profile 透传给下游。 | 确认 |
| D-14 | query-app-instances | `query-app-instances/SKILL.md:47` | Medium | 路径时效性 | 推荐命令使用迁移前项目路径，应用名自动推导会失败。 | `--cwd /home/joney/projects/hawk/server_hawk_decision_executor`；该路径不存在，现有路径为 `/home/joney/projects/backend/hawk/server_hawk_decision_executor`。 | 仅更新该示例路径。 | 确认 |
| D-15 | healthy-dashboard-config | `healthy-dashboard-config/SKILL.md:3`；`healthy-dashboard-config/scripts/healthy_dashboard_config.js:242` | Medium | 触发与能力边界 | description 承诺“新建大盘”，实际流程和入口都要求已有 board ID，没有创建大盘的接口。 | description：“新建或修改监控大盘”；脚本要求 `--board` 为正整数，随后先 GET 已有 `/board/{id}`（258–259 行）。 | 将触发范围收窄到已有大盘配置；需要创建时明确说明缺少创建入口，不借用已有大盘。 | 确认 |
| D-16 | test-dubbo-api | `test-dubbo-api/SKILL.md:187`；`test-dubbo-api/scripts/dubbo_scenario.py:200` | Medium | 预览契约 | 多步骤场景支持响应提取，但 dry-run 不能预览依赖前序提取值的后续步骤，文档没有说明限制。 | dry-run 在 200–208 行直接返回，提取仅在 213–214 行执行；离线“创建并提取 id → 查询 `{{id}}`”预览报 `template variable not found: id`。 | 说明响应依赖变量需用已有 `--var` 提供预览值；缺值时明确标为预览受限，不暗示场景本身无效。 | 确认 |
| D-17 | diagnose-healthy-alert | `diagnose-healthy-alert/scripts/diagnose_alert.js:102`、`:680` | Medium | 环境衔接 | 接收完整 stable 告警 URL 时只提取 ID，不使用 URL 的站点；省略 env 会查询生产站点的同号事件。 | `resolveBaseUrl` 默认 prod，`resolveAlertId` 仅匹配 `alert-show-detail/数字`。离线传入 stable 完整链接，得到生产 base URL。正文 78 行仅说完整链接“自动抽 ID”，未提示站点被忽略。 | 从受支持 URL 推导站点，显式 env 与 URL 冲突时拒绝；至少明确要求从链接透传 env。 | 确认 |

## 3. 跨 skill / 跨文件问题

- 日志路由迁移后，告警入口仍指向 Java 诊断入口：`diagnose-healthy-alert/SKILL.md:20` 写“日志检索由它执行”，而 `java-server-diagnostics/SKILL.md:96` 已交给 `query-app-logs`；后者正文 38 行又默认先查 error.log。应直接交接已确定的日志级别、关键词和时间窗，避免已定位的 WARN 取证重新进入快检门槛。
- Healthy 认证口径已经分叉：`healthy-dashboard-config/SKILL.md:113` 要求精确读取 access_token，但三个旧入口仍模糊匹配；对应 D-10，修复范围无需扩成整个认证体系重构。
- 注册中心结果会被其他 skill 放大使用：`inspect-app-call-topology/SKILL.md:146` 用它补归属，`query-oa-gateway-interface/SKILL.md:95` 要求冲突时“以注册中心为准”；因此 D-05 的截断会影响不止一份报告，消费方也应保留查询完整性和冲突信息。
- JVM 看板与大盘配置的备份约定已不同步：前者 `SKILL.md:21` 指定固定 after.json，后者 `SKILL.md:71` 明确返回独立目录；对应 D-09，应以工具返回路径为准。
- MCP 名称仍夹杂旧注册方式：`test-dubbo-api/SKILL.md:12` 写“已注册 dubbo_test MCP”，`inspect-healthy-jvm-dashboard/SKILL.md:21` 使用 `healthy.healthy_read_board`，但仓库 `AGENTS.md:139` 说明统一前缀为 `mcp__devtools__<tool>`；宜明确这些是能力模块名，实际按聚合后的工具名调用。

## 4. 做得好、不要动

- `healthy-dashboard-config/SKILL.md:70` 的回读、备份、指纹校验、写后完整比较和页面实际查询验证形成了有效闭环；对应测试通过，不应简化成“HTTP 200 即成功”。
- `inspect-app-call-topology/SKILL.md:115` 明确关闭默认异常下钻，用户要求后才开启；测试覆盖默认关闭和显式开启，能控制排查范围与成本。
- `query-dubbo-registry/SKILL.md:21` 清楚区分注册声明、实际流量、部署实例和接口调用；这组职责边界应保留。
- `query-app-instances/SKILL.md:78` 坚持使用乐效原始登录地址、交叉校验 Pod 元数据、缺地址不猜测，避免进入错误容器。
- `query-app-logs/references/log-platform-http.md:64` 记录了分页去重陷阱，`query-oa-gateway-interface/SKILL.md:16` 正确区分 GET MCP 与只读 POST 入口；这些内容直接影响执行正确性，不属于可删背景。

## 5. 优先级 Top 10

1. D-01：分离线路与部署环境，防止调用错误实例。
2. D-02：修正 matchedFiles 判定，避免错误取证方向。
3. D-03：让容器快检来源与 error.log 承诺一致。
4. D-06：错误响应不得输出“无字段引用”。
5. D-05：补齐注册中心分页或明确截断。
6. D-04：多提供方停止自动选择第一项。
7. D-07：删除 Cookie 进入会话上下文的指令。
8. D-09：修复 JVM 看板备份路径衔接。
9. D-08：删除 TTL 能区分未写入与已过期的错误推断。
10. D-10：统一精确读取 access_token。

## 6. JSON

```json
{
  "batch": "D",
  "findings": [
    {
      "id": "D-01",
      "skill": "test-dubbo-api",
      "location": "skills/lexin/test-dubbo-api/SKILL.md:88; skills/lexin/test-dubbo-api/scripts/dubbo_request.py:157",
      "severity": "High",
      "category": "环境边界",
      "summary": "生产环境归一为 pre 后被用于选择预发布部署地址。",
      "fix": "分离站点线路与部署环境，缺少目标环境地址时要求明确 IP:Port。",
      "confidence": "确认"
    },
    {
      "id": "D-02",
      "skill": "diagnose-healthy-alert",
      "location": "skills/lexin/diagnose-healthy-alert/SKILL.md:130; skills/lexin/diagnose-healthy-alert/scripts/diagnose_alert.js:540",
      "severity": "High",
      "category": "输出契约",
      "summary": "错误地把 matchedFiles 为空解释为未扫描文件。",
      "fix": "用 fileCount、logDirExists 和错误码判断文件状态，同步修正文档与脚本提示。",
      "confidence": "确认"
    },
    {
      "id": "D-03",
      "skill": "query-app-logs,java-server-diagnostics",
      "location": "skills/lexin/query-app-logs/SKILL.md:50; skills/lexin/java-server-diagnostics/scripts/container_log_check.js:135",
      "severity": "High",
      "category": "接口一致性",
      "summary": "容器快检承诺检查 error.log，kubectl 分支却只读取 stdout。",
      "fix": "文件快检使用文件读取路径，stdout 查询明确标注来源与限制。",
      "confidence": "确认"
    },
    {
      "id": "D-04",
      "skill": "inspect-app-call-topology",
      "location": "skills/lexin/inspect-app-call-topology/scripts/inspect_call_topology.js:1091",
      "severity": "High",
      "category": "目标歧义",
      "summary": "服务对应多个提供方时自动选择首个应用。",
      "fix": "列出候选，要求使用 --app 明确目标。",
      "confidence": "确认"
    },
    {
      "id": "D-05",
      "skill": "query-dubbo-registry",
      "location": "skills/lexin/query-dubbo-registry/scripts/query_dubbo_registry.js:194; skills/lexin/query-dubbo-registry/scripts/query_dubbo_registry.js:291",
      "severity": "High",
      "category": "结果完整性",
      "summary": "只查询第一页且丢弃总数，服务清单和提供方候选静默截断。",
      "fix": "按总数翻页，或输出明确截断标志并限制完整性结论。",
      "confidence": "确认"
    },
    {
      "id": "D-06",
      "skill": "query-hawk-field-reference",
      "location": "skills/lexin/query-hawk-field-reference/scripts/hawk_field_ref.py:205",
      "severity": "High",
      "category": "失败语义",
      "summary": "错误 JSON 可被转换成正常的空引用列表。",
      "fix": "先校验接口成功状态和响应结构，失败时非零退出。",
      "confidence": "确认"
    },
    {
      "id": "D-07",
      "skill": "test-dubbo-api",
      "location": "skills/lexin/test-dubbo-api/SKILL.md:80",
      "severity": "High",
      "category": "凭据边界",
      "summary": "手动复制 Cookie 并保存在会话上下文的指令与禁止索要凭据冲突。",
      "fix": "删除该兜底，统一通过浏览器重新登录。",
      "confidence": "确认"
    },
    {
      "id": "D-08",
      "skill": "diagnose-healthy-alert",
      "location": "skills/lexin/diagnose-healthy-alert/SKILL.md:152",
      "severity": "High",
      "category": "诊断正确性",
      "summary": "错误地声称当前存在性和 TTL 足以区分从未写入与已经过期。",
      "fix": "仅判断当前状态，历史原因需要写入日志或其他历史证据。",
      "confidence": "确认"
    },
    {
      "id": "D-09",
      "skill": "inspect-healthy-jvm-dashboard",
      "location": "skills/lexin/inspect-healthy-jvm-dashboard/SKILL.md:21; skills/lexin/inspect-healthy-jvm-dashboard/scripts/inspect_dashboard.js:58",
      "severity": "Medium",
      "category": "引用有效性",
      "summary": "仍消费旧固定备份路径，与当前 backupDir 输出不兼容。",
      "fix": "读取返回目录中的 before.json 或直接消费 configs，同步更新示例。",
      "confidence": "确认"
    },
    {
      "id": "D-10",
      "skill": "diagnose-healthy-alert,inspect-healthy-jvm-dashboard,register-healthy-metrics",
      "location": "skills/lexin/diagnose-healthy-alert/scripts/diagnose_alert.js:190; skills/lexin/inspect-healthy-jvm-dashboard/scripts/inspect_dashboard.js:174; skills/lexin/register-healthy-metrics/scripts/register_metrics.js:272",
      "severity": "Medium",
      "category": "认证契约",
      "summary": "模糊匹配 token 可能将 refresh_token 用作访问令牌。",
      "fix": "精确读取 localStorage.access_token。",
      "confidence": "确认"
    },
    {
      "id": "D-11",
      "skill": "inspect-healthy-metrics",
      "location": "skills/lexin/inspect-healthy-metrics/scripts/inspect_metrics.js:308",
      "severity": "Medium",
      "category": "查询边界",
      "summary": "注册表无记录时跳过样本查询，无法判断未注册指标是否实际上报。",
      "fix": "注册状态与样本状态独立查询，未查询值不输出为确定的零。",
      "confidence": "确认"
    },
    {
      "id": "D-12",
      "skill": "register-healthy-metrics",
      "location": "skills/lexin/register-healthy-metrics/SKILL.md:33; skills/lexin/register-healthy-metrics/scripts/register_metrics.js:189",
      "severity": "Medium",
      "category": "输入契约",
      "summary": "显式给出完整注册字段仍因非内置后缀被拒绝。",
      "fix": "完整显式字段跳过推导，需推导时明确限制与补参方式。",
      "confidence": "确认"
    },
    {
      "id": "D-13",
      "skill": "query-app-logs",
      "location": "skills/lexin/query-app-logs/SKILL.md:53; skills/lexin/query-app-logs/SKILL.md:69",
      "severity": "Medium",
      "category": "跨 skill 衔接",
      "summary": "容器示例遗漏 profile，可能落到未登录的 webshell 默认 profile。",
      "fix": "显式传递已经验证的 profile，并保持下游透传。",
      "confidence": "确认"
    },
    {
      "id": "D-14",
      "skill": "query-app-instances",
      "location": "skills/lexin/query-app-instances/SKILL.md:47",
      "severity": "Medium",
      "category": "路径时效性",
      "summary": "示例 cwd 使用已经不存在的迁移前路径。",
      "fix": "改为 /home/joney/projects/backend/hawk/server_hawk_decision_executor。",
      "confidence": "确认"
    },
    {
      "id": "D-15",
      "skill": "healthy-dashboard-config",
      "location": "skills/lexin/healthy-dashboard-config/SKILL.md:3; skills/lexin/healthy-dashboard-config/scripts/healthy_dashboard_config.js:242",
      "severity": "Medium",
      "category": "触发与能力边界",
      "summary": "宣称支持新建大盘，实际入口要求已有 board ID。",
      "fix": "收窄为已有大盘配置，明确创建入口尚未提供。",
      "confidence": "确认"
    },
    {
      "id": "D-16",
      "skill": "test-dubbo-api",
      "location": "skills/lexin/test-dubbo-api/SKILL.md:187; skills/lexin/test-dubbo-api/scripts/dubbo_scenario.py:200",
      "severity": "Medium",
      "category": "预览契约",
      "summary": "dry-run 无法解析依赖前序响应提取值的后续步骤。",
      "fix": "说明通过 --var 提供预览值，缺值时明确预览限制。",
      "confidence": "确认"
    },
    {
      "id": "D-17",
      "skill": "diagnose-healthy-alert",
      "location": "skills/lexin/diagnose-healthy-alert/scripts/diagnose_alert.js:102; skills/lexin/diagnose-healthy-alert/scripts/diagnose_alert.js:680",
      "severity": "Medium",
      "category": "环境衔接",
      "summary": "完整 stable 告警 URL 的站点被忽略，省略 env 时查询生产站点。",
      "fix": "从受支持 URL 推导站点并校验显式 env 冲突，或明确要求透传链接环境。",
      "confidence": "确认"
    }
  ]
}
```
