// The request guard: its pure decisions, and its listeners driven by hand
// with the details Firefox would pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEvent, logSink } from "../helpers/ext-fakes.js";
import { Guard, checkHop, classifyResponse, classifySubresource, declaredType, frameResponseAllowed, isAttachment, mediaType, offeredAsDownload, originOf } from "../../extension/background/guard.js";
import { DEFAULT_BLOCKLIST, REASON } from "../../extension/shared/policy.js";

const RELEASE = { blocklist: DEFAULT_BLOCKLIST, allowLoopbackPorts: /** @type {number[]} */ ([]) };
const FIXTURE = { blocklist: [...DEFAULT_BLOCKLIST, "blocked.localhost"], allowLoopbackPorts: [4711] };
const BASE = "moz-extension://0f8c2a3e-5b1d-4c7a-9e6f-112233445566/";
const STORE = "firefox-container-7";
const TAB = 31;
/** The gateway window, and the window the fake browser has every other tab in. */
const GATEWAY_WINDOW = 9;
const OTHER_WINDOW = 4;

test("originOf", () => {
	assert.equal(originOf("https://example.com:8443/a/b?c=d#e"), "https://example.com:8443");
	assert.equal(originOf("http://user:pw@example.com/"), "http://example.com");
	assert.equal(originOf("ftp://example.com/"), null);
	assert.equal(originOf("not a url"), null);
});

test("checkHop: the URL policy for every hop", () => {
	const ok = checkHop("https://example.com/a?b=c", RELEASE);
	assert.deepEqual(ok, { allowed: true, host: "example.com", origin: "https://example.com", exempt: false, literal: false });
	assert.deepEqual(checkHop("https://93.184.216.34/", RELEASE), { allowed: true, host: "93.184.216.34", origin: "https://93.184.216.34", exempt: false, literal: true });

	/** @type {[string, string][]} */
	const refused = [
		["http://127.0.0.1:8791/v1/status", REASON.PRIVATE_ADDRESS],
		["http://10.0.0.1/", REASON.PRIVATE_ADDRESS],
		["http://[::1]/", REASON.PRIVATE_ADDRESS],
		["http://192.168.1.1/admin", REASON.PRIVATE_ADDRESS],
		["http://169.254.169.254/latest/meta-data/", REASON.PRIVATE_ADDRESS],
		["http://router.local/", REASON.LOCAL_NAME],
		["http://localhost:3000/", REASON.LOCAL_NAME],
		["https://accounts.google.com/signin", REASON.BLOCKLISTED],
		["https://user:pw@example.com/", REASON.USERINFO],
		["ftp://example.com/file", REASON.SCHEME],
		["file:///etc/passwd", REASON.SCHEME],
		["javascript:alert(1)", REASON.SCHEME],
		["http://fileserver/", REASON.SINGLE_LABEL],
	];
	for (const [url, reason] of refused) {
		const hop = checkHop(url, RELEASE);
		assert.equal(hop.allowed, false, url);
		assert.equal(/** @type {{ reason: string }} */ (hop).reason, reason, url);
	}
});

test("checkHop: a long redirect target is judged by its origin, not refused for its length", () => {
	const long = "https://example.com/cb?token=" + "a".repeat(3000);
	assert.equal(checkHop(long, RELEASE).allowed, true);
	// The same rules still apply to it.
	assert.equal(/** @type {{ reason: string }} */ (checkHop("http://10.0.0.1/cb?token=" + "a".repeat(3000), RELEASE)).reason, REASON.PRIVATE_ADDRESS);
	assert.equal(/** @type {{ reason: string }} */ (checkHop("https://accounts.google.com/o?x=" + "a".repeat(3000), RELEASE)).reason, REASON.BLOCKLISTED);
	assert.equal(/** @type {{ reason: string }} */ (checkHop("https://u:p@example.com/?x=" + "a".repeat(3000), RELEASE)).reason, REASON.USERINFO);
	// And there is still a limit.
	assert.equal(/** @type {{ reason: string }} */ (checkHop("https://example.com/?x=" + "a".repeat(9000), RELEASE)).reason, REASON.URL_TOO_LONG);
});

test("checkHop: the loopback exception exists only with a dev config and only for its ports", () => {
	assert.equal(checkHop("http://a.localhost:4711/x", RELEASE).allowed, false);
	const hop = checkHop("http://a.localhost:4711/x", FIXTURE);
	assert.equal(hop.allowed, true);
	assert.equal(/** @type {{ exempt: boolean }} */ (hop).exempt, true);
	assert.equal(checkHop("http://a.localhost:4712/x", FIXTURE).allowed, false);
	assert.equal(checkHop("http://127.0.0.1:4711/x", FIXTURE).allowed, true);
	assert.equal(checkHop("http://10.0.0.1:4711/x", FIXTURE).allowed, false, "other private addresses stay refused");
	assert.equal(/** @type {{ reason: string }} */ (checkHop("http://blocked.localhost:4711/x", FIXTURE)).reason, REASON.BLOCKLISTED);
	assert.equal(/** @type {{ exempt: boolean }} */ (checkHop("https://example.com/", FIXTURE)).exempt, false);
});

test("classifySubresource: nothing a page loads may reach a private or local address", () => {
	for (const url of ["https://cdn.example.com/a.js", "wss://live.example.com/socket", "data:text/plain,hi", "blob:https://example.com/1", "https://accounts.google.com/gsi/client"]) {
		assert.equal(classifySubresource(url, RELEASE).allowed, true, url);
	}
	for (const url of ["http://127.0.0.1:8791/v1/status", "ws://localhost:9222/devtools", "http://192.168.0.1/cgi-bin/reboot", "https://printer.local/", "http://[fe80::1]/", "::not a url::"]) {
		assert.equal(classifySubresource(url, RELEASE).allowed, false, url);
	}
	assert.equal(classifySubresource("http://b.localhost:4711/pixel", FIXTURE).allowed, true);
	assert.equal(classifySubresource("ws://b.localhost:4711/ws", FIXTURE).allowed, true);
	assert.equal(classifySubresource("http://b.localhost:4712/pixel", FIXTURE).allowed, false);
});

test("classifySubresource: which hosts still need their addresses looked at", () => {
	assert.deepEqual(classifySubresource("https://cdn.example.com/a.js?x=1", RELEASE), { allowed: true, host: "cdn.example.com", exempt: false, resolve: true });
	assert.deepEqual(classifySubresource("wss://live.example.com:8443/socket", RELEASE), { allowed: true, host: "live.example.com", exempt: false, resolve: true });
	assert.deepEqual(classifySubresource("https://93.184.216.34/a.js", RELEASE), { allowed: true, host: "93.184.216.34", exempt: false, resolve: false }, "a literal address has nothing to resolve");
	assert.deepEqual(classifySubresource("data:text/plain,hi", RELEASE), { allowed: true, host: null, exempt: false, resolve: false });
	assert.deepEqual(classifySubresource("blob:https://example.com/1", RELEASE), { allowed: true, host: null, exempt: false, resolve: false });
	assert.deepEqual(classifySubresource("http://10.0.0.1/x", RELEASE), { allowed: false });
	assert.deepEqual(classifySubresource("http://b.localhost:4711/pixel", RELEASE), { allowed: false });
	// The fixture exception: allowed, and not resolved (it would resolve to loopback).
	assert.deepEqual(classifySubresource("http://b.localhost:4711/pixel", FIXTURE), { allowed: true, host: "b.localhost", exempt: true, resolve: false });
	assert.deepEqual(classifySubresource("http://127.0.0.1:4711/pixel", FIXTURE), { allowed: true, host: "127.0.0.1", exempt: true, resolve: false });
	// A public name on the fixture port is no fixture: it is resolved like any other.
	assert.deepEqual(classifySubresource("http://name.example.net:4711/pixel", FIXTURE), { allowed: true, host: "name.example.net", exempt: false, resolve: true });
});

test("mediaType", () => {
	assert.equal(mediaType("Text/HTML; charset=utf-8"), "text/html");
	assert.equal(mediaType(" application/xhtml+xml "), "application/xhtml+xml");
	assert.equal(mediaType(null), null);
	assert.equal(mediaType(""), null);
	assert.equal(mediaType("garbage"), null);
	assert.equal(mediaType("text/html\r\nx: y"), null);
});

// Every row was measured in headless Firefox 156 (tests/integration/headers.test.js
// asks the browser again on every run): what the browser takes the response for, and what the guard reads. The
// guard may say less than the browser (null: not certain) - it must never say another type than the browser uses.
test("mediaType reads a Content-Type the way the browser does, or not at all: a list of types is only a type when all of it is the same one", () => {
	/** @type {[string, string | null, string][]} value, what the guard reads, what Firefox does with an HTML body under it */
	const rows = [
		["text/html", "text/html", "HTML"],
		["TEXT/HTML", "text/html", "HTML"],
		["text/html; charset=utf-8", "text/html", "HTML"],
		["text/html;", "text/html", "HTML"],
		["text/html ; charset=x", "text/html", "HTML"],
		["text/html\t; charset=x", "text/html", "HTML"],
		["text/html;charset=utf-8;application/pdf", "text/html", "HTML"],
		["text/html, text/html", "text/html", "HTML"],
		["text/html,text/html", "text/html", "HTML: two headers of the same value, as the browser reports them"],
		["text/html; charset=utf-8, text/html; charset=utf-8", "text/html", "HTML"],
		["text/html,text/html; charset=utf-8", "text/html", "HTML"],
		["application/xhtml+xml", "application/xhtml+xml", "XHTML"],
		// The reviewer's two, and their kin: the browser takes the last type of the list.
		["text/html;,application/pdf", null, "the PDF viewer"],
		["text/html;,application/zip", null, "saved as a file"],
		["text/html, application/pdf", null, "the PDF viewer"],
		["text/html,application/zip", null, "saved as a file"],
		["text/html , application/zip", null, "saved as a file"],
		["text/html,application/pdf", null, "the PDF viewer: two headers, as the browser reports them"],
		["application/pdf, text/html", null, "HTML, script runs"],
		["application/zip, text/html", null, "HTML, script runs"],
		["application/pdf;,text/html", null, "HTML, script runs"],
		["application/json, text/html", null, "HTML, script runs"],
		["text/html, application/json", null, "the JSON viewer"],
		["text/html, text/plain", null, "a text document"],
		["text/plain, text/html", null, "HTML, script runs"],
		["application/xhtml+xml, application/zip", null, "saved as a file"],
		["application/json;,application/zip", null, "saved as a file"],
		["application/pdf;,application/zip", null, "saved as a file"],
		["text/html;charset=utf-8, application/pdf;foo", null, "the PDF viewer"],
		// A list with something in it that is no type: the browser passes over it. Here it is not certain.
		["text/html,", null, "HTML"],
		[",text/html", null, "HTML"],
		["text/html, */*", null, "HTML"],
		["text/html, garbage", null, "HTML"],
		["application/zip, garbage", null, "saved as a file"],
		["garbage, text/html", null, "HTML"],
		["text/html; charset=utf-8,", null, "HTML"],
		// Quotes: Firefox does not split inside "...", another parser may. Never certain.
		['text/html; charset="a,application/pdf"', null, "HTML"],
		['text/html; x=",application/pdf', null, "HTML"],
		['text/html; x="\\",application/pdf"', null, "HTML"],
		['application/zip; x=",text/html', null, "saved as a file"],
		["text/html; charset='a,application/zip'", null, "saved as a file (of type application/zip')"],
		// The type ends at a blank for the browser; here that is no type.
		["text/html application/pdf", null, "HTML"],
		["text/html application/zip", null, "HTML"],
		["text/html\tfoo", null, "HTML"],
		[";text/html", null, "HTML"],
		// No type the browser can use: it guesses from the bytes.
		["text /html", null, "guessed: HTML"],
		["text", null, "guessed: HTML"],
		["html", null, "guessed: HTML"],
		["", null, "guessed: HTML"],
		["   ", null, "guessed: HTML"],
		["*/*", null, "guessed: HTML"],
		["text/ html", null, "a text document of type text/"],
		["text/html/x", null, "a text document"],
		["/html", null, "saved as a file"],
		['"text/html"', null, "saved as a file"],
		// A character that is a blank to JavaScript and none to the browser: not text/html there, so not here.
		["text/html\u000b", null, "a text document, no script"],
		["text/html\u000c", null, "not measured"],
		["text/html\u00a0", null, "not measured"],
		["\ufefftext/html", null, "not measured"],
		["application/pdf\u000b", null, "saved as a file"],
		// A letter that only becomes ASCII when it is lowercased (the Kelvin sign) is no letter of a type.
		["text/mar\u212adown", null, "not measured"],
		["application/x-t\u0130r", null, "not measured"],
		// Types of their own, which the browser saves or shows as text: read as what they say.
		["x/y", "x/y", "saved as a file"],
		["text/html+x", "text/html+x", "a text document, no script"],
	];
	for (const [value, type, browser] of rows) assert.equal(mediaType(value), type, `${JSON.stringify(value)} (Firefox: ${browser})`);
	// Never a page type unless the whole value says so.
	for (const [value, type] of rows) {
		if (type === "text/html" || type === "application/xhtml+xml") assert.equal(/,/.test(value) ? value.split(",").every((part) => mediaType(part) === type) : true, true, value);
	}

	// From the headers: every Content-Type line counts, as one list.
	/** @param {string[]} values */
	const lines = (values) => values.map((value) => ({ name: "Content-Type", value }));
	assert.equal(declaredType([]), null);
	assert.equal(declaredType(lines(["text/html"])), "text/html");
	assert.equal(declaredType([{ name: "CONTENT-TYPE", value: "Text/Html; charset=x" }]), "text/html");
	assert.equal(declaredType(lines(["text/html", "text/html; charset=utf-8"])), "text/html");
	assert.equal(declaredType(lines(["text/html", "application/pdf"])), null, "Firefox: the PDF viewer");
	assert.equal(declaredType(lines(["application/zip", "text/html"])), null, "Firefox: HTML, script runs");
	assert.equal(declaredType(lines(["text/html", ""])), null);
	assert.equal(declaredType(lines(["", "text/html"])), null);
	assert.equal(declaredType([{ name: "content-type" }]), null, "a line without a value");
	assert.equal(declaredType([{ name: "X-Content-Type", value: "text/html" }]), null);
});

// Every row was measured in headless Firefox 156 with a PDF, an HTML page and
// JSON (tests/integration/headers.test.js asks the browser again on every run).
test("isAttachment reads a Content-Disposition the way the browser does: everything is an attachment but an empty value, inline, and a value that begins with filename", () => {
	/** @type {[string, boolean][]} value, true: Firefox saves the response instead of showing it */
	const rows = [
		["", false],
		["   ", false],
		["\t", false],
		[";", false],
		['; filename="a"', false],
		["inline", false],
		["INLINE", false],
		["Inline", false],
		[" inline", false],
		["\tinline", false],
		['inline; filename="a"', false],
		['inline;filename="a"', false],
		["inline ; filename=a", false],
		["inline\t; x=y", false],
		["inline foo", false],
		['inline; filename="attachment.pdf"', false],
		['filename="a"', false],
		["FileName=a", false],
		["filename", false],
		["filenamex", false],
		["filename*=UTF-8''a.pdf", false],
		["attachment", true],
		["Attachment", true],
		['ATTACHMENT; filename="a.pdf"', true],
		["attachment;filename=a", true],
		[" attachment", true],
		["download", true],
		['download; filename="x.pdf"', true],
		["x", true],
		["attach", true],
		["file", true],
		['foo; filename="a"', true],
		["form-data; name=x", true],
		["inlinex", true],
		["inline=1", true],
		['"inline"', true],
		["'inline'", true],
		['"attachment"', true],
		["inline, attachment", true],
		["inline,attachment", true],
		["attachment, inline", true],
		[",inline", true],
		["x inline", true],
		[": inline", true],
		["=inline", true],
		// Not measured, and so not trusted: a character that may or may not be a blank to the browser.
		["inline\u000b", true],
		["inline\u000c; x", true],
		["\u00a0inline", true],
		["\u000b", true],
		// Letters outside ASCII are not the letters of "inline" or "filename".
		["\u0131nline", true],
		["f\u0131lename=a", true],
	];
	for (const [value, attachment] of rows) assert.equal(isAttachment(value), attachment, JSON.stringify(value));

	/** @param {(string | undefined)[]} values */
	const lines = (values) => values.map((value) => ({ name: "Content-Disposition", ...(value === undefined ? {} : { value }) }));
	assert.equal(offeredAsDownload([]), false);
	assert.equal(offeredAsDownload([{ name: "Content-Type", value: "attachment" }]), false);
	assert.equal(offeredAsDownload(lines([undefined])), false);
	assert.equal(offeredAsDownload(lines(["inline"])), false);
	assert.equal(offeredAsDownload([{ name: "CONTENT-DISPOSITION", value: "download" }]), true);
	// Two lines of the same value are one to the browser. Two that differ make the load fail there (measured: its
	// error page, and no headers are told to an extension); should they ever be told, one attachment is enough.
	assert.equal(offeredAsDownload(lines(["inline", "inline"])), false);
	assert.equal(offeredAsDownload(lines(["attachment", "attachment"])), true);
	assert.equal(offeredAsDownload(lines(["inline", "attachment"])), true);
	assert.equal(offeredAsDownload(lines(["attachment", "inline"])), true);
	assert.equal(offeredAsDownload(lines(["", "x"])), true);
	// ... and so are two that differ, though each alone is a value the browser shows: nobody can say what it would do.
	assert.equal(offeredAsDownload(lines(["inline", 'inline; filename="a"'])), true);
	assert.equal(offeredAsDownload(lines(["", "inline"])), true);
	assert.equal(offeredAsDownload(lines(['filename="a"', 'filename="b"'])), true);
});

/** @param {Record<string, string>} headers */
const h = (headers) => Object.entries(headers).map(([name, value]) => ({ name, value }));

