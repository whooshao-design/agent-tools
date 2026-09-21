---
name: query-app-instances
description: 通过乐效只读查询应用在各环境的虚拟机和容器实例地址。Use when 用户要求查应用服务器 IP、容器/Pod 地址、某应用线上/灰度/预发布/OA/稳定实例清单、需要为日志排查或部署验证定位机器；未指定应用名时从当前目录 app.properties 的 application.name 推断，未指定环境时默认预发布 pre。
metadata:
  version: 1.1.1
---

# query-app-instances

## 定位

只读查询乐效应用实例清单，解决“应用名 -> 各环境 VM/KVM IP 与容器 Pod 地址”的发现问题。它不负责部署、重启、停用、发布、审批，也不直接查看服务器日志；拿到 IP 或 `login_pod_addr` 后，再交给 `java-server-diagnostics` 做日志诊断。

MCP 暂无专用实例发现工具，使用固定脚本兜底。脚本复用本机 Playwright/Chromium 登录态访问乐效，不保存、不输出 Cookie。

## 默认规则

- 未指定应用名：从当前工作目录递归查 `app.properties`，读取 `application.name`。
- 未指定环境：默认 `pre`，即预发布环境。
- 未指定实例类型：默认同时查 VM/KVM 和容器 Pod。
- 默认浏览器 profile：脚本依次尝试 `/home/joney/.local/state/agent-tools/browser-profiles/healthy`、`~/.local/state/agent-tools/browser-profiles/main`。
- 访问乐效内网域名时，脚本只在自身 Chromium 子进程中清除 VPS 代理并设置 `NO_PROXY`；不修改当前 shell、系统代理或用户 Chrome 配置。
- 如果登录态不可用，先使用 `get-browser-session` 刷新乐效登录态；不要向用户索要 Cookie、密码或 OTP。

## 快速使用

在用户当前项目目录执行默认查询：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/query-app-instances/scripts/query_app_instances.js
```

常用参数：

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/query-app-instances/scripts/query_app_instances.js \
  --app server-hawk-decision-executor-simulate \
  --env prod \
  --type all

node /home/joney/projects/ai/agent-tools/skills/lexin/query-app-instances/scripts/query_app_instances.js \
  --app-id 5286 \
  --env pre \
  --json

node /home/joney/projects/ai/agent-tools/skills/lexin/query-app-instances/scripts/query_app_instances.js \
  --cwd /home/joney/projects/backend/hawk/server_hawk_decision_executor \
  --env pre,gray \
  --type vm
```

参数说明：

- `--app`：乐效应用名、`app_name` 或 `project_name`。
- `--app-id`：乐效应用 `fid/app_id`，已知 ID 时优先用它。
- `--env`：`pre|prod|gray|oa|stable|all`，支持中文别名。
- `--type`：`all|vm|pod`，支持 `machine/container` 等别名。
- `--json` / `--format=json`：输出完整结构，包含 `login_pod_addr`。
- `--show-login-url`：table 输出时也展示容器登录地址，可能很长。
- `--profile`：指定已登录乐效的浏览器 profile。

## 工作流

1. 明确 app 和 env：
   - 用户给 `--app` 或 `--app-id` 时直接使用。
   - 用户没给应用名时，保持当前工作目录为用户项目目录，或显式传 `--cwd`。
   - 用户没给环境时不要询问，按 `pre` 查。
2. 运行固定脚本，不临时改写查询脚本。
3. 如果脚本报未登录，使用 `get-browser-session` 打开乐效页面刷新登录态，再重跑脚本。
4. 输出结果时说明：
   - app 名、fid、project_name。
   - 查询环境和 VM/Pod 数量。
   - VM 的 `ip/set/run_status/app_version/jdk_version`。
   - Pod 的 `pod_name/pod_ip/host_ip/namespace/pod_status/version/container`。
   - `login_url_source` 和 `login_url_validation`；有效地址的来源必须是乐效 `login_pod_addr`。
   - 后续看日志时使用 VM `ip` 或 Pod 的 `login_pod_addr`；若用户只给 app+env，可直接交给 `java-server-diagnostics` 的 `container_log_check.js`。

## Pod 登录地址规则

- `login_pod_addr` 是 WebShell 登录地址的权威来源。校验通过后原样交给下游，不重新排列参数，也不按模板覆盖。
- 当前标准 URL 必须使用 `https://webshell.oa.fenqile.com/`，并包含 `ns/pod/container/cluster/command`；这些字段会与 Pod 元数据交叉校验。
- 兼容乐效旧版 `arg` 地址，但标记 `mode=legacy-arg` 和 `LEGACY_ARG_NOT_FIELD_VERIFIABLE`，不声称已核验内部字段。
- 乐效未返回登录地址时，输出 `login_url_source=missing` 和 `LOGIN_URL_MISSING`，不根据应用名猜测 container 或生成 URL。
- `container` 优先取乐效独立字段；若接口未单独返回，仅从已校验的标准 `login_pod_addr` 中提取。

## API 参考

需要排查接口字段或扩展脚本时读取：

`/home/joney/projects/ai/agent-tools/skills/lexin/query-app-instances/references/lexiao-app-instances-api.md`

已验证的核心接口：

- 应用搜索：`POST /oa/publish/application/list_simple_app.json`
- 应用详情：`POST /oa/publish/application/get.json`
- 环境列表：`POST /oa/publish/appmachine/listAppMachineEnvs.json`
- VM/KVM：`POST /oa/publish/appMachine/getAppMachineDistinct.json`
- 容器 Pod：`GET /oa/publish/devops/pod/getAppPodInfo.json`
- JDK 补充：`POST /oa/publish/appops/get_app_jdkversion.json`

## 安全边界

- 只执行只读查询，不点击或调用保存、部署、重启、停用、同步线上版本、批量操作等动作。
- 不把 Cookie、ticket、token 写入文件、命令输出或最终回复。
- 遇到多个应用匹配时，列出候选并让用户确认，不要猜。
- 查询到生产环境实例只表示实例发现成功，不代表可以对生产执行登录、重启、部署或修改操作。
