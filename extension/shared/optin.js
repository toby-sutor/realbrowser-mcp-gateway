// Login opt-in rules as they are kept by the extension, shared by the options
// page (the only place that writes them) and the background page (which only
// reads them). Standard JS only.
//
// The rules live in storage.local under OPTIN_STORAGE_KEY. A copy of the same
// list is kept in the IndexedDB of the extension's own pages (ownstore.js)
// under OPTIN_SHADOW_KEY, and the rules count only while the two agree.
//
// Why two places: storage.local can be written by any script of this
// extension, and that includes the content scripts that read untrusted pages.
// The IndexedDB of the extension's origin cannot be reached from a content
// script - there, IndexedDB is the page's. So should a page ever get a
// content script to do its bidding, it can damage the list in storage.local,
// but it cannot make the two agree on a rule the operator never set. A list
// that does not agree is no list: every job runs in the container.

import { OPTIN_LIMITS, OPTIN_REASON, checkOptInRule, optInRuleKey, parseOptInRules } from "./policy.js";

/**
 * How often one rule may be used: at most one page per gap, and so many an
 * hour. The extension enforces it (background/optin.js), so that the daemon
 * cannot lift it; the daemon paces to the same numbers (queue.js).
 */
export const LOGIN_LIMITS = Object.freeze({ minGapMs: 10000, perHour: 30 });

export const OPTIN_STORAGE_KEY = "optinRules";
export const OPTIN_SHADOW_KEY = "optinRules";
const FORMAT = 1;
// Longest text either copy may have: the cap on rules times the longest rule, with room to spare.
const MAX_STORED_CHARS = OPTIN_LIMITS.maxRules * (OPTIN_LIMITS.maxHost + OPTIN_LIMITS.maxPathPrefix + 80) + 64;

/**
 * @typedef {import("./policy.js").OptInRule} OptInRule
 * @typedef {import("./policy.js").OptInOptions} OptInOptions
 *
 * @typedef {object} StoredRules what a read of the two copies comes to
 * @property {OptInRule[]} rules the rules in force; empty unless state is "ok"
 * @property {"ok" | "empty" | "mismatch"} state empty: nothing is stored in either place. mismatch: the two
 *   copies do not agree, or one of them cannot be read - no rule is in force
 * @property {number} rejected entries of the stored list that are no usable rule
 */

/**
 * The value that goes into storage.local for a list of checked rules.
 * @param {readonly OptInRule[]} rules canonical rules
 * @returns {{ v: number, rules: OptInRule[] }}
 */
export function packOptInRules(rules) {
	return { v: FORMAT, rules: rules.map((r) => ({ host: r.host, pathPrefix: r.pathPrefix, subdomains: r.subdomains })) };
}

/**
 * One text for a list of rules: the same list always gives the same text.
 * This is what goes into the shadow copy, and what the two copies are compared by.
 * @param {readonly OptInRule[]} rules canonical rules
 * @returns {string}
 */
export function serializeOptInRules(rules) {
	return JSON.stringify(packOptInRules(rules));
}

/**
 * The rules out of one copy, each checked. Says nothing about whether they are
 * in force: that takes both copies (readOptInRules).
 * @param {unknown} packed a value in the shape of packOptInRules()
 * @param {OptInOptions} [opts]
 * @returns {{ rules: OptInRule[], rejected: number } | null} null when it is not that shape at all
 */
export function unpackOptInRules(packed, opts = {}) {
	if (typeof packed !== "object" || packed === null || Array.isArray(packed)) return null;
	const o = /** @type {Record<string, unknown>} */ (packed);
	if (o.v !== FORMAT || !Array.isArray(o.rules) || Object.keys(o).length !== 2) return null;
	return parseOptInRules(o.rules, opts);
}

/**
 * Put the two copies together. Every rule is checked again here, whoever
 * wrote it: what does not pass is not in force.
 * @param {unknown} stored the value under OPTIN_STORAGE_KEY in storage.local; undefined when there is none
 * @param {unknown} shadow the text under OPTIN_SHADOW_KEY in the extension's own page storage; null when there is none
 * @param {OptInOptions} [opts]
 * @returns {StoredRules}
 */
