// File capture: the body of a job tab's top-level response that is a file
// (a PDF, JSON, an image) instead of a page, read with a response filter
// (webRequest.filterResponseData) and never shown, saved or passed on.
//
// What the browser does, measured in headless Firefox 156 with a throwaway
// profile (2026-10-06; every row with and without a filter on the request):
//
//   response                                 without a filter          with a filter that passes nothing on
//   application/pdf                          built-in PDF viewer       all bytes; the viewer page starts, gets none
//   application/json, text/json,             JSON viewer (text/json:   all bytes; the viewer starts, gets none
//     application/*+json                     shown as text)
//   application/xml, text/xml, image/svg+xml XML or SVG document       all bytes; an empty document, no script runs
//   text/plain with nosniff, text/markdown   text document             all bytes; an empty text document
//     (text/plain with a Content-Encoding
//     and no nosniff was listed here until
//     0.1.6: wrongly - its bytes are looked
//     at like those of any text/plain)
//   image/png, jpeg, gif, webp               image document            all bytes; an image document without image
//   the same behind a redirect chain         as above                  as above (the filter is made for the last hop)
//   Content-Encoding gzip or br              as above                  the bytes arrive decoded
//   30 MB in chunks, no Content-Length       as above                  all of it, in pieces of 128 KiB, about a second
//   Content-Disposition: attachment (any     saved to the download     the filter fails with "Invalid request ID" and
//     type; a PDF is opened in a new tab     directory, listed         gets nothing; the download happens all the same,
//     afterwards)                                                      with the real bytes
//   application/zip, gzip, x-tar,            saved, listed             the same: nothing for the filter, a download
//     octet-stream, text/csv, rss+xml,
//     atom+xml, other +xml, no Content-Type
//     with binary bytes, text/plain with
//     binary bytes and no nosniff
//   application/pdf with pdfjs.disabled      saved, listed             the same (navigator.pdfViewerEnabled is false then)
//
// ("attachment" stands for every Content-Disposition the browser saves a
// response by. That is not the word alone: everything but an empty value,
// "inline" and a value that begins with "filename" - measured, the table is
// at guard.isAttachment. And a type is what the browser takes the
// Content-Type for, which is its last entry where it names several: see
// guard.mediaType.)
//
// So a filter on a navigation only ever sees what the browser shows itself.
// A response it hands to its download manager is beyond reach: the browser
// attaches the filter when it gives the load to a tab's document, and a
// download never gets there. Whether it will be a download is decided on the
// headers and, for text/plain without nosniff and for a missing type, on the
// first real bytes - before any filter. No sequence of filter calls changes
// that, and the only other lever is to change the response headers, which
// this extension did not do before 0.1.6. Hence:
//
//   - captured as they are: the types of the first block above, when the
//     operator's allowlist names them, the status is 200 and the job runs in
//     the gateway container;
//   - until 0.1.5 refused at the headers, before a byte is read: attachments,
//     archives, CSV, feeds, unknown binary types, a missing type, plain text
//     without nosniff, PDFs while the viewer is off. Since 0.1.6 they are
//     captured under the same three conditions, with other response headers
//     (see "Download-type responses" below).
//
// The sequence. The filter is made in the blocking onHeadersReceived listener
// of the last hop. It never writes: the tab's document gets no byte of the
// file, so nothing of it is rendered, parsed or run. When the response has
// ended (onstop) the filter is left open; the job closes its tab first and the
// filter after, so the viewer is never even told that the response is over.
// To stop early - the size limit, a refused head, the job's time - close() is
// called at once: measured, that aborts the request within some 20 ms (the
// server sees the connection go), where suspend() would leave it hanging.
// In no row of the captured block did a file or a download entry appear, at
// any moment (the download directory was polled every 3 ms).
//
// Not measured, because a fresh profile resets them: other choices than "open
// in the browser" for PDF, XML, SVG or WebP in the browser's own settings.
// There a captured type could become a download or a question to the
// operator. The downloads backstop removes such a download and ends the job.
//
// Download-type responses (since 0.1.6). The second block of the
// table - what the browser hands to its download manager - is read as well,
// by the one thing the paragraph above ruled out: the RESPONSE headers of
// that one response are changed locally, in the same blocking
// onHeadersReceived call that makes the filter, so that the browser takes
// the response for something it shows. relabelForCapture() below is the only
// place that makes such headers, and TabGuard.#read (guard.js) the only one
// that returns them. The server sees nothing of it: the request is the same
// navigation as before, with the container's cookies, and nothing of a
// request is ever changed.
//
// Measured in headless Firefox 156 through the test harness (2026-10-06),
// with a throwaway profile, each row also with "always ask where to save",
// no download directory, the PDF viewer and the JSON viewer switched off:
//
//   headers returned from onHeadersReceived          a filter made in the same call
//   none (as before)                                 "Invalid request ID"; the file is downloaded
//   Content-Type: text/plain, with or without        attaches for a body that is text; a body with
//     X-Content-Type-Options: nosniff or a charset,    binary bytes is sniffed and downloaded all the
//     Content-Disposition dropped                      same (nosniff counts only when the server sent it)
//   Content-Type changed, Content-Disposition kept   downloaded (also with a PDF)
//   Content-Disposition dropped, type kept           attaches only where the type is one the browser shows
//   Content-Type: text/json (also application/json,  attaches, every case below; nosniff makes no
//     text/css, text/javascript, image/png, ...),      difference, Content-Disposition: inline does as
//     Content-Disposition dropped                      well as none
//   the same, Content-Length or Content-Encoding     no difference: the length is not needed, and the
//     dropped as well                                   body is decoded whatever is said about its encoding
//
//   case, relabelled as text/json + nosniff, no      filter   bytes against the server's file (SHA-256)
//     Content-Disposition
//   application/zip, gzip, x-tar, octet-stream       attaches identical
//   text/csv (with and without a charset), rss+xml   attaches identical
//   attachment: PDF, zip, JSON, PNG, no type         attaches identical
//   application/pdf with the PDF viewer off          attaches identical
//   no Content-Type, an empty or a senseless one     attaches identical
//   text/plain without nosniff, text or binary body  attaches identical
//   30 MiB attachment, chunked and with a length     attaches identical, in pieces of 128 KiB
//   attachment behind a redirect chain (2 origins)   attaches identical
//   Content-Encoding gzip or br                      attaches identical to the decoded file
//   chunked in twelve pieces                         attaches identical
//   the same from the browser's HTTP cache, with     attaches identical (0.1.6 only: since 0.1.7 the
//     and without a 304 from the server                browser keeps no such response, see below)
//   application/gzip sent WITH Content-Encoding:     attaches NOT the file: the browser, which would have
//     gzip (a common server mistake)                   saved it as it came, now unpacks it once. What
//                                                      arrives no longer is what was declared. Such a
//                                                      response is therefore not read under other headers
//                                                      at all: planCapture refuses it at the headers
//                                                      (file_type_mismatch), see gzipSentEncoded
//
// In every attaching row: no download entry at any moment, no file in the
// download directory or the temp directory (polled every 3 ms), no new tab or
// window, and the tab commits an empty text document (document.contentType
// text/json, no viewer - the JSON viewer does not take text/json) that gets no
// byte. An ELF and an HTML document relabelled this way are read like any
// file; nothing of them runs (title unchanged, no request). Two Set-Cookie
// headers on such a response set both cookies, as without the change.
//
// Should the filter not be there (it always was, 60 loads in a row): the tab
// shows the bytes as plain text, script in them does not run, nothing is
// saved. The other way round - headers not changed, filter made - is the
// first row: a download, which the downloads backstop removes.
//
// Order and other listeners. Every onHeadersReceived listener is called with
// the headers as the server sent them; the browser applies what they return
// afterwards, in the order of the listeners, and skips a header whose
// returned value equals the original. Measured with a second blocking
// listener on the same response, before and after this one: one that returns
// the headers untouched plus one of its own, or sets Content-Type back to the
// original, changes nothing. One that itself adds Content-Disposition:
// attachment and comes after this one wins: the response is downloaded, the
// filter fails, and the backstop has to clean up - as it would have had to
// before, for a PDF. The filter attaches whether it is made in the call that
// returns the headers, a moment after it, or the headers come 50 ms later
// from a promise. The operator's own download of the same file in another
// tab at the same moment completes untouched.
//
// What the browser keeps: nothing (since 0.1.7). Until 0.1.6 its HTTP cache (the
// gateway container's own part of it) stored such a response as it went on
// with it - without the Content-Disposition, with the nosniff, under the
// server's own Content-Type and for as long as the server allowed. A later
// load of that address in the container, from any document, was then answered
// from the cache with a response that no longer said "attachment": a page of
// the same site that put the address into a frame got an SVG or XHTML
// attachment rendered there, script and all.
// So the headers made here also take out what a cache goes by (Cache-Control,
// Expires, ETag, Last-Modified, Pragma) and say "Cache-Control: no-store".
// Measured in headless Firefox 156: nothing of such a response is kept; the
// next load of the address, top-level or in a frame, is a new request without
// a condition, answered by the server with its own headers and judged by
// them. A file that was read this way is therefore asked for anew on every
// fetch (no "304 Not Modified" for it, no answer from the browser's cache),
// and the name its server suggests comes with it every time.
//
// Not measured: Waterfox itself, and another extension (a second listener
// of another add-on could add the header again).

