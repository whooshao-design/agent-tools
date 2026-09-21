# lexin 观测与诊断 第 5 轮报告

## 1. 总体判断

本批次不可收敛：D-4-01 已关闭，但发现 1 条此前漏报的 High，涉及两个 Python HTTP 入口。  
第 4 轮修复确实阻止了指标注册请求跨源转发 Bearer；未发现该修复引入回归。  
剩余风险是字段引用查询和 Dubbo HTTP 调用在跨源重定向时转发 Cookie。  
8 个相关 JS 测试文件通过；另完成两个 Python 入口的离线重定向模拟，未访问内网、未修改文件，未运行 WebShell 全量测试。  
做得好、不要动：大盘备份与写后回读、拓扑默认关闭异常下钻、Pod 登录地址交叉校验。  
以下路径相对于 `/home/joney/projects/ai/agent-tools/skills/lexin/`；已忽略指定的 ClickHouse 未跟踪文件。

## 2. 旧 finding 处置核对

| ID | 状态 | 证据（文件:行号 + 一句话） |
|---|---|---|
| D-4-01 | 已关闭 | `register-healthy-metrics/scripts/register_metrics.js:313` 使用 `redirect: 'manual'`，`:319` 在递归前比较 origin，跨源直接抛错；`register-healthy-metrics/tests/redirect_guard.test.js:11` 的离线测试确认跨源只发一次请求，同源仍可跟随。 |

## 3. 对拒绝 / 部分采纳项的表态

| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |
|---|---|---|
| — | 不适用 | 第 4 轮审核对 D-4-01 为采纳，本批次没有拒绝或部分采纳项。 |

## 4. 新 findings

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| D-5-01 | query-hawk-field-reference、test-dubbo-api | `query-hawk-field-reference/scripts/hawk_field_ref.py:103`、`:111`；`test-dubbo-api/scripts/dubbo_request.py:239`、`:246` | High | 凭据边界 | agent 使用字段引用脚本兜底，或使用 Dubbo 的 `--transport=http` 时，若接口返回跨源 302，默认重定向处理会将原始 Cookie 发给新来源。这是此前漏报，非本轮回归。 | 两处分别设置 `"Cookie": config.cookie`、`"Cookie": cookie`，随后直接 `urllib.request.urlopen(...)`，没有重定向限制。离线调用真实入口，仅替换 HTTPS 传输、保留默认重定向处理；模拟返回 `Location: https://outside.example/next`，两个入口的第二次请求均携带占位 Cookie。Dubbo 的 POST 被改为 GET，但 Cookie 仍保留。 | 两处均在跟随重定向前拒绝跨源目标，并补“跨源不得发出第二次请求”的离线测试。 | 确认 |

## 5. 收敛判断

不可收敛：D-5-01。

## 6. JSON

```json
{
  "batch": "D",
  "closed": ["D-4-01"],
  "partial": [],
  "open": [],
  "regressions": [],
  "disagree": [],
  "new_findings": [
    {
      "id": "D-5-01",
      "skill": "query-hawk-field-reference,test-dubbo-api",
      "location": "skills/lexin/query-hawk-field-reference/scripts/hawk_field_ref.py:103; skills/lexin/query-hawk-field-reference/scripts/hawk_field_ref.py:111; skills/lexin/test-dubbo-api/scripts/dubbo_request.py:239; skills/lexin/test-dubbo-api/scripts/dubbo_request.py:246",
      "severity": "High",
      "summary": "字段引用查询和 Dubbo HTTP 入口跟随跨源重定向时转发原始 Cookie。",
      "fix": "两个入口均在跟随重定向前拒绝跨源目标，并补跨源不得发出第二次请求的离线测试。"
    }
  ],
  "converged": false
}
```
