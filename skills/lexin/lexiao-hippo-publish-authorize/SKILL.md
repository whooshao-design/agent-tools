---
name: lexiao-hippo-publish-authorize
description: 在乐效需求/版本里登记「hippo 发布授权」，标记本次发布需要一并发布哪些应用的 hippo namespace，并回读校验登记结果。Use when 用户要求在乐效版本里标记需要发布的 hippo、配置 hippo 发布授权、查看某需求已登记哪些 hippo namespace，或在发版前核对配置发布清单是否遗漏应用。
metadata:
  version: 1.1.0
---

# lexiao-hippo-publish-authorize

## 定位

管理乐效（lexiao）需求/版本上的 **hippo 发布授权登记**：声明本次发布需要连带发布哪些应用的 hippo
namespace。它只写"登记"这一层元数据，**不修改配置值、不发布配置、不部署应用**。

与相邻 skill 的边界：

- 改 Hippo 配置值、新建 namespace、按 key 发布 → `configure-hippo`
- 只读查询 Hippo 实际生效值 → `query-hippo-config`
- 构建与部署应用 → `lexiao-deploy`

**登记 ≠ 已发布。** 登记只是让版本知道"这些 namespace 要发"，配置真正生效仍需 `configure-hippo`
执行发布，或由发布流程在放量时执行。两者都做完，运行期才读得到值。

## 接口

| 动作 | 方法 | 端点 |
|---|---|---|
| 查询已登记 | GET | `/oa/lexiao/get_hippo_publish_authorize_list.json?demand_id=<id>&limit=200` |
| 新增登记 | POST | `/oa/lexiao/add_hippo_publish_authorize.json` |

基址 `https://lexiao-api.oa.fenqile.com`。POST 请求体：

```json
{"app_namespace_list":[{
  "demand_id": 1423729,
  "resource_id": "server_hawk_decision_manage",
  "resource_name": "server_hawk_decision_manage",
  "resource_instance": "encryption",
  "instance_type": "1",
  "resource_type": "hippo"
}]}
```

`resource_id` 与 `resource_name` 都填应用名；`resource_instance` 是 namespace 名。
一次可提交多条。**删除登记的端点尚未验证，不要凭猜测调用。**

## 用法

```bash
# 查看某需求已登记哪些
node /home/joney/projects/ai/agent-tools/skills/lexin/lexiao-hippo-publish-authorize/scripts/lexiao_hippo_authorize.js \
  list --demand-id=1423729

# 登记（只提交尚未登记的，写入后自动回读校验）
node /home/joney/projects/ai/agent-tools/skills/lexin/lexiao-hippo-publish-authorize/scripts/lexiao_hippo_authorize.js \
  add --demand-id=1423729 --namespace=encryption \
      --apps=server_hawk_decision_manage,process-engine-console-java
```

参数：`--demand-id`（正整数，必填）、`--apps`（add 必填，逗号分隔）、`--namespace`（add 必须显式指定，不使用默认值）、
`--instance-type`（仅支持 `1`）、`--resource-type`（仅支持 `hippo`）、`--profile`（默认
`/home/joney/.cache/lexiao-browser-profile`）、`--page-url`（默认乐效首页）。

## 强制约束

- **不经手原始 Cookie。** 复用浏览器 profile 的登录态，在页面上下文内
  `fetch(credentials:'include')` 发请求。不要把用户贴来的 `oa_token_id`、`oa_session` 等
  凭据写进命令行、脚本或聊天内容；用户提供 curl 时只取端点与请求体结构。
- **写入前先查。** 先 `list` 拿到已登记集合，只提交缺失项，避免重复写入。
- **写入后必须回读做集合比对。** POST 返回 200 且回显了请求内容，**不代表已落库**；
  必须重新 `list` 并逐项比对，确认"缺失 0"。脚本已内置，`verified=false` 时退出码非 0。
- **响应不得截断。** 完整读取响应体再解析；`slice`/`head`/`tail` 截断会切断 JSON，
  导致解析失败或误判成功。
- 登记范围必须是用户已授权的应用与 namespace 集合，并用本次需求的配置执行记录核对遗漏。
  发现额外候选只报告差集，不因“宁可多登记”扩大后续发布范围；仅存在 namespace 或代码引用不足以证明本次需要发布。
- 查询失败、登录 HTML、异常响应或达到 200 条上限时停止，不能当作空集合继续新增。

## 确定登记范围

先弄清本次需求在目标 namespace 下建了配置的应用全集，再登记。可靠来源按优先级：

1. 需求的 hippo 配置执行记录（若前序步骤留了 evidence 文件）
2. `query-hippo-config` 按 namespace 反查各应用是否存在该 namespace
3. 代码侧：搜索 `@HippoConfigProperty(namespace = "<ns>"` 的消费方，并核对传递依赖消费方

不要只按"这次要发布哪几个应用"来登记——同一需求分批发布时，批次是应用发布节奏，
而版本级的 hippo 登记覆盖整个需求。

## 失败处理

- `URI不存在或者未绑定域名`（retcode 30281040）：端点名写错，核对本文档中的端点。
- 返回 HTML 登录页或鉴权错误：用 `get-browser-session` 检查同一 profile。成功响应里的空 `result_rows` 可以是正常空集合，不能据此认定登录失效。
- `verified=false`：POST 成功但回读不到，**停止并人工核对**，不要重复提交。
