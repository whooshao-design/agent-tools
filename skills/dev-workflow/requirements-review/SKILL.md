---
name: requirements-review
description: "评审已有产品或技术需求文档（PRD/需求单/接口需求），独立检查边界、异常、验收标准、风险和依赖是否完整。Use when 用户要求评审需求文档、PRD 评审、规格评审，或主流程需要在方案设计前形成稳定的需求身份 R。"
metadata:
  version: 1.7.1
---

# requirements-review

## 定位

用于独立评审已有 PRD、需求单、接口需求或规格文档的完整性与可验收性。

它不是默认研发主线门禁，因此保留文档评审型名称 `requirements-review`；不替代 `dev-clarify-task` 收敛任务，也不评审技术实现方案。用户请求评审现成需求，或主流程转入需求评审时使用。

## 默认产物目录

正式评审每轮写入 `/home/joney/docs/requirements-development/<requirement-name>/requirements-review/rounds/round-<N>/`，`report.md` 使用 `references/report-template.md`；轮次文件、不可覆盖、`review.md` 只是指针与 `approval-record-v1` 生成规则见委派契约 §5。只需对话结论时不创建文件，但仍须形成可引用、可计算指纹的等价消息记录。

## When to Use

适合：已有 PRD、需求单或接口需求文档，需要独立判断能否进入方案设计或验收；需求修订后复审。

不适合：需求还没写出来、只有口头描述（转 `dev-clarify-task` 收敛）；要评审的是技术方案（转 `dev-review-solution`）或代码（转 `dev-review-change`）。

## 输入契约

至少固定：

- 需求文档引用、版本或内容指纹、内容摘要和本轮评审范围
- 业务背景、目标、范围与非目标
- 依赖系统、上线时间、兼容、数据和回滚约束
- 上一轮未关闭 findings 与风险授权（复审时）
- 需求内容的全部 `producer_agent_refs[]`

需求身份、内容指纹和风险授权遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/artifact-identity.md`。无法稳定标识评审对象，或关键业务规则缺失到无法判断时，结论为 `材料不足`，不得自行补造规则。

正式评审必须由 `agent-tools-requirements-reviewer` 或满足同一契约的独立 agent 执行，并遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/delegation-contract.md`。身份、只读、写入、工具面和结果结构的准入只以该契约为准；任何一项无法由运行时事实证明时，不得形成正式结论。纯用户或外部原始需求的 producer 列表可以为空；根 agent 直接产出时使用可稳定标识的会话级 ref 并记录其强度限制，不构成审批阻塞（见 `delegation-contract.md` §1）。

## Workflow

### 1. 确认目标和边界

明确本轮是判断“是否可开发”“是否可验收”还是仅检查指定章节；不把需求评审扩大成技术方案评审。

### 2. 分两遍评审

- 编排器先冻结需求输入和指纹，只传原始需求、必要背景证据及上一轮待复核 findings，不传需求编写者的推理或预期结论
- 快速扫描：总结目标、识别阻塞项和主要风险
- 完整评审：按 `references/checklist.md` 核对边界、规则、异常、验收、非功能需求、依赖和发布约束
- 编排器在 reviewer 停止后按委派契约校验运行记录并生成审批事实；本 skill 不重复定义或放宽通用准入条件

### 3. 形成可追踪 findings

每条 finding 使用稳定 ID（如 `RR-001`）和内容指纹，并记录类别、严重度、证据、影响、建议、关闭条件和状态；问题、证据或影响实质变化时更新指纹。

- 类别只取一个最主要的问题域：`目标与范围` / `用户与场景` / `业务规则与状态` / `数据与接口` / `非功能需求` / `验收与测试` / `依赖与发布` / `材料问题`；横跨多个独立问题域时拆成多条 finding
- 严重度：`Blocker`（目标、范围或关键规则缺失/冲突，方案无法启动）/ `High`（某条验收标准、业务规则或异常路径缺失或矛盾，方案与测试会建立在错误前提上）/ `Medium`（表述不精确或边界未定，可由用户对精确 finding 授权后带假设继续）/ `Low`（措辞、格式，不影响判断）
- 状态：`Open` / `Resolved` / `Accepted`
- `Resolved` 必须引用满足关闭条件的新需求版本或补充证据，并经当前轮复核
- `Accepted` 仅用于用户对当前 `R`、精确 Medium finding ID/指纹和条件作出明确授权；Blocker/High 不接受风险放行

### 4. 给出唯一结论

先确认评审执行状态为 `valid`；执行失败的一次重试与 `formal_reviewer_unavailable` 规则见委派契约 §3，有效 reviewer 的“不通过”属于正常结果。

- `通过`：Open Blocker/High/Medium 均为 0
- `有条件通过`：没有 Open Blocker/High，剩余 Medium 均有匹配的用户风险授权
- `不通过`：仍有必须修订的 Blocker/High，或未经授权的 Medium
- `材料不足`：证据不足以判断

风险授权是新的评审输入：编排器按委派契约 §3 新建 `task_id` / `round`，把同一 `R` 与授权记录重新派发独立 reviewer，由新一轮决定是否形成 `有条件通过`。

## 输出要求

默认按“输入绑定 → 结论 → findings → 非规范性验收标准建议 → 风险与依赖 → 后续动作”输出。建议仅用于指出如何消除歧义，不会修改 `R`，也不能被当作新增需求或验收标准。若需求方采纳建议，应由需求方或可追踪 producer 写成新 `R`，再派发新的独立 reviewer。编排器按委派契约 §5 落盘并生成 `approval-record-v1`；handoff 只引用其 ref 与 fingerprint。

## 交接

- 需求仍需业务澄清 → `dev-clarify-task`
- 结论为 `通过`，或风险授权匹配的 `有条件通过` → 以需求引用、版本/内容指纹和摘要组成稳定 `R`，携带验收标准 ID 进入 `dev-design-solution`
- `不通过` → 需求方修订后绑定新版本重新评审
- `材料不足` → 补齐指定材料后继续当前评审
- `formal_reviewer_unavailable` → 补齐独立 reviewer 能力后，在同一冻结输入上重新执行正式评审
