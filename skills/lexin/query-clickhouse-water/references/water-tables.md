# ClickHouse 流水表

## Hawk 常见表

这些表是查询 Hawk 相关流水时的候选表。使用前先 `DESCRIBE` 确认字段，不要只根据表名假设字段或业务口径。

| 表名 | 用途提示 |
|---|---|
| `risk_control_base_db.t_strategy_node_decision_water` | 节点决策流水 |
| `risk_control_base_db.t_strategy_node_decision_test_water` | 节点决策测试流水 |
| `risk_control_base_db.t_rule_decision_water` | 规则决策流水 |
| `risk_control_base_db.t_rule_decision_test_water` | 规则决策测试流水 |
| `risk_control_base_db.t_decision_trace_cost_serial` | 决策 trace/cost 串行流水 |

## stable/测试环境线上执行流水

stable/测试表示部署环境，不等于测试执行。当前只查询该环境中的线上执行流水，通过乐信云 ClickHouse 页面或其同域 HTTP 接口查看，实例使用 `ABTestCK`，数据库使用 `risk_control_base_db`：

- 节点线上执行流水：`risk_control_base_db.t_strategy_node_decision_water`
- 规则线上执行流水：`risk_control_base_db.t_rule_decision_water`

不要因为环境名称含“测试”就选择带 `test` 的表。`t_strategy_node_decision_test_water` 和 `t_rule_decision_test_water` 属于测试执行流水，当前不查。

接口调用和响应判定见 `/home/joney/projects/ai/agent-tools/skills/lexin/query-clickhouse-water/references/stable-http.md`。

## 使用原则

- 用户给出明确表名时，以用户表名为准。
- 用户只说 stable/测试环境流水时，当前默认指该环境的线上执行流水，选择不带 `test` 的表。
- 用户只说“线上流水”“决策流水”“规则流水”时，先从上表选候选表，再用 `DESCRIBE` 验证。
- 这些表名不代表固定业务口径。过滤条件、时间字段、通过/拒绝含义、去重键和聚合方式都要来自用户问题或本次探查。
