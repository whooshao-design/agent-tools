#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Requests carry the login Cookie: never follow a redirect to another origin with it."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        absolute = urllib.parse.urljoin(req.full_url, newurl)
        origin = urllib.parse.urlsplit(req.full_url)
        target = urllib.parse.urlsplit(absolute)
        if (origin.scheme, origin.netloc) != (target.scheme, target.netloc):
            raise RuntimeError(
                f"{req.full_url} redirected to another origin ({target.scheme}://{target.netloc}); refusing to forward credentials"
            )
        return super().redirect_request(req, fp, code, msg, headers, absolute)


OPENER = urllib.request.build_opener(SameOriginRedirectHandler())


SKILL_DIR = Path(__file__).resolve().parents[1]
SKILLS_DIR = SKILL_DIR.parent
SKILLS_ROOT = SKILL_DIR.parents[1]
DEFAULT_PROFILE = (
    os.environ.get("BROWSER_SESSION_PROFILE")
    or os.environ.get("DEVTOOLS_BROWSER_PROFILE")
    or os.environ.get("JAVA_BACKEND_BROWSER_PROFILE")
    or str(Path.home() / ".local" / "state" / "agent-tools" / "browser-profiles" / "main")
)
DEFAULT_TARGETS_FILE = os.environ.get("DUBBO_TARGETS_FILE", str(SKILL_DIR / "targets.json"))
DEFAULT_NO_PROXY = ".fenqile.com,.lexinfintech.com,.lexincloud.com,10.0.0.0/8,localhost,127.0.0.1"
BROWSER_SESSION_SCRIPT = os.environ.get(
    "BROWSER_SESSION_SCRIPT",
    str(SKILLS_ROOT / "lexin" / "get-browser-session" / "scripts" / "browser_session.js"),
)
BROWSER_REQUEST_SCRIPT = os.environ.get(
    "BIANQUE_BROWSER_REQUEST_SCRIPT",
    str(SKILL_DIR / "scripts" / "bianque_browser_request.js"),
)
ENV_CONFIG = {
    "stable": {
        "base_url": "https://stable-bianque.lexinfintech.com",
        "env": "prj",
        "domain": "stable-bianque.lexinfintech.com",
    },
    "pre": {
        "base_url": "https://bianque.lexinfintech.com",
        "env": "pre",
        "domain": "bianque.lexinfintech.com",
    },
}
ENV_ALIASES = {
    "auto": "auto",
    "": "auto",
    "stable": "stable",
    "stable环境": "stable",
    "prj": "stable",
    "project": "stable",
    "项目": "stable",
    "项目环境": "stable",
    "test": "stable",
    "testing": "stable",
    "测试": "stable",
    "测试环境": "stable",
    "offline": "stable",
    "线下": "stable",
    "线下环境": "stable",
    "pre": "pre",
    "pre环境": "pre",
    "preview": "pre",
    "预发布": "pre",
    "预发布环境": "pre",
    "gray": "pre",
    "gray环境": "pre",
    "灰度": "pre",
    "灰度环境": "pre",
    "prod": "pre",
    "prod环境": "pre",
    "online": "pre",
    "线上": "pre",
    "线上环境": "pre",
    "生产": "pre",
    "生产环境": "pre",
}
KEY_ENV_ALIASES = {
    "stable": "stable",
    "test": "stable",
    "testing": "stable",
    "offline": "stable",
    "pre": "pre",
    "preview": "pre",
    "gray": "pre",
    "prod": "pre",
    "online": "pre",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Call Dubbo through Bianque service emulator.")
    parser.add_argument("--env", default="stable", help="environment alias; test/offline/stable -> stable, pre/gray/prod/online -> pre; auto infers from Redis key")
    parser.add_argument("--base-url")
    parser.add_argument("--bianque-env")
    parser.add_argument("--domain")
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--cookie")
    parser.add_argument("--service", required=True)
    parser.add_argument("--method", required=True)
    parser.add_argument("--app", help="optional app key in targets.json")
    parser.add_argument("--targets-file", default=DEFAULT_TARGETS_FILE)
    parser.add_argument("--ip")
    parser.add_argument("--port")
    parser.add_argument("--group", default="default")
    parser.add_argument("--version", default="2.0.0")
    parser.add_argument("--params", default="[]", help="JSON array string")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--transport", choices=["auto", "http", "browser"], default="auto")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def ensure_internal_no_proxy():
    for name in ("NO_PROXY", "no_proxy"):
        current = os.environ.get(name, "")
        entries = [item.strip() for item in current.split(",") if item.strip()]
        existing = set(entries)
        for item in DEFAULT_NO_PROXY.split(","):
            if item not in existing:
                entries.append(item)
                existing.add(item)
        os.environ[name] = ",".join(entries)


def infer_env_from_params(params):
    if not isinstance(params, list) or len(params) < 2:
        return ""
    key = str(params[1] or "")
    tokens = [item for item in key.replace("-", ":").replace("_", ":").replace(".", ":").replace("/", ":").split(":") if item]
    for token in reversed(tokens):
        canonical = KEY_ENV_ALIASES.get(token.lower())
        if canonical:
            return canonical
    return ""


# 部署环境只决定 targets.json 里查哪条 IP:Port；线路（stable/pre 两个服务模拟器站点）由 ENV_ALIASES 归一。
# prod/gray 走 pre 线路，但目标实例必须是 prod/gray 自己的地址，不能借用 pre 条目。
DEPLOY_ENV_ALIASES = {
    "gray": "gray", "gray环境": "gray", "灰度": "gray", "灰度环境": "gray",
    "prod": "prod", "prod环境": "prod", "online": "prod", "线上": "prod", "线上环境": "prod", "生产": "prod", "生产环境": "prod",
}


def deploy_env(value, target_env):
    key = str(value or "").strip()
    return DEPLOY_ENV_ALIASES.get(key) or DEPLOY_ENV_ALIASES.get(key.lower()) or target_env


def normalize_env(value, params=None):
    key = str(value or "stable").strip()
    canonical = ENV_ALIASES.get(key) or ENV_ALIASES.get(key.lower())
    if canonical == "auto":
        inferred = infer_env_from_params(params)
        if inferred:
            return inferred
        raise SystemExit("missing env: pass --env, or include an environment token in the Redis key")
    if canonical:
        return canonical
    raise SystemExit(f"unsupported env: {value}. Supported aliases: {', '.join(sorted(ENV_ALIASES))}")


def resolve_endpoint(args, target_env, deployment_env=None):
    deployment_env = deployment_env or target_env
    if args.ip and args.port:
        return args.ip, args.port
    if args.app:
        if not os.path.exists(args.targets_file):
            raise SystemExit(f"targets file not found: {args.targets_file}")
        with open(args.targets_file, "r", encoding="utf-8") as handle:
            targets = json.load(handle)
        endpoint = (targets.get(args.app) or {}).get(deployment_env)
        if endpoint:
            ip = endpoint.get("ip")
            port = endpoint.get("port")
            if ip and port:
                return str(ip), str(port)
        if deployment_env != target_env:
            raise SystemExit(
                f"targets.json has no {args.app}.{deployment_env} entry; a {deployment_env} call must not borrow the "
                f"{target_env} address. Pass --ip/--port for the {deployment_env} instance."
            )
    raise SystemExit("missing target endpoint: pass --ip/--port or --app with a matching targets.json entry")


def get_cookie(base_url, domain, profile):
    cmd = [
        "node",
        BROWSER_SESSION_SCRIPT,
        f"--url={base_url}",
        "--cookies",
        "--show-secrets",
        f"--domain={domain}",
        "--success-text=none",
        f"--profile={profile}",
    ]
    data = json.loads(subprocess.check_output(cmd, text=True))
    cookie = "; ".join(
        f"{item['name']}={item['value']}"
        for item in data.get("cookies", [])
        if item.get("name") and item.get("value")
    )
    if not cookie:
        raise RuntimeError(f"cookie not found for {domain}")
    return cookie


def load_params(value):
    try:
        params = json.loads(value)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"--params must be a JSON array: {exc}") from exc
    if not isinstance(params, list):
        raise SystemExit("--params must be a JSON array")
    return params


