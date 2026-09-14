---
name: build-codeagent
description: Use when `dev-build-change` 或 `dev-auto-loop` 已确认任务边界，需要派发多后端 producer 执行改动，或派发与产物生成者身份隔离的正式 reviewer。
metadata:
  version: 1.5.0
---

# build-codeagent

## 定位

用于作为 `dev-build-change` 和 `dev-auto-loop` 的执行后端增强，统一派发 codeagent producer 和独立 reviewer。

它负责约束任务信封、运行时身份、权限、超时、并行和失败处理，不替代开发主入口的业务判断或正式评审 skill 的专业判断。

正式评审委派统一遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/delegation-contract.md`。
作为 `dev-auto-loop` 后端时，producer 结果、预算预占和恢复统一遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-auto-loop/references/run-state-and-resume.md`。

后端选择与实测能力画像见本目录 `model-routing.json`，由 `scripts/pick_agent.py` 执行，见下方「选后端」。

## When to Use

适合以下场景：
- 较大或长耗时改动需要交给 producer 执行
- 需要并行处理写集不相交的实现任务
- 需求、方案、测试清单或代码需要由独立 reviewer 正式评审
- 需要在 Codex、Claude 或其他已接入后端间统一超时和失败处理

不适合以下场景：
- 小改动可由当前主流程直接完成，且不涉及独立评审门禁
- 需求或方案尚未稳定，不适合放大执行
- 只是做一般搜索、问答或轻量修改，不需要 codeagent

## 两种模式

### producer

- 在允许路径和工具内创建或修改产物，完成后由编排器把实际 runtime `agent_ref` 加入 `producer_agent_refs[]`
- 从 `dev-build-change` 派发代码任务时，开发执行清单遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-build-change/references/development-checklist.md`；每个信封只消费一个已定义 `DEV-*`，后端不得自行拆分、合并、改写来源或扩展范围
- `producer_agent_refs[]` 必须可稳定标识、可重新指认：subagent 用平台返回的实例 ID，根 agent 直接产出时用稳定的会话级 ref 并记录其强度限制；不能把角色名或会话描述充当 producer 身份。producer ref 的强度不是审批前置条件，reviewer 侧的平台可验证性才是（见 `delegation-contract.md` §1）
- 多个 producer 并行写入时，必须能证明文件写集不相交，或为每个任务使用隔离 worktree；无法证明时串行
- 隔离 worktree 的结果由编排器按依赖顺序吸收，不让两个 agent 直接竞争同一文件

### reviewer

- reviewer 的实际 runtime `agent_ref` 必须与全部 `producer_agent_refs[]` 不相交；角色名、昵称、新上下文或模型自报都不能证明身份独立
- reviewer 严格只读，不修改产物、代码或工作区；一旦发生写入，该 agent 即成为新 producer，本轮评审失效
- reviewer 使用对应正式评审 skill，并按 `delegation-result-v1` 返回结果；没有可验证的独立 reviewer 或有效能力面不是严格只读时不得降级为正式评审

运行时身份由编排器从派发工具返回值或平台元数据记录，不信任 agent 在正文或结果中自报的 ID。`reviewer_agent_ref` 只能在 spawn/stop 后写入编排运行记录，不属于派发信封。

## Task envelope

每次派发前固定一份信封，至少包含：

| 字段 | 要求 |
|---|---|
| `task_id` | 本次派发的稳定唯一 ID |
| `mode` / `role` | `producer` 或 `reviewer`，以及精确角色名 |
| 冻结输入与 `input_fingerprints` | 输入引用、版本和精确指纹；重试时不得变化 |
| `producer_agent_refs[]` | 当前产物的全部实质生成者，由编排器维护 |
| `development_item` | 代码 producer 必填：单个 DEV ID、来源、依赖已满足证据、目标、预计写集、完成条件和验证入口 |
| 允许路径 / 工具 | 最小文件边界和工具 allowlist；reviewer 只读 |
| 成功标准 | 可观察的完成条件和必需验证 |
| `result_schema` | reviewer 固定为 `delegation-result-v1`；auto-loop producer 固定为 `producer-stage-result-v1`，其他 producer 使用调用方声明的结构 |
| `timeout` | 明确时限及超时后的停止条件，不依赖隐式默认值 |

信封还应说明禁止删除、工作区外操作和凭据输出。所有子 agent 均禁止再次委派；只有当前编排器可以创建、重试或停止子 agent。

reviewer 信封不得包含尚未产生的 `reviewer_agent_ref`。编排器在 spawn/stop 后另建运行记录，可信附着实际 agent ref、sandbox、有效工具/MCP surface、`checks.write_set_empty` 的运行事件或前后快照证据，以及结果指纹。父会话全权限、reviewer 可访问写能力 MCP 或无法证明未写入时必须 `blocked`；`changed_files=[]` 不能作为未写入证明。

`delegation-result-v1` 的 `blocked` 结果仍保留固定 8 字段；若信封本身缺失或损坏，允许诚实返回 `task_id=null`、`input_fingerprints={}`，同时要求 `conclusion=null`、`unresolved` 非空。Hook 只校验结构，身份、权限、写入和输入真实性仍由编排器校验。

## 失败与重试

- reviewer 给出有效的“不通过”“修改后复审”等领域结论，属于成功完成的评审执行；按 finding 路由回 producer，禁止更换 reviewer 刷取通过
- 派发失败、超时、身份无法验证、实际能力面不只读、结果 schema 无效或 reviewer 发生写入，属于执行失败
- 只有执行失败可在完全相同的冻结输入和 fingerprints 上换一个新的 reviewer 重试一次；编排器重新记录并校验其 runtime `agent_ref`
- 第二次执行仍失败时停止并报告恢复条件；输入发生变化时是新评审任务，不算原任务重试
- producer 的失败按调用方契约处理，不套用 reviewer 的一次重试规则；auto-loop 中仅允许“写动作尚未启动且工作区未变化”的同输入派发安全重试一次，动作已启动或有部分写入时保留现场并停止盲目重试

## 选后端

不要凭印象挑模型，用脚本：

```bash
python3 /home/joney/projects/ai/agent-tools/skills/common/build-codeagent/scripts/pick_agent.py \
  <环节> --task <任务ID> [--material <材料目录>] [--exclude 后端1,后端2] [--json]
