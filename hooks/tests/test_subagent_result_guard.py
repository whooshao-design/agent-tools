from __future__ import annotations

import copy
import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "subagent_result_guard.py"
SPEC = importlib.util.spec_from_file_location("subagent_result_guard", MODULE_PATH)
assert SPEC and SPEC.loader
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class SubagentResultContractTest(unittest.TestCase):
    def valid_result(self, **overrides):
        result = {
            "schema": "delegation-result-v1",
            "task_id": "review-task-1",
            "role": "agent-tools-solution-reviewer",
            "status": "complete",
            "input_fingerprints": {
                "requirements": "sha256-v1:requirements",
                "solution": "sha256-v1:solution",
            },
            "conclusion": "通过",
            "changed_files": [],
            "unresolved": [],
        }
        result.update(overrides)
        return result

    @staticmethod
    def message(result, prefix="评审正文。\n\n"):
        return f"{prefix}```json\n{json.dumps(result, ensure_ascii=False)}\n```"

    def assert_invalid(self, result):
        with self.assertRaises(guard.ContractError):
            guard.parse_result(self.message(result))

    def test_accepts_complete_and_blocked_results_for_all_roles(self):
        roles = {
            "agent-tools-requirements-reviewer": "通过",
            "agent-tools-solution-reviewer": "通过",
            "agent-tools-test-design-reviewer": "通过",
            "agent-tools-change-reviewer": "可继续推进",
        }
        for role, conclusion in roles.items():
            with self.subTest(role=role, status="complete"):
                result = self.valid_result(role=role, conclusion=conclusion)
                self.assertEqual(result, guard.parse_result(self.message(result)))
            with self.subTest(role=role, status="blocked"):
                result = self.valid_result(
                    role=role,
                    status="blocked",
                    conclusion=None,
                    unresolved=["missing-input"],
                )
                self.assertEqual(result, guard.parse_result(self.message(result)))

    def test_blocked_allows_missing_dispatch_envelope(self):
        result = self.valid_result(
            task_id=None,
            status="blocked",
            input_fingerprints={},
            conclusion=None,
            unresolved=["派发信封缺失"],
        )

        self.assertEqual(result, guard.parse_result(self.message(result)))

    def test_rejects_missing_and_unknown_fields(self):
        for field in guard.REQUIRED_FIELDS:
            with self.subTest(missing=field):
                result = self.valid_result()
                result.pop(field)
                self.assert_invalid(result)

        result = self.valid_result(extra="unexpected")
        self.assert_invalid(result)

    def test_rejects_invalid_schema_role_status_and_field_types(self):
        invalid_overrides = (
            {"schema": "delegation-result-v2"},
            {"task_id": ""},
            {"role": "general-purpose"},
            {"role": []},
            {"status": "completed"},
            {"status": "invalid"},
            {"status": []},
            {"input_fingerprints": []},
            {"input_fingerprints": {}},
            {"input_fingerprints": {"requirements": 1}},
            {"conclusion": None},
            {"conclusion": "不存在的结论"},
            {"unresolved": "missing-input"},
            {"unresolved": [1]},
        )
        for overrides in invalid_overrides:
            with self.subTest(overrides=overrides):
                self.assert_invalid(self.valid_result(**overrides))

        self.assert_invalid(
            self.valid_result(status="blocked", conclusion="材料不足")
        )
        self.assert_invalid(
            self.valid_result(status="blocked", conclusion=None, unresolved=[])
        )

    def test_rejects_non_string_conclusion_as_contract_error(self):
        # list/dict used to raise TypeError inside the membership test and fail open
        for bad in ([], {}, ["通过"], {"value": "通过"}, 1):
            self.assert_invalid(self.valid_result(conclusion=bad))

    def test_rejects_conclusion_for_another_role(self):
        self.assert_invalid(
            self.valid_result(
                role="agent-tools-change-reviewer",
                conclusion="通过",
            )
        )

    def test_reviewer_changed_files_must_be_exactly_empty(self):
        for changed_files in (["src/main.py"], None, "src/main.py"):
            with self.subTest(changed_files=changed_files):
                self.assert_invalid(
                    self.valid_result(changed_files=changed_files)
                )

    def test_uses_last_terminal_json_block_after_json_evidence(self):
        evidence = '```json\n{"evidence": true}\n```\n\n评审结论：\n'
        result = self.valid_result()

        self.assertEqual(result, guard.parse_result(self.message(result, evidence)))

    def test_rejects_non_terminal_and_oversized_json_blocks(self):
        valid_block = self.message(self.valid_result(), prefix="")
        with self.subTest(case="non-terminal"):
            with self.assertRaises(guard.ContractError):
                guard.parse_result(f"{valid_block}\n评审结束")

        with self.subTest(case="oversized-result-block"):
            oversized = self.valid_result(
                conclusion="x" * guard.MAX_SCAN_BYTES
            )
            with self.assertRaises(guard.ContractError):
                guard.parse_result(self.message(oversized))

    def test_only_the_final_16_kib_are_scanned(self):
        message = self.message(
            self.valid_result(), prefix="x" * (guard.MAX_SCAN_BYTES * 2) + "\n"
        )
        self.assertEqual("complete", guard.parse_result(message)["status"])


