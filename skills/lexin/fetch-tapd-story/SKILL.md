---
name: fetch-tapd-story
description: 只读抓取 TAPD 需求单的字段、描述、评论和图片，落盘为本地 Markdown，复用 get-browser-session 浏览器登录态。Use when 用户给出 www.tapd.cn 需求链接要求下载或读取 TAPD 原文，或其他 skill 需要取回 TAPD 原文；不修改 TAPD，不处理缺陷/任务单。
metadata:
  version: 1.0.0
---

# fetch-tapd-story

## 定位

把一条 TAPD 需求原样取回本地，作为需求澄清的原始输入。它只负责"取原文"：字段、需求描述（HTML 转 Markdown）、评论和描述中的图片；不负责理解、改写或评审需求，这些交给 `dev-clarify-task`。

不修改 TAPD（不评论、不流转状态、不改字段），不处理缺陷、任务等其他工作项。

暂无 TAPD MCP，使用固定脚本。脚本复用 `get-browser-session` 的 Chromium 与 main profile，网络为 direct-only，不保存、不输出 Cookie，也不需要用户在对话里粘贴 Cookie。

## 用法

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/fetch-tapd-story/scripts/fetch_tapd_story.js \
  --url=<TAPD需求URL> \
  --out-dir=<输出目录>
```

- `--out-dir`：被 `dev-clarify-task` 调用时传 `<需求目录>/requirements/source/`；不传时默认 `~/docs/requirements-development/tapd-<7位ID>/requirements/source/`。
- `--headed`：打开浏览器窗口，等待用户完成 TAPD 登录（最长 `--login-timeout` 毫秒，默认 300000）。
- `--profile`：浏览器 profile，默认 `~/.local/state/agent-tools/browser-profiles/main`。

产物：

- `TAPD-<7位ID>.md`：基础信息表（含状态中文名、非空自定义字段）、需求描述、评论。
- `images/img_NN.<ext>`：描述中的图片，Markdown 里用相对路径引用；下载失败的图片保留原 URL 并列在 `imageFailures`。
- `TAPD-<7位ID>.description.html`：原始描述 HTML，用于核对转换是否丢内容。

脚本标准输出是一段 JSON，`state` 取值：

| state | 含义与处理 |
|---|---|
| `OK` | 成功；读取 `markdownPath` 指向的文件 |
| `LOGIN_REQUIRED` | profile 没有 TAPD 登录态；告诉用户将弹出窗口，用 `--headed` 重跑，请用户在窗口里登录 |
| `FORBIDDEN` | TAPD WAF 返回 403；检查 UA 或网络，不要反复重试 |
| `NOT_LOADED` | 页面打开但没拿到需求数据；多为无该项目权限或链接错误 |
| `ERROR` | 脚本异常，按 `error` 排查 |

## 工作方式与约束

- 数据来自页面加载时 TAPD 前端调用的 `/api/aggregation/workitem_aggregation/common_get_info` 响应：`Story` 取字段和描述，`show_fields_info.show_fields` 取字段中文名，`workspace_configs.workflow_infos.story.status_map` 取状态中文名，`comment_list.comments` 取评论。TAPD 改版导致取不到时，返回 `NOT_LOADED`，不要退回抓整页文字冒充结果。
- TAPD WAF 会拒绝 User-Agent 含 `HeadlessChrome` 的请求，脚本固定使用普通 Chrome UA；`get-browser-session --status` 对 TAPD 会误报 `FORBIDDEN`，不要用它判断 TAPD 登录态。
- 登录态保存在共享 profile 中，并发时按 `launchLockedContext` 排队。
- 读完产物后核对：描述里的图片要逐张查看，因为原型图里常含正文没写的交互细节（弹窗文案、按钮、字段）。
- 产物属于原始需求证据，按原样保存，不在上面改写；整理和澄清结果写到 `dev-clarify-task` 的 `summary.md`。

## 验证

```bash
node --test /home/joney/projects/ai/agent-tools/skills/lexin/fetch-tapd-story/tests/fetch_tapd_story.test.js
```
