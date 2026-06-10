---
name: server-log
description: "兼容旧入口：通过堡垒机/跳板机只读查看 Java 应用服务器日志。新任务优先使用 java-server-diagnostics，它覆盖日志、进程、端口、JVM、线程、GC/OOM 和健康检查。"
version: 1.0.0
---

# server-log

这是旧日志排查入口。完整 Java 应用服务器诊断流程见 `../java-server-diagnostics/SKILL.md`。

使用本 skill 时遵循同样的安全边界：

- 只读查询，不修改、不删除、不重启服务。
- 通过堡垒机/跳板机访问目标服务器，不直连业务服务器。
- 优先使用 `java_app_diag` MCP；如果只需要旧日志能力，也可以使用 `server_log` MCP。
- 默认共享日志目录：`/home/product/logs/<app_name>_logs/`。
- 默认优先查 `error.log`，必要时再查 `debug.log`、`info.log`、`stdout.log`。
- 不在最终回复中输出 Cookie、token、密码、完整敏感配置值或大段原始日志。

常用工具：

- `list_log_files(ip, app_name)`
- `tail_app_log(ip, app_name, file_name="error.log")`
- `grep_app_log(ip, app_name, keyword, file_name="error.log")`
- `recent_error_summary(ip, app_name)`
