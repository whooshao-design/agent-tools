#!/usr/bin/env python3
"""按 JaCoCo XML 报告计算相对基线分支的改动行覆盖率。

只统计 `git diff -U0 <base>` 中 src/main/java 下新增或修改的可执行行（JaCoCo 有 ci/mi 记录的行），
输出逐文件命中、未覆盖行号与总计；--threshold 未达标时退出码为 1。
"""
import argparse
import collections
import re
import subprocess
import sys
import xml.etree.ElementTree as ET


def changed_lines(base, repo):
    diff = subprocess.run(['git', '-C', repo, 'diff', '-U0', base, '--', '*.java'],
                          capture_output=True, text=True, check=True).stdout
    changed = collections.defaultdict(set)
    current = None
    for line in diff.splitlines():
        if line.startswith('+++ '):
            path = line[6:] if line.startswith('+++ b/') else None
            current = path if path and '/src/main/java/' in path else None
        elif line.startswith('@@') and current:
            m = re.search(r'\+(\d+)(?:,(\d+))?', line)
            start, count = int(m.group(1)), int(m.group(2) or 1)
            changed[current].update(range(start, start + count))
    return changed


def line_coverage(report):
    # JaCoCo XML 自带 DOCTYPE，不解析外部实体
    root = ET.parse(report).getroot()
    cov = {}
    for pkg in root.iter('package'):
        for sf in pkg.iter('sourcefile'):
            key = pkg.get('name') + '/' + sf.get('name')
            cov[key] = {int(x.get('nr')): (int(x.get('ci')), int(x.get('mi'))) for x in sf.iter('line')}
    return cov


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--base', required=True, help='基线分支或提交，如 master、origin/master')
    ap.add_argument('--report', required=True, help='JaCoCo XML 报告')
    ap.add_argument('--repo', default='.', help='Git 仓库根目录')
    ap.add_argument('--threshold', type=float, default=None, help='改动行覆盖率门槛（百分比），如 90')
    args = ap.parse_args(argv)

    cov = line_coverage(args.report)
    total = hit_total = 0
    missing_data = []
    for path, lines in sorted(changed_lines(args.base, args.repo).items()):
        key = path.split('/src/main/java/')[1]
        if key not in cov:
            missing_data.append(path)
            continue
        c = cov[key]
        executable = [n for n in sorted(lines) if n in c and sum(c[n]) > 0]
        hit = [n for n in executable if c[n][0] > 0]
        miss = [n for n in executable if c[n][0] == 0]
        total += len(executable)
        hit_total += len(hit)
        if executable:
            print(f'{len(hit)}/{len(executable)} {key} miss={miss}')
    for path in missing_data:
        # 报告里没有这个类：通常是 --classfiles 漏了模块，或该模块不在统计范围内；不能当作已覆盖
        print(f'NO_DATA {path}')
    ratio = 100.0 * hit_total / total if total else 100.0
    print(f'TOTAL {hit_total}/{total} = {ratio:.1f}%')
    if missing_data:
        print('有改动文件不在报告里，结论不完整', file=sys.stderr)
        return 2
    if args.threshold is not None and ratio < args.threshold:
        print(f'改动行覆盖率 {ratio:.1f}% 低于 {args.threshold}%', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
