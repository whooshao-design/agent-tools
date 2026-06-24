---
name: query-hippo-config
description: 通过 Hippo 配置中心只读查看应用配置和实际生效 release。Use when 用户要求查看 Hippo 配置、线上/预发/灰度/OA 配置、代码分支依赖的配置 key、应用默认配置、namespace 配置项，或需要根据代码里的 ConfigService/getAppConfig/@HippoConfigProperty 判断真实配置走向；默认环境为 prod/fql_prod，最终必须输出查询接口路径和配置结果。
version: 1.1.1
---

# query-hippo-config

## 定位

只读查看 Hippo 配置中心中的应用配置、namespace 配置项和实际生效 release，用于辅助判断代码中由 Hippo/Apollo 配置控制的运行分支。它不负责修改配置、发布配置、审批配置，也不替代代码阅读；它负责把代码里的 app/env/namespace/key 映射到 Hippo 当前实际值。

MCP 优先、浏览器手工操作兜底。优先使用 `browser_session` MCP 的 `check_session`、`fetch_with_session`、`browser_page_snapshot` 访问 `http://hippo.oa.fenqile.com/`；登录态不可用时使用 `get-browser-session` skill 刷新登录态，不要让用户在聊天中提供 Cookie、ticket、token 或密码。

## 核心约束

- 只执行只读 GET 请求。不要调用 POST、PUT、PATCH、DELETE，也不要在页面上点击保存、发布、删除、回滚等动作。
- 默认环境是 `prod`，映射为 Hippo env `fql_prod`。用户明确指定 `pre`、`gray`、`oa`、`fql_*` 时才切换。
- 最终回复必须同时输出本次查询的接口路径或 URL、配置结果，以及是否来自 active release。
- 判断运行时生效值时，优先查 `releases/active`；`items` 和 namespace 列表可用于查草稿差异、注释、修改人和页面展示，但不要把未发布 items 当成运行时生效值。
- 不要输出 Cookie、ticket、token、完整登录跳转 URL 中的敏感参数；引用 URL 时可省略一次性 ticket 参数。
- 如果用户只说“默认应用”，先从当前代码上下文或仓库 `app.properties` 的 `application.name` 推断；同一问题能匹配多个子工程时，先说明候选并询问，不要随意选择。

## 默认映射

环境映射：

- `prod`、`生产`、`线上` -> `fql_prod`
- `pre`、`预发` -> `fql_pre`
- `gray`、`灰度` -> `fql_gray`
- `oa` -> `fql_oa`
- 用户已给 `fql_prod` 这类完整 env 时直接使用。

应用推断：

- 优先使用用户给出的 appId 或应用名。
- 如果用户正在讨论某个代码文件，优先读该子工程 `src/main/resources/app.properties` 中的 `application.name`。
- Hawk 常见 appId 可由仓库里的 `app.properties` 推断，例如 `server_hawk_decision_executor`、`server_hawk_decision_manage`、`server_hawk_decision_dispatcher`、`server_hawk_decision_task`。
- 只知道业务模块而无法唯一映射 appId 时，先用 `/apps/list?appId=<keyword>` 搜索并向用户确认候选。

namespace/key 推断：

- `ConfigService.getAppConfig()`、`MtHippoConfigService.getAppConfig()`、没有显式 namespace 的 `@HippoConfigProperty` 默认查 `application`。
- `ConfigService.getConfig("<namespace>")` 或 `@HippoConfigProperty(namespace = ...)` 按显式 namespace 查。
- 如果 namespace 来自常量，先在代码中解析常量值；不要只凭变量名猜测。
- 公共 namespace 如 `hippo.mihwak_common`、`hippo.water_common` 也要按代码里显式 namespace 查询；如果应用私有 namespace 查不到，再按 reference 中公共 namespace 接口排查关联关系。

## 查询流程

1. 明确目标：appId、env、cluster、namespace、key。缺省 env 用 `fql_prod`，缺省 cluster 用 `default`，缺省 namespace 用 `application`。
2. 如果 appId、env、cluster、namespace 已知，直接查 `releases/active`，不要先查应用列表或 `navtree`；只有 404、空数组、权限异常或 cluster 不确定时再补查。
3. 如果只给 appId 和 key，先直查 `application` active release；命中就停止。未命中时再查 namespace 列表定位 key 所在 namespace，然后对该 namespace 查 active release。
4. 如果是公共 namespace，先做常见别名归一化；能确定承载 app 时直接查承载 app 的 active release，否则再走公共 namespace 关联接口。
5. 如果查询“线程池配置”，并行查 `application`、`thread_pool_config`、`dynamic_thread_pool_config` 的 active release；`application` 中重点提取 `lsf.dubbo.sys.cfg` 这类框架线程配置。
6. 需要注释、修改人、行号或草稿差异时，再查 `items` 或 namespace 列表，并说明它不是唯一运行时依据。
7. 回复时先给结论，再列接口路径，再给配置结果。若没有命中 key，说明查过的 app/env/cluster/namespace，并给出代码默认值或下一步排查点。

## 快捷规则

- 已知 appId 的单 key 查询：优先 `GET /apps/<appId>/envs/fql_prod/clusters/default/namespaces/application/releases/active?page=0&size=1`，从 `configurations` 取 key。
- 已知 namespace 的单 key 查询：直接查该 namespace 的 active release；不要为了确认 namespace 存在先查 namespace 列表。
- `mihwak_common`、`mihawk_common` 归一为 `hippo.mihwak_common`；当前米霍克公共 namespace 的承载 app 为 `mihwak_virtual`，可直接查 `/apps/mihwak_virtual/envs/fql_prod/clusters/default/namespaces/hippo.mihwak_common/releases/active?page=0&size=1`。
- `water_common` 归一为 `hippo.water_common`；承载 app 未确定时先用公共 namespace 关联接口查 owner，再查 active release。
- 同一个 app 下多个独立 namespace 查询可以并行发起 GET，最后统一整理结果。

## API Reference

Hippo API 路径、参数和示例见 `/home/joney/projects/ai/agent-tools/skills/lexin/query-hippo-config/references/hippo-api.md`。需要拼接接口、查公共 namespace、区分 items 与 active release，或排查 401/404/空结果时读取该 reference。

## 输出格式

简短查询按这个顺序回复：

1. `结论`：给出目标 key 的实际值、环境和 namespace。
2. `查询接口`：列出实际调用的只读接口路径或 URL。
3. `结果`：表格或 key/value/comment 摘要，说明是否来自 active release。

代码分支排查按这个顺序回复：

1. `代码口径`：说明从代码定位到的 app/env/namespace/key/defaultValue。
2. `Hippo 实际值`：给出 active release 中的值；如果未配置，说明会走代码默认值。
3. `查询接口`：列出接口路径。
4. `影响判断`：结合代码分支说明当前会走哪条路径。
