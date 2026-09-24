---
name: manage-feishu-doc
description: 经飞书官方 lark-cli 读取、发布、修改并校验 lexin 飞书云文档。Use when 用户提供 lexin.feishu.cn 的 docx、wiki 或 drive/folder 链接，要求读取飞书文档（含 mermaid 小组件与画板源码）、把本地 Markdown（技术方案、操作手册、资料文档）新建发布到飞书或把本地改动增量同步/整篇覆盖过去、在飞书文档里插入替换删除一段或一节、替换一处文字、按技术方案/操作手册/资料文档排版、在飞书文档里放 mermaid 图或图表、发布前检查 Markdown 写法、把 HTML 转成可发布的 Markdown、同步表格数据或删行、合并单元格、调列宽、改写段落或补页内跳转链接、更新托管 JSON 章节、检查飞书登录与权限、在缺权限时申请准确 scope，或列出需要删除的飞书文档交给用户手动删除。
metadata:
  version: 2.3.0
---

# Manage Feishu Doc

## 定位与边界

治理 `lexin.feishu.cn` 云文档的读、发布、修改和权限。一律用本 skill 的脚本，它经官方 lark-cli 以用户身份调用开放平台；会话里的 `mcp__lark__*` 常驻工具走已停更的 lark-mcp，只在脚本不可用时拿来读和搜索，不用它写。

- 不经 Linux 浏览器访问飞书，组织设备策略会拦截。
- 不治理飞书消息、日历、多维表格；不把 `ledocs.lexincloud.com` 链接当成飞书 token。
- 飞书上的写入对他人可见：发布、覆盖、改表、改文字都要用户明确要求。
- 不删除飞书文档，也不申请删除权限（`space:document:delete`、`drive:drive`）。需要删除时用 `cleanup-list` 列出文档名、链接和所在目录，交给用户在飞书里手动删。探针、回归测试和任何试写只落测试目录：`env/credentials.env` 的 `FEISHU_TEST_FOLDER`（`bin/with-env` 载入），不要在正式文档上试错。

脚本：`S=/home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc.mjs`

## 先确认登录与权限

```bash
node $S auth-check --operation=<read|write-blocks|write-json|publish|edit|table-edit|create-doc> --target='<链接>'
```

`lint` 只读本地文件，不需要登录。其余命令 `ready` 就继续。否则按输出的 `failureClass`、`missingScopes`、`nextAction` 一次性告诉用户，不要先用多个接口试错；需要登录时后台运行 `node $S authorize --operation=<操作>`，把输出里的 `verification_uri_complete` 原样发给用户确认。首次使用先 `/home/joney/projects/ai/agent-tools/mcp/third-party-mcp/lark/bin/lark-cli setup`。细节见 `references/permission-matrix.md`。

## 按任务选命令

先判断任务，再读对应的参考文件，不用一次读全。

| 任务 | 命令 | 参考 |
|---|---|---|
| 读文档、看某一节、拿 mermaid 源码或块 id | `read`（默认 Markdown）、`outline` | `references/read.md` |
| 写要发布的 Markdown：飞书方言、特殊字符、HTML 转换 | — | `references/markdown-profile.md` |
| 画图、选图的容器、做图表 | — | `references/diagrams.md` |
| 按文档类型排版；发布前检查 Markdown | `lint` | `references/authoring-rules.md` |
| 本地 Markdown 发布到飞书，或把本地改动同步过去（默认增量，可整篇覆盖） | `publish` | `references/publish.md` |
| 直接在飞书文档里插入、替换、删除一段或一节，或替换一处文字 | `edit` | `references/update.md` |
| 保留样式改段落文字、补标题跳转链接、写托管 JSON 章节 | `update-text`、`link-plan`、`write-json` | `references/update.md` |
| 把数据源同步进已有表格，删行、合并或拆分单元格、调列宽 | `table-read`、`table-sync`、`table-edit` | `references/tables.md` |
| 清理测试文档或废弃的发布 | `cleanup-list` | 本文「删除文档」 |
| 本脚本没包装的接口 | `call --method=<M> --path=/open-apis/...` | `references/api-facts.md` |

接口行为、上限和踩过的坑都在 `references/api-facts.md`，动手写之前遇到不确定的行为先查它。

## 发布

