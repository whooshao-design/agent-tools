---
name: dev-auto-loop
description: Use when 任务目标和边界已明确，需要按审批基线自动串联设计评审、测试清单与开发交付，并在完成、预算耗尽、无进展或外部阻塞时停止。
metadata:
  version: 3.1.1
---

# dev-auto-loop

## 定位

用于编排三个有边界的研发闭环：

- **设计闭环**：`dev-design-solution` ⇄ `dev-review-solution`
- **测试清单准备**：`dev-derive-test-cases` 编写清单 ⇄ `dev-review-test-cases` 独立复核清单
- **交付闭环**：`dev-build-change` → `dev-verify-change` → `dev-review-change` → `dev-finish-branch`

本 skill 只治理跨阶段路由、审批基线、预算和止损；各阶段的专业判断仍由对应 skill 负责。设计与测试清单的详细判定分别见
`references/design-review-loop.md` 和 `references/test-case-review-loop.md`。

运行身份、producer 结果、不可变 checkpoint、终态分类与恢复规则见 `references/run-state-and-resume.md`。

`R/S/C/B`、`change_revision`、`gate_context` 和风险授权统一遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/artifact-identity.md`；所有正式评审委派遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/delegation-contract.md`。

本自动编排只接受路径选择 `governance_path=approved`。它可以在方案尚未生成或两项正式门禁尚未完成时启动；此时还不存在交付 `G.mode=approved`。普通 direct 和 waived 交付由各阶段 skill 独立推进，不得进入本状态机。

## 默认产物目录

默认在 `/home/joney/docs/requirements-development/<requirement-name>/auto-loop/` 保存运行状态：`runs/<run-id>/run.json` 固定初始身份与预算，`runs/<run-id>/checkpoints/step-<N>.json` 追加不可变转移事实，`status.md` 只展示并指向最新 checkpoint。完整格式见 `references/run-state-and-resume.md`；用户指定根目录时优先使用。

## 进入条件

- 需求目标、范围和完成标准已明确；否则先转 `dev-clarify-task`
- 用户若要求正式需求评审，必须先在本状态机外完成并形成稳定 `R`；auto-loop 不包含需求修订子循环
- 用户显式调用本 skill 即选择 `governance_path=approved`；这只表示进入正式治理路径，不表示任何门禁已经通过
- 能为当前需求和代码基线生成稳定标识；已有方案或测试清单时，也必须能标识其版本
- 建立新的 `auto-loop-run-v1`；设计、测试清单、交付及每段补证均使用默认预算，只有用户明确覆盖时才调整
- 工作区必须能保持 `B` 稳定并在正式评审期间禁止并发写入；共享或长周期任务优先使用隔离 worktree
- 用户要求逐步确认时，不启动自动编排

## 不适合

- 需求或边界还在收敛：先 `dev-clarify-task`
- 普通修复或边界清晰的小改动：各阶段 skill 以 `direct` 独立推进，不进状态机
- 用户要逐步确认每一步，或只要单次评审、单次验证
- 平台不能提供可信的 reviewer runtime 身份与只读证明：正式门禁无法成立，不启动

## Workflow

### 1. 固定治理输入，门禁完成后构造 `G`

设计和测试清单阶段维护工作集 `(R,S,C,B)`，它不是审批元组 `T`：

- `R`：需求引用、版本/内容指纹和内容摘要
- `S`：方案引用、版本、内容指纹和内容摘要；尚未形成时为 `∅`
- `C`：测试清单引用、版本、内容指纹和内容摘要；尚未形成时为 `∅`
- `B`：实现开始前的 `repo-snapshot-v1`

方案审批必须绑定 `(R,S,B)`；测试清单审批必须绑定 `(R,S,C,B)`。进入任何下一阶段前，都要把当前产物身份与不可变 `approval-record-v1` 逐项精确匹配。只有两项审批均有效后，才定义 `T=(R,S,C,B)` 并构造交付 `G={mode: approved,T,approvals}`；在此之前禁止传递或声称 `G.mode=approved`。交付代码使用独立 `change_revision`，不改写冻结的 `B`。

### 2. 维护轻量 handoff envelope

阶段间只传递一份轻量 envelope，不复制方案、测试清单或评审正文：

