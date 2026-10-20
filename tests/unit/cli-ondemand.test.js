// Starting the daemon on demand: bgw and "bgw mcp" start it themselves when they find nothing on the
// port and the operator switched that on. Against scratch locations only, as the tests of "bgw daemon":
// a config and data directory in the tests' temp root and a port nothing else uses. Nothing here goes
// near the operator's ~/.config or port 8791.
//
// The daemons these tests start are real ones, as processes of their own, started by the client under
// test. They get a session bus address that leads nowhere and no sound. Each test stops what it
// started; whatever a failed test left is ended after the run, by its pid file.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";
import { FakeExtension, makeResult } from "../helpers/fake-extension.js";
import { startMcp } from "../helpers/mcp-stdio.js";
import { closedPort, squatter } from "../helpers/squatter.js";

const REPO = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = path.join(REPO, "cli", "bgw");
const INSTALL = path.join(REPO, "tools", "install.sh");
const PYTHON = process.env.PYTHON || "python3";
/** Which daemons run, and that each test leaves none, is read from /proc. On Windows: cli-windows.test.js. */
const PROC = process.platform === "win32" ? "reads /proc to see which daemons run" : false;
const SOURCE = fs.readFileSync(CLI, "utf8");
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1" } };

/** @typedef {{ dir: string, configDir: string, dataDir: string, port: number, env: Record<string, string> }} Gateway */

/** @type {string} */
let tmp;
/** @type {{ dataDir: string }[]} every place a daemon of these tests may have left a pid file */
const made = [];

before(() => {
	tmp = makeTempDir("ondemand");
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

/** @param {string} dataDir @returns {number[]} the daemons that run with this data directory, whoever started them */
function daemonsOf(dataDir) {
	/** @type {number[]} */
	const found = [];
	for (const name of fs.readdirSync("/proc")) {
		if (!/^[0-9]+$/.test(name)) continue;
		const info = proc(Number(name));
		if (info !== null && info.argv.includes("daemon/src/main.js") && info.environ.includes(`BGW_DATA_DIR=${dataDir}\0`)) found.push(Number(name));
	}
	return found;
}

after(async () => {
	// Whatever a failed test left running: only a daemon whose environment names one of this run's own directories.
	for (const g of made) {
		for (const pid of daemonsOf(g.dataDir)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// gone already
			}
		}
	}
	removeTempDir(tmp);
});

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A scratch gateway: directories and a port of its own. Starting on demand is off unless a test switches it on. @returns {Promise<Gateway>} */
async function scratch() {
	const dir = fs.mkdtempSync(path.join(tmp, "gw-"));
	const configDir = path.join(dir, "config");
	const dataDir = path.join(dir, "data");
	fs.mkdirSync(configDir, { mode: 0o700 });
	// No sound, whatever happens.
	fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ notify: { sound: false } }), { mode: 0o600 });
	const port = await closedPort();
	assert.ok(![8791, 8792].includes(port), "a real port");
	const g = {
		dir,
		configDir,
		dataDir,
		port,
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: path.join(dir, "home"),
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
 * @param {string} program
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number, stdout: string, stderr: string, ms: number }>}
 */
function run(program, args, env) {
	const began = Date.now();
	return new Promise((resolve) => {
		execFile(program, args, { env, timeout: 58000 }, (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr, ms: Date.now() - began }));
	});
}

/** @param {string[]} args @param {Record<string, string>} env */
const bgw = (args, env) => run(PYTHON, [CLI, ...args], env);

/** @param {Gateway} g @returns {any} the pid file */
const record = (g) => JSON.parse(fs.readFileSync(path.join(g.dataDir, "daemon.pid"), "utf8"));
/** @param {Gateway} g */
const started = (g) => fs.existsSync(path.join(g.dataDir, "daemon.pid"));
/** @param {Gateway} g @returns {number} how often a daemon came up with this data directory */
const listenings = (g) => (fs.existsSync(path.join(g.dataDir, "daemon.log")) ? fs.readFileSync(path.join(g.dataDir, "daemon.log"), "utf8").split('"event":"daemon.listening"').length - 1 : 0);
/** @param {Gateway} g */
async function stop(g) {
	const r = await bgw(["daemon", "stop"], g.env);
	assert.equal(r.code, 0, r.stderr);
	assert.deepEqual(daemonsOf(g.dataDir), []);
}

/** @param {Gateway} g @returns {RegExp} the one line a client says when it started the daemon */
const STARTED = (g) => new RegExp(`the daemon was not running on 127\\.0\\.0\\.1:${g.port} - started it on demand \\(pid \\d+, log ${path.join(g.dataDir, "daemon.log").replaceAll(".", "\\.")}\\)\\n`);
const WAITING = "waiting up to 45 s for the browser extension to connect to the daemon\n";
const ON = { BGW_ON_DEMAND: "1" };

