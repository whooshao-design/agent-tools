# 在飞书文档上做局部修改

`S=/home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc.mjs`

`edit` 直接改飞书上的文档：插入、替换、删除一段或一节，或替换一处文字。用于以飞书为准的文档（定稿移交后的 `feishu-master`、别人的文档）。以本地为准的文档应改本地 md 后 `publish`；对它用 `edit` 会带 `warning`，因为下次增量发布会因飞书上的改动停下。写入对他人可见，必须用户明确要求；试写只落 `FEISHU_TEST_FOLDER`。

## 先定位

- `node $S outline --target=<链接>` 看标题和标题块 id。
- `node $S read --target=<链接> --format=xml --with-ids` 看每个块的 id。

只能定位**顶层块**：文档根下的段落、标题、表格、图片、高亮块、分栏、小组件等，外加列表的每一项（每个列表项在飞书里都是独立的顶层块，嵌套的子项跟着父项走）。表格单元格、高亮块和分栏里面的块不能单独定位，要改就替换整个外层块，或者用 `replace-text`、`update-text`。

## 操作

| `--op` | 参数 | 效果 |
|---|---|---|
| `insert-after` | `--file`，加 `--after=<块 id>`、`--after-heading=<标题>` 或 `--at=start\|end` 之一 | 插入片段；`--after-heading` 插在这一节末尾（下一个同级或更高级标题之前） |
| `replace` | `--block=<块 id>` [`--end-block=<块 id>`] `--file` | 用片段替换一个块或一段连续的块 |
| `delete` | `--block=<块 id>` [`--end-block=<块 id>`] | 删除一个块或一段连续的块 |
| `replace-section` | `--heading=<标题或块 id>` `--file` [`--include-heading`] | 替换这一节的正文（含子标题），默认保留标题；节为空时插在标题后 |
| `delete-section` | `--heading=<标题或块 id>` [`--include-heading`] | 删除这一节的正文，加 `--include-heading` 连标题一起删 |
| `replace-text` | `--pattern=<原文>` `--content=<新文字>` [`--all`] | 全文替换一处行内文字；`--content=` 留空表示删掉原文 |

片段文件按 `markdown-profile.md` 的规则写，写前检查同发布：mermaid 建成文本绘图小组件，`> [!TIP]` 等变高亮块，图片路径相对片段文件所在目录。片段里的 `# 标题` 就是正文标题，不会被当成文档标题拿走。空片段报 `EMPTY_FRAGMENT`，要删除请用 `delete` 系列。

标题按文字精确匹配。同一文字出现多次时报 `AMBIGUOUS_HEADING` 并列出各自的块 id，改用 id，不要猜。

`replace-text` 的规则来自 docs_ai 的 `str_replace`：

- 按 `read`（Markdown）导出的写法匹配，特殊字符要带导出时的反斜杠转义（如 `\[`）。
- 替换**所有**匹配处：出现不止一次时报 `AMBIGUOUS_PATTERN`，确认要全部替换再加 `--all`，否则换一段更长、唯一的原文。
- 只处理单行行内文字；整段、多行或跨块的改动用 `replace`。新文字经标准输入传给 lark-cli，以 `@` 开头也不会被当成文件路径。

## 写之前的检查

先加 `--dry-run` 看 `removedPreview`（将被替换或删除的块）和 `insertExpected`（片段里各类元素的数量）。以下情况会返回 `blocked`（退出码 2），原样告诉用户，由用户确认后才加对应参数：

| 检查 | 触发 | 确认后加 |
|---|---|---|
| `protected_blocks` | 范围里有图片、画板、文本绘图小组件、嵌入表格或多维表格、同步块、任务等无法从 Markdown 原样重建的块 | `--allow-protected` |
| `open_comments` | 有未解决评论挂在要替换或删除的块（含其子块）上，替换后评论失去挂靠位置 | `--accept-comment-loss` |

写入前会再读一次正文，读取之后有人改了就报 `REMOTE_CHANGED_DURING_EDIT`、不写入：重新 `--dry-run` 看新的范围后再执行。

只想改文字、保住块 id 和评论时，用 `replace-text` 或 `update-text` 原地改，不要整块替换。

## 结果

| status | 退出码 | 含义 |
|---|---|---|
| `updated` | 0 | 写入成功，服务端无警告，图都建成了小组件 |
| `updated_with_issues` | 3 | 已写入，但有服务端降级警告、图没建成小组件或残留占位；逐项报告 |
| `dry_run` | 0 | 只给预览 |
| `blocked` | 2 | 被上面的检查阻断，见 `blockers` |

写入后块 id 会变（替换、插入的内容都是新块），再次修改前重新 `read --with-ids`，不要沿用旧 id。

## 元素级编辑（保留样式改文字、补标题跳转链接）

加链接、改行内样式、重写单元格走「导出原始块 → 生成计划 → dry-run → 写入」：

```bash
node $S list-blocks --target='<链接>' --full --out=/abs/raw.json
node $S link-plan --target='<链接>' --labels=/abs/labels.json --out=/abs/plan.json   # 可选：正文文字 → 标题跳转链接
node $S update-text --target='<链接>' --file=/abs/plan.json --dry-run
node $S update-text --target='<链接>' --file=/abs/plan.json
```

计划是 `[{block_id, elements}]`，整块替换 elements，自己拼 elements 时必须沿用原 run 的 `text_element_style`。`update-text` 跳过已一致的块，每批 40 条、确定性 client_token，写后逐块回读比对内容、样式和解码后的链接。`labels.json` 形如 `{"第 3 章": "3. 国内流水查询"}`（值为标题文本或标题块 id）。原地改写保留块 id，挂在该段的评论不受影响。

## 托管 JSON 章节

```bash
node $S write-json --target='<链接>' --file=/absolute/path/data.json --section=package-all-info --heading='PackageAllInfo' --mode=upsert
```

写之前可用 `node $S inspect-sections --target='<链接>' --section=<id>` 看已有的托管章节。`upsert`（默认）先创建并按 SHA-256 校验新章节，再删除旧章节，失败时宁可留下重复章节也不先删旧数据；`append` 不覆盖已有同名章节。输入也可用 `--stdin`。

## 权限

`edit` 需要 `docx:document`、`docx:document:readonly`、`docx:document:write_only`、`docs:document.comment:read`、`docs:document.media:upload`、`board:whiteboard:node:create`、`offline_access`；`update-text`、`write-json` 只要 `docx:document`、`docx:document:readonly`、`offline_access`。以 `auth-check --operation=edit|write-blocks|write-json` 为准。
