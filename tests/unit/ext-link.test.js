// The extension's link module against the real daemon and against a scripted
// one. The scripted daemon is there for what the real one will not do on
// request: every close code of the reconnect contract, and bad frames.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestDaemon, until } from "../helpers/daemon.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";
import { challengeFor, daemonPairCode, daemonStatus, logSink, memorySettings, relayTo, scriptedDaemon, sleep, socketFactory } from "../helpers/ext-fakes.js";
import { FakeExtension, defaultState } from "../helpers/fake-extension.js";
import { Link, PHASE, TERMINAL_PHASES } from "../../extension/background/link.js";
import { b64urlDecode, b64urlEncode, pairingKey, randomBytes } from "../../extension/shared/auth.js";
import { HANDSHAKE_CORE_SINCE, LIMITS, MSG, PROTOCOL_VERSION, makeMessage, DIRECTION, validateMessage } from "../../extension/shared/protocol.js";

const FAST = { baseMs: 20, capMs: 160, longMs: 4000, unverifiedBaseMs: 60, unverifiedCapMs: 240, stableMs: 100000, handshakeTimeoutMs: 800, pairTimeoutMs: 1500, replaceWaitMs: 300 };

/**
 * @param {{ port: number, key?: import("../../extension/shared/auth.js").Bytes | null, tuning?: Partial<typeof FAST>, random?: () => number }} opts
 */
function makeLink(opts) {
	const settings = memorySettings({ port: opts.port, key: opts.key ?? null });
	const sockets = socketFactory();
	const sink = logSink();
	/** @type {string[]} */
	const events = [];
	/** @type {Record<string, unknown>[]} */
	const messages = [];
	const link = new Link({
		createSocket: sockets.create,
		settings,
		getState: () => defaultState(),
		identity: { extVersion: "0.1.0", browser: { name: "TestFox", version: "1.2" } },
		handlers: {
			onReady: () => events.push("ready"),
			onDown: () => events.push("down"),
			onMessage: (msg) => messages.push(msg),
			onStatus: () => {},
		},
		log: sink.log,
		random: opts.random ?? (() => 0.5),
		tuning: { ...FAST, ...opts.tuning },
	});
	return { link, settings, sockets, sink, events, messages };
}

/**
 * @param {Link} link
 * @param {string} phase
 * @param {number} [timeoutMs]
 */
const phaseIs = (link, phase, timeoutMs = 3000) => until(() => link.status().phase === phase, { timeoutMs, what: `phase ${phase} (is ${link.status().phase})` });

/** A daemon that already holds a key, as after a pairing. */
async function pairedDaemon() {
	const dir = makeTempDir("extlink");
	const configDir = path.join(dir, "config");
	fs.mkdirSync(configDir, { mode: 0o700 });
	const key = randomBytes(32);
	fs.writeFileSync(path.join(configDir, "ext.key"), b64urlEncode(key) + "\n", { mode: 0o600 });
	const daemon = await startTestDaemon({ configDir });
	return {
		daemon,
		key,
		configDir,
		stop: async () => {
			await daemon.stop();
			removeTempDir(dir);
		},
	};
}

test("auth mode against the real daemon: ready, state delivered, pings answered", async () => {
	const d = await pairedDaemon();
	const { link, events, sink } = makeLink({ port: d.daemon.port, key: d.key });
	try {
		assert.equal(link.status().phase, PHASE.STOPPED);
		link.start();
		await phaseIs(link, PHASE.READY);
		assert.deepEqual(events, ["ready"]);
		const status = await daemonStatus(d.daemon);
		assert.equal(status.extension.connected, true);
		assert.equal(status.extension.ext_version, "0.1.0");
		assert.deepEqual(status.extension.browser, { name: "TestFox", version: "1.2" });
		assert.deepEqual(status.extension.state, defaultState());
		assert.equal(link.isReady(), true);
		assert.equal(link.maxResultBytes, 8388608);
		assert.equal(link.status().lastError, null);
		// Neither the key nor anything made from it reaches the log.
		assert.equal(sink.text().includes(b64urlEncode(d.key)), false);
	} finally {
		await link.stop();
		await d.stop();
	}
});

test("the daemon's proof is checked first: with the wrong key nothing made from it is sent", async () => {
	const d = await pairedDaemon();
	const wrong = randomBytes(32);
	const { link, events, sockets, settings } = makeLink({ port: d.daemon.port, key: wrong });
	try {
		link.start();
		await phaseIs(link, PHASE.UNVERIFIED);
		const status = link.status();
		assert.equal(status.reason, "daemon_unverified");
		assert.match(String(status.lastError), /Daemon not verified/);
		assert.match(String(status.lastError), /wrong proof/);
		assert.ok(status.retryAt !== null && status.retryAt > Date.now(), "the next attempt is scheduled");
		assert.deepEqual(events, []);
		// The daemon never saw an auth frame: it has no failed attempt on record.
		await sleep(50);
		const logs = d.daemon.logs.map((l) => JSON.parse(l));
		assert.equal(logs.some((l) => l.event === "ext.auth_failed"), false);
		assert.equal(logs.some((l) => l.event === "ext.connected"), false);
		// It keeps trying, and the key it holds is not thrown away over it.
		await until(() => sockets.dials >= 3, { timeoutMs: 4000, what: "further attempts" });
		assert.equal(settings.key, wrong);
		assert.equal(settings.keyWrites, 0);
		assert.equal(TERMINAL_PHASES.includes(link.status().phase), false);
	} finally {
		await link.stop();
		await d.stop();
	}
});

test("a scripted peer with a wrong proof gets no auth frame", async () => {
	/** @type {import("../helpers/ext-fakes.js").FakeDaemonConn[]} */
	const seen = [];
	const fake = await scriptedDaemon(async (conn) => {
		seen.push(conn);
		const hello = await conn.next();
		assert.equal(hello.type, MSG.HELLO);
		conn.send(makeMessage(MSG.CHALLENGE, { instance: "squatter", nonce_s: hello.nonce_c, mac_s: b64urlEncode(randomBytes(32)) }));
	});
	const key = randomBytes(32);
	const { link, sink } = makeLink({ port: fake.port, key });
	try {
		link.start();
		await phaseIs(link, PHASE.UNVERIFIED);
		await seen[0].closed;
		assert.deepEqual(seen[0].received.map((f) => f.type), [MSG.HELLO]);
		// hello carries nothing made from the key
		assert.deepEqual(Object.keys(seen[0].received[0]).sort(), ["browser", "ext_version", "mode", "nonce_c", "type", "v"]);
		assert.equal(link.status().reason, "daemon_unverified");
		assert.equal(sink.count("link.daemon_unverified"), 1);
	} finally {
		await link.stop();
		await fake.stop();
	}
});