import { LIMITS } from "../shared/protocol.js";
import { Sha256 } from "../shared/sha256.js";
import { FILE_CODE, SNIFF_BYTES, decideFile, typeAllowed } from "../shared/sniff.js";
import { EVIDENCE, KIND, KIND_MESSAGE, parseRetryAfter } from "./detect.js";

/**
 * @typedef {object} FilterLike the part of a StreamFilter used here
 * @property {((event: any) => void) | null} ondata the event carries the bytes as event.data (an ArrayBuffer)
 * @property {((event: any) => void) | null} onstop
 * @property {((event: any) => void) | null} onerror
 * @property {() => void} close
 *
 * @typedef {object} FilePolicy what the daemon lets a job bring back as a file
 * @property {number} maxBytes
 * @property {readonly string[]} types the operator's allowlist
 *
 * @typedef {object} FileStop why a capture ended without a file; the shape of the job runner's own
 * @property {import("../shared/protocol.js").Outcome} outcome
 * @property {string} code
 * @property {string} message
 * @property {boolean} retryable
 *
 * @typedef {{ ok: true, size: number, sha256: string } | { ok: false, stop: FileStop }} CaptureEnd
 *
 * @typedef {object} CapturePlan what is known of a file before its first byte
 * @property {string} contentType the declared media type, lowercase, without parameters, as the server sent it and
 *   before anything was changed; UNTYPED for a response that named none
 * @property {string | null} charset
 * @property {string | null} name what the server suggests as a file name
 * @property {string} url the address of the response
 * @property {true} [relabel] the browser would hand this response to its download manager: it is read with
 *   other response headers (relabelForCapture)
 *
 * @typedef {{ name: string, value?: string }} Header
 *
 * @typedef {object} PlanInput
 * @property {number} status
 * @property {readonly Header[]} headers
 * @property {{ kind: string, contentType: string | null, code?: string }} cls what guard.classifyResponse made of them
 * @property {string} url
 * @property {FilePolicy | null} files null: this job brings no file back
 * @property {boolean} login the job tab runs with the operator's own cookie store
 * @property {boolean} pdfViewer the browser shows PDFs itself
 *
 * @typedef {{ outcome: "policy_blocked" | "unsupported" | "error" | "blocked", code: string, message: string,
 *   detect?: { kind: string, evidence: string }, retryAfterS?: number | null }} PlanRefusal
 */

