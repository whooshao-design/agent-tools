"""SSH 连接管理器 - 堡垒机连接、保活、通道复用、命令执行"""

import base64
import hashlib
import hmac
import os
import re
import socket
import struct
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
    "sort", "wc", "uniq", "egrep", "id", "ps",
    # 二进制文件只读拉取与校验：base64 分块输出，md5sum/sha1sum/stat 核对
    "base64", "md5sum", "sha1sum", "stat", "od",
    # 目标机连通性测试（用户 2026-10-15 明确授权放开）
    "curl"
}
DEFAULT_ALLOWED_SUDO_USERS = {"java_admin"}
SAFE_JSTAT_OPTIONS = {"-gcutil", "-gccause"}
SAFE_JCMD_COMMANDS = {
    "GC.heap_info",
    "Thread.print",
    "VM.command_line",
    "VM.flags",
    "VM.version",
}

# shell 认证相关关键词
_PASSWORD_KEYWORDS = ("密码", "password", "Password")
_OTP_KEYWORDS = ("安全码", "验证码", "otp", "OTP", "code", "MOA")
_AUTH_FAIL_KEYWORDS = ("验证失败", "认证失败", "失败", "invalid", "Invalid", "incorrect")
# 输入提示符：确认 shell 确实在等待用户输入，而非普通输出中碰巧包含关键词
_INPUT_PROMPT_INDICATORS = ("请输入", "enter", "Enter", "input", "Input")
_SUDO_PROMPT = "[sudo-password]:"
# whoami 的合法结果；堡垒机把输入当安全码回显时得到的是一串 *，不能当成用户名
_USERNAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,63}$")
# 只有真正的 shell 才会把 `echo ===MCP_SHELL===$?` 输出成独占一行的 ===MCP_SHELL===0
_SHELL_PROBE = "===MCP_SHELL==="
_OPENSSH_VERSION = re.compile(r"OpenSSH_(\d+)\.(\d+)")
_RSA_SHA2_MIN_OPENSSH_VERSION = (7, 2)
_RSA_SHA2_ALGORITHMS = ["rsa-sha2-256", "rsa-sha2-512"]


def _requires_legacy_ssh_rsa(remote_version: str) -> bool:
    match = _OPENSSH_VERSION.search(remote_version)
    return bool(
        match
        and (int(match.group(1)), int(match.group(2))) < _RSA_SHA2_MIN_OPENSSH_VERSION
    )


# 连接被 aTrust 隧道/堡垒机网关提前关闭时的有限重试：仅限尚未发送密码/验证码的尝试
_EARLY_CLOSE_MAX_ATTEMPTS = 3
_EARLY_CLOSE_BACKOFF_SECONDS = (1, 3)
_EARLY_CLOSE_RETRY_BUDGET_SECONDS = 20


class _GatewayClosed(Exception):
    """TCP 已建立，但对端（aTrust 网关/堡垒机）在握手、认证或开 shell 时关闭了连接。"""

    def __init__(self, stage: str, detail: str):
        super().__init__(f"{stage}: {detail}")
        self.stage = stage
        self.detail = detail


