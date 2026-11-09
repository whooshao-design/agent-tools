#!/usr/bin/env python3
"""Install repository skills and optional reviewer subagents for both clients.

Usage:
  python3 install.py                          # symlink all skills to both targets
  python3 install.py --groups dev-workflow    # only one skill group
  python3 install.py --skills dev-cr,code-dev # only some skills
  python3 install.py --targets claude         # only one client
  python3 install.py --copy                   # copy instead of symlink
  python3 install.py --with-subagents         # also install reviewer agents/hooks
  python3 install.py --with-global            # also render AGENTS.global.md (+ env/AGENTS.local.md) as client-level instructions
  python3 install.py --with-session-cleanup   # also add Claude SessionEnd hook that removes the session temp dir
  python3 install.py --with-mcp               # also register devtools / bastion / bastion_dba MCP servers
  python3 install.py --dry-run                # report without writing
  python3 install.py --list                   # show available groups/skills
  python3 install.py --uninstall              # remove owned installations
"""

from __future__ import annotations

import argparse
import copy as copy_module
import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
if sys.version_info < (3, 11):  # tomllib
    sys.stderr.write("install.py needs Python >= 3.11 (tomllib); found %d.%d\n" % sys.version_info[:2])
    sys.exit(2)
import tomllib
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO / "lib"))
from agent_tools.locate import render_placeholders  # noqa: E402
TARGETS = {
    "claude": Path.home() / ".claude" / "skills",
    "codex": Path.home() / ".codex" / "skills",
}
AGENT_SOURCES = {
    "claude": (REPO / "agents" / "claude", ".md"),
    "codex": (REPO / "agents" / "codex", ".toml"),
}
HOOK_CONFIG_NAMES = {
    "claude": "settings.json",
    "codex": "hooks.json",
}
OWNER = "agent-tools-subagent-result-v1"
MANIFEST_NAME = ".agent-tools-install.json"
MANIFEST_VERSION = 4
# version 4 新增的 manifest 字段；--uninstall 清空后写回 version 3 形态
MANIFEST_V4_FIELDS = (
    "env_entries",
    "pending_env_entries",
    "pointer_file",
    "pointer_fingerprint",
    "mcp_servers",
    "mcp_servers_replaced",
)
LOCAL_ENV_SOURCE = REPO / "env" / "local.env"
LOCAL_OVERLAY_SOURCE = REPO / "env" / "AGENTS.local.md"
# local.env 里用户可设的四个键；AGENT_TOOLS_ROOT 只由本文件推导
LOCAL_ENV_KEYS = (
    "AGENT_TOOLS_DOCS_ROOT",
    "AGENT_TOOLS_WORKSPACE_ROOT",
    "BROWSER_SESSION_TOOL_DIR",
    "AGENT_TOOLS_OPEN_CMD",
)
LOCAL_ENV_PATH_KEYS = LOCAL_ENV_KEYS[:3]
PLACEHOLDER_KEYS = ("AGENT_TOOLS_ROOT", "AGENT_TOOLS_DOCS_ROOT", "AGENT_TOOLS_WORKSPACE_ROOT")
POINTER_FILE = Path.home() / ".config" / "agent-tools" / "root"
CLAUDE_SETTINGS = Path.home() / ".claude" / "settings.json"
CLAUDE_MCP_CONFIG = Path.home() / ".claude.json"
CODEX_CONFIG = Path.home() / ".codex" / "config.toml"
ENV_BLOCK_START = "# >>> agent-tools (owner: agent-tools-env-v1) >>>"
ENV_BLOCK_END = "# <<< agent-tools <<<"
ENV_TABLE_HEADER = "[shell_environment_policy.set]"
MCP_IDENTITY_KEYS = ("command", "args", "env")
AGENT_NAMES = (
    "agent-tools-requirements-reviewer",
    "agent-tools-solution-reviewer",
    "agent-tools-test-design-reviewer",
    "agent-tools-change-reviewer",
)
SUBAGENT_MATCHER = "^(" + "|".join(AGENT_NAMES) + ")$"
HOOK_SOURCE = REPO / "hooks" / "subagent_result_guard.py"
GLOBAL_SOURCE = REPO / "AGENTS.global.md"
CLEANUP_SOURCE = REPO / "hooks" / "session_tmp_cleanup.py"
CLEANUP_OWNER = "agent-tools-session-cleanup-v1"
GLOBAL_NAMES = {
    "claude": "CLAUDE.md",
    "codex": "AGENTS.md",
}
HOOK_SCRIPT_PATTERN = re.compile(r"subagent_result_guard-([0-9a-f]{64})\.py")


class InstallError(RuntimeError):
    """Raised when an installation cannot proceed without risking user data."""


def find_groups() -> dict[str, Path]:
    groups = {}
    skills_root = REPO / "skills"
    if skills_root.is_dir():
        for child in sorted(skills_root.iterdir()):
            if child.is_dir():
                groups[child.name] = child
    return groups


def find_skills(groups: dict[str, Path]) -> dict[str, Path]:
    skills = {}
    for skills_dir in groups.values():
        for skill in sorted(skills_dir.iterdir()):
            if (skill / "SKILL.md").is_file():
                if skill.name in skills:
                    print(
                        f"warning: duplicate skill name {skill.name}, "
                        f"keeping {skills[skill.name]}"
                    )
                    continue
                skills[skill.name] = skill
    return skills


def find_agents(client: str) -> dict[str, Path]:
    source_dir, suffix = AGENT_SOURCES[client]
    if not source_dir.is_dir():
        return {}
    return {
        path.name: path
        for path in sorted(source_dir.iterdir())
        if path.is_file() and path.suffix == suffix
    }


def _new_manifest() -> dict[str, Any]:
    return {
        "owner": OWNER,
        "version": MANIFEST_VERSION,
        "links": {},
        "copies": {},
        "pending_copies": {},
        "env_entries": {},
        "pending_env_entries": {},
        "pointer_file": None,
        "pointer_fingerprint": None,
        "mcp_servers": [],
        "mcp_servers_replaced": [],
    }


def _load_json_object(path: Path, *, default: dict[str, Any]) -> dict[str, Any]:
    if path.is_symlink():
        raise InstallError(f"refusing to replace symlink-managed JSON file: {path}")
    if not path.exists():
        return copy_module.deepcopy(default)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InstallError(f"cannot parse JSON file {path}: {error}") from error
    if not isinstance(data, dict):
        raise InstallError(f"JSON file must contain an object: {path}")
    return data


def _load_manifest(path: Path) -> dict[str, Any]:
    manifest = _load_json_object(path, default=_new_manifest())
    if (
        manifest.get("owner") != OWNER
        or manifest.get("version") not in (1, 2, 3, MANIFEST_VERSION)
        or not isinstance(manifest.get("copies"), dict)
    ):
        raise InstallError(f"invalid ownership manifest: {path}")
    if manifest.get("version") == 1:
        manifest["links"] = {}
    if manifest.get("version") in (1, 2):
        manifest["pending_copies"] = {}
    if manifest.get("version") in (1, 2, 3):
        # 版本号抬升并补空字段
        manifest["version"] = MANIFEST_VERSION
        for field, empty in zip(MANIFEST_V4_FIELDS, ({}, {}, None, None, [], [])):
            manifest.setdefault(field, copy_module.deepcopy(empty))
    if not isinstance(manifest.get("links"), dict):
        raise InstallError(f"invalid link ownership state: {path}")
    if not isinstance(manifest.get("pending_copies"), dict):
        raise InstallError(f"invalid pending copy state: {path}")
    hook_config = manifest.get("hook_config")
    if hook_config is not None and not isinstance(hook_config, dict):
        raise InstallError(f"invalid hook ownership state: {path}")
    if not isinstance(manifest.get("env_entries"), dict) or not isinstance(
        manifest.get("pending_env_entries"), dict
    ):
        raise InstallError(f"invalid env ownership state: {path}")
    if not isinstance(manifest.get("mcp_servers"), list) or not isinstance(
        manifest.get("mcp_servers_replaced"), list
    ):
        raise InstallError(f"invalid MCP ownership state: {path}")
    return manifest


def _manifest_v3_shape(manifest: dict[str, Any]) -> dict[str, Any]:
    """卸载后六个新字段都为空时写回 version 3 形态，旧版 install.py 才读得了。"""
    if any(manifest.get(field) for field in MANIFEST_V4_FIELDS):
        return manifest
    downgraded = {
        key: value for key, value in manifest.items() if key not in MANIFEST_V4_FIELDS
    }
    downgraded["version"] = 3
    for record in downgraded["copies"].values():
        if isinstance(record, dict):
            record.pop("rendered", None)
    return downgraded


def _atomic_write(path: Path, content: bytes, *, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as file:
            fd = -1
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp_path, path)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def _json_bytes(data: dict[str, Any]) -> bytes:
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _write_json_if_needed(
    path: Path,
    before: dict[str, Any],
    after: dict[str, Any],
    *,
    dry_run: bool,
    expected_revision: tuple[int, int, int, int, str] | None | object = Ellipsis,
) -> None:
    overly_open = path.exists() and bool(stat.S_IMODE(path.stat().st_mode) & ~0o600)
    if before == after and not overly_open:
        return
    if not dry_run:
        if expected_revision is not Ellipsis:
            _check_revision(path, expected_revision)
        _atomic_write(path, _json_bytes(after))


def _file_revision(path: Path) -> tuple[int, int, int, int, str] | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if path.is_symlink():
        content_hash = hashlib.sha256(
            os.readlink(path).encode("utf-8", errors="surrogateescape")
        ).hexdigest()
    else:
        content_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    return (
        info.st_dev,
        info.st_ino,
        info.st_size,
        info.st_mtime_ns,
        content_hash,
    )


