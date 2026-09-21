import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "skill_routing_eval", Path(__file__).parents[1] / "bin/skill_routing_eval.py"
)
routing = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(routing)

RANK1_FLOOR = 85.0


class TokenizerTest(unittest.TestCase):
    def test_chinese_descriptions_produce_bigrams(self):
        tokens = routing.tokenize("Use when 代码改动已形成可评审结果，需要基于变更证据做代码评审")
        self.assertIn("代码", tokens)
        self.assertIn("评审", tokens)
        self.assertNotIn("use", tokens)
        self.assertNotIn("when", tokens)

    def test_mixed_text_keeps_ascii_terms(self):
        tokens = routing.tokenize("查一下 hippo 里这个 key 的配置值")
        self.assertIn("hippo", tokens)
        self.assertIn("key", tokens)
        self.assertIn("配置", tokens)

    def test_description_reader_handles_quoted_and_folded_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "SKILL.md"
            p.write_text('---\nname: x\ndescription: "评审已有需求文档。触发：PRD 评审"\nmetadata:\n  version: 1.0.0\n---\n# x\n', encoding="utf-8")
            self.assertEqual("评审已有需求文档。触发：PRD 评审", routing.read_description(p))
            p.write_text("---\nname: x\ndescription: >\n  Use when 第一行\n  第二行\nlicense: MIT\n---\n", encoding="utf-8")
            self.assertEqual("Use when 第一行 第二行", routing.read_description(p))


class RoutingEvalTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.report = routing.run()

    def test_every_dev_workflow_skill_has_a_case_file(self):
        missing = [e for e in self.report["errors"] if "missing evals/cases" in e]
        self.assertEqual([], missing)

    def test_no_routing_errors(self):
        self.assertEqual([], self.report["errors"], "\n".join(self.report["errors"]))

    def test_no_description_collisions(self):
        hard = [w for w in self.report["warnings"] if "similarity" in w]
        self.assertEqual([], hard, "\n".join(hard))

    def test_rank1_rate_meets_floor(self):
        self.assertGreaterEqual(
            self.report["rank1_rate"], RANK1_FLOOR,
            f"rank-1 {self.report['rank1_rate']:.0f}% < {RANK1_FLOOR:.0f}%; fix the description, not the prompt",
        )

    def test_case_files_are_well_formed(self):
        for path in sorted(routing.CASES_DIR.glob("*.json")):
            case = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(path.stem, case["skill_name"], path.name)
            for item in case["trigger"]["positive"]:
                self.assertTrue(item.get("prompt"), path.name)
            for item in case["trigger"]["negative"]:
                self.assertTrue(item.get("prompt"), path.name)
                self.assertTrue(item.get("owner"), f"{path.name}: negative prompts must name an owner")
            for ev in case.get("evals", []):
                self.assertIn(ev.get("kind", "dialogue"), ("dialogue", "execution"), path.name)
                self.assertTrue(ev.get("prompt") and ev.get("expectations"), path.name)


if __name__ == "__main__":
    unittest.main()
