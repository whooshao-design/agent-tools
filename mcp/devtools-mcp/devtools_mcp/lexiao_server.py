"""Lexiao deployment MCP server backed by existing Playwright scripts."""

from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from urllib.parse import quote

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from devtools_mcp.common import (
    DEFAULT_BROWSER_PROFILE,
    DEFAULT_INTERNAL_ALLOWED_HOSTS,
    bounded_int,
    command_result_text,
    current_repo_context,
    error_text,
    internal_http_get,
    json_text,
    run_command,
    skill_path,
)
from devtools_mcp.jenkins_server import _base_url as jenkins_base_url
from devtools_mcp.jenkins_server import _read_url as jenkins_read_url

mcp = FastMCP("Lexiao Deploy")

PROJECT_SCRIPT = skill_path("lexiao-deploy", "scripts", "lexiao_project_env.js")
PRE_SCRIPT = skill_path("lexiao-deploy", "scripts", "lexiao_pre_release.js")


def _run_node(script: str, args: list[str], timeout: int = 900, max_chars: int = 50000) -> str:
    return command_result_text(run_command(["node", script, *args], timeout=timeout), max_chars=max_chars)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
def lexiao_project_status(url: str, app: str, profile: str = DEFAULT_BROWSER_PROFILE) -> str:
    """查询乐效项目环境目标应用行状态，并打开该行「部署详情」弹窗读取版本号、集群行、Pod 与发布单号（打开弹窗时页面会自行调用 create_publish_order）。"""
    if not url or not app:
        return error_text("url and app are required")
    return _run_node(PROJECT_SCRIPT, ["--action=status", f"--url={url}", f"--app={app}", f"--profile={profile}"], timeout=180)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
def lexiao_project_deploy(
    url: str,
    app: str,
    profile: str = DEFAULT_BROWSER_PROFILE,
    build_timeout_seconds: int = 900,
    deploy_timeout_seconds: int = 900,
    cluster: str = "",
) -> str:
    """部署乐效项目环境目标应用。行上有「部署」按钮时点该按钮；否则打开「部署详情」，只点唯一「待发布」集群行（多个时用 cluster 指定集群或 set）的「发布」并轮询到已发布。"""
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
    if cluster:
        args.append(f"--cluster={cluster}")
    return _run_node(PROJECT_SCRIPT, args, timeout=bounded_int(build_timeout_seconds, 900, 30, 3600) + bounded_int(deploy_timeout_seconds, 900, 30, 3600) + 60)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
def lexiao_list_apps(url: str, env: str = "pre", profile: str = "") -> str:
    """列出乐效预发布/灰度页面应用、发布顺序和流水线制品状态。"""
    if not url:
        return error_text("url is required")
    args = ["--action=list-apps", f"--url={url}", f"--env={env}"]
    if profile:
        args.append(f"--profile={profile}")
    return _run_node(PRE_SCRIPT, args, timeout=120)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
def lexiao_branch_integrate(url: str, profile: str = "") -> str:
    """触发乐效分支集成。仅适用于受支持的预发布流程。"""
    if not url:
        return error_text("url is required")
    args = ["--action=branch-integrate", f"--url={url}"]
    if profile:
        args.append(f"--profile={profile}")
    return _run_node(PRE_SCRIPT, args, timeout=180)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
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


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
def lexiao_build_many(url: str, apps: str, env: str = "pre", profile: str = "", timeout_seconds: int = 900) -> str:
    """触发并等待多个乐效目标应用构建完成，apps 用逗号分隔。"""
    if not url or not apps:
        return error_text("url and apps are required")
    args = ["--action=build-many", f"--url={url}", f"--apps={apps}", f"--env={env}", f"--timeout={bounded_int(timeout_seconds, 900, 60, 3600) * 1000}"]
    if profile:
        args.append(f"--profile={profile}")
    return _run_node(PRE_SCRIPT, args, timeout=bounded_int(timeout_seconds, 900, 60, 3600) + 60)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
