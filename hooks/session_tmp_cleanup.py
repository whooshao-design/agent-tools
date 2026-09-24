#!/usr/bin/env python3
"""Remove a Claude Code session's own temp directory when the session ends.

Claude Code keeps per-session scratchpad and background-task output under
<tmp>/claude-<uid>/<project-slug>/<session-id>/ and never deletes it. Other
sessions' directories and the shared files next to them are left alone.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Sequence


OWNER = "agent-tools-session-cleanup-v1"
SESSION_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def default_base() -> Path:
    return Path(tempfile.gettempdir()) / f"claude-{os.getuid()}"


def cleanup(base: Path, session_id: str) -> list[Path]:
    if not SESSION_ID.fullmatch(session_id) or not base.is_dir() or base.is_symlink():
        return []
    removed = []
    for project in base.iterdir():
        if project.is_symlink() or not project.is_dir():
            continue
        target = project / session_id
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target, ignore_errors=True)
            removed.append(target)
    return removed


def main(argv: Sequence[str] | None = None) -> int:
    del argv  # --owner only marks the settings entry as installer-owned.
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return 0
    session_id = payload.get("session_id") if isinstance(payload, dict) else None
    if isinstance(session_id, str):
        cleanup(default_base(), session_id)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
