# stable/测试环境线上执行流水 HTTP 查询

## 固定入口

- 页面：`https://stable-lxcloud.oa.fenqile.com/#/details_clickhouse/query_clickhouse`
- ClickHouse 实例：`ABTestCK`
- Hawk 数据库：`risk_control_base_db`
- 节点线上执行流水表：`risk_control_base_db.t_strategy_node_decision_water`
- 规则线上执行流水表：`risk_control_base_db.t_rule_decision_water`

这里的“stable/测试”表示部署环境，当前查询目标是该环境中的线上执行流水。不要使用 `t_strategy_node_decision_test_water` 或 `t_rule_decision_test_water`；带 `test` 的表属于测试执行流水，不在当前范围内。

页面需要 OA 登录态。优先使用 `browser_session` MCP 检查和复用 session；MCP 不可用时，用底层脚本检查：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --status \
  --url=https://stable-lxcloud.oa.fenqile.com/#/details_clickhouse/query_clickhouse \
  --success-text=none
```

只有 `sessionReady: true` 才继续。登录失效时使用同一 URL 和 profile 执行 `ensure_session`，让用户在浏览器窗口完成登录；不要在对话中索取密码、OTP、Cookie 或 token。

## HTTP 接口

页面 Hash URL 只是前端入口，实际查询使用同域接口，并在同一个浏览器 BrowserContext/profile 中发起请求以复用 session：

| 用途 | 方法与路径 | 请求体/查询参数 |
|---|---|---|
| 列实例 | `GET /v1/clickhouse/instance_list/` | `page=1&size=2000&user_name=<当前登录用户>` |
| 列数据库 | `POST /v1/clickhouse/sql_exec/showdatabases` | `{"clickhouse_type":"ABTestCK"}` |
| 列表 | `POST /v1/clickhouse/sql_exec/showtables` | `{"clickhouse_type":"ABTestCK","db_name":"risk_control_base_db"}` |
| 执行查询 | `POST /v1/clickhouse/sql_exec/exec_query` | `{"clickhouse_type":"ABTestCK","user_name":"<当前登录用户>","sql":"<只读 SQL>"}` |

`user_name` 从已登录页面的 `localStorage.userInfo[0].min` 获取；不要硬编码用户名，也不要把完整 localStorage 或 session 凭据输出到终端或最终回复。不要用未携带浏览器 session 的普通 `curl` 直接调用接口。

## 查询约束与响应

- 只发送本 skill 允许的只读 SQL；stable 接口的明细 `SELECT` 需要带 `WHERE`，同时主动加上绝对时间范围和合理的 `LIMIT`。
- 显式写 `database.table`。表或库不确定时，先调用 `showdatabases`、`showtables`，不要猜名称。
- HTTP 200 只代表请求到达。查询成功还要求外层 `code = 200`、`data.code = 200` 且 `data.query_code = 0`。
- 成功结果位于 `data.data.columns` 和 `data.data.data`；`data.query_time` 是执行耗时。
- `data.query_code = 1` 或内层 `code != 200` 时，保留并报告接口返回的 `error`，不要把空 `data` 误判为无流水。
- 最终仍需输出实际执行的 SQL 和整理后的结果；不得输出 Cookie、ticket、token 或完整认证请求头。

## 手工查看

1. 打开固定页面并完成 OA 登录。
2. 在 ClickHouse 实例中选择 `ABTestCK`。
3. 数据库选择 `risk_control_base_db`，再选择不带 `test` 的节点或规则线上执行流水表。
4. 输入带绝对时间范围、业务 ID 和 `LIMIT` 的只读 SQL，点击“查询”。
5. 在“执行结果”查看列、数据和执行时间；接口错误显示在同一区域。