export function readOptInRules(stored, shadow, opts = {}) {
	const noStored = stored === undefined || stored === null;
	const noShadow = shadow === undefined || shadow === null || shadow === "";
	if (noStored && noShadow) return { rules: [], state: "empty", rejected: 0 };
	/** @type {StoredRules} */
	const mismatch = { rules: [], state: "mismatch", rejected: 0 };
	if (noStored || noShadow || typeof shadow !== "string" || shadow.length > MAX_STORED_CHARS) return mismatch;
	const fromStore = unpackOptInRules(stored, opts);
	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(shadow);
	} catch {
		return mismatch;
	}
	const fromShadow = unpackOptInRules(parsed, opts);
	if (fromStore === null || fromShadow === null) return mismatch;
	// Compared by the rules that pass the check on both sides. An entry that
	// passes on neither (a rule an update of the extension no longer allows)
	// is simply not in force; one that is in a single copy only breaks the
	// agreement, and with it the whole list.
	if (serializeOptInRules(fromStore.rules) !== serializeOptInRules(fromShadow.rules)) return { ...mismatch, rejected: fromStore.rejected };
	return { rules: fromStore.rules, state: fromStore.rules.length === 0 ? "empty" : "ok", rejected: fromStore.rejected };
}

/**
 * What the options page shows of the two copies, and whether the operator may
 * put it back in force as it stands.
 *
 * While the copies agree this is readOptInRules(). When they do not, no rule
 * is in force, and the two are not worth the same: the copy in the
 * extension's own page storage is written by the options page alone, so what
 * it holds is what the operator last saved, and it can be offered again.
 * storage.local can be written by a content script that a page got hold of.
 * A list that stands there alone - the own copy lost, emptied or unreadable -
 * is shown for the operator to read and is never offered: it can only be
 * removed, and the rules entered again.
 * @param {unknown} stored the value under OPTIN_STORAGE_KEY in storage.local; undefined when there is none
 * @param {unknown} shadow the text under OPTIN_SHADOW_KEY in the extension's own page storage; null when there is none
 * @param {OptInOptions} [opts]
 * @returns {{ state: "ok" | "empty" | "mismatch", rules: OptInRule[], restorable: boolean }}
 *   restorable: the rules are those of the extension's own copy and may be written back to both places
 */
export function reviewOptInRules(stored, shadow, opts = {}) {
	const read = readOptInRules(stored, shadow, opts);
	if (read.state !== "mismatch") return { state: read.state, rules: read.rules, restorable: false };
	/** @type {OptInRule[]} */
	let own = [];
	if (typeof shadow === "string" && shadow.length <= MAX_STORED_CHARS) {
		try {
			own = unpackOptInRules(JSON.parse(shadow), opts)?.rules ?? [];
		} catch {
			// not a list: nothing of the operator's to offer
		}
	}
	if (own.length > 0) return { state: "mismatch", rules: own, restorable: true };
	return { state: "mismatch", rules: unpackOptInRules(stored, opts)?.rules ?? [], restorable: false };
}

/** One sentence per reason a rule is refused, for the operator. */
export const OPTIN_MESSAGES = Object.freeze({
	[OPTIN_REASON.SHAPE]: "This is not a usable rule.",
	[OPTIN_REASON.HOST]: "Enter the host name of one site, like old.reddit.com - no https://, no port, no path, no wildcard.",
	[OPTIN_REASON.IP]: "An IP address cannot be opted in, only a host name.",
	[OPTIN_REASON.LOCAL]: "Local and special-use names cannot be opted in.",
	[OPTIN_REASON.PUBLIC_SUFFIX]: "That name stands for many sites of different owners (like com, co.uk or github.io). Name the one site you mean.",
	[OPTIN_REASON.SUFFIX_LIKE]:
		"With its subdomains this name cannot be opted in: it has the form of a name under which a registry or a hosting service gives sites to many different owners, and the extension cannot tell that it is not one. Add the hosts you mean one at a time, without subdomains.",
	[OPTIN_REASON.BLOCKLISTED]: "This site is on the gateway's blocklist (accounts, webmail, payment, password managers) and cannot be opted in.",
	[OPTIN_REASON.COVERS_BLOCKLISTED]: "With its subdomains this rule would cover a site on the gateway's blocklist (accounts, webmail, payment, password managers). Name the one host you mean, without subdomains.",
	[OPTIN_REASON.PATH]: "The path must start with / and be written as the address bar shows it: no ? or #, no spaces, no .. and no empty parts.",
	duplicate: "This rule is on the list already.",
	too_many: `The list is full (${OPTIN_LIMITS.maxRules} rules). Remove one first.`,
});

