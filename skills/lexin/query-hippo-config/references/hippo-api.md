# Hippo 只读 API 参考

## 基础信息

- 标准入口：`http://hippo.oa.fenqile.com/#/app/dashboard`
- 标准 API host：`http://hippo.oa.fenqile.com`
- stable/测试/项目环境入口：`http://stable-hippo.oa.fenqile.com/#/app/dashboard`
- stable/测试/项目环境 API host：`http://stable-hippo.oa.fenqile.com`
- 墨西哥入口与 API host：`https://hippo.oa.wowcredito.com`
- 印尼入口与 API host：`https://hippo.oa.kredito.id`
- 默认浏览器 profile：`/home/joney/.local/state/agent-tools/browser-profiles/healthy`（四个站点共用同一个 passport 登录态）
- 常用登录检查成功标识：页面标题 `Hippo - Dashboard`、`Hippo - 统一配置中心` 或正文包含 `Welcome`
- 所有 `hippo.oa.*` 域名都是内网域名，必须直连；预置脚本已强制直连，手工 `curl` 要加 `--noproxy '*'`，走代理会得到 503 或代理伪造的 404

通过 `browser_session` MCP 请求时使用 `fetch_with_session`，不要输出 Cookie：

```text
profile=/home/joney/.local/state/agent-tools/browser-profiles/healthy
url=<按环境选择的 API host>/<path>
max_chars=30000
```

## 响应大小与截断

Hippo 没有单 key 读接口：`releases/active` 的 `configurations` 是含该 namespace **全部** key 的 JSON 字符串，
`items` 同理。所以任何单 key 查询在接口层面都会返回整个 namespace，过滤只能发生在客户端。

各取数通道的字符上限：

| 通道 | 默认 | 上限 | 截断可见性 |
|---|---|---|---|
| `browser_session` MCP `fetch_with_session` | 8000 | 30000 | 响应里的 `truncated` |
| `config_registry` MCP `registry_get` | 12000 | 100000 | 响应里的 `truncated` |
| `hippo_query.js`（页内 fetch） | 无 | 无 | 不会截断 |

实测参考：`server_hawk_decision_manage` 线上 `application` 的 `configurations` 为 110 个 key、184952 字符，
即 `fetch_with_session` 上限的 6 倍、`registry_get` 上限的 1.8 倍。这类 namespace 用 MCP 通道必然截断，
而截断后的 JSON 仍能被部分匹配，很容易得出「该 key 不存在 → 走代码默认值」的错误结论。

因此：**查具体 key 的值用 `hippo_query.js`**；`fetch_with_session` 只用于 `apps/list`、`navtree`、
namespace 列表这类小响应接口，且必须显式传 `max_chars` 并检查 `truncated`。

## 站点与 env 路由

先确定用户语义，再同时确定 API host 和 env：

- `prod`、`生产`、`线上` -> host `http://hippo.oa.fenqile.com`，env `fql_prod`
- `pre`、`预发`、`预发布` -> host `http://hippo.oa.fenqile.com`，env `fql_pre`
- `gray`、`灰度` -> host `http://hippo.oa.fenqile.com`，env `fql_gray`
- `oa` -> host `http://hippo.oa.fenqile.com`，env `fql_oa`
- `stable`、`test`、`testing`、`prj`、`project`、`测试`、`测试环境`、`项目`、`项目环境` -> host `http://stable-hippo.oa.fenqile.com`，env 默认 `fql_pre`
- `mx`、`mexico`、`墨西哥` -> host `https://hippo.oa.wowcredito.com`，env `mxyw_pre`、`mxyw_prod`
- `id`、`idn`、`indonesia`、`印尼` -> host `https://hippo.oa.kredito.id`，env 只有 `ynyw_prod`
- 用户显式给 `fql_prod`、`fql_pre`、`pdwl_pre`、`mxyw_prod`、`ynyw_prod` 这类完整 env 时，env 原样使用；`mxyw_*` 和 `ynyw_*` 前缀直接决定海外 host，其余 host 由用户语义决定，stable/测试/项目环境用 stable host，线上/预发/灰度/OA 用标准 host
- stable host 中不同业务线可能有不同 env 前缀；不确定时先查 `/apps/<appId>/navtree`，再用 navtree 返回的 env 查 active release

