#!/usr/bin/env node
// check_solution_html.mjs — 用无头 Chromium 检查 render_solution.mjs 生成的 solution.html：
// 图、脚本错误、源文件指纹和 F1–F5 五项交互。只依赖模板结构（摘要与第 1～7 章、"变更"列、图类型），
// 不依赖某份方案特有的小节编号或节点名，任何按 solution-template.md 写的方案都能用。
// 先用 file:// 打开，再起一个只提供 /vendor/ 与 /file/ 两个路由的本机 http 服务模拟 mdview 打开一次，两次都检查。
//
// usage: node check_solution_html.mjs <solution.html> [--md <solution.md>]
//   --md 默认取同目录同名的 .md，用于比对图源码和指纹。
// 浏览器工具链与 check_mermaid.js 相同：PW_PATH / CHROME_PATH / RUNTIME_LIBS。
// 退出码：0 全部通过；1 任一项失败或无法运行。F4 未匹配的节点只列出，不算失败。

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_VENDOR } from './render_solution.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { extractMermaidBlocks } = require(path.join(here, 'check_mermaid.js'));
const home = os.homedir();
const PW_PATH = process.env.PW_PATH || path.join(home, 'tools/lexiao-browser/node_modules/playwright');
const CHROME_PATH = process.env.CHROME_PATH || path.join(home, 'tools/lexiao-browser/browsers/chrome-linux64/chrome');
const RUNTIME_LIBS = process.env.RUNTIME_LIBS || path.join(home, 'tools/lexiao-browser/runtime-libs/usr/lib/x86_64-linux-gnu');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const args = process.argv.slice(2);
const mIdx = args.indexOf('--md');
const mdArg = mIdx >= 0 ? args.splice(mIdx, 2)[1] : null;
const htmlFile = args[0] && path.resolve(args[0]);
if (!htmlFile) {
  console.error('usage: node check_solution_html.mjs <solution.html> [--md <solution.md>]');
  process.exit(1);
}
const mdFile = path.resolve(mdArg || htmlFile.replace(/\.html?$/, '.md'));

