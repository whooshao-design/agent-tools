"""lib/agent_tools/locate.py 与 bootstrap.py 模板副本的用例表测试（python3 -m unittest tests.test_locate）。"""
from __future__ import annotations

import importlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
LIB = REPO / "lib"
CASES = json.loads((LIB / "agent_tools" / "locate.cases.json").read_text(encoding="utf-8"))["cases"]
IS_ROOT = hasattr(os, "geteuid") and os.geteuid() == 0

sys.path.insert(0, str(LIB))
from agent_tools import locate  # noqa: E402


def substitute(value, tree: str):
    return value.replace("${TREE}", tree) if isinstance(value, str) else value


class _Tree:
    def __init__(self, case: dict):
        self.case = case
        self.root = Path(tempfile.mkdtemp(prefix="locate-case-")).resolve()
        self.modes: list[tuple[Path, int]] = []
        for relative, spec in case["tree"].items():
            target = self.root / relative
            if isinstance(spec, str):
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(spec, encoding="utf-8")
            else:
                target.mkdir(parents=True, exist_ok=True)
                if "mode" in spec:
                    self.modes.append((target, int(spec["mode"], 8)))
        self.home = self.root / "home"
        self.home.mkdir(parents=True, exist_ok=True)
        self.pointer = self.home / ".config/agent-tools/root"
        if case["pointer"] is not None:
            self.pointer.parent.mkdir(parents=True, exist_ok=True)
            self.pointer.write_text(substitute(case["pointer"], str(self.root)) + "\n", encoding="utf-8")
        for target, mode in self.modes:
            target.chmod(mode)

    def env(self) -> dict[str, str]:
        return {key: substitute(value, str(self.root)) for key, value in self.case["env"].items()}

    def cleanup(self) -> None:
        for target, _ in self.modes:
            target.chmod(0o700)
        subprocess.run(["rm", "-rf", str(self.root)], check=False)


class LocateCasesTest(unittest.TestCase):
    def _check_tried(self, tried: str, case: dict, tree: str) -> None:
        for needle in case["expect"].get("tried_contains", []):
            self.assertIn(substitute(needle, tree), tried)

    def test_repo_root_cases(self):
        for case in CASES:
            with self.subTest(case=case["name"]):
                if case.get("requires_non_root") and IS_ROOT:
                    self.skipTest("以 root 运行时权限用例不成立")
                tree = _Tree(case)
                saved = os.environ.pop("AGENT_TOOLS_ROOT", None)
                try:
                    os.environ.update(tree.env())
                    start = tree.root / case["start"]
                    if "root" in case["expect"]:
                        root = locate.repo_root(start, tree.pointer)
                        self.assertEqual(Path(root).resolve(), tree.root / case["expect"]["root"])
                        if case["expect"].get("tried_contains"):
                            self._check_tried(self._failing_tried(start, tree), case, str(tree.root))
                    else:
                        with self.assertRaises(locate.AgentToolsLocateError) as raised:
                            locate.repo_root(start, tree.pointer)
                        self.assertEqual(raised.exception.code, case["expect"]["error"])
                        self._check_tried("\n".join(raised.exception.tried), case, str(tree.root))
                finally:
                    for key in tree.env():
                        os.environ.pop(key, None)
                    if saved is not None:
                        os.environ["AGENT_TOOLS_ROOT"] = saved
                    tree.cleanup()

    def _failing_tried(self, start: Path, tree: _Tree) -> str:
        """成功用例也要检验 tried 文字：去掉指针文件再跑，仍命中（env 有效）就再去掉 env，直到失败后取 tried。"""
        missing_pointer = tree.root / "no-pointer-here"
        try:
            locate.repo_root(start, missing_pointer)
        except locate.AgentToolsLocateError as error:
            return "\n".join(error.tried)
        os.environ.pop("AGENT_TOOLS_ROOT", None)
        with self.assertRaises(locate.AgentToolsLocateError) as raised:
            locate.repo_root(start, missing_pointer)
        return "\n".join(raised.exception.tried)

    def test_bootstrap_py_template_cases(self):
        template = (LIB / "agent_tools" / "bootstrap.py").read_text(encoding="utf-8")
        for case in CASES:
            with self.subTest(case=case["name"]):
                if case.get("requires_non_root") and IS_ROOT:
                    self.skipTest("以 root 运行时权限用例不成立")
                tree = _Tree(case)
                try:
                    script = tree.root / case["start"] / "probe.py"
                    script.write_text(template + "\nprint(_root)\n", encoding="utf-8")
                    env = {k: v for k, v in os.environ.items() if k != "AGENT_TOOLS_ROOT"}
                    env["HOME"] = str(tree.home)
                    env.update(tree.env())
                    completed = subprocess.run([sys.executable, "-I", str(script)], env=env, capture_output=True, text=True)
                    if "root" in case["expect"]:
                        self.assertEqual(completed.returncode, 0, completed.stderr)
                        self.assertEqual(Path(completed.stdout.strip()).resolve(), tree.root / case["expect"]["root"])
                        if case["expect"].get("tried_contains"):
                            # 同一脚本在没有指针文件（必要时再去掉 env）的 HOME 下必须失败，失败输出含期望文字
                            failing = dict(env, HOME=str(tree.root / "empty-home"))
                            (tree.root / "empty-home").mkdir(exist_ok=True)
                            run = subprocess.run([sys.executable, "-I", str(script)], env=failing, capture_output=True, text=True)
                            if run.returncode == 0:
                                failing.pop("AGENT_TOOLS_ROOT", None)
                                run = subprocess.run([sys.executable, "-I", str(script)], env=failing, capture_output=True, text=True)
                            self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
                            self._check_tried(run.stderr, case, str(tree.root))
                    else:
                        self.assertEqual(completed.returncode, 2, completed.stdout + completed.stderr)
                        self._check_tried(completed.stderr, case, str(tree.root))
                        self.assertIn("请在仓库目录运行 python3 install.py", completed.stderr)
                finally:
                    tree.cleanup()


