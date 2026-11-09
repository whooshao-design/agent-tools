# 案例集

每条案例固定四段：现象、查询路径、结论、沉淀。只写对下次排查有复用价值的内容；
表名、topic、结果码等事实项带核实日期，过期就改而不是堆叠。

## 模板

```markdown
## YYYY-MM-DD <一句话现象>

- 入口：<订单号 / 实例 ID / uid / traceId>，环境 <prod|pre|gray|stable>
- 查询路径：<表 + 关键条件 → 日志应用 + 关键字 → 名称查询>
- 结论：<流程 / 乐包 / 节点 / 规则 → 结果；间隔或异常的原因>
- 沉淀：<新的拼接关系、语义、调用方行为、坑>
```

## 2026-11-04 电商交易单 hold 后 3 分钟才转人工

- 入口：订单 `O20261104643572700718`，2026-11-04 20:37 左右，prod。
- 查询路径：
  1. `DecisionWaterHawkCK` `t_strategy_node_decision_water` 按 `Forder_id` 查当天流水（HTTP 降级，100 行翻页），按 `Fseq` 分组得到 4 个流程实例、3 次执行同一实例 `I2026110462556524804335965440718`。
  2. `ProcessmanageDB` `t_process` 取流程名；`HawkDecisionDB` `t_package`、`t_strategy_node`、`t_rule.Fname` 取乐包/节点/规则名。
  3. `t_rule_decision_water` 按 `Fseq + Fnode_id + Fhit=1` 找到给出 99 和 1 的规则。
  4. 日志平台 `process-engine` 按实例 ID 查到三次 `processRequest`，行尾调用方 `server-rc-trade-biz-java`；再按订单号查调用方日志拿到 MQ 发送与消费行。
- 结论：hold 发生在 `P00000031 电商二审交易流程` 第一次执行（20:37:34），乐包 1959 `电商AB1.5-识别策略包` 节点 208802 `新策略-自动审核节点` 规则 1448308 `电商人行查征hold单规则` 输出 `approval_result=99`、`disposal_codes=F00002`，引擎以 `business interruption, status=1` 结束。
  调用方收到 99 后发 `SECOND_AUDIT_RETRY_TOPIC`，180 秒后消费（msgId 改变，延迟消息重投）并重跑同一实例；第二次执行乐包 3626 `反欺诈_回捞策略_电商` 节点 445878 `赊销订单转人审` 规则 5069630 `赊销订单转人工（首单）` 给出 1（`SXDDZRG01`），调用方发 `FK_TRADE_MANUAL_TOPIC`。
  人工结果 50 秒后经 `SECOND_AUDIT_RETRY_FIX_TOPIC` 回流，规则 5074420 `人工审核结果_拒绝或修改分期数` 给出 2；用户改金额重新下单后一审/鉴权/二审全部通过。
- 沉淀：
  - 流程引擎调用米霍克时 CK `Fseq` 就是流程实例 ID，是 CK 流水与引擎日志的拼接键；引擎日志 `processRequest` 行尾给出调用方应用名。
  - 同一实例多次执行且引擎中间无日志，间隔在调用方；电商二审对 99 的重试延迟是 3 分钟（日志 `audit minutes ... 3`）。
  - `t_strategy_node` / `t_rule` 同 ID 多版本会吃掉 `LIMIT`，查名称要 `DISTINCT`；`t_rule_decision_water` 没有规则名列。
  - 该订单在 `server_credit_api` 无任何日志：交易单的 hold/转人工与授信 hold 单链路无关。
  - 当天 `bastion_dba` SSH 握手被对端关闭，CK 查询全部走乐信云 HTTP 降级完成。

## 2026-11-05 白名单流程 P00000397 报 tradeAuditType 缺失，上游是 WhiteMockPlugin 拦截的 P00000531

- 入口：雷神告警规则 110441（链接 ID 17021053，接口返回事件 ID 17021068），trace `AC13297E1793863762275747600E21`，prod。
- 查询路径：
  1. 日志平台 `process-engine-ec` 按告警 `trace_data` 的 traceId 查，同一 trace 内先后两条 `processRequest`：P00000531、P00000397。
  2. 关键字 `P00000397` + `tradeAuditType is missing` 取窗口内全部 trace，逐个核对父流程。
  3. `ProcessmanageDB` `t_process_edition_detail.Fprocess_content`（`Fedition_id` 取日志 `version`）解析网关出边的条件、默认边和目标节点。
