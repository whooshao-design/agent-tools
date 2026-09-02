#!/usr/bin/env node
'use strict';
/**
 * 米霍克 OA 前端（web_mihawk_oa）本地开发会话管理。
 *
 * 子命令：
 *   doctor   启动前置门禁（Node 版本 / 内存 / PSI / 8116 端口 / 代理提醒），只读
 *   start    门禁全绿后启动本地 webpack（npm run dev:index）；已有本项目健康实例则复用
 *   connect  生成/写入 whistle 网关规则，把 /rc_oa_gateway 切到预发布(pre)或项目环境(prj)
 *   open     打印真实域名访问地址，并探测本地实例与网关当前指向
 *
 * 只使用 Node 内置模块，无第三方依赖。
 * 知识来源：/home/joney/projects/web/web_mihawk_oa/AGENTS.md（本地开发环境搭建、启动前资源门禁）。
 * 说明：Node 内置 http/https 不读取 http_proxy/https_proxy 环境变量，
 * 因此脚本内所有探测请求天然直连；换成 curl 调试时需 --noproxy '*'。
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const https = require('https');
const querystring = require('querystring');
const { spawn, spawnSync } = require('child_process');

const PROJECT_DIR = '/home/joney/projects/web/web_mihawk_oa';
const DEV_PORT = 8116;
const DOMAIN = 'mihawk.oa.fenqile.com';
const GATEWAY_PATH = '/rc_oa_gateway';
const OPEN_URL = `https://${DOMAIN}/index.html#/index`;
// 预发布网关机 IP。这是“当前值”而非承诺不变的常量：预发布静态机相对稳定、变更频率低，
// 作为带注释的默认值使用，已变化时用 --ip 覆盖。项目环境(prj) IP 随时在变，一律动态发现，绝不硬编码。
const DEFAULT_PRE_GATEWAY_IP = '121.46.128.40';
const WHISTLE_PORT = 8899;
// 本 skill 的专属 whistle 分组名。脚本只整组覆盖这一个分组，绝不读改其他分组
// （用户有手工维护的公共分组和名为「项目」的分组，均不可触碰）。
const WHISTLE_GROUP = 'mihawk-gateway';
const NODE16_BIN = path.join(os.homedir(), '.nvm/versions/node/v16.16.0/bin');
// 与 web_mihawk_oa/AGENTS.md 一致：用精确 Node 版本覆盖整个进程树
const START_PATH = `${NODE16_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const QUERY_APP_SCRIPT = '/home/joney/projects/ai/agent-tools/skills/lexin/query-app-instances/scripts/query_app_instances.js';
const DEFAULT_PRJ_APP = 'server_hawk_decision_manage';
// 网关探活接口：返回含 retcode 或 rc_gateway_ip 的 JSON 才算通过
const PROBE_PATH = '/rc_oa_gateway/hawk_decision/alarm/rule/detail.json?alarm_rule_id=1';
// 冷启动资源硬门禁（依据 AGENTS.md：2026-08-10 webpack 常驻 1.6GiB 曾把 WSL 打挂）
const MIN_MEM_AVAILABLE_GIB = 6;
const MIN_SWAP_FREE_GIB = 2;
const MAX_PSI_FULL_AVG10 = 5;

function usage() {
    console.log(`用法: node frontend_env.js <doctor|start|connect|open> [选项]

  doctor                     启动前置门禁检查（只读，不改任何东西）
  start                      门禁全绿后启动 npm run dev:index；已有本项目健康实例则复用不重启
  connect --env pre|prj      生成 whistle 网关规则（默认只打印文本，不写入）
          [--app <name>]     prj 实例发现用的乐效应用名，默认 ${DEFAULT_PRJ_APP}
          [--ip <ip>]        跳过发现直接指定网关 IP（prj 下仍会先探活）
          [--whistle h[:p]]  覆盖 whistle 地址（默认取 \`ip route show default\` 的宿主机 IP:${WHISTLE_PORT}）
          [--apply]          调 whistle API 写入专属分组 ${WHISTLE_GROUP}（写入端点未实测，失败自动降级为手工粘贴）
  open                       打印访问地址并探测本地实例与网关当前指向`);
}

function parseArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const item = argv[index];
        if (!item.startsWith('--')) continue;
        const eq = item.indexOf('=');
        if (eq !== -1) {
            args[item.slice(2, eq)] = item.slice(eq + 1);
        } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
            args[item.slice(2)] = argv[index + 1];
            index += 1;
        } else {
            args[item.slice(2)] = true;
        }
    }
    return args;
}

// ---------- 基础探测 ----------

function readMeminfo() {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const pick = (key) => {
        const m = text.match(new RegExp('^' + key + ':\\s+(\\d+) kB', 'm'));
        return m ? Number(m[1]) : NaN;
    };
    return {
        memAvailableGiB: pick('MemAvailable') / 1024 / 1024,
        swapFreeGiB: pick('SwapFree') / 1024 / 1024,
    };
}

function readPsiFullAvg10(kind) {
    try {
        const text = fs.readFileSync('/proc/pressure/' + kind, 'utf8');
        const m = text.match(/full avg10=([0-9.]+)/);
        return m ? Number(m[1]) : null;
    } catch (_) {
        return null; // 内核未开启 PSI 时跳过
    }
}

function describePid(pid) {
    let cwd = '';
    let cmd = '';
    try { cwd = fs.readlinkSync('/proc/' + pid + '/cwd'); } catch (_) {}
    try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline').toString('utf8').replace(/\0+/g, ' ').trim(); } catch (_) {}
    return { pid, cwd, cmd };
}

function portListeningProcFallback(port) {
    const hex = port.toString(16).toUpperCase().padStart(4, '0');
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
        try {
            const text = fs.readFileSync(file, 'utf8');
            for (const line of text.split('\n').slice(1)) {
                const cols = line.trim().split(/\s+/);
                if (cols.length > 3 && cols[1].endsWith(':' + hex) && cols[3] === '0A') return true;
            }
        } catch (_) {}
    }
    return false;
}

function listListeners(port) {
    const res = spawnSync('ss', ['-ltnpH', `( sport = :${port} )`], { encoding: 'utf8' });
    if (res.error || res.status !== 0) {
        return { listening: portListeningProcFallback(port), pids: [], source: 'proc-fallback' };
    }
    const lines = (res.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const pids = [];
    for (const line of lines) {
        const re = /pid=(\d+)/g;
        let m;
        while ((m = re.exec(line))) {
            const pid = Number(m[1]);
            if (!pids.some((p) => p.pid === pid)) pids.push(describePid(pid));
        }
    }
    return { listening: lines.length > 0, pids, source: 'ss' };
}

function isProjectCwd(cwd) {
    if (!cwd) return false;
    let proj = PROJECT_DIR;
    let real = cwd;
    try { proj = fs.realpathSync(PROJECT_DIR); } catch (_) {}
    try { real = fs.realpathSync(cwd); } catch (_) {}
    return real === proj || real.startsWith(proj + path.sep);
}

function request(options, body) {
    return new Promise((resolve, reject) => {
        const lib = options.protocol === 'https:' ? https : http;
        const req = lib.request(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.setTimeout(options.timeoutMs || 10000, () => req.destroy(new Error('timeout after ' + (options.timeoutMs || 10000) + 'ms')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function probeLocalDev(timeoutMs) {
    return new Promise((resolve) => {
        const req = https.request({
            host: '127.0.0.1',
            port: DEV_PORT,
            path: '/',
            method: 'GET',
            rejectUnauthorized: false,
            timeout: timeoutMs || 5000,
        }, (res) => {
            res.resume();
            resolve({ ok: true, status: res.statusCode });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (err) => resolve({ ok: false, error: err.message }));
        req.end();
    });
}

function probeTcp(host, port, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const sock = net.connect({ host, port });
        const done = (ok, err) => {
            if (settled) return;
            settled = true;
            sock.destroy();
            resolve({ ok, error: err });
        };
        sock.setTimeout(timeoutMs || 3000, () => done(false, 'timeout'));
        sock.on('connect', () => done(true));
        sock.on('error', (e) => done(false, e.message));
    });
}

/**
 * 网关探活：TCP 443 可达 + 带 Host 头的 HTTPS 请求返回含 retcode 或 rc_gateway_ip 的 JSON。
 * 等价于: curl -sk --noproxy '*' -H "Host: mihawk.oa.fenqile.com" https://<ip>/rc_oa_gateway/...
 */
