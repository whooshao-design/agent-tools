// 定时段的确定性取数：飞书周报、本机会话、git 提交、需求文档阶段日期、乐空间 OKR。任一来源失败只标注，不中断其他来源。
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
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { skillDir, docsRoot, workspaceRoot } = require(path.join(root, 'lib/agent_tools/locate.js'));
const FEISHU = skillDir('manage-feishu-doc', 'scripts', 'feishu_doc.mjs');
const SESSIONS = skillDir('recall-agent-sessions', 'scripts', 'agent_sessions.py');
const CN_OFFSET_MS = 8 * 3600 * 1000;  // 北京时间无夏令时

// 本周一 00:00（北京时间）到 now
export function weekWindow(now = new Date()) {
  const local = new Date(now.getTime() + CN_OFFSET_MS);
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  const mondayLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysSinceMonday);
  return { start: new Date(mondayLocal - CN_OFFSET_MS), end: now };
}

export function cnDate(date) {
  return new Date(date.getTime() + CN_OFFSET_MS).toISOString().slice(0, 10);
}

// 「周工作汇报 2026年10月16日」→ 2026-10-16；同一时间窗内多于一份视为歧义，不猜
export function pickWeeklyReport(files, window) {
  const lo = cnDate(window.start), hi = cnDate(window.end);
  const dated = files.map((f) => {
    const m = /周工作汇报\s*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(f.name || '');
    return m ? { ...f, date: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` } : null;
  }).filter((f) => f && f.date >= lo && f.date <= hi);
  if (dated.length === 0) return { status: 'missing', candidates: [] };
  if (dated.length > 1) return { status: 'ambiguous', candidates: dated };
  return { status: 'ok', report: dated[0] };
}

export function overlaps(record, window) {
  const start = Date.parse(record.start), end = Date.parse(record.end || record.start);
  return !Number.isNaN(start) && end >= window.start.getTime() && start <= window.end.getTime();
}

function runJson(cmd, args, opts = {}) {
  return JSON.parse(execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000, ...opts }));
}

// 子进程非零退出时，manage-feishu-doc 会把 permission_required 等结构化结果打印在 stdout；保留它，授权指引才能传到周报里
export function guard(fn) {
  try { return fn() } catch (e) {
    let structured = null;
    try { structured = JSON.parse(String(e.stdout || '')) } catch { /* 非 JSON 输出 */ }
    if (structured && typeof structured === 'object') {
      return { status: 'error', error: structured.message || structured.status || 'command failed', failureClass: structured.failureClass, nextAction: structured.nextAction, missingScopes: structured.missingScopes };
    }
    return { status: 'error', error: String(e.stderr || e.message || e).slice(0, 2000) };
  }
}

export function collectFeishu(folderUrl, window) {
  return guard(() => {
    const listed = runJson('node', [FEISHU, 'list-folder', `--target=${folderUrl}`, '--name=周工作汇报']);
    if (listed.status !== 'ok') return { status: 'error', error: JSON.stringify(listed).slice(0, 1000) };
    const picked = pickWeeklyReport(listed.files, window);
    if (listed.truncated && picked.status === 'missing') return { ...picked, warning: '目录文件过多，列表被截断，周报可能在未列出的部分' };
    if (picked.status !== 'ok') return picked;
    const doc = runJson('node', [FEISHU, 'read', `--target=${picked.report.url}`]);
    return { status: 'ok', title: picked.report.name, date: picked.report.date, url: picked.report.url, createdAt: picked.report.created_at, content: doc.content };
  });
}

export function collectSessions(window) {
  return guard(() => {
    const days = Math.ceil((Date.now() - window.start.getTime()) / 86400000) + 1;
    const all = runJson('python3', [SESSIONS, 'list', '--since', String(days), '--limit', '1000', '--json']);
    // 跨越周一的会话只保留时间窗内的提问；最后一条回复在窗口外就去掉
    const inWindow = (t) => { const ms = Date.parse(t); return !Number.isNaN(ms) && ms >= window.start.getTime() && ms <= window.end.getTime() };
    const sessions = all.filter((s) => overlaps(s, window)).map((s) => ({
      ...s,
      // 没有时间戳的提问无法判断，按会话整体与窗口重叠保留，和最后回复的处理一致
      prompts: (s.prompts || []).filter((p) => typeof p === 'string' || !p.time || inWindow(p.time)),
      last_reply: !s.last_reply_time || inWindow(s.last_reply_time) ? s.last_reply : '',
    }));
    return { status: 'ok', count: sessions.length, sessions };
  });
}

export function gitRepos(root, depth = 5) {
  const out = [];
  const walk = (dir, d) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    // 只认真正的仓库：.git 是 worktree 指针文件，或含 HEAD 的目录（工作区根有一个空 .git 目录）
    const git = path.join(dir, '.git');
    let isRepo = false;
    try { isRepo = ents.some((e) => e.name === '.git') && (fs.statSync(git).isFile() || fs.existsSync(path.join(git, 'HEAD'))) } catch { /* 断开的 .git 链接 */ }
    if (isRepo) { out.push(dir); return }
    if (d >= depth) return;
    for (const e of ents) {
      if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'target', 'dist', 'build', 'venv'].includes(e.name)) walk(path.join(dir, e.name), d + 1);
    }
  };
  walk(root, 0);
  return out;
}

// 统计 git 提交用的作者：--author，否则 env/credentials.env 的 OKR_WEEKLY_AUTHOR（交互会话经 bin/with-env 加载，定时段由 run_scheduled.sh 加载）；
// 都没有时报错，不再猜测本机用户名
export const AUTHOR_ENV = 'OKR_WEEKLY_AUTHOR';
export function resolveAuthor(opts = {}, env = process.env) {
  const author = String(opts.author || env[AUTHOR_ENV] || '').trim();
  if (!author) throw Object.assign(new Error(`${AUTHOR_ENV} 未配置：在 env/credentials.env 填写该键并经 bin/with-env 运行，或传 --author=<git 作者>`), { code: 'AUTHOR_REQUIRED' });
  return author;
}

export function collectCommits(root, author, window) {
  return guard(() => {
    const commits = [];
    for (const repo of gitRepos(root)) {
      let log = '';
      try {
        log = execFileSync('git', ['-C', repo, 'log', '--all', `--author=${author}`, `--since=${window.start.toISOString()}`, `--until=${window.end.toISOString()}`, '--pretty=%h%x09%aI%x09%s'], { encoding: 'utf8', timeout: 30000 });
      } catch { continue }
      for (const line of log.split('\n').filter(Boolean)) {
        const [hash, time, ...subject] = line.split('\t');
        // --since 按提交时间过滤，输出的是作者时间；rebase 过的旧提交按作者时间再筛一次
        const authored = Date.parse(time);
        if (authored < window.start.getTime() || authored > window.end.getTime()) continue;
        commits.push({ repo: path.relative(root, repo), hash, time, subject: subject.join('\t') });
      }
    }
    return { status: 'ok', count: commits.length, commits };
  });
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : e.isFile() ? [p] : [];
  });
}

// 需求文档目录（<需求>/<阶段>/…）：给阶段表提供各阶段文件的最早、最晚日期；只列本周有文件改动的需求。
// 最早日期取创建时间与修改时间中较早的一个，文件系统不支持创建时间（birthtimeMs 为 0）时用修改时间
export function collectRequirementDocs(root, window) {
  return guard(() => {
    const requirements = [];
    for (const req of fs.readdirSync(root, { withFileTypes: true })) {
      if (!req.isDirectory() || req.name === 'archive') continue;
      const dir = path.join(root, req.name);
      const stages = [];
      for (const stage of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!stage.isDirectory()) continue;
        const stats = filesUnder(path.join(dir, stage.name)).map((f) => fs.statSync(f));
        if (stats.length === 0) continue;
        const first = Math.min(...stats.map((st) => (st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs)));
        const last = Math.max(...stats.map((st) => st.mtimeMs));
        stages.push({ stage: stage.name, first: cnDate(new Date(first)), last: cnDate(new Date(last)), lastMs: last });
      }
      if (!stages.some((st) => st.lastMs >= window.start.getTime())) continue;
      const summary = path.join(dir, 'requirements', 'summary.md');
      requirements.push({
        name: req.name, dir, summary: fs.existsSync(summary) ? summary : null,
        stages: stages.sort((a, b) => a.first.localeCompare(b.first) || a.stage.localeCompare(b.stage)).map(({ lastMs, ...st }) => st),
      });
    }
    return { status: 'ok', count: requirements.length, requirements };
  });
}

export function recentArchives(dir, limit = 4) {
  try {
    return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-limit).map((f) => path.join(dir, f));
  } catch { return [] }
}

export function archivePlan(dir, feishu, window) {
  const date = feishu?.status === 'ok' ? feishu.date : cnDate(window.end);
  const target = path.join(dir, `${date}.md`);
  if (!fs.existsSync(target)) return { date, path: target, existing: null };
  // 同名已存在时不覆盖任何旧文件，包括上一次生成的 .new.md
  let candidate = path.join(dir, `${date}.new.md`);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${date}.new-${n}.md`);
  return { date, path: candidate, existing: target };
}

export const DEFAULTS = {
  folder: 'https://lexin.feishu.cn/drive/folder/BR06fpVhtl6224dAVuscxF5Wnnc',
  mid: 49548,
  projects: workspaceRoot(),
  archiveDir: path.join(docsRoot(), 'weekly-reports'),
  requirementsDir: path.join(docsRoot(), 'requirements-development'),
  stateDir: path.join(os.homedir(), '.local', 'state', 'agent-tools', 'okr-weekly'),
};
