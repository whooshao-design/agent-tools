---
name: query-oa-gateway-interface
description: 查询 OA 网关 URL 与后端接口映射，并回代码仓库追踪实现链路。Use when 用户给出前端请求地址、rc_oa_gateway 路径、mihawk/gateway OA 页面请求，要求查询对应的 FSOF/Dubbo interface、method、version、真实后端应用、实现类、VO 参数、DAO 或 SQL；适用于“页面请求对应后端接口”“前端地址映射后端”“query_page_list 网关规则查询”“当前仓库搜不到接口时定位应用”等只读排查。
metadata:
  version: 1.2.0
---

# query-oa-gateway-interface

## 定位

只读查询 OA 网关配置，把前端 URL 映射到后端 `interface_name + method`，再在本地代码仓库中追踪接口定义、实现、业务逻辑、DAO 和 mapper SQL。它不负责修改网关规则、发布应用、压测接口或调用真实业务写接口。

MCP 优先、浏览器会话兜底。优先使用 `browser_session` MCP 访问 `https://gateway.oa.fenqile.com/`；登录态不可用时使用 `get-browser-session` skill 刷新登录态。不要要求用户在聊天中提供 Cookie、ticket、token 或密码；如果用户已经贴出 Cookie，也不要复用、保存或输出。

## 核心约束

- 只做查询和代码阅读。不要点击、调用或构造任何新增、修改、删除、发布、审批类网关接口。
- 不输出敏感请求头、Cookie、登录跳转票据、token；最终回复只保留脱敏后的 URL 路径和查询结果。
- 默认从用户给出的前端请求 URL 提取 path；去掉 scheme、domain、query string 和 fragment。
- 网关查询时优先使用无前导斜杠的 path 作为 `url` 参数；无结果时再尝试带前导斜杠、带 `rc_oa_gateway/` 前缀或去掉该前缀的变体。
- 如果返回多条规则，按 `domain`、`system_id`、`app_name`、`protocol`、`interface_name`、`method` 与用户上下文筛选；仍不唯一时把候选列出并说明差异。
- 代码追踪默认在当前仓库执行；如果网关返回的应用不属于当前仓库，先说明不匹配，再按用户提供的仓库或本地可发现仓库继续。

## 查询流程

1. 提取前端 path：
   - 输入 `https://mihawk.oa.fenqile.com/rc_oa_gateway/hawk_decision/manage/element/query_section_list.json?page=1`。
   - 查询 path 用 `rc_oa_gateway/hawk_decision/manage/element/query_section_list.json`。
   - 记录原始 query 参数，用于后续映射请求 VO 字段。

2. 查询 OA 网关规则：

```text
POST https://gateway.oa.fenqile.com/rc_oa_gateway/application/url_interface_rule/query_page_list.json
Content-Type: application/x-www-form-urlencoded

page=1&limit=10&system_id=&url=<urlencoded-path>&interface_name=&method=&lsf_app_name=
```

读取 `result_rows` 中这些字段：`protocol`、`interface_name`、`method`、`interface_version`、`lsf_app_name`、`system_id`、`app_name`、`domain`、`method_time_out`、`check_auth`、`modify_time`。

3. 回代码仓库定位接口。先在当前仓库搜；搜不到时按“跨仓库定位”规则确定真实后端应用，再切换到对应仓库搜索：

```bash
rg -n "methodName|interface InterfaceSimpleName|class InterfaceSimpleNameImpl" \
  . -g '*.java' -g '*.xml' -g '*.properties'
```

优先查契约模块和实现模块。Java/Dubbo 项目常见链路是：

```text
service/gateway interface
-> service/impl gateway implementation
-> service/logic
-> dao.logic / dao
-> MyBatis mapper XML
```

4. 识别真实业务入口：
   - 如果网关 method 只是转调或别名，继续追被调用方法。
   - 读取方法参数类型，定位请求 VO/DTO，说明前端 query/body 参数到 Java 字段的映射。
   - 继续追分页、权限过滤、默认值、枚举转换、隐藏状态过滤等影响查询结果的逻辑。

5. 追到数据层：
   - 对 MyBatis 项目，搜索 DAO 方法名和 mapper `<select id="...">`。
   - 摘要说明表名、核心过滤条件、排序、分页口径；不要整段复制很长 SQL。
   - 如果 SQL 在 XML 动态片段中，说明关键 `<if>` 条件与前端参数的关系。

