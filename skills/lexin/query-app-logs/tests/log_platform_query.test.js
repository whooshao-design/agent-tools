'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPayload,
  buildQuery,
  formatTime,
  normalizeRow,
  parseArgs,
  parseDuration,
  parseLevel,
  parseTime,
  resolveRange,
  shouldFetchNextPage,
} = require('../scripts/log_platform_query');

const NOW = Date.UTC(2026, 8, 16, 9, 0, 0); // 2026-09-16 17:00:00 Asia/Shanghai

test('parses repeated --keyword and both --k=v / --k v forms', () => {
  const args = parseArgs(['--app=server_x', '--keyword', 'a b', '--keyword=c', '--order', 'asc', '--flag']);
  assert.equal(args.app, 'server_x');
  assert.deepEqual(args.keyword, ['a b', 'c']);
  assert.equal(args.order, 'asc');
  assert.equal(args.flag, true);
});

test('interprets naive times as Asia/Shanghai and formats them back', () => {
  const ms = parseTime('2026-09-16 17:00:00', 'from');
  assert.equal(ms, NOW);
  assert.equal(parseTime('2026-09-16', 'from'), Date.UTC(2026, 8, 15, 16, 0, 0));
  assert.equal(parseTime('1789549200000', 'from'), 1789549200000);
  assert.equal(parseTime('2026-09-16T09:00:00.000Z', 'from'), NOW);
  assert.equal(formatTime(NOW), '2026-09-16 17:00:00.000');
  assert.throws(() => parseTime('yesterday', 'from'), /invalid from time/);
});

test('resolves the window from --last, --from/--to or the default last hour', () => {
  assert.equal(parseDuration('30m'), 30 * 60000);
  assert.equal(parseDuration('3d'), 3 * 86400000);
  assert.throws(() => parseDuration('1w'), /invalid duration/);
  assert.deepEqual(resolveRange({ last: '2h' }, NOW), { from: NOW - 7200000, to: NOW });
  assert.deepEqual(resolveRange({}, NOW), { from: NOW - 3600000, to: NOW });
  assert.deepEqual(resolveRange({ from: '2026-09-16 10:00', to: '2026-09-16 11:00' }, NOW),
    { from: Date.UTC(2026, 8, 16, 2, 0), to: Date.UTC(2026, 8, 16, 3, 0) });
  assert.throws(() => resolveRange({ from: '2026-09-16 12:00', to: '2026-09-16 11:00' }, NOW), /earlier than/);
});

test('requires --app and rejects unknown enum values', () => {
  assert.throws(() => buildQuery({}, NOW), /--app is required/);
  assert.throws(() => buildQuery({ app: 'x', type: 'warn' }, NOW), /unsupported type/);
  assert.throws(() => buildQuery({ app: 'x', env: 'stable' }, NOW), /unsupported env/);
  assert.throws(() => buildQuery({ app: 'x', order: 'random' }, NOW), /unsupported order/);
  const query = buildQuery({ app: ' server_x ', type: 'ERROR', env: 'Pre', keyword: ['k1', ' ', 'k2'], 'keyword-mode': 'or', 'page-size': '9999' }, NOW);
  assert.equal(query.app, 'server_x');
  assert.equal(query.type, 'error');
  assert.equal(query.env, 'pre');
  assert.deepEqual(query.keywords, ['k1', 'k2']);
  assert.equal(query.keywordMode, 'or');
  assert.equal(query.pageSize, 500);
  assert.equal(query.maxPages, 1);
});

test('builds the archLog/page payload with the codes the page sends', () => {
  const query = buildQuery({ app: 'server_x', type: 'dubbo', env: 'gray', 'trace-id': 'T1', ip: '10.0.0.1', service: 'Svc', method: 'm', uid: '7', keyword: ['a', 'b'], 'keyword-mode': 'or', order: 'asc', page: 2, 'page-size': 50 }, NOW);
  const payload = buildPayload({ ...query, userName: 'joney' });
  assert.equal(payload.type, 3);
  assert.equal(payload.env, 'gray');
  assert.equal(payload.filterType, 2);
  assert.equal(payload.orderType, false);
  assert.deepEqual(payload.filters, [{ type: 1, value: 'a' }, { type: 1, value: 'b' }]);
  assert.deepEqual(payload.domains, [{ value: 'a' }, { value: 'b' }]);
  assert.equal(payload.tid, 'T1');
  assert.equal(payload.cls, 'Svc');
  assert.equal(payload.mth, 'm');
  assert.equal(payload.page, 2);
  assert.equal(payload.limit, 50);
  assert.equal(payload.min, 'joney');
  assert.deepEqual(payload.times, [new Date(query.from).toISOString(), new Date(query.to).toISOString()]);
  const defaults = buildPayload({ ...buildQuery({ app: 'server_x' }, NOW), userName: 'u' });
  assert.equal(defaults.type, 10);
  assert.equal(defaults.env, '');
  assert.deepEqual(defaults.domains, [{ value: '' }]);
  assert.deepEqual(defaults.filters, []);
  assert.equal(defaults.orderType, true);
});

test('extracts the level from the pipe-delimited body and truncates long bodies', () => {
  const body = '2026-09-16 17:00:06.976|245|0A0E45B5|0|ERROR|com.x.Svc|run|121|UID=,ENV=prod|boom\n\tat com.x.Svc.run';
  assert.equal(parseLevel(body), 'ERROR');
  assert.equal(parseLevel('plain text'), null);
  const row = normalizeRow({ time: NOW, env: 'prod', ip: '10.1.1.1', tid: 'T', cls: 'com.x.Svc', mth: 'run', uid: '', body }, 40);
  assert.equal(row.time, '2026-09-16 17:00:00.000');
  assert.equal(row.level, 'ERROR');
  assert.equal(row.body.length, 40);
  assert.equal(row.bodyTruncated, true);
});

test('stops paging at max-pages, an empty page or the last page, but not at a de-duplicated short page', () => {
  assert.equal(shouldFetchNextPage({ pagesFetched: 1, maxPages: 1, lastRowCount: 100, nextPage: 2, totalPage: 5 }), false);
  assert.equal(shouldFetchNextPage({ pagesFetched: 1, maxPages: 3, lastRowCount: 0, nextPage: 2, totalPage: 5 }), false);
  assert.equal(shouldFetchNextPage({ pagesFetched: 1, maxPages: 3, lastRowCount: 100, nextPage: 2, totalPage: 1 }), false);
  assert.equal(shouldFetchNextPage({ pagesFetched: 1, maxPages: 3, lastRowCount: 40, nextPage: 2, totalPage: 5 }), true);
  assert.equal(shouldFetchNextPage({ pagesFetched: 1, maxPages: 3, lastRowCount: 40, nextPage: 2, totalPage: NaN }), true);
});
