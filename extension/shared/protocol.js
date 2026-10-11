// Extension <-> daemon wire protocol, shared by both sides.
// Standard JS only. Every frame is one JSON text message of the form
// { v: 1, type: "<message type>", ...fields }.
//
// Handshake: hello -> challenge -> auth -> ready. Both MACs cover the mode
// from hello, the port, the protocol versions stated in hello and challenge,
// the instance id from the challenge and both nonces (see auth.js). The port
// is in no frame: the daemon uses the one it listens on, the extension the one
// it dialled, so a proof cannot be carried from one port to another. The
// extension must verify mac_s before it sends auth, and must drop the
// connection without answering if it does not verify.
//
// Two versions. The proof comes before the verdict (see HANDSHAKE_CORE_SINCE
// below). A daemon answers the hello of another version, 5 or later, with its
// ordinary challenge, which states the daemon's own version, and takes nothing
// more on that connection: whatever comes next is closed with 4003. The
// extension checks mac_s first and compares the versions after. Proof right
// and versions different: it leaves without sending auth and is in the
// terminal state "version mismatch" - told by the daemon it is paired with,
// not by whoever holds the port. Proof wrong: "daemon not verified", as for
// any peer that proved nothing. A hello of a version before 5 is closed with
// 4003 before any proof: those versions made their proofs in another form,
// and this daemon makes none in it.
//
// Frames after ready carry no MAC of their own. The extension takes "ready"
// and everything after it only on the connection whose mac_s it verified, and
// that proof holds for nobody but the listener on the dialled port.
//
// Reconnect contract for the extension. What to do when the daemon closes
// the socket depends on the close code - but 4001 to 4004 only mean what they
// say when the daemon's mac_s was verified on that same connection. From a peer that proved nothing they are all the same: keep the
// stored key, report "daemon not verified", retry with a long backoff (60 s
// at most). No close code and no failed handshake ever deletes or replaces
// the stored key; only the operator or a completed pairing does.
//
//   4001 auth_failed        Terminal. The key (or pairing code) is wrong. Stop
//                           reconnecting and ask the operator to pair again.
//   4004 not_paired         Terminal until paired. The daemon holds no key.
//                           (A daemon cannot say this and prove itself, and
//                           since version 5 it does not say it: without a key
//                           it answers like a daemon that holds another one.)
//   4003 protocol_version   Terminal. Daemon and extension speak different
//                           protocol versions; one of them must be updated.
//   4002 already_connected  Another browser profile holds the link. Back off
//                           for a long time (minutes), do not hammer.
//   anything else           Reconnect with backoff (daemon restart, network
//                           hiccup, missed pings, a frame the daemon refused).
//                           The daemon throttles nothing: no close code
//                           means "try again later".
//
// A terminal state ends when the operator acts (pairs again, updates).
// On every reconnect the extension aborts its own jobs: the daemon has
// already failed them and never replays a job by itself.
//
// Parked jobs. A job whose page shows a challenge that does not clear by
// itself is not finished: the extension keeps the tab open, sends the event
// challenge.pending { job, host, detect } and, whenever the job does end,
// exactly one job.result for it. From the event on the job holds no slot.
// challenge.acked { job } says that the operator was given the tab. The
// daemon may send attention { job, action } for a parked job at any time.
// Parked jobs survive nothing: when the link goes down, both sides end them.
//
// Files. A job whose top-level response is a file (a PDF, JSON, an image)
// instead of a page ends with a job.result whose "file" member describes it:
// name, size, SHA-256 and how many pieces it came in. The bytes do not fit a
// result frame, so they travel first, in job.blob frames: numbered from 0,
// each with the offset of its bytes in the file, each but the last holding
// exactly LIMITS.BLOB_CHUNK_BYTES of them as base64. Then the one job.result.
// Only a job whose job.start carried "files" may send any, and never more
// bytes than that allowed. The daemon puts the pieces together, checks their
// count, the size and the hash, and keeps nothing of a transfer that does not
// add up or does not end. Between two pieces the extension lets other frames
// through (pings, a job.cancel).

import { OPTIN_LIMITS } from "./policy.js";

// 2: job.result.render carries scroll and dwell (what a hidden gateway window skipped).
// 3: job.result.render carries timings (where the time of a job went), and render.scroll knows
//    "skipped_handoff". Extension 0.1.3.
// 4: file retrieval. job.start carries "files", job.result carries "file" and nav.body_bytes, job.blob frames carry
//    the bytes, job.progress knows the phase "receiving_file". Extension 0.1.4 and its daemon must be updated together.
// 5: both handshake MACs cover the port and the versions of both sides. No frame changed its shape, but a proof
//    of version 4 is not one of version 5: daemon and extension must be updated together.
export const PROTOCOL_VERSION = 5;

