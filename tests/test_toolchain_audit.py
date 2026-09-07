import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("toolchain_audit", Path(__file__).parents[1] / "bin/toolchain_audit.py")
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class ToolchainAuditTest(unittest.TestCase):
    def test_server_summary_never_emits_credentials(self):
        server = {"url": "https://user:secret@example.com/?token=secret",
                  "env": {"TOKEN": "secret"}, "headers": {"Authorization": "Bearer ${AUDIT_MISSING_TOKEN}"},
                  "args": ["--token", "secret"]}
        with patch.dict(os.environ, {}, clear=True):
            result = audit.server_summary(server)
        self.assertNotIn("secret", json.dumps(result))
        self.assertEqual(["AUDIT_MISSING_TOKEN"], result["missing_process_env"])
        self.assertEqual(["TOKEN"], result["env_keys"])

    def test_recursive_discovery_follows_links_without_loops_or_nested_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / "source/skills/example"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("---\nname: example\ndescription: Example.\n---\nContent\n")
            (skill / "assets/nested").mkdir(parents=True)
            (skill / "assets/nested/SKILL.md").write_text("not a skill entry")
            installed = root / "installed"
            installed.mkdir()
            (installed / "bundle").symlink_to(root / "source/skills", target_is_directory=True)
            (root / "source/skills/loop").symlink_to(installed, target_is_directory=True)
            entries = audit.skill_entries(installed)
            self.assertEqual(["example"], [item["name"] for item in entries])
            self.assertEqual(str(skill / "SKILL.md"), entries[0]["source"])

    def test_inventory_detects_shared_mcp_gap_and_window_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".codex").mkdir()
            (root / ".codex/config.toml").write_text(
                'model = "example"\nmodel_context_window = 300000\n'
                '[mcp_servers.internal]\ncommand = "python3"\nargs = ["-m", "example.server"]\n'
            )
            (root / ".codex/models_cache.json").write_text(json.dumps({
                "models": [{"slug": "example", "context_window": 272000}]
            }))
            before = sorted(str(path) for path in root.rglob("*"))
            result = audit.inventory(root / "repo", root)
            self.assertEqual(before, sorted(str(path) for path in root.rglob("*")))
            self.assertEqual({"SHARED_MCP_MISSING", "CONTEXT_WINDOW_DIFFERS_FROM_CACHE"},
                             {issue["code"] for issue in result["issues"]})

    def test_claude_local_model_and_hook_declarations_are_not_hidden(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = root / ".claude"
            settings.mkdir()
            (settings / "settings.json").write_text(json.dumps({"model": "user-model"}))
            (settings / "settings.local.json").write_text(json.dumps({
                "model": "local-model", "effortLevel": "high",
                "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "example"}]}]}
            }))
            result = audit.inventory(root / "repo", root)
            self.assertEqual("local-model", result["models"]["claude"])
            self.assertEqual("high", result["models"]["claude_effort"])
            self.assertEqual({"Stop": 1}, result["hooks"]["claude_local"])
            self.assertIn("Declaration counts", result["hooks_scope_note"])


if __name__ == "__main__":
    unittest.main()
