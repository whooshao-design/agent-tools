# 把本地 Markdown 发布到飞书

`S=/home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc.mjs`

适用于技术方案、操作/指导手册、资料文档等任何在本地用 Markdown 写的文档。发布都是对外可见的写入，必须用户明确要求；试写只落 `FEISHU_TEST_FOLDER`。

## 流程

1. 写完先检查：`node $S lint --file=<md 绝对路径>`，错误必须改，警告按需处理（见 `authoring-rules.md`）。
2. 再看计划：`node $S publish --file=<md 绝对路径> --target=<文件夹或知识库节点链接> --dry-run`。输出标题、各类元素的预期数量（标题、表格、图片、高亮块、图）和本地警告。
3. 发布：去掉 `--dry-run`。脚本依次预处理 Markdown → docs_ai 建文档 → 把 mermaid 占位换成文本绘图小组件 → 读回计数校验 → 在 md 旁写 `<文件名>.feishu.json`。
4. 报告：给用户文档链接、`status`、`diagrams` 各项状态、`verification.mismatches`、`serverWarnings`；有问题逐项说明。

## 本地怎么写

按 `markdown-profile.md` 的飞书方言写，图按 `diagrams.md`，排版按 `authoring-rules.md`。发布前先 `node $S lint --file=<md>`；`publish` 自己也会跑静态检查，错误直接报 `PUBLISH_PRECHECK_FAILED`、不写飞书。

## 状态文件与两种模式

`<文件名>.feishu.json` 记录文档 token、链接、标题、`mode`、发布时的 revision 与正文哈希、最近一次备份。首次发布还会把文档记进 `~/.local/share/agent-tools/feishu-created-docs.jsonl`，以后要清理时由 `cleanup-list` 列给用户手动删除。

状态文件还有 `units`：本地每一段（段落、标题、列表、表格、图……）对应飞书上哪些顶层块，增量发布靠它定位。

- `mode: local-master`（默认）：以本地为准。再次发布默认增量，用户明确要求时整篇覆盖。
- `mode: feishu-master`：定稿移交后以飞书为准，`publish` 拒绝写入，要改就直接在飞书上改（用户在客户端改，或用 `edit`、`update-text`、`table-sync` 等局部命令）。用户说「这篇以后在飞书上维护」时，把状态文件里的 `mode` 改成 `feishu-master`。

别人拥有的文档不要用 `publish` 接管，按飞书为准用 `edit` 做局部修改。

## 增量更新（再次发布的默认方式）

`node $S publish --file=<md> --dry-run` 先看 `summary`，再去掉 `--dry-run` 执行。

脚本把本地 Markdown 切成段，与上次发布时的段逐一比较，只动变了的：

- 只改了文字的段落和标题原地改写（经 `docx.v1.document.convert` 转成行内元素后 `update_text_elements`），块 id 不变，挂在上面的评论保住。
- 其余改动按段替换、删除或插入；mermaid 改了会在原位置重建小组件。没变的段一个字都不碰。
- `summary`：`unchanged`、`inPlace`（原地改写）、`replacedOrDeleted`、`inserted`、`titleChanged`；改动超过一半时 `suggestion` 提示也可以整篇覆盖。
- 本地和飞书完全一致时返回 `unchanged`，不写飞书。

执行前按段检查飞书端现状：

| 检查 | 阻断时 | 用户确认后加 |
|---|---|---|
| 要改的段落在飞书上被人改过 | `remote_changed` | `--force`（飞书上的这些改动会被本地内容替换） |
| 飞书上多了本地没有的块 | `remote_inserted`，给出样例 | `--force`（之后要覆盖一次才能继续增量） |
| 本地改了标题，飞书上的标题也被人改过 | `remote_title_changed` | `--force` |
| 飞书上调整过段落顺序 | `remote_reordered` | 先把顺序合回本地后 `--overwrite`；`--force` 照样按块写入，但之后要覆盖一次才能继续增量 |
| 有未解决评论挂在要替换或删除的块上（原地改写的段不算） | `open_comments`，列出评论 | `--accept-comment-loss` |

飞书上改过、但本地这次没动的段不会被覆盖，计入 `checks.preservedRemoteEdits`；这时本地与飞书已不一致，提醒用户把这些改动合回本地。这些段之后本地再改时仍按冲突（`remote_changed`）处理，合回本地后确认再加 `--force`。文本绘图小组件在 XML 里是空块，比对时会读图的源码，飞书上改了图同样算改过。

发布后脚本核对没改动的段落块 id 是否与上次一致；对不上说明飞书上调整过顺序，逐段映射作废（`verification.incrementalReady` 为 false），下次要 `--overwrite`。

检查通过后、写入前会再读一次正文：这几秒里有人改了正文就报 `REMOTE_CHANGED_DURING_PUBLISH`、不写入，重新运行即可（会重新做上面的检查）。

`needs_mode`：状态文件没有 `units`（2.2.0 以前发布的），或者本地切出的段与飞书上的块对不上。先整篇覆盖一次，之后就能增量。

## 全量覆盖

用户明确要整篇覆盖时用 `--overwrite`。`node $S publish --file=<md> --overwrite --dry-run` 先看检查，再去掉 `--dry-run` 执行。覆盖前自动检查：

| 检查 | 阻断时 | 用户确认后加 |
|---|---|---|
| 上次发布后飞书上有人改过正文（revision 变了且正文哈希不同），或之前的增量发布保留了还没合回本地的飞书改动（`checks.unmergedRemoteEdits`） | `remote_changed` | `--force` |
| 本地改了标题，飞书上的标题也被人改过 | `remote_title_changed` | `--force` |
| 有未解决、挂在正文上的评论（覆盖后会失去挂靠位置；全文评论不受影响） | `open_comments`，列出评论 | `--accept-comment-loss` |

阻断时把原因和评论原样转给用户，由用户决定：合回本地再发、先处理评论，或者确认后加对应参数。执行覆盖前会把当前飞书内容备份到 `~/.local/share/agent-tools/feishu-backups/<文档 token>/<时间>-r<版本>.{xml,md}`；标题变了会一并更新。要恢复，用飞书的历史版本回滚到备份里记录的版本。

覆盖一篇不是 `publish` 建的已有文档：`--doc=<文档链接> --overwrite`。这时没有发布记录，无法判断飞书上是否有人改过，只做评论检查和备份，然后写出状态文件。

## 结果状态与退出码

| status | 退出码 | 含义 |
|---|---|---|
| `published` | 0 | 写入成功，计数一致，图都是小组件，服务端无警告 |
| `published_with_issues` | 3 | 已写入，但有计数不一致、图退到画板或代码块、或服务端警告；逐项报告 |
| `unchanged` | 0 | 本地没有改动，没写飞书 |
| `dry_run` | 0 | 只给计划和检查结果 |
| `blocked` | 2 | 增量或覆盖被检查阻断，见 `blockers` |
| `needs_mode` | 2 | 发布记录不支持增量，需要 `--overwrite` 覆盖一次 |

`diagrams[].status`：`widget` 正常；`whiteboard` 退到画板；`code` 退成代码块；`placeholder_missing` 表示占位段落没找到，要人工核对。

## 权限

`publish` 需要 `docx:document`、`docx:document.block:convert`（增量原地改写）、`docx:document:create`、`docx:document:write_only`、`docx:document:readonly`、`docs:document.media:upload`、`docs:document.comment:read`、`board:whiteboard:node:create`；发布到知识库节点可能还要 `wiki:node:create`（未实测）。缺什么以 `auth-check --operation=publish` 为准。