| 字段 | 最少内容 |
|---|---|
| `artifacts` | `R/S/C/B` 的引用、版本、内容指纹与摘要，当前 `change_revision` |
| `approvals` | 各轮 `approval-record-v1` 的不可变 `{ref,fingerprint}`；不引用可覆盖的顶层 `review.md` 作为事实 |
| `actors` | 各产物/代码的 `producer_agent_refs[]`、各评审的运行时 `reviewer_agent_ref` 与独立性结果 |
| `review_execution` | reviewer role、任务 ID、冻结输入指纹、执行状态、结构校验和只读检查 |
| `risk_authorizations` | 用户明确授权的 finding/限制项 ID 与指纹、条件、授权来源和当前阶段绑定；交付阶段绑定 `G` 与 `change_revision` |
| `loop_state` | `run_id`、最新 checkpoint `{ref,fingerprint}`、当前阶段、各计数器 `used/limit` 和最近结果 |
| `evidence` | 证据摘要、事实指纹、缺口 ID、每缺口次数和当前段补证总次数 |
| `delivery_work` | 仅交付段使用：DEV 清单引用/摘要、依赖、状态、预计/实际写集和对应 producer refs；不复制完整清单正文 |
| `next` | 下一阶段、路由原因，或终止状态与恢复条件 |

所有生成/修改阶段都返回 `producer-stage-result-v1`；编排器按 `references/run-state-and-resume.md` 附着实际 producer 身份、工作区事件和输出指纹。每次产物、审批、授权、证据或代码修订变化后追加 checkpoint 并更新 envelope；复审新建 round 文件，不覆盖历史记录；每次路由前重新校验，不沿用口头上的“已通过”。

### 3. 按唯一主路径推进

主路径固定为：

`设计闭环通过` → `测试清单准备通过` → `构建` → `验证` → `代码评审` → `收口` → `完成`

- 只有存在匹配 `(R,S,B)` 的方案审批，才可跳过设计闭环
- 设计结论为 `通过`，或在本轮结论形成前已具备精确风险授权的 `有条件通过`，下一步只能进入测试清单准备
- 只有存在匹配 `(R,S,C,B)` 的测试清单审批，才可跳过该阶段或进入交付闭环
- 测试清单复核发现 `方案缺口` 时，允许回设计闭环；设计重新审批后必须回测试清单准备，不得直达交付
- 交付中发现需求、方案或测试清单级缺陷时停止等待人工，不自动跨段回跳

### 4. 派发独立正式评审

生成和评审必须使用不同的运行时 agent 实例。编排器在每个门禁前冻结输入及 `producer_agent_refs[]`，分别派发 `agent-tools-solution-reviewer`、`agent-tools-test-design-reviewer`、`agent-tools-change-reviewer`。reviewer 只接收原始需求、冻结产物、必要证据和上一轮待复核 findings，不接收 producer 的推理过程或预期结论，也不得继续委派。

