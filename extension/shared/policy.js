// URL policy, shared by the daemon (Node) and the extension background page.
// Pure functions on top of the WHATWG URL parser - no Node built-ins, no DOM.
//
// Everything here is static: it looks at the URL text only. Names that resolve
// to private addresses are caught later by the extension guard, which feeds DNS
// answers and the response IP through isPrivateAddress().

import { SECOND_LEVEL_LABELS, inProviderZone, isSharedSuffix, sharedSuffixOf } from "./suffixes.js";

export const MAX_URL_LENGTH = 2048;

export const REASON = Object.freeze({
	INVALID_URL: "invalid_url",
	URL_TOO_LONG: "url_too_long",
	SCHEME: "scheme_not_allowed",
	USERINFO: "userinfo_not_allowed",
	INVALID_HOST: "invalid_host",
	PRIVATE_ADDRESS: "private_address",
	LOCAL_NAME: "local_name",
	ONION: "onion",
	SINGLE_LABEL: "single_label",
	BLOCKLISTED: "blocklisted",
});

/**
 * Hosts that are never fetched, matched as domain suffixes on label
 * boundaries. Deliberately short: webmail, account and identity pages,
 * payment, password managers.
 */
export const DEFAULT_BLOCKLIST = Object.freeze([
	// webmail
	"mail.google.com",
	"gmail.com",
	"outlook.live.com",
	"outlook.office.com",
	"outlook.office365.com",
	"mail.yahoo.com",
	"mail.proton.me",
	"app.tuta.com",
	"app.fastmail.com",
	"mail.zoho.com",
	"icloud.com",
	// accounts and identity
	"accounts.google.com",
	"myaccount.google.com",
	"login.microsoftonline.com",
	"login.live.com",
	"account.microsoft.com",
	"account.live.com",
	"appleid.apple.com",
	"account.apple.com",
	"login.yahoo.com",
	"account.proton.me",
	"accounts.firefox.com",
	// payment
	"paypal.com",
	"pay.google.com",
	"wallet.google.com",
	"dashboard.stripe.com",
	"checkout.stripe.com",
	"wise.com",
	"revolut.com",
	"klarna.com",
	// password managers
	"passwords.google.com",
	"my.1password.com",
	"my.1password.eu",
	"my.1password.ca",
	"vault.bitwarden.com",
	"vault.bitwarden.eu",
	"lastpass.com",
	"app.dashlane.com",
	"keepersecurity.com",
	"pass.proton.me",
]);

// Special-use and common intranet suffixes. "localhost" also covers the bare name.
const LOCAL_SUFFIXES = Object.freeze([
	"localhost",
	"local",
	"localdomain",
	"internal",
	"intranet",
	"private",
	"corp",
	"home",
	"lan",
	"home.arpa",
	"test",
	"invalid",
]);

/**
 * @typedef {{ ok: true, url: string, host: string, scheme: "http" | "https", port: number }} NormalizedUrl
 * @typedef {{ ok: false, reason: string }} UrlRejection
 */

/**
 * Parse and normalise an agent-supplied URL. The WHATWG parser does the heavy
 * lifting: it lowercases the host, converts IDN to punycode and rewrites every
 * numeric IPv4 spelling (2130706433, 0x7f.1, 127.1, 017700000001) to dotted
 * decimal, so classification only ever sees the canonical form.
 * @param {unknown} input
 * @returns {NormalizedUrl | UrlRejection}
 */
