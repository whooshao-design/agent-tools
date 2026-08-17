---
name: manage-feishu-doc
description: 通过飞书官方 Lark MCP 读取、追加、替换并校验飞书云文档内容。Use when 用户提供 lexin.feishu.cn/docx 或 lexin.feishu.cn/wiki 链接，要求读取飞书文档、把 JSON/文本写入已有文档、更新已有表格或段落、按数据源同步表格数据、更新托管章节、检查文档或 OAuth 权限，或在缺权限时快速申请准确 scope。
metadata:
  version: 1.1.0
---

# Manage Feishu Doc

## 定位与边界

治理 `lexin.feishu.cn/docx/<token>` 与 `lexin.feishu.cn/wiki/<token>` 的文档读写、权限预检、幂等更新和回读校验。

MCP 优先、脚本兜底：当前会话已暴露 `mcp__lark__*` 时优先直接调用；写入已有文档所需工具未暴露时，使用本 Skill 的 MCP 客户端脚本。不要通过 Linux 浏览器访问飞书文档；组织设备策略会拦截。`get-browser-session` 只处理其他网页会话。

不治理飞书消息、日历、多维表格，也不把 `ledocs.lexincloud.com` 链接猜测成飞书文档 token。

## 工作流

1. 解析目标，确认 host、资源类型和 token：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc_mcp.mjs \
  parse-target --target='<飞书链接>'
```

2. 在第一次文档 API 调用前按操作预检权限：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc_mcp.mjs \
  auth-check --operation=write-json --target='<飞书链接>'
```

权限齐全时直接继续。缺权限时一次性向用户说明 `missingScopes`、`failureClass` 和 `nextAction`，不要先用多个 API 试错。完整映射见 `references/permission-matrix.md`。

3. 用户已经要求完成目标文档操作时，可直接启动一次 OAuth 授权；让用户只在系统浏览器完成授权，不索取密码、验证码、Cookie 或 token：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc_mcp.mjs \
  authorize --operation=write-json --target='<飞书链接>'
```

授权完成后必须再次运行 `auth-check`。若返回 `APP_PERMISSION_NOT_PUBLISHED`，OAuth 无法自愈：给出确切 scope，要求在开放平台添加用户身份权限、发布应用版本后再授权。

4. 执行操作。读取全文纯文本：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc_mcp.mjs \
  read --target='<飞书链接>'
```

`read` 返回的是 rawContent 纯文本，只适合速览。**不要用它做表格内容校验**：单元格之间的换行数取决于格内块数，同一份内容会因排版差异解析成不同结果。要看结构就用 `list-blocks`（一次分页拿到全部块、块类型统计和表格清单），要看表格就用 `table-read`：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc_mcp.mjs \
  list-blocks --target='<飞书链接>'

node /home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc_mcp.mjs \
  table-read --target='<飞书链接>' --table-index=0
```

把数据源同步进已有表格（含表头行，行数只增不减）：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc_mcp.mjs \
  table-sync --target='<飞书链接>' --table-index=0 \
  --file=/absolute/path/rows.json --dry-run
```

输入是 `{"rows": [["表头1","表头2"],["值1","值2"]]}` 或裸二维数组，全部为字符串。先跑 `--dry-run` 看 `rowsToAppend` 和 `cellsToWrite`，确认无误后去掉该参数正式写入。`table-sync` 只写与期望不同的格，因此不会破坏未变更单元格的加粗、行内代码等样式；行数不足会自动在末尾补行，并把新行的格块数对齐到既有数据行（避免行高不一致）；输入行数少于现有行数时直接报 `ROW_COUNT_SHRINK` 停止，不会删行。写入后自动逐格回读校验，不一致则报 `VERIFY_FAILED` 并列出 mismatches。

需要顺序敏感的表格（例如按某列排序）时，直接把排好序的完整二维数组交给 `table-sync`：它按最终状态对齐，不需要你计算插入位置。

脚本没有包装的 API 用 `call` 逃生口，目标工具会按需加载：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc_mcp.mjs \
  call --target='<飞书链接>' --api=docx.v1.documentBlock.get --operation=read \
  --file=/absolute/path/args.json
```

块级操作细节（表格行插入语义、单元格块结构、批量写入上限）见 `references/docx-block-operations.md`。

把 JSON 写入已有文档的托管章节：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc_mcp.mjs \
  write-json --target='<飞书链接>' --file=/absolute/path/data.json \
  --section=package-all-info --heading='PackageAllInfo' --mode=upsert
```

`upsert` 是默认模式：先创建并精确校验新章节，再删除旧章节；失败时宁可留下重复章节，也不先删旧数据。`append` 不覆盖已有同名章节。输入也可用 `--stdin`。

5. 只在富 Markdown/HTML 必须转换为原生文档块时使用 convert；JSON 和纯文本直接创建块，避免申请 `docx:document.block:convert`。

## 权限和错误处理

- `AUTH_REQUIRED` / `TOKEN_EXPIRED`：运行 `authorize`，授权后复检一次。
- `OAUTH_SCOPE_MISSING`：从 `permission_violations[].subject` 提取准确 scope，只申请缺失项。
- `APP_PERMISSION_NOT_PUBLISHED`：先在应用后台添加并发布权限；不要反复 OAuth。
- `DOCUMENT_ACCESS_DENIED`：OAuth scope 已齐全，申请目标文档的编辑/阅读 ACL；不要扩大应用 scope。
- `MCP_TOOL_MISSING`：当前工具预设不含目标工具；改用本 Skill 脚本或重启已更新 MCP 的会话。

授权后使用相同的确定性 `client_token` 最多重试一次。写入成功必须报告文档 token、section、内容 SHA-256、文档版本及回读校验结果；不得输出 access token、refresh token 或 App Secret。

## 完成标准

- `lexin.feishu.cn` 链接未经过浏览器链路。
- 写操作前权限已预检，缺失权限有准确分类和一步到位的后续动作。
- Wiki token 已解析为 `obj_type=docx` 的真实文档 token。
- 写入具备确定性幂等标识；托管章节回读 SHA-256 与输入一致，表格写入逐格回读与输入一致。
- 表格类结果用 `table-read` 结构化比对确认，没有把 rawContent 的换行切分当作校验依据。
- 没有泄漏凭据；失败时没有把 OAuth、应用发布、文档 ACL 和工具加载问题混为一类。
