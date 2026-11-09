// agent-tools bootstrap（模板 lib/agent_tools/bootstrap.js，lint 规则六校验逐字一致）
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
// probe 返回 'hit' | 'miss' | <异常码>：与 locate.py 同序先看 install.py（缺失即 miss），再看 skills/；用会抛错的 statSync，不用对一切错误都返回 false 的 existsSync
const probe = (d) => { if (!d) return 'miss'; try { const i = fs.statSync(path.join(d, 'install.py'), { throwIfNoEntry: false }); if (!i || !i.isFile()) return 'miss'; const s = fs.statSync(path.join(d, 'skills'), { throwIfNoEntry: false }); return s && s.isDirectory() ? 'hit' : 'miss'; } catch (e) { return e.code || 'error'; } };
const tried = []; let root = '', r = 'miss';
try { let d = fs.realpathSync(__dirname); tried.push(`上溯起点 ${d}`); while ((r = probe(d)) === 'miss' && path.dirname(d) !== d) d = path.dirname(d); if (r === 'hit') root = d; else tried[0] += r === 'miss' ? ' 未命中有效根（install.py 文件 + skills/ 目录）' : ` ${r}（放弃上溯）`; }
catch (e) { tried.push(`上溯起点 ${__dirname} ${e.code || e.message}`); }
if (!root) { const v = process.env.AGENT_TOOLS_ROOT || ''; r = probe(v); tried.push(`AGENT_TOOLS_ROOT=${v || '<unset>'}${r === 'hit' || r === 'miss' ? '' : ' ' + r}`); if (r === 'hit') root = v; }
if (!root) { const p = path.join(os.homedir(), '.config/agent-tools/root'); try { const v = fs.readFileSync(p, 'utf8').trim(); r = probe(v); tried.push(`${p} = ${v}${r === 'hit' || r === 'miss' ? '' : ' ' + r}`); if (r === 'hit') root = v; } catch (e) { tried.push(`${p} ${e.code === 'ENOENT' ? '<absent>' : e.code}`); } }
if (!root) { console.error(['agent-tools: 未找到仓库根', ...tried, '请在仓库目录运行 python3 install.py'].join('\n')); process.exit(2); }
// agent-tools bootstrap end
