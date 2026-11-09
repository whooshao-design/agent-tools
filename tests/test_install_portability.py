"""install.py 可移植改造新能力的测试（CHG-003）：local.env、渲染副本、两端 env、指针文件、MCP 注册与 manifest v4。

MCP 注册用 PATH 上的假 claude / codex CLI（本目录临时生成）操作 $HOME/.claude.json 与 $HOME/.codex/config.toml。
"""
from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import tomllib
import unittest
from pathlib import Path

REPO = Path(__file__).parents[1]
INSTALL = REPO / "install.py"
SPEC = importlib.util.spec_from_file_location("agent_tools_install_portability", INSTALL)
assert SPEC and SPEC.loader
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)

FAKE_CLAUDE = r'''#!/usr/bin/env python3
"""假 claude CLI：mcp add --scope user NAME -e K=V ... -- CMD ARGS...；mcp remove --scope user NAME。"""
import json, os, sys
path = os.path.join(os.environ["HOME"], ".claude.json")
data = json.load(open(path)) if os.path.exists(path) else {}
argv = sys.argv[1:]
assert argv[:2] == ["mcp", "add"] or argv[:2] == ["mcp", "remove"], argv
rest = argv[2:]
if rest[:2] == ["--scope", "user"]:
    rest = rest[2:]
name = rest[0]
servers = data.setdefault("mcpServers", {})
if argv[1] == "remove":
    if name not in servers:
        sys.exit("No MCP server found with name: " + name)
    servers.pop(name)
else:
    if name in servers:
        sys.exit("MCP server " + name + " already exists")
    env = {}
    i = 1
    while rest[i] == "-e":
        key, _, value = rest[i + 1].partition("=")
        env[key] = value
        i += 2
    assert rest[i] == "--"
    servers[name] = {"type": "stdio", "command": rest[i + 1], "args": rest[i + 2:], "env": env}
json.dump(data, open(path, "w"), indent=2)
'''

FAKE_CODEX = r'''#!/usr/bin/env python3
"""假 codex CLI：mcp add NAME --env K=V ... -- CMD ARGS...；mcp remove NAME。重写 config.toml 时丢掉表内注释以外的排版。"""
import os, sys
path = os.path.join(os.environ["HOME"], ".codex", "config.toml")
text = open(path).read() if os.path.exists(path) else ""
argv = sys.argv[1:]
name = argv[2]
lines = text.split("\n")
def drop(prefixes):
    out, skipping = [], False
    for line in lines:
        s = line.strip()
        if s.startswith("["):
            skipping = any(s == p for p in prefixes)
        if not skipping:
            out.append(line)
    return out
if argv[1] == "remove":
    if f"[mcp_servers.{name}]" not in [l.strip() for l in lines]:
        sys.exit("No MCP server named " + name)
    lines = drop([f"[mcp_servers.{name}]", f"[mcp_servers.{name}.env]"])
else:
    if f"[mcp_servers.{name}]" in [l.strip() for l in lines]:
        sys.exit("MCP server " + name + " already exists")
    env = []
    i = 3
    while argv[i] == "--env":
        env.append(argv[i + 1]); i += 2
    assert argv[i] == "--"
    cmd, args = argv[i + 1], argv[i + 2:]
    block = [f"[mcp_servers.{name}]", f'command = "{cmd}"', "args = [" + ", ".join(f'"{a}"' for a in args) + "]"]
    if env:
        block += ["", f"[mcp_servers.{name}.env]"] + [f'{k} = "{v}"' for k, v in (e.partition("=")[::2] for e in env)]
    while lines and lines[-1] == "":
        lines.pop()
    lines += [""] + block if lines else block
os.makedirs(os.path.dirname(path), exist_ok=True)
open(path, "w").write("\n".join(lines).rstrip("\n") + "\n")
'''


class PortabilityInstallTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.home = Path(self.temp_dir.name)
        self.bin = self.home / "fakebin"
        self.bin.mkdir()
        for name, body in (("claude", FAKE_CLAUDE), ("codex", FAKE_CODEX)):
            script = self.bin / name
            script.write_text(body, encoding="utf-8")
            script.chmod(0o755)
        self.repo = str(REPO)
        self.targets = installer._mcp_targets(self.repo)

    def tearDown(self):
        self.temp_dir.cleanup()

    def run_install(self, *args, check=True, with_cli=True, local_env=None):
        env = os.environ.copy()
        env["HOME"] = str(self.home)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        if with_cli:
            env["PATH"] = f"{self.bin}{os.pathsep}{env['PATH']}"
        else:
            env["PATH"] = str(self.home / "empty-bin")
            (self.home / "empty-bin").mkdir(exist_ok=True)
            # python3 仍需可用
            env["PATH"] += os.pathsep + os.path.dirname(sys.executable)
        result = subprocess.run(
            [sys.executable, str(INSTALL), *args], cwd=REPO, env=env, text=True, capture_output=True, check=False
        )
        if check and result.returncode != 0:
            self.fail(f"install.py exited {result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        return result

    def manifest(self, client):
        return json.loads((self.home / f".{client}/.agent-tools-install.json").read_text(encoding="utf-8"))

    def claude_mcp(self):
        path = self.home / ".claude.json"
        return json.loads(path.read_text(encoding="utf-8")).get("mcpServers", {}) if path.exists() else {}

    def codex_toml(self):
        path = self.home / ".codex/config.toml"
        return tomllib.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def write_codex(self, text):
        path = self.home / ".codex/config.toml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(text), encoding="utf-8")
        return path

    # ---- MCP ---------------------------------------------------------------

    def test_with_mcp_dry_run_writes_nothing(self):
        result = self.run_install("--skills", "skill-authoring", "--with-mcp", "--dry-run")
        self.assertIn("claude mcp devtools: would register", result.stdout)
        self.assertFalse((self.home / ".claude.json").exists())
        self.assertFalse((self.home / ".codex/config.toml").exists())
        self.assertFalse((self.home / ".claude").exists())

    def test_with_mcp_registers_three_servers_and_is_idempotent(self):
        first = self.run_install("--skills", "skill-authoring", "--with-mcp")
        self.assertIn("claude mcp devtools: registered", first.stdout)
        servers = self.claude_mcp()
        self.assertEqual(set(self.targets), set(servers))
        self.assertEqual(self.targets["devtools"]["env"], servers["devtools"]["env"])
        codex = self.codex_toml()["mcp_servers"]
        self.assertEqual(self.targets["bastion_dba"]["env"]["BASTION_CONFIG"], codex["bastion_dba"]["env"]["BASTION_CONFIG"])
        for client in ("claude", "codex"):
            recorded = {item["name"]: item for item in self.manifest(client)["mcp_servers"]}
            self.assertEqual(set(self.targets), set(recorded))
            self.assertEqual([], self.manifest(client)["mcp_servers_replaced"])
        second = self.run_install("--skills", "skill-authoring", "--with-mcp")
        self.assertIn("claude mcp devtools: ok", second.stdout)
        self.assertEqual(servers, self.claude_mcp())

    def test_without_cli_prints_command_and_exits_1(self):
        result = self.run_install("--skills", "skill-authoring", "--with-mcp", check=False, with_cli=False)
        self.assertEqual(1, result.returncode)
        self.assertIn("claude CLI not in PATH", result.stdout)
        self.assertIn("claude mcp add --scope user devtools", result.stdout)

    def _seed_foreign_registrations(self):
        """现有 WSL 机器的形态：devtools 带 9 个 env 与额外键。"""
        foreign_env = {
            "PYTHONPATH": "/old/clone/mcp/devtools-mcp:/old/clone/mcp/bastion-mcp",
            "BASTION_CONFIG": "/old/clone/mcp/bastion-mcp/config.json",
            "GITLAB_BASE_URL": "https://gitlab.example",
        }
        self.home.joinpath(".claude.json").write_text(json.dumps({
            "mcpServers": {"devtools": {"type": "stdio", "command": "python3", "args": ["-m", "devtools_mcp.aggregate_server"], "env": foreign_env}},
            "other": True,
        }), encoding="utf-8")
        self.write_codex('''
            model = "keep"

            [mcp_servers.devtools]
            command = "python3"
            args = ["-m", "devtools_mcp.aggregate_server"]
            default_tools_approval_mode = "approve"

            [mcp_servers.devtools.env]
            PYTHONPATH = "/old/clone/mcp/devtools-mcp:/old/clone/mcp/bastion-mcp"
            BASTION_CONFIG = "/old/clone/mcp/bastion-mcp/config.json"
            GITLAB_BASE_URL = "https://gitlab.example"
        ''')
        return foreign_env

    def test_foreign_registration_is_unconverged_without_force(self):
        foreign_env = self._seed_foreign_registrations()
        result = self.run_install("--skills", "skill-authoring", "--with-mcp", check=False)
        self.assertEqual(1, result.returncode)
        self.assertIn("claude mcp devtools: unconverged", result.stdout)
        self.assertEqual(foreign_env, self.claude_mcp()["devtools"]["env"])
        self.assertEqual("approve", self.codex_toml()["mcp_servers"]["devtools"]["default_tools_approval_mode"])

    def test_force_backs_up_original_once_and_uninstall_restores_it(self):
        foreign_env = self._seed_foreign_registrations()
        self.run_install("--skills", "skill-authoring", "--with-mcp", "--force")
        codex = self.codex_toml()["mcp_servers"]["devtools"]
        self.assertEqual(self.targets["devtools"]["env"], codex["env"])
        self.assertEqual("approve", codex["default_tools_approval_mode"], "额外键写回")
        self.assertEqual("keep", self.codex_toml()["model"])
        backup = self.manifest("codex")["mcp_servers_replaced"]
        self.assertEqual(1, len(backup))
        self.assertEqual(foreign_env, backup[0]["env"])
        self.assertEqual({"default_tools_approval_mode": "approve"}, backup[0]["extra"])
        claude_backup = self.manifest("claude")["mcp_servers_replaced"][0]
        self.assertEqual({"type": "stdio"}, claude_backup["extra"])

        # O→A→B：第二次 --force（当前注册已是自有身份）不覆盖备份
        self.run_install("--skills", "skill-authoring", "--with-mcp", "--force")
        self.assertEqual(backup, self.manifest("codex")["mcp_servers_replaced"])

        # 迁移完成后用户删掉额外键，再不带 --force 重装：不补写、退出码 0
        path = self.home / ".codex/config.toml"
        path.write_text(path.read_text(encoding="utf-8").replace('"default_tools_approval_mode" = "approve"\n', ""), encoding="utf-8")
        result = self.run_install("--skills", "skill-authoring", "--with-mcp")
        self.assertNotIn("default_tools_approval_mode", self.codex_toml()["mcp_servers"]["devtools"])
        self.assertIn("codex mcp devtools: ok", result.stdout)

        self.run_install("--skills", "skill-authoring", "--with-mcp", "--uninstall")
        restored = self.codex_toml()["mcp_servers"]["devtools"]
        self.assertEqual(foreign_env, restored["env"])
        self.assertEqual("approve", restored["default_tools_approval_mode"])
        self.assertEqual(foreign_env, self.claude_mcp()["devtools"]["env"])
        self.assertTrue(json.loads((self.home / ".claude.json").read_text(encoding="utf-8"))["other"])
        self.assertFalse((self.home / ".codex/.agent-tools-install.json").exists())
        self.assertNotIn("bastion", self.codex_toml().get("mcp_servers", {}))

    def test_interruption_points_recover(self):
        foreign_env = self._seed_foreign_registrations()
        # 中断点 1：备份已保存、原注册未删 → 卸载不删原注册、恢复跳过并清备份
        self.run_install("--skills", "skill-authoring", "--targets", "codex")
        manifest_path = self.home / ".codex/.agent-tools-install.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["mcp_servers_replaced"] = [{"name": "devtools", "command": "python3", "args": ["-m", "devtools_mcp.aggregate_server"], "env": foreign_env, "extra": {"default_tools_approval_mode": "approve"}}]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        result = self.run_install("--skills", "skill-authoring", "--targets", "codex", "--with-mcp", "--uninstall")
        self.assertIn("codex mcp devtools restore: ok", result.stdout)
        self.assertEqual(foreign_env, self.codex_toml()["mcp_servers"]["devtools"]["env"])
        self.assertFalse(manifest_path.exists())

        # 中断点 2：备份已保存、注册已删 → 重跑直接 add 并写回额外键
        self.run_install("--skills", "skill-authoring", "--targets", "codex")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["mcp_servers_replaced"] = [{"name": "devtools", "command": "python3", "args": ["-m", "devtools_mcp.aggregate_server"], "env": foreign_env, "extra": {"default_tools_approval_mode": "approve"}}]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        subprocess.run([str(self.bin / "codex"), "mcp", "remove", "devtools"], env={**os.environ, "HOME": str(self.home)}, check=True)
        result = self.run_install("--skills", "skill-authoring", "--targets", "codex", "--with-mcp")
        devtools = self.codex_toml()["mcp_servers"]["devtools"]
        self.assertEqual(self.targets["devtools"]["env"], devtools["env"])
        self.assertEqual("approve", devtools["default_tools_approval_mode"])
        self.assertEqual("devtools", next(i["name"] for i in self.manifest("codex")["mcp_servers"] if i["name"] == "devtools"))

        # 中断点 3：add 完成、额外键未写回、未记入 → 幂等分支补写并补记
        path = self.home / ".codex/config.toml"
        path.write_text(path.read_text(encoding="utf-8").replace('"default_tools_approval_mode" = "approve"\n', ""), encoding="utf-8")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["mcp_servers"] = [i for i in manifest["mcp_servers"] if i["name"] != "devtools"]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        result = self.run_install("--skills", "skill-authoring", "--targets", "codex", "--with-mcp")
        self.assertEqual("approve", self.codex_toml()["mcp_servers"]["devtools"]["default_tools_approval_mode"])
        self.assertIn("restored extra keys default_tools_approval_mode", result.stdout)
        self.assertTrue(any(i["name"] == "devtools" for i in self.manifest("codex")["mcp_servers"]))

    def test_uninstall_keeps_registrations_of_sibling_clone(self):
        """两个克隆共用 manifest：记录的是 ~/src/agent-tools-2 的身份时，agent-tools 的卸载不删它。"""
        self.run_install("--skills", "skill-authoring", "--with-mcp")
        sibling = self.repo + "-2"
        sibling_targets = installer._mcp_targets(sibling)
        for client in ("claude", "codex"):
            manifest_path = self.home / f".{client}/.agent-tools-install.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["mcp_servers"] = [{"name": name, **installer._identity(target)} for name, target in sibling_targets.items()]
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        data = json.loads((self.home / ".claude.json").read_text(encoding="utf-8"))
        for name, target in sibling_targets.items():
            data["mcpServers"][name] = {"type": "stdio", **target}
        (self.home / ".claude.json").write_text(json.dumps(data), encoding="utf-8")
        result = self.run_install("--skills", "skill-authoring", "--with-mcp", "--targets", "claude", "--uninstall")
        self.assertIn("claude mcp devtools: skip (not this clone's registration)", result.stdout)
        self.assertEqual(sibling_targets["devtools"]["env"], self.claude_mcp()["devtools"]["env"])

    # ---- env / 指针文件 / manifest -------------------------------------------

    def test_codex_env_block_merges_into_existing_table_and_keeps_user_keys(self):
        self.write_codex('''
            model = "keep"

            [shell_environment_policy.set]
            MY_TOKEN = "secret"
        ''')
        self.run_install("--skills", "skill-authoring", "--targets", "codex")
        text = (self.home / ".codex/config.toml").read_text(encoding="utf-8")
        self.assertIn(installer.ENV_BLOCK_START, text)
        self.assertIn(installer.ENV_BLOCK_END, text)
        self.assertEqual(1, text.count("[shell_environment_policy.set]"))
        parsed = self.codex_toml()
        self.assertEqual("secret", parsed["shell_environment_policy"]["set"]["MY_TOKEN"])
        self.assertEqual(self.repo, parsed["shell_environment_policy"]["set"]["AGENT_TOOLS_ROOT"])
        self.assertEqual("keep", parsed["model"])

        # 用户在标记块里加键、再重装：保留；卸载只删自有键
        path = self.home / ".codex/config.toml"
        path.write_text(text.replace(installer.ENV_BLOCK_END, 'USER_IN_BLOCK = "1"\n' + installer.ENV_BLOCK_END), encoding="utf-8")
        self.run_install("--skills", "skill-authoring", "--targets", "codex")
        self.assertEqual("1", self.codex_toml()["shell_environment_policy"]["set"]["USER_IN_BLOCK"])
        self.run_install("--skills", "skill-authoring", "--targets", "codex", "--uninstall")
        parsed = self.codex_toml()
        self.assertEqual({"MY_TOKEN": "secret", "USER_IN_BLOCK": "1"}, parsed["shell_environment_policy"]["set"])
        self.assertNotIn("AGENT_TOOLS_ROOT", (self.home / ".codex/config.toml").read_text(encoding="utf-8"))

    def test_codex_env_dotted_table_is_refused(self):
        self.write_codex('''
            shell_environment_policy.set.MY_TOKEN = "secret"
        ''')
        result = self.run_install("--skills", "skill-authoring", "--targets", "codex", check=False)
        self.assertEqual(1, result.returncode)
        self.assertIn("without a [shell_environment_policy.set] header", result.stdout)
        self.assertNotIn("AGENT_TOOLS_ROOT", (self.home / ".codex/config.toml").read_text(encoding="utf-8"))

    def test_codex_env_table_is_removed_when_empty_after_uninstall(self):
        self.run_install("--skills", "skill-authoring", "--targets", "codex")
        self.run_install("--skills", "skill-authoring", "--targets", "codex", "--uninstall")
        self.assertNotIn("shell_environment_policy", (self.home / ".codex/config.toml").read_text(encoding="utf-8"))

    def test_claude_env_differing_value_is_unconverged_and_force_overwrites(self):
        settings = self.home / ".claude/settings.json"
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({"env": {"AGENT_TOOLS_ROOT": "/elsewhere", "KEEP": "1"}}), encoding="utf-8")
        result = self.run_install("--skills", "skill-authoring", "--targets", "claude", check=False)
        self.assertEqual(1, result.returncode)
        self.assertIn("claude env AGENT_TOOLS_ROOT: unconverged", result.stdout)
        self.assertEqual("/elsewhere", json.loads(settings.read_text(encoding="utf-8"))["env"]["AGENT_TOOLS_ROOT"])
        self.run_install("--skills", "skill-authoring", "--targets", "claude", "--force")
        env = json.loads(settings.read_text(encoding="utf-8"))["env"]
        self.assertEqual({"AGENT_TOOLS_ROOT": self.repo, "KEEP": "1"}, env)
        # 用户事后改值：卸载不删、不覆盖
        settings.write_text(json.dumps({"env": {"AGENT_TOOLS_ROOT": "/changed", "KEEP": "1"}}), encoding="utf-8")
        result = self.run_install("--skills", "skill-authoring", "--targets", "claude", "--uninstall")
        self.assertIn("claude env AGENT_TOOLS_ROOT: skip", result.stdout)
        self.assertEqual("/changed", json.loads(settings.read_text(encoding="utf-8"))["env"]["AGENT_TOOLS_ROOT"])

    def test_claude_env_same_value_is_claimed_and_pending_is_promoted(self):
        settings = self.home / ".claude/settings.json"
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({"env": {"AGENT_TOOLS_ROOT": self.repo}}), encoding="utf-8")
        result = self.run_install("--skills", "skill-authoring", "--targets", "claude")
        self.assertIn("claude env AGENT_TOOLS_ROOT: written", result.stdout)
        self.assertIn("AGENT_TOOLS_ROOT", self.manifest("claude")["env_entries"])
        # 写目标后、晋升前崩溃：pending 有记录、值已在 → 重跑晋升
        manifest_path = self.home / ".claude/.agent-tools-install.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["pending_env_entries"] = {"AGENT_TOOLS_ROOT": manifest["env_entries"].pop("AGENT_TOOLS_ROOT")}
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        self.run_install("--skills", "skill-authoring", "--targets", "claude")
        manifest = self.manifest("claude")
        self.assertEqual({}, manifest["pending_env_entries"])
        self.assertIn("AGENT_TOOLS_ROOT", manifest["env_entries"])

    def test_local_env_whitelist_and_render_values(self):
        local_env = REPO / "env" / "local.env"
        existed = local_env.exists()
        backup = local_env.read_text(encoding="utf-8") if existed else None
        try:
            local_env.write_text("AGENT_TOOLS_DOCS_ROOT=~/mydocs\nAGENT_TOOLS_ROOT=/evil\nUNKNOWN=1\nAGENT_TOOLS_OPEN_CMD= open {target} \nBROWSER_SESSION_TOOL_DIR=\n", encoding="utf-8")
            result = self.run_install("--skills", "skill-authoring", "--targets", "claude", "--with-global")
            self.assertIn("ignores keys AGENT_TOOLS_ROOT, UNKNOWN", result.stderr)
            env = json.loads((self.home / ".claude/settings.json").read_text(encoding="utf-8"))["env"]
            self.assertEqual(str(self.home / "mydocs"), env["AGENT_TOOLS_DOCS_ROOT"])
            self.assertEqual("open {target}", env["AGENT_TOOLS_OPEN_CMD"])
            self.assertNotIn("BROWSER_SESSION_TOOL_DIR", env)
            rendered = (self.home / ".claude/CLAUDE.md").read_text(encoding="utf-8")
            saved_home = os.environ["HOME"]
            os.environ["HOME"] = str(self.home)  # 与子进程同一 HOME 展开 ~
            try:
                values = installer._render_values(installer._load_local_env())
            finally:
                os.environ["HOME"] = saved_home
            self.assertEqual(str(self.home / "mydocs"), values["AGENT_TOOLS_DOCS_ROOT"])
            expected = installer.render_placeholders(installer.GLOBAL_SOURCE.read_text(encoding="utf-8"), values)
            self.assertEqual(expected, rendered)
            self.assertNotIn("{{", rendered)
        finally:
            if existed:
                local_env.write_text(backup, encoding="utf-8")
            else:
                local_env.unlink()

    def test_pointer_file_inputs(self):
        pointer = self.home / ".config/agent-tools/root"
        pointer.parent.mkdir(parents=True)
        pointer.write_text("garbage\n", encoding="utf-8")
        result = self.run_install("--skills", "skill-authoring", "--targets", "claude")
        self.assertIn("pointer", result.stdout)
        self.assertEqual(self.repo + "\n", pointer.read_text(encoding="utf-8"))
        # 指向另一个有效克隆（用仓库本身伪装）：仍覆盖并说明旧值
        pointer.write_text(str(REPO.parent) + "\n", encoding="utf-8")
        result = self.run_install("--skills", "skill-authoring", "--targets", "claude")
        self.assertEqual(self.repo + "\n", pointer.read_text(encoding="utf-8"))
        # 卸载时指向别的根 → 保留文件
        pointer.write_text("/other/clone\n", encoding="utf-8")
        result = self.run_install("--skills", "skill-authoring", "--targets", "claude", "--uninstall")
        self.assertIn("skip (points to another clone)", result.stdout)
        self.assertTrue(pointer.exists())

    def test_manifest_v3_is_upgraded_and_written_back_after_uninstall(self):
        manifest_path = self.home / ".claude/.agent-tools-install.json"
        manifest_path.parent.mkdir(parents=True)
        manifest_path.write_text(json.dumps({"owner": installer.OWNER, "version": 3, "links": {}, "copies": {}, "pending_copies": {}}), encoding="utf-8")
        self.run_install("--skills", "skill-authoring", "--targets", "claude", "--with-global")
        manifest = self.manifest("claude")
        self.assertEqual(4, manifest["version"])
        for field in installer.MANIFEST_V4_FIELDS:
            self.assertIn(field, manifest)
        # 只卸载 skill：全局指令副本仍在，env/pointer 也清空 → 仍是 v4 还是 v3？copies 非空、新字段全空 → 写回 v3
        self.run_install("--skills", "skill-authoring", "--targets", "claude", "--uninstall")
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(3, manifest["version"])
            for field in installer.MANIFEST_V4_FIELDS:
                self.assertNotIn(field, manifest)
            for record in manifest["copies"].values():
                self.assertNotIn("rendered", record)

    def test_manifest_has_state_with_only_new_fields(self):
        manifest = installer._new_manifest()
        self.assertFalse(installer._manifest_has_state(manifest))
        manifest["env_entries"]["AGENT_TOOLS_ROOT"] = "sha256-v1:x"
        self.assertTrue(installer._manifest_has_state(manifest))
        manifest = installer._new_manifest()
        manifest["mcp_servers_replaced"].append({"name": "devtools"})
        self.assertTrue(installer._manifest_has_state(manifest))

    def test_toml_literal_and_identity_prefix(self):
        self.assertEqual('"a\\"b"', installer._toml_literal('a"b'))
        self.assertEqual("[1, true, \"x\"]", installer._toml_literal([1, True, "x"]))
        with self.assertRaises(ValueError):
            installer._toml_literal({"a": 1})
        target = installer._mcp_targets("/srv/agent-tools")["devtools"]
        self.assertTrue(installer._identity_under_root(target, "/srv/agent-tools"))
        self.assertFalse(installer._identity_under_root(installer._mcp_targets("/srv/agent-tools-2")["devtools"], "/srv/agent-tools"))

    def test_render_agents_toml_is_valid_and_overlay_is_appended(self):
        values = {"AGENT_TOOLS_ROOT": '/weird "path"\\x'}
        for source in installer.find_agents("codex").values():
            tomllib.loads(installer._render(source, values).decode("utf-8"))
        overlay = REPO / "env" / "AGENTS.local.md"
        existed = overlay.exists()
        saved = overlay.read_text(encoding="utf-8") if existed else None
        try:
            overlay.write_text("## 本机规则\n- 占位\n", encoding="utf-8")
            rendered = installer._render(installer.GLOBAL_SOURCE, {"AGENT_TOOLS_ROOT": "/r"}).decode("utf-8")
            self.assertTrue(rendered.endswith("## 本机规则\n- 占位\n"))
            self.assertNotIn("{{AGENT_TOOLS_ROOT}}", rendered)
        finally:
            if existed:
                overlay.write_text(saved, encoding="utf-8")
            else:
                overlay.unlink()


    # ---- round-1 code review regressions (CR-001, CR-002, CR-009, CR-010, CR-011) ------

    def test_uninstall_removes_rendered_copy_after_source_changed(self):
        """CR-001：安装后 overlay 改了，卸载仍要删掉本克隆渲染的副本（记录的 source 钉死本克隆）。"""
        overlay = REPO / "env" / "AGENTS.local.md"
        existed = overlay.exists()
        saved = overlay.read_text(encoding="utf-8") if existed else None
        try:
            overlay.write_text("## 本机规则\n- v1\n", encoding="utf-8")
            self.run_install("--skills", "skill-authoring", "--targets", "claude", "--with-global")
            claude_md = self.home / ".claude/CLAUDE.md"
            self.assertTrue(claude_md.exists())
            overlay.write_text("## 本机规则\n- v2\n", encoding="utf-8")  # 当前渲染结果不再等于已安装副本
            result = self.run_install("--skills", "skill-authoring", "--targets", "claude", "--with-global", "--uninstall")
            self.assertIn("CLAUDE.md: removed", result.stdout)
            self.assertNotIn("another clone", result.stdout)
            self.assertFalse(claude_md.exists())
            manifest_path = self.home / ".claude/.agent-tools-install.json"
            if manifest_path.exists():
                self.assertNotIn(str(claude_md), json.loads(manifest_path.read_text(encoding="utf-8"))["copies"])
        finally:
            if existed:
                overlay.write_text(saved, encoding="utf-8")
            else:
                overlay.unlink()

    def test_uninstall_reports_failed_restore_with_original_and_exit_1(self):
        """CR-002：卸载时备份的原注册被第三方身份占位 → 打印 original was、退出码 1、备份保留。"""
        foreign_env = self._seed_foreign_registrations()
        self.run_install("--skills", "skill-authoring", "--with-mcp", "--force")
        # 第三方改写了 devtools 注册（既不是本仓库身份也不是备份）
        env = {**os.environ, "HOME": str(self.home)}
        subprocess.run([str(self.bin / "claude"), "mcp", "remove", "--scope", "user", "devtools"], env=env, check=True)
        subprocess.run([str(self.bin / "claude"), "mcp", "add", "--scope", "user", "devtools", "-e", "X=1", "--", "python3", "-m", "other"], env=env, check=True)
        result = self.run_install("--skills", "skill-authoring", "--with-mcp", "--targets", "claude", "--uninstall", check=False)
        self.assertEqual(1, result.returncode)
        self.assertIn("claude mcp devtools restore: unconverged", result.stdout)
        self.assertIn("original was", result.stdout)
        self.assertIn(foreign_env["GITLAB_BASE_URL"], result.stdout)
        self.assertEqual("other", self.claude_mcp()["devtools"]["args"][-1], "第三方注册不被动")
        backup = self.manifest("claude")["mcp_servers_replaced"]
        self.assertEqual(1, len(backup), "备份保留供手工恢复")

    def test_uninstall_removes_env_key_still_pending_after_interruption(self):
        """CR-009：写入后、晋升前中断，再直接卸载：两端都按预登记指纹删键。"""
        self.run_install("--skills", "skill-authoring")
        for client, read_env in (("claude", lambda: json.loads((self.home / ".claude/settings.json").read_text(encoding="utf-8")).get("env", {})),
                                 ("codex", lambda: self.codex_toml().get("shell_environment_policy", {}).get("set", {}))):
            manifest_path = self.home / f".{client}/.agent-tools-install.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["pending_env_entries"] = {"AGENT_TOOLS_ROOT": manifest["env_entries"].pop("AGENT_TOOLS_ROOT")}
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            self.assertIn("AGENT_TOOLS_ROOT", read_env())
            result = self.run_install("--skills", "skill-authoring", "--targets", client, "--uninstall")
            self.assertIn(f"{client} env AGENT_TOOLS_ROOT: removed", result.stdout)
            self.assertNotIn("AGENT_TOOLS_ROOT", read_env())

    def test_non_string_foreign_env_values_are_unconverged_without_force(self):
        """CR-010：已有数字/数组/对象值不是“键不存在”，无 --force 不覆盖并打印原因。"""
        settings = self.home / ".claude/settings.json"
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({"env": {"AGENT_TOOLS_ROOT": 123, "KEEP": "1"}}), encoding="utf-8")
        self.write_codex('''
            [shell_environment_policy.set]
            AGENT_TOOLS_ROOT = ["x"]
        ''')
        result = self.run_install("--skills", "skill-authoring", check=False)
        self.assertEqual(1, result.returncode)
        self.assertIn("claude env AGENT_TOOLS_ROOT: unconverged (existing value is not a string", result.stdout)
        self.assertIn("codex env AGENT_TOOLS_ROOT: unconverged (existing value is not a string", result.stdout)
        self.assertEqual(123, json.loads(settings.read_text(encoding="utf-8"))["env"]["AGENT_TOOLS_ROOT"])
        self.assertEqual(["x"], self.codex_toml()["shell_environment_policy"]["set"]["AGENT_TOOLS_ROOT"])
        self.run_install("--skills", "skill-authoring", "--force")
        self.assertEqual(self.repo, json.loads(settings.read_text(encoding="utf-8"))["env"]["AGENT_TOOLS_ROOT"])
        self.assertEqual(self.repo, self.codex_toml()["shell_environment_policy"]["set"]["AGENT_TOOLS_ROOT"])

    def test_restore_with_unsupported_extra_keeps_backup_and_exits_1(self):
        """CR-011：原注册的额外键是 inline table，恢复写不回去 → unconverged、备份保留、退出码 1。"""
        self.write_codex('''
            [mcp_servers.devtools]
            command = "python3"
            args = ["-m", "devtools_mcp.aggregate_server"]
            tool_timeout = { seconds = 5 }

            [mcp_servers.devtools.env]
            PYTHONPATH = "/old/clone/mcp/devtools-mcp"
        ''')
        result = self.run_install("--skills", "skill-authoring", "--with-mcp", "--targets", "codex", "--force", check=False)
        self.assertEqual(1, result.returncode, "注册成功但额外键写不回去也要报出来")
        self.assertIn("unsupported extra values for ['tool_timeout']", result.stdout)
        self.assertEqual(self.targets["devtools"]["env"], self.codex_toml()["mcp_servers"]["devtools"]["env"])
        self.assertEqual({"tool_timeout": {"seconds": 5}}, self.manifest("codex")["mcp_servers_replaced"][0]["extra"])
        result = self.run_install("--skills", "skill-authoring", "--with-mcp", "--targets", "codex", "--uninstall", check=False)
        self.assertEqual(1, result.returncode)
        self.assertIn("codex mcp devtools restore: unconverged", result.stdout)
        self.assertIn("backup kept in manifest", result.stdout)
        restored = self.codex_toml()["mcp_servers"]["devtools"]
        self.assertEqual("/old/clone/mcp/devtools-mcp", restored["env"]["PYTHONPATH"], "身份已恢复")
        self.assertEqual(1, len(self.manifest("codex")["mcp_servers_replaced"]), "备份未删")


    def test_force_then_uninstall_restores_registration_without_args_or_env(self):
        """CR-013：原注册只有 command（无 args、无 env）→ --force 备份 → 卸载恢复不抛异常、退出码 0、备份清空。"""
        self.home.joinpath(".claude.json").write_text(json.dumps({"mcpServers": {"bastion": {"command": "/usr/local/bin/bastion-mcp"}}}), encoding="utf-8")
        self.write_codex('''
            [mcp_servers.bastion]
            command = "/usr/local/bin/bastion-mcp"
        ''')
        self.run_install("--skills", "skill-authoring", "--with-mcp", "--force")
        for client in ("claude", "codex"):
            backup = next(b for b in self.manifest(client)["mcp_servers_replaced"] if b["name"] == "bastion")
            self.assertEqual(([], {}), (backup["args"], backup["env"]), "备份里 args/env 归一为空集合")
        result = self.run_install("--skills", "skill-authoring", "--with-mcp", "--uninstall")
        self.assertIn("claude mcp bastion restore: restored", result.stdout)
        self.assertIn("codex mcp bastion restore: restored", result.stdout)
        self.assertEqual("/usr/local/bin/bastion-mcp", self.claude_mcp()["bastion"]["command"])
        self.assertEqual("/usr/local/bin/bastion-mcp", self.codex_toml()["mcp_servers"]["bastion"]["command"])
        for client in ("claude", "codex"):
            self.assertFalse((self.home / f".{client}/.agent-tools-install.json").exists(), client)

    def test_codex_dotted_table_uninstall_reports_pending_key_and_keeps_state(self):
        """CR-016：标准表装好后配置被改成 dotted 形态、键只在 pending 里 → 卸载报 unconverged（remove by hand）、退出码 1、记录保留。"""
        self.run_install("--skills", "skill-authoring", "--targets", "codex")
        manifest_path = self.home / ".codex/.agent-tools-install.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["pending_env_entries"] = {"AGENT_TOOLS_ROOT": manifest["env_entries"].pop("AGENT_TOOLS_ROOT")}
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        self.write_codex(f'''
            shell_environment_policy.set.AGENT_TOOLS_ROOT = "{self.repo}"
        ''')
        result = self.run_install("--skills", "skill-authoring", "--targets", "codex", "--uninstall", check=False)
        self.assertEqual(1, result.returncode)
        self.assertIn("codex env AGENT_TOOLS_ROOT: unconverged", result.stdout)
        self.assertIn("remove AGENT_TOOLS_ROOT =", result.stdout)
        self.assertEqual(self.repo, self.codex_toml()["shell_environment_policy"]["set"]["AGENT_TOOLS_ROOT"], "配置原样")
        self.assertIn("AGENT_TOOLS_ROOT", json.loads(manifest_path.read_text(encoding="utf-8"))["pending_env_entries"], "记录保留供重试")


if __name__ == "__main__":
    unittest.main()
