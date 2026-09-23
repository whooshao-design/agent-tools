# 飞书云文档接口实测事实

都是在真实文档上验证过的行为，用来避免重新试错。2026-09-23 起本 skill 经 lark-cli 1.0.96（用户身份，直传 JSON）调用；标注「lark-mcp」的条目是之前经 `@larksuiteoapi/lark-mcp@0.5.1` 得出的，换通道后仍成立的已注明。探针原始记录见 `~/docs/requirements-development/feishu-doc-skill-optimization/research/05-p0-probe-results.md`。

## 读取

- `documentBlock.list` 一次分页返回文档内**全部**块，含表格单元格（`block_type=32`）及其文本子块，单元格自带 `children`。逐单元格 `documentBlockChildren.get` 是每格一次调用：74 行 × 6 列的表，`list` 分页 3 次约 1.3 秒，逐格 438 次超过 2 分钟。只有明确只要某块的直接子块时才用 `children.get`。分页必须跟到 `has_more=false`。
- `rawContent` 把块按顺序拼成纯文本，单元格之间的换行数取决于格内文本块个数（每格 2 块是 `\n\n\n`，1 块是 `\n\n`）。同一张表两种形态并存时按分隔符切分会同时出现缺条和错序，表格一律用 `table-read`。
- docs_ai 读取（`docs +fetch`）保留结构、带块 id，能只读大纲、章节、区间或关键词附近；画板连同 mermaid 源码读回；**文本绘图小组件只显示为空的 `<readonly-block type="isv">`**，源码要用 `documentBlock.get` 取 `add_ons.record.data`（`read` 命令已自动补回）。
- 公开接口 `GET /docs/v1/content?content_type=markdown` 损失很大：小组件、画板、图片整块消失且没有占位；高亮块变 `<div class="callout">` 并丢 emoji；分栏被导成表格；表格变 HTML 且没有表头；转义混乱。不要用它读文档。

## docs_ai 写入（`docs +create` / `+update`，Markdown 模式）

2026-09-23 在 lexin 租户实测，用户身份可用，导出 PDF、Word 和页面上都没有「由 AI 生成」标记。

