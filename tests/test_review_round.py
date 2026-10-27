from __future__ import annotations

import contextlib
import io
import json
import subprocess
import tempfile
import unittest
import unittest.mock
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
        self.ledger_patch = unittest.mock.patch.object(rr, "LEDGER", root / "ledger.jsonl")
        self.ledger_patch.start()
        self.addCleanup(self.ledger_patch.stop)
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

    def spawn_job(self, name, env, conclusion, tools=("Read", "Grep", "Glob"), backend=None):
        job = Path(self.tmp.name) / name
        job.mkdir()
        name = backend or name
        res = {"schema": "delegation-result-v1", "task_id": env["task_id"], "role": env["role"], "status": "complete",
               "input_fingerprints": env["input_fingerprints"], "conclusion": conclusion, "changed_files": [], "unresolved": []}
        (job / "result.md").write_text("# 评审\n\n```json\n" + json.dumps(res, ensure_ascii=False) + "\n```")
        (job / "meta.json").write_text(json.dumps({"backend": name, "session_id": job.name + "-sid", "model": name + "-model",
                                                   "readonly": True, "exit_code": 0, "effective_tools": list(tools),
                                                   "mcp_servers": [], "tools_used": ["Read"]}))
        return job

    def test_external_and_dual_review(self):
        self.freeze()
        run(*self.base, "envelope", "--task-id", "t1", "--scope", "full review")
        run(*self.base, "task")
        task = (self.rd / "evidence/external-task-primary.md").read_text()
        self.assertIn("dev-review-solution/SKILL.md", task)
        self.assertIn(str(self.rd / "delegation-envelope.json"), task)
        env = json.loads((self.rd / "delegation-envelope.json").read_text())
        run(*self.base, "snapshot", "before")
        run(*self.base, "persist", "--slot", "secondary", "--spawn-job", str(self.spawn_job("claude-deepseek", env, "修改后复审")))
        run(*self.base, "snapshot", "after")
        findings = Path(self.tmp.name) / "f.json"
        findings.write_text(json.dumps([
            {"id": "F-1", "severity": "Medium", "status": "Open", "classification": "成立需修", "found_by": ["secondary"]},
            {"id": "F-2", "severity": "Low", "status": "Open", "classification": "噪音", "evidence": "x.md:1", "found_by": ["primary", "secondary"]}]))
        run(*self.base, "persist", "--spawn-job", str(self.spawn_job("claude-qwen", env, "通过")), "--findings", str(findings))
        rows = [json.loads(l) for l in rr.LEDGER.read_text().splitlines()]
        self.assertEqual([(r["slot"], r["backend"]) for r in rows], [("primary", "claude-qwen"), ("secondary", "claude-deepseek")])
        self.assertEqual(rows[0]["finding_counts"], {"噪音/Low": 1})
        self.assertEqual(rows[1]["finding_counts"], {"成立需修/Medium": 1, "噪音/Low": 1})
        run(*self.base, "ledger")  # backfill is idempotent
        self.assertEqual(len(rr.LEDGER.read_text().splitlines()), 2)
        rec = json.loads((self.rd / "approval-record.json").read_text())
        self.assertEqual(rec["reviewer_agent_ref"], "spawn:claude-qwen:claude-qwen-sid")
        self.assertEqual(rec["reviewer"], {"kind": "spawn-model-agent", "model": "claude-qwen-model", "selected_by": "user"})
        self.assertEqual(rec["conclusion"], "修改后复审")  # stricter of the two
        self.assertFalse(rec["can_enter_next_stage"])
        self.assertEqual(rec["secondary_reviewer"]["model"], "claude-deepseek-model")

    def test_external_reviewer_with_write_tools_is_invalid(self):
        self.freeze()
        run(*self.base, "envelope", "--task-id", "t1", "--scope", "full review")
        env = json.loads((self.rd / "delegation-envelope.json").read_text())
        run(*self.base, "snapshot", "before")
        run(*self.base, "snapshot", "after")
        findings = Path(self.tmp.name) / "f.json"
        findings.write_text("[]")
        with self.assertRaises(SystemExit):
            run(*self.base, "persist", "--findings", str(findings),
                "--spawn-job", str(self.spawn_job("claude-qwen", env, "通过", tools=("Read", "WebFetch"))))
        rec = json.loads((self.rd / "approval-record.json").read_text())
        self.assertIsNone(rec["conclusion"])
        self.assertFalse(rec["checks"]["tool_surface"]["passed"])

    def test_persist_rejects_unclassified_or_unevidenced_findings(self):
        self.freeze()
        run(*self.base, "envelope", "--task-id", "t1", "--scope", "full review")
        env = json.loads((self.rd / "delegation-envelope.json").read_text())
        run(*self.base, "snapshot", "before")
        run(*self.base, "snapshot", "after")
        findings = Path(self.tmp.name) / "f.json"
        for bad in ([{"id": "F-1", "severity": "Low", "status": "Open"}],
                    [{"id": "F-1", "severity": "Low", "status": "Open", "classification": "噪音"}]):
            findings.write_text(json.dumps(bad))
            with self.assertRaises(SystemExit):
                run(*self.base, "persist", "--findings", str(findings), "--spawn-job", str(self.spawn_job(f"claude-qwen{len(bad[0])}", env, "通过")))
        self.assertFalse((self.rd / "approval-record.json").exists())

    def review_round(self, base, task_id, findings, job, disturb=None, prior=None):
        """One external-reviewer round on R; returns (exit raised, stdout)."""
        run(*base, "freeze", "--artifact", "R=requirements:summary.md")
        extra = ["--prior-round", str(prior)] if prior else []
        run(*base, "envelope", "--task-id", task_id, "--role", "agent-tools-requirements-reviewer", "--scope", "full", *extra)
        rd = self.req / "requirements-review/rounds" / f"round-{base[-1]}"
        env = json.loads((rd / "delegation-envelope.json").read_text())
        run(*base, "snapshot", "before")
        if disturb:
            disturb()
        run(*base, "snapshot", "after")
        path = Path(self.tmp.name) / f"{task_id}-findings.json"
        path.write_text(json.dumps(findings, ensure_ascii=False))
        out, failed = io.StringIO(), False
        with contextlib.redirect_stdout(out):
            try:
                rr.main([*base, "persist", "--findings", str(path),
                         "--spawn-job", str(self.spawn_job(job, env, "通过", backend="claude-qwen"))])
            except SystemExit:
                failed = True
        return failed, out.getvalue(), env

    def test_ledger_scores_only_new_findings_and_separates_environment_voids(self):
        base1 = ["--req-dir", str(self.req), "--stage", "requirements-review", "--round", "1"]
        f1 = {"id": "RR-001", "severity": "Medium", "status": "Open", "classification": "成立需修"}
        failed, out, _ = self.review_round(base1, "t1", [f1], "job1")
        self.assertFalse(failed)
        self.assertIn("## 评审打分", out)
        card = self.req / "requirements-review/rounds/round-1/scorecard.md"
        self.assertTrue(out.rstrip().endswith(card.read_text().rstrip()))  # the printed scorecard is kept in the round
        base2 = ["--req-dir", str(self.req), "--stage", "requirements-review", "--round", "2"]
        f2 = {"id": "RR-002", "severity": "Low", "status": "Open", "classification": "噪音", "evidence": "summary.md:3"}
        other_writer = lambda: (self.req / "requirements/notes.md").write_text("另一会话写入\n")
        failed, out, _ = self.review_round(base2, "t2", [dict(f1, status="Resolved"), f2], "job2", disturb=other_writer)
        self.assertTrue(failed)  # still no approval fact
        rows = [json.loads(l) for l in rr.LEDGER.read_text().splitlines()]
        self.assertEqual([r["invalid_cause"] for r in rows], [None, "environment"])
        self.assertEqual(rows[1]["finding_counts"], {"噪音/Low": 1})
        self.assertEqual(rows[1]["carried_findings"], 1)
        self.assertIn("作废（环境原因", out)
        self.assertIn("RR-002 噪音（summary.md:3）", out)
        self.assertIn("累计实战 claude-qwen（claude-qwen-model）：n=2 成立 1/2 噪音 1", out)
        self.assertIn("环境作废 1", out)

    def test_requirements_review_targeted_rereview_diffs_archived_version(self):
        base1 = ["--req-dir", str(self.req), "--stage", "requirements-review", "--round", "1"]
        self.review_round(base1, "t1", [], "job1")
        rd1 = self.req / "requirements-review/rounds/round-1"
        (rd1 / "resolution.md").write_text("处置\n")
        archive = self.req / "requirements/versions/v0.3"
        archive.mkdir(parents=True)
        (archive / "summary.md").write_text((self.req / "requirements/summary.md").read_text())
        (self.req / "requirements/summary.md").write_text("状态：已对齐 · 版本：v0.4\n\nAC-001 新行为\n")
        base2 = ["--req-dir", str(self.req), "--stage", "requirements-review", "--round", "2"]
        _, _, env = self.review_round(base2, "t2", [], "job2", prior=1)
        self.assertEqual(env["inputs"]["review_mode"], "targeted")
        self.assertEqual(env["inputs"]["prior_R"]["version"], "v0.3")
        self.assertIn("+AC-001 新行为", Path(env["inputs"]["diff"]).read_text())

    def test_test_case_closure_and_table_version(self):
        (self.req / "test-cases").mkdir()
        (self.req / "test-cases/test-cases.md").write_text(
            "# 清单\n\n| 项目 | 内容 |\n|---|---|\n| 清单版本 | v2 |\n\n## 3. 追踪\n\n| AC | CHG | TC |\n|---|---|---|\n"
            "| AC-001 | CHG-001 / 3.1 | TC-001～TC-002 |\n\n| 集合 | 分母 |\n|---|---|\n| TC | 3（TC-001～TC-003） |\n\n## 4. 检查项\n\n| ID | 来源 | CHG |\n|---|---|---|\n"
            "| TC-001 | AC-001 | CHG-001 |\n| TC-002 | AC-001 | CHG-009 |\n| TC-003 | 无 | CHG-001 |\n")
        base = ["--req-dir", str(self.req), "--stage", "test-cases-review", "--round", "1"]
        with contextlib.redirect_stderr(io.StringIO()):
            run(*base, "freeze", "--artifact", "C=test-cases:test-cases.md", "--repo", str(self.repo))
        rd = self.req / "test-cases-review/rounds/round-1"
        self.assertEqual(json.loads((rd / "evidence/frozen-inputs.json").read_text())["inputs"]["C"]["version"], "v2")
        checks = json.loads((rd / "mechanical-checks.json").read_text())
        self.assertEqual(checks["TC_count"], 3)
        self.assertEqual(checks["CHG_unmapped"], ["CHG-002"])
        self.assertEqual(checks["TC_without_AC"], ["TC-003"])
        self.assertEqual(checks["TC_refs_outside_denominator"], ["CHG-009"])
        self.assertEqual(checks["TC_defined_not_in_trace_table"], ["TC-003"])
        self.assertEqual(checks["TC_CHG_mismatch_trace_vs_item"], {"TC-002": {"trace_table": ["CHG-001"], "item": ["CHG-009"]}})


if __name__ == "__main__":
    unittest.main()