```bash
node $S lint --file=<md 绝对路径>                                                  # 写完先检查
node $S publish --file=<md 绝对路径> --target='<文件夹或知识库节点链接>' --dry-run   # 看计划
node $S publish --file=<md 绝对路径> --target='<文件夹或知识库节点链接>'             # 首次发布
node $S publish --file=<md 绝对路径> --dry-run                                     # 再次发布：默认增量，先看改动摘要
node $S publish --file=<md 绝对路径> --overwrite --dry-run                         # 整篇覆盖（用户明确要求时）
```

- `lint` 的错误必须改完（`publish` 也会挡住）；警告带行号，逐条判断，保留的告诉用户飞书上会是什么样。
- 首次发布在 md 旁生成 `<文件名>.feishu.json`，之后同一文件不会重复建文档。
- 再次发布默认增量：只改本地变了的段落，只改了字的段落和标题原地改写，块 id 和评论都保住。整篇覆盖要用户明确要求才加 `--overwrite`；`needs_mode` 表示旧版本的发布记录没有逐段映射，需要覆盖一次。
- 被 `remote_changed`（要改的段落在飞书上被人改过）、`remote_inserted`（飞书上多了本地没有的块）、`remote_reordered`（飞书上调整过段落顺序）、`remote_title_changed`（两边都改了标题）或 `open_comments`（有未解决评论挂在要替换的块上）阻断时，把原因和评论原样转给用户，由用户决定是否加 `--force` 或 `--accept-comment-loss`，不要自行加。
- `published_with_issues` 要逐项报告 `verification.mismatches`、`diagrams` 状态和 `serverWarnings`。
- 状态文件 `mode` 为 `feishu-master` 的文档以飞书为准，不从本地发布；别人的文档不要用 `publish` 接管，改用 `edit`。

## 局部修改

以飞书为准的文档（定稿移交后、别人的文档）直接在飞书上改，先 `read --format=xml --with-ids` 或 `outline` 找块 id 和标题：

```bash
node $S edit --target='<链接>' --op=replace-section --heading='<标题>' --file=<片段 md> --dry-run
node $S edit --target='<链接>' --op=insert-after --after-heading='<标题>' --file=<片段 md>
node $S edit --target='<链接>' --op=replace-text --pattern='<原文>' --content='<新文字>'
```

- 操作还有 `replace`/`delete`（按块 id）、`delete-section`；片段按 `references/markdown-profile.md` 写，mermaid 会建成小组件。
- 标题重名直接报错并列出块 id，改用 id；`replace-text` 出现多次要 `--all`。
- 范围里有图片、画板、小组件、嵌入表格等无法原样写回的块（`protected_blocks`），或有未解决评论（`open_comments`）时会阻断：原样告诉用户，确认后才加 `--allow-protected`、`--accept-comment-loss`。
- 以本地为准的文档改本地 md 后 `publish`；对它用 `edit` 会给出 `warning`，因为下次增量发布会因飞书上的改动停下。

## 删除文档

本 skill 每次新建文档（`publish` 首次发布、`create-doc`）都会记进 `~/.local/share/agent-tools/feishu-created-docs.jsonl`。需要清理时：

```bash
node $S cleanup-list                                # 本 skill 建过的全部文档
node $S cleanup-list --folder='<文件夹链接>'          # 只看某个目录，例如测试目录
node $S cleanup-list --docs='<链接1>,<链接2>'         # 指定文档，不限本 skill 建的
node $S cleanup-list --file=<md 绝对路径>            # 某个本地文件发布出去的文档
```

把输出里的 `checklist`（按目录分组的「文档名 — 链接」清单）原样发给用户，由用户在飞书里手动删除。用户删完再跑一次加 `--prune`：确认已删除的从记录里去掉；对应本地文件的 `<文件名>.feishu.json` 提醒用户一并删除，否则下次发布会报找不到文档。

## 完成标准

- 写操作前已 `auth-check`；缺权限时一次给出准确 scope 和下一步，没有把登录、应用发布、文档权限问题混为一类。
- wiki 链接已解析为真实 docx token。
- 发布：计数校验无不一致、没有残留占位、服务端警告已检查，状态文件已更新且 `verification.incrementalReady` 为 true；覆盖有备份路径；增量发布报告了 `summary`。
- 局部修改：先 `--dry-run` 核对 `removedPreview`，写后状态为 `updated`，必要时 `read` 回读核对。
- 写前检查：`lint` 没有错误；mermaid 语法校验若被跳过，已说明原因。
- 表格逐格、文本逐块回读一致；托管章节回读 SHA-256 与输入一致。
- 没有泄露 App Secret、access token 或 refresh token；飞书链接只报告给用户，不写进仓库。
