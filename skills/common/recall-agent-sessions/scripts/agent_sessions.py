#!/usr/bin/env python3
"""Search local Claude Code and Codex session transcripts and build handoff material.

Read-only. Sources:
  Claude Code: ~/.claude/projects/<dir>/<session-id>.jsonl (subagent transcripts in deeper dirs are skipped)
  Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (threads with parent_thread_id are skipped)
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

CLAUDE_ROOT = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / "projects"
CODEX_ROOT = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "sessions"

# Injected context, not something the user typed.
NOISE_PREFIXES = (
    "<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>", "Caveat:",
    "# AGENTS.md instructions", "<environment_context>", "<user_instructions>",
    "<permissions instructions>", "<turn_aborted>", "<task-notification>",
    "<bash-stdout>", "[Request interrupted by user",
)
REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
PASTE_TAG_RE = re.compile(r"</?pasted_content[^>]*>")
SHELLS = {"bash", "/bin/bash", "sh", "/bin/sh", "zsh", "/bin/zsh"}


class Session:
    def __init__(self, agent, sid, path):
        self.agent, self.id, self.path = agent, sid, path
        self.cwd = self.branch = self.source = ""
        self.start = self.end = ""
        self.events = []  # (timestamp, kind, text); kind: user | assistant | command | file

    def add(self, ts, kind, text):
        text = (text or "").strip()
        if not text:
            return
        if self.events and self.events[-1][1:] == (kind, text):
            return  # retried or re-sent duplicate
        if ts:
            self.start = self.start or ts
            self.end = ts
        self.events.append((ts or "", kind, text))

    def first_prompt(self):
        return next((t for _, k, t in self.events if k == "user"), "")

    def resume_cmd(self):
        if self.agent == "claude":
            return f"cd {self.cwd} && claude --resume {self.id}"
        return f"codex resume {self.id}"


def clean_user_text(text):
    text = PASTE_TAG_RE.sub("", REMINDER_RE.sub("", text or "")).strip()
    if not text or text.startswith(NOISE_PREFIXES):
        return ""
    return text


def read_jsonl(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    yield json.loads(line)
                except ValueError:
                    continue
    except OSError as exc:
        print(f"warning: cannot read {path}: {exc}", file=sys.stderr)


def parse_claude(path):
    s = Session("claude", path.stem, path)
    for d in read_jsonl(path):
        typ = d.get("type")
        if typ not in ("user", "assistant") or d.get("isSidechain"):
            continue
        s.cwd = s.cwd or d.get("cwd", "")
        s.branch = s.branch or d.get("gitBranch", "")
        ts = d.get("timestamp", "")
        content = (d.get("message") or {}).get("content")
        if typ == "user":
            if d.get("isMeta") or d.get("isCompactSummary"):
                continue
            if isinstance(content, str):
                s.add(ts, "user", clean_user_text(content))
            elif isinstance(content, list):
                for part in content:
                    if part.get("type") == "text":
                        s.add(ts, "user", clean_user_text(part.get("text")))
            continue
        for part in content if isinstance(content, list) else []:
            ptype = part.get("type")
            if ptype == "text":
                s.add(ts, "assistant", part.get("text"))
            elif ptype == "tool_use":
                name, inp = part.get("name", ""), part.get("input") or {}
                if name == "Bash":
                    s.add(ts, "command", inp.get("command"))
                elif name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
                    s.add(ts, "file", inp.get("file_path") or inp.get("notebook_path"))
    return s


def codex_command(cmd):
    if isinstance(cmd, list):
        if len(cmd) >= 3 and cmd[0] in SHELLS and cmd[1] in ("-lc", "-c"):
            return cmd[2]
        return " ".join(map(str, cmd))
    return str(cmd or "")


def parse_codex(path):
    s = None
    items, legacy = [], []
    for d in read_jsonl(path):
        typ, p = d.get("type"), d.get("payload") or {}
        ts = d.get("timestamp", "")
        if typ == "session_meta":
            if p.get("parent_thread_id"):
                return None  # guardian / spawned sub-thread
            s = Session("codex", p.get("id", path.stem), path)
            s.cwd = p.get("cwd", "")
            s.branch = (p.get("git") or {}).get("branch", "") if isinstance(p.get("git"), dict) else ""
            s.source = p.get("originator", "")
        elif typ == "event_msg" and p.get("type") == "item_completed":
            items.append((ts, p.get("item") or {}))
        elif typ == "event_msg" and p.get("type") in ("user_message", "agent_message"):
            legacy.append((ts, p))
        elif typ == "response_item" and p.get("type") == "function_call":
            legacy.append((ts, p))
    if s is None:
        return None
    if any(i.get("type") == "UserMessage" for _, i in items):
        for ts, it in items:
            kind = it.get("type")
            texts = [c.get("text", "") for c in it.get("content") or [] if isinstance(c, dict)]
            if kind == "UserMessage":
                s.add(ts, "user", clean_user_text("\n".join(texts)))
            elif kind == "AgentMessage":
                s.add(ts, "assistant", "\n".join(texts))
            elif kind == "CommandExecution":
                s.add(ts, "command", codex_command(it.get("command")))
            elif kind == "FileChange":
                for f in (it.get("changes") or {}):
                    s.add(ts, "file", f)
    else:  # older rollout format
        for ts, p in legacy:
            if p.get("type") == "user_message":
                s.add(ts, "user", clean_user_text(p.get("message")))
            elif p.get("type") == "agent_message":
                s.add(ts, "assistant", p.get("message"))
            elif p.get("name") in ("shell", "exec_command", "local_shell"):
                try:
                    args = json.loads(p.get("arguments") or "{}")
                except ValueError:
                    args = {}
                s.add(ts, "command", codex_command(args.get("command") or args.get("cmd")))
    return s


def session_files(agent, since_days):
    cutoff = time.time() - since_days * 86400 if since_days else 0
    out = []
    if agent in ("all", "claude") and CLAUDE_ROOT.is_dir():
        out += [("claude", p) for p in CLAUDE_ROOT.glob("*/*.jsonl")]
    if agent in ("all", "codex") and CODEX_ROOT.is_dir():
        out += [("codex", p) for p in CODEX_ROOT.glob("*/*/*/rollout-*.jsonl")]
    out = [(a, p) for a, p in out if p.stat().st_mtime >= cutoff]
    out.sort(key=lambda ap: ap[1].stat().st_mtime, reverse=True)
    return out


def current_ids():
    return {v for v in (os.environ.get("CLAUDE_CODE_SESSION_ID"), os.environ.get("CODEX_THREAD_ID")) if v}


def raw_contains(path, terms):
    try:
        raw = path.read_text(encoding="utf-8", errors="replace").lower()
    except OSError:
        return False
    return all(t in raw for t in terms)


def load_sessions(args, terms=()):
    skip = set() if getattr(args, "include_current", False) else current_ids()
    for agent, path in session_files(args.agent, args.since):
        if terms and not raw_contains(path, terms):
            continue
        s = parse_claude(path) if agent == "claude" else parse_codex(path)
        if s is None or s.id in skip or not s.events:
            continue
        if args.cwd and args.cwd.lower() not in s.cwd.lower():
            continue
        yield s


def short(text, n):
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"


def header(s):
    src = f" {s.source}" if s.source else ""
    return (f"[{s.agent}{src}] {s.id}  {s.start[:16].replace('T', ' ')} → {s.end[:16].replace('T', ' ')}\n"
            f"  cwd: {s.cwd}{'  branch: ' + s.branch if s.branch else ''}\n"
            f"  首个提问: {short(s.first_prompt(), 120)}")


def session_record(s, prompt_chars, last_chars):
    """Machine-readable summary; start/end keep the transcript's ISO-8601 UTC timestamps."""
    replies = [(ts, t) for ts, k, t in s.events if k == "assistant"]
    return {
        "agent": s.agent, "id": s.id, "source": s.source, "cwd": s.cwd, "branch": s.branch,
        "start": s.start, "end": s.end, "path": str(s.path),
        "prompts": [{"time": ts, "text": short(t, prompt_chars)} for ts, k, t in s.events if k == "user"],
        "last_reply": replies[-1][1][:last_chars] if replies else "",
        "last_reply_time": replies[-1][0] if replies else "",
    }


