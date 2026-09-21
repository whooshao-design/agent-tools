from __future__ import annotations

import argparse
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "skills/common/build-codeagent/scripts/pick_agent.py"
SPEC = importlib.util.spec_from_file_location("pick_agent", SCRIPT)
assert SPEC and SPEC.loader
picker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(picker)


class PickAgentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.routing = copy.deepcopy(picker.load_routing())
        # 不依赖机器上随时可变的默认模型；配置解析在独立测试中验证。
        for backend, spec in self.routing["backends"].items():
            spec["model"] = "model-" + backend
        for target, value in (("STATE", self.root / "state"), ("load_routing", lambda: self.routing)):
            mock = patch.object(picker, target, value)
            mock.start()
            self.addCleanup(mock.stop)
        random = patch.object(picker.random, "choice", lambda pool: pool[0])
        random.start()
        self.addCleanup(random.stop)

    def call(self, stage="solution-review", **kwargs):
        args = argparse.Namespace(stage=stage, task="demo", exclude=None,
                                  replace_producer=None, actual_model=None,
                                  record=None, material=None, json=True)
        for key, value in kwargs.items():
            setattr(args, key, value)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = picker.pick(args)
        self.assertEqual(code, 0)
        return json.loads(output.getvalue())

    def record(self, backend, stage="solution-review", **kwargs):
        return self.call(stage, record=backend, **kwargs)

    def test_preview_does_not_create_state_or_consume_rounds(self):
        for _ in range(3):
            result = self.call()
            self.assertEqual(result["round"], 1)
            self.assertEqual(result["event"], "preview")
        self.assertFalse(picker.STATE.exists())

    def test_preview_after_participation_leaves_history_unchanged(self):
        self.record("claude-vps")
        before = picker.record_path("demo").read_bytes()
        self.assertEqual(self.call()["backend"], "claude-qwen")
        self.assertEqual(picker.record_path("demo").read_bytes(), before)

    def test_record_uses_actual_backend_and_runtime_model(self):
        row = self.record("codex-vps", actual_model="runtime-version")
        self.assertEqual(row["backend"], "codex-vps")
        self.assertEqual(row["model"], "runtime-version")
        self.assertEqual(row["model_basis"], "runtime")
        self.assertEqual(row["event"], "participation")
        self.assertIsNone(row["command"])
        self.assertEqual(picker.read_record("demo")[0]["model"], "runtime-version")

    def test_existing_producer_outside_stage_candidates_is_preserved(self):
        self.record("claude-qwen", "solution-design")
        self.assertIn("claude-qwen", self.call()["excluded"])
        self.assertIn("claude-qwen", self.call()["excluded"])

    def test_legacy_history_stays_excluded_and_is_not_rewritten(self):
        row = self.record("claude-vps", "solution-design")
        for key in ("event", "model_basis", "command", "notes", "record"):
            row.pop(key, None)
        raw = json.dumps(row).encode()
        path = picker.record_path("demo")
        path.write_bytes(raw)
        self.assertIn("claude-vps", self.call()["excluded"])
        self.assertEqual(path.read_bytes(), raw)
        self.record("claude-qwen")
        self.assertEqual(len(picker.read_record("demo")), 2)

    def test_corrupt_history_stops_without_discarding_producers(self):
        self.record("claude-vps", "solution-design")
        path = picker.record_path("demo")
        raw = path.read_bytes() + b'{broken\n'
        path.write_bytes(raw)
        for kwargs in ({}, {"record": "codex-vps"}):
            with self.assertRaisesRegex(ValueError, "第 2 行.*不能跳过或清空"):
                self.call(**kwargs)
        self.assertEqual(path.read_bytes(), raw)

    def test_invalid_record_shape_and_foreign_task_stop(self):
        original = self.record("claude-vps")
        path = picker.record_path("demo")
        for change in ({"task": "foreign"}, {"round": True}, {"round": 0},
                       {"stage": None}, {"model": []}, {"role": "unknown"}):
            with self.subTest(change=change):
                path.write_text(json.dumps({**original, **change}) + "\n")
                with self.assertRaisesRegex(ValueError, "第 1 行"):
                    self.call()

    def test_review_rotation_uses_latest_use_after_pool_exhaustion(self):
        self.record("claude-vps", "solution-design")
        choices, reused = [], []
        for _ in range(6):
            preview = self.call()
            choices.append(preview["backend"])
            reused.append(preview["reuse_of_round"])
            self.record(preview["backend"])
        self.assertEqual(choices, ["claude-qwen", "codex-vps", "codex-qwen"] * 2)
        self.assertEqual(reused, [None, None, None, 1, 2, 3])

    def test_host_collapses_same_model_channels_but_keeps_rotation_between_models(self):
        # claude-qwen / codex-qwen carry the same model: only the host's channel stays in the pool
        self.routing["backends"]["codex-qwen"]["model"] = self.routing["backends"]["claude-qwen"]["model"]
        self.record("claude-vps", "solution-design")
        self.assertEqual(self.call(host="codex")["backend"], "codex-vps")
        self.assertEqual(self.call(host="claude")["backend"], "claude-qwen")
        # requirement-clarify only lists claude-*: a codex host still gets a candidate instead of nothing
        self.assertTrue(self.call("requirement-clarify", host="codex")["backend"].startswith("claude-"))
        # claude-vps and codex-vps are different models: a codex host must still rotate between them
        self.record("claude-deepseek", "requirement-clarify")
        first = self.call("requirement-review", host="codex")["backend"]
        self.record(first, "requirement-review")
        second = self.call("requirement-review", host="codex")["backend"]
        self.assertNotEqual(first, second)
        self.assertEqual({first, second}, {"claude-vps", "codex-vps"})
        self.assertIn(picker.detect_host(), ("claude", "codex", "any"))

    def test_unknown_models_are_never_collapsed_as_if_identical(self):
        # both dynamic configs unreadable: the same placeholder string must not make the two backends "one model"
        for backend in ("claude-vps", "codex-vps"):
            self.routing["backends"][backend].pop("model", None)
            self.routing["backends"][backend]["model_source"] = "dynamic:/nonexistent/config.json#model"
        self.record("claude-deepseek", "requirement-clarify")
        first = self.call("requirement-review", host="codex")["backend"]
        self.record(first, "requirement-review")
        second = self.call("requirement-review", host="codex")["backend"]
        self.assertEqual({first, second}, {"claude-vps", "codex-vps"})

    def test_explicit_exclude_is_temporary_and_does_not_record_producer(self):
        self.assertEqual(self.call(exclude=" claude-vps ")["backend"], "claude-qwen")
        self.assertEqual(self.call()["backend"], "claude-vps")
        self.assertEqual(picker.read_record("demo"), [])

    def test_all_historical_producers_remain_excluded(self):
        self.record("claude-vps", "solution-design")
        self.record("codex-vps", "solution-design", replace_producer="原后端不可用")
        result = self.call()
        self.assertEqual(result["backend"], "claude-qwen")
        self.assertTrue({"claude-vps", "codex-vps"} <= set(result["excluded"]))

    def test_revision_reuses_current_producer(self):
        self.record("codex-vps", "solution-design")
        self.assertEqual(self.call("solution-design")["backend"], "codex-vps")

    def test_revision_respects_exclusion_and_current_candidates(self):
        self.record("claude-vps", "solution-design")
        with self.assertRaisesRegex(ValueError, "确认换人条件"):
            self.call("solution-design", exclude="claude-vps")
        self.routing["stages"]["solution-design"]["candidates"] = ["codex-vps"]
        with self.assertRaisesRegex(ValueError, "确认换人条件"):
            self.call("solution-design")

    def test_explicit_replacement_becomes_revision_owner(self):
        self.record("claude-vps", "solution-design")
        reason = "连续两轮未关闭关键问题"
        result = self.call("solution-design", replace_producer=reason)
        self.assertEqual(result["backend"], "codex-vps")
        self.record(result["backend"], "solution-design", replace_producer=reason)
        self.assertEqual(self.call("solution-design")["backend"], "codex-vps")
        self.assertEqual(picker.read_record("demo")[-1]["replacement_reason"], reason)

    def test_no_valid_replacement_or_reviewer_stops(self):
        self.record("claude-vps", "solution-design")
        with self.assertRaisesRegex(ValueError, "无可接替"):
            self.call("solution-design", exclude="codex-vps", replace_producer="不可用")
        self.record("codex-vps", "solution-design")
        self.record("claude-qwen", "solution-design")
        self.record("codex-qwen", "solution-design")
        with self.assertRaisesRegex(ValueError, "无可用后端"):
            self.call()

    def test_execute_can_use_code_producer_but_review_cannot(self):
        self.record("claude-qwen", "code-build")
        result = self.call("verify-execute", exclude="claude-deepseek,claude-glm")
        self.assertEqual(result["backend"], "claude-qwen")
        self.assertIn("claude-qwen", self.call("code-review")["excluded"])

    def test_task_and_artifact_histories_are_isolated(self):
        self.record("claude-vps", "solution-design")
        self.assertEqual(self.call(task="another")["backend"], "claude-vps")
        self.assertEqual(self.call("requirement-review")["backend"], "claude-vps")

    def test_invalid_task_does_not_collide_and_unicode_is_preserved(self):
        for task in ("a/b", "a?b", "", ".", "..", "../x", "a b"):
            with self.subTest(task=task), self.assertRaises(ValueError):
                self.call(task=task)
        self.assertFalse(picker.STATE.exists())
        self.record("claude-vps", task="中文任务-1")
        self.assertEqual(picker.record_path("中文任务-1").name, "中文任务-1.jsonl")
        self.assertEqual(picker.record_path("a_b").name, "a_b.jsonl")

    def test_known_same_model_is_excluded_across_backend_names(self):
        self.record("claude-vps", "solution-design", actual_model="shared-model")
        self.routing["backends"]["claude-qwen"]["model"] = "shared-model"
        self.assertEqual(self.call()["backend"], "codex-vps")

    def test_toml_model_key_is_exact_and_json_model_is_supported(self):
        toml = self.root / "config.toml"
        toml.write_text('model_provider = "provider-name"\nmodel = "real-model"\n')
        self.assertEqual(picker.resolve_model("codex-vps", {
            "model_source": f"dynamic:{toml}#model"}), "real-model")
        js = self.root / "settings.json"
        js.write_text('{"model": "configured-model"}')
        self.assertEqual(picker.resolve_model("claude-vps", {
            "model_source": f"dynamic:{js}#model"}), "configured-model")

    def test_bad_config_is_reported_without_leaking_contents(self):
        config = self.root / "bad.toml"
        config.write_text('SECRET = [malformed')
        result = picker.resolve_model("codex-vps", {"model_source": f"dynamic:{config}#model"})
        self.assertIn("解析失败", result)
        self.assertNotIn("SECRET", result)

    def test_model_basis_and_tested_model_mismatch_note(self):
        result = self.call()
        self.assertEqual(result["model_basis"], "configured")
        self.assertFalse(any("older-model" in note for note in result["notes"]))
        self.routing["backends"]["claude-vps"]["review_test_model"] = "older-model"
        self.assertTrue(any("older-model" in note for note in self.call()["notes"]))

    def test_recording_review_by_producer_is_refused(self):
        self.record("claude-vps", "solution-design")
        with self.assertRaisesRegex(ValueError, "生成者，不能登记为评审者"):
            self.record("claude-vps")
        self.assertEqual(len(picker.read_record("demo")), 1)

    def test_review_preview_flags_missing_producer_record(self):
        self.assertTrue(any("没有生成者记录" in n for n in self.call()["notes"]))
        self.record("claude-vps", "solution-design")
        self.assertFalse(any("没有生成者记录" in n for n in self.call()["notes"]))

    def test_material_is_one_literal_shell_argument_and_tools_are_limited(self):
        material = "/tmp/material's dir; $(touch sentinel) `echo x`"
        result = self.call(material=material)
        tokens = shlex.split(result["command"])
        self.assertEqual(tokens[:4], ["cd", "--", material, "&&"])
        self.assertEqual(tokens[tokens.index("--tools") + 1], "Read,Grep,Glob")
        self.assertIn("--strict-mcp-config", tokens)
        self.assertNotIn("--allowedTools", tokens)
        self.assertFalse((self.root / "sentinel").exists())

    def test_invocation_comes_from_routing_and_codex_uses_wrapper(self):
        self.routing["invocation"]["claude_review"] = "review {backend} at {material}"
        self.assertEqual(self.call(material="some path")["command"], "review claude-vps at 'some path'")
        result = self.call(exclude="claude-vps,claude-qwen", material="/tmp/mat")
        self.assertIn("/home/joney/bin/codex-reviewer", result["command"])

    def test_bad_exclusion_backend_and_replacement_reason_are_rejected(self):
        for kwargs in ({"exclude": "unknown"}, {"record": "unknown"},
                       {"replace_producer": "reason"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.call(**kwargs)
        for reason in ("", " "):
            with self.assertRaises(ValueError):
                self.call("solution-design", replace_producer=reason)

    def test_cli_preview_record_show_and_usage_errors(self):
        env = {**os.environ, "AGENT_ROUTING_HOME": str(self.root / "cli-state")}

        def run(*args):
            return subprocess.run([sys.executable, str(SCRIPT), "--task", "cli", *args],
                                  env=env, capture_output=True, text=True)

        result = run("solution-review", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["event"], "preview")
        self.assertFalse((self.root / "cli-state").exists())
        result = run("solution-design", "--record", "claude-vps", "--actual-model", "runtime-id", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        shown = run("--show-record")
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertIn("runtime-id", shown.stdout)
        for args in (("unknown",), ("solution-review", "--actual-model", "x"),
                     ("solution-review", "--record", "claude-vps", "--exclude", "codex-vps")):
            failed = run(*args)
            self.assertEqual(failed.returncode, 2, failed.stderr)
        self.assertEqual(len((self.root / "cli-state/cli.jsonl").read_text().splitlines()), 1)


if __name__ == "__main__":
    unittest.main()