export function normalizeUrl(input) {
	if (typeof input !== "string" || input.length === 0) return { ok: false, reason: REASON.INVALID_URL };
	if (input.length > MAX_URL_LENGTH) return { ok: false, reason: REASON.URL_TOO_LONG };
	// The parser would silently drop tabs and newlines and trim spaces. Refuse
	// instead, so the logged URL is the one that was asked for.
	if (/[\u0000- \u007f]/.test(input)) return { ok: false, reason: REASON.INVALID_URL };
	/** @type {URL} */
	let u;
	try {
		u = new URL(input);
	} catch {
		return { ok: false, reason: REASON.INVALID_URL };
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: REASON.SCHEME };
	if (u.username !== "" || u.password !== "") return { ok: false, reason: REASON.USERINFO };
	let host = u.hostname;
	if (host.endsWith(".")) {
		// "example.com." names the same host; one spelling keeps matching simple.
		host = host.slice(0, -1);
		try {
			u.hostname = host;
		} catch {
			return { ok: false, reason: REASON.INVALID_HOST };
		}
		if (u.hostname !== host) return { ok: false, reason: REASON.INVALID_HOST };
	}
	if (host === "" || (!host.startsWith("[") && host.split(".").includes(""))) {
		return { ok: false, reason: REASON.INVALID_HOST };
	}
	const scheme = u.protocol === "https:" ? "https" : "http";
	const port = u.port === "" ? (scheme === "https" ? 443 : 80) : Number(u.port);
	const url = u.href;
	if (url.length > MAX_URL_LENGTH) return { ok: false, reason: REASON.URL_TOO_LONG };
	return { ok: true, url, host, scheme, port };
}

/**
 * @param {string} text strict dotted decimal, no leading zeros
 * @returns {Uint8Array | null}
 */
function parseIpv4(text) {
	const parts = text.split(".");
	if (parts.length !== 4) return null;
	const out = new Uint8Array(4);
	for (let i = 0; i < 4; i++) {
		const p = parts[i];
		if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
		const n = Number(p);
		if (n > 255) return null;
		out[i] = n;
	}
	return out;
}

/**
 * @param {string} text IPv6 literal without brackets or zone id
 * @returns {Uint8Array | null} 16 bytes
 */
function parseIpv6(text) {
	if (text.length < 2 || text.length > 45 || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
	const halves = text.split("::");
	if (halves.length > 2) return null;
	/** @param {string} part @returns {number[] | null} 16-bit groups */
	const groups = (part) => {
		if (part === "") return [];
		const items = part.split(":");
		/** @type {number[]} */
		const out = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.includes(".")) {
				// Embedded dotted IPv4 is only valid as the last item.
				if (i !== items.length - 1) return null;
				const v4 = parseIpv4(item);
				if (v4 === null) return null;
				out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
			} else {
				if (!/^[0-9a-fA-F]{1,4}$/.test(item)) return null;
				out.push(parseInt(item, 16));
			}
		}
		return out;
	};
	const head = groups(halves[0]);
	const tail = halves.length === 2 ? groups(halves[1]) : [];
	if (head === null || tail === null) return null;
	// A dotted quad in the head is only acceptable when nothing follows it.
	if (halves.length === 2 && halves[0].includes(".")) return null;
	const total = head.length + tail.length;
	if (halves.length === 2 ? total > 7 : total !== 8) return null;
	const all = [...head, ...new Array(8 - total).fill(0), ...tail];
	const out = new Uint8Array(16);
	for (let i = 0; i < 8; i++) {
		out[i * 2] = all[i] >> 8;
		out[i * 2 + 1] = all[i] & 0xff;
	}
	return out;
}

/**
 * @param {unknown} text IPv4 dotted decimal or an IPv6 literal, brackets optional
 * @returns {{ version: 4 | 6, bytes: Uint8Array, zone: boolean } | null}
 */
export function parseIp(text) {
	if (typeof text !== "string") return null;
	let s = text;
	if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
	if (s.includes(":")) {
		const pct = s.indexOf("%");
		const zone = pct !== -1;
		if (zone) s = s.slice(0, pct);
		const bytes = parseIpv6(s);
		return bytes === null ? null : { version: 6, bytes, zone };
	}
	const bytes = parseIpv4(s);
	return bytes === null ? null : { version: 4, bytes, zone: false };
}

/**
 * Everything that is not globally reachable unicast (IANA special-purpose
 * registry): this network, RFC 1918, CGNAT, loopback, link-local, protocol
 * assignments, documentation, benchmarking, multicast, reserved, broadcast.
 * @param {Uint8Array} b 4 bytes
 * @returns {boolean}
 */
