#!/usr/bin/env node
// Download one TAPD story (fields, description, comments, images) into a local Markdown file.
// Reuses the get-browser-session Chromium profile; never prints cookies.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const { buildBrowserEnv, chromiumArgsFor } = require('../../get-browser-session/scripts/browser_network');
const { launchLockedContext } = require('../../get-browser-session/scripts/browser_session');

const TOOL_DIR = path.join(os.homedir(), 'tools/lexiao-browser');
const CHROME_PATH = path.join(TOOL_DIR, 'browsers/chrome-linux64/chrome');
const RUNTIME_LIB_DIR = path.join(TOOL_DIR, 'runtime-libs/usr/lib/x86_64-linux-gnu');
const DEFAULT_PROFILE = path.join(os.homedir(), '.local/state/agent-tools/browser-profiles/main');
const DOCS_ROOT = path.join(os.homedir(), 'docs/requirements-development');
// TAPD's WAF rejects any User-Agent containing "HeadlessChrome" with HTTP 403.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const INFO_API = /\/api\/aggregation\/workitem_aggregation\/common_get_info/;
const BASE_FIELDS = [
  ['status', '状态'], ['priority', '优先级'], ['type', '需求类型'], ['source', '需求来源'],
  ['owner', '处理人'], ['developer', '开发人员'], ['creator', '创建人'], ['created', '创建时间'],
  ['modified', '最后修改时间'],
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq !== -1) args[item.slice(2, eq)] = item.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[item.slice(2)] = argv[++i];
    else args[item.slice(2)] = true;
  }
  return args;
}

function parseStoryUrl(url) {
  const match = String(url || '').match(/^https:\/\/www\.tapd\.cn\/(?:tapd_fe\/)?(\d+)\/(?:story\/detail|prong\/stories\/view)\/(\d+)/);
  if (!match) {
    throw new Error(`not a TAPD story URL: ${url} (expected https://www.tapd.cn/tapd_fe/<workspace>/story/detail/<id>)`);
  }
  return { workspaceId: match[1], storyId: match[2], shortId: match[2].slice(-7) };
}

function cleanPerson(value) {
  return String(value || '').split(';').map((s) => s.trim()).filter(Boolean).join('、');
}

function escapeCell(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// story: TAPD Story object; statusMap: status code -> label; labels: field name -> label.
function buildMarkdown({ story, shortId, url, statusMap, labels, descriptionMd, comments, fetchedAt }) {
  const rows = [['需求ID', shortId]];
  const used = new Set(['id', 'name', 'description']);
  for (const [key, fallback] of BASE_FIELDS) {
    used.add(key);
    let value = story[key];
    if (key === 'status') value = statusMap[value] ? `${statusMap[value]}（${value}）` : value;
    if (['owner', 'developer'].includes(key)) value = cleanPerson(value);
    if (value) rows.push([labels[key] || fallback, value]);
  }
  for (const [key, label] of Object.entries(labels)) {
    if (used.has(key) || !/^custom_field_/.test(key)) continue;
    const value = story[key];
    if (value && String(value).trim()) rows.push([label, cleanPerson(value) || value]);
  }
  const lines = [
    `# ${story.name}`,
    '',
    `> 来源: [TAPD ${shortId}](${url})`,
    `> 抓取时间: ${fetchedAt}`,
    '',
    '## 基础信息',
    '',
    '| 字段 | 值 |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${escapeCell(k)} | ${escapeCell(v)} |`),
    '',
    '## 需求描述',
    '',
    descriptionMd.trim() || '（无描述）',
    '',
    '## 评论',
    '',
  ];
  if (!comments.length) lines.push('（无评论）', '');
  for (const c of comments) {
    lines.push(`- ${c.author}（${c.created}）：${String(c.text || '').replace(/\s+/g, ' ').trim()}`);
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

// Runs inside the page: converts TAPD description HTML into Markdown and lists images.
function htmlToMarkdownInPage(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  const images = [];
  const inline = (node) => Array.from(node.childNodes).map(render).join('');
  const block = (text) => `\n\n${text.trim()}\n\n`;
  const cellText = (cell) => inline(cell).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
  function render(node) {
    if (node.nodeType === 3) return node.textContent.replace(/\u00a0/g, ' ').replace(/\*/g, '\\*');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (['style', 'script'].includes(tag)) return '';
    if (/^h[1-6]$/.test(tag)) return block(`${'#'.repeat(Math.min(6, Number(tag[1]) + 2))} ${inline(node).trim()}`);
    if (tag === 'br') return '\n';
    if (tag === 'img') {
      const src = node.getAttribute('original_src') || node.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) return '';
      const name = `img_${String(images.length + 1).padStart(2, '0')}`;
      images.push({ name, url: new URL(src, 'https://www.tapd.cn').href });
      return `\n\n![${name}](images/${name})\n\n`;
    }
    if (tag === 'b' || tag === 'strong') {
      const text = inline(node).trim();
      if (node.parentElement && node.parentElement.closest('b,strong')) return text;
      return text ? `**${text}**` : '';
    }
    if (tag === 'a') {
      const text = inline(node).trim();
      const href = node.getAttribute('href');
      return href && text ? `[${text}](${href})` : text;
    }
    if (tag === 'li') return `${inline(node).trim()}`;
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(node.children).filter((c) => c.tagName.toLowerCase() === 'li');
      return block(items.map((li, i) => `${tag === 'ol' ? `${i + 1}.` : '-'} ${render(li).replace(/\n+/g, ' ')}`).join('\n'));
    }
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map(cellText));
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r) => [...r, ...Array(width - r.length).fill('')];
      const out = [`| ${pad(rows[0]).join(' | ')} |`, `|${' --- |'.repeat(width)}`];
      rows.slice(1).forEach((r) => out.push(`| ${pad(r).join(' | ')} |`));
      return block(out.join('\n'));
    }
    if (tag === 'pre') return block(`\`\`\`\n${node.textContent}\n\`\`\``);
    if (['p', 'div', 'section', 'blockquote'].includes(tag)) return block(inline(node));
    return inline(node);
  }
  const markdown = render(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { markdown, images };
}

