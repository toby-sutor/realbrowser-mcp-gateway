import { WebSocket } from "ws";
import {
	b64urlEncode,
	computeMacC,
	computeMacS,
	deriveExtKey,
	macMatches,
	pairingKey,
	parsePairingCode,
	randomNonce,
} from "../../extension/shared/auth.js";
import crypto from "node:crypto";
import { DIRECTION, LIMITS, MSG, PROTOCOL_VERSION, makeMessage, validateMessage, zeroTimings } from "../../extension/shared/protocol.js";

/**
 * @typedef {import("../../extension/shared/auth.js").Bytes} Bytes
 * @typedef {import("../../extension/shared/protocol.js").ExtState} ExtState
 * @typedef {import("../../extension/shared/protocol.js").JobResultBody} JobResultBody
 * @typedef {Record<string, any>} Frame a decoded frame from the daemon
 */

/**
 * @typedef {object} HandshakeResult
 * @property {boolean} ready the daemon sent "ready"
 * @property {number | null} httpStatus set when the upgrade itself was refused
 * @property {number | null} closeCode set when the daemon closed the socket during the handshake
 * @property {string | null} closeReason
 * @property {boolean | null} serverMacValid did the daemon prove knowledge of the key (null: no challenge seen)
 */

/**
 * Ways to break the handshake on purpose.
 * @typedef {object} HandshakeOptions
 * @property {Bytes} [key] use this key instead of the stored one
 * @property {boolean} [corruptMac] send a wrong mac_c
 * @property {boolean} [ignoreServerMac] carry on even if the daemon's mac_s does not verify
 * @property {number} [version] protocol version to claim in hello
 * @property {string | null} [origin] Origin header; null sends none
 * @property {Record<string, string>} [headers] extra request headers for the upgrade
 * @property {Record<string, unknown>} [helloOverride] fields merged over the hello frame
 * @property {"hello" | "challenge"} [stopAfter] go silent after sending hello, or after receiving the challenge
 * @property {"auth" | "pair"} [macMode] compute both MACs as if for this mode instead of the one in hello
 * @property {string} [macInstance] compute both MACs over this instance id instead of the one in the challenge
 * @property {number} [macPort] compute both MACs over this port instead of the one that was dialled
 * @property {number} [macVersionC] compute both MACs over this version instead of the one the hello stated
 * @property {number} [macVersionS] compute both MACs over this version instead of the one the challenge states
 * @property {number} [dialPort] open the socket on this port instead of the daemon's (something stands in between)
 * @property {(frame: Frame) => void} [onChallenge] look at the challenge before it is answered
 */

export const FAKE_ORIGIN = "moz-extension://0f8c2a3e-5b1d-4c7a-9e6f-112233445566";

/** Raised by waitFor() when the socket closes before the frame arrives. */
export class SocketClosedError extends Error {
	/** @param {string} type the frame type that was awaited */
	constructor(type) {
		super(`fake extension: socket closed while waiting for "${type}"`);
		this.name = "SocketClosedError";
	}
}

/** @returns {ExtState} */
export function defaultState() {
	return {
		paused: false,
		pause_reason: null,
		slots: 1,
		container: { ready: true },
		window: { open: true },
		policy_rev: 1,
		optin_hosts: [],
	};
}

/**
 * A well-formed job.result body for a job.start frame.
 * @param {Frame} start
 * @param {Partial<JobResultBody>} [overrides]
 * @returns {JobResultBody}
 */
export function makeResult(start, overrides = {}) {
	return {
		job: start.job,
		outcome: "ok",
		cookie_scope: "container",
		nav: {
			requested_url: start.url,
			final_url: start.url,
			redirect_origins: [],
			http_status: 200,
			content_type: "text/html",
			body_bytes: null,
		},
		render: { visibility: "visible", raf_hz: 60, settled: true, scrolled_px: 0, scroll: "off", dwell: "off", elapsed_ms: 120, timings: zeroTimings() },
		detect: null,
		error: null,
		page: {
			title: "Fixture page",
			author: null,
			published: null,
			lang: "en",
			site: null,
			word_count: 2,
			extractor: "fake",
		},
		extraction: null,
		content: { markdown: "# Fixture page\n\nhello world", text: null, html: null, raw_html: null, links: [], results: [] },
		truncated: { markdown: false, text: false, html: false, raw_html: false },
		file: null,
		tab_kept_open: false,
		...overrides,
	};
}