test("a daemon that holds no key cannot prove itself: not terminal, the key is kept, retried late, and the operator is told to pair if the daemon is new", async () => {
	const daemon = await startTestDaemon();
	const key = randomBytes(32);
	const { link, sockets, settings, events } = makeLink({ port: daemon.port, key });
	try {
		link.start();
		await phaseIs(link, PHASE.UNVERIFIED);
		assert.equal(TERMINAL_PHASES.includes(link.status().phase), false);
		// It answers like a daemon that holds another key: with a proof that does not verify.
		assert.equal(link.status().reason, "daemon_unverified");
		assert.equal(
			link.status().lastError,
			`Daemon not verified: the program on port ${daemon.port} answered with a wrong proof (it holds another key, or none), but did not prove that it is the daemon. The stored key is kept and nothing made from it was sent. Still trying. If the daemon was set up anew, pair again.`,
		);
		assert.ok(link.status().retryAt !== null);
		await until(() => sockets.dials >= 3, { timeoutMs: 4000, what: "further attempts" });
		// Between two attempts it is back in the same state.
		await phaseIs(link, PHASE.UNVERIFIED);
		assert.equal(settings.key, key);
		assert.equal(settings.keyWrites, 0);
		assert.deepEqual(events, []);
		// The extension stopped at the challenge: the daemon saw no auth frame. Its log says why nobody connects.
		const logs = daemon.logs.map((l) => JSON.parse(l));
		assert.equal(logs.some((l) => l.event === "ext.auth_failed"), false);
		assert.ok(logs.some((l) => l.event === "ext.not_paired"));
		assert.equal((await daemonStatus(daemon)).paired, false);

		// Pairing is what mends it, and it works from this state.
		assert.deepEqual(await link.pair(await daemonPairCode(daemon)), { ok: true });
		assert.equal(link.status().phase, PHASE.READY);
		assert.equal(settings.keyWrites, 1);
	} finally {
		await link.stop();
		await daemon.stop();
	}
});

test("no key stored: unpaired, nothing is dialled", async () => {
	const { link, sockets } = makeLink({ port: 1 });
	link.start();
	assert.equal(link.status().phase, PHASE.UNPAIRED);
	assert.equal(link.status().paired, false);
	await sleep(100);
	assert.equal(sockets.dials, 0);
	await link.stop();
});

test("pair mode against the real daemon: key derived on both sides, then auth mode works", async () => {
	const daemon = await startTestDaemon();
	const { link, settings, events, sink } = makeLink({ port: 1 });
	try {
		link.start();
		const code = await daemonPairCode(daemon);
		const result = await link.pair(`  ${code}\n`);
		assert.deepEqual(result, { ok: true });
		assert.equal(link.status().phase, PHASE.READY);
		assert.equal(settings.port, daemon.port, "the port comes from the code");
		const stored = fs.readFileSync(path.join(daemon.configDir, "ext.key"), "utf8").trim();
		assert.ok(settings.key !== null);
		assert.equal(b64urlEncode(settings.key), stored, "both sides hold the same derived key");
		assert.deepEqual(events, ["ready"]);

		await link.reconnect();
		await phaseIs(link, PHASE.READY);
		assert.deepEqual(events, ["ready", "down", "ready"]);
		assert.equal(JSON.parse(daemon.logs.filter((l) => l.includes("ext.connected")).at(-1) ?? "{}").mode, "auth");

		// The code, its secret and the keys stay out of the log.
		const text = sink.text();
		assert.equal(text.includes(code), false);
		assert.equal(text.includes(code.split(".")[2]), false);
		assert.equal(text.includes(stored), false);
	} finally {
		await link.stop();
		await daemon.stop();
	}
});

test("pairing fails cleanly: bad text, unknown code, daemon away - and is never repeated by itself", async () => {
	const daemon = await startTestDaemon();
	const { link, sockets, settings } = makeLink({ port: daemon.port });
	try {
		link.start();
		const malformed = await link.pair("not a code");
		assert.equal(malformed.ok, false);
		assert.equal(sockets.dials, 0);

		const unknown = await link.pair(`bgw1.${daemon.port}.${b64urlEncode(randomBytes(32))}`);
		assert.equal(unknown.ok, false);
		assert.match(/** @type {{ error: string }} */ (unknown).error, /did not prove that it knows this code|rejected the code/);
		assert.equal(link.status().phase, PHASE.UNPAIRED);
		assert.equal(settings.key, null);
		await sleep(300);
		assert.equal(sockets.dials, 1, "one attempt per code");

		await daemon.close();
		const away = await link.pair(`bgw1.${daemon.port}.${b64urlEncode(randomBytes(32))}`);
		assert.equal(away.ok, false);
		assert.match(/** @type {{ error: string }} */ (away).error, /Could not reach|did not answer/);
		assert.equal(link.status().phase, PHASE.UNPAIRED);
	} finally {
		await link.stop();
		await daemon.stop();
	}
});

test("a failed pairing falls back to the key that is already stored", async () => {
	const d = await pairedDaemon();
	const { link, settings, events } = makeLink({ port: d.daemon.port, key: d.key });
	try {
		link.start();
		await phaseIs(link, PHASE.READY);
		const result = await link.pair(`bgw1.${d.daemon.port}.${b64urlEncode(randomBytes(32))}`);
		assert.equal(result.ok, false);
		assert.equal(settings.key, d.key);
		await phaseIs(link, PHASE.READY);
		assert.deepEqual(events, ["ready", "down", "ready"]);

		// A code for another port that does not work does not leave the extension dialling that port.
		const elsewhere = await link.pair(`bgw1.1.${b64urlEncode(randomBytes(32))}`);
		assert.equal(elsewhere.ok, false);
		await until(() => settings.port === d.daemon.port, { what: "the port to be put back" });
		await phaseIs(link, PHASE.READY);
		assert.equal(settings.key, d.key);
	} finally {
		await link.stop();
		await d.stop();
	}
});

/**
 * Run a link against a scripted daemon that closes every connection with one
 * code: right after hello (a peer that proved nothing), or after it proved
 * that it knows the key and took the extension's proof.
 * @param {number} code
 * @param {"unverified" | "verified"} how
 * @param {(ctx: ReturnType<typeof makeLink> & { fake: Awaited<ReturnType<typeof scriptedDaemon>>, key: import("../../extension/shared/auth.js").Bytes }) => Promise<void>} body
 */
async function closingWith(code, how, body) {
	const key = randomBytes(32);
	const fake = await scriptedDaemon(async (conn) => {
		if (how === "verified") assert.equal((await conn.prove(key)).macOk, true);
		else await conn.next();
		conn.close(code);
	});
	const ctx = makeLink({ port: fake.port, key });
	try {
		ctx.link.start();
		await body({ ...ctx, fake, key });
	} finally {
		await ctx.link.stop();
		await fake.stop();
	}
}

// Anything can listen on the port. What it says when it closes
// the socket counts only after it proved that it is the daemon.
for (const [code, reason, said] of /** @type {[number, string, RegExp][]} */ ([
	[4001, "unverified_auth_failed", /refused the connection/],
	[4004, "unverified_not_paired", /holds no key/],
	[4003, "unverified_protocol_version", /another protocol version/],
	[4002, "unverified_already_connected", /another browser is connected/],
])) {
	test(`close ${code} from a peer that proved nothing: key kept, "daemon not verified", retries go on`, async () => {
		await closingWith(code, "unverified", async ({ link, sockets, settings, key, fake, sink }) => {
			await phaseIs(link, PHASE.UNVERIFIED);
			const status = link.status();
			assert.equal(status.reason, reason);
			assert.match(String(status.lastError), /^Daemon not verified/);
			assert.match(String(status.lastError), said);
			assert.match(String(status.lastError), /key is kept/);
			assert.equal(TERMINAL_PHASES.includes(status.phase), false);
			assert.ok(status.retryAt !== null && status.retryAt > Date.now() - 5, "a next attempt is scheduled");
			assert.equal(status.paired, true);
			await until(() => sink.count("link.unverified") >= 3, { timeoutMs: 5000, what: "further attempts" });
			assert.ok(sockets.dials >= 3);
			// Between two attempts it is back in the same state, never in a terminal one.
			await phaseIs(link, PHASE.UNVERIFIED);
			// Nothing made from the key ever went to that peer, and the key is untouched.
			for (const conn of fake.conns) assert.deepEqual(conn.received.map((f) => f.type), [MSG.HELLO]);
			assert.equal(settings.key, key);
			assert.equal(settings.keyWrites, 0, "the stored key was neither removed nor replaced");
		});
	});
}

