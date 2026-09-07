---
name: fix-sonarqube-issues
description: 评估并修复 SonarQube 新代码周期的 BLOCKER/CRITICAL 问题。按规则与代码证据区分真实问题、误报和无法确认的风险，修复后执行最小验证。只要求评估时不改代码。
metadata:
  version: 1.2.0
---

# fix-sonarqube-issues

## 定位

处理当前任务范围内的 SonarQube 新代码问题。保留真实业务、日志与监控契约；不要为了消除告警而改变行为。
默认范围是未解决的 BLOCKER/CRITICAL。用户要求其他范围时明确记录；较高风险或架构变更先收敛方案，不盲改。

MCP 优先、脚本兜底。已有 `sonarqube` MCP 支持项目解析、分页 issues、规则详情和质量门禁。
只要求评估时只读；要求修复时实施可确认安全的最小改动。提交、推送、标记误报/接受风险与抑制规则需有相应授权。

## 输入与认证

从用户问题页 URL 或当前仓库上下文确认项目、分支或 PR、新代码周期。页面的 `id` 是 project key。
用 `parse_sonarqube_project` 解析基址；将返回的 `base_url` 显式传入后续工具，避免查询到默认站点的同名项目。

认证由 MCP 内部读取本地 `SONARQUBE_COOKIE` / `SONARQUBE_XSRF_TOKEN` 或复用浏览器 profile。
登录失效时通过 `get-browser-session` 续期；不要要求用户把 Cookie、token、完整认证 curl 粘贴到对话。
MCP 不可用时可在本机脚本内使用同一认证与 API；不要把凭据放入命令参数、日志或产物。

## 查询与评估

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
5. 逐项判定：真实且修复安全 → 需修复；确有误报或应保持既有行为 → 无需修复并给证据；无法确认 → 待确认。
   并发集合的 `size()` / `isEmpty()` 都可能只是瞬时观测，不把方法名当作原子性保证。
   常量重命名与常量值变化是不同问题；是否影响监控取决于输出值与消费契约，不能只凭命名推断。

## 修复与验证

- 只修用户授权范围内、已确认的问题；按文件合并相关改动，复用已有实现。
- 删除字段前核对运行时引用；替换字面量前核对输出语义。保留字符串稳定值本身的业务约束。
- 先跑受影响模块的最小编译/测试；多模块 Maven 依仓库约定选择 `mvn -pl <module> -am compile`
  或已有测试入口。编译成功不能替代语义变化所需的行为验证。
- 验证失败时先定位原因；需要撤销时只撤销本次改动，保留用户已有改动。
- 本地验证通过不等于服务端问题已关闭。只有已有授权允许推送/扫描时才继续，并核对新分析的分支与修订；
  否则交付本地结果和后续扫描方式。不默认添加 `NOSONAR` 或改变服务端 issue 状态。

## 输出

用一份结果表覆盖本次查询到的全部 issue：issue key、规则、位置、判定、证据/改法、验证结果。
明确区分已修复、无需修复、待确认、修复失败；记录分页覆盖、项目/分支/分析身份、实际执行命令、
未验证内容以及是否提交或触发扫描。没有修改时不强行运行编译。
