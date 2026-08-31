---
name: configure-hippo
description: 安全新增、修改并在明确授权后发布 Hippo 配置，支持标准 Hippo、stable/测试/项目环境以及墨西哥、印尼海外站点的独立域名；默认使用预发布 fql_pre 且只保存草稿、不发布。Use when 用户要求在 Hippo 配置中心新增 key、修改配置值、更新预发布或 stable 配置、修改墨西哥或印尼海外配置、把本地文件写入 namespace，或明确授权“修改并发布”；内置变更前检查、并发草稿保护、非目标项保护、key 粒度发布和 active release 校验。
metadata:
  version: 1.3.0
---

# configure-hippo

## 定位

新增或修改 Hippo namespace 中的单个配置项。默认只保存为未发布草稿；只有用户在当前对话明确授权发布时，才允许自动发布目标 key。默认环境为当前站点的 pre（国内 `fql_pre`）、cluster 为 `default`、namespace 为 `application`。

标准 Hippo 站点使用 `http://hippo.oa.fenqile.com`。stable/测试/项目环境使用独立站点 `http://stable-hippo.oa.fenqile.com`：`stable`、`test`、`testing`、`prj`、`project`、`测试`、`测试环境`、`项目`、`项目环境` 默认映射为 API env `fql_pre`，即只切换 Hippo 域名，其它 env 命名逻辑保持与原 Hippo 一致。若 `navtree` 显示 `pdwl_pre` 等业务前缀 env，显式传该 env 并加 `--hippo-site=stable`。

海外站点是独立域名加独立 env 前缀，不能沿用 `fql_*`：墨西哥 `https://hippo.oa.wowcredito.com` 对应 `mxyw_pre`、`mxyw_prod`，印尼 `https://hippo.oa.kredito.id` 只有 `ynyw_prod`，没有 pre，所以印尼站点缺省 env 就是 `ynyw_prod`。传 `--hippo-site=mx|id` 加 `--env=pre|prod`，或直接传完整 env（`mxyw_pre`、`ynyw_prod` 会自行路由到对应站点）。所有 `hippo.oa.*` 域名都是内网域名，脚本强制直连、不走代理。除站点域名和 env 前缀外，草稿检查、保存和回读逻辑相同。

本 skill 不回滚、不删除配置。未授权时不发布；用户明确说“可以发布”“授权发布”“修改并发布”等同义表达后，可以在保存草稿并回读校验后自动发布目标 key。纯查询实际生效值使用 `query-hippo-config`；登录态失效使用 `get-browser-session`。

`browser_session` MCP 优先用于登录态预检；由于该 MCP 只允许 GET，新增、修改和授权发布必须使用本 skill 的预置脚本。不要临时编写 Hippo PUT/POST 工具。

## 强制约束

