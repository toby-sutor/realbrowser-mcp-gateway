// The job runner and a response that turns out to be a file: what is sent and
// in which order, that the tab goes before the bytes do, and every way such a
// job can end. The browser, the request guard and the response filter are
// stand-ins; the capture itself (capture.js) is the real one.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { FakeEvent, logSink, sleep } from "../helpers/ext-fakes.js";
import { until } from "../helpers/daemon.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeFilter } from "../helpers/fake-filter.js";
import { Capture } from "../../extension/background/capture.js";
import { Jobs } from "../../extension/background/jobs.js";
import { DEFAULT_BLOCKLIST } from "../../extension/shared/policy.js";
import { DIRECTION, LIMITS, MSG, makeMessage, validateMessage } from "../../extension/shared/protocol.js";
import { DEFAULT_ALLOW_TYPES } from "../../extension/shared/sniff.js";

const STORE = "firefox-container-7";
const WINDOW = 5;
const FILES = Object.freeze({ max_bytes: 4 * 1048576, types: [...DEFAULT_ALLOW_TYPES] });
const PDF = Buffer.from("%PDF-1.4\n% a made-up document\n");
const SETTLED = Object.freeze({ ok: true, settled: true, waitedMs: 12, mutations: 0, visibility: "visible", rafHz: 60 });
const EXTRACTED = Object.freeze({
	ok: true,
	url: "https://example.com/final",
	page: { title: "A title", author: null, published: null, lang: "en", site: null, word_count: 400, extractor: "defuddle@0.19.4" },
	extraction: { view: "article", coverage_pct: 80, hidden_removed: 0, capped: false },
	content: { markdown: "# A title\n\na page", text: "A title a page", html: null, raw_html: null, links: [] },
	truncated: { markdown: false, text: false, html: false, raw_html: false },
	stats: {},
});
/** What content/detect-dom.js reports for a Cloudflare interstitial, and for an ordinary page. */
const CF_DOM = Object.freeze({ ok: true, title_interstitial: true, cf_challenge: true, turnstile: false, datadome: false, recaptcha: false, hcaptcha: false, reddit_block: false, consent: false, cf_chl_opt: false, text_len: 180 });
const PAGE_DOM = Object.freeze({ ...CF_DOM, title_interstitial: false, cf_challenge: false, text_len: 5000 });

