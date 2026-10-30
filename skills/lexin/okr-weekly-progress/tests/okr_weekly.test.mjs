import assert from 'node:assert/strict';
import test from 'node:test';

import { markdownToHtml, parseArchive, sanitizeHtml, scanSensitive, SKIP_MARK } from '../scripts/lib/archive.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { archivePlan, cnDate, collectRequirementDocs, gitRepos, overlaps, pickWeeklyReport, weekWindow } from '../scripts/lib/collect.mjs';
import { buildRequest, changedSince, normalizeDetail, parseLecoTime, restoreRequest, verifyAfterWrite } from '../scripts/lib/payload.mjs';

const ARCHIVE = `# 周工作汇总 2026-10-12 ~ 10-16
<!-- okr-weekly: {"goal_mid":49548,"period_id":26} -->

## O1-KR1 \`262338\` 米霍克、特征平台迭代优化升级

本周工作
1. 人审中台化全链路验证通过（飞）

## O2-KR1 \`262339\` 业务监控分析智能体

> ${SKIP_MARK}

本周工作
1. 智能助手参数规范（会 7b7dd4f4）

## 待归类

1. 反欺诈分单优化（飞）
`;

test('parseArchive keeps only KR sections writable and honours the skip mark', () => {
  const { meta, sections } = parseArchive(ARCHIVE);
  assert.deepEqual(meta, { goal_mid: 49548, period_id: 26 });
  const krs = sections.filter((s) => s.kind === 'kr');
  assert.deepEqual(krs.map((s) => [s.krId, s.o, s.kr, s.skipped]), [[262338, 1, 1, false], [262339, 2, 1, true]]);
  assert.ok(!krs[1].content.includes(SKIP_MARK));
  assert.equal(sections.find((s) => s.kind === 'other').title, '待归类');
});

