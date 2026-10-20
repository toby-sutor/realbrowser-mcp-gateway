// "bgw daemon start | stop | status" and tools/autostart.sh, against scratch
// locations only: a config and data directory in the tests' temp root, a port
// nothing else uses, an autostart directory of the tests' own. Nothing here
// goes near the operator's ~/.config, their autostart folder or port 8791.
//
// The daemon these tests start is a real one, as a process of its own. It is
// given a session bus address that leads nowhere and no sound, and no
// extension ever connects to it, so it has nothing to tell the desktop.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";
import { closedPort, squatter } from "../helpers/squatter.js";
import { SYSTEM_ENV } from "../helpers/mcp-stdio.js";

const REPO = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = path.join(REPO, "cli", "bgw");
const AUTOSTART = path.join(REPO, "tools", "autostart.sh");
const PYTHON = process.env.PYTHON || "python3";
/** What only Linux or POSIX has: /proc, sh and the desktop autostart, mode bits and a shell script standing in for node. */
const PROC = process.platform === "win32" ? "reads /proc" : false;
const SH = process.platform === "win32" ? "tools/autostart.sh is a POSIX sh script for a Linux desktop" : false;
const POSIX_ONLY = process.platform === "win32" ? "mode bits, and a sh script standing in for node" : false;

/** @type {string} */
let tmp;
/** @type {{ configDir: string, dataDir: string, port: number, env: Record<string, string> }[]} every scratch gateway a test made */
const made = [];

before(() => {
	tmp = makeTempDir("daemonctl");
});

/** @param {number} pid @returns {{ start: string, cwd: string, argv: string[], environ: string } | null} what /proc says about a process */
function proc(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return {
			start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
			cwd: fs.readlinkSync(`/proc/${pid}/cwd`),
			argv: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((a) => a !== ""),
			environ: fs.readFileSync(`/proc/${pid}/environ`, "utf8"),
		};
	} catch {
		return null;
	}
}

after(async () => {
	// Whatever a failed test left running: only a daemon whose environment names one of this run's own directories.
	for (const g of made) {
		try {
			const record = JSON.parse(fs.readFileSync(path.join(g.dataDir, "daemon.pid"), "utf8"));
			const info = proc(record.pid);
			if (info !== null && info.environ.includes(`BGW_DATA_DIR=${g.dataDir}`) && info.argv.includes("daemon/src/main.js")) process.kill(record.pid, "SIGKILL");
		} catch {
			// no pid file: nothing was left
		}
	}
	removeTempDir(tmp);
});

