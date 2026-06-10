"""Dubbo service-emulator MCP server backed by the local Bianque script."""

from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from devtools_mcp.common import DEFAULT_BROWSER_PROFILE, bounded_int, command_result_text, error_text, run_command, skill_path

mcp = FastMCP("Dubbo Test")

DUBBO_SCRIPT = skill_path("test-dubbo-api", "scripts", "dubbo_request.py")


def _base_args(
    env: str,
    service: str,
    method: str,
    params_json: str,
    app: str = "",
    ip: str = "",
    port: str = "",
    group: str = "default",
    version: str = "2.0.0",
    profile: str = DEFAULT_BROWSER_PROFILE,
    timeout_seconds: int = 120,
) -> list[str]:
    args = [
        DUBBO_SCRIPT,
        f"--env={env}",
        f"--service={service}",
        f"--method={method}",
        f"--group={group}",
        f"--version={version}",
        f"--params={params_json}",
        f"--timeout={bounded_int(timeout_seconds, 120, 5, 600)}",
    ]
    if app:
        args.append(f"--app={app}")
    if ip:
        args.append(f"--ip={ip}")
    if port:
        args.append(f"--port={port}")
    if profile:
        args.append(f"--profile={profile}")
    return args


def _run(args: list[str], timeout: int = 180, max_chars: int = 30000) -> str:
    return command_result_text(run_command(["python3", *args], timeout=timeout), max_chars=max_chars)


@mcp.tool()
def dubbo_call(
    service: str,
    method: str,
    params_json: str = "[]",
    env: str = "stable",
    app: str = "",
    ip: str = "",
    port: str = "",
    group: str = "default",
    version: str = "2.0.0",
    profile: str = DEFAULT_BROWSER_PROFILE,
    timeout_seconds: int = 120,
) -> str:
    """通过 bianque 服务模拟器调用 Dubbo 接口。params_json 必须是 JSON 数组。"""
    if not service or not method:
        return error_text("service and method are required")
    try:
        params = json.loads(params_json)
    except json.JSONDecodeError as exc:
        return error_text("params_json must be a JSON array", detail=str(exc))
    if not isinstance(params, list):
        return error_text("params_json must be a JSON array")
    args = _base_args(env, service, method, json.dumps(params, ensure_ascii=False), app, ip, port, group, version, profile, timeout_seconds)
    return _run(args, timeout=bounded_int(timeout_seconds, 120, 5, 600) + 30)


@mcp.tool()
def dubbo_dry_run(
    service: str,
    method: str,
    params_json: str = "[]",
    env: str = "stable",
    app: str = "",
    ip: str = "",
    port: str = "",
    group: str = "default",
    version: str = "2.0.0",
) -> str:
    """预览 Dubbo 调用参数，不发起实际请求。"""
    if not service or not method:
        return error_text("service and method are required")
    args = _base_args(env, service, method, params_json, app, ip, port, group, version)
    args.append("--dry-run")
    return _run(args, timeout=30)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
