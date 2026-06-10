"""SSH 连接管理器 - 堡垒机连接、保活、通道复用、命令执行"""

import re
import socket
import threading
import time
import logging

import shlex

import paramiko

logger = logging.getLogger(__name__)

# 允许执行的命令白名单
ALLOWED_COMMANDS = {
    "cd", "grep", "ls", "ll", "cat", "head", "tail",
    "find", "echo", "pwd", "whoami", "hostname", "zcat", "awk",
    "sort", "wc", "uniq", "egrep"
}

# shell 认证相关关键词
_PASSWORD_KEYWORDS = ("密码", "password", "Password")
_OTP_KEYWORDS = ("安全码", "验证码", "otp", "OTP", "code")
_AUTH_FAIL_KEYWORDS = ("验证失败", "认证失败", "失败", "invalid", "Invalid", "incorrect")
# 输入提示符：确认 shell 确实在等待用户输入，而非普通输出中碰巧包含关键词
_INPUT_PROMPT_INDICATORS = ("请输入", "enter", "Enter", "input", "Input")


def _is_auth_prompt(text: str, keywords: tuple[str, ...]) -> bool:
    """判断 text 是否为认证输入提示。
    同时满足：1) 包含认证关键词  2) 看起来在等待用户输入（包含提示语或以冒号结尾）"""
    if not any(k in text for k in keywords):
        return False
    # 检查是否有输入提示指示符
    if any(ind in text for ind in _INPUT_PROMPT_INDICATORS):
        return True
    # 检查是否以冒号结尾（中英文冒号），常见的输入等待标志
    stripped = text.rstrip()
    if stripped and stripped[-1] in (":", "："):
        return True
    return False


def _split_outside_quotes(text: str, separators: list[str]) -> list[str]:
    """在引号外按 separators 拆分字符串。
    单引号和双引号内的内容不会被拆分。"""
    parts = []
    current = []
    i = 0
    n = len(text)
    in_single = False
    in_double = False

    while i < n:
        ch = text[i]
        # 引号状态切换
        if ch == "'" and not in_double:
            in_single = not in_single
            current.append(ch)
            i += 1
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            current.append(ch)
            i += 1
            continue

        # 在引号内，直接追加
        if in_single or in_double:
            current.append(ch)
            i += 1
            continue

        # 在引号外，检查是否匹配分隔符
        matched = False
        for sep in separators:
            if text[i:i + len(sep)] == sep:
                parts.append("".join(current))
                current = []
                i += len(sep)
                matched = True
                break
        if not matched:
            current.append(ch)
            i += 1

    parts.append("".join(current))
    return [p.strip() for p in parts if p.strip()]


def validate_command(command: str) -> str | None:
    """校验命令是否在白名单内。
    支持 && 连接多条命令，支持管道 |。
    正确处理引号内的特殊字符（如 awk 脚本中的 &&、|、;）。
    返回第一个不合法的命令名，全部合法返回 None。"""
    # 按 &&、||、; 拆分子命令（引号感知）
    parts = _split_outside_quotes(command, ["&&", "||", ";"])
    for part in parts:
        # 按管道拆分（引号感知）
        segments = _split_outside_quotes(part, ["|"])
        for seg in segments:
            seg = seg.strip()
            if not seg:
                continue
            # 提取命令名（第一个 token）
            try:
                tokens = shlex.split(seg)
            except ValueError:
                tokens = seg.split()
            if not tokens:
                continue
            cmd_name = tokens[0].split("/")[-1]  # 处理 /usr/bin/grep 等绝对路径
            if cmd_name not in ALLOWED_COMMANDS:
                return cmd_name
    return None

# ===== 工具函数（复用自 bastion_fetch.py） =====


def recv_until_idle(channel, timeout=10, idle=1.5):
    """持续读取 channel 输出，直到 idle 秒内无新数据"""
    buf = b""
    end = time.time() + timeout
    last_recv = time.time()
    while time.time() < end:
        if channel.recv_ready():
            chunk = channel.recv(65535)
            buf += chunk
            last_recv = time.time()
        elif time.time() - last_recv > idle:
            break
        else:
            time.sleep(0.2)
    for enc in ("utf-8", "gbk", "gb2312"):
        try:
            return buf.decode(enc)
        except (UnicodeDecodeError, ValueError):
            continue
    return buf.decode("utf-8", errors="replace")