const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
// A page is fetched as a page: never read as a file, whatever comes with it and whatever the operator's list says.
const PAGE_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/** What a response that names no usable type is judged as, by the extension and by the daemon (RFC 9110, 8.3). */
export const UNTYPED = "application/octet-stream";

/**
 * The Content-Type a download-type response is given so that the browser shows it instead of saving it: shown
 * as plain text, by no viewer, and - other than text/plain - not looked at to see whether it is text (measured,
 * see the table at the top).
 */
export const RELABEL_TYPE = "text/json";
// What of the server's headers is taken out for that: the three the browser decides by whether to show or to save,
// and what its HTTP cache goes by - the response the browser goes on with must not be kept (see "What the browser
// keeps" at the top). Nothing else is touched: not the length, not the encoding.
const RELABEL_DROPPED = new Set(["content-disposition", "content-type", "x-content-type-options", "cache-control", "expires", "etag", "last-modified", "pragma"]);
// The media types of a gzip file, and what a Content-Encoding calls the same packing.
const GZIP_TYPES = new Set(["application/gzip", "application/x-gzip", "application/x-gunzip"]);
const GZIP_ENCODINGS = new Set(["gzip", "x-gzip"]);

/**
 * @param {string} type lowercase media type without parameters
 * @returns {"pdf" | "json" | "xml" | "text" | "image" | null} how the browser shows a top-level response of that type
 *   by itself; null: it does not, the response would become a download (see the table at the top)
 */
