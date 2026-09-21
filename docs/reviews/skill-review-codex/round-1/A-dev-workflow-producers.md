# dev-workflow 生产者链路（前缀 A）评审报告

## 1. 总体判断

生产者链路的职责、追踪和审批规则总体完整，但仍存在执行入口阻塞、规则冲突，以及读者测试能力隔离不足的问题。  
已逐个读完范围内全部 39 个文件，共 3,013 行，包括 references、脚本和客户端配置；本报告仅评审，不修改文件。  
共发现 9 项：High 1 项、Medium 7 项、Low 1 项；最大风险是读者测试命令没有落实声明的工具隔离。  
最值得先做的是：落实读者测试隔离、修正不可执行的选模命令、为单独验证提供不虚构审批历史的入口。  
验证结果：49 个测试中 48 个通过，1 个因只读沙箱无法创建临时目录而报错；独立路由评测通过，rank-1 为 31/33。  
未执行会写文件或调用外部模型的渲染、读者测试；以下涉及这些流程的判断依据为文档与脚本接口。

## 2. Findings

表中路径均位于 `/home/joney/projects/ai/agent-tools/`，全局规则除外。

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| A-01 | dev-design-solution | [reader-test-protocol.md:34](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-design-solution/references/reader-test-protocol.md:34)、[同文件:96](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-design-solution/references/reader-test-protocol.md:96) | High | 安全与可执行性 | Codex 读者命令没有落实禁止联网、写入和委派的工具面约束；继承配置中的 MCP 时，文件只读沙箱不足以排除外部副作用，也不能保证测试只依据方案正文。 | 第 34 行要求“工具面只有 Read……不联网、不写文件、不委派”；第 96 行命令仅指定 `-s read-only` 等参数；第 100 行却将“不挂载主配置里的 MCP server”的 `--ignore-user-config` 写成可选。 | 将禁用用户配置/MCP 纳入实际命令，并在派发前核验有效工具面；无法满足隔离时停止读者测试，不能仅凭只读沙箱判定满足协议。 | 确认 |
| A-02 | dev-auto-loop | [SKILL.md:156](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-auto-loop/SKILL.md:156)、[design-review-loop.md:11](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-auto-loop/references/design-review-loop.md:11) | Medium | 正确性与自洽 | `R/B` 变化后，主文件允许按影响分析保留部分审批，细则却要求旧方案审批失效；保留下来的审批也无法满足下一阶段的精确绑定检查，导致运行状态与准入结果冲突。 | 主文件：“`R` 变化后先做影响分析；受影响的……审批全部失效”；第 159 行只失效“依赖旧代码证据”的审批。细则：“方案内容或 `R/B` 变化后，旧方案审批失效”；共享身份契约要求冻结输入与当前产物“全部精确匹配”。 | 明确区分审批身份失效与内容修订范围：绑定的 `R/B` 改变即失效，影响分析只决定复审和重建范围。 | 确认 |
| A-03 | dev-verify-change | [SKILL.md:45](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-verify-change/SKILL.md:45)、[同文件:54](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-verify-change/SKILL.md:54) | Medium | 触发与边界 | 用户单独要求“验证已有改动”时，skill 会因没有历史 `G`、`change_revision`、DEV 而停止；人工或其他工具完成的普通改动无法直接获得测试结果。 | description 覆盖“代码改动已完成，需要跑测试”；执行前却要求 `G`、`change_revision` 和 DEV，并规定“缺少与所选模式匹配的上下文时停止”。仅开发入口有构造 direct 上下文的规则。 | 区分单独验证与正式交付验证：前者允许冻结当前对象、运行检查并说明证据边界；不得补造实现前 `B` 或正式审批事实。 | 确认 |
| A-04 | dev-design-solution | [SKILL.md:14](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-design-solution/SKILL.md:14)、[同文件:126](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-design-solution/SKILL.md:126) | Medium | 规则冲突 | 文档默认输出规则不一致。用户要求“写技术方案”但没说“落盘”时，agent 可能只回答对话，或额外索要保存许可。 | 第 14 行：“只有用户明确要求落盘时才创建或修改方案文档”；第 126 行又写“用户要求正式方案或落盘时”使用文档模式；[全局规则:42](/home/joney/.codex/AGENTS.md:42)要求文档默认本地 Markdown。 | 将默认落盘规则与全局约定统一，仅在用户明确要求对话讨论或不保存时使用纯对话模式。 | 确认 |
| A-05 | dev-clarify-task | [SKILL.md:88](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-clarify-task/SKILL.md:88) | Medium | 可执行性与边界 | 将用户明确委托判断的“你看着办”一律视为未确认，并强制等待用户回答“是”，会阻塞低风险、可逆且已获授权的任务。 | “『差不多』『你看着办』不算确认……用户对复述说『是』才算收敛”；[全局规则:14](/home/joney/.codex/AGENTS.md:14)允许低风险、可逆事项声明假设后继续。 | 只对影响范围、核心行为或外部后果的关键歧义要求确认；保留用户授权 agent 自行判断的有效性。 | 确认 |
| A-06 | dev-design-solution | [reader-test-protocol.md:33](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-design-solution/references/reader-test-protocol.md:33) | Medium | 引用与接口 | 推荐的选模命令缺少必填参数，按文档执行直接失败；相对脚本路径在业务仓库中也无法直接定位。 | 文档给出 `skills/common/build-codeagent/scripts/pick_agent.py quick-check`；源码要求 `--task`，实际执行退出码为 2，报错 `the following arguments are required: --task`。 | 改为仓库绝对路径，并补 `--task <稳定任务ID>`；明确该命令只预览，不登记参与历史。 | 确认 |
| A-07 | dev-design-solution | [SKILL.md:104](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-design-solution/SKILL.md:104)、[check_mermaid.js:28](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-design-solution/scripts/check_mermaid.js:28) | Medium | 可执行性与接口 | 已选择等宽文本图或获准不画图的方案，仍被要求运行 Mermaid 校验；脚本在判断没有 Mermaid 块之前就加载 Playwright，导致无需渲染的方案也依赖浏览器工具链。 | 正文要求“运行……全部通过后再交付”；脚本第 28 行 `require(PW_PATH)`，直到第 45 行才处理 `no mermaid blocks`。可视化规则明确允许等宽文本块作为正式形式。 | 将浏览器依赖限定于存在 Mermaid 块的情况；无块时直接产生“不适用”结果，或允许文档流程跳过该命令。 | 确认 |
| A-08 | dev-auto-loop | [run-state-and-resume.md:38](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-auto-loop/references/run-state-and-resume.md:38)、[同文件:69](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-auto-loop/references/run-state-and-resume.md:69) | Medium | 状态与恢复 | 预算先预占、派发失败不计费两条规则之间缺少确定的恢复规则。派发未启动就失败时，已写入的不可变 checkpoint 仍标记动作启动并扣费，恢复者无法确定实际消耗。 | 第 38 行：“先原子写入 checkpoint，记录计数预占和 `action_started=true`，再启动动作”，随后又要求“派发在动作真正启动前失败时不预占领域预算”；第 69 行允许此类失败重试一次。 | 区分预占与实际启动；对确定未启动且无写入的派发失败追加取消预占事实，明确恢复时如何计算已用预算。 | 确认 |
| A-09 | 共享 references / 产物模板 | [writing-principles.md:22](/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/writing-principles.md:22)、[traceability-template.md:34](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-design-solution/references/traceability-template.md:34) | Low | 自洽与精简 | 共享写作规则限制表格不超过 6 列，强制消费的模板却包含 8～9 列，agent 必须自行决定违背哪一条规则或重排模板。 | 共享规则：“列数不超过 6”；方案 CHG 表为 8 列，测试清单模板第 49 行为 9 列，开发清单契约第 74 行为 8 列。 | 明确结构化追踪表是否豁免列数限制；若不豁免，直接统一现有模板，避免执行者临时重构。 | 确认 |