test("unverified: the retries come late and later, never beyond the cap", async () => {
	/** @type {number[]} */
	const at = [];
	const fake = await scriptedDaemon(async (conn) => {
		at.push(Date.now());
		await conn.next();
		conn.close(4001);
	});
	// Steps 60, 120, 240, 240, ... at 75 % to 100 %; with random() = 1 the full step.
	const { link } = makeLink({ port: fake.port, key: randomBytes(32), random: () => 1 });
	try {
		link.start();
		await until(() => at.length >= 6, { timeoutMs: 8000, what: "six attempts" });
		const gaps = at.slice(1).map((t, i) => t - at[i]);
		assert.ok(gaps[0] >= 55 && gaps[0] < 150, `first gap ${gaps[0]}: slower than an ordinary first retry (20 ms)`);
		assert.ok(gaps[1] > gaps[0] && gaps[2] > gaps[1], `gaps grow: ${gaps.join(", ")}`);
		assert.ok(gaps[3] >= 230 && gaps[4] >= 230, `at the cap: ${gaps.join(", ")}`);
		assert.ok(Math.max(...gaps) < FAST.unverifiedCapMs + 120, `never beyond the cap: ${gaps.join(", ")}`);
	} finally {
		await link.stop();
		await fake.stop();
	}
});

test("unverified: the shipped delays are 5 s at first and 60 s at most", async () => {
	const fake = await scriptedDaemon(async (conn) => {
		await conn.next();
		conn.close(4004);
	});
	/** @param {Partial<typeof FAST>} tuning @param {number} random */
	const firstWait = async (tuning, random) => {
		const settings = memorySettings({ port: fake.port, key: randomBytes(32) });
		// No tuning for the unverified delays: what the extension ships with.
		const link = new Link({
			createSocket: socketFactory().create,
			settings,
			getState: () => defaultState(),
			identity: { extVersion: "0.1.0", browser: { name: "TestFox", version: "1.2" } },
			handlers: { onReady: () => {}, onDown: () => {}, onMessage: () => {}, onStatus: () => {} },
			log: () => {},
			random: () => random,
			tuning,
		});
		try {
			link.start();
			await phaseIs(link, PHASE.UNVERIFIED);
			return (link.status().retryAt ?? 0) - Date.now();
		} finally {
			await link.stop();
		}
	};
	try {
		const longest = await firstWait({}, 1);
		assert.ok(longest > 4800 && longest <= 5000, `first wait at most 5 s: ${longest}`);
		const shortest = await firstWait({}, 0);
		assert.ok(shortest > 3550 && shortest <= 3750, `and at least three quarters of that: ${shortest}`);
		// However far the doubling has gone, the shipped cap holds.
		const capped = await firstWait({ unverifiedBaseMs: 60000 * 64 }, 1);
		assert.ok(capped > 59800 && capped <= 60000, `never more than 60 s: ${capped}`);
	} finally {
		await fake.stop();
	}
});

test("a squatter on the port, then the real daemon: the kept key connects, nothing had to be paired again", async () => {
	const d = await pairedDaemon();
	const port = d.daemon.port;
	await d.daemon.close();
	// Something else takes the port and answers every hello with "auth failed", then with "not paired".
	let n = 0;
	const squatter = await scriptedDaemon(
		async (conn) => {
			await conn.next();
			conn.close(n++ % 2 === 0 ? 4001 : 4004);
		},
		{ port },
	);
	const { link, settings, sockets, events } = makeLink({ port, key: d.key });
	let real = null;
	try {
		link.start();
		await phaseIs(link, PHASE.UNVERIFIED);
		await until(() => sockets.dials >= 3, { timeoutMs: 4000, what: "retries against the squatter" });
		assert.deepEqual(events, []);
		assert.equal(settings.key, d.key);
		await squatter.stop();
		real = await startTestDaemon({ configDir: d.configDir, port });
		await phaseIs(link, PHASE.READY, 6000);
		assert.deepEqual(events, ["ready"]);
		assert.equal(link.status().lastError, null);
		assert.equal(settings.keyWrites, 0);
		assert.equal((await daemonStatus(real)).extension.connected, true);
	} finally {
		await link.stop();
		await squatter.stop().catch(() => {});
		if (real !== null) await real.stop();
		await d.stop().catch(() => {});
	}
});

test("close 4001 from a daemon that proved itself: terminal until the operator acts, key still kept", async () => {
	await closingWith(4001, "verified", async ({ link, sockets, settings, key }) => {
		await phaseIs(link, PHASE.AUTH_FAILED);
		assert.ok(TERMINAL_PHASES.includes(link.status().phase));
		assert.match(String(link.status().lastError), /Pair again/);
		assert.equal(link.status().retryAt, null);
		await sleep(400);
		assert.equal(sockets.dials, 1, "no further attempts");
		// Terminal is a state of the link, not of the key: only the operator removes that.
		assert.equal(settings.key, key);
		assert.equal(settings.keyWrites, 0);
		// The operator pressing "reconnect" is such an act.
		await link.reconnect();
		await until(() => sockets.dials === 2);
		await phaseIs(link, PHASE.AUTH_FAILED);
	});
});

test("close 4004 from a daemon that proved itself: terminal", async () => {
	await closingWith(4004, "verified", async ({ link, sockets, settings }) => {
		await phaseIs(link, PHASE.NOT_PAIRED);
		assert.match(String(link.status().lastError), /Pair again/);
		await sleep(300);
		assert.equal(sockets.dials, 1);
		assert.equal(settings.keyWrites, 0);
	});
});

test("close 4003 from a daemon that proved itself: terminal, version mismatch", async () => {
	await closingWith(4003, "verified", async ({ link, sockets }) => {
		await phaseIs(link, PHASE.PROTOCOL_VERSION);
		assert.match(String(link.status().lastError), /Version mismatch/);
		await sleep(300);
		assert.equal(sockets.dials, 1);
	});
});

test("close 4002 from a daemon that proved itself: a long wait, not a retry loop", async () => {
	await closingWith(4002, "verified", async ({ link, sockets }) => {
		await phaseIs(link, PHASE.WAITING);
		const status = link.status();
		assert.equal(status.reason, "already_connected");
		assert.ok(status.retryAt !== null && status.retryAt - Date.now() > FAST.longMs * 0.9, "waits at least the long delay");
		await sleep(500);
		assert.equal(sockets.dials, 1);
	});
});

test("close 1013 means nothing special (the daemon throttles nothing): retried like any other close, the key kept", async () => {
	await closingWith(1013, "unverified", async ({ link, sockets, settings, key }) => {
		await until(() => sockets.dials >= 3, { timeoutMs: 4000, what: "retries" });
		// Between two attempts: waiting, with the reason any close without a meaning of its own gets.
		await until(() => link.status().phase === PHASE.WAITING, { timeoutMs: 4000, what: "the pause before the next attempt" });
		assert.equal(link.status().reason, "unreachable");
		assert.notEqual(link.status().reason, "throttled");
		assert.equal(TERMINAL_PHASES.includes(link.status().phase), false);
		assert.equal(settings.key, key);
		assert.equal(settings.keyWrites, 0);
	});
});