def _check_revision(
    path: Path, expected: tuple[int, int, int, int, str] | None
) -> None:
    if _file_revision(path) != expected:
        raise InstallError(f"file changed while installing; refusing to overwrite: {path}")


def _feed_hash(digest: Any, value: bytes) -> None:
    digest.update(len(value).to_bytes(8, "big"))
    digest.update(value)


def _fingerprint(path: Path) -> str:
    digest = hashlib.sha256()

    def visit(current: Path, relative: str) -> None:
        info = current.lstat()
        _feed_hash(digest, relative.encode("utf-8", errors="surrogateescape"))
        _feed_hash(digest, f"{stat.S_IMODE(info.st_mode):o}".encode("ascii"))
        if current.is_symlink():
            _feed_hash(digest, b"link")
            _feed_hash(
                digest,
                os.readlink(current).encode("utf-8", errors="surrogateescape"),
            )
        elif current.is_file():
            _feed_hash(digest, b"file")
            with current.open("rb") as file:
                while chunk := file.read(1024 * 1024):
                    digest.update(chunk)
        elif current.is_dir():
            _feed_hash(digest, b"dir")
            for child in sorted(current.iterdir(), key=lambda item: item.name):
                child_relative = child.name if relative == "." else f"{relative}/{child.name}"
                visit(child, child_relative)
        else:
            _feed_hash(digest, b"other")

    visit(path, ".")
    return f"sha256-v1:{digest.hexdigest()}"


