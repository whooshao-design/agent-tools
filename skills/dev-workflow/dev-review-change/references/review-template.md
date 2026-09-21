# <需求名称>代码评审报告

## 1. 评审对象

| 项目 | 内容 |
|---|---|
| 不可变报告 / 轮次 | rounds/round-<N>/report.md / Round <N> |
| gate context `G` | approved: `T=(R,S,C,B)` + approvals `{ref,fingerprint}` / direct: `D={ref,fingerprint}` → `direct-record-v1` / waived: `W={ref,fingerprint}` → `waiver-record-v1` |
| change revision | <repo-snapshot-v1 身份> |
| DEV 执行证据 | <最终状态；实际写集归属；未完成/越界项> |
| 代码产出者 | <producer_agent_refs[]> |
| 独立评审者 | <由编排器在 stop 后附着 reviewer_agent_ref；reviewer 不填写> |
| 运行时检查 | independence / read_only / write_set_empty / tool_surface = Pass / Fail |
| 评审执行 | <task_id；input_fingerprints；status；structure_check；valid / formal_reviewer_unavailable / invalid> |
| 验证报告 / 结论 | |
| 外部评审证据 | 无 / rounds/round-<N>/ocr.json + fingerprint（provider/model，与 producer 模型不同） |
| 评审范围 / 排除范围 | |
| 上一轮审批记录 | 无 / rounds/round-<N-1>/approval-record.json + fingerprint |
| 日期 | YYYY-MM-DD |

## 2. 结论

- 结论：可继续推进 / 修复后再评 / 带风险接受 / 证据不足
- 一句话依据：
- 证据限制：无 / <缺口及影响>

> 仅当评审执行状态为 `valid` 时填写领域结论；否则结论留空，且不得形成交付准入。

## 3. Findings

| ID / 指纹 | 严重度 | 对象引用 | 根因类型 | 维度 | 问题 | 证据 | 影响 | 建议 | 关闭条件 | 状态 |
|---|---|---|---|---|---|---|---|---|---|---|
| CR-001 / <fingerprint> | High / Medium / Low | DEV-001 / 文件:行 | 实现问题 / 清单缺口 / 方案缺口 / 需求缺口 / 材料缺口 | | | | | | | Open / Resolved / Accepted |

High 不允许 Accepted；Medium Accepted 必须在第 5 节存在匹配授权。没有问题时写“未发现 High/Medium finding”。

## 4. 评审覆盖

| 维度 | 结果 | 证据或说明 |
|---|---|---|
| 正确性 | Pass / Finding / Unknown | |
| 架构与改动边界 | | |
| 安全 | | |
| 稳定性与发布风险 | | |
| 复杂度与冗余 | | |

逐文件覆盖（信封提供可评审文件清单时必填）：

| 文件 | 状态 | 已评审 / 跳过原因 |
|---|---|---|
| | | |

## 5. 已接受风险

| Finding ID / 指纹 | 绑定 `G` / change revision | 授权引用 | 生效/到期条件 | 独立复核结果 | 后续动作 |
|---|---|---|---|---|---|
| | | | | Pending / Accepted / Rejected | |

没有已接受风险时写“无”。

## 6. 证据缺口与后续动作

| 缺口或 finding | 根因类型 | 所需动作 | 完成条件 | 最早失效阶段 |
|---|---|---|---|---|
| | | | | |

- 本轮审批记录路径：rounds/round-<N>/approval-record.json（由编排器在 stop 后生成）

> 编排器在 `report.md` 落盘后，必须在外部 handoff 中返回审批记录、报告和委派结果各自的 ref/fingerprint；不得把当前报告或审批记录的自身指纹写回本文件，避免循环哈希。