## 3. 跨 skill / 跨文件问题

- 审批身份与影响分析混在一起：`dev-auto-loop/SKILL.md:156` 的“受影响……审批全部失效”与 `references/artifact-identity.md:102` 的“冻结输入和当前产物全部精确匹配”无法同时用于保留旧审批，见 A-02。
- 普通任务的入口支持不对称：`dev-build-change/SKILL.md:75` 明确支持“尚无 `G/D`”时构造 direct 上下文，`dev-verify-change/SKILL.md:54` 则直接停止；需要保留单独验证入口，见 A-03。
- 写作规则与阶段模板没有统一适用范围：共享规则第 22 行的 6 列限制，与方案、测试、开发三类模板冲突，见 A-09。
- 范围外核对发现：`tests/test_workflow_contract.py:111` 等检查主要验证标题和关键字符串存在，因此当前测试通过不能证明上述执行语义无冲突。

## 4. 做得好、不要动

- `references/artifact-identity.md:60` 区分 approved、direct、waived，并要求 waiver 依赖闭包和逐门禁授权；能防止将“缺少审批”误记为“已豁免”。
- `references/delegation-contract.md:25`、`:55` 明确要求可复核的未写入证据，并规定风险授权必须产生新一轮评审；不要退回依赖 reviewer 自报或覆盖旧结论。
- `dev-derive-test-cases/SKILL.md:37`、`:68` 冻结 AC/CHG 分母并输出计数与差集；这能发现清单遗漏，避免只统计已经写出的检查项。
- `dev-build-change/SKILL.md:46` 明确清单模式到拆分后停止，`development-checklist.md:35` 限制 Skipped 用法；同时保护用户“暂不编码”的边界和真实完成状态。
- `dev-auto-loop/SKILL.md:148`、`:152` 对交付阶段上游缺陷停止等待人工，并明确 completed 不授权提交、推送或部署；这些边界应保留。

## 5. 优先级 Top 10

本批次共 9 项，不补凑第 10 项。

