---
name: query-hippo-config
description: 通过 Hippo 配置中心只读查看应用配置和实际生效 release，支持标准 Hippo 与 stable/测试/项目环境独立域名。Use when 用户要求查看 Hippo 配置、线上/预发/灰度/OA/stable 配置、代码分支依赖的配置 key、应用默认配置、namespace 配置项，或需要根据代码里的 ConfigService/getAppConfig/@HippoConfigProperty 判断真实配置走向；默认环境为 prod/fql_prod，最终必须输出查询接口 URL 和配置结果。
metadata:
  version: 1.3.0
---

# query-hippo-config

## 定位

只读查看 Hippo 配置中心中的应用配置、namespace 配置项和实际生效 release，用于辅助判断代码中由 Hippo/Apollo 配置控制的运行分支。它不负责修改配置、发布配置、审批配置，也不替代代码阅读；它负责把代码里的 app/env/namespace/key 映射到 Hippo 当前实际值。

取具体配置值一律用预置脚本 `hippo_query.js`，它在页面内取数、本地过滤，只把目标 key 带回来。`fetch_with_session` 只用于小响应的探索类接口（`apps/list`、`navtree`、namespace 列表），因为它的响应字符上限是 30000，而真实应用的 active release 远超该上限（实测 `server_hawk_decision_manage` 线上 `application` 为 110 个 key、184952 字符），截断后无法判断 key 是否存在。

站点：标准为 `http://hippo.oa.fenqile.com/`，stable/测试/项目环境为 `http://stable-hippo.oa.fenqile.com/`。登录态不可用时使用 `get-browser-session` skill 刷新，不要让用户在聊天中提供 Cookie、ticket、token 或密码。

## 核心约束

- 只执行只读 GET 请求。不要调用 POST、PUT、PATCH、DELETE，也不要在页面上点击保存、发布、删除、回滚等动作。
- 默认环境是 `prod`，映射为 Hippo env `fql_prod`。用户明确指定 `pre`、`gray`、`oa`、`fql_*` 时才切换。
- 用户指定 `stable`、`test`、`testing`、`prj`、`project`、`测试`、`测试环境`、`项目`、`项目环境` 时，查询 `http://stable-hippo.oa.fenqile.com`，API env 默认按预发逻辑用 `fql_pre`。不要把这些别名直接当作 `env=stable`；如果 404/500 或业务前缀不确定，先查 `navtree` 确认真实 env。
- 最终回复必须同时输出本次查询的完整接口 URL、配置结果，以及是否来自 active release。
- 用 `fetch_with_session` 直接查 `releases/active` 或 `items` 时，必须显式传 `max_chars=30000`（上限），并且先看响应里的 `truncated`。`truncated=true` 时禁止得出「该 key 未配置 / 走代码默认值」的结论，改用 `hippo_query.js`。
- 回复里不要贴整段 `configurations`。只给目标 key 及必要上下文，并说明该 namespace 的总 key 数。
- 判断运行时生效值时，优先查 `releases/active`；`items` 和 namespace 列表可用于查草稿差异、注释、修改人和页面展示，但不要把未发布 items 当成运行时生效值。
- 不要输出 Cookie、ticket、token、完整登录跳转 URL 中的敏感参数；引用 URL 时可省略一次性 ticket 参数。
- 如果用户只说“默认应用”，先从当前代码上下文或仓库 `app.properties` 的 `application.name` 推断；同一问题能匹配多个子工程时，先说明候选并询问，不要随意选择。

## 默认映射

环境映射：

- `prod`、`生产`、`线上` -> `fql_prod`
- `pre`、`预发` -> `fql_pre`
- `gray`、`灰度` -> `fql_gray`
- `oa` -> `fql_oa`
- `stable`、`test`、`testing`、`prj`、`project`、`测试`、`测试环境`、`项目`、`项目环境` -> 使用 `http://stable-hippo.oa.fenqile.com`，env 默认 `fql_pre`
- 用户已给 `fql_prod`、`pdwl_pre` 这类完整 env 时直接使用；host 由用户语义决定，stable/测试/项目环境用 `http://stable-hippo.oa.fenqile.com`，线上/预发/灰度/OA 用 `http://hippo.oa.fenqile.com`。

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

key 的确定顺序：

1. 代码字面量：`getProperty("<key>", default)`、`getBooleanProperty("<key>", false)`、`@HippoConfigProperty(key = "<key>")` 的第一个参数就是 key，直接用。
2. 常量或拼接：key 来自常量、枚举或 `PREFIX + bizType` 这类拼接时，先在代码里解析出实际字符串再查；只能确定前缀时用 `get --key-prefix=<前缀>` 查整个前缀族。
3. 用户只说了业务语义、给不出 key 名：用 `list` 拿该 namespace 的全量 key 名（只出名字不出 value，成本低）再按语义筛，命中候选后再 `get` 取值。
4. 以上都定位不到：不要猜 key 名，按查询流程换 namespace 重来，或列出候选让用户确认。

