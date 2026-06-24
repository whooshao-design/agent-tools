---
name: query-mysql-data
description: 查询和验证公司内网 MySQL 数据，支持测试/stable 本地只读实例和受限线上 lxcloud SQL 查询。Use when 用户要求只读查询 MySQL、查看流程引擎元信息、米霍克元信息、测试任务表、表结构、样例记录或验证 MySQL 数据；线上查询只允许 ProcesstestDB 和 HawkDecisionDB 两个实例，可复用浏览器 session 获取 lxcloud Cookie，最终必须输出 SQL 和查询结果。
version: 2.1.1
---

# query-mysql-data

## 定位

只读查询 MySQL 数据，覆盖两类入口：

- 测试/stable 环境：只能使用本地 mysql 客户端直连只读实例，复用 `~/.config/codex-mysql-readonly/instances.json`。
- 线上/prod 环境：只能使用 lxcloud HTTP SQL，通过 `https://lxcloud.oa.fenqile.com/v1/mysql/sql-query/exec-query/` 查询受限线上元信息数据。

MCP 优先、脚本兜底。已注册 `mysql_readonly` MCP 时，测试/stable 本地实例优先使用 MCP；线上 lxcloud 查询如 MCP 未暴露对应工具，则使用本 skill 的脚本。脚本路径固定为 `/home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js`。

## 核心约束

- 只执行只读 SQL：`SELECT`、`SHOW`、`DESCRIBE`、`DESC`、`EXPLAIN`、`WITH`。不要执行 INSERT/UPDATE/DELETE/DDL、权限或管理类 SQL。
- 最终回复必须包含实际执行 SQL 和查询结果。
- 环境路由必须固定：`test/stable` 走本地 mysql 客户端直连；`online/prod/线上` 走 lxcloud HTTP SQL。不要用本地 mysql 客户端直连线上库。
- 线上 lxcloud 查询只允许两个 `db_type`：
  - `ProcesstestDB`：流程引擎元信息数据。
  - `HawkDecisionDB`：米霍克元信息数据。
- 线上查询不要访问业务流水、用户隐私明细、资金交易等非元信息数据；用户要求超出上述范围时拒绝或先确认合法替代查询。
- 不要把 Bearer token、Cookie、oa_session、JWT、数据库密码写入 skill、仓库、命令历史或回复。凭据只从环境变量读取。
- 用户在聊天里粘贴了 token/cookie 时，不要复制进文件；只说明不会存储，必要时让用户改用环境变量重新提供。

## 测试/stable 本地直连

常用命令：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js --doctor
node /home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js --list
node /home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js --check
```

执行只读 SQL：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js \
  --query "SHOW DATABASES"
```

指定本地实例：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js \
  --instance <name> \
  --query "DESCRIBE some_db.some_table"
```

本地实例配置仍存放在：

```bash
~/.config/codex-mysql-readonly/instances.json
```

该文件必须保持 `0600`，且只能保存只读账号。

## 线上/prod lxcloud HTTP SQL

线上只读查询使用 `--lxcloud`，凭据只从环境变量读取：

```bash
read -r -s LXCLOUD_BEARER_TOKEN
export LXCLOUD_BEARER_TOKEN
export LXCLOUD_USER_NAME="joneyshao"

node /home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js \
  --lxcloud \
  --db-type ProcesstestDB \
  --query "SELECT * FROM process_engine_test_db.t_test_task WHERE Ftask_id = 46349"

unset LXCLOUD_BEARER_TOKEN
```

如 lxcloud 同时要求 Cookie，不要让用户在聊天里粘贴 Cookie。先复用 `get-browser-session` 作为会话层：MCP 可用时优先调用 `browser_session` 的 `check_session`/`ensure_session` 和 `get_cookies`，目标 URL 使用 `https://lxcloud.oa.fenqile.com/`，domain 使用 `lxcloud.oa.fenqile.com`；MCP 不可用时再用脚本兜底检查或刷新登录态：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --ensure \
  --url=https://lxcloud.oa.fenqile.com/ \
  --success-text=none

node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --cookies \
  --show-secrets \
  --domain=lxcloud.oa.fenqile.com \
  --url=https://lxcloud.oa.fenqile.com/
```

只在本地 shell 中把 Cookie 临时设置给查询脚本：

```bash
read -r -s LXCLOUD_COOKIE
export LXCLOUD_COOKIE
```

参数说明：

- `--db-type ProcesstestDB`：流程引擎元信息，只允许这个值或别名 `process`。
- `--db-type HawkDecisionDB`：米霍克元信息，只允许这个值或别名 `hawk`、`mihawk`。
- `--query-role` 默认 `masterbackup`。
- `--query-type` 默认 `single`。
- `--user-name` 默认当前系统用户，也可用 `LXCLOUD_USER_NAME`。

## 查询流程

1. 先判断目标环境：`test/stable` 用本地 mysql 客户端直连；`online/prod/线上` 用 lxcloud HTTP SQL。
2. 线上查询必须确认属于 `ProcesstestDB` 或 `HawkDecisionDB`；如果用户只说“流程引擎”，映射为 `ProcesstestDB`；只说“米霍克/Hawk”，映射为 `HawkDecisionDB`。
3. 线上查询遇到 lxcloud 需要 Cookie 或登录态过期时，先通过 `browser_session` MCP 获取/刷新 session，再把 Cookie 临时传给脚本；不要把 Cookie 写入文件或回复。
4. 查询前先定位库表。未知表结构时优先执行 `SHOW TABLES`、`DESCRIBE <table>`、`EXPLAIN <select>`。
5. 对大表加必要条件和 `LIMIT`；查单任务、单乐包、单配置时必须带业务键过滤。
6. 回复时先给结论，再给 SQL，再给结果。结果过多时只展示关键行并说明截断。

## 安全边界

- 脚本会逐条校验 SQL 首关键字，拒绝非只读语句。
- 本地 MySQL 客户端会启用 `--safe-updates` 和 `SET SESSION TRANSACTION READ ONLY`。
- lxcloud 查询会在脚本内校验 `db_type` 白名单，非 `ProcesstestDB`/`HawkDecisionDB` 直接拒绝。
- 不在本 skill 中新增任何线上 token、Cookie 或数据库账号配置文件。
