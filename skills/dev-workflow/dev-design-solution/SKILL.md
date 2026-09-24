---
name: dev-design-solution
description: Use when 需求边界和验收标准已基本明确，需要写技术方案、出方案或做方案设计：基于代码上下文产出可评审、可实施、可验证的技术方案，比较存在实质取舍的实现路径并收敛设计决策。
metadata:
  version: 4.1.2
---

# dev-design-solution

## 定位

在需求已基本明确后，结合代码证据形成可评审、可实施、可验证的技术方案。它负责分析现状、收敛技术决策、解释目标机制及其正确性，并明确影响、发布、风险和验证；不替代需求澄清、正式方案评审、详细测试清单或开发执行清单。

默认只读取需求、代码和配置，不在设计阶段改业务代码。用户要技术方案（"写方案""出方案""做方案设计"）时默认按文档模式落盘到产物目录；用户明确只要讨论、口头建议或不保存时才用对话模式。

方案的文件构成、内容归属、追踪和可读性统一遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/solution-structure-contract.md`；表达规则遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/writing-principles.md`。

## 参考资料路由

不要一次加载所有 reference：

- 每次先读 `references/template-routing.md`，判断是否需要正式方案并选择一个主 profile。
- 输出正式文档时读 `references/solution-template.md`、`references/traceability-template.md`、`references/design-dimensions.md`、`references/readability-and-writing.md` 和选中的 `references/profiles/<profile>.md`。
- 决定画什么图、怎么校验时读 `references/visualization-routing.md`。
- 交付评审前读 `references/reader-test-protocol.md`。
- 路径明确且无需正式方案时，转 `dev-build-change`，不加载完整模板和 profile。

## 默认产物

正式方案默认放到 `/home/joney/docs/requirements-development/<requirement-name>/solution-design/`：

- `solution.md`：给人读的设计叙事，按 `solution-template.md`。
- `traceability.md`：身份、AC 映射、CHG 矩阵、横切覆盖、风险登记、证据清单，按 `traceability-template.md`。
- `diagrams/`：`check_mermaid.js` 输出的 mmd、SVG、PNG 和 `results.md`。
- `reader-test/`：答案键、agent 读者测试原始输出与比对结果、人的读者测试记录。

规则：

- `<requirement-name>` 使用简短、稳定、可读的需求名；用户指定路径时优先使用。
- 只需在对话中收敛方案时不创建文件。
- 修订已有方案前，把 `solution.md` 与 `traceability.md` 一起归档到 `solution-design/versions/v<旧版本号>/`，再递增方案版本；首次成案不创建 `versions/`。
- 设计方只维护 `Draft` / `Reviewing`，不得自行标记 `Approved`。审批事实只来自 `dev-review-solution` 针对 `(R,S,B)` 形成的不可变 `approval-record-v1`。
- 方案身份 `S` 是覆盖 `solution.md` 和 `traceability.md` 的文件集指纹，按 `artifact-identity.md` 在 handoff 计算，不写回文件。

## When to Use

适合：

- 需求目标、范围和验收标准已基本明确，需要决定如何实现；
- 需要基于现有代码、接口、数据或配置形成正式方案；
- 存在实质技术取舍，或需要明确机制、迁移、契约、数据状态、发布及验证风险。

不适合：

- 需求边界或验收标准不清楚：转 `dev-clarify-task`；
- 已有完整方案，需要独立评审：转 `dev-review-solution`；
- 实现路径唯一且风险可直接从完成标准得出：转 `dev-build-change`。

## Workflow

### 1. 冻结设计输入与范围事实源

至少确认目标、In Scope、Out of Scope、稳定 `AC-*`、已知约束、代码基线 `B`、相关代码上下文，以及符合 `artifact-identity.md` 的需求身份 `R`。同时收齐方案要引用的文档：需求文档、接口或契约文档、依赖的上游文档、前序方案或评审记录，它们会出现在 `solution.md` 头部的相关文档列表。

明确哪份产物定义变更范围，记录其 `ref + fingerprint`、条目枚举或计数、非目标与裁定人。当范围事实源是 agent 自建的脚本、扫描器或清单，或 `R` 缺少带稳定 ID 的验收标准时，必须先由用户裁定它是"范围事实源"还是"定位辅助工具"；未裁定不得进入正式评审。

会改变范围、核心行为或方案方向的未知项必须先确认或回退需求澄清；低风险、可逆未知项可以作为显式假设继续。

### 2. 建立最小必要现状与证据

只收集理解本次决策需要的当前职责、调用/数据/状态流、可复用模式、限制和影响对象。现状章节不夹带目标方案；事实、假设和待确认事项分开，长调用链、SQL、日志和完整核验结果放 `traceability.md` 的证据清单，正文引用 `[E-n]`。

上游事实必须标注可复核来源。对"0 命中、无消费方、无影响"等负向断言，至少使用两条相互独立的检索路径；单一路径结论只能记为待复核。全称断言同时遵循结构契约中的可复现规则。

### 3. 路由文档粒度和主 profile

按 `template-routing.md` 先判断是否需要正式方案。正式方案只选择一个主要正确性问题：

- `mechanism-architecture`（机制/架构型）：证明多个运行时参与者协作后机制仍正确；
- `migration-remediation`（迁移/整改型）：证明现状能安全切换到目标状态且不漏不误；
- `contract-evolution`（契约演进型）：证明新旧生产方和消费方在版本窗口内兼容；
- `data-state-consistency`（数据/状态型）：证明数据、状态和事务在并发及失败下保持不变量。

