// tools/deploy.sh against scratch locations only: a releases root, an autostart directory, a config and data
// directory, a home directory, a port and a Claude Code stand-in of the tests' own, all below the tests' temp root
// and all with a space in their name. Nothing here goes near ~/.local/share/browser-gateway, ~/.config, the
// real autostart folder, ~/.claude.json or port 8791: every gateway made here is checked against those
// before a command runs, and the check fails the test.
//
// The daemons these tests start are real ones, as processes of their own, from release copies made by "prepare"
// from HEAD (the real build). Each test stops what it started, also when it fails.

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";
import { closedPort } from "../helpers/squatter.js";

const REPO = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const DEPLOY = path.join(REPO, "tools", "deploy.sh");
const REAL_HOME = os.homedir();
// Where a real, running gateway lives: never read, never written, never bound by these tests.
const REAL_PLACES = [".local/share/browser-gateway", ".config/browser-gateway", ".config/autostart", ".claude.json", ".claude"].map((p) => path.join(REAL_HOME, p));

/** @returns {string | false} why the tests cannot run here */
function skipReason() {
	if (process.platform === "win32") return "POSIX shell scripts and systemd only";
	for (const tool of ["git", "python3", "sh", "tar"]) {
		if (spawnSync(tool, ["--version"], { stdio: "ignore" }).error !== undefined) return `${tool} is not available`;
	}
	if (spawnSync("git", ["-C", REPO, "rev-parse", "--verify", "HEAD^{commit}"], { stdio: "ignore" }).status !== 0) return "no git repository with a commit here";
	if (!fs.existsSync(path.join(REPO, "node_modules"))) return "node_modules is not installed";
	return false;
}
const SKIP = skipReason();

/** @param {string} name @param {(t: import("node:test").TestContext) => Promise<void>} fn */
function t(name, fn) {
	test(name, { skip: SKIP }, fn);
}

// What stands in for claude: it records its arguments next to itself and keeps one registration in files.
// Environment does not reach it from a sandbox, so everything it needs lies in its own directory.
//   registered  the arguments of the registration; no file, no registration
//   scope       the scope line of "mcp get", when it is not the user scope ("Local config (...)")
//   env         the variables of the registration, one NAME=value a line; an empty file is a heading without lines
//   get-broken  "mcp get" answers with something that is not its usual text
//   get-fails   "mcp get" fails without a word about the server
// As with the real one, "mcp remove --scope user" does not find a registration of another scope, and
// "mcp add" makes a plain one in the user scope. "fail-add" and "slow-add" are consumed by the next "mcp add".
const FAKE_CLAUDE = `#!/bin/sh
d=$(cd "$(dirname "$0")" && pwd)
printf '%s\\n' "$*" >> "$d/calls.log"
case "$1 $2" in
"mcp get")
	if [ -f "$d/get-broken" ]; then echo "a table, a spinner, anything but the usual lines"; exit 0; fi
	if [ -f "$d/get-fails" ]; then echo "claude: something of its own went wrong" >&2; exit 1; fi
	[ -f "$d/registered" ] || { echo "No MCP server found with name: $3" >&2; exit 1; }
	scope="User config (available in all your projects)"
	[ ! -f "$d/scope" ] || scope=$(cat "$d/scope")
	printf '%s:\\n  Scope: %s\\n  Status: Connected\\n  Type: stdio\\n  Command: python3\\n  Args: %s\\n' "$3" "$scope" "$(cat "$d/registered")"
	if [ -f "$d/env" ]; then
		printf '  Environment:\\n'
		sed 's/^/    /' "$d/env"
	fi
	printf '\\nTo remove this server, run: claude mcp remove "%s" -s user\\n' "$3"
	;;
"mcp remove")
	[ -f "$d/registered" ] || exit 1
	if [ -f "$d/scope" ]; then
		case "$(tr 'A-Z' 'a-z' < "$d/scope")" in
		"$4"*) ;;
		*) echo "No $4-scoped MCP server found with name: $5" >&2; exit 1 ;;
		esac
	fi
	rm -f "$d/registered" "$d/scope" "$d/env"
	;;
"mcp add")
	if [ -f "$d/fail-add" ]; then rm -f "$d/fail-add"; exit 1; fi
	if [ -f "$d/slow-add" ]; then rm -f "$d/slow-add"; sleep 30; fi
	shift 7
	printf '%s' "$*" > "$d/registered"
	rm -f "$d/scope" "$d/env"
	;;
*) exit 64 ;;
esac
`;

// What stands in for npm: "ci" makes a node_modules directory in the working directory.
const FAKE_NPM = `#!/bin/sh
d=$(cd "$(dirname "$0")" && pwd)
printf '%s | %s\\n' "$(pwd)" "$*" >> "$d/calls.log"
case "$1" in
--version) echo 0.0.0 ;;
ci) mkdir -p node_modules && : > node_modules/.package-lock.json ;;
*) exit 64 ;;
esac
`;

/** @type {string} */
let tmp;
/** @type {string} root of the shared release made by "prepare" from HEAD */
let preparedRoot;
/** @type {string} */
let preparedName;
/** @type {string} version of extension/manifest.json at HEAD */
let version;
/** @type {string} */
let head7;

/** @typedef {{ dir: string, root: string, auto: string, config: string, data: string, home: string, bin: string, claude: string, port: number, env: Record<string, string> }} Gateway */
/** @type {Gateway[]} */
const made = [];
/** @type {import("node:child_process").ChildProcess[]} */
const children = [];

/** @param {number} pid @returns {{ start: string, cwd: string, environ: string } | null} what /proc says about a process */
function proc(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return {
			start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
			cwd: fs.readlinkSync(`/proc/${pid}/cwd`),
			environ: fs.readFileSync(`/proc/${pid}/environ`, "utf8"),
		};
	} catch {
		return null;
	}
}

