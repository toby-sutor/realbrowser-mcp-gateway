// The header gate in one place: what the request guard decides for the top-level response of a job tab, for
// every combination of status, Content-Type, Content-Disposition, "may this job bring a file back" and cookie
// scope it handles. The decision is one of
//
//   page       the response is let through as it is; the tab shows it and the job reads it
//   capture    let through as it is, with a filter on it that keeps every byte from the tab
//   relabel    let through with a filter AND other response headers (the browser would save it otherwise)
//   pass       no decision yet: a redirect hop, a proxy asking for credentials, a 304 whose stored response follows
//   <code>     cancelled at the headers, the job ends with that code
//
// The expectations below are written out as rules of their own (expected()), not taken from the code under test.
// Each Content-Type and Content-Disposition variant says what the browser does with it, as measured in headless
// Firefox 156 (tests/integration/headers.test.js asks the browser on every run).

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEvent, logSink } from "../helpers/ext-fakes.js";
import { filterFactory } from "../helpers/fake-filter.js";
import { Guard } from "../../extension/background/guard.js";
import { DEFAULT_BLOCKLIST } from "../../extension/shared/policy.js";
import { DEFAULT_ALLOW_TYPES } from "../../extension/shared/sniff.js";

const BASE = "moz-extension://0f8c2a3e-5b1d-4c7a-9e6f-112233445566/";
const STORE = "firefox-container-7";
const TAB = 31;
const FILES = Object.freeze({ maxBytes: 1048576, types: DEFAULT_ALLOW_TYPES });
const UNTYPED = "application/octet-stream";

/**
 * @typedef {{ name: string, value: string }} Line
 *
 * @typedef {object} TypeVariant a Content-Type as a server may send it
 * @property {string} label
 * @property {Line[]} lines the Content-Type lines, and X-Content-Type-Options where the case is about it
 * @property {"html" | "plain_shown" | "plain_guessed" | "shown" | "saved" | "none"} kind what it is to the gate: a page
 *   type; plain text the browser shows without looking; plain text it decides on by its bytes; a file type it shows
 *   itself; a type it saves; or no type that is certain
 * @property {string | null} type the media type the gate reads: null for "none"
 * @property {"content_type" | "content_type_json" | "content_type_xml"} [code] the gate's word for a shown or saved type
 *   where no file can be had
 * @property {boolean} [listed] false: a type the operator's list does not name
 *
 * @typedef {object} DispositionVariant
 * @property {string[]} values the Content-Disposition lines
 * @property {boolean} attachment the browser saves a response that carries them
 */

/** @param {string} value @returns {Line[]} */
const ct = (value) => [{ name: "Content-Type", value }];

