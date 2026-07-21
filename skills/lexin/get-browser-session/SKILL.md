---
name: get-browser-session
description: 获取、检查和复用 WSL Playwright/Chromium 浏览器登录态与网页 session（底层会话层，供其他 skill 复用）。Use when 需要访问要求登录的内网页面、检查浏览器 profile 登录态是否有效、打开浏览器让用户完成 SSO/OTP 登录、复用已保存 profile 做页面自动化，或按默认脱敏方式查看 session Cookie/localStorage token。
metadata:
  version: 1.2.0
---

# Get Browser Session

## Workflow

Prefer the bundled script over rewriting browser setup code:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js --status --url=<url>
```

Use the existing WSL browser tool at `~/tools/lexiao-browser` by default. Override with `--tool-dir`, `--chrome`, `--runtime-lib-dir`, or `--profile` only when the local setup differs.

When another skill needs a logged-in browser session, use this skill as the session layer. The calling skill should pass only the target `url`, the intended `profile`, and an optional `success-text`; do not duplicate login instructions in the calling skill.

MCP 优先：能用 `browser_session` MCP 时，优先使用 `check_session` / `browser_page_snapshot` / `browser_click_text` / `browser_click_button` / `get_cookies` / `fetch_with_session`；脚本作为兜底入口。

## Check Existing Session

Run a headless status check first:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --url=https://lexiao.oa.fenqile.com/#/app-publish/51303 \
  --success-text=当前环境
```

Treat `sessionReady: true` as a usable login state. Also inspect `sessionState`: `LOGIN_REQUIRED` means the profile is missing or expired, `PROXY_INTERCEPTED` means the child browser reached ATrust/乐空间 instead of the target, and `FORBIDDEN` means the current user lacks access.

For non-Lexiao pages, always pass a page-specific `--url` and `--profile`. If there is no stable success marker on the target page, use `--success-text=none` and rely on the default login detection, which covers Chinese login words, the English OA page markers `Work Happy`, `QR Code`, `Use MOA` / `MOA`, `Account Login`, `Password Login`, and `Sign in`, plus password input fields; if there is a stable marker, pass it explicitly.

For environment diagnostics:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js --doctor
```

## WebShell / Gotty Pages

For WebShell pages such as `https://webshell.oa.fenqile.com/?arg=...`, use this skill only to confirm the browser session and login state:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --status \
  --profile=/tmp/healthy-dashboard-profile \
  --url=<login_pod_addr> \
  --success-text=none
```

WebShell uses stricter readiness semantics than a generic OA page:

- The default profile is `~/.codex/webshell-direct-profile` unless `--profile` is explicit.
- The Chromium child process clears proxy variables only for approved internal hosts and adds `--no-proxy-server`; global proxy settings are untouched.
- `READY` requires the browser to stay on `webshell.oa.fenqile.com` and expose an xterm/terminal DOM for three consecutive polls.
- `乐空间传送门`、`ATrust`、登录页和 403 markers override transient Gotty titles and terminal elements.
- `snippet` may be empty because xterm uses canvas; use `sessionState/terminalReady/stableReadyPolls` instead of body text alone.

Do not use this skill to execute server commands or read logs; container log reads belong to `java-server-diagnostics`, using `/home/joney/projects/ai/agent-tools/skills/lexin/java-server-diagnostics/scripts/webshell_log_check.js` when a Gotty WebSocket or terminal interaction is needed.

## Obtain Or Refresh Session

If the session is missing, use `--ensure`. It first checks the target URL headlessly and returns immediately when the saved session is already usable. If login is required, it opens a headed browser and lets the user complete login in the browser window. In WSL, the script auto-fills WSLg display variables when the Codex process did not inherit `DISPLAY`.

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --ensure \
  --url=https://lexiao.oa.fenqile.com/#/app-publish/51303 \
  --success-text=当前环境
```

If a headed browser still cannot be opened, `--ensure` returns JSON with `ensureStrategy: "headless-screenshot"` and `loginScreenshot`, instead of failing with raw Chromium/XServer errors. Scan that screenshot, then rerun the status check or `--ensure`.

Do not ask the user for passwords, OTP codes, private keys, or cookies in chat. Ask only for the user to finish login in the opened browser window. After the script exits, rerun the headless status check before continuing automation.

The default profile is:

```bash
~/.cache/lexiao-browser-profile
```

WebShell defaults to the isolated profile `~/.codex/webshell-direct-profile`. To refresh it, run `--ensure --url=<login_pod_addr> --success-text=none` and complete SSO in the opened browser. Do not reuse a profile that is concurrently open in another Chromium process.

If Chrome reports the profile is already in use, ask the user to close the WSL Chromium window or rerun with a different `--profile`.

## Reuse Session For Page Automation

After `sessionReady: true`, use the same profile for page actions. The script supports normalized text clicks:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --url=https://lexiao.oa.fenqile.com/#/app-publish/51303 \
  --click-text=分支集成 \
  --click-button=批量集成分支
```

The script will not force-click disabled buttons. If a button is disabled, inspect the returned `clickText`, `clickButton`, `buttons`, and `snippet` fields to explain the current page state.

## Cookies And Sensitive Values

Use cookies or browser storage only when the user explicitly asks for session details or a downstream tool genuinely requires them:

```bash
node /home/joney/projects/ai/agent-tools/skills/lexin/get-browser-session/scripts/browser_session.js \
  --cookies \
  --domain=lexiao.oa.fenqile.com \
  --url=https://lexiao.oa.fenqile.com/#/app-publish/51303
```

Cookie and storage values are redacted by default. Use `--show-secrets` only when absolutely necessary for a local command. Do not paste full session tokens in the final response unless the user explicitly requested the raw value and the security implications are clear.

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