test('markdownToHtml emits only whitelisted tags, keeping just table align and border styles', () => {
  const html = markdownToHtml('本周工作\n1. a **b** <script>x</script> [l](http://e)\n\n| a | b |\n|:-:|---|\n| 1 | 2 |');
  assert.match(html, /^<p>本周工作<\/p><ol><li>a <strong>b<\/strong> x l<\/li><\/ol><table style=\"border-collapse: collapse;\">/);
  assert.ok(!/<script|<a |href/.test(html));
  assert.match(html, /<th align="center" style="border: 1px solid #ccc;[^"]*">a<\/th>/);
  assert.equal(sanitizeHtml('<div class="x"><p style="c">t</p></div>'), '<p>t</p>');
});

test('scanSensitive flags IPs, long ids and credentials but not commit hashes', () => {
  const kinds = scanSensitive('机器 10.17.58.35，订单 APL202610151324450003504324，token=abc，提交 343a71ae').map((h) => h.kind);
  assert.deepEqual(kinds.sort(), ['IPv4 地址', '凭据字样', '长数字或订单号'].sort());
  assert.deepEqual(scanSensitive('提交 4d1855c a3da8f6，会话 7b7dd4f4'), []);
});

test('weekWindow starts Monday 00:00 Beijing time, including Sunday night and Monday early UTC', () => {
  assert.equal(weekWindow(new Date('2026-10-16T05:40:00Z')).start.toISOString(), '2026-10-11T16:00:00.000Z');
  assert.equal(weekWindow(new Date('2026-10-18T15:59:00Z')).start.toISOString(), '2026-10-11T16:00:00.000Z');
  assert.equal(weekWindow(new Date('2026-10-18T16:00:00Z')).start.toISOString(), '2026-10-18T16:00:00.000Z');
  assert.equal(cnDate(new Date('2026-10-15T16:30:00Z')), '2026-10-16');
});

test('pickWeeklyReport picks the one report in the window, reports missing and ambiguous', () => {
  const w = { start: new Date('2026-10-11T16:00:00Z'), end: new Date('2026-10-16T05:40:00Z') };
  const f = (name) => ({ name, url: name });
  assert.equal(pickWeeklyReport([f('周工作汇报 2026年10月16日'), f('周工作汇报 2026年10月9日')], w).report.date, '2026-10-16');
  assert.equal(pickWeeklyReport([f('周工作汇报 2026年10月9日')], w).status, 'missing');
  assert.equal(pickWeeklyReport([f('周工作汇报 2026年10月13日'), f('周工作汇报 2026年10月16日')], w).status, 'ambiguous');
});

test('overlaps uses UTC session times against the Beijing window', () => {
  const w = { start: new Date('2026-10-11T16:00:00Z'), end: new Date('2026-10-16T05:40:00Z') };
  assert.ok(overlaps({ start: '2026-10-11T16:30:00Z', end: '2026-10-11T17:00:00Z' }, w));
  assert.ok(!overlaps({ start: '2026-10-11T10:00:00Z', end: '2026-10-11T15:59:00Z' }, w));
  assert.ok(overlaps({ start: '2026-10-09T10:00:00Z', end: '2026-10-12T01:00:00Z' }, w));
});

const DETAIL = {
  result_rows: [{
    kr_process_list: [
      { kr_id: 1, process_draft_content: { process_with_rich_text: '<p>旧草稿</p>', progress_ratio: '40', process_status: 3, draft_modify_time: 't1' }, latest_kr_process: { process_with_rich_text: '<p>上周</p>', progress_ratio: '30', process_status: 3, publish_time: '2026/10/09 13:44:43' } },
      { kr_id: 2, latest_kr_process: { process_with_rich_text: '<p>已发布</p>', progress_ratio: '50', process_status: 2, publish_time: '2026/10/09 10:00:00' } },
      { kr_id: 3, process_draft_content: { process_with_rich_text: '', progress_ratio: '0', process_status: 0, draft_modify_time: 't3' }, latest_kr_process: { process_with_rich_text: '<p>本周</p>', progress_ratio: '20', process_status: 3, publish_time: '2026/10/16 13:53:01' } },
    ],
  }],
};
const START = new Date('2026-10-11T16:00:00Z');

test('normalizeDetail treats an all-default draft as empty, like the page does', () => {
  const n = normalizeDetail(9, DETAIL);
  assert.deepEqual(n.krs.map((k) => Boolean(k.draft)), [true, false, false]);
  assert.equal(parseLecoTime('2026/10/16 13:53:01').toISOString(), '2026-10-16T05:53:01.000Z');
});

test('buildRequest appends to the target, keeps others and their state untouched', () => {
  const obj = normalizeDetail(9, DETAIL);
  const { request, plan } = buildRequest(obj, new Map([[1, '<p>新</p>'], [2, '<p>新2</p>']]), { windowStart: START });
  assert.deepEqual(request.krProcessList, [
    { krId: 1, progressRatio: '40', processStatus: 3, processContent: '<p>旧草稿</p><p>新</p>' },
    { krId: 2, progressRatio: '50', processStatus: 2, processContent: '<p>新2</p>' },
    { krId: 3, progressRatio: '0', processStatus: 0, processContent: '' },
  ]);
  assert.deepEqual(plan.map((p) => p.action), ['append', 'append', 'keep-empty']);
  assert.equal(request.option, 1);
});

test('buildRequest skips KRs published this week and already-written additions', () => {
  const obj = normalizeDetail(9, DETAIL);
  const published = buildRequest(obj, new Map([[3, '<p>x</p>']]), { windowStart: START });
  assert.equal(published.request, null);
  assert.equal(published.plan[2].action, 'skip-published');
  assert.equal(buildRequest(obj, new Map([[3, '<p>x</p>']]), { windowStart: START, includePublished: true }).plan[2].action, 'append');
  const dup = buildRequest(obj, new Map([[1, '<p>旧草稿</p>']]), { windowStart: START });
  assert.equal(dup.plan[0].action, 'skip-duplicate');
  assert.equal(dup.request, null);
});

test('buildRequest with replace swaps the old draft for the addition and keeps its state', () => {
  const before = normalizeDetail(9, DETAIL);
  const { request, plan } = buildRequest(before, new Map([[1, '<p>旧草稿</p>']]), { windowStart: START, replace: new Set([1]) });
  assert.equal(plan[0].action, 'replace');
  assert.deepEqual(request.krProcessList[0], { krId: 1, progressRatio: '40', processStatus: 3, processContent: '<p>旧草稿</p>' });
  const echo = { result_rows: [{ kr_process_list: request.krProcessList.map((k, i) => ({ kr_id: k.krId, process_draft_content: k.processContent ? { process_with_rich_text: k.processContent, progress_ratio: k.progressRatio, process_status: k.processStatus, draft_modify_time: 'new' } : null, latest_kr_process: DETAIL.result_rows[0].kr_process_list[i].latest_kr_process })) }] };
  assert.deepEqual(verifyAfterWrite(before, normalizeDetail(9, echo), plan), []);
  const stale = { result_rows: [{ kr_process_list: echo.result_rows[0].kr_process_list.map((k, i) => (i === 0 ? { ...k, process_draft_content: { ...k.process_draft_content, process_with_rich_text: '<p>旧草稿</p><p>旧草稿</p>' } } : k)) }] };
  assert.deepEqual(verifyAfterWrite(before, normalizeDetail(9, stale), plan).map((p) => [p.krId, p.field]), [[1, 'content']]);
});

test('buildRequest replaces a draft that only repeats the latest published progress', () => {
  const detail = structuredClone(DETAIL);
  detail.result_rows[0].kr_process_list[0].process_draft_content.process_with_rich_text = '<p>上周&nbsp;</p>\n';
  const { request, plan } = buildRequest(normalizeDetail(9, detail), new Map([[1, '<p>新</p>']]), { windowStart: START });
  assert.equal(plan[0].action, 'replace');
  assert.equal(request.krProcessList[0].processContent, '<p>新</p>');
});

test('verifyAfterWrite passes on the expected state and catches clobbered neighbours', () => {
  const before = normalizeDetail(9, DETAIL);
  const { request, plan } = buildRequest(before, new Map([[1, '<p>新</p>']]), { windowStart: START });
  const echo = (list, mutate = (x) => x) => ({
    result_rows: [{ kr_process_list: list.map((k, i) => mutate({ kr_id: k.krId, process_draft_content: { process_with_rich_text: k.processContent, progress_ratio: k.progressRatio, process_status: k.processStatus, draft_modify_time: 'new' }, latest_kr_process: DETAIL.result_rows[0].kr_process_list[i].latest_kr_process }, i)) }],
  });
  assert.deepEqual(verifyAfterWrite(before, normalizeDetail(9, echo(request.krProcessList)), plan), []);
  const clobbered = echo(request.krProcessList, (x, i) => (i === 1 ? { ...x, process_draft_content: { process_with_rich_text: '<p>页面回填</p>', progress_ratio: '50', process_status: 2 } } : x));
  assert.deepEqual(verifyAfterWrite(before, normalizeDetail(9, clobbered), plan).map((p) => [p.krId, p.field]), [[2, 'draft'], [2, 'progressRatio'], [2, 'processStatus']]);
});

test('changedSince detects drafts edited during review; restoreRequest rebuilds the snapshot', () => {
  const before = normalizeDetail(9, DETAIL);
  const now = normalizeDetail(9, { result_rows: [{ kr_process_list: DETAIL.result_rows[0].kr_process_list.map((k) => (k.kr_id === 3 ? { ...k, process_draft_content: { ...k.process_draft_content, draft_modify_time: 't3b' } } : k)) }] });
  assert.deepEqual(changedSince(before, now), [3]);
  assert.deepEqual(restoreRequest(before).krProcessList.map((k) => [k.krId, k.processContent, k.progressRatio, k.processStatus]), [[1, '<p>旧草稿</p>', '40', 3], [2, '', '0', 0], [3, '', '0', 0]]);
});

test('gitRepos skips an empty .git directory at the workspace root and finds nested repos', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'okr-repos-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'a', 'repo1', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'repo1', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(root, 'b', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(root, 'b', 'wt', '.git'), 'gitdir: /x\n');
  assert.deepEqual(gitRepos(root).map((p) => path.relative(root, p)).sort(), ['a/repo1', 'b/wt']);
});

