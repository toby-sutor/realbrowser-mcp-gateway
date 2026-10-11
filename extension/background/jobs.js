// Runs the jobs the daemon sends: one at a time, exactly one job.result each.
//
// Flow: policy -> container -> job.accepted -> address check -> job tab ->
// guard -> navigate -> load complete -> settle (with a bounded walk down the
// page when the job asks for it) -> detect -> dwell -> extract -> close the
// tab -> job.result.
//
// A job tab that is out of sight (another virtual desktop, minimised) gets
// timers that fire about once a second and no frames: every wait inside the
// page costs a second per hop. Settling therefore takes a short path for it
// (see #settle): no walk down the page, no dwell, the waiting done here with
// the background page's own timers, and the result says what was skipped.
// A tab that is made in such a window may also have no viewport yet when its
// page is read: the browser gives it one when it next lays the window out.
// content/extract.js allows for that; nothing here waits for it.
//
// Detect (detect.js, content/detect-dom.js) looks for what can stand in the
// way of the content:
// - a block or a wall (403, 429, a network security page, a login or consent
//   page): the job ends as "blocked";
// - a challenge: the page gets a randomised grace period in which it may clear
//   by itself (a browser check does). If it does, the job goes on and its
//   result says so. If it does not, the job is parked (parked.js): its tab
//   stays open for the operator, this runner is free for the next job, and
//   the one job.result follows when the page was cleared, turned into a
//   refusal, was closed, or nobody came in time.
//
// Extraction runs in the page's isolated world: the vendored Defuddle bundle,
// then content/extract.js, then one call with numbers and booleans. Should
// that fail, the extractor runs once more without Defuddle (the text of what
// the page renders). Only if that fails too the job ends as extract_failed.
//
// A search is a job like any other - the load of one results page, in the
// gateway container, never with the operator's login - whose page is read by
// content/search.js: a list of results instead of an article. Where that
// finds fewer than three, the text and the links of the page go along, so
// that the caller still has what the page showed.
//
// A job tab is only ever navigated, scrolled down and up again by the settle
// script, and read. No clicks, no typing, no focus changes, no synthetic input
// events - a challenge is waited for or handed to the operator, never worked
// on. A tab that runs with the operator's own session is not scrolled.
//
// Which cookie store a job runs in is decided here and nowhere else, at the
// moment its tab is made: the operator's own store when the URL of a fetch lies
// inside one of the rules the operator set in the options page (optin.js),
// the gateway container for everything else. A job can ask for the container
// (session "isolated"); nothing a job carries can ask for the operator's
// store. Such a job is held to its rule for as long as its tab is open: the
// request guard cancels every navigation that would leave it, and what the
// guard cannot hear - an address changed by script, a document without a
// request - is told to it from here and ends the job as well.
//
// Files. A fetch in the gateway container whose top-level response is a file
// (capture.js says which: what the browser would show by itself, and since
// 0.1.6 what it would save) takes another way from the
// moment the request guard says so - at the first load, after a redirect,
// behind a challenge that cleared or that the operator passed: nothing is
// settled, scrolled or extracted, since the tab is given no byte to show. The
// job waits for the response to end, within the time it has left, closes its
// tab, sends the bytes in job.blob frames and then its one job.result with
// the file's description. A search never brings a file back, and neither does
// a tab that runs with the operator's login.
//
// Service workers. A page can leave a worker behind in the gateway container
// that answers later loads of its site itself, where the request guard hears
// no response. Two things stand against that. Every document a job tab
// commits is told to the guard, which ends the job when it never saw the
// response (guard.js, UNGUARDED). And when a job ends, the workers its page
// could have registered are taken away again before the tab is closed:
// content/workers.js asks the page's own registrations - those of the origin
// of each of its frames, nothing else can be reached from a page - to
// unregister. Only in the gateway container; in the operator's own cookie
// store the workers of their sites are theirs.

import { DIRECTION, ERROR_CODE, LIMITS, MSG, TIMING_PHASES, makeMessage, validateMessage, zeroTimings } from "../shared/protocol.js";
import { checkUrl } from "../shared/policy.js";
import { siteOf } from "../shared/site.js";
import { ContainerError } from "./container.js";
import { DETECT_LIMITS, KIND, KIND_MESSAGE, RESOLVED, cleanDomFacts, decide } from "./detect.js";
import { OUT_OF_SCOPE, UNGUARDED } from "./guard.js";
import { DEFAULT_STORE_ID } from "./optin.js";
import { Parked } from "./parked.js";
import { toBase64 } from "./capture.js";
import { errorText } from "./errtext.js";

/**
 * @typedef {import("../shared/protocol.js").Outcome} Outcome
 * @typedef {import("../shared/protocol.js").JobWait} JobWait
 * @typedef {import("../shared/protocol.js").JobExtract} JobExtract
 * @typedef {import("../shared/protocol.js").JobResultBody} JobResultBody
 * @typedef {import("./guard.js").Verdict} Verdict
 * @typedef {import("./guard.js").TabGuard} TabGuard
 * @typedef {import("./detect.js").Detection} Detection
 * @typedef {import("./detect.js").DomFacts} DomFacts
 * @typedef {import("./parked.js").Clock} Clock
 * @typedef {import("./parked.js").ParkEnd} ParkEnd
 * @typedef {import("./parked.js").Probe} Probe
 *
 * @typedef {object} Stop why a job ends without content
 * @property {Outcome} outcome
 * @property {string} code
 * @property {string} message
 * @property {boolean} retryable
 * @property {number | null} [retryAfterS] what the site asked for (Retry-After), where it did
 * @property {boolean} [silent] send no result: the link is gone and the daemon has failed the job already
 *
 * @typedef {object} Detected what stood in the way of a job's page
 * @property {string} kind
 * @property {string} evidence
 * @property {number} since when it was first seen
 * @property {number} waitedMs
 * @property {"cleared_by_waiting" | "cleared_by_operator" | null} resolved
 *
 * @typedef {object} Challenge a parked job, as the rest of the extension is told about it
 * @property {string} job
 * @property {string} host
 * @property {NonNullable<JobResultBody["detect"]>} detect
 *
 * @typedef {object} Settled what content/settle.js (or, for a hidden tab, content/quiet.js) reports
 * @property {boolean} settled
 * @property {"visible" | "hidden"} visibility hidden if any part of settling ran in a hidden tab
 * @property {number | null} rafHz null: no frames were measured
 * @property {number} scrolledPx how far down the page the settle script went
 * @property {import("../shared/protocol.js").ScrollResult} scroll
 * @property {number} walkMs how long the walk down the page took
 *
 * @typedef {NonNullable<JobResultBody["page"]>} PageInfo
 * @typedef {NonNullable<JobResultBody["extraction"]>} Extraction
 * @typedef {NonNullable<JobResultBody["content"]>["links"]} Links
 *
 * @typedef {NonNullable<JobResultBody["content"]>["results"]} Results
 *
 * @typedef {object} Collected what content/extract.js reports, cleaned up
 * @property {Results} [results] of a search: the results that were recognised, in the page's order
 * @property {string | null} url
 * @property {PageInfo} page
 * @property {Extraction} extraction
 * @property {string | null} markdown
 * @property {string | null} text
 * @property {string | null} html
 * @property {string | null} rawHtml
 * @property {Links} links
 * @property {boolean} markdownTruncated
 * @property {boolean} textTruncated
 * @property {boolean} htmlTruncated
 * @property {boolean} rawHtmlTruncated
 *
 * @typedef {object} NavTracker top-frame navigation events of one job tab
 * @property {number} startedAt last onBeforeNavigate
 * @property {number} committedAt last onCommitted: a document of the navigation is in the tab
 * @property {number} completedAt last onCompleted
 * @property {number} errorAt last onErrorOccurred
 * @property {string | null} error
 *
 * @typedef {object} Run
 * @property {string} id
 * @property {"fetch" | "probe" | "search"} kind
 * @property {{ limit: number, hint: number } | null} search of a search: how many results are wanted, and which of the
 *   content script's hints fits the engine (-1: none)
 * @property {string} url
 * @property {string} host
 * @property {"auto" | "isolated"} session isolated: the daemon asked for the gateway container whatever the rules say
 * @property {JobWait} wait
 * @property {JobExtract} extract
 * @property {number} startedAt
 * @property {number} deadline everything but collecting and closing must be over by then
 * @property {number | null} tabId
 * @property {number | null} windowId the window the job tab was opened in
 * @property {boolean} tabOpened
 * @property {"container" | "default" | null} scope the cookie store the job runs in, once it is chosen
 * @property {import("../shared/policy.js").OptInRule | null} rule the operator's rule a job in the default store must stay inside
 * @property {TabGuard | null} guard
 * @property {NavTracker} nav
 * @property {Stop | null} stop
 * @property {Promise<Stop>} stopped resolves when something ends the job from outside its own flow
 * @property {(stop: Stop) => void} interrupt
 * @property {boolean} done
 * @property {Settled | null} settled
 * @property {ReturnType<typeof setTimeout> | null} backstop
 * @property {Detected | null} detect
 * @property {import("./capture.js").FilePolicy | null} files what the job may bring back when its response is a file
 * @property {import("./capture.js").Capture | null} capture the top-level response is a file and is being read
 * @property {Promise<void>} fileSeen resolves when that began
 * @property {() => void} wakeFile
 * @property {import("../shared/protocol.js").DwellResult} dwell
 * @property {boolean} parked the job was parked at some point: it left the runner and has a life of its own
 * @property {number} parkedAt when, on the injected clock
 * @property {boolean} handedOff the operator was given the tab of the parked job
 * @property {import("../shared/protocol.js").JobTimings} times where the time of the job went, for its result
 * @property {(() => void) | null} unlisten removes the navigation listeners of a parked job
 * @property {boolean} moving the tab of the parked job is on its way into another window
 * @property {number} missing looks in a row at which the browser did not know the tab of the parked job
 *
 * @typedef {object} JobsTuning
 * @property {number} errorGraceMs how long a navigation error waits for a follow-up navigation before it counts
 * @property {number} pollMs
 * @property {number} hiddenQuietMs the one quiet check of a hidden tab, at most; the background page waits it out
 * @property {number} hiddenScriptMs longest one script of the hidden path may take
 * @property {boolean} forceHidden test builds only (dev config): every job tab is treated as hidden
 * @property {number} backstopMs past the job's own budget before it is given up locally
 * @property {number} releaseTimeoutMs
 * @property {number} extractTimeoutMs for each of the two extraction attempts
 * @property {number} downloadGraceMs how long a tab that shows no page waits for the downloads backstop to say why
 * @property {number} scrollSteps most steps of the walk down a page (wait.scroll "lazy")
 * @property {number} scrollMs longest that walk may take
 * @property {number} scrollGrowMs longest the walk may take on a page that keeps growing under it (a feed that loads more)
 * @property {number} scrollGrowSteps most steps of the walk on such a page
 * @property {number} scrollGrowMaxPx how far down such a page the walk goes at most
 * @property {readonly [number, number]} graceMs shortest and longest grace period of a challenge; each job gets a random one
 * @property {number} gracePollMs how often a challenge page is looked at during its grace period
 * @property {number} detectTimeoutMs for one run of the detection script
 * @property {number} finishMs how long reading a page may take once its challenge was cleared by the operator
 * @property {number} handoffCapMs longest the quiet check may take for a page the operator has just cleared
 * @property {number} loadPatienceMs how long a parked tab may go on loading, its document already there, before it is looked at anyway
 * @property {number} blobBacklogBytes a file is sent no faster than the link takes it: no further piece while more than this waits
 * @property {number} blobStallMs how long the link may take nothing before sending a file is given up
 * @property {number} blobSendMs how long sending a file may take in all; the daemon grants a job the same on top of its run
 * @property {number} workersMs how long taking away the service workers of a job's page may hold up the closing of its tab
 * @property {readonly number[]} recloseMs for a job tab the browser did not close: how long to wait before each further try
 *
 * @typedef {object} JobsDeps
 * @property {(msg: Record<string, unknown>) => boolean} send
 * @property {() => number} [backlog] bytes the link has taken and not sent yet; absent: never any
 * @property {() => number} maxResultBytes
 * @property {() => boolean} isPaused
 * @property {{ ensure: () => Promise<string> }} container
 * @property {import("./window.js").WindowStrategy} window
 * @property {import("./guard.js").Guard} guard
 * @property {import("./guard.js").PolicyOptions} policy
 * @property {{ match: (url: string) => import("../shared/policy.js").OptInRule | null, admit: (rule: import("../shared/policy.js").OptInRule) => number }} optin
 *   the operator's login rules: which rule a URL lies in, and whether that rule may be used once more right now
 *   (0, or the seconds to wait)
 * @property {import("../shared/policy.js").OptInOptions} optinPolicy how those rules are read
 * @property {Pick<typeof browser.tabs, "executeScript" | "get">} tabs
 * @property {Pick<typeof browser.webNavigation, "onBeforeNavigate" | "onCompleted" | "onErrorOccurred"> &
 *   Partial<Pick<typeof browser.webNavigation, "onCommitted" | "onHistoryStateUpdated" | "onReferenceFragmentUpdated">>} webNavigation
 * @property {(event: string, fields?: Record<string, string | number | boolean | null>) => void} log
 * @property {() => void} onActivity the running job or the list of parked jobs changed
 * @property {(what: "pending" | "acked" | "cleared" | "ended", challenge: Challenge) => void} [onChallenge] a job was parked,
 *   its tab was handed to the operator, its challenge was seen gone (the page is read next), or it ended
 * @property {Clock} [clock] for the waits that are about pacing and patience (dwell, grace, parked jobs), so that
 *   tests need not sit through them. Default: the real one
 * @property {() => number} [rng] uniform in [0, 1), for the length of a grace period
 * @property {Partial<JobsTuning>} [tuning]
 * @property {Partial<import("./parked.js").ParkedTuning>} [parkTuning]
 */

