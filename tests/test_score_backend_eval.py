from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).parents[1] / "skills/common/build-codeagent"
SCRIPT = ROOT / "scripts/score_backend_eval.py"
SPEC = importlib.util.spec_from_file_location("score_backend_eval", SCRIPT)
assert SPEC and SPEC.loader
scorer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scorer)

KEY = json.loads((ROOT / "evals/review-seeded/answer-key.json").read_text(encoding="utf-8"))
DOC = (ROOT / "evals/review-seeded/seeded-solution.md").read_text(encoding="utf-8")
BY_ID = {d["id"]: d for d in KEY["defects"]}

THROWABLE_QUOTE = "失败捕获 `Throwable`，用 `e.getMessage()` 与错误码字符串 `16092306` 构造 `ResultVo`。"


def finding(fid, heading, quote, problem):
    return {"id": fid, "heading": heading, "quote": quote, "problem": problem}


def result(findings, writes=()):
    return {"backend": "claude-x", "json_ok": True, "parsed": {"findings": findings}, "write_attempts": list(writes)}


class GateTest(unittest.TestCase):
    def test_every_anchor_occurs_in_seeded_doc(self):
        for d in KEY["defects"]:
            for a in d.get("anchors", []):
                self.assertIn(a, DOC, d["id"])

    def test_quote_on_throwable_line_gates_both_d3_and_d8(self):
        f = finding("F1", "3.3 解析契约留在当前请求中", THROWABLE_QUOTE, "错误码与 1.1 不一致")
        self.assertTrue(scorer.candidates(f, BY_ID["D3"]))
        self.assertTrue(scorer.candidates(f, BY_ID["D8"]))
        self.assertTrue(scorer.quote_ok(f["quote"], scorer.norm(DOC)))

    def test_section_35_rollback_heading_is_not_a_d4_candidate(self):
        f = finding("F2", "3.5 失败时停止扩量，回滚应用制品", "（本节按 round-2 的 F-03 修订", "修订痕迹不应出现在正文")
        self.assertFalse(scorer.candidates(f, BY_ID["D4"]))
        self.assertTrue(scorer.candidates(f, BY_ID["D6"]))

    def test_legacy_phrase_match_still_overcounts_d8(self):
        r = result([finding("F1", "3.3 解析契约留在当前请求中", THROWABLE_QUOTE, "错误码与 1.1 不一致")])
        self.assertEqual(scorer.phrase_score(r, KEY)["D8"], 1)


class JudgeTest(unittest.TestCase):
    def args(self, results):
        return argparse.Namespace(results=results, judge_cmd="judge", rejudge=False)

    def test_out_of_candidate_verdict_is_rejected_and_cache_is_reused(self):
        r = result([finding("F1", "3.3 解析契约留在当前请求中", THROWABLE_QUOTE, "错误码与 1.1 不一致"),
                    finding("F2", "2.2 关键决策", "使用全局单例解析器", "单例与每次新建矛盾")])
        verdicts = [{"finding": "F1", "defect": "D3", "reason": "错误码"},
                    {"finding": "F2", "defect": "D9", "reason": "越界"}]
        with tempfile.TemporaryDirectory() as d, \
                patch.object(scorer, "run_judge", return_value=(verdicts, "judge-model")) as run:
            first = scorer.judge_run("run1", r, KEY, self.args(d))
            second = scorer.judge_run("run1", r, KEY, self.args(d))
        self.assertEqual(run.call_count, 1)
        self.assertEqual(second["verdicts"], first["verdicts"])
        f2 = next(v for v in first["verdicts"] if v["finding"] == "F2")
        self.assertEqual((f2["defect"], f2["rejected"]), ("none", "D9"))

    def test_findings_without_candidates_skip_the_judge(self):
        r = result([finding("F1", "前言", "不存在的句子", "文风问题")])
        with tempfile.TemporaryDirectory() as d, patch.object(scorer, "run_judge") as run:
            self.assertEqual(scorer.judge_run("run1", r, KEY, self.args(d))["verdicts"], [])
        run.assert_not_called()

    def test_one_defect_per_finding_duplicates_and_linked_defects(self):
        fs = [finding(f"F{i}", "", "", "") for i in range(1, 5)]
        judge = {"verdicts": [{"finding": "F1", "defect": "D1"}, {"finding": "F2", "defect": "D1"},
                              {"finding": "F3", "defect": "None"}, {"finding": "F4", "defect": "D7"}]}
        scored, hit, dups, unmatched = scorer.judge_score(result(fs, writes=["Write"]), KEY, judge)
        self.assertEqual((scored["D1"], scored["D10"], scored["D7"], scored["D8"]), (1, 1, 1, 0))
        self.assertEqual(scored["D11"], 0)
        self.assertEqual(dups, [("F2", "D1")])
        self.assertEqual([f["id"] for f, _ in unmatched], ["F3"])

    def test_kappa(self):
        self.assertEqual(scorer.kappa([(1, 1), (0, 0), (1, 1), (0, 0)]), (1.0, 1.0))
        agree, k = scorer.kappa([(1, 0), (0, 1)])
        self.assertEqual(agree, 0.0)
        self.assertLess(k, 0)


if __name__ == "__main__":
    unittest.main()
