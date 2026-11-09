#!/usr/bin/env node
'use strict';
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
// Create TAPD work items through the real "新建" page with the get-browser-session profile. Only bugs for now.
// The page builds the payload itself: this script fills form items by their data-field-name and clicks 创建 (a#_view).
// --dry-run fills and prints the form without clicking 创建. Cookies are never printed or written.
const { createRequire } = require('module');
const { skillDir, browserRuntime } = require(path.join(root, 'lib/agent_tools/locate.js'));

const B = skillDir('get-browser-session', 'scripts');
const { buildBrowserEnv, chromiumArgsFor } = require(path.join(B, 'browser_network'));
const { launchLockedContext } = require(path.join(B, 'browser_session'));

let RUNTIME;
try { RUNTIME = browserRuntime(); } catch (error) { console.error(error.message); process.exit(2); }
const DEFAULT_PROFILE = path.join(os.homedir(), '.local/state/agent-tools/browser-profiles/main');
// TAPD's WAF rejects the HeadlessChrome user agent.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const READY_TIMEOUT_MS = 45000;
const LOGIN_WAIT_MS = 8 * 60 * 1000;
const INFO_API = /\/api\/aggregation\/workitem_aggregation\/common_get_info/;

const USAGE = `Usage:
  node tapd_workitem.js login  --workspace=<项目ID>                       # 打开有界面浏览器让用户登录 TAPD
  node tapd_workitem.js fields --workspace=<项目ID> [--template=<模板ID>]  # 列出模板、表单字段、必填与可选值（只读）
  node tapd_workitem.js create-bug --file=<bug.json> [--dry-run]           # 填表；不带 --dry-run 才点“创建”

Common: [--profile <dir>] (default: get-browser-session main profile)`;

class TapdError extends Error {}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) { args._.push(item); continue; }
    const eq = item.indexOf('=');
    if (eq > 2) { args[item.slice(2, eq)] = item.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[item.slice(2)] = next; i += 1; } else { args[item.slice(2)] = true; }
  }
  return args;
}

function addUrl(workspace, template) {
  const base = `https://www.tapd.cn/${workspace}/bugtrace/bugs/add`;
  return template ? `${base}?template_id=${template}` : base;
}

// bug.json: workspace, template, title, owner, description (HTML) or description_file, fields {data-field-name: value|[values]}
function validateBugSpec(spec, baseDir = '.') {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new TapdError('bug file must contain a JSON object');
  for (const key of ['workspace', 'title', 'owner']) {
    if (!String(spec[key] || '').trim()) throw new TapdError(`${key} is required`);
  }
  if (!/^\d+$/.test(String(spec.workspace))) throw new TapdError(`workspace must be a TAPD project id: ${spec.workspace}`);
  if (spec.template !== undefined && !/^\d+$/.test(String(spec.template))) throw new TapdError(`template must be a TAPD template id: ${spec.template}`);
  if (/[;,；，\s]/.test(String(spec.owner).trim())) throw new TapdError('owner must be a single TAPD account (e.g. zhangsan)');
  let description = spec.description || '';
  if (spec.description_file) description = fs.readFileSync(path.resolve(baseDir, spec.description_file), 'utf8');
  if (!String(description).trim()) throw new TapdError('description or description_file is required');
  const fields = spec.fields || {};
  if (typeof fields !== 'object' || Array.isArray(fields)) throw new TapdError('fields must be an object keyed by data-field-name');
  return {
    workspace: String(spec.workspace),
    template: spec.template ? String(spec.template) : '',
    title: String(spec.title).trim(),
    owner: String(spec.owner).trim(),
    description: String(description),
    fields,
  };
}

// The user chooser adds every prefix match while typing (typing one account also adds the others sharing its prefix); keep the target account only.
function keepAccountTokens(value, account) {
  return String(value || '').split(';').map((t) => t.trim()).filter((t) => t.startsWith(account)).map((t) => `${t};`).join('');
}

// options: [{value, text}]; wanted matches an option value or its visible text exactly.
function matchOption(options, wanted) {
  const w = String(wanted).trim();
  const hit = options.find((o) => o.value === w) || options.find((o) => o.text === w);
  return hit ? hit.value : null;
}

// items: [{name, label, required, filled}] -> labels of required items still empty
function missingRequired(items) {
  return items.filter((i) => i.required && !i.filled).map((i) => `${i.label}(${i.name})`);
}

// ---------- browser ----------

