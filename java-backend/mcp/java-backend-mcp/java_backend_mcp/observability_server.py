"""Read-only observability MCP server for metrics, logs and traces."""

from __future__ import annotations

import json
from urllib.parse import urlencode, urljoin

from mcp.server.fastmcp import FastMCP

from java_backend_mcp.common import (
    DEFAULT_INTERNAL_ALLOWED_HOSTS,
    bounded_int,
    env_value,
    error_text,
    internal_http_get,
    internal_http_request,
    json_text,
    parse_json_object,
)

mcp = FastMCP("Observability")


def _allowed_hosts() -> str:
    return env_value("OBSERVABILITY_ALLOWED_HOSTS", DEFAULT_INTERNAL_ALLOWED_HOSTS)


def _headers(headers_json: str) -> dict[str, str] | str:
    headers = parse_json_object(headers_json, {})
    if not isinstance(headers, dict):
        return "headers_json must be a JSON object"
    return {str(k): str(v) for k, v in headers.items()}


@mcp.tool()
def prometheus_query(
    base_url: str,
    query: str,
    time: str = "",
    use_browser_session: bool = True,
    profile: str = "",
    headers_json: str = "{}",
    max_chars: int = 30000,
) -> str:
    """Prometheus instant query: GET /api/v1/query."""
    if not base_url or not query:
        return error_text("base_url and query are required")
    headers = _headers(headers_json)
    if isinstance(headers, str):
        return error_text(headers)
    params = {"query": query}
    if time:
        params["time"] = time
    url = urljoin(base_url.rstrip("/") + "/", "api/v1/query") + "?" + urlencode(params)
    return json_text(internal_http_get(
        url,
        headers=headers,
        use_browser_session=use_browser_session,
        profile=profile,
        max_chars=bounded_int(max_chars, 30000, 1000, 100000),
        allowed_hosts=_allowed_hosts(),
    ))


@mcp.tool()
def prometheus_query_range(
    base_url: str,
    query: str,
    start: str,
    end: str,
    step: str,
    use_browser_session: bool = True,
    profile: str = "",
    headers_json: str = "{}",
    max_chars: int = 50000,
) -> str:
    """Prometheus range query: GET /api/v1/query_range."""
    if not base_url or not query or not start or not end or not step:
        return error_text("base_url, query, start, end and step are required")
    headers = _headers(headers_json)
    if isinstance(headers, str):
        return error_text(headers)
    url = urljoin(base_url.rstrip("/") + "/", "api/v1/query_range") + "?" + urlencode({
        "query": query,
        "start": start,
        "end": end,
        "step": step,
    })
    return json_text(internal_http_get(
        url,
        headers=headers,
        use_browser_session=use_browser_session,
        profile=profile,
        max_chars=bounded_int(max_chars, 50000, 1000, 100000),
        allowed_hosts=_allowed_hosts(),
    ))


@mcp.tool()
def loki_query_range(
    base_url: str,
    query: str,
    start: str = "",
    end: str = "",
    limit: int = 100,
    direction: str = "backward",
    use_browser_session: bool = True,
    profile: str = "",
    headers_json: str = "{}",
    max_chars: int = 50000,
) -> str:
    """Loki log query: GET /loki/api/v1/query_range."""
    if not base_url or not query:
        return error_text("base_url and query are required")
    headers = _headers(headers_json)
    if isinstance(headers, str):
        return error_text(headers)
    params = {"query": query, "limit": bounded_int(limit, 100, 1, 5000), "direction": direction}
    if start:
        params["start"] = start
    if end:
        params["end"] = end
    url = urljoin(base_url.rstrip("/") + "/", "loki/api/v1/query_range") + "?" + urlencode(params)
    return json_text(internal_http_get(
        url,
        headers=headers,
        use_browser_session=use_browser_session,
        profile=profile,
        max_chars=bounded_int(max_chars, 50000, 1000, 100000),
        allowed_hosts=_allowed_hosts(),
    ))


@mcp.tool()
def jaeger_trace(base_url: str, trace_id: str, use_browser_session: bool = True, profile: str = "", headers_json: str = "{}", max_chars: int = 50000) -> str:
    """Jaeger trace lookup: GET /api/traces/{trace_id}."""
    if not base_url or not trace_id:
        return error_text("base_url and trace_id are required")
    headers = _headers(headers_json)
    if isinstance(headers, str):
        return error_text(headers)
    url = urljoin(base_url.rstrip("/") + "/", f"api/traces/{trace_id}")
    return json_text(internal_http_get(
        url,
        headers=headers,
        use_browser_session=use_browser_session,
        profile=profile,
        max_chars=bounded_int(max_chars, 50000, 1000, 100000),
        allowed_hosts=_allowed_hosts(),
    ))


@mcp.tool()
def skywalking_graphql(base_url: str, graphql_json: str, use_browser_session: bool = True, profile: str = "", headers_json: str = "{}", max_chars: int = 50000) -> str:
    """SkyWalking GraphQL read query. graphql_json should contain query/variables."""
    if not base_url or not graphql_json:
        return error_text("base_url and graphql_json are required")
    body = parse_json_object(graphql_json, None)
    if not isinstance(body, dict):
        return error_text("graphql_json must be a JSON object")
    headers = _headers(headers_json)
    if isinstance(headers, str):
        return error_text(headers)
    headers.setdefault("Content-Type", "application/json")
    url = urljoin(base_url.rstrip("/") + "/", "graphql")
    return json_text(internal_http_request(
        "POST",
        url,
        headers=headers,
        body=json.dumps(body, ensure_ascii=False),
        use_browser_session=use_browser_session,
        profile=profile,
        max_chars=bounded_int(max_chars, 50000, 1000, 100000),
        allowed_hosts=_allowed_hosts(),
    ))


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
