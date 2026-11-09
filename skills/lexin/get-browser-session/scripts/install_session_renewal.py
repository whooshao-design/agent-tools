#!/usr/bin/env python3
"""Install or remove the browser-session renewal systemd user timer."""

from __future__ import annotations

# agent-tools bootstrap（模板 lib/agent_tools/bootstrap.py）
import errno, os, stat, sys
from pathlib import Path
def _probe(d):  # 'hit' | 'miss' | 异常码：先看 install.py（缺失即 miss）再看 skills/，install.py 是普通文件且 skills/ 是目录才 hit；不存在与不是目录算 miss，其余 OSError 取 errno 名；不用遇错返回 False 的 os.path.isdir
    if not d: return 'miss'
    try: return 'hit' if stat.S_ISREG(os.stat(os.path.join(d, 'install.py')).st_mode) and stat.S_ISDIR(os.stat(os.path.join(d, 'skills')).st_mode) else 'miss'
    except (FileNotFoundError, NotADirectoryError): return 'miss'
    except OSError as e: return errno.errorcode.get(e.errno, 'error')
_tried, _root, _r = [], '', 'miss'
try:
    _d = str(Path(__file__).resolve().parent); _tried.append(f'上溯起点 {_d}')
    while (_r := _probe(_d)) == 'miss' and os.path.dirname(_d) != _d: _d = os.path.dirname(_d)
    if _r == 'hit': _root = _d
    else: _tried[0] += ' 未命中有效根（install.py 文件 + skills/ 目录）' if _r == 'miss' else f' {_r}（放弃上溯）'
except OSError as e: _tried.append(f'上溯起点 {__file__} {errno.errorcode.get(e.errno, e)}')
if not _root:
    _v = os.environ.get('AGENT_TOOLS_ROOT', ''); _r = _probe(_v)
    _tried.append(f"AGENT_TOOLS_ROOT={_v or '<unset>'}" + ('' if _r in ('hit', 'miss') else f' {_r}'))
    if _r == 'hit': _root = _v
if not _root:
    _p = Path.home() / '.config/agent-tools/root'
    try:
        _v = _p.read_text().strip(); _r = _probe(_v); _tried.append(f'{_p} = {_v}' + ('' if _r in ('hit', 'miss') else f' {_r}'))
        if _r == 'hit': _root = _v
    except OSError as e: _tried.append(f"{_p} {'<absent>' if e.errno == errno.ENOENT else errno.errorcode.get(e.errno, e)}")
if not _root:
    print('\n'.join(['agent-tools: 未找到仓库根', *_tried, '请在仓库目录运行 python3 install.py']), file=sys.stderr); sys.exit(2)
# agent-tools bootstrap end
sys.path.insert(0, os.path.join(_root, 'lib'))
from agent_tools import locate  # noqa: E402

import argparse
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import urlparse


UNIT_NAME = "agent-tools-browser-session-renewal"
SERVICE_NAME = f"{UNIT_NAME}.service"
TIMER_NAME = f"{UNIT_NAME}.timer"
DEFAULT_SCHEDULE = "*-*-* 11:00:00"
MAIN_PROFILE = Path.home() / ".local" / "state" / "agent-tools" / "browser-profiles" / "main"
HEALTHY_PROFILE = Path.home() / ".local" / "state" / "agent-tools" / "browser-profiles" / "healthy"
SESSION_SNAPSHOT = Path.home() / ".local" / "state" / "agent-tools" / "session-snapshots" / "main.json"
DEFAULT_BROWSER_SCRIPT = Path(__file__).resolve().with_name("browser_session.js")

MANUAL_STEPS = """{unit} 一期只支持 Linux/WSL 的 systemd user 定时器；当前平台 {platform} 没有 systemd，未安装任何文件。
手工等价步骤：按计划 {schedule} 对每个续期目标运行
  {command}
macOS launchd：写 ~/Library/LaunchAgents/{label}.plist，ProgramArguments 为上面的命令，StartCalendarInterval 对应计划时间，
EnvironmentVariables 含 AGENT_TOOLS_ROOT={root}，然后 launchctl load 该文件；或等价的 cron 条目。
"""


def require_systemd(*, schedule: str, command: str) -> None:
    """Linux/WSL 以外没有 systemd：退出码 2 并打印手工步骤（RISK-006，launchd 后端留二期）。"""
    current = locate.platform()
    if current in ("linux", "wsl"):
        return
    sys.stderr.write(MANUAL_STEPS.format(unit=UNIT_NAME, platform=current, schedule=schedule, command=command,
                                         label=f"com.agent-tools.{UNIT_NAME}", root=_root))
    sys.exit(2)


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


def validate_config(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("renewal URL must be an HTTPS URL")


def validate_schedule(schedule: str) -> None:
    """Reject anything that could break out of the timer unit's OnCalendar line."""
    if not schedule or not schedule.strip():
        raise ValueError("schedule must not be empty")
    if any(ch in schedule for ch in "\n\r"):
        raise ValueError("schedule must be a single line")


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
    schedule: str,
    root: str | None = None,
) -> tuple[str, str]:
    if not targets:
        raise ValueError("at least one renewal target is required")
    validate_schedule(schedule)
    for target in targets:
        validate_config(target["url"])
    # "-" lets a failing target be skipped instead of aborting the remaining ones.
    exec_lines = "\n".join(f"ExecStart=-{target_command(browser_script, target)}" for target in targets)
    # 复制模式下 browser_session.js 的副本上溯不到仓库，靠这个变量找仓库根（3.5）
    root_line = f"Environment={systemd_quote(f'AGENT_TOOLS_ROOT={root or _root}')}"
    service = f"""[Unit]
Description=Renew the agent-tools browser session
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
{root_line}
{exec_lines}
TimeoutStartSec=25min
"""
    # Persistent=true matters here: WSL is often shut down, and without it a missed
    # 11:00 trigger would simply be skipped until the next day.
    timer = f"""[Unit]
Description=Renew the agent-tools browser session on schedule ({schedule})

[Timer]
OnCalendar={schedule}
Persistent=true
OnBootSec=5m
RandomizedDelaySec=5m
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
    require_systemd(schedule=args.schedule, command=f"node {browser_script} --renew ...（目标见 default_targets()）")
    if not browser_script.is_file():
        raise FileNotFoundError(f"browser session script not found: {browser_script}")
    targets = default_targets()
    service, timer = build_unit_contents(
        browser_script=browser_script,
        targets=targets,
        schedule=args.schedule,
    )
    paths = write_units(default_unit_dir(), service, timer)
    run_systemctl("daemon-reload")
    run_systemctl("enable", "--now", TIMER_NAME)
    run_systemctl("start", SERVICE_NAME)
    return {
        "action": "installed",
        "service": str(paths["service"]),
        "timer": str(paths["timer"]),
        "schedule": args.schedule,
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
    require_systemd(schedule=DEFAULT_SCHEDULE, command=f"node {DEFAULT_BROWSER_SCRIPT} --renew ...")
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
    parser.add_argument("--schedule", default=DEFAULT_SCHEDULE, help="systemd OnCalendar expression")
    parser.add_argument("--browser-script", default=str(DEFAULT_BROWSER_SCRIPT))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = uninstall() if args.uninstall else install(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
