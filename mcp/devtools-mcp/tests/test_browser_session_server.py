import sys
import unittest
from pathlib import Path
from unittest.mock import patch


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

from devtools_mcp import browser_session_server  # noqa: E402


class BrowserSessionServerTest(unittest.TestCase):
    @patch("devtools_mcp.browser_session_server._run_browser")
    def test_renew_session_runs_headless_renewal(self, run_browser):
        run_browser.return_value = '{"renewalState":"SESSION_ACTIVE"}'

        result = browser_session_server.renew_session(
            "https://lexiao.oa.fenqile.com/",
            profile="/tmp/profile",
            success_text="当前环境",
        )

        self.assertEqual(result, '{"renewalState":"SESSION_ACTIVE"}')
        run_browser.assert_called_once_with([
            "--url=https://lexiao.oa.fenqile.com/",
            "--profile=/tmp/profile",
            "--success-text=当前环境",
            "--renew",
        ], timeout=90)

    @patch("devtools_mcp.browser_session_server._run_browser")
    def test_renew_session_requires_url(self, run_browser):
        result = browser_session_server.renew_session("")

        self.assertIn("url is required", result)
        run_browser.assert_not_called()


if __name__ == "__main__":
    unittest.main()
