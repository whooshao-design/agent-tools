---
name: test-dubbo-api
description: 通过 bianque 服务模拟器 HTTP 接口调用和编排 Dubbo 服务测试。支持从项目配置提取 Dubbo 元信息、按 targets.json 复用 IP:Port、自动获取 Cookie、区分 stable/pre 环境，并用 JSON 场景复用多接口验收流程。
version: 1.1.0
---

# Dubbo 接口测试

## 核心原则

- **服务元信息从代码中自动提取**：Dubbo 接口名、group、version 从项目配置文件读取
- **部署地址从 targets.json 读取默认值**：`/home/joney/projects/ai/claude-code-skills/java-backend/skills/test-dubbo-api/targets.json` 存储各应用各环境的 IP:Port，优先使用默认配置
- **调用端点是 /request，不是 /requestParams** — 混用会导致返回空或 `types: []`，务必注意
- **支持本项目和外部项目**：当前项目自动提取，外部项目手动指定

## 环境预置配置

| 环境 | 服务模拟器 URL | `env` 参数值 |
|------|---------------|-------------|
| Stable | `https://stable-bianque.lexinfintech.com` | `prj` |
| 预发布 | `https://bianque.lexinfintech.com` | `pre` |

## IP:Port 默认配置

读取 `/home/joney/projects/ai/claude-code-skills/java-backend/skills/test-dubbo-api/targets.json`：

```json
{
  "<app_name>": {
    "stable": { "ip": "10.x.x.x", "port": 31104 },
    "pre":    { "ip": "10.x.x.x", "port": 31104 }
  }
}
```

- 首次调用某应用/环境时，文件中没有对应条目，由用户提供 IP:Port
- **回写前探活**：用户提供新 IP:Port 后，先用 `curl -s --max-time 5 <IP>:<PORT>/` 验证可达，探活失败则不回写，提示用户重新输入
- 调用成功后，将探活通过的 IP:Port 回写到 targets.json

## 用户每次需提供的信息

| 信息 | 默认来源 | 何时需手动提供 |
|------|---------|--------------|
| **环境** | — | 每次指定 |
| **应用名** | 当前项目自动识别 | 外部项目时指定 |
| **目标 IP:Port** | `targets.json` 默认值 | 首次使用该应用/环境，或选择覆盖默认值时 |
| **Cookie** | `dubbo_request.py` 自动从浏览器 profile 获取 | 自动获取失败时重新登录 |
| **Dubbo 接口** | 项目 dubbo-provider.xml | 外部项目时手动输入 |
| **方法名 + 参数** | — | 每次指定 |

## Cookie 管理

### 自动获取（推荐）

固定脚本默认通过 `get-browser-session` 从 `/home/joney/.codex/lexiao-browser-profile` 获取 bianque Cookie。需要单独检查登录态时使用：

```bash
node /home/joney/projects/ai/claude-code-skills/java-backend/skills/get-browser-session/scripts/browser_session.js \
  --url=https://stable-bianque.lexinfintech.com \
  --cookies \
  --domain=stable-bianque.lexinfintech.com \
  --profile=/home/joney/.codex/lexiao-browser-profile
```

如果默认 profile 登录态不可用，打开 headed 浏览器让用户完成 SSO/MOA 登录；不要在聊天中索要密码、OTP 或 Cookie。

### 手动获取

如果自动获取失败，手动复制：打开对应环境的服务模拟器页面 → F12 → Application → Cookies → 复制 `JSESSIONID` 和 `ltrace_sessionId`。

Cookie 保存在会话上下文中，过期时可自动或手动重新获取。

## 工作流程

### 步骤 1：收集参数

1. **环境** — 问：stable 还是预发布？
2. **应用名** — 当前项目自动识别，否则询问
3. **IP:Port** — 查 `targets.json` 中 `<app>.<env>` 的默认值：
   - 有默认值：「使用默认 IP:Port `<ip>:<port>`？直接回车确认，或输入新的 IP:Port 覆盖」
   - 无默认值：「请从服务模拟器页面搜索接口名，提供可用提供者的 IP 和 Port」
4. **Dubbo 接口 + 方法 + 参数** — 当前项目列出可用接口供选择，外部项目手动输入
5. **Cookie** — 固定脚本自动从浏览器 profile 获取；失败时让用户在打开的浏览器里重新登录 bianque，再重试固定脚本。

### 步骤 2：调用单个接口

优先使用固定脚本，避免重复写 Cookie 获取和 `/request` 表单逻辑：