async function probeGateway(ip) {
    const tcp = await probeTcp(ip, 443, 3000);
    if (!tcp.ok) return { ok: false, step: 'tcp443', detail: tcp.error };
    let res;
    try {
        res = await request({
            protocol: 'https:',
            host: ip,
            port: 443,
            path: PROBE_PATH,
            method: 'GET',
            servername: DOMAIN,
            rejectUnauthorized: false,
            headers: { Host: DOMAIN },
            timeoutMs: 10000,
        });
    } catch (e) {
        return { ok: false, step: 'https', detail: e.message };
    }
    let json = null;
    try { json = JSON.parse(res.body); } catch (_) {}
    if (json && (Object.prototype.hasOwnProperty.call(json, 'retcode') || res.body.indexOf('rc_gateway_ip') !== -1)) {
        return { ok: true, status: res.status, retcode: json.retcode };
    }
    return { ok: false, step: 'body', detail: `status=${res.status}, body=${(res.body || '').slice(0, 120).replace(/\s+/g, ' ')}` };
}

// ---------- whistle ----------

function resolveWhistle(args) {
    if (args.whistle) {
        const parts = String(args.whistle).split(':');
        return { host: parts[0], port: Number(parts[1] || WHISTLE_PORT) };
    }
    // WSL2 NAT 模式下默认路由网关即 Windows 宿主机；宿主机 IP 会变，必须动态发现
    const res = spawnSync('ip', ['route', 'show', 'default'], { encoding: 'utf8' });
    const m = (res.stdout || '').match(/default\s+via\s+([0-9.]+)/);
    if (!m) throw new Error('无法从 `ip route show default` 解析 Windows 宿主机 IP；可用 --whistle <host[:port]> 指定');
    return { host: m[1], port: WHISTLE_PORT };
}