function isPrivateV4(b) {
	const [a, c] = [b[0], b[1]];
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 100 && c >= 64 && c <= 127) return true;
	if (a === 169 && c === 254) return true;
	if (a === 172 && c >= 16 && c <= 31) return true;
	if (a === 192 && c === 0 && (b[2] === 0 || b[2] === 2)) return true;
	if (a === 192 && c === 88 && b[2] === 99) return true;
	if (a === 192 && c === 168) return true;
	if (a === 198 && (c === 18 || c === 19)) return true;
	if (a === 198 && c === 51 && b[2] === 100) return true;
	if (a === 203 && c === 0 && b[2] === 113) return true;
	return a >= 224;
}

/**
 * Default deny: only global unicast 2000::/3 is public, minus its special
 * blocks, plus the two forms that carry a public IPv4 address.
 * @param {Uint8Array} b 16 bytes
 * @returns {boolean}
 */
function isPrivateV6(b) {
	/** @param {number} n */
	const zeroPrefix = (n) => b.subarray(0, n).every((x) => x === 0);
	// ::ffff:a.b.c.d IPv4-mapped
	if (zeroPrefix(10) && b[10] === 0xff && b[11] === 0xff) return isPrivateV4(b.subarray(12));
	// 64:ff9b::/96 well-known NAT64 prefix
	if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.subarray(4, 12).every((x) => x === 0)) {
		return isPrivateV4(b.subarray(12));
	}
	if ((b[0] & 0xe0) !== 0x20) return true;
	// 2001::/23 protocol assignments (Teredo, benchmarking, ORCHID)
	if (b[0] === 0x20 && b[1] === 0x01 && (b[2] & 0xfe) === 0) return true;
	// 2001:db8::/32 and 3fff::/20 documentation
	if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
	if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0) return true;
	// 2002::/16 6to4 carries an IPv4 address in the next 32 bits
	if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4(b.subarray(2, 6));
	return false;
}

/**
 * True for any address an agent job must not reach: loopback, RFC 1918,
 * link-local, CGNAT, unspecified, multicast, broadcast, ULA, fe80::/10, ::1 and
 * the IPv4-mapped, NAT64 and 6to4 forms of those. Fails closed: input that is
 * not a well-formed IP literal counts as private, and so does anything with a
 * zone id.
 * @param {unknown} ip IPv4 dotted decimal or IPv6 literal (brackets optional)
 * @returns {boolean}
 */
export function isPrivateAddress(ip) {
	const parsed = parseIp(ip);
	if (parsed === null || parsed.zone) return true;
	return parsed.version === 4 ? isPrivateV4(parsed.bytes) : isPrivateV6(parsed.bytes);
}

/**
 * @param {string} host
 * @returns {string} lowercase, without one trailing dot
 */
function canonicalHost(host) {
	const h = host.toLowerCase();
	return h.endsWith(".") ? h.slice(0, -1) : h;
}

/**
 * Label-boundary suffix match: "a.example.com" is under "example.com",
 * "badexample.com" is not.
 * @param {string} host canonical
 * @param {string} suffix canonical
 * @returns {boolean}
 */
function isUnder(host, suffix) {
	return suffix !== "" && (host === suffix || host.endsWith("." + suffix));
}

/**
 * Classify a URL host (as produced by the URL parser) without resolving it.
 * @param {unknown} host hostname; IPv6 literals in brackets
 * @returns {{ allowed: true, kind: "domain" | "ip" } | { allowed: false, reason: string }}
 */
