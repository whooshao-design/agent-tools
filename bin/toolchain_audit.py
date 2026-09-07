#!/usr/bin/env python3
"""Read-only inventory of shared skills and client registrations; never emit secrets."""

from __future__ import annotations

import argparse
import ast
import json
import os
from pathlib import Path
import re
import tomllib


SKIP_DIRS = {".git", "node_modules", ".venv", "__pycache__", "references", "scripts", "assets"}


def read_config(path: Path) -> dict:
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    data = tomllib.loads(text) if path.suffix == ".toml" else json.loads(text)
    if not isinstance(data, dict):
        raise ValueError(f"Expected an object: {path}")
    return data


def skill_entries(root: Path) -> list[dict]:
    entries = []
    seen = set()
    if not root.is_dir():
        return entries
    for directory, dirs, files in os.walk(root, followlinks=True):
        path = Path(directory)
        resolved = path.resolve()
        if resolved in seen:
            dirs[:] = []
            continue
        seen.add(resolved)
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
        if "SKILL.md" not in files:
            continue
        skill = path / "SKILL.md"
        text = skill.read_text(encoding="utf-8")
        frontmatter = text.split("---", 2)[1] if text.startswith("---\n") else ""
        name = re.search(r"^name:\s*['\"]?([^'\"\n]+)", frontmatter, re.M)
        description = re.search(r"^description:\s*(.+)", frontmatter, re.M)
        policy = path / "agents/openai.yaml"
        explicit_codex = policy.exists() and bool(re.search(
            r"^\s*allow_implicit_invocation:\s*false\s*$", policy.read_text(), re.M
        ))
        entries.append({
            "name": name.group(1).strip() if name else path.name,
            "path": str(skill), "source": str(skill.resolve()),
            "lines": len(text.splitlines()), "bytes": len(text.encode()),
            "frontmatter_present": bool(name and description),
            "codex_explicit_only": explicit_codex,
            "claude_explicit_only": bool(re.search(
                r"^disable-model-invocation:\s*true\s*$", frontmatter, re.M
            )),
        })
        dirs[:] = []
    return sorted(entries, key=lambda item: (item["name"], item["path"]))


