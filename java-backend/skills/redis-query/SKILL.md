---
name: redis-query
description: "通过 bianque 服务模拟器调用 DevService.queryRedis 进行 Redis 只读查询。适用于用户要求查询 Redis key 是否存在、类型、TTL、数量、STRING/SET/HASH/LIST/ZSET 值、Hash 指定 field 或批量排查 Redis key 来源和值时使用。"
version: 1.0.0
---

# redis-query

## 核心约束

- 只执行只读查询，不执行 Redis 增删改、过期时间修改、脚本写入或任何会改变数据的操作。
- 默认通过 bianque 服务模拟器调用兼容 `queryRedis(instanceName, key, fields, fetchData)` 签名的只读 Dubbo 服务；不要直连 Redis，也不要使用 `redis-cli` 猜测连接信息。
- 拉取全量数据前先用 `fetchData=false` 查询类型、TTL 和 size。`size > 5000` 时先提示用户数据量较大，建议只看 size 或缩小范围。
- Cookie、目标环境、Redis 实例名、key、Hash fields 不明确时，先从上下文推断；推断风险较高时再问用户。
- 不在最终回复中输出 Cookie、完整敏感值或大段原始数据；只展示与问题相关的摘要和值片段。

## 默认环境

| 环境 | bianque URL | env 参数 | 目标 IP:Port |
| --- | --- | --- | --- |
| stable | `https://stable-bianque.lexinfintech.com` | `prj` | 从 `targets.json` 或用户输入读取 |
| pre | `https://bianque.lexinfintech.com` | `pre` | 从 `targets.json` 或用户输入读取 |

默认 IP:Port 来自 `~/.codex/skills/test-dubbo-api/targets.json` 中用户指定的应用条目。不要把某个业务应用作为通用默认；如果用户给了新的 IP/Port，以用户指定为准。

## Dubbo 接口

- `interface`: 从用户上下文、代码配置或接口列表中确认，要求暴露 `queryRedis`
- `method`: `queryRedis`
- `group`: `default`
- `version`: `2.0.0`
- 参数数组：`[instanceName, key, fields, fetchData]`
- `instanceName`: Redis 实例名，空串 `""` 表示默认实例。
- `key`: Redis key，必填。
- `fields`: Hash 指定 field 列表；空列表 `[]` 表示 Hash 全量 field。非 Hash 类型忽略。
- `fetchData`: `false` 仅返回类型、存在性、TTL、size；`true` 返回数据值。

返回结果字段：

- `type`: `STRING` / `SET` / `HASH` / `LIST` / `ZSET` / `NONE`
- `exists`: key 是否存在
- `ttl`: 秒数，`-1` 表示无过期，`-2` 表示 key 不存在
- `size`: STRING 长度、SET 成员数、HASH field 数、LIST 长度、ZSET 成员数
- `stringValue` / `setMembers` / `hashFields` / `listElements` / `zsetMembers`: `fetchData=true` 时按类型返回

## Redis 实例名

实例名由目标服务的 `queryRedis` 实现决定。空串 `""` 表示该服务的默认实例；其他实例名必须来自用户、代码配置或已有上下文，不要猜测。

## 查询流程

1. 确认环境：用户未指定时，根据上下文选择 `pre` 或 `stable`；线上/prod Redis 不通过此默认表猜测，必须让用户给出可用 bianque 环境和服务实例。
2. 确认 `instanceName`、`key`、`fields` 和是否需要拉取值。
3. 先执行轻量查询：`fetchData=false`。
4. 若只需要存在性、类型、TTL、数量，直接汇总结果。
5. 若需要数据值且 size 可控，再执行 `fetchData=true`；Hash 指定 field 时传入 field 列表。
6. 汇总时说明环境、实例名、key、type、exists、ttl、size，以及必要的数据摘要。

## 调用模板

优先复用 `test-dubbo-api` 的固定脚本：

```bash
python3 /home/joney/.codex/skills/test-dubbo-api/scripts/dubbo_request.py \
  --env stable \
  --service '<DEV_SERVICE>' \
  --method queryRedis \
  --app '<APP_NAME>' \
  --group default \
  --version 2.0.0 \
  --params '["<INSTANCE_NAME>","<KEY>",<FIELDS_LIST>,<FETCH_DATA>]'
```

目标地址也可以直接传 `--ip '<IP>' --port '<PORT>'`。

手工 curl 仅作为脚本不可用时的备用：

构造参数：

```bash
PARAMS=$(python3 -c 'import json, urllib.parse; print(urllib.parse.quote(json.dumps(["<INSTANCE_NAME>", "<KEY>", <FIELDS_LIST>, <FETCH_DATA>])))')
```

调用 bianque：

```bash
curl -s --max-time 60 '<BASE_URL>/serviceEmulator/request' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -b '<COOKIE>' \
  -H 'Origin: <BASE_URL>' \
  -H 'Referer: <BASE_URL>/' \
  --data-raw 'env=<ENV>&service=<DEV_SERVICE>&ip=<IP>&port=<PORT>&group=default&version=2.0.0&method=queryRedis&params='"$PARAMS"'&comment=&stringFlag=false'
```

需要格式化时追加：

```bash
| python3 -m json.tool
```

## 常见模式

查 key 类型、TTL、数量：

```text
instanceName = ""
fields = []
fetchData = false
```

查 STRING 值：

```text
instanceName = ""
fields = []
fetchData = true
```

查 HASH 指定 field：

```text
instanceName = "<INSTANCE_NAME>"
fields = ["field1", "field2"]
fetchData = true
```

查 SET/HASH 全量：

```text
先 fetchData=false 看 size；size 可控后 fields=[] 且 fetchData=true。
```

## Cookie 获取

如果请求返回登录态失效或权限错误，优先复用 `test-dubbo-api/scripts/dubbo_request.py` 的自动登录态获取能力；只有自动方式不可用时，才让用户在浏览器里重新登录对应 bianque 页面。不要在聊天中索要或输出完整 Cookie。
