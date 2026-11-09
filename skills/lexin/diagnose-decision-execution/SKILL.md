---
name: diagnose-decision-execution
description: 排查线上（预发布/灰度/线上）流程引擎流程与米霍克乐包的一次决策执行：按订单号、流程实例 ID、uid 或 traceId 串起节点流水、规则流水、流程名/乐包名/节点名/规则名、引擎日志和调用方日志，回答这单走了哪个流程、哪个乐包节点规则给出了什么结果、为什么中断/转人工/拒绝、两次执行之间的间隔是谁造成的。Use when 用户给出订单号或流程实例 ID 要求排查流程决策结果、确认乐包/节点/规则的决策结果、解释 approval_result 或 disposal_codes、追查流程为什么 hold/中断/转人工、解释两次决策之间的时间间隔；只读排查，不改流程、乐包或配置。
metadata:
  version: 1.2.0
---

# diagnose-decision-execution

## 定位

对一次线上决策执行做只读排查并给出可核对的结论：输入是订单号、流程实例 ID、uid 或 traceId，
输出是按时间排序的执行链路（调用方 → 流程引擎流程 → 米霍克乐包/节点/规则 → 结果 → 调用方后续动作）和结果解释。

不改流程、乐包、规则或 Hippo 配置，不重放决策，不判断字段取值本身是否正确（字段链路归字段平台排查），
不处理 stable 审批。环境默认线上；stable/测试流水的实例和域名见 `query-clickhouse-water`。

与相邻 skill 的边界（本 skill 是编排层，数据访问全部交给它们，不另写脚本）：

- `query-clickhouse-water`：执行节点流水、规则流水 SQL。本 skill 提供表、字段、业务键和时间窗。
- `query-app-logs`：按实例 ID / 订单号 / traceId 查日志平台。本 skill 提供应用名、关键字和时间窗。
- `query-mysql-data`：查流程名、乐包名、节点名、规则名。本 skill 提供实例、库表和 ID。
- `query-hive-data`：流程级决策日志 `rt_mart.t_process_decision_log` 在 Hive，CK 的 `DecisionWaterHawkCK` 上没有这张表。
- `query-hawk-field-reference`：字段被哪些乐包/节点引用，与本 skill 的“某次执行的结果”方向不同。
- `diagnose-healthy-alert`：入口是告警；需要落到某笔决策时交接订单号或 traceId 给本 skill。

## 入口 ID 与拼接关系

| ID | 形态 | 在哪里出现 | 用它查什么 |
|---|---|---|---|
| 订单号 | `O2026...`（子单）、`FO...`/`PPO...`（父单/审核单） | 调用方日志、CK `Forder_id` | CK 节点流水、调用方日志 |
| 流程实例 ID | `I2026...` | CK `Fseq`（流程引擎调用米霍克时 `Fseq` 就是实例 ID）、引擎日志 `instanceId[...]` | 引擎日志、CK 规则流水 |
| 流程 ID | `P000000NN` | CK `Fprocess_id`、引擎日志 `processId[...]` | `process_engine_db.t_process` 取流程名 |
| 乐包 / 节点 / 规则 ID | 数字 | CK `Fpackage_id`、`Fnode_id`、`Frule_id`；`Finvoke_flow_id` 形如 `P1959` 时数字部分就是乐包 ID | `hawkeye_decision_engine_db` 取名称 |
| traceId | 30 位十六进制 | CK `Fexecution_info.traceId`、日志平台 `tid` | 跨应用拉同一次调用 |
| 调用方应用 | 日志行尾 `|<ip>:<app>` | 引擎日志 `ProcessEngineProxyImpl.doExecute` 行尾 | 调用方日志 |

`Fprocess_id` 为空、`Finvoke_flow_id` 为纯数字的行是米霍克旧接入（直接 `rcFlowDecision`），不经过流程引擎；
`Finvoker=10020` 的行来自流程引擎，`10007` 来自 `server_credit_api` 的授信 hold 单节点，`10023` 来自批跑执行器（2026-11-05 观察）。

## 排查步骤

