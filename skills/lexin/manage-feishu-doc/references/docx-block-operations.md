# docx 块操作要点

这些是在真实文档上验证过的行为，用来避免重新试错。所有事实以 lark-mcp `@larksuiteoapi/lark-mcp@0.5.1` 为准。

## 读取：优先整篇拉块

`docx.v1.documentBlock.list` 一次分页返回文档内**全部**块，包含表格单元格（`block_type=32`）及其文本子块，且单元格块自带 `children` 数组。

用 `docx.v1.documentBlockChildren.get` 逐层下钻则是每个单元格一次调用。实测同一篇文档（74 行 × 6 列主表）：

| 方式 | 调用次数 | 耗时 |
|---|---|---|
| `documentBlock.list` 分页 | 3 | 约 1.3 秒 |
| 逐单元格 `documentBlockChildren.get` | 438 | 超过 2 分钟未完成 |

只有在明确只要某个块的直接子块时才用 `documentBlockChildren.get`。

## rawContent 不能用于表格校验

`docx.v1.document.rawContent` 把块按顺序拼成纯文本，单元格之间的换行数量取决于**格内文本块的个数**：

- 每格 2 个文本块（常见的人工排版）→ 相邻内容间是 `\n\n\n`
- 每格 1 个文本块（`insert_table_row` 新建的行）→ 相邻内容间是 `\n\n`

同一张表里两种格式并存时，按固定分隔符切分会同时产生「条目缺失」和「顺序错乱」的假阳性。表格一律用 `table-read` 取结构化二维数组再比对。

## 表格行插入

`docx.v1.documentBlock.patch` 的 `insert_table_row`：

- `row_index: -1` → 追加到表格末尾
- `row_index: n`（n ≥ 0）→ 新行落在索引 `n`，原第 `n` 行及之后整体下移

`docx.v1.documentBlock.batchUpdate` 在 lark-mcp 的 schema 中只声明了 `update_text_elements`，插入行仍需逐次 `patch`。

`table-sync` 只在末尾补行，靠"重写差异格"达成中间插入的效果——这样调用方不需要计算插入位置，代价是被下移的行会被重写。

## 单元格块结构

一个表格单元格（`block_type=32`）的内容是它的文本子块：

- 人工创建 / 历史文档的单元格常见形态是 `[空文本块, 内容文本块]`
- `insert_table_row` 新建的单元格只有 `[空文本块]`

两种形态混在同一张表里，行高会不一致（多出来的空段落占一行）。`table-sync --pad-cells=auto`（默认）会统计既有数据行（跳过表头）每格文本块数的众数，把新行补齐到同样的块数；`--pad-cells=off` 关闭该行为。

补块只能逐格调用 `documentBlockChildren.create`（该接口一次只能指定一个父块），所以新增 N 行 × M 列需要 N×M 次调用，这是扩表的主要耗时来源。

写入时以**格内最后一个文本块**为目标，读取时拼接格内所有文本块，二者自洽。

## 批量写入与整表重建

- `documentBlock.batchUpdate` 用于批量改文本，`table-sync` 按每批 40 条切分。
- `documentBlockDescendant.create` 单次创建的块数有上限，重建一张 74 行 × 6 列的表格需要约 889 个块（1 表 + 444 格 + 444 文本），远超上限。**已有大表只能原地扩行，不能删表重建。**
- 用 `documentBlockChildren.create` 新建表格时，只传 `table.property.row_size/column_size`，单元格由飞书自动生成；手工声明 cell 子块会返回 `1770001 invalid param`。

## 样式保持

`update_text_elements` 会整体替换 elements，`text_element_style` 不传就会丢失加粗、行内代码等样式。`table-sync` 只重写内容有差异的格，并沿用该块原有的 `text_element_style`。
