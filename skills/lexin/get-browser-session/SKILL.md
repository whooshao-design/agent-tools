---
name: get-browser-session
description: 获取、检查、续期和复用 WSL Playwright/Chromium 浏览器登录态与网页 session（底层会话层，供其他 skill 复用）。Use when 需要访问要求登录的内网页面、检查或定时续期浏览器 profile 登录态、打开浏览器让用户完成 SSO/OTP 登录、复用已保存 profile 做页面自动化，或按默认脱敏方式查看 session Cookie/localStorage token。
metadata:
  version: 1.7.0
---

# Get Browser Session

## Feishu Boundary

`https://lexin.feishu.cn/docx/*` 与 `https://lexin.feishu.cn/wiki/*` 的内容读取、写入和权限处理不属于本 Skill，必须交给 `manage-feishu-doc` 通过 Lark MCP 完成。即使网络探测能直连该域名，也不要为飞书文档启动浏览器会话；Linux 设备合规策略会拦截文档登录。

## Workflow

Prefer the bundled script over rewriting browser setup code:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js --status --url=<url>
```

Use the existing WSL browser tool at `~/tools/lexiao-browser` by default. Override with `--tool-dir`, `--chrome`, `--runtime-lib-dir`, or `--profile` only when the local setup differs.

When another skill needs a logged-in browser session, use this skill as the session layer. The calling skill should pass only the target `url`, the intended `profile`, and an optional `success-text`; do not duplicate login instructions in the calling skill.

MCP 优先：能用 `browser_session` MCP 时，优先使用 `check_session` / `renew_session` / `export_session` / `browser_page_snapshot` / `browser_click_text` / `browser_click_button` / `get_cookies` / `fetch_with_session`；脚本作为兜底入口。

## Check Existing Session

Run a headless status check first:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --url=https://lexiao.oa.fenqile.com/#/app-publish/51303 \
  --success-text=当前环境
```

Treat `sessionReady: true` as a usable login state. Also inspect `sessionState`: `LOGIN_REQUIRED` means the profile is missing or expired, `PROXY_INTERCEPTED` means the child browser reached ATrust/乐空间 instead of the target, `FORBIDDEN` means the current user lacks access, and `UPSTREAM_ERROR` means the target returned an HTTP error and must not be treated as a valid session.

For non-Lexiao pages, always pass a page-specific `--url` and `--profile`. If there is no stable success marker on the target page, use `--success-text=none` and rely on the default login detection, which covers Chinese login words, the English OA page markers `Work Happy`, `QR Code`, `Use MOA` / `MOA`, `Account Login`, `Password Login`, and `Sign in`, plus password input fields; if there is a stable marker, pass it explicitly.

For environment diagnostics:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js --doctor
```

Inspect `wslgHealth` in the result before interactive login. `copyMode: true` means WSLg failed to allocate its shared-memory transport; save current WSL work, run `wsl.exe --shutdown` from Windows PowerShell, then reopen WSL before retrying.

## WebShell / Gotty Pages

For WebShell pages such as `https://webshell.oa.fenqile.com/?arg=...`, use this skill only to confirm the browser session and login state:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --status \
  --profile=/home/joney/.cache/healthy-dashboard-profile \
  --url=<login_pod_addr> \
  --success-text=none
```

WebShell uses stricter readiness semantics than a generic OA page:

- The default profile is `~/.codex/webshell-direct-profile` unless `--profile` is explicit.
- The Chromium child process runs direct by default; see "Network Policy". Global proxy settings outside the browser are untouched.
- `READY` requires the browser to stay on `webshell.oa.fenqile.com` and expose an xterm/terminal DOM for three consecutive polls.
- `乐空间传送门`、`ATrust`、登录页和 403 markers override transient Gotty titles and terminal elements.
- `snippet` may be empty because xterm uses canvas; use `sessionState/terminalReady/stableReadyPolls` instead of body text alone.

Do not use this skill to execute server commands or read logs; container log reads belong to `java-server-diagnostics`, using `/home/joney/projects/ai/agent-tools/skills/lexin/java-server-diagnostics/scripts/webshell_log_check.js` when a Gotty WebSocket or terminal interaction is needed.

## Network Policy

**This browser is direct-only. It must never talk through a proxy — for any host, in any mode.** There is deliberately no flag, option, or environment variable that turns the proxy back on.

The reason is the exit IP. On this workstation `HTTP(S)_PROXY`/`ALL_PROXY` point at a local HTTP→SOCKS bridge whose exit lands in another country, so a proxied login looks like it came from a foreign cloud host. That trips risk control on Feishu/OA-class accounts, raises security alerts, and can invalidate a session immediately after it is issued.

Every launch therefore strips `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (both cases) from the Chromium child environment, extends `NO_PROXY`, and passes `--no-proxy-server`. Results report `networkPolicy: "direct-only"`; treat any other value as a bug in this skill, not as a configuration choice.