export function classifyHost(host) {
	if (typeof host !== "string" || host === "" || host.length > 255) return { allowed: false, reason: REASON.INVALID_HOST };
	if (host.startsWith("[") || host.includes(":")) {
		if (parseIp(host) === null) return { allowed: false, reason: REASON.INVALID_HOST };
		return isPrivateAddress(host) ? { allowed: false, reason: REASON.PRIVATE_ADDRESS } : { allowed: true, kind: "ip" };
	}
	const h = canonicalHost(host);
	const labels = h.split(".");
	if (h === "" || labels.includes("")) return { allowed: false, reason: REASON.INVALID_HOST };
	if (parseIp(h) !== null) {
		return isPrivateAddress(h) ? { allowed: false, reason: REASON.PRIVATE_ADDRESS } : { allowed: true, kind: "ip" };
	}
	// A numeric last label that did not parse as canonical IPv4 would be read as
	// an address by some resolvers. The URL parser never produces one.
	const last = labels[labels.length - 1];
	if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return { allowed: false, reason: REASON.INVALID_HOST };
	if (!/^[a-z0-9_-]+$/.test(labels.join(""))) return { allowed: false, reason: REASON.INVALID_HOST };
	if (isUnder(h, "onion")) return { allowed: false, reason: REASON.ONION };
	for (const suffix of LOCAL_SUFFIXES) {
		if (isUnder(h, suffix)) return { allowed: false, reason: REASON.LOCAL_NAME };
	}
	if (labels.length === 1) return { allowed: false, reason: REASON.SINGLE_LABEL };
	return { allowed: true, kind: "domain" };
}

/**
 * @param {unknown} host
 * @param {readonly string[]} list domain suffixes
 * @returns {string | null} the matching entry
 */
export function matchBlocklist(host, list) {
	if (typeof host !== "string") return null;
	const h = canonicalHost(host);
	for (const entry of list) {
		if (typeof entry !== "string") continue;
		const e = canonicalHost(entry.trim());
		if (isUnder(h, e)) return entry;
	}
	return null;
}

/**
 * Login opt-in rule: pages under it are loaded with the operator's own cookie
 * store instead of the gateway container. A host, a path prefix, and whether
 * the names below the host are meant as well.
 * @typedef {{ host: string, pathPrefix: string, subdomains: boolean }} OptInRule
 *
 * @typedef {object} OptInOptions
 * @property {readonly string[]} [blocklist] hosts no rule may name; the default blocklist when absent
 * @property {readonly number[]} [fixturePorts] test fixtures only (a dev build of the extension): with ports
 *   listed here a rule may name a loopback name ("a.localhost"), and http URLs on exactly these ports are matched
 *   in place of https URLs on the default port. Empty in a release build
 */

export const OPTIN_LIMITS = Object.freeze({
	maxRules: 50,
	maxHost: 253,
	maxPathPrefix: 256,
});

/** Why a rule is refused. The options page turns these into sentences. */
export const OPTIN_REASON = Object.freeze({
	SHAPE: "shape",
	HOST: "host",
	IP: "ip_literal",
	LOCAL: "local_name",
	PUBLIC_SUFFIX: "public_suffix",
	SUFFIX_LIKE: "suffix_like",
	BLOCKLISTED: "blocklisted",
	COVERS_BLOCKLISTED: "covers_blocklisted",
	PATH: "path_prefix",
});

/** @param {string} text @returns {Set<string>} */
const words = (text) => new Set(text.split(/\s+/).filter((w) => w !== ""));

/**
 * Country codes whose registry hands out names directly below the code
 * ("example.de"), whatever second levels it has besides. Only codes this is
 * known of: under any other code a name of two labels may as well be a
 * registry's second level.
 */
const DIRECT_COUNTRY_CODES = words(`
	al am at az ba be bg by ch cz de dk ee es eu fi fo fr ge gg gl gr hr hu ie im is it je li lt lu lv md me mk nl no pl pt ro rs
	ru se si sk sm su ua uk
	ar ca cl co ec mx pe us uy
	ae au cn hk id in ir jp kr kz la lk my nz ph pk sa sg tw uz vn
	ke ma ng tn
	ac ag ai bz cc cx fm gd gs gy io ly ms mu nu pw sc sh so st sx tc tk tl to tv vc vg ws
`);

/** The two-letter country codes: what a name can end in, and what a registry under com, net or org is named after. */
const COUNTRY_CODES = words(`
	ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bv bw by bz ca cc cd cf cg ch
	ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn
	gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc
	li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz
	om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st su sv sx sy
	sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw
`);

