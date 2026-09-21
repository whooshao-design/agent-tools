# dev-workflow 评审门禁链路（前缀 B）评审报告

## 1. 总体判断

整体契约较完整，本次确认 8 项 Medium、1 项 Low，未确认 High 级问题。  
已逐文件读完范围内 30 个文件、共 2215 行；脚本仅核对接口及约定行为，全程未修改文件。  
主要风险是定点复审范围、授权绑定和调用入口存在不一致，会造成漏查、无效记录或额外阻塞。  
优先处理三件事：明确跨章节非回归范围、补齐测试清单授权绑定、修正 OCR 命令。  
hook、工作流契约及结构检查共 57 项通过；路由评测通过。另复现了两项 OCR 命令错误和一项 hook 输入处理差异。  
未调用远程模型，未执行双端正式评审集成验证；测试通过不代表运行时隔离已验证。

## 2. Findings

以下路径均相对于 `/home/joney/projects/ai/agent-tools/`。

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| B-01 | dev-review-solution | [SKILL.md:146](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-solution/SKILL.md:146) | Medium | 正确性与自洽 | 定点复审把语义检查收缩为文本 diff 触达章节，未明确包含语义依赖章节。修改共享决策后，未改动的发布、回滚章节可能仍依赖旧决策，执行者会对是否重查产生不同判断。 | 第 145 行要求“全局结构/追踪一致性检查和变更影响非回归检查”，第 146 行却限定“本轮 diff 触达的章节 + 上轮已关闭项中被 diff 触达者”。 | 将范围改为 diff 触达章节及其受影响的引用、依赖章节；影响无法确认时沿用完整复审规则。 | 确认 |
| B-02 | dev-review-test-cases | [references/review-template.md:25](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-test-cases/references/review-template.md:25) | Medium | 输出契约 | 模板唯一的授权表只绑定 `(R,S,B)`，不能完整记录本轮针对测试清单 finding 的授权；照模板填写会遗漏 `C`，导致记录不满足准入要求。 | 模板表头为“绑定 `(R,S,B)`”，第 69 行要求“风险接受仅引用第 1 节的有效授权”；[SKILL.md:87](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-test-cases/SKILL.md:87) 则要求授权绑定“当前 `(R,S,C,B)`”。 | 表中分别记录原授权绑定与本轮 `(R,S,C,B)` 复核绑定，保留上游授权来源。 | 确认 |
| B-03 | hooks | [subagent_result_guard.py:115](/home/joney/projects/ai/agent-tools/hooks/subagent_result_guard.py:115) | Medium | 接口正确性 | `conclusion` 为数组或对象时，首次无效结果直接放行，没有走约定的首次纠错拦截。该问题削弱结构守卫，但不能据此认定最终审批被绕过。 | 第 115 行直接执行 `conclusion not in ALLOWED_CONCLUSIONS[...]`；第 210 行捕获异常后放行。实测相同首轮事件中，错误字符串返回 `decision=block`，`[]`、`{}` 返回“输入异常，已放行”。 | 在枚举判断前检查字符串类型，将字段类型错误转换为 `ContractError`；补充这两类接口用例。 | 确认 |
| B-04 | dev-review-change | [references/ocr-evidence.md:34](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-change/references/ocr-evidence.md:34) | Medium | 引用有效性 | 正式流程的文件清单生成命令使用不存在的参数，执行后无法获得要求冻结的清单。 | 原文：“`ocr delegate preview ... --output rounds/round-<N>/ocr-files.json`”。本机 CLI 帮助无 `--output`，实测返回 `Error: unknown flag: --output`。 | 改用该子命令支持的 stdout 重定向；同时注明 preview 的保存方式与 `ocr review --output` 不同。 | 确认 |
| B-05 | dev-review-change | [references/ocr-evidence.md:18](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-change/references/ocr-evidence.md:18) | Medium | 可执行性 | 多行命令的续行符后带空格和注释，复制执行会拆成多个命令，背景、规则和输出路径不会正常传给 OCR。 | 第 18、19 行均为反斜杠后接注释，如“`\ # 或 -c ...`”。用内存 shell 函数替代 OCR 复现后，出现 `-B: command not found`、`--rule: command not found`，退出码 127。 | 将说明移至独立注释行，确保续行反斜杠是该行最后一个字符。 | 确认 |
| B-06 | dev-review-solution | [SKILL.md:88](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-solution/SKILL.md:88)、[SKILL.md:114](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-solution/SKILL.md:114) | Medium | 跨文件一致性 | 读者测试门禁未区分全文读者与截断读者；会把截断读者允许找不到的 Q6/Q7 误判为 Medium，或只检查全文结果而漏查截断结果。 | 原文分别要求“七问全部通过”和“读者测试任一问不通过……至少定为 Medium”；共享结构契约第 142 行也只写“agent 读者七问全部通过”，与实际协议的两种读者判定不一致，详见第 3 节。 | 三处统一引用协议判定：全文七问、截断前五问及成立的探针问题，避免另写一套简化门槛。 | 确认 |
| B-07 | dev-review-change | [agents/openai.yaml:4](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-change/agents/openai.yaml:4) | Medium | 触发与边界 | Codex 默认提示直接要求正式门禁材料，与正文“普通审查默认建议审查”冲突。用户从默认入口发起普通 diff 审查时，可能被要求补造治理记录。 | 默认提示：“绑定 gate_context 和 change_revision，核对 DEV 状态……再按独立评审契约”；[SKILL.md:20](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-change/SKILL.md:20) 明确“建议审查不要求补造 `G`、`DEV-*`、producer 身份或审批记录”。 | 默认提示先选择建议审查或正式准入，仅正式准入要求这些字段。 | 确认 |
| B-08 | requirements-review | [SKILL.md:58](/home/joney/projects/ai/agent-tools/skills/dev-workflow/requirements-review/SKILL.md:58) | Medium | 可判定性 | 严重度只有枚举，没有判级依据，但 High 与 Medium 决定能否接受风险。同一需求缺口可能被不同 reviewer 分到不同门禁路径。 | 第 58 行仅列“`Blocker / High / Medium / Low`”；第 61 行规定“Blocker/High 不接受风险放行”。[severity-and-complexity.md:5](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-change/references/severity-and-complexity.md:5) 又明确代码判级规则不能跨阶段套用，并称需求评审保留内嵌定义。 | 在现有严重度条目中补充简短、基于需求影响的判级依据，尤其明确 High 与可授权 Medium 的边界。 | 确认 |
| B-09 | 共享 references | [writing-principles.md:7](/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/writing-principles.md:7)、[writing-principles.md:22](/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/writing-principles.md:22) | Low | 精简与分层 | 将设计叙事的表达限制无差别应用于评审报告，与正式模板冲突，增加不必要的格式取舍。 | 第 3 行明确覆盖“评审报告”，第 7 行要求“指纹、producer refs、审批引用不放正文”，第 22 行要求“列数不超过 6”；代码评审模板第 11、18 行要求身份及审批引用，第 31 行 findings 表有 11 列。 | 将这些限制限定于设计叙事；明确正式评审的身份、证据和 findings 表按阶段模板保留。 | 确认 |

