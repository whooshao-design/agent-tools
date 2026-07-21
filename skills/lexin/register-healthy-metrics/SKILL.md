---
name: register-healthy-metrics
description: 注册、查询和复查 Healthy/雷神/Nightingale 指标。Use when 用户要求检查雷神指标是否存在、批量注册 stable 或线上雷神指标、按 metric 列表或应用维度展开指标清单、调用 /api/n9e/metric-manage 做先查后注册、或确认指标注册中的 desc/app/business_line 填写规则。
metadata:
  version: 1.0.0
---

# register-healthy-metrics

## 定位

用于 Healthy/雷神/Nightingale 指标管理的幂等注册：先查询指标是否存在，再按需注册，最后复查结果。它处理 `/api/n9e/metric-manage` 的字段口径、认证复用和批量展开；不负责修改告警规则、大盘面板，也不自动编辑或删除已有指标。

优先使用本 skill 的脚本，避免临时拼 curl、临时写 Python/Perl/Node 片段，降低认证、重定向、JSON 解析和延迟复查出错概率。登录态失效时复用 `get-browser-session` skill 刷新浏览器 profile，不要让用户在聊天中提供密码、验证码、Cookie 或 token。

## 核心字段

注册 body 固定包含：

```json
{
  "metric": "<目标指标名>",
  "desc": "<指标描述>",
  "business_line": "风控研发中心",
  "app": "<来源应用>",
  "enable": true
}
```

字段规则：

- `business_line` 固定填 `风控研发中心`。
- `metric` 来自用户明确提供，或由 `--apps` 和 `--suffixes` 展开。
- `app` 默认从指标名解析：`metric = fql_fk_${source_app}_${suffix}`，则 `app = ${source_app}`。用户显式提供单指标 `app` 时才覆盖。
- `desc` 优先级：用户显式提供；当前会话或代码中已确认的描述；已有可靠注册记录；最后按 `app + suffix` 映射生成。
- 发现已有指标的 `app` 或 `desc` 与当前规则不一致时，只输出 `EXISTS_MISMATCH`，不要自动修改。修正已有指标元信息必须单独确认。

## 环境

环境域名：

- `stable`、`test`、`测试` -> `https://stable-eye.oa.fenqile.com`
- `prod`、`online`、`线上`、`生产` -> `https://eye.oa.fenqile.com`

请求头固定包含：

```text
Authorization: Bearer <access_token>
X-Cluster: Default
X-Language: zh
Content-Type: application/json;charset=UTF-8
```

认证来源优先级：

1. 脚本参数 `--token`。
2. 环境变量 `HEALTHY_METRIC_TOKEN`。
3. `--profile` 指定的浏览器 profile 中 Healthy 页面 `localStorage.access_token`。

如果没有可用认证，先使用 `get-browser-session` 让用户完成登录，再复用同一个 profile 调脚本。

## 推荐脚本

脚本路径：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/register-healthy-metrics/scripts/register_metrics.js
```

离线展开和字段预览，不访问接口：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/register-healthy-metrics/scripts/register_metrics.js \
  --env stable \
  --apps server_hawk_decision_dispatcher,server_hawk_decision_dispatcher_ec \
  --suffixes dubbo_active_count,dubbo_pool_size,dubbo_queue_size,dubbo_queue_remaining_capacity \
  --plan-only
```

dry-run 查询，不写入：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/register-healthy-metrics/scripts/register_metrics.js \
  --env stable \
  --metrics fql_fk_server_hawk_decision_dispatcher_ec_dubbo_active_count \
  --token "$HEALTHY_METRIC_TOKEN"
```

实际注册并复查：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/register-healthy-metrics/scripts/register_metrics.js \
  --env prod \
  --apps server_hawk_decision_dispatcher,server_hawk_decision_dispatcher_ec,server_hawk_decision_dispatcher_batch,server_hawk_decision_dispatcher_simulate \
  --suffixes dubbo_active_count,dubbo_pool_size,dubbo_queue_size,dubbo_queue_remaining_capacity \
  --profile /tmp/healthy-metrics-profile \
  --apply
```

## 描述推断

脚本内置 dispatcher 常用应用中文名：

```text
server_hawk_decision_dispatcher          -> 米霍克dispatcher主应用
server_hawk_decision_dispatcher_ec       -> 米霍克dispatcher EC应用
server_hawk_decision_dispatcher_batch    -> 米霍克dispatcher批跑应用
server_hawk_decision_dispatcher_simulate -> 米霍克dispatcher仿真应用
```

脚本内置 Dubbo 线程池 suffix：

```text
dubbo_active_count                   -> 活跃线程数
dubbo_pool_size                      -> 当前线程数
dubbo_queue_size                     -> 队列大小
dubbo_queue_remaining_capacity       -> 队列剩余容量
```

兜底格式：

```text
${应用中文名或app}Dubbo线程池${指标含义}
```

如果会话或代码中已有更准确描述，创建一个 JSON 映射文件传给脚本，不要改脚本：

```json
{
  "fql_fk_xxx_dubbo_active_count": "明确描述",
  "server_hawk_decision_dispatcher_ec:dubbo_active_count": "按 app+suffix 覆盖",
  "dubbo_queue_size": "按 suffix 覆盖"
}
```

使用方式：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/register-healthy-metrics/scripts/register_metrics.js \
  --env stable \
  --metrics-file /tmp/metrics.json \
  --desc-map /tmp/desc-map.json \
  --apply
```

## 执行流程

1. 明确环境、目标指标、是否允许写入。
2. 用 `--plan-only` 预览 `metric/app/desc/business_line/enable`，确认字段口径。
3. dry-run 查询接口，检查已存在、缺失、元信息不一致。
4. 用户明确要注册时加 `--apply`。
5. 注册后脚本自动延迟复查；最终输出 `FOUND`、`SKIP_EXISTS`、`PLAN_REGISTER`、`REGISTER_OK`、`VERIFY_FOUND`、`VERIFY_MISSING`、`EXISTS_MISMATCH`。
6. 最终回复只汇总结果，不输出 token、ticket、Cookie 或完整登录跳转参数。
