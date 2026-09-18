# <方案名称>：追踪与治理

> 对应 `solution.md` v<N>（YYYY-MM-DD）。本文件承担交付完整性，不控制正文叙事；设计理由只在 `solution.md`，这里只做映射、登记和证据索引。

> 使用说明（生成后删除）：本文件与 `solution.md` 一起构成方案身份 `S`（文件集指纹，见 `artifact-identity.md`）。矩阵里的"设计位置"引用 `solution.md` 的章节标题，重构标题时同步更新。没有内容的表删除，不留空行。

## 1. 身份

| 项目 | 内容 |
|---|---|
| 需求 `R` | <ref；version；summary。指纹在 handoff> |
| 方案 `S` | 文件集：`solution.md` + `traceability.md`；逐文件指纹与清单指纹在 handoff |
| 代码基线 `B` | <repo-snapshot-v1 身份或 handoff 引用> |
| 主 profile | mechanism-architecture / migration-remediation / contract-evolution / data-state-consistency |
| 产出者 | <producer_agent_refs[]> |
| 审批事实 | 不回写本文件；从 `solution-review/rounds/round-<N>/approval-record.json` 读取 |

版本大于 v1 时保留下表，首次成案删除。每轮一行，处置明细在 `solution-review/rounds/round-<N>/resolution.md`。

| 版本 | 日期 | 触发 | 受影响 DEC/CHG/RISK | 变更摘要 | 上一版归档 |
|---|---|---|---|---|---|
| v2 | | round-1 findings | | | `versions/v1/` |

## 2. 验收映射

| AC | 可验证行为 | 设计位置 | 交付单元 | 验证方式 | 失败信号 |
|---|---|---|---|---|---|
| AC-001 | | 3.x | CHG-001 | | |

## 3. 交付单元

追踪闭环：`AC → 设计正文 → CHG → 验证信号 → 发布/回滚`。每个 CHG 至少绑定一个 AC、已确认约束、DEC 或风险处置；没有来源的是孤儿变更。动作只取 `新增 / 修改 / 删除 / 保持不变`。

| CHG | 动作 | 对象 | 调整摘要 | 设计位置 | 来源 | 验证入口 | 发布/回滚 |
|---|---|---|---|---|---|---|---|
| CHG-001 | 新增 / 修改 / 删除 / 保持不变 | | | 3.x | AC-001 / DEC-001 | | 第 6 章 <阶段> |

逐文件对象、工时、负责人、commit 和开发批次不在这里，交给 `dev-build-change`。

## 4. 横切维度覆盖

按 `design-dimensions.md` 逐项判断；相关内容写在 `solution.md` 对应机制处，这里只记录权威位置。

| 维度 | 结果 | 权威位置或 N/A 原因 |
|---|---|---|
| 接口/契约 | Pass / N/A / Unknown | |
| 数据/存储 | | |
| 配置/开关 | | |
| 并发/幂等 | | |
| 外部依赖/可靠性 | | |
| 兼容/迁移 | | |
| 安全/权限 | | |
| 性能/容量 | | |
| 可观测性 | | |
| 发布/回滚 | | |

## 5. 风险登记

`solution.md` 第 7 章只写残余风险的叙述，这里登记状态与绑定。

| RISK | 描述 | 关联 DEC/设计位置/CHG | 缓解或决策条件 | 状态 |
|---|---|---|---|---|
| RISK-001 | | | | Open / Pre-authorized / Closed |

## 6. 证据清单

正文用 `[E-n]` 引用。全称断言（唯一、全仓 0 命中、完整枚举）必须给出可复跑命令、检索范围含排除项、命中计数；负向断言至少两条独立检索路径。

| E | 内容 | 位置或命令 | 范围与计数 |
|---|---|---|---|
| E-1 | | | |
