---
name: get-browser-session
description: 获取、检查和复用 WSL Playwright/Chromium 浏览器登录态与网页 session。Use when Codex needs to access an internal web page that requires login, verify whether an existing browser profile is authenticated, open a browser for the user to complete SSO/OTP/login, reuse the saved profile for automation, or inspect session cookies with redaction by default.
version: 1.0.0
---

# Get Browser Session

## Workflow

Prefer the bundled script over rewriting browser setup code:

```bash
node /home/joney/projects/ai/claude-code-skills/java-backend/skills/get-browser-session/scripts/browser_session.js --status --url=<url>
```

Use the existing WSL browser tool at `~/tools/lexiao-browser` by default. Override with `--tool-dir`, `--chrome`, `--runtime-lib-dir`, or `--profile` only when the local setup differs.

When another skill needs a logged-in browser session, use this skill as the session layer. The calling skill should pass only the target `url`, the intended `profile`, and an optional `success-text`; do not duplicate login instructions in the calling skill.

## Check Existing Session

Run a headless status check first:

```bash
node /home/joney/projects/ai/claude-code-skills/java-backend/skills/get-browser-session/scripts/browser_session.js \
  --url=https://lexiao.oa.fenqile.com/#/app-publish/51303 \
  --success-text=当前环境
```

Treat `sessionReady: true` as a usable login state. If `hasLoginText: true`, `sessionReady: false`, or the snippet clearly shows a login/SSO page, the profile is missing or expired.

For non-Lexiao pages, always pass a page-specific `--url` and `--profile`. If there is no stable success marker on the target page, use `--success-text=none` and rely on `login-pattern`; if there is a stable marker, pass it explicitly.

For environment diagnostics:

```bash
node /home/joney/projects/ai/claude-code-skills/java-backend/skills/get-browser-session/scripts/browser_session.js --doctor
```

## Obtain Or Refresh Session

If the session is missing, open the headed browser and let the user complete login in the browser window:

```bash
node /home/joney/projects/ai/claude-code-skills/java-backend/skills/get-browser-session/scripts/browser_session.js \
  --ensure \
  --url=https://lexiao.oa.fenqile.com/#/app-publish/51303 \
  --success-text=当前环境
```

Do not ask the user for passwords, OTP codes, private keys, or cookies in chat. Ask only for the user to finish login in the opened browser window. After the script exits, rerun the headless status check before continuing automation.

The default profile is:

```bash
~/.cache/lexiao-browser-profile
```

If Chrome reports the profile is already in use, ask the user to close the WSL Chromium window or rerun with a different `--profile`.

## Reuse Session For Page Automation

After `sessionReady: true`, use the same profile for page actions. The script supports normalized text clicks:

```bash
node /home/joney/projects/ai/claude-code-skills/java-backend/skills/get-browser-session/scripts/browser_session.js \
  --url=https://lexiao.oa.fenqile.com/#/app-publish/51303 \
  --click-text=分支集成 \
  --click-button=批量集成分支
```

The script will not force-click disabled buttons. If a button is disabled, inspect the returned `clickText`, `clickButton`, `buttons`, and `snippet` fields to explain the current page state.

## Cookies And Sensitive Values

Use cookies only when the user explicitly asks for cookie/session details or a downstream tool genuinely requires them:

```bash
node /home/joney/projects/ai/claude-code-skills/java-backend/skills/get-browser-session/scripts/browser_session.js \
  --cookies \
  --domain=lexiao.oa.fenqile.com \
  --url=https://lexiao.oa.fenqile.com/#/app-publish/51303
```

Cookie values are redacted by default. Use `--show-secrets` only when absolutely necessary for a local command. Do not paste full session tokens in the final response unless the user explicitly requested the raw value and the security implications are clear.
