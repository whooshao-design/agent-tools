---
name: query-dubbo-registry
description: 通过服务名查提供它的应用名，以及 Dubbo/FSOF 注册中心的其他只读查询。Use when 用户只知道 service 全限定名或短名要找是哪个应用提供的、要查谁在消费某个服务、要列出某个应用注册了哪些服务、要拿服务提供者的实例地址和 version/group，或者在代码仓库里搜不到接口需要先定位应用。
metadata:
  version: 1.1.0
---

# query-dubbo-registry

## 定位

只读查询 bianque 服务治理平台的 Dubbo/FSOF **注册中心**，回答四类问题：

1. **service → 提供方应用**（最常用）：只知道服务名，找是哪个应用提供的。
2. **service → 消费方应用**：谁注册成了这个服务的消费者。
3. **app → 注册的服务清单**：某个应用对外声明了哪些服务。
4. **提供者实例地址 + version/group**。

不做的事：不调用业务接口、不改注册信息、不做上下线摘除。

### 和相邻 skill 的边界

这条边界很关键，别用错数据源：

| 需求 | 用谁 | 为什么 |
|---|---|---|
| 这个服务是哪个应用提供的 | **本 skill** | 注册中心视角，零流量也查得到 |
| 这个接口实际被调了多少次 / 错误率 / 耗时 | `inspect-app-call-topology` | 指标视角，只反映有流量的 |
| 应用在各环境的 VM / 容器地址 | `query-app-instances` | 从乐效查部署实例，含未注册服务的机器 |
| 前端 URL 对应哪个后端接口 | `query-oa-gateway-interface` | 从 OA 网关规则出发 |
| 调用这个 Dubbo 接口做测试 | `test-dubbo-api` | 本 skill 只查不调 |

**注册中心 ≠ 实际流量**：注册中心列出应用**声明**的服务，`inspect-app-call-topology` 基于监控指标列出**实际有流量**的接口。实测 `server_strategy_decision_java` 注册了 7 个服务，最近 1 天只有 1 个有流量。两者互补，回答"有没有人在用"要看指标，回答"应该由谁提供"要看注册中心。

登录态复用 `test-dubbo-api` 的浏览器 profile 约定，不在会话里索要密码、验证码、Cookie 或 token。

## 用法

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/query-dubbo-registry/scripts/query_dubbo_registry.js \
  --service=com.fenqile.credit.ser.deploy.service.IPDirectoryTablesService
```

服务名支持短名模糊匹配，不用给全限定名：

```bash
node .../query_dubbo_registry.js --service=ExpressRuleRunnerService --instances
```

查谁在消费、查应用注册了哪些服务：

```bash
node .../query_dubbo_registry.js --service=ExpressRuleRunnerService --role=consumer
node .../query_dubbo_registry.js --app=server_strategy_decision_java
```

批量解析归属，供其他脚本消费（输出含 `ownerMap` 与 `completeness{total,fetched,truncated}`；脚本按 `total` 翻页，`truncated=true` 时不得声称服务清单或归属候选完整）：

```bash
node .../query_dubbo_registry.js --services=com.a.FooService,com.b.BarService --format=json
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--service` | — | 服务名，支持短名模糊匹配 |
| `--services` | — | 逗号分隔的多个服务名，批量查询 |
| `--app` | — | 按应用名反查它注册的服务 |
| `--role` | `provider` | `provider` / `consumer` |
| `--site` | `pre` | `pre`/`prod`/`online`/`gray` 共用 `bianque.lexinfintech.com`；`stable`/`test` 走 `stable-bianque` |
| `--instances` | — | 输出提供者实例地址明细 |
| `--format` | `table` | `table` / `json` |
| `--page-size` | `200` | 单次查询条数 |
| `--concurrency` | `4` | 批量查询并发数 |
| `--cookie` | — | 也可用环境变量 `BIANQUE_COOKIE` |
| `--profile` | — | 取 `BROWSER_SESSION_PROFILE` / `DEVTOOLS_BROWSER_PROFILE` / `~/.local/state/agent-tools/browser-profiles/main` |
| `--http-timeout` | `30000` | 单次请求超时毫秒 |
| `--retries` | `2` | 可重试错误的重试次数 |

## 接口

```text
GET /governance/services/list
    ?name=<服务名>&ip=&port=&appName=<应用名>&version=&group=
    &catogory=provider|consumer&pageIndex=1&pageSize=200
```

返回 `data.list[]`，每条含 `application`、`serviceName`、`version`、`group`、`ip`（`ip:port`）。

## 口径要点

1. **`catogory` 是平台接口本身的拼写错误**，必须照抄，写成 `category` 查不到任何结果。

2. **`consumer` 类目的 `application` 是逗号拼接的多个应用**，例如
   `server_post_loan_manage,server_rc_realtime_operation`，必须按逗号拆开，否则会当成一个不存在的应用名。
   `provider` 类目是单个应用。

3. **`name` 是模糊匹配**。传短名（`ExpressRuleRunnerService`）能命中全限定名，但也可能命中同名的其他包路径下的服务，
   结果多于一条时要按全限定名核对，不要默认取第一条。

4. **注册中心只说明"声明了什么"，不说明"有没有流量"**。要判断接口是否还在被使用，必须配合
   `inspect-app-call-topology` 看监控指标。

5. **登录态失效时平台返回登录页 HTML 而不是 JSON**，脚本会明确报"登录态失效"，
   这时用 `get-browser-session` 刷新 profile，不要让用户在聊天里贴 Cookie。

6. **同一个 service 可能有多个提供方应用**（分机构、分环境独立部署），这时如实列出全部候选，
   不要挑一个当作唯一答案。

## 被谁复用

- `inspect-app-call-topology`：监控指标查不到某个下游 service 的归属应用时，兜底调用本 skill 的脚本
  （`--services=... --format=json`）补全，结果在报告里标注「注册中心」以区分数据来源。
- `query-oa-gateway-interface`：网关规则给出 `interface_name` 但本地仓库搜不到实现时，用本 skill 定位真实后端应用，
  再切到对应仓库继续追代码。