/** @param {Buffer} data */
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** @param {{ backlog?: () => number, tuning?: Record<string, unknown>, sendFails?: (msg: Record<string, any>) => boolean }} [opts] */
function setup(opts = {}) {
	const clock = new FakeClock();
	const nav = { onBeforeNavigate: new FakeEvent(), onCommitted: new FakeEvent(), onCompleted: new FakeEvent(), onErrorOccurred: new FakeEvent() };
	/** @type {string[]} */
	const calls = [];
	/** @type {Record<string, any>[]} */
	const sent = [];
	/** @type {[string, import("../../extension/background/jobs.js").Challenge][]} */
	const challenges = [];
	/** @type {Map<number, { nav: any, sealed: boolean, detached: boolean, opts: any, capture: Capture | null }>} */
	const guards = new Map();
	/** @type {Map<number, { url: string, dom: Record<string, unknown> | null, status: number, cf: boolean }>} */
	const pages = new Map();
	/** @type {Set<number>} */
	const closedTabs = new Set();
	/** @type {{ file?: string, code?: string }[]} */
	const scripts = [];
	const sink = logSink();
	let nextTab = 40;
	/** What a navigation leads to: "file" (the guard reports one, no page ever loads), a page, or a challenge page. */
	const world = { next: /** @type {"file" | "page" | "challenge" | "nothing"} */ ("file"), file: { contentType: "application/pdf", charset: /** @type {string | null} */ (null), name: /** @type {string | null} */ (null) } };
	/** @type {(msg: Record<string, any>) => void} called for every frame the runner sends, after it was recorded */
	let onSend = () => {};

	/**
	 * The guard reports that the top-level response of the tab is a file: as the real one does, from its
	 * headers listener, with a capture over the filter of that request.
	 * @param {number} tabId
	 * @param {string} [url]
	 * @returns {FakeFilter}
	 */
	const fileArrives = (tabId, url = "https://cdn.example.com/files/report.pdf") => {
		const g = /** @type {NonNullable<ReturnType<typeof guards.get>>} */ (guards.get(tabId));
		const filter = new FakeFilter("1");
		const files = g.opts.files;
		assert.ok(files, "the guard was given what the job may bring back");
		g.capture = new Capture({ filter, files, plan: { ...world.file, url } });
		Object.assign(g.nav, { httpStatus: 200, contentType: world.file.contentType, finalUrl: url });
		// The tab's document is committed without content; its load never completes while the filter is open.
		nav.onBeforeNavigate.fire({ tabId, frameId: 0, url });
		g.opts.onFile(g.capture);
		return filter;
	};
	/** @param {number} tabId @param {"page" | "challenge"} what */
	const show = (tabId, what) => {
		const page = what === "challenge" ? { url: "https://example.com/start", dom: CF_DOM, status: 403, cf: true } : { url: "https://example.com/final", dom: PAGE_DOM, status: 200, cf: false };
		pages.set(tabId, page);
		const g = guards.get(tabId);
		if (g !== undefined) Object.assign(g.nav, { httpStatus: page.status, cfMitigated: page.cf, contentType: "text/html" });
		nav.onBeforeNavigate.fire({ tabId, frameId: 0, url: page.url });
		nav.onCommitted.fire({ tabId, frameId: 0, url: page.url });
		nav.onCompleted.fire({ tabId, frameId: 0, url: page.url });
	};
	/** @type {FakeFilter[]} the filters of the files that arrived, oldest first */
	const filters = [];

	const jobs = new Jobs({
		send: (msg) => {
			const check = validateMessage(msg, DIRECTION.TO_DAEMON);
			assert.equal(check.ok, true, `every frame is valid: ${check.ok ? "" : check.error}`);
			if (opts.sendFails?.(msg) === true) return false;
			sent.push(msg);
			onSend(msg);
			return true;
		},
		...(opts.backlog === undefined ? {} : { backlog: opts.backlog }),
		maxResultBytes: () => 8388608,
		isPaused: () => false,
		container: { ensure: async () => STORE },
		window: {
			name: "fake",
			acquire: async (cookieStoreId) => {
				const tabId = nextTab++;
				calls.push(`acquire:${tabId}:${cookieStoreId}`);
				return { windowId: WINDOW, tabId };
			},
			navigate: async (tabId) => {
				calls.push(`navigate:${tabId}`);
				const next = world.next;
				setTimeout(() => {
					if (next === "file") filters.push(fileArrives(tabId));
					else if (next !== "nothing") show(tabId, next);
				}, 2);
			},
			release: async (tabId) => {
				calls.push(`release:${tabId}`);
				closedTabs.add(tabId);
			},
			popOut: async (tabId) => 900 + tabId,
			closeForeign: async () => "kept",
			releaseAll: async () => {},
			adoptOrSweep: async () => ({ adopted: false, closedWindows: 0, closedTabs: 0, disowned: 0 }),
			idle: async () => {},
			isOpen: () => true,
			close: async () => {},
			snapshot: () => ({ windowId: WINDOW, parkTabId: 1, jobTabs: [], handoffWindows: [] }),
		},
		guard: /** @type {any} */ ({
			precheck: async () => ({ verdict: null }),
			widen: () => {},
			attach: (/** @type {number} */ tabId, /** @type {any} */ o) => {
				const g = {
					nav: { redirectOrigins: /** @type {string[]} */ ([]), httpStatus: /** @type {number | null} */ (null), contentType: /** @type {string | null} */ (null), cfMitigated: false, retryAfterS: null },
					sealed: false,
					detached: false,
					sawTopFrame: true,
					opts: o,
					capture: /** @type {Capture | null} */ (null),
					topFrameAt: () => true,
					committed: () => true,
					navigationFailed: () => {},
					seal() {
						g.sealed = true;
						calls.push(`seal:${tabId}`);
					},
					// The real guard closes the filter of its tab when the tab goes.
					detach() {
						g.detached = true;
						g.capture?.close();
						calls.push(`detach:${tabId}`);
					},
				};
				guards.set(tabId, g);
				return g;
			},
		}),
		policy: { blocklist: DEFAULT_BLOCKLIST, allowLoopbackPorts: [] },
		optin: { match: () => null, admit: () => 0 },
		optinPolicy: {},
		tabs: /** @type {any} */ ({
			executeScript: async (/** @type {number} */ tabId, /** @type {{ code?: string, file?: string }} */ details) => {
				scripts.push(details);
				if (closedTabs.has(tabId)) throw new Error("no such tab");
				if (details.code !== undefined) return [details.code.startsWith("globalThis.__bgwExtract(") ? EXTRACTED : undefined];
				if (details.file === "/content/settle.js") return [SETTLED];
				if (details.file === "/content/detect-dom.js") return [pages.get(tabId)?.dom ?? undefined];
				return [undefined];
			},
			get: async (/** @type {number} */ tabId) => {
				if (closedTabs.has(tabId)) throw new Error("no such tab");
				return { id: tabId, url: pages.get(tabId)?.url ?? "about:blank", status: "complete" };
			},
		}),
		webNavigation: /** @type {any} */ (nav),
		log: sink.log,
		onActivity: () => {},
		onChallenge: (what, challenge) => challenges.push([what, challenge]),
		clock,
		rng: () => 0,
		tuning: { errorGraceMs: 30, pollMs: 5, backstopMs: 200, releaseTimeoutMs: 300, extractTimeoutMs: 500, downloadGraceMs: 40, detectTimeoutMs: 500, ...opts.tuning },
	});

	/**
	 * @param {string} id
	 * @param {Record<string, unknown>} [over] replaces members of the job.start frame
	 * @param {Record<string, unknown>} [wait]
	 */
	const start = (id, over = {}, wait = {}) => {
		const msg = makeMessage(MSG.JOB_START, {
			job: id,
			kind: "fetch",
			url: "https://example.com/start",
			session: "auto",
			wait: { timeout_ms: 600, settle_ms: 20, dwell_ms: 0, human_wait_ms: 900000, scroll: "none", ...wait },
			extract: { markdown: true, text: true, html: false, raw_html: false, links: true, adapter: "auto" },
			files: FILES,
			...over,
		});
		assert.deepEqual(validateMessage(msg, DIRECTION.TO_EXT), { ok: true });
		jobs.start(msg);
	};
	/** @param {string} id */
	const results = (id) => sent.filter((m) => m.type === MSG.JOB_RESULT && m.job === id);
	/** @param {string} id @returns {Promise<Record<string, any>>} the one result of a job */
	const result = async (id) => {
		await until(() => results(id).length > 0, { timeoutMs: 4000, what: `the result of ${id}` });
		await sleep(20);
		assert.equal(results(id).length, 1, "exactly one result");
		return results(id)[0];
	};
	/** @param {string} id */
	const frames = (id) => sent.filter((m) => m.job === id).map((m) => (m.type === MSG.JOB_PROGRESS ? m.phase : m.type));
	/** @param {string} id @returns {Buffer} the bytes the blob frames of a job carried, in the order they were sent */
	const blobBytes = (id) => Buffer.concat(sent.filter((m) => m.type === MSG.JOB_BLOB && m.job === id).map((m) => Buffer.from(m.data, "base64")));
	/** The filter of the file that the running job's tab is receiving. */
	const filter = async () => {
		await until(() => filters.length > 0, { what: "the response to turn out to be a file" });
		return filters[filters.length - 1];
	};
	const advance = async (/** @type {number} */ ms, step = 500) => {
		for (let left = ms; left > 0; left -= step) {
			clock.advance(Math.min(step, left));
			await sleep(4);
		}
	};
	return { jobs, clock, world, calls, sent, sink, challenges, guards, pages, scripts, filters, start, result, results, frames, blobBytes, filter, fileArrives, show, advance, onSend: (/** @type {typeof onSend} */ fn) => (onSend = fn) };
}

