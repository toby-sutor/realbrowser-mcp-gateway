"""bgw daemon start | stop | status - the gateway daemon as a plain host process.

Loaded by cli/bgw for its "daemon" command and for a start on demand (a client
that found nothing on the port, where the operator switched that on), and for
nothing else. This module starts a program and signals a process. It never
reads a credential of the gateway and hands none on: those are files the
daemon makes for itself.

What it does:

  start   run "node daemon/src/main.js" from the checkout this script sits in,
          detached, with its output appended to <data dir>/daemon.log, and note
          the process in <data dir>/daemon.pid. Refuses when that daemon runs
          already, and when anything else listens on the port. One start at a
          time for one data directory: a second one waits for the first.
          "node" is the first one on the PATH of the process that runs this
          (a PATH entry that is not an absolute path is refused).
  stop    end the process the pid file names - after checking that it is the
          one that was started: same pid, same start time, working directory
          this checkout, and the daemon's own command line. Anything else is
          never signalled.
  status  say whether that process runs and whether the port answers.

Python 3.9 or newer is needed (the daemon is started with a umask of its own,
which subprocess.Popen takes from 3.9 on); "start" says so and does nothing
when it runs on an older one. status and stop have no such need.

Inside a Flatpak sandbox the command runs itself again on the host
(flatpak-spawn --host): process ids, /proc and node are the host's.

There is no sandbox around a daemon started this way and nothing holds its
port while it is down (tools/browser-gateway.socket does both). Whoever takes
the port meanwhile gets nothing from the gateway's own clients: the CLI and
"bgw mcp" make the listener prove itself before they send anything.

Environment: BGW_CONFIG_DIR and BGW_DATA_DIR as the daemon reads them (defaults
~/.config/browser-gateway and ~/.local/share/browser-gateway). The port is
that of BGW_URL, which cli/bgw has checked.
"""

import errno
import fcntl
import http.client
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

MIN_PYTHON = (3, 9)
PID_FILE = "daemon.pid"
LOG_FILE = "daemon.log"
MAIN = os.path.join("daemon", "src", "main.js")
# How long a started daemon gets until it answers on its port.
START_WAIT_S = 15.0
# How long a daemon gets to end after SIGTERM before it is killed.
STOP_WAIT_S = 10.0
# A log larger than this is set aside (daemon.log.1) at the next start.
LOG_ROTATE_BYTES = 10485760
# How long a start waits for another start that is under way with the same data directory.
LOCK_WAIT_S = START_WAIT_S + 10.0
# How long a start that was passed on to the host may take, from inside a sandbox.
HOST_WAIT_S = LOCK_WAIT_S + START_WAIT_S + 15.0

EXIT_OK = 0
EXIT_FAILED = 1


class Failure(Exception):
	"""A reason not to go on, in one line. kind: "port_in_use" when something listens on the port already, else "failed"."""

	def __init__(self, message, kind="failed"):
		super().__init__(message)
		self.kind = kind


def in_sandbox() -> bool:
	return os.path.isfile("/.flatpak-info")


def directories() -> tuple:
	"""The daemon's config and data directory, as the daemon itself resolves them (never XDG: a sandbox remaps it)."""
	home = os.path.expanduser("~")
	config = os.environ.get("BGW_CONFIG_DIR") or os.path.join(home, ".config", "browser-gateway")
	data = os.environ.get("BGW_DATA_DIR") or os.path.join(home, ".local", "share", "browser-gateway")
	for name, path in (("BGW_CONFIG_DIR", config), ("BGW_DATA_DIR", data)):
		if not os.path.isabs(path):
			raise Failure("%s must be an absolute path" % name)
	return os.path.normpath(config), os.path.normpath(data)


def process_info(pid: int):
	"""What /proc says about a process: its start time, working directory and command line. None: no such process."""
	try:
		with open("/proc/%d/stat" % pid, encoding="ascii", errors="replace") as f:
			stat = f.read()
		# Field 22, counted after the command name, which may hold spaces and brackets.
		start = stat[stat.rindex(")") + 2 :].split(" ")[19]
		cwd = os.readlink("/proc/%d/cwd" % pid)
		with open("/proc/%d/cmdline" % pid, "rb") as f:
			argv = [a.decode("utf-8", "replace") for a in f.read().split(b"\0") if a != b""]
	except (OSError, ValueError, IndexError):
		return None
	return {"start": start, "cwd": cwd, "argv": argv}


