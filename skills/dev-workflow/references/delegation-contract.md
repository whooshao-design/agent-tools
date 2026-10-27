# 独立评审委派契约

本文件定义 Claude Code 与 Codex 共用的正式评审委派契约。它只治理 agent 身份、有效权限、机器可校验结果和编排记录；领域评审方法与结论由对应 skill 定义，审批记录身份由 `artifact-identity.md` 定义。

## 1. 身份与产出溯源

独立性是 **reviewer 的属性**：要证明的是「评审者不是产出者」，因此身份强度按角色分级——reviewer 必须平台可验证，producer 只需可稳定标识。对 producer 施加同等的不可伪造要求，在单会话本地工作流里没有对应的攻击面，只会阻塞合规的评审。

- 编排器必须为每个待评对象保存全部 `producer_agent_refs[]`。任何创建或实质修改该对象的 agent 都是 producer。
- **`reviewer_agent_ref` 必须是派发工具或平台运行时返回的不透明实例标识**，不是角色名、模型名、prompt、skill 名或模型自报 ID；只能在 spawn 返回或运行结束后由编排器可信附着，不是派发信封字段，也不由 reviewer 输出。
- **`producer_agent_refs[]` 只需可稳定标识、可重新指认**，不要求不可伪造。subagent 使用平台返回的实例 ID；根 agent 直接产出时使用稳定的会话级 ref（如 `/root`），并在执行记录中说明该 ref 的强度限制。纯用户或外部原始产物可使用空 producer 列表。
- 正式评审要求 `reviewer_agent_ref` 平台可验证，且不属于 `producer_agent_refs[]`。reviewer 身份缺失、与任一 producer 相交、或为模型自报身份时，均不能形成审批事实；producer ref 的强度不作为审批前置条件，但必须记录。
- 换模型是质量增强，不是独立性的证明；它降低的是同模型盲区相关，选择规则见 §3.1。

## 2. 只读与有效能力面

- reviewer 只能读取冻结输入与必要代码证据，不得写工作区、修改被评对象、修复代码、提交、推送或继续委派。
- 正式派发前，编排器必须校验实际 runtime sandbox、工具 allowlist 和 MCP surface；配置文件中的声明不能替代运行时检查。
- reviewer 必须处于有效只读 sandbox，且不可访问任何有写入或外部变更能力的工具/MCP。父会话处于全权限/跳过权限模式，或 reviewer 仍能继承写能力 MCP 时，本轮执行必须 `blocked`。
- reviewer 一旦写入即成为新状态的 producer，本轮结果失效；`changed_files` 等模型自报不能作为未写入证明。
- reviewer 返回的 `changed_files` 必须严格为 `[]`。
- 经 `spawn-model-agent` 派发的外部 reviewer 不继承父会话权限，有效能力面由其自身启动参数决定：必须带 `--readonly --tools Read,Grep,Glob`（Claude 通道同时 `--strict-mcp-config`），并以运行流 init 事件记录的实际工具集与 MCP 列表为准；该集合超出 `Read/Grep/Glob` 或 MCP 非空时本轮无效。`codex-vps` 是例外：codex 没有工具白名单，也不输出 init 事件，`spawn_model_agent.py --readonly` 对它改经 `/home/joney/bin/codex-reviewer` 启动（bwrap 只读挂载 home、`-s read-only`、`approval_policy=never`、`--ignore-user-config` 不挂 MCP、禁用 apps），以只读 shell 命令代替 `Read/Grep/Glob`；`persist` 核对实际启动命令是 `codex-reviewer`，且事件流里执行过的工具只有 `shell`（出现 `mcp_tool_call`、`web_search` 或 `file_change` 即无效），执行过的命令原样记入运行记录。其他 `codex-*` 后端没有等价封装，仍不能做正式评审。reviewer 调用会话中不存在的工具时，运行时直接拒绝、不执行，`persist` 把它记入运行记录的 `tool_calls_rejected`，不计为越界；越界判定只看实际执行的工具调用。

### 写入证明

- 正式评审必须使用平台可信的逐 agent 写入事件，或同一监视范围的前后快照，证明 reviewer 的写集合为空；没有可复核证据时 `checks.write_set_empty=false`。
- 使用快照时，编排器必须在派发前，以及 stop 后、写入本轮报告或审批文件前分别采集。监视范围必须显式记录并覆盖 reviewer 可写的工作区根；无法证明覆盖完整时检查失败。Git 工作区优先使用 `artifact-identity.md` 定义的 `repo-snapshot-v1`，比较完整快照指纹而不是要求工作区原本干净；`git status` 为空或 reviewer 自报 `changed_files: []` 都不能替代前后比较。
- 前后快照不一致，或评审期间存在无法归因的并发写入时，本轮结果失效；编排器应先排除并发写入并重新冻结输入。重算后的输入指纹完全相同时才可计为原任务的一次可恢复重试；任一指纹变化都必须创建新任务并按产物失效规则处理。
- 文件快照只能证明监视范围内的文件状态。外部副作用仍必须通过有效工具/MCP surface 和平台运行事件排除，不能由快照结论外推。

