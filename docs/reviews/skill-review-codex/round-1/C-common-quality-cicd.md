# common + dev-quality + cicd 评审报告

## 1. 总体判断

本批次发现 11 项问题：High 2 项、Medium 8 项、Low 1 项，最大风险集中在跨模型进程的权限边界。
已逐个读完 12 个 skill 目录中的 36 个源文件，脚本仅核对参数、路径、输出及其文档契约。
优先处理三件事：纠正启动器权限默认值、保留续接作业的只读属性、修正后端评测的判定口径。
CICD 的授权边界、EPUB 的原件保护、Java 覆盖率的临时修改恢复规则较扎实，应保留。
10 项现有定向测试通过；另用内存模拟复现权限续接、超时和评测输出问题，未启动外部模型、访问内网或运行完整集成验证。
以下路径相对于 `/home/joney/projects/ai/agent-tools/`；未修改任何文件。

## 2. Findings

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| C-01 | spawn-model-agent | `skills/common/spawn-model-agent/SKILL.md:55`；`scripts/spawn_model_agent.py:100` | High | 安全与自洽 | 将固定的宽权限启动描述成“与主会话相同”，会让受限会话错误选择越过自身授权边界的调用方式。 | 原文：“权限与主会话的子 agent 相同”；实际 Claude 默认追加 `--dangerously-skip-permissions`，Codex 默认选择 `workspace-write`，未读取主会话有效权限。内存调用已确认。 | 删除权限继承承诺；按任务授权和主会话有效边界选择模式，无法证明可写时使用只读，不能默认跳过权限检查。 | 确认 |
| C-02 | spawn-model-agent | `skills/common/spawn-model-agent/SKILL.md:28`；`scripts/spawn_model_agent.py:224` | High | 接口与权限 | 按文档续接只读作业，会默认变为可写作业。 | 文档：“在上一次的 agent 会话里继续追问”；恢复代码只读取 `cwd`、`slim`，未恢复 `readonly`；该参数默认 false。模拟前次 `readonly=true`，传入 `run_child` 的值为 false。 | 续接默认保留前次只读约束；放宽权限必须有新的明确授权，不能以省略参数表示放宽。 | 确认 |
| C-03 | spawn-model-agent | `skills/common/spawn-model-agent/SKILL.md:49`；`scripts/spawn_model_agent.py:158`、`:184` | Medium | 异常与输出 | 超时后不生成完成状态，按 `--status` 等待的 agent 无法区分“仍运行”和“已经异常退出”。 | 文档要求“用 Monitor 或 `--status` 等它结束”；`subprocess.run(... timeout=timeout)` 抛错后尚未写入 `meta.json`；状态接口在文件不存在时始终输出“运行中或未开始”。模拟已确认异常直接逸出。 | 捕获超时并保存失败终态及已有输出；文档明确失败状态的查看入口，避免无限轮询。 | 确认 |
| C-04 | build-codeagent | `skills/common/build-codeagent/SKILL.md:117`；`model-routing.json:183`、`:329` | Medium | 路由自洽 | “按宿主选择通道”与实际候选表冲突，Codex 主会话照脚本执行仍会选中 Claude 通道。 | 原文：“编排器在哪个客户端就用哪一套”；路由表同样要求 Codex 使用 `codex-*`，但需求梳理、内容整理、测试生成、代码生成、验证执行五个环节只有 `claude-*` 候选。选择器无宿主参数。 | 在现有两种规则中确定一个：若保留当前候选表，将宿主通道改成偏好并说明例外；若是硬规则，补齐通道选择。 | 确认 |
| C-05 | build-codeagent | `skills/common/build-codeagent/evals/review-seeded/answer-key.json:121`；`scripts/score_backend_eval.py:17` | Medium | 评测输出正确性 | 计分不检查位置或缺陷对应关系，通用词命中会虚增评审能力分数。 | 答案键要求“命中……phrase 且指向正确位置”；脚本只检查 `any(p in text ...)`，短语包括“证据”“顺序”“错误码”。模拟一条位于“无关位置”的关键词串即可得到 11/11。 | 将机械命中作为候选；人工核对位置和问题对应关系后再更新有效分数及候选资格，不能只复核 unmatched 项。 | 确认 |
| C-06 | build-codeagent | `skills/common/build-codeagent/references/backend-evaluation.md:26`、`:70`；`scripts/backend_eval.py:22`、`:106` | Medium | 评测输出正确性 | `json_ok` 仅表示能提取 JSON，却被当作严格格式遵从证据。 | 方法要求“最终消息是否恰好一个可解析的 JSON 代码块”；实现接受裸 JSON、带前后额外文字的代码块、多个代码块。三种输入均模拟得到 true。 | 按提示词实际要求验证唯一代码块及结构；或将当前字段改称“JSON 可提取”，不得用于证明格式门槛通过。 | 确认 |
| C-07 | review-db-change / review-middleware-reliability | `skills/dev-quality/review-db-change/SKILL.md:28`；`skills/dev-quality/review-middleware-reliability/SKILL.md:28` | Medium | 触发与边界 | 两个专项声明支持方案评审，却要求代码阶段证据，会误挡编码前的正常调用。 | 两者定位均包含 `dev-review-solution`；不适用条件分别写“还未完成基础代码评审证据收集”“还没形成基础 diff 和验证证据”。 | 将这些前提限定为代码评审场景；方案评审使用方案、现有代码基线和约束，不要求未来 diff 或执行结果。 | 确认 |
| C-08 | review-db-change | `skills/dev-quality/review-db-change/SKILL.md:36` | Medium | 过度约束 | 把特定在线迁移策略写成所有结构变更的硬规则，会推动无必要的多阶段实施。 | 原文：“改名、删列、改类型不原地做，按 expand → backfill → contract 分阶段……每个 migration 有跑过的回滚路径”。没有区分空表、离线变更或已明确停机窗口。 | 将该要求限定于需要新旧版本并存、保留存量数据的场景；其他场景按实际兼容与恢复要求判断。 | 确认 |
| C-09 | fix-sonarqube-issues | `skills/cicd/fix-sonarqube-issues/SKILL.md:3`、`:29`、`:55` | Medium | 任务覆盖 | description 接收“看质量门禁”，但执行和交付只覆盖 issue，可能遗漏实际失败的门禁条件。 | 触发包括“用户要求看 SonarQube 质量门禁”；查询步骤仅规定 `list_sonarqube_issues`，输出要求“覆盖……全部 issue”。源码已有 `get_sonarqube_quality_gate_status`，正文未安排调用。 | 用户问门禁时，先查询同项目、分支或 PR 的门禁状态及失败条件，再按需进入 issue 分析。 | 确认 |
| C-10 | skill-authoring | `skills/common/skill-authoring/SKILL.md:70`、`:93` | Medium | 仓库契约一致性 | 创建和修改流程缺少仓库强制评测，版本变更又被描述成可选，照流程完成仍可能不满足仓库要求。 | 原文：“需要追踪内容变化时升 `metadata.version`”；验证流程仅列基础校验与安装。根 `AGENTS.md:56` 要求新增 dev-workflow case、修改 description 后跑路由评测，`:63` 明确改内容需 bump version。 | 在现有验证步骤引用这些条件性必做项；版本规则与仓库现有门禁统一，不另建流程。 | 确认 |
| C-11 | debug-systematic | `skills/common/debug-systematic/SKILL.md:13` | Low | 时效性与引用 | 仍指向已退出当前分类体系的 `env-access`，降低数据排查交接的可定位性。 | 原文：“查数据用 `env-access` 类 skill”；当前分类表列的是 `common/dev-workflow/dev-quality/cicd/lexin`，不存在该分类入口。 | 改为当前数据查询 skill 的明确入口，或直接引用 `lexin` 下的数据查询能力。 | 确认 |