// The handshake core. From this version on three things are fixed, and every
// later version must keep them exactly as they are:
//   - the members of "hello" (mode, ext_version, browser, nonce_c) and of
//     "challenge" (instance, nonce_s, mac_s), each with "v" and "type";
//   - the form of the two proofs, mac_s and mac_c (auth.js);
//   - the rule that a daemon answers a hello of another version from this one
//     on with its challenge, and that an extension checks the proof in a
//     challenge before it looks at its version.
// That is what lets a daemon and an extension of different versions tell each
// other so with proof. A version that changes any of it is to the others a
// stranger on the port: "daemon not verified", retried for ever, instead of
// "version mismatch, update both". What a version may change freely is
// everything after the challenge.
export const HANDSHAKE_CORE_SINCE = 5;

export const DIRECTION = Object.freeze({
	TO_DAEMON: "ext_to_daemon",
	TO_EXT: "daemon_to_ext",
});

export const MSG = Object.freeze({
	HELLO: "hello",
	CHALLENGE: "challenge",
	AUTH: "auth",
	READY: "ready",
	JOB_START: "job.start",
	JOB_ACCEPTED: "job.accepted",
	JOB_PROGRESS: "job.progress",
	JOB_CANCEL: "job.cancel",
	JOB_BLOB: "job.blob",
	JOB_RESULT: "job.result",
	EVENT: "event",
	ATTENTION: "attention",
	PING: "ping",
	PONG: "pong",
});

export const CLOSE = Object.freeze({
	AUTH_FAILED: 4001,
	ALREADY_CONNECTED: 4002,
	PROTOCOL_VERSION: 4003,
	NOT_PAIRED: 4004,
	// Standard codes the daemon also uses.
	GOING_AWAY: 1001,
	UNSUPPORTED_DATA: 1003,
	POLICY_VIOLATION: 1008,
	TOO_BIG: 1009,
});

export const CLOSE_REASON = Object.freeze({
	4001: "auth_failed",
	4002: "already_connected",
	4003: "protocol_version",
	4004: "not_paired",
});

export const HELLO_MODES = Object.freeze(/** @type {const} */ (["auth", "pair"]));
export const JOB_KINDS = Object.freeze(/** @type {const} */ (["fetch", "search", "probe"]));
export const SESSIONS = Object.freeze(/** @type {const} */ (["auto", "isolated"]));
export const SCROLL_MODES = Object.freeze(/** @type {const} */ (["none", "lazy"]));
export const ADAPTERS = Object.freeze(/** @type {const} */ (["auto", "none"]));
export const COOKIE_SCOPES = Object.freeze(/** @type {const} */ (["container", "default"]));
export const PHASES = Object.freeze(["navigating", "settling", "challenge_wait", "extracting", "receiving_file"]);
export const CANCEL_REASONS = Object.freeze(["deadline", "client_gone", "shutdown"]);
export const OUTCOMES = Object.freeze([
	"ok",
	"blocked",
	"needs_human",
	"timeout",
	"policy_blocked",
	"unsupported",
	"aborted",
	"error",
]);
export const EVENT_NAMES = Object.freeze([
	"challenge.pending",
	"challenge.acked",
	"challenge.cleared",
	"paused",
	"resumed",
	"window.closed",
	"policy.changed",
	// Anything else in the state changed (the gateway window was opened, the
	// container became ready or went away). The state itself is the news.
	"state.changed",
]);
// focus: bring the challenge tab to the operator (the extension opens it in a
// window of its own). renotify: show the extension's own notification again.
export const ATTENTION_ACTIONS = Object.freeze(["focus", "renotify"]);
/**
 * How a challenge that was detected went away, on a result that ended "ok":
 * by itself within the grace period, or because the operator passed it.
 */
export const DETECT_RESOLUTIONS = Object.freeze(/** @type {const} */ (["cleared_by_waiting", "cleared_by_operator"]));
/**
 * What the Markdown of a result is a view of:
 *   article    the main content of the page, the rest left out
 *   full_page  everything the page shows, as Markdown: the article view held
 *              too small a share of it (forum threads, comment pages)
 *   text       the Markdown is the plain visible text itself (a page with
 *              next to no content, one too large to analyse, a text file)
 */