test("classifyResponse: only what the browser shows as a page gets through", () => {
	/** @type {[number, Record<string, string>, string, string?][]} */
	const cases = [
		[200, { "Content-Type": "text/html; charset=utf-8" }, "page"],
		[200, { "content-type": "application/xhtml+xml" }, "page"],
		[404, { "content-type": "text/html" }, "page"],
		[503, { "content-type": "text/html" }, "page"],
		[200, { "content-type": "text/plain", "X-Content-Type-Options": "nosniff" }, "page"],
		// Changed for 0.1.7: an encoded body was taken for one the browser shows. Measured in Firefox 156, it looks at
		// the bytes of text/plain once they are unpacked, and saves an archive under gzip, br or "identity" all the same.
		[200, { "content-type": "text/plain", "content-encoding": "gzip" }, "refuse", "plain_text_sniffable"],
		[200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "br" }, "refuse", "plain_text_sniffable"],
		[200, { "content-type": "text/plain", "content-encoding": "identity" }, "refuse", "plain_text_sniffable"],
		[200, { "content-type": "text/plain", "content-encoding": "gzip", "x-content-type-options": "nosniff" }, "page"],
		[200, { "content-type": "text/plain" }, "refuse", "plain_text_sniffable"],
		[200, { "content-type": "text/plain; charset=UTF-8" }, "refuse", "plain_text_sniffable"],
		[200, { "content-type": "text/html", "Content-Disposition": "attachment; filename=x.html" }, "refuse", "attachment"],
		[200, { "content-type": "text/html", "content-disposition": "ATTACHMENT" }, "refuse", "attachment"],
		[200, { "content-type": "text/html", "content-disposition": "inline; filename=attachment.html" }, "page"],
		// Not the word "attachment" decides, but what the browser does - it saves all of these.
		[200, { "content-type": "text/html", "content-disposition": 'download; filename="x.html"' }, "refuse", "attachment"],
		[200, { "content-type": "text/html", "content-disposition": "x" }, "refuse", "attachment"],
		[200, { "content-type": "text/html", "content-disposition": '"inline"' }, "refuse", "attachment"],
		[200, { "content-type": "text/html", "content-disposition": "inline, attachment" }, "refuse", "attachment"],
		[200, { "content-type": "application/pdf", "content-disposition": 'foo; filename="a"' }, "refuse", "attachment"],
		[404, { "content-type": "text/html", "content-disposition": "inlinex" }, "refuse", "attachment"],
		// ... and shows these.
		[200, { "content-type": "text/html", "content-disposition": "" }, "page"],
		[200, { "content-type": "text/html", "content-disposition": ";" }, "page"],
		[200, { "content-type": "text/html", "content-disposition": "INLINE" }, "page"],
		[200, { "content-type": "text/html", "content-disposition": "inline foo" }, "page"],
		[200, { "content-type": "text/html", "content-disposition": 'filename="a.html"' }, "page"],
		// A list of types is no page type, whatever its first entry says.
		[200, { "content-type": "text/html;,application/pdf" }, "refuse", "content_type_missing"],
		[200, { "content-type": "text/html;,application/zip" }, "refuse", "content_type_missing"],
		[200, { "content-type": "application/zip, text/html" }, "refuse", "content_type_missing"],
		[200, { "content-type": "text/html; charset=\"a,application/pdf\"" }, "refuse", "content_type_missing"],
		[200, { "content-type": "text/html application/pdf" }, "refuse", "content_type_missing"],
		[200, { "content-type": "text/html\u000b" }, "refuse", "content_type_missing"],
		[200, { "content-type": "text/html, text/html" }, "page"],
		[200, { "content-type": "text/plain, text/html", "x-content-type-options": "nosniff" }, "refuse", "content_type_missing"],
		// nosniff is the word alone: with more around it the browser may or may not take it.
		[200, { "content-type": "text/plain", "x-content-type-options": "NoSniff" }, "page"],
		[200, { "content-type": "text/plain", "x-content-type-options": " nosniff " }, "page"],
		[200, { "content-type": "text/plain", "x-content-type-options": "nosniff\u000b" }, "refuse", "plain_text_sniffable"],
		[200, { "content-type": "text/plain", "x-content-type-options": "nosniff, nosniff" }, "refuse", "plain_text_sniffable"],
		[200, { "content-type": "text/plain", "x-content-type-options": "sniff" }, "refuse", "plain_text_sniffable"],
		[200, { "content-type": "application/json" }, "refuse", "content_type_json"],
		[200, { "content-type": "application/ld+json" }, "refuse", "content_type_json"],
		[200, { "content-type": "application/xml" }, "refuse", "content_type_xml"],
		[200, { "content-type": "application/rss+xml" }, "refuse", "content_type_xml"],
		[200, { "content-type": "image/svg+xml" }, "refuse", "content_type_xml"],
		[200, { "content-type": "application/pdf" }, "refuse", "content_type"],
		[200, { "content-type": "application/octet-stream" }, "refuse", "content_type"],
		[200, { "content-type": "image/png" }, "refuse", "content_type"],
		[200, { "content-type": "video/mp4" }, "refuse", "content_type"],
		[200, {}, "refuse", "content_type_missing"],
		[200, { "content-type": "nonsense" }, "refuse", "content_type_missing"],
		[204, {}, "refuse", "no_content"],
		[205, { "content-type": "text/html" }, "refuse", "no_content"],
		[304, {}, "refuse", "no_content"],
		[302, { location: "https://example.com/next" }, "redirect"],
		[301, { Location: "/next", "content-type": "application/octet-stream" }, "redirect"],
		[302, { "content-type": "application/octet-stream" }, "refuse", "content_type"],
		// 300 is no redirect to Firefox, with a Location or without (measured in Firefox 156: it shows the body, or
		// saves it): the response is judged like any other, by its type and its disposition.
		[300, { location: "https://example.com/next" }, "refuse", "content_type_missing"],
		[300, { Location: "/next", "content-type": "text/html" }, "page"],
		[300, { Location: "/next", "content-type": "text/html", "content-disposition": "attachment" }, "refuse", "attachment"],
		[300, { Location: "/next", "content-type": "application/zip" }, "refuse", "content_type"],
		[300, { "content-type": "text/html" }, "page"],
		[300, { "content-type": "text/html", "content-disposition": "attachment" }, "refuse", "attachment"],
		[300, {}, "refuse", "content_type_missing"],
		[401, { "content-type": "text/html", "WWW-Authenticate": 'Basic realm="x"' }, "refuse", "auth_required"],
		[401, { "content-type": "application/octet-stream", "www-authenticate": "Digest realm=x" }, "refuse", "auth_required"],
		[401, { "content-type": "text/html", "www-authenticate": 'Newauth realm="apps", Basic realm="simple"' }, "refuse", "auth_required"],
		[401, { "content-type": "text/html", "www-authenticate": "Negotiate" }, "refuse", "auth_required"],
		// A scheme the browser shows no dialog for: the body is handled like any other.
		[401, { "content-type": "text/html", "www-authenticate": "Bearer" }, "page"],
		[401, { "content-type": "text/html", "www-authenticate": "Bearer", "content-disposition": "attachment" }, "refuse", "attachment"],
		[407, { "proxy-authenticate": "Basic" }, "proxy_auth"],
	];
	for (const [status, headers, kind, code] of cases) {
		const r = classifyResponse(status, h(headers));
		const label = `${status} ${JSON.stringify(headers)}`;
		assert.equal(r.kind, kind, label);
		if (r.kind === "refuse") {
			assert.equal(r.code, code, label);
			assert.equal(r.outcome, code === "auth_required" ? "error" : "unsupported", label);
		}
	}
});

test("frameResponseAllowed: a frame may show things, it may not start a download", () => {
	/** @type {[number, Record<string, string>, boolean][]} */
	const cases = [
		[200, { "content-type": "text/html" }, true],
		[200, { "content-type": "image/png" }, true],
		[200, { "content-type": "image/svg+xml" }, true],
		[200, { "content-type": "application/json" }, true],
		[200, { "content-type": "text/plain", "x-content-type-options": "nosniff" }, true],
		[204, {}, true],
		[302, { location: "/next" }, true],
		[401, { "content-type": "text/html", "www-authenticate": "Basic" }, true],
		[200, { "content-type": "text/html", "content-disposition": "attachment" }, false],
		[200, { "content-type": "application/octet-stream" }, false],
		[200, { "content-type": "application/zip" }, false],
		[200, { "content-type": "application/pdf" }, false],
		[200, { "content-type": "text/plain" }, false],
		[200, {}, false],
		// What the browser saves by its Content-Disposition, whatever the word, and what it may take for another type.
		[200, { "content-type": "text/html", "content-disposition": "download" }, false],
		[200, { "content-type": "image/svg+xml", "content-disposition": 'x; filename="a.svg"' }, false],
		[200, { "content-type": "image/png", "content-disposition": '"inline"' }, false],
		[200, { "content-type": "text/html", "content-disposition": 'filename="a.html"' }, true],
		[200, { "content-type": "text/html", "content-disposition": "" }, true],
		[200, { "content-type": "text/html;,application/zip" }, false],
		[200, { "content-type": "image/png, application/zip" }, false],
		[200, { "content-type": "text/html, text/html" }, true],
	];
	for (const [status, headers, allowed] of cases) {
		assert.equal(frameResponseAllowed(status, h(headers)), allowed, `${status} ${JSON.stringify(headers)}`);
	}
	// Two Content-Type lines in a frame's response: a list like any other.
	assert.equal(frameResponseAllowed(200, [{ name: "content-type", value: "text/html" }, { name: "content-type", value: "application/zip" }]), false);
	assert.equal(frameResponseAllowed(200, [{ name: "content-type", value: "text/html" }, { name: "content-disposition", value: "inline" }, { name: "content-disposition", value: "attachment" }]), false);
});

/** A webRequest API that records the listeners and lets a test fire them. */
function fakeWebRequest() {
	return {
		onBeforeRequest: new FakeEvent(),
		onHeadersReceived: new FakeEvent(),
		onAuthRequired: new FakeEvent(),
		onResponseStarted: new FakeEvent(),
		onErrorOccurred: new FakeEvent(),
	};
}

const EVENTS = /** @type {const} */ (["onBeforeRequest", "onHeadersReceived", "onAuthRequired", "onResponseStarted"]);

/**
 * @param {{ policy?: typeof RELEASE, resolve?: (host: string) => Promise<{ addresses: string[] }>, storeId?: string | null, start?: boolean, openTabs?: { id: number, cookieStoreId: string }[],
 *   log?: (event: string, fields?: Record<string, unknown>) => void }} [opts] log: in place of the sink, for a log that fails
 */
function setup(opts = {}) {
	const wr = fakeWebRequest();
	const tabs = {
		onCreated: new FakeEvent(),
		onRemoved: new FakeEvent(),
		query: async (/** @type {{ cookieStoreId?: string }} */ q) => (opts.openTabs ?? []).filter((t) => q.cookieStoreId === undefined || t.cookieStoreId === q.cookieStoreId),
	};
	/** @type {string[]} */
	const resolved = [];
	/** @type {import("../../extension/background/guard.js").Stray[]} */
	const strays = [];
	const sink = logSink();
	let storeId = opts.storeId === undefined ? STORE : opts.storeId;
	/** How many of the next questions for the container's cookie store fail. */
	let storeFailures = 0;
	const guard = new Guard({
		webRequest: /** @type {any} */ (wr),
		tabs: /** @type {any} */ (tabs),
		resolve: async (host) => {
			resolved.push(host);
			return opts.resolve ? opts.resolve(host) : { addresses: ["93.184.216.34", "2606:2800:220:1::1"] };
		},
		policy: opts.policy ?? RELEASE,
		extensionBase: BASE,
		storeId: () => {
			if (storeFailures > 0) {
				storeFailures -= 1;
				throw new Error("the container cannot be told");
			}
			return storeId;
		},
		onStray: (stray) => strays.push(stray),
		log: /** @type {any} */ (opts.log ?? sink.log),
		dnsTimeoutMs: 200,
	});
	if (opts.start !== false) guard.start();
	/** @type {import("../../extension/background/guard.js").Verdict[]} */
	const verdicts = [];
	const attach = () => guard.attach(TAB, { cookieStoreId: STORE, onVerdict: (v) => verdicts.push(v) });
	/** How many listeners were asked about the last request fired. */
	let asked = 0;
	/**
	 * Fire an event the way the browser does: every listener whose filter
	 * matches is asked, and one "cancel" is enough to cancel. A filter matches
	 * the way it was measured in Firefox 156: "tabId" selects the requests of
	 * that tab and nothing else, -1 those without a tab; "windowId" selects the
	 * requests of the tabs in that window. Each answer is checked on the way:
	 * {} or { cancel: true }, nothing else, ever.
	 * @param {typeof EVENTS[number]} event
	 * @param {Record<string, unknown>} request windowId: the window the tab of the request is in (not part
	 *   of what a listener is told)
	 * @returns {Promise<{ cancel?: true }>}
	 */
	const raw = async (event, request) => {
		const { windowId: inWindow, ...details } = request;
		const windowId = details.tabId === -1 ? -1 : (inWindow ?? OTHER_WINDOW);
		let cancel = false;
		asked = 0;
		for (const { fn, args } of [...wr[event].listeners]) {
			const filter = /** @type {{ types?: string[], tabId?: number, windowId?: number }} */ (args[0]);
			if (filter.tabId !== undefined && filter.tabId !== details.tabId) continue;
			if (filter.windowId !== undefined && filter.windowId !== windowId) continue;
			if (filter.types !== undefined && !filter.types.includes(String(details.type))) continue;
			asked += 1;
			const answer = await fn(details);
			if (event === "onResponseStarted") {
				assert.equal(answer, undefined, "a listener that cannot block returns nothing");
				continue;
			}
			const keys = Object.keys(/** @type {object} */ (answer));
			assert.ok(keys.length === 0 || (keys.length === 1 && keys[0] === "cancel" && /** @type {any} */ (answer).cancel === true), `only {} or { cancel: true }: ${JSON.stringify(answer)}`);
			if (keys.length === 1) cancel = true;
		}
		return cancel ? { cancel: true } : {};
	};
	/**
	 * A request of the job tab.
	 * @param {typeof EVENTS[number]} event
	 * @param {Record<string, unknown>} details
	 */
	const fire = (event, details) => raw(event, { tabId: TAB, windowId: GATEWAY_WINDOW, cookieStoreId: STORE, type: "main_frame", requestId: "1", ...details });
	/**
	 * A request that no tab stands behind, in the gateway container: a service worker's.
	 * @param {typeof EVENTS[number]} event
	 * @param {Record<string, unknown>} details
	 */
	const tabless = (event, details) => raw(event, { tabId: -1, cookieStoreId: STORE, type: "xmlhttprequest", requestId: "2", ...details });
	/** @returns {number[]} listeners per event */
	const count = () => EVENTS.map((name) => wr[name].listeners.length);
	return { wr, tabs, guard, attach, fire, tabless, raw, verdicts, resolved, strays, sink, count, asked: () => asked, setStore: (/** @type {string | null} */ id) => (storeId = id), failStore: (/** @type {number} */ times) => (storeFailures = times) };
}

test("the operator's requests are answered with 'no objection' and nothing else happens", async () => {
	for (const running of [false, true]) {
		const t = setup({ resolve: async () => ({ addresses: ["10.0.0.1"] }) });
		t.guard.watchWindow(GATEWAY_WINDOW);
		const g = running ? t.attach() : null;
		for (const cookieStoreId of ["firefox-default", "firefox-private", "firefox-container-8", "firefox-container-77", undefined]) {
			for (const tabId of [-1, 3, TAB + 1]) {
				const who = { tabId, cookieStoreId };
				// Things the guard refuses in the container, down to a loopback address and a download.
				assert.deepEqual(await t.raw("onBeforeRequest", { ...who, type: "main_frame", url: "http://127.0.0.1:8791/v1/status" }), {});
				assert.deepEqual(await t.raw("onBeforeRequest", { ...who, type: "main_frame", url: "https://mail.google.com/" }), {});
				assert.deepEqual(await t.raw("onBeforeRequest", { ...who, type: "xmlhttprequest", url: "http://192.168.1.1/cgi-bin/status" }), {});
				assert.deepEqual(await t.raw("onBeforeRequest", { ...who, type: "script", url: "https://rebind.example.net/a.js" }), {});
				assert.deepEqual(await t.raw("onHeadersReceived", { ...who, type: "main_frame", url: "https://example.com/file.zip", statusCode: 200, ip: "10.0.0.5", responseHeaders: h({ "content-type": "application/zip", "content-disposition": "attachment" }) }), {});
				assert.deepEqual(await t.raw("onHeadersReceived", { ...who, type: "image", url: "https://intranet.example.com/a.png", statusCode: 200, ip: "192.168.1.9" }), {});
				assert.deepEqual(await t.raw("onAuthRequired", { ...who, type: "main_frame", url: "https://example.com/", isProxy: false }), {}, "their login dialogs are theirs");
				assert.deepEqual(await t.raw("onResponseStarted", { ...who, type: "main_frame", url: "https://example.com/", ip: "10.0.0.5" }), {});
			}
		}
		assert.deepEqual(t.resolved, [], "not one name was looked up for them");
		assert.deepEqual(t.verdicts, []);
		assert.deepEqual(t.sink.entries, [], "and nothing about them is logged");
		g?.detach();
	}
});

