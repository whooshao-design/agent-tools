---
name: start-local-frontend
description: 米霍克 OA 前端(web_mihawk_oa)本地开发会话管理：启动前资源门禁、安全启动本地 webpack(127.0.0.1:8116)、把当前 whistle 联调分组里的米霍克网关行切到预发布或项目环境（项目环境网关 IP 由用户指定并探活，不硬编码）、用真实域名打开本地页面，并给出“后端部署项目环境 + 前端本地启动”的联调串联步骤。Use when 用户要求本地启动米霍克前端、npm run dev:index、检查 webpack 启动条件、把 rc_oa_gateway 切到预发布/项目环境、修改 whistle 网关规则、验证本地页面访问链路，或要做前后端项目环境联调。
metadata:
  version: 1.3.1
---

# start-local-frontend

## 定位

管理 `web_mihawk_oa`（米霍克 OA 前端，`~/projects/frontend/web_mihawk_oa`）的本地开发会话：
启动前门禁 -> 启动本地 webpack -> 把后端网关切到预发布(pre)或项目环境(prj) -> 用真实域名访问本地页面。
项目环境网关机随每次部署新建、IP 会变，脚本不硬编码，由用户给出 IP 后探活。

不治理的部分：

- 不部署、不发布、不改任何远端机器和远端配置（部署走 `lexiao-deploy`）。
- 不管理乐效实例发现的细节（复用 `query-app-instances` 的脚本）。
- 不管理浏览器登录态（乐效登录态失效时先用 `get-browser-session` 刷新）。
- whistle 只改联调分组里的米霍克网关行，不增删其他规则（见下方“whistle 分组模型”）。
- **纯看已部署整站**（不需要本地前端改动）时，hosts 直接指项目环境 IP 就够了，不需要本 skill。

知识来源：`~/projects/frontend/web_mihawk_oa/AGENTS.md`（本地开发环境搭建一节，已实测跑通）。

## 快速使用

脚本：`scripts/frontend_env.js`（Node，无第三方依赖）。

```bash
SCRIPT=scripts/frontend_env.js

node $SCRIPT doctor                 # 1. 启动前置门禁（只读）
node $SCRIPT start                  # 2. 门禁全绿后启动 npm run dev:index（长驻进程，建议后台运行）
node $SCRIPT connect --env pre      # 3a. 网关指向预发布：只预览要改的行
node $SCRIPT connect --env prj --ip <网关机IP>   # 3b. 网关指向项目环境：探活通过后预览要改的行
node $SCRIPT connect --env prj --ip <网关机IP> --apply   # 3c. 写入联调分组并回读校验
node $SCRIPT open                   # 4. 打印访问地址，检查页面规则与网关当前指向
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
  工作目录 `~/projects/frontend/web_mihawk_oa`。
- 长驻进程：由 agent 执行时放后台运行。端口开始监听不代表编译完成，等 webpack 明确输出编译完成再访问。

### connect --env pre|prj [--ip <ip>] [--group <分组名>] [--apply]

- whistle API 地址动态发现：`ip route show default` 取 Windows 宿主机 IP + 端口 8899（无鉴权）。
  宿主机 IP 会变，不硬编码；可 `--whistle h[:p]` 覆盖。
- `pre`：目标是脚本里带注释的默认常量 `DEFAULT_PRE_GATEWAY_IP`（当前值，变更频率低；已变化用 `--ip` 覆盖）。
  会顺带探活，失败只警告不阻断（WSL 直连与浏览器经 whistle 的网络路径不同）。
- `prj`：`/rc_oa_gateway` 由项目环境的独立网关机（`server_rc_oa_gateway_java` VM，部署项目环境时新建）承接，
  不是业务应用的 IP——manage 等业务应用在项目环境是 Pod，探活必然失败（2026-10-20 实测）。
  乐效项目环境页显示的环境 IP 就是这台网关机（2026-11 实测 10.9.110.229）。
  prj 网关同时运行上百台、不按需求打标，自动挑选会静默连到别人的环境，因此 **`--ip` 必填**；
  未传时只列出最近创建的运行中网关实例作参考并以退出码 2 结束。
  探活：TCP 443 可达 + 带 `Host: mihawk.oa.fenqile.com` 的 HTTPS 请求
  `/rc_oa_gateway/hawk_decision/alarm/rule/detail.json?alarm_rule_id=1`
  返回含 `rc_gateway_ip` 或 `retcode` 的 JSON 才算通过（未登录的 `16051006` 也算可达）；失败则拒绝修改。
- 要改的分组：`--group` 指定；未指定时取**唯一一个**含米霍克网关行的已启用分组，0 个或多个时拒绝并要求 `--group`。
- 只替换该分组里这 4 个目标所在行的 IP（`GATEWAY_TARGETS`）：`mihawk.oa.fenqile.com/rc_oa_gateway`、
  `gateway.oa.fenqile.com/rc_oa_gateway`、`hawkeye.oa.fenqile.com/rc_oa_gateway`、`mihawk.oa.fenqile.com/groovy-lint`。
  注释行、其他行（如有意指向预发布的 `cs.fenqile.com/rc_oa_gateway`）原样保留；分组里缺的目标只报告，不新增。
- 默认只打印 `-`/`+` 行差异；带 `--apply` 才调 `/cgi-bin/rules/select` 保存并启用该分组
  （2026-11-02 实测可用），再回读 `/cgi-bin/rules/list` 核对内容一致。回退：用 `--ip <原 IP>` 再执行一次。

### open

- 打印访问地址 `https://mihawk.oa.fenqile.com/index.html#/index`，说明必须走 whistle 用真实域名访问
  （登录 cookie 绑在 `oa.fenqile.com` 域，`127.0.0.1` 直连拿不到登录态）。
