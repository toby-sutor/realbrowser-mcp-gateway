// File capture in the extension: which responses are read as files, how a
// filter is handled, and what the request guard does with one - driven by hand
// with a stand-in for the browser's response filter.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { FakeEvent, logSink } from "../helpers/ext-fakes.js";
import { FakeFilter, filterFactory } from "../helpers/fake-filter.js";
import { Capture, RELABEL_TYPE, UNTYPED, charsetOf, dispositionName, downloadType, gzipSentEncoded, inlineKind, planCapture, relabelForCapture, toBase64 } from "../../extension/background/capture.js";
import { Guard, classifyResponse, mediaType } from "../../extension/background/guard.js";
import { DEFAULT_BLOCKLIST } from "../../extension/shared/policy.js";
import { LIMITS } from "../../extension/shared/protocol.js";
import { DEFAULT_ALLOW_TYPES, SNIFF_BYTES } from "../../extension/shared/sniff.js";

const FILES = Object.freeze({ maxBytes: 1048576, types: DEFAULT_ALLOW_TYPES });
const PDF = Buffer.from("%PDF-1.4\n% a made-up document\n");

/** @param {Record<string, string>} headers */
const h = (headers) => Object.entries(headers).map(([name, value]) => ({ name, value }));

/**
 * planCapture as the guard calls it.
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {Partial<import("../../extension/background/capture.js").PlanInput>} [over]
 */
function plan(status, headers, over = {}) {
	const list = h(headers);
	return planCapture({ status, headers: list, cls: classifyResponse(status, list), url: "https://example.com/file", files: FILES, login: false, pdfViewer: true, ...over });
}

test("inlineKind: the types the browser shows by itself, measured - and nothing else", () => {
	/** @type {[string, string | null][]} */
	const table = [
		["application/pdf", "pdf"],
		["application/json", "json"],
		["text/json", "json"],
		["application/ld+json", "json"],
		["application/vnd.api+json", "json"],
		["application/xml", "xml"],
		["text/xml", "xml"],
		["image/svg+xml", "xml"],
		["text/plain", "text"],
		["text/markdown", "text"],
		["image/png", "image"],
		["image/jpeg", "image"],
		["image/gif", "image"],
		["image/webp", "image"],
		// Saved as a download by the browser: a filter never sees them.
		["application/zip", null],
		["application/gzip", null],
		["application/x-tar", null],
		["application/octet-stream", null],
		["text/csv", null],
		["application/rss+xml", null],
		["application/atom+xml", null],
		["application/soap+xml", null],
		["image/x+json", null],
		["image/avif", null],
		["video/mp4", null],
		// Pages are pages.
		["text/html", null],
		["application/xhtml+xml", null],
	];
	for (const [type, kind] of table) assert.equal(inlineKind(type), kind, type);
});

test("the name a server suggests is read from Content-Disposition, as it stands", () => {
	/** @type {[string | null, string | null][]} */
	const table = [
		[null, null],
		["inline", null],
		["attachment", null],
		['inline; filename="report.pdf"', "report.pdf"],
		["inline; filename=report.pdf", "report.pdf"],
		['INLINE; FileName="A B.pdf"', "A B.pdf"],
		['inline; filename="quo\\"te.pdf"', 'quo"te.pdf'],
		["inline; filename*=UTF-8''gr%C3%BC%C3%9Fe.pdf", "gr\u00fc\u00dfe.pdf"],
		["inline; filename=\"fallback.pdf\"; filename*=UTF-8''real%20name.pdf", "real name.pdf"],
		["inline; filename*=UTF-8''%E0%A4%A; filename=plain.pdf", "plain.pdf"],
		// Whatever stands before it, and where nothing does: a value that begins with "filename" is one the browser shows.
		['download; filename="x.pdf"', "x.pdf"],
		['filename="bare.pdf"', "bare.pdf"],
		["FileName=bare.pdf", "bare.pdf"],
		["filename*=UTF-8''gr%C3%BC%C3%9Fe.pdf", "gr\u00fc\u00dfe.pdf"],
		['; filename="after-nothing.pdf"', "after-nothing.pdf"],
		// Not a parameter of that name.
		['inline; xfilename="no.pdf"', null],
		['xfilename="no.pdf"', null],
		// Nothing is cleaned here: the daemon makes the name that is used, and never a path.
		['inline; filename="../../etc/passwd"', "../../etc/passwd"],
		['inline; filename=""', null],
		[`inline; filename="${"a".repeat(600)}"`, "a".repeat(LIMITS.MAX_FILE_NAME)],
		["x".repeat(3000), null],
	];
	for (const [value, name] of table) assert.equal(dispositionName(value), name, String(value).slice(0, 60));
	assert.equal(charsetOf("text/plain; charset=ISO-8859-1"), "iso-8859-1");
	assert.equal(charsetOf('application/json;charset="UTF-8"'), "utf-8");
	assert.equal(charsetOf("application/pdf"), null);
	assert.equal(charsetOf("text/plain; charset=bad charset!"), "bad");
	assert.equal(charsetOf(null), null);
});

test("base64 for the wire: the runtime's own where it has one, and the same without", () => {
	for (const n of [0, 1, 2, 3, 4, 255, 32768, 32769, 100000]) {
		const data = crypto.randomBytes(n);
		const want = data.toString("base64");
		assert.equal(toBase64(new Uint8Array(data)), want, `${n} bytes`);
		// A browser without Uint8Array.prototype.toBase64.
		const plain = new Uint8Array(data);
		Object.defineProperty(plain, "toBase64", { value: undefined });
		assert.equal(toBase64(plain), want, `${n} bytes, the long way`);
	}
});

