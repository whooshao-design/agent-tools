# 乐信云 ClickHouse HTTP 查询

## 入口与通道

- 预发布/灰度/线上：`https://lxcloud.lexincloud.com/#/details_clickhouse/query_clickhouse`。
- stable/测试：`https://stable-lxcloud.oa.fenqile.com/#/details_clickhouse/query_clickhouse`，流水实例使用 `ABTestCK`。
- `DecisionWaterHawkCK` 默认使用 `bastion_dba`，其他 CK 实例默认使用 HTTP。用户显式指定通道时覆盖默认值；失败不自动换通道。
- 页面 Hash URL 是前端入口，SQL 请求发往同域 `/v1/clickhouse/` 接口。`--env pre|gray|prod` 使用同一域名，不会自动添加环境过滤条件。

## 推荐脚本

脚本复用 `get-browser-session` 的路径解析、profile 锁、直连网络配置和登录检测。在一次浏览器上下文中读取当前用户、调用接口并保存 Cookie 续期结果；token 仅留在浏览器内存中，不输出到终端。登录失效的处理交给 `get-browser-session`，不要另写登录流程。

```bash
# 不确定实例时先列清单；只输出实例标识和说明，不输出连接地址或凭据。
node /home/joney/projects/ai/agent-tools/skills/lexin/query-clickhouse-water/scripts/clickhouse_http.js \
  --env prod --action instances

# RCbaseCK 已验证可列库；当前账号没有该实例的 SQL 查询权限。
node /home/joney/projects/ai/agent-tools/skills/lexin/query-clickhouse-water/scripts/clickhouse_http.js \
  --env prod --instance RCbaseCK --action databases

node /home/joney/projects/ai/agent-tools/skills/lexin/query-clickhouse-water/scripts/clickhouse_http.js \
  --env prod --instance RCbaseCK --action tables --database risk_control_base_db

# stable 查询链路验证：恒假条件不读取业务明细，不代表实际流水数量。
node /home/joney/projects/ai/agent-tools/skills/lexin/query-clickhouse-water/scripts/clickhouse_http.js \
  --env stable --query 'SELECT count() AS matched_rows FROM risk_control_base_db.t_strategy_node_decision_water WHERE 1 = 0 LIMIT 1'
```

复杂 SQL 用 `--sql-file <本地文件>`，与 `--query` 互斥；每次只执行一条 SQL。支持 `--profile` 和会话层已有的 profile 环境变量。脚本只实现 HTTP；`DecisionWaterHawkCK` 默认会在联网前提示改用 DBA MCP，只有用户显式指定 HTTP 时才额外传 `--transport http`。

## 接口契约

| 用途 | 方法与路径 | 请求体或查询参数 |
|---|---|---|
| 列实例 | `GET /v1/clickhouse/instance_list/` | `page=1&size=2000&user_name=<登录用户>` |
| 列数据库 | `POST /v1/clickhouse/sql_exec/showdatabases` | `{"clickhouse_type":"<实例>"}` |
| 列表 | `POST /v1/clickhouse/sql_exec/showtables` | `{"clickhouse_type":"<实例>","db_name":"<库>"}` |
| 执行查询 | `POST /v1/clickhouse/sql_exec/exec_query` | `{"clickhouse_type":"<实例>","user_name":"<登录用户>","sql":"<只读 SQL>"}` |

从当前页面 `localStorage.userInfo[0].min` 读取 `user_name`；从同源 `localStorage.token` 构造 `Authorization: Bearer ...`，并在同一 BrowserContext 内携带 Cookie。不硬编码用户名，不导出完整 localStorage，不用无登录态的普通 `curl` 查询。

- 实例列表：HTTP 200、外层 `code = 200`，数据在 `data.results`，实例标识为 `ftype`、说明为 `ftype_memo`。列表可包含当前账号无权查询的实例；实际权限以目标请求为准。脚本用 `count/truncated` 标明是否完整。
- 库表列表：还需内层 `data.code = 200`，库表数据位于 `data.data`。
- SQL 查询：必须同时满足 HTTP 200、外层 `code = 200`、`data.code = 200`、`data.query_code = 0`。
- 查询列在 `data.data.columns`，行在 `data.data.data`，耗时在 `data.query_time`。脚本输出 `columns/rows/rowCount/queryTime` 及实际 SQL。
- HTTP 200 或 `query_code = 0` 单独都不代表成功。错误需报告内层 `error`；只有完整成功响应中的空行数组才表示零行。脚本错误以非零退出码返回，不自动重试或切换到 DBA。

## 已验证限制（2026-09-21）

- 线上接口只接受 `SELECT`/`SHOW`；`DESCRIBE` 返回内层 403，错误为“目前只支持SELECT | SHOW 查询语句”。HTTP 表结构探查改用 `SHOW CREATE TABLE <database.table>`，已实测成功。
- 当前账号通过该接口查 `system.columns` 返回“无权限访问以下库: system”；不要依赖系统库来列字段。需要额外权限时报告缺失权限。
- 当前账号的线上 `RCbaseCK`、`RCbaseComCK` SQL 请求返回内层 403“没有实例查询权限”；列库成功不代表具备 SQL 权限。报告权限问题，不自动申请角色或切换通道。
- stable 实测无 `FROM database.table` 的 `SELECT 1` 会被平台校验拒绝；链路验证也应引用已确认的全限定表名，可用恒假条件避免扫描明细。
- 页面可能缓存一个无权限的实例并弹出角色申请提示；这不等于 OA 登录过期，也不代表目标实例无权限。脚本显式传 `clickhouse_type`，不采用缓存选择，不申请或修改角色。
- 明细 `SELECT` 应包含绝对时间范围、显式字段和合理 `LIMIT`；接口不支持的 SQL 只有在保持业务口径时才改写。脚本不会自行补 `Fenv`、`Forigin`、去重条件或时间范围。
