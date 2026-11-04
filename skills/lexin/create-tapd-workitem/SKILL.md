---
name: create-tapd-workitem
description: 在 TAPD（www.tapd.cn）新建工作项，目前只支持缺陷：按项目的缺陷模板列出字段与必填项，按 JSON 填表并先 dry-run，确认后点“创建”并回读标题与处理人，复用 get-browser-session 浏览器登录态。Use when 用户要求建 TAPD 缺陷单、把整理好的缺陷描述提交到 TAPD、查看某个 TAPD 项目的缺陷模板和必填字段；需求单创建尚未支持，只读需求原文用 fetch-tapd-story。
metadata:
  version: 1.0.0
---

# create-tapd-workitem

## 定位

- 治理：在 TAPD 项目里新建缺陷（bug）。列模板与字段、按 JSON 填表、dry-run 预览、点“创建”、回读结果。
- 后续扩展：新建需求（story）。现在没有实测过需求的新建页，不要用本 skill 建需求。
- 不治理：修改或流转已有缺陷、评论、关联需求或迭代、上传附件、删除；只读需求原文用 `fetch-tapd-story`。
- 登录态由 `get-browser-session` 的 `main` profile 提供；TAPD 的 WAF 会拦截 HeadlessChrome UA，脚本固定使用普通 Chrome UA。

## 脚本

```bash
S=/home/joney/projects/ai/agent-tools/skills/lexin/create-tapd-workitem/scripts/tapd_workitem.js
node $S login  --workspace=<项目ID>                       # 打开有界面浏览器，用户登录后自动关闭（最多等 8 分钟）
node $S fields --workspace=<项目ID> [--template=<模板ID>]  # 只读：列模板 ID、字段名、类型、必填、可选值
node $S create-bug --file=<bug.json> [--dry-run]           # 填表；不带 --dry-run 才点“创建”
```

| 子命令 | 作用 | 写 TAPD |
|---|---|---|
| `login` | 打开 WSLg 有界面浏览器到新建缺陷页，等用户完成登录 | 否 |
| `fields` | 输出 `templates[]`（`id`、`name`、`current`）和 `fields[]`（`name` 即 `data-field-name`、`type`、`label`、`required`、`options`） | 否 |
| `create-bug` | 校验 JSON → 打开 `bugs/add?template_id=<模板ID>` → 填标题、处理人、各字段、描述 → 打印表单状态和未填的必填项；不带 `--dry-run` 时点“创建”，等跳到 `bug/detail/<id>` 并回读 | 是（不带 `--dry-run` 时） |

报 `TAPD login required` 时先跑 `login`，让用户在弹出的窗口里登录（企业微信或 SSO），不要在对话里要密码。

## bug.json

示例：`/home/joney/projects/ai/agent-tools/skills/lexin/create-tapd-workitem/references/bug.example.json`（项目 20061171 风控业务，“分期乐缺陷创建模板”）。

| 字段 | 必填 | 说明 |
|---|---|---|
| `workspace` | 是 | TAPD 项目 ID，URL 里 `tapd.cn/<项目ID>/` 那一段 |
| `template` | 否 | 模板 ID，`fields` 输出里取；不填用页面当前默认模板 |
| `title` | 是 | 缺陷标题 |
| `owner` | 是 | 处理人，单个 TAPD 账号（如 `joneyshao`） |
| `description` / `description_file` | 二选一 | 描述 HTML；`description_file` 相对 bug.json 所在目录 |
| `fields` | 否 | `{data-field-name: 值}`。下拉填选项值或显示文字；多选、单选按钮填数组或单个值；文本框填字符串 |

先用 `fields` 看当前模板的字段名和可选值再写 JSON。`create-bug` 遇到模板没有的字段名、不存在的选项、仍为空的必填项都会直接报错，不会提交。

## 工作流

1. 字段取值先问用户：处理人、严重程度、优先级、发现阶段、缺陷类型、缺陷归属、是否关联需求等由用户决定，不要自己猜。缺陷类型是“线上已有问题”时，提醒用户关联需求会计入该需求的缺陷数。
2. `fields --workspace=<ID>` 确认模板和字段，写 bug.json 和描述 HTML 到任务临时目录。描述里已确认的写事实，推测的标“推测”。
3. `create-bug --dry-run`，把打印的标题、处理人、已填字段和 `missingRequired` 给用户确认。
4. 用户同意后去掉 `--dry-run` 创建，汇报缺陷 ID、链接 `https://www.tapd.cn/tapd_fe/<项目ID>/bug/detail/<ID>` 和回读结果。
5. 创建后报“没有跳到缺陷详情”时不要重试：先在 TAPD 缺陷列表（按创建时间倒序）找同标题记录，确认没有建成再重跑，避免重复建单。

## 已知坑

- 处理人是选人控件：逐字输入时会把前缀匹配的人一起加进来（输入 `joneyshao` 时多出 `jojoduan`），脚本按账号过滤 `#BugCurrentOwner`，不是恰好 1 人就报错。
- “创建”按钮是 `a#_view.for_submit`，不是 `<button>`；按按钮角色找不到，点击会超时。
- 页面切换模板会向同一个 `bugs/add` 地址发 POST；直接用 `?template_id=` 打开指定模板，不要拦截 `bugs/add` 的请求。
- 描述是 TinyMCE（`tinymce.get('BugDescription')`），脚本用 `setContent` 写 HTML。
- 2026-11-04 项目 20061171 的模板：分期乐缺陷创建模板 `1120061171001000570`、需求评审阶段缺陷创建模板 `1120061171001000896`（有必填“评审问题类型”，只用于需求评审）、风控业务值班问题模板 `1120061171001000572`。

## 未覆盖

- 2026-11-04 用与本脚本相同的步骤建过缺陷 1120061171001173602（分期乐模板）；打包成本脚本后只实跑了 `fields` 和 `create-bug --dry-run`，正式创建的回读逻辑尚未实跑，首次使用时核对输出的 `readback`。
- 抄送人、验证人等其他选人字段、日期字段、附件、关联需求未支持；模板里这些字段为必填时脚本会报 `missingRequired`，由用户在页面补填。
- 新建需求（story）后续扩展，需先实测需求新建页再加 `create-story`。
