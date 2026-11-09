#!/usr/bin/env python3
"""Upload a SER migration XML to oss-fk (scenes=fe_hawkdecision) and print the FastDFS path.

TransferService#transfer reads its filePath from this file service. Credentials come from
web_mihawk_oa src/store/store.js `upload_config` (default block = online, stable block = stable);
they stay in this process and are never printed.

--env stable needs OSS_FK_STABLE_IP (env/credentials.env, loaded by bin/with-env).

Usage: python3 -I upload_transfer_file.py --env stable|online --file PACKAGE.xml [--name PACKAGE.txt]
"""
# agent-tools bootstrap（模板 lib/agent_tools/bootstrap.py）
import errno, os, stat, sys
from pathlib import Path
def _probe(d):  # 'hit' | 'miss' | 异常码：先看 install.py（缺失即 miss）再看 skills/，install.py 是普通文件且 skills/ 是目录才 hit；不存在与不是目录算 miss，其余 OSError 取 errno 名；不用遇错返回 False 的 os.path.isdir
    if not d: return 'miss'
    try: return 'hit' if stat.S_ISREG(os.stat(os.path.join(d, 'install.py')).st_mode) and stat.S_ISDIR(os.stat(os.path.join(d, 'skills')).st_mode) else 'miss'
    except (FileNotFoundError, NotADirectoryError): return 'miss'
    except OSError as e: return errno.errorcode.get(e.errno, 'error')
_tried, _root, _r = [], '', 'miss'
try:
    _d = str(Path(__file__).resolve().parent); _tried.append(f'上溯起点 {_d}')
    while (_r := _probe(_d)) == 'miss' and os.path.dirname(_d) != _d: _d = os.path.dirname(_d)
    if _r == 'hit': _root = _d
    else: _tried[0] += ' 未命中有效根（install.py 文件 + skills/ 目录）' if _r == 'miss' else f' {_r}（放弃上溯）'
except OSError as e: _tried.append(f'上溯起点 {__file__} {errno.errorcode.get(e.errno, e)}')
if not _root:
    _v = os.environ.get('AGENT_TOOLS_ROOT', ''); _r = _probe(_v)
    _tried.append(f"AGENT_TOOLS_ROOT={_v or '<unset>'}" + ('' if _r in ('hit', 'miss') else f' {_r}'))
    if _r == 'hit': _root = _v
if not _root:
    _p = Path.home() / '.config/agent-tools/root'
    try:
        _v = _p.read_text().strip(); _r = _probe(_v); _tried.append(f'{_p} = {_v}' + ('' if _r in ('hit', 'miss') else f' {_r}'))
        if _r == 'hit': _root = _v
    except OSError as e: _tried.append(f"{_p} {'<absent>' if e.errno == errno.ENOENT else errno.errorcode.get(e.errno, e)}")
if not _root:
    print('\n'.join(['agent-tools: 未找到仓库根', *_tried, '请在仓库目录运行 python3 install.py']), file=sys.stderr); sys.exit(2)
# agent-tools bootstrap end
sys.path.insert(0, os.path.join(_root, 'lib'))
from agent_tools.locate import workspace_root  # noqa: E402

import argparse
import json
import os
import re
import subprocess
import sys

STORE_JS = os.path.join(workspace_root(), 'frontend/web_mihawk_oa/src/store/store.js')
HOST = 'oss-fk.oa.fenqile.com'
URL = 'https://%s/upload?type=file&output_type=json&plusflag=1&scenes=fe_hawkdecision' % HOST


def credentials(env):
    src = open(STORE_JS, encoding='utf-8').read()
    start = src.index('upload_config(state)')
    block = src[start:src.index('return config', start)]
    stable_at = block.index("env_en === 'stable'")
    part = block[stable_at:] if env == 'stable' else block[:stable_at]
    appid = re.search(r"appId\s*:\s*['\"]([^'\"]+)", part).group(1)
    token = re.search(r"token\s*:\s*['\"]([^'\"]+)", part).group(1)
    return appid, token


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--env', required=True, choices=['stable', 'online'])
    p.add_argument('--file', required=True)
    p.add_argument('--name', help='uploaded filename, default: basename with .txt')
    a = p.parse_args()
    name = a.name or re.sub(r'\.[^./]*$', '', a.file.rsplit('/', 1)[-1]) + '.txt'
    # stable oss-fk shares the online hostname; only its internal address serves the stable store.
    stable_ip = os.environ.get('OSS_FK_STABLE_IP', '')
    if a.env == 'stable' and not stable_ip:
        print(json.dumps({'ok': False, 'env': a.env, 'error': 'OSS_FK_STABLE_IP is not set'}))
        return 2
    appid, token = credentials(a.env)
    # oss-fk is internal, so skip any proxy. Headers go through stdin to keep credentials out of argv.
    cmd = ['curl', '-sS', '--noproxy', '*', '--max-time', '60', '-K', '-',
           '-F', 'file=@%s;filename=%s;type=text/plain' % (a.file, name), URL]
    if a.env == 'stable':
        cmd[1:1] = ['--resolve', '%s:443:%s' % (HOST, stable_ip)]
    config = 'header = "appid: %s"\nheader = "token: %s"\n' % (appid, token)
    r = subprocess.run(cmd, input=config, capture_output=True, text=True)
    try:
        body = json.loads(r.stdout)
    except ValueError:
        print(json.dumps({'ok': False, 'env': a.env, 'error': (r.stderr or r.stdout)[:300]}, ensure_ascii=False))
        return 2
    ok = str(body.get('retcode')) == '0' and body.get('src')
    print(json.dumps({'ok': bool(ok), 'env': a.env, 'filePath': body.get('src'),
                      'retcode': body.get('retcode'), 'retmsg': body.get('retmsg')}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
