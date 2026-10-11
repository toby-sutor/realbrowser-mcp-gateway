#!/usr/bin/env python3
"""Fake org.freedesktop.Notifications service on a private, throwaway bus.

This host has no dbus-daemon and dbus-broker cannot run without systemd, so
the "bus" is a Gio.DBusServer on a private unix socket that answers the few
org.freedesktop.DBus calls a Gio client makes (Hello, AddMatch, GetNameOwner,
...) and plays the Notifications service itself. Clients connect with
DBUS_SESSION_BUS_ADDRESS=<address>. It never touches the operator's bus.

Usage: fake-notify-server.py SOCKET_PATH
stdout (JSON lines): {"event":"ready","address":...}, {"event":"connected"},
  {"event":"notify","id":N,"summary":..,"body":..,"urgency":N,"actions":[..],
   "replaces_id":N,"timeout":N,"app_name":..}, {"event":"close_called","id":N},
  {"event":"disconnected"}
stdin (JSON lines): {"emit":"action","id":N,"key":"open"[,"token":"t"]},
  {"emit":"closed","id":N,"reason":2}, {"emit":"quit"}
"""

import json
import os
import sys
import threading
from typing import Any, Optional

import gi  # type: ignore[import-not-found]

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib  # type: ignore[import-not-found]

SERVICE = "org.freedesktop.Notifications"
PATH = "/org/freedesktop/Notifications"
SERVICE_UNIQUE = ":1.99"
OUT_LOCK = threading.Lock()


def out(obj: dict[str, Any]) -> None:
    with OUT_LOCK:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


