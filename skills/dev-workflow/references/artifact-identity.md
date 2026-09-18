# 研发产物身份与门禁上下文

本文件是 `dev-workflow` 各阶段共享的身份契约。涉及 `R/S/C/B`、`change_revision`、审批或风险授权时均按本文解释；阶段 skill 只补充业务规则，不重新定义身份格式。

## 1. 文档产物身份

`R`（需求）、`S`（方案）和 `C`（测试清单，内部检查项 ID 使用 `TC-*`）都使用以下字段：

| 字段 | 含义 |
|---|---|
| `ref` | 可重新读取的文件路径、文档链接或消息引用 |
| `version` | 产物声明版本；没有版本时明确写 `unversioned` |
| `fingerprint` | `sha256-v1:<hash>`，用于判断内容是否完全相同 |
| `summary` | 一句话语义摘要，只用于阅读，不参与相等判断 |
| `producer_agent_refs` | 对内容有实质产出的运行时 agent 实例引用；纯用户/外部产物为空列表 |

- 本地文件按最终字节计算 SHA-256；指纹保存在 handoff envelope 或审批记录，不写回被散列文件本体
- 对话产物使用消息引用，并对该消息的精确产物正文计算 SHA-256
- 外部文档优先使用平台不可变 revision ID；能导出正文时同时记录导出内容 SHA-256，不能导出时说明证据限制
- `version`、日期、文件名或摘要都不能替代 `fingerprint`；版本相同但指纹变化即视为新产物

### 1.1 文件集产物

一个产物由多个文件构成时（技术方案 `S` = `solution.md` + `traceability.md`），身份增加 `files` 字段：

| 字段 | 含义 |
|---|---|
| `ref` | 文件集所在目录 |
| `files[]` | 每个文件的 `path`（相对 `ref`）与 `fingerprint`（该文件字节的 SHA-256） |
| `fingerprint` | 清单指纹：`files` 按 `path` 字节序排序，每项写成 `path\0fingerprint\n`，对拼接结果计算 SHA-256 |

- 任一文件字节变化都会改变清单指纹，审批绑定清单指纹即绑定全部文件。
- 派发信封的 `input_fingerprints` 逐文件列出，并附清单指纹；reviewer 原样回显。
- 只有一个文件的旧产物是只含一项的文件集，格式不变，历史审批记录不需要改写。
- 归档旧版本时整目录归档（`versions/v<N>/`），保持文件集完整。

## 2. 仓库快照身份

`repo-snapshot-v1` 至少包含：仓库路径、HEAD commit/tree、tracked patch 指纹、未跟踪文件清单指纹、显式排除项。

- tracked patch 使用 `git diff HEAD --binary --full-index --find-renames=50% --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ --submodule=short --ignore-submodules=none --`，对 stdout 原始字节计算 SHA-256；它同时覆盖 staged/unstaged 且保留新增、删除、重命名、模式、二进制和 submodule 变化
- 未跟踪路径来自 `git ls-files --others --exclude-standard -z`；按路径原始字节排序，以 NUL 分隔记录路径、类型、模式和内容 SHA-256（符号链接哈希链接目标字节），再对整个清单计算 SHA-256
- ignored 文件默认排除；若它属于交付范围，必须显式加入清单
- 不在摘要中输出文件内容、凭据或敏感值，只记录路径、类型和指纹

`B` 是实现开始前的 `repo-snapshot-v1`。`change_revision` 是待验证/评审/交付时的新快照，并额外记录 `B`、本任务文件清单、全部实质代码产出者 `producer_agent_refs`，以及各 `DEV-*` 的来源、最终状态、实际写集和执行结果摘要；任何任务外变化也会改变快照，必须重新判断证据是否仍有效。开发执行清单不是独立审批产物，详细规则见 `dev-build-change/references/development-checklist.md`。

## 3. 治理路径与交付门禁上下文

`governance_path` 用于选择研发路径，不是审批结论：

- `governance_path=approved`：进入设计、方案评审、测试清单编写与独立复核的正式路径；这些阶段可以在尚无交付 `G` 时启动。
- `governance_path=direct`：普通任务从未进入正式治理流程，直接执行 build → verify。
- `governance_path=waived`：正式门禁原本适用或已经进入，但用户明确授权跳过指定门禁。

`dev-auto-loop` 只接受 `governance_path=approved`。设计或测试清单阶段只维护当前 `R/S/C/B` 和已有审批，不得提前声称 `G.mode=approved`；只有方案审批精确绑定 `(R,S,B)`、测试清单审批精确绑定 `(R,S,C,B)` 且两者有效后，才可构造交付上下文 `G.mode=approved`。

构建、验证和收口阶段统一传递 `gate_context G`，`mode` 只能取以下三种值：

- `G = {mode: approved, T: (R,S,C,B), approvals}`：两个正式门禁均已完成；`approvals.solution-review` 必须绑定 `(R,S,B)`，`approvals.test-design-review` 必须绑定 `(R,S,C,B)`，并分别引用有效 `approval-record-v1` 的 `{ref,fingerprint}`。
- `G = {mode: direct, D: {ref,fingerprint}}`：`D` 指向不可变 `direct-record-v1`；不产生或暗示方案/测试清单审批事实。
- `G = {mode: waived, W: {ref,fingerprint}}`：`W` 指向不可变 `waiver-record-v1`；只免除记录中明确列出的门禁。

`direct-record-v1` 至少包含：固定 `schema`、稳定任务引用、完成标准、范围/排除范围、实现开始前基线 `B`、选择 direct 的理由、代码评审是否因风险或用户要求而必需，以及创建时间。`direct` 不是低配审批或隐式 waiver；若已经生成正式审批事实或任务明确要求正式治理，不得改成 `direct` 规避门禁。