1. **拉节点流水**（`query-clickhouse-water`，实例 `DecisionWaterHawkCK`，表 `risk_control_base_db.t_strategy_node_decision_water`）。
   条件：`Forder_id = '<订单号>'`（或 `Fseq = '<实例 ID>'` / `Fuid`）加当天闭开时间窗；
   取 `Fcreate_time, Fseq, Fprocess_id, Fprocess_scene_type, Finvoker, Finvoke_flow_id, Fpackage_id, Fpackage_edition_id, Fnode_id, Fapproval_result, Fdecision_status, Fhit, Forigin, Fexecution_info`，`ORDER BY Fcreate_time`。
   HTTP 通道 `LIMIT` 上限 100：返回恰好 100 行就以最后一行的 `Fcreate_time` 为起点翻页。`Fnode_id = -1` 是乐包级汇总行。
2. **汇总时间线**：按 `(Fcreate_time, Fseq, Fprocess_id, Finvoker, Finvoke_flow_id)` 分组，列出乐包、节点、结果集合、traceId。
   同一 `Fseq` 出现多个时间点就是同一实例被多次执行，间隔要在步骤 5/6 里找原因。
3. **取名称**（`query-mysql-data`）：流程名 `ProcessmanageDB` 的 `process_engine_db.t_process`；
   乐包/节点/规则名 `HawkDecisionDB` 的 `hawkeye_decision_engine_db.t_package`、`t_strategy_node`、`t_rule`（规则名列是 `Fname`）。
   `t_strategy_node` 和 `t_rule` 同一 ID 有多版本，要 `DISTINCT` 或加 `Fvalid_state = 0`，`LIMIT` 要给足。
4. **下钻规则**：对结果非 0 的节点查 `risk_control_base_db.t_rule_decision_water`，条件 `Fseq`、`Fnode_id`、`Fhit = 1`，
   看 `Frule_id`、`Fstrategy_id`、`Fapproval_result`、`Foutput_values`（`#approval_result`、`#disposal_codes`、`#cause`、`#RC_CAUSE_CODE`、`#BRANCH_NEXT_NODE_ID`）。
   规则流水没有规则名，用步骤 3 回填。
5. **引擎日志**（`query-app-logs`，应用 `process-engine`，关键字为实例 ID）。关键行：
   `ProcessEngineProxyImpl.doExecute` 的 `processRequest`（invoker、inputs、行尾调用方应用）、`DubboServiceTask invoke`（流程里调的外部 Dubbo 服务与入参）、
   `ProcessTask.postExec` 的 `exec result:ExecResult(...)` 与 `exec traces`、`isBusiInterruption, countDown`、`ProcessTaskScheduler.remove ... is done`。
   同一实例两次 `processRequest` 之间引擎没有任何日志，说明间隔在调用方。
6. **调用方日志**（`query-app-logs`，应用名取自步骤 5 行尾，关键字订单号或审核单号）。
   找结果处理和 MQ 发送/消费行：发送与消费的 msgId 不同、间隔是整分钟，是 RocketMQ 延迟消息重投。
7. **写结论**：先一句话说哪个流程、哪个乐包/节点/规则给出什么结果；再给时间线表（时间 / 应用 / 事件）；
   最后列推断项和未核对项。调用方源码不在本地时，行为只能标注“从日志观察”。

## 结果语义

- 米霍克 `DecisionResultEnum`（`server_hawk_decision_executor/.../constants/DecisionResultEnum.java`）：`0 通过`、`1 转人工`、`2 拒绝`、`99 BLOCK 流程引擎中断`。
- 流程引擎 `ExecResult.status`（`process-core/.../constants/ProcessStatusEnum.java`）：`-1 失败`、`0 执行中`、`1 等待中`、`9 完成`。
  `msg=business interruption, status=1` 对应 `ProcessEngineExceptionEnum.BUSI_INTERRUPTION(911)`：乐包返回 99 后流程中断等待调用方再次调用同一实例。
- `disposal_codes`：`F00001` 是引擎在字段缺失时写入（`process-infra/.../DecisionEngineProxy.java` 第 489 行附近）；
  其他 `F000xx` 来自乐包规则出参，含义以规则名为准。
