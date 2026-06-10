---
name: skill-authoring
description: Use when 需要在 agent-tools 仓库中创建新 skill、修改 skill 分类，或检查现有 skill 是否符合仓库约定（frontmatter、路径、分类、双端安装）。
version: 1.0.0
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
| `skills/env-access/` | 测试环境接口、数据、会话访问 |
| `skills/cicd/` | 构建、质量门禁、发布 |
| `skills/observability/` | 运行时诊断与监控 |

都不合适时再考虑新分类（`skills/` 下建目录即被 install.py 自动发现），但优先复用现有分类。

### 2. 命名

- 目录名 = frontmatter `name`，kebab-case，全英文。
- 名称必须准确反映内容范围，不过窄不过宽（教训见 AGENTS.md 命名约定）。
- 动宾结构优先（如 `debug-systematic`、`fix-sonarqube-issues`）；阶段类用 `dev-` 前缀。

### 3. 写 SKILL.md

frontmatter 三字段缺一不可：

```yaml
---
name: <与目录名一致>
description: Use when <触发场景，让模型能判断何时加载>
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

```bash
cd /home/joney/projects/ai/agent-tools && python3 install.py
```

确认输出中新 skill 在 claude 和 codex 两端均为 `linked`；新会话中确认 skill 出现在可用列表。

### 6. 提交

更新 `README.md` 对应分类表格，然后 git commit + push。

## 修改与下线

- 改既有 skill：直接在仓库改，符号链接即时生效（新会话）。
- 版本号规则：内容实质变化必须升 `version`（修文案 patch、加能力 minor、重写 major）——不升版本号会导致两端无法判断新旧。
- 下线 skill：从仓库删除目录、删两端符号链接、在 README 移除条目；若有替代者，在提交信息中注明由谁承接。
