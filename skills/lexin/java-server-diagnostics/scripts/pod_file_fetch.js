#!/usr/bin/env node
// agent-tools bootstrap（模板 lib/agent_tools/bootstrap.js，lint 规则六校验逐字一致）
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
// probe 返回 'hit' | 'miss' | <异常码>：与 locate.py 同序先看 install.py（缺失即 miss），再看 skills/；用会抛错的 statSync，不用对一切错误都返回 false 的 existsSync
const probe = (d) => { if (!d) return 'miss'; try { const i = fs.statSync(path.join(d, 'install.py'), { throwIfNoEntry: false }); if (!i || !i.isFile()) return 'miss'; const s = fs.statSync(path.join(d, 'skills'), { throwIfNoEntry: false }); return s && s.isDirectory() ? 'hit' : 'miss'; } catch (e) { return e.code || 'error'; } };
const tried = []; let root = '', r = 'miss';
try { let d = fs.realpathSync(__dirname); tried.push(`上溯起点 ${d}`); while ((r = probe(d)) === 'miss' && path.dirname(d) !== d) d = path.dirname(d); if (r === 'hit') root = d; else tried[0] += r === 'miss' ? ' 未命中有效根（install.py 文件 + skills/ 目录）' : ` ${r}（放弃上溯）`; }
catch (e) { tried.push(`上溯起点 ${__dirname} ${e.code || e.message}`); }
if (!root) { const v = process.env.AGENT_TOOLS_ROOT || ''; r = probe(v); tried.push(`AGENT_TOOLS_ROOT=${v || '<unset>'}${r === 'hit' || r === 'miss' ? '' : ' ' + r}`); if (r === 'hit') root = v; }
if (!root) { const p = path.join(os.homedir(), '.config/agent-tools/root'); try { const v = fs.readFileSync(p, 'utf8').trim(); r = probe(v); tried.push(`${p} = ${v}${r === 'hit' || r === 'miss' ? '' : ' ' + r}`); if (r === 'hit') root = v; } catch (e) { tried.push(`${p} ${e.code === 'ENOENT' ? '<absent>' : e.code}`); } }
if (!root) { console.error(['agent-tools: 未找到仓库根', ...tried, '请在仓库目录运行 python3 install.py'].join('\n')); process.exit(2); }
// agent-tools bootstrap end
const crypto = require('node:crypto');

// Read-only file access inside a Pod through the Lexiao WebShell (Gotty WebSocket): list a directory, stat a file,
// or fetch one file and verify it. The remote script is assembled here from a fixed template; callers pass an
// action and a path, never a command. Paths are limited to the application's own publish directory.
const ACTIONS = new Set(['list', 'stat', 'fetch']);
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const LIST_LIMIT = 200;
// Verified up to 7.9 MiB on 2026-11-11; the ceiling stays close to what a terminal stream can carry in a few minutes.
const HARD_MAX_BYTES = 32 * 1024 * 1024;
const KNOWN_ARGS = new Set(['url', 'app', 'action', 'path', 'out', 'max-bytes', 'timeout', 'profile', 'headed', 'help']);
const B64_BEGIN = '__POD_FILE_B64_BEGIN__';
const B64_END = '__POD_FILE_B64_END__';
const APP_PATTERN = /^[A-Za-z0-9_-]+$/;
const PATH_PATTERN = /^\/[A-Za-z0-9_.\/-]+$/;

const USAGE = `Usage:
  pod_file_fetch.js --url=<login_pod_addr> --app=<app_name> --action=list --path=<directory>
  pod_file_fetch.js --url=<login_pod_addr> --app=<app_name> --action=stat --path=<file>
  pod_file_fetch.js --url=<login_pod_addr> --app=<app_name> --action=fetch --path=<file> --out=<local file>
      [--max-bytes=${DEFAULT_MAX_BYTES}] [--timeout=<ms>] [--profile=<browser profile dir>]

--url is the WebShell address from query-app-instances (login_pod_addr), used verbatim.
--path must be an absolute path under /home/publish_product/server_java/<app_name>/ made of [A-Za-z0-9_./-]; the Pod
resolves symlinks first and refuses a path whose real location is outside that directory.
fetch writes the file to --out (mode 600) only after its size and md5 match what the Pod reported; the content is
never printed. Output is JSON on stdout. Exit codes: 0 ok, 1 failed (see errorCode), 2 agent-tools root or browser
runtime missing.`;

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    if (!item.startsWith('--')) throw new Error(`unexpected argument ${item}`);
    const eq = item.indexOf('=');
    const key = eq === -1 ? item.slice(2) : item.slice(2, eq);
    if (!KNOWN_ARGS.has(key)) throw new Error(`unknown option --${key}`);
    args[key] = eq === -1 ? true : item.slice(eq + 1);
  }
  return args;
}

function allowedRoot(app) {
  return `/home/publish_product/server_java/${app}/`;
}