## 3. 跨 skill / 跨文件问题

- 定点复审口径冲突对应 B-01：[dev-review-solution/SKILL.md:145](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-solution/SKILL.md:145) 要求“全局结构/追踪一致性”，下一行的语义范围却只保留 diff 触达内容；应统一为变更影响范围。
- 授权绑定冲突对应 B-02：[artifact-identity.md:113](/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/artifact-identity.md:113) 要求下游“记录当前阶段绑定”，测试清单模板的授权表仍只有 `(R,S,B)`。
- 读者测试冲突对应 B-06：范围外协议 [reader-test-protocol.md:44](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-design-solution/references/reader-test-protocol.md:44) 明确“Q6、Q7 允许答‘找不到’”，第 56 行只要求截断读者前五问通过；范围内入口与共享契约应沿用该判定。
- 默认入口与正文冲突对应 B-07：[openai.yaml:4](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-change/agents/openai.yaml:4) 直接进入正式材料绑定，而 [SKILL.md:22](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-change/SKILL.md:22) 要求满足明确条件才进入正式 Workflow。
- 通用写作规则与阶段模板冲突对应 B-09；此外，[dev-review-solution/SKILL.md:114](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-solution/SKILL.md:114) 使用类别“结构/可读性”，其 [模板第 22 行](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-solution/references/review-template.md:22) 仅列“结构”，建议统一名称，不新增类别体系。

## 4. 做得好、不要动

- **审批记录不可变与外部指纹绑定**：[artifact-identity.md:81](/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/artifact-identity.md:81) 要求逐轮保存，第 102 行避免自指纹；能防止修改展示报告后沿用旧审批。
- **独立性依赖运行事实**：[delegation-contract.md:10](/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/delegation-contract.md:10) 区分平台 reviewer 身份与稳定 producer 引用，第 25 行拒绝用自报空写集证明只读；该边界应保留。
- **禁止通过更换 reviewer 刷取通过**：[delegation-contract.md:53](/home/joney/projects/ai/agent-tools/skills/dev-workflow/references/delegation-contract.md:53) 区分有效否决与执行失败，第 55 行要求风险授权进入新轮次，保护审批历史。
- **建议审查与正式审批分开**：[dev-review-change/SKILL.md:18](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-change/SKILL.md:18) 允许普通静态审查在验证不足时披露限制，避免普通请求被重流程阻塞；修正默认提示即可，无须重写正文。
- **外部线索不直接成为结论**：[severity-and-complexity.md:36](/home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-change/references/severity-and-complexity.md:36) 要求具体失败场景与 High 反驳；OCR 输出仅作候选证据的定位合理。

