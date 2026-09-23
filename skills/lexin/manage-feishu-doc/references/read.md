# 读取飞书文档

`S=/home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc.mjs`

## 选哪个命令

| 目的 | 命令 |
|---|---|
| 把正文给 agent 读（默认） | `node $S read --target=<链接>`：docs_ai 输出的 Markdown，小组件补成 ```` ```mermaid ````，画板也是 ```` ```mermaid ```` |
| 大文档先看结构 | `node $S read --target=<链接> --scope=outline --max-depth=2` 或 `node $S outline --target=<链接>`（带标题块 id） |
| 只读一节 | `node $S read --target=<链接> --scope=section --start-block-id=<标题块 id>` |
| 找关键词附近 | `node $S read --target=<链接> --scope=keyword --keyword='a\|b' --context-before=1 --context-after=1` |
| 要改文档，需要块 id | 加 `--format=xml --with-ids`（每个块带 `id`，小组件显示为 `<mermaid-widget id=…>`） |
| 结构化读表、校验表格 | `node $S table-read --target=<链接> --table-index=<n>` |
| 元素级修改前拿原始块 | `node $S list-blocks --target=<链接> --full --out=<绝对路径>` |
| 只想速览纯文本 | `--format=text`（rawContent，不能用来校验表格） |

正文很长时加 `--out=<绝对路径>`，只在输出里留摘要，避免把整篇拉进上下文。wiki 链接会先解析成真实 docx token（需要 `wiki:wiki:readonly`）。

## 输出里要注意的

- `widgets.mermaid` 是补回源码的小组件个数；`widgets.other` 是其它第三方小组件，保留为 `<readonly-block type="isv">`，读不到内容。
- 图片显示为飞书文件链接，要看图片内容需另行下载（`lark-cli docs +media-download`）。
- 嵌入的电子表格、多维表格只给 `<sheet token>` 之类的标签，不展开数据。
- 从飞书读出的 Markdown 已经按 docs_ai 规则转义，拿去回写时不要反转义（`\[`、`\|`、`\\` 都有含义）。
- 不要用公开接口 `docs/v1/content` 读文档：小组件、画板、图片会整块消失（见 `api-facts.md`）。
