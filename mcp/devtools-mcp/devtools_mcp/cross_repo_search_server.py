"""Cross-repository search MCP server for local checkouts and GitLab code search."""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlencode, urljoin

from mcp.server.fastmcp import FastMCP

from devtools_mcp.common import (
    bounded_int,
    command_result_text,
    encode_project_path,
    env_value,
    error_text,
    internal_http_get,
    json_text,
    parse_git_project_path,
    run_command,
)

mcp = FastMCP("Cross Repo Search")

DEFAULT_ROOT = os.environ.get("DEVTOOLS_SEARCH_ROOT", str(Path.home() / "projects"))


def _gitlab_base() -> str:
    return env_value("GITLAB_BASE_URL", "https://gitlab.fenqile.com").rstrip("/")


def _gitlab_headers() -> dict[str, str]:
    headers = {"Accept": "application/json"}
    token = env_value("GITLAB_TOKEN") or env_value("GITLAB_PRIVATE_TOKEN")
    if token:
        headers["PRIVATE-TOKEN"] = token
    bearer = env_value("GITLAB_BEARER_TOKEN")
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    return headers


def _roots(value: str) -> list[str]:
    roots = [item.strip() for item in (value or DEFAULT_ROOT).split(",") if item.strip()]
    return [str(Path(item).expanduser()) for item in roots]


@mcp.tool()
def list_local_git_repos(root: str = DEFAULT_ROOT, max_results: int = 200) -> str:
    """列出本地 root 下的 Git 仓库。"""
    repos: list[dict[str, str]] = []
    for base in _roots(root):
        for git_dir in Path(base).expanduser().rglob(".git"):
            if not git_dir.is_dir():
                continue
            repo = git_dir.parent
            remote = run_command(["git", "-C", str(repo), "remote", "get-url", "origin"], timeout=10)
            repos.append({
                "path": str(repo),
                "remote": str(remote.get("stdout") or "").strip(),
                "project_path": parse_git_project_path(str(remote.get("stdout") or "").strip()),
            })
            if len(repos) >= bounded_int(max_results, 200, 1, 1000):
                return json_text({"repos": repos, "truncated": True})
    return json_text({"repos": repos, "truncated": False})


@mcp.tool()
def local_code_search(pattern: str, root: str = DEFAULT_ROOT, glob: str = "", max_matches: int = 200, context_lines: int = 0) -> str:
    """跨本地 checkout 执行 rg 搜索。"""
    if not pattern:
        return error_text("pattern is required")
    args = ["rg", "--line-number", "--hidden", "--glob", "!.git/**"]
    if context_lines:
        args.extend(["--context", str(bounded_int(context_lines, 0, 0, 5))])
    if glob:
        for item in glob.split(","):
            if item.strip():
                args.extend(["--glob", item.strip()])
    args.append(pattern)
    args.extend(_roots(root))
    result = run_command(args, timeout=120)
    stdout = str(result.get("stdout") or "")
    lines = stdout.splitlines()
    limit = bounded_int(max_matches, 200, 1, 2000)
    result["stdout"] = "\n".join(lines[:limit])
    if len(lines) > limit:
        result["stdout"] += f"\n<truncated: {len(lines) - limit} more lines>"
    return command_result_text(result, max_chars=100000)


@mcp.tool()
def gitlab_code_search(search: str, project_path_or_url: str = "", group_id: str = "", ref: str = "", limit: int = 20, max_chars: int = 50000) -> str:
    """GitLab code search. 可按 project 或 group 收窄。"""
    if not search:
        return error_text("search is required")
    base = _gitlab_base()
    query = {"scope": "blobs", "search": search, "per_page": bounded_int(limit, 20, 1, 100)}
    if ref:
        query["ref"] = ref
    if project_path_or_url:
        project = encode_project_path(project_path_or_url)
        path = f"api/v4/projects/{project}/search"
    elif group_id:
        path = f"api/v4/groups/{group_id}/search"
    else:
        path = "api/v4/search"
    url = urljoin(base.rstrip("/") + "/", path) + "?" + urlencode(query)
    return json_text(internal_http_get(
        url,
        headers=_gitlab_headers(),
        use_browser_session=False,
        max_chars=bounded_int(max_chars, 50000, 1000, 100000),
        allowed_hosts=".fenqile.com,.lexinfintech.com,.lexincloud.com,gitlab.com",
    ))


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
