// Handshake and pairing crypto, shared by the daemon (Node) and the extension
// background page. Standard JS plus the global WebCrypto object only - no Node
// built-ins, no DOM.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const REVERSE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) REVERSE[ALPHABET.charCodeAt(i)] = i;

export const NONCE_BYTES = 32;
export const KEY_BYTES = 32;
export const MAC_BYTES = 32;
/** Length of an unpadded base64url string that encodes 32 bytes. */
export const B64URL_32_LENGTH = 43;
export const B64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Daemon instance id as carried in the challenge. */
export const INSTANCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const PAIRING_PREFIX = "bgw1";
export const EXT_KEY_INFO = "bgw1 ext key";

/**
 * Bytes that own a plain ArrayBuffer - the only kind WebCrypto accepts.
 * @typedef {Uint8Array<ArrayBuffer>} Bytes
 */

const encoder = new TextEncoder();

/**
 * @param {string} text
 * @returns {Bytes}
 */
export function utf8(text) {
	return encoder.encode(text);
}

/**
 * Unpadded base64url (RFC 4648 section 5).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function b64urlEncode(bytes) {
	let out = "";
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
		out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
	}
	if (i + 1 === bytes.length) {
		const n = bytes[i] << 16;
		out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63];
	} else if (i + 2 === bytes.length) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
		out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
	}
	return out;
}

/**
 * Strict decoder: unpadded, alphabet only, and the unused trailing bits must be
 * zero, so every byte string has exactly one accepted encoding.
 * @param {unknown} text
 * @returns {Bytes | null} null when the input is not canonical base64url
 */
export function b64urlDecode(text) {
	if (typeof text !== "string") return null;
	const rem = text.length % 4;
	if (rem === 1) return null;
	const out = new Uint8Array(Math.floor((text.length * 3) / 4));
	let acc = 0;
	let bits = 0;
	let o = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		const v = c < 128 ? REVERSE[c] : -1;
		if (v < 0) return null;
		acc = (acc << 6) | v;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[o++] = (acc >> bits) & 0xff;
			acc &= (1 << bits) - 1;
		}
	}
	if (acc !== 0) return null;
	return out;
}

/**
 * @param {number} length
 * @returns {Bytes}
 */
export function randomBytes(length) {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

/**
 * A fresh handshake nonce: 32 random bytes as base64url (43 characters).
 * @returns {string}
 */
export function randomNonce() {
	return b64urlEncode(randomBytes(NONCE_BYTES));
}

/**
 * @param {Bytes} key
 * @param {Bytes | string} data strings are encoded as UTF-8
 * @returns {Promise<Bytes>} 32 bytes
 */
export async function hmacSha256(key, data) {
	if (!(key instanceof Uint8Array) || key.length === 0) throw new TypeError("hmac key must be a non-empty Uint8Array");
	const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", k, typeof data === "string" ? utf8(data) : data);
	return new Uint8Array(sig);
}

/**
 * HKDF-SHA256 (RFC 5869), extract and expand.
 * @param {Bytes} ikm
 * @param {Bytes} salt
 * @param {Bytes | string} info
 * @param {number} length output length in bytes
 * @returns {Promise<Bytes>}
 */
export async function hkdfSha256(ikm, salt, info, length) {
	const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt, info: typeof info === "string" ? utf8(info) : info },
		k,
		length * 8,
	);
	return new Uint8Array(bits);
}

/**
 * Compare without an early exit. Only the lengths are allowed to leak.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

/** @param {string} nonce */
function assertNonce(nonce) {
	// Fixed length and an alphabet without "|" keep the MAC input unambiguous.
	if (typeof nonce !== "string" || !B64URL_32_PATTERN.test(nonce)) throw new TypeError("nonce must be 43 base64url characters");
}

/**
 * What both handshake MACs cover: the mode the extension asked for, the port
 * the link runs over, the protocol versions of both sides, the daemon's
 * instance id from the challenge, and both nonces.
 *
 * The port is never taken from a frame. Each side fills in the one it knows by
 * itself: the daemon the port it listens on, the extension the port it
 * dialled. A proof made for one port is then worth nothing on another. Whoever
 * sits on the port the extension dials cannot pass the hello on to a daemon
 * that listens elsewhere and hand back its answer: that answer names the
 * daemon's port, and the extension checks it against its own.
 *
 * The versions are the ones the frames state: versionC stands in the hello,
 * versionS in the challenge. Each side fills in its own from what it sent and
 * the other's from what it received. So a proof also says "a daemon of this
 * version answered a hello of that version", and the extension can judge a
 * difference between the two after it has checked the proof. A version
 * number that was changed on the way makes the proof wrong: a peer in the
 * middle can neither make two equal versions look different nor two
 * different ones look equal.
 *
 * Since protocol version 5 this form is fixed, together with the members of
 * hello and challenge (see HANDSHAKE_CORE_SINCE in protocol.js): a later
 * version must make and check both proofs exactly like this, or an extension
 * and a daemon of different versions can no longer tell each other so.
 * @typedef {object} Transcript
 * @property {"auth" | "pair"} mode
 * @property {number} port 1 to 65535
 * @property {number} versionC the protocol version in the extension's hello
 * @property {number} versionS the protocol version in the daemon's challenge
 * @property {string} instance
 * @property {string} nonceC
 * @property {string} nonceS
 */

/**
 * The parts are joined with "|", always in the same order. None of them can
 * contain it: the mode is one of two words, the port and the two versions are
 * written in decimal digits without leading zeros, the rest is base64url.
 * Anything else is refused here, so two different transcripts can never
 * produce the same MAC input.
 * @param {Transcript} t
 */
