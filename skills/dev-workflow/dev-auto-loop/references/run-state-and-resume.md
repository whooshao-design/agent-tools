# 自动循环运行状态与恢复契约

供 `dev-auto-loop` 保存可恢复状态、解释 producer 执行结果和恢复终态时使用。本文件只治理运行事实；产物、审批和 reviewer 身份仍分别遵循 `artifact-identity.md` 与 `delegation-contract.md`。

## 1. 不可变运行身份

每次显式启动创建新的 `run_id`，默认目录为：

```text
auto-loop/
├── status.md
└── runs/<run-id>/
    ├── run.json
    └── checkpoints/step-<N>.json
```

- `run.json` 是不可变 `auto-loop-run-v1`，至少记录 `run_id`、`governance_path=approved`、初始 `R/B`、各预算上限、用户预算覆盖引用、工作区范围和创建时间。
- `step-<N>.json` 是不可变 `auto-loop-checkpoint-v1`；`N` 从 1 开始连续递增，不覆盖、不复用。
- `status.md` 只展示当前摘要，并指向最新 checkpoint 的 `{ref,fingerprint}`；它可以更新，但不能作为计数、审批或恢复事实源。
- checkpoint 本身不包含自己的 fingerprint。下一个 checkpoint 记录前一个 checkpoint 的 `{ref,fingerprint}`，最新指纹由 `status.md` 和 handoff envelope 外部保存，形成可校验链。

每个 checkpoint 至少包含：

| 字段 | 内容 |
|---|---|
| `schema/run_id/sequence` | 固定 schema、运行身份和单调序号 |
| `previous` | 上一步 `{ref,fingerprint}`；首步为 `null` |
| `bound_state` | 当前 `R/S/C/B`、审批、`G/change_revision` 及各自指纹 |
| `stage/result` | 当前阶段、阶段结果和标准化原因 ID |
| `budgets` | 所有计数器的 `used/limit`，包括各段补证总次数 |
| `evidence` | 缺口 ID、事实指纹、每缺口次数、阶段总次数和证据摘要 |
| `delivery_work` | 交付段 DEV 清单引用/摘要、依赖与状态、预计/实际写集、producer refs；非交付段为 `null` |
| `actors` | producer/reviewer runtime refs 与执行检查引用 |
| `transition` | guard、失效项、计数变化、目标状态和路由原因 |
| `progress_key` | 用于 `no_progress` / `inconsistent_review` 比较的规范化键 |
| `resume` | 终态、最早恢复阶段和要求的最小外部变化 |

执行有预算成本或写能力的动作前，先原子写入 checkpoint，记录计数预占和 `action_started=true`，再启动动作；进程中断不能通过重放逃避预算。派发在动作真正启动前失败时不预占领域预算。

## 2. Producer 阶段结果

auto-loop 调用的方案生成、清单编写和代码构建统一返回 `producer-stage-result-v1`。它不由 reviewer Hook 校验，由编排器绑定实际 runtime `agent_ref`、工作区事件和输出指纹后解释。

最少字段为：`schema`、`run_id`、`task_id`、`stage`、`status`、`outcome`、`input_fingerprints`、`output_artifacts`、`changed_files`、`evidence_gap_ids`、`unresolved`。`status` 只能取 `complete`、`blocked` 或 `failed`：`produced` 对应 `complete`，各类等待/阻塞对应 `blocked`，`execution_failed` 对应 `failed`。

运行时 `agent_ref` 不属于 producer 自报结果字段，由编排器从平台元数据可信附着。`changed_files` 也只是 producer 声明，编排器必须用工作区事件或前后快照核对实际写集与输出指纹；不一致时按 `execution_failed` 处理。

代码构建结果还必须在 `output_artifacts` 或等价阶段摘要中返回本次 `DEV-*` 的来源、最终状态、实际写集和完成条件证据；
编排器核对后写入 `delivery_work`。DEV 是构建执行状态，不是新的审批身份；单个构建 attempt 内的 DEV 状态 checkpoint
不增加 repair/transition 计数。

`outcome` 只能取：