/**
 * @param {string} reason
 * @returns {string}
 */
export function optInMessage(reason) {
	return Object.hasOwn(OPTIN_MESSAGES, reason) ? /** @type {Record<string, string>} */ (OPTIN_MESSAGES)[reason] : OPTIN_MESSAGES[OPTIN_REASON.SHAPE];
}

/**
 * A rule out of what the operator typed. The host is taken as typed, apart
 * from case, a dot at the end and the spelling of non-ASCII names; anything
 * that needs guessing (a pasted address, a port, a path in the host field) is
 * refused, so that what is saved is what the operator sees.
 * @param {unknown} hostText
 * @param {unknown} pathText empty means the whole site ("/")
 * @param {unknown} subdomains
 * @param {OptInOptions} [opts]
 * @returns {{ ok: true, rule: OptInRule } | { ok: false, reason: string }}
 */
export function optInRuleFromInput(hostText, pathText, subdomains, opts = {}) {
	if (typeof hostText !== "string" || typeof pathText !== "string" || typeof subdomains !== "boolean") return { ok: false, reason: OPTIN_REASON.SHAPE };
	let host = hostText.trim().toLowerCase();
	if (host === "" || host.length > OPTIN_LIMITS.maxHost * 4 || /[\s/\\:@?#*%[\]]/.test(host)) return { ok: false, reason: OPTIN_REASON.HOST };
	if (/[^\u0000-\u007f]/.test(host)) {
		// A name in another script is kept the way the browser sends it.
		try {
			host = new URL(`https://${host}/`).hostname;
		} catch {
			return { ok: false, reason: OPTIN_REASON.HOST };
		}
	}
	const path = pathText.trim() === "" ? "/" : pathText.trim();
	return checkOptInRule({ host, pathPrefix: path, subdomains }, opts);
}

/**
 * The list with one rule added, or put in the place of another.
 * @param {readonly OptInRule[]} rules the list as it is
 * @param {OptInRule} rule a checked rule
 * @param {string | null} [replaceKey] optInRuleKey of the rule this one takes the place of
 * @returns {{ ok: true, rules: OptInRule[] } | { ok: false, reason: string }}
 */
export function withOptInRule(rules, rule, replaceKey = null) {
	const key = optInRuleKey(rule);
	const rest = replaceKey === null ? [...rules] : rules.filter((r) => optInRuleKey(r) !== replaceKey);
	if (rest.some((r) => optInRuleKey(r) === key)) return { ok: false, reason: "duplicate" };
	if (rest.length >= OPTIN_LIMITS.maxRules) return { ok: false, reason: "too_many" };
	if (replaceKey === null || rest.length === rules.length) return { ok: true, rules: [...rest, rule] };
	// In the place of the rule it replaces.
	const at = rules.findIndex((r) => optInRuleKey(r) === replaceKey);
	return { ok: true, rules: [...rest.slice(0, at), rule, ...rest.slice(at)] };
}

/**
 * @param {OptInRule} rule
 * @returns {string} the rule as one line a person can read
 */
export function describeOptInRule(rule) {
	return `https://${rule.host}${rule.pathPrefix}${rule.subdomains ? `  (and every subdomain of ${rule.host})` : ""}`;
}
