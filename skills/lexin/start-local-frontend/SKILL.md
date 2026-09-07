---
name: start-local-frontend
description: 米霍克 OA 前端(web_mihawk_oa)本地开发会话管理：启动前资源门禁、安全启动本地 webpack(127.0.0.1:8116)、把 whistle 网关规则切到预发布或项目环境（项目环境 IP 每次动态发现，不硬编码）、用真实域名打开本地页面。Use when 用户要求本地启动米霍克前端、npm run dev:index、检查 webpack 启动条件、把 rc_oa_gateway 切到预发布/项目环境、生成或写入 whistle 网关规则、验证本地页面访问链路。
metadata:
  version: 1.0.0
---

# start-local-frontend

## 定位

管理 `web_mihawk_oa`（米霍克 OA 前端，`/home/joney/projects/web/web_mihawk_oa`）的本地开发会话：
启动前门禁 -> 启动本地 webpack -> 把后端网关切到预发布(pre)或项目环境(prj) -> 用真实域名访问本地页面。
核心价值是**项目环境 IP 随时在变，每次执行时动态发现，不硬编码**。

不治理的部分：

- 不部署、不发布、不改任何远端机器和远端配置（部署走 `lexiao-deploy`）。
- 不管理乐效实例发现的细节（复用 `query-app-instances` 的脚本）。
- 不管理浏览器登录态（乐效登录态失效时先用 `get-browser-session` 刷新）。
- 不管理用户在 whistle 里手工维护的分组（见下方“whistle 分组模型”）。
- **纯看已部署整站**（不需要本地前端改动）时，hosts 直接指项目环境 IP 就够了，不需要本 skill。

知识来源：`/home/joney/projects/web/web_mihawk_oa/AGENTS.md`（本地开发环境搭建一节，已实测跑通）。

## 快速使用

脚本：`/home/joney/projects/ai/agent-tools/skills/lexin/start-local-frontend/scripts/frontend_env.js`（Node，无第三方依赖）。

```bash
SCRIPT=/home/joney/projects/ai/agent-tools/skills/lexin/start-local-frontend/scripts/frontend_env.js

node $SCRIPT doctor                 # 1. 启动前置门禁（只读）
node $SCRIPT start                  # 2. 门禁全绿后启动 npm run dev:index（长驻进程，建议后台运行）
node $SCRIPT connect --env pre      # 3a. 网关指向预发布：默认只打印规则文本
node $SCRIPT connect --env prj      # 3b. 网关指向项目环境：动态发现 IP + 探活后打印规则文本
node $SCRIPT connect --env prj --apply   # 3c. 尝试调 whistle API 自动写入专属分组
node $SCRIPT open                   # 4. 打印访问地址，并探测本地实例与网关当前指向
```

## 子命令说明

### doctor（启动前置门禁，全部来自 web_mihawk_oa/AGENTS.md 的实测结论）

- Node 必须 16.16.0：检查 `$HOME/.nvm/versions/node/v16.16.0/bin`（node-sass@7 在 Node 18+ 必定编译失败）。
- 内存硬门禁：冷启动前 `MemAvailable >= 6 GiB` 且 `SwapFree >= 0.5 GiB`（读 /proc/meminfo），
  不足时拒绝并给出实测数字。依据：webpack 常驻约 1.6 GiB，2026-08 曾在低内存下把 WSL 打挂。
  Swap 门禁 2026-09-07 由 2 GiB 降为 0.5 GiB：三次实测在 MemAvailable ≥ 7 GiB、SwapFree 0.8~1.7 GiB 下启动，
  swap 均未增长、内存压力为 0，风险主要由 MemAvailable 决定。
- `/proc/pressure/{memory,io}` 的 full avg10 > 5% 时警告，不与 Maven/生产构建并行。
- 8116 端口检查：已监听时输出占用 PID、`/proc/<pid>/cwd`，判断是否本项目实例；
  **绝不自动杀进程，绝不漂移到其他端口**；非本项目占用或本项目实例无响应都判 FAIL，交人工处理。
- 检查 `http_proxy`/`https_proxy` 并提醒：WSL 内 curl 调试需 `--noproxy '*'`；npm install 需整体绕开代理。

任一 FAIL 时 exit 1。

### start

- 前置：doctor 全绿；有 FAIL 直接拒绝启动。
- 8116 已有本项目健康实例（cwd 属于本项目且 HTTPS 有响应）时**复用不重启**。
- 冷启动命令（与 AGENTS.md 完全一致，用精确 Node 版本覆盖整个进程树）：
  `env PATH="$HOME/.nvm/versions/node/v16.16.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" npm run dev:index`，
  工作目录 `/home/joney/projects/web/web_mihawk_oa`。
- 长驻进程：由 agent 执行时放后台运行。端口开始监听不代表编译完成，等 webpack 明确输出编译完成再访问。