test("a request of an ordinary tab reaches no listener of the guard at all", async () => {
	const t = setup();
	t.guard.watchWindow(GATEWAY_WINDOW);
	const g = t.attach();
	const before = t.guard.stats;
	for (const cookieStoreId of ["firefox-default", "firefox-private", "firefox-container-8"]) {
		for (const tabId of [1, 3, TAB + 1, 9999]) {
			for (const [event, details] of /** @type {[typeof EVENTS[number], Record<string, unknown>][]} */ ([
				["onBeforeRequest", { type: "main_frame", url: "https://example.com/" }],
				["onBeforeRequest", { type: "image", url: "https://example.com/a.png" }],
				["onBeforeRequest", { type: "xmlhttprequest", url: "http://192.168.1.1/status" }],
				["onHeadersReceived", { type: "main_frame", url: "https://example.com/", statusCode: 200, responseHeaders: h({ "content-type": "text/html" }) }],
				["onHeadersReceived", { type: "script", url: "https://example.com/a.js", statusCode: 200 }],
				["onAuthRequired", { type: "main_frame", url: "https://example.com/", isProxy: false }],
				["onResponseStarted", { type: "main_frame", url: "https://example.com/", ip: "93.184.216.34" }],
			])) {
				assert.deepEqual(await t.raw(event, { tabId, cookieStoreId, ...details }), {});
				assert.equal(t.asked(), 0, `${event} of tab ${tabId} in ${cookieStoreId}: no listener was asked`);
			}
		}
	}
	assert.deepEqual(t.guard.stats, before, "not one call was counted");

	// What does pass through, and is waved on at once: a request without a tab (a worker of one of the
	// operator's sites, this extension's own dial to the daemon) ...
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: -1, cookieStoreId: "firefox-default", type: "websocket", url: "ws://127.0.0.1:8791/ext" }), {});
	assert.equal(t.asked(), 1);
	assert.deepEqual(await t.raw("onHeadersReceived", { tabId: -1, cookieStoreId: "firefox-default", type: "xmlhttprequest", url: "https://example.com/api", statusCode: 200, ip: "10.0.0.1" }), {});
	assert.equal(t.asked(), 1, "one listener, the one that does not ask for headers");
	// ... and a tab the operator put into the gateway window, until the window is handed over to them.
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 55, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-default", type: "main_frame", url: "http://192.168.1.1/" }), {});
	assert.equal(t.asked(), 1);
	assert.deepEqual(await t.raw("onHeadersReceived", { tabId: 55, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-default", type: "main_frame", url: "http://192.168.1.1/", statusCode: 200, responseHeaders: [] }), {});
	assert.equal(t.asked(), 0, "the window is only listened to for requests about to be made");
	const after = t.guard.stats;
	assert.deepEqual(after.calls, { ...before.calls, tabless: before.calls.tabless + 2, window: before.calls.window + 1 });
	assert.equal(after.outside, before.outside + 3, "all three counted as not ours");
	assert.equal(after.dropped, before.dropped);
	assert.deepEqual(t.resolved, []);
	assert.deepEqual(t.sink.entries, []);
	g.detach();
});

test("listeners: one set for requests without a tab, one per guarded tab, one listener for the gateway window; blocking, cancel-only", () => {
	const { wr, guard, attach, count } = setup();
	/** @param {typeof EVENTS[number]} name @returns {unknown[][]} */
	const args = (name) => wr[name].listeners.map((l) => l.args);
	// At rest: the requests no tab stands behind, and nothing else.
	assert.deepEqual(count(), [1, 2, 1, 1]);
	assert.deepEqual(args("onBeforeRequest"), [[{ urls: ["<all_urls>"], tabId: -1 }, ["blocking"]]]);
	assert.deepEqual(args("onAuthRequired"), [[{ urls: ["<all_urls>"], tabId: -1 }, ["blocking"]]]);
	assert.deepEqual(args("onResponseStarted"), [[{ urls: ["<all_urls>"], tabId: -1 }]]);
	// Response headers are only asked for where they are read: for frames.
	assert.deepEqual(args("onHeadersReceived"), [
		[{ urls: ["<all_urls>"], types: ["main_frame", "sub_frame"], tabId: -1 }, ["blocking", "responseHeaders"]],
		[{ urls: ["<all_urls>"], tabId: -1 }, ["blocking"]],
	]);
	guard.start();
	assert.deepEqual(count(), [1, 2, 1, 1], "starting twice changes nothing");

	// A job tab brings listeners of its own and takes them with it.
	const g = attach();
	assert.deepEqual(count(), [2, 4, 2, 2]);
	assert.deepEqual(args("onBeforeRequest")[1], [{ urls: ["<all_urls>"], tabId: TAB }, ["blocking"]]);
	assert.deepEqual(args("onHeadersReceived").slice(2), [
		[{ urls: ["<all_urls>"], types: ["main_frame", "sub_frame"], tabId: TAB }, ["blocking", "responseHeaders"]],
		[{ urls: ["<all_urls>"], tabId: TAB }, ["blocking"]],
	]);
	const second = guard.attach(TAB + 1, { cookieStoreId: STORE, onVerdict: () => {} });
	assert.deepEqual(count(), [3, 6, 3, 3]);
	// A new guard for the same tab takes over the listeners that are there.
	const again = attach();
	assert.deepEqual(count(), [3, 6, 3, 3]);
	g.detach();
	assert.deepEqual(count(), [3, 6, 3, 3], "the guard that was replaced takes nothing with it");
	again.detach();
	again.detach();
	second.detach();
	assert.deepEqual(count(), [1, 2, 1, 1], "the container stays guarded between jobs");

	// The gateway window: one listener, for requests about to be made.
	guard.watchWindow(GATEWAY_WINDOW);
	assert.deepEqual(count(), [2, 2, 1, 1]);
	assert.deepEqual(args("onBeforeRequest")[1], [{ urls: ["<all_urls>"], windowId: GATEWAY_WINDOW }, ["blocking"]]);
	guard.watchWindow(GATEWAY_WINDOW);
	assert.deepEqual(count(), [2, 2, 1, 1]);
	guard.watchWindow(12);
	assert.deepEqual(args("onBeforeRequest")[1], [{ urls: ["<all_urls>"], windowId: 12 }, ["blocking"]]);
	guard.watchWindow(null);
	assert.deepEqual(count(), [1, 2, 1, 1]);

	// Every filter names a slice: none is for all requests, and none asks for the right to change a request.
	guard.watchWindow(GATEWAY_WINDOW);
	const live = attach();
	for (const name of EVENTS) {
		for (const l of wr[name].listeners) {
			const filter = /** @type {{ urls: string[], tabId?: number, windowId?: number }} */ (l.args[0]);
			assert.deepEqual(filter.urls, ["<all_urls>"]);
			assert.ok(filter.tabId !== undefined || filter.windowId !== undefined, `${name}: bound to a tab, to "no tab" or to the gateway window`);
			assert.equal(JSON.stringify(l.args).includes("requestHeaders"), false);
		}
	}
	guard.stop();
	assert.deepEqual(count(), [0, 0, 0, 0]);
	// Started again, it listens for what it guards by then.
	guard.start();
	assert.deepEqual(count(), [3, 4, 2, 2]);
	live.detach();
	guard.stop();
	assert.deepEqual(count(), [0, 0, 0, 0]);
});

test("a tab that appears in the container is sealed the moment the browser reports it", async () => {
	const t = setup();
	const popup = { tabId: 70, cookieStoreId: STORE };
	// Not yet reported: nothing of the guard hears it (the gateway window's listener is for that gap).
	assert.deepEqual(await t.raw("onBeforeRequest", { ...popup, type: "main_frame", url: "https://example.com/" }), {});
	assert.equal(t.asked(), 0);

	const g = t.attach();
	t.tabs.onCreated.fire({ id: 70, windowId: 17, cookieStoreId: STORE });
	t.tabs.onCreated.fire({ id: 71, windowId: GATEWAY_WINDOW, cookieStoreId: STORE, openerTabId: TAB });
	// Tabs of other stores are nobody's business here.
	t.tabs.onCreated.fire({ id: 72, windowId: 3, cookieStoreId: "firefox-default" });
	t.tabs.onCreated.fire({ id: 73, windowId: 3, cookieStoreId: "firefox-container-8", openerTabId: TAB });
	t.tabs.onCreated.fire({ windowId: 3, cookieStoreId: STORE });
	assert.deepEqual(t.strays, [
		{ tabId: 70, windowId: 17, openerTabId: null, duringJob: true },
		{ tabId: 71, windowId: GATEWAY_WINDOW, openerTabId: TAB, duringJob: true },
	]);
	assert.deepEqual(t.count(), [4, 8, 4, 4], "the tab-less set, the job tab's, and one for each of the two strays");
	for (const tabId of [70, 71]) {
		const who = { tabId, cookieStoreId: STORE };
		assert.deepEqual(await t.raw("onBeforeRequest", { ...who, type: "main_frame", url: "https://example.com/" }), { cancel: true });
		assert.deepEqual(await t.raw("onBeforeRequest", { ...who, type: "image", url: "https://93.184.216.34/a.png" }), { cancel: true });
		assert.deepEqual(await t.raw("onBeforeRequest", { ...who, type: "image", url: "data:image/gif;base64,AAAA" }), { cancel: true });
		assert.deepEqual(await t.raw("onHeadersReceived", { ...who, type: "main_frame", url: "https://example.com/", statusCode: 200, responseHeaders: h({ "content-type": "text/html" }) }), { cancel: true });
		assert.deepEqual(await t.raw("onHeadersReceived", { ...who, type: "image", url: "https://example.com/a.png", statusCode: 200 }), { cancel: true });
		assert.deepEqual(await t.raw("onAuthRequired", { ...who, type: "main_frame", url: "https://example.com/", isProxy: false }), { cancel: true });
	}
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 72, cookieStoreId: "firefox-default", type: "main_frame", url: "https://example.com/" }), {});
	assert.equal(t.asked(), 0);
	assert.deepEqual(t.verdicts, [], "a stray tab is nobody's job");
	assert.equal(t.guard.running, true, "the job goes on");
	// A sealed stray is not a running job, and what was learned about names is not kept for it.
	g.detach();
	assert.equal(t.guard.running, false);
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://api.example.com/data" }), { cancel: true });

	// Reported again: nothing changes. Closed: its listeners go.
	t.tabs.onCreated.fire({ id: 70, windowId: 17, cookieStoreId: STORE });
	assert.equal(t.strays.length, 2);
	t.tabs.onRemoved.fire(70);
	t.tabs.onRemoved.fire(71);
	t.tabs.onRemoved.fire(12345);
	assert.deepEqual(t.count(), [1, 2, 1, 1]);

	// A tab that appears while no job runs is sealed all the same, and said to be no job's doing.
	t.tabs.onCreated.fire({ id: 80, windowId: 3, cookieStoreId: STORE });
	assert.deepEqual(t.strays[2], { tabId: 80, windowId: 3, openerTabId: null, duringJob: false });
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 80, cookieStoreId: STORE, type: "main_frame", url: "https://example.com/" }), { cancel: true });
});

test("a job tab is reported like any tab of the container: sealed first, then claimed by its job", async () => {
	const t = setup();
	t.tabs.onCreated.fire({ id: TAB, windowId: GATEWAY_WINDOW, cookieStoreId: STORE });
	assert.deepEqual(t.count(), [2, 4, 2, 2]);
	assert.equal(t.guard.running, false);
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://93.184.216.34/" }), { cancel: true }, "sealed until its job claims it");
	const g = t.attach();
	assert.deepEqual(t.count(), [2, 4, 2, 2], "the same listeners");
	assert.equal(g.stray, false);
	assert.equal(t.guard.running, true);
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://93.184.216.34/" }), {});
	// The browser reports the close of a job tab too: its guard is the job's to end, not the event's.
	t.tabs.onRemoved.fire(TAB);
	assert.deepEqual(t.count(), [2, 4, 2, 2]);
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://93.184.216.34/next" }), {});
	g.detach();
	assert.deepEqual(t.count(), [1, 2, 1, 1]);
});

test("tabs that are open in the container when the guard starts, or when the container becomes known, are sealed", async () => {
	const open = [
		{ id: 5, cookieStoreId: STORE },
		{ id: 6, cookieStoreId: "firefox-default" },
		{ id: 7, cookieStoreId: STORE },
	];
	const t = setup({ openTabs: open });
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(t.count(), [3, 6, 3, 3]);
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 5, cookieStoreId: STORE, type: "main_frame", url: "https://example.com/" }), { cancel: true });
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 6, cookieStoreId: "firefox-default", type: "main_frame", url: "https://example.com/" }), {});
	assert.deepEqual(t.strays, [], "found, not reported as new");

	const late = setup({ openTabs: open, storeId: null });
	await late.guard.rescan();
	assert.deepEqual(late.count(), [1, 2, 1, 1], "no container, nothing to look for");
	late.setStore(STORE);
	await late.guard.rescan();
	assert.deepEqual(late.count(), [3, 6, 3, 3]);
	// A job tab among them is left to its job.
	const g = late.guard.attach(8, { cookieStoreId: STORE, onVerdict: () => {} });
	open.push({ id: 8, cookieStoreId: STORE });
	await late.guard.rescan();
	assert.equal(g.open, true);
	g.detach();
});

test("the gateway window: a tab of the container that turns up in it is cancelled before anyone reported it", async () => {
	const t = setup();
	t.guard.watchWindow(GATEWAY_WINDOW);
	const g = t.attach();
	const popup = { tabId: 90, windowId: GATEWAY_WINDOW, cookieStoreId: STORE };
	const dropped = t.guard.dropped;
	assert.deepEqual(await t.raw("onBeforeRequest", { ...popup, type: "main_frame", url: "https://example.com/" }), { cancel: true });
	assert.deepEqual(await t.raw("onBeforeRequest", { ...popup, type: "image", url: "http://192.168.1.1/a.png" }), { cancel: true });
	assert.equal(t.guard.dropped, dropped + 2);
	// The same tab in a window of its own is not heard until it is reported.
	assert.deepEqual(await t.raw("onBeforeRequest", { ...popup, windowId: 33, type: "main_frame", url: "https://example.com/" }), {});
	// The park page is the extension's own.
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 2, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-default", type: "main_frame", url: BASE + "park/park.html" }), {});
	// The job tab is in that window too. Its own listeners decide, once: a hop is recorded once.
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://93.184.216.34/a" }), {});
	assert.equal(t.asked(), 2, "the tab's listener and the window's");
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://93.184.216.35/b" }), {});
	assert.deepEqual(g.nav.redirectOrigins, ["https://93.184.216.35"]);
	// A refusal by the tab's listener stands whatever the window's listener says.
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "http://10.0.0.1/" }), { cancel: true });
	assert.equal(t.verdicts.length, 1);
	g.detach();
	// Moved out of the gateway window in mid-job, a job tab is still heard: by its own listeners.
	const moved = t.attach();
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "http://10.0.0.1/", windowId: 33 }), { cancel: true });
	moved.detach();
});

test("a filter that selects nothing is noticed, and the guard listens to everything again", async () => {
	// The tab-less listener heard a request: all is well.
	const fine = setup();
	await fine.raw("onBeforeRequest", { tabId: -1, cookieStoreId: "firefox-default", type: "websocket", url: "ws://127.0.0.1:8791/ext" });
	assert.equal(fine.guard.confirmTabless(), true);
	assert.equal(fine.guard.stats.wide, false);
	assert.deepEqual(fine.sink.entries, []);

	// It heard nothing although a request without a tab was made: the filter is deaf in this browser.
	const t = setup();
	t.guard.watchWindow(GATEWAY_WINDOW);
	const g = t.attach();
	t.tabs.onCreated.fire({ id: 70, windowId: 17, cookieStoreId: STORE });
	assert.deepEqual(t.count(), [4, 6, 3, 3]);
	assert.equal(t.guard.confirmTabless(), false);
	assert.equal(t.guard.stats.wide, true);
	assert.deepEqual(t.sink.entries, [{ event: "guard.widened", fields: { reason: "tabless_filter_deaf" } }]);
	assert.deepEqual(t.count(), [1, 2, 1, 1], "one set of listeners again");
	for (const name of EVENTS) {
		for (const l of t.wr[name].listeners) {
			const filter = /** @type {{ tabId?: number, windowId?: number }} */ (l.args[0]);
			assert.deepEqual([filter.tabId, filter.windowId], [undefined, undefined], `${name}: for every request`);
		}
	}
	// Everything is decided as before the listeners were narrowed.
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://93.184.216.34/" }), {});
	assert.equal(g.sawTopFrame, true);
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "http://10.0.0.1/" }), { cancel: true });
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 70, cookieStoreId: STORE, type: "main_frame", url: "https://example.com/" }), { cancel: true }, "the sealed stray");
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 99, cookieStoreId: STORE, type: "main_frame", url: "https://example.com/" }), { cancel: true }, "a tab of the container nobody reported");
	assert.deepEqual(await t.raw("onHeadersReceived", { tabId: 99, cookieStoreId: STORE, type: "image", url: "https://example.com/a.png", statusCode: 200 }), { cancel: true });
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "http://192.168.1.1/" }), { cancel: true });
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 3, cookieStoreId: "firefox-default", type: "main_frame", url: "http://192.168.1.1/" }), {});
	assert.equal(t.asked(), 1, "the operator's requests pass through it again");
	// Nothing narrows it again: not a new job tab, not the window, not a second widening.
	g.detach();
	t.attach().detach();
	t.guard.watchWindow(12);
	t.guard.widen("again");
	assert.equal(t.guard.confirmTabless(), false);
	assert.deepEqual(t.count(), [1, 2, 1, 1]);
	assert.equal(t.sink.count("guard.widened"), 1);

	// Decided before start(): the wide set is what gets registered.
	const early = setup({ start: false });
	early.guard.widen("tab_filter_deaf");
	assert.deepEqual(early.count(), [0, 0, 0, 0]);
	early.guard.start();
	assert.deepEqual(early.count(), [1, 2, 1, 1]);
	assert.equal(/** @type {{ tabId?: number }} */ (early.wr.onBeforeRequest.listeners[0].args[0]).tabId, undefined);
});

test("a job tab knows whether its top frame was ever heard", async () => {
	const t = setup();
	const g = t.attach();
	assert.equal(g.sawTopFrame, false);
	await t.fire("onBeforeRequest", { type: "image", url: "https://93.184.216.34/a.png" });
	await t.fire("onHeadersReceived", { url: "https://93.184.216.34/", statusCode: 200, responseHeaders: h({ "content-type": "text/html" }) });
	assert.equal(g.sawTopFrame, false, "only a request for the top frame counts");
	await t.fire("onBeforeRequest", { url: "https://93.184.216.34/" });
	assert.equal(g.sawTopFrame, true);
	g.detach();
});