/** @type {TypeVariant[]} */
const TYPES = [
	// Pages. Firefox: HTML, script runs.
	{ label: "text/html", lines: ct("text/html"), kind: "html", type: "text/html" },
	{ label: "text/html with a charset", lines: ct("text/html; charset=utf-8"), kind: "html", type: "text/html" },
	{ label: "TEXT/HTML", lines: ct("TEXT/HTML"), kind: "html", type: "text/html" },
	{ label: "text/html, text/html", lines: ct("text/html, text/html"), kind: "html", type: "text/html" },
	{ label: "text/html in two headers", lines: [...ct("text/html"), ...ct("text/html; charset=utf-8")], kind: "html", type: "text/html" },
	{ label: "application/xhtml+xml", lines: ct("application/xhtml+xml"), kind: "html", type: "application/xhtml+xml" },
	// Plain text.
	{ label: "text/plain with nosniff", lines: [...ct("text/plain; charset=utf-8"), { name: "X-Content-Type-Options", value: "nosniff" }], kind: "plain_shown", type: "text/plain" },
	{ label: "text/plain with nosniff and an encoding", lines: [...ct("text/plain"), { name: "X-Content-Type-Options", value: "NoSniff" }, { name: "Content-Encoding", value: "gzip" }], kind: "plain_shown", type: "text/plain" },
	// An encoding alone does not keep the browser from looking at the bytes (measured: gzip, br, identity).
	{ label: "text/plain with an encoding", lines: [...ct("text/plain"), { name: "Content-Encoding", value: "gzip" }], kind: "plain_guessed", type: "text/plain" },
	{ label: "text/plain with the encoding identity", lines: [...ct("text/plain; charset=utf-8"), { name: "Content-Encoding", value: "identity" }], kind: "plain_guessed", type: "text/plain" },
	{ label: "text/plain", lines: ct("text/plain"), kind: "plain_guessed", type: "text/plain" },
	{ label: "text/plain with a nosniff that is not the word alone", lines: [...ct("text/plain"), { name: "X-Content-Type-Options", value: "nosniff, x" }], kind: "plain_guessed", type: "text/plain" },
	// File types the browser shows by itself.
	{ label: "application/pdf", lines: ct("application/pdf"), kind: "shown", type: "application/pdf", code: "content_type" },
	{ label: "application/json", lines: ct("application/json; charset=utf-8"), kind: "shown", type: "application/json", code: "content_type_json" },
	{ label: "application/ld+json", lines: ct("application/ld+json"), kind: "shown", type: "application/ld+json", code: "content_type_json" },
	{ label: "application/xml", lines: ct("application/xml"), kind: "shown", type: "application/xml", code: "content_type_xml" },
	{ label: "image/svg+xml", lines: ct("image/svg+xml"), kind: "shown", type: "image/svg+xml", code: "content_type_xml" },
	{ label: "image/png", lines: ct("image/png"), kind: "shown", type: "image/png", code: "content_type" },
	{ label: "text/markdown", lines: ct("text/markdown"), kind: "shown", type: "text/markdown", code: "content_type" },
	// Types the browser saves.
	{ label: "application/zip", lines: ct("application/zip"), kind: "saved", type: "application/zip", code: "content_type" },
	{ label: "application/octet-stream", lines: ct("application/octet-stream"), kind: "saved", type: "application/octet-stream", code: "content_type" },
	{ label: "text/csv", lines: ct("text/csv; charset=utf-8"), kind: "saved", type: "text/csv", code: "content_type" },
	{ label: "application/rss+xml", lines: ct("application/rss+xml"), kind: "saved", type: "application/rss+xml", code: "content_type_xml" },
	{ label: "video/mp4", lines: ct("video/mp4"), kind: "saved", type: "video/mp4", code: "content_type", listed: false },
	{ label: "application/x-msdownload", lines: ct("application/x-msdownload"), kind: "saved", type: "application/x-msdownload", code: "content_type", listed: false },
	// No type that is certain. What Firefox makes of each (with an HTML body) stands behind it.
	{ label: "no Content-Type", lines: [], kind: "none", type: null }, // guessed from the bytes
	{ label: "an empty Content-Type", lines: ct(""), kind: "none", type: null }, // guessed
	{ label: "garbage", lines: ct("garbage"), kind: "none", type: null }, // guessed
	{ label: "text/html;,application/pdf", lines: ct("text/html;,application/pdf"), kind: "none", type: null }, // the PDF viewer
	{ label: "text/html;,application/zip", lines: ct("text/html;,application/zip"), kind: "none", type: null }, // saved
	{ label: "text/html, application/pdf", lines: ct("text/html, application/pdf"), kind: "none", type: null }, // the PDF viewer
	{ label: "application/pdf, text/html", lines: ct("application/pdf, text/html"), kind: "none", type: null }, // HTML, script runs
	{ label: "application/zip, text/html", lines: ct("application/zip, text/html"), kind: "none", type: null }, // HTML, script runs
	{ label: "text/html, application/json", lines: ct("text/html, application/json"), kind: "none", type: null }, // the JSON viewer
	{ label: "application/json, application/zip", lines: ct("application/json, application/zip"), kind: "none", type: null }, // saved
	{ label: "text/html + application/pdf in two headers", lines: [...ct("text/html"), ...ct("application/pdf")], kind: "none", type: null }, // the PDF viewer
	{ label: "application/zip + text/html in two headers", lines: [...ct("application/zip"), ...ct("text/html")], kind: "none", type: null }, // HTML
	{ label: "text/html + an empty one in two headers", lines: [...ct("text/html"), ...ct("")], kind: "none", type: null }, // HTML
	{ label: "text/html, */*", lines: ct("text/html, */*"), kind: "none", type: null }, // HTML
	{ label: "text/html,", lines: ct("text/html,"), kind: "none", type: null }, // HTML
	{ label: "a comma inside quotes", lines: ct('text/html; charset="a,application/pdf"'), kind: "none", type: null }, // HTML
	{ label: "a comma after an open quote", lines: ct('application/zip; x=",text/html'), kind: "none", type: null }, // saved
	{ label: "a comma inside single quotes", lines: ct("text/html; charset='a,application/zip'"), kind: "none", type: null }, // saved
	{ label: "text/html application/pdf", lines: ct("text/html application/pdf"), kind: "none", type: null }, // HTML
	{ label: "text/html and a vertical tab", lines: ct("text/html\u000b"), kind: "none", type: null }, // a text document
	{ label: "application/pdf and a vertical tab", lines: ct("application/pdf\u000b"), kind: "none", type: null }, // saved
	{ label: "a quoted type", lines: ct('"text/html"'), kind: "none", type: null }, // saved
	{ label: "*/*", lines: ct("*/*"), kind: "none", type: null }, // guessed
	{ label: "text/ html", lines: ct("text/ html"), kind: "none", type: null }, // a text document
];