test("a file from start to result: nothing is settled or read, the tab goes first, then the bytes, then the one result", async () => {
	const t = setup();
	t.world.file = { contentType: "application/pdf", charset: null, name: "Report 2026.pdf" };
	t.start("j_file");
	const f = await t.filter();
	const tab = /** @type {number} */ ([...t.guards.keys()][0]);
	// The job told the guard what it may bring back, and for which cookie store.
	assert.deepEqual(t.guards.get(tab)?.opts.files, { maxBytes: FILES.max_bytes, types: FILES.types });
	assert.equal(t.guards.get(tab)?.opts.cookieStoreId, STORE);
	f.feed(PDF.subarray(0, 10));
	await sleep(30);
	assert.equal(t.results("j_file").length, 0, "not before the response has ended");
	assert.equal(t.calls.includes(`release:${tab}`), false, "the tab stays while the response arrives");
	f.feed(PDF.subarray(10));
	f.end();
	const r = await t.result("j_file");
	assert.equal(r.outcome, "ok");
	assert.equal(r.error, null);
	assert.equal(r.cookie_scope, "container");
	assert.deepEqual(r.file, { name: "Report 2026.pdf", charset: null, size: PDF.length, sha256: sha256(PDF), chunks: 1 });
	assert.deepEqual(r.nav, { requested_url: "https://example.com/start", final_url: "https://cdn.example.com/files/report.pdf", redirect_origins: [], http_status: 200, content_type: "application/pdf", body_bytes: PDF.length });
	// A file has no page, no extraction and no content.
	assert.deepEqual([r.page, r.extraction, r.content, r.detect], [null, null, null, null]);
	assert.deepEqual(r.truncated, { markdown: false, text: false, html: false, raw_html: false });
	assert.deepEqual([r.render.visibility, r.render.settled, r.render.scroll, r.render.dwell], [null, false, "off", "off"]);
	assert.ok(r.render.timings.nav_ms >= 0 && r.render.timings.settle_ms === 0 && r.render.timings.extract_ms === 0);
	// The frames, in order: the bytes before the result.
	assert.deepEqual(t.frames("j_file"), [MSG.JOB_ACCEPTED, "navigating", "receiving_file", MSG.JOB_BLOB, MSG.JOB_RESULT]);
	assert.deepEqual(t.sent.filter((m) => m.type === MSG.JOB_BLOB).map((m) => [m.seq, m.offset]), [[0, 0]]);
	assert.equal(t.blobBytes("j_file").equals(PDF), true);
	// The tab was closed before a byte went out, and only then was its filter closed: the viewer in the tab was
	// never told that its response had ended, let alone given any of it.
	assert.deepEqual(t.calls, [`acquire:${tab}:${STORE}`, `navigate:${tab}`, `seal:${tab}`, `release:${tab}`, `detach:${tab}`]);
	assert.deepEqual(f.calls, { close: 1, write: 0, disconnect: 0, suspend: 0, resume: 0 });
	// No script ever ran in the tab: no settling, no detection, no extraction.
	assert.deepEqual(t.scripts, []);
	assert.equal(t.jobs.current(), null);
	// Written down: counts and ids. No name, no address, no byte.
	assert.deepEqual(t.sink.entries.find((e) => e.event === "job.file_received")?.fields, { job: "j_file", bytes: PDF.length });
	assert.equal(/Report|report\.pdf|%PDF/.test(t.sink.text()), false);
});

