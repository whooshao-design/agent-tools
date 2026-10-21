---
name: manage-publish-plan
description: 在乐信发布系统 publish3（publish3.oa.fenqile.com）为乐效流程需求新建“普通应用发布”前端发布计划，或修改尚未提交审批（待审批、列表有“修改”按钮）的计划的版本描述与通知方式；先用历史计划取默认值并经用户确认，按前端发布指南模板写版本描述并检查是否混入后端事项，先 dry-run 预览再保存，写后回读校验，复用 get-browser-session 浏览器登录态。Use when 用户要求在 publish3 建发布计划、给需求建前端发布计划、修改发布计划的版本描述、查看自己的历史发布计划或某个计划详情、查看业务名对应的审批人选项；不负责后端计划（后续补充）、发布申请、删除计划、发布单、打包推送，也不负责乐效集成部署或 Hippo 配置。
metadata:
  version: 1.0.0
---

# manage-publish-plan

## 定位

- 治理：publish3 上“普通应用发布”类型的**前端**发布计划。能查历史计划、看计划详情、列出业务名联动的审批人选项、新建计划、修改待审批计划的版本描述与通知提醒。
- 不治理：后端发布计划（后续补充）；列表行上的“发布申请”（提交审批）和“删除”；发布单（发布指南 7.2 的打包、推送预发布/灰度/线上、结单）；紧急发布与跨团队项目。这些都由用户在页面上操作。
- 相邻 skill：
  - `lexiao-deploy`：乐效里的分支集成、构建、部署到项目环境或预发布。本 skill 只建 publish3 的发布计划，不碰乐效。
  - `manage-tqm-test-cases`：TQM 用例的创建与执行结果。
  - `lexiao-hippo-publish-authorize`：在乐效版本里登记需随版本发布的 Hippo namespace。Hippo 事项登记在那里，不写进前端发布计划。
  - `configure-hippo`：改 Hippo 配置值或发布配置。
  - `get-browser-session`：登录态层。本 skill 只复用 `main` profile，不处理登录。

## 关键规则

1. 一个发布计划只写本计划所含应用的内容。前端计划的版本描述只写前端改动和对前端发布的影响。后端事项写进后端计划，不写进前端计划，包括 Hippo 配置发布、后端应用名、后端配置项、数据库变更。跨端依赖最多写一句“本版本需先于/后于后端发布”，不展开后端细节。
   - 正例：`references/plan.frontend.example.json` 的 `description`（需求 1426731、计划 44107 修改后的版本）。
   - 反例：前端计划“7、其他事项”写“发布顺序：前端 web_mihawk_oa 先发布，后端 server_hawk_decision_manage 后发布；Hippo 配置 package_copy_real_time_query_confirm 随版本发布”。
   - 脚本会检查前端描述里的 Hippo、namespace、`server_`/`server-` 应用名、SQL、DDL、ALTER/CREATE/DROP TABLE、数据库、建表、加字段、刷数，命中即拒绝。只有用户确认这些确实属于前端内容时，才加 `--allow-backend-terms`。
2. 默认值先用 `history` 取用户的历史计划，向用户确认后再用，包括业务名、抄送测试、leader、总监、通知方式。版本描述里“是否已发送发布周知”和“CR情况”必须问用户，不能自己假设。
3. 写入前完整打印表单内容，并提醒“保存后进入待审批”。先跑 `--dry-run`：它会填表、截图、打印各字段值，但不保存。用户确认后再去掉 `--dry-run` 正式保存。
4. 同一需求已有待审批或审批通过且未过有效期的计划（或 `validity=true`）时，`create` 拒绝重复创建，提示改用 `modify`。
5. 不点“发布申请”和“删除”，不建发布单，不打包推送。脚本会拦截 publish_server 上路径含 delete/remove/apply/approve/submit 的请求；dry-run 和只读命令还会拦截所有 publishPlan 写接口。

## 脚本

```bash
S=/home/joney/projects/ai/agent-tools/skills/lexin/manage-publish-plan/scripts/publish_plan.js
node $S history [--creator=<OA用户名>] [--limit=N]      # 默认当前登录用户、最近 10 条
node $S options [--biz=<业务名>]                         # 不传 --biz 列出全部业务名
node $S show    --id=<计划ID>
node $S create  --file=<plan.json> [--dry-run] [--allow-backend-terms] [--screenshot-dir=<dir>]
node $S modify  --id=<计划ID> --file=<patch.json> [--dry-run] [--allow-backend-terms] [--screenshot-dir=<dir>]
```

