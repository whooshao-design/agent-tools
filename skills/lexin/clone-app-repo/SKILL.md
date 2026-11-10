---
name: clone-app-repo
description: 按应用名、乐效 app_id 或仓库地址定位 GitLab 仓库并克隆到本地工作区：从乐效 list_simple_app 取 git_addr 与 owner/manager，先查工作区里是否已有同一仓库的克隆，按同一 GitLab group 已有克隆的位置建议父目录，用 git ls-remote 探测权限，无权限时停下让用户申请。Use when 本地工作区按检索顺序搜不到某个应用、接口实现或依赖模块的源码，需要把对应仓库克隆下来再继续查代码；或用户要求把某个应用的代码拉到本地、问某应用的 Git 仓库地址；不负责分支管理、提交推送、乐效构建或部署。
metadata:
  version: 1.0.0
---

# clone-app-repo

## 定位

把“本地没有这个源码”变成“仓库已经在工作区里”：应用名 → 乐效 `list_simple_app` 的 `git_addr` → 本地已有克隆检查 → 目标目录对齐 → `git clone`。
只做只读查询和一次 `git clone`，不改远端、不建分支、不提交推送、不改 Git 凭据。

MCP 没有“应用名 → Git 地址”的工具，乐效查询走固定脚本；本地已有克隆的检查也可用 `mcp__devtools__list_local_git_repos`。
脚本复用 `query-app-instances` 的乐效登录态（浏览器 profile 与 Cookie 快照），不索要、不输出 Cookie。

### 和相邻 skill 的边界

| 线索 | 先用谁拿到应用名或仓库地址 | 然后 |
|---|---|---|
| 应用名（日志、告警、`app.properties`、乐效页面） | 直接用 | 本 skill |
| Dubbo/FSOF service 名 | `query-dubbo-registry`（service → 提供方应用） | 本 skill `--app=<应用名>` |
| OA 网关 URL / 前端请求 | `query-oa-gateway-interface`（URL → interface → 应用） | 本 skill |
| Maven 坐标（依赖 jar 的 groupId:artifactId） | `mcp__devtools__gitlab_code_search` 搜 `<artifactId>` 的 pom，或 `mcp__devtools__maven_pom` 看 scm | 本 skill `--repo=<group/project>` |
| 已知 GitLab 地址 | 不用查 | 本 skill `--repo=<url>` |

本地源码检索顺序本身由工作区 `AGENTS.md`（目标仓库 → 相关仓库 → 工作区兜底 → `--hidden -u` 复核）规定；只有完成那套检索仍找不到源码，才进入本 skill。

## 用法

查询（不克隆）：

```bash
node scripts/clone_app_repo.js --app=server_credit_api
node scripts/clone_app_repo.js --app-id=584 --json
node scripts/clone_app_repo.js --repo=credit_platform/server-credit-api-java
```

克隆到约定好的父目录（相对工作区根，或绝对路径）：

```bash
node scripts/clone_app_repo.js --app=server_credit_api --dir=backend/credit
node scripts/clone_app_repo.js --repo=rc_comm/feature-api-compute --dir=backend/feature --branch=master
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--app` / `--app-id` / `--repo` | 三选一 | `--app` 同时按 `project_name`（精确）和 `name`（模糊）搜乐效；`--repo` 接 Git URL 或 `group/project`（补成 `https://gitlab.fenqile.com/...`） |
| `--dir` | — | 给了才克隆；父目录相对工作区根解析 |
| `--name` | URL 里的仓库名 | 克隆目录名，只能是单级目录名（`[A-Za-z0-9._-]`，不以 `.` 开头） |
| `--branch` / `--depth` | 默认分支 / 全量 | 透传 `git clone` |
| `--protocol` | `keep` | `http`/`https`/`ssh` 改写克隆地址；乐效给的是 `http://`，本机已有克隆多数也是 `http://`，默认不改 |
| `--workspace` | `AGENT_TOOLS_WORKSPACE_ROOT`，否则 `~/projects` | 工作区根 |
| `--scan-depth` | `4` | 扫描已有克隆的目录深度 |
| `--no-probe` | — | 查询模式跳过 `git ls-remote` 权限探测 |
| `--profile` | 同 `query-app-instances` | 乐效浏览器 profile |
| `--format=json` / `--json` | table | 机器可读输出 |

`status` 与退出码：`lookup`/`exists`/`cloned` 0；`ambiguous` 查询模式 0、带 `--dir` 时 1；`no_access` 3；`no_credential` 4；`network` 5；`not_found` 6；`timeout`、`target_exists`、参数错误及其他错误 1；未找到 agent-tools 仓库根或浏览器运行时 2。输出里所有 URL、git 命令和 stderr 都先把 `user:password@` 脱敏为 `***@`。字段说明见 `references/lexiao-app-repo-fields.md`。

## 工作流

