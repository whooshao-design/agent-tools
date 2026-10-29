#!/usr/bin/env node
// render_solution.mjs — 把按 solution-template.md 写的 solution.md 渲染成带交互的单页 HTML。
//
// usage: node render_solution.mjs <solution.md> <out.html> [--vendor <dir>]
//
// 只用 Node 内置模块 + vendor/marked.min.js（Node 侧转 HTML）；mermaid、highlight.js 由浏览器从 vendor 加载，
// 不内联、不走 CDN：http 打开（mdview）时用 /vendor/<文件>，file:// 打开时用按输出位置算的相对路径。
// vendor 默认是本仓库 tools/mdview/vendor/，所以生成的页面只在本机能打开。
// 交互（F1 阅读模式、F2 变更筛选、F3 时序分步、F4 节点跳转、F5 粘性目录）全部从 solution-template.md 的结构推导。
// 唯一的指令是 `<!-- render: node-map 节点=行名; ... -->`：流程图节点（ID 或文字）与实现对照表第一列对不上时显式指定。
// F4 的节点匹配在这里完成，结果以"节点 ID → 行名"写进页面，渲染结束打印未匹配的节点；页面只按 SVG 元素 ID 挂点击。
// 页面写入 source-sha256，check_solution_html.mjs 与 review_round.py freeze 据此发现过期页面。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VENDOR = path.resolve(here, '../../../../tools/mdview/vendor');
const require = createRequire(import.meta.url);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => s.replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');

// ---------- 结构推导常量（来自 solution-template.md） ----------
const CHANGE_WORDS = { '新增': 'new', '修改': 'mod', '删除': 'del', '现有': 'keep' };
const CHANGE_COL = '变更';            // 2.4 变更总览表与第 3 章步骤表/对照表的"变更"列
const SUMMARY_HEADING = '摘要';       // 模板固定的无编号 h2

/** "变更"列单元格 → new/mod/del/keep；不以四个词开头时为空串。 */
export function changeOf(text) {
  const t = text.trim();
  for (const w of Object.keys(CHANGE_WORDS)) if (t.startsWith(w)) return CHANGE_WORDS[w];
  return '';
}

/** `<!-- render: ... -->` → {nodeMap} 或 {unknown}；不是 render 指令时返回 null。 */
export function parseDirective(raw) {
  const m = raw.match(/^\s*<!--\s*render:\s*([\s\S]*?)\s*-->\s*$/);
  if (!m) return null;
  const body = m[1].trim();
  const nm = body.match(/^node-map\s+([\s\S]+)$/);
  if (!nm) return { unknown: body };
  return {
    nodeMap: Object.fromEntries(nm[1].split(/[;；]/).map((s) => s.trim()).filter(Boolean).map((pair) => {
      const [k, v] = pair.split(/\s*=\s*/);
      return [k.trim(), (v || '').trim()];
    })),
  };
}

// 形状定界符，长的在前：A(((x)))、A((x))、A([x])、A[[x]]、A[(x)]、A{{x}}、A[/x/]、A[\x\]、A>x]、A[x]、A(x)、A{x}
const SHAPES = [['(((', ')))'], ['((', '))'], ['([', '])'], ['[[', ']]'], ['[(', ')]'], ['{{', '}}'],
  ['[/', '/]'], ['[\\', '\\]'], ['[/', '\\]'], ['[\\', '/]'], ['>', ']'], ['[', ']'], ['(', ')'], ['{', '}']];
const SKIP_LINE = /^\s*(%%|classDef\b|class\b|style\b|linkStyle\b|click\b|subgraph\b|end\b|direction\b|flowchart\b|graph\b)/;

/**
 * 从 flowchart 源码取带文字的节点：[{id, label}]，按首次定义的顺序。
 * 只写 ID 的节点没有可匹配的名称，不列出；边上的 |文字| 先去掉，避免把其中的括号当成节点。
 */