身份、只读、写入、工具面和结果结构的准入只以 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/delegation-contract.md` 为准。编排器必须记录真实 `reviewer_agent_ref`，校验它与全部 producer 不相交，并以平台运行事件或前后快照证明 `checks.write_set_empty=true`；`changed_files=[]` 只是一项结果 schema 条件，不能作为未写入证明。校验成功后形成新的不可变 `approval-record-v1`；SubagentStop hook 仍只拦截缺失或畸形的结果信封。

正式派发前先按委派契约检查证明能力。平台无法提供可信 runtime 身份、有效能力面或覆盖完整的写入证明时，直接停止为 `blocked_infrastructure`，原因记为 `formal_reviewer_unavailable`，不得创建或重试 reviewer。只有偶发派发失败、超时、畸形结果，或原因已消除且冻结输入指纹未变的实例级配置/快照问题，才允许换一个新 reviewer 重试一次；输入指纹变化时创建新任务而不是占用原任务重试，再次执行失败时进入同一终态。有效 reviewer 的否决或 findings 是正常评审结果，必须按阶段路由修订，不能更换 reviewer 刷取通过。

### 5. 执行设计闭环

使用两个独立计数器，不再折算“轮次单位”：

- `design_revision_count`：默认最多 3 次；每执行一次定点方案修订时 `+1`，包括方案评审的 `修改后复审` 和测试清单复核发现的 `方案缺口`
- `design_redesign_count`：默认最多 1 次，仅在执行一次 `退回重设计` 时 `+1`

任一动作开始前若对应计数已达上限，停止为 `budget_exhausted`。Blocker/High 必须关闭；Medium 不得由 agent 自动标记 `Accepted`。只有用户在本轮结论形成前对精确 finding 和当前绑定元组作出明确授权，`有条件通过` 才能退出；缺少授权时停止为 `awaiting_human_risk_decision`。恢复后把授权作为新输入派发新的正式评审，不消费 revision/redesign 预算。完整规则见 `references/design-review-loop.md`。

### 6. 执行测试清单准备

先由 `dev-derive-test-cases` 编写“改完后检查什么、怎样算通过”的测试清单，再由独立 agent 使用 `dev-review-test-cases` 检查漏项、错项与可执行性；两步都不执行测试。`test_case_revision_count` 默认最多 2 次，仅在执行一次 `修改后复审` 补充时 `+1`。本段没有自动接受或有条件通过：只有绑定 `(R,S,C,B)` 的 `通过` 才能进入交付。

producer 自报 `方案缺口` 不能直接推翻既有方案审批：能形成稳定 `C` 时仍交 test-design reviewer；不能形成稳定 `C` 时，把新证据交 solution reviewer 复核同一 `(R,S,B)`。有效 reviewer 确认缺口后才按设计预算回设计；方案变化后的清单重编消费设计预算，不额外消费清单 revision 预算。完整规则见 `references/test-case-review-loop.md`。

### 7. 执行交付闭环

默认 `delivery_repair_limit=3`、`delivery.evidence_auto_attempt_limit=3`。`delivery_transition_limit` 按 `4 + 4 × repair_limit + 2 × evidence_auto_attempt_limit` 推导，默认 22；这样不会先于已授权的 repair/evidence 子预算截断合法主路径。用户只覆盖子预算时重新计算该值，只有显式覆盖 transition limit 时才采用独立值。

每次进入构建时，由 `dev-build-change` 按其开发执行清单契约生成或修订 `DEV-*`：首次构建从已审批的 `CHG-*` /
`TC-*` 派生；验证或代码评审修复从原 DEV、当前 finding 和新证据派生，保留已完成项历史。auto-loop 只把清单摘要、
依赖和状态写入 checkpoint/envelope，不重新拆分任务。需要 producer 时，`build-codeagent` 每次只消费一个依赖已满足的
DEV；预计写集不相交或隔离 worktree 才能并行。

同一构建 attempt 内执行多个 DEV 不按项额外消费 repair/transition 预算；这些预算仍按阶段写动作和跨阶段路由计算。
DEV 状态、实际写集或 producer refs 变化可以追加运行事实 checkpoint，但不能借此重置预算。若 producer 部分写入后失败，
仍按运行状态契约保留现场并停止安全自动重试，不因已有清单就推测性续写。

每次返回 `dev-build-change` 并启动新的写能力动作都预占一次 repair，包括验证失败、代码评审实现 finding 和收口清理；派发在写动作启动前失败且工作区未变化时不消费 repair。每次从交付阶段正常路由到另一阶段或终态前都预占一次 transition。仅当当前 `used < limit` 时才能预占；容量不足时直接追加 `budget_exhausted` checkpoint，不递增已经耗尽的 transition 计数。

自动补充验证/评审证据时还要登记 `delivery.evidence_auto_attempt_count`；`证据不足` 不能通过在 verify/review 间切换来绕过每缺口和当前段的补证总预算。

| 当前阶段与结果 | 下一状态 |
|---|---|
| 构建产出新的 `change_revision` | `dev-verify-change` |
| 验证为 `通过` | `dev-review-change` |
| 验证为 `受限通过`，且限制不涉及必需门禁/检查项，每个 `VL-*` 的指纹、`G`、`change_revision` 和条件均有匹配用户授权 | `dev-review-change`；否则 `awaiting_human_risk_decision` |
| 验证为 `需修复后重验`，且得到新的、可行动的实现失败证据 | 在 repair 预算内回 `dev-build-change` |
| 验证为 `阻塞` | 按原因进入 `blocked_infrastructure` / `blocked_material` / `awaiting_human`，不原地重试 |
| 代码评审为 `可继续推进` | `dev-finish-branch` |
| 代码评审为 `修复后再评`，且有新的、可行动的实现 finding | 预占 repair 后回 `dev-build-change` |
| 代码评审为 `修复后再评`，但只剩可授权 Medium | `awaiting_human_risk_decision` |
| 代码评审为 `修复后再评`，且没有新 finding、证据或动作 | `no_progress` |
| 代码评审为 `带风险接受` | 只有匹配用户风险授权时进入 `dev-finish-branch`；否则 `awaiting_human_risk_decision` |
| 代码评审为 `证据不足` | 有新补证动作且预算可用时回 `dev-verify-change`；否则进入对应阻塞或 `no_progress` 终态 |
| 收口为 `可交付` | `completed` |
| 收口为 `需清理后重验` | 仅任务自有改动可安全清理时预占 repair 后回 `dev-build-change`；否则 `awaiting_human` |
| 收口为 `审批或证据失效` | 使旧结论失效，停止为 `awaiting_human` 并给出最早恢复阶段 |
| 收口为 `等待人工` | `awaiting_human` |
| 任一交付阶段发现需求/方案/测试清单缺陷 | 使相关审批失效，停止为 `awaiting_human` 并给出最早恢复阶段 |
| 任一阶段需要用户决定是否接受精确风险 | `awaiting_human_risk_decision` |
| 必需依赖、权限、服务或测试设施不可用 | `blocked_infrastructure` |

本次运行的终态统一为 `completed`、`budget_exhausted`、`no_progress`、`inconsistent_review`、`blocked_material`、`blocked_infrastructure`、`awaiting_human` 或 `awaiting_human_risk_decision`。原因分类和恢复条件统一按 `references/run-state-and-resume.md`；进入终态即停止自动动作并追加 checkpoint。`completed` 只表示收口为“可交付”，不授权 commit、push 或部署。

### 8. 使过期审批失效

- `R` 变化后先做影响分析；受影响的方案和测试清单审批全部失效，无法证明不受影响时按受影响处理
- `S` 变化后方案审批失效，依赖该方案的测试清单及其审批也失效
- `C` 变化后测试清单审批失效
- `B` 因外部变化后，依赖旧代码证据的方案和测试清单审批失效
- finding/限制项的内容指纹、条件或当前阶段绑定变化后，原风险授权失效

失效后路由到最早需要重新产出/审批的阶段。任何设计重新收敛都必须先经过测试清单准备，不能沿用旧清单审批直达交付。

### 9. 执行通用止损

- 对每个标准化 `evidence_gap_id` 最多自动补证 1 次；设计、测试清单和交付每段的 `evidence_auto_attempt_limit` 默认均为 3。任一单 gap 或阶段总次数达上限，或补证后证据摘要未变化，停止为 `blocked_material`；`budget_exhausted` 仅用于修订、重设计、清单修订、交付 repair/transition 等动作预算
- 连续两次在相同治理工作集（交付阶段为同一 `T`）、`change_revision`、finding/限制项指纹和证据摘要上得到相同非终态结果，停止为 `no_progress`
- 同一失败指纹在一次修复后再次出现，且没有足以改变定位或下一动作的新证据，停止为 `no_progress`
- 同一未变化输入得到互相矛盾的严重度或结论，停止为 `inconsistent_review`
- 用户精确授权带来的合法 `Accepted` 状态变化属于新状态；它不是 agent 自动接受，也不触发“findings 未变化”止损

### 10. 每轮输出状态摘要

至少报告：`run_id` 与最新 checkpoint、当前治理工作集、`T/G` 是否已形成、阶段与结论、各计数器 `used/limit`、风险授权状态、证据缺口与单项/总补证次数、下一状态及原因。终止时同时报告终止类型和恢复循环所需的最小外部变化。

## 编排原则

- 自动编排只执行已授权且可验证的阶段转移，不替人接受风险
- 任何正式评审都必须与对应 producer 使用不同运行时 agent；无法隔离时只能做非正式自检并停止门禁，不能降级为同 agent 审批
- 三段分别计数；设计修订、重新设计和交付修复互不折算
- 跳过阶段依赖匹配审批，不依赖“之前做过”的记忆
- 没有新产物、新证据或新授权时，不重复相同动作
- 恢复同一 run 时校验 checkpoint 链并保留全部已用计数；预算调整只能追加用户授权记录，不能重置计数
- 任务过大时可调用 `build-codeagent`；并行 producer 只能修改互不重叠的文件或使用隔离 worktree，子 agent 不得再次委派，也不得绕过本状态机、治理工作集和交付 `G`
- 开发执行清单由 `dev-build-change` 生成和修订；auto-loop 只校验覆盖、记录状态并按依赖派发，不把 DEV 升级为新审批门禁

## 结果要求

最终结果必须能回答：当前 run/checkpoint 是什么、治理工作集与 `T/G` 是否已形成、哪些审批仍有效、为什么发生每次路由、预算消耗多少、为何完成或停止，以及满足什么外部变化后从哪个阶段恢复。
