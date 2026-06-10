---
name: healthy-dashboard-config
description: "配置 Healthy/雷神/Nightingale 监控大盘时使用：读取和更新 /api/n9e/board/{id}/configs，配置大盘变量、Prometheus 面板、穿透加载监控指标，并复用本地浏览器登录态完成回读校验。"
version: 1.0.0
---

# healthy-dashboard-config

## 工具优先级

已注册 `healthy` MCP 时，优先使用其工具完成本 skill 的查询与操作；MCP 不可用或未注册时，再按下文的脚本/HTTP 方式兜底。两者底层能力一致。


## 适用场景

用户要求配置 Healthy/雷神大盘、修改 dashboard configs、添加大盘变量、添加 Prometheus 面板、排查大盘 API 写入格式或复用已登录 Healthy 页面时使用。

## 核心约束

- 复用 `get-browser-session` 获取 Healthy 登录态，默认 profile：`/tmp/healthy-dashboard-profile`。
- 不在回复、skill 或脚本输出中暴露完整 `Authorization`、`ticket`、Cookie。
- 修改前必须回读并备份原始大盘配置；修改后必须再次回读确认。
- Healthy 写入 configs 的 body 必须是 `{"configs":"<config JSON string>"}`，不能直接传对象。
- 写入前保留原有 `var`、`panels` 中不相关内容，只做目标变量/面板的增量替换或追加。

## API 要点

基础地址：

```text
https://healthy.lexincloud.com
```

常用 API：

```text
GET /api/n9e/board/{id}
PUT /api/n9e/board/{id}/configs
POST /api/n9e/prometheus/api/v1/query
POST /api/n9e/query-range-batch
```

关键 header：

```text
Authorization: Bearer <localStorage access_token>
X-Cluster: Default
X-Language: zh
Content-Type: application/json;charset=UTF-8
```

## 推荐流程

1. 用 `get-browser-session` 确认 Healthy 页面已登录；未登录则让用户在浏览器完成登录。
2. 用脚本回读大盘，备份到 `/tmp/healthy-dashboard-{boardId}-before.json`。
3. 更新变量和面板，PUT 到 `/api/n9e/board/{id}/configs`。
4. 回读校验 `PUT 200`、`err` 为空、变量数和面板数符合预期。
5. 必要时用 `query-range-batch` 或页面截图确认 PromQL 可查到数据。

## 辅助脚本

优先使用本 skill 的脚本，避免手写 token、字符串转义和 configs 包装：

```bash
node /home/joney/projects/ai/agent-tools/skills/observability/healthy-dashboard-config/scripts/healthy_dashboard_config.js \
  --board=16761 \
  --mode=hawk-read-through \
  --profile=/tmp/healthy-dashboard-profile \
  --apply
```

只回读和备份：

```bash
node /home/joney/projects/ai/agent-tools/skills/observability/healthy-dashboard-config/scripts/healthy_dashboard_config.js \
  --board=16761 \
  --profile=/tmp/healthy-dashboard-profile \
  --read
```

## 登录态失效处理

如果脚本提示没有取到 `access_token`、页面是 SSO/登录页，或 Healthy API 返回 401/403，直接使用 `get-browser-session` skill 刷新同一个 profile，不要在本 skill 里重复登录流程，也不要让用户在聊天里提供 token、Cookie 或验证码。

传给 `get-browser-session` 的关键参数：

```text
url=https://healthy.lexincloud.com/dashboards/{boardId}
profile=/tmp/healthy-dashboard-profile
success-text=none 或 Healthy 页面上的稳定文案
```

登录态刷新后，先用本 skill 脚本执行 `--read` 回读确认，再执行 `--apply`。

## 穿透加载监控模板

本次已沉淀的大盘：

```text
url: https://healthy.lexincloud.com/dashboards/16761
name: 穿透加载监控
group_id: 88
screen_id: 20000000881
```

变量模板：

```json
[
  {
    "name": "app",
    "type": "textbox",
    "definition": "",
    "effect": "default",
    "datasource": {"cate": "prometheus"},
    "defaultValue": "server-hawk-decision-executor-simulate"
  },
  {
    "name": "env",
    "type": "query",
    "definition": "label_values(old_gen_mem_used{app=\"$app\"},env)",
    "effect": "default",
    "datasource": {"cate": "prometheus"},
    "defaultValue": "prod"
  },
  {
    "name": "ip",
    "type": "query",
    "definition": "label_values(old_gen_mem_used{app=\"$app\",env=\"$env\"},ident)",
    "effect": "default",
    "datasource": {"cate": "prometheus"},
    "multi": true,
    "allOption": true,
    "allValue": ".*",
    "defaultValue": ["all"]
  }
]
```

PromQL 通用过滤：

```promql
app="$app",env="$env",ident=~"$ip"
```

核心面板 PromQL：

```promql
sum by (app,module,method,entry) (fql_fk_hawk_executor_snapshot_read_through_counter{app="$app",env="$env",ident=~"$ip",outcome="failed",failureType="waitTimeout"})
sum by (app,module,method,failureType) (fql_fk_hawk_executor_snapshot_read_through_counter{app="$app",env="$env",ident=~"$ip",outcome="failed"})
sum by (app,method,failureType) (fql_fk_hawk_executor_snapshot_read_through_counter{app="$app",env="$env",ident=~"$ip",module="online",method=~"package|commonNode",outcome="failed"})
sum by (app,module,method,action,outcome) (fql_fk_hawk_executor_snapshot_read_through_counter{app="$app",env="$env",ident=~"$ip"})
avg by (app,module,method,action,outcome) (fql_fk_hawk_executor_snapshot_read_through_average{app="$app",env="$env",ident=~"$ip",stage="total"})
avg by (app,method) (fql_fk_hawk_executor_snapshotLoad_average{app="$app",env="$env",ident=~"$ip",module="runtime",stage="total"})
```

## 校验要点

- `GET /api/n9e/board/{id}` 能返回 `configs`，且 `configs` 可解析为 JSON。
- `PUT /api/n9e/board/{id}/configs` 返回 HTTP 200，响应里 `err` 为空或无错误字段。
- 回读后检查 `configs.var` 包含 `app/env/ip`，目标面板名称和 PromQL 存在。
- 不要把 `/tmp/healthy-dashboard-*.json` 备份提交到仓库。