## 跨仓库定位

当前仓库搜不到 `interface_name` 或 `method` 时，不要直接断言代码不存在。按这个顺序定位真实后端应用：

1. 优先看网关返回字段：
   - `lsf_app_name`：有值时通常最接近后端运行应用名，优先用于找仓库和配置。
   - `interface_name`：最稳定，用完整类名或简单类名反查代码。
   - `app_name`、`system_id`：用于确认系统归属，但不一定等于代码仓库名。
   - `domain`、`url`：多用于确认前端入口，只作为辅助。
   - `company_name`、`url_manager`、`operator`：用于人工归属和权限线索，不作为代码定位主依据。

2. **用注册中心直接查提供方应用（权威，优先于下面所有推断）。**
   `query-dubbo-registry` 查 Dubbo/FSOF 注册中心，服务名支持短名模糊匹配：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/query-dubbo-registry/scripts/query_dubbo_registry.js \
  --service=<网关返回的 interface_name>
```

   - 网关的 `lsf_app_name` 与注册中心结果不一致时以注册中心为准，并说明差异（网关配置可能滞后）。
   - 返回多个提供方应用（分机构、分环境独立部署）时如实列出全部候选，再用网关的 `interface_version`、`group` 收敛。
   - 注册中心查不到，才继续往下用包名推断，并明确标注结论是推断而非查证。

3. 用 `interface_name` 反推包和仓库（注册中心查不到时的兜底，包名和应用名经常对不上，不要当作结论）。例：

```text
com.fenqile.rc_comm.hawk.decision.manage.service.gateway.ElementGatewayService
```

优先提取业务段 `hawk.decision.manage`，映射到类似 `server_hawk_decision_manage` 的仓库；`executor`、`dispatcher`、`task` 等包名也按同样方式映射。

4. 在本地项目根全局搜索：

```bash
rg -n "com\\.fenqile\\..*XxxGatewayService|interface XxxGatewayService|class XxxGatewayServiceImpl|methodName" \
  /home/joney/projects -g '*.java' -g '*.xml' -g '*.properties' -g 'pom.xml'

rg --files /home/joney/projects | rg 'XxxGatewayService\.java$'
```

5. 如果网关返回 `lsf_app_name` 或能推断 artifactId，再搜应用配置：

```bash
rg -n "application.name|lsf_app_name|dubbo.application.name|artifactId|XxxGatewayService" \
  /home/joney/projects -g '*.properties' -g '*.xml' -g 'pom.xml' -g '*.java'
```

重点看 `src/main/resources/app.properties`、`pom.xml`、`dubbo-provider.xml`、`META-INF/spring/*.xml`。

6. 本地没有仓库时，使用可用的跨仓库搜索/GitLab 搜索完整 `interface_name`；完整类名优先，其次接口简单类名，最后才搜 method。最终回复要说明“本地未发现仓库，定位依据来自网关字段/跨仓库搜索结果”。

## 失败处理

- 网关返回 401/登录页：使用 `get-browser-session` 刷新 `gateway.oa.fenqile.com` 登录态后重试。
- 网关返回空结果：依次尝试 path 变体；再用前端项目关键字、接口名、方法名或系统名查询；最后说明已尝试的查询条件。
- 本地搜不到接口：先用 `query-dubbo-registry` 查注册中心确认真实后端应用，再按“跨仓库定位”其余步骤处理。
- 代码链路出现多个实现：按注册中心返回的应用、Dubbo provider 配置、Spring bean、包名、版本筛选；无法唯一确认时列候选和判断依据。

## 输出格式

简短问题按这个顺序回复：

1. `结论`：前端 URL 对应的后端 interface、method、version、protocol、应用。
2. `代码链路`：用文件链接列出接口定义、实现、真实业务入口、DAO/mapper；如果不是当前仓库，先说明真实应用定位依据。
3. `参数与 SQL`：说明关键前端参数映射到哪个请求字段，以及最终查什么表/条件。
4. `查询依据`：列出 OA 网关查询接口路径和关键查询条件，不输出 Cookie。

需要复盘流程时，按步骤说明：

```text
前端 URL
-> 提取 path
-> query_page_list 网关规则
-> interface_name + method
-> 本地 rg 定位接口
-> impl/logic/dao/mapper
-> 输出结论和证据
```
