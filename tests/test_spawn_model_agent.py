from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest import mock


REPO = Path(__file__).parents[1]
SCRIPT = REPO / "skills/common/spawn-model-agent/scripts/spawn_model_agent.py"
SPEC = importlib.util.spec_from_file_location("spawn_model_agent", SCRIPT)
assert SPEC and SPEC.loader
sma = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sma)

WRAPPERS = ["claude-deepseek", "claude-kimi", "claude-qwen", "codex-kimi", "codex-qwen", "codex-vps"]


class SpawnModelAgentTest(unittest.TestCase):
    def test_detect_client_from_host_env_then_process_tree(self):
        with mock.patch.dict("os.environ", {"CLAUDECODE": "1"}, clear=True):
            self.assertEqual(sma.detect_client(), "claude")
        with mock.patch.dict("os.environ", {"CODEX_THREAD_ID": "x"}, clear=True):
            self.assertEqual(sma.detect_client(), "codex")
        tree = {100: ("python3", 90), 90: ("bash", 80), 80: ("codex.exe", 1)}

        def fake_open(path, *a, **k):
            pid = int(path.split("/")[2])
            comm, ppid = tree[pid]
            body = comm if path.endswith("comm") else f"{pid} ({comm}) S {ppid} 1 1"
            return mock.mock_open(read_data=body)()

        with mock.patch.dict("os.environ", {}, clear=True), mock.patch("os.getppid", return_value=100), \
                mock.patch("builtins.open", side_effect=fake_open):
            self.assertEqual(sma.detect_client(), "codex")
        with mock.patch.dict("os.environ", {}, clear=True), mock.patch("os.getppid", return_value=1), \
                mock.patch("builtins.open", side_effect=OSError):
            self.assertIsNone(sma.detect_client())

    def test_short_names_follow_host_and_full_names_pass_through(self):
        with mock.patch.object(sma, "wrappers_on_path", return_value=WRAPPERS):
            self.assertEqual(sma.resolve_backend("kimi", "claude"), "claude-kimi")
            self.assertEqual(sma.resolve_backend("qwen", "codex"), "codex-qwen")
            self.assertEqual(sma.resolve_backend("claude-deepseek", "codex"), "claude-deepseek")
            with self.assertRaises(SystemExit):
                sma.resolve_backend("gpt", "claude")  # no such wrapper
            with self.assertRaises(SystemExit):
                sma.resolve_backend("kimi", None)  # host unknown, short name ambiguous

    def test_commands_match_host_permissions(self):
        c = sma.build_command("claude-kimi", "do it", readonly=False)
        self.assertEqual(c[:3], ["claude-kimi", "-p", "do it"])
        self.assertIn("--dangerously-skip-permissions", c)
        self.assertNotIn("--tools", c)
        self.assertNotIn("--strict-mcp-config", c)  # MCP inherited like a normal subagent
        r = sma.build_command("claude-kimi", "do it", readonly=True)
        self.assertIn("--tools", r)
        self.assertNotIn("--dangerously-skip-permissions", r)
        self.assertEqual(r[r.index("--tools") + 1], "Read,Grep,Glob,WebSearch,WebFetch")
        self.assertEqual(c[c.index("--output-format") + 1], "stream-json")
        n = sma.build_command("claude-qwen", "review", readonly=True, tools=["Read", "Grep", "Glob"])
        self.assertEqual(n[n.index("--tools") + 1], "Read,Grep,Glob")
        self.assertEqual(n[n.index("--allowedTools") + 1], "Read,Grep,Glob")

        x = sma.build_command("codex-qwen", "do it", readonly=False)
        self.assertEqual(x[:3], ["codex-qwen", "--search", "exec"])
        self.assertIn("workspace-write", x)
        self.assertIn('approval_policy="never"', x)
        self.assertNotIn("--ephemeral", x)  # thread must persist for --resume
        self.assertIn("read-only", sma.build_command("codex-qwen", "do it", readonly=True))
        # codex-vps read-only goes through codex-reviewer (bwrap, no user config/MCP) and cannot be resumed (--ephemeral)
        self.assertEqual(sma.build_command("codex-vps", "review", readonly=True, tools=["Read"]), [sma.CODEX_REVIEWER, "--json", "review"])
        with self.assertRaises(SystemExit):
            sma.build_command("codex-vps", "more", readonly=True, resume_id="tid")
        self.assertEqual(sma.build_command("codex-vps", "do it", readonly=False)[:3], ["codex-vps", "--search", "exec"])

    def test_resume_commands(self):
        c = sma.build_command("claude-kimi", "more", readonly=False, resume_id="sid")
        self.assertEqual(c[c.index("--resume") + 1], "sid")
        x = sma.build_command("codex-kimi", "more", readonly=False, resume_id="tid")
        self.assertEqual(x[:4], ["codex-kimi", "--search", "exec", "resume"])
        self.assertNotIn("-s", x)  # exec resume has no -s; sandbox goes through -c
        self.assertIn('sandbox_mode="workspace-write"', x)
        self.assertEqual(x[-2:], ["tid", "more"])

    def test_resume_inherits_readonly_and_slim(self):
        from types import SimpleNamespace
        a = SimpleNamespace(cwd="/x", slim=False, readonly=False)
        backend, sid = sma.apply_resume(a, {"backend": "codex-kimi", "session_id": "t1", "readonly": True, "slim": True, "cwd": "/y"})
        self.assertEqual((backend, sid), ("codex-kimi", "t1"))
        self.assertTrue(a.readonly)
        self.assertTrue(a.slim)
        self.assertEqual(a.cwd, "/y")
        with self.assertRaises(SystemExit):
            sma.apply_resume(a, {"backend": "codex-kimi"})

    def test_timeout_writes_terminal_meta(self):
        import json, os, subprocess, tempfile
        with tempfile.TemporaryDirectory() as job:
            exc = subprocess.TimeoutExpired(cmd=["x"], timeout=1, output="partial", stderr="err")
            with mock.patch.object(sma.subprocess, "run", side_effect=exc):
                rc = sma.run_child(job, "claude-kimi", "t", job, False, False, 1, None)
            self.assertEqual(rc, 124)
            meta = json.load(open(os.path.join(job, "meta.json")))
            self.assertEqual(meta["exit_code"], "timeout")
            self.assertTrue(os.path.exists(os.path.join(job, "result.md")))

    def test_parsers_capture_session_ids(self):
        raw = "\n".join([
            '{"type":"system","subtype":"init","tools":["Glob","Grep","Read"],"mcp_servers":[]}',
            '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{}}]}}',
            '{"type":"result","session_id":"s1","result":"ok","num_turns":2,"modelUsage":{"m":{"inputTokens":1,"outputTokens":2}}}',
            '{"type":"rate_limit_event"}'])
        meta, text = sma.parse_claude(raw)
        self.assertEqual((meta["session_id"], meta["model"], text), ("s1", "m", "ok"))
        self.assertEqual((meta["effective_tools"], meta["mcp_servers"], meta["tools_used"]), (["Glob", "Grep", "Read"], [], ["Read"]))
        raw = '{"type":"thread.started","thread_id":"t1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}'
        meta, text = sma.parse_codex(raw)
        self.assertEqual((meta["session_id"], meta["input_tokens"], text), ("t1", 3, "hi"))
        raw = "\n".join([
            '{"type":"thread.started","thread_id":"t2"}',
            '{"type":"item.completed","item":{"type":"command_execution","command":"cat a.md"}}',
            '{"type":"item.completed","item":{"type":"mcp_tool_call","server":"bastion","tool":"execute_command"}}',
            '{"type":"item.completed","item":{"type":"reasoning","text":"r"}}',
            '{"type":"item.completed","item":{"type":"new_tool_kind"}}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'])
        meta, _ = sma.parse_codex(raw)
        self.assertEqual((meta["tools_used"], meta["shell_commands"]), (["mcp:bastion", "new_tool_kind", "shell"], ["cat a.md"]))

    def test_refused_tool_calls_are_kept_apart_from_executed_ones(self):
        raw = "\n".join([
            '{"type":"system","subtype":"init","tools":["Glob","Grep","Read"],"mcp_servers":[]}',
            '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Bash","input":{}}]}}',
            '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","is_error":true,"content":"<tool_use_error>Error: No such tool available: Bash</tool_use_error>"}]}}',
            '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"b","name":"Grep","input":{}}]}}',
            '{"type":"result","session_id":"s","result":"ok"}'])
        meta, _ = sma.parse_claude(raw)
        self.assertEqual((meta["tools_used"], meta["tools_rejected"]), (["Grep"], ["Bash"]))

    def test_ledger_stats_attribute_escapes_to_the_passing_reviewer(self):
        import json, os, tempfile
        rows = [
            {"approval_id": "a1", "slot": "primary", "backend": "claude-qwen", "model": "q1", "execution_valid": True,
             "finding_counts": {"成立需修/Low": 2, "噪音/Low": 1}, "escaped_from": []},
            {"approval_id": "a2", "slot": "primary", "backend": "claude-subagent", "model": "s", "execution_valid": True,
             "finding_counts": {"成立需修/High": 1}, "escaped_from": ["a1"]},
            {"approval_id": "a3", "slot": "primary", "backend": "claude-qwen", "model": "q1", "execution_valid": False, "finding_counts": {}},
            {"approval_id": "a4", "slot": "primary", "backend": "claude-qwen", "model": "q2", "execution_valid": True,
             "finding_counts": {"成立需修/Medium": 1}, "escaped_from": []},
        ]
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "ledger.jsonl")
            open(path, "w").write("\n".join(json.dumps(r, ensure_ascii=False) for r in rows))
            st = sma.ledger_stats(path)
        self.assertEqual(sma.format_stats(st[("claude-qwen", "q1")]), "n=1 成立 2/3 噪音 1 漏检 1 无效 1")
        self.assertEqual(sma.format_stats(st[("claude-qwen", "q2")]), "n=1 成立 1/1 噪音 0 漏检 0")  # a swapped model starts fresh
        self.assertEqual(sma.format_stats(st[("claude-subagent", "s")]), "n=1 成立 1/1 噪音 0 漏检 0")
        self.assertEqual(sma.format_stats(None), "—")

    def test_list_marks_score_stale_when_profile_model_changed(self):
        import io, os, tempfile, contextlib
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "claude"))
            open(os.path.join(d, "claude", "lexin-deepseek.env"), "w").write('# note\nCLAUDE_PROFILE_MODEL="ds-new"\n')
            routing = {"claude-deepseek": {"model_source": "profile", "review_score": "11/11", "review_test_model": "ds-old"}}
            out = io.StringIO()
            with mock.patch.dict(os.environ, {"AI_PROVIDERS_HOME": d}), \
                    mock.patch.object(sma, "routing_backends", return_value=routing), \
                    mock.patch.object(sma, "wrappers_on_path", return_value=["claude-deepseek"]), \
                    mock.patch.object(sma, "ledger_stats", return_value={}), contextlib.redirect_stdout(out):
                sma.list_backends()
        text = out.getvalue()
        self.assertIn("| claude-deepseek | ds-new | 未测（11/11 测于 ds-old） |", text)
        self.assertIn("不进推荐排序", text)

    def test_fit_hint_comes_from_routing(self):
        with mock.patch.object(sma, "routing_backends", return_value={"codex-glm": {"fit": "只派轻任务", "output_cap_tokens": 8192}}):
            self.assertIn("8192", sma.fit_hint("codex-glm"))
            self.assertIn("只派轻任务", sma.fit_hint("codex-glm"))
            self.assertIsNone(sma.fit_hint("codex-kimi"))
        self.assertIsNotNone(sma.fit_hint("codex-glm"))  # real routing file carries the rule


if __name__ == "__main__":
    unittest.main()
