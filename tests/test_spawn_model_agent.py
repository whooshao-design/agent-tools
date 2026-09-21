from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest import mock


REPO = Path(__file__).parents[1]
SCRIPT = REPO / "skills/common/spawn-model-agent/scripts/spawn_model_agent.py"
SPEC = importlib.util.spec_from_file_location("spawn_model_agent", SCRIPT)
assert SPEC and SPEC.loader
sma = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sma)

WRAPPERS = ["claude-deepseek", "claude-kimi", "claude-qwen", "codex-kimi", "codex-qwen", "codex-vps"]


class SpawnModelAgentTest(unittest.TestCase):
    def test_detect_client_from_host_env_then_process_tree(self):
        with mock.patch.dict("os.environ", {"CLAUDECODE": "1"}, clear=True):
            self.assertEqual(sma.detect_client(), "claude")
        with mock.patch.dict("os.environ", {"CODEX_THREAD_ID": "x"}, clear=True):
            self.assertEqual(sma.detect_client(), "codex")
        tree = {100: ("python3", 90), 90: ("bash", 80), 80: ("codex.exe", 1)}

        def fake_open(path, *a, **k):
            pid = int(path.split("/")[2])
            comm, ppid = tree[pid]
            body = comm if path.endswith("comm") else f"{pid} ({comm}) S {ppid} 1 1"
            return mock.mock_open(read_data=body)()

        with mock.patch.dict("os.environ", {}, clear=True), mock.patch("os.getppid", return_value=100), \
                mock.patch("builtins.open", side_effect=fake_open):
            self.assertEqual(sma.detect_client(), "codex")
        with mock.patch.dict("os.environ", {}, clear=True), mock.patch("os.getppid", return_value=1), \
                mock.patch("builtins.open", side_effect=OSError):
            self.assertIsNone(sma.detect_client())

    def test_short_names_follow_host_and_full_names_pass_through(self):
        with mock.patch.object(sma, "wrappers_on_path", return_value=WRAPPERS):
            self.assertEqual(sma.resolve_backend("kimi", "claude"), "claude-kimi")
            self.assertEqual(sma.resolve_backend("qwen", "codex"), "codex-qwen")
            self.assertEqual(sma.resolve_backend("claude-deepseek", "codex"), "claude-deepseek")
            with self.assertRaises(SystemExit):
                sma.resolve_backend("gpt", "claude")  # no such wrapper
            with self.assertRaises(SystemExit):
                sma.resolve_backend("kimi", None)  # host unknown, short name ambiguous

    def test_commands_match_host_permissions(self):
        c = sma.build_command("claude-kimi", "do it", readonly=False)
        self.assertEqual(c[:3], ["claude-kimi", "-p", "do it"])
        self.assertIn("--dangerously-skip-permissions", c)
        self.assertNotIn("--tools", c)
        self.assertNotIn("--strict-mcp-config", c)  # MCP inherited like a normal subagent
        r = sma.build_command("claude-kimi", "do it", readonly=True)
        self.assertIn("--tools", r)
        self.assertNotIn("--dangerously-skip-permissions", r)

        x = sma.build_command("codex-qwen", "do it", readonly=False)
        self.assertEqual(x[:3], ["codex-qwen", "--search", "exec"])
        self.assertIn("workspace-write", x)
        self.assertIn('approval_policy="never"', x)
        self.assertNotIn("--ephemeral", x)  # thread must persist for --resume
        self.assertIn("read-only", sma.build_command("codex-qwen", "do it", readonly=True))

    def test_resume_commands(self):
        c = sma.build_command("claude-kimi", "more", readonly=False, resume_id="sid")
        self.assertEqual(c[c.index("--resume") + 1], "sid")
        x = sma.build_command("codex-kimi", "more", readonly=False, resume_id="tid")
        self.assertEqual(x[:4], ["codex-kimi", "--search", "exec", "resume"])
        self.assertNotIn("-s", x)  # exec resume has no -s; sandbox goes through -c
        self.assertIn('sandbox_mode="workspace-write"', x)
        self.assertEqual(x[-2:], ["tid", "more"])

    def test_resume_inherits_readonly_and_slim(self):
        from types import SimpleNamespace
        a = SimpleNamespace(cwd="/x", slim=False, readonly=False)
        backend, sid = sma.apply_resume(a, {"backend": "codex-kimi", "session_id": "t1", "readonly": True, "slim": True, "cwd": "/y"})
        self.assertEqual((backend, sid), ("codex-kimi", "t1"))
        self.assertTrue(a.readonly)
        self.assertTrue(a.slim)
        self.assertEqual(a.cwd, "/y")
        with self.assertRaises(SystemExit):
            sma.apply_resume(a, {"backend": "codex-kimi"})

    def test_timeout_writes_terminal_meta(self):
        import json, os, subprocess, tempfile
        with tempfile.TemporaryDirectory() as job:
            exc = subprocess.TimeoutExpired(cmd=["x"], timeout=1, output="partial", stderr="err")
            with mock.patch.object(sma.subprocess, "run", side_effect=exc):
                rc = sma.run_child(job, "claude-kimi", "t", job, False, False, 1, None)
            self.assertEqual(rc, 124)
            meta = json.load(open(os.path.join(job, "meta.json")))
            self.assertEqual(meta["exit_code"], "timeout")
            self.assertTrue(os.path.exists(os.path.join(job, "result.md")))

    def test_parsers_capture_session_ids(self):
        meta, text = sma.parse_claude('{"session_id":"s1","result":"ok","num_turns":2,"modelUsage":{"m":{"inputTokens":1,"outputTokens":2}}}')
        self.assertEqual((meta["session_id"], meta["model"], text), ("s1", "m", "ok"))
        raw = '{"type":"thread.started","thread_id":"t1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}'
        meta, text = sma.parse_codex(raw)
        self.assertEqual((meta["session_id"], meta["input_tokens"], text), ("t1", 3, "hi"))

    def test_fit_hint_comes_from_routing(self):
        with mock.patch.object(sma, "routing_backends", return_value={"codex-glm": {"fit": "只派轻任务", "output_cap_tokens": 8192}}):
            self.assertIn("8192", sma.fit_hint("codex-glm"))
            self.assertIn("只派轻任务", sma.fit_hint("codex-glm"))
            self.assertIsNone(sma.fit_hint("codex-kimi"))
        self.assertIsNotNone(sma.fit_hint("codex-glm"))  # real routing file carries the rule


if __name__ == "__main__":
    unittest.main()