- `Forigin`：`0 线上`、`1 批跑`、`2 仿真`。`Fhit`：`1 命中`。
- `Fexecution_info` 是 JSON，含 `traceId`、`executorIp`、`appName`、`decisionType`（`PACKAGE_DECISION` / `FLOW_DECISION`）、`costInfo.decisionCostMs`。

## 已知调用方行为（按观察日期标注）

电商交易 `server-rc-trade-biz-java`（2026-11-05 观察，源码不在本地工作区）：

- `auditType 1/2/3` 分别走 `P00000030 电商一审交易流程`、`P00000034 电商鉴权流程`、`P00000031 电商二审交易流程`，引擎 `invoker=23`。
- 二审返回 99 时发 RocketMQ `SECOND_AUDIT_RETRY_TOPIC`，3 分钟后消费并用同一实例 ID、同一 traceId 再次调用引擎；日志 `audit minutes <审核单号> <首次时间> 3`。
- 返回 1 时发 `FK_TRADE_MANUAL_TOPIC`（转人工），auditStatus 303；人工结果经 `SECOND_AUDIT_RETRY_FIX_TOPIC` 回流再跑一次二审，终态经 `AUTO_AUDIT_OFFER_RESULT` 通知。

新的调用方行为先写进 `references/cases.md`，同一行为被两次以上案例确认后再提到这里。

## 已知坑

- 墨西哥（`MexicoCK`）乐包的字段值或字段类型异常（如同一字段时而数字时而字符串）：字段经 `service-action` 转类型后才到米霍克，调用链、可对账的表和排查顺序见 `references/mexico-field-chain.md`。
- `DecisionWaterHawkCK` 默认走 `bastion_dba`；堡垒机 SSH 握手被断开时按 `query-clickhouse-water` 的降级规则改 HTTP，并在结论里写明。
- 乐信云 HTTP 不支持 `DESCRIBE`，表结构用 `SHOW CREATE TABLE`；`SELECT` 必须带 `WHERE` 和 `LIMIT`。
- `t_process_decision_log` 不在 `DecisionWaterHawkCK`，也未在 `RCbaseCK` 的 `risk_control_base_db` 列出；需要流程级日志时走 Hive `rt_mart.t_process_decision_log`（`fdate` 分区）。
- 授信 hold 单（`server_credit_api` 的 `RcOrderBizResultServiceImpl.hold`）与交易订单的 hold/转人工是两套链路，订单号以 `O` 开头的交易单不要去查授信侧。
- 日志平台按应用名精确匹配，写错返回 0 条不报错；流程引擎应用名是 `process-engine`。

## 输出格式

1. 结论一句话：流程、乐包/节点/规则、结果、间隔原因。
2. 时间线表：时间 / 应用（IP 可省）/ 事件，含 traceId 或 msgId 等可复核标识。
3. 结果解释：结果码、处置码、原因码对应的名称。
4. 推断与未核对项：调用方源码不在本地、延迟级别未核对、通道降级等。

排查结束把案例按 `references/cases.md` 的模板追加一条；只记录对下次排查有复用价值的拼接关系、语义和坑。
确实没有可复用内容时，在回复里写明“本轮无沉淀”。

## 沉淀提醒 hook（Claude Code）

`$AGENT_TOOLS_ROOT/hooks/decision_case_reminder.py` 是 Stop hook：本轮 tool_use 里出现本 skill 的加载、
`t_strategy_node_decision_water` 或 `t_rule_decision_water`，而整个会话没有写过 `references/cases.md`，且最后回复没有“本轮无沉淀”
字样时，拦截一次并给出补案例的理由；`stop_hook_active=true` 时放行，异常输入放行。它不经 `install.py`，在 `~/.claude/settings.json`
的 `hooks.Stop` 手动登记（已于 2026-11-05 登记）：

```json
{"type": "command", "timeout": 10,
 "command": "~/.pyenv/versions/3.11.7/bin/python3 $AGENT_TOOLS_ROOT/hooks/decision_case_reminder.py --owner agent-tools-decision-case-reminder-v1"}
```

Codex 没有同类 hook，依赖 `AGENTS.global.md` 工作方式里的同一条要求。测试：`python3 -m unittest hooks.tests.test_decision_case_reminder`。
