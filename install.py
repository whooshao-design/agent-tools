#!/usr/bin/env python3
"""Install skills as symlinks into Claude Code and Codex skill directories.

The repository is the single source of truth. By default every skill is
symlinked into both ~/.claude/skills and ~/.codex/skills, so edits in the
repo take effect immediately in both tools.

Usage:
  python3 install.py                          # symlink all skills to both targets
  python3 install.py --groups dev-workflow    # only one group
  python3 install.py --skills dev-cr,code-dev # only some skills
  python3 install.py --targets claude         # only ~/.claude/skills
  python3 install.py --copy                   # copy instead of symlink (fallback)
  python3 install.py --list                   # show available groups/skills
  python3 install.py --uninstall              # remove installed links/copies
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent
TARGETS = {
    "claude": Path.home() / ".claude" / "skills",
    "codex": Path.home() / ".codex" / "skills",
}


def find_groups() -> dict[str, Path]:
    groups = {}
    for child in sorted(REPO.iterdir()):
        if child.is_dir() and (child / "skills").is_dir():
            groups[child.name] = child / "skills"
    return groups


def find_skills(groups: dict[str, Path]) -> dict[str, Path]:
    skills = {}
    for skills_dir in groups.values():
        for skill in sorted(skills_dir.iterdir()):
            if (skill / "SKILL.md").is_file():
                if skill.name in skills:
                    print(f"warning: duplicate skill name {skill.name}, keeping {skills[skill.name]}")
                    continue
                skills[skill.name] = skill
    return skills


def install(name: str, src: Path, target_dir: Path, copy: bool, force: bool) -> str:
    dst = target_dir / name
    if dst.is_symlink():
        if dst.resolve() == src.resolve() and not copy:
            return "ok"
        dst.unlink()
    elif dst.exists():
        if not force:
            return "skip (exists, use --force)"
        shutil.rmtree(dst)
    target_dir.mkdir(parents=True, exist_ok=True)
    if copy:
        shutil.copytree(src, dst)
        return "copied"
    dst.symlink_to(src)
    return "linked"


def uninstall(name: str, src: Path, target_dir: Path) -> str:
    dst = target_dir / name
    if dst.is_symlink():
        if dst.resolve() == src.resolve():
            dst.unlink()
            return "removed"
        return "skip (foreign link)"
    if dst.is_dir():
        return "skip (real dir, remove manually)"
    return "absent"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--groups", help="comma separated group names")
    ap.add_argument("--skills", help="comma separated skill names")
    ap.add_argument("--targets", default="claude,codex", help="claude,codex")
    ap.add_argument("--copy", action="store_true", help="copy instead of symlink")
    ap.add_argument("--force", action="store_true", help="replace existing real directories")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--uninstall", action="store_true")
    args = ap.parse_args()

    groups = find_groups()
    if args.groups:
        wanted = set(args.groups.split(","))
        unknown = wanted - groups.keys()
        if unknown:
            print(f"unknown groups: {', '.join(sorted(unknown))}")
            return 1
        groups = {k: v for k, v in groups.items() if k in wanted}

    skills = find_skills(groups)
    if args.skills:
        wanted = set(args.skills.split(","))
        unknown = wanted - skills.keys()
        if unknown:
            print(f"unknown skills: {', '.join(sorted(unknown))}")
            return 1
        skills = {k: v for k, v in skills.items() if k in wanted}

    if args.list:
        for gname, gdir in groups.items():
            print(f"[{gname}]")
            for skill in sorted(gdir.iterdir()):
                if (skill / "SKILL.md").is_file():
                    print(f"  {skill.name}")
        return 0

    target_dirs = {}
    for t in args.targets.split(","):
        t = t.strip()
        if t not in TARGETS:
            print(f"unknown target: {t}")
            return 1
        target_dirs[t] = TARGETS[t]

    for tname, tdir in target_dirs.items():
        print(f"== {tname} ({tdir}) ==")
        for name, src in skills.items():
            if args.uninstall:
                status = uninstall(name, src, tdir)
            else:
                status = install(name, src, tdir, copy=args.copy, force=args.force)
            print(f"  {name}: {status}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