/** A scratch gateway: directories and a port of its own. */
async function scratch() {
	const dir = fs.mkdtempSync(path.join(tmp, "gw-"));
	const configDir = path.join(dir, "config");
	const dataDir = path.join(dir, "data");
	fs.mkdirSync(configDir, { mode: 0o700 });
	// No sound, whatever happens.
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ notify: { sound: false } }), { mode: 0o600 });
	const port = await closedPort();
	const g = {
		configDir,
		dataDir,
		port,
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: path.join(dir, "home"),
			...SYSTEM_ENV,
			BGW_URL: `http://127.0.0.1:${port}`,
			BGW_CONFIG_DIR: configDir,
			BGW_DATA_DIR: dataDir,
			BGW_TOKEN_FILE: path.join(configDir, "client.token"),
			BGW_ADMIN_TOKEN_FILE: path.join(configDir, "admin.token"),
			// A bus that does not exist: this daemon cannot reach the desktop.
			DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(dir, "no-such-bus")}`,
		},
	};
	made.push(g);
	return g;
}

/**
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function bgw(args, env) {
	return new Promise((resolve) => {
		execFile(PYTHON, [CLI, ...args], { env, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr }));
	});
}

/** @param {string} dataDir @returns {any} */
const record = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, "daemon.pid"), "utf8"));

test("bgw daemon start, status, stop: a detached daemon from this checkout, one at most, and only that process is ever signalled", { skip: PROC }, async () => {
	const g = await scratch();
	const none = await bgw(["daemon", "status"], g.env);
	assert.deepEqual([none.code, none.stdout, none.stderr], [1, "bgw daemon: not running\n", ""]);
	assert.deepEqual([(await bgw(["daemon", "stop"], g.env)).stdout], ["bgw daemon: not running (no pid file)\n"]);

	const started = await bgw(["daemon", "start"], g.env);
	assert.equal(started.code, 0, started.stderr);
	const rec = record(g.dataDir);
	assert.equal(started.stdout, `bgw daemon: started, pid ${rec.pid}, 127.0.0.1:${g.port}, log ${path.join(g.dataDir, "daemon.log")}\n`);
	assert.deepEqual(Object.keys(rec).sort(), ["cwd", "pid", "port", "start", "started_at"]);
	assert.deepEqual([rec.cwd, rec.port], [REPO, g.port]);
	const info = proc(rec.pid);
	assert.ok(info !== null);
	// The process is the daemon of this checkout, in a session of its own, with the directories it was given.
	assert.deepEqual([info.cwd, info.start, info.argv.slice(1)], [REPO, rec.start, ["daemon/src/main.js"]]);
	assert.match(info.argv[0], /\/node$/);
	const stat = fs.readFileSync(`/proc/${rec.pid}/stat`, "utf8");
	const [, , pgrp, session, tty] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	assert.deepEqual([pgrp, session, tty], [String(rec.pid), String(rec.pid), "0"], "its own session and process group, no terminal");
	for (const name of ["BGW_PORT", "BGW_CONFIG_DIR", "BGW_DATA_DIR"]) assert.ok(info.environ.includes(`${name}=`), name);
	assert.ok(info.environ.includes(`BGW_PORT=${g.port}\0`) && info.environ.includes(`BGW_CONFIG_DIR=${g.configDir}\0`) && info.environ.includes(`BGW_DATA_DIR=${g.dataDir}\0`));
	// The tokens are files the daemon made itself: no token in its command line or its environment.
	const token = fs.readFileSync(g.env.BGW_TOKEN_FILE, "utf8").trim();
	const admin = fs.readFileSync(g.env.BGW_ADMIN_TOKEN_FILE, "utf8").trim();
	assert.ok(token.length >= 20 && admin.length >= 20);
	for (const secret of [token, admin]) assert.ok(!info.environ.includes(secret) && !info.argv.join(" ").includes(secret));
	// Files of its own, private.
	for (const file of ["daemon.pid", "daemon.log"]) assert.equal(fs.statSync(path.join(g.dataDir, file)).mode & 0o777, 0o600, file);
	assert.equal(fs.statSync(g.dataDir).mode & 0o777, 0o700);
	const log = fs.readFileSync(path.join(g.dataDir, "daemon.log"), "utf8");
	assert.match(log, /"event":"daemon.listening"/);
	assert.ok(!log.includes(token) && !log.includes(admin));

	// It is the gateway: it proves that it holds the token the CLI reads, and answers.
	const status = await bgw(["status"], g.env);
	assert.equal(status.code, 0, status.stderr);
	assert.match(status.stdout, /^daemon:    browser-gateway /);
	const running = await bgw(["daemon", "status", "--json"], g.env);
	assert.equal(running.code, 0);
	assert.deepEqual(JSON.parse(running.stdout), { ok: true, running: true, answers: true, pid: rec.pid, port: g.port, log: path.join(g.dataDir, "daemon.log"), started_at: rec.started_at, note: "running" });

	// A second start starts nothing.
	const again = await bgw(["daemon", "start"], g.env);
	assert.equal(again.code, 0);
	assert.equal(again.stdout, `bgw daemon: the daemon is already running - not starting a second one, pid ${rec.pid}, 127.0.0.1:${g.port}, log ${path.join(g.dataDir, "daemon.log")}\n`);
	assert.deepEqual(record(g.dataDir), rec);
	assert.equal(proc(rec.pid)?.start, rec.start);

	const stopped = await bgw(["daemon", "stop"], g.env);
	assert.deepEqual([stopped.code, stopped.stdout, stopped.stderr], [0, `bgw daemon: stopped, pid ${rec.pid}\n`, ""]);
	assert.equal(proc(rec.pid), null, "the process is gone");
	assert.equal(fs.existsSync(path.join(g.dataDir, "daemon.pid")), false);
	assert.equal((await bgw(["daemon", "status"], g.env)).code, 1);
	const down = await bgw(["status"], g.env);
	assert.equal(down.stderr, `bgw: daemon is not running on 127.0.0.1:${g.port} (connection refused)\n`);

	// And it comes up again, as at the next login, with the same tokens.
	const second = await bgw(["daemon", "start", "--json"], g.env);
	assert.equal(second.code, 0, second.stderr + second.stdout);
	const rec2 = record(g.dataDir);
	assert.notEqual(rec2.pid, rec.pid);
	assert.equal(JSON.parse(second.stdout).started, true);
	assert.equal(fs.readFileSync(g.env.BGW_TOKEN_FILE, "utf8").trim(), token);
	assert.equal((await bgw(["daemon", "stop", "--json"], g.env)).code, 0);
	assert.equal(proc(rec2.pid), null);
});

test("bgw daemon start refuses a port that is taken, and leaves nothing behind when the daemon does not come up", async () => {
	const g = await scratch();
	// Something else listens there: another daemon started by hand, or any other program.
	const other = net.createServer((socket) => socket.destroy());
	await /** @type {Promise<void>} */ (new Promise((resolve) => other.listen(g.port, "127.0.0.1", () => resolve())));
	try {
		const r = await bgw(["daemon", "start"], g.env);
		assert.deepEqual([r.code, r.stdout], [1, ""]);
		assert.equal(r.stderr, `bgw daemon: 127.0.0.1:${g.port} is already in use (a daemon started another way, or another program) - not starting\n`);
		assert.equal(fs.existsSync(path.join(g.dataDir, "daemon.pid")), false);
		assert.equal(fs.existsSync(path.join(g.dataDir, "daemon.log")), false, "nothing was started");
	} finally {
		await new Promise((resolve) => other.close(() => resolve(undefined)));
	}

	// A config file the daemon refuses: it ends at once, and the start says why.
	fs.writeFileSync(path.join(g.configDir, "config.json"), '{"no_such_key": 1}', { mode: 0o600 });
	const bad = await bgw(["daemon", "start"], g.env);
	assert.equal(bad.code, 1);
	assert.match(bad.stderr, /^bgw daemon: the daemon ended at once \(exit code 2\): browser-gateway: config\.json: unknown key "no_such_key" in the top level\n$/);
	assert.equal(fs.existsSync(path.join(g.dataDir, "daemon.pid")), false);
	const asJson = await bgw(["daemon", "start", "--json"], g.env);
	assert.equal(asJson.code, 1);
	assert.equal(JSON.parse(asJson.stdout).ok, false);
	assert.equal((await bgw(["daemon", "status"], g.env)).code, 1);
});

test("bgw daemon stop signals nothing it did not start: a reused pid, another program in this checkout, a pid file of another checkout, a file that is no pid file", { skip: PROC }, async () => {
	const g = await scratch();
	fs.mkdirSync(g.dataDir, { mode: 0o700 });
	const pidFile = path.join(g.dataDir, "daemon.pid");
	// A process of this test's own, in this checkout: what a pid looks like that was given to something else.
	const sleeper = spawn("sleep", ["60"], { cwd: REPO, stdio: "ignore" });
	try {
		await new Promise((resolve) => setTimeout(resolve, 100));
		const info = proc(/** @type {number} */ (sleeper.pid));
		assert.ok(info !== null);
		/** @param {Record<string, unknown>} over */
		const write = (over) => fs.writeFileSync(pidFile, JSON.stringify({ pid: sleeper.pid, start: info.start, cwd: REPO, port: g.port, started_at: "2026-10-06T00:00:00Z", ...over }), { mode: 0o600 });

		// Right pid, right start time, right directory - but it is not the daemon.
		write({});
		const notDaemon = await bgw(["daemon", "stop"], g.env);
		assert.equal(notDaemon.code, 1);
		assert.equal(notDaemon.stderr, `bgw daemon: process ${sleeper.pid} was not started from this checkout (pid file: ${REPO}, process: ${REPO}) - nothing was signalled\n`);
		assert.equal(fs.existsSync(pidFile), true);
		assert.equal((await bgw(["daemon", "status"], g.env)).code, 1);

		// The pid file of a daemon that another checkout started with these directories.
		write({ cwd: "/somewhere/else" });
		const elsewhere = await bgw(["daemon", "stop"], g.env);
		assert.equal(elsewhere.code, 1);
		assert.match(elsewhere.stderr, /was not started from this checkout \(pid file: \/somewhere\/else, process: .*\) - nothing was signalled\n$/);
		const startElsewhere = await bgw(["daemon", "start"], g.env);
		assert.equal(startElsewhere.code, 1);
		assert.equal(startElsewhere.stderr, `bgw daemon: a daemon started from /somewhere/else runs with these directories (pid ${sleeper.pid}) - stop it from there first\n`);

		// The pid was given to another process since: the start time differs. The file is stale, nothing is signalled.
		write({ start: String(Number(info.start) - 1) });
		const reused = await bgw(["daemon", "stop"], g.env);
		assert.deepEqual([reused.code, reused.stdout], [0, "bgw daemon: not running (the process of the pid file is gone; the stale file was removed)\n"]);
		assert.equal(fs.existsSync(pidFile), false);

		// Files that are no pid file of this tool.
		for (const content of ["12345\n", "{}", '{"pid": 1, "start": "1", "cwd": "/", "port": 1}', '{"pid": "7", "start": "1", "cwd": "/", "port": 1}', "[1]"]) {
			fs.writeFileSync(pidFile, content);
			const r = await bgw(["daemon", "stop"], g.env);
			assert.deepEqual([r.code, r.stderr], [1, `bgw daemon: ${pidFile} is not a pid file of bgw daemon - nothing was signalled (if no daemon runs, remove the file; bgw daemon status says whether one answers)\n`], content);
		}
		fs.rmSync(pidFile);
		// Through all of it the other process lived.
		assert.equal(proc(/** @type {number} */ (sleeper.pid))?.start, info.start);
		assert.equal(sleeper.exitCode, null);
		assert.equal(sleeper.signalCode, null);
	} finally {
		sleeper.kill("SIGKILL");
	}
});

test("bgw daemon: bad directories and a bad address are refused before anything is started", async () => {
	const g = await scratch();
	const relative = await bgw(["daemon", "start"], { ...g.env, BGW_DATA_DIR: "relative/dir" });
	assert.deepEqual([relative.code, relative.stderr], [1, "bgw daemon: BGW_DATA_DIR must be an absolute path\n"]);
	const url = await bgw(["daemon", "start"], { ...g.env, BGW_URL: "http://example.com:8791" });
	assert.deepEqual([url.code, url.stderr], [1, "bgw: BGW_URL must look like http://127.0.0.1:<port>\n"]);
	const usage = await bgw(["daemon", "restart"], g.env);
	assert.equal(usage.code, 1);
	assert.equal(fs.existsSync(g.dataDir), false);
});

/**
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function autostart(args, env) {
	return new Promise((resolve) => {
		execFile("sh", [AUTOSTART, ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr }));
	});
}

test("tools/autostart.sh writes one desktop entry that runs bgw daemon start, and removes only what it wrote", { skip: SH }, async () => {
	const home = fs.mkdtempSync(path.join(tmp, "home-"));
	const dir = path.join(home, "autostart dir");
	const file = path.join(dir, "browser-gateway.desktop");
	const env = { HOME: home, BGW_AUTOSTART_DIR: dir };

	const absent = await autostart(["status"], env);
	assert.deepEqual([absent.code, absent.stdout], [1, "autostart: not installed\n"]);
	assert.deepEqual([(await autostart(["remove"], env)).code, fs.existsSync(dir)], [0, false]);

	const installed = await autostart(["install"], env);
	assert.equal(installed.code, 0, installed.stderr);
	assert.equal(installed.stdout, `autostart: wrote ${file}\nautostart: at the next login it runs: python3 ${CLI} daemon start\n`);
	assert.deepEqual(fs.readdirSync(dir), ["browser-gateway.desktop"]);
	assert.equal(
		fs.readFileSync(file, "utf8"),
		["[Desktop Entry]", "Type=Application", "Name=Browser Gateway daemon", "Comment=Starts the Browser Gateway daemon at login (written by tools/autostart.sh)", `Exec=python3 "${CLI}" daemon start`, "Terminal=false", "NoDisplay=true", "X-Browser-Gateway-Autostart=1", ""].join("\n"),
	);
	assert.deepEqual([(await autostart(["status"], env)).code, (await autostart(["status"], env)).stdout], [0, `autostart: installed (${file}), starts the daemon of ${REPO}\n`]);
	// Twice is once.
	assert.equal((await autostart(["install"], env)).code, 0);
	assert.deepEqual(fs.readdirSync(dir), ["browser-gateway.desktop"]);
	// An entry that another checkout wrote is said to be out of date, and install puts it right.
	fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(CLI, "/old/checkout/cli/bgw"));
	const stale = await autostart(["status"], env);
	assert.deepEqual([stale.code, stale.stdout], [1, `autostart: installed (${file}), but not as this checkout would write it - run install again\n`]);
	assert.equal((await autostart(["install"], env)).code, 0);
	assert.equal((await autostart(["status"], env)).code, 0);

	const removed = await autostart(["remove"], env);
	assert.equal(removed.code, 0);
	assert.deepEqual(fs.readdirSync(dir), []);

	// A file of that name that is somebody else's: not overwritten, not removed.
	const foreign = "[Desktop Entry]\nType=Application\nName=Something else\nExec=/usr/bin/true\n";
	fs.writeFileSync(file, foreign);
	for (const action of ["install", "remove"]) {
		const r = await autostart([action], env);
		assert.equal(r.code, 2, action);
		assert.match(r.stderr, /was not written by this tool - not (touching|removing) it\n$/);
	}
	assert.equal((await autostart(["status"], env)).code, 1);
	assert.equal(fs.readFileSync(file, "utf8"), foreign);
	fs.rmSync(file);
	// A symlink of that name is not followed.
	const target = path.join(home, "target.desktop");
	fs.writeFileSync(target, "X-Browser-Gateway-Autostart=1\n");
	fs.symlinkSync(target, file);
	assert.equal((await autostart(["install"], env)).code, 2);
	assert.equal((await autostart(["remove"], env)).code, 2);
	assert.equal(fs.readFileSync(target, "utf8"), "X-Browser-Gateway-Autostart=1\n");
	fs.rmSync(file);

	// Nothing but that one directory was written to: the home it was given holds the scratch files of this test only.
	assert.deepEqual(fs.readdirSync(home).sort(), ["autostart dir", "target.desktop"]);
	const usage = await autostart([], env);
	assert.deepEqual([usage.code, usage.stderr], [2, `usage: ${AUTOSTART} install|remove|status\n`]);
	assert.equal((await autostart(["install"], { HOME: home, BGW_AUTOSTART_DIR: "relative" })).code, 2);
});

test("tools/autostart.sh: without the override it is ~/.config/autostart of the HOME it is given, never XDG_CONFIG_HOME, and a path with odd characters is quoted for the Exec line", { skip: SH }, async () => {
	const home = fs.mkdtempSync(path.join(tmp, "home2-"));
	// A sandbox remaps XDG_CONFIG_HOME; the desktop reads the real ~/.config.
	const r = await autostart(["install"], { HOME: home, XDG_CONFIG_HOME: path.join(home, "remapped") });
	assert.equal(r.code, 0, r.stderr);
	assert.equal(fs.existsSync(path.join(home, ".config", "autostart", "browser-gateway.desktop")), true);
	assert.equal(fs.existsSync(path.join(home, "remapped")), false);

	// A copy of the script in a checkout whose path needs quoting.
	const odd = path.join(home, 'check out $1 "q" 100% `x` b\\s');
	fs.mkdirSync(path.join(odd, "tools"), { recursive: true });
	fs.mkdirSync(path.join(odd, "cli"));
	fs.copyFileSync(AUTOSTART, path.join(odd, "tools", "autostart.sh"));
	fs.writeFileSync(path.join(odd, "cli", "bgw"), "");
	const dir = path.join(home, "auto");
	const made2 = await new Promise((resolve) => execFile("sh", [path.join(odd, "tools", "autostart.sh"), "install"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, BGW_AUTOSTART_DIR: dir } }, (err) => resolve(err)));
	assert.equal(made2, null);
	const exec = /^Exec=(.*)$/m.exec(fs.readFileSync(path.join(dir, "browser-gateway.desktop"), "utf8"))?.[1] ?? "";
	// The desktop-entry rules, undone in their order: the string escape, then the quoting, then the field codes.
	const unescaped = exec.replace(/\\\\/g, "\\");
	const m = /^python3 "((?:[^"\\]|\\.)*)" daemon start$/.exec(unescaped);
	assert.ok(m !== null, exec);
	assert.equal(m[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%"), path.join(fs.realpathSync(odd), "cli", "bgw"));
});

// With a line break in the path of the checkout the quoting failed inside the here-document,
// where its exit ended only a subshell: a broken Exec line was written, install said "wrote", status said "installed".
test("tools/autostart.sh: a checkout whose path cannot stand in a desktop entry writes nothing and exits non-zero, and status never calls a broken entry correct", { skip: SH }, async () => {
	const home = fs.mkdtempSync(path.join(tmp, "home3-"));
	/** @param {string} script @param {string[]} args @param {string} dir */
	const run = (script, args, dir) =>
		new Promise((resolve) => {
			execFile("sh", [script, ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, BGW_AUTOSTART_DIR: dir }, timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr }));
		});
	/** @type {[string, string][]} what is odd about the path, and a directory name that has it */
	const odd = [
		["a line break in the middle", "check\nout"],
		["a line break at the end", "checkout\n"],
		["two line breaks at the end", "checkout\n\n"],
		["a line break and what could pass for a key of its own", "x\nExec=sh -c 'touch pwned'\nX-y"],
		["a carriage return", "check\rout"],
		["a tab", "check\tout"],
		["an escape character", "check\u001bout"],
	];
	for (const [label, name] of odd) {
		const root = fs.mkdtempSync(path.join(home, "case-"));
		const checkout = path.join(root, name);
		fs.mkdirSync(path.join(checkout, "tools"), { recursive: true });
		fs.mkdirSync(path.join(checkout, "cli"));
		fs.copyFileSync(AUTOSTART, path.join(checkout, "tools", "autostart.sh"));
		fs.writeFileSync(path.join(checkout, "cli", "bgw"), "");
		const script = path.join(checkout, "tools", "autostart.sh");
		const dir = path.join(root, "autostart");
		const installed = /** @type {{ code: number, stdout: string, stderr: string }} */ (await run(script, ["install"], dir));
		assert.equal(installed.code, 2, `${label}: ${installed.stdout}${installed.stderr}`);
		assert.equal(installed.stdout, "", `${label}: it does not say "wrote"`);
		assert.equal(installed.stderr, "autostart: the path of this checkout holds a line break or another control character and cannot be written into a desktop entry - nothing was written\n", label);
		assert.equal(fs.existsSync(dir), false, `${label}: not even the directory was made`);
		assert.deepEqual(fs.readdirSync(root).sort(), [name], `${label}: nothing but the checkout lies there - no temporary file either`);
		const absent = /** @type {{ code: number, stdout: string }} */ (await run(script, ["status"], dir));
		assert.deepEqual([absent.code, absent.stdout], [1, "autostart: not installed\n"], label);

		// The entry as it was written before the fix: the tag is there, the command is broken over several lines.
		fs.mkdirSync(dir);
		const broken = ["[Desktop Entry]", "Type=Application", "Name=Browser Gateway daemon", "Comment=Starts the Browser Gateway daemon at login (written by tools/autostart.sh)", `Exec=python3 "${path.join(checkout, "cli", "bgw")}" daemon start`, "Terminal=false", "NoDisplay=true", "X-Browser-Gateway-Autostart=1", ""].join("\n");
		fs.writeFileSync(path.join(dir, "browser-gateway.desktop"), broken);
		const status = /** @type {{ code: number, stdout: string }} */ (await run(script, ["status"], dir));
		assert.equal(status.code, 1, `${label}: ${status.stdout}`);
		assert.equal(status.stdout, `autostart: installed (${path.join(dir, "browser-gateway.desktop")}), but it cannot be one of this checkout: its path holds a line break or another control character\n`, label);
		assert.doesNotMatch(status.stdout, /starts the daemon of/);
		// Installing again does not touch it, and taking it away still works: that needs no quoting.
		assert.equal((/** @type {{ code: number }} */ (await run(script, ["install"], dir))).code, 2);
		assert.equal(fs.readFileSync(path.join(dir, "browser-gateway.desktop"), "utf8"), broken);
		assert.equal((/** @type {{ code: number }} */ (await run(script, ["remove"], dir))).code, 0, label);
		assert.deepEqual(fs.readdirSync(dir), []);
	}

	// For the checkout itself: an entry that is this tool's, and almost right, is not called right.
	const dir = path.join(home, "almost");
	const env = { HOME: home, BGW_AUTOSTART_DIR: dir };
	const file = path.join(dir, "browser-gateway.desktop");
	assert.equal((await autostart(["install"], env)).code, 0);
	const good = fs.readFileSync(file, "utf8");
	assert.equal(good.split("\n").length, 9, "eight lines and the line end of the last");
	assert.equal(good.split("\n").filter((l) => l.startsWith("Exec=")).length, 1);
	assert.equal((await autostart(["status"], env)).code, 0);
	for (const [label, changed] of /** @type {[string, string][]} */ ([
		["a second command", `${good}Exec=sh -c 'true'\n`],
		["a command broken over two lines", good.replace("/cli/bgw", "/cli\n/bgw")],
		["lines after the last", `${good}\n\n`],
		["no command at all", good.replace(/^Exec=.*\n/m, "")],
	])) {
		fs.writeFileSync(file, changed);
		const r = await autostart(["status"], env);
		assert.deepEqual([r.code, r.stdout], [1, `autostart: installed (${file}), but not as this checkout would write it - run install again\n`], label);
	}
	assert.equal((await autostart(["install"], env)).code, 0);
	assert.equal(fs.readFileSync(file, "utf8"), good, "install puts it right");
	assert.equal((await autostart(["remove"], env)).code, 0);
});

/**
 * Run Python code that has the controller module loaded as `ctl`.
 * @param {string} code
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function withController(code, env = { PATH: process.env.PATH ?? "/usr/bin:/bin" }) {
	const prelude = `import importlib.util, sys\nspec = importlib.util.spec_from_file_location("ctl", ${JSON.stringify(path.join(REPO, "cli", "bgw_daemonctl.py"))})\nctl = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(ctl)\n`;
	return new Promise((resolve) => {
		execFile(PYTHON, ["-B", "-c", prelude + code], { env, timeout: 30000 }, (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr }));
	});
}

test("the pid file is put in place whole: never empty or half written, never over another, and nothing is left when it fails", { skip: POSIX_ONLY }, async () => {
	const g = await scratch();
	fs.mkdirSync(g.dataDir, { mode: 0o700 });
	const pidFile = path.join(g.dataDir, "daemon.pid");
	const record = { pid: 4242, start: "1", cwd: REPO, port: g.port, started_at: "2026-10-06T00:00:00Z" };
	const r = await withController(
		`