- 结论：`WhiteMockPlugin.interceptor` 把白名单 uid 的 P00000531 请求同步转到 P00000397，入参原样复制后只加 `processSceneType`、`processBizType`、`processCreditCardType`；P00000531 的调用方未传 `tradeAuditType`，特征计算返回 `{}`，边条件报缺失后走默认边。
- 沉淀：
  - 白名单流程的上游不在流程定义里：看同 trace 的前一条 `processRequest` 和 `WhiteMockPlugin` 日志（`is in white list`、`newProcessRequest`）。
  - 流程按应用分部署：P00000031 的日志在 `process-engine`，P00000531、P00000397 的日志在 `process-engine-ec`；关键字统计换应用前先做阳性对照，否则 0 条没有意义。
  - 日志平台大时间窗关键字查询会被 ClickHouse 预估耗时限制拒绝（Code 160），要缩小窗口。

## 2026-11-09 墨西哥乐包 2799 入参 `$gd_x_7` 从数值变成字符串

- 入口：入参字段 `$gd_x_7`，最近 7 天，墨西哥 prod；无订单号，按字段做全量统计。
- 查询路径：
  1. MySQL 实例 `MxgHawkDecisionWaterDB` 的 `water_process_one_db.t_rule_online_decision_error_info`（线上决策异常流水），用 `JSON_TYPE(JSON_EXTRACT(Finput_values, '$."$gd_x_7"'))` 判断类型，按 `Fpackage_id` 分组。
  2. CK 实例 `MexicoCK`（乐信云 HTTP）的 `risk_control_base_db.t_strategy_node_decision_water`，用 `JSONType(Finput_values, '$gd_x_7')` 判断类型，加 `position(Finput_values, '"$gd_x_7"') > 0` 预过滤，按天拆成多条 SQL，按 `Forigin, Fpackage_id, t` 分组。
- 结论：只有乐包 2799 出现 `String`，CK 中首次出现在 2026-11-08 13:27:16，此后与 `Double` 并存；乐包 2792、2798、2801、2803 全周都是 `Double`。异常流水表里同一批数据的最早时间是 2026-11-07 23:27:16。
- 沉淀：
  - 墨西哥库有两个实例名相近：`MxgHawkDecisionDB` 是管理/字段库，里面没有 `water_process_one_db`；流水在 `MxgHawkDecisionWaterDB`。
  - 墨西哥 MySQL 流水与 `MexicoCK` 的 `Fcreate_time` 相差 14 小时，同一批数据 MySQL 早 14 小时：该实例 `@@time_zone=SYSTEM`、`@@system_time_zone=CST`（墨西哥中部时间 UTC-6，2026-11-09 实测 `NOW()` 比北京时间慢 14 小时），CK 存北京时间。按“今天”查 MySQL 时日期要按墨西哥时间算。
  - `MexicoCK` 节点流水每天约 255 万行，对 `Finput_values` 做 7 天 JSON 扫描会让 HTTP 返回 `query_code 1: 查询失败`，按天拆成多条 SQL 后可以成功；分区键是 `toYYYYMMDD(Fmodify_time)`，时间条件用 `Fmodify_time`。
  - `t_rule_online_decision_error_info` 只记录异常执行，它的类型分布不能代表全部流量，全量要查 CK。


## 2026-11-09 墨西哥 2799 新版本发布 72 秒后出现字符串，转换位置尚未确认