- 探测：本地 8116 HTTPS 是否应答；列出已启用分组，检查其中有没有页面规则 `127.0.0.1:8116 mihawk.oa.fenqile.com`，
  列出米霍克网关行并在指向多个 IP 时告警。探测失败只提示不阻断。
- 最终验证手段：`ss -tan state all | grep 8116` 出现 ESTAB（HMR WebSocket）才说明浏览器真的连上了本地。

## whistle 分组模型

用户的 whistle 是单选模式，每个联调场景一个完整分组（如「本地-项目」「本地-预发布」），
里面同时有页面规则、静态资源规则和网关行；启用一个分组会关掉其他分组。

因此脚本改用户当前启用的分组，不再另建分组：1.2.x 写入的独立分组 `mihawk-gateway` 只有一条网关行、
没有页面和静态资源规则，单选模式下启用它会关掉联调分组，页面也不再来自本地（2026-11-02 实测）。
旧版留下的 `mihawk-gateway` 分组可以在 whistle 界面手工删除，脚本不再读写它。

## 项目环境前后端联调

后端改动部署到项目环境、前端在本地起，按下面顺序串联；每一步由对应 skill 负责，本 skill 只负责第 3～5 步。

1. 部署后端：`lexiao-deploy` 把后端应用部署到需求的项目环境，记下乐效项目环境页的环境 IP（网关机 IP）。
2. 网关路由：新增了页面要调的网关 URL 时，用 `manage-oa-gateway-rule --env prj` 在项目环境网关加规则并探活；
   上线前线上也要加（`--env prod`）。没有新 URL 跳过。
3. 起前端：`doctor` 全绿后 `start`，等 webpack 输出编译完成。
4. 切网关：`connect --env prj --ip <环境IP>` 预览，确认后加 `--apply`。
5. 自检：`open` 无告警；浏览器打开访问地址后 `ss -tan state all | grep 8116` 出现 ESTAB。
6. 验收：agent 用扁鹊 Dubbo + SQL 验证后端（见 `dev-verify-change`），页面交互交用户在浏览器验收（见下方登录态限制）。

登录态限制：用户浏览器经 whistle（passport-odin 走预发布）登录后，项目环境网关可正常鉴权（2026-10-20 实测）。
WSL 自动化浏览器 profile 的 `oa_session` 来自线上 passport，项目环境网关返回 `16051006` 未登录，
所以 agent 不能用 profile 直接调项目环境网关接口。不要把 profile Cookie 发往预发布网关 IP 绕过（会被权限策略按数据外发拦截）。

## 页面视觉自检（不需要登录）

`references/ui-check/mihawk.base.json` 是 `verify-browser-qa` 的 `ui_check.js` 用的米霍克基础场景，让 agent 不登录也能在本地渲染页面并测量：

- `rewrite`：`https://mihawk.oa.fenqile.com/` 下除 `assets/`、`rc_oa_gateway/` 以外的请求，改从本地 `https://127.0.0.1:8116/` 取，所以要先 `start` 并等 webpack 编译完成。
- `passthrough`：`vui.oa.fenqile.com` 和 `mihawk.oa.fenqile.com/assets/` 的公共静态资源直连真实地址取。
- `mocks`：`auth/query_auth_user_name.json` 返回 `super_admin: true`（页面按超管权限渲染，菜单和按钮全部可见）；`profile/desc.json` 返回 `prod`。其余 `/rc_oa_gateway/` 请求由 `defaultMock` 返回空列表。
- 伪造 Cookie `rog_session`（值为 `ui-check`）和 `sessionStorage.user_info`，让前端的登录检查放行。它们只存在于本次无头浏览器；`/rc_oa_gateway/` 请求全部由 mock 应答，不发往任何网关，只有 `mihawk.oa.fenqile.com/assets/` 的静态资源请求会带着这个假 Cookie 发到真实地址。

示例 `references/ui-check/package-copy-confirm.json` 打开乐包列表，通过 Vue 实例调用 `appEditor` 的 `show(..., 'copy')` 和 `confirmRealTimeQueryCopy(...)` 弹出“乐包复制提醒”，测量 `.copy-confirm-modal`（2026-10-23 实测：通过；注入原先泄漏的 `.modal-body { padding: 4px 0 0 0 !important }` 后两个按钮报 `cramped` 0px）。新页面照它写场景：给页面依赖的接口补 `mocks`，用 `steps` 点开或调用组件方法打开要检查的界面。

```bash
node $AGENT_TOOLS_ROOT/skills/dev-quality/verify-browser-qa/scripts/ui_check.js \
  --scenario=references/ui-check/package-copy-confirm.json
```

模拟数据只证明布局和样式；接口真实返回、权限和后端行为仍按原来的方式交用户在环境里验收。

## 安全边界

- 只做本地开发环境编排：不部署、不发布、不改远端机器或远端配置。
- 绝不自动杀进程、绝不让 webpack 漂移到 8116 以外的端口；停止旧实例永远由人工核对后执行。
- whistle 侧只替换一个分组里米霍克网关行的 IP，且默认 dry-run（不带 `--apply` 不发任何写请求）。
- 脚本不写死任何项目环境 IP；预发布 IP 仅作为带注释的默认常量存在，可被 `--ip` 覆盖。
- 不把 Cookie、token 写入文件或输出；乐效查询复用 `query-app-instances` 的登录态机制。
