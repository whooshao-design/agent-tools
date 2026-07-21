#!/usr/bin/env node
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const {
  buildBrowserEnv,
  chromiumArgsFor,
  redactUrl,
  validateWebShellUrl,
} = require('../../get-browser-session/scripts/browser_network');
const {
  DEFAULT_LOGIN_PATTERN,
  DEFAULT_PORTAL_PATTERN,
  waitForStableSession,
} = require('../../get-browser-session/scripts/browser_session');
const { asBoolean, normalizeQuery } = require('./log_query');

const TOOL_DIR = path.join(os.homedir(), 'tools/lexiao-browser');
const DEFAULT_PROFILE = path.join(os.homedir(), '.codex/webshell-direct-profile');
const CHROME_PATH = path.join(TOOL_DIR, 'browsers/chrome-linux64/chrome');
const RUNTIME_LIB_DIR = path.join(TOOL_DIR, 'runtime-libs/usr/lib/x86_64-linux-gnu');
const chromium = createRequire(path.join(TOOL_DIR, 'package.json'))('playwright').chromium;
const LOG_BEGIN_MARKER = '__LEXIAO_WEB_SHELL_LOG_BEGIN__';
const LOG_END_MARKER = '__LEXIAO_WEB_SHELL_LOG_END__';
const FORENSICS_BEGIN_MARKER = '__LEXIAO_FORENSICS_BEGIN__';
const FORENSICS_END_MARKER = '__LEXIAO_FORENSICS_END__';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq !== -1) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[item.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args[item.slice(2)] = true;
    }
  }
  return args;
}

