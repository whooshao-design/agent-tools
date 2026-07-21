---
name: configure-hippo
description: 安全新增或修改 Hippo 配置草稿，默认使用预发布 fql_pre 且只保存、不发布。Use when 用户要求在 Hippo 配置中心新增 key、修改配置值、更新预发布配置、把本地文件写入 namespace，或明确要求“修改 Hippo 但不要发布”；内置变更前检查、并发草稿保护、非目标项保护和 active release 未变化校验。
metadata:
  version: 1.0.0
---

# configure-hippo

## 定位

新增或修改 Hippo namespace 中的单个配置项，并将结果保留为未发布草稿。默认环境为 `fql_pre`、cluster 为 `default`、namespace 为 `application`。

本 skill 不发布、不回滚、不删除配置。纯查询实际生效值使用 `query-hippo-config`；登录态失效使用 `get-browser-session`；需要发布时停止并明确交由用户手工处理，不能扩展本流程顺手发布。

`browser_session` MCP 优先用于登录态预检；由于该 MCP 只允许 GET，新增/修改必须使用本 skill 的预置脚本。不要临时编写 Hippo PUT/POST 工具。

## 强制约束

- 默认 env 固定为 `fql_pre`。只有用户明确指定其它环境时才传 `--env`，且写入时必须同时传 `--allow-non-pre`。
- 默认动作仅是 upsert 草稿。脚本没有发布入口，也不能调用 release、publish、commitApprove 等发布动作。
- 配置值只从 UTF-8 文件读取；不要把长配置、token、密钥直接放进命令行或聊天内容。
- Hippo 页面正文可能包含“登录”说明，不能据此误判 session；以目标 host、Angular injector 和 `ConfigService` 就绪为准。
- 脚本复用 `browser_network` 对 Hippo 内网域名直连，仅清理子进程代理环境，不修改用户全局 VPS/代理配置。
- items 较大时由页面内原生 fetch 完整读取，避免 `fetch_with_session` 输出上限导致配置被截断。
- 变更前必须执行 `plan`。目标 key 已存在未发布改动时，写入必须携带本次 `plan` 返回的 `currentStateToken`，避免覆盖并发草稿。
- 保留同 namespace 的其它草稿。写入后必须验证非目标项未变化、active `releaseKey` 和完整 `configurations` 未变化。
- 不输出 Cookie、token 或配置原文。最终只汇报目标路径、操作类型、长度/行数/hash、草稿差异 key 和未发布校验结果。
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
- `upsert`：新增或修改一个草稿项；相同内容自动 `noop`；永不发布。
- `verify`：只读确认草稿等于文件，并报告它是否仍是未发布差异。
- `self-test`：不访问网络，验证参数归一化、diff 和并发 token 等纯逻辑。

通用参数：

```text
--app-id=<应用名>                 可省略；从当前项目 app.properties 推断
--env=fql_pre                     默认 fql_pre；也接受 pre/gray/oa/prod
--cluster=default                 默认 default
--namespace=application           默认 application
--key=<配置 key>                  doctor 之外必填
--value-file=<UTF-8 文件>         plan/upsert/verify 必填
--comment=<备注>                  可选；修改时缺省则保留原备注
--profile=/tmp/healthy-dashboard-profile
--expected-current-token=<token>  覆盖已有未发布目标草稿时必填
--allow-non-pre                   非 fql_pre 写入的二次保护
--allow-empty-value               明确允许写入空值
```

## 标准流程

1. 明确 `appId/env/cluster/namespace/key`。appId 未给时从当前仓库 `app.properties` 推断；候选不唯一就停止并让用户确认。
2. 把目标值保存到本地 UTF-8 文件。若值已在仓库文件中，直接使用该文件，不创建临时副本。
3. 可先运行 `doctor`；登录失效时调用 `get-browser-session`，目标 URL 使用 `http://hippo.oa.fenqile.com/#/app/dashboard`，profile 保持 `/tmp/healthy-dashboard-profile`。
4. 运行 `plan`，检查 `operation`、`targetHasUnpublishedDraft`、`draftDiffKeys`。非目标草稿只保留并报告，不得清除。
5. 若 `operation=noop`，无需写入，直接运行 `verify`。若目标有未发布草稿且需覆盖，将刚返回的 `currentStateToken` 原样传给 `upsert`；用户没有明确授权覆盖目标草稿时先说明并等待确认。
6. 运行 `upsert`。必须看到 `publishAttempted=false`、`activeReleaseKeyUnchanged=true`、`activeConfigurationsUnchanged=true`、`otherItemsUnchanged=true`；实际写入时还必须有 `targetItemValidated=true`。
7. 再运行 `verify`，确认 `draftEqualsDesired=true`。最终明确写出“仅保存草稿，未发布”。

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

## 失败处理

- `LOGIN_REQUIRED` / `ANGULAR_INJECTOR_UNAVAILABLE`：用下面的预置会话脚本刷新同一 profile，完成浏览器登录后重跑 `doctor`。这里显式收窄登录关键词，避免 Hippo 帮助文字中的“登录”造成误判。

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --ensure \
  --profile=/tmp/healthy-dashboard-profile \
  --url=http://hippo.oa.fenqile.com/#/app/dashboard \
  --success-text=Welcome \
  --login-pattern='Work Happy|QR Code|Use MOA|Account Login|Password Login|乐空间传送门|ATrust'
```

- `PROFILE_IN_USE`：不要删除原 profile；关闭占用它的 Chromium，或明确指定另一个已登录 profile。
- `CONCURRENT_DRAFT_CHANGED`：重新运行 `plan`，不要复用旧 token。
- `ACTIVE_RELEASE_CHANGED`：草稿可能已保存，但有人并发发布；立即停止，回读当前状态并向用户报告，不能自动回滚或再次写入。
- `NON_TARGET_ITEM_CHANGED`：立即停止并报告并发修改；不要覆盖其它 key。
