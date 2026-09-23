# lark（飞书 / Feishu）

飞书官方 MCP server `@larksuiteoapi/lark-mcp` 的本地 wrapper，用于读写飞书云文档与知识库。

业务文档入口明确支持：

- `https://lexin.feishu.cn/docx/<document_token>`
- `https://lexin.feishu.cn/wiki/<wiki_token>`

操作流程、权限预检、幂等写入和回读校验由
`skills/lexin/manage-feishu-doc/SKILL.md` 治理。不要把 `ledocs.lexincloud.com` 的文档 ID
直接当作飞书 docx token。

Wrapper：`bin/lark-mcp`，固定版本 `@larksuiteoapi/lark-mcp@0.5.1`，首次运行自动装到
`~/.local/share/agent-tools/mcp-cache/lark`（与 context7 同惯例）。它从仓库公共凭证文件 `env/credentials.env` 读取配置并注入，
**App Secret 不会出现在 Codex/Claude 配置、shell 历史或进程命令行里**。

## 为什么必须走 API 而不是浏览器

组织安全策略禁止在 Linux 上登录飞书客户端。WSL 里用浏览器访问 `lexin.feishu.cn` 会被重定向到
`security.feishu.cn` 并显示 `Access denied / Feishu login on Linux is blocked`，且**认证是成功的**
（页面会显示你的账号名），被拒的是设备合规校验。换任何浏览器、代理、DNS 都无解。

开放平台 API 走应用凭证，不经过客户端登录，因此不受该策略约束。这是唯一可行路径。

## 前置：控制台配置

在 `open.feishu.cn` 开发者后台创建**企业自建应用**，然后：

1. **凭证与基础信息** → 记下 App ID / App Secret
2. **权限管理 → 用户身份权限（user_access_token）** → 开通所需 scope
3. **安全设置 → 重定向 URL** → 添加 `http://localhost:3000/callback`（端口须与 `LARK_OAUTH_PORT` 一致）
4. **版本管理与发布** → 创建版本 → 申请发布

可用范围仅包含应用所有者时发布无需管理员审核，通常立即生效。

## 配置

```bash
cp env/credentials.env.example env/credentials.env
chmod 600 env/credentials.env
# 填写 LARK_APP_ID / LARK_APP_SECRET
```

相关变量（都在公共凭证文件的「飞书」段）：

| 变量 | 说明 |
|---|---|
| `LARK_APP_ID` / `LARK_APP_SECRET` | 必填，来自控制台 |
| `LARK_SCOPE` | **必填**，空格分隔。见下方「坑 1」 |
| `LARK_OAUTH_PORT` | OAuth 回调端口，默认 3000，须与控制台登记的一致 |
| `LARK_TOKEN_MODE` | `user_access_token`（默认，本人身份）或 `tenant_access_token`（应用身份） |
| `LARK_TOOLS` | 工具预设，默认 `preset.doc.default` |
| `LARK_DOMAIN` | 国内版默认 `https://open.feishu.cn`；国际版 `https://open.larksuite.com` |

## 一次性授权

```bash
mcp/third-party-mcp/lark/bin/lark-mcp login
mcp/third-party-mcp/lark/bin/lark-mcp whoami   # 验收：必须列出会话且 scopes 含 docx:/wiki:
```

`login` 会打印授权链接。**必须用 Windows/macOS 浏览器打开**（Linux 会被设备策略拦）。
WSL 的 localhost 转发方向是通的（Windows → WSL），所以回调能正常回到 WSL 中的本地服务。

## 注册

Codex：

```bash
codex mcp add lark -- /home/joney/projects/ai/agent-tools/mcp/third-party-mcp/lark/bin/lark-mcp mcp
```

Claude Code：

```bash
claude mcp add lark -- /home/joney/projects/ai/agent-tools/mcp/third-party-mcp/lark/bin/lark-mcp mcp
```

两端都不需要写任何凭据，wrapper 自己从 `env/credentials.env` 读。

## 已验证可用的工具

`preset.doc.default` 提供 6 个工具：

- `wiki_v2_space_getNode` — wiki 节点 token → 文档 token
- `docx_v1_document_rawContent` — 读文档正文
- `wiki_v1_node_search`、`docx_builtin_search` — 搜索
- `docx_builtin_import`、`drive_v1_permissionMember_create`

该预设能读文档和导入新文档，但**不能修改已有文档块**。2026-09-23 起 `manage-feishu-doc` 不再经
lark-mcp 写入：lark-mcp 0.5.1 已停更，其 zod schema 会静默剥掉 `table_cell`、`column_width`、
`emoji_id` 等字段。skill 改用同目录的 `bin/lark-cli`（飞书官方 CLI，固定版本、默认直连、凭据存加密文件），
这个常驻 MCP 只保留读和搜索用途。

