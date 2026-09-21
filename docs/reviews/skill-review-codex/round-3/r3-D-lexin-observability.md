# lexin 观测与诊断 第 3 轮报告

## 1. 总体判断

本批次不可收敛：本轮复核的 6 个 ID 中，2 个已关闭、3 个部分关闭、1 个改动引入新问题。  
Claude 全部标为“采纳”，但日志完成状态、注册中心完整性传递和重定向凭据边界仍未修复完整。  
新增 1 条 High：Dubbo 场景验收的 `truthy` 断言会放过缺失字段。  
6 个相关测试文件通过；WebShell 测试执行挂起后终止，不计通过。另完成离线模拟，未访问内网、未修改文件。  
做得好、不要动：大盘备份与写后回读、拓扑默认关闭异常下钻、Pod 登录地址交叉校验。  
以下路径相对于 `/home/joney/projects/ai/agent-tools/skills/lexin/`；以第 2 轮报告为复核基准。

## 2. 旧 finding 处置核对

| ID | 状态 | 证据（文件:行号 + 一句话） |
|---|---|---|
| D-02 | 部分关闭 | `diagnose-healthy-alert/SKILL.md:131` 新增“且 `truncated=false`”，但仍未要求查询完成；`java-server-diagnostics/scripts/webshell_log_check.js:509` 会把缺失截断元信息转成 `false`。离线模拟连接在文件计数后中断，得到 `completed=false、fileCount=1、matchedEvents=0、truncated=false`，仍满足正文的“关键词不存在”条件；应先检查 `completed=true` 且无错误，并限定为查询范围内无命中。 |
| D-05 | 改动引入新问题 | `inspect-app-call-topology/scripts/inspect_call_topology.js:1139` 已传入 `registryTruncated`，但 `:1150` 的解构及 `:1203` 的报告模型遗漏它，`:924` 的 `Boolean(registryTruncated)` 因而输出 `false`；离线运行真实编排，输入 `completeness.truncated=true`，最终 JSON 为 `registry_truncated=false`。应贯穿报告模型，并保留 `:1089` 服务反查阶段的完整性结果。 |
| D-17 | 部分关闭 | `diagnose-healthy-alert/scripts/diagnose_alert.js:120` 已按链接选择站点，`:720` 改为 `env: envForBaseUrl(baseUrl), baseUrl`；stable 环境定位与标注已修复，但上轮关联的凭据问题 D-2-01 尚未完全关闭。 |
| D-2-01 | 部分关闭 | `diagnose-healthy-alert/scripts/diagnose_alert.js:108` 拒绝未知初始来源，但 `:288` 仍解析任意 `Location`，`:289` 执行 `requestJson(nextUrl, auth, ...)`；模拟合法 Healthy 地址返回跨域 302，后续请求仍携带模拟 Bearer 和 ticket。应拒绝跨源重定向，或直接禁用自动跟随。 |
| D-2-02 | 已关闭 | `diagnose-healthy-alert/scripts/diagnose_alert.js:114` 从最终站点推导环境，`:720` 同时输出 `baseUrl`；离线确认仅传 stable 链接时解析为 `env=stable`。 |
| D-2-03 | 已关闭 | `inspect-app-call-topology/SKILL.md:93` 明确“可与 `--service` 同时传”，与多提供方报错及测试中的恢复方式一致。 |

## 3. 对拒绝 / 部分采纳项的表态

| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |
|---|---|---|
| — | 不适用 | 第 2 轮 `audit.md` 中 D 批次全部为“采纳”，没有拒绝或部分采纳项；采纳后修复不完整的情况已逐条记录在上表。 |

## 4. 新 findings

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| D-3-01 | test-dubbo-api | `test-dubbo-api/SKILL.md:183`；`test-dubbo-api/scripts/dubbo_scenario.py:157`、`:171`、`:218` | High | 验收输出契约 | agent 使用声明支持的 `truthy` 验证成功字段时，响应缺失该字段仍会验收通过。 | 缺失路径返回 `marker = object()`，`truthy` 分支直接执行 `ok = bool(actual)`。离线输入响应 `{"data":{}}` 与断言 `{"path":"data.success","truthy":true}`，断言通过，真实 `run_step` 返回 `status="ok"`。 | `truthy` 先检查 `actual is not marker`，再判断真值；补缺失字段应失败的回归用例。 | 确认 |

## 5. 收敛判断

不可收敛：D-02、D-05、D-17（关联 D-2-01）、D-2-01、D-3-01。

## 6. JSON

```json
{
  "batch": "D",
  "closed": ["D-2-02", "D-2-03"],
  "partial": ["D-02", "D-17", "D-2-01"],
  "open": [],
  "regressions": ["D-05"],
  "disagree": [],
  "new_findings": [
    {
      "id": "D-3-01",
      "skill": "test-dubbo-api",
      "location": "skills/lexin/test-dubbo-api/scripts/dubbo_scenario.py:157; skills/lexin/test-dubbo-api/scripts/dubbo_scenario.py:171",
      "severity": "High",
      "summary": "truthy 断言把缺失字段的哨兵对象判为真，导致无成功字段的响应仍验收通过。",
      "fix": "truthy 先检查 actual is not marker，再判断真值，并补缺失字段应失败的回归用例。"
    }
  ],
  "converged": false
}
```
