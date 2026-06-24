"""Read-only Redis query MCP server via DevService.queryRedis."""

from __future__ import annotations

import json
import re

from mcp.server.fastmcp import FastMCP

from devtools_mcp.common import DEFAULT_BROWSER_PROFILE, bounded_int, command_result_text, error_text, run_command, skill_path

mcp = FastMCP("Redis Query")

DUBBO_SCRIPT = skill_path("test-dubbo-api", "scripts", "dubbo_request.py")
ENV_ALIASES = {
    "stable": "stable",
    "stable环境": "stable",
    "prj": "stable",
    "project": "stable",
    "项目": "stable",
    "项目环境": "stable",
    "test": "stable",
    "testing": "stable",
    "测试": "stable",
    "测试环境": "stable",
    "offline": "stable",
    "线下": "stable",
    "线下环境": "stable",
    "pre": "pre",
    "pre环境": "pre",
    "preview": "pre",
    "预发布": "pre",
    "预发布环境": "pre",
    "gray": "pre",
    "gray环境": "pre",
    "灰度": "pre",
    "灰度环境": "pre",
    "prod": "pre",
    "prod环境": "pre",
    "online": "pre",
    "线上": "pre",
    "线上环境": "pre",
    "生产": "pre",
    "生产环境": "pre",
}
KEY_ENV_ALIASES = {
    "stable": "stable",
    "test": "stable",
    "testing": "stable",
    "offline": "stable",
    "pre": "pre",
    "preview": "pre",
    "gray": "pre",
    "prod": "pre",
    "online": "pre",
}


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


def _infer_env_from_key(key: str) -> str:
    tokens = [item for item in re.split(r"[:_\-./]+", key or "") if item]
    for token in reversed(tokens):
        canonical = KEY_ENV_ALIASES.get(token.lower())
        if canonical:
            return canonical
    return ""


def _resolve_env(env: str, key: str) -> str:
    raw = str(env or "").strip()
    if not raw or raw.lower() == "auto":
        inferred = _infer_env_from_key(key)
        if inferred:
            return inferred
        raise ValueError("env is required when key does not contain stable/pre/gray/prod/online/test/offline")
    canonical = ENV_ALIASES.get(raw) or ENV_ALIASES.get(raw.lower())
    if canonical:
        return canonical
    raise ValueError(f"unsupported env: {env}")


@mcp.tool()
def redis_query(
    service: str,
    key: str,
    env: str = "auto",
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
    try:
        target_env = _resolve_env(env, key)
    except ValueError as exc:
        return error_text(str(exc), key=key, env=env)
    params = [instance_name or "", key, _fields(fields), bool(fetch_data)]
    args = [
        DUBBO_SCRIPT,
        f"--env={target_env}",
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
