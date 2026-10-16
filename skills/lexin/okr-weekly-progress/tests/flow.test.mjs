import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isEmptySection, scanSensitive } from '../scripts/lib/archive.mjs';
import { guard } from '../scripts/lib/collect.mjs';
import { cmdRestore, cmdWrite } from '../scripts/okr_weekly.mjs';

const ARCHIVE = `# 周工作汇总
<!-- okr-weekly: {"goal_mid":1,"period_id":26,"window_start":"2026-10-11T16:00:00.000Z"} -->

## O1-KR1 \`11\` A

本周工作

1. 做了 A

## O2-KR1 \`21\` B

本周工作

1. 做了 B

## O2-KR2 \`22\` C

本周无
`;

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okr-flow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'w.md');
  fs.writeFileSync(file, ARCHIVE);
  return { dir, file };
}

const detail = (krs) => ({ retcode: 0, result_rows: [{ kr_process_list: krs.map(([id, html = '', t = 'm0', ratio = html ? '10' : '0', status = html ? 3 : 0]) => ({ kr_id: id, process_draft_content: { process_with_rich_text: html, progress_ratio: ratio, process_status: status, draft_modify_time: t } })) }] });

// 一个可编排的假乐空间：按 obj 记录草稿；fail 钩子决定第几次 get/post 抛错
function fakeLeco({ failGet = () => false } = {}) {
  const drafts = { 1: [[11, '<p>旧</p>']], 2: [[21], [22]] };
  const calls = { get: 0, post: [] };
  const client = {
    async get(name, params) {
      calls.get += 1;
      if (name === 'get_obj_list_adjust.json') return { result_rows: [{ obj_id: 1, kr_list: [{ kr_id: 11, content_str: 'A' }] }, { obj_id: 2, kr_list: [{ kr_id: 21, content_str: 'B' }, { kr_id: 22, content_str: 'C' }] }] };
      if (failGet(name, params, calls)) throw new Error(`get ${name} boom`);
      return detail(drafts[params.obj_id]);
    },
    async post(name, body) {
      calls.post.push(body);
      drafts[body.objId] = body.krProcessList.map((k) => [k.krId, k.processContent, 'm1', k.progressRatio ?? '0', k.processStatus ?? 0]);
      return { retcode: 0 };
    },
  };
  return { client, calls, withClient: async (mid, fn) => fn(client) };
}

const run = async (fn, opts, deps) => { let out; await fn(opts, { ...deps, out: (o) => { out = o } }); return out };

test('dry-run never posts and skips sections that only say 本周无', async (t) => {
  const { file, dir } = sandbox(t);
  const f = fakeLeco();
  const out = await run(cmdWrite, { file }, { withClient: f.withClient, stateDir: dir });
  assert.equal(out.status, 'dry-run');
  assert.deepEqual(out.emptySections, [22]);
  assert.equal(f.calls.post.length, 0);
  assert.equal(out.groups.flatMap((g) => g.krs).find((k) => k.krId === 11).additionText, '本周工作 做了 A');
});

test('--confirm=false is not a confirmation', async (t) => {
  const { file, dir } = sandbox(t);
  const f = fakeLeco();
  assert.equal((await run(cmdWrite, { file, confirm: 'false' }, { withClient: f.withClient, stateDir: dir })).status, 'dry-run');
  assert.equal(f.calls.post.length, 0);
});

test('a failed read-back after POST is reported with its snapshot, and later groups still run', async (t) => {
  const { file, dir } = sandbox(t);
  // obj 1：提交前比对读成功，提交后回读失败；obj 2 正常
  let obj1Reads = 0;
  const f = fakeLeco({ failGet: (name, params) => params?.obj_id === 1 && name === 'get_obj_detail.json' && ++obj1Reads === 3 });
  const out = await run(cmdWrite, { file, confirm: true, 'settle-seconds': 0, 'recheck-seconds': 1 }, { withClient: f.withClient, wait: async () => {}, stateDir: dir });
  const [r1, r2] = out.results;
  assert.equal(r1.status, 'unknown-after-post');
  assert.ok(r1.restore && fs.existsSync(r1.snapshot));
  assert.equal(JSON.parse(fs.readFileSync(r1.snapshot, 'utf8')).posted, true);
  assert.equal(r2.status, 'written');
  assert.equal(r2.recheck.status, 'ok');
  assert.equal(out.status, 'attention');
  assert.equal(fs.statSync(r1.snapshot).mode & 0o777, 0o600);
});

test('a failure before POST leaves drafts untouched and the snapshot unposted', async (t) => {
  const { file, dir } = sandbox(t);
  let obj2Reads = 0;
  const f = fakeLeco({ failGet: (name, params) => params?.obj_id === 2 && name === 'get_obj_detail.json' && ++obj2Reads === 2 });
  const out = await run(cmdWrite, { file, confirm: true, 'settle-seconds': 0, 'recheck-seconds': 0 }, { withClient: f.withClient, wait: async () => {}, stateDir: dir });
  assert.deepEqual(out.results.map((r) => r.status), ['written', 'failed-before-post']);
  assert.equal(f.calls.post.length, 1);
  assert.equal(out.results[1].restore, undefined);
});

test('drafts edited during the settle window abort the write', async (t) => {
  const { file, dir } = sandbox(t);
  const f = fakeLeco();
  const wait = async () => { await f.client.post('edit_kr_process.json', { objId: 2, krProcessList: [{ krId: 21, processContent: '<p>页面自动保存</p>' }, { krId: 22, processContent: '' }] }); f.calls.post.length = 0 };
  const out = await run(cmdWrite, { file, confirm: true, 'recheck-seconds': 0 }, { withClient: f.withClient, wait, stateDir: dir });
  assert.deepEqual(out.results.map((r) => r.status), ['written', 'aborted']);
  assert.equal(f.calls.post.length, 1);
});

