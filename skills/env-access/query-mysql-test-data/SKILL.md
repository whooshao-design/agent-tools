---
name: query-mysql-test-data
description: 查询和验证公司内网测试/stable 环境 MySQL 数据。Use when Codex needs to run read-only MySQL queries against locally stored test-environment credentials, inspect schemas, validate sample records, or extend the local config for more read-only test MySQL instances. Do not use for production/online data unless explicitly reconfigured and requested.
version: 1.0.0
---

# Query MySQL Test Data

## 工具优先级

已注册 `mysql_readonly` MCP 时，优先使用其工具完成本 skill 的查询与操作；MCP 不可用或未注册时，再按下文的脚本/HTTP 方式兜底。两者底层能力一致。


## Core Rule

Use this skill only for test/stable environment data lookup or verification. Do not use it for production/online data unless the user explicitly asks and the configuration has been intentionally changed for that environment.

Use only read-only credentials. Prefer Slave/read replica accounts; never store or use Master/write credentials for routine validation.

The script stores credentials locally in:

```bash
~/.config/codex-mysql-readonly/instances.json
```

The file must stay `0600`; do not print full host/user/password values in chat unless the user explicitly asks for raw secrets.

## Commands

Prefer the bundled script:

```bash
node /home/joney/projects/ai/agent-tools/skills/env-access/query-mysql-test-data/scripts/mysql_readonly.js --doctor
node /home/joney/projects/ai/agent-tools/skills/env-access/query-mysql-test-data/scripts/mysql_readonly.js --list
```

Add or refresh an instance with explicit read-only credentials. Prefer environment variables for secrets so they are not echoed into shell history:

```bash
export MYSQL_HOST='<host>'
export MYSQL_PORT='<port>'
export MYSQL_USER='<readonly_user>'
read -r -s MYSQL_PASSWORD
export MYSQL_PASSWORD
node /home/joney/projects/ai/agent-tools/skills/env-access/query-mysql-test-data/scripts/mysql_readonly.js \
  --add-instance <instance_name> \
  --display-name '<display_name>' \
  --mode readonly-slave \
  --source '<source_hint>' \
  --set-default
unset MYSQL_PASSWORD
```

Check connectivity:

```bash
node /home/joney/projects/ai/agent-tools/skills/env-access/query-mysql-test-data/scripts/mysql_readonly.js --check
```

Run a read-only query:

```bash
node /home/joney/projects/ai/agent-tools/skills/env-access/query-mysql-test-data/scripts/mysql_readonly.js \
  --query "SHOW DATABASES"
```

Open an interactive client:

```bash
node /home/joney/projects/ai/agent-tools/skills/env-access/query-mysql-test-data/scripts/mysql_readonly.js
```

The script passes `--safe-updates` and initializes the session with:

```sql
SET SESSION TRANSACTION READ ONLY
```

The stored account should also have only `SELECT` grants.

## Instance Support

Default instance: the `defaultInstance` value stored in `~/.config/codex-mysql-readonly/instances.json`.

The config format is multi-instance:

```json
{
  "version": 1,
  "defaultInstance": "<instance_name>",
  "instances": {
    "<instance_name>": {
      "displayName": "<display_name>",
      "host": "...",
      "port": "...",
      "user": "...",
      "password": "...",
      "mode": "readonly-slave",
      "source": "manual"
    }
  }
}
```

To check a configured instance:

```bash
node /home/joney/projects/ai/agent-tools/skills/env-access/query-mysql-test-data/scripts/mysql_readonly.js \
  --instance <name> --check
```

## Safety

For `--query`, the script rejects obvious write statements such as `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, and similar commands.

When a task requires schema exploration, start with:

```sql
SHOW DATABASES;
SHOW TABLES;
DESCRIBE <table>;
EXPLAIN <select-query>;
```
