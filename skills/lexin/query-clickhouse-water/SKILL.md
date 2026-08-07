---
name: query-clickhouse-water
description: 通过预发布/灰度/线上共用的 DBA 堡垒机或 stable/测试乐信云 HTTP 接口只读查询 ClickHouse 流水并整理结果。Use when 用户要求查询 ClickHouse 流水、预发布/灰度/线上/stable/测试流水、决策流水、规则流水、trace cost 流水，验证流水口径，或优化已有 ClickHouse 查询 SQL；最终必须同时输出执行 SQL 和查询结果。
metadata:
  version: 1.2.0
---

# query-clickhouse-water

## 定位

通过 ClickHouse 查询业务流水、核对查询口径、对已有 ClickHouse SQL 做轻量优化。它不固化某一次分析里的业务口径，不默认加入特定乐包、节点、环境、来源、去重键或同比窗口；这些条件必须来自用户问题、已有上下文或本次查询前的明确确认。

按环境选择入口：预发布、灰度、线上共用 `bastion_dba` MCP 路径，手工 `clickhouse-client` 只作为兜底；stable/测试通过乐信云 ClickHouse HTTP 接口查询，并复用 `get-browser-session` 的登录态。不要用 stable 页面代替预发布、灰度或线上入口，也不要把页面 Hash URL 当成查询 API。

## 环境路由

- 预发布/灰度/线上：`pre`、预发布、`gray`、灰度、`prod`、`online`、线上、生产统一走同一个 `bastion_dba` MCP，不划分 `pre`、`gray`、`online` profile。环境差异只能来自本次确认的库、表和业务过滤条件，不能因为登录路径相同就混用查询口径。
- stable/测试：打开 `https://stable-lxcloud.oa.fenqile.com/#/details_clickhouse/query_clickhouse`，实例选择 `ABTestCK`；自动查询时复用浏览器 session 调用页面对应的 HTTP 接口。stable/测试是部署环境，不代表测试执行；当前只查询该环境中的线上执行流水，使用不带 `test` 的表。完整接口、请求字段和响应判定见 `/home/joney/projects/ai/agent-tools/skills/lexin/query-clickhouse-water/references/stable-http.md`。
- 用户未说明环境且无法从上下文可靠判断时，先确认是预发布/灰度/线上还是 stable/测试，不能静默选择数据源。

## DBA 堡垒机步骤

预发布、灰度、线上统一按以下顺序执行：

1. 调用 `mcp__bastion_dba__connection_status`；已连接时复用当前连接。
2. 未连接时调用 `mcp__bastion_dba__connect_bastion()`，不要传 `profile`，也不要改用通用 `bastion(profile="online")`。`bastion_dba` 是独立 DBA 通道，本身没有预发布、灰度、线上 profile。
3. PEM 认证可用时不传密码或 OTP。只有连接结果明确要求认证信息时才向用户索取最小必要信息；不要重复重试同一失败连接，也不要把凭据写入文件或最终回复。
4. 连接成功后调用 `mcp__bastion_dba__clickhouse_query` 执行只读 SQL。MCP 不可用时，再按用户提供的堡垒机/ClickHouse 连接信息通过只读账号使用 `clickhouse-client`。

## 核心约束

- 只执行只读 SQL：`SELECT`、`WITH`、`SHOW`、`DESCRIBE`、`DESC`、`EXPLAIN`。不要执行 DDL、DML、权限、配置或管理类 SQL。
- 最终回复必须包含本次执行的 SQL 和查询结果；如果对用户 SQL 做了改写，要说明保留和调整的口径。
- 不在 skill 或回复中写入密码、私钥、token、完整连接串等敏感信息。连接配置应来自本机 MCP 配置或用户当次提供的信息。
- 使用绝对时间范围，不只写“今天/昨天/最近一小时”。用户使用相对日期时，按当前会话日期换算后写入 SQL 或在回复中说明。
- 不擅自添加业务过滤条件，例如某个 `Fnode_id`、`Fenv`、`Forigin`、`Fpackage_id`、去重键或通过口径。除非用户明确给出，或查询目标已经在上下文中确认。
- 不把“stable/测试环境”推断为“测试执行流水”。当前 stable/测试查询固定使用 `t_strategy_node_decision_water` 或 `t_rule_decision_water`；只有用户以后明确要求测试执行流水时，才另行确认是否使用带 `test` 的表。
- 大表查询先收窄时间窗口和必要字段。不要为最终不使用的字段做 JSON 解析或复杂表达式计算。

## 查询流程

1. 确认查询环境和目标：表名、时间范围、业务 ID、统计指标、是否需要去重或对比窗口。缺少关键信息且无法从上下文可靠推断时再问用户。
2. 按“环境路由”选择入口：预发布/灰度/线上执行“DBA 堡垒机步骤”；stable/测试必须使用 `ABTestCK`，并先确认浏览器登录态可用。
3. 如果表或字段不确定，预发布/灰度/线上先执行 `DESCRIBE <database.table>` 或小范围 `SELECT ... LIMIT`；stable/测试先通过 HTTP 接口列出数据库和表，再用带 `WHERE` 与 `LIMIT` 的小范围查询探查。
4. 编写只读 SQL，优先显式写库名和表名，时间条件用闭开区间：`>= start AND < end`。
5. 执行 SQL。结果为空或明显异常时，先查时间窗口、最大时间、基础行数，再调整 SQL。
6. 回复用户时先给结论，再给 SQL，再给结果。结果较多时只展示关键行，并说明是否截断。

## 表清单

Hawk 当前常见流水表见 `/home/joney/projects/ai/agent-tools/skills/lexin/query-clickhouse-water/references/water-tables.md`。当用户只说“查流水”“查决策流水”“查规则流水”但未给表名时，读取该 reference 选择候选表，并用 `DESCRIBE` 校验字段。

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