- 默认 env 是当前站点的 pre 环境：标准和 stable 站点是 `fql_pre`，墨西哥是 `mxyw_pre`；印尼没有 pre，缺省 env 是 `ynyw_prod`。只有用户明确指定其它环境时才传 `--env`，且写入时必须同时传 `--allow-non-pre`。
- 印尼只有 `ynyw_prod`，任何印尼写入都等同于改线上：脚本不给印尼保留免二次确认的写入环境，必须由用户明确指定环境、传 `--allow-non-pre`，发布还要单独的明确授权。
- 根据 `--env` 和 `--hippo-site` 自动选择 Hippo 站点：stable/测试/项目环境走 `http://stable-hippo.oa.fenqile.com`，墨西哥走 `https://hippo.oa.wowcredito.com`，印尼走 `https://hippo.oa.kredito.id`，其它环境走 `http://hippo.oa.fenqile.com`。不要把 stable 环境请求发到标准站点，不要把线上/预发请求发到 stable 站点，也不要把海外请求发到国内站点。
- 默认动作仅是 upsert 草稿。没有用户明确授权时，不能传 `--publish`，也不能调用 release、publish、commitApprove 等发布动作。
- 授权发布只能通过 `upsert --publish --publish-authorization=explicit --expected-current-token=<plan token>` 执行；必须先运行 `plan`，并使用本次 `plan` 返回的 `currentStateToken`。
- 发布必须是 key 粒度：脚本只把目标 key 放入 `releaseSelectedItems`。不要发布整个 namespace，不要合并发布灰度分支，不要顺手发布其它草稿 key。
- 授权发布不等于绕过平台审批。若 Hippo 判断该环境需要审批，脚本必须停止并报告 `PUBLISH_REQUIRES_APPROVAL`，不能直接调用发布接口绕过流程。
- 配置值只从 UTF-8 文件读取；不要把长配置、token、密钥直接放进命令行或聊天内容。
- Hippo 页面正文可能包含“登录”说明，不能据此误判 session；以目标 host、Angular injector 和 `ConfigService` 就绪为准。
- 脚本复用 `browser_network` 对 Hippo 内网域名直连，仅清理子进程代理环境，不修改用户全局 VPS/代理配置。
- items 较大时由页面内原生 fetch 完整读取，避免 `fetch_with_session` 输出上限导致配置被截断。
- 变更前必须执行 `plan`。目标 key 已存在未发布改动时，写入必须携带本次 `plan` 返回的 `currentStateToken`，避免覆盖并发草稿。
- 未发布时保留同 namespace 的其它草稿。写入后必须验证非目标项未变化、active `releaseKey` 和完整 `configurations` 未变化；授权发布后必须验证 active release 只有目标 key 变化。
- 不输出 Cookie、token 或配置原文。最终只汇报目标路径、操作类型、长度/行数/hash、草稿差异 key；若发布，汇报 releaseKey、变更 key 和 active 校验结果。
- 空文件默认拒绝；确需空值时，用户必须明确要求并传 `--allow-empty-value`。

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
- `self-test`：不访问网络，验证参数归一化、diff 和并发 token 等纯逻辑。

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
--profile=/home/joney/.cache/healthy-dashboard-profile
--expected-current-token=<token>  覆盖已有未发布目标草稿时必填
--allow-non-pre                   非当前站点 pre 环境写入的二次保护
--allow-empty-value               明确允许写入空值
--publish                         用户明确授权后才允许；保存/校验后发布目标 key
--publish-authorization=explicit  发布二次保护，必须与 --publish 同时传
--release-title=<标题>            可选；缺省为 <时间戳>-release
--release-comment=<备注>          可选；缺省为脚本生成的目标路径备注
--emergency-publish               可选；按 Hippo 发布参数传 isEmergencyPublish=true
```

## 标准流程

1. 明确 `appId/env/cluster/namespace/key`。appId 未给时从当前仓库 `app.properties` 推断；候选不唯一就停止并让用户确认。应用名或目标 key 所在 namespace 不确定时，先用 `query-hippo-config` 的 `apps --keyword=` 和 `find --key=`（都是只读）定位，确认到唯一的 `appId/namespace` 后再回到本 skill 写入，不要凭猜测往 `application` 里写。用户说 stable/测试/项目环境时传 `--env=stable` 或同义别名，并确认脚本输出的 `baseUrl` 是 `http://stable-hippo.oa.fenqile.com`、`env` 是 `fql_pre`。若要写 `pdwl_pre` 这类 navtree 显示的 stable env，传 `--env=pdwl_pre --hippo-site=stable`。用户说墨西哥或印尼时传 `--hippo-site=mx|id` 加 `--env=pre|prod`，并确认输出的 `baseUrl` 和 `env` 前缀（`mxyw_*`/`ynyw_*`）与目标国家一致，不确定 env 是否存在时先查该 app 的 `navtree`。
2. 把目标值保存到本地 UTF-8 文件。若值已在仓库文件中，直接使用该文件，不创建临时副本。
3. 可先运行 `doctor`（可加 `--hippo-site` 检查目标站点）；登录失效时调用 `get-browser-session`，标准环境目标 URL 使用 `http://hippo.oa.fenqile.com/#/app/dashboard`，stable/测试/项目环境使用 `http://stable-hippo.oa.fenqile.com/#/app/dashboard`，墨西哥使用 `https://hippo.oa.wowcredito.com/#/app/dashboard`，印尼使用 `https://hippo.oa.kredito.id/#/app/dashboard`，profile 保持 `/home/joney/.cache/healthy-dashboard-profile`。四个站点共用同一个 passport 登录态和同一个 profile。
4. 运行 `plan`，检查 `operation`、`targetHasUnpublishedDraft`、`draftDiffKeys`。非目标草稿只保留并报告，不得清除。
5. 若 `operation=noop`，无需写入，直接运行 `verify`。若目标有未发布草稿且需覆盖，将刚返回的 `currentStateToken` 原样传给 `upsert`；用户没有明确授权覆盖目标草稿时先说明并等待确认。
6. 未授权发布时，运行 `upsert`。必须看到 `publishAttempted=false`、`activeReleaseKeyUnchanged=true`、`activeConfigurationsUnchanged=true`、`otherItemsUnchanged=true`；实际写入时还必须有 `targetItemValidated=true`。
7. 用户已明确授权发布时，运行 `upsert --publish --publish-authorization=explicit --expected-current-token=<plan token>`。必须看到 `publishAttempted=true`、`published=true`、`activeChangedKeys` 只有目标 key、`nonTargetActiveConfigurationsUnchanged=true`。
8. 再运行 `verify`，确认草稿仍等于目标文件。最终明确写出“仅保存草稿，未发布”或“已按授权发布目标 key”，不能模糊表述。

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

