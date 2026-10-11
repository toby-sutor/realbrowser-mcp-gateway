// What a peer without the key can make the daemon hold in memory. The daemon
// runs as its own process here, so that its memory can be read from outside.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";
import { FAKE_ORIGIN } from "../helpers/fake-extension.js";

const MAIN = fileURLToPath(new URL("../../daemon/src/main.js", import.meta.url));
const MIB = 1048576;

/** @type {string[]} */
const dirs = [];
/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
after(() => {
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	for (const dir of dirs) removeTempDir(dir);
});

/** @returns {Promise<{ pid: number, port: number, stop: () => Promise<void> }>} a daemon of its own, on a port of its own */
async function startDaemonProcess() {
	const dir = makeTempDir("extmem");
	dirs.push(dir);
	// Spelled out in full: nothing of the real daemon's can be reached from here.
	const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", BGW_PORT: "0", BGW_CONFIG_DIR: path.join(dir, "config"), BGW_DATA_DIR: path.join(dir, "data") };
	const child = spawn(process.execPath, [MAIN], { env, stdio: ["ignore", "pipe", "ignore"] });
	children.push(child);
	let stdout = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
	/** @type {Promise<void>} */
	const exited = new Promise((resolve) => child.on("exit", () => resolve()));
	const deadline = Date.now() + 10000;
	for (;;) {
		const m = /browser-gateway listening on 127\.0\.0\.1:(\d+)/.exec(stdout);
		if (m !== null && child.pid !== undefined) {
			return {
				pid: child.pid,
				port: Number(m[1]),
				stop: async () => {
					child.kill("SIGTERM");
					await exited;
				},
			};
		}
		if (Date.now() > deadline || child.exitCode !== null) throw new Error("the daemon did not start");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** @param {number} pid @returns {number} resident memory in bytes */
function rss(pid) {
	const m = /^VmRSS:\s+(\d+) kB$/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
	if (m === null) throw new Error("no VmRSS");
	return Number(m[1]) * 1024;
}

/**
 * A client frame header: FIN, the opcode, masked with a key of zeros (so the
 * payload goes out as it is).
 * @param {number} opcode
 * @param {number} length of the payload that is announced
 */
function frameHeader(opcode, length) {
	const head = Buffer.alloc(length < 126 ? 6 : 14);
	head[0] = 0x80 | opcode;
	if (length < 126) head[1] = 0x80 | length;
	else {
		head[1] = 0x80 | 127;
		head.writeBigUInt64BE(BigInt(length), 2);
	}
	return head;
}

/**
 * One peer without the key: upgrades, sends a frame the daemon refuses, takes
 * no notice of the answer and streams the beginning of one huge frame.
 * @param {number} port
 * @param {number} bytes how much of the frame to send
 * @param {number} overMs
 * @returns {Promise<{ sent: number, closedAfterMs: number | null }>}
 */
function streamAfterRefusal(port, bytes, overMs) {
	return new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		const started = Date.now();
		let sent = 0;
		/** @type {number | null} */
		let closedAfterMs = null;
		let upgraded = false;
		let head = "";
		/** @type {ReturnType<typeof setInterval> | undefined} */
		let pump;
		const chunk = Buffer.alloc(65536, 0x61);
		const done = () => {
			clearInterval(pump);
			socket.destroy();
			resolve({ sent, closedAfterMs });
		};
		socket.on("error", () => {});
		socket.on("close", () => {
			closedAfterMs ??= Date.now() - started;
			done();
		});
		socket.on("connect", () => {
			socket.write(
				`GET /ext HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
					`Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${FAKE_ORIGIN}\r\n\r\n`,
			);
		});
		socket.on("data", (data) => {
			// Whatever the daemon says after the upgrade (its close frame) is ignored.
			if (upgraded) return;
			head += data.toString("latin1");
			if (!head.includes("\r\n\r\n")) return;
			upgraded = true;
			if (!head.startsWith("HTTP/1.1 101")) return done();
			// Not JSON: refused as a protocol violation.
			socket.write(Buffer.concat([frameHeader(1, 1), Buffer.from("x")]));
			// Then one text frame of 15 MiB that never ends.
			socket.write(frameHeader(1, 15 * MIB));
			const perTick = Math.ceil(bytes / (overMs / 10) / chunk.length);
			pump = setInterval(() => {
				for (let i = 0; i < perTick && sent < bytes && !socket.destroyed; i++) {
					socket.write(chunk);
					sent += chunk.length;
				}
				if (sent >= bytes) clearInterval(pump);
			}, 10);
		});
		setTimeout(done, overMs + 2500);
	});
}

test("N1: a refused peer is cut off at once - what it streams after the refusal is not buffered", async () => {
	const daemon = await startDaemonProcess();
	try {
		const before = rss(daemon.pid);
		let peak = before;
		const sampler = setInterval(() => {
			try {
				peak = Math.max(peak, rss(daemon.pid));
			} catch {
				// the daemon went away: the assertions below say so
			}
		}, 25);
		// The reported case, at half size: 24 sockets, 8 MiB each, within a second.
		const peers = await Promise.all(Array.from({ length: 24 }, () => streamAfterRefusal(daemon.port, 8 * MIB, 1000)));
		clearInterval(sampler);
		const grown = peak - before;
		// Buffered whole it would be 192 MiB (measured before the fix: about that).
		assert.ok(grown < 48 * MIB, `the daemon grew by ${Math.round(grown / MIB)} MiB`);
		if (process.env.BGW_TEST_VERBOSE === "1") console.log(`grown ${Math.round(grown / MIB)} MiB, closed after ${peers.map((p) => p.closedAfterMs).join(",")} ms`);
		// Every one of them was dropped by the daemon, and quickly: not after the two seconds a close handshake used to get.
		for (const peer of peers) assert.ok(peer.closedAfterMs !== null && peer.closedAfterMs < 1500, `closed after ${peer.closedAfterMs} ms`);
		// The daemon is still there and serves.
		const res = await fetch(`http://127.0.0.1:${daemon.port}/healthz`);
		assert.equal(res.status, 200);
	} finally {
		await daemon.stop();
	}
});