多项命中时选择风险最高、最影响正确性结论的一项，其他问题作为横切维度写回相关机制；不得拼接多份 profile。`CHG-*` 只做交付追踪，不控制正文叙事。

### 4. 收敛推荐方案

存在实质取舍时为关键决策分配 `DEC-*`，比较 2 到 3 个真实候选的正确性、现有边界一致性、复杂度、兼容/迁移/回滚成本和演进风险。明显只有一个合理最小路径时，不制造陪跑方案，只说明其他路径为何不成立。

写正文前先按 `readability-and-writing.md` 的七个读者问题和 `design-dimensions.md` 的横切矩阵建立覆盖地图。完整性由覆盖地图保证，不需要把检查项全部扩写为章节。

### 5. 先写给人看的部分

按 `solution-template.md` 的顺序写 `solution.md`：头部一行、相关文档、摘要、背景与目标、方案概览（一句话方案、主图、关键决策、成立理由）、详细设计、替代方案、影响、发布验证回滚、风险与未决。

摘要不超过 150 字，只压缩正文已有结论。主图按 `visualization-routing.md` 的触发条件和 profile 默认图型决定，不画要写豁免理由。第 3 章按选中 profile 使用 guide → reference 顺序：先用机制导读和代表性场景建立心智模型，再说明参与者、契约、状态、时序、不变量、失败、兼容和边界；标题使用技术机制或状态变化。正文只展开本次变化、违反直觉、高风险、存在争议、影响正确性或缺少细节会导致不同实现的内容。

### 6. 再写追踪文件

按 `traceability-template.md` 写 `traceability.md`：身份、`AC → 设计位置 → CHG → 验证 → 发布/回滚` 的映射、CHG 矩阵（动作只取 `新增` / `修改` / `删除` / `保持不变`）、横切维度覆盖、风险登记、证据清单。每个 CHG 都有来源、影响对象和验证入口；"设计位置"引用 `solution.md` 的章节号。逐文件对象、工时、负责人、commit 和开发批次交给 `dev-build-change`。

### 7. 校验图与指标

运行 `node /home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-design-solution/scripts/check_mermaid.js solution-design/solution.md solution-design/diagrams`，全部通过后再交付；改不好的图换成等宽文本块。运行 `python3 /home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-design-solution/scripts/doc_metrics.py solution-design/solution.md --traceability solution-design/traceability.md`，逐条处理它给出的提示，尤其是摘要长度、主图缺失、表格多于散文、修订痕迹和追踪引用失联。

### 8. 输出前自检与读者测试

按 `readability-and-writing.md` 第 7 节执行自检。然后按 `reader-test-protocol.md` 先写答案键 `reader-test/answer-key-v<N>.md`，交由编排器派发与设计方不同模型的 agent 读者只读 `solution.md` 作答，比对结果写入 `reader-test/agent-v<N>.md`。按协议 §5 判定不通过（全文读者七问、截断读者前五问、成立的探针问题）时先修方案再进入正式评审。

方案必须能交给 `dev-review-solution` 独立评审：reviewer 不读 `traceability.md` 也能理解机制、影响和上线验证，深读时能从两个文件定位精确契约、边界、证据及所有 CHG。

### 9. 评审后修订

按 findings 修订时只改设计内容，并在 `solution-review/rounds/round-<N>/resolution.md` 逐条记录处置、修改的章节、是否新增全称断言及其证据编号。正文不写"关闭 F-xx""v9 订正"这类痕迹，也不写解释给 reviewer 听的句子；关闭 finding 时优先删除或收窄不成立的断言，确需新增全称断言时在证据清单附可复跑检索命令。

递增版本，在 `traceability.md` 的版本表加一行。编排器生成上一版与当前版两个文件的 diff 及触达标题列表，随冻结输入下发下一轮。定点复审仍需提供新旧方案差异和影响范围，并执行全局结构、追踪与非回归检查。

## 输出模式

### 对话模式

用户明确只要讨论或不保存时，按"结论 → 推荐方案与机制导读 → 必要精度 → 验证与风险"输出。路径明确时保持轻量，不展开完整模板。

### 文档模式

用户要方案文档（默认）时使用 `solution-template.md` + `traceability-template.md` 和一个主 profile。长证据、完整对象清单和执行内容进 `traceability.md` 或独立证据文件；`solution.md` 超过约 300 行时复核是否重复或混入追踪内容，超过约 450 行时优先拆分证据，不机械删减必要设计。

## 交接建议

- 方案达到可评审状态时冻结文件集 `S` 和 `producer_agent_refs`，连同答案键与读者测试结果交由独立 `dev-review-solution`。
- `通过` 或有效的 `有条件通过` 后转 `dev-derive-test-cases`。
- `修改后复审` / `退回重设计` 时按第 9 步修订；需求边界争议回退 `dev-clarify-task`。
- 进入人评审会前，用户按 `reader-test-protocol.md` 第 7 节做 5 分钟读者测试；会上意见由编排器记为下一轮 findings。
- 只有用户明确豁免原本适用的正式门禁时才生成 `waiver-record-v1`；普通直接任务使用 `direct` 上下文，不伪造 waiver。
