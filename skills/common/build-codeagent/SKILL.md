---
name: build-codeagent
description: Use when 需求梳理、内容整理、方案、测试或代码需要跨模型生成与轻量互审，或 dev-build-change/dev-auto-loop 需要派发 producer 与独立正式 reviewer。
metadata:
  version: 1.7.0
---

# build-codeagent

## 定位

统一派发跨模型生成者和评审者。普通需求梳理、内容整理与互审使用轻档；`dev-build-change`、`dev-auto-loop` 或正式评审门禁委派使用正式路径。

主会话负责交接、验收与停止判断；脚本只负责候选选择和参与记录，不自动审批内容。

正式评审委派统一遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/delegation-contract.md`。
作为 `dev-auto-loop` 后端时，producer 结果、预算预占和恢复统一遵循 `/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-auto-loop/references/run-state-and-resume.md`。

候选、分数和调用模板见 `model-routing.json`，由 `scripts/pick_agent.py` 执行，见下方「选后端」。

## When to Use

适合以下场景：
- 日常需求梳理、内容整理、方案、测试或代码需要生成者与另一模型交叉检查
- 较大或长耗时改动需要交给 producer 执行
- 需要并行处理写集不相交的实现任务
- 需求、方案、测试清单或代码需要由独立 reviewer 正式评审
- 需要在 Codex、Claude 或其他已接入后端间统一超时和失败处理

不适合以下场景：
- 小改动可由当前主流程直接完成，且不涉及独立评审门禁
- 只是单次搜索或问答，没有跨模型协作需要

## 轻档协作

按 [轻档交接与验收](references/lightweight-collaboration.md) 执行：主会话组装交接材料（目标、事实、假设、未决项、检查项、旧 findings），用脚本预览选模后派发，实际参与后登记，再核对修订与停止条件。

轻档不需要 DEV 清单、身份信封或审批记录；接入已有开发或正式评审流程时仍按那套流程的准入走，互审结果不当正式结论用。

未解决的问题必须跟着材料传到下一轮。连续两轮没有实质改善时暂停，由主会话决定换生成者还是补材料，不能靠换评审者绕过。

## 正式委派的两种模式

本节及 Task envelope、失败重试、使用原则、输出要求、交接建议用于正式委派；选后端与调用边界适用于两条路径。

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
# 预览：输出选中后端、模型和待填调用模板，不写记录
python3 /home/joney/projects/ai/agent-tools/skills/common/build-codeagent/scripts/pick_agent.py \
  <环节> --task <任务ID> [--material <材料目录>] [--exclude 后端1,后端2] [--json]
# 登记：实际参与后追加一条记录
python3 .../pick_agent.py <环节> --task <任务ID> --record <实际后端> [--actual-model <运行模型ID>]
python3 .../pick_agent.py --task <任务ID> --show-record
```

需要 Python 3.11+。记录追加到 `~/.local/state/agent-routing/<任务ID>.jsonl`（`AGENT_ROUTING_HOME` 可改）。排除集只看登记过的记录，所以：

- 已有产物先按对应生成环节逐个 `--record` 补录生成者，否则它可能被选为评审者。评审预览时脚本会提示该产物尚无生成者记录。
- 生成或修订留下实质产出就登记，失败但改了东西也登记；评审拿到有效结论（含「需修订」）就登记；只预览或启动前失败不登记。
- 有运行返回的模型 ID 就用 `--actual-model` 一起登记，没有则记配置值。
- `--exclude` 只对当次预览生效。登记不接受 `--exclude`；登记的评审者若是该产物的生成者会被拒绝。

任务 ID 只能用 Unicode 字母数字和 `-_.`。每个 task 的每种 artifact 只对应一份产物：修订沿用 task，另一份同类产物另建 task；同 task 的选择、调用、登记串行。记录文件有损坏行时脚本停止并报行号，核实后再继续，不要清空历史。

`model-routing.json` 三块内容：

- `backends`：6 个后端的通道、模型来源、评审实测分数、生成能力分档和只读调用要求。`claude-vps` 和 `codex-vps`
  的模型写成 `dynamic:<路径>#<键>`，跟随本机配置。
- `stages`：11 个环节的候选集与 `artifact` 归属。`evidence` 标 `extrapolated` 或 `untested` 的环节，
  候选是外推来的，试运行后再调。
- `rules`：8 条规则。排除、轮换、修订归属由脚本执行；交接、验收、换人判断由主会话负责。

规则要点（完整表述见 JSON）：

- **生成者终身排除**：参与过该 artifact 任一版本生成的后端，后续所有轮次都不能评审它
- **评审者每轮轮换**：优先选该 artifact 上没当过评审者的，同优先级随机
- **轮换必须带上轮 findings**：否则新评审者只会重新发现同样问题，无法核对闭环
- **候选耗尽复用最久未使用者**，`reuse_of_round` 记它上次评审的轮次
- **修订沿用最近的生成者**；它被排除、不可用或连续两轮无改善时用 `--replace-producer '原因'` 换人，旧生成者仍排除
- **调用方不传后端 `--model`**，用各后端默认配置；`--actual-model` 只是登记元数据

## 调用与只读边界

**provider 是进程级的。** 一个 Claude Code 会话连哪个网关由启动时的 `ANTHROPIC_BASE_URL` 决定，进程内 subagent 换不到别家模型。要不同模型的视角只能跨进程派发：`claude-vps` 经 `ai-vps-exec` 启动 `claude`，其他 `claude-*` 经 `claude-profile` 按各自 env 启动。

**Codex 评审必须走 `/home/joney/bin/codex-reviewer`。** 裸 `codex exec -s read-only` 不安全：沙箱拦住第一次写入后，本机配置 `approval_policy = "on-request"` 加 `approvals_reviewer = "auto_review"` 会自动批准提权，同一条命令重试即成功（2026-09-14 复现：第一次报 Read-only file system，第二次 exit 0）。`codex-reviewer` 叠加三层：bwrap 只读绑定 home（`~/.codex` 除外）和材料目录；`approval_policy=never` 断掉提权，home 外的写入由 codex 自身只读沙箱拦住；`--ignore-user-config` 不挂用户级 MCP。它内部从主配置取模型传 `-m`，是封装例外。

**Claude 评审用 `--tools "Read,Grep,Glob"` 加 `--strict-mcp-config`。** 前者把工具集合限到三个只读工具，后者去掉用户级 MCP；实测 claude-qwen 在此配置下工具面只有这三个、MCP 为空、skill 仍可加载。`--allowedTools` 只控制免确认，不限制工具集合，不要拿它当隔离。

派发后核对运行返回的工具面、MCP 列表和材料目录是否未变。正式 reviewer 另需满足上面的委派契约。模板要填入真实 prompt 再用，不要直接 `eval` 脚本输出。

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
