import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { LIMITS } from "./config.js";
import { CLOSE, DIRECTION, MSG, PROTOCOL_VERSION, coreFrameVersion, makeMessage, validateMessage } from "../../extension/shared/protocol.js";
import { b64urlEncode, computeMacC, computeMacS, deriveExtKey, macMatches, randomNonce } from "../../extension/shared/auth.js";

/**
 * @typedef {import("../../extension/shared/protocol.js").ExtState} ExtState
 * @typedef {import("../../extension/shared/protocol.js").JobResultBody} JobResultBody
 * @typedef {import("../../extension/shared/protocol.js").HelloMsg} HelloMsg
 * @typedef {import("../../extension/shared/protocol.js").AuthMsg} AuthMsg
 * @typedef {import("../../extension/shared/protocol.js").JobAcceptedMsg} JobAcceptedMsg
 * @typedef {import("../../extension/shared/protocol.js").JobProgressMsg} JobProgressMsg
 * @typedef {import("./secrets.js").PairingCode} PairingCode
 */

/**
 * Why a ready link ended. "lost": the socket went away (browser closed,
 * crashed, stopped answering pings). "violation": the daemon cut it because
 * the extension sent something invalid.
 * @typedef {"lost" | "violation"} DownCause
 */

/**
 * @typedef {object} LinkHandlers
 * @property {(state: ExtState) => void} onUp the extension is authenticated and ready
 * @property {(cause: DownCause) => void} onDown the ready link is gone
 * @property {(state: ExtState) => void} onState
 * @property {(event: { name: string, job: string | null, host: string | null, detect: JobResultBody["detect"] }) => void} [onEvent]
 *   an event that is about a job (challenge.pending, challenge.acked)
 * @property {(msg: JobAcceptedMsg) => void} onAccepted
 * @property {(msg: JobProgressMsg) => void} onProgress
 * @property {(msg: import("../../extension/shared/protocol.js").JobBlobMsg) => void} [onBlob] a piece of a file a job brings back
 * @property {(body: JobResultBody) => void} onResult
 */

/**
 * @typedef {object} Conn
 * @property {WebSocket} ws
 * @property {() => void} stopCounting stop watching the bytes received before "ready"
 * @property {() => void} cut read nothing more from the peer; the socket goes as soon as what was written to it is out
 * @property {"hello" | "auth" | "ready" | "closed"} phase
 * @property {boolean} everReady the handshake was completed on this connection
 * @property {boolean} detached
 * @property {Promise<void>} chain inbound frames are handled strictly one after another
 * @property {unknown} handshakeTimer
 * @property {unknown} pingTimer
 * @property {NodeJS.Timeout | null} killTimer
 * @property {number} missedPongs
 * @property {Set<number>} pingsOut
 * @property {"auth" | "pair" | null} mode
 * @property {number} helloVersion the protocol version the peer's hello stated; when it is not this daemon's, the peer got its challenge and gets nothing more
 * @property {import("../../extension/shared/auth.js").Bytes | null} key K of this handshake: the extension key, or the pairing code
 * @property {PairingCode | null} pairing
 * @property {string} nonceC
 * @property {string} nonceS
 * @property {string} extVersion
 * @property {{ name: string, version: string }} browser
 * @property {number} readyAt
 */

// How long a hello of another protocol version is still named in the status.
// An extension that is turned away for it comes back at least once a minute.
const VERSION_MISMATCH_SHOWN_MS = 120000;

