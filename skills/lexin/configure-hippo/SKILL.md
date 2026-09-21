---
name: configure-hippo
description: 安全新增、修改并在明确授权后发布 Hippo 配置，并支持在明确授权后为应用新建 namespace；支持标准 Hippo、stable/测试/项目环境以及墨西哥、印尼海外站点的独立域名；默认使用预发布 fql_pre 且只保存草稿、不发布；stable/测试环境保存后自动按 key 发布。Use when 用户要求在 Hippo 配置中心新增 key、修改配置值、更新预发布或 stable 配置、修改墨西哥或印尼海外配置、把本地文件写入 namespace、给某个 appId 新建 namespace、给 namespace 授修改权或发布权，或明确授权“修改并发布”；内置变更前检查、并发草稿保护、非目标项保护、key 粒度发布、新建 namespace 与授权的二次确认和 active release 校验。
metadata:
  version: 1.9.6
---

# configure-hippo

## 定位

新增或修改 Hippo namespace 中的单个配置项。默认只保存为未发布草稿；只有用户在当前对话明确授权发布时，才允许自动发布目标 key。默认环境为当前站点的 pre（国内 `fql_pre`）、cluster 为 `default`、namespace 为 `application`。

**stable 站点是唯一例外**：stable 是测试环境，Hippo 前端在 stable 上发布也不走审批流，所以 `--env=stable` 的 `upsert`
在保存草稿并回读校验通过后会**自动按 key 发布目标项**，不需要 `--publish`、授权参数和 plan token；
只想留草稿时传 `--no-publish`。自动发布和 Hippo 发布弹窗里“勾选要发布的项”是同一个接口：`releaseSelectedItems`
只放本次 `upsert` 的目标 key（`{id,key,oldValue,newValue,type}`），namespace 里别人的未发布草稿原样留着、
不会被顺手发出去；发布后校验 active release 只有目标 key 变化，并在 `otherDraftKeysLeftUnpublished` 里列出
被保留的其它草稿 key。一次 `upsert` 只处理一个 key，改了多个 key 就跑多次，每次只发自己那个。
线上、灰度、OA 和海外站点不受影响，仍必须显式授权。

标准 Hippo 站点使用 `http://hippo.oa.fenqile.com`。stable/测试/项目环境使用独立站点 `http://stable-hippo.oa.fenqile.com`：`stable`、`test`、`testing`、`prj`、`project`、`测试`、`测试环境`、`项目`、`项目环境` 默认映射为 API env `fql_pre`，即只切换 Hippo 域名，其它 env 命名逻辑保持与原 Hippo 一致。若 `navtree` 显示 `pdwl_pre` 等业务前缀 env，显式传该 env 并加 `--hippo-site=stable`。

海外站点是独立域名加独立 env 前缀，不能沿用 `fql_*`：墨西哥 `https://hippo.oa.wowcredito.com` 对应 `mxyw_pre`、`mxyw_prod`，印尼 `https://hippo.oa.kredito.id` 只有 `ynyw_prod`，没有 pre，所以印尼站点缺省 env 就是 `ynyw_prod`。传 `--hippo-site=mx|id` 加 `--env=pre|prod`，或直接传完整 env（`mxyw_pre`、`ynyw_prod` 会自行路由到对应站点）。所有 `hippo.oa.*` 域名都是内网域名，脚本强制直连、不走代理。除站点域名和 env 前缀外，草稿检查、保存和回读逻辑相同。

除配置项外，本 skill 还能给应用新建 namespace，对应页面 `http://hippo.oa.fenqile.com/#/app/baseinfo/user/namespace/create`（入口在 `http://hippo.oa.fenqile.com/#/app/baseinfo/config/env`），接口是 `POST /apps/<appId>/appnamespaces`。新建 namespace 是**应用级**动作：Hippo 会在该站点的每个 env（例如 `fql_pre`、`fql_gray`、`fql_oa`、`fql_prod`）各建一个同名空 namespace，没有配置项也没有 release，因此它不是“只动预发布”的操作，必须由用户明确授权。新建只产生空 namespace，运行时要等后续 `upsert` 写值并发布后才会受影响。

namespace 和授权都是**按站点**独立的：标准、stable、墨西哥、印尼是四个互不相通的 Hippo 实例，在线上站点建好的
namespace 不会出现在 stable 上，授权也一样。所有 `namespace-*` 命令都用和配置命令相同的站点参数切换：
`--env=stable`（或 `test`/`prj`/`测试`/`项目环境` 等别名）走 `http://stable-hippo.oa.fenqile.com`，
`--hippo-site=mx|id` 走海外站点。stable 站点通常只有 `fql_pre` 一个 env（业务线不同可能是 `pdwl_pre` 之类，
以 `namespace-status` 输出的 `envs` 为准），所以在 stable 新建 namespace 只落一个 env；印尼只有 `ynyw_prod`，
在印尼新建 namespace 等同于直接动线上，但因为没有配置项也没有 release，运行时不受影响。`namespace-*` 命令
不需要 `--allow-non-pre`，站点选择本身就是用户意图的一部分，创建/授权仍按各自的授权规则走。