export const EXTRACTION_VIEWS = Object.freeze(/** @type {const} */ (["article", "full_page", "text"]));
export const VISIBILITY = Object.freeze(["visible", "hidden"]);
/**
 * What became of the walk down the page (wait.scroll "lazy"), and of the dwell,
 * as reported in render:
 *   off               not asked for, or not allowed (a tab with the operator's session)
 *   done              carried out
 *   skipped_hidden    asked for, not done: the tab was hidden (another virtual desktop, minimised)
 *   cut_short_hidden  scroll only: the tab went out of sight in the middle of the walk
 *   skipped_handoff   scroll only: asked for, not done: the page was read right after the operator passed its
 *                     check, in the window they have in front of them
 */
export const SCROLL_RESULTS = Object.freeze(/** @type {const} */ (["off", "done", "skipped_hidden", "cut_short_hidden", "skipped_handoff"]));
export const DWELL_RESULTS = Object.freeze(/** @type {const} */ (["off", "done", "skipped_hidden"]));
/**
 * Where the time of a job went, in milliseconds of the wall clock, as render.timings reports it. Every phase
 * is there on every result; one that did not happen is 0.
 *   prep_ms            before the page was asked for: policy, container, address check, job tab
 *   nav_ms             from asking for the page until it had loaded (a retry included)
 *   settle_ms          settling: the quiet check and the walk down the page
 *   scroll_ms          of that, the walk
 *   grace_ms           the grace period of a challenge, until it cleared or was over
 *   parked_ms          parked for the operator, until the watch over the tab ended
 *   handoff_ms         of that, from parking until the operator was given the tab; 0: they never were
 *   cleared_settle_ms  from the moment a challenge was seen gone until the page behind it had settled
 *   dwell_ms           the pacing pause before the page was read
 *   extract_ms         reading the page
 */
export const TIMING_PHASES = Object.freeze(
	/** @type {const} */ (["prep_ms", "nav_ms", "settle_ms", "scroll_ms", "grace_ms", "parked_ms", "handoff_ms", "cleared_settle_ms", "dwell_ms", "extract_ms"]),
);

/** @returns {JobTimings} every phase at 0 */
export function zeroTimings() {
	return { prep_ms: 0, nav_ms: 0, settle_ms: 0, scroll_ms: 0, grace_ms: 0, parked_ms: 0, handoff_ms: 0, cleared_settle_ms: 0, dwell_ms: 0, extract_ms: 0 };
}

/** Error codes the daemon itself puts into a result. The extension adds its own. */
export const ERROR_CODE = Object.freeze({
	BROWSER_DISCONNECTED: "browser_disconnected",
	INVALID_RESULT: "invalid_result",
	EXTENSION_NOT_CONNECTED: "extension_not_connected",
	PAUSED: "paused",
	DEADLINE: "deadline",
	QUEUE_TIMEOUT: "queue_timeout",
	QUEUE_FULL: "queue_full",
	CLIENT_GONE: "client_gone",
	SHUTDOWN: "shutdown",
	SCOPE_VIOLATION: "scope_violation",
	// The hourly budget of the site is used up; retry_after_s says when it frees.
	SITE_BUDGET: "site_budget",
	// The site blocked or challenged a moment ago and is left alone for a while.
	SITE_COOLDOWN: "site_cooldown",
	// A challenge page waits for the operator: this job's own (the caller is
	// answered while it waits), or an earlier one of the same site.
	CHALLENGE_PENDING: "challenge_pending",
	// The extension parked more challenges than the daemon lets wait.
	TOO_MANY_PENDING: "too_many_pending",
	// Nobody cleared the challenge in time.
	CHALLENGE_EXPIRED: "challenge_expired",
	// Pages under one of the operator's login rules were asked for too often. The
	// extension enforces the limit; the daemon paces to it and says the same.
	LOGIN_RATE_LIMIT: "login_rate_limit",
	// The pieces of a file did not add up: one missing, twice, out of order, more bytes than allowed, another hash.
	FILE_TRANSFER_FAILED: "file_transfer_failed",
	// A file came back for a job that was not allowed to return one.
	FILE_UNEXPECTED: "file_unexpected",
	// Both sides say this one: the file is larger than the operator allows (files.max_mb).
	TOO_LARGE: "too_large",
});