Direct reachability was verified for both internal OA hosts and external SaaS such as `lexin.feishu.cn`, where it is also roughly 12x faster than the proxied path. This is a network observation only; Feishu document content operations remain excluded by "Feishu Boundary" above. If some future target is genuinely unreachable direct, fix routing or DNS for that target — do not reintroduce a proxy opt-in here.

Only the Chromium child process is affected; the shell's own proxy settings are left untouched.

## Obtain Or Refresh Session

If the session is missing, use `--ensure`. It first checks the target URL headlessly and returns immediately when the saved session is already usable. If login is required, it opens a headed browser and lets the user complete login in the browser window. In WSL, the script auto-fills WSLg display variables when the Codex process did not inherit `DISPLAY`.

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --ensure \
  --url=https://lexiao.oa.fenqile.com/#/app-publish/51303 \
  --success-text=当前环境
```

Before opening a headed browser, `--ensure` checks WSLg health. If WSLg is in COPY MODE, or a headed browser otherwise cannot be opened, it returns JSON with `ensureStrategy: "headless-screenshot"` and `loginScreenshot` instead of opening an unusable window or failing with raw Chromium/XServer errors. For COPY MODE, follow `wslgHealth.recoveryCommand`; otherwise scan the screenshot, then rerun the status check or `--ensure`.

Do not ask the user for passwords, OTP codes, private keys, or cookies in chat. Ask only for the user to finish login in the opened browser window. After the script exits, rerun the headless status check before continuing automation.

The default profile is:

```bash
~/.cache/lexiao-browser-profile
```

Profile selection is shared across the skill and MCP tools: explicit `--profile` first, then `BROWSER_SESSION_PROFILE`, then `DEVTOOLS_BROWSER_PROFILE`, and finally the default above. Keep other skills on the same profile instead of creating a second implicit profile.

WebShell defaults to the isolated profile `~/.codex/webshell-direct-profile`. To refresh it, run `--ensure --url=<login_pod_addr> --success-text=none` and complete SSO in the opened browser.

`browser_session` script and MCP calls using the same profile are serialized with a cross-process lock. Other scripts and independently opened Chromium instances are outside this lock; if Chrome still reports the profile is already in use, close the competing WSL Chromium process or rerun the whole flow with a different explicit `--profile`.

## Session Lifecycle And Renewal

Use `renew_session` for an explicit one-shot renewal. The equivalent script command is headless even if `--headed` is also passed, visits the target page in the shared persistent profile, and saves response `Set-Cookie` changes without returning page text, Cookie values, or storage values:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --renew \
  --url=https://lexiao.oa.fenqile.com/ \
  --success-text=当前环境
```

Renewal state is decided by actual Cookie change, not by page text:

- `SESSION_RENEWED` means authentication Cookies were re-signed during the visit; `authRenewal.renewed` / `authRenewal.added` list exactly which ones. **This is the state to expect from `passport.lexincloud.com`, whose landing page looks like a login page even when renewal succeeded** — never treat that page text as failure.
- `SESSION_ACTIVE` means the session was usable but no authentication Cookie changed.
- `LOGIN_REQUIRED` / `PROXY_INTERCEPTED` with no Cookie change means run `ensure_session` interactively; background renewal never opens a headed browser and never retries indefinitely.

Only `https://passport.lexincloud.com/` re-signs the fixed-lifetime tickets (`oa_token_id` / `mid`). Business pages such as 乐效 or Healthy only slide `oa_session`, so they cannot substitute for the SSO endpoint. `oa_token_id` follows "issue when missing, leave alone when present": it is re-issued automatically once expired and cleared, so an expired ticket does not require manual login.

To install the default Lexiao renewal as a systemd user timer, run:

```bash
python /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/install_session_renewal.py
```

The installer performs one renewal immediately, then schedules the same headless sweep daily at 11:00 (`OnCalendar=*-*-* 11:00:00`, up to 5 minutes of randomized delay). Pass `--schedule` for a different `OnCalendar` expression. It renews four targets in order, each as its own skippable `ExecStart` so one failure never aborts the rest:

1. `passport.lexincloud.com` on the main profile — the only entry that re-signs fixed-lifetime tickets;
2. `passport.lexincloud.com` on the Healthy profile — that profile is separate and is not covered by the main one;
3. `lexiao.oa.fenqile.com` on the main profile — slides `oa_session` and verifies reachability;
4. `lxcloud.oa.fenqile.com` on the main profile — refreshes the localStorage token and writes the session snapshot.

