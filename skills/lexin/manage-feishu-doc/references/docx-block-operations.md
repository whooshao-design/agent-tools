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

## 经未打补丁的 lark-mcp 调用 descendant 会失败

`docx.v1.documentBlockDescendant.create` 通过未打补丁的上游 lark-mcp 调用必定返回 `1770041 open schema mismatch`：上游的 zod schema 里 `descendants[]` 元素漏了 `block_id` 和 `children`，MCP SDK 的 `safeParseAsync` 默认 strip 会把这两个字段在发出前剥掉，服务端收到「`children_id` 引用了不存在的块」。

本仓库的 wrapper 启动时由 `mcp/third-party-mcp/lark/patches/apply.mjs` 打补丁修复（`.extend()` 补两个 optional 字段），补丁失败会拒绝启动；经本仓库 wrapper 调用可以直接用 descendant，不需要绕行 REST。**直连 REST 不受影响**。

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

## 元素级编辑

`list-blocks` 默认只返回扁平文本摘要；做元素级修改要用 `list-blocks --full --out=<file>` 导出原始块，里面才有 `text.elements[].text_run.text_element_style`。

常用块类型：1 页面根、2 文本、3–11 为 H1–H9（4/5/6/7 即 H2/H3/H4/H5）、12 无序列表、13 有序列表、14 代码、31 表格、32 单元格。root 块（`block_type=1`）的 `children` 顺序就是文档顺序，可据此追踪「当前 H4」，给 H5 生成带上级编号的引用标签（如 `3.2 某小节`）。

改写规则（`link-plan` 已按此实现）：

- 按 text_run 拆分：保留原 run 的 `text_element_style`，只把匹配的子串拆成新 run 并加 `link`。
- 跳过已有 `link` 或 `inline_code` 的 run，跳过标题块和代码块（14），只处理 2/12/13。这样重跑是幂等的。
- 导入的表格每个单元格通常只有 1 个文本子块，可直接对该子块 `update_text_elements` 重写整格；表头原有的 `bold` 要沿用。
- 手写 Markdown 行内语法转 elements 时：`` `x` `` → `inline_code: true`，`**x**` → `bold: true`，`[t](url)` → `link.url`。

写入统一走 `update-text --file=<plan.json>`：先 `--dry-run` 看 `toWrite` 和 `preview`（before/after/解码后的链接），再正式写。它每批最多 40 条 `update_text_elements`、用确定性 client_token，写后回读逐块比对内容、样式标志和解码后的链接 URL。比对前会合并相邻同样式 run，因为飞书写入后可能合并它们。2026-09 实测一次 51 处改动全部回读一致，对同一计划再次 dry-run 得到 `toWrite: 0`。

## 页内跳转链接

- Markdown 导入飞书会丢掉 `<a id>` 锚点和 `](#...)` 页内链接。
- 可用格式是 `https://lexin.feishu.cn/docx/<document_token>#<heading_block_id>`，block_id 形如 `doxcn...`，从 API 获取；已由用户在飞书中点击验证可跳转。
- 飞书界面「复制链接」生成的是 `#share-<id>`，这种 id 不是 API 的 block_id，API 拿不到，不要拿它拼链接。
- 写入时 `text_element_style.link.url` 必须整体 URL 编码（`encodeURIComponent`）。`update-text` 和 `link-plan` 会把未编码的 URL 自动编码一次，已编码的保持不变。

## Markdown 导入注意事项

- 重新导入 Markdown 会丢失所有在飞书上做的增量编辑（如链接）。源文件更新后优先用 API 增量修改。
- mermaid 在飞书中只显示为代码块。
- 路径含 `%20` 的本地图片导入后打不开；改为文字/表格，或按上文「插图」链路上传。
