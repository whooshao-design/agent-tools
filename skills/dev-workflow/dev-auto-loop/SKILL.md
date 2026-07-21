---
name: dev-auto-loop
description: Use when 任务目标和边界已明确，需要按审批基线自动串联设计评审、测试场景与开发交付，并在完成、预算耗尽、无进展或外部阻塞时停止。
metadata:
  version: 2.2.0
---

# dev-auto-loop

## 定位

用于编排三个有边界的研发闭环：

- **设计闭环**：`dev-design-solution` ⇄ `dev-review-solution`
- **测试场景闭环**：`dev-derive-test-cases` ⇄ `dev-review-test-cases`
- **交付闭环**：`dev-build-change` → `dev-verify-change` → `dev-review-change` → `dev-finish-branch`

本 skill 只治理跨阶段路由、审批基线、预算和止损；各阶段的专业判断仍由对应 skill 负责。设计与测试场景的详细判定分别见
`references/design-review-loop.md` 和 `references/test-case-review-loop.md`。

## 默认产物目录

状态需要落盘时，默认写入
`/home/joney/docs/requirements-development/<requirement-name>/auto-loop/status.md`。轮次标识使用
`design-2`、`test-cases-1`、`delivery-3` 这类语义前缀；用户指定路径时优先使用用户路径。

## 进入条件

- 需求目标、范围和完成标准已明确；否则先转 `dev-clarify-task`
- 能为当前需求和代码基线生成稳定标识；已有方案或场景时，也必须能标识其版本
- 三段均使用本文默认预算；只有用户明确覆盖时才调整
- 用户要求逐步确认时，不启动自动编排

## Workflow

### 1. 固定审批元组

定义当前审批元组 `T = (R, S, C, B)`：

- `R`：需求引用、版本和内容摘要
- `S`：方案引用、版本和内容摘要；尚未形成时为 `∅`
- `C`：测试场景引用、版本和内容摘要；尚未形成时为 `∅`
- `B`：实现开始前的代码基线标识（提交/树及既有工作区状态摘要）

方案审批绑定 `(R, S, B)`；场景审批绑定完整的 `(R, S, C, B)`。进入任何下一阶段前，都要把当前产物摘要与审批记录逐项精确匹配，不能只比较文件名或版本标签。交付阶段产生的任务 diff 记为独立的 `change_revision`，不改写冻结的 `B`；外部合并、变基或非本任务改动导致的基线变化属于 `B` 变化。

### 2. 维护轻量 handoff envelope

阶段间只传递一份轻量 envelope，不复制方案、场景或评审正文：

| 字段 | 最少内容 |
|---|---|
| `artifacts` | `R/S/C/B` 的引用、版本、摘要，当前 `change_revision` |
| `approvals` | 方案与场景的结论、审批元组、正式报告或结构化对话结果引用 |
| `risk_authorizations` | 用户明确授权的 finding 指纹、条件、授权来源及其绑定元组 |
| `loop_state` | 当前阶段、各独立计数器、已用/上限、最近结果 |
| `evidence` | 证据摘要、缺口 ID、每个缺口的自动补证次数 |
| `next` | 下一阶段、路由原因，或终止状态与恢复条件 |

每次产物、审批、授权、证据或代码修订变化后更新 envelope；每次路由前重新校验，不沿用口头上的“已通过”。

### 3. 按唯一主路径推进

主路径固定为：

`设计闭环通过` → `测试场景闭环通过` → `构建` → `验证` → `代码评审` → `收口` → `完成`

- 只有存在匹配 `(R,S,B)` 的方案审批，才可跳过设计闭环
- 设计结论为 `通过`，或满足用户预授权要求的 `有条件通过`，下一步只能进入测试场景闭环
- 只有存在匹配 `(R,S,C,B)` 的场景审批，才可跳过测试场景闭环或进入交付闭环
- 测试场景发现 `方案缺口` 时，允许回设计闭环；设计重新审批后必须回测试场景闭环，不得直达交付
- 交付中发现需求、方案或场景级缺陷时停止等待人工，不自动跨段回跳

### 4. 执行设计闭环

使用两个独立计数器，不再折算“轮次单位”：

- `design_revision_count`：默认最多 3 次，仅在执行一次 `修改后复审` 修订时 `+1`
- `design_redesign_count`：默认最多 1 次，仅在执行一次 `退回重设计` 时 `+1`

任一动作开始前若对应计数已达上限，停止为 `budget_exhausted`。Blocker/High 必须关闭；Medium 不得由 agent 自动标记 `Accepted`。只有用户事先对精确 finding 和当前绑定元组作出明确授权，`有条件通过` 才能退出设计闭环；缺少授权时停止为 `awaiting_human_risk_decision`，不伪装成一次修订。完整规则见 `references/design-review-loop.md`。

