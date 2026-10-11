// The WebSocket link to the daemon: handshake, pairing and reconnects.
//
// Reconnect rules. Anything can listen on the port, so a
// close code only means what it says when it comes from a daemon that proved
// itself: its mac_s was verified on that same connection.
//
//   verified, 4001 / 4004 / 4003   terminal: "pair again" / "version mismatch"
//   verified, 4002                 another browser holds the link: wait long
//   NOT verified, any of those     keep the key, show "daemon not verified",
//                                  retry with a long backoff (at most 60 s)
//   NOT verified, and silent       the same: whoever took the connection said
//   or not making sense              nothing until the time for the handshake
//                                    was up, or sent what the daemon never
//                                    sends. That is no daemon as far as
//                                    anybody can tell
//   anything else                  retry with the ordinary backoff (nobody
//                                  listening, a close without a meaning, a
//                                  daemon that is being restarted)
//
// A daemon of another protocol version proves itself like any other: its
// challenge states its version, and the proof covers that version and this
// extension's. The proof is checked first, the versions are compared after.
// Proof right, versions different: "version mismatch", terminal, and no auth
// frame is sent - the daemon knows from the hello. Proof wrong: not verified,
// as above. (A daemon from before the handshake core, version 4, closes with
// 4003 and proves nothing: that stays "not verified".)
//
// The stored key is never deleted or replaced because of a close code or a
// failed handshake. Only the operator ("forget pairing") or a pairing that
// went through replaces it.

import { CLOSE, DIRECTION, LIMITS, MSG, PROTOCOL_VERSION, coreFrameVersion, makeMessage, validateMessage } from "../shared/protocol.js";
import {
	b64urlEncode,
	computeMacC,
	computeMacS,
	deriveExtKey,
	macMatches,
	pairingKey,
	parsePairingCode,
	randomNonce,
} from "../shared/auth.js";
import { errorText } from "./errtext.js";

export const PHASE = Object.freeze({
	/** No key stored: there is nothing to prove with, so nothing is dialled. */
	UNPAIRED: "unpaired",
	CONNECTING: "connecting",
	HANDSHAKE: "handshake",
	READY: "ready",
	/** Backing off before the next attempt. */
	WAITING: "waiting",
	/** Backing off: whoever answers on the port has not proved to be the daemon. The key is kept. */
	UNVERIFIED: "daemon_unverified",
	/** Terminal, close 4001 from a verified daemon: it refused the key. */
	AUTH_FAILED: "auth_failed",
	/** Terminal, close 4004 from a verified daemon: it holds no key. */
	NOT_PAIRED: "not_paired",
	/** Terminal: a verified daemon states another version in its challenge, closes with 4003 or sends a frame of another version. */
	PROTOCOL_VERSION: "protocol_version",
	STOPPED: "stopped",
});

/**
 * Phases that only an operator action ends.
 * @type {readonly string[]}
 */
export const TERMINAL_PHASES = Object.freeze([PHASE.AUTH_FAILED, PHASE.NOT_PAIRED, PHASE.PROTOCOL_VERSION]);

// Sent when this side drops the link because of what the daemon sent. Private
// use range; the daemon does not interpret close codes from the extension.
const CLOSE_BAD_FRAME = 4400;
// Frames from the daemon are small (the largest is job.start with a URL).
const MAX_INBOUND_CHARS = 65536;
// Before the daemon has proved itself one frame is due, the challenge: three short members. Anything longer
// comes from somebody else, and is not read.
const MAX_UNVERIFIED_CHARS = 4096;