## 查询流程

1. 明确目标：appId、env、cluster、namespace、key 和 API host。缺省 env 用 `fql_prod`，缺省 host 用 `http://hippo.oa.fenqile.com`，缺省 cluster 用 `default`，缺省 namespace 用 `application`；stable/测试/项目环境 host 改用 `http://stable-hippo.oa.fenqile.com`，env 默认用 `fql_pre`。若 direct active release 返回 404/500，先查 `navtree`，按返回的真实 env 重试。
2. 如果 appId、env、cluster、namespace 已知，直接用 `hippo_query.js get --key=<key>` 取值，不要先查应用列表或 `navtree`；只有 404、空 active release、权限异常或 cluster 不确定时再补查。
3. 如果只给 appId 和 key，先对 `application` 跑 `get`；`missingKeys` 命中说明该 namespace 没有这个 key，再用 `list` 或 namespace 列表定位 key 所在 namespace，然后对该 namespace 跑 `get`。
4. 如果是公共 namespace，先做常见别名归一化；能确定承载 app 时直接用 `get --app-id=<承载 app> --namespace=<公共 namespace>`，否则再走公共 namespace 关联接口。
5. 如果查询“线程池配置”，对 `application` 跑 `get --key-prefix=lsf.dubbo`（重点是 `lsf.dubbo.sys.cfg` 这类框架线程配置），对 `thread_pool_config`、`dynamic_thread_pool_config` 这类小 namespace 跑 `dump`。
6. 需要注释、修改人、行号或草稿差异时，再查 `items` 或 namespace 列表，并说明它不是唯一运行时依据。
7. 回复时先给结论，再列接口路径，再给配置结果。若没有命中 key，说明查过的 app/env/cluster/namespace，并给出代码默认值或下一步排查点。

## 预置脚本

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/query-hippo-config/scripts/hippo_query.js <command> [options]
```

- `get`：查目标 key 的生效值，只输出命中项和 `missingKeys`。必须传 `--key=a,b`（英文逗号分隔）或 `--key-prefix=<前缀>`。
- `list`：只列 key 名和总数，不输出 value。用于定位 key 落在哪个 namespace、判断 namespace 规模。
- `dump`：输出整个 namespace 的 key/value。只有确认需要整包时才用。
- `self-test`：纯逻辑自检，不联网。

常用参数：`--app-id`（省略时从当前目录 `app.properties` 推断）、`--env`（默认 `prod`）、`--hippo-site=stable`、`--cluster`、`--namespace`、`--profile`。

每次输出都带 `releaseKey`、`releasedBy`、`releasedTime`、`totalKeys` 和 `configurationsChars`，可直接用于回复中的 active release 说明。

失败码：`LOGIN_REQUIRED`（按 `details.ensureCommand` 刷新登录态后重试）、`PROFILE_IN_USE`（关闭占用该 profile 的 Chromium）、`FORBIDDEN`、`ACTIVE_RESPONSE_INVALID`。

## 快捷规则

- 已知 appId 的单 key 查询：`hippo_query.js get --app-id=<appId> --key=<key>`，默认就是 `fql_prod` + `default` + `application`。
- 已知 namespace 的单 key 查询：加 `--namespace=<namespace>`；不要为了确认 namespace 存在先查 namespace 列表。
- `mihwak_common`、`mihawk_common` 归一为 `hippo.mihwak_common`；当前米霍克公共 namespace 的承载 app 为 `mihwak_virtual`，可直接 `get --app-id=mihwak_virtual --namespace=hippo.mihwak_common --key=<key>`。
- `water_common` 归一为 `hippo.water_common`；承载 app 未确定时先用公共 namespace 关联接口查 owner，再查 active release。
- 同一个 app 下多个独立 namespace 的查询可以分多次 `get` 并行发起，最后统一整理结果。

## API Reference

Hippo API 路径、参数和示例见 `/home/joney/projects/ai/agent-tools/skills/lexin/query-hippo-config/references/hippo-api.md`。需要拼接接口、查公共 namespace、区分 items 与 active release，或排查 401/404/空结果时读取该 reference。

## 输出格式

简短查询按这个顺序回复：

1. `结论`：给出目标 key 的实际值、环境和 namespace。
2. `查询接口`：列出实际调用的只读 URL，包含本次选择的 Hippo 域名。
3. `结果`：表格或 key/value/comment 摘要，说明是否来自 active release。

代码分支排查按这个顺序回复：

1. `代码口径`：说明从代码定位到的 app/env/namespace/key/defaultValue。
2. `Hippo 实际值`：给出 active release 中的值；如果未配置，说明会走代码默认值。
3. `查询接口`：列出实际调用的只读 URL，包含本次选择的 Hippo 域名。
4. `影响判断`：结合代码分支说明当前会走哪条路径。
