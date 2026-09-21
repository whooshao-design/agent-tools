# lexin 观测与诊断 第 2 轮报告

## 1. 总体判断

本批次不可收敛：17 条旧 finding 中，14 条已关闭、2 条部分关闭、1 条改动引入新问题。  
Claude 的采纳记录与大多数修复一致，但日志空结果判断、注册中心完整性传递仍未消除执行风险。  
新增 1 条 High、2 条 Medium；主要风险是告警链接可改变携带凭据的请求目标。  
6 个相关测试文件通过；另做了离线模拟，未访问内网。WebShell AWK 探针超时，不计通过；相关判断依据源码与解析器模拟。  
做得好、不要动：大盘备份与写后回读、拓扑默认关闭异常下钻、Pod 登录地址交叉校验。  
以下路径均相对于 `/home/joney/projects/ai/agent-tools/skills/lexin/`；未修改文件，已忽略指定的未跟踪文件。

## 2. 旧 finding 处置核对

| ID | 状态 | 证据（文件:行号 + 一句话） |
|---|---|---|
| D-01 | 已关闭 | `test-dubbo-api/scripts/dubbo_request.py:171` 改为 `.get(deployment_env)`；离线确认 prod 读取 prod 地址，gray 缺项时拒绝借用 pre。 |
| D-02 | 部分关闭 | `diagnose-healthy-alert/SKILL.md:131` 仍将“`fileCount>0` 而 `matchedEvents: 0`”断言为无关键词；`java-server-diagnostics/scripts/webshell_log_check.js:321` 会丢弃超限事件，`:516` 只数返回事件，因此截断时仍会误判；应先要求查询完成且未截断，再判定查询范围内无命中。 |
| D-03 | 已关闭 | `query-app-logs/SKILL.md:50` 已明确“kubectl 路径读的是容器 stdout”；`java-server-diagnostics/scripts/container_log_check.js:286` 补上“error.log was not read as a file”，消除了快检已读文件的承诺。 |
| D-04 | 已关闭 | `inspect-app-call-topology/scripts/inspect_call_topology.js:1092` 多提供方改为报错并要求 `--app`，不再自动选择首项；对应测试通过，参数说明的剩余矛盾见 D-2-03。 |
| D-05 | 部分关闭 | `query-dubbo-registry/scripts/query_dubbo_registry.js:223` 已翻页并返回 `truncated`，但 `inspect-app-call-topology/scripts/inspect_call_topology.js:325` 仍只读取 `ownerMap`；离线输入 `truncated=true` 后标记消失，残缺候选仍被当作完整归属，应向报告透传不完整状态。 |
| D-06 | 已关闭 | `query-hawk-field-reference/scripts/hawk_field_ref.py:210` 非零错误码抛异常；原 `retcode=-1` 权限失败输入已无法产生正常空引用结果。 |
| D-07 | 已关闭 | `test-dubbo-api/SKILL.md:80` 明确“Cookie 只在脚本进程内使用”，失败后刷新同一 profile，删除了复制到会话的兜底。 |
| D-08 | 已关闭 | `diagnose-healthy-alert/SKILL.md:152` 改为“只能确认当前是否存在和剩余 TTL”，历史原因缺证据时记未知。 |
| D-09 | 已关闭 | `inspect-healthy-jvm-dashboard/scripts/inspect_dashboard.js:59` 要求返回 `backupDir`，`:61` 读取其中的 `before.json`；与 `healthy-dashboard-config/scripts/healthy_dashboard_config.js:260` 的保存位置一致。 |
| D-10 | 已关闭 | `diagnose-healthy-alert/scripts/diagnose_alert.js:202`、`inspect-healthy-jvm-dashboard/scripts/inspect_dashboard.js:177`、`register-healthy-metrics/scripts/register_metrics.js:275` 均精确读取 `access_token`。 |
| D-11 | 已关闭 | `inspect-healthy-metrics/scripts/inspect_metrics.js:305` 保存注册状态后继续查询；离线确认未注册指标发起 6 次 Prometheus 查询，返回 `registered=false,status=OK`。 |
| D-12 | 已关闭 | `register-healthy-metrics/scripts/register_metrics.js:190` 用显式 `app && desc` 跳过后缀推导；原非内置后缀输入已能生成注册计划。 |
| D-13 | 已关闭 | `query-app-logs/SKILL.md:55`、`:65`、`:73` 三个容器示例均显式传 main profile；`java-server-diagnostics/scripts/container_log_check.js:206` 保留向 WebShell 透传。 |
| D-14 | 已关闭 | `query-app-instances/SKILL.md:47` 已使用 `/home/joney/projects/backend/hawk/server_hawk_decision_executor`，本地目录存在。 |
| D-15 | 已关闭 | `healthy-dashboard-config/SKILL.md:3` 收窄为“修改已有”，`:10` 明确所有入口要求已有 board ID。 |
| D-16 | 已关闭 | `test-dubbo-api/SKILL.md:185` 已说明响应提取变量的预览限制及 `--var` 补值办法，与场景脚本行为一致。 |
| D-17 | 改动引入新问题 | `diagnose-healthy-alert/scripts/diagnose_alert.js:117` 已按链接选择站点，但接受任意来源；`:710` 又保留 `env: args.env \|\| 'prod'`，分别导致 D-2-01、D-2-02。 |