新 namespace 要有人能改能发，授权接口是 `POST /apps/<appId>/namespaces/<namespaceName>/roles/<roleType>`，
请求体就是用户 id，一次一个用户。`namespace-create` 会在创建校验通过后**自动**给默认名单（`joneyshao`）
授修改权（`ModifyNamespace`）和发布权（`ReleaseNamespace`），不再单独询问——创建授权已经覆盖这一步；
需要跳过时传 `--no-auto-grant`。Hippo 一般已经把创建者自动加上，这时自动授权会命中 `alreadyGranted` 并跳过，
不会重复发请求。给默认名单以外的人授权仍然要单独明确授权，用 `namespace-grant`。
namespace 归到分组时，角色接口里的 namespace 名要写成 `<groupPath>!<namespaceName>`，脚本会自动按回读到的 `groupPath` 拼。

已有 namespace 但当前账号没有修改权/发布权时，`status`/`plan` 会先暴露 `hasModifyPermission`/`hasReleasePermission`，
`upsert` 会在写入前拒绝（`NAMESPACE_MODIFY_PERMISSION_DENIED` / `NAMESPACE_RELEASE_PERMISSION_DENIED`）。
这时直接跑 `namespace-grant`（不传 `--grant-users` 就是给默认名单自助补权限，不用再问）；如果 `namespace-grant`
报 `ASSIGN_ROLE_PERMISSION_DENIED`，说明当前账号根本没有这个应用的 Hippo 权限，脚本会把 `appOwners` 一起返回，
此时必须停下来告知用户去向应用负责人申请权限，不要反复重试或换路径绕过。

本 skill 不回滚配置。**删除配置项是不可逆的高危动作，只走 `delete-item`，且每一个 key 都必须由用户在当前对话中点名授权**（应用、环境、namespace、key 四者齐全）；没有点名授权的 key 一律不删，也不能拿"清理冗余项"之类的概括性授权去删清单之外的 key。流程固定为：先 `delete-plan`（只读）看影响面，再把 plan 给出的 `deleteAuthorizationValue`（目标全路径）、`confirmEnvValue`、`currentStateToken`、`instancesOnActiveRelease` 原样传给 `delete-item`；加 `--publish --publish-authorization=explicit` 才按 key 粒度发布该删除（载荷 `type=delete`，与 Hippo 发布弹窗一致），发布后校验 active release 只少了目标 key。每次 `delete-item` 都写审计日志 `~/.local/state/agent-tools/hippo-delete-audit.log`。未授权时不发布；用户明确说“可以发布”“授权发布”“修改并发布”等同义表达后，可以在保存草稿并回读校验后自动发布目标 key。纯查询实际生效值使用 `query-hippo-config`；登录态失效使用 `get-browser-session`。

`browser_session` MCP 优先用于登录态预检；由于该 MCP 只允许 GET，新增、修改和授权发布必须使用本 skill 的预置脚本。不要临时编写 Hippo PUT/POST 工具。

## 强制约束

