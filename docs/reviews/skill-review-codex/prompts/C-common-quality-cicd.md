# 本批次：common + dev-quality + cicd（前缀 C）

评审范围（逐个文件读完，含各 skill 目录下 references/ 与 scripts/ 的接口）：
- /home/joney/projects/ai/agent-tools/skills/common/build-codeagent
- /home/joney/projects/ai/agent-tools/skills/common/convert-epub-to-markdown
- /home/joney/projects/ai/agent-tools/skills/common/debug-systematic
- /home/joney/projects/ai/agent-tools/skills/common/skill-authoring
- /home/joney/projects/ai/agent-tools/skills/common/spawn-model-agent
- /home/joney/projects/ai/agent-tools/skills/dev-quality/lang-java-service-patterns
- /home/joney/projects/ai/agent-tools/skills/dev-quality/review-db-change
- /home/joney/projects/ai/agent-tools/skills/dev-quality/review-middleware-reliability
- /home/joney/projects/ai/agent-tools/skills/dev-quality/verify-browser-qa
- /home/joney/projects/ai/agent-tools/skills/dev-quality/verify-java-coverage
- /home/joney/projects/ai/agent-tools/skills/cicd/fix-sonarqube-issues
- /home/joney/projects/ai/agent-tools/skills/cicd/jenkins-pipeline-fix

范围外但允许读来核对一致性的：仓库其余 skill、mcp/devtools-mcp/ 源码、tests/、agents/、hooks/、evals/。范围外文件的问题只在第 3 节以一句话提及，不进 Findings。

评审规范如下，严格按其中的输出格式作答：

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
