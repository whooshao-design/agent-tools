# Bastion MCP Server

通过堡垒机（JumpServer）在目标机器上远程执行命令的 MCP Server。

## 功能

- SSH 连接堡垒机，支持 PEM 密钥认证和密码 + 动态验证码认证
- 三层保活机制，防止空闲断连
- 通道复用，每次命令执行复用已有 SSH 连接，无需重新认证
- 命令白名单，仅允许安全的只读命令
- 支持 stdio 和 HTTP 两种 MCP transport

## 安装

```bash
pip install mcp paramiko
```

## 配置

复制 `config.json.example` 为 `config.json`，并填写您的认证信息：

```bash
cp config.json.example config.json
```

```json
{
  "bastion_host": "ssh.jumpserver.fenqile.cn",
  "bastion_port": 39000,
  "username": "your_username",
  "password": "",
  "pem_path": "D:\\your_key.pem",
  "keepalive_ip": "10.xx.xx.xx",
  "keepalive_interval": 30,
  "idle_cmd_interval": 60,
  "shell_timeout": 10,
  "connect_timeout": 15
}
```

| 字段 | 说明 |
|------|------|
| `bastion_host` | 堡垒机地址 |
| `bastion_port` | 堡垒机端口 |
| `username` | 登录用户名 |
| `password` | 密码（PEM 认证足够时可留空） |
| `pem_path` | PEM 私钥文件路径 |
| `keepalive_ip` | 保活用的目标机器 IP |
| `keepalive_interval` | SSH 心跳间隔（秒） |
| `idle_cmd_interval` | 保活空命令发送间隔（秒） |
| `shell_timeout` | Shell 输出等待超时（秒） |
| `connect_timeout` | TCP 连接超时（秒） |

## 启动

```bash
# stdio 模式（Claude Code 集成）
python -m bastion_mcp.server

# HTTP 模式（调试 / MCP Inspector）
python -m bastion_mcp.server --transport http --port 8000
```

## Claude Code 集成

在 Claude Code 的 MCP 配置中添加（修改路径为您的实际路径）：

```json
{
  "mcpServers": {
    "bastion": {
      "command": "cmd",
      "args": [
        "/c python C:\\path\\to\\bastion-mcp\\bastion_mcp\\server.py"
      ],
      "env": {
        "BASTION_CONFIG": "C:\\path\\to\\bastion-mcp\\config.json"
      },
      "type": "stdio"
    }
  }
}
```

> **注意**：请将 `C:\\path\\to\\bastion-mcp` 替换为您的实际安装路径。

## MCP 工具

### `connect_bastion`

连接堡垒机并启动保活。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `password` | string | 否 | 密码（PEM 认证足够时不传） |
| `otp` | string | 否 | 6 位动态验证码 |
| `keepalive_ip` | string | 否 | 保活目标机器 IP，默认使用配置值 |

### `execute_command`

在目标机器上执行命令。通过堡垒机 `go {ip}` 跳转后执行。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ip` | string | 是 | 目标机器 IP |
| `command` | string | 是 | 要执行的命令 |
| `timeout` | int | 否 | 超时秒数，默认 30 |

### `connection_status`

查看堡垒机连接状态。无参数。

### `disconnect_bastion`

断开堡垒机连接。无参数。

## 命令白名单

仅允许以下命令，支持 `&&` 和 `|` 组合：

```
awk  cat  cd  echo  find  grep  head  hostname  ll  ls  pwd  tail  whoami  zcat
```

其他命令（如 `rm`、`curl`、`python` 等）会被拒绝。

## 保活机制

连接建立后自动启用三层保活：

| 层级 | 方式 | 说明 |
|------|------|------|
| SSH 协议层 | `set_keepalive(30)` | 每 30 秒发送 SSH 心跳包 |
| Shell 层 | `TMOUT=86400` + `tail -f /dev/null` | 防止 shell 空闲超时 |
| Shell 层 | 定期发送 `\n` | 每 60 秒模拟用户活动 |

保活使用独立的 shell channel，不影响命令执行。

## 认证流程

```
PEM 密钥认证 ──成功──→ 进入堡垒机
      │
      失败
      │
      ↓
密码 + 动态验证码（keyboard-interactive）──→ 进入堡垒机
```

堡垒机服务端决定是否需要密码和验证码。PEM 认证足够时无需额外输入。

## 环境变量

| 变量 | 说明 |
|------|------|
| `BASTION_CONFIG` | 配置文件路径，默认 `config.json` 同目录下 |
| `BASTION_PASSWORD` | 堡垒机密码（优先级高于 config.json） |

## 日志级别

默认 `INFO`，可通过 Python 标准日志配置覆盖：

```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

## 常见问题

**Q: 认证失败怎么办？**
- 确认 PEM 密钥路径正确（Windows 用反斜杠）
- 动态验证码有效期 30 秒，请在连接时及时提供

**Q: 命令执行超时？**
- 默认超时 30 秒，可通过 `timeout` 参数调大
- 检查目标机器网络连通性

**Q: 空闲断开？**
- 检查 `keepalive_interval` 和 `idle_cmd_interval` 配置
- 确认堡垒机自身超时策略