海外站点的 env 由业务线前缀加环境后缀组成，`navtree` 的 `entities[].body.env` 会同时给出 `name`、`envShowName`、`bu`：

| 站点 | env name | envShowName | bu |
|---|---|---|---|
| 墨西哥 | `mxyw_pre` | 墨西哥业务pre环境 | `mexicoyewu` |
| 墨西哥 | `mxyw_prod` | 墨西哥业务prod环境 | `mexicoyewu` |
| 印尼 | `ynyw_prod` | 印尼业务prod环境 | `indonesiayewu` |

注意 `env.prefix` 字段与 env name 前缀不一致（墨西哥 `prefix` 是 `mexyw`，env name 却是 `mxyw_*`）；拼接 API 路径一律用 `env.name`。印尼只有 prod，没有 pre 环境；应用范围也和国内不同，海外常见的是 `middle-*`、`overseas-*`、`mx-*` 这类应用。

除 host 和 env 前缀外，其它 API 路径、参数和 active release 判断逻辑相同。最终回复的查询接口应输出完整 URL，避免省略域名导致 stable、海外与标准环境混淆。

## 常用端点

查应用：

```text
GET /apps/list?appId=<appId_or_keyword>&page=0&size=10
GET /apps/<appId>
GET /apps?appIds=<appId1>,<appId2>
```

查应用环境和 cluster：

```text
GET /apps/<appId>/navtree
```

返回的 env 通常形如 `fql_pre`、`fql_gray`、`fql_oa`、`fql_prod`；cluster 通常是 `default`。

查 namespace 列表和页面 items：

```text
GET /apps/<appId>/envs/<env>/clusters/<cluster>/namespacePubTypes/__app__/groupId/0/page/0/size/100?searchNamespace=
GET /apps/<appId>/envs/<env>/clusters/<cluster>/namespacePubTypes/__app__/groupId/0
GET /apps/<appId>/envs/<env>/clusters/<cluster>/namespaces/<namespaceName>
GET /apps/<appId>/envs/<env>/clusters/<cluster>/namespaces/<namespaceName>/items?orderBy=key
```

说明：

- 普通应用配置使用 `namespacePubTypes/__app__`。
- `__pub__` 是发布系统配置，不要默认使用。
- `items` 可看到 value、comment、修改人、更新时间、`isModified`，但可能包含未发布草稿。

定位类查询的响应结构（`hippo_query.js` 的 `apps`/`find` 依赖这几点）：

- `GET /apps/list?appId=<keyword>&page=0&size=<n>` 返回 `{"elements":[{"appId","name","ownerName","bu",...}]}`，是**全站**应用元数据，不代表该应用在当前站点/env 有配置。海外站点尤其会搜出大量国内应用，必须再用 `navtree` 过滤。
- `GET /apps/<appId>/navtree` 返回 `{"entities":[{"body":{"env":{...},"clusters":[...]}}]}`；`entities` 为空表示该应用在这个站点没有任何环境，直接查 active release 会 404。
- namespace 列表的 `elements` 里，namespace 名在不同版本分别落在 `namespace.namespaceName`、`namespaceName` 或 `baseInfo.namespaceName`，三种都要兼容。

查运行时生效 release：

```text
GET /apps/<appId>/envs/<env>/clusters/<cluster>/namespaces/<namespaceName>/releases/active?page=0&size=1
GET /apps/<appId>/envs/<env>/clusters/<cluster>/namespaces/<namespaceName>/releases/all
```

`releases/active` 返回数组，核心字段：

- `configurations`：JSON 字符串，表示该 namespace 当前发布生效的 key/value。
- `releaseKey`、`dataChangeCreatedTime`、`dataChangeCreatedBy`：用于说明发布版本和发布人。
- `comment`：发布备注。

## 快速查询路径

已知 appId、env、cluster、namespace 时，直接取目标 key（脚本内部就是查上面那条 active release URL，
差别只在于整包留在页面里、只有目标 key 回到终端）：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/query-hippo-config/scripts/hippo_query.js get \
  --app-id=<appId> --namespace=<namespaceName> --key=<key>
