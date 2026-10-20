import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";
import { FakeExtension } from "../helpers/fake-extension.js";
import { b64urlEncode, randomBytes } from "../../extension/shared/auth.js";

const MAIN = fileURLToPath(new URL("../../daemon/src/main.js", import.meta.url));

/** @type {string[]} */
const dirs = [];
after(() => {
	for (const dir of dirs) removeTempDir(dir);
});

/**
 * Start daemon/src/main.js as its own process. The environment is spelled out
 * in full, so the child can never fall back to the real port or directories.
 * @param {Record<string, string>} env
 */
function runMain(env) {
	const child = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
	/** @type {Promise<number | null>} */
	const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
	return { child, exited, output: () => ({ stdout, stderr }) };
}

/** @param {number} port @returns {Promise<{ status: number, body: string }>} */
function healthz(port) {
	return new Promise((resolve, reject) => {
		http
			.get({ host: "127.0.0.1", port, path: "/healthz", agent: false }, (res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => (body += chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			})
			.on("error", reject);
	});
}

test("main.js: starts from the environment, serves, and stops cleanly on SIGTERM", { skip: process.platform === "win32" ? "SIGTERM and mode bits" : false }, async () => {
	const dir = makeTempDir("main");
	dirs.push(dir);
	const configDir = path.join(dir, "config");
	const dataDir = path.join(dir, "data");
	const proc = runMain({ BGW_PORT: "0", BGW_CONFIG_DIR: configDir, BGW_DATA_DIR: dataDir });
	try {
		/** @type {number} */
		const port = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no listening line: ${JSON.stringify(proc.output())}`)), 5000);
			const poll = setInterval(() => {
				const m = /browser-gateway listening on 127\.0\.0\.1:(\d+)/.exec(proc.output().stdout);
				if (m === null) return;
				clearInterval(poll);
				clearTimeout(timer);
				resolve(Number(m[1]));
			}, 10);
			proc.exited.then((code) => {
				clearInterval(poll);
				clearTimeout(timer);
				reject(new Error(`exited early with ${code}: ${proc.output().stderr}`));
			});
		});
		assert.notEqual(port, 8791);
		const r = await healthz(port);
		assert.equal(r.status, 200);
		assert.equal(JSON.parse(r.body).name, "browser-gateway");

		assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);
		assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(configDir, "client.token")).mode & 0o777, 0o600);
		assert.equal(fs.statSync(path.join(configDir, "admin.token")).mode & 0o777, 0o600);
		assert.equal(fs.statSync(path.join(dataDir, "audit.jsonl")).mode & 0o777, 0o600);
		const token = fs.readFileSync(path.join(configDir, "client.token"), "utf8").trim();
		const admin = fs.readFileSync(path.join(configDir, "admin.token"), "utf8").trim();
		const { stdout, stderr } = proc.output();
		assert.ok(!stdout.includes(token) && !stderr.includes(token), "the token is not printed at start");
		assert.ok(!stdout.includes(admin) && !stderr.includes(admin), "nor is the admin token");

		proc.child.kill("SIGTERM");
		assert.equal(await proc.exited, 0);
	} finally {
		proc.child.kill("SIGKILL");
	}
});

test("main.js: an exception or a rejection that nothing catches is one line without its message, and exit code 1", { skip: process.platform === "win32" ? "SIGUSR2" : false }, async () => {
	/** @type {[string, string][]} */
	const cases = [
		["uncaught_exception", 'process.on("SIGUSR2",()=>{throw new TypeError("PAGETEXT https://private.example/inbox")})'],
		["unhandled_rejection", 'process.on("SIGUSR2",()=>{Promise.reject(new TypeError("PAGETEXT https://private.example/inbox"))})'],
	];
	for (const [kind, preload] of cases) {
		const dir = makeTempDir("main-fault");
		dirs.push(dir);
		// The fault comes from outside the daemon's own code, on a signal, once it serves.
		const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, MAIN], {
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", BGW_PORT: "0", BGW_CONFIG_DIR: path.join(dir, "config"), BGW_DATA_DIR: path.join(dir, "data") },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
		/** @type {Promise<number | null>} */
		const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
		try {
			const deadline = Date.now() + 10000;
			while (!/browser-gateway listening on/.test(stdout)) {
				if (Date.now() > deadline || child.exitCode !== null) assert.fail(`no listening line: ${JSON.stringify({ stdout, stderr })}`);
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			child.kill("SIGUSR2");
			assert.equal(await exited, 1, kind);
			const lines = stderr.split("\n").filter(Boolean);
			assert.equal(lines.length, 1, stderr);
			const line = JSON.parse(lines[0]);
			assert.deepEqual([line.level, line.event, line.kind, line.name], ["error", "daemon.fatal", kind, "TypeError"]);
			for (const needle of ["PAGETEXT", "private.example"]) assert.ok(!(stdout + stderr).includes(needle), needle);
		} finally {
			child.kill("SIGKILL");
		}
	}
});

test("main.js: a bad BGW_PORT or relative directory stops the start with exit code 2", async () => {
	const dir = makeTempDir("main-bad");
	dirs.push(dir);
	const good = { BGW_PORT: "0", BGW_CONFIG_DIR: path.join(dir, "config"), BGW_DATA_DIR: path.join(dir, "data") };
	for (const [bad, message] of /** @type {[Record<string, string>, RegExp][]} */ ([
		[{ BGW_PORT: "eighty" }, /invalid BGW_PORT: eighty/],
		[{ BGW_PORT: "70000" }, /invalid BGW_PORT: 70000/],
		[{ BGW_CONFIG_DIR: "relative/config" }, /BGW_CONFIG_DIR must be an absolute path/],
		[{ BGW_DATA_DIR: "relative/data" }, /BGW_DATA_DIR must be an absolute path/],
	])) {
		const proc = runMain({ ...good, ...bad });
		assert.equal(await proc.exited, 2, JSON.stringify(bad));
		assert.match(proc.output().stderr, message);
	}
	assert.equal(fs.existsSync(path.join(dir, "config")), false, "nothing was created");
	assert.equal(fs.existsSync(path.join(dir, "data")), false);
});

/** @param {ReturnType<typeof runMain>} proc @returns {Promise<number>} the port from the "listening" line */
function listeningPort(proc) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no listening line: ${JSON.stringify(proc.output())}`)), 5000);
		const poll = setInterval(() => {
			const m = /browser-gateway listening on 127\.0\.0\.1:(\d+)/.exec(proc.output().stdout);
			if (m === null) return;
			clearInterval(poll);
			clearTimeout(timer);
			resolve(Number(m[1]));
		}, 10);
		proc.exited.then((code) => {
			clearInterval(poll);
			clearTimeout(timer);
			reject(new Error(`exited early with ${code}: ${proc.output().stderr}`));
		});
	});
}

