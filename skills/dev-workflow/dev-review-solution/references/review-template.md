# <需求名称>技术方案评审

> 使用说明：报告引用冻结的方案身份，只记录结论、findings、覆盖证据和后续动作，不复制方案正文。没有实质内容的占位应删除。

## 0. 一页评审结论

- 结论：通过 / 有条件通过 / 修改后复审 / 退回重设计 / 材料不足
- Blocker / High / Medium / Low：0 / 0 / 0 / 0
- 一句话依据：
- 首要阻断或风险：无 / <Finding ID>
- 是否可进入测试清单编写：是 / 否
- 受限判断：无 / <缺失证据及影响>

> 仅当评审执行状态为 `valid` 时填写领域结论；否则结论留空，且不得形成审批事实。

## 1. Findings 摘要

| ID / 内容指纹 | 根因 ID | 严重度 | 类别 | 对象引用 | 问题 | 是否阻塞 | 状态 |
|---|---|---|---|---|---|---|---|
| TR-001 / <fingerprint> | RC-001 | Blocker / High / Medium / Low | | CHG-001 / DEC-001 / AC-001 / 章节 | | 是 / 否 | Open / Resolved / Accepted |

类别使用：`结构` / `需求追踪` / `可行性` / `架构` / `接口数据` / `可靠性` / `性能` / `安全` / `可观测性` / `可测试性` / `发布` / `证据`。

没有问题时明确写“未发现阻断问题”，不要为填充模板制造 findings。

## 2. Findings 详情

### TR-001 [Blocker / High / Medium / Low] <问题标题>

- 类别：
- 对象引用：DEC-001 / CHG-001 / AC-001 / RISK-001 / 具体章节
- 根因 ID：RC-001
- 问题：
- 证据：
- 影响：
- 根因与修复位置：需求 / 方案 DEC / 方案 CHG / 外部证据
- 建议：
- 是否阻塞开发：是 / 否
- 关闭条件：
- 内容指纹：
- 状态：Open / Resolved / Accepted（仅 Medium 且有匹配授权）

> 每条 finding 只表达一个可验证问题；没有详细 findings 时删除本节占位。

## 3. CHG 逐项评审覆盖

| CHG | 来源 AC/约束 | 当前证据 | 目标行为与不变量 | 相关边界与风险 | 验证/发布/回滚 | 结果 / Finding |
|---|---|---|---|---|---|---|
| CHG-001 | AC-001 | | | | | Pass / Finding / Unknown |

> 必须覆盖 `traceability.md` 追踪矩阵中的每个 `CHG-*`；逐项覆盖不要求正文按 CHG 分章。`保持不变` 项按受保护的回归边界评审，不要求实现步骤。

## 4. 全局一致性与跨变更风险

### 4.1 结构与追踪准入

| 检查项 | 结果 | 证据或 Finding |
|---|---|---|
| 使用统一核心壳且只有一个合理主 profile | Pass / Finding / Unknown | |
| 摘要与权威正文一致，现状与目标设计分离；正文无矩阵、指纹、处置痕迹 | | |
| 第 3 章按 guide→reference 和技术机制组织，不是 CHG/文件清单 | | |
| 同级单一划分维度，DEC 与横切内容只有一个权威位置 | | |
| AC→设计→CHG→验证/发布闭环，无孤儿变更；traceability 引用的章节存在 | | |
| 主图存在或豁免成立；`diagrams/results.md` 全部通过 | | |
| 全称断言可复跑，Unknown 不支撑方案结论 | | |

结构类 finding 标记：`profile 误选` / `正文清单化` / `层级错位` / `结构重叠` / `覆盖缺口` / `孤儿变更` / `重复事实源` / `表达冗余`。只有影响决策、实施或验证时才记录，不评价无影响的标题和个人文风。

### 4.2 分层阅读与信息密度

| 测试 | 结果 | 证据或 Finding |
|---|---|---|
| 读者测试：`reader-test/agent-v<N>.md` 七问全部通过，探针矛盾已处置 | Pass / Finding / Unknown | |
| 30 秒扫描：问题、选择、主要变化、最大风险、待裁定项 | | |
| 5 分钟理解：机制、主要影响、上线与证明路径 | | |
| 标题测试：第 3 章标题可恢复设计推理 | | |
| 双读者测试：新读者可理解，实施者可定位精确边界 | | |
| 唯一归属与范围隔离 | | |

### 4.3 跨变更技术风险

| 维度 | 结果 | 证据、N/A 原因或 Finding |
|---|---|---|
| 架构职责与依赖方向 | Pass / Finding / N/A / Unknown | |
| 共享状态、事务、并发与一致性 | | |
| 性能与容量 | | |
| 安全与权限 | | |
| 可观测性与故障恢复 | | |
| 发布、迁移与整体回滚 | | |

## 5. 已接受风险

| Finding ID / 指纹 | 绑定 `(R,S,B)` | 接受原因 | 授权来源与时间 | 生效/到期条件 | 后续动作 |
|---|---|---|---|---|---|
| | | | | | |

没有已接受风险时写“无”。

## 6. 后续动作与复审策略

| 动作 | 对应 Finding / DEC / CHG | 完成条件 | 是否需要复审 |
|---|---|---|---|
| | | | |

- 下一轮模式：完整复审 / 定点复审 / 无需复审
- 定点复审范围：<待关闭 findings；受影响 DEC/CHG/RISK>
- 强制全局结构与追踪检查：方案身份、摘要/正文一致性、CHG 集合、变更影响非回归
- 进入测试清单编写的前置条件：
- 本轮审批记录路径：`rounds/round-<N>/approval-record.json`（由编排器在 stop 后生成）

> 定点复审只缩小领域重查范围；新旧方案差异或影响范围无法可靠证明时，必须完整复审。

## 7. 评审对象与执行

| 项目 | 内容 |
|---|---|
| 不可变报告 / 轮次 | `rounds/round-<N>/report.md` / Round <N> |
| 评审模式 | 完整评审 / 定点复审 |
| 方案身份 `S` | <ref；version；sha256-v1:fingerprint；summary> |
| 上一版 `S` / 审批记录 | 无 / <ref；fingerprint> |
| 本轮差异与影响范围 | 无 / <受影响 DEC/CHG/RISK；diff 证据> |
| 需求身份 `R` | <ref；version；sha256-v1:fingerprint；summary> |
| 代码基线 `B` | <repo-snapshot-v1 身份或 handoff 引用> |
| 评审范围 | <本轮覆盖范围与明确排除项> |
| 方案产出者 | <producer_agent_refs[]> |
| 独立评审者 | <由编排器在 stop 后附着 reviewer_agent_ref；reviewer 不填写> |
| 运行时检查 | independence / read_only / write_set_empty / tool_surface = Pass / Fail |
| 评审执行 | <task_id；input_fingerprints；status；structure_check；valid / formal_reviewer_unavailable / invalid> |
| 参考材料 | <需求、方案、代码、数据、配置> |
| 评审日期 | YYYY-MM-DD |

## 8. 评审历史

> 仅在第 2 轮及以后保留。每轮目录不可覆盖；本表只引用历史 `approval-record.json` 及其 fingerprint。

| 轮次 | 审批记录 ref / fingerprint | 对应方案版本 | 结论 | 一句话依据 |
|---|---|---|---|---|
| 1 | `rounds/round-1/approval-record.json` / | v1 | | |

> 编排器在 `report.md` 落盘后，必须在外部 handoff 中返回审批记录、报告和委派结果各自的 ref/fingerprint；不得把当前报告或审批记录的自身指纹写回本文件，避免循环哈希。
