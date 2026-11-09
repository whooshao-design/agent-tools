# 墨西哥决策字段链路（导航版）

墨西哥（MX）米霍克乐包的字段取值、字段类型、字段缺失问题，先按本文定位到具体一跳和可对账的数据，再回到代码和线上数据核实。
内容核对于 2026-11-09；与实际代码或数据冲突时以实际为准。本文刻意不写 IP、域名和完整代码路径；
本机工作区有完整版时（hawk 工作区 `docs/system-analysis/墨西哥决策字段链路.md`）优先读完整版。

## 调用链

| # | 应用 | 入口 | 行为 |
|---|---|---|---|
| 1 | 米霍克 dispatcher（墨西哥模块 `...-infra-mexyw`） | `FieldBatchComputeServiceMex.doCompute` | HTTP POST 到 Hippo `mihwak_virtual` / `hippo.mihwak_common` 的 `suoji.compute.url`；响应只 `JSON.parseObject`，不转类型 |
| 2 | `service-middle-gateway`（仓库 `overseas_platform`） | `MiddleActionController`，路径 `/route/action/mihawk_adapter/rule/field/computing/compute` | Feign `MihawkFieldFc` 转给 `service-action` |
| 3 | `service-action`（仓库 `overseas_platform`） | `MihawkFieldServiceImpl.fieldCompute` → `FieldServiceImpl.compute` → `getFeaturePlatformCompute` | 按 `action_db.t_data_field.Fplatform` 分组取值，再 `handleFieldDataType` 按 `Fdata_type` 转类型 |
| 4 | `mx-field-service-mexyw` | 源码不在本地 | `AfFieldComputingService` 的消费方，invoker=1001（Hippo `biz.feature.field.config`）；3→4 的跳转是推断 |
| 5 | `middle-risk-core` | `AfFieldComputingServiceImpl` → `AfFieldComputingLogic` → `AfFieldComputingRpcLogic` | fsof 原样透传，不转类型 |
| 6 | 字段平台（墨西哥壳工程 + 国内 core 依赖） | `BaseFeatureRpcComputeServiceImpl` | API 类基础特征按 `directFieldPath` 取原值；404 时返回配置默认值。墨西哥 Hippo 开关为全量新特征链路 |

和国内的关键差异：字段类型转换在 `service-action`，不在米霍克或字段平台。

## `service-action` 类型转换的坑

`FieldServiceImpl.handleFieldDataType` 按 `getFieldInfoByNames`（`Ffield_name IN (...) AND Fstate=1`，无 `ORDER BY`）的顺序逐个转换：
int 用 `Integer.valueOf`，double 用 `Double.valueOf`。任一字段失败即抛 `Field [xxx] type validation failed`，后续字段保留字段平台原值；
外层 catch 吞掉异常，调用方仍收到 `retcode=0`。

典型现象：乐包新版本新增引用一个“登记为 int、实际返回 `-1.0`”的字段后，同一请求里排在它后面的 double 字段从数字变成字符串，
404 默认值（本来就是 Double）仍是数字。日志关键字：`[Field validation failed]`、`simulate suoji field calculate`。

## 可对账的数据

| 用途 | 实例 | 表 | 关联键 |
|---|---|---|---|
| 节点决策流水 | CK `MexicoCK`（乐信云 HTTP） | `risk_control_base_db.t_strategy_node_decision_water` | `Forder_id`、`Fpackage_id`、`Fnode_id`、`Fexecution_info.traceId` |
| 米霍克实际收到的字段值（保留 JSON 类型） | CK `MexicoCK` | `risk_control_base_db.t_decision_trace_cost_serial.Fpull_fields`（`fieldResults` 为本节点拉取值） | `Ftrace_id`、`Fnode_id` |
| 字段平台逐特征返回 | CK `MexicoCK` | `risk_feature_platform_db.t_feature_invoke_water`（`Ffeature_value` 统一为 String，看不出类型） | `Forder_id`、`Fseq_no`、`Ffeature_name`、`Ffeature_status` |
| 特征元数据 | MySQL `MxgRiskfeatureDB` | `meta_info_db.t_general_feature_info`（`Fvalue_type`） | `Ffeature_name` |
| 乐包/节点/规则元数据 | MySQL `MxgHawkDecisionDB` | `hawkeye_decision_engine_db.*` | ID |
| 规则执行异常 | MySQL `MxgHawkDecisionWaterDB` | `water_process_one_db.t_rule_online_decision_error_info`（只有异常类名） | 实例 ID |
| `service-action` 字段登记 | 实例未确认 | `action_db.t_data_field`（`Fdata_type`、`Fplatform`） | `Ffield_name` |

- 墨西哥 MySQL 时间比北京时间慢 14 小时；CK 显示为北京时间。
- `MxgRiskDB.rcrule_db.t_rcrule_data_field` 在墨西哥是空表，不能用来判断字段来源。
- 乐信云 MySQL 对不存在的实例名也提示“没有实例权限”，不能用它判断实例是否存在。
- `action_db` 实例：`service-action` 数据源在墨西哥 Nacos（`common.yml` / `service-action.yml`）；启动类 `BootPrinter` 会读取 `spring.datasource.druid.url`，可从启动日志确认。

## 排查顺序

1. 节点流水定位异常开始的乐包版本、节点和 traceId。
2. traceId 查 `Fpull_fields`，确认米霍克收到的值和 JSON 类型。
3. 订单号查 `t_feature_invoke_water`，确认字段平台返回值与状态。
4. 两端值相同、类型不同：问题在 `service-action` 转换，比较前后版本该节点拉取的字段集合，找登记类型与实际值不符的新增字段；值不同：看字段平台计算或默认值。
5. 定论需要 `action_db.t_data_field` 或 `service-action` 日志。

## 已知不可用

- 扁鹊墨西哥 traceShow 对试过的 traceId 均返回空，无法用调用链证实 3→4。
- 本机直连墨西哥网关超时；本机没有墨西哥 k8s context。
- 线上 `service-action`、网关、米霍克墨西哥 dispatcher 的部署分支未核对。

## 案例

2026-11-08 乐包 2799 从版本 30423 切到 30440 后，节点 290364 的 `gd_x_7` 非默认值全部变成字符串，`-1.0` 仍为数字。
字段平台两个时期输出一致；30440 新增 `fuid_his_ovd_principal_max_prd`（值总带小数）等字段，`handleFieldDataType` 中途失败导致 `gd_x_7` 未转 Double。
具体失败字段待 `action_db.t_data_field` 确认，备选为新增的 `*_v5` 字母值字段。