- 默认 env 是当前站点的 pre 环境：标准和 stable 站点是 `fql_pre`，墨西哥是 `mxyw_pre`；印尼没有 pre，缺省 env 是 `ynyw_prod`。只有用户明确指定其它环境时才传 `--env`，且写入时必须同时传 `--allow-non-pre`。
- 印尼只有 `ynyw_prod`，任何印尼写入都等同于改线上：脚本不给印尼保留免二次确认的写入环境，必须由用户明确指定环境、传 `--allow-non-pre`，发布还要单独的明确授权。
- 根据 `--env` 和 `--hippo-site` 自动选择 Hippo 站点：stable/测试/项目环境走 `http://stable-hippo.oa.fenqile.com`，墨西哥走 `https://hippo.oa.wowcredito.com`，印尼走 `https://hippo.oa.kredito.id`，其它环境走 `http://hippo.oa.fenqile.com`。不要把 stable 环境请求发到标准站点，不要把线上/预发请求发到 stable 站点，也不要把海外请求发到国内站点。
- **删除规则（高于其它约束）**：① 只删用户在当前对话里逐 key 点名授权的项，授权必须能落成 `--delete-authorization=<app>/<env>/<namespace>/<key>`；② 先 `delete-plan`，向用户展示 `instancesOnActiveRelease` 与删除后剩余 key，再执行；③ 不要把多个 key 写进循环脚本一次跑完，除非用户已经逐条确认过完全相同的清单，且任一失败立即停止；④ 多环境按 pre → gray → oa → prod 逐环境做，每个环境删除后先验证（active 回读、实例仍在公共域/新代码、日志无 `未配置`）再进下一个；⑤ 绝不删除用户明确要求保留的 key，绝不删除公共 namespace 的项（除非用户专门授权并传 `--allow-public-namespace`）；⑥ 不删 namespace 本身；⑦ 结果里必须报告 `auditLogged`。
- 默认动作仅是 upsert 草稿。没有用户明确授权时，不能传 `--publish`，也不能调用 release、publish、commitApprove 等发布动作。stable 站点例外：`upsert` 保存后自动发布目标 key，这是站点规则而不是授权动作，`--no-publish` 可关闭。
- 非 stable 站点的授权发布只能通过 `upsert --publish --publish-authorization=explicit --expected-current-token=<plan token>` 执行；必须先运行 `plan`，并使用本次 `plan` 返回的 `currentStateToken`。stable 自动发布不要求 token，但目标 key 已有未发布草稿时仍要按草稿规则带 token。
- stable 自动发布需要当前账号有该 namespace 的发布权；缺发布权时 `upsert` 报 `NAMESPACE_RELEASE_PERMISSION_DENIED`，按“已有 namespace 但没有权限”流程自助补权限，不要用 `--no-publish` 绕过后留下一个没人发布的草稿。
- 发布必须是 key 粒度：脚本只把目标 key 放入 `releaseSelectedItems`。不要发布整个 namespace，不要合并发布灰度分支，不要顺手发布其它草稿 key。stable 自动发布同样遵守这一条，`otherDraftKeysLeftUnpublished` 非空是正常现象，表示别人的草稿被原样保留，不要去“帮忙”发布或清理。
- 授权发布不等于绕过平台审批。若 Hippo 判断该环境需要审批，脚本必须停止并报告 `PUBLISH_REQUIRES_APPROVAL`，不能直接调用发布接口绕过流程。
- 配置值只从 UTF-8 文件读取；不要把长配置、token、密钥直接放进命令行或聊天内容。
- 配置项备注（`--comment` / `--comment-file`）解释配置用途、合法取值及各值行为；有默认值、单位或非法值回退行为时一并说明，并以代码为准。不要写测试目的、临时验证过程、需求章节号或版本号；发布背景写入独立的 `--release-comment`。只修改备注时保留原值，并验证 active 值未变；脚本因值相同跳过发布是正常结果。
- Hippo 页面正文可能包含“登录”说明，不能据此误判 session；以目标 host、Angular injector 和 `ConfigService` 就绪为准。
- 脚本复用 `browser_network` 对 Hippo 内网域名直连，仅清理子进程代理环境，不修改用户全局 VPS/代理配置。
- items 较大时由页面内原生 fetch 完整读取，避免 `fetch_with_session` 输出上限导致配置被截断。
- 变更前必须执行 `plan`。目标 key 已存在未发布改动时，写入必须携带本次 `plan` 返回的 `currentStateToken`，避免覆盖并发草稿。
- 未发布时保留同 namespace 的其它草稿。写入后必须验证非目标项未变化、active `releaseKey` 和完整 `configurations` 未变化；授权发布后必须验证 active release 只有目标 key 变化。
- 不输出 Cookie、token 或配置原文。最终只汇报目标路径、操作类型、长度/行数/hash、草稿差异 key；若发布，汇报 releaseKey、变更 key 和 active 校验结果。
- 空文件默认拒绝；确需空值时，用户必须明确要求并传 `--allow-empty-value`。
- 新建 namespace 必须先跑 `namespace-plan`，再用 `namespace-create --create-authorization=explicit --expected-current-token=<plan token>`；没有用户明确授权时只做 `namespace-status`/`namespace-plan`。
- 新建 namespace 无法只建 pre：一次创建会覆盖该站点所有 env。不要用 `--allow-non-pre` 代替授权，也不要因为默认 env 是 `fql_pre` 就说线上不受影响。
- 目标 namespace 在任一 env 已存在时停止并报告 `NAMESPACE_ALREADY_EXISTS`。本 skill 不改名、不删除 namespace、不关联公共 namespace，也不处理发布系统配置 `__pub__`，只处理普通应用配置 `__app__`。
- 新建 namespace 后必须验证 `otherNamespacesUnchanged=true`、`targetNamespaceEmpty=true`、`hasActiveRelease=false`，且 public/加密/格式与请求一致、`fieldMismatches` 为空。
- namespace 名称只能包含字母、数字和下划线，含部门前缀不超过 64 字符；备注必填且 10-64 字符；加密存储只支持 `properties` 格式。public/private 由应用类型决定（实体应用=private，虚拟应用=public 且自动加 `<orgId>.` 前缀），不接受手工指定。
- 默认名单（`joneyshao`）的授权随 `namespace-create` 自动执行，不要再问用户；给默认名单以外的人授权只能通过 `namespace-grant --grant-authorization=explicit`，且必须显式传 `--grant-users`，不要凭猜测扩大名单。
- `namespace-create` 上的 `--grant-users` 只在同时传 `--grant-authorization=explicit` 时才生效；否则脚本报 `GRANT_AUTHORIZATION_REQUIRED`，不会静默按默认名单处理。
- 写配置前先看 `plan` 里的 `hasModifyPermission`（要发布再看 `hasReleasePermission`）。为 false 时按脚本给出的 `grantCommand` 自动跑一次 `namespace-grant` 自助补权限再重试，这一步不用问用户；`grantCommand` 已带 `--roles`，只补本次操作缺的角色（存草稿只补 modify，要发布才连 release 一起补），不要自行加角色；`namespace-grant` 报 `ASSIGN_ROLE_PERMISSION_DENIED` 就停止，把 `appId`、`namespace`、`appOwners` 报给用户让其申请权限，不要再重试、不要试图用别的接口写入。
- 授权只做加法。脚本不调用任何 remove role 接口；已经有该角色的用户直接跳过并计入 `alreadyGranted`，授权后必须验证 `nonTargetRoleUsersUnchanged=true`（没有用户被移除、没有非目标用户被加进来）。
- 发布权（`ReleaseNamespace`）意味着该用户可以对这个 namespace 的所有环境发起发布；除上述默认名单规则外，授权前要向用户确认名单，不要顺手把整组人都加上。