test("any other close: retried with a growing, capped, jittered delay", async () => {
	/** @type {number[]} */
	const at = [];
	const fake = await scriptedDaemon(async (conn) => {
		at.push(Date.now());
		await conn.next();
		conn.close(1011);
	});
	const { link } = makeLink({ port: fake.port, key: randomBytes(32), tuning: { baseMs: 40, capMs: 320 }, random: () => 0.5 });
	try {
		link.start();
		await until(() => at.length >= 7, { timeoutMs: 8000, what: "seven attempts" });
		const gaps = at.slice(1).map((t, i) => t - at[i]);
		// Steps 40, 80, 160, 320, 320, ... at 75 % each (half fixed, half random with random() = 0.5).
		assert.ok(gaps[0] >= 25 && gaps[0] < 120, `first gap ${gaps[0]}`);
		assert.ok(gaps[2] > gaps[0], `gaps grow: ${gaps.join(", ")}`);
		assert.ok(gaps[3] >= 200, `fourth gap near the cap: ${gaps.join(", ")}`);
		assert.ok(Math.max(...gaps) < 320 + 150, `never beyond the cap: ${gaps.join(", ")}`);
		assert.equal(link.status().reason, "unreachable");
	} finally {
		await link.stop();
		await fake.stop();
	}
});

test("nobody listening: unreachable, retried", async () => {
	const fake = await scriptedDaemon(() => {});
	const port = fake.port;
	await fake.stop();
	const { link, sockets } = makeLink({ port, key: randomBytes(32) });
	try {
		link.start();
		await until(() => sockets.dials >= 3, { timeoutMs: 4000, what: "retries" });
		assert.equal(link.status().reason, "unreachable");
		assert.match(String(link.status().lastError), new RegExp(`127\\.0\\.0\\.1:${port}`));
	} finally {
		await link.stop();
	}
});

/**
 * A link that is up against a scripted daemon playing the handshake properly.
 * @param {(ctx: ReturnType<typeof makeLink> & { conn: import("../helpers/ext-fakes.js").FakeDaemonConn, conns: import("../helpers/ext-fakes.js").FakeDaemonConn[] }) => Promise<void>} body
 * @param {{ pingS?: number }} [opts]
 */
async function upAgainstScripted(body, opts = {}) {
	const key = randomBytes(32);
	/** @type {import("../helpers/ext-fakes.js").FakeDaemonConn[]} */
	const conns = [];
	const fake = await scriptedDaemon(async (conn) => {
		conns.push(conn);
		const { macOk } = await conn.handshake(key, opts);
		assert.equal(macOk, true, "the extension's proof verifies");
	});
	const ctx = makeLink({ port: fake.port, key });
	try {
		ctx.link.start();
		await phaseIs(ctx.link, PHASE.READY);
		await body({ ...ctx, conn: conns[0], conns });
	} finally {
		await ctx.link.stop();
		await fake.stop();
	}
}

const JOB_START = makeMessage(MSG.JOB_START, {
	job: "j_1",
	kind: "fetch",
	url: "https://example.com/",
	session: "auto",
	wait: { timeout_ms: 30000, settle_ms: 1500, dwell_ms: 0, human_wait_ms: 0, scroll: "none" },
	extract: { markdown: true, text: true, html: false, raw_html: false, links: true, adapter: "auto" },
	files: null,
});

// The daemon listens on one port, something else holds the port the extension
// dials and passes the handshake on. The daemon answers it - it cannot tell -
// but its proof names its own port, and the extension's would name the other.
test("a go-between on another port: the daemon's proof does not verify there, and nothing made from the key is sent", async () => {
	const d = await pairedDaemon();
	// Behind the challenge it says "ready" itself and starts a job, as it would to pass for the daemon.
	const relay = await relayTo(d.daemon.port, {
		afterChallenge: [makeMessage(MSG.READY, { limits: { max_result_bytes: 8388608, ping_s: 20 } }), JOB_START],
	});
	const state = { ...defaultState(), optin_hosts: ["intranet.example.com"] };
	const settings = memorySettings({ port: relay.port, key: d.key });
	const sockets = socketFactory();
	const sink = logSink();
	/** @type {string[]} */
	const events = [];
	/** @type {Record<string, unknown>[]} */
	const messages = [];
	const link = new Link({
		createSocket: sockets.create,
		settings,
		getState: () => state,
		identity: { extVersion: "0.1.0", browser: { name: "TestFox", version: "1.2" } },
		handlers: { onReady: () => events.push("ready"), onDown: () => events.push("down"), onMessage: (msg) => messages.push(msg), onStatus: () => {} },
		log: sink.log,
		random: () => 0.5,
		tuning: FAST,
	});
	try {
		assert.notEqual(relay.port, d.daemon.port);
		link.start();
		await phaseIs(link, PHASE.UNVERIFIED);
		assert.equal(link.status().reason, "daemon_unverified");
		assert.match(String(link.status().lastError), /wrong proof/);
		await until(() => sockets.dials >= 3, { timeoutMs: 4000, what: "further attempts" });
		await phaseIs(link, PHASE.UNVERIFIED);

		// The daemon did answer every hello that was passed on to it: a well-formed challenge each time.
		const challenges = relay.fromDaemon.filter((f) => f.type === MSG.CHALLENGE);
		assert.ok(challenges.length >= 2);
		for (const c of challenges) assert.deepEqual(validateMessage(c, DIRECTION.TO_EXT), { ok: true });
		// The extension never took it: no auth frame, so neither its proof nor its state - the
		// hosts of the login rules among it - reached whoever holds the port.
		assert.deepEqual([...new Set(relay.fromExt.map((f) => f.type))], [MSG.HELLO]);
		assert.equal(JSON.stringify(relay.fromExt).includes("intranet.example.com"), false);
		// "ready" and the job that followed the challenge were not acted on.
		assert.deepEqual(events, []);
		assert.deepEqual(messages, []);
		assert.equal(link.isReady(), false);
		assert.ok(sink.count("link.daemon_unverified") >= 2);
		assert.equal(sink.count("link.ready"), 0);
		assert.equal(settings.keyWrites, 0);
		// And the daemon has nothing: no extension, no failed proof on record.
		assert.equal((await daemonStatus(d.daemon)).extension.connected, false);
		const logs = d.daemon.logs.map((l) => JSON.parse(l));
		assert.equal(logs.some((l) => l.event === "ext.connected" || l.event === "ext.auth_failed"), false);
	} finally {
		await link.stop();
		await relay.stop();
		await d.stop();
	}
});

test("a go-between on another port: an extension proof made for the dialled port is refused by the daemon - only a proof for the daemon's port would pass", async () => {
	const d = await pairedDaemon();
	const relay = await relayTo(d.daemon.port);
	/** @type {FakeExtension[]} */
	const exts = [];
	/** @returns {FakeExtension} one that dials the go-between */
	const viaRelay = () => {
		const e = new FakeExtension({ port: relay.port });
		e.key = d.key;
		exts.push(e);
		return e;
	};
	try {
		// What the extension does: it checks the proof against the port it dialled, and stops.
		const careful = await viaRelay().connect();
		assert.equal(careful.serverMacValid, false);
		assert.equal(careful.ready, false);

		// Suppose it went on regardless. Its own proof names the port it dialled; the daemon listens on another.
		const careless = await viaRelay().connect({ ignoreServerMac: true });
		assert.deepEqual(careless, { ready: false, httpStatus: null, closeCode: 4001, closeReason: "", serverMacValid: false });
		assert.equal(relay.daemonCloses.at(-1), 4001);
		assert.equal((await daemonStatus(d.daemon)).extension.connected, false);
		assert.equal(d.daemon.logs.map((l) => JSON.parse(l)).filter((l) => l.event === "ext.auth_failed").length, 1);

		// Pair mode, the same: the code names the daemon's port, the socket was opened on the other.
		const pairing = new FakeExtension({ port: relay.port });
		exts.push(pairing);
		const paired = await pairing.pair(await daemonPairCode(d.daemon), { ignoreServerMac: true });
		assert.equal(paired.serverMacValid, false);
		assert.equal(paired.closeCode, 4001);
		assert.equal(pairing.key, null);

		// The go-between itself passes everything on faithfully: with proofs made for the daemon's
		// port - what version 4 amounted to, where no port was in them - the handshake goes through
		// it. The port in the proofs is all that stands in its way.
		const blind = viaRelay();
		const through = await blind.connect({ macPort: d.daemon.port });
		assert.deepEqual(through, { ready: true, httpStatus: null, closeCode: null, closeReason: null, serverMacValid: true });
		await blind.close();
	} finally {
		for (const e of exts) await e.kill();
		await relay.stop();
		await d.stop();
	}
});

