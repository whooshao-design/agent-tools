---
name: fix-sonarqube-issues
description: 评估 SonarQube 新代码周期的 BLOCKER/CRITICAL 问题，真实问题修复、误报在服务端标记并写明理由。Use when 用户要求看 SonarQube 质量门禁、评估或修复 Sonar 问题、git push 被 Sonar 推送前检查拒绝、或要求把误报标记掉；按规则与代码证据区分真实问题、误报和无法确认的风险，修复后执行最小验证。只要求评估时不改代码也不改 issue 状态。
metadata:
  version: 1.4.0
---

# fix-sonarqube-issues

## 定位

处理当前任务范围内的 SonarQube 新代码问题。保留真实业务、日志与监控契约；不要为了消除告警而改变行为。
默认范围是未解决的 BLOCKER/CRITICAL。用户要求其他范围时明确记录；较高风险或架构变更先收敛方案，不盲改。

每条 issue 先判断是不是误报：不是误报就修代码，是误报就在 SonarQube 标记误报并写明理由，不为消告警改代码。
Sonar 的误报很常见（例如不认识工具类判空），把等价代码改写成它认识的样子只是绕过检查，还可能改变行为。

MCP 优先、脚本兜底。`sonarqube` MCP 支持项目解析、分页 issues、规则详情、质量门禁，以及用
`transition_sonarqube_issues` 标记误报/不修复。只要求评估时只读；用户要求处理或修复 Sonar 问题时，
修复真实问题、标记已确认的误报都在授权内。提交、推送、`wontfix`（接受风险）与 `NOSONAR` 抑制仍需单独授权。

## 输入与认证

从用户问题页 URL 或当前仓库上下文确认项目、分支或 PR、新代码周期。页面的 `id` 是 project key。
用 `parse_sonarqube_project` 解析基址；将返回的 `base_url` 显式传入后续工具，避免查询到默认站点的同名项目。

认证由 MCP 内部读取本地 `SONARQUBE_COOKIE` / `SONARQUBE_XSRF_TOKEN` 或复用浏览器 profile。
登录失效时通过 `get-browser-session` 续期；不要要求用户把 Cookie、token、完整认证 curl 粘贴到对话。
MCP 不可用时可在本机脚本内使用同一认证与 API；不要把凭据放入命令参数、日志或产物。

- 查询可以匿名，标记必须登录：浏览器 profile 只有 OA Cookie（`oa_session` 等）时读接口照常返回，
  `bulk_change` 返回 401 `Authentication is required`。先用 `get-browser-session` 的
  `--ensure --url=<base_url>/sessions/new --success-text=none` 走一次 OA 单点登录，确认出现
  `JWT-SESSION` 和 `XSRF-TOKEN` 后再标记，并把同一个 `profile` 传给工具。
- 报 `profile is busy: .../browser-profiles/main` 是另一个进程（常见是乐效构建脚本）占着 profile，
  不是认证失败：只读查询可改传 `profile=/home/joney/.local/state/agent-tools/browser-profiles/healthy`，
  标记要等 `main` 释放后用已登录 Sonar 的 profile。

## 查询与评估

`git push` 被 pre-receive hook 拒绝并提示"未通过编码规范检查"时，项目是 `project:git_push_check_<仓库名>`，
hook 输出里有 `analysisId` 和看板地址；用 `list_sonarqube_issues`（新代码周期、未解决）拉出这次拦截的 issue，
处理完再推一次。issue 的 `creationDate` 早于本次提交时，多半是旧 issue 因本次改动重新打开，先看历史修法。

用户问的是质量门禁时，先调 `get_sonarqube_quality_gate_status`（同一 `project_key`、`branch` 或 `pull_request`）拿到门禁状态与失败条件，按失败条件决定是否进入 issue 分析并在输出里报告门禁结论；只问 issue 时直接从第 1 步开始。

