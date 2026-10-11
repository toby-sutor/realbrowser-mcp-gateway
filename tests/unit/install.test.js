// tools/install.sh against scratch locations only: a directory that stands in for / (BGW_INSTALL_ROOT), a
// stand-in for systemctl that records what it is asked, a unit directory, a config, data, autostart and
// home directory and a port of the tests' own, all below the tests' temp root. Nothing here goes near
// /etc, /opt, /usr/local, ~/.config or port 8791, and the systemctl of this machine is never called:
// every run is checked against that before it starts, and the check fails the test.
//
// What this cannot show is what systemd does with the units. The tests look at what is written where
// and at what systemctl is asked; no unit is ever loaded or started.

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";
import { closedPort } from "../helpers/squatter.js";

const REPO = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const REAL_HOME = os.homedir();
// Where a real installation lives: never read, never written by these tests.
const REAL_PLACES = ["/etc", "/opt", "/usr", ...[".config", ".local", ".claude", ".claude.json"].map((p) => path.join(REAL_HOME, p))];
const UNITS = ["browser-gateway-dirs.service", "browser-gateway.service", "browser-gateway.socket"];
const VERSION = "9.8.7";
// The node "user" writes into the service unit: the one the PATH finds, by its full path.
const NODE = (spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).stdout ?? "").trim();

/** @returns {string | false} why the tests cannot run here */
function skipReason() {
	for (const tool of ["sh", "sed", "find", "readlink"]) {
		if (spawnSync(tool, ["--version"], { stdio: "ignore" }).error !== undefined) return `${tool} is not available`;
	}
	return false;
}
const SKIP = skipReason();

/** @type {string} */
let tmp;
/** @type {{ stop: () => Promise<void> }[]} listeners a test opened */
const listeners = [];

before(() => {
	tmp = makeTempDir("install");
});
afterEach(async () => {
	for (const l of listeners.splice(0)) await l.stop();
});
after(() => {
	removeTempDir(tmp);
});

/** @param {string} name @param {(t: import("node:test").TestContext) => Promise<void>} fn @param {{ skip?: string | false }} [opts] */
function t(name, fn, opts = {}) {
	test(name, { skip: SKIP || opts.skip || false }, fn);
}

// What stands in for systemctl. It records its arguments next to itself and keeps the little state the
// script asks about: whether the socket unit is active, and the link that "enable" makes for all users.
// Its files lie in its own directory and the stand-in root is the one next to it, so it needs no environment.
const FAKE_SYSTEMCTL = `#!/bin/sh
d=$(cd "$(dirname "$0")" && pwd)
printf '%s\\n' "$*" >> "$d/systemctl.log"
wants="$d/../root/etc/systemd/user/sockets.target.wants"
case "$*" in
"--user is-active --quiet browser-gateway.socket") [ -f "$d/socket-active" ] ;;
"--user is-active --quiet browser-gateway.service") [ -f "$d/service-active" ] ;;
"--user enable --now browser-gateway.socket") [ -f "$d/never-active" ] || : > "$d/socket-active" ;;
"--user disable --now browser-gateway.socket") [ -f "$d/stays-active" ] || rm -f "$d/socket-active" ;;
"--global enable browser-gateway.socket") mkdir -p "$wants" && ln -sf ../browser-gateway.socket "$wants/browser-gateway.socket" ;;
"--global disable browser-gateway.socket") rm -f "$wants/browser-gateway.socket" ;;
esac
`;

// What stands in for npm: "ci" makes node_modules/ws in the working directory.
const FAKE_NPM = `#!/bin/sh
d=$(cd "$(dirname "$0")" && pwd)
printf '%s | %s\\n' "$(pwd)" "$*" >> "$d/npm.log"
case "$1" in
ci) mkdir -p node_modules/ws && : > node_modules/ws/index.js ;;
*) exit 64 ;;
esac
`;

/**
 * @typedef {object} Scratch
 * @property {string} dir
 * @property {string} checkout a small stand-in for a checkout, with the real install.sh and unit templates in it
 * @property {string} script
 * @property {string} root what stands in for /
 * @property {string} bin where the stand-in for systemctl lies
 * @property {string} units
 * @property {string} config
 * @property {string} data
 * @property {string} auto
 * @property {string} home
 * @property {number} port
 * @property {Record<string, string>} env
 */

/**
 * A scratch machine: every location the script can touch, below the temp root. The directories of the user
 * have a space in their name; the checkout has none, because its path goes into unit files. The config and
 * the data directory are where the units look for them, below the home directory: "user" takes no other.
 * @param {{ ws?: boolean, xpi?: boolean }} [opts]
 * @returns {Promise<Scratch>}
 */
async function scratch(opts = {}) {
	const dir = fs.mkdtempSync(path.join(tmp, "m-"));
	const checkout = path.join(dir, "checkout");
	/** @type {Scratch} */
	const g = {
		dir,
		checkout,
		script: path.join(checkout, "tools", "install.sh"),
		root: path.join(dir, "root"),
		bin: path.join(dir, "bin"),
		units: path.join(dir, "unit dir"),
		config: path.join(dir, "home dir", ".config", "browser-gateway"),
		data: path.join(dir, "home dir", ".local", "share", "browser-gateway"),
		auto: path.join(dir, "auto start"),
		home: path.join(dir, "home dir"),
		port: await closedPort(),
		env: {},
	};
	for (const d of [g.root, g.bin, g.home, path.dirname(g.config), path.dirname(path.dirname(g.data)), path.dirname(g.data)]) fs.mkdirSync(d, { mode: 0o755 });
	fs.writeFileSync(path.join(g.bin, "systemctl"), FAKE_SYSTEMCTL, { mode: 0o755 });

	/** @param {string} rel @param {string | Buffer} content @param {number} [mode] */
	const put = (rel, content, mode = 0o644) => {
		fs.mkdirSync(path.dirname(path.join(checkout, rel)), { recursive: true });
		fs.writeFileSync(path.join(checkout, rel), content, { mode });
		fs.chmodSync(path.join(checkout, rel), mode);
	};
	for (const name of ["install.sh", ...UNITS]) put(`tools/${name}`, fs.readFileSync(path.join(REPO, "tools", name)));
	put("cli/bgw", "#!/usr/bin/env python3\n# stand-in\n", 0o755);
	put("cli/bgw_daemonctl.py", "# stand-in\n", 0o600);
	put("daemon/src/main.js", "// stand-in\n", 0o664);
	put("daemon/helpers/notify_helper.py", "# stand-in\n");
	put("package.json", `{\n\t"name": "stand-in",\n\t"version": "${VERSION}"\n}\n`);
	for (const name of ["LICENSE", "THIRD-PARTY-NOTICES.md", "README.md"]) put(name, `${name}\n`);
	if (opts.ws !== false) {
		put("node_modules/ws/package.json", "{}\n");
		put("node_modules/ws/lib/websocket.js", "// stand-in\n");
	}
	if (opts.xpi !== false) {
		put(`dist/browser-gateway-${VERSION}.xpi`, "xpi of this version");
		put("dist/browser-gateway-9.8.6.xpi", "an older one");
	}
	// What must never be copied anywhere.
	put("notes/private.md", "private\n");
	put(".env", "SECRET=1\n", 0o600);
	put("extension/manifest.json", "{}\n");
	put("node_modules/other/index.js", "// not a runtime dependency\n");
	put("cli/__pycache__/bgw.cpython-313.pyc", "bytecode");

	g.env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: g.home,
		BGW_INSTALL_ROOT: g.root,
		BGW_SYSTEMCTL: path.join(g.bin, "systemctl"),
		BGW_UNIT_DIR: g.units,
		BGW_CONFIG_DIR: g.config,
		BGW_DATA_DIR: g.data,
		BGW_AUTOSTART_DIR: g.auto,
		BGW_PORT: String(g.port),
		BGW_INSTALL_WAIT_S: "2",
	};
	return g;
}

/** Abort when anything a run would touch is a real location. @param {Record<string, string>} env */
function assertScratch(env) {
	for (const name of ["HOME", "BGW_INSTALL_ROOT", "BGW_SYSTEMCTL", "BGW_UNIT_DIR", "BGW_CONFIG_DIR", "BGW_DATA_DIR", "BGW_AUTOSTART_DIR"]) {
		const value = env[name];
		assert.ok(typeof value === "string" && value !== "", `${name} is not set: the run could reach a real location`);
		if (!path.isAbsolute(value)) continue;
		assert.ok(path.resolve(value).startsWith(tmp + path.sep), `${name}=${value} is not below the tests' temp root`);
		for (const real of REAL_PLACES) assert.ok(path.resolve(value) !== real && !path.resolve(value).startsWith(real + path.sep), `${name}=${value} is a real location`);
	}
	assert.ok(!["8791", "8792"].includes(env.BGW_PORT), "a real port");
}

/**
 * Run the install script of a scratch machine.
 * @param {Scratch} g
 * @param {string[]} args
 * @param {Record<string, string>} [more] over the environment of the scratch machine
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function install(g, args, more = {}) {
	const env = { ...g.env, ...more };
	assertScratch(env);
	return new Promise((resolve) => {
		execFile("sh", [g.script, ...args], { env, timeout: 40000 }, (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr }));
	});
}

/**
 * Run a script with exactly this environment: for the two runs that leave an override out on purpose.
 * @param {string} script
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function raw(script, args, env) {
	// Whatever is left out, these stay: no run ever has the real home, unit or config directory.
	for (const name of ["HOME", "BGW_UNIT_DIR", "BGW_CONFIG_DIR", "BGW_DATA_DIR", "BGW_AUTOSTART_DIR"]) assert.ok(path.resolve(env[name] ?? "/").startsWith(tmp + path.sep), name);
	assert.ok(!["8791", "8792"].includes(env.BGW_PORT), "a real port");
	return new Promise((resolve) => {
		execFile("sh", [script, ...args], { env, timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr }));
	});
}

/** @param {Record<string, string>} env @param {string} name @returns {Record<string, string>} env without one variable */
const without = (env, name) => Object.fromEntries(Object.entries(env).filter(([k]) => k !== name));

/** @param {Scratch} g @returns {string[]} what systemctl was asked, in order */
function calls(g) {
	try {
		return fs.readFileSync(path.join(g.bin, "systemctl.log"), "utf8").split("\n").filter((l) => l !== "");
	} catch {
		return [];
	}
}

/** @param {Scratch} g */
const forget = (g) => fs.rmSync(path.join(g.bin, "systemctl.log"), { force: true });

/**
 * Everything below a directory: path, kind, permission bits and content.
 * @param {string} dir
 * @returns {Record<string, string>}
 */
