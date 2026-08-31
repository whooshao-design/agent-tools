# metric -> 埋点代码 检索参考

## 1. 检索算法

```
指标名   fql_fk_server_hawk_decision_executor_simulate_nodeRoute_counter
         │      │                                        │         └ 后缀：counter / average / sum / gauge
         │      └ 应用名（instance_name 的下划线形式）      └ 中缀：埋点常量里的字符串字面量
         └ 固定前缀 fql_ 或 fql_fk_

1. 剥前缀、应用名、后缀 -> 中缀 nodeRoute
2. rg -n '"nodeRoute"' --glob '*.java' <repo>
   -> LogReporterConstants.NODE_ROUTE_COUNTER = PREFIX_METRIC + "nodeRoute" + METRIC_SUFFIX_COUNTER
3. rg -n 'NODE_ROUTE_COUNTER' --glob '*.java' <repo>
   -> 全部埋点点位
4. 用 tags 收敛：
   module=<类名> -> rg -n 'class <module>'
   type=<分支标签> -> rg -n '<type>'   （通常以 "type=xxx" 字面量出现在上报参数里）
5. 读点位上下文，提取三样：触发条件 / 配套日志关键词 / 返回行为
```

## 1.1 从代码取 Hippo key 名

代码里出现 `ExecutorHippoConfigConstants.xxx()` 这类开关调用时，一条命令带出 key 和默认值：

```bash
rg -n -B4 '<CONSTANT_NAME>\s*[;=]' --glob '*.java'
# -> @HippoConfigProperty(key = "enable_snapshot_lazy_load_offline", defaultValue = BOOLEAN_TRUE_STR)
#    public static Boolean ENABLE_SNAPSHOT_LAZY_LOAD_OFFLINE;
```

不要先搜方法名再搜常量名，那是两轮。拿到后还要读判空写法：
`!BooleanUtils.isFalse(X)` 表示只有显式配成 false 才关闭，未配置即默认开启。

## 2. 实测案例：告警 16343328

指标 `fql_fk_server_hawk_decision_executor_simulate_nodeRoute_counter`，
tags `module=RcDecisionRouteServiceImpl method=routeByOfflineDecisionNode type=routeResultIsEmpty`。

定位到
`server_hawk_decision_executor/server-hawk-decision-executor-kernel/src/main/java/com/fenqile/rc_comm/hawk/decision/executor/service/impl/route/RcDecisionRouteServiceImpl.java`：

```java
public DecisionNodeRoute routeByOfflineDecisonNode(OfflineDecesionNodeRouteReq routeReq) {
    ...
    Optional<StrategyNode> strategyNodeCacheOpt = offlineSnapshotReadThroughService
            .getOfflineDecisionStrategyNodeCache(...);
    if (!strategyNodeCacheOpt.isPresent()) {
        log.warn("route result is empty. tenantId = {}, routeReq={}", MtContextUtil.getTenantId(), routeReq);
        logReporter.counterReport(LogReporterConstants.NODE_ROUTE_COUNTER, CLASS_NAME,
                EntryConstants.ROUTE_BY_OFFLINE_DECISION_NODE, "type=routeResultIsEmpty", 1.0);
        return null;
    }
    ...
}
```

三样产出：

- **触发条件**：离线决策节点的策略节点快照穿透读为空。
- **日志关键词**：`route result is empty`，参数 `routeReq` 含 `decisionNodeId`、`packageId`、`editionId`、`offlineTaskId`。
- **返回行为**：返回 `null`，调用方拿不到路由结果。

## 3. 三个坑

### 3.1 method 标签 ≠ Java 方法名

标签值 `routeByOfflineDecisionNode` 来自 `EntryConstants.ROUTE_BY_OFFLINE_DECISION_NODE`，
而 Java 方法名是 `routeByOfflineDecisonNode`（少一个 `i`）。
直接拿 `method` 标签搜方法名会搜空，必须先搜常量。

### 3.2 壳工程

