# 测试清单准备判定细则

供 `dev-auto-loop` 编排 `dev-derive-test-cases` ⇄ `dev-review-test-cases` 时使用。本文件只规定自动编排的路由、预算和止损；产物身份遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/artifact-identity.md`。

## 进入与退出约束

- 进入前必须存在匹配当前 `(R,S,B)` 的方案审批；不匹配时回设计闭环
- 正式复核必须由与全部清单 producer 身份不相交的只读 reviewer 执行；身份、输入指纹或结果信封校验失败时不解释领域结论，按 `formal_reviewer_unavailable` 处理
- 测试清单 `C` 必须标明它对应的 `R/S/B`，不能只引用方案文件名
- 成功评审以新的不可变 `approval-record-v1` 记录完整审批元组 `(R,S,C,B)`；顶层 `review.md` 只作展示或指针，只有当前产物与审批记录精确匹配才能进入交付闭环
- 本段没有 `有条件通过`；用户针对精确 finding 与 `(R,S,C,B)` 作出的明确授权，按 `dev-review-test-cases` §5 计为该 finding 的关闭证据，agent 不得自动接受 finding
- 停止时须区分两种终态：`budget_exhausted`（预算耗尽、未收敛）与满足当前复核规则的 `通过`（已收敛）；交付状态中必须可分辨

## 独立预算

`test_case_revision_count` 默认上限为 2。执行一次清单补充/修订前，先判断计数小于上限，再将计数 `+1`；已达上限则停止为 `budget_exhausted`。设计闭环消耗不计入本计数，因 `方案缺口` 回设计也不重置本计数。

方案变化后重编受影响清单属于设计缺口的下游重建，已经消费 `design_revision_count`，不额外消费 `test_case_revision_count`；后续 test-design reviewer 再给出 `修改后复审` 时才消费清单修订预算。

## Producer 发现上游缺口

`dev-derive-test-cases` 自报的 `方案缺口` 是待复核证据，不是正式结论，不能直接推翻已有方案审批：

- 能形成稳定 `C` 时，把缺口保留在清单中并正常派发 test-design reviewer。
- 无法形成稳定 `C` 时，把新证据连同同一 `(R,S,B)` 派发给独立 solution reviewer；其有效结论再按设计闭环路由。
- solution reviewer 确认原方案审批仍有效时，在清单修订预算内回 `dev-derive-test-cases` 重试一次；相同缺口再次出现且没有新证据时停止为 `no_progress`。
- producer 只报告材料不足时，按本段补证预算处理；没有稳定产物时不伪造 test-design 审批。

## 结论到动作

| 评审结论 | 自动编排动作 |
|---|---|
| `通过` | 确认没有未关闭的 Blocker/High/Medium，写入绑定 `(R,S,C,B)` 的本轮不可变审批记录，进入 `dev-build-change` |
| `修改后复审` | 在清单修订预算内回 `dev-derive-test-cases`，定点补充 finding 指向的检查项，生成新的 `C` 后独立复核 |
| `方案缺口` | 保留已有清单 findings，失效受影响审批，按“回设计闭环”处理；不进入交付 |
| `材料不足` | 在单 gap 与测试清单段补证总预算内补证；无法形成新证据时停止为 `blocked_material` |

表中的领域结论仅在正式复核执行有效时参与路由；有效 reviewer 的否决不能通过更换 reviewer 绕过。

任何送审后内容变化都要形成新的清单版本、内容指纹和摘要。只有版本标签变化、清单内容未变化，不算一次有效修订。

## 回设计闭环

只要存在未关闭的方案缺口，整体结论优先为 `方案缺口`；即使同时存在清单问题，也不能先把清单修好后放行。路由步骤固定为：

1. 保留并标记现有清单 findings，不把它们误记为已解决
2. 在 design revision 预算可用时递增 `design_revision_count`，回 `dev-design-solution` 修订方案；需要根本换方向时仍由后续方案评审给出 `退回重设计`，并独立消费 redesign 预算
3. 使旧方案审批及受影响的测试清单审批、风险授权失效
4. 方案重新得到匹配 `(R,S,B)` 的审批后，回 `dev-derive-test-cases` 编写所有受影响检查项
5. 生成新的 `C` 并独立复核；影响范围无法可靠界定时全量重新编写/复核

设计重新通过后的下一步始终是测试清单准备，不得从设计阶段直达交付。若设计预算耗尽或需人工风险授权，沿用设计闭环的终止状态。

## 材料补证

为每个材料缺口建立稳定 `evidence_gap_id`，并在 handoff envelope 记录所需事实指纹与 `auto_attempts`。测试清单段另维护默认上限为 3 的 `test_cases.evidence_auto_attempt_count`：

- 单 gap 未尝试且阶段总次数未达上限时，可从代码仓库和已授权只读来源补证一次；动作开始前同时递增两项计数
- 同一缺口再次出现、阶段总次数耗尽或补证后证据摘要未变化时，停止为 `blocked_material`
- 业务或范围决策进入 `awaiting_human`；风险接受进入 `awaiting_human_risk_decision`；依赖、权限、服务或 agent 后端不可用进入 `blocked_infrastructure`
- 所需材料相同但措辞变化，仍视为同一缺口，不得重新获得自动尝试次数

补证不消耗清单修订预算，但不能绕过通用无进展止损。

## 无进展与一致性止损

比较连续评审的进展键：`(R,S,C,B, 证据摘要, finding ID/内容/状态, 评审结论)`。

- 需要继续动作但进展键未变化：停止为 `no_progress`
- 修订后相同 findings 和结论再次出现，且没有新证据改变定位或动作：停止为 `no_progress`
- 相同输入出现不同严重度或互相矛盾的结论：停止为 `inconsistent_review`
- `R/S/B` 变化不是继续使用旧审批的“进展”，而是审批失效事件；先回到最早受影响阶段

## 停止时交付状态

无论成功还是停止，都输出：当前 `(R,S,C,B)`、方案与清单版本摘要、清单修订计数、测试清单段补证总次数、因 `方案缺口` 回设计的历史、完整 Blocker/High/Medium 及状态、证据缺口及单项次数、结论历史、下一状态和恢复条件。成功时明确下一状态为 `dev-build-change`。