def _path_revision(path: Path) -> tuple[int, int, int, int, str] | None:
    """Capture a revision for a file, directory, symlink, or absent path."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    return (
        info.st_dev,
        info.st_ino,
        info.st_size,
        info.st_mtime_ns,
        _fingerprint(path),
    )


def _check_path_revision(
    path: Path, expected: tuple[int, int, int, int, str] | None
) -> None:
    if _path_revision(path) != expected:
        raise InstallError(
            f"reviewer target changed while installing; refusing to continue: {path}"
        )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def _copy_path(src: Path, dst: Path) -> None:
    temporary = dst.with_name(
        f".{dst.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    )
    try:
        if src.is_dir():
            shutil.copytree(src, temporary, symlinks=True)
        else:
            shutil.copy2(src, temporary)
        os.replace(temporary, dst)
    finally:
        if temporary.exists() or temporary.is_symlink():
            _remove_path(temporary)


def _link_path(src: Path, dst: Path) -> None:
    temporary = dst.with_name(
        f".{dst.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    )
    try:
        temporary.symlink_to(src)
        os.replace(temporary, dst)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _copy_record(
    manifest: dict[str, Any], dst: Path, src: Path
) -> dict[str, Any] | None:
    candidates = [
        manifest["copies"].get(str(dst)),
        manifest["pending_copies"].get(str(dst)),
    ]
    valid = [
        record
        for record in candidates
        if isinstance(record, dict)
        and record.get("source") == str(src.resolve())
        and isinstance(record.get("fingerprint"), str)
    ]
    if dst.exists() and not dst.is_symlink():
        current = _fingerprint(dst)
        for record in valid:
            if record["fingerprint"] == current:
                return record
    return valid[0] if valid else None


def _record_link(manifest: dict[str, Any], dst: Path, src: Path) -> None:
    manifest["links"][str(dst)] = str(src.resolve())
    manifest["copies"].pop(str(dst), None)
    manifest["pending_copies"].pop(str(dst), None)


def install(
    name: str,
    src: Path,
    target_dir: Path,
    copy: bool,
    force: bool,
    *,
    manifest: dict[str, Any] | None = None,
    dry_run: bool = False,
) -> str:
    manifest = manifest if manifest is not None else _new_manifest()
    dst = target_dir / name
    record = _copy_record(manifest, dst, src)

    if dst.is_symlink():
        same_source = dst.resolve() == src.resolve()
        if same_source and not copy:
            _record_link(manifest, dst, src)
            return "ok"
        if not same_source and not force:
            return "skip (foreign link, use --force)"
        if not dry_run:
            dst.unlink()
        manifest["copies"].pop(str(dst), None)
        manifest["pending_copies"].pop(str(dst), None)
        manifest["links"].pop(str(dst), None)
    elif dst.exists():
        owned_unchanged = (
            record is not None
            and _fingerprint(dst) == record["fingerprint"]
        )
        if copy and owned_unchanged and _fingerprint(src) == record["fingerprint"]:
            manifest["copies"][str(dst)] = copy_module.deepcopy(record)
            manifest["pending_copies"].pop(str(dst), None)
            manifest["links"].pop(str(dst), None)
            return "ok"
        if not owned_unchanged and not force:
            return "skip (exists, use --force)"
        if not dry_run:
            _remove_path(dst)
        manifest["copies"].pop(str(dst), None)
        manifest["pending_copies"].pop(str(dst), None)
        manifest["links"].pop(str(dst), None)

    if not dry_run:
        target_dir.mkdir(parents=True, exist_ok=True)
    if copy:
        if not dry_run:
            _copy_path(src, dst)
            fingerprint = _fingerprint(dst)
        else:
            fingerprint = _fingerprint(src)
        manifest["copies"][str(dst)] = {
            "source": str(src.resolve()),
            "fingerprint": fingerprint,
        }
        manifest["pending_copies"].pop(str(dst), None)
        manifest["links"].pop(str(dst), None)
        return "would copy" if dry_run else "copied"

    _record_link(manifest, dst, src)
    if not dry_run:
        _link_path(src, dst)
    return "would link" if dry_run else "linked"


def uninstall(
    name: str,
    src: Path,
    target_dir: Path,
    *,
    manifest: dict[str, Any] | None = None,
    dry_run: bool = False,
) -> str:
    manifest = manifest if manifest is not None else _new_manifest()
    dst = target_dir / name
    record = _copy_record(manifest, dst, src)

    if dst.is_symlink():
        if dst.resolve() != src.resolve():
            return "skip (foreign link)"
        if not dry_run:
            dst.unlink()
        manifest["copies"].pop(str(dst), None)
        manifest["pending_copies"].pop(str(dst), None)
        manifest["links"].pop(str(dst), None)
        return "would remove" if dry_run else "removed"
    if dst.exists():
        if record is None:
            return "skip (unowned path)"
        if _fingerprint(dst) != record["fingerprint"]:
            return "skip (owned copy modified)"
        if not dry_run:
            _remove_path(dst)
        manifest["copies"].pop(str(dst), None)
        manifest["pending_copies"].pop(str(dst), None)
        manifest["links"].pop(str(dst), None)
        return "would remove" if dry_run else "removed"

    manifest["copies"].pop(str(dst), None)
    manifest["pending_copies"].pop(str(dst), None)
    manifest["links"].pop(str(dst), None)
    return "absent"


def _command_tokens(command: Any) -> list[str]:
    if not isinstance(command, str):
        return []
    try:
        return shlex.split(command)
    except ValueError:
        return []


def _is_owned_handler(handler: Any) -> bool:
    if not isinstance(handler, dict):
        return False
    tokens = _command_tokens(handler.get("command"))
    return any(
        token == f"--owner={OWNER}"
        or (token == "--owner" and index + 1 < len(tokens) and tokens[index + 1] == OWNER)
        for index, token in enumerate(tokens)
    )


def _merge_hook_config(
    data: dict[str, Any],
    *,
    client: str,
    script: Path | None,
    install_hook: bool,
    ownership: dict[str, Any] | None,
) -> tuple[dict[str, Any], bool]:
    updated = copy_module.deepcopy(data)
    hooks = updated.get("hooks")
    if hooks is None:
        if not install_hook:
            return updated, False
        hooks = {}
        updated["hooks"] = hooks
    if not isinstance(hooks, dict):
        raise InstallError("hooks must be a JSON object")

    groups = hooks.get("SubagentStop")
    if groups is None:
        groups = []
        if not install_hook:
            return updated, False
    if not isinstance(groups, list):
        raise InstallError("hooks.SubagentStop must be a JSON array")

    removed_owned = False
    retained_groups = []
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
            retained_groups.append(group)
            continue
        retained_handlers = []
        for handler in group["hooks"]:
            if _is_owned_handler(handler):
                removed_owned = True
            else:
                retained_handlers.append(handler)
        if retained_handlers or group.get("matcher") != SUBAGENT_MATCHER:
            retained_group = copy_module.deepcopy(group)
            retained_group["hooks"] = retained_handlers
            retained_groups.append(retained_group)

    if install_hook:
        assert script is not None
        command = (
            f"{shlex.quote(sys.executable)} {shlex.quote(str(script))} "
            f"--client {client} --owner {OWNER}"
        )
        retained_groups.append(
            {
                "matcher": SUBAGENT_MATCHER,
                "hooks": [
                    {
                        "type": "command",
                        "command": command,
                        "timeout": 5,
                        "statusMessage": "正在校验独立评审结果",
                    }
                ],
            }
        )
    elif removed_owned and ownership:
        if ownership.get("created_subagent_stop") and not retained_groups:
            hooks.pop("SubagentStop", None)
        else:
            hooks["SubagentStop"] = retained_groups
        if ownership.get("created_hooks") and not hooks:
            updated.pop("hooks", None)
        return updated, True

    hooks["SubagentStop"] = retained_groups
    return updated, removed_owned


def _merge_session_cleanup_hook(
    data: dict[str, Any], *, install_hook: bool
) -> dict[str, Any]:
    """Add or remove the owned Claude SessionEnd handler, keeping all others."""
    updated = copy_module.deepcopy(data)
    hooks = updated.get("hooks")
    if hooks is None:
        if not install_hook:
            return updated
        hooks = updated["hooks"] = {}
    if not isinstance(hooks, dict):
        raise InstallError("hooks must be a JSON object")
    groups = hooks.get("SessionEnd", [])
    if not isinstance(groups, list):
        raise InstallError("hooks.SessionEnd must be a JSON array")

    def owned(handler: Any) -> bool:
        tokens = _command_tokens(handler.get("command")) if isinstance(handler, dict) else []
        return f"--owner={CLEANUP_OWNER}" in tokens or any(
            token == "--owner" and tokens[index + 1 : index + 2] == [CLEANUP_OWNER]
            for index, token in enumerate(tokens)
        )

    retained = []
    for group in groups:
        if isinstance(group, dict) and isinstance(group.get("hooks"), list):
            handlers = [handler for handler in group["hooks"] if not owned(handler)]
            if not handlers and len(handlers) != len(group["hooks"]):
                continue
            group = {**group, "hooks": handlers}
        retained.append(group)
    if install_hook:
        command = (
            f"{shlex.quote(sys.executable)} {shlex.quote(str(CLEANUP_SOURCE))} "
            f"--owner {CLEANUP_OWNER}"
        )
        retained.append({"hooks": [{"type": "command", "command": command, "timeout": 10}]})
    if retained:
        hooks["SessionEnd"] = retained
    else:
        hooks.pop("SessionEnd", None)
        if not hooks:
            updated.pop("hooks", None)
    return updated


def _install_session_cleanup(*, uninstalling: bool, dry_run: bool) -> None:
    config_path = TARGETS["claude"].parent / HOOK_CONFIG_NAMES["claude"]
    revision = _file_revision(config_path)
    before = _load_json_object(config_path, default={})
    after = _merge_session_cleanup_hook(before, install_hook=not uninstalling)
    _write_json_if_needed(
        config_path, before, after, dry_run=dry_run, expected_revision=revision
    )
    if before == after:
        status = "ok" if not uninstalling else "absent"
    elif dry_run:
        status = "would remove" if uninstalling else "would add"
    else:
        status = "removed" if uninstalling else "added"
    print(f"  [hook] SessionEnd session cleanup: {status}")


def _install_hook_script(client_root: Path, *, dry_run: bool) -> tuple[Path, str]:
    if not HOOK_SOURCE.is_file():
        raise InstallError(f"hook source not found: {HOOK_SOURCE}")
    content = HOOK_SOURCE.read_bytes()
    content_hash = hashlib.sha256(content).hexdigest()
    hook_dir = client_root / "hooks" / "agent-tools"
    destination = hook_dir / f"subagent_result_guard-{content_hash}.py"

    if destination.exists() or destination.is_symlink():
        if not destination.is_file() or destination.is_symlink():
            raise InstallError(f"hook destination is not an owned file: {destination}")
        if _sha256_file(destination) != content_hash:
            raise InstallError(f"hook destination content does not match its hash: {destination}")
        overly_open = bool(stat.S_IMODE(destination.stat().st_mode) & ~0o600)
        if overly_open and not dry_run:
            _atomic_write(destination, content)
        return destination, "ok"

    if not dry_run:
        _atomic_write(destination, content)
    return destination, "would copy" if dry_run else "copied"


def _cleanup_hook_scripts(
    client_root: Path, *, keep: Path | None, dry_run: bool
) -> int:
    hook_dir = client_root / "hooks" / "agent-tools"
    if not hook_dir.is_dir():
        return 0
    removed = 0
    for path in hook_dir.glob("subagent_result_guard-*.py"):
        if keep is not None and path == keep:
            continue
        match = HOOK_SCRIPT_PATTERN.fullmatch(path.name)
        if (
            match is None
            or not path.is_file()
            or path.is_symlink()
            or _sha256_file(path) != match.group(1)
        ):
            continue
        if not dry_run:
            path.unlink()
        removed += 1
    return removed


def _manifest_has_state(manifest: dict[str, Any]) -> bool:
    return bool(
        manifest["links"]
        or manifest["copies"]
        or manifest["pending_copies"]
        or manifest.get("hook_config")
        or any(manifest.get(field) for field in MANIFEST_V4_FIELDS)
    )


def _save_manifest(
    path: Path,
    before: dict[str, Any],
    after: dict[str, Any],
    *,
    dry_run: bool,
    expected_revision: tuple[int, int, int, int, str] | None,
) -> None:
    if not _manifest_has_state(after):
        if path.exists() and not dry_run:
            _check_revision(path, expected_revision)
            path.unlink()
        return
    _write_json_if_needed(
        path,
        before,
        after,
        dry_run=dry_run,
        expected_revision=expected_revision,
    )


def _prepare_targets(
    clients: list[str], *, with_subagents: bool
) -> dict[str, dict[str, Any]]:
    states = {}
    for client in clients:
        root = TARGETS[client].parent
        manifest_path = root / MANIFEST_NAME
        manifest = _load_manifest(manifest_path)
        state = {
            "root": root,
            "manifest_path": manifest_path,
            "manifest_revision": _file_revision(manifest_path),
            "manifest_before": copy_module.deepcopy(manifest),
            "manifest": manifest,
        }
        if with_subagents:
            config_path = root / HOOK_CONFIG_NAMES[client]
            hook_config = _load_json_object(config_path, default={})
            hooks = hook_config.get("hooks")
            if hooks is not None and not isinstance(hooks, dict):
                raise InstallError(f"hooks must be a JSON object: {config_path}")
            if isinstance(hooks, dict):
                groups = hooks.get("SubagentStop")
                if groups is not None and not isinstance(groups, list):
                    raise InstallError(
                        f"hooks.SubagentStop must be a JSON array: {config_path}"
                    )
            state.update(
                {
                    "config_path": config_path,
                    "config_revision": _file_revision(config_path),
                    "config_before": copy_module.deepcopy(hook_config),
                    "config": hook_config,
                }
            )
        states[client] = state
    return states


def _check_target_revisions(
    states: dict[str, dict[str, Any]], *, with_subagents: bool
) -> None:
    for state in states.values():
        _check_revision(state["manifest_path"], state["manifest_revision"])
        if with_subagents:
            _check_revision(state["config_path"], state["config_revision"])


def _preflight_subagent_targets(
    clients: list[str], states: dict[str, dict[str, Any]], *, force: bool
) -> dict[Path, tuple[int, int, int, int, str] | None]:
    """Reject foreign reviewer targets across all clients before any write."""
    conflicts = []
    revisions = {}
    for client in clients:
        source_dir, suffix = AGENT_SOURCES[client]
        agents_dir = states[client]["root"] / "agents"
        for agent_name in AGENT_NAMES:
            source = source_dir / f"{agent_name}{suffix}"
            if not source.is_file():
                raise InstallError(f"reviewer source not found: {source}")

            destination = agents_dir / source.name
            revisions[destination] = _path_revision(destination)
            if destination.is_symlink():
                if destination.resolve() != source.resolve():
                    conflicts.append(destination)
                continue
            if not destination.exists():
                continue

            record = _copy_record(states[client]["manifest"], destination, source)
            if record is None or _fingerprint(destination) != record["fingerprint"]:
                conflicts.append(destination)

    if conflicts and not force:
        joined = ", ".join(str(path) for path in conflicts)
        raise InstallError(
            f"foreign reviewer target(s), use --force to replace: {joined}"
        )
    return revisions


def _check_subagent_target_revisions(
    revisions: dict[Path, tuple[int, int, int, int, str] | None],
) -> None:
    for path, expected in revisions.items():
        _check_path_revision(path, expected)


def _promote_completed_pending_copies(
    client: str, state: dict[str, Any], *, dry_run: bool
) -> None:
    """Commit pending ownership when the planned copy already reached its target."""
    manifest = state["manifest"]
    allowed_parents = {TARGETS[client], state["root"] / "agents", state["root"]}
    changed = False

    for destination, record in list(manifest["pending_copies"].items()):
        destination_path = Path(destination)
        if destination_path.parent not in allowed_parents or not isinstance(record, dict):
            raise InstallError(f"invalid pending copy record: {destination}")
        source_value = record.get("source")
        fingerprint = record.get("fingerprint")
        source = Path(source_value) if isinstance(source_value, str) else None
        if source is None or not isinstance(fingerprint, str):
            raise InstallError(f"invalid pending copy record: {destination}")
        if not source.is_relative_to(REPO):
            raise InstallError(f"pending copy source is outside repository: {source}")
        if (
            destination_path.exists()
            and not destination_path.is_symlink()
            and _fingerprint(destination_path) == fingerprint
        ):
            manifest["copies"][destination] = copy_module.deepcopy(record)
            manifest["pending_copies"].pop(destination)
            changed = True

    if not changed:
        return
    _save_manifest(
        state["manifest_path"],
        state["manifest_before"],
        manifest,
        dry_run=dry_run,
        expected_revision=state["manifest_revision"],
    )
    if not dry_run:
        state["manifest_before"] = copy_module.deepcopy(manifest)
        state["manifest_revision"] = _file_revision(state["manifest_path"])


def _cleanup_stale_ownership(
    client: str, state: dict[str, Any], *, dry_run: bool
) -> None:
    """Remove unchanged owned installs whose repository source disappeared."""
    manifest = state["manifest"]
    allowed_parents = {TARGETS[client], state["root"] / "agents", state["root"]}
    changed = False

    for destination, source_value in list(manifest["links"].items()):
        destination_path = Path(destination)
        source = Path(source_value) if isinstance(source_value, str) else None
        if destination_path.parent not in allowed_parents or source is None:
            raise InstallError(f"invalid owned link record: {destination}")
        if not source.is_relative_to(REPO):
            raise InstallError(f"owned link source is outside repository: {source}")
        if source.exists():
            continue
        if not destination_path.exists() and not destination_path.is_symlink():
            manifest["links"].pop(destination)
            changed = True
            continue
        if destination_path.is_symlink() and destination_path.resolve() == source.resolve():
            if not dry_run:
                destination_path.unlink()
            manifest["links"].pop(destination)
            changed = True
            print(f"  stale link: {'would remove' if dry_run else 'removed'} {destination}")
        else:
            print(f"  stale link: skip modified/foreign path {destination}")

    for record_key in ("copies", "pending_copies"):
        for destination, record in list(manifest[record_key].items()):
            destination_path = Path(destination)
            if destination_path.parent not in allowed_parents or not isinstance(record, dict):
                raise InstallError(f"invalid owned copy record: {destination}")
            source_value = record.get("source")
            fingerprint = record.get("fingerprint")
            source = Path(source_value) if isinstance(source_value, str) else None
            if source is None or not isinstance(fingerprint, str):
                raise InstallError(f"invalid owned copy record: {destination}")
            if not source.is_relative_to(REPO):
                raise InstallError(f"owned copy source is outside repository: {source}")
            if source.exists():
                continue
            if not destination_path.exists() and not destination_path.is_symlink():
                manifest[record_key].pop(destination)
                changed = True
                continue
            if (
                not destination_path.is_symlink()
                and _fingerprint(destination_path) == fingerprint
            ):
                if not dry_run:
                    _remove_path(destination_path)
                manifest["copies"].pop(destination, None)
                manifest["pending_copies"].pop(destination, None)
                changed = True
                print(
                    f"  stale copy: {'would remove' if dry_run else 'removed'} "
                    f"{destination}"
                )
            else:
                print(f"  stale copy: skip modified/foreign path {destination}")

    if not changed:
        return
    _save_manifest(
        state["manifest_path"],
        state["manifest_before"],
        manifest,
        dry_run=dry_run,
        expected_revision=state["manifest_revision"],
    )
    if not dry_run:
        state["manifest_before"] = copy_module.deepcopy(manifest)
        state["manifest_revision"] = _file_revision(state["manifest_path"])


def _stage_copy_ownership(
    client: str,
    state: dict[str, Any],
    skills: dict[str, Path],
    *,
    force: bool,
    with_subagents: bool,
    with_global: bool,
    dry_run: bool,
) -> None:
    """Persist planned copy ownership before files can be partially installed."""
    planned = copy_module.deepcopy(state["manifest"])
    simulated = copy_module.deepcopy(planned)
    # 全局指令副本与 agents 是渲染对象，由 _install_rendered() 自行预登记渲染后内容的指纹
    for name, source in skills.items():
        install(
            name,
            source,
            TARGETS[client],
            copy=True,
            force=force,
            manifest=simulated,
            dry_run=True,
        )
    if with_subagents:
        if not isinstance(planned.get("hook_config"), dict):
            config = state["config"]
            hooks = config.get("hooks")
            planned["hook_config"] = {
                "created_hooks": "hooks" not in config,
                "created_subagent_stop": not (
                    isinstance(hooks, dict) and "SubagentStop" in hooks
                ),
            }

    for destination, record in simulated["copies"].items():
        if planned["copies"].get(destination) != record:
            planned["pending_copies"][destination] = copy_module.deepcopy(record)

    _save_manifest(
        state["manifest_path"],
        state["manifest_before"],
        planned,
        dry_run=dry_run,
        expected_revision=state["manifest_revision"],
    )
    state["manifest"] = planned
    if not dry_run:
        state["manifest_before"] = copy_module.deepcopy(planned)
        state["manifest_revision"] = _file_revision(state["manifest_path"])


def _install_subagents(
    client: str,
    state: dict[str, Any],
    *,
    values: dict[str, str],
    force: bool,
    uninstalling: bool,
    dry_run: bool,
) -> None:
    root = state["root"]
    manifest = state["manifest"]
    agents_dir = root / "agents"
    print(f"  [{client} subagents]")
    for name, source in find_agents(client).items():
        if uninstalling:
            status = _uninstall_rendered(
                name, source, agents_dir, _render(source, values), state=state, dry_run=dry_run
            )
        else:
            status = _install_rendered(
                name,
                source,
                agents_dir,
                _render(source, values),
                state=state,
                force=force,
                dry_run=dry_run,
            )
            if status.startswith("skip"):
                raise InstallError(
                    f"reviewer target became unsafe while installing: "
                    f"{agents_dir / source.name} ({status})"
                )
        print(f"    {name}: {status}")

    config_before = state["config"]
    ownership = manifest.get("hook_config")
    if uninstalling:
        updated, _ = _merge_hook_config(
            config_before,
            client=client,
            script=None,
            install_hook=False,
            ownership=ownership if isinstance(ownership, dict) else None,
        )
        _write_json_if_needed(
            state["config_path"],
            state["config_before"],
            updated,
            dry_run=dry_run,
            expected_revision=state["config_revision"],
        )
        removed = _cleanup_hook_scripts(root, keep=None, dry_run=dry_run)
        manifest.pop("hook_config", None)
        print(f"    SubagentStop hook: removed ({removed} script(s))")
        return

    hooks_existed = "hooks" in config_before
    subagent_stop_existed = (
        isinstance(config_before.get("hooks"), dict)
        and "SubagentStop" in config_before["hooks"]
    )
    if not isinstance(ownership, dict):
        manifest["hook_config"] = {
            "created_hooks": not hooks_existed,
            "created_subagent_stop": not subagent_stop_existed,
        }

    script, script_status = _install_hook_script(root, dry_run=dry_run)
    updated, _ = _merge_hook_config(
        config_before,
        client=client,
        script=script,
        install_hook=True,
        ownership=manifest["hook_config"],
    )
    _write_json_if_needed(
        state["config_path"],
        state["config_before"],
        updated,
        dry_run=dry_run,
        expected_revision=state["config_revision"],
    )
    removed = _cleanup_hook_scripts(root, keep=script, dry_run=dry_run)
    print(
        f"    SubagentStop hook: {script_status}"
        + (f", cleaned {removed} old script(s)" if removed else "")
    )


def _persist_manifest(state: dict[str, Any], *, dry_run: bool) -> None:
    """每个新增步骤完成后立即保存 manifest，并刷新 before / revision 以便下一步再保存。"""
    _save_manifest(
        state["manifest_path"],
        state["manifest_before"],
        state["manifest"],
        dry_run=dry_run,
        expected_revision=state["manifest_revision"],
    )
    if not dry_run:
        state["manifest_before"] = copy_module.deepcopy(state["manifest"])
        state["manifest_revision"] = _file_revision(state["manifest_path"])


def _value_fingerprint(value: str) -> str:
    return "sha256-v1:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _content_fingerprint(content: bytes, mode: int = 0o644) -> str:
    """与 _fingerprint() 对同一内容、同一权限位的普通文件给出相同结果。"""
    digest = hashlib.sha256()
    _feed_hash(digest, b".")
    _feed_hash(digest, f"{mode:o}".encode("ascii"))
    _feed_hash(digest, b"file")
    digest.update(content)
    return f"sha256-v1:{digest.hexdigest()}"


def _read_env_file(path: Path) -> dict[str, str]:
    """KEY=VALUE 文本；# 开头与空行跳过，不处理引号、export 前缀与行内注释，重复键后者覆盖。"""
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return values
    except OSError as error:
        raise InstallError(f"cannot read {path}: {error}") from error
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        values[key.strip()] = value.strip()
    return values