test("planCapture: what is read as a file, what is refused with a word of its own, and what stays the guard's business", () => {
	const capture = (/** @type {any} */ p) => (p !== null && "capture" in p ? p.capture : null);
	const refusal = (/** @type {any} */ p) => (p !== null && "refuse" in p ? [p.refuse.outcome, p.refuse.code] : null);

	// Read as a file: the types the browser shows itself, on the operator's list, status 200, in the container.
	for (const type of ["application/pdf", "application/json", "application/ld+json", "application/xml", "text/xml", "image/svg+xml", "text/markdown", "image/png", "image/jpeg", "image/gif", "image/webp"]) {
		assert.deepEqual(capture(plan(200, { "content-type": type })), { contentType: type, charset: null, name: null, url: "https://example.com/file" }, type);
	}
	assert.deepEqual(capture(plan(200, { "Content-Type": "text/plain; charset=UTF-8", "X-Content-Type-Options": "nosniff", "Content-Disposition": 'inline; filename="notes.txt"' })), {
		contentType: "text/plain",
		charset: "utf-8",
		name: "notes.txt",
		url: "https://example.com/file",
	});
	// Changed for 0.1.7: an encoded body is looked at by the browser like any other (measured), so it is read under
	// other response headers, like every text/plain that does not forbid the looking.
	assert.deepEqual(capture(plan(200, { "content-type": "text/plain", "content-encoding": "gzip" })), { contentType: "text/plain", charset: null, name: null, url: "https://example.com/file", relabel: true });
	assert.deepEqual(capture(plan(200, { "content-type": "text/plain", "content-encoding": "gzip", "x-content-type-options": "nosniff" })), { contentType: "text/plain", charset: null, name: null, url: "https://example.com/file" });

	// What the browser would hand to its download manager is read as well, marked for other response headers.
	// The type is the one the server declared; a response that names none is judged as bytes of no named kind.
	/** @type {[Record<string, string>, string, string | null][]} headers, the declared type, the suggested name */
	const downloads = [
		[{ "content-type": "application/pdf", "content-disposition": "attachment" }, "application/pdf", null],
		[{ "content-type": "application/json", "content-disposition": 'attachment; filename="x.json"' }, "application/json", "x.json"],
		[{ "content-type": "image/png", "Content-Disposition": "ATTACHMENT; filename*=UTF-8''gr%C3%BC%C3%9Fe.png" }, "image/png", "gr\u00fc\u00dfe.png"],
		[{ "content-type": "text/plain", "x-content-type-options": "nosniff", "content-disposition": "attachment" }, "text/plain", null],
		[{ "content-disposition": 'attachment; filename="blob"' }, UNTYPED, "blob"],
		[{ "content-type": "application/zip" }, "application/zip", null],
		[{ "content-type": "application/gzip" }, "application/gzip", null],
		[{ "content-type": "application/x-tar" }, "application/x-tar", null],
		[{ "content-type": "application/octet-stream" }, "application/octet-stream", null],
		[{ "content-type": "text/csv" }, "text/csv", null],
		[{ "content-type": "application/rss+xml" }, "application/rss+xml", null],
		[{ "content-type": "application/atom+xml; charset=utf-8" }, "application/atom+xml", null],
		[{}, UNTYPED, null],
		[{ "content-type": "nonsense" }, UNTYPED, null],
		[{ "content-type": "text/plain" }, "text/plain", null],
	];
	for (const [headers, type, name] of downloads) {
		const p = capture(plan(200, headers));
		assert.deepEqual({ contentType: p?.contentType, name: p?.name, url: p?.url, relabel: p?.relabel }, { contentType: type, name, url: "https://example.com/file", relabel: true }, JSON.stringify(headers));
	}
	assert.equal(capture(plan(200, { "content-type": "text/csv; charset=ISO-8859-1" }))?.charset, "iso-8859-1");
	assert.equal(UNTYPED, "application/octet-stream");
	// A PDF is a download where the browser does not show PDFs itself, and is read that way there.
	assert.deepEqual(capture(plan(200, { "content-type": "application/pdf" }, { pdfViewer: false })), { contentType: "application/pdf", charset: null, name: null, url: "https://example.com/file", relabel: true });
	// What the browser shows by itself is never marked: its headers stay as they are.
	for (const type of ["application/pdf", "application/json", "image/png", "text/markdown"]) assert.equal("relabel" in capture(plan(200, { "content-type": type })), false, type);
	assert.equal("relabel" in capture(plan(200, { "content-type": "application/pdf", "content-disposition": 'inline; filename="x.pdf"' })), false, "inline is no download");

	// A page is a page: its type is never read as a file, whatever comes with it and whatever the operator allows.
	const anything = { maxBytes: 1048576, types: [...DEFAULT_ALLOW_TYPES, "text/html", "application/xhtml+xml", "+xml"] };
	for (const type of ["text/html", "text/html; charset=utf-8", "application/xhtml+xml"]) {
		for (const more of /** @type {Record<string, string>[]} */ ([{}, { "content-disposition": "attachment" }, { "content-disposition": 'attachment; filename="page.html"' }])) {
			assert.equal(plan(200, { "content-type": type, ...more }, { files: anything }), null, `${type} ${JSON.stringify(more)}`);
			assert.equal(downloadType(classifyResponse(200, h({ "content-type": type, ...more })), true), null);
		}
	}

	// Not a file matter at all (null): the guard goes on as it always did - a page, a redirect, or its own refusal.
	/** @type {[number, Record<string, string>, string][]} */
	const untouched = [
		[200, { "content-type": "text/html" }, "a page"],
		[200, { "content-type": "application/xhtml+xml" }, "a page"],
		[200, { "content-type": "text/html", "content-disposition": "attachment" }, "a page offered as a download: refused by the guard, as ever"],
		[302, { location: "/x", "content-type": "application/pdf" }, "a redirect"],
		[302, { location: "/x", "content-type": "application/zip", "content-disposition": "attachment" }, "a redirect, whatever it claims to be"],
		[204, { "content-type": "application/pdf" }, "no body"],
		[204, { "content-type": "application/zip", "content-disposition": "attachment" }, "no body"],
		[304, {}, "not modified"],
		[401, { "content-type": "application/json", "www-authenticate": "Basic" }, "a login dialog"],
		[401, { "content-type": "application/zip", "www-authenticate": "Basic" }, "a login dialog"],
		[407, { "content-type": "application/zip" }, "the proxy's question"],
		[404, { "content-type": "text/plain", "x-content-type-options": "nosniff" }, "a plain-text error page stays a page"],
	];
	for (const [status, headers, label] of untouched) assert.equal(plan(status, headers), null, label);
	// An error status under a download type is the site's refusal, as under any file type.
	assert.deepEqual(refusal(plan(404, { "content-type": "application/zip" })), ["unsupported", "file_http_error"]);
	assert.deepEqual(refusal(plan(403, { "content-type": "application/octet-stream", "content-disposition": "attachment" })), ["blocked", "http_403"]);
	assert.deepEqual(refusal(plan(429, {})), ["blocked", "http_429"]);
	assert.deepEqual(refusal(plan(200, { "content-type": "application/zip", "content-length": "2000000" })), ["unsupported", "too_large"], "announced larger than allowed: refused before a byte is read");

	// A job that brings no file back (a search, a probe, files switched off): nothing changes for it.
	for (const type of ["application/pdf", "application/json", "image/png"]) assert.equal(plan(200, { "content-type": type }, { files: null }), null, type);
	assert.equal(plan(200, { "content-type": "text/plain", "x-content-type-options": "nosniff" }, { files: null }), null);

	// The operator's login: never a file. Plain text stays the page it was; everything else is refused by name.
	for (const type of ["application/pdf", "application/json", "application/xml", "image/png", "text/markdown"]) {
		assert.deepEqual(refusal(plan(200, { "content-type": type }, { login: true })), ["policy_blocked", "file_login_scope"], type);
	}
	assert.equal(plan(200, { "content-type": "text/plain", "x-content-type-options": "nosniff" }, { login: true }), null);
	assert.equal(plan(200, { "content-type": "application/pdf" }, { login: true, files: null }), null, "no file and a login: the guard's own refusal, as before");

	// Not on the operator's list.
	const few = { maxBytes: 1000, types: ["application/pdf"] };
	assert.deepEqual(refusal(plan(200, { "content-type": "application/json" }, { files: few })), ["unsupported", "file_type_not_allowed"]);
	assert.deepEqual(refusal(plan(200, { "content-type": "image/png" }, { files: few })), ["unsupported", "file_type_not_allowed"]);
	// The same three rules for what the browser would save: no file for a job that brings none back (the guard's
	// own refusal stands, as before), never with the operator's login, never a type that is not on the list.
	for (const [headers] of downloads) {
		assert.equal(plan(200, headers, { files: null }), null, JSON.stringify(headers));
		assert.equal(plan(200, headers, { files: null, login: true }), null, JSON.stringify(headers));
		assert.deepEqual(refusal(plan(200, headers, { login: true })), ["policy_blocked", "file_login_scope"], JSON.stringify(headers));
		assert.deepEqual(refusal(plan(200, headers, { files: { maxBytes: 1000, types: ["image/webp"] } })), ["unsupported", "file_type_not_allowed"], JSON.stringify(headers));
	}
	assert.deepEqual(refusal(plan(200, { "content-type": "video/mp4" })), ["unsupported", "file_type_not_allowed"]);
	assert.deepEqual(refusal(plan(200, { "content-type": "application/x-msdownload", "content-disposition": "attachment" })), ["unsupported", "file_type_not_allowed"]);
	// Bytes of no named kind need "application/octet-stream" on the list, like those that are named so.
	assert.deepEqual(refusal(plan(200, {}, { files: { maxBytes: 1000, types: ["application/zip"] } })), ["unsupported", "file_type_not_allowed"]);
	assert.equal(plan(200, { "content-type": "text/plain", "x-content-type-options": "nosniff" }, { files: few }), null, "plain text off the list is the page it always was");

	// The browser's PDF viewer is off: it would save the file - which makes the PDF a download like any other (above).
	assert.equal(capture(plan(200, { "content-type": "application/pdf" }, { pdfViewer: false }))?.relabel, true);
	assert.equal(plan(200, { "content-type": "application/pdf" }, { pdfViewer: false, files: null }), null);
	assert.equal("relabel" in capture(plan(200, { "content-type": "application/json" }, { pdfViewer: false })), false);

	// An error status with a file type: the site's refusal.
	assert.deepEqual(refusal(plan(404, { "content-type": "application/json" })), ["unsupported", "file_http_error"]);
	assert.deepEqual(refusal(plan(500, { "content-type": "application/pdf" })), ["unsupported", "file_http_error"]);
	assert.deepEqual(refusal(plan(206, { "content-type": "application/pdf" })), ["unsupported", "file_http_error"], "a part of a file is no file");
	const forbidden = /** @type {any} */ (plan(403, { "content-type": "application/json" }));
	assert.deepEqual([forbidden.refuse.outcome, forbidden.refuse.code, forbidden.refuse.detect], ["blocked", "http_403", { kind: "http_403", evidence: "status 403" }]);
	const limited = /** @type {any} */ (plan(429, { "content-type": "application/json", "retry-after": "77" }));
	assert.deepEqual([limited.refuse.outcome, limited.refuse.code, limited.refuse.retryAfterS], ["blocked", "http_429", 77]);

	// A length the server announces beyond the limit: refused before a byte is read.
	assert.deepEqual(refusal(plan(200, { "content-type": "application/pdf", "content-length": String(FILES.maxBytes + 1) })), ["unsupported", "too_large"]);
	assert.notEqual(capture(plan(200, { "content-type": "application/pdf", "content-length": String(FILES.maxBytes) })), null);
	assert.notEqual(capture(plan(200, { "content-type": "application/json", "content-length": "99999999", "content-encoding": "gzip" })), null, "the length of an encoded body says nothing about the file");
	assert.notEqual(capture(plan(200, { "content-type": "application/pdf", "content-length": "lots" })), null);
});

/**
 * A capture over a fake filter.
 * @param {Partial<import("../../extension/background/capture.js").FilePolicy>} [files]
 * @param {string} [contentType]
 */
function capturing(files = {}, contentType = "application/pdf") {
	const filter = new FakeFilter("7");
	const capture = new Capture({ filter, files: { ...FILES, ...files }, plan: { contentType, charset: null, name: null, url: "https://example.com/file" } });
	return { filter, capture };
}

/** @param {Promise<unknown>} p @returns {Promise<boolean>} */
const settledSoon = (p) => Promise.race([p.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 20))]);

