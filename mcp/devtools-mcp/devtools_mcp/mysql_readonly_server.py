"""Read-only MySQL MCP server backed by the lxcloud HTTP SQL script (mysql_readonly.js)."""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from devtools_mcp.common import bounded_int, command_result_text, error_text, run_command, skill_path

mcp = FastMCP("MySQL Readonly")

MYSQL_SCRIPT = skill_path("query-mysql-data", "scripts", "mysql_readonly.js")


def _run(args: list[str], timeout: int = 120, max_chars: int = 20000) -> str:
    return command_result_text(run_command(["node", MYSQL_SCRIPT, *args], timeout=timeout), max_chars=max_chars)


@mcp.tool()
def mysql_doctor() -> str:
    """检查 MySQL 只读脚本、lxcloud 环境入口和浏览器 session 依赖状态。"""
    return _run(["--doctor"], timeout=30)


@mcp.tool()
def mysql_lxcloud_query(
    query: str,
    db_type: str,
    env: str = "prod",
    user_name: str = "",
    query_type: str = "single",
    query_role: str = "masterbackup",
    timeout_seconds: int = 120,
    max_chars: int = 20000,
) -> str:
    """通过 lxcloud HTTP SQL 只读查询 MySQL。env 为 prod（线上，默认）或 stable（测试/stable）；db_type 接受代码确认且当前账号有权访问的任意实例。"""
    if not query:
        return error_text("query is required")
    if not db_type:
        return error_text("db_type is required")
    args = [
        f"--env={env or 'prod'}",
        f"--db-type={db_type}",
        f"--query={query}",
        f"--query-type={query_type or 'single'}",
        f"--query-role={query_role or 'masterbackup'}",
    ]
    if user_name:
        args.append(f"--user-name={user_name}")
    timeout = bounded_int(timeout_seconds, 120, 5, 600)
    return _run(args, timeout=timeout, max_chars=bounded_int(max_chars, 20000, 1000, 100000))


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