test("two job tabs can be under guard at once, each with its own verdicts", async () => {
	const { guard, raw } = setup();
	/** @type {string[]} */
	const seen = [];
	const a = guard.attach(1, { cookieStoreId: STORE, onVerdict: (v) => seen.push(`a:${v.code}`) });
	const b = guard.attach(2, { cookieStoreId: STORE, onVerdict: (v) => seen.push(`b:${v.code}`) });
	assert.deepEqual(await raw("onBeforeRequest", { tabId: 2, cookieStoreId: STORE, type: "main_frame", url: "http://10.0.0.1/" }), { cancel: true });
	assert.deepEqual(seen, ["b:private_address"]);
	assert.equal(a.verdict, null);
	assert.equal(guard.running, true, "the other job goes on");
	assert.deepEqual(await raw("onBeforeRequest", { tabId: 1, cookieStoreId: STORE, type: "main_frame", url: "https://93.184.216.34/" }), {});
	a.detach();
	assert.equal(guard.running, false);
	b.detach();
});

test("top-frame requests: policy on every hop, and the addresses of its name asked for on every hop", async () => {
	const { guard, attach, fire, verdicts, resolved } = setup();
	// The check before the tab is made is one lookup; what it found is not carried into the tab.
	assert.equal((await guard.precheck("https://example.com/start")).verdict, null);
	const g = attach();
	assert.deepEqual(await fire("onBeforeRequest", { url: "https://example.com/start" }), {});
	assert.deepEqual(resolved, ["example.com", "example.com"], "asked again when the first request is about to be sent");
	assert.deepEqual(await fire("onBeforeRequest", { url: "https://www.example.org/next" }), {});
	assert.deepEqual(await fire("onBeforeRequest", { url: "https://www.example.org/again" }), {});
	assert.deepEqual(resolved, ["example.com", "example.com", "www.example.org", "www.example.org"], "and for a name that passed a moment ago");
	assert.deepEqual(await fire("onBeforeRequest", { url: "https://93.184.216.34/literal" }), {});
	assert.equal(resolved.length, 4, "an address needs no lookup");
	assert.deepEqual(g.nav.redirectOrigins, ["https://www.example.org", "https://93.184.216.34"]);
	assert.deepEqual(verdicts, []);
	g.detach();
});

test("a hop to a private address is cancelled and ends the job", async () => {
	const { attach, fire, verdicts, resolved } = setup();
	const g = attach();
	await fire("onBeforeRequest", { url: "https://example.com/" });
	assert.deepEqual(await fire("onBeforeRequest", { url: "http://192.168.1.1/admin?secret=1" }), { cancel: true });
	assert.equal(verdicts.length, 1);
	assert.deepEqual({ outcome: verdicts[0].outcome, code: verdicts[0].code }, { outcome: "policy_blocked", code: "private_address" });
	assert.equal(verdicts[0].message.includes("192.168"), false, "no address in the message");
	assert.deepEqual(g.nav.redirectOrigins, ["http://192.168.1.1"], "origin only");
	assert.deepEqual(resolved, ["example.com"], "a literal private address needs no lookup to be refused");
	// Once there is a verdict nothing else gets out of the tab.
	assert.deepEqual(await fire("onBeforeRequest", { url: "https://example.com/retry" }), { cancel: true });
	assert.deepEqual(await fire("onBeforeRequest", { url: "https://cdn.example.com/a.js", type: "script" }), { cancel: true });
	assert.equal(verdicts.length, 1, "one verdict per job");
	g.detach();
});

test("a 300 is no redirect, Location or not: what the browser would show is judged as a page, what it would save is refused at the headers", async () => {
	// The browser shows the body of such a response under the address that was asked for: it is the page of the job.
	const { attach, fire, verdicts } = setup();
	const g = attach();
	await fire("onBeforeRequest", { url: "https://example.com/choices" });
	assert.deepEqual(await fire("onHeadersReceived", { url: "https://example.com/choices", statusCode: 300, ip: "93.184.216.34", responseHeaders: h({ location: "http://192.168.1.1/admin", "content-type": "text/html" }) }), {});
	assert.equal(verdicts.length, 0);
	assert.equal(g.diagnose().top_load, "passed", "judged, and passed as a page");
	assert.equal(g.committed("https://example.com/choices"), true);
	assert.equal(g.nav.httpStatus, 300);
	// Should a browser go where its Location says after all, that is a request of its own, judged like any hop.
	assert.deepEqual(await fire("onBeforeRequest", { url: "http://192.168.1.1/admin" }), { cancel: true });
	assert.equal(verdicts[0].code, "private_address");
	g.detach();

	// And one that the browser would save is refused before the body, whatever its Location says.
	const saved = setup();
	const gs = saved.attach();
	await saved.fire("onBeforeRequest", { url: "https://example.com/choices" });
	assert.deepEqual(await saved.fire("onHeadersReceived", { url: "https://example.com/choices", statusCode: 300, ip: "93.184.216.34", responseHeaders: h({ location: "/next", "content-type": "application/zip", "content-disposition": "attachment" }) }), { cancel: true });
	assert.deepEqual({ outcome: saved.verdicts[0].outcome, code: saved.verdicts[0].code }, { outcome: "unsupported", code: "attachment" });
	gs.detach();
});

test("a blocklisted hop and a non-web hop are cancelled with their codes", async () => {
	for (const [url, code] of /** @type {[string, string][]} */ ([
		["https://mail.google.com/mail/u/0/", "blocklisted"],
		["https://user:pw@example.com/", "userinfo_not_allowed"],
		["ftp://example.com/x", "scheme_not_allowed"],
	])) {
		const { attach, fire, verdicts } = setup();
		const g = attach();
		assert.deepEqual(await fire("onBeforeRequest", { url }), { cancel: true }, url);
		assert.equal(verdicts[0].outcome, "policy_blocked");
		assert.equal(verdicts[0].code, code);
		g.detach();
	}
});

test("a name that resolves to a private address is cancelled; so is one that does not resolve", async () => {
	const rebind = setup({ resolve: async () => ({ addresses: ["93.184.216.34", "10.1.2.3"] }) });
	let g = rebind.attach();
	assert.deepEqual(await rebind.fire("onBeforeRequest", { url: "https://rebind.example.net/" }), { cancel: true });
	assert.deepEqual({ outcome: rebind.verdicts[0].outcome, code: rebind.verdicts[0].code }, { outcome: "policy_blocked", code: "private_address" });
	g.detach();

	for (const resolve of [
		async () => {
			throw new Error("NS_ERROR_UNKNOWN_HOST");
		},
		async () => ({ addresses: [] }),
		() => new Promise(() => {}),
	]) {
		const failing = setup({ resolve: /** @type {any} */ (resolve) });
		g = failing.attach();
		assert.deepEqual(await failing.fire("onBeforeRequest", { url: "https://nowhere.example.net/" }), { cancel: true });
		assert.deepEqual({ outcome: failing.verdicts[0].outcome, code: failing.verdicts[0].code }, { outcome: "error", code: "dns_failed" });
		g.detach();
	}

	for (const address of ["127.0.0.1", "::1", "169.254.169.254", "fd00::1", "::ffff:10.0.0.1", "100.64.0.1", "0.0.0.0", "not-an-address"]) {
		const one = setup({ resolve: async () => ({ addresses: [address] }) });
		g = one.attach();
		assert.deepEqual(await one.fire("onBeforeRequest", { url: "https://name.example.net/" }), { cancel: true }, address);
		g.detach();
	}
});

test("requests a page makes by itself: private targets are cancelled quietly, the rest pass", async () => {
	const { attach, fire, verdicts, resolved } = setup();
	const g = attach();
	assert.deepEqual(await fire("onBeforeRequest", { url: "http://127.0.0.1:8791/v1/status", type: "xmlhttprequest" }), { cancel: true });
	assert.deepEqual(await fire("onBeforeRequest", { url: "http://192.168.1.1/cgi-bin/reboot", type: "image" }), { cancel: true });
	assert.deepEqual(await fire("onBeforeRequest", { url: "ws://localhost:9222/", type: "websocket" }), { cancel: true });
	assert.deepEqual(await fire("onBeforeRequest", { url: "http://10.0.0.1/frame", type: "sub_frame" }), { cancel: true });
	assert.deepEqual(resolved, [], "a literal private address needs no lookup to be refused");
	assert.deepEqual(await fire("onBeforeRequest", { url: "https://cdn.example.com/app.js", type: "script" }), {});
	assert.deepEqual(await fire("onBeforeRequest", { url: "https://accounts.google.com/gsi/client", type: "sub_frame" }), {});
	assert.deepEqual(await fire("onBeforeRequest", { url: "data:image/gif;base64,AAAA", type: "image" }), {});
	assert.deepEqual(verdicts, [], "the job goes on");
	assert.deepEqual(resolved, ["cdn.example.com", "accounts.google.com"]);
	assert.deepEqual(g.nav.redirectOrigins, []);
	g.detach();
});

test("sub-resources by name: a name that resolves to a private address is cancelled, quietly", async () => {
	/** @type {Record<string, string[]>} */
	const zone = { "cdn.example.com": ["93.184.216.34"], "rebind.example.net": ["93.184.216.34", "192.168.1.20"], "loop.example.net": ["127.0.0.1"], "six.example.net": ["fd00::7"] };
	const t = setup({
		resolve: async (host) => {
			if (zone[host] === undefined) throw new Error("NS_ERROR_UNKNOWN_HOST");
			return { addresses: zone[host] };
		},
	});
	const g = t.attach();
	for (const type of ["image", "script", "xmlhttprequest", "sub_frame", "websocket", "beacon", "font", "media", "other"]) {
		const scheme = type === "websocket" ? "wss" : "https";
		assert.deepEqual(await t.fire("onBeforeRequest", { type, url: `${scheme}://cdn.example.com/x` }), {}, type);
		assert.deepEqual(await t.fire("onBeforeRequest", { type, url: `${scheme}://rebind.example.net/x` }), { cancel: true }, type);
		assert.deepEqual(await t.fire("onBeforeRequest", { type, url: `${scheme}://loop.example.net/x` }), { cancel: true }, type);
		assert.deepEqual(await t.fire("onBeforeRequest", { type, url: `${scheme}://six.example.net/x` }), { cancel: true }, type);
		// A name that does not resolve could not be loaded anyway: cancelled, not waved through.
		assert.deepEqual(await t.fire("onBeforeRequest", { type, url: `${scheme}://nowhere.example.net/x` }), { cancel: true }, type);
	}
	assert.deepEqual(t.verdicts, [], "none of this ends the job");
	// No answer is remembered, a good one as little as a bad one: every request asks.
	assert.equal(t.resolved.filter((host) => host === "cdn.example.com").length, 9);
	assert.equal(t.resolved.filter((host) => host === "rebind.example.net").length, 9);
	g.detach();
});

// A name can be made to resolve to a public address when the guard first asks and to a private one afterwards.
// Whatever was found for one request says nothing about the next.
test("a name that turns private after it passed once is refused from then on: by every kind of request, by a hop of the top frame, by a worker, and in a later job", async () => {
	let answer = ["93.184.216.34"];
	const t = setup({ resolve: async () => ({ addresses: answer }) });
	// Checked before the tab was made, and fine then.
	assert.equal((await t.guard.precheck("https://rebind.example.net/")).verdict, null);
	const g = t.attach();
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://rebind.example.net/" }), {});
	assert.deepEqual(await t.fire("onBeforeRequest", { type: "image", url: "https://rebind.example.net/a.png" }), {});
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://rebind.example.net/sw" }), {});
	// The record is changed. The page goes on asking for the name.
	answer = ["192.168.1.1"];
	const before = t.resolved.length;
	/** @type {[string, string][]} */
	const requests = [
		["image", "https://rebind.example.net/apply.cgi?x=1"],
		["xmlhttprequest", "https://rebind.example.net/apply.cgi"],
		["sub_frame", "https://rebind.example.net/form-target"],
		["websocket", "wss://rebind.example.net/socket"],
		["beacon", "https://rebind.example.net/b"],
		["script", "https://rebind.example.net/a.js"],
	];
	for (const [type, url] of requests) assert.deepEqual(await t.fire("onBeforeRequest", { type, url }), { cancel: true }, type);
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://rebind.example.net/sw" }), { cancel: true }, "a service worker's request");
	assert.equal(t.resolved.length - before, requests.length + 1, "each of them asked");
	assert.equal(t.verdicts.length, 0, "what a page loads by itself is cancelled quietly");
	// A navigation of the top frame to that name is cancelled too, and ends the job.
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://rebind.example.net/" }), { cancel: true });
	assert.deepEqual(t.verdicts.map((v) => [v.outcome, v.code]), [["policy_blocked", "private_address"]]);

	// A tab that stays open (a page that waits for the operator) carries nothing over into the next job.
	answer = ["93.184.216.34"];
	const next = setup({ resolve: async () => ({ addresses: answer }) });
	const parked = next.guard.attach(TAB + 1, { cookieStoreId: STORE, onVerdict: () => {} });
	const first = next.attach();
	assert.deepEqual(await next.fire("onBeforeRequest", { type: "image", url: "https://rebind.example.net/a.png" }), {});
	first.detach();
	answer = ["10.0.0.7"];
	const second = next.attach();
	assert.deepEqual(await next.fire("onBeforeRequest", { type: "image", url: "https://rebind.example.net/a.png" }), { cancel: true });
	assert.deepEqual(await next.raw("onBeforeRequest", { tabId: TAB + 1, windowId: GATEWAY_WINDOW, cookieStoreId: STORE, type: "image", requestId: "9", url: "https://rebind.example.net/a.png" }), { cancel: true }, "nor does the tab that stayed");
	second.detach();
	parked.detach();
	g.detach();
});

// What asking every time costs. The resolver is the browser's own and answers from its cache; the number of
// questions is what this guard adds. Requests that are on their way at the same time share one question per name,
// so a page costs at most one lookup per request, and far fewer the way a browser asks for them: in bursts.
test("a page with 300 requests to twelve names: one lookup per request at most, one per name for requests that are asked at the same time", async (ctx) => {
	const HOSTS = Array.from({ length: 12 }, (_, i) => `cdn${i}.example.com`);
	const urls = Array.from({ length: 300 }, (_, i) => `https://${HOSTS[i % HOSTS.length]}/asset-${i}.js`);
	/** @param {number} latencyMs how long the resolver takes for one answer */
	const page = async (latencyMs) => {
		const t = setup({ resolve: () => new Promise((resolve) => setTimeout(() => resolve({ addresses: ["93.184.216.34"] }), latencyMs)) });
		const g = t.attach();
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/" }), {});
		return { t, g, lookups: () => t.resolved.length - 1 };
	};

	// All at once, as the parser of a page finds them: twelve lookups.
	const burst = await page(2);
	const began = Date.now();
	assert.deepEqual(await Promise.all(urls.map((url) => burst.t.fire("onBeforeRequest", { type: "script", url }))), urls.map(() => ({})));
	const burstMs = Date.now() - began;
	assert.equal(burst.lookups(), HOSTS.length);
	burst.g.detach();

	// In five waves of sixty, each wave when the one before was answered: twelve per wave.
	const waves = await page(2);
	for (let at = 0; at < urls.length; at += 60) await Promise.all(urls.slice(at, at + 60).map((url) => waves.t.fire("onBeforeRequest", { type: "script", url })));
	assert.equal(waves.lookups(), 5 * HOSTS.length);
	waves.g.detach();

	// One after the other, each when the one before was answered: the most there can be, one per request.
	const serial = await page(0);
	const serialBegan = Date.now();
	for (const url of urls) assert.deepEqual(await serial.t.fire("onBeforeRequest", { type: "script", url }), {});
	const serialMs = Date.now() - serialBegan;
	assert.equal(serial.lookups(), urls.length);
	serial.g.detach();

	// The guard's own share of the time is small beside any network: a generous bound, for a busy machine.
	ctx.diagnostic(`300 requests: ${burst.lookups()} lookups and ${burstMs} ms at once, ${waves.lookups()} lookups in five waves, ${serial.lookups()} lookups and ${serialMs} ms one by one`);
	assert.ok(burstMs < 2000 && serialMs < 5000, `300 requests took ${burstMs} ms at once and ${serialMs} ms one by one`);
});

test("requests for one name at the same time share one lookup; once it is answered the next request asks again", async () => {
	/** @type {((v: { addresses: string[] }) => void)[]} */
	const waiting = [];
	const t = setup({ resolve: () => new Promise((resolve) => waiting.push(resolve)) });
	let g = t.attach();
	const answers = [1, 2, 3, 4].map((n) => t.fire("onBeforeRequest", { type: "image", url: `https://cdn.example.com/${n}.png` }));
	// A hop of the top frame and a worker's request to that name share it as well; another name has its own.
	const hop = t.fire("onBeforeRequest", { url: "https://cdn.example.com/page" });
	const worker = t.tabless("onBeforeRequest", { url: "https://cdn.example.com/sw-data" });
	const other = t.fire("onBeforeRequest", { type: "image", url: "https://img.example.com/1.png" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(t.resolved, ["cdn.example.com", "img.example.com"], "one lookup per name for seven requests");
	waiting[0]({ addresses: ["93.184.216.34"] });
	waiting[1]({ addresses: ["93.184.216.34"] });
	assert.deepEqual(await Promise.all([...answers, hop, worker, other]), [{}, {}, {}, {}, {}, {}, {}]);
	// Answered: the very next request for the name is a new question, in the same job.
	const later = t.fire("onBeforeRequest", { type: "image", url: "https://cdn.example.com/later.png" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(waiting.length, 3);
	// A shared answer that is a refusal is one for all who share it, and is not kept either.
	const shared = [1, 2].map((n) => t.fire("onBeforeRequest", { type: "image", url: `https://cdn.example.com/shared-${n}.png` }));
	waiting[2]({ addresses: ["10.0.0.1"] });
	assert.deepEqual(await Promise.all([later, ...shared]), [{ cancel: true }, { cancel: true }, { cancel: true }]);
	g.detach();
	g = t.attach();
	waiting.length = 1;
	const again = t.fire("onBeforeRequest", { type: "image", url: "https://cdn.example.com/5.png" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(waiting.length, 2);
	// A job that ends while a lookup is under way gets its request cancelled.
	g.seal();
	waiting[1]({ addresses: ["93.184.216.34"] });
	assert.deepEqual(await again, { cancel: true });
	g.detach();
});

test("service-worker requests (no tab, container store): the address rules while a job runs", async () => {
	/** @type {Record<string, string[]>} */
	const zone = { "api.example.com": ["93.184.216.34"], "rebind.example.net": ["10.0.0.9"] };
	const t = setup({ resolve: async (host) => ({ addresses: zone[host] ?? [] }) });
	const g = t.attach();
	assert.equal(t.guard.running, true);
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://api.example.com/data" }), {});
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://sw.example.com/worker.js", type: "script" }), { cancel: true }, "a name that does not resolve");
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "http://127.0.0.1:8791/v1/status" }), { cancel: true });
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "http://192.168.1.1/cgi-bin/reboot" }), { cancel: true });
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "http://printer.local/" }), { cancel: true });
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://rebind.example.net/steal" }), { cancel: true });
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "wss://rebind.example.net/socket", type: "websocket" }), { cancel: true });
	// The address that answered is looked at as well.
	assert.deepEqual(await t.tabless("onHeadersReceived", { url: "https://api.example.com/data", statusCode: 200, ip: "93.184.216.34" }), {});
	assert.deepEqual(await t.tabless("onHeadersReceived", { url: "https://api.example.com/data", statusCode: 200, ip: "10.0.0.9" }), { cancel: true });
	assert.deepEqual(await t.tabless("onHeadersReceived", { url: "https://api.example.com/data", statusCode: 200 }), {}, "from the cache: no address");
	// No login dialog for them either; a proxy's challenge is the operator's own setup.
	assert.deepEqual(await t.tabless("onAuthRequired", { url: "https://api.example.com/data", isProxy: false }), { cancel: true });
	assert.deepEqual(await t.tabless("onAuthRequired", { url: "https://api.example.com/data", isProxy: true }), {});
	assert.deepEqual(t.verdicts, [], "a worker's requests never end the job");
	g.detach();
});

