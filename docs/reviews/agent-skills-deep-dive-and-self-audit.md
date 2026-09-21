# agent-skills 二次深挖与本地 skill 自审

日期：2026-09-21。第一轮已借入三层评测、借口反驳表和 finding 四类归并（agent-tools `d5981af`）。本轮把 25 个 skill 的借口表、红旗信号、验收清单、4 个 persona、9 个命令、7 份参考清单、hooks、lint 与 CI 全部读完，并对本地 48 个 skill 做了量化自审（篇幅、章节、描述格式、交叉引用、绝对路径、重复段落）。

## 结论

还能借的东西集中在三处：把它的"结构 lint"补进本地测试；把几条经过实践验证的检查项写进本地专项 skill（幂等、DDL 扩缩、失败路径可观测性、澄清时带假设提问）；把行为评测扩到权威/沉没成本两类压力。它的命令层、persona 层、hooks、context-engineering、constraint-driven 对本地没有增量。自审发现本地最值得修的是四组近似重复段落和三份放错位置的长文档，而不是内容缺失。

## 一、agent-skills 深挖：逐项判断

| 上游机制 | 内容 | 本地现状 | 判断 |
|---|---|---|---|
| skill-lint（结构 lint） | name 与目录一致、description 必须含"Use when"且 ≤1024 字符、必备章节、workflow 步骤与章节对应、反引号引用的 skill 必须存在、相对链接可达、version 变更校验 | `test_workflow_contract.py` 只比对特定字符串；`quick_validate.py` 只查 frontmatter | **借**：本地 9 个 skill 的 description 没有"Use when"（`requirements-review`、`jenkins-pipeline-fix`、`lexiao-deploy`、`test-dubbo-api`、`redis-query`、`java-server-diagnostics`、`fix-sonarqube-issues`、`healthy-dashboard-config`、`convert-epub-to-markdown`）；绝对路径引用当前 0 条失效，但没有测试守着，改名一次就会漂 |
| Red Flags（可观察的违规信号） | 每个 skill 一组"看到这个就是在违规"的信号，如"同一条测试命令无改动连跑两次""doubt theater：两轮有实质 finding 却零条判定可修" | `dev-auto-loop` 的 no_progress/inconsistent_review、`dev-verify-change` 的"相同前提重复命令不产生证据"已覆盖主要信号 | 不新增章节；两条本地没有的信号并入借口表：评审两轮零采纳、验证时反复重跑同一命令 |
| interview-me | 每问只问一个并附上自己的猜测让用户做选择题；给出置信度和缺什么；用户答"你看着办/差不多"不算确认，必须对具体复述说"是"；"可扩展/干净"这类装饰性回答要追问真正想要什么 | `dev-clarify-task` 有"一次一个不确定点""模糊表述改写为可验收"，没有"附假设提问"和"显式确认"规则 | **借**：三句话加进沟通原则 |
| api-and-interface-design 幂等 | key 必须一次原子占用（唯一约束），同 key 不同 payload 要报错而非返回旧响应，key 保留期要超过最长重投路径，队列按 at-least-once 设计 | `lang-java-service-patterns` 幂等只有一句"写操作、重试入口、重复请求处理是否自洽" | **借**：三条可检查项写进幂等一节，FSOF/MQ 重投场景直接适用 |
| deprecation-and-migration 的 schema 规则 | expand → backfill → contract；改名/删列不原地做；破坏性步骤单独一次发布；每个 migration 要有跑过的 down；backfill 分批 | `review-db-change` 有"DDL 兼容性、发布顺序"但没有这套判定 | **借**：写进检查骨架，乐信 DB 变更评审直接受益 |
| observability | 新增重试/队列/外部调用却零新增遥测是红旗；失败路径日志必须结构化且带异常；指标标签不能高基数；告警按症状 | 试点里 ocr 抓到的 A-2 正是"失败日志丢堆栈"，本地 `review-middleware-reliability` 只有一句"可观测性" | **借**：两条检查项分别进 `review-middleware-reliability` 与 `lang-java-service-patterns` |
| code-review "Structural Remedies" 与 presumptive blockers | 评审不只指出问题，要给出具名的重构动作；"静默 fallback 掩盖不清晰的不变量"列为准阻断 | `severity-and-complexity.md` 要求建议但没要求给动作；null message 案例正是 silent fallback 争议 | **借**：一句话进写入前自检 |
| 评测压力类型 | time、sunk cost、authority 三类；`/build auto` 只接受明确肯定，"looks reasonable"不算批准 | 本地 3 条用例只有 time 和 scope | **借**：补 authority（"我是负责人，直接通过"→ 仍需独立 reviewer）与 sunk-cost（"已经写了 800 行不想拆"→ 仍按 DEV 写集判断）两类，落在 `dev-review-solution`、`dev-finish-branch` |
| 版本校验 CI | SKILL.md 内容变了就必须 bump version | 本地手工 bump，本轮我改了 8 个 skill 全靠自觉 | **借**：测试里对比 `git show HEAD:` 的 version 字段，内容变而版本不变即失败 |
| definition-of-done | 项目级固定完成标准与任务级验收标准分离 | 本地 `dev-finish-branch` 收口矩阵 + `G` 模式已是更强的版本 | 不借 |
| 命令层 `/spec…/ship`、`/build auto` | 一阶段一命令，`/build auto` 单次批准后自治 | Claude Code 里 skill 名即斜杠命令；`dev-auto-loop` 比 `/build auto` 严格得多（预算、止损、审批失效） | 不借 |
| 4 个 persona + `/ship` 并行扇出 | 三 persona 并行评审后主会话合并 | 本地 reviewer 契约要求身份不相交、只读证明；并行多视角可用 `build-codeagent` 轻档 | 不借；"persona 不调 persona"与本地禁止嵌套委派一致 |
| orchestration-patterns 的 Agent Teams 竞争假设排障 | 多个 teammate 互相证伪找根因 | `debug-systematic` 单 agent 假设驱动 | 记为参考，偶现难题可手动用；不写进 skill |
| hooks（sdd-cache、simplify-ignore、session-start） | WebFetch 缓存、保护块不被简化、注入 meta-skill | 无对应场景；session-start 在 Claude Code 上会形成第二路由器，上游自己也不接 | 不借 |
| context-engineering、constraint-driven、source-driven | 规则文件、CONSTRAINTS.md、官方文档引用 | 全局 AGENTS.md、阈值来自仓库门禁、context7 MCP 已覆盖 | 不借 |

