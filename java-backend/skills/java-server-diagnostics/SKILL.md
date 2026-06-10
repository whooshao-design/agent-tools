---
name: java-server-diagnostics
description: "通过 java_app_diag MCP 对 Java 应用所在服务器做只读排查。适用于按 IP、应用名、端口、PID、version_tag、traceId 或关键字检查服务器基础状态、Java 进程、端口连接、JVM/线程、GC/OOM、健康检查和应用日志。"
version: 1.0.0
---

# java-server-diagnostics

## 适用场景

用户要求排查 Java 应用所在服务器、发布后启动状态、进程是否存在、端口是否监听、健康检查是否正常、JVM/线程/GC 状态、线上/预发/stable 日志、traceId/关键字相关异常时使用。

## 核心边界

- 首选 `java_app_diag` MCP；`server_log` 仅作为旧日志兼容入口。
- 所有服务器访问必须通过堡垒机/跳板机通道，不直连业务服务器。
- 只做只读诊断，不修改、不删除、不重启服务，不发送进程信号。
- 不开放任意远程 shell；只使用 MCP 已封装的固定诊断工具。
- 禁止执行或建议执行高风险诊断：
  - `jmap -dump`
  - `jmap -histo:live`
  - `kill -3`
  - 任意 `rm`、`mv`、`cp`、`chmod`、`chown`、`touch`、`tee`、重定向写入、服务重启
  - 读取完整环境变量、完整 JVM system properties、任意配置文件或密钥文件
- `local_health_get` 只用于目标机本机 `127.0.0.1` 的 GET，默认 `/actuator/health`；不要查询 `/actuator/env`、`/actuator/configprops`、`/actuator/heapdump` 等敏感端点。
- 最终回复不贴大段原始日志，不输出 Cookie、token、密码、完整敏感配置值。

## 默认路径

共享应用日志目录：

```text
/home/product/logs/<app_name>_logs/
```

版本本地日志目录：

```text
/home/publish_product/server_java/<app_name>/<version_tag>/logs/
```

常见日志文件：

- 共享日志：`error.log`、`debug.log`、`info.log`、`stdout.log` 及其轮转文件
- 版本日志：优先 `stdout.log`，再按需要查 `error.log`、`debug.log`、`info.log`

## 缺少服务名或机器时

用户只说“查看服务日志看看有没有问题”“看下服务有没有异常”时，不要直接猜测服务名或机器。

先按以下顺序从上下文推断：

1. 当前对话刚指定过的 `app_name`、`ip`、`version_tag`、端口或 traceId。
2. 乐效发布/部署上下文中明确选中的应用和机器。
3. 当前仓库或模块名能唯一映射到应用名，且已有唯一目标机器上下文。
4. 用户已提供 `ip` 但未提供 `app_name` 时，先用 `discover_java_apps(ip)` 从目标机标准路径和 Java 进程发现候选应用。若共享日志目录、发布目录和 Java 进程线索最终只收敛到一个应用名，可以使用该应用继续；若出现多个候选或候选之间冲突，先让用户确认。
5. `targets.json`、部署页面/API 或用户给出的环境信息中能唯一确定目标。

只有 `app_name` 和 `ip` 都能唯一、可信地确定时，才继续执行日志或诊断查询。否则先问一句最小问题，例如：

```text
要查哪个应用和哪台机器？请给 app_name + IP；如果是刚才的发布单，我可以按选中的机器查。
```

不要因为当前目录名、历史常用应用名或某个默认环境就自行猜测目标机器。

## 推荐流程

### 1. 连接和范围确认

1. 用 `app_server_connection_status` 查看连接。
2. 未连接时用 `connect_app_server_bastion` 连接。
3. 确认最小排查范围：`ip`、`app_name`、可选 `version_tag`、可选 `port`、可选 `pid`、关键字或 traceId、关注时间窗口。

如果是项目环境、stable、test 或 prj 机器，默认要求走 dev 堡垒机路径 `dev.ssh.jumpserver.fenqile.cn`。若当前工具不支持该路径，记录为服务器诊断受阻，不要反复重试同一失败连接。

### 2. 先看服务器和进程

优先轻量确认机器和应用是否活着：

- `server_basic_status(ip)`：时间、主机名、负载、内存、磁盘、vmstat。
- `find_java_process(ip, app_name)`：确认 Java 进程、PID、运行时长、CPU、内存、线程数。
- `java_process_status(ip, app_name|pid)`：确认 `/proc`、线程数、FD 数、limits 等资源状态。

如果找不到进程，先判断应用未启动、应用名不匹配、部署路径不对，暂时不要继续做 JVM/线程诊断。

### 3. 再看端口和健康检查

当用户提供端口，或能从发布日志/应用参数确认端口时：

- `network_port_status(ip, port)`：检查监听和连接状态。
- `local_health_get(ip, port, "/actuator/health")`：只读健康检查。

端口未监听、health 非 UP 或请求失败时，结合版本本地 `stdout.log` 和共享 `error.log` 判断启动失败原因。

### 4. 查日志

共享日志：

- `list_log_files(ip, app_name)`
- `tail_app_log(ip, app_name, "error.log")`
- `grep_app_log(ip, app_name, keyword, "error.log")`
- `recent_error_summary(ip, app_name)`

发布或重启后优先查版本本地日志：

- `list_version_log_files(ip, app_name, version_tag)`
- `tail_version_log(ip, app_name, version_tag, "stdout.log")`
- `grep_version_log(ip, app_name, version_tag, "ERROR|Exception|Throwable|Caused by|Dubbo run OK|项目启动|has publish", "stdout.log")`

查日志时优先按时间窗口、traceId、请求 ID、错误关键字收窄；不要直接拉取大段全量日志。

### 5. JVM、线程和 GC/OOM

只有在进程存在且问题指向 JVM 层时再查：

- `java_jvm_summary(ip, app_name|pid)`：JVM 版本、flags、GC utilization。
- `java_thread_summary(ip, app_name|pid)`：线程状态、BLOCKED/WAITING/RUNNABLE、deadlock 线索。
- `java_thread_summary(..., keyword)`：按线程名或业务关键字过滤。
- `java_gc_log_summary(ip, app_name)`：GC/OOM 关键字和 GC 日志文件摘要。

不要把线程 dump 全量粘贴到最终回复；只提取阻塞线程、异常线程名、deadlock 证据和数量级。

## 汇总结论

回复优先包含：

- 查询的 IP、应用、端口、PID、日志文件、version_tag 和时间范围。
- 进程是否存在，端口是否监听，health 是否正常。
- 关键资源信号：CPU、内存、线程数、FD 数、磁盘空间、负载。
- 关键异常类型、traceId、业务字段、最近出现时间和出现次数。
- 若是发布后排查，明确启动是否成功、启动耗时是否找到、是否有新引入的阻塞错误。
- 如果没查到，说明已经查过的范围和下一步最小建议。

## 工具映射

- 主 MCP：`java_app_diag`
- 兼容日志 MCP：`server_log`
- 底层通道 MCP：`bastion`，仅在缺少专用诊断工具且命令明确只读时才考虑使用。
