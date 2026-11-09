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
