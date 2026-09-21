# 外部仓库对本地代码开发 skill 的价值评估：ECC / open-code-review / archify

评估日期：2026-09-21。三仓库均浅克隆到本会话 scratchpad 并读源码，commit 分别为 ECC `2b6e839`（2026-09-20）、open-code-review `cf64e70`（2026-09-20）、archify `29f1ff5`（2026-09-21）。

## 结论

| 仓库 | 结论 | 建议动作 |
|---|---|---|
| alibaba/open-code-review（`ocr`） | 高价值，可直接接入代码评审阶段 | 先试点：本机升级 Git 到 2.41+，配置自定义 provider 指向乐信网关，在 2 到 3 个真实 MR 上与现有 change-reviewer 对比 |
| affaan-m/ECC | 整体不采用，少量做法可吸收进自有 skill | 不安装插件；按下文清单挑 5 项作为参考材料改写进现有 skill |
| tt-a1i/archify | 低价值，可选增强，不进方案主线 | 不装；仅当用户明确要"演示用交互图"时临时使用 |

判断基准是本地 `~/projects/ai/agent-tools` 的研发主线：`dev-clarify-task → dev-design-solution ⇄ dev-review-solution → dev-derive-test-cases ⇄ dev-review-test-cases → dev-build-change → dev-verify-change → dev-review-change → dev-finish-branch`，由 `dev-auto-loop` 编排，产物身份 `R/S/C/B` 加指纹、不可变 `approval-record-v1`、只读独立 reviewer 子 agent、`build-codeagent` 跨模型路由与 eval-v2 评分，以及"单套分层配置、每阶段 1 到 2 个 skill、减少噪音"的治理偏好。

## 一、open-code-review（`ocr`）

### 它是什么

Go 编写的 AI 代码评审 CLI，Apache-2.0，源自阿里内部 Aone CR。核心是"确定性工程 + agent"：文件筛选六道门（二进制、密钥路径、用户排除、用户包含、扩展名白名单、默认测试文件排除）、按路径 glob 匹配内置规则文档、把相关文件打包成子任务并发评审、独立的定位与反思模块。自带 AACR-Bench（200 个真实 PR，1505 条标注问题），自报同模型下精确率和 F1 高于 Claude Code、召回率更低、token 约为 1/9。

### 与本地流程的契合点

- 规则文档直接命中乐信技术栈：`java.md`、`mapper_dao_xml.md`（MyBatis `${}` 注入、动态 SQL 条件、缺 WHERE 全表扫描）、`pom_xml.md`、`properties.md`、`yaml.md`。`java.md` 的线程安全章节写明"不报告"的情形，与 `dev-review-change` 的"只报告有证据和实际影响的问题"同向。
- 自定义 provider 支持任意 OpenAI 兼容或 Anthropic 协议地址（`custom_providers.<name>.url/protocol/model/api_key`），可直接指向乐信网关，代码不出内网；`--provider/--model` 可按次覆盖，能配合 `build-codeagent` 的生成者排除规则选一个与 producer 不同的后端。
- `--format json --audience agent --output <file>` 输出 `path/start_line/end_line/category/severity/suggestion_code/session_id`，会话保存在 `~/.opencodereview/sessions/`，不写入仓库。`ocr session compare <before> <after>` 给出新增、持续、已解决、未评审四类差异，正好对应 `dev-review-change` 的"定点复审 + 上轮已关闭项非回归"。
- `-B/--background-file` 可把 `R` 摘要与 `AC-*` 列表（清洗后 8000 字符内）作为评审背景。
- Delegation 模式 `ocr delegate preview/rule --format json` 不调用 LLM，只输出可评审文件清单（含排除原因）和按内容分组的规则。这可以由编排器在派发前跑一次，写进冻结信封，解决 `agent-tools-change-reviewer`（只有 Read/Grep/Glob，无法自己跑 ocr）漏看文件的问题，并给 reviewer 一份确定性的按文件覆盖清单。
- 遥测默认关闭（`OCR_ENABLE_TELEMETRY` 未设即不启用）。

### 边界与风险