export function inlineKind(type) {
	if (type === "application/pdf") return "pdf";
	if (type === "application/json" || type === "text/json" || (type.startsWith("application/") && type.endsWith("+json"))) return "json";
	if (type === "application/xml" || type === "text/xml" || type === "image/svg+xml") return "xml";
	if (type === "text/plain" || type === "text/markdown") return "text";
	if (IMAGES.has(type)) return "image";
	return null;
}

/**
 * The response headers under which the browser hands a download-type response to the tab, where a filter can
 * read it: the server's own, without Content-Disposition, with RELABEL_TYPE for a type and nosniff - and, so
 * that the browser's cache keeps nothing of a response it was told other things about, without the server's
 * word on caching and with "no-store". This is the
 * only function of the extension that makes headers. What it returns is used in one place (TabGuard.#read in
 * guard.js), for one response: the top-level response of a job tab in the gateway container that the job may
 * bring back as a file. No request header is ever made or changed anywhere.
 * @param {readonly Header[]} headers as the browser reports them; not changed
 * @returns {Header[]}
 */
export function relabelForCapture(headers) {
	const out = headers.filter((h) => typeof h.name !== "string" || !RELABEL_DROPPED.has(h.name.toLowerCase()));
	out.push({ name: "Content-Type", value: RELABEL_TYPE }, { name: "X-Content-Type-Options", value: "nosniff" }, { name: "Cache-Control", value: "no-store" });
	return out;
}

/**
 * A gzip file that is sent with "Content-Encoding: gzip" on top of its gzip type: a common server mistake - the
 * body is packed once, and both headers speak of that one packing. The browser saves such a response as it
 * came. Shown instead of saved, which is what other response headers make of it, the browser unpacks it once
 * (measured, see the table at the top): a filter would be given something that is not the file the browser
 * saves. So this response is not read under other headers; planCapture refuses it, and TabGuard.#relabelled
 * (guard.js) makes no headers for it.
 * @param {string} type the declared media type, lowercase, without parameters
 * @param {readonly Header[]} headers
 * @returns {boolean}
 */
