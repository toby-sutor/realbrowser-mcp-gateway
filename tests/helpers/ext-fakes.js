// Stand-ins for the browser, so the extension's background modules can be
// unit-tested under Node. The modules take everything they use as arguments.

import { WebSocket, WebSocketServer } from "ws";
import { b64urlEncode, computeMacC, computeMacS, macMatches, randomBytes, randomNonce } from "../../extension/shared/auth.js";
import { MSG, PROTOCOL_VERSION, makeMessage } from "../../extension/shared/protocol.js";
import { FAKE_ORIGIN } from "./fake-extension.js";

/**
 * createSocket for the Link, on top of the ws package. Counts the dials.
 * @param {{ origin?: string }} [opts]
 */
export function socketFactory(opts = {}) {
	/** @type {{ dials: number, urls: string[], create: (url: string) => import("../../extension/background/link.js").SocketLike }} */
	const factory = {
		dials: 0,
		urls: [],
		create: (url) => {
			factory.dials += 1;
			factory.urls.push(url);
			const ws = new WebSocket(url, { origin: opts.origin ?? FAKE_ORIGIN, perMessageDeflate: false });
			/** @type {import("../../extension/background/link.js").SocketLike} */
			const sock = {
				send: (data) => ws.send(data),
				close: (code, reason) => {
					// Like a browser: closing a socket that never opened just ends it.
					if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
					else ws.close(code, reason);
				},
				onopen: null,
				onmessage: null,
				onclose: null,
			};
			ws.on("open", () => sock.onopen?.());
			ws.on("message", (data, isBinary) => sock.onmessage?.({ data: isBinary ? data : data.toString() }));
			ws.on("close", (code) => sock.onclose?.({ code }));
			ws.on("error", () => {});
			return sock;
		},
	};
	return factory;
}

/**
 * The settings object the Link works with, kept in memory.
 * @param {{ port: number, key?: import("../../extension/shared/auth.js").Bytes | null }} init
 */
export function memorySettings(init) {
	const s = {
		port: init.port,
		/** @type {import("../../extension/shared/auth.js").Bytes | null} */
		key: init.key ?? null,
		/** How often the stored key was replaced or removed. */
		keyWrites: 0,
		/** @param {import("../../extension/shared/auth.js").Bytes} key */
		setKey: async (key) => {
			s.keyWrites += 1;
			s.key = key;
		},
		clearKey: async () => {
			s.keyWrites += 1;
			s.key = null;
		},
		/** @param {number} port */
		setPort: async (port) => {
			s.port = port;
		},
	};
	return s;
}

/** A log sink that keeps what it is given, to check that no secret ever gets there. */
export function logSink() {
	/** @type {{ event: string, fields: Record<string, unknown> }[]} */
	const entries = [];
	return {
		entries,
		/** @param {string} event @param {Record<string, unknown>} [fields] */
		log: (event, fields = {}) => {
			entries.push({ event, fields });
		},
		/** @param {string} event */
		count: (event) => entries.filter((e) => e.event === event).length,
		text: () => JSON.stringify(entries),
	};
}

/**
 * A scripted daemon: a WebSocket server on an ephemeral loopback port whose
 * behaviour per connection is up to the test.
 * @param {(conn: FakeDaemonConn) => void | Promise<void>} onConnection
 * @param {{ port?: number }} [opts] port: take this loopback port instead of any free one
 */
export async function scriptedDaemon(onConnection, opts = {}) {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: opts.port ?? 0, perMessageDeflate: false });
	await new Promise((resolve) => wss.once("listening", resolve));
	const addr = wss.address();
	if (addr === null || typeof addr === "string") throw new Error("no port");
	/** @type {FakeDaemonConn[]} */
	const conns = [];
	wss.on("connection", (ws) => {
		const conn = new FakeDaemonConn(ws, addr.port);
		conns.push(conn);
		Promise.resolve(onConnection(conn)).catch(() => {});
	});
	return {
		port: addr.port,
		conns,
		stop: async () => {
			for (const ws of wss.clients) ws.terminate();
			await new Promise((resolve) => wss.close(() => resolve(undefined)));
		},
	};
}

/**
 * A go-between: it listens on a port of its own and passes whatever an
 * extension sends there on to a daemon that listens elsewhere - over a socket
 * it opens with the Host and Origin that daemon expects - and the daemon's
 * answers back. It can also add frames of its own behind the challenge, the
 * way a process would that wants to pass for the daemon from then on.
 * @param {number} target the port of the daemon
 * @param {{ afterChallenge?: Record<string, unknown>[] }} [opts] afterChallenge: frames it sends the extension itself, right behind the daemon's challenge
 */
