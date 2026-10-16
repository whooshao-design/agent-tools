#!/usr/bin/env node
// mdview - 轻量 Markdown/HTML 查看器：本地 http 服务 + 浏览器渲染（含离线 mermaid）
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addComment, deleteComment, loadComments, runCli, setStatus, withLines } from './lib/comments.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, 'vendor');
const SHELL = () => fs.readFileSync(path.join(HERE, 'shell.html'));  // 每次读取，改完刷新页面即可生效
const SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.idea', '.venv', '__pycache__']);
const DOC = /\.(md|markdown|html?)$/i;

// mdview comments <文件> …：给 agent 读写评论，不起服务
if (process.argv[2] === 'comments') {
  try { process.exit(runCli(process.argv.slice(3))) }
  catch (e) { console.error(e.message); process.exit(1) }
}

let target = '.', port = 8321, open = true, fresh = false, idleMin = 0;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-p' || a === '--port') port = Number(argv[++i]);
  else if (a === '--no-open') open = false;
  else if (a === '--new') fresh = true;
  else if (a === '--idle') idleMin = Number(argv[++i]);
  else if (a === '-h' || a === '--help') {
    console.log('用法: mdview [文件或目录] [-p 端口] [--no-open] [--new] [--idle 分钟]\n      mdview comments <文件> [--all | --resolve <id> [--reply 文字] | --reopen <id>]');
    process.exit(0);
  } else target = a;
}

let stat;
try { stat = fs.statSync(path.resolve(target)); }
catch { console.error(`路径不存在: ${target}`); process.exit(1); }
const abs = path.resolve(target);
let ROOT = stat.isFile() ? path.dirname(abs) : abs;
let ENTRY = stat.isFile() ? path.relative(ROOT, abs) : '';

// 把相对路径夹在 root 内，越界返回 null
function safe(rel, root = ROOT) {
  const p = path.resolve(root, '.' + path.posix.sep + (rel || '').replace(/^\/+/, ''));
  return p === root || p.startsWith(root + path.sep) ? p : null;
}
// 切目录/浏览文件系统这类会越出 ROOT 的接口，只接受同源请求
const sameSite = (req) => {
  const s = req.headers['sec-fetch-site'];
  return !s || s === 'same-origin' || s === 'none';
};
const rel = (p, root = ROOT) => path.relative(root, p).split(path.sep).join('/');
const visible = (name) => !name.startsWith('.') && !SKIP.has(name);

async function ls(dir) {
  const dirs = [], files = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!visible(e.name)) continue;
    if (e.isDirectory()) dirs.push(e.name);
    else if (DOC.test(e.name)) files.push(e.name);
  }
  const cmp = (a, b) => a.localeCompare(b);
  return { dirs: dirs.sort(cmp), files: files.sort(cmp) };
}

