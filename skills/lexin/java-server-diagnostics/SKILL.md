---
name: java-server-diagnostics
description: "通过 java_app_diag MCP 对 Java 应用所在服务器做只读排查。默认先只看 error.log 判断有没有问题；只有 error.log 暴露线索后，才递进排查 info/debug/启动日志、进程、端口、JVM、线程或 GC。"
version: 1.1.1
---

# java-server-diagnostics

## 适用场景

用户要求排查 Java 应用所在服务器、检查应用日志有没有异常、发布后启动状态、进程是否存在、端口是否监听、健康检查是否正常、JVM/线程/GC 状态、线上/预发/stable 日志、traceId/关键字相关异常时使用。

## 核心边界

- 首选 `java_app_diag` MCP。
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

## 默认排查策略

用户只说“检查服务器日志有没有问题”“看下应用有没有异常”时，默认目标是先判断是否有问题，而不是做完整服务器体检。

默认只做最小日志快检：

1. 优先调用 `check_app_error_log(ip, app_name?)`。
2. 该工具会自动复用或建立堡垒机连接；PEM 认证可用时，不要先单独调用 `app_server_connection_status` 或 `connect_app_server_bastion`。
3. `app_name` 缺失但用户给了 `ip` 时，允许 `check_app_error_log` 自动从共享日志目录、发布目录和 Java 进程中收敛唯一应用名。
4. 快检只读取共享 `/home/product/logs/<app_name>_logs/error.log` 的摘要和尾部，不默认查 `info.log`、`debug.log`、启动日志、进程、端口、JVM、线程、GC、磁盘或负载。
5. 只有 `error.log` 暴露明确异常、持续错误、启动失败线索或用户继续要求定位时，才进入递进排查。

如果 `check_app_error_log` 返回多个候选应用或无法自动连接，再向用户确认应用名或认证信息。

## 缺少服务名或机器时

用户只说“查看服务日志看看有没有问题”“看下服务有没有异常”时，不要直接猜测服务名或机器。

先按以下顺序从上下文推断：

1. 当前对话刚指定过的 `app_name`、`ip`、`version_tag`、端口或 traceId。
2. 乐效发布/部署上下文中明确选中的应用和机器。
3. 当前仓库或模块名能唯一映射到应用名，且已有唯一目标机器上下文。
4. 用户已提供 `ip` 但未提供 `app_name` 时，先用 `check_app_error_log(ip)` 自动收敛唯一应用名并读取 `error.log`。若返回多个候选或候选之间冲突，先让用户确认；只有需要人工判断候选来源时，才再调用 `discover_java_apps(ip)`。
5. `targets.json`、部署页面/API 或用户给出的环境信息中能唯一确定目标。

只有 `app_name` 和 `ip` 都能唯一、可信地确定时，才继续执行日志或诊断查询。否则先问一句最小问题，例如：

```text
要查哪个应用和哪台机器？请给 app_name + IP；如果是刚才的发布单，我可以按选中的机器查。
```

不要因为当前目录名、历史常用应用名或某个默认环境就自行猜测目标机器。

## 推荐流程

### 1. 最小日志快检

1. 对“看看有没有问题”类请求，直接调用 `check_app_error_log(ip, app_name?)`。
2. 只汇总 `error.log` 中最近的 ERROR/Exception/Caused by 线索和尾部内容。
3. 若 `error.log` 没有明确异常，结论停在“本次只查了 error.log，未发现明显错误线索”，不要继续扩大排查。
4. 若工具返回自动连接失败且提示需要 password/otp，再向用户要最小认证信息。

如果是项目环境、stable、test 或 prj 机器，默认要求走 dev 堡垒机路径 `dev.ssh.jumpserver.fenqile.cn`。若当前工具不支持该路径，记录为服务器诊断受阻，不要反复重试同一失败连接。

### 2. 基于 error.log 递进定位

只有出现以下情况，才继续查其他日志：

- `error.log` 有业务异常、堆栈、重复错误：先用 `grep_app_log(..., "error.log")` 按异常类名、traceId、关键字段收窄。
- 需要还原异常前后上下文：再查 `info.log` 或 `debug.log` 的同一 traceId、请求 ID、用户 ID、任务 ID。
- `error.log` 指向启动失败、配置加载、Dubbo 注册或 Spring 初始化：再查版本本地 `stdout.log` 或共享 `stdout.log`。
- `error.log` 指向 MQ、Redis、DB、RPC 等依赖异常：优先用日志关键字定位具体依赖、消费组、topic、接口或数据源，再决定是否调用对应 MCP。

不要因为有一两条历史 `ERROR` 就直接做 JVM、线程、GC 或服务器资源排查；先判断错误时间、频率和是否仍在持续。

### 3. 进程、端口和健康检查

只有日志指向应用未启动、启动卡住、服务不可用，或用户明确要求检查存活状态时再查：

- `find_java_process(ip, app_name)`：确认 Java 进程、PID、运行时长、CPU、内存、线程数。
- `network_port_status(ip, port)`：检查监听和连接状态。
- `local_health_get(ip, port, "/actuator/health")`：只读健康检查。

端口未监听、health 非 UP 或请求失败时，结合版本本地 `stdout.log` 和共享 `error.log` 判断启动失败原因。

### 4. JVM、线程和 GC/OOM

只有日志或现象指向 JVM 层时再查：

- OOM、Full GC、GC overhead、Metaspace、频繁重启：查 `java_gc_log_summary(ip, app_name)`。
- 线程池耗尽、死锁、阻塞、请求卡住：查 `java_thread_summary(ip, app_name|pid)`，必要时按线程名或业务关键字过滤。
- 需要确认 JVM 参数或轻量 GC 概览：查 `java_jvm_summary(ip, app_name|pid)`。

不要把线程 dump 全量粘贴到最终回复；只提取阻塞线程、异常线程名、deadlock 证据和数量级。

## 汇总结论

回复优先包含：

- 查询的 IP、应用、日志文件和时间范围。
- 关键异常类型、traceId、业务字段、最近出现时间和出现次数。
- 是否只检查了 `error.log`；如果扩展到 `info.log`、`debug.log`、启动日志、进程、端口、JVM 或 GC，要说明扩展原因。
- 若已检查存活状态，再补充进程是否存在、端口是否监听、health 是否正常。
- 若已检查资源状态，再补充 CPU、内存、线程数、FD 数、磁盘空间、负载。
- 若是发布后排查，明确启动是否成功、启动耗时是否找到、是否有新引入的阻塞错误。
- 如果没查到，说明已经查过的范围和下一步最小建议。

## 工具映射

- 主 MCP：`java_app_diag`
- 默认快检：`check_app_error_log`
- 递进日志：`grep_app_log`、`tail_app_log`、`grep_version_log`、`tail_version_log`
- 底层通道 MCP：`bastion`，仅在缺少专用诊断工具且命令明确只读时才考虑使用。
