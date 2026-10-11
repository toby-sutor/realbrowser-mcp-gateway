// Request guard for the gateway container. A request is
// the guard's business when it comes from a job tab or carries the cookie store
// of the gateway container; that includes requests no tab stands behind
// (service workers, shared workers).
//
// The operator's ordinary tabs do not pass through any listener of this file.
// A request filter cannot name a cookie store, but it can name a tab or a
// window, and "tab -1" selects exactly the requests without a tab (measured in
// Firefox 156: a tab's listener hears everything the tab does - frames,
// redirects, dedicated workers, WebSockets, beacons, its favicon). So the
// blocking listeners are registered for these slices only:
//
//   a job tab        its own listeners, from before it loads anything until
//                    it is closed
//   no tab (-1)      one set, for good. Decides by cookie store: the
//                    operator's own tab-less requests (their sites' workers,
//                    this extension's dial to the daemon) pass through it and
//                    are answered with "no objection" at once
//   gateway window   one listener for whatever else appears in that window: in
//                    the container's store (a pop-up of a job page), or in any
//                    store while a job tab is open (see "A tab somebody else
//                    makes" below)
//   any other tab    of the container, the moment the browser reports it: its
//                    own listeners, cancelling everything
//
// Should a browser not select requests by these filters, the guard notices
// (confirmTabless, TabGuard.sawTopFrame) and goes back to one set of listeners
// for every request, which decides by tab and cookie store alone.
//
// In the container:
// - a job tab: policy on every hop of the top frame, private addresses refused
//   for everything it loads (by literal, by DNS answer, by server address).
//   The DNS answer is asked for anew for every request (Guard.hostVerdict): a
//   name that passed once can lead somewhere else the next time;
// - no tab (service worker and the like): the same address rules while a job
//   runs, cancelled while none runs;
// - any other tab: cancelled. Nothing legitimate loads in the container
//   outside a job.
//
// Behind a proxy two of these checks say nothing, and one of them does harm.
// The browser hands a request to the proxy by name: the proxy asks for the
// addresses, wherever it stands, and the address the browser then reports
// for the response is the proxy's own. A lookup by this guard would send
// every host name a job touches to the local resolver as well - past the
// proxy the operator set up - and tell nothing of where the proxy will go;
// and the address check would refuse every response for a proxy on this
// machine or in its network, and look at an address that is not the
// server's for any other. So for a request the browser says it sends to a
// proxy (details.proxyInfo, of any type but "direct") there is no lookup and
// no look at the address that answered. What the text of an address says
// stays as it is, for every request: a private or local address by literal
// or by name, the blocklist, the operator's rule. The log says once per
// session that this is so (guard.proxied, the kind of proxy and nothing
// else), and from then on no name is looked up before a job's tab is made
// either (precheck) - there is no request yet to ask the browser about.
// Whether a public name leads to a private address at the proxy's end is
// then the proxy's to refuse, not this guard's.
//
// A job tab that runs with the operator's own cookie store (login opt-in) is
// guarded like any job tab, by listeners of its own, and by one rule more: its
// top frame stays inside the rule the operator set. A navigation or a redirect
// hop that would leave it is cancelled before it is sent, and ends the job.
// What no request stands behind (a history change, a document made by the
// page) is told to the guard by the job runner and ends the job as well.
// Nothing is registered for that store beyond the tab itself: the operator's
// own tabs on the same site are never heard, and neither are the requests of
// that site's service and shared workers, which no tab stands behind.
//
// One more slice exists while such a job tab is open, and only then: the
// first page of a tab that was made during that time. A page can open a window
// of its own, and the browser says which tab opened it only after the new
// window has begun to load (measured in Firefox 156: its first request was out
// four times of four). So the top-frame request of a tab that is new, in the
// operator's store, and asked for by a document of the site the job is reading
// is held - not cancelled - until the browser has said where the tab came
// from: a tab the job page opened is sealed and its request cancelled, any
// other goes on unchanged. A tab the operator had open before is never held,
// and no request of the operator's is ever cancelled by this.
//
// A tab somebody else makes in the gateway window. Add-ons that keep sites in
// containers of their own (Multi-Account Containers with "always open in",
// Facebook Container, Temporary Containers) answer a navigation by cancelling
// it and opening its address again in a new tab: in their container, with
// whatever the operator is logged in to there, next to the tab they took it
// from. For a job tab that is an address a page or an agent chose, loaded
// with the operator's session, in a tab no listener of this file would hear.
// The gateway makes every tab of its window itself. So a tab the browser
// reports as made there while a job tab is open - in any cookie store - is
// sealed in that moment, before its first request, and reported
// (Stray.foreign) with the job tab whose page it seems to have taken over.
// The window module then says whether the tab is one of the gateway's own
// (the park tab, a job tab that is just being made); if not it is closed, and
// that job ends as REASSIGNED. Not touched by this: any tab in another
// window, a tab that is made in the gateway window while no job tab is open,
// and a tab that is moved into it (the browser does not report that as a new
// tab) - those are the operator moving in, as before.
// What that leaves open, as far as the published source of those add-ons
// reads (none of them was run here): Facebook Container and Temporary
// Containers name the window of the tab they took the address from, so their
// tab appears in the gateway window. Multi-Account Containers names no
// window, and the browser then makes the tab in the window that is in front
// (measured in headless Firefox 156 with a tab made that way through the
// test hook) - the gateway window only while that is the one. In any other
// window the tab is the same as a tab of the operator's to this file, and
// is not heard.
//
// The guard only ever cancels a request. It never rewrites a URL or a request
// header - and no response header either, with the one exception below.
//
// One thing more it may do to the top-level response of a job tab in the
// container: read it. Where that response is a file (capture.js says which),
// and the job may bring a file back, the guard lets the response through with
// a filter on it that takes every byte and passes none on. Nothing else is
// ever filtered: no other tab, no frame, no request without a tab, and no tab
// that runs with the operator's login.
//
// The exception (since 0.1.6). A file the browser would hand
// to its download manager - an attachment, an archive, CSV, bytes of no named
// type - never reaches a filter. For such a response, and only for it, the
// guard answers the browser with other RESPONSE headers: Content-Disposition
// taken out, the Content-Type replaced by one the browser shows as text, and
// nosniff. The browser then gives the response to the tab, where the filter
// takes it; the tab still gets no byte. The server sees nothing different.
// This is done in one place (TabGuard.#read, with the headers that
// capture.relabelForCapture makes) and only when all of this holds, checked
// there once more (TabGuard.#relabelled): a job tab, not a stray; its
// top-level response; the request that was last asked for, answered with 200
// (so: the last hop, never a redirect); the cookie store of the gateway
// container, never the operator's; a job that may bring a file back; a
// declared type that is on the list the daemon sent and is no page type; and
// not a gzip file sent with "Content-Encoding: gzip" on top, which the
// browser would unpack on the way (capture.gzipSentEncoded). It is never
// done to make a page read differently, and nothing of a request is ever
// changed.
//
// Reading the two headers all of this goes by (since 0.1.7). Whether the
// browser shows a response, saves it, or takes it for another type than it
// seems to name is decided by the browser's own reading of Content-Disposition
// and Content-Type, which is not the obvious one: "download" or "x" is an
// attachment to it as much as "attachment" is, and of "text/html,
// application/pdf" - or of two Content-Type headers - it takes the last type.
// isAttachment and mediaType below read the way the browser was measured to
// read, and where a value could be read in more than one way they say so
// (an attachment; no type): such a response is never let through as it is.
//
// And one thing it holds a job tab to: every document of a web address that
// its top frame commits must be one whose response headers passed here. A
// service worker that an earlier page of the site left in the container can
// answer a top-level load itself (measured in Firefox 156: onBeforeRequest
// for the tab, then nothing - no headers event, no end of the request - and
// the document is committed; the same when the worker passes on what it
// fetched). Such a document was never looked at: no status, no type, no file
// rule. The job runner tells the guard of every commit (TabGuard.committed),
// and one that no passed headers and no failed load stand behind ends the
// job at once, as UNGUARDED. A document the browser brings back from its
// history without a request ends it the same way.
//
// A failed load is the one other thing a tab commits under a web address:
// the browser's own error page. The guard knows of it from two sides, and
// either is enough. The end of the request (webRequest.onErrorOccurred),
// which belongs to a request by its id - but is not always told before the
// commit (measured in Firefox 156: of four failed loads, one was told after
// it). And the navigation error the job runner passes on
// (TabGuard.navigationFailed), which comes the same way as the commit and
// always before it, and belongs to a load by its address. A navigation that
// was merely given up for another one (NS_BINDING_ABORTED) has no error page
// and is no failed load.
//
// The browser's own HTTP cache. A top-level load whose address the browser
// has stored is asked for with a condition, and a server that says "304 Not
// Modified" is heard here twice (measured in Firefox 156, pages and files
// alike): once with status 304 and the few headers of that answer, then,
// under the same request id, with the status and the headers of the stored
// response, which is what the tab is given. The first is let through
// without a judgement, the second is judged like any response - a page, a
// file, a refusal. (Until 0.1.5 the first one ended the job as "no
// content": a page or a file that was fetched before could not be fetched
// again.) A 304 that nobody asked for has no second part: measured, the tab
// then commits an empty document or the browser's error page, nothing is
// saved - and the job ends as it did before, "no content". Only a 304 that
// carries a Content-Disposition of its own is still cancelled at once: the
// browser opened a tab for such an answer when it came unasked. (What was
// read under other response headers is not in that cache: the headers the
// guard answers with say "no-store", see capture.relabelForCapture.)

import { REASON, checkUrl, isPrivateAddress, isWithinRule, parseIp } from "../shared/policy.js";
import { LIMITS } from "../shared/protocol.js";
import { KIND, KIND_MESSAGE, classifyRedirect, headerFacts } from "./detect.js";
import { Capture, gzipSentEncoded, inlineKind, planCapture, relabelForCapture } from "./capture.js";
import { typeAllowed } from "../shared/sniff.js";

/** The code of a job that ended because its page tried to leave the operator's rule. */
export const OUT_OF_SCOPE = "redirect_out_of_scope";
/** The code of a job whose tab committed a document that no response the guard saw stands behind. */
export const UNGUARDED = "unguarded_response";
/** The code of a job whose response was being read as a file when the browser told its headers once more. */
export const REPEATED = "response_repeated";
/** The code of a job whose page another add-on opened again in a tab of its own. */
export const REASSIGNED = "reassigned_by_addon";

