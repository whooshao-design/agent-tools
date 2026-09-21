---
name: jenkins-pipeline-fix
description: 诊断或修复 Jenkins 流水线失败。Use when 用户给出构建 URL 或在当前 Git 仓库里要求定位失败阶段、看 console 与测试报告；默认只读诊断，用户要求修复时才改代码，提交和推送分别遵循已有授权。
metadata:
  version: 2.1.1
---

# Jenkins 流水线诊断与修复

## 定位与执行范围

MCP 优先、脚本/HTTP 兜底。使用 `jenkins` MCP 查询；本 skill 不触发部署，不默认重跑 Jenkins 构建。

| 参数 | 默认 | 规则 |
|---|---|---|
| mode | auto | diagnose / fix-tests / fix-build / auto |
| job_url | 从上下文推断 | 用户指定的构建优先 |
| wait | true | 运行中可等待；用户只问当前状态时立即交付 |
| fix | false | “修复/让它过”才允许改代码；“为什么失败”只诊断 |
| push | false | 提交、推送均需相应授权，不能由 auto 模式开启 |

`auto` 根据用户任务和失败阶段选择；已授权的修复不重复确认。新增权限、超出任务的业务行为变更或
缺少决定性信息时才请求补充。其他失败阶段也先查证根因，不因为标签不在固定列表就提前结束分析。

## 固定构建身份

1. 有具体构建 URL 时直接使用，例如
   `https://devops-jenkins.oa.fenqile.com/job/<pipeline>/<number>/`。
2. 未给 URL 时用 `infer_feature_pipeline(repo_dir=...)` 从当前 Git 仓库推断
   `feature-pipeline-<project>-<branch>`；不存在时再查流水线名称或向用户获取缺失信息。
3. 仅有 job 根路径时，首次 `get_build_status` 可用 `build=lastBuild`。
   取得返回的数字 `number` 与 `url` 后固定该构建。后续阶段、console、测试报告与等待
   都传同一数字 build，或同一具体构建 URL，不能继续跟随会变化的 `lastBuild`。
4. 用户要求“最新构建”时也记录本次解析的数字；如果明确切换目标，标明新旧构建，不能混用证据。

## 查询与认证

使用以下 MCP 工具，均绑定上一节固定的构建：

- `get_build_status`：result、building、number、url、timestamp、duration。
- `get_pipeline_stages`：定位实际首个失败阶段；区分 FAILED 与上游失败造成的跳过。
- `get_console_summary`：错误摘要。摘要缺少根因时再读取完整 console 的相关窗口。
- `get_testng_summary`：失败用例与报告；没有 TestNG 报告时检查该仓库真实测试布局和 console。

MCP 从本地环境或 `mcp/devtools-mcp/.env` 读取 `JENKINS_COOKIE` 或
`JENKINS_USER` + `JENKINS_TOKEN` / `JENKINS_API_TOKEN`。
401/403 先区分未登录与当前账号无权限；可复用 `get-browser-session` 的已登录请求。
不要要求用户把认证值贴到聊天，不在命令参数或日志输出凭据。

HTTP 兜底使用同一具体构建根 `<BUILD_URL>`：

| 证据 | 路径 |
|---|---|
| 状态 | `<BUILD_URL>/api/json?tree=result,building,displayName,number,url,timestamp,duration` |
| 阶段 | `<BUILD_URL>/wfapi/` |
| 日志 | `<BUILD_URL>/consoleText` |
| TestNG | `<BUILD_URL>/testngreports/api/json` |

普通请求限时 30 秒，console 可 60 秒。需要本地证据文件时使用 `mktemp -d` 独立目录，
不要共用固定 `/tmp/jenkins_log.txt`。报告引用文件路径并只摘录相关、已脱敏的日志。

## 等待与诊断

`building=true` 且需要等待时，每 30–60 秒检查同一构建，期间保持可中断和用户进度反馈。
默认等待预算 30 分钟；用户明确要求等到结束时按其终止条件持续推进。预算用尽时报告仍在运行，
不能把未知状态判为失败。不要执行阻塞整轮的长 shell 循环。`wait=false` 时只报告当前状态。

按证据区分 checkout/权限、依赖或编译、单测、质量扫描、部署/上传等根因。
保留失败阶段、关键异常链、受影响模块与修复建议；诊断请求到此交付，不进入改代码流程。

## 修复与验证

仅当用户要求修复时：

1. 阅读失败用例、实现和仓库构建约定；可复现时先用最小命令复现。
2. 区分实现错误、过期断言、兼容要求和环境缺失。不能为了变绿而修改正确断言，
   也不能把需要真实环境的集成测试机械改为 mock。
3. 单测修复按实际 Surefire/TestNG/suite 规则运行目标用例；示例
   `mvn test -pl <module> -Dtest=<Class>#<method>` 仅在仓库支持该发现方式时使用。
4. 编译修复优先受影响模块，必要时 `mvn -pl <module> -am compile`；按失败命令重验。
5. 只有新变化、失败或相关风险需要时扩大回归。保留用户已有改动。

本地通过不代表远端 Jenkins 已通过。用户已授权提交/推送/重跑时继续完成相应步骤并验证新构建；
否则交付本地结果，不把修复请求推定为外部写入授权。

## 输出

给出固定构建 URL/编号、状态、失败阶段、关键证据、根因与下一步。
有修复时追加实际变更、验证命令和结果、未覆盖内容、提交/推送/远端重跑状态。
不要只报“已修复”，也不要把未执行的远端构建写成通过。
