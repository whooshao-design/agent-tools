---
name: query-app-logs
description: 统一只读查询 Java 应用日志：按应用、时间、关键字、traceId、IP 的检索默认走架构日志服务（OA 网关加 lxctl token，不可用时回退日志平台浏览器登录态），需要服务器上的原始文件（stable/项目环境、启动与 GC 日志、任意路径文件）时 VM/KVM 走 java_app_diag MCP、容器 Pod 走 container_log_check/webshell_log_check 脚本。Use when 用户要求查某应用的日志、按 traceId/关键字/时间段找日志、看几天到几个月前的历史日志、服务器日志已轮转找不到、或明确说用日志平台或 lxctl 查日志；应用名必须明确。
metadata:
  version: 1.2.0
---

# query-app-logs

## 定位

查 Java 应用日志的统一入口，三条只读路径按场景路由：

- A. VM/KVM 服务器日志：`java_app_diag` MCP，经堡垒机读服务器上的文件。
- B. 容器 Pod 日志：`java-server-diagnostics/scripts/` 下的 `container_log_check.js`、`webshell_log_check.js`（脚本路径不变，本 skill 只负责调用）。
- C. 架构日志服务（日志平台 `https://log.oa.fenqile.com/#/dashboard` 背后的检索接口）：本 skill 的 `scripts/log_platform_query.js`。它有两种传输，查的是同一个后端、参数和输出相同：`gateway`（OA 网关 + `lxctl` 的 OAuth token，见 `lxctl-gateway`）和 `browser`（日志平台页面的浏览器登录态）。默认 `--via auto`：本机有 `lxctl` token 就走 `gateway`，网关通道不可用时回退 `browser`。

C 是默认首选：不需要知道机器，不需要堡垒机密码和 MOA 安全码，单次查询实测 0.7～3 秒。A/B 读的是服务器上的原始文件，在 C 覆盖不到时使用。

它不做进程、端口、JVM、GC 诊断（那是 `java-server-diagnostics`，它的日志章节也指向本 skill），不做任何写操作，不重启服务。
应用名必填；机器/Pod 由 `query-app-instances` 给出；`diagnose-healthy-alert` 等上游 skill 产出的 traceId、关键字直接作为本 skill 输入。
最终回复不贴大段原始日志，不输出 Cookie、token、密码或完整敏感配置。

## 路由规则

| 场景 | 路径 |
|---|---|
| `prod`/`pre`/`gray` 环境，按时间段、级别、关键字、traceId、IP、类名、方法查应用日志（INFO/ERROR/NGINX/DUBBO） | C |
| 不知道具体机器，或要跨机器按 traceId / 关键字汇总 | C，结果里的 `ip` 指出产生日志的机器 |
| 历史日志：服务器上的文件已轮转或删除 | C（2026-11-11 实测 120 天、180 天前的 1 小时窗口都返回了数据） |
| `stable`/测试/项目环境 | A / B。C 对 `env=stable`、`env=test` 实测返回 0 行，这些环境的日志没有入库 |
| 没有被采集的文件：`stdout.log` 启动日志、GC 日志、`deploy.log`、任意路径的文件 | A / B |
| C 返回 0 行但事件刚发生或机器可达 | A / B 复核。入库有延迟（`etlTime`），C 无数据不等于服务器无日志 |
| 需要某条日志前后相邻的原始行（C 按条件检索，不提供“上下 N 行”） | 先用 C 定位 `ip` 和时间，再到 A / B 取上下文 |
| 用户明确指定通道（“登机器看”“用日志平台”“用 lxctl”） | 按用户指定；“用 lxctl”即 C 加 `--via gateway` |