test('nested theme lists keep their hierarchy in the HTML sent to leco', () => {
  const html = markdownToHtml('本周工作\n\n1. **线上问题支持**\n   1. 事项一（会 a）\n   2. 事项二（会 b）\n2. **SER 迁移**：比对规则（会 c）\n');
  assert.equal(html, '<p>本周工作</p><ol><li><strong>线上问题支持</strong><ol><li>事项一（会 a）</li><li>事项二（会 b）</li></ol></li><li><strong>SER 迁移</strong>：比对规则（会 c）</li></ol>');
});

test('a stage table under a numbered item stays inside that item', () => {
  const html = markdownToHtml('1. **乐包复制**\n\n   | 阶段 | 进度 |\n   |---|---|\n   | 方案设计 | 已完成 |\n\n   收益：预期 a；实际 b\n\n2. **告警排查**：结论\n');
  assert.equal(html, '<ol><li><p><strong>乐包复制</strong></p><table style="border-collapse: collapse;"><thead><tr><th style="border: 1px solid #ccc; padding: 4px 8px; background-color: #f5f5f5;">阶段</th><th style="border: 1px solid #ccc; padding: 4px 8px; background-color: #f5f5f5;">进度</th></tr></thead><tbody><tr><td style="border: 1px solid #ccc; padding: 4px 8px;">方案设计</td><td style="border: 1px solid #ccc; padding: 4px 8px;">已完成</td></tr></tbody></table><p>收益：预期 a；实际 b</p></li><li><p><strong>告警排查</strong>：结论</p></li></ol>');
});

