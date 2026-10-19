from __future__ import annotations

import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import importlib.util

REPO = Path(__file__).parents[1]
SCRIPT = REPO / "skills/dev-workflow/scripts/review_round.py"
SPEC = importlib.util.spec_from_file_location("review_round", SCRIPT)
rr = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rr)

SOLUTION = """# 方案

> 状态：Draft · 版本：v2 · 日期：2026-10-19

## 2. 方案概览

### 2.4 变更总览

| 应用 | 对象 | 变更 | 改动 | 详见 |
|---|---|---|---|---|
| m | a | 新增 | x | 3.1（CHG-001） |

## 3. 详细设计

### 3.1 机制

正文 [E-1]。
"""
TRACE = """# 追踪

## 2. 验收映射

| AC | 行为 | 设计位置 | 交付单元 |
|---|---|---|---|
| AC-001 | x | 3.1 | CHG-001 |

## 3. 交付单元

| CHG | 动作 | 对象 |
|---|---|---|
| CHG-001 | 新增 | a |
| CHG-002 | 保持不变 | b |

## 6. 证据

| E | 内容 |
|---|---|
| E-1 | x |
"""


def run(*argv):
    with contextlib.redirect_stdout(io.StringIO()):
        rr.main(list(argv))


class ReviewRoundTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.repo = root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        (self.repo / "a.txt").write_text("a\n")
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], cwd=self.repo, check=True)
        self.req = root / "req"
        (self.req / "requirements").mkdir(parents=True)
        (self.req / "requirements/summary.md").write_text("状态：已对齐 · 版本：v0.3\n\nAC-001 行为\n")
        (self.req / "solution-design").mkdir()
        (self.req / "solution-design/solution.md").write_text(SOLUTION)
        (self.req / "solution-design/traceability.md").write_text(TRACE)
        self.base = ["--req-dir", str(self.req), "--round", "1"]
        self.rd = self.req / "solution-review/rounds/round-1"

    def tearDown(self):
        self.tmp.cleanup()

    def freeze(self):
        run(*self.base, "freeze", "--artifact", "R=requirements:summary.md",
            "--artifact", "S=solution-design:solution.md,traceability.md", "--repo", str(self.repo))

    def test_freeze_reads_versions_and_runs_mechanical_checks(self):
        self.freeze()
        inputs = json.loads((self.rd / "evidence/frozen-inputs.json").read_text())["inputs"]
        self.assertEqual(inputs["S"]["version"], "v2")
        self.assertEqual(inputs["R"]["version"], "v0.3")
        self.assertEqual(len(inputs["S"]["files"]), 2)
        checks = json.loads((self.rd / "mechanical-checks.json").read_text())
        self.assertTrue(checks["AC_sets_equal"])
        self.assertEqual(checks["CHG_unchanged"], ["CHG-002"])
        self.assertEqual(checks["changed_CHG_missing_from_overview"], [])
        self.assertEqual(checks["section_refs_missing_in_solution"], [])
        self.assertEqual(checks["evidence_cited_but_undefined"], [])

    def test_full_round_produces_valid_approval_record(self):
        self.freeze()
        run(*self.base, "envelope", "--task-id", "t1", "--scope", "full review")
        env = json.loads((self.rd / "delegation-envelope.json").read_text())
        self.assertIn("S/solution.md", env["input_fingerprints"])
        self.assertEqual(env["inputs"]["review_mode"], "full")
        run(*self.base, "snapshot", "before")
        run(*self.base, "snapshot", "after")
        result = {"schema": "delegation-result-v1", "task_id": "t1", "role": env["role"], "status": "complete",
                  "input_fingerprints": env["input_fingerprints"], "conclusion": "通过", "changed_files": [], "unresolved": []}
        report = "# 评审\n\n结论：通过\n\n```json\n" + json.dumps(result, ensure_ascii=False) + "\n```"
        transcript = Path(self.tmp.name) / "t.jsonl"
        transcript.write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in [
            {"message": {"role": "assistant", "content": [{"type": "tool_use", "name": "Read", "input": {}}]}},
            {"message": {"role": "assistant", "content": [{"type": "tool_use", "name": "SubagentHandback", "input": {"report": report}}]}},
        ]))
        findings = Path(self.tmp.name) / "f.json"
        findings.write_text("[]")
        run(*self.base, "persist", "--transcript", str(transcript), "--findings", str(findings), "--reviewer-ref", "agent:1")
        rec = json.loads((self.rd / "approval-record.json").read_text())
        self.assertEqual(rec["conclusion"], "通过")
        self.assertTrue(rec["can_enter_next_stage"])
        self.assertEqual(rec["bound_inputs"]["S"]["version"], "v2")

    def test_persist_rejects_changed_fingerprints_and_writes(self):
        self.freeze()
        run(*self.base, "envelope", "--task-id", "t1", "--scope", "full review")
        run(*self.base, "snapshot", "before")
        (self.req / "solution-design/solution.md").write_text(SOLUTION + "\n改动\n")
        run(*self.base, "snapshot", "after")
        env = json.loads((self.rd / "delegation-envelope.json").read_text())
        result = {"schema": "delegation-result-v1", "task_id": "t1", "role": env["role"], "status": "complete",
                  "input_fingerprints": {"S": "sha256-v1:wrong"}, "conclusion": "通过", "changed_files": [], "unresolved": []}
        report_file = Path(self.tmp.name) / "r.md"
        report_file.write_text("```json\n" + json.dumps(result) + "\n```")
        findings = Path(self.tmp.name) / "f.json"
        findings.write_text("[]")
        with self.assertRaises(SystemExit):
            run(*self.base, "persist", "--report-file", str(report_file), "--tools-used", "Read",
                "--findings", str(findings), "--reviewer-ref", "agent:1")
        rec = json.loads((self.rd / "approval-record.json").read_text())
        self.assertIsNone(rec["conclusion"])
        self.assertFalse(rec["checks"]["write_set_empty"]["passed"])


if __name__ == "__main__":
    unittest.main()
