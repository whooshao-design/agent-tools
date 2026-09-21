# addyosmani/agent-skills 对本地 skill 体系的价值评估

评估日期：2026-09-21。对象 commit `dc27a9c`（2026-09-20），MIT，25 个 skill 约 5.2 万词，4 个评审 persona，9 个命令，7 份参考清单，3 层 eval 框架，13 个校验脚本，零依赖 Node。作者是 Chrome 团队的 Addy Osmani，仓库有活跃的社区评审与 CI。

## 结论

不整体安装，借三样东西：eval 框架（最有价值，需要为中文 description 换分词）、每个 skill 的"常见借口与反驳"表、评审 finding 的四类归并口径。它的 25 个 skill 本身与本地主线重叠且弱于本地治理，装进来会变成第二个路由器，它自己的 `docs/comparison.md` 也明说"不要同时跑两个 meta-skill 路由"。

## 它是什么

按 Define → Plan → Build → Verify → Review → Ship 六个阶段组织的通用工程方法论，每个 skill 固定"Overview / When to Use / Process / Common Rationalizations / Red Flags / Verification"六段。内容源自 Google 工程实践（Hyrum's Law、change sizing、Beyonce Rule、Chesterton's Fence）。示例以 TS/JS 为主，面向产品团队和 greenfield 项目，全英文。

## 与本地体系逐项对照

| 维度 | agent-skills | 本地 agent-tools | 判断 |
|---|---|---|---|
| 阶段主线 | 25 个 skill + `using-agent-skills` 路由 | 9 阶段 skill + `dev-auto-loop` 编排 + 5 个质量增强 | 覆盖面等价；本地多了正式门禁、产物身份、审批记录 |
| 评审独立性 | 4 个 persona，`personas don't invoke personas`；无只读证明 | `delegation-contract.md`：runtime 身份不相交、只读沙箱、写集证明、不可变审批 | 本地严格得多 |
| 反驳性评审 | `doubt-driven-development`：CLAIM→EXTRACT→DOUBT→RECONCILE→STOP，只传 artifact+contract 不传 claim | 契约已有"不传设计方推理与预期结论"；`severity-and-complexity.md` 已有写入前自检与 High 反驳 | 原则已具备；RECONCILE 的四类归并口径可借 |
| 代码评审 | 五轴（正确性、可读性、架构、安全、性能）+ Structural Remedies + Nit/Optional/FYI 标签 | 四维 + 复杂度冗余，High/Medium/Low，根因类型路由 | 本地更贴合门禁；"提出重构动作而不只指出问题"值得加一句 |
| 需求澄清 | `interview-me` 一次一问到 95% 置信 | `dev-clarify-task` "一次澄清一个最关键不确定点" | 已等价 |
| 全局行为 | `using-agent-skills` 六条操作行为（暴露假设、管理困惑、敢于反对、简洁、范围纪律、验证） | `~/.codex/AGENTS.md` Core Engineering Principles | 几乎一一对应 |
| 阈值事实源 | `constraint-driven-development` 写 CONSTRAINTS.md | 阈值只从仓库门禁/任务读取，不内置 | 团队仓库不能加文件，本地做法更适用 |
| skill 质量度量 | 三层 eval：结构校验、TF-IDF 触发/路由/冲突检查（CI）、`claude -p` 行为评测含压力用例 | `tests/test_workflow_contract.py` 契约一致性 + `build-codeagent` eval-v2 评审后端打分 | **本地空白**：没有触发路由检查，没有 skill 行为评测 |
| 语言与栈 | 英文、TS/JS 示例、团队流程规范（PR 大小、评审时效） | 中文、Java/乐信内网 | 内容不能直接用 |

## 对 eval 框架的实测

上游 Tier-2 在其自身仓库跑通：140 项检查通过，88 条正向提示 rank-1 率 100%。但它的分词是 `[^a-z0-9\s-]` 全部丢弃，对本地中文 description 输出空 token，直接不可用。

我用"ASCII 词 + 中文二字组"分词把同样的 TF-IDF 余弦逻辑在本地 48 个 skill 上跑了一遍：

- description 两两相似度最高 0.36（`configure-hippo` ~ `query-hippo-config`），全部低于上游 0.50 的告警线。本地 skill 的 description 区分度是好的。
- 10 条用户口吻的路由探针 rank-1 命中 7 条。3 条未命中都是 description 缺词汇：`把技术方案写出来` 排到 `dev-derive-test-cases`（`dev-design-solution` 的 description 没有"写方案"这类说法）；`跑一下这次改动相关的测试` 排到 `java-server-diagnostics`（`dev-verify-change` 没有"跑测试/运行测试"）；`独立复核一下测试清单` 与 `dev-derive-test-cases` 只差 0.01。

这三条就是这套检查的价值：它会把"为什么 skill 没触发"变成可在 CI 里失败的具体 description 修改项。

## 建议引入的三项

1. **移植 eval 框架到 agent-tools**（约半天）。`tests/` 下加 `skill_routing_eval.py`：中文二字组加 ASCII 词的 TF-IDF，检查 `evals/cases/<skill>.json` 的正向/负向提示与描述冲突，rank-1 底线进 `python3 -m unittest`；先为 dev-workflow 的 11 个 skill 各写 3 正 2 负提示。行为层用 `claude-profile`/`codex exec` 无头跑 SKILL.md 加提示，grader 用另一后端，沿用上游 `expectations[]` 结构；重点补压力用例——用户说"时间紧先跳过测试清单"时，`dev-review-solution` 交接必须产出 `waiver-record-v1` 而不是直接进 `dev-build-change`，这类门禁最需要被证明扛得住。
2. **给四个最容易被跳过的门禁加"常见借口与反驳"表**：`dev-verify-change`（"测试过了就行"）、`dev-review-change`（"改动很小不用评审"）、`dev-build-change` 简化回看（"先能跑，以后再清理"）、`dev-clarify-task`（"需求很明显不用澄清"）。每表 4 到 6 行，不超过 150 字，与减噪偏好不冲突。
3. **RECONCILE 四类归并写进编排器处理 reviewer findings 的口径**：契约误读（先改冻结输入再复审）、成立需修、成立但接受取舍（显式记录）、噪音（reviewer 缺上下文，回头补进信封）。落在 `delegation-contract.md` §3 或 `dev-review-change` 第 8 节，一段话即可。

## 不建议引入

- 25 个 skill 本体与 9 个命令：与主线重复，英文与 TS/JS 示例不适用，会与本地 skill 抢触发。
- 4 个 persona：没有只读与身份证明，低于本地 reviewer 契约。
- hooks（`sdd-cache` WebFetch 缓存、`session-start`、`simplify-ignore`）：针对它自己的 skill，本地无对应场景。
- `constraint-driven-development` 的 CONSTRAINTS.md：团队仓库不能落文件，本地"阈值来自仓库门禁"已足够。

## 本次产物

评估文档本身；分词原型未入库（在会话临时目录跑通），移植时按第 1 项重写。