export function gzipSentEncoded(type, headers) {
	if (!GZIP_TYPES.has(type)) return false;
	for (const h of headers) {
		if (typeof h.name !== "string" || h.name.toLowerCase() !== "content-encoding") continue;
		// Several lines of the header are one list, like its commas.
		if (String(h.value ?? "").split(",").some((coding) => GZIP_ENCODINGS.has(coding.trim().toLowerCase()))) return true;
	}
	return false;
}

/**
 * @param {{ kind: string, contentType: string | null, code?: string }} cls what guard.classifyResponse made of a response
 * @param {boolean} pdfViewer the browser shows PDFs itself
 * @returns {string | null} for a response the browser would hand to its download manager: the declared type it is
 *   judged by. null: no such response - or a page by its type, which is never a file
 */
export function downloadType(cls, pdfViewer) {
	if (cls.kind !== "refuse") return null;
	const type = cls.contentType;
	if (type !== null && PAGE_TYPES.has(type)) return null;
	switch (cls.code) {
		case "attachment":
			return type ?? UNTYPED;
		case "content_type_missing":
			return UNTYPED;
		case "plain_text_sniffable":
			return type;
		case "content_type":
		case "content_type_json":
		case "content_type_xml":
			if (type === null) return null;
			if (inlineKind(type) === null) return type;
			// With its viewer off the browser saves PDFs.
			return type === "application/pdf" && !pdfViewer ? type : null;
		default:
			return null;
	}
}

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
 * The file name a Content-Disposition header suggests, as it stands there. It
 * is a server's word: the daemon makes the name that is used, and never a path.
 * @param {string | null} value
 * @returns {string | null}
 */
export function dispositionName(value) {
	if (value === null || value.length > 2048) return null;
	// Also where nothing stands before it: "filename=..." alone is a response the browser shows, under that name.
	const star = /(?:^|;)\s*filename\*\s*=\s*(?:utf-8|iso-8859-1)'[^']{0,20}'([^;\s]{1,1024})/i.exec(value);
	if (star !== null) {
		try {
			const decoded = decodeURIComponent(star[1]);
			if (decoded !== "") return decoded.slice(0, LIMITS.MAX_FILE_NAME);
		} catch {
			// not what it claims to be: the plain form may still do
		}
	}
	const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.){0,1024})"|([^;\s"]{1,1024}))/i.exec(value);
	if (plain === null) return null;
	const name = plain[1] !== undefined ? plain[1].replace(/\\(.)/g, "$1") : plain[2];
	return name === "" ? null : name.slice(0, LIMITS.MAX_FILE_NAME);
}

/**
 * @param {string | null} value a Content-Type header
 * @returns {string | null} its charset parameter, lowercase
 */
export function charsetOf(value) {
	if (value === null) return null;
	const m = /;\s*charset\s*=\s*"?([A-Za-z0-9._:-]{1,40})"?/i.exec(value);
	return m === null ? null : m[1].toLowerCase();
}

/**
 * What to do with the top-level response of a job tab, as far as files go.
 * @param {PlanInput} input
 * @returns {null | { refuse: PlanRefusal } | { capture: CapturePlan }} null: no file matter - the response is a page,
 *   or something the request guard refuses by its own rules (among them: every response of a job that brings no
 *   file back)
 */
