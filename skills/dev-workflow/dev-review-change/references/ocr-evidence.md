# 用 `ocr` 生成代码评审候选线索与逐文件覆盖基线

`ocr`（alibaba/open-code-review）是确定性文件筛选加规则匹配再交给模型的评审 CLI。本流程只把它当作两类输入：候选线索（findings 的来源之一）和可评审文件清单（覆盖基线）。它没有 `R/S/C/B`、`TC-*`、`DEV-*` 和 producer 身份概念，不能替代独立 reviewer，也不构成审批事实。

## 前提

- 本机已装：`npm i -g @alibaba-group/open-code-review`（当前 v1.12.7）。
- Git 需 2.41 以上。2.34 只会告警，但 `code_search` 工具依赖 `git grep --max-count`，旧版本下该工具每次失败，评审深度明显下降；升级命令见文末。
- 模型走乐信网关：provider `lexin`，配置在 `~/.opencodereview/config.json`，密钥通过 `api_key_cmd` 从 `~/.config/ai-providers/claude/_lexin.env` 运行时读取，不落盘。`ocr llm test` 通过即可用。
- 评审语言已设为中文（`ocr config set language 中文`）。
- 遥测默认关闭；会话记录在 `~/.opencodereview/sessions/`，不写入仓库。
- 不安装 ocr 的 Claude Code/Kimi 插件命令：它们会自主修复代码，违反 reviewer 只读契约。

## 建议审查（普通 PR / diff）

```bash
# 范围：--from <base> --to <head>，或 -c <commit>；不带范围时评审工作区（含未跟踪文件）
# 背景：-B <背景文件.md>（R 摘要 + AC 列表，清洗后 8000 字符内），或 -b "一句话背景"
ocr review --format json --audience agent \
  --from <base> --to <head> \
  -B <背景文件.md> \
  --rule /home/joney/projects/ai/agent-tools/skills/dev-workflow/dev-review-change/references/ocr-rules.json \
  --output <目录>/ocr.json
```

- `--output` 必须用，不要用 `head`/`tail` 截 stdout。
- 建议审查默认 `--effort low`；正式准入、或范围内有 `TC-*` 要核对测试代码时用 `--effort medium`。2026-09-21 试点（7 文件 Java 变更）：medium 30 分钟、非缓存输入加输出约 25 万 token、4 条线索；low 13 分钟、约 12 万 token、2 条线索，保住了生产代码的 medium 级问题，丢掉了测试断言质量类问题和同根因的次要项。`--timeout 15` 是每轮分钟数，medium 两轮。
- ocr 的 severity 偏高（SNAPSHOT 版本给 high、null message 给 medium），一律按本地口径重判，不沿用它的等级。
- 读取 `comments[]`：`path`、`start_line`/`end_line`（都为 0 表示定位失败，要自己回文件定位）、`severity`（critical/high/medium/low）、`category`、`content`、`suggestion_code`、`existing_code`。`summary` 有文件数与失败文件；`session_id` 供复审对比。
- 每条 comment 都按 `severity-and-complexity.md` 的写入前自检重新判级，映射到 High/Medium/Low；ocr 的 `critical` 与 `high` 只是 High 候选。它不核对旧实现与验收标准：试点里"`e.getMessage()` 可能为 null"在 AC 要求与旧实现一致时并不成立，这类要先查原实现再定。`low` 不默认丢弃，试点中 low 级的自证式断言问题恰是既有评审的盲区。ocr 无发现不等于无问题：它有意偏向精确率，默认排除测试文件和 `.md`、`.properties` 以外的非代码文件。

## 正式准入

编排器在冻结 `change_revision` 之后、派发 `agent-tools-change-reviewer` 之前执行：

1. `ocr delegate preview --format json [--from/--to | -c] > rounds/round-<N>/ocr-files.json`（preview 没有 `--output`，只能重定向 stdout）：不调模型，输出 `reviewable_files[]`（path/status/insertions/deletions）与 `excluded_files[]`（含 `exclude_reason`）。清单写进信封 `inputs`，reviewer 必须对每个 reviewable 文件标记已评审或跳过原因；`excluded_files` 中 `default_path`（测试文件）和 `unsupported_ext` 的项由 reviewer 按 `TC-*`/`DEV-*` 映射自行决定是否读，不因 ocr 排除而免检。
2. `ocr review --format json --audience agent --provider lexin --model <M> ... --output rounds/round-<N>/ocr.json`，`<M>` 不得与 `change_revision` 任一 producer 的实际模型相同（对照 `pick_agent.py --task <id> --show-record`）。计算 `ocr.json` 指纹，连同 provider/model 写进信封 `input_fingerprints` 与运行记录。
3. reviewer 只把 `ocr.json` 当候选线索：每条线索先过写入前自检与 High 反驳，绑定 DEV 或代码位置后才成为 finding；不得引用 ocr 结论作为证据本身。报告第 1 节填“外部评审证据”，第 4 节填逐文件覆盖表。
4. 定点复审时对上一轮与本轮会话跑 `ocr session compare <before> <after>`，输出新增、持续、已解决、未评审四类，作为“上轮已关闭项非回归”的辅助证据；`session_id` 在各轮 `ocr.json` 里。

ocr 本身不写工作区，但它由编排器运行，不在 reviewer 的只读沙箱里执行；reviewer 信封中只放结果文件与指纹。

## 规则文件

`ocr-rules.json` 与本文件同目录：把 `src/test/java` 纳入评审并只查断言质量；Java 源码在系统规则之上追加幂等、事务内远程调用、异常吞噬、外部调用超时、配置回退五项。需要仓库特定规则时用 `--rule` 指向副本，不往团队仓库提交 `.opencodereview/`。`ocr rules check --rule <file> <path>` 可查看某文件最终命中的规则。

## 升级 Git

```bash
sudo add-apt-repository -y ppa:git-core/ppa && sudo apt-get update && sudo apt-get install -y git
git --version   # 期望 >= 2.41
```
