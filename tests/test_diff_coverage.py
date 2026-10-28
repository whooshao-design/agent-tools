import importlib.util
import io
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    'diff_coverage', ROOT / 'skills/dev-quality/verify-java-coverage/scripts/diff_coverage.py')
diff_coverage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diff_coverage)

REPORT = """<?xml version="1.0"?><report name="r"><package name="com/x">
<sourcefile name="A.java"><line nr="3" mi="0" ci="2"/><line nr="4" mi="1" ci="0"/><line nr="5" mi="0" ci="1"/></sourcefile>
</package></report>"""


class DiffCoverageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        run = lambda *a: subprocess.run(['git', '-C', str(self.repo), *a], check=True, capture_output=True)
        run('init', '-q')
        run('config', 'user.email', 't@t')
        run('config', 'user.name', 't')
        src = self.repo / 'm/src/main/java/com/x'
        src.mkdir(parents=True)
        (src / 'A.java').write_text('a\nb\n')
        run('add', '.')
        run('commit', '-qm', 'base')
        run('branch', 'base')
        (src / 'A.java').write_text('a\nb\nc\nd\ne\n')
        self.report = self.repo / 'r.xml'
        self.report.write_text(REPORT)

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, *extra):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = diff_coverage.main(['--base', 'base', '--report', str(self.report), '--repo', str(self.repo), *extra])
        return code, out.getvalue()

    def test_counts_only_changed_executable_lines(self):
        code, out = self.call()
        self.assertEqual(code, 0)
        self.assertIn('2/3 com/x/A.java miss=[4]', out)
        self.assertIn('TOTAL 2/3 = 66.7%', out)

    def test_threshold_fails_below_ninety(self):
        code, _ = self.call('--threshold', '90')
        self.assertEqual(code, 1)

    def test_changed_file_missing_from_report_is_not_treated_as_covered(self):
        self.report.write_text('<report name="r"></report>')
        code, out = self.call('--threshold', '90')
        self.assertEqual(code, 2)
        self.assertIn('NO_DATA', out)


if __name__ == '__main__':
    unittest.main()