const results = [];
const record = (mode, id, pass, detail) => {
  results.push({ mode, id, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${mode}] ${id} — ${detail}`);
};
const wait = (page, ms) => page.waitForTimeout(ms);

// 等平滑滚动停下：先等 200ms 让滚动开始，再要 scrollY 连续 5 次（每次 100ms）不变
async function settle(page) {
  await wait(page, 200);
  let last = -1, same = 0;
  for (let i = 0; i < 50 && same < 5; i++) {
    const y = await page.evaluate(() => window.scrollY);
    same = y === last ? same + 1 : 0;
    last = y;
    await wait(page, 100);
  }
}

// 只提供 mdview 的两个路由：/vendor/<文件名> 取 vendor 目录，/file/<相对路径> 取 solution.html 所在目录
function serve(dir) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }   // 浏览器自发的请求，不是页面错误
    let file = null;
    if (p.startsWith('/vendor/')) file = path.join(DEFAULT_VENDOR, path.basename(p));
    else if (p.startsWith('/file/')) file = path.join(dir, path.normalize(p.slice(6)).replace(/^(\.\.[/\\])+/, ''));
    if (!file || !fs.existsSync(file)) {
      console.log(`  http 404 ${p}`);
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function checkPage(browser, url, mode, md, srcBlocks) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  const warnings = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await page.goto(url);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 60000 });

  // 图：全部渲染，源码与 Markdown 逐字相同
  const figs = await page.$$eval('figure.diagram', (els) => els.map((f) => ({
    id: f.id, kind: f.dataset.kind, failed: f.classList.contains('failed'),
    src: f.querySelector('pre.mermaid').textContent,
  })));
  const failed = figs.filter((f) => f.failed).map((f) => f.id);
  const differ = figs.filter((f, i) => f.src !== srcBlocks[i]).map((f) => f.id);
  record(mode, '图', !failed.length && !differ.length && figs.length === srcBlocks.length,
    `${figs.length}/${srcBlocks.length} 张；渲染失败 ${failed.join(',') || '无'}；源码不一致 ${differ.join(',') || '无'}`);

  // 指纹：页面由当前 solution.md 生成
  const expected = 'sha256-v1:' + crypto.createHash('sha256').update(md).digest('hex');
  const actual = await page.$eval('meta[name="source-sha256"]', (m) => m.content).catch(() => null);
  record(mode, '指纹', actual === expected, actual === expected ? '与 solution.md 一致' : `页面 ${actual}，当前 ${expected}；重新运行 render_solution.mjs`);

  // F1：三种阅读模式按模板章节号显示；第 3 章每个三级标题可折叠
  const f1 = await page.evaluate(() => {
    const secs = () => Array.from(document.querySelectorAll('section.sec'));
    const expect = (mode, s) => {
      const key = s.dataset.key, ch = s.dataset.chapter;
      if (key === 'header' || key === 'summary' || mode === 'full') return true;
      if (mode === 'summary') return false;
      if (['1', '2', '6', '7'].includes(ch)) return true;
      if (ch === '3') return s.dataset.level === '2' || !!s.closest('section[data-first-sub]');
      return false;
    };
    const wrong = {};
    for (const mode of ['summary', 'brief', 'full']) {
      window.__solution.setMode(mode);
      wrong[mode] = secs().filter((s) => s.hidden === expect(mode, s)).map((s) => s.id);
    }
    const ch3 = secs().filter((s) => s.dataset.level === '3' && s.dataset.chapter === '3');
    const missingFold = ch3.filter((s) => !s.querySelector(':scope > .sec-h > .fold')).map((s) => s.id);
    const extraFold = secs().filter((s) => !(s.dataset.level === '3' && s.dataset.chapter === '3') && s.querySelector(':scope > .sec-h > .fold')).map((s) => s.id);
    let foldWorks = true;
    if (ch3.length) {
      const btn = ch3[0].querySelector(':scope > .sec-h > .fold');
      btn.click();
      const body = Array.from(ch3[0].children).filter((c) => !c.classList.contains('sec-h'));
      foldWorks = ch3[0].classList.contains('folded') && body.every((c) => !c.checkVisibility());
      btn.click();
      foldWorks = foldWorks && !ch3[0].classList.contains('folded');
    }
    return { wrong, ch3: ch3.length, missingFold, extraFold, foldWorks };
  });
  const modeWrong = Object.entries(f1.wrong).filter(([, ids]) => ids.length);
  record(mode, 'F1', !modeWrong.length && !f1.missingFold.length && !f1.extraFold.length && f1.foldWorks,
    `显示与预期不符：${modeWrong.map(([m, ids]) => `${m} ${ids.join(',')}`).join('；') || '无'}；第 3 章 ${f1.ch3} 个三级标题，缺折叠按钮 ${f1.missingFold.join(',') || '无'}，多余按钮 ${f1.extraFold.join(',') || '无'}，折叠${f1.foldWorks ? '可用' : '失效'}`);

  // F2："变更"列每行都有标记；关闭某类后该类元素淡化、打开后恢复
  const f2 = await page.evaluate(async () => {
    // opacity 有 .25s 过渡：每 100ms 看一次，2 秒内达到即可
    const until = async (ok) => {
      for (const t0 = performance.now(); performance.now() - t0 < 2000; await new Promise((r) => setTimeout(r, 100))) if (ok()) return true;
      return ok();
    };
    const rows = Array.from(document.querySelectorAll('table[data-change-col] tbody tr'));
    const unmarked = rows.filter((r) => !r.dataset.change).map((r) => r.textContent.trim().slice(0, 30));
    const toggles = {};
    for (const kind of ['new', 'mod', 'keep']) {
      const els = Array.from(document.querySelectorAll(`[data-change="${kind}"]`));
      if (!els.length) continue;
      const box = document.querySelector(`.ctl.filters input[data-kind="${kind}"]`);
      box.click();
      const dimmed = await until(() => els.every((e) => Number(getComputedStyle(e).opacity) < 1));
      box.click();
      toggles[kind] = dimmed && await until(() => els.every((e) => Number(getComputedStyle(e).opacity) === 1));
    }
    return { tables: document.querySelectorAll('table[data-change-col]').length, rows: rows.length, unmarked, toggles };
  });
  const badToggles = Object.entries(f2.toggles).filter(([, ok]) => !ok).map(([k]) => k);
  record(mode, 'F2', !f2.unmarked.length && !badToggles.length,
    `${f2.tables} 张表 ${f2.rows} 行，未标记 ${f2.unmarked.length ? f2.unmarked.join(' | ') : '无'}；开关失效 ${badToggles.join(',') || '无'}`);

  // F3：每张时序图有分步控件；第 k 步时恰有 k 条消息完全可见，图后紧跟编号列表时列表第 k 项高亮
  const f3 = [];
  for (const f of figs.filter((x) => x.kind === 'sequence')) {
    const info = await page.evaluate((id) => {
      const fig = document.getElementById(id);
      return { controls: !!fig.querySelector('.steps') && typeof fig._act === 'function',
        texts: fig.querySelectorAll('text.messageText').length, declared: Number(fig.dataset.messages),
        list: !!document.querySelector(`ol[data-steps-for="${id}"]`) };
    }, f.id);
    if (!info.controls) { f3.push({ id: f.id, ok: false, why: '缺控件' }); continue; }
    if (!info.texts) {   // 没有消息的图：上一步、下一步应禁用，调用分步不能报错
      const z = await page.evaluate((id) => {
        const fig = document.getElementById(id);
        let err = null;
        try { fig._act('next'); fig._act('prev'); fig._act('all'); } catch (e) { err = String(e); }
        const steps = Array.from(fig.querySelectorAll('.steps button[data-act="prev"], .steps button[data-act="next"]'));
        return { err, disabled: steps.length === 2 && steps.every((b) => b.disabled) };
      }, f.id);
      f3.push({ id: f.id, ok: !z.err && z.disabled && info.declared === 0,
        why: z.err || `0 条消息（源码 ${info.declared}），上一步/下一步${z.disabled ? '已禁用' : '未禁用'}` });
      continue;
    }
    const bad = [];
    await page.click(`#${f.id} .steps button[data-act="all"]`);
    for (let k = 1; k <= info.texts; k++) {
      await page.click(`#${f.id} .steps button[data-act="next"]`);
      // 消息的 opacity 有 .25s 过渡：每 100ms 看一次，1.5 秒内到达第 k 步的状态即可
      const st = await page.evaluate(({ id, k }) => new Promise((resolve) => {
        const t0 = performance.now();
        const poll = () => {
          const fig = document.getElementById(id);
          const list = document.querySelector(`ol[data-steps-for="${id}"]`);
          const s = {
            visible: Array.from(fig.querySelectorAll('text.messageText')).filter((t) => getComputedStyle(t).opacity === '1').length,
            cur: list ? Array.from(list.children).findIndex((li) => li.classList.contains('step-current')) + 1 : 0,
            items: list ? list.children.length : 0,
          };
          if ((s.visible === k && (!list || k > s.items || s.cur === k)) || performance.now() - t0 > 1500) return resolve(s);
          setTimeout(poll, 100);
        };
        poll();
      }), { id: f.id, k });
      if (st.visible !== k || (info.list && k <= st.items && st.cur !== k)) bad.push(`第 ${k} 步可见 ${st.visible}${info.list ? '、列表高亮 ' + st.cur : ''}`);
    }
    await page.click(`#${f.id} .steps button[data-act="all"]`);
    f3.push({ id: f.id, ok: !bad.length && info.texts === info.declared,
      why: bad.join('；') || `${info.texts} 条消息（源码 ${info.declared}）${info.list ? '，带编号列表' : ''}` });
  }
  const countWarn = warnings.filter((w) => /条消息/.test(w));
  record(mode, 'F3', f3.every((s) => s.ok) && !countWarn.length,
    `${f3.length} 张时序图：${f3.map((s) => `${s.id} ${s.ok ? '通过' : '失败'}（${s.why}）`).join('；') || '无'}；消息数告警 ${countWarn.join(' | ') || '无'}`);

  // F4：有映射的节点点击后滚到对应表格行；未匹配的节点由 render_solution.mjs 列出，不算失败
  const flows = await page.evaluate(() => Array.from(document.querySelectorAll('table[data-impl-for]')).map((t) => ({
    id: t.dataset.implFor, links: JSON.parse(t.dataset.nodeLinks || '{}'),
    linked: (document.getElementById(t.dataset.implFor) || {})._linked || [],
  })));
  const jumpFail = [];
  let mapped = 0;
  for (const f of flows) {
    for (const [nodeId, row] of Object.entries(f.links)) {
      mapped++;
      const ok = await page.evaluate(({ id, nodeId, row }) => new Promise((resolve) => {
        const node = document.querySelector(`#${id} g.node.linkable[data-node-id="${CSS.escape(nodeId)}"]`);
        if (!node) return resolve(false);
        node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // 平滑滚动需要时间：每 100ms 看一次，行高亮期间（2 秒）进入视口即通过
        const t0 = performance.now();
        const poll = () => {
          const tr = document.querySelector('tr.flash');
          const r = tr && tr.getBoundingClientRect();
          if (tr && tr.dataset.name === row && r.top >= 0 && r.bottom <= window.innerHeight) return resolve(true);
          if (performance.now() - t0 > 1900) return resolve(false);
          setTimeout(poll, 100);
        };
        poll();
      }), { id: f.id, nodeId, row });
      if (!ok) jumpFail.push(`${f.id}:${nodeId}`);
    }
  }
  record(mode, 'F4', !jumpFail.length, `${flows.length} 张流程图有对照表，有映射的节点 ${mapped} 个；跳转失败 ${jumpFail.join(',') || '无'}`);

  // F5：目录覆盖全部二、三级标题；逐个点击二级标题，滚动停下后目录高亮的是该章
  const counts = await page.evaluate(() => ({
    toc: document.querySelectorAll('nav.toc li[data-for]').length,
    heads: document.querySelectorAll('section.sec[data-level="2"]:not([data-key="header"]), section.sec[data-level="3"]').length,
  }));
  const h2 = await page.$$eval('nav.toc li[data-level="2"]', (ls) => ls.map((l) => l.dataset.for));
  const wrongActive = [];
  for (const id of h2) {
    await page.click(`nav.toc li[data-for="${id}"] > a`);
    // 平滑滚动的开始时刻不固定：先等高亮切到该章（最多 3 秒），再等滚动停下后复核
    await page.waitForFunction((want) => {
      const li = document.querySelector('nav.toc li.active');
      return li && li.dataset.for === want;
    }, id, { timeout: 3000, polling: 100 }).catch(() => {});
    await settle(page);
    const active = await page.$eval('nav.toc li.active', (li) => li.dataset.for).catch(() => null);
    if (active !== id) wrongActive.push(`${id}→${active}`);
  }
  record(mode, 'F5', counts.toc === counts.heads && !wrongActive.length,
    `目录 ${counts.toc} 条，二、三级标题 ${counts.heads} 个；逐个点击 ${h2.length} 个二级标题，高亮不符 ${wrongActive.join(',') || '无'}`);

  record(mode, '脚本', !errors.length, errors.length ? errors.join(' | ').slice(0, 300) : '无 pageerror / console.error');
  await page.close();
}

async function main() {
  const md = fs.readFileSync(mdFile);
  const srcBlocks = extractMermaidBlocks(md.toString('utf8')).map((b) => b.code);
  const { chromium } = require(PW_PATH);
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    env: { ...process.env, LD_LIBRARY_PATH: [RUNTIME_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
  });
  const server = await serve(path.dirname(htmlFile));
  try {
    await checkPage(browser, pathToFileURL(htmlFile).href, 'file', md, srcBlocks);
    const url = `http://127.0.0.1:${server.address().port}/file/${encodeURIComponent(path.basename(htmlFile))}`;
    await checkPage(browser, url, 'http', md, srcBlocks);
  } finally {
    server.close();
    await browser.close();
  }
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