## 预置脚本

统一入口：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/scripts/hippo_draft_config.js <command> [options]
```

支持的 command：

- `doctor`：检查浏览器、登录态、Angular injector 和 `ConfigService` 新增/修改能力。
- `status`：只读查看目标草稿、active 状态和 namespace 草稿差异，不输出值。
- `plan`：读取 `--value-file`，计算 `create/update/noop` 及并发保护 token，不写入。
- `upsert`：新增或修改一个草稿项；相同内容自动 `noop`；默认不发布，只有显式授权参数齐全时才发布目标 key。
- `verify`：只读确认草稿等于文件，并报告 active release 是否也等于文件。
- `delete-plan`：只读；报告目标 key 是否在草稿/active、删除后 active 剩余 key、当前读取该 namespace active release 的实例数与样本（`instancesOnActiveRelease`），并给出 `delete-item` 必须原样回填的 `deleteAuthorizationValue` / `confirmEnvValue` / `currentStateToken`。
- `delete-item`：删除一个草稿项并可选发布该删除。必须同时满足：`--delete-authorization=<app>/<env>/<namespace>/<key>`（目标全路径，写错任一字段即拒绝，不接受常量）、`--confirm-env=<env>` 与解析环境一致、`--expected-current-token` 为本次 `delete-plan` 的 token、`--expected-instances` 等于 plan 的实例数（实例数变了必须重新 plan）；非 pre 环境还要 `--allow-non-pre`，公共 namespace（名称含 `.`）还要 `--allow-public-namespace`。目标不在草稿中时报 `TARGET_ITEM_MISSING`（草稿已删、active 仍有时可只补发布）；删除前后校验非目标项与 active release 未被误动。
- `namespace-status`：只读查看应用类型、目标 namespace 在各 env 是否已存在、namespace 分组和新建权限。
- `namespace-plan`：校验名称、备注、格式和加密组合，计算 `operation` 与并发保护 token，不写入。
- `namespace-create`：用户明确授权后新建 namespace，并回读校验非目标 namespace、空配置项和无 release。
- `namespace-roles`：只读查看某个 namespace 的修改权/发布权用户、当前账号是否有修改权/发布权/`AssignRole`、应用负责人。
- `namespace-grant`：给默认名单（不传 `--grant-users`）自助补修改权/发布权，或在用户明确授权后给指定用户授权，并回读校验。
- `self-test`：不访问网络，验证参数归一化、diff、namespace 校验和并发 token 等纯逻辑。

通用参数：

```text
--app-id=<应用名>                 可省略；从当前项目 app.properties 推断
--env=fql_pre                     默认当前站点的 pre；也接受 pre/gray/oa/prod/stable/test/testing/prj/project/测试/项目、
                                  mx/墨西哥/id/印尼，以及 fql_*、mxyw_*、ynyw_* 完整 env
--hippo-site=standard|stable|mx|id  可选；显式 env 如 pdwl_pre 需要 stable 域名时传 stable；
                                  mx=hippo.oa.wowcredito.com（墨西哥），id=hippo.oa.kredito.id（印尼）