/**
 * @typedef {object} PolicyOptions
 * @property {readonly string[]} blocklist
 * @property {readonly number[]} allowLoopbackPorts test fixtures only; empty in a release build
 *
 * @typedef {object} Verdict why a job must end
 * @property {"policy_blocked" | "unsupported" | "error" | "blocked"} outcome
 * @property {string} code
 * @property {string} message never contains a URL or a header value; for redirect_out_of_scope it names the origin
 *   (scheme, host and port) the page tried to go to, and nothing more of that address
 * @property {{ kind: string, evidence: string }} [detect] what stood in the way, in the words of detect.js
 * @property {number | null} [retryAfterS] what the site asked for (Retry-After), where the verdict is about that
 *
 * @typedef {object} TabScope the rule a job tab with the operator's own cookie store must stay inside
 * @property {import("../shared/policy.js").OptInRule} rule
 * @property {import("../shared/policy.js").OptInOptions} policy how rules are read (fixture ports of a test build)
 * @property {string} url the URL of the job
 *
 * @typedef {object} NavRecord what was seen on the wire for the top frame
 * @property {string[]} redirectOrigins scheme://host[:port] of every hop that left the previous origin
 * @property {number | null} httpStatus of the last response
 * @property {string | null} contentType media type of the last response, without parameters
 * @property {boolean} cfMitigated the last response carried "cf-mitigated: challenge". Read for the challenge
 *   detection; like every header, never changed
 * @property {number | null} retryAfterS Retry-After of the last response, in seconds
 * @property {string | null} [finalUrl] the address of the last response
 *
 * @typedef {{ allowed: true, host: string, origin: string, exempt: boolean, literal: boolean } | { allowed: false, reason: string, origin: string | null }} HopVerdict
 *   exempt: a loopback fixture URL that passes only because of allowLoopbackPorts
 *   literal: the host is an IP address, there is nothing to resolve
 *
 * @typedef {{ name: string, value?: string }} Header
 *
 * @typedef {object} AttachOptions
 * @property {string} cookieStoreId the only cookie store requests of the tab may use
 * @property {(verdict: Verdict) => void} onVerdict called once, with the first verdict
 * @property {boolean} [stray] no job tab: a tab that must not load anything, sealed from the start
 * @property {TabScope} [scope] the tab runs with the operator's own cookie store: its top frame stays inside this rule
 * @property {import("./capture.js").FilePolicy | null} [files] what the job may bring back when its response is a file; absent
 *   or null: nothing
 * @property {(capture: Capture) => void} [onFile] the top-level response is a file and is being read: called once
 *
 * @typedef {object} Stray a tab that appeared in the gateway container and that no job made
 * @property {number} tabId
 * @property {number | null} windowId
 * @property {number | null} openerTabId
 * @property {boolean} duringJob a job tab was open for loading when it appeared
 * @property {boolean} [ofLoginJob] it was opened by a job tab that runs with the operator's own cookie store
 * @property {boolean} [foreign] not a tab of the container: a tab of any other cookie store that the browser reported
 *   as made in the gateway window while a job tab was open. It may be the gateway's own (the window module knows)
 * @property {number | null} [reopenedFrom] of a foreign tab: the job tab whose top frame had asked for a page a moment
 *   before and had no answer yet - the page such a tab is made for by an add-on that moves sites into containers
 *
 * @typedef {object} GuardDeps
 * @property {Pick<typeof browser.webRequest, "onBeforeRequest" | "onHeadersReceived" | "onAuthRequired" | "onResponseStarted" | "onErrorOccurred"> &
 *   { filterResponseData?: (requestId: string) => import("./capture.js").FilterLike }} webRequest filterResponseData: to read a
 *   response that is a file; a browser without it captures none
 * @property {() => boolean} [pdfViewer] does the browser show PDFs itself (navigator.pdfViewerEnabled)? Absent: taken as no
 * @property {Pick<typeof browser.tabs, "onCreated" | "onRemoved" | "query">} [tabs] to notice tabs that appear in the container
 * @property {Pick<typeof browser.webNavigation, "onCreatedNavigationTarget">} [webNavigation] to notice the tabs a job page opens
 * @property {(host: string) => Promise<{ addresses: string[] }>} resolve browser.dns.resolve
 * @property {PolicyOptions} policy
 * @property {string} extensionBase moz-extension://<uuid>/
 * @property {() => string | null} storeId cookie store of the gateway container, null while it is not known
 * @property {(stray: Stray) => void} [onStray] a tab was sealed; the caller decides whether to close it
 * @property {() => void} [onLoginTab] a job tab was put under guard that runs with the operator's own cookie store
 * @property {(event: string, fields?: Record<string, string | number | boolean | null>) => void} log
 * @property {number} [dnsTimeoutMs]
 *
 * @typedef {"tab" | "tabless" | "window" | "wide" | "login"} Scope which request filter let a request in. login: the
 *   top-frame requests of every tab, heard only while a job tab with the operator's cookie store is open
 * @typedef {{ event: "onBeforeRequest" | "onHeadersReceived" | "onAuthRequired" | "onResponseStarted" | "onErrorOccurred", fn: (details: any) => unknown }} Registered
 *
 * @typedef {object} GuardStats counts only, for the log and the tests
 * @property {boolean} wide true once the guard listens to every request again
 * @property {Record<Scope, number>} calls how often a blocking listener of each kind was called
 * @property {number} outside calls for a request that was neither a guarded tab's nor the container's
 * @property {number} dropped requests cancelled in the container outside a job tab
 * @property {number} held first requests of new tabs that were held until the browser said where the tab came from
 * @property {number} heldCancelled those of them that belonged to a window a job page opened, and were cancelled
 * @property {boolean} running
 * @property {boolean} proxied a request of a job or of the container was seen to go through a proxy, in this session:
 *   for such requests no name is looked up and the address that answered is not looked at
 *
 * @typedef {{ allowed: false } | { allowed: true, host: string | null, exempt: boolean, resolve: boolean }} SubVerdict
 *   host: null for a URL that never leaves the browser (data:, blob:)
 *   exempt: a loopback fixture URL that passes only because of allowLoopbackPorts
 *   resolve: the host is a name whose addresses must be looked at before the request may go out
 *
 * @typedef {object} RequestDetails the part of a webRequest event the guard reads
 * @property {number} tabId
 * @property {string} url
 * @property {string} type
 * @property {string} [requestId]
 * @property {string} [cookieStoreId]
 * @property {number} [statusCode]
 * @property {Header[]} [responseHeaders]
 * @property {string | null} [ip]
 * @property {boolean} [isProxy]
 * @property {{ type?: unknown } | null} [proxyInfo] present when the browser sends the request to a proxy; type: "http",
 *   "https", "socks", "socks4" - or "direct" where a proxy configuration said to use none
 *
 * @typedef {object} StallFacts where a job tab stands whose page does not finish loading, as far as the guard can tell:
 *   counts, times and one of four fixed words - no address, nothing of a request
 * @property {"none" | "asked" | "passed" | "failed"} top_load what the last top-frame request of the tab has come to
 * @property {number} top_requests top-frame requests the tab made
 * @property {number} top_after_commit how many of them came after the tab had committed its first document: a page that
 *   asks for itself again, or goes somewhere else
 * @property {number} top_asked_ms how long ago the last of them was heard; -1: none
 * @property {number} answers_owed requests that wait for an answer of a blocking listener: the tab's own, and those no tab
 *   stands behind (a service worker's, which the page may wait for)
 * @property {boolean} top_answer_owed a top-frame request of the tab is among them
 * @property {number} answer_oldest_ms how long the oldest of them has waited; -1: none waits
 * @property {number} lookups_under_way names whose addresses are being asked for right now
 * @property {number} lookups lookups since the tab was put under guard (those of other job tabs that were open meanwhile included)
 * @property {number} lookups_shared requests that joined a lookup that was under way
 * @property {number} lookups_failed lookups the resolver answered with an error or with no address
 * @property {number} lookups_refused lookups that named a private address
 * @property {number} lookups_deadline lookups the resolver did not answer in time (dnsTimeoutMs); the request was cancelled
 * @property {number} lookup_slowest_ms the longest a lookup took
 * @property {number} cancelled requests of the tab this guard cancelled
 * @property {string} cancelled_most why, for the three most frequent reasons: "word*count" joined by commas, each word
 *   one of CutWord; "" when none was cancelled
 * @property {boolean} file_tried a top-frame response of the tab was a file matter: read as a file, or refused as one
 * @property {boolean} download a download was caught while the tab was open
 *
 * @typedef {"sealed" | "file" | "store" | "local" | "private" | "dns" | "scope" | "policy" | "type" | "frame" | "server" | "auth"} CutWord
 *   why a request of a job tab was cancelled, as a fixed word. sealed: the tab loads nothing any more; file: its response
 *   is being read as a file, or a file was refused; store: another cookie store; local: a private or local address by
 *   its text; private: a name that leads to a private address; dns: a name that did not resolve in time or at all;
 *   scope: outside the operator's rule; policy: any other rule of the URL policy; type: a response that is no page;
 *   frame: a frame that would be saved; server: answered from a private address; auth: a login dialog
 *
 * @typedef {{ asked: number, shared: number, failed: number, refused: number, deadline: number }} LookupCounts
 *
 * @typedef {{ cancel?: true, responseHeaders?: Header[] }} Answer what a listener returns: {} or { cancel: true } -
 *   and, from one place only (TabGuard.#read), the response headers under which a download-type file is read
 */

// The statuses the browser answers by going where Location says. A response with one of them and a Location is
// let through unjudged for that reason alone: its body is never shown and never saved, and where it leads is a
// request of its own that is judged before it is sent (beforeRequest). Without a Location none of them is a
// redirect, and the response is judged as what it is.
//
// 300 is not among them, and must not be. HTTP lets a browser go where the Location of a "300 Multiple Choices"
// says; Firefox does not (measured in Firefox 156, 2026-10-11: the tab showed the body of the 300 as a page, under
// the address that was asked for, and the address in Location was never requested; with "Content-Disposition:
// attachment" the same response is a download). Taken for a redirect here, such a response would pass with
// nobody having looked at its type or its disposition. So a 300 is a response like any other, Location or not.
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const NO_BODY_STATUS = new Set([204, 205, 304]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
// Challenge schemes the browser answers with a login dialog.
const PROMPTING_AUTH = /(^|,)\s*(basic|digest|ntlm|negotiate)\b/i;

/**
 * @param {string} url
 * @returns {string | null} scheme://host[:port], null for anything that is not http(s)
 */
export function originOf(url) {
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
	} catch {
		return null;
	}
}

/**
 * Policy for one navigation or redirect hop of the top frame. Same rules as
 * for the URL an agent asks for, with one difference: a hop may be longer
 * than an agent's URL (redirect targets carry tokens and return addresses).
 * Such a hop is judged by its origin alone, which is what the rules look at
 * anyway.
 * @param {string} url
 * @param {PolicyOptions} policy
 * @returns {HopVerdict}
 */
export function checkHop(url, policy) {
	const origin = originOf(url);
	let verdict = checkUrl(url, policy);
	if (!verdict.allowed && verdict.reason === REASON.URL_TOO_LONG && origin !== null && url.length <= LIMITS.MAX_FINAL_URL) {
		let userinfo = true;
		try {
			const u = new URL(url);
			userinfo = u.username !== "" || u.password !== "";
		} catch {
			// origin !== null means it parsed; stay closed if it somehow did not
		}
		if (userinfo) return { allowed: false, reason: REASON.USERINFO, origin };
		verdict = checkUrl(origin + "/", policy);
	}
	if (!verdict.allowed) return { allowed: false, reason: verdict.reason, origin };
	if (origin === null) return { allowed: false, reason: REASON.INVALID_URL, origin };
	const strict = policy.allowLoopbackPorts.length === 0 ? verdict : checkUrl(origin + "/", { blocklist: policy.blocklist, allowLoopbackPorts: [] });
	return { allowed: true, host: verdict.host, origin, exempt: !strict.allowed, literal: parseIp(verdict.host) !== null };
}

/**
 * Requests a page makes by itself (images, scripts, frames, XHR, WebSockets)
 * and requests of its service worker are checked by host only: nothing may
 * reach a private or local address. The blocklist is for navigations and does
 * not apply here.
 * @param {string} url
 * @param {PolicyOptions} policy
 * @returns {SubVerdict}
 */
export function classifySubresource(url, policy) {
	/** @type {URL} */
	let u;
	try {
		u = new URL(url);
	} catch {
		return { allowed: false };
	}
	/** @type {Record<string, string>} */
	const web = { "http:": "http:", "https:": "https:", "ws:": "http:", "wss:": "https:" };
	const scheme = web[u.protocol];
	// data:, blob: and the like never leave the browser.
	if (scheme === undefined) return { allowed: true, host: null, exempt: false, resolve: false };
	const origin = `${scheme}//${u.host}/`;
	const verdict = checkUrl(origin, { blocklist: [], allowLoopbackPorts: policy.allowLoopbackPorts });
	if (!verdict.allowed) return { allowed: false };
	const exempt = policy.allowLoopbackPorts.length > 0 && !checkUrl(origin, { blocklist: [], allowLoopbackPorts: [] }).allowed;
	// Neither a fixture nor a literal address has anything to resolve.
	return { allowed: true, host: verdict.host, exempt, resolve: !exempt && parseIp(verdict.host) === null };
}

/**
 * @param {readonly Header[]} headers
 * @param {string} name lowercase
 * @returns {string | null} the first value
 */
function header(headers, name) {
	for (const h of headers) {
		if (typeof h.name === "string" && h.name.toLowerCase() === name) return h.value ?? "";
	}
	return null;
}

/**
 * @param {readonly Header[]} headers
 * @param {string} name lowercase
 * @returns {string[]} every value that stands under the name, in the order the browser reports them
 */
function headerValues(headers, name) {
	const out = [];
	for (const h of headers) {
		if (typeof h.name === "string" && h.name.toLowerCase() === name) out.push(h.value ?? "");
	}
	return out;
}

