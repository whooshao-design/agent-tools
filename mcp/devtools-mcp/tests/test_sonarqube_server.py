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

    @patch.object(server, "_sonarqube_get")
    @patch.object(server, "_sonarqube_post", return_value='{"total":2,"success":2,"ignored":0,"failures":0}')
    def test_transition_posts_comment_and_reports_unresolved_keys(self, post, get):
        get.return_value = json.dumps({"issues": [
            {"key": "A", "status": "RESOLVED", "resolution": "FALSE-POSITIVE"},
            {"key": "B", "status": "OPEN"},
        ]})
        result = json.loads(server.transition_sonarqube_issues(" A, B ", "falsepositive", " 误报说明 "))
        form = post.call_args.args[2]
        self.assertEqual(("api/issues/bulk_change", "A,B", "falsepositive", "误报说明"),
                         (post.call_args.args[1], form["issues"], form["do_transition"], form["comment"]))
        self.assertEqual((False, ["B"]), (result["verified"], result["not_transitioned"]))

    @patch.object(server, "_sonarqube_post")
    def test_transition_requires_comment_and_known_transition(self, post):
        self.assertIn("comment is required", server.transition_sonarqube_issues("A", "falsepositive", " "))
        self.assertIn("transition must be", server.transition_sonarqube_issues("A", "reopen", "x"))
        post.assert_not_called()

    @patch.object(server, "_headers", return_value={})
    @patch.object(server, "urlopen")
    def test_post_sends_form_body_not_query_string(self, urlopen, headers):
        response = MagicMock()
        response.read.return_value = b"{}"
        urlopen.return_value.__enter__.return_value = response
        server._sonarqube_post("https://example.test", "api/issues/bulk_change", {"issues": "A", "x": ""})
        request = urlopen.call_args.args[0]
        self.assertEqual(("POST", "https://example.test/api/issues/bulk_change", b"issues=A"),
                         (request.get_method(), request.full_url, request.data))


if __name__ == "__main__":
    unittest.main()
