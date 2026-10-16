// 定时段的确定性取数：飞书周报、本机会话、git 提交、乐空间 OKR。任一来源失败只标注，不中断其他来源。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FEISHU = '/home/joney/projects/ai/agent-tools/skills/lexin/manage-feishu-doc/scripts/feishu_doc.mjs';
const SESSIONS = '/home/joney/projects/ai/agent-tools/skills/common/recall-agent-sessions/scripts/agent_sessions.py';
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
  projects: path.join(os.homedir(), 'projects'),
  archiveDir: path.join(os.homedir(), 'docs', 'weekly-reports'),
  stateDir: path.join(os.homedir(), '.local', 'state', 'agent-tools', 'okr-weekly'),
};
