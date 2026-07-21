'use strict';

const ALLOWED_LOG_FILES = new Set(['error.log', 'info.log', 'warn.log', 'debug.log', 'stdout.log']);
const TIMESTAMP_PATTERN = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/;

function asBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function boundedInteger(value, defaultValue, min, max, name) {
  const number = value === undefined ? defaultValue : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function normalizeTimestamp(value) {
  if (!value) return '';
  const match = String(value).match(TIMESTAMP_PATTERN);
  if (!match) throw new Error(`invalid timestamp: ${value}; expected YYYY-MM-DD HH:mm:ss`);
  return `${match[1]} ${match[2]}`;
}

function timestampOf(line) {
  const match = String(line || '').match(TIMESTAMP_PATTERN);
  return match ? `${match[1]} ${match[2]}` : '';
}

function parseLogFiles(value, defaults = ['error.log']) {
  const files = String(value || defaults.join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!files.length) throw new Error('at least one log file is required');
  for (const file of files) {
    if (!ALLOWED_LOG_FILES.has(file)) throw new Error(`unsupported log file: ${file}`);
  }
  return Array.from(new Set(files));
}

function safeLiteral(value, name, maxLength = 256) {
  const text = String(value || '');
  if (text.length > maxLength) throw new Error(`${name} must not exceed ${maxLength} characters`);
  if (/[\u0000\r\n]/.test(text)) throw new Error(`${name} must not contain control line breaks`);
  return text;
}

function normalizeQuery(args = {}) {
  const from = normalizeTimestamp(args.from || '');
  const to = normalizeTimestamp(args.to || '');
  if (from && to && from > to) throw new Error('--from must not be later than --to');
  const context = boundedInteger(args.context, 0, 0, 20, '--context');
  return {
    from,
    to,
    traceId: safeLiteral(args['trace-id'] || args.traceId, '--trace-id'),
    ruleId: safeLiteral(args['rule-id'] || args.ruleId, '--rule-id'),
    keyword: safeLiteral(args.keyword, '--keyword'),
    contextBefore: boundedInteger(args['context-before'], context, 0, 20, '--context-before'),
    contextAfter: boundedInteger(args['context-after'], context, 0, 20, '--context-after'),
    maxLines: boundedInteger(args['max-lines'], 500, 1, 5000, '--max-lines'),
    maxBytes: boundedInteger(args['max-bytes'], 1024 * 1024, 1024, 10 * 1024 * 1024, '--max-bytes'),
    includeRotated: asBoolean(args['include-rotated'], false),
    files: parseLogFiles(args.files, ['error.log']),
  };
}

function groupLogEvents(text, source = '') {
  const events = [];
  let current = null;
  const lines = String(text || '').replace(/\r/g, '').split('\n');

  const flush = () => {
    if (!current || current.lines.length === 0) return;
    current.text = current.lines.join('\n');
    events.push(current);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const timestamp = timestampOf(line);
    if (timestamp) {
      flush();
      current = { source, timestamp, lineStart: index + 1, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else if (line) {
      current = { source, timestamp: '', lineStart: index + 1, lines: [line] };
    }
  }
  flush();
  return events;
}

function matchesEvent(event, query) {
  if (query.from && (!event.timestamp || event.timestamp < query.from)) return false;
  if (query.to && (!event.timestamp || event.timestamp > query.to)) return false;
  const needles = [query.traceId, query.ruleId, query.keyword].filter(Boolean);
  return needles.every((needle) => event.text.includes(needle));
}

function withContext(events, matchedIndexes, before, after) {
  const selected = new Map();
  const matched = new Set(matchedIndexes);
  for (const index of matchedIndexes) {
    const start = Math.max(0, index - before);
    const end = Math.min(events.length - 1, index + after);
    for (let cursor = start; cursor <= end; cursor += 1) selected.set(cursor, true);
  }
  return Array.from(selected.keys()).sort((a, b) => a - b).map((index) => ({
    ...events[index],
    role: matched.has(index) ? 'match' : (index < matchedIndexes.find((item) => item >= index) ? 'context_before' : 'context_after'),
  }));
}

function limitEvents(events, maxLines, maxBytes) {
  const accepted = [];
  let lines = 0;
  let bytes = 0;
  let truncated = false;
  for (const event of events) {
    const eventLines = event.text.split('\n').length;
    const eventBytes = Buffer.byteLength(event.text, 'utf8');
    if (accepted.length === 0 && (eventLines > maxLines || eventBytes > maxBytes)) {
      const lineLimited = event.text.split('\n').slice(0, maxLines).join('\n');
      let byteLimited = '';
      let usedBytes = 0;
      for (const character of lineLimited) {
        const size = Buffer.byteLength(character, 'utf8');
        if (usedBytes + size > maxBytes) break;
        byteLimited += character;
        usedBytes += size;
      }
      accepted.push({ ...event, text: byteLimited, partial: true });
      lines = byteLimited.split('\n').length;
      bytes = usedBytes;
      truncated = true;
      break;
    }
    if (accepted.length > 0 && (lines + eventLines > maxLines || bytes + eventBytes > maxBytes)) {
      truncated = true;
      break;
    }
    accepted.push(event);
    lines += eventLines;
    bytes += eventBytes;
    if (lines >= maxLines || bytes >= maxBytes) {
      truncated = accepted.length < events.length;
      break;
    }
  }
  return { events: accepted, lines, bytes, truncated };
}

function queryLogText(text, args = {}, source = 'kubectl') {
  const query = args.files ? args : normalizeQuery(args);
  const events = groupLogEvents(text, source);
  const matchedIndexes = [];
  for (let index = 0; index < events.length; index += 1) {
    if (matchesEvent(events[index], query)) matchedIndexes.push(index);
  }
  const selected = withContext(events, matchedIndexes, query.contextBefore, query.contextAfter);
  const limited = limitEvents(selected, query.maxLines, query.maxBytes);
  return {
    query,
    totalEvents: events.length,
    matchedEvents: matchedIndexes.length,
    returnedEvents: limited.events,
    returnedLines: limited.lines,
    returnedBytes: limited.bytes,
    truncated: limited.truncated,
  };
}

module.exports = {
  ALLOWED_LOG_FILES,
  asBoolean,
  groupLogEvents,
  normalizeQuery,
  normalizeTimestamp,
  parseLogFiles,
  queryLogText,
  timestampOf,
};