/** @type {JobsTuning} */
const DEFAULT_TUNING = Object.freeze({
	errorGraceMs: 700,
	pollMs: 50,
	hiddenQuietMs: 1200,
	hiddenScriptMs: 5000,
	forceHidden: false,
	backstopMs: 4000,
	releaseTimeoutMs: 6000,
	extractTimeoutMs: 20000,
	downloadGraceMs: 500,
	scrollSteps: 24,
	scrollMs: 6000,
	scrollGrowMs: 20000,
	scrollGrowSteps: 120,
	scrollGrowMaxPx: 60000,
	graceMs: Object.freeze(/** @type {[number, number]} */ ([5000, 20000])),
	gracePollMs: 1000,
	detectTimeoutMs: 5000,
	finishMs: 45000,
	handoffCapMs: 3000,
	loadPatienceMs: 3000,
	blobBacklogBytes: 2097152,
	blobStallMs: 15000,
	blobSendMs: 20000,
	workersMs: 1000,
	recloseMs: Object.freeze([3000, 30000]),
});

/** @type {Clock} */
const REAL_CLOCK = Object.freeze({
	now: () => Date.now(),
	setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms),
	clearTimeout: (/** @type {unknown} */ handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
});

/** @type {Stop} */
const TAB_CLOSED = Object.freeze({ outcome: "error", code: "tab_closed", message: "the job tab was closed before the job finished", retryable: true });

/**
 * Not an end: what a step of the page flow is answered with when the response turned out to be a file. It is
 * never stored as the stop of a run and never sent; whoever gets it goes on to receive the file.
 * @type {Stop}
 */
const FILE_ARRIVED = Object.freeze({ outcome: "ok", code: "file", message: "the response is a file", retryable: false });

/** What a login page means on a site that was loaded with the operator's own session. */
const LOGGED_OUT = "the site sent the browser to a login page although the page was loaded with the operator's login: the operator is logged out of this site and has to log in to it in their browser";

/** Why a challenge is reported at once, with its tab closed, instead of being kept for the operator. */
const NOT_PARKED = Object.freeze({
	challenge_unattended: "the page shows a human check and the job does not wait for the operator",
	challenge_pending: "a human check of this site is already waiting for the operator",
	too_many_pending: "the page shows a human check, and too many others are already waiting for the operator",
});

// Share of a result frame that the link list may take. The Markdown comes
// next, then the visible text, and the document last.
const LINKS_SHARE = 0.25;
// Fewer results than this is no list: the page's text and links go along.
const MIN_RESULTS = 3;
/** The engines content/search.js has hints for, in its order: the place in this list is all it is told. */
export const SEARCH_HINTS = Object.freeze(["duckduckgo", "brave", "bing", "google", "startpage"]);
const VIEWS = /** @type {const} */ (["article", "full_page", "text"]);

// How much longer than its own limits the visible settle script may run before the background page gives up on it.
const SETTLE_SLACK = 3;

const BLANK = "about:blank";
const encoder = new TextEncoder();

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} text @returns {number} bytes of the text as a JSON string in UTF-8 */
function jsonBytes(text) {
	return encoder.encode(JSON.stringify(text)).length;
}

/**
 * The longest prefix of a string whose JSON encoding fits into a byte budget.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean }}
 */
export function fitJsonString(text, maxBytes) {
	// Worst case is six bytes per code unit (\u0000) plus the quotes.
	if (text.length * 6 + 2 <= maxBytes || jsonBytes(text) <= maxBytes) return { text, truncated: false };
	// Never cut a surrogate pair in half: a prefix that would is taken one unit
	// shorter. That also keeps the size growing with the length, which the
	// search below relies on (a lone half costs more bytes than the pair).
	/** @param {number} n */
	const prefix = (n) => {
		const last = n > 0 ? text.charCodeAt(n - 1) : 0;
		return text.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
	};
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (jsonBytes(prefix(mid)) <= maxBytes) lo = mid;
		else hi = mid - 1;
	}
	return { text: prefix(lo), truncated: true };
}

/**
 * The leading links whose JSON encoding fits into a byte budget. Whole entries only.
 * @param {Links} links
 * @param {number} maxBytes for the array, brackets and commas included
 * @returns {Links}
 */
export function fitLinks(links, maxBytes) {
	let used = 2;
	let count = 0;
	for (const link of links) {
		used += encoder.encode(JSON.stringify(link)).length + (count === 0 ? 0 : 1);
		if (used > maxBytes) break;
		count += 1;
	}
	return count === links.length ? links : links.slice(0, count);
}

/**
 * @param {unknown} v
 * @param {number} max
 * @returns {string | null} null for anything that is not a non-empty string
 */
function str(v, max) {
	return typeof v === "string" && v !== "" ? v.slice(0, max) : null;
}

/**
 * What the extractor handed over, cut to what the protocol allows. The
 * extractor runs next to an untrusted page: nothing of its answer is taken on
 * trust, whatever the type.
 * @param {Record<string, unknown>} r
 * @returns {Collected}
 */
export function cleanExtracted(r) {
	/** @param {unknown} v @returns {Record<string, unknown>} */
	const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {});
	const page = obj(r.page);
	const content = obj(r.content);
	const truncated = obj(r.truncated);
	const extraction = obj(r.extraction);
	const words = page.word_count;
	const view = VIEWS.find((v) => v === extraction.view);
	const coverage = extraction.coverage_pct;
	const removed = extraction.hidden_removed;
	/** @type {Links} */
	const links = [];
	for (const item of Array.isArray(content.links) ? content.links : []) {
		if (links.length >= LIMITS.MAX_LINKS) break;
		const link = obj(item);
		if (typeof link.url !== "string" || link.url.length > LIMITS.MAX_FINAL_URL || !isWebUrl(link.url)) continue;
		links.push({ url: link.url, text: typeof link.text === "string" ? link.text.slice(0, 500) : "" });
	}
	return {
		url: typeof r.url === "string" ? r.url.slice(0, LIMITS.MAX_FINAL_URL) : null,
		page: {
			title: str(page.title, 1000),
			author: str(page.author, 500),
			published: str(page.published, 100),
			lang: str(page.lang, 35),
			site: str(page.site, 300),
			word_count: typeof words === "number" && Number.isSafeInteger(words) ? Math.min(Math.max(words, 0), 100000000) : 0,
			extractor: str(page.extractor, 100),
		},
		extraction: {
			// An answer that does not say is taken for the plainest view there is.
			view: view ?? "text",
			coverage_pct: typeof coverage === "number" && Number.isFinite(coverage) ? Math.min(Math.max(Math.round(coverage), 0), 100) : null,
			hidden_removed: typeof removed === "number" && Number.isSafeInteger(removed) ? Math.min(Math.max(removed, 0), LIMITS.MAX_HIDDEN_REMOVED) : 0,
			capped: extraction.capped === true,
		},
		markdown: typeof content.markdown === "string" ? content.markdown : null,
		text: typeof content.text === "string" ? content.text : null,
		html: typeof content.html === "string" ? content.html : null,
		rawHtml: typeof content.raw_html === "string" ? content.raw_html.slice(0, LIMITS.MAX_RAW_HTML_CHARS) : null,
		links,
		markdownTruncated: truncated.markdown === true,
		textTruncated: truncated.text === true,
		htmlTruncated: truncated.html === true,
		rawHtmlTruncated: truncated.raw_html === true || (typeof content.raw_html === "string" && content.raw_html.length > LIMITS.MAX_RAW_HTML_CHARS),
	};
}

/**
 * What the search script handed over, cut to what the protocol allows. Like
 * the extractor it runs next to an untrusted page: every result is checked
 * here again - a web address, a title, numbered in the order they came.
 * @param {Record<string, unknown>} r
 * @param {number} limit
 * @returns {{ results: Results, detector: "hint" | "generic", hiddenRemoved: number, capped: boolean, title: string | null, url: string | null }}
 */
export function cleanSearch(r, limit) {
	/** @type {Results} */
	const results = [];
	/** @type {Set<string>} */
	const seen = new Set();
	const max = Math.min(Math.max(Math.floor(limit) || 1, 1), LIMITS.MAX_RESULTS);
	/** @param {unknown} v @param {number} cap */
	const oneLine = (v, cap) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim().slice(0, cap) : "");
	for (const item of Array.isArray(r.results) ? r.results : []) {
		if (results.length >= max) break;
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const { title, url, snippet } = /** @type {Record<string, unknown>} */ (item);
		if (typeof url !== "string" || url.length > LIMITS.MAX_URL || !isWebUrl(url) || seen.has(url)) continue;
		const name = oneLine(title, LIMITS.MAX_RESULT_TITLE);
		if (name === "") continue;
		seen.add(url);
		results.push({ rank: results.length + 1, title: name, url, snippet: oneLine(snippet, LIMITS.MAX_RESULT_SNIPPET) });
	}
	const removed = r.hidden_removed;
	return {
		results,
		detector: r.detector === "hint" ? "hint" : "generic",
		hiddenRemoved: typeof removed === "number" && Number.isSafeInteger(removed) ? Math.min(Math.max(removed, 0), LIMITS.MAX_HIDDEN_REMOVED) : 0,
		capped: r.capped === true,
		title: str(r.title, 1000),
		url: typeof r.url === "string" ? r.url.slice(0, LIMITS.MAX_FINAL_URL) : null,
	};
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, what) {
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let timer;
	/** @type {Promise<never>} */
	const guard = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
	});
	return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** @param {unknown} url */
function isWebUrl(url) {
	return typeof url === "string" && /^https?:\/\//i.test(url);
}

/**
 * The end of a job whose page is a refusal or a wall.
 * @param {Detection} detection
 * @returns {Stop}
 */
function blockedStop(detection) {
	return {
		outcome: "blocked",
		code: detection.kind,
		message: KIND_MESSAGE[/** @type {keyof typeof KIND_MESSAGE} */ (detection.kind)] ?? "the site blocked the request",
		// A rate limit passes; a refusal or a wall does not go away by asking again.
		retryable: detection.kind === KIND.HTTP_429,
		retryAfterS: detection.retryAfterS,
	};
}

/**
 * Where a page stood that did not finish loading in time, on one line: the message of a navigation_timeout
 * result, which the daemon hands on as the "detail" of the failure. It is made of fixed words and numbers only -
 * no address, no host name, nothing of the page - and is never longer than 200 characters, which is what the
 * daemon prints of a detail. Times are milliseconds ago, -1 for "never"; y and n are yes and no.
 *
 *   stalled try=0 tab=loading nav=60012/59800/-1/-1 top=passed/2/1/59990 owed=0/n/-1 dns=41/0/7/0/0/0/38 cut=12:dns*9,private*3 file=n dl=n
 *
 *   try   0, or 1 after the one retry of a navigation that failed
 *   tab   what the browser calls the tab: loading, complete or unknown
 *   nav   when the navigation that is waited for began / when a document was last committed / when a load was
 *         last told complete / when a navigation last failed
 *   top   what the last top-frame request came to (none, asked, passed, failed) / top-frame requests in all /
 *         those of them after the first document was committed / when the last was heard
 *   owed  requests that wait for an answer of the request guard / a top-frame request among them / how long the
 *         oldest has waited
 *   dns   lookups / under way right now / requests that shared a lookup / failed / private address / not
 *         answered before the deadline / the slowest, in milliseconds
 *   cut   requests of the tab the guard cancelled, and the three most frequent reasons (guard.js, CutWord)
 *   file  a top-frame response was read or refused as a file;  dl  a download was caught
 *
 * Everything from "top" on is the guard's and is left out where no guard says it.
 * @param {{ attempt: number, tab_status: string, started_ms: number, committed_ms: number, completed_ms: number, error_ms: number }} where
 * @param {Partial<import("./guard.js").StallFacts>} facts
 * @returns {string}
 */
