"""Read-only MySQL MCP server backed by the local mysql_readonly.js script."""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from java_backend_mcp.common import bounded_int, command_result_text, error_text, run_command, skill_path

mcp = FastMCP("MySQL Readonly")

MYSQL_SCRIPT = skill_path("query-mysql-test-data", "scripts", "mysql_readonly.js")


def _run(args: list[str], timeout: int = 120, max_chars: int = 20000) -> str:
    return command_result_text(run_command(["node", MYSQL_SCRIPT, *args], timeout=timeout), max_chars=max_chars)


@mcp.tool()
def mysql_doctor() -> str:
    """检查 MySQL 只读脚本、配置文件和 mysql 客户端状态。"""
    return _run(["--doctor"], timeout=30)


@mcp.tool()
def list_mysql_instances() -> str:
    """列出已配置的 MySQL 只读实例，敏感字段由脚本脱敏。"""
    return _run(["--list"], timeout=30)


@mcp.tool()
def mysql_instance_status(instance: str = "") -> str:
    """查看某个 MySQL 只读实例的配置状态，敏感字段脱敏。"""
    args = ["--status"]
    if instance:
        args.append(f"--instance={instance}")
    return _run(args, timeout=30)


@mcp.tool()
def mysql_check(instance: str = "") -> str:
    """检查指定 MySQL 只读实例连通性。"""
    args = ["--check"]
    if instance:
        args.append(f"--instance={instance}")
    return _run(args, timeout=60)


@mcp.tool()
def mysql_query(query: str, instance: str = "", timeout_seconds: int = 120, max_chars: int = 20000) -> str:
    """执行只读 SQL。脚本会拒绝 INSERT/UPDATE/DELETE/DDL 等写操作。"""
    if not query:
        return error_text("query is required")
    args = [f"--query={query}"]
    if instance:
        args.append(f"--instance={instance}")
    timeout = bounded_int(timeout_seconds, 120, 5, 600)
    return _run(args, timeout=timeout, max_chars=bounded_int(max_chars, 20000, 1000, 100000))


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