export const LIMITS = Object.freeze({
	MAX_RESULT_BYTES: 8388608,
	// The page source (content.raw_html), in characters. Cut here by the extractor, and first of all when the frame is too big.
	MAX_RAW_HTML_CHARS: 4194304,
	PING_S: 20,
	MAX_URL: 2048,
	MAX_FINAL_URL: 8192,
	MAX_SLOTS: 16,
	MAX_OPTIN_HOSTS: 256,
	MAX_REDIRECTS: 32,
	MAX_LINKS: 5000,
	// Results of one search, and how long each of their parts may be.
	MAX_RESULTS: 20,
	MAX_RESULT_TITLE: 300,
	MAX_RESULT_SNIPPET: 500,
	MAX_TIMEOUT_MS: 3600000,
	// More elements than the extractor ever looks at on one page.
	MAX_HIDDEN_REMOVED: 1000000,
	// The largest file that can travel at all, whatever the operator allows (files.max_mb is at most this).
	MAX_FILE_BYTES: 209715200,
	// Bytes of a file in one job.blob frame: every frame but the last holds exactly this many.
	BLOB_CHUNK_BYTES: 196608,
	// The same as base64 characters, and the most frames one file can take.
	MAX_BLOB_CHARS: 262144,
	MAX_BLOB_FRAMES: 1067,
	// Entries of the type allowlist that rides along with a job.
	MAX_FILE_TYPES: 64,
	// The name a server suggests for a file, as the extension passes it on. The daemon makes the name that is used.
	MAX_FILE_NAME: 255,
});

/**
 * @typedef {object} ExtState
 * @property {boolean} paused
 * @property {string | null} pause_reason
 * @property {number} slots
 * @property {{ ready: boolean }} container
 * @property {{ open: boolean }} window
 * @property {number} policy_rev
 * @property {string[]} optin_hosts
 *
 * @typedef {object} JobWait
 * @property {number} timeout_ms
 * @property {number} settle_ms
 * @property {number} dwell_ms
 * @property {number} human_wait_ms how long a challenge that did not clear by itself may wait, parked, for the
 *   operator. 0: do not park, report needs_human and close the tab
 * @property {"none" | "lazy"} scroll
 *
 * @typedef {object} JobExtract
 * @property {boolean} markdown
 * @property {boolean} text the full visible text of the page, next to the Markdown
 * @property {boolean} html
 * @property {boolean} raw_html the page source as the live document holds it. Always taken in the container;
 *   in the operator's login scope only when asked for here
 * @property {boolean} links
 * @property {"auto" | "none"} adapter
 *
 * @typedef {object} JobFiles what a job may bring back when its response is a file instead of a page
 * @property {number} max_bytes the most bytes of a file; reading stops there
 * @property {string[]} types the operator's allowlist: media types, and "+suffix" for every type that ends so
 *
 * @typedef {object} JobFile the file a job.result brings; its bytes went ahead in job.blob frames
 * @property {string | null} name what the server suggests as a file name (Content-Disposition), untouched: the
 *   daemon makes a safe name of it, or of the address
 * @property {string | null} charset of the declared content type, lowercase
 * @property {number} size in bytes
 * @property {string} sha256 hex, of those bytes
 * @property {number} chunks job.blob frames that carried them
 *
 * @typedef {"ok" | "blocked" | "needs_human" | "timeout" | "policy_blocked" | "unsupported" | "aborted" | "error"} Outcome
 * @typedef {"container" | "default"} CookieScope
 * @typedef {(typeof SCROLL_RESULTS)[number]} ScrollResult
 * @typedef {(typeof DWELL_RESULTS)[number]} DwellResult
 *
 * @typedef {object} JobError
 * @property {string} code
 * @property {string} message
 * @property {boolean} retryable
 * @property {number | null} retry_after_s
 *
 * @typedef {object} JobNav
 * @property {string} requested_url
 * @property {string | null} final_url
 * @property {string[]} redirect_origins
 * @property {number | null} http_status
 * @property {string | null} content_type
 * @property {number | null} body_bytes bytes of the response body that a file capture read, whether or not it
 *   was read to the end; null when nothing was captured
 *
 * @typedef {Record<(typeof TIMING_PHASES)[number], number>} JobTimings
 *
 * @typedef {object} JobRender
 * @property {"visible" | "hidden" | null} visibility
 * @property {number | null} raf_hz
 * @property {boolean} settled
 * @property {number} scrolled_px
 * @property {ScrollResult} scroll
 * @property {DwellResult} dwell
 * @property {number} elapsed_ms
 * @property {JobTimings} timings where that time went: integers only
 *
 * @typedef {object} JobExtraction how the content was taken from the page: enums and counts, no page text
 * @property {"article" | "full_page" | "text"} view what the Markdown is a view of
 * @property {number | null} coverage_pct length of the article view's text in percent of the visible text; null
 *   when no article view was made
 * @property {number} hidden_removed pieces of text the page does not render that were left out
 * @property {boolean} capped the page has more elements than are looked at; what lay beyond was dropped
 *
 * @typedef {object} JobDetect what stood in the way of the content. Kind and evidence come from the extension's
 *   fixed vocabulary (background/detect.js), never from the page
 * @property {string} kind
 * @property {string} evidence
 * @property {number} waited_ms from the moment it was seen until the job went on or ended
 * @property {"cleared_by_waiting" | "cleared_by_operator" | null} resolved set on an "ok" result: the challenge went away
 *
 * @typedef {object} JobResultBody
 * @property {string} job
 * @property {Outcome} outcome
 * @property {CookieScope | null} cookie_scope null when no tab was ever opened
 * @property {JobNav} nav
 * @property {JobRender} render
 * @property {JobDetect | null} detect
 * @property {JobError | null} error
 * @property {{ title: string | null, author: string | null, published: string | null, lang: string | null,
 *   site: string | null, word_count: number | null, extractor: string | null } | null} page
 * @property {JobExtraction | null} extraction null when the page was not read
 * @property {{ markdown: string | null, text: string | null, html: string | null, raw_html: string | null, links: { url: string, text: string }[],
 *   results: { rank: number, title: string, url: string, snippet: string }[] } | null} content
 *   text: the full visible text. null when it was not asked for, and when the view is "text": the Markdown is it then
 * @property {{ markdown: boolean, text: boolean, html: boolean, raw_html: boolean }} truncated
 * @property {JobFile | null} file set when the response was a file: page, extraction and content are null then
 * @property {boolean} tab_kept_open
 *
 * @typedef {object} JobBlobMsg
 * @property {string} job
 * @property {number} seq 0, 1, 2 ...
 * @property {number} offset where the bytes of this frame begin in the file: the count of all bytes before
 * @property {string} data base64
 *
 * @typedef {object} HelloMsg
 * @property {"auth" | "pair"} mode
 * @property {string} ext_version
 * @property {{ name: string, version: string }} browser
 * @property {string} nonce_c
 *
 * @typedef {object} AuthMsg
 * @property {string} mac_c
 * @property {ExtState} state
 *
 * @typedef {object} JobAcceptedMsg
 * @property {string} job
 * @property {CookieScope} cookie_scope
 * @property {{ host: string, path_prefix: string, subdomains: boolean } | null} rule the operator's login rule the URL
 *   lies in; null for a job in the container
 *
 * @typedef {object} JobProgressMsg
 * @property {string} job
 * @property {"navigating" | "settling" | "challenge_wait" | "extracting" | "receiving_file"} phase
 * @property {number | null} http_status
 */

