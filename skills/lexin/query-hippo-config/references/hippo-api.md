# Hippo 只读 API 参考

## 基础信息

- 入口：`http://hippo.oa.fenqile.com/#/app/dashboard`
- API host：`http://hippo.oa.fenqile.com`
- 默认浏览器 profile：`/tmp/healthy-dashboard-profile`
- 常用登录检查成功标识：页面标题 `Hippo - Dashboard` 或正文包含 `Welcome`

通过 `browser_session` MCP 请求时使用 `fetch_with_session`，不要输出 Cookie：

```text
profile=/tmp/healthy-dashboard-profile
url=http://hippo.oa.fenqile.com/<path>
```

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

已知 appId、env、cluster、namespace 时，先直查 active release：

```text
GET /apps/<appId>/envs/fql_prod/clusters/default/namespaces/<namespaceName>/releases/active?page=0&size=1
```

如果用户只给 appId 和 key：

1. 先查 `application` active release。
2. 如果 `configurations` 有 key，直接返回。
3. 如果没有 key，再查 namespace 列表定位 key 所在 namespace。
4. 定位到 namespace 后，再查该 namespace 的 active release。

这比固定先查 `/apps/list`、`/navtree`、namespace 列表更快；只有 appId 不确定、cluster 不确定、返回 404 或 active release 为空时才补查这些接口。

线程池配置快捷查询：

```text
GET /apps/<appId>/envs/fql_prod/clusters/default/namespaces/application/releases/active?page=0&size=1
GET /apps/<appId>/envs/fql_prod/clusters/default/namespaces/thread_pool_config/releases/active?page=0&size=1
GET /apps/<appId>/envs/fql_prod/clusters/default/namespaces/dynamic_thread_pool_config/releases/active?page=0&size=1
```

整理时：

- `application` 中重点看 `lsf.dubbo.sys.cfg`、`dubbo.*`、`*.executor.*` 等框架线程/队列配置。
- `thread_pool_config` 通常是固定线程池基础参数。
- `dynamic_thread_pool_config` 通常是业务动态线程池参数。
- 某个 namespace active release 返回空数组时说明该 app 当前没有该 namespace 的生效发布，继续输出其它命中的 namespace。

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

- 401、登录页、空 HTML：登录态失效，使用 `get-browser-session` 刷新 profile。
- `ProcessSingleton` 或 `SingletonLock` 报错：说明 profile 被占用或有残留锁。不要删除原 profile；优先复制 profile 到 `/tmp/hippo-query-profile.*`，删除副本中的 `SingletonCookie`、`SingletonLock`、`SingletonSocket` 后用副本查询。
- app 搜索有多个候选：不要模糊选择，列出候选 appId 让用户确认。
- namespace 列表能看到 items，但 active release 没有该 key：说明可能未发布或该 key 被删除；运行时通常按 active release/默认值。
- 404：先确认 env/cluster 是否存在，再确认 namespace 是否属于应用或公共 namespace。
