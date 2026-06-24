#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DUBBO_REQUEST = os.environ.get("DUBBO_REQUEST_SCRIPT", str(SCRIPT_DIR / "dubbo_request.py"))
DEFAULT_PROFILE = os.environ.get("JAVA_BACKEND_BROWSER_PROFILE", str(Path.home() / ".codex" / "lexiao-browser-profile"))

FULL_TEMPLATE = re.compile(r"^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$")
PART_TEMPLATE = re.compile(r"\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}")


def parse_args():
    parser = argparse.ArgumentParser(description="Run a JSON-defined Dubbo test scenario through Bianque.")
    parser.add_argument("--scenario", required=True, help="JSON scenario file path, or '-' for stdin")
    parser.add_argument("--env", help="override scenario env: stable/pre")
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--var", action="append", default=[], help="override variable, KEY=VALUE; JSON values are accepted")
    parser.add_argument("--target", action="append", default=[], help="override target, NAME=IP:PORT")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-cleanup", action="store_true")
    parser.add_argument("--continue-on-failure", action="store_true")
    return parser.parse_args()


def load_json(path):
    if path == "-":
        return json.load(sys.stdin)
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def parse_value(value):
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def apply_cli_overrides(spec, args):
    if args.env:
        spec["env"] = args.env
    spec.setdefault("vars", {})
    for item in args.var:
        if "=" not in item:
            raise SystemExit(f"--var must be KEY=VALUE: {item}")
        key, value = item.split("=", 1)
        spec["vars"][key] = parse_value(value)
    spec.setdefault("targets", {})
    for item in args.target:
        if "=" not in item or ":" not in item.split("=", 1)[1]:
            raise SystemExit(f"--target must be NAME=IP:PORT: {item}")
        name, endpoint = item.split("=", 1)
        ip, port = endpoint.rsplit(":", 1)
        spec["targets"][name] = {"ip": ip, "port": port}
    return spec


def get_path(data, path, default=None):
    if path is None or path == "":
        return data
    if isinstance(path, list):
        tokens = path
    elif isinstance(path, str) and path.startswith("/"):
        tokens = [part.replace("~1", "/").replace("~0", "~") for part in path.strip("/").split("/") if part]
    else:
        value = str(path)
        if value.startswith("$."):
            value = value[2:]
        tokens = [part for part in value.split(".") if part]
    current = data
    for token in tokens:
        if isinstance(current, list):
            try:
                current = current[int(token)]
            except (ValueError, IndexError):
                return default
        elif isinstance(current, dict):
            if token not in current:
                return default
            current = current[token]
        else:
            return default
    return current


def resolve_template(context, name):
    marker = object()
    value = get_path(context, name, marker)
    if value is marker:
        raise KeyError(f"template variable not found: {name}")
    return value


def render(value, context):
    if isinstance(value, str):
        full = FULL_TEMPLATE.match(value)
        if full:
            return resolve_template(context, full.group(1))

        def replace(match):
            resolved = resolve_template(context, match.group(1))
            return json.dumps(resolved, ensure_ascii=False) if isinstance(resolved, (dict, list)) else str(resolved)

        return PART_TEMPLATE.sub(replace, value)
    if isinstance(value, list):
        return [render(item, context) for item in value]
    if isinstance(value, dict):
        return {key: render(item, context) for key, item in value.items()}
    return value


def call_dubbo(env, profile, defaults, targets, step, context):
    target_name = step.get("target")
    target = targets.get(target_name, {}) if target_name else {}
    group = step.get("group", defaults.get("group", "default"))
    version = step.get("version", defaults.get("version", "2.0.0"))
    timeout = str(step.get("timeout", defaults.get("timeout", 120)))
    ip = step.get("ip", target.get("ip"))
    port = step.get("port", target.get("port"))
    if not ip or not port:
        raise RuntimeError(f"step {step.get('name', '<unnamed>')} missing ip/port")
    cmd = [
        "python3", DUBBO_REQUEST,
        "--env", env,
        "--profile", profile,
        "--service", step["service"],
        "--method", step["method"],
        "--ip", str(ip),
        "--port", str(port),
        "--group", str(group),
        "--version", str(version),
        "--params", json.dumps(render(step.get("params", []), context), ensure_ascii=False, separators=(",", ":")),
        "--timeout", timeout,
    ]
    output = subprocess.check_output(cmd, text=True)
    return json.loads(output)


