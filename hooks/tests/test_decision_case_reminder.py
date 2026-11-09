from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "decision_case_reminder.py"
SPEC = importlib.util.spec_from_file_location("decision_case_reminder", MODULE_PATH)
assert SPEC and SPEC.loader
hook = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hook)

CASES = str(Path(__file__).resolve().parents[2] / "skills/lexin/diagnose-decision-execution/references/cases.md")


def user(text: str) -> dict:
    return {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}


def tool_result() -> dict:
    return {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}}


def assistant(*blocks: dict) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks)}}


def tool_use(name: str, **tool_input) -> dict:
    return {"type": "tool_use", "name": name, "input": tool_input}


def text(value: str) -> dict:
    return {"type": "text", "text": value}


CK_QUERY = "SELECT Fseq FROM risk_control_base_db.t_strategy_node_decision_water WHERE Forder_id = 'O1' LIMIT 10"


class DecisionCaseReminderTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "session.jsonl"

    def tearDown(self):
        self.temp.cleanup()

    def write(self, *records: dict, raw_lines: tuple[str, ...] = ()):
        with self.path.open("w", encoding="utf-8") as handle:
            for record in records:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            for line in raw_lines:
                handle.write(line + "\n")

    def event(self, **overrides) -> dict:
        base = {"hook_event_name": "Stop", "stop_hook_active": False, "transcript_path": str(self.path)}
        base.update(overrides)
        return base

    def test_blocks_when_investigated_without_recording(self):
        self.write(user("查一下 O1 为什么 hold"), assistant(tool_use("Bash", command=CK_QUERY)), tool_result(),
                   assistant(text("结论：...")))
        result = hook.handle_event(self.event())
        self.assertEqual(result.get("decision"), "block")
        self.assertIn("cases.md", result["reason"])

    def test_skill_invocation_counts_as_investigation(self):
        self.write(user("排查决策"), assistant(tool_use("Skill", skill="diagnose-decision-execution")), tool_result(),
                   assistant(text("done")))
        self.assertEqual(hook.handle_event(self.event()).get("decision"), "block")

    def test_passes_when_case_recorded_in_session(self):
        self.write(user("查一下"), assistant(tool_use("Bash", command=CK_QUERY)), tool_result(),
                   assistant(tool_use("Edit", file_path=CASES, old_string="a", new_string="b")), tool_result(),
                   assistant(text("已沉淀")))
        self.assertEqual(hook.handle_event(self.event()), {})

    def test_passes_when_reply_declares_nothing_to_record(self):
        self.write(user("查一下"), assistant(tool_use("Bash", command=CK_QUERY)), tool_result(),
                   assistant(text("结论如上，本轮无沉淀。")))
        self.assertEqual(hook.handle_event(self.event()), {})

    def test_last_assistant_message_from_event_wins(self):
        self.write(user("查一下"), assistant(tool_use("Bash", command=CK_QUERY)), tool_result(),
                   assistant(text("结论")))
        self.assertEqual(hook.handle_event(self.event(last_assistant_message="本轮无沉淀")), {})

    def test_only_current_turn_counts(self):
        self.write(user("查一下"), assistant(tool_use("Bash", command=CK_QUERY)), tool_result(),
                   assistant(text("结论")), user("谢谢，顺便看看别的"), assistant(text("好的")))
        self.assertEqual(hook.handle_event(self.event()), {})

    def test_ignores_markers_outside_assistant_tool_use(self):
        self.write(user("随便聊聊"), assistant(text("t_strategy_node_decision_water 是节点流水表")),
                   raw_lines=(json.dumps({"type": "api-request", "params": CK_QUERY}),))
        self.assertEqual(hook.handle_event(self.event()), {})

    def test_passes_when_stop_hook_already_active(self):
        self.write(user("查一下"), assistant(tool_use("Bash", command=CK_QUERY)), tool_result(), assistant(text("结论")))
        self.assertEqual(hook.handle_event(self.event(stop_hook_active=True)), {})

    def test_fail_open_on_bad_input(self):
        self.assertEqual(hook.handle_event("not a dict"), {})
        self.assertEqual(hook.handle_event(self.event(transcript_path="/nonexistent/x.jsonl")), {})
        self.assertEqual(hook.handle_event(self.event(hook_event_name="SubagentStop")), {})


if __name__ == "__main__":
    unittest.main()