/** @param {any} answer @returns {string} the text of a tool result */
const textOf = (answer) => answer.result.content[0].text;

/**
 * Bring a scratch gateway up once, pair a stand-in extension with it, and take both down again: what a
 * machine looks like on which the gateway was set up and the daemon is not running.
 * @param {Gateway} g
 * @returns {Promise<FakeExtension>} not connected; it holds the key
 */
async function paired(g) {
	assert.equal((await bgw(["daemon", "start"], g.env)).code, 0);
	const code = JSON.parse((await bgw(["pair", "--json"], g.env)).stdout).code;
	const ext = new FakeExtension({ port: g.port });
	assert.equal((await ext.pair(code)).ready, true);
	await ext.kill();
	await stop(g);
	return ext;
}

/** Connect the stand-in extension some time after a daemon came up on the port, as the real one does on its next redial. @param {Gateway} g @param {FakeExtension} ext @param {number} afterMs */
async function connectLater(g, ext, afterMs) {
	for (let i = 0; i < 400 && !started(g); i++) await sleep(25);
	await sleep(afterMs);
	for (let i = 0; i < 40; i++) {
		try {
			if ((await ext.connect()).ready) return Date.now();
		} catch {
			// not listening yet
		}
		await sleep(100);
	}
	throw new Error("the stand-in extension could not connect");
}

// ---------------------------------------------------------------- the switch

test("the switch: off by default, on with the marker file or BGW_ON_DEMAND=1, off again with BGW_ON_DEMAND=0; the start is the one of bgw daemon start", { skip: PROC }, async () => {
	const g = await scratch();
	const down = `bgw: daemon is not running on 127.0.0.1:${g.port} (connection refused)\n`;
	// Tokens first, so that "no token" is not what the commands below report.
	assert.equal((await bgw(["daemon", "start"], g.env)).code, 0);
	await stop(g);
	fs.rmSync(g.dataDir, { recursive: true });

	// Off: as it always was.
	const off = await bgw(["pages", "okapi"], g.env);
	assert.deepEqual([off.code, off.stdout, off.stderr], [1, "", down]);
	assert.equal(fs.existsSync(g.dataDir), false, "nothing was started, nothing was made");

	// On for this one call.
	const forced = await bgw(["pages", "okapi"], { ...g.env, ...ON });
	assert.equal(forced.code, 0, forced.stderr);
	assert.match(forced.stderr, new RegExp(`^bgw: ${STARTED(g).source}$`));
	assert.match(forced.stdout, /^\[browser-gateway\] outcome=ok kind=page_search hits=0 query="okapi"$/m);
	// The daemon is the one of this checkout, started as bgw daemon start starts it: its pid file, its log, a session of its own.
	const rec = record(g);
	const info = proc(rec.pid);
	assert.ok(info !== null);
	assert.deepEqual([rec.cwd, rec.port, info.cwd, info.argv.slice(1)], [REPO, g.port, REPO, ["daemon/src/main.js"]]);
	const stat = fs.readFileSync(`/proc/${rec.pid}/stat`, "utf8");
	assert.equal(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3], String(rec.pid), "a session of its own: it outlives the command that started it");
	assert.equal(JSON.parse((await bgw(["daemon", "status", "--json"], g.env)).stdout).note, "running");
	// No token in its command line or its environment.
	const token = fs.readFileSync(g.env.BGW_TOKEN_FILE, "utf8").trim();
	assert.ok(!info.environ.includes(token) && !info.argv.join(" ").includes(token));
	// It is not stopped when the command ends, and the next command starts nothing.
	const next = await bgw(["pages", "okapi"], { ...g.env, ...ON });
	assert.deepEqual([next.code, next.stderr], [0, ""]);
	assert.deepEqual([record(g).pid, listenings(g)], [rec.pid, 1]);
	await stop(g);

	// The marker file in the config directory.
	fs.writeFileSync(path.join(g.configDir, "on-demand"), "", { mode: 0o600 });
	const marked = await bgw(["pages", "okapi"], g.env);
	assert.equal(marked.code, 0, marked.stderr);
	assert.match(marked.stderr, STARTED(g));
	await stop(g);
	// ... which the environment overrules for one call.
	const overruled = await bgw(["pages", "okapi"], { ...g.env, BGW_ON_DEMAND: "0" });
	assert.deepEqual([overruled.code, overruled.stdout, overruled.stderr], [1, "", down]);
	assert.equal(started(g), false);
	// Any other value of the variable decides nothing: the file does.
	const odd = await bgw(["pages", "okapi"], { ...g.env, BGW_ON_DEMAND: "yes" });
	assert.equal(odd.code, 0, odd.stderr);
	await stop(g);
	fs.rmSync(path.join(g.configDir, "on-demand"));
	const oddOff = await bgw(["pages", "okapi"], { ...g.env, BGW_ON_DEMAND: "true" });
	assert.deepEqual([oddOff.code, oddOff.stderr], [1, down]);
	// A directory of that name is no switch.
	fs.mkdirSync(path.join(g.configDir, "on-demand"));
	assert.equal((await bgw(["pages", "okapi"], g.env)).code, 1);
	assert.equal(started(g), false);
});