export function stallLine(where, facts) {
	/** @param {unknown} v @param {number} max @returns {string} a whole number from -1 to max */
	const num = (v, max) => String(typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), -1), max) : -1);
	const ms = (/** @type {unknown} */ v) => num(v, 999999);
	const count = (/** @type {unknown} */ v) => num(v, 9999);
	const yes = (/** @type {unknown} */ v) => (v === true ? "y" : "n");
	const word = (/** @type {unknown} */ v, /** @type {readonly string[]} */ of) => (typeof v === "string" && of.includes(v) ? v : "unknown");
	const parts = [`stalled try=${num(where.attempt, 9)}`, `tab=${word(where.tab_status, ["loading", "complete"])}`, `nav=${ms(where.started_ms)}/${ms(where.committed_ms)}/${ms(where.completed_ms)}/${ms(where.error_ms)}`];
	if (typeof facts.top_load === "string") {
		// Reasons are the guard's fixed words; anything else in their place is left out.
		const most = String(facts.cancelled_most ?? "")
			.split(",")
			.map((part) => /^([a-z]{1,8})\*([0-9]{1,9})$/.exec(part))
			.flatMap((m) => (m === null ? [] : [`${m[1]}*${num(Number(m[2]), 999)}`]))
			.slice(0, 3);
		parts.push(
			`top=${word(facts.top_load, ["none", "asked", "passed", "failed"])}/${num(facts.top_requests, 999)}/${num(facts.top_after_commit, 999)}/${ms(facts.top_asked_ms)}`,
			`owed=${count(facts.answers_owed)}/${yes(facts.top_answer_owed)}/${ms(facts.answer_oldest_ms)}`,
			`dns=${count(facts.lookups)}/${count(facts.lookups_under_way)}/${count(facts.lookups_shared)}/${count(facts.lookups_failed)}/${count(facts.lookups_refused)}/${count(facts.lookups_deadline)}/${ms(facts.lookup_slowest_ms)}`,
			`cut=${count(facts.cancelled)}${most.length === 0 ? "" : `:${most.join(",")}`}`,
			`file=${yes(facts.file_tried)}`,
			`dl=${yes(facts.download)}`,
		);
	}
	return parts.join(" ").slice(0, 200);
}

export class Jobs {
	#d;
	/** @type {JobsTuning} */
	#tuning;
	/** @type {Clock} */
	#clock;
	#rng;
	/** @type {Run | null} */
	#current = null;
	/** @type {Parked} the challenge tabs that wait for the operator */
	#parked;
	/** @type {Map<string, Run>} every job that was parked and has not sent its result yet, by job id */
	#parkedRuns = new Map();
	/** @type {{ windowId: number | null, at: number } | null} the last job that lost its tab, until the next job starts */
	#lostTab = null;
	/** Tabs of jobs that ended while their tab was still being made, or that the browser did not close, and that are still being closed. */
	#straggling = 0;
	/** Jobs that have given up their place and whose result is being handed over at this very moment. */
	#reporting = 0;

