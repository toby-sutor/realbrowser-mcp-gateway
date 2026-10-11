// What the extension remembers (storage.local) and the optional dev-config.json
// that exists only in a test copy of the extension. The release XPI never
// contains that file (tools/build-xpi.sh refuses to package it).
//
// The pairing key is not in storage.local. Any script of the extension can
// read and write that store, the content scripts that run in untrusted pages
// among them; the key is kept where they cannot reach, in the storage of the
// extension's own pages (shared/ownstore.js), as the second copy of the login
// rules is.
//
// Builds from before the first public release kept it in storage.local, under "extKey". The first start
// of a build that knows better moves it: the key is written to the own store,
// read back from there, and only then taken out of storage.local. Whatever
// fails on the way, the key stays where it was and is used from there; the
// next start tries again. From the moment the own store holds a value - a key,
// or the empty text for "none" - its word alone counts: a value that turns up
// in storage.local afterwards is not a key, whoever put it there, and is
// removed. (So a build from before the move, put back in place of this one,
// finds no key and asks to be paired; and a key it stores then is not taken
// over when this build returns.)
//
// One thing is left in storage.local: "keyMoved", which says no more than that
// the key is kept elsewhere. It is read in one case only - the own store
// cannot be read at a start. Without it that browser has never had such a
// store, and storage.local is where its key is, as before. With it a key may
// lie where nobody can read it right now: the extension is without a key for
// that session, takes none from storage.local, and refuses to pair (a pairing
// could not be kept) until the browser is started again.

import { b64urlDecode, b64urlEncode, KEY_BYTES } from "../shared/auth.js";

export const DEFAULT_PORT = 8791;

/**
 * @typedef {import("../shared/auth.js").Bytes} Bytes
 *
 * @typedef {object} DevConfig
 * @property {number} port daemon port of the test run
 * @property {string} extKey pre-shared extension key, base64url of 32 bytes
 * @property {number[]} allowLoopbackPorts fixture ports that pass the URL policy
 * @property {string[]} blocklistExtra added to the default blocklist (it can only tighten)
 * @property {number | null} hookPort test control channel, see devhook.js
 * @property {DevTuning | null} tuning shorter waits for a test run, so that a test of a challenge need not sit
 *   through a grace period of up to twenty seconds
 *
 * @typedef {object} DevTuning
 * @property {{ graceMs?: [number, number], gracePollMs?: number, forceHidden?: boolean, scrollGrowMs?: number }} jobs
 * @property {{ pollMs?: number, clearStableMs?: number }} park
 * @property {{ minGapMs?: number, perHour?: number }} login the rate limit of a login rule, so that a test of it
 *   need not wait ten seconds between two pages
 *
 * @typedef {object} StorageArea the part of browser.storage.local used here
 * @property {(keys: string[]) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 *
 * @typedef {object} KeyStore the pairing key's place in the storage of the extension's own pages (ownstore.js, pairingStore)
 * @property {() => Promise<string | null>} get the key as text; "": none is kept; null: nothing was ever kept here
 * @property {(value: string) => Promise<void>} set
 *
 * @typedef {"own" | "local" | "nowhere"} KeyHome where the key is kept in this session. local: storage.local, in a
 *   browser that has never let the own store be used; nowhere: the own store has it, or may, and cannot be read
 */

/** @param {unknown} v @returns {v is number} */
function isPort(v) {
	return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
}

/**
 * Strict: anything unexpected makes the whole file unusable, so a damaged
 * file can never widen the policy by accident.
 * @param {unknown} raw
 * @returns {DevConfig | null}
 */
