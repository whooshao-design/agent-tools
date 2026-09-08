"""Offline checks for the shared defaults and the actual Dubbo CLI forwarding."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


LEXIN = Path(__file__).resolve().parents[2]
REPO = LEXIN.parents[1]
BROWSER = LEXIN / "get-browser-session/scripts/browser_session.js"
DUBBO = LEXIN / "test-dubbo-api/scripts"
STATE = Path.home() / ".local/state/agent-tools"
PROFILE_ENV = ("BROWSER_SESSION_PROFILE", "DEVTOOLS_BROWSER_PROFILE", "JAVA_BACKEND_BROWSER_PROFILE")


def clean_env(**values):
    env = {key: value for key, value in os.environ.items() if key not in PROFILE_ENV}
    env.update(values)
    return env


def load_installer():
    spec = importlib.util.spec_from_file_location("renewal_paths", BROWSER.with_name("install_session_renewal.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BrowserProfilePathsTest(unittest.TestCase):
    def browser_profile(self, env, args=None, url="https://example.invalid/"):
        code = "console.log(require(process.argv[1]).resolvePaths(JSON.parse(process.argv[2]), process.argv[3]).profileDir)"
        return subprocess.check_output(
            ["node", "-e", code, str(BROWSER), json.dumps(args or {}), url], env=env, text=True,
        ).strip()

    def python_defaults(self, env):
        code = (
            "import json,sys;sys.path.insert(0,sys.argv[1]);sys.path.insert(0,sys.argv[2]);"
            "import dubbo_request,dubbo_scenario;from devtools_mcp.common import DEFAULT_BROWSER_PROFILE;"
            "print(json.dumps([dubbo_request.DEFAULT_PROFILE,dubbo_scenario.DEFAULT_PROFILE,DEFAULT_BROWSER_PROFILE]))"
        )
        return json.loads(subprocess.check_output(
            [sys.executable, "-B", "-c", code, str(DUBBO), str(REPO / "mcp/devtools-mcp")], env=env, text=True,
        ))

    def test_python_mcp_and_node_share_default_main_profile(self):
        expected = str(STATE / "browser-profiles/main")
        self.assertEqual(self.python_defaults(clean_env()), [expected] * 3)
        self.assertEqual(self.browser_profile(clean_env()), expected)

    def test_shared_environment_precedence(self):
        for overrides, expected in [
            ({"DEVTOOLS_BROWSER_PROFILE": "/tmp/devtools-profile"}, "/tmp/devtools-profile"),
            ({"BROWSER_SESSION_PROFILE": "/tmp/browser-profile", "DEVTOOLS_BROWSER_PROFILE": "/tmp/devtools-profile", "JAVA_BACKEND_BROWSER_PROFILE": "/tmp/legacy-profile"}, "/tmp/browser-profile"),
            ({"BROWSER_SESSION_PROFILE": "", "DEVTOOLS_BROWSER_PROFILE": ""}, str(STATE / "browser-profiles/main")),
        ]:
            with self.subTest(overrides=overrides):
                self.assertEqual(self.python_defaults(clean_env(**overrides)), [expected] * 3)
                self.assertEqual(self.browser_profile(clean_env(**overrides)), expected)

    def test_python_legacy_variable_remains_a_fallback(self):
        self.assertEqual(self.python_defaults(clean_env(JAVA_BACKEND_BROWSER_PROFILE="/tmp/legacy-profile"))[:2], ["/tmp/legacy-profile"] * 2)

    def test_webshell_is_isolated_and_explicit_profile_still_wins(self):
        url = "https://webshell.oa.fenqile.com/"
        self.assertEqual(self.browser_profile(clean_env(), url=url), str(STATE / "browser-profiles/webshell"))
        self.assertEqual(self.browser_profile(clean_env(BROWSER_SESSION_PROFILE="/tmp/env-profile"), {"profile": "~/chosen-profile"}, url), str(Path.home() / "chosen-profile"))

    def test_renewal_targets_and_snapshot_use_shared_state(self):
        installer = load_installer()
        targets = installer.default_targets()
        self.assertEqual([str(t["profile"]) for t in targets], [str(STATE / "browser-profiles" / role) for role in ["main", "healthy", "main", "main"]])
        self.assertEqual(targets[-1]["export"], STATE / "session-snapshots/main.json")

    def test_dubbo_cli_forwards_explicit_profile_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            stub = Path(directory) / "browser.js"
            stub.write_text("console.log(JSON.stringify({profile:process.argv.find(a=>a.startsWith('--profile=')).slice(10)}));\n")
            command = [sys.executable, "-B", str(DUBBO / "dubbo_request.py"), "--transport=browser", "--service=test.Service", "--method=read", "--ip=127.0.0.1", "--port=1", "--profile=/tmp/explicit-profile"]
            env = clean_env(BROWSER_SESSION_PROFILE="/tmp/env-profile", BIANQUE_BROWSER_REQUEST_SCRIPT=str(stub))
            self.assertEqual(json.loads(subprocess.check_output(command, env=env, text=True))["profile"], "/tmp/explicit-profile")


if __name__ == "__main__":
    unittest.main()