- 结论里注明来源（C 的 `transport`，或 A/B 的机器与文件）。同一问题先 C 后 A/B 时，两边的条数口径不同，不要相加。
- C 的环境取值是 `prod`/`pre`/`gray`/`oa`；实测 `server_credit_api` 最近 1 小时 `prod` 约 63 万行、`pre` 221 行、`gray` 与 `oa` 0 行。0 行只说明该应用在该环境该时段没有入库日志。
- 走 A 要先登录堡垒机：线上与 stable 堡垒机都会追问密码和 6 位 MOA 安全码，首次进入一台机器实测 8～13 秒，同机后续命令约 2 秒。这是 C 作为首选的原因之一。
- 用户只说"看下服务日志"而没有应用名时，按 `java-server-diagnostics` 的"缺少服务名或机器时"顺序从上下文推断；推断不出就问一句最小问题，不要猜。

## 路径 A：VM/KVM 服务器日志

1. 快检直接调用 `check_app_error_log(ip, app_name?, env?)`，它会自动复用/建立堡垒机连接；PEM 可用时不要先单独连接。只有 `error.log` 暴露线索或用户继续要求时才递进。
2. 递进：`list_log_files` 确认真实文件名 → `grep_app_log` / `tail_app_log`（共享日志 `/home/product/logs/<app_name>_logs/`：`error.log`、`warn.log`、`info.log`、`debug.log`、`stdout.log` 及轮转文件，支持 `.gz`）；启动问题看版本目录 `/home/publish_product/server_java/<app_name>/<version_tag>/logs/` 的 `grep_version_log` / `tail_version_log`。
3. 环境映射：`pre`/预发布/灰度/`prod`/线上 → `profile=online`（默认，环境不明时按线上处理）；项目环境/`stable`/`test`/`prj` → `profile=dev`。优先传 `env`，只有需要强制路径时才传 `profile`。
4. "未连接堡垒机"表示当前 MCP 进程尚未建立连接，不是服务器故障；按环境连接一次，不跨环境重试。返回“要求输入安全码”时弹出输入框向用户要一次当前 6 位 MOA 码，带 `otp` 重连；返回“要求输入密码”时请用户在 bastion 的 `config.json` 填 `password`；命令结果是“命令没有在目标机执行”时按 MCP 故障报告，不重复向用户要码。
5. 文件已轮转、`.gz` 也不在、或用户要的时间早于服务器保存期 → 转路径 C。

## 路径 B：容器 Pod 日志

1. 先用 `query-app-instances` 获取 `namespace`、`pod_name`、`container`、`cluster_id/context`、`login_pod_addr`；WebShell URL 使用乐效原值。
2. 优先只读 kubectl context；只有 context/kubeconfig/连接不可用等基础设施错误才回退 WebShell，权限拒绝、Pod 不存在等业务错误不要静默回退。
3. `app + env` 命中多个 Running Pod 时必须补 `--pod` 或 `--ip`，不随机选。

快检（默认 `--log-mode=quick`；kubectl 路径读的是容器 stdout，结果 `source=kubectl-stdout` 且 `limitations` 注明没读 `error.log` 文件，只有 WebShell 回退路径读 `error.log`；启动问题加 `--include-startup`）：

```bash
node $AGENT_TOOLS_ROOT/skills/lexin/java-server-diagnostics/scripts/container_log_check.js \
  --app=<app_name> --env=pre --ip=<pod_ip> --lines=120 \
  --profile=~/.local/state/agent-tools/browser-profiles/main
```

取证（当前日志 + 未压缩/`.gz` 轮转，按时间戳聚合多行事件；`trace-id/rule-id/keyword` 同时给出时 AND 匹配；`--context` 0～20）：

```bash
node $AGENT_TOOLS_ROOT/skills/lexin/java-server-diagnostics/scripts/container_log_check.js \
  --app=<app_name> --env=prod --ip=<pod_ip> --log-mode=forensics \
  --trace-id=<trace_id> --from="2026-07-13 11:39:00" --to="2026-07-13 11:42:00" \
  --files=error.log,info.log --context=2 --include-rotated --max-lines=500 --max-bytes=1048576 \
  --profile=~/.local/state/agent-tools/browser-profiles/main
```

