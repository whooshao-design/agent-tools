'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  buildForensicsCommand,
  forensicsAwkProgram,
  parseForensics,
  parseSummary,
} = require('../scripts/webshell_log_check');
const { normalizeQuery } = require('../scripts/log_query');

test('forensics command only reads allowed current and rotated logs with explicit bounds', () => {
  const query = normalizeQuery({
    files: 'error.log,info.log',
    'trace-id': 'TRACE-1',
    'include-rotated': true,
    'max-lines': '300',
    'max-bytes': '65536',
  });
  const command = buildForensicsCommand({ app: 'server_demo' }, query);
  assert.match(command, /gzip -cd/);
  assert.ok(command.includes('"$logDir/${stem}"_*.log.gz'));
  assert.match(command, /maxBytes=65536/);
  assert.match(command, /__EVENT_BEGIN__\|truncated=1/);
  assert.doesNotMatch(command, /rm |tee |chmod |kill /);
  const syntax = spawnSync('bash', ['-n'], { input: command, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('forensics parser retains complete multiline events and limit metadata', () => {
  const query = normalizeQuery({ 'trace-id': 'TRACE-1' });
  const text = [
    '__LEXIAO_FORENSICS_BEGIN__',
    '__FILE_BEGIN__ /home/product/logs/app_logs/error.log',
    '__EVENT_BEGIN__ role=match timestamp=2026-07-13 11:39:32',
    '2026-07-13 11:39:32 |ERROR| TRACE-1',
    'java.lang.IllegalArgumentException',
    '__EVENT_END__',
    '__FILE_END__',
    '__FORENSICS_META__ actualLines=8 actualBytes=200 maxLines=500 maxBytes=1048576 truncated=0',
    '__LEXIAO_FORENSICS_END__',
  ].join('\n');
  const result = parseForensics(text, query);
  assert.equal(result.matchedEvents, 1);
  assert.equal(result.events.length, 1);
  assert.match(result.events[0].text, /IllegalArgumentException/);
  assert.equal(result.truncated, false);
});

test('forensics awk executes and keeps stack lines in the matched event', () => {
  const sample = [
    '2026-07-13 11:39:00 |INFO| before',
    '2026-07-13 11:39:32 |ERROR| TRACE-1',
    'java.lang.IllegalStateException: failed',
    '\tat demo.Service.run(Service.java:10)',
    '2026-07-13 11:40:00 |INFO| after',
  ].join('\n');
  const result = spawnSync('awk', [
    '-v', 'fromTs=2026-07-13 11:39:00',
    '-v', 'toTs=2026-07-13 11:39:59',
    '-v', 'needle1=TRACE-1',
    '-v', 'needle2=',
    '-v', 'needle3=',
    '-v', 'before=1',
    '-v', 'after=1',
    '-v', 'maxEvents=20',
    '-v', 'maxEventChars=65536',
    '-v', 'maxOutputLines=100',
    '-v', 'maxOutputChars=65536',
    forensicsAwkProgram(),
  ], { input: sample, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /role=match/);
  assert.match(result.stdout, /IllegalStateException/);
  assert.match(result.stdout, /Service\.java:10/);
});

test('quick summary exposes a missing log directory and error.log', () => {
  const text = [
    '__LOG_DIR_STATUS__ MISSING',
    '__ERROR_RECENT__',
    '## error.log',
    'MISSING',
    '__LEVEL_ERROR_RECENT__',
  ].join('\n');
  const summary = parseSummary(text);
  assert.equal(summary.logDirExists, false);
  assert.deepEqual(summary.recentExceptionMissingFiles, ['error.log']);
});
