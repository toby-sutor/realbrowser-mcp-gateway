// Login opt-in, as the background page sees it: the rules the operator set in
// the options page, read and never written, and the rate limit of each rule.
//
// A fetch whose URL lies inside a rule runs in the operator's own cookie store
// instead of the gateway container. Which store a job gets is decided here, in
// the extension, from the job's URL and these rules alone. Nothing that
// arrives over the link to the daemon can add a rule, change one or ask for
// the operator's store: this module has no method that writes a rule, and no
// message of the protocol reaches it.

import { matchOptInRule, optInRuleKey } from "../shared/policy.js";
import { LOGIN_LIMITS, OPTIN_STORAGE_KEY, readOptInRules } from "../shared/optin.js";

/** The cookie store of the browser's ordinary, non-private windows. */
export const DEFAULT_STORE_ID = "firefox-default";

export { LOGIN_LIMITS };

const HOUR_MS = 3600000;
// Rules whose use is remembered. A rule that was removed and set again is the same rule.
const MAX_TRACKED = 200;

/**
 * @typedef {import("../shared/policy.js").OptInRule} OptInRule
 * @typedef {import("../shared/policy.js").OptInOptions} OptInOptions
 *
 * @typedef {object} OptInDeps
 * @property {{ get: (keys: string[]) => Promise<Record<string, unknown>> }} storage storage.local: read, never written
 * @property {() => Promise<string | null>} shadow the copy in the extension's own page storage; null when there is none
 * @property {{ addListener: (fn: (changes: Record<string, unknown>, area: string) => void) => void } | undefined} onChanged
 *   storage.onChanged
 * @property {OptInOptions} policy the blocklist, and the fixture ports of a test build
 * @property {(event: string, fields?: Record<string, string | number | boolean | null>) => void} log
 * @property {() => void} onChange the rules in force changed
 * @property {() => number} [now]
 * @property {{ minGapMs?: number, perHour?: number }} [limits] a test build may shorten them; a release build has no way to
 * @property {readonly number[]} [retryMs] when to look again after the two copies did not agree
 */

/**
 * At most one use per gap and so many an hour, per key.
 */
export class LoginLimiter {
	#now;
	#minGapMs;
	#perHour;
	/** @type {Map<string, number[]>} uses of the last hour, oldest first */
	#uses = new Map();

	/** @param {{ now?: () => number, minGapMs?: number, perHour?: number }} [opts] */
	constructor(opts = {}) {
		this.#now = opts.now ?? Date.now;
		this.#minGapMs = opts.minGapMs ?? LOGIN_LIMITS.minGapMs;
		this.#perHour = opts.perHour ?? LOGIN_LIMITS.perHour;
	}

	/**
	 * Ask for one use. A use that is granted is counted; one that is refused is not.
	 * @param {string} key
	 * @returns {number} 0: granted. Otherwise the seconds until the next one can be
	 */
	admit(key) {
		const now = this.#now();
		const uses = (this.#uses.get(key) ?? []).filter((t) => t > now - HOUR_MS && t <= now);
		/** @type {number} */
		let waitMs = 0;
		const last = uses[uses.length - 1];
		if (last !== undefined && now - last < this.#minGapMs) waitMs = this.#minGapMs - (now - last);
		if (uses.length >= this.#perHour) waitMs = Math.max(waitMs, uses[uses.length - this.#perHour] + HOUR_MS - now);
		if (waitMs > 0) {
			this.#uses.set(key, uses);
			return Math.max(1, Math.ceil(waitMs / 1000));
		}
		uses.push(now);
		this.#uses.delete(key);
		this.#uses.set(key, uses);
		if (this.#uses.size > MAX_TRACKED) this.#uses.delete(/** @type {string} */ (this.#uses.keys().next().value));
		return 0;
	}
}

export class OptIn {
	#d;
	#limiter;
	/** @type {OptInRule[]} */
	#rules = [];
	/** @type {"ok" | "empty" | "mismatch"} */
	#state = "empty";
	#rev = 1;
	/** @type {string} what the rules in force were when onChange was last called */
	#told = "[]";
	/** @type {Promise<void>} reads run one after another */
	#chain = Promise.resolve();
	/** @type {ReturnType<typeof setTimeout> | null} */
	#retry = null;

	/** @param {OptInDeps} deps */
	constructor(deps) {
		this.#d = deps;
		this.#limiter = new LoginLimiter({ now: deps.now, ...deps.limits });
		deps.onChanged?.addListener((changes, area) => {
			if (area === "local" && Object.hasOwn(changes, OPTIN_STORAGE_KEY)) this.load().catch(() => {});
		});
	}

	/** Read the rules. Called at start and whenever the stored list changes. */
	load() {
		const run = this.#chain.then(() => this.#read(0));
		this.#chain = run.catch(() => undefined);
		return run;
	}

	/** @param {number} attempt */
	async #read(attempt) {
		if (this.#retry !== null) clearTimeout(this.#retry);
		this.#retry = null;
		/** @type {unknown} */
		let stored;
		/** @type {string | null} */
		let shadow = null;
		let readable = true;
		try {
			stored = (await this.#d.storage.get([OPTIN_STORAGE_KEY]))[OPTIN_STORAGE_KEY];
			shadow = await this.#d.shadow();
		} catch {
			readable = false;
		}
		const read = readable ? readOptInRules(stored, shadow, this.#d.policy) : { rules: [], state: /** @type {const} */ ("mismatch"), rejected: 0 };
		this.#rules = read.rules;
		this.#state = read.state;
		if (read.rejected > 0) this.#d.log("optin.rules_ignored", { count: read.rejected });
		if (read.state === "mismatch") {
			this.#d.log("optin.not_in_force", { attempt });
			// The options page writes one copy after the other: look again before taking it for final.
			const wait = (this.#d.retryMs ?? [150, 600, 2500])[attempt];
			if (wait !== undefined) {
				this.#retry = setTimeout(() => {
					this.#retry = null;
					this.#chain = this.#chain.then(() => this.#read(attempt + 1)).catch(() => undefined);
				}, wait);
			}
		}
		const now = JSON.stringify(this.#rules);
		if (now !== this.#told) {
			this.#told = now;
			this.#rev += 1;
			this.#d.log("optin.rules_loaded", { rules: this.#rules.length });
			this.#d.onChange();
		}
	}

	/** @returns {readonly OptInRule[]} the rules in force */
	get rules() {
		return this.#rules;
	}

	/** ok: rules are in force. empty: none are set. mismatch: what is stored cannot be trusted, none are in force. */
	get state() {
		return this.#state;
	}

	/** Goes up whenever the rules in force change. */
	get rev() {
		return this.#rev;
	}

	/** @returns {string[]} the hosts that have a rule, each once */
	hosts() {
		return [...new Set(this.#rules.map((r) => r.host))];
	}

	/**
	 * @param {string} url the URL of a job
	 * @returns {OptInRule | null} the rule the URL lies in
	 */
	match(url) {
		return matchOptInRule(url, this.#rules, this.#d.policy);
	}

	/**
	 * Ask for one page load under a rule.
	 * @param {OptInRule} rule
	 * @returns {number} 0: go ahead. Otherwise the seconds to wait
	 */
	admit(rule) {
		return this.#limiter.admit(optInRuleKey(rule));
	}
}