- 它是 finding 生成器，没有 `R/S/C/B`、`TC-*`、`DEV-*`、producer 身份的概念，不能替代正式门禁；只能作为 `dev-review-change` 的证据来源，每条 finding 仍需 reviewer 绑定到 DEV 或代码位置并复核。
- 召回率有意偏低，且 `low` 级默认建议丢弃；不能把"ocr 无发现"当作"无问题"。
- 默认排除测试文件（`**/*Test.java`、`src/test/java/**`），测试代码改动要靠 `include` 显式纳入，否则清单模式对 `TC-*` 的实现检查会漏。
- 官方 Claude Code/Kimi 插件的 `/review` 命令会"自主决定是否修复"，与本地 reviewer 只读契约冲突；只用 CLI，不装插件命令。
- 本机 Git 为 2.34.1，ocr 要求 2.41 以上，接入前必须升级（WSL Ubuntu 可用 git-core PPA）。
- 评审结果依赖网关模型质量；`codex-glm` 8192 输出上限这类约束同样适用，重评审应选 `claude-glm`/`qwen`/`deepseek` 等已在 eval-v2 拿到 10 分以上的后端。

### 建议接入方式

1. 建议审查模式（普通 PR/diff）：`dev-review-change` 增加可选步骤，先跑 `ocr review --format json --audience agent -B <背景文件> --output <round>/ocr.json`，再由主会话按现有严重度口径复核。
2. 正式准入模式：编排器在冻结 `change_revision` 后跑 ocr，后端从 `build-codeagent` 排除集中选取并登记为参与者；json 存入 `code-review/rounds/round-<N>/`，作为证据随信封交给独立 reviewer；reviewer 仍按 `delegation-contract.md` 只读、独立、按 DEV 覆盖。
3. 编排器同时跑 `ocr delegate preview --format json`，把可评审文件清单写进信封，报告增加"逐文件覆盖"一节。
4. 乐信专项规则放 `~/.opencodereview/rule.json` 或 agent-tools 仓库内一份 `--rule` 文件（Hippo 配置 key、FSOF/Dubbo 接口兼容、mapper XML），不往团队仓库提交 `.opencodereview/`。
5. 先做试点再改 skill：选 2 到 3 个已完成正式评审的 MR，对比 ocr 输出与当时 `report.md` 的 findings，统计命中、漏报、误报后再决定写入 `dev-review-change`。

## 二、ECC（affaan-m/ECC v2.2.2）

### 它是什么

自称"agent harness 操作系统"的 Claude Code 插件，292 个 skill（约 35 万词）、68 个 agent（约 6 万词）、94 个命令、覆盖每次 Bash/Edit 的 hook 链、按语言分的 rules，支持 Claude Code、Codex、Cursor 等十余个客户端，提供 minimal/core/developer/full 安装 profile。附带商业化的 ECC Pro GitHub App。

### 为什么整体不采用

- 与治理偏好直接冲突：本地目标是每阶段 1 到 2 个 skill、减少噪音；ECC 即使 minimal profile 也会引入大量与本地无关的领域（homelab、healthcare、prediction market、marketing、video 等）和 always-on rules。它自己的 `context-budget` skill 就是为解决这种膨胀而写的。
- 治理模型更弱：ECC 的评审是进程内子 agent，`code-reviewer`/`java-reviewer` 都带 Bash 工具，没有只读证明、身份不相交、不可变审批记录、产物指纹这些本地已经落地的约束；`orch-pipeline` 的 gate 是对话内人工确认，不如 `dev-auto-loop` 的预算、止损和 checkpoint。
- 硬编码默认值与本地原则相悖：80% 覆盖率强制、TDD 强制、"不可变性 CRITICAL"、函数 50 行、文件 800 行等作为 rules 注入所有会话；本地 `verify-java-coverage` 明确"阈值以仓库门禁为事实源，不内置 80%"，`dev-build-change` 以最小改动和沿用仓库模式为原则。
- 技术栈重心是 TS/JS：`verification-loop`、`security-reviewer`、`code-review` 命令都以 npm/eslint/console.log/JSDoc 为检查项。Java 内容（`java-coding-standards`、`springboot-*`、`jpa-patterns`、`mysql-patterns`、`redis-patterns`、`java-reviewer`）是通用 Spring Boot/Quarkus 教科书写法（records、sealed、Testcontainers），与乐信的 FSOF/Dubbo、MyBatis、Hippo 环境距离较远，本地 `lang-java-service-patterns` 更贴近。
- hook 链在每次 Bash 前用 `node -e` 引导脚本再分发，有可感知延迟，且与本地 `SubagentStop` 结果守卫、Codex 双端符号链接安装机制并存时增加排障面。仓库迭代极快（PR 编号已过 3100），跟随成本高。

