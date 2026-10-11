// End-to-end tests: the real daemon, the real extension in headless Firefox,
// local fixture pages. Everything goes through the daemon's HTTP API, as an
// agent would; the extension's test hook is only used to look at browser
// state and to play the operator.
//
// Run with: npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { BLOCKLISTED_HOST, LOOPBACK_NAME, startHarness, waitFor } from "./harness.js";
import { LIMITS, PROTOCOL_VERSION } from "../../extension/shared/protocol.js";
import { renderFailure } from "../../daemon/src/render.js";
import { b64urlDecode, b64urlEncode, computeMacS, randomNonce } from "../../extension/shared/auth.js";

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;
let seq = 0;

before(async () => {
	h = await startHarness();
});

after(async () => {
	if (h !== undefined) await h.stop();
});

/**
 * A fixture URL that no earlier job used, so nothing is deduplicated or cached.
 * @param {string} host
 * @param {string} path
 */
function fx(host, path) {
	seq += 1;
	return h.fixtures.url(host, `${path}${path.includes("?") ? "&" : "?"}n=${seq}`);
}

/**
 * Submit a job through the daemon's HTTP API and return its result.
 * @param {string} url
 * @param {{ wait?: Record<string, unknown>, extract?: Record<string, unknown>, kind?: string }} [opts]
 * @returns {Promise<any>}
 */
async function job(url, opts = {}) {
	const res = await h.submitJob({
		kind: opts.kind ?? "fetch",
		url,
		wait: { timeout_ms: 15000, settle_ms: 200, dwell_ms: 0, ...opts.wait },
		extract: { html: true, ...opts.extract },
	});
	assert.equal(res.status, 200, res.text.slice(0, 300));
	return res.json.result;
}

/** @returns {Promise<{ own: { windowId: number | null, parkTabId: number | null, jobTabs: number[] }, containerId: string | null, windows: any[] }>} */
const windows = () => h.hook("windows");

/**
 * The gateway window as it should look with no job running: exactly one
 * gateway window, holding the park tab and nothing else.
 */
async function assertIdleWindow() {
	const snap = await windows();
	const gateways = snap.windows.filter((w) => w.role === "gateway");
	assert.equal(gateways.length, 1, "exactly one gateway window");
	const gw = gateways[0];
	assert.equal(gw.type, "normal");
	assert.equal(gw.id, snap.own.windowId);
	assert.deepEqual(snap.own.jobTabs, [], "no job tab is tracked");
	assert.equal(gw.tabs.length, 1, `only the park tab is left, found: ${gw.tabs.map((/** @type {any} */ t) => t.url).join(", ")}`);
	assert.match(gw.tabs[0].url, /^moz-extension:\/\/[0-9a-f-]+\/park\/park\.html$/);
	assert.equal(gw.tabs[0].id, snap.own.parkTabId);
	return snap;
}

test("handshake in auth mode with the pre-shared key", async () => {
	const status = await h.status();
	assert.equal(status.paired, true);
	assert.equal(status.extension.connected, true);
	assert.equal(status.extension.ext_version, "0.1.9");
	assert.equal(status.extension.browser.name, "Firefox");
	const state = status.extension.state;
	assert.equal(state.paused, false);
	assert.equal(state.pause_reason, null);
	assert.equal(state.slots, 1);
	assert.equal(state.container.ready, true);
	assert.equal(state.policy_rev, 1);
	assert.deepEqual(state.optin_hosts, []);
	const connected = h.daemon.logs.map((l) => JSON.parse(l)).filter((l) => l.event === "ext.connected");
	assert.equal(connected.length, 1);
	assert.equal(connected[0].mode, "auth");
	const st = await h.hook("status");
	assert.equal(st.dev, true);
	assert.equal(st.link.phase, "ready");
});

test("fetch of the plain page: ok with title and html, from the container", async () => {
	const url = fx("a", "/plain");
	const r = await job(url);
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.error, null);
	assert.equal(r.cookie_scope, "container");
	assert.equal(r.nav.requested_url, url);
	assert.equal(r.nav.final_url, url);
	assert.equal(r.nav.http_status, 200);
	assert.equal(r.nav.content_type, "text/html");
	assert.deepEqual(r.nav.redirect_origins, []);
	assert.equal(r.page.title, "Fixture plain page");
	assert.equal(r.page.lang, "en");
	assert.equal(r.page.site, "a.localhost", "no site name declared: the host name");
	assert.equal(r.page.author, null);
	assert.ok(r.page.word_count > 2);
	assert.match(r.page.extractor, /^(defuddle@0\.19\.4|innertext)$/);
	assert.match(r.content.markdown, /bgw-fixture-plain-marker/);
	assert.match(r.content.html, /bgw-fixture-plain-marker/);
	assert.equal(/<script/i.test(r.content.html), false, "the document comes back without its scripts");
	assert.deepEqual(r.content.links, []);
	assert.deepEqual(r.content.results, []);
	assert.deepEqual(r.truncated, { markdown: false, text: false, html: false, raw_html: false });
	assert.ok(["article", "text"].includes(r.extraction.view), JSON.stringify(r.extraction));
	assert.equal(r.tab_kept_open, false);
	assert.equal(r.render.settled, true);
	assert.ok(["visible", "hidden"].includes(r.render.visibility));
	assert.ok(r.render.raf_hz >= 0);
	await assertIdleWindow();
});

/** @param {string} event */
const daemonLog = (event) => h.daemon.logs.map((l) => JSON.parse(l)).filter((l) => l.event === event);

/**
 * Wait until a job tab shows up in the gateway window.
 * @returns {Promise<{ snap: Awaited<ReturnType<typeof windows>>, gw: any, tab: any }>}
 */
async function jobTabOpen() {
	/** @type {any} */
	let found = null;
	await waitFor(
		async () => {
			const snap = await windows();
			const gw = snap.windows.find((w) => w.gateway);
			const tab = gw?.tabs.find((/** @type {any} */ t) => t.role === "job");
			if (tab === undefined) return false;
			found = { snap, gw, tab };
			return true;
		},
		{ timeoutMs: 10000, intervalMs: 50, what: "a job tab to open" },
	);
	return found;
}

/** Windows and tabs that are not the gateway's: the operator's. */
async function foreignWindows() {
	const snap = await windows();
	return snap.windows
		.filter((w) => w.role !== "gateway")
		.map((w) => ({ id: w.id, type: w.type, tabs: w.tabs.map((/** @type {any} */ t) => ({ id: t.id, url: t.url, cookieStoreId: t.cookieStoreId })) }));
}

/** @type {Awaited<ReturnType<typeof foreignWindows>>} */
let operatorBefore = [];

test("setup: the operator has windows and tabs of their own", async () => {
	const opened = await h.hook("window.open", { url: fx("a", "/hit?operator=window") });
	// A page the guard would refuse in a job tab. In the operator's tab it must load untouched.
	await h.hook("tab.open", { windowId: opened.id, url: fx("a", "/json?operator=tab") });
	await waitFor(async () => (await foreignWindows()).some((w) => w.id === opened.id && w.tabs.length === 2 && w.tabs.every((/** @type {{ url: string }} */ t) => /^http:/.test(t.url))), {
		timeoutMs: 10000,
		what: "the operator's tabs to load",
	});
	operatorBefore = await foreignWindows();
	assert.ok(operatorBefore.length >= 2, "the browser's first window plus the one just opened");
	assert.equal(h.fixtures.seen((s) => s.query.operator === "tab" && s.finishedAt !== null).length, 1);
});

test("navigator.webdriver is false as seen by the page", async () => {
	const r = await job(fx("a", "/plain"));
	assert.equal(r.outcome, "ok");
	// Written into the page by the page's own script, before anything of ours ran in it.
	assert.match(r.content.markdown, /webdriver=false/);
});

test("header echo: a plain browser navigation, no cookies, nothing added", async () => {
	const r = await job(fx("b", "/headers"));
	assert.equal(r.outcome, "ok");
	const sent = h.fixtures.seen((s) => s.path === "/headers").at(-1);
	assert.ok(sent);
	assert.match(sent.headers["user-agent"], /Firefox\/\d+/);
	assert.equal(sent.headers["sec-fetch-dest"], "document");
	assert.equal(sent.headers["sec-fetch-mode"], "navigate");
	assert.equal(sent.headers.cookie, undefined);
	assert.equal(Object.keys(sent.headers).some((name) => name.startsWith("x-")), false);
});

test("one gateway window: park tab when idle, park tab plus one job tab during a job", async () => {
	const before = await assertIdleWindow();
	const url = fx("a", "/slow?ms=1500");
	const pending = job(url);
	const { snap, gw, tab } = await jobTabOpen();
	assert.equal(snap.windows.filter((w) => w.role === "gateway").length, 1);
	assert.equal(gw.id, before.own.windowId, "the same window is reused");
	assert.equal(gw.tabs.length, 2);
	assert.deepEqual(snap.own.jobTabs, [tab.id]);
	assert.equal(tab.cookieStoreId, snap.containerId);
	assert.match(String(snap.containerId), /^firefox-container-\d+$/);
	assert.equal(tab.muted, true);
	assert.equal(tab.active, true);
	const park = gw.tabs.find((/** @type {any} */ t) => t.id === snap.own.parkTabId);
	assert.equal(park.cookieStoreId, "firefox-default");
	const r = await pending;
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.match(r.content.html, /bgw-fixture-slow-marker/);
	const after = await assertIdleWindow();
	assert.equal(after.own.windowId, before.own.windowId);
	// The closed job tab is not left in the operator's "recently closed" list.
	const closed = await h.hook("recently.closed");
	assert.deepEqual(closed.filter((/** @type {any} */ c) => typeof c.url === "string" && c.url.includes("/slow")), []);
	// ... because its record was found there and removed, not because none was made.
	const log = await h.hook("logs");
	assert.ok(log.some((/** @type {any} */ l) => l.event === "window.closed_tab_forgotten"));
	assert.equal(log.some((/** @type {any} */ l) => l.event === "window.closed_tab_not_forgotten"), false);
});

test("content that appears after load is captured once the DOM is quiet", async () => {
	const r = await job(fx("a", "/late?ms=700"), { wait: { settle_ms: 1000 } });
	assert.equal(r.outcome, "ok");
	assert.equal(r.render.settled, true);
	assert.match(r.content.markdown, /bgw-fixture-late-content/);
});

test("a page that never goes quiet is returned at the cap, reported as not settled", async () => {
	const r = await job(fx("a", "/mutating"), { wait: { settle_ms: 300 } });
	assert.equal(r.outcome, "ok");
	assert.equal(r.render.settled, false);
	assert.ok(r.render.elapsed_ms >= 4500, `elapsed ${r.render.elapsed_ms}`);
});

test("probe: page facts without content", async () => {
	const r = await job(fx("a", "/plain"), { kind: "probe" });
	assert.equal(r.outcome, "ok");
	assert.equal(r.page.title, "Fixture plain page");
	assert.equal(r.content, null);
});

test("html only when asked for, markdown unless switched off, links unless switched off", async () => {
	const url = () => fx("a", "/smoke/article.html");
	const byDefault = await h.submitJob({ kind: "fetch", url: url(), wait: { timeout_ms: 15000, settle_ms: 200, dwell_ms: 0 } });
	assert.equal(byDefault.status, 200);
	let r = byDefault.json.result;
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.content.html, null);
	assert.match(r.content.markdown, /ZEBRACORP-MAIN/);
	assert.ok(r.content.links.length > 0);
	assert.equal(r.page.title, "Harbor council approves the Quayside tram extension");

	// The visible text comes along unless it is switched off.
	assert.match(r.content.text, /ZEBRACORP-MAIN/);
	assert.match(r.content.text, /NAV-CLUTTER/);

	r = await job(url(), { extract: { markdown: false, text: false, html: true, links: false } });
	assert.equal(r.content.markdown, null);
	assert.equal(r.content.text, null);
	assert.match(r.content.html, /ZEBRACORP-MAIN/);
	assert.deepEqual(r.content.links, []);

	r = await job(url(), { extract: { markdown: false, text: false, html: false, links: false } });
	// In the gateway's own container the page source is always taken, whatever else is switched off.
	assert.equal(typeof r.content.raw_html, "string");
	assert.deepEqual({ ...r.content, raw_html: null }, { markdown: null, text: null, html: null, raw_html: null, links: [], results: [] });
	assert.equal(r.page.extractor, "defuddle@0.19.4", "the page facts are there all the same");
	assert.equal(r.extraction.view, "article");
	assert.deepEqual(r.truncated, { markdown: false, text: false, html: false, raw_html: false });
});

/** @param {string} id job id @returns {Promise<Record<string, any>>} what the extension logged about the extraction of that job */
async function extractionLog(id) {
	const entry = (await h.hook("logs")).find((/** @type {any} */ l) => l.event === "job.extracted" && l.fields.job === id);
	assert.ok(entry, "the extraction was logged");
	return entry.fields;
}