test("Capture: every byte is taken, none is passed on, and the filter is closed only when told", async () => {
	const { filter, capture } = capturing();
	const body = Buffer.concat([PDF, crypto.randomBytes(70000)]);
	for (let i = 0; i < body.length; i += 16384) filter.feed(body.subarray(i, i + 16384));
	assert.equal(await settledSoon(capture.done), false, "not done before the response ended");
	assert.equal(capture.seen, body.length);
	filter.end();
	assert.deepEqual(await capture.done, { ok: true, size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") });
	// The tab's document was given nothing, and was not even told that the response is over.
	assert.deepEqual(filter.calls, { close: 0, write: 0, disconnect: 0, suspend: 0, resume: 0 });
	assert.equal(Buffer.concat([...capture.pieces()]).equals(body), true);
	capture.close();
	capture.close();
	assert.equal(filter.calls.close, 1, "closed once, however often it is asked");
	assert.equal(Buffer.concat([...capture.pieces()]).equals(body), true, "closing the filter keeps the bytes");
	capture.discard();
	assert.deepEqual([...capture.pieces()], []);
	assert.equal(filter.passedOn, 0);
});

test("Capture: the pieces for the wire are full ones, except the last", () => {
	for (const size of [0, 1, LIMITS.BLOB_CHUNK_BYTES - 1, LIMITS.BLOB_CHUNK_BYTES, LIMITS.BLOB_CHUNK_BYTES + 1, 3 * LIMITS.BLOB_CHUNK_BYTES, 3 * LIMITS.BLOB_CHUNK_BYTES + 77]) {
		const { filter, capture } = capturing({ maxBytes: 4 * LIMITS.BLOB_CHUNK_BYTES }, "text/plain");
		const body = Buffer.alloc(size, 0x61);
		// As a browser delivers: in pieces of its own size, here 128 KiB and a few odd ones.
		for (let i = 0; i < size; ) {
			const n = i === 0 ? 5 : 131072;
			filter.feed(body.subarray(i, i + n));
			i += n;
		}
		filter.end();
		const pieces = [...capture.pieces()];
		assert.equal(pieces.length, Math.ceil(size / LIMITS.BLOB_CHUNK_BYTES), `${size} bytes`);
		for (const [i, piece] of pieces.entries()) {
			if (i < pieces.length - 1) assert.equal(piece.length, LIMITS.BLOB_CHUNK_BYTES);
			else assert.ok(piece.length >= 1 && piece.length <= LIMITS.BLOB_CHUNK_BYTES);
		}
		assert.equal(Buffer.concat(pieces).length, size);
	}
});

test("Capture: the size limit stops the reading at once - the filter is closed, which ends the request - and nothing is kept", async () => {
	const { filter, capture } = capturing({ maxBytes: 100000 });
	filter.feed(PDF);
	filter.feed(Buffer.alloc(99000, 0x20));
	assert.equal(filter.closed, false, "still within the limit");
	filter.feed(Buffer.alloc(2000, 0x20));
	assert.equal(filter.calls.close, 1, "closed in the same moment");
	const end = await capture.done;
	assert.deepEqual([end.ok, !end.ok && end.stop.outcome, !end.ok && end.stop.code, !end.ok && end.stop.retryable], [false, "unsupported", "too_large", false]);
	assert.equal(capture.seen, PDF.length + 101000, "what was read is known, for the result");
	assert.deepEqual([...capture.pieces()], [], "none of it is kept");
	// Whatever the browser still delivers changes nothing.
	filter.ondata?.({ data: new Uint8Array(10).buffer });
	filter.onstop?.();
	assert.equal(capture.seen, PDF.length + 101000);
	assert.deepEqual(filter.calls, { close: 1, write: 0, disconnect: 0, suspend: 0, resume: 0 });
	// Exactly at the limit is within it.
	const exact = capturing({ maxBytes: PDF.length });
	exact.filter.feed(PDF);
	exact.filter.end();
	assert.equal((await exact.capture.done).ok, true);
	// The limit can never be more than the wire carries.
	const huge = capturing({ maxBytes: Number.MAX_SAFE_INTEGER });
	huge.filter.feed(PDF);
	huge.filter.end();
	assert.equal((await huge.capture.done).ok, true);
});

test("Capture: a body nobody wants is not read to its end - the head is looked at as soon as it is there", async () => {
	// An executable declared as a PDF: refused when the head has arrived, long before the end.
	const exe = capturing();
	exe.filter.feed(Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(SNIFF_BYTES, 0)]));
	assert.equal(exe.filter.calls.close, 1);
	const refused = await exe.capture.done;
	assert.deepEqual([refused.ok, !refused.ok && refused.stop.outcome, !refused.ok && refused.stop.code], [false, "unsupported", "file_content_refused"]);
	assert.deepEqual([...exe.capture.pieces()], []);

	// A web page declared as an image, shorter than the head: looked at when the response ends.
	const html = capturing({}, "image/png");
	html.filter.feed("<!doctype html><script>alert(1)</script>");
	assert.equal(html.filter.closed, false);
	html.filter.end();
	const mismatch = await html.capture.done;
	assert.deepEqual([mismatch.ok, !mismatch.ok && mismatch.stop.code], [false, "file_type_mismatch"]);
	assert.equal(html.filter.calls.close, 1);

	// The head arriving in small pieces is put together before it is judged.
	const slow = capturing({}, "application/pdf");
	for (const byte of PDF) slow.filter.feed(Uint8Array.of(byte));
	slow.filter.feed(Buffer.alloc(SNIFF_BYTES, 0x20));
	assert.equal(slow.filter.closed, false, "a PDF that is one");
	slow.filter.end();
	assert.equal((await slow.capture.done).ok, true);

	// An empty PDF is none.
	const empty = capturing();
	empty.filter.end();
	assert.equal((await empty.capture.done).ok, false);
	// An empty text file is one.
	const blank = capturing({}, "text/plain");
	blank.filter.end();
	assert.deepEqual(await blank.capture.done, { ok: true, size: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
});

test("Capture: a response that breaks off, and a job that gives up, end it once and for good", async () => {
	const broken = capturing();
	broken.filter.feed(PDF);
	broken.filter.fail("Invalid request ID");
	const end = await broken.capture.done;
	assert.deepEqual([end.ok, !end.ok && end.stop.outcome, !end.ok && end.stop.code, !end.ok && end.stop.retryable], [false, "error", "file_interrupted", true]);
	assert.equal(!end.ok && end.stop.message.includes("Invalid request ID"), false, "the browser's words are not passed on");
	assert.deepEqual([...broken.capture.pieces()], []);

	const late = capturing();
	late.filter.feed(PDF);
	late.capture.abort({ outcome: "timeout", code: "file_timeout", message: "the file did not arrive in time", retryable: true });
	assert.equal(late.filter.calls.close, 1);
	const gaveUp = await late.capture.done;
	assert.equal(!gaveUp.ok && gaveUp.stop.code, "file_timeout");
	// The first end counts: a later one changes nothing.
	late.capture.abort({ outcome: "error", code: "other", message: "x", retryable: false });
	late.filter.end();
	assert.equal(!(await late.capture.done).ok && /** @type {any} */ (await late.capture.done).stop.code, "file_timeout");

	// A filter that throws on close (its request is gone) is no error.
	const gone = new FakeFilter("9");
	gone.close = () => {
		throw new Error("gone");
	};
	const c = new Capture({ filter: gone, files: FILES, plan: { contentType: "application/pdf", charset: null, name: null, url: "https://example.com/x" } });
	assert.doesNotThrow(() => c.close());
});

// ---------------------------------------------------------------- the guard

const BASE = "moz-extension://0f8c2a3e-5b1d-4c7a-9e6f-112233445566/";
const STORE = "firefox-container-7";
const TAB = 31;

/**
 * A guard over a fake browser whose webRequest can make response filters.
 * @param {{ filters?: boolean, pdfViewer?: boolean }} [opts]
 */
function guarded(opts = {}) {
	const factory = filterFactory();
	const wr = {
		onBeforeRequest: new FakeEvent(),
		onHeadersReceived: new FakeEvent(),
		onAuthRequired: new FakeEvent(),
		onResponseStarted: new FakeEvent(),
		onErrorOccurred: new FakeEvent(),
		...(opts.filters === false ? {} : { filterResponseData: factory.filterResponseData }),
	};
	const sink = logSink();
	const guard = new Guard({
		webRequest: /** @type {any} */ (wr),
		tabs: /** @type {any} */ ({ onCreated: new FakeEvent(), onRemoved: new FakeEvent(), query: async () => [] }),
		resolve: async () => ({ addresses: ["93.184.216.34"] }),
		policy: { blocklist: DEFAULT_BLOCKLIST, allowLoopbackPorts: [] },
		extensionBase: BASE,
		storeId: () => STORE,
		pdfViewer: () => opts.pdfViewer !== false,
		log: sink.log,
		dnsTimeoutMs: 200,
	});
	guard.start();
	/** @type {import("../../extension/background/guard.js").Verdict[]} */
	const verdicts = [];
	/** @type {Capture[]} */
	const files = [];
	/**
	 * @param {"onBeforeRequest" | "onHeadersReceived"} event
	 * @param {Record<string, unknown>} request
	 * @returns {Promise<{ cancel?: true, responseHeaders?: { name: string, value?: string }[] }>}
	 */
	const raw = async (event, request) => {
		let cancel = false;
		/** @type {{ name: string, value?: string }[] | null} */
		let relabelled = null;
		for (const { fn, args } of [...wr[event].listeners]) {
			const filter = /** @type {{ types?: string[], tabId?: number, windowId?: number }} */ (args[0]);
			if (filter.tabId !== undefined && filter.tabId !== request.tabId) continue;
			if (filter.windowId !== undefined) continue;
			if (filter.types !== undefined && !filter.types.includes(String(request.type))) continue;
			const answer = /** @type {{ cancel?: unknown, responseHeaders?: any }} */ (await fn(request));
			const keys = Object.keys(answer);
			// The guard may read a response; what it answers the browser is "go on", "cancel" - or, for the response of
			// a download-type file and nothing else, "go on with these response headers".
			assert.ok(keys.length === 0 || (keys.length === 1 && (keys[0] === "cancel" || keys[0] === "responseHeaders")), `only {}, { cancel: true } or { responseHeaders }: ${JSON.stringify(answer)}`);
			if (keys[0] === "cancel") cancel = true;
			if (keys[0] === "responseHeaders") {
				// Only where the browser takes them: the top-level response headers of a request, from the one listener that was registered to get and give headers.
				assert.equal(event, "onHeadersReceived");
				assert.equal(request.type, "main_frame", "never for a frame or a sub-resource");
				assert.deepEqual(args[1], ["blocking", "responseHeaders"], "from the listener that may answer with headers");
				assert.equal(relabelled, null, "one listener only");
				relabelled = answer.responseHeaders;
			}
		}
		assert.equal(cancel && relabelled !== null, false, "never both");
		return cancel ? { cancel: true } : relabelled !== null ? { responseHeaders: relabelled } : {};
	};
	/** @param {"onBeforeRequest" | "onHeadersReceived"} event @param {Record<string, unknown>} details */
	const fire = (event, details) => raw(event, { tabId: TAB, cookieStoreId: STORE, type: "main_frame", requestId: "1", ip: "93.184.216.34", ...details });
	/** @param {Partial<import("../../extension/background/guard.js").AttachOptions>} [more] */
	const attach = (more = {}) => guard.attach(TAB, { cookieStoreId: STORE, onVerdict: (v) => verdicts.push(v), files: FILES, onFile: (c) => files.push(c), ...more });
	return { guard, wr, factory, sink, verdicts, files, raw, fire, attach };
}

const PDF_HEADERS = h({ "content-type": "application/pdf" });

test("guard: the top-level response of a job tab that is a file is let through with a filter on it, and the job is told", async () => {
	const t = guarded();
	const g = t.attach();
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/report.pdf", requestId: "41" }), {});
	assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/report.pdf", requestId: "41", statusCode: 200, responseHeaders: PDF_HEADERS }), {}, "not cancelled");
	assert.equal(t.factory.made.length, 1);
	assert.equal(t.factory.made[0].requestId, "41", "the filter is on that very request");
	assert.equal(t.files.length, 1);
	assert.equal(g.capture, t.files[0]);
	assert.deepEqual(t.files[0].plan, { contentType: "application/pdf", charset: null, name: null, url: "https://example.com/report.pdf" });
	assert.deepEqual(t.verdicts, []);
	assert.deepEqual([g.nav.httpStatus, g.nav.contentType, g.nav.finalUrl], [200, "application/pdf", "https://example.com/report.pdf"]);
	// Written down: that a file is read, and of which of five kinds. Nothing of the response.
	assert.deepEqual(t.sink.entries.filter((e) => e.event === "guard.file_capture").map((e) => e.fields), [{ kind: "pdf" }]);
	assert.equal(t.sink.text().includes("report.pdf"), false);
	// The bytes go to the capture and nowhere else.
	t.factory.made[0].feed(PDF);
	t.factory.made[0].end();
	assert.equal((await t.files[0].done).ok, true);
	assert.equal(t.factory.made[0].passedOn, 0);
	// The tab commits a document for the response all the same - an empty one. That is the response the guard let through.
	assert.equal(g.committed("https://example.com/report.pdf"), true);
	assert.deepEqual(t.verdicts, []);
	// From here on the tab asks for nothing more: not its icon, not another page.
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/favicon.ico", type: "image", requestId: "42" }), { cancel: true });
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/next", requestId: "43" }), { cancel: true });
	assert.deepEqual(t.verdicts, [], "quietly: the file is what the job is about");
	// The tab goes: its filter is closed with it.
	assert.equal(t.factory.made[0].closed, false);
	g.detach();
	assert.equal(t.factory.made[0].calls.close, 1);
	assert.deepEqual(t.factory.made[0].calls, { close: 1, write: 0, disconnect: 0, suspend: 0, resume: 0 });
});

test("guard: a redirect chain gets one filter, on its last hop; a hop to a private address is cancelled before it is sent", async () => {
	const t = guarded();
	t.attach();
	await t.fire("onBeforeRequest", { url: "https://example.com/go", requestId: "5" });
	assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/go", requestId: "5", statusCode: 302, responseHeaders: h({ location: "https://cdn.example.com/f.pdf", "content-type": "application/pdf" }) }), {});
	assert.equal(t.factory.made.length, 0, "no filter on a redirect, whatever type it claims");
	await t.fire("onBeforeRequest", { url: "https://cdn.example.com/f.pdf", requestId: "5" });
	await t.fire("onHeadersReceived", { url: "https://cdn.example.com/f.pdf", requestId: "5", statusCode: 200, responseHeaders: PDF_HEADERS });
	assert.equal(t.factory.made.length, 1);
	assert.equal(t.files[0].plan.url, "https://cdn.example.com/f.pdf");

	const p = guarded();
	p.attach();
	await p.fire("onBeforeRequest", { url: "https://example.com/go", requestId: "6" });
	await p.fire("onHeadersReceived", { url: "https://example.com/go", requestId: "6", statusCode: 302, responseHeaders: h({ location: "http://10.0.0.5/f.pdf" }) });
	assert.deepEqual(await p.fire("onBeforeRequest", { url: "http://10.0.0.5/f.pdf", requestId: "6" }), { cancel: true });
	assert.deepEqual(p.verdicts.map((v) => v.code), ["private_address"]);
	assert.equal(p.factory.made.length, 0);
	// A file that answers from a private address is refused at its headers: no filter either.
	const q = guarded();
	q.attach();
	await q.fire("onBeforeRequest", { url: "https://example.com/f.pdf" });
	assert.deepEqual(await q.fire("onHeadersReceived", { url: "https://example.com/f.pdf", statusCode: 200, ip: "192.168.1.4", responseHeaders: PDF_HEADERS }), { cancel: true });
	assert.deepEqual([q.verdicts.map((v) => v.code), q.factory.made.length], [["private_address"], 0]);
});

test("guard: only the top-level document of a job tab is ever filtered - no frame, no sub-resource, no other tab, no request without a tab", async () => {
	const t = guarded();
	t.attach();
	await t.fire("onBeforeRequest", { url: "https://example.com/" });
	await t.fire("onHeadersReceived", { url: "https://example.com/", statusCode: 200, responseHeaders: h({ "content-type": "text/html" }) });
	// What a page loads: a PDF in a frame, JSON by script, an image. Passed or cancelled as before, never read.
	for (const [type, headers] of /** @type {[string, Record<string, string>][]} */ ([
		["sub_frame", { "content-type": "application/pdf" }],
		["sub_frame", { "content-type": "application/json" }],
		["xmlhttprequest", { "content-type": "application/json" }],
		["image", { "content-type": "image/png" }],
		["object", { "content-type": "application/pdf" }],
		["other", { "content-type": "application/pdf" }],
	])) {
		await t.fire("onBeforeRequest", { url: "https://example.com/inner", type, requestId: "9" });
		await t.fire("onHeadersReceived", { url: "https://example.com/inner", type, requestId: "9", statusCode: 200, responseHeaders: h(headers) });
	}
	assert.equal(t.factory.made.length, 0);
	// The operator's own tabs, in any cookie store, and requests no tab stands behind.
	for (const who of [
		{ tabId: 3, cookieStoreId: "firefox-default" },
		{ tabId: 4, cookieStoreId: "firefox-container-9" },
		{ tabId: -1, cookieStoreId: "firefox-default" },
		{ tabId: -1, cookieStoreId: STORE },
		{ tabId: 77, cookieStoreId: STORE },
	]) {
		await t.raw("onBeforeRequest", { ...who, type: "main_frame", url: "https://example.com/report.pdf", requestId: "11" });
		await t.raw("onHeadersReceived", { ...who, type: "main_frame", url: "https://example.com/report.pdf", requestId: "11", statusCode: 200, ip: "93.184.216.34", responseHeaders: PDF_HEADERS });
	}
	assert.equal(t.factory.made.length, 0, "no filter was made for any of them");
	assert.deepEqual(t.files, []);
	// A tab that is in the container without being a job's is sealed: its file is cancelled, not read.
	const stray = t.guard.quarantine(88);
	assert.deepEqual(await t.raw("onHeadersReceived", { tabId: 88, cookieStoreId: STORE, type: "main_frame", url: "https://example.com/report.pdf", requestId: "12", statusCode: 200, responseHeaders: PDF_HEADERS }), { cancel: true });
	assert.equal(stray.capture, null);
	assert.equal(t.factory.made.length, 0);
});

test("guard: a job that brings no file back, and a tab with the operator's login, never get a filter", async () => {
	// A search, a probe, files switched off: the refusals of before, word for word.
	for (const [type, code] of [["application/pdf", "content_type"], ["application/json", "content_type_json"], ["application/xml", "content_type_xml"], ["image/png", "content_type"]]) {
		const t = guarded();
		t.attach({ files: null });
		await t.fire("onBeforeRequest", { url: "https://example.com/f" });
		assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/f", statusCode: 200, responseHeaders: h({ "content-type": type }) }), { cancel: true }, type);
		assert.deepEqual([t.verdicts.map((v) => [v.outcome, v.code]), t.factory.made.length], [[["unsupported", code]], 0], type);
	}
	// The operator's login: refused by name, cancelled at the headers, nothing read.
	const rule = { host: "forum.example.com", pathPrefix: "/", subdomains: false };
	const t = guarded();
	t.guard.attach(TAB, { cookieStoreId: "firefox-default", onVerdict: (v) => t.verdicts.push(v), files: FILES, onFile: (c) => t.files.push(c), scope: { rule, policy: {}, url: "https://forum.example.com/export" } });
	await t.raw("onBeforeRequest", { tabId: TAB, cookieStoreId: "firefox-default", type: "main_frame", url: "https://forum.example.com/export", requestId: "3" });
	assert.deepEqual(await t.raw("onHeadersReceived", { tabId: TAB, cookieStoreId: "firefox-default", type: "main_frame", url: "https://forum.example.com/export", requestId: "3", statusCode: 200, ip: "93.184.216.34", responseHeaders: PDF_HEADERS }), { cancel: true });
	assert.deepEqual(t.verdicts.map((v) => [v.outcome, v.code]), [["policy_blocked", "file_login_scope"]]);
	assert.deepEqual([t.factory.made.length, t.files.length], [0, 0]);
});

/** @param {{ name: string, value?: string }[]} headers @returns {Record<string, string>} by lowercase name; a name that stands twice fails */
function byName(headers) {
	/** @type {Record<string, string>} */
	const out = {};
	for (const { name, value } of headers) {
		assert.equal(Object.hasOwn(out, name.toLowerCase()), false, `${name} stands twice`);
		out[name.toLowerCase()] = value ?? "";
	}
	return out;
}

/** What the browser would save, in the headers a server sends it with: [headers, the declared type it is judged by]. */
const SAVED = /** @type {[Record<string, string>, string][]} */ ([
	[{ "content-type": "application/pdf", "content-disposition": 'attachment; filename="x.pdf"' }, "application/pdf"],
	[{ "content-type": "application/zip", "content-disposition": "attachment" }, "application/zip"],
	[{ "content-type": "application/zip" }, "application/zip"],
	[{ "content-type": "application/gzip" }, "application/gzip"],
	[{ "content-type": "application/x-tar" }, "application/x-tar"],
	[{ "content-type": "application/octet-stream" }, "application/octet-stream"],
	[{ "content-type": "text/csv" }, "text/csv"],
	[{ "content-type": "application/rss+xml" }, "application/rss+xml"],
	[{}, "application/octet-stream"],
	[{ "content-type": "text/plain" }, "text/plain"],
	// What the browser saves for its Content-Disposition without the word "attachment" in it.
	[{ "content-type": "application/pdf", "content-disposition": 'download; filename="x.pdf"' }, "application/pdf"],
	[{ "content-type": "application/json", "content-disposition": "x" }, "application/json"],
	[{ "content-type": "image/png", "content-disposition": '"inline"' }, "image/png"],
	// A Content-Type the browser reads as another type than its first word says is no type to go by.
	[{ "content-type": "text/html;,application/pdf" }, "application/octet-stream"],
	[{ "content-type": "text/html;,application/zip" }, "application/octet-stream"],
	[{ "content-type": "application/pdf, text/html" }, "application/octet-stream"],
	[{ "content-type": "application/pdf\u000b" }, "application/octet-stream"],
]);

// Changed for 0.1.7: until then ETag and Cache-Control stayed as the server sent
// them, and the browser's cache kept the response without its Content-Disposition.
test("relabelForCapture: the server's headers without Content-Disposition, with one fixed type and nosniff, and nothing a cache could keep the response by - and nothing else touched", () => {
	const sent = h({
		Date: "Tue, 06 Oct 2026 10:00:00 GMT",
		"Content-Type": "application/zip",
		"content-disposition": 'attachment; filename="a.zip"',
		"Content-Length": "1234",
		"Content-Encoding": "gzip",
		"X-Content-Type-Options": "something",
		"Set-Cookie": "a=1; Path=/",
		ETag: '"v1"',
		"Cache-Control": "max-age=60",
		Expires: "Wed, 07 Oct 2026 10:00:00 GMT",
		"Last-Modified": "Tue, 01 Sep 2026 10:00:00 GMT",
		Pragma: "public",
		Vary: "Accept-Encoding",
		Age: "5",
		Link: "</x.css>; rel=preload",
	});
	const before = JSON.stringify(sent);
	const out = relabelForCapture(sent);
	assert.equal(JSON.stringify(sent), before, "what the browser handed over is not changed");
	assert.deepEqual(byName(out), {
		date: "Tue, 06 Oct 2026 10:00:00 GMT",
		"content-length": "1234",
		"content-encoding": "gzip",
		"set-cookie": "a=1; Path=/",
		vary: "Accept-Encoding",
		age: "5",
		link: "</x.css>; rel=preload",
		"content-type": "text/json",
		"x-content-type-options": "nosniff",
		// The server's own word on caching, and what a later request could ask "not modified?" by, are gone.
		"cache-control": "no-store",
	});
	// The lines that stay are the very objects the browser reported: no value of them is made here.
	for (const line of out.slice(0, -3)) assert.ok(/** @type {object[]} */ (sent).includes(line));
	assert.deepEqual(out.slice(-3), [{ name: "Content-Type", value: "text/json" }, { name: "X-Content-Type-Options", value: "nosniff" }, { name: "Cache-Control", value: "no-store" }]);
	assert.equal(RELABEL_TYPE, "text/json");
	// Whatever a server sends of those, however often and however spelled: none of it survives, and the three that are set stand once.
	const odd = relabelForCapture([
		{ name: "CONTENT-TYPE", value: "text/html" },
		{ name: "content-type", value: "application/zip" },
		{ name: "Content-Disposition", value: "attachment" },
		{ name: "content-disposition", value: "inline" },
		{ name: "x-content-type-options" },
		{ name: "CACHE-CONTROL", value: "public, max-age=31536000, immutable" },
		{ name: "cache-control", value: "s-maxage=10" },
		{ name: "EXPIRES", value: "Thu, 01 Jan 2099 00:00:00 GMT" },
		{ name: "etag", value: 'W/"x"' },
		{ name: "LAST-MODIFIED", value: "Tue, 01 Sep 2026 10:00:00 GMT" },
		{ name: "pragma", value: "no-cache" },
		{ name: "X-Other", value: "1" },
	]);
	assert.deepEqual(odd, [{ name: "X-Other", value: "1" }, { name: "Content-Type", value: "text/json" }, { name: "X-Content-Type-Options", value: "nosniff" }, { name: "Cache-Control", value: "no-store" }]);
	assert.deepEqual(relabelForCapture([]), [{ name: "Content-Type", value: "text/json" }, { name: "X-Content-Type-Options", value: "nosniff" }, { name: "Cache-Control", value: "no-store" }]);
});

test("guard: what the browser would save is let through with a filter on it AND other response headers - in the same answer, for the job tab's top-level response only", async () => {
	for (const [headers, declared] of SAVED) {
		const t = guarded();
		const g = t.attach();
		const sent = h({ ...headers, "content-length": "20", "set-cookie": "a=1" });
		await t.fire("onBeforeRequest", { url: "https://example.com/f", requestId: "7" });
		const answer = await t.fire("onHeadersReceived", { url: "https://example.com/f", requestId: "7", statusCode: 200, responseHeaders: sent });
		assert.deepEqual(Object.keys(answer), ["responseHeaders"], JSON.stringify(headers));
		assert.deepEqual(byName(/** @type {any} */ (answer).responseHeaders), { "content-length": "20", "set-cookie": "a=1", "content-type": "text/json", "x-content-type-options": "nosniff", "cache-control": "no-store" }, JSON.stringify(headers));
		// The filter was made in that call, on that request, before the answer went back.
		assert.equal(t.factory.made.length, 1);
		assert.equal(t.factory.made[0].requestId, "7");
		assert.equal(g.capture, t.files[0]);
		// What the job is told of the file is what the server said, read before anything was changed.
		assert.equal(t.files[0].plan.contentType, declared);
		assert.equal(t.files[0].plan.relabel, true);
		assert.deepEqual([g.nav.httpStatus, g.nav.contentType], [200, mediaType(headers["content-type"] ?? null)], "the record of the navigation holds the server's own type, where it names one");
		assert.deepEqual(t.verdicts, []);
		assert.deepEqual(t.sink.entries.filter((e) => e.event === "guard.file_capture").map((e) => e.fields), [{ kind: /** @type {Record<string, string>} */ ({ "application/pdf": "pdf", "text/plain": "text", "application/json": "json", "image/png": "image" })[declared] ?? "other", relabelled: true }]);
		// The empty document the tab commits for it is the response the guard let through, and the tab asks for nothing more.
		assert.equal(g.committed("https://example.com/f"), true);
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/x.css", type: "stylesheet", requestId: "8" }), { cancel: true });
		t.factory.made[0].feed("abc");
		assert.equal(t.factory.made[0].passedOn, 0);
	}
	// The name a server suggests for an attachment travels as it stands; the daemon makes a label of it.
	const n = guarded();
	n.attach();
	await n.fire("onBeforeRequest", { url: "https://example.com/get?id=5" });
	await n.fire("onHeadersReceived", { url: "https://example.com/get?id=5", statusCode: 200, responseHeaders: h({ "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="../q3 data.zip"' }) });
	assert.deepEqual(n.files[0].plan, { contentType: "application/zip", charset: null, name: "../q3 data.zip", url: "https://example.com/get?id=5", relabel: true });
	// A PDF where the browser shows none itself.
	const off = guarded({ pdfViewer: false });
	off.attach();
	await off.fire("onBeforeRequest", { url: "https://example.com/f.pdf" });
	assert.deepEqual(Object.keys(await off.fire("onHeadersReceived", { url: "https://example.com/f.pdf", statusCode: 200, responseHeaders: PDF_HEADERS })), ["responseHeaders"]);
	assert.equal(off.factory.made.length, 1);
});

test("guard: response headers are never answered with for anything else - a page, a shown file, a redirect, a frame, a sub-resource, another tab, a stray, the operator's login, a job without files, a type off the list", async () => {
	const ZIP = h({ "content-type": "application/zip", "content-disposition": 'attachment; filename="a.zip"' });
	// A page and a file the browser shows by itself: let through as they are.
	for (const headers of /** @type {Record<string, string>[]} */ ([{ "content-type": "text/html" }, { "content-type": "application/pdf" }, { "content-type": "application/json" }, { "content-type": "text/plain", "x-content-type-options": "nosniff" }, { "content-type": "image/png" }])) {
		const t = guarded();
		t.attach();
		await t.fire("onBeforeRequest", { url: "https://example.com/x" });
		assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/x", statusCode: 200, responseHeaders: h(headers) }), {}, JSON.stringify(headers));
	}
	// A page offered as a download is refused as ever, also where the operator's list names HTML: a page is never read as a file.
	for (const type of ["text/html", "application/xhtml+xml"]) {
		const t = guarded();
		t.attach({ files: { maxBytes: 1048576, types: [...DEFAULT_ALLOW_TYPES, "text/html", "application/xhtml+xml"] } });
		await t.fire("onBeforeRequest", { url: "https://example.com/page" });
		assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/page", statusCode: 200, responseHeaders: h({ "content-type": type, "content-disposition": "attachment" }) }), { cancel: true }, type);
		assert.deepEqual([t.verdicts.map((v) => v.code), t.factory.made.length], [["attachment"], 0]);
	}
	// A redirect hop that claims to be a download: nothing is read and nothing changed; an error status: refused.
	const r = guarded();
	r.attach();
	await r.fire("onBeforeRequest", { url: "https://example.com/go" });
	assert.deepEqual(await r.fire("onHeadersReceived", { url: "https://example.com/go", statusCode: 302, responseHeaders: h({ location: "https://example.com/a.zip", "content-type": "application/zip", "content-disposition": "attachment" }) }), {});
	assert.equal(r.factory.made.length, 0);
	const e = guarded();
	e.attach();
	await e.fire("onBeforeRequest", { url: "https://example.com/a.zip" });
	assert.deepEqual(await e.fire("onHeadersReceived", { url: "https://example.com/a.zip", statusCode: 404, responseHeaders: ZIP }), { cancel: true });
	assert.deepEqual(e.verdicts.map((v) => v.code), ["file_http_error"]);
	// Inside a page of a job tab: a frame that would download is cancelled as before, a sub-resource passes untouched.
	const t = guarded();
	t.attach();
	await t.fire("onBeforeRequest", { url: "https://example.com/" });
	await t.fire("onHeadersReceived", { url: "https://example.com/", statusCode: 200, responseHeaders: h({ "content-type": "text/html" }) });
	await t.fire("onBeforeRequest", { url: "https://example.com/a.zip", type: "sub_frame", requestId: "2" });
	assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/a.zip", type: "sub_frame", requestId: "2", statusCode: 200, responseHeaders: ZIP }), { cancel: true });
	for (const type of ["xmlhttprequest", "image", "script", "object", "media", "other", "beacon"]) {
		await t.fire("onBeforeRequest", { url: "https://example.com/a.zip", type, requestId: "3" });
		assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/a.zip", type, requestId: "3", statusCode: 200, responseHeaders: ZIP }), {}, type);
	}
	// The operator's own tabs in any cookie store, and requests no tab stands behind: no objection, nothing else.
	for (const who of [
		{ tabId: 3, cookieStoreId: "firefox-default" },
		{ tabId: 4, cookieStoreId: "firefox-container-9" },
		{ tabId: -1, cookieStoreId: "firefox-default" },
	]) {
		await t.raw("onBeforeRequest", { ...who, type: "main_frame", url: "https://example.com/a.zip", requestId: "11" });
		assert.deepEqual(await t.raw("onHeadersReceived", { ...who, type: "main_frame", url: "https://example.com/a.zip", requestId: "11", statusCode: 200, ip: "93.184.216.34", responseHeaders: ZIP }), {}, JSON.stringify(who));
	}
	// A tab in the container that is no job's, and a container request without a tab: cancelled, as before.
	t.guard.quarantine(88);
	assert.deepEqual(await t.raw("onHeadersReceived", { tabId: 88, cookieStoreId: STORE, type: "main_frame", url: "https://example.com/a.zip", requestId: "12", statusCode: 200, responseHeaders: ZIP }), { cancel: true });
	assert.equal(t.factory.made.length, 0, "and no filter was made for any of this");
	assert.deepEqual(t.files, []);

	// A job that brings no file back: the guard's refusals of before, word for word.
	for (const [headers] of SAVED) {
		const none = guarded();
		none.attach({ files: null });
		await none.fire("onBeforeRequest", { url: "https://example.com/f" });
		assert.deepEqual(await none.fire("onHeadersReceived", { url: "https://example.com/f", statusCode: 200, responseHeaders: h(headers) }), { cancel: true });
		assert.deepEqual([none.verdicts.map((v) => [v.outcome, v.code]), none.factory.made.length], [[["unsupported", /** @type {any} */ (classifyResponse(200, h(headers))).code]], 0], JSON.stringify(headers));
	}
	assert.deepEqual(SAVED.map(([headers]) => /** @type {any} */ (classifyResponse(200, h(headers))).code), ["attachment", "attachment", "content_type", "content_type", "content_type", "content_type", "content_type", "content_type_xml", "content_type_missing", "plain_text_sniffable", "attachment", "attachment", "attachment", "content_type_missing", "content_type_missing", "content_type_missing", "content_type_missing"]);
	// A type that is not on the list the daemon sent.
	const few = guarded();
	few.attach({ files: { maxBytes: 1048576, types: ["application/pdf"] } });
	await few.fire("onBeforeRequest", { url: "https://example.com/a.zip" });
	assert.deepEqual(await few.fire("onHeadersReceived", { url: "https://example.com/a.zip", statusCode: 200, responseHeaders: ZIP }), { cancel: true });
	assert.deepEqual([few.verdicts.map((v) => v.code), few.factory.made.length], [["file_type_not_allowed"], 0]);
	// The operator's login: refused by name at the headers; nothing read, nothing changed.
	const rule = { host: "forum.example.com", pathPrefix: "/", subdomains: false };
	for (const [headers] of SAVED) {
		const l = guarded();
		l.guard.attach(TAB, { cookieStoreId: "firefox-default", onVerdict: (v) => l.verdicts.push(v), files: FILES, onFile: (c) => l.files.push(c), scope: { rule, policy: {}, url: "https://forum.example.com/export" } });
		await l.raw("onBeforeRequest", { tabId: TAB, cookieStoreId: "firefox-default", type: "main_frame", url: "https://forum.example.com/export", requestId: "3" });
		assert.deepEqual(await l.raw("onHeadersReceived", { tabId: TAB, cookieStoreId: "firefox-default", type: "main_frame", url: "https://forum.example.com/export", requestId: "3", statusCode: 200, ip: "93.184.216.34", responseHeaders: h(headers) }), { cancel: true }, JSON.stringify(headers));
		assert.deepEqual([l.verdicts.map((v) => [v.outcome, v.code]), l.factory.made.length, l.files.length], [[["policy_blocked", "file_login_scope"]], 0, 0]);
	}
});

test("guard: the conditions of the header exception are checked where the headers are made - a response that fails one is not let through at all", async () => {
	const ZIP = h({ "content-type": "application/zip", "content-disposition": "attachment" });
	/** @type {[string, (t: ReturnType<typeof guarded>) => Promise<object>][]} each plays a response the plan would read under other headers, with one condition broken */
	const broken = [
		["the response carries another cookie store than the container's", async (t) => {
			t.attach();
			await t.fire("onBeforeRequest", { url: "https://example.com/a.zip" });
			return t.fire("onHeadersReceived", { url: "https://example.com/a.zip", cookieStoreId: "firefox-default", statusCode: 200, responseHeaders: ZIP });
		}],
		["the response names no cookie store", async (t) => {
			t.attach();
			await t.fire("onBeforeRequest", { url: "https://example.com/a.zip" });
			return t.fire("onHeadersReceived", { url: "https://example.com/a.zip", cookieStoreId: undefined, statusCode: 200, responseHeaders: ZIP });
		}],
		["the job tab was attached with a store that is not the container's", async (t) => {
			t.attach({ cookieStoreId: "firefox-container-9" });
			await t.raw("onBeforeRequest", { tabId: TAB, cookieStoreId: "firefox-container-9", type: "main_frame", requestId: "1", url: "https://example.com/a.zip" });
			return t.raw("onHeadersReceived", { tabId: TAB, cookieStoreId: "firefox-container-9", type: "main_frame", requestId: "1", ip: "93.184.216.34", url: "https://example.com/a.zip", statusCode: 200, responseHeaders: ZIP });
		}],
		["it is not the request that was last asked for", async (t) => {
			t.attach();
			await t.fire("onBeforeRequest", { url: "https://example.com/a.zip", requestId: "1" });
			return t.fire("onHeadersReceived", { url: "https://example.com/a.zip", requestId: "2", statusCode: 200, responseHeaders: ZIP });
		}],
		["the response has no request id", async (t) => {
			t.attach();
			await t.fire("onBeforeRequest", { url: "https://example.com/a.zip", requestId: undefined });
			return t.fire("onHeadersReceived", { url: "https://example.com/a.zip", requestId: undefined, statusCode: 200, responseHeaders: ZIP });
		}],
	];
	for (const [label, play] of broken) {
		const t = guarded();
		assert.deepEqual(await play(t), { cancel: true }, label);
		assert.deepEqual([t.verdicts.map((v) => v.code), t.factory.made.length, t.files.length], [["file_capture_unavailable"], 0, 0], label);
	}
	// And without a way to read the response nothing is changed either: the tab would show the bytes as text.
	const none = guarded({ filters: false });
	none.attach();
	await none.fire("onBeforeRequest", { url: "https://example.com/a.zip" });
	assert.deepEqual(await none.fire("onHeadersReceived", { url: "https://example.com/a.zip", statusCode: 200, responseHeaders: ZIP }), { cancel: true });
	assert.deepEqual(none.verdicts.map((v) => v.code), ["file_capture_unavailable"]);
	const throwing = guarded();
	/** @type {any} */ (throwing.wr).filterResponseData = () => {
		throw new Error("Invalid request ID");
	};
	throwing.attach();
	await throwing.fire("onBeforeRequest", { url: "https://example.com/a.zip" });
	assert.deepEqual(await throwing.fire("onHeadersReceived", { url: "https://example.com/a.zip", statusCode: 200, responseHeaders: ZIP }), { cancel: true });
	// Listening to everything (the way back when request filters select nothing): the same answers, and still only for the job tab.
	const wide = guarded();
	wide.guard.widen("test");
	wide.attach();
	await wide.fire("onBeforeRequest", { url: "https://example.com/a.zip" });
	assert.deepEqual(Object.keys(await wide.fire("onHeadersReceived", { url: "https://example.com/a.zip", statusCode: 200, responseHeaders: ZIP })), ["responseHeaders"]);
	assert.deepEqual(await wide.raw("onHeadersReceived", { tabId: 3, cookieStoreId: "firefox-default", type: "main_frame", url: "https://example.com/a.zip", requestId: "11", statusCode: 200, ip: "93.184.216.34", responseHeaders: ZIP }), {});
	assert.deepEqual(await wide.raw("onHeadersReceived", { tabId: 77, cookieStoreId: STORE, type: "main_frame", url: "https://example.com/a.zip", requestId: "12", statusCode: 200, ip: "93.184.216.34", responseHeaders: ZIP }), { cancel: true });
	assert.equal(wide.factory.made.length, 1);
});

// Measured (the table in capture.js): the browser saves such a response as it came, and unpacks it once when it is
// shown instead. Until now it was read under other headers all the same, and refused only when its first bytes
// were not those of a gzip file.
test("a gzip file sent with Content-Encoding: gzip is never read under other response headers: refused at the headers, before a filter is made or a byte is read", async () => {
	const capture = (/** @type {any} */ p) => (p !== null && "capture" in p ? p.capture : null);
	const refusal = (/** @type {any} */ p) => (p !== null && "refuse" in p ? [p.refuse.outcome, p.refuse.code] : null);
	/** @type {Record<string, string>[]} */
	const twice = [
		{ "content-type": "application/gzip", "content-encoding": "gzip" },
		{ "content-type": "application/x-gzip", "content-encoding": "gzip" },
		{ "Content-Type": "Application/GZip", "Content-Encoding": "GZIP" },
		{ "content-type": "application/gzip; charset=binary", "content-encoding": " gzip " },
		{ "content-type": "application/gzip", "content-encoding": "x-gzip" },
		{ "content-type": "application/gzip", "content-encoding": "identity, gzip" },
		{ "content-type": "application/gzip", "content-encoding": "gzip", "content-disposition": 'attachment; filename="backup.tar.gz"' },
	];
	const withGzip = { maxBytes: 1048576, types: [...DEFAULT_ALLOW_TYPES, "application/x-gzip"] };
	for (const headers of twice) {
		assert.deepEqual(refusal(plan(200, headers, { files: withGzip })), ["unsupported", "file_type_mismatch"], JSON.stringify(headers));
		assert.equal(gzipSentEncoded(/** @type {string} */ (classifyResponse(200, h(headers)).contentType), h(headers)), true, JSON.stringify(headers));
		// The rules that come before it stand as they were.
		assert.equal(plan(200, headers, { files: null }), null);
		assert.deepEqual(refusal(plan(200, headers, { files: withGzip, login: true })), ["policy_blocked", "file_login_scope"]);
		assert.deepEqual(refusal(plan(200, headers, { files: { maxBytes: 1000, types: ["application/pdf"] } })), ["unsupported", "file_type_not_allowed"]);
		assert.deepEqual(refusal(plan(404, headers, { files: withGzip })), ["unsupported", "file_http_error"]);
	}
	assert.equal(/** @type {any} */ (plan(200, twice[0])).refuse.message.includes("example.com"), false, "no address in the message");
	// Two lines of the header are one list.
	assert.equal(gzipSentEncoded("application/gzip", [{ name: "Content-Encoding", value: "identity" }, { name: "content-encoding", value: "gzip" }]), true);

	// Not that case: a gzip file that is sent as it is, and every other type under that encoding - read as before.
	/** @type {[Record<string, string>, boolean][]} headers, and whether they are read under other headers */
	const others = [
		[{ "content-type": "application/gzip" }, true],
		[{ "content-type": "application/gzip", "content-encoding": "" }, true],
		[{ "content-type": "application/gzip", "content-encoding": "identity" }, true],
		[{ "content-type": "application/gzip", "content-encoding": "br" }, true],
		[{ "content-type": "application/gzip", "content-encoding": "gzipped" }, true],
		[{ "content-type": "application/zip", "content-encoding": "gzip" }, true],
		[{ "content-type": "text/csv", "content-encoding": "gzip" }, true],
		[{ "content-type": "application/octet-stream", "content-encoding": "gzip", "content-disposition": 'attachment; filename="backup.tar.gz"' }, true],
		[{ "content-type": "application/json", "content-encoding": "gzip" }, false],
		[{ "content-type": "application/pdf", "content-encoding": "gzip" }, false],
	];
	for (const [headers, relabel] of others) {
		assert.equal(capture(plan(200, headers))?.relabel, relabel ? true : undefined, JSON.stringify(headers));
		assert.equal(gzipSentEncoded(/** @type {string} */ (classifyResponse(200, h(headers)).contentType), h(headers)), false, JSON.stringify(headers));
	}

	// Through the guard: the request is cancelled at the headers. No filter, no other headers, and the job is told why.
	for (const headers of twice.slice(0, 2)) {
		const t = guarded();
		t.attach({ files: withGzip });
		await t.fire("onBeforeRequest", { url: "https://example.com/backup.tar.gz" });
		assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/backup.tar.gz", statusCode: 200, responseHeaders: h(headers) }), { cancel: true });
		assert.deepEqual([t.verdicts.map((v) => [v.outcome, v.code]), t.factory.made.length, t.files.length], [[["unsupported", "file_type_mismatch"]], 0, 0]);
	}
	// The same file without the second header is read as it was.
	const plain = guarded();
	plain.attach();
	await plain.fire("onBeforeRequest", { url: "https://example.com/backup.tar.gz" });
	assert.deepEqual(Object.keys(await plain.fire("onHeadersReceived", { url: "https://example.com/backup.tar.gz", statusCode: 200, responseHeaders: h({ "content-type": "application/gzip" }) })), ["responseHeaders"]);
	assert.equal(plain.factory.made.length, 1);
});

// Until 0.1.6 the second of two 200 headers events for one request made a second
// filter, and the first was left behind with nobody to close it.
test("guard: headers that come once more while a response is read as a file are refused - no second filter, no page in that tab, and the first filter is closed with the job", async () => {
	const ZIP = h({ "content-type": "application/zip", "content-disposition": "attachment" });
	/** @type {[string, { name: string, value: string }[], { name: string, value: string }[], Record<string, unknown>][]} the first response, what comes after it, and under which request */
	const cases = [
		["the same file again", PDF_HEADERS, PDF_HEADERS, {}],
		["a download-type file after a shown one", PDF_HEADERS, ZIP, {}],
		["a shown file after a download-type one", ZIP, PDF_HEADERS, {}],
		["a download-type file twice", ZIP, ZIP, {}],
		["a page after a file", PDF_HEADERS, h({ "content-type": "text/html" }), {}],
		["the browser's stored copy after a file", PDF_HEADERS, PDF_HEADERS, { fromCache: true }],
		["another request of the top frame", PDF_HEADERS, PDF_HEADERS, { requestId: "42" }],
		["a refusal after a file", PDF_HEADERS, h({ "content-type": "video/mp4" }), {}],
		["an error status after a file", PDF_HEADERS, PDF_HEADERS, { statusCode: 404 }],
		["a 304 after a file", PDF_HEADERS, h({ etag: '"v1"' }), { statusCode: 304 }],
		["a redirect after a file", PDF_HEADERS, h({ location: "https://example.com/next" }), { statusCode: 302 }],
	];
	for (const [label, first, second, more] of cases) {
		const t = guarded();
		const g = t.attach();
		await t.fire("onBeforeRequest", { url: "https://example.com/f", requestId: "41" });
		const answer = await t.fire("onHeadersReceived", { url: "https://example.com/f", requestId: "41", statusCode: 200, responseHeaders: first });
		assert.equal("cancel" in answer, false, label);
		assert.equal(t.factory.made.length, 1, label);
		const capture = g.capture;
		assert.ok(capture, label);
		t.factory.made[0].feed("%PDF-1.4 ");
		assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/f", requestId: "41", statusCode: 200, responseHeaders: second, ...more }), { cancel: true }, label);
		assert.equal(t.factory.made.length, 1, `${label}: no second filter`);
		assert.equal(g.capture, capture, `${label}: the capture of the tab is still the first`);
		assert.deepEqual(t.files, [capture], `${label}: the job was told of one file`);
		assert.deepEqual(t.verdicts.map((v) => [v.outcome, v.code]), [["error", "response_repeated"]], label);
		assert.equal(g.open, false, `${label}: the tab loads nothing more`);
		// The job ends on the verdict and lets go of its tab: the one filter there is gets closed, once.
		assert.equal(t.factory.made[0].closed, false);
		g.detach();
		assert.deepEqual(t.factory.made.map((f) => f.calls), [{ close: 1, write: 0, disconnect: 0, suspend: 0, resume: 0 }], `${label}: no filter is left open`);
		assert.equal(t.factory.made[0].passedOn, 0);
	}
	// Whatever is fired at a tab, in any order: every filter that was ever made belongs to the capture of its tab.
	const statuses = [200, 200, 200, 304, 404, 302];
	const kinds = [PDF_HEADERS, ZIP, h({ "content-type": "text/html" }), h({ "content-type": "application/json" }), h({}), h({ etag: '"v1"' })];
	let x = 7;
	const next = (/** @type {number} */ n) => (x = (x * 1103515245 + 12345) & 0x7fffffff) % n;
	for (let round = 0; round < 300; round++) {
		const t = guarded();
		const g = t.attach();
		for (let step = 0; step < 6; step++) {
			const requestId = String(1 + next(2));
			if (next(3) === 0) await t.fire("onBeforeRequest", { url: "https://example.com/f", requestId });
			else await t.fire("onHeadersReceived", { url: "https://example.com/f", requestId, statusCode: statuses[next(statuses.length)], responseHeaders: kinds[next(kinds.length)] });
			assert.ok(t.factory.made.length <= 1, `round ${round}: at most one filter per tab`);
			assert.equal(t.factory.made.length, g.capture === null ? 0 : 1, `round ${round}: a filter without a capture`);
		}
		g.detach();
		assert.equal(t.factory.made.every((f) => f.calls.close === 1), true, `round ${round}: every filter is closed with the tab`);
	}
});

const PAGE_HEADERS = h({ "content-type": "text/html; charset=utf-8", etag: '"v1"' });

test("guard: 304 Not Modified for the top-level request is not the end - what the browser has stored comes next under the same request, and is judged then", async () => {
	// A page the browser has stored: the server's 304 passes without a judgement, the stored response is the page.
	const t = guarded();
	const g = t.attach();
	await t.fire("onBeforeRequest", { url: "https://example.com/page", requestId: "5" });
	assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/page", requestId: "5", statusCode: 304, responseHeaders: h({ etag: '"v1"' }) }), {});
	assert.deepEqual(t.verdicts, [], "no verdict on a 304");
	assert.deepEqual([g.nav.httpStatus, g.nav.contentType], [304, null]);
	assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/page", requestId: "5", statusCode: 200, fromCache: true, responseHeaders: PAGE_HEADERS }), {});
	assert.deepEqual([g.nav.httpStatus, g.nav.contentType], [200, "text/html"], "the status of the response the tab is given");
	assert.equal(g.committed("https://example.com/page"), true);
	assert.deepEqual(t.verdicts, []);
	assert.equal(t.sink.entries.filter((e) => e.event === "guard.not_modified").length, 1);

	// A file the browser has stored: the filter is made for the stored response, not for the 304.
	const f = guarded();
	f.attach();
	await f.fire("onBeforeRequest", { url: "https://example.com/data.json", requestId: "6" });
	assert.deepEqual(await f.fire("onHeadersReceived", { url: "https://example.com/data.json", requestId: "6", statusCode: 304, responseHeaders: h({ etag: '"v1"', "cache-control": "no-cache" }) }), {});
	assert.equal(f.factory.made.length, 0);
	assert.deepEqual(await f.fire("onHeadersReceived", { url: "https://example.com/data.json", requestId: "6", statusCode: 200, fromCache: true, responseHeaders: h({ "content-type": "application/json", etag: '"v1"' }) }), {});
	assert.equal(f.factory.made.length, 1);
	assert.equal(f.files[0].plan.contentType, "application/json");
	// A stored download: read under other headers, like one that came from the network.
	const z = guarded();
	z.attach();
	await z.fire("onBeforeRequest", { url: "https://example.com/a.zip", requestId: "7" });
	assert.deepEqual(await z.fire("onHeadersReceived", { url: "https://example.com/a.zip", requestId: "7", statusCode: 304, responseHeaders: h({ etag: '"v1"' }) }), {});
	const answer = await z.fire("onHeadersReceived", { url: "https://example.com/a.zip", requestId: "7", statusCode: 200, fromCache: true, responseHeaders: h({ "content-type": "application/zip", "content-disposition": "attachment", etag: '"v1"' }) });
	// (Since 0.1.7 the browser keeps nothing of a response that was read this way, so this no longer comes about by
	// the gateway's own doing; a response that was stored some other way is still read like this - without its ETag.)
	assert.deepEqual(byName(/** @type {any} */ (answer).responseHeaders), { "content-type": "text/json", "x-content-type-options": "nosniff", "cache-control": "no-store" });
	assert.equal(z.factory.made.length, 1);
	// What is stored is judged like anything else: a stored response that is refused is refused.
	const x = guarded();
	x.attach({ files: null });
	await x.fire("onBeforeRequest", { url: "https://example.com/a.zip", requestId: "8" });
	await x.fire("onHeadersReceived", { url: "https://example.com/a.zip", requestId: "8", statusCode: 304, responseHeaders: [] });
	assert.deepEqual(await x.fire("onHeadersReceived", { url: "https://example.com/a.zip", requestId: "8", statusCode: 200, fromCache: true, responseHeaders: h({ "content-type": "application/zip" }) }), { cancel: true });
	assert.deepEqual(x.verdicts.map((v) => v.code), ["content_type"]);
	// A 304 from a private address is refused like any answer from there.
	const p = guarded();
	p.attach();
	await p.fire("onBeforeRequest", { url: "https://example.com/page" });
	assert.deepEqual(await p.fire("onHeadersReceived", { url: "https://example.com/page", statusCode: 304, ip: "10.0.0.7", responseHeaders: [] }), { cancel: true });
	assert.deepEqual(p.verdicts.map((v) => v.code), ["private_address"]);
	// With the operator's login the same holds: the stored page is read, a stored file is refused by name.
	const rule = { host: "forum.example.com", pathPrefix: "/", subdomains: false };
	const l = guarded();
	const lg = l.guard.attach(TAB, { cookieStoreId: "firefox-default", onVerdict: (v) => l.verdicts.push(v), files: FILES, scope: { rule, policy: {}, url: "https://forum.example.com/t/1" } });
	const who = { tabId: TAB, cookieStoreId: "firefox-default", type: "main_frame", requestId: "9", ip: "93.184.216.34", url: "https://forum.example.com/t/1" };
	await l.raw("onBeforeRequest", who);
	assert.deepEqual(await l.raw("onHeadersReceived", { ...who, statusCode: 304, responseHeaders: [] }), {});
	assert.deepEqual(await l.raw("onHeadersReceived", { ...who, statusCode: 200, fromCache: true, responseHeaders: PAGE_HEADERS }), {});
	assert.equal(lg.committed("https://forum.example.com/t/1"), true);
	assert.deepEqual(l.verdicts, []);
});

test("guard: a 304 nobody asked for ends the job as before - at the headers when it names a Content-Disposition, else when the tab has nothing to show for it", async () => {
	// With a Content-Disposition of its own it is cancelled at once (measured: the browser would open a tab for it).
	const cd = guarded();
	const cg = cd.attach();
	await cd.fire("onBeforeRequest", { url: "https://example.com/a.zip" });
	assert.deepEqual(await cd.fire("onHeadersReceived", { url: "https://example.com/a.zip", statusCode: 304, responseHeaders: h({ "content-type": "application/zip", "content-disposition": "attachment" }) }), { cancel: true });
	assert.deepEqual(cd.verdicts.map((v) => [v.outcome, v.code]), [["unsupported", "no_content"]]);
	assert.equal(cg.nav.httpStatus, 304);
	// Without one it passes; nothing stored follows; the tab commits an empty document: the end, with the old words.
	const t = guarded();
	const g = t.attach();
	await t.fire("onBeforeRequest", { url: "https://example.com/page", requestId: "5" });
	assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/page", requestId: "5", statusCode: 304, responseHeaders: h({ "content-type": "text/html" }) }), {});
	assert.equal(t.verdicts.length, 0);
	assert.equal(g.committed("https://example.com/page"), false);
	assert.deepEqual(t.verdicts.map((v) => [v.outcome, v.code, v.message]), [["unsupported", "no_content", "the server answered without a page"]]);
	assert.equal(g.nav.httpStatus, 304);
	assert.equal(g.open, false, "sealed");
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/next", requestId: "6" }), { cancel: true });
	// Or the browser shows its error page for it (a type it would save): the same end, told by the failed request.
	const e = guarded();
	const eg = e.attach();
	await e.fire("onBeforeRequest", { url: "https://example.com/a.zip", requestId: "5" });
	assert.deepEqual(await e.fire("onHeadersReceived", { url: "https://example.com/a.zip", requestId: "5", statusCode: 304, responseHeaders: h({ "content-type": "application/zip" }) }), {});
	eg.requestFailed({ tabId: TAB, type: "main_frame", url: "https://example.com/a.zip", requestId: "5" });
	assert.deepEqual(e.verdicts.map((v) => v.code), ["no_content"]);
	assert.equal(eg.committed("https://example.com/a.zip"), true, "the error page is the browser's own");
	// ... or by the navigation that failed, whichever is told first.
	const n = guarded();
	const ng = n.attach();
	await n.fire("onBeforeRequest", { url: "https://example.com/a.zip", requestId: "5" });
	await n.fire("onHeadersReceived", { url: "https://example.com/a.zip", requestId: "5", statusCode: 304, responseHeaders: [] });
	ng.navigationFailed("https://example.com/a.zip", "Error code 2152398850");
	assert.equal(n.verdicts.length, 0, "a navigation that was only given up for another one says nothing");
	ng.navigationFailed("https://example.com/a.zip", "NS_ERROR_NET_ERROR_RESPONSE");
	assert.deepEqual(n.verdicts.map((v) => v.code), ["no_content"]);
	// A new request of the top frame forgets the old 304: a commit without headers is then unguarded, as it always was.
	const u = guarded();
	const ug = u.attach();
	await u.fire("onBeforeRequest", { url: "https://example.com/a", requestId: "5" });
	await u.fire("onHeadersReceived", { url: "https://example.com/a", requestId: "5", statusCode: 304, responseHeaders: [] });
	await u.fire("onBeforeRequest", { url: "https://example.com/b", requestId: "6" });
	assert.equal(ug.committed("https://example.com/b"), false);
	assert.deepEqual(u.verdicts.map((v) => v.code), ["unguarded_response"]);
	// In a frame nothing changed: a 304 there passed before and passes now.
	const fr = guarded();
	fr.attach();
	await fr.fire("onBeforeRequest", { url: "https://example.com/" });
	await fr.fire("onHeadersReceived", { url: "https://example.com/", statusCode: 200, responseHeaders: PAGE_HEADERS });
	assert.deepEqual(await fr.fire("onHeadersReceived", { url: "https://example.com/inner", type: "sub_frame", requestId: "2", statusCode: 304, responseHeaders: [] }), {});
	assert.deepEqual(fr.verdicts, []);
});

test("guard: without a way to read the response it is not let through - the tab would show it", async () => {
	// A browser without response filters.
	const none = guarded({ filters: false });
	none.attach();
	await none.fire("onBeforeRequest", { url: "https://example.com/f.pdf" });
	assert.deepEqual(await none.fire("onHeadersReceived", { url: "https://example.com/f.pdf", statusCode: 200, responseHeaders: PDF_HEADERS }), { cancel: true });
	assert.deepEqual(none.verdicts.map((v) => [v.outcome, v.code]), [["unsupported", "file_capture_unavailable"]]);
	// One whose filter cannot be made for this request.
	const broken = guarded();
	/** @type {any} */ (broken.wr).filterResponseData = () => {
		throw new Error("Invalid request ID");
	};
	broken.attach();
	await broken.fire("onBeforeRequest", { url: "https://example.com/f.pdf" });
	assert.deepEqual(await broken.fire("onHeadersReceived", { url: "https://example.com/f.pdf", statusCode: 200, responseHeaders: PDF_HEADERS }), { cancel: true });
	assert.deepEqual(broken.verdicts.map((v) => v.code), ["file_capture_unavailable"]);
	// The PDF viewer is off and the job brings no file back: refused as it always was.
	const off = guarded({ pdfViewer: false });
	off.attach({ files: null });
	await off.fire("onBeforeRequest", { url: "https://example.com/f.pdf" });
	assert.deepEqual(await off.fire("onHeadersReceived", { url: "https://example.com/f.pdf", statusCode: 200, responseHeaders: PDF_HEADERS }), { cancel: true });
	assert.deepEqual([off.verdicts.map((v) => v.code), off.factory.made.length], [["content_type"], 0]);
});