test("while no job runs, every request in the gateway container is cancelled", async () => {
	const t = setup();
	const everything = async () => {
		assert.equal(t.guard.running, false);
		for (const [type, url] of /** @type {[string, string][]} */ ([
			["xmlhttprequest", "https://api.example.com/data"],
			["script", "https://site.example.com/sw.js"],
			["image", "https://93.184.216.34/pixel.gif"],
			["websocket", "wss://live.example.com/socket"],
			["beacon", "https://stats.example.com/b"],
			["xmlhttprequest", "http://127.0.0.1:8791/v1/status"],
			["other", "data:text/plain,hi"],
		])) {
			assert.deepEqual(await t.tabless("onBeforeRequest", { type, url }), { cancel: true }, url);
		}
		assert.deepEqual(await t.tabless("onHeadersReceived", { url: "https://api.example.com/data", statusCode: 200, ip: "93.184.216.34" }), { cancel: true });
		assert.deepEqual(await t.tabless("onHeadersReceived", { type: "main_frame", url: "https://example.com/", statusCode: 200, responseHeaders: h({ "content-type": "text/html" }) }), { cancel: true });
		assert.deepEqual(await t.tabless("onAuthRequired", { url: "https://api.example.com/data", isProxy: false }), { cancel: true });
	};
	await everything();
	assert.deepEqual(t.resolved, [], "nothing is even looked up");
	// During a job they pass; the moment the job is sealed they do not any more.
	const g = t.attach();
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://api.example.com/data" }), {});
	g.seal();
	await everything();
	g.detach();
	await everything();
	assert.deepEqual(t.verdicts, []);
	assert.equal(t.sink.count("guard.container_request_cancelled"), 1, "counted in the log, not listed");
	// The one exception: the extension's own pages (the park page).
	assert.deepEqual(await t.tabless("onBeforeRequest", { type: "main_frame", tabId: 4, url: BASE + "park/park.html" }), {});
	assert.deepEqual(await t.tabless("onHeadersReceived", { type: "main_frame", tabId: 4, url: BASE + "park/park.html", statusCode: 200, responseHeaders: [] }), {});
});

test("a tab a job put under a sealed guard by its id loads nothing, whatever its store", async () => {
	const t = setup();
	const stray = t.guard.quarantine(77);
	assert.equal(stray.stray, true);
	assert.equal(stray.open, false);
	assert.equal(t.guard.quarantine(77), stray, "once");
	assert.equal(t.guard.running, false, "a sealed tab is not a running job");
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 77, cookieStoreId: "firefox-default", type: "main_frame", url: "https://example.com/" }), { cancel: true });
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 77, cookieStoreId: STORE, type: "image", url: "https://example.com/a.png" }), { cancel: true });
	assert.deepEqual(await t.raw("onAuthRequired", { tabId: 77, cookieStoreId: STORE, type: "main_frame", url: "https://example.com/", isProxy: false }), { cancel: true });
	assert.deepEqual(t.verdicts, []);
	stray.detach();
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 77, cookieStoreId: "firefox-default", type: "main_frame", url: "https://example.com/" }), {});
	assert.equal(t.asked(), 0);
	// A job tab is never mistaken for one.
	const g = t.attach();
	assert.equal(t.guard.quarantine(TAB), g);
	assert.equal(g.open, true);
	g.detach();
});

test("while the container is not known only job tabs are guarded", async () => {
	const t = setup({ storeId: null });
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://api.example.com/data" }), {});
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://api.example.com/data", cookieStoreId: undefined }), {});
	const g = t.attach();
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "http://10.0.0.1/" }), { cancel: true });
	g.detach();
	// It follows the container when that is made anew.
	t.setStore("firefox-container-9");
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://api.example.com/data" }), {}, "the old store is not the gateway's any more");
	assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://api.example.com/data", cookieStoreId: "firefox-container-9" }), { cancel: true });
});

test("fail closed on the cookie store: a request outside the container is cancelled", async () => {
	for (const cookieStoreId of ["firefox-default", "firefox-container-8", undefined]) {
		const { attach, fire, verdicts } = setup();
		const g = attach();
		assert.deepEqual(await fire("onBeforeRequest", { url: "https://example.com/", cookieStoreId }), { cancel: true });
		assert.deepEqual({ outcome: verdicts[0].outcome, code: verdicts[0].code }, { outcome: "error", code: "container_mismatch" });
		g.detach();
	}
});

test("the extension's own pages are not the guard's business", async () => {
	const { attach, fire, verdicts } = setup();
	const g = attach();
	assert.deepEqual(await fire("onBeforeRequest", { url: BASE + "park/park.html", cookieStoreId: "firefox-default" }), {});
	assert.deepEqual(verdicts, []);
	g.detach();
});

test("response headers: status and type are recorded, non-pages cancelled before the body", async () => {
	const { attach, fire, verdicts } = setup();
	const g = attach();
	assert.deepEqual(await fire("onHeadersReceived", { url: "https://example.com/", statusCode: 302, ip: "93.184.216.34", responseHeaders: h({ location: "/b" }) }), {});
	assert.equal(g.nav.httpStatus, 302);
	assert.deepEqual(await fire("onHeadersReceived", { url: "https://example.com/b", statusCode: 200, ip: "93.184.216.34", responseHeaders: h({ "content-type": "text/html; charset=utf-8" }) }), {});
	assert.deepEqual(g.nav, { redirectOrigins: [], httpStatus: 200, contentType: "text/html", cfMitigated: false, retryAfterS: null, finalUrl: "https://example.com/b" });
	assert.deepEqual(await fire("onHeadersReceived", { url: "https://example.com/c", statusCode: 200, responseHeaders: h({ "content-type": "application/pdf" }) }), { cancel: true });
	assert.deepEqual({ outcome: verdicts[0].outcome, code: verdicts[0].code }, { outcome: "unsupported", code: "content_type" });
	assert.equal(g.nav.contentType, "application/pdf");
	g.detach();
});

test("frames inside the page: a response that would be saved is cancelled quietly", async () => {
	const { attach, fire, verdicts } = setup();
	const g = attach();
	const frame = { type: "sub_frame", url: "https://files.example.com/x", statusCode: 200 };
	assert.deepEqual(await fire("onHeadersReceived", { ...frame, responseHeaders: h({ "content-type": "application/octet-stream" }) }), { cancel: true });
	assert.deepEqual(await fire("onHeadersReceived", { ...frame, responseHeaders: h({ "content-type": "text/html", "content-disposition": "attachment; filename=a.html" }) }), { cancel: true });
	assert.deepEqual(await fire("onHeadersReceived", { ...frame, responseHeaders: h({ "content-type": "text/html" }) }), {});
	assert.deepEqual(await fire("onHeadersReceived", { ...frame, responseHeaders: h({ "content-type": "image/gif" }) }), {});
	assert.deepEqual(await fire("onHeadersReceived", { ...frame, ip: "192.168.1.4", responseHeaders: h({ "content-type": "text/html" }) }), { cancel: true }, "a frame answered from a private address");
	assert.equal(verdicts.length, 0, "the job goes on");
	assert.deepEqual(g.nav, { redirectOrigins: [], httpStatus: null, contentType: null, cfMitigated: false, retryAfterS: null }, "a frame's response is not the page's");
	g.detach();
});

test("response from a private address: cancelled even though the name looked public", async () => {
	for (const ip of ["10.0.0.5", "127.0.0.1", "::1", "fe80::1", "192.168.1.1"]) {
		const { attach, fire, verdicts } = setup();
		const g = attach();
		assert.deepEqual(await fire("onHeadersReceived", { url: "https://rebind.example.net/", statusCode: 200, ip, responseHeaders: h({ "content-type": "text/html" }) }), { cancel: true }, ip);
		assert.deepEqual({ outcome: verdicts[0].outcome, code: verdicts[0].code }, { outcome: "policy_blocked", code: "private_address" });
		assert.equal(g.nav.httpStatus, null, "nothing of that response is reported");
		g.detach();
	}
	// The later event is a second chance to see the address.
	const late = setup();
	const g = late.attach();
	await late.fire("onResponseStarted", { url: "https://rebind.example.net/", ip: "10.0.0.5" });
	assert.equal(late.verdicts[0].code, "private_address");
	g.detach();
	// What a page loads by itself is held to the same: cancelled, without ending the job.
	const sub = setup();
	const gs = sub.attach();
	for (const type of ["image", "script", "xmlhttprequest", "websocket", "font"]) {
		assert.deepEqual(await sub.fire("onHeadersReceived", { type, url: "https://cdn.example.com/x", statusCode: 200, ip: "192.168.1.1" }), { cancel: true }, type);
		assert.deepEqual(await sub.fire("onHeadersReceived", { type, url: "https://cdn.example.com/x", statusCode: 200, ip: "93.184.216.34" }), {}, type);
	}
	assert.deepEqual(sub.verdicts, []);
	gs.detach();
	// A fixture on an allowed loopback port is the one exception.
	const fx = setup({ policy: FIXTURE });
	const gf = fx.attach();
	assert.deepEqual(await fx.fire("onHeadersReceived", { url: "http://a.localhost:4711/", statusCode: 200, ip: "127.0.0.1", responseHeaders: h({ "content-type": "text/html" }) }), {});
	assert.deepEqual(await fx.fire("onHeadersReceived", { type: "image", url: "http://b.localhost:4711/pixel", statusCode: 200, ip: "::1" }), {});
	assert.deepEqual(await fx.fire("onHeadersReceived", { url: "https://example.com/", statusCode: 200, ip: "127.0.0.1", responseHeaders: h({ "content-type": "text/html" }) }), { cancel: true });
	assert.deepEqual(await fx.fire("onHeadersReceived", { type: "image", url: "http://name.example.net:4711/pixel", statusCode: 200, ip: "127.0.0.1" }), { cancel: true }, "a public name on the fixture port is no fixture");
	gf.detach();
});

// What the browser adds to the details of a request it sends to a proxy (Firefox: host, port, type and more).
const VIA_HTTP = { proxyInfo: { host: "127.0.0.1", port: 3128, type: "http", proxyDNS: false, failoverTimeout: 5 } };
const VIA_SOCKS = { proxyInfo: { host: "proxy.corp.example", port: 1080, type: "socks", proxyDNS: true, failoverTimeout: 5 } };
// And for a request that a proxy configuration told to go straight to the server.
const DIRECT = { proxyInfo: { host: "", port: -1, type: "direct", proxyDNS: false, failoverTimeout: 0 } };

test("behind a proxy no name is looked up by the guard: not for a hop of the top frame, not for what the page loads, not for a worker - and what the text of an address says still decides", async () => {
	for (const via of [VIA_HTTP, VIA_SOCKS, { proxyInfo: { host: "p.example", port: 443, type: "https" } }, { proxyInfo: { host: "p.example", port: 1080, type: "socks4" } }, { proxyInfo: { host: "p.example", port: 1 } }]) {
		const name = JSON.stringify(via.proxyInfo);
		// A resolver that would refuse everything: asked, it would end the job.
		const { guard, attach, fire, tabless, verdicts, resolved } = setup({ resolve: async () => ({ addresses: ["10.0.0.1"] }) });
		const g = attach();
		assert.deepEqual(await fire("onBeforeRequest", { url: "https://example.com/start", ...via }), {}, name);
		assert.deepEqual(await fire("onBeforeRequest", { url: "https://www.example.org/next", ...via }), {}, name);
		for (const type of ["image", "script", "sub_frame", "xmlhttprequest", "websocket", "beacon"]) {
			assert.deepEqual(await fire("onBeforeRequest", { type, url: "https://cdn.example.com/x", ...via }), {}, `${name} ${type}`);
		}
		assert.deepEqual(await tabless("onBeforeRequest", { url: "https://api.example.com/sw", ...via }), {}, name);
		assert.deepEqual(resolved, [], `${name}: the local resolver was asked nothing`);
		assert.equal(verdicts.length, 0, name);
		assert.equal(guard.stats.proxied, true, name);

		// The text rules, all of them, as without a proxy: quietly for what a page loads ...
		for (const url of ["http://127.0.0.1:8791/v1/status", "http://192.168.1.1/cgi", "http://[::1]/", "https://printer.local/", "ws://localhost:9222/devtools", "http://169.254.169.254/latest/meta-data/"]) {
			assert.deepEqual(await fire("onBeforeRequest", { type: "xmlhttprequest", url, ...via }), { cancel: true }, `${name} ${url}`);
			assert.deepEqual(await tabless("onBeforeRequest", { url, ...via }), { cancel: true }, `${name} worker ${url}`);
		}
		assert.equal(verdicts.length, 0, name);
		g.detach();
		// ... and with a verdict for a hop of the top frame: a private address, a local name, a blocklisted site, no web address.
		for (const [url, code] of /** @type {[string, string][]} */ ([
			["http://10.0.0.1/admin", REASON.PRIVATE_ADDRESS],
			["http://router.local/", REASON.LOCAL_NAME],
			["https://accounts.google.com/signin", REASON.BLOCKLISTED],
			["http://fileserver/", REASON.SINGLE_LABEL],
			["https://user:pw@example.com/", REASON.USERINFO],
			["ftp://example.com/file", REASON.SCHEME],
		])) {
			const hop = setup();
			const gh = hop.attach();
			await hop.fire("onBeforeRequest", { url: "https://example.com/", ...via });
			assert.deepEqual(await hop.fire("onBeforeRequest", { url, ...via }), { cancel: true }, `${name} ${url}`);
			assert.deepEqual({ outcome: hop.verdicts[0].outcome, code: hop.verdicts[0].code }, { outcome: "policy_blocked", code }, `${name} ${url}`);
			gh.detach();
		}
	}
});

test("behind a proxy the address that answered is the proxy's and is not looked at; without one, and for a request a proxy configuration sends directly, it is", async () => {
	for (const via of [VIA_HTTP, VIA_SOCKS]) {
		// A proxy on this machine or in its network answers every request from a private address.
		for (const ip of ["127.0.0.1", "::1", "10.0.0.5", "192.168.1.1", "fe80::1"]) {
			const { attach, fire, tabless, verdicts, sink } = setup();
			const g = attach();
			await fire("onBeforeRequest", { url: "https://example.com/", ...via });
			assert.deepEqual(await fire("onHeadersReceived", { url: "https://example.com/", statusCode: 200, ip, responseHeaders: h({ "content-type": "text/html" }), ...via }), {}, ip);
			await fire("onResponseStarted", { url: "https://example.com/", ip, ...via });
			for (const type of ["image", "script", "xmlhttprequest", "websocket", "font"]) {
				assert.deepEqual(await fire("onHeadersReceived", { type, url: "https://cdn.example.com/x", statusCode: 200, ip, ...via }), {}, `${ip} ${type}`);
			}
			assert.deepEqual(await fire("onHeadersReceived", { type: "sub_frame", url: "https://frames.example.com/f", statusCode: 200, ip, responseHeaders: h({ "content-type": "text/html" }), ...via }), {}, ip);
			assert.deepEqual(await tabless("onHeadersReceived", { url: "https://api.example.com/sw", statusCode: 200, ip, ...via }), {}, ip);
			await tabless("onResponseStarted", { url: "https://api.example.com/sw", ip, ...via });
			assert.equal(verdicts.length, 0, ip);
			assert.equal(g.nav.httpStatus, 200, "the response is the page's, and is judged as one");
			assert.equal(sink.count("guard.private_response"), 0);
			// Everything else the headers are judged by is as it was: a download is no page, behind a proxy or not.
			assert.deepEqual(await fire("onHeadersReceived", { type: "sub_frame", url: "https://frames.example.com/zip", statusCode: 200, ip, responseHeaders: h({ "content-type": "application/zip" }), ...via }), { cancel: true }, ip);
			g.detach();
		}
	}
	// Told "direct" by a proxy configuration, or told nothing: the browser talks to the server, and its address counts.
	for (const how of [DIRECT, {}, { proxyInfo: null }, { proxyInfo: undefined }]) {
		const name = JSON.stringify(how);
		const { attach, fire, tabless, verdicts, resolved, guard } = setup();
		const g = attach();
		await fire("onBeforeRequest", { url: "https://rebind.example.net/", ...how });
		assert.deepEqual(resolved, ["rebind.example.net"], `${name}: the name was looked up`);
		assert.deepEqual(await fire("onHeadersReceived", { type: "image", url: "https://cdn.example.com/x", statusCode: 200, ip: "192.168.1.1", ...how }), { cancel: true }, name);
		assert.deepEqual(await tabless("onHeadersReceived", { url: "https://api.example.com/sw", statusCode: 200, ip: "10.0.0.5", ...how }), { cancel: true }, name);
		assert.deepEqual(await fire("onHeadersReceived", { url: "https://rebind.example.net/", statusCode: 200, ip: "10.0.0.5", responseHeaders: h({ "content-type": "text/html" }), ...how }), { cancel: true }, name);
		assert.equal(verdicts[0].code, "private_address", name);
		assert.equal(guard.stats.proxied, false, name);
		g.detach();
	}
	// Request by request: under a configuration that sends some hosts to a proxy and others not, each is judged by how it goes.
	const mixed = setup({ resolve: async (host) => ({ addresses: [host === "intranet.example.com" ? "10.0.0.7" : "93.184.216.34"] }) });
	const gm = mixed.attach();
	assert.deepEqual(await mixed.fire("onBeforeRequest", { type: "image", url: "https://far.example.com/a.png", ...VIA_HTTP }), {});
	assert.deepEqual(await mixed.fire("onBeforeRequest", { type: "image", url: "https://intranet.example.com/a.png", ...DIRECT }), { cancel: true });
	assert.deepEqual(await mixed.fire("onBeforeRequest", { type: "image", url: "https://intranet.example.com/a.png", ...VIA_HTTP }), {});
	assert.deepEqual(mixed.resolved, ["intranet.example.com"]);
	gm.detach();
});