def server_summary(server: dict) -> dict:
    # Never return raw env/header/URL/argument values: placeholders may contain credentials.
    encoded = json.dumps(server)
    referenced = set(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}", encoded))
    required = set(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", encoded))
    command = server.get("command", "")
    args = server.get("args", [])
    module = args[1] if len(args) >= 2 and args[0] == "-m" else None
    return {
        "enabled": server.get("enabled", True) and not server.get("disabled", False),
        "transport": server.get("type", "http" if server.get("url") else "stdio"),
        "executable": Path(command).name if command else None,
        "python_module": module,
        "env_keys": sorted(server.get("env", {})),
        "header_keys": sorted(server.get("headers", server.get("http_headers", {}))),
        "referenced_env": sorted(referenced),
        "missing_process_env": sorted(key for key in required if not os.environ.get(key)),
    }


def inventory(repo: Path, audit_root: Path) -> dict:
    codex = read_config(audit_root / ".codex/config.toml")
    claude = read_config(audit_root / ".claude.json")
    settings = read_config(audit_root / ".claude/settings.json")
    local = read_config(audit_root / ".claude/settings.local.json")
    codex_skills = skill_entries(audit_root / ".codex/skills") + skill_entries(audit_root / ".agents/skills")
    claude_skills = skill_entries(audit_root / ".claude/skills")
    servers = {
        "codex": {name: server_summary(value) for name, value in codex.get("mcp_servers", {}).items()},
        "claude_user": {name: server_summary(value) for name, value in claude.get("mcpServers", {}).items()},
    }
    project_servers = {
        path: {name: server_summary(value) for name, value in project.get("mcpServers", {}).items()}
        for path, project in claude.get("projects", {}).items() if project.get("mcpServers")
    }
    issues = []
    for client, items in servers.items():
        for name, item in items.items():
            if item["missing_process_env"]:
                issues.append({"code": "MCP_ENV_UNRESOLVED", "client": client, "name": name,
                               "env_keys": item["missing_process_env"]})
    for client in ("codex", "claude_user"):
        other = "claude_user" if client == "codex" else "codex"
        for name, item in servers[client].items():
            if item["python_module"] and name not in servers[other]:
                issues.append({"code": "SHARED_MCP_MISSING", "client": other, "name": name})
    for root in (audit_root / ".codex/skills", audit_root / ".claude/skills", audit_root / ".agents/skills"):
        if root.is_dir():
            for entry in root.iterdir():
                if entry.is_symlink() and not entry.exists():
                    issues.append({"code": "BROKEN_SKILL_LINK", "path": str(entry)})
    sources = {}
    for client, items in (("codex", codex_skills), ("claude", claude_skills)):
        for item in items:
            key = (client, item["name"])
            if key in sources:
                issues.append({"code": "DUPLICATE_SKILL", "client": client, "name": item["name"]})
            sources[key] = item["source"]
    for name in {item["name"] for item in codex_skills} & {item["name"] for item in claude_skills}:
        if sources[("codex", name)] != sources[("claude", name)]:
            issues.append({"code": "SKILL_SOURCE_DIFFERS", "name": name})
    models = read_config(audit_root / ".codex/models_cache.json").get("models", [])
    cached = next((model for model in models if model.get("slug") == codex.get("model")), {})
    override = codex.get("model_context_window")
    if override and cached.get("context_window") and override != cached["context_window"]:
        issues.append({"code": "CONTEXT_WINDOW_DIFFERS_FROM_CACHE", "override": override,
                       "cached": cached["context_window"]})
    tool_counts = {}
    for path in sorted((repo / "mcp/devtools-mcp/devtools_mcp").glob("*_server.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        tools = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and any(isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute)
                         and d.func.attr == "tool" for d in node.decorator_list)]
        tool_counts[path.stem] = {"tools": len(tools), "annotated": sum(
            any(k.arg == "annotations" for d in node.decorator_list if isinstance(d, ast.Call)
                for k in d.keywords) for node in tools
        )}
    plugin_settings = {**settings.get("enabledPlugins", {}), **local.get("enabledPlugins", {})}
    hooks = {}
    for client, config in (("codex", read_config(audit_root / ".codex/hooks.json")),
                           ("claude", settings), ("claude_local", local)):
        hooks[client] = {event: sum(len(group.get("hooks", [])) for group in groups)
                         for event, groups in config.get("hooks", {}).items()}
    return {
        "schema": "toolchain-inventory-v1", "repo": str(repo),
        "scope_note": "Configured state only; no network or model calls. CLI overrides, managed settings and remote apps need runtime verification.",
        "models": {"codex": codex.get("model"), "claude": local.get("model", settings.get("model")),
                   "codex_effort": codex.get("model_reasoning_effort"), "claude_effort": local.get("effortLevel", settings.get("effortLevel")),
                   "codex_context_override": override, "codex_cached_context": cached.get("context_window")},
        "skills": {"repository": skill_entries(repo / "skills"), "codex": codex_skills, "claude": claude_skills},
        "mcp": servers, "claude_project_mcp": project_servers,
        "claude_plugins_explicitly_enabled": sorted(name for name, enabled in plugin_settings.items() if enabled),
        "hooks": hooks,
        "hooks_scope_note": "Declaration counts, not effective enabled hooks. Claude user/local layers are separate; Codex trust/enabled state and runtime overrides need verification.",
        "repository_mcp_tools": tool_counts, "issues": issues,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--home-root", type=Path, default=Path.home())
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = inventory(args.repo, args.home_root)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for client, entries in result["skills"].items():
            print(f"skills {client}: {len(entries)}")
        for client, entries in result["mcp"].items():
            print(f"MCP {client}: {len(entries)} configured")
        print("Models:", json.dumps(result["models"], ensure_ascii=False))
        for issue in result["issues"]:
            print(json.dumps(issue, ensure_ascii=False))
        print(result["scope_note"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
