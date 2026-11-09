# 新机器安装 agent-tools

适用于 macOS、Linux 与 WSL；Windows 原生不支持。仓库可以克隆到任意路径、任意用户名下，安装器把仓库根写进两端客户端配置并渲染全局指令，skill 文本与脚本都经 `$AGENT_TOOLS_ROOT` 或 `lib/agent_tools` 找到仓库，不需要手改仓库文件。

## 1. 前置软件与最低版本

| 软件 | 最低版本 | 原因 | 检查命令 |
|---|---|---|---|
| Python | 3.11 | `install.py`、`bin/toolchain_audit.py`、`pick_agent.py`、契约测试用 `tomllib`；低版本 `install.py` 退出码 2 | `python3 --version` |
| Node.js | 22.5 | `browser_session.js` 用 `node:sqlite`；低版本脚本直接报错退出码 2（本机验证 v24.15.0） | `node --version` |
| git | 任意现代版本 | lint 用 `git ls-files` 划定受控范围 | `git --version` |
| Claude Code | 2.1.318 | 会给出 skill 目录提示并读 `settings.json` 的 `env`（本机验证版本） | `claude --version` |
| Codex CLI | 0.163.0 | 读 `config.toml` 的 `shell_environment_policy.set`（本机验证 0.167.0） | `codex --version` |
| sudo（Linux/WSL） | — | `npx playwright install-deps chromium` 安装 Chromium 系统共享库 | — |

可选：`rg`（全局指令里"若在 PATH"才用 `rtk`/`rg`）、`bwrap`（Linux，`bin/codex-reviewer` 的 L1 文件系统隔离；没有时输出 `isolation=codex-sandbox-only`）、飞书 `lark-cli`（随仓库 `mcp/third-party-mcp/lark/bin`，见该目录 README）。

## 2. 克隆与安装

```bash
git clone <仓库地址> <任意目录>
cd <任意目录>
cp env/local.env.example env/local.env            # 可选，见第 3 节；不建也能装
python3 install.py --dry-run --with-global --with-subagents --with-session-cleanup --with-mcp
python3 install.py --with-global --with-subagents --with-session-cleanup --with-mcp
git config core.hooksPath bin/git-hooks      # 提交前自动跑六条可移植 lint（硬门禁）
```

一次安装做的事（顺序固定）：读 `env/local.env` → 链接 skill 到 `~/.claude/skills` 与 `~/.codex/skills` → 渲染 `AGENTS.global.md`（追加 `env/AGENTS.local.md`）为 `~/.claude/CLAUDE.md` 与 `~/.codex/AGENTS.md` → 渲染 agents 副本与 hook → `claude mcp add` / `codex mcp add` 注册 `devtools`、`bastion`、`bastion_dba` → 写 `~/.claude/settings.json` 的 `env` 键与 `~/.codex/config.toml` 的 `[shell_environment_policy.set]` 标记块 → 写指针文件 `~/.config/agent-tools/root` → 写 manifest（`~/.claude/.agent-tools-install.json`、`~/.codex/.agent-tools-install.json`）。

退出码：0 全部收敛；1 有项目未收敛（目标位置已有不属于本安装器的内容，输出逐项列出并给出 `--force` 或手工命令）；2 Python 版本低于 3.11。各脚本的引导代码在找不到仓库根时同样以退出码 2 结束并列出三个来源的结果。`--force` 只替换外来项，并把被替换的 MCP 注册原值备份进 manifest，`--uninstall` 时恢复。`--copy` 用复制代替链接，脚本靠 env 与指针文件找仓库根。改了 `AGENTS.global.md`、`env/local.env` 或 `env/AGENTS.local.md` 后重跑 `python3 install.py --with-global`。

## 3. 两份本地配置（都在 `env/`，gitignore）

`env/local.env`（模板 `env/local.env.example`）：只接受四个键，其他键忽略并在 stderr 列出；仓库根由安装器推导，不要写 `AGENT_TOOLS_ROOT`。

