# Skill / MCP 缺口清单

会话里因为 skill 或 MCP 缺少能力而临时写脚本、反查前端代码、反复手工查询时，在收尾时把缺口记到这里（规则见 `AGENTS.global.md` 的 Temporary Files）。
同一缺口第二次出现时，用 `skill-authoring` 把它固化进对应 skill 或 MCP，然后把条目移到“已处理”。

每条写清：日期、触发任务、缺了什么、临时做法、建议落点。

## 待处理

以下前 5 条来自 2026-09-24 清理 `/tmp` 时看到的文件名，原文件已删除，缺口内容是按文件名推断的，处理前先在对应 skill 上复现确认。

| 日期 | 触发任务 | 缺口 | 临时做法（当时的文件） | 建议落点 |
|---|---|---|---|---|
| 2026-09-20 ~ 09-23 | 乐信云查询 | 乐信云接口没有文档，agent 从前端 bundle 反查接口 | `lxcloud_app.js`、`lxcloud_query.js`、`lxjs/`、`lx*.mjs`、`lx_instances.mjs` | `query-mysql-data`、`query-app-instances` 的接口说明 |
| 2026-09-23 | Hippo namespace 操作 | 新建 namespace、授权相关接口靠反查前端 | `hippo_index.html`、`ConfigAppController.js`、`ConfigBaseInfoController.js`、`namespace-panel-directive.js` | `configure-hippo`（先核对 SKILL.md 是否已覆盖） |
| 2026-09-21 | ClickHouse 查询 | HTTP 通道的调用方式需要临时探测 | `clickhouse-http-probe.cjs` | `query-clickhouse-water` |
| 2026-09-21 ~ 09-22 | dispatcher / JedisProxy 排查 | 本地找不到框架源码，只能反编译依赖 | `dispatcher-xin-*bytecode.txt`、`dispatcher-JedisProxy-*.java`、`xin-separate-*bytecode.txt` | 工作区目录地图补框架源码仓库位置 |
| 2026-09-22 | 告警 16620395 排查 | 告警排查时反复手工拉日志、Redis 配置、Pod 信息，多次查询输出为空 | `alert16620395-*`（约 30 个 JSON） | `diagnose-healthy-alert` 的标准取证步骤 |

## 已处理

| 日期 | 缺口 | 处理 |
|---|---|---|
| 2026-09-24 | markitdown MCP 进程加载 onnxruntime 遥测，每个进程留下 `/tmp/mat-debug-<pid>.log` | launcher 默认设置 `ORT_DISABLE_TELEMETRY=1` |
| 2026-09-24 | `healthy_query_metrics` 每次调用在 `/tmp` 根目录留一个 `healthy-metrics-*` 目录 | 结果集中到 `/tmp/agent-work/healthy-metrics/`，超过 24 小时的由下次调用清理 |