## 3. 跨 skill / 跨文件问题

- C-01/C-02 与同批次只读规则不一致：`build-codeagent/SKILL.md:57` 要求 reviewer“严格只读”，`spawn-model-agent/SKILL.md:55` 却把跳过权限检查描述为普通权限继承；两者虽然用途不同，权限术语仍应一致。
- C-07 的交接存在双向冲突：`dev-review-solution/SKILL.md:172`、`:173` 明确调用数据库和中间件专项，而两个专项的 `SKILL.md:28` 又要求代码评审证据。
- C-05/C-06 形成连续的证据放大：评测脚本输出宽松的命中数和 `json_ok`，`references/backend-evaluation.md:70` 再用它们判断正式评审候选资格；这不直接替代正式审批，但会影响选模依据。
- 范围外一致性问题：`tests/test_skill_lint.py:27` 仍将 `env-access` 加入豁免集合，因此结构测试通过不能发现 C-11 的失效分类引用。

## 4. 做得好、不要动

- `build-codeagent/SKILL.md:56–89` 区分运行时身份、只读证据、有效否决与执行失败；这些约束能防止自评和换 reviewer 刷取通过，应保留。
- `convert-epub-to-markdown/SKILL.md:18–23`、`:67–73` 保留原件、避免重复正文、逐页回读校验并披露图片限制；脚本接口与这条主路径一致。
- `jenkins-pipeline-fix/SKILL.md:31–34` 固定构建编号，`:64–66` 限定等待预算，`:83–84` 区分本地通过与远端通过，能有效避免证据混用和越权重跑。
- `verify-java-coverage/SKILL.md:35–36` 不虚构统一阈值，`:45–48` 只撤销自身临时 patch，既保护用户改动，也防止覆盖率假通过。
- `fix-sonarqube-issues/SKILL.md:35–41` 不把文本命中当引用证明，`:50–51` 不默认修改服务端状态；`verify-browser-qa/SKILL.md:62–65` 隔离浏览器会话并保留业务写入授权边界，均应保留。

