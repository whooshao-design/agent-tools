import base64
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

from devtools_mcp import common  # noqa: E402


class BrowserSessionRequestTest(unittest.TestCase):
    def test_default_profile_matches_browser_session_script(self):
        if "BROWSER_SESSION_PROFILE" not in os.environ and "DEVTOOLS_BROWSER_PROFILE" not in os.environ:
            self.assertEqual(
                common.DEFAULT_BROWSER_PROFILE,
                str(Path.home() / ".local" / "state" / "agent-tools" / "browser-profiles" / "main"),
            )

    @patch("devtools_mcp.common.browser_session_request")
    def test_authenticated_request_runs_inside_browser_context(self, browser_request):
        browser_request.return_value = {
            "status": 200,
            "url": "https://healthy.lexincloud.com/api/status",
            "body": "ok",
            "truncated": False,
        }

        result = common.internal_http_get(
            "https://healthy.lexincloud.com/api/status",
            use_browser_session=True,
            profile="/tmp/profile",
        )

        self.assertEqual(result["status"], 200)
        browser_request.assert_called_once()
        call_args = browser_request.call_args
        self.assertEqual(call_args.args[0], "GET")
        self.assertEqual(call_args.kwargs["profile"], "/tmp/profile")

    @patch("devtools_mcp.common.browser_session_request")
    def test_authenticated_request_rejects_unrelated_cookie_domain(self, browser_request):
        result = common.internal_http_get(
            "https://healthy.lexincloud.com/api/status",
            use_browser_session=True,
            domain="fenqile.com",
        )

        self.assertEqual(result["error"], "cookie domain does not match request host")
        browser_request.assert_not_called()

    @patch("devtools_mcp.common.run_command")
    def test_browser_request_uses_private_environment_payload(self, run_command):
        run_command.return_value = {
            "exit_code": 0,
            "stdout": '{"status": 200, "body": "ok"}',
            "stderr": "",
        }

        result = common.browser_session_request(
            "POST",
            "https://healthy.lexincloud.com/api/status",
            {"Content-Type": "application/json", "Cookie": "must-not-be-forwarded"},
            body='{"value":1}',
            profile="/tmp/profile",
        )

        self.assertEqual(result["status"], 200)
        command = run_command.call_args.args[0]
        self.assertIn("--request", command)
        self.assertIn("--profile=/tmp/profile", command)
        request_config = json.loads(run_command.call_args.kwargs["env"]["BROWSER_SESSION_REQUEST_JSON"])
        self.assertNotIn("Cookie", request_config["headers"])
        self.assertEqual(base64.b64decode(request_config["bodyBase64"]), b'{"value":1}')

    @patch("devtools_mcp.common.run_command")
    def test_browser_request_reports_process_and_protocol_errors(self, run_command):
        run_command.return_value = {"exit_code": 1, "stdout": "", "stderr": "launch failed"}
        failed = common.browser_session_request("GET", "https://healthy.lexincloud.com/api/status", {})
        self.assertEqual(failed["error"], "browser session request failed")

        run_command.return_value = {"exit_code": 0, "stdout": "not-json", "stderr": ""}
        invalid = common.browser_session_request("GET", "https://healthy.lexincloud.com/api/status", {})
        self.assertEqual(invalid["error"], "invalid browser session response")


if __name__ == "__main__":
    unittest.main()
