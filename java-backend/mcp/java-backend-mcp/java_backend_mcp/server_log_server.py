"""Legacy read-only application log MCP server.

Prefer java_app_diag_server for broader Java application host diagnostics.
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from java_backend_mcp.common import bounded_int, error_text
from java_backend_mcp.java_app_diag_core import (
    BastionDiagSession,
    app_log_dir,
    app_log_path,
    q,
    validate_keyword,
)

mcp = FastMCP("Java Server Logs")
session = BastionDiagSession()


async def _execute(ip: str, command: str, timeout: int) -> str:
    return await session.execute(ip, command, bounded_int(timeout, 30, 5, 120))


@mcp.tool()
async def connect_log_bastion(password: str = "", otp: str = "", keepalive_ip: str = "") -> str:
    """连接堡垒机，供日志只读查询使用。PEM 认证足够时可不传密码。"""
    return await session.connect(password=password, otp=otp, keepalive_ip=keepalive_ip)


@mcp.tool()
async def log_connection_status() -> str:
    """查看日志 MCP 的堡垒机连接状态。"""
    return await session.status()


@mcp.tool()
async def list_log_files(ip: str, app_name: str, timeout: int = 30) -> str:
    """列出 /home/product/logs/{app_name}_logs/ 下的日志文件。"""
    try:
        command = f"ls {q(app_log_dir(app_name))}/"
    except ValueError as exc:
        return error_text(str(exc))
    return await _execute(ip, command, timeout)


@mcp.tool()
async def tail_app_log(ip: str, app_name: str, file_name: str = "error.log", lines: int = 200, timeout: int = 30) -> str:
    """查看应用日志尾部内容。支持 debug/error/info/stdout 日志及其轮转文件。"""
    try:
        path = app_log_path(app_name, file_name)
        line_count = bounded_int(lines, 200, 1, 1000)
    except ValueError as exc:
        return error_text(str(exc))
    if path.endswith(".gz"):
        command = f"zcat {q(path)} | tail -{line_count}"
    else:
        command = f"tail -{line_count} {q(path)}"
    return await _execute(ip, command, timeout)


@mcp.tool()
async def grep_app_log(
    ip: str,
    app_name: str,
    keyword: str,
    file_name: str = "error.log",
    ignore_case: bool = True,
    lines: int = 50,
    timeout: int = 30,
) -> str:
    """按关键字查询应用日志。仅执行只读 grep/zcat/tail。"""
    try:
        path = app_log_path(app_name, file_name)
        safe_keyword = validate_keyword(keyword)
        line_count = bounded_int(lines, 50, 1, 500)
    except ValueError as exc:
        return error_text(str(exc))
    grep_flag = "-i " if ignore_case else ""
    if path.endswith(".gz"):
        command = f"zcat {q(path)} | grep {grep_flag}{q(safe_keyword)} | tail -{line_count}"
    else:
        command = f"grep {grep_flag}{q(safe_keyword)} {q(path)} | tail -{line_count}"
    return await _execute(ip, command, timeout)


@mcp.tool()
async def recent_error_summary(ip: str, app_name: str, timeout: int = 30) -> str:
    """提取 error.log 里最近的 ERROR/Exception/Caused by 关键行。"""
    try:
        path = app_log_path(app_name, "error.log")
    except ValueError as exc:
        return error_text(str(exc))
    command = f"grep -i 'ERROR\\|Exception\\|Throwable\\|Caused by' {q(path)} | tail -80"
    return await _execute(ip, command, timeout)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
