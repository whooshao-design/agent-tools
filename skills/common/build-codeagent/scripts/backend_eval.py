#!/usr/bin/env python3
"""Run one backend (claude-<x> or codex-<x>) over an eval material directory and record a normalized result.

usage: python3 backend_eval.py --backend claude-qwen --material <dir> --prompt <prompt.md> --out <results dir> [--label run1] [--timeout 1200]

The material directory must contain only the files the model is allowed to read. The script:
- launches the backend read-only (claude: --tools Read,Grep,Glob --strict-mcp-config; codex: -s read-only, approval never, --ignore-user-config),
- captures raw output, wall time, token usage, write attempts and any change to the material directory,
- extracts the last JSON code block from the final message,
- writes <out>/<backend>[-<label>].json plus the raw stream next to it.
"""
import argparse, hashlib, json, os, re, subprocess, sys, time

def snapshot(d):
    s = {}
    for root, _, fs in os.walk(d):
        for f in fs:
            p = os.path.join(root, f)
            s[os.path.relpath(p, d)] = hashlib.sha256(open(p, 'rb').read()).hexdigest()
    return s

def last_json_block(text):
    blocks = re.findall(r'```json\s*(\{.*?\})\s*```', text, re.S)
    if not blocks:
        blocks = re.findall(r'(\{[\s\S]*\})', text)
    for b in reversed(blocks):
        try:
            return json.loads(b)
        except json.JSONDecodeError:
            continue
    return None

def run(cmd, cwd, timeout, stdin_null=False):
    t0 = time.time()
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                       stdin=subprocess.DEVNULL if stdin_null else None)
    return p, time.time() - t0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--backend', required=True)
    ap.add_argument('--material', required=True)
    ap.add_argument('--prompt', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--label', default='')
    ap.add_argument('--timeout', type=int, default=1200)
    ap.add_argument('--max-turns', type=int, default=20)
    a = ap.parse_args()
    prompt = open(a.prompt, encoding='utf-8').read()
    os.makedirs(a.out, exist_ok=True)
    name = a.backend + (f'-{a.label}' if a.label else '')
    before = snapshot(a.material)
    harness = 'claude' if a.backend.startswith('claude-') else 'codex'
    res = {'backend': a.backend, 'harness': harness, 'material': os.path.abspath(a.material), 'label': a.label,
           'started': time.strftime('%Y-%m-%dT%H:%M:%S')}
    if harness == 'claude':
        cmd = [a.backend, '-p', prompt, '--tools', 'Read,Grep,Glob', '--strict-mcp-config',
               '--allowedTools', 'Read,Grep,Glob', '--max-turns', str(a.max_turns), '--output-format', 'json']
        p, wall = run(cmd, a.material, a.timeout)
        raw = p.stdout
        open(os.path.join(a.out, name + '.raw.json'), 'w').write(raw)
        open(os.path.join(a.out, name + '.err'), 'w').write(p.stderr)
        try:
            d = json.loads(raw.strip().splitlines()[-1])
        except Exception as e:  # noqa: BLE001
            d = {}
            res['parse_error'] = str(e)
        mu = d.get('modelUsage') or {}
        model = next(iter(mu), None)
        u = mu.get(model, {}) if model else {}
        res.update(model=model, exit_code=p.returncode, subtype=d.get('subtype'), turns=d.get('num_turns'),
                   input_tokens=(u.get('inputTokens') or 0) + (u.get('cacheReadInputTokens') or 0) + (u.get('cacheCreationInputTokens') or 0),
                   output_tokens=u.get('outputTokens'), duration_ms=d.get('duration_ms'),
                   write_attempts=[x.get('tool_name') for x in d.get('permission_denials', []) if x.get('tool_name') in ('Write', 'Edit', 'Bash', 'NotebookEdit')],
                   final_text=d.get('result', ''))
    else:
        cmd = [a.backend, 'exec', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config',
               '-c', 'approval_policy="never"', '--json', prompt]
        p, wall = run(cmd, a.material, a.timeout, stdin_null=True)
        raw = p.stdout
        open(os.path.join(a.out, name + '.raw.jsonl'), 'w').write(raw)
        open(os.path.join(a.out, name + '.err'), 'w').write(p.stderr)
        events = []
        for line in raw.splitlines():
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        msgs = [e['item']['text'] for e in events if e.get('type') == 'item.completed' and e.get('item', {}).get('type') == 'agent_message']
        cmds = [e['item'] for e in events if e.get('type') in ('item.completed',) and e.get('item', {}).get('type') == 'command_execution']
        writes = [c['command'] for c in cmds if re.search(r'(^|[^<])>|\btee\b|\btouch\b|\bmkdir\b|\bcp\b|\bmv\b|\brm\b|\bsed -i\b', c.get('command', ''))]
        usage = next((e['usage'] for e in events if e.get('type') == 'turn.completed'), {})
        model = None
        for e in events:
            t = str(e)
            m = re.search(r'Model metadata for `([^`]+)`', t)
            if m:
                model = m.group(1); break
        res.update(model=model, exit_code=p.returncode, turns=len(cmds),
                   input_tokens=usage.get('input_tokens'), output_tokens=usage.get('output_tokens'),
                   duration_ms=int(wall * 1000), write_attempts=writes, final_text=msgs[-1] if msgs else '')
    res['wall_s'] = round(wall, 1)
    after = snapshot(a.material)
    res['material_changed'] = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
    parsed = last_json_block(res.get('final_text') or '')
    res['json_ok'] = parsed is not None
    res['parsed'] = parsed
    json.dump(res, open(os.path.join(a.out, name + '.json'), 'w'), ensure_ascii=False, indent=1)
    print(f"{name}: exit={res.get('exit_code')} wall={res['wall_s']}s in={res.get('input_tokens')} out={res.get('output_tokens')} json_ok={res['json_ok']} writes={len(res.get('write_attempts') or [])} changed={res['material_changed']}")

if __name__ == '__main__':
    sys.exit(main())