class LocateFunctionsTest(unittest.TestCase):
    def test_probe_states(self):
        self.assertEqual(locate.probe(""), "miss")
        self.assertEqual(locate.probe(str(REPO)), "hit")
        self.assertEqual(locate.probe(str(REPO / "nope")), "miss")
        self.assertEqual(locate.probe(str(REPO / "install.py")), "miss")  # ENOTDIR

    def test_skill_dir_resolves_category(self):
        self.assertEqual(locate.skill_dir("get-browser-session"), str(REPO / "skills/lexin/get-browser-session"))
        self.assertEqual(
            locate.skill_dir("dev-design-solution", "scripts", "check_mermaid.js"),
            str(REPO / "skills/dev-workflow/dev-design-solution/scripts/check_mermaid.js"),
        )
        with self.assertRaises(locate.AgentToolsLocateError) as raised:
            locate.skill_dir("no-such-skill-xyz")
        self.assertEqual(raised.exception.code, "SKILL_NOT_FOUND")

    def test_docs_root_defaults_and_invalid_values(self):
        saved = os.environ.pop("AGENT_TOOLS_DOCS_ROOT", None)
        try:
            self.assertEqual(locate.docs_root(), str(Path.home() / "docs"))
            os.environ["AGENT_TOOLS_DOCS_ROOT"] = "~/docs"
            self.assertEqual(locate.docs_root(), str(Path.home() / "docs"))
            os.environ["AGENT_TOOLS_DOCS_ROOT"] = "/srv/docs"
            self.assertEqual(locate.docs_root(), "/srv/docs")
        finally:
            os.environ.pop("AGENT_TOOLS_DOCS_ROOT", None)
            if saved is not None:
                os.environ["AGENT_TOOLS_DOCS_ROOT"] = saved

    def test_platform_value(self):
        self.assertIn(locate.platform(), ("darwin", "wsl", "linux"))

    def test_open_external_custom_template(self):
        saved = os.environ.get("AGENT_TOOLS_OPEN_CMD")
        try:
            os.environ["AGENT_TOOLS_OPEN_CMD"] = "/bin/sh -c true {target}"
            self.assertTrue(locate.open_external("https://example.invalid"))
            os.environ["AGENT_TOOLS_OPEN_CMD"] = "/bin/sh -c false {target}"
            self.assertFalse(locate.open_external("https://example.invalid"))
        finally:
            if saved is None:
                os.environ.pop("AGENT_TOOLS_OPEN_CMD", None)
            else:
                os.environ["AGENT_TOOLS_OPEN_CMD"] = saved

    def test_render_placeholders(self):
        values = {"AGENT_TOOLS_ROOT": "/r", "AGENT_TOOLS_DOCS_ROOT": "/d"}
        self.assertEqual(locate.render_placeholders("a {{AGENT_TOOLS_ROOT}}/install.py {{AGENT_TOOLS_DOCS_ROOT}}", values), "a /r/install.py /d")
        with self.assertRaises(ValueError):
            locate.render_placeholders("{{AGENT_TOOLS_WORKSPACE_ROOT}}", values)
        self.assertEqual(locate.render_placeholders("no placeholders", {}), "no placeholders")

    def test_regular_package_wins_over_later_namespace_candidate(self):
        """sys.path 后面放一个同名常规包 agent_tools，导入的仍是本仓库 lib/agent_tools/locate.py。"""
        with tempfile.TemporaryDirectory() as shadow:
            pkg = Path(shadow) / "agent_tools"
            pkg.mkdir()
            (pkg / "__init__.py").write_text("", encoding="utf-8")
            (pkg / "locate.py").write_text("SHADOW = True\n", encoding="utf-8")
            code = (
                "import sys; sys.path.insert(0, %r); sys.path.append(%r);"
                "from agent_tools import locate; print(locate.__file__)" % (str(LIB), shadow)
            )
            completed = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True, check=True)
            self.assertEqual(Path(completed.stdout.strip()).resolve(), LIB / "agent_tools" / "locate.py")


if __name__ == "__main__":
    unittest.main()