// Firefox gives every installed extension an internal UUID origin.
const EXTENSION_ORIGIN = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The /ext WebSocket: at most one authenticated extension.
 *
 * Handshake: hello -> challenge -> auth -> ready. The daemon
 * proves knowledge of the key first, so an extension never answers a process
 * that merely squats the port. Both proofs cover the port this daemon listens
 * on: a process on another port that passes a hello on to this one gets an
 * answer the extension, which dialled that other port, does not accept. No
 * job traffic passes before ready.
 *
 * An extension of another protocol version gets the challenge as well, with
 * this daemon's version in it and in the proof, and then nothing more: it
 * checks the proof and knows from the daemon it is paired with that the two do
 * not fit. Its auth frame, should it send one, is not looked at, and a pairing
 * code is not used up. Versions before the handshake core (HANDSHAKE_CORE_SINCE)
 * are closed with 4003 before any proof.
 *
 * Anyone on the loopback who sends an extension-like Origin can open a socket
 * here, so nothing a peer does before it has proved the key may cost the real
 * extension anything. Failed handshakes are not counted and nothing is
 * throttled: key and pairing code are 256-bit secrets. A handshake that is
 * not done within two seconds is dropped, a peer may send only a few hundred
 * kilobytes before it is ready, and a hello is answered with a challenge
 * whether or not there is anything to prove with: in pair mode with or without
 * a pending code, in auth mode with or without a stored key. When every place
 * for a pending handshake is taken, the oldest one makes room: peers that
 * connect and say nothing cannot keep the extension out. A peer that is
 * refused before it was ready is told why and cut off in the same moment -
 * nothing it sends after that is read, let alone buffered.
 */
export class ExtLink {
	#getPort;
	#secrets;
	#clock;
	#log;
	#handlers;
	#wss;
	#instance = crypto.randomBytes(12).toString("base64url");
	/** @type {Set<Conn>} connections that have not finished the handshake */
	#pending = new Set();
	/** @type {Conn | null} */
	#live = null;
	/** @type {ExtState | null} */
	#state = null;
	/** @type {{ protocol: number | null, at: number } | null} the last hello of another protocol version: a peer's claim, kept for the operator's status */
	#mismatch = null;
	/** @type {(event: string, fields?: import("./log.js").LogFields, key?: string) => void} warnings a peer can provoke before it has proved anything */
	#warn;
	#closed = false;