test('archivePlan never overwrites an existing summary or an earlier .new.md', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okr-arch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const feishu = { status: 'ok', date: '2026-10-16' };
  const w = { start: new Date(0), end: new Date('2026-10-16T05:40:00Z') };
  assert.equal(path.basename(archivePlan(dir, feishu, w).path), '2026-10-16.md');
  fs.writeFileSync(path.join(dir, '2026-10-16.md'), 'x');
  assert.equal(path.basename(archivePlan(dir, feishu, w).path), '2026-10-16.new.md');
  fs.writeFileSync(path.join(dir, '2026-10-16.new.md'), 'x');
  assert.equal(path.basename(archivePlan(dir, feishu, w).path), '2026-10-16.new-2.md');
});

test('collectRequirementDocs lists stage dates only for requirements touched this week', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'okr-req-'));
  try {
    const put = (rel, iso) => {
      const f = path.join(root, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'x');
      fs.utimesSync(f, new Date(iso), new Date(iso));
    };
    put('reqA/requirements/summary.md', '2026-10-20T02:00:00Z');
    put('reqA/solution-design/v1/solution.md', '2026-10-22T02:00:00Z');
    put('reqB/requirements/summary.md', '2026-09-01T02:00:00Z');
    put('archive/old/requirements/summary.md', '2026-10-21T02:00:00Z');
    const window = { start: new Date('2026-10-18T16:00:00Z'), end: new Date('2026-10-23T05:40:00Z') };
    const out = collectRequirementDocs(root, window);
    assert.equal(out.status, 'ok');
    assert.deepEqual(out.requirements.map((r) => r.name), ['reqA']);
    assert.equal(out.requirements[0].summary, path.join(root, 'reqA', 'requirements', 'summary.md'));
    // 创建时间是今天，比设置的修改时间晚，因此最早日期取修改时间
    assert.deepEqual(out.requirements[0].stages, [
      { stage: 'requirements', first: '2026-10-20', last: '2026-10-20' },
      { stage: 'solution-design', first: '2026-10-22', last: '2026-10-22' },
    ]);
    assert.equal(collectRequirementDocs(path.join(root, 'missing'), window).status, 'error');
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
});
