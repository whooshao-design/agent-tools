---
name: query-clickhouse-water
description: 通过 DB 堡垒机只读查询 ClickHouse 流水并整理结果。Use when 用户要求查询 ClickHouse 流水、线上/测试流水、决策流水、规则流水、trace cost 流水，验证流水口径，或优化已有 ClickHouse 查询 SQL；最终必须同时输出执行 SQL 和查询结果。
metadata:
  version: 1.0.1
---

# query-clickhouse-water

## 定位

通过 ClickHouse 查询业务流水、核对查询口径、对已有 ClickHouse SQL 做轻量优化。它不固化某一次分析里的业务口径，不默认加入特定乐包、节点、环境、来源、去重键或同比窗口；这些条件必须来自用户问题、已有上下文或本次查询前的明确确认。

MCP 优先、手工 `clickhouse-client` 兜底。已注册 `bastion_dba` MCP 时，优先使用 `mcp__bastion_dba.clickhouse_query`；MCP 不可用时，再按用户提供的堡垒机/ClickHouse 连接信息通过只读账号执行。

## 核心约束

- 只执行只读 SQL：`SELECT`、`WITH`、`SHOW`、`DESCRIBE`、`DESC`、`EXPLAIN`。不要执行 DDL、DML、权限、配置或管理类 SQL。
- 最终回复必须包含本次执行的 SQL 和查询结果；如果对用户 SQL 做了改写，要说明保留和调整的口径。
- 不在 skill 或回复中写入密码、私钥、token、完整连接串等敏感信息。连接配置应来自本机 MCP 配置或用户当次提供的信息。
- 使用绝对时间范围，不只写“今天/昨天/最近一小时”。用户使用相对日期时，按当前会话日期换算后写入 SQL 或在回复中说明。
- 不擅自添加业务过滤条件，例如某个 `Fnode_id`、`Fenv`、`Forigin`、`Fpackage_id`、去重键或通过口径。除非用户明确给出，或查询目标已经在上下文中确认。
- 大表查询先收窄时间窗口和必要字段。不要为最终不使用的字段做 JSON 解析或复杂表达式计算。

## 查询流程

1. 确认查询目标：表名、时间范围、业务 ID、统计指标、是否需要去重或对比窗口。缺少关键信息且无法从上下文可靠推断时再问用户。
2. 如果表或字段不确定，先执行 `DESCRIBE <database.table>` 或小范围 `SELECT ... LIMIT` 探查结构。
3. 编写只读 SQL，优先显式写库名和表名，时间条件用闭开区间：`>= start AND < end`。
4. 执行 SQL。结果为空或明显异常时，先查时间窗口、最大时间、基础行数，再调整 SQL。
5. 回复用户时先给结论，再给 SQL，再给结果。结果较多时只展示关键行，并说明是否截断。

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