## 5. 优先级 Top 10

1. C-02：续接保留只读属性，修复范围小，直接关闭权限放宽路径。
2. C-01：纠正启动器默认权限及“权限继承”承诺。
3. C-09：补上质量门禁查询分支，直接覆盖已声明的用户任务。
4. C-07：按方案/代码阶段区分前置证据，消除交接阻塞。
5. C-06：让 `json_ok` 与格式门槛一致。
6. C-03：超时落失败终态，避免主会话持续等待。
7. C-10：同步作者流程与仓库强制验证要求。
8. C-04：统一宿主通道规则与候选表。
9. C-05：核对命中位置后再使用评测分数。
10. C-08：收窄迁移硬规则的适用条件，避免无必要的实施复杂度。

## 6. JSON

```json
{
  "batch": "C",
  "findings": [
    {
      "id": "C-01",
      "skill": "spawn-model-agent",
      "location": "skills/common/spawn-model-agent/SKILL.md:55; skills/common/spawn-model-agent/scripts/spawn_model_agent.py:100",
      "severity": "High",
      "category": "安全与自洽",
      "summary": "固定宽权限启动被描述为继承主会话权限，可能越过有效授权边界。",
      "fix": "删除继承承诺，按任务授权和有效权限选择模式，无法证明可写时使用只读。",
      "confidence": "确认"
    },
    {
      "id": "C-02",
      "skill": "spawn-model-agent",
      "location": "skills/common/spawn-model-agent/SKILL.md:28; skills/common/spawn-model-agent/scripts/spawn_model_agent.py:224",
      "severity": "High",
      "category": "接口与权限",
      "summary": "续接只读作业未继承 readonly，默认恢复为可写模式。",
      "fix": "续接保留只读约束，放宽权限必须有新的明确授权。",
      "confidence": "确认"
    },
    {
      "id": "C-03",
      "skill": "spawn-model-agent",
      "location": "skills/common/spawn-model-agent/scripts/spawn_model_agent.py:158; skills/common/spawn-model-agent/scripts/spawn_model_agent.py:184",
      "severity": "Medium",
      "category": "异常与输出",
      "summary": "超时未生成终态，状态查询持续显示运行中或未开始。",
      "fix": "捕获超时并保存失败元数据和已有输出，明确失败查看入口。",
      "confidence": "确认"
    },
    {
      "id": "C-04",
      "skill": "build-codeagent",
      "location": "skills/common/build-codeagent/SKILL.md:117; skills/common/build-codeagent/model-routing.json:183",
      "severity": "Medium",
      "category": "路由自洽",
      "summary": "按宿主选择通道的规则与多个环节仅含 Claude 候选矛盾。",
      "fix": "明确宿主通道是偏好还是硬规则，并同步候选选择行为。",
      "confidence": "确认"
    },
    {
      "id": "C-05",
      "skill": "build-codeagent",
      "location": "skills/common/build-codeagent/evals/review-seeded/answer-key.json:121; skills/common/build-codeagent/scripts/score_backend_eval.py:17",
      "severity": "Medium",
      "category": "评测输出正确性",
      "summary": "机械计分不核对位置，通用关键词即可虚增缺陷命中数。",
      "fix": "机械命中仅作候选，核对位置与缺陷对应关系后再更新有效分数。",
      "confidence": "确认"
    },
    {
      "id": "C-06",
      "skill": "build-codeagent",
      "location": "skills/common/build-codeagent/references/backend-evaluation.md:26; skills/common/build-codeagent/scripts/backend_eval.py:106",
      "severity": "Medium",
      "category": "评测输出正确性",
      "summary": "JSON 可提取被当作严格格式合规，接受裸 JSON、额外文字及多个代码块。",
      "fix": "验证实际格式契约，或更名为可提取指标并停止用其证明格式门槛通过。",
      "confidence": "确认"
    },
    {
      "id": "C-07",
      "skill": "review-db-change / review-middleware-reliability",
      "location": "skills/dev-quality/review-db-change/SKILL.md:28; skills/dev-quality/review-middleware-reliability/SKILL.md:28",
      "severity": "Medium",
      "category": "触发与边界",
      "summary": "支持方案评审的专项同时要求代码 diff 或验证证据，误挡编码前调用。",
      "fix": "按方案评审和代码评审分别限定前置证据。",
      "confidence": "确认"
    },
    {
      "id": "C-08",
      "skill": "review-db-change",
      "location": "skills/dev-quality/review-db-change/SKILL.md:36",
      "severity": "Medium",
      "category": "过度约束",
      "summary": "将多阶段在线迁移策略无条件应用于全部结构变更。",
      "fix": "限定于需要版本并存和存量数据兼容的场景，其余按实际恢复要求判断。",
      "confidence": "确认"
    },
    {
      "id": "C-09",
      "skill": "fix-sonarqube-issues",
      "location": "skills/cicd/fix-sonarqube-issues/SKILL.md:29",
      "severity": "Medium",
      "category": "任务覆盖",
      "summary": "接收质量门禁查询任务，但流程只查询和交付 issue。",
      "fix": "门禁查询任务先调用 get_sonarqube_quality_gate_status，再按失败条件分析 issue。",
      "confidence": "确认"
    },
    {
      "id": "C-10",
      "skill": "skill-authoring",
      "location": "skills/common/skill-authoring/SKILL.md:70; skills/common/skill-authoring/SKILL.md:93",
      "severity": "Medium",
      "category": "仓库契约一致性",
      "summary": "作者流程遗漏仓库强制评测，并将内容变更升版本描述为可选。",
      "fix": "引用新增 case、description 路由评测及内容变更升版本的现有要求。",
      "confidence": "确认"
    },
    {
      "id": "C-11",
      "skill": "debug-systematic",
      "location": "skills/common/debug-systematic/SKILL.md:13",
      "severity": "Low",
      "category": "时效性与引用",
      "summary": "数据排查交接仍引用不存在的 env-access 分类。",
      "fix": "改为当前 lexin 数据查询能力或明确的查询 skill。",
      "confidence": "确认"
    }
  ]
}
```