| 仓库 | Java 文件数 | 说明 |
|---|---|---|
| `server_hawk_decision_executor_simulate` | 3 | 只有 `Main.java`，仅打包入口 |
| `server_hawk_decision_executor_batch` | 3 | 同上 |
| `server_hawk_decision_executor` | 669 | 真实业务与埋点代码 |

应用名到仓库不是一一映射。脚本会用 Java 文件数标记 `thin launcher`
并列出同组兄弟仓库，搜索必须扩到整组。

### 3.3 代码基线漂移

本地仓库常停在某个发布分支（如 `rel_xxx_1423729`，末次提交 2026-08-04），
与告警触发时刻的线上版本未必一致。结论里必须写明
`仓库路径 + 分支 + 末次提交日期`，并提示线上版本可能不同。

本地没有仓库时的降级：从同组仓库的 `git remote` 推断地址
（hawk 系为 `gitlab.fenqile.com/rc_comm/<app>`），如实报告"代码基线缺失"。

### 3.4 常量类在多模块重复定义

`LogReporterConstants` 在 `-engine` 和 `-kernel` 两个模块各有一份同名类，
中缀检索会同时命中。判断实际生效的那份，要看埋点点位所在模块 import 的是哪个包。

### 3.5 一个常量对应多个埋点点位

`NODE_ROUTE_COUNTER` 在 `RcDecisionRouteServiceImpl` 里被引用 3 次（约 168、225、546 行），
分别对应不同的路由入口。必须用 tags 的 `method` 常量和 `type` 标签收敛到唯一点位，
只凭指标名会读错分支。

### 3.6 埋点日志级别决定查哪个日志文件

计数上报点旁边的日志常常是 `log.warn`（如 `route result is empty`），
而 `java-server-diagnostics` 的默认快检只读 `error.log`。
按 WARN 级别查 `error.log` 会查不到任何东西，并被误判成"无日志证据"。
定位到埋点后，先看那一行是 `log.warn` 还是 `log.error`，再决定查 `info.log` 还是 `error.log`。

## 4. 采样与口径

`HawkLogReporter` 的 `*Sampling` 系列方法带 `needSampling(num)` 判断，
按采样上报；`logReporter.counterReport(...)` 是全量上报。
判断"计数值是否等于真实发生次数"时必须先确认走的是哪条路径，
否则会把采样系数当成业务量级。

## 5. 告警事件字段速查

| 字段 | 含义 |
|---|---|
| `id` / `rule_id` / `rule_name` | 事件 ID / 规则 ID / 规则名 |
| `severity` | 1 紧急、2 严重、3 普通 |
| `is_recovered` / `recover_time` | 是否已恢复 / 恢复时间 |
| `trigger_time` / `first_trigger_time` | 本次触发 / 首次触发（unix 秒） |
| `trigger_value` | 触发时的表达式取值 |
| `prom_ql` / `prom_for_duration` / `prom_eval_interval` | 告警表达式 / 持续时长 / 评估间隔 |
| `tags` | `key=value` 数组，含 ident、instanceName、env、set 及业务维度 |
| `trace_data[]` | `seriesLabels`、`traceId`、`value`、`timestamp`，打通日志链路 |
| `target_ident` / `instance_name` / `apps` | 实例 IP / 应用名 / 关联应用列表 |
| `app_owner` / `receiver` / `notify_channels` | 负责人 / 接收人 / 通知渠道 |
| `env` / `set` / `business_line` | 环境 / set / 业务线 |

## 6. 规则字段速查

| 字段 | 排查用途 |
|---|---|
| `disabled` | 规则是否已停用 |
| `prom_for_duration` | 持续多久才告警，判断是否过敏 |
| `enable_stime` / `enable_etime` / `enable_days_of_week` | 生效时段，判断是否本应静默 |
| `notify_repeat_step` / `notify_max_number` | 重复通知间隔与上限，解释"为什么刷屏" |
| `recover_duration` / `notify_recovered` | 恢复判定与恢复通知 |
| `update_by` / `update_at` | 最近改动人与时间，规则突然变敏感时先看这里 |
