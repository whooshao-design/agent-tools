"""Shared safe diagnostics helpers for Java application hosts."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import sys
from pathlib import Path, PurePosixPath

try:
    import bastion_mcp.ssh_manager as bastion_ssh
except ModuleNotFoundError:
    sys.path.insert(0, os.environ.get("BASTION_MCP_ROOT", str(Path.home() / "ai" / "mcp" / "bastion-mcp")))
    import bastion_mcp.ssh_manager as bastion_ssh

from java_backend_mcp.common import bounded_int

DIAG_COMMANDS = {
    "curl",
    "date",
    "df",
    "free",
    "jcmd",
    "jps",
    "jstat",
    "netstat",
    "ps",
    "readlink",
    "ss",
    "stat",
    "uptime",
    "vmstat",
}

bastion_ssh.ALLOWED_COMMANDS.update(DIAG_COMMANDS)
SSHManager = bastion_ssh.SSHManager

APP_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
VERSION_RE = re.compile(r"^[A-Za-z0-9_.@:+-]+$")
PID_RE = re.compile(r"^[1-9][0-9]{0,8}$")
LOG_RE = re.compile(r"^(?:debug|error|info|stdout)\.log(?:[.\w-]+)?(?:\.gz)?$")
HEALTH_PATH_RE = re.compile(r"^/[A-Za-z0-9_./?=&:%+-]*$")
SENSITIVE_HEALTH_SEGMENTS = {
    "actuator/env",
    "actuator/configprops",
    "actuator/heapdump",
    "actuator/threaddump",
    "actuator/logfile",
    "actuator/loggers",
    "actuator/mappings",
    "env",
    "configprops",
    "heapdump",
    "threaddump",
    "logfile",
}


class BastionDiagSession:
    """Owns one bastion connection for a diagnostics MCP process."""

    def __init__(self) -> None:
        self.ssh_mgr: SSHManager | None = None

    def _load_config(self) -> dict:
        config_path = os.environ.get("BASTION_CONFIG", str(Path.home() / "ai" / "mcp" / "bastion-mcp" / "config.json"))
        with open(config_path, encoding="utf-8") as f:
            return json.load(f)

    async def connect(self, password: str = "", otp: str = "", keepalive_ip: str = "") -> str:
        config = self._load_config()
        self.ssh_mgr = SSHManager(config)
        final_password = password or os.environ.get("BASTION_PASSWORD", "") or config.get("password", "")
        return await asyncio.to_thread(
            self.ssh_mgr.connect,
            password=final_password,
            otp=otp,
            keepalive_ip=keepalive_ip or config.get("keepalive_ip", "10.11.86.153"),
        )

    async def status(self) -> str:
        if not self.ssh_mgr:
            return "未初始化"
        return "已连接" if self.ssh_mgr.is_connected() else "已断开"

    async def execute(self, ip: str, command: str, timeout: int) -> str:
        if not self.ssh_mgr or not self.ssh_mgr.is_connected():
            return "错误：未连接堡垒机，请先调用连接工具"
        return await asyncio.to_thread(
            self.ssh_mgr.execute_on_target,
            ip,
            command,
            bounded_int(timeout, 30, 5, 180),
        )


def validate_app(app_name: str) -> str:
    if not APP_RE.fullmatch(app_name or ""):
        raise ValueError("app_name only supports letters, digits, underscore, dot and hyphen")
    return app_name


def validate_version(version_tag: str) -> str:
    if not VERSION_RE.fullmatch(version_tag or ""):
        raise ValueError("version_tag only supports letters, digits, underscore, dot, at, colon, plus and hyphen")
    return version_tag


def validate_pid(pid: str | int) -> str:
    value = str(pid or "").strip()
    if not PID_RE.fullmatch(value):
        raise ValueError("pid must be a positive integer")
    return value


def validate_port(port: str | int) -> str:
    try:
        parsed = int(port)
    except Exception as exc:
        raise ValueError("port must be an integer") from exc
    if parsed < 1 or parsed > 65535:
        raise ValueError("port must be between 1 and 65535")
    return str(parsed)


def validate_keyword(keyword: str) -> str:
    value = str(keyword or "")
    if not value:
        raise ValueError("keyword is required")
    if "\n" in value or "\r" in value:
        raise ValueError("keyword must be a single line")
    if len(value) > 300:
        raise ValueError("keyword is too long")
    return value


def validate_log_file(file_name: str, default: str = "error.log") -> str:
    name = file_name or default
    if "/" in name or not LOG_RE.fullmatch(name):
        raise ValueError("file_name must be debug.log/error.log/info.log/stdout.log or their rotated .gz files")
    return name


def validate_health_path(path: str) -> str:
    value = path or "/actuator/health"
    if not HEALTH_PATH_RE.fullmatch(value) or ".." in value:
        raise ValueError("path must be a safe absolute HTTP path")
    normalized = value.strip("/").lower()
    if any(normalized == item or normalized.startswith(f"{item}/") for item in SENSITIVE_HEALTH_SEGMENTS):
        raise ValueError("sensitive actuator endpoints are not allowed")
    return value


def app_log_dir(app_name: str) -> str:
    return str(PurePosixPath("/home/product/logs") / f"{validate_app(app_name)}_logs")


def app_log_path(app_name: str, file_name: str = "error.log") -> str:
    return str(PurePosixPath(app_log_dir(app_name)) / validate_log_file(file_name))


def version_log_dir(app_name: str, version_tag: str) -> str:
    return str(PurePosixPath("/home/publish_product/server_java") / validate_app(app_name) / validate_version(version_tag) / "logs")


def version_log_path(app_name: str, version_tag: str, file_name: str = "stdout.log") -> str:
    return str(PurePosixPath(version_log_dir(app_name, version_tag)) / validate_log_file(file_name, "stdout.log"))


def q(value: str) -> str:
    return shlex.quote(value)


def ensure_success(command: str) -> str:
    return f"{command}; echo __java_app_diag_done__"
