from __future__ import annotations

import argparse
import contextlib
import json
import importlib.util
import io
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


REPO = Path(__file__).parents[1]
INSTALL = REPO / "install.py"
SPEC = importlib.util.spec_from_file_location("agent_tools_install", INSTALL)
assert SPEC and SPEC.loader
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)
OWNER = "agent-tools-subagent-result-v1"
AGENT_NAMES = (
    "agent-tools-requirements-reviewer",
    "agent-tools-solution-reviewer",
    "agent-tools-test-design-reviewer",
    "agent-tools-change-reviewer",
)
MATCHER = "^(" + "|".join(AGENT_NAMES) + ")$"


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.home = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def run_install(self, *args, check=True):
        env = os.environ.copy()
        env["HOME"] = str(self.home)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        result = subprocess.run(
            [sys.executable, str(INSTALL), *args],
            cwd=REPO,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        if check and result.returncode != 0:
            self.fail(
                f"install.py exited {result.returncode}\n"
                f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            )
        return result

    def write_json(self, relative_path, data, mode=0o644):
        path = self.home / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        path.chmod(mode)
        return path

    @staticmethod
    def foreign_group():
        return {
            "matcher": "foreign-reviewer",
            "hooks": [
                {
                    "type": "command",
                    "command": "python3 /opt/foreign/review.py",
                    "timeout": 20,
                }
            ],
        }

    @staticmethod
    def owned_groups(data):
        groups = data.get("hooks", {}).get("SubagentStop", [])
        return [
            group
            for group in groups
            if any(
                OWNER in hook.get("command", "")
                for hook in group.get("hooks", [])
                if isinstance(hook, dict)
            )
        ]

    def assert_private_file(self, path):
        mode = stat.S_IMODE(path.stat().st_mode)
        self.assertEqual(0, mode & ~0o600, f"unexpected mode {mode:o}: {path}")

    def test_default_still_installs_only_skills(self):
        self.run_install(
            "--targets", "claude", "--skills", "skill-authoring"
        )

        skill = self.home / ".claude/skills/skill-authoring"
        self.assertTrue(skill.is_symlink())
        manifest = json.loads(
            (self.home / ".claude/.agent-tools-install.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(
            str((REPO / "skills/common/skill-authoring").resolve()),
            manifest["links"][str(skill)],
        )
        self.assertFalse((self.home / ".claude/agents").exists())
        self.assertFalse((self.home / ".claude/hooks").exists())
        self.assertFalse((self.home / ".claude/settings.json").exists())
        self.assertFalse((self.home / ".claude/CLAUDE.md").exists())

    def test_with_global_links_client_instructions_and_uninstalls(self):
        existing = self.home / ".codex/AGENTS.md"
        existing.parent.mkdir(parents=True)
        existing.write_text("user rules\n", encoding="utf-8")

        result = self.run_install("--with-global", "--skills", "skill-authoring")

        source = (REPO / "AGENTS.global.md").resolve()
        claude = self.home / ".claude/CLAUDE.md"
        self.assertTrue(claude.is_symlink())
        self.assertEqual(source, claude.resolve())
        self.assertIn("[global] AGENTS.md: skip (exists, use --force)", result.stdout)
        self.assertEqual("user rules\n", existing.read_text(encoding="utf-8"))

        existing.unlink()
        self.run_install("--with-global", "--skills", "skill-authoring")
        self.assertEqual(source, existing.resolve())

        self.run_install(
            "--with-global", "--skills", "skill-authoring", "--uninstall"
        )
        self.assertFalse(claude.exists() or claude.is_symlink())
        self.assertFalse(existing.exists() or existing.is_symlink())

    def test_with_subagents_preserves_configs_and_is_idempotent(self):
        foreign = self.foreign_group()
        claude_config = self.write_json(
            ".claude/settings.json",
            {
                "model": "keep-claude",
                "hooks": {
                    "Stop": [{"hooks": []}],
                    "SubagentStop": [foreign],
                },
            },
        )
        codex_config = self.write_json(
            ".codex/hooks.json",
            {
                "description": "keep-codex",
                "hooks": {
                    "PostToolUse": [{"matcher": "Bash", "hooks": []}],
                    "SubagentStop": [foreign],
                },
            },
        )

        args = (
            "--skills",
            "skill-authoring",
            "--with-subagents",
        )
        self.run_install(*args)
        first_claude = claude_config.read_bytes()
        first_codex = codex_config.read_bytes()
        self.run_install(*args)

        self.assertEqual(first_claude, claude_config.read_bytes())
        self.assertEqual(first_codex, codex_config.read_bytes())
        for client, suffix, config_path in (
            ("claude", ".md", claude_config),
            ("codex", ".toml", codex_config),
        ):
            data = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertIn(foreign, data["hooks"]["SubagentStop"])
            owned = self.owned_groups(data)
            self.assertEqual(1, len(owned))
            self.assertEqual(MATCHER, owned[0]["matcher"])
            self.assertIn(f"--client {client}", owned[0]["hooks"][0]["command"])
            self.assertIn(f"--owner {OWNER}", owned[0]["hooks"][0]["command"])

            for name in AGENT_NAMES:
                agent = self.home / f".{client}/agents/{name}{suffix}"
                self.assertTrue(agent.is_symlink(), agent)

            scripts = list(
                (self.home / f".{client}/hooks/agent-tools").glob(
                    "subagent_result_guard-*.py"
                )
            )
            self.assertEqual(1, len(scripts))
            self.assert_private_file(scripts[0])
            self.assert_private_file(config_path)

        claude_data = json.loads(claude_config.read_text(encoding="utf-8"))
        codex_data = json.loads(codex_config.read_text(encoding="utf-8"))
        self.assertEqual("keep-claude", claude_data["model"])
        self.assertEqual([{"hooks": []}], claude_data["hooks"]["Stop"])
        self.assertEqual("keep-codex", codex_data["description"])
        self.assertEqual(
            [{"matcher": "Bash", "hooks": []}],
            codex_data["hooks"]["PostToolUse"],
        )

    def test_dry_run_is_zero_write_and_targets_are_respected(self):
        self.run_install(
            "--targets",
            "claude",
            "--skills",
            "skill-authoring",
            "--with-subagents",
            "--dry-run",
        )
        self.assertFalse((self.home / ".claude").exists())

        self.run_install(
            "--targets",
            "codex",
            "--skills",
            "skill-authoring",
            "--with-subagents",
        )
        self.assertFalse((self.home / ".claude").exists())
        self.assertTrue(
            (self.home / ".codex/agents/agent-tools-change-reviewer.toml")
            .is_symlink()
        )
        self.assertTrue((self.home / ".codex/hooks.json").is_file())

    def test_copy_install_uninstall_removes_only_owned_content(self):
        foreign = self.foreign_group()
        config = self.write_json(
            ".claude/settings.json",
            {"custom": {"keep": True}, "hooks": {"SubagentStop": [foreign]}},
        )
        args = (
            "--targets",
            "claude",
            "--skills",
            "skill-authoring",
            "--copy",
            "--with-subagents",
        )
        self.run_install(*args)
        self.assertTrue((self.home / ".claude/skills/skill-authoring").is_dir())
        self.assertFalse(
            (self.home / ".claude/agents/agent-tools-change-reviewer.md")
            .is_symlink()
        )

        self.run_install(
            "--targets",
            "claude",
            "--skills",
            "skill-authoring",
            "--with-subagents",
            "--uninstall",
        )

        self.assertFalse((self.home / ".claude/skills/skill-authoring").exists())
        for name in AGENT_NAMES:
            self.assertFalse((self.home / f".claude/agents/{name}.md").exists())
        self.assertEqual(
            [],
            list(
                (self.home / ".claude/hooks/agent-tools").glob(
                    "subagent_result_guard-*.py"
                )
            ),
        )
        data = json.loads(config.read_text(encoding="utf-8"))
        self.assertEqual({"keep": True}, data["custom"])
        self.assertEqual([foreign], data["hooks"]["SubagentStop"])

    def test_invalid_json_fails_before_any_target_is_written(self):
        invalid = self.home / ".codex/hooks.json"
        invalid.parent.mkdir(parents=True)
        invalid.write_bytes(b"{not-json")

        result = self.run_install(
            "--skills",
            "skill-authoring",
            "--with-subagents",
            check=False,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertEqual(b"{not-json", invalid.read_bytes())
        self.assertFalse((self.home / ".claude").exists())
        self.assertFalse((self.home / ".codex/skills").exists())
        self.assertFalse((self.home / ".codex/agents").exists())
        self.assertFalse((self.home / ".codex/hooks").exists())

    def test_foreign_skill_is_preserved_while_subagents_install(self):
        skills_dir = self.home / ".claude/skills"
        skills_dir.mkdir(parents=True)
        foreign_source = self.home / "foreign-skill"
        foreign_source.mkdir()
        foreign_link = skills_dir / "skill-authoring"
        foreign_link.symlink_to(foreign_source)

        self.run_install(
            "--targets",
            "claude",
            "--skills",
            "skill-authoring",
            "--with-subagents",
        )
        self.assertEqual(foreign_source, foreign_link.resolve())
        self.assertTrue(
            (
                self.home
                / ".claude/agents/agent-tools-solution-reviewer.md"
            ).is_symlink()
        )
        self.assertTrue((self.home / ".claude/settings.json").is_file())

    def test_foreign_reviewer_aborts_before_any_install_write(self):
        foreign_agent = self.home / ".claude/agents/agent-tools-solution-reviewer.md"
        foreign_agent.parent.mkdir(parents=True)
        foreign_agent.write_text("user-owned\n", encoding="utf-8")

        result = self.run_install(
            "--targets",
            "claude",
            "--skills",
            "skill-authoring",
            "--with-subagents",
            check=False,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("foreign reviewer target", result.stderr)
        self.assertEqual("user-owned\n", foreign_agent.read_text(encoding="utf-8"))
        self.assertFalse((self.home / ".claude/skills").exists())
        self.assertFalse((self.home / ".claude/settings.json").exists())
        self.assertFalse((self.home / ".claude/hooks").exists())
        self.assertFalse((self.home / ".claude/.agent-tools-install.json").exists())

    def test_foreign_reviewer_on_second_client_aborts_both_clients(self):
        foreign_agent = self.home / ".codex/agents/agent-tools-change-reviewer.toml"
        foreign_agent.parent.mkdir(parents=True)
        foreign_agent.write_text("user-owned\n", encoding="utf-8")

        result = self.run_install(
            "--skills",
            "skill-authoring",
            "--with-subagents",
            check=False,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertEqual("user-owned\n", foreign_agent.read_text(encoding="utf-8"))
        self.assertFalse((self.home / ".claude").exists())
        self.assertFalse((self.home / ".codex/skills").exists())
        self.assertFalse((self.home / ".codex/hooks.json").exists())
        self.assertFalse((self.home / ".codex/hooks").exists())
        self.assertFalse((self.home / ".codex/.agent-tools-install.json").exists())

    def test_force_replaces_foreign_reviewer_after_preflight(self):
        foreign_agent = self.home / ".claude/agents/agent-tools-solution-reviewer.md"
        foreign_agent.parent.mkdir(parents=True)
        foreign_agent.write_text("user-owned\n", encoding="utf-8")

        self.run_install(
            "--targets",
            "claude",
            "--skills",
            "skill-authoring",
            "--with-subagents",
            "--force",
        )

        self.assertTrue(foreign_agent.is_symlink())
        self.assertEqual(
            (REPO / "agents/claude/agent-tools-solution-reviewer.md").resolve(),
            foreign_agent.resolve(),
        )

    def test_reviewer_race_after_preflight_aborts_before_any_install_write(self):
        original_targets = installer.TARGETS
        installer.TARGETS = {
            "claude": self.home / ".claude/skills",
            "codex": self.home / ".codex/skills",
        }
        args = argparse.Namespace(
            groups=None,
            skills="skill-authoring",
            targets="claude",
            copy=False,
            force=False,
            with_subagents=True,
            with_global=False,
            dry_run=False,
            list=False,
            uninstall=False,
        )
        foreign_agent = (
            self.home / ".claude/agents/agent-tools-solution-reviewer.md"
        )
        original_preflight = installer._preflight_subagent_targets

        def inject_after_preflight(*preflight_args, **preflight_kwargs):
            result = original_preflight(*preflight_args, **preflight_kwargs)
            foreign_agent.parent.mkdir(parents=True, exist_ok=True)
            foreign_agent.write_text("concurrent-user-owned\n", encoding="utf-8")
            return result

        try:
            with mock.patch.object(
                installer,
                "_preflight_subagent_targets",
                side_effect=inject_after_preflight,
            ), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(installer.InstallError):
                    installer._run(args)

            self.assertEqual(
                "concurrent-user-owned\n",
                foreign_agent.read_text(encoding="utf-8"),
            )
            self.assertFalse((self.home / ".claude/skills").exists())
            self.assertFalse((self.home / ".claude/settings.json").exists())
            self.assertFalse((self.home / ".claude/hooks").exists())
            self.assertFalse(
                (self.home / ".claude/.agent-tools-install.json").exists()
            )
        finally:
            installer.TARGETS = original_targets

    def test_force_still_validates_every_reviewer_source(self):
        original_sources = installer.AGENT_SOURCES
        original_targets = installer.TARGETS
        incomplete_sources = self.home / "incomplete-agents"
        incomplete_sources.mkdir()
        installer.AGENT_SOURCES = {
            "claude": (incomplete_sources, ".md"),
            "codex": original_sources["codex"],
        }
        installer.TARGETS = {
            "claude": self.home / ".claude/skills",
            "codex": self.home / ".codex/skills",
        }
        args = argparse.Namespace(
            groups=None,
            skills="skill-authoring",
            targets="claude",
            copy=False,
            force=True,
            with_subagents=True,
            with_global=False,
            dry_run=False,
            list=False,
            uninstall=False,
        )

        try:
            with contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(
                    installer.InstallError, "reviewer source not found"
                ):
                    installer._run(args)
            self.assertFalse((self.home / ".claude/skills").exists())
            self.assertFalse((self.home / ".claude/settings.json").exists())
        finally:
            installer.AGENT_SOURCES = original_sources
            installer.TARGETS = original_targets

    def test_reviewer_race_after_revision_check_never_installs_hook(self):
        original_targets = installer.TARGETS
        installer.TARGETS = {
            "claude": self.home / ".claude/skills",
            "codex": self.home / ".codex/skills",
        }
        args = argparse.Namespace(
            groups=None,
            skills="skill-authoring",
            targets="claude",
            copy=False,
            force=False,
            with_subagents=True,
            with_global=False,
            dry_run=False,
            list=False,
            uninstall=False,
        )
        foreign_agent = (
            self.home / ".claude/agents/agent-tools-solution-reviewer.md"
        )
        original_check = installer._check_subagent_target_revisions

        def inject_after_revision_check(revisions):
            original_check(revisions)
            foreign_agent.parent.mkdir(parents=True, exist_ok=True)
            foreign_agent.write_text("late-user-owned\n", encoding="utf-8")

        try:
            with mock.patch.object(
                installer,
                "_check_subagent_target_revisions",
                side_effect=inject_after_revision_check,
            ), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(
                    installer.InstallError, "reviewer target became unsafe"
                ):
                    installer._run(args)

            self.assertEqual(
                "late-user-owned\n", foreign_agent.read_text(encoding="utf-8")
            )
            self.assertFalse((self.home / ".claude/settings.json").exists())
            self.assertFalse((self.home / ".claude/hooks").exists())
        finally:
            installer.TARGETS = original_targets

    def test_force_replaces_foreign_skill_without_subagents(self):
        skills_dir = self.home / ".claude/skills"
        skills_dir.mkdir(parents=True)
        foreign_link = skills_dir / "skill-authoring"
        foreign_link.write_text("replace-with-force\n", encoding="utf-8")

        self.run_install(
            "--targets",
            "claude",
            "--skills",
            "skill-authoring",
            "--force",
        )
        self.assertTrue(foreign_link.is_symlink())
        self.assertEqual(
            (REPO / "skills/common/skill-authoring").resolve(),
            foreign_link.resolve(),
        )

    def test_modified_copy_is_not_deleted_on_uninstall(self):
        args = (
            "--targets",
            "claude",
            "--skills",
            "skill-authoring",
            "--copy",
        )
        self.run_install(*args)
        copied = self.home / ".claude/skills/skill-authoring"
        marker = copied / "user-note.txt"
        marker.write_text("keep me\n", encoding="utf-8")

        self.run_install(
            "--targets",
            "claude",
            "--skills",
            "skill-authoring",
            "--uninstall",
        )
        self.assertTrue(copied.is_dir())
        self.assertEqual("keep me\n", marker.read_text(encoding="utf-8"))

    def test_uninstall_does_not_add_empty_subagent_stop(self):
        config = self.write_json(
            ".claude/settings.json",
            {"custom": {"keep": True}, "hooks": {"Stop": [{"hooks": []}]}},
        )
        before = config.read_bytes()

        self.run_install(
            "--targets",
            "claude",
            "--skills",
            "skill-authoring",
            "--with-subagents",
            "--uninstall",
        )

        self.assertEqual(before, config.read_bytes())

    def test_owned_unmodified_copy_updates_without_force(self):
        source = self.home / "source"
        target = self.home / "target"
        source.mkdir()
        (source / "value.txt").write_text("v1\n", encoding="utf-8")
        manifest = installer._new_manifest()

        self.assertEqual(
            "copied",
            installer.install(
                "owned", source, target, copy=True, force=False, manifest=manifest
            ),
        )
        (source / "value.txt").write_text("v2\n", encoding="utf-8")
        self.assertEqual(
            "copied",
            installer.install(
                "owned", source, target, copy=True, force=False, manifest=manifest
            ),
        )
        self.assertEqual(
            "v2\n", (target / "owned/value.txt").read_text(encoding="utf-8")
        )

    def test_atomic_json_write_rejects_concurrent_change(self):
        path = self.write_json(".claude/settings.json", {"before": True})
        revision = installer._file_revision(path)
        path.write_text('{"concurrent": true}\n', encoding="utf-8")

        with self.assertRaises(installer.InstallError):
            installer._write_json_if_needed(
                path,
                {"before": True},
                {"after": True},
                dry_run=False,
                expected_revision=revision,
            )
        self.assertEqual(
            {"concurrent": True}, json.loads(path.read_text(encoding="utf-8"))
        )

    def test_copy_race_keeps_ownership_for_safe_uninstall(self):
        original_targets = installer.TARGETS
        installer.TARGETS = {
            "claude": self.home / ".claude/skills",
            "codex": self.home / ".codex/skills",
        }
        args = argparse.Namespace(
            groups=None,
            skills="skill-authoring",
            targets="claude",
            copy=True,
            force=False,
            with_subagents=True,
            with_global=False,
            dry_run=False,
            list=False,
            uninstall=False,
        )
        original_write = installer._write_json_if_needed

        def race_config(path, before, after, **kwargs):
            if path.name == "settings.json" and not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('{"concurrent": true}\n', encoding="utf-8")
            return original_write(path, before, after, **kwargs)

        try:
            with mock.patch.object(
                installer, "_write_json_if_needed", side_effect=race_config
            ), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(installer.InstallError):
                    installer._run(args)

            self.assertTrue(
                (self.home / ".claude/skills/skill-authoring").is_dir()
            )
            manifest_path = self.home / ".claude/.agent-tools-install.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertIn(
                str(self.home / ".claude/skills/skill-authoring"),
                manifest["pending_copies"],
            )

            args.copy = False
            args.uninstall = True
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(0, installer._run(args))
            self.assertFalse(
                (self.home / ".claude/skills/skill-authoring").exists()
            )
            self.assertEqual(
                {"concurrent": True},
                json.loads(
                    (self.home / ".claude/settings.json").read_text(
                        encoding="utf-8"
                    )
                ),
            )
        finally:
            installer.TARGETS = original_targets

    def test_symlink_managed_hook_config_is_preserved_and_rejected(self):
        managed = self.write_json("dotfiles/claude-settings.json", {"keep": True})
        config = self.home / ".claude/settings.json"
        config.parent.mkdir(parents=True)
        config.symlink_to(managed)

        result = self.run_install(
            "--targets",
            "claude",
            "--skills",
            "skill-authoring",
            "--with-subagents",
            check=False,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertTrue(config.is_symlink())
        self.assertEqual({"keep": True}, json.loads(managed.read_text()))
        self.assertFalse((self.home / ".claude/skills").exists())
        self.assertFalse((self.home / ".claude/agents").exists())

    def test_stale_owned_link_and_copy_are_cleaned(self):
        original_targets = installer.TARGETS
        installer.TARGETS = {
            "claude": self.home / ".claude/skills",
            "codex": self.home / ".codex/skills",
        }
        root = self.home / ".claude"
        skills = root / "skills"
        agents = root / "agents"
        skills.mkdir(parents=True)
        agents.mkdir(parents=True)
        missing_link_source = REPO / "skills/common/deleted-test-skill"
        missing_copy_source = REPO / "agents/claude/deleted-reviewer.md"
        stale_link = skills / "deleted-test-skill"
        stale_link.symlink_to(missing_link_source)
        stale_copy = agents / "deleted-reviewer.md"
        stale_copy.write_text("old reviewer\n", encoding="utf-8")
        manifest = installer._new_manifest()
        manifest["links"][str(stale_link)] = str(missing_link_source)
        manifest["copies"][str(stale_copy)] = {
            "source": str(missing_copy_source),
            "fingerprint": installer._fingerprint(stale_copy),
        }
        manifest_path = root / installer.MANIFEST_NAME
        installer._atomic_write(manifest_path, installer._json_bytes(manifest))
        state = {
            "root": root,
            "manifest_path": manifest_path,
            "manifest_revision": installer._file_revision(manifest_path),
            "manifest_before": json.loads(manifest_path.read_text()),
            "manifest": manifest,
        }

        try:
            with contextlib.redirect_stdout(io.StringIO()):
                installer._cleanup_stale_ownership(
                    "claude", state, dry_run=False
                )
            self.assertFalse(stale_link.is_symlink())
            self.assertFalse(stale_copy.exists())
            self.assertFalse(manifest_path.exists())
        finally:
            installer.TARGETS = original_targets

    def test_full_copy_upgrade_updates_and_remains_uninstallable(self):
        original_repo = installer.REPO
        original_targets = installer.TARGETS
        fake_repo = self.home / "repo"
        skill = fake_repo / "skills/common/demo"
        skill.mkdir(parents=True)
        source_file = skill / "SKILL.md"
        source_file.write_text("v1\n", encoding="utf-8")
        installer.REPO = fake_repo
        installer.TARGETS = {
            "claude": self.home / ".claude/skills",
            "codex": self.home / ".codex/skills",
        }
        args = argparse.Namespace(
            groups=None,
            skills="demo",
            targets="claude",
            copy=True,
            force=False,
            with_subagents=False,
            with_global=False,
            dry_run=False,
            list=False,
            uninstall=False,
        )

        try:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(0, installer._run(args))
            installed = self.home / ".claude/skills/demo/SKILL.md"
            self.assertEqual("v1\n", installed.read_text(encoding="utf-8"))

            source_file.write_text("v2\n", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(0, installer._run(args))
            self.assertEqual("v2\n", installed.read_text(encoding="utf-8"))

            args.copy = False
            args.uninstall = True
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(0, installer._run(args))
            self.assertFalse(installed.parent.exists())
        finally:
            installer.REPO = original_repo
            installer.TARGETS = original_targets

    def test_interrupted_copy_upgrade_promotes_pending_before_next_upgrade(self):
        original_repo = installer.REPO
        original_targets = installer.TARGETS
        fake_repo = self.home / "repo"
        skill = fake_repo / "skills/common/demo"
        skill.mkdir(parents=True)
        source_file = skill / "SKILL.md"
        source_file.write_text("v1\n", encoding="utf-8")
        installer.REPO = fake_repo
        installer.TARGETS = {
            "claude": self.home / ".claude/skills",
            "codex": self.home / ".codex/skills",
        }
        args = argparse.Namespace(
            groups=None,
            skills="demo",
            targets="claude",
            copy=True,
            force=False,
            with_subagents=False,
            with_global=False,
            dry_run=False,
            list=False,
            uninstall=False,
        )

        try:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(0, installer._run(args))

            source_file.write_text("v2\n", encoding="utf-8")
            original_save = installer._save_manifest
            save_count = 0

            def fail_after_copy(*save_args, **save_kwargs):
                nonlocal save_count
                save_count += 1
                if save_count == 2:
                    raise installer.InstallError("simulated post-copy failure")
                return original_save(*save_args, **save_kwargs)

            with mock.patch.object(
                installer, "_save_manifest", side_effect=fail_after_copy
            ), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(installer.InstallError):
                    installer._run(args)

            installed = self.home / ".claude/skills/demo/SKILL.md"
            self.assertEqual("v2\n", installed.read_text(encoding="utf-8"))

            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(0, installer._run(args))
            manifest_path = self.home / ".claude/.agent-tools-install.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            destination = str(installed.parent)
            self.assertIn(destination, manifest["copies"])
            self.assertNotIn(destination, manifest["pending_copies"])

            source_file.write_text("v3\n", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(0, installer._run(args))
            self.assertEqual("v3\n", installed.read_text(encoding="utf-8"))

            args.copy = False
            args.uninstall = True
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(0, installer._run(args))
            self.assertFalse(installed.parent.exists())
        finally:
            installer.REPO = original_repo
            installer.TARGETS = original_targets


if __name__ == "__main__":
    unittest.main()
