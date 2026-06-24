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

## 使用原则

- 用户给出明确表名时，以用户表名为准。
- 用户只说“线上流水”“决策流水”“规则流水”时，先从上表选候选表，再用 `DESCRIBE` 验证。
- 这些表名不代表固定业务口径。过滤条件、时间字段、通过/拒绝含义、去重键和聚合方式都要来自用户问题或本次探查。
