from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).parents[1]
SCRIPT = REPO / "skills/common/recall-agent-sessions/scripts/agent_sessions.py"
SPEC = importlib.util.spec_from_file_location("agent_sessions", SCRIPT)
assert SPEC and SPEC.loader
ras = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ras)


def write_jsonl(path: Path, records: list[dict]) -> Path:
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n", encoding="utf-8")
    return path


class RecallAgentSessionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_claude_keeps_user_intent_and_tool_actions_only(self):
        ts = "2026-10-12T06:21:00Z"
        path = write_jsonl(self.dir / "abc.jsonl", [
            {"type": "user", "cwd": "/repo", "gitBranch": "main", "timestamp": ts,
             "message": {"content": '<pasted_content id="x">查告警</pasted_content><system-reminder>noise</system-reminder>'}},
            {"type": "user", "timestamp": ts, "message": {"content": '<pasted_content id="x">查告警</pasted_content>'}},
            {"type": "user", "isMeta": True, "timestamp": ts, "message": {"content": "meta"}},
            {"type": "user", "timestamp": ts, "message": {"content": "[Request interrupted by user]"}},
            {"type": "assistant", "timestamp": ts, "message": {"content": [
                {"type": "thinking", "thinking": "hidden"},
                {"type": "text", "text": "结论"},
                {"type": "tool_use", "name": "Bash", "input": {"command": "rg foo"}},
                {"type": "tool_use", "name": "Edit", "input": {"file_path": "/repo/a.py"}}]}},
            {"type": "user", "timestamp": ts, "message": {"content": [{"type": "tool_result", "content": "out"}]}},
            {"type": "assistant", "isSidechain": True, "timestamp": ts, "message": {"content": [{"type": "text", "text": "side"}]}},
        ])
        s = ras.parse_claude(path)
        self.assertEqual((s.id, s.cwd, s.branch), ("abc", "/repo", "main"))
        self.assertEqual([(k, t) for _, k, t in s.events], [
            ("user", "查告警"), ("assistant", "结论"), ("command", "rg foo"), ("file", "/repo/a.py")])

    def test_codex_item_format_and_subthread_skip(self):
        meta = {"type": "session_meta", "payload": {"id": "t1", "cwd": "/repo", "originator": "codex-tui"}}
        item = lambda it: {"type": "event_msg", "timestamp": "2026-10-09T06:01:00Z",
                           "payload": {"type": "item_completed", "item": it}}
        path = write_jsonl(self.dir / "rollout-a.jsonl", [
            meta,
            item({"type": "UserMessage", "content": [{"type": "text", "text": "梳理流量"}]}),
            item({"type": "CommandExecution", "command": ["/bin/bash", "-lc", "git status"]}),
            item({"type": "FileChange", "changes": {"/repo/B.java": {"type": "update"}}}),
            item({"type": "AgentMessage", "content": [{"type": "Text", "text": "已完成"}]}),
        ])
        s = ras.parse_codex(path)
        self.assertEqual([(k, t) for _, k, t in s.events], [
            ("user", "梳理流量"), ("command", "git status"), ("file", "/repo/B.java"), ("assistant", "已完成")])
        self.assertEqual(s.resume_cmd(), "codex resume t1")

        sub = write_jsonl(self.dir / "rollout-b.jsonl", [
            {"type": "session_meta", "payload": {"id": "t2", "parent_thread_id": "t1"}}])
        self.assertIsNone(ras.parse_codex(sub))

    def test_codex_legacy_format_falls_back_to_event_messages(self):
        path = write_jsonl(self.dir / "rollout-c.jsonl", [
            {"type": "session_meta", "payload": {"id": "t3", "cwd": "/repo"}},
            {"type": "event_msg", "timestamp": "t", "payload": {"type": "user_message", "message": "重新init"}},
            {"type": "response_item", "timestamp": "t", "payload": {
                "type": "function_call", "name": "shell", "arguments": json.dumps({"command": ["bash", "-lc", "ls"]})}},
            {"type": "event_msg", "timestamp": "t", "payload": {"type": "agent_message", "message": "done"}},
        ])
        s = ras.parse_codex(path)
        self.assertEqual([(k, t) for _, k, t in s.events], [("user", "重新init"), ("command", "ls"), ("assistant", "done")])


if __name__ == "__main__":
    unittest.main()
