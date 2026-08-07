# 设计闭环判定细则

供 `dev-auto-loop` 编排 `dev-design-solution` ⇄ `dev-review-solution` 时使用。本文件只规定自动编排如何解释评审结论、消费预算和停止；产物身份遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/artifact-identity.md`。

## 进入与退出约束

- 进入时至少固定需求 `R`、代码基线 `B` 和当前方案 `S`（首次设计时 `S=∅`）
- 正式评审必须由与全部方案 producer 身份不相交的只读 reviewer 执行；身份、输入指纹或结果信封校验失败时不解释领域结论，按 `formal_reviewer_unavailable` 处理
- 每次评审以新的不可变 `approval-record-v1` 记录方案审批键 `(R,S,B)`；`R/S` 使用引用、版本、内容指纹和摘要，`B` 使用不可变代码基线标识，顶层 `review.md` 只作展示或指针
- 成功退出后只能进入测试清单准备，不能直接进入交付闭环
- 方案内容或 `R/B` 变化后，旧方案审批失效；受影响的测试清单审批同时失效

## 独立预算

维护两个互不换算、互不重置的计数器：

| 计数器 | 默认上限 | 何时增加 |
|---|---:|---|
| `design_revision_count` | 3 | 即将执行一次定点方案修订时 `+1`，包括测试清单复核路由回来的 `方案缺口` |
| `design_redesign_count` | 1 | 即将执行一次重新构思候选方案时 `+1` |

开始动作前先判断 `count < limit`。满足时先 `+1` 再执行；不满足时停止为 `budget_exhausted`。重新设计不折算成“两轮修订”，也不重置已经消费的修订预算。

## 结论到动作

| 评审结论 | 自动编排动作 |
|---|---|
| `通过` | 确认没有未关闭的 Blocker/High/Medium，写入本轮不可变方案审批记录，进入测试清单准备 |
| `有条件通过` | 按“风险授权”逐项校验；全部匹配才写入本轮不可变方案审批记录并进入测试清单准备 |
| `修改后复审` | 在 revision 预算内递增计数，回 `dev-design-solution` 定点修订，产生新 `S` 后重新评审 |
| `退回重设计` | 在 redesign 预算内递增计数，回 `dev-design-solution` 重新比较候选方向；预算不足时建议转 `dev-clarify-task` 或人工 |
| `材料不足` | 在单 gap 与设计段补证总预算内补证；无法形成新证据时停止为 `blocked_material` |

表中的领域结论仅在正式评审执行有效时参与路由；有效 reviewer 的否决不能通过更换 reviewer 绕过。

修订或重新设计都必须产生新的方案版本、内容指纹与摘要；只有标签变化、内容未变化，不算有效修订。

定点修订后的评审只有在 handoff 同时提供上一版 `S`、上一轮审批记录、新旧方案差异、已处理 findings 和受影响的
`DEC-*` / `CHG-*` / `RISK-*` 时，才可声明为定点复审。定点复审仍执行方案身份、全局结构与追踪一致性和变更影响
非回归检查；影响范围无法证明或核心决策/系统边界发生变化时必须完整复审。重新设计一律完整复审。

## 风险授权

自动循环不得替用户接受风险，也不得因为 finding 连续多轮未变、修复成本较高或超出最小范围，就自行把 Medium 标记为 `Accepted`。agent 可以提出接受建议，但不能据此放行。

`有条件通过` 只有同时满足以下条件才能退出：

1. 没有未关闭的 Blocker 或 High
2. 每条未解决 Medium 都已被用户在退出前明确授权接受
3. 授权记录包含用户原话或消息引用、finding ID 与内容指纹、生效条件，以及绑定的 `(R,S,B)`
4. 当前 finding 内容、条件和 `(R,S,B)` 与授权记录精确匹配

缺少授权时停止为 `awaiting_human_risk_decision`，列出待决策 Medium；不得把它改写成 `修改后复审` 来消耗预算。用户沉默、继续执行的笼统指令或 agent 自己的风险判断都不构成授权。finding、条件或绑定元组变化后，旧授权失效。

用户补充匹配授权后，编排器把授权作为新冻结输入，创建新的 `task_id`、round 和独立 reviewer 结果；不得改写旧结论，也不消费 revision/redesign 预算。

严重度处置如下：

| 严重度 | 自动闭环处置 |
|---|---|
| Blocker | 必须解决，无接受路径 |
| High | 必须解决；`dev-review-solution` 的 `有条件通过` 前提也不允许存在 High |
| Medium | 修复、或等待匹配的用户明确授权；绝不自动接受 |
| Low | 记录但不阻断，不得悄悄升级为接受授权 |

## 材料补证

将每个材料缺口标准化为稳定的 `evidence_gap_id`，在 handoff envelope 记录缺口描述、所需事实指纹和 `auto_attempts`。设计段另维护默认上限为 3 的 `design.evidence_auto_attempt_count`：

1. 单 gap 尚未尝试且设计段总次数未达上限时，可从代码仓库和已授权只读来源补证一次；动作开始前同时递增两项计数
2. 补证后必须更新证据摘要再重新评审
3. 同一缺口再次出现、阶段总次数耗尽或补证没有产生新证据时，立即停止为 `blocked_material`
4. 需要业务或范围决策时进入 `awaiting_human`；需要风险接受时进入 `awaiting_human_risk_decision`；依赖、权限、服务或 agent 后端不可用时进入 `blocked_infrastructure`

不同措辞但所需事实相同的缺口视为同一 ID，不能通过改名绕过上限。材料补证不消耗 revision/redesign 预算，但受设计段补证总预算和无进展止损约束。

## 无进展与一致性止损

比较连续评审的进展键：`(R,S,B, 证据摘要, finding ID/内容/状态, 风险授权 ID, 评审结论)`。

- 需要继续动作但进展键未变化：停止为 `no_progress`
- 同一失败/finding 指纹在一次方案修订后再次出现，且没有改变定位或下一动作的新证据：停止为 `no_progress`
- 相同输入出现不同严重度或互相矛盾的结论：停止为 `inconsistent_review`
- 同一 Medium 稳定存在不产生授权，也不构成继续循环的理由
- 用户提供匹配授权后，finding 从 Open 到 Accepted 的变化属于新的外部状态；重新校验后可立即以 `有条件通过` 退出，不与“findings 未变化”冲突

## 停止时交付状态

无论成功还是停止，都输出：当前 `(R,S,B)`、方案版本与摘要、两个设计计数器、设计段补证总次数、完整 Blocker/High/Medium 及状态、风险授权引用、证据缺口及单项次数、结论历史、下一状态和恢复条件。成功时明确下一状态为 `dev-derive-test-cases` 或 `dev-review-test-cases`。