test('restore refuses unposted snapshots and requires --force when post-write state is unknown', async (t) => {
  const { dir } = sandbox(t);
  const f = fakeLeco();
  const before = { objId: 2, krs: [{ krId: 21, draft: null, draftModifyTime: 'm0' }, { krId: 22, draft: null, draftModifyTime: 'm0' }] };
  const unposted = path.join(dir, 'a.json');
  fs.writeFileSync(unposted, JSON.stringify({ objId: 2, posted: false, before }));
  assert.equal((await run(cmdRestore, { snapshot: unposted, confirm: true }, { withClient: f.withClient })).status, 'refused');
  const unknown = path.join(dir, 'b.json');
  fs.writeFileSync(unknown, JSON.stringify({ objId: 2, posted: true, before }));
  const dry = await run(cmdRestore, { snapshot: unknown }, { withClient: f.withClient });
  assert.equal(dry.status, 'dry-run');
  assert.match(dry.warning, /无法确认/);
  assert.equal((await run(cmdRestore, { snapshot: unknown, confirm: true }, { withClient: f.withClient })).status, 'aborted');
  assert.equal((await run(cmdRestore, { snapshot: unknown, confirm: true, force: true }, { withClient: f.withClient })).status, 'restored');
});

test('readonly mode refuses write and restore', async (t) => {
  const { file, dir } = sandbox(t);
  process.env.OKR_WEEKLY_READONLY = '1';
  t.after(() => { delete process.env.OKR_WEEKLY_READONLY });
  await assert.rejects(cmdWrite({ file }, { stateDir: dir }), /只读模式/);
  await assert.rejects(cmdRestore({ snapshot: file }), /只读模式/);
});

test('guard keeps the structured permission result a failing child printed on stdout', () => {
  const r = guard(() => { throw Object.assign(new Error('Command failed'), { stdout: JSON.stringify({ status: 'permission_required', failureClass: 'OAUTH_SCOPE_MISSING', nextAction: '运行 authorize', missingScopes: ['space:document:retrieve'] }) }) });
  assert.deepEqual([r.status, r.failureClass, r.nextAction, r.missingScopes], ['error', 'OAUTH_SCOPE_MISSING', '运行 authorize', ['space:document:retrieve']]);
  assert.equal(guard(() => { throw Object.assign(new Error('x'), { stderr: 'plain failure' }) }).error, 'plain failure');
});

test('scanSensitive covers internal domains, Chinese credentials, Bearer tokens and uids, but not full SHAs', () => {
  const kinds = (s) => scanSensitive(s).map((h) => h.kind);
  assert.deepEqual(kinds('访问 openmoa.oa.fenqile.com'), ['内网域名']);
  assert.deepEqual(kinds('密码：abc123'), ['中文凭据字样']);
  assert.deepEqual(kinds('密码是abc123'), ['中文凭据字样']);
  assert.deepEqual(kinds('见 fenqile.com'), ['内网域名']);
  assert.deepEqual(kinds('Authorization: Bearer abcdefgh12345'), ['Bearer 凭据']);
  assert.deepEqual(kinds('uid 75908634'), ['用户标识']);
  assert.deepEqual(kinds('提交 2ee41e399cf434e3d3ae13cd28db131b6c744068'), []);
});

test('isEmptySection recognises sections with nothing but labels and 本周无', () => {
  assert.ok(isEmptySection('本周工作\n\n本周无\n\n下周工作\n\n1. 无'));
  assert.ok(isEmptySection(''));
  assert.ok(!isEmptySection('本周无\n\n下周工作\n\n1. 推进 X'));
});

test('a keep-empty KR that the page would now treat as non-empty is reported', async () => {
  const { normalizeDetail, verifyAfterWrite, buildRequest } = await import('../scripts/lib/payload.mjs');
  const before = normalizeDetail(2, detail([[21], [22]]));
  const { plan } = buildRequest(before, new Map([[21, '<p>x</p>']]), { windowStart: new Date(0) });
  const after = normalizeDetail(2, { result_rows: [{ kr_process_list: [
    { kr_id: 21, process_draft_content: { process_with_rich_text: '<p>x</p>', progress_ratio: '0', process_status: 0, draft_modify_time: 'm1' } },
    { kr_id: 22, process_draft_content: { process_with_rich_text: '', progress_ratio: 0, process_status: 0, draft_modify_time: 'm1' } },
  ] }] });
  assert.deepEqual(verifyAfterWrite(before, after, plan).map((p) => [p.krId, p.field]), [[22, 'draft']]);
});

test('confirm with nothing to submit returns immediately without waiting', async (t) => {
  const { file, dir } = sandbox(t);
  fs.writeFileSync(file, ARCHIVE.replace('1. 做了 A', '1. 做了 A').replace('<p>', ''));
  const f = fakeLeco();
  await run(cmdWrite, { file, confirm: true, 'recheck-seconds': 0 }, { withClient: f.withClient, wait: async () => {}, stateDir: dir });
  let waited = false;
  const out = await run(cmdWrite, { file, confirm: true }, { withClient: f.withClient, wait: async () => { waited = true }, stateDir: dir });
  assert.equal(out.status, 'nothing-to-write');
  assert.equal(waited, false);
});
