---
name: query-app-logs
description: 统一只读查询 Java 应用日志：VM/KVM 服务器日志走 java_app_diag MCP，容器 Pod 日志走 container_log_check/webshell_log_check 脚本，超出服务器保存期或需要跨机器按 traceId 汇总时走日志平台 log.oa.fenqile.com（热数据 90 天）。Use when 用户要求查某应用的日志、按 traceId/关键字/时间段找日志、看几天到几个月前的历史日志、服务器日志已轮转找不到、或明确说用日志平台；应用名必须明确。
metadata:
  version: 1.0.0
---

# query-app-logs

## 定位

查 Java 应用日志的统一入口，三条只读路径按场景路由：

- A. VM/KVM 服务器日志：`java_app_diag` MCP。
- B. 容器 Pod 日志：`java-server-diagnostics/scripts/` 下的 `container_log_check.js`、`webshell_log_check.js`（脚本路径不变，本 skill 只负责调用）。
- C. 日志平台 `https://log.oa.fenqile.com/#/dashboard`：本 skill 的 `scripts/log_platform_query.js`。

它不做进程、端口、JVM、GC 诊断（那是 `java-server-diagnostics`，它的日志章节也指向本 skill），不做任何写操作，不重启服务。
应用名必填；机器/Pod 由 `query-app-instances` 给出；`diagnose-healthy-alert` 等上游 skill 产出的 traceId、关键字直接作为本 skill 输入。
最终回复不贴大段原始日志，不输出 Cookie、token、密码或完整敏感配置。

## 路由规则

| 场景 | 路径 |
|---|---|
| 最近的日志（仍在服务器保存期内）且已知 IP 或 Pod | A / B，服务器文件是权威来源：完整多行堆栈、实时、含 `stdout.log` 启动日志 |
| 时间超出服务器保存期；`error.log`/轮转文件（含 `.gz`）已不存在 | C |
| 不知道具体机器，或要跨机器、跨环境按 traceId / 关键字汇总 | C，再按平台返回的 `ip` 决定是否回到 A/B 取完整上下文 |
| 用户明确要求日志平台 | C |
| 启动日志、需要 `stdout.log`、平台无数据但机器可达 | A / B（平台是按行入库的聚合视图，`etlTime` 有入库延迟，平台无数据不等于服务器无日志） |

- 两边都可用时先 A/B，历史部分用 C 补；结论里注明来源。
- 平台热数据保留 90 天（`hotDueDay`）；更早的走冷备，2026-09-16 实测冷备后端报历史表不存在，只能如实告知，不要反复重试。
- 用户只说"看下服务日志"而没有应用名时，按 `java-server-diagnostics` 的"缺少服务名或机器时"顺序从上下文推断；推断不出就问一句最小问题，不要猜。

## 路径 A：VM/KVM 服务器日志

1. 快检直接调用 `check_app_error_log(ip, app_name?, env?)`，它会自动复用/建立堡垒机连接；PEM 可用时不要先单独连接。只有 `error.log` 暴露线索或用户继续要求时才递进。
2. 递进：`list_log_files` 确认真实文件名 → `grep_app_log` / `tail_app_log`（共享日志 `/home/product/logs/<app_name>_logs/`：`error.log`、`warn.log`、`info.log`、`debug.log`、`stdout.log` 及轮转文件，支持 `.gz`）；启动问题看版本目录 `/home/publish_product/server_java/<app_name>/<version_tag>/logs/` 的 `grep_version_log` / `tail_version_log`。
3. 环境映射：`pre`/预发布/灰度/`prod`/线上 → `profile=online`（默认，环境不明时按线上处理）；项目环境/`stable`/`test`/`prj` → `profile=dev`。优先传 `env`，只有需要强制路径时才传 `profile`。
4. "未连接堡垒机"表示当前 MCP 进程尚未建立连接，不是服务器故障；按环境连接一次，认证失败再处理认证，不跨环境重试，不在聊天索取密码/OTP 之外的凭据。
5. 文件已轮转、`.gz` 也不在、或用户要的时间早于服务器保存期 → 转路径 C。

## 路径 B：容器 Pod 日志

1. 先用 `query-app-instances` 获取 `namespace`、`pod_name`、`container`、`cluster_id/context`、`login_pod_addr`；WebShell URL 使用乐效原值。
2. 优先只读 kubectl context；只有 context/kubeconfig/连接不可用等基础设施错误才回退 WebShell，权限拒绝、Pod 不存在等业务错误不要静默回退。
3. `app + env` 命中多个 Running Pod 时必须补 `--pod` 或 `--ip`，不随机选。

