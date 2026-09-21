# 评审背景：checkExpressRuleValid 调用方改为本地校验表达式

目标：两个调用方（规则配置应用 server-rcrule-dataconfig-java 的 RuleXmlConvertLogic，发布应用 server_credit_ser_deploy_java 的 ExpressRuleDeployServiceImpl）不再远程调用 ExpressRuleDeployService.checkExpressRuleValid，而是在本地用 QLExpress 3.2.0 解析表达式做语法校验（每次请求创建 ExpressRunner(true,true)，只调用 parseInstructionSet），保留原有外围行为。

验收标准：
- AC-001 保留 checkExpressRuleValid 对外契约；合法/非法表达式返回与旧实现一致（正常 0/ok/null，异常 16092603 加原消息），独立入口空值仍按原业务错误处理。
- AC-002 规则配置共同保存路径中，仅 EXPRESS 分支改为本地解析；新增与更新均覆盖，原 trim、空白跳过、XML 包装顺序不变。
- AC-003 既有非 EXPRESS 分流、复制行为、各入口参数分组和异常包装保持一致；保存失败时规则记录和版本状态符合既有回滚行为。
- AC-004 两个调用方采用相同 QLExpress 3.2.0 解析语义并兼容 Java 7。
- AC-005 两个旧调用点已解除；发布应用无残留的该服务注入引用（DEP 注入与 dubbo-provider.xml reference 一起移除）。
- AC-006 更大范围的旧引用、API 包及原应用删除不在本次范围，不得顺手删除。

约束：目标运行环境 Java 7 兼容；POM 固定解析器版本并排除 log4j；不新增共享模块、开关或抽象；不改保存 RPC、事务、权限、版本或复制流程。

重点关注：测试断言是否真实约束业务行为（避免不可能失败的断言、错误的异常消息假设、依赖不存在的 API、与实际 Spring 4.3.30 / Bean Validation 1.0 签名不符的写法、事后捕获可变 DTO 导致的误判）；生产改动是否引入 execute、Throwable 吞捕、共享 runner 或 RPC fallback。
