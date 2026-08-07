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
    def test_build_unit_contents_uses_headless_renewal_and_six_hour_timer(self):
        service, timer = installer.build_unit_contents(
            browser_script=Path("/opt/agent tools/browser_session.js"),
            url="https://lexiao.oa.fenqile.com/#/home?ratio=100%",
            profile=Path("/home/test/.cache/browser profile"),
            success_text="当前环境",
            interval_hours=6,
        )

        self.assertIn('ExecStart="/usr/bin/node" "/opt/agent tools/browser_session.js" "--renew"', service)
        self.assertIn('"--url=https://lexiao.oa.fenqile.com/#/home?ratio=100%%"', service)
        self.assertIn('"--profile=/home/test/.cache/browser profile"', service)
        self.assertIn('"--success-text=当前环境"', service)
        self.assertIn("TimeoutStartSec=5min", service)
        self.assertIn("OnBootSec=5m", timer)
        self.assertIn("OnUnitActiveSec=6h", timer)
        self.assertIn("RandomizedDelaySec=10m", timer)
        self.assertNotIn("Persistent=true", timer)

    def test_validate_config_rejects_insecure_url_and_out_of_range_interval(self):
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            installer.validate_config("http://lexiao.oa.fenqile.com/", 6)
        with self.assertRaisesRegex(ValueError, "between 1 and 168"):
            installer.validate_config("https://lexiao.oa.fenqile.com/", 0)
        with self.assertRaisesRegex(ValueError, "between 1 and 168"):
            installer.validate_config("https://lexiao.oa.fenqile.com/", 169)

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
                url="https://lexiao.oa.fenqile.com/",
                profile=str(root / "profile"),
                success_text="当前环境",
                interval_hours=6,
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
            url="https://lexiao.oa.fenqile.com/",
            profile="/tmp/profile",
            success_text="当前环境",
            interval_hours=6,
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
        with patch.object(sys, "argv", ["installer", "--interval-hours", "12"]):
            args = installer.parse_args()
        self.assertEqual(args.interval_hours, 12)
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