| outcome | 路由 |
|---|---|
| `produced` | 输出存在、指纹可重读且 producer refs 完整时进入下一门禁 |
| `upstream_gap` | 记录根因与证据；不能由 producer 自评直接推翻已有审批 |
| `blocked_material` | 在当前段补证预算内取得新材料，否则进入同名终态 |
| `blocked_infrastructure` | 停止自动动作，等待依赖、权限、服务或执行后端恢复 |
| `awaiting_human` | 停止并列出必须由用户作出的业务或范围决策 |
| `execution_failed` | 不解释领域结论；按执行证据决定一次安全重试或停止 |

producer 在形成稳定产物前发现上游缺口时：

- 方案阶段的需求缺口进入 `awaiting_human`；需求修订后使受影响下游状态失效。
- 清单阶段若仍能形成稳定 `C`，保留缺口并交独立 test-design reviewer 判断；无法形成稳定 `C` 时，把新证据交独立 solution reviewer 复核同一 `(R,S,B)`。只有有效正式结论才能使方案审批失效并消费设计预算。
- 交付阶段发现需求、方案或清单缺口时进入 `awaiting_human`，只报告最早恢复阶段，不自动跨段回跳。

producer 派发失败且尚未启动写能力动作、工作区没有变化时，可在相同输入上重试一次；再次失败则进入 `blocked_infrastructure`。动作已经启动或出现部分写入时保留现场，进入 `awaiting_human` 等待工作区归属/恢复决定，不盲目重试。已启动的设计修订、清单修订或交付修复均消费对应 attempt 预算，即使最终没有形成有效产物。

## 3. 补证预算

除“每个 `evidence_gap_id` 最多自动补证 1 次”外，每段还维护 `evidence_auto_attempt_count`，默认上限均为 3：

- `design.evidence_auto_attempt_count`
- `test_cases.evidence_auto_attempt_count`
- `delivery.evidence_auto_attempt_count`

每次真正启动自动补证前预占当前段总次数。任一单 gap 或阶段总次数达到上限都停止为 `blocked_material`；缺口改名但所需事实相同，不获得新次数。只有用户同时指出新的已授权证据来源/动作时才可提高 limit；不能降低到已用值以下或重置 used。`budget_exhausted` 保留给 revision/redesign/repair/transition 等动作预算，不用来掩盖材料缺失。

## 4. 终态与恢复

进入终态后不再自动派发或修改文件。恢复前先重读 `run.json`、校验 checkpoint 链、重算当前产物/审批指纹，并确认 `resume` 要求的外部变化真实发生；同一 run 的所有已用计数保持不变。

| 终态 | 最小恢复条件 |
|---|---|
| `budget_exhausted` | 用户明确提高对应 limit；追加 checkpoint，不重置 used |
| `blocked_material` | 所需材料出现且证据摘要/指纹变化；或用户提供新证据来源并显式提高补证 limit |
| `blocked_infrastructure` | 依赖、权限、服务或执行后端状态发生可验证变化 |
| `awaiting_human` | 用户完成指定业务、范围或工作区归属决策 |
| `awaiting_human_risk_decision` | 用户对精确 finding/限制项及当前绑定作出决定 |
| `no_progress` | 产物、证据、授权或可执行动作至少一项实质变化 |
| `inconsistent_review` | 人工裁决矛盾来源，或冻结输入/证据发生实质变化 |
| `completed` | 不恢复；新的开发动作创建新 run |

风险授权属于新冻结输入：设计或代码正式评审必须创建新的 `task_id`、round 和 reviewer 结果；不得改写旧结论，也不消费设计修订或交付 repair 预算。验证限制项授权在 `G/change_revision` 未变时可通过新 checkpoint 继续，否则重新验证。

终态原因统一分类：缺文档或数据为 `blocked_material`；依赖、权限、服务或 agent 后端不可用为 `blocked_infrastructure`；业务/范围选择为 `awaiting_human`；风险接受选择为 `awaiting_human_risk_decision`。

`completed` 仅表示 `dev-finish-branch` 已得出“可交付”，不自动授权 commit、push、部署或其他外部变更。