快检（默认 `--log-mode=quick`，只看 `error.log`；启动问题加 `--include-startup`）：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/java-server-diagnostics/scripts/container_log_check.js \
  --app=<app_name> --env=pre --ip=<pod_ip> --lines=120
```

取证（当前日志 + 未压缩/`.gz` 轮转，按时间戳聚合多行事件；`trace-id/rule-id/keyword` 同时给出时 AND 匹配；`--context` 0～20）：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/java-server-diagnostics/scripts/container_log_check.js \
  --app=<app_name> --env=prod --ip=<pod_ip> --log-mode=forensics \
  --trace-id=<trace_id> --from="2026-07-13 11:39:00" --to="2026-07-13 11:42:00" \
  --files=error.log,info.log --context=2 --include-rotated --max-lines=500 --max-bytes=1048576
```

已有 `login_pod_addr` 时可直接用 WebShell helper（`--mode=auto` 先 Gotty WebSocket，终端 DOM 可用才回退）：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/java-server-diagnostics/scripts/webshell_log_check.js \
  --url=<login_pod_addr> --app=<app_name> --lines=120 --since-minutes=60 --version=<version_tag>
```

先读输出的 `targetSource/loginUrlSource/access/accessAttempts/errorCode/warningCode`，再看 `summary` 或 `forensics`；`warningCode=RESULT_TRUNCATED` 时缩小时间窗或提高受控上限重查；自动登录失败时把返回的乐效 `manualUrl` 交给用户在浏览器打开。日志文件只允许 `error.log/info.log/warn.log/debug.log/stdout.log`。

## 路径 C：日志平台

前置：脚本在 `get-browser-session` 的 `main` profile 内发请求，需要该 profile 已登录 OA。报 `browser session is not ready ... (LOGIN_REQUIRED|PROXY_INTERCEPTED|FORBIDDEN|UPSTREAM_ERROR)` 时先按 `get-browser-session` 的"登录态排查顺序"确认，确需重登再执行（MCP 优先 `browser_session.ensure_session`，脚本兜底）：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --ensure --url='https://log.oa.fenqile.com/#/dashboard' --success-text=none
```

常用命令（时间按北京时间写，默认最近 1 小时）：

```bash
# 按 traceId 跨机器拉全链路
node /home/joney/projects/ai/agent-tools/skills/lexin/query-app-logs/scripts/log_platform_query.js \
  --app server_hawk_decision_manage --trace-id 0A111D7C17786017331191014000ED --last 24h --order asc

# 某时间段的 ERROR
node /home/joney/projects/ai/agent-tools/skills/lexin/query-app-logs/scripts/log_platform_query.js \
  --app server_hawk_decision_manage --type error --env prod \
  --from "2026-09-10 09:00:00" --to "2026-09-10 12:00:00"

# 关键字（多个 --keyword，默认"与"）并落地完整结果
node /home/joney/projects/ai/agent-tools/skills/lexin/query-app-logs/scripts/log_platform_query.js \
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
- `--user-name`/`LOG_PLATFORM_USER_NAME`：覆盖 OA 账号（正常不需要）；`--profile` 等浏览器覆盖项同 `get-browser-session`。

输出 JSON：`rows[]` 每条含 `time`（北京时间）、`env`、`ip`、`level`（从 body 解析，可能为 null）、`tid`、`cls`、`mth`、`uid`、`body`、`bodyTruncated`；
`totalNum`/`totalPage` 是平台总匹配数（去重前）；每页实际条数可能少于 `--page-size`，因为平台按页去重相同日志行；`warnings` 提示截断或超出热数据期；`cost` 是平台耗时；`--output` 时 `resultFile` 指向完整文件。

使用要点：

- 宽泛条件（ALL + 1 小时）动辄数万条，先加 traceId、`--type error` 或关键字收窄；默认只取一页，不要为了"拉全"无限提高 `--max-pages`。
- 平台的 `type` 字段把 INFO/WARN 都记为 0，级别以 `level` 为准；`ip` 是产生日志的机器，可据此回到路径 A/B 取完整上下文。
- `retcode` 非 0 时脚本直接报错并带 `detail` 首行；不要改条件碰运气，先判断是冷备（起始时间早于 90 天）还是条件问题。
- 接口字段与编码见 `/home/joney/projects/ai/agent-tools/skills/lexin/query-app-logs/references/log-platform-http.md`。

## 输出格式

1. `查询范围`：应用、环境、时间窗、过滤条件、来源（服务器 / 容器 / 日志平台）。
2. `结论`：关键异常或事件摘要——类型、traceId、机器、首末时间、次数、是否仍在持续。
3. `证据`：少量关键日志行（截断）、条数、是否截断、平台总数。
4. `下一步`：没查到时说明已查范围和最小建议（换来源、扩时间窗、补 traceId）。
