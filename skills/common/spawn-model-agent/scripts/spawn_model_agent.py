#!/usr/bin/env python3
"""Spawn a separate agent process on a user-chosen backend (claude-<x> / codex-<x>) to run one task.

usage:
  spawn_model_agent.py --backend kimi --task "..." [--cwd DIR] [--readonly] [--slim] [--wait] [--client claude|codex]
  spawn_model_agent.py --resume JOB_DIR --task "追问..."      # continue the same agent session
  spawn_model_agent.py --status JOB_DIR
  spawn_model_agent.py --list                                  # backends on PATH with eval scores

Host detection: CLAUDECODE / CODEX_* env, then the parent process tree (claude / codex), else --client.
Permissions match an ordinary subagent of the host (read/write in --cwd, MCP inherited on claude-*);
--readonly narrows to read-only tools; --slim skips the global CLAUDE.md/memory/skills for a faster start.
"""
import argparse, glob, json, os, re, shlex, subprocess, sys, time

STATE = os.path.expanduser(os.environ.get('SPAWN_MODEL_AGENT_HOME', '~/.local/state/spawn-model-agent'))
ROUTING = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'build-codeagent', 'model-routing.json')
SLIM_DIR = os.path.expanduser('~/.config/spawn-model-agent/claude-slim')


def wrappers_on_path():
    """Model wrappers: symlinks to claude-profile / codex-profile, plus any backend named in model-routing.json."""
    known = set(routing_backends())
    found = set()
    for d in os.environ.get('PATH', '').split(os.pathsep):
        for p in glob.glob(os.path.join(d, 'claude-*')) + glob.glob(os.path.join(d, 'codex-*')):
            n = os.path.basename(p)
            if not os.access(p, os.X_OK):
                continue
            target = os.path.basename(os.path.realpath(p))
            if n in ('claude-profile', 'codex-profile'):
                continue
            if n in known or target in ('claude-profile', 'codex-profile'):
                found.add(n)
    return sorted(found)


def routing_backends():
    try:
        return json.load(open(ROUTING, encoding='utf-8')).get('backends', {})
    except (OSError, json.JSONDecodeError):
        return {}


def detect_client():
    if os.environ.get('CLAUDECODE') or os.environ.get('CLAUDE_CODE_ENTRYPOINT'):
        return 'claude'
    if any(k.startswith('CODEX_') for k in os.environ):
        return 'codex'
    pid = os.getppid()
    for _ in range(12):
        try:
            comm = open(f'/proc/{pid}/comm').read().strip().lower()
            ppid = int(re.search(r'\)\s+\S+\s+(\d+)', open(f'/proc/{pid}/stat').read()).group(1))
        except (OSError, AttributeError, ValueError):
            break
        if comm.startswith('claude'):
            return 'claude'
        if comm.startswith('codex'):
            return 'codex'
        if pid <= 1:
            break
        pid = ppid
    return None


def resolve_backend(name, client):
    name = name.strip()
    available = wrappers_on_path()
    if name.startswith(('claude-', 'codex-')):
        if name not in available:
            raise SystemExit(f'PATH 上没有 {name}；可用：{", ".join(available)}')
        return name
    if not client:
        raise SystemExit('无法判断宿主客户端（不在 Claude Code / Codex 进程树内），请用完整名如 claude-kimi，或加 --client')
    full = f'{client}-{name}'
    if full not in available:
        raise SystemExit(f'PATH 上没有 {full}；可用：{", ".join(available)}')
    return full


def list_backends():
    routing = routing_backends()
    print('| 后端 | 模型 | 评审分（eval-v2） | 备注 |\n|---|---|---|---|')
    for b in wrappers_on_path():
        r = routing.get(b, {})
        print(f"| {b} | {r.get('model') or r.get('model_source', '?')} | {r.get('review_score', '未测')} | {(r.get('warn') or r.get('note') or '')[:60]} |")
    print('\n短名（qwen/deepseek/kimi/…）按宿主补成 claude-* 或 codex-*；分数与备注来自 build-codeagent/model-routing.json。')