def contains(container, expected):
    if isinstance(container, dict):
        return expected in container
    if isinstance(container, (list, tuple, set)):
        return expected in container
    return str(expected) in str(container)


def assert_one(assertion, response, context):
    label = assertion.get("name") or assertion.get("path") or "assertion"
    marker = object()
    actual = get_path(response, assertion.get("path"), marker)
    expected = render(assertion.get("value"), context) if "value" in assertion else None

    if "exists" in assertion:
        ok = (actual is not marker) is bool(assertion["exists"])
    elif "equals" in assertion:
        ok = actual == render(assertion["equals"], context)
    elif "notEquals" in assertion:
        ok = actual != render(assertion["notEquals"], context)
    elif "contains" in assertion:
        ok = actual is not marker and contains(actual, render(assertion["contains"], context))
    elif "notContains" in assertion:
        ok = actual is marker or not contains(actual, render(assertion["notContains"], context))
    elif assertion.get("truthy"):
        ok = bool(actual)
    elif assertion.get("falsey"):
        ok = not bool(actual)
    elif "in" in assertion:
        ok = actual in render(assertion["in"], context)
    elif "regex" in assertion:
        ok = actual is not marker and re.search(str(assertion["regex"]), str(actual)) is not None
    elif "value" in assertion:
        ok = actual == expected
    else:
        raise AssertionError(f"{label}: unsupported assertion {assertion}")

    if not ok:
        shown = None if actual is marker else actual
        raise AssertionError(f"{label}: actual={shown!r}, assertion={assertion}")


def run_step(env, profile, defaults, targets, step, context, dry_run):
    step_type = step.get("type", "dubbo")
    name = step.get("name", step_type)
    if step_type == "sleep" or "sleep" in step:
        seconds = float(step.get("seconds", step.get("sleep", 1)))
        if not dry_run:
            time.sleep(seconds)
        return {"name": name, "type": "sleep", "seconds": seconds, "status": "ok"}

    if step_type != "dubbo":
        raise RuntimeError(f"{name}: unsupported step type {step_type}")
    if dry_run:
        return {
            "name": name,
            "type": "dubbo",
            "status": "dry-run",
            "service": step.get("service"),
            "method": step.get("method"),
            "params": render(step.get("params", []), context),
        }

    response = call_dubbo(env, profile, defaults, targets, step, context)
    for assertion in step.get("assert", []):
        assert_one(assertion, response, context)
    for key, path in step.get("extract", {}).items():
        context[key] = get_path(response, path)
    return {
        "name": name,
        "type": "dubbo",
        "status": "ok",
        "service": step.get("service"),
        "method": step.get("method"),
        "response": response,
    }


def run_steps(label, steps, env, profile, defaults, targets, context, args):
    results = []
    failed = False
    for step in steps:
        try:
            results.append(run_step(env, profile, defaults, targets, step, context, args.dry_run))
        except Exception as exc:
            failed = True
            results.append({
                "name": step.get("name", step.get("type", "dubbo")),
                "status": "failed",
                "error": str(exc),
            })
            if not args.continue_on_failure:
                break
    return {"name": label, "failed": failed, "steps": results}


def main():
    args = parse_args()
    spec = apply_cli_overrides(load_json(args.scenario), args)
    env = spec.get("env", "stable")
    profile = spec.get("profile", args.profile)
    defaults = spec.get("defaults", {})
    targets = spec.get("targets", {})
    context = {"env": env, **spec.get("vars", {})}

    main_result = run_steps("main", spec.get("steps", []), env, profile, defaults, targets, context, args)
    cleanup_result = None
    if spec.get("cleanup") and not args.no_cleanup:
        cleanup_args = argparse.Namespace(**vars(args))
        cleanup_args.continue_on_failure = True
        cleanup_result = run_steps("cleanup", spec.get("cleanup", []), env, profile, defaults, targets, context, cleanup_args)

    output = {
        "scenario": spec.get("name", args.scenario),
        "env": env,
        "status": "failed" if main_result["failed"] else "ok",
        "context": context,
        "main": main_result,
        "cleanup": cleanup_result,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    if main_result["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
