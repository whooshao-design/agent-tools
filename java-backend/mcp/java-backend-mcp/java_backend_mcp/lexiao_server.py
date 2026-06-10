"""Lexiao deployment MCP server backed by existing Playwright scripts."""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from java_backend_mcp.common import DEFAULT_BROWSER_PROFILE, bounded_int, command_result_text, error_text, run_command, skill_path

mcp = FastMCP("Lexiao Deploy")

PROJECT_SCRIPT = skill_path("lexiao-deploy", "scripts", "lexiao_project_env.js")
PRE_SCRIPT = skill_path("lexiao-deploy", "scripts", "lexiao_pre_release.js")


def _run_node(script: str, args: list[str], timeout: int = 900, max_chars: int = 50000) -> str:
    return command_result_text(run_command(["node", script, *args], timeout=timeout), max_chars=max_chars)


@mcp.tool()
def lexiao_project_status(url: str, app: str, profile: str = DEFAULT_BROWSER_PROFILE) -> str:
    """查询乐效项目环境目标应用行状态。"""
    if not url or not app:
        return error_text("url and app are required")
    return _run_node(PROJECT_SCRIPT, ["--action=status", f"--url={url}", f"--app={app}", f"--profile={profile}"], timeout=120)


@mcp.tool()
def lexiao_project_deploy(
    url: str,
    app: str,
    profile: str = DEFAULT_BROWSER_PROFILE,
    build_timeout_seconds: int = 900,
    deploy_timeout_seconds: int = 900,
) -> str:
    """部署乐效项目环境目标应用。脚本只点击匹配应用行的部署按钮。"""
    if not url or not app:
        return error_text("url and app are required")
    args = [
        "--action=deploy",
        f"--url={url}",
        f"--app={app}",
        f"--profile={profile}",
        f"--build-timeout={bounded_int(build_timeout_seconds, 900, 30, 3600) * 1000}",
        f"--deploy-timeout={bounded_int(deploy_timeout_seconds, 900, 30, 3600) * 1000}",
    ]
    return _run_node(PROJECT_SCRIPT, args, timeout=bounded_int(build_timeout_seconds, 900, 30, 3600) + bounded_int(deploy_timeout_seconds, 900, 30, 3600) + 60)


@mcp.tool()
def lexiao_list_apps(url: str, env: str = "pre", profile: str = "") -> str:
    """列出乐效预发布/灰度页面应用、发布顺序和流水线制品状态。"""
    if not url:
        return error_text("url is required")
    args = ["--action=list-apps", f"--url={url}", f"--env={env}"]
    if profile:
        args.append(f"--profile={profile}")
    return _run_node(PRE_SCRIPT, args, timeout=120)


@mcp.tool()
def lexiao_branch_integrate(url: str, profile: str = "") -> str:
    """触发乐效分支集成。仅适用于受支持的预发布流程。"""
    if not url:
        return error_text("url is required")
    args = ["--action=branch-integrate", f"--url={url}"]
    if profile:
        args.append(f"--profile={profile}")
    return _run_node(PRE_SCRIPT, args, timeout=180)


@mcp.tool()
def lexiao_build_app(url: str, app: str, app_id: str = "", project_id: str = "", env: str = "pre", profile: str = "", timeout_seconds: int = 900) -> str:
    """触发并等待乐效目标应用构建完成。"""
    if not url or not app:
        return error_text("url and app are required")
    args = ["--action=build", f"--url={url}", f"--app={app}", f"--env={env}", f"--timeout={bounded_int(timeout_seconds, 900, 60, 3600) * 1000}"]
    if app_id:
        args.append(f"--app-id={app_id}")
    if project_id:
        args.append(f"--project-id={project_id}")
    if profile:
        args.append(f"--profile={profile}")
    return _run_node(PRE_SCRIPT, args, timeout=bounded_int(timeout_seconds, 900, 60, 3600) + 60)


@mcp.tool()
def lexiao_build_many(url: str, apps: str, env: str = "pre", profile: str = "", timeout_seconds: int = 900) -> str:
    """触发并等待多个乐效目标应用构建完成，apps 用逗号分隔。"""
    if not url or not apps:
        return error_text("url and apps are required")
    args = ["--action=build-many", f"--url={url}", f"--apps={apps}", f"--env={env}", f"--timeout={bounded_int(timeout_seconds, 900, 60, 3600) * 1000}"]
    if profile:
        args.append(f"--profile={profile}")
    return _run_node(PRE_SCRIPT, args, timeout=bounded_int(timeout_seconds, 900, 60, 3600) + 60)


@mcp.tool()
def lexiao_open_order(url: str, app: str, env: str = "pre", profile: str = "") -> str:
    """打开目标应用部署详情，必要时创建新发布单，并返回 order_id。"""
    if not url or not app:
        return error_text("url and app are required")
    args = ["--action=open-order", f"--url={url}", f"--app={app}", f"--env={env}"]
    if profile:
        args.append(f"--profile={profile}")
    return _run_node(PRE_SCRIPT, args, timeout=180)


@mcp.tool()
def lexiao_deploy_one(
    url: str,
    app: str,
    order_id: int,
    env: str = "pre",
    target_type: str = "auto",
    target_ip: str = "",
    deployment_id: str = "",
    profile: str = "",
    timeout_seconds: int = 900,
) -> str:
    """部署乐效预发布/灰度的单个目标。默认 VM/KVM 优先，且只部署一个目标。"""
    if not url or not app or not order_id:
        return error_text("url, app and order_id are required")
    args = [
        "--action=deploy-one",
        f"--url={url}",
        f"--app={app}",
        f"--order-id={order_id}",
        f"--env={env}",
        f"--target-type={target_type}",
        f"--timeout={bounded_int(timeout_seconds, 900, 60, 3600) * 1000}",
    ]
    if target_ip:
        args.append(f"--target-ip={target_ip}")
    if deployment_id:
        args.append(f"--deployment-id={deployment_id}")
    if profile:
        args.append(f"--profile={profile}")
    return _run_node(PRE_SCRIPT, args, timeout=bounded_int(timeout_seconds, 900, 60, 3600) + 60)


@mcp.tool()
def lexiao_deployment_status(url: str, order_ids: str, env: str = "pre", profile: str = "") -> str:
    """查询乐效发布单状态。order_ids 用逗号分隔。"""
    if not url or not order_ids:
        return error_text("url and order_ids are required")
    args = ["--action=status", f"--url={url}", f"--order-ids={order_ids}", f"--env={env}"]
    if profile:
        args.append(f"--profile={profile}")
    return _run_node(PRE_SCRIPT, args, timeout=120)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