/**
 * What the extension sends for a job whose response was a file: the bytes in
 * job.blob frames - full pieces, numbered, each with its offset - and the
 * result that describes them.
 * @param {Frame} start the job.start frame
 * @param {Uint8Array} bytes
 * @param {{ contentType?: string, name?: string | null, charset?: string | null, finalUrl?: string, detect?: JobResultBody["detect"] }} [opts]
 * @returns {{ blobs: Record<string, unknown>[], result: JobResultBody }}
 */
export function fileFrames(start, bytes, opts = {}) {
	/** @type {Record<string, unknown>[]} */
	const blobs = [];
	for (let offset = 0; offset < bytes.length; offset += LIMITS.BLOB_CHUNK_BYTES) {
		blobs.push(makeMessage(MSG.JOB_BLOB, { job: start.job, seq: blobs.length, offset, data: Buffer.from(bytes.subarray(offset, offset + LIMITS.BLOB_CHUNK_BYTES)).toString("base64") }));
	}
	const result = makeResult(start, {
		nav: { requested_url: start.url, final_url: opts.finalUrl ?? start.url, redirect_origins: [], http_status: 200, content_type: opts.contentType ?? "application/pdf", body_bytes: bytes.length },
		render: { visibility: null, raf_hz: null, settled: false, scrolled_px: 0, scroll: "off", dwell: "off", elapsed_ms: 80, timings: zeroTimings() },
		detect: opts.detect ?? null,
		page: null,
		extraction: null,
		content: null,
		file: { name: opts.name ?? null, charset: opts.charset ?? null, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), chunks: blobs.length },
	});
	return { blobs, result };
}

/**
 * Plays the extension side of the wire protocol against a daemon, with the
 * same shared modules the real extension uses. By default it behaves: it
 * verifies the daemon's proof, answers pings and completes every job with an
 * ok result. Tests switch individual behaviours off or replace them.
 */
export class FakeExtension {
	/** @type {WebSocket | null} */
	ws = null;
	/** @type {Bytes | null} long-lived key, set by a successful pair() */
	key = null;
	/** @type {ExtState} */
	state;
	/** @type {Frame[]} every frame received, oldest first */
	received = [];
	/** @type {Frame[]} every job.start received */
	jobs = [];
	/** @type {Record<string, unknown>[]} every frame sent with send(), oldest first */
	sent = [];
	/** @type {string[]} violations of the protocol by the daemon, as seen by the shared validator */
	invalidFrames = [];
	/** Answer the daemon's pings. */
	autoPong = true;
	/**
	 * Called for every job.start. Return a result body to send it, or null to
	 * stay silent (the test answers by hand, or never).
	 * @type {(start: Frame, ext: FakeExtension) => JobResultBody | null | Promise<JobResultBody | null>}
	 */
	onJob = (start) => makeResult(start);
	/** @type {Promise<{ code: number, reason: string }>} resolves when the current socket closes */
	closed = Promise.resolve({ code: 1005, reason: "" });

	#port;
	#origin;
	#extVersion;
	#browser;
	/** @type {Frame[]} */
	#inbox = [];
	/** @type {{ type: string, match: (frame: Frame) => boolean, resolve: (frame: Frame) => void, reject: (err: Error) => void }[]} */
	#waiters = [];

	/**
	 * @param {object} opts
	 * @param {number} opts.port
	 * @param {string} [opts.origin]
	 * @param {string} [opts.extVersion]
	 * @param {{ name: string, version: string }} [opts.browser]
	 * @param {Partial<ExtState>} [opts.state]
	 */
	constructor({ port, origin = FAKE_ORIGIN, extVersion = "0.0.0-test", browser = { name: "Waterfox", version: "6.7.5" }, state }) {
		this.#port = port;
		this.#origin = origin;
		this.#extVersion = extVersion;
		this.#browser = browser;
		this.state = { ...defaultState(), ...state };
	}

	get connected() {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}

	/**
	 * Pair with a one-time code. On success the derived key is kept in this.key.
	 * @param {string} code
	 * @param {HandshakeOptions} [opts]
	 * @returns {Promise<HandshakeResult>}
	 */
	async pair(code, opts = {}) {
		const parsed = parsePairingCode(code);
		if (!parsed.ok) throw new Error(`not a pairing code: ${parsed.error}`);
		return this.#handshake("pair", opts.key ?? pairingKey(parsed.code), opts);
	}

	/**
	 * Connect in auth mode with the stored key.
	 * @param {HandshakeOptions} [opts]
	 * @returns {Promise<HandshakeResult>}
	 */
	async connect(opts = {}) {
		const key = opts.key ?? this.key;
		if (key === null) throw new Error("no key: pair first or pass opts.key");
		return this.#handshake("auth", key, opts);
	}

