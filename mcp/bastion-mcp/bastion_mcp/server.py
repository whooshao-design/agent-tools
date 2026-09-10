"""堡垒机 MCP Server - 通过堡垒机在目标机器上执行命令"""

import asyncio
import json
import logging
import os
import re
import shlex
import sys

from mcp.server.fastmcp import FastMCP

try:
    from bastion_mcp.ssh_manager import SSHManager
except ModuleNotFoundError:
    sys.path.insert(0, os.path.dirname(__file__))
    from ssh_manager import SSHManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

mcp = FastMCP("Bastion Host")
ssh_mgr: SSHManager = None


def _load_config(profile: str = "") -> dict:
    config_path = os.environ.get(
        "BASTION_CONFIG",
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "config.json"),
    )
    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)

    profile = profile or os.environ.get("BASTION_PROFILE", "") or config.get("default_profile", "")
    if not profile:
        return config

    profiles = config.get("profiles", {})
    if profile not in profiles:
        raise ValueError(f"未知堡垒机配置 profile: {profile}")

    base_config = {
        key: value
        for key, value in config.items()
        if key not in ("profiles", "default_profile")
    }
    base_config.update(profiles[profile])
    return base_config


@mcp.tool()
async def connect_bastion(
    password: str = "", otp: str = "", keepalive_ip: str = "", profile: str = ""
) -> str:
    """连接堡垒机。如果需要密码和动态验证码，请提供对应参数。
    PEM 认证足够时可不传。
    keepalive_ip: 保活用的目标机器 IP，默认使用配置文件中的值
    profile: 使用配置文件中的指定 profiles 条目，未传则使用默认配置"""
    global ssh_mgr
    try:
        config = _load_config(profile)
    except ValueError as e:
        return f"错误：{e}"
    ssh_mgr = SSHManager(config)
    # 密码优先级：工具参数 > 环境变量 BASTION_PASSWORD > config.json
    final_password = password or os.environ.get("BASTION_PASSWORD", "") or config.get("password", "")
    return await asyncio.to_thread(
        ssh_mgr.connect,
        password=final_password,
        otp=otp,
        keepalive_ip=keepalive_ip or config.get("keepalive_ip", "10.11.86.153"),
    )


# 默认只读护栏：拦截明显的写/破坏类命令与重定向写入。
# 确需放开时设置环境变量 BASTION_ALLOW_WRITE=1（自担风险）。
_WRITE_COMMAND = re.compile(
    r"(^|[;&|]\s*)("
    r"rm|mv|cp|dd|mkfs|chmod|chown|chgrp|touch|tee|truncate|shred|"
    r"kill|pkill|killall|reboot|shutdown|halt|poweroff|systemctl|service|"
    r"crontab|useradd|userdel|usermod|passwd|mount|umount|"
    r"yum|apt|apt-get|dnf|rpm|pip|npm"
    r")\b"
)
_WRITE_REDIRECT = re.compile(r"(?<![<>])>{1,2}(?!&\d)")


def _is_write_command(command: str) -> bool:
    return bool(_WRITE_COMMAND.search(command) or _WRITE_REDIRECT.search(command))


_CLICKHOUSE_READONLY_START = re.compile(
    r"^\s*(select|with|show|describe|desc|explain)\b",
    re.IGNORECASE | re.DOTALL,
)
_CLICKHOUSE_FORBIDDEN = re.compile(
    r"\b("
    r"insert|update|delete|alter|drop|truncate|create|rename|grant|revoke|"
    r"attach|detach|optimize|kill|system|set|use|watch|backup|restore"
    r")\b|\binto\s+outfile\b",
    re.IGNORECASE,
)
_CLICKHOUSE_FORMATS = {
    "TabSeparated",
    "TabSeparatedWithNames",
    "CSV",
    "CSVWithNames",
    "JSON",
    "JSONEachRow",
    "Pretty",
    "PrettyCompact",
    "Vertical",
}


def _validate_clickhouse_sql(sql: str) -> tuple[str, str | None]:
    normalized = sql.strip()
    if not normalized:
        return "", "SQL 不能为空"

    while normalized.endswith(";"):
        normalized = normalized[:-1].strip()
    if ";" in normalized:
        return "", "只允许单条 SQL，不允许包含分号分隔的多语句"
    if not _CLICKHOUSE_READONLY_START.match(normalized):
        return "", "只允许 SELECT/WITH/SHOW/DESCRIBE/DESC/EXPLAIN 只读 SQL"
    match = _CLICKHOUSE_FORBIDDEN.search(normalized)
    if match:
        return "", f"SQL 包含禁止的写入/管理关键字: {match.group(0)}"
    return normalized, None