def cmd_list(args):
    records = []
    for n, s in enumerate(load_sessions(args)):
        if n >= args.limit:
            break
        if args.json:
            records.append(session_record(s, args.prompt_chars, args.last_chars))
        else:
            print(header(s), "\n")
    if args.json:
        print(json.dumps(records, ensure_ascii=False, indent=2))


def snippet(text, pattern, width=90):
    m = pattern.search(text)
    if not m:
        return short(text, width * 2)
    a, b = max(0, m.start() - width), min(len(text), m.end() + width)
    return ("…" if a else "") + " ".join(text[a:b].split()) + ("…" if b < len(text) else "")


def cmd_search(args):
    if args.regex:
        patterns = [re.compile(args.query, re.I)]
    else:
        patterns = [re.compile(re.escape(t), re.I) for t in args.query.split()]
    kinds = {"user", "assistant", "command", "file"} if args.all_kinds else {"user", "assistant"}
    found = 0
    terms = () if args.regex else [t.lower() for t in args.query.split()]
    for s in load_sessions(args, terms):
        hits = [(ts, k, t) for ts, k, t in s.events if k in kinds and all(p.search(t) for p in patterns)]
        if not hits:
            continue
        print(header(s))
        print(f"  命中 {len(hits)} 处，恢复：{s.resume_cmd()}")
        for ts, k, t in hits[-args.per_session:]:
            print(f"  - {ts[:16].replace('T', ' ')} {k}: {snippet(t, patterns[0])}")
        print()
        found += 1
        if found >= args.limit:
            break
    if not found:
        print("没有匹配的会话。可以放宽关键词、加 --all-kinds 搜命令和文件，或加大 --since。")