- 读接口在已登录的 publish3 页面里用 `fetch(credentials:'include')` 调 `https://publish_server.oa.fenqile.com/`，请求为 POST、表单编码。`publishPlan/list` 按 `creator` 或 `id` 过滤；`publishPlan/getPublishPlanDetailList` 的参数是 `id=<计划ID>`，不是 planId。Cookie 不出浏览器、不落盘、不输出。浏览器经 `launchLockedContext` 启动，强制直连。
- 写入走真实页面表单，由页面组装载荷：新建点“保存”，修改点“修改”，然后在“确认保存发布计划吗?”弹框里点“确定”。新建接口 `publishPlan/add` 返回 `{"status":0,"data":<计划ID>}`。
- `main` profile 有跨进程锁，一次只跑一个命令，不要并行。
- 截图默认放在 `/tmp/agent-work/<YYYYMMDD>-publish-plan/`，任务结束后按全局临时文件规则清理。

| 子命令 | 作用 | 写平台 |
|---|---|---|
| `history` | 历史计划摘要：id、创建时间、上线日期、需求、bizLine、approvers、通知、状态、validity、应用、需求名称 | 否 |
| `options` | 选业务名后列出抄送测试、leader、总监的可选项和页面默认值，并列出 notify 取值 | 否 |
| `show` | 计划字段、版本描述、应用明细 | 否 |
| `create` | 校验与查重 → 填表 → 打印并截图；不带 `--dry-run` 时保存，抓取新 ID，再用 list 和 detail 回读校验 | 是（不带 `--dry-run` 时） |
| `modify` | 只改 `description` 和 `notify`，其他字段保持原值；要求计划待审批且列表行有“修改”；回读校验 version 加 1、描述和通知一致、应用明细不变 | 是（不带 `--dry-run` 时） |

## 工作流

1. 读发布指南模板。前端发布指南在飞书 wiki `https://lexin.feishu.cn/wiki/DrOFwKwq0iiKqvk1603cKrCmnHk`，第 7.1 节“新建审批单”给出版本描述模板。用 `manage-feishu-doc` 读取：`node /home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc.mjs read --target=<链接> --scope=keyword --keyword='新建审批单' --context-after=40`。读不到时以示例 plan.json 的 7 段结构为准。
2. 取默认值：跑 `history`，把最近计划的业务名（列表里显示的是 bizLine，例如“风控业务线”；表单要选中心名，例如“风控研发中心”）、approvers、通知方式列给用户确认。拿不准时用 `options --biz=<业务名>` 看可选项。同时询问“是否已发送发布周知”和“CR情况”。
3. 区分前端和后端：每份计划只写本端内容。后端事项（Hippo、后端应用、配置、数据库）留给后端计划，前端描述里最多写一句发布先后依赖。
4. 写 plan.json：放在任务临时目录，字段见下表，可以复制示例再改。
5. 跑 `create --file=<plan.json> --dry-run`，把打印的表单内容和截图路径给用户看，并提醒“保存后进入待审批”。
6. 用户确认后去掉 `--dry-run` 正式保存，汇报计划 ID 和回读结果。
7. 回读汇报后提醒用户：米霍克发布前要在“米霍克问题沟通群”@所有人发升级提醒（文案模板见发布指南），这一步由用户自己发；计划审批通过后，再由用户按指南 7.2 建发布单。

修改计划时：先 `show --id=<ID>` 看现状，写只含 `description` 和/或 `notify` 的 patch.json，跑 `modify --dry-run` 给用户确认，再正式修改。

## plan.json 字段

示例：`/home/joney/projects/ai/agent-tools/skills/lexin/manage-publish-plan/references/plan.frontend.example.json`（需求 1426731 / web_mihawk_oa）。示例的 `onlineDate` 已过期时，换成真实上线日期再用。

