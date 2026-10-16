// 乐空间 OKR 接口：在 get-browser-session main profile 的页面上下文里 fetch，复用登录态，不读取或输出 Cookie
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SESSION_SCRIPTS = '/home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts';
const API = 'https://openmoa.oa.fenqile.com/oa/okr';
const PAGE = 'https://leco.oa.fenqile.com/main.html';

export class LecoError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

export async function openLeco({ mid }) {
  const bs = require(path.join(SESSION_SCRIPTS, 'browser_session.js'));
  const net = require(path.join(SESSION_SCRIPTS, 'browser_network.js'));
  const url = `${PAGE}#/goal/${mid}`;
  const paths = bs.resolvePaths({ url });
  const chromium = createRequire(paths.playwrightPackage)('playwright').chromium;
  const env = net.buildBrowserEnv(url, { ...process.env }).env;
  env.LD_LIBRARY_PATH = [paths.runtimeLibDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const ctx = await bs.launchLockedContext(chromium, paths.profileDir, {
    executablePath: paths.chromePath, headless: true, env, args: net.chromiumArgsFor(url, ['--no-sandbox']),
  });
  // 只停在空白的 leco 首页拿同源上下文，不打开「添加进展」，避免触发页面的回填和 30 秒自动保存
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  const call = async (method, name, { params, body } = {}) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const res = await page.evaluate(async ({ u, method, body }) => {
      const r = await fetch(u, { method, credentials: 'include', headers: body ? { 'content-type': 'application/json;charset=UTF-8' } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, text: await r.text() };
    }, { u: `${API}/${name}${qs}`, method, body });
    let json;
    try { json = JSON.parse(res.text) } catch { throw new LecoError('LOGIN_REQUIRED', `乐空间返回非 JSON（HTTP ${res.status}），登录态可能失效；用 get-browser-session 刷新 main profile 后重试`) }
    if (Number(json.retcode) !== 0) throw new LecoError(Number(json.retcode) === 401 ? 'LOGIN_REQUIRED' : 'API_ERROR', `${name} 失败：retcode=${json.retcode} ${json.retmsg || ''}`);
    return json;
  };
  return {
    get: (name, params) => call('GET', name, { params }),
    post: (name, body) => call('POST', name, { body }),
    close: () => ctx.close(),
  };
}

// 当前周期以接口的 is_current 为准：季度刚切换、新 OKR 未建时它仍指向上一季度
export async function readOkr(client, { mid, periodId } = {}) {
  let period = periodId;
  let periodName = '';
  if (!period) {
    const periods = (await client.get('get_obj_period_list.json')).result_rows || [];
    const current = periods.find((p) => p.is_current) || periods[0];
    period = current?.obj_period_id;
    periodName = current?.period_name || '';
  }
  const list = (await client.get('get_obj_list_adjust.json', { obj_person_mid: mid, period_id: period })).result_rows || [];
  const objs = [];
  for (const [i, o] of list.entries()) {
    const detail = await client.get('get_obj_detail.json', { obj_id: o.obj_id });
    objs.push({
      index: i + 1,
      objId: Number(o.obj_id),
      text: String(o.last_content || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim(),
      krs: (o.kr_list || []).map((k, j) => ({ index: j + 1, krId: Number(k.kr_id), text: String(k.content_str || '').trim() })),
      detail,
    });
  }
  return { mid, periodId: Number(period), periodName, objs };
}
