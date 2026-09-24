---
name: inspect-healthy-metrics
description: 只读查看 Healthy/雷神/Nightingale 指标上报状态。Use when 用户要求确认指标是否有数据、最近是否正常上报、批量检查 stable 或线上指标、按 metric 列表或 app+suffix 展开查询 Prometheus 样本、区分未注册/无数据/已过期/正常上报。
metadata:
  version: 1.1.2
---

# inspect-healthy-metrics

## 定位

只读检查 Healthy/雷神/Nightingale 指标的 Prometheus 上报状态：查询当前 series、窗口内样本数、最近样本时间和值，并可选回查指标注册表。它不注册指标、不修改已有指标元信息、不改告警规则或大盘。

和相邻 skill 的边界：

- `register-healthy-metrics`：用于 `/api/n9e/metric-manage` 的先查后注册；不判断时序数据是否上报。
- `inspect-healthy-metrics`：用于 Prometheus 数据检查；只读，可选检查注册表辅助判断。
- `healthy-dashboard-config`：用于大盘配置，不用于单指标上报排查。

MCP 优先、脚本兜底：批量 PromQL 使用 `healthy_query_metrics`，指标注册状态和新鲜度分类用下文正式脚本。旧 MCP 进程需重启才能加载新增入口，期间直接调用正式脚本；不要复制临时 Node/Python/curl 客户端。
登录态失效时复用 `get-browser-session` 刷新同一 profile；默认使用持久的 `/home/joney/.local/state/agent-tools/browser-profiles/healthy`，不要每次新建 profile。

## 环境

默认域名：

- `stable`、`test`、`测试` -> `https://stable-eye.oa.fenqile.com`
- `prod`、`online`、`线上`、`生产` -> `https://healthy.lexincloud.com`

接口：

```text
POST /api/n9e/prometheus/api/v1/query
POST /api/n9e/prometheus/api/v1/query_range
POST /api/n9e/query-range-batch
GET  /api/n9e/metric-manage?query=<metric>&exporter_type=&p=1&limit=15
```

认证来源优先级：

1. `--token` 参数。
2. 环境变量 `HEALTHY_METRIC_TOKEN`。
3. `--profile` 指定的浏览器 profile 中 Healthy 页面 `localStorage.access_token`。

请求头固定包含 `X-Cluster: Default`、`X-Language: zh`，必要时自动带 `Authorization: Bearer <token>` 和 `ticket`，但最终回复不输出这些敏感值。
浏览器模式只读取精确键 `access_token`，不能按 `token` 模糊匹配，否则可能误用 `refresh_token` 导致 401。与大盘脚本共用会话锁、直连策略和页面 fetch；一批查询只启动一次浏览器，同一 profile 的任务串行。

## 推荐脚本

脚本路径：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/inspect-healthy-metrics/scripts/inspect_metrics.js
```

离线展开指标，不访问接口：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/inspect-healthy-metrics/scripts/inspect_metrics.js \
  --env stable \
  --apps server_hawk_decision_dispatcher,server_hawk_decision_dispatcher_ec \
  --suffixes dubbo_active_count,dubbo_pool_size \
  --plan-only
```

检查指定指标：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/inspect-healthy-metrics/scripts/inspect_metrics.js \
  --env stable \
  --metrics fql_fk_server_hawk_decision_dispatcher_dubbo_active_count \
  --range 30m \
  --lookback 2h \
  --freshness 10m \
  --profile /home/joney/.local/state/agent-tools/browser-profiles/healthy \
  --check-registry
```

按应用和 suffix 批量展开：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/inspect-healthy-metrics/scripts/inspect_metrics.js \
  --env stable \
  --apps server_hawk_decision_dispatcher,server_hawk_decision_dispatcher_ec,server_hawk_decision_dispatcher_batch,server_hawk_decision_dispatcher_simulate \
  --suffixes dubbo_active_count,dubbo_pool_size,dubbo_queue_size,dubbo_queue_remaining_capacity \
  --range 30m \
  --lookback 2h \
  --freshness 10m \
  --profile /home/joney/.local/state/agent-tools/browser-profiles/healthy \
  --check-registry
```

直接执行 PromQL：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/inspect-healthy-metrics/scripts/inspect_metrics.js \
  --env prod \
  --profile /home/joney/.local/state/agent-tools/browser-profiles/healthy \
  --promql 'count(up)'
```

批量查询（`env` 是站点，预发布使用 prod；`expr` 内的标签筛选才是数据环境）：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/inspect-healthy-metrics/scripts/inspect_metrics.js \
  --env=prod --queries-json='[{"name":"预发布实例数","expr":"count(up{env=\"pre\"})"}]' \
  --query-type=range --range=30m --step=60s --output=/tmp/healthy-query-results.json
```