	/** @param {JobsDeps} deps */
	constructor(deps) {
		this.#d = deps;
		this.#tuning = { ...DEFAULT_TUNING, ...deps.tuning };
		this.#clock = deps.clock ?? REAL_CLOCK;
		this.#rng = deps.rng ?? Math.random;
		this.#parked = new Parked({
			clock: this.#clock,
			probe: (entry) => this.#probeParked(entry.job),
			onEnd: (entry, end) => {
				const run = this.#parkedRuns.get(entry.job);
				if (run === undefined) return;
				this.#finishParked(run, end).catch((err) => {
					this.#d.log("job.crashed", { message: errorText(err) });
				});
			},
			onChange: () => this.#d.onActivity(),
			tuning: deps.parkTuning,
		});
	}

	/** @returns {{ job: string, host: string, scope: "container" | "default" | null } | null} the running job, for the toolbar popup */
	current() {
		const run = this.#current;
		return run === null ? null : { job: run.id, host: run.host, scope: run.scope };
	}

	/** @returns {ReturnType<Parked["list"]>} the challenges that wait for the operator, oldest first */
	pending() {
		return this.#parked.list();
	}

	/**
	 * Is any job alive? That is more than current() and pending() show between them: a job whose human check was
	 * just cleared is neither running nor waiting, and its tab is open until its page was read, its file was sent
	 * and its result is out.
	 * @returns {boolean} true from the start of a job to its result, and for as long as a tab of one is still open
	 */
	busy() {
		return this.#live().length > 0 || this.#straggling > 0 || this.#reporting > 0;
	}

	/**
	 * Bring the tab of a parked job to the operator: into a new window of its
	 * own. Only ever called because the operator asked - by
	 * the daemon's notification, the toolbar popup or the extension's own
	 * notification.
	 * @param {string} job
	 * @returns {Promise<boolean>} false when no such job waits, or the window could not be made
	 */
	async handoff(job) {
		const entry = this.#parked.get(job);
		const run = this.#parkedRuns.get(job);
		if (entry === null || run === undefined || run.tabId === null) return false;
		// While the tab changes windows the browser may not know it for a moment: it is not looked at meanwhile.
		run.moving = true;
		try {
			run.windowId = await this.#d.window.popOut(run.tabId);
		} catch (err) {
			this.#d.log("job.handoff_failed", { job, message: errorText(err) });
			return false;
		} finally {
			run.moving = false;
		}
		this.#d.log("job.handed_off", { job });
		// The operator has the tab: that is the acknowledgement, once.
		if (this.#parked.markHandedOff(job)) {
			run.handedOff = true;
			run.times.handoff_ms = this.#clock.now() - run.parkedAt;
			this.#d.onChallenge?.("acked", this.#challenge(run));
		}
		return true;
	}

	/**
	 * The daemon owns the deadline and cancels in time. This only fires if it does not.
	 * @param {Run} run
	 */
	#armBackstop(run) {
		if (run.backstop !== null) clearTimeout(run.backstop);
		run.backstop = setTimeout(
			() => run.interrupt({ outcome: "timeout", code: "deadline", message: "the job did not finish in time", retryable: true }),
			Math.max(0, run.deadline - Date.now()) + this.#tuning.backstopMs,
		);
	}

	/** @param {number} ms @returns {Promise<void>} a wait on the injected clock */
	#pause(ms) {
		return new Promise((resolve) => this.#clock.setTimeout(() => resolve(), ms));
	}

	/**
	 * A validated job.start frame arrived.
	 * @param {Record<string, unknown>} msg
	 */
	start(msg) {
		const job = String(msg.job);
		const url = typeof msg.url === "string" ? msg.url : BLANK;
		if (msg.kind !== "fetch" && msg.kind !== "probe" && msg.kind !== "search") {
			return this.#refuse(job, url, "unsupported", "kind_not_supported", "this extension version cannot run that kind of job", false);
		}
		if (this.#current !== null) {
			return this.#refuse(job, url, "error", "busy", "another job is still running", true);
		}
		if (this.#d.isPaused()) {
			return this.#refuse(job, url, "error", "paused", "the operator paused the gateway", false);
		}
		// A site that shows a challenge is not asked again while that challenge
		// waits for the operator. The daemon does not send such a job; should
		// one arrive all the same, no tab is opened for it.
		const asked = checkUrl(url, this.#d.policy);
		const waiting = asked.allowed ? this.#parked.pendingFor(siteOf(asked.host)) : null;
		if (waiting !== null) {
			return this.#refuse(job, url, "needs_human", "challenge_pending", NOT_PARKED.challenge_pending, true, {
				kind: waiting.kind,
				evidence: "",
				waited_ms: Math.min(Math.max(this.#clock.now() - waiting.since, 0), LIMITS.MAX_TIMEOUT_MS),
				resolved: null,
			});
		}
		const wait = /** @type {JobWait} */ (msg.wait);
		const startedAt = Date.now();
		/** @type {(stop: Stop) => void} */
		let wake = () => {};
		/** @type {Promise<Stop>} */
		const stopped = new Promise((resolve) => {
			wake = resolve;
		});
		/** @type {() => void} */
		let wakeFile = () => {};
		/** @type {Promise<void>} */
		const fileSeen = new Promise((resolve) => {
			wakeFile = resolve;
		});
		/** @type {Run} */
		const run = {
			id: job,
			kind: msg.kind,
			search:
				msg.kind === "search"
					? { limit: typeof msg.limit === "number" && Number.isInteger(msg.limit) ? Math.min(Math.max(msg.limit, 1), LIMITS.MAX_RESULTS) : 10, hint: SEARCH_HINTS.indexOf(String(msg.engine)) }
					: null,
			url,
			host: "",
			// Anything but a plain "auto" means the container.
			session: msg.session === "auto" ? "auto" : "isolated",
			wait,
			extract: /** @type {JobExtract} */ (msg.extract),
			startedAt,
			// The time a job may hold the runner. A challenge adds its grace period
			// (see #grace); waiting for the operator (human_wait_ms) happens parked,
			// outside of it.
			deadline: startedAt + wait.timeout_ms + wait.settle_ms + wait.dwell_ms,
			tabId: null,
			windowId: null,
			tabOpened: false,
			scope: null,
			rule: null,
			guard: null,
			nav: { startedAt: 0, committedAt: 0, completedAt: 0, errorAt: 0, error: null },
			stop: null,
			stopped,
			interrupt: (stop) => {
				if (run.stop !== null || run.done) return;
				run.stop = stop;
				wake(stop);
				// A parked job has no flow of its own that could notice: end its watch.
				this.#parked.stop(run.id, stop);
			},
			done: false,
			settled: null,
			dwell: "off",
			backstop: null,
			detect: null,
			// A fetch only: a search reads a results page, a probe wants facts.
			files: msg.kind === "fetch" && typeof msg.files === "object" && msg.files !== null ? { maxBytes: Number(/** @type {{ max_bytes: unknown }} */ (msg.files).max_bytes), types: [.../** @type {{ types: string[] }} */ (msg.files).types] } : null,
			capture: null,
			fileSeen,
			wakeFile,
			parked: false,
			parkedAt: 0,
			handedOff: false,
			times: zeroTimings(),
			unlisten: null,
			moving: false,
			missing: 0,
		};
		this.#armBackstop(run);
		this.#current = run;
		this.#lostTab = null;
		this.#d.onActivity();
		this.#execute(run).catch((err) => {
			this.#d.log("job.crashed", { message: errorText(err) });
		});
	}

	/**
	 * job.cancel from the daemon.
	 * @param {string} job
	 * @param {string} reason deadline | client_gone | shutdown
	 */
	cancel(job, reason) {
		const run = this.#current !== null && this.#current.id === job ? this.#current : (this.#parkedRuns.get(job) ?? null);
		if (run === null) return;
		run.interrupt(
			reason === "deadline"
				? { outcome: "timeout", code: "deadline", message: "the daemon's deadline for the job passed", retryable: true }
				: { outcome: "aborted", code: reason, message: "the daemon cancelled the job", retryable: true },
		);
	}

	/**
	 * Stop whatever is running.
	 * @param {"link_down" | "link_reset" | "paused"} why
	 */
	abortAll(why) {
		// Parked jobs too: they survive neither a pause nor the loss of the link.
		for (const run of this.#live()) {
			if (why === "paused") {
				run.interrupt({ outcome: "aborted", code: "paused", message: "the operator paused the gateway", retryable: false });
			} else {
				run.interrupt({ outcome: "aborted", code: why, message: "the link to the daemon was lost", retryable: true, silent: true });
			}
		}
	}

	/** @returns {Run[]} the running job and every parked one that has not ended */
	#live() {
		const runs = [...this.#parkedRuns.values()];
		if (this.#current !== null) runs.unshift(this.#current);
		return runs;
	}

	/**
	 * The downloads backstop caught a download of a job. With one job at a
	 * time, a download while a job tab is open is that job's. The job ends, and
	 * its tab is closed here and now: a page that starts one download may be
	 * starting a hundred.
	 * @returns {boolean} true when a running job was ended for it
	 */
	downloadStarted() {
		return this.#endForDownload({ outcome: "unsupported", code: "download", message: "the page started a download instead of showing content", retryable: false });
	}

	/**
	 * A download started that may be the job's or the operator's own (they have
	 * the same site open). It was not touched; the job ends all the same.
	 * @returns {boolean} true when a running job was ended for it
	 */
	downloadAmbiguous() {
		return this.#endForDownload({ outcome: "error", code: "download_ambiguous", message: "a download started that may be the page's or the operator's own; it was left alone", retryable: false });
	}

	/** @param {Stop} stop @returns {boolean} */
	#endForDownload(stop) {
		let ended = false;
		// Which tab of the container started it cannot be told: every job tab
		// that is open goes, the parked ones included.
		for (const run of this.#live()) {
			if (run.tabId === null || run.done) continue;
			ended = true;
			if (run.stop !== null) continue;
			run.interrupt(stop);
			// Nothing more leaves the tab, and it goes at once. The ordinary end of
			// the job finds it closed already.
			run.guard?.seal();
			this.#d.window.release(run.tabId).catch(() => {});
		}
		return ended;
	}

	/**
	 * A job tab was closed by someone else.
	 * @param {number} tabId
	 * @returns {boolean} true when a running job lost its tab
	 */
	tabLost(tabId) {
		const run = this.#live().find((r) => r.tabId === tabId) ?? null;
		if (run === null || run.done) return false;
		this.#lostTab = { windowId: run.windowId, at: Date.now() };
		run.interrupt(TAB_CLOSED);
		return true;
	}

	/**
	 * A window was closed by someone else.
	 * @param {number} windowId
	 * @returns {boolean} true when a job was running in a tab of that window
	 */
	windowClosed(windowId) {
		// The tab event usually comes first and may already have ended the job.
		const lost = this.#lostTab;
		this.#lostTab = null;
		if (lost !== null && lost.windowId === windowId && Date.now() - lost.at < 5000) return true;
		let lostAny = false;
		for (const run of this.#live()) {
			if (run.windowId !== windowId || run.done) continue;
			if (run.tabId !== null) this.tabLost(run.tabId);
			lostAny = true;
		}
		this.#lostTab = null;
		return lostAny;
	}

	/**
	 * A job that never starts still gets its one result.
	 * @param {string} job
	 * @param {string} url
	 * @param {Outcome} outcome
	 * @param {string} code
	 * @param {string} message
	 * @param {boolean} retryable
	 * @param {JobResultBody["detect"]} [detect]
	 */
	#refuse(job, url, outcome, code, message, retryable, detect = null) {
		this.#d.log("job.refused", { job, code });
		this.#sendResult({
			job,
			outcome,
			cookie_scope: null,
			nav: { requested_url: url === "" ? BLANK : url, final_url: null, redirect_origins: [], http_status: null, content_type: null, body_bytes: null },
			render: { visibility: null, raf_hz: null, settled: false, scrolled_px: 0, scroll: "off", dwell: "off", elapsed_ms: 0, timings: zeroTimings() },
			detect,
			error: { code, message, retryable, retry_after_s: null },
			page: null,
			extraction: null,
			content: null,
			truncated: { markdown: false, text: false, html: false, raw_html: false },
			file: null,
			tab_kept_open: false,
		});
	}

	/**
	 * @param {Run} run
	 * @param {"navigating" | "settling" | "challenge_wait" | "extracting" | "receiving_file"} phase
	 */
	#progress(run, phase) {
		this.#d.send(makeMessage(MSG.JOB_PROGRESS, { job: run.id, phase, http_status: run.guard?.nav.httpStatus ?? null }));
	}

	/**
	 * Wait for a step unless the job is stopped first.
	 * @template T
	 * @param {Run} run
	 * @param {Promise<T>} step
	 * @returns {Promise<{ value: T } | { stop: Stop }>}
	 */
	async #step(run, step) {
		if (run.stop !== null || run.capture !== null) {
			step.catch(() => {});
			return { stop: run.stop ?? FILE_ARRIVED };
		}
		/** @type {{ value: T } | { stop: Stop }} */
		const first = await Promise.race([step.then((value) => ({ value })), run.stopped.then((stop) => ({ stop })), run.fileSeen.then(() => ({ stop: FILE_ARRIVED }))]);
		if ("stop" in first) step.catch(() => {});
		return first;
	}

	/**
	 * The response of the job tab is a file: wait until it was read to its end, for as long as the job has left.
	 * @param {Run} run
	 * @param {import("./capture.js").Capture} capture
	 * @returns {Promise<{ file: { size: number, sha256: string } } | { stop: Stop }>}
	 */
	async #receiveFile(run, capture) {
		this.#progress(run, "receiving_file");
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let timer;
		/** @type {Promise<"timeout">} */
		const late = new Promise((resolve) => {
			timer = setTimeout(() => resolve("timeout"), Math.max(0, run.deadline - Date.now()));
		});
		const first = await Promise.race([capture.done, run.stopped.then(() => /** @type {const} */ ("stopped")), late]);
		clearTimeout(timer);
		// What the page flow did not count: the whole of it was the response arriving.
		if (run.times.nav_ms === 0) run.times.nav_ms = Math.max(0, Date.now() - run.startedAt - run.times.prep_ms);
		if (first === "stopped") return { stop: run.stop ?? TAB_CLOSED };
		if (first === "timeout") {
			/** @type {Stop} */
			const stop = { outcome: "timeout", code: "file_timeout", message: "the file did not arrive in time", retryable: true };
			capture.abort(stop);
			return { stop };
		}
		if (!first.ok) return { stop: first.stop };
		this.#d.log("job.file_received", { job: run.id, bytes: first.size });
		return { file: { size: first.size, sha256: first.sha256 } };
	}

	/**
	 * Send the bytes of a file ahead of its result, piece by piece. Between two pieces other frames get their
	 * turn (a ping is answered, a cancel is heard), and no piece is handed over while the link still holds
	 * much of the last ones.
	 * @param {Run} run
	 * @param {import("./capture.js").Capture} capture
	 * @returns {Promise<number | null>} how many frames it took; null when the job was ended meanwhile or the link took no more
	 */
	async #sendFile(run, capture) {
		let seq = 0;
		let offset = 0;
		for (const piece of capture.pieces()) {
			const waitUntil = Math.min(Date.now() + this.#tuning.blobStallMs, run.deadline);
			while ((this.#d.backlog?.() ?? 0) > this.#tuning.blobBacklogBytes) {
				if (run.stop !== null || Date.now() > waitUntil) return null;
				await sleep(5);
			}
			if (run.stop !== null) return null;
			if (!this.#d.send(makeMessage(MSG.JOB_BLOB, { job: run.id, seq, offset, data: toBase64(piece) }))) return null;
			seq += 1;
			offset += piece.length;
			await sleep(0);
		}
		return run.stop === null ? seq : null;
	}

	/** @param {Run} run */
	async #execute(run) {
		/** @type {Stop | null} */
		let stop = null;
		/** @type {Collected | null} */
		let collected = null;
		/** @type {Detection | null} */
		let park = null;
		try {
			const result = await this.#drive(run);
			if ("stop" in result) stop = result.stop;
			else if ("park" in result) park = result.park;
			else collected = result.collected;
		} catch (err) {
			this.#d.log("job.failed", { job: run.id, message: errorText(err) });
			stop = { outcome: "error", code: "internal_error", message: "the extension failed while running the job", retryable: false };
		}
		// Something that ended the job from outside wins over a late success.
		if (run.stop !== null) {
			stop = run.stop;
			park = null;
		}
		/** @type {{ size: number, sha256: string } | null} */
		let file = null;
		if (run.stop === null && run.capture !== null) {
			// The response is a file: whatever the page flow made of the tab meanwhile does not count.
			park = null;
			collected = null;
			const got = await this.#receiveFile(run, run.capture);
			if ("stop" in got) stop = got.stop;
			else {
				stop = null;
				file = got.file;
				// A challenge that stood before the file is gone, and nobody was asked.
				if (run.detect !== null) {
					run.detect.waitedMs = this.#clock.now() - run.detect.since;
					run.detect.resolved = RESOLVED.WAITING;
				}
			}
		} else if (stop === FILE_ARRIVED) {
			stop = run.stop ?? TAB_CLOSED;
		}
		if (file !== null) return this.#conclude(run, null, null, file);
		if (park !== null) {
			const refusal = this.#parked.refusal(siteOf(run.host), run.wait.human_wait_ms);
			if (refusal === null && run.tabId !== null) return this.#park(run, run.tabId, park);
			// Not kept: reported at once, and the tab goes like any other.
			stop = { outcome: "needs_human", code: refusal ?? "challenge_unattended", message: NOT_PARKED[refusal ?? "challenge_unattended"], retryable: true };
		}
		await this.#conclude(run, stop, collected);
	}

	/**
	 * The end of every job that was started: close the tab, then report. The bytes of a file go out in between.
	 * @param {Run} run
	 * @param {Stop | null} stop
	 * @param {Collected | null} collected
	 * @param {{ size: number, sha256: string } | null} [file] the file the job's response was, read to its end
	 */
	async #conclude(run, stop, collected, file = null) {
		// A file that is not sent keeps the backstop from before: sending is part of the job.
		if (file === null && run.backstop !== null) clearTimeout(run.backstop);
		run.unlisten?.();
		run.unlisten = null;
		// Nothing more may leave the tab; then close it, then report.
		run.guard?.seal();
		if (run.tabId !== null) {
			await this.#removeWorkers(run, run.tabId);
			await withTimeout(this.#d.window.release(run.tabId), this.#tuning.releaseTimeoutMs, "release").catch((err) => {
				this.#d.log("job.release_failed", { job: run.id, message: errorText(err) });
			});
		}
		if (run.guard !== null && run.tabId !== null) {
			// A tab that is still open keeps its guard, whatever the closing said: the page in it is alive.
			if (await this.#tabThere(run.tabId)) this.#outlived(run, run.tabId, run.guard);
			// The tab is gone: only now is the filter of a file closed, so that no viewer was ever told its response had ended.
			else run.guard.detach();
		}
		const capture = run.capture;
		/** @type {{ size: number, sha256: string, chunks: number } | null} */
		let sent = null;
		if (file !== null && capture !== null && stop === null) {
			// The bytes get time of their own to go out, however much of the job's time the response took to arrive.
			run.deadline = Math.max(run.deadline, Date.now() + this.#tuning.blobSendMs);
			this.#armBackstop(run);
			const chunks = await this.#sendFile(run, capture);
			if (chunks === null) stop = run.stop ?? { outcome: "error", code: "file_transfer_failed", message: "the file could not be handed to the daemon", retryable: true };
			else sent = { ...file, chunks };
		}
		// Ended from outside while the bytes went out: that wins, as everywhere.
		if (run.stop !== null) {
			stop = run.stop;
			sent = null;
		}
		if (run.backstop !== null) clearTimeout(run.backstop);
		const bodyBytes = capture === null ? null : capture.seen;
		capture?.discard();
		run.done = true;
		// The runner is free for the next job before the result goes out; alive (busy) the job is until it is out.
		this.#reporting += 1;
		/** @type {boolean} */
		let wasParked;
		try {
			if (this.#current === run) this.#current = null;
			wasParked = this.#parkedRuns.delete(run.id);
			this.#d.log("job.done", { job: run.id, outcome: stop === null ? "ok" : stop.outcome, code: stop === null ? null : stop.code });
			if (stop === null || stop.silent !== true) this.#sendResult(this.#buildResult(run, stop, collected, sent === null || capture === null ? null : { ...sent, plan: capture.plan }, bodyBytes));
		} finally {
			this.#reporting -= 1;
		}
		if (wasParked) this.#d.onChallenge?.("ended", this.#challenge(run));
		this.#d.onActivity();
	}

	/**
	 * @param {number} tabId
	 * @returns {Promise<boolean>} false when the browser no longer knows the tab. A browser that does not answer has
	 *   not said that the tab is gone
	 */
	#tabThere(tabId) {
		const known = this.#d.tabs.get(tabId).then(
			() => true,
			() => false,
		);
		return withTimeout(known, this.#tuning.releaseTimeoutMs, "tab").catch(() => true);
	}

	/**
	 * The job is over and its tab is still open: the browser did not close it (the page asked whether to leave
	 * it - which it may once the operator worked with it - and the answer was to stay), or took too long. The
	 * tab stays under the guard of its job, sealed, until it is gone: nothing loads in it, and it is not taken
	 * for a tab of the operator's. Closing is tried again a few times; the result of the job does not wait for it.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {TabGuard} guard
	 */
	#outlived(run, tabId, guard) {
		guard.retire();
		this.#d.log("job.tab_outlived", { job: run.id });
		// Alive for the container's sake (busy): a tab of a job is open in it.
		this.#straggling += 1;
		const closing = (async () => {
			for (const waitMs of this.#tuning.recloseMs) {
				await sleep(waitMs);
				if (!(await this.#tabThere(tabId))) return true;
				await withTimeout(this.#d.window.release(tabId), this.#tuning.releaseTimeoutMs, "release").catch(() => {});
			}
			return !(await this.#tabThere(tabId));
		})();
		closing
			.then(
				(closed) => {
					// Seen gone: the guard lets go here as well, should the browser's word of it have come before the guard asked for it.
					if (closed) guard.detach();
					this.#d.log(closed ? "job.tab_closed_late" : "job.tab_left_open", { job: run.id });
				},
				() => {},
			)
			.finally(() => {
				this.#straggling -= 1;
				this.#d.onActivity();
			});
	}

	/**
	 * Take away the service workers the page of a job could have registered, while its tab is still there to ask:
	 * the registrations of the origin of each frame of the tab. Called with the tab sealed, so that nothing the
	 * page does now can register one again. A page that cannot be asked (a viewer, a tab that is gone, a script
	 * that never yields) keeps its workers; the guard's look at every commit is what stands against those.
	 * @param {Run} run
	 * @param {number} tabId
	 */
	async #removeWorkers(run, tabId) {
		// Nothing of a site was in the tab; a file was read without the tab getting a byte; or the store is the operator's.
		if (run.scope !== "container" || run.capture !== null || run.nav.committedAt === 0) return;
		/** @param {boolean} allFrames */
		const ask = (allFrames) => this.#d.tabs.executeScript(tabId, { file: "/content/workers.js", runAt: "document_start", ...(allFrames ? { allFrames: true } : { frameId: 0 }) });
		let found = 0;
		let removed = 0;
		try {
			// Every frame; if one of them cannot be asked, the page itself at least.
			const results = await withTimeout(ask(true).catch(() => ask(false)), this.#tuning.workersMs, "workers");
			for (const r of Array.isArray(results) ? results : []) {
				if (typeof r !== "object" || r === null) continue;
				const { found: f, removed: n } = /** @type {Record<string, unknown>} */ (r);
				if (typeof f === "number" && Number.isSafeInteger(f) && f > 0) found += Math.min(f, 1000);
				if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) removed += Math.min(n, 1000);
			}
		} catch {
			// not a page that can be asked, or it did not answer in time
			return;
		}
		// Counts only.
		if (found > 0) this.#d.log("job.workers_removed", { job: run.id, found, removed });
	}

	/**
	 * @param {Run} run a job that is or was parked
	 * @returns {Challenge}
	 */
	#challenge(run) {
		const d = run.detect;
		return {
			job: run.id,
			host: run.host,
			detect: {
				kind: d === null ? "unknown" : d.kind,
				evidence: d === null ? "" : d.evidence,
				waited_ms: d === null ? 0 : Math.min(Math.max(Math.round(d.waitedMs), 0), LIMITS.MAX_TIMEOUT_MS),
				resolved: d === null ? null : d.resolved,
			},
		};
	}

	/**
	 * Keep the tab of a challenge open for the operator and free the runner.
	 * The job is not over: its one result is sent when its watch ends.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {Detection} detection
	 */
	#park(run, tabId, detection) {
		if (run.backstop !== null) clearTimeout(run.backstop);
		run.backstop = null;
		run.parked = true;
		run.parkedAt = this.#clock.now();
		this.#parkedRuns.set(run.id, run);
		// The tab is still watched: a navigation that completes is a reason to look at once.
		run.unlisten = this.#trackNavigation(run, tabId, () => this.#parked.nudge(run.id));
		if (this.#current === run) this.#current = null;
		this.#parked.park({ job: run.id, host: run.host, site: siteOf(run.host), tabId, kind: detection.kind, parkMs: run.wait.human_wait_ms });
		this.#d.log("job.parked", { job: run.id, kind: detection.kind });
		this.#d.onChallenge?.("pending", this.#challenge(run));
		this.#d.onActivity();
	}

	/**
	 * What the tab of a parked job shows now. Read-only, like every look at a page.
	 * @param {string} job
	 * @returns {Promise<Probe>}
	 */
	async #probeParked(job) {
		const run = this.#parkedRuns.get(job);
		if (run === undefined || run.tabId === null) return { state: "gone" };
		if (run.moving) return { state: "loading" };
		const tab = await this.#d.tabs.get(run.tabId).catch(() => null);
		if (tab === null) {
			// A tab that was closed is reported by the browser (tabLost). One that
			// it merely does not answer for - it is changing windows - is still
			// there: only when it stays unknown is it taken for gone.
			run.missing += 1;
			return run.missing >= 3 && !run.moving ? { state: "gone" } : { state: "loading" };
		}
		run.missing = 0;
		// On its way somewhere: looked at when it has arrived.
		if (this.#stillLoading(run, tab.status)) return { state: "loading" };
		const seen = await this.#look(run, run.tabId);
		// The look itself lost the tab, or the tab went into another window under it: not an answer.
		if ("stop" in seen || run.moving) return { state: "loading" };
		const { detection, dom } = seen.value;
		if (detection === null) return { state: "clear", thin: dom === null || dom.textLen < DETECT_LIMITS.thinTextChars };
		if (detection.action === "blocked") return { state: "blocked", detection };
		return { state: "challenge" };
	}

	/**
	 * Is the tab of a parked job still on its way somewhere, so that a look at it would see a page in between?
	 *
	 * A tab counts as arrived when its load is complete. Two cases are not waited for beyond that: a navigation
	 * that ended in an error while the tab shows a complete document (nothing more will come of it), and a page
	 * whose document has been in the tab for a while but whose load does not end - one slow frame or tracker can
	 * hold the load event of a page for a minute that has long shown its content.
	 * @param {Run} run
	 * @param {string | undefined} status tabs.Tab.status
	 * @returns {boolean}
	 */
	#stillLoading(run, status) {
		const nav = run.nav;
		const complete = status === undefined || status === "complete";
		if (complete && nav.completedAt >= nav.startedAt) return false;
		if (complete && nav.error !== null && nav.errorAt >= nav.startedAt) return false;
		// The document is there (committed after the navigation began) and has been for long enough.
		if (nav.committedAt >= nav.startedAt && nav.committedAt > 0 && Date.now() - nav.committedAt >= this.#tuning.loadPatienceMs) return false;
		return true;
	}

	/**
	 * The watch over a parked job ended: read the page if it was cleared, and
	 * send the job's one result either way.
	 * @param {Run} run
	 * @param {ParkEnd} end
	 */
	async #finishParked(run, end) {
		/** @type {Stop | null} */
		let stop = null;
		/** @type {Collected | null} */
		let collected = null;
		/** @type {{ size: number, sha256: string } | null} */
		let file = null;
		const detect = run.detect;
		if (detect !== null) detect.waitedMs = this.#clock.now() - detect.since;
		run.times.parked_ms = this.#clock.now() - run.parkedAt;
		if (end.how === "cleared" && run.tabId !== null) {
			// The page that took the place of the challenge is read like any other. One the operator has just
			// cleared, in the window in front of them, is read at once: the quiet check with a short cap, no walk
			// down the page. One that cleared by itself in the gateway window settles like any page.
			run.deadline = Date.now() + this.#tuning.finishMs;
			// Parking took the job's backstop away, and nobody cancels a job for time while it is parked. The reading
			// that begins here is bounded like a job that runs: whatever the page does, it ends a moment after its
			// deadline (conclude clears the timer).
			this.#armBackstop(run);
			// Said before the page is read: reading takes a while, and nobody needs to be called for a check that is gone.
			this.#d.onChallenge?.("cleared", this.#challenge(run));
			// What came behind the check is a file: there is no page to settle or read.
			if (run.capture === null) {
				try {
					this.#progress(run, "settling");
					const clearedAt = Date.now();
					const settled = await this.#settle(run, run.tabId, run.handedOff);
					run.times.cleared_settle_ms = Date.now() - clearedAt;
					if ("stop" in settled) stop = settled.stop;
					else {
						run.settled = settled.value;
						run.times.scroll_ms += settled.value.walkMs;
						this.#progress(run, "extracting");
						const readAt = Date.now();
						const read = await this.#collect(run, run.tabId);
						run.times.extract_ms = Date.now() - readAt;
						if ("stop" in read) stop = read.stop;
						else collected = read.value;
					}
				} catch (err) {
					this.#d.log("job.failed", { job: run.id, message: errorText(err) });
					stop = { outcome: "error", code: "internal_error", message: "the extension failed while running the job", retryable: false };
				}
			}
			if (run.stop === null && run.capture !== null) {
				collected = null;
				const got = await this.#receiveFile(run, run.capture);
				if ("stop" in got) stop = got.stop;
				else {
					stop = null;
					file = got.file;
				}
			} else if (stop === FILE_ARRIVED) {
				stop = run.stop ?? TAB_CLOSED;
			}
			// Who cleared it is known only where the operator was given the tab; a page that was never opened for
			// them cleared by being waited for.
			if (stop === null && detect !== null) detect.resolved = run.handedOff ? RESOLVED.OPERATOR : RESOLVED.WAITING;
		} else if (end.how === "blocked") {
			if (detect !== null) {
				detect.kind = end.detection.kind;
				detect.evidence = end.detection.evidence;
			}
			stop = blockedStop(end.detection);
		} else if (end.how === "expired") {
			stop = { outcome: "timeout", code: "challenge_expired", message: "nobody cleared the human check in time", retryable: true };
		} else if (end.how === "stopped") {
			stop = end.stop;
		} else {
			stop = TAB_CLOSED;
		}
		if (run.stop !== null) stop = run.stop;
		await this.#conclude(run, stop, collected, stop === null ? file : null);
	}

	/**
	 * @param {Run} run
	 * @returns {Promise<{ collected: Collected } | { stop: Stop } | { park: Detection }>}
	 *   park: the page shows a challenge that did not clear by itself
	 */
	async #drive(run) {
		const d = this.#d;
		// The daemon checked the URL already. Check again: this side decides
		// what the browser loads.
		const verdict = checkUrl(run.url, d.policy);
		if (!verdict.allowed) {
			return { stop: { outcome: "policy_blocked", code: verdict.reason, message: "the URL is not allowed by the gateway policy", retryable: false } };
		}
		run.host = verdict.host;
		d.onActivity();

		// The operator's own cookie store only for a fetch whose URL lies inside one
		// of their rules, and only as often as that rule allows. The daemon paces
		// to the same limit; this is the one it cannot lift.
		const rule = run.kind === "fetch" && run.session === "auto" ? d.optin.match(run.url) : null;
		if (rule !== null) {
			const waitS = d.optin.admit(rule);
			if (waitS > 0) {
				return { stop: { outcome: "error", code: ERROR_CODE.LOGIN_RATE_LIMIT, message: "pages under this login rule were loaded too often; the limit is the operator's protection and cannot be lifted", retryable: true, retryAfterS: waitS } };
			}
		}

		// Fail closed: without the container nothing is loaded at all.
		/** @type {string} */
		let cookieStoreId;
		const ensured = await this.#step(run, d.container.ensure().then((id) => ({ id }), (err) => ({ err })));
		if ("stop" in ensured) return ensured;
		if ("err" in ensured.value) {
			const message = ensured.value.err instanceof ContainerError ? ensured.value.err.message : "the gateway container is not available";
			return { stop: { outcome: "error", code: "container_unavailable", message: message.slice(0, 300), retryable: false } };
		} else {
			cookieStoreId = rule === null ? ensured.value.id : DEFAULT_STORE_ID;
		}
		run.scope = rule === null ? "container" : "default";
		run.rule = rule;
		d.send(makeMessage(MSG.JOB_ACCEPTED, { job: run.id, cookie_scope: run.scope, rule: rule === null ? null : { host: rule.host, path_prefix: rule.pathPrefix, subdomains: rule.subdomains } }));
		// The host of the rule, never the address: what is loaded with the operator's login is not written down.
		if (rule !== null) d.log("job.login_scope", { job: run.id, host: rule.host.slice(0, 80) });
		d.onActivity();

		const pre = await this.#step(run, d.guard.precheck(run.url));
		if ("stop" in pre) return pre;
		if (pre.value.verdict !== null) return { stop: { ...pre.value.verdict, retryable: pre.value.verdict.code === "dns_failed" } };

		const acquiring = d.window.acquire(cookieStoreId);
		const acquired = await this.#step(run, acquiring.then((tab) => ({ tab }), (err) => ({ err })));
		if ("stop" in acquired) {
			// The tab may still be on its way: close it once it is there.
			this.#straggling += 1;
			acquiring
				.then((tab) => d.window.release(tab.tabId))
				.catch(() => {})
				.finally(() => {
					this.#straggling -= 1;
				});
			return acquired;
		}
		if ("err" in acquired.value) {
			d.log("job.window_failed", { job: run.id, message: errorText(acquired.value.err) });
			return { stop: { outcome: "error", code: "window_unavailable", message: "the gateway window or job tab could not be opened", retryable: true } };
		}
		const tabId = acquired.value.tab.tabId;
		run.tabId = tabId;
		run.windowId = acquired.value.tab.windowId;
		run.tabOpened = true;
		run.guard = d.guard.attach(tabId, {
			cookieStoreId,
			onVerdict: (v) => {
				if (v.detect !== undefined && run.detect === null) run.detect = { kind: v.detect.kind, evidence: v.detect.evidence, since: this.#clock.now(), waitedMs: 0, resolved: null };
				// A rate limit passes, as it does for a page; so does a name that did not resolve, and a worker that is taken away when the job ends.
				run.interrupt({ outcome: v.outcome, code: v.code, message: v.message, retryable: v.code === "dns_failed" || v.code === KIND.HTTP_429 || v.code === UNGUARDED, ...(typeof v.retryAfterS === "number" ? { retryAfterS: v.retryAfterS } : {}) });
			},
			files: run.files,
			onFile: (capture) => {
				run.capture = capture;
				run.wakeFile();
				// A parked job has no flow of its own that could notice: its watch ends, and what follows receives the file.
				if (run.parked) this.#parked.cleared(run.id);
			},
			...(rule === null ? {} : { scope: { rule, policy: d.optinPolicy, url: run.url } }),
		});

		const unlisten = this.#trackNavigation(run, tabId);
		try {
			this.#progress(run, "navigating");
			const navAt = Date.now();
			run.times.prep_ms = navAt - run.startedAt;
			// One automatic retry on a navigation error (seen right after a network switch).
			for (let attempt = 0; ; attempt++) {
				const navDeadline = Math.min(Date.now() + run.wait.timeout_ms, run.deadline);
				run.nav.error = null;
				run.nav.completedAt = 0;
				run.nav.startedAt = Date.now();
				const started = await this.#step(run, d.window.navigate(tabId, run.url));
				if ("stop" in started) return started;
				const nav = await this.#waitLoaded(run, navDeadline);
				if (nav.kind === "stopped") return { stop: nav.stop };
				if (nav.kind === "loaded") break;
				if (nav.kind === "timeout") {
					// What the result says of it is where the page stood (stallLine): the daemon's own sentence says the rest.
					return { stop: { outcome: "timeout", code: "navigation_timeout", message: await this.#noteStall(run, tabId, attempt), retryable: true } };
				}
				if (attempt === 0 && Date.now() < navDeadline) {
					d.log("job.navigation_retry", { job: run.id, error: nav.error });
					continue;
				}
				return { stop: { outcome: "error", code: "navigation_failed", message: `the page could not be loaded (${nav.error})`, retryable: true } };
			}
			run.times.nav_ms = Date.now() - navAt;
			// The guard hears a job tab through listeners of the tab's own. A page
			// that loaded without the guard having heard its top frame was not
			// guarded: its content is not used, and the guard goes back to
			// listening to everything.
			if (!run.guard.sawTopFrame) {
				d.guard.widen("tab_filter_deaf");
				return { stop: { outcome: "error", code: "guard_blind", message: "the request guard did not see the page being loaded", retryable: true } };
			}

			this.#progress(run, "settling");
			const settleAt = Date.now();
			const settled = await this.#settle(run, tabId);
			run.times.settle_ms = Date.now() - settleAt;
			if ("stop" in settled) return settled;
			run.settled = settled.value;
			run.times.scroll_ms = settled.value.walkMs;

			const seen = await this.#look(run, tabId);
			if ("stop" in seen) return seen;
			let detection = seen.value.detection;
			if (detection !== null) {
				run.detect = { kind: detection.kind, evidence: detection.evidence, since: this.#clock.now(), waitedMs: 0, resolved: null };
				if (detection.action === "challenge") {
					// A browser check passes by being waited for. Nothing is done to the page meanwhile.
					this.#progress(run, "challenge_wait");
					const graceAt = this.#clock.now();
					const waited = await this.#grace(run, tabId, detection);
					run.times.grace_ms = this.#clock.now() - graceAt;
					if ("stop" in waited) return waited;
					detection = waited.value;
					run.detect.waitedMs = this.#clock.now() - run.detect.since;
					if (detection === null) {
						run.detect.resolved = RESOLVED.WAITING;
						this.#d.log("job.challenge_cleared", { job: run.id, kind: run.detect.kind, waited_ms: Math.round(run.detect.waitedMs) });
						// The page behind the challenge settles like any other.
						this.#progress(run, "settling");
						const clearedAt = Date.now();
						const again = await this.#settle(run, tabId);
						run.times.cleared_settle_ms = Date.now() - clearedAt;
						if ("stop" in again) return again;
						run.settled = again.value;
						run.times.scroll_ms += again.value.walkMs;
					}
				}
				if (detection !== null) {
					run.detect.kind = detection.kind;
					run.detect.evidence = detection.evidence;
					if (detection.action === "challenge") return { park: detection };
					return { stop: blockedStop(detection) };
				}
			}

			if (run.wait.dwell_ms > 0) {
				// A tab out of sight is read as soon as it has loaded: no pacing pause on top.
				if (run.settled?.visibility === "hidden") run.dwell = "skipped_hidden";
				else {
					const dwellAt = this.#clock.now();
					const dwell = await this.#step(run, this.#pause(Math.max(0, Math.min(run.wait.dwell_ms, run.deadline - Date.now()))));
					run.times.dwell_ms = this.#clock.now() - dwellAt;
					if ("stop" in dwell) return dwell;
					run.dwell = "done";
				}
			}

			this.#progress(run, "extracting");
			const readAt = Date.now();
			const collected = await this.#collect(run, tabId);
			run.times.extract_ms = Date.now() - readAt;
			if ("stop" in collected) return collected;
			return { collected: collected.value };
		} finally {
			unlisten();
		}
	}

	/**
	 * Look at the page of a job tab: its response headers as the guard recorded
	 * them, where the tab is now, and what the detection script sees in the DOM.
	 * @param {Run} run
	 * @param {number} tabId
	 * @returns {Promise<{ value: { detection: Detection | null, dom: DomFacts | null } } | { stop: Stop }>}
	 */
	async #look(run, tabId) {
		const tab = await this.#d.tabs.get(tabId).catch(() => null);
		if (tab === null) return { stop: run.stop ?? TAB_CLOSED };
		const finalUrl = isWebUrl(tab.url) ? String(tab.url) : null;
		// Where the tab is now must still be inside the rule of a job that has one.
		if (typeof tab.url === "string" && tab.url !== BLANK && run.guard?.topFrameAt(tab.url) === false) return { stop: run.stop ?? TAB_CLOSED };
		/** @type {DomFacts | null} */
		let dom = null;
		if (finalUrl !== null) {
			// A page that cannot be scripted, or a document that goes away under the script, simply has no DOM facts.
			const script = withTimeout(this.#d.tabs.executeScript(tabId, { file: "/content/detect-dom.js", runAt: "document_idle" }), this.#tuning.detectTimeoutMs, "detect");
			const tried = await this.#step(run, script.then((results) => results[0], () => null));
			if ("stop" in tried) return tried;
			dom = cleanDomFacts(tried.value);
		}
		const nav = run.guard?.nav;
		const detection = decide({
			status: nav?.httpStatus ?? null,
			cfMitigated: nav?.cfMitigated === true,
			retryAfterS: typeof nav?.retryAfterS === "number" ? nav.retryAfterS : null,
			requestedUrl: run.url,
			finalUrl,
			dom,
		});
		return { value: { detection, dom } };
	}

	/**
	 * The grace period of a challenge: look again every now and then until the
	 * page shows no challenge any more, or the time is up. The time is random
	 * within its limits and never longer than the job has left.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {Detection} first what the page showed when the grace period began
	 * @returns {Promise<{ value: Detection | null } | { stop: Stop }>} null: the challenge is gone
	 */
	async #grace(run, tabId, first) {
		const [min, max] = this.#tuning.graceMs;
		const u = Math.min(Math.max(this.#rng(), 0), 1);
		const graceMs = Math.min(Math.round(min + (max - min) * u), max);
		const end = this.#clock.now() + graceMs;
		// The job gets that much longer, and time for the page behind the
		// challenge to settle. The daemon grants the same when it is told of the wait.
		run.deadline += graceMs + Math.max(run.wait.settle_ms * 5, 5000);
		this.#armBackstop(run);
		this.#d.log("job.challenge_wait", { job: run.id, kind: first.kind, grace_ms: graceMs });
		/** @type {Detection | null} */
		let last = first;
		for (;;) {
			const left = end - this.#clock.now();
			if (left <= 0) return { value: last };
			const slept = await this.#step(run, this.#pause(Math.min(this.#tuning.gracePollMs, left)));
			if ("stop" in slept) return slept;
			// A page that is on its way somewhere else is looked at when it has arrived.
			if (run.nav.completedAt < run.nav.startedAt) {
				const loaded = await this.#waitLoaded(run, Date.now() + Math.min(run.wait.timeout_ms, 10000));
				if (loaded.kind === "stopped") return { stop: loaded.stop };
				if (loaded.kind !== "loaded") continue;
			}
			const seen = await this.#look(run, tabId);
			if ("stop" in seen) return seen;
			last = seen.value.detection;
			// Gone, or turned into a refusal: nothing more to wait for.
			if (last === null || last.action === "blocked") return { value: last };
		}
	}

	/**
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {() => void} [onCompleted] called when a navigation of the top frame completed
	 * @returns {() => void} remove the listeners again
	 */
	#trackNavigation(run, tabId, onCompleted) {
		const nav = this.#d.webNavigation;
		/** @param {{ tabId: number, frameId: number, url: string }} details */
		const mine = (details) => details.tabId === tabId && details.frameId === 0 && details.url !== BLANK;
		/**
		 * Where the top frame is going, or has got to. For a tab that must stay
		 * inside a rule this is the look at what no request stands behind: an
		 * address changed by script, a document the page made itself.
		 * @param {{ tabId: number, frameId: number, url: string }} details
		 */
		const onMoved = (details) => {
			if (mine(details)) run.guard?.topFrameAt(details.url);
		};
		/** @param {{ tabId: number, frameId: number, url: string }} details */
		const onCommitted = (details) => {
			if (mine(details)) {
				run.nav.committedAt = Date.now();
				// A document the guard never saw the response of ends the job here and now.
				run.guard?.committed(details.url);
			}
			onMoved(details);
		};
		/** @param {browser.webNavigation._OnBeforeNavigateDetails} details */
		const onBefore = (details) => {
			if (!mine(details)) return;
			run.nav.startedAt = Date.now();
			onMoved(details);
		};
		/** @param {browser.webNavigation._OnCompletedDetails} details */
		const onDone = (details) => {
			if (!mine(details)) return;
			run.nav.completedAt = Date.now();
			onCompleted?.();
		};
		/** @param {browser.webNavigation._OnErrorOccurredDetails} details */
		const onError = (details) => {
			if (!mine(details)) return;
			run.nav.errorAt = Date.now();
			const text = /** @type {{ error?: unknown }} */ (details).error;
			// What the tab commits next for this address is the browser's error page, and the guard is to know.
			run.guard?.navigationFailed(details.url, text);
			run.nav.error = typeof text === "string" ? text.replace(/[^A-Za-z0-9_ ]/g, "").slice(0, 64) : "unknown";
		};
		nav.onBeforeNavigate.addListener(onBefore);
		nav.onCompleted.addListener(onDone);
		nav.onErrorOccurred.addListener(onError);
		nav.onCommitted?.addListener(onCommitted);
		const moves = [nav.onHistoryStateUpdated, nav.onReferenceFragmentUpdated];
		for (const event of moves) event?.addListener(onMoved);
		return () => {
			nav.onBeforeNavigate.removeListener(onBefore);
			nav.onCompleted.removeListener(onDone);
			nav.onErrorOccurred.removeListener(onError);
			nav.onCommitted?.removeListener(onCommitted);
			for (const event of moves) event?.removeListener(onMoved);
		};
	}

	/**
	 * A page did not finish loading in time. Where it stood is written to the log, once, for whoever has to find
	 * out why: the navigation events of the tab as times, what the browser says of the tab, and what the request
	 * guard still owed its requests (TabGuard.diagnose). Counts, times and fixed words: no address, and nothing of
	 * the page. Nothing is done to the tab.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {number} attempt 0, or 1 after the one retry
	 * @returns {Promise<string>} the same facts on one line (stallLine), for the result of the job
	 */
	async #noteStall(run, tabId, attempt) {
		const now = Date.now();
		/** @param {number} at @returns {number} how long ago; -1: never */
		const ago = (at) => (at > 0 ? now - at : -1);
		// Read before anything is waited for: the tab as it is in the moment the navigation is given up.
		const facts = run.guard?.diagnose?.() ?? {};
		const tab = await withTimeout(this.#d.tabs.get(tabId), 1000, "tab").catch(() => null);
		const status = tab === null ? "unknown" : tab.status === "loading" || tab.status === "complete" ? tab.status : "unknown";
		const where = { attempt, tab_status: status, started_ms: ago(run.nav.startedAt), committed_ms: ago(run.nav.committedAt), completed_ms: ago(run.nav.completedAt), error_ms: ago(run.nav.errorAt) };
		this.#d.log("job.navigation_stalled", { job: run.id, ...where, nav_error: run.nav.error, ...facts });
		return stallLine(where, facts);
	}

	/**
	 * Wait until the top frame finished loading.
	 * @param {Run} run
	 * @param {number} deadline
	 * @returns {Promise<{ kind: "loaded" } | { kind: "timeout" } | { kind: "error", error: string } | { kind: "stopped", stop: Stop }>}
	 */
	async #waitLoaded(run, deadline) {
		const t = run.nav;
		for (;;) {
			if (run.stop !== null) return { kind: "stopped", stop: run.stop };
			// No page will load: the response is being read as a file.
			if (run.capture !== null) return { kind: "stopped", stop: FILE_ARRIVED };
			const now = Date.now();
			if (t.completedAt > 0 && t.completedAt >= t.startedAt) return { kind: "loaded" };
			// An error only counts when no other navigation takes over: a
			// script redirect aborts the load it interrupts.
			if (t.error !== null && t.startedAt <= t.errorAt && now - t.errorAt >= this.#tuning.errorGraceMs) {
				return { kind: "error", error: t.error };
			}
			if (now >= deadline) return { kind: "timeout" };
			await Promise.race([sleep(Math.min(this.#tuning.pollMs, Math.max(1, deadline - now))), run.stopped, run.fileSeen]);
		}
	}

	/**
	 * Run the settle script in the top frame of the job tab.
	 * @param {number} tabId
	 * @param {Record<string, number | boolean>} args numbers and booleans only: this becomes code
	 * @param {number} timeoutMs
	 * @returns {Promise<Record<string, unknown>>}
	 */
	async #injectSettle(tabId, args, timeoutMs) {
		const run = async () => {
			await this.#d.tabs.executeScript(tabId, { code: `globalThis.__bgwSettle = ${JSON.stringify(args)};`, runAt: "document_start" });
			const results = await this.#d.tabs.executeScript(tabId, { file: "/content/settle.js", runAt: "document_idle" });
			return results[0];
		};
		return this.#answer(await withTimeout(run(), timeoutMs, "settle"), "settle");
	}

	/**
	 * Run the extractor in the top frame of the job tab: with Defuddle first,
	 * and if anything about that fails, once more without it.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {Record<string, number | boolean>} args numbers and booleans only: this becomes code
	 * @param {number} timeoutMs for each attempt
	 * @param {boolean} [plain] without Defuddle from the start: the text and the links of what the page renders
	 * @returns {Promise<Record<string, unknown>>}
	 */
	async #injectExtract(run, tabId, args, timeoutMs, plain = false) {
		const navigatedAt = run.nav.startedAt;
		/** @param {boolean} defuddle */
		const attempt = async (defuddle) => {
			const inject = async () => {
				// The bundle only defines a global; extract.js only defines a function.
				if (defuddle) await this.#d.tabs.executeScript(tabId, { file: "/vendor/defuddle.full.js", runAt: "document_idle" });
				await this.#d.tabs.executeScript(tabId, { file: "/content/extract.js", runAt: "document_idle" });
				const results = await this.#d.tabs.executeScript(tabId, { code: `globalThis.__bgwExtract(${JSON.stringify({ ...args, defuddle })});`, runAt: "document_idle" });
				return results[0];
			};
			return this.#answer(await withTimeout(inject(), timeoutMs, "extract"), "extract");
		};
		if (plain) return attempt(false);
		try {
			return await attempt(true);
		} catch (err) {
			// The document went away under the script: the caller starts over in its successor.
			if (run.nav.startedAt !== navigatedAt) throw err;
			this.#d.log("job.extract_fallback", { job: run.id, message: errorText(err) });
			return attempt(false);
		}
	}

	/**
	 * Run the search script in the top frame of the job tab. It works on the
	 * clone that extract.js makes, so that goes in first.
	 * @param {number} tabId
	 * @param {Record<string, number | boolean>} args numbers and booleans only: this becomes code
	 * @param {number} timeoutMs
	 * @returns {Promise<Record<string, unknown>>}
	 */
	async #injectSearch(tabId, args, timeoutMs) {
		const inject = async () => {
			await this.#d.tabs.executeScript(tabId, { file: "/content/extract.js", runAt: "document_idle" });
			await this.#d.tabs.executeScript(tabId, { file: "/content/search.js", runAt: "document_idle" });
			const results = await this.#d.tabs.executeScript(tabId, { code: `globalThis.__bgwSearch(${JSON.stringify(args)});`, runAt: "document_idle" });
			return results[0];
		};
		return this.#answer(await withTimeout(inject(), timeoutMs, "search"), "search");
	}

	/**
	 * @param {unknown} result what a content script handed back
	 * @param {string} name
	 * @returns {Record<string, unknown>}
	 */
	#answer(result, name) {
		if (typeof result !== "object" || result === null || /** @type {Record<string, unknown>} */ (result).ok !== true) {
			throw new Error(`${name} returned no result`);
		}
		return /** @type {Record<string, unknown>} */ (result);
	}

	/**
	 * Run a content script, coping with a document that goes away under it
	 * (a script redirect) and with pages that cannot be scripted at all.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {"settle" | "extract" | "plain" | "search"} name plain: the extractor without Defuddle
	 * @param {(remainingMs: number) => { args: Record<string, number | boolean>, timeoutMs: number }} plan
	 * @returns {Promise<{ value: Record<string, unknown> } | { stop: Stop }>}
	 */
	async #script(run, tabId, name, plan) {
		// A document that was replaced is worth another go; an extractor that fails on the same document is not.
		const attempts = name === "settle" ? 5 : 2;
		let scriptable = name !== "settle";
		for (let attempt = 0; attempt < attempts; attempt++) {
			const remaining = Math.max(0, run.deadline - run.wait.dwell_ms - Date.now());
			const { args, timeoutMs } = plan(remaining);
			const inject =
				name === "settle" ? this.#injectSettle(tabId, args, timeoutMs) : name === "search" ? this.#injectSearch(tabId, args, timeoutMs) : this.#injectExtract(run, tabId, args, timeoutMs, name === "plain");
			const tried = await this.#step(run, inject.then((value) => ({ value }), () => null));
			if ("stop" in tried) return tried;
			if (tried.value !== null) return tried.value;
			// Why did it fail? A page the extension may not touch (viewer,
			// error or internal page) never works. A document that was
			// replaced works once its successor has loaded.
			const tab = await this.#d.tabs.get(tabId).catch(() => null);
			if (tab === null) return { stop: run.stop ?? TAB_CLOSED };
			if (!isWebUrl(tab.url)) {
				scriptable = false;
				break;
			}
			if (Date.now() >= run.deadline) break;
			const loaded = await this.#waitLoaded(run, Math.min(run.deadline, Date.now() + 5000));
			if (loaded.kind === "stopped") return { stop: loaded.stop };
			await sleep(150);
		}
		if (scriptable) {
			// The page settled, so scripts do run in it: it is the extractor that failed.
			return { stop: { outcome: "error", code: "extract_failed", message: "the content of the page could not be extracted", retryable: false } };
		}
		// A navigation that became a download leaves a tab without a page. The
		// downloads backstop says so a moment later; its verdict is the better one.
		const grace = await this.#step(run, sleep(this.#tuning.downloadGraceMs));
		if ("stop" in grace) return grace;
		return { stop: { outcome: "unsupported", code: "not_scriptable", message: "the page cannot be read by the extension", retryable: false } };
	}

	/**
	 * Wait for the page of a job tab to settle.
	 *
	 * Visible tab: content/settle.js waits for the DOM to be quiet and, when the
	 * job asks for it, walks down the page. That script looks at the visibility
	 * when it starts and before every timer hop; a hidden document makes it
	 * answer at once (bailed) and the hidden path below takes over - also when
	 * the window went out of sight in the middle of the walk.
	 *
	 * Hidden tab (HIDDEN PATH): its in-page timers fire about once a second and
	 * it gets almost no frames, so nothing here waits inside the page. Timer
	 * hops in the page: 0. Waits of the background page: 1 (hiddenQuietMs at
	 * most, 0 when the job wants no settle time). Round trips of
	 * tabs.executeScript: the argument script and settle.js (which answers
	 * bailed at once), then two each for the start and the end of the quiet
	 * check. No walk, no dwell, no stretching.
	 *
	 * A page that gets longer under the walk (a feed that loads more as it is
	 * scrolled) is walked further than others, for as long as it keeps
	 * growing: scrollGrowMs, scrollGrowSteps and scrollGrowMaxPx bound that.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {boolean} [afterHandoff] the operator has just cleared the page, in a window in front of them: the quiet
	 *   check gets a short cap and the page is not walked down
	 * @returns {Promise<{ value: Settled } | { stop: Stop }>}
	 */
	async #settle(run, tabId, afterHandoff = false) {
		const quietMs = run.wait.settle_ms;
		const capMs = afterHandoff ? Math.min(Math.max(quietMs * 2, 1000), this.#tuning.handoffCapMs) : Math.max(quietMs * 5, 5000);
		// The walk down the page is for the gateway container only. A tab that
		// runs with the operator's own session is loaded and read, nothing more.
		const asked = run.wait.scroll === "lazy" && run.scope === "container";
		const scroll = asked && !afterHandoff;
		const scrollMs = scroll ? this.#tuning.scrollMs : 0;
		const growMs = scroll ? this.#tuning.scrollGrowMs : 0;
		let walkedPx = 0;
		let walkedSteps = 0;
		let walkMs = 0;
		if (!this.#tuning.forceHidden) {
			const done = await this.#script(run, tabId, "settle", (remaining) => ({
				args: { quietMs, capMs, budgetMs: remaining, probeMs: 250, scroll, scrollSteps: this.#tuning.scrollSteps, scrollMs, growMs, growSteps: this.#tuning.scrollGrowSteps, growMaxPx: this.#tuning.scrollGrowMaxPx },
				// Only a safety net: the script ends itself, at the latest at its budget.
				timeoutMs: Math.min((capMs + Math.max(scrollMs, growMs)) * SETTLE_SLACK, remaining) + 5000,
			}));
			if ("stop" in done) return done;
			const r = done.value;
			const hz = typeof r.rafHz === "number" && Number.isFinite(r.rafHz) ? Math.min(Math.max(r.rafHz, 0), 1000) : 0;
			const px = typeof r.scrolledPx === "number" && Number.isFinite(r.scrolledPx) ? Math.min(Math.max(Math.round(r.scrolledPx), 0), 100000000) : 0;
			walkMs = typeof r.walkMs === "number" && Number.isFinite(r.walkMs) ? Math.min(Math.max(Math.round(r.walkMs), 0), LIMITS.MAX_TIMEOUT_MS) : 0;
			const steps = typeof r.scrollSteps === "number" && Number.isFinite(r.scrollSteps) ? Math.max(Math.floor(r.scrollSteps), 0) : 0;
			if (r.visibility !== "hidden") {
				// Counts only: how far the walk went, and whether the page grew under it.
				if (scroll) this.#d.log("job.walked", { job: run.id, steps, px, ms: walkMs, grew: r.grew === true });
				return this.#noteSettled(run, { settled: r.settled === true, visibility: "visible", rafHz: hz, scrolledPx: px, scroll: scroll ? "done" : asked ? "skipped_handoff" : "off", walkMs });
			}
			walkedPx = px;
			walkedSteps = steps;
		}
		return this.#settleHidden(run, tabId, asked, walkedPx, walkedSteps, walkMs);
	}

	/**
	 * The hidden path of #settle: load is complete (the caller waited for it);
	 * one quiet check, timed here, watched in the page by content/quiet.js.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {boolean} scrollAsked
	 * @param {number} walkedPx how far a walk got before the tab went out of sight
	 * @param {number} walkedSteps
	 * @param {number} walkMs how long that walk took
	 * @returns {Promise<{ value: Settled } | { stop: Stop }>}
	 */
	async #settleHidden(run, tabId, scrollAsked, walkedPx, walkedSteps, walkMs) {
		/** @type {import("../shared/protocol.js").ScrollResult} */
		const scroll = !scrollAsked ? "off" : walkedSteps > 0 ? "cut_short_hidden" : "skipped_hidden";
		const remaining = Math.max(0, run.deadline - Date.now());
		const waitMs = Math.max(0, Math.min(run.wait.settle_ms, this.#tuning.hiddenQuietMs, Math.floor(remaining / 2)));
		let settled = true;
		/** @type {number | null} */
		let rafHz = null;
		if (waitMs > 0) {
			const begin = await this.#quiet(run, tabId, false);
			if ("stop" in begin) return begin;
			// A page that cannot be asked is not waited for: whatever the extractor makes of it comes next.
			/** @type {Record<string, unknown> | null} */
			let r = null;
			if (begin.value !== null) {
				const slept = await this.#step(run, this.#pause(waitMs));
				if ("stop" in slept) return slept;
				const end = await this.#quiet(run, tabId, true);
				if ("stop" in end) return end;
				r = end.value;
			}
			// A document that was replaced under the check is not known to be quiet either.
			settled = r !== null && r.known === true && r.mutations === 0;
			if (r !== null && r.known === true && typeof r.frames === "number" && typeof r.ms === "number" && r.ms > 0 && Number.isFinite(r.frames)) {
				rafHz = Math.min(Math.round((Math.max(r.frames, 0) / r.ms) * 10000) / 10, 1000);
			}
		}
		this.#d.log("job.hidden_path", { job: run.id, quiet_ms: waitMs, settled, scroll });
		return this.#noteSettled(run, { settled, visibility: "hidden", rafHz, scrolledPx: walkedPx, scroll, walkMs });
	}

	/**
	 * One call of content/quiet.js: the start or the end of the quiet check.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {boolean} end
	 * @returns {Promise<{ value: Record<string, unknown> | null } | { stop: Stop }>} null: no answer
	 */
	async #quiet(run, tabId, end) {
		const call = async () => {
			await this.#d.tabs.executeScript(tabId, { code: `globalThis.__bgwQuietArgs = ${JSON.stringify({ end })};`, runAt: "document_start" });
			const results = await this.#d.tabs.executeScript(tabId, { file: "/content/quiet.js", runAt: "document_idle" });
			return results[0];
		};
		const limit = Math.max(1, Math.min(this.#tuning.hiddenScriptMs, run.deadline - Date.now()));
		const tried = await this.#step(
			run,
			withTimeout(call(), limit, "quiet").then(
				(value) => {
					const ok = typeof value === "object" && value !== null && /** @type {Record<string, unknown>} */ (value).ok === true;
					return /** @type {Record<string, unknown> | null} */ (ok ? value : null);
				},
				() => null,
			),
		);
		return "stop" in tried ? tried : { value: tried.value };
	}

	/**
	 * Remember what settling found. Hidden stays hidden for the whole job, and
	 * the furthest the page was walked down stays.
	 * @param {Run} run
	 * @param {Settled} next
	 * @returns {{ value: Settled }}
	 */
	#noteSettled(run, next) {
		const prev = run.settled;
		if (prev !== null) {
			if (prev.visibility === "hidden") next.visibility = "hidden";
			next.scrolledPx = Math.max(prev.scrolledPx, next.scrolledPx);
		}
		return { value: next };
	}

	/**
	 * @param {Run} run
	 * @param {number} tabId
	 * @returns {Promise<{ value: Collected } | { stop: Stop }>}
	 */
	async #collect(run, tabId) {
		if (run.search !== null) return this.#collectSearch(run, tabId, run.search);
		// A probe wants the facts about the page, not its content.
		const fetch = run.kind === "fetch";
		// A string of more characters than the frame has bytes could never be sent whole.
		const maxChars = this.#d.maxResultBytes();
		const done = await this.#script(run, tabId, "extract", () => ({
			args: {
				markdown: fetch && run.extract.markdown,
				text: fetch && run.extract.text,
				html: fetch && run.extract.html,
				// Always in the gateway container; in the operator's login scope only when the job asks.
				rawHtml: fetch && (run.scope === "container" || run.extract.raw_html),
				links: fetch && run.extract.links,
				maxMarkdownChars: maxChars,
				maxTextChars: maxChars,
				maxHtmlChars: maxChars,
				maxRawHtmlChars: LIMITS.MAX_RAW_HTML_CHARS,
				maxLinks: LIMITS.MAX_LINKS,
			},
			timeoutMs: this.#tuning.extractTimeoutMs,
		}));
		if ("stop" in done) return done;
		const collected = cleanExtracted(done.value);
		// What was read must have been read inside the rule: the address the page itself reports, last of all.
		if (run.rule !== null && (collected.url === null || run.guard === null || !run.guard.topFrameAt(collected.url))) {
			return { stop: run.stop ?? { outcome: "policy_blocked", code: OUT_OF_SCOPE, message: "the page is not inside the part of the site the operator opted in", retryable: false } };
		}
		const stats = typeof done.value.stats === "object" && done.value.stats !== null ? /** @type {Record<string, unknown>} */ (done.value.stats) : {};
		/** @param {unknown} v */
		const count = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
		// Counts and the extractor's name only: nothing of the page itself is logged.
		this.#d.log("job.extracted", {
			job: run.id,
			extractor: collected.page.extractor === null ? null : collected.page.extractor.replace(/[^A-Za-z0-9@.+_-]/g, "").slice(0, 60),
			view: collected.extraction.view,
			coverage_pct: collected.extraction.coverage_pct,
			hidden_removed: count(stats.hidden_removed),
			fading_kept: count(stats.fading_kept),
			elements_inspected: count(stats.elements_inspected),
			capped: stats.capped === true,
			// The extractor bundle threw or was not there: the page was read as plain text.
			defuddle_failed: stats.defuddle_failed === true,
			ms: count(stats.ms),
		});
		return { value: collected };
	}

	/**
	 * Read a results page: the list of results, and where that is no list, the
	 * text and the links of the page as well.
	 * @param {Run} run
	 * @param {number} tabId
	 * @param {{ limit: number, hint: number }} search
	 * @returns {Promise<{ value: Collected } | { stop: Stop }>}
	 */
	async #collectSearch(run, tabId, search) {
		// Asked for at least as many as make a list: whether the page has one is not a matter of how few the caller wants.
		const ask = Math.max(search.limit, MIN_RESULTS);
		const done = await this.#script(run, tabId, "search", () => ({ args: { limit: ask, hint: search.hint }, timeoutMs: this.#tuning.extractTimeoutMs }));
		if ("stop" in done) return done;
		const found = cleanSearch(done.value, ask);
		const fallback = found.results.length < MIN_RESULTS;
		found.results = found.results.slice(0, search.limit);
		/** @type {Collected} */
		const collected = {
			url: found.url,
			page: { title: found.title, author: null, published: null, lang: null, site: null, word_count: 0, extractor: fallback ? "search-fallback" : `search-${found.detector}` },
			extraction: { view: "text", coverage_pct: null, hidden_removed: found.hiddenRemoved, capped: found.capped },
			markdown: null,
			text: null,
			html: null,
			rawHtml: null,
			links: [],
			markdownTruncated: false,
			textTruncated: false,
			htmlTruncated: false,
			rawHtmlTruncated: false,
			results: found.results,
		};
		if (fallback) {
			// No list was recognised: what the page shows, and where it links to.
			const maxChars = this.#d.maxResultBytes();
			const plain = await this.#script(run, tabId, "plain", () => ({
				args: { markdown: false, text: true, html: false, links: true, maxMarkdownChars: maxChars, maxTextChars: maxChars, maxHtmlChars: maxChars, maxLinks: LIMITS.MAX_LINKS },
				timeoutMs: this.#tuning.extractTimeoutMs,
			}));
			if ("stop" in plain) return plain;
			const page = cleanExtracted(plain.value);
			collected.text = page.text ?? page.markdown;
			collected.textTruncated = page.textTruncated || page.markdownTruncated;
			collected.links = page.links;
			collected.page.word_count = page.page.word_count;
			collected.url = page.url ?? collected.url;
		}
		const stats = typeof done.value.stats === "object" && done.value.stats !== null ? /** @type {Record<string, unknown>} */ (done.value.stats) : {};
		/** @param {unknown} v */
		const count = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
		// Counts only: nothing of the page, and nothing of what was searched for.
		this.#d.log("job.searched", { job: run.id, results: found.results.length, detector: found.detector, fallback, generic: count(stats.generic), hint: count(stats.hint), hidden_removed: found.hiddenRemoved, ms: count(stats.ms) });
		return { value: collected };
	}

	/**
	 * @param {Run} run
	 * @param {Stop | null} stop
	 * @param {Collected | null} collected
	 * @param {{ size: number, sha256: string, chunks: number, plan: import("./capture.js").CapturePlan } | null} [file] the file
	 *   whose bytes went ahead
	 * @param {number | null} [bodyBytes] what a file capture read of the response, complete or not
	 * @returns {JobResultBody}
	 */
	#buildResult(run, stop, collected, file = null, bodyBytes = null) {
		const nav = run.guard?.nav ?? { redirectOrigins: [], httpStatus: null, contentType: null };
		const detect = run.detect;
		/** @type {JobResultBody} */
		const body = {
			job: run.id,
			outcome: stop === null ? "ok" : stop.outcome,
			cookie_scope: run.tabOpened ? run.scope : null,
			nav: {
				requested_url: run.url,
				final_url: stop === null && collected !== null ? collected.url : null,
				redirect_origins: [...nav.redirectOrigins],
				http_status: nav.httpStatus,
				content_type: nav.contentType === null ? null : nav.contentType.slice(0, 200),
				body_bytes: typeof bodyBytes === "number" && Number.isSafeInteger(bodyBytes) && bodyBytes >= 0 ? Math.min(bodyBytes, LIMITS.MAX_FILE_BYTES + 16777216) : null,
			},
			render: {
				visibility: run.settled?.visibility ?? null,
				raf_hz: run.settled?.rafHz ?? null,
				settled: run.settled?.settled ?? false,
				scrolled_px: run.settled?.scrolledPx ?? 0,
				scroll: run.settled?.scroll ?? "off",
				dwell: run.dwell,
				elapsed_ms: Math.min(Math.max(Date.now() - run.startedAt, 0), LIMITS.MAX_TIMEOUT_MS),
				// Whole milliseconds within the protocol's bounds, whatever a clock said.
				timings: /** @type {import("../shared/protocol.js").JobTimings} */ (
					Object.fromEntries(TIMING_PHASES.map((phase) => [phase, Number.isFinite(run.times[phase]) ? Math.min(Math.max(Math.round(run.times[phase]), 0), LIMITS.MAX_TIMEOUT_MS) : 0]))
				),
			},
			detect:
				detect === null
					? null
					: { kind: detect.kind, evidence: detect.evidence, waited_ms: Math.min(Math.max(Math.round(detect.waitedMs), 0), LIMITS.MAX_TIMEOUT_MS), resolved: stop === null ? detect.resolved : null },
			error:
				stop === null
					? null
					: {
							code: stop.code,
							// A login page where the operator's own session was used: they are logged out there.
							message: (run.scope === "default" && stop.code === KIND.LOGIN_WALL ? LOGGED_OUT : stop.message).slice(0, 500),
							retryable: stop.retryable,
							retry_after_s: typeof stop.retryAfterS === "number" ? Math.min(Math.max(Math.round(stop.retryAfterS), 0), 86400) : null,
						},
			page: null,
			extraction: null,
			content: null,
			truncated: { markdown: false, text: false, html: false, raw_html: false },
			file: null,
			tab_kept_open: false,
		};
		if (stop === null && file !== null) {
			// A file has no page, no extraction and no content: its description, and where it came from.
			body.nav.final_url = file.plan.url.slice(0, LIMITS.MAX_FINAL_URL);
			body.nav.content_type = file.plan.contentType.slice(0, 200);
			body.file = { name: file.plan.name === null ? null : file.plan.name.slice(0, LIMITS.MAX_FILE_NAME), charset: file.plan.charset, size: file.size, sha256: file.sha256, chunks: file.chunks };
			return body;
		}
		if (stop !== null || collected === null) return body;
		body.page = collected.page;
		body.extraction = collected.extraction;
		if (run.kind === "probe") return body;
		body.content = { markdown: null, text: null, html: null, raw_html: null, links: [], results: collected.results ?? [] };
		// The whole frame must fit the daemon's limit: measure it without the
		// content, then hand out what is left. The link list gets a share, the
		// Markdown comes next, then the visible text, then the cleaned document; the
		// raw page source gets what is left and is the first thing to be cut.
		let room = this.#d.maxResultBytes() - 64 - encoder.encode(JSON.stringify(makeMessage(MSG.JOB_RESULT, { ...body }))).length;
		const links = fitLinks(collected.links, Math.max(0, Math.floor(room * LINKS_SHARE)));
		body.content.links = links;
		if (links.length > 0) room -= encoder.encode(JSON.stringify(links)).length;
		if (collected.markdown !== null) {
			const fitted = fitJsonString(collected.markdown, Math.max(0, room));
			body.content.markdown = fitted.text;
			body.truncated.markdown = collected.markdownTruncated || fitted.truncated;
			room -= jsonBytes(fitted.text);
		}
		if (collected.text !== null) {
			const fitted = fitJsonString(collected.text, Math.max(0, room));
			body.content.text = fitted.text;
			body.truncated.text = collected.textTruncated || fitted.truncated;
			room -= jsonBytes(fitted.text);
		}
		if (collected.html !== null) {
			const fitted = fitJsonString(collected.html, Math.max(0, room));
			body.content.html = fitted.text;
			body.truncated.html = collected.htmlTruncated || fitted.truncated;
			room -= jsonBytes(fitted.text);
		}
		if (collected.rawHtml !== null) {
			const fitted = fitJsonString(collected.rawHtml, Math.max(0, room));
			body.content.raw_html = fitted.text;
			body.truncated.raw_html = collected.rawHtmlTruncated || fitted.truncated;
		}
		return body;
	}

	/** @param {JobResultBody} body */
	#sendResult(body) {
		let msg = makeMessage(MSG.JOB_RESULT, { ...body });
		const check = validateMessage(msg, DIRECTION.TO_DAEMON);
		if (!check.ok) {
			// An invalid frame would make the daemon cut the link. Report the
			// failure in a frame that is known to be well-formed instead.
			this.#d.log("job.result_invalid", { job: body.job, error: check.error });
			msg = makeMessage(MSG.JOB_RESULT, {
				job: body.job,
				outcome: "error",
				cookie_scope: body.cookie_scope,
				nav: { requested_url: BLANK, final_url: null, redirect_origins: [], http_status: null, content_type: null, body_bytes: null },
				render: { visibility: null, raf_hz: null, settled: false, scrolled_px: 0, scroll: "off", dwell: "off", elapsed_ms: 0, timings: zeroTimings() },
				detect: null,
				error: { code: "result_invalid", message: "the extension built a result the protocol does not allow", retryable: false, retry_after_s: null },
				page: null,
				extraction: null,
				content: null,
				truncated: { markdown: false, text: false, html: false, raw_html: false },
				file: null,
				tab_kept_open: false,
			});
		}
		if (!this.#d.send(msg)) this.#d.log("job.result_not_sent", { job: body.job });
	}
}
