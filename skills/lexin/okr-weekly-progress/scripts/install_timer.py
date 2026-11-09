#!/usr/bin/env python3
"""Install or remove the weekly OKR summary systemd user timer (okr-weekly.timer)."""

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

UNIT_NAME = "okr-weekly"
SERVICE_NAME = f"{UNIT_NAME}.service"
TIMER_NAME = f"{UNIT_NAME}.timer"
DEFAULT_SCHEDULE = "Fri *-*-* 13:40:00"
RUN_SCRIPT = Path(__file__).resolve().with_name("run_scheduled.sh")
# systemd 用户服务拿不到交互 shell 的 PATH 和代理变量；安装时把当前值写进单元，claude 才能联网
PASSTHROUGH_ENV = ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy")

MANUAL_STEPS = """{unit} 一期只支持 Linux/WSL 的 systemd user 定时器；当前平台 {platform} 没有 systemd，未安装任何文件。
run_scheduled.sh 依赖 systemd 环境与 GNU 工具（sort -z、xargs -r、timeout），一期不在 macOS 运行，也不要用 launchd/cron 直接调它。
手工等价步骤：按计划 {schedule} 在交互会话里说「生成本周 OKR 周报」，核对周报汇总后说「写入 OKR」（仍只存草稿）。
仓库根 AGENT_TOOLS_ROOT={root}。
"""


def require_systemd(*, schedule: str) -> None:
    """Linux/WSL 以外没有 systemd：退出码 2 并打印手工步骤（RISK-006，launchd 后端留二期）。"""
    current = locate.platform()
    if current in ("linux", "wsl"):
        return
    sys.stderr.write(MANUAL_STEPS.format(unit=UNIT_NAME, platform=current, schedule=schedule, root=_root))
    sys.exit(2)


def systemd_quote(value: object) -> str:
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
    escaped = escaped.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f'"{escaped}"'


def validate_schedule(schedule: str) -> None:
    if not schedule or not schedule.strip() or any(ch in schedule for ch in "\n\r"):
        raise ValueError("schedule must be a single non-empty line")


def build_unit_contents(*, schedule: str, run_script: Path, env: dict[str, str], root: str | None = None, docs_root: str | None = None) -> tuple[str, str]:
    validate_schedule(schedule)
    path = ":".join([str(Path.home() / ".npm-global" / "bin"), str(Path.home() / ".local" / "bin"), "/usr/local/bin", "/usr/bin", "/bin"])
    env_lines = [f"Environment={systemd_quote(f'PATH={path}')}", f"Environment={systemd_quote('TZ=Asia/Shanghai')}"]
    env_lines += [f"Environment={systemd_quote(f'{k}={env[k]}')}" for k in PASSTHROUGH_ENV if env.get(k)]
    # 复制模式下 run_scheduled.sh 的副本上三层到不了仓库，靠这两个变量找仓库根与文档根（3.5）
    env_lines += [f"Environment={systemd_quote(f'AGENT_TOOLS_ROOT={root or _root}')}",
                  f"Environment={systemd_quote(f'AGENT_TOOLS_DOCS_ROOT={docs_root or locate.docs_root()}')}"]
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
    require_systemd(schedule=schedule)
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
    require_systemd(schedule=DEFAULT_SCHEDULE)
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