test("valid frames are passed on, pings are answered", async () => {
	await upAgainstScripted(async ({ conn, messages }) => {
		conn.send(JOB_START);
		conn.send(makeMessage(MSG.JOB_CANCEL, { job: "j_1", reason: "deadline" }));
		conn.send(makeMessage(MSG.PING, { t: 4242 }));
		const pong = await conn.next();
		assert.deepEqual(pong, makeMessage(MSG.PONG, { t: 4242 }));
		assert.deepEqual(messages.map((m) => m.type), [MSG.JOB_START, MSG.JOB_CANCEL]);
	});
});

test("every invalid inbound frame closes the link", async () => {
	/** @type {[string, (conn: import("../helpers/ext-fakes.js").FakeDaemonConn) => void][]} */
	const cases = [
		["unknown type", (c) => c.send({ v: PROTOCOL_VERSION, type: "job.execute", code: "alert(1)" })],
		["extra field", (c) => c.send({ ...JOB_START, evil: true })],
		["missing field", (c) => c.send({ v: PROTOCOL_VERSION, type: MSG.JOB_CANCEL, job: "j_1" })],
		["wrong direction", (c) => c.send(makeMessage(MSG.JOB_ACCEPTED, { job: "j_1", cookie_scope: "container", rule: null }))],
		["not json", (c) => c.sendRaw("{nope")],
		["binary", (c) => c.sendRaw(Buffer.from([1, 2, 3]), true)],
		["a second ready", (c) => c.send(makeMessage(MSG.READY, { limits: { max_result_bytes: 1, ping_s: 1 } }))],
		["oversized", (c) => c.sendRaw(JSON.stringify({ ...JOB_START, url: "https://example.com/" + "a".repeat(70000) }))],
	];
	for (const [name, send] of cases) {
		await upAgainstScripted(async ({ link, conn, events, messages, sink }) => {
			send(conn);
			const closed = await conn.closed;
			assert.equal(closed.code, 4400, name);
			assert.deepEqual(events, ["ready", "down"], name);
			assert.deepEqual(messages, [], name);
			assert.equal(link.isReady(), false, name);
			assert.equal(sink.count("link.bad_frame"), 1, name);
		});
	}
});

test("nothing the daemon can send carries a login rule or asks for the operator's session: every such frame closes the link, and none reaches the job runner", async () => {
	const rule = { host: "bank.example.com", path_prefix: "/", subdomains: true };
	const state = { paused: false, pause_reason: null, slots: 1, container: { ready: true }, window: { open: true }, policy_rev: 2, optin_hosts: ["bank.example.com"] };
	/** @type {[string, Record<string, unknown>][]} */
	const cases = [
		["a message that sets rules", { v: PROTOCOL_VERSION, type: "optin.set", rules: [{ host: "bank.example.com", pathPrefix: "/", subdomains: true }] }],
		["a message that sets the policy", { v: PROTOCOL_VERSION, type: "policy.set", optin_hosts: ["bank.example.com"] }],
		["a message that writes settings", { v: PROTOCOL_VERSION, type: "settings.set", optinRules: { v: 1, rules: [] } }],
		["the extension's own event, sent back at it", makeMessage(MSG.EVENT, { name: "policy.changed", host: null, job: null, state, detect: null })],
		["the extension's own state, sent back at it", makeMessage(MSG.AUTH, { mac_c: "A".repeat(43), state })],
		["job.accepted with a rule", makeMessage(MSG.JOB_ACCEPTED, { job: "j_1", cookie_scope: "default", rule })],
		["ready with opt-in hosts", makeMessage(MSG.READY, { limits: { max_result_bytes: 8388608, ping_s: 20 }, optin_hosts: ["bank.example.com"] })],
		["job.start, session default", { ...JOB_START, session: "default" }],
		["job.start, session login", { ...JOB_START, session: "login" }],
		["job.start, session as a list", { ...JOB_START, session: ["auto", "default"] }],
		["job.start with a rule", { ...JOB_START, rule }],
		["job.start with a cookie scope", { ...JOB_START, cookie_scope: "default" }],
		["job.start with a cookie store", { ...JOB_START, cookieStoreId: "firefox-default" }],
		["job.start with opt-in rules", { ...JOB_START, optin: [rule] }],
		["job.start with a session inside wait", { ...JOB_START, wait: { .../** @type {Record<string, unknown>} */ (JOB_START.wait), session: "default" } }],
		["job.start with a rule inside extract", { ...JOB_START, extract: { .../** @type {Record<string, unknown>} */ (JOB_START.extract), rule } }],
		["attention with a rule", makeMessage(MSG.ATTENTION, { job: "j_1", action: "focus", rule })],
		["attention that asks for something else", makeMessage(MSG.ATTENTION, { job: "j_1", action: "optin" })],
		["job.cancel with a rule", makeMessage(MSG.JOB_CANCEL, { job: "j_1", reason: "deadline", rule })],
		["ping with a rule", makeMessage(MSG.PING, { t: 1, rule })],
	];
	for (const [name, frame] of cases) {
		await upAgainstScripted(async ({ link, conn, events, messages, sink }) => {
			conn.send(frame);
			const closed = await conn.closed;
			assert.equal(closed.code, 4400, name);
			assert.deepEqual(events, ["ready", "down"], name);
			assert.deepEqual(messages, [], `${name}: nothing was handed on`);
			assert.equal(link.isReady(), false, name);
			assert.equal(sink.count("link.bad_frame"), 1, name);
			// What is logged names the fault, never what the frame held.
			assert.equal(sink.text().includes("bank.example.com"), false, name);
		});
	}
	// What the daemon may send, all of it: seven kinds of frame, and the three that reach the rest of the extension.
	const toExt = Object.values(MSG).filter((type) => {
		const checked = validateMessage({ v: PROTOCOL_VERSION, type }, DIRECTION.TO_EXT);
		return checked.ok || checked.error !== "type: not allowed in this direction";
	});
	assert.deepEqual(toExt.sort(), [MSG.ATTENTION, MSG.CHALLENGE, MSG.JOB_CANCEL, MSG.JOB_START, MSG.PING, MSG.PONG, MSG.READY].sort());
	// A job.start says "auto" or "isolated" and holds exactly these fields.
	assert.deepEqual(validateMessage(JOB_START, DIRECTION.TO_EXT), { ok: true });
	assert.deepEqual(validateMessage({ ...JOB_START, session: "isolated" }, DIRECTION.TO_EXT), { ok: true });
	assert.deepEqual(Object.keys(JOB_START).sort(), ["extract", "files", "job", "kind", "session", "type", "url", "v", "wait"]);
});

