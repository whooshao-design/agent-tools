"""Read-only GitLab MCP server for backend development."""

from __future__ import annotations

import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from mcp.server.fastmcp import FastMCP

from devtools_mcp.common import (
    current_repo_context as get_current_repo_context,
    encode_project_path,
    env_value,
    error_text,
    json_text,
    parse_git_project_path,
)

mcp = FastMCP("GitLab Backend")


def _base_url() -> str:
    return env_value("GITLAB_BASE_URL", "https://gitlab.fenqile.com").rstrip("/")


def _headers() -> dict[str, str]:
    headers = {"Accept": "application/json"}
    token = env_value("GITLAB_TOKEN") or env_value("GITLAB_PRIVATE_TOKEN")
    if token:
        headers["PRIVATE-TOKEN"] = token
    bearer = env_value("GITLAB_BEARER_TOKEN")
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    return headers


def _gitlab_get(path: str, query: dict[str, Any] | None = None) -> str:
    query_string = f"?{urlencode(query or {}, doseq=True)}" if query else ""
    url = f"{_base_url()}/api/v4{path}{query_string}"
    try:
        request = Request(url, headers=_headers())
        with urlopen(request, timeout=30) as response:
            return response.read().decode("utf-8")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return error_text("GitLab API request failed", status=exc.code, url=url, body=body[:1000])
    except URLError as exc:
        return error_text("GitLab API is unreachable", url=url, reason=str(exc.reason))


@mcp.tool()
def current_repo_context(repo_dir: str = "") -> str:
    """读取本地 Git 仓库上下文，包括 origin、当前分支、GitLab project path。"""
    try:
        return json_text(get_current_repo_context(repo_dir or None))
    except Exception as exc:
        return error_text("Unable to read local git context", detail=str(exc))


@mcp.tool()
def get_project(project_path_or_url: str) -> str:
    """按 GitLab project path 或 remote URL 查询项目基础信息。"""
    project = encode_project_path(project_path_or_url)
    if not project:
        return error_text("project_path_or_url is required")
    raw = _gitlab_get(f"/projects/{project}")
    return raw


@mcp.tool()
def list_merge_requests(project_path_or_url: str, state: str = "opened", limit: int = 10) -> str:
    """查询项目 MR 列表。state 支持 opened/merged/closed/all。"""
    project = encode_project_path(project_path_or_url)
    if not project:
        return error_text("project_path_or_url is required")
    per_page = max(1, min(limit, 50))
    query = {"state": state, "per_page": per_page, "order_by": "updated_at", "sort": "desc"}
    return _gitlab_get(f"/projects/{project}/merge_requests", query)


@mcp.tool()
def get_merge_request(project_path_or_url: str, iid: int) -> str:
    """查询指定 MR 详情。iid 是 GitLab 页面上的 !数字。"""
    project = encode_project_path(project_path_or_url)
    if not project:
        return error_text("project_path_or_url is required")
    return _gitlab_get(f"/projects/{project}/merge_requests/{iid}")


@mcp.tool()
def list_project_pipelines(project_path_or_url: str, ref: str = "", limit: int = 10) -> str:
    """查询项目流水线列表，可按分支 ref 过滤。"""
    project = encode_project_path(project_path_or_url)
    if not project:
        return error_text("project_path_or_url is required")
    query: dict[str, Any] = {"per_page": max(1, min(limit, 50)), "order_by": "updated_at", "sort": "desc"}
    if ref:
        query["ref"] = ref
    return _gitlab_get(f"/projects/{project}/pipelines", query)


@mcp.tool()
def get_pipeline(project_path_or_url: str, pipeline_id: int) -> str:
    """查询指定 GitLab pipeline 详情。"""
    project = encode_project_path(project_path_or_url)
    if not project:
        return error_text("project_path_or_url is required")
    return _gitlab_get(f"/projects/{project}/pipelines/{pipeline_id}")


@mcp.tool()
def normalize_project_path(project_path_or_url: str) -> str:
    """把 Git remote URL 归一化成 GitLab project path。"""
    return json_text({"project_path": parse_git_project_path(project_path_or_url)})


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