- 一次写对：XML 高亮块（emoji、颜色）、分栏、带 `<colgroup>` 列宽和 `rowspan/colspan` 的表格、15 行 GFM 表格、`@./` 本地图片（含子目录、`<@./带空格 路径.png>`）、行内代码、加粗、链接、`$E=mc^2$` 公式、待办、分割线、嵌套列表、代码块语言。`$100 到 $200` 保持原样。
- 普通 ```` ```mermaid ```` 代码块会被自动转成**画板**；写成 `<whiteboard type="mermaid" path=...>` 反而解析失败（degrade 2107），整块被丢且不回退。画图只用代码块（`publish` 会换成小组件）。
- `> [!NOTE]` 只变成普通引用；XML 标签里的 Markdown 行内语法不解析（`**x**` 原样显示），要写成 `<b>`、`<code>`、`<a href>`。
- 正文里形如标签的文本会被当成未知标签删掉：`List<String>` 只剩 `List`（degrade 4010）；`Map<K, V>`、`a < b` 不受影响。HTML 注释被删并报 4010。
- 页内锚点链接 `[x](#y)` 只剩文字。
- `str_replace`、`block_replace`、`block_insert_after`、`block_delete`、`overwrite` 都可用，每次 revision +1；`warnings` 在 `ok=true` 时也可能有降级，必须检查。
- docs_ai 建不了文本绘图小组件；`publish` 先写占位段落 `[[feishu-mermaid:N]]`，再用块接口在同一位置建小组件并删掉占位（已验证）。

## 文本绘图小组件（add_ons，block_type 40）

- `children.create` 建块：`{"block_type":40,"add_ons":{"component_id":"","component_type_id":"blk_631fefbbae02400430b8f9f4","record":"{\"data\":\"<mermaid>\",\"view\":\"chart\"}"}}`。组件 ID 官方没公开，来自社区实现，lexin 租户 25/25 建块成功，record 原样回读。
- `view`：不传或 `codeChart` 是左代码右图，`chart` 只显示图（`publish` 用这个），`code` 只显示代码。
- 内置 mermaid 不低于 11.10：architecture、kanban、radar、treemap、不带 `-beta` 的 xychart 都能渲染；带 `par` 的时序图、节点里的全角冒号和「→」、`%%{init}%%` 都能渲染（mermaid 8.13 的词法限制对它不适用）。
- quadrantChart、xychart、sankey 里有未加引号的中文时不出图；纯英文或中文加双引号能出图（xychart 已验证加引号写法）。
- 服务端不校验 mermaid 语法，写错也建块成功，只是不出图；发布前用 `check_mermaid.js` 校验。
- 小组件不能 PATCH（社区在同类 add_ons 上实测 1770001），改图 = 同位置新建再删旧块，块 id 会变。

## 画板（block_type 43）

- 建空画板块后，用 `POST /board/v1/whiteboards/{board.token}/nodes/plantuml`（`lark-cli whiteboard +update --input_format mermaid`）填 mermaid，生成可拖拽的节点；`whiteboard +export --output-type source` 能读回源码，`--output-type preview` 导出 jpg。
- 实测：中文判断节点、`-- 是 -->` 与 `-->|是|` 两种边标签、带 autonumber/alt 的时序图、带 `par` 的时序图都成功（`and` 分支会多一个空的 `[]` 标签）；**所有标签都加引号的流程图失败**（2890002，服务端报颜色格式错误）。画板解析器与 mermaid.js 不同，本地能渲染的图不一定能进画板。
- 单次 `children.create` 建 6 个画板块报 1770035（资源数超限），逐个建没问题；上限未测。
- 流程图/UML 块（`block_type=21`）不能通过 API 创建（`1770029`）。

## 表格

- `children.create` 建表 `row_size`、`column_size` **最多 9**，第 10 行起 `1770001 invalid param`，报错不提行数（2026-08-17 实测）。只传 `table.property.row_size/column_size`，单元格由飞书自动生成；手工声明 cell 子块也会 1770001。
- `descendant.create` 没有 9 行上限：经 lark-cli 一次建 15 行 × 3 列（92 块），`header_row` 与 `column_width` 生效（P7）。官方上限：单次 1000 块、表格 100 列、单表 2000 个单元格；lark-mcp 时期实测 500 块可一次写入。
- 已有大表继续原地扩行，不要删表重建（74 行 × 6 列约 889 块）。
- `documentBlock.patch` 的 `insert_table_row`：`row_index: -1` 追加到末尾，`row_index: n` 新行落在 `n`、原第 `n` 行起下移。`batchUpdate` 也声明了 `update_table_property`、`insert_table_row` 等子请求，但同一批里块 id 不能重复，所以对同一张表的多次插行、逐列改宽仍要逐次 `patch`。
- 列宽用 `patch` 的 `update_table_property`（`column_width` 最小 50，另加 `column_index`）逐列设置，回读 `table.property.column_width` 核对。
- 单元格常见两种形态：人工建的 `[空文本块, 内容文本块]`，`insert_table_row` 新建的 `[空文本块]`。混在一张表里行高会不一致；`table-sync --pad-cells=auto`（默认）按既有数据行（跳过表头）每格块数的众数补齐新行，`--pad-cells=off` 关闭。补块只能逐格 `children.create`，N 行 × M 列要 N×M 次调用，是扩表的主要耗时。写入以格内最后一个文本块为目标，读取拼接格内所有文本块。
- `table-sync` 只在末尾补行，靠重写差异格实现中间插入，被下移的行会被重写。

## convert（Markdown/HTML → 块）

- 2026-09-23 实测表格已带 `table.property`（`row_size`、`column_size`、`column_width`、`merge_info`），早先「只给 cells 不给 property」已过时。
- 返回的 `blocks` 数组**不是文档顺序**，要按 `first_level_block_ids` 和各块 `children` 建树；块自带 `parent_id: ""` 要剥掉，写回前还要删只读的 `merge_info`、`comment_ids`；用 `children.create` 时再剥掉 `block_id`。
- `> [!NOTE]` 变普通引用，mermaid 变未标语言的代码块；`- [ ]` 变待办、`---` 变分割线；`$E=mc^2$` 变行内公式，`$100` 保持原样。
- HTML 模式下内联 `<svg>` 被整个丢弃；`<img src="data:...">` 和外链图片只转成图片占位，URL 在 `block_id_to_image_urls`，内容仍要自己上传绑定。
- `publish` 用 docs_ai，不走 convert；convert 只在需要块级 JSON 时用。

## 图片

- 块接口插图三步（需 `docs:document.media:upload`）：建图片块 `{block_type: 27, image: {}}` → `POST /drive/v1/medias/upload_all`（`parent_type=docx_image`、`parent_node=<图片块 id>`）→ `patch` 的 `replace_image` 绑定。docs_ai 的 `![说明](@./a.png)` 更省事，`publish` 用这个。
- 飞书接受直接上传 SVG，但会按 viewBox 尺寸显示，mermaid 导出的 SVG 通常显示得很小；要图片就导出宽度 1600px 以上的 PNG。

## 写入与并发

- `children.create` 的 `index` 是**请求体字段**：`data: { children, index: 0 }`。放在 query 里会被静默忽略，所有插入都变追加（2026-08-19 实测）。它的含义是「插入到该位置」，与 `insert_table_row` 的「新行落在该索引」不同。
- `document_revision_id` 是「这次操作基于哪个版本计算位置」，服务端会把位置换算到最新版本，**不会拒绝旧版本**：基于第 32 版追加的块落在第 32 版时的文末，未来版本号按最新处理（P9）。纯追加传 `-1`；按快照算出的位置要带快照版本号；并发检测只能写前读版本、写后核对是否恰好 +1。
- 评论挂在块 id 上（评论接口 `extra.content_anchor_id`）：原地 `update_text_elements` 保住评论；整块替换后评论仍在列表里、未解决，但指向已删除的块，失去挂靠位置（P12）。
- 频率：应用写接口 3 次/秒（超限 400/99991400），单篇文档编辑 3 次/秒（超限 429）。lark-cli 传输层写请求间隔 350ms，限流自动退避重试 3 次。
- 高亮块、分栏建好后飞书会自动塞一个空段落，写内容要复用它或删掉它。

## 文本编辑与链接

- `update_text_elements` 整体替换 elements，`text_element_style` 不传就丢加粗、行内代码等样式；`table-sync` 只重写有差异的格并沿用原样式。
- 做元素级修改要用 `list-blocks --full --out=<file>` 导出原始块，里面才有 `text.elements[].text_run.text_element_style`。常用块类型：1 页面、2 文本、3–11 为 H1–H9、12 无序列表、13 有序列表、14 代码、19 高亮块、24/25 分栏、27 图片、31 表格、32 单元格、40 小组件、43 画板。
- `link-plan` 的改写规则：按 text_run 拆分，保留原样式，只把匹配子串拆成新 run 加 `link`；跳过已有 `link` 或 `inline_code` 的 run、标题和代码块，只处理 2/12/13，重跑幂等。`update-text` 每批 40 条、确定性 client_token，写后逐块比对内容、样式和解码后的链接，比对前合并相邻同样式 run。2026-09 实测一次 51 处改动全部一致。
- 页内跳转链接格式 `https://lexin.feishu.cn/docx/<document_token>#<heading_block_id>`（已点击验证）；飞书「复制链接」给的 `#share-<id>` 不是 API 的块 id。`link.url` 必须整体 `encodeURIComponent`，`update-text` 和 `link-plan` 会自动编码一次。

## lark-mcp 0.5.1 的字段剥离（历史，skill 已改用 lark-cli）

lark-mcp 的 zod schema 会在请求发出前静默剥掉未声明的字段，本 skill 因此改为经 lark-cli 直传 JSON。已确认被剥的字段：

- descendant 的 `block_id`/`children`（仓库 wrapper 打过补丁）和单元格的 `table_cell`：经 wrapper 用 descendant 建表必定 1770001。
- `children.create` 里 `table.property.column_width`：新表是默认每列 100。
- 有序列表的 `ordered.style.sequence`：descendant、children.create、patch 的 update_text_style/update_text、batchUpdate 五条路径都被剥，建出的有序块没有 sequence，rawContent 也不带编号。需要固定编号时，把列表之间的代码块挂到前一个有序项的 children 下，让各项保持相邻。经 lark-cli 是否保留 sequence 未测。
- callout 的 `emoji_id`：回读成默认的 🎁；docs_ai 的 `<callout emoji="💡">` 正常。

会话里常驻的 `mcp__lark__*`（preset.doc.default）仍走 lark-mcp，只适合读和搜索，不要用它写。
