"""Shared helpers for local Java backend MCP servers."""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen


PACKAGE_DIR = Path(__file__).resolve().parent
MCP_ROOT = PACKAGE_DIR.parent
GROUP_ROOT = MCP_ROOT.parents[1]
DEFAULT_SKILLS_DIR = Path(os.environ.get("JAVA_BACKEND_SKILLS_DIR", str(GROUP_ROOT / "skills")))
if not DEFAULT_SKILLS_DIR.exists():
    DEFAULT_SKILLS_DIR = Path.home() / ".codex" / "skills"

DEFAULT_BROWSER_SCRIPT = str(DEFAULT_SKILLS_DIR / "get-browser-session" / "scripts" / "browser_session.js")
DEFAULT_BROWSER_PROFILE = os.environ.get("JAVA_BACKEND_BROWSER_PROFILE", str(Path.home() / ".codex" / "lexiao-browser-profile"))
DEFAULT_INTERNAL_ALLOWED_HOSTS = ".fenqile.com,.lexinfintech.com,.lexincloud.com,localhost,127.0.0.1"


def skill_path(skill_name: str, *parts: str) -> str:
    return str(DEFAULT_SKILLS_DIR / skill_name / Path(*parts))


def json_text(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


def error_text(message: str, **extra: Any) -> str:
    payload: dict[str, Any] = {"error": message}
    payload.update({k: v for k, v in extra.items() if v is not None})
    return json_text(payload)


def env_value(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value:
        return value

    env_path = Path(
        os.environ.get(
            "JAVA_BACKEND_MCP_ENV",
            str(MCP_ROOT / ".env"),
        )
    ).expanduser()
    if not env_path.exists():
        return default

    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, raw = stripped.split("=", 1)
        if key.strip() == name:
            return raw.strip().strip("'\"")
    return default


def bounded_int(value: int | str, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except Exception:
        parsed = default
    return max(minimum, min(parsed, maximum))


def run_command(command: list[str], timeout: int = 120, cwd: str | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        return {
            "exit_code": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "exit_code": 124,
            "stdout": exc.stdout or "",
            "stderr": f"command timed out after {timeout}s",
        }
    except Exception as exc:
        return {
            "exit_code": 1,
            "stdout": "",
            "stderr": str(exc),
        }


def command_result_text(result: dict[str, Any], max_chars: int = 12000) -> str:
    stdout = str(result.get("stdout") or "")
    stderr = str(result.get("stderr") or "")
    payload = {
        "exit_code": result.get("exit_code"),
        "stdout": stdout[:max_chars],
        "stderr": stderr[:max_chars],
        "truncated": len(stdout) > max_chars or len(stderr) > max_chars,
    }
    return json_text(payload)


def browser_cookie_header(url: str, domain: str = "", profile: str = "", timeout: int = 120) -> str:
    cookie_domain = domain or safe_domain_from_url(url)
    if not cookie_domain:
        raise ValueError("domain or url is required")

    target_url = url or f"https://{cookie_domain}"
    command = [
        "node",
        DEFAULT_BROWSER_SCRIPT,
        f"--url={target_url}",
        "--cookies",
        "--show-secrets",
        f"--domain={cookie_domain}",
        "--success-text=none",
    ]
    if profile:
        command.append(f"--profile={profile}")

    result = run_command(command, timeout=bounded_int(timeout, 120, 10, 600))
    if result["exit_code"] != 0:
        raise RuntimeError(result["stderr"] or result["stdout"] or "cookie lookup failed")

    data = json.loads(result["stdout"])
    pairs = [
        f"{item['name']}={item['value']}"
        for item in data.get("cookies", [])
        if item.get("name") and item.get("value")
    ]
    if not pairs:
        raise RuntimeError(f"cookie not found for {cookie_domain}")
    return "; ".join(pairs)


def split_allowed_hosts(value: str) -> list[str]:
    return [item.strip() for item in str(value or "").split(",") if item.strip()]


def is_allowed_host(host: str, allowed_hosts: str = "") -> bool:
    allowed = split_allowed_hosts(allowed_hosts or env_value("INTERNAL_HTTP_ALLOWED_HOSTS", DEFAULT_INTERNAL_ALLOWED_HOSTS))
    return any(host == item or (item.startswith(".") and host.endswith(item)) for item in allowed)


def internal_http_get(
    url: str,
    headers: dict[str, str] | None = None,
    use_browser_session: bool = False,
    profile: str = "",
    domain: str = "",
    timeout: int = 60,
    max_chars: int = 12000,
    allowed_hosts: str = "",
) -> dict[str, Any]:
    return internal_http_request(
        "GET",
        url,
        headers=headers,
        use_browser_session=use_browser_session,
        profile=profile,
        domain=domain,
        timeout=timeout,
        max_chars=max_chars,
        allowed_hosts=allowed_hosts,
    )


def internal_http_request(
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    body: str | bytes | None = None,
    use_browser_session: bool = False,
    profile: str = "",
    domain: str = "",
    timeout: int = 60,
    max_chars: int = 12000,
    allowed_hosts: str = "",
) -> dict[str, Any]:
    method = method.upper()
    if method not in {"GET", "POST"}:
        return {"error": "only GET/POST are supported", "method": method}
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return {"error": "only http/https URLs are supported", "url": url}
    if not is_allowed_host(parsed.hostname, allowed_hosts):
        return {"error": "host is not allowed", "host": parsed.hostname}

    request_headers = {"Accept": "application/json,text/plain,*/*"}
    request_headers.update(headers or {})
    if use_browser_session:
        try:
            request_headers["Cookie"] = browser_cookie_header(url, domain or parsed.hostname, profile)
        except Exception as exc:
            return {"error": "unable to get browser session cookie", "detail": str(exc)}

    try:
        payload = body.encode("utf-8") if isinstance(body, str) else body
        request = Request(url, data=payload, headers=request_headers, method=method)
        with urlopen(request, timeout=bounded_int(timeout, 60, 5, 300)) as response:
            body = response.read().decode("utf-8", errors="replace")
            limit = bounded_int(max_chars, 12000, 100, 100000)
            return {
                "status": response.status,
                "url": response.url,
                "body": body[:limit],
                "truncated": len(body) > limit,
            }
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {"error": "HTTP request failed", "status": exc.code, "url": url, "body": body[:1000]}
    except URLError as exc:
        return {"error": "HTTP request unreachable", "url": url, "reason": str(exc.reason)}


def parse_json_object(value: str, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def redact_secret(value: str) -> str:
    if not value:
        return value
    if len(value) <= 8:
        return "<redacted>"
    return f"{value[:4]}...{value[-4:]}"


def redact_cookie_header(cookie: str) -> str:
    parts = []
    for item in str(cookie or "").split(";"):
        if "=" not in item:
            continue
        name, value = item.strip().split("=", 1)
        parts.append(f"{name}={redact_secret(value)}")
    return "; ".join(parts)


def safe_domain_from_url(url: str) -> str:
    parsed = urlparse(url)
    return parsed.hostname or ""


def run_git(repo_dir: str | None, *args: str) -> str:
    cwd = Path(repo_dir or os.getcwd()).expanduser()
    result = subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout.strip()


def current_repo_context(repo_dir: str | None = None) -> dict[str, str]:
    remote = run_git(repo_dir, "remote", "get-url", "origin")
    branch = run_git(repo_dir, "branch", "--show-current")
    return {
        "repo_dir": str(Path(repo_dir or os.getcwd()).expanduser()),
        "remote": remote,
        "branch": branch,
        "project_path": parse_git_project_path(remote),
        "project_name": parse_git_project_name(remote),
    }


def parse_git_project_name(value: str) -> str:
    path = parse_git_project_path(value)
    return path.rsplit("/", 1)[-1] if path else ""


def parse_git_project_path(value: str) -> str:
    raw = value.strip()
    if not raw:
        return ""

    if "://" in raw:
        parsed = urlparse(raw)
        path = parsed.path.lstrip("/")
    elif "@" in raw and ":" in raw:
        path = raw.split(":", 1)[1]
    else:
        path = raw

    path = re.sub(r"^/*", "", path)
    path = re.sub(r"\.git$", "", path)
    return path


def encode_project_path(project_path_or_url: str) -> str:
    project_path = parse_git_project_path(project_path_or_url)
    return quote(project_path, safe="")