1. A-01：落实读者测试的工具隔离，优先消除外部副作用能力。
2. A-06：补齐选模命令的绝对路径和 `--task`，修改成本最低。
3. A-04：统一方案默认落盘规则，避免额外确认和漏交付。
4. A-03：补单独验证入口，避免普通测试请求被治理历史阻塞。
5. A-05：取消对低风险委托判断的强制二次确认。
6. A-02：统一审批身份失效规则，影响分析只控制复审范围。
7. A-07：无 Mermaid 块时解除浏览器工具链依赖。
8. A-08：明确派发失败后的预算取消与恢复计算。
9. A-09：统一结构化表格与共享列数规则。

## 6. JSON

```json
{
  "batch": "A",
  "findings": [
    {
      "id": "A-01",
      "skill": "dev-design-solution",
      "location": "skills/dev-workflow/dev-design-solution/references/reader-test-protocol.md:34,96,100",
      "severity": "High",
      "category": "安全与可执行性",
      "summary": "Codex 读者命令未落实禁止 MCP、联网和委派的能力隔离。",
      "fix": "将禁用用户配置和 MCP 纳入命令并核验有效工具面，无法隔离时停止测试。",
      "confidence": "确认"
    },
    {
      "id": "A-02",
      "skill": "dev-auto-loop",
      "location": "skills/dev-workflow/dev-auto-loop/SKILL.md:156",
      "severity": "Medium",
      "category": "正确性与自洽",
      "summary": "R/B 变化后的选择性审批失效规则与精确绑定契约冲突。",
      "fix": "绑定身份变化即使旧审批失效，影响分析仅决定修订和复审范围。",
      "confidence": "确认"
    },
    {
      "id": "A-03",
      "skill": "dev-verify-change",
      "location": "skills/dev-workflow/dev-verify-change/SKILL.md:45,54",
      "severity": "Medium",
      "category": "触发与边界",
      "summary": "单独验证已有改动会因缺少历史 G、change_revision 和 DEV 被阻塞。",
      "fix": "区分单独验证与正式交付验证，允许运行检查并披露证据限制，不补造历史基线。",
      "confidence": "确认"
    },
    {
      "id": "A-04",
      "skill": "dev-design-solution",
      "location": "skills/dev-workflow/dev-design-solution/SKILL.md:14,126",
      "severity": "Medium",
      "category": "规则冲突",
      "summary": "仅明确要求落盘才写文档，与正式方案文档模式及全局默认本地 Markdown 冲突。",
      "fix": "请求方案文档时默认本地落盘，用户明确只讨论或不保存时采用对话模式。",
      "confidence": "确认"
    },
    {
      "id": "A-05",
      "skill": "dev-clarify-task",
      "location": "skills/dev-workflow/dev-clarify-task/SKILL.md:88",
      "severity": "Medium",
      "category": "可执行性与边界",
      "summary": "一律否定用户委托判断并要求回答“是”，会阻塞低风险可逆任务。",
      "fix": "仅对关键歧义要求确认，低风险事项允许按用户授权声明假设后继续。",
      "confidence": "确认"
    },
    {
      "id": "A-06",
      "skill": "dev-design-solution",
      "location": "skills/dev-workflow/dev-design-solution/references/reader-test-protocol.md:33",
      "severity": "Medium",
      "category": "引用与接口",
      "summary": "选模命令缺少必填 --task，已复现退出码 2。",
      "fix": "使用仓库绝对脚本路径并补充 --task <稳定任务ID>。",
      "confidence": "确认"
    },
    {
      "id": "A-07",
      "skill": "dev-design-solution",
      "location": "skills/dev-workflow/dev-design-solution/SKILL.md:104; skills/dev-workflow/dev-design-solution/scripts/check_mermaid.js:28,45",
      "severity": "Medium",
      "category": "可执行性与接口",
      "summary": "无 Mermaid 块的方案仍在检查前加载 Playwright，产生不必要的环境依赖。",
      "fix": "先判断是否存在 Mermaid 块，无块直接标记不适用或跳过渲染命令。",
      "confidence": "确认"
    },
    {
      "id": "A-08",
      "skill": "dev-auto-loop",
      "location": "skills/dev-workflow/dev-auto-loop/references/run-state-and-resume.md:38,69",
      "severity": "Medium",
      "category": "状态与恢复",
      "summary": "预算预占和派发未启动失败不计费之间缺少明确恢复规则。",
      "fix": "区分预占与启动，对确定未启动的失败追加取消预占事实并规定恢复计数。",
      "confidence": "确认"
    },
    {
      "id": "A-09",
      "skill": "共享 references / 产物模板",
      "location": "skills/dev-workflow/references/writing-principles.md:22; skills/dev-workflow/dev-design-solution/references/traceability-template.md:34",
      "severity": "Low",
      "category": "自洽与精简",
      "summary": "共享规则最多 6 列，与方案、测试和开发模板的 8 至 9 列冲突。",
      "fix": "明确追踪表例外或统一现有模板，避免执行者自行选择规则。",
      "confidence": "确认"
    }
  ]
}
```