--cluster=default                 默认 default
--namespace=application           默认 application
--key=<配置 key>                  doctor 之外必填
--value-file=<UTF-8 文件>         plan/upsert/verify 必填
--comment=<备注>                  可选；修改时缺省则保留原备注
--profile=/home/joney/.local/state/agent-tools/browser-profiles/healthy
--expected-current-token=<token>  覆盖已有未发布目标草稿时必填
--allow-non-pre                   非当前站点 pre 环境写入的二次保护
--allow-empty-value               明确允许写入空值
--publish                         用户明确授权后才允许；保存/校验后发布目标 key（stable 站点默认已自动发布，无需此参数）
--no-publish                      stable 站点只存草稿不自动发布；其它站点等同默认行为
--publish-authorization=explicit  发布二次保护，必须与 --publish 同时传
--release-title=<标题>            可选；缺省为 <时间戳>-release
--release-comment=<备注>          可选；缺省为脚本生成的目标路径备注
--emergency-publish               可选；按 Hippo 发布参数传 isEmergencyPublish=true
```

namespace 命令的专用参数：

```text
--namespace=<namespace 名>        namespace-* 命令里是目标 namespace 名，必填且没有默认值
--comment=<备注>                  namespace-plan/namespace-create 必填，10-64 字符；也可用 --comment-file
--format=properties               可选；properties/xml/sh/json/yml，默认 properties
--encrypt                         可选；加密存储，只有 properties 格式支持
--group-id=<分组 id>              可选；默认 0（不分组），且必须是该应用已有的 namespace 分组
--create-authorization=explicit   新建 namespace 的授权二次保护，必须与 namespace-create 同时传
--expected-current-token=<token>  namespace-create 必填，使用本次 namespace-plan 返回值
--grant-users=<id1,id2>           可选；不传就是默认名单（joneyshao）；传了必须配 --grant-authorization
--roles=modify,release            可选；默认同时授修改权和发布权
--grant-authorization=explicit    给默认名单以外的用户授权时的二次保护
--no-auto-grant                   可选；namespace-create 跳过默认名单的自动授权
```

## 标准流程

1. 明确 `appId/env/cluster/namespace/key`。appId 未给时从当前仓库 `app.properties` 推断；候选不唯一就停止并让用户确认。应用名或目标 key 所在 namespace 不确定时，先用 `query-hippo-config` 的 `apps --keyword=` 和 `find --key=`（都是只读）定位，确认到唯一的 `appId/namespace` 后再回到本 skill 写入，不要凭猜测往 `application` 里写。用户说 stable/测试/项目环境时传 `--env=stable` 或同义别名，并确认脚本输出的 `baseUrl` 是 `http://stable-hippo.oa.fenqile.com`、`env` 是 `fql_pre`。若要写 `pdwl_pre` 这类 navtree 显示的 stable env，传 `--env=pdwl_pre --hippo-site=stable`。用户说墨西哥或印尼时传 `--hippo-site=mx|id` 加 `--env=pre|prod`，并确认输出的 `baseUrl` 和 `env` 前缀（`mxyw_*`/`ynyw_*`）与目标国家一致，不确定 env 是否存在时先查该 app 的 `navtree`。
2. 把目标值保存到本地 UTF-8 文件。若值已在仓库文件中，直接使用该文件，不创建临时副本。
3. 可先运行 `doctor`（可加 `--hippo-site` 检查目标站点）；登录失效时调用 `get-browser-session`，标准环境目标 URL 使用 `http://hippo.oa.fenqile.com/#/app/dashboard`，stable/测试/项目环境使用 `http://stable-hippo.oa.fenqile.com/#/app/dashboard`，墨西哥使用 `https://hippo.oa.wowcredito.com/#/app/dashboard`，印尼使用 `https://hippo.oa.kredito.id/#/app/dashboard`，profile 保持 `/home/joney/.local/state/agent-tools/browser-profiles/healthy`。四个站点共用同一个 passport 登录态和同一个 profile。
4. 运行 `plan`，检查 `operation`、`targetHasUnpublishedDraft`、`draftDiffKeys`。非目标草稿只保留并报告，不得清除。
5. 若 `operation=noop`，草稿不必再写：`targetHasUnpublishedDraft=false` 时直接运行 `verify`；有未发布草稿且本次要发布（stable 自动发布或用户已授权）时仍运行 `upsert`（带 token），脚本在 noop 路径上只做发布并回读 active，不要跳过。若目标有未发布草稿且需覆盖，将刚返回的 `currentStateToken` 原样传给 `upsert`；用户没有明确授权覆盖目标草稿时先说明并等待确认。
6. 未授权发布时，运行 `upsert`。必须看到 `publishAttempted=false`、`activeReleaseKeyUnchanged=true`、`activeConfigurationsUnchanged=true`、`otherItemsUnchanged=true`；实际写入时还必须有 `targetItemValidated=true`。stable 站点例外：`upsert --env=stable` 会自动发布，输出应是 `autoPublish=true`，实际发布时 `published=true`、`activeChangedKeys` 只有目标 key、`nonTargetActiveConfigurationsUnchanged=true`；active 已等于目标值时是 `publishSkipped=true`。最终措辞写“stable 已自动发布目标 key”。
7. 用户已明确授权发布时，运行 `upsert --publish --publish-authorization=explicit --expected-current-token=<plan token>`。必须看到 `publishAttempted=true`、`published=true`、`activeChangedKeys` 只有目标 key、`nonTargetActiveConfigurationsUnchanged=true`。
8. 再运行 `verify`，确认草稿仍等于目标文件。最终明确写出“仅保存草稿，未发布”、“已按授权发布目标 key”或“stable 已自动发布目标 key”，不能模糊表述。