/** @type {DispositionVariant[]} */
const DISPOSITIONS = [
	// Firefox shows the response.
	{ values: [], attachment: false },
	{ values: [""], attachment: false },
	{ values: [";"], attachment: false },
	{ values: ["inline"], attachment: false },
	{ values: ['INLINE; filename="a.bin"'], attachment: false },
	{ values: ["inline foo"], attachment: false },
	{ values: ['filename="attachment.bin"'], attachment: false },
	{ values: ["inline", "inline"], attachment: false },
	// Firefox saves it.
	{ values: ["attachment"], attachment: true },
	{ values: ['Attachment; filename="a.bin"'], attachment: true },
	{ values: ['download; filename="x.pdf"'], attachment: true },
	{ values: ["x"], attachment: true },
	{ values: ['foo; filename="a"'], attachment: true },
	{ values: ['"inline"'], attachment: true },
	{ values: ["inlinex"], attachment: true },
	{ values: ["inline, attachment"], attachment: true },
	{ values: [",inline"], attachment: true },
	// Two lines that differ: the load fails in Firefox before any header is told; should they be told, the gate saves nothing.
	{ values: ["inline", "attachment"], attachment: true },
	{ values: ["x", "inline"], attachment: true },
	{ values: ["inline", 'inline; filename="a"'], attachment: true },
];

/** The statuses that carry a body. */
const BODY_STATUSES = [200, 201, 206, 403, 404, 429, 500];

/**
 * The rules.
 * @param {{ status: number, type: TypeVariant, disposition: DispositionVariant, files: boolean, login: boolean }} c
 * @returns {{ decision: string, read?: string }} read: the declared type a captured file is judged by
 */