### 已知信任边界

现有机制是分层保障，不是平台签名、不可伪造的独立执行证明：静态 reviewer 配置限制能力面，Hook 拦截无效结果信封，编排器再根据平台返回的 runtime ref、实际生效配置、运行事件或前后快照形成审批记录。若平台不能提供其中任一必需事实，本轮必须 `blocked`，不得降级采信编排器或 reviewer 的文字声明。普通跨会话 identity registry 若没有平台可信来源，只能用于追踪，不能证明身份独立。

派发前已经确认平台无法提供可信的 **reviewer** runtime 身份、有效能力面或覆盖完整的写入证明，属于环境级能力缺口：立即 `blocked`，不得创建或重试 reviewer。只有可恢复的单次执行失败——例如偶发派发失败、超时、畸形结果，或已经消除原因的实例级配置问题——才允许在相同冻结输入上换新 reviewer 重试一次；失败原因和环境事实未变化时禁止重试。并发写入或快照变化按“写入证明”规则重新冻结，输入指纹变化时属于新任务而非重试。

## 3. 派发信封与编排运行记录

派发信封只包含 reviewer 开始前已知的事实：

| 字段 | 约束 |
|---|---|
| `task_id` | 本轮稳定 ID；正常评审必须为非空字符串 |
| `role` | 精确 reviewer role |
| `producer_agent_refs[]` | 冻结对象的全部 producer |
| `input_fingerprints` | 冻结输入名到精确指纹的非空映射；文件集产物（如方案的 `solution.md` + `traceability.md`）逐文件列出并附清单指纹（见 `artifact-identity.md` §1.1） |
| `inputs` | 原始需求、冻结产物、必要证据和上一轮待复核 findings；方案评审还包括读者测试结果 `reader-test/agent-v<N>.md`，复审时包括上一版与当前版的 diff、触达标题列表和 `resolution.md`；代码评审可包括编排器生成的外部评审证据（如 `ocr` 结果）与可评审文件清单，它们是候选线索和覆盖基线，reviewer 不得直接采信其结论 |
| `runtime_requirements` | 只读 sandbox、工具/MCP 禁限和禁止嵌套委派 |

信封不得包含尚未产生的 `reviewer_agent_ref`，也不得传 producer 的推理过程或预期结论。

spawn/stop 后，编排器另外生成可信运行记录，至少包含：派发信封、实际 `reviewer_agent_ref`、实际角色、sandbox、有效工具/MCP surface、写入证明的方法与证据引用、原始 `delegation-result-v1` 及其指纹和 `structure_check`。只有身份、权限、写入、输入和结果结构全部通过，领域结论才有效。

有效的否决结论是正常评审结果，应回 producer 修订，不能更换 reviewer 刷取通过。编排器把 reviewer 的每条 finding 对照产物原文归入四类之一（按此优先级）：契约或输入误读（冻结输入不清导致，先补输入再复审）、成立需修（回 producer）、成立但接受取舍（显式记录并按风险授权流程处理）、噪音（reviewer 缺少上下文，记下并把该上下文补进下一轮信封）。reviewer 的输出是数据不是裁决，编排器不得不读原文就照单接受，也不得因“它是独立的”就放弃归类。

归类后的路由由编排器直接执行，不询问用户“要不要改”：成立需修的 finding 交回 producer 修订（编排器自己就是 producer 时直接修订），写处置记录，补齐复审所需材料后派发下一轮；契约误读与噪音补进下一轮信封。只有以下事项属于用户决策，才停下来问：接受未修正的 Medium 及以上风险（风险授权）；裁定范围事实源；改变需求范围或验收标准；在产品行为明显不同的修复方案之间选择。只剩 Low 时按对应 skill 的规则作为后续建议，不为改措辞重开审批。执行失败是否可重试以“已知信任边界”的恢复性判定为准；环境级能力缺口直接阻塞，只有可恢复的单次执行失败可在相同冻结输入上换新 reviewer 重试一次；再次失败时本轮执行状态记为 `formal_reviewer_unavailable`，不生成领域结论。各评审 skill 的“先确认执行状态为 `valid`”即指本节规则。

