---
name: lxctl-gateway
description: OA AI 网关（公司 CLI lxctl 背后的 gateway.oa.fenqile.com）调用底层：检查 lxctl 安装与 OAuth 登录、自动续期 token、带超时与重试地调用网关接口，并提供雷神 PromQL 即时查询（JVM 堆/GC/线程、RPC、机器与容器资源）。供 query-app-logs 等 skill 复用。Use when 需要在新机器安装或登录 lxctl、排查 lxctl token 过期或网关报错、用 PromQL 即时查询某应用的 JVM 或机器指标而浏览器登录态不可用、或其他 skill 的脚本要经 OA 网关取数；按应用查日志用 query-app-logs，看 Healthy 大盘用 inspect-healthy-jvm-dashboard。
metadata:
  version: 1.0.0
---

# lxctl-gateway

## 定位

公司 CLI `lxctl`（npm 包 `@lx/lxctl`）用 OA OAuth2 token 调用 OA AI 网关 `https://gateway.oa.fenqile.com/rc_oa_gateway/jiagouzhongxin`。本 skill 是这条通道在 agent-tools 里的底层：

- `scripts/lxctl_gateway.js` 读 `lxctl auth login` 存在 `~/.lxctl/tokens.json` 的 token，直接对网关发 HTTPS 请求；token 被拒时调用一次 `lxctl auth refresh` 再重试；网络错误、超时、502/503/504 重试 2 次。不打印 token。
- 其他 skill 的脚本用 `require(skillDir('lxctl-gateway', 'scripts', 'lxctl_gateway.js'))` 取 `callGateway()`、`eyeQuery()`、`readToken()`、`status()`，不各自拼请求头。`query-app-logs` 的日志检索已经这样接入。

和浏览器登录态通道（`get-browser-session`）的区别：这条通道只依赖一个可以无浏览器续期的 OAuth token，不依赖 Playwright、aTrust 页面登录或堡垒机，换机器只需装包并授权一次。它只能调用网关已登记的接口（见下表），不能替代页面操作。

不做的事：不改网关配置，不调用写接口（`lxctl` 对高风险操作有 `--yes` 确认协议，本 skill 的脚本不传），不把 token 写进仓库或输出。

`lxctl skill install` 会往 `~/.claude/skills/lxctl/`、`~/.codex/skills/lxctl/` 写公司维护的三份说明（`lxctl`、`log-query`、`monitor-query`）。它们和本仓库的 skill 触发词重叠，装不装都不影响本 skill 的脚本；装了以后日志查询仍以 `query-app-logs` 为入口。

## 安装与登录（每台机器一次）

前置：Node.js ≥ 16，已连零信任（内部 npm 源和网关都在内网）。

```bash
npm install -g @lx/lxctl --registry=http://registry.npm.frd.fenqile.com   # 只对这条命令指定内部源，不改全局 registry
lxctl config init --new          # 写 ~/.lxctl/config.json（网关与 OAuth 默认值）
lxctl auth login                 # OA OAuth2 设备码流程：自动打开浏览器，用户点确认
chmod 600 ~/.lxctl/tokens.json   # lxctl 0.1.32 写出来是 644
node scripts/lxctl_gateway.js doctor --probe
```

- `lxctl auth login` 要用户在浏览器里确认，agent 运行命令后等它返回“授权成功”，不要让用户贴 token。
- access token 有效期 7200 秒。过期后脚本自动 `lxctl auth refresh`（不需要浏览器，2026-11-11 实测）；refresh 也失败时脚本报 `TOKEN_REJECTED`，这时再请用户重新 `lxctl auth login`。
- 升级：重跑上面的 `npm install -g`。官方安装指南见飞书《lxctl CLI 使用手册》，它用 `nrm use` 切换全局源，本仓库不这么做。

## 用法

```bash
# 安装/登录状态；--probe 额外发一次真实请求
node scripts/lxctl_gateway.js doctor --probe

# PromQL 即时查询（雷神 /api/eye，app id 固定 eye）
node scripts/lxctl_gateway.js eye --query 'max(old_gen_mem_ratio{app="server_credit_api",env="prod"}) by (ident)'

# 任意已登记的网关接口
node scripts/lxctl_gateway.js call --method POST --path /ai/archLog/page --app-id arch_log_service --body '{"app":"...","start":0,"end":0,"filterType":1,"limit":1,"page":1}'
node scripts/lxctl_gateway.js call --path /api/schema --app-id lxctl_cli        # 列出网关登记的全部接口
```

退出码：0 成功；1 调用或参数错误；2 找不到 agent-tools 仓库根；3 未登录或 token 被拒（`doctor` 未登录、探测失败时也是 3）。错误以 JSON `{error, code}` 写到 stderr，`code` 取值：