test("a frame of another protocol version: terminal only from a daemon that proved itself", async () => {
	// Before any proof: whoever sent it may be anybody.
	const fake = await scriptedDaemon(async (conn) => {
		await conn.next();
		conn.send({ v: PROTOCOL_VERSION + 1, type: MSG.CHALLENGE });
	});
	const first = makeLink({ port: fake.port, key: randomBytes(32) });
	try {
		first.link.start();
		await phaseIs(first.link, PHASE.UNVERIFIED);
		assert.equal(first.link.status().reason, "unverified_protocol_version");
		await until(() => first.sockets.dials >= 2, { timeoutMs: 3000, what: "a retry" });
		assert.equal(first.settings.keyWrites, 0);
	} finally {
		await first.link.stop();
		await fake.stop();
	}
	// On a link that is up, from the verified daemon.
	await upAgainstScripted(async ({ link, conn, sockets }) => {
		conn.send({ v: PROTOCOL_VERSION + 1, type: MSG.PING, t: 1 });
		await phaseIs(link, PHASE.PROTOCOL_VERSION);
		await sleep(300);
		assert.equal(sockets.dials, 1);
	});
});

// A daemon of another protocol version proves itself in its challenge, which
// states its version. The proof is checked first; the versions are compared after.
test("a daemon of another protocol version: recognised by its proof, version mismatch, terminal - no auth frame, the key is kept", async () => {
	for (const version of [PROTOCOL_VERSION + 1, PROTOCOL_VERSION + 2, 99]) {
		const key = randomBytes(32);
		const other = await scriptedDaemon(async (conn) => {
			await conn.challenge(key, { version });
		});
		const { link, sockets, settings, events, sink } = makeLink({ port: other.port, key });
		try {
			link.start();
			await phaseIs(link, PHASE.PROTOCOL_VERSION);
			const status = link.status();
			assert.ok(TERMINAL_PHASES.includes(status.phase));
			assert.equal(status.reason, "protocol_version");
			assert.equal(status.lastError, `Version mismatch: this extension speaks protocol version ${PROTOCOL_VERSION} and the daemon another one. Update the daemon and the extension to the same release.`);
			assert.doesNotMatch(String(status.lastError), /[Pp]air again/);
			assert.equal(status.retryAt, null);
			assert.equal(status.paired, true, "the pairing stays");
			// It stays there: no retry loop.
			await sleep(400);
			assert.equal(sockets.dials, 1, `v=${version}: one attempt, nothing after`);
			assert.equal(link.status().phase, PHASE.PROTOCOL_VERSION);
			// The daemon knows from the hello. No auth frame went out: neither a proof of this
			// side nor its state reached a daemon it cannot work with.
			await other.conns[0].closed;
			assert.deepEqual(other.conns[0].received.map((f) => [f.v, f.type]), [[PROTOCOL_VERSION, MSG.HELLO]]);
			assert.deepEqual(events, [], "the link was never up");
			assert.equal(link.isReady(), false);
			assert.equal(settings.key, key);
			assert.equal(settings.keyWrites, 0);
			assert.deepEqual(sink.entries.filter((e) => e.event === "link.protocol_version").map((e) => e.fields), [{ verified: true }]);
			assert.equal(sink.count("link.unverified"), 0);
			assert.equal(sink.text().includes(b64urlEncode(key)), false);

			// The operator updates and presses "reconnect": that ends it. (Here the daemon is still the other one.)
			await link.reconnect();
			await phaseIs(link, PHASE.PROTOCOL_VERSION);
			assert.equal(sockets.dials, 2);
			assert.equal(settings.keyWrites, 0);
		} finally {
			await link.stop();
			await other.stop();
		}
	}
});

test("pairing with a daemon of another protocol version: one clear error, the code is not answered, a stored key stays", async () => {
	const stored = randomBytes(32);
	const other = await scriptedDaemon(async (conn) => {
		// It holds the code it printed and, for auth mode, the key of the earlier pairing.
		await conn.challenge((hello) => (hello.mode === "pair" ? pairingKey(code) : stored), { version: PROTOCOL_VERSION + 1 });
	});
	const code = `bgw1.${other.port}.${b64urlEncode(randomBytes(32))}`;
	// Without a key from before.
	const fresh = makeLink({ port: 1 });
	// With one: the failed pairing must leave it alone.
	const paired = makeLink({ port: other.port, key: stored });
	try {
		fresh.link.start();
		const result = await fresh.link.pair(code);
		assert.deepEqual(result, { ok: false, error: `Daemon and extension speak different protocol versions (this extension: ${PROTOCOL_VERSION}).` });
		assert.equal(fresh.link.status().phase, PHASE.UNPAIRED);
		assert.equal(fresh.settings.key, null);
		assert.equal(fresh.settings.keyWrites, 0);
		assert.equal(fresh.sockets.dials, 1);
		for (const conn of other.conns) assert.deepEqual(conn.received.map((f) => f.type), [MSG.HELLO], "no auth frame: the code was not answered, the daemon can still take it");
		await sleep(200);
		assert.equal(fresh.sockets.dials, 1, "never repeated by itself");

		paired.link.start();
		await phaseIs(paired.link, PHASE.PROTOCOL_VERSION);
		const again = await paired.link.pair(code);
		assert.equal(again.ok, false);
		assert.match(/** @type {{ error: string }} */ (again).error, /different protocol versions/);
		assert.equal(paired.settings.key, stored);
		assert.equal(paired.settings.keyWrites, 0);
		// Back to the stored key, which meets the same daemon: version mismatch again, not "pair again".
		await phaseIs(paired.link, PHASE.PROTOCOL_VERSION);
		for (const conn of other.conns) assert.ok(conn.received.every((f) => f.type === MSG.HELLO));
	} finally {
		await fresh.link.stop();
		await paired.link.stop();
		await other.stop();
	}
});

test("another version stated without the right proof: \"daemon not verified\", retried late, the key kept, never terminal", async () => {
	const key = randomBytes(32);
	const later = PROTOCOL_VERSION + 1;
	/** @type {[string, (conn: import("../helpers/ext-fakes.js").FakeDaemonConn) => Promise<unknown>][]} */
	const cases = [
		["a proof under another key", (c) => c.challenge(randomBytes(32), { version: later })],
		// The daemon is of this version and something on the way rewrote the version in its challenge.
		["a challenge whose version was changed after the proof was made", (c) => c.challenge(key, { version: later, macVersionS: PROTOCOL_VERSION })],
		// Something rewrote the version in the hello on its way to a daemon of this version, and the daemon answered that.
		["a proof for a hello of another version than was sent", (c) => c.challenge(key, { version: later, macVersionC: later })],
		["a proof for another port", (c) => c.challenge(key, { version: later, port: 1 })],
		["a version from before the handshake core", (c) => c.challenge(key, { version: HANDSHAKE_CORE_SINCE - 1 })],
		["the right proof in a frame that is not the challenge of the handshake core", (c) => c.challenge(key, { version: later, extra: { port: 8791 } })],
	];
	for (const [name, answer] of cases) {
		const fake = await scriptedDaemon(async (conn) => {
			await answer(conn);
		});
		const { link, sockets, settings, events, sink } = makeLink({ port: fake.port, key });
		try {
			link.start();
			await phaseIs(link, PHASE.UNVERIFIED);
			const status = link.status();
			assert.equal(status.reason, "unverified_protocol_version", name);
			assert.match(String(status.lastError), /^Daemon not verified: .* reports another protocol version, but did not prove that it is the daemon\./, name);
			assert.match(String(status.lastError), /key is kept/, name);
			assert.match(String(status.lastError), /update both to the same release/, name);
			assert.doesNotMatch(String(status.lastError), /pair again/, name);
			assert.ok(status.retryAt !== null, name);
			assert.equal(TERMINAL_PHASES.includes(status.phase), false, name);
			await until(() => sockets.dials >= 3, { timeoutMs: 4000, what: `${name}: further attempts` });
			await phaseIs(link, PHASE.UNVERIFIED);
			for (const conn of fake.conns) assert.ok(conn.received.every((f) => f.type === MSG.HELLO), `${name}: no auth frame`);
			assert.ok(sink.entries.filter((e) => e.event === "link.protocol_version").every((e) => e.fields.verified === false), name);
			assert.deepEqual(events, [], name);
			assert.equal(settings.key, key, name);
			assert.equal(settings.keyWrites, 0, name);
		} finally {
			await link.stop();
			await fake.stop();
		}
	}
});

