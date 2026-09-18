#!/usr/bin/env node
// Validate every ```mermaid block in a Markdown file under one or more mermaid versions,
// render each block to SVG/PNG, and write a results table.
//
// usage: node check_mermaid.js <markdown-file> <out-dir> [--versions 8.13.0,11]
//
// Defaults reuse the browser toolchain that get-browser-session already installs:
//   PW_PATH      ~/tools/lexiao-browser/node_modules/playwright
//   CHROME_PATH  ~/tools/lexiao-browser/browsers/chrome-linux64/chrome
//   RUNTIME_LIBS ~/tools/lexiao-browser/runtime-libs/usr/lib/x86_64-linux-gnu  (libasound etc.)
// mermaid itself is loaded from cdn.jsdelivr.net, so the run needs network access.
// Exit code: 0 all blocks ok, 2 at least one block failed, 1 fatal.
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();
const PW_PATH = process.env.PW_PATH || path.join(home, 'tools/lexiao-browser/node_modules/playwright');
const CHROME_PATH = process.env.CHROME_PATH || path.join(home, 'tools/lexiao-browser/browsers/chrome-linux64/chrome');
const RUNTIME_LIBS = process.env.RUNTIME_LIBS || path.join(home, 'tools/lexiao-browser/runtime-libs/usr/lib/x86_64-linux-gnu');

const args = process.argv.slice(2);
const vIdx = args.indexOf('--versions');
const versions = (vIdx >= 0 ? args.splice(vIdx, 2)[1] : '8.13.0,11').split(',').map((s) => s.trim());
const [mdFile, outDir] = args;
if (!mdFile || !outDir) { console.error('usage: node check_mermaid.js <markdown-file> <out-dir> [--versions 8.13.0,11]'); process.exit(1); }

const { chromium } = require(PW_PATH);
const md = fs.readFileSync(mdFile, 'utf8');
fs.mkdirSync(outDir, { recursive: true });

const blocks = [];
const lines = md.split('\n');
let heading = '(top)';
for (let i = 0; i < lines.length; i++) {
  const h = lines[i].match(/^#{1,6}\s+(.*)/);
  if (h) heading = h[1].trim();
  if (/^```mermaid\s*$/.test(lines[i])) {
    let j = i + 1; const buf = [];
    while (j < lines.length && !/^```/.test(lines[j])) buf.push(lines[j++]);
    blocks.push({ id: `D${blocks.length + 1}`, heading, line: i + 1, code: buf.join('\n') });
    i = j;
  }
}
if (!blocks.length) { console.log('no mermaid blocks'); fs.writeFileSync(path.join(outDir, 'results.md'), '无 mermaid 块\n'); process.exit(0); }

const modernTag = (ver) => `import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@${ver}/dist/mermaid.esm.min.mjs'; mermaid.initialize({startOnLoad:false, securityLevel:'loose'}); window.mermaid = mermaid;`;

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    env: { ...process.env, LD_LIBRARY_PATH: [RUNTIME_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
  });
  const results = {};
  for (const ver of versions) {
    const modern = parseInt(ver, 10) >= 10;
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1.5 });
    const load = async () => {
      if (modern) {
        await page.setContent('<html><body><div id="c"></div></body></html>');
        await page.addScriptTag({ type: 'module', content: modernTag(ver) });
      } else {
        await page.setContent(`<html><body><div id="c"></div><script src="https://cdn.jsdelivr.net/npm/mermaid@${ver}/dist/mermaid.min.js"></script></body></html>`, { waitUntil: 'load' });
      }
      await page.waitForFunction(() => window.mermaid, null, { timeout: 30000 });
    };
    await load();
    for (const b of blocks) {
      const r = await page.evaluate(async ({ id, code, modern }) => {
        try {
          if (modern) { await window.mermaid.parse(code); const { svg } = await window.mermaid.render('m' + id, code); return { status: 'ok', svg }; }
          window.mermaid.mermaidAPI.initialize({ startOnLoad: false, securityLevel: 'loose' }); window.mermaid.parse(code); return { status: 'ok' };
        } catch (e) { return { status: 'ERR: ' + String(e && (e.str || e.message || e)).split('\n')[0].slice(0, 100) }; }
      }, { id: b.id, code: b.code, modern });
      (results[b.id] ||= {})[ver] = r.status;
      if (r.svg) {
        fs.writeFileSync(path.join(outDir, `${b.id}.svg`), r.svg);
        fs.writeFileSync(path.join(outDir, `${b.id}.mmd`), b.code + '\n');
        await page.setContent(`<html><body style="margin:16px;background:#fff">${r.svg}</body></html>`);
        await page.screenshot({ path: path.join(outDir, `${b.id}.png`), fullPage: true });
        await load();
      }
    }
    await page.close();
  }
  await browser.close();

  const header = ['图', '所在标题', '行号', ...versions.map((v) => `mermaid ${v}`)];
  const rows = blocks.map((b) => [b.id, b.heading, String(b.line), ...versions.map((v) => results[b.id][v])]);
  const table = ['| ' + header.join(' | ') + ' |', '|' + header.map(() => '---').join('|') + '|', ...rows.map((r) => '| ' + r.join(' | ') + ' |')].join('\n');
  const bad = rows.filter((r) => r.slice(3).some((s) => s !== 'ok')).length;
  fs.writeFileSync(path.join(outDir, 'results.md'), `# mermaid 校验结果\n\n来源：\`${mdFile}\` · 时间：${new Date().toISOString()} · 通过 ${rows.length - bad}/${rows.length}\n\n${table}\n`);
  console.log(table);
  console.log(bad ? `\n${bad} 张图未通过，见 ${path.join(outDir, 'results.md')}` : `\n全部通过，SVG/PNG/mmd 在 ${outDir}`);
  process.exit(bad ? 2 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