def read_pid_file(path: str) -> tuple:
	"""The pid file: (record, None), or (None, why not). why: "missing", "empty" (nothing in it), "damaged" (not one of ours)."""
	try:
		with open(path, encoding="utf-8") as f:
			text = f.read(4096)
	except FileNotFoundError:
		return None, "missing"
	except (OSError, ValueError):
		return None, "damaged"
	if text.strip() == "":
		return None, "empty"
	try:
		raw = json.loads(text)
	except ValueError:
		return None, "damaged"
	if not isinstance(raw, dict):
		return None, "damaged"
	pid, start, cwd, port = raw.get("pid"), raw.get("start"), raw.get("cwd"), raw.get("port")
	if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1 or not isinstance(start, str) or not isinstance(cwd, str) or not isinstance(port, int):
		return None, "damaged"
	return {"pid": pid, "start": start, "cwd": cwd, "port": port, "started_at": raw.get("started_at") if isinstance(raw.get("started_at"), str) else None}, None


def read_record(path: str):
	"""The pid file. None: there is none, or it is not one of ours."""
	return read_pid_file(path)[0]


def publish_record(pid_path: str, record: dict):
	"""Put the pid file in place whole. Raises FileExistsError when there is one already, and then changes nothing.

	The record is written to a file of its own first and given the name of the pid file with a hard link, which
	fails where that name is taken: the pid file is never there empty or half written, whatever kills this
	process, and it is never replaced by a second start. The lock on the data directory (start_lock) already
	lets one start at a time work; this is what keeps the file whole, and keeps two starts on a file system
	without such locks from both claiming it.
	"""
	tmp = "%s.%s.tmp" % (pid_path, os.urandom(4).hex())
	fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
	try:
		with os.fdopen(fd, "wb") as f:
			f.write((json.dumps(record) + "\n").encode("utf-8"))
			f.flush()
			os.fsync(f.fileno())
		os.link(tmp, pid_path)
	finally:
		try:
			os.unlink(tmp)
		except OSError:
			pass


def sweep_temporaries(data_dir: str):
	"""Remove the temporary files of a start that was killed (daemon.pid.<hex>.tmp). Called with the start lock held."""
	try:
		names = os.listdir(data_dir)
	except OSError:
		return
	for name in names:
		if name.startswith(PID_FILE + ".") and name.endswith(".tmp") and len(name) == len(PID_FILE) + 13:
			try:
				os.unlink(os.path.join(data_dir, name))
			except OSError:
				pass


def is_ours(record: dict, checkout: str) -> bool:
	"""Is the process the pid file names still the daemon that was started from this checkout?"""
	info = process_info(record["pid"])
	if info is None or info["start"] != record["start"]:
		return False
	if record["cwd"] != checkout or info["cwd"] != checkout:
		return False
	return any(arg == MAIN or arg.endswith(os.sep + MAIN) for arg in info["argv"])


def port_listens(port: int) -> bool:
	"""Does anything accept connections on the port? Nothing is sent."""
	try:
		with socket.create_connection(("127.0.0.1", port), timeout=1.0):
			return True
	except OSError:
		return False


def answers_as_gateway(port: int) -> bool:
	"""GET /healthz: open, no credential involved."""
	conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1.0)
	try:
		conn.request("GET", "/healthz", headers={"Host": "127.0.0.1:%d" % port, "Accept": "application/json"})
		resp = conn.getresponse()
		body = json.loads(resp.read(4096).decode("utf-8"))
		return resp.status == 200 and isinstance(body, dict) and body.get("name") == "browser-gateway"
	except (OSError, ValueError, http.client.HTTPException):
		return False
	finally:
		conn.close()


def log_tail(path: str, offset: int) -> str:
	"""The last lines the daemon wrote since "offset", for saying why a start failed."""
	try:
		with open(path, "rb") as f:
			f.seek(offset)
			text = f.read(8192).decode("utf-8", "replace")
	except OSError:
		return ""
	lines = [line for line in text.splitlines() if line.strip() != ""]
	return " | ".join("".join(c if " " <= c < "\x7f" else "?" for c in line)[:300] for line in lines[-3:])


def start_lock(data_dir: str):
	"""Take the lock that lets one start at a time work on a data directory. Returns its descriptor, or None.

	Two starts at the same moment - two clients that found the daemon down - would
	otherwise each take the other's unfinished pid file for a stale one. The
	lock is on the directory itself, so it leaves no file behind and ends with
	the process that holds it. A start that finds it taken waits: when it gets
	its turn the daemon of the first one runs, and it says so.
	"""
	try:
		fd = os.open(data_dir, os.O_RDONLY | os.O_DIRECTORY)
	except OSError:
		return None
	deadline = time.monotonic() + LOCK_WAIT_S
	while True:
		try:
			fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
			return fd
		except OSError as e:
			if e.errno not in (errno.EAGAIN, errno.EACCES):
				# A file system without such locks: go on as before there was one.
				os.close(fd)
				return None
			if time.monotonic() >= deadline:
				os.close(fd)
				raise Failure("another start is under way with %s and did not end within %d s" % (data_dir, LOCK_WAIT_S)) from None
			time.sleep(0.05)


