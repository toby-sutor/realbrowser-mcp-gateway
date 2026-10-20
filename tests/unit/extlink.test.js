import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestDaemon, until } from "../helpers/daemon.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FAKE_ORIGIN, FakeExtension, makeResult } from "../helpers/fake-extension.js";
import { b64urlEncode, generatePairingCode, parsePairingCode, randomBytes, randomNonce } from "../../extension/shared/auth.js";
import { HANDSHAKE_CORE_SINCE, MSG, PROTOCOL_VERSION, makeMessage, zeroTimings } from "../../extension/shared/protocol.js";
import { LIMITS } from "../../daemon/src/config.js";

// Windows has no mode bits: what they are is checked where there are.
const MODES = process.platform !== "win32";

/**
 * @typedef {Awaited<ReturnType<typeof startTestDaemon>>} TestDaemon
 */

/**
 * Run a test body against its own daemon (driven by a fake clock) and clean
 * up whatever happens.
 * @param {(ctx: { daemon: TestDaemon, clock: FakeClock, ext: (opts?: Partial<ConstructorParameters<typeof FakeExtension>[0]>) => FakeExtension, paired: () => Promise<FakeExtension> }) => Promise<void>} body
 * @param {Parameters<typeof startTestDaemon>[0]} [opts]
 */
async function withDaemon(body, opts = {}) {
	const clock = new FakeClock();
	const daemon = await startTestDaemon({ clock, ...opts });
	/** @type {FakeExtension[]} */
	const extensions = [];
	/** @param {Partial<ConstructorParameters<typeof FakeExtension>[0]>} [o] */
	const ext = (o = {}) => {
		const e = new FakeExtension({ port: daemon.port, ...o });
		extensions.push(e);
		return e;
	};
	const paired = async () => {
		const e = ext();
		const r = await e.pair(await daemon.pairCode());
		assert.equal(r.ready, true, "pairing in test setup failed");
		return e;
	};
	try {
		await body({ daemon, clock, ext, paired });
	} finally {
		for (const e of extensions) await e.kill();
		await daemon.stop();
	}
}

/**
 * Wait until the daemon has handled every frame this extension sent so far:
 * frames are handled in order, so the pong to a fresh ping proves it.
 * @param {FakeExtension} ext
 */
async function flush(ext) {
	const t = Math.floor(Math.random() * 1e9) + 1;
	ext.send(makeMessage(MSG.PING, { t }));
	await ext.waitFor(MSG.PONG, { match: (f) => f.t === t });
}

/** @param {TestDaemon} daemon @param {string} event */
const logged = (daemon, event) => daemon.logs.map((l) => JSON.parse(l)).filter((l) => l.event === event);

/**
 * How many lines of an event the log throttle counted instead of writing.
 * @param {TestDaemon} daemon @param {string} event
 */
const suppressed = (daemon, event) =>
	logged(daemon, "log.suppressed")
		.filter((l) => l.suppressed_event === event)
		.reduce((n, l) => n + l.count, 0);

test("pair with a one-time code, then reconnect in auth mode", async () => {
	await withDaemon(async ({ daemon, ext }) => {
		assert.equal((await daemon.status()).paired, false);
		const code = await daemon.pairCode();
		const e = ext();
		const paired = await e.pair(code);
		assert.deepEqual(paired, { ready: true, httpStatus: null, closeCode: null, closeReason: null, serverMacValid: true });
		assert.ok(e.key);

		// Both sides derived the same long-lived key; the daemon stored it 0600.
		const keyFile = path.join(daemon.configDir, "ext.key");
		assert.equal(fs.readFileSync(keyFile, "utf8").trim(), b64urlEncode(e.key));
		if (MODES) assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);

		const ready = e.received.find((f) => f.type === MSG.READY);
		assert.deepEqual(ready?.limits, { max_result_bytes: 8388608, ping_s: 20 });
		const status = await daemon.status();
		assert.equal(status.paired, true);
		assert.equal(status.pairing, undefined, "status says nothing about pairing codes");
		assert.equal(status.extension.connected, true);
		assert.equal(status.extension.ext_version, "0.0.0-test");
		assert.deepEqual(status.extension.browser, { name: "Waterfox", version: "6.7.5" });
		assert.deepEqual(status.extension.state, e.state);

		await e.close();
		await until(async () => (await daemon.status()).extension.connected === false, { what: "disconnect to register" });

		const again = await e.connect();
		assert.deepEqual(again, { ready: true, httpStatus: null, closeCode: null, closeReason: null, serverMacValid: true });
		assert.equal((await daemon.status()).extension.connected, true);
		assert.deepEqual(e.invalidFrames, [], "every frame from the daemon passes the shared validator");
		assert.deepEqual(logged(daemon, "ext.connected").map((l) => l.mode), ["pair", "auth"]);
	});
});

test("the key survives a daemon restart", async () => {
	const clock = new FakeClock();
	const first = await startTestDaemon({ clock });
	const e = new FakeExtension({ port: first.port });
	assert.equal((await e.pair(await first.pairCode())).ready, true);
	const key = e.key;
	await e.close();
	await first.close();

	const second = await startTestDaemon({ clock, configDir: first.configDir, dataDir: first.dataDir });
	try {
		assert.equal(second.token, first.token);
		const e2 = new FakeExtension({ port: second.port });
		e2.key = key;
		const r = await e2.connect();
		assert.equal(r.ready, true);
		assert.equal(r.serverMacValid, true);
		await e2.close();
	} finally {
		await second.stop();
		await first.stop();
	}
});

test("the daemon proves knowledge of the key first, and the client can check it", async () => {
	await withDaemon(async ({ daemon, ext, paired }) => {
		const good = await paired();
		await good.close();

		// With the right key the proof verifies before the client has sent any MAC.
		const probe = ext();
		probe.key = good.key;
		const seen = await probe.connect({ stopAfter: "challenge" });
		assert.equal(seen.serverMacValid, true);
		assert.equal(seen.ready, false);
		const sentTypes = probe.sent.map((f) => f.type);
		assert.deepEqual(sentTypes, [MSG.HELLO], "nothing but hello left the client before the daemon proved itself");
		const challenge = probe.received.find((f) => f.type === MSG.CHALLENGE);
		assert.match(challenge?.nonce_s, /^[A-Za-z0-9_-]{43}$/);
		assert.match(challenge?.mac_s, /^[A-Za-z0-9_-]{43}$/);
		assert.match(challenge?.instance, /^[A-Za-z0-9_-]{16}$/);
		await probe.kill();

		// A client holding another key sees that the proof does not verify and stops.
		const stranger = ext();
		const r = await stranger.connect({ key: randomBytes(32) });
		assert.equal(r.serverMacValid, false);
		assert.equal(r.ready, false);
		assert.deepEqual(stranger.sent.map((f) => f.type), [MSG.HELLO], "no auth frame was sent to an unproven peer");

		// Fresh nonce and MAC on every handshake: nothing to replay.
		const p2 = ext();
		p2.key = good.key;
		await p2.connect({ stopAfter: "challenge" });
		const c2 = p2.received.find((f) => f.type === MSG.CHALLENGE);
		assert.notEqual(c2?.nonce_s, challenge?.nonce_s);
		assert.notEqual(c2?.mac_s, challenge?.mac_s);
		assert.equal(c2?.instance, challenge?.instance, "same daemon process, same instance id");
	});
});

test("both MACs are bound to the mode: a proof for one mode is refused in the other", async () => {
	await withDaemon(async ({ daemon, clock, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);

		// hello says "auth", the MACs are computed as if for "pair", with the right key.
		const confused = ext();
		confused.key = good.key;
		const seen = await confused.connect({ macMode: "pair" });
		assert.equal(seen.serverMacValid, false, "the daemon's proof is for the mode in hello, not for another");
		assert.deepEqual(confused.sent.map((f) => f.type), [MSG.HELLO]);

		clock.advance(60000);
		const forced = ext();
		forced.key = good.key;
		const r = await forced.connect({ macMode: "pair", ignoreServerMac: true });
		assert.equal(r.ready, false);
		assert.equal(r.closeCode, 4001, "an extension proof for pair mode is not accepted in auth mode");

		// And the other way round, with a real pairing code.
		clock.advance(60000);
		const code = await daemon.pairCode();
		const pairing = ext();
		const p = await pairing.pair(code, { macMode: "auth", ignoreServerMac: true });
		assert.equal(p.serverMacValid, false);
		assert.equal(p.closeCode, 4001);
		assert.equal(pairing.key, null);
		assert.equal(logged(daemon, "pairing.ext_key_replaced").length, 0);

		clock.advance(60000);
		assert.equal((await good.connect()).ready, true, "the untampered handshake still works");
	});
});

test("both MACs are bound to the daemon instance", async () => {
	await withDaemon(async ({ daemon, clock, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);

		const other = ext();
		other.key = good.key;
		const r = await other.connect({ macInstance: "someOtherInstance", ignoreServerMac: true });
		assert.equal(r.serverMacValid, false);
		assert.equal(r.closeCode, 4001, "a proof over another instance id is refused by the daemon");
		clock.advance(60000);

		// A restarted daemon has a new instance id; the stored key keeps working with it.
		const first = good.received.find((f) => f.type === MSG.CHALLENGE)?.instance;
		const restarted = await startTestDaemon({ clock, configDir: daemon.configDir, dataDir: daemon.dataDir });
		try {
			const e = new FakeExtension({ port: restarted.port });
			e.key = good.key;
			const again = await e.connect();
			assert.equal(again.ready, true);
			assert.notEqual(e.received.find((f) => f.type === MSG.CHALLENGE)?.instance, first);
			await e.kill();
		} finally {
			// Closes the second daemon and removes its own (unused) temp directory;
			// the shared config directory belongs to the first one.
			await restarted.stop();
		}
	});
});

test("a challenge relayed with a different instance fails on the client side", async () => {
	await withDaemon(async ({ daemon, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);

		// A process in the middle: it passes frames between extension and daemon
		// and rewrites the instance id in the challenge.
		const { WebSocketServer, WebSocket } = await import("ws");
		/** @type {string[]} frame types the relay passed on towards the daemon */
		const upstreamTypes = [];
		const relay = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
		await /** @type {Promise<void>} */ (new Promise((resolve) => relay.once("listening", () => resolve())));
		relay.on("connection", (client) => {
			const upstream = new WebSocket(`ws://127.0.0.1:${daemon.port}/ext`, { origin: FAKE_ORIGIN, perMessageDeflate: false });
			/** @type {string[]} */
			const early = [];
			client.on("message", (data) => {
				const text = data.toString();
				upstreamTypes.push(JSON.parse(text).type);
				if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
				else early.push(text);
			});
			upstream.on("open", () => {
				for (const text of early) upstream.send(text);
			});
			upstream.on("message", (data) => {
				const frame = JSON.parse(data.toString());
				if (frame.type === MSG.CHALLENGE) frame.instance = "forgedInstance000";
				client.send(JSON.stringify(frame));
			});
			upstream.on("close", () => client.close());
			upstream.on("error", () => client.close());
			client.on("close", () => upstream.terminate());
		});
		const addr = relay.address();
		const relayPort = typeof addr === "object" && addr !== null ? addr.port : 0;
		try {
			const victim = new FakeExtension({ port: relayPort });
			victim.key = good.key;
			const r = await victim.connect();
			assert.equal(r.serverMacValid, false, "the proof does not cover the forged instance");
			assert.equal(r.ready, false);
			assert.equal(victim.received.find((f) => f.type === MSG.CHALLENGE)?.instance, "forgedInstance000");
			assert.deepEqual(victim.sent.map((f) => f.type), [MSG.HELLO], "the extension refused: no auth frame left it");
			assert.deepEqual(upstreamTypes, [MSG.HELLO]);
			assert.equal((await daemon.status()).extension.connected, false);

			// The same relay without tampering would have worked: the check above is about the instance.
			assert.equal((await good.connect()).ready, true);
		} finally {
			for (const client of relay.clients) client.terminate();
			await /** @type {Promise<void>} */ (new Promise((resolve) => relay.close(() => resolve())));
		}
	});
});

