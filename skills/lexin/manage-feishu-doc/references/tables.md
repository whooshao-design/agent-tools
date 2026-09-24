# 表格

`S=/home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc.mjs`

## 读取与同步

```bash
node $S table-read --target='<链接>' --table-index=0
node $S table-sync --target='<链接>' --table-index=0 --file=/absolute/path/rows.json --dry-run
```

输入是 `{"rows": [["表头1","表头2"],["值1","值2"]]}` 或裸二维数组，全部为字符串，含表头行。先 `--dry-run` 看 `rowsToAppend` 和 `cellsToWrite`，确认后去掉。`table-sync` 只重写与期望不同的格，保留原有加粗、行内代码等样式；行数不足在末尾补行并把新行格内块数对齐到既有数据行；输入行数少于现有行数时报 `ROW_COUNT_SHRINK` 停止，不删行；写后逐格回读，不一致报 `VERIFY_FAILED`。要按某列排序时直接交完整的有序二维数组。表格校验一律用 `table-read`，不要用 rawContent 的换行切分。

## 改表结构：删行、合并与拆分、列宽

```bash
node $S table-edit --target='<链接>' --table-index=0 --op=delete-rows --rows=3-4 --dry-run
node $S table-edit --target='<链接>' --table-index=0 --op=merge --rows=1-2 --cols=0 --dry-run
node $S table-edit --target='<链接>' --table-index=0 --op=unmerge --row=1 --col=0
node $S table-edit --target='<链接>' --table-index=0 --op=widths --widths='*,240,*'
```

行列号从 0 开始，0 是表头行，与 `table-read` 输出的 `rows` 下标一致；`a-b` 含两端。每个操作先 `--dry-run` 看预览；写之前再读一次表，行列或合并在这期间被人改过就报 `TABLE_CHANGED_DURING_EDIT`、不写入；写后回读核对，不一致报 `VERIFY_FAILED`。

- `delete-rows`：预览列出要删的行。不能删掉全部行，整张表用 `edit --op=delete`。
  - 和合并单元格相交会报 `MERGED_CELLS_IN_RANGE`：删除会悄悄取消合并，合并格的内容只在左上角那一格，可能随行一起丢；先 `unmerge` 再删。
  - 行里有未解决评论时返回 `blocked`，用户确认后加 `--accept-comment-loss`。
- `merge`：飞书把区域里各格的内容按行拼进左上角那一格、其余格清空。预览的 `mergedText` 和 `warnings` 给出拼接结果，给用户看过再执行。和已有合并区域部分重叠会报 `MERGE_OVERLAP`。
- `unmerge`：给区域里任意一格都行，脚本定位到左上角（飞书只认左上角，给别的格不报错也不生效）。拆分后内容留在左上角那一格，其余格为空。
- `widths`：每列一个像素值，逗号分隔，不改的列写 `*`，最小 50。只改有变化的列，逐列提交。

发布时 docs_ai 已经开了标题行、按内容估好了列宽，一般不用再调；内容大改后觉得挤再用 `widths`。

## 建表

新表格直接写成 GFM 表格，随 `publish` 发布，或用 `edit` 插入含表格的片段，任意行数一次写入；不要走块接口逐格建。排版规则见 `authoring-rules.md`，接口上限和扩行细节见 `api-facts.md`「表格」。