function tree(dir) {
	/** @type {Record<string, string>} */
	const out = {};
	/** @param {string} at */
	const walk = (at) => {
		for (const name of fs.readdirSync(at).sort()) {
			const full = path.join(at, name);
			const st = fs.lstatSync(full);
			const rel = path.relative(dir, full);
			const mode = (st.mode & 0o7777).toString(8);
			if (st.isSymbolicLink()) out[rel] = `link -> ${fs.readlinkSync(full)}`;
			else if (st.isDirectory()) {
				out[rel + "/"] = `dir ${mode}`;
				walk(full);
			} else out[rel] = `file ${mode} ${crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex").slice(0, 12)}`;
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return out;
}

/**
 * Something on the port of a scratch machine that answers /healthz as the gateway daemon does.
 * @param {Scratch} g
 * @param {{ when?: string }} [opts] when: listen only once this file exists (the socket unit "became active")
 */
function gatewayOnPort(g, opts = {}) {
	let connections = 0;
	const server = http.createServer((_req, res) => {
		const body = JSON.stringify({ ok: true, name: "browser-gateway", version: "0.0.0" });
		res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
		res.end(body);
	});
	server.on("connection", () => connections++);
	/** @type {NodeJS.Timeout | null} */
	let timer = null;
	/** @type {Promise<void>} */
	const listening = new Promise((resolve) => {
		const listen = () => server.listen(g.port, "127.0.0.1", () => resolve());
		if (opts.when === undefined) return listen();
		const flag = opts.when;
		timer = setInterval(() => {
			if (!fs.existsSync(flag)) return;
			if (timer !== null) clearInterval(timer);
			timer = null;
			listen();
		}, 15);
	});
	const handle = {
		listening,
		connections: () => connections,
		stop: () =>
			/** @type {Promise<void>} */ (
				new Promise((resolve) => {
					if (timer !== null) clearInterval(timer);
					if (!server.listening) return resolve();
					server.close(() => resolve());
					server.closeAllConnections();
				})
			),
	};
	listeners.push(handle);
	return handle;
}

/** A user install that goes through: the port answers as soon as the socket unit is "active". @param {Scratch} g @param {Record<string, string>} [more] */
async function installUser(g, more = {}) {
	const gw = gatewayOnPort(g, { when: path.join(g.bin, "socket-active") });
	const r = await install(g, ["user"], more);
	await gw.stop();
	return r;
}

/** @param {string} file @returns {string[]} the lines of a unit file that are neither comments nor blank */
const directives = (file) => fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "" && !l.startsWith("#"));

// Every directive of the three units as they are installed. A change of a template that drops one fails here.
/** @param {string} program @param {number} port @param {string} [node] */
const SERVICE_LINES = (program, port, node = "/usr/bin/env node") => [
	"[Unit]",
	"Description=Browser Gateway daemon",
	`Documentation=file://${program}/README.md`,
	"Requires=browser-gateway.socket browser-gateway-dirs.service",
	"After=browser-gateway.socket browser-gateway-dirs.service",
	"StartLimitIntervalSec=0",
	"[Service]",
	"Type=simple",
	`ExecStart=${node} ${program}/daemon/src/main.js`,
	`WorkingDirectory=${program}`,
	`Environment=BGW_PORT=${port}`,
	"UMask=0077",
	"NoNewPrivileges=yes",
	"ProtectSystem=strict",
	"ProtectHome=tmpfs",
	"BindPaths=%h/.config/browser-gateway %h/.local/share/browser-gateway",
	`BindReadOnlyPaths=${program}`,
	"BindPaths=-%t/bus",
	"BindReadOnlyPaths=-%t/pipewire-0",
	"InaccessiblePaths=-/mnt -/media -/run/media -/srv -/boot -/lost+found",
	"PrivateTmp=yes",
	"PrivateDevices=yes",
	"PrivateIPC=yes",
	"PrivateNetwork=yes",
	"RestrictAddressFamilies=AF_UNIX",
	"CapabilityBoundingSet=",
	"LockPersonality=yes",
	"RestrictNamespaces=yes",
	"RestrictRealtime=yes",
	"RestrictSUIDSGID=yes",
	"ProtectKernelTunables=yes",
	"ProtectKernelModules=yes",
	"ProtectKernelLogs=yes",
	"ProtectControlGroups=yes",
	"ProtectClock=yes",
	"ProtectHostname=yes",
	"SystemCallArchitectures=native",
	"SystemCallFilter=@system-service",
	"SystemCallFilter=~@privileged @resources @obsolete",
	"SystemCallErrorNumber=EPERM",
	"KeyringMode=private",
	"MemoryMax=1G",
	"TasksMax=96",
	"LimitCORE=0",
	"OOMPolicy=stop",
];
/** @param {number} port */
const SOCKET_LINES = (port) => ["[Unit]", `Description=Browser Gateway daemon socket (127.0.0.1:${port})`, "[Socket]", `ListenStream=127.0.0.1:${port}`, "FlushPending=yes", "TriggerLimitIntervalSec=0", "[Install]", "WantedBy=sockets.target"];
const DIRS_LINES = ["[Unit]", "Description=Browser Gateway: make the daemon's config and data directory", "[Service]", "Type=oneshot", "UMask=0077", "NoNewPrivileges=yes", "ExecStart=/usr/bin/env mkdir -p -m 0700 %h/.config/browser-gateway %h/.local/share/browser-gateway"];

/** The three units in a directory are complete, rendered for this program directory, port and node, and readable for all. @param {string} dir @param {string} program @param {number} port @param {string} [node] */
function assertUnits(dir, program, port, node) {
	assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith("browser-gateway")).sort(), UNITS);
	assert.deepEqual(directives(path.join(dir, "browser-gateway.service")), SERVICE_LINES(program, port, node));
	assert.deepEqual(directives(path.join(dir, "browser-gateway.socket")), SOCKET_LINES(port));
	assert.deepEqual(directives(path.join(dir, "browser-gateway-dirs.service")), DIRS_LINES);
	for (const name of UNITS) {
		const text = fs.readFileSync(path.join(dir, name), "utf8");
		assert.doesNotMatch(text, /@[A-Z][A-Z_]*@/, `${name}: a placeholder was left`);
		assert.ok(!text.includes(tmp) || program.startsWith(tmp), `${name}: the stand-in root is in the file`);
		assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o644, name);
	}
}

