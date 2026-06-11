"""堡垒机 MCP Server - 通过堡垒机在目标机器上执行命令"""

import asyncio
import json
import logging
import os
import re
import sys

from mcp.server.fastmcp import FastMCP

try:
    from bastion_mcp.ssh_manager import SSHManager
except ModuleNotFoundError:
    sys.path.insert(0, os.path.dirname(__file__))
    from ssh_manager import SSHManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

mcp = FastMCP("Bastion Host")
ssh_mgr: SSHManager = None


def _load_config() -> dict:
    config_path = os.environ.get(
        "BASTION_CONFIG",
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "config.json"),
    )
    with open(config_path, encoding="utf-8") as f:
        return json.load(f)


@mcp.tool()
async def connect_bastion(
    password: str = "", otp: str = "", keepalive_ip: str = ""
) -> str:
    """连接堡垒机。如果需要密码和动态验证码，请提供对应参数。
    PEM 认证足够时可不传。
    keepalive_ip: 保活用的目标机器 IP，默认使用配置文件中的值"""
    global ssh_mgr
    config = _load_config()
    ssh_mgr = SSHManager(config)
    # 密码优先级：工具参数 > 环境变量 BASTION_PASSWORD > config.json
    final_password = password or os.environ.get("BASTION_PASSWORD", "") or config.get("password", "")
    return await asyncio.to_thread(
        ssh_mgr.connect,
        password=final_password,
        otp=otp,
        keepalive_ip=keepalive_ip or config.get("keepalive_ip", "10.11.86.153"),
    )


# 默认只读护栏：拦截明显的写/破坏类命令与重定向写入。
# 确需放开时设置环境变量 BASTION_ALLOW_WRITE=1（自担风险）。
_WRITE_COMMAND = re.compile(
    r"(^|[;&|]\s*)("
    r"rm|mv|cp|dd|mkfs|chmod|chown|chgrp|touch|tee|truncate|shred|"
    r"kill|pkill|killall|reboot|shutdown|halt|poweroff|systemctl|service|"
    r"crontab|useradd|userdel|usermod|passwd|mount|umount|"
    r"yum|apt|apt-get|dnf|rpm|pip|npm"
    r")\b"
)
_WRITE_REDIRECT = re.compile(r"(?<![<>])>{1,2}(?!&\d)")


def _is_write_command(command: str) -> bool:
    return bool(_WRITE_COMMAND.search(command) or _WRITE_REDIRECT.search(command))


@mcp.tool()
async def execute_command(ip: str, command: str, timeout: int = 30) -> str:
    """在目标机器上执行只读命令。
    ip: 目标机器 IP（通过堡垒机 go 命令跳转）
    command: 要执行的命令（默认只读护栏：写/破坏类命令与重定向写入会被拒绝）
    timeout: 命令超时秒数"""
    if not ssh_mgr or not ssh_mgr.is_connected():
        return "错误：未连接堡垒机，请先调用 connect_bastion"
    if os.environ.get("BASTION_ALLOW_WRITE") != "1" and _is_write_command(command):
        return (
            "错误：命令被只读护栏拦截（包含写/破坏类命令或重定向写入）。"
            "如确需执行，请在 MCP 注册中设置 BASTION_ALLOW_WRITE=1 后重启。"
        )
    return await asyncio.to_thread(ssh_mgr.execute_on_target, ip, command, timeout)


@mcp.tool()
async def connection_status() -> str:
    """查看堡垒机连接状态"""
    if not ssh_mgr:
        return "未初始化"
    return "已连接" if ssh_mgr.is_connected() else "已断开"


@mcp.tool()
async def disconnect_bastion() -> str:
    """断开堡垒机连接"""
    if ssh_mgr:
        ssh_mgr.disconnect()
        return "已断开"
    return "未连接"


def main():
    transport = "stdio"
    port = 8000
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] in ("--transport", "-t") and i + 1 < len(args):
            transport = args[i + 1]
            i += 2
        elif args[i] in ("--port", "-p") and i + 1 < len(args):
            port = int(args[i + 1])
            i += 2
        else:
            i += 1

    if transport == "stdio":
        mcp.run(transport="stdio")
    else:
        # 堡垒机通道仅限本机访问；确需外部访问时通过 BASTION_HTTP_HOST 显式放开
        mcp.settings.host = os.environ.get("BASTION_HTTP_HOST", "127.0.0.1")
        mcp.settings.port = port
        mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