stable 站点的同一套操作，只多一个 `--env=stable`（墨西哥/印尼换成 `--hippo-site=mx|id`），先确认输出里的
`site`/`baseUrl` 指向目标站点再继续：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/scripts/hippo_draft_config.js namespace-status \
  --env=stable --app-id=server_hawk_decision_manage --namespace=encryption

node /home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/scripts/hippo_draft_config.js namespace-plan \
  --env=stable --app-id=server_hawk_decision_manage --namespace=encryption --comment="米霍克加解密相关配置"

node /home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/scripts/hippo_draft_config.js namespace-create \
  --env=stable --app-id=server_hawk_decision_manage --namespace=encryption --comment="米霍克加解密相关配置" \
  --create-authorization=explicit --expected-current-token=<stable 站点 namespace-plan 返回值>

node /home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/scripts/hippo_draft_config.js namespace-grant \
  --env=stable --app-id=server_hawk_decision_manage --namespace=encryption
```

## 已有 namespace 但没有权限

1. `status` 或 `plan` 输出 `hasModifyPermission=false`（或要发布时 `hasReleasePermission=false`），或 `upsert` 报 `NAMESPACE_MODIFY_PERMISSION_DENIED` / `NAMESPACE_RELEASE_PERMISSION_DENIED`。
2. 直接跑输出里的 `grantCommand`（`plan` 缺权限时也会给出，带 `--roles=`：存草稿只补 modify，要发布才 modify,release）；没有 `grantCommand` 时用原请求的 `--hippo-site=<site> --env=<env> --cluster=<cluster>` 跑 `namespace-grant --app-id=<appId> --namespace=<namespace> --roles=<本次需要的角色>`（不传 `--grant-users`，即给默认名单自助补权限），不需要再询问用户。优先复用错误里的 `details.grantArgv` 或已安全引用的 `grantCommand`；不能丢失站点后落入 standard 默认值。
3. 成功（`granted` 或 `alreadyGranted` 覆盖本次补的角色、`nonTargetRoleUsersUnchanged=true`）就回到原流程重跑 `plan`/`upsert`；不要为了"两个角色都有"再补一次 release。
4. 报 `ASSIGN_ROLE_PERMISSION_DENIED`：当前账号没有该应用的 Hippo 权限。停止，向用户说明“需要申请 `<appId>` 的 Hippo 权限”，并把 `details.appOwners` 列出来作为申请对象；不要重试，不要绕过。

## 新建 namespace 流程

1. 明确 `appId`、新 namespace 名和**站点**：用户说 stable/测试/项目环境就传 `--env=stable`，说墨西哥/印尼就传 `--hippo-site=mx|id`，否则是线上标准站点。先跑 `namespace-status`，确认 `site`/`baseUrl` 是目标站点、`operation=create`（各 env 都没有同名 namespace）、`hasCreateNamespacePermission=true`，并记下 `envs` 里会被影响的 env 列表。用户要求“线上和 stable 都建”时，两个站点各走一遍完整流程，token 不能跨站点复用。
2. 跑 `namespace-plan` 并带上备注，确认 `namespace`（公共应用会带 `<orgId>.` 前缀）、`format`、`isEncrypt`、`groupId` 都符合预期，记下 `currentStateToken`。
3. 向用户说明这次会在 `envs` 列出的所有 env 各建一个空 namespace，等待明确授权；没有授权就停在这一步。
4. 得到明确授权后跑 `namespace-create`，必须看到 `created=true`、`createdEnvs` 覆盖目标 env、`otherNamespacesUnchanged=true`、`targetNamespaceEmpty=true`、`hasActiveRelease=false`、`fieldMismatches` 为空。
5. `namespace-create` 的输出里检查 `autoGrant`：`skipped=false`、`nonTargetRoleUsersUnchanged=true`，且 `modifyRoleUsers`/`releaseRoleUsers` 包含默认名单。`granted` 为空而 `alreadyGranted` 有值是正常的，说明 Hippo 已经把创建者授权了。若 `autoGrant.reason=ASSIGN_ROLE_PERMISSION_DENIED`，namespace 已经建好但没授上权，要把 `autoGrant.pending` 报给用户去找有 `AssignRole` 权限的人补。
6. 只有需要给默认名单以外的人授权时，才跑 `namespace-roles` 看现状，并在用户明确授权后跑 `namespace-grant --grant-users=<确认过的名单> --grant-authorization=explicit`，确认 `granted` 覆盖目标用户和角色、`nonTargetRoleUsersUnchanged=true`。
7. 往新 namespace 写配置仍走原来的 `plan`/`upsert` 流程，只是 `--namespace=` 换成新 namespace；新建和授权本身都不写任何配置值。

创建前先校验全部授权参数。创建后若列表/详情/active 响应异常、目标环境缺失或字段不匹配，立即停止，不继续自动授权；namespace 可能已创建，先只读核对，不自动重建或清理。

## 示例

默认预发布 plan：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/scripts/hippo_draft_config.js plan \
  --app-id=server_hawk_decision_manage \
  --namespace=ai_config \
  --key=gpt_cr_aviator_role_user_prompt \
  --value-file=/absolute/path/prompt.md
```