/** @param {Gateway} g @returns {{ pid: number, cwd: string } | null} */
function record(g) {
	try {
		const r = JSON.parse(fs.readFileSync(path.join(g.data, "daemon.pid"), "utf8"));
		return { pid: r.pid, cwd: r.cwd };
	} catch {
		return null;
	}
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The daemon of a scratch gateway, if one runs: only a process whose environment names this gateway's data directory. */
async function stopDaemon(/** @type {Gateway} */ g) {
	const r = record(g);
	if (r === null) return;
	const info = proc(r.pid);
	if (info === null || !info.environ.includes(`BGW_DATA_DIR=${g.data}\0`)) return;
	process.kill(r.pid, "SIGTERM");
	for (let i = 0; i < 100 && proc(r.pid) !== null; i++) await sleep(50);
	if (proc(r.pid) !== null) process.kill(r.pid, "SIGKILL");
}

/** @param {number} port @returns {Promise<boolean>} does anything listen there */
function listens(port) {
	return new Promise((resolve) => {
		const s = net.connect(port, "127.0.0.1");
		s.once("connect", () => {
			s.destroy();
			resolve(true);
		});
		s.once("error", () => resolve(false));
	});
}

afterEach(async () => {
	for (const c of children) {
		if (c.pid !== undefined && c.exitCode === null && c.signalCode === null) {
			try {
				process.kill(-c.pid, "SIGKILL");
			} catch {
				// gone already
			}
		}
	}
	children.length = 0;
	for (const g of made) await stopDaemon(g);
});

before(async () => {
	if (SKIP) return;
	tmp = makeTempDir("deploy");
	head7 = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim().slice(0, 7);
	version = JSON.parse(execFileSync("git", ["-C", REPO, "show", "HEAD:extension/manifest.json"], { encoding: "utf8" })).version;
	preparedName = `${version}-${head7}`;
	preparedRoot = path.join(tmp, "prepared root");
});

after(async () => {
	if (SKIP) return;
	for (const g of made) await stopDaemon(g);
	for (const g of made) assert.equal(await listens(g.port), false, `nothing may listen on ${g.port} any more`);
	removeTempDir(tmp);
});

/**
 * A scratch gateway: every location the tool can touch, below the temp root, with a space in each name.
 * @param {import("node:test").TestContext} ctx
 * @returns {Promise<Gateway>}
 */
async function scratch(ctx) {
	const dir = fs.mkdtempSync(path.join(tmp, "gw "));
	/** @type {Gateway} */
	const g = {
		dir,
		root: path.join(dir, "releases root"),
		auto: path.join(dir, "auto start"),
		config: path.join(dir, "config dir"),
		data: path.join(dir, "data dir"),
		home: path.join(dir, "home dir"),
		bin: path.join(dir, "fake bin"),
		claude: path.join(dir, "fake bin", "claude"),
		port: await closedPort(),
		env: {},
	};
	for (const d of [g.auto, g.config, g.home, g.bin]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
	fs.writeFileSync(g.claude, FAKE_CLAUDE, { mode: 0o755 });
	// No sound, whatever happens.
	fs.writeFileSync(path.join(g.config, "config.json"), JSON.stringify({ notify: { sound: false } }), { mode: 0o600 });
	g.env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: g.home,
		BGW_RELEASES_ROOT: g.root,
		BGW_AUTOSTART_DIR: g.auto,
		BGW_CONFIG_DIR: g.config,
		BGW_DATA_DIR: g.data,
		BGW_CLAUDE_BIN: g.claude,
		BGW_URL: `http://127.0.0.1:${g.port}`,
		BGW_TOKEN_FILE: path.join(g.config, "client.token"),
		BGW_ADMIN_TOKEN_FILE: path.join(g.config, "admin.token"),
		BGW_DEPLOY_WAIT_S: "20",
		// A bus that does not exist: the daemon cannot reach the desktop.
		DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(dir, "no-such-bus")}`,
	};
	assertScratch(g);
	ctx.diagnostic(`effective: root=${g.root} autostart=${g.auto} config=${g.config} data=${g.data} home=${g.home} claude=${g.claude} port=${g.port}`);
	made.push(g);
	return g;
}

/** Abort when anything a gateway would touch is a real location. @param {Gateway} g */
function assertScratch(g) {
	const places = { BGW_RELEASES_ROOT: g.root, BGW_AUTOSTART_DIR: g.auto, BGW_CONFIG_DIR: g.config, BGW_DATA_DIR: g.data, BGW_CLAUDE_BIN: g.claude, HOME: g.home };
	for (const [name, p] of Object.entries(places)) {
		assert.ok(path.resolve(p).startsWith(tmp + path.sep), `${name}=${p} is not below the tests' temp root`);
		assert.ok(p.includes(" "), `${name}=${p} has no space in it`);
		for (const real of REAL_PLACES) assert.ok(!path.resolve(p).startsWith(real), `${name}=${p} is a real location`);
	}
	assert.ok(![8791, 8792].includes(g.port), "a real port");
	assert.equal(g.env.BGW_URL, `http://127.0.0.1:${g.port}`);
	assert.notEqual(g.env.HOME, REAL_HOME);
}

/**
 * @param {Gateway} g
 * @param {string[]} args
 * @param {Record<string, string>} [over] environment to add
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function deploy(g, args, over = {}) {
	assertScratch(g);
	return new Promise((resolve) => {
		execFile("sh", [DEPLOY, ...args], { env: { ...g.env, ...over }, timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr }));
	});
}

/**
 * @param {Gateway} g
 * @param {string} dir a release or a checkout outside the releases root
 * @param {string[]} args
 */
function bgw(g, dir, args) {
	assertScratch(g);
	return new Promise((resolve) => {
		execFile("python3", [path.join(dir, "cli", "bgw"), ...args], { env: g.env, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr }));
	});
}

/**
 * A release in a gateway's root: a copy of the prepared one under another name, as prepare would have made it.
 * @param {Gateway} g
 * @param {string} short name of the commit part
 * @param {string} created
 * @param {boolean} [marked]
 * @returns {string} its path
 */
function addRelease(g, short, created, marked = true) {
	fs.mkdirSync(g.root, { recursive: true });
	const dest = path.join(g.root, `${version}-${short}`);
	execFileSync("cp", ["-a", path.join(preparedRoot, preparedName), dest]);
	const marker = path.join(dest, ".bgw-release");
	if (marked) fs.writeFileSync(marker, fs.readFileSync(marker, "utf8").replace(/^created=.*$/m, `created=${created}`));
	else fs.rmSync(marker);
	return dest;
}

/** @param {Gateway} g @param {string} name @returns {string | null} */
const link = (g, name) => {
	try {
		return fs.readlinkSync(path.join(g.root, name));
	} catch {
		return null;
	}
};

/** @param {Gateway} g @returns {string[]} the calls the fake claude has seen, "mcp get" left out */
const claudeCalls = (g) => {
	try {
		return fs
			.readFileSync(path.join(g.bin, "calls.log"), "utf8")
			.split("\n")
			.filter((l) => l !== "" && !l.startsWith("mcp get"));
	} catch {
		return [];
	}
};

/** @param {Gateway} g @returns {string | null} what Claude Code would start */
const registered = (g) => {
	try {
		return fs.readFileSync(path.join(g.bin, "registered"), "utf8");
	} catch {
		return null;
	}
};

/** @param {Gateway} g @returns {string} the Exec line of the autostart entry */
const autostartExec = (g) => (fs.readFileSync(path.join(g.auto, "browser-gateway.desktop"), "utf8").split("\n").find((l) => l.startsWith("Exec=")) ?? "");