| `code` | 含义 | 处理 |
|---|---|---|
| `NOT_LOGGED_IN` | `~/.lxctl/tokens.json` 不存在 | 按“安装与登录”执行 |
| `TOKEN_REJECTED` | token 被网关拒绝且 refresh 失败或 refresh 后仍被拒 | 请用户重新 `lxctl auth login` |
| `FORBIDDEN` | `--app-id` 无权访问该路径（网关 retcode `16051009`） | 核对接口登记的 `authorizedAppIds`，不换别的 app id 碰运气 |
| `UPSTREAM_FAILED` | 网关背后的服务 502/503/504，重试后仍失败 | 稍后重试或换通道，如实报告 |
| `NETWORK` | 连接失败或在 `--timeout`（默认 60000 ms）内无响应，重试后仍失败 | 检查零信任；缩小查询范围 |
| `BAD_RESPONSE` | 返回的不是 JSON | 原样报告前 200 字符 |

网关背后的服务自己的 `retcode`（例如日志服务的 `-1 查询日志出错！`）不算网关错误，`callGateway()` 原样返回给调用方判断。

## 已登记的接口（2026-11-11 `GET /api/schema`）

| 路径 | `--app-id` | 用途 | 本仓库入口 |
|---|---|---|---|
| `POST /ai/archLog/page` | `arch_log_service` | 应用日志检索 | `query-app-logs` 的 `log_platform_query.js`（默认走这里） |
| `GET /api/eye?query=<PromQL>` | `eye` | 雷神指标即时查询 | 本 skill 的 `eye` 子命令 |
| `/ai/bianque/getProvidersByCondition` | `bianque` | 按应用名查 Dubbo 对外接口与方法 | 未接入；现用 `query-dubbo-registry` |
| `/ai/lexiao/application/list`、`/ai/lexiao/version/list`、`/ai/lexiao/application/resourceSummary` | `server_oa_lexiao` | 乐效应用、版本、资源统计 | 未接入；现用 `query-app-instances`、`clone-app-repo` |
| `/ai/yichao/selectAllByAppIdAndType`、`/ai/yichao/selectBelongByApiId` | `yichao` | 接口文档 | 未接入 |
| `/ai/quickbi/*` | `quickbi` | 乐 BI 取数 | 未接入 |

“未接入”的接口只验证过出现在 schema 里，参数和返回没有实测；要用时先 `call` 一次看返回，再决定是否写进对应 skill。

## 指标即时查询

`eye` 是 Prometheus instant query：返回 `{resultType, result[]}`，每个序列一个当前值，没有时间范围参数。要看趋势用 PromQL 的区间函数（`max_over_time(x[1h])`、`rate(x[5m])`、`increase(x[1h])`），要看大盘配置和多面板对照用 `inspect-healthy-jvm-dashboard`。

| 指标 | 含义 |
|---|---|
| `old_gen_mem_ratio`、`old_gen_mem_used`、`eden_gen_mem_used` | 老年代使用率（%）、老年代与 Eden 使用量（字节） |
| `jmxmon_heap_memory_used`、`jmxmon_heap_memory_max` | 堆使用量与上限（字节） |
| `g1_young_generation_gc_count`、`g1_old_generation_gc_count`、`gc_throughput` | G1 Young/Old GC 次数、GC 吞吐率（%） |
| `thread_active_count`、`thread_peak_count` | 活跃线程数、线程峰值 |
| `<应用名>_provider_monitor_acc_count`、`<应用名>_consumer_monitor_avr_cost_time` | Dubbo 提供方调用量、消费方平均耗时 |

常用标签：`app`（应用名）、`env`（`prod`/`pre`/`gray`/`stable`/`project`）、`ident`（实例 IP）、`set`。实测 `old_gen_mem_ratio{app="server_credit_api",env="prod"}` 返回每台机器一条序列；同一应用 `env="stable"` 的 `thread_active_count` 返回空结果，空结果只说明该标签组合当前没有序列，不说明应用没有部署。

## 给其他脚本复用

```js
const gateway = require(skillDir('lxctl-gateway', 'scripts', 'lxctl_gateway.js'));
if (gateway.readToken()) {
  const json = await gateway.callGateway({ method: 'POST', path: '/ai/archLog/page', appId: 'arch_log_service', body, timeoutMs: 90000 });
}
const data = await gateway.eyeQuery('thread_active_count{app="x",env="prod"}');
```

- 调用方自己判断服务返回的 `retcode`；`GatewayError`（带 `code`）只表示网关通道不可用，适合作为回退到其他通道的条件。
- 模块加载时不读 token、不联网，可以在没有装 `lxctl` 的机器上被 `require`。