python3 .../pick_agent.py --task <任务ID> --show-record    # 查看该任务已选过谁
```

它读 `model-routing.json`，输出选中的后端、解析后的模型名和可直接执行的调用命令，并把这次选择追加到
`~/.local/state/agent-routing/<任务ID>.jsonl`（`AGENT_ROUTING_HOME` 可改）。

`model-routing.json` 记录三块内容：

- `backends`：6 个后端的通道、模型来源、两项实测能力分数、只读能力。`claude-vps` 和 `codex-vps`
  的模型写成 `dynamic:<路径>#<键>`，跟随用户配置，不写死。
- `stages`：11 个环节的候选集与 `artifact` 归属。`evidence` 标 `extrapolated` 或 `untested` 的
  条目表示该环节的候选是外推而非实测，不要当作已验证。
- `rules`：脚本自动执行的规则，不需要人记。

规则要点（完整表述见 JSON）：

- **生成者终身排除**：参与过该 artifact 任一版本生成的后端，后续所有轮次都不能评审它
- **评审者每轮轮换**：优先选该 artifact 上没当过评审者的。实测各模型盲区稳定且互不相同，
  固定评审者会把它的盲区固化成整个流程的盲区
- **轮换必须带上轮 findings**：否则新评审者只会重新发现同样问题，无法核对闭环
- **候选耗尽可复用最早轮次**，但记录中标明本轮为复用
- **修订由原生成者执行**，不重新随机
- **一律不传 `--model`**，用 profile 配置的模型。一个后端=一个模型，因此不存在同厂商跨版本的歧义

## 跨进程派发的两条硬约束

**一、provider 是进程级的，同进程换不到别家模型。** 一个 Claude Code 会话连哪个网关由启动时的
`ANTHROPIC_BASE_URL` 决定；agent 定义只有 `model:` 字段，没有 provider 或 baseUrl。在官方通道里
指定 `qwen3.8-max` 会直接报模型不存在。所以想要不同模型的视角，只能跨进程派发——
进程内 subagent 只能给到上下文隔离，给不了视角多样性。

**二、codex 做评审必须走 `/home/joney/bin/codex-reviewer`。** 裸 `codex exec -s read-only`
不安全：沙箱确实拦住了第一次写入，但 `approval_policy="on-request"` 会自动批准提权并重试成功，
实测能写任意路径。`codex-reviewer` 三层叠加——bwrap 只读牢笼、`approval_policy=never` 断掉提权、
`--ignore-user-config` 不挂载那 21 个 MCP server（其中 bastion 能执行远程命令，且 MCP 子进程
完全在 codex 沙箱之外）。

Claude 系后端做评审必须加 `--strict-mcp-config`，不加会被用户级 MCP 污染工具面导致评审者拒评。

## 使用原则

- codeagent 只执行已定义任务，不负责扩写需求或绕过主流程门禁
- 后端选择服从任务所需能力、只读/写权限和超时要求
- 代码 producer 派发前由编排器确认 DEV 依赖已满足；并行 DEV 的预计写集必须不相交，否则使用隔离 worktree 或串行
- 实际写集超出 DEV 预计边界、发现新依赖或完成条件需要变化时，producer 停止并返回偏差，不自行更新其他 DEV 或继续扩大修改
- 恢复已有 producer 会话时保持后端和任务身份一致；reviewer 执行失败重试必须使用新 agent

## 输出要求

编排结果至少说明：task envelope 摘要、DEV ID（代码 producer）、后端与实际 runtime agent refs、身份隔离、sandbox、有效工具/MCP surface、预计/实际写集、执行状态、完成条件证据、结果 schema 校验、结果指纹、失败类型及重试次数，以及哪些结果可交回主流程。

## 交接建议

- producer 结果回交调用它的设计、清单或构建阶段；auto-loop 只解释校验后的 `producer-stage-result-v1`
- reviewer 结果回交对应正式门禁；编排器保存不可变 round 的报告和委派结果，计算两者指纹并生成 `approval-record-v1`。只有其身份、只读边界、有效工具面、输入指纹和 schema 均校验通过时才可作为正式结论
- 若用于自动循环，由 `dev-auto-loop` 决定是否继续下一阶段
