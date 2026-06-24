"""Read-only SonarQube MCP server."""

from __future__ import annotations

from http.cookies import SimpleCookie
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

from mcp.server.fastmcp import FastMCP

from devtools_mcp.common import browser_cookie_header, bounded_int, env_value, error_text, json_text, redact_cookie_header

mcp = FastMCP("SonarQube")


def _base_url(value: str = "") -> str:
    return (value or env_value("SONARQUBE_BASE_URL", "https://sonarqube.oa.fenqile.com/new_sonar")).rstrip("/")


def _project_key(issue_url: str = "", project_key: str = "") -> str:
    if project_key:
        return project_key
    if issue_url:
        query = parse_qs(urlparse(issue_url).query)
        return (query.get("id") or query.get("componentKeys") or [""])[0]
    return ""


def _headers(base_url: str, profile: str = "") -> dict[str, str]:
    cookie = env_value("SONARQUBE_COOKIE")
    if not cookie:
        cookie = browser_cookie_header(base_url, urlparse(base_url).hostname or "", profile)
    simple = SimpleCookie()
    simple.load(cookie)
    xsrf = env_value("SONARQUBE_XSRF_TOKEN")
    if not xsrf and "XSRF-TOKEN" in simple:
        xsrf = simple["XSRF-TOKEN"].value
    headers = {"Accept": "application/json", "Cookie": cookie}
    if xsrf:
        headers["X-XSRF-TOKEN"] = xsrf
    return headers


def _query_params(query: dict[str, object]) -> dict[str, str]:
    params: dict[str, str] = {}
    for key, value in query.items():
        if value is None or value == "":
            continue
        if isinstance(value, bool):
            params[key] = "true" if value else "false"
        else:
            params[key] = str(value)
    return params


def _sonarqube_get(base_url: str, path: str, query: dict[str, object], profile: str = "", max_chars: int = 100000) -> str:
    base = _base_url(base_url)
    params = _query_params(query)
    url = urljoin(base.rstrip("/") + "/", path.lstrip("/"))
    if params:
        url += "?" + urlencode(params)
    try:
        request = Request(url, headers=_headers(base, profile))
        with urlopen(request, timeout=60) as response:
            body = response.read().decode("utf-8", errors="replace")
            limit = bounded_int(max_chars, 100000, 1000, 500000)
            return body[:limit]
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return error_text("SonarQube request failed", status=exc.code, url=url, body=body[:1000])
    except URLError as exc:
        return error_text("SonarQube is unreachable", url=url, reason=str(exc.reason))
    except Exception as exc:
        return error_text("SonarQube request failed", detail=str(exc), cookie=redact_cookie_header(env_value("SONARQUBE_COOKIE")))


@mcp.tool()
def parse_sonarqube_project(issue_url: str) -> str:
    """从 SonarQube issue 页面 URL 中提取 base_url 和 project key。"""
    if not issue_url:
        return error_text("issue_url is required")
    parsed = urlparse(issue_url)
    base_path = parsed.path.split("/project/", 1)[0]
    return json_text({
        "base_url": f"{parsed.scheme}://{parsed.netloc}{base_path}",
        "project_key": _project_key(issue_url),
    })


@mcp.tool()
def list_sonarqube_issues(
    issue_url: str = "",
    project_key: str = "",
    base_url: str = "",
    severities: str = "BLOCKER,CRITICAL",
    in_new_code_period: bool = True,
    resolved: str = "false",
    limit: int = 100,
    branch: str = "",
    pull_request: str = "",
    profile: str = "",
) -> str:
    """查询 SonarQube issue 列表，默认只查新代码周期 BLOCKER/CRITICAL。"""
    project = _project_key(issue_url, project_key)
    if not project:
        return error_text("project_key or issue_url with id= is required")
    query = {
        "componentKeys": project,
        "resolved": resolved,
        "severities": severities,
        "ps": bounded_int(limit, 100, 1, 500),
        "branch": branch,
        "pullRequest": pull_request,
    }
    if in_new_code_period:
        query["inNewCodePeriod"] = "true"
    return _sonarqube_get(base_url, "api/issues/search", query, profile)


@mcp.tool()
def get_sonarqube_quality_gate_status(
    issue_url: str = "",
    project_key: str = "",
    base_url: str = "",
    branch: str = "",
    pull_request: str = "",
    profile: str = "",
) -> str:
    """查询项目质量门禁状态，可按 branch 或 pull_request 收窄。"""
    project = _project_key(issue_url, project_key)
    if not project:
        return error_text("project_key or issue_url with id= is required")
    return _sonarqube_get(
        base_url,
        "api/qualitygates/project_status",
        {
            "projectKey": project,
            "branch": branch,
            "pullRequest": pull_request,
        },
        profile,
    )


@mcp.tool()
def show_sonarqube_rule(rule_key: str, base_url: str = "", profile: str = "") -> str:
    """查询 SonarQube 规则详情，用于判断 issue 是否值得修复。"""
    if not rule_key:
        return error_text("rule_key is required")
    return _sonarqube_get(base_url, "api/rules/show", {"key": rule_key}, profile)


@mcp.tool()
def list_sonarqube_branches(issue_url: str = "", project_key: str = "", base_url: str = "", profile: str = "") -> str:
    """查询 SonarQube 项目分支列表。"""
    project = _project_key(issue_url, project_key)
    if not project:
        return error_text("project_key or issue_url with id= is required")
    return _sonarqube_get(base_url, "api/project_branches/list", {"project": project}, profile)


@mcp.tool()
def list_sonarqube_pull_requests(issue_url: str = "", project_key: str = "", base_url: str = "", profile: str = "") -> str:
    """查询 SonarQube 项目 Pull Request 分析列表。"""
    project = _project_key(issue_url, project_key)
    if not project:
        return error_text("project_key or issue_url with id= is required")
    return _sonarqube_get(base_url, "api/project_pull_requests/list", {"project": project}, profile)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