function expected(c) {
	const { status, type, disposition, files, login } = c;
	const saved = disposition.attachment;
	// A page type is a page or nothing: offered as a download it is refused, and never read as a file.
	if (type.kind === "html") return { decision: saved ? "attachment" : "page" };
	// Everything else is a file, if anything. How the browser would treat it decides how it is read.
	const relabel = saved || type.kind === "saved" || type.kind === "none" || type.kind === "plain_guessed";
	// Plain text the browser shows without looking was a page before files existed, and is one wherever no file is to be had.
	const page = type.kind === "plain_shown" && !saved;
	const base = saved ? "attachment" : type.kind === "none" ? "content_type_missing" : type.kind === "plain_guessed" ? "plain_text_sniffable" : (type.code ?? "content_type");
	const declared = type.type ?? UNTYPED;
	if (!files) return { decision: page ? "page" : base };
	if (login) return { decision: page ? "page" : "file_login_scope" };
	if (type.listed === false) return { decision: page ? "page" : "file_type_not_allowed" };
	if (status !== 200) return { decision: page ? "page" : status === 403 ? "http_403" : status === 429 ? "http_429" : "file_http_error" };
	return { decision: relabel ? "relabel" : "capture", read: declared };
}

/**
 * One response at the gate, on a fresh guard.
 * @param {{ status: number, headers: Line[], files: boolean, login: boolean, pdfViewer?: boolean }} c
 * @returns {Promise<{ decision: string, read: string | null, navType: string | null, headers: Line[] | null, filters: number }>}
 */
async function gate(c) {
	const factory = filterFactory();
	const wr = { onBeforeRequest: new FakeEvent(), onHeadersReceived: new FakeEvent(), onAuthRequired: new FakeEvent(), onResponseStarted: new FakeEvent(), onErrorOccurred: new FakeEvent(), filterResponseData: factory.filterResponseData };
	const guard = new Guard({
		webRequest: /** @type {any} */ (wr),
		tabs: /** @type {any} */ ({ onCreated: new FakeEvent(), onRemoved: new FakeEvent(), query: async () => [] }),
		resolve: async () => ({ addresses: ["93.184.216.34"] }),
		policy: { blocklist: DEFAULT_BLOCKLIST, allowLoopbackPorts: [] },
		extensionBase: BASE,
		storeId: () => STORE,
		pdfViewer: () => c.pdfViewer !== false,
		log: logSink().log,
		dnsTimeoutMs: 200,
	});
	guard.start();
	/** @type {import("../../extension/background/guard.js").Verdict[]} */
	const verdicts = [];
	/** @type {import("../../extension/background/capture.js").Capture[]} */
	const captured = [];
	const store = c.login ? "firefox-default" : STORE;
	const rule = { host: "example.com", pathPrefix: "/", subdomains: false };
	const tab = guard.attach(TAB, {
		cookieStoreId: store,
		onVerdict: (v) => verdicts.push(v),
		files: c.files ? FILES : null,
		onFile: (f) => captured.push(f),
		...(c.login ? { scope: { rule, policy: {}, url: "https://example.com/f" } } : {}),
	});
	/** @param {"onBeforeRequest" | "onHeadersReceived"} event @param {Record<string, unknown>} details */
	const fire = async (event, details) => {
		/** @type {Record<string, unknown>[]} */
		const answers = [];
		for (const { fn, args } of [...wr[event].listeners]) {
			const filter = /** @type {{ types?: string[], tabId?: number, windowId?: number }} */ (args[0]);
			if (filter.tabId !== undefined && filter.tabId !== TAB) continue;
			if (filter.windowId !== undefined) continue;
			if (filter.types !== undefined && !filter.types.includes("main_frame")) continue;
			answers.push(/** @type {Record<string, unknown>} */ (await fn({ tabId: TAB, cookieStoreId: store, type: "main_frame", requestId: "1", ip: "93.184.216.34", url: "https://example.com/f", ...details })));
		}
		return answers;
	};
	await fire("onBeforeRequest", {});
	const answers = await fire("onHeadersReceived", { statusCode: c.status, responseHeaders: c.headers });
	const cancelled = answers.some((a) => a.cancel === true);
	const relabelled = answers.filter((a) => "responseHeaders" in a);
	for (const a of answers) assert.ok(Object.keys(a).length <= 1 && Object.keys(a).every((k) => k === "cancel" || k === "responseHeaders"), JSON.stringify(a));
	assert.ok(relabelled.length <= 1 && !(cancelled && relabelled.length > 0), "one answer with headers at most, and never next to a cancel");
	/** @type {string} */
	let decision;
	if (cancelled) {
		assert.equal(verdicts.length, 1, "a cancelled top-level response ends the job with one verdict");
		assert.equal(factory.made.length, 0, "no filter on a response that is refused");
		decision = verdicts[0].code;
	} else {
		assert.deepEqual(verdicts, [], "no verdict on a response that is let through");
		if (factory.made.length === 1) {
			assert.equal(tab.capture, captured[0]);
			decision = relabelled.length === 1 ? "relabel" : "capture";
		} else {
			assert.equal(relabelled.length, 0, "never other headers without a filter");
			// A page is the response the tab may commit; a hop or a 304 is not there yet.
			decision = tab.committed("https://example.com/f") ? "page" : "pass";
		}
	}
	const result = { decision, read: captured[0]?.plan.contentType ?? null, navType: tab.nav.contentType, headers: relabelled.length === 1 ? /** @type {Line[]} */ (relabelled[0].responseHeaders) : null, filters: factory.made.length };
	tab.detach();
	guard.stop();
	return result;
}

