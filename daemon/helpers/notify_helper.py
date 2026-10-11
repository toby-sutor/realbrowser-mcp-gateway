#!/usr/bin/env python3
"""Post one freedesktop notification and report what happens to it.

One process keeps one D-Bus connection: it posts the notification and listens
for ActionInvoked / NotificationClosed / ActivationToken on that same
connection. A separate `gdbus call` cannot receive the click because its
connection is gone before the click happens.

stdout carries JSON lines only (one object per line, flushed):
    {"event":"posted","id":N}  {"event":"action","key":"open"}
    {"event":"activation_token","token":"..."}  {"event":"closed","reason":N}
    {"event":"error","message":"..."}  {"event":"exit","why":"..."}
stdin takes JSON-line commands: {"cmd":"close"}. stdin EOF means the daemon is
gone: exit and leave the notification as it is.
Exit codes: 0 normal, 1 bus lost after posting, 2 D-Bus or PyGObject
unavailable, 3 bad arguments. Diagnostics go to stderr.
"""

import argparse
import json
import os
import signal
import sys
from typing import Any, NoReturn, Optional

BUS_NAME = "org.freedesktop.Notifications"
OBJECT_PATH = "/org/freedesktop/Notifications"
IFACE = "org.freedesktop.Notifications"
URGENCY = {"low": 0, "normal": 1, "critical": 2}
CLOSE_GRACE_MS = 1500
NOTIFY_TIMEOUT_MS = 10000
MAX_STDIN_BUFFER = 64 * 1024

EXIT_OK = 0
EXIT_BUS_LOST = 1
EXIT_NO_DBUS = 2
EXIT_BAD_ARGS = 3


def emit(obj: dict[str, Any]) -> None:
    """Write one JSON line to stdout and flush; a closed pipe ends the process."""
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=True, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, ValueError):
        os._exit(EXIT_OK)


def log(msg: str) -> None:
    print("notify_helper: " + msg, file=sys.stderr, flush=True)


def fail(message: str, code: int) -> NoReturn:
    emit({"event": "error", "message": message})
    emit({"event": "exit", "why": "error"})
    sys.exit(code)


class ArgParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        fail("bad arguments: " + message, EXIT_BAD_ARGS)


def parse_action(value: str) -> tuple[str, str]:
    key, sep, label = value.partition("=")
    if not sep or not key or not label:
        raise argparse.ArgumentTypeError("expected KEY=LABEL, got " + repr(value))
    if "\x00" in key or "\x00" in label:
        raise argparse.ArgumentTypeError("NUL in action")
    return key, label


def build_parser() -> argparse.ArgumentParser:
    p = ArgParser(description="Post one desktop notification and report clicks.")
    p.add_argument("--summary", required=True)
    p.add_argument("--body", default="")
    p.add_argument("--urgency", choices=sorted(URGENCY), default="normal")
    p.add_argument("--action", action="append", default=[], type=parse_action, metavar="KEY=LABEL")
    p.add_argument("--timeout-ms", type=int, default=-1, help="0 = no expiry, -1 = server default")
    p.add_argument("--replaces-id", type=int, default=0)
    p.add_argument("--max-wait-s", type=int, default=3600, help="0 = no limit")
    p.add_argument("--app-name", default="Browser Gateway")
    return p


def build_actions(actions: list[tuple[str, str]]) -> list[str]:
    """Flat [key, label, ...] list; the default action is always present."""
    flat: list[str] = []
    keys = [k for k, _ in actions]
    if "default" not in keys:
        flat += ["default", "Default"]
    for key, label in actions:
        flat += [key, label]
    return flat