| 键 | 默认值 | 用途 |
|---|---|---|
| `AGENT_TOOLS_DOCS_ROOT` | `~/docs` | 文档产物根（周报收集、拓扑输出目录、全局指令"引用解析"一节） |
| `AGENT_TOOLS_WORKSPACE_ROOT` | `~/projects` | 代码工作区根（前端页面反查、前端环境检查、告警下钻、SER 迁移脚本） |
| `BROWSER_SESSION_TOOL_DIR` | `~/.local/share/agent-tools/browser-tool`；默认目录无效而 `~/tools/lexiao-browser` 有效时取后者 | Playwright 工具目录 |
| `AGENT_TOOLS_OPEN_CMD` | 空：darwin `open {target}`，linux `xdg-open {target}`，wsl 走 `powershell.exe Start-Process` | 打开 URL / 文件 / 图片的命令模板 |

`env/AGENTS.local.md`（模板 `env/AGENTS.local.md.example`）：本机专有的全局指令段落，安装器原样追加在渲染后的 `CLAUDE.md` / `AGENTS.md` 末尾。模板给的是 WSL 用 JPEGView 看图的规则，macOS 可整段删掉或改成自己的看图命令。

## 4. 凭据与 MCP 配置（用户准备，仓库只给模板）

| 文件 | 模板 | 内容 |
|---|---|---|
| `env/credentials.env` | `env/credentials.env.example` | 飞书开放平台等公共凭证；可选键 `HIPPO_DEFAULT_GRANT_USERS`（`configure-hippo` 建 namespace 后自动授权的账号，不填则不自动授权并提示）、`OKR_WEEKLY_AUTHOR`（周报收集的本人账号，不填则要求 `--author`）。经 `bin/with-env <命令>` 加载，`chmod 600` |
| `mcp/devtools-mcp/.env` | `mcp/devtools-mcp/.env.example` | GitLab / Jenkins / SonarQube 等 token 与内网域名；MCP 注册项只带 `PYTHONPATH` 与 `BASTION_CONFIG`，其余变量都从这里读 |
| `mcp/bastion-mcp/config.json` | `mcp/bastion-mcp/config.json.example` | 堡垒机机器配置（`bastion`、`devtools` 的 `java_app_diag` 共用） |
| `mcp/bastion-mcp/config.dba.json` | `mcp/bastion-mcp/config.dba.json.example` | DBA 堡垒机配置（`bastion_dba`） |

检查：`python3 bin/toolchain_audit.py` 只读盘点两端 skill 链接、MCP 注册与缺失的环境变量，不联网、不输出密钥。

## 5. 浏览器运行时（lexin 浏览器类 skill）

```bash
bash skills/lexin/get-browser-session/scripts/setup_browser_tool.sh    # 安装锁定版本 Playwright 与平台 Chromium 到 BROWSER_SESSION_TOOL_DIR
sudo npx --prefix "$HOME/.local/share/agent-tools/browser-tool" playwright install-deps chromium   # 仅 Linux/WSL：Chromium 系统共享库
node skills/lexin/get-browser-session/scripts/browser_session.js --doctor   # 报告 Chromium 可用
```

macOS 用 Playwright 自带的 Chromium；Linux/WSL 优先 `<工具目录>/browsers/chrome-linux64/chrome`，没有时同 macOS。脚本结束时 `ldd` 发现缺库会提示上面的 `install-deps` 命令。现有 WSL 机器可以继续用 `~/tools/lexiao-browser`。登录态按 `get-browser-session` skill 在浏览器里完成 SSO 后保存到 `~/.local/state/agent-tools/`。

## 6. 外部模型 wrapper（不在仓库内）

`spawn-model-agent`、`build-codeagent` 与外部模型评审通过 PATH 上的包装器派发：`~/bin/claude-<后端>`、`~/bin/codex-<后端>` 是指向 `claude-profile` / `codex-profile` 的可执行文件，读取 `~/.config/ai-providers/<后端>` 里的网关地址、密钥与模型；`vps` 后端另需 `~/bin/ai-vps-exec`、`~/bin/ai-vps-proxy`。这些文件不随仓库迁移，从已配置的机器把 `~/bin/claude-profile`、`~/bin/codex-profile`、各 `claude-*` / `codex-*` 链接、`~/bin/ai-vps-*` 与 `~/.config/ai-providers/` 复制过来，再把密钥改成本机可用的值。