| 字段 | 必填 | 说明 |
|---|---|---|
| `biz` | 是 | 业务名下拉里的中心名，例如“风控研发中心” |
| `projectType` | 是 | 只接受 `frontend`；`backend` 直接报错“后端计划暂不支持，后续补充” |
| `demandIds` | 是 | TAPD 需求 ID，数组或逗号分隔字符串；页面据此带出需求名称和链接 |
| `onlineDate` | 是 | `YYYY-MM-DD`，不能早于今天（有效期到次日 06:00） |
| `test` / `leader` / `director` | 是 | 抄送测试 / leader审批 / 抄送总监的选项原文，例如 `无需测试`、`jaydeng`、`skywalkerzhang` |
| `notify` | 是 | `none`（无需通知）、`diy`（自定义，以版本描述作为通知内容）、`risk`（风控政策）、`oracle`（oracle凭证测试）、`report`（OA报表检查）；只实测过 `none` |
| `description` | 是 | 版本描述，字符串或按行的数组 |
| `apps` | 是 | 应用名数组，按发布顺序；搜索结果按应用名精确匹配 |
| `crossTeam` | 否 | 只接受 `false`（业务线内项目） |
| `env` | 否 | 只接受 `prod`（线上） |

patch.json 只允许 `description`、`notify` 两个字段，写法同上。

## 字段说明与已知坑

- 页面加载慢，偶尔还会断连。脚本用 `domcontentloaded` 打开页面，再等“业务名”标签（新建页）或版本描述 textarea 有值（修改页），每次最多等 45s，超时会刷新一次。导航遇到 `net::ERR_*` 重试 3 次，读接口遇到 `Failed to fetch` 重试 1 次。不要改成固定 sleep。
- 业务名与 bizLine 不一致：下拉选“风控研发中心”，记录和列表里显示“风控业务线”。
- 审批人随业务名联动：必须先选业务名，再点开抄送测试、leader、总监的下拉。“风控研发中心”下，抄送测试的选项是 无需测试/demiwang/billyzhao，leader 是 jaydeng，总监是 skywalkerzhang。选完业务名后，页面会自动带出 leader 和总监。approvers 字段形如 `,jaydeng,skywalkerzhang`，首位为空表示抄送测试选了“无需测试”。
- 填需求 ID 并失焦后，页面可能提示“需求未按分支命名规范提交代码，无法自动填充发布应用”。这是正常提示，应用由脚本在“选择应用”弹窗里按名称精确匹配。搜索是模糊匹配，例如 `web_mihawk_oa` 会同时搜出 `web-mihawk-oa-lxrd` 等应用。
- 保存和修改都会弹出 el-message-box“确认保存发布计划吗?”，必须点“确定”才会提交。修改页的提交按钮文字是“修改”，不是“保存”。
- 修改页里通知提醒 radio 的选中状态不一定渲染出来，所以脚本保存前会显式点一次目标值（未改时点原值）。修改后 version 加 1，modifyTime 更新；应用明细会重建，明细 id 会变，内容不变。
- 上线日期决定发布类型：页面按日期调 `publishWindow/getPublishType`，日期不在正常发布窗口时（2026-10-21 实测，2026-10-23 周五）会切成紧急发布，多出“紧急原因类型”“总监审批”“抄送GM”字段。脚本检测到这种情况就停止，提示换日期或由用户在页面上走紧急发布。
- 计划有效期是上线当天 00:00 到次日 06:00，过期自动失效。`validity` 只在有效期内为 true，待审批但未到上线日的计划 `validity=false`，所以查重同时看审批状态和上线日期。
- 只有待审批、尚未提交发布申请的计划，列表行才有“修改 / 删除 / 发布申请”三个按钮。脚本只认“修改”，不点其他两个。
- 脚本报 `publish3 login required` 或 `non-JSON response` 时，按 `get-browser-session` 的流程处理登录：MCP 优先用 `browser_session.ensure_session`，脚本兜底用 `node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js --ensure --url=https://publish3.oa.fenqile.com/ --success-text=none`。不要在聊天里索取密码、OTP 或 Cookie。

## 未覆盖

- 后端发布计划后续补充。目前 `projectType=backend` 直接报错；后端事项（Hippo、后端应用、配置、数据库）写进后端计划，不写进前端计划。
- 紧急发布、跨团队项目未实测，脚本也不支持。多个应用（插入行）和 `notify` 除 `none` 外的取值未实测，脚本会校验最终的应用顺序和通知值，不一致就报错。
- 正式保存（`publishPlan/add`）和修改提交的接口路径只按 2026-10-21 主会话的人工实测记录实现，本 skill 交付时没有对平台做真实写入；首次正式使用时要核对脚本输出的回读结果。
- 删除计划、发布申请、发布单、上传附件、工程列表（老 pub 工程）不做。