test("that requests go through a proxy is said once per session, by the kind of proxy alone - and from then on no name is looked up before a tab is made either", async () => {
	const { guard, attach, fire, tabless, resolved, sink } = setup();
	// Nothing seen yet: the check before the tab is made asks the resolver, as ever.
	assert.equal((await guard.precheck("https://first.example.com/secret-path?token=1")).verdict, null);
	assert.deepEqual(resolved, ["first.example.com"]);
	assert.equal(sink.count("guard.proxied"), 0);
	assert.equal(guard.stats.proxied, false);
	const g = attach();
	await fire("onBeforeRequest", { url: "https://first.example.com/secret-path?token=1", ...VIA_SOCKS });
	for (let i = 0; i < 20; i++) await fire("onBeforeRequest", { type: "image", url: `https://img${i}.example.com/p.png`, ...(i % 2 === 0 ? VIA_SOCKS : VIA_HTTP) });
	await fire("onHeadersReceived", { url: "https://first.example.com/secret-path?token=1", statusCode: 200, ip: "127.0.0.1", responseHeaders: h({ "content-type": "text/html" }), ...VIA_SOCKS });
	await tabless("onBeforeRequest", { url: "https://api.example.com/sw", ...VIA_HTTP });
	g.detach();
	assert.deepEqual(sink.entries.filter((e) => e.event === "guard.proxied"), [{ event: "guard.proxied", fields: { type: "socks" } }]);
	assert.equal(/example|secret|token|corp|1080|3128|127\.0/.test(sink.text()), false, sink.text());
	assert.equal(guard.stats.proxied, true);
	// The next job: its address is held to the policy before a tab is made, and its name is asked of nobody.
	assert.equal((await guard.precheck("https://second.example.com/")).verdict, null);
	assert.deepEqual(resolved, ["first.example.com"]);
	assert.equal((await guard.precheck("http://192.168.1.1/")).verdict?.code, REASON.PRIVATE_ADDRESS);
	assert.equal((await guard.precheck("https://accounts.google.com/")).verdict?.code, REASON.BLOCKLISTED);
	assert.equal((await guard.precheck("http://router.local/")).verdict?.code, REASON.LOCAL_NAME);

	// A kind of proxy the browser names in a way nobody knows is "other" in the log: no text of its making gets there.
	const odd = setup();
	const go = odd.attach();
	await odd.fire("onBeforeRequest", { url: "https://example.com/", proxyInfo: { host: "x", port: 1, type: "https://leak.example/?" } });
	assert.deepEqual(odd.sink.entries.filter((e) => e.event === "guard.proxied").map((e) => e.fields), [{ type: "other" }]);
	go.detach();

	// The operator's own requests are not asked how they travel, and say nothing about it.
	const theirs = setup();
	await theirs.raw("onBeforeRequest", { tabId: -1, cookieStoreId: "firefox-default", type: "xmlhttprequest", url: "https://their.example.com/sw", ...VIA_HTTP });
	assert.equal(theirs.guard.stats.proxied, false);
	assert.equal(theirs.sink.count("guard.proxied"), 0);
});

test("HTTP authentication: cancelled, no dialog; a proxy's challenge is left alone", async () => {
	const { attach, fire, verdicts } = setup();
	const g = attach();
	assert.deepEqual(await fire("onAuthRequired", { url: "https://example.com/a.png", type: "image", isProxy: false }), { cancel: true });
	assert.equal(verdicts.length, 0, "a resource asking for a login does not end the job");
	assert.deepEqual(await fire("onAuthRequired", { url: "https://example.com/", isProxy: true }), {});
	assert.deepEqual(await fire("onAuthRequired", { url: "https://example.com/", isProxy: false }), { cancel: true });
	assert.deepEqual({ outcome: verdicts[0].outcome, code: verdicts[0].code }, { outcome: "error", code: "auth_required" });
	g.detach();
});

test("sealed: after the job nothing leaves the tab, and no verdict is made up", async () => {
	const { attach, fire, verdicts } = setup();
	const g = attach();
	g.seal();
	assert.deepEqual(await fire("onBeforeRequest", { url: "https://example.com/" }), { cancel: true });
	assert.deepEqual(await fire("onBeforeRequest", { url: "https://example.com/a.js", type: "script" }), { cancel: true });
	assert.deepEqual(await fire("onHeadersReceived", { url: "https://example.com/", statusCode: 200, responseHeaders: h({ "content-type": "text/html" }) }), { cancel: true });
	assert.deepEqual(await fire("onHeadersReceived", { url: "https://example.com/a.js", type: "script", statusCode: 200 }), { cancel: true });
	assert.deepEqual(verdicts, []);
	g.detach();
});