function usage() {
  console.log(`Usage:
  webshell_log_check.js --url=<login_pod_addr> --app=<app_name> [options]

Transport:
  --mode=auto|gotty|dom       Default auto
  --profile=<browser-profile> Default ~/.codex/webshell-direct-profile
  --headed                    Show Chromium window

Log query:
  --log-mode=quick|forensics  Quick checks error.log; forensics groups multiline events
  --since-minutes=60          Quick-mode lower time bound
  --include-startup           Also inspect stdout/info startup markers in quick mode
  --from="YYYY-MM-DD HH:mm:ss" --to="YYYY-MM-DD HH:mm:ss"
  --trace-id=<id> --rule-id=<id> --keyword=<literal>
  --files=error.log,info.log  Fixed allowlist only
  --context=2                 Event context before and after, max 20
  --include-rotated           Include .log and .log.gz rotations
  --max-lines=500 --max-bytes=1048576
`);
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function cleanTerminalText(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatLocalMinute(date) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('-') + ' ' + [pad2(date.getHours()), pad2(date.getMinutes())].join(':');
}

function resolveSince(args) {
  if (args.since && String(args.since).toLowerCase() !== 'all') return args.since;
  if (String(args.since || '').toLowerCase() === 'all') return '';
  const minutes = Number(args['since-minutes'] || 60);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  return formatLocalMinute(new Date(Date.now() - minutes * 60 * 1000));
}

function wrapCommand(command) {
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  return [
    "base64 -d <<'__LEXIAO_LOG_SCRIPT_B64__' | bash",
    encoded,
    '__LEXIAO_LOG_SCRIPT_B64__',
  ].join('\n') + '\n';
}

function extractLogText(output) {
  const text = cleanTerminalText(output);
  const begin = text.indexOf(LOG_BEGIN_MARKER);
  const end = text.indexOf(LOG_END_MARKER);
  if (begin === -1 || end === -1 || end < begin) return text.trim();
  return text.slice(begin, end + LOG_END_MARKER.length).trim();
}

function parseCountSection(lines, startMarker, stopMarkers) {
  const counts = {};
  const recent = {};
  const missing = [];
  let activeFile = null;
  let inSection = false;
  for (const line of lines) {
    if (line === startMarker) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (stopMarkers.includes(line)) break;
    const fileMatch = line.match(/^##\s+(.+)$/);
    if (fileMatch) {
      activeFile = fileMatch[1];
      recent[activeFile] = [];
      continue;
    }
    const countMatch = line.match(/^count=(\d+)$/);
    if (countMatch && activeFile) {
      counts[activeFile] = Number(countMatch[1]);
      continue;
    }
    if (activeFile && line === 'MISSING') {
      missing.push(activeFile);
      continue;
    }
    if (activeFile && line) {
      recent[activeFile].push(line);
    }
  }
  return { counts, recent, missing };
}

function parseSummary(text) {
  const lines = String(text || '').split('\n').map((line) => line.trimEnd());
  const summary = {
    scope: {},
    logDirExists: null,
    logFiles: [],
    stdout: { path: '', exists: false, count: null, recent: [] },
    recentExceptionCounts: {},
    recentExceptionLines: {},
    recentExceptionMissingFiles: [],
    levelErrorCounts: {},
    levelErrorLines: {},
    startupMarkerCounts: {},
    startupMarkerLines: {},
    healthRecent: '',
  };

  const logDirStatus = lines.find((line) => line.startsWith('__LOG_DIR_STATUS__ '));
  if (logDirStatus) summary.logDirExists = logDirStatus.endsWith(' OK');

  const scopeLine = lines.find((line) => line.startsWith('__LOG_SCOPE__ '));
  if (scopeLine) {
    const scopeMatch = scopeLine.match(/^__LOG_SCOPE__ app=(.*?) since=(.*?) version=(.*)$/);
    if (scopeMatch) {
      summary.scope = {
        app: scopeMatch[1],
        since: scopeMatch[2],
        version: scopeMatch[3],
      };
    } else {
      for (const part of scopeLine.replace('__LOG_SCOPE__ ', '').split(/\s+/)) {
        const index = part.indexOf('=');
        if (index > 0) summary.scope[part.slice(0, index)] = part.slice(index + 1);
      }
    }
  }

  const logFilesStart = lines.indexOf('__LOG_FILES__');
  const versionStart = lines.indexOf('__VERSION_STDOUT__');
  if (logFilesStart !== -1 && versionStart > logFilesStart) {
    summary.logFiles = lines.slice(logFilesStart + 1, versionStart).filter(Boolean);
  }

  const errorStart = lines.indexOf('__ERROR_RECENT__');
  if (versionStart !== -1 && errorStart > versionStart) {
    const stdoutLines = lines.slice(versionStart + 1, errorStart).filter(Boolean);
    summary.stdout.path = ['SKIPPED', 'NO_STDOUT_LOG'].includes(stdoutLines[0]) ? '' : (stdoutLines[0] || '');
    summary.stdout.exists = Boolean(summary.stdout.path && !stdoutLines.includes('NO_STDOUT_LOG'));
    const stdoutCount = stdoutLines.find((line) => /^count=\d+$/.test(line));
    if (stdoutCount) summary.stdout.count = Number(stdoutCount.slice('count='.length));
    summary.stdout.recent = stdoutLines.filter((line) => line !== summary.stdout.path && line !== stdoutCount && line !== 'NO_STDOUT_LOG');
  }

  const recent = parseCountSection(lines, '__ERROR_RECENT__', ['__LEVEL_ERROR_RECENT__', '__STARTUP_MARKERS__', '__HEALTH_RECENT__', LOG_END_MARKER]);
  summary.recentExceptionCounts = recent.counts;
  summary.recentExceptionLines = recent.recent;
  summary.recentExceptionMissingFiles = recent.missing;

  const level = parseCountSection(lines, '__LEVEL_ERROR_RECENT__', ['__STARTUP_MARKERS__', '__HEALTH_RECENT__', LOG_END_MARKER]);
  summary.levelErrorCounts = level.counts;
  summary.levelErrorLines = level.recent;

  const startup = parseCountSection(lines, '__STARTUP_MARKERS__', ['__HEALTH_RECENT__', LOG_END_MARKER]);
  summary.startupMarkerCounts = startup.counts;
  summary.startupMarkerLines = startup.recent;

  const healthStart = lines.indexOf('__HEALTH_RECENT__');
  const end = lines.indexOf(LOG_END_MARKER);
  if (healthStart !== -1 && end > healthStart) {
    summary.healthRecent = lines.slice(healthStart + 1, end).filter(Boolean).join('\n');
  }

  return summary;
}

async function openContext(args) {
  const ldLibraryPath = [RUNTIME_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const network = buildBrowserEnv(args.url, process.env);
  const context = await chromium.launchPersistentContext(args.profile || DEFAULT_PROFILE, {
    executablePath: args.chrome || CHROME_PATH,
    headless: !args.headed,
    viewport: { width: Number(args.width || 1800), height: Number(args.height || 1200) },
    env: { ...network.env, LD_LIBRARY_PATH: ldLibraryPath },
    args: chromiumArgsFor(args.url, ['--no-sandbox']),
  });
  return { context, networkPolicy: network.networkPolicy };
}

function buildCommand(args, lines) {
  const appName = args.app;
  const startupPattern = 'Dubbo run OK|Dubbo service.*started|Started .*Application|Started .* in [0-9].* seconds|启动成功|项目启动成功|init finished.*cost[=: ]*[0-9]+|duration[=: ]*[0-9]+|耗时 *[0-9]+';
  const errorPattern = 'ERROR|Exception|Throwable|Caused by';
  const since = resolveSince(args);
  const version = args.version || '';
  const includeStartup = asBoolean(args['include-startup'], false);
  const startupLimit = Math.max(2, Math.min(lines, 50));
  const errorLimit = Math.max(2, Math.min(lines, 500));
  const sample = `awk '{print substr($0,1,4096)}'`;
  return [
    `app=${shellQuote(appName)}`,
    `since=${shellQuote(since)}`,
    `version=${shellQuote(version)}`,
    'logDir="/home/product/logs/${app}_logs"',
    'publishRoot="/home/publish_product/server_java/${app}"',
    'filter_log() { if [ -n "$since" ]; then awk -v s="$since" \'match($0,/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]/){ts=substr($0,RSTART,16); if (ts>=s) print}\' "$1"; else cat "$1"; fi; }',
    `echo ${LOG_BEGIN_MARKER}`,
    'pwd',
    'hostname',
    'whoami',
    `echo __LOG_SCOPE__ app="$app" since="\${since:-ALL}" version="\${version:-AUTO}"`,
    'if [ -d "$logDir" ]; then echo __LOG_DIR_STATUS__ OK; else echo __LOG_DIR_STATUS__ MISSING; fi',
    `echo __LOG_FILES__; ls -l "$logDir"/ 2>/dev/null | tail -12 | ${sample}`,
    includeStartup
      ? `echo __VERSION_STDOUT__; stdout=''; if [ -n "$version" ]; then stdout="$publishRoot/$version/logs/stdout.log"; fi; if [ -z "$stdout" ]; then stdout=$(find "$publishRoot" -maxdepth 3 -name stdout.log 2>/dev/null | sort | tail -1); fi; echo "$stdout"; if [ -f "$stdout" ]; then echo "count=$(filter_log "$stdout" | grep -E -i '${startupPattern}|${errorPattern}' | wc -l)"; filter_log "$stdout" | grep -E -n -i '${startupPattern}|${errorPattern}' | tail -${startupLimit} | ${sample}; else echo NO_STDOUT_LOG; fi`
      : 'echo __VERSION_STDOUT__; echo SKIPPED',
    `echo __ERROR_RECENT__`,
    `for f in error.log; do echo "## $f"; if [ -f "$logDir/$f" ]; then echo "count=$(filter_log "$logDir/$f" | grep -E -i '${errorPattern}' | wc -l)"; filter_log "$logDir/$f" | grep -E -n -i '${errorPattern}' | tail -${errorLimit} | ${sample}; else echo MISSING; fi; done`,
    `echo __LEVEL_ERROR_RECENT__`,
    `for f in error.log; do echo "## $f"; if [ -f "$logDir/$f" ]; then echo "count=$(filter_log "$logDir/$f" | grep -F '|ERROR|' | wc -l)"; filter_log "$logDir/$f" | grep -F -n '|ERROR|' | tail -${errorLimit} | ${sample}; else echo MISSING; fi; done`,
    `echo __STARTUP_MARKERS__`,
    includeStartup
      ? `for f in debug.log info.log; do echo "## $f"; if [ -f "$logDir/$f" ]; then echo "count=$(filter_log "$logDir/$f" | grep -E -i '${startupPattern}' | wc -l)"; filter_log "$logDir/$f" | grep -E -n -i '${startupPattern}' | tail -${startupLimit} | ${sample}; else echo MISSING; fi; done`
      : 'echo SKIPPED',
    `echo __HEALTH_RECENT__`,
    includeStartup
      ? `grep -E -n -i 'service port|serverResource' "$logDir/info.log" 2>/dev/null | tail -1 | ${sample}`
      : 'echo SKIPPED',
    `echo ${LOG_END_MARKER}`,
  ].join('\n') + '\n';
}

function forensicsAwkProgram() {
  return [
    'BEGIN { emitted=0; emittedLines=0; emittedChars=0; truncated=0 }',
    'function countLines(body, copy) { copy=body; return gsub(/\\n/, "\\n", copy)+1 }',
    'function emit(role, body, ts, bodyLines, bodyChars) {',
    '  bodyLines=countLines(body)',
    '  bodyChars=length(body)+96',
    '  if (emitted >= maxEvents || emittedLines+bodyLines > maxOutputLines || emittedChars+bodyChars > maxOutputChars) { truncated=1; return }',
    '  print "__EVENT_BEGIN__ role=" role " timestamp=" ts',
    '  print body',
    '  print "__EVENT_END__"',
    '  emitted++',
    '  emittedLines+=bodyLines+2',
    '  emittedChars+=bodyChars',
    '}',
    'function remember(body, ts, i) {',
    '  if (before <= 0) return',
    '  if (prevCount < before) {',
    '    prevCount++',
    '    prevBody[prevCount]=body',
    '    prevTs[prevCount]=ts',
    '    return',
    '  }',
    '  for (i=1; i<before; i++) { prevBody[i]=prevBody[i+1]; prevTs[i]=prevTs[i+1] }',
    '  prevBody[before]=body',
    '  prevTs[before]=ts',
    '}',
    'function wanted(body, ts) {',
    '  if (fromTs != "" && (ts == "" || ts < fromTs)) return 0',
    '  if (toTs != "" && (ts == "" || ts > toTs)) return 0',
    '  if (needle1 != "" && index(body, needle1) == 0) return 0',
    '  if (needle2 != "" && index(body, needle2) == 0) return 0',
    '  if (needle3 != "" && index(body, needle3) == 0) return 0',
    '  return 1',
    '}',
    'function flush(i, isMatch) {',
    '  if (event == "") return',
    '  if (eventTruncated) event=event "\\n__EVENT_TRUNCATED__"',
    '  isMatch=wanted(event, eventTs)',
    '  if (isMatch) {',
    '    for (i=1; i<=prevCount; i++) emit("context_before", prevBody[i], prevTs[i])',
    '    delete prevBody; delete prevTs; prevCount=0',
    '    emit("match", event, eventTs)',
    '    remainingAfter=after',
    '  } else if (remainingAfter > 0) {',
    '    emit("context_after", event, eventTs)',
    '    remainingAfter--',
    '  } else {',
    '    remember(event, eventTs)',
    '  }',
    '  event=""; eventTs=""; eventTruncated=0',
    '}',
    '{',
    '  ts=""',
    '  if (match($0, /[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][ T][0-9][0-9]:[0-9][0-9]:[0-9][0-9]/)) ts=substr($0,RSTART,19)',
    '  gsub(/T/, " ", ts)',
    '  if (ts != "") { flush(); event=substr($0,1,maxEventChars); eventTs=ts; eventTruncated=(length($0)>maxEventChars) }',
    '  else if (event != "") { if (length(event)+length($0)+1 <= maxEventChars) event=event "\\n" $0; else eventTruncated=1 }',
    '  else { event=substr($0,1,maxEventChars); eventTs=""; eventTruncated=(length($0)>maxEventChars) }',
    '}',
    'END { flush(); print "__AWK_META__ emitted=" emitted " emittedLines=" emittedLines " emittedChars=" emittedChars " truncated=" (truncated ? 1 : 0) }',
  ].join('\n');
}

function buildForensicsCommand(args, query) {
  const maxEvents = Math.min(query.maxLines, 500);
  const maxEventChars = Math.min(query.maxBytes, 256 * 1024);
  const awkProgram = forensicsAwkProgram();
  return [
    `app=${shellQuote(args.app)}`,
    `files=${shellQuote(query.files.join(' '))}`,
    `includeRotated=${query.includeRotated ? '1' : '0'}`,
    `fromTs=${shellQuote(query.from)}`,
    `toTs=${shellQuote(query.to)}`,
    `needle1=${shellQuote(query.traceId)}`,
    `needle2=${shellQuote(query.ruleId)}`,
    `needle3=${shellQuote(query.keyword)}`,
    `before=${query.contextBefore}`,
    `after=${query.contextAfter}`,
    `maxEvents=${maxEvents}`,
    `maxEventChars=${maxEventChars}`,
    `maxLines=${query.maxLines}`,
    `maxBytes=${query.maxBytes}`,
    'logDir="/home/product/logs/${app}_logs"',
    'read_log() { case "$1" in *.gz) gzip -cd -- "$1" 2>/dev/null ;; *) cat -- "$1" 2>/dev/null ;; esac; }',
    'list_files() {',
    '  for base in $files; do',
    '    stem=${base%.log}',
    '    if [ "$includeRotated" = "1" ]; then',
    '      for candidate in "$logDir/$base" "$logDir/${stem}"_*.log "$logDir/${stem}"_*.log.gz "$logDir/$base".* "$logDir/$base".*.gz; do',
    '        [ -f "$candidate" ] && printf "%s\\n" "$candidate"',
    '      done',
    '    elif [ -f "$logDir/$base" ]; then',
    '      printf "%s\\n" "$logDir/$base"',
    '    fi',
    '  done | awk \'!seen[$0]++\'',
    '}',
    `echo ${LOG_BEGIN_MARKER}`,
    `echo __LOG_SCOPE__ app="$app" from="\${fromTs:-OPEN}" to="\${toTs:-OPEN}"`,
    'raw="$(list_files | while IFS= read -r file; do',
    `  fileOutput=$(read_log "$file" | awk -v fromTs="$fromTs" -v toTs="$toTs" -v needle1="$needle1" -v needle2="$needle2" -v needle3="$needle3" -v before="$before" -v after="$after" -v maxEvents="$maxEvents" -v maxEventChars="$maxEventChars" -v maxOutputLines="$maxLines" -v maxOutputChars="$maxBytes" ${shellQuote(awkProgram)})`,
    '  if printf "%s\\n" "$fileOutput" | grep -q -E "__EVENT_BEGIN__|truncated=1"; then',
    '    echo "__FILE_BEGIN__ $file"',
    '    printf "%s\\n" "$fileOutput"',
    '    echo "__FILE_END__"',
    '  fi',
    'done)"',
    'actualLines=$(printf "%s\\n" "$raw" | wc -l)',
    'actualBytes=$(printf "%s" "$raw" | wc -c)',
    'fileCount=$(list_files | wc -l)',
    'limited=$(printf "%s\\n" "$raw" | head -n "$maxLines")',
    'limited=$(printf "%s" "$limited" | head -c "$maxBytes")',
    'truncated=0',
    '[ "$actualLines" -gt "$maxLines" ] && truncated=1',
    '[ "$actualBytes" -gt "$maxBytes" ] && truncated=1',
    `echo ${FORENSICS_BEGIN_MARKER}`,
    'if [ -d "$logDir" ]; then echo __LOG_DIR_STATUS__ OK; else echo __LOG_DIR_STATUS__ MISSING; fi',
    'echo "__FILE_COUNT__ $fileCount"',
    'printf "%s\\n" "$limited"',
    'echo "__FORENSICS_META__ actualLines=$actualLines actualBytes=$actualBytes maxLines=$maxLines maxBytes=$maxBytes truncated=$truncated"',
    `echo ${FORENSICS_END_MARKER}`,
    `echo ${LOG_END_MARKER}`,
  ].join('\n') + '\n';
}

function parseForensics(text, query) {
  const lines = String(text || '').split('\n').map((line) => line.replace(/\r$/, ''));
  const begin = lines.indexOf(FORENSICS_BEGIN_MARKER);
  const end = lines.indexOf(FORENSICS_END_MARKER);
  const body = begin !== -1 && end > begin ? lines.slice(begin + 1, end) : lines;
  const events = [];
  const matchedFiles = new Set();
  let currentFile = '';
  let currentEvent = null;
  let meta = {};
  let awkTruncated = false;
  let logDirExists = null;
  let fileCount = 0;

  for (const line of body) {
    if (line.startsWith('__LOG_DIR_STATUS__ ')) {
      logDirExists = line.endsWith(' OK');
      continue;
    }
    if (line.startsWith('__FILE_COUNT__ ')) {
      fileCount = Number(line.slice('__FILE_COUNT__ '.length)) || 0;
      continue;
    }
    if (line.startsWith('__FILE_BEGIN__ ')) {
      currentFile = line.slice('__FILE_BEGIN__ '.length);
      continue;
    }
    if (line === '__FILE_END__') {
      currentFile = '';
      continue;
    }
    const eventStart = line.match(/^__EVENT_BEGIN__ role=(\S+) timestamp=(.*)$/);
    if (eventStart) {
      currentEvent = { file: currentFile, role: eventStart[1], timestamp: eventStart[2], lines: [] };
      continue;
    }
    if (line === '__EVENT_END__' && currentEvent) {
      currentEvent.text = currentEvent.lines.join('\n');
      delete currentEvent.lines;
      events.push(currentEvent);
      if (currentEvent.role === 'match') matchedFiles.add(currentEvent.file);
      currentEvent = null;
      continue;
    }
    const awkMetaMatch = line.match(/^__AWK_META__ .*truncated=(\d+)$/);
    if (awkMetaMatch) {
      if (awkMetaMatch[1] === '1') awkTruncated = true;
      continue;
    }
    const metaMatch = line.match(/^__FORENSICS_META__ actualLines=(\d+) actualBytes=(\d+) maxLines=(\d+) maxBytes=(\d+) truncated=(\d+)$/);
    if (metaMatch) {
      meta = {
        actualLines: Number(metaMatch[1]),
        actualBytes: Number(metaMatch[2]),
        maxLines: Number(metaMatch[3]),
        maxBytes: Number(metaMatch[4]),
        truncated: metaMatch[5] === '1',
      };
      continue;
    }
    if (currentEvent) currentEvent.lines.push(line);
  }

  if (currentEvent) {
    currentEvent.text = currentEvent.lines.join('\n');
    delete currentEvent.lines;
    currentEvent.partial = true;
    events.push(currentEvent);
    meta.truncated = true;
  }
  meta.truncated = Boolean(meta.truncated || awkTruncated);

  return {
    query,
    logDirExists,
    fileCount,
    matchedFiles: Array.from(matchedFiles),
    matchedEvents: events.filter((event) => event.role === 'match').length,
    returnedMatchedEvents: events.filter((event) => event.role === 'match').length,
    events,
    ...meta,
  };
}

async function terminalText(frame) {
  return frame.evaluate(() => Array.from(document.querySelectorAll('x-row')).map((row) => row.innerText || row.textContent || '').join('\n')).catch(() => null);
}

async function runGottyWebSocket(page, command, args) {
  const timeoutMs = Number(args.timeout || 60000);
  return page.evaluate(async ({ command, endMarker, timeoutMs }) => {
    function decodeBase64Utf8(value) {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new TextDecoder().decode(bytes);
    }

    return new Promise((resolve) => {
      let output = '';
      let opened = false;
      let settled = false;
      let socket;
      let timer;

      const settle = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch (_) {
          // Ignore close failures while collecting diagnostics output.
        }
        resolve(value);
      };

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let pathname = location.pathname || '/';
      if (!pathname.endsWith('/')) pathname += '/';
      const wsUrl = `${protocol}//${location.host}${pathname}ws`;

      timer = setTimeout(() => {
        settle({ method: 'gotty-websocket', opened, completed: output.includes(endMarker), timeout: true, output });
      }, timeoutMs);

      socket = new WebSocket(wsUrl, ['webtty']);
      socket.onopen = () => {
        opened = true;
        socket.send(JSON.stringify({
          Arguments: location.search,
          AuthToken: window.gotty_auth_token || '',
        }));
        socket.send(`3${JSON.stringify({ columns: 180, rows: 60 })}`);
        setTimeout(() => socket.send(`1${command}`), 1500);
      };
      socket.onmessage = (event) => {
        const data = String(event.data || '');
        if (data[0] === '1') {
          output += decodeBase64Utf8(data.slice(1));
          if (output.includes(endMarker)) {
            settle({ method: 'gotty-websocket', opened, completed: true, timeout: false, output });
          }
        }
      };
      socket.onerror = () => settle({ method: 'gotty-websocket', opened, completed: false, error: 'websocket error', output });
      socket.onclose = () => {
        if (!output.includes(endMarker)) {
          settle({ method: 'gotty-websocket', opened, completed: false, closed: true, output });
        }
      };
    });
  }, { command, endMarker: LOG_END_MARKER, timeoutMs });
}

async function runDomTerminal(page, command, args) {
  const candidates = [page, ...page.frames()];
  let terminal = null;
  for (const candidate of candidates) {
    const textareaCount = await candidate.locator('textarea').count().catch(() => 0);
    if (textareaCount > 0) {
      terminal = candidate;
      break;
    }
  }
  if (!terminal) throw new Error('cannot find webshell terminal textarea');

  await terminal.locator('textarea').first().focus({ timeout: 10000 }).catch(async () => {
    await terminal.locator('x-screen,.xterm-screen,#terminal').first().click({ timeout: 10000 });
  });
  await page.keyboard.type(command, { delay: Number(args.delay || 1) });

  let text = null;
  for (let i = 0; i < Number(args.polls || 40); i += 1) {
    await page.waitForTimeout(1000);
    text = await terminalText(terminal);
    if (text && text.includes(LOG_END_MARKER)) break;
  }
  return {
    method: 'dom-terminal',
    completed: Boolean(text && text.includes(LOG_END_MARKER)),
    output: text || '',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.url) throw new Error('missing --url=<login_pod_addr>');
  if (!args.app) throw new Error('missing --app=<log_app_name>');
  if (!/^[a-zA-Z0-9_-]+$/.test(String(args.app))) throw new Error('invalid --app value');
  const lines = Number(args.lines || 120);
  if (!Number.isInteger(lines) || lines < 1 || lines > 500) throw new Error('--lines must be an integer between 1 and 500');
  const mode = args.mode || 'auto';
  if (!['auto', 'gotty', 'dom'].includes(mode)) throw new Error('--mode must be auto, gotty, or dom');
  const hasForensicsArgs = ['from', 'to', 'trace-id', 'rule-id', 'keyword', 'files', 'context', 'context-before', 'context-after', 'include-rotated']
    .some((name) => args[name] !== undefined);
  const logMode = args['log-mode'] || (hasForensicsArgs ? 'forensics' : 'quick');
  if (!['quick', 'forensics'].includes(logMode)) throw new Error('--log-mode must be quick or forensics');
  const query = logMode === 'forensics'
    ? normalizeQuery({ ...args, files: args.files || 'error.log,info.log' })
    : null;
  const commandBody = logMode === 'forensics'
    ? buildForensicsCommand(args, query)
    : buildCommand(args, lines);
  const command = wrapCommand(commandBody);
  const urlValidation = validateWebShellUrl(args.url);
  if (!urlValidation.valid) {
    console.log(JSON.stringify({
      app: args.app,
      completed: false,
      errorCode: 'LOGIN_URL_INVALID',
      loginUrlValidation: urlValidation,
      manualUrl: null,
    }, null, 2));
    return;
  }

  const launched = await openContext(args);
  const { context } = launched;
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const session = await waitForStableSession(page, {
      successText: '',
      loginPattern: DEFAULT_LOGIN_PATTERN,
      portalPattern: DEFAULT_PORTAL_PATTERN,
      forbiddenPattern: '403|Forbidden|无权限|拒绝访问',
      targetUrl: args.url,
      stablePolls: Number(args['stable-polls'] || 3),
      stableDwellMs: Number(args['stable-dwell-ms'] || 2500),
      waitForLogin: false,
      timeoutMs: Number(args['session-timeout'] || 10000),
      pollMs: Number(args['session-poll-ms'] || 750),
    });

    if (['LOGIN_REQUIRED', 'PROXY_INTERCEPTED', 'FORBIDDEN'].includes(session.sessionState)) {
      const errorCode = session.sessionState === 'PROXY_INTERCEPTED'
        ? 'PROXY_INTERCEPTED'
        : (session.sessionState === 'FORBIDDEN' ? 'FORBIDDEN' : 'LOGIN_REQUIRED');
      console.log(JSON.stringify({
        url: redactUrl(args.url),
        app: args.app,
        logMode,
        completed: false,
        errorCode,
        networkPolicy: launched.networkPolicy,
        session: {
          state: session.sessionState,
          title: session.title,
          currentHost: session.currentHost,
          terminalReady: session.terminalReady,
          stableReadyPolls: session.stableReadyPolls,
        },
        manualUrl: args.url,
      }, null, 2));
      return;
    }

    let result;
    let fallbackError = null;
    if (mode === 'gotty' || mode === 'auto') {
      result = await runGottyWebSocket(page, command, args).catch((error) => ({
        method: 'gotty-websocket',
        completed: false,
        error: error.stack || error.message,
        output: '',
      }));
    }
    if ((mode === 'dom' || (mode === 'auto' && !result.completed)) && mode !== 'gotty' && session.terminalReady) {
      fallbackError = result && result.error ? result.error : null;
      result = await runDomTerminal(page, command, args).catch((error) => ({
        method: 'dom-terminal',
        completed: false,
        error: error.stack || error.message,
        output: '',
      }));
    }
    if (!result) {
      result = {
        method: mode === 'dom' ? 'dom-terminal' : 'gotty-websocket',
        completed: false,
        error: 'webshell terminal is not ready',
        output: '',
      };
    }
    if (args.screenshot) {
      await page.screenshot({ path: args.screenshot, fullPage: true });
    }
    const text = extractLogText(result.output);
    const summary = logMode === 'quick' ? parseSummary(text) : undefined;
    const forensics = logMode === 'forensics' ? parseForensics(text, query) : undefined;
    const queryErrorCode = summary && (summary.logDirExists === false || summary.recentExceptionMissingFiles.includes('error.log'))
      ? 'LOG_PATH_MISSING'
      : (forensics && (forensics.logDirExists === false || forensics.fileCount === 0) ? 'LOG_PATH_MISSING' : null);
    const transportCompleted = Boolean(result.completed);
    const completed = transportCompleted && !queryErrorCode;
    const sessionState = transportCompleted || result.opened ? 'READY' : session.sessionState;
    console.log(JSON.stringify({
      url: redactUrl(args.url),
      app: args.app,
      mode,
      logMode,
      method: result.method,
      completed,
      transportCompleted,
      errorCode: completed ? null : (queryErrorCode || 'WEBSHELL_WS_FAILED'),
      warningCode: forensics && forensics.truncated ? 'RESULT_TRUNCATED' : null,
      networkPolicy: launched.networkPolicy,
      loginUrlSource: 'lexiao',
      loginUrlValidation: urlValidation,
      session: {
        state: sessionState,
        title: session.title,
        currentHost: session.currentHost,
        terminalReady: session.terminalReady,
        stableReadyPolls: session.stableReadyPolls,
      },
      fallbackError,
      error: result.error,
      summary,
      forensics,
      manualUrl: transportCompleted ? null : args.url,
      text,
    }, null, 2));
  } finally {
    await context.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ errorCode: 'WEBSHELL_CHECK_FAILED', error: error.message }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  buildCommand,
  buildForensicsCommand,
  forensicsAwkProgram,
  parseArgs,
  parseForensics,
  parseSummary,
};
