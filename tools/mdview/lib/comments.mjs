// mdview 评论：用户在页面上对选中文字留评论，agent 用 `mdview comments <文件>` 读出、处理并标记已处理。
// 评论不写进文档，统一存在 $XDG_STATE_HOME/mdview/comments/<路径哈希>.json，仓库里不多出文件。
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function stateDir(env = process.env) {
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'mdview', 'comments');
}

// 同一文件经符号链接或相对路径访问时要落到同一份评论
function canonical(file) {
  const abs = path.resolve(file);
  try { return fs.realpathSync(abs) } catch { return abs }
}

export function storePath(file, dir = stateDir()) {
  return path.join(dir, createHash('sha256').update(canonical(file)).digest('hex').slice(0, 16) + '.json');
}

export function loadComments(file, { dir } = {}) {
  try {
    return JSON.parse(fs.readFileSync(storePath(file, dir), 'utf8')).comments || [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// 页面和 CLI 可能同时写：读改写后经临时文件 rename，至少不会留下半截 JSON
function update(file, dir, change) {
  const comments = loadComments(file, { dir });
  const result = change(comments);
  const target = storePath(file, dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ file: canonical(file), comments }, null, 2) + '\n');
  fs.renameSync(tmp, target);
  return result;
}

const clip = (value, max) => String(value ?? '').slice(0, max);

function find(comments, id) {
  const comment = comments.find((c) => c.id === id);
  if (!comment) throw new Error(`评论不存在: ${id}`);
  return comment;
}

export function addComment(file, input, { dir, now = new Date() } = {}) {
  const body = clip(input.body, 4000).trim();
  if (!body) throw new Error('评论内容不能为空');
  return update(file, dir, (comments) => {
    const comment = {
      id: randomBytes(4).toString('hex'),
      quote: clip(input.quote, 1000).trim(),
      prefix: clip(input.prefix, 60),
      suffix: clip(input.suffix, 60),
      heading: clip(input.heading, 200),
      body,
      status: 'open',
      created_at: now.toISOString(),
      reply: '',
      resolved_at: null,
    };
    comments.push(comment);
    return comment;
  });
}

export function setStatus(file, id, status, { reply, dir, now = new Date() } = {}) {
  if (!['open', 'resolved'].includes(status)) throw new Error(`未知状态: ${status}`);
  return update(file, dir, (comments) => {
    const comment = find(comments, id);
    comment.status = status;
    if (reply !== undefined) comment.reply = clip(reply, 4000);
    comment.resolved_at = status === 'resolved' ? now.toISOString() : null;
    return comment;
  });
}

export function deleteComment(file, id, { dir } = {}) {
  return update(file, dir, (comments) => {
    find(comments, id);
    comments.splice(comments.findIndex((c) => c.id === id), 1);
    return { id, deleted: true };
  });
}

// 评论记的是渲染后的文字；去掉常见 Markdown 标记后在源文件里找，给出大致行号，找不到返回 null
function plain(line) {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/[*_`|~\\]/g, '')
    .replace(/\s+/g, '');
}

export function locateLine(markdown, quote) {
  const needle = String(quote || '').replace(/[*_`|~\\\s]/g, '').slice(0, 40);
  if (!needle) return null;
  const starts = [];
  let text = '';
  for (const line of markdown.split('\n')) {
    starts.push(text.length);
    text += plain(line);
  }
  const at = text.indexOf(needle);
  if (at < 0) return null;
  let line = 0;
  for (let i = 0; i < starts.length && starts[i] <= at; i++) line = i;
  return line + 1;
}

export function withLines(file, comments) {
  let markdown = null;
  try { markdown = fs.readFileSync(file, 'utf8') } catch { /* 文件被删时仍返回评论 */ }
  return comments.map((c) => ({ ...c, line: markdown === null ? null : locateLine(markdown, c.quote) }));
}

const USAGE = `用法:
  mdview comments <文件> [--all]                       列出未处理评论（--all 含已处理），JSON 输出
  mdview comments <文件> --resolve <id> [--reply 文字]  标记已处理并回复
  mdview comments <文件> --reopen <id>                  重新打开`;

export function runCli(args, { dir, out = (s) => process.stdout.write(s + '\n') } = {}) {
  const opts = { all: false };
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') opts.all = true;
    else if (a === '--resolve' || a === '--reopen' || a === '--reply') opts[a.slice(2)] = args[++i];
    else if (a === '-h' || a === '--help') { out(USAGE); return 0 }
    else files.push(a);
  }
  if (files.length !== 1) { out(USAGE); return 2 }
  const file = canonical(files[0]);
  if (opts.resolve) out(JSON.stringify(setStatus(file, opts.resolve, 'resolved', { reply: opts.reply, dir }), null, 2));
  else if (opts.reopen) out(JSON.stringify(setStatus(file, opts.reopen, 'open', { reply: opts.reply, dir }), null, 2));
  else {
    const all = withLines(file, loadComments(file, { dir }));
    const comments = opts.all ? all : all.filter((c) => c.status === 'open');
    out(JSON.stringify({ file, store: storePath(file, dir), open: all.filter((c) => c.status === 'open').length, total: all.length, comments }, null, 2));
  }
  return 0;
}