- 入口：实例 `I2026110744814348170867027200776`，CK 输入 traceId `0AF8034F179411563620825210261D`；墨西哥 prod，输入 `$gd_x_7`。类型与版本核对窗口为北京时间 `[2026-11-08 11:14:46, 2026-11-09 11:14:46)`。
- 查询路径：CK 实例 `MexicoCK` 的 `risk_control_base_db.t_strategy_node_decision_water` 按实例、乐包 2799 与时间查输入和版本；`MxgHawkDecisionDB.hawkeye_decision_engine_db` 的 `t_edition`、`t_strategy_node_field`、`t_rule` 比较 30423/30440；`MxgHawkDecisionWaterDB.water_process_one_db.t_rule_online_decision_error_info` 按乐包、节点和墨西哥本地时间查异常；CK `t_process_decision_log` 查入口 `fieldSet`。
- 结论：2799「额度更新_老客」30440 于北京时间 2026-11-08 13:26:04 发布，本次窗口内首条 String 出现在 72 秒后。两版字段配置均为 double、默认 -2、方法 ID 711、获取模式 1；规则 2300176 的组件 70735 从 v10 到 v11，新增 v5 分层判断，但 gd_x_7 的直接有效引用仍是读取与 >=10 比较，未发现直接字符串赋值。首条流程入口未带该字段；首条执行记录 ClassCastException，缺少堆栈。已确认发布与类型混用关联，未确认产生 String 的接口、缓存或转换语句，不能把候选查询批次变化当成根因。
- 沉淀：本轮管理库 `masterbackup` SELECT 返回“没有找到实例信息”，小范围元数据查询改 `query_role=master` 成功；首条异常记录 `Ftrace_id` 为空，用 Fseq、节点、时间关联。乐包汇总行 `Fpackage_edition_id=0`，实际版本用 `Fedition_id`；该样例带 `$gd_x_7` 的记录在乐包汇总行和节点 290364 行各有一条，记录数不等于唯一请求数。`t_process_decision_log` 在 MexicoCK 可查，本轮 `t_element_decision_log` 返回 query_code=1，失败不能解释为没有节点记录。线上 `t_strategy_node_field` 没有本地新代码中的 `Fis_real_time_query` 列，应先核实结构及生产版本。
  - `MexicoCK` 节点流水中，同一执行会同时出现实际 `Fnode_id` 和 `Fnode_id=-1` 两条带相同入参的记录，二者本次逐日计数一致；按策略节点统计时排除 `-1`，按请求统计时不能直接把总行数当请求数（2026-11-09 实测）。
  - 墨西哥 manage 实例 `MxgHawkDecisionDB` 本次 `SELECT` 使用 `query_role=master` 才成功，默认 `masterbackup` 返回“没有找到实例信息,请勾选主库查询”（2026-11-09 实测）。
  - `t_rule` 在同一 `Fpackage_id + Fedition_id + Frule_id` 下可能同时存在 `Fvalid_state=0` 和 `1` 两行；取当前执行代码必须限定 `Fvalid_state=0`，否则 `LIMIT 1` 可能拿到 `Fscript_data={}` 的失效行（2026-11-09 实测）。
  - `MexicoCK` 按乐包版本统计时，`Fnode_id=-1` 的记录在本次表现为 `Fpackage_edition_id=0、Fpolicy_tag=''`，实际节点 `290364` 的记录才是 `Fpackage_edition_id=30440、Fpolicy_tag='2799_master'`；不能把前者的 0 当成另一个乐包版本（2026-11-09 实测）。


## 2026-11-09 2799 两版规则均未显式将 gd_x_7 转为 double

- 入口：墨西哥 prod，乐包 2799，比较版本 30423 与 30440 中 `$gd_x_7` 的转换逻辑。
- 查询路径：`MxgHawkDecisionDB.hawkeye_decision_engine_db`，`query_role=master`；对 `t_rule` 的 82/83 条 `Fvalid_state=0` 记录完整检索字段引用，读取每版直接引用该字段的两条规则的原文、生成脚本和结果配置；按 `t_element.Findex` 读取组件 70605 v1、70735 v10/v11；另查 34 条含常见数值转换词的记录，按完整 `Fscript_data` 的数据库 MD5 分成 22 组，读取代表脚本并重新计算 MD5 校验。
- 结论：规则 2294604 两版原文、生成脚本和结果配置逐项相同；规则 2300176 从组件 70735 v10 升到 v11，与 gd 比较相关的变化为前置 v4/v5 分层条件。两版对 gd 都是 `def $0$_gd_x_7 = map['$0$_gd_x_7'];` 后直接 `>=10`，没有针对 gd 的显式 double 转换。`BuiltInFunction.toNumeric` 的参数是 uid；同节点 `Double.valueOf` 处理的是上一笔风险利率，不是 gd。不能用旧流水是 Double 推断旧规则做了转换，也不能把字段类型变化归因为 30440 删除了这类转换；字段服务和框架转换需另证。
- 沉淀：按字段声明 double 与执行转换代码分别取证；直接字段引用检索要覆盖 Frule_data/Fscript_data/Fresult_data，并继续查组件版本。组件历史记录本例 `Fis_test=1`，不能仅按列名猜 0 为目标生产记录；用规则保存的组件 ID、版本和实际 Findex 核对。本次材料按版本 ID 读取管理库记录，没有证明当时执行进程加载的快照内容。
