# java-backend

Java 后端研发 MCP 与相关 skills。

## 内容

### MCP

MCP 代码位于：

```text
java-backend/mcp/java-backend-mcp/
```

包含：

- `java_app_diag`: Java 应用服务器只读诊断。
- `server_log`: 旧日志兼容入口。
- `browser_session`: 浏览器登录态、Cookie 和带 session 的只读 GET。
- `mysql_readonly`: 只读 MySQL 查询。
- `dubbo_test`: Dubbo 服务模拟器调用。
- `redis_query`: `DevService.queryRedis` 只读 Redis 查询。
- `gitlab`、`jenkins`、`sonarqube`: 研发平台只读封装。
- `lexiao`、`healthy`: 内部发布和大盘脚本封装。
- `config_registry`、`observability`、`k8s_readonly`、`mq_readonly`、`artifact_repo`、`cross_repo_search`: 配置、监控、集群、MQ、制品和跨仓搜索能力。

### Skills

相关 skills 位于：

```text
java-backend/skills/
```

包含：

- `java-server-diagnostics`
- `server-log`
- `redis-query`
- `test-dubbo-api`
- `get-browser-session`
- `chrome-cookie`
- `query-mysql-test-data`
- `fix-sonarqube-issues`
- `lexiao-deploy`
- `healthy-dashboard-config`
- `jenkins-pipeline-fix`

## 安装 skills

仓库根目录执行：

```bash
python3 install.py --groups java-backend --force
```

安装脚本只复制 skills 到 `~/.claude/skills/`。MCP 需要按 Codex 的 MCP 配置方式单独注册。

## 使用 MCP

推荐把 MCP 目录复制到本机 Codex 目录，或直接将 Codex `PYTHONPATH` 指向本仓库中的 MCP 目录：

```text
java-backend/mcp/java-backend-mcp
```

MCP 不提交任何 token、cookie、私钥或机器本地凭据。需要认证时使用本机环境变量、浏览器 profile、本地只读配置文件或 `.env`。

本机私有文件不要提交：

- `java-backend/mcp/java-backend-mcp/.env`
- `java-backend/skills/test-dubbo-api/targets.json`
- `__pycache__/`
- `*.pyc`