用户对 finding 作出的风险授权属于新增冻结输入，不是编排器改写旧结论的许可。旧 `report.md`、`delegation-result.json` 和 `approval-record.json` 均不可修改；编排器必须生成新的 `task_id` 和 `round`，把原冻结对象与授权记录一并派发给独立 reviewer，由新一轮 reviewer 判断是否满足 `Accepted` 或有条件通过。没有新一轮有效结果时，旧结论保持不变。

### 3.1 reviewer 选择

每轮正式评审派发前，编排器让用户选择 reviewer 模型，而不是默认使用与 producer 相同的模型：

1. 运行 `python3 /home/joney/projects/ai/agent-tools/skills/common/spawn-model-agent/scripts/spawn_model_agent.py --list`，候选只取宿主通道（Claude Code 取 `claude-*`，Codex 取 `codex-*`）中评审分为满分或最高档的后端，`codex-vps` 例外：它经 `codex-reviewer` 在两个宿主下都能做正式评审（见 §2），且是唯一非 Anthropic 的前沿模型，producer 是 Claude 模型时作为异厂商选项固定列出（评审分按 `--list` 当前值标注）；未测、低分或适用性备注不适合多缺陷评审的后端不进默认选项（用户点名时照常可用）。后端背后的模型可由用户随时在 profile 中更换：`--list` 显示的是当前配置的模型，与评审基准模型（`review_test_model`）不同时分数标为“未测”，该后端按未测处理。与 producer 同 provider 的后端不作推荐项。
2. 用选择题列出 2～3 个候选（模型、评审分、关键备注），推荐项放第一位并写明理由；另外固定提供“同模型子 agent（`agent-tools-*-reviewer`）”和“双评审（推荐项 + 同模型子 agent）”两项。推荐项按评审分、再按备注中的缺陷捕获记录排序，有可靠性警告（如空返回）时在描述里写出处置。方案评审的核心机制涉及缓存、并发、状态流转或外部依赖失败处理时，推荐项改为“双评审”，因为单个 reviewer 对隐含前提的漏检在实战中出现过；用户仍可选单评审。`--list` 的“实战”列（§3.2 评审记录）只在同一阶段累计不少于 5 轮有效记录后参与同分排序，样本不足时只展示；实战记录出现漏检或模型版本更新时，提示用户用 `build-codeagent/scripts/backend_eval.py` 重跑基准，不据实战记录单独换模型。
3. 同一需求已有用户选择时，后续轮次与后续阶段默认沿用（`--selected-by carried-over`），不再重复提问；复审中途换 reviewer 会让 findings 口径不一致，只在用户明确要求时更换。沿用来源是最近一轮审批记录的 `reviewer` 字段。
4. 无人值守编排（如 `dev-auto-loop`）不提问：沿用该需求已有选择，否则用推荐项，并以 `--selected-by default-unattended` 记入审批记录。

外部 reviewer 的执行步骤：`review_round.py task` 生成任务文本（角色提示 + 评审 skill + 信封路径），以 `spawn_model_agent.py --backend <后端> --readonly --tools Read,Grep,Glob --cwd <代码仓库> --task @<任务文件>` 运行，前后快照照常采集，结束后 `review_round.py persist --spawn-job <作业目录>` 收口。`reviewer_agent_ref` 记为 `spawn:<后端>:<会话 ID>`，会话 ID 取自后端 CLI 运行时输出，不由模型自报。结果为空或畸形属于可恢复的单次执行失败，按 §3 在同一后端重试一次；不得静默换模型重跑，换模型须经用户选择。

双评审时两个 reviewer 使用同一信封并发执行，次 reviewer 先以 `persist --slot secondary` 落盘，主 reviewer 再生成审批记录。两者都必须执行有效；结论取较严者，findings 由编排器合并归类后写入同一 `findings.json`。

### 3.2 评审记录（reviewer 实战表现）

编排器归类 findings 时，在 `findings.json` 的每条 finding 上写 `classification`（`成立需修` / `接受取舍` / `契约误读` / `噪音`）；`契约误读` 与 `噪音` 必须在 `evidence` 写出原文位置，`persist` 对缺分类或缺证据的 findings 拒绝生成审批记录。双评审时用 `found_by`（`primary` / `secondary`）标出由谁提出。后续轮次、代码评审或验证发现 Medium 及以上问题，且该问题在某个已通过版本中已经存在时，在新 finding 上写 `escaped_from: <那轮 approval_id>`，记作那轮 reviewer 的漏检。