export function planCapture(input) {
	const { status, headers, cls, files, login } = input;
	// Plain text that the browser shows without looking at it was a page before files existed, and stays one
	// wherever a file is not to be had.
	const wasPage = cls.kind === "page" && cls.contentType === "text/plain";
	// What the browser would save is read with other response headers; what it shows by itself, as it is.
	const download = downloadType(cls, input.pdfViewer);
	const shown = cls.contentType !== null && inlineKind(cls.contentType) !== null && (wasPage || (cls.kind === "refuse" && (cls.code === "content_type_json" || cls.code === "content_type_xml" || cls.code === "content_type")));
	const type = download ?? (shown ? cls.contentType : null);
	if (type === null) return null;
	if (files === null) return null;
	if (login) {
		if (wasPage) return null;
		return { refuse: { outcome: "policy_blocked", code: "file_login_scope", message: "the response is a file, and files are not retrieved with the operator's login" } };
	}
	if (!typeAllowed(type, files.types)) {
		if (wasPage) return null;
		return { refuse: { outcome: "unsupported", code: "file_type_not_allowed", message: "the response is a file of a type that is not on the operator's list" } };
	}
	if (status !== 200) {
		if (wasPage) return null;
		if (status === 403) return { refuse: { outcome: "blocked", code: KIND.HTTP_403, message: KIND_MESSAGE[KIND.HTTP_403], detect: { kind: KIND.HTTP_403, evidence: EVIDENCE.STATUS_403 } } };
		if (status === 429) {
			return {
				refuse: { outcome: "blocked", code: KIND.HTTP_429, message: KIND_MESSAGE[KIND.HTTP_429], detect: { kind: KIND.HTTP_429, evidence: EVIDENCE.STATUS_429 }, retryAfterS: parseRetryAfter(header(headers, "retry-after"), Date.now()) },
			};
		}
		return { refuse: { outcome: "unsupported", code: "file_http_error", message: "the server answered with an error status instead of a file" } };
	}
	// What the browser would unpack on the way is not the file it would have saved: not read, and said so here,
	// before a filter is made or a byte arrives.
	if (download !== null && gzipSentEncoded(download, headers)) {
		return { refuse: { outcome: "unsupported", code: FILE_CODE.MISMATCH, message: "the server sent a gzip file with Content-Encoding: gzip on top; read in the browser it would be unpacked, and would not be the file" } };
	}
	// What the server announces is the size on the wire: only without an encoding is it the size of the file.
	const length = header(headers, "content-length");
	if (length !== null && (header(headers, "content-encoding") ?? "").trim() === "" && /^[0-9]{1,15}$/.test(length.trim()) && Number(length.trim()) > files.maxBytes) {
		return { refuse: { outcome: "unsupported", code: "too_large", message: "the server announces a file that is larger than the operator allows" } };
	}
	// Type, charset and name are read here, from the headers as the server sent them.
	return { capture: { contentType: type, charset: charsetOf(header(headers, "content-type")), name: dispositionName(header(headers, "content-disposition")), url: input.url, ...(download === null ? {} : { relabel: /** @type {const} */ (true) }) } };
}

/**
 * @param {Uint8Array} bytes
 * @returns {string} base64 with padding
 */