function extensionFor(contentType) {
  if (/jpe?g/.test(contentType)) return '.jpg';
  if (/gif/.test(contentType)) return '.gif';
  if (/webp/.test(contentType)) return '.webp';
  return '.png';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { storyId, shortId } = parseStoryUrl(args.url);
  const headed = Boolean(args.headed);
  const outDir = path.resolve(args['out-dir'] || path.join(DOCS_ROOT, `tapd-${shortId}`, 'requirements', 'source'));
  const loginTimeoutMs = Number(args['login-timeout'] || 300000);
  const chromium = createRequire(path.join(TOOL_DIR, 'package.json'))('playwright').chromium;
  const network = buildBrowserEnv(args.url, process.env);
  const env = { ...network.env, LD_LIBRARY_PATH: [RUNTIME_LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  if (headed) {
    if (!env.DISPLAY && fs.existsSync('/tmp/.X11-unix/X0')) env.DISPLAY = ':0';
    if (!env.WAYLAND_DISPLAY && fs.existsSync('/mnt/wslg/runtime-dir/wayland-0')) env.WAYLAND_DISPLAY = 'wayland-0';
    if (!env.XDG_RUNTIME_DIR && fs.existsSync('/mnt/wslg/runtime-dir')) env.XDG_RUNTIME_DIR = '/mnt/wslg/runtime-dir';
  }
  const context = await launchLockedContext(chromium, path.resolve(args.profile || DEFAULT_PROFILE), {
    executablePath: CHROME_PATH,
    headless: !headed,
    env,
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    args: chromiumArgsFor(args.url, ['--no-sandbox']),
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    const infoPromise = page.waitForResponse(
      (r) => INFO_API.test(r.url()) && (r.request().postData() || '').includes(storyId),
      { timeout: headed ? loginTimeoutMs : 30000 },
    ).catch(() => null);
    const nav = await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (nav && nav.status() === 403) {
      return { state: 'FORBIDDEN', httpStatus: 403, title: await page.title(), hint: 'TAPD WAF rejected the request' };
    }
    const infoResponse = await infoPromise;
    if (!infoResponse) {
      const loginPage = /cloud_logins|登录/.test(page.url() + await page.title());
      return {
        state: loginPage ? 'LOGIN_REQUIRED' : 'NOT_LOADED',
        url: page.url(),
        title: await page.title(),
        hint: loginPage ? 'rerun with --headed and finish TAPD login in the browser window' : 'story data did not load; check access to this workspace',
      };
    }
    const data = (await infoResponse.json()).data.get_info_ret.data;
    const story = data.Story;
    const workspaceId = story.workspace_id;
    const statusMap = ((((data.workspace_configs || {}).workflow_infos || {}).story || {}).status_map || {})[workspaceId] || {};
    const labels = {};
    for (const field of ((data.show_fields_info || {}).show_fields || [])) labels[field.name] = field.label;
    const comments = (((data.comment_list || {}).comments) || []).map((c) => ({ author: c.author, created: c.created, text: c.plain_text }));
    const { markdown: descriptionMd, images } = await page.evaluate(htmlToMarkdownInPage, story.description || '');

    fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });
    let finalMd = descriptionMd;
    const failures = [];
    for (const image of images) {
      try {
        const response = await context.request.get(image.url, { headers: { Referer: args.url }, timeout: 30000 });
        if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
        const file = image.name + extensionFor(response.headers()['content-type'] || '');
        fs.writeFileSync(path.join(outDir, 'images', file), await response.body());
        finalMd = finalMd.replace(`(images/${image.name})`, `(images/${file})`);
        image.file = file;
      } catch (error) {
        failures.push({ name: image.name, url: image.url, error: error.message });
        finalMd = finalMd.replace(`(images/${image.name})`, `(${image.url})`);
      }
    }
    const fetchedAt = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16);
    const markdownPath = path.join(outDir, `TAPD-${shortId}.md`);
    fs.writeFileSync(markdownPath, buildMarkdown({
      story, shortId, url: args.url, statusMap, labels, descriptionMd: finalMd, comments, fetchedAt,
    }));
    fs.writeFileSync(path.join(outDir, `TAPD-${shortId}.description.html`), story.description || '');
    return {
      state: 'OK',
      title: story.name,
      status: statusMap[story.status] || story.status,
      markdownPath,
      images: images.length,
      imageFailures: failures,
      comments: comments.length,
      networkPolicy: network.networkPolicy,
    };
  } finally {
    await context.close();
  }
}

if (require.main === module) {
  main()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.state === 'OK' ? 0 : 2);
    })
    .catch((error) => {
      console.log(JSON.stringify({ state: 'ERROR', error: error.message }, null, 2));
      process.exit(1);
    });
}

module.exports = { parseStoryUrl, buildMarkdown, cleanPerson, extensionFor };