def _load_local_env() -> dict[str, str]:
    """读 env/local.env 的四个白名单键，加上推导的 AGENT_TOOLS_ROOT。

    三个路径键去掉两端空白并展开开头的 ~ 后写成绝对路径；AGENT_TOOLS_OPEN_CMD 原样；
    键不存在与值为空同样视为未设置，不进入返回值；其他键忽略并在 stderr 列出。
    """
    values: dict[str, str] = {"AGENT_TOOLS_ROOT": str(REPO)}
    ignored = []
    for key, raw in _read_env_file(LOCAL_ENV_SOURCE).items():
        if key not in LOCAL_ENV_KEYS:
            ignored.append(key)
            continue
        if not raw:
            continue
        if key in LOCAL_ENV_PATH_KEYS:
            raw = str(Path(raw).expanduser())
            if not Path(raw).is_absolute():
                raw = str((REPO / raw).resolve())
        values[key] = raw
    if ignored:
        print(
            f"warning: {LOCAL_ENV_SOURCE} ignores keys {', '.join(sorted(ignored))} "
            f"(only {', '.join(LOCAL_ENV_KEYS)} are read; AGENT_TOOLS_ROOT is derived)",
            file=sys.stderr,
        )
    return values


def _render_values(values: dict[str, str]) -> dict[str, str]:
    """渲染占位符用的三个值；未设置的文档根与工作区根填默认值展开后的绝对路径。"""
    home = Path.home()
    return {
        "AGENT_TOOLS_ROOT": values["AGENT_TOOLS_ROOT"],
        "AGENT_TOOLS_DOCS_ROOT": values.get("AGENT_TOOLS_DOCS_ROOT", str(home / "docs")),
        "AGENT_TOOLS_WORKSPACE_ROOT": values.get("AGENT_TOOLS_WORKSPACE_ROOT", str(home / "projects")),
    }


def _render(source: Path, values: dict[str, str]) -> bytes:
    """渲染全局指令源文件或 agent 文件：替换三个占位符；TOML 先转义再解析校验；全局指令追加 overlay。"""
    try:
        text = source.read_text(encoding="utf-8")
    except OSError as error:
        raise InstallError(f"cannot read render source {source}: {error}") from error
    rendered_values = _render_values(values)
    if source.suffix == ".toml":
        rendered_values = {
            key: value.replace("\\", "\\\\").replace('"', '\\"')
            for key, value in rendered_values.items()
        }
    try:
        text = render_placeholders(text, rendered_values)
    except ValueError as error:
        raise InstallError(f"{source}: {error}") from error
    if source.suffix == ".toml":
        try:
            tomllib.loads(text)
        except tomllib.TOMLDecodeError as error:
            raise InstallError(f"rendered TOML is invalid for {source}: {error}") from error
    if source == GLOBAL_SOURCE and LOCAL_OVERLAY_SOURCE.is_file():
        overlay = LOCAL_OVERLAY_SOURCE.read_text(encoding="utf-8")
        if not text.endswith("\n"):
            text += "\n"
        text += "\n" + overlay
    return text.encode("utf-8")


