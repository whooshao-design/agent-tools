from __future__ import annotations

import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "session_tmp_cleanup.py"
SPEC = importlib.util.spec_from_file_location("session_tmp_cleanup", MODULE_PATH)
assert SPEC and SPEC.loader
hook = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hook)

SESSION = "3b99f906-6baf-4a65-8edc-68b7cb517488"
OTHER = "e6a4f8ab-262e-4524-9a8a-229c3f03648a"


class SessionTmpCleanupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name) / "claude-1000"
        for project in ("-tmp", "-home-joney"):
            for session in (SESSION, OTHER):
                (self.base / project / session / "scratchpad").mkdir(parents=True)
        (self.base / "bash-edit-diff").mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_removes_only_this_sessions_dirs(self):
        removed = hook.cleanup(self.base, SESSION)

        self.assertEqual(2, len(removed))
        for project in ("-tmp", "-home-joney"):
            self.assertFalse((self.base / project / SESSION).exists())
            self.assertTrue((self.base / project / OTHER / "scratchpad").is_dir())
        self.assertTrue((self.base / "bash-edit-diff").is_dir())

    def test_rejects_non_uuid_session_id(self):
        for session_id in ("", "..", "*", f"../{SESSION}", SESSION.upper()):
            self.assertEqual([], hook.cleanup(self.base, session_id))
        self.assertTrue((self.base / "-tmp" / SESSION).is_dir())

    def test_does_not_follow_symlinked_session_dir(self):
        outside = Path(self.temp.name) / "outside"
        (outside / "keep").mkdir(parents=True)
        (self.base / "linked").mkdir()
        (self.base / "linked" / SESSION).symlink_to(outside)

        hook.cleanup(self.base, SESSION)

        self.assertTrue((outside / "keep").is_dir())

    def test_main_reads_session_id_from_stdin_and_ignores_bad_input(self):
        with mock.patch.object(hook, "default_base", return_value=self.base):
            for raw in ("not json", json.dumps(["list"]), json.dumps({"session_id": 1})):
                with mock.patch("sys.stdin", io.StringIO(raw)):
                    self.assertEqual(0, hook.main([]))
            self.assertTrue((self.base / "-tmp" / SESSION).is_dir())

            payload = {"session_id": SESSION, "cwd": "/tmp", "reason": "prompt_input_exit"}
            with mock.patch("sys.stdin", io.StringIO(json.dumps(payload))):
                self.assertEqual(0, hook.main([]))
        self.assertFalse((self.base / "-tmp" / SESSION).exists())


if __name__ == "__main__":
    unittest.main()
