#!/usr/bin/env python3
"""Install repository skills and optional reviewer subagents for both clients.

Usage:
  python3 install.py                          # symlink all skills to both targets
  python3 install.py --groups dev-workflow    # only one skill group
  python3 install.py --skills dev-cr,code-dev # only some skills
  python3 install.py --targets claude         # only one client
  python3 install.py --copy                   # copy instead of symlink
  python3 install.py --with-subagents         # also install reviewer agents/hooks
  python3 install.py --with-global            # also link AGENTS.global.md as client-level instructions
  python3 install.py --with-session-cleanup   # also add Claude SessionEnd hook that removes the session temp dir
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
import sys
import tempfile
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parent
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
MANIFEST_VERSION = 3
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
        or manifest.get("version") not in (1, 2, MANIFEST_VERSION)
        or not isinstance(manifest.get("copies"), dict)
    ):
        raise InstallError(f"invalid ownership manifest: {path}")
    if manifest.get("version") == 1:
        manifest["links"] = {}
    if manifest.get("version") in (1, 2):
        manifest["version"] = MANIFEST_VERSION
        manifest["pending_copies"] = {}
    if not isinstance(manifest.get("links"), dict):
        raise InstallError(f"invalid link ownership state: {path}")
    if not isinstance(manifest.get("pending_copies"), dict):
        raise InstallError(f"invalid pending copy state: {path}")
    hook_config = manifest.get("hook_config")
    if hook_config is not None and not isinstance(hook_config, dict):
        raise InstallError(f"invalid hook ownership state: {path}")
    return manifest


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
    if with_global:
        install(
            GLOBAL_NAMES[client],
            GLOBAL_SOURCE,
            state["root"],
            copy=True,
            force=force,
            manifest=simulated,
            dry_run=True,
        )
    if with_subagents:
        agents_dir = state["root"] / "agents"
        for name, source in find_agents(client).items():
            install(
                name,
                source,
                agents_dir,
                copy=True,
                force=force,
                manifest=simulated,
                dry_run=True,
            )
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
    copy: bool,
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
            status = uninstall(
                name,
                source,
                agents_dir,
                manifest=manifest,
                dry_run=dry_run,
            )
        else:
            status = install(
                name,
                source,
                agents_dir,
                copy=copy,
                force=force,
                manifest=manifest,
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

        if args.with_global:
            name = GLOBAL_NAMES[client]
            if args.uninstall:
                status = uninstall(
                    name,
                    GLOBAL_SOURCE,
                    state["root"],
                    manifest=manifest,
                    dry_run=args.dry_run,
                )
            else:
                status = install(
                    name,
                    GLOBAL_SOURCE,
                    state["root"],
                    copy=args.copy,
                    force=args.force,
                    manifest=manifest,
                    dry_run=args.dry_run,
                )
            print(f"  [global] {name}: {status}")

        if args.with_subagents:
            _install_subagents(
                client,
                state,
                copy=args.copy,
                force=args.force,
                uninstalling=args.uninstall,
                dry_run=args.dry_run,
            )

        _save_manifest(
            state["manifest_path"],
            state["manifest_before"],
            manifest,
            dry_run=args.dry_run,
            expected_revision=state["manifest_revision"],
        )
    if args.with_session_cleanup:
        if "claude" in clients:
            _install_session_cleanup(uninstalling=args.uninstall, dry_run=args.dry_run)
        else:
            print("  [hook] SessionEnd session cleanup: skip (claude target only)")
    return 0


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
        help="also link AGENTS.global.md as ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md",
    )
    parser.add_argument(
        "--with-session-cleanup",
        action="store_true",
        help="also add a Claude SessionEnd hook that removes the session's temp dir",
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