def start(port: int, checkout: str, config_dir: str, data_dir: str) -> dict:
	if sys.version_info < MIN_PYTHON:
		raise Failure("bgw daemon start needs Python %d.%d or newer; this is Python %d.%d - nothing was started" % (MIN_PYTHON + sys.version_info[:2]))
	if not os.path.isfile(os.path.join(checkout, MAIN)):
		raise Failure("%s is not in %s: bgw daemon runs the daemon of the checkout this script sits in" % (MAIN, checkout))
	node = shutil.which("node")
	if node is None:
		raise Failure("node is not on the PATH of this host")
	if not os.path.isabs(node):
		raise Failure("the first node on the PATH is %s, found through a PATH entry that is not an absolute path - fix the PATH" % node)
	for path in (config_dir, data_dir):
		os.makedirs(path, mode=0o700, exist_ok=True)
	lock = start_lock(data_dir)
	try:
		if lock is not None:
			sweep_temporaries(data_dir)
		return start_locked(port, checkout, node, config_dir, data_dir)
	finally:
		if lock is not None:
			os.close(lock)


def start_locked(port: int, checkout: str, node: str, config_dir: str, data_dir: str) -> dict:
	pid_path = os.path.join(data_dir, PID_FILE)
	log_path = os.path.join(data_dir, LOG_FILE)

	record = read_record(pid_path)
	if record is not None and is_ours(record, checkout):
		return {"started": False, "running": True, "pid": record["pid"], "port": record["port"], "log": log_path, "note": "the daemon is already running - not starting a second one"}
	if record is not None and process_info(record["pid"]) is not None and process_info(record["pid"])["start"] == record["start"]:
		# Alive, and not from here: another checkout shares these directories.
		raise Failure("a daemon started from %s runs with these directories (pid %d) - stop it from there first" % (record["cwd"], record["pid"]))
	if port_listens(port):
		raise Failure("127.0.0.1:%d is already in use (a daemon started another way, or another program) - not starting" % port, kind="port_in_use")
	if os.path.lexists(pid_path):
		# What it named is gone, or it never named anything.
		os.unlink(pid_path)

	try:
		if os.path.getsize(log_path) > LOG_ROTATE_BYTES:
			os.replace(log_path, log_path + ".1")
	except OSError:
		pass
	child = None
	published = False
	try:
		log = os.open(log_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
		try:
			offset = os.fstat(log).st_size
			env = dict(os.environ)
			# What a service manager hands to its own child is not for this one.
			for name in ("LISTEN_FDS", "LISTEN_PID", "LISTEN_FDNAMES", "BGW_URL"):
				env.pop(name, None)
			env["BGW_PORT"] = str(port)
			env["BGW_CONFIG_DIR"] = config_dir
			env["BGW_DATA_DIR"] = data_dir
			# A session of its own: it outlives this command and the terminal it was typed in.
			child = subprocess.Popen([node, MAIN], cwd=checkout, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True, umask=0o077)
		finally:
			os.close(log)
		# From here to the pid file a polite kill (Ctrl-C, SIGTERM, a closed terminal) waits: it would leave a
		# daemon that nothing names. The child was started before this, so it does not inherit the block.
		held = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM, signal.SIGHUP})
		try:
			info = None
			deadline = time.monotonic() + 2.0
			while child.poll() is None and time.monotonic() < deadline:
				seen = process_info(child.pid)
				# Between fork and exec it would still look like this command.
				if seen is not None and any(arg == MAIN for arg in seen["argv"]):
					info = seen
					break
				time.sleep(0.02)
			if info is not None:
				record = {"pid": child.pid, "start": info["start"], "cwd": checkout, "port": port, "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
				try:
					publish_record(pid_path, record)
				except FileExistsError:
					raise Failure("another start is under way (%s exists)" % pid_path) from None
				published = True
		finally:
			signal.pthread_sigmask(signal.SIG_SETMASK, held)

		deadline = time.monotonic() + START_WAIT_S
		while time.monotonic() < deadline:
			code = child.poll()
			if code is not None:
				why = log_tail(log_path, offset)
				raise Failure("the daemon ended at once (exit code %d)%s" % (code, ": " + why if why else ""))
			if info is not None and answers_as_gateway(port):
				# A daemon that is ended from elsewhere (bgw daemon stop, in another process) would stay a zombie
				# for as long as this process lives, a long-running "bgw mcp" for one: something waits for it.
				threading.Thread(target=child.wait, daemon=True).start()
				return {"started": True, "running": True, "pid": child.pid, "port": port, "log": log_path, "note": "started"}
			time.sleep(0.1)
		raise Failure("the daemon did not answer on 127.0.0.1:%d within %d s - it was stopped again (see %s)" % (port, START_WAIT_S, log_path))
	except BaseException:
		# Nothing half-started is left behind: the child is this command's own, by its handle.
		if child is not None and child.poll() is None:
			child.terminate()
			try:
				child.wait(STOP_WAIT_S)
			except subprocess.TimeoutExpired:
				child.kill()
				child.wait(5)
		if published:
			try:
				os.unlink(pid_path)
			except OSError:
				pass
		raise


def stop(checkout: str, data_dir: str, port: int) -> dict:
	pid_path = os.path.join(data_dir, PID_FILE)
	record, problem = read_pid_file(pid_path)
	if record is None:
		if problem == "empty":
			# Nothing to signal: a start was killed before it wrote the record. The file says nothing and is in the way.
			os.unlink(pid_path)
			if answers_as_gateway(port):
				raise Failure("%s was empty (a start was cut short) and is removed, but a gateway daemon answers on 127.0.0.1:%d that no pid file names - nothing was signalled; end that process by hand (its command line is node %s)" % (pid_path, port, MAIN))
			return {"stopped": False, "running": False, "note": "not running (the pid file was empty - a start was cut short; the file was removed)"}
		if problem == "damaged":
			raise Failure("%s is not a pid file of bgw daemon - nothing was signalled (if no daemon runs, remove the file; bgw daemon status says whether one answers)" % pid_path)
		return {"stopped": False, "running": False, "note": "not running (no pid file)"}
	info = process_info(record["pid"])
	if info is None or info["start"] != record["start"]:
		# The process is gone; its number may belong to something else by now.
		os.unlink(pid_path)
		return {"stopped": False, "running": False, "note": "not running (the process of the pid file is gone; the stale file was removed)"}
	if not is_ours(record, checkout):
		raise Failure("process %d was not started from this checkout (pid file: %s, process: %s) - nothing was signalled" % (record["pid"], record["cwd"], info["cwd"]))
	pid = record["pid"]

	def gone() -> bool:
		now = process_info(pid)
		return now is None or now["start"] != record["start"]

	os.kill(pid, signal.SIGTERM)
	deadline = time.monotonic() + STOP_WAIT_S
	while not gone() and time.monotonic() < deadline:
		time.sleep(0.05)
	killed = False
	if not gone() and is_ours(record, checkout):
		os.kill(pid, signal.SIGKILL)
		killed = True
		deadline = time.monotonic() + 3.0
		while not gone() and time.monotonic() < deadline:
			time.sleep(0.05)
	if not gone():
		raise Failure("process %d did not end" % pid)
	try:
		os.unlink(pid_path)
	except OSError:
		pass
	return {"stopped": True, "running": False, "pid": pid, "note": "stopped (it did not end by itself and was killed)" if killed else "stopped"}


def status(port: int, checkout: str, data_dir: str) -> dict:
	pid_path = os.path.join(data_dir, PID_FILE)
	record, problem = read_pid_file(pid_path)
	running = record is not None and is_ours(record, checkout)
	out = {"running": running, "port": record["port"] if running and record is not None else port, "log": os.path.join(data_dir, LOG_FILE)}
	if running and record is not None:
		out["pid"] = record["pid"]
		out["started_at"] = record["started_at"]
		out["answers"] = answers_as_gateway(record["port"])
		out["note"] = "running" if out["answers"] else "running, but 127.0.0.1:%d does not answer" % record["port"]
	else:
		out["answers"] = answers_as_gateway(port)
		out["note"] = "not started by bgw daemon from this checkout, but a gateway daemon answers on 127.0.0.1:%d" % port if out["answers"] else "not running"
		if problem == "empty":
			out["note"] += " (the pid file %s is empty: a start was cut short; bgw daemon stop removes it)" % pid_path
		elif problem == "damaged":
			out["note"] += " (the pid file %s is not one of bgw daemon: remove it if no daemon runs)" % pid_path
	return out


def host_argv(action: str, port: int, script: str, json_output: bool) -> list:
	"""This very command, to be run on the host from inside a Flatpak sandbox. Only what the host needs to know goes along."""
	argv = ["flatpak-spawn", "--host", "--env=BGW_URL=http://127.0.0.1:%d" % port]
	for name in ("BGW_CONFIG_DIR", "BGW_DATA_DIR"):
		value = os.environ.get(name)
		if value:
			argv.append("--env=%s=%s" % (name, value))
	argv += ["python3", script, "daemon", action]
	if json_output:
		argv.append("--json")
	return argv


def on_host(action: str, port: int, script: str, json_output: bool) -> int:
	"""Run this very command on the host, from inside a Flatpak sandbox."""
	try:
		return subprocess.run(host_argv(action, port, script, json_output), stdin=subprocess.DEVNULL, check=False).returncode
	except OSError:
		raise Failure("flatpak-spawn is needed to reach the host from inside this sandbox") from None


def start_on_host(port: int, script: str) -> dict:
	"""bgw daemon start --json on the host, from inside a Flatpak sandbox: what it answered, as start() would have returned or raised it."""
	try:
		done = subprocess.run(host_argv("start", port, script, True), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, check=False, timeout=HOST_WAIT_S)
	except OSError:
		raise Failure("flatpak-spawn is needed to reach the host from inside this sandbox") from None
	except subprocess.TimeoutExpired:
		raise Failure("the start on the host did not end within %d s" % HOST_WAIT_S) from None
	try:
		answer = json.loads(done.stdout.decode("utf-8"))
	except ValueError:
		answer = None
	if not isinstance(answer, dict) or not isinstance(answer.get("ok"), bool):
		raise Failure("the start on the host gave no answer (exit code %d)" % done.returncode)
	if answer["ok"] is not True:
		raise Failure(str(answer.get("error")), kind="port_in_use" if answer.get("kind") == "port_in_use" else "failed")
	return answer


def start_on_demand(port: int, script: str) -> dict:
	"""For a client that found nothing listening on the port: start the daemon exactly as "start" does, and print nothing.

	Returns {"ok": True, "started": ..., "note": ..., and "pid" and "log" where known}. started is False when the
	daemon of this checkout runs already (another client was first) and when something took the port meanwhile: the
	client then goes to the port, where whatever listens has to prove itself before it is sent anything.
	Returns {"ok": False, "error": one line} when the daemon could not be started.
	"""
	try:
		if in_sandbox():
			result = start_on_host(port, script)
		else:
			if not os.path.isdir("/proc/self"):
				raise Failure("bgw daemon needs /proc (Linux)")
			checkout = os.path.dirname(os.path.dirname(os.path.realpath(script)))
			config_dir, data_dir = directories()
			result = start(port, checkout, config_dir, data_dir)
	except Failure as e:
		if e.kind == "port_in_use":
			return {"ok": True, "started": False, "note": str(e)}
		return {"ok": False, "error": str(e)}
	except OSError as e:
		# A directory that cannot be made, a log that cannot be written.
		return {"ok": False, "error": "%s (%s)" % (e.strerror or e.__class__.__name__, e.filename or "no path")}
	out = {"ok": True, "started": result.get("started") is True, "note": str(result.get("note"))}
	if isinstance(result.get("pid"), int):
		out["pid"] = result["pid"]
	if isinstance(result.get("log"), str):
		out["log"] = result["log"]
	return out


def run(action: str, port: int, script: str, json_output: bool = False) -> int:
	"""Entry point for cli/bgw. Returns the exit code: 0 done (or running, for status), 1 otherwise."""
	try:
		if in_sandbox():
			return on_host(action, port, script, json_output)
		if not os.path.isdir("/proc/self"):
			raise Failure("bgw daemon needs /proc (Linux)")
		checkout = os.path.dirname(os.path.dirname(os.path.realpath(script)))
		config_dir, data_dir = directories()
		if action == "start":
			result = start(port, checkout, config_dir, data_dir)
			ok = True
		elif action == "stop":
			result = stop(checkout, data_dir, port)
			ok = True
		else:
			result = status(port, checkout, data_dir)
			ok = result["running"]
	except Failure as e:
		if json_output:
			print(json.dumps({"ok": False, "error": str(e), "kind": e.kind}, indent=2, sort_keys=True))
		else:
			print("bgw daemon: %s" % e, file=sys.stderr)
		return EXIT_FAILED
	if json_output:
		print(json.dumps(dict(result, ok=ok), indent=2, sort_keys=True))
	else:
		parts = [result["note"]]
		if "pid" in result:
			parts.append("pid %d" % result["pid"])
		if result.get("running"):
			parts.append("127.0.0.1:%d" % result["port"])
			parts.append("log %s" % result["log"])
		print("bgw daemon: " + ", ".join(parts))
	return EXIT_OK if ok else EXIT_FAILED
