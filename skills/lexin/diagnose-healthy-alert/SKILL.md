---
name: diagnose-healthy-alert
description: 从雷神告警排查告警原因。Use when 用户给出 Healthy/雷神告警 ID 或 alert-show-detail 链接、要求排查告警原因、判断告警是真实故障还是误报或规则过敏、需要把告警关联到触发指标、埋点代码和应用日志。
metadata:
  version: 1.1.2
---

# diagnose-healthy-alert

## 定位

从雷神（Healthy/Nightingale）告警事件出发，只读采集证据链并给出**告警原因判定**：
事件详情 → 规则配置 → 指标回放 → 埋点代码 → 实例 → 日志 → 定性结论。

不改告警规则、不改大盘、不注册或修改指标、不重启或变更服务。

和相邻 skill 的边界：

- `inspect-healthy-metrics`：入口是 metric，查上报状态；本 skill 入口是告警，按告警窗口回放 `prom_ql`。
- `query-app-logs`：本 skill 产出 `traceId`、`ident`、日志级别、关键词和时间窗作为它的输入；服务器、容器和日志平台的检索都由它路由执行，直接交接取证参数，不再从 error.log 快检门槛重走。
- `query-app-instances`：需要把 `apps` 展开到实例清单时调用。
- `healthy-dashboard-config` / `inspect-healthy-jvm-dashboard` / `register-healthy-metrics`：大盘与指标管理方向，与告警排查无交集。
- `debug-systematic`：通用调试方法论；本 skill 是雷神告警场景的专用证据采集与定性层。

优先使用本 skill 的脚本，不要临时写 curl 或 Node 拼接口。登录态失效时复用 `get-browser-session`
刷新同一个 profile，不要让用户在聊天里提供密码、验证码、Cookie 或 token。

## 环境与接口

默认域名：

- `prod`、`online`、`线上`、`生产` -> `https://healthy.lexincloud.com`
- `stable`、`test`、`测试` -> `https://stable-eye.oa.fenqile.com`（同构参数，未实测）

已验证接口：

```text
GET /api/n9e/alert-show-detail/{alert_id}      -> {dat:{list:[event]}}
GET /api/n9e/alert-rule/{rule_id}              -> {dat:{rule}}
GET /api/n9e/prometheus/api/v1/query_range     -> 按告警窗口回放 prom_ql
```

认证：`--token` > 环境变量 `HEALTHY_METRIC_TOKEN` > `--profile` 中 Healthy 页面的
`localStorage.access_token`。请求头固定带 `X-Cluster: Default`、`X-Language: zh`。
脚本打开告警详情页取 token，页面自身的 `/auth/refresh` 会顺带续期过期 token。
最终回复不输出 token、ticket、Cookie。

n9e 原生的 `alert-cur-events` / `alert-his-events` 列表接口在乐信版返回 404，
**同规则历史告警频率只能用 `--replay` 拉长窗口估算**，不等于真实告警次数。

## 分层排查流程

每层可停：拿到足够定性的证据就输出结论，不必跑完全部层级。

```
L0 事件详情   规则名、severity、is_recovered、触发/恢复时间、trigger_value、
              prom_ql、全量 tags、apps、app_owner、trace_data(traceId)
L1 规则配置   for 时长、评估间隔、生效时段、重复通知、恢复通知、是否已禁用
L2 指标回放   按 trigger_time 前后窗口回放 prom_ql：尖刺还是持续、单实例还是多实例、
              告警前指标是否断流
L3 埋点代码   metric + tags -> 埋点点位 -> 触发条件、配套日志关键词、返回行为
L4 实例定位   ident / apps -> query-app-instances（按需）
L5 日志现场   L3 给出的日志关键词 + traceId + ident + 触发时间窗口
              -> java-server-diagnostics（只读检索，直接执行）
L5.5 外部状态 日志暴露业务主键后，查它依赖的外部状态：配置开关、缓存、元数据、流水
L6 定性输出   证据 -> 结论 -> 建议动作
```

L3 排在 L5 之前：代码检索是本地 `rg`，秒级且不需要堡垒机，却决定了日志层该 grep 什么。

## 脚本

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/diagnose-healthy-alert/scripts/diagnose_alert.js \
  --alert 16343328 --env prod --with-rule --replay --window 30m