The timer runs while the WSL systemd user manager is active. `Persistent=true` matters on WSL: the machine is often shut down at 11:00, and without it that day's run would simply be skipped — instead it is caught up on the next boot. `OnBootSec=5m` additionally refreshes the session shortly after WSL starts. Remove only these units with `--uninstall`.

At a daily cadence the 10-day tickets still have 10x margin, but `oa_token_id` — which is only re-issued when missing — can stay expired for up to 24 hours before the next sweep re-seeds it. If that window causes trouble for OA-domain sites, either run the service manually or install a twice-daily schedule such as `--schedule='*-*-* 11,23:00:00'`. Do not describe this as a permanent or guaranteed login: account policy, SSO revocation, network interruption, or a stopped WSL instance can still let the session expire.

## Session Snapshot

`export_session` visits the target page and writes that profile's Cookies plus localStorage to a JSON file with mode `0600`:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --export-session=~/.cache/agent-tools-session/main.json \
  --url=https://lxcloud.oa.fenqile.com/ \
  --success-text=none
```

The timer keeps `~/.cache/agent-tools-session/main.json` current. Downstream skills that need the lxcloud `token` may read it directly instead of launching Chromium and contending for the profile lock. `storageState` only captures localStorage for origins visited in that run, so export against the origin whose token is needed. The file holds credentials in cleartext — keep it at `0600`, never copy it into a repository, a log, or a reply.

Status checks and `--ensure` also visit the target page on demand, so a server-side sliding session can refresh its Cookie naturally. `fetch_with_session` runs inside the same BrowserContext rather than copying a Cookie header into a separate HTTP client; response `Set-Cookie` values are therefore persisted back to the profile.

Every page or authenticated-request result includes `sessionHealth` with Cookie counts and the earliest persistent-Cookie expiry. `persistentCookieExpiringSoon` uses a 15-minute default threshold and is advisory: not every Cookie is an authentication Cookie. If an authenticated request returns `LOGIN_REQUIRED` or `PROXY_INTERCEPTED`, run `ensure_session` and retry once after login; do not add an unconditional retry loop.

## Reuse Session For Page Automation

After `sessionReady: true`, use the same profile for page actions. The script supports normalized text clicks:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --url=https://lexiao.oa.fenqile.com/#/app-publish/51303 \
  --click-text=分支集成 \
  --click-button=批量集成分支
```

The script will not force-click disabled buttons. It recollects the page state after an action. If a button is disabled, inspect the returned `clickText`, `clickButton`, `buttons`, and `snippet` fields to explain the current page state.

## Cookies And Sensitive Values

Use cookies or browser storage only when the user explicitly asks for session details or a downstream tool genuinely requires them:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --cookies \
  --domain=lexiao.oa.fenqile.com \
  --url=https://lexiao.oa.fenqile.com/#/app-publish/51303
```

Cookie and storage values are redacted by default. Cookie filtering uses hostname suffix boundaries; do not pass broad public suffixes such as `com`. Use `--show-secrets` only when absolutely necessary for a local command. Do not paste full session tokens in the final response unless the user explicitly requested the raw value and the security implications are clear.

For applications that store auth in localStorage rather than cookies, read only the needed key:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --storage \
  --storage-type=local \
  --storage-key=token \
  --url=https://lxcloud.oa.fenqile.com/ \
  --success-text=none
```

Use `--show-secrets` only for a downstream local process that consumes the value in memory, such as `query-mysql-data`; never write the value to a file or final answer.

## 登录态排查顺序

遇到 `LOGIN_REQUIRED` 时按序确认，**三步都失败才认定登录过期**：

1. **profile 路径是否解析正确**：脚本已统一展开 `~`，但仍建议传绝对路径。若报
   `PROFILE_NOT_FOUND`，那是路径问题而非登录问题，错误信息里会列出当前可用的 profile。
2. **换一个 profile 试**：不同站点的登录态分布在不同 profile，常见的是
   `~/.cache/lexiao-browser-profile`（乐效、Hippo、lxcloud、WebShell）和
   `/home/joney/.cache/healthy-dashboard-profile`（Healthy）。用
   `browser_session.js --check --profile=<abs> --url=<目标站点>` 逐个确认，
   `sessionState=READY` 即可用。
3. **确认目标 host**：返回 `passport.lexincloud.com` 或 `trust.oa.fenqile.com`
   才是真的需要重新登录。

不要在第 1 步失败后就去拉起 headed 浏览器重新登录——历史上多次"登录不上"实际都是
路径未展开或选错 profile。