	/**
	 * @param {object} opts
	 * @param {() => number} opts.getPort the bound port: for the Host check, and part of what the handshake MACs cover
	 * @param {import("./secrets.js").Secrets} opts.secrets
	 * @param {import("./log.js").Clock} opts.clock
	 * @param {import("./log.js").Logger} opts.log
	 * @param {import("./log.js").LogThrottle} [opts.throttle] for warnings an unauthenticated peer can provoke
	 * @param {LinkHandlers} opts.handlers
	 */
	constructor({ getPort, secrets, clock, log, throttle, handlers }) {
		this.#getPort = getPort;
		this.#secrets = secrets;
		this.#clock = clock;
		this.#log = log;
		this.#warn = throttle === undefined ? (event, fields) => log.warn(event, fields) : (event, fields, key) => throttle.warn(event, fields, key);
		this.#handlers = handlers;
		this.#wss = new WebSocketServer({
			noServer: true,
			maxPayload: LIMITS.wsMaxPayload,
			perMessageDeflate: false,
			clientTracking: false,
		});
	}

	/**
	 * For the operator's status. While no extension is connected and one was
	 * lately turned away over its protocol version, that is said. An extension
	 * from the handshake core on shows "version mismatch" itself; one from
	 * before cannot, since for it a refusal counts only with a proof in a form
	 * this daemon does not make. What is reported is what a peer claimed before
	 * it proved anything.
	 * @returns {{ connected: false, version_mismatch?: { peer_protocol: number | null, daemon_protocol: number, ago_s: number } } | { connected: true, connected_s: number, ext_version: string, browser: { name: string, version: string }, state: ExtState | null }}
	 */
	info() {
		const conn = this.#live;
		if (conn === null) {
			const seen = this.#mismatch;
			const age = seen === null ? 0 : this.#clock.now() - seen.at;
			if (seen === null || age < 0 || age > VERSION_MISMATCH_SHOWN_MS) return { connected: false };
			return { connected: false, version_mismatch: { peer_protocol: seen.protocol, daemon_protocol: PROTOCOL_VERSION, ago_s: Math.floor(age / 1000) } };
		}
		return {
			connected: true,
			connected_s: Math.floor((this.#clock.now() - conn.readyAt) / 1000),
			ext_version: conn.extVersion,
			browser: conn.browser,
			state: this.#state,
		};
	}

	/**
	 * Send a frame to the ready extension.
	 * @param {Record<string, unknown>} msg
	 * @returns {boolean} false when there is no ready link
	 */
	send(msg) {
		const conn = this.#live;
		if (conn === null || conn.ws.readyState !== WebSocket.OPEN) return false;
		this.#write(conn, msg);
		return true;
	}

	/**
	 * "upgrade" handler of the HTTP server.
	 * @param {import("node:http").IncomingMessage} req
	 * @param {import("node:stream").Duplex} socket
	 * @param {Buffer} head
	 */
	handleUpgrade(req, socket, head) {
		socket.on("error", () => {});
		/** @param {number} status @param {string} text @param {string} reason */
		const refuse = (status, text, reason) => {
			this.#warn("ext.upgrade_refused", { reason }, reason);
			socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
		};
		const hosts = req.headersDistinct.host;
		if (hosts === undefined || hosts.length !== 1 || hosts[0] !== `127.0.0.1:${this.#getPort()}`) {
			return refuse(403, "Forbidden", "host");
		}
		if (req.method !== "GET" || req.url !== "/ext") return refuse(404, "Not Found", "path");
		const origins = req.headersDistinct.origin;
		if (origins === undefined || origins.length !== 1 || !EXTENSION_ORIGIN.test(origins[0])) {
			return refuse(403, "Forbidden", "origin");
		}
		if (this.#closed) return refuse(503, "Service Unavailable", "busy");
		while (this.#pending.size >= LIMITS.maxPendingHandshakes) {
			// The set keeps the order of arrival: the first one is the oldest.
			const [oldest] = this.#pending;
			this.#warn("ext.handshake_evicted");
			// The same answer as for a handshake that ran out of time: for the
			// extension it means "dial again", and nothing is held against it.
			this.#closeConn(oldest, CLOSE.POLICY_VIOLATION, "handshake_evicted");
		}
		this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, socket));
	}

	/** Close every connection; resolves when they are gone. */
	async close() {
		this.#closed = true;
		const conns = [...this.#pending];
		if (this.#live !== null) conns.push(this.#live);
		await Promise.all(
			conns.map(
				(conn) =>
					/** @type {Promise<void>} */ (
						new Promise((resolve) => {
							if (conn.ws.readyState === WebSocket.CLOSED) return resolve();
							conn.ws.once("close", () => resolve());
							this.#closeConn(conn, CLOSE.GOING_AWAY, "shutdown", { killAfterMs: 500 });
						})
					),
			),
		);
		this.#wss.close();
	}

	/**
	 * @param {WebSocket} ws
	 * @param {import("node:stream").Duplex} socket the connection under the WebSocket
	 */
	#onConnection(ws, socket) {
		// ws buffers a frame until it is complete, up to its 16 MiB limit, and
		// that limit cannot be set per connection. So count what the peer sends
		// before it is ready and cut it off far below that: a hello and an auth
		// frame are small. (Bytes that came with the upgrade request are put back
		// on the socket by ws and pass through here like the rest.)
		let received = 0;
		/** @param {Buffer | string} chunk */
		const count = (chunk) => {
			received += chunk.length;
			if (received > LIMITS.maxPreAuthBytes && conn.phase !== "ready" && conn.phase !== "closed") {
				this.#warn("ext.protocol_violation", { phase: conn.phase, reason: "too much data before ready" });
				this.#detach(conn, "violation");
				ws.terminate();
			}
		};
		socket.on("data", count);
		/** @type {Conn} */
		const conn = {
			ws,
			stopCounting: () => socket.off("data", count),
			cut: () => {
				socket.pause();
				// What was written (the close frame) still goes out; then the socket goes.
				socket.end(() => socket.destroy());
			},
			phase: "hello",
			everReady: false,
			detached: false,
			chain: Promise.resolve(),
			handshakeTimer: null,
			pingTimer: null,
			killTimer: null,
			missedPongs: 0,
			pingsOut: new Set(),
			mode: null,
			helloVersion: PROTOCOL_VERSION,
			key: null,
			pairing: null,
			nonceC: "",
			nonceS: "",
			extVersion: "",
			browser: { name: "", version: "" },
			readyAt: 0,
		};
		this.#pending.add(conn);
		conn.handshakeTimer = this.#clock.setTimeout(() => {
			this.#warn("ext.handshake_timeout");
			// No close handshake to wait for: the peer had its two seconds.
			this.#closeConn(conn, CLOSE.POLICY_VIOLATION, "handshake_timeout", { killAfterMs: 200 });
		}, LIMITS.handshakeTimeoutMs);

		ws.on("message", (data, isBinary) => {
			conn.chain = conn.chain
				.then(() => this.#onMessage(conn, data, isBinary))
				.catch((err) => {
					this.#log.error("ext.handler_failed", { message: err instanceof Error ? err.message : "unknown" });
					this.#closeConn(conn, 1011, "internal_error", { cause: "violation" });
				});
		});
		ws.on("close", () => {
			if (conn.killTimer !== null) clearTimeout(conn.killTimer);
			this.#detach(conn, "lost");
		});
		ws.on("error", (err) => {
			this.#warn("ext.socket_error", { message: err.message });
			// Frame-level faults found by the ws parser (over maxPayload, bad UTF-8,
			// bad opcode) are the peer's doing, not a lost connection. ws is already
			// closing the socket; record the cause before its close event arrives.
			const code = /** @type {NodeJS.ErrnoException} */ (err).code;
			if (typeof code === "string" && code.startsWith("WS_ERR_")) {
				this.#closeConn(conn, CLOSE.POLICY_VIOLATION, "frame error", { cause: "violation" });
			}
		});
	}

	/**
	 * @param {Conn} conn
	 * @param {Record<string, unknown>} msg
	 */
	#write(conn, msg) {
		const check = validateMessage(msg, DIRECTION.TO_EXT);
		if (!check.ok) throw new Error(`refusing to send an invalid frame: ${check.error}`);
		// A peer that is on its way out gets nothing more: writing to it could only fail.
		if (conn.ws.readyState !== WebSocket.OPEN) return;
		conn.ws.send(JSON.stringify(msg), (err) => {
			// Any peer can hang up in the middle of a write, as often as it likes.
			if (err) this.#warn("ext.send_failed", { message: err.message.slice(0, 100) });
		});
	}

	/**
	 * Stop using the connection now and close the socket.
	 *
	 * A connection that was ready gets time for the close handshake. One that
	 * never was is sent the close frame and cut off at once: while a close
	 * handshake is pending the WebSocket parser goes on reading, and a peer that
	 * ignores the close could have it buffer a frame of megabytes that the
	 * pre-auth limit no longer counts.
	 * @param {Conn} conn
	 * @param {number} code
	 * @param {string} reason
	 * @param {{ killAfterMs?: number, cause?: DownCause }} [opts]
	 *   killAfterMs: how long a peer that was ready gets to complete the close handshake
	 */
	#closeConn(conn, code, reason, opts = {}) {
		this.#detach(conn, opts.cause ?? "lost");
		if (conn.ws.readyState === WebSocket.OPEN) conn.ws.close(code, reason.slice(0, 100));
		if (!conn.everReady) {
			conn.cut();
			return;
		}
		if (conn.killTimer === null && conn.ws.readyState !== WebSocket.CLOSED) {
			conn.killTimer = setTimeout(() => conn.ws.terminate(), opts.killAfterMs ?? 2000);
			conn.killTimer.unref();
		}
	}

	/**
	 * @param {Conn} conn
	 * @param {DownCause} cause only the first call for a connection counts
	 */
	#detach(conn, cause) {
		if (conn.detached) return;
		conn.detached = true;
		conn.phase = "closed";
		conn.stopCounting();
		this.#clock.clearTimeout(conn.handshakeTimer);
		this.#clock.clearTimeout(conn.pingTimer);
		conn.key = null;
		conn.pairing = null;
		this.#pending.delete(conn);
		if (this.#live === conn) {
			this.#live = null;
			this.#state = null;
			this.#log.info("ext.disconnected", { cause });
			this.#handlers.onDown(cause);
		}
	}

	/**
	 * @param {Conn} conn
	 * @param {import("ws").RawData} data
	 * @param {boolean} isBinary
	 */
	async #onMessage(conn, data, isBinary) {
		if (conn.phase === "closed") return;
		/** @param {number} code @param {string} reason */
		const violation = (code, reason) => {
			this.#warn("ext.protocol_violation", { phase: conn.phase, reason });
			this.#closeConn(conn, code, reason, { cause: "violation" });
		};
		if (isBinary || !Buffer.isBuffer(data)) return violation(CLOSE.UNSUPPORTED_DATA, "text frames only");
		const cap = conn.phase === "ready" ? LIMITS.maxResultBytes : LIMITS.maxHandshakeFrameBytes;
		if (data.length > cap) return violation(CLOSE.TOO_BIG, "frame too large");
		/** @type {unknown} */
		let msg;
		try {
			msg = JSON.parse(data.toString("utf8"));
		} catch {
			return violation(CLOSE.POLICY_VIOLATION, "invalid json");
		}
		if (isPlainObject(msg) && typeof msg.v === "number" && msg.v !== PROTOCOL_VERSION) {
			// A peer that already got its challenge as one of another version was
			// told then; whatever it sends now only ends the connection.
			if (conn.helloVersion !== PROTOCOL_VERSION) return violation(CLOSE.PROTOCOL_VERSION, "protocol_version");
			// The log and the operator's status say it in plain words. The number
			// is a peer's claim; it is passed on as a number or not at all.
			const claimed = Number.isSafeInteger(msg.v) ? msg.v : null;
			if (conn.phase === "hello") this.#mismatch = { protocol: claimed, at: this.#clock.now() };
			this.#warn("ext.version_mismatch", {
				peer_protocol: claimed,
				daemon_protocol: PROTOCOL_VERSION,
				advice: "update the daemon and the extension to the same release",
			});
			// The proof before the verdict: a hello of a version that keeps the
			// handshake core is answered like any hello, so the extension learns
			// of the mismatch from a daemon that proved itself. Any other frame of
			// another version - a hello from before the core, one that is not
			// shaped like a hello, anything on a link that is up - is closed
			// without a proof.
			const helloVersion = conn.phase === "hello" ? coreFrameVersion(msg, MSG.HELLO, DIRECTION.TO_DAEMON) : null;
			if (helloVersion === null) return violation(CLOSE.PROTOCOL_VERSION, "protocol_version");
			conn.helloVersion = helloVersion;
			return this.#onHello(conn, /** @type {HelloMsg} */ (/** @type {unknown} */ (msg)));
		}
		const check = validateMessage(msg, DIRECTION.TO_DAEMON);
		if (!check.ok || !isPlainObject(msg)) return violation(CLOSE.POLICY_VIOLATION, check.ok ? "invalid" : check.error);
		const type = msg.type;

		if (conn.phase === "hello") {
			if (type !== MSG.HELLO) return violation(CLOSE.POLICY_VIOLATION, "expected hello");
			return this.#onHello(conn, /** @type {HelloMsg} */ (msg));
		}
		if (conn.phase === "auth") {
			// Of this version, after a hello of another: not looked at. No proof of
			// the peer's is checked, no pairing code used up, nobody let in.
			if (conn.helloVersion !== PROTOCOL_VERSION) return violation(CLOSE.PROTOCOL_VERSION, "protocol_version");
			if (type !== MSG.AUTH) return violation(CLOSE.POLICY_VIOLATION, "expected auth");
			return this.#onAuth(conn, /** @type {AuthMsg} */ (msg));
		}
		switch (type) {
			case MSG.JOB_ACCEPTED:
				return this.#handlers.onAccepted(/** @type {JobAcceptedMsg} */ (msg));
			case MSG.JOB_PROGRESS:
				return this.#handlers.onProgress(/** @type {JobProgressMsg} */ (msg));
			case MSG.JOB_BLOB:
				return this.#handlers.onBlob?.(/** @type {import("../../extension/shared/protocol.js").JobBlobMsg} */ (/** @type {unknown} */ (msg)));
			case MSG.JOB_RESULT: {
				const { v: _v, type: _type, ...body } = msg;
				return this.#handlers.onResult(/** @type {JobResultBody} */ (body));
			}
			case MSG.EVENT: {
				const state = /** @type {ExtState} */ (msg.state);
				this.#state = state;
				const job = typeof msg.job === "string" ? msg.job : null;
				this.#log.info("ext.event", { name: String(msg.name), job });
				// The state first: a job that is parked by this event frees a slot,
				// and whoever fills it must see the state that came with it.
				this.#handlers.onState(state);
				if (job !== null) {
					this.#handlers.onEvent?.({
						name: String(msg.name),
						job,
						host: typeof msg.host === "string" ? msg.host : null,
						detect: /** @type {JobResultBody["detect"]} */ (msg.detect ?? null),
					});
				}
				return;
			}
			case MSG.PING:
				return this.#write(conn, makeMessage(MSG.PONG, { t: msg.t }));
			case MSG.PONG:
				if (typeof msg.t === "number" && conn.pingsOut.has(msg.t)) {
					conn.pingsOut.clear();
					conn.missedPongs = 0;
				}
				return;
			default:
				return violation(CLOSE.POLICY_VIOLATION, "unexpected message");
		}
	}

	/**
	 * What the MACs of a handshake on this daemon cover. The port is the one
	 * this daemon listens on - read off the listening socket, also when that
	 * socket was handed over by the service manager - and never one a peer
	 * named: not the Host header, not a frame. So the proof made here is of use
	 * to a peer that dialled this port and to nobody else. The versions are the
	 * one the peer's hello stated and this daemon's own, which stands in its
	 * challenge.
	 * @param {"auth" | "pair"} mode
	 * @param {number} helloVersion
	 * @param {string} nonceC
	 * @param {string} nonceS
	 * @returns {import("../../extension/shared/auth.js").Transcript}
	 */
	#transcript(mode, helloVersion, nonceC, nonceS) {
		return { mode, port: this.#getPort(), versionC: helloVersion, versionS: PROTOCOL_VERSION, instance: this.#instance, nonceC, nonceS };
	}

	/**
	 * @param {Conn} conn
	 * @param {HelloMsg} msg
	 */
	async #onHello(conn, msg) {
		conn.mode = msg.mode;
		conn.extVersion = msg.ext_version;
		conn.browser = { name: msg.browser.name, version: msg.browser.version };
		conn.nonceC = msg.nonce_c;
		if (msg.mode === "auth") {
			// Paired or not, the peer gets a challenge. While no key is stored the
			// challenge is made from a random one that is thrown away, so the
			// handshake goes as it does for a peer with the wrong key: the proof
			// does not verify, and whoever answers it all the same is refused at
			// the auth step. Whether an extension is paired cannot be read off
			// the answer by a peer that proved nothing. The operator finds it in
			// the log and in "bgw status".
			const key = this.#secrets.extKey();
			if (key === null) this.#warn("ext.not_paired");
			conn.key = key ?? this.#secrets.throwawayExtKey();
		} else {
			// With or without a pending code the peer gets a challenge. Without
			// one the key is random and thrown away, so the handshake ends in the
			// same auth_failed as a wrong code, at the same step: whether pairing
			// is in progress cannot be read off the answer.
			const pairing = this.#secrets.activePairing();
			conn.pairing = pairing;
			conn.key = pairing === null ? this.#secrets.throwawayPairingKey(this.#getPort()) : pairing.key;
		}
		const nonceS = randomNonce();
		const macS = await computeMacS(conn.key, this.#transcript(msg.mode, conn.helloVersion, conn.nonceC, nonceS));
		if (conn.phase !== "hello") return;
		conn.nonceS = nonceS;
		conn.phase = "auth";
		this.#write(
			conn,
			makeMessage(MSG.CHALLENGE, { instance: this.#instance, nonce_s: nonceS, mac_s: b64urlEncode(macS) }),
		);
	}

	/**
	 * @param {Conn} conn
	 * @param {AuthMsg} msg
	 */
	async #onAuth(conn, msg) {
		const key = conn.key;
		const mode = conn.mode;
		if (key === null || mode === null || conn.helloVersion !== PROTOCOL_VERSION) return this.#authFailed(conn);
		const expected = await computeMacC(key, this.#transcript(mode, conn.helloVersion, conn.nonceC, conn.nonceS));
		if (conn.phase !== "auth") return;
		// A wrong MAC costs the sender this connection and nobody else anything:
		// no counter, no backoff, and a pairing code stays good.
		if (!macMatches(expected, msg.mac_c)) return this.#authFailed(conn);
		// The peer knows K. Only now may it learn that the slot is taken.
		if (this.#live !== null) return this.#refuseSecond(conn);
		if (mode === "pair") {
			const extKey = await deriveExtKey(key, conn.nonceC, conn.nonceS);
			if (conn.phase !== "auth") return;
			if (this.#live !== null) return this.#refuseSecond(conn);
			// Expired or replaced while the handshake ran: the code is no longer good.
			if (conn.pairing === null || !this.#secrets.consumePairing(conn.pairing)) return this.#authFailed(conn);
			this.#secrets.setExtKey(extKey);
		} else if (this.#secrets.extKey() !== key) {
			// A pairing completed meanwhile and replaced the key this handshake used.
			return this.#authFailed(conn);
		}

		this.#clock.clearTimeout(conn.handshakeTimer);
		conn.handshakeTimer = null;
		this.#pending.delete(conn);
		conn.stopCounting();
		conn.phase = "ready";
		conn.everReady = true;
		conn.readyAt = this.#clock.now();
		conn.key = null;
		conn.pairing = null;
		this.#live = conn;
		this.#mismatch = null;
		this.#state = msg.state;
		this.#write(
			conn,
			makeMessage(MSG.READY, {
				limits: { max_result_bytes: LIMITS.maxResultBytes, ping_s: LIMITS.pingIntervalMs / 1000 },
			}),
		);
		this.#schedulePing(conn);
		this.#log.info("ext.connected", {
			mode: conn.mode,
			ext_version: conn.extVersion,
			browser: `${conn.browser.name} ${conn.browser.version}`.trim(),
		});
		this.#handlers.onUp(msg.state);
	}

	/** @param {Conn} conn */
	#refuseSecond(conn) {
		this.#warn("ext.second_connection_refused");
		this.#closeConn(conn, CLOSE.ALREADY_CONNECTED, "already_connected");
	}

	/**
	 * Wrong MAC, or no usable key material.
	 * @param {Conn} conn
	 */
	#authFailed(conn) {
		this.#warn("ext.auth_failed", { mode: conn.mode }, String(conn.mode));
		this.#closeConn(conn, CLOSE.AUTH_FAILED, "auth_failed");
	}

	/** @param {Conn} conn */
	#schedulePing(conn) {
		conn.pingTimer = this.#clock.setTimeout(() => {
			if (conn.phase !== "ready") return;
			if (conn.missedPongs >= LIMITS.maxMissedPongs) {
				this.#log.warn("ext.ping_timeout");
				this.#detach(conn, "lost");
				conn.ws.terminate();
				return;
			}
			conn.missedPongs += 1;
			const t = this.#clock.now();
			conn.pingsOut.add(t);
			this.#write(conn, makeMessage(MSG.PING, { t }));
			this.#schedulePing(conn);
		}, LIMITS.pingIntervalMs);
	}
}