### connect --env pre|prj [--app <name>] [--ip <ip>] [--apply]

- whistle API 地址动态发现：`ip route show default` 取 Windows 宿主机 IP + 端口 8899
  （`/cgi-bin/rules/list` 已实测无鉴权可读）。宿主机 IP 会变，不硬编码；可 `--whistle h[:p]` 覆盖。
- `pre`：网关规则指向预发布。预发布 IP 是脚本里带注释的默认常量 `DEFAULT_PRE_GATEWAY_IP`
  （当前值，变更频率低；已变化用 `--ip` 覆盖）。会顺带探活，失败只警告不阻断
  （WSL 直连与浏览器经 whistle 的网络路径不同）。
- `prj`：**动态发现** —— 复用 `query-app-instances` 脚本查乐效实例
  （应用名默认 `server_hawk_decision_manage`，环境 prj），拿到候选 IP 后逐个探活：
  TCP 443 可达 + 带 `Host: mihawk.oa.fenqile.com` 的 HTTPS 请求
  `/rc_oa_gateway/hawk_decision/alarm/rule/detail.json?alarm_rule_id=1`
  返回含 `rc_gateway_ip` 或 `retcode` 的 JSON 才算通过；全部失败则拒绝生成规则。
- 规则只有一行 `<ip> mihawk.oa.fenqile.com/rc_oa_gateway`（加注释头），写入专属分组 `mihawk-gateway`。
- 默认**只打印**规则文本和手工启用步骤；带 `--apply` 才调 whistle 写入 API
  （`/cgi-bin/rules/add` + `/cgi-bin/rules/select`，**这两个写入端点未实测**），
  写入后回读 `/cgi-bin/rules/list` 校验；任何一步失败自动降级为打印文本让用户手工粘贴，不报错退出。

### open

- 打印访问地址 `https://mihawk.oa.fenqile.com/index.html#/index`，说明必须走 whistle 用真实域名访问
  （登录 cookie 绑在 `oa.fenqile.com` 域，`127.0.0.1` 直连拿不到登录态）。
- 探测：本地 8116 HTTPS 是否应答；读 whistle `mihawk-gateway` 分组内容，报告网关当前指向哪个 IP、
  对应哪个环境、分组是否启用。探测失败只提示不阻断。
- 最终验证手段：`ss -tan state all | grep 8116` 出现 ESTAB（HMR WebSocket）才说明浏览器真的连上了本地。

## whistle 分组模型（与公共规则的关系）

本 skill 只管理专属分组 `mihawk-gateway`（整组覆盖），里面只有一条网关规则。
以下规则属于用户既有的**公共分组**（含手工维护的「项目」分组），skill **绝不读改**：

- 页面本体 `127.0.0.1:8116 mihawk.oa.fenqile.com`
- `vui.oa.fenqile.com`、`mihawk.oa.fenqile.com/assets/`、`captcha.fenqile.com`、
  `passport-odin.fenqile.com` 等恒指预发布静态机的规则

注意：若公共分组里也保留了一条 `mihawk.oa.fenqile.com/rc_oa_gateway` 规则，两条同 path 规则只有
一条会生效（以 whistle 匹配顺序为准）。建议一次性手工把公共组里那条注释掉，让 `mihawk-gateway`
独占这条路径；这个调整由用户手工完成，skill 不代改公共组。

## 待实测项（首次使用时人工确认）

1. **whistle 写入 API**（`/cgi-bin/rules/add`、`/cgi-bin/rules/select`）未实测，只有
   `/cgi-bin/rules/list` 实测可读。`--apply` 失败会自动降级为手工粘贴，属预期行为。
2. **登录态跨环境网关**：用预发布域名登录态访问项目环境网关这一跳截至创建时未实测；
   首次 `connect --env prj` 后要人工确认页面接口不跳登录、不报权限错。若不通，需在项目环境
   重新走一次登录，或回退 `connect --env pre`。
3. 乐效 `prj` 环境的 env 取值按 `query-app-instances` 的透传逻辑处理；若乐效侧项目环境
   命名不同，脚本会在报错里列出该应用实际可用的环境名。

## 安全边界

- 只做本地开发环境编排：不部署、不发布、不改远端机器或远端配置。
- 绝不自动杀进程、绝不让 webpack 漂移到 8116 以外的端口；停止旧实例永远由人工核对后执行。
- whistle 侧只写 `mihawk-gateway` 一个分组，且默认 dry-run（不带 `--apply` 不发任何写请求）。
- 脚本不写死任何项目环境 IP；预发布 IP 仅作为带注释的默认常量存在，可被 `--ip` 覆盖。
- 不把 Cookie、token 写入文件或输出；乐效查询复用 `query-app-instances` 的登录态机制。