// 全量递归，只在搜索时用
async function tree(root = ROOT, dir = root, depth = 0, out = []) {
  if (depth > 6 || out.length > 5000) return out;
  let ents = [];
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  ents.sort((a, b) => (a.isDirectory() - b.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of ents) {
    if (!visible(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await tree(root, full, depth + 1, out);
    else if (DOC.test(e.name)) out.push(rel(full, root));
  }
  return out;
}

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

let lastHit = Date.now();

// —— 导出到 Windows 侧并放进 Windows 剪贴板（供飞书「上传/粘贴文件」使用）——
const WIN = { profile: null };
const win2lin = (w) => '/mnt/' + w[0].toLowerCase() + w.slice(2).replace(/\\/g, '/');
// wslpath -w：/home/... → \\wsl.localhost\...，/mnt/c/... → C:\...
function toWinPath(p) {
  return new Promise((res) => execFile('/usr/bin/wslpath', ['-w', p], (e, so) => res(e ? '' : String(so).trim())));
}
function psRun(script) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((res) => execFile(
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { timeout: 20000 },
    (err, so, se) => res({ err, so: String(so || ''), se: String(se || '') })));
}
async function winProfile() {
  if (WIN.profile) return WIN.profile;
  const out = await new Promise((res) => execFile('/mnt/c/Windows/System32/cmd.exe',
    ['/c', 'echo %USERPROFILE%'], (e, so) => res(String(so || ''))));
  WIN.profile = out.trim().replace(/\r/g, '');
  return WIN.profile;
}

// 每个标签页自带 root（?root= 或 /file/<root>/ 前缀），服务端不再保存"当前目录"，多标签互不影响；
// 越出默认 ROOT 只对同源请求开放，规则与 /api/dirs 一致
async function checkRoot(req, value) {
  if (!value || !sameSite(req)) return ROOT;
  const p = path.resolve(value);
  const st = await fsp.stat(p).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`目录不存在: ${p}`);
  return p;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; if (data.length > limit) { reject(new Error('请求体过大')); req.destroy() } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  lastHit = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  const json = (o) => send(200, 'application/json', JSON.stringify(o));
  try {
    const root = await checkRoot(req, url.searchParams.get('root'));
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', SHELL());
    if (url.pathname === '/api/config') return json({ root: ROOT, entry: ENTRY, home: process.env.HOME });
    if (url.pathname === '/api/tree') return json(await tree(root));
    if (url.pathname === '/api/ls') {
      const p = safe(url.searchParams.get('p') || '', root);
      if (!p) return send(403, 'text/plain', 'forbidden');
      return json(await ls(p));
    }
    // 目录指纹：目录内新增/删除/改名文件会改变其 mtime
    if (url.pathname === '/api/dirstat') {
      const rels = url.searchParams.getAll('p').slice(0, 200);
      let stamp = '';
      for (const r of rels) {
        const q = safe(r, root);
        if (!q) { stamp += 'x,'; continue }
        try { stamp += Math.round((await fsp.stat(q)).mtimeMs) + ',' } catch { stamp += 'x,' }
      }
      return json({ stamp });
    }
    if (url.pathname === '/api/raw' || url.pathname === '/api/stat') {
      const p = safe(url.searchParams.get('p'), root);
      if (!p) return send(403, 'text/plain', 'forbidden');
      const st = await fsp.stat(p);
      if (url.pathname === '/api/stat') return json({ mtime: st.mtimeMs });
      return send(200, 'text/plain; charset=utf-8', await fsp.readFile(p));
    }
    // 以下两个接口会越出 ROOT，仅同源可用
    if (url.pathname === '/api/dirs') {
      if (!sameSite(req)) return send(403, 'text/plain', 'forbidden');
      const p = path.resolve(url.searchParams.get('p') || root);
      const ents = await fsp.readdir(p, { withFileTypes: true });
      const dirs = ents.filter((e) => e.isDirectory() && visible(e.name)).map((e) => e.name).sort((a, b) => a.localeCompare(b));
      return json({ path: p, parent: path.dirname(p), dirs });
    }
    if (url.pathname === '/api/chroot') {
      if (!sameSite(req)) return send(403, 'text/plain', 'forbidden');
      const p = path.resolve(url.searchParams.get('p') || '');
      const st = await fsp.stat(p);
      if (!st.isDirectory()) return send(400, 'text/plain', 'not a directory');
      return json({ root: p });   // 只校验，目录状态由各标签页自己带
    }
    // 导出文件到 Windows 并放进剪贴板
    if (url.pathname === '/api/winexport') {
      if (!sameSite(req)) return send(403, 'text/plain', 'forbidden');
      const p = safe(url.searchParams.get('p'), root);
      if (!p) return send(403, 'text/plain', 'forbidden');
      const profile = await winProfile();
      if (!/^[A-Za-z]:/.test(profile)) return json({ error: '拿不到 Windows 用户目录' });
      const winDir = profile + '\\Downloads\\mdview-export';
      const linDir = win2lin(winDir);
      await fsp.mkdir(linDir, { recursive: true });
      const base = path.basename(p).replace(/[\\/:*?"<>|]/g, '_');
      await fsp.copyFile(p, path.join(linDir, base));
      const winPath = (await toWinPath(path.join(linDir, base))) || (winDir + '\\' + base);
      const uncPath = await toWinPath(p);
      // 飞书的上传对话框只能贴路径文本，所以剪贴板放文本而不是文件对象
      const r = await psRun(`Set-Clipboard -Value '${winPath.replace(/'/g, "''")}'`);
      return json({ win: winPath, unc: uncPath, clipboard: !r.err });
    }
    if (url.pathname === '/api/edit') {
      if (!sameSite(req)) return send(403, 'text/plain', 'forbidden');
      const p = safe(url.searchParams.get('p'), root);
      if (!p || !fs.existsSync(p)) return send(403, 'text/plain', 'forbidden');
      return json(await openInCode(p));
    }
    // 评论：读对所有同源页面开放，写只接受同源 POST
    if (url.pathname === '/api/comments') {
      const p = safe(url.searchParams.get('p'), root);
      if (!p || !fs.existsSync(p)) return send(403, 'text/plain', 'forbidden');
      if (req.method === 'POST') {
        if (!sameSite(req)) return send(403, 'text/plain', 'forbidden');
        const body = JSON.parse((await readBody(req)) || '{}');
        const op = url.searchParams.get('op');
        if (op === 'add') addComment(p, body);
        else if (op === 'resolve' || op === 'reopen') setStatus(p, body.id, op === 'resolve' ? 'resolved' : 'open');
        else if (op === 'delete') deleteComment(p, body.id);
        else return send(400, 'text/plain', 'unknown op');
      }
      return json({ comments: withLines(p, loadComments(p)) });
    }
    if (url.pathname.startsWith('/vendor/')) {
      const f = path.join(VENDOR, path.basename(url.pathname));
      return send(200, MIME[path.extname(f).toLowerCase()] || 'text/javascript', await fsp.readFile(f));
    }
    if (url.pathname.startsWith('/file/')) {
      // /file/<encodeURIComponent(root)>/<rel>：root 作为路径前缀，iframe 里 html 的相对资源才能落在同一个 root 下
      const segs = url.pathname.slice(6).split('/');
      let fileRoot = root;
      if (segs[0] && decodeURIComponent(segs[0]).startsWith('/')) fileRoot = await checkRoot(req, decodeURIComponent(segs.shift()));
      const p = safe(decodeURIComponent(segs.join('/')), fileRoot);
      if (!p) return send(403, 'text/plain', 'forbidden');
      return send(200, MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', await fsp.readFile(p));
    }
    send(404, 'text/plain', 'not found');
  } catch (e) { send(404, 'text/plain; charset=utf-8', String(e.message || e)); }
});

function listen(p, tries = 20) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) listen(p + 1, tries - 1);
    else { console.error(e.message); process.exit(1); }
  });
  server.listen(p, '127.0.0.1', () => {
    const u = `http://127.0.0.1:${p}/` + (ENTRY ? '#/' + encodeURI(ENTRY) : '');
    console.log(`mdview  ${ROOT}\n        ${u}   (Ctrl+C 退出)`);
    if (open) browse(u);
  });
}

