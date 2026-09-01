---
name: inspect-app-call-topology
description: 只读排查应用的 FSOF/Dubbo 上下游调用关系，定位异常实例与时间点，并输出自包含 HTML 报告。Use when 用户要求查某个应用被谁调用、调用了哪些外部服务、某个 service 的客户端应用是谁、应用的接口调用量与错误率耗时、梳理服务依赖拓扑、排查上下游故障影响面、对比发布前后接口变化。
metadata:
  version: 1.3.0
---

# inspect-app-call-topology

## 定位

基于 Healthy/雷神 的 fsof provider/consumer 监控指标，只读梳理一个应用的三段调用关系：
**谁在调我 → 我对外提供什么接口 → 我调了谁**，对异常链路下钻到实例和时间点，
并输出含拓扑图、明细表和原始 JSON 的自包含 HTML 报告。

不做的事：不注册指标、不改大盘、不改告警、不碰应用配置。

和相邻 skill 的边界：

- `inspect-healthy-metrics`：检查单个指标是否正常上报；本 skill 关心调用关系，不判断指标上报健康度。
- `register-healthy-metrics`：指标注册；fsof monitor 族是自动上报的，不在注册表里。
- `healthy-dashboard-config` / `inspect-healthy-jvm-dashboard`：大盘配置与 JVM 视角。
- `diagnose-healthy-alert`：从告警反查根因；本 skill 提供其中的上下游依赖面。
- `query-app-instances` / `java-server-diagnostics`：本 skill 下钻出问题实例后，接这两个拿机器和日志。
- `query-dubbo-registry`：注册中心视角（声明了什么，含零流量）；本 skill 是指标视角（实际有多少流量）。
  指标查不到某个下游 service 的归属应用时，本 skill 会兜底调用它补全。

登录态复用 `inspect-healthy-metrics` 的同一套机制，不在会话里索要密码、验证码、Cookie 或 token。

## 覆盖范围

**只覆盖 FSOF/Dubbo RPC。** MySQL、Redis、MQ、HTTP 入口的依赖不在这套指标里，不要用本 skill 的结果声称"应用的全部依赖"。

只反映窗口内**有流量**的接口；零流量的已注册接口不会出现。

站点只验证过线上 `healthy.lexincloud.com`；stable 站点域名已接好但未实跑，指定时脚本会打印未验证提示。

## 用法

默认不限制环境（gray/oa/pre/prod 全看）、窗口 1 天：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/inspect-app-call-topology/scripts/inspect_call_topology.js \
  --app=server_strategy_decision_java
