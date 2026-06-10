#!/usr/bin/env python3
"""
从 Chrome DevTools Protocol 获取指定域名的 Cookie（通过 PowerShell）。
用法: python3 get_chrome_cookie.py <domain>
示例: python3 get_chrome_cookie.py bianque.lexinfintech.com
"""

import json
import sys
import subprocess


def run_powershell(script):
    """通过 PowerShell 执行脚本并返回输出。"""
    result = subprocess.run(
        ['powershell.exe', '-Command', script],
        capture_output=True, text=True, timeout=30, encoding='utf-8', errors='replace'
    )
    if result.returncode != 0:
        print(f"PowerShell 错误: {result.stderr}")
        return None
    return result.stdout


def get_chrome_cookies(domain):
    """通过 Chrome DevTools Protocol 获取指定域名的 Cookie。"""

    # 1. 获取 Chrome targets
    ps_script = """
try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/list' -TimeoutSec 5 -ErrorAction Stop
    Write-Host ($resp | ConvertTo-Json -Depth 10 -Compress)
} catch {
    Write-Host "ERROR: " + $_.Exception.Message
}
"""
    output = run_powershell(ps_script)
    if not output or output.startswith("ERROR"):
        print("错误: 无法连接到 Chrome (127.0.0.1:9222)，请确保 Chrome 已启动远程调试")
        return None

    try:
        targets = json.loads(output.strip().split('\n')[-1])
    except json.JSONDecodeError:
        print("错误: 无法解析 Chrome targets")
        return None

    # 2. 找到匹配的页面
    for target in targets:
        url = target.get('url', '')
        if domain in url:
            target_id = target.get('id')
            print(f"找到页面: {url}")

            # 3. 通过 WebSocket 获取 Cookie，只输出 JSON
            ws_script = f"""
try {{
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ws.ConnectAsync([System.Uri]'ws://127.0.0.1:9222/devtools/page/{target_id}', [System.Threading.CancellationToken]::None).Wait(5000)
    if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {{
        $cmd = '{{"id":1,"method":"Network.getAllCookies"}}'
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($cmd)
        $ws.SendAsync([System.ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait(5000)

        $buffer = New-Object byte[] 65536
        $result = $ws.ReceiveAsync([System.ArraySegment[byte]]::new($buffer), [System.Threading.CancellationToken]::None).Result
        $response = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
        Write-Host $response

        $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'Done', [System.Threading.CancellationToken]::None).Wait(3000)
    }} else {{
        Write-Host "ERROR: WebSocket not connected"
    }}
}} catch {{
    Write-Host "ERROR: " + $_.Exception.Message
}}
"""
            output = run_powershell(ws_script)
            if not output or output.startswith("ERROR"):
                print("错误: 无法获取 Cookie")
                return None

            # 提取 JSON 响应（找到包含 {"id":1 的那一行）
            json_lines = []
            for line in output.strip().split('\n'):
                line = line.strip()
                if line.startswith('{"id":1'):
                    json_lines.append(line)

            if not json_lines:
                print("错误: 无法找到 JSON 响应")
                return None

            try:
                data = json.loads(json_lines[0])
                cookies = data.get('result', {}).get('cookies', [])

                # 过滤指定域名的 Cookie
                filtered = [c for c in cookies if domain in c.get('domain', '')]
                if filtered:
                    cookie_str = '; '.join([f"{c['name']}={c['value']}" for c in filtered])
                    return cookie_str
                else:
                    print(f"未找到 {domain} 的 Cookie，请确认已在 bianque 页面登录")
                    return None
            except json.JSONDecodeError as e:
                print(f"解析响应失败: {e}")
                return None

    print(f"未找到包含 {domain} 的页面，请确认已在 Chrome 中打开该页面")
    return None


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("用法: python3 get_chrome_cookie.py <domain>")
        print("示例: python3 get_chrome_cookie.py bianque.lexinfintech.com")
        sys.exit(1)

    domain = sys.argv[1]
    cookies = get_chrome_cookies(domain)
    if cookies:
        print(f"\nCookie: {cookies}")
    else:
        sys.exit(1)