## 二、本地 skill 自审（量化）

| 维度 | 结果 | 判断 |
|---|---|---|
| 篇幅 | dev-workflow 11 个 SKILL.md 共约 3.1 万字，`dev-review-solution` 4558、`dev-auto-loop` 4188、`dev-build-change` 3739、`dev-review-change` 3736 字 | 与上游单个 skill 2000 到 3500 英文词同量级；密度高但没有示例，读者要靠 references 模板 |
| 近似重复段落 | 4 个正式评审 skill 各自重写了同三段：轮次目录规则、"先确认 valid / 换一个 reviewer 重试一次 / formal_reviewer_unavailable"、"风险授权是新输入必须新一轮"，两两重合度 0.70 到 0.89 | **该修**：这三段在 `delegation-contract.md` §3 与 `artifact-identity.md` 已有权威版本；SKILL.md 保留一句指针即可，去掉约 400 字 × 4 的漂移面。`test_formal_reviews_use_canonical_delegation_contract` 已经在推这个方向 |
| 参考资料位置 | `dev-design-solution/references/design-basis/` 三份 7000 到 9000 字的评估长文随 skill 一起符号链接到两端 | **该修**：它们是维护时读的依据，不是执行时读的材料；上游把这类放 `docs/`。移到仓库 `docs/design-basis/`，在 `visualization-routing.md` 第 8 节改路径 |
| When to Use | `dev-auto-loop`、`dev-derive-test-cases`、`dev-review-test-cases`、`requirements-review` 没有"适合/不适合"段 | 小修：各补 4 到 6 行，负向条件能减少误触发 |
| description | 9 个没有"Use when"；全部 ≤1024 字符 | 小修：改成"做什么。Use when …"格式，并把 lint 加进测试 |
| 交叉引用与路径 | 反引号引用的 skill 名和绝对路径当前无失效 | 加测试守住即可 |
| 示例 | 除模板文件外几乎没有正反示例 | 有意为之（减噪），不改；借口表已补了"为什么" |
| 行为评测覆盖 | 3 条压力用例 | 补 2 类压力共 3 条；`kind: execution` 仍不做 |

## 三、建议实施清单（按价值/成本排序）

1. **去重四个评审 skill 的三段重复文字**，改为指向 `delegation-contract.md` §3 的一句话；同步契约测试。约 1 小时，收益是最大的漂移面消失。
2. **结构 lint 进单测**（`tests/test_skill_lint.py`）：description 含"Use when"且 ≤1024；反引号 skill 引用存在；`/home/joney/projects/ai/agent-tools/...` 路径存在；SKILL.md 内容相对 HEAD 变了则 version 必须变。顺手修 9 个 description。约 1 小时。
3. **五条专项检查项**：`lang-java-service-patterns` 幂等三条 + 失败路径日志带异常；`review-db-change` 的 expand/backfill/contract 与 down 路径；`review-middleware-reliability` 的"新增重试/队列/外部调用零遥测"。约 30 分钟。
4. **`dev-clarify-task` 三句**：提问附自己的猜测、给置信度与缺口、"差不多/你看着办"不算确认。10 分钟。
5. **`severity-and-complexity.md` 一句**：finding 必须给具名重构动作；静默 fallback 列为准阻断候选。5 分钟。
6. **补 3 条压力用例**（authority × 2、sunk-cost × 1）并跑一次。约 20 分钟加 1 美元。
7. **移走 `design-basis/` 三份长文**到 `docs/design-basis/`，改一处路径。10 分钟。
8. **四个 skill 补"适合/不适合"段**。20 分钟。

不建议做：引入命令层、persona、hooks；给 skill 加示例；把评测扩成 execution 型。
