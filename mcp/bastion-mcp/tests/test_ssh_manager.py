import unittest
from unittest.mock import patch

from bastion_mcp.ssh_manager import SSHManager, validate_command


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


if __name__ == "__main__":
    unittest.main()


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
