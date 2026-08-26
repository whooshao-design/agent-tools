#!/usr/bin/env python3
"""Install or remove the browser-session renewal systemd user timer."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlparse


UNIT_NAME = "agent-tools-browser-session-renewal"
SERVICE_NAME = f"{UNIT_NAME}.service"
TIMER_NAME = f"{UNIT_NAME}.timer"
DEFAULT_INTERVAL_HOURS = 6
MAIN_PROFILE = Path.home() / ".cache" / "lexiao-browser-profile"
HEALTHY_PROFILE = Path.home() / ".cache" / "healthy-dashboard-profile"
SESSION_SNAPSHOT = Path.home() / ".cache" / "agent-tools-session" / "main.json"
DEFAULT_BROWSER_SCRIPT = Path(__file__).resolve().with_name("browser_session.js")


def default_targets() -> list[dict]:
    """Renewal targets, in execution order.

    The SSO endpoint comes first: it is the only entry that re-signs the fixed-lifetime
    tickets. Business pages only slide `oa_session`, so they cannot replace it.
    """
    return [
        {"url": "https://passport.lexincloud.com/", "profile": MAIN_PROFILE, "success_text": "none"},
        {"url": "https://passport.lexincloud.com/", "profile": HEALTHY_PROFILE, "success_text": "none"},
        {"url": "https://lexiao.oa.fenqile.com/", "profile": MAIN_PROFILE, "success_text": "当前环境"},
        {
            "url": "https://lxcloud.oa.fenqile.com/",
            "profile": MAIN_PROFILE,
            "success_text": "none",
            "export": SESSION_SNAPSHOT,
        },
    ]


def validate_config(url: str, interval_hours: int) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("renewal URL must be an HTTPS URL")
    if not 1 <= interval_hours <= 168:
        raise ValueError("interval hours must be between 1 and 168")


def systemd_quote(value: object) -> str:
    escaped = str(value)
    escaped = escaped.replace("\\", "\\\\")
    escaped = escaped.replace('"', '\\"')
    escaped = escaped.replace("%", "%%")
    escaped = escaped.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f'"{escaped}"'


def target_command(browser_script: Path, target: dict) -> str:
    export_path = target.get("export")
    mode_arg = f"--export-session={export_path}" if export_path else "--renew"
    return " ".join(systemd_quote(value) for value in (
        "/usr/bin/node",
        browser_script,
        mode_arg,
        f"--url={target['url']}",
        f"--profile={target['profile']}",
        f"--success-text={target['success_text']}",
    ))


def build_unit_contents(
    *,
    browser_script: Path,
    targets: list[dict],
    interval_hours: int,
) -> tuple[str, str]:
    if not targets:
        raise ValueError("at least one renewal target is required")
    for target in targets:
        validate_config(target["url"], interval_hours)
    # "-" lets a failing target be skipped instead of aborting the remaining ones.
    exec_lines = "\n".join(f"ExecStart=-{target_command(browser_script, target)}" for target in targets)
    service = f"""[Unit]
Description=Renew the agent-tools browser session
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
{exec_lines}
TimeoutStartSec=5min
"""
    timer = f"""[Unit]
Description=Renew the agent-tools browser session every {interval_hours} hours

[Timer]
OnBootSec=5m
OnUnitActiveSec={interval_hours}h
RandomizedDelaySec=10m
AccuracySec=1m
Unit={SERVICE_NAME}

[Install]
WantedBy=timers.target
"""
    return service, timer


def unit_paths(unit_dir: Path) -> dict[str, Path]:
    return {
        "service": unit_dir / SERVICE_NAME,
        "timer": unit_dir / TIMER_NAME,
    }


def write_units(unit_dir: Path, service: str, timer: str) -> dict[str, Path]:
    paths = unit_paths(unit_dir)
    unit_dir.mkdir(parents=True, exist_ok=True)
    paths["service"].write_text(service, encoding="utf-8")
    paths["timer"].write_text(timer, encoding="utf-8")
    paths["service"].chmod(0o644)
    paths["timer"].chmod(0o644)
    return paths


def remove_units(unit_dir: Path) -> list[Path]:
    removed = []
    for path in unit_paths(unit_dir).values():
        if path.exists():
            path.unlink()
            removed.append(path)
    return removed


def run_systemctl(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["systemctl", "--user", *args],
        check=check,
        text=True,
        capture_output=True,
    )


def default_unit_dir() -> Path:
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return config_home / "systemd" / "user"


def install(args: argparse.Namespace) -> dict[str, object]:
    browser_script = Path(args.browser_script).expanduser().resolve()
    if not browser_script.is_file():
        raise FileNotFoundError(f"browser session script not found: {browser_script}")
    targets = default_targets()
    service, timer = build_unit_contents(
        browser_script=browser_script,
        targets=targets,
        interval_hours=args.interval_hours,
    )
    paths = write_units(default_unit_dir(), service, timer)
    run_systemctl("daemon-reload")
    run_systemctl("enable", "--now", TIMER_NAME)
    run_systemctl("start", SERVICE_NAME)
    return {
        "action": "installed",
        "service": str(paths["service"]),
        "timer": str(paths["timer"]),
        "intervalHours": args.interval_hours,
        "targets": [
            {"url": target["url"], "profile": str(target["profile"]), "export": str(target["export"])}
            if target.get("export")
            else {"url": target["url"], "profile": str(target["profile"])}
            for target in targets
        ],
        "sessionSnapshot": str(SESSION_SNAPSHOT),
        "initialRenewalAttempted": True,
    }


def uninstall() -> dict[str, object]:
    run_systemctl("disable", "--now", TIMER_NAME, check=False)
    removed = remove_units(default_unit_dir())
    run_systemctl("daemon-reload")
    run_systemctl("reset-failed", SERVICE_NAME, check=False)
    return {
        "action": "uninstalled",
        "removed": [str(path) for path in removed],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uninstall", action="store_true", help="disable the timer and remove its user units")
    parser.add_argument("--interval-hours", type=int, default=DEFAULT_INTERVAL_HOURS)
    parser.add_argument("--browser-script", default=str(DEFAULT_BROWSER_SCRIPT))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = uninstall() if args.uninstall else install(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