/**
 * A validator returns null when the value is fine, else a short description.
 * Descriptions name fields and expectations only - never the offending value.
 * @typedef {(value: unknown, path: string) => string | null} Check
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * @param {number} max maximum length in UTF-16 code units
 * @param {{ min?: number, pattern?: RegExp }} [opts]
 * @returns {Check}
 */
function str(max, opts = {}) {
	const min = opts.min ?? 0;
	return (v, p) => {
		if (typeof v !== "string") return `${p}: expected string`;
		if (v.length > max) return `${p}: longer than ${max}`;
		if (v.length < min) return `${p}: shorter than ${min}`;
		if (opts.pattern !== undefined && !opts.pattern.test(v)) return `${p}: bad format`;
		return null;
	};
}

/** @param {readonly string[]} values @returns {Check} */
function oneOf(values) {
	return (v, p) => (typeof v === "string" && values.includes(v) ? null : `${p}: not an allowed value`);
}

/** @param {number} min @param {number} max @returns {Check} */
function int(min, max) {
	return (v, p) =>
		typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? null : `${p}: expected integer ${min}..${max}`;
}

/** @param {number} min @param {number} max @returns {Check} */
function num(min, max) {
	return (v, p) =>
		typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? null : `${p}: expected number ${min}..${max}`;
}

/** @type {Check} */
const bool = (v, p) => (typeof v === "boolean" ? null : `${p}: expected boolean`);

/** @param {Check} inner @returns {Check} */
function nullable(inner) {
	return (v, p) => (v === null ? null : inner(v, p));
}

/** @param {Check} inner @param {number} maxItems @returns {Check} */
function arr(inner, maxItems) {
	return (v, p) => {
		if (!Array.isArray(v)) return `${p}: expected array`;
		if (v.length > maxItems) return `${p}: more than ${maxItems} items`;
		for (let i = 0; i < v.length; i++) {
			const err = inner(v[i], `${p}[${i}]`);
			if (err !== null) return err;
		}
		return null;
	};
}

