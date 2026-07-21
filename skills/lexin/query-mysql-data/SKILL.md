---
name: query-mysql-data
description: 查询和验证公司内网 MySQL 数据，支持测试/stable 本地只读实例和线上 lxcloud SQL 查询。Use when 用户要求只读查询 MySQL、查看表结构或样例记录、验证数据库数据；未明确实例时必须优先从目标项目运行时数据源代码反查实例与逻辑库，线上 db_type 不使用静态白名单，可复用浏览器 session 获取 lxcloud token/Cookie，最终必须输出 SQL 和查询结果。
metadata:
  version: 2.5.0
---

# query-mysql-data

## 定位

只读查询 MySQL 数据，覆盖两类入口：

- 测试/stable 环境：只能使用本地 mysql 客户端直连只读实例，复用 `~/.config/codex-mysql-readonly/instances.json`。
- 线上/prod 环境：只能使用 lxcloud HTTP SQL，通过 `https://lxcloud.oa.fenqile.com/v1/mysql/sql-query/exec-query/` 查询受限线上元信息和受控业务配置/测试数据。

MCP 优先、脚本兜底。已注册 `mysql_readonly` MCP 时，测试/stable 本地实例优先使用 MCP；线上 lxcloud 查询如 MCP 未暴露对应工具，则使用本 skill 的脚本。脚本路径固定为 `/home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js`。

## 核心约束

- 只执行只读 SQL：`SELECT`、`SHOW`、`DESCRIBE`、`DESC`、`EXPLAIN`、`WITH`。不要执行 INSERT/UPDATE/DELETE/DDL、权限或管理类 SQL。
- 最终回复必须包含实际执行 SQL 和查询结果。
- 环境路由必须固定：`test/stable` 走本地 mysql 客户端直连；`online/prod/线上` 走 lxcloud HTTP SQL。不要用本地 mysql 客户端直连线上库。
- `db_type` 表示 lxcloud 数据库实例配置键，schema/database 表示逻辑库；两者不能混用。
- 线上 `db_type` 不设客户端静态白名单，可以使用代码确认且当前账号有权访问的任意实例；这不会绕过 lxcloud 自身鉴权。
- 线上查询不要访问非排障必要的业务流水、用户隐私或资金交易明细；业务表必须带明确业务键并限制字段和行数。
- 不要把 Bearer token、Cookie、oa_session、JWT、数据库密码写入 skill、仓库、命令历史或回复。线上凭据优先从环境变量读取；缺失时可由脚本在当前进程内复用浏览器 session 读取 lxcloud localStorage token，不写文件、不输出明文。
- 用户在聊天里粘贴了 token/cookie 时，不要复制进文件；只说明不会存储，必要时让用户改用环境变量重新提供。

## 实例定位（必须先于查询）

按以下优先级确定实例，禁止按业务域名称猜测：

1. 用户明确给出实例或 lxcloud `db_type`：使用该值；逻辑库仍从 SQL 或代码确认。
2. 用户未明确实例：先定位目标表所属应用/仓库，再从运行时代码反查：
   - 在 Mapper、DAO、SQL 中定位目标表，由 `table2db.properties`、分库配置或 SQL 全限定名确认逻辑库。
   - 从 `server.properties`、`application*.properties/yml`、`bootstrap*`、Spring DataSource 配置中提取 `zk.db.key`、`zk.db.path`、`datasource.*.name/key` 等实例配置键。
   - 追踪 `Transporter`、`MultipleDataSource`、`ShardPlugin` 或项目自定义路由，确认“实例配置键 → 逻辑库 → 目标表”的完整关系。
   - 检查 Maven profile、assembly/conf 和环境资源覆盖；生产查询使用生产运行时配置，不使用默认测试 profile 猜测。
3. 代码只给出配置中心 key、不同环境可能覆盖时，再只读查询对应环境的生效配置；不要退回到相邻的已知实例试错。
4. 仍存在多个候选时，列出证据和差异并请用户确认，不执行线上 SQL。

证据优先级：运行时环境覆盖配置 > 公共运行时配置 > Mapper/分库映射。`generatorConfig.xml`、测试资源、`target/` 和本机临时 JDBC 配置只用于辅助定位，不能单独证明线上实例。搜索过程中如发现 URL 或凭据，只提取实例 key/schema，不输出密码或完整连接串。

示例：`zk.db.key=ProcessmanageDB` 是实例，`db.name=process_engine_db` 是逻辑库，`t_process=process_engine_db` 是表到库映射；查询应使用 `db_type=ProcessmanageDB`，SQL 再访问 `process_engine_db.t_process`，不能因为业务属于流程引擎就改用 `ProcesstestDB`。

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