`waiver-record-v1` 至少包含：固定 `schema`、稳定 waiver ID、当前 `R/S/C/B`（不存在写 `∅`）、`skipped_gates[]`、逐门禁 `gate_waivers`、授权适用范围和创建时间。`skipped_gates[]` 只允许：

- `requirements-review`
- `solution-review`
- `test-design-review`
- `change-review`

依赖闭包必须在形成记录前展开：跳过 `solution-review` 时必须同时跳过依赖其审批的 `test-design-review`；只跳过 `test-design-review` 不会反向豁免 `solution-review`。每个被跳过门禁都必须在 `gate_waivers` 中分别记录用户授权引用、原因、替代证据、残余风险、适用范围、生效条件和到期条件；缺项、未知枚举或闭包不完整时 `W` 无效。用户仅说“继续”或 agent 自行判断不构成 waiver。

`direct-record-v1` 与 `waiver-record-v1` 写入后不可修改，记录本身不包含自己的 fingerprint。handoff 对最终文件或消息字节计算 SHA-256，并以 `{ref,fingerprint}` 放入 `G`，避免自指纹；平台不能提供稳定、可重读的不可变消息引用时，必须保存为不可变文件。判断 `G` 匹配时必须重读记录、校验外部 fingerprint，并逐项核对其中的任务/授权范围、`B`、门禁闭包、替代证据及当前产物；只比较 `mode` 或 record ID 不够。

`direct` 和 `waived` 不进入 `dev-auto-loop`，仅由独立阶段 skill 交付。`waived` 未跳过的适用门禁仍须提供精确匹配的 `approval-record-v1`。

## 4. 不可变审批记录

每次正式评审只能形成一个新的 `approval-record-v1`。推荐目录为 `<review-dir>/rounds/round-<N>/`，其中 `report.md`、`delegation-result.json` 和 `approval-record.json` 在写入后均不可修改；复审必须新建下一轮。顶层 `review.md` 只能展示当前状态或指向最新轮次，不能作为审批事实。

`approval-record.json` 至少包含：

| 字段 | 含义 |
|---|---|
| `schema` / `approval_id` | 固定为 `approval-record-v1` / 全局稳定且不复用的审批 ID |
| `stage` / `round` | 评审阶段，以及从 1 开始、只增不复用的轮次 |
| `bound_inputs` | 冻结的输入与审批键：`R`、`(R,S,B)`、`(R,S,C,B)` 或 `G + change_revision` |
| `conclusion` | 该评审类型允许的正式结论 |
| `producer_agent_refs` / `reviewer_agent_ref` | 全部产出者与编排器记录的真实 reviewer 运行时身份 |
| `checks` | `independence`、`read_only`、`write_set_empty` 和 `tool_surface` 的校验结果及证据引用 |
| `review_execution` | 任务 ID、冻结输入指纹、执行状态和结构校验结果 |
| `report` | 本轮不可变报告的 `ref` 与 `sha256-v1` 指纹 |
| `delegation_result` | 本轮原始 `delegation-result-v1` 的不可变 `ref`（或内联值）与 `sha256-v1` 指纹 |
| `created_at` | 带时区的创建时间；不用于判断内容相等 |

`stage` 取 `requirements-review`、`solution-review`、`test-design-review` 或 `change-review`；`round` 为正整数。`checks` 各项必须记录布尔结论及必要证据引用，不能用 reviewer 自报代替编排器观察；任一必需检查不是 `true` 时不得形成审批事实。

`checks.write_set_empty` 还必须记录证明方法：平台可信的逐 agent 写入事件，或同一监视范围在派发前，以及 stop 后、编排器落盘前的快照引用与指纹。监视范围必须覆盖 reviewer 可写的工作区根。Git 工作区使用 `repo-snapshot-v1` 时允许存在原有未提交改动，但前后完整指纹必须相同；只记录 `git status` 为空、`changed_files: []` 或无证据的布尔值无效。范围覆盖无法证明、快照变化或存在无法归因的并发写入时，该检查必须为 `false`。

记录本身不包含自己的指纹。handoff 中以 `{ref, fingerprint}` 引用 `approval-record.json`，对其最终字节计算 SHA-256；只有 record、报告、委派结果、冻结输入和当前产物全部精确匹配时，审批才有效。结构化对话评审也必须保存为等价的不可变消息/结果引用及指纹，不能只记录结论文本。

## 5. 风险授权

每条授权必须记录 finding/限制项 ID 与内容指纹、授权范围、用户授权引用、生效条件、到期条件和后续动作。身份绑定随阶段逐级加强：

- 需求评审绑定 `R`
- 方案评审绑定 `(R,S,B)`
- 测试清单复核记录原授权绑定，并将复核结论绑定 `(R,S,C,B)`；该审批有效后，编排器才可构造 `T/G`
- 交付阶段的 finding/限制项绑定当前 `G` 和 `change_revision`

上游授权不会自动扩展到下游；下游阶段必须复核其范围和条件，并记录当前阶段绑定。

finding/限制项内容、当前阶段绑定或条件任一变化，旧授权立即失效。Blocker/High 没有风险接受路径；是否允许接受 Medium 由对应阶段规则决定。

## 6. Agent 溯源与独立评审

Agent 实例身份、委派结果和独立性判定统一遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/delegation-contract.md`。正式评审记录必须同时保存 `producer_agent_refs[]`、`reviewer_agent_ref` 和独立性校验结果；`reviewer_agent_ref` 与任一 producer 相同时，只能形成非正式自检，不能形成审批或复核通过事实。

评审者一旦修改被评产物或代码，就成为新 producer：本轮评审立即失效，必须冻结新产物并派发另一个独立 reviewer。
