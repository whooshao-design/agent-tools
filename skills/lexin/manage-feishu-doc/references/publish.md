# 把本地 Markdown 发布到飞书

`S=/home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc.mjs`

适用于技术方案、操作/指导手册、资料文档等任何在本地用 Markdown 写的文档。发布都是对外可见的写入，必须用户明确要求；试写只落 `FEISHU_TEST_FOLDER`。

## 流程

1. 先看计划：`node $S publish --file=<md 绝对路径> --target=<文件夹或知识库节点链接> --dry-run`。输出标题、各类元素的预期数量（标题、表格、图片、高亮块、图）和本地警告。
2. 发布：去掉 `--dry-run`。脚本依次预处理 Markdown → docs_ai 建文档 → 把 mermaid 占位换成文本绘图小组件 → 读回计数校验 → 在 md 旁写 `<文件名>.feishu.json`。
3. 报告：给用户文档链接、`status`、`diagrams` 各项状态、`verification.mismatches`、`serverWarnings`；有问题逐项说明。

## 本地怎么写

| 写法 | 发布后 |
|---|---|
| frontmatter `title:` 或开头的 `# 标题` | 文档标题；正文里不再重复这个 H1 |
| ```` ```mermaid ```` | 文本绘图小组件（只显示图，读者可切到代码）；建不出来就退到画板，再不行保留为代码块 |
| `> [!NOTE]`、`[!TIP]`、`[!IMPORTANT]`、`[!WARNING]`、`[!CAUTION]` | 高亮块：📝 蓝、💡 绿、📌 紫、❗ 橙、⛔ 红；内容可含段落、列表、待办和行内格式 |
| `![说明](相对路径)` | 上传的图片，说明作图注；图片必须在 md 所在目录或其子目录里 |
| GFM 表格 | 原生表格，任意行数；建议不超过 6 列 |
| 有意写的 DocxXML 标签（如 `<table>` 带 `colspan`） | 原样交给 docs_ai |
| `List<String>` 这类正文里的尖括号 | 自动转义，照常显示；代码里的不动 |
| `<!-- 注释 -->` | 去掉（飞书不保留注释），会给出本地警告 |
| `[文字](#标题)` 页内链接 | 只剩文字，会给出本地警告；需要跳转时发布后用 `link-plan` 补 |

mermaid 在小组件里的写法：沿用本地稳定子集；quadrantChart、xychart、sankey 里的中文要加双引号，不加就不出图；不要给所有标签都加引号（小组件失败退到画板时，全加引号的图会解析失败）。写 `<whiteboard>` 会被本地检查拦下。

发布前检查不通过（图片不在目录内、图片不存在、data URI 图片、代码块没闭合、写了 `<whiteboard>`）时直接报 `PUBLISH_PRECHECK_FAILED`，不会写飞书。

代码一律用围栏代码块（```` ``` ````）：4 个空格缩进式的代码块不被识别为代码，里面的 `<` 会被当成正文转义。

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
| 有未解决评论挂在要替换或删除的块上（原地改写的段不算） | `open_comments`，列出评论 | `--accept-comment-loss` |

飞书上改过、但本地这次没动的段不会被覆盖，计入 `checks.preservedRemoteEdits`；这时本地与飞书已不一致，提醒用户把这些改动合回本地。

`needs_mode`：状态文件没有 `units`（2.2.0 以前发布的），或者本地切出的段与飞书上的块对不上。先整篇覆盖一次，之后就能增量。

## 全量覆盖

用户明确要整篇覆盖时用 `--overwrite`。`node $S publish --file=<md> --overwrite --dry-run` 先看检查，再去掉 `--dry-run` 执行。覆盖前自动检查：

| 检查 | 阻断时 | 用户确认后加 |
|---|---|---|
| 上次发布后飞书上有人改过正文（revision 变了且正文哈希不同） | `remote_changed` | `--force` |
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
