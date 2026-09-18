#!/usr/bin/python3
"""在终端里解锁 gnome-keyring 默认钥匙串，不依赖图形弹窗（WSL 下 gcr-prompter 常常不可用）。

用法（必须由用户在自己的终端运行，密码经 getpass 读取，不落盘、不打印）：
  /usr/bin/python3 unlock_keyring.py                  # 解锁一次
  /usr/bin/python3 unlock_keyring.py --empty-password # 把钥匙串密码改为空，以后开机不再锁定

--empty-password 会让钥匙串文件不再加密，只在用户明确同意后使用。
必须用系统 /usr/bin/python3：pyenv 等自装解释器通常没有 dbus 模块。
"""
import getpass
import sys

import dbus

BUS_NAME = "org.freedesktop.secrets"
INTERNAL = "org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface"


def main():
    empty_password = "--empty-password" in sys.argv[1:]
    bus = dbus.SessionBus()
    svc = bus.get_object(BUS_NAME, "/org/freedesktop/secrets")
    service = dbus.Interface(svc, "org.freedesktop.Secret.Service")
    internal = dbus.Interface(svc, INTERNAL)

    collection = service.ReadAlias("default")
    if collection == "/":
        raise SystemExit("没有找到默认钥匙串")
    props = dbus.Interface(bus.get_object(BUS_NAME, collection), "org.freedesktop.DBus.Properties")

    def locked():
        return bool(props.Get("org.freedesktop.Secret.Collection", "Locked"))

    if not empty_password and not locked():
        print("钥匙串已经是解锁状态")
        return

    _, session = service.OpenSession("plain", dbus.String("", variant_level=1))

    def secret(value):
        return dbus.Struct(
            (session, dbus.ByteArray(b""), dbus.ByteArray(value.encode()), "text/plain"),
            signature="oayays",
        )

    password = getpass.getpass("当前钥匙串密码（通常是 WSL 登录密码）: ")
    try:
        if empty_password:
            internal.ChangeWithMasterPassword(collection, secret(password), secret(""))
            if locked():
                internal.UnlockWithMasterPassword(collection, secret(""))
        else:
            internal.UnlockWithMasterPassword(collection, secret(password))
    except dbus.DBusException as error:
        raise SystemExit(f"操作失败：{error.get_dbus_message()}（密码可能不对）")
    finally:
        password = None

    state = "仍锁定，密码可能不对" if locked() else "已解锁"
    print(("钥匙串密码已改为空，当前" if empty_password else "钥匙串") + state)


if __name__ == "__main__":
    main()