test("the marker is looked for in the literal ~/.config/browser-gateway (never XDG_CONFIG_HOME), and tools/install.sh on-demand writes the file the clients read", { skip: PROC }, async () => {
	const g = await scratch();
	// No BGW_CONFIG_DIR, no token variables: everything by the home directory, as on a machine as it comes.
	const home = path.join(g.dir, "home");
	const config = path.join(home, ".config", "browser-gateway");
	const data = path.join(home, ".local", "share", "browser-gateway");
	const remapped = path.join(g.dir, "remapped");
	fs.mkdirSync(config, { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(remapped, "browser-gateway"), { recursive: true });
	fs.writeFileSync(path.join(config, "config.json"), JSON.stringify({ notify: { sound: false } }), { mode: 0o600 });
	const env = { PATH: g.env.PATH, HOME: home, BGW_URL: g.env.BGW_URL, DBUS_SESSION_BUS_ADDRESS: g.env.DBUS_SESSION_BUS_ADDRESS, XDG_CONFIG_HOME: remapped, XDG_DATA_HOME: remapped };
	const h = { ...g, configDir: config, dataDir: data, env: { ...env, BGW_CONFIG_DIR: config, BGW_DATA_DIR: data } };
	made.push(h);

	// A sandbox remaps XDG_CONFIG_HOME: a file there is not the switch.
	fs.writeFileSync(path.join(remapped, "browser-gateway", "on-demand"), "");
	const not = await bgw(["pages", "x"], env);
	assert.equal(not.code, 1);
	assert.equal(fs.existsSync(data), false);

	// The install script writes it, with every location named to it and a stand-in for systemctl that must never be asked.
	const bin = path.join(g.dir, "bin");
	fs.mkdirSync(bin);
	fs.mkdirSync(path.join(g.dir, "root"));
	fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> "${path.join(bin, "systemctl.log")}"\n`, { mode: 0o755 });
	const scriptEnv = { PATH: g.env.PATH, HOME: home, BGW_INSTALL_ROOT: path.join(g.dir, "root"), BGW_SYSTEMCTL: path.join(bin, "systemctl"), BGW_UNIT_DIR: path.join(g.dir, "units"), BGW_CONFIG_DIR: config, BGW_DATA_DIR: data, BGW_AUTOSTART_DIR: path.join(g.dir, "autostart"), BGW_PORT: String(g.port) };
	for (const value of Object.values(scriptEnv).filter((v) => v.startsWith("/") && v !== g.env.PATH)) assert.ok(value.startsWith(tmp + path.sep), value);
	const wrote = await run("sh", [INSTALL, "on-demand"], scriptEnv);
	assert.equal(wrote.code, 0, wrote.stderr);
	assert.equal(fs.statSync(path.join(config, "on-demand")).mode & 0o777, 0o600);
	assert.equal(fs.existsSync(path.join(bin, "systemctl.log")), false);
	assert.equal(fs.existsSync(data), false, "the script started nothing");

	// And the client, told nothing but its home directory, finds it and starts the daemon there.
	const r = await bgw(["pages", "x"], env);
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stderr, STARTED(h));
	assert.equal(fs.statSync(path.join(config, "client.token")).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(remapped), ["browser-gateway"], "nothing was written where XDG pointed");
	await stop(h);
	// The name the script writes is the name the client reads.
	assert.equal(/^ON_DEMAND=(\S+)$/m.exec(fs.readFileSync(INSTALL, "utf8"))?.[1], /^ON_DEMAND_MARKER = "([^"]+)"$/m.exec(SOURCE)?.[1]);
});

// ---------------------------------------------------------------- which commands

test("status, doctor, debug-job, daemon status and mcp-config start nothing: they say that the daemon is down and who will start it", { skip: PROC }, async () => {
	const g = await scratch();
	assert.equal((await bgw(["daemon", "start"], g.env)).code, 0);
	await stop(g);
	const before = fs.readFileSync(path.join(g.dataDir, "daemon.log"), "utf8");
	const env = { ...g.env, ...ON };
	const hint = "it is started on demand by the next command that needs it (fetch, search, read, pages, export, pair, pending, open)";
	const down = `daemon is not running on 127.0.0.1:${g.port} (connection refused) - ${hint}`;

	for (const args of [["status"], ["status", "--admin"], ["status", "--json"], ["debug-job", "https://example.com/"]]) {
		const r = await bgw(args, env);
		assert.deepEqual([r.code, r.stdout, r.stderr], [1, "", `bgw: ${down}\n`], args.join(" "));
	}
	const doctor = await bgw(["doctor"], env);
	assert.equal(doctor.code, 1);
	assert.match(doctor.stdout, /^reachable: NO$/m);
	assert.ok(doctor.stdout.includes(`\nresult:    ${down}\n`), doctor.stdout);
	const report = JSON.parse((await bgw(["doctor", "--json"], env)).stdout);
	assert.deepEqual([report.reachable, report.on_demand, report.problem], [false, true, down]);
	const daemonStatus = await bgw(["daemon", "status"], env);
	assert.deepEqual([daemonStatus.code, daemonStatus.stdout], [1, "bgw daemon: not running\n"]);
	assert.equal((await bgw(["mcp-config"], env)).code, 0);
	assert.deepEqual([started(g), daemonsOf(g.dataDir), fs.readFileSync(path.join(g.dataDir, "daemon.log"), "utf8")], [false, [], before], "none of them started a daemon");

	// Without the switch the same commands say what they always said, and doctor says that nothing starts it.
	const plain = await bgw(["status"], g.env);
	assert.equal(plain.stderr, `bgw: daemon is not running on 127.0.0.1:${g.port} (connection refused)\n`);
	const plainReport = JSON.parse((await bgw(["doctor", "--json"], g.env)).stdout);
	assert.deepEqual([plainReport.on_demand, plainReport.problem], [false, `daemon is not running on 127.0.0.1:${g.port} (connection refused)`]);
	// What the hint names is what starts it.
	assert.equal(/^ON_DEMAND_HINT = "([^"]+)"$/m.exec(SOURCE)?.[1], hint);
	assert.match(SOURCE, /^STARTS_DAEMON = \{cmd_fetch: "client", cmd_search: "client", cmd_open: "admin", cmd_read: None, cmd_pages: None, cmd_export: None, cmd_pair: None, cmd_pending: None\}$/m);
});

test("fetch, search, read, pages, export, pair, pending and open each start the daemon, and carry on as if it had been running", { skip: PROC }, async () => {
	const g = await scratch();
	const env = { ...g.env, ...ON };
	/** @type {[string[], number, RegExp][]} the command, its exit code against a daemon without an extension, and what it prints */
	const commands = [
		[["pair", "--json"], 0, /^\{\n {2}"code": "bgw1\.\d+\.[A-Za-z0-9_-]{43}",/],
		[["fetch", "https://example.com/"], 2, /^code: extension_not_connected$/m],
		[["search", "okapi"], 2, /^code: extension_not_connected$/m],
		[["read", `pg_${"0".repeat(26)}`], 2, /^\[browser-gateway\] outcome=error/],
		[["pages", "okapi"], 0, /^\[browser-gateway\] outcome=ok kind=page_search hits=0/],
		[["export", `pg_${"0".repeat(26)}`, "--format", "text", "-o", path.join(g.dir, "out.txt")], 2, /^$/],
		[["pending"], 0, /^no page is waiting for you\n$/],
		[["open", "j_abc"], 2, /^$/],
	];
	let count = 0;
	for (const [args, code, out] of commands) {
		const r = await bgw(args, env);
		count++;
		assert.equal(r.code, code, `${args.join(" ")}: ${r.stderr}`);
		assert.match(r.stderr, new RegExp(`^bgw: ${STARTED(g).source}`), args.join(" "));
		assert.match(r.stdout, out, args.join(" "));
		assert.ok(!r.stderr.includes("Traceback") && !r.stderr.includes(WAITING), r.stderr);
		assert.deepEqual([daemonsOf(g.dataDir).length, listenings(g)], [1, count], args.join(" "));
		// Not paired: no extension can connect, so the commands that need the browser do not wait for one.
		assert.ok(r.ms < 20000, `${args.join(" ")} took ${r.ms} ms`);
		await stop(g);
	}
});

// ---------------------------------------------------------------- only a refused connection

test("something else on the port: nothing is started, the proof fails as always and no token is sent - the CLI and bgw mcp alike", { skip: PROC }, async () => {
	const g = await scratch();
	assert.equal((await bgw(["daemon", "start"], g.env)).code, 0);
	await stop(g);
	fs.rmSync(g.dataDir, { recursive: true });
	const token = fs.readFileSync(g.env.BGW_TOKEN_FILE, "utf8").trim();
	const admin = fs.readFileSync(g.env.BGW_ADMIN_TOKEN_FILE, "utf8").trim();
	const files = { tokenFile: g.env.BGW_TOKEN_FILE, adminFile: g.env.BGW_ADMIN_TOKEN_FILE };

	// A program that answers every request, also /healthz, and "proves" what it cannot.
	const s = await squatter(({ url }) => (url === "/healthz" ? { json: { ok: true, name: "browser-gateway", version: "9.9.9" } } : { json: { ok: true, mac: "B".repeat(43) } }), files);
	const env = { ...g.env, ...ON, BGW_URL: `http://127.0.0.1:${s.port}` };
	try {
		for (const args of [["pages", "x"], ["fetch", "https://example.com/"], ["pair"], ["open", "j_abc"]]) {
			const r = await bgw(args, env);
			assert.deepEqual([r.code, r.stdout, r.stderr], [1, "", `bgw: the process on 127.0.0.1:${s.port} is not the gateway daemon - not sending the token\n`], args.join(" "));
		}
		const mcp = startMcp(env);
		try {
			const r = await mcp.request("tools/call", { name: "gateway_status", arguments: {} });
			assert.equal(r.result.isError, true);
			assert.match(textOf(r), new RegExp(`^Browser Gateway: the process on 127\\.0\\.0\\.1:${s.port} is not the gateway daemon - no token and no request was sent to it\\.`));
			assert.doesNotMatch(mcp.stderr(), /started it on demand/);
		} finally {
			await mcp.stop();
		}
		assert.ok(s.requests.length >= 5 && s.requests.every((q) => q.method === "POST" && q.url === "/v1/prove" && q.headers.authorization === undefined), "it was asked to prove itself, and nothing else");
		assert.ok(!s.seen().includes(token) && !s.seen().includes(admin), "no token reached it");
	} finally {
		await s.stop();
	}
	assert.deepEqual([fs.existsSync(g.dataDir), daemonsOf(g.dataDir)], [false, []], "no daemon was started next to it");

	// A program that takes connections and says nothing useful: that is not "nothing listens" either.
	const mute = net.createServer((socket) => socket.destroy());
	await /** @type {Promise<void>} */ (new Promise((resolve) => mute.listen(g.port, "127.0.0.1", () => resolve())));
	try {
		const r = await bgw(["pages", "x"], { ...g.env, ...ON });
		assert.equal(r.code, 1);
		assert.match(r.stderr, new RegExp(`^bgw: (cannot talk to the daemon on 127\\.0\\.0\\.1:${g.port}: \\w+|the process on 127\\.0\\.0\\.1:${g.port} is not the gateway daemon - not sending the token)\\n$`));
		assert.doesNotMatch(r.stderr, /on demand/);
	} finally {
		await new Promise((resolve) => mute.close(() => resolve(undefined)));
	}
	assert.equal(fs.existsSync(g.dataDir), false);
});

test("a start that fails is reported in the controller's words and the command exits 1; bgw mcp answers with an error result and tries again next time", { skip: PROC }, async () => {
	const g = await scratch();
	const env = { ...g.env, ...ON };
	// A config file the daemon refuses: it ends at once.
	fs.writeFileSync(path.join(g.configDir, "config.json"), '{"no_such_key": 1}', { mode: 0o600 });
	const why = 'the daemon ended at once (exit code 2): browser-gateway: config.json: unknown key "no_such_key" in the top level';
	const r = await bgw(["pages", "x"], env);
	assert.deepEqual([r.code, r.stdout, r.stderr], [1, "", `bgw: the daemon is not running on 127.0.0.1:${g.port} and could not be started on demand: ${why}\n`]);
	assert.deepEqual([started(g), daemonsOf(g.dataDir)], [false, []], "nothing half-started is left");

	const mcp = startMcp(env);
	try {
		const failed = await mcp.request("tools/call", { name: "page_search", arguments: { query: "x" } });
		assert.deepEqual(failed.result, {
			content: [{ type: "text", text: `Browser Gateway: the daemon is not running on 127.0.0.1:${g.port} and could not be started on demand: ${why}. Nothing was fetched. Tell the user; do not retry in a loop.` }],
			isError: true,
		});
		assert.equal(mcp.stderr(), `bgw mcp: the daemon is not running on 127.0.0.1:${g.port} and could not be started on demand: ${why}\n`);
		// The operator repairs the file; the next call starts the daemon, without a new helper.
		fs.writeFileSync(path.join(g.configDir, "config.json"), JSON.stringify({ notify: { sound: false } }), { mode: 0o600 });
		const ok = await mcp.request("tools/call", { name: "page_search", arguments: { query: "x" } });
		assert.equal(ok.result.isError, false, JSON.stringify(ok));
		assert.match(mcp.stderr(), new RegExp(`\\nbgw mcp: ${STARTED(g).source}bgw mcp: connected to the gateway daemon on 127\\.0\\.0\\.1:${g.port} \\(it proved that it holds the token\\)\\n$`));
		assert.deepEqual(mcp.junk, []);
	} finally {
		await mcp.stop();
	}
	await stop(g);

	// A relative config directory is the controller's to refuse, in its own words.
	const relative = await bgw(["pages", "x"], { ...env, BGW_DATA_DIR: "relative/dir" });
	assert.deepEqual([relative.code, relative.stderr], [1, `bgw: the daemon is not running on 127.0.0.1:${g.port} and could not be started on demand: BGW_DATA_DIR must be an absolute path\n`]);
});

// ---------------------------------------------------------------- the browser extension

test("after its own start a fetch waits for the extension to connect and then sends the job; with the daemon already running it never waits; a command that reads the store never waits", { skip: PROC }, async () => {
	const g = await scratch();
	const env = { ...g.env, ...ON };
	const ext = await paired(g);
	ext.onJob = (start) => makeResult(start, { content: { markdown: "# Okapi\n\nfound on demand", text: null, html: null, raw_html: null, links: [], results: [] } });

	// The daemon is down. fetch starts it; the extension dials in a few seconds later, as on its next redial.
	const dialled = connectLater(g, ext, 2500);
	const r = await bgw(["fetch", "https://example.com/okapi"], env);
	const connectedAt = await dialled;
	assert.equal(r.code, 0, r.stderr + r.stdout);
	assert.match(r.stderr, new RegExp(`^bgw: ${STARTED(g).source}bgw: ${WAITING}$`));
	assert.match(r.stdout, /^\[browser-gateway\] outcome=ok page=pg_[0-9A-Z]{26}/);
	assert.ok(r.stdout.includes("found on demand"));
	assert.equal(ext.jobs.length, 1, "the job went out once, after the extension was there");
	assert.ok(r.ms >= 2500, `it waited (${r.ms} ms)`);
	assert.ok(Date.now() - connectedAt < 10000, "and went on as soon as the extension was connected, not after 45 s");

	// The daemon runs, the extension is gone: the daemon's own answer at once, no waiting.
	await ext.kill();
	await sleep(200);
	const gone = await bgw(["fetch", "https://example.com/other"], env);
	assert.equal(gone.code, 2);
	assert.match(gone.stdout, /^code: extension_not_connected$/m);
	assert.equal(gone.stderr, "");
	assert.ok(gone.ms < 8000, `no wait with a daemon that was running already (${gone.ms} ms)`);
	await stop(g);

	// A command that reads the store starts the daemon and does not wait for an extension that is not there.
	for (const args of [["pages", "okapi"], ["read", "pg_" + "0".repeat(26)], ["pending"]]) {
		const quick = await bgw(args, env);
		assert.match(quick.stderr, new RegExp(`^bgw: ${STARTED(g).source}$`), args.join(" "));
		assert.ok(quick.ms < 15000, `${args.join(" ")} took ${quick.ms} ms`);
		await stop(g);
	}
});

test("when the extension does not come, the job is sent after the wait and the daemon answers in its own words (with the wait cut short for the test)", { skip: PROC }, async () => {
	const g = await scratch();
	await paired(g);
	// The client as it is, with one number changed: how long it waits. Loaded as a module, then run as the command.
	const shortened = [
		"import importlib.machinery, importlib.util, sys",
		`loader = importlib.machinery.SourceFileLoader("bgw_under_test", ${JSON.stringify(CLI)})`,
		"spec = importlib.util.spec_from_loader(loader.name, loader)",
		"module = importlib.util.module_from_spec(spec)",
		"sys.dont_write_bytecode = True",
		"loader.exec_module(module)",
		"assert module.EXTENSION_WAIT_S == 45 and module.EXTENSION_POLL_S == 1.0",
		"module.EXTENSION_WAIT_S = 3",
		"sys.exit(module.main(sys.argv[1:]))",
	].join("\n");
	const r = await run(PYTHON, ["-c", shortened, "search", "okapi"], { ...g.env, ...ON });
	const ms = r.ms;
	assert.equal(r.code, 2, r.stderr);
	assert.match(r.stderr, new RegExp(`^bgw: ${STARTED(g).source}bgw: waiting up to 3 s for the browser extension to connect to the daemon\\n$`));
	assert.match(r.stdout, /^code: extension_not_connected$/m);
	assert.ok(ms >= 3000 && ms < 20000, `${ms} ms`);
	await stop(g);
	// The wait is longer than the longest pause of the extension between two redials.
	const link = fs.readFileSync(path.join(REPO, "extension", "background", "link.js"), "utf8");
	const capMs = Number(/^\tcapMs: (\d+),$/m.exec(link)?.[1]);
	const waitS = Number(/^EXTENSION_WAIT_S = (\d+)$/m.exec(SOURCE)?.[1]);
	assert.ok(capMs >= 1000 && waitS * 1000 > capMs, `${waitS} s against a longest pause of ${capMs} ms`);
});

// ---------------------------------------------------------------- bgw mcp

test("bgw mcp: the handshake and the tool list start nothing, a tool call starts the daemon, two calls at once start one, and only protocol messages go to stdout", { skip: PROC }, async () => {
	const g = await scratch();
	const mcp = startMcp({ ...g.env, ...ON });
	try {
		const init = await mcp.request("initialize", INIT);
		assert.equal(init.result.serverInfo.name, "browser-gateway");
		const list = await mcp.request("tools/list");
		assert.equal(list.result.tools.length, 6);
		assert.deepEqual((await mcp.request("ping")).result, {});
		assert.deepEqual([fs.existsSync(g.dataDir), daemonsOf(g.dataDir)], [false, []], "answered by the helper itself, nothing started");
		assert.equal(mcp.stderr(), `bgw mcp: the gateway daemon is not running on 127.0.0.1:${g.port} (it is started on demand by the next tool call)\n`);

		// Two tool calls arrive together.
		const [a, b] = await Promise.all([mcp.request("tools/call", { name: "gateway_status", arguments: {} }, { timeoutMs: 40000 }), mcp.request("tools/call", { name: "page_search", arguments: { query: "okapi" } }, { timeoutMs: 40000 })]);
		assert.deepEqual([a.result.isError, b.result.isError], [false, false], JSON.stringify([a, b]));
		assert.match(textOf(a), /^paired: false$/m);
		assert.match(textOf(b), /hits=0/);
		assert.deepEqual([daemonsOf(g.dataDir).length, listenings(g)], [1, 1], "one daemon");
		assert.equal(mcp.stderr().split("started it on demand").length - 1, 1, "said once");
		assert.match(mcp.stderr(), new RegExp(`\\nbgw mcp: ${STARTED(g).source}`));
		// The tool list is the daemon's own from now on, and nothing more is started.
		assert.equal((await mcp.request("tools/list")).result.tools.length, 6);
		assert.deepEqual([daemonsOf(g.dataDir).length, listenings(g)], [1, 1]);

		// stdout is the protocol channel: one JSON-RPC answer per request, and no token anywhere.
		assert.deepEqual(mcp.junk, []);
		assert.equal(mcp.messages.length, 6);
		const token = fs.readFileSync(g.env.BGW_TOKEN_FILE, "utf8").trim();
		assert.ok(!mcp.stdout().includes(token) && !mcp.stderr().includes(token) && !mcp.stderr().includes("Traceback"));
	} finally {
		await mcp.stop();
	}
	// The daemon outlives the helper that started it.
	assert.equal(daemonsOf(g.dataDir).length, 1);
	await stop(g);
});

test("bgw mcp: after its own start browser_fetch waits for the extension, page_search and gateway_status do not; with the switch off a tool call starts nothing", { skip: PROC }, async () => {
	const g = await scratch();
	const ext = await paired(g);
	const off = startMcp(g.env);
	try {
		const r = await off.request("tools/call", { name: "gateway_status", arguments: {} });
		assert.equal(textOf(r), `Browser Gateway: the gateway daemon is not running on 127.0.0.1:${g.port} (start it with: bgw daemon start). Nothing was fetched. Tell the user; do not retry in a loop.`);
		assert.deepEqual([started(g), daemonsOf(g.dataDir)], [false, []]);
	} finally {
		await off.stop();
	}

	const mcp = startMcp({ ...g.env, ...ON });
	try {
		// A status call starts the daemon and answers at once: the extension is not there, and it says so.
		const began = Date.now();
		const status = await mcp.request("tools/call", { name: "gateway_status", arguments: {} }, { timeoutMs: 30000 });
		assert.match(textOf(status), /^extension_connected: false$/m);
		assert.ok(Date.now() - began < 15000);
		assert.ok(!mcp.stderr().includes(WAITING));
		await stop(g);

		// browser_fetch starts it again and waits; the extension dials in meanwhile.
		const dialled = connectLater(g, ext, 2000);
		const fetchBegan = Date.now();
		const fetched = await mcp.request("tools/call", { name: "browser_fetch", arguments: { url: "https://example.com/okapi" } }, { timeoutMs: 50000 });
		await dialled;
		assert.equal(fetched.result.isError, false, JSON.stringify(fetched));
		assert.match(textOf(fetched), /^\[browser-gateway\] outcome=ok page=pg_[0-9A-Z]{26}/);
		assert.ok(Date.now() - fetchBegan >= 2000);
		assert.equal(ext.jobs.length, 1);
		// Each start is said, and the wait; that the daemon proved itself is said once, when that was new.
		assert.equal(mcp.stderr().split("started it on demand").length - 1, 2, mcp.stderr());
		assert.ok(mcp.stderr().endsWith(`bgw mcp: ${WAITING}`), mcp.stderr());
		assert.deepEqual(mcp.junk, []);
	} finally {
		await mcp.stop();
		await ext.kill();
	}
	await stop(g);
});

// ---------------------------------------------------------------- several at once

test("several commands at the same moment start one daemon, and each of them gets its answer; the same for bgw daemon start", { skip: PROC }, async () => {
	const g = await scratch();
	const env = { ...g.env, ...ON };
	const results = await Promise.all(Array.from({ length: 5 }, () => bgw(["pages", "okapi"], env)));
	for (const r of results) {
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /hits=0/);
	}
	assert.deepEqual([daemonsOf(g.dataDir).length, listenings(g)], [1, 1], "one daemon, started once");
	assert.equal(results.filter((r) => STARTED(g).test(r.stderr)).length, 1, "one of them started it and said so");
	assert.deepEqual(results.filter((r) => r.stderr !== "" && !STARTED(g).test(r.stderr)).map((r) => r.stderr), []);
	assert.equal(record(g).pid, daemonsOf(g.dataDir)[0], "the pid file names it, so bgw daemon stop finds it");
	await stop(g);

	// The controller by itself: before it kept the order, a second start could take the unfinished pid file of the first for a stale one.
	const starts = await Promise.all(Array.from({ length: 4 }, () => bgw(["daemon", "start", "--json"], g.env)));
	const answers = starts.map((r) => JSON.parse(r.stdout));
	assert.deepEqual(starts.map((r) => r.code), [0, 0, 0, 0], starts.map((r) => r.stdout).join(""));
	assert.equal(answers.filter((a) => a.started === true).length, 1);
	assert.equal(answers.filter((a) => a.started === false && a.note === "the daemon is already running - not starting a second one").length, 3);
	assert.deepEqual([daemonsOf(g.dataDir).length, listenings(g), new Set(answers.map((a) => a.pid)).size], [1, 2, 1]);
	await stop(g);
	assert.equal(fs.readdirSync(g.dataDir).filter((n) => n.includes("lock")).length, 0, "the lock leaves no file behind");
});

