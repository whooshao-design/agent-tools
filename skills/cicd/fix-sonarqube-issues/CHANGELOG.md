# Changelog

## 1.4.0 (2026-10-29)

- 原则改为"不是误报就修，是误报就标记"：误报不再改写代码绕过检查，用新 MCP 工具 `transition_sonarqube_issues` 标记并写明理由
- 新增"标记误报"一节：说明写法、带引号代码片段会被网关断开、网络错误后先回读再重试
- 认证补充：读接口可匿名、标记需 Sonar 登录（`JWT-SESSION`/`XSRF-TOKEN`）；`profile is busy` 时的处理
- 补充 git push 被 Sonar 推送前检查拒绝的入口（`project:git_push_check_<仓库名>`）

## 1.1.0 (2026-05-28)

- **核心变更：评估优先，不该修的不硬修**
- Workflow 增加"逐条评估是否需要修复"步骤（步骤 3），先判断再动手
- 结果表格判定从三类改为四类：已修复 / 无需修复 / 需人工 / 修复失败
- 增加误报识别场景（lambda 内引用、反射/序列化隐式引用、日志监控契约）
- 增加修复安全检查点（监控上报 className 稳定性、isEmpty 并发语义等）
- 明确区分"无需修复"（已有充分证据不做改动）和"需人工"（证据不足需人判断）
- 增加可选增强：NOSONAR 注释处理建议

## 1.0.0 (2026-05-28)

- Initial release
- Support BLOCKER/CRITICAL severity issues in SonarQube new code period
- Auto-fix rules: S1192 (duplicate string constants), S1068/LxUnusedPrivateFieldCheck (unused private fields), S1155 (isEmpty vs size), S1161 (missing @Override), S1858 (redundant this), S1181 (catching NullPointerException)
- Authentication via XSRF-TOKEN + JWT-SESSION cookie
- Compile verification after fixes