import path from "node:path";
import crypto from "node:crypto";
import { ensurePrivateDir, readPrivateFile, writePrivateFile, LIMITS } from "./config.js";
import {
	b64urlDecode,
	b64urlEncode,
	generatePairingCode,
	pairingKey,
	randomBytes,
	B64URL_32_PATTERN,
	KEY_BYTES,
} from "../../extension/shared/auth.js";

/**
 * An active one-time pairing code. Lives in memory only.
 * @typedef {object} PairingCode
 * @property {string} code
 * @property {import("../../extension/shared/auth.js").Bytes} key HMAC key and HKDF input for a pair-mode handshake
 * @property {number} expiresAt
 */

/** Proof nonces of the CLI: base64url of 16 to 64 bytes. */
export const PROOF_NONCE_BYTES = Object.freeze({ min: 16, max: 64 });

/**
 * @param {unknown} nonce
 * @returns {nonce is string} canonical unpadded base64url of 16 to 64 bytes
 */
export function isProofNonce(nonce) {
	if (typeof nonce !== "string" || nonce.length < 22 || nonce.length > 86) return false;
	const bytes = b64urlDecode(nonce);
	return bytes !== null && bytes.length >= PROOF_NONCE_BYTES.min && bytes.length <= PROOF_NONCE_BYTES.max;
}

/**
 * The daemon's credentials:
 * - client.token: bearer token for agents, created on first start.
 * - admin.token: bearer token for the operator, created on first start. It
 *   mints pairing codes and does nothing else; the client token cannot. So a
 *   leaked agent token never lets its holder pair a fake extension.
 * - ext.key: long-lived extension key, written when a pairing completes.
 * - at most one pairing code at a time, never written to disk.
 *
 * The tokens are 256 bits of randomness and so is the pairing code: nothing
 * here counts or throttles wrong guesses. A code ends by being used or
 * by its ten minutes running out.
 *
 * Besides comparing a presented token, the daemon can prove that it holds one:
 * prove() and pairProof() answer a caller's nonce with an HMAC under
 * the token, so the CLI can tell the daemon from a process that merely sits on
 * the port before it sends the token itself. Both MACs cover the port the
 * daemon listens on: a proof made by a daemon on another port, should
 * one hold the same tokens, is worth nothing to whoever passes it on. The MAC
 * is the only thing about a token that ever leaves this class.
 */

/** @param {unknown} port */
function assertPort(port) {
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("port must be an integer from 1 to 65535");
}

export class Secrets {
	#tokenFile;
	#adminTokenFile;
	#keyFile;
	#clock;
	#log;
	/** @type {Buffer} SHA-256 of the client token, for constant-time comparison */
	#tokenDigest = Buffer.alloc(0);
	/** @type {Buffer} SHA-256 of the admin token */
	#adminDigest = Buffer.alloc(0);
	/** @type {Buffer} the client token as it stands in its file (UTF-8), the HMAC key of its proofs */
	#tokenKey = Buffer.alloc(0);
	/** @type {Buffer} the admin token likewise */
	#adminKey = Buffer.alloc(0);
	/** @type {import("../../extension/shared/auth.js").Bytes | null} */
	#extKey = null;
	/** @type {PairingCode | null} */
	#pairing = null;

	/**
	 * @param {{ configDir: string, clock: import("./log.js").Clock, log: import("./log.js").Logger }} opts
	 */
	constructor({ configDir, clock, log }) {
		this.configDir = configDir;
		this.#tokenFile = path.join(configDir, "client.token");
		this.#adminTokenFile = path.join(configDir, "admin.token");
		this.#keyFile = path.join(configDir, "ext.key");
		this.#clock = clock;
		this.#log = log;
	}

