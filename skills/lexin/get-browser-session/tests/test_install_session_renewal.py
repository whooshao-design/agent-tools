import argparse
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "install_session_renewal.py"
SPEC = importlib.util.spec_from_file_location("install_session_renewal", SCRIPT)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class SessionRenewalInstallerTest(unittest.TestCase):
    def test_build_unit_contents_uses_headless_renewal_and_daily_timer(self):
        service, timer = installer.build_unit_contents(
            browser_script=Path("/opt/agent tools/browser_session.js"),
            targets=[{
                "url": "https://lexiao.oa.fenqile.com/#/home?ratio=100%",
                "profile": Path("/home/test/.cache/browser profile"),
                "success_text": "当前环境",
            }],
            schedule="*-*-* 11:00:00",
        )

        self.assertIn('ExecStart=-"/usr/bin/node" "/opt/agent tools/browser_session.js" "--renew"', service)
        self.assertIn('"--url=https://lexiao.oa.fenqile.com/#/home?ratio=100%%"', service)
        self.assertIn('"--profile=/home/test/.cache/browser profile"', service)
        self.assertIn('"--success-text=当前环境"', service)
        self.assertIn("TimeoutStartSec=5min", service)
        self.assertIn("OnCalendar=*-*-* 11:00:00", timer)
        self.assertIn("OnBootSec=5m", timer)
        self.assertIn("RandomizedDelaySec=5m", timer)
        # WSL is frequently shut down; a missed 11:00 run must be caught up on next boot.
        self.assertIn("Persistent=true", timer)
        self.assertNotIn("OnUnitActiveSec", timer)

    def test_build_unit_contents_emits_one_skippable_exec_line_per_target(self):
        service, _ = installer.build_unit_contents(
            browser_script=Path("/opt/browser_session.js"),
            targets=installer.default_targets(),
            schedule="*-*-* 11:00:00",
        )

        exec_lines = [line for line in service.splitlines() if line.startswith("ExecStart=")]
        self.assertEqual(len(exec_lines), 4)
        # "-" keeps a failing target from aborting the remaining ones.
        self.assertTrue(all(line.startswith("ExecStart=-") for line in exec_lines))
        # The SSO endpoint must run before the business pages that cannot re-sign tickets.
        self.assertIn("passport.lexincloud.com", exec_lines[0])
        self.assertIn(str(installer.HEALTHY_PROFILE), exec_lines[1])
        self.assertIn("--export-session=", exec_lines[3])

    def test_build_unit_contents_rejects_an_empty_target_list(self):
        with self.assertRaisesRegex(ValueError, "at least one renewal target"):
            installer.build_unit_contents(
                browser_script=Path("/opt/browser_session.js"),
                targets=[],
                schedule="*-*-* 11:00:00",
            )

    def test_default_targets_lead_with_the_sso_endpoint_for_every_profile(self):
        targets = installer.default_targets()
        sso = [t for t in targets if t["url"] == "https://passport.lexincloud.com/"]

        self.assertEqual({t["profile"] for t in sso}, {installer.MAIN_PROFILE, installer.HEALTHY_PROFILE})
        self.assertNotIn("/tmp", str(installer.HEALTHY_PROFILE))
        self.assertEqual([t for t in targets if t.get("export")][0]["export"], installer.SESSION_SNAPSHOT)

    def test_validate_config_rejects_insecure_url(self):
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            installer.validate_config("http://lexiao.oa.fenqile.com/")
        installer.validate_config("https://lexiao.oa.fenqile.com/")

    def test_validate_schedule_rejects_empty_and_multiline_expressions(self):
        with self.assertRaisesRegex(ValueError, "must not be empty"):
            installer.validate_schedule("  ")
        # A newline would let extra directives be injected into the timer unit.
        with self.assertRaisesRegex(ValueError, "single line"):
            installer.validate_schedule("*-*-* 11:00:00\nExecStart=/bin/sh")
        installer.validate_schedule("*-*-* 11:00:00")

    def test_write_and_remove_units_only_touch_named_user_units(self):
        with tempfile.TemporaryDirectory() as directory:
            unit_dir = Path(directory)
            paths = installer.write_units(unit_dir, "service-content\n", "timer-content\n")

            self.assertEqual(paths["service"].read_text(), "service-content\n")
            self.assertEqual(paths["timer"].read_text(), "timer-content\n")
            (unit_dir / "unrelated.service").write_text("keep\n")

            removed = installer.remove_units(unit_dir)

            self.assertEqual(set(removed), {paths["service"], paths["timer"]})
            self.assertTrue((unit_dir / "unrelated.service").exists())

    def test_install_writes_units_enables_timer_and_runs_initial_renewal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / "browser_session.js"
            script.write_text("// browser\n")
            unit_dir = root / "units"
            args = argparse.Namespace(
                schedule="*-*-* 11:00:00",
                browser_script=str(script),
            )
            with patch.object(installer, "default_unit_dir", return_value=unit_dir), \
                    patch.object(installer, "run_systemctl") as run_systemctl:
                result = installer.install(args)

            self.assertEqual(result["action"], "installed")
            self.assertTrue((unit_dir / installer.SERVICE_NAME).exists())
            self.assertTrue((unit_dir / installer.TIMER_NAME).exists())
            self.assertEqual(run_systemctl.call_args_list, [
                call("daemon-reload"),
                call("enable", "--now", installer.TIMER_NAME),
                call("start", installer.SERVICE_NAME),
            ])

    def test_install_rejects_missing_browser_script_before_writing_units(self):
        args = argparse.Namespace(
            schedule="*-*-* 11:00:00",
            browser_script="/tmp/browser-session-script-that-does-not-exist.js",
        )
        with self.assertRaisesRegex(FileNotFoundError, "script not found"):
            installer.install(args)

    def test_uninstall_disables_timer_and_removes_only_renewal_units(self):
        with tempfile.TemporaryDirectory() as directory:
            unit_dir = Path(directory)
            installer.write_units(unit_dir, "service\n", "timer\n")
            with patch.object(installer, "default_unit_dir", return_value=unit_dir), \
                    patch.object(installer, "run_systemctl") as run_systemctl:
                result = installer.uninstall()

            self.assertEqual(result["action"], "uninstalled")
            self.assertEqual(run_systemctl.call_args_list, [
                call("disable", "--now", installer.TIMER_NAME, check=False),
                call("daemon-reload"),
                call("reset-failed", installer.SERVICE_NAME, check=False),
            ])
            self.assertFalse((unit_dir / installer.SERVICE_NAME).exists())
            self.assertFalse((unit_dir / installer.TIMER_NAME).exists())

    def test_run_systemctl_uses_the_user_manager(self):
        with patch.object(installer.subprocess, "run") as run:
            installer.run_systemctl("daemon-reload")

        run.assert_called_once_with(
            ["systemctl", "--user", "daemon-reload"],
            check=True,
            text=True,
            capture_output=True,
        )

    def test_default_unit_dir_honors_xdg_config_home(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"XDG_CONFIG_HOME": directory}):
            self.assertEqual(
                installer.default_unit_dir(),
                Path(directory) / "systemd" / "user",
            )

    def test_parse_args_and_main_route_install_or_uninstall(self):
        with patch.object(sys, "argv", ["installer", "--schedule", "*-*-* 09:00:00"]):
            args = installer.parse_args()
        self.assertEqual(args.schedule, "*-*-* 09:00:00")
        self.assertFalse(args.uninstall)

        installed = {"action": "installed"}
        with patch.object(installer, "parse_args", return_value=args), \
                patch.object(installer, "install", return_value=installed) as install, \
                patch("builtins.print") as output:
            installer.main()
        install.assert_called_once_with(args)
        self.assertIn('"installed"', output.call_args.args[0])

        args.uninstall = True
        with patch.object(installer, "parse_args", return_value=args), \
                patch.object(installer, "uninstall", return_value={"action": "uninstalled"}) as uninstall, \
                patch("builtins.print"):
            installer.main()
        uninstall.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