test("a large file goes out in full pieces, numbered, each saying where its bytes belong; other frames get their turn in between", async () => {
	const t = setup();
	const body = Buffer.concat([PDF, crypto.randomBytes(2 * LIMITS.BLOB_CHUNK_BYTES + 12345)]);
	// A stand-in for whatever else waits for the event loop: a ping to answer, a cancel to hear.
	let turns = 0;
	const turn = setInterval(() => (turns += 1), 0);
	/** @type {number[]} */
	const turnsAtBlob = [];
	t.onSend((m) => {
		if (m.type === MSG.JOB_BLOB) turnsAtBlob.push(turns);
	});
	t.start("j_big");
	const f = await t.filter();
	for (let i = 0; i < body.length; i += 131072) f.feed(body.subarray(i, i + 131072));
	f.end();
	const r = await t.result("j_big");
	clearInterval(turn);
	assert.equal(r.outcome, "ok");
	const blobs = t.sent.filter((m) => m.type === MSG.JOB_BLOB);
	assert.deepEqual(blobs.map((m) => m.seq), [0, 1, 2]);
	assert.deepEqual(blobs.map((m) => m.offset), [0, LIMITS.BLOB_CHUNK_BYTES, 2 * LIMITS.BLOB_CHUNK_BYTES]);
	assert.deepEqual(blobs.map((m) => Buffer.from(m.data, "base64").length), [LIMITS.BLOB_CHUNK_BYTES, LIMITS.BLOB_CHUNK_BYTES, PDF.length + 12345]);
	assert.ok(blobs.every((m) => m.data.length <= LIMITS.MAX_BLOB_CHARS));
	assert.equal(t.blobBytes("j_big").equals(body), true);
	assert.deepEqual(r.file, { name: null, charset: null, size: body.length, sha256: sha256(body), chunks: 3 });
	assert.equal(t.sent.indexOf(r), t.sent.length - 1, "the result is the last frame of the job");
	// Between two pieces the event loop turned at least once.
	assert.ok(turnsAtBlob[1] > turnsAtBlob[0] && turnsAtBlob[2] > turnsAtBlob[1], `turns at each piece: ${turnsAtBlob}`);
});