### 5. 执行测试场景闭环

`test_case_revision_count` 默认最多 2 次，仅在执行一次 `修改后复审` 补充时 `+1`。本段没有自动接受或有条件通过：只有匹配当前完整元组的 `通过` 才能进入交付。`方案缺口` 路由和止损规则见 `references/test-case-review-loop.md`。

### 6. 执行交付闭环

默认预算为 `delivery_repair_count <= 3` 且 `delivery_transition_count <= 12`。每次因验证失败或评审 finding 回到 `dev-build-change` 前，将 repair 计数 `+1`；每次非终态阶段转移前将 transition 计数 `+1`。计划计数动作时先判断当前值小于上限，满足才 `+1` 并执行；否则停止为 `budget_exhausted`。

| 当前阶段与结果 | 下一状态 |
|---|---|
| 构建产出新的 `change_revision` | `dev-verify-change` |
| 验证为 `通过` | `dev-review-change` |
| 验证为 `受限通过`，且限制不涉及必需门禁/场景并已有匹配的用户风险授权 | `dev-review-change`；否则 `awaiting_human_risk_decision` |
| 验证为 `需修复后重验`，且得到新的、可行动的实现失败证据 | 在 repair 预算内回 `dev-build-change` |
| 验证为 `阻塞` | 按原因进入 `blocked_infrastructure` / `blocked_material` / `awaiting_human`，不原地重试 |
| 代码评审为 `可继续推进` | `dev-finish-branch` |
| 代码评审为 `修复后再评`，且有新的、可行动的实现 finding | 在 repair 预算内回 `dev-build-change`；若只缺验证证据则回 `dev-verify-change` |
| 代码评审为 `带风险接受` | 只有匹配用户风险授权时进入 `dev-finish-branch`；否则 `awaiting_human_risk_decision` |
| 收口确认审批、验证、评审和 diff 均匹配 | `completed` |
| 任一阶段发现需求/方案/场景缺陷或需风险决策 | 使相关审批失效，停止为 `awaiting_human` 并给出最早恢复阶段 |
| 必需依赖、权限、服务或测试设施不可用 | `blocked_infrastructure` |

`blocked_infrastructure` 是本次运行的终态：记录缺失能力、已完成检查和恢复条件，不把环境失败算成代码失败，也不降级为“验证通过”。

### 7. 使过期审批失效

- `R` 变化后先做影响分析；受影响的方案和场景审批全部失效，无法证明不受影响时按受影响处理
- `S` 变化后方案审批失效，依赖该方案的场景及其审批也失效
- `C` 变化后场景审批失效
- `B` 因外部变化后，依赖旧代码证据的方案和场景审批失效
- finding 内容、条件或绑定元组变化后，原风险授权失效

失效后路由到最早需要重新产出/审批的阶段。任何设计重新收敛都必须先经过测试场景闭环，不能沿用旧场景审批直达交付。

### 8. 执行通用止损

- 对每个标准化 `evidence_gap_id` 最多自动补证 1 次；同一缺口再次出现，或补证后证据摘要未变化，停止并列出人工所需材料
- 连续两次在相同审批元组、`change_revision` 和证据摘要上得到相同非终态结果，停止为 `no_progress`
- 同一失败指纹在一次修复后再次出现，且没有足以改变定位或下一动作的新证据，停止为 `no_progress`
- 同一未变化输入得到互相矛盾的严重度或结论，停止为 `inconsistent_review`
- 用户预授权带来的合法 `Accepted` 状态变化属于新状态；它不是 agent 自动接受，也不触发“findings 未变化”止损

### 9. 每轮输出状态摘要

至少报告：当前审批元组摘要、阶段与结论、各计数器已用/上限、风险授权状态、证据缺口与补证次数、下一状态及原因。终止时同时报告终止类型和恢复循环所需的最小外部变化。

## 编排原则

- 自动编排只执行已授权且可验证的阶段转移，不替人接受风险
- 设计/场景产出与对应评审应使用独立新上下文；可用时交给未看过产出过程的子代理，只提供原始需求、产物和必要代码证据。无法隔离时标明“同上下文自评”这一证据限制
- 三段分别计数；设计修订、重新设计和交付修复互不折算
- 跳过阶段依赖匹配审批，不依赖“之前做过”的记忆
- 没有新产物、新证据或新授权时，不重复相同动作
- 任务过大时可调用 `build-codeagent`，但子代理不得绕过本状态机和审批元组

## 结果要求

最终结果必须能回答：当前 `T` 是什么、哪些审批仍有效、为什么发生每次路由、预算消耗多少、为何完成或停止，以及恢复时应从哪个阶段继续。