/**
 * A listening TCP socket of this process.
 * @param {string} address
 * @returns {Promise<import("node:net").Server & { port: number }>}
 */
async function listener(address) {
	const net = await import("node:net");
	const server = net.createServer((socket) => socket.destroy());
	await /** @type {Promise<void>} */ (new Promise((resolve, reject) => server.once("error", reject).listen(0, address, () => resolve())));
	const addr = server.address();
	return Object.assign(server, { port: addr !== null && typeof addr !== "string" ? addr.port : 0 });
}

// What systemd does for a socket-activated service, in a dozen lines: bind and
// listen, put the socket on descriptor 3, name the process it is meant for in
// LISTEN_PID, and become that process.
const ACTIVATE = `
import os, socket, sys
address, port_mode, fds, pid, node, main = sys.argv[1:7]
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind((address, 0))
s.listen(16)
port = s.getsockname()[1]
if s.fileno() != 3:
    os.dup2(s.fileno(), 3)
os.set_inheritable(3, True)
os.environ["LISTEN_FDS"] = fds
os.environ["LISTEN_PID"] = str(os.getpid()) if pid == "self" else pid
os.environ["BGW_PORT"] = {"match": str(port), "other": str(port + 1 if port < 65535 else port - 1), "any": "0"}[port_mode]
os.execv(node, [node, main])
`;

/**
 * Start main.js with a listening socket handed over the way systemd does it.
 * @param {Record<string, string>} env
 * @param {{ address?: string, port?: "match" | "other" | "any", listenPid?: string, listenFds?: string }} [opts]
 *   port: what BGW_PORT says compared to the port the socket is bound to
 */