// Add-ons that keep sites in containers of their own answer a navigation by cancelling it and opening its address
// again in a new tab, in their container - with whatever the operator is logged in to there - right next to the
// tab they took it from. The gateway makes every tab of its window itself, so one that somebody else makes there
// while a job tab is open is not let load anything.
test("a tab somebody else makes in the gateway window while a job tab is open is sealed before it loads anything, whatever its cookie store - and the job whose page it took over is named", async () => {
	const PAGE = { statusCode: 200, ip: "93.184.216.34", responseHeaders: h({ "content-type": "text/html" }) };
	for (const [wide, store] of /** @type {[boolean, string][]} */ ([[false, "firefox-container-3"], [false, "firefox-default"], [true, "firefox-container-3"]])) {
		const t = setup();
		t.guard.watchWindow(GATEWAY_WINDOW);
		if (wide) t.guard.widen("test");
		const g = t.attach();
		// The job tab asks for its page. Another add-on cancels that request and makes a tab of its own for the address.
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://bank.example.com/transfer?to=x" }), {});
		t.tabs.onCreated.fire({ id: 77, windowId: GATEWAY_WINDOW, cookieStoreId: store, index: 2, url: "about:blank" });
		assert.deepEqual(t.strays, [{ tabId: 77, windowId: GATEWAY_WINDOW, openerTabId: null, duringJob: true, foreign: true, reopenedFrom: TAB }], store);
		const theirs = { tabId: 77, windowId: GATEWAY_WINDOW, cookieStoreId: store, requestId: "70" };
		// Its very first request is cancelled - also when only the listener of the gateway window hears it, which was
		// there before the tab was: the tab's own listeners are a moment too new for a request that is on its way.
		const early = t.wr.onBeforeRequest.listeners.filter(({ args }) => wide || /** @type {any} */ (args[0]).windowId === GATEWAY_WINDOW);
		assert.equal(early.length, 1);
		assert.deepEqual(await early[0].fn({ ...theirs, type: "main_frame", url: "https://bank.example.com/transfer?to=x" }), { cancel: true }, store);
		assert.deepEqual(await t.raw("onBeforeRequest", { ...theirs, type: "main_frame", url: "https://bank.example.com/transfer?to=x" }), { cancel: true });
		assert.deepEqual(await t.raw("onBeforeRequest", { ...theirs, type: "image", url: "https://bank.example.com/logo.png" }), { cancel: true });
		assert.deepEqual(await t.raw("onHeadersReceived", { ...theirs, type: "main_frame", url: "https://bank.example.com/", ...PAGE }), { cancel: true });
		assert.deepEqual(await t.raw("onAuthRequired", { ...theirs, type: "main_frame", url: "https://bank.example.com/", isProxy: false }), { cancel: true });
		// Whose tab it is is for the window module to say (it may be making that very tab): the job goes on until then.
		assert.deepEqual([t.verdicts.length, g.open], [0, true]);
		t.guard.reassigned(TAB);
		assert.deepEqual(t.verdicts.map((v) => [v.outcome, v.code]), [["error", "reassigned_by_addon"]]);
		assert.equal(/bank|example/.test(t.verdicts[0].message), false, "no address in the message");
		assert.equal(g.open, false);
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://bank.example.com/again" }), { cancel: true }, "the job tab loads nothing more either");
		t.guard.reassigned(TAB + 5);
		t.guard.reassigned(77);
		assert.equal(t.verdicts.length, 1, "once, and for a job tab only");
		// The tab is closed: its seal goes with it.
		t.tabs.onRemoved.fire(77);
		g.detach();
	}

	// Which job, if any: the one whose top frame asked for a page that has not been answered, a moment ago at most.
	const t = setup();
	t.guard.watchWindow(GATEWAY_WINDOW);
	const g = t.attach();
	const other = t.guard.attach(TAB + 1, { cookieStoreId: STORE, onVerdict: () => {} });
	let id = 80;
	const made = () => {
		t.strays.length = 0;
		t.tabs.onCreated.fire({ id: (id += 1), windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-container-3" });
		return t.strays[0];
	};
	assert.deepEqual(made(), { tabId: 81, windowId: GATEWAY_WINDOW, openerTabId: null, duringJob: true, foreign: true, reopenedFrom: null }, "no job tab has asked for anything: sealed all the same");
	await t.fire("onBeforeRequest", { url: "https://example.com/", requestId: "5" });
	assert.equal(made().reopenedFrom, TAB, "asked, not answered");
	await t.raw("onBeforeRequest", { tabId: TAB + 1, windowId: GATEWAY_WINDOW, cookieStoreId: STORE, type: "main_frame", requestId: "6", url: "https://www.example.org/" });
	assert.equal(made().reopenedFrom, TAB + 1, "of two, the one that asked last");
	// The request of that one was cancelled by somebody: still the one.
	for (const { fn } of t.wr.onErrorOccurred.listeners) fn({ tabId: TAB + 1, cookieStoreId: STORE, type: "main_frame", requestId: "6", url: "https://www.example.org/", error: "NS_ERROR_ABORT" });
	assert.equal(made().reopenedFrom, TAB + 1);
	other.detach();
	// A page that was answered is on its way into the tab: a tab that appears now took nothing over.
	await t.fire("onHeadersReceived", { url: "https://example.com/", requestId: "5", ...PAGE });
	assert.equal(made().reopenedFrom, null);
	assert.equal(t.guard.stats.running, true);
	g.detach();

	// A job tab that outlived its job is still a tab whose page can be taken over.
	const kept = setup();
	kept.guard.watchWindow(GATEWAY_WINDOW);
	const k = kept.attach();
	k.retire();
	kept.tabs.onCreated.fire({ id: 90, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-container-3" });
	assert.equal(kept.strays.length, 1);
	k.detach();
});

test("what is never sealed for appearing: a tab in another window, a tab that appears while no job tab is open, a tab that was moved into the gateway window - and a tab the gateway made itself is given back", async () => {
	const t = setup();
	t.guard.watchWindow(GATEWAY_WINDOW);
	const web = { type: "main_frame", requestId: "9", url: "https://example.com/" };
	// No job tab is open: the operator moving in, as far as anyone can tell. Not sealed, not reported; its requests pass.
	t.tabs.onCreated.fire({ id: 60, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-default" });
	t.tabs.onCreated.fire({ id: 61, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-container-3" });
	assert.equal(t.strays.length, 0);
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 60, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-default", ...web }), {});
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 61, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-container-3", ...web }), {});

	const g = t.attach();
	await t.fire("onBeforeRequest", { url: "https://example.com/" });
	// A job tab is open. In the operator's own windows nothing changes: their new tabs are not heard, let alone sealed.
	t.tabs.onCreated.fire({ id: 62, windowId: OTHER_WINDOW, cookieStoreId: "firefox-default" });
	t.tabs.onCreated.fire({ id: 63, windowId: OTHER_WINDOW, cookieStoreId: "firefox-container-3", openerTabId: 62 });
	t.tabs.onCreated.fire({ id: 64, cookieStoreId: "firefox-container-3" });
	assert.equal(t.strays.length, 0);
	for (const tabId of [62, 63, 64]) {
		assert.deepEqual(await t.raw("onBeforeRequest", { tabId, windowId: OTHER_WINDOW, cookieStoreId: "firefox-container-3", ...web }), {});
		assert.equal(t.asked(), 0, "no listener of the guard is even asked");
	}
	// The tabs that were in the gateway window before, and a tab that is moved into it (which the browser does not
	// report as made): the operator's, as before. The window listener hears them and has no objection.
	for (const tabId of [60, 61, 65]) {
		assert.deepEqual(await t.raw("onBeforeRequest", { tabId, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-container-3", ...web }), {});
		assert.equal(t.asked(), 1);
	}
	assert.equal(t.strays.length, 0);

	// A tab the gateway makes itself in its window is reported like any other; the seal is taken off again when the
	// window module says it is the park tab, and a job tab is claimed by its job.
	t.tabs.onCreated.fire({ id: 66, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-default" });
	t.tabs.onCreated.fire({ id: 67, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-default" });
	assert.deepEqual(t.strays.map((s) => [s.tabId, s.foreign]), [[66, true], [67, true]]);
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 66, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-default", type: "main_frame", requestId: "9", url: BASE + "park/park.html" }), {}, "the extension's own page loads in it, sealed or not");
	t.guard.release(66);
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: 66, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-default", ...web }), {});
	const login = t.guard.attach(67, { cookieStoreId: "firefox-default", onVerdict: () => {} });
	assert.equal(login.open, true);
	t.guard.release(67);
	t.guard.release(TAB);
	assert.deepEqual([login.open, g.open], [true, true], "a job tab is not let go of that way");
	login.detach();
	g.detach();

	// The gateway window is not known: nothing is taken for it.
	const none = setup();
	const n = none.attach();
	none.tabs.onCreated.fire({ id: 70, windowId: GATEWAY_WINDOW, cookieStoreId: "firefox-container-3" });
	none.tabs.onCreated.fire({ id: 71, cookieStoreId: "firefox-container-3" });
	assert.deepEqual(none.strays, []);
	n.detach();
});

test("a job tab that outlived its job stays under its guard, sealed, until the browser says it is gone", async () => {
	const t = setup();
	t.guard.watchWindow(GATEWAY_WINDOW);
	const g = t.attach();
	const page = { statusCode: 200, ip: "93.184.216.34", responseHeaders: h({ "content-type": "text/html" }) };
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/" }), {});
	assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/", ...page }), {});
	// The job is over, and the browser did not close the tab.
	g.seal();
	g.retire();
	assert.deepEqual([g.retired, g.open, t.guard.running], [true, false, false]);
	const listeners = t.count();
	// Whatever the page in it does now is cancelled - where the tab was, and in a window of its own, where no
	// listener of the gateway window stands behind it.
	for (const windowId of [GATEWAY_WINDOW, OTHER_WINDOW]) {
		assert.deepEqual(await t.fire("onBeforeRequest", { windowId, url: "https://example.com/next" }), { cancel: true });
		assert.deepEqual(await t.fire("onBeforeRequest", { windowId, type: "xmlhttprequest", url: "https://example.com/api" }), { cancel: true });
		assert.deepEqual(await t.fire("onBeforeRequest", { windowId, type: "websocket", url: "wss://example.com/socket" }), { cancel: true });
		assert.deepEqual(await t.fire("onHeadersReceived", { windowId, url: "https://example.com/next", ...page }), { cancel: true });
		assert.equal(t.asked() > 0, true, "heard by the tab's own listeners");
	}
	assert.deepEqual(t.verdicts, [], "and no verdict is made up for a job that is over");
	// What it loaded stays known for as long as it is there: a download it starts now is still a job's.
	assert.deepEqual([...t.guard.jobTraces(0).origins.keys()], ["https://example.com"]);
	// Another tab closes: nothing changes.
	t.tabs.onRemoved.fire(TAB + 1);
	assert.deepEqual(t.count(), listeners);
	assert.deepEqual(await t.fire("onBeforeRequest", { windowId: OTHER_WINDOW, url: "https://example.com/next" }), { cancel: true });
	// The browser says the tab is gone: only now does the guard let go.
	t.tabs.onRemoved.fire(TAB);
	assert.deepEqual(t.count(), [2, 2, 1, 1], "the listeners of the tab are gone: left are those for requests without a tab, and the one of the gateway window");
	assert.deepEqual(await t.raw("onBeforeRequest", { tabId: TAB, windowId: OTHER_WINDOW, cookieStoreId: "firefox-default", type: "main_frame", url: "https://example.com/" }), {});
	assert.equal(t.asked(), 0);

	// A job tab whose job is still running is not let go of by that event: its job is told, and decides.
	const running = setup();
	const r = running.attach();
	running.tabs.onRemoved.fire(TAB);
	assert.deepEqual(await running.fire("onBeforeRequest", { url: "http://10.0.0.1/" }), { cancel: true });
	assert.equal(running.verdicts.length, 1);
	r.detach();
});

// For a page that does not finish loading: where it stands, as far as this guard can tell. A request that waits
// for an answer of the guard is one the page waits for.
test("what the guard can say of a job tab whose page does not finish loading: the answers it still owes, and the lookups that are under way, were slow or ran into the deadline - counts and times only", async () => {
	/** @type {((v: { addresses: string[] }) => void)[]} */
	const slow = [];
	const t = setup({
		resolve: (host) => {
			if (host.startsWith("slow")) return new Promise((resolve) => slow.push(resolve));
			if (host.startsWith("dead")) return new Promise(() => {});
			if (host.startsWith("gone")) return Promise.reject(new Error("NS_ERROR_UNKNOWN_HOST"));
			return Promise.resolve({ addresses: host.startsWith("inner") ? ["10.0.0.9"] : ["93.184.216.34"] });
		},
	});
	const g = t.attach();
	const NOTHING = { top_load: "none", top_requests: 0, top_after_commit: 0, top_asked_ms: -1, answers_owed: 0, top_answer_owed: false, answer_oldest_ms: -1, lookups_under_way: 0, lookups: 0, lookups_shared: 0, lookups_failed: 0, lookups_refused: 0, lookups_deadline: 0, lookup_slowest_ms: 0, cancelled: 0, cancelled_most: "", file_tried: false, download: false };
	assert.deepEqual(g.diagnose(), NOTHING);
	// The page is asked for and answered.
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/" }), {});
	assert.deepEqual({ ...g.diagnose(), top_asked_ms: 0, lookup_slowest_ms: 0 }, { ...NOTHING, top_load: "asked", top_requests: 1, top_asked_ms: 0, lookups: 1 });
	assert.ok(g.diagnose().top_asked_ms >= 0);
	await t.fire("onHeadersReceived", { url: "https://example.com/", statusCode: 200, ip: "93.184.216.34", responseHeaders: h({ "content-type": "text/html" }) });
	assert.equal(g.diagnose().top_load, "passed");
	// The document is in the tab. The page asks for itself again, and is answered again: counted as a second visit of the top frame.
	assert.equal(g.committed("https://example.com/"), true);
	assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/", requestId: "1b" }), {});
	await t.fire("onHeadersReceived", { url: "https://example.com/", requestId: "1b", statusCode: 200, ip: "93.184.216.34", responseHeaders: h({ "content-type": "text/html" }) });
	assert.deepEqual([g.diagnose().top_requests, g.diagnose().top_after_commit, g.diagnose().top_load], [2, 1, "passed"]);
	// Three things of the page wait for one lookup that takes its time; a worker's request for another name waits too.
	const waiting = [1, 2, 3].map((n) => t.fire("onBeforeRequest", { type: "script", requestId: `s${n}`, url: `https://slow.example.com/${n}.js` }));
	const worker = t.tabless("onBeforeRequest", { url: "https://slower.example.com/data" });
	await new Promise((resolve) => setTimeout(resolve, 30));
	let d = g.diagnose();
	assert.deepEqual([d.answers_owed, d.top_answer_owed, d.lookups_under_way, d.lookups, d.lookups_shared], [4, false, 2, 4, 2], "the tab's own and those without a tab, which the page may wait for as well");
	assert.ok(d.answer_oldest_ms >= 25 && d.answer_oldest_ms < 2000, String(d.answer_oldest_ms));
	slow[0]({ addresses: ["93.184.216.34"] });
	slow[1]({ addresses: ["93.184.216.34"] });
	assert.deepEqual(await Promise.all([...waiting, worker]), [{}, {}, {}, {}]);
	d = g.diagnose();
	assert.deepEqual([d.answers_owed, d.answer_oldest_ms, d.lookups_under_way], [0, -1, 0]);
	assert.ok(d.lookup_slowest_ms >= 25, "how long the slowest took");
	// A name that does not resolve, one that leads inside, and one whose lookup never answers: each counted for what it was.
	assert.deepEqual(await t.fire("onBeforeRequest", { type: "image", url: "https://gone.example.com/a.png" }), { cancel: true });
	assert.deepEqual(await t.fire("onBeforeRequest", { type: "image", url: "https://inner.example.com/a.png" }), { cancel: true });
	// What the guard cancelled is counted by why, in fixed words: an address that is private by its text, a frame
	// that would be saved, a response from inside, a login dialog.
	assert.deepEqual(await t.fire("onBeforeRequest", { type: "image", url: "http://192.168.1.1/a.png" }), { cancel: true });
	assert.deepEqual(await t.fire("onBeforeRequest", { type: "image", url: "http://printer.local/a.png" }), { cancel: true });
	assert.deepEqual(await t.fire("onBeforeRequest", { type: "image", url: "http://10.0.0.1/a.png" }), { cancel: true });
	assert.deepEqual(await t.fire("onHeadersReceived", { type: "sub_frame", url: "https://files.example.com/x", statusCode: 200, responseHeaders: h({ "content-type": "application/zip" }) }), { cancel: true });
	assert.deepEqual(await t.fire("onHeadersReceived", { type: "image", url: "https://cdn.example.com/x", statusCode: 200, ip: "10.0.0.5" }), { cancel: true });
	assert.deepEqual(await t.fire("onAuthRequired", { type: "image", url: "https://cdn.example.com/x", isProxy: false }), { cancel: true });
	d = g.diagnose();
	assert.deepEqual([d.cancelled, d.cancelled_most, d.file_tried, d.download], [8, "local*3,auth*1,dns*1", false, false], "the three most frequent, and of equals the first by name");
	const dead = t.fire("onBeforeRequest", { url: "https://dead.example.com/next" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual([g.diagnose().top_answer_owed, g.diagnose().top_load, g.diagnose().top_requests, g.diagnose().top_after_commit], [true, "asked", 3, 2], "the top frame itself waits");
	assert.deepEqual(await dead, { cancel: true });
	d = g.diagnose();
	assert.deepEqual([d.lookups, d.lookups_failed, d.lookups_refused, d.lookups_deadline, d.answers_owed], [7, 1, 1, 1, 0]);
	assert.deepEqual([d.cancelled, d.cancelled_most], [9, "local*3,dns*2,auth*1"]);
	// A request after the verdict is cancelled because the tab loads nothing more; a download that was caught is said.
	assert.deepEqual(await t.fire("onBeforeRequest", { type: "image", url: "https://example.com/late.png" }), { cancel: true });
	t.guard.noteDownload();
	assert.deepEqual([g.diagnose().cancelled, g.diagnose().download], [10, true]);
	assert.ok(d.lookup_slowest_ms >= 190, "the deadline is the slowest there is");
	assert.deepEqual(t.sink.entries.filter((e) => e.event === "guard.lookup_deadline").map((e) => e.fields), [{ count: 1 }], "and is said in the log when it happens, by its number alone");
	// Numbers, yes or no, and one of four words: nothing of a request is in it.
	for (const [name, value] of Object.entries(d)) assert.ok(typeof value === "number" || typeof value === "boolean" || ["none", "asked", "passed", "failed"].includes(/** @type {string} */ (value)) || /^[a-z]{1,8}\*\d+(,[a-z]{1,8}\*\d+){0,2}$/.test(/** @type {string} */ (value)), name);
	assert.equal(JSON.stringify(d).includes("example"), false);
	g.detach();
	// The next job counts from nothing.
	const next = t.attach();
	assert.deepEqual(next.diagnose(), NOTHING);
	next.detach();

	// A top-frame response that is a file matter is said, whether it was read or refused.
	const f = setup();
	const file = f.guard.attach(TAB, { cookieStoreId: STORE, onVerdict: () => {}, files: { maxBytes: 1000, types: ["application/pdf"] } });
	await f.fire("onBeforeRequest", { url: "https://example.com/x.zip" });
	assert.deepEqual(await f.fire("onHeadersReceived", { url: "https://example.com/x.zip", statusCode: 200, ip: "93.184.216.34", responseHeaders: h({ "content-type": "application/zip" }) }), { cancel: true });
	assert.deepEqual([file.diagnose().file_tried, file.diagnose().cancelled_most], [true, "file*1"]);
	file.detach();
});

test("the guard only ever cancels: no listener returns anything that changes a request, and response headers are answered with in one place only", async () => {
	// Every answer in this file goes through the same check (see setup); this
	// runs the whole range of events once more and looks at the source.
	const { attach, fire, tabless } = setup();
	const g = attach();
	await fire("onBeforeRequest", { url: "https://example.com/" });
	await fire("onBeforeRequest", { url: "https://cdn.example.com/x.js", type: "script" });
	await fire("onHeadersReceived", { url: "https://example.com/", statusCode: 200, responseHeaders: h({ "content-type": "text/html" }) });
	await fire("onAuthRequired", { url: "https://example.com/", isProxy: true });
	await tabless("onBeforeRequest", { url: "https://api.example.com/" });
	await fire("onBeforeRequest", { url: "http://10.0.0.1/" });
	await fire("onHeadersReceived", { url: "https://example.com/", statusCode: 200, responseHeaders: h({ "content-type": "text/html" }) });
	await fire("onAuthRequired", { url: "https://example.com/", isProxy: false });
	g.detach();
	const fs = await import("node:fs");
	/** @param {string} file @returns {string} the source without its comments */
	const code = (file) => fs.readFileSync(new URL(`../../extension/background/${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
	const source = code("guard.js");
	// Nothing of a request is ever changed, and no request header is even asked for.
	for (const banned of ["redirectUrl", "requestHeaders", "upgradeToSecure", "authCredentials", "onBeforeSendHeaders", "onSendHeaders"]) {
		assert.equal(source.includes(banned), false, `guard.js must not use ${banned}`);
	}
	// The one thing it may do besides cancelling: read the top-level response of a job tab that is a file. One
	// place makes the filter, and what handles it (capture.js) takes the bytes and gives none back: it never
	// writes to the filter and never lets the rest of a response through.
	assert.equal(source.split("filterResponseData").length - 1, 1, "one place in guard.js makes a response filter");
	// The one exception to "never a header": one statement in guard.js answers the browser with
	// response headers - in the method that makes the filter - and they come from one call of the one function
	// that makes them, behind the method that checks every condition of the exception.
	assert.equal(source.split("responseHeaders:").length - 1, 1, "one place in guard.js answers with response headers");
	assert.ok(source.includes("return relabelled === undefined ? PASS : { responseHeaders: relabelled };"), "and it is the end of #read");
	assert.equal(source.split("relabelForCapture(").length - 1, 1, "one call of the function that makes them");
	assert.equal(source.split("#relabelled(").length - 1, 2, "from the one method that checks the conditions: defined once, called once");
	const read = source.slice(source.indexOf("\t#read(details, plan) {"), source.indexOf("\t#loaded(url) {"));
	assert.ok(read.includes("this.#relabelled(details, plan)") && read.includes("filterResponseData") && read.includes("responseHeaders:"), "all of it in #read");
	const capture = code("capture.js");
	for (const banned of [".write(", ".disconnect(", ".suspend(", ".resume(", "redirectUrl", "requestHeaders", "responseHeaders:", "filterResponseData", "webRequest", "tabs.", "downloads."]) {
		assert.equal(capture.includes(banned), false, `capture.js must not use ${banned}`);
	}
	// What capture.js makes are three header lines, in one function (the third since 0.1.7: "Cache-Control: no-store",
	// so that the browser keeps nothing of a response it was told other things about); it has no way to hand them
	// to the browser.
	assert.equal(capture.split('{ name: "').length - 1, 3, "three headers are made, in one statement");
	assert.ok(capture.includes('out.push({ name: "Content-Type", value: RELABEL_TYPE }, { name: "X-Content-Type-Options", value: "nosniff" }, { name: "Cache-Control", value: "no-store" });'));
	assert.equal(capture.split("export function relabelForCapture(").length - 1, 1);
	// No other file of the extension makes a response filter, answers with headers, or reads those of a request.
	const dir = new URL("../../extension/", import.meta.url);
	for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".js") || entry.parentPath.includes("vendor")) continue;
		const rel = `${entry.parentPath}/${entry.name}`;
		const text = fs.readFileSync(rel, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		for (const banned of ["requestHeaders", "onBeforeSendHeaders", "onSendHeaders", "redirectUrl", "upgradeToSecure"]) assert.equal(text.includes(banned), false, `${rel} must not use ${banned}`);
		if (rel.endsWith("background/guard.js")) continue;
		assert.equal(text.includes("filterResponseData"), false, `${rel} must not make a response filter`);
		assert.equal(text.includes("responseHeaders:"), false, `${rel} must not answer a request with headers`);
		if (!rel.endsWith("background/capture.js")) assert.equal(text.includes("relabelForCapture"), false, `${rel} has no business with the headers of a download`);
	}
});

test("a refusal stands whatever the log and the job make of it: the request is cancelled before either is told", async () => {
	const boom = () => {
		throw new Error("the callback failed");
	};
	// The job's own callback fails: at once (a literal address) and after a lookup (a name).
	const a = setup({ resolve: async () => ({ addresses: ["10.1.2.3"] }) });
	let g = a.guard.attach(TAB, { cookieStoreId: STORE, onVerdict: boom });
	assert.deepEqual(await a.fire("onBeforeRequest", { url: "http://192.168.1.1/admin" }), { cancel: true });
	assert.equal(g.verdict?.code, "private_address", "the verdict is kept");
	assert.deepEqual(await a.fire("onBeforeRequest", { url: "https://example.com/" }), { cancel: true }, "and nothing more leaves the tab");
	g.detach();
	g = a.guard.attach(TAB, { cookieStoreId: STORE, onVerdict: boom });
	assert.deepEqual(await a.fire("onBeforeRequest", { url: "https://rebind.example.net/" }), { cancel: true });
	assert.equal(g.verdict?.code, "private_address");
	g.detach();
	g = a.guard.attach(TAB, { cookieStoreId: STORE, onVerdict: boom });
	assert.deepEqual(await a.fire("onHeadersReceived", { url: "https://example.com/", statusCode: 200, ip: "10.0.0.5", responseHeaders: h({ "content-type": "text/html" }) }), { cancel: true });
	assert.deepEqual(await a.fire("onAuthRequired", { url: "https://example.com/", isProxy: false }), { cancel: true });
	g.detach();
	// The log fails: every decision is the same as with one that works.
	const b = setup({ resolve: async () => ({ addresses: ["10.1.2.3"] }), log: boom });
	g = b.attach();
	assert.deepEqual(await b.fire("onBeforeRequest", { url: "https://cdn.example.com/a.js", type: "script" }), { cancel: true });
	assert.deepEqual(await b.fire("onBeforeRequest", { url: "http://192.168.1.1/admin" }), { cancel: true });
	assert.deepEqual(b.verdicts.map((v) => v.code), ["private_address"], "and the job is told all the same");
	g.detach();
	for (let i = 0; i < 3; i++) assert.deepEqual(await b.tabless("onBeforeRequest", { url: "https://api.example.com/data" }), { cancel: true }, "the container outside a job");
	assert.deepEqual(await b.raw("onBeforeRequest", { tabId: 3, cookieStoreId: "firefox-default", type: "main_frame", url: "https://example.com/" }), {}, "the operator's own");
});

test("a listener that fails cancels what is the gateway's and lets the operator's own request pass", async () => {
	// The browser hands over a header line without a name: read like any other line, not a reason to fail.
	const odd = setup();
	let g = odd.attach();
	const nameless = [{ value: "Basic realm=x" }, { name: 7, value: "x" }, { name: "Content-Type", value: "text/html" }];
	assert.deepEqual(await odd.fire("onHeadersReceived", { url: "https://example.com/", statusCode: 401, ip: "93.184.216.34", responseHeaders: nameless }), {}, "a 401 page that asks for no login dialog");
	assert.deepEqual(classifyResponse(401, /** @type {any} */ (nameless)), { kind: "page", contentType: "text/html" });
	assert.equal(classifyResponse(401, /** @type {any} */ ([...nameless, { name: "WWW-Authenticate", value: "Basic" }])).kind, "refuse");
	assert.deepEqual(odd.verdicts, []);
	g.detach();

	// What the resolver hands back cannot be read: the promise of the listener fails, and that is a cancel.
	class Unreadable extends Array {
		/** @returns {boolean} */
		some() {
			throw new Error("not to be read");
		}
	}
	const dns = setup({ resolve: async () => ({ addresses: /** @type {any} */ (Unreadable.from(["93.184.216.34"])) }) });
	g = dns.attach();
	assert.deepEqual(await dns.fire("onBeforeRequest", { url: "https://cdn.example.com/a.js", type: "script" }), { cancel: true }, "a request of the page");
	assert.equal(g.open, false, "a tab the guard failed on loads nothing more");
	assert.deepEqual(dns.verdicts.map((v) => [v.outcome, v.code]), [["error", "internal_error"]], "and its job ends");
	assert.equal(dns.verdicts[0].message.includes("example"), false, "no address in the message");
	assert.deepEqual(await dns.fire("onBeforeRequest", { url: "https://example.com/" }), { cancel: true });
	g.detach();
	g = dns.attach();
	assert.deepEqual(await dns.fire("onBeforeRequest", { url: "https://www.example.org/" }), { cancel: true }, "a hop of the top frame");
	assert.deepEqual(await dns.tabless("onBeforeRequest", { url: "https://api.example.com/data" }), { cancel: true }, "a service worker's request");
	g.detach();
	assert.deepEqual(dns.sink.entries.filter((e) => e.event === "guard.listener_failed").map((e) => e.fields), [{ scope: "tab", ours: true, count: 1 }], "said in the log, counted, not listed");

	// A request that is not what the browser always sends: a job tab's is cancelled, in every event.
	const bad = setup();
	g = bad.attach();
	assert.deepEqual(await bad.fire("onBeforeRequest", { url: undefined }), { cancel: true });
	g.detach();
	g = bad.attach();
	assert.deepEqual(await bad.fire("onHeadersReceived", { url: undefined, statusCode: 200, responseHeaders: h({ "content-type": "text/html" }) }), { cancel: true });
	g.detach();
	g = bad.attach();
	assert.deepEqual(await bad.fire("onHeadersReceived", { url: "https://example.com/", statusCode: 200, responseHeaders: 5 }), { cancel: true });
	assert.deepEqual(bad.verdicts.map((v) => v.code), ["internal_error", "internal_error", "internal_error"]);
	g.detach();
	assert.deepEqual(await bad.tabless("onBeforeRequest", { url: undefined }), { cancel: true }, "in the container, outside a job");
	assert.deepEqual(await bad.tabless("onHeadersReceived", { url: undefined }), { cancel: true });
	// The operator's own request is not looked at that far, and passes.
	assert.deepEqual(await bad.tabless("onBeforeRequest", { url: undefined, cookieStoreId: "firefox-default" }), {});
	assert.deepEqual(await bad.tabless("onHeadersReceived", { url: undefined, cookieStoreId: "firefox-default" }), {});

	// The question whose request it is fails itself, once: asked again, and answered by whose it is.
	for (const wide of [false, true]) {
		const t = setup();
		if (wide) t.guard.widen("test");
		t.failStore(1);
		assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://api.example.com/data" }), { cancel: true }, "the container's");
		t.failStore(1);
		assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://api.example.com/data", cookieStoreId: "firefox-default" }), {}, "the operator's");
		t.failStore(1);
		assert.deepEqual(await t.tabless("onAuthRequired", { url: "https://api.example.com/data", cookieStoreId: "firefox-default", isProxy: false }), {}, "the operator's login dialog");
		t.failStore(1);
		assert.deepEqual(await t.tabless("onHeadersReceived", { url: "https://api.example.com/data", cookieStoreId: STORE, statusCode: 200 }), { cancel: true });
		// It cannot be told at all: a tab under guard is known without asking, and is cancelled; of the rest nothing is
		// known, and nothing of the operator's is ever cancelled on a guess.
		g = t.attach();
		t.failStore(1000);
		assert.deepEqual(await t.fire("onBeforeRequest", { url: undefined }), { cancel: true });
		assert.deepEqual(await t.tabless("onBeforeRequest", { url: "https://api.example.com/data", cookieStoreId: "firefox-default" }), {});
		t.failStore(0);
		g.detach();
	}
});

test("precheck: policy first, then the addresses", async () => {
	const { guard, resolved } = setup();
	assert.deepEqual(await guard.precheck("https://example.com/a"), { verdict: null });
	assert.deepEqual(resolved, ["example.com"]);
	const refused = await guard.precheck("http://10.0.0.1/");
	assert.equal(refused.verdict?.code, "private_address");
	assert.deepEqual(resolved, ["example.com"], "no lookup for a URL the policy refuses");
	assert.deepEqual(await guard.precheck("https://93.184.216.34/"), { verdict: null });

	const rebind = setup({ resolve: async () => ({ addresses: ["127.0.0.1"] }) });
	assert.equal((await rebind.guard.precheck("https://rebind.example.net/")).verdict?.code, "private_address");

	const fixture = setup({ policy: FIXTURE });
	assert.deepEqual(await fixture.guard.precheck("http://a.localhost:4711/plain"), { verdict: null });
	assert.deepEqual(fixture.resolved, []);
});

test("what a job tab loaded pages and frames from is remembered for the downloads backstop, a moment past its end", async () => {
	const t = setup();
	const began = Date.now();
	assert.deepEqual(t.guard.jobTraces(5000), { active: false, origins: new Map(), caughtAt: null, loginOrigins: new Map(), loginSince: null });
	const g = t.attach();
	const page = { statusCode: 200, ip: "93.184.216.34", responseHeaders: h({ "content-type": "text/html" }) };
	assert.deepEqual(t.guard.jobTraces(5000), { active: true, origins: new Map(), caughtAt: null, loginOrigins: new Map(), loginSince: null }, "open, nothing loaded yet");
	// The top frame through a redirect, and frames inside it.
	await t.fire("onHeadersReceived", { url: "https://example.com/start", statusCode: 302, ip: "93.184.216.34", responseHeaders: h({ location: "https://www.example.org/" }) });
	await t.fire("onHeadersReceived", { url: "https://www.example.org/landing?x=1", ...page });
	await t.fire("onHeadersReceived", { type: "sub_frame", url: "https://widgets.example.net:8443/embed", ...page });
	await t.fire("onHeadersReceived", { type: "sub_frame", url: "https://www.example.org/inner", ...page });
	// Not: a frame that was refused, a frame answered from a private address, things that are no pages.
	await t.fire("onHeadersReceived", { type: "sub_frame", url: "https://files.example.com/x.zip", statusCode: 200, ip: "93.184.216.34", responseHeaders: h({ "content-type": "application/zip" }) });
	await t.fire("onHeadersReceived", { type: "sub_frame", url: "https://intranet.example.com/", statusCode: 200, ip: "10.0.0.5", responseHeaders: h({ "content-type": "text/html" }) });
	await t.fire("onHeadersReceived", { type: "image", url: "https://cdn.example.com/a.png", statusCode: 200, ip: "93.184.216.34" });
	await t.fire("onHeadersReceived", { type: "script", url: "https://scripts.example.com/a.js", statusCode: 200, ip: "93.184.216.34" });
	assert.deepEqual([...t.guard.jobTraces(5000).origins.keys()].sort(), ["https://widgets.example.net:8443", "https://www.example.org"]);
	assert.deepEqual([...g.origins.keys()].sort(), ["https://widgets.example.net:8443", "https://www.example.org"]);
	// Each with the moment it was first loaded: a blob that began earlier cannot be this tab's.
	const loadedAt = /** @type {number} */ (g.origins.get("https://www.example.org"));
	assert.ok(loadedAt >= began && loadedAt <= Date.now());
	await new Promise((resolve) => setTimeout(resolve, 5));
	await t.fire("onHeadersReceived", { type: "sub_frame", url: "https://www.example.org/again", ...page });
	assert.equal(g.origins.get("https://www.example.org"), loadedAt, "the first time, not the last");
	assert.equal(t.guard.jobTraces(5000).origins.get("https://www.example.org"), loadedAt);
	// A sealed stray is no job: it adds nothing and does not make a job "about".
	t.guard.quarantine(77);
	assert.equal(t.guard.jobTraces(5000).origins.size, 2);

	// The first download of the job is remembered with it.
	assert.equal(t.guard.jobTraces(5000).caughtAt, null);
	const before = Date.now();
	t.guard.noteDownload();
	const caughtAt = t.guard.jobTraces(5000).caughtAt;
	assert.ok(caughtAt !== null && caughtAt >= before && caughtAt <= Date.now());
	await new Promise((resolve) => setTimeout(resolve, 5));
	t.guard.noteDownload();
	assert.equal(t.guard.jobTraces(5000).caughtAt, caughtAt, "the first one, not the last");

	// The tab is closed: its traces stay for the grace time that is asked for, and no longer.
	g.detach();
	assert.equal(t.guard.running, false);
	const after = t.guard.jobTraces(5000);
	assert.deepEqual({ active: after.active, origins: [...after.origins.keys()].sort(), caughtAt: after.caughtAt }, { active: true, origins: ["https://widgets.example.net:8443", "https://www.example.org"], caughtAt });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(t.guard.jobTraces(20), { active: false, origins: new Map(), caughtAt: null, loginOrigins: new Map(), loginSince: null });
	assert.deepEqual(t.guard.jobTraces(5000), { active: false, origins: new Map(), caughtAt: null, loginOrigins: new Map(), loginSince: null }, "once dropped, gone");
	// The next job starts with nothing of the last.
	const next = t.attach();
	assert.deepEqual(t.guard.jobTraces(5000), { active: true, origins: new Map(), caughtAt: null, loginOrigins: new Map(), loginSince: null });
	next.detach();
	// A job that loaded nothing leaves nothing behind.
	assert.equal(t.guard.jobTraces(5000).active, false);
});

// A service worker that an earlier job left in the container answers a top-level load itself.
// Measured in Firefox 156: onBeforeRequest for the tab, then no headers event and no end of the request - and the
// document is committed. The same when the worker hands on what it fetched itself.
test("every document a job tab commits must be a response whose headers passed here; one that no response stands behind ends the job", async () => {
	const PAGE = h({ "content-type": "text/html" });
	const UNGUARDED = { outcome: "error", code: "unguarded_response", message: "the page was answered without a response the request guard saw (by a service worker of the site, or from the browser's history)" };
	/** The network ended a request: every listener for that event whose filter takes the request is told. */
	const failed = (/** @type {ReturnType<typeof setup>} */ t, /** @type {Record<string, unknown>} */ details) => {
		const request = { tabId: TAB, cookieStoreId: STORE, type: "main_frame", error: "NS_ERROR_NET_RESET", ...details };
		let told = 0;
		for (const { fn, args } of [...t.wr.onErrorOccurred.listeners]) {
			const filter = /** @type {{ types?: string[], tabId?: number }} */ (args[0]);
			if (filter.tabId !== undefined && filter.tabId !== request.tabId) continue;
			if (filter.types !== undefined && !filter.types.includes(String(request.type))) continue;
			assert.equal(fn(request), undefined, "a listener that cannot block returns nothing");
			told += 1;
		}
		return told;
	};

	// An ordinary load: asked for, headers passed, committed.
	{
		const t = setup();
		const g = t.attach();
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/", requestId: "10" }), {});
		assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/", requestId: "10", statusCode: 200, responseHeaders: PAGE }), {});
		assert.equal(g.committed("https://example.com/"), true);
		assert.deepEqual(t.verdicts, []);
		assert.equal(g.open, true);
		// A redirect chain: what passed for a hop is not the response of the document; the last hop's headers are.
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/a", requestId: "11" }), {});
		assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/a", requestId: "11", statusCode: 302, responseHeaders: h({ location: "/b" }) }), {});
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/b", requestId: "11" }), {});
		assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/b", requestId: "11", statusCode: 200, responseHeaders: PAGE }), {});
		assert.equal(g.committed("https://example.com/b#top"), true);
		// A worker that does not answer: the browser asks twice for the same request, and the network's headers pass.
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/c", requestId: "12" }), {});
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/c", requestId: "12" }), {});
		assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/c", requestId: "12", statusCode: 404, responseHeaders: PAGE }), {});
		assert.equal(g.committed("https://example.com/c"), true);
		// What no server could have answered is none of this: the blank start page, the extension's own, a document the page made.
		for (const url of ["about:blank", `${BASE}park/park.html`, "blob:https://example.com/1", "data:text/html,x", "about:srcdoc"]) assert.equal(g.committed(url), true, url);
		assert.deepEqual(t.verdicts, []);
		// A passed response stands for one document. The next one committed without a request - brought back from
		// the browser's history - has none.
		assert.equal(g.committed("https://example.com/"), false);
		assert.deepEqual(t.verdicts, [UNGUARDED]);
		assert.equal(g.open, false, "sealed: nothing more leaves the tab");
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/next", requestId: "13" }), { cancel: true });
		assert.deepEqual(t.sink.entries.at(-1), { event: "guard.verdict", fields: { outcome: "error", code: "unguarded_response" } });
		assert.equal(t.sink.text().includes("example.com"), false, "no address in the log");
	}

	// The worker answers: a request is heard for the tab, and then nothing until the document is there.
	{
		const t = setup();
		const g = t.attach();
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/sw/page", requestId: "20" }), {});
		assert.equal(g.sawTopFrame, true, "the request itself was heard: this is not a deaf listener");
		assert.equal(g.committed("https://example.com/sw/page"), false);
		assert.deepEqual(t.verdicts, [UNGUARDED]);
		assert.equal(g.committed("https://example.com/sw/page"), false);
		assert.equal(t.verdicts.length, 1, "said once");
	}

	// A load the network ended: the browser commits its own error page under the address that failed. No worker's doing.
	{
		const t = setup();
		const g = t.attach();
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/reset", requestId: "30" }), {});
		assert.equal(failed(t, { url: "https://example.com/reset", requestId: "30" }), 1, "one listener, the tab's own");
		assert.equal(g.committed("https://example.com/reset"), true);
		assert.deepEqual(t.verdicts, []);
		// But the end of an older request says nothing about the one that came after it: a page that starts a slow
		// load and then goes where the worker answers does not get its worker's document in on the first one's failure.
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/slow", requestId: "31" }), {});
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/sw/page", requestId: "32" }), {});
		failed(t, { url: "https://example.com/slow", requestId: "31", error: "NS_BINDING_ABORTED" });
		assert.equal(g.committed("https://example.com/sw/page"), false);
		assert.deepEqual(t.verdicts, [UNGUARDED]);
	}

	// The end of a request is not always told before the commit (measured: one failed load in four was told after
	// it). The navigation error the job runner passes on always is: it stands for the load that was last asked for.
	{
		const t = setup();
		const g = t.attach();
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/reset?x=1", requestId: "35" }), {});
		// A frame of the old page was given up, and so was the load before this one: that is no failure of this load.
		g.navigationFailed("https://example.com/reset?x=1", "Error code 2152398850");
		g.navigationFailed("https://example.com/reset?x=1", "NS_BINDING_ABORTED");
		g.navigationFailed("https://example.com/reset?x=1#top", "Error code 2152398868");
		assert.equal(g.committed("https://example.com/reset?x=1"), true, "the browser's error page");
		failed(t, { url: "https://example.com/reset?x=1", requestId: "35" });
		assert.deepEqual(t.verdicts, []);
		// The late word about the old request does not stand for the next document.
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/sw/page", requestId: "36" }), {});
		assert.equal(g.committed("https://example.com/sw/page"), false);
		assert.deepEqual(t.verdicts, [UNGUARDED]);

		// A navigation that was given up for another one has no error page: the document that follows is the other one's.
		const a = setup();
		const aborted = a.attach();
		assert.deepEqual(await a.fire("onBeforeRequest", { url: "https://example.com/sw/page", requestId: "37" }), {});
		aborted.navigationFailed("https://example.com/sw/page", "Error code 2152398850");
		assert.equal(aborted.committed("https://example.com/sw/page"), false);
		// Nor does the failure of another address stand for the one that was asked for last.
		const o = setup();
		const other = o.attach();
		assert.deepEqual(await o.fire("onBeforeRequest", { url: "https://example.com/slow", requestId: "38" }), {});
		assert.deepEqual(await o.fire("onBeforeRequest", { url: "https://example.com/sw/page", requestId: "39" }), {});
		other.navigationFailed("https://example.com/slow", "Error code 2152398868");
		assert.equal(other.committed("https://example.com/sw/page"), false);
		assert.deepEqual(o.verdicts, [UNGUARDED]);
		// A load that failed before any request was made (the browser is offline) has its error page too.
		const n = setup();
		const none = n.attach();
		none.navigationFailed("https://example.com/offline", "Error code 2152398865");
		assert.equal(none.committed("https://example.com/offline"), true);
		assert.equal(none.committed("https://example.com/offline"), false, "one failure, one error page");
		// Headers that passed are not taken back by an error that follows them.
		const p = setup();
		const passed = p.attach();
		assert.deepEqual(await p.fire("onBeforeRequest", { url: "https://example.com/", requestId: "3a" }), {});
		assert.deepEqual(await p.fire("onHeadersReceived", { url: "https://example.com/", requestId: "3a", statusCode: 200, responseHeaders: PAGE }), {});
		passed.navigationFailed("https://example.com/", "Error code 2152398868");
		assert.equal(passed.committed("https://example.com/"), true);
	}

	// Neither do headers of something else: a frame's, an older request's, or headers that were refused.
	{
		const t = setup();
		const g = t.attach();
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/old", requestId: "40" }), {});
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/sw/page", requestId: "41" }), {});
		assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/old", requestId: "40", statusCode: 200, responseHeaders: PAGE }), {});
		assert.deepEqual(await t.fire("onBeforeRequest", { url: "https://example.com/frame", type: "sub_frame", requestId: "42" }), {});
		assert.deepEqual(await t.fire("onHeadersReceived", { url: "https://example.com/frame", type: "sub_frame", requestId: "42", statusCode: 200, responseHeaders: PAGE }), {});
		failed(t, { url: "https://example.com/pixel", type: "image", requestId: "43" });
		assert.equal(g.committed("https://example.com/sw/page"), false);
		assert.deepEqual(t.verdicts, [UNGUARDED]);
		const r = setup();
		const refused = r.attach();
		assert.deepEqual(await r.fire("onBeforeRequest", { url: "https://example.com/file", requestId: "50" }), {});
		assert.deepEqual(await r.fire("onHeadersReceived", { url: "https://example.com/file", requestId: "50", statusCode: 200, responseHeaders: h({ "content-type": "application/zip" }) }), { cancel: true });
		assert.equal(refused.committed("https://example.com/file"), false);
		assert.deepEqual(r.verdicts.map((v) => v.code), ["content_type"], "the first verdict stands");
	}

	// The listener for failed loads: one per guarded tab, for top frames only, never blocking; none for requests without a tab.
	{
		const t = setup();
		assert.equal(t.wr.onErrorOccurred.listeners.length, 0);
		const g = t.attach();
		assert.deepEqual(t.wr.onErrorOccurred.listeners.map((l) => l.args), [[{ urls: ["<all_urls>"], types: ["main_frame"], tabId: TAB }]]);
		assert.equal(failed(t, { tabId: TAB + 7, url: "https://example.com/", requestId: "60" }), 0, "another tab's failures reach nobody");
		g.detach();
		assert.equal(t.wr.onErrorOccurred.listeners.length, 0);
		// A tab that is no job's shows nothing and is asked nothing.
		const stray = t.guard.quarantine(TAB + 1);
		assert.equal(stray.committed("https://example.com/"), true);
		// Listening to everything: one listener, which finds the tab by its id.
		const wide = setup();
		const w = wide.attach();
		wide.guard.widen("test");
		assert.deepEqual(wide.wr.onErrorOccurred.listeners.map((l) => l.args), [[{ urls: ["<all_urls>"], types: ["main_frame"] }]]);
		assert.deepEqual(await wide.fire("onBeforeRequest", { url: "https://example.com/reset", requestId: "70" }), {});
		failed(wide, { url: "https://example.com/reset", requestId: "70" });
		assert.equal(w.committed("https://example.com/reset"), true);
		assert.equal(w.committed("https://example.com/reset"), false);
	}
});