import json, os
pid = ${JSON.stringify(pidFile)}
record = ${JSON.stringify(record)}
ctl.publish_record(pid, record)
print(oct(os.stat(pid).st_mode & 0o777), json.load(open(pid)) == record)
try:
    ctl.publish_record(pid, dict(record, pid=1))
except FileExistsError:
    print("second refused")
print(json.load(open(pid))["pid"], sorted(os.listdir(os.path.dirname(pid))))
os.unlink(pid)
# A failure on the way: no pid file, no temporary file.
real = os.fsync
def broken(fd):
    raise OSError(5, "I/O error")
os.fsync = broken
try:
    ctl.publish_record(pid, record)
except OSError:
    print("failed")
os.fsync = real
print(sorted(os.listdir(os.path.dirname(pid))))
`,
	);
	assert.deepEqual([r.code, r.stderr], [0, ""]);
	assert.equal(r.stdout, "0o600 True\nsecond refused\n4242 ['daemon.pid']\nfailed\n[]\n");
});

test("bgw daemon stop and status say what an empty or damaged pid file means; an empty one is removed, a damaged one is kept", async () => {
	const g = await scratch();
	fs.mkdirSync(g.dataDir, { mode: 0o700 });
	const pidFile = path.join(g.dataDir, "daemon.pid");
	// Empty: a start was cut short. Nothing runs on the port.
	fs.writeFileSync(pidFile, "");
	const st = await bgw(["daemon", "status"], g.env);
	assert.deepEqual([st.code, st.stdout], [1, `bgw daemon: not running (the pid file ${pidFile} is empty: a start was cut short; bgw daemon stop removes it)\n`]);
	const stopped = await bgw(["daemon", "stop"], g.env);
	assert.deepEqual([stopped.code, stopped.stdout, fs.existsSync(pidFile)], [0, "bgw daemon: not running (the pid file was empty - a start was cut short; the file was removed)\n", false]);
	// A start finds an empty one in its way and goes on.
	fs.writeFileSync(pidFile, "  \n");
	// Empty, and a gateway daemon answers on the port: it is not stopped, and the operator is told.
	const gateway = await squatter(({ url }) => (url === "/healthz" ? { json: { ok: true, name: "browser-gateway", version: "1" } } : { json: { ok: false } }), { tokenFile: "/nonexistent", adminFile: "/nonexistent" });
	try {
		const env = { ...g.env, BGW_URL: `http://127.0.0.1:${gateway.port}` };
		const answering = await bgw(["daemon", "stop"], env);
		assert.equal(answering.code, 1);
		assert.equal(answering.stderr, `bgw daemon: ${pidFile} was empty (a start was cut short) and is removed, but a gateway daemon answers on 127.0.0.1:${gateway.port} that no pid file names - nothing was signalled; end that process by hand (its command line is node daemon/src/main.js)\n`);
		assert.equal(fs.existsSync(pidFile), false);
		// Damaged: kept, and the message says what to do.
		fs.writeFileSync(pidFile, "{not json");
		const statusDamaged = await bgw(["daemon", "status"], env);
		assert.equal(statusDamaged.code, 1);
		assert.equal(statusDamaged.stdout, `bgw daemon: not started by bgw daemon from this checkout, but a gateway daemon answers on 127.0.0.1:${gateway.port} (the pid file ${pidFile} is not one of bgw daemon: remove it if no daemon runs)\n`);
		const stopDamaged = await bgw(["daemon", "stop"], env);
		assert.equal(stopDamaged.code, 1);
		assert.match(stopDamaged.stderr, /is not a pid file of bgw daemon - nothing was signalled \(if no daemon runs, remove the file/);
		assert.equal(fs.readFileSync(pidFile, "utf8"), "{not json");
	} finally {
		await gateway.stop();
	}
});