	/**
	 * Send a frame object as JSON.
	 * @param {Record<string, unknown>} frame
	 */
	send(frame) {
		this.sent.push(frame);
		this.sendRaw(JSON.stringify(frame));
	}

	/**
	 * Send anything, well-formed or not.
	 * @param {string | Buffer} data
	 * @param {{ binary?: boolean }} [opts]
	 */
	sendRaw(data, opts = {}) {
		if (this.ws === null) throw new Error("not connected");
		this.ws.send(data, { binary: opts.binary ?? false });
	}

	/**
	 * Report an event together with the current (optionally changed) state.
	 * @param {string} name
	 * @param {{ host?: string | null, job?: string | null, state?: Partial<ExtState>, detect?: JobResultBody["detect"] }} [opts]
	 */
	sendEvent(name, opts = {}) {
		this.state = { ...this.state, ...opts.state };
		this.send(makeMessage(MSG.EVENT, { name, host: opts.host ?? null, job: opts.job ?? null, state: this.state, detect: opts.detect ?? null }));
	}

	/**
	 * Park a job the way the extension does: its page shows a challenge that
	 * waits for the operator. The job's one result is still to come.
	 * @param {Frame} start the job.start frame
	 * @param {Partial<NonNullable<JobResultBody["detect"]>>} [detect]
	 */
	park(start, detect = {}) {
		this.sendEvent("challenge.pending", {
			job: start.job,
			host: new URL(start.url).hostname,
			detect: { kind: "cloudflare_challenge", evidence: "header cf-mitigated=challenge", waited_ms: 8000, resolved: null, ...detect },
		});
	}

	/**
	 * Send a job.result.
	 * @param {JobResultBody} body
	 */
	sendResult(body) {
		this.send(makeMessage(MSG.JOB_RESULT, { ...body }));
	}

	/**
	 * Answer a job with a file: its bytes first, then the result.
	 * @param {Frame} start
	 * @param {Uint8Array} bytes
	 * @param {Parameters<typeof fileFrames>[2]} [opts]
	 */
	sendFile(start, bytes, opts = {}) {
		const { blobs, result } = fileFrames(start, bytes, opts);
		for (const blob of blobs) this.send(blob);
		this.sendResult(result);
	}