test("article: markdown with headings and links, clutter left out, metadata from the page", async () => {
	const url = fx("a", "/smoke/article.html");
	const r = await job(url);
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	const md = r.content.markdown;
	assert.match(md, /ZEBRACORP-MAIN/);
	assert.match(md, /^## What the vote means$/m);
	assert.match(md, /^## Next steps$/m);
	assert.ok(md.includes("[published transit plan](https://transit.example.org/quayside-plan)"), md.slice(0, 600));
	assert.ok(md.includes(`[full budget document](${h.fixtures.url("a", "/documents/budget-2026.pdf")})`), "a relative link is made absolute");
	for (const clutter of ["NAV-CLUTTER", "SIDEBAR-CLUTTER", "FOOTER-CLUTTER", "COMMENT-CLUTTER"]) {
		assert.equal(md.includes(clutter), false, `${clutter} in the markdown`);
		assert.equal(r.content.html.includes(clutter), false, `${clutter} in the html`);
	}
	assert.deepEqual(r.page, {
		title: "Harbor council approves the Quayside tram extension",
		author: "Marta Okonkwo",
		published: "2026-03-14T08:30:00Z",
		lang: "en",
		site: "The Example Courier",
		word_count: r.page.word_count,
		extractor: "defuddle@0.19.4",
	});
	assert.ok(r.page.word_count > 100 && r.page.word_count < 400, `word count ${r.page.word_count}`);
	assert.deepEqual(r.content.links, [
		{ url: "https://transit.example.org/quayside-plan", text: "published transit plan" },
		{ url: h.fixtures.url("a", "/documents/budget-2026.pdf"), text: "full budget document" },
	]);
	assert.deepEqual(r.truncated, { markdown: false, text: false, html: false, raw_html: false });
	// The article view stands for the page, and says what share of it it holds. The rest is in the text.
	assert.equal(r.extraction.view, "article");
	assert.ok(r.extraction.coverage_pct >= 55 && r.extraction.coverage_pct <= 80, `coverage ${r.extraction.coverage_pct}`);
	assert.deepEqual({ removed: r.extraction.hidden_removed, capped: r.extraction.capped }, { removed: 0, capped: false });
	for (const clutter of ["NAV-CLUTTER", "SIDEBAR-CLUTTER", "FOOTER-CLUTTER", "COMMENT-CLUTTER", "ZEBRACORP-MAIN"]) assert.ok(r.content.text.includes(clutter), `${clutter} in the visible text`);
	assert.equal(/<[a-z]/i.test(r.content.text), false, "the text is text");
	assert.equal(r.nav.final_url, url);
	const log = await extractionLog(r.job);
	assert.equal(log.extractor, "defuddle@0.19.4");
	assert.equal(log.capped, false);
	await assertIdleWindow();
});

test("forum thread: the article view holds the first post only, so the whole page is returned, replies and all", async () => {
	const r = await job(fx("a", "/smoke/forum.html"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	const md = r.content.markdown;
	assert.match(md, /FORUMOP-MAIN/);
	assert.match(md, /FORUMREPLY-MAIN/);
	assert.match(md, /FORUMREPLY2-MAIN/);
	assert.ok(md.indexOf("FORUMOP-MAIN") < md.indexOf("FORUMREPLY-MAIN") && md.indexOf("FORUMREPLY-MAIN") < md.indexOf("FORUMREPLY2-MAIN"), "in page order");
	// (Markdown writes an underscore in running text with a backslash before it.)
	for (const author of ["quokka\\_dev", "fennec42", "otter\\_ops"]) assert.ok(md.includes(author), author);
	for (const author of ["quokka_dev", "fennec42", "otter_ops"]) assert.ok(r.content.text.includes(author), author);
	assert.ok(md.includes("[the pragma docs](https://www.sqlite.org/pragma.html)"));
	assert.ok(md.includes(`[tuning thread](${h.fixtures.url("a", "/t/9981-sqlite-tuning")})`), "a relative link is made absolute");
	assert.ok(md.includes("\u{1F600}\u{1F680}\u{1F4A1}"), "emoji survive");
	// Said so, by an enum and a number: the full page, because the article view held about a third of it.
	assert.equal(r.extraction.view, "full_page");
	assert.ok(r.extraction.coverage_pct >= 25 && r.extraction.coverage_pct < 50, `coverage ${r.extraction.coverage_pct}`);
	assert.equal(r.page.extractor, "defuddle@0.19.4+fullpage");
	// The full page is the full page: what stands around the thread is in it.
	for (const around of ["TOPBAR-CLUTTER", "SIDEBAR-CLUTTER", "FOOTER-CLUTTER"]) assert.ok(md.includes(around), around);
	assert.equal(r.page.title, "Best way to cache SQLite queries?");
	assert.equal(r.page.site, "Dev Forum");
	assert.equal(r.page.published, null);
	// The visible text and the document are those of the whole page as well.
	assert.match(r.content.text, /FORUMREPLY2-MAIN/);
	assert.match(r.content.html, /FORUMREPLY2-MAIN/);
	assert.equal(/<(script|style|iframe|form)\b|\son[a-z]+=/i.test(r.content.html), false);
	assert.ok(r.content.links.some((/** @type {any} */ l) => l.url === "https://www.sqlite.org/pragma.html" && l.text === "the pragma docs"));
	assert.ok(r.content.links.some((/** @type {any} */ l) => l.url === h.fixtures.url("a", "/t/9981-sqlite-tuning")));
	assert.deepEqual(r.truncated, { markdown: false, text: false, html: false, raw_html: false });
	const log = await extractionLog(r.job);
	assert.deepEqual({ extractor: log.extractor, view: log.view, capped: log.capped }, { extractor: "defuddle@0.19.4+fullpage", view: "full_page", capped: false });
});

test("hostile page: nothing in the result that runs or loads, links are absolute http(s)", async () => {
	const r = await job(fx("a", "/smoke/hostile.html"), { wait: { settle_ms: 500 } });
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	const html = r.content.html;
	const md = r.content.markdown;
	assert.match(md, /HOSTILE-MAIN/);
	assert.equal(/<script/i.test(html), false, "a script element");
	assert.equal(/\son[a-z]+\s*=/i.test(html), false, "an on* attribute");
	assert.equal(/(javascript|vbscript|data):/i.test(html), false, "a javascript:, vbscript: or data: address");
	assert.equal(/<(iframe|object|embed|form|link|meta|base|style)\b|\sstyle=|srcdoc/i.test(html), false, "a frame, plugin, form or style");
	assert.equal(/\]\((javascript|vbscript|data):|<(iframe|script|object|embed|form)/i.test(md), false, md);
	assert.ok(md.includes("this harmless link") && md.includes("vb link"), "the text of a dropped link stays");
	assert.ok(html.includes('href="https://good.example.org/ok?a=1&amp;b=2"'));
	assert.ok(html.includes("mailto:help@example.org"));
	assert.deepEqual(r.content.links, [{ url: "https://good.example.org/ok?a=1&b=2", text: "legitimate link" }]);
	for (const link of r.content.links) assert.match(link.url, /^https?:\/\//);
	assert.equal(r.page.title, "Totally normal tutorial");
	assert.equal(/[\r\n\u2028\u2029]/.test(r.page.author ?? ""), false, "the author is one line");
	assert.equal(r.page.published, null, "a date that is none is dropped");
	assert.equal(r.page.site, "a.localhost", "the host name, not the author the page claims");
	assert.notEqual(r.page.site, r.page.author);
	assert.equal((await h.status()).extension.connected, true);
	await assertIdleWindow();
});

test("hidden text: what the page does not render is not in the result", async () => {
	const r = await job(fx("a", "/smoke/hidden.html"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	const md = r.content.markdown;
	const html = r.content.html;
	for (const name of ["DISPLAY", "CLASS", "VISIBILITY", "ATTR", "CV", "OPACITY", "OFFSCREEN", "TOP", "CLIP", "CLIPPATH", "FONT", "INDENT", "TRANSFORM", "SCALE", "CANVAS", "VIDEO", "NESTED", "COMMENT", "VISPARENT", "SCHEMA"]) {
		assert.equal(md.includes(`HIDDEN-${name}`), false, `HIDDEN-${name} in the markdown`);
		assert.equal(html.includes(`HIDDEN-${name}`), false, `HIDDEN-${name} in the html`);
	}
	// Rendered, closed <details> and a region collapsed by script included.
	for (const name of ["MAIN", "REVEALED", "DETAILS", "COLLAPSED", "LOWOPACITY"]) {
		assert.ok(md.includes(`VISIBLE-${name}`), `VISIBLE-${name} in the markdown`);
		assert.ok(html.includes(`VISIBLE-${name}`), `VISIBLE-${name} in the html`);
	}
	assert.equal(/attacker\.example|previous instructions/i.test(JSON.stringify({ ...r.content, raw_html: null }) + JSON.stringify(r.page)), false, "not one of the injected sentences, anywhere");
	// The page source is the page as it is: what the page hides is in it, and nowhere else.
	assert.ok(r.content.raw_html.includes("HIDDEN-DISPLAY") && /attacker\.example|previous instructions/i.test(r.content.raw_html));
	assert.equal(r.page.extractor, "defuddle@0.19.4");
	// Not in the visible text either: it is made from the same pruned copy of the page.
	for (const name of ["DISPLAY", "CLASS", "VISIBILITY", "ATTR", "CV", "OPACITY", "OFFSCREEN", "TOP", "CLIP", "CLIPPATH", "FONT", "INDENT", "TRANSFORM", "SCALE", "CANVAS", "VIDEO", "NESTED", "COMMENT", "VISPARENT", "SCHEMA"]) {
		assert.equal(r.content.text.includes(`HIDDEN-${name}`), false, `HIDDEN-${name} in the visible text`);
	}
	assert.ok(r.content.text.includes("VISIBLE-MAIN") && r.content.text.includes("VISIBLE-DETAILS") && r.content.text.includes("VISIBLE-COLLAPSED"));
	assert.equal(r.extraction.hidden_removed, (await extractionLog(r.job)).hidden_removed, "the count travels in the result");
	assert.ok(r.extraction.hidden_removed >= 17);
	assert.equal(r.page.author, "Ines Albrecht");
	assert.equal(r.page.site, "Orchard Notes");
	assert.deepEqual(r.content.links, [{ url: "https://orchard.example.org/calendar", text: "orchard calendar" }]);
	const log = await extractionLog(r.job);
	assert.ok(log.hidden_removed >= 17, `removed: ${log.hidden_removed}`);
	assert.ok(log.elements_inspected > 10 && log.capped === false, JSON.stringify(log));

	// The same on a page with so little visible text that the text path is taken.
	const thin = await job(fx("a", "/smoke/hiddenthin.html"));
	assert.equal(thin.outcome, "ok");
	assert.equal(thin.page.extractor, "innertext");
	assert.match(thin.content.markdown, /THINVIS-MARK/);
	assert.equal(/THINHID-/.test(JSON.stringify({ ...thin.content, raw_html: null }) + JSON.stringify(thin.page)), false, JSON.stringify(thin.content));
	assert.match(thin.content.raw_html, /THINHID-/);
	assert.deepEqual(thin.content.links, [{ url: h.fixtures.url("a", "/thin-elsewhere"), text: "Visible link" }]);
	assert.equal(thin.page.word_count, 5);
	assert.equal((await extractionLog(thin.job)).hidden_removed, 4);
	assert.deepEqual(thin.extraction, { view: "text", coverage_pct: null, hidden_removed: 4, capped: false });
});

test("thin page: the text of what is rendered (innertext), with its links", async () => {
	const r = await job(fx("a", "/smoke/thin.html"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.page.extractor, "innertext");
	assert.equal(r.content.markdown, "Hello THIN-MARK\n\nGo elsewhere");
	// The Markdown is the visible text: said so, and not sent a second time.
	assert.deepEqual(r.extraction, { view: "text", coverage_pct: null, hidden_removed: 0, capped: false });
	assert.equal(r.content.text, null);
	assert.equal(r.page.title, "Tiny page");
	assert.equal(r.page.word_count, 4);
	assert.equal(r.page.site, "a.localhost");
	assert.deepEqual(r.content.links, [{ url: h.fixtures.url("a", "/elsewhere"), text: "Go elsewhere" }]);
	assert.match(r.content.html, /THIN-MARK/);
	assert.equal((await extractionLog(r.job)).hidden_removed, 0);
});

test("the extractor in a watched tab: the live page is not changed, nothing is requested, small limits are flagged", async () => {
	// An ordinary tab, so that it stays open to be looked at afterwards. The
	// extractor is injected exactly as a job does it.
	for (const name of ["article", "hostile", "hidden"]) {
		const opened = await h.hook("window.open", { url: fx("a", `/smoke/${name}.html`) });
		try {
			await waitFor(() => h.fixtures.seen((s) => s.path === `/smoke/${name}.html` && s.finishedAt !== null).length >= 1, { timeoutMs: 10000, what: "the page" });
			await new Promise((resolve) => setTimeout(resolve, 800));
			const seenBefore = h.fixtures.requests.length;
			const full = { markdown: true, text: true, html: true, links: true, maxMarkdownChars: LIMITS.MAX_RESULT_BYTES, maxTextChars: LIMITS.MAX_RESULT_BYTES, maxHtmlChars: LIMITS.MAX_RESULT_BYTES, maxLinks: LIMITS.MAX_LINKS };
			const check = await h.hook("extract.check", { tabId: opened.tabs[0], options: full });
			assert.equal(check.result.ok, true);
			assert.match(check.result.page.extractor, /^defuddle@0\.19\.4/);
			// The live document: same serialisation, not one mutation record, not scrolled.
			assert.deepEqual(check.page, { mutations: 0, domUnchanged: true, newResources: 0, scrollUnchanged: true, pageSeesDefuddle: "undefined", pageSeesExtract: "undefined", webdriver: false }, name);
			// Not one request by the browser while it ran twice, to any host.
			assert.deepEqual(check.requests, [], name);
			assert.equal(h.fixtures.requests.length, seenBefore, "nor did anything reach the fixture server");
			assert.deepEqual({ ...check.result, stats: 0 }, { ...check.again, stats: 0 }, "the same answer twice");
			assert.deepEqual(check.result.truncated, { markdown: false, text: false, html: false, raw_html: false });

			// Small limits: all three texts cut to them, their flags set, links capped.
			const small = (await h.hook("extract.check", { tabId: opened.tabs[0], options: { ...full, maxMarkdownChars: 50, maxTextChars: 70, maxHtmlChars: 60, maxLinks: 1 } })).result;
			assert.equal(small.content.markdown.length, 50);
			assert.equal(small.content.text.length, 70);
			assert.equal(small.content.html.length, 60);
			assert.ok(check.result.content.markdown.startsWith(small.content.markdown));
			assert.ok(check.result.content.text.startsWith(small.content.text));
			assert.ok(check.result.content.html.startsWith(small.content.html));
			assert.deepEqual(small.truncated, { markdown: true, text: true, html: true, raw_html: false });
			assert.ok(small.content.links.length <= 1);
			// A cap on the elements looked at: the rest of the page is dropped, and the result says so.
			const capped = (await h.hook("extract.check", { tabId: opened.tabs[0], options: { ...full, maxElements: 8 } })).result;
			assert.deepEqual({ inspected: capped.stats.elements_inspected, cap: capped.stats.elements_cap, capped: capped.stats.capped }, { inspected: 8, cap: 8, capped: true });
			assert.ok(capped.stats.dropped > 0);
			// (So little of the page is left that its Markdown may be the visible text, which is then not sent twice.)
			assert.deepEqual(capped.truncated, { markdown: true, text: capped.extraction.view !== "text", html: true, raw_html: false });
			assert.equal(capped.extraction.capped, true);
			assert.ok(capped.content.markdown.length < check.result.content.markdown.length);
		} finally {
			await h.hook("window.close", { windowId: opened.id });
		}
	}
});

test("a 2 MB page comes back whole, as markdown and html, within the result limit", async () => {
	const r = await job(fx("a", "/big?kb=2000"), { wait: { timeout_ms: 30000 } });
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.page.extractor, "defuddle@0.19.4");
	assert.deepEqual(r.truncated, { markdown: false, text: false, html: false, raw_html: false });
	assert.match(r.content.markdown, /bgw-fixture-big-marker/);
	// The visible text of the same two megabytes travels with it.
	assert.equal(r.extraction.view, "article");
	assert.ok(r.content.text.length > 2000000 && r.content.text.length < 2200000, `text length ${r.content.text.length}`);
	// Long as it is, the page is walked down a bounded way only.
	assert.ok(r.render.scrolled_px > 5000 && r.render.scrolled_px < 40000, `scrolled ${r.render.scrolled_px} px`);
	assert.ok(r.content.markdown.length > 2000000 && r.content.markdown.length < 2200000, `markdown length ${r.content.markdown.length}`);
	assert.ok(r.content.html.length > 2000000 && r.content.html.length < 2200000, `html length ${r.content.html.length}`);
	assert.ok(r.content.markdown.endsWith("x".repeat(1000)), "down to its last paragraph");
	const bytes = Buffer.byteLength(JSON.stringify(r));
	assert.ok(bytes < LIMITS.MAX_RESULT_BYTES, `the result is ${bytes} bytes`);
	assert.equal((await h.status()).extension.connected, true);
	assert.deepEqual(daemonLog("ext.protocol_violation"), []);
});

test("an error status is reported as it is", async () => {
	const r = await job(fx("a", "/status?code=503"));
	assert.equal(r.outcome, "ok");
	assert.equal(r.nav.http_status, 503);
	assert.match(r.content.html, /bgw-fixture-status-503/);
});

test("a document larger than the result limit is cut, flagged, and the link survives", async () => {
	const r = await job(fx("a", "/big?kb=9000"), { wait: { timeout_ms: 30000 }, extract: { markdown: false, text: false, html: true } });
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.deepEqual(r.truncated, { markdown: false, text: false, html: true, raw_html: true });
	assert.equal(r.content.raw_html, "", "the page source is the first to go: the document keeps the room");
	assert.ok(r.content.html.length > 8000000 && r.content.html.length < 8388608, `html length ${r.content.html.length}`);
	// Too much text for Defuddle in reasonable time: the rendered text as it is.
	assert.equal(r.page.extractor, "innertext");
	assert.equal((await h.status()).extension.connected, true);
	assert.deepEqual(daemonLog("ext.protocol_violation"), []);

	// With both asked for, the Markdown comes first and takes all there is.
	const both = await job(fx("a", "/big?kb=9000"), { wait: { timeout_ms: 30000 } });
	assert.equal(both.outcome, "ok", JSON.stringify(both.error));
	// The Markdown of this page is its visible text (too large to analyse): it is not sent a second time.
	assert.deepEqual(both.truncated, { markdown: true, text: false, html: true, raw_html: true });
	assert.equal(both.content.raw_html, "");
	assert.deepEqual(both.extraction, { view: "text", coverage_pct: null, hidden_removed: 0, capped: false });
	assert.equal(both.content.text, null);
	assert.ok(both.content.markdown.length > 8000000 && both.content.markdown.length < 8388608, `markdown length ${both.content.markdown.length}`);
	assert.match(both.content.markdown, /^bgw-fixture-big-marker/);
	assert.equal(both.content.html, "");

	// Without the Markdown the text is what comes first; the document is still the first to go.
	const textFirst = await job(fx("a", "/big?kb=9000"), { wait: { timeout_ms: 30000 }, extract: { markdown: false, text: true, html: true } });
	assert.deepEqual(textFirst.truncated, { markdown: false, text: true, html: true, raw_html: true });
	assert.equal(textFirst.content.raw_html, "");
	assert.ok(textFirst.content.text.length > 8000000 && textFirst.content.text.length < 8388608, `text length ${textFirst.content.text.length}`);
	assert.deepEqual([textFirst.content.markdown, textFirst.content.html], [null, ""]);
	assert.equal(textFirst.content.raw_html, "");
	assert.ok(Buffer.byteLength(JSON.stringify(textFirst)) < LIMITS.MAX_RESULT_BYTES);
	assert.equal((await h.status()).extension.connected, true);
	assert.deepEqual(daemonLog("ext.protocol_violation"), []);
});

test("container isolation: default-store cookies stay out, job cookies stay in", async () => {
	const site = h.fixtures.url("a", "/");
	assert.equal(await h.hook("cookies.set", { url: site, name: "bgw_default", value: "d1" }), true);

	// A cookie of the operator's default store is not sent from a job.
	let r = await job(fx("a", "/cookie/echo?step=1"));
	assert.equal(r.outcome, "ok");
	let sent = h.fixtures.seen((s) => s.query.step === "1")[0];
	assert.deepEqual(sent.cookies, {});

	// A cookie set by a job is sent by the next job.
	r = await job(fx("a", "/cookie/set?name=bgw_job&value=j1"));
	assert.equal(r.outcome, "ok");
	r = await job(fx("a", "/cookie/echo?step=2"));
	assert.equal(r.outcome, "ok");
	sent = h.fixtures.seen((s) => s.query.step === "2")[0];
	assert.deepEqual(sent.cookies, { bgw_job: "j1" });
	assert.match(r.content.html, /bgw_job/);

	// The default store never receives it.
	const inDefault = await h.hook("cookies.get", { url: site });
	assert.deepEqual(inDefault, [{ name: "bgw_default", value: "d1" }]);
	const snap = await windows();
	const inContainer = await h.hook("cookies.get", { url: site, storeId: snap.containerId });
	assert.deepEqual(inContainer, [{ name: "bgw_job", value: "j1" }]);
});

test("redirect to another fixture host is followed and its origin recorded", async () => {
	const target = fx("b", "/hit?via=redirect");
	const r = await job(fx("a", `/redirect?to=${encodeURIComponent(target)}`));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.nav.final_url, target);
	assert.deepEqual(r.nav.redirect_origins, [new URL(target).origin]);
	assert.match(r.content.html, /bgw-fixture-hit-marker/);
});

test("300 with a Location is no redirect to this browser: its body is the page, the address in Location is never asked for - and one that calls itself a download is refused, with nothing saved", async () => {
	// HTTP lets a browser go where the Location of a 300 says. This one does not: it shows what the 300 carried.
	const target = fx("b", "/hit?via=location-of-300");
	const asked = fx("a", `/redirect?status=300&to=${encodeURIComponent(target)}`);
	const r = await job(asked);
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.nav.http_status, 300);
	assert.equal(r.nav.final_url, asked);
	assert.deepEqual(r.nav.redirect_origins, []);
	assert.doesNotMatch(r.content.html ?? "", /bgw-fixture-hit-marker/);
	assert.deepEqual(h.fixtures.seen((s) => s.query.via === "location-of-300"), [], "the address in Location was never requested");

	// The same answer calling itself an archive to be saved: judged by that, not let through as a redirect.
	const saved = await job(fx("a", `/redirect?status=300&attach=1&to=${encodeURIComponent(fx("b", "/hit?via=location-of-300-attach"))}`));
	assert.deepEqual([saved.outcome, saved.error.code], ["unsupported", "attachment"]);
	assert.deepEqual(h.fixtures.seen((s) => s.query.via === "location-of-300-attach"), []);
	assert.deepEqual(h.downloads(), []);
	// With 302 the very same answers are redirects: followed, and their own claims count for nothing.
	const followed = await job(fx("a", `/redirect?status=302&attach=1&to=${encodeURIComponent(fx("b", "/hit?via=location-of-302-attach"))}`));
	assert.equal(followed.outcome, "ok", JSON.stringify(followed.error));
	assert.equal(h.fixtures.seen((s) => s.query.via === "location-of-302-attach").length, 1);
	assert.deepEqual(h.downloads(), []);
	await assertIdleWindow();
});

test("redirect to a private address: policy_blocked, and the target is never requested", async () => {
	const target = h.fixtures.forbiddenUrl("/secret?via=redirect");
	const r = await job(fx("a", `/redirect?to=${encodeURIComponent(target)}`));
	assert.equal(r.outcome, "policy_blocked");
	assert.equal(r.error.code, "private_address");
	assert.equal(r.error.retryable, false);
	assert.equal(r.content, null);
	assert.deepEqual(r.nav.redirect_origins, [new URL(target).origin]);
	assert.deepEqual(h.fixtures.seen((s) => s.listener === "forbidden"), []);
	await assertIdleWindow();

	// The same through a redirect made by a script after the page loaded.
	const r2 = await job(fx("a", `/js-redirect?to=${encodeURIComponent(h.fixtures.forbiddenUrl("/secret?via=script"))}`), { wait: { settle_ms: 1500 } });
	assert.equal(r2.outcome, "policy_blocked");
	assert.equal(r2.error.code, "private_address");
	assert.deepEqual(h.fixtures.seen((s) => s.listener === "forbidden"), []);

	// A private literal on a standard port.
	const r3 = await job(fx("a", `/redirect?to=${encodeURIComponent("http://10.255.255.1/")}`));
	assert.equal(r3.outcome, "policy_blocked");
	assert.equal(r3.error.code, "private_address");
	await assertIdleWindow();
});

test("redirect to a blocklisted host: policy_blocked, and the target is never requested", async () => {
	const target = `http://${BLOCKLISTED_HOST}:${h.fixtures.port}/hit?via=blocklist`;
	const r = await job(fx("a", `/redirect?to=${encodeURIComponent(target)}`));
	assert.equal(r.outcome, "policy_blocked");
	assert.equal(r.error.code, "blocklisted");
	assert.deepEqual(h.fixtures.seen((s) => s.host.startsWith(BLOCKLISTED_HOST)), []);

	// The real blocklist, through a redirect.
	const r2 = await job(fx("a", `/redirect?to=${encodeURIComponent("https://accounts.google.com/")}`));
	assert.equal(r2.outcome, "policy_blocked");
	assert.equal(r2.error.code, "blocklisted");
	await assertIdleWindow();
});

test("the extension checks the policy itself, whatever the daemon let through", async () => {
	// The daemon of this test run does not know the extra blocklist entry.
	const r = await job(`http://${BLOCKLISTED_HOST}:${h.fixtures.port}/hit?via=direct`);
	assert.equal(r.outcome, "policy_blocked");
	assert.equal(r.error.code, "blocklisted");
	assert.equal(r.cookie_scope, null, "no tab was opened");
	assert.deepEqual(h.fixtures.seen((s) => s.host.startsWith(BLOCKLISTED_HOST)), []);
	await assertIdleWindow();
});

test("a public-looking name that resolves to a private address is refused before any request", async () => {
	const r = await job(`http://${LOOPBACK_NAME}:${h.fixtures.port}/hit?via=dns`);
	assert.equal(r.outcome, "policy_blocked", JSON.stringify(r.error));
	assert.equal(r.error.code, "private_address");
	assert.equal(r.cookie_scope, null);
	assert.deepEqual(h.fixtures.seen((s) => s.query.via === "dns"), []);

	// And as a redirect target.
	const target = `http://${LOOPBACK_NAME}:${h.fixtures.port}/hit?via=dns-redirect`;
	const r2 = await job(fx("a", `/redirect?to=${encodeURIComponent(target)}`));
	assert.equal(r2.outcome, "policy_blocked");
	assert.equal(r2.error.code, "private_address");
	assert.deepEqual(h.fixtures.seen((s) => s.query.via === "dns-redirect"), []);
	await assertIdleWindow();
});

test("a page cannot make the browser fetch from a private address", async () => {
	const r = await job(fx("a", `/subresource?src=${encodeURIComponent(h.fixtures.forbiddenUrl("/pixel?via=img"))}`), { wait: { settle_ms: 500 } });
	assert.equal(r.outcome, "ok");
	assert.match(r.content.html, /bgw-fixture-subresource-marker/);
	assert.deepEqual(h.fixtures.seen((s) => s.listener === "forbidden"), []);
	// The control: the same page with an allowed image does fetch it.
	const r2 = await job(fx("a", `/subresource?src=${encodeURIComponent(fx("b", "/pixel?via=img-ok"))}`), { wait: { settle_ms: 500 } });
	assert.equal(r2.outcome, "ok");
	assert.equal(h.fixtures.seen((s) => s.query.via === "img-ok").length, 1);
});

test("control: outside a job tab the same responses do become downloads", async () => {
	// Shows that the "nothing was saved" checks below can fail: an ordinary
	// tab, which the guard does not touch, saves both files.
	assert.deepEqual(h.downloads(), []);
	for (const route of ["/attachment?control=1", "/binary-as-text?control=1", `/frame?src=${encodeURIComponent("/attachment?control=frame")}`]) {
		const opened = await h.hook("window.open", { url: fx("a", route) });
		await waitFor(() => h.downloads().some((name) => !name.endsWith(".part")), { timeoutMs: 15000, what: `a download of ${route}` });
		await h.hook("window.close", { windowId: opened.id });
		await new Promise((resolve) => setTimeout(resolve, 300));
		for (const name of h.downloads()) fs.rmSync(path.join(h.downloadsDir, name), { force: true });
	}
	assert.deepEqual(h.downloads(), []);
	// All three were the operator's: saved in the default store, never the container's.
	const list = await h.hook("downloads.list");
	assert.equal(list.length, 3);
	assert.ok(list.every((/** @type {any} */ d) => d.cookieStoreId === "firefox-default" && d.state === "complete"), JSON.stringify(list));
	for (const d of list) await h.hook("downloads.act", { id: d.id, action: "erase" });
});

test("attachment: unsupported, and no download starts", async () => {
	const r = await job(fx("a", "/attachment"));
	assert.equal(r.outcome, "unsupported");
	assert.equal(r.error.code, "attachment");
	assert.equal(r.content, null);
	await assertIdleWindow();
	assert.deepEqual(h.downloads(), []);
});

test("a frame inside a page cannot start a download either", async () => {
	const r = await job(fx("a", `/frame?src=${encodeURIComponent("/attachment?via=frame")}`), { wait: { settle_ms: 800 } });
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.match(r.content.html, /bgw-fixture-frame-marker/);
	assert.equal(h.fixtures.seen((s) => s.query.via === "frame").length, 1, "the frame was requested");
	await new Promise((resolve) => setTimeout(resolve, 1000));
	assert.deepEqual(h.downloads(), []);
	// An ordinary frame is left alone.
	const ok = await job(fx("a", `/frame?src=${encodeURIComponent("/hit?via=frame-ok")}`), { wait: { settle_ms: 500 } });
	assert.equal(ok.outcome, "ok");
	assert.equal(h.fixtures.seen((s) => s.query.via === "frame-ok" && s.finishedAt !== null).length, 1);
});

test("a tab that a job page opens by itself is closed at once", async () => {
	const before = (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === "window.stray_tab_closed").length;
	const r = await job(fx("a", `/opener?to=${encodeURIComponent(fx("b", "/hit?via=opener"))}`), { wait: { settle_ms: 800 } });
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.match(r.content.html, /bgw-fixture-opener-marker/);
	const after = (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === "window.stray_tab_closed").length;
	assert.equal(after, before + 1, "the pop-up was seen and closed");
	const snap = await assertIdleWindow();
	assert.equal(snap.windows.some((w) => w.tabs.some((/** @type {any} */ t) => typeof t.url === "string" && t.url.includes("via=opener"))), false, "it is open nowhere");

	// Nothing loads in such a tab before it is gone, a private address least of all.
	// (The tab is put under a sealed guard the moment it appears; if this ever
	// fails, a request won that race.)
	const r2 = await job(fx("a", `/opener?to=${encodeURIComponent(h.fixtures.forbiddenUrl("/secret?via=opener"))}`), { wait: { settle_ms: 800 } });
	assert.equal(r2.outcome, "ok");
	assert.deepEqual(h.fixtures.seen((s) => s.listener === "forbidden"), []);
	await assertIdleWindow();
});

test("a pop-up that gets a window of its own, navigated or written into, loads nothing and is closed with its window", async () => {
	// Such a pop-up names no opener, and its window is not the gateway's: it is known by the container
	// it is in, sealed by listeners of its own the moment it is reported, and closed.
	const windowsBefore = (await windows()).windows.length;
	const strays = async () => (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === "window.stray_tab_closed").length;
	const features = encodeURIComponent("width=300,height=200");
	for (let round = 0; round < 3; round++) {
		const before = await strays();
		// Navigated to a page of an allowed host: the page is never asked for.
		const nav = await job(fx("a", `/opener?to=${encodeURIComponent(fx("b", `/hit?via=popup-window-${round}`))}&features=${features}`), { wait: { settle_ms: 1000 } });
		assert.equal(nav.outcome, "ok", JSON.stringify(nav.error));
		// Left blank and written into by its opener: the picture is never asked for, wherever it lies.
		const pub = await job(fx("a", `/opener?write=${encodeURIComponent(fx("b", `/pixel?via=popup-write-${round}`))}&features=${features}`), { wait: { settle_ms: 1000 } });
		assert.equal(pub.outcome, "ok");
		const priv = await job(fx("a", `/opener?write=${encodeURIComponent(h.fixtures.forbiddenUrl(`/pixel?via=popup-write-private-${round}`))}&features=${features}`), { wait: { settle_ms: 1000 } });
		assert.equal(priv.outcome, "ok");
		// The same without a window of its own, written into.
		const tab = await job(fx("a", `/opener?write=${encodeURIComponent(fx("b", `/pixel?via=popup-write-tab-${round}`))}`), { wait: { settle_ms: 1000 } });
		assert.equal(tab.outcome, "ok");
		// A pop-up with a window of its own is closed when its job is over; one in the gateway window at once.
		await waitFor(async () => (await strays()) === before + 4, { timeoutMs: 5000, what: "each pop-up to be seen and closed" });
	}
	assert.deepEqual(h.fixtures.seen((s) => /^popup-/.test(s.query.via ?? "")).map((s) => s.query.via), [], "not one request of a pop-up left the browser");
	assert.deepEqual(h.fixtures.seen((s) => s.listener === "forbidden"), []);
	const snap = await assertIdleWindow();
	assert.equal(snap.windows.length, windowsBefore, "no pop-up window is left open");
	assert.equal(snap.windows.some((w) => w.tabs.some((/** @type {any} */ t) => t.cookieStoreId === snap.containerId)), false, "no tab of the container is open anywhere");
});

test("responses that are not pages: unsupported with a code, and nothing is saved", async () => {
	/** @type {[string, string][]} */
	const cases = [
		["/json", "content_type_json"],
		["/xml", "content_type_xml"],
		["/pdf", "content_type"],
		["/octet", "content_type"],
		["/no-type", "content_type_missing"],
		["/binary-as-text", "plain_text_sniffable"],
		["/no-content", "no_content"],
	];
	for (const [path, code] of cases) {
		const r = await job(fx("a", path));
		assert.equal(r.outcome, "unsupported", `${path}: ${JSON.stringify(r.error)}`);
		assert.equal(r.error.code, code, path);
		assert.equal(r.error.retryable, false);
	}
	await assertIdleWindow();
	// Give a download that slipped through time to show up.
	await new Promise((resolve) => setTimeout(resolve, 1000));
	assert.deepEqual(h.downloads(), []);
});

// ---------------------------------------------------------------- downloads backstop

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @returns {{ name: string, size: number }[]} what lies in the download directory */
const downloadFiles = () => fs.readdirSync(h.downloadsDir).map((name) => ({ name, size: fs.statSync(path.join(h.downloadsDir, name)).size }));
/** @returns {Promise<any[]>} the browser's own list of downloads */
const downloadList = () => h.hook("downloads.list");

/** @param {string} event @param {number} since @returns {Promise<Record<string, any>[]>} what the extension logged under that name since then */
const loggedSince = async (event, since) => (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === event && l.t >= since).map((/** @type {any} */ l) => l.fields);

/**
 * Leave the fixture worker behind in the gateway container, the way a page can. When a job ends, the workers
 * of its page are taken away - if the page can still be asked. This one goes, as soon as its worker is active,
 * to an address the worker answers with JSON: the job ends there (the guard never saw that response), the tab
 * shows the browser's JSON viewer, and a viewer is no page an extension can ask for anything. The worker stays.
 * @param {string} [host]
 */
async function leaveWorker(host = "a") {
	const since = Date.now();
	const r = await job(fx(host, "/sw/register?then=/sw/data"), { wait: { settle_ms: 2500 } });
	assert.deepEqual({ outcome: r.outcome, code: r.error?.code }, { outcome: "error", code: "unguarded_response" }, "the page went where its worker answers");
	assert.deepEqual(await loggedSince("job.workers_removed", since), [], "and where its worker could not be taken away");
}
/**
 * @param {number} since epoch ms
 * @returns {Promise<Record<string, any>[]>} what the backstop logged since then about downloads it removed
 */
const removedLog = async (since) => (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === "downloads.removed" && l.t >= since).map((/** @type {any} */ l) => l.fields);

// First of all what must never happen: a download of the operator's own being
// touched. The same site, worker, address and file name in both cookie stores,
// at the same time.
test("downloads backstop: the operator's own downloads are left alone, right next to a job's", async () => {
	assert.deepEqual(h.downloads(), []);
	assert.deepEqual(await downloadList(), []);
	const began = Date.now();
	// The worker that answers with downloads, once in the gateway container and once in the operator's store.
	await leaveWorker();
	const workersBefore = h.fixtures.seen((s) => s.path === "/sw/worker.js").length;
	const op = await h.hook("window.open", { url: fx("a", "/sw/register?operator=1") });
	await waitFor(() => h.fixtures.seen((s) => s.path === "/sw/worker.js").length > workersBefore, { timeoutMs: 10000, what: "the operator's copy of the worker" });
	await pause(1500);

	// The operator starts a download that takes eight seconds ...
	await h.hook("tab.open", { windowId: op.id, url: fx("a", "/sw/slow-download?operator=1") });
	await waitFor(async () => (await downloadList()).some((d) => d.cookieStoreId === "firefox-default" && d.state === "in_progress"), { timeoutMs: 10000, what: "the operator's download to start" });
	// ... and jobs run into the very same download and into another one.
	const slow = await job(fx("a", "/sw/slow-download"), { wait: { settle_ms: 1000 } });
	assert.deepEqual({ outcome: slow.outcome, code: slow.error?.code }, { outcome: "unsupported", code: "download" });
	const blob = await job(fx("a", "/blob-download"), { wait: { settle_ms: 1000 } });
	assert.deepEqual({ outcome: blob.outcome, code: blob.error?.code }, { outcome: "unsupported", code: "download" });
	// A second download of the operator, a quick one, in between.
	await h.hook("tab.open", { windowId: op.id, url: fx("a", "/attachment?operator=2") });
	await waitFor(async () => (await removedLog(began)).length === 2, { timeoutMs: 10000, what: "the backstop to finish with the two job downloads" });

	// The operator's long download is still running: it was not cancelled along with the job's twin.
	let list = await downloadList();
	assert.ok(list.length >= 1 && list.every((d) => d.cookieStoreId === "firefox-default"), `only the operator's entries are left: ${JSON.stringify(list)}`);
	const running = list.find((d) => /bgw-fixture-sw-slow/.test(d.filename));
	assert.equal(running?.state, "in_progress", "the operator's download goes on");
	assert.equal(running?.error, null);

	// Both of the operator's downloads complete, whole.
	await waitFor(async () => (list = await downloadList()).length === 2 && list.every((d) => d.state === "complete"), { timeoutMs: 30000, intervalMs: 250, what: "the operator's downloads to complete" });
	assert.ok(list.every((d) => d.cookieStoreId === "firefox-default" && d.exists === true && d.error === null), JSON.stringify(list));
	const files = downloadFiles().sort((x, y) => x.name.localeCompare(y.name));
	assert.deepEqual(files.map((f) => f.name), ["bgw-fixture-download.html", path.basename(String(list.find((d) => /sw-slow/.test(d.filename))?.filename))], "the operator's two files and nothing else, no partial file");
	assert.equal(files[1].size, 80 * 4096, "every byte of the long one");
	assert.match(fs.readFileSync(path.join(h.downloadsDir, "bgw-fixture-download.html"), "utf8"), /<p>download<\/p>/);
	// The backstop dealt with exactly the two job downloads.
	assert.equal((await removedLog(began)).length, 2);
	assert.equal((await h.hook("logs")).some((/** @type {any} */ l) => ["downloads.remove_failed", "downloads.not_cancelled", "downloads.not_attributed"].includes(l.event)), false);

	// The operator clears up after themselves; from here on the directory is empty again.
	for (const d of list) {
		await h.hook("downloads.act", { id: d.id, action: "removeFile" });
		await h.hook("downloads.act", { id: d.id, action: "erase" });
	}
	await h.hook("window.close", { windowId: op.id });
	assert.deepEqual(h.downloads(), []);
	await assertIdleWindow();
});

// Three ways of saving a file that involve no response header the guard could
// refuse. Before the backstop each of them left a file behind.
for (const [name, route] of /** @type {[string, string][]} */ ([
	["a download started by a script from a blob", "/blob-download"],
	["a navigation to a data: URL of a type the browser saves", "/data-download"],
	["a download answered by a service worker the site installed in an earlier job", "/sw/download"],
])) {
	test(`downloads backstop: ${name} - unsupported / download, and no file remains`, async () => {
		assert.deepEqual(h.downloads(), []);
		const began = Date.now();
		if (route.startsWith("/sw/")) await leaveWorker();
		const r = await job(fx("a", route), { wait: { settle_ms: 1500 } });
		assert.equal(r.outcome, "unsupported", JSON.stringify(r.error));
		assert.equal(r.error.code, "download");
		assert.equal(r.error.retryable, false);
		assert.equal(r.content, null);
		assert.equal(r.cookie_scope, "container");
		// The backstop finishes a moment after the job was told.
		await waitFor(async () => (await removedLog(began)).length === 1, { timeoutMs: 10000, what: "the backstop to finish" });
		await pause(500);
		assert.deepEqual(downloadFiles(), [], "no file in the download directory, whole or partial");
		assert.deepEqual(await downloadList(), [], "no entry in the browser's download list");
		await assertIdleWindow();
		assert.equal((await job(fx("a", "/plain"))).outcome, "ok", "the next job runs as usual");
	});
}

test("downloads backstop: a download that is still running is cancelled, with nothing left behind", async () => {
	assert.deepEqual(h.downloads(), []);
	const began = Date.now();
	await leaveWorker();
	const started = Date.now();
	const r = await job(fx("a", "/sw/slow-download"), { wait: { settle_ms: 1500 } });
	assert.deepEqual({ outcome: r.outcome, code: r.error?.code }, { outcome: "unsupported", code: "download" });
	assert.ok(Date.now() - started < 4000, "the job did not wait for the eight seconds the download would take");
	await waitFor(async () => (await removedLog(began)).length === 1, { timeoutMs: 10000, what: "the backstop to finish" });
	assert.deepEqual(await removedLog(began), [{ cancelled: true, file_removed: false, state: "interrupted" }]);
	await pause(1000);
	assert.deepEqual(downloadFiles(), [], "neither the target file nor a .part file");
	assert.deepEqual(await downloadList(), []);
	await assertIdleWindow();
});

// ---------------------------------------------------------------- service workers

// A worker that an earlier job left in the container answers a later top-level load itself. The browser tells an
// extension of the request and then of nothing until the document is there: no response headers pass the guard,
// so no status, no type and no file rule was ever looked at. Before the fix a page of the worker's making was
// read and returned as "ok", and its JSON sat in the built-in viewer until the job gave up.
test("service worker: a top-level load that a left-behind worker answers itself ends the job when its document is committed - nothing of it is read", async () => {
	await leaveWorker();
	for (const [route, what] of /** @type {[string, string][]} */ ([
		["/sw/page", "a page of its own making"],
		["/sw/pass", "what it fetched from the server itself"],
		["/sw/data", "JSON of its own making, which the browser shows in its viewer"],
	])) {
		const since = Date.now();
		const url = fx("a", route);
		const r = await job(url, { wait: { settle_ms: 1500 } });
		assert.deepEqual({ outcome: r.outcome, code: r.error?.code, retryable: r.error?.retryable }, { outcome: "error", code: "unguarded_response", retryable: true }, `${what}: ${JSON.stringify(r.error)}`);
		assert.equal(r.content, null, what);
		assert.equal(r.page, null, what);
		assert.equal(r.nav.http_status, null, "no response was ever seen");
		assert.equal(r.cookie_scope, "container");
		assert.ok(r.render.elapsed_ms < 1500, `${what}: ended at the commit, not after settling or at a timeout (${r.render.elapsed_ms} ms)`);
		assert.equal(JSON.stringify(r).includes("bgw-fixture-sw-synthetic"), false, "not a word of the worker's");
		// Nothing was settled, looked at or extracted in that document.
		assert.deepEqual(await loggedSince("job.extracted", since), []);
		assert.deepEqual((await loggedSince("guard.verdict", since)).map((v) => v.code), ["unguarded_response"]);
		// The tab's own request never reached the server; only the worker's own fetch did, where it made one.
		const seen = h.fixtures.seen((x) => x.path === route && x.query.n === new URL(url).searchParams.get("n"));
		assert.equal(seen.length, route === "/sw/pass" ? 1 : 0, what);
		await assertIdleWindow();
		if (route === "/sw/data") {
			// The viewer is no page that can be asked: the worker is still there, and the next load ends the same way.
			assert.deepEqual(await loggedSince("job.workers_removed", since), []);
			assert.equal((await job(fx("a", "/sw/data"))).error?.code, "unguarded_response");
		} else {
			// The document the worker made is a page of the site: before its tab went, it was asked to give the worker up.
			assert.deepEqual(await loggedSince("job.workers_removed", since), [{ job: r.job, found: 1, removed: 1 }]);
			// From here on the site is loaded from its server again, and its response passes the guard like any other.
			const again = fx("a", route);
			const fine = await job(again);
			assert.equal(fine.outcome, "ok", JSON.stringify(fine.error));
			assert.match(fine.content.markdown, /bgw-fixture-sw-network/);
			assert.equal(fine.nav.http_status, 200);
			assert.equal(h.fixtures.seen((x) => x.path === route && x.query.n === new URL(again).searchParams.get("n")).length, 1);
			await leaveWorker();
		}
	}
	// What is left from the last round goes with the next page of the site that can be asked.
	const since = Date.now();
	assert.equal((await job(fx("a", "/sw/page"))).error?.code, "unguarded_response");
	assert.deepEqual((await loggedSince("job.workers_removed", since)).map((f) => [f.found, f.removed]), [[1, 1]]);
	const served = await job(fx("a", "/sw/data"));
	assert.equal(served.outcome, "ok", JSON.stringify(served.error));
	assert.match(served.content.markdown, /bgw-fixture-sw-network/, "the address the worker answered with JSON is the server's page again");
	assert.deepEqual(h.downloads(), []);
});

test("service worker: within one job too - a page that installs its worker and then goes where the worker answers", async () => {
	const since = Date.now();
	const r = await job(fx("b", "/sw/register?then=/sw/page"), { wait: { settle_ms: 2500 } });
	assert.deepEqual({ outcome: r.outcome, code: r.error?.code }, { outcome: "error", code: "unguarded_response" }, JSON.stringify(r.error));
	assert.equal(r.content, null);
	assert.deepEqual(await loggedSince("job.workers_removed", since), [{ job: r.job, found: 1, removed: 1 }]);
	assert.equal(h.fixtures.seen((x) => x.host.startsWith("b.localhost") && x.path === "/sw/page" && x.query.via === "register").length, 0, "the worker answered; the server was not asked");
	const fine = await job(fx("b", "/sw/page"));
	assert.equal(fine.outcome, "ok", JSON.stringify(fine.error));
	assert.match(fine.content.markdown, /bgw-fixture-sw-network/);
});

test("service worker: when a job ends, the workers of its page are taken away in the gateway container - and only there", async () => {
	// The operator has the same site open, with the same worker, in their own cookie store.
	const workersBefore = h.fixtures.seen((s) => s.path === "/sw/worker.js").length;
	const op = await h.hook("window.open", { url: fx("b", "/sw/register?operator=1") });
	try {
		await waitFor(() => h.fixtures.seen((s) => s.path === "/sw/worker.js").length > workersBefore, { timeoutMs: 10000, what: "the operator's copy of the worker" });
		/** @returns {Promise<string[]>} the scopes of the workers the operator's page has */
		const theirs = () => h.hook("content.exec", { tabId: op.tabs[0], code: "navigator.serviceWorker.getRegistrations().then((all) => all.map((r) => new URL(r.scope).pathname))" });
		await waitFor(async () => (await theirs()).length === 1, { timeoutMs: 10000, what: "the operator's worker to be registered" });

		const since = Date.now();
		const r = await job(fx("b", "/sw/register"), { wait: { settle_ms: 2500 } });
		assert.equal(r.outcome, "ok", JSON.stringify(r.error));
		assert.match(r.content.markdown, /active/, "the page had its worker while it was read");
		assert.deepEqual(await loggedSince("job.workers_removed", since), [{ job: r.job, found: 1, removed: 1 }]);
		await assertIdleWindow();

		// The next jobs of that site are answered by its server, whatever the worker would have made of them.
		for (const route of ["/sw/page", "/sw/pass", "/sw/download", "/sw/slow-download"]) {
			const url = fx("b", route);
			const next = await job(url);
			assert.equal(next.outcome, "ok", `${route}: ${JSON.stringify(next.error)}`);
			assert.match(next.content.markdown, /bgw-fixture-sw-network/, route);
			assert.equal(h.fixtures.seen((x) => x.path === route && x.query.n === new URL(url).searchParams.get("n")).length, 1, route);
		}
		assert.deepEqual(h.downloads(), [], "no download: the worker that answers with one is gone");
		assert.deepEqual(await downloadList(), []);
		// A page without workers: asked, and nothing to write down.
		const quiet = Date.now();
		assert.equal((await job(fx("b", "/plain"))).outcome, "ok");
		assert.deepEqual(await loggedSince("job.workers_removed", quiet), []);

		// The operator's worker was never touched: it is theirs, in their store.
		assert.deepEqual(await theirs(), ["/sw/"]);
		assert.equal(await h.hook("content.exec", { tabId: op.tabs[0], code: "navigator.serviceWorker.controller !== null" }), true);
	} finally {
		await h.hook("content.exec", { tabId: op.tabs[0], code: "navigator.serviceWorker.getRegistrations().then((all) => Promise.all(all.map((r) => r.unregister()))).then(() => true)" }).catch(() => {});
		await h.hook("window.close", { windowId: op.id });
	}
});

// ---------------------------------------------------------------- downloads in a burst

/**
 * Give the backstop time to finish with what it caught, then say what is left.
 * @returns {Promise<{ files: string[], list: any[] }>}
 */
async function leftAfterBurst() {
	await waitFor(async () => downloadFiles().length === 0 && (await downloadList()).length === 0, { timeoutMs: 30000, intervalMs: 250, what: "the downloads to be gone" }).catch(() => {});
	// A straggler would show up now.
	await pause(2500);
	return { files: downloadFiles().map((f) => f.name), list: await downloadList() };
}

/** Clear up after a test, whatever it left: the next one starts from an empty directory. */
async function clearDownloads() {
	for (const d of await downloadList()) {
		await h.hook("downloads.act", { id: d.id, action: "cancel" }).catch(() => {});
		await h.hook("downloads.act", { id: d.id, action: "removeFile" }).catch(() => {});
		await h.hook("downloads.act", { id: d.id, action: "erase" }).catch(() => {});
	}
	for (const f of downloadFiles()) fs.rmSync(path.join(h.downloadsDir, f.name), { force: true });
}

test("downloads backstop: 120 downloads started in one go by the page - the job ends as a download and not one file stays", async () => {
	assert.deepEqual(h.downloads(), []);
	assert.deepEqual(await downloadList(), []);
	try {
		// On a site of which the operator has no tab open: see the last test of this group for that case.
		const r = await job(fx("c", "/blob-burst?n=120&name=bgw-burst-top"), { wait: { settle_ms: 1500 } });
		assert.deepEqual({ outcome: r.outcome, code: r.error?.code }, { outcome: "unsupported", code: "download" });
		const left = await leftAfterBurst();
		assert.deepEqual(left.files, [], `${left.files.length} file(s) left in the download directory`);
		assert.deepEqual(left.list.map((d) => ({ url: d.url.slice(0, 40), store: d.cookieStoreId, state: d.state })), [], `${left.list.length} entries left in the browser's list`);
		await assertIdleWindow();
	} finally {
		await clearDownloads();
	}
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok", "the next job runs as usual");
});

test("downloads backstop: 40 downloads, each from a frame that lives for a moment - the job ends as a download and not one file stays", async () => {
	assert.deepEqual(h.downloads(), []);
	assert.deepEqual(await downloadList(), []);
	// Whether the browser starts a download whose frame is about to go is a matter of moments: when it is
	// busy it starts none of the forty, and then there is nothing to end the job for. Whatever it does,
	// nothing may be left; and within three rounds it does save, and the job ends for it.
	let saved = 0;
	try {
		for (let round = 1; round <= 3 && saved === 0; round++) {
			const began = Date.now();
			const r = await job(fx("c", "/blob-burst?n=40&frames=1&name=bgw-burst-frame"), { wait: { settle_ms: 1500 } });
			const left = await leftAfterBurst();
			assert.deepEqual(left.files, [], `round ${round}: ${left.files.length} file(s) left in the download directory`);
			assert.deepEqual(left.list.map((d) => ({ url: d.url.slice(0, 40), store: d.cookieStoreId, state: d.state })), [], `round ${round}: ${left.list.length} entries left in the browser's list`);
			if ((await removedLog(began)).length === 0) {
				assert.equal(r.outcome, "ok", `round ${round}: nothing was saved, so the page is a page: ${JSON.stringify(r.error)}`);
				continue;
			}
			saved += 1;
			assert.deepEqual({ outcome: r.outcome, code: r.error?.code }, { outcome: "unsupported", code: "download" }, `round ${round}`);
		}
		assert.ok(saved > 0, "in three rounds the browser started none of the downloads");
		await assertIdleWindow();
	} finally {
		await clearDownloads();
	}
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok", "the next job runs as usual");
});

test("downloads backstop: the operator's own blob download from another site, in the middle of a job's burst, is left alone", async () => {
	assert.deepEqual(h.downloads(), []);
	const began = Date.now();
	/** @type {{ id: number } | null} */
	let op = null;
	try {
		// A job whose page saves from frames (some of which the browser files under the default store) and
		// once from the page itself ...
		const pending = job(fx("c", "/blob-burst?n=40&frames=1&top=1&name=bgw-burst-mixed"), { wait: { settle_ms: 1500 } });
		// ... and at the same time the operator saves a blob of their own from a page of another site.
		op = await h.hook("window.open", { url: fx("b", "/blob-download?name=bgw-operator-own") });
		const r = await pending;
		assert.deepEqual({ outcome: r.outcome, code: r.error?.code }, { outcome: "unsupported", code: "download" });
		await waitFor(() => h.downloads().includes("bgw-operator-own.bin"), { timeoutMs: 10000, what: "the operator's download" });
		await waitFor(async () => downloadFiles().length === 1 && (await downloadList()).length === 1, { timeoutMs: 30000, intervalMs: 250, what: "the job's downloads to be gone" }).catch(() => {});
		await pause(2500);
		assert.deepEqual(h.downloads(), ["bgw-operator-own.bin"], "the operator's file and nothing of the job's");
		assert.equal(fs.readFileSync(path.join(h.downloadsDir, "bgw-operator-own.bin"), "utf8"), "bgw fixture blob");
		const list = await downloadList();
		assert.equal(list.length, 1);
		assert.deepEqual({ origin: list[0].url.slice(0, `blob:${h.fixtures.url("b", "/")}`.length), store: list[0].cookieStoreId, state: list[0].state, exists: list[0].exists }, { origin: `blob:${h.fixtures.url("b", "/")}`, store: "firefox-default", state: "complete", exists: true });
		// The job's were told by the store the browser named or by where their blobs came from (which of
		// the two is up to the browser's timing); none was in doubt, and none was given up on.
		const logs = (await h.hook("logs")).filter((/** @type {any} */ l) => l.t >= began);
		assert.ok(logs.filter((/** @type {any} */ l) => l.event === "downloads.removed").length >= 1);
		assert.equal(logs.some((/** @type {any} */ l) => ["downloads.ambiguous", "downloads.not_attributed", "downloads.remove_failed", "downloads.not_cancelled"].includes(l.event)), false);
	} finally {
		if (op !== null) await h.hook("window.close", { windowId: op.id }).catch(() => {});
		await clearDownloads();
	}
});

test("downloads backstop: the operator has the job's site open - a blob nobody can tell the owner of is not touched, and the job fails", async () => {
	assert.deepEqual(h.downloads(), []);
	const began = Date.now();
	// The operator is on the very site the job will load, and saves a blob there.
	const op = await h.hook("window.open", { url: fx("d", "/blob-download?name=bgw-operator-same") });
	try {
		await waitFor(() => h.downloads().includes("bgw-operator-same.bin"), { timeoutMs: 10000, what: "the operator's download" });
		const operatorsId = (await downloadList()).map((d) => d.id);
		assert.equal(operatorsId.length, 1);
		const r = await job(fx("d", "/blob-burst?n=40&frames=1&top=1&name=bgw-burst-doubt"), { wait: { settle_ms: 1500 } });
		// The job ends, and says why. Which of the two reasons depends on what the browser reported first: a
		// download it filed under the container (the job's for certain), or one it filed under the default
		// store (the job's or the operator's - nobody can tell).
		assert.equal(r.outcome === "ok", false, "a job whose page saves files does not end ok");
		assert.ok(["download_ambiguous", "download"].includes(r.error?.code), JSON.stringify(r.error));
		assert.equal(r.content, null);
		await pause(3000);
		// Whatever happened to the job's files: the operator's own is there, whole.
		assert.ok(h.downloads().includes("bgw-operator-same.bin"), "the operator's file is there");
		assert.equal(fs.readFileSync(path.join(h.downloadsDir, "bgw-operator-same.bin"), "utf8"), "bgw fixture blob");
		const list = await downloadList();
		const logs = (await h.hook("logs")).filter((/** @type {any} */ l) => l.t >= began);
		// Nothing was taken for the job's by where its blob came from: the operator has that site open.
		assert.equal(logs.some((/** @type {any} */ l) => l.event === "downloads.attributed" && l.fields.by === "origin"), false);
		// What is left is what the browser filed under the default store, complete and untouched; each such
		// download of the job's was said to be in doubt.
		assert.ok(list.every((d) => d.cookieStoreId === "firefox-default" && d.state === "complete" && d.exists === true), JSON.stringify(list.map((d) => [d.cookieStoreId, d.state, d.exists])));
		const inDoubt = logs.filter((/** @type {any} */ l) => l.event === "downloads.ambiguous").length;
		assert.ok(inDoubt >= list.length - 1, `${list.length - 1} of the job's files left, ${inDoubt} said to be in doubt`);
		// The operator's own began before the job came to the site: that one was never in doubt, so a job
		// that ended in doubt did so over a download of its own, which is still there.
		assert.ok(list.some((d) => d.id === operatorsId[0]));
		if (r.error?.code === "download_ambiguous") assert.ok(inDoubt >= 1 && list.length >= 2, `${inDoubt} in doubt, ${list.length} entries`);
		// The tab went at the first of them: far fewer than forty were saved.
		assert.ok(list.length < 30, `${list.length} entries`);
		await assertIdleWindow();
	} finally {
		await h.hook("window.close", { windowId: op.id }).catch(() => {});
		await clearDownloads();
	}
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok", "the next job runs as usual");
});

// ---------------------------------------------------------------- guard by cookie store

test("guard by cookie store: a service worker reaches no private address, and nothing at all outside a job", async () => {
	const priv = h.fixtures.forbiddenUrl("/pixel?via=sw-private");
	const byName = `http://${LOOPBACK_NAME}:${h.fixtures.port}/pixel?via=sw-dns`;
	const pub = h.fixtures.url("b", "/pixel?via=sw-public");
	/** @param {number} from @param {number} to @returns {number} worker requests to the public target that arrived in that time */
	const arrived = (from, to) => h.fixtures.seen((s) => s.query.via === "sw-public" && s.t >= from && s.t <= to).length;
	const droppedBefore = (await h.hook("guard.stats")).dropped;

	// The worker fetches all three targets five times a second, for twelve seconds, page or no page.
	// When a job ends, the workers of its page are taken away, if the page can be asked. This test is about a
	// worker that stays: its page goes, once the worker is active, to where another worker of the site answers
	// with JSON - the job ends there, and the browser's viewer in its tab is no page that can be asked.
	await leaveWorker();
	const t0 = Date.now();
	const r = await job(fx("a", `/swnet/register?targets=${encodeURIComponent(JSON.stringify([priv, pub, byName]))}&ms=12000&then=/sw/data&after=1500`), { wait: { settle_ms: 3000 } });
	const t1 = Date.now();
	assert.deepEqual({ outcome: r.outcome, code: r.error?.code }, { outcome: "error", code: "unguarded_response" }, JSON.stringify(r.error));
	// While the job ran, its requests to the public target went out (no tab stands behind them).
	assert.ok(arrived(t0, t1) >= 2, `during the job: ${arrived(t0, t1)}`);

	// The job is over and its tab closed; the worker is still at it. Nothing arrives.
	await pause(2500);
	const t2 = Date.now();
	assert.equal(arrived(t1 + 1, t2), 0, "no request of the worker left the browser between jobs");

	// It was running all along: during the next job its requests pass again.
	assert.equal((await job(fx("b", "/slow?ms=1500&during=swnet"))).outcome, "ok");
	const t3 = Date.now();
	assert.ok(arrived(t2, t3) >= 2, `during the second job: ${arrived(t2, t3)} - the worker is alive, so the silence before was the guard's doing`);
	await pause(1500);
	assert.equal(arrived(t3 + 1, Date.now()), 0, "and none after it");

	// Not once, at any time: the private address, by literal or by a name that resolves to it.
	assert.deepEqual(h.fixtures.seen((s) => s.listener === "forbidden"), []);
	assert.deepEqual(h.fixtures.seen((s) => s.query.via === "sw-private"), []);
	assert.deepEqual(h.fixtures.seen((s) => s.query.via === "sw-dns"), []);
	const stats = await h.hook("guard.stats");
	assert.equal(stats.running, false);
	assert.ok(stats.dropped - droppedBefore >= 20, `requests cancelled between and after the jobs: ${stats.dropped - droppedBefore}`);
	await assertIdleWindow();
});

test("a page cannot fetch from a name that resolves to a private address either", async () => {
	const img = (/** @type {string} */ via) => `http://${LOOPBACK_NAME}:${h.fixtures.port}/pixel?via=${via}`;
	const r = await job(fx("a", `/subresource?src=${encodeURIComponent(img("img-dns"))}`), { wait: { settle_ms: 500 } });
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.match(r.content.markdown, /bgw-fixture-subresource-marker/);
	assert.deepEqual(h.fixtures.seen((s) => s.query.via === "img-dns"), []);
	// The control: the same page in the operator's own tab does fetch it. That is theirs to do.
	const opened = await h.hook("window.open", { url: fx("a", `/subresource?src=${encodeURIComponent(img("img-dns-operator"))}`) });
	await waitFor(() => h.fixtures.seen((s) => s.query.via === "img-dns-operator").length === 1, { timeoutMs: 10000, what: "the operator's image" });
	await h.hook("window.close", { windowId: opened.id });
});

// ---------------------------------------------------------------- guard scope

/** @returns {Promise<{ wide: boolean, calls: { tab: number, tabless: number, window: number, wide: number }, outside: number, dropped: number, running: boolean }>} */
const guardStats = () => h.hook("guard.stats");
// Every way the sink page has of making a request that a tab stands behind.
// The last five come from frames that have no address of their own: srcdoc, sandboxed, data: and blank ones.
const SINK_TAB = ["img", "redirimg", "frame", "frameimg", "script", "css", "cssimport", "cssbg", "preload", "favicon", "media", "object", "fetch", "xhr", "beacon", "es", "ws", "workerfetch", "workerxhr", "workerimport", "srcdocimg", "sandboximg", "sandboxfetch", "dataimg", "blankimg"];
// ... and those no tab stands behind: the shared worker's.
const SINK_TABLESS = ["sharedfetch", "sharedxhr", "sharedimport"];
/** @param {string} tag @param {string[]} ways @returns {string[]} the ways whose request has not arrived */
const missing = (tag, ways) => ways.filter((way) => h.fixtures.seen((s) => s.query.via === `${tag}-${way}`).length === 0);

test("guard scope: pages in the operator's own tabs pass through no blocking listener of the guard", async () => {
	const base = h.fixtures.url("b", "/").slice(0, -1);
	/**
	 * What the guard heard of requests that were not the gateway's. (Requests without a tab in the gateway
	 * container - a worker that an earlier job left behind - are heard by the tab-less listener all along;
	 * those are counted as cancelled, not as someone else's.)
	 */
	const heard = async () => {
		const s = await guardStats();
		return { tab: s.calls.tab, window: s.calls.window, wide: s.calls.wide, outside: s.outside };
	};
	const stats = await guardStats();
	assert.equal(stats.wide, false, "the listeners are narrowed to job tabs, the gateway window and requests without a tab");
	assert.equal(stats.calls.wide, 0);
	assert.ok(stats.calls.tab > 100, "they were at work for the jobs so far");
	const before = stats;
	// The extension's own dial to the daemon is a request without a tab: the listener for those heard it,
	// which is how the guard knows that the filter works in this browser.
	assert.ok(before.calls.tabless >= 2 && before.outside >= 2, JSON.stringify(before));

	// Two pages that make requests in every way there is, in ordinary tabs of the default store.
	const opened = await h.hook("window.open", { url: fx("a", `/sink?base=${encodeURIComponent(base)}&tag=opq&shared=0`) });
	const second = await h.hook("window.open", { url: fx("b", `/sink?base=${encodeURIComponent(h.fixtures.url("a", "/").slice(0, -1))}&tag=opr&shared=0`) });
	/** @type {{ id: number } | null} */
	let third = null;
	try {
		await waitFor(() => missing("opq", SINK_TAB).length === 0 && missing("opr", SINK_TAB).length === 0, { timeoutMs: 20000, what: `the pages' requests to arrive; missing: ${missing("opq", SINK_TAB)} / ${missing("opr", SINK_TAB)}` });
		await pause(800);
		const after = await heard();
		assert.deepEqual(after, { tab: before.calls.tab, window: before.calls.window, wide: 0, outside: before.outside }, "not one call of a blocking listener for any of it");
		assert.ok(h.fixtures.seen((s) => /^op[qr]-/.test(s.query.via ?? "")).length >= 50, "while the browser made all those requests");

		// What is left, and why: a request no tab stands behind cannot be told from a service worker's of
		// the gateway container by any request filter, only by its cookie store. The operator's own shared
		// worker makes such requests; each passes through the one tab-less listener and is waved on.
		third = await h.hook("window.open", { url: fx("a", `/sink?base=${encodeURIComponent(base)}&tag=ops`) });
		await waitFor(() => missing("ops", [...SINK_TAB, ...SINK_TABLESS]).length === 0, { timeoutMs: 20000, what: `the third page's requests; missing: ${missing("ops", [...SINK_TAB, ...SINK_TABLESS])}` });
		await pause(800);
		const rest = await heard();
		assert.deepEqual({ tab: rest.tab, window: rest.window, wide: rest.wide }, { tab: after.tab, window: after.window, wide: 0 }, "still nothing of the tabs");
		// The worker's script, its fetch, its XHR and the script it imports: asked about twice each (before
		// the request, at its headers), and each time answered with "not ours".
		const tabless = rest.outside - after.outside;
		assert.ok(tabless >= 4 && tabless <= 16, `${tabless} calls for the operator's requests without a tab`);
		// None of the operator's requests was cancelled: all of them arrived.
		assert.deepEqual(missing("ops", [...SINK_TAB, ...SINK_TABLESS]), []);
	} finally {
		for (const w of [opened, second, third]) {
			if (w !== null) await h.hook("window.close", { windowId: w.id }).catch(() => {});
		}
	}
});

test("guard scope: a job tab's own listeners hear all the tab does - no way a page has reaches a private address", async () => {
	const began = Date.now();
	const before = await guardStats();
	const enc = encodeURIComponent;
	// The control: aimed at an allowed host, every one of the ways does make its request from a job tab.
	const pub = await job(fx("a", `/sink?base=${enc(h.fixtures.url("b", "/").slice(0, -1))}&tag=jobpub`), { wait: { settle_ms: 2500 } });
	assert.equal(pub.outcome, "ok", JSON.stringify(pub.error));
	assert.match(pub.content.markdown, /bgw-fixture-sink-marker/);
	assert.deepEqual(missing("jobpub", [...SINK_TAB, ...SINK_TABLESS]), [], "the control: these requests were made");

	// The same page aimed at a loopback port outside the policy, and at a name that resolves to loopback.
	const priv = await job(fx("a", `/sink?base=${enc(h.fixtures.forbiddenUrl("/").slice(0, -1))}&tag=jobpriv`), { wait: { settle_ms: 2500 } });
	assert.equal(priv.outcome, "ok", JSON.stringify(priv.error));
	assert.match(priv.content.markdown, /bgw-fixture-sink-marker/);
	const named = await job(fx("a", `/sink?base=${enc(`http://${LOOPBACK_NAME}:${h.fixtures.port}`)}&tag=jobdns`), { wait: { settle_ms: 2500 } });
	assert.equal(named.outcome, "ok", JSON.stringify(named.error));
	await pause(500);
	assert.deepEqual(h.fixtures.seen((s) => s.listener === "forbidden").map((s) => s.query.via), [], "nothing arrived at the private port");
	assert.deepEqual(h.fixtures.seen((s) => /^jobpriv-/.test(s.query.via ?? "") && s.path !== "/redirect").map((s) => s.query.via), []);
	assert.deepEqual(h.fixtures.seen((s) => /^jobdns-/.test(s.query.via ?? "") || (s.t >= began && s.host.startsWith(LOOPBACK_NAME))).map((s) => s.query.via), [], "nor by a name that resolves to it");

	const after = await guardStats();
	assert.equal(after.wide, false);
	assert.equal(after.calls.wide, 0);
	assert.ok(after.calls.tab - before.calls.tab >= 90, `the tabs' own listeners decided: ${after.calls.tab - before.calls.tab} calls`);
	// The gateway window's listener hears a job tab too and leaves it to the tab's own.
	assert.ok(after.calls.window - before.calls.window >= 40, `${after.calls.window - before.calls.window} calls of the window's listener`);
	// The shared workers of the three pages: requests without a tab, in the container, under the address rules.
	assert.ok(after.calls.tabless - before.calls.tabless >= 6, `${after.calls.tabless - before.calls.tabless} calls for requests without a tab`);
	assert.equal(after.outside, before.outside, "nothing of the operator's was heard meanwhile");
	await assertIdleWindow();
});

// ---------------------------------------------------------------- what is content

test("a code answer page: question and answers, tags in code as the page shows them, the table as a table", async () => {
	const r = await job(fx("a", "/smoke/qa.html"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	const md = r.content.markdown;
	for (const mark of ["QAQUESTION-MAIN", "QAANSWER-ONE", "QAANSWER-TWO"]) assert.ok(md.includes(mark), mark);
	// Inline code.
	assert.ok(md.includes('`<script src="tracker.js"></script>`'), md.slice(0, 600));
	for (const code of ["`<iframe>`", "`<style>`", "`<script defer>`", '`"<script>"`', "`defer`"]) assert.ok(md.includes(code), code);
	// Code blocks, with their language, to the letter - an HTML comment included.
	const doc = '<!doctype html>\n<html>\n<head>\n  <!-- the tracker -->\n  <style>body { margin: 0 }</style>\n  <script src="tracker.js"></script>\n</head>\n<body>\n  <iframe src="https://video.example.org/embed/42" width="560" height="315"></iframe>\n</body>\n</html>';
	assert.ok(md.includes("```html\n" + doc + "\n```"), md.slice(md.indexOf("```"), md.indexOf("```") + 500));
	assert.ok(md.includes('```html\n<script defer src="tracker.js"></script>\n<iframe loading="lazy" src="https://video.example.org/embed/42"></iframe>\n```'));
	const js = 'window.addEventListener("load", () => {\n  const s = document.createElement("script");\n  s.src = "tracker.js";\n  s.async = true;\n  document.head.appendChild(s);\n  if (a < b && c > d) console.log("<script> injected");\n});';
	assert.ok(md.includes("```js\n" + js + "\n```"));
	assert.match(md, /\| Attribute \| Fetch \| Runs \|\n\| -+ \| -+ \| -+ \|\n\| none \| blocks parsing \| at once \|\n\| async \| in parallel \| as soon as it arrives \|\n\| defer \| in parallel \| after parsing, in order \|/);
	// The visible text has the same samples; the stored document has them as escaped text and no element that runs or loads.
	assert.ok(r.content.text.includes(doc) && r.content.text.includes(js));
	assert.ok(r.content.html.includes('&lt;script src="tracker.js"&gt;&lt;/script&gt;'));
	assert.equal(/<(script|style|iframe|object|embed|form|link|meta|base)\b|\son[a-z]+\s*=/i.test(r.content.html), false);
	assert.equal(r.content.links.some((/** @type {any} */ l) => /video\.example\.org|tracker\.js/.test(l.url)), false, "an address inside a code sample is no link");
	assert.equal(r.page.title, "How do I load a script only after the page has rendered?");
	assert.equal(r.page.site, "Stack Example");
	assert.ok(["article", "full_page"].includes(r.extraction.view), JSON.stringify(r.extraction));
	// Nothing of the page's samples was run or requested by taking them out of it.
	assert.deepEqual(h.fixtures.seen((s) => s.path === "/tracker.js"), []);
});

test("reveal-on-scroll: sections waiting at opacity 0 are content, and the job walks down the page for what is loaded on the way", async () => {
	const shown = ["INTRO", "ONE", "TWO", "THREE", "FOUR", "ANIMATED"];
	const never = ["GONE", "COLOUR", "INSTANT"];
	// As a fetch asks for it: wait.scroll "lazy".
	const r = await job(fx("a", "/smoke/reveal.html"), { wait: { settle_ms: 600, scroll: "lazy" } });
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	for (const name of shown) {
		assert.ok(r.content.markdown.includes(`REVEAL-${name}`), `REVEAL-${name} in the markdown`);
		assert.ok(r.content.text.includes(`REVEAL-${name}`), `REVEAL-${name} in the visible text`);
	}
	const noSource = (/** @type {any} */ c) => JSON.stringify({ ...c, raw_html: null });
	for (const name of never) assert.equal(noSource(r.content).includes(`REVEALHID-${name}`), false, `REVEALHID-${name}`);
	assert.equal(/attacker\.example|urgent instruction/.test(noSource(r.content)), false);
	// The last paragraph only exists once the end of the page came into view.
	assert.match(r.content.markdown, /REVEAL-LAZY This closing paragraph is loaded when the reader scrolls to the end/);
	assert.ok(r.render.scrolled_px >= 2500 && r.render.scrolled_px < 20000, `walked down ${r.render.scrolled_px} px`);
	assert.equal(r.render.settled, true);
	assert.deepEqual({ view: r.extraction.view, removed: r.extraction.hidden_removed, capped: r.extraction.capped }, { view: "article", removed: 3, capped: false });
	assert.equal(r.page.author, "Noor Halvorsen");

	// Without the walk: the sections that are in the page are still content, though no visitor has seen
	// them yet - they wait for a transition or an animation. What the page has not made yet is not there.
	const still = await job(fx("a", "/smoke/reveal.html"), { wait: { settle_ms: 600, scroll: "none" } });
	assert.equal(still.outcome, "ok", JSON.stringify(still.error));
	assert.equal(still.render.scrolled_px, 0);
	for (const name of shown) assert.ok(still.content.markdown.includes(`REVEAL-${name}`), `without scrolling: REVEAL-${name}`);
	for (const name of never) assert.equal(noSource(still.content).includes(`REVEALHID-${name}`), false, `without scrolling: REVEALHID-${name}`);
	assert.equal(still.content.markdown.includes("REVEAL-LAZY"), false);
	const log = await extractionLog(still.job);
	assert.ok(log.fading_kept >= 4, `kept although transparent at that moment: ${log.fading_kept}`);
	assert.equal(log.hidden_removed, 3);
	// The page is back at its top either way, and the tab is gone.
	await assertIdleWindow();
});

test("hidden-text probes: 49 of 51 ways of hiding text are left out, and what merely looks like one stays", async () => {
	const r = await job(fx("a", "/smoke/probes.html"), { wait: { settle_ms: 400 } });
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	const all = `${r.content.markdown}\n${r.content.text}\n${r.content.html}\n${JSON.stringify(r.content.links)}\n${JSON.stringify(r.page)}`;
	// All of them, by name (tests/integration/unseen.test.js lists them).
	const probes = [...new Set([...fs.readFileSync(new URL("../browser-smoke/fixtures/probes.html", import.meta.url), "utf8").matchAll(/PROBEHID-([A-Z0-9]+)/g)].map((m) => m[1]))];
	assert.equal(probes.length, 51);
	const survivors = probes.filter((name) => new RegExp(`PROBEHID-${name}\\b`).test(all)).sort();
	// The two that are left: text under an opaque box laid over it (telling that from a dialog, a banner
	// or a sticky header over ordinary content takes more than styles and one look at a point), and text
	// behind a mask that is a picture.
	assert.deepEqual(survivors, ["MASKURL", "OVERLAY"]);
	for (const name of ["FIXEDRIGHT", "INDENTCLIP", "NESTEDOPACITY", "ALPHALOW", "SCALEPROP", "MARGIN"]) assert.equal(all.includes(`PROBEHIDX-${name}`), false, `PROBEHIDX-${name}`);
	assert.equal((all.match(/attacker\.example/g) ?? []).length, (all.match(/PROBEHID-(OVERLAY|MASKURL)\b/g) ?? []).length, "the injected sentence occurs with those two probes only");
	// Content that shares a property with a hiding place, and is none.
	for (const name of ["PLAIN", "DETAILS", "DETAILSCODE", "TABPANEL", "MENU", "LOWCONTRAST", "GRADIENT", "HERO", "DARKBOX", "PSEUDO", "SLIDEONE", "SLIDEFIVE", "STICKY", "WIDECELL", "FOLDED", "SHADOW", "HALF", "TIP", "SMALL", "HANGING", "PANEL", "ACCORDION", "DRAWER", "DUSK", "END"]) {
		assert.ok(r.content.text.includes(`PROBEVIS-${name}`), `PROBEVIS-${name} in the visible text`);
	}
	assert.ok(r.content.markdown.includes("PROBEVIS-PLAIN") && r.content.markdown.includes("PROBEVIS-END"));
	assert.ok(r.extraction.hidden_removed >= 54, `removed: ${r.extraction.hidden_removed}`);
	// The far-away probe makes the page a hundred thousand pixels long: the walk down it is bounded all the same.
	assert.ok(r.render.scrolled_px > 0 && r.render.scrolled_px < 40000, `scrolled ${r.render.scrolled_px}`);
});

test("a page that changes its address while it is closed leaves no entry in the recently-closed list", async () => {
	const began = Date.now();
	const count = async (/** @type {string} */ event) => (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === event && l.t >= began).length;
	const r = await job(fx("a", "/flip"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.match(r.content.html, /bgw-fixture-flip-marker/);
	const closed = await h.hook("recently.closed");
	assert.deepEqual(closed.filter((/** @type {any} */ c) => /\/flip/.test(c.url ?? "")), [], "neither under its old address nor under the one it gave itself");
	assert.equal(await count("window.closed_tab_forgotten"), 1, "its record was found and removed");
	assert.equal(await count("window.closed_tab_not_forgotten"), 0);
	// The operator's own closed tabs stay in the list: one of theirs, closed right now, is still there after the next job.
	const opened = await h.hook("window.open", { url: fx("a", "/hit?operator=closing") });
	try {
		const theirs = await h.hook("tab.open", { windowId: opened.id, url: fx("a", "/hit?operator=closed-tab") });
		await waitFor(() => h.fixtures.seen((s) => s.query.operator === "closed-tab" && s.finishedAt !== null).length === 1, { timeoutMs: 10000, what: "the operator's tab to load" });
		// Measured in Firefox 156: a tab that is closed in the moment it finished loading leaves no record at all.
		await pause(800);
		await h.hook("tab.close", { tabId: theirs.id });
		await waitFor(async () => (await h.hook("recently.closed")).some((/** @type {any} */ c) => /operator=closed-tab/.test(c.url ?? "")), { timeoutMs: 5000, what: "the operator's closed tab to be in the list" });
		assert.equal((await job(fx("a", "/flip"))).outcome, "ok");
		await pause(1200);
		const list = await h.hook("recently.closed");
		assert.equal(list.filter((/** @type {any} */ c) => /operator=closed-tab/.test(c.url ?? "")).length, 1, "the operator's record is still there");
		assert.deepEqual(list.filter((/** @type {any} */ c) => /\/flip/.test(c.url ?? "")), []);
		assert.equal(await count("window.closed_tab_forgotten"), 2, "one record for each of the two jobs, and no other");
	} finally {
		await h.hook("window.close", { windowId: opened.id }).catch(() => {});
	}
});

test("a plain-text document is returned as text", async () => {
	const r = await job(fx("a", "/text"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.nav.content_type, "text/plain");
	assert.equal(r.page.extractor, "plaintext");
	assert.equal(r.content.markdown, "bgw-fixture-plain-text\nsecond line\n", "as it is, not as Markdown");
	assert.equal(r.content.html, "<pre>bgw-fixture-plain-text\nsecond line\n</pre>");
	assert.deepEqual(r.content.links, []);
	assert.deepEqual({ title: r.page.title, site: r.page.site, words: r.page.word_count }, { title: null, site: "a.localhost", words: 3 });
	assert.deepEqual(r.truncated, { markdown: false, text: false, html: false, raw_html: false });
	assert.deepEqual(r.extraction, { view: "text", coverage_pct: null, hidden_removed: 0, capped: false });
	assert.equal(r.content.text, null);
	// Other things the browser shows in a viewer of its own stay unsupported.
	const json = await job(fx("a", "/json"));
	assert.deepEqual({ outcome: json.outcome, code: json.error.code }, { outcome: "unsupported", code: "content_type_json" });
});

test("401 with a login challenge: auth_required at once, no dialog to hang on", async () => {
	const started = Date.now();
	const r = await job(fx("a", "/auth"));
	assert.equal(r.outcome, "error");
	assert.equal(r.error.code, "auth_required");
	assert.equal(r.nav.http_status, 401);
	assert.ok(Date.now() - started < 5000, "the job did not wait for a dialog");
	await assertIdleWindow();
	// The next job is not held up by anything left behind.
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
});

test("navigation error: one automatic retry, then an honest error", async () => {
	/** @param {string} id job id @returns {Promise<number>} retries the extension logged for it */
	const retries = async (id) => (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === "job.navigation_retry" && l.fields.job === id).length;

	// Both navigation attempts die. Firefox itself re-sends a reset request
	// several times per navigation, so count what one navigation costs.
	const dead = await job(fx("a", "/reset?dead=1"));
	assert.equal(dead.outcome, "error");
	assert.equal(dead.error.code, "navigation_failed");
	assert.equal(dead.error.retryable, true);
	assert.equal(await retries(dead.job), 1, "retried once, not more");
	const perNavigation = h.fixtures.seen((s) => s.query.dead === "1").length / 2;
	assert.ok(Number.isInteger(perNavigation) && perNavigation >= 1, `requests per navigation: ${perNavigation}`);
	await assertIdleWindow();

	// The whole first navigation dies, the retry gets the page.
	const flaky = await job(fx("a", `/flaky?id=${Date.now()}&fail=${perNavigation}`));
	assert.equal(flaky.outcome, "ok", JSON.stringify(flaky.error));
	assert.match(flaky.content.html, /bgw-fixture-flaky-marker/);
	assert.equal(await retries(flaky.job), 1);
	await assertIdleWindow();
});

test("slow page: timeout, and the job tab is gone afterwards", async () => {
	const started = Date.now();
	const r = await job(fx("a", "/slow"), { wait: { timeout_ms: 2000, settle_ms: 0 } });
	assert.equal(r.outcome, "timeout", JSON.stringify(r.error));
	// The extension gives up at the job's own load timeout; the daemon's deadline is the backstop behind it.
	assert.equal(r.error.code, "navigation_timeout");
	assert.equal(r.cookie_scope, "container");
	const took = Date.now() - started;
	assert.ok(took >= 2000 && took < 6000, `took ${took} ms`);
	await assertIdleWindow();
	// Where the page stood is in the add-on's log: the top frame had asked and was not answered, nothing waited
	// for the guard, and the browser called the tab loading. Times and counts only.
	const stalled = (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === "job.navigation_stalled" && l.t >= started);
	assert.equal(stalled.length, 1);
	const f = stalled[0].fields;
	assert.deepEqual(
		{ attempt: f.attempt, tab_status: f.tab_status, committed_ms: f.committed_ms, completed_ms: f.completed_ms, nav_error: f.nav_error, top_load: f.top_load, top_requests: f.top_requests, answers_owed: f.answers_owed, top_answer_owed: f.top_answer_owed, lookups_under_way: f.lookups_under_way, lookups_deadline: f.lookups_deadline },
		{ attempt: 0, tab_status: "loading", committed_ms: -1, completed_ms: -1, nav_error: null, top_load: "asked", top_requests: 1, answers_owed: 0, top_answer_owed: false, lookups_under_way: 0, lookups_deadline: 0 },
	);
	assert.ok(f.started_ms >= 1500 && f.top_asked_ms >= 1500, JSON.stringify(f));
	assert.equal(JSON.stringify(f).includes("localhost"), false, "no address");
	// The same facts are the message of the result, on one line - and that line is what an agent and the command
	// line are shown as the "detail" of the failure, whole: nobody has to open the browser's console for it.
	const LINE = /^stalled try=0 tab=loading nav=\d{4}\/-1\/-1\/-1 top=asked\/1\/0\/\d{4} owed=0\/n\/-1 dns=0\/0\/0\/0\/0\/0\/0 cut=0 file=n dl=n$/;
	assert.match(r.error.message, LINE);
	const shown = renderFailure({ outcome: r.outcome, job: r.job, cookie_scope: r.cookie_scope, http_status: r.nav.http_status, requested_url: r.nav.requested_url, detect: r.detect, error: r.error }).split("\n");
	const detail = shown.filter((line) => line.startsWith("detail: "));
	assert.equal(detail.length, 1, shown.join("\n"));
	assert.match(detail[0].slice("detail: ".length), LINE, "as the add-on wrote it: not cut, nothing taken out");
	assert.equal(shown[0].includes("stalled"), false, "and not in the line the daemon makes itself");
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
});

test("cancel: when the caller goes away the job tab is closed and the slot is free", async () => {
	const controller = new AbortController();
	const pending = h
		.submitJob({ url: fx("a", "/slow?cancel=1"), wait: { timeout_ms: 20000, settle_ms: 0, dwell_ms: 0 } }, { signal: controller.signal })
		.then(
			() => "answered",
			() => "aborted",
		);
	await jobTabOpen();
	await waitFor(() => h.fixtures.seen((s) => s.query.cancel === "1").length === 1, { timeoutMs: 5000, what: "the slow request" });
	controller.abort();
	assert.equal(await pending, "aborted");
	await waitFor(async () => (await windows()).own.jobTabs.length === 0, { timeoutMs: 5000, what: "the job tab to close" });
	await assertIdleWindow();
	assert.equal(daemonLog("job.result_dropped").at(-1)?.reason, "late_after_cancel");
	const started = Date.now();
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
	assert.ok(Date.now() - started < 4000, "the next job did not have to wait for the cancel grace period");
});

test("a job tab closed by someone else: tab_closed, window back to the park tab, not paused", async () => {
	const pending = job(fx("a", "/slow?closed=1"), { wait: { timeout_ms: 20000 } });
	const { tab } = await jobTabOpen();
	await h.hook("tab.close", { tabId: tab.id });
	const r = await pending;
	assert.equal(r.outcome, "error");
	assert.equal(r.error.code, "tab_closed");
	await assertIdleWindow();
	assert.equal((await h.status()).extension.state.paused, false);
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
});

test("a second job queued behind the first runs after it, never beside it", async () => {
	const first = job(fx("a", "/slow?ms=1200&order=first"));
	const second = job(fx("a", "/hit?order=second"));
	const { gw } = await jobTabOpen();
	assert.equal(gw.tabs.length, 2, "one job tab only while two jobs are in the daemon");
	const [r1, r2] = await Promise.all([first, second]);
	assert.equal(r1.outcome, "ok");
	assert.equal(r2.outcome, "ok");
	const a = h.fixtures.seen((s) => s.query.order === "first")[0];
	const b = h.fixtures.seen((s) => s.query.order === "second")[0];
	assert.ok(a.finishedAt !== null && b.t > a.finishedAt, "the second page was requested after the first was done");
	await assertIdleWindow();
});

test("pause: jobs fail fast, a running job is stopped, resume brings it back", async () => {
	const running = job(fx("a", "/slow?paused=1"), { wait: { timeout_ms: 20000 } });
	await jobTabOpen();
	assert.equal((await h.hook("badge")).text, "", "no badge while all is well");
	const st = await h.hook("pause");
	assert.equal(st.paused, true);
	assert.equal((await h.hook("badge")).text, "II");
	const stopped = await running;
	assert.notEqual(stopped.outcome, "ok");
	assert.equal(stopped.error.code, "paused");
	await waitFor(async () => (await h.status()).extension.state.paused === true, { timeoutMs: 3000, what: "the daemon to learn of the pause" });
	assert.equal((await h.status()).extension.state.pause_reason, "operator");
	const started = Date.now();
	const r = await job(fx("a", "/plain"));
	assert.equal(r.outcome, "error");
	assert.equal(r.error.code, "paused");
	assert.ok(Date.now() - started < 1000, "refused at once");
	await assertIdleWindow();
	await h.hook("resume");
	await waitFor(async () => (await h.status()).extension.state.paused === false, { timeoutMs: 3000, what: "the daemon to learn of the resume" });
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
});

test("gateway window closed during a job: tab_closed, paused with window_closed, a new window after resume", async () => {
	const before = await assertIdleWindow();
	const pending = job(fx("a", "/slow?window=1"), { wait: { timeout_ms: 20000 } });
	const { gw } = await jobTabOpen();
	await h.hook("window.close", { windowId: gw.id });
	const r = await pending;
	assert.equal(r.outcome, "error");
	assert.equal(r.error.code, "tab_closed");
	await waitFor(async () => (await h.status()).extension.state.paused === true, { timeoutMs: 3000, what: "the pause" });
	const state = (await h.status()).extension.state;
	assert.equal(state.pause_reason, "window_closed");
	const badge = await h.hook("badge");
	assert.equal(badge.text, "II");
	assert.match(badge.title, /gateway window was closed/);
	assert.equal(state.window.open, false);
	assert.equal((await windows()).windows.filter((w) => w.role === "gateway").length, 0, "the window is not reopened behind the operator's back");
	const refused = await job(fx("a", "/plain"));
	assert.equal(refused.error.code, "paused");

	await h.hook("resume");
	await waitFor(async () => (await h.status()).extension.state.paused === false, { timeoutMs: 3000, what: "the resume" });
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
	const after = await assertIdleWindow();
	assert.notEqual(after.own.windowId, before.own.windowId);
	await waitFor(async () => (await h.status()).extension.state.window.open === true, { timeoutMs: 3000, what: "the daemon to learn of the new window" });
});

test("startup sweep: an extra gateway window is closed", async () => {
	const before = await assertIdleWindow();
	// Recognised by its park tab alone, as after a session restore that lost the tag.
	const extra = await h.hook("window.open", { url: "park" });
	await waitFor(async () => (await windows()).windows.some((w) => w.id === extra.id && /park\.html$/.test(w.tabs[0]?.url ?? "")), { timeoutMs: 5000, what: "the lookalike window" });
	const report = await h.hook("sweep");
	assert.deepEqual(report, { adopted: false, closedWindows: 1, closedTabs: 0, disowned: 0 });
	const after = await assertIdleWindow();
	assert.equal(after.own.windowId, before.own.windowId);
	assert.equal(after.windows.some((w) => w.id === extra.id), false);
});

test("startup sweep: a leftover window is adopted, its leftover job tab closed, a second leftover closed", async () => {
	const before = await assertIdleWindow();
	// Lose the current window the quiet way (no job is running, so no pause).
	await h.hook("window.close", { windowId: before.own.windowId });
	await waitFor(async () => (await windows()).own.windowId === null, { timeoutMs: 5000, what: "the window to be gone" });
	await waitFor(async () => (await h.status()).extension.state.window.open === false, { timeoutMs: 3000, what: "the daemon to learn of it" });
	assert.equal((await h.status()).extension.state.paused, false);

	// Two windows as a restored session would bring them back: one tagged,
	// with a job tab that was open when the browser went down; one more.
	const first = await h.hook("window.open", { url: "park" });
	await h.hook("window.tag", { windowId: first.id, role: "gateway" });
	const stale = await h.hook("tab.open", { windowId: first.id, url: fx("a", "/hit?stale=1") });
	await h.hook("tab.tag", { tabId: stale.id, role: "job" });
	const second = await h.hook("window.open", { url: "park" });
	await waitFor(async () => (await windows()).windows.filter((w) => w.tabs.some((/** @type {any} */ t) => /park\.html$/.test(t.url ?? ""))).length === 2, {
		timeoutMs: 5000,
		what: "both leftover windows",
	});

	const report = await h.hook("sweep");
	assert.deepEqual(report, { adopted: true, closedWindows: 1, closedTabs: 1, disowned: 0 });
	const after = await assertIdleWindow();
	assert.ok([first.id, second.id].includes(after.own.windowId), "one of the leftovers is the gateway window now");
	await waitFor(async () => (await h.status()).extension.state.window.open === true, { timeoutMs: 3000, what: "the daemon to learn of the adopted window" });

	// The next job runs in the adopted window; none is created.
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
	assert.equal((await assertIdleWindow()).own.windowId, after.own.windowId);
});

test("a gateway window the operator put a tab into is left to them; jobs get a clean one", async () => {
	const before = await assertIdleWindow();
	const theirs = await h.hook("tab.open", { windowId: before.own.windowId, url: fx("a", "/hit?theirs=1") });
	await waitFor(() => h.fixtures.seen((s) => s.query.theirs === "1" && s.finishedAt !== null).length === 1, { timeoutMs: 5000, what: "the operator's tab to load" });

	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
	const after = await assertIdleWindow();
	assert.notEqual(after.own.windowId, before.own.windowId, "a clean window was made");
	// The old window is an ordinary window now: their tab, nothing of ours.
	const old = after.windows.find((w) => w.id === before.own.windowId);
	assert.ok(old, "the window with the operator's tab is still open");
	assert.equal(old.role, null);
	assert.deepEqual(old.tabs.map((/** @type {any} */ t) => t.id), [theirs.id]);
	assert.match(old.tabs[0].url, /theirs=1/);
	await h.hook("window.close", { windowId: old.id });
});

// Add-ons that keep sites in containers of their own (Multi-Account Containers, Facebook Container, Temporary
// Containers) cancel a navigation and open its address again in a new tab of their container, next to the tab they
// took it from. None of them is installed here; what they do to the browser is done through the test hook: while
// the job tab waits for its page, a tab of another container is made in the gateway window for an address.
test("a tab somebody else makes in the gateway window while a job tab waits for its page loads nothing and is closed; the job ends as reassigned_by_addon and the window stays the gateway's", async () => {
	const began = Date.now();
	const before = await assertIdleWindow();
	const other = await h.hook("identity.create", { name: "bgw-test-assigned" });
	assert.notEqual(other.cookieStoreId, before.containerId);
	const logs = async (/** @type {string} */ event) => (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === event && l.t >= began);
	const rounds = 5;
	for (let round = 0; round < rounds; round++) {
		// The server holds the answer back: the top frame of the job tab has asked and has no answer.
		const url = fx("a", "/slow?ms=4000");
		const n = new URL(url).searchParams.get("n");
		const pending = job(url);
		await waitFor(() => h.fixtures.seen((s) => s.path === "/slow" && s.query.n === n).length === 1, { timeoutMs: 10000, intervalMs: 20, what: "the job tab to ask for its page" });
		const via = `reopened-${round}`;
		const reopened = await h.hook("tab.open", { windowId: before.own.windowId, url: fx("a", `/hit?via=${via}`), cookieStoreId: other.cookieStoreId });
		const r = await pending;
		assert.deepEqual([r.outcome, r.error?.code, r.error?.retryable], ["error", "reassigned_by_addon", false], JSON.stringify(r.error));
		assert.equal(r.content, null);
		await waitFor(async () => !(await windows()).windows.flatMap((w) => w.tabs).some((/** @type {any} */ t) => t.id === reopened.id), { timeoutMs: 5000, what: "the tab to be closed" });
		// Time for a request that was on its way to arrive, had one got out.
		await pause(500);
		assert.deepEqual(h.fixtures.seen((s) => s.query.via === via), [], "its address was never asked for");
		const after = await assertIdleWindow();
		assert.equal(after.own.windowId, before.own.windowId, "the same gateway window, with its park tab and nothing else");
	}
	assert.equal((await logs("guard.foreign_tab_sealed")).length, rounds);
	assert.deepEqual((await logs("window.foreign_tab")).map((/** @type {any} */ l) => l.fields), Array.from({ length: rounds }, () => ({ outcome: "closed", took_over: true })));
	assert.deepEqual(await logs("window.disowned"), [], "the window was not given up for it");
	assert.deepEqual(await logs("job.crashed"), []);
	// The next job runs as ever, in that window.
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
	assert.equal((await assertIdleWindow()).own.windowId, before.own.windowId);
});

test("while a job tab is open the operator's own new tabs are not touched: in their own window they load and stay, in any container", async () => {
	const began = Date.now();
	const before = await assertIdleWindow();
	const other = (await h.hook("identity.list")).find((/** @type {any} */ i) => i.name === "bgw-test-assigned");
	assert.ok(other, "the container of the test before");
	const opened = await h.hook("window.open", { url: fx("a", "/hit?operator=own-window") });
	try {
		const url = fx("a", "/slow?ms=2500");
		const n = new URL(url).searchParams.get("n");
		const pending = job(url);
		await waitFor(() => h.fixtures.seen((s) => s.path === "/slow" && s.query.n === n).length === 1, { timeoutMs: 10000, intervalMs: 20, what: "the job tab to ask for its page" });
		const plain = await h.hook("tab.open", { windowId: opened.id, url: fx("a", "/hit?operator=during-job") });
		const contained = await h.hook("tab.open", { windowId: opened.id, url: fx("a", "/hit?operator=during-job-container"), cookieStoreId: other.cookieStoreId });
		const r = await pending;
		assert.equal(r.outcome, "ok", JSON.stringify(r.error));
		assert.match(r.content.html, /bgw-fixture-slow-marker/);
		await waitFor(() => h.fixtures.seen((s) => /^during-job/.test(s.query.operator ?? "") && s.finishedAt !== null).length === 2, { timeoutMs: 10000, what: "both tabs of the operator to load" });
		const snap = await windows();
		const theirs = snap.windows.find((w) => w.id === opened.id);
		assert.ok(theirs, "their window is open");
		assert.deepEqual(theirs.tabs.map((/** @type {any} */ t) => t.id).slice(-2), [plain.id, contained.id], "and holds both tabs");
		assert.equal(snap.own.windowId, before.own.windowId);
		const sealed = (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === "guard.foreign_tab_sealed" && l.t >= began);
		assert.deepEqual(sealed, [], "nothing of the operator's was taken for a tab to close");
	} finally {
		await h.hook("window.close", { windowId: opened.id }).catch(() => {});
	}
	await assertIdleWindow();
});

// The request guard asks the browser's resolver before every request it lets through. The fixtures of this
// suite are loopback addresses that are never resolved, so the cost of asking is measured by itself: the same
// question, answered by the browser without the network, as often as a large page has requests.
test("asking the browser's resolver for every request is cheap: 300 questions for a name it knows", async (t) => {
	const once = await h.hook("dns.time", { host: LOOPBACK_NAME, count: 1 });
	assert.equal(once.failed, 0, "the name resolves");
	const serial = await h.hook("dns.time", { host: LOOPBACK_NAME, count: 300 });
	const together = await h.hook("dns.time", { host: LOOPBACK_NAME, count: 300, together: true });
	t.diagnostic(`300 lookups one after the other: ${Math.round(serial.ms)} ms (${(serial.ms / 300).toFixed(2)} ms each); 300 at once: ${Math.round(together.ms)} ms`);
	assert.deepEqual([serial.failed, together.failed], [0, 0]);
	// A generous bound, for a busy machine: one question is a round trip inside the browser.
	assert.ok(serial.ms < 6000 && together.ms < 6000, `${serial.ms} ms and ${together.ms} ms`);
});

test("clearing the container removes its cookies and gives jobs a fresh one", async () => {
	const site = h.fixtures.url("a", "/");
	assert.equal((await job(fx("a", "/cookie/set?name=bgw_clear&value=c1"))).outcome, "ok");
	const old = (await windows()).containerId;
	assert.ok((await h.hook("cookies.get", { url: site, storeId: old })).some((/** @type {any} */ c) => c.name === "bgw_clear"));
	const fresh = await h.hook("container.clear");
	assert.match(fresh, /^firefox-container-\d+$/);
	assert.notEqual(fresh, old);
	await waitFor(async () => (await h.status()).extension.state.container.ready === true, { timeoutMs: 3000, what: "the container to be ready again" });
	const r = await job(fx("a", "/cookie/echo?step=cleared"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.deepEqual(h.fixtures.seen((s) => s.query.step === "cleared")[0].cookies, {});
	assert.equal((await windows()).containerId, fresh);
	await assertIdleWindow();
});

test("pair mode end to end: one-time code, derived key stored, later connections use it", async () => {
	const keyFile = path.join(h.daemon.configDir, "ext.key");
	const keyBefore = fs.readFileSync(keyFile, "utf8");

	// A code the daemon never issued is refused and changes nothing.
	const bogus = await h.hook("pair", { code: `bgw1.${h.daemonPort}.${"A".repeat(43)}` });
	assert.equal(bogus.ok, false);
	assert.match(bogus.error, /did not prove that it knows this code|rejected the code/);
	await h.connected(15000);
	assert.equal(fs.readFileSync(keyFile, "utf8"), keyBefore);

	const code = await h.pairCode();
	const paired = await h.hook("pair", { code });
	assert.deepEqual(paired, { ok: true });
	await h.connected(10000);
	assert.equal(daemonLog("ext.connected").at(-1).mode, "pair");
	const keyAfter = fs.readFileSync(keyFile, "utf8");
	assert.notEqual(keyAfter, keyBefore, "the daemon stored the derived key");
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");

	// The code is used up.
	const again = await h.hook("pair", { code });
	assert.equal(again.ok, false);
	await h.connected(15000);

	// A fresh connection authenticates with the key the extension derived and stored.
	await h.hook("reconnect");
	await waitFor(() => daemonLog("ext.connected").at(-1).mode === "auth", { timeoutMs: 10000, what: "a reconnect in auth mode" });
	await h.connected(10000);
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
	assert.equal(fs.readFileSync(keyFile, "utf8"), keyAfter);
});

/**
 * @param {"options" | "popup"} page
 * @param {string[]} ids
 * @returns {Promise<Record<string, string | null>>} text (or field value) of elements of an open extension page
 */
const ui = (page, ids) => h.hook("ui.read", { page, ids });

test("toolbar popup: shows the state and holds the pause switch", async () => {
	const opened = await h.hook("ui.open", { page: "popup" });
	try {
		await waitFor(async () => /^connected/.test((await ui("popup", ["link"]).catch(() => ({ link: "" }))).link ?? ""), { timeoutMs: 10000, what: "the popup to show the link" });
		assert.deepEqual(await ui("popup", ["version", "link", "paused", "job", "pause"]), {
			version: "v0.1.9",
			link: `connected (port ${h.daemonPort})`,
			paused: "running",
			job: "-",
			pause: "Pause",
		});
		await h.hook("ui.click", { page: "popup", id: "pause" });
		await waitFor(async () => (await h.status()).extension.state.paused === true, { timeoutMs: 5000, what: "the pause to reach the daemon" });
		await waitFor(async () => (await ui("popup", ["pause"])).pause === "Resume", { timeoutMs: 5000, what: "the popup to show the pause" });
		assert.equal((await ui("popup", ["paused"])).paused, "paused");
		assert.equal((await job(fx("a", "/plain"))).error.code, "paused");
		await h.hook("ui.click", { page: "popup", id: "pause" });
		await waitFor(async () => (await h.status()).extension.state.paused === false, { timeoutMs: 5000, what: "the resume to reach the daemon" });
		// The running job's host is shown while it runs.
		const pending = job(fx("a", "/slow?ms=2500&popup=1"));
		await waitFor(async () => (await ui("popup", ["job"])).job === "a.localhost", { timeoutMs: 5000, what: "the popup to show the job" });
		assert.equal((await pending).outcome, "ok");
	} finally {
		await h.hook("window.close", { windowId: opened.windowId });
	}
});

test("options page: shows the state, forgets the pairing, pairs again with a pasted code", async () => {
	const opened = await h.hook("ui.open", { page: "options" });
	const page = "options";
	try {
		await waitFor(async () => (await ui(page, ["paired"]).catch(() => ({ paired: "" }))).paired === "yes", { timeoutMs: 10000, what: "the options page to show the state" });
		assert.deepEqual(await ui(page, ["version", "paired", "link", "error", "port"]), {
			version: "v0.1.9",
			paired: "yes",
			link: `connected on port ${h.daemonPort}`,
			error: "-",
			port: String(h.daemonPort),
		});

		await h.hook("ui.click", { page, id: "forget" });
		await waitFor(async () => (await ui(page, ["paired"])).paired === "no", { timeoutMs: 5000, what: "the page to show that the key is gone" });
		await waitFor(async () => (await h.status()).extension.connected === false, { timeoutMs: 5000, what: "the link to drop" });
		assert.equal((await ui(page, ["link"])).link, "not paired");
		assert.equal((await h.hook("badge")).text, "pair");
		const st = await h.hook("status");
		assert.equal(st.link.phase, "unpaired");
		// Nothing is dialled without a key.
		const refusedBefore = daemonLog("ext.upgrade_refused").length + daemonLog("ext.auth_failed").length + daemonLog("ext.connected").length;
		await new Promise((resolve) => setTimeout(resolve, 1500));
		assert.equal(daemonLog("ext.upgrade_refused").length + daemonLog("ext.auth_failed").length + daemonLog("ext.connected").length, refusedBefore);

		// Something that is not a code.
		await h.hook("ui.set", { page, id: "code", value: "bgw1.1.tooshort" });
		await h.hook("ui.click", { page, id: "pair" });
		await waitFor(async () => /not a pairing code/.test((await ui(page, ["pair-result"]))["pair-result"] ?? ""), { timeoutMs: 5000, what: "the refusal of a malformed code" });

		// A real one, pasted with the whitespace a terminal adds.
		const code = await h.pairCode();
		await h.hook("ui.set", { page, id: "code", value: `  ${code}\n` });
		await h.hook("ui.click", { page, id: "pair" });
		assert.equal((await ui(page, ["code"])).code, "", "the code does not stay in the field");
		await waitFor(async () => (await ui(page, ["pair-result"]))["pair-result"] === "Paired. The extension is connected.", { timeoutMs: 10000, what: "the pairing to finish" });
		await h.connected(10000);
		assert.equal(daemonLog("ext.connected").at(-1).mode, "pair");
		await waitFor(async () => (await ui(page, ["paired"])).paired === "yes", { timeoutMs: 5000, what: "the page to show the new pairing" });
		assert.equal((await job(fx("a", "/plain"))).outcome, "ok");

		// The port field: a bad value is refused, a good one saved (and the link comes back).
		await h.hook("ui.set", { page, id: "port", value: "0" });
		await h.hook("ui.click", { page, id: "save-port" });
		await waitFor(async () => /1 to 65535/.test((await ui(page, ["port-result"]))["port-result"] ?? ""), { timeoutMs: 5000, what: "the refusal of port 0" });
		await h.hook("ui.set", { page, id: "port", value: String(h.daemonPort) });
		await h.hook("ui.click", { page, id: "save-port" });
		await waitFor(async () => (await ui(page, ["port-result"]))["port-result"] === "Saved.", { timeoutMs: 5000, what: "the port to be saved" });
		await h.connected(15000);
		assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
	} finally {
		await h.hook("window.close", { windowId: opened.windowId });
	}
});

test("nothing secret reaches the extension's console", async () => {
	const out = h.browserLog();
	assert.match(out, /\[bgw\]/, "the console output is being captured");
	const key = fs.readFileSync(path.join(h.daemon.configDir, "ext.key"), "utf8").trim();
	const client = fs.readFileSync(path.join(h.daemon.configDir, "client.token"), "utf8").trim();
	const admin = fs.readFileSync(path.join(h.daemon.configDir, "admin.token"), "utf8").trim();
	for (const secret of [key, client, admin, h.presharedKey]) assert.equal(out.includes(secret), false);
	assert.equal(/bgw1\.[0-9]+\.[A-Za-z0-9_-]{43}/.test(out), false, "no pairing code");
	// The log lines that are there name events, hosts and codes only.
	assert.match(out, /"link\.ready"/);
	assert.match(out, /"job\.done"/);
});

test("daemon restart: the extension reconnects and a new job works", async () => {
	await h.stopDaemon();
	await waitFor(async () => (await h.hook("status")).link.phase !== "ready", { timeoutMs: 5000, what: "the extension to notice" });
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.equal((await h.hook("status")).link.phase, "waiting");
	const badge = await h.hook("badge");
	assert.equal(badge.text, "off");
	assert.match(badge.title, /not connected/);
	await h.restartDaemon();
	await h.connected(40000);
	const r = await job(fx("a", "/plain"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	await assertIdleWindow();
	assert.equal((await h.hook("badge")).text, "");
});

test("a squatter on the daemon's port: 'daemon not verified', the key is kept, the real daemon is taken back unpaired", async () => {
	const keyFile = path.join(h.daemon.configDir, "ext.key");
	const keyBefore = fs.readFileSync(keyFile, "utf8");
	await h.stopDaemon();
	// Something else takes the port. It answers every hello with one of the
	// close codes that used to mean "pair again", and proves nothing.
	const codes = [4001, 4004, 4003];
	/** @type {Record<string, unknown>[]} */
	const received = [];
	const squatter = new WebSocketServer({ host: "127.0.0.1", port: h.daemonPort });
	await new Promise((resolve) => squatter.once("listening", resolve));
	squatter.on("connection", (ws) => {
		ws.on("message", (data) => {
			received.push(JSON.parse(data.toString()));
			ws.close(codes[(received.length - 1) % codes.length]);
		});
	});
	try {
		await waitFor(async () => (await h.hook("status")).link.phase === "daemon_unverified", { timeoutMs: 60000, intervalMs: 50, what: "the extension to meet the squatter" });
		const st = await h.hook("status");
		assert.equal(st.link.paired, true, "the key is kept");
		assert.match(st.link.lastError, /^Daemon not verified/);
		assert.match(st.link.reason, /^unverified_(auth_failed|not_paired|protocol_version)$/);
		assert.ok(st.link.retryAt > Date.now() - 1000, "the next attempt is scheduled");
		const badge = await h.hook("badge");
		assert.equal(badge.text, "?");
		assert.match(badge.title, /Daemon not verified/);
		// It keeps trying, through all three codes, and never ends up in a terminal state.
		await waitFor(() => received.length >= 3, { timeoutMs: 60000, what: "three attempts against the squatter" });
		await waitFor(async () => (await h.hook("status")).link.phase === "daemon_unverified", { timeoutMs: 5000, intervalMs: 50, what: "the state after the third attempt" });
		assert.equal((await h.hook("status")).link.paired, true);
		// All the squatter ever got: hello, which carries nothing made from the key.
		for (const frame of received) assert.deepEqual(Object.keys(frame).sort(), ["browser", "ext_version", "mode", "nonce_c", "type", "v"]);
		assert.ok(received.every((frame) => frame.type === "hello" && frame.mode === "auth"));
	} finally {
		for (const ws of squatter.clients) ws.terminate();
		await new Promise((resolve) => squatter.close(() => resolve(undefined)));
	}
	// The real daemon is back on its port with the key it always had: no pairing needed.
	await h.restartDaemon();
	await h.connected(90000);
	assert.equal(daemonLog("ext.connected").at(-1).mode, "auth");
	assert.equal(fs.readFileSync(keyFile, "utf8"), keyBefore);
	assert.equal((await h.hook("status")).link.phase, "ready");
	assert.equal((await h.hook("badge")).text, "");
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
	await assertIdleWindow();
});

test("a daemon of another protocol version on the port: 'version mismatch', no retry loop, no auth frame, the key is kept; once the right daemon is back, 'reconnect' is all it takes", async () => {
	const keyFile = path.join(h.daemon.configDir, "ext.key");
	const keyBefore = fs.readFileSync(keyFile, "utf8");
	const key = b64urlDecode(keyBefore.trim());
	assert.ok(key !== null);
	await h.stopDaemon();
	// A daemon of the next protocol version that holds the key this extension was paired with:
	// the operator updated the daemon only. It answers a hello as every version from 5 on does,
	// with its challenge - its own version in the frame and in the proof.
	const theirs = PROTOCOL_VERSION + 1;
	/** @type {Record<string, any>[]} */
	const received = [];
	const other = new WebSocketServer({ host: "127.0.0.1", port: h.daemonPort });
	await new Promise((resolve) => other.once("listening", resolve));
	other.on("connection", (ws) => {
		ws.on("message", async (data) => {
			const frame = JSON.parse(data.toString());
			received.push(frame);
			if (frame.type !== "hello") return ws.close(4003, "protocol_version");
			const instance = "next-version-daemon";
			const nonceS = randomNonce();
			const macS = await computeMacS(key, { mode: frame.mode, port: h.daemonPort, versionC: frame.v, versionS: theirs, instance, nonceC: frame.nonce_c, nonceS });
			ws.send(JSON.stringify({ v: theirs, type: "challenge", instance, nonce_s: nonceS, mac_s: b64urlEncode(macS) }));
		});
	});
	try {
		await waitFor(async () => (await h.hook("status")).link.phase === "protocol_version", { timeoutMs: 60000, intervalMs: 50, what: "the extension to meet the other daemon" });
		const st = await h.hook("status");
		assert.equal(st.link.paired, true, "the key is kept");
		assert.equal(st.link.reason, "protocol_version");
		assert.equal(st.link.lastError, `Version mismatch: this extension speaks protocol version ${PROTOCOL_VERSION} and the daemon another one. Update the daemon and the extension to the same release.`);
		assert.equal(st.link.retryAt, null, "no further attempt is scheduled");
		const badge = await h.hook("badge");
		assert.equal(badge.text, "err");
		assert.match(badge.title, /Version mismatch/);
		assert.doesNotMatch(badge.title, /[Pp]air again/);
		// One hello, whose answer it checked. No auth frame followed, and it does not come back by itself.
		await new Promise((resolve) => setTimeout(resolve, 4000));
		assert.deepEqual(received.map((f) => [f.v, f.type, f.mode]), [[PROTOCOL_VERSION, "hello", "auth"]]);
		assert.deepEqual(Object.keys(received[0]).sort(), ["browser", "ext_version", "mode", "nonce_c", "type", "v"]);
		assert.equal((await h.hook("status")).link.phase, "protocol_version");
	} finally {
		for (const ws of other.clients) ws.terminate();
		await new Promise((resolve) => other.close(() => resolve(undefined)));
	}
	// The daemon of this release is back on its port, with the key it always had. The state was
	// terminal, so the operator says "reconnect" (or restarts the browser). No pairing.
	await h.restartDaemon();
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.equal((await h.hook("status")).link.phase, "protocol_version", "terminal until the operator acts");
	await h.hook("reconnect");
	await h.connected(90000);
	assert.equal(daemonLog("ext.connected").at(-1).mode, "auth");
	assert.equal(fs.readFileSync(keyFile, "utf8"), keyBefore);
	assert.equal((await h.hook("status")).link.phase, "ready");
	assert.equal((await h.hook("badge")).text, "");
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
	await assertIdleWindow();
});

test("the operator's windows and tabs were never touched", async () => {
	assert.deepEqual(await foreignWindows(), operatorBefore);
});

test("over the whole run no listener of the request guard failed on a request, and no job tab outlived its job", async () => {
	const out = h.browserLog();
	assert.match(out, /job\.done/, "the console output is being captured");
	for (const event of ["guard.listener_failed", "job.tab_outlived", "window.job_tab_not_closed"]) assert.equal(out.includes(event), false, event);
});

test("when the operator closes their last window the gateway window goes too and the browser quits", async () => {
	const snap = await windows();
	assert.equal(snap.windows.filter((w) => w.role === "gateway").length, 1);
	for (const w of snap.windows.filter((w) => w.role !== "gateway")) {
		// The answer may never arrive: the browser is going down.
		h.hook("window.close", { windowId: w.id }).catch(() => {});
	}
	await Promise.race([h.browserExit, new Promise((resolve) => setTimeout(resolve, 20000))]);
	assert.equal(h.browserExited, true, "the browser quit by itself");
});