test("a version mismatch cannot be hidden: a challenge that states this version over a proof made for another is a wrong proof", async () => {
	const key = randomBytes(32);
	// A daemon of a later version behind something that rewrites the version numbers both ways, so
	// that each side sees its own: what the daemon proved is not what this side reckons with.
	for (const opts of [{ macVersionS: PROTOCOL_VERSION + 1 }, { macVersionC: PROTOCOL_VERSION + 1 }, { macVersionC: PROTOCOL_VERSION + 1, macVersionS: PROTOCOL_VERSION + 1 }]) {
		const fake = await scriptedDaemon(async (conn) => {
			await conn.challenge(key, opts);
		});
		const { link, settings, events } = makeLink({ port: fake.port, key });
		try {
			link.start();
			await phaseIs(link, PHASE.UNVERIFIED);
			assert.equal(link.status().reason, "daemon_unverified", JSON.stringify(opts));
			assert.match(String(link.status().lastError), /wrong proof/);
			await fake.conns[0].closed;
			assert.deepEqual(fake.conns[0].received.map((f) => f.type), [MSG.HELLO], "no auth frame");
			assert.deepEqual(events, []);
			assert.equal(settings.keyWrites, 0);
		} finally {
			await link.stop();
			await fake.stop();
		}
	}
});

test("job frames before the handshake is through close the link", async () => {
	const fake = await scriptedDaemon(async (conn) => {
		await conn.next();
		conn.send(JOB_START);
	});
	const { link, messages, events } = makeLink({ port: fake.port, key: randomBytes(32) });
	try {
		link.start();
		await until(() => fake.conns.length > 0 && fake.conns[0].closedWith !== null);
		assert.equal(fake.conns[0].closedWith?.code, 4400);
		assert.deepEqual(messages, []);
		assert.deepEqual(events, []);
	} finally {
		await link.stop();
		await fake.stop();
	}
});

test("a peer that takes the connection and says nothing is dropped at the handshake timeout - and is no daemon: not verified, the key kept, the next attempt late", async () => {
	/** @type {number[]} */
	const at = [];
	const fake = await scriptedDaemon(() => {
		at.push(Date.now());
	});
	const key = randomBytes(32);
	// The ordinary delay would bring the next attempt within 20 ms; a peer that proved nothing waits 400 ms and more.
	const { link, settings, sink, sockets } = makeLink({ port: fake.port, key, tuning: { handshakeTimeoutMs: 150, baseMs: 10, capMs: 20, unverifiedBaseMs: 400, unverifiedCapMs: 1600 } });
	try {
		link.start();
		await phaseIs(link, PHASE.UNVERIFIED);
		const status = link.status();
		assert.equal(status.reason, "unverified_silent");
		assert.match(String(status.lastError), /^Daemon not verified: the program on port \d+ took the connection and then said nothing, but did not prove that it is the daemon\. The stored key is kept/);
		assert.ok(status.retryAt !== null && status.retryAt - Date.now() > 250, "the long delay, not the ordinary one");
		assert.deepEqual(sink.entries.filter((e) => e.event === "link.unverified").map((e) => e.fields), [{ code: null, claim: "silent" }]);
		await sleep(200);
		assert.equal(sockets.dials, 1, "no second attempt within the ordinary delay");
		await until(() => at.length >= 3, { timeoutMs: 5000, what: "further attempts" });
		assert.ok(at[2] - at[1] > at[1] - at[0], `later and later: ${at.join(", ")}`);
		// Nothing but the hello went out, and the key is where it was.
		assert.deepEqual(fake.conns[0].received.map((f) => f.type), [MSG.HELLO]);
		assert.equal(settings.key, key);
		assert.equal(settings.keyWrites, 0);
	} finally {
		await link.stop();
		await fake.stop();
	}
});

test("a peer that answers the hello with what the daemon never sends is no daemon either: not verified, the key kept, the next attempt late", async () => {
	const key = randomBytes(32);
	/** @type {[string, (conn: import("../helpers/ext-fakes.js").FakeDaemonConn) => void][]} */
	const cases = [
		["no json", (c) => c.sendRaw("HTTP/1.1 400 Bad Request")],
		["a binary frame", (c) => c.sendRaw(Buffer.from([1, 2, 3]), true)],
		["a frame of this protocol that is no challenge", (c) => c.send(JOB_START)],
		["a challenge with a member too many", (c) => c.send({ ...makeMessage(MSG.CHALLENGE, { instance: "x", nonce_s: "A".repeat(43), mac_s: "A".repeat(43) }), token: "?" })],
		["more than a challenge can be", (c) => c.sendRaw(" ".repeat(5000))],
	];
	for (const [name, answer] of cases) {
		const fake = await scriptedDaemon(async (conn) => {
			await conn.next();
			answer(conn);
		});
		const { link, settings, sink, sockets, events } = makeLink({ port: fake.port, key, tuning: { baseMs: 10, capMs: 20, unverifiedBaseMs: 400, unverifiedCapMs: 1600 } });
		try {
			link.start();
			await phaseIs(link, PHASE.UNVERIFIED);
			assert.equal(link.status().reason, "unverified_garbage", name);
			assert.match(String(link.status().lastError), /sent something the daemon never sends, but did not prove that it is the daemon/, name);
			assert.equal((await fake.conns[0].closed).code, 4400, name);
			assert.equal(sink.count("link.bad_frame"), 1, name);
			await sleep(200);
			assert.equal(sockets.dials, 1, `${name}: no second attempt within the ordinary delay`);
			assert.deepEqual(fake.conns[0].received.map((f) => f.type), [MSG.HELLO], name);
			assert.deepEqual(events, [], name);
			assert.equal(settings.keyWrites, 0, name);
			assert.equal(sink.text().includes(b64urlEncode(key)), false, name);
		} finally {
			await link.stop();
			await fake.stop();
		}
	}
});

test("a daemon that proved itself and then sends a bad frame is still the daemon: tried again soon, as before", async () => {
	const key = randomBytes(32);
	const fake = await scriptedDaemon(async (conn) => {
		await conn.prove(key);
		conn.send({ v: PROTOCOL_VERSION, type: MSG.READY, limits: "none" });
	});
	const { link, sockets } = makeLink({ port: fake.port, key, tuning: { unverifiedBaseMs: 60000 } });
	try {
		link.start();
		await until(() => sockets.dials >= 3, { timeoutMs: 4000, what: "retries at the ordinary pace" });
		await until(() => link.status().phase === PHASE.WAITING, { timeoutMs: 4000, what: "the pause before the next attempt" });
		assert.equal(link.status().reason, "bad_frame");
	} finally {
		await link.stop();
		await fake.stop();
	}
});