// /cgi-bin/rules/list 已实测无鉴权可读，返回 {"ec":0,...,"list":[{name,data,selected,...}]}
async function whistleGetList(w) {
    const res = await request({ host: w.host, port: w.port, path: '/cgi-bin/rules/list', method: 'GET', timeoutMs: 5000 });
    let json = null;
    try { json = JSON.parse(res.body); } catch (_) {}
    if (!json || json.ec !== 0 || !Array.isArray(json.list)) {
        throw new Error(`whistle /cgi-bin/rules/list 响应异常 (status=${res.status})`);
    }
    return json;
}

async function whistlePost(w, pathName, form) {
    const body = querystring.stringify(form);
    const res = await request({
        host: w.host,
        port: w.port,
        path: pathName,
        method: 'POST',
        timeoutMs: 8000,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
        },
    }, body);
    let json = null;
    try { json = JSON.parse(res.body); } catch (_) {}
    if (!json || json.ec !== 0) {
        throw new Error(`whistle ${pathName} 返回异常 (status=${res.status}, body=${(res.body || '').slice(0, 200)})`);
    }
    return json;
}

function buildRuleValue(env, app, ip, source) {
    return [
        '# managed-by: start-local-frontend（本分组由脚本整组覆盖，请勿手工编辑；切换环境请重跑 connect）',
        `# env=${env}` + (app ? ` app=${app}` : '') + ` source=${source} generated=${new Date().toISOString()}`,
        `${ip} ${DOMAIN}${GATEWAY_PATH}`,
    ].join('\n') + '\n';
}

function printManualInstructions(w) {
    const ui = w ? `http://${w.host}:${w.port}/` : `http://<Windows宿主机IP>:${WHISTLE_PORT}/`;
    console.log(`
手工启用步骤:
  1. 打开 whistle 界面 ${ui} -> Rules
  2. 若无 ${WHISTLE_GROUP} 则 Create 一个（名字必须精确为 ${WHISTLE_GROUP}），已有则打开
  3. 用上面内容整体替换该分组内容并保存、勾选启用
  4. 只改这一个分组；页面本体(127.0.0.1:${DEV_PORT})与 vui/assets/captcha/passport-odin
     等公共规则在你既有的公共分组里，保持不动
  5. 若公共分组里也有一条 ${DOMAIN}${GATEWAY_PATH} 规则，两条同 path 规则只有一条会生效
     （以 whistle 的匹配顺序为准），建议把公共组那条注释掉，让 ${WHISTLE_GROUP} 独占这条路径`);
}

