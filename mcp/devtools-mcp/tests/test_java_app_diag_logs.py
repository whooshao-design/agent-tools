import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from devtools_mcp import java_app_diag_core as core
from devtools_mcp import java_app_diag_server as server


class LogFileValidationTest(unittest.TestCase):
    def test_current_and_suffix_rotations_remain_supported(self):
        for name in ("error.log", "debug.log.1", "info.log.2026-09-10.gz", "stdout.log.gz"):
            with self.subTest(name=name):
                self.assertEqual(core.validate_log_file(name), name)

    def test_warn_and_timestamp_before_extension_are_supported(self):
        for name in ("warn.log", "warn.log.1.gz", "info_2026091010.0.log",
                     "info_2026091010.0.log.gz", "error_20260910.log"):
            with self.subTest(name=name):
                self.assertEqual(core.validate_log_file(name), name)

    def test_paths_unrelated_files_and_shell_fragments_are_rejected(self):
        for name in ("../error.log", "/tmp/error.log", "application.properties", "audit.log",
                     "info_abc.log", "info.log;id", "info.log$(id)", "info.log\nerror.log"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                core.validate_log_file(name)


class LogReadCommandTest(unittest.IsolatedAsyncioTestCase):
    async def test_uncompressed_rotation_uses_grep_and_preserves_environment(self):
        with patch.object(server, "_execute", new_callable=AsyncMock, return_value="match") as execute:
            result = await server.grep_app_log(
                "192.0.2.1", "test_app", "trace-id", file_name="info_2026091010.0.log", env="prj")
        self.assertEqual(result, "match")
        command = execute.call_args.args[1]
        self.assertIn("info_2026091010.0.log", command)
        self.assertTrue(command.startswith("grep "))
        self.assertEqual(execute.call_args.kwargs["env"], "prj")

    async def test_compressed_rotation_uses_zcat(self):
        with patch.object(server, "_execute", new_callable=AsyncMock, return_value="match") as execute:
            result = await server.grep_app_log(
                "192.0.2.1", "test_app", "trace-id", file_name="warn_2026091010.0.log.gz", env="prj")
        self.assertEqual(result, "match")
        self.assertTrue(execute.call_args.args[1].startswith("zcat "))

    async def test_invalid_file_never_reaches_bastion(self):
        with patch.object(server, "_execute", new_callable=AsyncMock) as execute:
            result = await server.grep_app_log("192.0.2.1", "test_app", "trace-id", file_name="../error.log")
        self.assertIn("file_name", result)
        execute.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