function assertTranscript(t) {
	if (t.mode !== "auth" && t.mode !== "pair") throw new TypeError("mode must be auth or pair");
	if (typeof t.instance !== "string" || !INSTANCE_PATTERN.test(t.instance)) {
		throw new TypeError("instance must be 1 to 64 base64url characters");
	}
	assertNonce(t.nonceC);
	assertNonce(t.nonceS);
}

/**
 * @param {unknown} port
 * @returns {string} the one spelling of a port: "8791", never "08791", "8791.0" or "8.791e3"
 */
function portText(port) {
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("port must be an integer from 1 to 65535");
	return String(port);
}

/**
 * @param {unknown} version
 * @returns {string} the one spelling of a protocol version: digits only (a whole number that is safe to count with never prints as "1e+21")
 */
function versionText(version) {
	if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new TypeError("protocol version must be a positive whole number");
	return String(version);
}

/**
 * The middle of both MAC inputs: what is the same in the two directions.
 * @param {Transcript} t
 * @returns {string} mode + "|" + port + "|" + versionC + "|" + versionS + "|" + instance
 */
function commonParts(t) {
	assertTranscript(t);
	return t.mode + "|" + portText(t.port) + "|" + versionText(t.versionC) + "|" + versionText(t.versionS) + "|" + t.instance;
}

/**
 * Daemon proof:
 * HMAC(K, "bgw1|s|" + mode + "|" + port + "|" + version_c + "|" + version_s + "|" + instance + "|" + nonce_c + "|" + nonce_s).
 * @param {Bytes} key
 * @param {Transcript} t
 * @returns {Promise<Bytes>}
 */
export async function computeMacS(key, t) {
	return hmacSha256(key, "bgw1|s|" + commonParts(t) + "|" + t.nonceC + "|" + t.nonceS);
}

/**
 * Extension proof:
 * HMAC(K, "bgw1|c|" + mode + "|" + port + "|" + version_c + "|" + version_s + "|" + instance + "|" + nonce_s + "|" + nonce_c).
 * @param {Bytes} key
 * @param {Transcript} t
 * @returns {Promise<Bytes>}
 */
export async function computeMacC(key, t) {
	return hmacSha256(key, "bgw1|c|" + commonParts(t) + "|" + t.nonceS + "|" + t.nonceC);
}

/**
 * @param {Uint8Array} expected
 * @param {unknown} presented base64url text as received from the peer
 * @returns {boolean}
 */
export function macMatches(expected, presented) {
	const bytes = b64urlDecode(presented);
	return bytes !== null && timingSafeEqual(expected, bytes);
}

/**
 * Long-lived extension key from a pairing handshake:
 * HKDF-SHA256(ikm = code, salt = nonce_c || nonce_s as raw bytes, info = "bgw1 ext key").
 * @param {Bytes} codeKey see pairingKey()
 * @param {string} nonceC
 * @param {string} nonceS
 * @returns {Promise<Bytes>} 32 bytes
 */
export async function deriveExtKey(codeKey, nonceC, nonceS) {
	assertNonce(nonceC);
	assertNonce(nonceS);
	const c = b64urlDecode(nonceC);
	const s = b64urlDecode(nonceS);
	if (c === null || s === null || c.length !== NONCE_BYTES || s.length !== NONCE_BYTES) {
		throw new TypeError("nonce is not canonical base64url");
	}
	const salt = new Uint8Array(NONCE_BYTES * 2);
	salt.set(c, 0);
	salt.set(s, NONCE_BYTES);
	return hkdfSha256(codeKey, salt, EXT_KEY_INFO, KEY_BYTES);
}

/**
 * @param {number} port
 * @param {Uint8Array} secret 32 bytes
 * @returns {string} "bgw1.<port>.<base64url secret>"
 */
export function formatPairingCode(port, secret) {
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("invalid port");
	if (!(secret instanceof Uint8Array) || secret.length !== KEY_BYTES) throw new RangeError("secret must be 32 bytes");
	return `${PAIRING_PREFIX}.${port}.${b64urlEncode(secret)}`;
}

/**
 * @param {number} port
 * @returns {string}
 */
export function generatePairingCode(port) {
	return formatPairingCode(port, randomBytes(KEY_BYTES));
}

/**
 * @param {unknown} text surrounding whitespace is ignored (the code is pasted by hand)
 * @returns {{ ok: true, code: string, port: number, secret: Bytes } | { ok: false, error: string }}
 */
export function parsePairingCode(text) {
	if (typeof text !== "string") return { ok: false, error: "not a string" };
	const code = text.trim();
	if (code.length > 64) return { ok: false, error: "too long" };
	const m = /^bgw1\.([1-9][0-9]{0,4})\.([A-Za-z0-9_-]{43})$/.exec(code);
	if (m === null) return { ok: false, error: "malformed" };
	const port = Number(m[1]);
	if (port > 65535) return { ok: false, error: "invalid port" };
	const secret = b64urlDecode(m[2]);
	if (secret === null || secret.length !== KEY_BYTES) return { ok: false, error: "malformed secret" };
	return { ok: true, code, port, secret };
}

/**
 * In pair mode K is the one-time code itself: the UTF-8 bytes of the canonical
 * code string (as returned by parsePairingCode). Used as the HMAC key and as
 * the HKDF input keying material.
 * @param {string} code
 * @returns {Bytes}
 */
export function pairingKey(code) {
	const parsed = parsePairingCode(code);
	if (!parsed.ok || parsed.code !== code) throw new TypeError("not a canonical pairing code");
	return utf8(code);
}