```

- `--alert`：告警 ID 或完整 `alert-show-detail` 链接；链接会自动抽 ID 并按主机选站点（`stable-eye` → stable，`healthy.lexincloud.com` → prod），显式 `--env` 与链接冲突时报错。
- `--with-rule`：附带 L1 规则配置。
- `--replay`：附带 L2 指标回放，**一次起浏览器跑两个窗口**——告警窗口回答"尖刺还是持续"，
  基线窗口（`--baseline`，默认 `24h`，`off` 关闭）回答"偶发还是反复、单实例还是多实例"。
  只看窄窗口曾得出过错误的"单实例"结论。`--window` 是触发前后补白，默认 `30m`，`--step` 默认 `60s`。
  `--step` 应与规则的 `prom_eval_interval` 对齐；拉长窗口时放大 step 会把多次触发压缩成一个点，
  此时 `firing_points` 只能读作"至少 N 次"。
- L3 代码线索默认输出，`--no-code-hint` 关闭；`--code-hint-only --metric <m> --app <a>` 纯本地推导，不联网。
- `--code-root`：扫描候选仓库的根目录，默认 `/home/joney/projects`。
- token 缓存在 `~/.cache/healthy-alert-token.json`（权限 0600），避免同一次排查里
  每条命令都重起浏览器（每次 30~40 秒）；缓存失效会自动回退浏览器刷新并重写。
  `--no-token-cache` 关闭，删除该文件即清空。
- L5 访问路径默认输出：脚本按 tags `origins` 判断容器还是 VM，直接给出可执行的日志命令，
  并把 UTC 告警时间换算成服务器本地时间（UTC+8）写进 `--from/--to`；`--log-pad` 调补白，默认 `10m`。
- `--format json`：结构化输出，便于二次处理。

默认只做 L0（一次浏览器起停）；L1、L2 按需加参数。L4、L5 由模型按流程调用其它 skill，不硬编进脚本。

## L3 埋点代码定位

检索算法与踩坑详见 `references/metric-to-code.md`，要点：

1. 从 `prom_ql` 取指标名，剥离 `fql_fk_` 前缀、应用名和 `_counter`/`_average` 类后缀，得到**中缀**（如 `nodeRoute`）。
2. 在候选仓库搜中缀字符串常量（`rg -n '"nodeRoute"' --glob '*.java'`），定位 `LogReporterConstants` 里的常量名。
3. 搜常量引用，得到全部埋点点位；用 tags 的 `module`（类名）和 `type`（自定义分支标签）收敛到唯一点位。
4. 读点位上下文，取**触发条件、配套日志关键词、返回行为**三样。
5. 日志里的 `failureType`、`action` 这类枚举值**必须回代码确认语义**，不要按字面理解。
   实例：`TARGET_CACHE_MISS` 是在 `loadResult.isSuccess()` 为真之后才判定的，
   意思是"加载成功但复查仍找不到目标"，与"加载失败"（`EXACT_REDIS_MISS`）是完全不同的根因。

三条硬约束：

- **`method` 标签不是方法名**：标签值来自常量（如 `EntryConstants.ROUTE_BY_OFFLINE_DECISION_NODE`），
  与 Java 方法名可能拼写不同。直接拿 `method` 当方法名搜会搜空，必须走常量这一跳。
- **壳工程**：`*_simulate`、`*_batch` 这类应用仓库常常只有 `Main.java`，真实埋点在同组主仓库。
  脚本会标记 `thin launcher` 并列出同组兄弟仓库，搜索范围要扩到整组。
- **代码基线**：结论里必须声明仓库路径、分支和末次提交日期，并提示线上版本可能与本地不同。
  本地找不到仓库时，如实报"代码基线缺失"并给出 gitlab 地址，**不要凭指标名猜语义**。

## L5 日志取证

只读检索，直接执行，不征求确认，不预设实例数或时间窗上限。优先 `java_app_diag` MCP；
不可用时按 `java-server-diagnostics` 的兜底规则改用 `bastion` MCP（命令须明确只读）。
容器（tags `origins=k8s`）用 `container_log_check.js --ip=<pod_ip>`，堡垒机 `go` 跳不进 Pod IP。

四条影响结论正确性的规则：

- **一次拿全**：单次取证约 60~90 秒（起浏览器 + WebShell + gotty），第一次就带
  `--files=warn.log,info.log --include-rotated --context=2`，不要先只查 warn.log 再回头补 info.log。
  脚本生成的命令已是这个口径。
- **根因在前一行**：埋点行往往只说"结果为空"，同 traceId 的上一条 ERROR 才是根因，所以 `--context>=2`。
  埋点用 `log.warn` 时日志在 `warn.log` 不在 `error.log`，别沿用"只看 error.log"的快检口径。
- **区分两种空结果**：`matchedFiles` 只列命中过关键词的文件，为空不等于没扫到文件。看 `fileCount` 与 `logDirExists`：
  `fileCount=0` 或 `logDirExists=false` 是没有文件被扫到（轮转、文件名或 `--files` 写错），`completed=true`、`errorCode` 为空、`fileCount>0`、`matchedEvents: 0` 且 `truncated=false` 才是文件里确实没这个关键词（`completed=false` 是传输中断或路径错误，结果只覆盖已返回的部分，不能当"没有"）（`truncated=true` 表示事件或输出超限被丢弃，只能说明"返回范围内没有"，要缩小时间窗或加大 `--max-lines` 重查）。
  把前者当后者，会误判成"代码没打这条日志"而去改关键词，白跑几轮。
- **多实例交叉验证**：L2 基线窗口报出多个实例时至少查两个。业务主键相同说明是一条固定坏数据
  被反复重试，主键不同才是系统性问题——这一步直接决定结论和修复方向。

日志轮转规律、调用方字段、WebShell profile 等操作细节见 `references/log-forensics.md`。

## L5.5 外部状态层

只在日志暴露了具体业务主键（ID、cache key、任务号）时进入。

**先翻日志，再啃代码**：真实的存储 key、field、命中与否通常已经打在同一条链路的 INFO 行里
（`key=hawk:offline-package:prod, field=7035408_3467_46560`、`exact redis hit`）。
先从 L5 已经取回的日志里 grep `key=`、`field=`，拿不到再回代码推导构造逻辑——
反过来做会多花好几轮，而且推导出的 key 未必是运行时真正用的那个。

按这个顺序查：

| 顺序 | 查什么 | 用哪个 skill | 为什么排这个位置 |
|---|---|---|---|
| 1 | **配置开关** | `query-hippo-config` | 代码里的开关分支决定线上实际走哪条路径。不确认开关，L3 读的代码可能根本没执行 |
| 2 | **缓存 / Redis** | `redis-query` | key 通常在日志里直接给了；只能确认当前是否存在和剩余 TTL；key 不存在时是没写入还是已过期，要靠写入日志或历史证据，没有就记未知 |
| 3 | **元数据 / MySQL** | `query-mysql-data` | 判断主键对应的业务对象是否存在、状态是否正常，即缓存 miss 的上游真值 |
| 4 | **业务流水 / ClickHouse** | `query-clickhouse-water` | 确认影响面：受影响的请求量、是否波及真实决策 |

两条硬约束：

- **配置开关排在最前**。代码里出现 `ExecutorHippoConfigConstants.xxx()`、`ConfigService`、
  `@HippoConfigProperty` 这类分支时，先查 Hippo 再下结论，否则会照着一条没走的代码路径解释现象。
- **日志里的 key 不一定是真实存储 key**。先在 L3 找到 key 的构造代码
  （如 `OfflineSnapshotReadThroughService:191` 拼的 `offline:package:<pkg>:<edition>:<task>`
  只是内部 single-flight key，真实存储是 Hash `hawk:offline-package:<env>`
  加 field `<taskId>_<packageId>_<editionId>`），确认前缀、字段顺序和所属实例再查。
  **field 的拼接顺序常与日志打印顺序不同**，不要照日志顺序拼。
- **Hippo 查不到 key 不等于查询失败**。`@HippoConfigProperty` 有 `defaultValue`，
  未配置就是默认值生效。查不到时回代码读默认值和判空写法
  （如 `!BooleanUtils.isFalse(X)` 表示只有显式 false 才关闭），再下"走哪条分支"的结论。
  先看 `scannedNamespaces`：为空说明**应用没定位到**（appId 写法或 env 下无 cluster），
  该换 `--app-keyword` 重找应用；有值而 `hitCount=0` 才是这个 key 确实没配置。
- **MySQL 的 `--db-type` 是 lxcloud 实例键，不是逻辑库名**。拿分片配置里的 logicTable
  前缀（如 `HawkDecisionDB`）当实例键会返回 `SQL error`。按 `query-mysql-data` 的要求，
  先从应用的运行时数据源配置反查实例名和物理 schema 再写 SQL。
  从代码取 Hippo key 名的检索式见 `references/metric-to-code.md`。

## 定性分类

结论必须落到其中之一，不接受"看起来有点异常"式回答：

| 分类 | 典型证据 |
|---|---|
| 业务真实异常 | 指标真实抬升 + 日志有对应错误 + 埋点条件确实是异常分支 |
| 依赖/中间件抖动 | 下游超时、连接池耗尽、MQ 堆积、缓存穿透 |
| 发布/重启相关 | 触发时间与发布窗口对齐，恢复时间与启动完成对齐 |
| 指标口径问题 | PromQL 未聚合、subquery 写法、正则过宽，指标本身没问题 |
| 告警规则过敏 | 阈值/for 时长不合理，`>0` 型规则尤其常见 |
| 指标断流误报 | 告警前指标已断流，触发来自数据缺失而非业务 |
| 瞬时抖动已自愈 | `is_recovered=1` 且持续时间短于业务容忍度 |
| 埋点语义误解 | 指标名唬人，埋点条件其实是正常业务分支 |
| 代码缺陷 | 埋点条件暴露真实 bug |
| 配置导致路径不同 | 开关状态让线上走的分支与预期不同，现象与代码直觉不符 |
| 证据不足 | 代码基线缺失或点位无法定位；如实说明缺什么，不猜 |

## 输出约束

- 只读：不调用任何写接口，不改规则、大盘、指标、配置或服务。
- 报告结构：告警画像 → 逐层证据 → 定性结论 → 建议动作（谁来做、改哪里）。
- 不输出 token、ticket、Cookie、完整登录跳转参数。
- `receiver`、`app_owner` 等人员字段可在终端回复中保留，但不要写入外发文档或外部服务。
- 代码检索超过 3 轮仍未定位点位时，可委派 `Explore` 子代理，默认不委派。

## 未覆盖

- 同规则真实历史告警次数（乐信版列表接口路由未定位，只能用 `--replay` 估算）。
- `stable` 环境接口未实测。
- `dat.list` 多事件场景按数组处理，但只在单事件上验证过。
