# 常用 Hive 表清单

从当前用户在即席分析中已保存的 SQL 提取（2026-09-16），只记录表名、分区列和 SQL 中出现过的关键字段；
完整字段以 `DESCRIBE <db>.<table>` 为准。用户只说“查流水”“查规则”而未给表名时，从这里选候选表并先 `DESCRIBE` 校验。

## 命名约定

- `dp_ods.<mysql库>_<表>`：MySQL 库表的离线 ODS 镜像（如 `hawkeye_decision_engine_db` → `dp_ods.hawkeye_decision_engine_db_t_rule`）；`dp_snap.*` 为快照表。
- `rt_ods.*`：实时接入的 ODS 表；表名中的 `yyyy` / `mmdd` 是字面量（对应源库按年、按日分表），不是需要替换的占位符。
- `lx_dwd.*`：DWD 明细/监控层；`rt_mart.*`：实时集市层。
- 分区列：`dp_ods` / `dp_snap` / `rt_ods` / `lx_dwd` 流水表用 `f_p_date`（`'YYYY-MM-DD'` 字符串），`rt_mart.t_process_decision_log` 用 `fdate`。查流水必须带分区条件，再叠加业务键。
- 数仓分层（`listWarehouseInfo`）：ODS 采集层、DWD 明细层、DWB 基础层、DWS 主体宽表与轻度汇总层、DIM 维表层、DM 集市层、ADS 应用层、MID 中间层、TMP 临时层。

## 米霍克（Hawk）决策引擎元数据

| 表 | 说明 | SQL 中出现的字段 |
|---|---|---|
| `dp_ods.hawkeye_decision_engine_db_t_rule` | 规则定义 | `frule_id`、`fedition_id`、`fnode_id`、`frule_data`（JSON，`$.protocolVersion` 为协议版本）、`fvalid_state`（0 有效）、`fmodify_time` |
| `dp_snap.hawkeye_decision_engine_db_t_edition` | 版本 | `Fedition_id`、`Fedition_type`（2 线上、3 线上灰度）、`Fvalid_state`（0 有效） |
| `dp_ods.hawkeye_decision_engine_db_t_strategy_node` | 策略节点 | — |
| `dp_ods.hawkeye_decision_engine_db_t_rule_field` | 规则字段 | — |
| `dp_snap.hawkeye_decision_engine_db_t_filed_invoke_count` | 字段调用统计 | — |

常见口径：线上有效规则 = `t_edition.Fedition_type IN (2,3) AND t_edition.Fvalid_state = 0 AND t_rule.Fvalid_state = 0`，按 `Fedition_id` 关联。

## 米霍克决策流水（离线 ODS，`f_p_date` 分区）

| 表 | 说明 | SQL 中出现的字段 |
|---|---|---|
| `dp_ods.hawkeye_decision_engine_record_db_t_strategy_node_decision` | 策略节点决策流水 | `fpackage_id`、`fnode_id`（-1 为无节点）、`fedition_id`、`forder_id`、`fapproval_result`（0 通过）、`forigin`、`fwrite_time` |
| `dp_ods.hawkeye_decision_engine_record_db_t_rule_decision` | 规则决策流水 | `fedition_id`、`frule_id` |
| `dp_ods.hawkeye_decision_engine_record_yyyy_db_t_pre_strategy_node_decision_mmdd` | 预判策略节点决策流水 | `fnode_id`、`fedition_id` |
| `dp_ods.hawk_manage_water_db_t_hawk_operate_water` | Hawk 管理端操作流水 | — |

## 米霍克实时流水（`rt_ods`，`f_p_date` 分区）

| 表 | 说明 |
|---|---|
| `rt_ods.t_rule_decision` | 规则决策流水（实时） |
| `rt_ods.t_pre_strategy_node_decision` | 预判策略节点决策流水（实时） |
| `rt_ods.t_strategy_node_with_param_decision` | 带参数的策略节点决策流水（实时） |
| `rt_ods.hawkdecisionwaterdb_hawkeye_decision_engine_record_yyyy_db_t_rule_decision_mmdd` | 规则决策流水源库分表镜像 |
| `rt_ods.hawkprewaterdb_hawkeye_decision_engine_record_yyyy_db_t_pre_strategy_node_decision_mmdd` | 预判策略节点流水源库分表镜像 |
| `rt_ods.hawkdecisionallwaterdb_hawkeye_decision_engine_record_yyyy_db_t_strategy_node_with_param_decision_mmdd` | 带参数策略节点流水源库分表镜像 |
| `rt_ods.hawktestwaterdb_hawkeye_decision_engine_test_record_yyyy_db_t_strategy_node_test_decision_mmdd` | 测试执行流水（不是线上流水） |

流水字段（对比 MD5 时用到）：`Fseq`、`fuid`、`forder_id`、`fcredit_id`、`finvoke_flow_id`、`finvoker`、`fedition_id`、`fpolicy_tag`、`fpackage_id`、`fnode_id`、`fcredit_sampling_flag`、`fapproval_result`、`fdecision_status`、`fhit`、`finput_values`（JSON，`$.uuid`）、`foutput_values`、`fvalid_state`、`fbusiness_area`。

## 风控流水对数与监控（`lx_dwd`，`f_p_date` 分区）

| 表 | 说明 | SQL 中出现的字段 |
|---|---|---|
| `lx_dwd.dwd_rsk_rule_decision_monitor` | 规则流水离线/实时对数 | `fhour`、`fsoure_cnt`、`frt_cnt` |
| `lx_dwd.dwd_rsk_all_monitor_decision_engine_pre_strategy_node_decision` | 预判策略节点流水对数 | `fhour`、`fsoure_cnt`、`frt_cnt` |
| `lx_dwd.dwd_rsk_strategy_node_with_param_decision` | 带参数策略节点流水 | — |
| `lx_dwd.dwd_cre_rsk_hawk_hawk_operate_water_df` | Hawk 操作流水明细 | `fbiz_model`、`fbiz_operate_type`、`finput_param`（JSON）、`fmodify_time` |

## 流程引擎

| 表 | 说明 | SQL 中出现的字段 |
|---|---|---|
| `rt_mart.t_process_decision_log` | 流程决策日志（`fdate` 分区） | `fprocess_id`、`fprocess_version`、`finstance_id`、`fuid`、`fip`、`felement_ids`（JSON 数组）、`foutputs`（JSON，`$.approval_result`）、`fcreate_time` |
| `rt_mart.t_strategy_node_decision_test_water` | 策略节点测试流水 | — |

## Presto 写法提示

已保存 SQL 中在 Presto 引擎下可用：`get_json_object(col, '$.key')`、`json_extract_scalar`、`json_parse` + `CAST(... AS array(varchar))`、
`cardinality` / `array_distinct` / `filter` / `array_join`、`md5(CAST(CONCAT_WS(...) AS varbinary))`、`COUNT(DISTINCT IF(cond, col, NULL))`。
