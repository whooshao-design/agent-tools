# 飞书文档权限矩阵

## 操作与 scope

| 操作 | 必需用户身份权限 | 说明 |
|---|---|---|
| `read`（docx） | `docx:document:readonly`, `offline_access` | 读取正文；`offline_access` 用于 refresh token 自动续期 |
| `read`（wiki） | `wiki:wiki:readonly`, `docx:document:readonly`, `offline_access` | 先解析 wiki 节点，再读取真实 docx |
| `write-json`（docx） | `docx:document`, `docx:document:readonly`, `offline_access` | 写入后需要读取块并校验 SHA-256 |
| `write-json`（wiki） | `wiki:wiki:readonly`, `docx:document`, `docx:document:readonly`, `offline_access` | 先解析 wiki，再写入和回读 |
| `write-blocks`（docx） | `docx:document`, `docx:document:readonly`, `offline_access` | 改已有块：表格同步、段落更新；与 `write-json` 同权限，命名区分意图 |
| `write-blocks`（wiki） | `wiki:wiki:readonly`, `docx:document`, `docx:document:readonly`, `offline_access` | 先解析 wiki，再改块和回读 |
| `convert` | `docx:document.block:convert`, `offline_access` | 仅把 Markdown/HTML 转成块，不包含把块写入目标文档 |
| `write-markdown` | `docx:document.block:convert`, `docx:document`, `docx:document:readonly`, `offline_access` | 转换、写入和回读的组合操作 |

`auth:user.id:read` 可保留在 OAuth scope 集合中，但不是文档读写的业务权限。

## 快速判定顺序

1. `whoami` 没有会话：`AUTH_REQUIRED`。
2. access token 已过期且没有 refresh token：`TOKEN_EXPIRED`。
3. 当前 token scope 缺少矩阵中的权限：`OAUTH_SCOPE_MISSING`，一次性列出全部缺失项。
4. OAuth 返回 `20027`：应用未开通或未发布请求中的权限，分类为 `APP_PERMISSION_NOT_PUBLISHED`。
5. API 返回 `99991679`：解析 `permission_violations[].subject`，以服务端指出的 scope 为准。
6. scope 齐全但目标文档仍返回禁止访问：`DOCUMENT_ACCESS_DENIED`，申请文档阅读/编辑 ACL。
7. MCP `tools/list` 不含目标工具：`MCP_TOOL_MISSING`，与权限无关。

## 最短恢复路径

### 用户 token 缺 scope

运行 `authorize --operation=<操作> --target=<链接>`。脚本会把当前 scope 与目标操作所需 scope 合并，重新授权后立即复检。不要逐项多次授权。

### 应用权限未发布

1. 打开 `open.feishu.cn` 开发者后台对应企业自建应用。
2. 在“权限管理”添加错误结果中的准确 scope，身份类型选择用户身份。
3. 创建并发布应用版本。
4. 再运行一次 `authorize`；仅重新登录不会让未发布权限生效。

### 文档 ACL 不足

让文档所有者或管理员给当前用户授予阅读/编辑权限。不要为单篇文档 ACL 问题申请云空间全量权限。

### MCP 工具未加载

直接使用 `scripts/feishu_doc_mcp.mjs` 兜底。若需要在会话内直接调用，调整 `LARK_TOOLS` 后重启客户端；OAuth 不会让缺失工具出现。
