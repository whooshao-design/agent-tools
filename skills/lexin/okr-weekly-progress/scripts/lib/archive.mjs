// 周报汇总文件：解析 KR 小节、转成乐空间可接受的 HTML、写入前的敏感信息扫描
// agent-tools bootstrap（模板 lib/agent_tools/bootstrap.mjs，lint 规则六校验逐字一致）
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
// probe 返回 'hit' | 'miss' | <异常码>：与 locate.py 同序先看 install.py（缺失即 miss），再看 skills/；用会抛错的 statSync，不用对一切错误都返回 false 的 existsSync
const probe = (d) => { if (!d) return 'miss'; try { const i = fs.statSync(path.join(d, 'install.py'), { throwIfNoEntry: false }); if (!i || !i.isFile()) return 'miss'; const s = fs.statSync(path.join(d, 'skills'), { throwIfNoEntry: false }); return s && s.isDirectory() ? 'hit' : 'miss'; } catch (e) { return e.code || 'error'; } };
const tried = []; let root = '', r = 'miss';
try { let d = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url))); tried.push(`上溯起点 ${d}`); while ((r = probe(d)) === 'miss' && path.dirname(d) !== d) d = path.dirname(d); if (r === 'hit') root = d; else tried[0] += r === 'miss' ? ' 未命中有效根（install.py 文件 + skills/ 目录）' : ` ${r}（放弃上溯）`; }
catch (e) { tried.push(`上溯起点 ${path.dirname(fileURLToPath(import.meta.url))} ${e.code || e.message}`); }
if (!root) { const v = process.env.AGENT_TOOLS_ROOT || ''; r = probe(v); tried.push(`AGENT_TOOLS_ROOT=${v || '<unset>'}${r === 'hit' || r === 'miss' ? '' : ' ' + r}`); if (r === 'hit') root = v; }
if (!root) { const p = path.join(os.homedir(), '.config/agent-tools/root'); try { const v = fs.readFileSync(p, 'utf8').trim(); r = probe(v); tried.push(`${p} = ${v}${r === 'hit' || r === 'miss' ? '' : ' ' + r}`); if (r === 'hit') root = v; } catch (e) { tried.push(`${p} ${e.code === 'ENOENT' ? '<absent>' : e.code}`); } }
if (!root) { console.error(['agent-tools: 未找到仓库根', ...tried, '请在仓库目录运行 python3 install.py'].join('\n')); process.exit(2); }
// agent-tools bootstrap end
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { repoRoot } = require(path.join(root, 'lib/agent_tools/locate.js'));
const { marked } = require(path.join(repoRoot(), 'tools/mdview/vendor/marked.min.js'));

export const SKIP_MARK = '本周已发布，默认跳过';
const KR_HEADING = /^O(\d+)-KR(\d+)\s+`(\d+)`\s*(.*)$/;
const META = /<!--\s*okr-weekly:\s*(\{.*?\})\s*-->/;

// 每个二级标题一个小节；只有 `O<i>-KR<j> \`<kr_id>\`` 形式的是可写的 KR 小节，其余（待归类、已排除……）永远不写
export function parseArchive(markdown) {
  const meta = (() => { const m = META.exec(markdown); try { return m ? JSON.parse(m[1]) : {} } catch { return {} } })();
  const sections = [];
  const parts = markdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const title = (nl < 0 ? part : part.slice(0, nl)).trim();
    const body = nl < 0 ? '' : part.slice(nl + 1);
    const m = KR_HEADING.exec(title);
    if (!m) { sections.push({ kind: 'other', title, body }); continue }
    const skipped = body.includes(SKIP_MARK);
    const content = body.split('\n').filter((line) => !line.includes(SKIP_MARK)).join('\n').trim();
    sections.push({ kind: 'kr', title, o: Number(m[1]), kr: Number(m[2]), krId: Number(m[3]), name: m[4].trim(), skipped, content });
  }
  return { meta, sections };
}

// 与乐空间前端的 js-xss 白名单一致的最小子集；其他标签去掉标签保留文字，属性只留表格对齐
const ALLOWED = new Set(['p', 'br', 'ol', 'ul', 'li', 'strong', 'em', 'code', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'h3', 'h4']);
// 已发布进展的展示页不给表格画线（编辑器会），边框只能写成内联 style
const TABLE_STYLE = {
  table: 'border-collapse: collapse;',
  th: 'border: 1px solid #ccc; padding: 4px 8px; background-color: #f5f5f5;',
  td: 'border: 1px solid #ccc; padding: 4px 8px;',
};
export function sanitizeHtml(html) {
  return html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g, (all, slash, tag, attrs) => {
    const name = tag.toLowerCase();
    if (!ALLOWED.has(name)) return '';
    if (slash) return `</${name}>`;
    const align = name === 'td' || name === 'th' ? /\balign="(left|right|center)"/.exec(attrs) : null;
    const style = TABLE_STYLE[name];
    return `<${name}${align ? ` align="${align[1]}"` : ''}${style ? ` style="${style}"` : ''}>`;
  });
}

export function markdownToHtml(markdown) {
  return sanitizeHtml(marked.parse(markdown, { gfm: true, breaks: false })).replace(/\n+/g, '');
}

// 只剩「本周工作/下周工作」标签和「本周无/无」的小节不写：否则会给原本没有草稿的 KR 生成一段空话
export function isEmptySection(content) {
  return !String(content || '').replace(/本周工作|下周工作|本周无|\d+[.)、]|[>#*\-\s。.、:：]|无/g, '').trim();
}

const INTERNAL_DOMAIN = /\b(?:[\w-]+\.)*(?:fenqile\.com|fenqile\.cn|lexin\.com|lexincloud\.com|lexinfintech\.com|fql\.com|dev-fql\.com|lexinrongdan\.com|kredito\.id)\b/gi;
const SENSITIVE = [
  ['IPv4 地址', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['内网域名', INTERNAL_DOMAIN],
  ['长数字或订单号', /\b[A-Z]{0,4}\d{12,}\b/g],
  ['用户标识', /\b(?:uid|user_?id|mid)\s*[:=：]?\s*\d{5,}\b/gi],
  ['凭据字样', /\b(?:token|secret|password|passwd|cookie|api[_-]?key)\s*[:=：]\s*\S+/gi],
  ['中文凭据字样', /(?:密码|口令|密钥|令牌)\s*(?:[:=：]|是|为)\s*\S+/g],
  ['Bearer 凭据', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g],
  ['疑似密钥', /\b[A-Za-z0-9_-]{32,}\b/g],
];
export function scanSensitive(text) {
  const hits = [];
  for (const [kind, re] of SENSITIVE) {
    for (const m of text.matchAll(re)) {
      if (kind === '疑似密钥' && /^[0-9a-f]{40}$/.test(m[0])) continue;  // 完整 commit SHA
      hits.push({ kind, value: m[0] });
    }
  }
  return hits;
}
