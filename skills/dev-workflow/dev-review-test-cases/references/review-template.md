# <需求名称>测试清单独立复核报告

> 使用说明：本报告检查测试清单是否漏项、错项或不可执行，不执行测试。它只对下列精确产物版本和代码基线生效；不复制清单正文。任一绑定项变化后必须重新复核。

## 1. 评审对象绑定

| 项目 | 内容 |
|---|---|
| 不可变报告 / 轮次 | rounds/round-<N>/report.md / Round <N> |
| 测试清单身份 `C` | <ref；version；sha256-v1:fingerprint；summary> |
| 需求身份 `R` | <ref；version；sha256-v1:fingerprint；summary> |
| 验收标准范围 | AC-001... |
| 方案身份 `S` | <ref；version；sha256-v1:fingerprint；summary> |
| 方案评审记录 / 结论 | <审批引用；绑定 `(R,S,B)`> / 通过 |
| 代码基线 `B` | <repo-snapshot-v1 身份或 handoff 引用> |
| 清单产出者 | <producer_agent_refs[]> |
| 独立复核者 | <由编排器在 stop 后附着 reviewer_agent_ref；reviewer 不填写> |
| 运行时检查 | independence / read_only / write_set_empty / tool_surface = Pass / Fail |
| 评审执行 | <task_id；input_fingerprints；status；structure_check；valid / formal_reviewer_unavailable / invalid> |
| 评审范围 / 排除范围 | |
| 评审日期 | YYYY-MM-DD |

### 已明确接受的风险与假设

| Finding ID / 指纹 | 绑定 `(R,S,B)` | 风险 / 假设 / 排除项 | 对本评审的影响 | 授权引用 | 生效/到期条件 |
|---|---|---|---|---|---|
| RISK-001 / <fingerprint> | | | | | |

没有有效授权记录时不得视为已接受；没有此类前提时写“无”。

## 2. 评审历史

> 每轮保存在不可变 `rounds/round-<N>/`；本表引用历史 `approval-record.json` 及其 fingerprint。

| 轮次 | 清单版本 | 方案版本 | 代码基线 | 结论 | 审批记录 ref / fingerprint |
|---|---|---|---|---|---|
| Round 1 | v1 | v1 | | | rounds/round-1/approval-record.json / |

## 3. 评审结论

- 结论：通过 / 修改后复审 / 方案缺口 / 材料不足
- 编码准入：允许 / 不允许
- Open Blocker：0
- Open High：0
- Open Medium：0
- Open Low：0
- 一句话依据：

只有 Open Blocker/High/Medium 均为 0 且绑定材料完整时才能“通过”。
仅当评审执行状态为 `valid` 时填写领域结论；否则结论留空，且不得形成编码准入。

## 4. 三向追踪与覆盖证据

| 检查项 / 维度 | 关联需求/方案/检查项 | 核对证据 | 结果 / 不适用理由 |
|---|---|---|---|
| 需求 → 方案 → 检查项 | | | |
| 正常 / 异常 / 边界 | | | |
| 并发 / 权限 / 安全 | | | |
| 兼容 / 迁移 / 性能 | | | |
| 观测 / 发布 / 回滚 | | | |
| 其他领域维度 | | | |

## 5. Findings

| ID / 内容指纹 / root_cause_id | 严重度 | 原因类型 | 关联需求/方案/检查项 | 证据 | 影响 | 建议 | 关闭条件 | 状态 |
|---|---|---|---|---|---|---|---|---|
| TC-R-001 / <fingerprint> | | 清单问题 / 方案缺口 / 材料问题 | | | | | | Open / Resolved |

没有问题时写“未发现遗漏、假覆盖或追踪断点”，不要制造 findings。风险接受仅引用第 1 节的有效授权，不另设风险接受状态。

### Finding 关闭记录

| Finding ID | 原状态 → 新状态 | 关闭证据 | 复核人 / 日期 |
|---|---|---|---|
| TC-R-001 | Open → Resolved | | |

## 6. 后续动作

- 需要补充或加强的检查项：
- 需要回 `dev-design-solution` 处理的方案缺口：
- 需要补齐的材料：
- 保留到下一轮的 findings / 待办：
- 进入编码的前置条件：
- 本轮审批记录路径：rounds/round-<N>/approval-record.json（由编排器在 stop 后生成）

若方案缺口与清单问题并存，先回设计阶段，并保留全部清单 findings；方案重新评审通过、受影响清单生成新版本后继续逐条关闭。

> 编排器在 `report.md` 落盘后，必须在外部 handoff 中返回审批记录、报告和委派结果各自的 ref/fingerprint；不得把当前报告或审批记录的自身指纹写回本文件，避免循环哈希。
