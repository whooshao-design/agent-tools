# 第 3 轮：核对第 3 轮报告中未关闭项与新 finding 的处置，并找剩余问题

你在第 1 轮的报告在 `/home/joney/docs/agent-tools/skill-review-codex/round-1/D-lexin-observability.md`，第 2 轮的报告在 `/home/joney/docs/agent-tools/skill-review-codex/round-2/r2-D-lexin-observability.md`（本轮以它为准）；Claude 对每条 finding 的审核结论（采纳 / 部分采纳 / 拒绝及理由）在 `/home/joney/docs/agent-tools/skill-review-codex/round-2/audit.md` 的对应批次小节。所有修改都在仓库工作树里、尚未提交：先在 `/home/joney/projects/ai/agent-tools` 运行 `git diff HEAD --stat`，再对本批次涉及的文件运行 `git diff HEAD -- <路径>` 看精确改动（`skills/lexin/query-clickhouse-water/` 下的未跟踪文件不属于本轮，忽略）。

本轮任务：

1. **逐条核对旧 finding 的处置**：对第 3 轮报告里状态不是“已关闭”的旧 ID 和第 2 轮的新 finding，读改动后的文件与 diff，判定 `已关闭` / `部分关闭` / `未关闭` / `改动引入新问题`，给出 `文件:行号` 证据。Claude 写"采纳"但改动没有真正消除你指出的执行风险，要指出来。
2. **对拒绝和部分采纳项表态**：Claude 的理由写在审核文件里。逐条写 `同意` 或 `不同意`；不同意必须给出理由没有覆盖到的具体失败场景（谁、在什么输入下、会做错什么），不要重复第 1 轮的措辞。
3. **找剩余问题**：改动本身引入的问题（矛盾、断链、措辞让 agent 犹豫）优先；第 1 轮漏掉的 High/Medium 也报；Low 只在一句话能说清、改起来不超过一行时报。不要为了凑数报问题，也不要重复已关闭的项。
4. **收敛判断**：最后一节明确回答"本批次是否可以视为收敛"：全部 High/Medium 已关闭或分歧已记录、且没有新的 High/Medium 时答"可收敛"；否则列出阻止收敛的 ID。

输出格式（严格遵守）：

```
# <批次名> 第 3 轮报告

## 1. 总体判断
（3 到 6 行）

## 2. 旧 finding 处置核对
| ID | 状态 | 证据（文件:行号 + 一句话） |

## 3. 对拒绝 / 部分采纳项的表态
| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |

## 4. 新 findings
| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
（ID 用 <批次前缀>-3-<两位序号>；没有就写"无"）

## 5. 收敛判断
可收敛 / 不可收敛：<阻止收敛的 ID 列表>

## 6. JSON
```json
{"batch":"<前缀>","closed":[],"partial":[],"open":[],"regressions":[],"disagree":[],"new_findings":[{"id":"","skill":"","location":"","severity":"","summary":"","fix":""}],"converged":true}
```
```

以下是第 1 轮的评审规范，严重度与置信度定义沿用：

# 评审规范（所有批次共用）

你是独立的只读评审者，评审对象是仓库 `/home/joney/projects/ai/agent-tools` 里的 agent skill（Claude Code 与 Codex 共用，通过符号链接安装）。你无法写文件，评审结论全部写到标准输出。全文用简体中文。

## 评审标准来源（先读）
1. `/home/joney/projects/ai/agent-tools/AGENTS.md`：仓库约定、分类、安装、测试、命名教训。
2. `/home/joney/projects/ai/agent-tools/skills/common/skill-authoring/SKILL.md`：skill 写法约定。
3. `/home/joney/.codex/AGENTS.md`：用户的全局工作规则（简体中文、Simplicity First、Surgical Changes、文档默认本地 Markdown 等）。skill 不得与之冲突。
4. `/home/joney/projects/ai/agent-tools/evals/README.md`：skill 评测三层（结构 lint、路由、行为）。

## 评审对象的定位
skill 是给 LLM agent 在执行任务时加载的指令。评判它好坏的唯一标准是：一个能力不错但没有上下文的 agent 加载它之后，能否在真实任务里做对、做少、不越界、不误触发。请始终从"执行中的 agent 会怎么读这段话"的角度评审，而不是从"文档是否漂亮"的角度。

