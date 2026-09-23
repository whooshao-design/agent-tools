# 飞书文档权限与登录

本 skill 经 lark-cli 以用户身份调用开放平台。wrapper：`/home/joney/projects/ai/agent-tools/mcp/third-party-mcp/lark/bin/lark-cli`（固定 `@larksuite/cli@1.0.96`，默认直连不走本机代理）。凭据是 lark-cli 自己的加密文件（`~/.local/share/lark-cli`），不经 gnome-keyring。

## 操作与 scope

| 操作 | 用户身份权限 |
|---|---|
| `read`（docx） | `docx:document:readonly`、`offline_access` |
| `write-blocks`（table-sync、update-text）、`write-json` | `docx:document`、`docx:document:readonly`、`offline_access` |
| `publish` | `docx:document`、`docx:document.block:convert`、`docx:document:create`、`docx:document:write_only`、`docx:document:readonly`、`docs:document.media:upload`、`docs:document.comment:read`、`board:whiteboard:node:create`、`offline_access` |
| `edit` | `docx:document`、`docx:document:write_only`、`docx:document:readonly`、`docs:document.media:upload`、`docs:document.comment:read`、`board:whiteboard:node:create`、`offline_access` |
| `create-doc` | `docx:document`、`offline_access` |
| 任一操作的目标是 wiki 链接 | 另加 `wiki:wiki:readonly` |

`auth:user.id:read` 可留在授权集合里，不是文档读写的业务权限。本 skill 刻意不申请删除权限（`space:document:delete`、`drive:drive`）和列目录权限（`space:document:retrieve`）：要删文档时用 `cleanup-list` 列出清单，由用户在飞书里手动删除。不要申请 `drive:drive:readonly` 这类云空间全量权限：范围过大，且应用没开通时会让整个授权失败（20027）。

## 登录流程

1. 首次使用绑定应用：`mcp/third-party-mcp/lark/bin/lark-cli setup`（从 `env/credentials.env` 读 `LARK_APP_ID`/`LARK_APP_SECRET`，密钥经标准输入传入）。
2. `node <脚本> auth-check --operation=<操作> [--target=<链接>]`：一次性返回缺失的 scope；refresh token 不到 24 小时过期时给出 `warning`。
3. 需要登录或补 scope：`node <脚本> authorize --operation=<操作>`。它会把当前 scope 与目标操作所需 scope 合并后发起设备码登录，先打印 `verification_uri_complete`，然后阻塞到用户确认（最长约 10 分钟）。在 agent 里要**放到后台运行**，把链接原样发给用户，让用户在自己的浏览器或手机飞书里确认；确认后进程结束，再跑一次 `auth-check`。也可以 `authorize --no-wait` 先拿链接和 `device_code`，用户确认后 `authorize --device-code=<code>` 收尾。不在聊天里索要密码、验证码、Cookie 或 token。
4. access token 2 小时，lark-cli 调用前自动续期（过期后 `auth status` 显示 `needs_refresh`，仍然可用）；refresh token 7 天，超过 7 天没用要重新 `authorize`。

## 失败分类与处理

| failureClass | 含义 | 最短处理 |
|---|---|---|
| `LARK_CLI_NOT_CONFIGURED` | 没绑定应用或应用凭证不对 | 运行 `lark-cli setup` |
| `AUTH_REQUIRED` / `TOKEN_EXPIRED` | 未登录、token 失效或 refresh token 过期 | `authorize` 后复检 |
| `OAUTH_SCOPE_MISSING` | 用户 token 缺 scope（`missingScopes` 给出准确名称） | `authorize` 一次性补授权，不要逐项多次授权 |
| `APP_PERMISSION_NOT_PUBLISHED` | 应用在开放平台没开通或没发布这些权限 | 见下文「应用权限未发布」，只重新登录无效 |
| `DOCUMENT_ACCESS_DENIED` | 权限齐全但当前用户对这篇文档没有阅读/编辑权限 | 请文档所有者授权；不要为单篇文档扩大应用权限 |
| `RATE_LIMITED` | 超过 3 次/秒 | 传输层已自动退避重试 3 次；仍失败就放慢批量写入 |
| `LARK_API_FAILED` | 其它接口错误 | 保留 `code` 与 `logId` 如实报告，不要自动扩大权限 |

判定依据是 lark-cli 错误信封的 `type`/`subtype`/`missing_scopes`；错误码 `99991679` 以服务端给出的 scope 为准，`99991672` 是应用未开通，`99991400` 是限流而不是认证过期。

## 应用权限未发布

1. 打开 `open.feishu.cn` 开发者后台，找到 App ID 与 `env/credentials.env` 中 `LARK_APP_ID` 一致的企业自建应用。
2. 「权限管理」里添加错误结果中的准确 scope，身份选用户身份。
3. 创建并发布应用版本（可用范围仅含应用所有者时发布免审，通常立即生效）。授权页只反映已发布版本的权限。
4. 再运行一次 `authorize`。

## 常驻 lark MCP（历史通道）

会话里的 `mcp__lark__*` 仍由 `mcp/third-party-mcp/lark/bin/lark-mcp`（lark-mcp 0.5.1）提供，只适合读和搜索。它的 token 存在 gnome-keyring 加密的本地存储里，钥匙串锁定时会卡住：让用户在**自己的终端**运行 `/usr/bin/python3 /home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/unlock_keyring.py`（getpass 读密码，绝不在聊天里要密码），解锁后再 `lark-mcp login`。本 skill 的脚本不再依赖这条通道。