/** @param {DispositionVariant} d @returns {Line[]} */
const cd = (d) => d.values.map((value) => ({ name: "Content-Disposition", value }));

test("the header gate, row by row: status x Content-Type x Content-Disposition x files x scope", async () => {
	/** @type {Record<string, number>} */
	const seen = {};
	let rows = 0;
	for (const status of BODY_STATUSES) {
		for (const type of TYPES) {
			for (const disposition of DISPOSITIONS) {
				for (const files of [true, false]) {
					for (const login of [false, true]) {
						const want = expected({ status, type, disposition, files, login });
						const got = await gate({ status, headers: [...type.lines, ...cd(disposition)], files, login });
						const label = `${status} | ${type.label} | Content-Disposition ${JSON.stringify(disposition.values)} | files ${files ? "on" : "off"} | ${login ? "login" : "container"}`;
						assert.equal(got.decision, want.decision, label);
						assert.equal(got.navType, type.type, `${label}: the type on record`);
						if (want.read !== undefined) assert.equal(got.read, want.read, `${label}: the type the file is judged by`);
						if (want.decision === "relabel") {
							// The headers the browser goes on with: one type, no disposition, nothing to keep the response by.
							const names = (got.headers ?? []).map((h) => h.name.toLowerCase());
							assert.deepEqual(got.headers?.filter((h) => /^(content-type|content-disposition|x-content-type-options|cache-control)$/i.test(h.name)), [{ name: "Content-Type", value: "text/json" }, { name: "X-Content-Type-Options", value: "nosniff" }, { name: "Cache-Control", value: "no-store" }], label);
							assert.equal(new Set(names).size, names.length, `${label}: no header twice`);
						}
						seen[want.decision] = (seen[want.decision] ?? 0) + 1;
						rows += 1;
					}
				}
			}
		}
	}
	assert.equal(rows, BODY_STATUSES.length * TYPES.length * DISPOSITIONS.length * 4);
	// Every class of decision came up, so the table is about all of them.
	assert.deepEqual(Object.keys(seen).sort(), ["attachment", "capture", "content_type", "content_type_json", "content_type_missing", "content_type_xml", "file_http_error", "file_login_scope", "file_type_not_allowed", "http_403", "http_429", "page", "plain_text_sniffable", "relabel"]);
	for (const decision of Object.keys(seen)) assert.ok(seen[decision] > 0);
});