## 必查维度
1. **正确性与自洽**：同一 skill 内部、同批次 skill 之间、skill 与 `AGENTS.md`/引用文件之间是否矛盾；数字、阈值、字段名、状态枚举、文件名是否前后一致。
2. **引用有效性**：SKILL.md 与 references 中引用的绝对路径、脚本、参数/子命令、MCP 工具名（源码在 `mcp/devtools-mcp/`）、环境变量、其他 skill 名，是否真实存在且接口与描述一致。脚本只核对接口（参数、输出、路径）与文档是否一致，不做完整代码评审。
3. **可执行性**：步骤是否足以让 agent 直接执行；有没有"应当/尽量/合理"这类无法判定的措辞出现在门禁或必做项上；失败/异常/权限不足时怎么办有没有写；输出契约（文件名、字段、状态值）是否明确。
4. **触发与边界**：frontmatter `description` 是否能让路由器在该触发时触发、不该触发时不触发；"适合/不适合"边界与相邻 skill 是否清楚、是否互相踩踏。
5. **精简与分层**：正文是否有可删的重复、与引用文件重复的段落、对执行没有作用的背景叙述；长内容是否该下沉到 `references/`；是否有过度设计（为不存在的场景加规则、加配置）。
6. **安全与合规**：凭据、真实 IP、内网主机名是否泄露在正文；破坏性操作（删除、发布、写库、审批）有没有明确的确认门槛与只读默认；是否与用户全局规则"只有用户要求才提交/推送/发布"一致。
7. **时效性**：是否残留已过时的结论、已移除的文件/工具、历史遗留的"曾经不可用"说法。

## 硬性要求
- 每条 finding 必须给证据：`文件路径:行号` 加原文引用（可截断），以及为什么这在执行中会造成问题。没有证据的判断标为"疑似"并说明需要什么才能确认。
- 不要提出会增加复杂度却没有对应真实失败场景的改动；不要建议加示例、加章节来"更完整"，除非能说明缺了它 agent 会做错什么。
- 明确列出"做得好、不要动"的部分，避免下一轮为改而改。
- 严重度定义：High = 会让 agent 做错、越界或门禁失效；Medium = 会让 agent 犹豫、走弯路或结果不一致；Low = 文案、冗余、可读性。
- 置信度：确认（已核对文件或源码）/ 疑似（推断）。
- 不改写 skill，不输出完整替换文本；给出定位到行的最小修改建议即可。

## 输出格式（严格遵守）
```
# <批次名> 评审报告

## 1. 总体判断
（3 到 8 行：整体质量、最大风险、最值得先做的三件事）

## 2. Findings
| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
（ID 格式 <批次前缀>-<两位序号>，按严重度降序）

## 3. 跨 skill / 跨文件问题
（重复、矛盾、边界踩踏，逐条给证据）

## 4. 做得好、不要动
（逐条，说明为什么）

## 5. 优先级 Top 10
（按 价值/成本 排序，每条一行，引用 finding ID）

## 6. JSON
```json
{"batch":"<批次前缀>","findings":[{"id":"","skill":"","location":"","severity":"High|Medium|Low","category":"","summary":"","fix":"","confidence":"确认|疑似"}]}
```
```

本批次范围（同第 1 轮）：
评审范围（逐个文件读完，含各 skill 目录下 references/ 与 scripts/ 的接口）：
- /home/joney/projects/ai/agent-tools/skills/lexin/diagnose-healthy-alert
- /home/joney/projects/ai/agent-tools/skills/lexin/inspect-healthy-jvm-dashboard
- /home/joney/projects/ai/agent-tools/skills/lexin/inspect-healthy-metrics
- /home/joney/projects/ai/agent-tools/skills/lexin/healthy-dashboard-config
- /home/joney/projects/ai/agent-tools/skills/lexin/register-healthy-metrics
- /home/joney/projects/ai/agent-tools/skills/lexin/java-server-diagnostics
- /home/joney/projects/ai/agent-tools/skills/lexin/query-app-logs
- /home/joney/projects/ai/agent-tools/skills/lexin/query-app-instances
- /home/joney/projects/ai/agent-tools/skills/lexin/inspect-app-call-topology
- /home/joney/projects/ai/agent-tools/skills/lexin/query-hawk-field-reference
- /home/joney/projects/ai/agent-tools/skills/lexin/query-dubbo-registry
- /home/joney/projects/ai/agent-tools/skills/lexin/test-dubbo-api
- /home/joney/projects/ai/agent-tools/skills/lexin/query-oa-gateway-interface

