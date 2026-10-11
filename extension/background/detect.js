// Block and challenge detection: what the response headers of
// a page say, what its DOM shows, and what follows from the two.
//
// Three things can be found:
//   a challenge   the site wants to see a human (or just a browser) first. The
//                 page may clear by itself; if it does not, it is the
//                 operator's to clear.
//   a block       the site refuses. Nothing here or at the operator's desk
//                 changes that: the job ends as "blocked".
//   a wall        a login or consent page instead of the content. Reported,
//                 never filled in.
//
// Nothing is ever done to a page because of what is found here. The extension
// does not click, type, focus a widget or send it events, and holds no code
// that solves anything.
//
// Every word that leaves this module as "kind" or "evidence" is one of the
// constants below. Page text is looked at, never passed on.

export const KIND = Object.freeze({
	CLOUDFLARE: "cloudflare_challenge",
	DATADOME: "datadome_challenge",
	CAPTCHA: "captcha_challenge",
	REDDIT_BLOCK: "reddit_block",
	HTTP_403: "http_403",
	HTTP_429: "http_429",
	LOGIN_WALL: "login_wall",
	CONSENT_WALL: "consent_wall",
});

export const EVIDENCE = Object.freeze({
	CF_HEADER: "header cf-mitigated=challenge",
	CF_TITLE: "interstitial title",
	CF_ELEMENT: "cloudflare challenge element",
	TURNSTILE_FRAME: "frame challenges.cloudflare.com",
	DATADOME_FRAME: "frame captcha-delivery.com",
	RECAPTCHA_FRAME: "frame recaptcha",
	HCAPTCHA_FRAME: "frame hcaptcha.com",
	REDDIT_TEXT: "reddit network security page",
	STATUS_403: "status 403",
	STATUS_429: "status 429",
	LOGIN_PATH: "redirect to a login path",
	LOGIN_HOST: "redirect to an accounts host",
	CONSENT_HOST: "redirect to a consent host",
	CONSENT_ELEMENT: "consent dialog with little else on the page",
});

/** What a job result says about a challenge that went away. */
export const RESOLVED = Object.freeze({ WAITING: "cleared_by_waiting", OPERATOR: "cleared_by_operator" });

/** One fixed sentence per kind, for the error of a job that ends because of it. */
export const KIND_MESSAGE = Object.freeze({
	[KIND.CLOUDFLARE]: "the page shows a Cloudflare human check",
	[KIND.DATADOME]: "the page shows a DataDome human check",
	[KIND.CAPTCHA]: "the page shows a CAPTCHA",
	[KIND.REDDIT_BLOCK]: "the site blocked the request (network security page)",
	[KIND.HTTP_403]: "the site refused the request (HTTP 403)",
	[KIND.HTTP_429]: "the site is rate limiting (HTTP 429)",
	[KIND.LOGIN_WALL]: "the site sent the browser to a login page",
	[KIND.CONSENT_WALL]: "the site shows a consent page instead of the content",
});

export const DETECT_LIMITS = Object.freeze({
	// Visible text shorter than this is "thin": an interstitial, a widget on an otherwise empty page.
	thinTextChars: 800,
	// From here on a page is content, whatever else is on it: never a challenge.
	substantialTextChars: 4000,
	// Longest Retry-After that is passed on, in seconds.
	maxRetryAfterS: 3600,
});

/** Statuses a challenge or block page is served with. */
const CHALLENGE_STATUS = new Set([403, 429, 503]);

/**
 * @typedef {{ name: string, value?: string }} Header
 *
 * @typedef {object} HeaderFacts what the response headers of the top frame say
 * @property {boolean} cfMitigated cf-mitigated: challenge
 * @property {number | null} retryAfterS Retry-After in seconds from now
 *
 * @typedef {object} DomFacts what content/detect-dom.js saw: flags and one number, nothing of the page's text
 * @property {boolean} titleInterstitial the title of a "just a moment" page
 * @property {boolean} cfChallenge elements of a Cloudflare challenge page
 * @property {boolean} turnstile a frame from challenges.cloudflare.com
 * @property {boolean} datadome a frame from captcha-delivery.com
 * @property {boolean} recaptcha a reCAPTCHA frame
 * @property {boolean} hcaptcha an hCaptcha frame
 * @property {boolean} redditBlock Reddit's "blocked by network security" page
 * @property {boolean} consent the dialog of a consent manager
 * @property {boolean} cfChlOpt a script mentions _cf_chl_opt. Recorded, and by itself no signal
 * @property {number} textLen length of the text the page shows
 *
 * @typedef {object} PageFacts
 * @property {number | null} status HTTP status of the last top-frame response
 * @property {boolean} cfMitigated
 * @property {number | null} retryAfterS
 * @property {string} requestedUrl
 * @property {string | null} finalUrl where the tab is now
 * @property {DomFacts | null} dom null when the page could not be looked at
 *
 * @typedef {object} Detection
 * @property {string} kind one of KIND
 * @property {string} evidence one of EVIDENCE
 * @property {"challenge" | "blocked"} action challenge: wait, then hand over to the operator; blocked: give up
 * @property {number | null} retryAfterS what the site asked for, where it did
 */