已有 `login_pod_addr` 时可直接用 WebShell helper（`--mode=auto` 先 Gotty WebSocket，终端 DOM 可用才回退）。WebShell 登录态在 `browser-profiles/main`，脚本默认 `webshell` profile，所以 `--profile` 必须显式传，否则会报看似登录过期的 `LOGIN_REQUIRED`：

```bash
node $AGENT_TOOLS_ROOT/skills/lexin/java-server-diagnostics/scripts/webshell_log_check.js \
  --url=<login_pod_addr> --app=<app_name> --lines=120 --since-minutes=60 --version=<version_tag> \
  --profile=~/.local/state/agent-tools/browser-profiles/main
```

先读输出的 `targetSource/loginUrlSource/access/accessAttempts/errorCode/warningCode`，再看 `summary` 或 `forensics`；`warningCode=RESULT_TRUNCATED` 时缩小时间窗或提高受控上限重查；自动登录失败时把返回的乐效 `manualUrl` 交给用户在浏览器打开。`--files` 可读任意文件：相对路径基于 `/home/product/logs/<app>_logs/`（如 `deploy.log`、`deploy/deploy_*.log`，支持通配符），也可传绝对路径，路径中不能有空白字符；路径 A 的 MCP `file_name` 同样不限文件。

## 路径 C：架构日志服务

传输与前置：

- `gateway`（有 `lxctl` token 时的默认）：需要本机装过 `lxctl` 并 `lxctl auth login`，状态用 `node $AGENT_TOOLS_ROOT/skills/lexin/lxctl-gateway/scripts/lxctl_gateway.js doctor` 看。token 过期由脚本自动续期；网络错误、超时、502 自动重试 2 次（实测偶发 `socket disconnected` 和 30 秒无响应，重试后成功）。
- `browser`（没有 token，或网关通道不可用时的回退）：脚本在 `get-browser-session` 的 `main` profile 内发请求，需要该 profile 已登录 OA。
- `--via auto` 只在网关通道本身不可用（未登录、token 续期失败、无权限、网络）时回退，并在 `warnings` 里写明原因；日志服务返回的查询错误（`retcode` 非 0）不换通道重试。输出的 `transport` 字段是实际使用的传输。
- 两种传输都不可用时，先按 `lxctl-gateway` 的“安装与登录”恢复 `gateway`（只需用户在浏览器点一次确认），它比恢复浏览器登录态更省事。

`browser` 传输报 `browser session is not ready ... (LOGIN_REQUIRED|PROXY_INTERCEPTED|FORBIDDEN|UPSTREAM_ERROR)` 时先按 `get-browser-session` 的"登录态排查顺序"确认，确需重登再执行（MCP 优先 `browser_session.ensure_session`，脚本兜底）：

```bash
node $AGENT_TOOLS_ROOT/skills/lexin/get-browser-session/scripts/browser_session.js \
  --ensure --url='https://log.oa.fenqile.com/#/dashboard' --success-text=none
```

常用命令（时间按北京时间写，默认最近 1 小时）：

```bash
# 按 traceId 跨机器拉全链路
node scripts/log_platform_query.js \
  --app server_hawk_decision_manage --trace-id 0A111D7C17786017331191014000ED --last 24h --order asc

# 某时间段的 ERROR
node scripts/log_platform_query.js \
  --app server_hawk_decision_manage --type error --env prod \
  --from "2026-09-10 09:00:00" --to "2026-09-10 12:00:00"

# 关键字（多个 --keyword，默认"与"）并落地完整结果
node scripts/log_platform_query.js \
  --app server_hawk_decision_manage --keyword "获锁失败" --keyword "metadata:sync" --keyword-mode and \
  --last 3d --max-pages 3 --output /tmp/hawk-lock.json
```