/** @param {string} dir @returns {string[]} every path below it, with what it is, nothing followed */
function snapshot(dir) {
	/** @type {string[]} */
	const out = [];
	/** @param {string} d */
	const walk = (d) => {
		for (const name of fs.readdirSync(d).sort()) {
			const p = path.join(d, name);
			const st = fs.lstatSync(p);
			const rel = path.relative(dir, p);
			if (st.isSymbolicLink()) out.push(`l ${rel} -> ${fs.readlinkSync(p)}`);
			else if (st.isDirectory()) {
				out.push(`d ${rel}`);
				walk(p);
			} else out.push(`f ${rel} ${st.size} ${createHash("sha1").update(fs.readFileSync(p)).digest("hex")}`);
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return out;
}

/** @param {Gateway} g @param {string} name @returns {string | null} a file of the fake claude */
const claudeFile = (g, name) => {
	try {
		return fs.readFileSync(path.join(g.bin, name), "utf8");
	} catch {
		return null;
	}
};

/** @param {Gateway} g @returns {string[]} everything deploy.sh can change, except the daemon's own data */
const footprint = (g) => [
	...snapshot(g.root).map((l) => `root ${l}`),
	...snapshot(g.auto).map((l) => `auto ${l}`),
	`registered ${registered(g)} scope ${claudeFile(g, "scope")} env ${claudeFile(g, "env")}`,
	`calls ${claudeCalls(g).join(";")}`,
	`data ${fs.existsSync(g.data)}`,
];

/** @param {Gateway} g @param {string} release @param {string[]} [extra] activate with the usual switches */
async function activate(g, release, extra = ["--autostart", "--mcp"]) {
	const r = await deploy(g, ["activate", release, ...extra]);
	assert.equal(r.code, 0, r.stdout + r.stderr);
	return r;
}

// ---------------------------------------------------------------- prepare

t("prepare: a release from HEAD with the real build, nothing live touched, an existing directory refused", async (ctx) => {
	const g = await scratch(ctx);
	g.env.BGW_RELEASES_ROOT = preparedRoot;
	fs.mkdirSync(path.dirname(preparedRoot), { recursive: true });
	assert.ok(path.resolve(preparedRoot).startsWith(tmp + path.sep) && preparedRoot.includes(" "));

	const r = await deploy(g, ["prepare", "HEAD"]);
	assert.equal(r.code, 0, r.stdout + r.stderr);
	const rel = path.join(fs.realpathSync(preparedRoot), preparedName);
	const xpi = path.join(rel, "dist", `browser-gateway-${version}.xpi`);
	assert.ok(r.stdout.split("\n").includes(`deploy: xpi: ${xpi}`), r.stdout);
	assert.equal(fs.readFileSync(xpi).subarray(0, 2).toString(), "PK");
	assert.ok(r.stdout.includes("vendor check passed"), "the vendored bundle was checked on the host");
	const marker = fs.readFileSync(path.join(rel, ".bgw-release"), "utf8");
	assert.match(marker, new RegExp(`^bgw-deploy-release=1\\nversion=${version.replaceAll(".", "\\.")}\\ncommit=${head7}[0-9a-f]{33}\\ncreated=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\\n$`));
	assert.equal(fs.readlinkSync(path.join(rel, "node_modules")), path.join(REPO, "node_modules"));
	for (const f of ["cli/bgw", "cli/bgw_daemonctl.py", "daemon/src/main.js", "tools/autostart.sh", "extension/manifest.json"]) assert.ok(fs.existsSync(path.join(rel, f)), f);
	// The release is the commit, and nothing else is in the root: no staging directory, no link, no lock.
	assert.deepEqual(fs.readdirSync(preparedRoot), [preparedName]);
	assert.equal(fs.existsSync(path.join(g.data)), false, "nothing of a real setup was made");
	assert.deepEqual(fs.readdirSync(g.auto), []);
	assert.deepEqual(claudeCalls(g), []);

	// The same commit again: refused, and nothing moves.
	const before = snapshot(preparedRoot);
	const again = await deploy(g, ["prepare", "HEAD"]);
	assert.equal(again.code, 2);
	assert.match(again.stderr, /exists already - refusing to prepare into it/);
	assert.deepEqual(snapshot(preparedRoot), before);

	// A commit that is not there.
	const bad = await deploy(g, ["prepare", "no-such-commit-1234"]);
	assert.equal(bad.code, 2);
	assert.match(bad.stderr, /no such commit/);
	assert.deepEqual(snapshot(preparedRoot), before);
	assert.equal((await deploy(g, ["prepare"])).code, 2);
});

t("prepare --install-deps runs npm ci --omit=dev in the new release instead of linking node_modules", async (ctx) => {
	const g = await scratch(ctx);
	const npm = path.join(g.bin, "npm");
	fs.writeFileSync(npm, FAKE_NPM, { mode: 0o755 });
	const r = await deploy(g, ["prepare", "HEAD", "--install-deps"], { BGW_NPM_BIN: npm });
	assert.equal(r.code, 0, r.stdout + r.stderr);
	const rel = path.join(fs.realpathSync(g.root), preparedName);
	assert.equal(fs.lstatSync(path.join(rel, "node_modules")).isSymbolicLink(), false);
	const calls = fs.readFileSync(path.join(g.bin, "calls.log"), "utf8").split("\n").filter((l) => l !== "");
	assert.equal(calls.length, 2);
	assert.match(calls[0], / \| --version$/);
	assert.match(calls[1], new RegExp(`^${path.join(g.root, ".prepare-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.* \\| ci --omit=dev$`));
	assert.deepEqual(fs.readdirSync(g.root), [preparedName]);
});

t("prepare that fails half way leaves no directory and no staging behind", async (ctx) => {
	const g = await scratch(ctx);
	// A node that cannot check the vendored bundle: the failure comes after the copy and the build.
	const node = path.join(g.bin, "node");
	fs.writeFileSync(node, '#!/bin/sh\ncase "$1" in --version) echo v0 ;; *) echo "fake node: no" >&2; exit 1 ;; esac\n', { mode: 0o755 });
	const r = await deploy(g, ["prepare", "HEAD"], { BGW_NODE_BIN: node });
	assert.notEqual(r.code, 0);
	assert.match(r.stdout, /checking the vendored bundle/);
	assert.deepEqual(fs.readdirSync(g.root), [], "the root is empty: no release, no staging directory, no archive");
	// And the same commit can be prepared afterwards.
	const ok = await deploy(g, ["prepare", "HEAD"]);
	assert.equal(ok.code, 0, ok.stdout + ok.stderr);
	assert.deepEqual(fs.readdirSync(g.root), [preparedName]);
});

// ---------------------------------------------------------------- activate, status, rollback

t("activate: the first time, again, and from one release to the next; status, list and rollback agree with it", async (ctx) => {
	const g = await scratch(ctx);
	const a = addRelease(g, "aaaaaaa", "2026-01-01T00:00:00Z");
	const b = addRelease(g, "bbbbbbb", "2026-02-01T00:00:00Z");

	// First time: nothing is current, no daemon runs.
	const first = await activate(g, a);
	assert.match(first.stdout, /starting the daemon of .*aaaaaaa: bgw daemon start/);
	assert.match(first.stdout, /bgw doctor: reachable and proven/);
	assert.match(first.stdout, /Do NOT remove the add-on first/);
	assert.ok(first.stdout.includes(`XPI: ${path.join(a, "dist", `browser-gateway-${version}.xpi`)}`));
	assert.equal(link(g, "current"), a);
	assert.equal(link(g, "previous"), null);
	const recA = record(g);
	assert.ok(recA !== null && proc(recA.pid) !== null);
	assert.equal(recA.cwd, a);
	assert.ok(autostartExec(g).includes(`"${path.join(a, "cli", "bgw")}" daemon start`));
	assert.equal(registered(g), `${path.join(a, "cli", "bgw")} mcp`);
	assert.deepEqual(claudeCalls(g), [`mcp add --scope user browser-gateway -- python3 ${path.join(a, "cli", "bgw")} mcp`]);
	assert.deepEqual(fs.readdirSync(g.root).sort(), [path.basename(a), path.basename(b), "current"].sort(), "no lock, no temporary link left");

	// The same release again: the daemon is not restarted, the rest is made sure of.
	const second = await activate(g, a);
	assert.match(second.stdout, /runs already - not restarting it/);
	assert.deepEqual(record(g), recA);
	assert.equal(proc(recA.pid)?.cwd, a);
	assert.equal(link(g, "previous"), null, "previous is not set to the release that is current");
	assert.equal(registered(g), `${path.join(a, "cli", "bgw")} mcp`);

	const consistent = await deploy(g, ["status"]);
	assert.equal(consistent.code, 0, consistent.stdout + consistent.stderr);
	assert.match(consistent.stdout, new RegExp(`current:  ${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
	assert.match(consistent.stdout, new RegExp(`daemon:   running, pid ${recA.pid}, 127\\.0\\.0\\.1:${g.port}, from .*, daemon version \\S+ \\(proven\\)`));
	assert.match(consistent.stdout, /autostart: .*starts the daemon of .*aaaaaaa\n/);
	assert.match(consistent.stdout, /mcp:      Claude Code starts .*aaaaaaa\/cli\/bgw mcp\n/);
	assert.match(consistent.stdout, /result: everything that is set points at current/);

	// To the next release: the old daemon ends, the new one runs, the entry and the registration are replaced.
	const sw = await activate(g, b);
	assert.equal(proc(recA.pid), null, "the daemon of the old release is gone");
	const recB = record(g);
	assert.ok(recB !== null && recB.pid !== recA.pid && proc(recB.pid) !== null);
	assert.equal(recB.cwd, b);
	assert.equal(link(g, "current"), b);
	assert.equal(link(g, "previous"), a);
	assert.ok(autostartExec(g).includes(`"${path.join(b, "cli", "bgw")}" daemon start`));
	assert.equal(registered(g), `${path.join(b, "cli", "bgw")} mcp`);
	assert.ok(claudeCalls(g).includes("mcp remove --scope user browser-gateway"));
	assert.match(sw.stdout, /stopping the daemon of .*aaaaaaa, if one runs: bgw daemon stop/);

	// A registration that does not point at current is flagged.
	fs.writeFileSync(path.join(g.bin, "registered"), `${path.join(a, "cli", "bgw")} mcp`);
	const flagged = await deploy(g, ["status"]);
	assert.equal(flagged.code, 1);
	assert.match(flagged.stdout, /mcp:      Claude Code starts .*aaaaaaa\/cli\/bgw mcp\ndeploy:   DOES NOT POINT AT CURRENT\n/);
	assert.match(flagged.stdout, /result: 1 item\(s\) do not point at current/);
	fs.writeFileSync(path.join(g.bin, "registered"), `${path.join(b, "cli", "bgw")} mcp`);

	const ls = await deploy(g, ["list"]);
	assert.equal(ls.code, 0);
	assert.match(ls.stdout, /bbbbbbb\s+2026-02-01T00:00:00Z current\n/);
	assert.match(ls.stdout, /aaaaaaa\s+2026-01-01T00:00:00Z previous\n/);

	// rollback --dry-run changes nothing.
	const quiet = footprint(g);
	const dry = await deploy(g, ["rollback", "--autostart", "--mcp", "--dry-run"]);
	assert.equal(dry.code, 0, dry.stdout + dry.stderr);
	assert.match(dry.stdout, /\(dry run\) current -> .*aaaaaaa/);
	assert.deepEqual(footprint(g), quiet);
	assert.deepEqual(record(g), recB);

	// rollback: the release that was current before is current again; the add-on is not the tool's to move.
	const back = await deploy(g, ["rollback", "--mcp"]);
	assert.equal(back.code, 0, back.stdout + back.stderr);
	assert.equal(proc(recB.pid), null);
	assert.equal(record(g)?.cwd, a);
	assert.equal(link(g, "current"), a);
	assert.equal(link(g, "previous"), b);
	assert.ok(autostartExec(g).includes(`"${path.join(a, "cli", "bgw")}" daemon start`), "an entry of ours is moved along");
	assert.equal(registered(g), `${path.join(a, "cli", "bgw")} mcp`);
	const final = await deploy(g, ["status"]);
	assert.equal(final.code, 0, final.stdout);
});

t("activate from a copy outside the releases root with --from, and rollback to it", async (ctx) => {
	const g = await scratch(ctx);
	const b = addRelease(g, "bbbbbbb", "2026-02-01T00:00:00Z");
	const stop = path.join(g.dir, "stop gap", "live-0.1.5");
	fs.mkdirSync(path.dirname(stop));
	execFileSync("cp", ["-a", path.join(preparedRoot, preparedName), stop]);
	fs.rmSync(path.join(stop, ".bgw-release"));
	// A copy outside the releases root is how a setup looks before the first activation: its daemon, its autostart entry, its registration.
	assert.equal((await bgw(g, stop, ["daemon", "start"])).code, 0);
	assert.equal((await new Promise((resolve) => execFile("sh", [path.join(stop, "tools", "autostart.sh"), "install"], { env: g.env }, (e) => resolve(e === null ? 0 : 1)))), 0);
	fs.writeFileSync(path.join(g.bin, "registered"), `${path.join(stop, "cli", "bgw")} mcp`);
	const recStop = record(g);
	assert.equal(recStop?.cwd, stop);

	// Without --from the daemon of the outside copy cannot be stopped by the new release: refused, nothing changed.
	const refused = await deploy(g, ["activate", b, "--autostart", "--mcp"]);
	assert.equal(refused.code, 1);
	assert.match(refused.stderr, /FAILED: bgw daemon stop of .* failed \(name the release the running daemon was started from with --from\)/);
	assert.equal(link(g, "current"), null);
	assert.equal(record(g)?.pid, recStop?.pid, "the daemon of the outside copy still runs");
	assert.equal(proc(recStop?.pid ?? 0)?.cwd, stop);
	assert.ok(autostartExec(g).includes(stop));
	assert.equal(registered(g), `${path.join(stop, "cli", "bgw")} mcp`);

	// With --from it goes over, and the outside copy is kept as the release to go back to.
	const r = await deploy(g, ["activate", b, "--from", stop, "--autostart", "--mcp"]);
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.equal(proc(recStop?.pid ?? 0), null);
	assert.equal(record(g)?.cwd, b);
	assert.equal(link(g, "current"), b);
	assert.equal(link(g, "previous"), stop);
	assert.ok(autostartExec(g).includes(b));
	assert.equal(registered(g), `${path.join(b, "cli", "bgw")} mcp`);

	// A copy outside the root is never pruned.
	const kept = await deploy(g, ["prune", "--keep", "0", "--yes"]);
	assert.equal(kept.code, 0, kept.stdout + kept.stderr);
	assert.ok(fs.existsSync(path.join(stop, "cli", "bgw")));

	const back = await deploy(g, ["rollback", "--autostart", "--mcp"]);
	assert.equal(back.code, 0, back.stdout + back.stderr);
	assert.equal(record(g)?.cwd, stop);
	assert.equal(link(g, "current"), stop);
	assert.equal(link(g, "previous"), b);
	assert.ok(autostartExec(g).includes(stop));
	assert.equal(registered(g), `${path.join(stop, "cli", "bgw")} mcp`);
});

t("activate with --autostart makes an entry where none is; without it none is made and a foreign file is left alone", async (ctx) => {
	const g = await scratch(ctx);
	const a = addRelease(g, "aaaaaaa", "2026-01-01T00:00:00Z");
	const entry = path.join(g.auto, "browser-gateway.desktop");

	const plain = await activate(g, a, []);
	assert.match(plain.stdout, /no entry of ours exists - none is made/);
	assert.match(plain.stdout, /the Claude Code registration was not changed/);
	assert.equal(fs.existsSync(entry), false);
	assert.deepEqual(claudeCalls(g), []);
	await stopDaemon(g);

	// A file of that name that autostart.sh did not write.
	fs.writeFileSync(entry, "[Desktop Entry]\nExec=something-else\n");
	const foreign = await deploy(g, ["activate", a, "--autostart"]);
	assert.equal(foreign.code, 2);
	assert.match(foreign.stderr, /was not written by autostart\.sh - not touching it/);
	const left = await deploy(g, ["activate", a]);
	assert.equal(left.code, 0, left.stdout + left.stderr);
	assert.equal(fs.readFileSync(entry, "utf8"), "[Desktop Entry]\nExec=something-else\n");
	await stopDaemon(g);
	fs.rmSync(entry);

	const made1 = await activate(g, a, ["--autostart"]);
	assert.match(made1.stdout, /autostart: wrote /);
	assert.ok(autostartExec(g).includes(path.join(a, "cli", "bgw")));
});

// ---------------------------------------------------------------- failures

t("a daemon that does not start: the previous release is brought back, nothing else has moved", async (ctx) => {
	const g = await scratch(ctx);
	const a = addRelease(g, "aaaaaaa", "2026-01-01T00:00:00Z");
	const c = addRelease(g, "ccccccc", "2026-03-01T00:00:00Z");
	// A release that ends at once.
	fs.writeFileSync(path.join(c, "daemon", "src", "main.js"), "process.exit(3);\n");
	await activate(g, a);
	const recA = record(g);
	const entryBefore = fs.readFileSync(path.join(g.auto, "browser-gateway.desktop"), "utf8");
	const callsBefore = claudeCalls(g);

	const r = await deploy(g, ["activate", c, "--autostart", "--mcp"]);
	assert.equal(r.code, 1);
	assert.match(r.stderr, /FAILED: bgw daemon start of .*ccccccc failed/);
	assert.match(r.stdout, /going back to the state before activate/);
	assert.match(r.stdout, /starting the daemon of .*aaaaaaa again/);
	assert.match(r.stdout, /state now:/);
	assert.match(r.stdout, /current symlink: .*aaaaaaa \(not moved\)/);
	const rec = record(g);
	assert.ok(rec !== null && recA !== null && proc(rec.pid) !== null, "a daemon runs");
	assert.equal(rec.cwd, a);
	assert.notEqual(rec.pid, recA.pid, "the old daemon was stopped and started again");
	assert.equal(link(g, "current"), a);
	assert.equal(link(g, "previous"), null);
	assert.equal(fs.readFileSync(path.join(g.auto, "browser-gateway.desktop"), "utf8"), entryBefore);
	assert.deepEqual(claudeCalls(g), callsBefore, "Claude Code was not asked to change anything");
	assert.deepEqual(fs.readdirSync(g.root).sort(), [path.basename(a), path.basename(c), "current"].sort());
	assert.equal((await deploy(g, ["status"])).code, 0);
});

t("a step after the daemon fails: autostart, the registration and the daemon are put back", async (ctx) => {
	const g = await scratch(ctx);
	const a = addRelease(g, "aaaaaaa", "2026-01-01T00:00:00Z");
	const b = addRelease(g, "bbbbbbb", "2026-02-01T00:00:00Z");
	await activate(g, a);
	const recA = record(g);
	const entryBefore = fs.readFileSync(path.join(g.auto, "browser-gateway.desktop"), "utf8");
	const registeredBefore = registered(g);

	// The new daemon is up and proven, the entry is replaced - then "claude mcp add" fails once.
	fs.writeFileSync(path.join(g.bin, "fail-add"), "");
	const r = await deploy(g, ["activate", b, "--autostart", "--mcp"]);
	assert.equal(r.code, 1);
	assert.match(r.stderr, /FAILED: claude mcp remove or add failed/);
	assert.match(r.stdout, /stopping the daemon of .*bbbbbbb/);
	assert.match(r.stdout, /putting the autostart entry back as it was/);
	assert.match(r.stdout, /registering .*aaaaaaa again in Claude Code/);
	assert.equal(fs.readFileSync(path.join(g.auto, "browser-gateway.desktop"), "utf8"), entryBefore);
	assert.equal(registered(g), registeredBefore);
	const rec = record(g);
	assert.ok(rec !== null && recA !== null && proc(rec.pid) !== null);
	assert.equal(rec.cwd, a);
	assert.equal(link(g, "current"), a);
	assert.equal(link(g, "previous"), null);
	assert.equal((await deploy(g, ["status"])).code, 0);
	assert.deepEqual(fs.readdirSync(g.root).sort(), [path.basename(a), path.basename(b), "current"].sort(), "no lock or backup left");
});

t("an interrupt in the middle of activate goes the same way back", async (ctx) => {
	const g = await scratch(ctx);
	const a = addRelease(g, "aaaaaaa", "2026-01-01T00:00:00Z");
	const b = addRelease(g, "bbbbbbb", "2026-02-01T00:00:00Z");
	await activate(g, a);
	const registeredBefore = registered(g);
	const callsBefore = claudeCalls(g).length;

	// "claude mcp add" hangs; the user presses Ctrl-C, which reaches the whole foreground group.
	fs.writeFileSync(path.join(g.bin, "slow-add"), "");
	assertScratch(g);
	const child = spawn("sh", [DEPLOY, "activate", b, "--mcp"], { env: g.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	children.push(child);
	let out = "";
	child.stdout?.on("data", (d) => (out += d));
	child.stderr?.on("data", (d) => (out += d));
	const done = new Promise((resolve) => child.once("close", (code) => resolve(code)));
	for (let i = 0; i < 400 && claudeCalls(g).length <= callsBefore + 1; i++) await sleep(50);
	assert.ok(claudeCalls(g).length > callsBefore + 1, "activate reached the registration: " + out);
	process.kill(-(/** @type {number} */ (child.pid)), "SIGTERM");
	const code = await done;
	assert.equal(code, 1, out);
	assert.match(out, /going back to the state before activate/);
	assert.equal(registered(g), registeredBefore);
	assert.equal(record(g)?.cwd, a);
	assert.equal(link(g, "current"), a);
	assert.deepEqual(fs.readdirSync(g.root).sort(), [path.basename(a), path.basename(b), "current"].sort());
});

t("--mcp leaves a registration alone that is more than the plain one: another scope, environment variables, or one it cannot read", async (ctx) => {
	const g = await scratch(ctx);
	const a = addRelease(g, "aaaaaaa", "2026-01-01T00:00:00Z");
	const b = addRelease(g, "bbbbbbb", "2026-02-01T00:00:00Z");
	await activate(g, a);
	const recA = record(g);
	const plain = `${path.join(a, "cli", "bgw")} mcp`;
	assert.equal(registered(g), plain);

	/** @param {string[]} args @param {RegExp[]} messages */
	const refused = async (args, messages) => {
		const quiet = footprint(g);
		const r = await deploy(g, args);
		assert.equal(r.code, 2, r.stdout + r.stderr);
		for (const m of messages) assert.match(r.stderr, m);
		assert.match(r.stderr, /Nothing was changed\./);
		assert.deepEqual(footprint(g), quiet, "no link, no entry, no registration and no call to change one");
		assert.deepEqual(record(g), recA, "the daemon that ran still runs");
		assert.equal(link(g, "current"), a);
		return r;
	};

	// Registered by hand with variables: "claude mcp add -e BGW_URL=... -e BGW_DOWNLOAD_DIR=...". A plain one in
	// its place would talk to another port and save files elsewhere. The values are not printed: they can be secrets.
	fs.writeFileSync(path.join(g.bin, "env"), "BGW_URL=http://127.0.0.1:9\nBGW_DOWNLOAD_DIR=/somewhere/private-dir\n");
	const withEnv = await refused(["activate", b, "--mcp"], [
		/^deploy: the Claude Code registration browser-gateway is not the plain one this tool makes \(it carries environment variables\), and --mcp would replace it by a plain one in the user scope\. Nothing was changed\.\n/,
		/^deploy: {3}found: scope: User config \(available in all your projects\); command: python3; starts: .*aaaaaaa\/cli\/bgw mcp; environment: BGW_URL BGW_DOWNLOAD_DIR\n/m,
		/^deploy: {5}claude mcp remove --scope user browser-gateway\n/m,
		/^deploy: {5}claude mcp add --scope user --env BGW_URL=<value> --env BGW_DOWNLOAD_DIR=<value> browser-gateway -- python3 .*bbbbbbb\/cli\/bgw mcp\n/m,
		/^deploy: {3}and run this again without --mcp\.\n/m,
	]);
	assert.doesNotMatch(withEnv.stdout + withEnv.stderr, /127\.0\.0\.1:9\b|private-dir/);
	// A dry run and a rollback read the same registration and say the same.
	await refused(["activate", b, "--mcp", "--dry-run"], [/it carries environment variables/]);
	// status shows it, without counting it as something that does not point at current.
	const status = await deploy(g, ["status"]);
	assert.equal(status.code, 0, status.stdout);
	assert.match(status.stdout, /mcp: {6}Claude Code starts .*aaaaaaa\/cli\/bgw mcp\ndeploy: {3}not the plain registration this tool makes \(it carries environment variables\): activate --mcp will not replace it\n/);
	// A heading without a line below it is no variable.
	fs.writeFileSync(path.join(g.bin, "env"), "");
	assert.equal((await deploy(g, ["activate", a, "--mcp"])).code, 0);

	// In the local scope of some project: "remove --scope user" would not find it, and after the daemon had been
	// moved the whole activation would have to be undone. Said before anything is moved.
	fs.writeFileSync(path.join(g.bin, "scope"), "Local config (private to you in this project)");
	await refused(["activate", b, "--mcp"], [/\(it is not in the user scope\)/, /found: scope: Local config \(private to you in this project\);/, /claude mcp remove --scope local browser-gateway\n/, /claude mcp add --scope local browser-gateway -- python3 /]);
	fs.writeFileSync(path.join(g.bin, "scope"), "Project config (shared via .mcp.json)");
	fs.writeFileSync(path.join(g.bin, "env"), "BGW_URL=x\n");
	await refused(["activate", b, "--mcp"], [/\(it is not in the user scope, it carries environment variables\)/, /claude mcp add --scope project --env BGW_URL=<value> browser-gateway -- /]);
	fs.rmSync(path.join(g.bin, "scope"));
	fs.rmSync(path.join(g.bin, "env"));

	// Another program, or more arguments than "mcp".
	fs.writeFileSync(path.join(g.bin, "registered"), `${path.join(a, "cli", "bgw")} mcp --something`);
	await refused(["activate", b, "--mcp"], [/\(its arguments are not <release>\/cli\/bgw mcp\)/, /starts: not readable;/]);
	// An answer that is not the usual text at all.
	fs.writeFileSync(path.join(g.bin, "registered"), plain);
	fs.writeFileSync(path.join(g.bin, "get-broken"), "");
	await refused(["activate", b, "--mcp"], [/\(its scope could not be read, its arguments are not <release>\/cli\/bgw mcp\)/, /claude mcp remove --scope <its scope> browser-gateway\n/]);
	fs.rmSync(path.join(g.bin, "get-broken"));

	// Without --mcp none of this is looked at: the activation goes through and the registration is as it was.
	fs.writeFileSync(path.join(g.bin, "scope"), "Local config (private to you in this project)");
	fs.writeFileSync(path.join(g.bin, "env"), "BGW_URL=http://127.0.0.1:9\n");
	const callsBefore = claudeCalls(g);
	const r = await deploy(g, ["activate", b]);
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.equal(link(g, "current"), b);
	assert.deepEqual([registered(g), claudeFile(g, "scope"), claudeFile(g, "env")], [plain, "Local config (private to you in this project)", "BGW_URL=http://127.0.0.1:9\n"]);
	assert.deepEqual(claudeCalls(g), callsBefore);
});

t("an autostart entry of ours whose command was changed by hand is not replaced", async (ctx) => {
	const g = await scratch(ctx);
	const a = addRelease(g, "aaaaaaa", "2026-01-01T00:00:00Z");
	const b = addRelease(g, "bbbbbbb", "2026-02-01T00:00:00Z");
	await activate(g, a, ["--autostart"]);
	const recA = record(g);
	const entry = path.join(g.auto, "browser-gateway.desktop");
	// A variable in front of the command: the entry is still marked as ours, and a new one would drop the variable.
	const edited = fs.readFileSync(entry, "utf8").replace(/^Exec=(.*)$/m, "Exec=env BGW_URL=http://127.0.0.1:9 $1");
	assert.match(edited, /^Exec=env BGW_URL=/m);
	fs.writeFileSync(entry, edited);
	const quiet = footprint(g);
	for (const args of [["activate", b], ["activate", b, "--autostart"]]) {
		const r = await deploy(g, args);
		assert.equal(r.code, 2, r.stdout + r.stderr);
		assert.match(r.stderr, /^deploy: the autostart entry .*browser-gateway\.desktop is one of tools\/autostart\.sh, but its Exec line is not as that tool writes it \(changed by hand\?\)\. Replacing it would drop the change\. Nothing was changed\./);
		assert.deepEqual(footprint(g), quiet);
		assert.deepEqual(record(g), recA);
	}
	assert.equal(fs.readFileSync(entry, "utf8"), edited);
});

t("the two links are moved last, one after the other: a run that fails or is cut short between them puts previous back", async (ctx) => {
	const g = await scratch(ctx);
	const a = addRelease(g, "aaaaaaa", "2026-01-01T00:00:00Z");
	const b = addRelease(g, "bbbbbbb", "2026-02-01T00:00:00Z");
	const c = addRelease(g, "ccccccc", "2026-03-01T00:00:00Z");
	await activate(g, a, []);
	await activate(g, b, []);
	assert.deepEqual([link(g, "current"), link(g, "previous")], [b, a]);

	// A python3 in front of the real one that looks at one call only: the rename that moves "current".
	const real = execFileSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();
	const shim = path.join(g.dir, "shim bin");
	fs.mkdirSync(shim);
	fs.writeFileSync(
		path.join(shim, "python3"),
		`#!/bin/sh\nd=$(cd "$(dirname "$0")" && pwd)\nfor last; do :; done\ncase "$1 $last" in\n"-c "*/current)\n\tif [ -f "$d/fail-current" ]; then rm -f "$d/fail-current"; exit 1; fi\n\tif [ -f "$d/stall-current" ]; then rm -f "$d/stall-current"; readlink "$(dirname "$last")/previous" > "$d/previous-then"; sleep 30; fi\n\t;;\nesac\nexec "${real}" "$@"\n`,
		{ mode: 0o755 },
	);
	const over = { PATH: `${shim}:${g.env.PATH}` };

	// The move of "current" fails after "previous" was moved to b.
	fs.writeFileSync(path.join(shim, "fail-current"), "");
	const failed = await deploy(g, ["activate", c], over);
	assert.equal(failed.code, 1, failed.stdout + failed.stderr);
	assert.match(failed.stderr, /FAILED: cannot move the current symlink/);
	assert.match(failed.stdout, /previous -> .*bbbbbbb\n/);
	assert.match(failed.stdout, /putting the previous symlink back: .*aaaaaaa\n/);
	assert.match(failed.stdout, /current symlink: .*bbbbbbb \(put back\)\ndeploy: {3}previous symlink: .*aaaaaaa \(put back\)\n/);
	assert.deepEqual([link(g, "current"), link(g, "previous")], [b, a]);
	assert.equal(record(g)?.cwd, b, "the daemon of the release that was current runs again");
	assert.deepEqual(fs.readdirSync(g.root).sort(), [a, b, c].map((p) => path.basename(p)).concat(["current", "previous"]).sort(), "no half-made link is left");
	assert.equal((await deploy(g, ["status"])).code, 0);

	// The same moment, and the user presses Ctrl-C.
	fs.writeFileSync(path.join(shim, "stall-current"), "");
	assertScratch(g);
	const child = spawn("sh", [DEPLOY, "activate", c], { env: { ...g.env, ...over }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	children.push(child);
	let out = "";
	child.stdout?.on("data", (d) => (out += d));
	child.stderr?.on("data", (d) => (out += d));
	const done = new Promise((resolve) => child.once("close", (code) => resolve(code)));
	for (let i = 0; i < 600 && !fs.existsSync(path.join(shim, "previous-then")); i++) await sleep(50);
	assert.equal(fs.readFileSync(path.join(shim, "previous-then"), "utf8").trim(), b, "previous had been moved when the run was cut short: " + out);
	process.kill(-(/** @type {number} */ (child.pid)), "SIGINT");
	assert.equal(await done, 1, out);
	assert.match(out, /going back to the state before activate/);
	assert.deepEqual([link(g, "current"), link(g, "previous")], [b, a]);
	assert.equal(record(g)?.cwd, b);
	assert.deepEqual(fs.readdirSync(g.root).sort(), [a, b, c].map((p) => path.basename(p)).concat(["current", "previous"]).sort());

	// Where there was no previous before, none is left behind.
	const h = await scratch(ctx);
	const a2 = addRelease(h, "aaaaaaa", "2026-01-01T00:00:00Z");
	const b2 = addRelease(h, "bbbbbbb", "2026-02-01T00:00:00Z");
	await activate(h, a2, []);
	fs.writeFileSync(path.join(shim, "fail-current"), "");
	const first = await deploy(h, ["activate", b2], over);
	assert.equal(first.code, 1, first.stdout + first.stderr);
	assert.match(first.stdout, /removing the previous symlink that activate made\n/);
	assert.deepEqual([link(h, "current"), link(h, "previous")], [a2, null]);
});

// ---------------------------------------------------------------- refusals, dry runs, prune

t("activate refuses what is not a release of this tool, a current that is no link, and a second deploy at the same time", async (ctx) => {
	const g = await scratch(ctx);
	const a = addRelease(g, "aaaaaaa", "2026-01-01T00:00:00Z");
	const unmarked = addRelease(g, "uuuuuuu", "2026-01-01T00:00:00Z", false);
	const outside = path.join(g.dir, "elsewhere");
	execFileSync("cp", ["-a", a, outside]);
	const quiet = footprint(g);

	const noMarker = await deploy(g, ["activate", unmarked, "--autostart", "--mcp"]);
	assert.equal(noMarker.code, 2);
	assert.match(noMarker.stderr, /has no \.bgw-release: it was not made by deploy\.sh prepare/);
	const out = await deploy(g, ["activate", outside]);
	assert.equal(out.code, 2);
	assert.match(out.stderr, /is not directly inside the releases root/);
	const missing = await deploy(g, ["activate", path.join(g.root, "no-such")]);
	assert.equal(missing.code, 2);
	assert.equal((await deploy(g, ["rollback"])).code, 2);
	assert.deepEqual(footprint(g), quiet);
	assert.equal(record(g), null, "no daemon was started");

	fs.mkdirSync(path.join(g.root, "current"));
	const dir = await deploy(g, ["activate", a]);
	assert.equal(dir.code, 2);
	assert.match(dir.stderr, /is not a symlink - not touching it/);
	fs.rmdirSync(path.join(g.root, "current"));

	fs.mkdirSync(path.join(g.root, ".deploy.lock"));
	const locked = await deploy(g, ["activate", a]);
	assert.equal(locked.code, 2);
	assert.match(locked.stderr, /another deploy\.sh runs, or one was killed/);
	assert.equal(record(g), null);
	fs.rmdirSync(path.join(g.root, ".deploy.lock"));
});

t("--dry-run on activate and prune changes nothing and starts nothing", async (ctx) => {
	const g = await scratch(ctx);
	const a = addRelease(g, "aaaaaaa", "2026-01-01T00:00:00Z");
	addRelease(g, "bbbbbbb", "2026-02-01T00:00:00Z");
	const quiet = footprint(g);
	const r = await deploy(g, ["activate", a, "--autostart", "--mcp", "--dry-run"]);
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /\(dry run\) starting the daemon of .*aaaaaaa/);
	assert.match(r.stdout, /\(dry run\) replacing the autostart entry/);
	assert.match(r.stdout, /\(dry run\) registering .*aaaaaaa as the Claude Code MCP server/);
	assert.match(r.stdout, /\(dry run\) current -> .*aaaaaaa/);
	assert.deepEqual(footprint(g), quiet);
	assert.equal(record(g), null);
	assert.equal(await listens(g.port), false);

	const p = await deploy(g, ["prune", "--keep", "0", "--dry-run", "--yes"]);
	assert.equal(p.code, 0, p.stdout + p.stderr);
	assert.match(p.stdout, /would remove /);
	assert.deepEqual(footprint(g), quiet);
});

t("prune removes only old releases of this tool, never current, previous, a directory without the marker or a link, and only with --yes", async (ctx) => {
	const g = await scratch(ctx);
	const r1 = addRelease(g, "1111111", "2026-01-01T00:00:00Z");
	const r2 = addRelease(g, "2222222", "2026-02-01T00:00:00Z");
	const r3 = addRelease(g, "3333333", "2026-03-01T00:00:00Z");
	const r4 = addRelease(g, "4444444", "2026-04-01T00:00:00Z");
	const r5 = addRelease(g, "5555555", "2026-05-01T00:00:00Z");
	const unmarked = addRelease(g, "0000000", "2025-01-01T00:00:00Z", false);
	// A link named like a release, to a directory with a marker: a link is never followed.
	const target = path.join(g.dir, "link target");
	execFileSync("cp", ["-a", r1, target]);
	fs.symlinkSync(target, path.join(g.root, `${version}-ddddddd`));
	fs.symlinkSync(r4, path.join(g.root, "current"));
	fs.symlinkSync(r2, path.join(g.root, "previous"));
	const quiet = footprint(g);

	assert.equal((await deploy(g, ["prune"])).code, 2, "--keep is needed");
	assert.equal((await deploy(g, ["prune", "--keep", "x"])).code, 2);

	// Without --yes it only says what it would do.
	const say = await deploy(g, ["prune", "--keep", "1"]);
	assert.equal(say.code, 0, say.stdout + say.stderr);
	assert.match(say.stdout, /keeping 5555555|keeping .*5555555/);
	assert.match(say.stdout, /would remove .*3333333/);
	assert.match(say.stdout, /would remove .*1111111/);
	assert.match(say.stdout, /keeping .*4444444 \(current\)/);
	assert.match(say.stdout, /keeping .*2222222 \(previous\)/);
	assert.match(say.stdout, /nothing was removed: add --yes/);
	assert.deepEqual(footprint(g), quiet);

	const yes = await deploy(g, ["prune", "--keep", "1", "--yes"]);
	assert.equal(yes.code, 0, yes.stdout + yes.stderr);
	assert.deepEqual(fs.readdirSync(g.root).sort(), [r2, r4, r5, unmarked, `${version}-ddddddd`, "current", "previous"].map((p) => path.basename(p)).sort());
	assert.ok(fs.existsSync(path.join(target, ".bgw-release")), "the target of a link is untouched");
	assert.ok(fs.existsSync(path.join(REPO, "node_modules", "ws")), "the node_modules a release links to is untouched");
	assert.ok(!fs.existsSync(r1) && !fs.existsSync(r3));

	// Even with nothing kept: current, previous, what has no marker and a link stay.
	const none = await deploy(g, ["prune", "--keep", "0", "--yes"]);
	assert.equal(none.code, 0, none.stdout + none.stderr);
	assert.deepEqual(fs.readdirSync(g.root).sort(), [r2, r4, unmarked, `${version}-ddddddd`, "current", "previous"].map((p) => path.basename(p)).sort());
	assert.ok(!fs.existsSync(r5));
	assert.equal(link(g, "current"), r4);
	assert.equal(link(g, "previous"), r2);
	assert.match((await deploy(g, ["list"])).stdout, /0000000 +\(no marker: not made by this tool, never pruned\)/);
});

t("prune never removes the release Claude Code is registered to, and nothing at all where that cannot be asked - unless --force", async (ctx) => {
	const g = await scratch(ctx);
	const r1 = addRelease(g, "1111111", "2026-01-01T00:00:00Z");
	const r2 = addRelease(g, "2222222", "2026-02-01T00:00:00Z");
	const r3 = addRelease(g, "3333333", "2026-03-01T00:00:00Z");
	const r4 = addRelease(g, "4444444", "2026-04-01T00:00:00Z");
	fs.symlinkSync(r4, path.join(g.root, "current"));
	/** @returns {string[]} */
	const left = () => fs.readdirSync(g.root).filter((n) => n !== "current").sort();
	const all = [r1, r2, r3, r4].map((p) => path.basename(p));

	// Registered to an old release that is neither current nor previous, and that no daemon runs from: a session
	// of Claude Code would start a helper that is gone.
	fs.writeFileSync(path.join(g.bin, "registered"), `${path.join(r2, "cli", "bgw")} mcp`);
	const kept = await deploy(g, ["prune", "--keep", "0", "--yes"]);
	assert.equal(kept.code, 0, kept.stdout + kept.stderr);
	assert.match(kept.stdout, /keeping .*2222222 \(Claude Code is registered to it\)\n/);
	assert.match(kept.stdout, /removing .*1111111\n/);
	assert.deepEqual(left(), [r2, r4].map((p) => path.basename(p)));
	assert.deepEqual(claudeCalls(g), [], "Claude Code was asked and not changed");

	// What claude says cannot be read: any release might be the registered one.
	addRelease(g, "1111111", "2026-01-01T00:00:00Z");
	addRelease(g, "3333333", "2026-03-01T00:00:00Z");
	/** @param {Record<string, string>} over @param {RegExp} why */
	const unknown = async (over, why) => {
		for (const args of [["prune", "--keep", "0", "--yes"], ["prune", "--keep", "0"]]) {
			const r = await deploy(g, args, over);
			assert.equal(r.code, 0, r.stdout + r.stderr);
			assert.match(r.stdout, why);
			assert.match(r.stdout, /keeping .*1111111 \(Claude Code may be registered to it; --force removes it all the same\)\n/);
			assert.doesNotMatch(r.stdout, /removing |would remove /);
			assert.deepEqual(left(), all);
		}
	};
	fs.writeFileSync(path.join(g.bin, "get-broken"), "");
	await unknown({}, /^deploy: Claude Code could not be asked which release it starts: what claude mcp get says about browser-gateway could not be read\n/m);
	fs.rmSync(path.join(g.bin, "get-broken"));
	fs.writeFileSync(path.join(g.bin, "get-fails"), "");
	await unknown({}, /could not be asked which release it starts: claude mcp get browser-gateway failed without saying that there is no such server\n/);
	fs.rmSync(path.join(g.bin, "get-fails"));
	// No claude where this tool looks for it (it may be somewhere else).
	const nowhere = path.join(g.dir, "no such bin", "claude");
	assert.ok(path.resolve(nowhere).startsWith(tmp + path.sep));
	await unknown({ BGW_CLAUDE_BIN: nowhere }, /could not be asked which release it starts: the claude binary is not there \(.*no such bin\/claude, BGW_CLAUDE_BIN\)\n/);

	// --force: the operator says that none of them is registered.
	const dry = await deploy(g, ["prune", "--keep", "0", "--force"], { BGW_CLAUDE_BIN: nowhere });
	assert.match(dry.stdout, /would remove .*1111111\n/);
	assert.deepEqual(left(), all);
	const forced = await deploy(g, ["prune", "--keep", "0", "--yes", "--force"], { BGW_CLAUDE_BIN: nowhere });
	assert.equal(forced.code, 0, forced.stdout + forced.stderr);
	assert.match(forced.stdout, /^deploy: Claude Code was not asked which release it starts \(the claude binary is not there .*\): --force, so none is kept for that\n/m);
	assert.deepEqual(left(), [path.basename(r4)], "current stays, whatever is forced");
});

t("the releases root defaults to the literal home directory, whatever XDG says", async (ctx) => {
	const g = await scratch(ctx);
	/** @type {Record<string, string>} */
	const env = { ...g.env, XDG_DATA_HOME: path.join(g.dir, "xdg data") };
	// The root of this test is not overridden; every other location still is.
	delete env.BGW_RELEASES_ROOT;
	assertScratch(g);
	const r = await new Promise((resolve) => execFile("sh", [DEPLOY, "status"], { env }, (err, stdout, stderr) => resolve({ stdout, stderr })));
	assert.match(/** @type {{ stdout: string }} */ (r).stdout, new RegExp(`^deploy: releases root: ${path.join(g.home, ".local/share/browser-gateway/releases").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
	assert.equal(fs.existsSync(path.join(g.home, ".local")), false, "status makes nothing");
});
