'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  asBoolean,
  groupLogEvents,
  normalizeQuery,
  parseLogFiles,
  queryLogText,
} = require('../scripts/log_query');

const SAMPLE = [
  '2026-07-13 11:39:00.001 |INFO| before',
  '2026-07-13 11:39:32.100 |ERROR| trace=TRACE-1 ruleId=4344229 invalid json',
  'java.lang.IllegalArgumentException: parse failed',
  '\tat demo.Parser.parse(Parser.java:10)',
  '2026-07-13 11:40:00.000 |INFO| after',
  'continuation',
].join('\n');

test('multiline stack traces stay attached to their timestamp event', () => {
  const events = groupLogEvents(SAMPLE, 'error.log');
  assert.equal(events.length, 3);
  assert.match(events[1].text, /IllegalArgumentException/);
  assert.match(events[1].text, /Parser\.java:10/);
});

test('trace, rule and time filters return a complete event with event context', () => {
  const query = normalizeQuery({
    from: '2026-07-13 11:39:00',
    to: '2026-07-13 11:39:59',
    'trace-id': 'TRACE-1',
    'rule-id': '4344229',
    context: '1',
  });
  const result = queryLogText(SAMPLE, query, 'error.log');
  assert.equal(result.matchedEvents, 1);
  assert.equal(result.returnedEvents.length, 3);
  assert.equal(result.returnedEvents[1].role, 'match');
  assert.match(result.returnedEvents[1].text, /parse failed/);
});

test('result byte and line bounds report truncation', () => {
  const query = normalizeQuery({ 'max-lines': '2', 'max-bytes': '1024' });
  const result = queryLogText(SAMPLE, query, 'error.log');
  assert.equal(result.truncated, true);
  assert.ok(result.returnedEvents.length >= 1);
});

test('only fixed log file names are accepted', () => {
  assert.deepEqual(parseLogFiles('error.log,info.log'), ['error.log', 'info.log']);
  assert.throws(() => parseLogFiles('../../etc/passwd'), /unsupported log file/);
});

test('invalid time ranges and excessive limits are rejected', () => {
  assert.throws(() => normalizeQuery({ from: '2026-07-13 12:00:00', to: '2026-07-13 11:00:00' }), /must not be later/);
  assert.throws(() => normalizeQuery({ 'max-bytes': String(20 * 1024 * 1024) }), /max-bytes/);
});

test('boolean flags and control characters are normalized safely', () => {
  assert.equal(asBoolean('false', true), false);
  assert.equal(asBoolean(undefined, true), true);
  assert.throws(() => normalizeQuery({ keyword: 'bad\nvalue' }), /control line breaks/);
});

test('a single oversized event is hard-truncated within line and byte limits', () => {
  const text = `2026-07-13 11:39:00 |ERROR| ${'错误'.repeat(2000)}`;
  const query = normalizeQuery({ 'max-lines': '1', 'max-bytes': '1024' });
  const result = queryLogText(text, query, 'error.log');
  assert.equal(result.truncated, true);
  assert.equal(result.returnedEvents[0].partial, true);
  assert.ok(result.returnedBytes <= 1024);
});

test('text before the first timestamp remains attached to a standalone event', () => {
  const events = groupLogEvents('banner\n2026-07-13 11:39:00 |INFO| started', 'stdout.log');
  assert.equal(events.length, 2);
  assert.equal(events[0].timestamp, '');
  assert.equal(events[0].text, 'banner');
});