	/**
	 * The next frame of a type that no earlier waitFor() consumed. Rejects with
	 * SocketClosedError if the socket closes first, or after the timeout.
	 * @param {string} type
	 * @param {{ match?: (frame: Frame) => boolean, timeoutMs?: number }} [opts]
	 * @returns {Promise<Frame>}
	 */
	waitFor(type, opts = {}) {
		const match = opts.match ?? (() => true);
		const index = this.#inbox.findIndex((f) => f.type === type && match(f));
		if (index !== -1) return Promise.resolve(this.#inbox.splice(index, 1)[0]);
		if (!this.connected) return Promise.reject(new SocketClosedError(type));
		return new Promise((resolve, reject) => {
			const waiter = {
				type,
				match,
				/** @param {Frame} frame */
				resolve: (frame) => {
					clearTimeout(timer);
					resolve(frame);
				},
				/** @param {Error} err */
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			};
			const timer = setTimeout(() => {
				this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
				reject(new Error(`fake extension: no "${type}" frame within ${opts.timeoutMs ?? 3000} ms`));
			}, opts.timeoutMs ?? 3000);
			this.#waiters.push(waiter);
		});
	}

	/**
	 * Close the socket from this side and wait until it is gone.
	 * @param {number} [code]
	 */
	async close(code = 1000) {
		const ws = this.ws;
		if (ws === null || ws.readyState === WebSocket.CLOSED) return;
		ws.close(code);
		await this.closed;
	}

	/** Drop the TCP connection without a close handshake, like a crashed browser. */
	async kill() {
		const ws = this.ws;
		if (ws === null || ws.readyState === WebSocket.CLOSED) return;
		ws.terminate();
		await this.closed;
	}

	/**
	 * @param {"auth" | "pair"} mode
	 * @param {Bytes} key
	 * @param {HandshakeOptions} opts
	 * @returns {Promise<HandshakeResult>}
	 */
	async #handshake(mode, key, opts) {
		if (this.ws !== null && this.ws.readyState !== WebSocket.CLOSED) throw new Error("fake extension: the previous socket is still open");
		/** @type {HandshakeResult} */
		const result = { ready: false, httpStatus: null, closeCode: null, closeReason: null, serverMacValid: null };
		const origin = opts.origin === undefined ? this.#origin : opts.origin;
		const dialled = opts.dialPort ?? this.#port;
		const ws = new WebSocket(`ws://127.0.0.1:${dialled}/ext`, {
			perMessageDeflate: false,
			...(origin === null ? {} : { origin }),
			...(opts.headers === undefined ? {} : { headers: opts.headers }),
		});
		this.ws = ws;
		this.#inbox = [];

		/** @type {Promise<number | null>} null: open, number: HTTP status of a refused upgrade */
		const opened = new Promise((resolve, reject) => {
			ws.once("open", () => resolve(null));
			ws.once("unexpected-response", (_req, res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			ws.once("error", reject);
		});
		this.closed = new Promise((resolve) => {
			ws.once("close", (code, reason) => {
				// Nothing more can arrive: release whoever is still waiting for a frame.
				for (const waiter of this.#waiters.splice(0)) waiter.reject(new SocketClosedError(waiter.type));
				resolve({ code, reason: reason.toString("utf8") });
			});
		});
		ws.on("error", () => {});
		ws.on("message", (data, isBinary) => this.#onFrame(data, isBinary));

		const status = await opened;
		if (status !== null) {
			result.httpStatus = status;
			ws.terminate();
			return result;
		}

		/**
		 * @param {string} type
		 * @returns {Promise<Frame | null>} null when the daemon closed the socket instead
		 */
		const frameOrClose = async (type) => {
			try {
				return await this.waitFor(type);
			} catch (err) {
				if (!(err instanceof SocketClosedError)) throw err;
				const c = await this.closed;
				result.closeCode = c.code;
				result.closeReason = c.reason;
				return null;
			}
		};

		const nonceC = randomNonce();
		this.send({
			...makeMessage(MSG.HELLO, { mode, ext_version: this.#extVersion, browser: this.#browser, nonce_c: nonceC }),
			...(opts.version === undefined ? {} : { v: opts.version }),
			...opts.helloOverride,
		});
		if (opts.stopAfter === "hello") return result;

		const challenge = await frameOrClose(MSG.CHALLENGE);
		if (challenge === null) return result;
		opts.onChallenge?.(challenge);
		// The proof covers the mode this side asked for, the port it dialled, the
		// versions both sides stated and the instance id the daemon just named,
		// so none can be swapped on the way.
		const wellFormed = validateMessage(challenge, DIRECTION.TO_EXT).ok;
		const transcript = {
			mode: opts.macMode ?? mode,
			port: opts.macPort ?? dialled,
			versionC: opts.macVersionC ?? opts.version ?? PROTOCOL_VERSION,
			versionS: opts.macVersionS ?? Number(challenge.v),
			instance: String(opts.macInstance ?? challenge.instance),
			nonceC,
			nonceS: String(challenge.nonce_s),
		};
		result.serverMacValid = wellFormed && macMatches(await computeMacS(key, transcript), challenge.mac_s);
		if (!result.serverMacValid && opts.ignoreServerMac !== true) {
			// A real extension stops here: whoever answered does not know the key,
			// or the challenge was tampered with.
			await this.close();
			return result;
		}
		if (opts.stopAfter === "challenge") return result;
		if (!wellFormed) throw new Error("fake extension: cannot answer a malformed challenge");

		const macC = await computeMacC(key, transcript);
		if (opts.corruptMac === true) macC[0] ^= 0xff;
		this.send(makeMessage(MSG.AUTH, { mac_c: b64urlEncode(macC), state: this.state }));

		const ready = await frameOrClose(MSG.READY);
		if (ready === null) return result;
		result.ready = true;
		if (mode === "pair") this.key = await deriveExtKey(key, nonceC, challenge.nonce_s);
		return result;
	}

	/**
	 * @param {import("ws").RawData} data
	 * @param {boolean} isBinary
	 */
	#onFrame(data, isBinary) {
		if (isBinary) {
			this.invalidFrames.push("binary frame");
			return;
		}
		/** @type {Frame} */
		const frame = JSON.parse(data.toString());
		const check = validateMessage(frame, DIRECTION.TO_EXT);
		if (!check.ok) this.invalidFrames.push(check.error);
		this.received.push(frame);

		if (frame.type === MSG.PING && this.autoPong) this.send(makeMessage(MSG.PONG, { t: frame.t }));
		if (frame.type === MSG.JOB_START) {
			this.jobs.push(frame);
			Promise.resolve(this.onJob(frame, this)).then((body) => {
				if (body !== null && this.connected) this.sendResult(body);
			});
		}

		const index = this.#waiters.findIndex((w) => w.type === frame.type && w.match(frame));
		if (index !== -1) this.#waiters.splice(index, 1)[0].resolve(frame);
		else this.#inbox.push(frame);
	}
}