## 权限预检与快速恢复

不要等到写入中途才发现权限不足。目标操作开始前运行：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc.mjs \
  auth-check --operation=write-json --target='https://lexin.feishu.cn/docx/<token>'
```

预检会一次性返回缺失 scope。用户已经要求完成文档操作时，可直接运行对应的 `authorize`
命令并让用户在系统浏览器完成授权；回调结束后会立即复检。错误分类如下：

| 分类 | 含义 | 最短处理 |
|---|---|---|
| `AUTH_REQUIRED` / `TOKEN_EXPIRED` | 无会话或无法续期 | 重新 OAuth |
| `OAUTH_SCOPE_MISSING` | 用户 token 缺 scope | 合并缺失 scope 后一次性重授权 |
| `APP_PERMISSION_NOT_PUBLISHED` | 应用未开通或未发布权限 | 添加准确权限、发布版本，再 OAuth |
| `DOCUMENT_ACCESS_DENIED` | 应用 scope 齐全但文档 ACL 不足 | 申请目标文档阅读/编辑权限 |
| `MCP_TOOL_MISSING` | 当前工具预设未加载接口 | 用 Skill 脚本或调整工具后重启会话 |

飞书错误 `99991679` 以 `permission_violations[].subject` 指出的 scope 为准；OAuth 错误
`20027` 表示请求的权限尚未在应用中生效，不要循环重新登录。

读一篇 wiki 文档要两步（**URL 里的 token 不是文档 ID**）：

```
https://<租户>.feishu.cn/wiki/DrOFwKwq0iiKqvk1603cKrCmnHk
                              └─ wiki 节点 token
wiki_v2_space_getNode(token)        → obj_token（真正的文档 ID）+ obj_type=docx
docx_v1_document_rawContent(obj_token) → 正文纯文本
```

响应结构是 `{"node": {...}}` / `{"content": "..."}`，**没有 `data` 外层包装**，解析时别多套一层。

## 踩过的坑

**坑 1：不显式传 `--scope`，只会拿到 `auth:user.id:read`。**
帮助文档写着「default is all permissions granted to the app」，实测不成立 —— 授权页会显示
「可授予的权限（共 1 项）」，读任何文档都失败。wrapper 已自动把 `LARK_SCOPE` 传给 `login`，
所以这个变量**必填**。判据：授权 URL 里应能看到 `&scope=...`。

**坑 2：权限「已添加」不等于生效，必须发布版本。**
在权限管理里勾选后，OAuth 授权页仍只显示旧权限 —— 授权页只反映**已发布版本**的权限清单。
绿色「免审权限」标签只表示该权限本身不需管理员单独审批，不代表不用发版。

**坑 3：申请多余权限会导致整个授权失败。**
带上 `drive:drive:readonly` 时飞书直接报错 20027「当前应用权限不足」。这个报错**只列出真正缺失的项**，
是很好的诊断信号。读 wiki 只需 `docx:document:readonly` + `wiki:wiki:readonly`，
`drive:drive:readonly`（查看和下载云空间**所有**文件）范围过大且用不上，不要申请。

**坑 4：Linux 上缺 `libsecret` 会导致登录不落盘。**
表现为 `login` 显示 `✅ Successfully logged in`，但紧接着 `whoami` 返回
`No active login sessions found` —— token 只存在于内存，进程退出即丢失。日志里会有
`libsecret-1.so.0: cannot open shared object file` 警告。修复：

```bash
sudo apt install -y libsecret-1-0 gnome-keyring
```

首次使用会弹出「Choose password for new keyring」。**WSL 无桌面会话，建议密码留空**，
否则密钥环长期处于锁定状态，后台启动的 MCP 服务读不出 token，等于没修。

**坑 5：用 `npx` 启动会让 MCP 握手超时。**
`npx -y` 每次冷启动解析包要 30s 以上，超过客户端 30s 的连接超时，表现为
`Failed to connect — connection timed out`。改成固定版本装到缓存目录后启动降到约 2.5s。

**坑 6：换权限后必须 `logout` 再 `login`。**
token 的 scope 在签发时固定，不重新授权拿不到新权限。

**坑 7：token 有效期约 2 小时**，但 `refreshToken` 会自动续期，正常使用无需干预。

## 排障

`whoami` 是唯一可靠的验收点，依次检查：

| 现象 | 原因 |
|---|---|
| `No active login sessions found` | 坑 4，libsecret / 密钥环 |
| `scopes` 只有 `auth:user.id:read` | 坑 1，`LARK_SCOPE` 未生效 |
| `scopes` 缺某一项 | 坑 2，该权限未随版本发布 |
| 客户端显示连接超时 | 坑 5，wrapper 被改回 npx 了 |
| 授权时报 20027 | 坑 3，申请了未开通的权限，报错会指名 |
