---
name: query-clickhouse-water
description: 只读查询 ClickHouse 流水；DecisionWaterHawkCK 默认走 bastion_dba，其他 CK 实例默认走乐信云 HTTP，支持用户显式指定通道。Use when 用户要求查询预发布/灰度/线上/stable/测试 ClickHouse 流水、决策/规则/trace cost 流水，验证流水口径或优化查询 SQL；输出执行 SQL 和查询结果。
metadata:
  version: 1.3.0
---

# query-clickhouse-water

## 定位

通过 ClickHouse 查询业务流水、核对查询口径、对已有 ClickHouse SQL 做轻量优化。它不固化某一次分析里的业务口径，不默认加入特定乐包、节点、环境、来源、去重键或同比窗口；这些条件必须来自用户问题、已有上下文或本次查询前的明确确认。

先确认实例，再选通道和环境域名。`DecisionWaterHawkCK` 默认走 `bastion_dba`，其他 CK 实例默认走乐信云 HTTP；用户显式指定通道时覆盖默认值。通道失败时报告原因，不自动切换。登录态复用 `get-browser-session`，MCP 优先、脚本兜底；ClickHouse HTTP 查询使用本技能脚本。

## 通道与环境路由

| 条件 | 通道 |
|---|---|
| 用户显式指定 HTTP 或 `bastion_dba` | 使用指定通道；仍需确认该通道实际连接的目标实例 |
| 未指定通道，实例为 `DecisionWaterHawkCK` | `bastion_dba` |
| 未指定通道，其他 CK 实例 | 乐信云 HTTP |

- 预发布/灰度/线上：HTTP 页面统一为 `https://lxcloud.lexincloud.com/#/details_clickhouse/query_clickhouse`；不能用 stable 域名替代。`pre`、`gray`、`prod`/`online` 仅选择入口，不自动添加 `Fenv` 等过滤条件；同一入口不代表业务口径相同。
- stable/测试：HTTP 页面为 `https://stable-lxcloud.oa.fenqile.com/#/details_clickhouse/query_clickhouse`，实例使用 `ABTestCK`。stable/测试是部署环境，不代表测试执行；当前查询不带 `test` 的线上执行流水表。见 `/home/joney/projects/ai/agent-tools/skills/lexin/query-clickhouse-water/references/stable-http.md`。
- 实例不明确时先列实例、核对数据库和表；不要把所有 Hawk 表都直接映射为同一实例，也不要采用页面缓存选中的实例。
- 用户未说明环境且无法从上下文可靠判断时，先确认是预发布/灰度/线上还是 stable/测试，不能静默选择数据源。

## 乐信云 HTTP 步骤

接口、命令和限制见 `/home/joney/projects/ai/agent-tools/skills/lexin/query-clickhouse-water/references/lxcloud-http.md`。

1. 使用 `/home/joney/projects/ai/agent-tools/skills/lexin/query-clickhouse-water/scripts/clickhouse_http.js`，显式传 `--env` 和已确认的 `--instance`；实例不明时先 `--action instances`，再用 `databases`/`tables` 探查。
2. 脚本在同一 BrowserContext 内复用登录态、读取当前用户并查询，不导出凭据。需要登录时交给 `get-browser-session`，不重复启动浏览器或自行索取凭据。
3. HTTP 目前接受单条 `SELECT`/`SHOW`，表结构用 `SHOW CREATE TABLE <database.table>`；不要发 `DESCRIBE`，也不要假设有 `system` 库权限。复杂 SQL 无法等价改写时报告接口限制，不自动改走堡垒机。
4. 同时校验 HTTP 状态、外层 `code`、内层 `code` 和 `query_code`。错误与成功的空结果分别报告。

## DBA 堡垒机步骤

仅在实例默认规则或用户显式指定选中此通道后执行。预发布、灰度、线上共用该通道，不划分环境 profile；它没有 `clickhouse_type` 参数，其他实例不能只改实例名就认为已切换连接。

1. 调用 `mcp__bastion_dba__connection_status`；已连接时复用当前连接。
2. 未连接时调用 `mcp__bastion_dba__connect_bastion()`，不要传 `profile`，也不要改用通用 `bastion(profile="online")`。`bastion_dba` 是独立 DBA 通道，本身没有预发布、灰度、线上 profile。
3. PEM 认证可用时不传密码或 OTP。只有连接结果明确要求认证时才处理缺失认证；不要重复重试同一失败连接，也不要把凭据写入文件或最终回复。
4. 连接成功后调用 `mcp__bastion_dba__clickhouse_query` 执行只读 SQL。MCP 不可用时，再按用户提供的堡垒机/ClickHouse 连接信息通过只读账号使用 `clickhouse-client`。

