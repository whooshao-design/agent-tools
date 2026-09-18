# 即席分析 HTTP 接口

页面 `https://data.oa.fenqile.com/microapps/data/portal/improvisationAnalysis` 只是前端入口；查询由同域 JSON 接口完成，
请求必须在已登录的浏览器 BrowserContext 内发出（复用 `get-browser-session` 的 `main` profile）。所有接口均为
`POST`、`Content-Type: application/json`，响应外层为 `{"retcode":0,"retmsg":"success","result_rows":[...]}`，
`retcode` 非 0 即失败（注意 `/oa/api/user/session.json` 的 `retcode` 是字符串 `"0"`）。

## 查询链路（脚本已封装）

| 步骤 | 路径 | 请求体 | 关键返回 |
|---|---|---|---|
| 当前用户 | `/oa/api/user/session.json` | `{}` | `result_rows[0].min`（OA 账号）、`name`、`mid` |
| 文件夹与文件 | `/oa/data/adhoc/management/folder/list.json` | `{"type":1,"userName":"<min>"}` | 每个文件夹 `id/name/item_list[]`，文件 `type=3` |
| 文件内 SQL | `/oa/data/adhoc/management/sql/detail.json` | `{"fileId":<id>,"userName":"<min>","fileType":3}` | 段落 `id`（即 sqlId）、`name`、`engine`、`sql` |
| 保存 SQL | `/oa/data/adhoc/management/file/saveorupdate.json` | `{"fileType":3,"fileName":"<名>","fileId":<可选>,"folderId":<id>,"userName":"<min>","sqlList":[{"sqlId":<可选>,"sqlName":"...","fileType":2,"sql":"...","engine":"Presto","cluster":"","userName":"<min>","position":1}]}` | `file_id`、`file_name`、`sql_list[0].sql_id` |
| 提交执行 | `/oa/data/adhoc/management/sql/submit.json` | `{"sql":"...","wholeSql":"...","userName":"<min>","engine":"Presto","cluster":"","sqlName":"...","isSkipCheckSql":false,"sqlId":<sql_id>,"executeTableName":""}` | `result=0` 且 `sql_instance_id`；`result=2` 时 `message` 为拒绝原因 |
| 轮询结果 | `/oa/data/adhoc/management/sql/instance/getResult.json` | `{"sqlInstanceId":<id>,"userName":"<min>","time":<ms>}` | `status`、`progress`、成功时 `data.columns` / `data.datas`，失败时 `message` |
| 执行日志 | `/oa/data/adhoc/management/sql/instance/log.json` | 同上 | `description`、`status`、`execute_cost`、`optimize_description` |

- `submit.json` 不带 `sqlId` 会返回 `errcode:36810001 请求参数缺失:参数名称sqlId`，所以 SQL 必须先保存成文件段落。
  页面每次“新建 SQL + 运行”都会在 `用户临时目录` 生成 `FILE<时间戳>` 文件；脚本改为复用同一目录下名为
  `agent-tools-adhoc` 的文件并原地更新其唯一段落，避免堆积临时文件。
- `getResult.json` 的 `status`：`0` 执行中、`1` 成功、`2` 失败；`data.datas` 是字符串二维数组，行序与 `columns` 对应。
- `engine` 取 `Presto` 或 `Spark`；提交时 `cluster` 传空串即可（页面也如此，集群由服务端按用户分配）。
- 页面附带但脚本未调用的接口：`sql/suggest.json`（SQL 建议）、`sql/instance/sensitiveInfoScan.json`（敏感信息扫描）、
  `metric/presto/getMetrics.json`（集群负载）。

## 元数据接口（按需手工调用）

| 用途 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| 数仓分层 | `/oa/data/asset/management/open/adhoc/database/listWarehouseInfo.json` | `{"tableType":2}` | ODS/DWD/DWB/DWS/DIM/DM/ADS/MID/TMP 层说明 |
| 全量库表 | `/oa/data/asset/management/open/adhoc/table/all.json` | `{"tableType":2}` | 返回约 7MB，`tables[].database_name` + `table_names[]`；查某库表名优先用 `SHOW TABLES FROM <db>` |

## 页面约束

- 未写 `LIMIT` 时服务端自动追加 `LIMIT 1000`；页面和接口只返回前 1000 行，更多需用页面“下载”功能（脚本未封装）。
- `LIMIT N` 且 `N > 1000` 时页面会自动切换到 Spark 引擎；脚本不做自动切换，需要时显式 `--engine spark`。
- 元数据语句实测（2026-09-16）：`SHOW TABLES IN <db> [LIKE 'x%']`、`DESCRIBE <db>.<table>` 在 Presto 可用；
  `SHOW DATABASES` 仅 Spark 可用（Presto 报 `mismatched input 'databases'`）；`SHOW SCHEMAS` 被门户预检拒绝
  （`errcode:36810011 SQL语法错误`，`isSkipCheckSql=true` 也不能跳过）；`information_schema.*` 无查询权限（`errcode:36810013`）。
- 每次提交都会在页面“全部运行历史”留下记录。