test("the header gate: what is never a page", async () => {
	// The property the two findings were about, over the whole table: a response the browser would save, or would
	// take for another type than its Content-Type begins with, is let through as it is in no combination.
	for (const type of TYPES) {
		for (const disposition of DISPOSITIONS) {
			for (const files of [true, false]) {
				for (const login of [false, true]) {
					const got = await gate({ status: 200, headers: [...type.lines, ...cd(disposition)], files, login });
					const label = `${type.label} | ${JSON.stringify(disposition.values)} | files ${files} | login ${login}`;
					const browserSaves = disposition.attachment || type.kind === "saved" || type.kind === "none" || type.kind === "plain_guessed";
					if (browserSaves) assert.ok(got.decision !== "page" && got.decision !== "capture" && got.decision !== "pass", `${label}: ${got.decision}`);
					if (type.kind !== "html" && type.kind !== "plain_shown") assert.notEqual(got.decision, "page", label);
					if (login) assert.equal(got.filters, 0, `${label}: nothing is read with the operator's login`);
					if (!files) assert.equal(got.filters, 0, `${label}: nothing is read for a job that brings no file back`);
				}
			}
		}
	}
});

test("the header gate: answers without a body, redirects and credentials - the same whatever the headers claim", async () => {
	for (const type of TYPES) {
		for (const disposition of DISPOSITIONS) {
			for (const files of [true, false]) {
				for (const login of [false, true]) {
					const lines = [...type.lines, ...cd(disposition)];
					const label = `${type.label} | ${JSON.stringify(disposition.values)} | files ${files} | login ${login}`;
					const at = async (/** @type {number} */ status, /** @type {Line[]} */ more = []) => (await gate({ status, headers: [...lines, ...more], files, login })).decision;
					for (const status of [204, 205]) assert.equal(await at(status), "no_content", `${status} | ${label}`);
					// A 304: what the browser has stored comes next and is judged then - unless the 304 itself names a
					// Content-Disposition (any: measured, the browser opened a tab for such an answer when it came unasked).
					assert.equal(await at(304), disposition.values.length > 0 ? "no_content" : "pass", `304 | ${label}`);
					// A redirect hop is no response to judge; without a Location it is a response like any other.
					for (const status of [301, 302, 303, 307, 308]) assert.equal(await at(status, [{ name: "Location", value: "https://example.com/next" }]), "pass", `${status} | ${label}`);
					assert.equal(await at(407, [{ name: "Proxy-Authenticate", value: "Basic" }]), "pass", `407 | ${label}`);
					assert.equal(await at(401, [{ name: "WWW-Authenticate", value: 'Basic realm="x"' }]), "auth_required", `401 | ${label}`);
				}
			}
		}
	}
	// A redirect status without a Location, and a 401 that asks for nothing the browser has a dialog for: judged like a 404.
	for (const type of TYPES) {
		for (const disposition of DISPOSITIONS) {
			for (const status of [302, 401]) {
				const more = status === 401 ? [{ name: "WWW-Authenticate", value: "Bearer" }] : [];
				const got = await gate({ status, headers: [...type.lines, ...cd(disposition), ...more], files: true, login: false });
				assert.equal(got.decision, expected({ status, type, disposition, files: true, login: false }).decision, `${status} | ${type.label} | ${JSON.stringify(disposition.values)}`);
			}
		}
	}
});

test("the header gate: a PDF where the browser shows none itself is a download-type file", async () => {
	for (const disposition of DISPOSITIONS) {
		const got = await gate({ status: 200, headers: [...ct("application/pdf"), ...cd(disposition)], files: true, login: false, pdfViewer: false });
		assert.deepEqual([got.decision, got.read], ["relabel", "application/pdf"], JSON.stringify(disposition.values));
		assert.equal((await gate({ status: 200, headers: [...ct("application/pdf"), ...cd(disposition)], files: false, login: false, pdfViewer: false })).decision, disposition.attachment ? "attachment" : "content_type");
	}
});
