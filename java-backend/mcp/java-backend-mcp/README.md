# Java Backend MCP

本地只读 MCP 集合，覆盖 Java 后端研发的高频链路：

- `gitlab`: 查询 GitLab 项目、MR、pipeline。
- `jenkins`: 查询 Jenkins 构建状态、阶段、console 摘要、TestNG 报告。
- `java_app_diag`: 通过既有堡垒机配置做 Java 应用服务器只读诊断，覆盖基础状态、进程、端口、JVM、线程、GC/OOM、健康检查和日志。
- `server_log`: 兼容旧入口，仅保留共享应用日志查询能力；新任务优先使用 `java_app_diag`。
- `browser_session`: 复用本地 Chromium profile，检查登录态、打开登录页、读取脱敏 Cookie、用 session 发起 GET。
- `mysql_readonly`: 复用本地只读 MySQL 实例配置，执行只读 SQL。
- `redis_query`: 通过 bianque/Dubbo `queryRedis` 只读查询 Redis。
- `dubbo_test`: 通过 bianque 服务模拟器调用 Dubbo 接口。
- `config_registry`: 对 Nacos/配置中心/注册中心发起只读 GET，默认只允许公司内网相关域名。
- `sonarqube`: 查询 SonarQube 项目 issue，默认新代码周期 BLOCKER/CRITICAL。
- `lexiao`: 复用乐效脚本查询、构建、打开发布单、单目标部署。
- `healthy`: 复用 Healthy/Nightingale 脚本读取或应用固定大盘模板。
- `observability`: Prometheus/Loki/Jaeger/SkyWalking 只读查询。
- `k8s_readonly`: 通过 `kubectl` 执行 Kubernetes 只读查询和日志读取。
- `mq_readonly`: Kafka/RocketMQ CLI 只读查询和 MQ 控制台只读 GET。
- `artifact_repo`: Maven 本地仓库、Maven 仓库元数据、Nexus search 只读查询。
- `cross_repo_search`: 本地多仓 `rg` 搜索和 GitLab code search。

## 认证

不要把 token 写入 `config.toml`。需要认证时，在启动 Codex 前导出环境变量：

```bash
export GITLAB_TOKEN=...
export JENKINS_COOKIE=...
# 或
export JENKINS_USER=...
export JENKINS_TOKEN=...
```

如果不想依赖启动环境，也可以创建本地文件：

```bash
java-backend/mcp/java-backend-mcp/.env
```

支持的键包括 `GITLAB_TOKEN`、`GITLAB_PRIVATE_TOKEN`、`GITLAB_BEARER_TOKEN`、`JENKINS_COOKIE`、`JENKINS_USER`、`JENKINS_TOKEN`、`JENKINS_API_TOKEN`。

也支持：

- `SONARQUBE_COOKIE`
- `SONARQUBE_XSRF_TOKEN`
- `SONARQUBE_BASE_URL`
- `CONFIG_REGISTRY_ALLOWED_HOSTS`
- `OBSERVABILITY_ALLOWED_HOSTS`
- `MQ_ALLOWED_HOSTS`
- `ARTIFACT_REPO_ALLOWED_HOSTS`

`java_app_diag` / `server_log` 通过 `BASTION_CONFIG` 指定堡垒机配置，默认查找 `~/ai/mcp/bastion-mcp/config.json`。
`mysql_readonly` 复用 `~/.config/codex-mysql-readonly/instances.json`。
`browser_session`、`redis_query`、`dubbo_test`、`lexiao`、`healthy` 复用已有 Playwright profile 和脚本约定。

## 分层

底层通用能力：

- `browser_session`: 浏览器登录态、Cookie、带 session 的只读 GET。
- `config_registry.internal_http_get`: 公司内网 allowlist 下的通用只读 HTTP GET。
- `bastion`: 跳板机通道和受白名单限制的远程只读命令执行。
- `mysql_readonly`: 只读 SQL。
- `dubbo_test`: Dubbo 服务模拟器调用。
- `observability`: 指标、日志、链路追踪查询。
- `k8s_readonly`: Kubernetes 资源、事件、pod 日志读取。
- `artifact_repo`: 制品仓库元数据查询。
- `cross_repo_search`: 本地与 GitLab 跨仓搜索。

薄包装能力：

- `redis_query`: `dubbo_test` 上的 `queryRedis` 专用入口。
- `java_app_diag`: `bastion` 上的 Java 应用服务器诊断安全封装，不开放任意远程 shell。
- `server_log`: `java_app_diag` 的旧日志兼容入口。
- `gitlab`、`jenkins`、`sonarqube`: 对常用研发平台 API 的只读封装。
- `mq_readonly`: Kafka/RocketMQ 常用只读命令封装。
- `lexiao`、`healthy`: 对已有本地脚本的流程封装，包含少量写操作，仍需工具审批。

设计原则：

- 优先复用底层通用工具；业务流程 MCP 只保留高频且容易误操作的安全封装。
- 新增 HTTP 类能力先考虑放到 `internal_http_get`，只有稳定高频场景再加专用工具。
- 不在 `config.toml` 写入 token/cookie；需要认证时使用 `.env`、浏览器 profile 或本地配置文件。
