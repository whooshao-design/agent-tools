#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[1]
SKILLS_DIR = SKILL_DIR.parent
DEFAULT_PROFILE = os.environ.get("JAVA_BACKEND_BROWSER_PROFILE", str(Path.home() / ".codex" / "lexiao-browser-profile"))
DEFAULT_TARGETS_FILE = os.environ.get("DUBBO_TARGETS_FILE", str(SKILL_DIR / "targets.json"))
BROWSER_SESSION_SCRIPT = os.environ.get(
    "BROWSER_SESSION_SCRIPT",
    str(SKILLS_DIR / "get-browser-session" / "scripts" / "browser_session.js"),
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


def parse_args():
    parser = argparse.ArgumentParser(description="Call Dubbo through Bianque service emulator.")
    parser.add_argument("--env", choices=sorted(ENV_CONFIG), default="stable")
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
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def resolve_endpoint(args):
    if args.ip and args.port:
        return args.ip, args.port
    if args.app:
        if not os.path.exists(args.targets_file):
            raise SystemExit(f"targets file not found: {args.targets_file}")
        with open(args.targets_file, "r", encoding="utf-8") as handle:
            targets = json.load(handle)
        endpoint = (targets.get(args.app) or {}).get(args.env)
        if endpoint:
            ip = endpoint.get("ip")
            port = endpoint.get("port")
            if ip and port:
                return str(ip), str(port)
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
        "--login-pattern=Work Happy|QR Code|Use MOA|Account|登录|扫码|账号|密码|SSO|OAuth",
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


def build_body(args, bianque_env, ip, port):
    params = load_params(args.params)
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


def call(args, base_url, bianque_env, cookie, ip, port):
    body = build_body(args, bianque_env, ip, port)
    request = urllib.request.Request(
        f"{base_url}/serviceEmulator/request",
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Cookie": cookie,
            "Origin": base_url,
            "Referer": f"{base_url}/",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=args.timeout) as response:
        text = response.read().decode()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text}


def main():
    args = parse_args()
    config = ENV_CONFIG[args.env]
    base_url = args.base_url or config["base_url"]
    bianque_env = args.bianque_env or config["env"]
    domain = args.domain or config["domain"]
    ip, port = resolve_endpoint(args)
    if args.dry_run:
        print(json.dumps({
            "base_url": base_url,
            "bianque_env": bianque_env,
            "service": args.service,
            "method": args.method,
            "ip": ip,
            "port": port,
            "group": args.group,
            "version": args.version,
            "params": load_params(args.params),
        }, ensure_ascii=False, indent=2))
        return
    cookie = args.cookie or get_cookie(base_url, domain, args.profile)
    result = call(args, base_url, bianque_env, cookie, ip, port)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
