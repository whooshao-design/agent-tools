---
name: manage-feishu-doc
description: 经飞书官方 lark-cli 读取、发布、修改并校验 lexin 飞书云文档。Use when 用户提供 lexin.feishu.cn 的 docx、wiki 或 drive/folder 链接，要求读取飞书文档（含 mermaid 小组件与画板源码）、把本地 Markdown（技术方案、操作手册、资料文档）新建发布或覆盖到飞书、在飞书文档里放 mermaid 图、同步表格数据、改写段落或补页内跳转链接、更新托管 JSON 章节、检查飞书登录与权限、在缺权限时申请准确 scope，或列出需要删除的飞书文档交给用户手动删除。
metadata:
  version: 2.1.1
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
node $S auth-check --operation=<read|write-blocks|write-json|publish|create-doc> --target='<链接>'
```

`ready` 就继续。否则按输出的 `failureClass`、`missingScopes`、`nextAction` 一次性告诉用户，不要先用多个接口试错；需要登录时后台运行 `node $S authorize --operation=<操作>`，把输出里的 `verification_uri_complete` 原样发给用户确认。首次使用先 `/home/joney/projects/ai/agent-tools/mcp/third-party-mcp/lark/bin/lark-cli setup`。细节见 `references/permission-matrix.md`。

## 按任务选命令

先判断任务，再读对应的参考文件，不用一次读全。

| 任务 | 命令 | 参考 |
|---|---|---|
| 读文档、看某一节、拿 mermaid 源码或块 id | `read`（默认 Markdown）、`outline` | `references/read.md` |
| 本地 Markdown 发布到飞书，或全量覆盖已发布的文档 | `publish` | `references/publish.md` |
| 把数据源同步进已有表格 | `table-read`、`table-sync` | 本文「表格」 |
| 改段落文字、样式或补标题跳转链接 | `list-blocks --full`、`update-text`、`link-plan` | 本文「元素级编辑」 |
| 把 JSON 写进托管章节 | `write-json`、`inspect-sections` | 本文「托管章节」 |
| 清理测试文档或废弃的发布 | `cleanup-list` | 本文「删除文档」 |
| 本脚本没包装的接口 | `call --method=<M> --path=/open-apis/...` | `references/api-facts.md` |

接口行为、上限和踩过的坑都在 `references/api-facts.md`，动手写之前遇到不确定的行为先查它。

## 发布

```bash
node $S publish --file=<md 绝对路径> --target='<文件夹或知识库节点链接>' --dry-run   # 看计划
node $S publish --file=<md 绝对路径> --target='<文件夹或知识库节点链接>'             # 首次发布
node $S publish --file=<md 绝对路径> --overwrite --dry-run                           # 再次发布先看检查
```

- 首次发布在 md 旁生成 `<文件名>.feishu.json`，之后同一文件不会重复建文档。
- 再次发布目前只支持 `--overwrite` 全量覆盖，增量更新在后续版本提供。覆盖被 `remote_changed`（飞书上有人改过）或 `open_comments`（有未解决评论）阻断时，把原因和评论原样转给用户，由用户决定是否加 `--force` 或 `--accept-comment-loss`，不要自行加。
- `published_with_issues` 要逐项报告 `verification.mismatches`、`diagrams` 状态和 `serverWarnings`。
- 状态文件 `mode` 为 `feishu-master` 的文档以飞书为准，不从本地覆盖；别人的文档不要用 `publish` 接管。

## 表格

```bash
node $S table-read --target='<链接>' --table-index=0
node $S table-sync --target='<链接>' --table-index=0 --file=/absolute/path/rows.json --dry-run
```

输入是 `{"rows": [["表头1","表头2"],["值1","值2"]]}` 或裸二维数组，全部为字符串，含表头行。先 `--dry-run` 看 `rowsToAppend` 和 `cellsToWrite`，确认后去掉。`table-sync` 只重写与期望不同的格，保留原有加粗、行内代码等样式；行数不足在末尾补行并把新行格内块数对齐到既有数据行；输入行数少于现有行数时报 `ROW_COUNT_SHRINK` 停止，不删行；写后逐格回读，不一致报 `VERIFY_FAILED`。要按某列排序时直接交完整的有序二维数组。表格校验一律用 `table-read`，不要用 rawContent 的换行切分。

## 元素级编辑

加链接、改行内样式、重写单元格走「导出原始块 → 生成计划 → dry-run → 写入」：

```bash
node $S list-blocks --target='<链接>' --full --out=/abs/raw.json
node $S link-plan --target='<链接>' --labels=/abs/labels.json --out=/abs/plan.json   # 可选：正文文字 → 标题跳转链接
node $S update-text --target='<链接>' --file=/abs/plan.json --dry-run
node $S update-text --target='<链接>' --file=/abs/plan.json
```

计划是 `[{block_id, elements}]`，整块替换 elements，自己拼 elements 时必须沿用原 run 的 `text_element_style`。`update-text` 跳过已一致的块，每批 40 条、确定性 client_token，写后逐块回读比对内容、样式和解码后的链接。`labels.json` 形如 `{"第 3 章": "3. 国内流水查询"}`（值为标题文本或标题块 id）。原地改写保留块 id，挂在该段的评论不受影响。

## 托管章节

```bash
node $S write-json --target='<链接>' --file=/absolute/path/data.json --section=package-all-info --heading='PackageAllInfo' --mode=upsert
```

`upsert`（默认）先创建并按 SHA-256 校验新章节，再删除旧章节，失败时宁可留下重复章节也不先删旧数据；`append` 不覆盖已有同名章节。输入也可用 `--stdin`。

## 删除文档

本 skill 每次新建文档（`publish` 首次发布、`create-doc`）都会记进 `~/.local/share/agent-tools/feishu-created-docs.jsonl`。需要清理时：

```bash
node $S cleanup-list                                # 本 skill 建过的全部文档
node $S cleanup-list --folder='<文件夹链接>'          # 只看某个目录，例如测试目录
node $S cleanup-list --docs='<链接1>,<链接2>'         # 指定文档
node $S cleanup-list --file=<md 绝对路径>            # 某个本地文件发布出去的文档
```

把输出里的 `checklist`（按目录分组的「文档名 — 链接」清单）原样发给用户，由用户在飞书里手动删除。用户删完再跑一次加 `--prune`：确认已删除的从记录里去掉；对应本地文件的 `<文件名>.feishu.json` 提醒用户一并删除，否则下次发布会报找不到文档。

## 完成标准

- 写操作前已 `auth-check`；缺权限时一次给出准确 scope 和下一步，没有把登录、应用发布、文档权限问题混为一类。
- wiki 链接已解析为真实 docx token。
- 发布：计数校验无不一致、没有残留占位、服务端警告已检查，状态文件已更新；覆盖有备份路径。
- 表格逐格、文本逐块回读一致；托管章节回读 SHA-256 与输入一致。
- 没有泄露 App Secret、access token 或 refresh token；飞书链接只报告给用户，不写进仓库。