test("only a fetch brings a file back: a search and a probe never tell the guard that they may", async () => {
	for (const over of [
		{ kind: "search", engine: "brave", limit: 5, session: "isolated" },
		{ kind: "probe" },
		{ files: null },
	]) {
		const t = setup();
		t.world.next = "page";
		t.start("j_x", over);
		await t.result("j_x");
		assert.equal([...t.guards.values()][0].opts.files, null, JSON.stringify(over));
	}
});

test("a file larger than allowed: reading stops at the limit, nothing is sent, and the result says how much was read", async () => {
	const t = setup();
	t.start("j_large", { files: { ...FILES, max_bytes: 100000 } });
	const f = await t.filter();
	f.feed(PDF);
	f.feed(Buffer.alloc(120000, 0x20));
	const r = await t.result("j_large");
	assert.deepEqual([r.outcome, r.error.code, r.error.retryable], ["unsupported", "too_large", false]);
	assert.equal(r.file, null);
	assert.equal(r.nav.body_bytes, PDF.length + 120000);
	assert.equal(r.nav.final_url, null);
	assert.equal(t.sent.some((m) => m.type === MSG.JOB_BLOB), false, "no byte of it went to the daemon");
	assert.equal(f.calls.close, 1, "the filter was closed at once: that ends the request");
	assert.equal(f.passedOn, 0);
	assert.ok(t.calls.some((c) => c.startsWith("release:")), "and the tab is closed");
});

test("a body the daemon would refuse is not sent: an executable declared as a PDF", async () => {
	const t = setup();
	t.start("j_exe");
	const f = await t.filter();
	f.feed(Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(200, 0)]));
	f.end();
	const r = await t.result("j_exe");
	assert.deepEqual([r.outcome, r.error.code, r.file], ["unsupported", "file_content_refused", null]);
	assert.equal(t.sent.some((m) => m.type === MSG.JOB_BLOB), false);
});

test("a file that does not arrive in time: given up at the job's own deadline, the request ended, one result", async () => {
	const t = setup();
	t.start("j_slow", {}, { timeout_ms: 150, settle_ms: 0 });
	const f = await t.filter();
	f.feed(PDF);
	const r = await t.result("j_slow");
	assert.deepEqual([r.outcome, r.error.code, r.error.retryable, r.file], ["timeout", "file_timeout", true, null]);
	assert.equal(r.nav.body_bytes, PDF.length);
	assert.ok(r.render.elapsed_ms >= 120 && r.render.elapsed_ms < 1500, `after ${r.render.elapsed_ms} ms`);
	assert.equal(f.calls.close, 1);
	assert.equal(t.sent.some((m) => m.type === MSG.JOB_BLOB), false);
	// Whatever still comes changes nothing.
	f.onstop?.();
	await sleep(40);
	assert.equal(t.results("j_slow").length, 1);
});

test("a response that breaks off under the filter ends the job as retryable, with nothing sent", async () => {
	const t = setup();
	t.start("j_cut");
	const f = await t.filter();
	f.feed(PDF);
	f.fail();
	const r = await t.result("j_cut");
	assert.deepEqual([r.outcome, r.error.code, r.error.retryable, r.file], ["error", "file_interrupted", true, null]);
	assert.equal(t.sent.some((m) => m.type === MSG.JOB_BLOB), false);
});

