import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "install_timer.py"
SPEC = importlib.util.spec_from_file_location("install_timer", SCRIPT)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class InstallTimerTest(unittest.TestCase):
    def test_units_run_weekly_and_carry_proxy_env(self):
        service, timer = mod.build_unit_contents(
            schedule="Fri *-*-* 13:40:00", run_script=Path("/x/run.sh"),
            env={"HTTPS_PROXY": "http://127.0.0.1:18180", "UNRELATED": "no"})
        self.assertIn("OnCalendar=Fri *-*-* 13:40:00", timer)
        self.assertIn("Persistent=true", timer)
        self.assertIn('Environment="HTTPS_PROXY=http://127.0.0.1:18180"', service)
        self.assertNotIn("UNRELATED", service)
        self.assertIn('ExecStart=/bin/bash "/x/run.sh"', service)
        self.assertIn("TimeoutStartSec=30min", service)

    def test_schedule_cannot_inject_lines(self):
        with self.assertRaises(ValueError):
            mod.build_unit_contents(schedule="Fri 13:40\nExecStart=evil", run_script=Path("/x"), env={})


if __name__ == "__main__":
    unittest.main()