def _install_rendered(
    name: str,
    source: Path,
    target_dir: Path,
    content: bytes,
    *,
    state: dict[str, Any],
    force: bool,
    dry_run: bool,
) -> str:
    """以复制方式安装渲染副本；写目标前把渲染后内容的指纹预登记到 pending_copies。"""
    manifest = state["manifest"]
    dst = target_dir / name
    record = _copy_record(manifest, dst, source)
    fingerprint = _content_fingerprint(content)

    if dst.is_symlink():
        if dst.resolve() != source.resolve() and not force:
            return "skip (foreign link, use --force)"
        if not dry_run:
            dst.unlink()
        for key in ("copies", "pending_copies", "links"):
            manifest[key].pop(str(dst), None)
    elif dst.exists():
        owned_unchanged = record is not None and _fingerprint(dst) == record["fingerprint"]
        if owned_unchanged and record["fingerprint"] == fingerprint:
            manifest["copies"][str(dst)] = {**record, "rendered": True}
            manifest["pending_copies"].pop(str(dst), None)
            return "ok"
        if not owned_unchanged and not force:
            return "skip (exists, use --force)"
        if not dry_run:
            _remove_path(dst)
        for key in ("copies", "pending_copies", "links"):
            manifest[key].pop(str(dst), None)

    pending = {"source": str(source.resolve()), "fingerprint": fingerprint, "rendered": True}
    manifest["pending_copies"][str(dst)] = copy_module.deepcopy(pending)
    _persist_manifest(state, dry_run=dry_run)
    if not dry_run:
        target_dir.mkdir(parents=True, exist_ok=True)
        _atomic_write(dst, content, mode=0o644)
    manifest["copies"][str(dst)] = pending
    manifest["pending_copies"].pop(str(dst), None)
    manifest["links"].pop(str(dst), None)
    return "would copy" if dry_run else "copied"


def _uninstall_rendered(
    name: str,
    source: Path,
    target_dir: Path,
    own_content: bytes,
    *,
    state: dict[str, Any],
    dry_run: bool,
) -> str:
    """只删本克隆渲染出的副本：目标指纹等于当前渲染结果，或等于 manifest 记录（记录的 source 已钉死本克隆，
    源文件或渲染值在安装后变了也算自有）才删；没有记录且内容不是本克隆渲染结果的副本（另一克隆或用户写的）保留。"""
    manifest = state["manifest"]
    dst = target_dir / name
    if dst.is_symlink():
        if dst.resolve() != source.resolve():
            return "skip (foreign link)"
        if not dry_run:
            dst.unlink()
        for key in ("copies", "pending_copies", "links"):
            manifest[key].pop(str(dst), None)
        return "would remove" if dry_run else "removed"
    if dst.exists():
        record = _copy_record(manifest, dst, source)
        current = _fingerprint(dst)
        if current == _content_fingerprint(own_content) or (record is not None and current == record["fingerprint"]):
            if not dry_run:
                _remove_path(dst)
            for key in ("copies", "pending_copies", "links"):
                manifest[key].pop(str(dst), None)
            return "would remove" if dry_run else "removed"
        return "skip (unowned path)" if record is None else "skip (owned copy modified)"
    for key in ("copies", "pending_copies", "links"):
        manifest[key].pop(str(dst), None)
    return "absent"


# ---------------------------------------------------------------------------
# 本机配置变量：Claude settings.json 的 env 对象 / Codex config.toml 的标记块


def _env_key_action(
    manifest: dict[str, Any], key: str, current: str | None, target: str, *, force: bool
) -> str:
    """write | unconverged：键不存在则写；当前值指纹等于记录、等于预登记或等于目标值则覆盖。"""
    if current is None or current == target or force:
        return "write"
    fingerprint = _value_fingerprint(current)
    if fingerprint in (manifest["env_entries"].get(key), manifest["pending_env_entries"].get(key)):
        return "write"
    return "unconverged"


def _install_claude_env(
    values: dict[str, str],
    state: dict[str, Any],
    *,
    uninstalling: bool,
    force: bool,
    dry_run: bool,
) -> list[tuple[str, str, str]]:
    manifest = state["manifest"]
    results = []
    revision = _file_revision(CLAUDE_SETTINGS)
    before = _load_json_object(CLAUDE_SETTINGS, default={})
    env = before.get("env")
    if env is not None and not isinstance(env, dict):
        raise InstallError(f"env must be a JSON object: {CLAUDE_SETTINGS}")
    after = copy_module.deepcopy(before)
    env_after = after.setdefault("env", {}) if not uninstalling else after.get("env", {})

    if uninstalling:
        # 预登记（写入后、晋升前中断）的键同样归本安装器：按预登记指纹一起删
        owned = dict(manifest["env_entries"])
        owned.update(manifest["pending_env_entries"])
        for key in list(owned):
            current = env_after.get(key)
            if current is None:
                manifest["env_entries"].pop(key, None)
                results.append((f"claude env {key}", "absent", ""))
                continue
            if key == "AGENT_TOOLS_ROOT" and current != values["AGENT_TOOLS_ROOT"]:
                results.append((f"claude env {key}", "skip (owned by another clone)", f"current value {current}"))
                continue
            if not isinstance(current, str) or _value_fingerprint(current) != owned[key]:
                results.append((f"claude env {key}", "skip (value modified)", "kept as is"))
                continue
            env_after.pop(key)
            manifest["env_entries"].pop(key, None)
            results.append((f"claude env {key}", "would remove" if dry_run else "removed", ""))
        manifest["pending_env_entries"].clear()
        if not env_after and "env" in after:
            after.pop("env")
    else:
        for key in ("AGENT_TOOLS_ROOT", *LOCAL_ENV_KEYS):
            if key not in values:
                continue
            target = values[key]
            current = env_after.get(key)
            if isinstance(current, str) and current == target and key in manifest["env_entries"]:
                results.append((f"claude env {key}", "ok", ""))
                continue
            if current is not None and not isinstance(current, str):
                # 外来的非字符串值（数字、数组、对象）不是“键不存在”，无 --force 不覆盖
                action = "write" if force else "unconverged"
                reason = f"existing value is not a string ({CLAUDE_SETTINGS}); use --force"
            else:
                action = _env_key_action(manifest, key, current, target, force=force)
                reason = f"existing value differs ({CLAUDE_SETTINGS}); use --force"
            if action == "unconverged":
                results.append((f"claude env {key}", "unconverged", reason))
                continue
            manifest["pending_env_entries"][key] = _value_fingerprint(target)
            _persist_manifest(state, dry_run=dry_run)
            env_after[key] = target
            results.append((f"claude env {key}", "would write" if dry_run else "written", ""))

    _write_json_if_needed(CLAUDE_SETTINGS, before, after, dry_run=dry_run, expected_revision=revision)
    if not uninstalling:
        for key in list(manifest["pending_env_entries"]):
            if key in values and env_after.get(key) == values[key]:
                manifest["env_entries"][key] = manifest["pending_env_entries"].pop(key)
    _persist_manifest(state, dry_run=dry_run)
    return results


def _toml_literal(value: Any) -> str:
    """只接受字符串、整数、浮点、布尔与这四类标量的数组；其他类型抛 ValueError。"""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int) or isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        escaped = (
            value.replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("\n", "\\n")
            .replace("\t", "\\t")
            .replace("\r", "\\r")
        )
        return f'"{escaped}"'
    if isinstance(value, list) and all(
        isinstance(item, (str, int, float, bool)) for item in value
    ):
        return "[" + ", ".join(_toml_literal(item) for item in value) + "]"
    raise ValueError(f"unsupported TOML value: {value!r}")


TOML_KEY_LINE = re.compile(r'^\s*(?:"(?P<quoted>[^"]+)"|(?P<bare>[A-Za-z0-9_-]+))\s*=')
TOML_HEADER_LINE = re.compile(r"^\s*\[")


def _toml_key_of(line: str) -> str | None:
    match = TOML_KEY_LINE.match(line)
    if not match:
        return None
    return match.group("quoted") or match.group("bare")


def _locate_env_block(lines: list[str]) -> tuple[int, int, bool] | None:
    """返回 (表头行号, 表结束行号(不含), 是否带标记)；找不到表头返回 None。"""
    try:
        start = lines.index(ENV_BLOCK_START)
    except ValueError:
        start = -1
    if start >= 0:
        try:
            end = lines.index(ENV_BLOCK_END, start)
        except ValueError:
            raise InstallError(f"{CODEX_CONFIG}: env block start marker without end marker")
        header = next(
            (index for index in range(start + 1, end) if lines[index].strip().startswith(ENV_TABLE_HEADER)),
            None,
        )
        if header is None:
            raise InstallError(f"{CODEX_CONFIG}: env block without {ENV_TABLE_HEADER} header")
        return header, end, True
    header = next(
        (
            index
            for index, line in enumerate(lines)
            if line.strip() == ENV_TABLE_HEADER or line.strip().startswith(ENV_TABLE_HEADER + " ")
            or line.strip().startswith(ENV_TABLE_HEADER + "#")
        ),
        None,
    )
    if header is None:
        return None
    end = header + 1
    while end < len(lines) and not TOML_HEADER_LINE.match(lines[end]):
        end += 1
    return header, end, False


