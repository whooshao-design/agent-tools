import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "skills/dev-workflow/dev-build-change/scripts/check_javadoc.py"


def git(repo, *args):
    subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True)


class CheckJavadocTest(unittest.TestCase):

    def run_check(self, before, after):
        with tempfile.TemporaryDirectory() as repo:
            git(repo, "init", "-q")
            git(repo, "config", "user.email", "t@t")
            git(repo, "config", "user.name", "t")
            path = Path(repo, "src/main/java/A.java")
            path.parent.mkdir(parents=True)
            path.write_text(textwrap.dedent(before), encoding="utf-8")
            git(repo, "add", ".")
            git(repo, "commit", "-qm", "base")
            path.write_text(textwrap.dedent(after), encoding="utf-8")
            out = subprocess.run([sys.executable, str(SCRIPT), "--repo", repo, "--base", "HEAD"],
                                 capture_output=True, text=True)
            return out.returncode, out.stdout

    BASE = """\
        public class A {
            public int old(int x) {
                return x;
            }
        }
        """

    def test_reports_only_new_undocumented_declarations(self):
        code, out = self.run_check(self.BASE, """\
            public class A {
                private int count;

                public int old(int x) {
                    int local = x;
                    return local;
                }

                /**
                 * Adds.
                 *
                 * @param a first
                 */
                public int add(int a, java.util.Map<String, Integer> b) {
                    return a;
                }
            }
            """)
        self.assertEqual(code, 1)
        self.assertIn("字段 count 缺少 JavaDoc", out)
        self.assertIn("add() 缺少 @param b", out)
        self.assertIn("add() 缺少 @return", out)
        self.assertNotIn("old()", out)
        self.assertNotIn("local", out)

    def test_clean_when_documented_or_exempt(self):
        code, out = self.run_check(self.BASE, """\
            public class A {
                private static final long serialVersionUID = 1L;

                private Integer ruleId;

                /*
                 * JSON keys
                 */

                private static final String TREE = "tree";

                private static final String CHILDREN = "children";

                public int old(int x) {
                    return x;
                }

                public Integer getRuleId() {
                    return ruleId;
                }

                /**
                 * Adds.
                 *
                 * @param a first
                 * @return sum
                 */
                public int add(int a) {
                    return a;
                }

                @Override
                public String toString() {
                    return "";
                }
            }
            """)
        self.assertEqual(code, 0, out)


if __name__ == "__main__":
    unittest.main()
