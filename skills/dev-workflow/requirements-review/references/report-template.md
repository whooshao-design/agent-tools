# 需求评审报告 - <需求标题>

## 1. 评审范围
- 文档引用：
- 版本：
- 内容指纹：sha256-v1:<hash>
- 内容摘要：
- 不可变报告：rounds/round-<N>/report.md
- 评审轮次：Round <N>
- 上一轮审批记录：无 / rounds/round-<N-1>/approval-record.json + fingerprint
- 系统/模块：
- 本轮范围/排除范围：
- 目标上线时间：
- 关键相关方：
- 需求产出者：<producer_agent_refs[]>
- 独立评审者：<由编排器在 stop 后附着 reviewer_agent_ref；reviewer 不填写>
- 运行时检查：independence / read_only / write_set_empty / tool_surface = Pass / Fail
- 评审执行：<task_id；input_fingerprints；status；structure_check；valid / formal_reviewer_unavailable / invalid>

## 2. 结论
- 结论：通过 / 有条件通过 / 不通过 / 材料不足
- Blocker 数量：
- High 数量：
- Medium 数量：
- Low 数量：
- 一句话依据：

> 仅当评审执行状态为 `valid` 时填写领域结论；否则结论留空，且不得形成审批事实。

## 3. 问题清单（优先按严重度排序）
| ID / 内容指纹 | 严重度 | 类别 | 问题 | 证据 | 影响 | 建议/行动项 | 关闭条件 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RR-001 / <fingerprint> | | | | | | | | Open / Resolved / Accepted（仅 Medium 且有匹配授权） |

类别只能取：`目标与范围` / `用户与场景` / `业务规则与状态` / `数据与接口` / `非功能需求` / `验收与测试` / `依赖与发布` / `材料问题`。一条 finding 只选一个主要类别；多个独立问题拆开记录。

## 4. 澄清问题
- 

## 5. 风险与依赖

| Finding ID / 指纹 | 接受原因 | 用户授权引用 | 绑定 `R` | 生效/到期条件 |
|---|---|---|---|---|
| | | | | |

没有已接受风险时写“无”。

## 6. 非规范性验收标准建议（示例：Given/When/Then）

> 本节只提出可验收性建议，不修改需求。采纳后必须由需求 producer 写入新 `R`，再进行新的独立评审。
- AC-001：
  - Given
  - When
  - Then

## 7. 测试要点
- 单测：
- 接口/集成：
- 回归：
- 线上观测：

## 8. 非功能需求核对
- 性能：
- 可用性：
- 安全：
- 可观测：

## 9. 交接

- 稳定需求身份 `R`：<引用 + 版本/内容指纹 + 摘要>
- 本轮审批记录路径：rounds/round-<N>/approval-record.json（由编排器在 stop 后生成）
- 验收标准 ID 范围：
- 下一阶段：`dev-clarify-task` / `dev-design-solution` / 重新评审 / 补材料
- 进入下一阶段的条件：

> 编排器在 `report.md` 落盘后，必须在外部 handoff 中返回审批记录、报告和委派结果各自的 ref/fingerprint；不得把当前报告或审批记录的自身指纹写回本文件，避免循环哈希。