/**
 * Could the name, with everything below it, be a registry or a hosting name
 * that the table of shared names does not hold? Asked for a rule with
 * subdomains only, and on the cautious side: such a rule would put the
 * operator's cookies on the sites of whoever has a name there, so a name that
 * merely has the form is refused. The same host can still be named alone.
 *
 * - Anything below a provider's zone ("x.s3.eu-west-1.amazonaws.com"): what
 *   lies under it is not known to be one customer's.
 * - A name of two labels under a country code, unless the code is one whose
 *   registry is known to hand out names directly below it and the name has
 *   three characters or more: "mi.it" and "ab.se" have the form of a second
 *   level (and are one), and so has every name under a code this file knows
 *   nothing of.
 * - A country code as the name under com, net or org: "uk.com", "gb.net",
 *   "eu.org" are registries, and there are more of them than the table holds.
 * - A registry's label on top of a shared name: "ltd.co.im", "edu.eu.org".
 * @param {string} host canonical, not itself a name of the table
 * @returns {boolean}
 */
function looksShared(host) {
	if (inProviderZone(host)) return true;
	const labels = host.split(".");
	const tld = labels[labels.length - 1];
	if (labels.length === 2) {
		if (tld.length === 2) return !DIRECT_COUNTRY_CODES.has(tld) || labels[0].length < 3;
		return (tld === "com" || tld === "net" || tld === "org") && COUNTRY_CODES.has(labels[0]);
	}
	return SECOND_LEVEL_LABELS.has(labels[0]) && sharedSuffixOf(host) === labels.slice(1).join(".");
}

/**
 * "." or ".." with a path parameter behind it: "/..;/", "/.;x=1/". The URL
 * parser takes such a segment for a name and leaves it where it is; a server
 * that knows path parameters (Tomcat, Jetty) drops the parameter first and
 * then walks up. The semicolon may be encoded, once or over again. The dots
 * may not: an encoded dot is refused wherever a path is looked at.
 */
const PARAM_DOT_SEGMENT = /(?:^|\/)\.{1,2}(?:;|%(?:25)*3b)/i;

/**
 * Check one rule and bring it into its canonical form. Strict on purpose: a
 * rule widens what an agent can reach, so anything unusual is refused rather
 * than interpreted.
 *
 * - host: a registrable-looking domain name. No wildcard, no scheme, port or
 *   path, no IP address, no single label, no name that many owners share
 *   ("com", "co.uk", "github.io": suffixes.js), no local or special-use name,
 *   nothing on the blocklist.
 * - subdomains: must be a boolean. true extends the rule to the names below
 *   the host; such a rule may not reach a blocklisted host either, and its
 *   host may not even have the form of a shared name (looksShared). What the
 *   table does not know is refused here rather than accepted.
 * - pathPrefix: starts with "/", in the form the URL parser gives a path (no
 *   dot segments, no empty segments, nothing left to encode), no query, no
 *   fragment, no encoded separators, no dot segment with a path parameter.
 * @param {unknown} rule
 * @param {OptInOptions} [opts]
 * @returns {{ ok: true, rule: OptInRule } | { ok: false, reason: string }}
 */
