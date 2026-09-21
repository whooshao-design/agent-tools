# common + dev-quality + cicd 第 3 轮报告

## 1. 总体判断

本批次不可收敛：本轮核对的 6 项中，5 项已关闭，C-04 的修复引入 1 项 Medium 回归。
已按第 2 轮报告为基准，核对工作树精确 diff、本批次 12 个 skill、引用材料及脚本接口。
宿主过滤实现了通道选择，却破坏了需求评审明确要求的两后端轮换。
7 项无需文件写入的定向测试通过；内存模拟复现轮换回归，未启动外部模型或执行集成验证。
做得好、不要动：EPUB 原件保护、Jenkins 固定构建身份、覆盖率临时修改恢复，以及正式 reviewer 身份和只读核验。
以下文件路径均相对于 `/home/joney/projects/ai/agent-tools/`；未修改文件，已忽略指定的 ClickHouse 未跟踪文件。

## 2. 旧 finding 处置核对

| ID | 状态 | 证据（文件:行号 + 一句话） |
|---|---|---|
| C-01 | 已关闭 | `skills/common/spawn-model-agent/SKILL.md:12` 改为“固定的默认权限”，`:55` 明确受限或无需写入的任务加 `--readonly`；`scripts/spawn_model_agent.py:11` 同步删除权限继承承诺，已消除上轮剩余矛盾。 |
| C-04 | 改动引入新问题 | `skills/common/build-codeagent/scripts/pick_agent.py:131` 新增宿主过滤，正文 `SKILL.md:117` 已解释单通道例外；但过滤所有异宿主后端，破坏两强轮换，见 C-3-01。 |
| C-06 | 已关闭 | `skills/common/build-codeagent/references/backend-evaluation.md:26`、`:27` 分开“JSON 可提取”和人工格式检查，`:71` 要求二者均通过，不再单凭 `json_ok` 证明格式合规。 |
| C-07 | 已关闭 | `skills/dev-quality/review-db-change/SKILL.md:28` 与 `skills/dev-quality/review-middleware-reliability/SKILL.md:28` 均明确“方案阶段……不要求 diff”，并区分建议审查与正式准入。 |
| C-2-01 | 已关闭 | `skills/common/spawn-model-agent/scripts/spawn_model_agent.py:253` 使用 `tempfile.mkdtemp(...)` 原子分配唯一目录，`:254` 才写任务输入；同秒任务不再共用目录。 |
| C-2-02 | 已关闭 | 两个专项的 `SKILL.md:28` 均明确“建议审查只要有 diff 和现有上下文就可做”，验证缺口在结论披露，消除了无运行验证即退出的限制。 |

## 3. 对拒绝 / 部分采纳项的表态

第 2 轮审核文件对本批次待处理项均为“采纳”，没有新增拒绝或部分采纳项。此前涉及的两项立场如下：

| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |
|---|---|---|
| C-01 | 同意 | 保留审核记录中的默认权限裁定；本轮已删除定位段和脚本说明的“同等权限”承诺，并明确受限任务使用只读，上轮剩余异议解除。 |
| C-05 | 同意 | 维持人工核对机械候选命中的方案；`skills/common/build-codeagent/references/backend-evaluation.md:25`、`:71` 已要求核对位置与对应关系后才使用有效分，不必增加匹配算法。 |

## 4. 新 findings

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| C-3-01 | build-codeagent | `skills/common/build-codeagent/scripts/pick_agent.py:131`、`:149`；`skills/common/build-codeagent/model-routing.json:201` | Medium | 改动回归／轮换规则冲突 | 宿主过滤把不同模型也当作可替代通道，导致需求评审永久复用同一后端。Codex 编排器评审由 `claude-deepseek` 生成的需求时，首轮选择 `codex-vps`，后续仍选择它，未使用的 `claude-vps` 始终被过滤。 | 实现先执行 `pool = same_host`，再检查未使用候选；路由表却明确“用户指定：质量优先，只在两个最强后端间轮换”。内存模拟连续三轮均选择 `codex-vps`，后两轮返回“候选已用完”，尽管 `claude-vps` 从未参与。 | 宿主过滤仅用于确认是同一模型的双通道候选；保留不同模型的轮换资格，并补需求评审连续两轮选择不同后端的回归检查。 | 确认 |

## 5. 收敛判断

不可收敛：C-04（修复引入回归）、C-3-01。

两者指向同一个剩余问题：宿主通道选择不能覆盖明确要求的不同模型轮换。

## 6. JSON

```json
{
  "batch": "C",
  "closed": ["C-01", "C-06", "C-07", "C-2-01", "C-2-02"],
  "partial": [],
  "open": [],
  "regressions": ["C-04"],
  "disagree": [],
  "new_findings": [
    {
      "id": "C-3-01",
      "skill": "build-codeagent",
      "location": "skills/common/build-codeagent/scripts/pick_agent.py:131; skills/common/build-codeagent/scripts/pick_agent.py:149; skills/common/build-codeagent/model-routing.json:201",
      "severity": "Medium",
      "summary": "宿主过滤排除了不同模型的异宿主候选，导致需求评审连续复用同一后端，破坏明确要求的两强轮换。",
      "fix": "仅对确认是同一模型的双通道候选执行宿主过滤，保留不同模型轮换资格，并补连续两轮的回归检查。"
    }
  ],
  "converged": false
}
```