// Returns the normalised path, or throws with the reason. No shell metacharacter, whitespace or `..` can pass.
function validateTarget(app, target) {
  if (!APP_PATTERN.test(String(app || ''))) throw new Error('--app must match [A-Za-z0-9_-]+');
  const value = String(target || '');
  if (!PATH_PATTERN.test(value)) throw new Error('--path must be an absolute path made of [A-Za-z0-9_./-]');
  if (value.split('/').includes('..')) throw new Error('--path must not contain ..');
  const normalised = value.replace(/\/{2,}/g, '/');
  const root = allowedRoot(app);
  if (!(normalised + '/').startsWith(root)) throw new Error(`--path must be under ${root}`);
  return normalised;
}

function resolveMaxBytes(value) {
  if (value === undefined || value === true || value === '') return DEFAULT_MAX_BYTES;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > HARD_MAX_BYTES) throw new Error(`--max-bytes must be an integer between 1 and ${HARD_MAX_BYTES}`);
  return parsed;
}

// The script that runs in the Pod. `target` and `root` have passed validateTarget / APP_PATTERN, so single quotes
// are safe. The string check in validateTarget cannot see symlinks, so the Pod resolves the real path ($r) and the
// real root, refuses anything outside it, and every later command works on $r only.
function buildScript(action, target, markers, maxBytes = DEFAULT_MAX_BYTES, root = '/') {
  if (!ACTIONS.has(action)) throw new Error(`--action must be one of ${[...ACTIONS].join(', ')}`);
  const lines = [
    `p='${target}'`,
    `root='${root.replace(/\/+$/, '') || '/'}'`,
    `echo ${markers.begin}`,
    'r=$(readlink -f -- "$p" 2>/dev/null); realroot=$(readlink -f -- "$root" 2>/dev/null)',
    'if [ -z "$r" ] || [ ! -e "$r" ]; then echo KIND=missing',
    'elif [ -z "$realroot" ]; then echo KIND=outside-root',
    'else case "$r/" in "${realroot%/}/"*)',
  ];
  if (action === 'list') {
    lines.push(`  if [ -d "$r" ]; then echo KIND=dir; echo "COUNT=$(ls -A -- "$r" 2>/dev/null | wc -l)"; ls -lt --time-style=long-iso -- "$r" 2>&1 | head -n ${LIST_LIMIT + 1}; else echo KIND=not-a-dir; fi ;;`);
  } else {
    lines.push(
      '  for tool in stat md5sum base64; do command -v "$tool" >/dev/null 2>&1 || echo "MISSING_TOOL=$tool"; done',
      '  if [ -f "$r" ]; then',
      '    echo KIND=file; echo "SIZE=$(stat -c %s -- "$r")"; echo "MTIME=$(stat -c %y -- "$r")"; echo "MD5=$(md5sum -- "$r" | cut -d" " -f1)"',
    );
    if (action === 'fetch') {
      lines.push(
        `    if [ "$(stat -c %s -- "$r")" -le ${maxBytes} ]; then echo ${B64_BEGIN}; base64 -w 76 -- "$r"; echo; echo ${B64_END}; else echo TOO_LARGE=${maxBytes}; fi`,
      );
    }
    lines.push('  else echo KIND=not-a-file; fi ;;');
  }
  lines.push('  *) echo KIND=outside-root ;; esac; fi', `echo ${markers.end}`);
  return lines.join('\n') + '\n';
}

