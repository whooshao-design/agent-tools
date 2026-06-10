"""Read-only Jenkins MCP server for backend development."""

from __future__ import annotations

import base64
import os
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from mcp.server.fastmcp import FastMCP

from devtools_mcp.common import current_repo_context as get_current_repo_context
from devtools_mcp.common import env_value, error_text, json_text

mcp = FastMCP("Jenkins Backend")


def _base_url() -> str:
    return env_value("JENKINS_BASE_URL", "https://devops-jenkins.oa.fenqile.com").rstrip("/")


def _headers() -> dict[str, str]:
    headers = {"Accept": "application/json,text/plain"}
    cookie = env_value("JENKINS_COOKIE")
    if cookie:
        headers["Cookie"] = cookie
    user = env_value("JENKINS_USER")
    token = env_value("JENKINS_TOKEN") or env_value("JENKINS_API_TOKEN")
    if user and token:
        auth = base64.b64encode(f"{user}:{token}".encode()).decode()
        headers["Authorization"] = f"Basic {auth}"
    return headers


def _read_url(url: str, timeout: int = 60) -> str:
    try:
        request = Request(url, headers=_headers())
        with urlopen(request, timeout=timeout) as response:
            return response.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return error_text("Jenkins request failed", status=exc.code, url=url, body=body[:1000])
    except URLError as exc:
        return error_text("Jenkins is unreachable", url=url, reason=str(exc.reason))


def _job_root(job_url: str = "", job_name: str = "") -> str:
    if job_url:
        return job_url.rstrip("/")
    if not job_name:
        raise ValueError("job_url or job_name is required")
    return f"{_base_url()}/job/{quote(job_name, safe='')}"


def _build_root(job_url: str = "", job_name: str = "", build: str = "lastBuild") -> str:
    root = _job_root(job_url, job_name)
    if re.search(r"/(?:lastBuild|\d+)$", root):
        return root
    return f"{root}/{quote(build or 'lastBuild', safe='')}"


@mcp.tool()
def infer_feature_pipeline(repo_dir: str = "") -> str:
    """从本地 Git 仓库推断 feature-pipeline-{project}-{branch} 的 Jenkins 地址。"""
    try:
        ctx = get_current_repo_context(repo_dir or None)
        job_name = f"feature-pipeline-{ctx['project_name']}-{ctx['branch']}"
        return json_text({"job_name": job_name, "job_url": f"{_base_url()}/job/{quote(job_name, safe='')}/", **ctx})
    except Exception as exc:
        return error_text("Unable to infer Jenkins pipeline from git context", detail=str(exc))


@mcp.tool()
def get_build_status(job_url: str = "", job_name: str = "", build: str = "lastBuild") -> str:
    """查询 Jenkins 构建状态。可传完整 job_url 或 job_name。"""
    try:
        url = f"{_build_root(job_url, job_name, build)}/api/json?tree=result,building,displayName,number,url,timestamp,duration"
    except ValueError as exc:
        return error_text(str(exc))
    return _read_url(url, timeout=30)


@mcp.tool()
def get_pipeline_stages(job_url: str = "", job_name: str = "", build: str = "lastBuild") -> str:
    """查询 Jenkins Pipeline 阶段状态。"""
    try:
        url = f"{_build_root(job_url, job_name, build)}/wfapi/"
    except ValueError as exc:
        return error_text(str(exc))
    return _read_url(url, timeout=30)


@mcp.tool()
def get_console_summary(job_url: str = "", job_name: str = "", build: str = "lastBuild", max_lines: int = 120) -> str:
    """读取 Jenkins consoleText 并返回构建失败常用关键行摘要。"""
    try:
        url = f"{_build_root(job_url, job_name, build)}/consoleText"
    except ValueError as exc:
        return error_text(str(exc))
    text = _read_url(url, timeout=60)
    if text.startswith("{") and '"error"' in text[:80]:
        return text

    patterns = (
        "[ERROR]",
        "BUILD FAILURE",
        "Compilation failure",
        "FAILED:",
        "FAILURE",
        "Tests run:",
        "Caused by:",
        "构建过程发生业务异常",
    )
    lines = [line for line in text.splitlines() if any(pattern in line for pattern in patterns)]
    selected = lines[-max(1, min(max_lines, 300)) :]
    return json_text({"url": url, "matched_lines": selected, "matched_count": len(lines)})


@mcp.tool()
def get_testng_summary(job_url: str = "", job_name: str = "", build: str = "lastBuild") -> str:
    """读取 Jenkins TestNG 报告摘要。"""
    try:
        url = f"{_build_root(job_url, job_name, build)}/testngreports/api/json"
    except ValueError as exc:
        return error_text(str(exc))
    return _read_url(url, timeout=30)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
