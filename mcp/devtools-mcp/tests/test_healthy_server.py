import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from devtools_mcp import healthy_server as server


class HealthyToolsTest(unittest.TestCase):
    def test_read_preserves_old_profile_argument_and_adds_site(self):
        with patch.object(server, "_run", return_value="ok") as run:
            self.assertEqual(server.healthy_read_board(1, "/profile", "stable"), "ok")
        args = run.call_args.args[0]
        self.assertIn("--profile=/profile", args)
        self.assertIn("--env=stable", args)
        self.assertIn("--read", args)

    def test_update_uses_structured_json_without_shell_interpolation(self):
        configs = {"panels": [{"name": "中文 `literal` $(literal)", "expr": 'up{env="pre"}'}]}
        with patch.object(server, "_run", return_value="ok") as run:
            server.healthy_update_board(1, configs, "a" * 64)
        args = run.call_args.args[0]
        value = next(arg.split("=", 1)[1] for arg in args if arg.startswith("--configs-json="))
        self.assertEqual(json.loads(value), configs)
        self.assertIn("--expected-sha256=" + "a" * 64, args)

    def test_invalid_write_or_site_does_not_execute(self):
        with patch.object(server, "_run") as run:
            for board_id, env, sha in [(0, "prod", "a" * 64), (1, "pre", "a" * 64), (1, "prod", "")]:
                server.healthy_update_board(board_id, {}, sha, env=env)
            run.assert_not_called()

    def test_verify_variables_are_data_and_no_apply_flag(self):
        with patch.object(server, "_run", return_value="ok") as run:
            server.healthy_verify_board(1, {"env": ["pre"]})
        args = run.call_args.args[0]
        self.assertIn('--variables-json={"env": ["pre"]}', args)
        self.assertNotIn("--apply", args)

    def test_batch_routes_to_formal_metrics_script(self):
        with patch.object(server, "_run", return_value="ok") as run, \
                patch.object(server, "_new_results_dir", return_value=Path("/tmp/mock-metrics")):
            server.healthy_query_metrics([{"name": "up", "expr": "count(up)"}], env="stable")
        self.assertEqual(run.call_args.kwargs["script"], server.METRICS_SCRIPT)
        self.assertIn("--output=/tmp/mock-metrics/results.json", run.call_args.args[0])
        self.assertIn("--query-type=range", run.call_args.args[0])

    def test_results_dir_prunes_only_expired_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "healthy-metrics"
            expired, recent = root / "expired", root / "recent"
            expired.mkdir(parents=True)
            recent.mkdir()
            old = time.time() - server.RESULTS_TTL_SECONDS - 60
            os.utime(expired, (old, old))
            with patch.object(server, "RESULTS_ROOT", root):
                created = server._new_results_dir()
            self.assertFalse(expired.exists())
            self.assertTrue(recent.is_dir())
            self.assertEqual(root, created.parent)

    def test_invalid_queries_do_not_execute(self):
        with patch.object(server, "_run") as run:
            server.healthy_query_metrics([])
            server.healthy_query_metrics([{"name": "x"}])
            server.healthy_query_metrics([{"name": "x", "expr": "up"}], query_type="invalid")
            run.assert_not_called()


class ToolAnnotationsTest(unittest.IsolatedAsyncioTestCase):
    async def test_read_and_write_annotations(self):
        tools = {tool.name: tool for tool in await server.mcp.list_tools()}
        for name in ("healthy_read_board", "healthy_verify_board", "healthy_query_metrics"):
            self.assertTrue(tools[name].annotations.readOnlyHint)
        for name in ("healthy_update_board", "healthy_apply_hawk_read_through"):
            self.assertFalse(tools[name].annotations.readOnlyHint)


if __name__ == "__main__":
    unittest.main()