### 值得吸收的做法（作为参考材料改写进自有 skill，不安装）

| 来源 | 内容 | 落点 | 价值 |
|---|---|---|---|
| `agents/code-reviewer.md` | Pre-Report Gate 四问（能否引用精确行、能否描述具体失败场景、是否读过周边上下文、严重度是否站得住）+ HIGH/CRITICAL 必须附触发条件 | `dev-review-change/references/severity-and-complexity.md` 与 `agents/claude/*change-reviewer*.md` | 中 |
| `workflows/orch-review.workflow.js` | 多维度并行评审后，对每条 CRITICAL/HIGH 做一次对抗性反驳，只有反驳失败的才进阻断清单 | `dev-review-change` 可选步骤，或 `build-codeagent` 轻档互审 | 中 |
| `skills/skill-comply` | 用 `claude -p` 在三种提示强度下跑场景、按工具调用序列判定 skill/rule 是否真的被遵循 | `skill-authoring` 增加合规度评测入口；补 eval-v2 只测评审后端、不测 skill 触发的空白 | 中 |
| `skills/intent-driven-development` | 每条 AC 带 Must-not（禁止副作用）和 Verification（验证方式）字段 | `dev-clarify-task` 验收标准模板 | 低到中 |
| `agents/silent-failure-hunter.md`、`agents/pr-test-analyzer.md` | 吞异常、危险回退、丢栈；测试是否覆盖行为而非"不抛错" | `lang-java-service-patterns` 异常/测试章节、`dev-review-test-cases` 断言质量检查 | 低 |
| `skills/loop-design-check` | 可判定目标、反 Goodhart 边界、判断权留在人 | 一次性对照 `dev-auto-loop` 自查，不常驻 | 低 |

不建议吸收：`gateguard`（首次编辑前强制列出导入方，证据仅 2 个任务的自评 A/B，Java 仓库上会显著增加噪音）、`continuous-learning-v2`（与本地记忆机制重叠）、`strategic-compact`、`delivery-gate`（检查学习日志 mtime 与磁盘，与交付质量无关）、`tdd-workflow`（TDD 强制与最小改动原则冲突）。

## 三、archify（tt-a1i/archify v2.17.0-dev.1）

### 它是什么

MIT 的图表 skill：agent 写类型化 JSON IR（architecture/workflow/sequence/dataflow/lifecycle 五种），`node bin/archify.mjs validate/deliver` 做 schema、布局、连线净空等确定性校验，输出自包含交互式 HTML（内联 SVG，深浅主题，聚焦、路径、上下游可达、章节演示，PNG/SVG/WebM 导出）。零运行时依赖，Node 18+，Claude Code 与 Codex 都能装。支持读 Mermaid 输入重新作图、仓库源码证据（节点标 `SRC n` 固定到 commit 与行号）、`compare` 生成架构前后对照。

### 与本地方案文档链路的冲突

- 本地 `visualization-routing.md` 的交付面是 Markdown + mermaid 稳定子集，`check_mermaid.js` 用 mermaid 8.13 与 11 双版本解析并渲染 SVG/PNG，上传飞书后用文本绘图小组件或 PNG 展示；规则明确"不因此引入新的渲染依赖""默认只有一张主图"。archify 的产物是 HTML，飞书无法嵌入交互，PNG 导出在浏览器 Export 菜单或 `visual-check` 截图（需 Chrome），没有面向文档流水线的干净 CLI 静态导出。
- 只读 reviewer 消费的是文本；JSON IR 是第二种图源格式，reviewer 要额外学一套 schema，而 mermaid 文本已经能直接读。
- 每次使用要加载约 2300 词的 SKILL.md 加一份 schema 和示例，外加最多两轮修复循环，token 成本高于 mermaid。
- 自带更新检查会访问作者站点（可用 `ARCHIFY_UPDATE_CHECK_DISABLED=1` 关闭）。