class FakeServer:
    def __init__(self, sock: str) -> None:
        self.loop = GLib.MainLoop()
        self.conns: list[Any] = []
        self.next_id = 100
        self.next_client = 1
        guid = Gio.dbus_generate_guid()
        self.server = Gio.DBusServer.new_sync(
            "unix:path=" + sock, Gio.DBusServerFlags.NONE, guid, None, None)
        self.server.connect("new-connection", self.on_new_connection)
        self.server.start()
        self.address = self.server.get_client_address()
        self.serial = 1000

    def on_new_connection(self, _server: Any, conn: Any) -> bool:
        self.conns.append(conn)
        conn.add_filter(self.on_message)
        conn.connect("closed", lambda *_a: out({"event": "disconnected"}))
        out({"event": "connected"})
        return True

    # -- message handling ----------------------------------------------------
    def reply(self, conn: Any, msg: Any, fmt: Optional[str], value: Any = None) -> None:
        r = Gio.DBusMessage.new_method_reply(msg)
        if fmt:
            r.set_body(GLib.Variant(fmt, value))
        r.set_sender("org.freedesktop.DBus" if msg.get_destination() == "org.freedesktop.DBus"
                     else SERVICE_UNIQUE)
        conn.send_message(r, Gio.DBusSendMessageFlags.NONE)

    def error(self, conn: Any, msg: Any, name: str, text: str) -> None:
        r = Gio.DBusMessage.new_method_error_literal(msg, name, text)
        conn.send_message(r, Gio.DBusSendMessageFlags.NONE)

    def on_message(self, conn: Any, msg: Any, incoming: bool) -> Any:
        if msg.get_message_type() != Gio.DBusMessageType.METHOD_CALL:
            return msg
        dest, member = msg.get_destination(), msg.get_member()
        body = msg.get_body()
        if dest == "org.freedesktop.DBus":
            self.bus_call(conn, msg, member, body)
        elif dest == SERVICE or dest == SERVICE_UNIQUE:
            self.service_call(conn, msg, member, body)
        elif dest is None:
            self.error(conn, msg, "org.freedesktop.DBus.Error.UnknownMethod", "no destination")
        else:
            self.error(conn, msg, "org.freedesktop.DBus.Error.ServiceUnknown", "unknown " + dest)
        return None

    def bus_call(self, conn: Any, msg: Any, member: str, body: Any) -> None:
        if member == "Hello":
            name = ":1.%d" % self.next_client
            self.next_client += 1
            self.reply(conn, msg, "(s)", (name,))
        elif member in ("AddMatch", "RemoveMatch"):
            self.reply(conn, msg, None)
        elif member == "RequestName":
            self.reply(conn, msg, "(u)", (1,))
        elif member == "GetNameOwner":
            name = body.unpack()[0]
            if name == SERVICE:
                self.reply(conn, msg, "(s)", (SERVICE_UNIQUE,))
            else:
                self.error(conn, msg, "org.freedesktop.DBus.Error.NameHasNoOwner", name)
        elif member == "NameHasOwner":
            self.reply(conn, msg, "(b)", (body.unpack()[0] == SERVICE,))
        elif member == "ListNames":
            self.reply(conn, msg, "(as)", ([SERVICE],))
        else:
            self.error(conn, msg, "org.freedesktop.DBus.Error.UnknownMethod", member)

    def service_call(self, conn: Any, msg: Any, member: str, body: Any) -> None:
        if member == "Notify":
            (app, rep, _icon, summary, text, actions, hints, timeout) = body.unpack()
            nid = rep if rep else self.next_id
            if not rep:
                self.next_id += 1
            out({"event": "notify", "id": nid, "app_name": app, "replaces_id": rep,
                 "summary": summary, "body": text, "actions": list(actions),
                 "urgency": int(hints.get("urgency", 1)), "timeout": timeout})
            self.reply(conn, msg, "(u)", (nid,))
        elif member == "CloseNotification":
            nid = body.unpack()[0]
            out({"event": "close_called", "id": nid})
            self.reply(conn, msg, None)
            self.signal("NotificationClosed", "(uu)", (nid, 3))
        elif member == "GetCapabilities":
            self.reply(conn, msg, "(as)", (["actions", "body"],))
        elif member == "GetServerInformation":
            self.reply(conn, msg, "(ssss)", ("fake", "bgw-test", "0", "1.2"))
        else:
            self.error(conn, msg, "org.freedesktop.DBus.Error.UnknownMethod", member)

    # -- signals on request ----------------------------------------------------
    def signal(self, name: str, fmt: str, value: Any) -> None:
        for conn in list(self.conns):
            if conn.is_closed():
                continue
            m = Gio.DBusMessage.new_signal(PATH, SERVICE, name)
            m.set_sender(SERVICE_UNIQUE)
            m.set_body(GLib.Variant(fmt, value))
            conn.send_message(m, Gio.DBusSendMessageFlags.NONE)

    def handle_command(self, cmd: dict[str, Any]) -> bool:
        what = cmd.get("emit")
        if what == "action":
            if "token" in cmd:
                self.signal("ActivationToken", "(us)", (cmd["id"], cmd["token"]))
            self.signal("ActionInvoked", "(us)", (cmd["id"], cmd["key"]))
        elif what == "closed":
            self.signal("NotificationClosed", "(uu)", (cmd["id"], cmd.get("reason", 2)))
        elif what == "quit":
            self.loop.quit()
        return False

    def stdin_reader(self) -> None:
        for line in sys.stdin:
            try:
                cmd = json.loads(line)
            except ValueError:
                continue
            GLib.idle_add(self.handle_command, cmd)
        GLib.idle_add(self.loop.quit)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: fake-notify-server.py SOCKET_PATH", file=sys.stderr)
        return 3
    sock = sys.argv[1]
    server = FakeServer(sock)
    out({"event": "ready", "address": server.address})
    threading.Thread(target=server.stdin_reader, daemon=True).start()
    try:
        server.loop.run()
    finally:
        server.server.stop()
        if os.path.exists(sock):
            os.unlink(sock)
    return 0


if __name__ == "__main__":
    sys.exit(main())
