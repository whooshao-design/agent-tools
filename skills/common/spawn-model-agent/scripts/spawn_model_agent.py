#!/usr/bin/env python3
"""Spawn a separate agent process on a user-chosen backend (claude-<x> / codex-<x>) to run one task.

usage:
  spawn_model_agent.py --backend kimi --task "..." [--cwd DIR] [--readonly] [--wait] [--client claude|codex]
  spawn_model_agent.py --status JOB_DIR

Host detection: CLAUDECODE=1 -> claude wrappers; CODEX_* env or --client codex -> codex wrappers.
Permissions match an ordinary subagent of the host (read/write in --cwd); --readonly narrows to read-only.
"""
import argparse, json, os, re, shlex, subprocess, sys, time

STATE = os.path.expanduser(os.environ.get('SPAWN_MODEL_AGENT_HOME', '~/.local/state/spawn-model-agent'))
SHORT = ('qwen', 'deepseek', 'kimi', 'glm', 'minimax', 'doubao', 'vps')


def detect_client():
    if os.environ.get('CLAUDECODE') or os.environ.get('CLAUDE_CODE_ENTRYPOINT'):
        return 'claude'
    if any(k.startswith('CODEX_') for k in os.environ):
        return 'codex'
    return 'claude'


def resolve_backend(name, client):
    name = name.strip()
    if name.startswith(('claude-', 'codex-')):
        return name
    if name in SHORT:
        return f'{client}-{name}'
    raise SystemExit(f'未知后端 {name}；可用短名 {", ".join(SHORT)} 或完整包装器名 claude-<x> / codex-<x>')


def build_command(backend, task, readonly):
    """Return argv for the child process. Kept pure for tests."""
    if backend.startswith('claude-'):
        cmd = [backend, '-p', task, '--output-format', 'json', '--strict-mcp-config']
        if readonly:
            cmd += ['--tools', 'Read,Grep,Glob,WebSearch,WebFetch', '--allowedTools', 'Read,Grep,Glob,WebSearch,WebFetch']
        else:
            cmd += ['--dangerously-skip-permissions']
        return cmd
    # --search is a global codex flag (before the subcommand); the lexin gateway serves the web_search tool.
    cmd = [backend, '--search', 'exec', '--skip-git-repo-check', '--ephemeral', '--json',
           '-s', 'read-only' if readonly else 'workspace-write', '-c', 'approval_policy="never"', task]
    return cmd


def parse_claude(raw):
    try:
        d = json.loads(raw.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {}, ''
    mu = d.get('modelUsage') or {}
    model = next(iter(mu), None)
    u = mu.get(model, {}) if model else {}
    meta = {'model': model, 'subtype': d.get('subtype'), 'turns': d.get('num_turns'), 'duration_ms': d.get('duration_ms'),
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
    model = None
    for e in events:
        m = re.search(r'Model metadata for `([^`]+)`', str(e))
        if m:
            model = m.group(1); break
    meta = {'model': model, 'commands': len(cmds), 'input_tokens': usage.get('input_tokens'), 'output_tokens': usage.get('output_tokens')}
    return meta, msgs[-1] if msgs else ''


def status(job):
    meta_p = os.path.join(job, 'meta.json')
    if os.path.exists(meta_p):
        m = json.load(open(meta_p))
        print(f"状态: 完成  退出码 {m.get('exit_code')}  模型 {m.get('model')}  耗时 {m.get('wall_s')}s  token in/out {m.get('input_tokens')}/{m.get('output_tokens')}")
        print(f"结果: {os.path.join(job, 'result.md')}")
        return 0
    print('状态: 运行中或未开始（meta.json 尚未写出）；日志：', os.path.join(job, 'stderr.log'))
    return 3


def run_child(job, backend, task, cwd, readonly, timeout):
    cmd = build_command(backend, task, readonly)
    t0 = time.time()
    with open(os.path.join(job, 'stderr.log'), 'w') as err:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
        err.write(p.stderr)
    wall = round(time.time() - t0, 1)
    raw_name = 'raw.json' if backend.startswith('claude-') else 'raw.jsonl'
    open(os.path.join(job, raw_name), 'w').write(p.stdout)
    meta, result = (parse_claude if backend.startswith('claude-') else parse_codex)(p.stdout)
    meta.update(backend=backend, cwd=cwd, readonly=readonly, exit_code=p.returncode, wall_s=wall,
                command=' '.join(shlex.quote(c) if c != task else '"<task>"' for c in cmd),
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
    ap.add_argument('--wait', action='store_true')
    ap.add_argument('--client', choices=['claude', 'codex'])
    ap.add_argument('--timeout', type=int, default=3600)
    ap.add_argument('--status')
    ap.add_argument('--_child', action='store_true', help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.status:
        return status(a.status)
    if not (a.backend and a.task):
        ap.error('--backend 与 --task 必填（或用 --status）')
    task = open(a.task[1:], encoding='utf-8').read() if a.task.startswith('@') else a.task
    client = a.client or detect_client()
    backend = resolve_backend(a.backend, client)
    cwd = os.path.abspath(a.cwd)
    if a._child:
        job = os.environ['SPAWN_JOB_DIR']
        return run_child(job, backend, task, cwd, a.readonly, a.timeout)
    job = os.path.join(STATE, time.strftime('%Y%m%d-%H%M%S') + '-' + backend)
    os.makedirs(job, exist_ok=True)
    open(os.path.join(job, 'task.md'), 'w', encoding='utf-8').write(task)
    if a.wait:
        code = run_child(job, backend, task, cwd, a.readonly, a.timeout)
        print(open(os.path.join(job, 'result.md'), encoding='utf-8').read())
        print(f'\n[作业目录 {job}，退出码 {code}]')
        return code
    child = [sys.executable, os.path.abspath(__file__), '--_child', '--backend', backend, '--task', '@' + os.path.join(job, 'task.md'),
             '--cwd', cwd, '--client', client, '--timeout', str(a.timeout)] + (['--readonly'] if a.readonly else [])
    env = {**os.environ, 'SPAWN_JOB_DIR': job}
    subprocess.Popen(child, env=env, start_new_session=True, stdin=subprocess.DEVNULL,
                     stdout=open(os.path.join(job, 'launcher.log'), 'w'), stderr=subprocess.STDOUT)
    print(f'已在后台启动 {backend}（{client} 宿主），工作目录 {cwd}\n作业目录 {job}\n查看：python3 {os.path.abspath(__file__)} --status {job}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
