---
name: manage-publish-order
description: 在乐信发布系统 publish3（publish3.oa.fenqile.com）为乐效需求准备前端发布单：先把需求分支合并到前端发布分支（默认 product）并推送，再在“应用版本发布”新建前端发布单（线上、版本/补丁、预发布+灰度+线上）并打包；不推送、不发布、不回滚、不结单。Use when 用户要求合并前端代码到 product 后建发布单、新建前端发布单、给发布单打包、查看自己的发布单；后端发布单后续补充；不负责发布计划（用 manage-publish-plan）、乐效部署或推送上线。
metadata:
  version: 1.0.0
---

# manage-publish-order

## 定位

- 治理：前端发布单的准备工作，分三步：需求分支合入前端发布分支 → 新建前端发布单 → 打包。
- 不治理：推送预发布/灰度/线上、一键发布、回滚、结单（都由用户在页面操作）；发布计划（`manage-publish-plan`）；乐效集成部署（`lexiao-deploy`）；后端发布单（后续补充，脚本对 `--project-type=backend` 直接报错）。
- 关系：发布计划审批通过后再建发布单；前后端同需求时前端先发布，后端发布单之后补。

## 脚本

```bash
S=/home/joney/projects/ai/agent-tools/skills/lexin/manage-publish-order/scripts/publish_order.js
node $S merge  --repo=<前端仓库> [--branch=<需求分支>] [--target=product] [--dry-run]
node $S list   [--app=<应用名>] [--creator=<OA用户名>]
node $S create --app=<应用名> --desc='<发布版本描述>' [--pub-type=version|patch] [--envs=pre,gray,prod] \
               [--repo=<前端仓库> --feature=<需求分支>] [--allow-open] [--dry-run]
node $S pack   --id=<发布单号> [--dry-run]
```

| 子命令 | 作用 | 写入 |
|---|---|---|
| `merge` | 在临时 worktree 里把 `origin/<需求分支>` 用 `merge --no-ff` 合入 `origin/product` 并推送，提交信息 `Merge branch '<分支>' into product`（仓库惯例）；不动本地工作区 | git 推送 |
| `list` | 列出发布单：单号、应用、分支、tag、环境、状态、描述 | 否 |
| `create` | 按页面填表并点“创建”，回读单号 | publish3 |
| `pack` | 打开发布单详情点“打包”，确认弹框，等“打包成功”，确认“更新文件” | publish3 |

## 工作流（前端）

1. 合并：`merge --dry-run` 先列出将合入 product 的提交和文件给用户看；确认后去掉 `--dry-run`。需求分支必须已推送且与远端一致；已合入时直接跳过；有冲突时停止，回需求分支先合 `origin/product` 解决后再来。
2. 查重：`list --app=<应用>` 看有没有未结单的发布单；有则先问用户（结单或加 `--allow-open`）。
3. 建单：`create --dry-run` 填表并打印表单状态；确认后正式创建。默认值：
   - 发布环境类型“线上”；发布类型“版本”（需求功能新增），线上问题或需求优化用 `--pub-type=patch`。
   - 发布分支 `product`；版本 tag 由页面按类型自动生成（如 `1.65.0`），选完分支要等几秒。
   - 发布环境勾选预发布、灰度、线上（与前端发布指南一致），其他环境不勾；他人结单提醒、打包完成提醒、发布 CDN 文件保持“否”。
   - 发布版本描述一句话，形如 `feat: 【米霍克】<需求功能> tapdId: <ID>`，只写前端内容。
   - 传 `--repo` 与 `--feature` 时，创建前校验需求分支已合入 `origin/product`。
4. 打包：`pack --id=<单号>`。按钮显示“已打包”时直接报告、不重复打包。打包成功后看文件状态，提示冲突时点“查看详情”，按提示联系对应同事结单后再继续。
5. 汇报单号和详情链接（`#/verPub/FrontPubDetail?id=<单号>`），提醒用户按顺序推送预发布 → 灰度 → 线上、逐台确认成功，前端推完再发后端，上线验证后结单。

## 授权与安全

- 创建和打包会被 Claude Code 安全检查视为线上发布类操作；用户在当前对话明确说“只点创建/创建并打包”后才执行，且只做用户说的那一步。
- 脚本只点“创建”“打包”和它们的确认按钮，从不点“一键发布”“推送发布”“回滚”“结单”“结单并建单”；另对路径像推送、回滚、结单的非 GET 请求做拦截（尽力而为，真正的保护是不点这些按钮）。
- 读接口在已登录页面内调用：`publish_server.oa.fenqile.com/publishOrder/list`（表单编码，按 creator/appName 过滤，字段含 id、appName、branch、versionTag、envList、orderStatusValue、desc）、`loginInfo/currentUser`；新建走页面，接口为 `publishOrder/addIncrementOrder`，返回单号。

## 已知坑

- `#/verPub` 列表页不能直接打开（会跳回首页），要从“应用发布 → 应用版本发布”菜单进入；应用加载完成后，详情页 `#/verPub/FrontPubDetail?id=<单号>` 可以直接跳转。脚本已处理。
- “前端发布 → 发布单管理 → 新建前端发布单”是旧 Pub 工程（填工程名、文件列表），页面提示已低维护，不要用。
- 选应用后表单才出现“发布环境类型/发布类型/发布分支”；切到“线上”后出现“发布环境”多选，复选框文字里混有机器 IP 弹层，按 `input[value=pre|gray|prod]` 定位。
- 版本 tag 由 `tagLog/preGenerate` 异步生成，填表后要等它出现再创建。
- publish3 会间歇断连，导航有重试；页面慢时以“应用发布”菜单出现为就绪标志。

## 未覆盖

- `pack` 按发布指南与页面文案实现，尚未在真实发布单上执行过；第一次使用时要看着输出确认每个弹框都被正确处理，失败就停下让用户在页面上操作。
- 后端发布单、补丁类型、OA/稳定等其他环境组合、发布 CDN 文件未实测。
