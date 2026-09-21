---
name: query-hive-data
description: 通过乐信大数据门户「即席分析」（data.oa.fenqile.com）以 Presto/Spark 引擎只读查询 Hive 数仓表并整理结果。Use when 用户要求查 Hive 表、数仓表、dp_ods/dp_snap/rt_ods/lx_dwd/rt_mart 等库的数据、米霍克离线流水或规则元数据、SHOW SCHEMAS/SHOW TABLES/DESCRIBE 表结构，或让即席分析跑一条 SQL；最终必须同时输出执行 SQL 和查询结果。
metadata:
  version: 1.0.1
---

# query-hive-data

## 定位

通过乐信大数据门户的即席分析接口只读查询 Hive 数仓表（Presto 引擎为主，Spark 兜底），核对查询口径，整理结果。
它不管理页面上的文件夹、参数、运行历史或下载，不执行 DDL/DML，也不固化某一次分析的业务口径：
乐包、节点、版本、时间窗口、去重键等条件必须来自用户问题、已有上下文或本次查询前的确认。

相邻 skill 的边界：MySQL 走 `query-mysql-data`，ClickHouse 流水走 `query-clickhouse-water`，浏览器登录态由 `get-browser-session` 负责。
本 skill 没有对应 MCP 工具，脚本是唯一入口：

```text
/home/joney/projects/ai/agent-tools/skills/lexin/query-hive-data/scripts/hive_query.js
```

## 前置条件

脚本在 `get-browser-session` 的 `main` profile（`~/.local/state/agent-tools/browser-profiles/main`）内发请求，需要该 profile 已登录 OA。
脚本报 `browser session is not ready ... (LOGIN_REQUIRED|PROXY_INTERCEPTED|FORBIDDEN|UPSTREAM_ERROR)` 时，按 `get-browser-session` 的“登录态排查顺序”处理；
确认需要重新登录再执行（MCP 优先用 `browser_session.ensure_session`，脚本兜底）：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --ensure \
  --url=https://data.oa.fenqile.com/microapps/data/portal/improvisationAnalysis \
  --success-text=none
```

不要在聊天中索取密码、OTP、Cookie 或 token。同一 profile 同时只能被一个 Chromium 使用；脚本会等待跨进程锁最多 60 秒，
仍提示 `profile is busy` 或 `ProcessSingleton` 时，先结束占用该 profile 的浏览器进程，不要循环重试。

## 核心约束

- 只执行只读 SQL：`SELECT`、`WITH`、`SHOW`、`DESCRIBE`、`DESC`、`EXPLAIN`，且一次一条语句。脚本按首关键字拦截，
  `SELECT/WITH` 语句中出现 `INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE/MERGE/GRANT/REVOKE` 也会被拒绝（字符串里的 `--`/`/*` 不算注释，藏在"注释"后的写语句同样会被识别）；`EXPLAIN ANALYZE` 会真正执行语句，只读入口拒绝它，只允许普通 `EXPLAIN`。
  页面本身允许写操作，不要绕过脚本改用页面或接口执行写 SQL。
- 最终回复必须包含本次实际执行的 SQL 和查询结果；对用户 SQL 做过改写时说明保留和调整的口径。
- 流水表必须带分区条件（多数表是 `f_p_date`，`rt_mart.t_process_decision_log` 是 `fdate`），再叠加业务键；
  时间范围写绝对日期，闭开区间 `>= start AND < end`，相对日期按当前会话日期换算后写进 SQL 或在回复中说明。
- 不擅自添加业务过滤条件（`fpackage_id`、`fnode_id`、`forigin`、去重键等），除非用户明确给出或上下文已确认。
- 未写 `LIMIT` 时服务端自动追加 `LIMIT 1000`，接口最多返回 1000 行；需要更多数据先收窄条件或聚合，不要试图翻页。
- `LIMIT` 超过 1000 或 Presto 内存不足时改用 `--engine spark`；不要默认用 Spark。
- 每次查询都会在页面“全部运行历史”留下记录，并写入用户临时目录下的 `agent-tools-adhoc` 文件（脚本复用同一文件，不新建）。
  不要修改、移动或删除该目录下用户自己的文件。
- 不在回复、日志或仓库中写入 Cookie、token、`interface_info` 里的 IP 等敏感字段；脚本输出已只保留业务字段。

## 查询流程

1. 确认目标：库表、时间范围、业务 ID、统计指标、是否去重或对比。表不确定时读
   `/home/joney/projects/ai/agent-tools/skills/lexin/query-hive-data/references/hive-tables.md` 选候选表，
   再用 `SHOW TABLES IN <db> LIKE '<前缀>%'`（Presto，全量列表会撞 1000 行上限）和 `DESCRIBE <db>.<table>` 校验。
   列库只能 `SHOW DATABASES --engine spark`：Presto 不认 `SHOW DATABASES`，`SHOW SCHEMAS` 会被门户预检拒绝，`information_schema` 无权限。
2. 编写只读 SQL：显式写 `db.table`，先带分区和 `LIMIT` 做小范围探查，再跑正式查询。
3. 执行脚本（复杂 SQL 用 `--query-file` 避免 shell 转义问题）：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/query-hive-data/scripts/hive_query.js \
  --query "SELECT count(*) FROM dp_ods.hawkeye_decision_engine_record_db_t_rule_decision WHERE f_p_date = '2026-09-15'"

node /home/joney/projects/ai/agent-tools/skills/lexin/query-hive-data/scripts/hive_query.js \
  --query-file /tmp/xxx.sql --engine spark --timeout 1200 --max-rows 50 --output /tmp/xxx-result.json
```

4. 读输出 JSON：`status` 为 `SUCCESS` 时看 `columns`、`rows`（默认最多 200 行，`truncated` 标记是否截断，`rowCount` 为接口返回总行数，
   `--output` 可把完整结果落到本地文件）；`FAILED` 时 `message` 与 `logs` 是引擎报错，先修 SQL 再重跑，不要换表碰运气；
   `TIMEOUT` 时任务仍在执行，按 `hint` 用 `--instance <sqlInstanceId>` 继续等待，不要重复提交同一 SQL。
5. 结果为空或异常时，先查分区范围（`min/max(f_p_date)`）、基础行数，再调整 SQL。
6. 回复用户：先结论，再 SQL，再结果。结果较多时只展示关键行并说明截断。

## 脚本参数

- `--query <sql>` / `--query-file <path>`：二选一；`--instance <id>`：只等待已提交实例的结果。
- `--engine presto|spark`：默认 `presto`。
- `--timeout <秒>`：等待上限，默认 600（5–3600）；`--poll <秒>`：轮询间隔，默认 2。
- `--max-rows <n>`：stdout 展示行数，默认 200；`--output <file>`：完整 `columns/rows` 写入 JSON 文件。
- `--user-name <min>` 或环境变量 `DATA_PORTAL_USER_NAME`：覆盖从门户 session 解析的 OA 账号（正常不需要）。
- `--folder-id <id>`：用户临时目录不叫 `用户临时目录` 时指定文件夹 ID。
- `--profile` / `--tool-dir` / `--chrome`：与 `get-browser-session` 相同的浏览器覆盖项。

接口细节、状态码和页面约束见
`/home/joney/projects/ai/agent-tools/skills/lexin/query-hive-data/references/portal-http.md`。

## 输出格式

1. `结论`：一句话概括。
2. `SQL`：用 `sql` 代码块贴出实际执行 SQL（含引擎，非 Presto 时注明）。
3. `结果`：表格或关键行，说明是否截断、总行数是否受 1000 行上限影响。
