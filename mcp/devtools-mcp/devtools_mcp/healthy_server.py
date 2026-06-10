"""Healthy/Nightingale MCP server backed by the dashboard helper script."""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from devtools_mcp.common import command_result_text, error_text, run_command, skill_path

mcp = FastMCP("Healthy Dashboard")

HEALTHY_SCRIPT = skill_path("healthy-dashboard-config", "scripts", "healthy_dashboard_config.js")


def _run(args: list[str], timeout: int = 180) -> str:
    return command_result_text(run_command(["node", HEALTHY_SCRIPT, *args], timeout=timeout), max_chars=50000)


@mcp.tool()
def healthy_read_board(board_id: int, profile: str = "/tmp/healthy-dashboard-profile") -> str:
    """只读回读 Healthy/Nightingale 大盘配置，并写 /tmp 备份。"""
    if not board_id:
        return error_text("board_id is required")
    return _run([f"--board={board_id}", "--read", f"--profile={profile}"], timeout=180)


@mcp.tool()
def healthy_apply_hawk_read_through(board_id: int, profile: str = "/tmp/healthy-dashboard-profile") -> str:
    """向指定大盘应用已沉淀的 hawk-read-through 面板模板。会先回读备份再写入。"""
    if not board_id:
        return error_text("board_id is required")
    return _run([f"--board={board_id}", "--mode=hawk-read-through", "--apply", f"--profile={profile}"], timeout=240)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
