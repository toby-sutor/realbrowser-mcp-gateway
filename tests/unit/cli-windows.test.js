// The Windows ways of cli/bgw and cli/bgw_daemonctl.py, tried wherever the tests run: both are loaded as
// modules and told that they run on Windows (their WINDOWS flag), and what only Windows has is put in by hand
// (a process_info, a Popen that starts nothing). What needs Windows itself - kernel32 through ctypes, msvcrt
// locks - is tried at the end, on Windows only.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";
import { SYSTEM_ENV, startMcp } from "../helpers/mcp-stdio.js";
import { closedPort } from "../helpers/squatter.js";

const REPO = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = path.join(REPO, "cli", "bgw");
const DAEMONCTL = path.join(REPO, "cli", "bgw_daemonctl.py");
const PYTHON = process.env.PYTHON || "python3";
const POSIX_ONLY = process.platform === "win32" ? "symlinks, FIFOs and POSIX paths: on Windows the real branch is tried below" : false;
const WINDOWS_ONLY = process.platform === "win32" ? false : "kernel32 and msvcrt are on Windows only";

/** @type {string} */
let tmp;
before(() => {
	tmp = makeTempDir("windows");
});
after(() => removeTempDir(tmp));

/**
 * Run Python with cli/bgw loaded as `bgw` and the controller as `ctl`. Prints of the code come back as JSON lines.
 * @param {string} code
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number, out: any[], stderr: string }>}
 */
function py(code, env = {}) {
	const prelude = [
		"import importlib.machinery, importlib.util, json, os, sys",
		"sys.dont_write_bytecode = True",
		`loader = importlib.machinery.SourceFileLoader("bgw", ${JSON.stringify(CLI)})`,
		"bgw = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))",
		"loader.exec_module(bgw)",
		`spec = importlib.util.spec_from_file_location("ctl", ${JSON.stringify(DAEMONCTL)})`,
		"ctl = importlib.util.module_from_spec(spec)",
		"spec.loader.exec_module(ctl)",
		"def say(value):",
		"    print(json.dumps(value), flush=True)",
		"",
	].join("\n");
	return new Promise((resolve) => {
		execFile(PYTHON, ["-B", "-c", prelude + code], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...SYSTEM_ENV, ...env }, timeout: 30000 }, (err, stdout, stderr) => {
			const out = stdout
				.split("\n")
				.filter((l) => l !== "")
				.map((l) => JSON.parse(l));
			resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, out, stderr });
		});
	});
}

const LOCAL = "C:\\Users\\op\\AppData\\Local";
/** The daemon says the same (daemon/src/config.js). @param {string} variable */
const NOT_ABSOLUTE = (variable) => `LOCALAPPDATA is not set to an absolute path: set it, or ${variable}`;

