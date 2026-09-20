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


class SpawnModelAgentTest(unittest.TestCase):
    def test_detect_client_from_host_env(self):
        with mock.patch.dict("os.environ", {"CLAUDECODE": "1"}, clear=True):
            self.assertEqual(sma.detect_client(), "claude")
        with mock.patch.dict("os.environ", {"CODEX_THREAD_ID": "x"}, clear=True):
            self.assertEqual(sma.detect_client(), "codex")
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(sma.detect_client(), "claude")

    def test_short_names_follow_host_and_full_names_pass_through(self):
        self.assertEqual(sma.resolve_backend("kimi", "claude"), "claude-kimi")
        self.assertEqual(sma.resolve_backend("qwen", "codex"), "codex-qwen")
        self.assertEqual(sma.resolve_backend("claude-deepseek", "codex"), "claude-deepseek")
        with self.assertRaises(SystemExit):
            sma.resolve_backend("gpt", "claude")

    def test_commands_match_host_permissions(self):
        c = sma.build_command("claude-kimi", "do it", readonly=False)
        self.assertEqual(c[:3], ["claude-kimi", "-p", "do it"])
        self.assertIn("--dangerously-skip-permissions", c)
        self.assertNotIn("--tools", c)
        r = sma.build_command("claude-kimi", "do it", readonly=True)
        self.assertIn("--tools", r)
        self.assertNotIn("--dangerously-skip-permissions", r)

        x = sma.build_command("codex-qwen", "do it", readonly=False)
        self.assertEqual(x[:3], ["codex-qwen", "--search", "exec"])
        self.assertIn("workspace-write", x)
        self.assertIn('approval_policy="never"', x)
        self.assertIn("read-only", sma.build_command("codex-qwen", "do it", readonly=True))


if __name__ == "__main__":
    unittest.main()