```bash
python3 /home/joney/projects/ai/claude-code-skills/java-backend/skills/test-dubbo-api/scripts/dubbo_request.py \
  --env stable \
  --service '<SERVICE>' \
  --method '<METHOD>' \
  --app '<APP_NAME>' \
  --group '<GROUP>' \
  --version '<VERSION>' \
  --params '<JSON_ARRAY>'
```

目标地址可以用 `--app` 从 `targets.json` 读取，也可以直接传 `--ip '<IP>' --port '<PORT>'`。默认 profile 使用 `/home/joney/.codex/lexiao-browser-profile`。如果需要换浏览器登录态，传 `--profile=<profile-dir>`；如果已经有 Cookie，传 `--cookie='<COOKIE>'`。

手工 curl 仅作为脚本不可用时的备用：

```bash
# 参数 URL 编码
python3 -c "import urllib.parse; print(urllib.parse.quote('<JSON_ARRAY>'))"

# 调用（注意是 /request，不是 /requestParams）
curl -s --max-time 60 '<BASE_URL>/serviceEmulator/request' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -b '<COOKIE>' \
  -H 'Origin: <BASE_URL>' \
  -H 'Referer: <BASE_URL>/' \
  --data-raw 'env=<ENV>&service=<SERVICE>&ip=<IP>&port=<PORT>&group=<GROUP>&version=<VERSION>&method=<METHOD>&params=<ENCODED_PARAMS>&comment=&stringFlag=false'
```

格式化返回：`| python3 -m json.tool`

常见异常：
- `status: 221011` → 测试权限未申请或已过期
- 空返回 → Cookie 过期或 IP:Port 不对
- `status: 0, types: []` → 误用了 `/requestParams` 端点，请改用 `/request`

### 步骤 3：反馈

汇总接口返回结果，判断执行是否成功。异常时分析原因并给出建议。

如需查看服务器日志或 Java 应用服务器状态，使用 `/java-server-diagnostics` skill。

## 多步骤接口验收

当一次测试需要造数据、调用业务接口、查询副作用、最后清理数据时，优先使用通用场景脚本，不要为单个业务接口新增专用 Python：

```bash
python3 /home/joney/projects/ai/claude-code-skills/java-backend/skills/test-dubbo-api/scripts/dubbo_scenario.py \
  --scenario /tmp/scenario.json \
  --env stable \
  --target service_a=<IP>:<PORT> \
  --target service_b=<IP>:<PORT>
```

场景文件使用 JSON，支持 `targets`、`vars`、`steps`、`cleanup`、变量替换 `{{var}}`、响应字段提取和基础断言：

```json
{
  "name": "generic dubbo smoke",
  "env": "stable",
  "defaults": {"group": "default", "version": "2.0.0", "timeout": 120},
  "targets": {
    "service_a": {"ip": "<IP>", "port": "<PORT>"}
  },
  "vars": {
    "requestId": "case-001"
  },
  "steps": [
    {
      "name": "call target method",
      "target": "service_a",
      "service": "com.example.Service",
      "method": "methodName",
      "params": [{"requestId": "{{requestId}}"}],
      "assert": [{"path": "data.errcode", "equals": 0}],
      "extract": {"result": "data.result"}
    }
  ],
  "cleanup": []
}
```

脚本约定：

- `type=dubbo` 为默认步骤；也支持 `{"type":"sleep","seconds":1}`。
- `--var name=value` 覆盖 `vars`；`--target name=ip:port` 覆盖目标地址。
- `assert` 支持 `equals`、`notEquals`、`exists`、`contains`、`notContains`、`truthy`、`falsey`、`in`、`regex`。
- 主流程失败后仍会执行 `cleanup`；清理失败只记录在结果中。
- 用 `--dry-run` 预览参数替换后的调用内容，用 `--no-cleanup` 跳过清理。

## Dubbo 元信息发现

当前项目优先从 `src/main/resources/**/dubbo-provider.xml`、Spring XML、Java Config 或接口定义中提取 `service`、`group`、`version` 和方法签名。

不要把某次业务接口、测试数据、Redis key 或固定 IP 写进 skill；这些内容放到临时 scenario JSON、用户上下文或 `targets.json`。

## 关联 skill

- `/redis-query` — Redis 数据只读查询（使用 DevService.queryRedis，支持 fetchData/fields 参数）
- `/java-server-diagnostics` — 通过堡垒机查看 Java 应用服务器状态和日志
