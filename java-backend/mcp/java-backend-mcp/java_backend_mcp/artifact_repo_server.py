"""Read-only artifact repository MCP server for Maven/Nexus style repositories."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlencode, urljoin

from mcp.server.fastmcp import FastMCP

from java_backend_mcp.common import (
    DEFAULT_INTERNAL_ALLOWED_HOSTS,
    bounded_int,
    env_value,
    error_text,
    internal_http_get,
    json_text,
)

mcp = FastMCP("Artifact Repository")


def _allowed_hosts() -> str:
    return env_value("ARTIFACT_REPO_ALLOWED_HOSTS", DEFAULT_INTERNAL_ALLOWED_HOSTS)


def _maven_path(group_id: str, artifact_id: str, file_name: str = "") -> str:
    base = "/".join([*group_id.split("."), artifact_id])
    return f"{base}/{file_name}" if file_name else base


@mcp.tool()
def maven_local_find(group_id: str, artifact_id: str, version: str = "", max_results: int = 50) -> str:
    """查询本机 ~/.m2/repository 中的 Maven 制品。"""
    if not group_id or not artifact_id:
        return error_text("group_id and artifact_id are required")
    root = Path.home() / ".m2" / "repository" / Path(*group_id.split(".")) / artifact_id
    if version:
        root = root / version
    if not root.exists():
        return json_text({"exists": False, "path": str(root), "files": []})
    files = [str(path) for path in sorted(root.rglob("*")) if path.is_file()]
    limit = bounded_int(max_results, 50, 1, 500)
    return json_text({"exists": True, "path": str(root), "files": files[:limit], "truncated": len(files) > limit})


@mcp.tool()
def maven_metadata(repository_url: str, group_id: str, artifact_id: str, use_browser_session: bool = False, profile: str = "", max_chars: int = 30000) -> str:
    """读取远程 Maven maven-metadata.xml。"""
    if not repository_url or not group_id or not artifact_id:
        return error_text("repository_url, group_id and artifact_id are required")
    url = urljoin(repository_url.rstrip("/") + "/", _maven_path(group_id, artifact_id, "maven-metadata.xml"))
    return json_text(internal_http_get(
        url,
        use_browser_session=use_browser_session,
        profile=profile,
        max_chars=bounded_int(max_chars, 30000, 1000, 100000),
        allowed_hosts=_allowed_hosts(),
    ))


@mcp.tool()
def maven_pom(repository_url: str, group_id: str, artifact_id: str, version: str, use_browser_session: bool = False, profile: str = "", max_chars: int = 50000) -> str:
    """读取远程 Maven POM。"""
    if not repository_url or not group_id or not artifact_id or not version:
        return error_text("repository_url, group_id, artifact_id and version are required")
    file_name = f"{artifact_id}-{version}.pom"
    url = urljoin(repository_url.rstrip("/") + "/", _maven_path(group_id, artifact_id, f"{version}/{file_name}"))
    return json_text(internal_http_get(
        url,
        use_browser_session=use_browser_session,
        profile=profile,
        max_chars=bounded_int(max_chars, 50000, 1000, 100000),
        allowed_hosts=_allowed_hosts(),
    ))


@mcp.tool()
def nexus_search(base_url: str, repository: str = "", group_id: str = "", artifact_id: str = "", version: str = "", use_browser_session: bool = True, profile: str = "", max_chars: int = 50000) -> str:
    """Nexus 3 search API: GET /service/rest/v1/search。"""
    if not base_url:
        return error_text("base_url is required")
    query = {}
    if repository:
        query["repository"] = repository
    if group_id:
        query["group"] = group_id
    if artifact_id:
        query["name"] = artifact_id
    if version:
        query["version"] = version
    url = urljoin(base_url.rstrip("/") + "/", "service/rest/v1/search")
    if query:
        url += "?" + urlencode(query)
    return json_text(internal_http_get(
        url,
        use_browser_session=use_browser_session,
        profile=profile,
        max_chars=bounded_int(max_chars, 50000, 1000, 100000),
        allowed_hosts=_allowed_hosts(),
    ))


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
