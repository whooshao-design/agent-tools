#!/usr/bin/env python3
"""Install or remove the weekly OKR summary systemd user timer (okr-weekly.timer)."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

UNIT_NAME = "okr-weekly"
SERVICE_NAME = f"{UNIT_NAME}.service"
TIMER_NAME = f"{UNIT_NAME}.timer"
DEFAULT_SCHEDULE = "Fri *-*-* 13:40:00"
RUN_SCRIPT = Path(__file__).resolve().with_name("run_scheduled.sh")
# systemd 用户服务拿不到交互 shell 的 PATH 和代理变量；安装时把当前值写进单元，claude 才能联网
PASSTHROUGH_ENV = ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy")


def systemd_quote(value: object) -> str:
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
    escaped = escaped.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f'"{escaped}"'


def validate_schedule(schedule: str) -> None:
    if not schedule or not schedule.strip() or any(ch in schedule for ch in "\n\r"):
        raise ValueError("schedule must be a single non-empty line")


def build_unit_contents(*, schedule: str, run_script: Path, env: dict[str, str]) -> tuple[str, str]:
    validate_schedule(schedule)
    path = ":".join([str(Path.home() / ".npm-global" / "bin"), str(Path.home() / ".local" / "bin"), "/usr/local/bin", "/usr/bin", "/bin"])
    env_lines = [f"Environment={systemd_quote(f'PATH={path}')}", f"Environment={systemd_quote('TZ=Asia/Shanghai')}"]
    env_lines += [f"Environment={systemd_quote(f'{k}={env[k]}')}" for k in PASSTHROUGH_ENV if env.get(k)]
    service = f"""[Unit]
Description=Generate the weekly OKR progress summary (preview only, never writes OKR)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
{chr(10).join(env_lines)}
ExecStart=/bin/bash {systemd_quote(run_script)}
TimeoutStartSec=30min
"""
    # Persistent=true：WSL 常被关闭，错过的周五 13:40 在下次启动时补跑
    timer = f"""[Unit]
Description=Weekly OKR progress summary ({schedule})

[Timer]
OnCalendar={schedule}
Persistent=true
AccuracySec=1m
Unit={SERVICE_NAME}

[Install]
WantedBy=timers.target
"""
    return service, timer


def unit_dir() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "systemd" / "user"


def systemctl(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["systemctl", "--user", *args], check=check, capture_output=True, text=True)


def install(schedule: str, dry_run: bool) -> dict:
    service, timer = build_unit_contents(schedule=schedule, run_script=RUN_SCRIPT, env=dict(os.environ))
    paths = {"service": unit_dir() / SERVICE_NAME, "timer": unit_dir() / TIMER_NAME}
    if dry_run:
        return {"status": "dry-run", "service": service, "timer": timer, "paths": {k: str(v) for k, v in paths.items()}}
    unit_dir().mkdir(parents=True, exist_ok=True)
    paths["service"].write_text(service, encoding="utf-8")
    paths["timer"].write_text(timer, encoding="utf-8")
    systemctl("daemon-reload")
    systemctl("enable", "--now", TIMER_NAME)
    nxt = systemctl("list-timers", TIMER_NAME, "--no-pager", check=False).stdout.strip()
    return {"status": "installed", "paths": {k: str(v) for k, v in paths.items()}, "timers": nxt}


def uninstall() -> dict:
    systemctl("disable", "--now", TIMER_NAME, check=False)
    removed = []
    for name in (SERVICE_NAME, TIMER_NAME):
        p = unit_dir() / name
        if p.exists():
            p.unlink()
            removed.append(str(p))
    systemctl("daemon-reload", check=False)
    return {"status": "uninstalled", "removed": removed}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schedule", default=DEFAULT_SCHEDULE, help="systemd OnCalendar expression")
    parser.add_argument("--dry-run", action="store_true", help="print unit contents without installing")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()
    print(json.dumps(uninstall() if args.uninstall else install(args.schedule, args.dry_run), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