test("job.cancel while the file arrives, and while its bytes go out: the transfer stops there, one result says why", async () => {
	// While it arrives.
	const a = setup();
	a.start("j_a");
	const fa = await a.filter();
	fa.feed(PDF);
	a.jobs.cancel("j_a", "client_gone");
	const ra = await a.result("j_a");
	assert.deepEqual([ra.outcome, ra.error.code, ra.file], ["aborted", "client_gone", null]);
	assert.equal(fa.calls.close, 1, "the filter is closed with the tab");
	assert.equal(a.sent.some((m) => m.type === MSG.JOB_BLOB), false);

	// While its bytes go out: after the first piece.
	const b = setup();
	const body = Buffer.concat([PDF, Buffer.alloc(3 * LIMITS.BLOB_CHUNK_BYTES, 0x20)]);
	b.onSend((m) => {
		if (m.type === MSG.JOB_BLOB && m.seq === 0) b.jobs.cancel("j_b", "deadline");
	});
	b.start("j_b");
	const fb = await b.filter();
	fb.feed(body);
	fb.end();
	const rb = await b.result("j_b");
	assert.deepEqual([rb.outcome, rb.error.code, rb.file], ["timeout", "deadline", null]);
	assert.deepEqual(b.sent.filter((m) => m.type === MSG.JOB_BLOB).map((m) => m.seq), [0], "no piece after the cancel");
	assert.equal(b.sent.at(-1), rb, "and the result is the last frame");
	await sleep(50);
	assert.equal(b.sent.at(-1), rb);
});

test("the link goes down while the bytes go out: nothing more is sent, not even a result", async () => {
	const t = setup();
	const body = Buffer.concat([PDF, Buffer.alloc(3 * LIMITS.BLOB_CHUNK_BYTES, 0x20)]);
	t.onSend((m) => {
		if (m.type === MSG.JOB_BLOB && m.seq === 1) t.jobs.abortAll("link_down");
	});
	t.start("j_down");
	const f = await t.filter();
	f.feed(body);
	f.end();
	await until(() => t.jobs.current() === null, { what: "the job to end" });
	await sleep(50);
	assert.deepEqual(t.sent.filter((m) => m.type === MSG.JOB_BLOB).map((m) => m.seq), [0, 1]);
	assert.equal(t.results("j_down").length, 0, "the daemon has failed the job already");
	assert.deepEqual([...([...t.guards.values()][0].capture?.pieces() ?? [])], [], "the bytes are let go");

	// A link that takes no frame: the job ends with a failure of its own instead of a file.
	const dead = setup({ sendFails: (m) => m.type === MSG.JOB_BLOB });
	dead.start("j_dead");
	const fd = await dead.filter();
	fd.feed(PDF);
	fd.end();
	const r = await dead.result("j_dead");
	assert.deepEqual([r.outcome, r.error.code, r.error.retryable, r.file], ["error", "file_transfer_failed", true, null]);
});

test("no piece is handed to a link that still holds the last ones; one that takes nothing for too long ends the job", async () => {
	let backlog = 10 * 1048576;
	const t = setup({ backlog: () => backlog });
	t.start("j_wait");
	const f = await t.filter();
	f.feed(PDF);
	f.end();
	await until(() => t.calls.some((c) => c.startsWith("release:")), { what: "the tab to close" });
	await sleep(80);
	assert.equal(t.sent.some((m) => m.type === MSG.JOB_BLOB), false, "held back while the link is full");
	backlog = 0;
	const r = await t.result("j_wait");
	assert.equal(r.outcome, "ok");
	assert.equal(t.blobBytes("j_wait").equals(PDF), true);

	const stuck = setup({ backlog: () => 10 * 1048576, tuning: { blobStallMs: 60 } });
	stuck.start("j_stuck");
	const fs = await stuck.filter();
	fs.feed(PDF);
	fs.end();
	const rs = await stuck.result("j_stuck");
	assert.deepEqual([rs.outcome, rs.error.code, rs.file], ["error", "file_transfer_failed", null]);
	assert.equal(stuck.sent.some((m) => m.type === MSG.JOB_BLOB), false);
});

