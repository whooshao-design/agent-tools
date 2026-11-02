#!/usr/bin/env node
'use strict';
/**
 * 米霍克 OA 前端（web_mihawk_oa）本地开发会话管理。
 *
 * 子命令：
 *   doctor   启动前置门禁（Node 版本 / 内存 / PSI / 8116 端口 / 代理提醒），只读
 *   start    门禁全绿后启动本地 webpack（npm run dev:index）；已有本项目健康实例则复用
 *   connect  把当前 whistle 联调分组里的米霍克网关行切到预发布(pre)或项目环境(prj)，默认只预览
 *   open     打印真实域名访问地址，并探测本地实例与网关当前指向
 *
 * 只使用 Node 内置模块，无第三方依赖。
 * 知识来源：/home/joney/projects/frontend/web_mihawk_oa/AGENTS.md（本地开发环境搭建、启动前资源门禁）。
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

const PROJECT_DIR = '/home/joney/projects/frontend/web_mihawk_oa';
const DEV_PORT = 8116;
const DOMAIN = 'mihawk.oa.fenqile.com';
const GATEWAY_PATH = '/rc_oa_gateway';
const OPEN_URL = `https://${DOMAIN}/index.html#/index`;
// 预发布网关机 IP。这是“当前值”而非承诺不变的常量：预发布静态机相对稳定、变更频率低，
// 作为带注释的默认值使用，已变化时用 --ip 覆盖。项目环境(prj) IP 随时在变，一律动态发现，绝不硬编码。
const DEFAULT_PRE_GATEWAY_IP = '121.46.128.40';
const WHISTLE_PORT = 8899;
const NODE16_BIN = path.join(os.homedir(), '.nvm/versions/node/v16.16.0/bin');
// 与 web_mihawk_oa/AGENTS.md 一致：用精确 Node 版本覆盖整个进程树
const START_PATH = `${NODE16_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const QUERY_APP_SCRIPT = '/home/joney/projects/ai/agent-tools/skills/lexin/query-app-instances/scripts/query_app_instances.js';
// 项目环境的 /rc_oa_gateway 由独立网关机承接（每个项目环境一台 server_rc_oa_gateway_java VM），
// 不是业务应用（如 manage Pod）的 IP；prj 网关有上百台且不按需求打标，无法安全自动选择
const PRJ_GATEWAY_APP = 'server_rc_oa_gateway_java';
const PRJ_GATEWAY_HINT_LIMIT = 5;
// 网关探活接口：返回含 retcode 或 rc_gateway_ip 的 JSON 才算通过
const PROBE_PATH = '/rc_oa_gateway/hawk_decision/alarm/rule/detail.json?alarm_rule_id=1';
// 冷启动资源硬门禁（依据 AGENTS.md：2026-08-10 webpack 常驻 1.6GiB 曾把 WSL 打挂）
const MIN_MEM_AVAILABLE_GIB = 6;
// 2026-09-07 由 2 降为 0.5：三次实测（MemAvailable 7.0/8.2/7.1 GiB、SwapFree 0.8~1.7 GiB）启动后 swap 均未增长、
// 内存压力为 0。真正的风险驱动是 MemAvailable（事故现场是 1.5 GiB + swap 耗尽），swap 只需留一点余量防抖
const MIN_SWAP_FREE_GIB = 0.5;
const MAX_PSI_FULL_AVG10 = 5;

function usage() {
    console.log(`用法: node frontend_env.js <doctor|start|connect|open> [选项]

  doctor                     启动前置门禁检查（只读，不改任何东西）
  start                      门禁全绿后启动 npm run dev:index；已有本项目健康实例则复用不重启
  connect --env pre|prj      预览把联调分组里的米霍克网关行改到目标网关 IP（默认不写入）
          [--ip <ip>]        网关 IP。prj 必填（项目环境网关机，见乐效项目环境页），探活通过才修改；
                             prj 未传时只列出最近创建的 ${PRJ_GATEWAY_APP} 运行中实例作参考并退出
          [--whistle h[:p]]  覆盖 whistle 地址（默认取 \`ip route show default\` 的宿主机 IP:${WHISTLE_PORT}）
          [--group <名称>]   要改的 whistle 分组；默认取唯一一个含米霍克网关行的已启用分组
          [--apply]          写入该分组（只替换网关行的 IP）并回读校验
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

// 米霍克页面经网关访问的规则目标（whistle 规则写法 `<ip> <目标>`），取自用户「本地-项目」分组（2026-11-02）。
// 同组里 cs、ruleengin 等其他系统的 /rc_oa_gateway 有意指向预发布，不在此列，connect 不改它们
const GATEWAY_TARGETS = [
    `${DOMAIN}${GATEWAY_PATH}`,
    `gateway.oa.fenqile.com${GATEWAY_PATH}`,
    `hawkeye.oa.fenqile.com${GATEWAY_PATH}`,
    `${DOMAIN}/groovy-lint`,
];
const PAGE_RULE_TARGET = `127.0.0.1:${DEV_PORT}`;

// 解析一行 whistle 规则为 { ip, target }；空行、注释和不足两段的行返回 null
function parseRuleLine(line) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2 || parts[0].startsWith('#')) return null;
    return { ip: parts[0], target: parts[1] };
}

function hasGatewayLine(data) {
    return String(data || '').split('\n').some((line) => {
        const rule = parseRuleLine(line);
        return rule && GATEWAY_TARGETS.includes(rule.target);
    });
}

// 只把 GATEWAY_TARGETS 行的 IP 换成 ip，其余行原样保留；分组里没有的目标只报告，不新增
function rewriteGatewayLines(data, ip) {
    const found = new Set();
    const changes = [];
    const value = String(data || '').split('\n').map((line) => {
        const rule = parseRuleLine(line);
        if (!rule || !GATEWAY_TARGETS.includes(rule.target)) return line;
        found.add(rule.target);
        if (rule.ip === ip) return line;
        changes.push({ target: rule.target, from: rule.ip });
        return line.replace(rule.ip, ip);
    }).join('\n');
    return { value, changes, missing: GATEWAY_TARGETS.filter((target) => !found.has(target)) };
}

// 要改的分组：--group 指定的分组；未指定时取唯一一个含米霍克网关行的已启用分组。
// 单选模式下启用一个独立分组会关掉用户的联调分组（缺页面规则），所以改用户正在用的分组，不另建分组
function pickTargetGroup(list, name) {
    if (name) {
        const group = list.find((item) => item && item.name === name);
        if (!group) throw new Error(`whistle 中没有分组「${name}」`);
        return group;
    }
    const candidates = list.filter((item) => item && item.selected && hasGatewayLine(item.data));
    if (candidates.length !== 1) {
        throw new Error(`已启用分组中含米霍克网关行的有 ${candidates.length} 个`
            + `（${candidates.map((item) => item.name).join(', ') || '无'}），用 --group <分组名> 指定要改的分组`);
    }
    return candidates[0];
}

function printManualLines(ip) {
    console.log('手工修改: 在 whistle 界面 Rules 里打开当前联调分组，把下面这些目标的行改成:');
    for (const target of GATEWAY_TARGETS) console.log(`  ${ip} ${target}`);
}

// ---------- 乐效动态发现（prj） ----------

async function listRecentPrjGateways() {
    console.log(`· 查询项目环境网关实例（app=${PRJ_GATEWAY_APP}, env=prj），复用 query-app-instances 脚本...`);
    const res = spawnSync(process.execPath, [QUERY_APP_SCRIPT, '--app', PRJ_GATEWAY_APP, '--env', 'prj', '--type', 'vm', '--json'], {
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
        throw new Error('乐效实例查询失败: ' + errText
            + '\n  提示: 若为登录态问题，先用 get-browser-session skill 刷新乐效登录态后重试');
    }
    return ((json.instances || {}).vm || [])
        .filter((vm) => vm.ip && vm.run_status === 'RUNNING')
        .map((vm) => ({ ip: vm.ip, createTime: (vm.raw && vm.raw.create_time) || '' }))
        .sort((a, b) => b.createTime.localeCompare(a.createTime))
        .slice(0, PRJ_GATEWAY_HINT_LIMIT);
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

    // 内存硬门禁（冷启动）：MemAvailable >= 6 GiB 且 SwapFree >= 0.5 GiB
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
    if ((env !== 'pre' && env !== 'prj') || args.group === true) {
        console.error('用法: connect --env pre|prj [--ip <网关IP>] [--group <分组名>] [--whistle h[:p]] [--apply]');
        process.exitCode = 2;
        return;
    }
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
    if (env === 'pre') {
        ip = String(args.ip || DEFAULT_PRE_GATEWAY_IP);
        const probe = await probeGateway(ip);
        if (probe.ok) {
            console.log(`· 预发布网关探活通过: ${ip} (retcode=${probe.retcode})`);
        } else {
            console.log(`! 预发布网关探活未通过（${probe.step}: ${probe.detail}）。`
                + 'WSL 直连与浏览器经 whistle 的网络路径不同，规则仍可能可用；若确认 IP 已变化，用 --ip 覆盖');
        }
    } else {
        if (!args.ip) {
            // 多个项目环境的网关同时运行，任意一台都能探活通过，自动挑选会静默连到别人的环境
            const recent = await listRecentPrjGateways();
            console.error('prj 必须用 --ip 指定本项目环境的网关机 IP（乐效项目环境页可查；部署项目环境时新建的那台）。');
            console.error(`最近创建的运行中 ${PRJ_GATEWAY_APP} 实例（仅供参考，不能据此认定归属）:`);
            for (const vm of recent) console.error(`  - ${vm.ip}  create_time=${vm.createTime || '?'}`);
            process.exitCode = 2;
            return;
        }
        ip = String(args.ip);
        const probe = await probeGateway(ip);
        if (!probe.ok) {
            console.error(`探活失败，拒绝修改（项目环境网关必须探活通过才可用）: ${ip}: ${probe.step} ${probe.detail}`);
            process.exitCode = 1;
            return;
        }
        console.log(`· 探活通过: ${ip} (retcode=${probe.retcode})`);
    }

    if (!whistle) {
        printManualLines(ip);
        return;
    }
    let group;
    try {
        group = pickTargetGroup((await whistleGetList(whistle)).list, args.group);
    } catch (e) {
        console.error('! ' + e.message);
        printManualLines(ip);
        process.exitCode = 1;
        return;
    }
    const { value, changes, missing } = rewriteGatewayLines(group.data, ip);
    console.log(`\n目标分组「${group.name}」：${group.selected ? '已启用'
        : '未启用；写入时会启用它，whistle 单选模式下会同时关掉当前启用的分组'}`);
    for (const change of changes) console.log(`  - ${change.from} ${change.target}\n  + ${ip} ${change.target}`);
    if (missing.length) {
        console.log(`! 分组里没有这些网关行，脚本不新增，需要时手工加: ${missing.map((target) => `${ip} ${target}`).join('; ')}`);
    }
    if (!changes.length && group.selected) {
        console.log(`· 网关行已指向 ${ip}，无需修改`);
        return;
    }
    if (!args.apply) {
        console.log('\n（只预览，未写入。确认后加 --apply；回退时用 --ip <上面 - 行的原 IP> 再执行一次。）');
        return;
    }
    // /cgi-bin/rules/select 保存分组内容并启用，2026-11-02 实测可用（ec=0，回读内容一致、保持启用）
    await whistlePost(whistle, '/cgi-bin/rules/select', {
        name: group.name,
        value,
        selected: 'true',
        active: 'true',
        clientId: 'start-local-frontend-' + Date.now(),
    });
    const saved = (await whistleGetList(whistle)).list.find((item) => item && item.name === group.name);
    if (!saved || saved.data !== value) throw new Error(`写入后回读校验失败：分组「${group.name}」内容不一致`);
    console.log(`\n完成。「${group.name}」的米霍克网关行 -> ${ip}（env=${env}），`
        + (saved.selected ? '分组已启用' : '启用状态未能确认，请到 whistle 界面确认') + '。用 open 子命令复核。');
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

    // 探测 2：已启用分组里的页面规则和米霍克网关行（单选模式下只看当前启用的那个分组）
    try {
        const w = resolveWhistle(args);
        const enabled = (await whistleGetList(w)).list.filter((item) => item && item.selected);
        console.log(`· whistle(http://${w.host}:${w.port}) 已启用分组: ${enabled.map((item) => item.name).join(', ') || '无'}`);
        const gatewayRules = [];
        const pageGroups = [];
        for (const item of enabled) {
            for (const line of String(item.data || '').split('\n')) {
                const rule = parseRuleLine(line);
                if (!rule) continue;
                if (GATEWAY_TARGETS.includes(rule.target)) gatewayRules.push({ group: item.name, ip: rule.ip, target: rule.target });
                if ((rule.ip === PAGE_RULE_TARGET && rule.target === DOMAIN) || (rule.ip === DOMAIN && rule.target === PAGE_RULE_TARGET)) {
                    pageGroups.push(item.name);
                }
            }
        }
        if (pageGroups.length) console.log(`· 页面规则 ${PAGE_RULE_TARGET} ${DOMAIN} 在: ${pageGroups.join(', ')}`);
        else console.log(`! 已启用分组里没有 \`${PAGE_RULE_TARGET} ${DOMAIN}\`：页面不会来自本地`);
        if (!gatewayRules.length) {
            console.log('! 已启用分组里没有米霍克网关行：接口会走真实 DNS（线上）');
        } else {
            for (const rule of gatewayRules) console.log(`  ${rule.ip} ${rule.target}（${rule.group}）`);
            const ips = [...new Set(gatewayRules.map((rule) => rule.ip))];
            if (ips.length > 1) {
                console.log(`! 米霍克网关行指向多个 IP: ${ips.join(', ')}。用 connect --env pre|prj 统一`);
            } else {
                console.log(`· 网关指向 ${ips[0]}（${ips[0] === DEFAULT_PRE_GATEWAY_IP
                    ? '预发布' : '非预发布默认 IP；项目环境时核对它是本环境的网关机 IP'}）`);
            }
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
    parseArgs,
    pickTargetGroup,
    probeGateway,
    resolveWhistle,
    rewriteGatewayLines,
};
