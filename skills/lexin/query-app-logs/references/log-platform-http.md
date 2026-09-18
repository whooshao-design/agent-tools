# 日志平台 HTTP 接口

页面 `https://log.oa.fenqile.com/#/dashboard`（业务日志）只是前端入口；检索由同域 JSON 接口完成，请求需在已登录的
浏览器 BrowserContext 内发出（复用 `get-browser-session` 的 `main` profile）。实测直接调用接口不需要额外 CSRF 头。

## 接口

| 用途 | 方法与路径 | 说明 |
|---|---|---|
| 当前用户 | `GET https://fql_api.oa.fenqile.com/oa/api/user/session.json?resource_sn=RD_OA` | `result_rows[0].min` 为 OA 账号，页面用它填 `min` |
| 热数据保留天数 | `GET /api/archLog/hotDueDay` | `data` 为天数（2026-09-16 实测 90） |
| 检索 | `POST /api/archLog/page`，`Content-Type: application/json` | 热数据与「查询(冷备数据)」按钮共用此接口，由服务端按时间范围选表 |

### `POST /api/archLog/page` 请求体

```json
{"start":1789546727724,"end":1789550327724,
 "times":["2026-09-16T08:18:47.724Z","2026-09-16T09:18:47.724Z"],
 "type":10,"app":"server_hawk_decision_manage","env":"",
 "tid":"","uid":"","ip":"","cls":"","mth":"","keyword":"",
 "filters":[{"type":1,"value":"queryPackageById"}],"domains":[{"value":"queryPackageById"}],"filterType":1,
 "orderType":true,"page":1,"limit":100,"min":"joneyshao"}
```

| 字段 | 页面控件 | 取值 |
|---|---|---|
| `start` / `end` | 时间范围 | 毫秒时间戳；`times` 是同一范围的 ISO(UTC) 字符串，页面两者都发 |
| `type` | 日志类型 | `10` ALL、`0` INFO、`1` ERROR、`2` NGINX、`3` DUBBO |
| `app` | 应用名 | 纯文本输入，无远程搜索接口；必须是准确应用名 |
| `env` | 环境 | `""` 全部、`prod` 生产环境、`gray` 灰度、`oa` OA、`pre` 预发布 |
| `tid` / `ip` / `cls` / `mth` / `uid` | 链路 ID / 主机 Ip / 服务 / 方法 / UID | 字符串，空串表示不过滤 |
| `filters[]` | 日志 body 关键字 | 每个关键字 `{"type":1,"value":"..."}`；`domains[]` 是页面同一输入的镜像，无关键字时为 `[{"value":""}]` |
| `filterType` | 日志 body 过滤关系 | `1` 与、`2` 或 |
| `orderType` | 时间倒序 | `true` 倒序（默认）、`false` 正序 |
| `page` / `limit` | 分页 | 页面固定 `limit=100`；脚本允许 1–500 |
| `min` | — | 当前 OA 账号；实测缺省也能查询，脚本仍按页面行为填写 |
| `keyword` | — | 页面恒为空串，保留即可 |

### 响应

```json
{"retcode":0,"retmsg":"all cost:1037,ck realtime cost:1037","detail":"",
 "page":1,"limit":100,"offset":0,"totalNum":51670,"totalPage":517,
 "resultRows":[{"app":"...","body":"2026-09-16 17:18:15.264|243|<traceId>|0|INFO|<class>|<method>|53|UID=,SESSIONID=,ENV=prod,SET=gz_ydjd_idc|<message>",
   "cls":"...","env":"prod","etlTime":1789550295000,"ip":"10.17.103.133","mth":"consume","tid":"...","time":1789550295264,"type":0,"uid":""}]}
```

- `retcode` 非 0 即失败：`retmsg` 是页面弹窗文案（如 `查询日志出错！`），`detail` 是后端异常堆栈。
- `body` 是原始日志行，字段按 `|` 分隔：时间、线程/进程号、traceId、（空）、级别、类、方法、行号、`UID=,SESSIONID=,ENV=,SET=` 上下文、消息；异常堆栈以 `\n` 跟在消息后。
  `type` 字段是日志类型编码（INFO/WARN 都记为 `0`），级别要从 `body` 第 5 段取。
- `time` 是日志时间（毫秒），`etlTime` 是入库时间；`ip` 是产生日志的主机/Pod IP。

## 冷备数据

- 起始时间早于热数据保留期时，页面隐藏「查询」、显示「查询(冷备数据)」，但两者发送完全相同的请求；服务端改查历史表。
- 2026-09-16 实测查询 100 天前返回 `retcode=-1`、`retmsg=查询日志出错！`，`detail` 为
  `ClickHouse ... Table arch_log_db.t_arch_log_history_info doesn't exist`，即冷备链路当前在平台后端不可用。
  脚本不做特殊分支，只在起始时间早于 `hotDueDay` 时给出 warning 并原样透出错误摘要。

## 页面约束

- 应用名为必填；时间范围必填，页面默认最近 1 小时。
- 结果按页返回，页面固定 100 条/页，`totalNum` 是总匹配条数，`totalPage = ceil(totalNum / limit)`；宽泛条件（如 ALL + 1 小时）动辄数万条，先加 traceId、级别或关键字收窄。
- 服务端会对每页内容做去重（页面显示"本页去重后 N 条"）：`limit=200` 命中大量重复 WARN 时一页可能只返回 52 条，
  所以"返回条数小于 limit"不代表最后一页，翻页只能以 `totalPage` 或空页为终止条件；`limit=200` 实测可用，更大值未验证。
- 平台是按行入库的聚合视图，多行堆栈跟在同一条 `body` 里；服务器上的原始文件仍是权威来源。