async function openContext(args, url, headed = false) {
  const chromium = createRequire(path.join(RUNTIME.toolDir, 'package.json'))('playwright').chromium;
  const env = { ...buildBrowserEnv(url, { ...process.env }).env, LD_LIBRARY_PATH: [RUNTIME.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  if (headed) {
    if (!env.DISPLAY && fs.existsSync('/tmp/.X11-unix/X0')) env.DISPLAY = ':0';
    if (!env.WAYLAND_DISPLAY && fs.existsSync('/mnt/wslg/runtime-dir/wayland-0')) env.WAYLAND_DISPLAY = 'wayland-0';
    if (!env.XDG_RUNTIME_DIR && fs.existsSync('/mnt/wslg/runtime-dir')) env.XDG_RUNTIME_DIR = '/mnt/wslg/runtime-dir';
  }
  const context = await launchLockedContext(chromium, path.resolve(args.profile || DEFAULT_PROFILE), {
    executablePath: RUNTIME.executablePath,
    headless: !headed,
    env,
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 1000 },
    args: chromiumArgsFor(url, ['--no-sandbox']),
  });
  return { context, page: context.pages()[0] || await context.newPage() };
}

async function gotoForm(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (/cloud_logins\/login/.test(page.url())) throw new TapdError('TAPD login required: run `tapd_workitem.js login --workspace=<id>` and log in in the opened window');
  await page.locator('#BugTitle').waitFor({ timeout: READY_TIMEOUT_MS });
  await page.waitForTimeout(3000);
}

// Reads every form item: field name, type, label, required flag, options and whether it currently has a value.
async function readForm(page) {
  return page.evaluate(() => [...document.querySelectorAll('.form-item[data-field-name]')].map((item) => {
    const label = (item.querySelector('label')?.innerText || '').replace(/\*/g, '').trim();
    const required = !!item.querySelector('label .vip');
    const select = item.querySelector('select');
    const checks = [...item.querySelectorAll('input[type=checkbox],input[type=radio]')].filter((i) => i.value !== '');
    const hidden = item.querySelector('input[type=hidden]');
    const text = item.querySelector('input[type=text],textarea');
    let options = [];
    let filled = false;
    if (select) {
      options = [...select.options].filter((o) => o.value !== '').map((o) => ({ value: o.value, text: o.text.trim() }));
      filled = select.value !== '';
    } else if (checks.length) {
      options = checks.map((i) => ({ value: i.value, text: i.value }));
      filled = checks.some((i) => i.checked);
    } else if (hidden) {
      filled = hidden.value.trim() !== '';
    } else if (text) {
      filled = text.value.trim() !== '';
    }
    return { name: item.dataset.fieldName, type: item.dataset.fieldType, label, required, options, filled };
  }));
}

async function cmdLogin(args) {
  const workspace = String(args.workspace || '');
  if (!/^\d+$/.test(workspace)) throw new TapdError('--workspace is required');
  const url = addUrl(workspace);
  const { context, page } = await openContext(args, url, true);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      if (/\/bugtrace\/bugs\/add/.test(page.url()) && !/login/.test(page.url())) {
        await page.waitForTimeout(3000);
        console.log(`TAPD 已登录: ${page.url()}`);
        return 0;
      }
      await page.waitForTimeout(2000);
    }
    throw new TapdError('TAPD login not finished within 8 minutes');
  } finally {
    await context.close().catch(() => {});
  }
}

async function cmdFields(args) {
  const workspace = String(args.workspace || '');
  if (!/^\d+$/.test(workspace)) throw new TapdError('--workspace is required');
  const { context, page } = await openContext(args, addUrl(workspace));
  try {
    await gotoForm(page, addUrl(workspace, args.template));
    // 模板下拉：.template-list 里每个 li.template-item > a 的 id 就是模板 ID
    const templates = await page.evaluate(() => [...document.querySelectorAll('.template-list li.template-item a')]
      .map((a) => ({ id: a.id, name: (a.innerText || '').trim(), current: a.parentElement.classList.contains('current') })));
    const current = await page.evaluate(() => (document.querySelector('.template-config .current-value')?.innerText || '').trim());
    console.log(JSON.stringify({ url: page.url(), currentTemplate: current, templates, fields: await readForm(page) }, null, 2));
  } finally {
    await context.close().catch(() => {});
  }
  return 0;
}

async function fillField(page, item, value) {
  const values = Array.isArray(value) ? value.map(String) : [String(value)];
  if (item.type === 'select') {
    const v = matchOption(item.options, values[0]);
    if (v === null) throw new TapdError(`${item.label}(${item.name}) 没有选项 ${values[0]}；可选: ${item.options.map((o) => o.text).join('/')}`);
    await page.evaluate(([name, val]) => {
      const s = document.querySelector(`.form-item[data-field-name="${name}"] select`);
      s.value = val;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      if (window.jQuery) window.jQuery(s).trigger('change');
    }, [item.name, v]);
    return;
  }
  if (item.type === 'multi_select' || item.type === 'radio' || item.type === 'checkbox') {
    for (const one of values) {
      if (matchOption(item.options, one) === null) throw new TapdError(`${item.label}(${item.name}) 没有选项 ${one}；可选: ${item.options.map((o) => o.text).join('/')}`);
    }
    await page.evaluate(([name, vals]) => {
      for (const i of document.querySelectorAll(`.form-item[data-field-name="${name}"] input[type=checkbox],.form-item[data-field-name="${name}"] input[type=radio]`)) {
        const on = vals.includes(i.value);
        if (i.checked !== on) {
          i.checked = on;
          i.dispatchEvent(new Event('change', { bubbles: true }));
          if (window.jQuery) window.jQuery(i).trigger('change');
        }
      }
    }, [item.name, values]);
    return;
  }
  if (item.type === 'text' || item.type === 'integer' || item.type === 'float') {
    await page.fill(`.form-item[data-field-name="${item.name}"] input[type=text]`, values[0]);
    return;
  }
  throw new TapdError(`${item.label}(${item.name}) 的类型 ${item.type} 暂不支持自动填写`);
}

