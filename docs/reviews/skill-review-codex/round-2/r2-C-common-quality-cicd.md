# common + dev-quality + cicd 第 2 轮报告

## 1. 总体判断

本批次不可收敛：旧项 7 条已关闭、3 条部分关闭、1 条处置引入新问题；新增 High、Medium 各 1 条。
已核对本批次精确 diff、12 个 skill 及目录内引用材料、脚本接口；忽略指定的 ClickHouse 未跟踪文件。
离线内存模拟确认只读续接和超时终态修复有效，也确认同秒启动会共用作业目录；未启动外部模型、访问内网或写入文件。
做得好、不要动：EPUB 原件保护与回读校验、Jenkins 固定构建身份、覆盖率临时修改恢复、正式 reviewer 身份与只读核验。
以下路径均相对于 `/home/joney/projects/ai/agent-tools/`；本报告不代表完整集成验证通过。

## 2. 旧 finding 处置核对

| ID | 状态 | 证据（文件:行号 + 一句话） |
|---|---|---|
| C-01 | 部分关闭 | `skills/common/spawn-model-agent/SKILL.md:55` 已明确“默认权限是固定值”并要求受限任务加只读，但 `:12` 仍承诺“以和主会话同等的权限跑完任务”，脚本 `scripts/spawn_model_agent.py:11` 也保留同等权限说明，删除错误承诺尚未完成。 |
| C-02 | 已关闭 | `skills/common/spawn-model-agent/scripts/spawn_model_agent.py:188` 使用 `a.readonly or bool(prev.get('readonly'))`；内存模拟确认恢复后的 Codex 命令仍为 `read-only`。 |
| C-03 | 已关闭 | `skills/common/spawn-model-agent/scripts/spawn_model_agent.py:198` 捕获超时，`:205` 保存原始输出，`:213` 写终态；两通道模拟均得到 `exit_code="timeout"`、返回码 124，状态入口 `:162` 显示“超时”。 |
| C-04 | 部分关闭 | `skills/common/build-codeagent/SKILL.md:117` 已解释五个单通道环节，但仍要求双通道“在哪个客户端就用哪一套”；`scripts/pick_agent.py:118` 从全部未排除候选建池、`:141` 随机选择，调用步骤未要求按宿主构造 `--exclude`，双通道路径仍不一致。 |
| C-05 | 已关闭 | `skills/common/build-codeagent/references/backend-evaluation.md:25` 明确“人工核对命中位置与对应关系后才计入有效分”，`:70` 将正式候选门槛改为人工核对后的有效命中；保留机械脚本可接受。 |
| C-06 | 部分关闭 | `skills/common/build-codeagent/references/backend-evaluation.md:26` 已披露“不检查是否恰好一个代码块”，但仍命名为“格式遵从”，`:70` 继续用它判定格式通过；`evals/review-seeded/prompt.md:7` 仍要求“只输出一个 JSON 代码块”。 |
| C-07 | 改动引入新问题 | 两个专项 `SKILL.md:28` 均已豁免方案阶段 diff，原问题消除；数据库专项同时新增“代码阶段……diff 与验证证据”硬前提，与主入口允许无运行验证的建议审查冲突，见 C-2-02。 |
| C-08 | 已关闭 | `skills/dev-quality/review-db-change/SKILL.md:36` 已将多阶段迁移限定于新旧代码并存且保留存量数据，并明确空表、停机窗口、离线变更按实际恢复要求判断。 |
| C-09 | 已关闭 | `skills/cicd/fix-sonarqube-issues/SKILL.md:29` 已要求先查询门禁及失败条件并报告结论；`mcp/devtools-mcp/devtools_mcp/sonarqube_server.py:127` 的工具接口支持所述项目、分支和 PR 参数。 |
| C-10 | 已关闭 | `skills/common/skill-authoring/SKILL.md:89`、`:93`、`:102` 已补仓库测试、路由评测、case 数量与内容变更升版本的必做要求。 |
| C-11 | 已关闭 | `skills/common/debug-systematic/SKILL.md:13` 已改指当前 `lexin` 分类；`tests/test_skill_lint.py:27` 同步移除旧分类豁免。 |

## 3. 对拒绝 / 部分采纳项的表态

| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |
|---|---|---|
| C-01 | 不同意 | 同意保留审核记录所述的用户裁定默认值，但不同意认为错误承诺已删除。受限主会话执行“让 kimi 总结文件”时，定位段仍告诉它权限等同主会话，示例又不带 `--readonly`；照该入口启动就会使用宽权限，与末尾边界规则冲突。只需同步删除定位段和脚本说明中的同等权限承诺，不必推翻默认值裁定。 |
| C-05 | 同意 | 不增加位置匹配算法是合理取舍；当前文档已要求逐项核对候选命中的位置与对应关系，并以核对后的有效分决定正式候选资格，能够约束 agent 正确使用机械结果。 |

## 4. 新 findings

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| C-2-01 | spawn-model-agent | `skills/common/spawn-model-agent/scripts/spawn_model_agent.py:251`、`:253`、`:259` | High | 作业隔离与输出契约 | 同一后端在同一秒启动两项任务会共用目录，后启动者覆盖任务输入，子进程可能执行错误任务，结果和续接身份也会相互覆盖。首轮漏项。 | 目录仅由 `strftime('%Y%m%d-%H%M%S') + '-' + backend` 构成，创建使用 `exist_ok=True`，`task.md` 用 `'w'` 打开，后台子进程再从该文件读取任务；固定同一秒连续调用两次 `main()` 的内存模拟确认 `SPAWN_JOB_DIR` 完全相同。 | 用 `tempfile.mkdtemp` 等原子唯一目录分配方式保留时间和后端前缀，禁止复用已有作业目录。 | 确认 |
| C-2-02 | review-db-change / review-middleware-reliability | `skills/dev-quality/review-db-change/SKILL.md:28`；`skills/dev-quality/review-middleware-reliability/SKILL.md:28` | Medium | 跨 skill 前置条件冲突 | 未区分建议审查与正式准入，缺少运行验证时会误挡数据库或中间件静态审查；本轮数据库措辞将此限制明确硬化。 | 两处均将缺少“diff 与验证证据”列为不适用；但 `skills/dev-workflow/dev-review-change/SKILL.md:18` 明确“验证未运行……仍可完成静态审查”，`:43` 只对正式准入要求先验证。用户要求只读审查尚未跑测试的 SQL/重试 diff 时，主入口允许继续，专项却要求退出。 | 将运行验证前提限定于正式准入；建议审查允许基于 diff 和现有上下文继续，并披露验证缺口。 | 确认 |

## 5. 收敛判断

不可收敛：C-04、C-06、C-07（对应 C-2-02）、C-2-01、C-2-02。

C-01 的剩余分歧已记录；其默认权限裁定不再单独作为阻止收敛的理由。C-04 应明确宿主过滤由谁执行；C-06 应将 JSON 可提取与提示词格式合规分开，不能继续共用“格式通过”结论。

## 6. JSON

```json
{
  "batch": "C",
  "closed": ["C-02", "C-03", "C-05", "C-08", "C-09", "C-10", "C-11"],
  "partial": ["C-01", "C-04", "C-06"],
  "open": [],
  "regressions": ["C-07"],
  "disagree": ["C-01"],
  "new_findings": [
    {
      "id": "C-2-01",
      "skill": "spawn-model-agent",
      "location": "skills/common/spawn-model-agent/scripts/spawn_model_agent.py:251; skills/common/spawn-model-agent/scripts/spawn_model_agent.py:253; skills/common/spawn-model-agent/scripts/spawn_model_agent.py:259",
      "severity": "High",
      "summary": "同一后端同秒启动会共用作业目录，覆盖任务输入、结果和续接身份。",
      "fix": "使用原子唯一目录分配方式，禁止复用已有作业目录。"
    },
    {
      "id": "C-2-02",
      "skill": "review-db-change / review-middleware-reliability",
      "location": "skills/dev-quality/review-db-change/SKILL.md:28; skills/dev-quality/review-middleware-reliability/SKILL.md:28",
      "severity": "Medium",
      "summary": "代码阶段无运行验证即排除专项审查，与主入口允许静态建议审查冲突。",
      "fix": "将运行验证前提限定于正式准入；建议审查继续执行并披露验证缺口。"
    }
  ],
  "converged": false
}
```
