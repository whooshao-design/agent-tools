# review-seeded：评审能力评估材料

方法见 `../../references/backend-evaluation.md`。

- `seeded-solution.md`：注入 11 个缺陷的真实方案，只把这个文件放进模型的材料目录。
- `answer-key.json`：缺陷清单、类别与匹配短语。评估前不要给模型看。
- `prompt.md`：评审提示词，claude-* 与 codex-* 共用。
- `make_seeded.py`：从干净方案生成上面两个文件，换材料时改它并重新生成。
- `results/`：各日期的汇总表与结论；原始输出在 `~/.local/state/agent-routing/evals/<日期>/`。