async function applyWhistleGroup(w, value) {
    // 安全边界：只按精确名称操作专属分组，绝不读改其他分组（含用户手工维护的「项目」分组）
    const before = await whistleGetList(w);
    const existing = before.list.find((item) => item && item.name === WHISTLE_GROUP);
    if (existing && existing.data === value && existing.selected) {
        console.log(`· 分组 ${WHISTLE_GROUP} 已是目标内容且已启用，无需写入`);
        return;
    }
    const clientId = 'start-local-frontend-' + Date.now();
    if (!existing) {
        console.log(`· 创建分组 ${WHISTLE_GROUP}（POST /cgi-bin/rules/add，该端点未实测）`);
        await whistlePost(w, '/cgi-bin/rules/add', { name: WHISTLE_GROUP, value, clientId });
    }
    console.log(`· 写入并启用分组 ${WHISTLE_GROUP}（POST /cgi-bin/rules/select，该端点未实测）`);
    await whistlePost(w, '/cgi-bin/rules/select', {
        name: WHISTLE_GROUP,
        value,
        selected: 'true',
        active: 'true',
        clientId,
    });
    const after = await whistleGetList(w);
    const saved = after.list.find((item) => item && item.name === WHISTLE_GROUP);
    if (!saved || saved.data !== value) {
        throw new Error('写入后回读校验失败：分组不存在或内容不一致');
    }
    console.log('· 回读校验通过：内容一致' + (saved.selected
        ? '，分组已启用'
        : '；启用状态未能确认，请到 whistle 界面确认分组已勾选'));
}

// ---------- 乐效动态发现（prj） ----------