1. **先证明本地没有。** 按工作区 `AGENTS.md` 完成目标仓库、相关仓库、工作区兜底和 `--hidden -u` 复核；默认 `rg` 无结果不是“本地没有”。
2. **把线索换成应用名或仓库地址。** 按上面的边界表走一跳；拿不到应用名就把已知线索（service 名、接口前缀、jar 坐标）告诉用户，不要猜仓库名。
3. **跑查询模式**，按 `status` 处理：
   - `exists`：工作区里已有克隆，直接去 `local_clones[].path` 继续查代码，不再克隆。同一仓库可能有多份克隆（例如 `backend/business` 与 `backend/credit` 各一份），在回复里列出全部路径并说明用了哪一份。
   - `ambiguous`：多个乐效应用命中，把 `candidates[]`（`app_name`、`project_name`、`git_addr`、`owner`）列给用户选，或改用 `--app-id`。
   - `not_found`：核对名字（`project_name` 要精确、`name` 模糊、下划线和连字符脚本已互换尝试）；仍没有就请用户给仓库地址，用 `--repo`。
   - `no_access`：停止。把 `repo.web_url` 和候选里的 `owner`、`manager` 给用户，请用户在 GitLab 项目页申请访问权限或找 owner 开权限；权限到手前不要反复重试，也不要换协议、换账号绕过。
   - `no_credential`：本机 git 对该 host 没有可用凭据（credential store 为空或被拒、ssh 无 key）；告诉用户并等用户处理，不在会话里收集密码或 token。
   - `network`：GitLab 不可达（解析失败、连接拒绝/超时、证书错误），先确认 VPN/aTrust、代理与证书，再重跑。
   - `timeout`：`git clone` 超过 `--timeout`（默认 600000 ms）被终止；大仓库加大 `--timeout` 或先 `--depth=1`。
   - `lookup`：进入第 4 步。
4. **对齐目标目录。** `suggested_parent_dirs` 来自同一 GitLab group 已有克隆所在的父目录（按数量排序）。
   - 只有一个建议，且与工作区根 `AGENTS.md` 目录导航表的分类一致：直接用它，并在回复里写明“按同组已有克隆放在 `<dir>`”。
   - 没有建议、有多个建议、建议与导航表矛盾，或者仓库属于聚合目录下的子域（海外项目、仿真、历史服务）：把候选目录连同导航表里的分类列给用户，等用户选定再克隆。
   - 用户给了目录就用用户的；不要为了“整齐”自行迁移已有克隆。
5. **克隆。** 带 `--dir` 重跑；需要特定分支加 `--branch`。脚本以 `GIT_TERMINAL_PROMPT=0` 运行，不会卡在交互输入；先克隆到父目录下本次创建的 `.clone-app-repo-<随机>/<name>`，成功后改名到 `<父目录>/<name>`，目标已存在（非空目录、文件、符号链接）时报 `target_exists`，不覆盖、不删除；失败或超时只删除这个临时目录。被 Ctrl-C/kill 打断时临时目录可能残留，下次运行会在 `stale_temp_dirs` 里列出，由用户确认后手动删除。
6. **收尾。** 回复里给出克隆路径、分支、remote；若工作区根 `AGENTS.md` 维护目录导航表，提议补一行并经用户确认后再改；然后回到原任务，在新克隆里继续检索并以“文件路径 + 行号”给结论。

## 口径要点

1. `git_addr` 是乐效登记的地址，个别应用可能为空或过期；为空时报错并请用户给地址，不要按 `group_name/project_name` 自行拼接后当成事实。
2. 乐效行的 `name`/`app_name` 是运行时应用名（多带下划线），`project_name` 多数等于仓库名（多带连字符）；两者不一定相同，回复里都写出来。查询时脚本对输入同时尝试原样、`_`→`-`、`-`→`_` 三种写法。
3. `ls-remote` 返回 `repository not found` 时，GitLab 对“无权限”和“不存在”给的是同一句话；脚本统一归为 `no_access`，回复里要说明两种可能。
4. 本地已有克隆按 host + project path 比对，`http://`、`https://`、`ssh` 三种写法视为同一仓库；不同 host 上的同名项目不算。
5. 工作区根若有一个空的 `.git/` 目录（没有 `HEAD`），脚本不把它当仓库，继续往下扫描。

## 安全边界

- 只读乐效；对远端只执行 `git ls-remote` 与 `git clone`，对本地只执行 `git remote get-url origin`（扫描已有克隆）和 `git rev-parse --abbrev-ref HEAD`（读克隆后的分支）；不 push、不 fetch 已有仓库、不改 `~/.gitconfig` 和凭据文件。
- 不输出 Cookie、token；URL 里的 `user:password@` 在输出前脱敏；`owner`/`manager` 只用于告诉用户找谁申请权限。
- 只创建 `--dir` 指定的父目录和其下本次运行的 `.clone-app-repo-*` 临时目录，只删除该临时目录；不删除或覆盖任何已有目录、文件或符号链接。
