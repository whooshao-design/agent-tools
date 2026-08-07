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


def _browser_args(
    url: str = "",
    profile: str = "",
    success_text: str = "none",
    login_pattern: str = "",
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
def check_session(url: str, profile: str = "", success_text: str = "none", login_pattern: str = "") -> str:
    """检查指定 URL 的浏览器登录态。默认不要求固定成功文案。"""
    if not url:
        return error_text("url is required")
    return _run_browser(_browser_args(url, profile, success_text, login_pattern), timeout=90)


@mcp.tool()
def browser_page_snapshot(url: str, profile: str = "", success_text: str = "none", login_pattern: str = "") -> str:
    """读取页面标题、URL、正文摘要和按钮列表；不执行页面动作。"""
    if not url:
        return error_text("url is required")
    return _run_browser(_browser_args(url, profile, success_text, login_pattern), timeout=90)


@mcp.tool()
def browser_click_text(
    url: str,
    text: str,
    profile: str = "",
    success_text: str = "none",
    login_pattern: str = "",
    timeout_seconds: int = 120,
) -> str:
    """在页面中按规范化文本点击可见元素，并返回点击后的页面状态。"""
    if not url:
        return error_text("url is required")
    if not text:
        return error_text("text is required")
    timeout = bounded_int(timeout_seconds, 120, 10, 600)
    args = _browser_args(url, profile, success_text, login_pattern)
    args.append(f"--click-text={text}")
    return _run_browser(args, timeout=timeout)


@mcp.tool()
def browser_click_button(
    url: str,
    text: str,
    profile: str = "",
    success_text: str = "none",
    login_pattern: str = "",
    timeout_seconds: int = 120,
) -> str:
    """在页面中按按钮文本点击可见按钮，并返回点击后的页面状态。"""
    if not url:
        return error_text("url is required")
    if not text:
        return error_text("text is required")
    timeout = bounded_int(timeout_seconds, 120, 10, 600)
    args = _browser_args(url, profile, success_text, login_pattern)
    args.append(f"--click-button={text}")
    return _run_browser(args, timeout=timeout)


@mcp.tool()
def ensure_session(url: str, profile: str = "", success_text: str = "none", timeout_seconds: int = 300) -> str:
    """确保登录态可用：已登录则直接返回；未登录时打开 Chromium，无法显示时返回登录截图路径。"""
    if not url:
        return error_text("url is required")
    timeout_ms = bounded_int(timeout_seconds, 300, 30, 1800) * 1000
    args = _browser_args(url, profile, success_text)
    args.extend(["--ensure", f"--timeout={timeout_ms}"])
    return _run_browser(args, timeout=bounded_int(timeout_seconds, 300, 30, 1800) + 30)


@mcp.tool()
def renew_session(url: str, profile: str = "", success_text: str = "none") -> str:
    """无头访问目标页面以续期可滑动的浏览器 Session；登录失效时仅返回状态，不弹出浏览器。"""
    if not url:
        return error_text("url is required")
    args = _browser_args(url, profile, success_text)
    args.append("--renew")
    return _run_browser(args, timeout=90)


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
    """在 BrowserContext 中对允许的内网域名发起只读 GET，持久化续期 Cookie，不主动输出请求 Cookie。"""
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
