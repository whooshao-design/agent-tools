#!/usr/bin/env node
// 每周 OKR 进展：collect 只读取数；write 把周报汇总整组读改写进乐空间草稿；restore 按快照恢复；open 用 mdview 打开。
// write/restore 不带 --confirm 时只输出 dry-run，不发任何写请求。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEmptySection, markdownToHtml, parseArchive, scanSensitive } from './lib/archive.mjs';
import { DEFAULTS, archivePlan, collectCommits, collectFeishu, collectSessions, recentArchives, weekWindow } from './lib/collect.mjs';
import { openLeco, readOkr } from './lib/leco.mjs';
import { buildRequest, changedSince, normalizeDetail, parseLecoTime, restoreRequest, verifyAfterWrite } from './lib/payload.mjs';

const SELF = fileURLToPath(import.meta.url);
const MDVIEW = '/home/joney/projects/ai/agent-tools/tools/mdview/mdview';
const print = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const text = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    opts[k] = v !== undefined ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return opts;
}

// --confirm=false / --confirm=no 不能被当成真值
const flag = (v) => v === true || ['true', '1', 'yes'].includes(String(v).toLowerCase());
const writePrivate = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { mode: 0o600 }); fs.chmodSync(file, 0o600) };
const sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000));

// 定时段（run_scheduled.sh）设置 OKR_WEEKLY_READONLY=1：脚本层面再拦一次写入，不只依赖工具白名单
function assertWritable(cmd) {
  if (process.env.OKR_WEEKLY_READONLY === '1') throw Object.assign(new Error(`${cmd} 在只读模式（OKR_WEEKLY_READONLY=1）下被禁止`), { code: 'READONLY' });
}

async function withLeco(mid, fn) {
  const client = await openLeco({ mid });
  try { return await fn(client) } finally { await client.close() }
}

async function cmdCollect(opts) {
  const window = weekWindow(opts.now ? new Date(opts.now) : new Date());
  if (opts.start) window.start = new Date(opts.start);
  const mid = Number(opts.mid || DEFAULTS.mid);
  const archiveDir = opts['archive-dir'] || DEFAULTS.archiveDir;
  const feishu = collectFeishu(opts.folder || DEFAULTS.folder, window);
  const sessions = collectSessions(window);
  const commits = collectCommits(opts.projects || DEFAULTS.projects, opts.author || 'joneyshao', window);
  let okr;
  try {
    okr = await withLeco(mid, (c) => readOkr(c, { mid, periodId: opts.period ? Number(opts.period) : undefined }));
    okr = {
      status: 'ok', mid, periodId: okr.periodId, periodName: okr.periodName,
      objs: okr.objs.map((o) => {
        const n = normalizeDetail(o.objId, o.detail);
        return {
          index: o.index, objId: o.objId, text: o.text,
          krs: o.krs.map((k) => {
            const d = n.krs.find((x) => x.krId === k.krId) || {};
            const published = d.latest && parseLecoTime(d.latest.publishTime);
            return { ...k, heading: `O${o.index}-KR${k.index} \`${k.krId}\``, publishedThisWeek: Boolean(published && published >= window.start), latestPublishTime: d.latest?.publishTime || null, latestText: text(d.latest?.html), hasDraft: Boolean(d.draft) };
          }),
        };
      }),
    };
  } catch (e) {
    okr = { status: 'error', code: e.code || 'ERROR', error: e.message };
  }
  const result = {
    window: { start: window.start.toISOString(), end: window.end.toISOString(), timezone: 'Asia/Shanghai' },
    archive: { ...archivePlan(archiveDir, feishu, window), previous: recentArchives(archiveDir) },
    meta: { goal_mid: mid, period_id: okr.periodId ?? null, window_start: window.start.toISOString() },
    sources: { feishu, sessions, commits, okr },
  };
  // 只读模式下素材只能落在状态目录，不接受 --out
  const out = opts.out && process.env.OKR_WEEKLY_READONLY !== '1' ? opts.out : path.join(DEFAULTS.stateDir, 'collect', `${stamp()}.json`);
  writePrivate(out, JSON.stringify(result, null, 2));
  print({
    status: 'ok', out, window: result.window, archive: result.archive, meta: result.meta,
    sources: Object.fromEntries(Object.entries(result.sources).map(([k, v]) => [k, { status: v.status, count: v.count, error: v.error, code: v.code, nextAction: v.nextAction }])),
  });
}

function loadAdditions(file, includePublished) {
  const { meta, sections } = parseArchive(fs.readFileSync(file, 'utf8'));
  const additions = new Map();
  const skipped = [];
  const empty = [];
  for (const s of sections.filter((x) => x.kind === 'kr')) {
    if (isEmptySection(s.content)) { empty.push(s.krId); continue }
    if (s.skipped && !includePublished) { skipped.push(s.krId); continue }
    additions.set(s.krId, { markdown: s.content, html: markdownToHtml(s.content), title: s.title });
  }
  return { meta, additions, skipped, empty };
}

