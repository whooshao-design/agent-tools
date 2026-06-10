"""Browser session and cookie MCP server backed by the local Playwright profile."""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from devtools_mcp.common import (
    bounded_int,
    command_result_text,
    DEFAULT_BROWSER_SCRIPT,
    error_text,
    internal_http_get,
    json_text,
    run_command,
    safe_domain_from_url,
)

mcp = FastMCP("Browser Session")

BROWSER_SCRIPT = DEFAULT_BROWSER_SCRIPT
DEFAULT_LOGIN_PATTERN = "Work Happy|QR Code|Use MOA|Account|登录|扫码|账号|密码|SSO|OAuth"


def _browser_args(
    url: str = "",
    profile: str = "",
    success_text: str = "none",
    login_pattern: str = DEFAULT_LOGIN_PATTERN,
) -> list[str]:
    args = []
    if url:
        args.append(f"--url={url}")
    if profile:
        args.append(f"--profile={profile}")
    if success_text:
        args.append(f"--success-text={success_text}")
    if login_pattern:
        args.append(f"--login-pattern={login_pattern}")
    return args


def _run_browser(args: list[str], timeout: int = 120, max_chars: int = 12000) -> str:
    result = run_command(["node", BROWSER_SCRIPT, *args], timeout=timeout)
    return command_result_text(result, max_chars=max_chars)


@mcp.tool()
def browser_doctor() -> str:
    """检查本地 Playwright/Chromium/profile 环境是否可用。"""
    return _run_browser(["--doctor"], timeout=60)


@mcp.tool()
def check_session(url: str, profile: str = "", success_text: str = "none", login_pattern: str = DEFAULT_LOGIN_PATTERN) -> str:
    """检查指定 URL 的浏览器登录态。默认不要求固定成功文案。"""
    if not url:
        return error_text("url is required")
    return _run_browser(_browser_args(url, profile, success_text, login_pattern), timeout=90)


@mcp.tool()
def ensure_session(url: str, profile: str = "", success_text: str = "none", timeout_seconds: int = 300) -> str:
    """打开有界面 Chromium，让用户完成登录，并等待登录态可用。"""
    if not url:
        return error_text("url is required")
    timeout_ms = bounded_int(timeout_seconds, 300, 30, 1800) * 1000
    args = _browser_args(url, profile, success_text, DEFAULT_LOGIN_PATTERN)
    args.extend(["--ensure", f"--timeout={timeout_ms}"])
    return _run_browser(args, timeout=bounded_int(timeout_seconds, 300, 30, 1800) + 30)


@mcp.tool()
def get_cookies(url: str, domain: str = "", profile: str = "", show_secrets: bool = False) -> str:
    """读取指定域名 Cookie。默认脱敏；只有显式 show_secrets=true 才返回原始值。"""
    cookie_domain = domain or safe_domain_from_url(url)
    if not cookie_domain:
        return error_text("domain or url is required")
    args = _browser_args(url or f"https://{cookie_domain}", profile)
    args.extend(["--cookies", f"--domain={cookie_domain}"])
    if show_secrets:
        args.append("--show-secrets")
    return _run_browser(args, timeout=120)


@mcp.tool()
def fetch_with_session(url: str, domain: str = "", profile: str = "", max_chars: int = 8000) -> str:
    """使用浏览器 Cookie 对允许的内网域名发起只读 GET 请求。不会输出 Cookie。"""
    if not url:
        return error_text("url is required")
    return json_text(internal_http_get(
        url,
        use_browser_session=True,
        profile=profile,
        domain=domain,
        max_chars=bounded_int(max_chars, 8000, 100, 30000),
    ))


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
