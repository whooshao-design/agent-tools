"""Shared safe diagnostics helpers for Java application hosts."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import sys
from pathlib import Path, PurePosixPath

MCP_DIR = Path(__file__).resolve().parents[2]
BASTION_MCP_ROOT = MCP_DIR / "bastion-mcp"
DEFAULT_BASTION_CONFIG = BASTION_MCP_ROOT / "config.json"
ENV_PROFILE_ALIASES = {
    "online": "online",
    "prod": "online",
    "production": "online",
    "gray": "online",
    "grey": "online",
    "pre": "online",
    "pre-release": "online",
    "prerelease": "online",
    "线上": "online",
    "生产": "online",
    "灰度": "online",
    "预发": "online",
    "预发布": "online",
    "stable": "dev",
    "test": "dev",
    "testing": "dev",
    "prj": "dev",
    "project": "dev",
    "dev": "dev",
    "项目": "dev",
    "项目环境": "dev",
    "dba": "dba",
}
AUTH_HINT_MARKERS = (
    "要求输入密码",
    "要求输入安全码",
    "未提供 password",
    "密钥认证失败",
    "认证失败",
    "验证失败",
)

try:
    import bastion_mcp.ssh_manager as bastion_ssh
except ModuleNotFoundError:
    sys.path.insert(0, os.environ.get("BASTION_MCP_ROOT", str(BASTION_MCP_ROOT)))
    import bastion_mcp.ssh_manager as bastion_ssh

from devtools_mcp.common import bounded_int

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
# 兼容后缀轮转和时间戳位于扩展名前的轮转，仍只允许日志文件名。
LOG_RE = re.compile(
    r"^(?:debug|error|warn|info|stdout)"
    r"(?:\.log(?:[.\w-]+)?|_\d{8}(?:\d{2}){0,3}(?:\.\d+)?\.log)(?:\.gz)?$"
)
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
        self.active_profile = ""
        self.active_bastion_host = ""

    def _read_config(self) -> dict:
        config_path = os.environ.get("BASTION_CONFIG", str(DEFAULT_BASTION_CONFIG))
        with open(config_path, encoding="utf-8") as f:
            return json.load(f)

    def _select_profile(self, config: dict, profile: str = "") -> str:
        candidate = (
            profile
            or os.environ.get("JAVA_APP_DIAG_BASTION_PROFILE", "")
            or os.environ.get("BASTION_PROFILE", "")
            or config.get("default_profile", "")
        )
        return resolve_bastion_profile(profile=candidate)

    def _load_config(self, profile: str = "") -> tuple[dict, str]:
        config = self._read_config()
        selected_profile = self._select_profile(config, profile)
        if not selected_profile:
            return config, ""

        profiles = config.get("profiles", {})
        if not isinstance(profiles, dict) or selected_profile not in profiles:
            raise ValueError(f"未知堡垒机配置 profile: {selected_profile}")

        profile_config = profiles[selected_profile]
        if not isinstance(profile_config, dict):
            raise ValueError(f"堡垒机配置 profile 必须是对象: {selected_profile}")

        base_config = {
            key: value
            for key, value in config.items()
            if key not in ("profiles", "default_profile")
        }
        base_config.update(profile_config)
        return base_config, selected_profile

    def _desired_profile(self, env: str = "", profile: str = "") -> str:
        explicit_profile = resolve_bastion_profile(env=env, profile=profile)
        if explicit_profile:
            return explicit_profile
        try:
            config = self._read_config()
        except Exception:
            return ""
        return self._select_profile(config)

    def _format_connect_result(self, result: str, profile: str, config: dict) -> str:
        if not result.startswith("错误"):
            return result
        profile_label = profile or "default"
        host = config.get("bastion_host", "")
        detail = f"当前堡垒机 profile={profile_label}"
        if host:
            detail += f", host={host}"
        if any(marker in result for marker in AUTH_HINT_MARKERS):
            detail += "；MCP 不能复用 Xshell 的交互输入，请传入 password/otp，或确认该 profile 的 PEM/免密认证与 JumpServer 登录态可用"
        return f"{result}（{detail}）"

    async def connect(
        self,
        password: str = "",
        otp: str = "",
        keepalive_ip: str = "",
        env: str = "",
        profile: str = "",
    ) -> str:
        requested_profile = resolve_bastion_profile(env=env, profile=profile)
        try:
            config, loaded_profile = self._load_config(requested_profile)
        except ValueError as exc:
            return f"错误：{exc}"
        if self.ssh_mgr:
            try:
                self.ssh_mgr.disconnect()
            except Exception:
                pass
        self.ssh_mgr = SSHManager(config)
        self.active_profile = loaded_profile
        self.active_bastion_host = config.get("bastion_host", "")
        final_password = password or os.environ.get("BASTION_PASSWORD", "") or config.get("password", "")
        try:
            result = await asyncio.to_thread(
                self.ssh_mgr.connect,
                password=final_password,
                otp=otp,
                keepalive_ip=keepalive_ip or config.get("keepalive_ip", "10.11.86.153"),
            )
        except Exception as exc:
            result = f"错误：连接堡垒机失败：{exc}"
        return self._format_connect_result(result, loaded_profile, config)

    async def status(self) -> str:
        if not self.ssh_mgr:
            return "未初始化"
        state = "已连接" if self.ssh_mgr.is_connected() else "已断开"
        profile = self.active_profile or "default"
        if self.active_bastion_host:
            return f"{state}（profile={profile}, host={self.active_bastion_host}）"
        return f"{state}（profile={profile}）"

    async def execute(self, ip: str, command: str, timeout: int, env: str = "", profile: str = "") -> str:
        desired_profile = self._desired_profile(env=env, profile=profile)
        profile_changed = desired_profile and desired_profile != self.active_profile
        if not self.ssh_mgr or not self.ssh_mgr.is_connected() or profile_changed:
            try:
                connect_result = await self.connect(env=env, profile=profile)
            except Exception as exc:
                return f"错误：未连接堡垒机，自动连接失败：{exc}"
            if connect_result.startswith("错误") or not self.ssh_mgr or not self.ssh_mgr.is_connected():
                return f"错误：未连接堡垒机，自动连接失败：{connect_result}"
        return await asyncio.to_thread(
            self.ssh_mgr.execute_on_target,
            ip,
            command,
            bounded_int(timeout, 30, 5, 180),
        )


def resolve_bastion_profile(env: str = "", profile: str = "") -> str:
    value = str(profile or env or "").strip()
    if not value:
        return ""
    key = value.lower().replace("_", "-")
    return ENV_PROFILE_ALIASES.get(key, key)


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
        raise ValueError(
            "file_name must be debug/error/warn/info/stdout logs or their rotations "
            "(e.g. info.log.1, info_2026091010.0.log, optionally .gz); paths are not allowed"
        )
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