export async function cmdWrite(opts, { withClient = withLeco, wait = sleep, out = print, stateDir = DEFAULTS.stateDir } = {}) {
  assertWritable('write');
  const file = opts.file || opts._[0];
  if (!file || !fs.existsSync(file)) throw new Error('write 需要 --file=<周报汇总.md>');
  const includePublished = flag(opts['include-published']);
  const { meta, additions, skipped, empty } = loadAdditions(file, includePublished);
  if (additions.size === 0) return out({ status: 'nothing-to-write', skippedPublished: skipped, emptySections: empty, hint: '没有可写的 KR 小节（都标了本周已发布、为空或只有「本周无」）' });
  const hits = [...additions.values()].flatMap((a) => scanSensitive(a.markdown).map((h) => ({ ...h, kr: a.title })));
  if (hits.length && !flag(opts['allow-sensitive'])) return out({ status: 'sensitive-found', hits, hint: '先在周报汇总里脱敏；确认无碍后加 --allow-sensitive' });
  const mid = Number(opts.mid || meta.goal_mid || DEFAULTS.mid);
  // 时间窗以生成周报时记录的为准，周一补写上周的周报也不会按错误的周判断「本周已发布」
  const windowStart = new Date(opts.start || meta.window_start || weekWindow().start);

  return withClient(mid, async (client) => {
    const okr = await readOkr(client, { mid, periodId: Number(opts.period || meta.period_id) || undefined });
    const groups = okr.objs.map((o) => {
      const before = normalizeDetail(o.objId, o.detail);
      const adds = new Map([...additions].filter(([id]) => o.krs.some((k) => k.krId === id)).map(([id, a]) => [id, a.html]));
      return { obj: o, before, ...buildRequest(before, adds, { windowStart, includePublished }) };
    }).filter((g) => g.plan.some((p) => p.action !== 'keep' && p.action !== 'keep-empty'));
    // kr_id 必须同时出现在 KR 列表和进展详情里，否则会被整组请求悄悄丢掉
    const planned = new Set(groups.flatMap((g) => g.plan.filter((p) => p.action !== 'keep' && p.action !== 'keep-empty').map((p) => p.krId)));
    const unknown = [...additions.keys()].filter((id) => !planned.has(id));
    if (unknown.length) throw new Error(`周报汇总里的 kr_id 在当前 OKR 进展详情中找不到：${unknown.join(', ')}`);

    const summary = groups.map((g) => ({
      objId: g.obj.objId,
      willSubmit: Boolean(g.request),
      krs: g.plan.map((p) => ({ krId: p.krId, action: p.action, beforeChars: p.beforeChars, afterChars: p.afterChars, additionText: text(p.addition) })),
    }));
    if (!flag(opts.confirm)) return out({ status: 'dry-run', file, windowStart: windowStart.toISOString(), skippedPublished: skipped, emptySections: empty, groups: summary, hint: '核对无误、并关闭所有「添加进展」页面后，加 --confirm 提交' });

    const snapDir = path.join(stateDir, 'snapshots');
    const toSubmit = groups.filter((x) => x.request);
    if (toSubmit.length === 0) return out({ status: 'nothing-to-write', groups: summary, hint: '所有 KR 都被跳过（本周已发布或已写入过），没有发起请求' });
    for (const g of toSubmit) {
      g.snapFile = path.join(snapDir, `${stamp()}-${g.obj.objId}.json`);
      g.snap = { objId: g.obj.objId, takenAt: new Date().toISOString(), file, posted: false, before: g.before };
      writePrivate(g.snapFile, JSON.stringify(g.snap, null, 2));
    }
    // 打开着的「添加进展」页面每 30 秒自动保存；隔一个周期以上再比对，才能在提交前发现它
    const settle = Number(opts['settle-seconds'] ?? 35);
    if (settle > 0) await wait(settle);

    const results = [];
    for (const g of toSubmit) {
      const r = { objId: g.obj.objId, snapshot: g.snapFile, restore: `node ${SELF} restore --snapshot=${g.snapFile}` };
      results.push(r);
      try {
        const now = normalizeDetail(g.obj.objId, await client.get('get_obj_detail.json', { obj_id: g.obj.objId }));
        const moved = changedSince(g.before, now);
        if (moved.length) { Object.assign(r, { status: 'aborted', reason: `草稿在评审期间被改过（kr ${moved.join(', ')}），可能有打开着的「添加进展」页面` }); delete r.restore; continue }
        g.snap.posted = true;
        writePrivate(g.snapFile, JSON.stringify(g.snap, null, 2));
        await client.post('edit_kr_process.json', g.request);
        r.status = 'posted';
        const after = normalizeDetail(g.obj.objId, await client.get('get_obj_detail.json', { obj_id: g.obj.objId }));
        g.snap.afterModifyTimes = Object.fromEntries(after.krs.map((k) => [k.krId, k.draftModifyTime]));
        writePrivate(g.snapFile, JSON.stringify(g.snap, null, 2));
        const problems = verifyAfterWrite(g.before, after, g.plan);
        Object.assign(r, { status: problems.length ? 'verify-failed' : 'written', problems });
      } catch (e) {
        // 提交前失败：草稿没动；提交已发出后失败：写入结果未知，要人工核对
        if (g.snap.posted) Object.assign(r, { status: 'unknown-after-post', error: e.message, hint: '请求已发出但没能回读核验；在页面上核对该 O 的草稿，需要时用 restore（会要求 --force）' });
        else { Object.assign(r, { status: 'failed-before-post', error: e.message }); delete r.restore }
      }
    }
    const recheckSeconds = Number(opts['recheck-seconds'] ?? 65);
    if (recheckSeconds > 0 && results.some((r) => r.status === 'written')) {
      await wait(recheckSeconds);
      for (const r of results.filter((x) => x.status === 'written')) {
        const g = groups.find((x) => x.obj.objId === r.objId);
        try {
          const later = normalizeDetail(r.objId, await client.get('get_obj_detail.json', { obj_id: r.objId }));
          const problems = verifyAfterWrite(g.before, later, g.plan);
          r.recheck = problems.length ? { status: 'overwritten', problems, hint: '草稿被其他页面覆盖；关闭「添加进展」页面后决定是否重写，不会自动重写' } : { status: 'ok', afterSeconds: recheckSeconds };
        } catch (e) {
          r.recheck = { status: 'error', error: e.message };
        }
      }
    }
    out({ status: results.every((r) => r.status === 'written' && (recheckSeconds <= 0 || r.recheck?.status === 'ok')) ? 'ok' : 'attention', results });
  });
}