def _build_clickhouse_command(config: dict, sql: str, database: str,
                              output_format: str) -> tuple[str, str | None]:
    ch_config = config.get("clickhouse") or {}
    required = ("host", "port", "user", "password")
    missing = [key for key in required if ch_config.get(key) in (None, "")]
    if missing:
        return "", f"缺少 clickhouse 配置字段: {', '.join(missing)}"

    if output_format not in _CLICKHOUSE_FORMATS:
        return "", f"不支持的输出格式: {output_format}"

    args = [
        ch_config.get("client", "/usr/bin/clickhouse-client"),
        "--host", ch_config["host"],
        "--port", str(ch_config["port"]),
        "--user", ch_config["user"],
        "--password", ch_config["password"],
    ]
    db = database or ch_config.get("database", "")
    if db:
        args.extend(["--database", db])
    args.extend(["--format", output_format, "--query", sql])
    return " ".join(shlex.quote(str(arg)) for arg in args), None


def _truncate_output(text: str, max_chars: int) -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    return text[:max_chars] + f"\n... 输出已截断，原始长度 {len(text)} 字符 ..."


@mcp.tool()
async def execute_command(ip: str, command: str, timeout: int = 30) -> str:
    """在目标机器上执行只读命令。必须先在本 MCP 调用 connect_bastion；不共享 java_app_diag 的连接。
    ip: 目标机器 IP（通过堡垒机 go 命令跳转）
    command: 要执行的命令（默认只读护栏：写/破坏类命令与重定向写入会被拒绝）
    timeout: 命令超时秒数"""
    if not ssh_mgr or not ssh_mgr.is_connected():
        return "错误：当前 bastion MCP 未连接；连接不与 java_app_diag 等 MCP 共享。请先在当前 MCP 调用 connect_bastion，并按环境显式指定 profile（项目/stable=dev，预发/灰度/线上=online，DBA=dba）。"
    if os.environ.get("BASTION_ALLOW_WRITE") != "1" and _is_write_command(command):
        return (
            "错误：命令被只读护栏拦截（包含写/破坏类命令或重定向写入）。"
            "如确需执行，请在 MCP 注册中设置 BASTION_ALLOW_WRITE=1 后重启。"
        )
    return await asyncio.to_thread(ssh_mgr.execute_on_target, ip, command, timeout)


@mcp.tool()
async def clickhouse_query(
    sql: str,
    ip: str = "",
    database: str = "",
    timeout: int = 60,
    output_format: str = "TabSeparatedWithNames",
    max_chars: int = 20000,
) -> str:
    """通过目标机器上的 clickhouse-client 执行只读 SQL。
    sql: 仅允许 SELECT/WITH/SHOW/DESCRIBE/DESC/EXPLAIN。
    ip: ClickHouse 工具机 IP，默认使用配置中的 keepalive_ip。
    database: 库名，默认使用配置 clickhouse.database。
    output_format: 输出格式，默认 TabSeparatedWithNames。
    max_chars: 返回内容最大字符数，默认 20000。"""
    if not ssh_mgr or not ssh_mgr.is_connected():
        return "错误：当前 bastion MCP 未连接；连接不与 java_app_diag 等 MCP 共享。请先在当前 MCP 调用 connect_bastion，并按环境显式指定 profile（项目/stable=dev，预发/灰度/线上=online，DBA=dba）。"

    readonly_sql, error = _validate_clickhouse_sql(sql)
    if error:
        return f"错误：{error}"

    command, error = _build_clickhouse_command(
        ssh_mgr.config,
        readonly_sql,
        database=database,
        output_format=output_format,
    )
    if error:
        return f"错误：{error}"

    target_ip = ip or ssh_mgr.config.get("clickhouse", {}).get("tool_ip") or ssh_mgr.config.get("keepalive_ip", "")
    if not target_ip:
        return "错误：缺少 ClickHouse 工具机 IP，请传入 ip 或配置 keepalive_ip"

    result = await asyncio.to_thread(
        ssh_mgr.execute_raw_on_target,
        target_ip,
        command,
        timeout,
    )
    return _truncate_output(result, max_chars)


@mcp.tool()
async def connection_status() -> str:
    """查看堡垒机连接状态"""
    if not ssh_mgr:
        return "未初始化"
    return "已连接" if ssh_mgr.is_connected() else "已断开"


@mcp.tool()
async def disconnect_bastion() -> str:
    """断开堡垒机连接"""
    if ssh_mgr:
        ssh_mgr.disconnect()
        return "已断开"
    return "未连接"


def main():
    transport = "stdio"
    port = 8000
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] in ("--transport", "-t") and i + 1 < len(args):
            transport = args[i + 1]
            i += 2
        elif args[i] in ("--port", "-p") and i + 1 < len(args):
            port = int(args[i + 1])
            i += 2
        else:
            i += 1

    if transport == "stdio":
        mcp.run(transport="stdio")
    else:
        # 堡垒机通道仅限本机访问；确需外部访问时通过 BASTION_HTTP_HOST 显式放开
        mcp.settings.host = os.environ.get("BASTION_HTTP_HOST", "127.0.0.1")
        mcp.settings.port = port
        mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