查询数据多时传 `--queries-file=<JSON 文件>`，内容为 `[{"name":"说明","expr":"PromQL"}]`。
range 整批调用一次 `query-range-batch`；instant 在同一会话内查询。`--start/--end` 支持 Unix 秒回查历史窗口。
`--output` 保存完整 JSON，终端输出每条 series 的首末样本和点数；目标文件存在时拒绝覆盖。查询 JSON 和结果可以保留，不需要为每个场景编写脚本。
响应错误或批次结果缺项按查询失败处理，不能解释成无数据。

## 参数口径

- `--metrics`：逗号或换行分隔的指标名。
- `--metrics-file`：JSON 数组，或 `{"metrics":[...]}`；元素可以是字符串或 `{"metric":"..."}`。
- `--apps` + `--suffixes`：展开为 `fql_fk_${app}_${suffix}`。
- `--range`：统计窗口，默认 `30m`，用于 `range_series` 和 `range_samples`。
- `--lookback`：回看窗口，默认 `2h`，用于查找最后样本。
- `--freshness`：新鲜度阈值，默认 `10m`。
- `--step`：range query 步长，默认 `60s`。
- `--check-registry`：同时查询指标注册表，区分未注册和无数据。
- `--format json`：输出完整 JSON；默认输出 TSV 表格。
- `--queries-json/--queries-file`：批量任意 PromQL，`--query-type=instant|range`，默认 range。
- `--output`：保存完整查询数据并返回文件位置；MCP 自动在 `/tmp/agent-work/healthy-metrics/` 下建独立结果目录，保留 24 小时后由下次调用清理，需要长期保留的结果要及时移走。

## 多 series 陷阱（查聚合值时必读）

同一个逻辑指标在同一业务维度下，会**按上报实例拆成多条 series** —— 雷神/categraf 会自动附加
`ident`（实例 IP）、`origins`（kvm/k8s）、`env`、`prometheus_agent` 等 label。
多实例轮询上报时，每条 series 只承载自己那一份数据。

因此：

- **取聚合值必须在外层加 `sum()`**：`sum(sum_over_time(m[60m]))`、`sum(count_over_time(m[60m]))`。
  不加 `sum()` 时 Prometheus 返回多条 series，只读第一条就只是**单台机器**的数据。
- 判断上报是否完整看 `sum(count_over_time(m[<窗口>]))`，不要看单条 series 的点数。
  例：5 个实例每 4 分钟轮流上报一次，单条 series 一小时只有 12~18 个点，
  但 `sum(...)` 是 60，即每分钟一个点，上报完全正常。
- 脚本的 `range_samples` 已经是 `sum(count_over_time(...))`，`range_series` 是 `count(...)`，
  两者含义不同：前者是样本总数，后者是 series 条数。
- 样本数不等于独立业务请求数；指标名带 counter 也不保证是累计计数器。先确认埋点口径，再选择 `rate/increase` 或汇总方式。
- `--promql` 自由查询时脚本会输出 `series_count`；返回多条时附带 `multi_series_warning`，
  里面列出发生分裂的 label 和聚合建议。看到这个警告就说明当前查询没有聚合，结论不可直接采信。
- 直接用 curl 打 `healthy.lexincloud.com/api/n9e/prometheus/api/v1/query` 时，
  必须带 `X-Cluster: Default` 请求头，否则返回 `X-Cluster missed`。

排查「上报频率不足 / 数据缺失」前，先确认这一层，再去查 job 调度或耗时。

## 状态判断

每个指标输出：

```text
status metric registered current_series range_series range_samples lookback_series last_sample_time age last_value registry_ids error
```

状态含义：

- `OK`：当前有 series，或最后样本时间在 `--freshness` 内。
- `STALE`：`--lookback` 内有样本，但最后样本已经超过 `--freshness`。
- `MISSING`：`--lookback` 内没有样本。
- `registered=false`：开启 `--check-registry` 且注册表没有该指标；`status` 仍按样本判定，未注册不等于没上报（fsof 等指标本来就不在注册表里）。
- `QUERY_ERROR`：Prometheus 或注册表查询失败。

最终回复给用户时，按应用或指标分组汇总 `OK/STALE/MISSING` 数量并单列 `registered=false` 的指标，列出异常指标和最后样本时间；不要粘贴 token、ticket、Cookie 或完整登录跳转参数。

## 执行流程

1. 明确环境、指标来源、检查窗口和新鲜度阈值。
2. 先用 `--plan-only` 展开指标，确认没有拼错。
3. 如需区分未注册，加入 `--check-registry`。
4. 如果脚本提示没有登录态，用 `get-browser-session` 对同一 `--profile` 刷新 Healthy 登录。
5. 运行脚本并汇总结果；只读查询不需要用户额外确认。