test("bgw daemon start: Python before 3.9 is refused in one line, and a node found through a relative PATH entry is not run", { skip: POSIX_ONLY }, async () => {
	const g = await scratch();
	const old = await withController(`sys.version_info = (3, 8, 10, "final", 0)\nsys.exit(ctl.run("start", ${g.port}, ${JSON.stringify(CLI)}))`, g.env);
	assert.equal(old.code, 1);
	assert.equal(old.stderr, "bgw daemon: bgw daemon start needs Python 3.9 or newer; this is Python 3.8 - nothing was started\n");
	assert.equal(fs.existsSync(path.join(g.dataDir, "daemon.pid")), false);
	// status and stop have no such need.
	const status = await withController(`sys.version_info = (3, 8, 10, "final", 0)\nsys.exit(ctl.run("status", ${g.port}, ${JSON.stringify(CLI)}))`, g.env);
	assert.deepEqual([status.code, status.stdout], [1, "bgw daemon: not running\n"]);
	// A node that is a file in the working directory, reached by a PATH that starts with "bin": it is never started.
	const cwd = fs.mkdtempSync(path.join(tmp, "relpath-"));
	fs.mkdirSync(path.join(cwd, "bin"));
	fs.writeFileSync(path.join(cwd, "bin", "node"), `#!/bin/sh\ntouch ${JSON.stringify(path.join(cwd, "ran"))}\n`, { mode: 0o755 });
	const rel = await new Promise((resolve) => {
		execFile(PYTHON, [CLI, "daemon", "start"], { env: { ...g.env, PATH: `bin:${process.env.PATH ?? "/usr/bin:/bin"}` }, cwd, timeout: 30000 }, (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr }));
	});
	assert.equal(/** @type {any} */ (rel).code, 1);
	assert.equal(/** @type {any} */ (rel).stderr, "bgw daemon: the first node on the PATH is bin/node, found through a PATH entry that is not an absolute path - fix the PATH\n");
	assert.equal(fs.existsSync(path.join(cwd, "ran")), false);
	assert.equal(fs.existsSync(path.join(g.dataDir, "daemon.pid")), false);
});