test("wrong key: close 4001", async () => {
	await withDaemon(async ({ daemon, clock, ext, paired }) => {
		const good = await paired();
		await good.close();

		const corrupt = ext();
		corrupt.key = good.key;
		const r1 = await corrupt.connect({ corruptMac: true });
		assert.equal(r1.ready, false);
		assert.equal(r1.closeCode, 4001);
		assert.equal(r1.closeReason, "auth_failed");
		assert.equal(r1.serverMacValid, true);

		clock.advance(60000);
		const wrongKey = ext();
		const r2 = await wrongKey.connect({ key: randomBytes(32), ignoreServerMac: true });
		assert.equal(r2.closeCode, 4001);
		assert.equal(r2.ready, false);

		assert.equal((await daemon.status()).extension.connected, false);
		assert.equal(logged(daemon, "ext.auth_failed").length, 2);
		// The real key still works afterwards.
		clock.advance(60000);
		assert.equal((await good.connect()).ready, true);
	});
});

test("failed handshakes do not lock the real extension out", async () => {
	await withDaemon(async ({ daemon, clock, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		const attacker = ext();
		attacker.key = good.key;

		// Before the fix one wrong MAC closed the door for 500 ms, growing to 30 s
		// per failure: a key-less peer could keep the extension out for good.
		for (let i = 0; i < 40; i++) {
			const r = i % 2 === 0 ? await attacker.connect({ corruptMac: true }) : await ext().connect({ key: randomBytes(32), ignoreServerMac: true });
			assert.equal(r.closeCode, 4001, `failure ${i + 1}`);
			assert.equal(r.closeReason, "auth_failed");
		}
		// No time has passed, and the right key is served at once.
		const r = await good.connect();
		assert.deepEqual(r, { ready: true, httpStatus: null, closeCode: null, closeReason: null, serverMacValid: true });
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);

		// Nothing is ever answered with "try again later".
		assert.equal(logged(daemon, "ext.auth_throttled").length, 0);
		for (let i = 0; i < 10; i++) assert.notEqual((await attacker.connect({ corruptMac: true })).closeCode, 1013);
		assert.equal((await good.connect()).ready, true);

		// The failures are in the log, but not one line each.
		assert.equal(logged(daemon, "ext.auth_failed").length, LIMITS.refusalLogBurst);
		assert.ok(!daemon.logs.join("\n").includes('"failures"'), "no failure counter exists");
		clock.advance(LIMITS.refusalLogIntervalMs);
		assert.equal(suppressed(daemon, "ext.auth_failed"), 50 - LIMITS.refusalLogBurst);
	});
});