	/** @param {string} file a secret that others could read or write until now */
	#modeFixed = (file) => {
		this.#log.warn("secrets.file_mode_fixed", { file });
	};

	/**
	 * @param {string} file
	 * @param {string} createdEvent
	 * @returns {Buffer} the token in the file (UTF-8), which is created if missing
	 */
	#loadOrCreateToken(file, createdEvent) {
		const text = readPrivateFile(file, this.#modeFixed);
		/** @type {string} */
		let token;
		if (text === null) {
			token = b64urlEncode(crypto.randomBytes(KEY_BYTES));
			writePrivateFile(file, token + "\n");
			this.#log.info(createdEvent, { file });
		} else {
			token = text.trim();
			if (!B64URL_32_PATTERN.test(token)) {
				throw new Error(`${file} is damaged; delete it and restart to create a new token`);
			}
		}
		return Buffer.from(token, "utf8");
	}

	/** Create the config dir and both token files as needed and load ext.key. */
	init() {
		if (ensurePrivateDir(this.configDir).tightened) this.#log.warn("config.dir_mode_fixed", { dir: this.configDir });

		const tokenKey = this.#loadOrCreateToken(this.#tokenFile, "secrets.client_token_created");
		const adminKey = this.#loadOrCreateToken(this.#adminTokenFile, "secrets.admin_token_created");
		const tokenDigest = crypto.createHash("sha256").update(tokenKey).digest();
		const adminDigest = crypto.createHash("sha256").update(adminKey).digest();
		if (crypto.timingSafeEqual(tokenDigest, adminDigest)) {
			// One token in both files would hand every agent the pairing right.
			throw new Error(`${this.#adminTokenFile} and ${this.#tokenFile} hold the same token; delete one of them and restart`);
		}
		this.#tokenDigest = tokenDigest;
		this.#adminDigest = adminDigest;
		this.#tokenKey = tokenKey;
		this.#adminKey = adminKey;

		const keyText = readPrivateFile(this.#keyFile, this.#modeFixed);
		if (keyText !== null) {
			const key = b64urlDecode(keyText.trim());
			if (key !== null && key.length === KEY_BYTES) {
				this.#extKey = key;
			} else {
				// Fail closed: nothing can authenticate until the operator pairs again.
				this.#log.warn("secrets.ext_key_unreadable", { file: this.#keyFile });
			}
		}
	}

	/**
	 * Which credential is this? Both comparisons always run, in constant time.
	 * @param {string} presented
	 * @returns {"client" | "admin" | null}
	 */
	tokenRole(presented) {
		// Hashing first makes the comparison independent of the presented length.
		const digest = crypto.createHash("sha256").update(presented).digest();
		const isClient = this.#tokenDigest.length === digest.length && crypto.timingSafeEqual(digest, this.#tokenDigest);
		const isAdmin = this.#adminDigest.length === digest.length && crypto.timingSafeEqual(digest, this.#adminDigest);
		if (isClient) return "client";
		return isAdmin ? "admin" : null;
	}

	/**
	 * Proof that this daemon holds the token of a role:
	 * HMAC-SHA256(token, "bgw1|prove|" + role + "|" + port + "|" + nonce),
	 * unpadded base64url. The key is the token text as it stands in its file.
	 * The fixed prefix keeps the MAC from meaning anything anywhere else; the
	 * port keeps it from meaning anything on another port. None of the
	 * parts can hold a "|".
	 * @param {"client" | "admin"} role
	 * @param {number} port the port this daemon listens on, in decimal
	 * @param {string} nonce checked with isProofNonce()
	 * @returns {string}
	 */
	prove(role, port, nonce) {
		if (role !== "client" && role !== "admin") throw new TypeError("role must be client or admin");
		assertPort(port);
		if (!isProofNonce(nonce)) throw new TypeError("nonce must be base64url of 16 to 64 bytes");
		const key = role === "admin" ? this.#adminKey : this.#tokenKey;
		if (key.length === 0) throw new Error("secrets are not loaded");
		return crypto.createHmac("sha256", key).update(`bgw1|prove|${role}|${port}|${nonce}`, "utf8").digest("base64url");
	}

	/**
	 * Proof that a pairing code comes from this daemon:
	 * HMAC-SHA256(admin token, "bgw1|pair|" + port + "|" + nonce + "|" + code).
	 * @param {number} port the port this daemon listens on
	 * @param {string} nonce checked with isProofNonce()
	 * @param {string} code
	 * @returns {string}
	 */
	pairProof(port, nonce, code) {
		assertPort(port);
		if (!isProofNonce(nonce)) throw new TypeError("nonce must be base64url of 16 to 64 bytes");
		if (this.#adminKey.length === 0) throw new Error("secrets are not loaded");
		return crypto.createHmac("sha256", this.#adminKey).update(`bgw1|pair|${port}|${nonce}|${code}`, "utf8").digest("base64url");
	}

	isPaired() {
		return this.#extKey !== null;
	}

	/** @returns {import("../../extension/shared/auth.js").Bytes | null} */
	extKey() {
		return this.#extKey;
	}

	/**
	 * Store the key derived by a completed pairing.
	 * @param {import("../../extension/shared/auth.js").Bytes} key
	 */
	setExtKey(key) {
		if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new Error("extension key must be 32 bytes");
		const replaced = this.#extKey !== null;
		writePrivateFile(this.#keyFile, b64urlEncode(key) + "\n");
		this.#extKey = key;
		if (replaced) this.#log.warn("pairing.ext_key_replaced", { file: this.#keyFile });
		else this.#log.info("pairing.ext_key_created", { file: this.#keyFile });
	}

	/**
	 * Mint a new one-time code. Any earlier code stops working.
	 * @param {number} port the port the extension must dial
	 * @returns {{ code: string, expiresInS: number }}
	 */
	startPairing(port) {
		const code = generatePairingCode(port);
		this.#pairing = {
			code,
			key: pairingKey(code),
			expiresAt: this.#clock.now() + LIMITS.pairingTtlMs,
		};
		this.#log.info("pairing.code_issued", { ttl_s: LIMITS.pairingTtlMs / 1000 });
		return { code, expiresInS: LIMITS.pairingTtlMs / 1000 };
	}

	/** @returns {PairingCode | null} the code while it is still usable */
	activePairing() {
		const p = this.#pairing;
		if (p === null) return null;
		if (this.#clock.now() >= p.expiresAt) {
			this.#pairing = null;
			this.#log.info("pairing.code_expired");
			return null;
		}
		return p;
	}

	/**
	 * A key of the same kind as a pairing code's, known to nobody. A pair-mode
	 * hello gets its challenge from this when no code is pending, so the answer
	 * looks and costs the same either way.
	 * @param {number} port
	 * @returns {import("../../extension/shared/auth.js").Bytes}
	 */
	throwawayPairingKey(port) {
		return pairingKey(generatePairingCode(port));
	}

	/**
	 * A key of the same kind as the extension key, known to nobody. An auth-mode
	 * hello gets its challenge from this while no extension is paired, so the
	 * answer looks and costs the same whether a key is stored or not.
	 * @returns {import("../../extension/shared/auth.js").Bytes}
	 */
	throwawayExtKey() {
		return randomBytes(KEY_BYTES);
	}

	/**
	 * Use the code up. Returns false when it is no longer the active code, in
	 * which case the handshake must be refused.
	 * @param {PairingCode} pairing
	 * @returns {boolean}
	 */
	consumePairing(pairing) {
		if (this.activePairing() !== pairing) return false;
		this.#pairing = null;
		return true;
	}
}