def build_body(args, bianque_env, ip, port, params):
    return (
        f"env={urllib.parse.quote(bianque_env)}"
        f"&service={urllib.parse.quote(args.service)}"
        f"&ip={urllib.parse.quote(str(ip))}"
        f"&port={urllib.parse.quote(str(port))}"
        f"&group={urllib.parse.quote(args.group)}"
        f"&version={urllib.parse.quote(args.version)}"
        f"&method={urllib.parse.quote(args.method)}"
        f"&params={urllib.parse.quote(json.dumps(params, separators=(',', ':')))}"
        "&comment=&stringFlag=false"
    ).encode()


def call_http(args, base_url, bianque_env, cookie, ip, port, params):
    body = build_body(args, bianque_env, ip, port, params)
    request = urllib.request.Request(
        f"{base_url}/serviceEmulator/request",
        data=body,
        headers={
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "Cookie": cookie,
            "Origin": base_url,
            "Referer": f"{base_url}/",
            "X-Requested-With": "XMLHttpRequest",
        },
        method="POST",
    )
    with OPENER.open(request, timeout=args.timeout) as response:
        text = response.read().decode()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text}


def call_browser(args, base_url, bianque_env, target_env, ip, port, params):
    command = [
        "node",
        BROWSER_REQUEST_SCRIPT,
        f"--base-url={base_url}",
        f"--route-env={target_env}",
        f"--env={bianque_env}",
        f"--service={args.service}",
        f"--method={args.method}",
        f"--ip={ip}",
        f"--port={port}",
        f"--group={args.group}",
        f"--version={args.version}",
        f"--params={json.dumps(params, ensure_ascii=False, separators=(',', ':'))}",
        f"--profile={args.profile}",
        f"--timeout-ms={max(5000, int(args.timeout) * 1000)}",
    ]
    result = subprocess.run(
        command,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=max(10, int(args.timeout) + 30),
    )
    if result.returncode != 0:
        raise SystemExit(result.stderr or result.stdout or "browser request failed")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"raw": result.stdout}