async function chooseUser(page, account) {
  const input = '#BugCurrentOwnerValue';
  await page.click(input);
  await page.type(input, account, { delay: 60 });
  await page.waitForTimeout(2500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  const raw = await page.evaluate(() => ({
    hidden: document.querySelector('#BugCurrentOwner').value,
    shown: document.querySelector('#BugCurrentOwnerValue').value,
  }));
  const value = keepAccountTokens(raw.hidden, account);
  await page.evaluate(([hidden, shown]) => {
    document.querySelector('#BugCurrentOwner').value = hidden;
    document.querySelector('#BugCurrentOwnerValue').value = shown;
  }, [value, keepAccountTokens(raw.shown, account)]);
  if (value.split(';').filter(Boolean).length !== 1) throw new TapdError(`处理人没有精确选中 ${account}，实际: ${value || '(空)'}`);
  return value;
}

async function cmdCreateBug(args) {
  if (!args.file) throw new TapdError('--file is required');
  const file = path.resolve(args.file);
  const spec = validateBugSpec(JSON.parse(fs.readFileSync(file, 'utf8')), path.dirname(file));
  const dryRun = Boolean(args['dry-run']);
  const url = addUrl(spec.workspace, spec.template);
  const { context, page } = await openContext(args, url);
  try {
    await gotoForm(page, url);
    await page.fill('#BugTitle', spec.title);
    const owner = await chooseUser(page, spec.owner);
    const items = await readForm(page);
    const byName = new Map(items.map((i) => [i.name, i]));
    for (const [name, value] of Object.entries(spec.fields)) {
      const item = byName.get(name);
      if (!item) throw new TapdError(`当前模板没有字段 ${name}；先用 fields 子命令查看字段名`);
      await fillField(page, item, value);
    }
    await page.evaluate((html) => {
      const editor = window.tinymce && window.tinymce.get('BugDescription');
      if (!editor) throw new Error('description editor (tinymce BugDescription) not found');
      editor.setContent(html);
      editor.save();
    }, spec.description);
    await page.waitForTimeout(800);
    const after = await readForm(page);
    const missing = missingRequired(after.filter((i) => i.name !== 'description'));
    const summary = {
      mode: dryRun ? 'dry-run' : 'create',
      url,
      title: await page.inputValue('#BugTitle'),
      owner,
      fields: after.filter((i) => i.filled).map((i) => i.name),
      descriptionChars: await page.evaluate(() => window.tinymce.get('BugDescription').getContent({ format: 'text' }).length),
      missingRequired: missing,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (missing.length) throw new TapdError(`必填字段未填: ${missing.join('、')}`);
    if (dryRun) { console.log('dry-run: 未点“创建”'); return 0; }

    const info = page.waitForResponse((r) => INFO_API.test(r.url()), { timeout: 60000 }).catch(() => null);
    // “创建”是 a#_view.for_submit，不是 button
    await page.locator('a#_view.for_submit').click({ timeout: 15000 });
    try {
      await page.waitForURL(/\/bug\/detail\/\d+|\/bugtrace\/bugs\/view/, { timeout: 60000 });
    } catch (e) {
      throw new TapdError(`点“创建”后没有跳到缺陷详情（当前 ${page.url()}）。不要直接重试：先在 TAPD 缺陷列表按标题确认是否已创建`);
    }
    const id = (page.url().match(/\/bug\/detail\/(\d+)/) || [])[1] || '';
    const resp = await info;
    let bug = null;
    if (resp) { try { bug = (await resp.json()).data.get_info_ret.data.Bug; } catch (e) { bug = null; } }
    const readback = bug ? { id: bug.id, title: bug.title, current_owner: bug.current_owner, severity: bug.severity, priority: bug.priority, status: bug.status } : null;
    console.log(JSON.stringify({ created: id, url: page.url(), readback }, null, 2));
    if (readback && readback.title !== spec.title) throw new TapdError(`回读标题不一致: ${readback.title}`);
    if (readback && !String(readback.current_owner || '').startsWith(spec.owner)) throw new TapdError(`回读处理人不一致: ${readback.current_owner}`);
    return 0;
  } finally {
    await context.close().catch(() => {});
  }
}

const COMMANDS = { login: cmdLogin, fields: cmdFields, 'create-bug': cmdCreateBug };

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!COMMANDS[command] || args.help) { console.log(USAGE); return command || args.help ? 0 : 2; }
  return COMMANDS[command](args);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = { addUrl, keepAccountTokens, matchOption, missingRequired, parseArgs, validateBugSpec };