const UNIT_SAFE = /^[A-Za-z0-9/._+-]+$/.test(path.resolve(process.env.BGW_TEST_TMPDIR || path.join(REPO, ".test-tmp")));
// "user" writes the path of node into the unit and refuses one the unit could not run: where the node of
// this machine is one of those (a version manager below a home directory), these tests cannot install.
const NODE_HIDDEN = /** @type {string[]} */ ([NODE, NODE === "" ? "" : fs.realpathSync(NODE), process.execPath]).some((p) => !/^[A-Za-z0-9/._+-]+$/.test(p) || /^\/(home|root|run\/user|var\/home|tmp|var\/tmp|mnt|media|run\/media|srv|boot)\//.test(p));
const NEEDS_SAFE = !UNIT_SAFE ? "the tests' temp root has characters in its path that a unit file cannot take" : NODE_HIDDEN ? "node lies where the service unit could not run it (below a home or temporary directory), or its path needs quoting" : false;

// ---------------------------------------------------------------- the templates

t("the unit templates carry every directive the installed units are checked for, and the service waits for its directories", async () => {
	const service = fs.readFileSync(path.join(REPO, "tools", "browser-gateway.service"), "utf8");
	const lines = directives(path.join(REPO, "tools", "browser-gateway.service")).map((l) => l.replaceAll("@REPO@", "/x").replaceAll("@PORT@", "1").replaceAll("@NODE@", "/n/node"));
	assert.deepEqual(lines, SERVICE_LINES("/x", 1, "/n/node"));
	// Node is a placeholder of its own: no unit is written with a bare "node" that a PATH has to find, unless the installer says so.
	assert.match(service, /^ExecStart=@NODE@ @REPO@\/daemon\/src\/main\.js$/m);
	// The header says what the placeholders are without naming them, so that nothing odd is left in a rendered file.
	assert.deepEqual([...service.matchAll(/^#.*@[A-Z]+@.*$/gm)].map((m) => m[0]), ["# socket is not 127.0.0.1:@PORT@."]);
	assert.deepEqual(directives(path.join(REPO, "tools", "browser-gateway.socket")).map((l) => l.replaceAll("@PORT@", "1")), SOCKET_LINES(1));
	assert.deepEqual(directives(path.join(REPO, "tools", "browser-gateway-dirs.service")), DIRS_LINES);
	// The directories unit has no sandbox of its own (it writes into the real home) and no network or program beyond mkdir.
	const dirs = fs.readFileSync(path.join(REPO, "tools", "browser-gateway-dirs.service"), "utf8");
	assert.doesNotMatch(dirs, /^(ProtectHome|BindPaths|RemainAfterExit|ExecStartPre|ExecStartPost)=/m);
});

// ---------------------------------------------------------------- usage

t("no argument prints the help and installs nothing; wrong usage and bad overrides are refused before anything is touched", async () => {
	const g = await scratch();
	const before = tree(g.dir);
	const none = await install(g, []);
	assert.equal(none.code, 2);
	assert.equal(none.stdout, "");
	assert.match(none.stderr, /^Set up how the Browser Gateway daemon gets started on this machine\.\n/);
	for (const word of ["user", "global", "on-demand", "status", "uninstall", "--purge", "--prefix", "--node PATH", "--no-link", "BGW_INSTALL_ROOT", "BGW_SYSTEMCTL", "Exit codes"]) assert.ok(none.stderr.includes(word), word);
	assert.doesNotMatch(none.stderr, /^set -eu$/m);

	const help = await install(g, ["--help"]);
	assert.deepEqual([help.code, help.stderr, help.stdout], [0, "", none.stderr]);

	for (const [args, message] of /** @type {[string[], RegExp][]} */ ([
		[["bogus"], /^error: unknown command: bogus\n/],
		[["install"], /^error: unknown command: install\n/],
		[["user", "--bogus"], /^error: unknown argument: --bogus\n/],
		[["user", "--purge"], /^error: --purge only goes with uninstall\n/],
		[["uninstall"], /^error: uninstall needs one of: user, global, on-demand\n/],
		[["uninstall", "everything"], /^error: uninstall needs one of: user, global, on-demand\n/],
		[["uninstall", "global", "--purge"], /^error: --purge does not go with global: it deletes the directories of one user\./],
		[["on-demand", "--prefix", "/opt/x"], /^error: --prefix only goes with global\n/],
		[["global", "--prefix"], /^error: --prefix needs a directory\n/],
		[["global", "--node"], /^error: --node needs the path of a node program\n/],
		[["user", "--node", "/usr/bin/node"], /^error: --node only goes with global\n/],
		[["uninstall", "global", "--node=/usr/bin/node"], /^error: --node only goes with global\n/],
		[["user", "--no-link"], /^error: --no-link only goes with global\n/],
		[["uninstall", "global", "--no-link"], /^error: --no-link only goes with global\n/],
	])) {
		const r = await install(g, args);
		assert.equal(r.code, 2, args.join(" "));
		assert.equal(r.stdout, "");
		assert.match(r.stderr, message, args.join(" "));
		assert.match(r.stderr, /sh tools\/install\.sh --help says what each of them does\.\n$/);
	}

	// A stand-in root without a stand-in systemctl would end in the real session: refused.
	assert.throws(() => install(g, ["status"], { BGW_SYSTEMCTL: "" }), assert.AssertionError, "the test helper itself refuses to run without a stand-in");
	const direct = await raw(g.script, ["status"], without(g.env, "BGW_SYSTEMCTL"));
	assert.deepEqual(direct, { code: 1, stdout: "", stderr: "error: BGW_INSTALL_ROOT needs BGW_SYSTEMCTL as well, so that the systemctl of this machine is not called\n" });

	for (const [more, message] of /** @type {[Record<string, string>, string][]} */ ([
		[{ BGW_PORT: "abc" }, "error: BGW_PORT must be a port number\n"],
		[{ BGW_PORT: "70000" }, "error: BGW_PORT must be a port number\n"],
		[{ BGW_PORT: "0" }, "error: BGW_PORT must be a port number\n"],
		[{ BGW_CONFIG_DIR: "relative/dir" }, "error: BGW_CONFIG_DIR must be an absolute path\n"],
		[{ BGW_UNIT_DIR: "units" }, "error: BGW_UNIT_DIR must be an absolute path\n"],
		[{ BGW_INSTALL_WAIT_S: "soon" }, "error: BGW_INSTALL_WAIT_S must be a number of seconds\n"],
	])) {
		for (const args of [["status"], ["user"], ["on-demand"], ["global"]]) {
			const r = await install(g, args, more);
			assert.deepEqual([r.code, r.stdout, r.stderr], [1, "", message], `${JSON.stringify(more)} ${args.join(" ")}`);
		}
	}
	assert.deepEqual(tree(g.dir), before, "nothing was written, and systemctl was never asked");
});

// ---------------------------------------------------------------- user

t(
	"user: three units for the checkout and the port, the socket enabled, the daemon awaited; a second run is the same; uninstall takes exactly them away",
	async () => {
		const g = await scratch();
		// What is somebody else's in the same places stays as it is.
		fs.mkdirSync(g.units, { recursive: true });
		fs.writeFileSync(path.join(g.units, "other.service"), "[Unit]\nDescription=not ours\n");
		fs.mkdirSync(g.config, { mode: 0o755 });
		fs.writeFileSync(path.join(g.config, "client.token"), "kept", { mode: 0o600 });

		const r = await installUser(g);
		assert.equal(r.code, 0, r.stderr + r.stdout);
		assert.equal(r.stderr, "");
		// Node by the full path the PATH of this run finds it at: the PATH of the systemd user manager is another one.
		assert.ok(path.isAbsolute(NODE), NODE);
		assertUnits(g.units, g.checkout, g.port, NODE);
		assert.deepEqual(calls(g), [
			"--user is-active --quiet browser-gateway.socket",
			"--user stop browser-gateway.service",
			"--user daemon-reload",
			"--user disable browser-gateway.service",
			"--user enable --now browser-gateway.socket",
			"--user try-restart browser-gateway.service",
		]);
		// The two directories exist and are private, also the one that was there with wider permissions.
		for (const d of [g.config, g.data]) assert.equal(fs.statSync(d).mode & 0o777, 0o700, d);
		assert.equal(fs.readFileSync(path.join(g.config, "client.token"), "utf8"), "kept");
		assert.match(r.stdout, new RegExp(`^browser-gateway is installed for you; systemd holds 127\\.0\\.0\\.1:${g.port} and starts the daemon on the first connection\\n`));
		for (const line of [`units:  ${g.units}/browser-gateway.socket`, `runs:   ${g.checkout} (keep this checkout where it is)`, `node:   ${NODE}\n`, `config: ${g.config}`, "cli/bgw pair", "cli/bgw mcp-config", `BGW_URL=http://127.0.0.1:${g.port}`]) assert.ok(r.stdout.includes(line), line);
		// Nothing for all users, nothing in the home directory but the two directories, no marker, no temporary file left.
		assert.deepEqual(tree(g.root), {});
		assert.deepEqual(Object.keys(tree(g.home)), [".config/", ".config/browser-gateway/", ".config/browser-gateway/client.token", ".local/", ".local/share/", ".local/share/browser-gateway/"]);
		assert.deepEqual(fs.readdirSync(g.units).sort(), [...UNITS, "other.service"].sort());
		assert.equal(fs.existsSync(g.auto), false);
		const installed = tree(g.units);

		// Again: the socket unit is active now, so the port is not asked for and nothing is stopped.
		forget(g);
		const again = await installUser(g);
		assert.equal(again.code, 0, again.stderr);
		assert.deepEqual(calls(g), ["--user is-active --quiet browser-gateway.socket", "--user daemon-reload", "--user disable browser-gateway.service", "--user enable --now browser-gateway.socket", "--user try-restart browser-gateway.service"]);
		assert.deepEqual(tree(g.units), installed);

		// status: one mode, nothing wrong; with the socket unit active the port is not asked (that would start the daemon).
		forget(g);
		const watched = gatewayOnPort(g);
		await watched.listening;
		const status = await install(g, ["status"]);
		assert.equal(status.code, 0, status.stdout);
		assert.equal(
			status.stdout,
			[
				`user units:   installed in ${g.units}, daemon from ${g.checkout}, port ${g.port}`,
				"global units: not installed",
				"on-demand:    not switched on",
				"autostart:    no entry",
				"daemon:       not running; the socket unit is active, systemd holds the port and starts the daemon on the first connection",
				"mode:         user",
				"",
			].join("\n"),
		);
		assert.equal(watched.connections(), 0, "status did not connect to the port");
		assert.deepEqual(calls(g), ["--user is-active --quiet browser-gateway.socket", "--user is-active --quiet browser-gateway.service"]);
		await watched.stop();

		// Uninstall: the three units and nothing else.
		forget(g);
		const gone = await install(g, ["uninstall", "user"]);
		assert.equal(gone.code, 0, gone.stderr);
		assert.deepEqual(calls(g), [
			"--user disable --now browser-gateway.socket",
			"--user disable --now browser-gateway.service",
			"--user daemon-reload",
			"--user reset-failed browser-gateway.socket browser-gateway.service browser-gateway-dirs.service",
		]);
		assert.deepEqual(fs.readdirSync(g.units), ["other.service"]);
		assert.equal(fs.readFileSync(path.join(g.config, "client.token"), "utf8"), "kept");
		assert.ok(gone.stdout.includes(`kept ${g.config} (tokens, extension key, config.json) and ${g.data} (audit log, stored pages).`));
		assert.ok(gone.stdout.includes("Delete them with: sh tools/install.sh uninstall user --purge"));
		// And once more, with nothing there: said, and no harm.
		forget(g);
		const nothing = await install(g, ["uninstall", "user"]);
		assert.equal(nothing.code, 0);
		assert.match(nothing.stdout, /^the user units are not installed \(.*\): nothing to remove\n/);
		assert.deepEqual(calls(g), []);
	},
	{ skip: NEEDS_SAFE },
);

t(
	"user refuses next to another way of starting the daemon, on a port that is held, with an old node and from a path a unit file cannot take",
	async () => {
		const g = await scratch();
		const clean = tree(g.dir);
		/** @param {RegExp} message @param {Record<string, string>} [more] */
		const refused = async (message, more) => {
			const r = await install(g, ["user"], more);
			assert.equal(r.code, 1, r.stdout + r.stderr);
			assert.equal(r.stdout, "");
			assert.match(r.stderr, message);
			assert.equal(fs.existsSync(g.units), false, "no unit was written");
			assert.ok(!calls(g).some((c) => /enable|daemon-reload/.test(c)), "systemd was not changed");
		};

		// The units for all users.
		fs.mkdirSync(path.join(g.root, "etc/systemd/user"), { recursive: true });
		fs.writeFileSync(path.join(g.root, "etc/systemd/user/browser-gateway.socket"), "[Socket]\n");
		await refused(/^error: the units are installed for all users \(.*\/etc\/systemd\/user\): you have a daemon of your own already\. To use this checkout instead, remove them first: sudo sh tools\/install\.sh uninstall global\n$/);
		fs.rmSync(path.join(g.root, "etc"), { recursive: true });

		// An autostart entry of tools/autostart.sh: named, never removed from here.
		fs.mkdirSync(g.auto);
		const entry = "[Desktop Entry]\nType=Application\nExec=python3 \"/x/cli/bgw\" daemon start\nX-Browser-Gateway-Autostart=1\n";
		fs.writeFileSync(path.join(g.auto, "browser-gateway.desktop"), entry);
		await refused(/^error: an autostart entry starts a daemon at login \(.*browser-gateway\.desktop\); it would fight the socket unit for the port\. Remove it first: sh tools\/autostart\.sh remove\n$/);
		assert.equal(fs.readFileSync(path.join(g.auto, "browser-gateway.desktop"), "utf8"), entry);
		fs.rmSync(g.auto, { recursive: true });

		// The on-demand marker.
		fs.mkdirSync(g.config, { mode: 0o700 });
		fs.writeFileSync(path.join(g.config, "on-demand"), "");
		await refused(/^error: starting on demand is switched on \(.*on-demand\); with a socket unit it would never take effect\. Remove it first: sh tools\/install\.sh uninstall on-demand\n$/);
		fs.rmSync(g.config, { recursive: true });

		// A gateway daemon that runs as a plain process holds the port.
		const plain = gatewayOnPort(g);
		await plain.listening;
		await refused(new RegExp(`^error: a gateway daemon that runs as a plain process holds 127\\.0\\.0\\.1:${g.port}\\. Stop it first: cli/bgw daemon stop\\n$`));
		await plain.stop();
		// Something else holds it.
		const other = net.createServer((socket) => socket.destroy());
		await /** @type {Promise<void>} */ (new Promise((resolve) => other.listen(g.port, "127.0.0.1", () => resolve())));
		try {
			await refused(new RegExp(`^error: another program holds 127\\.0\\.0\\.1:${g.port}\\. Stop it first, or choose another port with BGW_PORT\\.\\n$`));
		} finally {
			await new Promise((resolve) => other.close(() => resolve(undefined)));
		}

		// A node that is too old, found first on the PATH.
		const old = path.join(g.dir, "old node");
		fs.mkdirSync(old);
		fs.writeFileSync(path.join(old, "node"), "#!/bin/sh\necho 20\n", { mode: 0o755 });
		await refused(/^error: Node 24 or newer is needed, found major version 20\n$/, { PATH: `${old}:${g.env.PATH}` });
		fs.rmSync(old, { recursive: true });

		// A node below the home directory, as a version manager installs it. It is the right version and it
		// runs here - the unit hides the home directory, so the daemon could never start with it.
		const nvm = path.join(g.home, ".nvm", "bin");
		fs.mkdirSync(nvm, { recursive: true });
		fs.writeFileSync(path.join(nvm, "node"), `#!/bin/sh\nexec "${NODE}" "$@"\n`, { mode: 0o755 });
		await refused(
			new RegExp(`^error: node is at ${path.join(nvm, "node").replaceAll(".", "\\.")}, and the service unit cannot run it from there: it hides the home directories, /tmp, /mnt, /media and /srv from the daemon\\. Nothing was installed\\. Install Node 24 or newer system-wide .* or use the mode without systemd: sh tools/install\\.sh on-demand\\n$`),
			{ PATH: `${nvm}:${g.env.PATH}` },
		);
		// The same node behind a link in a directory that is not hidden would not help: where the link leads is looked at.
		// (Everything of these tests lies below a home directory, so the link itself is refused here already.)
		fs.rmSync(path.join(g.home, ".nvm"), { recursive: true });

		// The units name the daemon's two directories themselves. A variable that names another one would have
		// the script make and report a directory the daemon never uses: said, and nothing done.
		const elsewhere = path.join(g.dir, "data elsewhere");
		await refused(new RegExp(`^error: BGW_DATA_DIR names ${elsewhere}, but the systemd units always use ${g.data.replaceAll(".", "\\.")} - the variable does not reach them\\. Nothing was changed\\. Run this again without BGW_DATA_DIR\\.\\n$`), { BGW_DATA_DIR: elsewhere });
		await refused(/^error: BGW_CONFIG_DIR names .*config elsewhere, but the systemd units always use .*\/\.config\/browser-gateway - the variable does not reach them\./, { BGW_CONFIG_DIR: path.join(g.dir, "config elsewhere") });
		assert.equal(fs.existsSync(elsewhere), false, "the directory the variable named was not made");

		// The one dependency as a link out of the checkout (a release of tools/deploy.sh made without
		// --install-deps): node finds it here, the daemon in its unit would not.
		const outside = path.join(g.dir, "outside modules");
		fs.renameSync(path.join(g.checkout, "node_modules"), outside);
		fs.symlinkSync(outside, path.join(g.checkout, "node_modules"));
		await refused(/^error: .*\/checkout\/node_modules\/ws is a link to .*\/outside modules\/ws, and the service unit shows the daemon nothing outside this checkout\. Nothing was installed\. .*prepare it with --install-deps\)\.\n$/);
		fs.rmSync(path.join(g.checkout, "node_modules"));
		fs.renameSync(outside, path.join(g.checkout, "node_modules"));

		forget(g);
		assert.deepEqual(tree(g.dir), clean, "all of it left the machine as it was");

		// A checkout whose path would need quoting in a unit file.
		const odd = path.join(g.dir, "check out");
		fs.cpSync(g.checkout, odd, { recursive: true });
		const r = await install({ ...g, script: path.join(odd, "tools", "install.sh") }, ["user"]);
		assert.deepEqual([r.code, r.stdout, r.stderr], [1, "", `error: the checkout path contains characters a unit file cannot take as they are: ${odd}\n`]);
		assert.equal(fs.existsSync(g.units), false);
	},
	{ skip: NEEDS_SAFE },
);

t(
	"user: the one dependency is installed when it is missing, and a daemon that does not answer is an error that says where to look",
	async () => {
		const g = await scratch({ ws: false });
		const fake = path.join(g.dir, "npm bin");
		fs.mkdirSync(fake);
		fs.writeFileSync(path.join(fake, "npm"), FAKE_NPM, { mode: 0o755 });
		const r = await installUser(g, { PATH: `${fake}:${g.env.PATH}` });
		assert.equal(r.code, 0, r.stderr);
		assert.equal(fs.readFileSync(path.join(fake, "npm.log"), "utf8"), `${g.checkout} | ci --omit=dev --no-audit --no-fund\n`);
		assert.match(r.stdout, /^installing the daemon's one dependency \(ws\)\.\.\.\n/);
		assertUnits(g.units, g.checkout, g.port, NODE);

		// Nothing comes up on the port: the socket unit never becomes active here. The units this run brought
		// are taken away again - the socket first - and what was in the unit directory before stays.
		const h = await scratch();
		fs.mkdirSync(h.units, { recursive: true });
		fs.writeFileSync(path.join(h.units, "other.service"), "[Unit]\nDescription=not ours\n");
		fs.writeFileSync(path.join(h.bin, "never-active"), "");
		const dead = await install(h, ["user"], { BGW_INSTALL_WAIT_S: "1" });
		assert.equal(dead.code, 1);
		assert.equal(dead.stdout, "");
		assert.equal(
			dead.stderr,
			`error: the daemon does not answer on 127.0.0.1:${h.port}. The three units were removed again (${h.units}): nothing is installed.\nwhat the daemon said is in the journal: journalctl --user -u browser-gateway.service -n 50\n`,
		);
		assert.deepEqual(fs.readdirSync(h.units), ["other.service"]);
		assert.deepEqual(calls(h).slice(-5), [
			"--user try-restart browser-gateway.service",
			"--user disable --now browser-gateway.socket",
			"--user stop browser-gateway.service",
			"--user daemon-reload",
			"--user reset-failed browser-gateway.socket browser-gateway.service browser-gateway-dirs.service",
		]);
		const status = await install(h, ["status"]);
		assert.match(status.stdout, /^user units:   not installed$/m);

		// Units that were there before the run are not this run's to remove: replaced, left, and said.
		fs.rmSync(path.join(h.bin, "never-active"));
		assert.equal((await installUser(h)).code, 0);
		forget(h);
		const again = await install(h, ["user"], { BGW_INSTALL_WAIT_S: "1" });
		assert.equal(again.code, 1);
		assert.equal(
			again.stderr,
			`error: the daemon does not answer on 127.0.0.1:${h.port}. The units were there before this run and were replaced by it; they are left in place (${h.units}).\nlook at: systemctl --user status browser-gateway.socket browser-gateway.service\nwhat the daemon said is in the journal: journalctl --user -u browser-gateway.service -n 50\n`,
		);
		assertUnits(h.units, h.checkout, h.port, NODE);
		assert.ok(!calls(h).some((c) => c.includes("disable --now")), "nothing was disabled");
	},
	{ skip: NEEDS_SAFE },
);

t(
	"uninstall user --purge deletes the caller's two directories and nothing else, and not from under a daemon that runs; --uninstall is the old spelling",
	async () => {
		const g = await scratch();
		assert.equal((await installUser(g)).code, 0);
		fs.writeFileSync(path.join(g.config, "client.token"), "t", { mode: 0o600 });
		fs.writeFileSync(path.join(g.data, "audit.jsonl"), "{}\n", { mode: 0o600 });
		fs.writeFileSync(path.join(g.home, "letter.txt"), "mine");
		fs.mkdirSync(g.auto);
		fs.writeFileSync(path.join(g.auto, "something.desktop"), "[Desktop Entry]\n");
		// Another user's directories, as far as a test can have them: next to the caller's, never named to the script.
		const theirs = path.join(g.dir, "other user", ".config", "browser-gateway");
		fs.mkdirSync(theirs, { recursive: true });
		fs.writeFileSync(path.join(theirs, "client.token"), "theirs");

		// The socket unit of the units for all users stays active after the user's own are gone: nothing is deleted.
		fs.writeFileSync(path.join(g.bin, "stays-active"), "");
		const held = await install(g, ["uninstall", "user", "--purge"]);
		assert.equal(held.code, 1);
		assert.equal(held.stderr, "error: a socket unit of the gateway is active in your session - nothing was deleted. Stop it first: systemctl --user stop browser-gateway.socket browser-gateway.service\n");
		assert.equal(fs.existsSync(path.join(g.config, "client.token")), true);
		fs.rmSync(path.join(g.bin, "stays-active"));
		fs.rmSync(path.join(g.bin, "socket-active"));

		// A daemon that runs as a plain process answers on the port: nothing is deleted either.
		const plain = gatewayOnPort(g);
		await plain.listening;
		const running = await install(g, ["uninstall", "user", "--purge"]);
		assert.equal(running.code, 1);
		assert.equal(running.stderr, `error: a gateway daemon answers on 127.0.0.1:${g.port} - nothing was deleted. Stop it first: cli/bgw daemon stop\n`);
		assert.equal(fs.existsSync(path.join(g.data, "audit.jsonl")), true);
		await plain.stop();

		// The old spelling, with a word about the new one.
		const purged = await install(g, ["--uninstall", "--purge"]);
		assert.equal(purged.code, 0, purged.stderr);
		assert.equal(purged.stderr, "warning: --uninstall is the old spelling of: uninstall user\n");
		assert.ok(purged.stdout.includes(`deleted ${fs.realpathSync(path.dirname(g.config))}/browser-gateway and ${fs.realpathSync(path.dirname(g.data))}/browser-gateway\n`));
		assert.ok(purged.stdout.includes('The browser add-on still holds its key: use "Forget pairing" in its options.'));
		assert.deepEqual([fs.existsSync(g.config), fs.existsSync(g.data)], [false, false]);
		assert.equal(fs.readFileSync(path.join(g.home, "letter.txt"), "utf8"), "mine");
		assert.deepEqual(fs.readdirSync(g.auto), ["something.desktop"]);
		assert.equal(fs.readFileSync(path.join(theirs, "client.token"), "utf8"), "theirs");
		assert.deepEqual(tree(g.root), {});

		// In this mode the variables may only name what the units use: with another directory nothing is
		// uninstalled and nothing deleted, whatever the directory is.
		assert.equal((await installUser(g)).code, 0);
		fs.writeFileSync(path.join(g.bin, "stays-active"), "");
		forget(g);
		for (const more of /** @type {Record<string, string>[]} */ ([{ BGW_CONFIG_DIR: g.home }, { BGW_DATA_DIR: path.join(g.home, ".local", "share") }])) {
			const wide = await install(g, ["uninstall", "user", "--purge"], more);
			assert.equal(wide.code, 1);
			assert.match(wide.stderr, /^error: BGW_(CONFIG|DATA)_DIR names .*, but the systemd units always use .*\/browser-gateway - the variable does not reach them\. Nothing was changed\. Run this again without BGW_(CONFIG|DATA)_DIR\.\n$/);
		}
		assert.deepEqual(calls(g), [], "systemd was not asked to change anything");
		assertUnits(g.units, g.checkout, g.port, NODE);
		assert.equal(fs.readFileSync(path.join(g.home, "letter.txt"), "utf8"), "mine");
	},
	{ skip: NEEDS_SAFE },
);

t("--purge deletes only what is the gateway's: not a link, not the home directory in any spelling, not a directory of other things, and by the path it judged", async () => {
	// "on-demand" is the mode in which the two variables are the daemon's as well, so here they can name anything.
	const g = await scratch();
	const share = path.dirname(g.data);
	fs.writeFileSync(path.join(g.home, "letter.txt"), "mine");
	fs.writeFileSync(path.join(share, "other-program.db"), "somebody else's");
	fs.mkdirSync(g.config, { mode: 0o700 });
	fs.writeFileSync(path.join(g.config, "client.token"), "t", { mode: 0o600 });
	fs.mkdirSync(path.join(g.data, "pages"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(g.dir, "x"));
	let before = tree(g.dir);

	/** @param {Record<string, string>} more @param {RegExp} message */
	const refused = async (more, message) => {
		const r = await install(g, ["uninstall", "on-demand", "--purge"], more);
		assert.equal(r.code, 1, JSON.stringify(more) + r.stdout + r.stderr);
		assert.match(r.stderr, message, JSON.stringify(more));
		assert.match(r.stderr, /nothing was deleted/);
		assert.doesNotMatch(r.stdout, /deleted/);
		assert.deepEqual(tree(g.dir), before, `${JSON.stringify(more)}: everything is as it was`);
	};

	// The home directory, however it is written, and what lies above it.
	for (const spelled of [g.home, `${g.home}/`, `${g.home}/.`, `${g.home}//`, `${g.home}/.config/..`, `${path.dirname(g.home)}/x/../${path.basename(g.home)}`, path.dirname(g.home)]) {
		await refused({ BGW_CONFIG_DIR: spelled }, /^error: (refusing to delete .*: it is the home directory or lies above it|cannot enter .*) - nothing was deleted\n$/m);
		await refused({ BGW_DATA_DIR: spelled }, /^error: (refusing to delete .*: it is the home directory or lies above it|cannot enter .*) - nothing was deleted\n$/m);
	}
	// Directories that hold other programs' things.
	for (const shared of [path.join(g.home, ".local", "share"), path.join(g.home, ".local"), path.join(g.home, ".config"), `${g.home}/.config/browser-gateway/..`]) {
		await refused({ BGW_DATA_DIR: shared }, /^error: refusing to delete .*: it is not the gateway's alone - nothing was deleted\n$/m);
	}
	// A directory with files in it, none of them the gateway's.
	const foreign = path.join(g.home, "Projects", "thesis");
	fs.mkdirSync(foreign, { recursive: true });
	fs.writeFileSync(path.join(foreign, "chapter1.txt"), "work");
	before = tree(g.dir);
	await refused({ BGW_DATA_DIR: foreign }, /^error: refusing to delete .*\/Projects\/thesis: none of the gateway's files is in it \(looked for: audit\.jsonl index\.db daemon\.log pages\/ files\/\) - nothing was deleted\. If it is the gateway's, delete it by hand\.\n$/m);
	await refused({ BGW_CONFIG_DIR: foreign }, /^error: refusing to delete .*\/Projects\/thesis: none of the gateway's files is in it \(looked for: client\.token admin\.token config\.json\) - nothing was deleted\./m);
	// A file of the gateway's name in the wrong directory does not make the other one a gateway directory.
	await refused({ BGW_CONFIG_DIR: g.data, BGW_DATA_DIR: g.config }, /none of the gateway's files is in it/);
	// A link to a directory of the gateway: the link is not followed, also with a slash behind it.
	const link = path.join(g.home, "link to config");
	fs.symlinkSync(g.config, link);
	before = tree(g.dir);
	await refused({ BGW_CONFIG_DIR: link }, /^error: .*\/link to config is a symbolic link - nothing was deleted\. --purge deletes a directory of the gateway, never what a link points at\.\n$/m);
	await refused({ BGW_CONFIG_DIR: `${link}/` }, /is a symbolic link - nothing was deleted/);
	fs.rmSync(link);
	// The directory the script itself runs from.
	const inside = path.join(g.data, "releases", "one");
	fs.cpSync(g.checkout, inside, { recursive: true });
	before = tree(g.dir);
	const self = await install({ ...g, script: path.join(inside, "tools", "install.sh") }, ["uninstall", "on-demand", "--purge"]);
	assert.equal(self.code, 1);
	assert.match(self.stderr, /^error: refusing to delete .*\/browser-gateway: this script runs from inside it \(.*\/releases\/one\) - nothing was deleted\. Run --purge from a checkout that lies elsewhere\.\n$/m);
	assert.deepEqual(tree(g.dir), before);
	fs.rmSync(path.join(g.data, "releases"), { recursive: true });

	// What it does delete: the two directories, named in a roundabout way, by where they really are. An empty
	// directory goes with rmdir; a directory that is not there is no error.
	const empty = path.join(g.dir, "empty data");
	fs.mkdirSync(empty);
	const roundabout = `${g.home}/.config/../.config/browser-gateway/`;
	const done = await install(g, ["uninstall", "on-demand", "--purge"], { BGW_CONFIG_DIR: roundabout, BGW_DATA_DIR: empty });
	assert.equal(done.code, 0, done.stderr);
	assert.ok(done.stdout.includes(`deleted ${fs.realpathSync(g.home)}/.config/browser-gateway and ${fs.realpathSync(g.dir)}/empty data\n`), done.stdout);
	assert.deepEqual([fs.existsSync(g.config), fs.existsSync(empty), fs.existsSync(path.join(g.data, "pages"))], [false, false, true]);
	const rest = await install(g, ["uninstall", "on-demand", "--purge"]);
	assert.equal(rest.code, 0, rest.stderr);
	assert.ok(rest.stdout.includes(`deleted ${fs.realpathSync(share)}/browser-gateway\n`), rest.stdout);
	const none = await install(g, ["uninstall", "on-demand", "--purge"]);
	assert.equal(none.code, 0);
	assert.match(none.stdout, /^neither .* nor .* is there: nothing to delete$/m);
	// And all along, what is not the gateway's stayed.
	assert.equal(fs.readFileSync(path.join(g.home, "letter.txt"), "utf8"), "mine");
	assert.equal(fs.readFileSync(path.join(share, "other-program.db"), "utf8"), "somebody else's");
	assert.equal(fs.readFileSync(path.join(foreign, "chapter1.txt"), "utf8"), "work");
});

// ---------------------------------------------------------------- global

// The files of a copy, as "global" makes it from the stand-in checkout: nothing else, and these permissions.
/** @param {string} version */
const COPY = (version) => ({
	".bgw-install": "file 644",
	LICENSE: "file 644",
	"README.md": "file 644",
	"THIRD-PARTY-NOTICES.md": "file 644",
	"cli/": "dir 755",
	"cli/bgw": "file 755",
	"cli/bgw_daemonctl.py": "file 644",
	"daemon/": "dir 755",
	"daemon/helpers/": "dir 755",
	"daemon/helpers/notify_helper.py": "file 644",
	"daemon/src/": "dir 755",
	"daemon/src/main.js": "file 644",
	"dist/": "dir 755",
	[`dist/browser-gateway-${version}.xpi`]: "file 644",
	"node_modules/": "dir 755",
	"node_modules/ws/": "dir 755",
	"node_modules/ws/lib/": "dir 755",
	"node_modules/ws/lib/websocket.js": "file 644",
	"node_modules/ws/package.json": "file 644",
	"package.json": "file 644",
	"tools/": "dir 755",
	"tools/browser-gateway-dirs.service": "file 644",
	"tools/browser-gateway.service": "file 644",
	"tools/browser-gateway.socket": "file 644",
	"tools/install.sh": "file 644",
});

/** @param {string} dir @returns {Record<string, string>} tree() without the content hashes */
const shape = (dir) => Object.fromEntries(Object.entries(tree(dir)).map(([k, v]) => [k, v.split(" ").slice(0, 2).join(" ")]));

/**
 * A directory below the stand-in root, each part of the way made with these permission bits whatever the umask of
 * the test run is: "global" looks at every one of them.
 * @param {Scratch} g @param {string} rel @param {number} [mode] of the last part; the ones above it get 0755
 * @returns {string}
 */
function rootDir(g, rel, mode = 0o755) {
	let at = g.root;
	const parts = rel.split("/");
	parts.forEach((part, i) => {
		at = path.join(at, part);
		if (!fs.existsSync(at)) fs.mkdirSync(at);
		if (i === parts.length - 1) fs.chmodSync(at, mode);
		else if (fs.statSync(at).mode & 0o022) fs.chmodSync(at, 0o755);
	});
	return at;
}

t("global: a copy of the program below the prefix, the units for all users, the socket enabled, a bgw command; an update keeps the copy before it whole; uninstall takes exactly that away", async () => {
	const g = await scratch();
	// What is somebody else's in the same places.
	fs.writeFileSync(path.join(rootDir(g, "etc/systemd/user"), "other.service"), "[Unit]\n");
	fs.writeFileSync(path.join(rootDir(g, "usr/local/bin"), "other"), "#!/bin/sh\n", { mode: 0o755 });
	fs.mkdirSync(g.config, { mode: 0o700 });
	fs.writeFileSync(path.join(g.config, "client.token"), "the caller's", { mode: 0o600 });
	// A file that the group may write in the checkout does not stay so in the copy; a private one becomes readable.
	fs.chmodSync(path.join(g.checkout, "daemon/src/main.js"), 0o666);
	const checkoutBefore = tree(g.checkout);

	const r = await install(g, ["global"]);
	assert.equal(r.code, 0, r.stderr + r.stdout);
	assert.equal(r.stderr, "");
	const prefix = path.join(g.root, "opt/browser-gateway");
	assert.deepEqual(shape(prefix), COPY(VERSION));
	assert.equal(fs.readFileSync(path.join(prefix, "cli/bgw"), "utf8"), fs.readFileSync(path.join(g.checkout, "cli/bgw"), "utf8"));
	assert.match(fs.readFileSync(path.join(prefix, ".bgw-install"), "utf8"), /^bgw-install-global=1\nversion=9\.8\.7\ninstalled=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
	// Owned by whoever ran it (root, in real use), every file of it.
	const uid = /** @type {number} */ (process.getuid?.());
	for (const rel of Object.keys(tree(prefix))) assert.equal(fs.lstatSync(path.join(prefix, rel)).uid, uid, rel);
	// The units name the prefix as it will be at run time, without the stand-in root.
	assertUnits(path.join(g.root, "etc/systemd/user"), "/opt/browser-gateway", g.port);
	assert.deepEqual(calls(g), ["--global enable browser-gateway.socket"]);
	assert.equal(fs.readlinkSync(path.join(g.root, "usr/local/bin/bgw")), "/opt/browser-gateway/cli/bgw");
	assert.deepEqual(Object.keys(tree(g.root)).filter((k) => !k.startsWith("opt/browser-gateway/")).sort(), [
		"etc/",
		"etc/systemd/",
		"etc/systemd/user/",
		"etc/systemd/user/browser-gateway-dirs.service",
		"etc/systemd/user/browser-gateway.service",
		"etc/systemd/user/browser-gateway.socket",
		"etc/systemd/user/other.service",
		"etc/systemd/user/sockets.target.wants/",
		"etc/systemd/user/sockets.target.wants/browser-gateway.socket",
		"opt/",
		"usr/",
		"usr/local/",
		"usr/local/bin/",
		"usr/local/bin/bgw",
		"usr/local/bin/other",
	]);
	// Nothing of any user: no unit directory, no data directory, the caller's config as it was, the checkout untouched.
	assert.deepEqual([fs.existsSync(g.units), fs.existsSync(g.data), fs.existsSync(g.auto)], [false, false, false]);
	assert.deepEqual(Object.keys(tree(g.home)), [".config/", ".config/browser-gateway/", ".config/browser-gateway/client.token", ".local/", ".local/share/"]);
	assert.deepEqual(tree(g.checkout), checkoutBefore);
	// What every user still has to do, and the one port they share.
	assert.match(r.stdout, /^browser-gateway 9\.8\.7 is installed for all users\n/);
	for (const line of [
		"Each user, once:",
		"log out and in again, or: systemctl --user daemon-reload && systemctl --user start browser-gateway.socket",
		"Install Add-on From File -> /opt/browser-gateway/dist/browser-gateway-9.8.7.xpi",
		"bgw pair, and paste the code into the add-on's options page",
		"bgw mcp-config, to register the gateway with their agent",
		`Every user's daemon listens on the same port, 127.0.0.1:${g.port}.`,
		"the second one's socket unit cannot take it",
		// A socket unit that could not bind does not try again by itself.
		"stays failed after the first one logged out: the second one then runs\nsystemctl --user restart browser-gateway.socket, or logs in again.",
		`command: ${g.root}/usr/local/bin/bgw -> /opt/browser-gateway/cli/bgw\n`,
		"node:    the one on each user's PATH (--node PATH names one for all)\n",
	]) assert.ok(r.stdout.includes(line), line);
	assert.doesNotMatch(r.stdout, /update:/);

	// status, as a user of that machine sees it before the next login.
	forget(g);
	const status = await install(g, ["status"]);
	assert.equal(status.code, 0, status.stdout);
	assert.equal(
		status.stdout,
		[
			"user units:   not installed",
			`global units: installed in ${g.root}/etc/systemd/user, daemon from /opt/browser-gateway, port ${g.port}`,
			"on-demand:    not switched on",
			"autostart:    no entry",
			"socket unit:  not active in this session. Log out and in again, or: systemctl --user daemon-reload && systemctl --user start browser-gateway.socket",
			`daemon:       not running; nothing listens on 127.0.0.1:${g.port}`,
			"mode:         global",
			"",
		].join("\n"),
	);

	// An update: a new version in the checkout. The copy before it is moved aside whole, not emptied.
	fs.writeFileSync(path.join(g.checkout, "package.json"), '{\n\t"version": "9.8.8"\n}\n');
	fs.writeFileSync(path.join(g.checkout, "dist/browser-gateway-9.8.8.xpi"), "newer");
	fs.writeFileSync(path.join(g.checkout, "daemon/src/added.js"), "// new\n");
	forget(g);
	const updated = await install(g, ["global"]);
	assert.equal(updated.code, 0, updated.stderr);
	assert.deepEqual(shape(prefix), { ...COPY("9.8.8"), "daemon/src/added.js": "file 644" });
	assert.deepEqual(shape(prefix + ".previous"), COPY(VERSION));
	assert.deepEqual(fs.readdirSync(path.join(g.root, "opt")).sort(), ["browser-gateway", "browser-gateway.previous"], "no temporary directory is left");
	assert.match(updated.stdout, /^update:  the copy before this one is in .*browser-gateway\.previous until the next update\./m);
	assert.deepEqual(calls(g), ["--global enable browser-gateway.socket"]);
	assert.equal(fs.readlinkSync(path.join(g.root, "usr/local/bin/bgw")), "/opt/browser-gateway/cli/bgw");
	// And a third time: one copy before the current one, never more.
	assert.equal((await install(g, ["global"])).code, 0);
	assert.deepEqual(fs.readdirSync(path.join(g.root, "opt")).sort(), ["browser-gateway", "browser-gateway.previous"]);
	assert.match(fs.readFileSync(path.join(prefix + ".previous", ".bgw-install"), "utf8"), /^version=9\.8\.8$/m);

	// Uninstall, from the installed copy (the checkout may be gone by then): what global made, and nothing else.
	forget(g);
	const gone = await install({ ...g, script: path.join(prefix, "tools/install.sh") }, ["uninstall", "global"]);
	assert.equal(gone.code, 0, gone.stderr);
	assert.deepEqual(calls(g), ["--global disable browser-gateway.socket"]);
	assert.deepEqual(Object.keys(tree(g.root)).sort(), ["etc/", "etc/systemd/", "etc/systemd/user/", "etc/systemd/user/other.service", "etc/systemd/user/sockets.target.wants/", "opt/", "usr/", "usr/local/", "usr/local/bin/", "usr/local/bin/other"]);
	assert.equal(fs.readFileSync(path.join(g.config, "client.token"), "utf8"), "the caller's");
	for (const line of ["removed browser-gateway.socket, browser-gateway.service and browser-gateway-dirs.service", `removed ${prefix}\n`, `removed ${prefix}.previous\n`, "Nobody's config or data directory was touched."]) assert.ok(gone.stdout.includes(line), line);
	// Twice is once.
	const twice = await install(g, ["uninstall", "global"]);
	assert.equal(twice.code, 0);
	assert.match(twice.stdout, /^the units for all users are not installed/);
});

t("global: another prefix, and no add-on file to copy", async () => {
	const g = await scratch({ xpi: false });
	// A checkout that lost the executable bit of bgw (unpacked from an archive, say): the command still has to run.
	fs.chmodSync(path.join(g.checkout, "cli/bgw"), 0o644);
	const r = await install(g, ["global", "--prefix", "/srv/apps/bgw-1.0/"]);
	assert.equal(r.code, 0, r.stderr);
	const prefix = path.join(g.root, "srv/apps/bgw-1.0");
	const expected = /** @type {Record<string, string>} */ ({ ...COPY(VERSION) });
	delete expected["dist/"];
	delete expected[`dist/browser-gateway-${VERSION}.xpi`];
	assert.deepEqual(shape(prefix), expected);
	assertUnits(path.join(g.root, "etc/systemd/user"), "/srv/apps/bgw-1.0", g.port);
	assert.equal(fs.readlinkSync(path.join(g.root, "usr/local/bin/bgw")), "/srv/apps/bgw-1.0/cli/bgw");
	assert.ok(r.stdout.includes("No add-on file was copied: dist/browser-gateway-9.8.7.xpi is not"));
	// A run without --prefix would make a second copy next to units that name the first: refused.
	const other = await install(g, ["global"]);
	assert.deepEqual([other.code, other.stdout], [1, ""]);
	assert.match(other.stderr, /^error: the units in .* run the daemon from \/srv\/apps\/bgw-1\.0, not from \/opt\/browser-gateway\. Give that directory with --prefix, or remove the installation first: sudo sh tools\/install\.sh uninstall global\n$/);
	assert.equal(fs.existsSync(path.join(g.root, "opt")), false);
	// Uninstall finds the prefix in the units.
	assert.equal((await install(g, ["uninstall", "global"])).code, 0);
	assert.deepEqual([fs.existsSync(prefix), fs.existsSync(path.join(g.root, "usr/local/bin/bgw"))], [false, false]);
});

t("global refuses: a prefix or a bgw command that is not its own, a link in the checkout, a missing dependency, a prefix that cannot be one", async () => {
	const g = await scratch();
	const prefix = path.join(g.root, "opt/browser-gateway");
	/** @param {string[]} args @param {RegExp} message @param {Scratch} [on] */
	const refused = async (args, message, on = g) => {
		forget(on);
		const r = await install(on, args);
		assert.equal(r.code, 1, args.join(" ") + r.stdout + r.stderr);
		assert.equal(r.stdout, "");
		assert.match(r.stderr, message);
		assert.deepEqual(calls(on), [], "systemctl was not asked");
		assert.equal(fs.existsSync(path.join(on.root, "etc")), false, "no unit was written");
		assert.equal(fs.existsSync(path.join(on.root, "usr/local/bin/bgw")) && fs.lstatSync(path.join(on.root, "usr/local/bin/bgw")).isSymbolicLink(), false, "no command was linked");
	};

	// A directory at the prefix that this tool did not make: left exactly as it is.
	fs.mkdirSync(prefix, { recursive: true });
	fs.writeFileSync(path.join(prefix, "theirs.txt"), "somebody else's");
	await refused(["global"], /^error: .*\/opt\/browser-gateway exists and was not made by this tool \(no \.bgw-install in it\) - not touching it\n$/);
	assert.deepEqual(fs.readdirSync(prefix), ["theirs.txt"]);
	// Uninstall leaves it alone as well, and says so.
	const left = await install(g, ["uninstall", "global"]);
	assert.equal(left.code, 0);
	assert.ok(left.stdout.includes(`left alone: ${prefix} was not made by this tool (no .bgw-install in it)`));
	assert.deepEqual(fs.readdirSync(prefix), ["theirs.txt"]);
	// A marker that is a link to a file with the right words is no marker.
	fs.writeFileSync(path.join(g.dir, "tag"), "bgw-install-global=1\n");
	fs.symlinkSync(path.join(g.dir, "tag"), path.join(prefix, ".bgw-install"));
	await refused(["global"], /exists and was not made by this tool/);
	fs.rmSync(path.join(g.root, "opt"), { recursive: true });
	// The same for the place where the copy before the current one is kept.
	fs.mkdirSync(prefix + ".previous", { recursive: true });
	await refused(["global"], /^error: .*browser-gateway\.previous exists and was not made by this tool/);
	fs.rmSync(path.join(g.root, "opt"), { recursive: true });

	// A bgw in /usr/local/bin that is somebody else's.
	rootDir(g, "usr/local/bin");
	fs.writeFileSync(path.join(g.root, "usr/local/bin/bgw"), "#!/bin/sh\necho mine\n", { mode: 0o755 });
	await refused(["global"], /^error: .*\/usr\/local\/bin\/bgw exists and is not the link to \/opt\/browser-gateway\/cli\/bgw that this tool makes - not touching it\n$/);
	assert.equal(fs.readFileSync(path.join(g.root, "usr/local/bin/bgw"), "utf8"), "#!/bin/sh\necho mine\n");
	assert.equal(fs.existsSync(path.join(g.root, "opt")), false, "nothing was copied before the refusal");
	fs.rmSync(path.join(g.root, "usr"), { recursive: true });

	// A link in what would be copied: it could lead to a file that then lay readable for everybody.
	const secret = path.join(g.dir, "secret.txt");
	fs.writeFileSync(secret, "not for other users", { mode: 0o600 });
	for (const rel of ["daemon/src/config.js", "node_modules/ws/lib/extra.js", "cli/more"]) {
		fs.symlinkSync(rel === "cli/more" ? g.dir : secret, path.join(g.checkout, rel));
		await refused(["global"], new RegExp(`^error: the checkout holds something that is neither a file nor a directory \\(a symlink\\?\\) - nothing was copied: ${rel.replaceAll(".", "\\.")} ?\\n$`));
		fs.rmSync(path.join(g.checkout, rel));
		assert.equal(fs.existsSync(path.join(g.root, "opt")), false);
	}
	// One of the directories on the way to what is copied is a link: every file below it is a plain file, and
	// every one of them comes from outside the checkout. A release of tools/deploy.sh made without
	// --install-deps has such a node_modules.
	const far = path.join(g.dir, "far away");
	fs.mkdirSync(far);
	for (const rel of ["daemon", "cli", "tools", "dist", "node_modules", "node_modules/ws"]) {
		const real = path.join(far, path.basename(rel));
		fs.renameSync(path.join(g.checkout, rel), real);
		fs.symlinkSync(real, path.join(g.checkout, rel));
		const hint = rel.startsWith("node_modules")
			? 'Put the dependency into the checkout itself: remove the link and run "npm ci --omit=dev" there as yourself\\. A release made by tools/deploy\\.sh has such a link unless it was prepared with --install-deps\\.'
			: "Run this from a checkout that holds the directory itself\\.";
		await refused(["global"], new RegExp(`^error: .*/checkout/${rel} is a symbolic link - nothing was copied\\. Root copies only what lies in the checkout itself: what a link leads to would end up readable for everybody below the prefix\\. ${hint}\\n$`));
		fs.rmSync(path.join(g.checkout, rel));
		fs.renameSync(real, path.join(g.checkout, rel));
		assert.equal(fs.existsSync(path.join(g.root, "opt")), false, rel);
	}
	// A file with a second name: whoever made the link need not be able to read the file, and root's copy would show it.
	fs.linkSync(secret, path.join(g.checkout, "daemon/src/borrowed.js"));
	await refused(["global"], /^error: the checkout holds files that have a second name somewhere \(hard links\) - nothing was copied: daemon\/src\/borrowed\.js\. Make a fresh copy of the checkout \(git clone, or cp -R\) and run this from there\.\n$/);
	fs.rmSync(path.join(g.checkout, "daemon/src/borrowed.js"));
	assert.equal(fs.existsSync(path.join(g.root, "opt")), false);

	// Prefixes that cannot be one.
	for (const [value, message] of /** @type {[string, RegExp][]} */ ([
		["opt/x", /^error: --prefix must be an absolute path\n$/],
		["/opt", /^error: --prefix must be a directory of its own, not \/opt\n$/],
		["/", /^error: --prefix must be an absolute path\n$/],
		["/opt/with space", /^error: --prefix contains characters a unit file cannot take as they are: \/opt\/with space\n$/],
		["/opt/../etc/x", /^error: write --prefix without \., \.\. or empty components: \/opt\/\.\.\/etc\/x\n$/],
		["/opt//x", /^error: write --prefix without \., \.\. or empty components: \/opt\/\/x\n$/],
	])) {
		await refused(["global", "--prefix", value], message);
	}
	// A prefix inside the checkout would be copied into itself; the checkout inside the prefix would be replaced by its copy.
	forget(g);
	const inside = await install(g, ["global", "--prefix", "/checkout/copy"], { BGW_INSTALL_ROOT: g.dir });
	assert.deepEqual([inside.code, inside.stdout, inside.stderr], [1, "", `error: the prefix lies inside this checkout: ${g.checkout}/copy\n`]);
	// (The stand-in root is the tests' temp root itself here; the refusal comes before anything is made in it.)
	const around = await raw(g.script, ["global", "--prefix", `/${path.basename(g.dir)}`], { ...g.env, BGW_INSTALL_ROOT: path.dirname(g.dir) });
	assert.deepEqual([around.code, around.stdout, around.stderr], [1, "", `error: this script runs from the installed copy (${g.dir}). Run "global" from a checkout.\n`]);
	assert.deepEqual([calls(g), fs.existsSync(path.join(g.checkout, "copy")), fs.existsSync(path.join(g.dir, "etc"))], [[], false, false]);
	// A directory above the prefix that others can write to.
	rootDir(g, "shared", 0o777);
	await refused(["global", "--prefix", "/shared/bgw"], /^error: .*\/shared is writable for its group or for everybody: whoever can write there could replace the program every user runs\. Choose another --prefix\.\n$/);
	assert.deepEqual(fs.readdirSync(path.join(g.root, "shared")), []);
	// Not only the one directly above it. Whoever can write to any directory on the way can move the rest
	// aside and put a tree of their own at the path every user's unit names. (The owner of each has to be root
	// as well; with a stand-in root there is no root to own anything, so only the permission bits are tested.)
	await refused(["global", "--prefix", "/shared/apps/bgw"], /^error: .*\/shared is writable for its group or for everybody: whoever can write there could replace the program every user runs\. Choose another --prefix\.\n$/);
	assert.deepEqual(fs.readdirSync(path.join(g.root, "shared")), [], "the directory in between was not made");
	rootDir(g, "shared/closed/deeper");
	for (const mode of [0o775, 0o757, 0o1777]) {
		fs.chmodSync(path.join(g.root, "shared"), mode);
		await refused(["global", "--prefix", "/shared/closed/deeper/bgw"], /^error: .*\/shared is writable for its group or for everybody: /);
	}
	fs.chmodSync(path.join(g.root, "shared"), 0o755);
	// A link on the way: where it leads is looked at as well.
	rootDir(g, "open", 0o777);
	fs.symlinkSync(path.join(g.root, "open"), path.join(g.root, "shared/closed/door"));
	await refused(["global", "--prefix", "/shared/closed/door/bgw"], /^error: .*\/root\/open is writable for its group or for everybody: /);
	assert.deepEqual(fs.readdirSync(path.join(g.root, "open")), []);
	fs.rmSync(path.join(g.root, "shared"), { recursive: true });
	fs.rmSync(path.join(g.root, "open"), { recursive: true });
	// The directory of the bgw command, where a group may write to it (root:staff 2775 on Debian and its family).
	rootDir(g, "usr/local/bin", 0o2775);
	fs.chmodSync(path.join(g.root, "usr/local"), 0o2775);
	const staff = /^error: .*\/usr\/local\/bin is writable for its group or for everybody: whoever can write there could replace the bgw command every user runs\. Run this again with --no-link: the link is left out then, and the command is \/opt\/browser-gateway\/cli\/bgw\.\n$/;
	await refused(["global"], staff);
	fs.chmodSync(path.join(g.root, "usr/local/bin"), 0o755);
	await refused(["global"], /^error: .*\/usr\/local is writable for its group or for everybody: whoever can write there could replace the bgw command every user runs\. Run this again with --no-link/);
	assert.equal(fs.existsSync(path.join(g.root, "opt")), false, "nothing was copied before the refusal");
	fs.rmSync(path.join(g.root, "usr"), { recursive: true });
	assert.deepEqual(fs.readdirSync(g.root), [], "after all of it the stand-in root is as empty as before");

	// The dependency is missing: said, with what to run as oneself. npm is not run by this mode.
	const h = await scratch({ ws: false });
	const fake = path.join(h.dir, "npm bin");
	fs.mkdirSync(fake);
	fs.writeFileSync(path.join(fake, "npm"), FAKE_NPM, { mode: 0o755 });
	h.env.PATH = `${fake}:${h.env.PATH}`;
	await refused(["global"], /^error: the daemon's one dependency is missing \(.*node_modules\/ws\)\. Root does not run npm in a checkout: run "npm ci --omit=dev" there as yourself, then this again\.\n$/, h);
	assert.equal(fs.existsSync(path.join(fake, "npm.log")), false, "npm was not run");
	assert.deepEqual(fs.readdirSync(h.root), []);
});

t("global --no-link leaves the bgw command out; --node writes a node of root's choosing into every user's unit, and only one that nobody else can change", async () => {
	const g = await scratch();
	// /usr/local/bin as Debian has it: the link is refused there (see above), and this is the way out.
	rootDir(g, "usr/local/bin", 0o2775);
	fs.chmodSync(path.join(g.root, "usr/local"), 0o2775);
	fs.writeFileSync(path.join(g.root, "usr/local/bin/bgw"), "#!/bin/sh\necho somebody else's\n", { mode: 0o755 });
	// A node for all users. It is asked for its version and for nothing else.
	const node = path.join(rootDir(g, "usr/lib/node-24/bin"), "node");
	fs.writeFileSync(node, "#!/bin/sh\necho 24\n", { mode: 0o755 });
	fs.chmodSync(node, 0o755);
	fs.symlinkSync("../lib/node-24/bin/node", path.join(rootDir(g, "usr/bin"), "node"));

	const r = await install(g, ["global", "--no-link", "--node", "/usr/bin/node"]);
	assert.equal(r.code, 0, r.stderr + r.stdout);
	assert.equal(r.stderr, "", "no word about root's PATH: the node was named");
	assertUnits(path.join(g.root, "etc/systemd/user"), "/opt/browser-gateway", g.port, "/usr/bin/node");
	assert.equal(fs.readFileSync(path.join(g.root, "usr/local/bin/bgw"), "utf8"), "#!/bin/sh\necho somebody else's\n", "what lies at the place of the link is not looked at, let alone touched");
	for (const line of ['command: /opt/browser-gateway/cli/bgw (--no-link: no link was made; where this text says "bgw", users call it by that path)\n', "node:    /usr/bin/node, written into the service unit\n"]) assert.ok(r.stdout.includes(line), line);
	assert.equal(fs.statSync(path.join(g.root, "usr/local/bin")).mode & 0o7777, 0o2775);
	// Uninstall leaves the foreign bgw alone, as before.
	const gone = await install(g, ["uninstall", "global"]);
	assert.equal(gone.code, 0, gone.stderr);
	assert.ok(gone.stdout.includes("is not the link to /opt/browser-gateway/cli/bgw that this tool makes"));
	assert.deepEqual(fs.readdirSync(path.join(g.root, "opt")), []);
	for (const made of ["etc", "opt"]) fs.rmSync(path.join(g.root, made), { recursive: true });

	/** @param {string} value @param {RegExp} message */
	const refused = async (value, message) => {
		forget(g);
		const x = await install(g, ["global", "--no-link", "--node", value]);
		assert.deepEqual([x.code, x.stdout], [1, ""], value + x.stderr);
		assert.match(x.stderr, message, value);
		assert.deepEqual([calls(g), fs.existsSync(path.join(g.root, "etc")), fs.existsSync(path.join(g.root, "opt"))], [[], false, false], value);
	};
	await refused("bin/node", /^error: --node must be an absolute path\n$/);
	await refused("/usr/my node", /^error: --node contains characters a unit file cannot take as they are: \/usr\/my node\n$/);
	await refused("/usr/bin/../bin/node", /^error: write --node without \., \.\. or empty components: /);
	await refused("/usr/bin/nodejs", /^error: --node \/usr\/bin\/nodejs is not a program\n$/);
	// In a home directory, or anywhere else the unit hides: every user's daemon would fail to start.
	for (const hidden of ["/home/alice/.nvm/versions/node/v24.0.0/bin/node", "/root/node", `${g.home.replaceAll(" ", "")}/node`, "/tmp/node", "/srv/node/bin/node"]) {
		await refused(hidden, /^error: --node .* lies in a home directory or another place the service unit hides from the daemon\. Name a node that is installed system-wide\.\n$/);
	}
	// A link from a system directory into a home directory is no better.
	fs.writeFileSync(path.join(rootDir(g, "home/alice"), "node"), "#!/bin/sh\necho 24\n", { mode: 0o755 });
	fs.symlinkSync(path.join(g.root, "home/alice/node"), path.join(g.root, "usr/bin/node-alice"));
	await refused("/usr/bin/node-alice", /^error: --node \/usr\/bin\/node-alice is a link to .*\/home\/alice\/node, which the service unit hides from the daemon\./);
	// A program, or a directory on the way to it, that somebody besides root can change.
	fs.chmodSync(node, 0o775);
	await refused("/usr/bin/node", /^error: --node .*\/usr\/lib\/node-24\/bin\/node is writable for its group or for everybody: whoever can write to it runs code as every user of the gateway\n$/);
	fs.chmodSync(node, 0o755);
	fs.chmodSync(path.join(g.root, "usr/lib/node-24"), 0o775);
	await refused("/usr/bin/node", /^error: .*\/usr\/lib\/node-24 is writable for its group or for everybody: whoever can write there could replace the node every user's daemon runs\. Name a node in a directory that only root can write to\.\n$/);
	fs.chmodSync(path.join(g.root, "usr/lib/node-24"), 0o755);
	fs.chmodSync(path.join(g.root, "usr/bin"), 0o777);
	await refused("/usr/bin/node", /^error: .*\/usr\/bin is writable for its group or for everybody: whoever can write there could replace the node every user's daemon runs\./);
	fs.chmodSync(path.join(g.root, "usr/bin"), 0o755);
	// Too old.
	fs.writeFileSync(node, "#!/bin/sh\necho 22\n");
	await refused("/usr/bin/node", /^error: --node \/usr\/bin\/node is not Node 24 or newer \(it says: 22\)\n$/);
	fs.writeFileSync(node, "#!/bin/sh\necho 24\n");

	// Without --no-link, and with a directory for the link that only root can write to, the link is made as ever.
	fs.rmSync(path.join(g.root, "usr/local"), { recursive: true });
	const linked = await install(g, ["global", "--node=/usr/bin/node"]);
	assert.equal(linked.code, 0, linked.stderr);
	assert.equal(fs.readlinkSync(path.join(g.root, "usr/local/bin/bgw")), "/opt/browser-gateway/cli/bgw");
	// A later run with --no-link leaves that link where it is, and says so.
	const later = await install(g, ["global", "--no-link"]);
	assert.equal(later.code, 0, later.stderr);
	assert.ok(later.stdout.includes(`command: /opt/browser-gateway/cli/bgw (--no-link: no link was made; ${g.root}/usr/local/bin/bgw from an earlier run was left where it is)\n`), later.stdout);
	assertUnits(path.join(g.root, "etc/systemd/user"), "/opt/browser-gateway", g.port);
});

t(
	"global and uninstall global need root: without the stand-in root an ordinary user is refused before anything is looked at",
	async () => {
		const g = await scratch();
		// No stand-in root here on purpose. The refusal is the first thing the mode does; were it missing, an
		// ordinary user could still not write below /etc or /opt. Never run as root (skipped then).
		for (const args of [["global"], ["global", "--prefix", "/opt/elsewhere"], ["uninstall", "global"]]) {
			const r = await raw(g.script, args, without(g.env, "BGW_INSTALL_ROOT"));
			const word = args[0] === "global" ? "global" : "uninstall global";
			assert.deepEqual(r, { code: 1, stdout: "", stderr: `error: "${word}" changes the system for all users and must be run as root: sudo sh tools/install.sh ${word}\n` });
		}
		assert.deepEqual(calls(g), []);
	},
	{ skip: process.getuid?.() === 0 ? "running as root: this test must not" : false },
);

// ---------------------------------------------------------------- on-demand

t("on-demand: one private file in the config directory, nothing started and systemd never asked; refused next to a socket unit; uninstall takes the file away", async () => {
	const g = await scratch();
	const marker = path.join(g.config, "on-demand");
	const r = await install(g, ["on-demand"]);
	assert.equal(r.code, 0, r.stderr);
	assert.equal(r.stderr, "");
	assert.deepEqual(tree(g.config), { "on-demand": `file 600 ${crypto.createHash("sha256").update(fs.readFileSync(marker)).digest("hex").slice(0, 12)}` });
	assert.equal(fs.statSync(g.config).mode & 0o777, 0o700);
	assert.match(fs.readFileSync(marker, "utf8"), /^# Browser Gateway: with this file here, bgw and "bgw mcp" start the daemon when they find it not running\.\n# Written by tools\/install\.sh on-demand\. Remove it with: sh tools\/install\.sh uninstall on-demand\n$/);
	assert.deepEqual(calls(g), [], "no systemd in this mode");
	assert.deepEqual([fs.existsSync(g.units), fs.existsSync(g.data), fs.existsSync(g.auto), fs.readdirSync(g.root).length], [false, false, false, 0]);
	assert.deepEqual(Object.keys(tree(g.home)), [".config/", ".config/browser-gateway/", ".config/browser-gateway/on-demand", ".local/", ".local/share/"]);
	assert.match(r.stdout, new RegExp(`^starting on demand is switched on: ${marker.replaceAll(".", "\\.")}\\nNothing was started\\.`));
	for (const line of ["The daemon is not stopped when idle", "There is no sandbox around it, and nothing holds the port while it is down.", `(this one: ${g.checkout})`]) assert.ok(r.stdout.includes(line), line);
	// Twice is once.
	assert.equal((await install(g, ["on-demand"])).code, 0);
	assert.deepEqual(fs.readdirSync(g.config), ["on-demand"]);

	const status = await install(g, ["status"]);
	assert.equal(status.code, 0, status.stdout);
	assert.equal(
		status.stdout,
		[
			"user units:   not installed",
			"global units: not installed",
			`on-demand:    switched on (${marker}): each bgw starts the daemon of the checkout it sits in`,
			"autostart:    no entry",
			`daemon:       not running; nothing listens on 127.0.0.1:${g.port}. It is started on demand.`,
			"mode:         on-demand",
			"",
		].join("\n"),
	);
	assert.deepEqual(calls(g), []);

	// An autostart entry next to it is no conflict: said, and left.
	fs.mkdirSync(g.auto);
	fs.writeFileSync(path.join(g.auto, "browser-gateway.desktop"), "[Desktop Entry]\nX-Browser-Gateway-Autostart=1\n");
	const withEntry = await install(g, ["on-demand"]);
	assert.equal(withEntry.code, 0);
	assert.ok(withEntry.stdout.includes("An autostart entry is there as well"));
	const both = await install(g, ["status"]);
	assert.equal(both.code, 0, both.stdout);
	assert.match(both.stdout, /^autostart:    an entry of tools\/autostart\.sh is there \(.*browser-gateway\.desktop\)$/m);
	fs.rmSync(g.auto, { recursive: true });

	// Uninstall: the file, and only the file.
	fs.writeFileSync(path.join(g.config, "client.token"), "kept", { mode: 0o600 });
	const gone = await install(g, ["uninstall", "on-demand"]);
	assert.equal(gone.code, 0, gone.stderr);
	assert.deepEqual(fs.readdirSync(g.config), ["client.token"]);
	assert.match(gone.stdout, /^removed .*on-demand: bgw no longer starts the daemon by itself\nA daemon that runs now is not stopped: cli\/bgw daemon stop\n/);
	const nothing = await install(g, ["uninstall", "on-demand"]);
	assert.equal(nothing.code, 0);
	assert.match(nothing.stdout, /^starting on demand is not switched on/);
	// With --purge the caller's two directories go as well - not while a daemon answers.
	assert.equal((await install(g, ["on-demand"])).code, 0);
	const plain = gatewayOnPort(g);
	await plain.listening;
	const running = await install(g, ["uninstall", "on-demand", "--purge"]);
	assert.equal(running.code, 1);
	assert.match(running.stderr, /^error: a gateway daemon answers on 127\.0\.0\.1:\d+ - nothing was deleted\. Stop it first: cli\/bgw daemon stop\n$/);
	assert.deepEqual(fs.readdirSync(g.config), ["client.token"]);
	await plain.stop();
	assert.equal((await install(g, ["on-demand"])).code, 0);
	assert.equal((await install(g, ["uninstall", "on-demand", "--purge"])).code, 0);
	assert.equal(fs.existsSync(g.config), false);
	assert.deepEqual(calls(g).filter((c) => !c.includes("is-active")), [], "systemd was only ever asked whether a socket unit is active, before the purge");

	// Refused where a socket unit holds the port: the marker would never matter.
	fs.mkdirSync(g.units, { recursive: true });
	fs.writeFileSync(path.join(g.units, "browser-gateway.socket"), "[Socket]\n");
	const withUser = await install(g, ["on-demand"]);
	assert.deepEqual([withUser.code, withUser.stdout], [1, ""]);
	assert.match(withUser.stderr, /^error: the systemd user units are installed \(.*\): they start the daemon already, and with the port held nothing is ever started on demand\. To switch, remove them first: sh tools\/install\.sh uninstall user\n$/);
	fs.rmSync(g.units, { recursive: true });
	fs.mkdirSync(path.join(g.root, "etc/systemd/user"), { recursive: true });
	fs.writeFileSync(path.join(g.root, "etc/systemd/user/browser-gateway.service"), "[Service]\n");
	const withGlobal = await install(g, ["on-demand"]);
	assert.deepEqual([withGlobal.code, withGlobal.stdout], [1, ""]);
	assert.match(withGlobal.stderr, /^error: the units are installed for all users \(.*\): .* remove them first: sudo sh tools\/install\.sh uninstall global\n$/);
	assert.equal(fs.existsSync(g.config), false, "no marker was written");

	// The checkout has to be able to run a daemon.
	const h = await scratch({ ws: false });
	const bare = await install(h, ["on-demand"]);
	assert.deepEqual([bare.code, bare.stdout], [1, ""]);
	assert.match(bare.stderr, /^error: the daemon's one dependency is missing \(.*node_modules\/ws\)\. Run this in the checkout first: npm ci --omit=dev\n$/);
	assert.equal(fs.existsSync(h.config), false);
});

// ---------------------------------------------------------------- status

t("status reads only, says what answers on the port, and exits 1 for what does not fit together", async () => {
	const g = await scratch();
	/** @returns {Promise<{ code: number, lines: string[], problems: string[] }>} */
	const status = async () => {
		forget(g);
		const before = tree(g.dir);
		const r = await install(g, ["status"]);
		assert.equal(r.stderr, "");
		assert.ok(calls(g).every((c) => /^--user is-active --quiet browser-gateway\.(socket|service)$/.test(c)), calls(g).join(" | "));
		forget(g);
		assert.deepEqual(tree(g.dir), before, "status wrote nothing");
		const lines = r.stdout.split("\n").filter((l) => l !== "");
		return { code: r.code, lines, problems: lines.filter((l) => l.startsWith("problem:")).map((l) => l.replace(/^problem:\s+/, "")) };
	};
	/** @param {string} dir @param {string} program */
	const units = (dir, program) => {
		fs.mkdirSync(dir, { recursive: true });
		for (const name of UNITS) fs.writeFileSync(path.join(dir, name), fs.readFileSync(path.join(REPO, "tools", name), "utf8").replaceAll("@REPO@", program).replaceAll("@PORT@", String(g.port)));
	};
	const sys = path.join(g.root, "etc/systemd/user");

	// Nothing installed: nothing wrong.
	const none = await status();
	assert.deepEqual([none.code, none.problems], [0, []]);
	assert.equal(none.lines.at(-1), "mode:         none of the three; the daemon runs when you start it: cli/bgw daemon start");
	assert.equal(none.lines.at(-2), `daemon:       not running; nothing listens on 127.0.0.1:${g.port}`);

	// What answers on the port, when no socket unit holds it.
	const plain = gatewayOnPort(g);
	await plain.listening;
	assert.equal((await status()).lines.at(-2), `daemon:       a gateway daemon answers on 127.0.0.1:${g.port}`);
	await plain.stop();
	const other = net.createServer((socket) => socket.destroy());
	await /** @type {Promise<void>} */ (new Promise((resolve) => other.listen(g.port, "127.0.0.1", () => resolve())));
	try {
		const squatted = await status();
		assert.deepEqual([squatted.code, squatted.lines.at(-2)], [0, `daemon:       something listens on 127.0.0.1:${g.port}, and it is not the gateway daemon`]);
	} finally {
		await new Promise((resolve) => other.close(() => resolve(undefined)));
	}

	// An autostart entry alone is a way of its own.
	fs.mkdirSync(g.auto);
	fs.writeFileSync(path.join(g.auto, "browser-gateway.desktop"), "[Desktop Entry]\nX-Browser-Gateway-Autostart=1\n");
	const auto = await status();
	assert.deepEqual([auto.code, auto.lines.at(-1)], [0, "mode:         none of the three; the autostart entry starts the daemon at login"]);

	// ... and a conflict next to a socket unit. The service unit is active here.
	units(g.units, g.checkout);
	fs.writeFileSync(path.join(g.bin, "socket-active"), "");
	fs.writeFileSync(path.join(g.bin, "service-active"), "");
	const withAuto = await status();
	assert.deepEqual([withAuto.code, withAuto.problems], [1, ["an autostart entry and a socket unit both want the port at login. Remove the entry: sh tools/autostart.sh remove"]]);
	assert.ok(withAuto.lines.includes("daemon:       running; the socket unit is active and systemd holds the port"));
	assert.equal(withAuto.lines.at(-1), "mode:         user");
	fs.rmSync(g.auto, { recursive: true });
	fs.rmSync(path.join(g.bin, "socket-active"));
	fs.rmSync(path.join(g.bin, "service-active"));
	assert.deepEqual([(await status()).code, (await status()).problems], [0, []]);

	// The marker next to a socket unit never takes effect.
	fs.mkdirSync(g.config, { mode: 0o700 });
	fs.writeFileSync(path.join(g.config, "on-demand"), "", { mode: 0o600 });
	const withMarker = await status();
	assert.deepEqual([withMarker.code, withMarker.problems], [1, ["starting on demand is switched on, but a socket unit holds the port: it never takes effect. Remove it: sh tools/install.sh uninstall on-demand"]]);
	assert.equal(withMarker.lines.at(-1), "mode:         more than one - see the problems above");
	fs.rmSync(g.config, { recursive: true });

	// Units that are not complete, and units whose checkout is gone.
	fs.rmSync(path.join(g.units, "browser-gateway-dirs.service"));
	const partial = await status();
	assert.deepEqual([partial.code, partial.problems], [1, [`the units in ${g.units} are not complete (missing: browser-gateway-dirs.service)`]]);
	units(g.units, "/no/such/checkout");
	const moved = await status();
	assert.deepEqual([moved.code, moved.problems], [1, [`the units in ${g.units} run the daemon from /no/such/checkout, and there is no daemon there (moved or deleted?)`]]);
	units(g.units, g.checkout);

	// Installed twice: for the user and for all users.
	assert.equal((await install(g, ["global"])).code, 0);
	const twice = await status();
	assert.deepEqual([twice.code, twice.problems], [1, ["the units are installed twice, for you and for all users. Yours win in your session. Remove one: sh tools/install.sh uninstall user, or sudo sh tools/install.sh uninstall global"]]);
	assert.equal(twice.lines.at(-1), "mode:         more than one - see the problems above");
	fs.rmSync(g.units, { recursive: true });
	assert.deepEqual([(await status()).code, (await status()).lines.at(-1)], [0, "mode:         global"]);

	// The units for all users: not enabled, their program gone, a prefix that is not this tool's.
	fs.rmSync(path.join(sys, "sockets.target.wants"), { recursive: true });
	assert.deepEqual((await status()).problems, [`the socket unit in ${sys} is not enabled for all users: sudo sh tools/install.sh global`]);
	fs.mkdirSync(path.join(sys, "sockets.target.wants"));
	fs.symlinkSync("../browser-gateway.socket", path.join(sys, "sockets.target.wants/browser-gateway.socket"));
	fs.rmSync(path.join(g.root, "opt/browser-gateway/.bgw-install"));
	assert.deepEqual((await status()).problems, [`${g.root}/opt/browser-gateway was not made by this tool (no .bgw-install in it)`]);
	fs.rmSync(path.join(g.root, "opt"), { recursive: true });
	const orphan = await status();
	assert.deepEqual([orphan.code, orphan.problems], [1, [`the units in ${sys} run the daemon from /opt/browser-gateway, and there is no daemon there (moved or deleted?)`]]);

	// The marker in a checkout that cannot run a daemon.
	fs.rmSync(path.join(g.root, "etc"), { recursive: true });
	fs.mkdirSync(g.config, { mode: 0o700 });
	fs.writeFileSync(path.join(g.config, "on-demand"), "", { mode: 0o600 });
	fs.rmSync(path.join(g.checkout, "node_modules"), { recursive: true });
	const bare = await status();
	assert.equal(bare.code, 1);
	assert.match(bare.problems[0], /^starting on demand is switched on, but this checkout cannot run a daemon \(node_modules\/ws or daemon\/src\/main\.js is missing in .*\): npm ci --omit=dev$/);
});

// ---------------------------------------------------------------- the script itself

t("the script names no real location that an override does not cover, and calls systemctl only through the stand-in hook", async () => {
	const source = fs.readFileSync(path.join(REPO, "tools", "install.sh"), "utf8");
	const code = source
		.split("\n")
		.filter((l) => !/^\s*#/.test(l))
		.join("\n");
	// systemctl is called through sc(), and sc() calls what BGW_SYSTEMCTL names.
	assert.match(code, /^SYSTEMCTL=\$\{BGW_SYSTEMCTL:-systemctl\}$/m);
	assert.match(code, /^sc\(\) \{\n\t"\$SYSTEMCTL" "\$@"\n\}$/m);
	const direct = code.split("\n").filter((l) => /(^|[\s;|&(])systemctl\s+-/.test(l) && !/\b(say|echo|die|problem|warn)\b/.test(l));
	assert.deepEqual(direct, [], "a direct call of systemctl");
	assert.doesNotMatch(code, /\b(sudo|loginctl|journalctl)\b(?![^\n]*["'])/, "nothing but systemctl is ever run to change the system");
	// The system paths it writes below all hang on the stand-in root.
	assert.match(code, /^SYS_UNIT_DIR=\$ROOT\/etc\/systemd\/user$/m);
	assert.match(code, /^BIN_LINK=\$ROOT\/usr\/local\/bin\/bgw$/m);
	assert.match(code, /^\tDEST=\$ROOT\$PREFIX$/m);
	// Root runs neither npm nor node on files of the checkout in the mode for all users.
	const globalBody = /^install_global\(\) \{\n([\s\S]*?)^\}$/m.exec(code)?.[1] ?? "";
	assert.ok(globalBody.length > 500);
	assert.doesNotMatch(globalBody, /\bnpm (ci|install)\b(?![^\n]*["'])/);
	assert.doesNotMatch(globalBody, /\bnode\s+"?\$REPO/);
	// POSIX sh: no bash-only syntax that this check knows of.
	assert.ok(source.startsWith("#!/bin/sh\n"));
	assert.doesNotMatch(code, /(^|\s)\[\[\s|^\s*function\s|^\s*local\s|<<<|\$\{[A-Za-z_]+\[/m);
});