test("Windows defaults: below %LOCALAPPDATA%\\browser-gateway, the same in cli/bgw and the controller; overrides need no LOCALAPPDATA; one that is not absolute is refused where it is needed", async () => {
	const r = await py(
		`
bgw.WINDOWS = ctl.WINDOWS = True
def each():
    row = []
    for f in (lambda: bgw.token_path("client"), lambda: bgw.token_path("admin"), bgw.download_dir, ctl.directories):
        try:
            got = f()
            row.append(["ok", list(got) if isinstance(got, tuple) else got])
        except (bgw.CliError, ctl.Failure) as e:
            row.append([getattr(e, "kind", "failure"), str(e)])
    row.append(bgw.on_demand())
    return row
os.environ["LOCALAPPDATA"] = ${JSON.stringify(LOCAL)}
say(each())
os.environ["LOCALAPPDATA"] = "C:/Users/op/AppData/Local/"
say(each())
for bad in (None, "", "relative\\\\dir", "\\\\rooted", "C:rel", "C:", "\\\\\\\\\\\\x", "\\\\\\\\server"):
    if bad is None:
        os.environ.pop("LOCALAPPDATA", None)
    else:
        os.environ["LOCALAPPDATA"] = bad
    say(each())
os.environ["BGW_CONFIG_DIR"] = "D:\\\\gw\\\\conf"
say(each()[3])
os.environ.update({"BGW_TOKEN_FILE": "D:\\\\gw\\\\c.token", "BGW_ADMIN_TOKEN_FILE": "D:\\\\gw\\\\a.token", "BGW_DOWNLOAD_DIR": "D:\\\\gw\\\\out", "BGW_CONFIG_DIR": "D:\\\\gw\\\\conf", "BGW_DATA_DIR": "D:\\\\gw\\\\data"})
say(each())
cases = ["C:\\\\x", "c:/x", "\\\\\\\\server\\\\share", "//server/share", "\\\\\\\\server", "//server/", "\\\\\\\\?\\\\C:\\\\x", "\\\\x", "/x", "C:", "C:x", "x", "", "\\\\\\\\\\\\x", "1:\\\\x", "\\u00e9:\\\\x"]
say([[c, bgw.windows_absolute(c), ctl.windows_absolute(c)] for c in cases])
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	const [good, slashes, unset, empty, relative, rooted, driveRelative, driveOnly, threeSlashes, serverOnly, dataOnly, overridden, absolute] = r.out;
	const config = `${LOCAL}\\browser-gateway\\config`;
	const data = `${LOCAL}\\browser-gateway\\data`;
	const expected = [["ok", `${config}\\client.token`], ["ok", `${config}\\admin.token`], ["ok", `${data}\\exports`], ["ok", [config, data]], false];
	assert.deepEqual(good, expected);
	assert.deepEqual(slashes, expected, "written with forward slashes, the same places");
	const refused = [
		["token", NOT_ABSOLUTE("BGW_TOKEN_FILE")],
		["token", NOT_ABSOLUTE("BGW_ADMIN_TOKEN_FILE")],
		["other", NOT_ABSOLUTE("BGW_DOWNLOAD_DIR")],
		["failed", NOT_ABSOLUTE("BGW_CONFIG_DIR")],
		false,
	];
	for (const [label, row] of Object.entries({ unset, empty, relative, rooted, driveRelative, driveOnly, threeSlashes, serverOnly })) assert.deepEqual(row, refused, label);
	assert.deepEqual(dataOnly, ["failed", NOT_ABSOLUTE("BGW_DATA_DIR")], "the controller names the one that is missing");
	assert.deepEqual(overridden, [["ok", "D:\\gw\\c.token"], ["ok", "D:\\gw\\a.token"], ["ok", "D:\\gw\\out"], ["ok", ["D:\\gw\\conf", "D:\\gw\\data"]], false], "the variables alone, without LOCALAPPDATA");
	for (const [given, a, b] of absolute) assert.equal(a, b, `one rule in both files: ${given}`);
	assert.deepEqual(
		absolute.filter((/** @type {any[]} */ c) => c[1]).map((/** @type {any[]} */ c) => c[0]),
		["C:\\x", "c:/x", "\\\\server\\share", "//server/share", "\\\\?\\C:\\x"],
	);
});

test("off Windows the defaults are what they were: the literal home paths", { skip: POSIX_ONLY }, async () => {
	const home = path.join(tmp, "home");
	const r = await py(`say([bgw.WINDOWS, ctl.WINDOWS, bgw.token_path("client"), bgw.token_path("admin"), bgw.download_dir(), list(ctl.directories())])`, { HOME: home, LOCALAPPDATA: "C:\\elsewhere" });
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	assert.deepEqual(r.out[0], [
		false,
		false,
		path.join(home, ".config", "browser-gateway", "client.token"),
		path.join(home, ".config", "browser-gateway", "admin.token"),
		path.join(home, ".local", "share", "browser-gateway", "exports"),
		[path.join(home, ".config", "browser-gateway"), path.join(home, ".local", "share", "browser-gateway")],
	]);
});

test("bgw mcp-config on Windows: this Python, BGW_ON_DEMAND=1 in the command and the entry, quoted as Windows takes a command line apart", async () => {
	const python = "C:\\Program Files\\Python313\\python.exe";
	const script = "C:\\Users\\op\\src\\realbrowser mcp\\cli\\bgw";
	const r = await py(
		`
import contextlib, io
bgw.WINDOWS = True
sys.executable = ${JSON.stringify(python)}
bgw.script_path = lambda: ${JSON.stringify(script)}
for args in (["mcp-config", "--json"], ["mcp-config"]):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = bgw.main(args)
    say([code, out.getvalue()])
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	const command = `claude mcp add --scope user -e BGW_ON_DEMAND=1 browser-gateway -- "${python}" "${script}" mcp`;
	const entry = { type: "stdio", command: python, args: [script, "mcp"], env: { BGW_ON_DEMAND: "1" } };
	const [[code, json], [textCode, text]] = r.out;
	assert.equal(code, 0);
	assert.deepEqual(JSON.parse(json), { name: "browser-gateway", command, config: entry });
	assert.equal(textCode, 0);
	assert.ok(text.startsWith("Register the gateway in Claude Code (user scope), in a command prompt:\n\n"), text);
	assert.ok(text.includes(`\n  ${command}\n`), text);
	assert.ok(text.includes(`\n  ${JSON.stringify(entry).replace(/":/g, '": ').replace(/,"/g, ', "')}\n`), text);
	assert.ok(!text.includes("Note:"), text);
});

test("the command line for cmd.exe: what cmd.exe acts on is quoted, the C runtime gets every argument back, a % is pointed to the JSON entry", async () => {
	const r = await py(
		`
import contextlib, io, random, subprocess
def crt_split(line):
    # How the Microsoft C runtime takes a command line apart into arguments.
    args, cur, quoted, have, i = [], [], False, False, 0
    while i < len(line):
        c = line[i]
        if c == "\\\\":
            n = 0
            while i < len(line) and line[i] == "\\\\":
                n += 1
                i += 1
            if i < len(line) and line[i] == '"':
                cur.append("\\\\" * (n // 2))
                if n % 2:
                    cur.append('"')
                    i += 1
            else:
                cur.append("\\\\" * n)
            have = True
            continue
        if c == '"':
            quoted, have, i = not quoted, True, i + 1
            continue
        if c in " \\t" and not quoted:
            if have:
                args.append("".join(cur))
                cur, have = [], False
            i += 1
            continue
        cur.append(c)
        have, i = True, i + 1
    if have:
        args.append("".join(cur))
    return args
def bare_special(line):
    # What cmd.exe sees outside quotes: it knows no backslash, every quote opens or closes.
    quoted = False
    for c in line:
        if c == '"':
            quoted = not quoted
        elif not quoted and c in bgw.CMD_SPECIAL:
            return True
    return False
rng = random.Random(7)
wrong = {"core": [], "parsed": [], "bare": []}
compared = 0
for _ in range(3000):
    # Where the standard library quotes an argument anyway, or it holds nothing cmd.exe acts on: its rules exactly.
    argv = ["".join(rng.choice('ab \\t"\\\\') for _ in range(rng.randrange(0, 8))) for _ in range(rng.randrange(1, 4))]
    core = all(a == "" or " " in a or "\\t" in a or not any(c in a for c in bgw.CMD_SPECIAL) for a in argv)
    compared += core
    if core and bgw.windows_command_line(argv) != subprocess.list2cmdline(argv):
        wrong["core"].append(argv)
    # With it: the C runtime gets the arguments back, and cmd.exe sees none of it outside quotes (no quote in them).
    argv = ["".join(rng.choice('ab \\t\\\\&^%!()|<>;"') for _ in range(rng.randrange(0, 8))) for _ in range(rng.randrange(1, 4))]
    line = bgw.windows_command_line(argv)
    if crt_split(line) != argv:
        wrong["parsed"].append(argv)
    if not any('"' in a for a in argv) and bare_special(line):
        wrong["bare"].append(argv)
say([{k: v[:5] for k, v in wrong.items()}, compared > 1000])
say([bgw.windows_command_line([a]) for a in ("plain", "", "C:\\\\Program Files\\\\x", "C:\\\\a b\\\\", "a&b", "100%", "x;y", "(x)", "a^b", "a|b", "<x>", "hey!", 'a"b')])
bgw.WINDOWS = True
sys.executable = "C:\\\\Python313\\\\python.exe"
bgw.script_path = lambda: "C:\\\\Users\\\\op\\\\100%\\\\cli\\\\bgw"
out = io.StringIO()
with contextlib.redirect_stdout(out):
    code = bgw.main(["mcp-config"])
say([code, out.getvalue()])
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	const [[wrong, enough], cases, [code, text]] = r.out;
	assert.deepEqual([wrong, enough], [{ core: [], parsed: [], bare: [] }, true]);
	assert.deepEqual(cases, ["plain", '""', '"C:\\Program Files\\x"', '"C:\\a b\\\\"', '"a&b"', '"100%"', '"x;y"', '"(x)"', '"a^b"', '"a|b"', '"<x>"', '"hey!"', '"a\\"b"']);
	assert.equal(code, 0);
	assert.ok(text.includes('"C:\\Users\\op\\100%\\cli\\bgw" mcp\n'), text);
	assert.ok(text.includes("\nNote: a path above holds a %, which cmd.exe expands even between quotes: use the JSON entry below instead.\n"), text);
});

test("a token file the Windows way: no owner or mode bits, but a link, a junction stand-in, a directory or a FIFO is refused, and the read is bounded", { skip: POSIX_ONLY }, async () => {
	const dir = fs.mkdtempSync(path.join(tmp, "token-"));
	const token = "A".repeat(43);
	const loose = path.join(dir, "loose.token");
	fs.writeFileSync(loose, token + "\n", { mode: 0o644 });
	fs.chmodSync(loose, 0o644);
	fs.symlinkSync(loose, path.join(dir, "link.token"));
	fs.symlinkSync(path.join(dir, "nowhere"), path.join(dir, "dangling.token"));
	fs.mkdirSync(path.join(dir, "dir.token"));
	fs.writeFileSync(path.join(dir, "big.token"), "A".repeat(600));
	execFileSync("mkfifo", [path.join(dir, "fifo.token")]);
	const r = await py(
		`
import time
bgw.WINDOWS = True
# POSIX paths stand in for drive paths here.
bgw.windows_absolute = os.path.isabs
for name in ("loose", "link", "dangling", "dir", "fifo", "big", "missing"):
    os.environ["BGW_TOKEN_FILE"] = os.path.join(${JSON.stringify(dir)}, name + ".token")
    started = time.monotonic()
    try:
        say([name, "ok", bgw.read_token("client") == ${JSON.stringify(token)}])
    except bgw.CliError as e:
        say([name, e.kind, str(e).replace(${JSON.stringify(dir + path.sep)}, "")])
    assert time.monotonic() - started < 5
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	assert.deepEqual(r.out, [
		["loose", "ok", true],
		["link", "token", "cannot read token file link.token: it is a link, and a token file must be a plain file"],
		["dangling", "token", "cannot read token file dangling.token: it is a link, and a token file must be a plain file"],
		["dir", "token", "cannot read token file dir.token: it is not a plain file"],
		["fifo", "token", "cannot read token file fifo.token: it is not a plain file"],
		["big", "token", "token file big.token is empty or damaged"],
		["missing", "token", "token file not found: missing.token (start the daemon once to create it)"],
	]);
});

test("the export directory by its path (Windows has no descriptor of a directory): bytes exact, never over anything, same content found, full directory refused, leftovers swept", async () => {
	const dir = fs.mkdtempSync(path.join(tmp, "export-"));
	const links = process.platform !== "win32";
	const r = await py(
		`
import hashlib, time
bgw.WINDOWS = True
FID = "fl_" + "0" * 26
base = ${JSON.stringify(dir)}
d = os.path.join(base, "exports")
os.environ["BGW_DOWNLOAD_DIR"] = d
where = bgw.open_download_dir(d, by_path=True)
say(where == d and os.path.isdir(d))
def fetch_of(content, kind="text/plain"):
    def fetch(write, begin):
        info = {"name": "x", "type": kind, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        begin(info)
        for i in range(0, len(content), 3):
            write(content[i:i + 3])
        return info
    return fetch
name_of = lambda info: bgw.export_name(FID, info["type"])
data = b"line one\\r\\nline two\\n\\x00\\xff\\x1a end"
say(bgw.save_download(where, fetch_of(data), name_of)[0])
say(open(os.path.join(d, FID + ".txt"), "rb").read() == data)
say(bgw.save_download(where, fetch_of(data), name_of)[0])
say(bgw.save_download(where, fetch_of(b"other"), name_of)[0])
say(open(os.path.join(d, FID + ".txt"), "rb").read() == data)
try:
    bgw.save_download(where, fetch_of(b"x" * 100, "application/pdf"), name_of, limit=10)
except bgw.NoRoom as e:
    say(["full", str(e).startswith("it holds 0 MiB and this file is 1 MiB, the limit is 0 MiB")])
if ${links ? "True" : "False"}:
    victim = os.path.join(base, "victim")
    open(victim, "wb").write(b"keep")
    os.symlink(victim, os.path.join(d, FID + ".pdf"))
    say(bgw.save_download(where, fetch_of(b"pdf bytes", "application/pdf"), name_of)[0])
    say(open(victim, "rb").read() == b"keep")
    os.symlink(d, os.path.join(base, "linked"))
    for bad in ("linked", "victim"):
        try:
            bgw.open_download_dir(os.path.join(base, bad), by_path=True)
            say("used")
        except bgw.CliError as e:
            say(str(e).replace(base + os.sep, ""))
# A part file a killed export left: swept when a day old, kept when young.
old = os.path.join(d, ".bgw-part-" + "a" * 16)
young = os.path.join(d, ".bgw-part-" + "b" * 16)
for p in (old, young):
    open(p, "wb").write(b"half")
os.utime(old, (time.time() - 90000, time.time() - 90000))
bgw.close_download_dir(bgw.open_download_dir(d, by_path=True))
say(sorted(n for n in os.listdir(d) if n.startswith(".")))
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	const FID = "fl_" + "0".repeat(26);
	const expected = [true, `${FID}.txt`, true, `${FID}.txt`, `${FID}-2.txt`, true, ["full", true]];
	if (links) {
		expected.push(`${FID}-2.pdf`, true);
		expected.push("the export directory linked cannot be used (it is a link or not a directory): it must be a real directory, not a link");
		expected.push("the export directory victim cannot be used (it is a link or not a directory): it must be a real directory, not a link");
	}
	expected.push([".bgw-part-" + "b".repeat(16)]);
	assert.deepEqual(r.out, expected);
});

test("the controller on Windows: a pid record names the image, is_ours wants pid, creation time, image and checkout, and stop is one hard stop, a wait and a look at the port", async () => {
	const dir = fs.mkdtempSync(path.join(tmp, "ctl-"));
	const r = await py(
		`
import signal
ctl.WINDOWS = True
procs = {}
ctl.process_info = lambda pid: procs.get(pid)
pid_path = os.path.join(${JSON.stringify(dir)}, "daemon.pid")
checkout = "C:\\\\src\\\\Gateway"
linux = {"pid": 4242, "start": "133700000000000000", "cwd": checkout, "port": 1, "started_at": "2026-10-20T00:00:00Z"}
open(pid_path, "w").write(json.dumps(linux))
say(list(ctl.read_pid_file(pid_path)))
record = dict(linux, image="C:\\\\Program Files\\\\nodejs\\\\node.exe")
open(pid_path, "w").write(json.dumps(record))
read, why = ctl.read_pid_file(pid_path)
say([read == record, why])
procs[4242] = {"start": record["start"], "image": "c:/program files/NODEJS/node.exe"}
rows = [ctl.is_ours(read, checkout), ctl.is_ours(read, "c:/SRC/gateway")]
procs[4242] = {"start": "1", "image": record["image"]}
rows.append(ctl.is_ours(read, checkout))
procs[4242] = {"start": record["start"], "image": "C:\\\\Windows\\\\System32\\\\notepad.exe"}
rows.append(ctl.is_ours(read, checkout))
procs[4242] = {"start": record["start"], "image": record["image"]}
rows.append(ctl.is_ours(read, "C:\\\\src\\\\other"))
rows.append(ctl.is_ours(dict(read, cwd="C:\\\\src\\\\other"), checkout))
rows.append(ctl.is_ours({k: v for k, v in read.items() if k != "image"}, checkout))
say(rows)
def never(*_a):
    raise AssertionError("no os.kill on Windows")
os.kill = never
kills = []
answers = []
ctl.answers_as_gateway = lambda port: answers.pop(0) if answers else False
def end(rec, wait_s):
    kills.append([rec["pid"], wait_s])
    procs.pop(rec["pid"], None)
    return True
ctl.windows_end = end
say(ctl.stop(checkout, ${JSON.stringify(dir)}, 1))
say([kills, os.path.exists(pid_path)])
# One that does not go: one stop, and it says so.
open(pid_path, "w").write(json.dumps(record))
procs[4242] = {"start": record["start"], "image": record["image"]}
kills.clear()
ctl.windows_end = lambda rec, wait_s: kills.append([rec["pid"], wait_s]) and False
try:
    ctl.stop(checkout, ${JSON.stringify(dir)}, 1)
except ctl.Failure as e:
    say(str(e))
say([kills, os.path.exists(pid_path)])
# It ended, but the port still answers as the gateway: a launcher (Volta) whose real node.exe lives on.
ctl.windows_end = end
ctl.SHIM_WAIT_S = 0.3
answers.extend([True] * 1000)
try:
    ctl.stop(checkout, ${JSON.stringify(dir)}, 1)
except ctl.Failure as e:
    say(str(e))
say(os.path.exists(pid_path))
# It answers a moment longer, then no more: stopped.
answers.clear()
answers.extend([True, True])
open(pid_path, "w").write(json.dumps(record))
procs[4242] = {"start": record["start"], "image": record["image"]}
say(ctl.stop(checkout, ${JSON.stringify(dir)}, 1))
# Another process in that place: nothing is ended.
open(pid_path, "w").write(json.dumps(record))
procs[4242] = {"start": record["start"], "image": "C:\\\\x\\\\other.exe"}
kills.clear()
try:
    ctl.stop(checkout, ${JSON.stringify(dir)}, 1)
except ctl.Failure as e:
    say(str(e))
say([kills, ctl.in_sandbox()])
ctl.needs_proc()
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	assert.deepEqual(r.out, [
		[null, "damaged"],
		[true, null],
		[true, true, false, false, false, false, false],
		{ stopped: true, running: false, pid: 4242, note: "stopped" },
		[[[4242, 10]], false],
		"process 4242 did not end",
		[[[4242, 10]], true],
		"process 4242 ended, but a gateway daemon still answers on 127.0.0.1:1 - the node.exe on the PATH may be a launcher (Volta and the like) that started the real one; end that process by hand, and put the real node.exe first on the PATH",
		false,
		{ stopped: true, running: false, pid: 4242, note: "stopped" },
		"process 4242 is not the daemon this checkout started (pid file: C:\\src\\Gateway, image C:\\Program Files\\nodejs\\node.exe; process: image C:\\x\\other.exe) - nothing was ended",
		[[], false],
	]);
});

test("a start on Windows: the first node.exe of a PATH entry (never the current directory, never node.cmd), started detached (no console, so no window); no session, umask or signal mask", async () => {
	const dir = fs.mkdtempSync(path.join(tmp, "start-"));
	for (const sub of ["bin", "cmdonly", "cwd", path.join("cwd", "rel"), "config", "data"]) fs.mkdirSync(path.join(dir, sub));
	fs.writeFileSync(path.join(dir, "bin", "node.exe"), "");
	fs.writeFileSync(path.join(dir, "cmdonly", "node.cmd"), "");
	fs.writeFileSync(path.join(dir, "cwd", "node.exe"), "");
	fs.writeFileSync(path.join(dir, "cwd", "rel", "node.exe"), "");
	const r = await py(
		`
import signal, subprocess
ctl.WINDOWS = True
base = ${JSON.stringify(dir)}
os.chdir(os.path.join(base, "cwd"))
found = []
for entries in ([os.path.join(base, "cmdonly"), os.path.join(base, "bin")], [os.path.join(base, "cmdonly")], ['"%s"' % os.path.join(base, "bin")], ["", "rel", os.path.join(base, "bin")]):
    os.environ["PATH"] = os.pathsep.join(entries)
    got = ctl.find_node()
    found.append(None if got is None else os.path.relpath(got, base) if os.path.isabs(got) else ["relative", got])
say(found)
seen = {}
class Child:
    pid = 999999
    def poll(self):
        return 3
class Sub:
    DEVNULL = subprocess.DEVNULL
    TimeoutExpired = subprocess.TimeoutExpired
    @staticmethod
    def Popen(argv, **kw):
        seen.update(argv=argv, **{k: v for k, v in kw.items() if k not in ("env", "stdin", "stdout", "stderr")})
        return Child()
def never(*_a, **_k):
    raise AssertionError("not on Windows")
ctl.subprocess = Sub
signal.pthread_sigmask = never
ctl.process_info = lambda pid: None
node = os.path.join(base, "bin", "node.exe")
try:
    ctl.start_locked(${await closedPort()}, base, node, os.path.join(base, "config"), os.path.join(base, "data"))
except ctl.Failure as e:
    say(str(e))
say([seen.pop("argv") == [node, ctl.MAIN], seen, os.path.isfile(os.path.join(base, "data", "daemon.log"))])
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	assert.deepEqual(r.out, [
		[path.join("bin", "node.exe"), null, path.join("bin", "node.exe"), ["relative", path.join("rel", "node.exe")]],
		"the daemon ended at once (exit code 3)",
		[true, { cwd: dir, close_fds: true, creationflags: 0x200 | 0x8 }, true],
	]);
});

test("on Windows itself: kernel32 knows this process by creation time and image, and not one that ended; the start lock is one at a time", { skip: WINDOWS_ONLY }, async () => {
	const dir = fs.mkdtempSync(path.join(tmp, "win-"));
	const r = await py(
		`
import subprocess
me = ctl.process_info(os.getpid())
say([me["start"].isdigit(), os.path.basename(me["image"]).lower().startswith("python"), ctl.process_info(os.getpid()) == me])
child = subprocess.Popen([sys.executable, "-c", "pass"])
child.wait()
say(ctl.process_info(child.pid))
fd = ctl.start_lock(${JSON.stringify(dir)})
ctl.LOCK_WAIT_S = 0.3
try:
    ctl.start_lock(${JSON.stringify(dir)})
    say("taken twice")
except ctl.Failure as e:
    say(str(e).startswith("another start is under way"))
ctl.release_lock(fd)
again = ctl.start_lock(${JSON.stringify(dir)})
say(isinstance(again, int))
ctl.release_lock(again)
`,
		{ LOCALAPPDATA: process.env.LOCALAPPDATA ?? "" },
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	assert.deepEqual(r.out, [[true, true, true], null, true, true]);
});

test("bgw status and doctor say when a daemon on Windows has no notifications, and nothing of it where the daemon does not say so", async () => {
	const r = await py(
		`
import argparse, contextlib, io
class Daemon:
    port = 8791
    def __init__(self, extra):
        self.status = dict({"name": "browser-gateway", "version": "1", "uptime_s": 1, "paired": True, "extension_connected": True, "paused": False, "audit_ok": True}, **extra)
    def call(self, role, method, path, *_a, **_k):
        return dict(self.status), "token"
    def open_call(self, path):
        return {"name": "browser-gateway"}
os.environ["BGW_ADMIN_TOKEN_FILE"] = os.path.join(os.sep, "nonexistent", "admin.token")
os.environ["BGW_ON_DEMAND"] = "0"
for extra in ({"notifications": "unavailable"}, {}):
    for command, args in ((bgw.cmd_status, argparse.Namespace(admin=False, json=False)), (bgw.cmd_doctor, argparse.Namespace(json=False)), (bgw.cmd_doctor, argparse.Namespace(json=True))):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = command(args, Daemon(extra))
        text = out.getvalue()
        say([code, json.loads(text).get("notifications", "absent") if args.json else "notifications: not available on Windows" in text.splitlines()])
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	assert.deepEqual(r.out, [
		[0, true],
		[0, true],
		[0, "unavailable"],
		[0, false],
		[0, false],
		[0, "absent"],
	]);
});

test("on Windows itself: bgw mcp with BGW_ON_DEMAND=1 starts the daemon at the first tool call, and bgw daemon status and stop find it by its pid record", { skip: WINDOWS_ONLY }, async () => {
	const dir = fs.mkdtempSync(path.join(tmp, "ondemand-"));
	const configDir = path.join(dir, "config");
	const dataDir = path.join(dir, "data");
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ notify: { sound: false } }));
	const port = await closedPort();
	const env = {
		BGW_URL: `http://127.0.0.1:${port}`,
		BGW_CONFIG_DIR: configDir,
		BGW_DATA_DIR: dataDir,
		BGW_TOKEN_FILE: path.join(configDir, "client.token"),
		BGW_ADMIN_TOKEN_FILE: path.join(configDir, "admin.token"),
		BGW_ON_DEMAND: "1",
		LOCALAPPDATA: path.join(dir, "local"),
	};
	/** @param {string[]} args @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
	const bgw = (args) =>
		new Promise((resolve) => {
			execFile(PYTHON, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...SYSTEM_ENV, ...env }, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr }));
		});
	const mcp = startMcp(env);
	try {
		const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1" } });
		assert.equal(init.result.protocolVersion, "2025-06-18");
		assert.equal(fs.existsSync(path.join(dataDir, "daemon.pid")), false, "the handshake starts nothing");
		const status = await mcp.request("tools/call", { name: "gateway_status", arguments: {} }, { timeoutMs: 45000 });
		assert.equal(status.result.isError, false, JSON.stringify(status));
		assert.match(mcp.stderr(), /started it on demand/);
		const record = JSON.parse(fs.readFileSync(path.join(dataDir, "daemon.pid"), "utf8"));
		assert.match(record.image, /node\.exe$/i);
		assert.match(record.start, /^[0-9]+$/);
		const running = JSON.parse((await bgw(["daemon", "status", "--json"])).stdout);
		assert.deepEqual([running.running, running.answers, running.pid], [true, true, record.pid]);
		const stopped = await bgw(["daemon", "stop"]);
		assert.deepEqual([stopped.code, stopped.stdout, stopped.stderr], [0, `bgw daemon: stopped, pid ${record.pid}\n`, ""]);
		assert.equal(fs.existsSync(path.join(dataDir, "daemon.pid")), false);
		assert.equal(JSON.parse((await bgw(["daemon", "status", "--json"])).stdout).running, false);
	} finally {
		await mcp.stop();
		await bgw(["daemon", "stop"]);
	}
});

test("Windows overrides: a drive or a share only, as for LOCALAPPDATA, for all five variables in cli/bgw and the controller", async () => {
	const r = await py(
		`
bgw.WINDOWS = ctl.WINDOWS = True
os.environ["LOCALAPPDATA"] = ${JSON.stringify(LOCAL)}
names = ["BGW_TOKEN_FILE", "BGW_ADMIN_TOKEN_FILE", "BGW_DOWNLOAD_DIR", "BGW_CONFIG_DIR", "BGW_DATA_DIR"]
calls = [lambda: bgw.token_path("client"), lambda: bgw.token_path("admin"), bgw.download_dir, ctl.directories, ctl.directories]
def row(value):
    out = []
    for name, f in zip(names, calls):
        for n in names:
            os.environ.pop(n, None)
        os.environ[name] = value
        try:
            got = f()
            out.append(["ok", list(got) if isinstance(got, tuple) else got])
        except (bgw.CliError, ctl.Failure) as e:
            out.append([getattr(e, "kind", "failure"), str(e)])
    os.environ["BGW_CONFIG_DIR"] = value
    out.append(bgw.on_demand())
    return out
for value in ("\\\\\\\\server\\\\share\\\\gw", "\\\\rooted", "C:rel", "rel", "/x", "\\\\\\\\\\\\x"):
    say(row(value))
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	const [share, ...bad] = r.out;
	const config = `${LOCAL}\\browser-gateway\\config`;
	const data = `${LOCAL}\\browser-gateway\\data`;
	const s = "\\\\server\\share\\gw";
	assert.deepEqual(share, [["ok", s], ["ok", s], ["ok", s], ["ok", [s, data]], ["ok", [config, s]], false]);
	const refused = [
		["token", "BGW_TOKEN_FILE must be an absolute path"],
		["token", "BGW_ADMIN_TOKEN_FILE must be an absolute path"],
		["other", "BGW_DOWNLOAD_DIR must be an absolute path"],
		["failed", "BGW_CONFIG_DIR must be an absolute path"],
		["failed", "BGW_DATA_DIR must be an absolute path"],
		false,
	];
	for (const row of bad) assert.deepEqual(row, refused);
});

test("reparse points on Windows: only those that name another place (links, junctions) are refused, as Node does; OneDrive and deduplicated files are files", { skip: POSIX_ONLY }, async () => {
	const dir = fs.mkdtempSync(path.join(tmp, "reparse-"));
	const token = "B".repeat(43);
	fs.writeFileSync(path.join(dir, "client.token"), token + "\n");
	fs.mkdirSync(path.join(dir, "exports"));
	const r = await py(
		`
import types
bgw.WINDOWS = True
bgw.windows_absolute = os.path.isabs
REG, DIR = 0o100000, 0o040000
cases = {"plain": (REG, 0, None), "symlink": (REG, 0x400, 0xA000000C), "junction": (DIR, 0x410, 0xA0000003), "onedrive": (REG, 0x400, 0x9000601A), "dedup": (REG, 0x400, 0x80000013), "no tag": (REG, 0x400, None), "tag only": (REG, 0, 0xA000000C)}
rows = []
for name, (mode, attrs, tag) in cases.items():
    st = types.SimpleNamespace(st_mode=mode | 0o600, st_file_attributes=attrs)
    if tag is not None:
        st.st_reparse_tag = tag
    rows.append([name, bgw._reparse(st), bgw._plain(st)])
say(rows)
# The same through the token read and the export directory, with what lstat says made up.
real = os.lstat
seen = {}
def lstat(p, *a, **k):
    st = real(p, *a, **k)
    attrs, tag = seen.get("now", (0, 0))
    return types.SimpleNamespace(st_mode=st.st_mode, st_dev=st.st_dev, st_ino=st.st_ino, st_size=st.st_size, st_mtime=st.st_mtime, st_file_attributes=attrs, st_reparse_tag=tag)
os.lstat = lstat
os.environ["BGW_TOKEN_FILE"] = os.path.join(${JSON.stringify(dir)}, "client.token")
out = []
for name in ("onedrive", "symlink", "junction"):
    seen["now"] = cases[name][1:]
    try:
        out.append([name, bgw.read_token("client") == ${JSON.stringify(token)}])
    except bgw.CliError as e:
        out.append([name, str(e).replace(${JSON.stringify(dir + path.sep)}, "")])
    try:
        out.append([name, bgw.open_download_dir(os.path.join(${JSON.stringify(dir)}, "exports"), by_path=True) is not None])
    except bgw.CliError as e:
        out.append([name, str(e).replace(${JSON.stringify(dir + path.sep)}, "")])
say(out)
`,
		{ BGW_DOWNLOAD_DIR: path.join(dir, "exports") },
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	assert.deepEqual(r.out[0], [
		["plain", false, true],
		["symlink", true, false],
		["junction", true, false],
		["onedrive", false, true],
		["dedup", false, true],
		["no tag", false, true],
		["tag only", false, true],
	]);
	const linkToken = "cannot read token file client.token: it is a link, and a token file must be a plain file";
	const linkDir = "the export directory exports cannot be used (it is a link or not a directory): it must be a real directory, not a link";
	assert.deepEqual(r.out[1], [
		["onedrive", true],
		["onedrive", true],
		["symlink", linkToken],
		["symlink", linkDir],
		["junction", linkToken],
		["junction", linkDir],
	]);
});

test("the Mark of the Web on Windows: an export in the export directory and one with -o get a Zone.Identifier of the Internet zone; off Windows nothing", async () => {
	const dir = fs.mkdtempSync(path.join(tmp, "motw-"));
	const r = await py(
		`
import hashlib
FID = "fl_" + "1" * 26
base = ${JSON.stringify(dir)}
def fetch(write, begin):
    info = {"name": "x", "type": "application/pdf", "size": 3, "sha256": hashlib.sha256(b"pdf").hexdigest()}
    begin(info)
    write(b"pdf")
    return info
def mark(p):
    try:
        return open(p + ":Zone.Identifier", "rb").read().decode("ascii")
    except FileNotFoundError:
        return None
out = []
for windows in (True, False):
    bgw.WINDOWS = windows
    d = os.path.join(base, "win" if windows else "posix")
    os.mkdir(d)
    where = d if windows else bgw.open_download_dir(d)
    name = bgw.save_download(where, fetch, lambda info: bgw.export_name(FID, info["type"]))[0]
    bgw.close_download_dir(where)
    rows = [name, mark(os.path.join(d, name))]
    for force in (False, True):
        target = bgw.NewFile(os.path.join(d, "out.pdf"), force)
        target.write(b"pdf")
        target.commit()
        rows.append(mark(os.path.join(d, "out.pdf")))
        if os.path.exists(os.path.join(d, "out.pdf:Zone.Identifier")):
            os.unlink(os.path.join(d, "out.pdf:Zone.Identifier"))
    out.append(rows)
say(out)
# Best effort: a place where no stream can be written changes nothing and raises nothing.
bgw.mark_downloaded(os.path.join(base, "missing", "x.pdf"))
say(os.path.exists(os.path.join(base, "missing")))
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	const zone = "[ZoneTransfer]\r\nZoneId=3\r\n";
	const FID = "fl_" + "1".repeat(26);
	assert.deepEqual(r.out, [
		[
			[`${FID}.pdf`, zone, zone, zone],
			[`${FID}.pdf`, null, null, null],
		],
		false,
	]);
});

test("removing a file that is held on Windows: tried again (5 x 50 ms), then the error; a part file left as a second name is not counted twice; once elsewhere", async () => {
	const dir = fs.mkdtempSync(path.join(tmp, "held-"));
	const r = await py(
		`
import hashlib
base = ${JSON.stringify(dir)}
real = os.unlink
state = {"fails": 0, "calls": 0}
def unlink(p, *a, **k):
    state["calls"] += 1
    if state["fails"] > 0:
        state["fails"] -= 1
        raise PermissionError(13, "held")
    real(p, *a, **k)
os.unlink = unlink
def attempt(module, fails):
    p = os.path.join(base, "f")
    open(p, "wb").write(b"x")
    state.update(fails=fails, calls=0)
    try:
        module.remove_file(p)
        return ["gone", state["calls"], os.path.exists(p)]
    except PermissionError:
        return ["held", state["calls"], os.path.exists(p)]
rows = []
for module in (bgw, ctl):
    module.WINDOWS = True
    rows.append([attempt(module, 2), attempt(module, 99)])
    module.WINDOWS = False
    rows.append([attempt(module, 1)])
say(rows)
# An export whose part file cannot be removed: the file is there once, and counted once.
bgw.WINDOWS = True
d = os.path.join(base, "exports")
os.mkdir(d)
content = b"0123456789"
def fetch(write, begin):
    info = {"name": "x", "type": "text/plain", "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
    begin(info)
    write(content)
    return info
state.update(fails=10 ** 6, calls=0)
name = bgw.save_download(d, fetch, lambda info: bgw.export_name("fl_" + "2" * 26, info["type"]))[0]
state["fails"] = 0
left = sorted(n for n in os.listdir(d) if n.startswith(".bgw-part-"))
counted = bgw.directory_bytes(d)
bgw.WINDOWS = False
say([name, len(left), os.stat(os.path.join(d, left[0])).st_nlink, counted, bgw.directory_bytes(d)])
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	const [rows, [name, left, links, counted, posixCounted]] = r.out;
	assert.deepEqual(rows, [[["gone", 3, false], ["held", 5, true]], [["held", 1, true]], [["gone", 3, false], ["held", 5, true]], [["held", 1, true]]]);
	assert.deepEqual([name, left, links, counted], [`fl_${"2".repeat(26)}.txt`, 1, 2, 10 + "[ZoneTransfer]\r\nZoneId=3\r\n".length]);
	assert.equal(posixCounted, counted + 10, "off Windows the part file counts as before");
});

test("no hard links on Windows (FAT, a share): an export and the pid record say the directory must be on NTFS and leave nothing behind; a taken name is still a taken name", async () => {
	const dir = fs.mkdtempSync(path.join(tmp, "nolink-"));
	const r = await py(
		`
import errno, hashlib
base = ${JSON.stringify(dir)}
real = os.link
mode = {"error": None}
def link(*a, **k):
    if mode["error"] is not None:
        raise mode["error"]
    return real(*a, **k)
os.link = link
def fetch(write, begin):
    info = {"name": "x", "type": "text/plain", "size": 2, "sha256": hashlib.sha256(b"hi").hexdigest()}
    begin(info)
    write(b"hi")
    return info
def short(text):
    return text.replace(base + os.sep, "")
out = []
for windows in (True, False):
    bgw.WINDOWS = ctl.WINDOWS = windows
    d = os.path.join(base, "win" if windows else "posix")
    os.mkdir(d)
    mode["error"] = OSError(errno.EPERM, "Operation not permitted")
    row = []
    target = bgw.NewFile(os.path.join(d, "out.txt"), False)
    target.write(b"hi")
    try:
        target.commit()
        row.append("written")
    except bgw.CliError as e:
        row.append([type(e).__name__, short(str(e))])
    try:
        bgw.save_download(d, fetch, lambda info: "f.txt")
        row.append("written")
    except bgw.CliError as e:
        row.append([type(e).__name__, short(str(e))])
    except OSError as e:
        row.append(["OSError", e.errno == errno.EPERM])
    try:
        ctl.publish_record(os.path.join(d, "daemon.pid"), {"pid": 2})
        row.append("written")
    except ctl.Failure as e:
        row.append(["Failure", short(str(e))])
    except OSError as e:
        row.append(["OSError", e.errno == errno.EPERM])
    mode["error"] = FileExistsError(errno.EEXIST, "File exists")
    try:
        ctl.publish_record(os.path.join(d, "daemon.pid"), {"pid": 2})
    except FileExistsError:
        row.append("exists")
    row.append(sorted(os.listdir(d)))
    out.append(row)
say(out)
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	const ntfs = "the directory must be on an NTFS volume (a hard link is needed)";
	assert.deepEqual(r.out, [
		[
			[
				["NoLink", `cannot write win${path.sep}out.txt (Operation not permitted): ${ntfs}`],
				["NoLink", `cannot write win${path.sep}f.txt (Operation not permitted): ${ntfs}`],
				["Failure", `cannot make win${path.sep}daemon.pid (Operation not permitted): the data ${ntfs.replace("the ", "")}`],
				"exists",
				[],
			],
			[
				["CliError", `cannot write posix${path.sep}out.txt: Operation not permitted`],
				["OSError", true],
				["OSError", true],
				"exists",
				[],
			],
		],
	]);
});

test("ending the daemon on Windows through kernel32: a handle with terminate, query and synchronize access only, the process checked again on it, TerminateProcess, a wait, the handle closed", async () => {
	const dir = fs.mkdtempSync(path.join(tmp, "k32-"));
	const r = await py(
		`
import ctypes
ctl.WINDOWS = True
ctl.ctypes = ctypes
ctypes.get_last_error = lambda: 5
IMAGE = "C:\\\\Program Files\\\\nodejs\\\\node.exe"
class Kernel32:
    """What kernel32 says about one process, and what was asked of it."""
    def __init__(self, start=1337, image=IMAGE, opens=True, ends=True, waited=0, reused=None):
        self.start, self.image, self.opens, self.ends, self.waited, self.reused = start, image, opens, ends, waited, reused
        self.alive = True
        self.calls = []
    def OpenProcess(self, access, inherit, pid):
        self.calls.append(["open", access, inherit, pid])
        if access & ctl.PROCESS_TERMINATE and self.reused is not None:
            self.start = self.reused
        return 77 if self.opens else 0
    def GetExitCodeProcess(self, h, code):
        code._obj.value = ctl.STILL_ACTIVE if self.alive else 0
        return 1
    def GetProcessTimes(self, h, created, ended, kernel, user):
        created._obj.value = self.start
        return 1
    def QueryFullProcessImageNameW(self, h, flags, buf, size):
        buf.value = self.image
        return 1
    def TerminateProcess(self, h, code):
        self.calls.append(["terminate", h, code])
        if self.ends:
            self.alive = False
        return 1 if self.ends else 0
    def WaitForSingleObject(self, h, ms):
        self.calls.append(["wait", h, ms])
        return self.waited
    def CloseHandle(self, h):
        self.calls.append(["close", h])
        return 1
record = {"pid": 4242, "start": "1337", "image": "c:/program files/NODEJS/node.exe", "cwd": "C:\\\\src", "port": 1}
out = []
for k in (Kernel32(), Kernel32(waited=0x102), Kernel32(reused=999), Kernel32(image="C:\\\\x\\\\other.exe"), Kernel32(opens=False), Kernel32(ends=False)):
    ctl._kernel32 = k
    try:
        out.append([ctl.windows_end(record, 10.0), k.calls])
    except ctl.Failure as e:
        out.append([str(e), k.calls])
say(out)
# What process_info asks: query access only.
ctl._kernel32 = k = Kernel32()
say([ctl.process_info(4242), k.calls])
# stop, all of it through the stand-in: the pid record, the check, the end.
pid_path = os.path.join(${JSON.stringify(dir)}, "daemon.pid")
open(pid_path, "w").write(json.dumps(dict(record, image=IMAGE)))
ctl._kernel32 = k = Kernel32()
ctl.answers_as_gateway = lambda port: False
say([ctl.stop("C:\\\\src", ${JSON.stringify(dir)}, 1), [c[0] for c in k.calls], os.path.exists(pid_path)])
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	const END = 0x0001 | 0x1000 | 0x00100000;
	const open = ["open", END, 0, 4242];
	const rest = [["terminate", 77, 1], ["wait", 77, 10000], ["close", 77]];
	assert.deepEqual(r.out[0], [
		[true, [open, ...rest]],
		[false, [open, ...rest]],
		["process 4242 is no longer the daemon of the pid file - nothing was ended", [open, ["close", 77]]],
		["process 4242 is no longer the daemon of the pid file - nothing was ended", [open, ["close", 77]]],
		["process 4242 cannot be opened to end it (Windows error 5) - nothing was ended", [open]],
		["process 4242 could not be ended (Windows error 5)", [open, ["terminate", 77, 1], ["close", 77]]],
	]);
	assert.deepEqual(r.out[1], [{ start: "1337", image: "C:\\Program Files\\nodejs\\node.exe" }, [["open", 0x1000, 0, 4242], ["close", 77]]]);
	assert.deepEqual(r.out[2], [
		{ stopped: true, running: false, pid: 4242, note: "stopped" },
		["open", "close", "open", "close", "open", "terminate", "wait", "close"],
		false,
	]);
});

test("Python of the Microsoft Store on Windows: known in cli/bgw and the controller by where it is installed; it starts no daemon and keeps no exports below %LOCALAPPDATA%, mcp-config warns", async () => {
	const dir = fs.mkdtempSync(path.join(tmp, "store-"));
	const r = await py(
		`
store = r"C:\\Users\\op\\AppData\\Local\\Microsoft\\WindowsApps\\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\\python.exe"
store_prefix = r"C:\\Program Files\\WindowsApps\\PythonSoftwareFoundation.Python.3.13_3.13.5_x64__qbz5n2kfra8p0"
plain = r"C:\\Users\\op\\AppData\\Local\\Programs\\Python\\Python313\\python.exe"
plain_prefix = r"C:\\Users\\op\\AppData\\Local\\Programs\\Python\\Python313"
alias = r"C:\\Users\\op\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"
say([[m.store_python(e, p) for e, p in ((store, plain_prefix), (plain, store_prefix), (plain, plain_prefix), (alias, plain_prefix), ("/usr/bin/python3", "/usr"))] for m in (bgw, ctl)])
bgw.WINDOWS = ctl.WINDOWS = True
bgw.store_python = ctl.store_python = lambda executable=None, prefix=None: True
os.environ["LOCALAPPDATA"] = r"C:\\Users\\op\\AppData\\Local"
try:
    ctl.start(8791, ${JSON.stringify(REPO)}, ${JSON.stringify(path.join(dir, "config"))}, ${JSON.stringify(path.join(dir, "data"))})
    say("started")
except ctl.Failure as e:
    say(str(e))
try:
    bgw.download_dir()
    say("exports")
except bgw.CliError as e:
    say(str(e))
os.environ["BGW_DOWNLOAD_DIR"] = r"D:\\exports"
say(bgw.download_dir())
`,
	);
	assert.equal(r.code, 0, r.stderr);
	assert.deepEqual(r.out[0], [
		[true, true, false, false, false],
		[true, true, false, false, false],
	]);
	assert.match(r.out[1], /^bgw daemon start: this is the Python of the Microsoft Store, .* install Python from python\.org .* - nothing was started$/);
	assert.match(r.out[2], /^no export directory: this is the Python of the Microsoft Store, .*, or set BGW_DOWNLOAD_DIR to a directory outside %LOCALAPPDATA%$/);
	assert.equal(r.out[3], "D:\\exports");
	assert.deepEqual(fs.readdirSync(dir), [], "nothing was made");
});
