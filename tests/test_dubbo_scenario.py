"""Assertion semantics of test-dubbo-api's scenario runner: a missing response path must not pass."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).parents[1]
SCRIPT = REPO / "skills/lexin/test-dubbo-api/scripts/dubbo_scenario.py"
sys.path.insert(0, str(SCRIPT.parent))  # the scenario runner imports its sibling dubbo_request
SPEC = importlib.util.spec_from_file_location("dubbo_scenario", SCRIPT)
assert SPEC and SPEC.loader
scenario = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scenario)


class ScenarioAssertionTest(unittest.TestCase):
    def test_truthy_and_in_fail_when_the_path_is_missing(self):
        response = {"data": {"success": True, "state": 2}}
        scenario.assert_one({"path": "data.success", "truthy": True}, response, {})
        scenario.assert_one({"path": "data.state", "in": [1, 2]}, response, {})
        for assertion in ({"path": "data.missing", "truthy": True}, {"path": "data.missing", "in": [1, 2]}):
            with self.assertRaises(AssertionError):
                scenario.assert_one(assertion, response, {})

    def test_exists_false_and_falsey_semantics(self):
        response = {"data": {"flag": False}}
        scenario.assert_one({"path": "data.missing", "exists": False}, response, {})
        scenario.assert_one({"path": "data.flag", "falsey": True}, response, {})
        with self.assertRaises(AssertionError):
            scenario.assert_one({"path": "data.flag", "truthy": True}, response, {})


if __name__ == "__main__":
    unittest.main()