`persist` 据此向本机 `~/.local/state/agent-tools/reviewer-ledger.jsonl` 追加每个 reviewer 一行（模型、阶段、轮次、复核模式、执行是否有效、无效原因、按分类与严重度的计数、往轮带入数、待抽查条目、漏检引用、耗时与 token）；该文件含需求名，不进仓库。已落盘的轮次可用 `review_round.py ledger` 补记。

- 复审信封里沿用往轮 ID 的 finding（无论 Open 还是 Resolved）只计入"往轮带入"，不重复计分；分类计数只覆盖本轮首次提出的 finding。
- reviewer 的身份、只读、工具面和结果结构全部通过，仅因前后快照不一致而作废的轮次，无效原因记为 `environment`：它由其他写入方造成，照常计入该 reviewer 的实战，不记"无效"；其余无效轮次记为 `reviewer`。环境作废仍不能形成审批事实，按 §2 重新冻结。
- `persist` 与 `ledger` 收口时在终端打印本轮评分卡（reviewer 与模型、选择方式、执行状态、本轮新提出的分类计数、往轮带入数、待抽查条目、该后端累计实战）。评分卡同时写入 `rounds/round-<N>/scorecard.md`；编排器每轮向用户汇报时原样粘贴该文件内容，不改写、不删行，不等用户追问。编排器往往也是产出者，判定 reviewer 意见为噪音存在利益冲突，评分卡中的 `噪音` 与 `契约误读` 条目就是供用户抽查的清单。

## 4. `delegation-result-v1`

reviewer 最后一段必须是且只能是以下 JSON fenced block；之后不得追加正文：

```json
{
  "schema": "delegation-result-v1",
  "task_id": "<派发信封 task_id>",
  "role": "<reviewer role>",
  "status": "complete",
  "input_fingerprints": {
    "<input-name>": "<exact fingerprint>"
  },
  "conclusion": "<对应 skill 的唯一结论>",
  "changed_files": [],
  "unresolved": []
}
```

所有状态都必须保留上述 8 个字段：

- `schema` 固定为 `delegation-result-v1`；`role` 固定为被派发角色；`changed_files` 固定为 `[]`。
- `status=complete` 时，`task_id` 必须是信封中的非空字符串，`input_fingerprints` 必须逐项原样回显非空映射，`conclusion` 使用对应 skill 枚举。
- `status=blocked` 时，`conclusion=null` 且 `unresolved` 至少包含一个具体阻塞原因。信封有效时仍原样回显 `task_id` 和指纹；正因为信封缺失或损坏而无法回显时，允许 `task_id=null`、`input_fingerprints={}`，不得猜测或伪造。
- `unresolved` 只列未关闭 finding ID、材料缺口 ID 或执行阻塞项；`complete` 且无未决项时为 `[]`。

Hook 只校验这段结果的结构和枚举，包括上述 blocked 例外；它不证明 runtime 身份、权限、写入状态或输入真实性，这些必须由编排器校验。

## 5. 不可变审批记录

reviewer 只产出评审正文和 `delegation-result-v1`。编排器校验完成后，按 `artifact-identity.md` 生成 `approval-record-v1`，并把 runtime 身份与检查结果可信附着。

每轮保存到不可变目录 `rounds/round-<N>/`，目录不可覆盖；reviewer 始终只读，落盘、指纹计算与 runtime 身份附着由编排器在 stop 后完成：

- `report.md`：本轮评审正文；计算并记录精确指纹。
- `delegation-result.json`：原始结构化结果；计算并记录精确指纹。
- `approval-record.json`：绑定输入、结论、两份指纹、producer/reviewer 身份和 runtime checks。

handoff 必须引用 `approval-record.json` 的 ref 与 fingerprint。冻结、快照与审批记录由 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/scripts/review_round.py` 生成，各评审 skill 不手写这些文件。顶层 `review.md` 只能是当前轮展示或指针，不是审批事实源，覆盖它不会改变历史记录。

## 6. 角色与结论枚举

| role | 对应 skill | `complete` 时允许的 conclusion |
|---|---|---|
| `agent-tools-requirements-reviewer` | `requirements-review` | `通过` / `有条件通过` / `不通过` / `材料不足` |
| `agent-tools-solution-reviewer` | `dev-review-solution` | `通过` / `有条件通过` / `修改后复审` / `退回重设计` / `材料不足` |
| `agent-tools-test-design-reviewer` | `dev-review-test-cases` | `通过` / `修改后复审` / `方案缺口` / `材料不足` |
| `agent-tools-change-reviewer` | `dev-review-change` | `可继续推进` / `修复后再评` / `带风险接受` / `证据不足` |
