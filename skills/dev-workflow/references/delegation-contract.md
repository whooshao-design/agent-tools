# 独立评审委派契约

本文件定义 Claude Code 与 Codex 共用的正式评审委派契约。它只治理 agent 身份、有效权限、机器可校验结果和编排记录；领域评审方法与结论由对应 skill 定义，审批记录身份由 `artifact-identity.md` 定义。

## 1. 身份与产出溯源

- 编排器必须为每个待评对象保存全部 `producer_agent_refs[]`。任何创建或实质修改该对象的 agent 都是 producer。
- `agent_ref` 是派发工具或平台运行时返回的不透明实例标识，不是角色名、模型名、prompt、skill 名或模型自报 ID。
- `reviewer_agent_ref` 只能在 spawn 返回或运行结束后由编排器可信附着；它不是派发信封字段，也不由 reviewer 输出。
- 正式评审要求 `reviewer_agent_ref` 可验证且不属于 `producer_agent_refs[]`。身份缺失、相交或模型自报身份均不能形成审批事实。
- 根 agent 若没有平台可验证的 runtime ref，不得直接产出之后需要正式评审的 agent 产物；应把产出交给可追踪的 producer subagent。纯用户或外部原始产物可使用空 producer 列表。
- 换模型是可选的质量增强，不是独立性的证明。

## 2. 只读与有效能力面

- reviewer 只能读取冻结输入与必要代码证据，不得写工作区、修改被评对象、修复代码、提交、推送或继续委派。
- 正式派发前，编排器必须校验实际 runtime sandbox、工具 allowlist 和 MCP surface；配置文件中的声明不能替代运行时检查。
- reviewer 必须处于有效只读 sandbox，且不可访问任何有写入或外部变更能力的工具/MCP。父会话处于全权限/跳过权限模式，或 reviewer 仍能继承写能力 MCP 时，本轮执行必须 `blocked`。
- reviewer 一旦写入即成为新状态的 producer，本轮结果失效；`changed_files` 等模型自报不能作为未写入证明。
- reviewer 返回的 `changed_files` 必须严格为 `[]`。

### 写入证明

- 正式评审必须使用平台可信的逐 agent 写入事件，或同一监视范围的前后快照，证明 reviewer 的写集合为空；没有可复核证据时 `checks.write_set_empty=false`。
- 使用快照时，编排器必须在派发前，以及 stop 后、写入本轮报告或审批文件前分别采集。监视范围必须显式记录并覆盖 reviewer 可写的工作区根；无法证明覆盖完整时检查失败。Git 工作区优先使用 `artifact-identity.md` 定义的 `repo-snapshot-v1`，比较完整快照指纹而不是要求工作区原本干净；`git status` 为空或 reviewer 自报 `changed_files: []` 都不能替代前后比较。
- 前后快照不一致，或评审期间存在无法归因的并发写入时，本轮结果失效；编排器应先排除并发写入并重新冻结输入。重算后的输入指纹完全相同时才可计为原任务的一次可恢复重试；任一指纹变化都必须创建新任务并按产物失效规则处理。
- 文件快照只能证明监视范围内的文件状态。外部副作用仍必须通过有效工具/MCP surface 和平台运行事件排除，不能由快照结论外推。

### 已知信任边界

现有机制是分层保障，不是平台签名、不可伪造的独立执行证明：静态 reviewer 配置限制能力面，Hook 拦截无效结果信封，编排器再根据平台返回的 runtime ref、实际生效配置、运行事件或前后快照形成审批记录。若平台不能提供其中任一必需事实，本轮必须 `blocked`，不得降级采信编排器或 reviewer 的文字声明。普通跨会话 identity registry 若没有平台可信来源，只能用于追踪，不能证明身份独立。

派发前已经确认平台无法提供可信 runtime 身份、有效能力面或覆盖完整的写入证明，属于环境级能力缺口：立即 `blocked`，不得创建或重试 reviewer。只有可恢复的单次执行失败——例如偶发派发失败、超时、畸形结果，或已经消除原因的实例级配置问题——才允许在相同冻结输入上换新 reviewer 重试一次；失败原因和环境事实未变化时禁止重试。并发写入或快照变化按“写入证明”规则重新冻结，输入指纹变化时属于新任务而非重试。

## 3. 派发信封与编排运行记录

派发信封只包含 reviewer 开始前已知的事实：

| 字段 | 约束 |
|---|---|
| `task_id` | 本轮稳定 ID；正常评审必须为非空字符串 |
| `role` | 精确 reviewer role |
| `producer_agent_refs[]` | 冻结对象的全部 producer |
| `input_fingerprints` | 冻结输入名到精确指纹的非空映射 |
| `inputs` | 原始需求、冻结产物、必要证据和上一轮待复核 findings |
| `runtime_requirements` | 只读 sandbox、工具/MCP 禁限和禁止嵌套委派 |

信封不得包含尚未产生的 `reviewer_agent_ref`，也不得传 producer 的推理过程或预期结论。

spawn/stop 后，编排器另外生成可信运行记录，至少包含：派发信封、实际 `reviewer_agent_ref`、实际角色、sandbox、有效工具/MCP surface、写入证明的方法与证据引用、原始 `delegation-result-v1` 及其指纹和 `structure_check`。只有身份、权限、写入、输入和结果结构全部通过，领域结论才有效。

有效的否决结论是正常评审结果，应回 producer 修订，不能更换 reviewer 刷取通过。执行失败是否可重试以“已知信任边界”的恢复性判定为准；环境级能力缺口直接阻塞，只有可恢复的单次执行失败可在相同冻结输入上换新 reviewer 重试一次。

用户对 finding 作出的风险授权属于新增冻结输入，不是编排器改写旧结论的许可。旧 `report.md`、`delegation-result.json` 和 `approval-record.json` 均不可修改；编排器必须生成新的 `task_id` 和 `round`，把原冻结对象与授权记录一并派发给独立 reviewer，由新一轮 reviewer 判断是否满足 `Accepted` 或有条件通过。没有新一轮有效结果时，旧结论保持不变。

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

每轮保存到不可变目录 `rounds/round-<N>/`：

- `report.md`：本轮评审正文；计算并记录精确指纹。
- `delegation-result.json`：原始结构化结果；计算并记录精确指纹。
- `approval-record.json`：绑定输入、结论、两份指纹、producer/reviewer 身份和 runtime checks。

handoff 必须引用 `approval-record.json` 的 ref 与 fingerprint。顶层 `review.md` 只能是当前轮展示或指针，不是审批事实源，覆盖它不会改变历史记录。

## 6. 角色与结论枚举

| role | 对应 skill | `complete` 时允许的 conclusion |
|---|---|---|
| `agent-tools-requirements-reviewer` | `requirements-review` | `通过` / `有条件通过` / `不通过` / `材料不足` |
| `agent-tools-solution-reviewer` | `dev-review-solution` | `通过` / `有条件通过` / `修改后复审` / `退回重设计` / `材料不足` |
| `agent-tools-test-design-reviewer` | `dev-review-test-cases` | `通过` / `修改后复审` / `方案缺口` / `材料不足` |
| `agent-tools-change-reviewer` | `dev-review-change` | `可继续推进` / `修复后再评` / `带风险接受` / `证据不足` |