```

只看线上、只看最近 1 小时：

```bash
node .../inspect_call_topology.js --app=server_strategy_decision_java --env=prod --range=1h
```

只知道 service 不知道应用时，先反查归属应用再展开：

```bash
node .../inspect_call_topology.js --service=com.fenqile.rc.strategy.decision.service.ExpressRuleRunnerService
```

拉长到 3 天或 7 天盘点低频接口：

```bash
node .../inspect_call_topology.js --app=xxx --range=7d
```

判断发布影响，对比 7 天前的同长窗口：

```bash
node .../inspect_call_topology.js --app=xxx --range=6h --baseline=7d
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--app` | — | 目标应用名（app 标签值，可含连字符）；与 `--service` 二选一 |
| `--service` | — | 聚焦单个 service；不给 `--app` 时先反查它属于哪个应用 |
| `--site` | `prod` | `prod`/`online` 已验证，`stable`/`test` 未验证 |
| `--env` | `all` | **默认不限制环境**，四个环境全看；传 `prod`/`gray`/`pre`/`oa` 才限定 |
| `--range` | `1d` | 统计窗口，可传 `1h` / `3d` / `7d` 等 |
| `--baseline` | — | 与多久之前的同长窗口对比，如 `1d`/`7d`；不给则不做对比 |
| `--slow-ms` | `500` | 平均耗时告警阈值（ms），可传 `0` |
| `--max-drilldown` | `8` | 异常下钻的链路数上限，传 `0` 关闭 |
| `--out-dir` | `/home/joney/docs/service-relationships` | HTML 输出目录 |
| `--out` | — | 直接指定 HTML 输出路径 |
| `--json` | — | 额外把完整结果写到该 JSON 路径 |
| `--no-html` | — | 只打印终端摘要 |
| `--fail-on-anomaly` | — | 有异常条目时以退出码 2 结束，便于串流水线 |
| `--concurrency` | `6` | 并发查询数 |
| `--http-timeout` | `30000` | 单次请求超时毫秒 |
| `--retries` | `2` | 可重试错误（超时、5xx、429、网络抖动）的重试次数 |
| `--token` | — | 也可用环境变量 `HEALTHY_METRIC_TOKEN` |
| `--profile` | `/tmp/healthy-metrics-profile` | 无 token 时从该 profile 的 `localStorage` 取；失效用 `get-browser-session` 刷新 |

输出文件名为 `<app>-<env>-<时间戳>.html`，自包含单文件、无 CDN 依赖，内网可直接打开。

## 查询链路

| 步骤 | 查询 | 得到 |
|---|---|---|
| 1 | provider 五指标 by `env,service,method,group,version,set` | 我对外提供的接口与健康度 |
| 2 | consumer 五指标 by `env,service,method,group,version,src_set,dst_set` | 我调出去的接口与健康度 |
| 3 | 用步骤 1 的 service 列表反查 consumer 侧 by `app,...` | **谁在调我**（客户端应用名） |
| 4 | 用步骤 2 的 service 列表反查 provider 侧 by `app,service` | **我调的是谁**（下游应用名） |
| 5 | 异常链路按 `ident,origins` 展开 + 错误时间线 range 查询 | **哪台机器、什么时候出的错** |
| 6 | `--baseline` 时把窗口整体 `offset` 到过去重跑 1、2 | 接口新增 / 消失 / 量变 / 耗时劣化 |
| 7 | 步骤 4 查不到归属的 service，调 `query-dubbo-registry` 脚本 | 零流量 / 未接指标服务的归属应用 |

五个指标后缀：`acc_count`、`err_count`、`avr_cost_time`、`slowest_cost_time`、`successrate`。

步骤 1 与 2 并发，3 与 4 并发，5 与 6 并发；每层内部的查询也并发（`--concurrency`）。

## 口径要点

改脚本或手写 PromQL 前必须先看这几条，都是实测踩出来的：

1. **不要直接拼接 app 名做指标名。** app 标签允许连字符（如 `server-rcrule-dataconfig-java`），
   而 Prometheus 指标名不允许，实际指标名是 `server_rcrule_dataconfig_java_provider_monitor_acc_count`。
   一律用 `{__name__=~".*_provider_monitor_acc_count",app="…"}` 选择。

2. **`env` 默认不过滤，四个环境（`prod`/`gray`/`pre`/`oa`）全看。** 所有明细表都带 `env` 列，可逐环境区分；
   拓扑按应用聚合，同一应用的多个环境合成一个节点，报告头部会列出实际覆盖到的环境。
   要单看某个环境（例如只算线上流量）必须显式传 `--env=prod`，否则预发和灰度会算进来。

3. **`acc_count` 是每 60s 采集周期的增量，不是单调计数器。** 窗口总量用 `sum_over_time(...[range])` 求和；
   靠调大 `query_range` 的 `step` 会取到"最近一个样本"而非区间和，长窗口严重低估。

4. **`avr_cost_time` / `slowest_cost_time` 的源单位是微秒**，脚本在 PromQL 里除以 1000 转 ms。
   判定依据：全局 provider `avr_cost_time` 分布 p50=6490、p90=76617、p99=667690、max=1.83e9；
   按 ms 解读意味着半数接口平均 6.5 秒、单次调用最长 21 天，不成立。
   交叉验证：同一次调用消费端量到 6579、提供端量到 5831，差值 748µs 正好是网络与序列化开销。

5. **这两个是平均值不是汇总耗时。** 实测同接口调用量从 1 变到 165 时 `avr_cost_time` 稳定在 21562~33182，与调用量无关联。

6. **consumer 指标没有目标应用名**，只有 `dst_set`（套名）。下游应用必须用 provider 侧按 `service` 反查。
   service 归属与 env 无关，该反查刻意不加 env 过滤，避免漏掉只在部分环境上报的应用。
   同一 service 可能由多个应用同时提供（分机构部署），这类标为**多候选**，不假装能归到某一个。

7. **指标只覆盖窗口内有流量的 provider。** 零流量或未接指标的 service 在指标里查不到归属，
   会兜底调 `query-dubbo-registry` 的脚本补全，报告里标为**注册中心**以区分来源。
   注册中心不可用（登录态失效、未安装该 skill）时降级为「未知应用」并打印提示，**不中断整个报告**。

8. **少量接口只上报 `acc_count` 不上报 `successrate`**（全局 7894 vs 7890）。这类的最低成功率必须显示
   "无数据"，不能默认成 100——否则会把没有数据渲染成绿色正常态。

9. **错误时间线必须用 `sum_over_time(...[step])`，不能裸采样。** 实测同一批错误
   `sum_over_time([7d])` 得到 3 次，而 `query_range` 用 `step=300` 裸采样只看到 2 次。
   桶宽固定在分钟级（≤6h 用 60s，≤2d 用 120s，更长用 300s），不按窗口比例缩放——
   按比例算 7d 会得到 42 分钟一个桶，定位不到问题时间点。

10. **下钻的实例表只列异常实例**（几十台机器全列没法看），但一致性校验用全量实例算：
   下钻过滤条件比链路行宽（不带 group/version/src_set/dst_set），实例错误合计应当 ≥ 链路错误数；
   小于时报告会显式标注"实例分布不完整"，不静默给偏小的数。

11. **service 正则要双重转义。** 标签值是 PromQL 双引号字符串字面量，字面量里 `\.` 是非法转义，
   必须写成 `\\.` 才能让正则引擎收到 `\.`。service 列表按正则总长度分批（上限 1500 字符），避免 URL 过长。

12. **平均耗时是各实例 `avr_cost_time` 的未加权平均**，实例间流量不均时为近似值。

## 排查建议

1. 先零参数跑（不限环境 + 1 天窗口）出全景，看概览卡片的「异常条目」。只关心线上时加 `--env=prod`。
2. 有异常时直接看报告的「异常下钻」：它只列出错的实例（正常的不占版面）和错误发生的时间点。
3. 拿到实例 IP 后接 `query-app-instances` 确认机器归属，再用 `java-server-diagnostics` 看该机器的 `error.log`。
4. 判断影响面：上游表告诉你故障会波及哪些应用，下游表告诉你自己可能被谁拖垮。
5. 怀疑是发布引起的，用 `--baseline=7d`（或 `1d`）对比，看「新增接口 / 消失接口 / 变化最大的接口」三张表。
6. 报告里标红的是错误数 >0 或最低成功率 <100%；标黄的是平均耗时超 `--slow-ms`。