test("bgw mcp: a daemon it started on demand and that is stopped from elsewhere does not stay a zombie while the helper lives", { skip: PROC }, async () => {
	const g = await scratch();
	const mcp = startMcp({ ...g.env, ...ON });
	try {
		const r = await mcp.request("tools/call", { name: "gateway_status", arguments: {} }, { timeoutMs: 40000 });
		assert.equal(r.result.isError, false, JSON.stringify(r));
		const pid = record(g).pid;
		assert.ok(fs.existsSync(`/proc/${pid}`));
		// Another process stops it, as the operator does.
		assert.equal((await bgw(["daemon", "stop"], g.env)).code, 0);
		let gone = false;
		for (let i = 0; i < 60 && !gone; i++) {
			gone = !fs.existsSync(`/proc/${pid}`);
			if (!gone) await sleep(50);
		}
		const state = gone ? "gone" : fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[0];
		assert.equal(state, "gone", `the process ${pid} is still there, state ${state} (Z: a zombie)`);
		// And the helper starts the next one when it is asked again.
		const again = await mcp.request("tools/call", { name: "gateway_status", arguments: {} }, { timeoutMs: 40000 });
		assert.equal(again.result.isError, false, JSON.stringify(again));
		assert.equal(daemonsOf(g.dataDir).length, 1);
	} finally {
		await mcp.stop();
	}
	await stop(g);
});
