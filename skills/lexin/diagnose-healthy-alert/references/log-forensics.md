# 日志取证操作细节

配套 `SKILL.md` 的 L5 一节，收纳容易踩但不影响主流程可读性的操作细节。

## 1. 日志文件与轮转

目录：`/home/product/logs/<app-name>_logs/`

| 文件 | 轮转粒度 | 查历史时 |
|---|---|---|
| `error.log` | 按天（`error_YYYYMMDD.0.log`） | 只收 ERROR |
| `warn.log` | 按天（`warn_YYYYMMDD.0.log`） | 收 WARN 及以上，当天的仍在 `warn.log` |
| `info.log` | **按小时**（`info_YYYYMMDDHH.0.log`） | 超过当前小时必须 `--include-rotated` |

埋点计数旁边的日志多是 `log.warn`，落在 `warn.log`；而打印存储 key、命中状态的
链路日志多是 `log.info`，落在按小时轮转的 `info.log`。两者要在同一次取证里一起取。

## 2. 时区

告警接口的 `trigger_time`、`recover_time` 是 UTC 秒；应用服务器日志是 **UTC+8**。
`diagnose_alert.js` 的 L5 输出已自动换算并写进 `--from/--to`，手工拼命令时别忘了 +8。

## 3. 日志行结构

```
2026-08-31 10:57:48.852|243|<traceId>||WARN|<类全名>|<方法>|<行号>|UID=,SESSIONID=,ENV=,SET=|<正文>|<调用方 ip:app>
```

- **traceId** 在第 3 段，可直接用于跨应用串联。
- **行号**能直接对上代码，比类名更精确地定位埋点点位。
- **行尾是调用方** `ip:app`（如 `10.17.28.71:server-hawk-decision-dispatcher-simulate`）。
  告警事件本身不含调用方信息，判断"谁发起的、是否同一个上游"只能从这里取。

## 4. 容器与 VM 的访问路径

| tags `origins` | 路径 |
|---|---|
| `k8s` | `container_log_check.js --ip=<pod_ip>`，走 WebShell |
| `kvm` / 空 | `java_app_diag` MCP，或 `bastion` MCP 兜底 |

容器场景的三个已验证事实：

- 堡垒机 `go <pod_ip>` 跳不进去，返回的是命令回显串而不是执行结果，不是权限报错。
- Pod 宿主机（乐效实例列表的 `host` 列）通常也没有登录权限，需在乐信云单独申请。
- WebShell 登录态在 `/home/joney/.local/state/agent-tools/browser-profiles/main`，**必须显式传 `--profile`**。
  不传会报 `LOGIN_REQUIRED`，看起来像登录过期，实际只是选错 profile。
  按 `java-server-diagnostics` 的三步流程排查，不要直接拉起 headed 浏览器重登。

VM 可以正常走堡垒机，但同一个应用的 VM 与 Pod 承接的流量可能完全不同：
本次告警在两个 Pod 上反复出现，而同应用的 prod VM 整月都没有这条日志。
**不要拿 VM 的日志代替 Pod 的日志下结论。**

## 5. 一次取证的成本

`container_log_check.js` 单次约 60~90 秒（起浏览器 + WebShell + gotty 建连）。
反复试关键词、试文件、试时间窗是这一层最大的时间浪费来源。
第一次就把 `--files`、`--include-rotated`、`--context` 带足，比分三次查更快。
