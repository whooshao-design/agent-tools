"""Read-only Redis query MCP server via DevService.queryRedis."""

from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from java_backend_mcp.common import DEFAULT_BROWSER_PROFILE, bounded_int, command_result_text, error_text, run_command, skill_path

mcp = FastMCP("Redis Query")

DUBBO_SCRIPT = skill_path("test-dubbo-api", "scripts", "dubbo_request.py")


def _fields(value: str) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
        if isinstance(parsed, list):
            return [str(item) for item in parsed]
    except json.JSONDecodeError:
        pass
    return [item.strip() for item in value.split(",") if item.strip()]


@mcp.tool()
def redis_query(
    service: str,
    key: str,
    env: str = "stable",
    app: str = "",
    ip: str = "",
    port: str = "",
    instance_name: str = "",
    fields: str = "",
    fetch_data: bool = False,
    group: str = "default",
    version: str = "2.0.0",
    profile: str = DEFAULT_BROWSER_PROFILE,
    timeout_seconds: int = 120,
) -> str:
    """通过 DevService.queryRedis 只读查询 Redis key。默认 fetch_data=false。"""
    if not service or not key:
        return error_text("service and key are required")
    params = [instance_name or "", key, _fields(fields), bool(fetch_data)]
    args = [
        DUBBO_SCRIPT,
        f"--env={env}",
        f"--service={service}",
        "--method=queryRedis",
        f"--group={group}",
        f"--version={version}",
        f"--params={json.dumps(params, ensure_ascii=False)}",
        f"--profile={profile}",
        f"--timeout={bounded_int(timeout_seconds, 120, 5, 600)}",
    ]
    if app:
        args.append(f"--app={app}")
    if ip:
        args.append(f"--ip={ip}")
    if port:
        args.append(f"--port={port}")
    return command_result_text(
        run_command(["python3", *args], timeout=bounded_int(timeout_seconds, 120, 5, 600) + 30),
        max_chars=50000,
    )


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