export async function relayTo(target, opts = {}) {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
	await new Promise((resolve) => wss.once("listening", resolve));
	const addr = wss.address();
	if (addr === null || typeof addr === "string") throw new Error("no port");
	/** @type {Record<string, any>[]} what the extension sent, oldest first; all of it was passed on */
	const fromExt = [];
	/** @type {Record<string, any>[]} what the daemon answered, oldest first; all of it was passed back */
	const fromDaemon = [];
	/** @type {number[]} close codes of the daemon's side */
	const daemonCloses = [];
	/** @type {Set<WebSocket>} */
	const ups = new Set();
	/** @param {number} code a close code as received @returns {number} one that may be sent */
	const sendable = (code) => (code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011);
	wss.on("connection", (down) => {
		const up = new WebSocket(`ws://127.0.0.1:${target}/ext`, { origin: FAKE_ORIGIN, perMessageDeflate: false });
		ups.add(up);
		/** @type {string[]} */
		const early = [];
		down.on("message", (data) => {
			const text = data.toString();
			fromExt.push(JSON.parse(text));
			if (up.readyState === WebSocket.OPEN) up.send(text);
			else early.push(text);
		});
		up.on("open", () => {
			for (const text of early.splice(0)) up.send(text);
		});
		up.on("message", (data) => {
			const text = data.toString();
			const frame = JSON.parse(text);
			fromDaemon.push(frame);
			if (down.readyState !== WebSocket.OPEN) return;
			down.send(text);
			if (frame.type === MSG.CHALLENGE) for (const own of opts.afterChallenge ?? []) down.send(JSON.stringify(own));
		});
		up.on("close", (code) => {
			ups.delete(up);
			daemonCloses.push(code);
			if (down.readyState === WebSocket.OPEN) down.close(sendable(code));
		});
		down.on("close", () => up.terminate());
		up.on("error", () => {});
		down.on("error", () => {});
	});
	return {
		port: addr.port,
		fromExt,
		fromDaemon,
		daemonCloses,
		stop: async () => {
			for (const ws of wss.clients) ws.terminate();
			for (const up of ups) up.terminate();
			await new Promise((resolve) => wss.close(() => resolve(undefined)));
		},
	};
}

/**
 * The challenge a daemon that holds the key answers a hello with, as a frame.
 * @param {import("../../extension/shared/auth.js").Bytes} key
 * @param {Record<string, any>} hello the extension's hello
 * @param {number} port the port the extension dialled
 * @returns {Promise<Record<string, unknown>>}
 */
export async function challengeFor(key, hello, port) {
	const instance = "fake-instance";
	const nonceS = randomNonce();
	const transcript = { mode: hello.mode, port, versionC: hello.v, versionS: PROTOCOL_VERSION, instance, nonceC: hello.nonce_c, nonceS };
	return makeMessage(MSG.CHALLENGE, { instance, nonce_s: nonceS, mac_s: b64urlEncode(await computeMacS(key, transcript)) });
}

export class FakeDaemonConn {
	/** @type {Record<string, any>[]} frames from the extension, oldest first */
	received = [];
	/** @type {{ code: number } | null} */
	closedWith = null;
	#ws;
	/** The port this scripted daemon listens on: what its proofs name unless a test says otherwise. */
	#port;
	/** @type {((frame: Record<string, any>) => void)[]} */
	#waiters = [];
	/** @type {Record<string, any>[]} */
	#inbox = [];
	/** @type {Promise<{ code: number }>} */
	closed;

	/** @param {WebSocket} ws @param {number} port */
	constructor(ws, port) {
		this.#ws = ws;
		this.#port = port;
		ws.on("message", (data) => {
			const frame = JSON.parse(data.toString());
			this.received.push(frame);
			const waiter = this.#waiters.shift();
			if (waiter) waiter(frame);
			else this.#inbox.push(frame);
		});
		this.closed = new Promise((resolve) => {
			ws.on("close", (code) => {
				this.closedWith = { code };
				resolve({ code });
			});
		});
	}

