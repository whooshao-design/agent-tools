import socket
import unittest
from unittest.mock import patch

import paramiko

from bastion_mcp import ssh_manager
from bastion_mcp.ssh_manager import SSHManager, _is_auth_prompt, validate_command


class _SecurityOptions:
    kex = ()
    key_types = ()
    ciphers = ()


class _Transport:
    def __init__(self, remote_version):
        self.remote_version = remote_version
        self.disabled_algorithms = {}
        self.auth_disabled_algorithms = None
        self.authenticated = False
        self.security_options = _SecurityOptions()

    def get_security_options(self):
        return self.security_options

    def start_client(self):
        pass

    def auth_publickey(self, username, key):
        self.auth_disabled_algorithms = self.disabled_algorithms.copy()
        self.authenticated = True

    def is_authenticated(self):
        return self.authenticated


class SSHManagerRsaAlgorithmTest(unittest.TestCase):
    def _connect(self, remote_version):
        transport = _Transport(remote_version)
        manager = SSHManager({
            "bastion_host": "bastion.example.com",
            "bastion_port": 39000,
            "username": "tester",
            "pem_path": "/tmp/test.pem",
        })

        with (
            patch("bastion_mcp.ssh_manager.socket.create_connection", return_value=object()),
            patch("bastion_mcp.ssh_manager.paramiko.Transport", return_value=transport),
            patch(
                "bastion_mcp.ssh_manager.paramiko.RSAKey.from_private_key_file",
                return_value=object(),
            ),
            patch.object(SSHManager, "_start_keepalive", return_value=None),
            patch.object(SSHManager, "_verify_connection", return_value=(None, "tester")),
        ):
            result = manager.connect()

        self.assertIn("验证成功", result)
        return transport.auth_disabled_algorithms

    def test_modern_openssh_keeps_rsa_sha2_enabled(self):
        for remote_version in ("SSH-2.0-OpenSSH_7.2", "SSH-2.0-OpenSSH_7.4"):
            with self.subTest(remote_version=remote_version):
                self.assertEqual({}, self._connect(remote_version))

    def test_old_openssh_uses_legacy_ssh_rsa_signature(self):
        for remote_version in ("SSH-2.0-OpenSSH_5.3", "SSH-2.0-OpenSSH_7.1"):
            with self.subTest(remote_version=remote_version):
                self.assertEqual(
                    {"pubkeys": ["rsa-sha2-256", "rsa-sha2-512"]},
                    self._connect(remote_version),
                )



class ValidateCommandTest(unittest.TestCase):
    def test_binary_read_commands_are_allowed(self):
        for cmd in (
            "tail -c +1 /a/b.ser | head -c 120000 | base64",
            "md5sum /a/b.ser && sha1sum /a/b.ser",
            "stat -c %s /a/b.ser",
            "od -An -tx1 -N16 /a/b.ser",
        ):
            self.assertIsNone(validate_command(cmd), cmd)

    def test_unlisted_commands_are_still_rejected(self):
        self.assertEqual(validate_command("base64 /a | xxd"), "xxd")
        self.assertEqual(validate_command("cp /a /b"), "cp")


_CONFIG = {
    "bastion_host": "ssh.jumpserver.example.com",
    "bastion_port": 39000,
    "username": "tester",
    "pem_path": "/tmp/test.pem",
}


class _BannerFailTransport(_Transport):
    """TCP 已建立，但对端在发送 SSH banner 前关闭。"""

    def __init__(self):
        super().__init__("")
        self.closed = False

    def start_client(self):
        raise paramiko.SSHException("Error reading SSH protocol banner")

    def is_active(self):
        return False

    def close(self):
        self.closed = True


class _Channel:
    def __init__(self, output, closed=False):
        self._output = output.encode("utf-8")
        self.closed = closed
        self.eof_received = closed
        self.sent = []

    def get_pty(self, **kwargs):
        pass

    def invoke_shell(self):
        pass

    def recv_ready(self):
        return bool(self._output)

    def recv(self, size):
        data, self._output = self._output, b""
        return data

    def send(self, data):
        self.sent.append(data)

    def close(self):
        self.closed = True


class _ShellTransport(_Transport):
    def __init__(self, channel, active=True):
        super().__init__("SSH-2.0-OpenSSH_7.4")
        self.channel = channel
        self.active = active

    def is_active(self):
        return self.active

    def set_keepalive(self, interval):
        pass

    def open_session(self):
        return self.channel

    def close(self):
        self.active = False


def _patch_connect(transport_factory):
    return (
        patch("bastion_mcp.ssh_manager.socket.create_connection", return_value=object()),
        patch("bastion_mcp.ssh_manager.paramiko.Transport", side_effect=transport_factory),
        patch(
            "bastion_mcp.ssh_manager.paramiko.RSAKey.from_private_key_file",
            return_value=object(),
        ),
        patch("bastion_mcp.ssh_manager.time.sleep"),
        # shell 输出直接从假 channel 读取，避免 recv_until_idle 的真实等待
        patch(
            "bastion_mcp.ssh_manager.recv_until_idle",
            side_effect=lambda ch, timeout=10, idle=1.5: ch.recv(65535).decode("utf-8"),
        ),
    )


def _retry_sleeps(sleep):
    return [c.args[0] for c in sleep.call_args_list if c.args[0] >= 1]