## 核心约束

- 只执行只读 SQL。DBA 通道支持 `SELECT`、`WITH`、`SHOW`、`DESCRIBE`、`DESC`、`EXPLAIN`；HTTP 使用 `SELECT`/`SHOW`。不要执行写入、权限、配置或管理类 SQL。
- 最终回复必须包含本次执行的 SQL 和查询结果；如果对用户 SQL 做了改写，要说明保留和调整的口径。
- 不在 skill 或回复中写入密码、私钥、token、完整连接串等敏感信息。连接配置应来自本机 MCP 配置或用户当次提供的信息。
- 使用绝对时间范围，不只写“今天/昨天/最近一小时”。用户使用相对日期时，按当前会话日期换算后写入 SQL 或在回复中说明。
- 不擅自添加业务过滤条件，例如某个 `Fnode_id`、`Fenv`、`Forigin`、`Fpackage_id`、去重键或通过口径。除非用户明确给出，或查询目标已经在上下文中确认。
- 不把“stable/测试环境”推断为“测试执行流水”。当前 stable/测试查询固定使用 `t_strategy_node_decision_water` 或 `t_rule_decision_water`；只有用户以后明确要求测试执行流水时，才另行确认是否使用带 `test` 的表。
- 大表查询先收窄时间窗口和必要字段。不要为最终不使用的字段做 JSON 解析或复杂表达式计算。

## 查询流程

1. 确认查询环境、实例和目标：表名、时间范围、业务 ID、统计指标、是否需要去重或对比窗口。缺少关键信息且无法从上下文可靠推断时再问用户。
2. 按“通道与环境路由”选择通道；用户指定优先，否则 `DecisionWaterHawkCK` 走 DBA，其他实例走 HTTP。
3. 如果表或字段不确定，HTTP 先列数据库和表、用 `SHOW CREATE TABLE` 查结构；DBA 可用 `DESCRIBE`。明细探查带绝对时间范围与 `LIMIT`。
4. 编写只读 SQL，优先显式写库名和表名，时间条件用闭开区间：`>= start AND < end`。
5. 执行 SQL。结果为空或明显异常时，先查时间窗口、最大时间、基础行数，再调整 SQL。
6. 回复用户时先给结论，再给 SQL，再给结果。结果较多时只展示关键行，并说明是否截断。

## 表清单

Hawk 当前常见流水表见 `/home/joney/projects/ai/agent-tools/skills/lexin/query-clickhouse-water/references/water-tables.md`。当用户未给表名时，读取该 reference 选择候选表，并按通道校验结构。

## SQL 优化准则

- 只保留最终输出或聚合真正需要的字段，删除无用 JSON 提取、无用子查询列和无用排序。
- 大范围多窗口统计时，优先把不同时间窗口拆成独立子查询先聚合，再按业务键 `JOIN`；这通常比在全量明细上使用大量 `OR + multiIf` 更容易读，也更利于时间条件裁剪。
- 需要按小时、半小时、天统计时，用 `toStartOfHour`、`toStartOfInterval` 或 `toDate` 明确落桶。
- 需要去重时，不要自行决定去重键和冲突取值规则。先从用户口径确认；确认后再用 `GROUP BY <业务键>, <时间桶>`，并按语义选择 `max`、`min`、`argMax`、`any` 等聚合。
- 对比两个 SQL 结果差异时，每次只改变一个变量：时间字段、时间窗口、表、过滤条件、是否去重、聚合函数、补偿窗口等。

## 输出格式

简短查询按这个顺序回复：

1. `结论`：一句话概括。
2. `SQL`：用 `sql` 代码块贴出实际执行 SQL。
3. `结果`：表格或关键行。

SQL 优化或差异排查按这个顺序回复：

1. `调整点`：列出 1-3 个关键改动。
2. `验证`：说明执行过的校验 SQL 或对比结果。
3. `SQL`：用 `sql` 代码块贴出实际执行 SQL。
4. `结果`：关键结果或差异摘要。
