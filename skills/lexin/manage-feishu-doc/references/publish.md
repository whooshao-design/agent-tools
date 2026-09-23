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

`<文件名>.feishu.json` 记录文档 token、链接、标题、`mode`、发布时的 revision 与正文哈希、最近一次备份。

- `mode: local-master`（默认）：以本地为准。再次发布目前只支持全量覆盖，增量更新在后续版本提供。
- `mode: feishu-master`：定稿移交后以飞书为准，`publish` 拒绝覆盖，要改就直接在飞书上改（用户在客户端改，或用 `update-text`、`table-sync` 等局部命令）。用户说「这篇以后在飞书上维护」时，把状态文件里的 `mode` 改成 `feishu-master`。

别人拥有的文档不要用 `publish` 接管，按飞书为准做局部修改。

## 全量覆盖

`node $S publish --file=<md> --overwrite --dry-run` 先看检查，再去掉 `--dry-run` 执行。覆盖前自动检查：

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
| `dry_run` | 0 | 只给计划和检查结果 |
| `blocked` | 2 | 覆盖被检查阻断，见 `blockers` |
| `needs_mode` | 2 | 已发布过，需要明确 `--overwrite` |

`diagrams[].status`：`widget` 正常；`whiteboard` 退到画板；`code` 退成代码块；`placeholder_missing` 表示占位段落没找到，要人工核对。

## 权限

`publish` 需要 `docx:document`、`docx:document:create`、`docx:document:write_only`、`docx:document:readonly`、`docs:document.media:upload`、`docs:document.comment:read`、`board:whiteboard:node:create`；发布到知识库节点可能还要 `wiki:node:create`（未实测）。缺什么以 `auth-check --operation=publish` 为准。