export function parseDevConfig(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const o = /** @type {Record<string, unknown>} */ (raw);
	for (const key of Object.keys(o)) {
		if (!["port", "extKey", "allowLoopbackPorts", "blocklistExtra", "hookPort", "tuning"].includes(key)) return null;
	}
	if (!isPort(o.port)) return null;
	if (typeof o.extKey !== "string") return null;
	const key = b64urlDecode(o.extKey);
	if (key === null || key.length !== KEY_BYTES) return null;
	const ports = o.allowLoopbackPorts ?? [];
	if (!Array.isArray(ports) || ports.length > 8 || !ports.every(isPort)) return null;
	const extra = o.blocklistExtra ?? [];
	if (!Array.isArray(extra) || extra.length > 32 || !extra.every((e) => typeof e === "string" && /^[a-z0-9.-]{1,253}$/.test(e))) return null;
	const hookPort = o.hookPort ?? null;
	if (hookPort !== null && !isPort(hookPort)) return null;
	/** @type {DevTuning | null} */
	let tuning = null;
	if (o.tuning !== undefined) {
		const t = o.tuning;
		if (typeof t !== "object" || t === null || Array.isArray(t)) return null;
		const tt = /** @type {Record<string, unknown>} */ (t);
		/** @param {unknown} v */
		const isMs = (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 60000;
		for (const key of Object.keys(tt)) {
			if (!["graceMs", "gracePollMs", "parkPollMs", "clearStableMs", "loginGapMs", "loginPerHour", "forceHidden", "scrollGrowMs"].includes(key)) return null;
			if (key === "forceHidden") {
				if (typeof tt.forceHidden !== "boolean") return null;
				continue;
			}
			if (key === "graceMs" ? !(Array.isArray(tt.graceMs) && tt.graceMs.length === 2 && tt.graceMs.every(isMs) && tt.graceMs[0] <= tt.graceMs[1]) : !isMs(tt[key])) return null;
		}
		tuning = { jobs: {}, park: {}, login: {} };
		if (typeof tt.loginGapMs === "number") tuning.login.minGapMs = tt.loginGapMs;
		if (typeof tt.loginPerHour === "number") tuning.login.perHour = tt.loginPerHour;
		if (Array.isArray(tt.graceMs)) tuning.jobs.graceMs = [tt.graceMs[0], tt.graceMs[1]];
		if (typeof tt.gracePollMs === "number") tuning.jobs.gracePollMs = tt.gracePollMs;
		// How long a feed that keeps loading more is followed, so that a test of its bound need not take twenty seconds.
		if (typeof tt.scrollGrowMs === "number") tuning.jobs.scrollGrowMs = tt.scrollGrowMs;
		// Tests only: makes every job tab count as hidden, which a headless browser cannot produce.
		if (tt.forceHidden === true) tuning.jobs.forceHidden = true;
		if (typeof tt.parkPollMs === "number") tuning.park.pollMs = tt.parkPollMs;
		if (typeof tt.clearStableMs === "number") tuning.park.clearStableMs = tt.clearStableMs;
	}
	return { port: o.port, extKey: o.extKey, allowLoopbackPorts: [...ports], blocklistExtra: [...extra], hookPort, tuning };
}

/**
 * @param {string} url extension URL of dev-config.json
 * @param {(url: string) => Promise<{ ok: boolean, json: () => Promise<unknown> }>} [fetchImpl]
 * @returns {Promise<{ present: boolean, config: DevConfig | null }>} present but null: the file is damaged
 */
export async function loadDevConfig(url, fetchImpl = fetch) {
	/** @type {unknown} */
	let raw;
	try {
		const res = await fetchImpl(url);
		if (!res.ok) return { present: false, config: null };
		raw = await res.json();
	} catch {
		// A missing packaged file makes fetch reject: the normal case.
		return { present: false, config: null };
	}
	return { present: true, config: parseDevConfig(raw) };
}

/**
 * @param {unknown} text
 * @returns {Bytes | null} the key that text stands for; null: it is none
 */
function keyFrom(text) {
	const key = typeof text === "string" ? b64urlDecode(text) : null;
	return key !== null && key.length === KEY_BYTES ? key : null;
}

/**
 * In-memory view of the stored settings. Every setter writes through.
 */
export class Settings {
	#storage;
	/** @type {KeyStore | null} */
	#own;
	#log;
	/** @type {KeyHome} */
	#keyHome = "local";
	/** storage.local says that the key is kept in the own store. */
	#marked = false;
	#port = DEFAULT_PORT;
	/** @type {Bytes | null} */
	#key = null;
	#paused = false;
	/** @type {string | null} */
	#pauseReason = null;
	/** @type {string | null} */
	#containerId = null;
	/** @type {number | null} set by a dev config; wins over the stored port */
	#portOverride = null;

	/**
	 * @param {StorageArea} storage
	 * @param {KeyStore | null} [own] where the pairing key is kept. Absent: a browser without such a place - the key
	 *   stays in storage.local
	 * @param {(event: string, fields?: Record<string, string | number | boolean | null>) => void} [log] never given a key
	 */
	constructor(storage, own = null, log = () => {}) {
		this.#storage = storage;
		this.#own = own;
		this.#log = log;
	}

	/** @param {DevConfig | null} [dev] */
	async load(dev = null) {
		const st = await this.#storage.get(["port", "extKey", "keyMoved", "paused", "pauseReason", "containerId"]);
		if (isPort(st.port)) this.#port = st.port;
		this.#key = await this.#findKey(st.extKey, st.keyMoved === true);
		this.#paused = st.paused === true;
		this.#pauseReason = this.#paused && typeof st.pauseReason === "string" ? st.pauseReason.slice(0, 200) : null;
		this.#containerId = typeof st.containerId === "string" ? st.containerId : null;
		if (dev !== null) {
			this.#portOverride = dev.port;
			// Seed only: a key from a later pairing stays in place. And not where a key may lie that cannot be read.
			if (this.#key === null && this.#keyHome !== "nowhere") await this.setKey(/** @type {Bytes} */ (b64urlDecode(dev.extKey)));
		}
	}

	/**
	 * Find the pairing key, and move it out of storage.local if that is where a build before this one left it
	 * (see the top of this file). Never throws, and never leaves the extension without a key it had.
	 * @param {unknown} legacy what storage.local holds under "extKey"
	 * @param {boolean} moved storage.local says the key is kept in the own store
	 * @returns {Promise<Bytes | null>}
	 */
	async #findKey(legacy, moved) {
		const own = this.#own;
		const old = keyFrom(legacy);
		this.#marked = moved;
		/** @type {string | null | undefined} undefined: the own store cannot be read */
		let kept = undefined;
		try {
			if (own !== null) kept = await own.get();
		} catch {
			kept = undefined;
		}
		if (own === null || kept === undefined) {
			if (moved) {
				// A key may lie where it cannot be read. Not replaced by whatever storage.local holds now.
				this.#keyHome = "nowhere";
				this.#log("settings.key_store_unavailable", {});
				return null;
			}
			this.#keyHome = "local";
			if (own !== null) this.#log("settings.key_not_moved", { step: "read" });
			return old;
		}
		if (kept === null) {
			// The first start of a build that keeps the key in the own store: the copy, then the proof that it is there.
			const text = old === null ? "" : b64urlEncode(old);
			try {
				await own.set(text);
				if ((await own.get()) !== text) throw new Error("the own store did not give the value back");
			} catch {
				this.#keyHome = "local";
				this.#log("settings.key_not_moved", { step: "copy" });
				return old;
			}
			kept = text;
			if (old !== null) this.#log("settings.key_moved", {});
		} else if (old !== null && b64urlEncode(old) !== kept) {
			// Not the key that is kept here: put there by a build from before the move, or by somebody else.
			this.#log("settings.key_in_storage_local_ignored", {});
		}
		// From here on the own store's word counts, and nothing in storage.local is a key.
		this.#keyHome = "own";
		await this.#mark();
		if (legacy !== undefined) await this.#dropOldCopy();
		return keyFrom(kept);
	}

	/** Say in storage.local that the key is kept elsewhere (see the top of this file). Tried again with the next write if it fails. */
	async #mark() {
		if (this.#marked) return;
		try {
			await this.#storage.set({ keyMoved: true });
			this.#marked = true;
		} catch {
			// not said; said with the next write of the key, or at the next start
		}
	}

	/** Take what is left under "extKey" out of storage.local. What cannot be removed is not read again either way. */
	async #dropOldCopy() {
		try {
			await this.#storage.remove("extKey");
		} catch {
			this.#log("settings.key_copy_left", {});
		}
	}

	/**
	 * @returns {boolean} true when a key may be kept where it cannot be read in this session: the extension has none
	 *   to use, and a new pairing could not be kept. Ends with the next start of the browser
	 */
	get keyStoreDown() {
		return this.#keyHome === "nowhere";
	}

	get port() {
		return this.#portOverride ?? this.#port;
	}

	/** @param {number} port */
	async setPort(port) {
		if (!isPort(port)) throw new RangeError("invalid port");
		this.#port = port;
		this.#portOverride = null;
		await this.#storage.set({ port });
	}

	/** @returns {Bytes | null} the long-lived extension key; never log it */
	get key() {
		return this.#key;
	}

	/**
	 * @param {Bytes} key
	 * @throws when the key could not be stored; it is the key of this session all the same
	 */
	async setKey(key) {
		if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new RangeError("extension key must be 32 bytes");
		this.#key = key;
		await this.#keep(b64urlEncode(key));
	}

	/** @throws when the key could not be removed from where it is kept */
	async clearKey() {
		this.#key = null;
		await this.#keep("");
	}

	/**
	 * Write the key, or that there is none, to where it is kept.
	 * @param {string} text the key as text; "": none
	 */
	async #keep(text) {
		const own = this.#own;
		if (own === null || this.#keyHome === "local") {
			if (text === "") await this.#storage.remove("extKey");
			else await this.#storage.set({ extKey: text });
			return;
		}
		await own.set(text);
		if ((await own.get()) !== text) throw new Error("the own store did not give the value back");
		// Also where it could not be read at the start: it can now.
		this.#keyHome = "own";
		await this.#mark();
	}

	get paused() {
		return this.#paused;
	}

	get pauseReason() {
		return this.#pauseReason;
	}

	/**
	 * @param {boolean} paused
	 * @param {string | null} reason
	 */
	async setPaused(paused, reason) {
		this.#paused = paused;
		this.#pauseReason = paused ? reason : null;
		await this.#storage.set({ paused: this.#paused, pauseReason: this.#pauseReason });
	}

	get containerId() {
		return this.#containerId;
	}

	/** @param {string | null} id */
	async setContainerId(id) {
		this.#containerId = id;
		if (id === null) await this.#storage.remove("containerId");
		else await this.#storage.set({ containerId: id });
	}
}
