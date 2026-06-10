#!/usr/bin/env python3
"""
Chrome Cookie 获取工具（Playwright + Chromium 方式，支持 WSL2）

参考 get-browser-session 设计：
- 使用 Playwright 的 chromium.launch_persistent_context 启动浏览器
- 使用 LD_LIBRARY_PATH 指定运行时库路径
- 使用 --no-sandbox 在 WSL2 中运行

用法:
  python3 auto_cookie.py --status --domain=bianque.lexinfintech.com
  python3 auto_cookie.py --doctor
  python3 auto_cookie.py --ensure --domain=bianque.lexinfintech.com --url=https://bianque.lexinfintech.com
  python3 auto_cookie.py --domain=bianque.lexinfintech.com  # 获取 Cookie（默认模式）
"""

import argparse
import json
import os
import subprocess
import sys

# Playwright 相关
from playwright.sync_api import sync_playwright

# Chrome/Chromium 路径（参考 get-browser-session）
CHROME_PATH = os.path.expanduser("~/tools/lexiao-browser/browsers/chrome-linux64/chrome")
RUNTIME_LIB_DIR = os.path.expanduser("~/tools/lexiao-browser/runtime-libs/usr/lib/x86_64-linux-gnu")
PROFILE_DIR = os.path.expanduser("~/.cache/lexiao-browser-profile")


def get_env_with_lib_path():
    """获取包含 LD_LIBRARY_PATH 的环境变量。"""
    env = os.environ.copy()
    ld_paths = [p for p in [RUNTIME_LIB_DIR, env.get("LD_LIBRARY_PATH", "")] if p]
    env["LD_LIBRARY_PATH"] = ":".join(ld_paths)
    # WSL2 需要的环境变量
    env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/run/user/1000/bus"
    env["XDG_RUNTIME_DIR"] = "/run/user/1000"
    return env


def launch_browser(headless=True):
    """启动 Chromium 浏览器（使用 Playwright）。"""
    env = get_env_with_lib_path()

    # 创建 profile 目录
    os.makedirs(PROFILE_DIR, exist_ok=True)

    playwright = sync_playwright().start()

    # 使用 launch_persistent_context 复用 profile
    # 添加 WSL2 需要的参数
    context = playwright.chromium.launch_persistent_context(
        PROFILE_DIR,
        executable_path=CHROME_PATH,
        headless=headless,
        env={k: v for k, v in env.items()},
        args=[
            '--no-sandbox',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-dev-shm-usage',
            '--disable-features=Translate',
        ],
    )

    return playwright, context


def get_page_cookies(context, domain):
    """获取指定域名的 Cookie。"""
    cookies = context.cookies()
    filtered = [c for c in cookies if domain in c.get('domain', '')]
    if filtered:
        return '; '.join([f"{c['name']}={c['value']}" for c in filtered])
    return None


def redact_cookie(cookie_str):
    """脱敏处理：只显示 Cookie 的前 8 位和最后 4 位。"""
    if not cookie_str:
        return None
    parts = cookie_str.split('; ')
    redacted = []
    for part in parts:
        if '=' in part:
            name, value = part.split('=', 1)
            if len(value) > 12:
                redacted.append(f"{name}={value[:8]}...{value[-4:]}")
            else:
                redacted.append(f"{name}={value}")
        else:
            redacted.append(part)
    return '; '.join(redacted)


def check_status(domain):
    """检查 session 是否可用。"""
    try:
        playwright, context = launch_browser(headless=True)
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(f"https://{domain}", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=15000)

        cookies = get_page_cookies(context, domain)

        context.close()
        playwright.stop()

        if cookies:
            return {"sessionReady": True, "cookies": redact_cookie(cookies)}
        else:
            return {"sessionReady": False, "reason": "页面已打开但未获取到 Cookie，可能未登录"}
    except Exception as e:
        return {"sessionReady": False, "reason": str(e)}


def doctor():
    """环境诊断。"""
    results = []

    # 检查 Chrome 路径
    chrome_exists = os.path.exists(CHROME_PATH)
    results.append(f"Chrome 路径: {'✅ 存在' if chrome_exists else '❌ 不存在'} ({CHROME_PATH})")

    # 检查运行时库
    runtime_exists = os.path.exists(RUNTIME_LIB_DIR)
    results.append(f"运行时库: {'✅ 存在' if runtime_exists else '❌ 不存在'} ({RUNTIME_LIB_DIR})")

    # 检查 profile 目录
    profile_exists = os.path.exists(PROFILE_DIR)
    results.append(f"Profile 目录: {'✅ 存在' if profile_exists else '❌ 不存在'} ({PROFILE_DIR})")

    # 检查 Playwright
    try:
        from playwright.sync_api import sync_playwright
        results.append("Playwright: ✅ 已安装")
    except ImportError:
        results.append("Playwright: ❌ 未安装")

    # 尝试启动浏览器
    try:
        playwright, context = launch_browser(headless=True)
        context.close()
        playwright.stop()
        results.append("浏览器启动: ✅ 成功")
    except Exception as e:
        results.append(f"浏览器启动: ❌ 失败 ({e})")

    return "\n".join(results)


def ensure_session(domain, target_url):
    """确保 session 可用（启动浏览器 → 打开网页 → 获取 Cookie）。"""
    playwright, context = launch_browser(headless=False)  # ensure 模式使用 headed

    try:
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=15000)

        cookies = get_page_cookies(context, domain)

        context.close()
        playwright.stop()

        if cookies:
            return cookies, None
        else:
            return None, "未获取到 Cookie，请确认已登录"
    except Exception as e:
        try:
            context.close()
            playwright.stop()
        except:
            pass
        return None, str(e)


def main():
    parser = argparse.ArgumentParser(description='Chrome Cookie 获取工具（Playwright + Chromium）')
    parser.add_argument('--status', action='store_true', help='检查 session 是否可用')
    parser.add_argument('--doctor', action='store_true', help='环境诊断')
    parser.add_argument('--ensure', action='store_true', help='自动确保 session 可用')
    parser.add_argument('--domain', type=str, help='目标域名')
    parser.add_argument('--url', type=str, help='目标 URL')
    parser.add_argument('--show-secrets', action='store_true', help='显示完整 Cookie（默认脱敏）')
    args = parser.parse_args()

    if args.doctor:
        print(doctor())
        return

    if args.status:
        if not args.domain:
            print("错误: --status 需要 --domain 参数")
            sys.exit(1)
        result = check_status(args.domain)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    if args.ensure:
        if not args.domain or not args.url:
            print("错误: --ensure 需要 --domain 和 --url 参数")
            sys.exit(1)
        cookies, error = ensure_session(args.domain, args.url)
        if error:
            print(f"错误: {error}")
            sys.exit(1)
        if args.show_secrets:
            print(cookies)
        else:
            print(redact_cookie(cookies))
        return

    # 默认模式：直接获取 Cookie
    if not args.domain:
        print("用法: python3 auto_cookie.py --domain=<domain> [--url=<url>]")
        print("       python3 auto_cookie.py --status --domain=<domain>")
        print("       python3 auto_cookie.py --doctor")
        print("       python3 auto_cookie.py --ensure --domain=<domain> --url=<url>")
        sys.exit(1)

    cookies, error = ensure_session(args.domain, args.url or f"https://{args.domain}")
    if error:
        print(f"错误: {error}")
        sys.exit(1)

    if args.show_secrets:
        print(cookies)
    else:
        print(redact_cookie(cookies))


if __name__ == '__main__':
    main()