```bash
python3 skills/common/spawn-model-agent/scripts/spawn_model_agent.py --list                                  # 至少列出一个后端
python3 skills/common/spawn-model-agent/scripts/spawn_model_agent.py --backend <后端> --readonly --slim --task 'echo ok' --wait   # 返回 ok
```

`--list` 为空时，这两个 skill 的核心动作没有后端可用，脚本会指回本文。

## 7. 定时任务与 mdview

- 浏览器登录态续期（`install_session_renewal.py`）与周报（`install_timer.py`）是 systemd user 定时器，只支持 Linux/WSL；macOS 上脚本退出码 2 并打印手工步骤，launchd 版本留待二期。单元文件写入 `AGENT_TOOLS_ROOT` 等变量，复制模式也能找到仓库。
- `tools/mdview/install.sh` 把 `~/.local/bin/mdview` 链到 `tools/mdview/mdview`，Linux/WSL 另按模板 `tools/mdview/systemd/mdview.service.in` 生成 `~/.config/systemd/user/mdview.service`（文档根取 `AGENT_TOOLS_DOCS_ROOT`）；macOS 不装 systemd 单元，直接 `mdview <文件>` 前台运行。

## 8. 验收清单

- [ ] `python3 install.py --with-global --with-subagents --with-session-cleanup --with-mcp` 退出码 0，重跑一次仍为 0。
- [ ] 两端新会话里可用 skill 数与 `ls skills/*/*/SKILL.md | wc -l` 一致（当前 61）。
- [ ] `claude -p 'echo $AGENT_TOOLS_ROOT'` 与 `codex exec 'echo $AGENT_TOOLS_ROOT'` 都输出克隆路径；Codex 若自配了 `shell_environment_policy` 的 `include_only` / `filters`，要放行 `AGENT_TOOLS_*`。
- [ ] 在 Claude 会话里按渲染后的 `~/.claude/CLAUDE.md` 打开 `skills/dev-workflow/references/delegation-contract.md`。
- [ ] `python3 -m unittest discover -s tests`、`python3 -m unittest discover -s hooks/tests`、`node --test 'skills/**/*.test.js' 'skills/**/*.test.mjs'`、`node --test tools/mdview/tests/*.test.mjs` 通过。
- [ ] `browser_session.js --doctor` 报告 Chromium 可用；`query_app_instances.js`、`hippo_query.js` 各跑一次只读命令能到登录页。
- [ ] `mdview <任意 .md>` 打开浏览器；`frontend_env.js doctor` 在内存充足的机器上不被内存门禁拒绝。
- [ ] `spawn_model_agent.py --list` 至少一个后端，并能派发 `echo ok`。

## 9. 现有 WSL 机器迁移

第一次重跑前：把现有 devtools 注册里的 7 个业务 env 写进 `mcp/devtools-mcp/.env`；把 `HIPPO_DEFAULT_GRANT_USERS`、`OKR_WEEKLY_AUTHOR` 写进 `env/credentials.env`；想保留 JPEGView 规则就把它放进 `env/AGENTS.local.md`。然后 `python3 install.py --with-global --with-subagents --with-mcp --force` 一次（输出列出被替换的三条 MCP 注册与写回的额外键），之后同一命令不带 `--force` 重装退出码 0。`~/.claude/CLAUDE.md` 与 `~/.codex/AGENTS.md` 从链接变为渲染副本。旧的 `~/bin/codex-reviewer`、`~/tools/lexiao-browser` 在两台机器验收通过后再删。

## 10. 卸载与回滚

`python3 install.py --uninstall --with-global --with-subagents --with-session-cleanup --with-mcp` 只删 manifest 记录且未被改动的链接、副本、env 键与 MCP 注册，恢复被 `--force` 替换的原注册；指向其他克隆的指针文件与用户改过值的 env 键保留并逐项说明。回滚某次升级：新版 `--uninstall` → `git checkout` 旧版本 → 旧版重新安装。