## 5. 优先级 Top 10

本次只有 9 项 findings，不为凑数增加问题。

1. B-04：修正 preview 不支持的参数，立即恢复文件清单生成。
2. B-05：修正 shell 续行，避免背景、规则和输出参数丢失。
3. B-02：补齐测试清单授权的当前四元组绑定。
4. B-03：统一非法 `conclusion` 类型的首次纠错行为。
5. B-01：明确跨章节语义依赖的非回归范围。
6. B-06：统一全文与截断读者的准入判定。
7. B-07：让默认提示遵循建议审查与正式准入分流。
8. B-08：补充需求严重度的最小判级依据。
9. B-09：收窄通用写作限制，保留正式模板必需字段。

## 6. JSON

```json
{
  "batch": "B",
  "findings": [
    {
      "id": "B-01",
      "skill": "dev-review-solution",
      "location": "skills/dev-workflow/dev-review-solution/SKILL.md:146",
      "severity": "Medium",
      "category": "正确性与自洽",
      "summary": "定点复审的语义检查只覆盖文本 diff 触达章节，未明确覆盖受影响的依赖章节。",
      "fix": "纳入受影响的引用和依赖章节；影响无法确认时完整复审。",
      "confidence": "确认"
    },
    {
      "id": "B-02",
      "skill": "dev-review-test-cases",
      "location": "skills/dev-workflow/dev-review-test-cases/references/review-template.md:25",
      "severity": "Medium",
      "category": "输出契约",
      "summary": "授权表只绑定 R/S/B，遗漏本轮测试清单授权要求的 C。",
      "fix": "分别记录原授权绑定与当前 R/S/C/B 复核绑定。",
      "confidence": "确认"
    },
    {
      "id": "B-03",
      "skill": "hooks",
      "location": "hooks/subagent_result_guard.py:115",
      "severity": "Medium",
      "category": "接口正确性",
      "summary": "数组或对象类型的 conclusion 导致直接放行，跳过首次纠错拦截。",
      "fix": "枚举检查前验证字符串类型，统一转为 ContractError，并补充接口用例。",
      "confidence": "确认"
    },
    {
      "id": "B-04",
      "skill": "dev-review-change",
      "location": "skills/dev-workflow/dev-review-change/references/ocr-evidence.md:34",
      "severity": "Medium",
      "category": "引用有效性",
      "summary": "ocr delegate preview 不支持文档使用的 --output 参数。",
      "fix": "使用 stdout 重定向保存 preview JSON，并区分两个子命令的输出接口。",
      "confidence": "确认"
    },
    {
      "id": "B-05",
      "skill": "dev-review-change",
      "location": "skills/dev-workflow/dev-review-change/references/ocr-evidence.md:18",
      "severity": "Medium",
      "category": "可执行性",
      "summary": "反斜杠后的空格和注释使多行 OCR 命令失去续行效果。",
      "fix": "将注释移至独立行，保证续行反斜杠位于行末。",
      "confidence": "确认"
    },
    {
      "id": "B-06",
      "skill": "dev-review-solution",
      "location": "skills/dev-workflow/dev-review-solution/SKILL.md:88",
      "severity": "Medium",
      "category": "跨文件一致性",
      "summary": "读者测试门禁未区分全文七问与截断前五问。",
      "fix": "入口和共享契约统一引用读者协议的两种判定及探针要求。",
      "confidence": "确认"
    },
    {
      "id": "B-07",
      "skill": "dev-review-change",
      "location": "skills/dev-workflow/dev-review-change/agents/openai.yaml:4",
      "severity": "Medium",
      "category": "触发与边界",
      "summary": "默认提示直接要求正式治理材料，与普通审查默认建议审查冲突。",
      "fix": "默认提示先分流，仅正式准入绑定 gate_context、DEV 和 producer。",
      "confidence": "确认"
    },
    {
      "id": "B-08",
      "skill": "requirements-review",
      "location": "skills/dev-workflow/requirements-review/SKILL.md:58",
      "severity": "Medium",
      "category": "可判定性",
      "summary": "严重度只有枚举，没有支撑风险接受门禁的判级依据。",
      "fix": "补充基于需求影响的简短定义，明确 High 与 Medium 的边界。",
      "confidence": "确认"
    },
    {
      "id": "B-09",
      "skill": "共享 references",
      "location": "skills/dev-workflow/references/writing-principles.md:7",
      "severity": "Low",
      "category": "精简与分层",
      "summary": "通用写作限制覆盖评审报告，与身份字段和宽表模板冲突。",
      "fix": "限定设计叙事规则的适用范围，正式评审字段遵循阶段模板。",
      "confidence": "确认"
    }
  ]
}
```