export async function cmdRestore(opts, { withClient = withLeco, out = print } = {}) {
  assertWritable('restore');
  const file = opts.snapshot;
  if (!file || !fs.existsSync(file)) throw new Error('restore 需要 --snapshot=<快照文件>');
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (snap.posted === false) return out({ status: 'refused', reason: '这份快照对应的写入没有提交过，草稿未被改动，不需要恢复' });
  const request = restoreRequest(snap.before);
  return withClient(Number(opts.mid || DEFAULTS.mid), async (client) => {
    const now = normalizeDetail(snap.objId, await client.get('get_obj_detail.json', { obj_id: snap.objId }));
    // 有写后修改时间就比对；没有（提交后回读失败）就无法判断写入后是否又有人改过，一律要求 --force
    const moved = snap.afterModifyTimes ? now.krs.filter((k) => snap.afterModifyTimes[k.krId] !== k.draftModifyTime).map((k) => k.krId) : null;
    const risky = moved === null || moved.length > 0;
    const plan = { objId: snap.objId, krs: request.krProcessList.map((k) => ({ krId: k.krId, chars: k.processContent.length })), changedAfterWrite: moved ?? 'unknown' };
    const warning = moved === null ? '快照没有写后修改时间，无法确认写入后是否又被改过；恢复可能覆盖这些改动' : moved.length ? `写入后 kr ${moved.join(', ')} 又被改过，恢复会覆盖这些改动` : null;
    if (!flag(opts.confirm)) return out({ status: 'dry-run', snapshot: file, plan, warning, hint: risky ? '确认要覆盖时加 --confirm --force' : '加 --confirm 恢复' });
    if (risky && !flag(opts.force)) return out({ status: 'aborted', reason: warning, plan });
    await client.post('edit_kr_process.json', request);
    const after = normalizeDetail(snap.objId, await client.get('get_obj_detail.json', { obj_id: snap.objId }));
    const keepPlan = snap.before.krs.map((k) => ({ krId: k.krId, action: 'keep', expected: k.draft ? { content: k.draft.html, ratio: k.draft.ratio, status: k.draft.status } : { content: '', ratio: '0', status: 0 } }));
    const problems = verifyAfterWrite(snap.before, after, keepPlan);
    out({ status: problems.length ? 'verify-failed' : 'restored', problems });
  });
}

function cmdOpen(opts) {
  const file = opts.file || opts._[0];
  if (!file) throw new Error('open 需要文件路径');
  const out = execFileSync(MDVIEW, [path.resolve(file)], { encoding: 'utf8', timeout: 20000 });
  print({ status: 'ok', mdview: out.trim() });
}

const USAGE = `用法:
  okr_weekly.mjs collect [--out=<json>] [--mid=49548] [--start=<ISO>] [--now=<ISO>]
  okr_weekly.mjs write --file=<周报汇总.md> [--confirm] [--allow-sensitive] [--include-published] [--settle-seconds=35] [--recheck-seconds=65]
  okr_weekly.mjs restore --snapshot=<快照.json> [--confirm] [--force]
  okr_weekly.mjs open <周报汇总.md>`;

// 经符号链接调用时 argv[1] 不是真实路径，比较前先解析
const invokedDirectly = (() => { try { return fs.realpathSync(process.argv[1]) === SELF } catch { return false } })();
if (invokedDirectly) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  const commands = { collect: cmdCollect, write: cmdWrite, restore: cmdRestore, open: cmdOpen };
  if (!commands[cmd]) { console.log(USAGE); process.exit(cmd ? 2 : 0) }
  Promise.resolve(commands[cmd](opts)).catch((e) => { print({ status: 'error', code: e.code || 'ERROR', error: e.message }); process.exit(1) });
}