def strip_ansi(text):
    """去除 ANSI 转义码"""
    return re.sub(r'\x1b\[[0-9;]*m', '', text)


def send_cmd(channel, cmd, timeout=10):
    """发送命令并等待输出"""
    channel.send(cmd + "\n")
    time.sleep(0.5)
    return recv_until_idle(channel, timeout=timeout)


def make_auth_handler(password="", otp=""):
    """创建 keyboard-interactive 认证处理器"""
    def handler(title, instructions, prompt_list):
        responses = []
        for prompt, echo in prompt_list:
            p = prompt.lower().strip()
            if "password" in p:
                responses.append(password)
            elif any(k in p for k in ("otp", "code", "验证", "token", "mfa")):
                responses.append(otp)
            else:
                responses.append("")
        return responses
    return handler


# ===== SSH 连接管理器 =====


class SSHManager:
    """管理到堡垒机的 SSH 连接，支持保活和通道复用"""

    def __init__(self, config: dict):
        self.config = config
        self.transport: paramiko.Transport = None
        self.keepalive_channel: paramiko.Channel = None
        self._keepalive_thread: threading.Thread = None
        self._stop_keepalive = threading.Event()
        self._password: str = ""
        self._otp: str = ""

    def connect(self, password: str = "", otp: str = "",
                keepalive_ip: str = "") -> str:
        """连接堡垒机并启动保活"""
        host = self.config["bastion_host"]
        port = self.config["bastion_port"]
        username = self.config["username"]
        pem_path = self.config["pem_path"]
        connect_timeout = self.config.get("connect_timeout", 15)

        logger.info(f"连接 {host}:{port} ...")
        sock = socket.create_connection((host, port), timeout=connect_timeout)
        self.transport = paramiko.Transport(sock)

        # OpenSSH 5.3 不支持 rsa-sha2-256/512，强制使用 ssh-rsa (SHA-1)
        # 同时启用旧版服务器密钥类型
        self.transport.disabled_algorithms = {
            'pubkeys': ['rsa-sha2-256', 'rsa-sha2-512'],
        }

        # 在 start_client 之前设置服务器密钥类型
        sec_opts = self.transport.get_security_options()
        sec_opts.kex = [
            'diffie-hellman-group-exchange-sha256',
            'diffie-hellman-group-exchange-sha1',
            'diffie-hellman-group14-sha1',
            'diffie-hellman-group1-sha1',
        ]
        sec_opts.key_types = ['ssh-rsa', 'ssh-dss']
        sec_opts.ciphers = [
            'aes256-ctr', 'aes192-ctr', 'aes128-ctr',
            'aes256-cbc', 'aes192-cbc', 'aes128-cbc',
            '3des-cbc',
        ]

        self.transport.start_client()

        # 优先尝试密钥认证
        authed = False
        for key_cls in (paramiko.RSAKey, paramiko.Ed25519Key):
            try:
                key = key_cls.from_private_key_file(pem_path)
                self.transport.auth_publickey(username, key)
                authed = True
                logger.info(f"{key_cls.__name__} 密钥认证成功")
                break
            except Exception:
                continue

        if not authed:
            if not password:
                return "错误：密钥认证失败且未提供密码，请传入 password 和 otp"
            logger.info("密钥认证失败，使用密码+验证码认证...")
            self.transport.auth_interactive(
                username, make_auth_handler(password=password, otp=otp)
            )
            logger.info("认证成功")

        if not self.transport.is_authenticated():
            return "错误：认证失败"

        # 保存密码和安全码，供 shell 二次认证使用
        self._password = password
        self._otp = otp

        # 启动保活（检查 shell 认证是否成功）
        kip = keepalive_ip or self.config.get("keepalive_ip", "10.11.86.153")
        err = self._start_keepalive(kip)
        if err:
            return err

        # 验证连接：真正进入目标机器并执行 whoami
        verify_error, whoami_result = self._verify_connection(kip)
        if verify_error:
            return verify_error

        return f"已连接堡垒机 {host}:{port}，保活目标 {kip}，验证成功(whoami={whoami_result})"

    def is_connected(self) -> bool:
        return self.transport is not None and self.transport.is_active()

    def _handle_shell_auth(self, ch, initial_output: str) -> tuple[bool, str]:
        """处理堡垒机 shell 的二次认证（密码 + 可选安全码）。

        仅当输出明确是认证输入提示时才发送凭据（关键词 + 提示符双重校验），
        避免在保活缓存生效、无需认证时误触发。

        Returns:
            (True, output)  — 认证成功或无需认证
            (False, error)  — 认证失败，error 包含原因描述
        """
        clean = strip_ansi(initial_output)

        # 第一步：检测密码提示
        if _is_auth_prompt(clean, _PASSWORD_KEYWORDS):
            if not self._password:
                return False, "错误：堡垒机 shell 要求输入密码，但未提供 password 参数"
            logger.info("检测到 shell 二次密码认证，自动输入密码")
            out = send_cmd(ch, self._password, timeout=10)
            clean = strip_ansi(out)
            # 检测密码是否被拒绝
            if any(k in clean for k in _AUTH_FAIL_KEYWORDS) and _is_auth_prompt(clean, _PASSWORD_KEYWORDS):
                return False, "错误：shell 密码认证失败，请检查密码是否正确"

        # 第二步：检测安全码提示
        if _is_auth_prompt(clean, _OTP_KEYWORDS):
            if not self._otp:
                return False, "错误：堡垒机 shell 要求输入安全码（OTP），请提供 otp 参数"
            logger.info("检测到安全码提示，自动输入安全码")
            out = send_cmd(ch, self._otp, timeout=10)
            clean = strip_ansi(out)
            # 检测安全码是否被拒绝
            if any(k in clean for k in _AUTH_FAIL_KEYWORDS):
                return False, "错误：安全码验证失败（可能已过期），请提供新的 otp 重新连接"

        return True, clean

    def _start_keepalive(self, keepalive_ip: str) -> str | None:
        """三重保活。返回 None 表示成功，返回错误字符串表示失败。"""
        interval = self.config.get("keepalive_interval", 30)
        idle_interval = self.config.get("idle_cmd_interval", 60)
        shell_timeout = self.config.get("shell_timeout", 10)

        # 1. SSH 协议层心跳
        self.transport.set_keepalive(interval)

        # 2. 开专用 shell channel → 认证 → go keepalive_ip → TMOUT + tail
        ch = self.transport.open_session()
        ch.get_pty(term="xterm", width=200, height=50)
        ch.invoke_shell()
        initial = recv_until_idle(ch, timeout=shell_timeout)

        ok, msg = self._handle_shell_auth(ch, initial)
        if not ok:
            ch.close()
            return msg

        send_cmd(ch, f"go {keepalive_ip}", timeout=15)
        send_cmd(ch, "export TMOUT=86400", timeout=5)
        send_cmd(ch, "tail -f /dev/null &", timeout=5)
        self.keepalive_channel = ch
        logger.info(f"保活 channel 已建立，目标 {keepalive_ip}")

        # 3. 后台线程定期发送空行
        self._stop_keepalive.clear()

        def _keepalive_loop():
            while not self._stop_keepalive.wait(idle_interval):
                try:
                    if self.keepalive_channel and not self.keepalive_channel.closed:
                        self.keepalive_channel.send("\n")
                except Exception as e:
                    logger.warning(f"保活发送失败: {e}")
                    break

        self._keepalive_thread = threading.Thread(
            target=_keepalive_loop, daemon=True
        )
        self._keepalive_thread.start()
        return None

    def _verify_connection(self, ip: str) -> tuple[str | None, str]:
        """验证连接：真正进入目标机器并执行 whoami，确认连接成功

        Returns:
            (error, whoami_result): (错误信息, whoami结果)。错误为None表示成功
        """
        shell_timeout = self.config.get("shell_timeout", 10)
        ch = None
        whoami_result = ""
        try:
            ch = self.transport.open_session()
            ch.get_pty(term="xterm", width=200, height=50)
            ch.invoke_shell()
            initial = recv_until_idle(ch, timeout=shell_timeout)

            ok, msg = self._handle_shell_auth(ch, initial)
            if not ok:
                return msg, ""

            # 跳转到目标机器
            jump_out = send_cmd(ch, f"go {ip}", timeout=15)
            jump_clean = strip_ansi(jump_out)
            if any(k in jump_clean for k in (">>>", "权限", "没有")):
                return f"跳转失败: {jump_clean.strip()}", ""

            # 执行 whoami 验证连接成功
            whoami_out = send_cmd(ch, "whoami", timeout=10)
            whoami_clean = strip_ansi(whoami_out)

            # 提取 whoami 结果（去掉命令回显和提示符）
            lines = whoami_clean.strip().split("\n")
            # 去掉第一行（命令回显 whoami）和可能的空行
            result_lines = [l for l in lines if l.strip() and l.strip() != "whoami"]
            whoami_result = result_lines[0].strip() if result_lines else ""

            if whoami_result:
                logger.info(f"连接验证成功: whoami = {whoami_result}")
                return None, whoami_result  # 验证成功
            else:
                return "错误：连接验证失败，无法获取用户信息", ""

        except Exception as e:
            return f"错误：连接验证失败: {e}", ""
        finally:
            if ch:
                try:
                    ch.close()
                except Exception:
                    pass

    def execute_on_target(self, ip: str, command: str,
                          timeout: int = 30) -> str:
        """在目标机器上执行命令"""
        if not self.is_connected():
            return "错误：未连接堡垒机"

        # 命令白名单校验
        rejected = validate_command(command)
        if rejected:
            return f"命令被拒绝：'{rejected}' 不在允许列表中。允许的命令: {', '.join(sorted(ALLOWED_COMMANDS))}"

        shell_timeout = self.config.get("shell_timeout", 10)
        ch = None
        try:
            ch = self.transport.open_session()
            ch.get_pty(term="xterm", width=200, height=50)
            ch.invoke_shell()
            initial = recv_until_idle(ch, timeout=shell_timeout)

            ok, msg = self._handle_shell_auth(ch, initial)
            if not ok:
                return msg

            # 跳转到目标机器
            jump_out = send_cmd(ch, f"go {ip}", timeout=15)
            jump_clean = strip_ansi(jump_out)
            if any(k in jump_clean for k in (">>>", "权限", "没有")):
                return f"跳转失败: {jump_clean.strip()}"

            # 用 marker 方式执行命令
            marker_start = "===MCP_START==="
            marker_end = "===MCP_END==="
            cmd = f"echo {marker_start} && {command} && echo {marker_end}"
            raw = send_cmd(ch, cmd, timeout=timeout)
            clean = strip_ansi(raw)

            # 提取 marker 之间的输出
            last_start = clean.rfind(marker_start)
            last_end = clean.rfind(marker_end)
            if last_start >= 0 and last_end > last_start:
                content = clean[last_start + len(marker_start):last_end]
                return content.strip("\r\n")
            else:
                # fallback: 去掉首行（命令回显）和末行（prompt）
                lines = clean.split("\n")
                return "\n".join(lines[1:-1]).strip() if len(lines) > 2 else clean.strip()
        except Exception as e:
            return f"执行失败: {e}"
        finally:
            if ch:
                try:
                    ch.close()
                except Exception:
                    pass

    def disconnect(self):
        """断开连接，停止保活"""
        self._stop_keepalive.set()
        if self.keepalive_channel:
            try:
                self.keepalive_channel.close()
            except Exception:
                pass
            self.keepalive_channel = None
        if self.transport:
            try:
                self.transport.close()
            except Exception:
                pass
            self.transport = None
        logger.info("已断开堡垒机连接")