test("the bytes get time of their own to go out: a response that took the job's whole time is still handed over, within a limit", async () => {
	let backlog = 10 * 1048576;
	const t = setup({ backlog: () => backlog });
	t.start("j_late", {}, { timeout_ms: 150, settle_ms: 0 });
	const f = await t.filter();
	f.feed(PDF.subarray(0, 100));
	await sleep(110);
	f.feed(PDF.subarray(100));
	f.end();
	// The job's own time (150 ms) runs out while the link is busy.
	await sleep(120);
	assert.equal(t.sent.some((m) => m.type === MSG.JOB_BLOB || m.type === MSG.JOB_RESULT), false);
	backlog = 0;
	const r = await t.result("j_late");
	assert.equal(r.outcome, "ok");
	assert.equal(t.blobBytes("j_late").equals(PDF), true);

	// That time is limited too.
	const stuck = setup({ backlog: () => 10 * 1048576, tuning: { blobSendMs: 60 } });
	stuck.start("j_never", {}, { timeout_ms: 150, settle_ms: 0 });
	const fs = await stuck.filter();
	fs.feed(PDF.subarray(0, 100));
	await sleep(110);
	fs.feed(PDF.subarray(100));
	fs.end();
	const startedAt = Date.now();
	const rs = await stuck.result("j_never");
	assert.deepEqual([rs.outcome, rs.error.code, rs.file], ["error", "file_transfer_failed", null]);
	assert.ok(Date.now() - startedAt < 2000, "given up long before the link's own stall limit");
});

test("a verdict of the guard while the file arrives wins: no file", async () => {
	const t = setup();
	t.start("j_v");
	const f = await t.filter();
	f.feed(PDF);
	[...t.guards.values()][0].opts.onVerdict({ outcome: "policy_blocked", code: "private_address", message: "the server answered from a private address" });
	const r = await t.result("j_v");
	assert.deepEqual([r.outcome, r.error.code, r.file], ["policy_blocked", "private_address", null]);
	assert.equal(t.sent.some((m) => m.type === MSG.JOB_BLOB), false);
	assert.equal(f.calls.close, 1);
});

test("a rate limit told at the headers of a file is a block that passes: retryable, with what the site asked for", async () => {
	const t = setup();
	t.world.next = "nothing";
	t.start("j_429");
	await until(() => t.guards.size === 1, { what: "the job tab" });
	[...t.guards.values()][0].opts.onVerdict({ outcome: "blocked", code: "http_429", message: "the site is rate limiting (HTTP 429)", detect: { kind: "http_429", evidence: "status 429" }, retryAfterS: 77 });
	const r = await t.result("j_429");
	assert.deepEqual([r.outcome, r.error.code, r.error.retryable, r.error.retry_after_s], ["blocked", "http_429", true, 77]);
	assert.deepEqual([r.detect.kind, r.detect.evidence], ["http_429", "status 429"]);
});

test("a challenge that clears into a file within its grace period: the file is the result, and it says what stood before it", async () => {
	const t = setup();
	t.world.next = "challenge";
	t.start("j_grace");
	await until(() => t.sent.some((m) => m.type === MSG.JOB_PROGRESS && m.phase === "challenge_wait"), { what: "the grace period" });
	const tab = /** @type {number} */ ([...t.guards.keys()][0]);
	await t.advance(2000);
	// The browser check passes: the page reloads itself, and what comes is a file.
	const f = t.fileArrives(tab);
	f.feed(PDF);
	f.end();
	const r = await t.result("j_grace");
	assert.equal(r.outcome, "ok");
	assert.deepEqual(r.file, { name: null, charset: null, size: PDF.length, sha256: sha256(PDF), chunks: 1 });
	assert.deepEqual([r.detect.kind, r.detect.resolved], ["cloudflare_challenge", "cleared_by_waiting"]);
	assert.ok(r.detect.waited_ms >= 2000);
	assert.deepEqual(t.challenges, [], "never parked");
	assert.equal(t.blobBytes("j_grace").equals(PDF), true);
});