// 用 PowerShell Start-Process 打开默认浏览器：explorer.exe 遇到带查询参数的地址（复用实例时的 /?root=…）会直接失败，
// 浏览器根本不打开（2026-10-16 在 systemd 与交互 shell 下实测）。地址经 -EncodedCommand 传入，& ? # 不会被 shell 解析
async function browse(u) {
  const r = await psRun(`Start-Process '${u.replace(/'/g, "''")}'`);
  if (!r.err) return true;
  console.error(`打开浏览器失败（${String(r.se || r.err.message).trim().slice(0, 200)}），请手动打开：${u}`);
  return false;
}

// —— 用 VS Code（Remote-WSL）打开文件编辑 ——
// systemd 拉起的进程没有 WSL_DISTRO_NAME，code 启动脚本会因此走不到 Remote-WSL 分支；用 wslpath 反推发行版名补上
const CODE_CLI = '/mnt/d/Programs/Microsoft VS Code/bin/code';
async function openInCode(p) {
  if (!fs.existsSync(CODE_CLI)) return { error: `找不到 VS Code: ${CODE_CLI}` };
  const distro = process.env.WSL_DISTRO_NAME
    || ((await toWinPath('/')).match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/) || [])[1] || '';
  const env = { ...process.env, WSL_DISTRO_NAME: distro };
  return new Promise((res) => {
    const c = spawn(CODE_CLI, [p], { detached: true, stdio: 'ignore', env });
    const timer = setTimeout(() => res({ ok: true, distro, pending: true }), 8000);
    c.on('error', (e) => { clearTimeout(timer); res({ error: e.message }); });
    c.on('exit', (code) => { clearTimeout(timer); res(code === 0 ? { ok: true, distro } : { error: `code 退出码 ${code}` }); });
    c.unref();
  });
}

// 空闲自动退出（socket 激活模式下由 systemd 在下次访问时重新拉起）
function idleGuard() {
  if (!idleMin) return;
  setInterval(() => {
    if (Date.now() - lastHit > idleMin * 60000) {
      console.log(`空闲 ${idleMin} 分钟，退出`);
      process.exit(0);
    }
  }, 30000);
}

// 已有实例在跑就复用它：切到目标目录并打开浏览器，不再起第二个进程
async function reuse() {
  if (fresh) return false;
  const base = `http://127.0.0.1:${port}`;
  const dir = stat.isFile() ? path.dirname(abs) : abs;
  try {
    const r = await fetch(base + '/api/config', { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
  } catch { return false; }
  const u = base + '/?root=' + encodeURIComponent(dir) + (stat.isFile() ? '#/' + encodeURI(path.basename(abs)) : '');
  console.log(`复用运行中的 mdview  ${dir}\n        ${u}`);
  if (open) await browse(u);
  return true;
}

// systemd socket 激活：监听传进来的 fd 3
const SD = process.env.LISTEN_FDS === '1' && process.env.LISTEN_PID === String(process.pid);
if (SD) {
  server.listen({ fd: 3 }, () => {
    console.log(`mdview (socket 激活)  ${ROOT}  端口 ${server.address().port}`);
    idleGuard();
  });
} else if (await reuse()) {
  process.exit(0);
} else {
  idleGuard();
  listen(port);
}