def lexiao_open_order(url: str, app: str, env: str = "pre", profile: str = "") -> str:
    """打开目标应用部署详情，必要时创建新发布单，并返回 order_id。"""
    if not url or not app:
        return error_text("url and app are required")
    args = ["--action=open-order", f"--url={url}", f"--app={app}", f"--env={env}"]
    if profile:
        args.append(f"--profile={profile}")
    return _run_node(PRE_SCRIPT, args, timeout=180)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False))
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


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
def lexiao_deployment_status(url: str, order_ids: str, env: str = "pre", profile: str = "") -> str:
    """查询乐效发布单状态。order_ids 用逗号分隔。"""
    if not url or not order_ids:
        return error_text("url and order_ids are required")
    args = ["--action=status", f"--url={url}", f"--order-ids={order_ids}", f"--env={env}"]
    if profile:
        args.append(f"--profile={profile}")
    return _run_node(PRE_SCRIPT, args, timeout=120)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False))
def lexiao_project_build(url: str, app: str, profile: str = DEFAULT_BROWSER_PROFILE, build_timeout_seconds: int = 1200) -> str:
    """点项目环境目标应用行的「构建」并等到 Jenkins 构建号变大且执行成功、制品制作成功。只在 lexiao_project_build_check 返回 build 或用户要求重建时使用。"""
    if not url or not app:
        return error_text("url and app are required")
    timeout = bounded_int(build_timeout_seconds, 1200, 60, 3600)
    args = ["--action=build", f"--url={url}", f"--app={app}", f"--profile={profile}", f"--build-timeout={timeout * 1000}"]
    return _run_node(PROJECT_SCRIPT, args, timeout=timeout + 120)


NEXUS_SNAPSHOTS = "http://product.fenqile.com:8081/nexus/content/repositories/snapshots/"
# 推送后 Jenkins 自动构建通常 1 分钟内开始；提交时间晚于此窗口仍未构建，就认为推送没有触发构建。
AUTO_BUILD_GRACE_SECONDS = 600


def _jenkins_last_build(job_name: str, project_path: str) -> dict:
    """读取 feature-pipeline 最近一次构建；sha 取 remoteUrls 指向本仓库的那条 BuildData（另一条是流水线脚本库）。"""
    tree = "number,building,result,timestamp,actions[lastBuiltRevision[SHA1],remoteUrls]"
    url = f"{jenkins_base_url()}/job/{quote(job_name, safe='')}/lastBuild/api/json?tree={tree}"
    text = jenkins_read_url(url, timeout=30)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {"error": "unexpected Jenkins response", "url": url, "body": text[:300]}
    if "error" in data:
        return {**data, "job_url": url}
    sha = ""
    for action in data.get("actions") or []:
        revision = (action or {}).get("lastBuiltRevision")
        if revision and any(project_path and project_path in remote for remote in action.get("remoteUrls") or []):
            sha = revision.get("SHA1", "")
    return {
        "job_name": job_name,
        "number": data.get("number"),
        "building": bool(data.get("building")),
        "result": data.get("result"),
        "timestamp": int(data.get("timestamp") or 0) // 1000,
        "sha": sha,
    }


def _remote_head(repo_dir: str, branch: str) -> dict:
    fetched = run_command(["git", "-C", repo_dir, "fetch", "--quiet", "origin", branch], timeout=60)
    if fetched["exit_code"] != 0:
        return {"error": "git fetch failed", "stderr": fetched["stderr"][-300:]}
    shown = run_command(["git", "-C", repo_dir, "log", "-1", "--format=%H %ct", f"origin/{branch}"], timeout=30)
    if shown["exit_code"] != 0:
        return {"error": "git log failed", "stderr": shown["stderr"][-300:]}
    sha, commit_time = shown["stdout"].split()
    return {"sha": sha, "commit_time": int(commit_time)}