class SubagentStopOutputTest(unittest.TestCase):
    @staticmethod
    def valid_message():
        result = {
            "schema": "delegation-result-v1",
            "task_id": "review-task-1",
            "role": "agent-tools-change-reviewer",
            "status": "complete",
            "input_fingerprints": {"change": "sha256-v1:change"},
            "conclusion": "可继续推进",
            "changed_files": [],
            "unresolved": [],
        }
        return f"```json\n{json.dumps(result, ensure_ascii=False)}\n```"

    def event(self, **overrides):
        event = {
            "hook_event_name": "SubagentStop",
            "agent_type": "agent-tools-change-reviewer",
            "last_assistant_message": self.valid_message(),
            "stop_hook_active": False,
        }
        event.update(overrides)
        return event

    def test_valid_result_allows_stop(self):
        for client in ("claude", "codex"):
            with self.subTest(client=client):
                self.assertEqual({}, guard.handle_event(self.event(), client))

    def test_first_invalid_result_blocks_once_with_client_contract(self):
        event = self.event(last_assistant_message="missing result")

        for client in ("claude", "codex"):
            with self.subTest(client=client):
                output = guard.handle_event(event, client)
                self.assertEqual("block", output["decision"])
                self.assertIn("reason", output)
                self.assertNotIn("continue", output)

    def test_role_mismatch_blocks_once_then_fails_open(self):
        mismatched = self.event(agent_type="agent-tools-solution-reviewer")

        for client in ("claude", "codex"):
            with self.subTest(client=client, attempt="first"):
                output = guard.handle_event(mismatched, client)
                self.assertEqual("block", output["decision"])
                self.assertIn("agent_type", output["reason"])

            repeated = copy.deepcopy(mismatched)
            repeated["stop_hook_active"] = True
            with self.subTest(client=client, attempt="repeated"):
                output = guard.handle_event(repeated, client)
                self.assertEqual({"systemMessage"}, set(output))

    def test_missing_agent_type_fails_open(self):
        event = self.event()
        event.pop("agent_type")

        for client in ("claude", "codex"):
            with self.subTest(client=client):
                output = guard.handle_event(event, client)
                self.assertEqual({"systemMessage"}, set(output))

    def test_active_stop_and_bad_input_fail_open_with_system_message(self):
        invalid = self.event(last_assistant_message="missing result")
        active = copy.deepcopy(invalid)
        active["stop_hook_active"] = True

        cases = (
            active,
            {"hook_event_name": "SubagentStop", "stop_hook_active": False},
            {"hook_event_name": "SubagentStop", "last_assistant_message": 1},
            ["not-an-object"],
        )
        for client in ("claude", "codex"):
            for event in cases:
                with self.subTest(client=client, event=event):
                    output = guard.handle_event(event, client)
                    self.assertEqual({"systemMessage"}, set(output))
                    self.assertTrue(output["systemMessage"])

    def test_missing_stop_hook_active_fails_open_to_avoid_a_loop(self):
        event = self.event(last_assistant_message="missing result")
        event.pop("stop_hook_active")

        for client in ("claude", "codex"):
            with self.subTest(client=client):
                output = guard.handle_event(event, client)
                self.assertEqual({"systemMessage"}, set(output))

    def test_main_fails_open_on_invalid_stdin_json(self):
        stdin = io.StringIO("not-json")
        stdout = io.StringIO()
        with mock.patch.object(guard.sys, "stdin", stdin), mock.patch.object(
            guard.sys, "stdout", stdout
        ):
            self.assertEqual(
                0,
                guard.main(
                    ["--client", "claude", "--owner", guard.OWNER]
                ),
            )

        output = json.loads(stdout.getvalue())
        self.assertEqual({"systemMessage"}, set(output))


if __name__ == "__main__":
    unittest.main()