test("a frame that cannot be the daemon's ends the connection the moment it arrives, not when its turn comes: nothing made from the key is sent after it", async () => {
	const key = randomBytes(32);
	// A right challenge, and behind it - before this side can have answered - a frame no daemon sends at that point.
	/** @type {[string, (conn: import("../helpers/ext-fakes.js").FakeDaemonConn) => void][]} */
	const cases = [
		["too long for any frame", (c) => c.sendRaw(JSON.stringify({ ...JOB_START, url: "https://example.com/" + "a".repeat(70000) }))],
		["too long for a frame of the handshake", (c) => c.sendRaw(JSON.stringify(JOB_START) + " ".repeat(5000))],
		["no text", (c) => c.sendRaw(Buffer.alloc(16), true)],
	];
	for (const [name, behind] of cases) {
		const fake = await scriptedDaemon(async (conn) => {
			// Both frames are on their way before the extension has worked out the first.
			const hello = await conn.next();
			conn.send(await challengeFor(key, hello, fake.port));
			behind(conn);
		});
		// One attempt is looked at: the next one is far off.
		const { link, sink, events } = makeLink({ port: fake.port, key, tuning: { unverifiedBaseMs: 30000, unverifiedCapMs: 30000 } });
		try {
			link.start();
			await until(() => fake.conns.length > 0 && fake.conns[0].closedWith !== null, { timeoutMs: 3000, what: `${name}: the connection to end` });
			assert.equal(fake.conns[0].closedWith?.code, 4400, name);
			await sleep(100);
			assert.deepEqual(fake.conns[0].received.map((f) => f.type), [MSG.HELLO], `${name}: no auth frame`);
			assert.deepEqual(sink.entries.filter((e) => e.event === "link.bad_frame").map((e) => e.fields), [{ step: "challenge", what: name === "no text" ? "not a text frame" : "frame too large" }], name);
			assert.deepEqual(events, [], name);
			assert.equal(link.status().reason, "unverified_garbage", name);
		} finally {
			await link.stop();
			await fake.stop();
		}
	}
});

test("a challenge of the usual size, whitespace and all, is read as ever; one padded beyond anything a challenge can be is not read at all", async () => {
	const key = randomBytes(32);
	for (const [pad, up] of /** @type {[number, boolean][]} */ ([[200, true], [3000, true], [5000, false]])) {
		const fake = await scriptedDaemon(async (conn) => {
			const hello = await conn.next();
			conn.sendRaw(JSON.stringify(await challengeFor(key, hello, fake.port)) + " ".repeat(pad));
			if (!up) return;
			await conn.next();
			conn.send(makeMessage(MSG.READY, { limits: { max_result_bytes: 8388608, ping_s: 20 } }));
		});
		const { link } = makeLink({ port: fake.port, key });
		try {
			link.start();
			await phaseIs(link, up ? PHASE.READY : PHASE.UNVERIFIED);
			if (!up) assert.deepEqual(fake.conns[0].received.map((f) => f.type), [MSG.HELLO], "a right proof in a frame that is not read counts for nothing");
		} finally {
			await link.stop();
			await fake.stop();
		}
	}
});

test("outbound frames are validated: an invalid one is not sent", async () => {
	await upAgainstScripted(async ({ link, conn, sink }) => {
		assert.equal(link.send(makeMessage(MSG.JOB_PROGRESS, { job: "j_1", phase: "navigating", http_status: null })), true);
		assert.equal((await conn.next()).type, MSG.JOB_PROGRESS);
		assert.equal(link.send(makeMessage(MSG.JOB_PROGRESS, { job: "j_1", phase: "clicking", http_status: null })), false);
		assert.equal(link.send({ v: PROTOCOL_VERSION, type: MSG.JOB_START }), false, "a frame only the daemon may send");
		assert.equal(sink.count("link.invalid_outbound"), 2);
		conn.send(makeMessage(MSG.PING, { t: 1 }));
		assert.equal((await conn.next()).type, MSG.PONG, "nothing else went out in between");
	});
});

test("send before ready returns false", async () => {
	const { link } = makeLink({ port: 1 });
	assert.equal(link.send(makeMessage(MSG.PING, { t: 1 })), false);
});

test("a daemon that goes silent is dropped by the watchdog", async () => {
	await upAgainstScripted(
		async ({ link, events }) => {
			// ping_s = 1: silence for more than 2.5 s counts as a dead link.
			await until(() => events.includes("down"), { timeoutMs: 6000, what: "the watchdog" });
			assert.equal(link.status().reason, "lost");
		},
		{ pingS: 1 },
	);
});

test("forget drops the key and the link", async () => {
	const d = await pairedDaemon();
	const { link, settings, events } = makeLink({ port: d.daemon.port, key: d.key });
	try {
		link.start();
		await phaseIs(link, PHASE.READY);
		await link.forget();
		assert.equal(settings.key, null);
		assert.equal(link.status().phase, PHASE.UNPAIRED);
		assert.deepEqual(events, ["ready", "down"]);
		await until(async () => (await daemonStatus(d.daemon)).extension.connected === false);
	} finally {
		await link.stop();
		await d.stop();
	}
});

test("the stored key decodes to what was set", () => {
	const key = randomBytes(32);
	assert.deepEqual(b64urlDecode(b64urlEncode(key)), key);
});

test("the pieces of a file go over the link like any frame, and a ping that arrives between them is answered before the last one", async () => {
	await upAgainstScripted(async ({ link, conn }) => {
		const piece = Buffer.alloc(LIMITS.BLOB_CHUNK_BYTES, 0x61).toString("base64");
		// The way the job runner sends: one piece, then the event loop gets its turn.
		const sending = (async () => {
			for (let seq = 0; seq < 30; seq++) {
				assert.equal(link.send(makeMessage(MSG.JOB_BLOB, { job: "j_1", seq, offset: seq * LIMITS.BLOB_CHUNK_BYTES, data: piece })), true);
				await sleep(0);
			}
		})();
		conn.send(makeMessage(MSG.PING, { t: 777 }));
		await sending;
		const frames = [];
		for (let i = 0; i < 31; i++) frames.push(await conn.next());
		const pongAt = frames.findIndex((f) => f.type === MSG.PONG);
		assert.ok(pongAt !== -1 && pongAt < 30, `the pong came after ${pongAt} pieces, not after all thirty`);
		assert.deepEqual(frames[pongAt], makeMessage(MSG.PONG, { t: 777 }));
		assert.deepEqual(frames.filter((f) => f.type === MSG.JOB_BLOB).map((f) => f.seq), Array.from({ length: 30 }, (_, i) => i), "every piece, in order");
		// A frame that is not what the protocol allows never leaves: one byte too many in a piece.
		assert.equal(link.send(makeMessage(MSG.JOB_BLOB, { job: "j_1", seq: 30, offset: 0, data: piece + "QUJD" })), false);
		assert.equal(link.send(makeMessage(MSG.JOB_BLOB, { job: "j_1", seq: 0, offset: 0, data: "not base64!" })), false);
	});
});

test("backlog: what the socket still holds, where it can say; 0 where it cannot, and when no link is up", async () => {
	const key = randomBytes(32);
	const fake = await scriptedDaemon(async (conn) => {
		await conn.handshake(key);
	});
	let held = 123456;
	const base = socketFactory();
	const settings = memorySettings({ port: fake.port, key });
	const link = new Link({
		createSocket: (url) => Object.assign(base.create(url), { buffered: () => held }),
		settings,
		getState: () => defaultState(),
		identity: { extVersion: "0.1.0", browser: { name: "TestFox", version: "1.2" } },
		handlers: { onReady: () => {}, onDown: () => {}, onMessage: () => {}, onStatus: () => {} },
		log: logSink().log,
		random: () => 0.5,
		tuning: FAST,
	});
	try {
		assert.equal(link.backlog(), 0, "nothing is up yet");
		link.start();
		await phaseIs(link, PHASE.READY);
		assert.equal(link.backlog(), 123456);
		held = 0;
		assert.equal(link.backlog(), 0);
		held = Number.NaN;
		assert.equal(link.backlog(), 0);
		await link.stop();
		held = 999;
		assert.equal(link.backlog(), 0, "a link that is down holds nothing");
	} finally {
		await link.stop();
		await fake.stop();
	}
	// A socket that cannot say: never held back.
	await upAgainstScripted(async ({ link: plain }) => {
		assert.equal(plain.backlog(), 0);
	});
});
