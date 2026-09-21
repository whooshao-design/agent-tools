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

## HTTP 查询

共用接口、认证、响应判定和脚本见 `/home/joney/projects/ai/agent-tools/skills/lexin/query-clickhouse-water/references/lxcloud-http.md`。使用 `--env stable`，默认实例为 `ABTestCK`，不需要改写请求或复制登录流程：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/query-clickhouse-water/scripts/clickhouse_http.js \
  --env stable --action tables --database risk_control_base_db
```

## 查询约束与响应

- 只发送本 skill 允许的只读 SQL；stable 接口的明细 `SELECT` 需要带 `WHERE`，同时主动加上绝对时间范围和合理的 `LIMIT`。
- 显式写 `database.table`。表或库不确定时，先调用 `showdatabases`、`showtables`，不要猜名称。
- 查看字段使用 `SHOW CREATE TABLE <database.table>`；查询失败按共用 HTTP 契约处理，不能把空 `data` 误判为无流水。
- 最终仍需输出实际执行的 SQL 和整理后的结果；不得输出 Cookie、ticket、token 或完整认证请求头。

## 手工查看

1. 打开固定页面并完成 OA 登录。
2. 在 ClickHouse 实例中选择 `ABTestCK`。
3. 数据库选择 `risk_control_base_db`，再选择不带 `test` 的节点或规则线上执行流水表。
4. 输入带绝对时间范围、业务 ID 和 `LIMIT` 的只读 SQL，点击“查询”。
5. 在“执行结果”查看列、数据和执行时间；接口错误显示在同一区域。
