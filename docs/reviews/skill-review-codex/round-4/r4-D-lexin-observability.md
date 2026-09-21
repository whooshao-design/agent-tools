# lexin 观测与诊断 第 4 轮报告

## 1. 总体判断

本批次不可收敛：本轮待复核的 5 个 ID 均已关闭，但新增 1 条此前漏报的 High。  
第 3 轮采纳的修复已实际生效：日志完成状态检查、注册中心完整性传递、告警重定向限制和缺失字段断言均已补齐。  
剩余风险位于指标注册入口：跨源重定向仍会携带 Bearer 凭据。  
6 个相关 JS 测试文件及 2 个 Python 用例通过；另完成离线模拟，未访问内网、未修改文件，未执行 WebShell 全量测试。  
做得好、不要动：大盘备份与写后回读、拓扑默认关闭异常下钻、Pod 登录地址交叉校验。  
以下路径相对于 `/home/joney/projects/ai/agent-tools/skills/lexin/`；已忽略指定的 ClickHouse 未跟踪文件。

## 2. 旧 finding 处置核对

| ID | 状态 | 证据（文件:行号 + 一句话） |
|---|---|---|
| D-02 | 已关闭 | `diagnose-healthy-alert/SKILL.md:131` 已同时要求“`completed=true`、`errorCode` 为空”及 `fileCount>0、matchedEvents=0、truncated=false`，传输中断不再满足无命中判定条件。 |
| D-05 | 已关闭 | `inspect-app-call-topology/scripts/inspect_call_topology.js:351` 保存 `ctx.registryTruncated`，`:1151` 接收目标字段，`:1220` 合并到报告模型，`:925` 输出 `registry_truncated`；离线运行真实 main，确认下游兜底和 service 反查两条路径均保留 `true`。 |
| D-17 | 已关闭 | `diagnose-healthy-alert/scripts/diagnose_alert.js:120` 从链接选择站点并校验环境冲突，`:724` 输出实际 `env/baseUrl`；离线确认 stable 链接仍解析为 stable，关联的 D-2-01 也已关闭。 |
| D-2-01 | 已关闭 | `diagnose-healthy-alert/scripts/diagnose_alert.js:108` 限制初始链接来源，`:290` 比较重定向前后 origin；离线模拟跨源 302 后直接拒绝，未发出第二次携带凭据的请求。 |
| D-3-01 | 已关闭 | `test-dubbo-api/scripts/dubbo_scenario.py:172` 改为 `actual is not marker and bool(actual)`，`:176` 同时保护 `in`；新增断言测试通过，缺失字段不再通过 `truthy` 验收。 |

## 3. 对拒绝 / 部分采纳项的表态

| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |
|---|---|---|
| — | 不适用 | 第 3 轮 `audit.md` 对 D 批次全部采纳，没有拒绝或部分采纳项；D-17 的关联修复随 D-2-01 核对。 |

## 4. 新 findings

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| D-4-01 | register-healthy-metrics | `register-healthy-metrics/scripts/register_metrics.js:299`、`:316`、`:318` | High | 凭据边界 | agent 按正式脚本查询或注册指标时，若 Healthy 接口返回跨源重定向，脚本会把 Bearer 凭据发送给新来源；告警入口的修复未覆盖此入口。这是此前漏报，非本轮新增回归。 | `headers.authorization = ...`；重定向分支直接执行 `return requestJson(method, nextUrl, token, args, body, ...)`。离线模拟合法 Healthy 地址返回 `Location: https://outside.example/next`，确认第二次请求仍携带模拟 Bearer。 | 在递归请求前比较 origin，跨源直接拒绝；补跨源重定向不得发出第二次请求的离线用例。 | 确认 |

## 5. 收敛判断

不可收敛：D-4-01。

## 6. JSON

```json
{
  "batch": "D",
  "closed": ["D-02", "D-05", "D-17", "D-2-01", "D-3-01"],
  "partial": [],
  "open": [],
  "regressions": [],
  "disagree": [],
  "new_findings": [
    {
      "id": "D-4-01",
      "skill": "register-healthy-metrics",
      "location": "skills/lexin/register-healthy-metrics/scripts/register_metrics.js:299; skills/lexin/register-healthy-metrics/scripts/register_metrics.js:318",
      "severity": "High",
      "summary": "指标注册脚本跟随跨源重定向时继续转发 Bearer 凭据。",
      "fix": "递归请求前比较 origin，跨源直接拒绝，并补不得发出第二次请求的离线用例。"
    }
  ],
  "converged": false
}
```