// Parses the text between the begin/end markers (terminal control sequences already removed).
function parseOutput(action, text, markers) {
  const begin = text.lastIndexOf(markers.begin);
  const end = text.lastIndexOf(markers.end);
  if (begin === -1 || end === -1 || end < begin) return { errorCode: 'OUTPUT_INCOMPLETE' };
  const body = text.slice(begin + markers.begin.length, end);
  const lines = body.split('\n').map((line) => line.trim());
  const field = (name) => {
    const line = lines.find((item) => item.startsWith(`${name}=`));
    return line === undefined ? undefined : line.slice(name.length + 1);
  };
  const kind = field('KIND');
  const missingTools = lines.filter((line) => line.startsWith('MISSING_TOOL=')).map((line) => line.slice(13));
  if (missingTools.length) return { errorCode: 'REMOTE_TOOL_MISSING', missingTools };
  if (kind === 'missing') return { errorCode: 'PATH_MISSING', kind };
  if (kind === 'outside-root') return { errorCode: 'PATH_OUTSIDE_ROOT', kind };
  if (action === 'list') {
    if (kind !== 'dir') return { errorCode: kind === 'not-a-dir' ? 'NOT_A_DIR' : 'OUTPUT_INCOMPLETE', kind };
    const total = Number(field('COUNT'));
    const entries = lines.slice(lines.indexOf('KIND=dir') + 1)
      .filter((line) => line && !/^total \d+$/.test(line) && !line.startsWith('COUNT=')).slice(0, LIST_LIMIT);
    // Newest first; a directory with more than LIST_LIMIT entries is cut and says so.
    return { kind, total: Number.isInteger(total) ? total : null, truncated: Number.isInteger(total) ? total > entries.length : null, entries };
  }
  if (kind !== 'file') return { errorCode: kind === 'not-a-file' ? 'NOT_A_FILE' : 'OUTPUT_INCOMPLETE', kind };
  const sizeText = field('SIZE') || '';
  const info = { kind, size: Number(sizeText), mtime: field('MTIME') || '', md5: field('MD5') || '' };
  if (!/^\d+$/.test(sizeText) || !/^[0-9a-f]{32}$/.test(info.md5)) return { errorCode: 'OUTPUT_INCOMPLETE' };
  if (action === 'stat') return info;
  if (field('TOO_LARGE') !== undefined) return { ...info, errorCode: 'FILE_TOO_LARGE', maxBytes: Number(field('TOO_LARGE')) };
  const b64Begin = body.indexOf(B64_BEGIN);
  const b64End = body.indexOf(B64_END);
  if (b64Begin === -1 || b64End === -1 || b64End < b64Begin) return { ...info, errorCode: 'OUTPUT_INCOMPLETE' };
  const encoded = body.slice(b64Begin + B64_BEGIN.length, b64End).replace(/[^A-Za-z0-9+/=]/g, '');
  const content = Buffer.from(encoded, 'base64');
  const localMd5 = crypto.createHash('md5').update(content).digest('hex');
  if (content.length !== info.size || localMd5 !== info.md5) {
    return { ...info, errorCode: 'VERIFY_FAILED', receivedSize: content.length, receivedMd5: localMd5 };
  }
  return { ...info, content };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (!args.url) throw new Error('missing --url=<login_pod_addr>');
  const action = String(args.action || '');
  if (!ACTIONS.has(action)) throw new Error(`--action must be one of ${[...ACTIONS].join(', ')}`);
  const target = validateTarget(args.app, args.path);
  const maxBytes = resolveMaxBytes(args['max-bytes']);
  if (action === 'fetch' && (!args.out || args.out === true)) throw new Error('fetch needs --out=<local file>');
  const out = action === 'fetch' ? path.resolve(String(args.out)) : null;
  if (out && fs.existsSync(out)) throw new Error(`${out} already exists; choose another --out`);

  // Loaded here, not at the top, so the pure helpers above can be required without a browser runtime.
  const webshell = require('./webshell_log_check');
  const markers = { begin: webshell.LOG_BEGIN_MARKER, end: webshell.LOG_END_MARKER };
  const command = webshell.wrapCommand(buildScript(action, target, markers, maxBytes, allowedRoot(args.app)));
  // A large file streams for a while: 60 s base plus 1 s per 100 KiB allowed (measured ~190 KiB/s for 7.9 MiB).
  // Only the options this script documents reach the WebShell layer (no --screenshot / --chrome pass-through).
  const runArgs = {
    url: args.url,
    app: args.app,
    profile: args.profile,
    headed: args.headed,
    timeout: args.timeout || (action === 'fetch' ? 60000 + Math.ceil(maxBytes / 102400) * 1000 : 60000),
  };
  // Gotty only: the DOM fallback reads the visible screen and cannot carry a file.
  const run = await webshell.runWebShellScript(runArgs, command, { mode: 'gotty' });

  const output = { action, app: args.app, path: target, completed: false, errorCode: null };
  if (run.stage === 'url') {
    Object.assign(output, { errorCode: 'LOGIN_URL_INVALID', loginUrlValidation: run.urlValidation });
  } else if (run.stage === 'session') {
    Object.assign(output, { errorCode: run.errorCode, sessionState: run.session.sessionState, manualUrl: args.url });
  } else if (!run.result.completed) {
    Object.assign(output, { errorCode: run.result.timeout ? 'WEBSHELL_TIMEOUT' : 'WEBSHELL_WS_FAILED', error: run.result.error, manualUrl: args.url });
  } else {
    const parsed = parseOutput(action, webshell.cleanTerminalText(run.result.output), markers);
    const { content, ...rest } = parsed;
    Object.assign(output, rest, { method: run.result.method });
    if (!parsed.errorCode) {
      if (content) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        try {
          fs.writeFileSync(out, content, { mode: 0o600, flag: 'wx' });
        } catch (error) {
          if (error.code !== 'EEXIST') fs.rmSync(out, { force: true }); // never leave a partial file behind
          throw error;
        }
        output.out = out;
        output.verified = true;
      }
      output.completed = true;
    }
  }
  console.log(JSON.stringify(output, null, 2));
  return output.completed ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(JSON.stringify({ errorCode: 'POD_FILE_FETCH_FAILED', error: error.message }, null, 2));
    process.exit(1);
  });
}

module.exports = { B64_BEGIN, B64_END, DEFAULT_MAX_BYTES, allowedRoot, buildScript, parseArgs, parseOutput, resolveMaxBytes, validateTarget };