def _jar_last_updated(coordinate: str) -> dict:
    """读 Nexus snapshots 中 group:artifact:version 的 maven-metadata.xml，返回 lastUpdated（UTC，转成秒）。"""
    parts = coordinate.split(":")
    if len(parts) != 3:
        return {"jar": coordinate, "error": "expected group:artifact:version"}
    group, artifact, version = parts
    url = f"{NEXUS_SNAPSHOTS}{group.replace('.', '/')}/{artifact}/{version}/maven-metadata.xml"
    response = internal_http_get(url, allowed_hosts=DEFAULT_INTERNAL_ALLOWED_HOSTS, timeout=30)
    match = re.search(r"<lastUpdated>(\d{14})</lastUpdated>", response.get("body") or "")
    if response.get("error") or not match:
        return {"jar": coordinate, "url": url, "error": response.get("error") or "lastUpdated not found", "status": response.get("status")}
    updated = datetime.strptime(match.group(1), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    return {"jar": coordinate, "last_updated": int(updated.timestamp())}


def decide_project_build(build: dict, head: dict, jars: list[dict], now: int) -> tuple[str, list[str]]:
    """给出项目环境是否需要点「构建」：deploy-only / build / wait / unknown，并附原因。"""
    if build.get("error") or head.get("error"):
        return "unknown", [f"jenkins: {build.get('error')}" if build.get("error") else f"git: {head.get('error')}"]
    if build.get("building"):
        return "wait", [f"构建 #{build['number']} 进行中，等它结束后重新检查"]
    if not build.get("sha"):
        return "unknown", [f"构建 #{build.get('number')} 的 BuildData 里没有指向本仓库的提交，无法和远端 HEAD 比较"]
    reasons = []
    if build.get("sha") != head["sha"]:
        if now - head["commit_time"] < AUTO_BUILD_GRACE_SECONDS:
            return "wait", [f"远端 HEAD {head['sha'][:8]} 尚未构建，提交不到 {AUTO_BUILD_GRACE_SECONDS // 60} 分钟，推送触发的自动构建可能还在排队"]
        reasons.append(f"最近构建 #{build['number']} 的提交 {str(build.get('sha'))[:8]} 不是远端 HEAD {head['sha'][:8]}")
    if build.get("result") != "SUCCESS":
        reasons.append(f"最近构建 #{build['number']} 结果为 {build.get('result')}")
    stale = [jar["jar"] for jar in jars if "last_updated" in jar and jar["last_updated"] > build["timestamp"]]
    if stale:
        reasons.append("这些 jar 在最近构建开始后才更新到 Nexus：" + ", ".join(stale))
    if reasons:
        return "build", reasons
    broken = [jar["jar"] for jar in jars if "error" in jar]
    if broken:
        return "unknown", ["无法读取这些 jar 的 Nexus 元数据：" + ", ".join(broken)]
    return "deploy-only", [f"最近构建 #{build['number']} 已构建远端 HEAD {head['sha'][:8]}" + ("，所列 jar 均早于构建" if jars else "")]


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True))
def lexiao_project_build_check(repo_dir: str, app: str, branch: str = "", jars: str = "") -> str:
    """项目环境部署前判断要不要点「构建」：比较 feature-pipeline-<app>-<branch> 最近构建的提交与远端分支 HEAD，以及 jars（逗号分隔的 group:artifact:version）在 Nexus 的更新时间是否晚于该构建。app 是乐效应用名（如 process-engine），不是仓库名（process-engine-java）。"""
    if not repo_dir or not app:
        return error_text("repo_dir and app are required")
    try:
        ctx = current_repo_context(repo_dir)
    except Exception as exc:  # noqa: BLE001 - surface git errors as tool output
        return error_text("Unable to read git context", detail=str(exc))
    branch = branch or ctx["branch"]
    # 任务名用乐效应用名：2026-10-28 需求 53704 的 process-engine-java 仓库对应 feature-pipeline-process-engine-<branch>。
    job_name = f"feature-pipeline-{app}-{branch}"
    build = _jenkins_last_build(job_name, ctx["project_path"])
    head = _remote_head(ctx["repo_dir"], branch)
    jar_results = [_jar_last_updated(item.strip()) for item in jars.split(",") if item.strip()]
    decision, reasons = decide_project_build(build, head, jar_results, int(time.time()))
    return json_text({"decision": decision, "reasons": reasons, "branch": branch, "build": build, "head": head, "jars": jar_results})


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
