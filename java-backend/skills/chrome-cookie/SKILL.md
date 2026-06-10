---
name: chrome-cookie
description: 通过 Playwright + 持久化 Chromium 自动获取浏览器 Cookie。适用于 bianque、Jenkins 等需要复用浏览器登录态的内部系统；支持状态检查、环境诊断、自动确保和敏感信息脱敏。
version: 1.0.0
---

# Chrome Cookie 获取

## 用途

提供一个独立的 Python 脚本，通过 Playwright 启动持久化 Chromium profile，从已登录的浏览器会话中自动获取指定域名的 Cookie。

**典型使用场景**：
- `test-dubbo-api` skill：获取 bianque Cookie 用于调用 Dubbo 接口
- `jenkins-pipeline-fix` skill：获取 Jenkins Cookie 用于流水线排查
- 任何需要从浏览器自动获取 Cookie 的 skill

## 前置条件

1. **lexiao-browser 已安装**：默认使用 `~/tools/lexiao-browser/browsers/chrome-linux64/chrome`
2. **已在该 Chromium profile 中登录过目标网站**：profile 位于 `~/.cache/lexiao-browser-profile`，登录态会保留
3. **Python 3 可用**：脚本在 WSL2 或 Linux 环境中运行

> **注意**：不需要手动启动浏览器或打开网页，脚本会自动完成。

## 命令行用法

### 模式 1：状态检查（--status）

检查目标域名的 session 是否可用；输出会脱敏显示已获取到的 Cookie 片段：

```bash
python3 ~/.codex/skills/chrome-cookie/auto_cookie.py --status --domain=bianque.lexinfintech.com
```

**输出**：
```json
{
  "sessionReady": true,
  "cookies": "ltrace_sessionId=9678E83C...440E265; JSESSIONID=50E1C35F...5EE3E16"
}
```

### 模式 2：环境诊断（--doctor）

检查环境是否就绪（Chromium 路径、运行时库、profile、Playwright、浏览器启动）：

```bash
python3 ~/.codex/skills/chrome-cookie/auto_cookie.py --doctor
```

**输出**：
```
Chrome 路径: 存在
运行时库: 存在
Profile 目录: 存在
Playwright: 已安装
浏览器启动: 成功
```

### 模式 3：自动确保（--ensure）

自动确保 session 可用（启动 Chromium → 打开网页 → 获取 Cookie）：

```bash
python3 ~/.codex/skills/chrome-cookie/auto_cookie.py --ensure --domain=bianque.lexinfintech.com --url=https://bianque.lexinfintech.com
```

**流程**：
1. 使用持久化 profile 启动 Chromium
2. 导航到目标 URL
3. 等待页面加载
4. 从 Playwright context 中读取全部 Cookie
5. 过滤目标域名 Cookie 并返回

### 模式 4：快速获取（默认）

等效于 `--ensure`，最常用：

```bash
python3 ~/.codex/skills/chrome-cookie/auto_cookie.py --domain=bianque.lexinfintech.com --url=https://bianque.lexinfintech.com
```

## Python 集成

```python
import sys
sys.path.insert(0, '~/.codex/skills/chrome-cookie')
from auto_cookie import ensure_session

cookies, error = ensure_session("bianque.lexinfintech.com", "https://bianque.lexinfintech.com")
if error:
    print(f"错误: {error}")
else:
    print(cookies)  # ltrace_sessionId=xxx; JSESSIONID=xxx
```

## 敏感信息处理

默认情况下，Cookie 值会**脱敏**显示（只显示前 8 位和最后 4 位）：

```
ltrace_sessionId=9678E83C...440E265; JSESSIONID=50E1C35F...5EE3E16
```

如需显示完整 Cookie，添加 `--show-secrets`：

```bash
python3 ~/.codex/skills/chrome-cookie/auto_cookie.py --domain=bianque.lexinfintech.com --show-secrets
```

## 返回格式

成功时返回 `name=value; name=value` 格式的字符串：
```
ltrace_sessionId=9678E83C437C02711E564B767440E265; JSESSIONID=50E1C35FEEEC1CACEA9B2B7EF5EE3E16
```

失败时返回 `None`，并打印错误信息。

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| "浏览器启动失败" | Chromium 路径、运行时库或 WSL 图形环境异常 | 先执行 `--doctor`，检查 `~/tools/lexiao-browser` 和运行时库 |
| "未获取到 Cookie" | 页面未登录或 Cookie 已过期 | 用 `--ensure` 打开目标网站并完成登录，之后重试 |
| "sessionReady: false" | 页面打开但没有目标域名 Cookie | 确认登录态是否有效，或目标域名参数是否正确 |
| Playwright 未安装 | Python 环境缺少依赖 | 安装 Playwright 后重试，或改用手动 Cookie |

## 原理

1. 通过 `playwright.chromium.launch_persistent_context` 启动持久化 Chromium profile
2. 使用 `~/tools/lexiao-browser/runtime-libs` 配置 `LD_LIBRARY_PATH`
3. 导航到目标 URL 并等待页面加载
4. 调用 Playwright `context.cookies()` 获取 Cookie
5. 过滤出目标域名的 Cookie，拼接为 `name=value` 格式返回

## 备用脚本

`get_chrome_cookie.py` 是旧的 PowerShell + CDP 方式，仅作为手动排障备用。默认优先使用 `auto_cookie.py`。
