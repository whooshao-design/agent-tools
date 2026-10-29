"""SonarQube MCP server: read-only queries plus explicit issue resolution transitions."""

from __future__ import annotations

import json
from http.cookies import SimpleCookie
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

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
    return _sonarqube_request(base_url, path, query, profile, max_chars)


def _sonarqube_post(base_url: str, path: str, form: dict[str, object], profile: str = "") -> str:
    return _sonarqube_request(base_url, path, form, profile, method="POST")


def _sonarqube_request(base_url: str, path: str, params_in: dict[str, object], profile: str = "",
                       max_chars: int = 100000, method: str = "GET") -> str:
    base = _base_url(base_url)
    params = _query_params(params_in)
    url = urljoin(base.rstrip("/") + "/", path.lstrip("/"))
    data = None
    if method == "POST":
        data = urlencode(params).encode()
    elif params:
        url += "?" + urlencode(params)
    try:
        headers = _headers(base, profile)
        if data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        request = Request(url, data=data, headers=headers, method=method)
        with urlopen(request, timeout=60) as response:
            body = response.read().decode("utf-8", errors="replace")
            limit = bounded_int(max_chars, 100000, 1000, 500000)
            if len(body) > limit:
                return error_text("SonarQube response exceeds output limit; reduce the page size",
                                  truncated=True, max_chars=limit, response_chars=len(body))
            return body
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
    page: int = 1,
) -> str:
    """分页查询 SonarQube issue，默认新代码周期 BLOCKER/CRITICAL。按 paging.total 继续传 page。"""
    project = _project_key(issue_url, project_key)
    if not project:
        return error_text("project_key or issue_url with id= is required")
    query = {
        "componentKeys": project,
        "resolved": resolved,
        "severities": severities,
        "ps": bounded_int(limit, 100, 1, 500),
        "p": bounded_int(page, 1, 1, 10000),
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


# Resolutions an evaluated issue may receive; reopening or confirming is left to the SonarQube UI.
_ISSUE_TRANSITIONS = {"falsepositive": "FALSE-POSITIVE", "wontfix": "WONTFIX"}


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False))
def transition_sonarqube_issues(
    issue_keys: str,
    transition: str,
    comment: str,
    base_url: str = "",
    profile: str = "",
) -> str:
    """把已逐条评估的 issue 标记为误报(falsepositive)或不修复(wontfix)，附带评估说明并回读校验。

    issue_keys 用逗号分隔；comment 必填，写清为什么不是真实问题。会改变服务端 issue 状态，
    只在用户授权标记后调用。
    """
    keys = [key.strip() for key in issue_keys.split(",") if key.strip()]
    if not keys:
        return error_text("issue_keys is required")
    if transition not in _ISSUE_TRANSITIONS:
        return error_text("transition must be one of: " + ", ".join(sorted(_ISSUE_TRANSITIONS)))
    if not comment.strip():
        return error_text("comment is required: explain why the issue is not a real defect")
    result = _sonarqube_post(base_url, "api/issues/bulk_change", {
        "issues": ",".join(keys),
        "do_transition": transition,
        "comment": comment.strip(),
        "sendNotifications": False,
    }, profile)
    try:
        bulk = json.loads(result)
    except ValueError:
        return error_text("SonarQube bulk_change returned non-JSON", body=result[:1000])
    if "error" in bulk:
        return result
    readback = _sonarqube_get(base_url, "api/issues/search", {"issues": ",".join(keys), "ps": len(keys)}, profile)
    try:
        issues = json.loads(readback).get("issues", [])
    except ValueError:
        return error_text("SonarQube readback returned non-JSON", bulk_change=bulk, body=readback[:1000])
    expected = _ISSUE_TRANSITIONS[transition]
    states = {issue["key"]: {"status": issue.get("status"), "resolution": issue.get("resolution")} for issue in issues}
    pending = [key for key in keys if states.get(key, {}).get("resolution") != expected]
    return json_text({"bulk_change": bulk, "expected_resolution": expected, "issues": states,
                      "verified": not pending, "not_transitioned": pending})


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