function runActivated(env, opts = {}) {
	const args = ["-c", ACTIVATE, opts.address ?? "127.0.0.1", opts.port ?? "match", opts.listenFds ?? "1", opts.listenPid ?? "self", process.execPath, MAIN];
	const child = spawn(process.env.PYTHON || "python3", args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
	/** @type {Promise<number | null>} */
	const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
	return { child, exited, output: () => ({ stdout, stderr }) };
}

test("main.js: a taken port is one clear line and exit code 3", async () => {
	const dir = makeTempDir("main-inuse");
	dirs.push(dir);
	const squatter = await listener("127.0.0.1");
	try {
		const proc = runMain({ BGW_PORT: String(squatter.port), BGW_CONFIG_DIR: path.join(dir, "config"), BGW_DATA_DIR: path.join(dir, "data") });
		assert.equal(await proc.exited, 3);
		const { stdout, stderr } = proc.output();
		assert.equal(stderr.trimEnd().split("\n").filter((l) => !l.startsWith("{")).join("\n"), `browser-gateway: 127.0.0.1:${squatter.port} is already in use by another process - not starting`);
		assert.ok(!stdout.includes("listening"), "it never claims to listen");
		assert.ok(!stderr.includes("    at "), "no stack trace");
	} finally {
		await /** @type {Promise<void>} */ (new Promise((resolve) => squatter.close(() => resolve())));
	}
});

test("main.js: a config.json that cannot be used is exit code 2, with the reason", async () => {
	const dir = makeTempDir("main-config");
	dirs.push(dir);
	const configDir = path.join(dir, "config");
	fs.mkdirSync(configDir, { mode: 0o700 });
	fs.writeFileSync(path.join(configDir, "config.json"), '{"retention_days": "forever"}', { mode: 0o600 });
	const proc = runMain({ BGW_PORT: "0", BGW_CONFIG_DIR: configDir, BGW_DATA_DIR: path.join(dir, "data") });
	assert.equal(await proc.exited, 2);
	assert.equal(proc.output().stderr, "browser-gateway: config.json: retention_days must be an integer from 1 to 3650\n");
	assert.deepEqual(fs.readdirSync(configDir), ["config.json"]);
});

test("main.js: socket activation - it serves on the socket systemd hands over", { skip: process.platform === "win32" ? "systemd socket activation" : false }, async () => {
	const dir = makeTempDir("main-activated");
	dirs.push(dir);
	const proc = runActivated({ BGW_CONFIG_DIR: path.join(dir, "config"), BGW_DATA_DIR: path.join(dir, "data") });
	try {
		const port = await listeningPort(proc);
		assert.notEqual(port, 8791);
		assert.match(proc.output().stdout, new RegExp(`browser-gateway listening on 127\\.0\\.0\\.1:${port} \\(socket handed over by the service manager\\)`));
		const r = await healthz(port);
		assert.equal(r.status, 200);
		assert.equal(JSON.parse(r.body).name, "browser-gateway");
		assert.match(proc.output().stdout, new RegExp(`"event":"daemon\\.listening","port":${port},"paired":false,"socket_activated":true`));
		// The same process that was handed the socket serves it.
		assert.equal(fs.statSync(path.join(dir, "config", "client.token")).mode & 0o777, 0o600);
		proc.child.kill("SIGTERM");
		assert.equal(await proc.exited, 0);
	} finally {
		proc.child.kill("SIGKILL");
	}
});

test("main.js: a handed-over socket that is not 127.0.0.1:<port> is refused with exit code 4", { skip: process.platform === "win32" ? "systemd socket activation" : false }, async () => {
	const dir = makeTempDir("main-badsocket");
	dirs.push(dir);
	const env = { BGW_CONFIG_DIR: path.join(dir, "config"), BGW_DATA_DIR: path.join(dir, "data") };
	/** @type {ReturnType<typeof runActivated>[]} */
	const procs = [];
	try {
		// The right address, but not the port the clients are told.
		const wrongPort = runActivated(env, { port: "other" });
		procs.push(wrongPort);
		assert.equal(await wrongPort.exited, 4);
		assert.match(wrongPort.output().stderr, /^browser-gateway: the listening socket is bound to 127\.0\.0\.1:\d+, expected 127\.0\.0\.1:\d+ - not starting$/m);
		const ports = /bound to 127\.0\.0\.1:(\d+), expected 127\.0\.0\.1:(\d+)/.exec(wrongPort.output().stderr);
		assert.notEqual(ports?.[1], ports?.[2]);

		// Another address: still loopback here, but the rule is 127.0.0.1 and nothing else.
		const wrongAddress = runActivated(env, { address: "127.0.0.2" });
		procs.push(wrongAddress);
		assert.equal(await wrongAddress.exited, 4);
		assert.match(wrongAddress.output().stderr, /^browser-gateway: the listening socket is bound to 127\.0\.0\.2:(\d+), expected 127\.0\.0\.1:\1 - not starting$/m);

		// More than one socket: the unit is not the one this daemon belongs to.
		const twoSockets = runActivated(env, { listenFds: "2" });
		procs.push(twoSockets);
		assert.equal(await twoSockets.exited, 4);
		assert.match(twoSockets.output().stderr, /^browser-gateway: expected exactly one socket from the service manager/m);

		for (const proc of procs) assert.ok(!proc.output().stdout.includes("listening on"));
	} finally {
		for (const proc of procs) proc.child.kill("SIGKILL");
	}
});

/**
 * A config directory that already holds an extension key, as after a pairing.
 * @param {string} dir
 * @returns {{ configDir: string, key: import("../../extension/shared/auth.js").Bytes }}
 */
function pairedConfig(dir) {
	const configDir = path.join(dir, "config");
	fs.mkdirSync(configDir, { mode: 0o700 });
	const key = randomBytes(32);
	fs.writeFileSync(path.join(configDir, "ext.key"), b64urlEncode(key) + "\n", { mode: 0o600 });
	return { configDir, key };
}

/**
 * The extension handshake against a daemon process: with proofs for the port
 * that was dialled, and with proofs for the port next to it.
 * @param {number} port
 * @param {import("../../extension/shared/auth.js").Bytes} key
 */
async function handshakeNamesPort(port, key) {
	const ext = new FakeExtension({ port });
	ext.key = key;
	try {
		const r = await ext.connect();
		assert.deepEqual(r, { ready: true, httpStatus: null, closeCode: null, closeReason: null, serverMacValid: true }, `the proofs name port ${port}`);
		await ext.close();
		const other = port < 65535 ? port + 1 : port - 1;
		const wrong = await ext.connect({ macPort: other, ignoreServerMac: true });
		assert.equal(wrong.serverMacValid, false, "the daemon's proof is not one for another port");
		assert.equal(wrong.closeCode, 4001, "and it takes no proof made for another port");
	} finally {
		await ext.kill();
	}
}

test("main.js: the handshake proofs name the port of BGW_PORT, whatever it is", async () => {
	const dir = makeTempDir("main-port");
	dirs.push(dir);
	const { configDir, key } = pairedConfig(dir);
	// A port that is free right now, named outright as an operator would name one.
	const free = await listener("127.0.0.1");
	const chosen = free.port;
	await /** @type {Promise<void>} */ (new Promise((resolve) => free.close(() => resolve())));
	const proc = runMain({ BGW_PORT: String(chosen), BGW_CONFIG_DIR: configDir, BGW_DATA_DIR: path.join(dir, "data") });
	try {
		assert.equal(await listeningPort(proc), chosen);
		assert.notEqual(chosen, 8791);
		await handshakeNamesPort(chosen, key);
		proc.child.kill("SIGTERM");
		assert.equal(await proc.exited, 0);
	} finally {
		proc.child.kill("SIGKILL");
	}
});

test("main.js: socket activation - the handshake proofs name the port of the socket that was handed over", { skip: process.platform === "win32" ? "systemd socket activation" : false }, async () => {
	const dir = makeTempDir("main-activated-port");
	dirs.push(dir);
	const { configDir, key } = pairedConfig(dir);
	const proc = runActivated({ BGW_CONFIG_DIR: configDir, BGW_DATA_DIR: path.join(dir, "data") });
	try {
		const port = await listeningPort(proc);
		assert.match(proc.output().stdout, /socket handed over by the service manager/);
		await handshakeNamesPort(port, key);
		proc.child.kill("SIGTERM");
		assert.equal(await proc.exited, 0);
	} finally {
		proc.child.kill("SIGKILL");
	}
});

test("main.js: LISTEN_FDS meant for another process is ignored", { skip: process.platform === "win32" ? "systemd socket activation" : false }, async () => {
	const dir = makeTempDir("main-foreignfds");
	dirs.push(dir);
	// A parent that was socket-activated itself leaves these variables behind.
	const proc = runActivated({ BGW_CONFIG_DIR: path.join(dir, "config"), BGW_DATA_DIR: path.join(dir, "data") }, { port: "any", listenPid: "1" });
	try {
		const port = await listeningPort(proc);
		assert.ok(!proc.output().stdout.includes("socket handed over"));
		assert.equal((await healthz(port)).status, 200);
		proc.child.kill("SIGTERM");
		assert.equal(await proc.exited, 0);
	} finally {
		proc.child.kill("SIGKILL");
	}
});