def _install_codex_env(
    values: dict[str, str],
    state: dict[str, Any],
    *,
    uninstalling: bool,
    force: bool,
    dry_run: bool,
) -> list[tuple[str, str, str]]:
    manifest = state["manifest"]
    results = []
    revision = _file_revision(CODEX_CONFIG)
    text = CODEX_CONFIG.read_text(encoding="utf-8") if CODEX_CONFIG.exists() else ""
    try:
        parsed = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise InstallError(f"cannot parse {CODEX_CONFIG}: {error}") from error
    table_exists = isinstance(parsed.get("shell_environment_policy"), dict) and isinstance(
        parsed["shell_environment_policy"].get("set"), dict
    )
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    located = _locate_env_block(lines)
    wanted = [key for key in ("AGENT_TOOLS_ROOT", *LOCAL_ENV_KEYS) if key in values]

    if located is None and table_exists:
        # dotted key / inline table 形态：tomllib 读得到，文本定位不到表头，拒绝写入；卸载同样拒绝删除，逐键提示手工删除
        dotted_values = parsed["shell_environment_policy"]["set"]
        if uninstalling:
            owned = dict(manifest["env_entries"])
            owned.update(manifest["pending_env_entries"])
            for key in owned:
                if key in dotted_values:
                    results.append(
                        (f"codex env {key}", "unconverged",
                         f"{CODEX_CONFIG} defines shell_environment_policy.set without a [shell_environment_policy.set] header; remove {key} = {dotted_values[key]!r} by hand, then rerun --uninstall")
                    )
                else:
                    manifest["env_entries"].pop(key, None)
                    manifest["pending_env_entries"].pop(key, None)
                    results.append((f"codex env {key}", "absent", ""))
            return results
        for key in wanted:
            results.append(
                (f"codex env {key}", "unconverged",
                 f"{CODEX_CONFIG} defines shell_environment_policy.set without a [shell_environment_policy.set] header; merge {key} = {values.get(key, '')!r} by hand")
            )
        return results

    if located is None:
        header_index, end_index, has_markers = len(lines), len(lines), False
        key_lines: list[str] = []
    else:
        header_index, end_index, has_markers = located
        key_lines = lines[header_index + 1:end_index]

    current_values = parsed.get("shell_environment_policy", {}).get("set", {}) if table_exists else {}
    owned = dict(manifest["env_entries"])
    if uninstalling:
        owned.update(manifest["pending_env_entries"])  # 写入后、晋升前中断的键一起删
    new_key_lines = []
    handled = set()
    for line in key_lines:
        key = _toml_key_of(line)
        if key is None:
            new_key_lines.append(line)
            continue
        if uninstalling:
            if key in owned:
                current = current_values.get(key)
                if key == "AGENT_TOOLS_ROOT" and current != values["AGENT_TOOLS_ROOT"]:
                    results.append((f"codex env {key}", "skip (owned by another clone)", str(current)))
                    new_key_lines.append(line)
                elif isinstance(current, str) and _value_fingerprint(current) == owned[key]:
                    manifest["env_entries"].pop(key, None)
                    results.append((f"codex env {key}", "would remove" if dry_run else "removed", ""))
                else:
                    results.append((f"codex env {key}", "skip (value modified)", "kept as is"))
                    new_key_lines.append(line)
                handled.add(key)
            else:
                new_key_lines.append(line)
            continue
        if key in wanted:
            handled.add(key)
            target = values[key]
            current = current_values.get(key)
            if current == target and key in manifest["env_entries"]:
                new_key_lines.append(line)
                results.append((f"codex env {key}", "ok", ""))
                continue
            if current is not None and not isinstance(current, str):
                action = "write" if force else "unconverged"
                reason = f"existing value is not a string ({CODEX_CONFIG}); use --force"
            else:
                action = _env_key_action(manifest, key, current, target, force=force)
                reason = f"existing value differs ({CODEX_CONFIG}); use --force"
            if action == "unconverged":
                new_key_lines.append(line)
                results.append((f"codex env {key}", "unconverged", reason))
                continue
            manifest["pending_env_entries"][key] = _value_fingerprint(target)
            new_key_lines.append(f"{key} = {_toml_literal(target)}")
            results.append((f"codex env {key}", "would write" if dry_run else "written", ""))
        else:
            new_key_lines.append(line)
    if uninstalling:
        for key in list(owned):
            if key not in handled:
                manifest["env_entries"].pop(key, None)
                results.append((f"codex env {key}", "absent", ""))
        manifest["pending_env_entries"].clear()
    else:
        for key in wanted:
            if key in handled:
                continue
            manifest["pending_env_entries"][key] = _value_fingerprint(values[key])
            new_key_lines.append(f"{key} = {_toml_literal(values[key])}")
            results.append((f"codex env {key}", "would write" if dry_run else "written", ""))
    if manifest["pending_env_entries"]:
        _persist_manifest(state, dry_run=dry_run)

    remaining_keys = [line for line in new_key_lines if _toml_key_of(line) is not None]
    if remaining_keys:
        block = [ENV_BLOCK_START, ENV_TABLE_HEADER, *new_key_lines, ENV_BLOCK_END]
    else:
        block = []
    if located is None:
        new_lines = lines + ([""] if lines and lines[-1].strip() else []) + block
    else:
        block_start = header_index - 1 if has_markers else header_index
        block_end = end_index + 1 if has_markers else end_index
        new_lines = lines[:block_start] + block + lines[block_end:]
    new_text = "\n".join(new_lines) + ("\n" if new_lines else "")
    if new_text != text:
        try:
            reparsed = tomllib.loads(new_text)
        except tomllib.TOMLDecodeError as error:
            raise InstallError(f"refusing to write invalid TOML to {CODEX_CONFIG}: {error}") from error
        if not dry_run:
            _check_revision(CODEX_CONFIG, revision)
            mode = stat.S_IMODE(CODEX_CONFIG.stat().st_mode) if CODEX_CONFIG.exists() else 0o600
            _atomic_write(CODEX_CONFIG, new_text.encode("utf-8"), mode=mode)
            if block and (ENV_BLOCK_START not in new_lines or ENV_BLOCK_END not in new_lines):
                raise InstallError(f"{CODEX_CONFIG}: env block markers missing after write")
        written_values = reparsed.get("shell_environment_policy", {}).get("set", {})
    else:
        written_values = current_values
    if not uninstalling:
        for key in list(manifest["pending_env_entries"]):
            if key in values and written_values.get(key) == values[key]:
                manifest["env_entries"][key] = manifest["pending_env_entries"].pop(key)
    _persist_manifest(state, dry_run=dry_run)
    return results


def _install_client_env(
    client: str,
    values: dict[str, str],
    state: dict[str, Any],
    *,
    uninstalling: bool,
    force: bool,
    dry_run: bool,
) -> list[tuple[str, str, str]]:
    if client == "claude":
        return _install_claude_env(values, state, uninstalling=uninstalling, force=force, dry_run=dry_run)
    return _install_codex_env(values, state, uninstalling=uninstalling, force=force, dry_run=dry_run)


def _install_pointer(
    root: str, state: dict[str, Any], *, uninstalling: bool, dry_run: bool
) -> tuple[str, str, str]:
    """~/.config/agent-tools/root 一行仓库根；任何有效克隆或无效内容都覆盖（最后安装生效）。"""
    manifest = state["manifest"]
    current = None
    if POINTER_FILE.exists() or POINTER_FILE.is_symlink():
        try:
            current = POINTER_FILE.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise InstallError(f"cannot read pointer file {POINTER_FILE}: {error}") from error
    if uninstalling:
        manifest["pointer_file"] = None
        manifest["pointer_fingerprint"] = None
        if current is None:
            return ("pointer", "absent", "")
        if current != root:
            return ("pointer", "skip (points to another clone)", current)
        if not dry_run:
            POINTER_FILE.unlink()
        return ("pointer", "would remove" if dry_run else "removed", "")
    note = ""
    if current is not None and current != root:
        note = f"replaced previous value {current}"
    content = (root + "\n").encode("utf-8")
    if current != root and not dry_run:
        try:
            _atomic_write(POINTER_FILE, content, mode=0o644)
        except OSError as error:
            raise InstallError(f"cannot write pointer file {POINTER_FILE}: {error}") from error
    manifest["pointer_file"] = str(POINTER_FILE)
    manifest["pointer_fingerprint"] = _content_fingerprint(content)
    if current == root:
        return ("pointer", "ok", "")
    return ("pointer", "would write" if dry_run else "written", note)


# ---------------------------------------------------------------------------
# MCP 注册：devtools / bastion / bastion_dba


def _mcp_targets(root: str) -> dict[str, dict[str, Any]]:
    bastion = f"{root}/mcp/bastion-mcp"
    return {
        "devtools": {
            "command": "python3",
            "args": ["-m", "devtools_mcp.aggregate_server"],
            "env": {
                "PYTHONPATH": f"{root}/mcp/devtools-mcp:{bastion}",
                "BASTION_CONFIG": f"{bastion}/config.json",
            },
        },
        "bastion": {
            "command": "python3",
            "args": ["-m", "bastion_mcp.server"],
            "env": {"PYTHONPATH": bastion, "BASTION_CONFIG": f"{bastion}/config.json"},
        },
        "bastion_dba": {
            "command": "python3",
            "args": ["-m", "bastion_mcp.server"],
            "env": {"PYTHONPATH": bastion, "BASTION_CONFIG": f"{bastion}/config.dba.json"},
        },
    }


def _identity(entry: dict[str, Any]) -> dict[str, Any]:
    """command/args/env 三元组；手写注册常缺 args 或 env，归一为 [] / {}，备份、比对与恢复命令都经这里取值。"""
    return {"command": entry.get("command"), "args": list(entry.get("args") or []), "env": dict(entry.get("env") or {})}