/**
 * @param {readonly Header[]} headers
 * @param {string} name lowercase
 * @returns {string | null}
 */
function header(headers, name) {
	for (const h of headers) {
		if (typeof h.name === "string" && h.name.toLowerCase() === name) return h.value ?? "";
	}
	return null;
}

/**
 * Retry-After as seconds from now: a number of seconds, or an HTTP date.
 * @param {string | null} value
 * @param {number} now epoch ms
 * @returns {number | null} null when absent or not understood
 */
export function parseRetryAfter(value, now) {
	if (value === null) return null;
	const v = value.trim();
	if (/^[0-9]{1,9}$/.test(v)) return Math.min(Number(v), DETECT_LIMITS.maxRetryAfterS);
	if (v.length < 10 || v.length > 40) return null;
	const at = Date.parse(v);
	if (!Number.isFinite(at)) return null;
	return Math.min(Math.max(Math.ceil((at - now) / 1000), 0), DETECT_LIMITS.maxRetryAfterS);
}

/**
 * The two response headers that matter here. Read, never changed.
 * @param {readonly Header[]} headers
 * @param {number} [now]
 * @returns {HeaderFacts}
 */
export function headerFacts(headers, now = Date.now()) {
	const mitigated = header(headers, "cf-mitigated");
	return {
		cfMitigated: mitigated !== null && mitigated.trim().toLowerCase() === "challenge",
		retryAfterS: parseRetryAfter(header(headers, "retry-after"), now),
	};
}

/**
 * What the content script handed back, reduced to flags and one number. The
 * script runs next to an untrusted page: nothing of its answer is taken on trust.
 * @param {unknown} raw
 * @returns {DomFacts | null} null when the script gave no answer
 */
export function cleanDomFacts(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const r = /** @type {Record<string, unknown>} */ (raw);
	if (r.ok !== true) return null;
	const len = r.text_len;
	return {
		titleInterstitial: r.title_interstitial === true,
		cfChallenge: r.cf_challenge === true,
		turnstile: r.turnstile === true,
		datadome: r.datadome === true,
		recaptcha: r.recaptcha === true,
		hcaptcha: r.hcaptcha === true,
		redditBlock: r.reddit_block === true,
		consent: r.consent === true,
		cfChlOpt: r.cf_chl_opt === true,
		textLen: typeof len === "number" && Number.isFinite(len) ? Math.min(Math.max(Math.floor(len), 0), 100000000) : 0,
	};
}

const LOGIN_SEGMENT = /^(?:login|log-in|log_in|signin|sign-in|sign_in|logon)(?:\.[a-z0-9]{1,5})?$/;
const LOGIN_LABELS = new Set(["accounts", "account", "login", "signin", "sso", "auth"]);
const CONSENT_LABELS = new Set(["consent"]);

/**
 * @param {string | null} url
 * @returns {URL | null}
 */
function parse(url) {
	if (url === null) return null;
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:" ? u : null;
	} catch {
		return null;
	}
}

/**
 * Is this the address of a login page: a path with a segment like /login or
 * /signin, or a host whose first label is "accounts", "login" and the like.
 * @param {URL} u
 * @returns {"path" | "host" | null}
 */
function loginLike(u) {
	const first = u.hostname.split(".")[0];
	if (u.hostname.includes(".") && LOGIN_LABELS.has(first)) return "host";
	for (const segment of u.pathname.toLowerCase().split("/")) {
		if (LOGIN_SEGMENT.test(segment)) return "path";
	}
	return null;
}