def find_session(sid):
    matches = []
    for agent, path in session_files("all", 0):
        if sid not in path.name:
            continue
        s = parse_claude(path) if agent == "claude" else parse_codex(path)
        if s is not None and s.id.startswith(sid):
            matches.append(s)
    return matches


def cmd_handoff(args):
    matches = find_session(args.session_id)
    if not matches:
        sys.exit(f"找不到会话 {args.session_id}")
    if len(matches) > 1:
        sys.exit("会话 ID 前缀不唯一：" + ", ".join(f"{m.agent}:{m.id}" for m in matches))
    s = matches[0]
    users = [(ts, t) for ts, k, t in s.events if k == "user"]
    replies = [(ts, t) for ts, k, t in s.events if k == "assistant"]
    files = list(dict.fromkeys(t for _, k, t in s.events if k == "file"))
    cmds = [(ts, t) for ts, k, t in s.events if k == "command"]

    out = [f"# 交接材料：{s.agent} 会话 {s.id}", "",
           f"- 文件：`{s.path}`",
           f"- 工作目录：`{s.cwd}`" + (f"，分支 `{s.branch}`" if s.branch else ""),
           f"- 时间：{s.start} → {s.end}",
           f"- 原生恢复（仅限同一 agent）：`{s.resume_cmd()}`",
           f"- 规模：{len(users)} 条用户提问，{len(replies)} 条回复，{len(cmds)} 条命令，{len(files)} 个改动文件", "",
           "## 用户提问（按时间）"]
    out += [f"{i}. [{ts[:16].replace('T', ' ')}] {short(t, args.prompt_chars)}" for i, (ts, t) in enumerate(users, 1)]
    out += ["", "## 改动过的文件"] + ([f"- `{f}`" for f in files] or ["- 无"])
    out += ["", f"## 最近 {min(len(cmds), args.commands)} 条命令（共 {len(cmds)} 条）"]
    out += [f"- `{short(t, 200)}`" for _, t in cmds[-args.commands:]] or ["- 无"]
    out += ["", "## 中间回复（截断）"]
    middle = replies[:-1][-args.replies:]
    out += [f"- [{ts[:16].replace('T', ' ')}] {short(t, 300)}" for ts, t in middle] or ["- 无"]
    if replies:
        ts, t = replies[-1]
        out += ["", f"## 最后一条回复（{ts[:16].replace('T', ' ')}）", "", t[: args.last_chars]]
        if len(t) > args.last_chars:
            out.append(f"\n…（已截断，原文 {len(t)} 字符）")
    print("\n".join(out))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def filters(p):
        p.add_argument("--agent", choices=["all", "claude", "codex"], default="all")
        p.add_argument("--cwd", help="工作目录包含该子串（不区分大小写）")
        p.add_argument("--since", type=float, default=30, help="只看最近 N 天修改过的会话，0 表示不限，默认 30")
        p.add_argument("--limit", type=int, default=10, help="最多输出几个会话，默认 10")
        p.add_argument("--include-current", action="store_true", help="也检索当前会话")

    p = sub.add_parser("list", help="按最近修改时间列出会话")
    filters(p)
    p.add_argument("--json", action="store_true", help="输出 JSON：含 UTC 起止时间、带时间的全部提问与最后一条回复")
    p.add_argument("--prompt-chars", type=int, default=300, help="--json 时每条提问的截断长度")
    p.add_argument("--last-chars", type=int, default=3000, help="--json 时最后一条回复的截断长度")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("search", help="按关键词检索会话内容")
    p.add_argument("query", help="空格分隔的关键词，同一条消息里须全部出现；--regex 时为正则")
    p.add_argument("--regex", action="store_true")
    p.add_argument("--all-kinds", action="store_true", help="同时搜执行的命令和改动的文件路径")
    p.add_argument("--per-session", type=int, default=3, help="每个会话最多显示几处命中，默认 3")
    filters(p)
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("handoff", help="为指定会话输出交接材料")
    p.add_argument("session_id", help="会话 ID 或唯一前缀")
    p.add_argument("--prompt-chars", type=int, default=600)
    p.add_argument("--commands", type=int, default=15)
    p.add_argument("--replies", type=int, default=12)
    p.add_argument("--last-chars", type=int, default=4000)
    p.set_defaults(func=cmd_handoff)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
