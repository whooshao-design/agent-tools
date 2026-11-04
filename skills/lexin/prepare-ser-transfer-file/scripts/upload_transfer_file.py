#!/usr/bin/env python3
"""Upload a SER migration XML to oss-fk (scenes=fe_hawkdecision) and print the FastDFS path.

TransferService#transfer reads its filePath from this file service. Credentials come from
web_mihawk_oa src/store/store.js `upload_config` (default block = online, stable block = stable);
they stay in this process and are never printed.

--env stable needs OSS_FK_STABLE_IP (env/credentials.env, loaded by bin/with-env).

Usage: python3 -I upload_transfer_file.py --env stable|online --file PACKAGE.xml [--name PACKAGE.txt]
"""
import argparse
import json
import os
import re
import subprocess
import sys

STORE_JS = '/home/joney/projects/frontend/web_mihawk_oa/src/store/store.js'
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
