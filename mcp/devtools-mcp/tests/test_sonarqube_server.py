import json
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from devtools_mcp import sonarqube_server as server


class SonarqubeServerTest(unittest.TestCase):
    @patch.object(server, "_sonarqube_get", return_value="{}")
    def test_page_and_branch_remain_bound_to_the_same_query(self, get):
        server.list_sonarqube_issues(project_key="project:example", page=3, limit=25, branch="feature/x")
        query = get.call_args.args[2]
        self.assertEqual((3, 25, "feature/x", "project:example"),
                         (query["p"], query["ps"], query["branch"], query["componentKeys"]))

    @patch.object(server, "_headers", return_value={})
    @patch.object(server, "urlopen")
    def test_large_response_is_a_valid_explicit_error_instead_of_partial_json(self, urlopen, headers):
        response = MagicMock()
        response.read.return_value = json.dumps({"issues": ["x" * 2000]}).encode()
        urlopen.return_value.__enter__.return_value = response
        result = json.loads(server._sonarqube_get("https://example.test", "api/issues/search", {}, max_chars=1000))
        self.assertTrue(result["truncated"])
        self.assertIn("reduce the page size", result["error"])


if __name__ == "__main__":
    unittest.main()
