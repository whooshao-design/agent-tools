"""Read-only config-center and service-registry HTTP MCP server."""

from __future__ import annotations

from urllib.parse import urlencode, urljoin

from mcp.server.fastmcp import FastMCP

from java_backend_mcp.common import (
    DEFAULT_INTERNAL_ALLOWED_HOSTS,
    bounded_int,
    env_value,
    error_text,
    internal_http_get as common_internal_http_get,
    json_text,
    parse_json_object,
)

mcp = FastMCP("Config Registry")


def _allowed_hosts() -> str:
    return env_value("CONFIG_REGISTRY_ALLOWED_HOSTS", DEFAULT_INTERNAL_ALLOWED_HOSTS)


def _read_url(url: str, use_browser_session: bool, profile: str, max_chars: int, headers_json: str = "") -> str:
    headers = parse_json_object(headers_json, {})
    if not isinstance(headers, dict):
        return error_text("headers_json must be a JSON object")
    return json_text(common_internal_http_get(
        url,
        headers={str(k): str(v) for k, v in headers.items()},
        use_browser_session=use_browser_session,
        profile=profile,
        max_chars=max_chars,
        allowed_hosts=_allowed_hosts(),
    ))


@mcp.tool()
def registry_get(url: str, use_browser_session: bool = True, profile: str = "", max_chars: int = 12000) -> str:
    """兼容旧工具名：对配置中心/注册中心发起只读 GET 请求。"""
    if not url:
        return error_text("url is required")
    return _read_url(url, use_browser_session, profile, max_chars)


@mcp.tool()
def internal_http_get(url: str, use_browser_session: bool = True, profile: str = "", headers_json: str = "{}", max_chars: int = 12000) -> str:
    """底层内网 HTTP GET。支持浏览器 session 和少量自定义 header，仅允许 allowlist 域名。"""
    if not url:
        return error_text("url is required")
    return _read_url(url, use_browser_session, profile, max_chars, headers_json=headers_json)


@mcp.tool()
def nacos_get_config(
    base_url: str,
    data_id: str,
    group: str = "DEFAULT_GROUP",
    namespace_id: str = "",
    use_browser_session: bool = True,
    profile: str = "",
    max_chars: int = 12000,
) -> str:
    """读取 Nacos 配置：/nacos/v1/cs/configs?dataId=&group=&tenant=。"""
    if not base_url or not data_id:
        return error_text("base_url and data_id are required")
    query = {"dataId": data_id, "group": group}
    if namespace_id:
        query["tenant"] = namespace_id
    url = urljoin(base_url.rstrip("/") + "/", "nacos/v1/cs/configs") + "?" + urlencode(query)
    return _read_url(url, use_browser_session, profile, max_chars)


@mcp.tool()
def nacos_list_instances(
    base_url: str,
    service_name: str,
    group_name: str = "",
    namespace_id: str = "",
    use_browser_session: bool = True,
    profile: str = "",
    max_chars: int = 12000,
) -> str:
    """读取 Nacos 服务实例列表：/nacos/v1/ns/instance/list。"""
    if not base_url or not service_name:
        return error_text("base_url and service_name are required")
    query = {"serviceName": service_name}
    if group_name:
        query["groupName"] = group_name
    if namespace_id:
        query["namespaceId"] = namespace_id
    url = urljoin(base_url.rstrip("/") + "/", "nacos/v1/ns/instance/list") + "?" + urlencode(query)
    return _read_url(url, use_browser_session, profile, max_chars)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