class Helper:
    def __init__(self, args: argparse.Namespace, gio: Any, glib: Any) -> None:
        self.args = args
        self.Gio = gio
        self.GLib = glib
        self.loop = glib.MainLoop()
        self.conn: Any = None
        self.nid: Optional[int] = None
        self.exit_code = EXIT_OK
        self.why: Optional[str] = None
        self.close_wanted = False
        self.close_sent = False
        self.stdin_buf = b""
        self.stdin_open = True

    # -- lifecycle ---------------------------------------------------------
    def finish(self, why: str, code: int = EXIT_OK) -> None:
        if self.why is not None:
            return
        self.why = why
        self.exit_code = code
        self.loop.quit()

    def run(self) -> int:
        GLib, Gio = self.GLib, self.Gio
        try:
            self.conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        except GLib.Error as e:
            fail("cannot connect to the session bus: " + str(e.message), EXIT_NO_DBUS)
        if self.conn is None or self.conn.is_closed():
            fail("session bus connection is closed", EXIT_NO_DBUS)
        self.conn.connect("closed", self.on_conn_closed)

        # Subscribe before posting so no signal for our id can slip past.
        for member in ("ActionInvoked", "NotificationClosed", "ActivationToken"):
            self.conn.signal_subscribe(
                BUS_NAME, IFACE, member, OBJECT_PATH, None,
                Gio.DBusSignalFlags.NONE, self.on_signal, None,
            )

        add_signal = self.unix_signal_add()
        for sig in (signal.SIGTERM, signal.SIGINT):
            add_signal(GLib.PRIORITY_HIGH, sig, self.on_signal_exit)
        if self.args.max_wait_s > 0:
            GLib.timeout_add_seconds(self.args.max_wait_s, self.on_max_wait)
        os.set_blocking(0, False)
        GLib.io_add_watch(0, GLib.PRIORITY_DEFAULT,
                          GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self.on_stdin)

        self.notify()
        self.loop.run()
        emit({"event": "exit", "why": self.why or "signal"})
        return self.exit_code

    def unix_signal_add(self) -> Any:
        # GLib.unix_signal_add is deprecated in favour of GLibUnix.signal_add.
        try:
            from gi.repository import GLibUnix  # type: ignore[import-not-found]
            return GLibUnix.signal_add
        except ImportError:
            return self.GLib.unix_signal_add

    # -- D-Bus -------------------------------------------------------------
    def notify(self) -> None:
        a, GLib, Gio = self.args, self.GLib, self.Gio
        params = GLib.Variant("(susssasa{sv}i)", (
            a.app_name, max(a.replaces_id, 0), "", a.summary, a.body,
            build_actions(a.action),
            {"urgency": GLib.Variant("y", URGENCY[a.urgency])},
            a.timeout_ms,
        ))
        self.conn.call(BUS_NAME, OBJECT_PATH, IFACE, "Notify", params,
                       GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE,
                       NOTIFY_TIMEOUT_MS, None, self.on_notify_done, None)

    def on_notify_done(self, conn: Any, result: Any, _data: Any) -> None:
        try:
            reply = conn.call_finish(result)
        except self.GLib.Error as e:
            fail_msg = "Notify failed: " + str(e.message)
            emit({"event": "error", "message": fail_msg})
            self.finish("error", EXIT_NO_DBUS)
            return
        self.nid = int(reply.unpack()[0])
        emit({"event": "posted", "id": self.nid})
        if self.close_wanted:
            self.send_close()

    def on_signal(self, _conn: Any, _sender: Any, _path: Any, _iface: Any,
                  member: str, params: Any, _data: Any) -> None:
        if self.nid is None or self.why is not None:
            return
        try:
            values = params.unpack()
            if int(values[0]) != self.nid:
                return
            if member == "ActionInvoked":
                emit({"event": "action", "key": str(values[1])})
                self.finish("action")
            elif member == "ActivationToken":
                emit({"event": "activation_token", "token": str(values[1])})
            elif member == "NotificationClosed":
                emit({"event": "closed", "reason": int(values[1])})
                self.finish("closed")
        except (IndexError, TypeError, ValueError) as e:
            log("bad signal payload: " + repr(e))

    def on_conn_closed(self, _conn: Any, remote_peer_vanished: bool, error: Any) -> None:
        if self.why is None:
            emit({"event": "error", "message": "bus connection lost"})
            self.finish("bus_lost", EXIT_BUS_LOST if self.nid is not None else EXIT_NO_DBUS)

    def send_close(self) -> None:
        if self.close_sent or self.nid is None:
            return
        self.close_sent = True
        GLib, Gio = self.GLib, self.Gio
        self.conn.call(BUS_NAME, OBJECT_PATH, IFACE, "CloseNotification",
                       GLib.Variant("(u)", (self.nid,)), None,
                       Gio.DBusCallFlags.NONE, 3000, None, self.on_close_done, None)
        # The NotificationClosed signal normally ends us; this is the backstop.
        GLib.timeout_add(CLOSE_GRACE_MS, self.on_close_grace)

    def on_close_done(self, conn: Any, result: Any, _data: Any) -> None:
        try:
            conn.call_finish(result)
        except self.GLib.Error as e:
            log("CloseNotification failed: " + str(e.message))

    def on_close_grace(self) -> bool:
        self.finish("closed")
        return False

    # -- other event sources -------------------------------------------------
    def on_signal_exit(self) -> bool:
        self.finish("signal")
        return False

    def on_max_wait(self) -> bool:
        self.finish("max_wait")
        return False

    def on_stdin(self, _fd: int, cond: int) -> bool:
        GLib = self.GLib
        try:
            chunk = os.read(0, 4096)
        except BlockingIOError:
            return True
        except OSError:
            chunk = b""
        if chunk:
            self.stdin_buf += chunk
            while b"\n" in self.stdin_buf:
                line, self.stdin_buf = self.stdin_buf.split(b"\n", 1)
                self.handle_command(line)
            if len(self.stdin_buf) > MAX_STDIN_BUFFER:
                log("stdin line too long, dropped")
                self.stdin_buf = b""
            return True
        # EOF (or HUP with nothing left to read): the daemon is gone.
        if self.stdin_buf.strip():
            self.handle_command(self.stdin_buf)
        self.finish("stdin_eof")
        return False

    def handle_command(self, line: bytes) -> None:
        try:
            msg = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            log("ignored malformed command")
            return
        if isinstance(msg, dict) and msg.get("cmd") == "close":
            self.close_wanted = True
            self.send_close()
        else:
            log("ignored unknown command")


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        import gi  # type: ignore[import-not-found]
        gi.require_version("Gio", "2.0")
        gi.require_version("GLib", "2.0")
        from gi.repository import Gio, GLib  # type: ignore[import-not-found]
    except (ImportError, ValueError) as e:
        fail("PyGObject unavailable: " + str(e), EXIT_NO_DBUS)
    return Helper(args, Gio, GLib).run()


if __name__ == "__main__":
    sys.exit(main())