export function flowchartNodes(src) {
  const nodes = new Map();
  for (const raw of src.split('\n')) {
    if (SKIP_LINE.test(raw)) continue;
    const line = raw.replace(/\|[^|]*\|/g, ' ');
    const idRe = /([\p{L}\p{N}_]+)\s*(?=[[({>])/gu;   // mermaid 11 的节点 ID 可以是中文
    let m;
    while ((m = idRe.exec(line))) {
      const start = m.index + m[0].length;
      const shape = SHAPES.find(([open]) => line.startsWith(open, start));
      if (!shape) continue;
      const [open, close] = shape;
      let from = start + open.length, end, label;
      if (line[from] === '"') {
        const q = line.indexOf('"', from + 1);
        end = q < 0 ? -1 : line.indexOf(close, q + 1);
        label = q < 0 ? '' : line.slice(from + 1, q);
      } else {
        end = line.indexOf(close, from);
        label = end < 0 ? '' : line.slice(from, end);
      }
      if (end < 0) continue;
      idRe.lastIndex = end + close.length;   // 跳过文字，文字里的括号不再当节点
      label = label.replace(/<br\s*\/?>/gi, ' ').replace(/\*\*|`/g, '').trim();
      if (label && !nodes.has(m[1])) nodes.set(m[1], label);
    }
  }
  return Array.from(nodes, ([id, label]) => ({ id, label }));
}

// 消息行：<参与者><箭头>[+-]<参与者>: <文字>。参与者 ID 可以是中文，只排除空白和 mermaid 的分隔符
const MESSAGE_RE = /^\s*[^\s:;,+<>-][^:;,\n]*?\s*(<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\))\s*[+-]?[^\s:;,][^:;\n]*?\s*:/u;

/** 时序图源码里的消息条数，供页面核对渲染后的消息数；%% 开头的注释行 mermaid 不渲染，不计。 */
export function sequenceMessageCount(src) {
  return src.split('\n').filter((l) => !/^\s*%%/.test(l) && MESSAGE_RE.test(l)).length;
}

const norm = (s) => s.replace(/[\s,，、:：;；()（）"'“”`]/g, '').toLowerCase();
function bigrams(s) { const r = new Set(); for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2)); return r; }
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0; A.forEach((x) => { if (B.has(x)) hit++; });
  return 2 * hit / (A.size + B.size);
}

/**
 * 节点 → 对照表行名：node-map 指令（按节点 ID 或文字）> 完全相同 > 一方是另一方的子串 > 相邻字对 Dice >= 0.5。
 * 返回 {row, how}，匹配不到返回 null；指令指向不存在的行也返回 null。
 */
export function matchRow(node, rowNames, nodeMap) {
  const rows = rowNames.map((name) => ({ name, n: norm(name) }));
  const target = nodeMap ? (nodeMap[node.id] ?? nodeMap[node.label]) : undefined;
  if (target !== undefined) {
    const r = rows.find((x) => x.n === norm(target));
    return r ? { row: r.name, how: 'instruction' } : null;
  }
  const L = norm(node.label);
  let r = rows.find((x) => x.n === L);
  if (r) return { row: r.name, how: 'exact' };
  r = rows.find((x) => x.n.length >= 2 && L.length >= 2 && (L.includes(x.n) || x.n.includes(L)));
  if (r) return { row: r.name, how: 'substring' };
  let best = null, bestScore = 0;
  rows.forEach((x) => { const s = dice(L, x.n); if (s > bestScore) { bestScore = s; best = x; } });
  return best && bestScore >= 0.5 ? { row: best.name, how: 'similar(' + bestScore.toFixed(2) + ')' } : null;
}

function parseHeading(text) {
  const m = text.match(/^(\d+(?:\.\d+)*)\.?\s+(.*)$/);
  return m ? { num: m[1], rest: m[2] } : { num: '', rest: text };
}

/**
 * 把 Markdown 源转成页面正文。返回 {title, body, toc, stats, warnings, f4}：
 * f4 是每张带对照表的流程图的匹配结果 {figure, section, nodes, links, unmatched}。
 */
export function renderBody(md, vendorDir = DEFAULT_VENDOR) {
  const marked = require(path.join(vendorDir, 'marked.min.js'));
  marked.setOptions({ gfm: true, breaks: false });
  const inlineParser = new marked.Parser();
  const textRenderer = new marked.TextRenderer();
  const inline = (tokens) => inlineParser.parseInline(tokens || []);
  const plain = (tokens) => inlineParser.parseInline(tokens || [], textRenderer).replace(/\s+/g, ' ').trim();

  const out = [];
  const stack = [];            // 已打开的 section：{level}
  const toc = [];              // {level, id, text, num}
  const warnings = [];
  const f4 = [];
  let title = '';
  let section = '';            // 当前标题文字，用于 F4 报告
  let diagramSeq = 0;
  let pendingNodeMap = null;   // 最近一条 node-map 指令，挂到下一张对照表
  let lastFlowchart = null;    // 本 section 内最近的 flowchart：{id, nodes}，尚未绑定对照表
  let instructionLines = 0;
  const firstSubSeen = new Set();   // 已经出现过 h3 的章号

  function closeTo(level) {
    while (stack.length && stack[stack.length - 1].level >= level) {
      stack.pop();
      out.push('</section>');
    }
  }
  function openSection(level, attrs) {
    const a = Object.entries(attrs).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
    out.push(`<section class="sec" ${a}>`);
    stack.push({ level });
    lastFlowchart = null;
  }

  for (const tok of marked.lexer(md)) {
    if (tok.type === 'html') {
      const d = parseDirective(tok.raw);
      if (d) {
        instructionLines += tok.raw.trim().split('\n').length;
        if (d.nodeMap) pendingNodeMap = Object.assign(pendingNodeMap || {}, d.nodeMap);
        else warnings.push(`未知指令，已忽略：${d.unknown}`);
        continue;
      }
    }

    if (tok.type === 'heading') {
      const text = plain(tok.tokens);
      if (tok.depth === 1) {
        title = text;
        closeTo(2);
        openSection(2, { 'data-level': '2', 'data-key': 'header', 'data-chapter': '', id: 'sec-header' });
        out.push(`<h1 id="top">${inline(tok.tokens)}</h1>`);
        continue;
      }
      section = text;
      const { num } = parseHeading(text);
      const chapter = num ? num.split('.')[0] : '';
      const id = num ? `sec-${num.replace(/\./g, '-')}` : `sec-${slug(text)}`;
      const key = tok.depth === 2 ? (num ? `ch${num}` : (text === SUMMARY_HEADING ? 'summary' : slug(text))) : '';
      closeTo(tok.depth);
      const attrs = { 'data-level': String(tok.depth), 'data-num': num, 'data-chapter': chapter, id };
      if (key) attrs['data-key'] = key;
      if (tok.depth === 3 && chapter && !firstSubSeen.has(chapter)) { firstSubSeen.add(chapter); attrs['data-first-sub'] = '1'; }
      openSection(tok.depth, attrs);
      const fold = tok.depth === 3 ? '<button class="fold" type="button" aria-expanded="true" title="折叠/展开本小节">折叠</button>' : '';
      out.push(`<h${tok.depth} class="sec-h">${inline(tok.tokens)}${fold}</h${tok.depth}>`);
      if (tok.depth <= 3) toc.push({ level: tok.depth, id, text, num });
      continue;
    }

    if (tok.type === 'code' && /^mermaid\b/i.test(tok.lang || '')) {
      const src = tok.text;
      const first = (src.split('\n').find((l) => l.trim()) || '').trim();
      const kind = /^sequenceDiagram/.test(first) ? 'sequence' : /^(flowchart|graph)\b/.test(first) ? 'flowchart' : 'other';
      const id = `diagram-${++diagramSeq}`;
      const msgCount = kind === 'sequence' ? sequenceMessageCount(src) : 0;
      out.push(`<figure class="diagram" id="${id}" data-kind="${kind}"${kind === 'sequence' ? ` data-messages="${msgCount}"` : ''}>`);
      out.push(`<pre class="mermaid">${esc(src)}</pre>`);   // 原样保留源码，可取回
      out.push('<div class="diagram-svg" aria-busy="true"></div>');
      if (kind === 'sequence') {
        out.push('<div class="steps" role="group" aria-label="时序分步">'
          + '<button type="button" data-act="prev">上一步</button>'
          + '<button type="button" data-act="next">下一步</button>'
          + '<button type="button" data-act="all" aria-pressed="true">全部</button>'
          + '<span class="step-label">全部</span></div>');
      }
      out.push('</figure>');
      if (kind === 'flowchart') lastFlowchart = { id, nodes: flowchartNodes(src) };
      continue;
    }

    if (tok.type === 'table') {
      const headers = tok.header.map((h) => plain(h.tokens));
      const changeCol = headers.findIndex((h) => h === CHANGE_COL);
      const locCol = (() => {
        const i = headers.findIndex((h, idx) => idx > 0 && /实现|代码|位置/.test(h));
        return i >= 0 ? i : headers.length - 1;
      })();
      const impl = lastFlowchart;   // 同一小节内流程图之后的第一张表是它的实现对照表
      const tattrs = [];
      if (changeCol >= 0) tattrs.push('data-change-col="' + changeCol + '"');
      if (impl) {
        const names = tok.rows.map((row) => plain(row[0].tokens));
        const links = {}, unmatched = [];
        for (const node of impl.nodes) {
          const m = matchRow(node, names, pendingNodeMap);
          if (m) links[node.id] = m.row; else unmatched.push(node);
        }
        if (pendingNodeMap) {
          const known = new Set(impl.nodes.flatMap((n) => [n.id, n.label]));
          for (const k of Object.keys(pendingNodeMap)) if (!known.has(k)) warnings.push(`node-map 的节点 ${k} 不在 ${impl.id} 中，已忽略`);
        }
        f4.push({ figure: impl.id, section, nodes: impl.nodes.length, links, unmatched });
        tattrs.push(`data-impl-for="${impl.id}"`, `data-node-links="${esc(JSON.stringify(links))}"`);
        lastFlowchart = null;
        pendingNodeMap = null;
      }
      // "变更"列只有两个字，长文字列会把它挤成逐字竖排，所以这一列不换行
      const align = (i) => (tok.align[i] ? ` style="text-align:${tok.align[i]}"` : '') + (i === changeCol ? ' class="chg"' : '');
      let html = `<table ${tattrs.join(' ')}><thead><tr>`;
      html += tok.header.map((h, i) => `<th${align(i)}>${inline(h.tokens)}</th>`).join('');
      html += '</tr></thead><tbody>';
      for (const row of tok.rows) {
        const rattrs = [];
        if (changeCol >= 0) {
          const c = changeOf(plain(row[changeCol].tokens));
          if (c) rattrs.push(`data-change="${c}"`);
        }
        if (impl) {
          rattrs.push(`data-name="${esc(plain(row[0].tokens))}"`);
          rattrs.push(`data-loc="${esc(plain(row[locCol].tokens))}"`);
        }
        html += `<tr ${rattrs.join(' ')}>` + row.map((c, i) => `<td${align(i)}>${inline(c.tokens)}</td>`).join('') + '</tr>';
      }
      html += '</tbody></table>';
      out.push(html);
      continue;
    }

    out.push(marked.parser([tok]));
  }
  closeTo(0);
  if (pendingNodeMap) warnings.push('node-map 指令后面没有流程图对照表，已忽略');

  const body = out.join('\n');
  const stats = {
    sections: (body.match(/<section class="sec"/g) || []).length,
    diagrams: diagramSeq,
    changeTables: (body.match(/data-change-col=/g) || []).length,
    implTables: f4.length,
    instructionLines,
  };
  return { title, body, toc, stats, warnings, f4 };
}

const css = `
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--accent:#0969da;--flash:#fff3b0;--topbar:56px;--toc:260px;--dim:.25}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg)}
[hidden]{display:none !important}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
pre{background:#f6f8fa;padding:12px 14px;border-radius:6px;overflow:auto}
code:not(pre code){background:#f0f1f3;padding:1px 5px;border-radius:4px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
blockquote{margin:0 0 1em;padding:6px 14px;border-left:4px solid var(--line);color:var(--muted);background:#f6f8fa}
table{border-collapse:collapse;margin:1em 0;width:100%;font-size:.95em}
th,td{border:1px solid var(--line);padding:6px 10px;vertical-align:top;text-align:left}
th{background:#f6f8fa}
th.chg,td.chg{white-space:nowrap}
tr[data-change],g.node[data-change],.diagram-svg [data-change]{transition:opacity .25s}
.topbar{position:sticky;top:0;z-index:20;height:var(--topbar);display:flex;align-items:center;gap:18px;padding:0 20px;background:#fff;border-bottom:1px solid var(--line)}
.topbar .brand{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34vw}
.ctl{display:flex;align-items:center;gap:6px;white-space:nowrap}
.ctl .lab{color:var(--muted);font-size:.9em}
.ctl button,.steps button{font:inherit;font-size:.9em;padding:3px 10px;border:1px solid var(--line);background:#fff;border-radius:6px;cursor:pointer}
.ctl button[aria-pressed="true"],.steps button[aria-pressed="true"]{background:var(--accent);color:#fff;border-color:var(--accent)}
.ctl label{display:inline-flex;align-items:center;gap:4px;font-size:.9em;padding:2px 8px;border-radius:6px;border:1px solid var(--line);cursor:pointer;user-select:none}
.ctl label .sw{display:inline-block;width:10px;height:10px;border-radius:2px;border:1px solid #999}
.sw.new{background:#d9f2d9;border-color:#2e7d32}.sw.mod{background:#ffe9c7;border-color:#e08a00}.sw.keep{background:#eeeeee;border-color:#9e9e9e}
.layout{display:flex;align-items:flex-start}
.toc{position:sticky;top:var(--topbar);width:var(--toc);flex:0 0 var(--toc);max-height:calc(100vh - var(--topbar));overflow:auto;padding:14px 12px 30px 16px;border-right:1px solid var(--line);font-size:.88em}
.toc ul{list-style:none;margin:0;padding:0}
.toc li{margin:0}
.toc li[data-level="3"]{padding-left:14px}
.toc a{display:block;padding:3px 8px;border-radius:4px;color:var(--fg)}
.toc li.active>a{background:#ddf4ff;color:var(--accent);font-weight:600}
.toc .top{display:block;margin-bottom:8px;color:var(--muted)}
.doc{flex:1 1 auto;min-width:0;max-width:980px;padding:10px 40px 80px}
.doc::after{content:"";display:block;height:calc(100vh - var(--topbar))}   /* 最后一章再短也能滚到顶栏下，目录高亮才能到达它 */
h1{font-size:1.7em;margin:.6em 0 .5em}
h2{font-size:1.35em;margin:1.6em 0 .6em;padding-bottom:.25em;border-bottom:1px solid var(--line)}
h3{font-size:1.12em;margin:1.3em 0 .5em}
h4{font-size:1em;margin:1.1em 0 .4em}
h1,h2,h3,h4,section.sec{scroll-margin-top:calc(var(--topbar) + 14px)}   /* 目录锚点指向 section，也要让出顶栏 */
.sec-h .fold{float:right;font:inherit;font-size:.7em;font-weight:400;padding:1px 8px;margin-top:4px;border:1px solid var(--line);background:#fff;border-radius:4px;cursor:pointer;color:var(--muted)}
section.folded>:not(.sec-h){display:none}
section.folded>.sec-h{opacity:.75}
.diagram{margin:1.2em 0;padding:12px;border:1px solid var(--line);border-radius:6px}   /* 图和分步控件成一组，控件不贴边 */
.diagram pre.mermaid{display:none}
.diagram.failed pre.mermaid{display:block}
.diagram-svg{overflow:auto}
.diagram-svg svg{max-width:100%;height:auto}
.diagram-svg .err{color:#b42318;font-size:.9em}
.steps{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:.9em;color:var(--muted)}
.step-hidden{opacity:.12 !important}
.step-current.messageText{font-weight:700 !important;fill:#0b57d0 !important}   /* mermaid 用 #id 选择器注入样式，需要 !important 才能盖过 */
.step-current.messageLine0,.step-current.messageLine1{stroke-width:2.5px !important;stroke:#0b57d0 !important}
li.step-current{background:var(--flash);border-radius:4px}
body.hide-new [data-change="new"],body.hide-mod [data-change="mod"],body.hide-keep [data-change="keep"]{opacity:var(--dim)}
g.node.linkable{cursor:pointer}
g.node.linkable:hover .label-container{filter:drop-shadow(0 0 3px rgba(9,105,218,.8))}
tr.flash>td{background:var(--flash);transition:background .3s}
.node-tip{position:fixed;z-index:30;max-width:420px;padding:6px 10px;font-size:.85em;background:#1f2328;color:#fff;border-radius:6px;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.note{color:var(--muted);font-size:.85em}
@media (max-width:900px){.toc{display:none}.doc{padding:10px 16px 60px}.topbar{gap:10px;flex-wrap:wrap;height:auto;padding:8px 12px}}
`;

// 浏览器端脚本：以函数源码形式内嵌，避免在模板字符串里转义
function clientMain() {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const body = document.body;
  const api = {};
  window.__solution = api;

  // ---------- F1 阅读模式 ----------
  const MODE_CHAPTERS = { brief: ['1', '2', '6', '7'] };   // 5 分钟 = 摘要 + 1 + 2 + 3 的第一个小节 + 6 + 7
  const BRIEF_FIRST_SUB_CHAPTERS = ['3'];
  function visibleIn(mode, sec) {
    const key = sec.dataset.key, ch = sec.dataset.chapter;
    if (key === 'header' || key === 'summary') return true;
    if (mode === 'full') return true;
    if (mode === 'summary') return false;
    if (MODE_CHAPTERS.brief.includes(ch)) return true;
    if (BRIEF_FIRST_SUB_CHAPTERS.includes(ch)) {
      if (sec.dataset.level === '2') return true;
      return !!sec.closest('section[data-first-sub]');
    }
    return false;
  }
  let mode = 'full';
  function setMode(m) {
    mode = m;
    $$('section.sec').forEach((sec) => { sec.hidden = !visibleIn(m, sec); });
    $$('.toc li[data-for]').forEach((li) => { const sec = document.getElementById(li.dataset.for); li.hidden = !sec || sec.hidden; });
    $$('.ctl.modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    body.dataset.mode = m;
    spy();
  }
  api.setMode = setMode;
  $$('.ctl.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  // 折叠：第 3 章（详细设计）每个 h3 小节
  $$('section.sec[data-level="3"]').forEach((sec) => {
    const btn = $(':scope > .sec-h > .fold', sec);
    if (!btn) return;
    if (sec.dataset.chapter !== '3') { btn.remove(); return; }
    btn.addEventListener('click', () => {
      const folded = sec.classList.toggle('folded');
      btn.setAttribute('aria-expanded', String(!folded));
      btn.textContent = folded ? '展开' : '折叠';
    });
  });

  // ---------- F2 变更筛选 ----------
  const filter = { new: true, mod: true, keep: true };
  function setFilter(kind, on) {
    filter[kind] = on;
    body.classList.toggle('hide-' + kind, !on);
    const cb = $('.ctl.filters input[data-kind="' + kind + '"]');
    if (cb) cb.checked = on;
  }
  api.setFilter = setFilter;
  $$('.ctl.filters input').forEach((cb) => cb.addEventListener('change', () => setFilter(cb.dataset.kind, cb.checked)));

  // ---------- F5 粘性目录 ----------
  const tocItems = $$('.toc li[data-for]');
  let spyTicking = false;
  function spy() {
    spyTicking = false;
    const limit = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--topbar'), 10) + 30;
    let current = null;
    for (const li of tocItems) {
      if (li.hidden) continue;
      const sec = document.getElementById(li.dataset.for);
      const h = sec && sec.querySelector(':scope > .sec-h');
      if (!h) continue;
      if (h.getBoundingClientRect().top <= limit) current = li; else break;
    }
    if (!current && !$('.toc li.active') && tocItems.length) current = null;
    tocItems.forEach((li) => li.classList.toggle('active', li === current));
    if (current) {
      const r = current.getBoundingClientRect(), tr = $('.toc').getBoundingClientRect();
      if (r.top < tr.top || r.bottom > tr.bottom) current.scrollIntoView({ block: 'nearest' });
    }
  }
  window.addEventListener('scroll', () => { if (!spyTicking) { spyTicking = true; requestAnimationFrame(spy); } }, { passive: true });
  window.addEventListener('resize', spy);
  $('.toc a.top').addEventListener('click', (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

  // ---------- mermaid 渲染 + F3 / F4 ----------
  const tip = $('.node-tip');
  function showTip(text, x, y) {
    tip.textContent = text;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(x + 14, window.innerWidth - w - 8) + 'px';
    tip.style.top = (y + 18 + h > window.innerHeight ? y - h - 10 : y + 18) + 'px';
  }
  function hideTip() { tip.hidden = true; }

  function changeOfText(t) {
    t = t.trim();
    if (t.startsWith('【新增】')) return 'new';
    if (t.startsWith('【修改】')) return 'mod';
    if (t.startsWith('【删除】')) return 'del';
    return 'keep';
  }

  function postSequence(fig, svg) {
    // mermaid 11 按源码顺序把每条消息画成相邻的兄弟元素：text.messageText, line/path.messageLine0|1, line, text.sequenceNumber
    const groups = [];
    let cur = null;
    for (const el of Array.from(svg.children)) {
      const cls = el.getAttribute('class') || '';
      const tag = el.tagName.toLowerCase();
      if (tag === 'text' && /\bmessageText\b/.test(cls)) { cur = { text: el, els: [el] }; groups.push(cur); continue; }
      if (cur && ((tag === 'line' || tag === 'path') || (tag === 'text' && /\bsequenceNumber\b/.test(cls)))) { cur.els.push(el); continue; }
      cur = null;
    }
    groups.forEach((g) => { const c = changeOfText(g.text.textContent); g.els.forEach((e) => e.setAttribute('data-change', c)); });
    fig._msgs = groups;
    const n = groups.length;
    const declared = parseInt(fig.dataset.messages || '0', 10);
    if (declared && declared !== n) console.warn(fig.id + ': 源码解析到 ' + declared + ' 条消息，渲染后找到 ' + n + ' 条，以渲染结果为准');
    const next = fig.nextElementSibling;
    const list = next && next.tagName === 'OL' ? next : null;
    if (list) list.dataset.stepsFor = fig.id;
    let step = null;   // null = 全部
    const label = $('.step-label', fig);
    function apply() {
      groups.forEach((g, i) => {
        const hidden = step !== null && i >= step;
        const current = step !== null && i === step - 1;
        g.els.forEach((e) => { e.classList.toggle('step-hidden', hidden); e.classList.toggle('step-current', current); });
      });
      if (list) Array.from(list.children).forEach((li, i) => li.classList.toggle('step-current', step !== null && i === step - 1));
      label.textContent = step === null ? '全部（' + n + ' 条消息）' : '第 ' + step + ' / ' + n + ' 步：' + groups[step - 1].text.textContent.trim();
      $$('.steps button', fig).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.act === 'all' && step === null)));
    }
    function act(a) {
      if (!n) return;   // 图里没有消息（只有参与者或注释）时没有可分的步
      if (a === 'all') step = null;
      else if (a === 'next') step = step === null ? 1 : Math.min(n, step + 1);
      else if (a === 'prev') step = step === null ? n : Math.max(1, step - 1);
      apply();
    }
    fig._act = act;
    if (!n) $$('.steps button[data-act="prev"], .steps button[data-act="next"]', fig).forEach((b) => { b.disabled = true; });
    $$('.steps button', fig).forEach((b) => b.addEventListener('click', () => act(b.dataset.act)));
    apply();
  }

  function postFlowchart(fig, svg) {
    const nodes = $$('g.node', svg);
    nodes.forEach((node) => {
      const c = ['new', 'mod', 'keep', 'del'].find((k) => node.classList.contains(k));
      if (c) node.setAttribute('data-change', c);
    });
    const table = $('table[data-impl-for="' + fig.id + '"]');
    if (!table) return;
    // 节点 ID → 行名由 render_solution.mjs 算好；这里只按 mermaid 11 节点元素 ID 里的 flowchart-<节点ID>-<序号> 挂点击
    const links = JSON.parse(table.dataset.nodeLinks || '{}');
    const rows = new Map($$('tbody tr[data-name]', table).map((tr) => [tr.dataset.name, tr]));
    const linked = [];
    nodes.forEach((node) => {
      const m = (node.id || '').match(/flowchart-(.+)-\d+$/);
      const tr = m && rows.get(links[m[1]]);
      if (!tr) return;
      linked.push(m[1]);
      node.classList.add('linkable');
      node.dataset.nodeId = m[1];
      node.setAttribute('tabindex', '0');
      node.setAttribute('role', 'link');
      const tipText = tr.dataset.name + ' → ' + tr.dataset.loc;
      node.addEventListener('mouseenter', (e) => showTip(tipText, e.clientX, e.clientY));
      node.addEventListener('mousemove', (e) => showTip(tipText, e.clientX, e.clientY));
      node.addEventListener('mouseleave', hideTip);
      const go = () => {
        let p = tr.parentElement;
        while (p) { if (p.classList && p.classList.contains('folded')) { p.classList.remove('folded'); const b = $(':scope > .sec-h > .fold', p); if (b) { b.textContent = '折叠'; b.setAttribute('aria-expanded', 'true'); } } p = p.parentElement; }
        tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
        $$('tr.flash').forEach((t) => t.classList.remove('flash'));
        tr.classList.add('flash');
        clearTimeout(tr._flashTimer);
        tr._flashTimer = setTimeout(() => tr.classList.remove('flash'), 2000);
      };
      node.addEventListener('click', go);
      node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    const missing = Object.keys(links).filter((id) => !linked.includes(id));
    if (missing.length) console.warn(fig.id + ': 对照表映射的节点在 SVG 中找不到：' + missing.join(','));
    fig._linked = linked;
  }

  async function renderDiagrams() {
    if (!window.mermaid) { $$('.diagram').forEach((f) => f.classList.add('failed')); return; }
    mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
    for (const fig of $$('figure.diagram')) {
      const src = $('pre.mermaid', fig).textContent;
      const box = $('.diagram-svg', fig);
      try {
        const { svg } = await mermaid.render(fig.id + '-svg', src);
        box.innerHTML = svg;
        const el = $('svg', box);
        if (fig.dataset.kind === 'sequence') postSequence(fig, el);
        else if (fig.dataset.kind === 'flowchart') postFlowchart(fig, el);
      } catch (e) {
        fig.classList.add('failed');
        box.innerHTML = '<p class="err">mermaid 渲染失败：' + String(e && e.message || e).replace(/</g, '&lt;') + '</p>';
      }
      box.removeAttribute('aria-busy');
    }
  }
  api.step = (figId, action) => { const f = document.getElementById(figId); if (f && f._act) f._act(action); };

  if (window.hljs) $$('pre code[class*="language-"]').forEach((c) => { try { hljs.highlightElement(c); } catch (e) { /* 忽略 */ } });
  setMode('full');
  api.ready = renderDiagrams().then(() => { body.dataset.ready = '1'; spy(); });
}

/** 整页 HTML；outDir 是页面所在目录，用来算 file:// 打开时到 vendor 的相对路径。 */
export function renderPage(md, { vendorDir = DEFAULT_VENDOR, outDir = '.' } = {}) {
  const r = renderBody(md, vendorDir);
  const sourceSha = 'sha256-v1:' + crypto.createHash('sha256').update(md).digest('hex');
  const sourceVersion = (md.match(/版本[：:]\s*(v?\d+(?:\.\d+)*)/) || [])[1] || 'unversioned';
  const vendorRel = path.relative(path.resolve(outDir), vendorDir).split(path.sep).join('/') || '.';
  const tocHtml = r.toc.map((t) => `<li data-level="${t.level}" data-for="${t.id}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('');
  // mdview 只按 /vendor/<文件名> 提供 vendor，iframe 里的相对路径会越出它的根目录，所以 http 下用绝对路径
  const loader = `(function () {
  var base = location.protocol === 'file:' ? ${JSON.stringify(vendorRel)} : '/vendor';
  var css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = base + '/hljs.css';
  document.head.appendChild(css);
  function load(f) {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = base + '/' + f;
      s.onload = resolve;
      s.onerror = function () { console.error('vendor 加载失败：' + s.src); resolve(); };
      document.head.appendChild(s);
    });
  }
  Promise.all([load('mermaid.min.js'), load('highlight.min.js')]).then(${clientMain.toString()});
})();`;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="source-sha256" content="${sourceSha}">
<meta name="source-version" content="${esc(sourceVersion)}">
<title>${esc(r.title || 'solution')}</title>
<style>${css}</style>
</head>
<body data-mode="full">
<header class="topbar">
  <span class="brand" title="${esc(r.title)}">${esc(r.title)}</span>
  <div class="ctl modes" role="group" aria-label="阅读模式"><span class="lab">阅读</span>
    <button type="button" data-mode="summary">摘要</button>
    <button type="button" data-mode="brief">5 分钟</button>
    <button type="button" data-mode="full" aria-pressed="true">全文</button>
  </div>
  <div class="ctl filters" role="group" aria-label="变更筛选"><span class="lab">显示</span>
    <label><input type="checkbox" data-kind="new" checked><span class="sw new"></span>新增</label>
    <label><input type="checkbox" data-kind="mod" checked><span class="sw mod"></span>修改</label>
    <label><input type="checkbox" data-kind="keep" checked><span class="sw keep"></span>现有</label>
  </div>
</header>
<div class="layout">
<nav class="toc" aria-label="目录"><a class="top" href="#top">↑ 回到顶部</a><ul>${tocHtml}</ul></nav>
<main class="doc">
${r.body}
</main>
</div>
<div class="node-tip" role="tooltip" hidden></div>
<script>${loader}</script>
</body>
</html>
`;
  return { ...r, html };
}

function main() {
  const args = process.argv.slice(2);
  const vIdx = args.indexOf('--vendor');
  const vendorDir = vIdx >= 0 ? path.resolve(args.splice(vIdx, 2)[1]) : DEFAULT_VENDOR;
  const [inFile, outFile] = args;
  if (!inFile || !outFile) {
    console.error('usage: node render_solution.mjs <solution.md> <out.html> [--vendor <dir>]');
    process.exit(1);
  }
  const outDir = path.dirname(path.resolve(outFile));
  const r = renderPage(fs.readFileSync(inFile, 'utf8'), { vendorDir, outDir });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, r.html);
  console.log(`${outFile}: ${JSON.stringify(r.stats)}`);
  for (const f of r.f4) {
    const n = Object.keys(f.links).length;
    console.log(`F4 ${f.figure}（${f.section}）：节点匹配 ${n}/${f.nodes}`);
    if (f.unmatched.length) {
      console.log(`  未匹配（可改节点名或加 <!-- render: node-map 节点=行名 -->）：${f.unmatched.map((u) => `${u.id} ${u.label}`).join('、')}`);
    }
  }
  for (const w of r.warnings) console.warn('warn: ' + w);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