	/** @returns {Promise<Record<string, any>>} the next frame from the extension */
	next() {
		const frame = this.#inbox.shift();
		if (frame) return Promise.resolve(frame);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("scripted daemon: no frame from the extension")), 3000);
			this.#waiters.push((f) => {
				clearTimeout(timer);
				resolve(f);
			});
		});
	}

	/** @param {unknown} frame sent as JSON, valid or not */
	send(frame) {
		this.#ws.send(JSON.stringify(frame));
	}

	/** @param {string | Buffer} data @param {boolean} [binary] */
	sendRaw(data, binary = false) {
		this.#ws.send(data, { binary });
	}

	/** @param {number} code */
	close(code) {
		this.#ws.close(code);
	}

	/**
	 * Prove knowledge of the key the way the daemon does and take the
	 * extension's proof - the handshake up to, and without, "ready".
	 * @param {import("../../extension/shared/auth.js").Bytes} key
	 * @param {{ instance?: string, port?: number }} [opts] port: make and check the proofs for this port instead of the one listened on
	 * @returns {Promise<{ hello: Record<string, any>, auth: Record<string, any>, macOk: boolean }>}
	 */
	async prove(key, opts = {}) {
		const { hello, transcript } = await this.challenge(key, opts);
		const auth = await this.next();
		return { hello, auth, macOk: macMatches(await computeMacC(key, transcript), auth.mac_c) };
	}

	/**
	 * Take the hello and answer it with a challenge, as a daemon does - of this
	 * protocol version or, on request, of another, or with one of the things a
	 * proof covers stated differently in the frame than in the proof.
	 * @param {import("../../extension/shared/auth.js").Bytes | ((hello: Record<string, any>) => import("../../extension/shared/auth.js").Bytes)} key
	 *   the key, or how to pick it once the hello is in (a pairing code for pair mode, the stored key for auth mode)
	 * @param {{ instance?: string, port?: number, version?: number, macVersionC?: number, macVersionS?: number, extra?: Record<string, unknown> }} [opts]
	 *   version: the protocol version this daemon speaks, stated in the challenge and covered by the proof;
	 *   macVersionC, macVersionS: what the proof covers instead of the hello's version and of the stated one;
	 *   extra: members added to the challenge frame
	 * @returns {Promise<{ hello: Record<string, any>, transcript: import("../../extension/shared/auth.js").Transcript }>}
	 */
	async challenge(key, opts = {}) {
		const hello = await this.next();
		const k = typeof key === "function" ? key(hello) : key;
		const instance = opts.instance ?? "fake-instance";
		const nonceS = randomNonce();
		const version = opts.version ?? PROTOCOL_VERSION;
		const transcript = {
			mode: hello.mode,
			port: opts.port ?? this.#port,
			versionC: opts.macVersionC ?? hello.v,
			versionS: opts.macVersionS ?? version,
			instance,
			nonceC: hello.nonce_c,
			nonceS,
		};
		this.send({ ...makeMessage(MSG.CHALLENGE, { instance, nonce_s: nonceS, mac_s: b64urlEncode(await computeMacS(k, transcript)) }), ...opts.extra, v: version });
		return { hello, transcript };
	}

	/**
	 * Play the daemon's side of the handshake correctly.
	 * @param {import("../../extension/shared/auth.js").Bytes} key
	 * @param {{ instance?: string, port?: number, pingS?: number }} [opts]
	 * @returns {Promise<{ hello: Record<string, any>, auth: Record<string, any>, macOk: boolean }>}
	 */
	async handshake(key, opts = {}) {
		const proved = await this.prove(key, opts);
		this.send(makeMessage(MSG.READY, { limits: { max_result_bytes: 8388608, ping_s: opts.pingS ?? 20 } }));
		return proved;
	}
}

/**
 * A browser-style event: addListener / removeListener, plus fire() for the test.
 * @template {(...args: any[]) => any} F
 */
export class FakeEvent {
	/** @type {{ fn: F, args: unknown[] }[]} */
	listeners = [];

	/** @param {F} fn @param {...unknown} args filter and extra info, as the browser API takes them */
	addListener(fn, ...args) {
		this.listeners.push({ fn, args });
	}

	/** @param {F} fn */
	removeListener(fn) {
		this.listeners = this.listeners.filter((l) => l.fn !== fn);
	}

	/** @param {F} fn */
	hasListener(fn) {
		return this.listeners.some((l) => l.fn === fn);
	}

	/**
	 * Call every listener; returns what they returned.
	 * @param {Parameters<F>} args
	 * @returns {ReturnType<F>[]}
	 */
	fire(...args) {
		return this.listeners.map((l) => l.fn(...args));
	}
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The part of a test daemon (helpers/daemon.js) the helpers below use.
 * @typedef {object} DaemonLike
 * @property {(method: string, target: string, ro?: { auth?: boolean | "admin", body?: unknown, signal?: AbortSignal }) => Promise<{ status: number, text: string, json: any }>} request
 */

/**
 * GET /v1/status with everything in it: the operator's view (admin token).
 * @param {DaemonLike} daemon
 * @returns {Promise<any>}
 */
export async function daemonStatus(daemon) {
	return (await daemon.request("GET", "/v1/status", { auth: "admin" })).json;
}

/**
 * A fresh one-time pairing code, minted with the admin token. The request
 * carries a nonce, as every caller's must.
 * @param {DaemonLike} daemon
 * @returns {Promise<string>}
 */
export async function daemonPairCode(daemon) {
	const res = await daemon.request("POST", "/v1/pair/start", { auth: "admin", body: { nonce: b64urlEncode(randomBytes(32)) } });
	if (res.status !== 200 || typeof res.json?.code !== "string") throw new Error(`the daemon minted no pairing code (HTTP ${res.status})`);
	return res.json.code;
}

/**
 * POST /v1/jobs: raw job, raw result. The route takes the admin token only.
 * @param {DaemonLike} daemon
 * @param {Record<string, unknown>} job
 * @param {{ signal?: AbortSignal }} [ro]
 */
export function daemonSubmitJob(daemon, job, ro = {}) {
	return daemon.request("POST", "/v1/jobs", { ...ro, auth: "admin", body: job });
}
