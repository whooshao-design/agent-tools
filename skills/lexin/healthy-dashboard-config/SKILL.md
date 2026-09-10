---
name: healthy-dashboard-config
description: "配置 Healthy/雷神/Nightingale 监控大盘时使用：读取和更新 /api/n9e/board/{id}/configs，配置大盘变量、Prometheus 面板、穿透加载监控指标，并复用本地浏览器登录态完成回读校验。"
metadata:
  version: 1.1.0
---

# healthy-dashboard-config

## 工具优先级

已注册 `healthy` MCP 时，优先使用其工具完成本 skill 的查询与操作；MCP 不可用或未注册时，再按下文的脚本/HTTP 方式兜底。两者底层能力一致。

| 任务 | 正式 MCP 入口 |
|---|---|
| 回读配置、备份、获取版本指纹 | `healthy_read_board(board_id, env, profile)` |
| 写入已授权的完整配置 | `healthy_update_board(board_id, configs, expected_configs_sha256, env, profile)` |
| 验证实际面板查询、变量选项和截图 | `healthy_verify_board(board_id, variables, env, profile)` |
| 批量查询面板 PromQL | `healthy_query_metrics(queries, env, query_type, range_window, step, profile)` |

`env=stable` 使用 stable 站点；`env=prod` 使用线上站点，预发布也选该站点并在变量/表达式中筛选 `pre`。
既有 MCP 进程没有新工具时，使用正式脚本兜底；重启 MCP 后加载新入口。不要为切站点、批量查询或自定义大盘复制临时客户端。

## 适用场景

用户要求配置 Healthy/雷神大盘、修改 dashboard configs、添加大盘变量、添加 Prometheus 面板、排查大盘 API 写入格式或复用已登录 Healthy 页面时使用。

## 核心约束

- 复用 `get-browser-session` 获取 Healthy 登录态，默认 profile：`/home/joney/.local/state/agent-tools/browser-profiles/healthy`。
- 不在回复、skill 或脚本输出中暴露完整 `Authorization`、`ticket`、Cookie。
- 修改前必须回读并备份原始大盘配置；修改后必须再次回读确认。
- Healthy 写入 configs 的 body 必须是 `{"configs":"<config JSON string>"}`，不能直接传对象。
- 写入前保留原有 `var`、`panels` 中不相关内容，只做目标变量/面板的增量替换或追加。
- 环境、实例 IP 等可从指标枚举的筛选项优先使用 `query` 类型和 `label_values(...)`，实例查询关联环境变量；仅有一个应用时将应用写入查询，不增加无意义的应用筛选项。
- 根据实际样本确认标签名及含义，不照搬 `app/application/instanceName`。业务与存活指标的 `env` 标签不一致时，不共用会误排除目标的环境条件；在面板说明中写明筛选范围。
- 修改变量后验证实际下拉选项、变量联动和页面发出的 PromQL，不能只看 configs 保存成功；变量名使用字母数字驼峰形式，避免部分版本无法替换带下划线的变量。
- 当前前端的 `query` 类型不使用 `defaultValue`。实际选择由 URL、浏览器保存值或首个选项决定；用 `variables` 指定目标并检查真实请求，不通过下载前端脚本反复确认。`textbox` 可使用 `defaultValue`。
- 一个任务复用一次浏览器会话；正式脚本共用 profile 锁和直连策略，同一 profile 的任务串行执行。

## API 要点

基础地址：

```text
https://healthy.lexincloud.com
https://stable-eye.oa.fenqile.com
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

1. 直接用正式入口回读；仅登录失效时复用 `get-browser-session`，不在每次调用前重复检查登录。
2. 回读结果包含完整 `configs`、`configsSha256` 和独立的 `/tmp/healthy-dashboard-{id}-*/` 备份目录。
3. 保留无关内容，提交目标 `configs` 和回读的指纹；配置冲突时重新回读合并，不覆盖他人的改动。
4. 工具在写入前再次回读检查，写后逐字段完整比较；相同目标不发 PUT。该检查不能替代服务端原子版本控制，应避免同时编辑。
5. 用 `healthy_verify_board` 指定变量，检查真实 PromQL、响应及截图；空数据需结合指标检查判断，不能等同于业务正常。

## 辅助脚本

优先使用本 skill 的脚本，避免手写 token、字符串转义和 configs 包装：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/healthy-dashboard-config/scripts/healthy_dashboard_config.js \
  --board=16761 \
  --mode=hawk-read-through \
  --profile=/home/joney/.local/state/agent-tools/browser-profiles/healthy \
  --apply
```

只回读和备份：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/healthy-dashboard-config/scripts/healthy_dashboard_config.js \
  --board=16761 \
  --profile=/home/joney/.local/state/agent-tools/browser-profiles/healthy \
  --read
```

通用写入：给正式脚本传 `--configs-file=<JSON 文件> --expected-sha256=<回读指纹> --apply`。
也可用 `--configs-json` 接收完整对象，MCP 自动结构化传递，不需要创建可执行脚本。

只读验证预发布页面：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/healthy-dashboard-config/scripts/healthy_dashboard_config.js \
  --board=17103 --env=prod --verify-page \
  --variables-json='{"env":["pre"],"ip":["all"]}'
```

输出包含下拉选项、实际查询及未替换变量检查结果；完整响应与截图放在 `backupDir`。
JSON 配置、查询条件和验证证据是数据文件，可保留用于复查；已被正式入口替代的临时 JS/Python 按用户授权清理。

## 登录态失效处理

正式客户端只读精确键 `access_token`，不能模糊匹配 `token`，更不能使用 `refresh_token` 充当 Bearer。
如果正式脚本提示没有取到 `access_token`、页面是 SSO/登录页，或 API 返回 401/403，使用 `get-browser-session` 刷新同一 profile；不要复制脚本改鉴权，也不要在聊天里索取凭据。

传给 `get-browser-session` 的关键参数：

```text
url=https://healthy.lexincloud.com/dashboards/{boardId}
profile=/home/joney/.local/state/agent-tools/browser-profiles/healthy
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
    "datasource": {"cate": "prometheus"}
  },
  {
    "name": "ip",
    "type": "query",
    "definition": "label_values(old_gen_mem_used{app=\"$app\",env=\"$env\"},ident)",
    "effect": "default",
    "datasource": {"cate": "prometheus"},
    "multi": true,
    "allOption": true,
    "allValue": ".*"
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
- 回读后检查 `configs.var` 与目标筛选项一致（单应用可无 `app`），目标面板名称和 PromQL 存在。
- 不要把 `/tmp/healthy-dashboard-*.json` 备份提交到仓库。
