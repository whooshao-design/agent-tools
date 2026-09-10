"""Healthy/Nightingale MCP server backed by the dashboard helper script."""

from __future__ import annotations

import json
import re
import tempfile
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from devtools_mcp.common import command_result_text, error_text, run_command, skill_path

mcp = FastMCP("Healthy Dashboard")

HEALTHY_SCRIPT = skill_path("healthy-dashboard-config", "scripts", "healthy_dashboard_config.js")
METRICS_SCRIPT = skill_path("inspect-healthy-metrics", "scripts", "inspect_metrics.js")
DEFAULT_PROFILE = "/home/joney/.local/state/agent-tools/browser-profiles/healthy"
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True)


def _run(args: list[str], timeout: int = 180, script: str = HEALTHY_SCRIPT) -> str:
    return command_result_text(run_command(["node", script, *args], timeout=timeout), max_chars=50000)


def _board_args(board_id: int, env: str, profile: str) -> list[str]:
    if board_id <= 0:
        raise ValueError("board_id 必须是正整数")
    if env not in ("stable", "prod"):
        raise ValueError("env 必须是 stable 或 prod；预发布使用 prod 站点并在查询中筛选 env=pre")
    return [f"--board={board_id}", f"--env={env}", f"--profile={profile}"]


@mcp.tool(annotations=READ_ONLY)
def healthy_read_board(board_id: int, profile: str = DEFAULT_PROFILE, env: str = "prod") -> str:
    """只读回读 stable/线上大盘，返回完整 configs、configsSha256 和唯一备份目录。"""
    try:
        return _run([*_board_args(board_id, env, profile), "--read"])
    except ValueError as exc:
        return error_text(str(exc))


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
def healthy_apply_hawk_read_through(board_id: int, profile: str = DEFAULT_PROFILE, env: str = "prod") -> str:
    """向指定大盘应用已沉淀的 hawk-read-through 面板模板。会先回读备份再写入。"""
    try:
        return _run([*_board_args(board_id, env, profile), "--mode=hawk-read-through", "--apply"], timeout=240)
    except ValueError as exc:
        return error_text(str(exc))


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
def healthy_update_board(
    board_id: int, configs: dict, expected_configs_sha256: str,
    env: str = "prod", profile: str = DEFAULT_PROFILE,
) -> str:
    """更新已授权的大盘配置。传完整 configs，保留无关内容；sha256 必须来自最近的 read_board。

    写入前备份并检查配置版本，写入后完整回读；目标相同时不重复 PUT。
    """
    try:
        args = _board_args(board_id, env, profile)
        if not isinstance(configs, dict) or not re.fullmatch(r"[a-f0-9]{64}", expected_configs_sha256):
            raise ValueError("需要 configs 对象和 read_board 返回的 configsSha256")
        return _run([*args, "--apply", f"--configs-json={json.dumps(configs, ensure_ascii=False)}",
                     f"--expected-sha256={expected_configs_sha256}"], timeout=240)
    except ValueError as exc:
        return error_text(str(exc))


@mcp.tool(annotations=READ_ONLY)
def healthy_verify_board(
    board_id: int, variables: dict | None = None, env: str = "prod", profile: str = DEFAULT_PROFILE,
) -> str:
    """只读验证大盘页面。variables 如 {\"env\":[\"pre\"],\"ip\":[\"all\"]}。

    滚动加载面板，保存真实 PromQL/响应、下拉选项与截图；不修改大盘配置。
    """
    try:
        return _run([*_board_args(board_id, env, profile), "--verify-page",
                     f"--variables-json={json.dumps(variables or {}, ensure_ascii=False)}"], timeout=240)
    except ValueError as exc:
        return error_text(str(exc))


@mcp.tool(annotations=READ_ONLY)
def healthy_query_metrics(
    queries: list[dict[str, str]], env: str = "prod", query_type: str = "range",
    range_window: str = "30m", step: str = "60s", profile: str = DEFAULT_PROFILE,
) -> str:
    """批量只读查询 PromQL。queries 为 [{\"name\":\"说明\",\"expr\":\"PromQL\"}]。

    一次浏览器会话查询整批表达式，range 使用 query-range-batch；返回摘要和完整结果文件。
    env 表示站点，预发布使用 prod 并在 expr 中指定 env=\"pre\"。
    """
    if env not in ("stable", "prod") or query_type not in ("instant", "range"):
        return error_text("env 必须是 stable/prod，query_type 必须是 instant/range")
    if not queries or any(not isinstance(item, dict) or not isinstance(item.get("name"), str)
                          or not item["name"].strip() or not isinstance(item.get("expr"), str)
                          or not item["expr"].strip() for item in queries):
        return error_text("queries 必须是非空的 {name,expr} 数组")
    output = Path(tempfile.mkdtemp(prefix="healthy-metrics-")) / "results.json"
    return _run([f"--env={env}", f"--profile={profile}", f"--queries-json={json.dumps(queries, ensure_ascii=False)}",
                 f"--query-type={query_type}", f"--range={range_window}", f"--step={step}", f"--output={output}"],
                timeout=240, script=METRICS_SCRIPT)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
