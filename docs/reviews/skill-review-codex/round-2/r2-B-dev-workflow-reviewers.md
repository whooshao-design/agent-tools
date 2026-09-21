# dev-workflow 评审门禁链路 第 2 轮报告

## 1. 总体判断

本批次暂不可收敛：9 条旧 finding 中，8 条已关闭，B-06 部分关闭。
Claude 标记全部采纳，但 B-06 遗漏正式报告模板，读者测试仍存在两套判定口径。
已逐文件读完范围内 30 个文件并核对精确 diff；未确认新 findings，未修改文件。
hook、工作流契约与结构检查共 58 项通过；另验证非法 conclusion 首次拦截及 OCR 示例参数完整性，未执行远程模型或双端正式评审集成验证。
做得好、不要动：不可变审批记录、运行时独立性校验、建议审查与正式准入分流，以及外部评审结果仅作候选线索的边界。

## 2. 旧 finding 处置核对

以下路径相对于 `/home/joney/projects/ai/agent-tools/`。

| ID | 状态 | 证据（文件:行号 + 一句话） |
|---|---|---|
| B-01 | 已关闭 | `skills/dev-workflow/dev-review-solution/SKILL.md:146` 纳入“引用或依赖这些章节的章节”，并要求依赖无法确认时完整复审，覆盖了跨章节语义影响。 |
| B-02 | 已关闭 | `skills/dev-workflow/dev-review-test-cases/references/review-template.md:25` 拆为“原授权绑定”和“本轮复核绑定 `(R,S,C,B)`”，可以同时保留授权来源与当前清单绑定。 |
| B-03 | 已关闭 | `hooks/subagent_result_guard.py:115` 在枚举判断前检查字符串类型；`:116` 抛出 `ContractError`，实测两个客户端的数组、对象 conclusion 首次均返回 `block`。 |
| B-04 | 已关闭 | `skills/dev-workflow/dev-review-change/references/ocr-evidence.md:36` 改为“`> rounds/round-<N>/ocr-files.json`”；本机 preview 帮助确认无 `--output`，保存方式已修正。 |
| B-05 | 已关闭 | `skills/dev-workflow/dev-review-change/references/ocr-evidence.md:17` 将说明移至独立注释行，`:19` 起续行符均位于行末；替换占位符后用 shell 函数验证全部参数完整传入。 |
| B-06 | 部分关闭 | `skills/dev-workflow/dev-review-solution/SKILL.md:88` 已区分“全文读者七问、截断读者前五问”，但 `skills/dev-workflow/dev-review-solution/references/review-template.md:73` 仍要求“七问全部通过”，模板尚未同步。 |
| B-07 | 已关闭 | `skills/dev-workflow/dev-review-change/agents/openai.yaml:4` 明确“建议审查（普通 PR/diff，默认）”，且“只有正式准入才绑定”治理材料，与正文分流一致。 |
| B-08 | 已关闭 | `skills/dev-workflow/requirements-review/SKILL.md:58` 补充从“方案无法启动”“建立在错误前提上”到“带假设继续”的影响定义，已有判级依据。 |
| B-09 | 已关闭 | `skills/dev-workflow/references/writing-principles.md:3` 明确“模板与本文冲突时以模板为准”，`:7`、`:22` 分别保留评审绑定字段和阶段模板宽表。 |

B-06 的剩余失败场景：全文读者七问通过、截断读者前五问通过且 Q6/Q7 答“找不到”时，正式 reviewer 按模板第 73 行填表，仍可能将协议允许的结果标为 Finding；若把该行理解为仅检查全文，又可能漏记截断读者结果。最小修改是将该行统一为按 `reader-test-protocol.md` §5 判定，明确两种读者各自的通过条件。

## 3. 对拒绝 / 部分采纳项的表态

| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |
|---|---|---|
| 无 | 不适用 | `round-1/audit.md:19` 的 B 批次全部标记采纳，没有拒绝或部分采纳项；B-06 属于实施遗漏。 |

## 4. 新 findings

无。B-06 的模板遗漏计入旧 finding 的部分关闭，不另编号重复报告。

## 5. 收敛判断

不可收敛：B-06。

该 Medium 项仍有明确执行歧义，且审核结论为采纳，不能按已记录分歧视为收敛；补齐模板判定即可继续核销。

## 6. JSON

```json
{
  "batch": "B",
  "closed": ["B-01", "B-02", "B-03", "B-04", "B-05", "B-07", "B-08", "B-09"],
  "partial": ["B-06"],
  "open": [],
  "regressions": [],
  "disagree": [],
  "new_findings": [],
  "converged": false
}
```
