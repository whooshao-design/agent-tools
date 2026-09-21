---
name: skill-authoring
description: Use when 需要在 agent-tools 仓库中创建新 skill、修改 skill 分类，或检查现有 skill 是否符合仓库约定（frontmatter、路径、分类、双端安装）。
metadata:
  version: 1.2.0
---

# skill-authoring

## 定位

按本仓库（`/home/joney/projects/ai/agent-tools`）约定创建和维护 skill 的元技能。
仓库是 Claude Code 与 Codex 的单一事实源，所有约定以仓库根 `AGENTS.md` 为准。

## 创建新 skill 的流程

### 1. 选分类

| 分类 | 收什么 |
|---|---|
| `skills/common/` | 跨分类复用的底层能力与通用方法论 |
| `skills/dev-workflow/` | 研发阶段主线与编排 |
| `skills/dev-quality/` | 评审/验证维度增强、编码规范 |
| `skills/cicd/` | 通用构建、流水线与质量门禁 |
| `skills/lexin/` | 乐信业务、内网平台、OA/Hawk/乐效/Hippo/Healthy/bianque/内网数据访问 |

都不合适时再考虑新分类（`skills/` 下建目录即被 install.py 自动发现），但优先复用现有分类。

### 2. 命名

- 目录名 = frontmatter `name`，kebab-case，全英文。
- 名称必须准确反映内容范围，不过窄不过宽（教训见 AGENTS.md 命名约定）。
- 动宾结构优先（如 `debug-systematic`、`fix-sonarqube-issues`）；阶段类用 `dev-` 前缀。

### 3. 写 SKILL.md

frontmatter 至少包含 `name` 和 `description`；需要版本追踪时使用 `metadata.version`，不要使用顶层 `version`，以兼容系统自带 `quick_validate.py`：

```yaml
---
name: <与目录名一致>
description: Use when <触发场景，让模型能判断何时加载>
metadata:
  version: 1.0.0
---
```

正文要求：

- 开头一节"定位"说明它治理什么、不治理什么，与相邻 skill 的边界。
- 正文保持精炼（建议 ≤200 行）；长参数表、案例集、模板放 `references/`，脚本放 `scripts/`。
- 引用本仓库脚本一律写仓库绝对路径（`/home/joney/projects/ai/agent-tools/skills/...`），
  不写 `~/.claude/skills` 或 `~/.codex/skills`。
- 与某个 MCP server 能力重叠时，开头注明"MCP 优先、脚本兜底"。
- 不在正文中写入任何凭据、token、真实 IP 清单；此类数据放本地文件并加入 `.gitignore`。

### 4. Codex 附加配置（可选）

需要 Codex 隐式触发时，加 `agents/openai.yaml`：

```yaml
interface:
  display_name: "<skill-name>"
  short_description: "<一句话>"
  default_prompt: "使用 $<skill-name> ..."
policy:
  allow_implicit_invocation: true
```

### 5. 安装与验证

先用系统校验器检查新 skill 的基础 frontmatter：

```bash
python3 /home/joney/.codex/skills/.system/skill-creator/scripts/quick_validate.py <path/to/skill-folder>
```

再安装到双端：

```bash
cd /home/joney/projects/ai/agent-tools && python3 install.py
```

确认输出中新 skill 在 claude 和 codex 两端均为 `linked`；新会话中确认 skill 出现在可用列表。

然后跑仓库测试与评测：

```bash
cd /home/joney/projects/ai/agent-tools && python3 -m unittest discover -s tests
python3 bin/skill_routing_eval.py   # 改了 description 时
```

结构 lint 要求 description 含 "Use when" 且不超过 1024 字符，SKILL.md 内容相对 HEAD 变了就必须升 `metadata.version`；`dev-workflow` 下新增 skill 必须同时加 `evals/cases/<skill>.json`（至少 3 条正向、2 条带 owner 的负向提示），路由评测失败改 description 不改提示。

### 6. 交付

更新 `README.md` 对应分类表格，汇报变更与验证结果。只有用户要求提交或推送时才执行相应 Git 操作；创建或修改 skill 本身不授权推送。

## 修改与下线

- 改既有 skill：直接在仓库改，符号链接即时生效（新会话）。
- 版本号规则：SKILL.md 内容变了就升 `metadata.version`（修文案 patch、加能力 minor、重写 major），`tests/test_skill_lint.py` 会拦住没升版本的改动；不要为了版本号破坏系统校验兼容性。
- 下线 skill：先核对调用方、双端安装与替代能力，再按用户要求停用或移除对应入口，保留可恢复备份；只有明确要求删除源码时才删除仓库目录。同步 README，说明替代者和恢复方法。