```

如果用户只给 appId 和 key：

1. 先对 `application` 跑 `get`。
2. `matched` 有该 key，直接返回。
3. key 落在 `missingKeys` 里，再用 `list` 或 namespace 列表定位 key 所在 namespace。
4. 定位到 namespace 后，加 `--namespace=` 再跑一次 `get`。

这比固定先查 `/apps/list`、`/navtree`、namespace 列表更快；只有 appId 不确定、cluster 不确定、返回 404 或 active release 为空时才补查这些接口。

线程池配置快捷查询：

```bash
hippo_query.js get  --app-id=<appId> --key-prefix=lsf.dubbo
hippo_query.js dump --app-id=<appId> --namespace=thread_pool_config
hippo_query.js dump --app-id=<appId> --namespace=dynamic_thread_pool_config
```

整理时：

- `application` 中重点看 `lsf.dubbo.sys.cfg`、`dubbo.*`、`*.executor.*` 等框架线程/队列配置。
- `thread_pool_config` 通常是固定线程池基础参数。
- `dynamic_thread_pool_config` 通常是业务动态线程池参数。
- 某个 namespace active release 返回空数组（脚本输出 `hasActiveRelease: false`）时说明该 app 当前没有该 namespace 的生效发布，继续输出其它命中的 namespace。

## 公共 Namespace

常见公共 namespace 可直接按应用 namespace 查询；若查不到或需要确认关联关系，再用：

```text
GET /appnamespaces/public
GET /envs/<env>/appnamespaces/<publicNamespaceName>/namespaces
GET /envs/<env>/apps/<appId>/clusters/<cluster>/namespaces/<namespaceName>/associated-public-namespace
```

常见别名：

- `mihwak_common`、`mihawk_common` -> `hippo.mihwak_common`
- `water_common` -> `hippo.water_common`

已知快捷承载：

```text
hippo.mihwak_common -> appId=mihwak_virtual, namespaceName=hippo.mihwak_common
```

例如查 prod 生效值：

```text
GET /apps/mihwak_virtual/envs/fql_prod/clusters/default/namespaces/hippo.mihwak_common/releases/active?page=0&size=1
```

## 代码到 Hippo 的映射

常见代码模式：

```java
ConfigService.getAppConfig().getProperty("key", "default")
ConfigService.getConfig("namespace").getBooleanProperty("key", false)
@HippoConfigProperty(key = "key", defaultValue = "false")
@HippoConfigProperty(namespace = NAMESPACE_COMM, key = "key", defaultValue = "true")
```

映射规则：

- `getAppConfig()` 和无 namespace 注解 -> `namespaceName=application`
- `getConfig("namespace")` 和显式 namespace 注解 -> `namespaceName=<namespace>`
- Java 常量必须先在代码里解析实际字符串。
- 如果 active release 的 `configurations` 没有该 key，则按代码 defaultValue 或 getProperty 默认值判断。

## 排查提示

- 401、登录页、空 HTML，或脚本返回 `LOGIN_REQUIRED`：登录态失效，按 `details.ensureCommand` 或 `get-browser-session` 刷新 profile。
- `ProcessSingleton`、`SingletonLock` 报错或脚本返回 `PROFILE_IN_USE`：说明 profile 被占用或有残留锁。不要删除原 profile；优先复制 profile 到 `/tmp/hippo-query-profile.*`，删除副本中的 `SingletonCookie`、`SingletonLock`、`SingletonSocket` 后用副本查询（脚本传 `--profile=` 指向副本）。
- 结论是「key 不存在」之前，先确认这次取数没有截断：MCP 通道要看 `truncated`，脚本通道不会截断但要看 `missingKeys` 与 `totalKeys` 是否合理。
- app 搜索有多个候选：不要模糊选择，列出候选 appId 让用户确认。
- namespace 列表能看到 items，但 active release 没有该 key：说明可能未发布或该 key 被删除；运行时通常按 active release/默认值。
- `hasActiveRelease: false`（active release 返回空数组）不区分「namespace 不存在」和「namespace 存在但没有生效发布」；实测拼一个不存在的 namespace 同样返回空数组而不是 404，需要用 namespace 列表来区分。
- 404：先确认 env/cluster 是否存在，再确认 namespace 是否属于应用或公共 namespace。
- stable/测试/项目环境 404、空结果或返回错误页面时，先确认 URL host 是 `http://stable-hippo.oa.fenqile.com`。不要直接使用 `env=stable`；先按 `fql_pre` 查，失败时查 `navtree` 获取真实 env，例如 `fql_pre`、`pdwl_pre`。
