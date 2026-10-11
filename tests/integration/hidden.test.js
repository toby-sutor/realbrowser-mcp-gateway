// The hidden path in a real browser: headless Firefox has no virtual desktops,
// so its gateway window is not hidden unless a test minimises it. The
// extension's dev config has a switch (tuning.forceHidden, absent from every
// release build) that makes it treat each job tab as hidden. That exercises
// the extension's whole hidden path - the quiet check of content/quiet.js
// timed by the background page, no walk down the page, no dwell, the
// reporting - against a real page, a real daemon and the agent's rendered
// result. What it cannot show is how a window that really is out of sight
// behaves: minimised.test.js minimises the window for that, and the rest is
// for the operator (tests/manual/WATERFOX-CHECKLIST.md).
//
// Run with: npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./harness.js";

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;
let seq = 0;

before(async () => {
	h = await startHarness({ tuning: { forceHidden: true } });
});

after(async () => {
	if (h !== undefined) await h.stop();
});

/** @param {string} host @param {string} path */
function fx(host, path) {
	seq += 1;
	return h.fixtures.url(host, `${path}${path.includes("?") ? "&" : "?"}n=${seq}`);
}

/** @param {string} url @param {Record<string, unknown>} wait @returns {Promise<any>} */
async function job(url, wait) {
	const res = await h.submitJob({ kind: "fetch", url, wait: { timeout_ms: 15000, settle_ms: 600, dwell_ms: 0, ...wait }, extract: { html: true } });
	assert.equal(res.status, 200, res.text.slice(0, 300));
	return res.json.result;
}

test("a job in a window that counts as hidden: fast path, no scroll, no dwell, reported as hidden, far inside the deadline", async () => {
	const url = fx("a", "/smoke/reveal.html");
	const started = Date.now();
	const r = await job(url, { scroll: "lazy", dwell_ms: 4000 });
	const wallMs = Date.now() - started;
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.deepEqual({ v: r.render.visibility, scroll: r.render.scroll, dwell: r.render.dwell, px: r.render.scrolled_px }, { v: "hidden", scroll: "skipped_hidden", dwell: "skipped_hidden", px: 0 });
	assert.equal(r.render.settled, true);
	// What a walk down the page brings in is absent; what the page has at load is there.
	assert.equal(r.content.markdown.includes("REVEAL-LAZY"), false, "the below-the-fold content that only a scroll loads is not there");
	assert.ok(r.content.markdown.includes("REVEAL-INTRO"));
	// The numbers the harness reports. The dwell of 4 s was asked for and skipped; the quiet check is 600 ms.
	console.log(`hidden path: elapsed_ms=${r.render.elapsed_ms} wall_ms=${wallMs} raf_hz=${r.render.raf_hz}`);
	assert.ok(r.render.elapsed_ms < 6000, `elapsed ${r.render.elapsed_ms} ms`);
	assert.match(h.browserLog(), /job\.hidden_path/);
});

test("the agent's rendered result carries the one header line, outside the untrusted block", async () => {
	const res = await h.daemon.tool("/v1/fetch", { url: fx("a", "/smoke/reveal.html") });
	assert.equal(res.status, 200, res.text.slice(0, 300));
	const text = /** @type {string} */ (res.json.text);
	const lines = text.split("\n");
	const note = "window: hidden - lazy content may be missing; keep the gateway window on the current desktop";
	assert.equal(lines.filter((l) => l === note).length, 1, text.slice(0, 600));
	assert.ok(lines[0].endsWith("visibility=hidden"));
	assert.ok(lines.indexOf(note) < lines.findIndex((l) => l.startsWith("<<<BEGIN_UNTRUSTED_WEB_CONTENT")));
	assert.equal(text.includes("REVEAL-LAZY This closing paragraph"), false);
});

test("a plain page, with and without settle time: both end well inside the deadline", async () => {
	const plain = await job(fx("a", "/plain"), {});
	assert.equal(plain.outcome, "ok", JSON.stringify(plain.error));
	assert.equal(plain.render.visibility, "hidden");
	assert.ok(plain.render.elapsed_ms < 6000, `elapsed ${plain.render.elapsed_ms} ms`);
	console.log(`hidden path, plain page: elapsed_ms=${plain.render.elapsed_ms}`);
	// No settle time asked for: no wait at all.
	const quick = await job(fx("a", "/plain"), { settle_ms: 0 });
	assert.equal(quick.outcome, "ok", JSON.stringify(quick.error));
	assert.equal(quick.render.raf_hz, null, "no frames were measured");
	console.log(`hidden path, no settle time: elapsed_ms=${quick.render.elapsed_ms}`);
	assert.ok(quick.render.elapsed_ms < plain.render.elapsed_ms + 1500);
});

test("a file in a window that counts as hidden: retrieved all the same, no page script runs, nothing is said about what was skipped", async () => {
	const { FILES } = await import("../fixtures/server.js");
	const started = Date.now();
	const res = await h.daemon.tool("/v1/fetch", { url: fx("files", "/file/report.pdf") });
	const wallMs = Date.now() - started;
	assert.equal(res.status, 200, res.text.slice(0, 300));
	const text = /** @type {string} */ (res.json.text);
	assert.equal(res.json.isError, false, text.slice(0, 400));
	assert.match(text, /^\[browser-gateway\] outcome=ok kind=file file=fl_[0-9A-Z]{26} scope=container status=200\n/);
	assert.match(text, new RegExp(`^file: type=application/pdf size=${FILES.pdf.length} sha256=[0-9a-f]{16}$`, "m"));
	// Reading a file needs nothing to be drawn: no hidden-window note, since nothing was skipped for it.
	assert.equal(text.includes("window: hidden"), false);
	const exported = await h.daemon.request("POST", "/v1/files/export", { body: { file: res.json.page } });
	assert.equal(Buffer.from(exported.json.data, "base64").equals(FILES.pdf), true);
	console.log(`hidden path, a file: wall_ms=${wallMs}`);
	assert.ok(wallMs < 6000, `took ${wallMs} ms`);
	assert.deepEqual(h.downloads(), []);
	assert.deepEqual(await h.hook("downloads.list"), []);
});
