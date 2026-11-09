"""定位与平台库（Python 版），与 locate.js 逐函数等价；另有只有 Python 需要的 render_placeholders()。

调用方写 ``from agent_tools import locate`` 后用 ``locate.platform()``，不要 ``from agent_tools.locate import platform``，
以免遮蔽标准库 platform 模块。
"""
from __future__ import annotations

import base64
import errno
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

POINTER_FILE = Path.home() / ".config/agent-tools/root"
LEGACY_BROWSER_TOOL_DIR = Path.home() / "tools/lexiao-browser"
DEFAULT_BROWSER_TOOL_DIR = Path.home() / ".local/share/agent-tools/browser-tool"
ROOT_MISS_TEXT = "未命中有效根（install.py 文件 + skills/ 目录）"
PLACEHOLDER = re.compile(r"\{\{([A-Z0-9_]+)\}\}")


class AgentToolsLocateError(Exception):
    """code: ROOT_NOT_FOUND | SKILL_NOT_FOUND | UNSUPPORTED_PLATFORM | BROWSER_TOOL_INVALID."""

    def __init__(self, code: str, message: str, tried: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.tried = tried or []


def _warn(message: str) -> None:
    print(f"agent-tools: {message}", file=sys.stderr)


def probe(directory: str | os.PathLike[str] | None) -> str:
    """'hit' | 'miss' | errno 名：有效根 = 同时含 install.py 文件与 skills/ 目录。

    不存在与路径中间不是目录算 miss；其他 OSError 取 errno 名（EACCES 等）交调用方记入 tried。
    不用 os.path.isdir：它遇到任何 OSError 都返回 False，会把无权限当成 miss。
    """
    if not directory:
        return "miss"
    try:
        installer = os.stat(os.path.join(directory, "install.py"))
        skills = os.stat(os.path.join(directory, "skills"))
        return "hit" if stat.S_ISREG(installer.st_mode) and stat.S_ISDIR(skills.st_mode) else "miss"
    except (FileNotFoundError, NotADirectoryError):
        return "miss"
    except OSError as error:
        return errno.errorcode.get(error.errno, "error")


def repo_root(start_dir: str | os.PathLike[str] | None = None, pointer_file: Path = POINTER_FILE) -> str:
    """按上溯、AGENT_TOOLS_ROOT、指针文件的顺序取第一个有效根；三者都没有抛 ROOT_NOT_FOUND。"""
    tried: list[str] = []
    root = ""
    result = "miss"
    start = Path(start_dir) if start_dir is not None else Path(__file__).parent
    try:
        current = str(start.resolve(strict=True))
        tried.append(f"上溯起点 {current}")
        while (result := probe(current)) == "miss" and os.path.dirname(current) != current:
            current = os.path.dirname(current)
        if result == "hit":
            root = current
        else:
            tried[0] += f" {ROOT_MISS_TEXT}" if result == "miss" else f" {result}（放弃上溯）"
    except OSError as error:
        tried.append(f"上溯起点 {start} {errno.errorcode.get(error.errno, error)}")
    if not root:
        value = os.environ.get("AGENT_TOOLS_ROOT", "")
        result = probe(value)
        tried.append(f"AGENT_TOOLS_ROOT={value or '<unset>'}" + ("" if result in ("hit", "miss") else f" {result}"))
        if result == "hit":
            root = value
    if not root:
        try:
            value = pointer_file.read_text(encoding="utf-8").strip()
            result = probe(value)
            tried.append(f"{pointer_file} = {value}" + ("" if result in ("hit", "miss") else f" {result}"))
            if result == "hit":
                root = value
        except OSError as error:
            tried.append(f"{pointer_file} {'<absent>' if error.errno == errno.ENOENT else errno.errorcode.get(error.errno, error)}")
    if not root:
        raise AgentToolsLocateError(
            "ROOT_NOT_FOUND",
            "\n".join(["agent-tools: 未找到仓库根", *tried, "请在仓库目录运行 python3 install.py"]),
            tried,
        )
    return root


def skill_dir(name: str, *parts: str) -> str:
    """skills/<分类>/<name>/<parts>；分类按目录名字典序取第一个存在的。"""
    root = repo_root()
    skills_root = Path(root) / "skills"
    try:
        categories = sorted(entry.name for entry in skills_root.iterdir() if entry.is_dir())
    except OSError as error:
        raise AgentToolsLocateError("SKILL_NOT_FOUND", f"无法读取 {skills_root}: {errno.errorcode.get(error.errno, error)}") from error
    for category in categories:
        candidate = skills_root / category / name
        if candidate.is_dir():
            return str(candidate.joinpath(*parts))
    raise AgentToolsLocateError("SKILL_NOT_FOUND", f"skills/*/{name} 不存在（仓库根 {root}）")


def _path_setting(name: str, fallback: str) -> str:
    value = os.environ.get(name)
    if not value:
        return fallback
    if not os.path.isabs(value) or value.startswith("~"):
        _warn(f"{name}={value} 不是绝对路径，按未设置处理，使用默认值 {fallback}")
        return fallback
    return value


def docs_root() -> str:
    return _path_setting("AGENT_TOOLS_DOCS_ROOT", str(Path.home() / "docs"))


def workspace_root() -> str:
    return _path_setting("AGENT_TOOLS_WORKSPACE_ROOT", str(Path.home() / "projects"))


def _browser_tool_dir_valid(directory: Path) -> bool:
    return (directory / "package.json").exists() and (directory / "node_modules/playwright/package.json").exists()


def browser_tool_dir() -> str:
    configured = _path_setting("BROWSER_SESSION_TOOL_DIR", "")
    if configured:
        return configured
    if not _browser_tool_dir_valid(DEFAULT_BROWSER_TOOL_DIR) and _browser_tool_dir_valid(LEGACY_BROWSER_TOOL_DIR):
        return str(LEGACY_BROWSER_TOOL_DIR)
    return str(DEFAULT_BROWSER_TOOL_DIR)


def _describe_missing(directory: Path) -> str:
    missing = [relative for relative in ("package.json", "node_modules/playwright/package.json") if not (directory / relative).exists()]
    return f"{directory} 缺 {'、'.join(missing)}" if missing else f"{directory} 有效"


def browser_runtime() -> dict:
    """键 toolDir、playwrightDir、executablePath、runtimeLibDir，与 JS 对象同名。"""
    tool_dir = Path(browser_tool_dir())
    if not _browser_tool_dir_valid(tool_dir):
        lines = [
            f"agent-tools: 浏览器工具目录无效：{_describe_missing(tool_dir)}",
            f"默认目录：{_describe_missing(DEFAULT_BROWSER_TOOL_DIR)}",
            f"旧目录：{_describe_missing(LEGACY_BROWSER_TOOL_DIR)}",
            "请运行 skills/lexin/get-browser-session/scripts/setup_browser_tool.sh，或设置 BROWSER_SESSION_TOOL_DIR",
        ]
        raise AgentToolsLocateError("BROWSER_TOOL_INVALID", "\n".join(lines))
    playwright_dir = tool_dir / "node_modules/playwright"
    current = platform()
    executable = ""
    runtime_lib_dir = None
    if current != "darwin":
        bundled = tool_dir / "browsers/chrome-linux64/chrome"
        if bundled.exists():
            executable = str(bundled)
        libs = tool_dir / "runtime-libs/usr/lib/x86_64-linux-gnu"
        if libs.exists():
            runtime_lib_dir = str(libs)
    if not executable:
        # Playwright 自带 Chromium 的位置只有 Node 侧能算，复用同一份 playwright 包求值
        completed = subprocess.run(
            ["node", "-p", f"require({str(playwright_dir)!r}).chromium.executablePath()"],
            capture_output=True, text=True, check=False,
        )
        if completed.returncode != 0:
            raise AgentToolsLocateError("BROWSER_TOOL_INVALID", f"取 Playwright Chromium 路径失败：{completed.stderr.strip()}")
        executable = completed.stdout.strip()
    return {"toolDir": str(tool_dir), "playwrightDir": str(playwright_dir), "executablePath": executable, "runtimeLibDir": runtime_lib_dir}


def platform() -> str:
    """darwin | wsl | linux；其他平台抛 UNSUPPORTED_PLATFORM。"""
    if sys.platform == "darwin":
        return "darwin"
    if sys.platform.startswith("linux"):
        try:
            release = Path("/proc/sys/kernel/osrelease").read_text(encoding="utf-8")
        except OSError as error:
            _warn(f"读取 /proc/sys/kernel/osrelease 失败（{errno.errorcode.get(error.errno, error)}），按 linux 处理")
            return "linux"
        return "wsl" if "microsoft" in release.lower() else "linux"
    raise AgentToolsLocateError("UNSUPPORTED_PLATFORM", f"不支持的平台：{sys.platform}")


def _open_command(target: str) -> list[str]:
    configured = os.environ.get("AGENT_TOOLS_OPEN_CMD", "").strip()
    if configured:
        words = configured.split()
        executable = words[0] if os.path.isabs(words[0]) and os.access(words[0], os.X_OK) else shutil.which(words[0])
        if executable:
            args = words[1:]
            filled = [target if word == "{target}" else word for word in args] if "{target}" in args else [*args, target]
            return [executable, *filled]
        _warn(f"AGENT_TOOLS_OPEN_CMD 的首词 {words[0]} 不是可执行命令，按未设置处理")
    current = platform()
    if current == "darwin":
        return ["open", target]
    if current == "linux":
        return ["xdg-open", target]
    script = "Start-Process '" + target.replace("'", "''") + "'"
    return ["powershell.exe", "-NoProfile", "-EncodedCommand", base64.b64encode(script.encode("utf-16-le")).decode("ascii")]


def open_external(target: str) -> bool:
    """不经 shell 启动；退出码 0 返回 True，命令不存在或退出码非 0 返回 False 并把错误写 stderr。"""
    command = _open_command(target)
    try:
        completed = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, check=False)
    except OSError as error:
        _warn(f"打开 {target} 失败：{command[0]} {errno.errorcode.get(error.errno, error)}")
        return False
    if completed.returncode != 0:
        _warn(f"打开 {target} 失败：{command[0]} 退出码 {completed.returncode} {completed.stderr.strip()}")
        return False
    return True


def render_placeholders(text: str, values: dict[str, str]) -> str:
    """把 text 里的 {{<键>}} 替换为 values[键]；values 的键是裸变量名。

    text 含 values 之外的占位符，或 values 缺键时抛 ValueError，调用方转 InstallError / SystemExit。
    """
    names = set(PLACEHOLDER.findall(text))
    unknown = sorted(names - values.keys())
    if unknown:
        raise ValueError("未知占位符: " + ", ".join(f"{{{{{name}}}}}" for name in unknown))
    return PLACEHOLDER.sub(lambda match: values[match.group(1)], text)
