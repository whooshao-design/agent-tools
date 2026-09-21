# common + dev-quality + cicd 第 4 轮报告

## 1. 总体判断

本批次不可收敛：正常配置下的轮换问题已修复，但新增折叠逻辑将相同的配置错误提示当作模型身份，产生 1 项 Medium 回归。
已核对工作树精确 diff、12 个 skill、引用材料及脚本接口；另发现 2 项一行可修的 Low。
7 项无需文件写入的现有测试通过；内存检查确认正常轮换有效，并复现模型未知时的错误折叠，未启动外部模型或执行集成验证。
做得好、不要动：EPUB 原件保护、Jenkins 固定构建身份、覆盖率临时修改恢复，以及正式 reviewer 身份和只读核验。
以下路径均相对于 `/home/joney/projects/ai/agent-tools/`；未修改文件，已忽略指定的 ClickHouse 未跟踪文件。

## 2. 旧 finding 处置核对

| ID | 状态 | 证据（文件:行号 + 一句话） |
|---|---|---|
| C-04 | 已关闭 | `skills/common/build-codeagent/SKILL.md:117` 明确“同一模型两条通道都在候选里时”才按宿主折叠，并保留五个单通道环节及修订例外；`scripts/pick_agent.py:132` 实现对应规则。 |
| C-3-01 | 改动引入新问题 | `skills/common/build-codeagent/scripts/pick_agent.py:135` 改为按解析模型分组；当前配置下两宿主均可交替选择 `claude-vps`、`codex-vps`，但模型解析失败的占位字符串也参与分组，见 C-4-01。 |

## 3. 对拒绝 / 部分采纳项的表态

第 3 轮 `audit.md` 对本批次为全部采纳，无新增拒绝或部分采纳项。此前两项立场保持如下：

| ID | 同意/不同意 | 理由（不同意时给具体失败场景） |
|---|---|---|
| C-01 | 同意 | 保留用户裁定的默认权限；`skills/common/spawn-model-agent/SKILL.md:12`、`:55` 已删除权限继承承诺，并要求受限或无需写入的任务使用只读。 |
| C-05 | 同意 | `skills/common/build-codeagent/references/backend-evaluation.md:25`、`:71` 已要求人工核对有效命中后再判候选资格，无需增加自动位置匹配算法。 |

## 4. 新 findings

| ID | skill | 位置 | 严重度 | 类别 | 问题 | 证据 | 建议 | 置信度 |
|---|---|---|---|---|---|---|---|---|
| C-4-01 | build-codeagent | `skills/common/build-codeagent/scripts/pick_agent.py:89`、`:135`、`:139` | Medium | 改动回归／模型身份判断 | 模型未知时仍可能折叠不同后端。编排器读取的两份配置均缺少 `model` 时，会把两个未知模型认成同一模型，静默删除异宿主候选，并错误报告候选耗尽。 | 解析失败返回 `"(缺 model)"` 或统一错误字符串；分组直接使用 `by_model.setdefault(resolve_model(...), [])`。内存模拟两份配置缺键，Codex 宿主连续三轮均选择 `codex-vps`，后两轮报告“候选已用完”，而 `claude-vps` 从未参与。 | 仅对成功解析的模型 ID 做折叠；未知模型按后端分别保留或明确报告配置缺口，并补缺键场景检查。 | 确认 |
| C-4-02 | build-codeagent | `skills/common/build-codeagent/scripts/pick_agent.py:257` | Low | 帮助文本未同步 | `--help` 仍称“候选里有同宿主通道时只用同宿主的”，与当前按模型分组的行为不符，容易让 agent 误判跨宿主结果。 | 原文：“候选里有同宿主通道时只用同宿主的”；`:135` 实际先按模型分组。 | 同一行补上“同一模型的双通道”限定。 | 确认 |
| C-4-03 | spawn-model-agent | `skills/common/spawn-model-agent/SKILL.md:34` | Low | 输出路径说明未同步 | 作业目录总述仍缺随机后缀，按该格式拼接 `--status` 或 `--resume` 路径会找不到实际作业。 | 原文：`<时间>-<后端>/`；`:30` 和 `scripts/spawn_model_agent.py:253` 已使用随机后缀。 | 将该行目录格式同步为 `<时间>-<后端>-<随机后缀>/`。 | 确认 |

## 5. 收敛判断

不可收敛：C-3-01（修复引入回归）、C-4-01。

两者对应同一个剩余风险：未知模型不能因错误提示相同而被判定为同一模型。C-4-02、C-4-03 为 Low，不阻止收敛。

## 6. JSON

```json
{
  "batch": "C",
  "closed": ["C-04"],
  "partial": [],
  "open": [],
  "regressions": ["C-3-01"],
  "disagree": [],
  "new_findings": [
    {
      "id": "C-4-01",
      "skill": "build-codeagent",
      "location": "skills/common/build-codeagent/scripts/pick_agent.py:89; skills/common/build-codeagent/scripts/pick_agent.py:135; skills/common/build-codeagent/scripts/pick_agent.py:139",
      "severity": "Medium",
      "summary": "模型解析失败的相同提示被当作同一模型身份，错误折叠不同后端并破坏轮换。",
      "fix": "仅折叠成功解析的模型 ID；未知模型分别保留或明确报告配置缺口，并补缺键场景检查。"
    },
    {
      "id": "C-4-02",
      "skill": "build-codeagent",
      "location": "skills/common/build-codeagent/scripts/pick_agent.py:257",
      "severity": "Low",
      "summary": "--host 帮助文本仍描述旧的全池宿主过滤规则。",
      "fix": "在同一行补上同一模型双通道的限定。"
    },
    {
      "id": "C-4-03",
      "skill": "spawn-model-agent",
      "location": "skills/common/spawn-model-agent/SKILL.md:34",
      "severity": "Low",
      "summary": "作业目录总述遗漏实际存在的随机后缀。",
      "fix": "将目录格式同步为 <时间>-<后端>-<随机后缀>/。"
    }
  ],
  "converged": false
}
```