参数：

- `--app`：必填，准确应用名（平台没有应用名搜索接口，写错只会返回 0 条）。
- 时间：`--last 30m|2h|3d`，或 `--from/--to`（`YYYY-MM-DD HH:mm[:ss]`、ISO、毫秒时间戳；北京时间）。
- `--type all|info|error|nginx|dubbo`（默认 all）；`--env all|prod|gray|oa|pre`（默认 all）。
- `--trace-id`、`--ip`、`--service`（类名）、`--method`、`--uid`：精确过滤。
- `--keyword` 可重复；`--keyword-mode and|or`（默认 and）。
- `--order desc|asc`（默认 desc，时间倒序）。
- `--page`（默认 1）、`--page-size`（默认 100，最大 500）、`--max-pages`（默认 1，最大 50）。
- `--max-body`：stdout 每条 body 截断长度（默认 2000）；`--output <file>`：完整结果写 JSON。
- `--via auto|gateway|browser`（默认 auto）：见上“传输与前置”。
- `--user-name`/`LOG_PLATFORM_USER_NAME`：覆盖 OA 账号（正常不需要；`gateway` 从 token 取，`browser` 从 OA 会话取）；`--profile` 等浏览器覆盖项同 `get-browser-session`，只对 `browser` 传输有效。

输出 JSON：`rows[]` 每条含 `time`（北京时间）、`env`、`ip`、`level`（从 body 解析，可能为 null）、`tid`、`cls`、`mth`、`uid`、`body`、`bodyTruncated`；
`totalNum`/`totalPage` 是平台总匹配数（去重前）；每页实际条数可能少于 `--page-size`，因为平台按页去重相同日志行；`warnings` 提示截断、通道回退或（`browser` 传输下）起始时间早于热数据期；`cost` 是平台耗时；`transport` 是实际传输（`gateway`/`browser`），`hotDueDay` 只有 `browser` 传输能取到（`gateway` 下为 null）；`--output` 时 `resultFile` 指向完整文件。

使用要点：

- 宽泛条件（ALL + 1 小时）动辄数万条，先加 traceId、`--type error` 或关键字收窄；默认只取一页，不要为了"拉全"无限提高 `--max-pages`。
- 平台的 `type` 字段把 INFO/WARN 都记为 0，级别以 `level` 为准；`ip` 是产生日志的机器，可据此回到路径 A/B 取完整上下文。
- `retcode` 非 0 时脚本直接报错并带 `detail` 首行；不要改条件碰运气，先判断是历史表问题（起始时间早于 90 天的热数据期；2026-09-16 报过历史表不存在，2026-11-11 两种传输查 120 天前都正常）还是条件问题。
- 时间窗越宽越慢：实测 1 小时窗口 0.7～1.6 秒，偶发 5～13 秒；一次查几天时先用 `--type error`、traceId 或关键字收窄，仍超时就按天拆开查。
- 接口字段与编码见 `references/log-platform-http.md`。

## 输出格式

直接输出查询摘要和少量可定位的证据，不加载复杂故障报告指南，不默认生成报告文件。
作为排查主流程的取证步骤时返回以下信息，由主流程综合判断根因与业务影响。

1. `结论及范围`：关键异常或事件摘要；应用、环境、时间窗、过滤条件、来源（服务器 / 容器 / 日志平台）。没有查到时仅说明该范围内未发现匹配。
2. `关键证据`：异常类型、traceId、机器、观测到的首末时间、少量日志摘录；只有覆盖当前时段才判断是否仍在持续。
3. `数量口径与限制`：区分平台总匹配数（去重前）、本次返回行数、异常事件和唯一请求数；说明分页、截断和未覆盖范围，不把部分返回量写成全量业务影响。
4. `下一步`：给最小建议（换来源、扩时间窗、补 traceId）；根因未确认时说明缺哪项证据，不仅凭异常名下定论。