def build_command(backend, task, readonly, resume_id=None):
    """Return argv for the child process. Kept pure for tests."""
    if backend.startswith('claude-'):
        cmd = [backend, '-p', task, '--output-format', 'json']
        if resume_id:
            cmd += ['--resume', resume_id]
        if readonly:
            cmd += ['--strict-mcp-config', '--tools', 'Read,Grep,Glob,WebSearch,WebFetch',
                    '--allowedTools', 'Read,Grep,Glob,WebSearch,WebFetch']
        else:
            cmd += ['--dangerously-skip-permissions']
        return cmd
    # --search is a global codex flag (before the subcommand); the lexin gateway serves the web_search tool.
    # No --ephemeral: the thread must persist so --resume can continue it.
    sandbox = 'read-only' if readonly else 'workspace-write'
    if resume_id:  # `exec resume` has no -s flag; sandbox goes through -c
        return [backend, '--search', 'exec', 'resume', '--skip-git-repo-check', '--json',
                '-c', f'sandbox_mode="{sandbox}"', '-c', 'approval_policy="never"', resume_id, task]
    return [backend, '--search', 'exec', '--skip-git-repo-check', '--json', '-s', sandbox,
            '-c', 'approval_policy="never"', task]


def parse_claude(raw):
    try:
        d = json.loads(raw.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {}, ''
    mu = d.get('modelUsage') or {}
    model = next(iter(mu), None)
    u = mu.get(model, {}) if model else {}
    meta = {'model': model, 'session_id': d.get('session_id'), 'subtype': d.get('subtype'), 'turns': d.get('num_turns'),
            'duration_ms': d.get('duration_ms'),
            'input_tokens': (u.get('inputTokens') or 0) + (u.get('cacheReadInputTokens') or 0) + (u.get('cacheCreationInputTokens') or 0),
            'output_tokens': u.get('outputTokens'), 'permission_denials': [x.get('tool_name') for x in d.get('permission_denials', [])]}
    return meta, d.get('result', '') or ''


def parse_codex(raw):
    events = []
    for line in raw.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    msgs = [e['item']['text'] for e in events if e.get('type') == 'item.completed' and e.get('item', {}).get('type') == 'agent_message']
    cmds = [e['item'].get('command') for e in events if e.get('type') == 'item.completed' and e.get('item', {}).get('type') == 'command_execution']
    usage = next((e['usage'] for e in events if e.get('type') == 'turn.completed'), {})
    thread = next((e.get('thread_id') for e in events if e.get('type') == 'thread.started'), None)
    model = None
    for e in events:
        m = re.search(r'Model metadata for `([^`]+)`', str(e))
        if m:
            model = m.group(1); break
    meta = {'model': model, 'session_id': thread, 'commands': len(cmds),
            'input_tokens': usage.get('input_tokens'), 'output_tokens': usage.get('output_tokens')}
    return meta, msgs[-1] if msgs else ''


def status(job):
    meta_p = os.path.join(job, 'meta.json')
    if os.path.exists(meta_p):
        m = json.load(open(meta_p))
        print(f"状态: 完成  退出码 {m.get('exit_code')}  模型 {m.get('model')}  耗时 {m.get('wall_s')}s  "
              f"token in/out {m.get('input_tokens')}/{m.get('output_tokens')}  会话 {m.get('session_id')}")
        print(f"结果: {os.path.join(job, 'result.md')}")
        return 0
    print('状态: 运行中或未开始（meta.json 尚未写出）；日志：', os.path.join(job, 'stderr.log'))
    return 3


def child_env(backend, slim):
    env = dict(os.environ)
    if slim and backend.startswith('claude-'):
        os.makedirs(SLIM_DIR, exist_ok=True)
        settings = os.path.join(SLIM_DIR, 'settings.json')
        if not os.path.exists(settings):
            open(settings, 'w').write('{}\n')
        env['CLAUDE_CONFIG_DIR'] = SLIM_DIR
    return env


def run_child(job, backend, task, cwd, readonly, slim, timeout, resume_id):
    cmd = build_command(backend, task, readonly, resume_id)
    t0 = time.time()
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                       stdin=subprocess.DEVNULL, env=child_env(backend, slim))
    open(os.path.join(job, 'stderr.log'), 'w').write(p.stderr)
    wall = round(time.time() - t0, 1)
    raw_name = 'raw.json' if backend.startswith('claude-') else 'raw.jsonl'
    open(os.path.join(job, raw_name), 'w').write(p.stdout)
    meta, result = (parse_claude if backend.startswith('claude-') else parse_codex)(p.stdout)
    meta['model'] = meta.get('model') or routing_backends().get(backend, {}).get('model')
    meta.update(backend=backend, cwd=cwd, readonly=readonly, slim=slim, resumed_from=resume_id,
                exit_code=p.returncode, wall_s=wall,
                command=' '.join('"<task>"' if c == task else shlex.quote(c) for c in cmd),
                finished=time.strftime('%Y-%m-%dT%H:%M:%S'))
    open(os.path.join(job, 'result.md'), 'w').write(result or '(agent 没有返回文本；看 raw.* 与 stderr.log)\n')
    json.dump(meta, open(os.path.join(job, 'meta.json'), 'w'), ensure_ascii=False, indent=1)
    return p.returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--backend')
    ap.add_argument('--task')
    ap.add_argument('--cwd', default=os.getcwd())
    ap.add_argument('--readonly', action='store_true')
    ap.add_argument('--slim', action='store_true', help='claude-*：不加载全局 CLAUDE.md/记忆/skill，启动更快')
    ap.add_argument('--wait', action='store_true')
    ap.add_argument('--client', choices=['claude', 'codex'])
    ap.add_argument('--timeout', type=int, default=3600)
    ap.add_argument('--status')
    ap.add_argument('--resume', help='作业目录：在同一个 agent 会话里继续追问')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--_child', action='store_true', help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.list:
        return list_backends()
    if a.status:
        return status(a.status)
    if not a.task or not (a.backend or a.resume):
        ap.error('需要 --task，以及 --backend 或 --resume（或用 --status / --list）')
    task = open(a.task[1:], encoding='utf-8').read() if a.task.startswith('@') else a.task
    resume_id, backend = None, None
    if a.resume:
        prev = json.load(open(os.path.join(a.resume, 'meta.json')))
        backend, resume_id = prev['backend'], prev.get('session_id')
        if not resume_id:
            raise SystemExit('上一个作业没有记录会话 ID，无法续接')
        a.cwd = prev.get('cwd', a.cwd)
        a.slim = a.slim or bool(prev.get('slim'))  # the session lives in the same config dir
    client = a.client or detect_client()
    backend = backend or resolve_backend(a.backend, client)
    cwd = os.path.abspath(a.cwd)
    if a._child:
        return run_child(os.environ['SPAWN_JOB_DIR'], backend, task, cwd, a.readonly, a.slim, a.timeout, resume_id)
    job = os.path.join(STATE, time.strftime('%Y%m%d-%H%M%S') + '-' + backend)
    os.makedirs(job, exist_ok=True)
    open(os.path.join(job, 'task.md'), 'w', encoding='utf-8').write(task)
    if a.wait:
        code = run_child(job, backend, task, cwd, a.readonly, a.slim, a.timeout, resume_id)
        print(open(os.path.join(job, 'result.md'), encoding='utf-8').read())
        print(f'\n[作业目录 {job}，退出码 {code}]')
        return code
    child = [sys.executable, os.path.abspath(__file__), '--_child', '--backend', backend, '--task', '@' + os.path.join(job, 'task.md'),
             '--cwd', cwd, '--timeout', str(a.timeout)] + (['--readonly'] if a.readonly else []) + (['--slim'] if a.slim else []) \
            + (['--client', client] if client else []) + (['--resume', a.resume] if a.resume else [])
    subprocess.Popen(child, env={**os.environ, 'SPAWN_JOB_DIR': job}, start_new_session=True, stdin=subprocess.DEVNULL,
                     stdout=open(os.path.join(job, 'launcher.log'), 'w'), stderr=subprocess.STDOUT)
    print(f'已在后台启动 {backend}（{client or "手动指定"} 宿主），工作目录 {cwd}\n作业目录 {job}\n'
          f'查看：python3 {os.path.abspath(__file__)} --status {job}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