1. 调用 `list_sonarqube_issues`，固定 `project_key`、`base_url`、`branch` 或 `pull_request`，
   默认 `severities=BLOCKER,CRITICAL`、`in_new_code_period=true`、`resolved=false`。
   `limit` 是页大小，`page` 从 1 开始；按响应 `paging.total` / `total` 拉完本次范围，并按 issue key 去重。
   响应被标记截断时减小页大小；缺页或总数不一致时说明覆盖缺口，不能声称已处理全部问题。
2. 保存每个 issue 的 key、rule、component、line/textRange、message、severity、type 及分支/分析身份。
   去除 component 的项目 key 前缀后定位相对路径；核对行号是否仍与当前代码一致。
3. 按需读取 `show_sonarqube_rule` 与受影响代码、调用方、测试。文本搜索用于定位，不能把“出现至少两次”
   当作有效引用或误报证明；必须区分声明、注释、字符串、同名符号和实际访问。
4. 检查反射、序列化、Spring 注入、lambda/匿名类及日志监控契约等非显式引用。证据不足时记“待确认”，
   不能把不确定性变成“无需修复”。BUG/VULNERABILITY 仍可只读分析，修复依据实际风险决定。
5. 逐项判定：真实且修复安全 → 需修复；确有误报 → 标记误报；应保持既有行为但不是误报 → 报告给用户决定是否 `wontfix`；
   无法确认 → 待确认。误报要能写出"为什么这一行不会出问题"的代码证据，例如 `java:S2259` 在
   `StringUtils.isEmpty` / `CollectionUtils.isEmpty` 判空后 `continue`/`break`，解引用不可达，只是 Sonar
   没把该工具方法识别成判空；这类不要改写成 `x == null || x.isEmpty()` 来消告警。
   并发集合的 `size()` / `isEmpty()` 都可能只是瞬时观测，不把方法名当作原子性保证。
   常量重命名与常量值变化是不同问题；是否影响监控取决于输出值与消费契约，不能只凭命名推断。

## 标记误报

- 调 `transition_sonarqube_issues(issue_keys, transition="falsepositive", comment, base_url, profile)`。
  `comment` 写实际判断依据：哪一行做了什么判断、为什么被标记的那行不会出问题、Sonar 漏识别了什么；
  不写"误报"两个字了事。理由不同的 issue 分开调用，各写各的说明。
- 说明里不要放带引号的代码片段（如 `"".equals(str)`）：实测请求会被网关断开，报
  `SSL: UNEXPECTED_EOF_WHILE_READING`，改成自然语言描述（"入参为 null 或空串时返回 true"）即可。
- 网络错误后先用 `list_sonarqube_issues` 或回读确认状态再重试：`bulk_change` 每次都会追加一条评论，
  盲目重试会留下重复评论。工具返回 `verified=true` 且 `not_transitioned` 为空才算标记成功。
- 标记只改服务端状态，不改代码；推送前检查依赖同一项目的 issue 状态，标记后重新推送即可通过。

## 修复与验证

- 只修用户授权范围内、已确认的问题；按文件合并相关改动，复用已有实现。
- 删除字段前核对运行时引用；替换字面量前核对输出语义。保留字符串稳定值本身的业务约束。
- 先跑受影响模块的最小编译/测试；多模块 Maven 依仓库约定选择 `mvn -pl <module> -am compile`
  或已有测试入口。编译成功不能替代语义变化所需的行为验证。
- 验证失败时先定位原因；需要撤销时只撤销本次改动，保留用户已有改动。
- 本地验证通过不等于服务端问题已关闭。只有已有授权允许推送/扫描时才继续，并核对新分析的分支与修订；
  否则交付本地结果和后续扫描方式。不默认添加 `NOSONAR`；服务端状态只按"标记误报"一节改。

## 输出

用一份结果表覆盖本次查询到的全部 issue：issue key、规则、位置、判定、证据/改法、验证结果。
明确区分已修复、已标记误报（附说明原文）、待确认、修复失败；记录分页覆盖、项目/分支/分析身份、实际执行命令、
未验证内容以及是否提交或触发扫描。没有修改时不强行运行编译。
