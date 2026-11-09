import importlib.util
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).parents[1] / "scripts" / "install_timer.py"
SPEC = importlib.util.spec_from_file_location("install_timer", SCRIPT)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class InstallTimerTest(unittest.TestCase):
    def test_units_run_weekly_and_carry_proxy_env(self):
        service, timer = mod.build_unit_contents(
            schedule="Fri *-*-* 13:40:00", run_script=Path("/x/run.sh"),
            env={"HTTPS_PROXY": "http://127.0.0.1:18180", "UNRELATED": "no"}, root="/r", docs_root="/d")
        self.assertIn("OnCalendar=Fri *-*-* 13:40:00", timer)
        self.assertIn('Environment="AGENT_TOOLS_ROOT=/r"', service)
        self.assertIn('Environment="AGENT_TOOLS_DOCS_ROOT=/d"', service)
        self.assertIn("Persistent=true", timer)
        self.assertIn('Environment="HTTPS_PROXY=http://127.0.0.1:18180"', service)
        self.assertNotIn("UNRELATED", service)
        self.assertIn('ExecStart=/bin/bash "/x/run.sh"', service)
        self.assertIn("TimeoutStartSec=30min", service)

    def test_defaults_come_from_bootstrap_root_and_locate_docs_root(self):
        service, _ = mod.build_unit_contents(schedule="Fri *-*-* 13:40:00", run_script=Path("/x/run.sh"), env={})
        self.assertIn(f'Environment="AGENT_TOOLS_ROOT={Path(__file__).parents[4]}"', service)
        self.assertIn(f'Environment="AGENT_TOOLS_DOCS_ROOT={mod.locate.docs_root()}"', service)

    def test_non_systemd_platform_exits_2_with_manual_steps(self):
        with mock.patch.object(mod.locate, "platform", return_value="darwin"), mock.patch("sys.stderr") as err:
            with self.assertRaises(SystemExit) as raised:
                mod.install("Fri *-*-* 13:40:00", dry_run=True)
        self.assertEqual(raised.exception.code, 2)
        text = "".join(call.args[0] for call in err.write.call_args_list)
        self.assertIn("生成本周 OKR 周报", text)
        self.assertIn("不在 macOS 运行", text)

    def test_schedule_cannot_inject_lines(self):
        with self.assertRaises(ValueError):
            mod.build_unit_contents(schedule="Fri 13:40\nExecStart=evil", run_script=Path("/x"), env={})


if __name__ == "__main__":
    unittest.main()