test("a parked challenge behind which a file waits: once the check is passed the file is captured, and the job ends with it", async () => {
	for (const handedOff of [false, true]) {
		const t = setup();
		t.world.next = "challenge";
		t.start("j_park");
		await until(() => t.sent.some((m) => m.type === MSG.JOB_PROGRESS && m.phase === "challenge_wait"), { what: "the grace period" });
		await t.advance(5000);
		await until(() => t.jobs.pending().length === 1, { what: "the job to be parked" });
		const tab = /** @type {number} */ ([...t.guards.keys()][0]);
		assert.equal(t.jobs.current(), null, "the runner is free");
		if (handedOff) assert.equal(await t.jobs.handoff("j_park"), true);
		await t.advance(20000);
		assert.equal(t.results("j_park").length, 0);
		// The operator passes the check (or it clears by itself): the tab reloads, and the response is a file.
		const f = t.fileArrives(tab);
		assert.equal(t.jobs.pending().length, 0, "no longer waiting for anyone: the watch ended the moment the file began");
		f.feed(PDF);
		f.end();
		const r = await t.result("j_park");
		assert.equal(r.outcome, "ok");
		assert.deepEqual(r.file, { name: null, charset: null, size: PDF.length, sha256: sha256(PDF), chunks: 1 });
		assert.deepEqual([r.detect.kind, r.detect.resolved], ["cloudflare_challenge", handedOff ? "cleared_by_operator" : "cleared_by_waiting"]);
		assert.ok(r.render.timings.parked_ms >= 20000);
		assert.equal(t.blobBytes("j_park").equals(PDF), true);
		assert.deepEqual(t.challenges.map(([what]) => what), handedOff ? ["pending", "acked", "cleared", "ended"] : ["pending", "cleared", "ended"]);
		assert.ok(t.calls.includes(`release:${tab}`), "the tab of the check is closed, wherever it is");
		assert.equal(f.calls.close, 1);
		// The page of the check was looked at while it waited; the file never was: no script after it began.
		const after = t.scripts.length;
		await sleep(30);
		assert.equal(t.scripts.length, after);
		assert.equal(t.clock.pending, 0, "no timer of the parked job is left");
	}
});

test("a page that sends its tab on to a file while it is being read: the file is the result", async () => {
	const t = setup({ tuning: { extractTimeoutMs: 2000 } });
	t.world.next = "page";
	t.start("j_late", {}, { dwell_ms: 5000 });
	// The page loaded and settled; the job dwells before it reads. Then the page navigates itself to a file.
	await until(() => t.scripts.some((s) => s.file === "/content/detect-dom.js"), { what: "the page to be looked at" });
	await sleep(20);
	const tab = /** @type {number} */ ([...t.guards.keys()][0]);
	const f = t.fileArrives(tab);
	f.feed(PDF);
	f.end();
	const r = await t.result("j_late");
	assert.equal(r.outcome, "ok");
	assert.equal(r.file.size, PDF.length);
	assert.equal(r.content, null, "nothing of the page that was there before");
	assert.equal(t.scripts.some((s) => (s.code ?? "").startsWith("globalThis.__bgwExtract(")), false, "the page was not read");
});

// The file behind a check that was passed is being sent, piece by
// piece. Nothing runs, nothing waits for the operator - and the job is alive until its result is out.
test("a parked job whose file is on its way to the daemon is alive at every frame: neither running nor waiting, and busy", async () => {
	const { clearRefusal } = await import("../../extension/background/container.js");
	const t = setup();
	const big = crypto.randomBytes(3 * LIMITS.BLOB_CHUNK_BYTES + 5000);
	big.set(Buffer.from("%PDF-1.4\n"), 0);
	/** @type {{ type: string, current: boolean, pending: number, busy: unknown, refusal: string | null }[]} */
	const samples = [];
	t.onSend((msg) => {
		samples.push({ type: msg.type, current: t.jobs.current() !== null, pending: t.jobs.pending().length, busy: /** @type {any} */ (t.jobs).busy?.(), refusal: clearRefusal(/** @type {any} */ (t.jobs)) });
	});
	t.world.next = "challenge";
	t.start("j_park");
	await until(() => t.sent.some((m) => m.type === MSG.JOB_PROGRESS && m.phase === "challenge_wait"), { what: "the grace period" });
	await t.advance(5000);
	await until(() => t.jobs.pending().length === 1, { what: "the job to be parked" });
	const tab = /** @type {number} */ ([...t.guards.keys()][0]);
	const f = t.fileArrives(tab);
	f.feed(big);
	f.end();
	const r = await t.result("j_park");
	assert.equal(r.outcome, "ok");
	assert.equal(r.file.chunks, 4);
	const blobs = samples.filter((s) => s.type === MSG.JOB_BLOB);
	assert.equal(blobs.length, 4);
	for (const s of [...blobs, ...samples.filter((x) => x.type === MSG.JOB_RESULT)]) {
		assert.deepEqual([s.current, s.pending], [false, 0], "the popup shows no job, and nothing waits for the operator");
		assert.equal(s.busy, true, `${s.type}: the job is alive`);
		assert.equal(s.refusal, "A page whose human check was just passed is still being read. Try again in a moment.");
	}
	assert.equal(t.jobs.busy(), false);
	assert.equal(clearRefusal(/** @type {any} */ (t.jobs)), null);
});