保存草稿；仅当 plan 提示需要时添加 token：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/scripts/hippo_draft_config.js upsert \
  --app-id=server_hawk_decision_manage \
  --namespace=ai_config \
  --key=gpt_cr_aviator_role_user_prompt \
  --value-file=/absolute/path/prompt.md \
  --expected-current-token=<plan 返回值>
```

保存并按用户明确授权发布目标 key：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/scripts/hippo_draft_config.js upsert \
  --app-id=server_hawk_decision_manage \
  --namespace=ai_config \
  --key=gpt_cr_aviator_role_user_prompt \
  --value-file=/absolute/path/prompt.md \
  --expected-current-token=<plan 返回值> \
  --publish \
  --publish-authorization=explicit \
  --release-comment="authorized by user request"
```

检查新建 namespace 的前置状态：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/scripts/hippo_draft_config.js namespace-status \
  --app-id=server_hawk_decision_manage \
  --namespace=encryption
```

校验参数并取并发保护 token：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/scripts/hippo_draft_config.js namespace-plan \
  --app-id=server_hawk_decision_manage \
  --namespace=encryption \
  --comment="米霍克加解密相关配置"
```

用户明确授权后新建 namespace：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/scripts/hippo_draft_config.js namespace-create \
  --app-id=server_hawk_decision_manage \
  --namespace=encryption \
  --comment="米霍克加解密相关配置" \
  --create-authorization=explicit \
  --expected-current-token=<namespace-plan 返回值>
```

查看授权现状，以及给默认名单以外的人补授权（默认名单已由 `namespace-create` 自动授权）：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/scripts/hippo_draft_config.js namespace-roles \
  --app-id=server_hawk_decision_manage \
  --namespace=encryption

node /home/joney/projects/ai/agent-tools/skills/lexin/configure-hippo/scripts/hippo_draft_config.js namespace-grant \
  --app-id=server_hawk_decision_manage \
  --namespace=encryption \
  --grant-users=joneyshao \
  --roles=modify,release \
  --grant-authorization=explicit
```

## 失败处理

- `LOGIN_REQUIRED` / `ANGULAR_INJECTOR_UNAVAILABLE`：用下面的预置会话脚本刷新同一 profile，完成浏览器登录后重跑 `doctor`。这里显式收窄登录关键词，避免 Hippo 帮助文字中的“登录”造成误判。stable/测试/项目环境把 `--url` 换成 `http://stable-hippo.oa.fenqile.com/#/app/dashboard`，墨西哥换成 `https://hippo.oa.wowcredito.com/#/app/dashboard`，印尼换成 `https://hippo.oa.kredito.id/#/app/dashboard`。

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --ensure \
  --profile=/home/joney/.local/state/agent-tools/browser-profiles/healthy \
  --url=http://hippo.oa.fenqile.com/#/app/dashboard \
  --success-text=Welcome \
  --login-pattern='Work Happy|QR Code|Use MOA|Account Login|Password Login|乐空间传送门|ATrust'