def _identity_equal(left: dict[str, Any] | None, right: dict[str, Any] | None) -> bool:
    return left is not None and right is not None and _identity(left) == _identity(right)


def _identity_under_root(entry: dict[str, Any], root: str) -> bool:
    """身份里 PYTHONPATH 与 BASTION_CONFIG 的每个路径都以 <root>/ 为前缀（含分隔符）。"""
    env = entry.get("env") or {}
    prefix = root.rstrip("/") + "/"
    paths = env.get("PYTHONPATH", "").split(":") + [env.get("BASTION_CONFIG", "")]
    return all(path.startswith(prefix) for path in paths if path)


def _read_mcp_registration(client: str, name: str) -> dict[str, Any] | None:
    """读当前注册：Claude 读 ~/.claude.json 的 mcpServers.<name>，Codex 读 config.toml 的 [mcp_servers.<name>]。"""
    if client == "claude":
        data = _load_json_object(CLAUDE_MCP_CONFIG, default={})
        servers = data.get("mcpServers")
        if not isinstance(servers, dict):
            return None
        entry = servers.get(name)
        return copy_module.deepcopy(entry) if isinstance(entry, dict) else None
    if not CODEX_CONFIG.exists():
        return None
    try:
        parsed = tomllib.loads(CODEX_CONFIG.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as error:
        raise InstallError(f"cannot parse {CODEX_CONFIG}: {error}") from error
    servers = parsed.get("mcp_servers")
    if not isinstance(servers, dict):
        return None
    entry = servers.get(name)
    return copy_module.deepcopy(entry) if isinstance(entry, dict) else None


def _mcp_cli(client: str) -> str | None:
    return shutil.which(client)


def _mcp_add_command(client: str, name: str, target: dict[str, Any]) -> list[str]:
    env_flag = "-e" if client == "claude" else "--env"
    command = [client, "mcp", "add"]
    if client == "claude":
        command += ["--scope", "user"]
    command.append(name)
    ident = _identity(target)
    for key, value in ident["env"].items():
        command += [env_flag, f"{key}={value}"]
    command += ["--", ident["command"], *ident["args"]]
    return command


def _mcp_remove_command(client: str, name: str) -> list[str]:
    if client == "claude":
        return [client, "mcp", "remove", "--scope", "user", name]
    return [client, "mcp", "remove", name]


def _run_cli(command: list[str]) -> None:
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise InstallError(
            f"{' '.join(shlex.quote(part) for part in command)} failed ({completed.returncode}): "
            f"{(completed.stderr or completed.stdout).strip()}"
        )


def _write_mcp_extra(client: str, name: str, extra: dict[str, Any], *, dry_run: bool) -> list[str]:
    """把被替换注册的额外键写回新注册；返回写回失败（不支持的类型）的键。"""
    unsupported = []
    if not extra:
        return unsupported
    if client == "claude":
        revision = _file_revision(CLAUDE_MCP_CONFIG)
        before = _load_json_object(CLAUDE_MCP_CONFIG, default={})
        after = copy_module.deepcopy(before)
        entry = after.setdefault("mcpServers", {}).setdefault(name, {})
        for key, value in extra.items():
            entry.setdefault(key, value)
        _write_json_if_needed(
            CLAUDE_MCP_CONFIG, before, after, dry_run=dry_run, expected_revision=revision
        )
        return unsupported
    if dry_run:
        return unsupported
    revision = _file_revision(CODEX_CONFIG)
    text = CODEX_CONFIG.read_text(encoding="utf-8")
    lines = text.split("\n")
    header = f"[mcp_servers.{name}]"
    try:
        index = next(i for i, line in enumerate(lines) if line.strip() == header)
    except StopIteration:
        raise InstallError(f"{CODEX_CONFIG}: table {header} not found after codex mcp add")
    insert = []
    for key, value in extra.items():
        try:
            insert.append(f'"{key}" = {_toml_literal(value)}')
        except ValueError:
            unsupported.append(key)
    if insert:
        new_text = "\n".join(lines[: index + 1] + insert + lines[index + 1 :])
        try:
            tomllib.loads(new_text)
        except tomllib.TOMLDecodeError as error:
            raise InstallError(f"refusing to write invalid TOML to {CODEX_CONFIG}: {error}") from error
        _check_revision(CODEX_CONFIG, revision)
        _atomic_write(CODEX_CONFIG, new_text.encode("utf-8"), mode=stat.S_IMODE(CODEX_CONFIG.stat().st_mode))
    return unsupported


def _find_backup(manifest: dict[str, Any], name: str) -> dict[str, Any] | None:
    return next((item for item in manifest["mcp_servers_replaced"] if item.get("name") == name), None)


def _find_recorded(manifest: dict[str, Any], name: str) -> dict[str, Any] | None:
    return next((item for item in manifest["mcp_servers"] if item.get("name") == name), None)


def _record_mcp(manifest: dict[str, Any], name: str, target: dict[str, Any]) -> None:
    manifest["mcp_servers"] = [item for item in manifest["mcp_servers"] if item.get("name") != name]
    manifest["mcp_servers"].append({"name": name, **_identity(target)})


def _register_mcp(
    client: str,
    root: str,
    state: dict[str, Any],
    *,
    force: bool,
    dry_run: bool,
) -> list[tuple[str, str, str]]:
    """按 3.4 注册三项 MCP：完整身份比对；--force 先备份并保存 manifest，再删再加，再写回额外键。"""
    manifest = state["manifest"]
    results = []
    cli = _mcp_cli(client)
    for name, target in _mcp_targets(root).items():
        label = f"{client} mcp {name}"
        add_command = _mcp_add_command(client, name, target)
        printable = " ".join(shlex.quote(part) for part in add_command)
        if cli is None:
            results.append((label, "unconverged", f"{client} CLI not in PATH; run: {printable}"))
            continue
        current = _read_mcp_registration(client, name)
        if current is not None and _identity_equal(current, target):
            if _find_recorded(manifest, name) is not None:
                results.append((label, "ok", ""))
                continue
            backup = _find_backup(manifest, name)
            if backup is not None:
                missing = {k: v for k, v in backup.get("extra", {}).items() if k not in current}
                if missing:
                    unsupported = _write_mcp_extra(client, name, missing, dry_run=dry_run)
                    written = {k: v for k, v in missing.items() if k not in unsupported}
                    if written and not dry_run:
                        after = _read_mcp_registration(client, name) or {}
                        if any(after.get(k) != v for k, v in written.items()):
                            results.append((label, "unconverged", f"extra keys not written back: {written}"))
                            continue
                        print(f"    {label}: restored extra keys {', '.join(sorted(written))}")
                    if unsupported:
                        results.append((label, "unconverged", f"unsupported extra values for {unsupported}; add by hand"))
                        continue
            _record_mcp(manifest, name, target)
            _persist_manifest(state, dry_run=dry_run)
            results.append((label, "ok", "recorded existing registration"))
            continue
        if current is not None and not force:
            results.append((label, "unconverged", f"registered with a different identity; use --force or run: {printable}"))
            continue
        if dry_run:
            results.append((label, "would register", printable))
            continue
        extra: dict[str, Any] = {}
        if current is not None:
            recorded = _find_recorded(manifest, name)
            extra = {k: v for k, v in current.items() if k not in MCP_IDENTITY_KEYS}
            if not _identity_equal(current, recorded) and _find_backup(manifest, name) is None:
                manifest["mcp_servers_replaced"].append({"name": name, **_identity(current), "extra": extra})
                _persist_manifest(state, dry_run=dry_run)
            else:
                backup = _find_backup(manifest, name)
                extra = dict(backup.get("extra", {})) if backup else {}
            _run_cli(_mcp_remove_command(client, name))
        else:
            backup = _find_backup(manifest, name)
            extra = dict(backup.get("extra", {})) if backup else {}
        _run_cli(add_command)
        unsupported = _write_mcp_extra(client, name, extra, dry_run=False)
        after = _read_mcp_registration(client, name)
        if not _identity_equal(after, target):
            results.append((label, "unconverged", f"registration differs after add; run: {printable}"))
            continue
        written = {k: v for k, v in extra.items() if k not in unsupported}
        if any(after.get(k) != v for k, v in written.items()):
            results.append((label, "unconverged", f"extra keys not written back: {written}"))
            continue
        _record_mcp(manifest, name, target)
        _persist_manifest(state, dry_run=False)
        note = f"restored extra keys {', '.join(sorted(written))}" if written else ""
        if unsupported:
            note += f"; unsupported extra values for {unsupported}, add by hand"
            results.append((label, "unconverged", note))
            continue
        results.append((label, "registered", note))
    return results


def _unregister_mcp(
    client: str, root: str, state: dict[str, Any], *, dry_run: bool
) -> list[tuple[str, str, str]]:
    """--uninstall：删与记录全等或与目标身份全等且根在本克隆下的注册，再按备份恢复原注册。"""
    manifest = state["manifest"]
    results = []
    cli = _mcp_cli(client)
    for name, target in _mcp_targets(root).items():
        label = f"{client} mcp {name}"
        current = _read_mcp_registration(client, name)
        recorded = _find_recorded(manifest, name)
        backup = _find_backup(manifest, name)
        own = current is not None and _identity_under_root(current, root) and (
            _identity_equal(current, recorded) or _identity_equal(current, target)
        )
        if cli is None and (own or backup):
            results.append((label, "unconverged", f"{client} CLI not in PATH; remove/restore by hand"))
            continue
        if own:
            if not dry_run:
                _run_cli(_mcp_remove_command(client, name))
            current = None
            results.append((label, "would remove" if dry_run else "removed", ""))
        elif current is not None and recorded is not None:
            results.append((label, "skip (not this clone's registration)", ""))
        manifest["mcp_servers"] = [item for item in manifest["mcp_servers"] if item.get("name") != name]
        if backup is None:
            continue
        backup_extra = backup.get("extra", {})
        if current is None:
            if not dry_run:
                _run_cli(_mcp_add_command(client, name, backup))
                unsupported = _write_mcp_extra(client, name, backup_extra, dry_run=False)
                after = _read_mcp_registration(client, name) or {}
                written = {k: v for k, v in backup_extra.items() if k not in unsupported}
                problems = []
                if not _identity_equal(after, backup):
                    problems.append("identity differs after add")
                if any(after.get(k) != v for k, v in written.items()):
                    problems.append(f"extra keys not written back: {written}")
                if unsupported:
                    problems.append(f"unsupported extra values for {unsupported}, add by hand")
                if problems:
                    results.append((f"{label} restore", "unconverged",
                                    "; ".join(problems) + f"; original was {json.dumps({**_identity(backup), 'extra': backup_extra}, ensure_ascii=False)}; backup kept in manifest"))
                    continue
            results.append((f"{label} restore", "would restore" if dry_run else "restored", ""))
        elif _identity_equal(current, backup) and all(current.get(k) == v for k, v in backup_extra.items()):
            results.append((f"{label} restore", "ok", "original registration already present"))
        else:
            results.append((f"{label} restore", "unconverged", f"a different registration exists; original was {json.dumps({**_identity(backup), 'extra': backup_extra}, ensure_ascii=False)}"))
            continue
        if not dry_run:
            manifest["mcp_servers_replaced"] = [
                item for item in manifest["mcp_servers_replaced"] if item.get("name") != name
            ]
    _persist_manifest(state, dry_run=dry_run)
    return results


def _report_unconverged(results: list[tuple[str, str, str]], *, uninstalling: bool = False) -> int:
    """汇总 skill、全局指令、env 键、指针文件、MCP 五类结果并决定退出码。

    安装：skip* 与 unconverged 都算未收敛，逐项打印并返回 1。
    卸载：skip* 是有意保留的用户内容（已逐项打印原因），只有 unconverged（恢复或删除没完成）返回 1。
    """
    if uninstalling:
        unconverged = [item for item in results if item[1] == "unconverged"]
        if not unconverged:
            return 0
        print(f"unconverged: uninstall left {len(unconverged)} item(s) unresolved:")
        for identifier, status, reason in unconverged:
            print(f"  {identifier}: {status}" + (f" — {reason}" if reason else ""))
        print("  fix: restore or remove by hand using the printed original value, then rerun --uninstall; backups stay in the manifest")
        return 1
    unconverged = [
        item for item in results if item[1].startswith("skip") or item[1] == "unconverged"
    ]
    if not unconverged:
        return 0
    print(f"unconverged: {len(unconverged)} item(s) still do not point at this repository:")
    for identifier, status, reason in unconverged:
        detail = f" — {reason}" if reason else ""
        print(f"  {identifier}: {status}{detail}")
    print("  fix: move the foreign content away or rerun with --force; run printed commands by hand")
    return 1


def _parse_targets(raw_targets: str) -> list[str]:
    clients = []
    for raw in raw_targets.split(","):
        client = raw.strip()
        if client not in TARGETS:
            raise InstallError(f"unknown target: {client}")
        if client not in clients:
            clients.append(client)
    return clients


def _run(args: argparse.Namespace) -> int:
    groups = find_groups()
    if args.groups:
        wanted = set(args.groups.split(","))
        unknown = wanted - groups.keys()
        if unknown:
            raise InstallError(f"unknown groups: {', '.join(sorted(unknown))}")
        groups = {key: value for key, value in groups.items() if key in wanted}

    skills = find_skills(groups)
    if args.skills:
        wanted = set(args.skills.split(","))
        unknown = wanted - skills.keys()
        if unknown:
            raise InstallError(f"unknown skills: {', '.join(sorted(unknown))}")
        skills = {key: value for key, value in skills.items() if key in wanted}

    clients = _parse_targets(args.targets)
    if args.list:
        for group_name, group_dir in groups.items():
            print(f"[{group_name}]")
            for skill in sorted(group_dir.iterdir()):
                if (skill / "SKILL.md").is_file():
                    print(f"  {skill.name}")
        if args.with_subagents:
            for client in clients:
                print(f"[{client} agents]")
                for name in find_agents(client):
                    print(f"  {name}")
        return 0

    values = _load_local_env()
    root = values["AGENT_TOOLS_ROOT"]
    results: list[tuple[str, str, str]] = []
    states = _prepare_targets(clients, with_subagents=args.with_subagents)
    subagent_revisions = {}
    if args.with_subagents and not args.uninstall:
        subagent_revisions = _preflight_subagent_targets(
            clients, states, force=args.force
        )
    _check_target_revisions(states, with_subagents=args.with_subagents)
    if subagent_revisions:
        _check_subagent_target_revisions(subagent_revisions)
    for client in clients:
        _promote_completed_pending_copies(
            client, states[client], dry_run=args.dry_run
        )
        _cleanup_stale_ownership(client, states[client], dry_run=args.dry_run)
    if args.copy and not args.uninstall:
        for client in clients:
            _stage_copy_ownership(
                client,
                states[client],
                skills,
                force=args.force,
                with_subagents=args.with_subagents,
                with_global=args.with_global,
                dry_run=args.dry_run,
            )
    for client in clients:
        _check_target_revisions(
            {client: states[client]},
            with_subagents=args.with_subagents,
        )
        target_dir = TARGETS[client]
        state = states[client]
        manifest = state["manifest"]
        print(f"== {client} ({target_dir}) ==")
        for name, source in skills.items():
            if args.uninstall:
                status = uninstall(
                    name,
                    source,
                    target_dir,
                    manifest=manifest,
                    dry_run=args.dry_run,
                )
            else:
                status = install(
                    name,
                    source,
                    target_dir,
                    copy=args.copy,
                    force=args.force,
                    manifest=manifest,
                    dry_run=args.dry_run,
                )
            print(f"  {name}: {status}")
            results.append((f"{client} skill {name}", status, str(target_dir / name)))
        _persist_manifest(state, dry_run=args.dry_run)

        if args.with_global:
            name = GLOBAL_NAMES[client]
            rendered = _render(GLOBAL_SOURCE, values)
            if args.uninstall:
                status = _uninstall_rendered(
                    name, GLOBAL_SOURCE, state["root"], rendered, state=state, dry_run=args.dry_run
                )
            else:
                status = _install_rendered(
                    name,
                    GLOBAL_SOURCE,
                    state["root"],
                    rendered,
                    state=state,
                    force=args.force,
                    dry_run=args.dry_run,
                )
            print(f"  [global] {name}: {status}")
            results.append((f"{client} global {name}", status, str(state["root"] / name)))
            _persist_manifest(state, dry_run=args.dry_run)

        if args.with_subagents:
            _install_subagents(
                client,
                state,
                values=values,
                force=args.force,
                uninstalling=args.uninstall,
                dry_run=args.dry_run,
            )
            _persist_manifest(state, dry_run=args.dry_run)

        if getattr(args, "with_mcp", False):
            # MCP 注册先于 Codex 标记块：codex mcp add 会重写 config.toml
            if args.uninstall:
                mcp_results = _unregister_mcp(client, root, state, dry_run=args.dry_run)
            else:
                mcp_results = _register_mcp(
                    client, root, state, force=args.force, dry_run=args.dry_run
                )
            for identifier, status, reason in mcp_results:
                print(f"  [mcp] {identifier}: {status}" + (f" ({reason})" if reason and status != "ok" else ""))
            results.extend(mcp_results)

        env_results = _install_client_env(
            client,
            values,
            state,
            uninstalling=args.uninstall,
            force=args.force,
            dry_run=args.dry_run,
        )
        for identifier, status, reason in env_results:
            print(f"  [env] {identifier}: {status}" + (f" ({reason})" if reason and status != "ok" else ""))
        results.extend(env_results)

        pointer_result = _install_pointer(
            root, state, uninstalling=args.uninstall, dry_run=args.dry_run
        )
        print(f"  [pointer] {POINTER_FILE}: {pointer_result[1]}" + (f" ({pointer_result[2]})" if pointer_result[2] else ""))
        results.append((f"{client} {pointer_result[0]}", pointer_result[1], pointer_result[2]))

        if args.uninstall:
            state["manifest"] = _manifest_v3_shape(manifest)
        _persist_manifest(state, dry_run=args.dry_run)
    if args.with_session_cleanup:
        if "claude" in clients:
            _install_session_cleanup(uninstalling=args.uninstall, dry_run=args.dry_run)
        else:
            print("  [hook] SessionEnd session cleanup: skip (claude target only)")
    return _report_unconverged(results, uninstalling=args.uninstall)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--groups", help="comma separated group names")
    parser.add_argument("--skills", help="comma separated skill names")
    parser.add_argument("--targets", default="claude,codex", help="claude,codex")
    parser.add_argument("--copy", action="store_true", help="copy instead of symlink")
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace existing foreign links, files, or directories",
    )
    parser.add_argument(
        "--with-subagents",
        action="store_true",
        help="also install reviewer agents and SubagentStop hooks",
    )
    parser.add_argument(
        "--with-global",
        action="store_true",
        help="also render AGENTS.global.md (plus env/AGENTS.local.md if present) as ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md",
    )
    parser.add_argument(
        "--with-session-cleanup",
        action="store_true",
        help="also add a Claude SessionEnd hook that removes the session's temp dir",
    )
    parser.add_argument(
        "--with-mcp",
        action="store_true",
        help="also register devtools / bastion / bastion_dba MCP servers in both clients",
    )
    parser.add_argument("--dry-run", action="store_true", help="report without writing")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()

    try:
        return _run(args)
    except (InstallError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