def _is_early_close(exc: BaseException) -> bool:
    """paramiko 在对端提前断开时抛出的异常：未收到 banner、EOF、连接被重置。"""
    if isinstance(exc, (EOFError, ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
        return True
    if isinstance(exc, paramiko.SSHException):
        message = str(exc).lower()
        return any(k in message for k in ("banner", "eof", "connection reset", "connection closed"))
    return False


def _channel_dead(ch) -> bool:
    return bool(getattr(ch, "closed", False) or getattr(ch, "eof_received", False))


def _last_line(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[-1] if lines else ""


def _first_line(text: str, skip: str = "") -> str:
    for line in text.replace("\r", "").split("\n"):
        if line.strip() and line.strip() != skip:
            return line.strip()
    return ""


def _is_auth_prompt(text: str, keywords: tuple[str, ...]) -> bool:
    """判断 text 是否为认证输入提示。
    只看最后一个非空行（光标所在的等待输入行），同时满足：
    1) 包含认证关键词  2) 看起来在等待用户输入（包含提示语或以冒号结尾）。
    避免 banner/菜单/报错中前面某行提到 password、另一行出现 Enter 时被误判。"""
    line = _last_line(text)
    if not any(k in line for k in keywords):
        return False
    # 检查是否有输入提示指示符
    if any(ind in line for ind in _INPUT_PROMPT_INDICATORS):
        return True
    # 检查是否以冒号结尾（中英文冒号），常见的输入等待标志
    return line[-1] in (":", "：")


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


def _get_allowed_sudo_users(config: dict | None) -> set[str]:
    if not config:
        return DEFAULT_ALLOWED_SUDO_USERS
    users = config.get("allowed_sudo_users", list(DEFAULT_ALLOWED_SUDO_USERS))
    if isinstance(users, str):
        users = [users]
    return {str(user).strip() for user in users if str(user).strip()}


def _validate_sudo_su_command(tokens: list[str], allowed_sudo_users: set[str]) -> str | None:
    if len(tokens) != 6:
        return "sudo"
    if tokens[0].split("/")[-1] != "sudo":
        return tokens[0].split("/")[-1]
    if tokens[1] != "/bin/su":
        return "sudo"
    if tokens[2] != "-":
        return "sudo"
    if tokens[3] not in allowed_sudo_users:
        return tokens[3]
    if tokens[4] != "-c" or not tokens[5].strip():
        return "sudo"
    return validate_command(tokens[5], allowed_sudo_users=set(), allow_sudo=False)


def _parse_sudo_su_command(command: str, allowed_sudo_users: set[str]) -> tuple[str, str] | None:
    parts = _split_outside_quotes(command, ["&&", "||", ";"])
    if len(parts) != 1:
        return None
    segments = _split_outside_quotes(parts[0], ["|"])
    if len(segments) != 1:
        return None
    try:
        tokens = shlex.split(segments[0])
    except ValueError:
        return None
    if _validate_sudo_su_command(tokens, allowed_sudo_users) is not None:
        return None
    return tokens[3], tokens[5]


def _is_pid(text: str) -> bool:
    return bool(re.fullmatch(r"[1-9][0-9]*", text))


def _is_jstat_interval(text: str) -> bool:
    return bool(re.fullmatch(r"[1-9][0-9]*(ms|s)?", text))


def _is_safe_jstat(tokens: list[str]) -> bool:
    if not 3 <= len(tokens) <= 5:
        return False
    if tokens[1] not in SAFE_JSTAT_OPTIONS or not _is_pid(tokens[2]):
        return False
    if len(tokens) >= 4 and not _is_jstat_interval(tokens[3]):
        return False
    if len(tokens) == 5:
        if not tokens[4].isdigit():
            return False
        count = int(tokens[4])
        if count < 1 or count > 10:
            return False
    return True


def _is_safe_jcmd(tokens: list[str]) -> bool:
    if len(tokens) != 3:
        return False
    return _is_pid(tokens[1]) and tokens[2] in SAFE_JCMD_COMMANDS


def validate_command(command: str, allowed_sudo_users: set[str] | None = None,
                     allow_sudo: bool = True) -> str | None:
    """校验命令是否在白名单内。
    支持 && 连接多条命令，支持管道 |。
    正确处理引号内的特殊字符（如 awk 脚本中的 &&、|、;）。
    支持受控的 sudo /bin/su - <user> -c '<只读命令>'。
    返回第一个不合法的命令名，全部合法返回 None。"""
    allowed_sudo_users = allowed_sudo_users or set()
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
            if cmd_name == "sudo":
                if len(parts) != 1 or len(segments) != 1:
                    return cmd_name
                if not allow_sudo:
                    return cmd_name
                sudo_rejected = _validate_sudo_su_command(tokens, allowed_sudo_users)
                if sudo_rejected:
                    return sudo_rejected
                continue
            if cmd_name == "jstat":
                if not _is_safe_jstat(tokens):
                    return cmd_name
                continue
            if cmd_name == "jcmd":
                if not _is_safe_jcmd(tokens):
                    return cmd_name
                continue
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


def _decode_output(buf: bytes) -> str:
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


def send_cmd_with_sudo_password(channel, cmd, password="", timeout=30):
    """发送 sudo 命令；如出现 sudo 密码提示，通过 stdin 输入密码。"""
    channel.send(cmd + "\n")
    buf = b""
    end = time.time() + timeout
    last_recv = time.time()
    password_sent = False
    while time.time() < end:
        if channel.recv_ready():
            chunk = channel.recv(65535)
            buf += chunk
            last_recv = time.time()
            clean = strip_ansi(_decode_output(buf))
            if _SUDO_PROMPT in clean and not password_sent:
                if not password:
                    channel.send("\003")
                    return clean + "\n错误：sudo 要求输入密码，但当前连接没有可用 password"
                channel.send(password + "\n")
                password_sent = True
        elif time.time() - last_recv > 1.5:
            break
        else:
            time.sleep(0.2)
    return _decode_output(buf)


def _extract_marker_content(clean: str, marker_start: str, marker_end: str) -> str | None:
    """取两个 marker 之间的输出。marker 必须独占一行：命令回显里的
    `echo ===MCP_START=== && ...` 不算，否则命令根本没执行时会把回显当成结果。
    没有独占一行的起始 marker 返回 None；有起始没有结束（`&&` 链中途失败）返回起始之后、末行提示符之前的内容。"""
    lines = clean.replace("\r", "").split("\n")
    starts = [i for i, line in enumerate(lines) if line.strip() == marker_start]
    if not starts:
        return None
    start = starts[-1]
    for end in range(start + 1, len(lines)):
        if lines[end].strip() == marker_end:
            return "\n".join(lines[start + 1:end]).strip("\n")
    return "\n".join(lines[start + 1:-1]).strip("\n")


def generate_totp(secret: str, now: float | None = None) -> str:
    """RFC 6238 TOTP（HMAC-SHA1、30 秒步长、6 位），secret 为 base32（忽略空格与大小写）。"""
    cleaned = secret.replace(" ", "").upper()
    key = base64.b32decode(cleaned + "=" * (-len(cleaned) % 8))
    counter = int((time.time() if now is None else now) // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{code % 1000000:06d}"


def make_auth_handler(password="", otp=""):
    """创建 keyboard-interactive 认证处理器"""
    def handler(title, instructions, prompt_list):
        responses = []
        for prompt, echo in prompt_list:
            p = prompt.lower().strip()
            if "password" in p:
                responses.append(password)
            elif any(k in p for k in ("otp", "code", "验证", "token", "mfa", "moa")):
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
        self._credentials_sent = False
        self._authenticated = False
        # 堡垒机 shell 追问过密码/安全码时为 True：安全码一次有效，之后所有命令必须复用这一个已认证的
        # channel（_shared_channel），不能再各开 channel 重新认证。
        self._shell_auth_used = False
        self._shared_channel: paramiko.Channel = None
        self._shared_ip: str | None = None
        self._shared_lock = threading.Lock()
        self._keepalive_note = ""

    def connect(self, password: str = "", otp: str = "",
                keepalive_ip: str = "") -> str:
        """连接堡垒机并启动保活。
        仅当 TCP 已连上但对端在握手/认证/开 shell 时提前关闭、且本次尝试尚未发送密码或验证码时，
        才做有限次退避重试；DNS/TCP 失败和真实的认证提示都直接返回。"""
        host = self.config["bastion_host"]
        port = self.config["bastion_port"]
        deadline = time.monotonic() + _EARLY_CLOSE_RETRY_BUDGET_SECONDS
        attempt = 0
        while True:
            attempt += 1
            self._credentials_sent = False
            try:
                return self._connect_once(password, otp, keepalive_ip)
            except _GatewayClosed as e:
                self.disconnect()
                delay = (
                    _EARLY_CLOSE_BACKOFF_SECONDS[attempt - 1]
                    if attempt < _EARLY_CLOSE_MAX_ATTEMPTS else None
                )
                retryable = (
                    not self._credentials_sent
                    and delay is not None
                    and time.monotonic() + delay < deadline
                )
                if not retryable:
                    note = (
                        "；本次已发送过密码/验证码，为避免重复消耗验证码未自动重试"
                        if self._credentials_sent else ""
                    )
                    return (
                        f"错误：TCP 已连上 {host}:{port}，但连接在{e.stage}阶段被对端关闭"
                        f"（{e.detail}），共尝试 {attempt} 次{note}。"
                        "aTrust 隧道或堡垒机网关断开（非凭据问题），"
                        "请检查 aTrust 是否在线/重新登录 aTrust，再重试"
                    )
                logger.warning(
                    f"第 {attempt} 次连接在{e.stage}阶段被对端关闭（{e.detail}），{delay}s 后重试"
                )
                time.sleep(delay)

    def _otp_value(self) -> str:
        """调用方传入的 otp 优先；否则用 BASTION_TOTP_SECRET 或 config["totp_secret"] 在提示出现的时刻现算一个，
        两者都没有返回空串。现算而不是连接开始时算，避免握手耗时后验证码过期。"""
        if self._otp:
            return self._otp
        secret = os.environ.get("BASTION_TOTP_SECRET", "") or self.config.get("totp_secret", "")
        if not secret:
            return ""
        try:
            return generate_totp(secret)
        except (ValueError, TypeError) as e:
            logger.warning(f"totp_secret 不是合法的 base32，无法生成验证码：{type(e).__name__}")
            return ""

    def _transport_active(self) -> bool:
        return self.transport is not None and self.transport.is_active()

    def _connect_once(self, password: str, otp: str, keepalive_ip: str) -> str:
        host = self.config["bastion_host"]
        port = self.config["bastion_port"]
        connect_timeout = self.config.get("connect_timeout", 15)

        logger.info(f"连接 {host}:{port} ...")
        try:
            sock = socket.create_connection((host, port), timeout=connect_timeout)
        except socket.gaierror as e:
            return f"错误：无法解析堡垒机地址 {host}（DNS 失败：{e}），请检查 aTrust/wsl-vpnkit 及 DNS 是否可用"
        except OSError as e:
            return f"错误：TCP 连接 {host}:{port} 失败（{e}），请检查 aTrust 是否在线及网络/wsl-vpnkit 是否正常"

        try:
            return self._handshake_and_login(sock, password, otp, keepalive_ip)
        except _GatewayClosed:
            raise
        except Exception as e:
            closed = _is_early_close(e) or not self._transport_active()
            self.disconnect()
            if closed:
                stage = "认证后打开 shell" if self._authenticated else "SSH 握手/认证"
                raise _GatewayClosed(stage, f"{type(e).__name__}: {e}") from e
            raise

    def _handshake_and_login(self, sock, password: str, otp: str,
                             keepalive_ip: str) -> str:
        host = self.config["bastion_host"]
        port = self.config["bastion_port"]
        username = self.config["username"]
        pem_path = self.config["pem_path"]
        self._authenticated = False
        self.transport = paramiko.Transport(sock)

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

        # OpenSSH 7.2 起支持 RSA-SHA2；仅对旧版服务端回退到 ssh-rsa (SHA-1)。
        if _requires_legacy_ssh_rsa(self.transport.remote_version):
            self.transport.disabled_algorithms = {
                "pubkeys": _RSA_SHA2_ALGORITHMS,
            }

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
            if not self._transport_active():
                raise _GatewayClosed("认证", "密钥认证过程中 SSH 连接已断开")
            if not password:
                return "错误：密钥认证失败且未提供密码，请传入 password 和 otp"
            logger.info("密钥认证失败，使用密码+验证码认证...")
            self._credentials_sent = True
            self._otp = otp
            self.transport.auth_interactive(
                username, make_auth_handler(password=password, otp=self._otp_value())
            )
            logger.info("认证成功")

        if not self.transport.is_authenticated():
            return "错误：认证失败"
        self._authenticated = True

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
            if not self._transport_active():
                raise _GatewayClosed("验证目标机", verify_error)
            return verify_error

        if self._keepalive_note:
            return f"已连接堡垒机 {host}:{port} 并通过认证；{self._keepalive_note}"
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
                return False, (
                    "错误：堡垒机 shell 要求输入密码，但未提供 password 参数"
                    f"（提示行：{_last_line(clean)!r}）；可在 BASTION_CONFIG 指向的 config.json 填 password，"
                    "或设置环境变量 BASTION_PASSWORD"
                )
            logger.info("检测到 shell 二次密码认证，自动输入密码")
            self._credentials_sent = True
            self._shell_auth_used = True
            out = send_cmd(ch, self._password, timeout=10)
            clean = strip_ansi(out)
            # 检测密码是否被拒绝
            if any(k in clean for k in _AUTH_FAIL_KEYWORDS) and _is_auth_prompt(clean, _PASSWORD_KEYWORDS):
                return False, "错误：shell 密码认证失败，请检查密码是否正确"

        # 第二步：检测安全码提示
        if _is_auth_prompt(clean, _OTP_KEYWORDS):
            otp = self._otp_value()
            if not otp:
                return False, (
                    "错误：堡垒机 shell 要求输入安全码（OTP），请提供 otp 参数"
                    f"（提示行：{_last_line(clean)!r}）。未配置 totp_secret / BASTION_TOTP_SECRET 时，"
                    "请立即向用户弹出输入框索取当前 6 位 MOA 安全码（Claude Code 用 AskUserQuestion，其他客户端直接提问），"
                    "拿到后用 otp 参数重连一次；安全码一次有效，不要用旧码或空码重试"
                )
            logger.info("检测到安全码提示，自动输入安全码")
            self._credentials_sent = True
            self._shell_auth_used = True
            out = send_cmd(ch, otp, timeout=10)
            clean = strip_ansi(out)
            # 检测安全码是否被拒绝：出现失败关键词，或者堡垒机又问了一次安全码/密码
            if (any(k in clean for k in _AUTH_FAIL_KEYWORDS)
                    or _is_auth_prompt(clean, _OTP_KEYWORDS)
                    or _is_auth_prompt(clean, _PASSWORD_KEYWORDS)):
                return False, (
                    "错误：安全码验证失败（已过期或已被使用过），请向用户索取新的 6 位 MOA 安全码后重新连接"
                    f"（提示行：{_last_line(clean)!r}）"
                )

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
        if not initial.strip() and _channel_dead(ch):
            ch.close()
            raise _GatewayClosed("打开 shell", "shell channel 未输出任何内容即被关闭")

        ok, msg = self._handle_shell_auth(ch, initial)
        if not ok:
            # 提示出现后 channel 随即关闭，说明是断线前的残留输出，不是在等待输入
            dead = _channel_dead(ch)
            ch.close()
            # 已经发过密码并被堡垒机接受、随后才缺安全码或安全码被拒：这是凭据问题，堡垒机随后关 channel 属正常，
            # 原样返回提示，不当成隧道断开去重试
            if dead and not self._credentials_sent:
                raise _GatewayClosed("打开 shell", f"shell channel 已关闭（{msg}）")
            return msg

        go_out = send_cmd(ch, f"go {keepalive_ip}", timeout=15)
        if self._shell_auth_used:
            # 这条 channel 用掉了一次有效的安全码，后续命令都复用它；先确认真的进了目标机 shell
            self._shared_channel = ch
            if self._at_target_shell(ch):
                self._shared_ip = keepalive_ip
            else:
                # 保活目标机进不去（下线/不可达）不等于登录失败：安全码已经用掉，channel 停在堡垒机菜单，
                # 照样可以 go 到别的机器，所以保留它，只在连接结果里说明
                if _channel_dead(ch):
                    self._shared_channel = None
                    ch.close()
                    raise _GatewayClosed("进入保活目标机", "shell channel 已关闭")
                self._shared_ip = None
                self._keepalive_note = (
                    f"保活目标 {keepalive_ip} 进不去（{self._redact(_first_line(strip_ansi(go_out), skip=f'go {keepalive_ip}'))}），"
                    "channel 停在堡垒机菜单，请把 config.json 的 keepalive_ip 换成一台在线机器"
                )
                logger.warning(self._keepalive_note)
        if not self._shell_auth_used or self._shared_ip is not None:
            send_cmd(ch, "export TMOUT=86400", timeout=5)
            send_cmd(ch, "tail -f /dev/null &", timeout=5)
        self.keepalive_channel = ch
        logger.info(f"保活 channel 已建立，目标 {keepalive_ip}")

        # 3. 后台线程定期发送空行
        self._stop_keepalive.clear()

        def _keepalive_loop():
            while not self._stop_keepalive.wait(idle_interval):
                try:
                    kch = self.keepalive_channel
                    if not kch or kch.closed:
                        continue
                    if kch is self._shared_channel:
                        # 复用模式：命令执行期间不插空行；发完把回显读掉，避免混进下一条命令的输出
                        if self._shared_lock.acquire(blocking=False):
                            try:
                                kch.send("\n")
                                recv_until_idle(kch, timeout=3, idle=0.5)
                            finally:
                                self._shared_lock.release()
                    else:
                        kch.send("\n")
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
        if self._shared_channel is not None:
            # 复用模式：已在保活目标机上，直接在这条已认证的 channel 里验证
            if self._shared_ip is None:
                return None, ""  # 停在堡垒机菜单，没有目标机可验证；_keepalive_note 已说明原因
            with self._shared_lock:
                whoami_result = self._whoami(self._shared_channel)
            if whoami_result:
                return None, whoami_result
            return "错误：连接验证失败，whoami 没有返回合法用户名（命令可能没有在目标机执行）", ""

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
            if any(k in jump_clean for k in ("权限", "没有")):
                return f"跳转失败: {jump_clean.strip()}", ""

            whoami_result = self._whoami(ch)

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

    def _whoami(self, ch) -> str:
        """在 ch 上执行 whoami，返回第一行合法用户名；没有则返回空串。
        目标机用户不一定等于堡垒机用户名（DBA 通道是 bi_clickhouse），所以只校验形状，不和 config 比对。"""
        lines = strip_ansi(send_cmd(ch, "whoami", timeout=10)).replace("\r", "").split("\n")
        for line in lines:
            text = line.strip()
            if text and text != "whoami" and _USERNAME_RE.match(text):
                return text
        return ""

    def _redact(self, text: str) -> str:
        for secret in (self._password, self._otp):
            if secret:
                text = text.replace(secret, "***")
        return text

    def _at_target_shell(self, ch) -> bool:
        out = strip_ansi(send_cmd(ch, f"echo {_SHELL_PROBE}$?", timeout=5)).replace("\r", "")
        return any(line.strip() == f"{_SHELL_PROBE}0" for line in out.split("\n"))

    def _shared_goto(self, ip: str) -> str | None:
        """复用模式下把已认证的 channel 切到目标机 ip。调用方持有 _shared_lock。返回 None 表示已在 ip 上。"""
        ch = self._shared_channel
        if _channel_dead(ch):
            return "错误：堡垒机已认证的 shell channel 已关闭，请重新 connect_bastion（需要新的安全码）"
        if ch.recv_ready():
            recv_until_idle(ch, timeout=2, idle=0.5)  # 丢掉上一条命令或保活留下的残余输出
        if self._shared_ip == ip:
            return None
        if self._shared_ip is not None:
            # 从当前目标机退回堡垒机菜单；su 之类的嵌套 shell 可能要退多层，以探针不再命中为准
            self._shared_ip = None
            for _ in range(3):
                send_cmd(ch, "exit", timeout=5)
                if _channel_dead(ch):
                    return "错误：退出上一台目标机时 channel 被关闭，请重新 connect_bastion（需要新的安全码）"
                if not self._at_target_shell(ch):
                    break
            else:
                return "错误：无法从上一台目标机退回堡垒机菜单，请重新 connect_bastion"
        jump = strip_ansi(send_cmd(ch, f"go {ip}", timeout=15))
        if any(k in jump for k in ("权限", "没有")):
            return f"跳转失败: {jump.strip()}"
        if not self._at_target_shell(ch):
            return f"错误：go {ip} 之后没有进入目标机 shell，尾部输出：{self._redact(jump)[-300:]!r}"
        send_cmd(ch, "export TMOUT=86400", timeout=5)
        self._shared_ip = ip
        return None

    def execute_on_target(self, ip: str, command: str,
                          timeout: int = 30) -> str:
        """在目标机器上执行命令"""
        return self._execute_on_target(
            ip,
            command,
            timeout=timeout,
            validate_allowed=True,
            always_mark_end=False,
        )

    def execute_raw_on_target(self, ip: str, command: str,
                              timeout: int = 30) -> str:
        """执行已由上层工具完成安全校验的命令。不要直接暴露为 MCP 通用工具。"""
        return self._execute_on_target(
            ip,
            command,
            timeout=timeout,
            validate_allowed=False,
            always_mark_end=True,
        )

    def _execute_via_interactive_sudo_su(self, ch, user: str, command: str,
                                         marker_start: str, marker_end: str,
                                         timeout: int) -> str:
        su_cmd = f"sudo /bin/su - {shlex.quote(user)}"
        if self._password:
            su_cmd = " ".join([
                "sudo",
                "-S",
                "-p",
                shlex.quote(_SUDO_PROMPT),
                "/bin/su",
                "-",
                shlex.quote(user),
            ])
            su_out = send_cmd_with_sudo_password(
                ch,
                su_cmd,
                password=self._password,
                timeout=timeout,
            )
        else:
            su_out = send_cmd(ch, su_cmd, timeout=timeout)

        verify_out = send_cmd(ch, "whoami", timeout=5)
        verify_lines = [
            line.strip()
            for line in strip_ansi(verify_out).splitlines()
            if line.strip()
        ]
        if user not in verify_lines:
            return (
                su_out
                + verify_out
                + f"\n错误：未能通过 sudo /bin/su - {user} 进入目标用户 shell"
            )

        raw = []
        raw.append(send_cmd(ch, f"echo {marker_start}", timeout=5))
        raw.append(send_cmd(ch, command, timeout=timeout))
        raw.append(send_cmd(ch, f"echo {marker_end}", timeout=5))
        raw.append(send_cmd(ch, "exit", timeout=5))
        return "".join(raw)

    def _execute_on_target(self, ip: str, command: str, timeout: int = 30,
                           validate_allowed: bool = True,
                           always_mark_end: bool = False) -> str:
        if not self.is_connected():
            return "错误：未连接堡垒机"

        sudo_su_command = None
        if validate_allowed:
            allowed_sudo_users = _get_allowed_sudo_users(self.config)
            rejected = validate_command(
                command,
                allowed_sudo_users=allowed_sudo_users,
            )
            if rejected:
                allowed = sorted(ALLOWED_COMMANDS)
                sudo_users = sorted(allowed_sudo_users)
                if sudo_users:
                    allowed.append(
                        "sudo /bin/su - <{}> -c '<allowed command>'".format(
                            "|".join(sudo_users)
                        )
                    )
                return f"命令被拒绝：'{rejected}' 不在允许列表中。允许的命令: {', '.join(allowed)}"
            sudo_su_command = _parse_sudo_su_command(command, allowed_sudo_users)

        if self._shared_channel is not None:
            # 复用模式：命令在唯一一条已认证的 channel 上串行执行，不再开新 channel 重新认证
            with self._shared_lock:
                try:
                    error = self._shared_goto(ip)
                    if error:
                        return error
                    return self._run_marked(self._shared_channel, command, sudo_su_command,
                                            always_mark_end, timeout, shared=True)
                except Exception as e:
                    return f"执行失败: {e}"

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
            if any(k in jump_clean for k in ("权限", "没有")):
                return f"跳转失败: {jump_clean.strip()}"
            return self._run_marked(ch, command, sudo_su_command, always_mark_end, timeout, shared=False)
        except Exception as e:
            return f"执行失败: {e}"
        finally:
            if ch:
                try:
                    ch.close()
                except Exception:
                    pass

    def _run_marked(self, ch, command: str, sudo_su_command, always_mark_end: bool,
                    timeout: int, shared: bool) -> str:
        """在已位于目标机 shell 的 ch 上用 marker 执行命令并取输出。"""
        # 用 marker 方式执行命令
        marker_start = "===MCP_START==="
        marker_end = "===MCP_END==="
        if sudo_su_command:
            raw = self._execute_via_interactive_sudo_su(
                ch,
                sudo_su_command[0],
                sudo_su_command[1],
                marker_start,
                marker_end,
                timeout,
            )
            clean = strip_ansi(raw)
            content = _extract_marker_content(clean, marker_start, marker_end)
            return content if content is not None else self._redact(clean.strip())

        if always_mark_end:
            cmd = f"echo {marker_start}; {command}; echo {marker_end}"
        else:
            cmd = f"echo {marker_start} && {command} && echo {marker_end}"
        if "sudo -S" in command:
            raw = send_cmd_with_sudo_password(
                ch,
                cmd,
                password=self._password,
                timeout=timeout,
            )
        else:
            raw = send_cmd(ch, cmd, timeout=timeout)
        clean = strip_ansi(raw)

        # 提取 marker 之间的输出
        content = _extract_marker_content(clean, marker_start, marker_end)
        if shared and not any(line.strip() == marker_end for line in clean.replace("\r", "").split("\n")):
            # 没见到结束 marker：命令可能还在跑（超时）或 && 链中途失败。发 Ctrl-C 并读掉残余，
            # 保证这条共用 channel 回到提示符，下一条命令不被污染
            ch.send("\x03")
            recv_until_idle(ch, timeout=3, idle=0.5)
        if content is not None:
            return content
        return (
            "错误：命令没有在目标机执行（输出里没有独占一行的 ===MCP_START===，只有命令回显）。"
            f"尾部输出：{self._redact(clean.strip())[-300:]!r}"
        )

    def disconnect(self):
        """断开连接，停止保活"""
        self._stop_keepalive.set()
        if self.keepalive_channel:
            try:
                self.keepalive_channel.close()
            except Exception:
                pass
            self.keepalive_channel = None
        self._shared_channel = None
        self._shared_ip = None
        self._shell_auth_used = False
        self._keepalive_note = ""
        if self.transport:
            try:
                self.transport.close()
            except Exception:
                pass
            self.transport = None
        logger.info("已断开堡垒机连接")
