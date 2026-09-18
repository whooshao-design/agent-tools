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
| `create-doc` | `docx:document`, `offline_access` | 在指定目录下新建文档（`folder_token`）；**不需要 drive 权限** |
| `insert-image` | `docs:document.media:upload`, `docx:document`, `offline_access` | 建图片块 → 上传媒体 → `replace_image` 绑定 |

`auth:user.id:read` 可保留在 OAuth scope 集合中，但不是文档读写的业务权限。

> **`docs:document.media:upload` 是可以授权到的**（2026-08-17 实测：授权页正常勾选并成功上传）。曾因某次应用身份调用失败而被误判为“应用级未开通”——应用身份与用户身份是两套权限，不能相互推断。缺这个 scope 时 `drive/v1/medias/upload_all` 返回 `99991679`，按第 5 条处理即可，不要直接跳到“去后台发版”。

## 快速判定顺序

0. D-Bus 预检到默认钥匙串 Locked，或 `whoami` 输出 `keytar timeout`：`KEYRING_LOCKED`；`whoami` 60 秒无响应：`WHOAMI_TIMEOUT`。两者都与 OAuth 无关，先按下文「钥匙串锁定」处理。
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

### 钥匙串锁定（KEYRING_LOCKED / WHOAMI_TIMEOUT）

lark-mcp 用 keytar 从 gnome-keyring 读取本地 token 的加密密钥。默认钥匙串处于 Locked 时，`auth-check` 等命令曾在 120s、300s 内都没有任何输出。脚本现在会在启动 lark-mcp 前预检，锁定时几秒内返回 `KEYRING_LOCKED`；设 `FEISHU_DOC_SKIP_KEYRING_CHECK=1` 可跳过预检。

手工判定（`Locked` 为 `<true>` 即锁定）：

```bash
gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets \
  --method org.freedesktop.Secret.Service.ReadAlias default
gdbus call --session --dest org.freedesktop.secrets --object-path '<上一步返回的 collection>' \
  --method org.freedesktop.DBus.Properties.Get org.freedesktop.Secret.Collection Locked
```

处理步骤：

1. 让用户在**自己的终端**运行 `/usr/bin/python3 /home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/unlock_keyring.py`，由 getpass 读取密码（通常是 WSL 登录密码）。绝不让用户在聊天中提供密码，也不要代为输入。必须用系统 `/usr/bin/python3`，pyenv 的 python3 没有 `dbus` 模块。
2. 解锁后本地会话往往失效：运行 `authorize`（公司 SSO 下可能自动完成并输出 `Successfully logged in`），再 `auth-check` 复检到 `ready`。
3. 用户明确同意后，可让其运行同一脚本加 `--empty-password`，把钥匙串密码改为空，以后开机不再锁定。代价是钥匙串文件不再加密，必须先说明再执行。

WSL 下的图形解锁弹窗通常不可用：systemd 用户环境没有 `DISPLAY` 时 gcr-prompter 起不来（可用 `systemctl --user import-environment DISPLAY WAYLAND_DISPLAY` 和 `dbus-update-activation-environment --systemd DISPLAY WAYLAND_DISPLAY` 补环境），即使弹出也可能无法操作；陈旧的 gcr-prompter 进程可能挂住多日，可用 `pgrep -a gcr-prompter` 检查。优先用上面的终端脚本，不要等弹窗。
