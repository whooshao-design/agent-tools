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

## 建表行数硬上限：9 行

`documentBlockChildren.create` 建表时 `row_size` **最多 9**，第 10 行起直接 `1770001 invalid param`（2026-08-17 实测，9 行成功 / 10 行失败）：

| row_size | 结果 |
|---|---|
| 9 | ✅ |
| 10 | ❌ `1770001 invalid param` |

**这是把 Markdown 表格写进飞书时最容易踩的坑**：8 行以内的表能正常写入，超过 9 行（含表头）就整段失败，且错误信息不会提到行数。超长表必须先建 9 行骨架，再用 `documentBlock.patch` 的 `insert_table_row`（`row_index: -1` 追加）补足剩余行。

## descendant 单次块数

`documentBlockDescendant.create` 实测 500 块可一次写入成功（50 / 200 / 500 三档均通过），上限高于本文早期估计。真正的约束更可能是请求体大小而非块数。

一张 74 行 × 6 列的表约需 889 块，仍超出安全范围，**已有大表继续走原地扩行，不要删表重建**。

## 经 lark-mcp 调用 descendant 会失败

`docx.v1.documentBlockDescendant.create` 通过 lark-mcp 调用必定返回 `1770041 open schema mismatch`：上游的 zod schema 里 `descendants[]` 元素漏了 `block_id` 和 `children`，MCP SDK 的 `safeParseAsync` 默认 strip 会把这两个字段在发出前剥掉，服务端收到「`children_id` 引用了不存在的块」。

已由 `mcp/third-party-mcp/lark/patches/apply.mjs` 修复（`.extend()` 补两个 optional 字段）。**直连 REST 不受影响**。

## convert 的两个坑

`docx.v1.document.convert` 支持 `content_type` 为 `markdown` 或 `html`，产出可直接喂给 descendant 接口，但有两处必须自己补：

1. **表格块只给 `table.cells`，不给 `table.property`**，而建表必须有 `row_size`/`column_size`，否则 `1770001`。单元格 id 形如 `row<uuid>col<uuid>`，据此统计去重后的行列数补上。
2. **块自带 `parent_id: ""`**，descendant 接口靠 `children` 表达父子关系，`parent_id` 需剥掉。用 `documentBlockChildren.create` 时还要额外剥掉 `block_id`。

HTML 模式下**内联 `<svg>` 会被整个丢弃**（产出 0 块）；`<img src="data:...">` 和外链 `<img>` 会转成图片块占位，URL 放在 `block_id_to_image_urls`，但图片内容仍需自己上传绑定。

## 插图：唯一可行路径

流程图/UML 块（`block_type=21`）**不能通过 API 创建**（`1770029 block not support to create`）；画板块（43）能建但只是空画布，内容要走画板产品的独立 API。

要在文档里放图，只有这一条链路（需 `docs:document.media:upload`）：

```
1. 建图片占位块   POST /docx/v1/documents/{doc}/blocks/{doc}/children
                  { block_type: 27, image: { width, height } }
2. 上传媒体       POST /drive/v1/medias/upload_all   (multipart)
                  file_name / parent_type=docx_image / parent_node=<图片块id> / size / file
3. 绑定           PATCH /docx/v1/documents/{doc}/blocks/{图片块id}
                  { replace_image: { token: <file_token> } }
```

**飞书接受直接上传 SVG**（`image/svg+xml`），因此画时序图/架构图不需要本地安装任何渲染器：手写 SVG 上传即可，中文由查看端字体渲染。

## children.create 的 index 必须放在 body 里

`docx.v1.documentBlockChildren.create` 的 `index` 是**请求体字段**，不是 query 参数：

```js
// 正确：新块插入到最前面
data: { children, index: 0 }

// 错误：index 被静默忽略，新块一律追加到末尾
params: { document_revision_id: -1, client_token, index: 0 }
```

放错位置不会报错，只会让所有插入都变成追加。症状是"内容顺序全对，但整体位置不对"——2026-08-19 实测：删到只剩一张表后，用 params 传 `index: 0` 建的 17 个块落在了表的**后面**。

注意与 `insert_table_row` 的 `row_index` 区分：那个是"新行落在该索引"，而 `children.create` 的 `index` 是"插入到该位置"（`index: 0` = 最前面）。

## 批量写入与整表重建

- `documentBlock.batchUpdate` 用于批量改文本，`table-sync` 按每批 40 条切分。
- `documentBlockDescendant.create` 单次创建的块数有上限，重建一张 74 行 × 6 列的表格需要约 889 个块（1 表 + 444 格 + 444 文本），远超上限。**已有大表只能原地扩行，不能删表重建。**
- 用 `documentBlockChildren.create` 新建表格时，只传 `table.property.row_size/column_size`，单元格由飞书自动生成；手工声明 cell 子块会返回 `1770001 invalid param`。

## 样式保持

`update_text_elements` 会整体替换 elements，`text_element_style` 不传就会丢失加粗、行内代码等样式。`table-sync` 只重写内容有差异的格，并沿用该块原有的 `text_element_style`。