线上只读查询使用 `--lxcloud`。脚本按以下顺序获取授权：

1. 优先读取 `LXCLOUD_AUTHORIZATION` / `LXCLOUD_BEARER_TOKEN` 或对应命令行参数。
2. 未配置时，自动调用 `get-browser-session`，从 `https://lxcloud.oa.fenqile.com/` 的 localStorage `token` 读取授权，只在当前进程内传递。

`user_name` 按“显式 `--user-name`/`LXCLOUD_USER_NAME` → token 中的 OA 用户字段 → lxcloud 页面显示的登录账号 → 当前系统用户”确定。浏览器会话可用时不要直接用本机用户名代替 OA 账号，否则本机账号与 OA 账号不一致时会被误判为无实例权限。

如果浏览器登录态缺失，先打开 lxcloud 完成登录：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --ensure \
  --url=https://lxcloud.oa.fenqile.com/ \
  --success-text=none
```

常规查询不需要手工导出 token：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js \
  --lxcloud \
  --db-type ProcesstestDB \
  --query "SELECT * FROM process_engine_test_db.t_test_task WHERE Ftask_id = 46349"
```

实例由代码确认后可直接传入，不受客户端固定列表限制：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/query-mysql-data/scripts/mysql_readonly.js \
  --lxcloud \
  --db-type ProcessmanageDB \
  --query "SHOW TABLE STATUS FROM process_engine_db LIKE 't_process'"
```

如需显式传入环境变量，仍可使用：

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

- `--db-type <instance>`：lxcloud 实例配置键，接受任意经授权实例，不等于 schema/database 名。
- 已知别名仅作输入归一化：`process-test -> ProcesstestDB`、`process-manage -> ProcessmanageDB`、`hawk/mihawk -> HawkDecisionDB`、`credit/creditm -> CreditmDB`。
- 不提供模糊的 `process` 别名，避免把流程管理库误路由到流程测试实例。
- `--query-role` 默认 `masterbackup`。
- `--query-type` 默认 `single`。
- `--user-name` 可显式覆盖，也可用 `LXCLOUD_USER_NAME`；未提供时优先从 token 或 lxcloud 浏览器会话识别实际 OA 账号，最后才回退当前系统用户。
- `--no-browser-session` 或 `LXCLOUD_DISABLE_BROWSER_SESSION=1`：禁用从浏览器 session 自动读取 lxcloud token。
- `--browser-profile` 或 `LXCLOUD_BROWSER_PROFILE`：指定复用的浏览器 profile。
- `--browser-storage-key` 或 `LXCLOUD_TOKEN_STORAGE_KEY`：指定 localStorage token key，默认 `token`。
- `--browser-url` 或 `LXCLOUD_URL`：指定读取 token 的 lxcloud 页面，默认 `https://lxcloud.oa.fenqile.com/`。

## 查询流程

1. 先判断目标环境：`test/stable` 用本地 mysql 客户端直连；`online/prod/线上` 用 lxcloud HTTP SQL。
2. 按“实例定位”章节取得确切实例和逻辑库；没有证据时不发起查询。
3. 线上查询默认先用环境变量授权，缺失时由脚本复用 `get-browser-session` 读取 lxcloud localStorage token；同时优先从 token/页面识别 OA 账号，登录态过期时先刷新 session。
4. 在已确认实例上定位库表。未知表结构时优先执行 `SHOW DATABASES`、`SHOW TABLES`、`DESCRIBE <table>`；返回 SQL error 时先复核实例路由，不切换到语义相近实例碰运气。
5. 对大表加必要条件和 `LIMIT`；查询业务数据必须带业务键并限制字段。
6. 回复先给“实例、逻辑库、定位证据”，再给结论、实际 SQL 和结果；结果过多时只展示关键行并说明截断。

## 安全边界

- 脚本会逐条校验 SQL 首关键字，拒绝非只读语句。
- 本地 MySQL 客户端会启用 `--safe-updates` 和 `SET SESSION TRANSACTION READ ONLY`。
- lxcloud 不再使用客户端实例白名单；脚本只校验 `db_type` 非空、长度和控制字符，最终访问权限由 lxcloud 服务端决定。
- 不在本 skill 中新增任何线上 token、Cookie 或数据库账号配置文件。
- 自动读取的 localStorage token 只在当前 Node 子进程内使用；`--show-secrets` 只由脚本内部调用，不把明文 token 写入文件、日志或最终回复。