```

- `HIPPO_SITE_INVALID`：`--hippo-site` 只接受 `standard`、`stable`、`mx`、`id` 及其别名；确认目标国家后重传，不要自造域名。
- `PROFILE_IN_USE`：不要删除原 profile；关闭占用它的 Chromium，或明确指定另一个已登录 profile。
- `CONCURRENT_DRAFT_CHANGED`：重新运行 `plan`，不要复用旧 token。
- `ACTIVE_RELEASE_CHANGED`：草稿可能已保存，但有人并发发布；立即停止，回读当前状态并向用户报告，不能自动回滚或再次写入。
- `NON_TARGET_ITEM_CHANGED`：立即停止并报告并发修改；不要覆盖其它 key。
- `DELETE_AUTHORIZATION_REQUIRED`：`--delete-authorization` 不是目标全路径（或用户根本没点名授权这个 key）；不要删除，回到用户处确认。
- `DELETE_ENV_CONFIRMATION_REQUIRED` / `PUBLIC_NAMESPACE_DELETE_REJECTED`：环境没有重复确认，或目标是公共 namespace；核对目标后由用户决定。
- `EXPECTED_TOKEN_REQUIRED_FOR_DELETE` / `EXPECTED_INSTANCES_REQUIRED` / `INSTANCE_COUNT_CHANGED`：缺少 `delete-plan` 的 token 或实例数，或实例数已变化；重新运行 `delete-plan`，把新结果给用户看过再删。
- `TARGET_ITEM_MISSING` / `ACTIVE_KEY_MISSING`：草稿里没有该 key，或 active release 里没有该 key（无需发布删除）；先核对目标。
- `DRAFT_DELETE_READBACK_TIMEOUT` / `PUBLISH_DELETE_READBACK_TIMEOUT`：删除或发布请求已发出但回读仍看到该 key；停止并人工核对，不要重复删除。
- `PUBLISH_AUTHORIZATION_REQUIRED`：用户没有明确授权发布，或脚本缺少 `--publish-authorization=explicit`；不要发布。
- `EXPECTED_TOKEN_REQUIRED_FOR_PUBLISH`：发布缺少本次 `plan` 的 `currentStateToken`；重新运行 `plan` 后再决定是否发布。
- `PUBLISH_REQUIRES_APPROVAL`：该环境需要走 Hippo 审批流；脚本不会绕过审批直接发布，向用户报告审批要求。
- `NON_TARGET_ACTIVE_CONFIG_CHANGED`：发布后 active release 出现非目标 key 变化；立即停止并报告，不要继续写入或二次发布。
- `NAMESPACE_NAME_REQUIRED`、`NAMESPACE_NAME_INVALID`、`NAMESPACE_NAME_TOO_LONG`、`NAMESPACE_COMMENT_INVALID`、`NAMESPACE_FORMAT_INVALID`、`NAMESPACE_ENCRYPT_UNSUPPORTED`：参数不满足 Hippo 页面校验；按提示改参数重跑，不要绕过校验直接调接口。
- `CREATE_AUTHORIZATION_REQUIRED`：用户没有明确授权新建 namespace；只输出 `namespace-plan` 结果并等待授权。
- `EXPECTED_TOKEN_REQUIRED_FOR_CREATE`、`CONCURRENT_NAMESPACE_CHANGED`：重新运行 `namespace-plan` 取新 token，不要复用旧 token。
- `NAMESPACE_ALREADY_EXISTS`：目标 namespace 已存在；确认用户是要往已有 namespace 写配置，还是要换一个名字。
- `CREATE_NAMESPACE_PERMISSION_DENIED`：当前账号没有该应用的新建 namespace 权限；让用户申请权限或换人操作。
- `NAMESPACE_GROUP_NOT_FOUND`：`--group-id` 不在该应用的分组里；用 `namespace-status` 看 `namespaceGroups` 后重传。
- `NAMESPACE_ENV_NOT_FOUND`：该应用在当前站点没有可用 env 或 cluster；确认 `--env`、`--hippo-site`、`--cluster`。
- `NAMESPACE_LIST_TRUNCATED`：namespace 数量超过单页上限，无法做非目标保护；停止并人工核对。
- `NAMESPACE_READBACK_TIMEOUT`、`NAMESPACE_NOT_EMPTY`、`NAMESPACE_UNEXPECTED_RELEASE`、`NAMESPACE_VERIFY_FAILED`、`NON_TARGET_NAMESPACE_CHANGED`：创建请求已经发出但回读异常；立即停止并人工核对，不要重复创建。
- `NAMESPACE_NOT_FOUND`：要授权的 namespace 不存在；先确认名字，或先走 `namespace-create`。
- `GRANT_AUTHORIZATION_REQUIRED`：用户没有明确授权；只输出 `namespace-roles` 结果并等待授权。
- `GRANT_USERS_REQUIRED`、`GRANT_USER_INVALID`、`NAMESPACE_ROLE_INVALID`：授权名单或角色参数不合法；和用户确认名单后重传，不要自行猜测用户 id。
- `NAMESPACE_MODIFY_PERMISSION_DENIED`、`NAMESPACE_RELEASE_PERMISSION_DENIED`：当前账号对该 namespace 没有修改权/发布权，`upsert` 在写入或发布前就停了；按 `details.grantCommand` 跑一次 `namespace-grant` 自助补权限后重试。
- `ASSIGN_ROLE_PERMISSION_DENIED`：当前账号没有该应用的 `AssignRole` 权限，自助补权限走不通，说明没有这个应用的 Hippo 权限；停止并告知用户去申请，`details.appOwners` 是可以找的应用负责人。`namespace-create` 遇到这种情况不会报错回滚，而是把结果放在 `autoGrant.reason` 和 `autoGrant.pending` 里，同样要明确报给用户。
- `GRANT_VERIFY_FAILED`、`NON_TARGET_ROLE_CHANGED`：授权请求已经发出但回读异常；立即停止并人工核对，不要重复授权。
