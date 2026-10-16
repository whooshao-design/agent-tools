---
name: okr-weekly-progress
description: 汇总本周工作（飞书「周工作汇报」、本机 Claude/Codex 会话、本人 git 提交），按乐空间 OKR 的 KR 归类生成周报汇总，用户在 mdview 评审后只以草稿形式追加写入各 KR 进展。Use when 用户要写或生成本周 OKR 进展/周报、把周报填进乐空间 leco.oa.fenqile.com 的 KR、说「写入 OKR」「看周报」、处理周报汇总上的 mdview 评论，或安装/调整每周五自动生成周报的定时任务。
metadata:
  version: 1.0.0
---

# okr-weekly-progress

## 定位

治理本人乐空间 OKR（默认 `goal/49548`）的每周进展：汇总、归类、本地归档、草稿写入。不发布进展，不改进展状态和进度，不改 O/KR，不写他人 OKR，不改飞书文档。飞书读取依赖 `manage-feishu-doc`，会话读取依赖 `recall-agent-sessions`，评审用 mdview 评论（`mdview comments <文件>`）。

脚本：`S=/home/joney/projects/ai/agent-tools/skills/lexin/okr-weekly-progress/scripts/okr_weekly.mjs`

流程分两段：定时段只生成周报汇总，不写乐空间；写入段由用户在交互会话里明确说「写入 OKR」后执行。

## 定时段：生成周报汇总

`okr-weekly.timer` 每周五 13:40 运行；交互会话里用户说「生成本周 OKR 周报」时也走这一段。

1. `node $S collect`：取本周一 00:00 至今（北京时间）的飞书周报、会话、提交和 OKR，输出素材 JSON 路径与 `archive.path`。任一来源 `status` 不是 `ok` 时照常继续，并在周报汇总里写明。
2. 读素材 JSON，按下面的规则整理后，按 `references/archive-format.md` 写到 `archive.path`。路径是 `<日期>.new.md`（或 `.new-2.md` 等）说明同名文件已存在：照写新文件，提示用户比较差异，不覆盖旧文件。
3. `node $S open <文件>` 在 mdview 中打开。

整理规则：

- 完整呈现：不设条数或篇幅上限，不自行删掉低优先级事项。同一件事跨来源、跨会话只保留一条，表述以飞书周报为准，来源全部列出。
- 分层表达：每个 KR 下先按主题（项目、需求或「线上问题支持」这类工作类别）分组为父级，具体事项作为子级；同主题不平铺，单事项主题写成一行。格式见 `references/archive-format.md` 第 2 节。
- 归类：先在该 KR 的 `latestText`（最近已发布进展）和 `archive.previous`（往期汇总）里找同一事项，找到就沿用原来的 KR；找不到再按 KR 文本判断；两者都拿不准时放进「待归类」并写理由。
- 非工作会话（个人网络、环境折腾、空会话）不进正文，列入「已排除」并写原因。
- 下周工作：优先用飞书周报的待办和计划，其次用会话里未完成的事项，后者标「推断」。
- 脱敏：内网 IP、订单号、用户 uid、token 不写进 KR 小节，在「需脱敏提示」里说明。
- 本周已发布（`publishedThisWeek`）的 KR 照常整理，但标题下加 `> 本周已发布，默认跳过`。

## 评审：处理 mdview 评论

用户说「看评论」时，`mdview comments <周报汇总>` 读未处理评论，逐条修改文件（删减、改写、改归类、移出待归类），然后 `mdview comments <文件> --resolve <id> --reply "<怎么改的>"`。需要用户拍板的评论保持未处理并提问。

## 写入段：只存草稿

只有用户明确说「写入 OKR」（或等价指令）才执行，每一步都看输出再继续：

```bash
node $S write --file=<周报汇总.md>              # dry-run：逐 KR 显示 append / keep / skip-published 与新增预览，不发请求
node $S write --file=<周报汇总.md> --confirm    # 用户核对 dry-run、关闭所有「添加进展」页面后提交
```

- 保存草稿接口 `edit_kr_process.json`（`option=1`）一次覆盖一个 O 下全部 KR 的草稿。脚本整组读改写：目标 KR 在原草稿后追加，其他 KR 原样带回，空草稿保持为空，进度和状态不变。
- `--confirm` 后先拍快照，等 35 秒（超过页面 30 秒自动保存周期，`--settle-seconds` 可调）再重读比对 `draft_modify_time`；被改过就中止（`aborted`），多半是有打开着的「添加进展」页面。
- 写后逐字段回读（`status=verify-failed` 时列出差异），65 秒后再查一次；`recheck.status=overwritten` 表示被其他页面覆盖，告诉用户，不要自动重写。
- `sensitive-found`：先在周报汇总里脱敏；用户确认无碍才加 `--allow-sensitive`。
- `skip-published`：该 KR 本周已发布。用户要追加时删掉小节里的跳过标记，或加 `--include-published`。只写「本周无」的小节不会写入（`emptySections`）。
- `failed-before-post`：草稿没动，排除原因后重跑。`unknown-after-post`：请求已发出但没能回读，让用户在页面上核对该 O 的草稿；需要恢复时 restore 会要求 `--force`。
- 每次提交前的草稿快照存在 `~/.local/state/agent-tools/okr-weekly/snapshots/`，结果里带 `restore` 命令。恢复同样先 dry-run：`node $S restore --snapshot=<文件>`，确认后加 `--confirm`。
- 登录失效（`LOGIN_REQUIRED`）：用 `get-browser-session` 刷新 main profile 后重试，不向用户索要 Cookie。

## 定时任务

```bash
python3 /home/joney/projects/ai/agent-tools/skills/lexin/okr-weekly-progress/scripts/install_timer.py --dry-run   # 看单元内容
python3 /home/joney/projects/ai/agent-tools/skills/lexin/okr-weekly-progress/scripts/install_timer.py             # 安装并启用（默认周五 13:40）
python3 /home/joney/projects/ai/agent-tools/skills/lexin/okr-weekly-progress/scripts/install_timer.py --uninstall
systemctl --user start okr-weekly.service      # 手动跑一次
```

安装时会把当前 shell 的代理变量写进服务单元；代理配置变了要重新安装。定时会话由 `scripts/run_scheduled.sh` 以 `claude -p` 运行，只放行 collect、open 和写 `~/docs/weekly-reports/`，write、restore 被显式禁止，脚本还设置 `OKR_WEEKLY_READONLY=1` 让它们在脚本内直接拒绝。失败时生成 `<日期>.failed.md` 并在 mdview 中打开，运行日志在 `~/.local/state/agent-tools/okr-weekly/runs/`（保留 60 天）。

## 完成标准

- 定时段：周报汇总已写出并在 mdview 打开；来源缺失写在文件头；乐空间草稿修改时间不变。
- 写入段：结果 `status=ok`，每个目标 KR `written` 且 65 秒复查 `ok`；否则把 `aborted`、`status=verify-failed` 或 `overwritten` 的原因和 restore 命令原样告诉用户。