/**
 * Exact object: every listed field is required, nothing else is allowed.
 * @param {Record<string, Check>} fields
 * @returns {Check}
 */
function obj(fields) {
	const names = Object.keys(fields);
	return (v, p) => {
		if (!isPlainObject(v)) return `${p}: expected object`;
		for (const key of Object.keys(v)) {
			if (!Object.hasOwn(fields, key)) return `${p}: unexpected field`;
		}
		for (const name of names) {
			if (!Object.hasOwn(v, name)) return `${p}.${name}: missing`;
			const err = fields[name](v[name], `${p}.${name}`);
			if (err !== null) return err;
		}
		return null;
	};
}

const b64u32 = str(43, { min: 43, pattern: /^[A-Za-z0-9_-]{43}$/ });
const jobId = str(64, { min: 1, pattern: /^[A-Za-z0-9_-]+$/ });
const ident = str(64, { min: 1, pattern: /^[a-z0-9][a-z0-9_.-]*$/ });
const hostName = str(255, { min: 1, pattern: /^[a-z0-9._:\[\]-]+$/ });
const ms = int(0, LIMITS.MAX_TIMEOUT_MS);
const httpStatus = int(100, 599);

const state = obj({
	paused: bool,
	pause_reason: nullable(str(200)),
	slots: int(0, LIMITS.MAX_SLOTS),
	container: obj({ ready: bool }),
	window: obj({ open: bool }),
	policy_rev: int(0, Number.MAX_SAFE_INTEGER),
	optin_hosts: arr(hostName, LIMITS.MAX_OPTIN_HOSTS),
});

const wait = obj({
	timeout_ms: int(1, LIMITS.MAX_TIMEOUT_MS),
	settle_ms: ms,
	dwell_ms: ms,
	human_wait_ms: ms,
	scroll: oneOf(SCROLL_MODES),
});

const extract = obj({
	markdown: bool,
	text: bool,
	html: bool,
	raw_html: bool,
	links: bool,
	adapter: oneOf(ADAPTERS),
});

const cookieScope = oneOf(COOKIE_SCOPES);