def should_use_browser(args, base_url):
    if args.transport == "browser":
        return True
    if args.transport == "http":
        return False
    return not args.cookie and "bianque.lexinfintech.com" in base_url


def main():
    ensure_internal_no_proxy()
    args = parse_args()
    params = load_params(args.params)
    target_env = normalize_env(args.env, params)
    config = ENV_CONFIG[target_env]
    base_url = args.base_url or config["base_url"]
    bianque_env = args.bianque_env or config["env"]
    domain = args.domain or config["domain"]
    deployment_env = deploy_env(args.env, target_env)
    ip, port = resolve_endpoint(args, target_env, deployment_env)
    if args.dry_run:
        print(json.dumps({
            "requested_env": args.env,
            "target_env": target_env,
            "deploy_env": deployment_env,
            "base_url": base_url,
            "bianque_env": bianque_env,
            "service": args.service,
            "method": args.method,
            "ip": ip,
            "port": port,
            "group": args.group,
            "version": args.version,
            "params": params,
            "transport": args.transport,
        }, ensure_ascii=False, indent=2))
        return
    if should_use_browser(args, base_url):
        result = call_browser(args, base_url, bianque_env, target_env, ip, port, params)
    else:
        cookie = args.cookie or get_cookie(base_url, domain, args.profile)
        try:
            result = call_http(args, base_url, bianque_env, cookie, ip, port, params)
        except (urllib.error.HTTPError, urllib.error.URLError):
            if args.transport == "http":
                raise
            result = call_browser(args, base_url, bianque_env, target_env, ip, port, params)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