## 3. 对拒绝 / 部分采纳项的表态

| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |
|---|---|---|
| — | 不适用 | audit.md 的 D 批次全部标为“采纳”，没有拒绝或部分采纳项；修复不足已在上表记录。 |

## 4. 新 findings

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| D-2-01 | diagnose-healthy-alert | `diagnose-healthy-alert/scripts/diagnose_alert.js:103`、`:250`、`:276` | High | 凭据边界 | 新增链接推导接受任意 HTTP(S) 来源；agent 接到非 Healthy 域名的告警链接、且进程已有 `HEALTHY_METRIC_TOKEN` 时，会把凭据发送给该域名。 | `baseUrlFromAlertLink` 提取任意 origin，随后 `return fromLink`；离线拦截 `fetch`，输入 `https://outside.example/alert-show-detail/42`，确认请求带模拟 Bearer 发往 outside.example。 | 只允许两个已支持的 HTTPS origin；在读取凭据前拒绝其他来源，重定向同样限制来源。 | 确认 |
| D-2-02 | diagnose-healthy-alert | `diagnose-healthy-alert/scripts/diagnose_alert.js:710` | Medium | 输出契约 | 仅传 stable 告警链接时，请求正确但 JSON 声称来自 prod，消费结果的 agent 会错误标注证据环境。 | 原文 `env: args.env \|\| 'prod'`；离线运行完整 main，请求为 stable-eye，输出 `env="prod"`。 | 输出环境从最终解析的站点推导，并保留实际 `baseUrl`。 | 确认 |
| D-2-03 | inspect-app-call-topology | `inspect-app-call-topology/SKILL.md:93`；`scripts/inspect_call_topology.js:1092` | Medium | 指令自洽 | 多提供方修复要求补 `--app`，正文却要求它与 `--service` 二选一；agent 为遵守正文删除 service 后，会把单接口查询扩大为整个应用。 | 正文“与 `--service` 二选一”；新增报错“请用 `--app=<应用>`”；`scripts/inspect_call_topology.test.js:180` 正确恢复路径实际同时传两者。 | 修改参数表该行，明确两者可同时传，分别限定应用和服务。 | 确认 |

## 5. 收敛判断

不可收敛：D-02、D-05、D-17（对应 D-2-01、D-2-02）、D-2-03。

## 6. JSON

```json
{
  "batch": "D",
  "closed": [
    "D-01", "D-03", "D-04", "D-06", "D-07", "D-08", "D-09",
    "D-10", "D-11", "D-12", "D-13", "D-14", "D-15", "D-16"
  ],
  "partial": ["D-02", "D-05"],
  "open": [],
  "regressions": ["D-17"],
  "disagree": [],
  "new_findings": [
    {
      "id": "D-2-01",
      "skill": "diagnose-healthy-alert",
      "location": "skills/lexin/diagnose-healthy-alert/scripts/diagnose_alert.js:103",
      "severity": "High",
      "summary": "告警链接可将携带环境变量 Bearer token 的请求导向任意来源。",
      "fix": "链接及重定向仅允许已支持的 HTTPS origin，在读取凭据前校验。"
    },
    {
      "id": "D-2-02",
      "skill": "diagnose-healthy-alert",
      "location": "skills/lexin/diagnose-healthy-alert/scripts/diagnose_alert.js:710",
      "severity": "Medium",
      "summary": "仅传 stable 链接时请求 stable，JSON 环境仍为 prod。",
      "fix": "输出环境从最终站点推导，并保留实际 baseUrl。"
    },
    {
      "id": "D-2-03",
      "skill": "inspect-app-call-topology",
      "location": "skills/lexin/inspect-app-call-topology/SKILL.md:93",
      "severity": "Medium",
      "summary": "app/service 二选一的说明与多提供方恢复路径要求同时传参矛盾。",
      "fix": "明确 app 与 service 可同时传，分别限定应用和服务。"
    }
  ],
  "converged": false
}
```