/**
 * A top-level redirect that ended somewhere the content is not: a login page
 * or a consent page. Only a redirect counts - a login page that was asked for
 * by its own address is the page that was asked for.
 * @param {string} requestedUrl
 * @param {string | null} finalUrl
 * @returns {{ kind: string, evidence: string } | null}
 */
export function classifyRedirect(requestedUrl, finalUrl) {
	const from = parse(requestedUrl);
	const to = parse(finalUrl);
	if (from === null || to === null) return null;
	if (from.origin === to.origin && from.pathname === to.pathname) return null;
	const login = loginLike(to);
	if (login !== null && loginLike(from) === null) {
		return { kind: KIND.LOGIN_WALL, evidence: login === "host" ? EVIDENCE.LOGIN_HOST : EVIDENCE.LOGIN_PATH };
	}
	const consent = (/** @type {URL} */ u) => u.hostname.includes(".") && CONSENT_LABELS.has(u.hostname.split(".")[0]);
	if (consent(to) && !consent(from)) return { kind: KIND.CONSENT_WALL, evidence: EVIDENCE.CONSENT_HOST };
	return null;
}

/**
 * The verdict on a loaded page.
 *
 * Rules, in this order:
 *  1. A page that shows a lot of text is content. It is never a challenge,
 *     whatever scripts and frames it carries.
 *  2. cf-mitigated: challenge with 403, 429 or 503 is a Cloudflare challenge.
 *  3. Challenge markers in the DOM count together with thin content or with
 *     one of those statuses, not on a page of ordinary length that loaded
 *     with 200. _cf_chl_opt is no marker at all.
 *  4. Reddit's network security page is a block.
 *  5. 429 is a rate limit, 403 without any challenge marker a refusal.
 *  6. A redirect to a login or consent address is a wall; so is a consent
 *     dialog on a page with little else.
 * @param {PageFacts} facts
 * @returns {Detection | null} null: nothing in the way
 */
export function decide(facts) {
	const { status, dom } = facts;
	const matching = status !== null && CHALLENGE_STATUS.has(status);
	const textLen = dom === null ? 0 : dom.textLen;
	const thin = textLen < DETECT_LIMITS.thinTextChars;
	const substantial = textLen >= DETECT_LIMITS.substantialTextChars;
	/** @param {string} kind @param {string} evidence @returns {Detection} */
	const challenge = (kind, evidence) => ({ kind, evidence, action: "challenge", retryAfterS: null });
	/** @param {string} kind @param {string} evidence @returns {Detection} */
	const blocked = (kind, evidence) => ({ kind, evidence, action: "blocked", retryAfterS: facts.retryAfterS });

	if (!substantial) {
		if (facts.cfMitigated && matching) return challenge(KIND.CLOUDFLARE, EVIDENCE.CF_HEADER);
		if (dom !== null && (thin || matching)) {
			if (dom.titleInterstitial) return challenge(KIND.CLOUDFLARE, EVIDENCE.CF_TITLE);
			if (dom.cfChallenge) return challenge(KIND.CLOUDFLARE, EVIDENCE.CF_ELEMENT);
			if (dom.turnstile) return challenge(KIND.CLOUDFLARE, EVIDENCE.TURNSTILE_FRAME);
			if (dom.datadome) return challenge(KIND.DATADOME, EVIDENCE.DATADOME_FRAME);
			if (dom.recaptcha) return challenge(KIND.CAPTCHA, EVIDENCE.RECAPTCHA_FRAME);
			if (dom.hcaptcha) return challenge(KIND.CAPTCHA, EVIDENCE.HCAPTCHA_FRAME);
			if (dom.redditBlock) return blocked(KIND.REDDIT_BLOCK, EVIDENCE.REDDIT_TEXT);
		}
	}
	if (status === 429) return blocked(KIND.HTTP_429, EVIDENCE.STATUS_429);
	if (status === 403) return blocked(KIND.HTTP_403, EVIDENCE.STATUS_403);
	const redirect = classifyRedirect(facts.requestedUrl, facts.finalUrl);
	if (redirect !== null) return blocked(redirect.kind, redirect.evidence);
	if (dom !== null && dom.consent && thin) return blocked(KIND.CONSENT_WALL, EVIDENCE.CONSENT_ELEMENT);
	return null;
}