// The allowlist entries are compared with media types and nothing else; the shape is the one config.json is held to.
const fileTypeEntry = str(182, { min: 2, pattern: /^(?:\+[a-z0-9.-]{1,40}|[a-z0-9!#$&^_.-]{1,60}\/[a-z0-9!#$&^_.+-]{1,120})$/ });
const files = obj({ max_bytes: int(1, LIMITS.MAX_FILE_BYTES), types: arr(fileTypeEntry, LIMITS.MAX_FILE_TYPES) });

/** @type {Check} whole groups of four base64 characters, padded only at the end */
const base64 = (v, p) => {
	if (typeof v !== "string") return `${p}: expected string`;
	if (v.length < 4 || v.length > LIMITS.MAX_BLOB_CHARS) return `${p}: expected 4..${LIMITS.MAX_BLOB_CHARS} characters`;
	if (v.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return `${p}: bad format`;
	return null;
};

const detect = obj({ kind: ident, evidence: str(500), waited_ms: ms, resolved: nullable(oneOf(DETECT_RESOLUTIONS)) });

const jobStartCommon = {
	job: jobId,
	kind: oneOf(JOB_KINDS),
	session: oneOf(SESSIONS),
	wait,
	extract,
	// null: this job brings no file back, whatever its response turns out to be.
	files: nullable(files),
};

// The address of a job is one the daemon's URL check has let through and written out again
// (policy.js, normalizeUrl): visible ASCII and nothing else - the parser encodes the rest. A control
// character, a space or a letter outside ASCII in this place did not come from that check. Which
// addresses a job may load is not decided here: the extension runs the URL check itself and answers
// a refused one with a result that says why.
const jobUrl = str(LIMITS.MAX_URL, { min: 1, pattern: /^[\u0021-\u007e]+$/ });
const jobStartUrl = obj({ ...jobStartCommon, url: jobUrl });
// A search is the load of one results page. The daemon makes the URL from the
// engine's template and the query; the engine's name only tells the extension
// which of its hints to try, and the limit how many results to hand back.
const jobStartSearch = obj({
	...jobStartCommon,
	url: jobUrl,
	engine: ident,
	limit: int(1, LIMITS.MAX_RESULTS),
});

/** @type {Check} */
const jobStart = (v, p) => {
	if (!isPlainObject(v)) return `${p}: expected object`;
	return v.kind === "search" ? jobStartSearch(v, p) : jobStartUrl(v, p);
};

const jobResult = obj({
	job: jobId,
	outcome: oneOf(OUTCOMES),
	cookie_scope: nullable(cookieScope),
	nav: obj({
		requested_url: str(LIMITS.MAX_URL, { min: 1 }),
		final_url: nullable(str(LIMITS.MAX_FINAL_URL)),
		redirect_origins: arr(str(300), LIMITS.MAX_REDIRECTS),
		http_status: nullable(httpStatus),
		content_type: nullable(str(200)),
		// One chunk more than the largest file: reading stops with the chunk that crossed the limit.
		body_bytes: nullable(int(0, LIMITS.MAX_FILE_BYTES + 16777216)),
	}),
	render: obj({
		visibility: nullable(oneOf(VISIBILITY)),
		raf_hz: nullable(num(0, 1000)),
		settled: bool,
		scrolled_px: int(0, 100000000),
		scroll: oneOf(SCROLL_RESULTS),
		dwell: oneOf(DWELL_RESULTS),
		elapsed_ms: ms,
		timings: obj(Object.fromEntries(TIMING_PHASES.map((phase) => [phase, ms]))),
	}),
	detect: nullable(detect),
	error: nullable(
		obj({
			code: ident,
			message: str(500),
			retryable: bool,
			retry_after_s: nullable(int(0, 86400)),
		}),
	),
	page: nullable(
		obj({
			title: nullable(str(1000)),
			author: nullable(str(500)),
			published: nullable(str(100)),
			lang: nullable(str(35)),
			site: nullable(str(300)),
			word_count: nullable(int(0, 100000000)),
			extractor: nullable(str(100)),
		}),
	),
	extraction: nullable(
		obj({
			view: oneOf(EXTRACTION_VIEWS),
			coverage_pct: nullable(int(0, 100)),
			hidden_removed: int(0, LIMITS.MAX_HIDDEN_REMOVED),
			capped: bool,
		}),
	),
	content: nullable(
		obj({
			markdown: nullable(str(LIMITS.MAX_RESULT_BYTES)),
			text: nullable(str(LIMITS.MAX_RESULT_BYTES)),
			html: nullable(str(LIMITS.MAX_RESULT_BYTES)),
			raw_html: nullable(str(LIMITS.MAX_RAW_HTML_CHARS)),
			// Web addresses only, like the results below: the extension passes on no other link (jobs.js, cleanExtracted).
			links: arr(obj({ url: str(LIMITS.MAX_FINAL_URL, { pattern: /^https?:\/\//i }), text: str(500) }), LIMITS.MAX_LINKS),
			results: arr(
				obj({
					rank: int(1, LIMITS.MAX_RESULTS),
					title: str(LIMITS.MAX_RESULT_TITLE, { min: 1 }),
					url: str(LIMITS.MAX_URL, { min: 1, pattern: /^https?:\/\//i }),
					snippet: str(LIMITS.MAX_RESULT_SNIPPET),
				}),
				LIMITS.MAX_RESULTS,
			),
		}),
	),
	truncated: obj({ markdown: bool, text: bool, html: bool, raw_html: bool }),
	file: nullable(
		obj({
			name: nullable(str(LIMITS.MAX_FILE_NAME)),
			charset: nullable(str(40, { min: 1, pattern: /^[a-z0-9._:-]+$/ })),
			size: int(0, LIMITS.MAX_FILE_BYTES),
			sha256: str(64, { min: 64, pattern: /^[0-9a-f]{64}$/ }),
			chunks: int(0, LIMITS.MAX_BLOB_FRAMES),
		}),
	),
	tab_kept_open: bool,
});

const pingPong = obj({ t: int(0, Number.MAX_SAFE_INTEGER) });

/**
 * dir: who may send the message. fields: validator for the message without
 * its "v" and "type" members.
 * @type {Record<string, { dir: string, fields: Check }>}
 */
const MESSAGES = {
	[MSG.HELLO]: {
		dir: DIRECTION.TO_DAEMON,
		fields: obj({
			mode: oneOf(HELLO_MODES),
			ext_version: str(32, { min: 1, pattern: /^[0-9A-Za-z.+_-]+$/ }),
			browser: obj({ name: str(64), version: str(32) }),
			nonce_c: b64u32,
		}),
	},
	[MSG.CHALLENGE]: {
		dir: DIRECTION.TO_EXT,
		fields: obj({ instance: str(64, { min: 1, pattern: /^[A-Za-z0-9_-]+$/ }), nonce_s: b64u32, mac_s: b64u32 }),
	},
	[MSG.AUTH]: { dir: DIRECTION.TO_DAEMON, fields: obj({ mac_c: b64u32, state }) },
	[MSG.READY]: {
		dir: DIRECTION.TO_EXT,
		fields: obj({ limits: obj({ max_result_bytes: int(1, 16777216), ping_s: int(1, 3600) }) }),
	},
	[MSG.JOB_START]: { dir: DIRECTION.TO_EXT, fields: jobStart },
	[MSG.JOB_ACCEPTED]: {
		dir: DIRECTION.TO_DAEMON,
		fields: obj({
			job: jobId,
			cookie_scope: cookieScope,
			rule: nullable(obj({ host: hostName, path_prefix: str(OPTIN_LIMITS.maxPathPrefix, { min: 1, pattern: /^\// }), subdomains: bool })),
		}),
	},
	[MSG.JOB_PROGRESS]: {
		dir: DIRECTION.TO_DAEMON,
		fields: obj({ job: jobId, phase: oneOf(PHASES), http_status: nullable(httpStatus) }),
	},
	[MSG.JOB_CANCEL]: { dir: DIRECTION.TO_EXT, fields: obj({ job: jobId, reason: oneOf(CANCEL_REASONS) }) },
	[MSG.JOB_BLOB]: {
		dir: DIRECTION.TO_DAEMON,
		fields: obj({ job: jobId, seq: int(0, LIMITS.MAX_BLOB_FRAMES - 1), offset: int(0, LIMITS.MAX_FILE_BYTES), data: base64 }),
	},
	[MSG.JOB_RESULT]: { dir: DIRECTION.TO_DAEMON, fields: jobResult },
	[MSG.EVENT]: {
		dir: DIRECTION.TO_DAEMON,
		// detect rides along with challenge.pending: what the parked job ran into.
		fields: obj({ name: oneOf(EVENT_NAMES), host: nullable(hostName), job: nullable(jobId), state, detect: nullable(detect) }),
	},
	[MSG.ATTENTION]: { dir: DIRECTION.TO_EXT, fields: obj({ job: jobId, action: oneOf(ATTENTION_ACTIONS) }) },
	[MSG.PING]: { dir: "both", fields: pingPong },
	[MSG.PONG]: { dir: "both", fields: pingPong },
};

/**
 * Build a frame object.
 * @param {string} type
 * @param {Record<string, unknown>} [fields]
 * @returns {Record<string, unknown>}
 */
export function makeMessage(type, fields = {}) {
	return { v: PROTOCOL_VERSION, type, ...fields };
}

/**
 * Strict check of one decoded frame. Unknown types, missing or extra fields,
 * wrong field types, values outside an enum and over-long strings all fail.
 * @param {unknown} msg the JSON-decoded frame
 * @param {string} direction the direction the frame travels (DIRECTION.*)
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateMessage(msg, direction) {
	if (direction !== DIRECTION.TO_DAEMON && direction !== DIRECTION.TO_EXT) {
		return { ok: false, error: "unknown direction" };
	}
	if (!isPlainObject(msg)) return { ok: false, error: "message: expected object" };
	if (msg.v !== PROTOCOL_VERSION) return { ok: false, error: "v: unsupported protocol version" };
	const type = msg.type;
	if (typeof type !== "string" || !Object.hasOwn(MESSAGES, type)) return { ok: false, error: "type: unknown message type" };
	const def = MESSAGES[type];
	if (def.dir !== "both" && def.dir !== direction) return { ok: false, error: "type: not allowed in this direction" };
	const { v: _v, type: _type, ...fields } = msg;
	const err = def.fields(fields, type);
	return err === null ? { ok: true } : { ok: false, error: err };
}

/**
 * The protocol version stated in a hello or a challenge that may come from
 * another version: one that keeps the handshake core. Apart from its version
 * the frame must be exactly what this version's is.
 * @param {unknown} msg the JSON-decoded frame
 * @param {string} type MSG.HELLO or MSG.CHALLENGE
 * @param {string} direction the direction the frame travels (DIRECTION.*)
 * @returns {number | null} null: not such a frame, or of a version before the handshake core
 */
export function coreFrameVersion(msg, type, direction) {
	if (type !== MSG.HELLO && type !== MSG.CHALLENGE) return null;
	if (!isPlainObject(msg) || msg.type !== type) return null;
	const v = msg.v;
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < HANDSHAKE_CORE_SINCE) return null;
	return validateMessage({ ...msg, v: PROTOCOL_VERSION }, direction).ok ? v : null;
}