async function discoverPrjCandidates(app) {
    console.log(`· 通过乐效动态发现项目环境实例（app=${app}, env=prj），复用 query-app-instances 脚本...`);
    const res = spawnSync(process.execPath, [QUERY_APP_SCRIPT, '--app', app, '--env', 'prj', '--json'], {
        encoding: 'utf8',
        timeout: 300000,
        maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error) throw new Error('调用 query_app_instances.js 失败: ' + res.error.message);
    const stdout = res.stdout || '';
    const start = stdout.indexOf('{');
    let json = null;
    if (start !== -1) {
        try { json = JSON.parse(stdout.slice(start)); } catch (_) {}
    }
    if (res.status !== 0 || !json) {
        const errText = (res.stderr || stdout || '').trim().slice(0, 500);
        throw new Error('乐效实例发现失败: ' + errText
            + '\n  提示: 若为登录态问题，先用 get-browser-session skill 刷新乐效登录态后重试');
    }
    const candidates = [];
    const push = (ip, label) => {
        if (ip && !candidates.some((c) => c.ip === ip)) candidates.push({ ip, label });
    };
    const instances = json.instances || {};
    for (const vm of instances.vm || []) push(vm.ip, `vm env=${vm.env} status=${vm.run_status}`);
    for (const pod of instances.pod || []) {
        push(pod.host_ip, `pod host_ip (${pod.pod_name || ''})`);
        push(pod.pod_ip, `pod pod_ip (${pod.pod_name || ''})`);
    }
    if (!candidates.length) {
        const avail = (json.available_envs || []).map((e) => `${e.env}(${e.count})`).join(', ');
        throw new Error(`乐效未返回 prj 实例。该应用可用环境: ${avail || '未知'}`);
    }
    return candidates;
}

// ---------- doctor ----------

async function runDoctor() {
    const rows = [];
    const add = (level, name, msg) => rows.push({ level, name, msg });

    // 4 项之一：8116 端口（先查端口，供内存门禁判断是否为“复用”场景）
    const listeners = listListeners(DEV_PORT);
    let reuse = false;
    if (!listeners.listening) {
        add('PASS', 'port', `${DEV_PORT} 空闲`);
    } else {
        const own = listeners.pids.find((p) => isProjectCwd(p.cwd));
        const desc = listeners.pids.length
            ? listeners.pids.map((p) => `pid=${p.pid} cwd=${p.cwd || '?'} cmd=${(p.cmd || '').slice(0, 80)}`).join('; ')
            : `监听进程信息不可读（来源:${listeners.source}）`;
        if (own) {
            const health = await probeLocalDev(5000);
            if (health.ok) {
                reuse = true;
                add('PASS', 'port', `${DEV_PORT} 已被本项目实例监听且 HTTPS 有响应（${desc}）；start 将复用，不重启`);
            } else {
                add('FAIL', 'port', `${DEV_PORT} 被本项目实例占用但 HTTPS 无响应（可能仍在编译）：${desc}。`
                    + '等编译完成，或人工核对 PID/命令/cwd 后手工停止；绝不自动杀进程，绝不漂移到其他端口');
            }
        } else {
            add('FAIL', 'port', `${DEV_PORT} 已被占用且无法确认属于本项目：${desc}。`
                + '请人工核对后处理；绝不自动杀进程，绝不漂移到其他端口');
        }
    }

    // Node 必须 16.16.0（node-sass@7 在 Node 18+ 必定编译失败）
    const node16 = path.join(NODE16_BIN, 'node');
    if (!fs.existsSync(node16)) {
        add('FAIL', 'node', `未找到 ${node16}；node-sass@7 在 Node 18+ 必定编译失败，先 nvm install 16.16.0`);
    } else {
        const v = spawnSync(node16, ['--version'], { encoding: 'utf8' });
        const ver = (v.stdout || '').trim();
        if (ver === 'v16.16.0') add('PASS', 'node', `${node16} (${ver})`);
        else add('FAIL', 'node', `${node16} 版本异常: ${ver || (v.stderr || '').trim()}`);
    }

    // 内存硬门禁（冷启动）：MemAvailable >= 6 GiB 且 SwapFree >= 2 GiB
    const mem = readMeminfo();
    const memText = `MemAvailable=${mem.memAvailableGiB.toFixed(2)} GiB, SwapFree=${mem.swapFreeGiB.toFixed(2)} GiB`
        + `（门禁: >= ${MIN_MEM_AVAILABLE_GIB} GiB / >= ${MIN_SWAP_FREE_GIB} GiB）`;
    if (mem.memAvailableGiB >= MIN_MEM_AVAILABLE_GIB && mem.swapFreeGiB >= MIN_SWAP_FREE_GIB) {
        add('PASS', 'mem', memText);
    } else if (reuse) {
        add('WARN', 'mem', `${memText}。低于冷启动门禁，但本次将复用已有实例、不新增编译负载；请勿再并行启动 Maven/生产构建`);
    } else {
        add('FAIL', 'mem', `${memText}。低于冷启动硬门禁，拒绝启动。`
            + '依据: webpack 常驻约 1.6 GiB，曾在低内存下把 WSL 打挂（见 web_mihawk_oa/AGENTS.md）。先释放内存/Swap 再试');
    }

    // PSI：memory/io 的 full avg10 > 5% 时警告
    for (const kind of ['memory', 'io']) {
        const avg10 = readPsiFullAvg10(kind);
        if (avg10 === null) add('WARN', 'psi', `/proc/pressure/${kind} 不可读，跳过压力检查`);
        else if (avg10 > MAX_PSI_FULL_AVG10) add('WARN', 'psi', `${kind} full avg10=${avg10}% 高于 ${MAX_PSI_FULL_AVG10}%，建议等压力回落，不与 Maven/生产构建并行`);
        else add('PASS', 'psi', `${kind} full avg10=${avg10}%`);
    }

    // 代理环境变量提醒
    const proxyKeys = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']
        .filter((key) => process.env[key]);
    if (proxyKeys.length) {
        add('WARN', 'proxy', `检测到代理变量: ${proxyKeys.join(', ')}。WSL 内 curl 调试需加 --noproxy '*'；`
            + 'npm install 需整体绕开代理（内网私服走代理返回 405）。本脚本自身的探测不受代理影响');
    } else {
        add('PASS', 'proxy', '未设置代理环境变量');
    }

    console.log('doctor 检查结果:');
    for (const row of rows) console.log(`  [${row.level}] ${row.name}: ${row.msg}`);
    const failed = rows.some((row) => row.level === 'FAIL');
    console.log(failed ? '结论: 存在 FAIL，禁止冷启动。' : (reuse ? '结论: 全绿（已有健康实例，start 将复用）。' : '结论: 全绿，可以启动。'));
    return { failed, reuse, rows };
}

// ---------- 子命令 ----------

async function cmdDoctor() {
    const result = await runDoctor();
    if (result.failed) process.exitCode = 1;
}

async function cmdStart() {
    const result = await runDoctor();
    if (result.reuse) {
        console.log(`\n复用已有实例，不重启。访问方式见: node ${__filename} open`);
        console.log('验证浏览器确实连到本地: ss -tan state all | grep 8116 （出现 ESTAB 才算）');
        return;
    }
    if (result.failed) {
        console.error('\ndoctor 未全绿，拒绝启动。处理完 FAIL 项后重试。');
        process.exitCode = 1;
        return;
    }
    console.log('\n即将执行: npm run dev:index');
    console.log(`工作目录: ${PROJECT_DIR}`);
    console.log(`PATH: ${START_PATH}`);
    console.log('提示: dev:index 只编译 Index 入口；冷编译需数分钟。端口开始监听不代表编译完成，');
    console.log('     等 webpack 明确输出编译完成再访问；编译期间不要启动第二个实例。\n');
    const child = spawn('npm', ['run', 'dev:index'], {
        cwd: PROJECT_DIR,
        env: Object.assign({}, process.env, { PATH: START_PATH }),
        stdio: 'inherit',
    });
    child.on('error', (e) => {
        console.error('启动失败: ' + e.message);
        process.exit(1);
    });
    child.on('exit', (code) => process.exit(code == null ? 1 : code));
}

async function cmdConnect(args) {
    const env = String(args.env || '').toLowerCase();
    if (env !== 'pre' && env !== 'prj') {
        console.error('用法: connect --env pre|prj [--app <乐效应用名>] [--ip <网关IP>] [--whistle h[:p]] [--apply]');
        process.exitCode = 2;
        return;
    }
    const app = env === 'prj' ? String(args.app || DEFAULT_PRJ_APP) : null;

    // whistle API 地址动态发现（宿主机 IP 会变，不硬编码）
    let whistle = null;
    try {
        whistle = resolveWhistle(args);
        await whistleGetList(whistle);
        console.log(`· whistle 可达: http://${whistle.host}:${whistle.port}`);
    } catch (e) {
        console.log('! whistle 不可达: ' + e.message);
        whistle = null;
    }

    // 确定目标网关 IP
    let ip = null;
    let source = '';
    if (env === 'pre') {
        ip = String(args.ip || DEFAULT_PRE_GATEWAY_IP);
        source = args.ip ? '--ip' : 'default-constant';
        const probe = await probeGateway(ip);
        if (probe.ok) {
            console.log(`· 预发布网关探活通过: ${ip} (retcode=${probe.retcode})`);
        } else {
            console.log(`! 预发布网关探活未通过（${probe.step}: ${probe.detail}）。`
                + 'WSL 直连与浏览器经 whistle 的网络路径不同，规则仍可能可用；若确认 IP 已变化，用 --ip 覆盖');
        }
    } else {
        const candidates = args.ip
            ? [{ ip: String(args.ip), label: '--ip 参数' }]
            : await discoverPrjCandidates(app);
        console.log(`· 候选实例 ${candidates.length} 个: ${candidates.map((c) => `${c.ip}(${c.label})`).join(', ')}`);
        const failures = [];
        for (const candidate of candidates) {
            const probe = await probeGateway(candidate.ip);
            if (probe.ok) {
                ip = candidate.ip;
                source = args.ip ? '--ip' : 'lexiao-discovery';
                console.log(`· 探活通过: ${candidate.ip} (retcode=${probe.retcode})`);
                break;
            }
            failures.push(`${candidate.ip}: ${probe.step} ${probe.detail}`);
        }
        if (!ip) {
            console.error('探活全部失败，拒绝生成规则（项目环境 IP 必须探活通过才可用）:');
            for (const failure of failures) console.error('  - ' + failure);
            process.exitCode = 1;
            return;
        }
    }

    const value = buildRuleValue(env, app, ip, source);
    console.log(`\n===== whistle 专属分组 ${WHISTLE_GROUP} 目标内容 =====`);
    process.stdout.write(value);
    console.log('====================================================');

    if (!args.apply) {
        console.log('\n（默认只打印，不写入。确认无误后加 --apply 尝试自动写入 whistle。）');
        printManualInstructions(whistle);
        return;
    }
    if (!whistle) {
        console.log('\n! --apply 无法执行（whistle 不可达），回退为手工粘贴:');
        printManualInstructions(null);
        return;
    }
    try {
        await applyWhistleGroup(whistle, value);
        console.log(`\n完成。当前 ${GATEWAY_PATH} -> ${ip}（env=${env}）。用 open 子命令复核。`);
    } catch (e) {
        // 写入端点未实测，失败属预期风险：降级为手工粘贴，不报错退出
        console.log('\n! whistle 写入 API 调用失败（add/select 端点未实测，失败属预期）: ' + e.message);
        console.log('回退为手工粘贴:');
        printManualInstructions(whistle);
    }
}

async function cmdOpen(args) {
    console.log(`访问地址: ${OPEN_URL}`);
    console.log(`说明: 必须让浏览器走 whistle 代理并用真实域名访问（登录 cookie 绑在 oa.fenqile.com 域），不要用 127.0.0.1:${DEV_PORT} 直连。\n`);

    // 探测 1：本地 dev server
    const listeners = listListeners(DEV_PORT);
    if (!listeners.listening) {
        console.log(`! 本地 ${DEV_PORT} 未监听：先运行 start 子命令`);
    } else {
        const health = await probeLocalDev(5000);
        if (health.ok) console.log(`· 本地 ${DEV_PORT} HTTPS 有响应 (status=${health.status})`);
        else console.log(`! 本地 ${DEV_PORT} 已监听但 HTTPS 无响应（可能仍在编译）: ${health.error}`);
    }

    // 探测 2：whistle 专属分组当前指向
    try {
        const w = resolveWhistle(args);
        const list = await whistleGetList(w);
        const group = list.list.find((item) => item && item.name === WHISTLE_GROUP);
        if (!group) {
            console.log(`! whistle(http://${w.host}:${w.port}) 无 ${WHISTLE_GROUP} 分组：先运行 connect --env pre|prj`);
        } else {
            const data = String(group.data || '');
            const envMatch = data.match(/^# env=(\w+)/m);
            let ip = null;
            for (const line of data.split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2 && !parts[0].startsWith('#') && parts[1].startsWith(DOMAIN)) {
                    ip = parts[0];
                    break;
                }
            }
            const envGuess = envMatch ? `env=${envMatch[1]}` : (ip === DEFAULT_PRE_GATEWAY_IP ? 'env≈pre(等于默认常量)' : 'env=未知(自定义?)');
            console.log(`· whistle 分组 ${WHISTLE_GROUP}: ${group.selected ? '已启用' : '未启用（需在界面勾选）'}，网关指向 ${ip || '未识别'}（${envGuess}）`);
        }
    } catch (e) {
        console.log('! 读取 whistle 状态失败: ' + e.message);
    }

    console.log(`\n验证真的走到本地: ss -tan state all | grep ${DEV_PORT}`);
    console.log('出现 ESTAB 长连接（webpack HMR WebSocket）才说明浏览器连上了本地；只有 LISTEN 说明页面其实来自预发布。');
}

async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    const args = parseArgs(argv.slice(1));
    if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
        usage();
        return;
    }
    if (cmd === 'doctor') return cmdDoctor(args);
    if (cmd === 'start') return cmdStart(args);
    if (cmd === 'connect') return cmdConnect(args);
    if (cmd === 'open') return cmdOpen(args);
    console.error('未知子命令: ' + cmd + '\n');
    usage();
    process.exitCode = 2;
}

if (require.main === module) {
    main().catch((error) => {
        console.error('执行失败: ' + error.message);
        process.exit(1);
    });
}

module.exports = {
    buildRuleValue,
    parseArgs,
    probeGateway,
    resolveWhistle,
};