## 失败处理

- `LOGIN_REQUIRED` / `ANGULAR_INJECTOR_UNAVAILABLE`：用下面的预置会话脚本刷新同一 profile，完成浏览器登录后重跑 `doctor`。这里显式收窄登录关键词，避免 Hippo 帮助文字中的“登录”造成误判。stable/测试/项目环境把 `--url` 换成 `http://stable-hippo.oa.fenqile.com/#/app/dashboard`，墨西哥换成 `https://hippo.oa.wowcredito.com/#/app/dashboard`，印尼换成 `https://hippo.oa.kredito.id/#/app/dashboard`。

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --ensure \
  --profile=/home/joney/.cache/healthy-dashboard-profile \
  --url=http://hippo.oa.fenqile.com/#/app/dashboard \
  --success-text=Welcome \
  --login-pattern='Work Happy|QR Code|Use MOA|Account Login|Password Login|乐空间传送门|ATrust'
```

- `HIPPO_SITE_INVALID`：`--hippo-site` 只接受 `standard`、`stable`、`mx`、`id` 及其别名；确认目标国家后重传，不要自造域名。
- `PROFILE_IN_USE`：不要删除原 profile；关闭占用它的 Chromium，或明确指定另一个已登录 profile。
- `CONCURRENT_DRAFT_CHANGED`：重新运行 `plan`，不要复用旧 token。
- `ACTIVE_RELEASE_CHANGED`：草稿可能已保存，但有人并发发布；立即停止，回读当前状态并向用户报告，不能自动回滚或再次写入。
- `NON_TARGET_ITEM_CHANGED`：立即停止并报告并发修改；不要覆盖其它 key。
- `PUBLISH_AUTHORIZATION_REQUIRED`：用户没有明确授权发布，或脚本缺少 `--publish-authorization=explicit`；不要发布。
- `EXPECTED_TOKEN_REQUIRED_FOR_PUBLISH`：发布缺少本次 `plan` 的 `currentStateToken`；重新运行 `plan` 后再决定是否发布。
- `PUBLISH_REQUIRES_APPROVAL`：该环境需要走 Hippo 审批流；脚本不会绕过审批直接发布，向用户报告审批要求。
- `NON_TARGET_ACTIVE_CONFIG_CHANGED`：发布后 active release 出现非目标 key 变化；立即停止并报告，不要继续写入或二次发布。