/**
 * @typedef {import("../shared/auth.js").Bytes} Bytes
 * @typedef {import("../shared/protocol.js").ExtState} ExtState
 *
 * @typedef {object} SocketLike the part of a WebSocket the link uses
 * @property {(data: string) => void} send
 * @property {(code?: number, reason?: string) => void} close
 * @property {() => number} [buffered] bytes handed to send() that are not on the wire yet; absent: not known
 * @property {(() => void) | null} onopen
 * @property {((ev: { data: unknown }) => void) | null} onmessage
 * @property {((ev: { code: number }) => void) | null} onclose
 *
 * @typedef {object} LinkSettings
 * @property {number} port
 * @property {Bytes | null} key
 * @property {(key: Bytes) => Promise<void>} setKey
 * @property {() => Promise<void>} clearKey
 * @property {(port: number) => Promise<void>} setPort
 *
 * @typedef {object} LinkHandlers
 * @property {(limits: { maxResultBytes: number, pingS: number }) => void} onReady the handshake finished
 * @property {() => void} onDown a ready link ended
 * @property {(msg: Record<string, unknown>) => void} onMessage a validated job.start, job.cancel or attention frame
 * @property {() => void} onStatus the status changed
 *
 * @typedef {object} LinkTuning
 * @property {number} baseMs first retry delay
 * @property {number} capMs longest ordinary retry delay
 * @property {number} longMs delay after "another browser holds the link"
 * @property {number} unverifiedBaseMs first retry delay towards a peer that did not prove itself
 * @property {number} unverifiedCapMs longest such delay
 * @property {number} stableMs a link that stayed up this long resets the backoff
 * @property {number} handshakeTimeoutMs
 * @property {number} pairTimeoutMs
 * @property {number} replaceWaitMs how long to wait for the old socket to close before dialling again
 *
 * @typedef {object} LinkDeps
 * @property {(url: string) => SocketLike} createSocket
 * @property {LinkSettings} settings
 * @property {() => ExtState} getState
 * @property {{ extVersion: string, browser: { name: string, version: string } }} identity
 * @property {LinkHandlers} handlers
 * @property {(event: string, fields?: Record<string, string | number | boolean | null>) => void} log never given secrets
 * @property {() => number} [random]
 * @property {Partial<LinkTuning>} [tuning]
 *
 * @typedef {object} LinkStatus
 * @property {string} phase one of PHASE
 * @property {boolean} paired a key is stored
 * @property {boolean} pairing a pairing attempt is running
 * @property {number} port
 * @property {string | null} reason short code for why the link is not up
 * @property {string | null} lastError one sentence for the operator
 * @property {number | null} retryAt epoch ms of the next attempt
 * @property {number | null} readySince epoch ms
 *
 * @typedef {{ ok: true } | { ok: false, error: string }} PairResult
 *
 * @typedef {object} Conn
 * @property {SocketLike} sock
 * @property {"auth" | "pair"} mode
 * @property {number} port the port this socket was dialled on; both proofs are checked and made for it
 * @property {Bytes} key K of this handshake: the stored key, or the pairing code
 * @property {"open" | "challenge" | "ready" | "up" | "done"} step
 * @property {boolean} verified the daemon's mac_s was checked and matched on this connection
 * @property {string} nonceC
 * @property {Bytes | null} derived the long-lived key of a pairing, held until "ready" arrives
 * @property {Promise<void>} chain inbound frames are handled strictly one after another
 * @property {boolean} closed the socket reported its close
 * @property {(() => void)[]} closeWaiters
 */