### 可能用得上的场景

- 人评审会或向业务方演示 `mechanism-architecture` 型方案时，需要可点击的路径高亮；此时把 `solution.md` 的 mermaid 主图转成 archify HTML 放在 `solution-design/diagrams/` 旁边，主图仍以 mermaid 为准。
- 接手陌生应用时用"分析仓库生成运行时架构图"做现状摸底；但对 FSOF/Dubbo 上下游，本地 `inspect-app-call-topology` 走真实注册中心，证据强于源码推断。
- 它的作图约束（一条主路径、主节点不超过 12 个、标签语义化、不为通过校验删语义标签）与 `visualization-routing.md` 第 4 节同向，可借用措辞，不需要引入工具。

## 四、按阶段汇总

| 阶段 | 本地主入口 | 三仓库能补什么 |
|---|---|---|
| 需求澄清 | dev-clarify-task | ECC intent-driven-development 的 Must-not/Verification 字段（小） |
| 方案设计 | dev-design-solution | archify 仅演示场景；ECC planner/architect 通用，不及现有 profile 体系 |
| 方案评审 | dev-review-solution | 无 |
| 测试清单与复核 | dev-derive/review-test-cases | ECC pr-test-analyzer 的断言质量检查项（小） |
| 编码 | dev-build-change | 无（ECC TDD/gateguard 与原则冲突） |
| 验证 | dev-verify-change + verify-java-coverage | 无（ECC springboot-verification 硬编码 80%，弱于现有） |
| 代码评审 | dev-review-change | ocr 作为证据源与逐文件覆盖清单（大）；ECC Pre-Report Gate 与对抗性反驳（中） |
| 收口 | dev-finish-branch | 无 |
| 编排 | dev-auto-loop | ECC loop-design-check 一次性自查（小） |
| skill 治理 | skill-authoring + build-codeagent eval | ECC skill-comply 合规度评测思路（中） |

## 五、下一步

1. 升级 Git 到 2.41+，`npm i -g @alibaba-group/open-code-review`，配置指向乐信网关的自定义 provider，`ocr llm test` 通过。
2. 选 2 到 3 个有正式评审记录的 MR 做对比试点，记录命中/漏报/误报；通过后再改 `dev-review-change` 与 `delegation-contract.md`，并把 ocr 后端登记进 `build-codeagent` 的参与记录。
3. ECC 只克隆到本地作参考，按上表五项改写进对应自有 skill；改动 `severity-and-complexity.md` 或 reviewer agent 后重跑 `python3 -m unittest discover -s tests` 保持契约一致。
4. archify 不安装；如需演示图，临时用 `npx skills use tt-a1i/archify@archify --agent codex` 一次性运行。

## 六、执行记录（2026-09-21）

- 已装 ocr v1.12.7，provider `lexin` 指向乐信网关，`ocr llm test` 通过；Git 已从 2.34.1 升到 2.55.0（git-core PPA），ocr 告警消失。
- 已改：`dev-review-change` 1.9.0（ocr 线索与逐文件覆盖、写入前自检引用）、`severity-and-complexity.md`（写入前自检四问 + High 反驳）、`review-template.md`（外部评审证据行、逐文件覆盖表）、`delegation-contract.md` §3 inputs、两端 change-reviewer agent、`dev-clarify-task` 1.5.0（AC 的禁止副作用与验证方式）、`lang-java-service-patterns` 1.1.0（异常吞噬检查项）、仓库 `AGENTS.md`；新增 `references/ocr-evidence.md` 与 `ocr-rules.json`。`python3 -m unittest discover -s tests` 96 项通过。
- 试点已完成，见 `ocr-pilot-2026-09-21.md`；archify 实测见 `archify-solution-diagram-assessment.md`。未做：skill-comply 式合规度评测（需另建脚本）。
