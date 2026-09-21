"""Cookie-bearing urllib requests in lexin scripts must not follow cross-origin redirects."""

from __future__ import annotations

import email.message
import importlib.util
import io
import sys
import unittest
import urllib.request
from pathlib import Path

REPO = Path(__file__).parents[1]


def load(name: str, rel: str):
    script = REPO / rel
    sys.path.insert(0, str(script.parent))
    spec = importlib.util.spec_from_file_location(name, script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses resolve annotations through sys.modules
    spec.loader.exec_module(module)
    return module


class RedirectGuardTest(unittest.TestCase):
    def check(self, module):
        handler = module.SameOriginRedirectHandler()
        req = urllib.request.Request("https://mihawk.oa.fenqile.com/api/x", headers={"Cookie": "s=1"})
        headers = email.message.Message()
        with self.assertRaises(RuntimeError):
            handler.redirect_request(req, io.BytesIO(b""), 302, "Found", headers, "https://outside.example/next")
        same = handler.redirect_request(req, io.BytesIO(b""), 302, "Found", headers, "/api/y")
        self.assertEqual(same.full_url, "https://mihawk.oa.fenqile.com/api/y")
        self.assertIsInstance(module.OPENER, urllib.request.OpenerDirector)

    def test_hawk_field_ref_refuses_cross_origin_redirect(self):
        self.check(load("hawk_field_ref", "skills/lexin/query-hawk-field-reference/scripts/hawk_field_ref.py"))

    def test_dubbo_request_refuses_cross_origin_redirect(self):
        self.check(load("dubbo_request_guard", "skills/lexin/test-dubbo-api/scripts/dubbo_request.py"))


if __name__ == "__main__":
    unittest.main()