/** @type {LinkTuning} */
const DEFAULT_TUNING = Object.freeze({
	baseMs: 500,
	capMs: 30000,
	longMs: 120000,
	unverifiedBaseMs: 5000,
	unverifiedCapMs: 60000,
	stableMs: 10000,
	handshakeTimeoutMs: 10000,
	pairTimeoutMs: 15000,
	replaceWaitMs: 1000,
});

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class Link {
	#deps;
	/** @type {LinkTuning} */
	#tuning;
	#random;
	/** @type {Conn | null} */
	#conn = null;
	/** @type {string} */
	#phase = PHASE.STOPPED;
	/** @type {string | null} */
	#reason = null;
	/** @type {string | null} */
	#lastError = null;
	/** @type {number | null} */
	#retryAt = null;
	/** @type {number | null} */
	#readySince = null;
	/** Failed attempts in a row; drives the backoff. */
	#attempt = 0;
	/** Answers in a row from a peer that did not prove itself; drives the long backoff. */
	#unverifiedAttempt = 0;
	#stopped = true;
	/** @type {ReturnType<typeof setTimeout> | null} */
	#retryTimer = null;
	/** @type {ReturnType<typeof setTimeout> | null} */
	#handshakeTimer = null;
	/** @type {ReturnType<typeof setTimeout> | null} */
	#watchdogTimer = null;
	#lastRx = 0;
	/** @type {number} */
	#pingS = LIMITS.PING_S;
	/** @type {number} */
	#maxResultBytes = LIMITS.MAX_RESULT_BYTES;
	/** @type {{ done: (result: PairResult) => void, timer: ReturnType<typeof setTimeout> | null } | null} */
	#pairing = null;
	/** @type {Promise<void>} operator actions (pair, reconnect, forget) run one at a time */
	#ops = Promise.resolve();

	/** @param {LinkDeps} deps */
	constructor(deps) {
		this.#deps = deps;
		this.#tuning = { ...DEFAULT_TUNING, ...deps.tuning };
		this.#random = deps.random ?? Math.random;
	}

	/** @returns {LinkStatus} */
	status() {
		return {
			phase: this.#phase,
			paired: this.#deps.settings.key !== null,
			pairing: this.#pairing !== null,
			port: this.#deps.settings.port,
			reason: this.#reason,
			lastError: this.#lastError,
			retryAt: this.#retryAt,
			readySince: this.#readySince,
		};
	}

	isReady() {
		return this.#conn !== null && this.#conn.step === "up";
	}

	/** Largest job.result frame the daemon accepts, in bytes. */
	get maxResultBytes() {
		return this.#maxResultBytes;
	}

	/** Begin connecting (when a key is stored) and keep the link up from now on. */
	start() {
		this.#stopped = false;
		this.#attempt = 0;
		this.#unverifiedAttempt = 0;
		if (this.#conn === null) this.#connectIfPaired();
	}

	/** Drop the link and stay down until start() or an operator action. Nothing in the extension calls it: for tests, which end a link with it. */
	stop() {
		return this.#serial(async () => {
			this.#stopped = true;
			this.#clearRetry();
			await this.#replace();
			this.#set(PHASE.STOPPED, null, null);
		});
	}

	/** The operator asked for a fresh attempt: forget the backoff and any terminal state. */
	reconnect() {
		return this.#serial(async () => {
			this.#stopped = false;
			this.#clearRetry();
			this.#attempt = 0;
			this.#unverifiedAttempt = 0;
			await this.#replace();
			this.#connectIfPaired();
		});
	}

	/** The operator asked for it: drop the stored key. The link stays down until the next pairing. */
	forget() {
		return this.#serial(async () => {
			this.#clearRetry();
			await this.#deps.settings.clearKey();
			await this.#replace();
			this.#set(PHASE.UNPAIRED, null, null);
		});
	}

	/**
	 * Pair with a one-time code from "bgw pair". One attempt, never repeated
	 * automatically: the daemon counts wrong attempts against the code.
	 * @param {unknown} text the code as pasted
	 * @returns {Promise<PairResult>}
	 */
	pair(text) {
		const parsed = parsePairingCode(text);
		if (!parsed.ok) return Promise.resolve({ ok: false, error: "That is not a pairing code. It looks like bgw1.<port>.<43 characters>." });
		if (this.#pairing !== null) return Promise.resolve({ ok: false, error: "A pairing attempt is already running." });
		/** @type {(result: PairResult) => void} */
		let done = () => {};
		/** @type {Promise<PairResult>} */
		const result = new Promise((resolve) => {
			done = resolve;
		});
		const pairing = { done, timer: /** @type {ReturnType<typeof setTimeout> | null} */ (null) };
		this.#pairing = pairing;
		// A code that did not work must not leave the extension dialling its port.
		const portBefore = this.#deps.settings.port;
		result.then((r) => {
			if (!r.ok && this.#deps.settings.port !== portBefore) this.#deps.settings.setPort(portBefore).catch(() => {});
		});
		pairing.timer = setTimeout(() => {
			const conn = this.#conn;
			if (conn !== null && conn.mode === "pair") this.#abandon(conn, "pair_timeout");
			else this.#pairDone({ ok: false, error: "The daemon did not answer in time." });
		}, this.#tuning.pairTimeoutMs);
		this.#serial(async () => {
			if (this.#pairing !== pairing) return;
			this.#stopped = false;
			this.#clearRetry();
			// The code names the port its daemon listens on.
			await this.#deps.settings.setPort(parsed.port);
			await this.#replace();
			if (this.#pairing !== pairing) return;
			this.#attempt = 0;
			this.#unverifiedAttempt = 0;
			this.#dial("pair", pairingKey(parsed.code));
		}).catch(() => {
			if (this.#pairing === pairing) this.#pairDone({ ok: false, error: "Pairing could not be started." });
		});
		this.#deps.handlers.onStatus();
		return result;
	}

	/**
	 * Send a frame over the ready link.
	 * @param {Record<string, unknown>} msg
	 * @returns {boolean} false when the link is not ready or the frame is not valid
	 */
	send(msg) {
		const conn = this.#conn;
		if (conn === null || conn.step !== "up") return false;
		const check = validateMessage(msg, DIRECTION.TO_DAEMON);
		if (!check.ok) {
			this.#deps.log("link.invalid_outbound", { error: check.error });
			return false;
		}
		try {
			conn.sock.send(JSON.stringify(msg));
		} catch {
			return false;
		}
		return true;
	}

	/** @returns {number} bytes of sent frames that the socket still holds; 0 when that cannot be told or no link is up */
	backlog() {
		const conn = this.#conn;
		if (conn === null || conn.step !== "up" || conn.sock.buffered === undefined) return 0;
		try {
			const n = conn.sock.buffered();
			return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
		} catch {
			return 0;
		}
	}

	/**
	 * @template T
	 * @param {() => Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	#serial(fn) {
		const run = this.#ops.then(fn);
		this.#ops = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * @param {string} phase
	 * @param {string | null} reason
	 * @param {string | null} lastError
	 */
	#set(phase, reason, lastError) {
		this.#phase = phase;
		this.#reason = reason;
		this.#lastError = lastError;
		if (phase !== PHASE.WAITING && phase !== PHASE.UNVERIFIED) this.#retryAt = null;
		if (phase !== PHASE.READY) this.#readySince = null;
		this.#deps.handlers.onStatus();
	}

	#clearRetry() {
		if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
		this.#retryTimer = null;
	}

	#clearConnTimers() {
		if (this.#handshakeTimer !== null) clearTimeout(this.#handshakeTimer);
		this.#handshakeTimer = null;
		if (this.#watchdogTimer !== null) clearTimeout(this.#watchdogTimer);
		this.#watchdogTimer = null;
	}

	/** Exponential backoff with jitter: half the step is fixed, half is random. */
	#nextDelay() {
		const step = Math.min(this.#tuning.capMs, this.#tuning.baseMs * 2 ** this.#attempt);
		this.#attempt = Math.min(this.#attempt + 1, 30);
		return Math.round(step / 2 + (this.#random() * step) / 2);
	}

	/**
	 * @param {number} ms
	 * @param {string} reason
	 * @param {string} text
	 * @param {string} [phase]
	 */
	#wait(ms, reason, text, phase = PHASE.WAITING) {
		this.#clearRetry();
		this.#retryAt = Date.now() + ms;
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = null;
			if (!this.#stopped && this.#conn === null) this.#connectIfPaired();
		}, ms);
		this.#set(phase, reason, text);
	}

	/**
	 * Whoever answered did not prove to be the daemon. Whatever it claimed
	 * changes nothing: the key stays, and the next attempt comes late.
	 * @param {string | null} claim what it said or did in place of a proof, null when its proof was wrong
	 */
	#waitUnverified(claim) {
		const port = this.#deps.settings.port;
		const step = Math.min(this.#tuning.unverifiedCapMs, this.#tuning.unverifiedBaseMs * 2 ** this.#unverifiedAttempt);
		this.#unverifiedAttempt = Math.min(this.#unverifiedAttempt + 1, 30);
		// Jitter downwards only: the cap is the longest wait there is.
		const ms = Math.round(step * (0.75 + this.#random() / 4));
		/** @type {Record<string, string>} */
		const claims = {
			auth_failed: "refused the connection",
			not_paired: "says it holds no key for this extension",
			protocol_version: "reports another protocol version",
			already_connected: "says another browser is connected",
			silent: "took the connection and then said nothing",
			garbage: "sent something the daemon never sends",
		};
		// A daemon that holds no key at all answers like one that holds another.
		const said = claim === null ? "answered with a wrong proof (it holds another key, or none)" : claims[claim];
		// Pairing again does not mend a version mismatch, so that advice is not given for one.
		const advice =
			claim === "protocol_version"
				? "If the daemon or the extension was updated, update both to the same release."
				: claim === "silent" || claim === "garbage"
					? "If the daemon is just starting or busy, this passes by itself; if another program uses the port, give the daemon another one."
					: "If the daemon was set up anew, pair again.";
		const text = `Daemon not verified: the program on port ${port} ${said}, but did not prove that it is the daemon. The stored key is kept and nothing made from it was sent. Still trying. ${advice}`;
		this.#wait(ms, claim === null ? "daemon_unverified" : `unverified_${claim}`, text, PHASE.UNVERIFIED);
	}

	#connectIfPaired() {
		const key = this.#deps.settings.key;
		if (key === null) {
			this.#set(PHASE.UNPAIRED, null, this.#lastError);
			return;
		}
		this.#dial("auth", key);
	}

	/**
	 * @param {"auth" | "pair"} mode
	 * @param {Bytes} key
	 */
	#dial(mode, key) {
		this.#clearRetry();
		const port = this.#deps.settings.port;
		/** @type {SocketLike} */
		let sock;
		try {
			sock = this.#deps.createSocket(`ws://127.0.0.1:${port}/ext`);
		} catch {
			if (mode === "pair") this.#pairDone({ ok: false, error: "Could not open a connection to the daemon." });
			this.#wait(this.#nextDelay(), "unreachable", `Cannot reach the daemon on 127.0.0.1:${port}.`);
			return;
		}
		/** @type {Conn} */
		const conn = { sock, mode, port, key, step: "open", verified: false, nonceC: "", derived: null, chain: Promise.resolve(), closed: false, closeWaiters: [] };
		this.#conn = conn;
		this.#handshakeTimer = setTimeout(() => this.#abandon(conn, "handshake_timeout"), this.#tuning.handshakeTimeoutMs);
		sock.onopen = () => {
			if (conn.step !== "open") return;
			conn.nonceC = randomNonce();
			conn.step = "challenge";
			this.#set(PHASE.HANDSHAKE, this.#reason, this.#lastError);
			// Nothing in hello depends on the key.
			this.#write(conn, makeMessage(MSG.HELLO, { mode, ...this.#helloIdentity(), nonce_c: conn.nonceC }));
		};
		sock.onmessage = (ev) => {
			if (conn.step === "done") return;
			// What can be told of a frame without reading it is told here, in the moment it arrives, and ends the
			// connection at once - not when its turn comes behind the frames that are still being worked on. The
			// browser hands over whole messages only: one that is too long has been taken in full by then, and
			// nothing in a page's reach of the WebSocket API ends it sooner.
			const fault = this.#unreadable(conn, ev.data);
			if (fault !== null) return this.#violation(conn, fault);
			conn.chain = conn.chain
				.then(() => this.#onFrame(conn, ev.data))
				.catch((err) => {
					this.#deps.log("link.handler_failed", { message: errorText(err) });
					this.#abandon(conn, "internal_error");
				});
		};
		sock.onclose = (ev) => {
			conn.closed = true;
			for (const wake of conn.closeWaiters.splice(0)) wake();
			this.#finish(conn, typeof ev.code === "number" ? ev.code : null, null);
		};
		this.#set(PHASE.CONNECTING, this.#reason, this.#lastError);
	}

	#helloIdentity() {
		const { extVersion, browser } = this.#deps.identity;
		return { ext_version: extVersion, browser: { name: browser.name.slice(0, 64), version: browser.version.slice(0, 32) } };
	}

	/**
	 * @param {Conn} conn
	 * @param {Record<string, unknown>} msg
	 */
	#write(conn, msg) {
		const check = validateMessage(msg, DIRECTION.TO_DAEMON);
		if (!check.ok) throw new Error(`refusing to send an invalid frame: ${check.error}`);
		conn.sock.send(JSON.stringify(msg));
	}

	/**
	 * Stop using a socket now, whatever it does next, and close it.
	 * @param {Conn} conn
	 * @param {string} local why this side gave up on it
	 * @param {number} [code]
	 */
	#abandon(conn, local, code = 1000) {
		this.#finish(conn, null, local);
		try {
			conn.sock.close(code);
		} catch {
			// already closed
		}
	}

	/**
	 * Drop the current socket and give the daemon a moment to notice, so that
	 * the next handshake is not refused as a second connection.
	 */
	async #replace() {
		const conn = this.#conn;
		if (conn === null) return;
		/** @type {Promise<void>} */
		const closed = new Promise((resolve) => {
			if (conn.closed) resolve();
			else conn.closeWaiters.push(resolve);
		});
		this.#abandon(conn, "replaced");
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let timer;
		await Promise.race([
			closed,
			new Promise((resolve) => {
				timer = setTimeout(resolve, this.#tuning.replaceWaitMs);
			}),
		]);
		clearTimeout(timer);
	}

	/** @param {PairResult} result */
	#pairDone(result) {
		const pairing = this.#pairing;
		if (pairing === null) return;
		this.#pairing = null;
		if (pairing.timer !== null) clearTimeout(pairing.timer);
		pairing.done(result);
	}

	/**
	 * The one place a connection ends. Decides what happens next from the close
	 * code (see the reconnect rules at the top) or from the local reason. No
	 * path through here touches the stored key.
	 * @param {Conn} conn
	 * @param {number | null} code close code from the daemon, null when this side gave up
	 * @param {string | null} local
	 */
	#finish(conn, code, local) {
		if (conn.step === "done") return;
		const wasUp = conn.step === "up";
		// The socket opened: something on the port took the connection.
		const taken = conn.step !== "open";
		conn.step = "done";
		conn.derived = null;
		if (this.#conn === conn) {
			this.#conn = null;
			this.#clearConnTimers();
		}
		const port = this.#deps.settings.port;
		if (wasUp) {
			if (this.#readySince !== null && Date.now() - this.#readySince >= this.#tuning.stableMs) this.#attempt = 0;
			this.#deps.log("link.down", { code, local });
			this.#deps.handlers.onDown();
		}
		if (local === "replaced") return;

		// What the other side says the matter is. It only counts from a daemon
		// that proved itself on this very connection.
		/** @type {"auth_failed" | "not_paired" | "protocol_version" | "already_connected" | null} */
		let claim = null;
		if (code === CLOSE.AUTH_FAILED) claim = "auth_failed";
		else if (code === CLOSE.NOT_PAIRED) claim = "not_paired";
		else if (code === CLOSE.PROTOCOL_VERSION || local === "protocol_version") claim = "protocol_version";
		else if (code === CLOSE.ALREADY_CONNECTED) claim = "already_connected";
		const unproven = !conn.verified && (claim !== null || local === "daemon_unverified");
		// Or it took the connection and then was no daemon to speak of: silent until the time for the handshake was
		// up, or sending what the daemon never sends. Nobody listening at all is not this, and neither is a close
		// that says nothing: a daemon that is not running, or is being restarted, is tried again soon.
		/** @type {"silent" | "garbage" | null} */
		const stranger = conn.verified || wasUp ? null : taken && local === "handshake_timeout" ? "silent" : local === "bad_frame" ? "garbage" : null;

		if (conn.mode === "pair" && !wasUp) {
			let error = `Could not reach the daemon on 127.0.0.1:${port}. Is it running?`;
			if (unproven) error = `The program on port ${port} did not prove that it knows this code. The code may be mistyped, already used or expired - or that program is not the daemon. Nothing was sent to it.`;
			else if (claim === "auth_failed" || claim === "not_paired") error = "The daemon rejected the code. It may be already used or expired.";
			else if (claim === "already_connected") error = "Another browser profile is connected to the daemon. Close it there first.";
			else if (claim === "protocol_version") error = `Daemon and extension speak different protocol versions (this extension: ${PROTOCOL_VERSION}).`;
			else if (local === "pair_timeout" || local === "handshake_timeout") error = "The daemon did not answer in time.";
			else if (local === "bad_frame" || local === "internal_error") error = "The daemon sent something unexpected. Pairing was stopped.";
			this.#deps.log("link.pair_failed", { code, local, verified: conn.verified });
			this.#pairDone({ ok: false, error });
			if (this.#stopped) return this.#set(PHASE.STOPPED, null, error);
			if (this.#deps.settings.key === null) return this.#set(PHASE.UNPAIRED, null, error);
			// The key from an earlier pairing is still stored: go back to using it.
			return this.#wait(this.#nextDelay(), "pair_failed", error);
		}

		if (this.#stopped) return this.#set(PHASE.STOPPED, null, null);
		if (unproven || stranger !== null) {
			this.#deps.log("link.unverified", { code, claim: claim ?? stranger });
			return this.#waitUnverified(claim ?? stranger);
		}
		if (claim === "auth_failed") {
			return this.#set(PHASE.AUTH_FAILED, "auth_failed", "The daemon refused this extension's key. Pair again.");
		}
		if (claim === "not_paired") {
			return this.#set(PHASE.NOT_PAIRED, "not_paired", "The daemon holds no key for this extension. Pair again.");
		}
		if (claim === "protocol_version") {
			return this.#set(PHASE.PROTOCOL_VERSION, "protocol_version", `Version mismatch: this extension speaks protocol version ${PROTOCOL_VERSION} and the daemon another one. Update the daemon and the extension to the same release.`);
		}
		if (claim === "already_connected") {
			const ms = Math.round(this.#tuning.longMs * (1 + this.#random() / 4));
			return this.#wait(ms, "already_connected", "Another browser profile is connected to the daemon.");
		}
		if (local === "bad_frame" || local === "internal_error") {
			return this.#wait(this.#nextDelay(), "bad_frame", "The daemon sent a frame this extension does not accept.");
		}
		if (wasUp) return this.#wait(this.#nextDelay(), "lost", "The connection to the daemon was lost.");
		return this.#wait(this.#nextDelay(), "unreachable", `Cannot reach the daemon on 127.0.0.1:${port}.`);
	}

	/**
	 * @param {Conn} conn
	 * @param {string} what names fields and expectations only, never values
	 */
	#violation(conn, what) {
		this.#deps.log("link.bad_frame", { step: conn.step, what });
		this.#abandon(conn, "bad_frame", CLOSE_BAD_FRAME);
	}

	/**
	 * @param {Conn} conn
	 * @param {unknown} data what the socket handed over
	 * @returns {string | null} why the frame is not even read: no text, or longer than anything that is due on this
	 *   connection as it stands. null: it may be read
	 */
	#unreadable(conn, data) {
		if (typeof data !== "string") return "not a text frame";
		// "open" and "challenge": nothing was verified yet, and the next frame after a challenge is asked for by this side.
		const unverified = conn.step === "open" || conn.step === "challenge";
		return data.length > (unverified ? MAX_UNVERIFIED_CHARS : MAX_INBOUND_CHARS) ? "frame too large" : null;
	}

	/**
	 * @param {Conn} conn
	 * @param {unknown} data
	 */
	async #onFrame(conn, data) {
		if (conn.step === "done") return;
		this.#lastRx = Date.now();
		// Asked again now that it is this frame's turn: the connection may stand elsewhere than when it arrived.
		const fault = this.#unreadable(conn, data);
		if (fault !== null || typeof data !== "string") return this.#violation(conn, fault ?? "not a text frame");
		/** @type {unknown} */
		let msg;
		try {
			msg = JSON.parse(data);
		} catch {
			return this.#violation(conn, "invalid json");
		}
		if (isPlainObject(msg) && typeof msg.v === "number" && msg.v !== PROTOCOL_VERSION) {
			// The proof before the verdict. A challenge of another version that
			// keeps the handshake core is checked like any challenge; if its proof
			// is right, it is the paired daemon that says "another version", and
			// that counts. Nothing is answered either way: no auth frame, so
			// nothing made from the key goes to a daemon this extension cannot
			// work with, let alone to a stranger.
			const theirs = conn.step === "challenge" ? coreFrameVersion(msg, MSG.CHALLENGE, DIRECTION.TO_EXT) : null;
			if (theirs !== null) {
				const expected = await computeMacS(conn.key, this.#transcript(conn, theirs, msg));
				if (conn.step !== "challenge") return;
				conn.verified = macMatches(expected, msg.mac_s);
			}
			this.#deps.log("link.protocol_version", { verified: conn.verified });
			return this.#abandon(conn, "protocol_version", CLOSE_BAD_FRAME);
		}
		const check = validateMessage(msg, DIRECTION.TO_EXT);
		if (!check.ok || !isPlainObject(msg)) return this.#violation(conn, check.ok ? "invalid" : check.error);

		if (conn.step === "challenge") {
			if (msg.type !== MSG.CHALLENGE) return this.#violation(conn, "expected challenge");
			return this.#onChallenge(conn, msg);
		}
		if (conn.step === "ready") {
			if (msg.type !== MSG.READY) return this.#violation(conn, "expected ready");
			return this.#onReady(conn, msg);
		}
		if (conn.step !== "up") return this.#violation(conn, "frame before hello");
		switch (msg.type) {
			case MSG.PING:
				this.#write(conn, makeMessage(MSG.PONG, { t: msg.t }));
				return;
			case MSG.PONG:
				return;
			case MSG.JOB_START:
			case MSG.JOB_CANCEL:
			case MSG.ATTENTION:
				this.#deps.handlers.onMessage(msg);
				return;
			default:
				return this.#violation(conn, "unexpected message");
		}
	}

	/**
	 * What the proofs on this connection cover. The port is the one this socket
	 * was dialled on, not one the peer names. The versions are the one this
	 * extension put in its hello and the one the challenge states.
	 * @param {Conn} conn
	 * @param {number} daemonVersion the "v" of the challenge
	 * @param {Record<string, unknown>} challenge its members, checked for their shape
	 * @returns {import("../shared/auth.js").Transcript}
	 */
	#transcript(conn, daemonVersion, challenge) {
		return {
			mode: conn.mode,
			port: conn.port,
			versionC: PROTOCOL_VERSION,
			versionS: daemonVersion,
			instance: String(challenge.instance),
			nonceC: conn.nonceC,
			nonceS: String(challenge.nonce_s),
		};
	}

	/**
	 * @param {Conn} conn
	 * @param {Record<string, unknown>} msg validated challenge
	 */
	async #onChallenge(conn, msg) {
		const transcript = this.#transcript(conn, PROTOCOL_VERSION, msg);
		const expected = await computeMacS(conn.key, transcript);
		if (conn.step !== "challenge") return;
		if (!macMatches(expected, msg.mac_s)) {
			// Whoever holds the port does not know the key. Leave without
			// sending anything that was made from it.
			this.#deps.log("link.daemon_unverified", { mode: conn.mode });
			return this.#abandon(conn, "daemon_unverified");
		}
		conn.verified = true;
		const macC = await computeMacC(conn.key, transcript);
		const derived = conn.mode === "pair" ? await deriveExtKey(conn.key, transcript.nonceC, transcript.nonceS) : null;
		if (conn.step !== "challenge") return;
		conn.derived = derived;
		conn.step = "ready";
		this.#write(conn, makeMessage(MSG.AUTH, { mac_c: b64urlEncode(macC), state: this.#deps.getState() }));
	}

	/**
	 * @param {Conn} conn
	 * @param {Record<string, unknown>} msg validated ready
	 */
	async #onReady(conn, msg) {
		if (!conn.verified) throw new Error("ready from a peer that was not verified");
		if (conn.mode === "pair") {
			if (conn.derived === null) throw new Error("pairing finished without a derived key");
			// The one place a stored key is replaced: the daemon proved that it
			// knows the code and then accepted this side's proof.
			await this.#deps.settings.setKey(conn.derived);
			conn.derived = null;
			if (conn.step !== "ready") return;
		}
		const limits = /** @type {{ max_result_bytes: number, ping_s: number }} */ (msg.limits);
		this.#maxResultBytes = Math.min(limits.max_result_bytes, LIMITS.MAX_RESULT_BYTES);
		this.#pingS = limits.ping_s;
		conn.step = "up";
		if (this.#handshakeTimer !== null) clearTimeout(this.#handshakeTimer);
		this.#handshakeTimer = null;
		this.#readySince = Date.now();
		this.#unverifiedAttempt = 0;
		this.#phase = PHASE.READY;
		this.#reason = null;
		this.#lastError = null;
		this.#retryAt = null;
		this.#armWatchdog(conn);
		this.#deps.log("link.ready", { mode: conn.mode });
		if (conn.mode === "pair") this.#pairDone({ ok: true });
		this.#deps.handlers.onStatus();
		this.#deps.handlers.onReady({ maxResultBytes: this.#maxResultBytes, pingS: this.#pingS });
	}

	/**
	 * The daemon pings every ping_s seconds. Silence for much longer means the
	 * socket is dead even if no close ever arrives.
	 * @param {Conn} conn
	 */
	#armWatchdog(conn) {
		this.#watchdogTimer = setTimeout(() => {
			this.#watchdogTimer = null;
			if (this.#conn !== conn || conn.step !== "up") return;
			if (Date.now() - this.#lastRx > this.#pingS * 2500) {
				this.#deps.log("link.silent", {});
				return this.#abandon(conn, "silent");
			}
			this.#armWatchdog(conn);
		}, this.#pingS * 500);
	}
}
