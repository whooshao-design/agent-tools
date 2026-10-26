from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

REPO = Path(__file__).parents[1]
SCRIPT = REPO / "skills/dev-workflow/dev-design-solution/scripts/doc_metrics.py"
SPEC = importlib.util.spec_from_file_location("doc_metrics", SCRIPT)
doc_metrics = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(doc_metrics)

HEAD = "# 方案\n\n相关文档：\n\n- 需求：/x\n\n## 摘要\n\n短摘要。\n\n"


def flags(text: str) -> list[str]:
    metrics, _, _ = doc_metrics.analyze(text)
    return doc_metrics.flags_for(metrics)


class DocMetricsTest(unittest.TestCase):
    def test_long_paragraph_is_flagged(self):
        text = HEAD + "## 1. 背景\n\n" + "这是一个很长的段落。" * 30 + "\n"
        self.assertTrue(any("段超过" in f for f in flags(text)))

    def test_dense_code_names_in_prose_are_flagged(self):
        line = "调用 `A.b` 后由 `C.d` 写入 `e.f`，再交给 `G`。\n\n"
        text = HEAD + "## 1. 背景\n\n" + line * 10
        self.assertTrue(any("正文行内代码" in f for f in flags(text)))

    def test_glossary_table_is_detected(self):
        rows = "".join(f"| 名称{i} | `Code{i}` |\n" for i in range(35))
        text = HEAD + "## 1.3 术语\n\n| 中文名 | 代码中的名称 |\n|---|---|\n" + rows
        metrics, _, _ = doc_metrics.analyze(text)
        self.assertTrue(metrics["has_glossary"])
        self.assertFalse(any("术语对照表" in f for f in doc_metrics.flags_for(metrics)))

    def test_many_code_names_without_glossary_are_flagged(self):
        rows = "".join(f"| 名称{i} | `Code{i}` |\n" for i in range(35))
        text = HEAD + "## 1. 背景\n\n| 对象 | 说明 |\n|---|---|\n" + rows
        self.assertTrue(any("术语对照表" in f for f in flags(text)))

    def test_table_heavy_document_is_not_flagged(self):
        rows = "".join(f"| 阶段{i} | 条件 | 信号 | 回滚 |\n" for i in range(20))
        text = HEAD + "## 6. 发布\n\n| 阶段 | 进入条件 | 通过信号 | 回滚 |\n|---|---|---|---|\n" + rows
        self.assertFalse(any("表格行数多于" in f for f in flags(text)))

    def test_missing_change_overview_and_marks_are_flagged(self):
        text = HEAD + "## 2.1 主图\n\n```mermaid\nflowchart LR\n  A --> B\n```\n"
        fl = flags(text)
        self.assertTrue(any("变更总览" in f for f in fl))
        self.assertTrue(any("新增/修改/现有" in f for f in fl))

    def test_change_overview_and_marked_diagrams_are_detected(self):
        text = (HEAD + "## 2.1 主图\n\n```mermaid\nflowchart LR\n  A --> B\n"
                "  classDef new fill:#d9f2d9\n  class B new\n```\n\n"
                "```mermaid\nsequenceDiagram\n  A->>B: 【修改】提交\n```\n\n"
                "## 2.4 变更总览\n\n| 应用或端 | 对象 | 变更 | 改动内容 | 详见 |\n|---|---|---|---|---|\n| manage | 复制接口 | 修改 | 加入参 | 3.4 |\n")
        metrics, _, _ = doc_metrics.analyze(text)
        self.assertTrue(metrics["has_change_table"])
        self.assertEqual(metrics["marked_diagrams"], 2)
        fl = doc_metrics.flags_for(metrics)
        self.assertFalse(any("变更总览" in f or "新增/修改/现有" in f for f in fl))

    def test_missing_change_overview_and_marks_are_flagged(self):
        text = HEAD + "## 2.1 主图\n\n```mermaid\nflowchart LR\n  A --> B\n```\n"
        fl = flags(text)
        self.assertTrue(any("变更总览" in f for f in fl))
        self.assertTrue(any("新增/修改/现有" in f for f in fl))

    def test_change_overview_and_marked_diagrams_are_detected(self):
        text = (HEAD + "## 2.1 主图\n\n```mermaid\nflowchart LR\n  A --> B\n"
                "  classDef new fill:#d9f2d9\n  class B new\n```\n\n"
                "```mermaid\nsequenceDiagram\n  A->>B: 【修改】提交\n```\n\n"
                "## 2.4 变更总览\n\n| 应用或端 | 对象 | 变更 | 改动内容 | 详见 |\n|---|---|---|---|---|\n| manage | 复制接口 | 修改 | 加入参 | 3.4 |\n")
        metrics, _, _ = doc_metrics.analyze(text)
        self.assertTrue(metrics["has_change_table"])
        self.assertEqual(metrics["marked_diagrams"], 2)
        fl = doc_metrics.flags_for(metrics)
        self.assertFalse(any("变更总览" in f or "新增/修改/现有" in f for f in fl))


if __name__ == "__main__":
    unittest.main()
