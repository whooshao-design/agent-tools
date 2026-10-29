import sys
import unittest
from pathlib import Path
from unittest.mock import patch


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

from devtools_mcp import lexiao_server  # noqa: E402


class LexiaoProjectDeployTest(unittest.TestCase):
    @patch("devtools_mcp.lexiao_server._run_node")
    def test_cluster_is_forwarded_only_when_given(self, run_node):
        run_node.return_value = "{}"

        lexiao_server.lexiao_project_deploy("u", "app", profile="/p", build_timeout_seconds=60, deploy_timeout_seconds=120)
        lexiao_server.lexiao_project_deploy("u", "app", profile="/p", cluster="gz_ydjd_idc")

        first, second = (call.args[1] for call in run_node.call_args_list)
        self.assertEqual(first, [
            "--action=deploy", "--url=u", "--app=app", "--profile=/p",
            "--build-timeout=60000", "--deploy-timeout=120000",
        ])
        self.assertEqual(second[-1], "--cluster=gz_ydjd_idc")

    @patch("devtools_mcp.lexiao_server._run_node")
    def test_deploy_requires_url_and_app(self, run_node):
        self.assertIn("url and app are required", lexiao_server.lexiao_project_deploy("", "app"))
        run_node.assert_not_called()


class ProjectBuildToolsTest(unittest.TestCase):
    @patch("devtools_mcp.lexiao_server._run_node")
    def test_build_forwards_build_action(self, run_node):
        run_node.return_value = "{}"
        lexiao_server.lexiao_project_build("u", "process-engine-ec", profile="/p", build_timeout_seconds=600)
        self.assertEqual(run_node.call_args.args[1], [
            "--action=build", "--url=u", "--app=process-engine-ec", "--profile=/p", "--build-timeout=600000",
        ])

    @patch("devtools_mcp.lexiao_server._remote_head", return_value={"error": "skip"})
    @patch("devtools_mcp.lexiao_server._jenkins_last_build", return_value={"error": "skip"})
    @patch("devtools_mcp.lexiao_server.current_repo_context")
    def test_build_check_uses_lexiao_app_name_for_job(self, ctx, last_build, _head):
        ctx.return_value = {"branch": "rel_x_1", "project_name": "process-engine-java", "project_path": "rc_core/process-engine-java", "repo_dir": "/r"}
        lexiao_server.lexiao_project_build_check("/r", "process-engine")
        self.assertEqual(last_build.call_args.args[0], "feature-pipeline-process-engine-rel_x_1")
        self.assertIn("required", lexiao_server.lexiao_project_build_check("/r", ""))


class ProjectBuildDecisionTest(unittest.TestCase):
    HEAD = {"sha": "a" * 40, "commit_time": 1000}
    BUILD = {"number": 2, "building": False, "result": "SUCCESS", "timestamp": 1050, "sha": "a" * 40}

    def decide(self, build=None, head=None, jars=(), now=5000):
        return lexiao_server.decide_project_build(build or self.BUILD, head or self.HEAD, list(jars), now)[0]

    def test_head_already_built_means_deploy_only(self):
        self.assertEqual(self.decide(jars=[{"jar": "g:a:1", "last_updated": 1040}]), "deploy-only")

    def test_jar_updated_after_build_requires_build(self):
        self.assertEqual(self.decide(jars=[{"jar": "g:a:1", "last_updated": 1100}]), "build")

    def test_unbuilt_head_waits_within_grace_then_builds(self):
        build = {**self.BUILD, "sha": "b" * 40}
        self.assertEqual(self.decide(build=build, now=1000 + 60), "wait")
        self.assertEqual(self.decide(build=build, now=1000 + lexiao_server.AUTO_BUILD_GRACE_SECONDS + 1), "build")

    def test_running_build_waits_and_failed_build_rebuilds(self):
        self.assertEqual(self.decide(build={**self.BUILD, "building": True}), "wait")
        self.assertEqual(self.decide(build={**self.BUILD, "result": "FAILURE"}), "build")

    def test_build_without_this_repo_commit_is_unknown(self):
        self.assertEqual(self.decide(build={**self.BUILD, "sha": ""}), "unknown")

    def test_unreadable_inputs_are_unknown(self):
        self.assertEqual(self.decide(jars=[{"jar": "g:a:1", "error": "HTTP request failed"}]), "unknown")
        self.assertEqual(self.decide(build={"error": "Jenkins is unreachable"}), "unknown")


if __name__ == "__main__":
    unittest.main()
