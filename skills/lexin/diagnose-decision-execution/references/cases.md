# 案例集

## 2026-11-09 墨西哥 2799 新版本发布 72 秒后出现字符串，转换位置尚未确认

- 入口：实例 `I2026110744814348170867027200776`，CK 输入 traceId `0AF8034F179411563620825210261D`；墨西哥 prod，输入 `$gd_x_7`。类型与版本核对窗口为北京时间 `[2026-11-08 11:14:46, 2026-11-09 11:14:46)`。
- 查询路径：CK 实例 `MexicoCK` 的 `risk_control_base_db.t_strategy_node_decision_water` 按实例、乐包 2799 与时间查输入和版本；`MxgHawkDecisionDB.hawkeye_decision_engine_db` 的 `t_edition`、`t_strategy_node_field`、`t_rule` 比较 30423/30440；`MxgHawkDecisionWaterDB.water_process_one_db.t_rule_online_decision_error_info` 按乐包、节点和墨西哥本地时间查异常；CK `t_process_decision_log` 查入口 `fieldSet`。
- 结论：2799「额度更新_老客」30440 于北京时间 2026-11-08 13:26:04 发布，本次窗口内首条 String 出现在 72 秒后。两版字段配置均为 double、默认 -2、方法 ID 711、获取模式 1；规则 2300176 的组件 70735 从 v10 到 v11，新增 v5 分层判断，但 gd_x_7 的直接有效引用仍是读取与 >=10 比较，未发现直接字符串赋值。首条流程入口未带该字段；首条执行记录 ClassCastException，缺少堆栈。已确认发布与类型混用关联，未确认产生 String 的接口、缓存或转换语句，不能把候选查询批次变化当成根因。
- 沉淀：本轮管理库 `masterbackup` SELECT 返回“没有找到实例信息”，小范围元数据查询改 `query_role=master` 成功；首条异常记录 `Ftrace_id` 为空，用 Fseq、节点、时间关联。乐包汇总行 `Fpackage_edition_id=0`，实际版本用 `Fedition_id`；该样例带 `$gd_x_7` 的记录在乐包汇总行和节点 290364 行各有一条，记录数不等于唯一请求数。`t_process_decision_log` 在 MexicoCK 可查，本轮 `t_element_decision_log` 返回 query_code=1，失败不能解释为没有节点记录。线上 `t_strategy_node_field` 没有本地新代码中的 `Fis_real_time_query` 列，应先核实结构及生产版本。

## 2026-11-09 2799 两版规则均未显式将 gd_x_7 转为 double

- 入口：墨西哥 prod，乐包 2799，比较版本 30423 与 30440 中 `$gd_x_7` 的转换逻辑。
- 查询路径：`MxgHawkDecisionDB.hawkeye_decision_engine_db`，`query_role=master`；对 `t_rule` 的 82/83 条 `Fvalid_state=0` 记录完整检索字段引用，读取每版直接引用该字段的两条规则的原文、生成脚本和结果配置；按 `t_element.Findex` 读取组件 70605 v1、70735 v10/v11；另查 34 条含常见数值转换词的记录，按完整 `Fscript_data` 的数据库 MD5 分成 22 组，读取代表脚本并重新计算 MD5 校验。
- 结论：规则 2294604 两版原文、生成脚本和结果配置逐项相同；规则 2300176 从组件 70735 v10 升到 v11，与 gd 比较相关的变化为前置 v4/v5 分层条件。两版对 gd 都是 `def $0$_gd_x_7 = map['$0$_gd_x_7'];` 后直接 `>=10`，没有针对 gd 的显式 double 转换。`BuiltInFunction.toNumeric` 的参数是 uid；同节点 `Double.valueOf` 处理的是上一笔风险利率，不是 gd。不能用旧流水是 Double 推断旧规则做了转换，也不能把字段类型变化归因为 30440 删除了这类转换；字段服务和框架转换需另证。
- 沉淀：按字段声明 double 与执行转换代码分别取证；直接字段引用检索要覆盖 Frule_data/Fscript_data/Fresult_data，并继续查组件版本。组件历史记录本例 `Fis_test=1`，不能仅按列名猜 0 为目标生产记录；用规则保存的组件 ID、版本和实际 Findex 核对。本次材料按版本 ID 读取管理库记录，没有证明当时执行进程加载的快照内容。