// A media type as a server writes it when nothing is odd about it. No "*", no quote, nothing outside ASCII.
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,60}\/[A-Za-z0-9!#$&^_.+-]{1,120}$/;

/**
 * The media type the browser will take a response for - where its Content-Type says so beyond doubt. The
 * browser does not read that header the way it looks. Measured in headless Firefox 156 (2026-10-06, a tab of
 * the operator's, an HTML document with a script as the body unless said otherwise):
 *
 *   Content-Type                                      the browser                         here
 *   text/html | TEXT/HTML | text/html; charset=utf-8  HTML, script runs                   text/html
 *   "text/html ; charset=x" | "text/html;"            HTML                                text/html
 *   text/html;charset=utf-8;application/pdf           HTML                                text/html
 *   text/html, text/html (also with parameters)       HTML                                text/html
 *   two headers: text/html + text/html                HTML (reported as one value,        text/html
 *                                                       "text/html,text/html")
 *   text/html;,application/pdf                        PDF viewer (the LAST type counts)   null
 *   text/html, application/pdf                        PDF viewer                          null
 *   text/html;,application/zip                        saved as a file                     null
 *   text/html , application/zip                       saved as a file                     null
 *   application/pdf, text/html                        HTML, script runs                   null
 *   application/zip, text/html                        HTML, script runs                   null
 *   text/html, application/json                       JSON viewer                         null
 *   text/html, text/plain                             text document                       null
 *   application/xhtml+xml, application/zip            saved as a file                     null
 *   two headers: text/html + application/pdf          PDF viewer (reported as             null
 *                                                       "text/html,application/pdf")
 *   two headers: application/zip + text/html          HTML, script runs                   null
 *   two headers: text/html + application/zip          saved as a file                     null
 *   text/html, | ,text/html | text/html, garbage |    HTML (what is no type is passed     null
 *     text/html, * / *                                  over)
 *   application/zip, garbage                          saved as a file                     null
 *   text/html; charset="a,application/pdf"            HTML (no split inside "...")        null
 *   text/html; x=",application/pdf                    HTML (an open quote runs to the     null
 *                                                       end)
 *   application/zip; x=",text/html                    saved as a file                     null
 *   text/html; charset='a,application/zip'            saved ('...' is no quoting)         null
 *   text/html application/pdf | text/html<TAB>foo     HTML (the type ends at a blank)     null
 *   ;text/html                                        HTML                                null
 *   text /html | text | html | "" | blanks | * / * |  no type at all: guessed from the    null
 *     no header                                         bytes - HTML here (no header and
 *                                                       a PDF: the PDF viewer)
 *   text/ html                                        a text document of type "text/"     null
 *   text/html/x | text/html+x | text/html<VT>         a text document, no script          null (text/html+x: itself)
 *   /html | "text/html" | x/y                         saved as a file                     null (x/y: itself)
 *
 * (* / * stands for the two characters without the blanks.) So a value with a comma in it names several types, of
 * which the browser takes the last it can read, and two Content-Type headers are such a list. Here a type is
 * only told where every part of the list - split at every comma, also one inside quotes, where browsers differ
 * - is the same plain type; everything else is "no usable type" (null), which is never a page and never a file
 * the browser is trusted to show: it is refused, or read under response headers of the guard's own making.
 * Blanks are the two HTTP knows, and letters are compared as ASCII: "text/html<VT>" is not text/html to the
 * browser, and must not be here.
 * @param {string | null} value a Content-Type header; several of them joined by ","
 * @returns {string | null} lowercase media type without parameters; null: none, or none that is certain
 */
export function mediaType(value) {
	if (value === null) return null;
	/** @type {string | null} */
	let type = null;
	for (const part of value.split(",")) {
		const one = part.split(";")[0].replace(/^[ \t]+|[ \t]+$/g, "");
		if (!MEDIA_TYPE.test(one)) return null;
		const lower = one.toLowerCase();
		if (type !== null && lower !== type) return null;
		type = lower;
	}
	return type;
}

/**
 * @param {readonly Header[]} headers
 * @returns {string | null} the media type of the response (see mediaType), from every Content-Type line it has
 */
export function declaredType(headers) {
	const values = headerValues(headers, "content-type");
	return values.length === 0 ? null : mediaType(values.join(","));
}

/**
 * Does the browser take a Content-Disposition value for an attachment - a response it saves instead of
 * showing? Not by the word "attachment": by everything that is not one of three things. What counts is the
 * disposition type, which is what stands before the first ";" or blank. Measured in headless Firefox 156
 * (2026-10-06, a tab of the operator's; each value with a PDF, an HTML page and JSON, which agreed in every
 * row - "shown" is the PDF viewer, the page with its script run, the JSON viewer):
 *
 *   Content-Disposition                                   the browser    here
 *   no header | "" | blanks                               shown          inline
 *   ; | ; filename="a"                                    shown          inline
 *   inline | INLINE | <TAB>inline                         shown          inline
 *   inline; filename="a" | inline;filename="a"            shown          inline
 *   inline ; filename=a | inline<TAB>; x=y | inline foo   shown          inline
 *   filename="a" | FileName=a | filename | filenamex      shown          inline
 *   attachment | Attachment | ATTACHMENT; filename="a"    saved          attachment
 *   download | x | attach | file                          saved          attachment
 *   foo; filename="a" | form-data; name=x                 saved          attachment
 *   inlinex | inline=1                                    saved          attachment
 *   "inline" | 'inline' | "attachment"                    saved          attachment
 *   inline, attachment | attachment, inline | ,inline     saved          attachment
 *   x inline | : inline | =inline                         saved          attachment
 *   two headers, the same value (inline, attachment)      as one         as one
 *   two headers with different values (inline +           the load       attachment (see
 *     attachment, either order; inline + inline;            fails: the     offeredAsDownload)
 *     filename="a"; "" + attachment)                        browser's
 *                                                           error page,
 *                                                           no headers
 *                                                           are told
 *
 * A saved PDF is opened afterwards from its file, in a new tab. Where in doubt - a character that may or may
 * not be a blank to the browser - the answer here is "attachment": such a response is never let through as it
 * is, so nothing is saved either way.
 * @param {string} value one Content-Disposition header
 * @returns {boolean}
 */
export function isAttachment(value) {
	const token = /^[ \t\r\n]*([^; \t\r\n]*)/.exec(value)?.[1] ?? "";
	return !(token === "" || /^inline$/i.test(token) || /^filename/i.test(token));
}

/**
 * @param {readonly Header[]} headers
 * @returns {boolean} true when the browser would save the response for its Content-Disposition, whatever its type -
 *   or when nobody can say: two Content-Disposition lines that differ are a load the browser gives up (measured, see
 *   isAttachment). Should such a response ever be told here, it is not one to let through as it is.
 */
export function offeredAsDownload(headers) {
	const values = headerValues(headers, "content-disposition");
	return values.some(isAttachment) || new Set(values).size > 1;
}

/**
 * Decide from the response headers of a top-frame load whether the browser
 * would show it as a page. Everything else is refused before the body is
 * handled, so no save dialog, helper application or viewer ever opens.
 * @param {number} status
 * @param {readonly Header[]} headers
 * @returns {{ kind: "page" | "redirect" | "proxy_auth", contentType: string | null }
 *   | { kind: "refuse", outcome: "unsupported" | "error", contentType: string | null, code: string, message: string }}
 */
export function classifyResponse(status, headers) {
	const contentType = declaredType(headers);
	if (REDIRECT_STATUS.has(status) && header(headers, "location") !== null) return { kind: "redirect", contentType };
	// A proxy asking for credentials is the operator's own setup; the browser
	// deals with it. From a web server the browser treats 407 as an error.
	if (status === 407) return { kind: "proxy_auth", contentType };
	if (status === 401 && headerValues(headers, "www-authenticate").some((value) => PROMPTING_AUTH.test(value))) {
		// Refused here, before the browser can open its login dialog.
		return { kind: "refuse", outcome: "error", contentType, code: "auth_required", message: "the page asks for HTTP authentication" };
	}
	if (NO_BODY_STATUS.has(status)) {
		return { kind: "refuse", outcome: "unsupported", contentType, code: "no_content", message: "the server answered without a page" };
	}
	if (offeredAsDownload(headers)) {
		return { kind: "refuse", outcome: "unsupported", contentType, code: "attachment", message: "the server offers a download, not a page" };
	}
	if (contentType === null) {
		// The browser would guess the type from the bytes and may decide to save them.
		return { kind: "refuse", outcome: "unsupported", contentType, code: "content_type_missing", message: "the response has no usable content type" };
	}
	if (HTML_TYPES.has(contentType)) return { kind: "page", contentType };
	if (contentType === "text/plain") {
		// Firefox looks at the bytes of text/plain and saves what does not look like text, unless the server
		// forbids that with "X-Content-Type-Options: nosniff". Measured in headless Firefox 156 (2026-10-07, a tab
		// of the operator's, text/plain with an archive as the body):
		//
		//   X-Content-Type-Options                          the browser    here
		//   nosniff | NoSniff                               shown as text  a page
		//   nosniff, nosniff | nosniff, x | two headers     shown as text  not one (the first word counts there;
		//     (nosniff + x, told as "nosniff, x")                            here only the word alone is taken)
		//   none | sniff | x, nosniff | nosniff x |         saved          not one
		//     nosniff; | nosniff<VT>
		//
		// A Content-Encoding changes nothing about that: the bytes are looked at once they are unpacked. Until
		// 0.1.6 an encoded body was taken for one the browser shows - measured with gzip, br and "identity": an
		// archive under text/plain was saved all the same.
		const nosniff = /^[ \t]*nosniff[ \t]*$/i.test(header(headers, "x-content-type-options") ?? "");
		if (nosniff) return { kind: "page", contentType };
		return { kind: "refuse", outcome: "unsupported", contentType, code: "plain_text_sniffable", message: "plain text without nosniff could be turned into a download" };
	}
	if (contentType === "application/json" || contentType === "text/json" || contentType.endsWith("+json")) {
		return { kind: "refuse", outcome: "unsupported", contentType, code: "content_type_json", message: "JSON responses are not supported yet" };
	}
	if (contentType === "application/xml" || contentType === "text/xml" || contentType.endsWith("+xml")) {
		return { kind: "refuse", outcome: "unsupported", contentType, code: "content_type_xml", message: "XML responses are not supported yet" };
	}
	return { kind: "refuse", outcome: "unsupported", contentType, code: "content_type", message: "the response is not a web page" };
}

/**
 * Response headers of a frame inside the page. Frames are not read, so this is
 * only about what must not happen: a frame is the one way a page can start a
 * download without a click. Whatever the browser would save instead of show
 * is refused; pages, images and the built-in viewers for JSON and XML pass.
 * @param {number} status
 * @param {readonly Header[]} headers
 * @returns {boolean}
 */
export function frameResponseAllowed(status, headers) {
	const r = classifyResponse(status, headers);
	if (r.kind !== "refuse") return true;
	// No body to save; a login challenge is cancelled by the auth listener.
	if (r.code === "no_content" || r.code === "auth_required") return true;
	if (r.code === "content_type_json" || r.code === "content_type_xml") return true;
	if (r.code === "content_type" && r.contentType !== null && r.contentType.startsWith("image/")) return true;
	return false;
}

/** @param {string} reason policy reason code */
function policyMessage(reason) {
	if (reason === REASON.PRIVATE_ADDRESS || reason === REASON.LOCAL_NAME) return "the page leads to a private or local address";
	if (reason === REASON.BLOCKLISTED) return "the page leads to a blocklisted site";
	return "the page leads to a URL that the gateway policy does not allow";
}

/**
 * The verdict on a job tab with the operator's cookie store whose top frame
 * went, or tried to go, outside its rule. A site that sends a logged-out
 * visitor to its login page is said to do so: that is something the operator
 * can act on. Everything else is the page leaving its bounds.
 * @param {string} requestedUrl the URL of the job
 * @param {string} targetUrl where the top frame went or wanted to go
 * @returns {Verdict}
 */
export function scopeVerdict(requestedUrl, targetUrl) {
	const wall = classifyRedirect(requestedUrl, targetUrl);
	if (wall !== null && wall.kind === KIND.LOGIN_WALL) {
		return { outcome: "blocked", code: KIND.LOGIN_WALL, message: KIND_MESSAGE[KIND.LOGIN_WALL], detect: { kind: wall.kind, evidence: wall.evidence } };
	}
	const origin = originOf(targetUrl);
	// Of where it wanted to go, the origin only: a path or a query could carry what the page read.
	const where = origin === null ? "an address that is no web page" : origin.slice(0, 300);
	return { outcome: "policy_blocked", code: OUT_OF_SCOPE, message: `the page tried to leave the part of the site the operator opted in, for ${where}` };
}

/**
 * @param {Verdict} verdict the verdict a top-frame request or response was refused with
 * @returns {CutWord}
 */
function cutWord(verdict) {
	if (verdict.code === "dns_failed") return "dns";
	if (verdict.code === REASON.PRIVATE_ADDRESS || verdict.code === REASON.LOCAL_NAME) return "private";
	if (verdict.code === "container_mismatch") return "store";
	if (verdict.code === OUT_OF_SCOPE || verdict.code === KIND.LOGIN_WALL) return "scope";
	if (verdict.outcome === "policy_blocked" && !verdict.code.startsWith("file_")) return "policy";
	if (verdict.code.startsWith("file_") || verdict.code === REPEATED || verdict.code === "too_large") return "file";
	return "type";
}

/** The browser's error for a load that was given up, by name and by number (Firefox reports "Error code 2152398850"). */
const ABORTED = /NS_BINDING_ABORTED|(?:^|[^0-9])2152398850(?:[^0-9]|$)/;

/** @param {string} url @returns {string} */
function withoutFragment(url) {
	const hash = url.indexOf("#");
	return hash === -1 ? url : url.slice(0, hash);
}

/** The kinds of proxy the browser names, for the log. */
const PROXY_TYPES = Object.freeze(["http", "https", "socks", "socks4"]);

/**
 * @param {RequestDetails} details
 * @returns {string | null} the kind of proxy the browser sends this request to ("other": one it names differently);
 *   null: it goes to the server itself
 */
function proxyOf(details) {
	const info = details.proxyInfo;
	if (typeof info !== "object" || info === null || info.type === "direct") return null;
	return typeof info.type === "string" && PROXY_TYPES.includes(info.type) ? info.type : "other";
}

/** @type {Answer} */
const PASS = Object.freeze({});
/** @type {Answer} */
const CANCEL = Object.freeze({ cancel: true });
// Lookups that are under way at one time and can be shared; a name beyond that many gets a lookup of its own.
const MAX_SHARED_LOOKUPS = 4000;
// Origins of pages and frames remembered per job tab; a page with more frames than this is no page.
const MAX_TAB_ORIGINS = 500;
// How long the first page of a new tab is held while the browser has not said which tab opened it.
const POPUP_VERDICT_MS = 1000;
// How long after the last job tab with the operator's cookie store closed its late pop-ups are still looked for.
const LOGIN_LINGER_MS = 1500;
// Tabs made during such a job that are remembered as new.
const MAX_NEW_TABS = 200;
// How long after a job tab asked for a page a tab that somebody else makes next to it is taken for that page opened
// again. An add-on that does this makes the tab in its answer to the request: within milliseconds.
const REASSIGN_MS = 3000;

/** Guard state of one tab: a job tab, or a tab that must not load anything. */
export class TabGuard {
	#guard;
	#deps;
	#tabId;
	#cookieStoreId;
	#onVerdict;
	/** @type {Verdict | null} */
	#verdict = null;
	#sealed = false;
	#attached = true;
	/** The job of the tab is over, and the tab was still there: see retire(). */
	#retired = false;
	#stray;
	/** @type {TabScope | null} */
	#scope;
	/** @type {import("./capture.js").FilePolicy | null} */
	#files;
	#onFile;
	/** @type {Capture | null} the top-level response that is being read as a file */
	#capture = null;
	/** Top-frame requests heard so far. */
	#topFrames = 0;
	/**
	 * What the last top-frame request of the tab has come to: "asked" - nothing yet; "passed" - its response headers
	 * passed this guard, as a page or as a file that is being read; "failed" - the network ended it, and what the tab
	 * shows for it is the browser's own error page. "none": no request since the last document was committed.
	 * @type {"none" | "asked" | "passed" | "failed"}
	 */
	#topLoad = "none";
	/** @type {string | undefined} the request #topLoad is about */
	#topRequest = undefined;
	/** @type {string | null} its address, without a fragment */
	#topUrl = null;
	/** Documents of a web address the top frame committed, and top-frame requests that came after the first of them. */
	#commits = 0;
	#topAfterCommit = 0;
	/** @type {Map<CutWord, number>} requests of the tab this guard cancelled, by why */
	#cuts = new Map();
	/** A top-frame response was a file matter (capture.planCapture): read as a file, or refused as one. */
	#fileTried = false;
	/** When that request was heard, and as the how-manieth top-frame request of all tabs under guard. */
	#topAskedAt = 0;
	#topAskedSeq = 0;
	/** @type {string | undefined} the top-frame request the server answered with 304: what the browser has stored is still to come */
	#notModified = undefined;
	/** @type {string | null} origin of the previous top-frame request */
	#lastOrigin = null;
	/** @type {LookupCounts} what the guard had counted of lookups when this tab was put under guard */
	#lookupsBefore;
	/** @type {NavRecord} */
	nav = { redirectOrigins: [], httpStatus: null, contentType: null, cfMitigated: false, retryAfterS: null };
	/**
	 * Origins the tab was let load a page or a frame from, and when the first
	 * time. A blob of the tab can only have been made by one of them, and only
	 * after that moment: the downloads backstop goes by both.
	 * @type {Map<string, number>}
	 */
	origins = new Map();
	/** @type {number | null} when the first download of this tab's job was caught */
	downloadAt = null;

	/**
	 * @param {Guard} guard
	 * @param {GuardDeps} deps
	 * @param {number} tabId
	 * @param {AttachOptions} opts
	 */
	constructor(guard, deps, tabId, opts) {
		this.#guard = guard;
		this.#deps = deps;
		this.#tabId = tabId;
		this.#cookieStoreId = opts.cookieStoreId;
		this.#onVerdict = opts.onVerdict;
		this.#stray = opts.stray === true;
		this.#sealed = this.#stray;
		this.#scope = opts.scope ?? null;
		this.#files = this.#stray ? null : (opts.files ?? null);
		this.#onFile = opts.onFile;
		this.#lookupsBefore = guard.lookupCounts();
	}

	/** @returns {Capture | null} the file this tab's top-level response is being read as, if it is one */
	get capture() {
		return this.#capture;
	}

	/** True for a job tab that runs with the operator's own cookie store. */
	get login() {
		return this.#scope !== null;
	}

	/**
	 * The top frame of the tab shows this address, or is on its way to it, and
	 * no request said so: a history change, a document the page made itself.
	 * For a tab that must stay inside a rule this is checked like a request,
	 * except that there is nothing left to cancel: the tab is sealed and the
	 * job is ended.
	 * @param {string} url
	 * @returns {boolean} false when the address lies outside the rule of the tab
	 */
	topFrameAt(url) {
		const scope = this.#scope;
		if (scope === null || isWithinRule(url, scope.rule, scope.policy)) return true;
		this.#sealed = true;
		this.#setVerdict(scopeVerdict(scope.url, url));
		return false;
	}

	get tabId() {
		return this.#tabId;
	}

	/** True for a tab that is no job's: sealed from the start. */
	get stray() {
		return this.#stray;
	}

	/**
	 * True once a request for the top frame of the tab was heard. A page that
	 * loaded without that was not under guard: the listeners of the tab are deaf.
	 */
	get sawTopFrame() {
		return this.#topFrames > 0;
	}

	/** @returns {Verdict | null} */
	get verdict() {
		return this.#verdict;
	}

	/** True while the tab may load things: attached, not sealed, no verdict. */
	get open() {
		return this.#attached && !this.#sealed && this.#verdict === null;
	}

	/** From now on every request of the tab is cancelled. Used between the end of a job and the closing of its tab. */
	seal() {
		this.#sealed = true;
	}

	/**
	 * The job of the tab is over, and the browser did not close the tab (its page asked whether to leave it and
	 * the answer was to stay; the closing took too long). A tab that is open is not left without a guard: it
	 * stays under this one, sealed, and what it was stays known with it - a tab with the operator's login, the
	 * pages it loaded. The guard lets go when the browser says the tab is gone (Guard, tabs.onRemoved).
	 */
	retire() {
		this.#sealed = true;
		this.#retired = true;
	}

	/** True for a job tab that outlived its job. */
	get retired() {
		return this.#retired;
	}

	/** Stop guarding the tab. Call after the tab is closed. */
	detach() {
		if (!this.#attached) return;
		this.#attached = false;
		this.#sealed = true;
		// The tab is gone, or about to be: its filter has nothing more to read.
		this.#capture?.close();
		this.#guard.forget(this);
	}

	/**
	 * @param {RequestDetails} details
	 * @returns {Answer | Promise<Answer>}
	 */
	beforeRequest(details) {
		if (details.url.startsWith(this.#deps.extensionBase)) return PASS;
		if (!this.open) return this.#cut("sealed");
		// A tab whose response is being read as a file shows nothing and asks for nothing more.
		if (this.#capture !== null) return this.#cut("file");
		// Fail closed: nothing leaves this tab with another cookie store.
		if (details.cookieStoreId !== this.#cookieStoreId) {
			return this.#refuse({ outcome: "error", code: "container_mismatch", message: "a request did not use the gateway container" });
		}
		if (details.type !== "main_frame") {
			// Cancelled quietly: the job goes on without that resource.
			const answer = this.#guard.subresource(details.url, (why) => this.#cut(why), this.#guard.proxied(details));
			return answer instanceof Promise ? answer.then((a) => (this.open || a === CANCEL ? a : this.#cut("sealed"))) : answer;
		}
		this.#topFrames += 1;
		if (this.#commits > 0) this.#topAfterCommit += 1;
		// Also for a redirect hop: whatever passed before was not the response of the document to come.
		this.#topLoad = "asked";
		this.#topRequest = details.requestId;
		this.#topUrl = withoutFragment(details.url);
		this.#topAskedAt = Date.now();
		this.#topAskedSeq = this.#guard.countTopFrame();
		this.#notModified = undefined;
		const scope = this.#scope;
		if (scope !== null && !isWithinRule(details.url, scope.rule, scope.policy)) {
			// Cancelled here, before anything is sent: the address it wanted never hears of it.
			this.#recordHop(originOf(details.url));
			return this.#refuse(scopeVerdict(scope.url, details.url));
		}
		const hop = checkHop(details.url, this.#deps.policy);
		this.#recordHop(hop.origin);
		if (!hop.allowed) return this.#refuse({ outcome: "policy_blocked", code: hop.reason, message: policyMessage(hop.reason) });
		// Through a proxy the name is the proxy's to look up (see the top of this file).
		if (hop.exempt || hop.literal || this.#guard.proxied(details)) return PASS;
		// Asked now, for this request: what the name led to a moment ago, or before the tab was made, is not gone by.
		return this.#guard.hostVerdict(hop.host).then((verdict) => {
			if (verdict !== null) return this.#refuse(verdict);
			return this.open ? PASS : this.#cut("sealed");
		});
	}

	/**
	 * @param {RequestDetails} details
	 * @returns {Answer}
	 */
	headersReceived(details) {
		if (details.url.startsWith(this.#deps.extensionBase)) return PASS;
		if (!this.open) return this.#cut("sealed");
		// Firefox reports the server address here too, although its API
		// description lists it only for the later events.
		// Through a proxy that address is the proxy's, and says nothing.
		const privateServer = !this.#guard.proxied(details) && this.#guard.privateServer(details.url, details.ip);
		if (details.type !== "main_frame") {
			if (privateServer) return this.#cut("server");
			if (details.type !== "sub_frame") return PASS;
			if (!frameResponseAllowed(details.statusCode ?? 0, details.responseHeaders ?? [])) return this.#cut("frame");
			this.#loaded(details.url);
			return PASS;
		}
		if (privateServer) {
			return this.#refuse({ outcome: "policy_blocked", code: REASON.PRIVATE_ADDRESS, message: "the server answered from a private address" }, "server");
		}
		// One response per tab is read as a file, and its filter is the tab's last word. Headers that come after
		// (should the browser ever tell them twice for one request: it did not in any case that was tried) are no
		// second file and no page: they would leave the first filter behind with nobody to close it, or put a
		// document into a tab that shows none.
		if (this.#capture !== null) return this.#refuse({ outcome: "error", code: REPEATED, message: "the browser reported the headers of a response a second time while it was being read as a file" });
		const code = details.statusCode;
		const status = typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
		if (status === 304 && this.#awaitStored(details)) return PASS;
		this.#notModified = undefined;
		const cls = classifyResponse(status ?? 0, details.responseHeaders ?? []);
		this.nav.httpStatus = status;
		this.nav.contentType = cls.contentType;
		const facts = headerFacts(details.responseHeaders ?? []);
		this.nav.cfMitigated = facts.cfMitigated;
		this.nav.retryAfterS = facts.retryAfterS;
		this.nav.finalUrl = details.url;
		const plan = planCapture({
			status: status ?? 0,
			headers: details.responseHeaders ?? [],
			cls,
			url: details.url,
			files: this.#files,
			login: this.#scope !== null,
			pdfViewer: this.#deps.pdfViewer?.() === true,
		});
		if (plan !== null) this.#fileTried = true;
		if (plan !== null && "refuse" in plan) return this.#refuse(plan.refuse, "file");
		if (plan !== null) return this.#read(details, plan.capture);
		if (cls.kind === "refuse") return this.#refuse({ outcome: cls.outcome, code: cls.code, message: cls.message });
		if (cls.kind === "page") {
			this.#loaded(details.url);
			this.#passed(details);
		}
		return PASS;
	}

	/**
	 * The server answered the top-frame request with 304 Not Modified: the browser asked with a condition and
	 * goes on with what it has stored, whose headers come here next under the same request id and are judged
	 * then. Nothing is judged now and nothing counts as passed.
	 * @param {RequestDetails} details
	 * @returns {boolean} false: this 304 is refused like any answer without a body
	 */
	#awaitStored(details) {
		const headers = details.responseHeaders ?? [];
		// Measured: for a 304 nobody asked for that names a Content-Disposition, the browser opens a tab.
		if (details.requestId === undefined || header(headers, "content-disposition") !== null) return false;
		const facts = headerFacts(headers);
		this.nav.httpStatus = 304;
		this.nav.contentType = declaredType(headers);
		this.nav.cfMitigated = facts.cfMitigated;
		this.nav.retryAfterS = facts.retryAfterS;
		this.nav.finalUrl = details.url;
		this.#notModified = details.requestId;
		this.#deps.log("guard.not_modified", {});
		return true;
	}

	/**
	 * Nothing stored came after a 304: the server said "not modified" to a request that asked no such thing. What
	 * the tab has for it is an empty document or the browser's error page. The job ends as for any answer
	 * without a body.
	 * @returns {boolean} true when that is what happened to the last top-frame request
	 */
	#nothingStored() {
		if (this.#notModified === undefined || this.#notModified !== this.#topRequest) return false;
		this.#notModified = undefined;
		this.#sealed = true;
		this.#setVerdict({ outcome: "unsupported", code: "no_content", message: "the server answered without a page" });
		return true;
	}

	/**
	 * The response headers of a top-frame request passed: the document the tab commits next is this response.
	 * @param {RequestDetails} details
	 */
	#passed(details) {
		if (details.requestId === this.#topRequest) this.#topLoad = "passed";
	}

	/**
	 * The network ended a top-frame request of the tab without a response.
	 * @param {RequestDetails} details
	 */
	requestFailed(details) {
		if (details.type !== "main_frame" || details.requestId !== this.#topRequest || this.#topLoad !== "asked") return;
		this.#topLoad = "failed";
		this.#nothingStored();
	}

	/**
	 * A navigation of the top frame ended in an error, as the browser's navigation events say. What the tab commits
	 * for it is the browser's error page - unless the navigation was only given up for another one.
	 * @param {string} url the address that failed
	 * @param {unknown} error the browser's word for the error
	 */
	navigationFailed(url, error) {
		if (typeof error === "string" && ABORTED.test(error)) return;
		// The load that failed must be the one that was last asked for; a failure without any request is its own.
		if (this.#topLoad === "none" || (this.#topLoad === "asked" && withoutFragment(url) === this.#topUrl)) {
			const asked = this.#topLoad === "asked";
			this.#topLoad = "failed";
			if (asked) this.#nothingStored();
		}
	}

	/**
	 * The top frame of the tab committed a document. For a web address that must be the response whose headers
	 * passed here, or the browser's error page for a request the network ended. Anything else was answered where
	 * this guard does not hear - by a service worker - or was brought back from the browser's history: the tab is
	 * sealed and the job is ended.
	 * @param {string} url
	 * @returns {boolean} false when the document is one the guard never saw the response of
	 */
	committed(url) {
		if (!/^https?:/i.test(url) || this.#stray) return true;
		this.#commits += 1;
		const load = this.#topLoad;
		this.#topLoad = "none";
		if (load === "passed" || load === "failed") return true;
		if (load === "asked" && this.#nothingStored()) return false;
		this.#sealed = true;
		this.#setVerdict({ outcome: "error", code: UNGUARDED, message: "the page was answered without a response the request guard saw (by a service worker of the site, or from the browser's history)" });
		return false;
	}

	/**
	 * The response headers under which a download-type file is read - if this is the one response they may be
	 * made for. Every condition of the exception (see the top of this file) is checked here, whatever was
	 * checked on the way.
	 * @param {RequestDetails} details
	 * @param {import("./capture.js").CapturePlan} plan
	 * @returns {Header[] | null} null: not for this response
	 */
	#relabelled(details, plan) {
		const files = this.#files;
		const store = this.#deps.storeId();
		// A job tab that may bring a file back, in the gateway container and never with the operator's login.
		if (this.#stray || this.#scope !== null || files === null) return null;
		if (store === null || this.#cookieStoreId !== store || details.cookieStoreId !== store) return null;
		// Its own top-level response: the request that was last asked for, at the end of its redirects.
		if (details.type !== "main_frame" || details.tabId !== this.#tabId) return null;
		if (details.requestId === undefined || details.requestId !== this.#topRequest || details.statusCode !== 200) return null;
		// A file of a type on the daemon's list, read that way because the browser would save it. Never a page.
		if (plan.relabel !== true || HTML_TYPES.has(plan.contentType) || !typeAllowed(plan.contentType, files.types)) return null;
		// Nor a gzip file under a gzip encoding: shown, the browser would unpack what it saves as it came.
		if (gzipSentEncoded(plan.contentType, details.responseHeaders ?? [])) return null;
		return relabelForCapture(details.responseHeaders ?? []);
	}

	/**
	 * Let the response through with a filter on it that keeps its bytes from the tab.
	 * @param {RequestDetails} details
	 * @param {import("./capture.js").CapturePlan} plan
	 * @returns {Answer}
	 */
	#read(details, plan) {
		const files = this.#files;
		const make = this.#deps.webRequest.filterResponseData;
		// Checked where the filter is made, whatever was checked on the way: never a second one.
		if (this.#capture !== null) return this.#refuse({ outcome: "error", code: REPEATED, message: "the browser reported the headers of a response a second time while it was being read as a file" });
		const relabelled = plan.relabel === true ? this.#relabelled(details, plan) : undefined;
		// A response the browser would save is read under other headers or not at all.
		if (relabelled === null) return this.#refuse({ outcome: "unsupported", code: "file_capture_unavailable", message: "the browser offers no way to read the response" });
		/** @type {import("./capture.js").FilterLike | null} */
		let filter = null;
		try {
			if (files !== null && typeof make === "function" && typeof details.requestId === "string") filter = make.call(this.#deps.webRequest, details.requestId);
		} catch {
			filter = null;
		}
		// Without a filter the response is not let through at all: the tab would show it.
		if (filter === null || files === null) return this.#refuse({ outcome: "unsupported", code: "file_capture_unavailable", message: "the browser offers no way to read the response" });
		this.#capture = new Capture({ filter, files, plan });
		// The tab commits a document for it all the same: an empty one.
		this.#passed(details);
		// The kind only: one of a few words of this extension, nothing of the response.
		this.#deps.log("guard.file_capture", relabelled === undefined ? { kind: inlineKind(plan.contentType) } : { kind: inlineKind(plan.contentType) ?? "other", relabelled: true });
		this.#onFile?.(this.#capture);
		// The filter is made; the browser applies the headers when this call has returned (measured: it attaches).
		return relabelled === undefined ? PASS : { responseHeaders: relabelled };
	}

	/** @param {string} url of a page or frame the tab is being let load */
	#loaded(url) {
		const origin = originOf(url);
		if (origin !== null && !this.origins.has(origin) && this.origins.size < MAX_TAB_ORIGINS) this.origins.set(origin, Date.now());
	}

	/**
	 * A server (not a proxy) asks for credentials. The caller cancels the request.
	 * @param {RequestDetails} details
	 */
	authRequired(details) {
		this.#cut("auth");
		if (details.type === "main_frame" && !this.#sealed) {
			this.#setVerdict({ outcome: "error", code: "auth_required", message: "the page asks for HTTP authentication" });
		}
	}

	/** @param {RequestDetails} details */
	responseStarted(details) {
		if (details.type !== "main_frame" || this.#sealed) return;
		// Second look at the address, should it only be known now. The tab
		// is closed by the job as soon as the verdict arrives.
		if (!this.#guard.proxied(details) && this.#guard.privateServer(details.url, details.ip)) {
			this.#setVerdict({ outcome: "policy_blocked", code: REASON.PRIVATE_ADDRESS, message: "the server answered from a private address" });
		}
	}

	/** @param {string | null} origin */
	#recordHop(origin) {
		if (origin === null) return;
		if (this.#lastOrigin !== null && origin !== this.#lastOrigin && this.nav.redirectOrigins.length < LIMITS.MAX_REDIRECTS) {
			this.nav.redirectOrigins.push(origin.slice(0, 300));
		}
		this.#lastOrigin = origin;
	}

	/** @param {Verdict} verdict */
	#setVerdict(verdict) {
		if (this.#verdict !== null) return;
		// Kept first: from here on the tab is not open, whatever becomes of telling anybody.
		this.#verdict = verdict;
		this.#deps.log("guard.verdict", { outcome: verdict.outcome, code: verdict.code });
		try {
			this.#onVerdict(verdict);
		} catch {
			// The job's own business. The request this is about is cancelled all the same.
		}
	}

	/**
	 * @param {number} withinMs
	 * @returns {number} 0, unless the top frame of the tab asked for a page no longer ago than withinMs that has not
	 *   been answered - the request is on its way, or somebody ended it. Then the number of that request among the
	 *   top-frame requests of all tabs under guard: the higher, the later
	 */
	topFrameUnanswered(withinMs) {
		if (this.#stray || (this.#topLoad !== "asked" && this.#topLoad !== "failed")) return 0;
		return Date.now() - this.#topAskedAt <= withinMs ? this.#topAskedSeq : 0;
	}

	/**
	 * Another add-on opened the page of this tab again in a tab of its own (see the top of this file). Nothing
	 * more leaves the tab, and its job ends: what it asked for was not loaded here, and is not loaded there.
	 */
	reassigned() {
		this.#sealed = true;
		this.#setVerdict({ outcome: "error", code: REASSIGNED, message: "another add-on opened the page again in a tab of its own, as container add-ons do for a site that is assigned to a container; that tab was closed, and nothing was read" });
	}

	/**
	 * For a page that does not finish loading in time: where the tab stands. A request the guard has not answered
	 * yet is one the page waits for, and a lookup that is not answered holds its request until the deadline. Read by
	 * the job runner when it gives a navigation up, and written to the log; nothing here changes anything.
	 * @returns {StallFacts}
	 */
	diagnose() {
		return {
			top_load: this.#topLoad,
			top_requests: this.#topFrames,
			top_after_commit: this.#topAfterCommit,
			top_asked_ms: this.#topAskedAt === 0 ? -1 : Date.now() - this.#topAskedAt,
			...this.#guard.owedTo(this.#tabId),
			...this.#guard.lookupsSince(this.#lookupsBefore),
			cancelled: [...this.#cuts.values()].reduce((sum, n) => sum + n, 0),
			cancelled_most: [...this.#cuts]
				.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
				.slice(0, 3)
				.map(([why, n]) => `${why}*${n}`)
				.join(","),
			file_tried: this.#fileTried,
			download: this.downloadAt !== null,
		};
	}

	/**
	 * Cancel a request of the tab, and count why (diagnose).
	 * @param {CutWord} why
	 * @returns {Answer}
	 */
	#cut(why) {
		this.#cuts.set(why, (this.#cuts.get(why) ?? 0) + 1);
		return CANCEL;
	}

	/**
	 * The guard itself failed on a request of this tab (see Guard.#failed): what it cannot judge it does not let
	 * through. Nothing more leaves the tab, and its job ends.
	 */
	failed() {
		this.#sealed = true;
		if (!this.#stray) this.#setVerdict({ outcome: "error", code: "internal_error", message: "the request guard failed while it looked at a request of the page" });
	}

	/**
	 * @param {Verdict} verdict
	 * @param {CutWord} [why] for the count of what was cancelled; told by the verdict where it is not said
	 * @returns {Answer}
	 */
	#refuse(verdict, why = cutWord(verdict)) {
		this.#setVerdict(verdict);
		return this.#cut(why);
	}
}

export class Guard {
	#deps;
	/** @type {Map<number, TabGuard>} job tabs and sealed strays */
	#tabs = new Map();
	/** @type {Map<string, Promise<Verdict | null>>} host -> the lookup that is under way for it. Nothing that was answered is kept */
	#lookups = new Map();
	/** @type {Map<string, Registered[]>} listeners by the slice they were registered for */
	#slices = new Map();
	#started = false;
	/** True once every request is listened to again, as before the listeners were limited to job tabs. */
	#wide = false;
	/** @type {number | null} the gateway window */
	#windowId = null;
	/** @type {Record<Scope, number>} */
	#calls = { tab: 0, tabless: 0, window: 0, wide: 0, login: 0 };
	#outside = 0;
	/** Requests cancelled outside a job, for the log: counted, not listed. */
	#dropped = 0;
	/** @type {{ origins: Map<string, number>, downloadAt: number | null, endedAt: number, login: boolean }[]} job tabs that closed a moment ago */
	#ended = [];
	/** @type {((tab: browser.tabs.Tab) => void) | null} */
	#onTabCreated = null;
	/** @type {((tabId: number) => void) | null} */
	#onTabRemoved = null;
	/** @type {((details: { sourceTabId: number, tabId: number }) => void) | null} */
	#onNavigationTarget = null;
	/** @type {Map<number, number>} job tabs with the operator's cookie store that closed a moment ago -> when */
	#lateLoginTabs = new Map();
	/** @type {Set<number>} tabs outside the container that were made while such a job tab was open */
	#newTabs = new Set();
	/** @type {Map<number, ((answer: Answer) => void)[]>} first requests of new tabs that wait to hear where their tab came from */
	#held = new Map();
	/** @type {ReturnType<typeof setTimeout> | null} */
	#loginLinger = null;
	/** True while a job tab with the operator's cookie store is open, and a moment after: new tabs are noted. */
	#watching = false;
	/** First requests of new tabs that were held, and how many of them were cancelled: counted, for the log and the tests. */
	#heldCount = 0;
	#heldCancelled = 0;
	/** Calls of a listener that ended in an error, and were answered by #failed. */
	#failures = 0;
	/** Top-frame requests of tabs under guard, counted: which of two was asked last is told by that, not by a clock. */
	#topFrames = 0;
	/** @type {LookupCounts} lookups by what became of them, for TabGuard.diagnose */
	#lookupCounts = { asked: 0, shared: 0, failed: 0, refused: 0, deadline: 0 };
	/** The longest a lookup took since a job tab was put under guard while no other was. */
	#lookupSlowestMs = 0;
	/** @type {Set<{ tabId: number, top: boolean, at: number }>} requests that wait for the answer a blocking listener promised */
	#owed = new Set();
	/** @type {string | null} the kind of proxy a request of a job or of the container was first seen to go through; null: none was, in this session */
	#proxy = null;

	/** @param {GuardDeps} deps */
	constructor(deps) {
		// A log that fails must not take a decision with it: every listener says what it found on its way to an answer.
		/** @type {GuardDeps["log"]} */
		const log = (event, fields) => {
			try {
				deps.log(event, fields);
			} catch {
				// not written down; the answer is the same
			}
		};
		this.#deps = { ...deps, log };
	}

	/**
	 * Register the listeners. From here on the gateway container is closed to
	 * everything but job tabs. Safe to call twice.
	 */
	start() {
		if (this.#started) return;
		this.#started = true;
		if (this.#wide) this.#listen("wide", "wide", {});
		else {
			this.#listen("tabless", "tabless", { tabId: -1 });
			if (this.#windowId !== null) this.#listen("window", "window", { windowId: this.#windowId });
			for (const tabId of this.#tabs.keys()) this.#listen("tab", `tab:${tabId}`, { tabId });
		}
		const tabs = this.#deps.tabs;
		if (tabs === undefined) return;
		this.#onTabCreated = (tab) => {
			if (tab.id === undefined || this.#tabs.has(tab.id)) return;
			if (!this.#isContainer(tab.cookieStoreId)) {
				// A tab outside the container is none of the guard's business, with one
				// exception: the tab a job page opened while it runs with the operator's
				// cookie store. It is known by its opener and by nothing else - a tab
				// that merely appears in that store is the operator's.
				// A tab that names its opener is explained there and then. One that does not may be a window
				// the job page opened: its first page waits for the browser's word.
				if (tab.openerTabId !== undefined && this.#popupOfLoginJob(tab.openerTabId, tab.id, tab.windowId ?? null)) return;
				// And one more: a tab that somebody else makes in the gateway window while a job tab is open.
				if (this.#windowId !== null && tab.windowId === this.#windowId && this.#hasJobTab()) this.#foreignTab(tab.id, tab.openerTabId ?? null);
				else if (tab.openerTabId === undefined && this.#watching && this.#newTabs.size < MAX_NEW_TABS) this.#newTabs.add(tab.id);
				return;
			}
			// A job tab is reported here too, before its job claims it with attach().
			const duringJob = this.running;
			this.quarantine(tab.id);
			this.#deps.onStray?.({ tabId: tab.id, windowId: tab.windowId ?? null, openerTabId: tab.openerTabId ?? null, duringJob });
		};
		this.#onTabRemoved = (tabId) => {
			const tab = this.#tabs.get(tabId);
			// A job tab is let go of by its job, when the job has seen it closed; one that outlived its job, here.
			if (tab !== undefined && (tab.stray || tab.retired)) tab.detach();
		};
		tabs.onCreated.addListener(this.#onTabCreated);
		tabs.onRemoved.addListener(this.#onTabRemoved);
		// The browser also says which tab a new tab or window was opened from, where the tab itself does not.
		this.#onNavigationTarget = (details) => {
			this.#popupOfLoginJob(details.sourceTabId, details.tabId, null);
			// Whatever it was: the browser has spoken. Nothing of that tab waits any longer, now or later.
			this.#newTabs.delete(details.tabId);
			this.#release(details.tabId, this.#tabs.has(details.tabId) ? CANCEL : PASS);
		};
		this.#deps.webNavigation?.onCreatedNavigationTarget.addListener(this.#onNavigationTarget);
		this.rescan().catch(() => {});
	}

	/**
	 * A tab was opened from another tab. If that other tab is a job tab with
	 * the operator's cookie store, the new one is sealed at once - nothing is
	 * loaded in it - and reported, to be closed.
	 * @param {number} openerTabId
	 * @param {number} tabId
	 * @param {number | null} windowId
	 * @returns {boolean} true when the tab was sealed for it
	 */
	#popupOfLoginJob(openerTabId, tabId, windowId) {
		const opener = this.#tabs.get(openerTabId);
		const fromLoginJob = opener === undefined ? this.#lateLoginTabs.has(openerTabId) : !opener.stray && opener.login;
		if (!fromLoginJob || this.#tabs.has(tabId)) return false;
		this.quarantine(tabId);
		this.#release(tabId, CANCEL);
		this.#deps.log("guard.login_popup_sealed", {});
		this.#deps.onStray?.({ tabId, windowId, openerTabId, duringJob: true, ofLoginJob: true });
		return true;
	}

	/**
	 * A tab of another cookie store than the container's was made in the gateway window while a job tab is open
	 * (see the top of this file). Sealed here and now, before it asks for anything, and reported: whether it is
	 * the gateway's own is not known in this moment - the window module may be making that very tab.
	 * @param {number} tabId
	 * @param {number | null} openerTabId
	 */
	#foreignTab(tabId, openerTabId) {
		/** @type {number | null} */
		let reopenedFrom = null;
		let latest = 0;
		for (const [id, tab] of this.#tabs) {
			const asked = tab.topFrameUnanswered(REASSIGN_MS);
			if (asked > latest) [reopenedFrom, latest] = [id, asked];
		}
		this.quarantine(tabId);
		this.#release(tabId, CANCEL);
		// Counted by its kind only: nothing of the tab is written down.
		this.#deps.log("guard.foreign_tab_sealed", { took_over: reopenedFrom !== null });
		this.#deps.onStray?.({ tabId, windowId: this.#windowId, openerTabId, duringJob: true, foreign: true, reopenedFrom });
	}

	/** @returns {number} the number of a top-frame request that a tab under guard has just heard */
	countTopFrame() {
		this.#topFrames += 1;
		return this.#topFrames;
	}

	/**
	 * The window module's word on a tab that was reported as foreign: nobody of the gateway made it. The job tab
	 * whose page it took over is sealed, and its job ends.
	 * @param {number} tabId the job tab (Stray.reopenedFrom)
	 */
	reassigned(tabId) {
		const tab = this.#tabs.get(tabId);
		if (tab !== undefined && !tab.stray) tab.reassigned();
	}

	/**
	 * Take the seal off a tab that was sealed for appearing and turned out to be the gateway's own (the park
	 * tab). Never a job tab's guard: that goes with its job.
	 * @param {number} tabId
	 */
	release(tabId) {
		const tab = this.#tabs.get(tabId);
		if (tab !== undefined && tab.stray) tab.detach();
	}

	/**
	 * @param {number} tabId
	 * @param {Answer} answer for every request of that tab that is being held
	 */
	#release(tabId, answer) {
		const waiting = this.#held.get(tabId);
		if (waiting === undefined) return;
		this.#held.delete(tabId);
		if (answer === CANCEL) this.#heldCancelled += waiting.length;
		for (const resolve of waiting) resolve(answer);
	}

	/**
	 * The top-frame request of a tab, heard while a job tab with the operator's
	 * cookie store is open. Cancelled when the tab is one the job page opened;
	 * held when it may be, and the browser has not said yet; everything else
	 * passes at once.
	 * @param {RequestDetails & { originUrl?: string }} details
	 * @returns {Answer | Promise<Answer>}
	 */
	#firstPage(details) {
		const known = this.#tabs.get(details.tabId);
		// A tab that was sealed a moment ago: its own listeners may be too new to hear a request that is
		// already on its way (measured in Firefox 156: a listener added two milliseconds before was not asked).
		// This one has been there since the job began.
		if (known !== undefined) return known.stray ? CANCEL : PASS;
		if (details.tabId === -1 || !this.#newTabs.has(details.tabId) || this.#isContainer(details.cookieStoreId)) return PASS;
		const from = typeof details.originUrl === "string" ? originOf(details.originUrl) : null;
		if (from === null || !this.#loginOrigin(from)) return PASS;
		this.#heldCount += 1;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				// The browser never said: not taken for the job's.
				this.#deps.log("guard.new_tab_unexplained", {});
				this.#release(details.tabId, this.#tabs.has(details.tabId) ? CANCEL : PASS);
			}, POPUP_VERDICT_MS);
			const waiting = this.#held.get(details.tabId) ?? [];
			waiting.push((answer) => {
				clearTimeout(timer);
				resolve(answer);
			});
			this.#held.set(details.tabId, waiting);
		});
	}

	/**
	 * @param {string} origin
	 * @returns {boolean} true when a job tab with the operator's cookie store that is open, or closed a moment ago, loaded a page from it
	 */
	#loginOrigin(origin) {
		for (const tab of this.#tabs.values()) {
			if (!tab.stray && tab.login && tab.origins.has(origin)) return true;
		}
		const now = Date.now();
		return this.#ended.some((job) => job.login && now - job.endedAt < LOGIN_LINGER_MS && job.origins.has(origin));
	}

	/** A job tab with the operator's cookie store is open: hear the first page of every tab that is made meanwhile. */
	#watchNewTabs() {
		if (this.#loginLinger !== null) clearTimeout(this.#loginLinger);
		this.#loginLinger = null;
		this.#watching = true;
		if (!this.#started || this.#wide || this.#slices.has("login")) return;
		const onFirstPage = this.#failClosed("login", (details) => {
			this.#calls.login += 1;
			return this.#firstPage(details);
		});
		this.#deps.webRequest.onBeforeRequest.addListener(/** @type {any} */ (onFirstPage), { urls: ["<all_urls>"], types: ["main_frame"] }, ["blocking"]);
		this.#slices.set("login", [{ event: "onBeforeRequest", fn: onFirstPage }]);
	}

	/** The last such job tab closed: a moment more for a window it opened in its last instant, then nothing is heard. */
	#unwatchNewTabs() {
		if (this.#loginLinger !== null) clearTimeout(this.#loginLinger);
		this.#loginLinger = setTimeout(() => {
			this.#loginLinger = null;
			for (const tab of this.#tabs.values()) {
				if (!tab.stray && tab.login) return;
			}
			this.#watching = false;
			this.#unlisten("login");
			this.#newTabs.clear();
			this.#lateLoginTabs.clear();
			for (const tabId of [...this.#held.keys()]) this.#release(tabId, PASS);
		}, LOGIN_LINGER_MS);
	}

	/** Remove the listeners again. Nothing in the extension does: the guard is there for as long as the background page is. For tests, which end their timers with it. */
	stop() {
		for (const key of [...this.#slices.keys()]) this.#unlisten(key);
		const tabs = this.#deps.tabs;
		if (tabs !== undefined) {
			if (this.#onTabCreated !== null) tabs.onCreated.removeListener(this.#onTabCreated);
			if (this.#onTabRemoved !== null) tabs.onRemoved.removeListener(this.#onTabRemoved);
		}
		if (this.#onNavigationTarget !== null) this.#deps.webNavigation?.onCreatedNavigationTarget.removeListener(this.#onNavigationTarget);
		this.#onTabCreated = null;
		this.#onTabRemoved = null;
		this.#onNavigationTarget = null;
		if (this.#loginLinger !== null) clearTimeout(this.#loginLinger);
		this.#loginLinger = null;
		this.#watching = false;
		for (const tabId of [...this.#held.keys()]) this.#release(tabId, PASS);
		this.#started = false;
	}

	/**
	 * Seal every tab that is open in the container and is no job tab. Called
	 * at the start and whenever the container becomes known.
	 */
	async rescan() {
		const tabs = this.#deps.tabs;
		const storeId = this.#deps.storeId();
		if (!this.#started || tabs === undefined || storeId === null) return;
		for (const tab of await tabs.query({ cookieStoreId: storeId })) {
			if (tab.id !== undefined && !this.#tabs.has(tab.id) && this.#isContainer(tab.cookieStoreId)) this.quarantine(tab.id);
		}
	}

	/**
	 * The gateway window changed. A tab that appears in it in the container's
	 * store is cancelled by a listener that is there before the tab is.
	 * @param {number | null} windowId
	 */
	watchWindow(windowId) {
		if (windowId === this.#windowId) return;
		this.#windowId = windowId;
		if (!this.#started || this.#wide) return;
		this.#unlisten("window");
		if (windowId !== null) this.#listen("window", "window", { windowId });
	}

	/**
	 * Listen to every request again, as before the listeners were narrowed.
	 * The way back when a request filter turns out not to select what it should.
	 * @param {string} reason for the log
	 */
	widen(reason) {
		if (this.#wide) return;
		this.#wide = true;
		this.#deps.log("guard.widened", { reason });
		if (!this.#started) return;
		// The wide set first: at no moment is a slice without a listener.
		this.#listen("wide", "wide", {});
		for (const key of [...this.#slices.keys()]) {
			if (key !== "wide") this.#unlisten(key);
		}
	}

	/**
	 * Call when a request without a tab is known to have been made since
	 * start() (this extension's own dial to the daemon is one). If the listener
	 * for tab-less requests has not heard a single one, the filter does not
	 * work in this browser.
	 * @returns {boolean} true when the tab-less listener is known to hear
	 */
	confirmTabless() {
		if (this.#wide) return false;
		if (this.#calls.tabless > 0) return true;
		this.widen("tabless_filter_deaf");
		return false;
	}

	/** @returns {GuardStats} */
	get stats() {
		return { wide: this.#wide, calls: { ...this.#calls }, outside: this.#outside, dropped: this.#dropped, held: this.#heldCount, heldCancelled: this.#heldCancelled, running: this.running, proxied: this.#proxy !== null };
	}

	/** How many requests were cancelled in the container outside a job tab, so far. */
	get dropped() {
		return this.#dropped;
	}

	/**
	 * What a download can be told to be a job's by when the cookie store the
	 * browser reports for it is not enough: the origins the job tabs loaded pages
	 * and frames from, each with the moment it was first loaded. Covers the job
	 * tabs that are open and those that closed less than graceMs ago - a download
	 * can surface a moment after its tab.
	 * @param {number} graceMs
	 * @returns {import("./downloads.js").JobTraces}
	 */
	jobTraces(graceMs) {
		const now = Date.now();
		this.#ended = this.#ended.filter((job) => now - job.endedAt < Math.max(graceMs, 0));
		/** @type {Map<string, number>} */
		const origins = new Map();
		/** @type {Map<string, number>} */
		const loginOrigins = new Map();
		/** @type {number | null} */
		let caughtAt = null;
		/** @type {number | null} */
		let loginSince = null;
		let active = false;
		const live = [...this.#tabs.values()].filter((tab) => !tab.stray);
		for (const job of [...live, ...this.#ended]) {
			active = true;
			for (const [origin, at] of job.origins) {
				origins.set(origin, Math.min(at, origins.get(origin) ?? at));
				if (!job.login) continue;
				loginOrigins.set(origin, Math.min(at, loginOrigins.get(origin) ?? at));
				if (loginSince === null || at < loginSince) loginSince = at;
			}
			if (job.downloadAt !== null && (caughtAt === null || job.downloadAt < caughtAt)) caughtAt = job.downloadAt;
		}
		return { active, origins, caughtAt, loginOrigins, loginSince };
	}

	/**
	 * @param {number} graceMs
	 * @returns {boolean} true while a job tab with the operator's own cookie store is open, and for graceMs after
	 */
	loginActive(graceMs) {
		const now = Date.now();
		for (const tab of this.#tabs.values()) {
			if (!tab.stray && tab.login) return true;
		}
		return this.#ended.some((job) => job.login && now - job.endedAt < Math.max(graceMs, 0));
	}

	/** A download was caught that is a job's: remembered with the job tabs that are open. */
	noteDownload() {
		const now = Date.now();
		for (const tab of this.#tabs.values()) {
			if (!tab.stray && tab.downloadAt === null) tab.downloadAt = now;
		}
		for (const job of this.#ended) job.downloadAt ??= now;
	}

	/** True while a job tab is open for loading: "a job runs". */
	get running() {
		for (const tab of this.#tabs.values()) {
			if (tab.open) return true;
		}
		return false;
	}

	/**
	 * Does the browser send this request to a proxy? Asked for requests of a job tab and of the container only,
	 * and the first time the answer is yes the log says so: from then on those requests are judged by what their
	 * addresses say, without a lookup and without a look at the address that answered (see the top of this file).
	 * @param {RequestDetails} details
	 * @returns {boolean}
	 */
	proxied(details) {
		const type = proxyOf(details);
		if (type === null) return false;
		if (this.#proxy === null) {
			this.#proxy = type;
			// The kind of proxy, one of five words. Not its address, and nothing of the request.
			this.#deps.log("guard.proxied", { type });
		}
		return true;
	}

	/**
	 * Resolve a host name the way the browser will and refuse it when any of
	 * its addresses is private. Fails closed when the name cannot be resolved.
	 * @param {string} host
	 * @returns {Promise<Verdict | null>} null: fine
	 */
	async checkHost(host) {
		/** @type {string[]} */
		let addresses;
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let timer;
		// Counted by what becomes of it, and timed (TabGuard.diagnose): a lookup holds the request it is for.
		const counts = this.#lookupCounts;
		const began = Date.now();
		let late = false;
		counts.asked += 1;
		try {
			const record = await Promise.race([
				this.#deps.resolve(host),
				new Promise((_resolve, reject) => {
					timer = setTimeout(() => {
						late = true;
						reject(new Error("dns timeout"));
					}, this.#deps.dnsTimeoutMs ?? 10000);
				}),
			]);
			addresses = /** @type {{ addresses: string[] }} */ (record).addresses;
		} catch {
			if (late) {
				counts.deadline += 1;
				// The first one and then every twentieth: each of them held its requests for the whole deadline.
				if (counts.deadline % 20 === 1) this.#deps.log("guard.lookup_deadline", { count: counts.deadline });
			} else counts.failed += 1;
			return { outcome: "error", code: "dns_failed", message: "the host name could not be resolved" };
		} finally {
			clearTimeout(timer);
			this.#lookupSlowestMs = Math.max(this.#lookupSlowestMs, Date.now() - began);
		}
		if (!Array.isArray(addresses) || addresses.length === 0) {
			counts.failed += 1;
			return { outcome: "error", code: "dns_failed", message: "the host name could not be resolved" };
		}
		if (addresses.some((address) => isPrivateAddress(address))) {
			counts.refused += 1;
			return { outcome: "policy_blocked", code: REASON.PRIVATE_ADDRESS, message: "the host name resolves to a private address" };
		}
		return null;
	}

	/** @returns {LookupCounts} a copy of what was counted of lookups so far */
	lookupCounts() {
		return { ...this.#lookupCounts };
	}

	/**
	 * @param {LookupCounts} before
	 * @returns {Pick<StallFacts, "lookups_under_way" | "lookups" | "lookups_shared" | "lookups_failed" | "lookups_refused" | "lookups_deadline" | "lookup_slowest_ms">}
	 */
	lookupsSince(before) {
		const now = this.#lookupCounts;
		return {
			lookups_under_way: this.#lookups.size,
			lookups: now.asked - before.asked,
			lookups_shared: now.shared - before.shared,
			lookups_failed: now.failed - before.failed,
			lookups_refused: now.refused - before.refused,
			lookups_deadline: now.deadline - before.deadline,
			lookup_slowest_ms: this.#lookupSlowestMs,
		};
	}

	/**
	 * @param {number} tabId
	 * @returns {Pick<StallFacts, "answers_owed" | "top_answer_owed" | "answer_oldest_ms">} the requests of that tab, and those
	 *   without a tab, that wait for an answer a blocking listener promised
	 */
	owedTo(tabId) {
		let count = 0;
		let top = false;
		let oldest = Infinity;
		for (const owed of this.#owed) {
			if (owed.tabId !== tabId && owed.tabId !== -1) continue;
			count += 1;
			top = top || (owed.top && owed.tabId === tabId);
			oldest = Math.min(oldest, owed.at);
		}
		return { answers_owed: count, top_answer_owed: top, answer_oldest_ms: count === 0 ? -1 : Date.now() - oldest };
	}

	/**
	 * checkHost for a request that is about to be sent. No answer is remembered, a good one as little as a bad
	 * one: where a name leads can change between two requests, and whoever runs its name server decides when (a
	 * public address for the first question, a private one from then on). So every request asks. The browser
	 * answers a name it knows without the network (measured in headless Firefox 156: 300 questions for one name
	 * took 0.1 to 0.6 s one after the other, and 0.05 s at once). Only requests that ask for the same name while a
	 * lookup for it is under way share that lookup - a page asks for its resources in bursts, and a burst costs
	 * one question per name.
	 *
	 * What this cannot do: the browser resolves the name once more when it connects, and nothing ties that answer
	 * to this one. The address that answered is looked at again when the response headers arrive (privateServer).
	 * @param {string} host
	 * @returns {Promise<Verdict | null>} null: fine
	 */
	hostVerdict(host) {
		const underWay = this.#lookups.get(host);
		if (underWay !== undefined) {
			this.#lookupCounts.shared += 1;
			return underWay;
		}
		/** @type {Promise<Verdict | null>} */
		const lookup = this.checkHost(host).finally(() => {
			if (this.#lookups.get(host) === lookup) this.#lookups.delete(host);
		});
		if (this.#lookups.size < MAX_SHARED_LOOKUPS) this.#lookups.set(host, lookup);
		return lookup;
	}

	/**
	 * The address rules for anything that is not a top-frame navigation.
	 * @param {string} url
	 * @param {(why: "local" | "private" | "dns") => void} [cut] told why, when the answer is a cancel
	 * @param {boolean} [proxied] the browser sends the request to a proxy: the name is not looked up here
	 * @returns {Answer | Promise<Answer>}
	 */
	subresource(url, cut, proxied = false) {
		const sub = classifySubresource(url, this.#deps.policy);
		if (!sub.allowed) {
			cut?.("local");
			return CANCEL;
		}
		if (!sub.resolve || sub.host === null || proxied) return PASS;
		return this.hostVerdict(sub.host).then((verdict) => {
			if (verdict === null) return PASS;
			cut?.(verdict.code === "dns_failed" ? "dns" : "private");
			return CANCEL;
		});
	}

	/**
	 * @param {string} url
	 * @param {string | null | undefined} ip the address that answered
	 * @returns {boolean} true when a response came from a private address it had no business coming from
	 */
	privateServer(url, ip) {
		if (typeof ip !== "string" || ip === "" || !isPrivateAddress(ip)) return false;
		// The one exception: a loopback fixture that passes only because of allowLoopbackPorts.
		const sub = classifySubresource(url, this.#deps.policy);
		return !(sub.allowed && sub.exempt);
	}

	/**
	 * Check a URL before anything is loaded: policy first, then the addresses
	 * behind its host name. This spares a tab for an address that is refused; it
	 * vouches for nothing later. The request guard asks again when the tab's
	 * first request is about to be sent, and for every request after it.
	 * @param {string} url
	 * @returns {Promise<{ verdict: Verdict | null }>}
	 */
	async precheck(url) {
		const hop = checkHop(url, this.#deps.policy);
		if (!hop.allowed) return { verdict: { outcome: "policy_blocked", code: hop.reason, message: "the URL is not allowed by the gateway policy" } };
		// Requests of this session go through a proxy: no name is sent to the local resolver for a job that has not
		// made a request yet. The policy above is all that is asked before the tab is made.
		if (hop.exempt || hop.literal || this.#proxy !== null) return { verdict: null };
		return { verdict: await this.checkHost(hop.host) };
	}

	/**
	 * Put a job tab under guard. Do this before the tab loads anything.
	 * @param {number} tabId
	 * @param {AttachOptions} opts
	 * @returns {TabGuard}
	 */
	attach(tabId, opts) {
		const before = this.#tabs.get(tabId);
		// The slowest lookup is that of the job tabs that are open: with none, it starts over.
		if (opts.stray !== true && !this.#hasJobTab()) this.#lookupSlowestMs = 0;
		const tab = new TabGuard(this, this.#deps, tabId, opts);
		// The listeners of the tab look its guard up when they are called: they
		// stay as they are when one guard takes over from another.
		this.#tabs.set(tabId, tab);
		before?.detach();
		if (this.#started && !this.#wide && !this.#slices.has(`tab:${tabId}`)) this.#listen("tab", `tab:${tabId}`, { tabId });
		if (opts.scope !== undefined && opts.stray !== true) {
			this.#watchNewTabs();
			this.#deps.onLoginTab?.();
		}
		return tab;
	}

	/**
	 * A tab that is in the container without being a job tab: nothing may
	 * load in it. It stays sealed until it is closed or a job claims it.
	 * @param {number} tabId
	 * @returns {TabGuard}
	 */
	quarantine(tabId) {
		return this.#tabs.get(tabId) ?? this.attach(tabId, { cookieStoreId: "", onVerdict: () => {}, stray: true });
	}

	/**
	 * Called by a TabGuard that is detached.
	 * @param {TabGuard} tab
	 */
	forget(tab) {
		if (this.#tabs.get(tab.tabId) === tab) {
			this.#tabs.delete(tab.tabId);
			this.#unlisten(`tab:${tab.tabId}`);
		}
		if (!tab.stray && tab.login) {
			this.#lateLoginTabs.set(tab.tabId, Date.now());
			this.#unwatchNewTabs();
		}
		if (!tab.stray && tab.origins.size > 0) {
			this.#ended.push({ origins: tab.origins, downloadAt: tab.downloadAt, endedAt: Date.now(), login: tab.login });
			if (this.#ended.length > 8) this.#ended.shift();
		}
	}

	/** @returns {boolean} true while a job tab is under guard: one whose job runs or waits for the operator, or one that outlived its job */
	#hasJobTab() {
		for (const tab of this.#tabs.values()) {
			if (!tab.stray) return true;
		}
		return false;
	}

	/** @param {unknown} cookieStoreId */
	#isContainer(cookieStoreId) {
		const storeId = this.#deps.storeId();
		return storeId !== null && cookieStoreId === storeId;
	}

	/**
	 * Register the listeners for one slice of the browser's requests.
	 * @param {Scope} scope
	 * @param {string} key
	 * @param {{ tabId?: number, windowId?: number }} only what the request filter narrows the slice to
	 */
	#listen(scope, key, only) {
		if (this.#slices.has(key)) return;
		const wr = this.#deps.webRequest;
		/** @type {browser.webRequest.RequestFilter} */
		const all = { urls: ["<all_urls>"], ...only };
		/** @type {browser.webRequest.RequestFilter} */
		const frames = { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"], ...only };

		const onBeforeRequest = this.#failClosed(scope, (details) => {
			this.#calls[scope] += 1;
			const tab = this.#tabs.get(details.tabId);
			if (tab !== undefined) {
				// A guarded tab in the gateway window is heard twice: its own listeners decide. Not for a tab that is
				// sealed, though: its listeners may be a moment too new for a request that is already on its way
				// (see #firstPage), and this one was there before the tab was.
				return scope === "window" && !tab.stray ? PASS : tab.beforeRequest(details);
			}
			if (!this.#isContainer(details.cookieStoreId)) {
				// Listening to everything: the first page of a window a job page opened is looked for here as well.
				if (scope === "wide" && details.type === "main_frame" && this.#newTabs.has(details.tabId)) return this.#firstPage(details);
				return this.#notOurs();
			}
			if (details.url.startsWith(this.#deps.extensionBase)) return PASS;
			// A tab of the container that is not a job tab, or nothing running at all.
			if (details.tabId !== -1 || !this.running) return this.#drop();
			// No tab behind it (a service worker): the address rules of the running job.
			const answer = this.subresource(details.url, undefined, this.proxied(details));
			return answer instanceof Promise ? answer.then((a) => (this.running ? a : CANCEL)) : answer;
		});
		wr.onBeforeRequest.addListener(/** @type {any} */ (onBeforeRequest), all, ["blocking"]);
		/** @type {Registered[]} */
		const listeners = [{ event: "onBeforeRequest", fn: onBeforeRequest }];
		this.#slices.set(key, listeners);
		// Whatever this slice is for is cancelled before it is sent: nothing more to hear.
		if (scope === "window") return;

		// Frames get their headers looked at; this listener is the only one that asks for them.
		const onFrameHeaders = this.#failClosed(scope, (details) => {
			this.#calls[scope] += 1;
			const tab = this.#tabs.get(details.tabId);
			if (tab !== undefined) return tab.headersReceived(details);
			return this.#outsideJob(details);
		});

		// Everything else is only checked for the address that answered.
		const onOtherHeaders = this.#failClosed(scope, (details) => {
			this.#calls[scope] += 1;
			if (details.type === "main_frame" || details.type === "sub_frame") return PASS;
			const tab = this.#tabs.get(details.tabId);
			if (tab !== undefined) return tab.headersReceived(details);
			return this.#outsideJob(details);
		});

		const onAuthRequired = this.#failClosed(scope, (details) => {
			this.#calls[scope] += 1;
			const tab = this.#tabs.get(details.tabId);
			if (tab === undefined && !this.#isContainer(details.cookieStoreId)) return this.#notOurs();
			// A proxy asking for credentials is the operator's own setup.
			if (details.isProxy) return PASS;
			if (tab !== undefined) tab.authRequired(details);
			// Cancelled for every resource type: no login dialog may open.
			return CANCEL;
		});

		// Answers nothing: the request is on its way. What it finds ends the job.
		const onResponseStarted = this.#unanswered(scope, (details) => {
			const tab = this.#tabs.get(details.tabId);
			if (tab !== undefined) return tab.responseStarted(details);
			if (this.#isContainer(details.cookieStoreId) && !this.proxied(details) && this.privateServer(details.url, details.ip)) this.#deps.log("guard.private_response", {});
		});

		wr.onHeadersReceived.addListener(/** @type {any} */ (onFrameHeaders), frames, ["blocking", "responseHeaders"]);
		wr.onHeadersReceived.addListener(/** @type {any} */ (onOtherHeaders), all, ["blocking"]);
		wr.onAuthRequired.addListener(/** @type {any} */ (onAuthRequired), all, ["blocking"]);
		wr.onResponseStarted.addListener(/** @type {any} */ (onResponseStarted), all);
		listeners.push(
			{ event: "onHeadersReceived", fn: onFrameHeaders },
			{ event: "onHeadersReceived", fn: onOtherHeaders },
			{ event: "onAuthRequired", fn: onAuthRequired },
			{ event: "onResponseStarted", fn: onResponseStarted },
		);
		// Only a tab has a top frame whose load can fail.
		if (scope === "tabless") return;

		// A top-frame request that the network ended: what the tab shows next is the browser's error page.
		const onErrorOccurred = this.#unanswered(scope, (details) => {
			this.#tabs.get(details.tabId)?.requestFailed(details);
		});
		wr.onErrorOccurred.addListener(/** @type {any} */ (onErrorOccurred), { urls: ["<all_urls>"], types: ["main_frame"], ...only });
		listeners.push({ event: "onErrorOccurred", fn: onErrorOccurred });
	}

	/**
	 * A blocking listener that cannot fail open. The browser goes on with a request whose listener threw, or
	 * whose promise was rejected, as if nobody had objected. So whatever goes wrong in a listener is answered
	 * here: with a cancel for a request of a guarded tab or of the gateway container, with "no objection" for
	 * every other - nothing of the operator's is cancelled because this extension failed.
	 * @param {Scope} scope
	 * @param {(details: RequestDetails & { originUrl?: string }) => Answer | Promise<Answer>} decide
	 * @returns {(details: RequestDetails) => Answer | Promise<Answer>}
	 */
	#failClosed(scope, decide) {
		return (details) => {
			try {
				const answer = decide(details);
				if (!(answer instanceof Promise)) return answer;
				// Noted for as long as it is owed (TabGuard.diagnose): the request waits for it.
				const owed = { tabId: details.tabId, top: details.type === "main_frame", at: Date.now() };
				this.#owed.add(owed);
				return answer
					.catch(() => this.#failed(scope, details))
					.finally(() => {
						this.#owed.delete(owed);
					});
			} catch {
				return this.#failed(scope, details);
			}
		};
	}

	/**
	 * A listener that answers nothing (the request cannot be stopped any more), kept from throwing all the same.
	 * @param {Scope} scope
	 * @param {(details: RequestDetails) => void} hear
	 * @returns {(details: RequestDetails) => void}
	 */
	#unanswered(scope, hear) {
		return (details) => {
			try {
				hear(details);
			} catch {
				this.#failed(scope, details);
			}
		};
	}

	/**
	 * A listener failed on this request. Whose it is is asked again, in the simplest way there is: the listeners
	 * of a tab hear that tab alone; a tab under guard is known by its id; the rest goes by the cookie store.
	 * Should even that fail, nothing is known of the request, and it is not taken for the gateway's.
	 * A tab the guard failed on is sealed, and its job ends: what the guard could not judge is not read.
	 * @param {Scope} scope
	 * @param {RequestDetails} details
	 * @returns {Answer}
	 */
	#failed(scope, details) {
		let ours = scope === "tab";
		try {
			const tab = this.#tabs.get(details.tabId);
			tab?.failed();
			ours = ours || tab !== undefined || this.#isContainer(details.cookieStoreId);
		} catch {
			// as far as it was told
		}
		this.#failures += 1;
		// The first one and then every hundredth: a listener that fails once is likely to fail again.
		if (this.#failures % 100 === 1) this.#deps.log("guard.listener_failed", { scope, ours, count: this.#failures });
		return ours ? CANCEL : PASS;
	}

	/** @param {string} key */
	#unlisten(key) {
		for (const { event, fn } of this.#slices.get(key) ?? []) this.#deps.webRequest[event].removeListener(/** @type {any} */ (fn));
		this.#slices.delete(key);
	}

	/**
	 * Response headers of a request that no guarded tab made.
	 * @param {RequestDetails} details
	 * @returns {Answer}
	 */
	#outsideJob(details) {
		if (!this.#isContainer(details.cookieStoreId)) return this.#notOurs();
		if (details.url.startsWith(this.#deps.extensionBase)) return PASS;
		if (details.tabId !== -1 || !this.running) return CANCEL;
		return !this.proxied(details) && this.privateServer(details.url, details.ip) ? CANCEL : PASS;
	}

	/**
	 * The operator's own request: no objection, and nothing else happens.
	 * @returns {Answer}
	 */
	#notOurs() {
		this.#outside += 1;
		return PASS;
	}

	/** @returns {Answer} */
	#drop() {
		this.#dropped += 1;
		// The first one and then every hundredth: enough to see it in the log.
		if (this.#dropped % 100 === 1) this.#deps.log("guard.container_request_cancelled", { count: this.#dropped });
		return CANCEL;
	}
}