export function toBase64(bytes) {
	const native = /** @type {{ toBase64?: () => string }} */ (/** @type {unknown} */ (bytes)).toBase64;
	if (typeof native === "function") return native.call(bytes);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/**
 * One file on its way in: collects what the filter delivers, up to a limit,
 * and hands nothing on.
 */
export class Capture {
	#filter;
	#maxBytes;
	#allow;
	/** @type {Uint8Array[]} */
	#chunks = [];
	#hash = new Sha256();
	#seen = 0;
	#checked = false;
	#ended = false;
	#closed = false;
	/** @type {(end: CaptureEnd) => void} */
	#resolve = () => {};
	/** @type {Promise<CaptureEnd>} resolves once: the response was read to its end, or reading stopped */
	done;
	/** @type {CapturePlan} */
	plan;

	/**
	 * @param {object} opts
	 * @param {FilterLike} opts.filter
	 * @param {FilePolicy} opts.files
	 * @param {CapturePlan} opts.plan
	 */
	constructor({ filter, files, plan }) {
		this.#filter = filter;
		this.#maxBytes = Math.min(files.maxBytes, LIMITS.MAX_FILE_BYTES);
		this.#allow = files.types;
		this.plan = plan;
		this.done = new Promise((resolve) => {
			this.#resolve = resolve;
		});
		filter.ondata = (event) => this.#onData(event.data);
		filter.onstop = () => this.#onStop();
		filter.onerror = () => this.#fail({ outcome: "error", code: "file_interrupted", message: "the response ended before the file was complete", retryable: true });
	}

	/** Bytes of the response body read so far, kept or not. */
	get seen() {
		return this.#seen;
	}

	/** @returns {Uint8Array} the first bytes that were kept, at most SNIFF_BYTES */
	#head() {
		const head = new Uint8Array(Math.min(this.#seen, SNIFF_BYTES));
		let at = 0;
		for (const chunk of this.#chunks) {
			if (at >= head.length) break;
			const part = chunk.subarray(0, head.length - at);
			head.set(part, at);
			at += part.length;
		}
		return head;
	}

	/**
	 * The cheap look at the head, once: what the daemon would refuse is not read to its end, let alone sent.
	 * @returns {boolean} false when the capture was ended for it
	 */
	#check() {
		if (this.#checked) return true;
		this.#checked = true;
		const verdict = decideFile({ declared: this.plan.contentType, head: this.#head(), allow: this.#allow });
		if (verdict.ok) return true;
		const messages = {
			file_content_refused: "the file is of a kind that is never retrieved (an executable, a script, a shortcut or an installer)",
			file_type_mismatch: "the content of the file is not what its declared type says",
		};
		this.#fail({ outcome: "unsupported", code: verdict.code, message: messages[/** @type {keyof typeof messages} */ (verdict.code)] ?? "the file is not of an allowed type", retryable: false });
		return false;
	}

	/** @param {ArrayBuffer} data */
	#onData(data) {
		if (this.#ended) return;
		const piece = new Uint8Array(data);
		this.#seen += piece.length;
		if (this.#seen > this.#maxBytes) {
			this.#fail({ outcome: "unsupported", code: "too_large", message: "the file is larger than the operator allows; reading stopped at the limit", retryable: false });
			return;
		}
		this.#chunks.push(piece);
		this.#hash.update(piece);
		if (!this.#checked && this.#seen >= SNIFF_BYTES) this.#check();
	}

	#onStop() {
		if (this.#ended || !this.#check()) return;
		this.#ended = true;
		// The filter stays open: the tab's document is not told that its response ended. close() comes after the tab.
		this.#resolve({ ok: true, size: this.#seen, sha256: this.#hash.digestHex() });
	}

	/** @param {FileStop} stop */
	#fail(stop) {
		if (this.#ended) return;
		this.#ended = true;
		this.#chunks = [];
		// At once: measured, this is what ends the request.
		this.close();
		this.#resolve({ ok: false, stop });
	}

	/**
	 * Stop reading: the job ran out of time, or was ended.
	 * @param {FileStop} stop
	 */
	abort(stop) {
		this.#fail(stop);
	}

	/** Close the filter. Safe to call twice, and after the tab is gone. */
	close() {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#filter.close();
		} catch {
			// already gone with its request
		}
	}

	/** Close the filter and let go of the bytes. */
	discard() {
		this.close();
		this.#ended = true;
		this.#chunks = [];
	}

	/**
	 * The file in pieces for the wire: every one but the last holds exactly LIMITS.BLOB_CHUNK_BYTES.
	 * @returns {Generator<Uint8Array, void, void>}
	 */
	*pieces() {
		const size = LIMITS.BLOB_CHUNK_BYTES;
		let piece = new Uint8Array(size);
		let fill = 0;
		for (const chunk of this.#chunks) {
			let at = 0;
			while (at < chunk.length) {
				const take = Math.min(size - fill, chunk.length - at);
				piece.set(chunk.subarray(at, at + take), fill);
				fill += take;
				at += take;
				if (fill === size) {
					yield piece;
					piece = new Uint8Array(size);
					fill = 0;
				}
			}
		}
		if (fill > 0) yield piece.subarray(0, fill);
	}
}