class AuthPromptDetectionTest(unittest.TestCase):
    def test_genuine_prompt_on_last_line(self):
        self.assertTrue(_is_auth_prompt("Welcome\r\n请输入密码:", ssh_manager._PASSWORD_KEYWORDS))
        self.assertTrue(_is_auth_prompt("Password: \r\n", ssh_manager._PASSWORD_KEYWORDS))

    def test_keywords_spread_over_banner_lines_are_not_a_prompt(self):
        banner = (
            "Enter the asset ID to login\r\n"
            "Tip: change your password every 90 days\r\n"
            "[tester@jumpserver ~]$ "
        )
        self.assertFalse(_is_auth_prompt(banner, ssh_manager._PASSWORD_KEYWORDS))
        self.assertFalse(_is_auth_prompt(banner, ssh_manager._OTP_KEYWORDS))


class ConnectFailureClassificationTest(unittest.TestCase):
    def _connect(self, transport_factory, **kwargs):
        manager = SSHManager(dict(_CONFIG))
        patches = _patch_connect(transport_factory)
        with patches[0], patches[1] as transport_cls, patches[2], patches[3] as sleep, patches[4]:
            result = manager.connect(**kwargs)
        return result, transport_cls, sleep

    def test_banner_failure_retries_with_backoff_then_reports_gateway(self):
        transports = []

        def factory(sock):
            transports.append(_BannerFailTransport())
            return transports[-1]

        result, transport_cls, sleep = self._connect(factory)
        self.assertEqual(3, transport_cls.call_count)
        self.assertEqual([1, 3], _retry_sleeps(sleep))
        self.assertTrue(all(t.closed for t in transports))
        self.assertIn("aTrust 隧道或堡垒机网关断开（非凭据问题）", result)
        self.assertIn("共尝试 3 次", result)
        self.assertIn("Error reading SSH protocol banner", result)

    def test_banner_failure_then_success_returns_connected(self):
        calls = []

        def factory(sock):
            calls.append(sock)
            if len(calls) == 1:
                return _BannerFailTransport()
            return _Transport("SSH-2.0-OpenSSH_7.4")

        with (
            patch.object(SSHManager, "_start_keepalive", return_value=None),
            patch.object(SSHManager, "_verify_connection", return_value=(None, "tester")),
        ):
            result, transport_cls, sleep = self._connect(factory)
        self.assertEqual(2, transport_cls.call_count)
        self.assertEqual([1], _retry_sleeps(sleep))
        self.assertIn("验证成功", result)

    def test_retry_stops_when_budget_exhausted(self):
        clock = iter([0, 25])
        with patch("bastion_mcp.ssh_manager.time.monotonic", side_effect=lambda: next(clock)):
            result, transport_cls, sleep = self._connect(lambda sock: _BannerFailTransport())
        self.assertEqual(1, transport_cls.call_count)
        sleep.assert_not_called()
        self.assertIn("共尝试 1 次", result)

    def test_dns_failure_is_reported_without_retry(self):
        manager = SSHManager(dict(_CONFIG))
        with (
            patch(
                "bastion_mcp.ssh_manager.socket.create_connection",
                side_effect=socket.gaierror(-2, "Name or service not known"),
            ) as create,
            patch("bastion_mcp.ssh_manager.time.sleep") as sleep,
        ):
            result = manager.connect()
        create.assert_called_once()
        sleep.assert_not_called()
        self.assertIn("DNS 失败", result)

    def test_tcp_failure_is_reported_without_retry(self):
        manager = SSHManager(dict(_CONFIG))
        with (
            patch(
                "bastion_mcp.ssh_manager.socket.create_connection",
                side_effect=socket.timeout("timed out"),
            ) as create,
            patch("bastion_mcp.ssh_manager.time.sleep") as sleep,
        ):
            result = manager.connect()
        create.assert_called_once()
        sleep.assert_not_called()
        self.assertIn("TCP 连接", result)
        self.assertIn("timed out", result)

    def test_genuine_shell_password_prompt_is_not_retried(self):
        channel = _Channel("请输入密码:")
        result, transport_cls, sleep = self._connect(lambda sock: _ShellTransport(channel))
        self.assertEqual(1, transport_cls.call_count)
        self.assertEqual([], _retry_sleeps(sleep))
        self.assertIn("堡垒机 shell 要求输入密码，但未提供 password 参数", result)
        self.assertEqual([], channel.sent)

    def test_password_prompt_on_closed_channel_is_gateway_close(self):
        channels = []

        def factory(sock):
            channels.append(_Channel("请输入密码:", closed=True))
            return _ShellTransport(channels[-1])

        result, transport_cls, sleep = self._connect(factory)
        self.assertEqual(3, transport_cls.call_count)
        self.assertIn("aTrust 隧道或堡垒机网关断开（非凭据问题）", result)
        self.assertTrue(all(ch.sent == [] for ch in channels))

    def test_gateway_close_after_password_sent_is_not_retried(self):
        channel = _Channel("请输入密码:")

        def drop_after_password(ch, cmd, timeout=10):
            ch.sent.append(cmd)
            ch.closed = ch.eof_received = True
            return ""

        with patch("bastion_mcp.ssh_manager.send_cmd", side_effect=drop_after_password):
            transport = _ShellTransport(channel)
            # 密码发出后连接断开：go/whoami 阶段 transport 已不可用
            with patch.object(
                SSHManager, "_verify_connection", side_effect=lambda ip: (transport.close() or ("错误：连接验证失败: EOF", ""))
            ):
                result, transport_cls, sleep = self._connect(lambda sock: transport, password="secret")
        self.assertEqual(1, transport_cls.call_count)
        self.assertEqual([], _retry_sleeps(sleep))
        self.assertIn("未自动重试", result)
        self.assertIn("非凭据问题", result)


if __name__ == "__main__":
    unittest.main()