test("failed handshakes do not get in the way of pairing either", async () => {
	await withDaemon(async ({ daemon, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		const stale = ext();
		stale.key = good.key;
		for (let i = 0; i < 10; i++) assert.equal((await stale.connect({ corruptMac: true })).closeCode, 4001);
		const fresh = ext();
		assert.equal((await fresh.pair(await daemon.pairCode())).ready, true);
	});
});

test("auth mode does not tell whether an extension is paired", async () => {
	await withDaemon(async ({ daemon, ext }) => {
		/**
		 * What a peer without the key can observe of one auth-mode handshake.
		 * @param {boolean} sendAuth
		 */
		const observe = async (sendAuth) => {
			const e = ext();
			const r = await e.connect({ key: randomBytes(32), ...(sendAuth ? { ignoreServerMac: true } : { ignoreServerMac: true, stopAfter: "challenge" }) });
			const challenge = e.received.find((f) => f.type === MSG.CHALLENGE);
			assert.ok(challenge, "a well-formed hello is always answered with a challenge");
			assert.deepEqual(e.invalidFrames, []);
			const seen = {
				frames: e.received.map((f) => f.type),
				challengeKeys: Object.keys(challenge).sort(),
				lengths: [challenge.nonce_s.length, challenge.mac_s.length, challenge.instance.length],
				serverMacValid: r.serverMacValid,
				close: sendAuth ? [r.closeCode, r.closeReason] : null,
			};
			await e.kill();
			return { seen, challenge };
		};

		// No key is stored: the daemon has never been paired.
		assert.equal((await daemon.status()).paired, false);
		const unpaired = [await observe(true), await observe(false)];
		assert.equal(fs.existsSync(path.join(daemon.configDir, "ext.key")), false, "answering made no key");
		assert.equal((await daemon.status()).paired, false);

		const real = ext();
		assert.equal((await real.pair(await daemon.pairCode())).ready, true);
		await real.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		const paired = [await observe(true), await observe(false)];

		assert.deepEqual(unpaired[0].seen, paired[0].seen);
		assert.deepEqual(unpaired[1].seen, paired[1].seen);
		assert.deepEqual(unpaired[0].seen, {
			frames: ["challenge"],
			challengeKeys: ["instance", "mac_s", "nonce_s", "type", "v"],
			lengths: [43, 43, 16],
			serverMacValid: false,
			close: [4001, "auth_failed"],
		});
		// Every challenge is fresh: nothing repeats that could mark the unpaired state.
		const all = [...unpaired, ...paired];
		assert.equal(new Set(all.map((o) => o.challenge.mac_s)).size, 4);
		assert.equal(new Set(all.map((o) => o.challenge.nonce_s)).size, 4);
		// The close code that said "not paired" to anybody who asked is not sent any more.
		assert.equal(logged(daemon, "ext.protocol_violation").length, 0);
		// The operator still reads it in the log - once for each hello that came while no key was stored.
		assert.equal(logged(daemon, "ext.not_paired").length + suppressed(daemon, "ext.not_paired"), 2);
		assert.equal(logged(daemon, "ext.not_paired")[0].level, "warn");
		// And the extension that does hold the key connects as ever.
		assert.equal((await real.connect()).ready, true);
	});
});

test("not paired: nobody gets in, whatever key is presented, and it is not counted as an attack", async () => {
	await withDaemon(async ({ daemon, ext }) => {
		for (let i = 0; i < 12; i++) {
			const e = ext();
			const r = await e.connect({ key: randomBytes(32), ignoreServerMac: true });
			assert.deepEqual(r, { ready: false, httpStatus: null, closeCode: 4001, closeReason: "auth_failed", serverMacValid: false });
		}
		assert.equal((await daemon.status()).paired, false);
		assert.equal((await daemon.status()).extension.connected, false);
		assert.equal(fs.existsSync(path.join(daemon.configDir, "ext.key")), false);
		// Nothing is held against anybody for it: pairing works right after.
		const real = ext();
		assert.equal((await real.pair(await daemon.pairCode())).ready, true);
	});
});

test("not paired, and a pairing completes during an auth-mode handshake: the handshake is still refused", async () => {
	await withDaemon(async ({ daemon, ext }) => {
		// hello while no key is stored...
		const early = ext();
		const half = await early.connect({ key: randomBytes(32), ignoreServerMac: true, stopAfter: "challenge" });
		assert.equal(half.serverMacValid, false);
		// ...then an extension pairs on another socket and leaves...
		const real = ext();
		assert.equal((await real.pair(await daemon.pairCode())).ready, true);
		await real.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		// ...and the first peer answers its challenge. Whatever it sends, the key that challenge was made from is gone.
		early.send(makeMessage(MSG.AUTH, { mac_c: b64urlEncode(randomBytes(32)), state: early.state }));
		assert.equal((await early.closed).code, 4001);
		assert.equal((await daemon.status()).extension.connected, false);
	});
});

test("the proofs name the port: the daemon's is good for the port it listens on only, and it takes none made for another", async () => {
	await withDaemon(async ({ daemon, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		for (const port of [daemon.port + 1, daemon.port - 1, 8791, 1, 65535].filter((p) => p !== daemon.port && p >= 1 && p <= 65535)) {
			// A peer that reckons with another port than the one this daemon listens on - because it
			// dialled that port and something passed its frames on.
			const careful = ext();
			careful.key = good.key;
			const seen = await careful.connect({ macPort: port });
			assert.deepEqual(seen, { ready: false, httpStatus: null, closeCode: null, closeReason: null, serverMacValid: false }, `port ${port}: the daemon's proof does not verify`);
			await careful.kill();
			// One that carries on regardless: its own proof is refused, like a wrong key.
			const careless = ext();
			careless.key = good.key;
			const r = await careless.connect({ macPort: port, ignoreServerMac: true });
			assert.deepEqual(r, { ready: false, httpStatus: null, closeCode: 4001, closeReason: "auth_failed", serverMacValid: false }, `port ${port}`);
		}
		assert.equal((await daemon.status()).extension.connected, false);
		// Pair mode likewise - and the code is not used up by it.
		const code = await daemon.pairCode();
		const pairing = ext();
		const p = await pairing.pair(code, { macPort: daemon.port + 1, ignoreServerMac: true });
		assert.deepEqual(p, { ready: false, httpStatus: null, closeCode: 4001, closeReason: "auth_failed", serverMacValid: false });
		assert.equal(pairing.key, null);
		assert.equal((await ext().pair(code)).ready, true, "the code still works for the port it was made for");
	});
});

test("the Host header has no say in what the proofs name", async () => {
	// A peer cannot talk the daemon into a proof for another port: a Host that
	// names one is refused before any frame, and nothing else it sends is used.
	await withDaemon(async ({ daemon, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		const e = ext();
		e.key = good.key;
		const r = await e.connect({ headers: { Host: `127.0.0.1:${daemon.port + 1}` }, macPort: daemon.port + 1 });
		assert.equal(r.httpStatus, 403);
		assert.equal(r.serverMacValid, null, "no challenge was made");
	});
});

test("a hello from before the handshake core: close 4003 before any proof, said in the log, and the pairing stays", async () => {
	await withDaemon(async ({ daemon, clock, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		const keyFile = path.join(daemon.configDir, "ext.key");
		const keyBefore = fs.readFileSync(keyFile, "utf8");
		// Versions that made their proofs in another form, and numbers that are no version at all.
		const versions = [HANDSHAKE_CORE_SINCE - 1, 1, 0, -6, 5.5];
		for (const version of versions) {
			const e = ext();
			e.key = good.key;
			const r = await e.connect({ version });
			assert.deepEqual(r, { ready: false, httpStatus: null, closeCode: 4003, closeReason: "protocol_version", serverMacValid: null }, `v=${version}`);
			// Not one frame came back: no challenge, so no proof in any form.
			assert.deepEqual(e.received, [], `v=${version}`);
		}
		const pairing = ext();
		const code = await daemon.pairCode();
		const r = await pairing.pair(code, { version: HANDSHAKE_CORE_SINCE - 1 });
		assert.equal(r.closeCode, 4003);
		assert.deepEqual(pairing.received, []);

		// The operator finds the reason in the log, with both numbers and what to do.
		const said = logged(daemon, "ext.version_mismatch");
		assert.equal(said[0].level, "warn");
		assert.deepEqual(
			{ peer: said[0].peer_protocol, daemon: said[0].daemon_protocol, advice: said[0].advice },
			{ peer: HANDSHAKE_CORE_SINCE - 1, daemon: PROTOCOL_VERSION, advice: "update the daemon and the extension to the same release" },
		);
		// A peer can do this as often as it likes: the journal is not flooded by it.
		assert.equal(said.length, Math.min(versions.length + 1, LIMITS.refusalLogBurst));
		clock.advance(LIMITS.refusalLogIntervalMs);
		assert.equal(said.length + suppressed(daemon, "ext.version_mismatch"), versions.length + 1);

		// Nothing was lost over it: the key is the same, the code is still good, and an
		// extension of this version connects as before.
		assert.equal(fs.readFileSync(keyFile, "utf8"), keyBefore);
		assert.equal((await daemon.status()).paired, true);
		assert.equal(logged(daemon, "ext.auth_failed").length, 0);
		assert.equal((await good.connect()).ready, true);
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		assert.equal((await pairing.pair(code)).ready, true);
	});
});

test("an extension of another version from the handshake core on: it gets the daemon's proof, with both versions in it, and then nothing", async () => {
	await withDaemon(async ({ daemon, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		const keyFile = path.join(daemon.configDir, "ext.key");
		const keyBefore = fs.readFileSync(keyFile, "utf8");
		/** @param {import("../helpers/fake-extension.js").HandshakeOptions} opts */
		const withKey = (opts) => {
			const e = ext();
			e.key = good.key;
			return { e, done: e.connect(opts) };
		};

		for (const version of [PROTOCOL_VERSION + 1, PROTOCOL_VERSION + 2, 99, 2 ** 40]) {
			// What such an extension does: it checks the proof, sees the other version in the challenge, and leaves.
			const careful = withKey({ version, stopAfter: "challenge" });
			const seen = await careful.done;
			assert.deepEqual(seen, { ready: false, httpStatus: null, closeCode: null, closeReason: null, serverMacValid: true }, `v=${version}`);
			assert.deepEqual(careful.e.received.map((f) => [f.v, f.type]), [[PROTOCOL_VERSION, MSG.CHALLENGE]], "the challenge states the daemon's own version");
			assert.deepEqual(careful.e.invalidFrames, []);
			await careful.e.close();

			// One that answers all the same, with the right proof: not looked at, not let in.
			const eager = withKey({ version });
			assert.deepEqual(await eager.done, { ready: false, httpStatus: null, closeCode: 4003, closeReason: "protocol_version", serverMacValid: true }, `v=${version}`);
			assert.deepEqual(eager.e.received.map((f) => f.type), [MSG.CHALLENGE], "no ready");
			// One that answers in its own version.
			const own = withKey({ version, stopAfter: "challenge" });
			await own.done;
			own.e.send({ ...makeMessage(MSG.AUTH, { mac_c: b64urlEncode(randomBytes(32)), state: own.e.state }), v: version });
			assert.deepEqual(await own.e.closed, { code: 4003, reason: "protocol_version" });
			// One that says hello a second time, now in the daemon's version.
			const again = withKey({ version, stopAfter: "challenge" });
			await again.done;
			again.e.send(makeMessage(MSG.HELLO, { mode: "auth", ext_version: "0.0.0-test", browser: { name: "Waterfox", version: "6.7.5" }, nonce_c: randomNonce() }));
			assert.deepEqual(await again.e.closed, { code: 4003, reason: "protocol_version" });
			assert.deepEqual(again.e.received.map((f) => f.type), [MSG.CHALLENGE], "one challenge a connection");
		}
		assert.equal((await daemon.status()).extension.connected, false);
		assert.equal(logged(daemon, "ext.connected").length, 1, "the pairing and nothing since");
		assert.equal(logged(daemon, "ext.auth_failed").length, 0, "no proof of such a peer was ever checked");

		// The versions are part of the proof. A peer that reckons with other versions than the frames
		// stated - because one was changed on the way - finds the proof wrong.
		for (const tampered of [{ macVersionC: PROTOCOL_VERSION }, { macVersionS: PROTOCOL_VERSION + 1 }, { macVersionC: PROTOCOL_VERSION, macVersionS: PROTOCOL_VERSION + 1 }]) {
			const t = withKey({ version: PROTOCOL_VERSION + 1, ...tampered });
			assert.equal((await t.done).serverMacValid, false, JSON.stringify(tampered));
			await t.e.kill();
		}
		// And between two sides of the same version likewise: a mismatch cannot be made up.
		for (const tampered of [{ macVersionC: PROTOCOL_VERSION + 1 }, { macVersionS: PROTOCOL_VERSION + 1 }]) {
			const t = withKey(tampered);
			assert.equal((await t.done).serverMacValid, false, JSON.stringify(tampered));
			await t.e.kill();
			const careless = withKey({ ...tampered, ignoreServerMac: true });
			assert.equal((await careless.done).closeCode, 4001, "its own proof, made the same way, is refused");
		}

		// Without the key the challenge proves nothing to the peer, as ever.
		const stranger = ext();
		const s = await stranger.connect({ key: randomBytes(32), version: PROTOCOL_VERSION + 1, stopAfter: "challenge" });
		assert.equal(s.serverMacValid, false);
		await stranger.kill();

		// A frame that states a later version but is not the hello of the handshake core: no challenge.
		for (const helloOverride of [{ extra: true }, { nonce_c: "short" }, { type: MSG.AUTH }, { mode: "admin" }]) {
			const odd = withKey({ version: PROTOCOL_VERSION + 1, helloOverride });
			assert.deepEqual(await odd.done, { ready: false, httpStatus: null, closeCode: 4003, closeReason: "protocol_version", serverMacValid: null }, JSON.stringify(helloOverride));
			assert.deepEqual(odd.e.received, []);
		}

		// The operator reads it in the log and in the status; the key is what it was.
		assert.ok(logged(daemon, "ext.version_mismatch").some((l) => l.peer_protocol === PROTOCOL_VERSION + 1 && l.daemon_protocol === PROTOCOL_VERSION));
		assert.equal((await daemon.status()).extension.version_mismatch.daemon_protocol, PROTOCOL_VERSION);
		assert.equal(fs.readFileSync(keyFile, "utf8"), keyBefore);
		assert.equal((await good.connect()).ready, true);
	});
});

test("pairing with an extension of another version: it gets the proof for the code, the code is not used up", async () => {
	await withDaemon(async ({ daemon, ext }) => {
		const code = await daemon.pairCode();
		for (let i = 0; i < 3; i++) {
			// It knows the code, so the daemon's proof verifies. Its answer is not looked at.
			const later = ext();
			const r = await later.pair(code, { version: PROTOCOL_VERSION + 1 });
			assert.deepEqual(r, { ready: false, httpStatus: null, closeCode: 4003, closeReason: "protocol_version", serverMacValid: true });
			assert.equal(later.key, null);
		}
		assert.equal((await daemon.status()).paired, false);
		assert.equal((await daemon.status()).pairing_pending, true);
		assert.equal(fs.existsSync(path.join(daemon.configDir, "ext.key")), false);
		assert.equal(logged(daemon, "ext.auth_failed").length, 0);

		// Whether a code is pending is not told to such a peer either: a challenge without one, as for any hello.
		const fresh = await startTestDaemon();
		try {
			const idle = new FakeExtension({ port: fresh.port });
			const r = await idle.pair(generatePairingCode(fresh.port), { version: PROTOCOL_VERSION + 1, stopAfter: "challenge" });
			assert.equal(r.serverMacValid, false);
			assert.deepEqual(idle.received.map((f) => f.type), [MSG.CHALLENGE]);
			await idle.kill();
		} finally {
			await fresh.stop();
		}

		// The extension of this version pairs with the same code.
		const real = ext();
		assert.equal((await real.pair(code)).ready, true);
		assert.equal((await daemon.status()).paired, true);
	});
});

test("an extension of another version that says nothing after its challenge is dropped like any slow handshake", async () => {
	await withDaemon(async ({ daemon, clock, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		const e = ext();
		e.key = good.key;
		assert.equal((await e.connect({ version: PROTOCOL_VERSION + 1, stopAfter: "challenge" })).serverMacValid, true);
		clock.advance(LIMITS.handshakeTimeoutMs);
		assert.deepEqual(await e.closed, { code: 1008, reason: "handshake_timeout" });
		// It held one of the places for a pending handshake until then, and no other.
		assert.equal((await good.connect()).ready, true);
	});
});

test("an extension of another protocol version that keeps being turned away is named in the operator's status, for a while", async () => {
	await withDaemon(async ({ daemon, clock, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		assert.deepEqual((await daemon.status()).extension, { connected: false });

		const old = ext();
		old.key = good.key;
		assert.equal((await old.connect({ version: PROTOCOL_VERSION - 1 })).closeCode, 4003);
		assert.deepEqual((await daemon.status()).extension, {
			connected: false,
			version_mismatch: { peer_protocol: PROTOCOL_VERSION - 1, daemon_protocol: PROTOCOL_VERSION, ago_s: 0 },
		});
		// For the operator only: an agent is told that no extension is connected, as before.
		const agent = await daemon.agentStatus();
		assert.equal(agent.extension, undefined);
		assert.equal(agent.extension_connected, false);
		assert.equal(JSON.stringify(agent).includes("version_mismatch"), false);

		clock.advance(61000);
		assert.equal((await daemon.status()).extension.version_mismatch.ago_s, 61);
		// It comes back within the minute; if it does not, the note goes.
		clock.advance(60000);
		assert.deepEqual((await daemon.status()).extension, { connected: false });

		// A number that is none is not passed on as one.
		const odd = ext();
		assert.equal((await odd.connect({ key: randomBytes(32), version: 1e300 })).closeCode, 4003);
		assert.equal((await daemon.status()).extension.version_mismatch.peer_protocol, null);

		// An extension of this version connects: the note is gone, and stays gone when it leaves.
		assert.equal((await good.connect()).ready, true);
		assert.equal((await daemon.status()).extension.version_mismatch, undefined);
		// A frame of another version on the link that is up ends the link, and is not a hello that was turned away.
		good.send({ v: PROTOCOL_VERSION + 1, type: "ping", t: 1 });
		assert.equal((await good.closed).code, 4003);
		await until(async () => (await daemon.status()).extension.connected === false);
		assert.deepEqual((await daemon.status()).extension, { connected: false });
	});
});

test("a version number that is no number an operator could use is not written to the log", async () => {
	await withDaemon(async ({ daemon, ext }) => {
		for (const version of [4.5, 1e300, -1e21]) {
			const e = ext();
			const r = await e.connect({ key: randomBytes(32), version });
			assert.equal(r.closeCode, 4003);
		}
		assert.deepEqual(logged(daemon, "ext.version_mismatch").map((l) => l.peer_protocol), [null, null, null]);
	});
});

test("second connection: refused with 4002, the first one stays and keeps working", async () => {
	await withDaemon(async ({ daemon, ext, paired }) => {
		const first = await paired();
		const second = ext();
		second.key = first.key;
		const r = await second.connect();
		assert.equal(r.ready, false);
		assert.equal(r.closeCode, 4002);
		assert.equal(r.closeReason, "already_connected");
		assert.equal(r.serverMacValid, true);

		assert.equal(first.connected, true);
		const job = await daemon.submitJob({ url: "https://example.com/still-here" });
		assert.equal(job.json.result.outcome, "ok");
		assert.equal(first.jobs.length, 1);
		assert.equal(second.jobs.length, 0);
		assert.equal(logged(daemon, "ext.second_connection_refused").length, 1);
		assert.equal(logged(daemon, "ext.disconnected").length, 0);

		// Whether the slot is taken is only told to someone who knows the key.
		const stranger = ext();
		stranger.key = first.key;
		assert.equal((await stranger.connect({ corruptMac: true })).closeCode, 4001);
	});
});

test("pairing while another extension is connected: 4002, and the code is not burnt", async () => {
	await withDaemon(async ({ daemon, ext, paired }) => {
		const first = await paired();
		const keyBefore = fs.readFileSync(path.join(daemon.configDir, "ext.key"), "utf8");
		const code = await daemon.pairCode();
		const second = ext();
		const r = await second.pair(code);
		assert.equal(r.closeCode, 4002);
		assert.equal(second.key, null);
		assert.equal(fs.readFileSync(path.join(daemon.configDir, "ext.key"), "utf8"), keyBefore, "the key of the connected extension is untouched");

		await first.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		assert.equal((await second.pair(code)).ready, true);
	});
});

test("pairing: wrong code, reused code, no code", async () => {
	await withDaemon(async ({ daemon, ext }) => {
		// No code has been issued. The peer is answered all the same, with a
		// proof it cannot verify, and refused at the same step as a wrong code.
		const early = ext();
		const none = await early.pair(generatePairingCode(daemon.port), { ignoreServerMac: true });
		assert.equal(none.closeCode, 4001);
		assert.equal(none.serverMacValid, false);

		const code = await daemon.pairCode();
		// A guess: the daemon's proof does not verify, and the guess is refused.
		const guess = ext();
		const wrong = await guess.pair(generatePairingCode(daemon.port), { ignoreServerMac: true });
		assert.equal(wrong.serverMacValid, false);
		assert.equal(wrong.closeCode, 4001);
		assert.equal(guess.key, null);
		assert.equal((await daemon.status()).paired, false);

		const real = ext();
		assert.equal((await real.pair(code)).ready, true);
		await real.close();
		await until(async () => (await daemon.status()).extension.connected === false);

		// Single use: the same code does nothing the second time.
		const replay = ext();
		const second = await replay.pair(code, { ignoreServerMac: true });
		assert.equal(second.ready, false);
		assert.equal(second.closeCode, 4001);
		assert.equal(replay.key, null);
		assert.equal(logged(daemon, "pairing.ext_key_replaced").length, 0);
	});
});

test("pairing: wrong answers do not burn the code", async () => {
	await withDaemon(async ({ daemon, ext }) => {
		const code = await daemon.pairCode();
		// Before the fix five of these invalidated the code the operator was about to paste.
		for (let i = 1; i <= 25; i++) {
			const e = ext();
			const r = i % 2 === 0 ? await e.pair(code, { corruptMac: true }) : await e.pair(generatePairingCode(daemon.port), { ignoreServerMac: true });
			assert.equal(r.closeCode, 4001, `attempt ${i}`);
			assert.equal(e.key, null);
		}
		assert.equal(logged(daemon, "pairing.code_invalidated").length, 0);
		assert.equal((await daemon.status()).paired, false);
		const real = ext();
		assert.equal((await real.pair(code)).ready, true, "the code still works");
		assert.equal((await daemon.status()).paired, true);
		// Used once, it is gone.
		await real.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		assert.equal((await ext().pair(code, { ignoreServerMac: true })).closeCode, 4001);
	});
});

test("pair mode does not tell whether a code is pending", async () => {
	await withDaemon(async ({ daemon, ext }) => {
		/**
		 * What a peer without the code can observe of one pair-mode handshake.
		 * @param {boolean} sendAuth
		 */
		const observe = async (sendAuth) => {
			const e = ext();
			const r = await e.pair(generatePairingCode(daemon.port), sendAuth ? { ignoreServerMac: true } : { ignoreServerMac: true, stopAfter: "challenge" });
			const challenge = e.received.find((f) => f.type === MSG.CHALLENGE);
			assert.ok(challenge, "a well-formed hello is always answered with a challenge");
			assert.deepEqual(e.invalidFrames, []);
			const seen = {
				frames: e.received.map((f) => f.type),
				challengeKeys: Object.keys(challenge).sort(),
				lengths: [challenge.nonce_s.length, challenge.mac_s.length, challenge.instance.length],
				serverMacValid: r.serverMacValid,
				close: sendAuth ? [r.closeCode, r.closeReason] : null,
			};
			await e.kill();
			return { seen, challenge };
		};

		const idle = [await observe(true), await observe(false)];
		await daemon.pairCode();
		const pending = [await observe(true), await observe(false)];
		assert.deepEqual(idle[0].seen, pending[0].seen);
		assert.deepEqual(idle[1].seen, pending[1].seen);
		assert.deepEqual(idle[0].seen, {
			frames: ["challenge"],
			challengeKeys: ["instance", "mac_s", "nonce_s", "type", "v"],
			lengths: [43, 43, 16],
			serverMacValid: false,
			close: [4001, "auth_failed"],
		});
		// Every challenge is fresh: nothing repeats that could mark the idle state.
		const macs = [...idle, ...pending].map((o) => o.challenge.mac_s);
		const nonces = [...idle, ...pending].map((o) => o.challenge.nonce_s);
		assert.equal(new Set(macs).size, 4);
		assert.equal(new Set(nonces).size, 4);
		// The log says the same for both: a failed pair-mode handshake.
		assert.deepEqual(new Set(logged(daemon, "ext.auth_failed").map((l) => l.mode)), new Set(["pair"]));
		assert.equal((await daemon.status()).paired, false);
		assert.equal((await daemon.agentStatus()).pairing, undefined);
	});
});

test("pairing: the code expires after ten minutes, also in the middle of a handshake", async () => {
	await withDaemon(async ({ daemon, clock, ext }) => {
		// One millisecond before the deadline the code still answers...
		const code = await daemon.pairCode();
		clock.advance(599999);
		const probe = ext();
		assert.equal((await probe.pair(code, { stopAfter: "challenge" })).serverMacValid, true);
		await probe.kill();
		// ...at the deadline it is gone.
		clock.advance(1);
		const late = ext();
		const r = await late.pair(code, { ignoreServerMac: true });
		assert.equal(r.closeCode, 4001);
		assert.equal(r.serverMacValid, false, "an expired code is answered like no code: with a proof that does not verify");
		assert.equal((await daemon.status()).paired, false);

		// hello arrives in time, auth after the deadline.
		const code2 = await daemon.pairCode();
		clock.advance(599000);
		const slow = ext();
		const parsed = parsePairingCode(code2);
		assert.ok(parsed.ok);
		const half = await slow.pair(code2, { stopAfter: "challenge" });
		assert.equal(half.serverMacValid, true);
		// Past the code's deadline, within the two seconds a handshake may take.
		clock.advance(1500);
		// Finish the handshake by hand with a correct MAC.
		const { computeMacC, pairingKey } = await import("../../extension/shared/auth.js");
		const hello = slow.sent[0];
		const challenge = slow.received.find((f) => f.type === MSG.CHALLENGE);
		const mac = await computeMacC(pairingKey(code2), {
			mode: "pair",
			port: daemon.port,
			versionC: PROTOCOL_VERSION,
			versionS: PROTOCOL_VERSION,
			instance: challenge?.instance,
			nonceC: String(hello.nonce_c),
			nonceS: challenge?.nonce_s,
		});
		slow.send(makeMessage(MSG.AUTH, { mac_c: b64urlEncode(mac), state: slow.state }));
		assert.equal((await slow.closed).code, 4001);
		assert.equal((await daemon.status()).paired, false);
	});
});

test("re-pairing replaces the key, is logged, and the old key stops working", async () => {
	await withDaemon(async ({ daemon, clock, ext, paired }) => {
		const old = await paired();
		const oldKey = old.key;
		await old.close();
		await until(async () => (await daemon.status()).extension.connected === false);

		const fresh = ext();
		assert.equal((await fresh.pair(await daemon.pairCode())).ready, true);
		assert.notDeepEqual(fresh.key, oldKey);
		const replaced = logged(daemon, "pairing.ext_key_replaced");
		assert.equal(replaced.length, 1);
		assert.equal(replaced[0].level, "warn");
		await fresh.close();
		await until(async () => (await daemon.status()).extension.connected === false);

		const r = await old.connect({ ignoreServerMac: true });
		assert.equal(r.serverMacValid, false);
		assert.equal(r.closeCode, 4001);
		clock.advance(60000);
		assert.equal((await fresh.connect()).ready, true);
	});
});

test("upgrade: only a moz-extension origin on the exact host gets a WebSocket", async () => {
	await withDaemon(async ({ daemon, ext, paired }) => {
		const good = await paired();
		await good.close();
		/** @type {[string, import("../helpers/fake-extension.js").HandshakeOptions][]} */
		const refused = [
			["no Origin", { origin: null }],
			["web page", { origin: "https://evil.example" }],
			["loopback page", { origin: `http://127.0.0.1:${daemon.port}` }],
			["localhost page", { origin: "http://localhost" }],
			["null origin", { origin: "null" }],
			["chrome extension", { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }],
			["extension id instead of uuid", { origin: "moz-extension://browser-gateway@example" }],
			["uuid with a path", { origin: "moz-extension://0f8c2a3e-5b1d-4c7a-9e6f-112233445566/page.html" }],
			["uuid with a suffix", { origin: "moz-extension://0f8c2a3e-5b1d-4c7a-9e6f-112233445566.evil.example" }],
			["upper-case scheme", { origin: "MOZ-EXTENSION://0f8c2a3e-5b1d-4c7a-9e6f-112233445566" }],
			["short uuid", { origin: "moz-extension://0f8c2a3e-5b1d-4c7a-9e6f-11223344556" }],
			["wrong Host", { headers: { Host: `localhost:${daemon.port}` } }],
			["foreign Host", { headers: { Host: "evil.example" } }],
		];
		for (const [label, opts] of refused) {
			const e = ext();
			e.key = good.key;
			const r = await e.connect(opts);
			assert.equal(r.httpStatus, 403, label);
			assert.equal(r.ready, false, label);
			assert.equal(r.serverMacValid, null, label);
		}
		assert.equal((await daemon.status()).extension.connected, false);
		// A few lines per reason and interval, the rest counted: 11 bad origins, 2 bad hosts.
		const lines = logged(daemon, "ext.upgrade_refused");
		assert.equal(lines.filter((l) => l.reason === "origin").length, LIMITS.refusalLogBurst);
		assert.equal(lines.filter((l) => l.reason === "host").length, 2);
		assert.equal(suppressed(daemon, "ext.upgrade_refused"), 0, "the summary comes when the interval ends");
		// The origins themselves are not written to the log.
		assert.ok(!daemon.logs.join("\n").includes("evil.example"));

		// Any installed extension has its own UUID; the key decides, not the UUID.
		const other = ext({ origin: "moz-extension://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
		other.key = good.key;
		assert.equal((await other.connect()).ready, true);
	});
});

test("refused upgrades cannot flood the log: a few lines, then one summary with a count", async () => {
	await withDaemon(async ({ daemon, clock, ext }) => {
		// A web page that keeps trying: one warning each before the fix.
		for (let i = 0; i < 60; i++) {
			const r = await ext({ origin: "https://evil.example" }).connect({ key: randomBytes(32) });
			assert.equal(r.httpStatus, 403);
		}
		assert.equal(logged(daemon, "ext.upgrade_refused").length, LIMITS.refusalLogBurst);
		assert.equal(logged(daemon, "log.suppressed").length, 0);
		clock.advance(LIMITS.refusalLogIntervalMs - 1);
		assert.equal(logged(daemon, "log.suppressed").length, 0);
		clock.advance(1);
		assert.deepEqual(
			logged(daemon, "log.suppressed").map((l) => ({ level: l.level, suppressed_event: l.suppressed_event, key: l.key, count: l.count, interval_s: l.interval_s })),
			[{ level: "warn", suppressed_event: "ext.upgrade_refused", key: "origin", count: 60 - LIMITS.refusalLogBurst, interval_s: 60 }],
		);
		// A new interval starts with lines again, and a quiet one ends without a summary.
		await ext({ origin: "https://evil.example" }).connect({ key: randomBytes(32) });
		assert.equal(logged(daemon, "ext.upgrade_refused").length, LIMITS.refusalLogBurst + 1);
		clock.advance(LIMITS.refusalLogIntervalMs);
		assert.equal(logged(daemon, "log.suppressed").length, 1);
		assert.equal(clock.pending, 1, "only the daily purge timer is left");
	});
});

test("no job traffic before ready: anything but hello, then auth, closes the socket", async () => {
	await withDaemon(async ({ daemon, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		const start = { job: "j_x", url: "https://example.com/" };

		/** @type {[string, Record<string, unknown>][]} */
		const firstFrames = [
			["job.result", makeMessage(MSG.JOB_RESULT, { ...makeResult(start) })],
			["job.accepted", makeMessage(MSG.JOB_ACCEPTED, { job: "j_x", cookie_scope: "container", rule: null })],
			["event", makeMessage(MSG.EVENT, { name: "resumed", host: null, job: null, state: good.state, detect: null })],
			["ping", makeMessage(MSG.PING, { t: 1 })],
			["auth", makeMessage(MSG.AUTH, { mac_c: randomNonce(), state: good.state })],
		];
		for (const [label, frame] of firstFrames) {
			const e = ext();
			e.key = good.key;
			// Replace the hello frame itself.
			const r = await e.connect({ helloOverride: { ...Object.fromEntries(Object.keys(makeMessage(MSG.HELLO, { mode: 1, ext_version: 1, browser: 1, nonce_c: 1 })).map((k) => [k, undefined])), ...frame } });
			assert.equal(r.ready, false, label);
			assert.equal(r.closeCode, 1008, `${label} as first frame`);
			assert.equal(r.serverMacValid, null);
		}

		// After the challenge only auth is acceptable.
		for (const [label, frame] of firstFrames.filter(([l]) => l !== "auth")) {
			const e = ext();
			e.key = good.key;
			await e.connect({ stopAfter: "challenge" });
			e.send(frame);
			assert.equal((await e.closed).code, 1008, `${label} instead of auth`);
		}
		const twice = ext();
		twice.key = good.key;
		await twice.connect({ stopAfter: "challenge" });
		twice.send(twice.sent[0]);
		assert.equal((await twice.closed).code, 1008, "a second hello");

		assert.equal((await daemon.status()).extension.connected, false);
		assert.equal(logged(daemon, "job.result_dropped").length, 0, "none of it reached the queue");
	});
});

test("no job traffic before ready: a half-open handshake receives no job", async () => {
	await withDaemon(async ({ daemon, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		const half = ext();
		half.key = good.key;
		await half.connect({ stopAfter: "challenge" });
		const r = await daemon.submitJob({ url: "https://example.com/" });
		assert.equal(r.json.result.error.code, "extension_not_connected");
		assert.deepEqual(half.received.map((f) => f.type), [MSG.CHALLENGE]);
		assert.equal((await daemon.status()).extension.connected, false);
	});
});

test("a handshake that stalls is dropped after two seconds", async () => {
	assert.equal(LIMITS.handshakeTimeoutMs, 2000);
	await withDaemon(async ({ clock, ext, paired }) => {
		const good = await paired();
		await good.close();
		const silent = ext();
		silent.key = good.key;
		await silent.connect({ stopAfter: "challenge" });
		clock.advance(1999);
		assert.equal(silent.connected, true);
		clock.advance(1);
		const closed = await silent.closed;
		assert.equal(closed.code, 1008);
		assert.equal(closed.reason, "handshake_timeout");

		// A finished handshake is not affected by its old timer.
		assert.equal((await good.connect()).ready, true);
		clock.advance(15000);
		await flush(good);
		assert.equal(good.connected, true);
	});
});

test("pending handshakes: stalled peers do not keep the real extension out", async () => {
	assert.equal(LIMITS.maxPendingHandshakes, 32);
	await withDaemon(async ({ daemon, clock, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		// Four stalled handshakes were enough to get the extension a 503 before the fix.
		/** @type {FakeExtension[]} */
		const idle = [];
		for (let i = 0; i < 4; i++) {
			const e = ext();
			await e.connect({ key: randomBytes(32), ignoreServerMac: true, stopAfter: "challenge" });
			idle.push(e);
		}
		assert.equal((await good.connect()).ready, true, "served while four others stall");
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);

		// Every place taken by a peer that says nothing: the next one in takes the
		// place of the oldest, it is not turned away. No time passes here (the
		// clock stands still), so no place frees itself.
		for (let i = 4; i < LIMITS.maxPendingHandshakes; i++) {
			const e = ext();
			await e.connect({ key: randomBytes(32), ignoreServerMac: true, stopAfter: "challenge" });
			idle.push(e);
		}
		assert.equal(idle.filter((e) => e.connected).length, LIMITS.maxPendingHandshakes);
		assert.equal((await good.connect()).ready, true, "the real extension gets in although every place is taken");
		const dropped = await idle[0].closed;
		assert.deepEqual(dropped, { code: 1008, reason: "handshake_evicted" }, "the oldest pending handshake made room");
		assert.equal(idle.slice(1).every((e) => e.connected), true, "and only the oldest");
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);

		// The reported case: silent sockets keep arriving. Before the fix the
		// extension got 0 of 27 attempts through in 8 s.
		/** @type {FakeExtension[]} */
		const flood = [];
		for (let round = 0; round < 5; round++) {
			for (let i = 0; i < 40; i++) {
				const e = ext();
				await e.connect({ key: randomBytes(32), ignoreServerMac: true, stopAfter: round % 2 === 0 ? "hello" : "challenge" });
				flood.push(e);
			}
			assert.equal((await good.connect()).ready, true, `round ${round}`);
			await good.close();
			await until(async () => (await daemon.status()).extension.connected === false);
		}
		await until(() => [...idle, ...flood].filter((e) => e.connected).length <= LIMITS.maxPendingHandshakes, { what: "the evicted sockets to close" });
		assert.equal(logged(daemon, "ext.upgrade_refused").filter((l) => l.reason === "busy").length, 0, "nobody was turned away");
		assert.ok(logged(daemon, "ext.handshake_evicted").length <= LIMITS.refusalLogBurst, "evictions do not flood the log");
		// What is left still times out.
		clock.advance(LIMITS.handshakeTimeoutMs);
		await until(() => [...idle, ...flood].every((e) => !e.connected), { what: "the rest to time out" });
		assert.equal((await good.connect()).ready, true);
	});
});

test("a write to a socket that is already closing is not attempted, and a failed one cannot flood the log", async () => {
	await withDaemon(async ({ daemon, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		// A peer that says hello and hangs up at once: its challenge used to be
		// written to a closing socket, one warning each (300 sockets, 296 lines).
		const peers = [];
		for (let i = 0; i < 80; i++) {
			const e = ext();
			e.key = good.key;
			await e.connect({ stopAfter: "hello" });
			e.ws?.close(1000);
			peers.push(e);
		}
		await Promise.all(peers.map((e) => e.closed));
		assert.equal((await good.connect()).ready, true);
		await flush(good);
		assert.ok(logged(daemon, "ext.send_failed").length <= LIMITS.refusalLogBurst, `${logged(daemon, "ext.send_failed").length} lines`);
	});
});

test("a peer that is not ready cannot make the daemon buffer megabytes", async () => {
	assert.ok(LIMITS.maxPreAuthBytes <= 262144);
	await withDaemon(async ({ daemon, ext, paired }) => {
		const good = await paired();
		await good.close();
		await until(async () => (await daemon.status()).extension.connected === false);

		// One frame of 4 MiB before any hello. ws would buffer it whole (its limit
		// is 16 MiB) before the daemon could look at it; now the connection is cut
		// while the frame is still arriving.
		const big = ext();
		big.key = good.key;
		await big.connect({ stopAfter: "hello", helloOverride: { pad: "x".repeat(4 * 1048576) } });
		const closed = await big.closed;
		assert.equal(closed.code, 1006, "cut, not answered: the frame never completed");
		const violations = logged(daemon, "ext.protocol_violation");
		assert.deepEqual(violations.map((l) => [l.phase, l.reason]), [["hello", "too much data before ready"]]);

		// Many small frames add up to the same limit.
		const drip = ext();
		drip.key = good.key;
		await drip.connect({ stopAfter: "challenge" });
		const ws = drip.ws;
		assert.ok(ws);
		for (let i = 0; i < 40 && ws.readyState === 1; i++) ws.ping(Buffer.alloc(100));
		for (let i = 0; i < 4000 && ws.readyState === 1; i++) ws.ping(Buffer.alloc(125));
		assert.equal((await drip.closed).code, 1006);

		// A whole handshake is far below it, and once ready the counter is gone:
		// an authenticated extension can send a result of several megabytes.
		assert.equal((await good.connect()).ready, true);
		good.onJob = (start) => makeResult(start, { content: { markdown: "m".repeat(3 * 1048576), text: null, html: null, raw_html: null, links: [], results: [] } });
		const r = await daemon.submitJob({ url: "https://example.com/large" });
		assert.equal(r.json.result.content.markdown.length, 3 * 1048576);
		assert.equal(good.connected, true);
	});
});

test("an invalid message closes the link", async () => {
	/** @type {[string, (e: FakeExtension) => void, number][]} */
	const cases = [
		["not JSON", (e) => e.sendRaw("this is not json"), 1008],
		["JSON but not an object", (e) => e.sendRaw("[1,2,3]"), 1008],
		["unknown type", (e) => e.send({ v: PROTOCOL_VERSION, type: "tabs.query" }), 1008],
		["no version", (e) => e.send({ type: "ping", t: 1 }), 1008],
		["newer version", (e) => e.send({ v: PROTOCOL_VERSION + 1, type: "ping", t: 1 }), 4003],
		["extra top-level field", (e) => e.send({ ...makeMessage(MSG.PING, { t: 1 }), extra: true }), 1008],
		["wrong field type", (e) => e.send(makeMessage(MSG.PING, { t: "1" })), 1008],
		["daemon-only message", (e) => e.send(makeMessage(MSG.JOB_CANCEL, { job: "j_1", reason: "deadline" })), 1008],
		["job.start from the extension", (e) => e.send(makeMessage(MSG.JOB_START, { job: "j_1", kind: "fetch", url: "https://example.com/", session: "auto", wait: { timeout_ms: 1000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" }, extract: { markdown: true, text: true, html: false, raw_html: false, links: false, adapter: "auto" }, files: null })), 1008],
		["hello after ready", (e) => e.send(e.sent[0]), 1008],
		["auth after ready", (e) => e.send(makeMessage(MSG.AUTH, { mac_c: randomNonce(), state: e.state })), 1008],
		["result with a bad outcome", (e) => e.send(makeMessage(MSG.JOB_RESULT, { ...makeResult({ job: "j_1", url: "https://example.com/" }), outcome: "great" })), 1008],
		["result with cookies attached", (e) => e.send(makeMessage(MSG.JOB_RESULT, { ...makeResult({ job: "j_1", url: "https://example.com/" }), cookies: [{ name: "sid", value: "x" }] })), 1008],
		["event with a bad state", (e) => e.send(makeMessage(MSG.EVENT, { name: "paused", host: null, job: null, state: { paused: true }, detect: null })), 1008],
		["binary frame", (e) => e.sendRaw(Buffer.from(JSON.stringify(makeMessage(MSG.PING, { t: 1 }))), { binary: true }), 1003],
		["frame over the result cap", (e) => e.sendRaw(JSON.stringify(makeMessage(MSG.PING, { t: 1 })) + " ".repeat(8388608)), 1009],
	];
	await withDaemon(async ({ daemon, clock, paired }) => {
		const e = await paired();
		for (const [label, misbehave, code] of cases) {
			await flush(e);
			misbehave(e);
			const closed = await e.closed;
			assert.equal(closed.code, code, label);
			await until(async () => (await daemon.status()).extension.connected === false, { what: `${label}: link to drop` });
			clock.advance(1000);
			assert.equal((await e.connect()).ready, true, `reconnect after: ${label}`);
		}
		assert.equal(logged(daemon, "ext.disconnected").length, cases.length);
		// Every case is in the log: the first few as lines, the rest as a count.
		assert.equal(logged(daemon, "ext.protocol_violation").length, LIMITS.refusalLogBurst);
		clock.advance(LIMITS.refusalLogIntervalMs);
		assert.equal(logged(daemon, "ext.protocol_violation").length + suppressed(daemon, "ext.protocol_violation"), cases.length);
	});
});

test("an oversized frame during the handshake is refused before it is parsed", async () => {
	await withDaemon(async ({ ext, paired }) => {
		const good = await paired();
		await good.close();
		const e = ext();
		e.key = good.key;
		await e.connect({ stopAfter: "challenge" });
		e.sendRaw(JSON.stringify(makeMessage(MSG.AUTH, { mac_c: randomNonce(), state: e.state })) + " ".repeat(131072));
		assert.equal((await e.closed).code, 1009);
	});
});

test("job round trip through POST /v1/jobs", async () => {
	await withDaemon(async ({ daemon, paired }) => {
		const e = await paired();
		e.onJob = async (start, self) => {
			self.send(makeMessage(MSG.JOB_ACCEPTED, { job: start.job, cookie_scope: "container", rule: null }));
			self.send(makeMessage(MSG.JOB_PROGRESS, { job: start.job, phase: "navigating", http_status: null }));
			self.send(makeMessage(MSG.JOB_PROGRESS, { job: start.job, phase: "extracting", http_status: 200 }));
			return makeResult(start, {
				nav: {
					requested_url: start.url,
					final_url: "https://example.com/article/a?utm=1",
					redirect_origins: ["https://example.com/login?token=SECRETQUERY", "https://www.example.com"],
					http_status: 200,
					content_type: "text/html; charset=utf-8",
					body_bytes: null,
				},
			});
		};
		const r = await daemon.submitJob({ url: "HTTPS://Example.com./a/../a?x=1", session: "isolated", extract: { html: true }, wait: { timeout_ms: 20000, dwell_ms: 0 } });
		assert.equal(r.status, 200);
		assert.equal(r.json.ok, true);
		const result = r.json.result;
		assert.equal(result.outcome, "ok");
		assert.equal(result.cookie_scope, "container");
		assert.equal(result.content.markdown, "# Fixture page\n\nhello world");
		assert.equal(result.nav.final_url, "https://example.com/article/a?utm=1");
		assert.deepEqual(Object.keys(result).sort(), ["content", "cookie_scope", "detect", "error", "extraction", "file", "job", "nav", "outcome", "page", "render", "tab_kept_open", "truncated"]);

		// What the extension was asked to do: the normalised URL and the filled-in defaults.
		assert.equal(e.jobs.length, 1);
		assert.deepEqual(e.jobs[0], {
			v: PROTOCOL_VERSION,
			type: "job.start",
			job: result.job,
			kind: "fetch",
			url: "https://example.com/a?x=1",
			session: "isolated",
			wait: { timeout_ms: 20000, settle_ms: 1500, dwell_ms: 0, human_wait_ms: 0, scroll: "lazy" },
			extract: { markdown: true, text: true, html: true, raw_html: false, links: true, adapter: "auto" },
			files: null,
		});
		assert.deepEqual(e.invalidFrames, []);

		const audit = daemon.auditEntries();
		assert.equal(audit.length, 1);
		assert.deepEqual({ ...audit[0], ts: "", duration_ms: 0 }, {
			ts: "",
			job: result.job,
			kind: "fetch",
			url: "https://example.com/a?x=1",
			host: "example.com",
			outcome: "ok",
			code: null,
			cookie_scope: "container",
			duration_ms: 0,
			redirect_origins: ["https://example.com", "https://www.example.com"],
			// Where the browser said the time went: numbers, by phase.
			timings: { elapsed_ms: 120, ...zeroTimings() },
		});
		const auditText = fs.readFileSync(path.join(daemon.dataDir, "audit.jsonl"), "utf8");
		assert.ok(!auditText.includes("SECRETQUERY"), "redirect hops are logged as origins only");
		assert.ok(!auditText.includes("hello world"), "no page content in the audit log");
		if (MODES) assert.equal(fs.statSync(path.join(daemon.dataDir, "audit.jsonl")).mode & 0o777, 0o600);
		assert.ok(!daemon.logs.join("\n").includes("hello world"), "no page content in the journal");
		assert.deepEqual((await daemon.status()).queue, { queued: 0, dispatched: 0 });
	});
});

test("jobs run one at a time and non-ok outcomes come back unchanged", async () => {
	await withDaemon(async ({ daemon, paired }) => {
		const e = await paired();
		let running = 0;
		let maxRunning = 0;
		e.onJob = async (start) => {
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((resolve) => setTimeout(resolve, 20));
			running -= 1;
			if (start.url.endsWith("/blocked")) {
				return makeResult(start, {
					outcome: "needs_human",
					content: null,
					page: null,
					detect: { kind: "cloudflare_challenge", evidence: "cf-mitigated: challenge", waited_ms: 8000, resolved: null },
					error: { code: "challenge", message: "interactive challenge", retryable: true, retry_after_s: 60 },
					file: null,
					tab_kept_open: true,
				});
			}
			return makeResult(start);
		};
		const answers = await Promise.all([
			daemon.submitJob({ url: "https://a.example/1" }),
			daemon.submitJob({ url: "https://b.example/blocked" }),
			daemon.submitJob({ url: "https://c.example/3" }),
		]);
		assert.equal(maxRunning, 1);
		assert.deepEqual(answers.map((a) => a.json.result.outcome), ["ok", "needs_human", "ok"]);
		assert.deepEqual(answers[1].json.result.detect, { kind: "cloudflare_challenge", evidence: "cf-mitigated: challenge", waited_ms: 8000, resolved: null });
		assert.equal(answers[1].json.result.tab_kept_open, true);
		assert.equal(answers[1].status, 200);
		assert.deepEqual(e.jobs.map((j) => j.url), ["https://a.example/1", "https://b.example/blocked", "https://c.example/3"]);
	});
});

test("identical requests in flight share one browser job", async () => {
	await withDaemon(async ({ daemon, paired }) => {
		const e = await paired();
		e.onJob = () => null;
		const a = daemon.submitJob({ url: "https://example.com/same" });
		const start = await e.waitFor(MSG.JOB_START);
		const b = daemon.submitJob({ url: "https://example.com/same" });
		const c = daemon.submitJob({ url: "https://example.com/same", session: "isolated" });
		await until(async () => (await daemon.status()).queue.queued === 1, { what: "the different job to queue" });
		e.sendResult(makeResult(start));
		const [ra, rb] = await Promise.all([a, b]);
		assert.equal(ra.json.result.job, rb.json.result.job);
		const other = await e.waitFor(MSG.JOB_START);
		assert.notEqual(other.job, start.job);
		assert.equal(other.session, "isolated");
		e.sendResult(makeResult(other));
		assert.equal((await c).json.result.outcome, "ok");
		assert.equal(e.jobs.length, 2);
		assert.equal(daemon.auditEntries().length, 2);
	});
});

test("disconnect in the middle of a job: browser_disconnected, retryable", async () => {
	for (const how of /** @type {const} */ (["close", "kill"])) {
		await withDaemon(async ({ daemon, paired }) => {
			const e = await paired();
			e.onJob = () => null;
			const pending = daemon.submitJob({ url: "https://example.com/slow" });
			const start = await e.waitFor(MSG.JOB_START);
			e.send(makeMessage(MSG.JOB_ACCEPTED, { job: start.job, cookie_scope: "container", rule: null }));
			await flush(e);
			if (how === "close") await e.close();
			else await e.kill();

			const r = await pending;
			assert.equal(r.status, 200, how);
			assert.equal(r.json.result.outcome, "error");
			assert.deepEqual(r.json.result.error, {
				code: "browser_disconnected",
				message: "the browser disconnected while the job was running",
				retryable: true,
				retry_after_s: null,
			});
			assert.equal(r.json.result.content, null);
			assert.equal(r.json.result.job, start.job);
			const audit = daemon.auditEntries();
			assert.deepEqual([audit[0].outcome, audit[0].code, audit[0].cookie_scope], ["error", "browser_disconnected", "container"]);
			assert.equal((await daemon.status()).extension.connected, false);

			// The extension comes back; the lost job is not replayed behind the caller's back.
			assert.equal((await e.connect()).ready, true);
			await flush(e);
			assert.equal(e.jobs.length, 1);
		});
	}
});

test("an invalid or oversize job.result fails the job as invalid_result, not retryable", async () => {
	const big = "x".repeat(1024 * 1024);
	/** @type {[string, (e: FakeExtension, start: Record<string, any>) => void, number][]} */
	const cases = [
		["result with an unknown outcome", (e, start) => e.send(makeMessage(MSG.JOB_RESULT, { ...makeResult(start), outcome: "great" })), 1008],
		["result with a missing field", (e, start) => {
			const { render: _render, ...rest } = makeResult(start);
			e.send(makeMessage(MSG.JOB_RESULT, rest));
		}, 1008],
		["result with extra data attached", (e, start) => e.send(makeMessage(MSG.JOB_RESULT, { ...makeResult(start), cookies: [{ name: "sid", value: "x" }] })), 1008],
		["result that is not JSON", (e) => e.sendRaw('{"v":1,"type":"job.result","job":'), 1008],
		["result over the 8 MiB cap", (e, start) => e.sendResult(makeResult(start, { content: { markdown: big.repeat(5), text: null, html: big.repeat(4), raw_html: null, links: [], results: [] } })), 1009],
		["frame over the 16 MiB transport limit", (e, start) => e.sendResult(makeResult(start, { content: { markdown: big.repeat(8), text: null, html: big.repeat(8), raw_html: null, links: [], results: [] } })), 1009],
		["another protocol violation while the job runs", (e) => e.send({ v: PROTOCOL_VERSION, type: "tabs.query" }), 1008],
		["a binary frame while the job runs", (e) => e.sendRaw(Buffer.from("{}"), { binary: true }), 1003],
	];
	await withDaemon(async ({ daemon, clock, paired }) => {
		const e = await paired();
		e.onJob = () => null;
		for (const [label, misbehave, closeCode] of cases) {
			const pending = daemon.submitJob({ url: "https://example.com/page", wait: { dwell_ms: 0 } });
			const start = await e.waitFor(MSG.JOB_START);
			misbehave(e, start);

			const r = await pending;
			assert.equal(r.status, 200, label);
			assert.equal(r.json.result.outcome, "error", label);
			assert.deepEqual(
				r.json.result.error,
				{ code: "invalid_result", message: "the extension sent an invalid or oversized message while the job was running", retryable: false, retry_after_s: null },
				label,
			);
			assert.equal(r.json.result.job, start.job);
			assert.equal(r.json.result.content, null, label);
			assert.equal((await e.closed).code, closeCode, label);
			await until(async () => (await daemon.status()).extension.connected === false, { what: `${label}: link to drop` });
			clock.advance(1000);
			assert.equal((await e.connect()).ready, true, `reconnect after: ${label}`);
		}
		const audit = daemon.auditEntries();
		assert.equal(audit.length, cases.length);
		assert.ok(audit.every((a) => a.outcome === "error" && a.code === "invalid_result"));
		assert.deepEqual(logged(daemon, "ext.disconnected").map((l) => l.cause), cases.map(() => "violation"));
		assert.ok(!daemon.logs.join("\n").includes("xxxxxxxx"), "no page content in the journal");
	});
});

test("only a genuine link loss is reported as retryable browser_disconnected", async () => {
	await withDaemon(async ({ daemon, paired }) => {
		const e = await paired();
		e.onJob = () => null;
		const pending = daemon.submitJob({ url: "https://example.com/page" });
		await e.waitFor(MSG.JOB_START);
		await e.kill();
		const r = await pending;
		assert.equal(r.json.result.error.code, "browser_disconnected");
		assert.equal(r.json.result.error.retryable, true);
		assert.deepEqual(logged(daemon, "ext.disconnected").map((l) => l.cause), ["lost"]);
	});
});

test("a violation fails the running job only; queued jobs wait for the reconnect", async () => {
	await withDaemon(async ({ daemon, clock, paired }) => {
		const e = await paired();
		e.onJob = () => null;
		const first = daemon.submitJob({ url: "https://a.example/1" });
		const start = await e.waitFor(MSG.JOB_START);
		const second = daemon.submitJob({ url: "https://b.example/2" });
		await until(async () => (await daemon.status()).queue.queued === 1);
		e.send(makeMessage(MSG.JOB_RESULT, { ...makeResult(start), outcome: "nonsense" }));
		assert.equal((await first).json.result.error.code, "invalid_result");
		await e.closed;
		clock.advance(1000);
		e.onJob = (s) => makeResult(s);
		assert.equal((await e.connect()).ready, true);
		assert.equal((await second).json.result.outcome, "ok");
	});
});

test("target URLs with query strings and fragments are fetched as asked", async () => {
	await withDaemon(async ({ daemon, paired }) => {
		const e = await paired();
		const urls = [
			"https://www.reddit.com/search/?q=browser+gateway&sort=new&t=week",
			"https://duckduckgo.com/html/?q=hkdf%20rfc&kl=us-en",
			"https://example.com/path?a=1&b=two&c=%C3%A9&empty=&flag",
			"https://example.com/?redirect=https%3A%2F%2Fother.example%2Fx%3Fy%3D1",
			"https://example.com/docs?page=2#section-3",
			"https://example.com/?",
		];
		for (const url of urls) {
			const r = await daemon.submitJob({ url });
			assert.equal(r.status, 200, url);
			assert.equal(r.json.result.outcome, "ok", url);
		}
		assert.deepEqual(e.jobs.map((j) => j.url), urls, "query and fragment reach the extension unchanged");
		assert.deepEqual(daemon.auditEntries().map((a) => a.url), urls);
		// The rule against query strings is about the daemon's own routes only.
		assert.equal((await daemon.request("POST", "/v1/jobs?x=1", { body: { url: urls[0] } })).status, 400);
		assert.equal((await daemon.request("GET", "/v1/status?x=1")).status, 400);
	});
});

test("a job that was still queued when the link dropped runs after the reconnect", async () => {
	await withDaemon(async ({ daemon, paired }) => {
		const e = await paired();
		e.onJob = () => null;
		const first = daemon.submitJob({ url: "https://a.example/1" });
		await e.waitFor(MSG.JOB_START);
		const second = daemon.submitJob({ url: "https://b.example/2" });
		await until(async () => (await daemon.status()).queue.queued === 1);
		await e.kill();
		assert.equal((await first).json.result.error.code, "browser_disconnected");
		assert.deepEqual((await daemon.status()).queue, { queued: 1, dispatched: 0 });

		e.onJob = (start) => makeResult(start);
		assert.equal((await e.connect()).ready, true);
		const r = await second;
		assert.equal(r.json.result.outcome, "ok");
		assert.equal(r.json.result.nav.requested_url, "https://b.example/2");
	});
});

test("deadline: the daemon sends job.cancel and answers timeout", async () => {
	await withDaemon(async ({ daemon, clock, paired }) => {
		const e = await paired();
		e.onJob = () => null;
		const pending = daemon.submitJob({ url: "https://example.com/hangs", wait: { timeout_ms: 10000, settle_ms: 0, dwell_ms: 0 } });
		const start = await e.waitFor(MSG.JOB_START);
		// Budget: 10 s timeout + 5 s grace.
		clock.advance(14999);
		await flush(e);
		assert.equal(e.received.filter((f) => f.type === MSG.JOB_CANCEL).length, 0);
		clock.advance(1);
		const cancel = await e.waitFor(MSG.JOB_CANCEL);
		assert.deepEqual(cancel, { v: PROTOCOL_VERSION, type: "job.cancel", job: start.job, reason: "deadline" });

		const r = await pending;
		assert.equal(r.status, 200);
		assert.equal(r.json.result.outcome, "timeout");
		assert.equal(r.json.result.error.code, "deadline");
		assert.equal(r.json.result.job, start.job);
		assert.equal(daemon.auditEntries()[0].outcome, "timeout");

		// The extension's own late answer changes nothing and does not break the link.
		e.sendResult(makeResult(start, { outcome: "aborted" }));
		await flush(e);
		assert.equal(e.connected, true);
		const dropped = logged(daemon, "job.result_dropped");
		assert.equal(dropped.length, 1);
		assert.equal(dropped[0].job, start.job);
		assert.equal(daemon.auditEntries().length, 1);
	});
});

test("late and unknown results are dropped and logged; the link stays up", async () => {
	await withDaemon(async ({ daemon, paired }) => {
		const e = await paired();
		e.sendResult(makeResult({ job: "j_never_issued", url: "https://example.com/" }));
		await flush(e);
		const r = await daemon.submitJob({ url: "https://example.com/1" });
		assert.equal(r.json.result.outcome, "ok");
		// A second result for the job that just finished.
		e.sendResult(makeResult(e.jobs[0], { outcome: "blocked" }));
		e.send(makeMessage(MSG.JOB_PROGRESS, { job: e.jobs[0].job, phase: "settling", http_status: 200 }));
		await flush(e);
		assert.equal(e.connected, true);
		assert.deepEqual(logged(daemon, "job.result_dropped").map((l) => l.job), ["j_never_issued", e.jobs[0].job]);
		assert.equal(daemon.auditEntries().length, 1);
		assert.equal(daemon.auditEntries()[0].outcome, "ok");
	});
});

test("blocklisted and private-range URLs are refused before dispatch", async () => {
	await withDaemon(async ({ daemon, paired }) => {
		const e = await paired();
		/** @type {[string, string][]} */
		const table = [
			["https://mail.google.com/mail/u/0/#inbox", "blocklisted"],
			["https://accounts.google.com/", "blocklisted"],
			["https://www.paypal.com/myaccount", "blocklisted"],
			["https://vault.bitwarden.com/", "blocklisted"],
			[`http://127.0.0.1:${daemon.port}/v1/status`, "private_address"],
			["http://2130706433/", "private_address"],
			["http://0x7f.1/", "private_address"],
			["http://127.1/", "private_address"],
			["http://[::1]/", "private_address"],
			["http://[::ffff:7f00:1]/", "private_address"],
			["http://[64:ff9b::7f00:1]/", "private_address"],
			["http://10.0.0.1/", "private_address"],
			["http://192.168.0.1/", "private_address"],
			["http://169.254.169.254/latest/meta-data/", "private_address"],
			["http://100.64.0.1/", "private_address"],
			["http://localhost/", "local_name"],
			["http://nas.lan/", "local_name"],
			["http://router/", "single_label"],
			["file:///etc/passwd", "scheme_not_allowed"],
			["about:config", "scheme_not_allowed"],
			["https://user:pw@example.com/", "userinfo_not_allowed"],
		];
		for (const [url, reason] of table) {
			const r = await daemon.submitJob({ url });
			assert.equal(r.json.result.outcome, "policy_blocked", url);
			assert.equal(r.json.result.error.code, reason, url);
			assert.equal(r.json.result.error.retryable, false);
		}
		await flush(e);
		assert.equal(e.jobs.length, 0, "nothing reached the extension");
		assert.deepEqual(e.received.map((f) => f.type).filter((t) => t !== MSG.PONG), [MSG.CHALLENGE, MSG.READY]);
		assert.deepEqual(daemon.auditEntries().map((a) => a.code), table.map(([, reason]) => reason));

		// The escape hatch for fixtures is closed unless a test opens it.
		const allowed = await daemon.submitJob({ url: "https://example.org/fine" });
		assert.equal(allowed.json.result.outcome, "ok");
		assert.equal(e.jobs.length, 1);
	});
});

test("loopback fixtures pass only on ports the test opened", async () => {
	await withDaemon(
		async ({ daemon, paired }) => {
			const e = await paired();
			assert.equal((await daemon.submitJob({ url: "http://a.localhost:18099/page" })).json.result.outcome, "ok");
			assert.equal((await daemon.submitJob({ url: "http://127.0.0.1:18099/page" })).json.result.outcome, "ok");
			assert.equal((await daemon.submitJob({ url: "http://127.0.0.1:18098/page" })).json.result.outcome, "policy_blocked");
			assert.equal((await daemon.submitJob({ url: `http://127.0.0.1:${daemon.port}/v1/status` })).json.result.outcome, "policy_blocked");
			assert.equal(e.jobs.length, 2);
		},
		{ allowLoopbackPorts: [18099] },
	);
});

test("a web-page-style request is refused, over HTTP and as a WebSocket", async () => {
	await withDaemon(async ({ daemon, ext, paired }) => {
		const e = await paired();
		const viaFetch = await daemon.submitJob(
			{ url: "https://example.com/" },
			{ headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" } },
		);
		assert.equal(viaFetch.status, 403);
		const simple = await daemon.request("POST", "/v1/jobs", {
			auth: false,
			rawBody: JSON.stringify({ url: "https://example.com/" }),
			headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
		});
		assert.equal(simple.status, 403);
		const pairAttempt = await daemon.request("POST", "/v1/pair/start", { body: {}, headers: { Origin: "https://evil.example" } });
		assert.equal(pairAttempt.status, 403);
		assert.equal(pairAttempt.json.code, undefined);

		// new WebSocket("ws://127.0.0.1:<port>/ext") from a page carries the page's origin.
		await e.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		const page = ext({ origin: "https://evil.example" });
		page.key = e.key;
		const r = await page.connect();
		assert.equal(r.httpStatus, 403);
		assert.equal(r.ready, false);

		await flush(await (async () => ((await e.connect()), e))());
		assert.equal(e.jobs.length, 0);
		assert.equal(daemon.auditEntries().length, 0);
	});
});

test("ping every 20 s; the link is dropped after two missed pongs", async () => {
	await withDaemon(async ({ daemon, clock, paired }) => {
		const e = await paired();
		// An extension that answers stays connected.
		for (let i = 1; i <= 5; i++) {
			clock.advance(19999);
			await flush(e);
			assert.equal(e.received.filter((f) => f.type === MSG.PING).length, i - 1);
			clock.advance(1);
			const ping = await e.waitFor(MSG.PING);
			assert.equal(ping.t, clock.now());
			await flush(e);
		}
		assert.equal(e.connected, true);
		assert.deepEqual(e.sent.filter((f) => f.type === MSG.PONG).length, 5);

		// One missed pong is forgiven if the next one is answered.
		e.autoPong = false;
		clock.advance(20000);
		await e.waitFor(MSG.PING);
		e.autoPong = true;
		clock.advance(20000);
		await e.waitFor(MSG.PING);
		await flush(e);
		clock.advance(20000);
		await e.waitFor(MSG.PING);
		await flush(e);
		assert.equal(e.connected, true);

		// Two in a row are not.
		e.autoPong = false;
		e.onJob = () => null;
		clock.advance(20000);
		await e.waitFor(MSG.PING);
		// Long enough that the job's own deadline cannot fire before the ping timeout
		// (the page timeout alone is cut to 30 s; settling and dwelling add to it).
		const pending = daemon.submitJob({ url: "https://example.com/during-outage", wait: { settle_ms: 5000, dwell_ms: 10000 } });
		await e.waitFor(MSG.JOB_START);
		clock.advance(20000);
		await e.waitFor(MSG.PING);
		assert.equal(e.connected, true);
		clock.advance(20000);
		const closed = await e.closed;
		assert.equal(closed.code, 1006, "the socket is cut, not politely closed");
		assert.equal(logged(daemon, "ext.ping_timeout").length, 1);
		assert.equal((await pending).json.result.error.code, "browser_disconnected");
		assert.equal((await daemon.status()).extension.connected, false);
	});
});

test("a pong that answers nothing does not keep the link alive", async () => {
	await withDaemon(async ({ clock, paired }) => {
		const e = await paired();
		e.autoPong = false;
		for (let i = 0; i < 2; i++) {
			clock.advance(20000);
			await e.waitFor(MSG.PING);
			e.send(makeMessage(MSG.PONG, { t: 12345 }));
			await flush(e);
		}
		clock.advance(20000);
		assert.equal((await e.closed).code, 1006);
	});
});

test("pause is a kill switch: state is shown and new jobs fail fast", async () => {
	await withDaemon(async ({ daemon, paired }) => {
		const e = await paired();
		e.sendEvent("paused", { state: { paused: true, pause_reason: "operator" } });
		await flush(e);
		const status = await daemon.status();
		assert.equal(status.extension.state.paused, true);
		assert.equal(status.extension.state.pause_reason, "operator");

		const r = await daemon.submitJob({ url: "https://example.com/" });
		assert.equal(r.json.result.outcome, "error");
		assert.equal(r.json.result.error.code, "paused");
		assert.equal(r.json.result.error.retryable, false);
		assert.equal(e.jobs.length, 0);

		e.sendEvent("resumed", { state: { paused: false, pause_reason: null } });
		await flush(e);
		assert.equal((await daemon.submitJob({ url: "https://example.com/" })).json.result.outcome, "ok");
		assert.deepEqual(logged(daemon, "ext.event").map((l) => l.name), ["paused", "resumed"]);
	});
});

test("an extension that connects paused gets no jobs", async () => {
	await withDaemon(async ({ daemon, ext, paired }) => {
		const first = await paired();
		await first.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		const e = ext({ state: { paused: true, pause_reason: "startup" } });
		e.key = first.key;
		assert.equal((await e.connect()).ready, true);
		assert.equal((await daemon.submitJob({ url: "https://example.com/" })).json.result.error.code, "paused");
		assert.equal(e.jobs.length, 0);
	});
});

test("a caller that goes away cancels its job", async () => {
	await withDaemon(async ({ daemon, paired }) => {
		const e = await paired();
		e.onJob = () => null;
		const controller = new AbortController();
		const pending = daemon.submitJob({ url: "https://example.com/abandoned" }, { signal: controller.signal });
		const start = await e.waitFor(MSG.JOB_START);
		controller.abort();
		await assert.rejects(pending);
		const cancel = await e.waitFor(MSG.JOB_CANCEL);
		assert.deepEqual(cancel, { v: PROTOCOL_VERSION, type: "job.cancel", job: start.job, reason: "client_gone" });
		await until(() => daemon.auditEntries().length === 1);
		assert.deepEqual([daemon.auditEntries()[0].outcome, daemon.auditEntries()[0].code], ["aborted", "client_gone"]);
	});
});

test("an isolated job answered from the default cookie store is not passed on", async () => {
	await withDaemon(async ({ daemon, paired }) => {
		const e = await paired();
		e.onJob = (start) => makeResult(start, { cookie_scope: "default", content: { markdown: "PRIVATE INBOX", text: null, html: null, raw_html: null, links: [], results: [] } });
		const r = await daemon.submitJob({ url: "https://example.com/", session: "isolated" });
		assert.equal(r.json.result.outcome, "error");
		assert.equal(r.json.result.error.code, "scope_violation");
		assert.ok(!r.text.includes("PRIVATE INBOX"));
	});
});

test("shutdown: the running job is cancelled, the socket is closed with 1001", async () => {
	const clock = new FakeClock();
	const daemon = await startTestDaemon({ clock });
	const e = new FakeExtension({ port: daemon.port });
	try {
		assert.equal((await e.pair(await daemon.pairCode())).ready, true);
		e.onJob = () => null;
		const pending = daemon.submitJob({ url: "https://example.com/running" }).catch(() => null);
		const start = await e.waitFor(MSG.JOB_START);
		const closing = daemon.close();
		const cancel = await e.waitFor(MSG.JOB_CANCEL);
		assert.deepEqual(cancel, { v: PROTOCOL_VERSION, type: "job.cancel", job: start.job, reason: "shutdown" });
		assert.equal((await e.closed).code, 1001);
		await closing;
		const r = await pending;
		if (r !== null) assert.equal(r.json.result.outcome, "aborted");
		const audit = daemon.auditEntries();
		assert.deepEqual([audit[0].outcome, audit[0].code], ["aborted", "shutdown"]);
		assert.equal(clock.pending, 0, "no timer survives shutdown");
	} finally {
		await e.kill();
		await daemon.stop();
	}
});

test("secrets never appear in the log or the audit file", async () => {
	await withDaemon(async ({ daemon, clock, ext }) => {
		const code1 = await daemon.pairCode();
		const first = ext();
		assert.equal((await first.pair(code1)).ready, true);
		await daemon.submitJob({ url: "https://example.com/a" });
		await daemon.submitJob({ url: "https://mail.google.com/" });
		await first.close();
		await until(async () => (await daemon.status()).extension.connected === false);
		assert.equal((await first.connect()).ready, true);
		await first.close();
		await until(async () => (await daemon.status()).extension.connected === false);

		// Failures, a wrong pairing attempt and a re-pair for good measure.
		const bad = ext();
		bad.key = first.key;
		await bad.connect({ corruptMac: true });
		clock.advance(60000);
		const code2 = await daemon.pairCode();
		const guess = ext();
		await guess.pair(code2, { corruptMac: true });
		const second = ext();
		assert.equal((await second.pair(code2)).ready, true);
		await daemon.request("GET", "/v1/status", { auth: false, headers: { Authorization: `Bearer ${daemon.token}x` } });

		const secrets = new Set([daemon.token, daemon.adminToken, code1, code2, code1.split(".")[2], code2.split(".")[2]]);
		for (const e of [first, second]) if (e.key) secrets.add(b64urlEncode(e.key));
		for (const e of [first, second, bad, guess]) {
			for (const f of e.received) if (f.type === MSG.CHALLENGE) secrets.add(f.mac_s).add(f.nonce_s);
			for (const f of e.sent) {
				if (typeof f.mac_c === "string") secrets.add(f.mac_c);
				if (typeof f.nonce_c === "string") secrets.add(f.nonce_c);
			}
		}
		assert.ok(secrets.size >= 20, `only ${secrets.size} secrets collected`);
		const logText = daemon.logs.join("\n");
		const auditText = fs.readFileSync(path.join(daemon.dataDir, "audit.jsonl"), "utf8");
		assert.ok(daemon.logs.length >= 15);
		for (const secret of secrets) {
			assert.ok(!logText.includes(secret), "a secret reached the log");
			assert.ok(!auditText.includes(secret), "a secret reached the audit file");
		}
		// On disk: the token and the current key, each only in its own file.
		const files = fs.readdirSync(daemon.configDir).sort();
		assert.deepEqual(files, ["admin.token", "client.token", "ext.key"]);
		const status = await daemon.request("GET", "/v1/status");
		for (const secret of secrets) assert.ok(!status.text.includes(secret), "a secret reached /v1/status");
	});
});