export function checkOptInRule(rule, opts = {}) {
	/** @param {string} reason @returns {{ ok: false, reason: string }} */
	const no = (reason) => ({ ok: false, reason });
	if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return no(OPTIN_REASON.SHAPE);
	const r = /** @type {Record<string, unknown>} */ (rule);
	for (const key of Object.keys(r)) {
		if (key !== "host" && key !== "pathPrefix" && key !== "subdomains") return no(OPTIN_REASON.SHAPE);
	}
	const { host, pathPrefix, subdomains } = r;
	if (typeof host !== "string" || typeof pathPrefix !== "string" || typeof subdomains !== "boolean") return no(OPTIN_REASON.SHAPE);

	const h = canonicalHost(host);
	if (h.length === 0 || h.length > OPTIN_LIMITS.maxHost) return no(OPTIN_REASON.HOST);
	if (parseIp(h) !== null || h.startsWith("[")) return no(OPTIN_REASON.IP);
	const labels = h.split(".");
	if (labels.length < 2 || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return no(OPTIN_REASON.HOST);
	const tld = labels[labels.length - 1];
	// A numeric last label is an address in some spelling; a one-letter one is no registry's.
	if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return no(/^[0-9]+$/.test(tld) ? OPTIN_REASON.IP : OPTIN_REASON.HOST);
	const fixture = (opts.fixturePorts ?? []).length > 0 && isUnder(h, "localhost");
	if (!fixture) {
		const c = classifyHost(h);
		if (!c.allowed) return no(c.reason === REASON.PRIVATE_ADDRESS ? OPTIN_REASON.IP : c.reason === REASON.INVALID_HOST ? OPTIN_REASON.HOST : OPTIN_REASON.LOCAL);
		if (isSharedSuffix(h)) return no(OPTIN_REASON.PUBLIC_SUFFIX);
		if (subdomains && looksShared(h)) return no(OPTIN_REASON.SUFFIX_LIKE);
	}
	const blocklist = opts.blocklist ?? DEFAULT_BLOCKLIST;
	if (matchBlocklist(h, blocklist) !== null) return no(OPTIN_REASON.BLOCKLISTED);
	if (subdomains && blocklist.some((entry) => typeof entry === "string" && isUnder(canonicalHost(entry.trim()), h))) return no(OPTIN_REASON.COVERS_BLOCKLISTED);

	if (!pathPrefix.startsWith("/") || pathPrefix.length > OPTIN_LIMITS.maxPathPrefix) return no(OPTIN_REASON.PATH);
	if (/[\u0000- \u007f-\uffff?#\\]/.test(pathPrefix) || /%2f|%5c|%2e|%25/i.test(pathPrefix)) return no(OPTIN_REASON.PATH);
	if (pathPrefix.includes("//") || PARAM_DOT_SEGMENT.test(pathPrefix)) return no(OPTIN_REASON.PATH);
	// Whatever the parser would rewrite (dot segments, characters it encodes) is
	// not the path a URL will ever show: such a prefix would match nothing, or
	// something else than it reads.
	try {
		if (new URL(`https://rule.invalid${pathPrefix}`).pathname !== pathPrefix) return no(OPTIN_REASON.PATH);
	} catch {
		return no(OPTIN_REASON.PATH);
	}
	return { ok: true, rule: { host: h, pathPrefix, subdomains } };
}

/**
 * @param {unknown} rule
 * @param {OptInOptions} [opts]
 * @returns {OptInRule | null} canonical form, or null when the rule is unusable
 */
export function normalizeOptInRule(rule, opts = {}) {
	const checked = checkOptInRule(rule, opts);
	return checked.ok ? checked.rule : null;
}

/**
 * The rules out of whatever was stored, each checked again. Everything that
 * does not pass is left out and counted: a damaged or tampered list can only
 * ever shrink. Rules beyond the cap are left out too, and duplicates.
 * @param {unknown} list
 * @param {OptInOptions} [opts]
 * @returns {{ rules: OptInRule[], rejected: number }}
 */
export function parseOptInRules(list, opts = {}) {
	if (!Array.isArray(list)) return { rules: [], rejected: list === undefined || list === null ? 0 : 1 };
	/** @type {OptInRule[]} */
	const rules = [];
	/** @type {Set<string>} */
	const seen = new Set();
	let rejected = 0;
	for (const item of list) {
		const rule = rules.length < OPTIN_LIMITS.maxRules ? normalizeOptInRule(item, opts) : null;
		const key = rule === null ? "" : optInRuleKey(rule);
		if (rule === null || seen.has(key)) {
			rejected += 1;
			continue;
		}
		seen.add(key);
		rules.push(rule);
	}
	return { rules, rejected };
}

/**
 * @param {OptInRule} rule canonical
 * @returns {string} one line that names the rule and nothing else; the same rule always gives the same line
 */
export function optInRuleKey(rule) {
	return `${rule.subdomains ? "*." : ""}${rule.host}${rule.pathPrefix}`;
}

/**
 * @param {string | URL} url
 * @returns {URL | null}
 */
function toUrl(url) {
	if (url instanceof URL) return url;
	if (typeof url !== "string") return null;
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

/**
 * Is the URL inside the rule? https on the default port only; the host is the
 * rule's own, or with "subdomains" a name below it on a label boundary; the
 * path prefix on segment boundaries ("/r/" covers "/r/x" but not "/rss").
 * Fails closed on anything odd: another scheme or port, userinfo, a path with
 * encoded separators or dots that a server might decode differently, or with
 * a dot segment that carries a path parameter ("/r/..;/admin").
 * @param {string | URL} url
 * @param {unknown} rule
 * @param {OptInOptions} [opts]
 * @returns {boolean}
 */
export function isWithinRule(url, rule, opts = {}) {
	const r = normalizeOptInRule(rule, opts);
	const u = toUrl(url);
	if (r === null || u === null) return false;
	if (u.username !== "" || u.password !== "") return false;
	const host = canonicalHost(u.hostname);
	const fixturePorts = opts.fixturePorts ?? [];
	if (fixturePorts.length > 0 && isLoopbackHost(host)) {
		// A fixture: plain http on one of the ports the test run allows, nothing else.
		if (u.protocol !== "http:" || !fixturePorts.includes(u.port === "" ? 80 : Number(u.port))) return false;
	} else if (u.protocol !== "https:" || u.port !== "") {
		return false;
	}
	if (host !== r.host && !(r.subdomains && isUnder(host, r.host))) return false;
	const path = u.pathname;
	// Encoded once or over again: a server that decodes more often than the browser would see a separator.
	if (/%(?:25)*(?:2f|5c|2e)|\\/i.test(path)) return false;
	if (PARAM_DOT_SEGMENT.test(path)) return false;
	const base = r.pathPrefix.replace(/\/+$/, "");
	return path === base || path.startsWith(base + "/");
}

/**
 * @param {string | URL} url
 * @param {readonly unknown[]} rules
 * @param {OptInOptions} [opts]
 * @returns {OptInRule | null} the most specific matching rule (longest host, then longest prefix)
 */
export function matchOptInRule(url, rules, opts = {}) {
	/** @type {OptInRule | null} */
	let best = null;
	for (const rule of rules) {
		if (!isWithinRule(url, rule, opts)) continue;
		const r = normalizeOptInRule(rule, opts);
		if (r === null) continue;
		if (
			best === null ||
			r.host.length > best.host.length ||
			(r.host.length === best.host.length && r.pathPrefix.length > best.pathPrefix.length)
		) {
			best = r;
		}
	}
	return best;
}

/**
 * @param {string} host canonical URL host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
	return host === "127.0.0.1" || host === "[::1]" || isUnder(host, "localhost");
}

/**
 * The single entry point: normalise, classify the host, apply the blocklist.
 * @param {unknown} url
 * @param {{ blocklist?: readonly string[], allowLoopbackPorts?: readonly number[] }} [opts]
 *   allowLoopbackPorts is a test-only escape hatch for fixture servers: loopback
 *   hosts on exactly these ports skip the host classification. Empty by default.
 * @returns {{ allowed: true, url: string, host: string } | { allowed: false, reason: string }}
 */
export function checkUrl(url, opts = {}) {
	const blocklist = opts.blocklist ?? DEFAULT_BLOCKLIST;
	const loopbackPorts = opts.allowLoopbackPorts ?? [];
	const n = normalizeUrl(url);
	if (!n.ok) return { allowed: false, reason: n.reason };
	const fixture = loopbackPorts.length > 0 && isLoopbackHost(n.host) && loopbackPorts.includes(n.port);
	if (!fixture) {
		const c = classifyHost(n.host);
		if (!c.allowed) return { allowed: false, reason: c.reason };
	}
	if (matchBlocklist(n.host, blocklist) !== null) return { allowed: false, reason: REASON.BLOCKLISTED };
	return { allowed: true, url: n.url, host: n.host };
}
