// The job runner with stand-ins for the browser: what it sends, in which
// order it touches things, and that every job gets exactly one result.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEvent, logSink, sleep } from "../helpers/ext-fakes.js";
import { until } from "../helpers/daemon.js";
import { Jobs, SEARCH_HINTS, cleanExtracted, cleanSearch, fitJsonString, fitLinks, stallLine } from "../../extension/background/jobs.js";
import { ContainerError } from "../../extension/background/container.js";
import { errorText } from "../../extension/background/errtext.js";
import { DEFAULT_BLOCKLIST } from "../../extension/shared/policy.js";
import { DIRECTION, LIMITS, MSG, PROTOCOL_VERSION, TIMING_PHASES, makeMessage, validateMessage, zeroTimings } from "../../extension/shared/protocol.js";

const STORE = "firefox-container-7";
const TAB = 40;
const WINDOW = 5;

/**
 * @typedef {object} World everything a test can bend
 * @property {(tabId: number, url: string, attempt: number) => void} onNavigate what the "browser" does when asked to navigate
 * @property {() => Promise<string>} ensure container.ensure()
 * @property {(url: string) => Promise<{ verdict: import("../../extension/background/guard.js").Verdict | null }>} precheck
 * @property {(name: "settle" | "extract" | "search", args: Record<string, unknown>) => unknown} script result of a content script, or throws
 * @property {() => void} vendor what injecting the Defuddle bundle does; may throw
 * @property {string} tabUrl what tabs.get reports
 * @property {boolean} paused
 * @property {number} maxResultBytes
 * @property {() => Promise<{ windowId: number, tabId: number }>} acquire
 * @property {boolean} sawTopFrame what the guard of the job tab says about having heard the page load
 * @property {(url: string) => import("../../extension/shared/policy.js").OptInRule | null} match the operator's login rule a URL lies in
 * @property {(rule: import("../../extension/shared/policy.js").OptInRule) => number} admit 0, or the seconds the rule's rate limit asks for
 * @property {(url: string) => boolean} inScope what the guard of the job tab says about an address of the top frame
 * @property {(url: string) => boolean} guarded what the guard of the job tab says about a document the top frame committed
 * @property {(details: Record<string, unknown>) => Promise<unknown> | unknown} workers what asking a tab for its service workers gives back, or throws
 * @property {boolean} survives the job tab is still there after it was released: the browser did not close it
 * @property {string} [tabStatus] what the browser says of the job tab ("loading", "complete"); absent: nothing
 * @property {() => void} [onRelease] what closing the job tab does besides; may throw
 */

const SETTLED = Object.freeze({ ok: true, settled: true, waitedMs: 12, mutations: 0, visibility: "visible", rafHz: 59.94 });

/**
 * What content/extract.js hands back for an ordinary page.
 * @param {Record<string, unknown>} [over] replaces top-level members
 */
function extracted(over = {}) {
	return {
		ok: true,
		url: "https://example.com/final",
		page: { title: "A title", author: "An Author", published: "2026-03-14T08:30:00Z", lang: "en", site: "Example Site", word_count: 4, extractor: "defuddle@0.19.4" },
		extraction: { view: "article", coverage_pct: 80, hidden_removed: 2, capped: false },
		content: { markdown: "# A title\n\nhello [there](https://example.com/there)", text: "Menu\nA title\nhello there\nFooter", html: "<h1>A title</h1><p>hello</p>", raw_html: null, links: [{ url: "https://example.com/there", text: "there" }] },
		truncated: { markdown: false, text: false, html: false, raw_html: false },
		stats: { text_len: 20, visible_len: 30, html_len: 28, ms: 3, elements_inspected: 9, elements_cap: 60000, capped: false, hidden_removed: 2, fading_kept: 1, dropped: 0 },
		...over,
	};
}

/** @param {Partial<World>} [overrides] */
function setup(overrides = {}) {
	const nav = {
		onBeforeNavigate: new FakeEvent(),
		onCompleted: new FakeEvent(),
		onErrorOccurred: new FakeEvent(),
		onCommitted: new FakeEvent(),
		onHistoryStateUpdated: new FakeEvent(),
		onReferenceFragmentUpdated: new FakeEvent(),
	};
	/** @type {string[]} */
	const calls = [];
	/** @type {Record<string, any>[]} */
	const sent = [];
	/** @type {{ nav: any, sealed: boolean, detached: boolean, retired: boolean, opts: any } | null} */
	let tabGuard = null;
	let attempt = 0;
	/** The job tab was released and the browser closed it. */
	let closed = false;

	/** @param {string} url */
	const load = (url) => {
		nav.onBeforeNavigate.fire({ tabId: TAB, frameId: 0, url });
		setTimeout(() => nav.onCompleted.fire({ tabId: TAB, frameId: 0, url }), 5);
	};
	/** @type {World} */
	const world = {
		onNavigate: (_tabId, url) => load(url),
		ensure: async () => STORE,
		precheck: async () => ({ verdict: null }),
		script: (name, args) => (name === "settle" ? SETTLED : extracted(args.html === true ? {} : { content: { ...extracted().content, html: null } })),
		vendor: () => {},
		tabUrl: "https://example.com/final",
		paused: false,
		maxResultBytes: 8388608,
		acquire: async () => ({ windowId: WINDOW, tabId: TAB }),
		sawTopFrame: true,
		match: () => null,
		admit: () => 0,
		inScope: () => true,
		guarded: () => true,
		workers: () => [{ ok: true, found: 0, removed: 0 }],
		survives: false,
		...overrides,
	};
	const sink = logSink();
	/** @type {Record<string, unknown>[]} */
	const injected = [];
	/** @type {string[]} files injected, in order */
	const files = [];
	/** @type {Record<string, unknown>[]} how the tab was asked for its service workers, call by call */
	const workerCalls = [];
	/** @type {[string, unknown][]} the failed navigations the guard of the job tab was told of: address and the browser's word */
	const failures = [];
	/** @param {string} url a load of the job tab whose document the browser reports as committed, as a real one is */
	const loadCommitted = (url) => {
		nav.onBeforeNavigate.fire({ tabId: TAB, frameId: 0, url });
		nav.onCommitted.fire({ tabId: TAB, frameId: 0, url });
		setTimeout(() => nav.onCompleted.fire({ tabId: TAB, frameId: 0, url }), 5);
	};

	const jobs = new Jobs({
		send: (msg) => {
			const check = validateMessage(msg, DIRECTION.TO_DAEMON);
			assert.equal(check.ok, true, `every frame is valid: ${check.ok ? "" : check.error}`);
			sent.push(msg);
			return true;
		},
		maxResultBytes: () => world.maxResultBytes,
		isPaused: () => world.paused,
		container: { ensure: () => world.ensure() },
		window: {
			name: "fake",
			acquire: async (cookieStoreId) => {
				calls.push(`acquire:${cookieStoreId}`);
				return world.acquire();
			},
			navigate: async (tabId, url) => {
				calls.push(`navigate:${url}`);
				world.onNavigate(tabId, url, attempt++);
			},
			release: async (tabId) => {
				calls.push(`release:${tabId}`);
				if (!world.survives) closed = true;
				world.onRelease?.();
			},
			popOut: async (tabId) => {
				calls.push(`popOut:${tabId}`);
				return WINDOW + 1;
			},
			closeForeign: async () => "kept",
			releaseAll: async () => {
				calls.push("releaseAll");
			},
			adoptOrSweep: async () => ({ adopted: false, closedWindows: 0, closedTabs: 0, disowned: 0 }),
			idle: async () => {},
			isOpen: () => true,
			close: async () => {},
			snapshot: () => ({ windowId: WINDOW, parkTabId: 1, jobTabs: [], handoffWindows: [] }),
		},
		guard: /** @type {any} */ ({
			precheck: (/** @type {string} */ url) => {
				calls.push("precheck");
				return world.precheck(url);
			},
			widen: (/** @type {string} */ reason) => {
				calls.push(`widen:${reason}`);
			},
			attach: (/** @type {number} */ tabId, /** @type {any} */ opts) => {
				calls.push(`attach:${tabId}:${opts.cookieStoreId}`);
				const g = {
					nav: { redirectOrigins: /** @type {string[]} */ ([]), httpStatus: /** @type {number | null} */ (200), contentType: /** @type {string | null} */ ("text/html") },
					sealed: false,
					detached: false,
					retired: false,
					get sawTopFrame() {
						return world.sawTopFrame;
					},
					opts,
					navigationFailed(/** @type {string} */ url, /** @type {unknown} */ error) {
						failures.push([url, error]);
					},
					// What the real guard says of a document it never saw the response of: the job is ended there.
					committed(/** @type {string} */ url) {
						if (world.guarded(url)) return true;
						g.sealed = true;
						opts.onVerdict({ outcome: "error", code: "unguarded_response", message: "the page was answered without a response the request guard saw (by a service worker of the site, or from the browser's history)" });
						return false;
					},
					// The real guard ends the job itself when an address lies outside the tab's rule.
					topFrameAt(/** @type {string} */ url) {
						if (world.inScope(url)) return true;
						g.sealed = true;
						opts.onVerdict({ outcome: "policy_blocked", code: "redirect_out_of_scope", message: "the page tried to leave the part of the site the operator opted in, for https://elsewhere.example" });
						return false;
					},
					seal() {
						g.sealed = true;
						calls.push("seal");
					},
					detach() {
						g.detached = true;
						calls.push("detach");
					},
					retire() {
						g.sealed = true;
						g.retired = true;
						calls.push("retire");
					},
					// What the real guard says of a tab whose page does not finish loading: numbers and fixed words.
					diagnose() {
						calls.push("diagnose");
						return { top_load: "passed", top_requests: 2, top_after_commit: 1, top_asked_ms: 180, answers_owed: 2, top_answer_owed: false, answer_oldest_ms: 150, lookups_under_way: 1, lookups: 9, lookups_shared: 3, lookups_failed: 0, lookups_refused: 0, lookups_deadline: 1, lookup_slowest_ms: 200, cancelled: 12, cancelled_most: "dns*9,private*3", file_tried: false, download: false };
					},
				};
				tabGuard = g;
				return g;
			},
		}),
		policy: { blocklist: DEFAULT_BLOCKLIST, allowLoopbackPorts: [] },
		optin: {
			match: (url) => world.match(url),
			admit: (rule) => {
				calls.push(`admit:${rule.host}${rule.pathPrefix}`);
				return world.admit(rule);
			},
		},
		optinPolicy: {},
		tabs: /** @type {any} */ ({
			executeScript: async (/** @type {number} */ _tabId, /** @type {{ code?: string, file?: string }} */ details) => {
				if (details.code !== undefined) {
					injected.push({ code: details.code });
					const call = /^globalThis\.__bgw(Extract|Search)\((\{.*\})\);$/.exec(details.code);
					// The call is the last expression of the injected code: its value comes back.
					return [call === null ? undefined : world.script(call[1] === "Search" ? "search" : "extract", JSON.parse(call[2]))];
				}
				const file = String(details.file);
				files.push(file);
				if (file === "/content/workers.js") {
					calls.push("workers");
					workerCalls.push(details);
					return world.workers(details);
				}
				if (file === "/content/settle.js") return [world.script("settle", {})];
				if (file === "/vendor/defuddle.full.js") world.vendor();
				// The bundle and extract.js only define things.
				return [undefined];
			},
			get: async () => {
				if (closed) throw new Error("Invalid tab ID");
				return { id: TAB, url: world.tabUrl, ...(world.tabStatus === undefined ? {} : { status: world.tabStatus }) };
			},
		}),
		webNavigation: /** @type {any} */ (nav),
		log: sink.log,
		onActivity: () => {},
		tuning: { errorGraceMs: 30, pollMs: 5, backstopMs: 150, releaseTimeoutMs: 300, extractTimeoutMs: 200, downloadGraceMs: 40, recloseMs: [25, 25] },
	});

	/**
	 * @param {string} id
	 * @param {Record<string, unknown>} [over]
	 */
	const start = (id, over = {}) => {
		const msg = makeMessage(MSG.JOB_START, {
			job: id,
			kind: "fetch",
			url: "https://example.com/start",
			session: "auto",
			wait: { timeout_ms: 400, settle_ms: 20, dwell_ms: 0, human_wait_ms: 0, scroll: "none" },
			extract: { markdown: true, text: true, html: true, raw_html: false, links: true, adapter: "auto" },
			files: null,
			...over,
		});
		assert.equal(validateMessage(msg, DIRECTION.TO_EXT).ok, true);
		jobs.start(msg);
	};
	/** @param {string} id @returns {Promise<Record<string, any>>} the one result of a job */
	const result = async (id) => {
		await until(() => sent.some((m) => m.type === MSG.JOB_RESULT && m.job === id), { timeoutMs: 3000, what: `the result of ${id}` });
		await sleep(30);
		const results = sent.filter((m) => m.type === MSG.JOB_RESULT && m.job === id);
		assert.equal(results.length, 1, "exactly one result");
		return results[0];
	};
	/** @returns {Record<string, unknown>[]} the arguments of every extractor call, oldest first */
	const extractCalls = () => injected.map((i) => /^globalThis\.__bgwExtract\((\{.*\})\);$/.exec(String(i.code))).filter((m) => m !== null).map((m) => JSON.parse(m[1]));
	return { jobs, world, nav, calls, sent, sink, injected, files, workerCalls, failures, loadCommitted, extractCalls, start, result, load, guard: () => /** @type {NonNullable<typeof tabGuard>} */ (tabGuard) };
}

test("a job from start to result: order of steps, frames, content", async () => {
	const t = setup();
	t.start("j_ok");
	const r = await t.result("j_ok");
	assert.deepEqual(t.calls, ["precheck", `acquire:${STORE}`, `attach:${TAB}:${STORE}`, "navigate:https://example.com/start", "seal", `release:${TAB}`, "detach"]);
	assert.deepEqual(
		t.sent.map((m) => (m.type === MSG.JOB_PROGRESS ? `progress:${m.phase}` : m.type)),
		[MSG.JOB_ACCEPTED, "progress:navigating", "progress:settling", "progress:extracting", MSG.JOB_RESULT],
	);
	assert.deepEqual(t.sent[0], makeMessage(MSG.JOB_ACCEPTED, { job: "j_ok", cookie_scope: "container", rule: null }));
	assert.equal(r.outcome, "ok");
	assert.equal(r.error, null);
	assert.equal(r.cookie_scope, "container");
	assert.deepEqual(r.nav, { requested_url: "https://example.com/start", final_url: "https://example.com/final", redirect_origins: [], http_status: 200, content_type: "text/html", body_bytes: null });
	assert.deepEqual(r.page, { title: "A title", author: "An Author", published: "2026-03-14T08:30:00Z", lang: "en", site: "Example Site", word_count: 4, extractor: "defuddle@0.19.4" });
	assert.deepEqual(r.content, {
		markdown: "# A title\n\nhello [there](https://example.com/there)",
		text: "Menu\nA title\nhello there\nFooter",
		html: "<h1>A title</h1><p>hello</p>",
		raw_html: null,
		links: [{ url: "https://example.com/there", text: "there" }],
		results: [],
	});
	assert.deepEqual(r.extraction, { view: "article", coverage_pct: 80, hidden_removed: 2, capped: false });
	assert.deepEqual(r.truncated, { markdown: false, text: false, html: false, raw_html: false });
	// The extractor: the vendored bundle, then the extractor, then one call with the job's flags and the protocol's limits.
	// In between, the look for a challenge or a block: one read-only script.
	assert.deepEqual(t.files, ["/content/settle.js", "/content/detect-dom.js", "/vendor/defuddle.full.js", "/content/extract.js"]);
	assert.deepEqual(t.extractCalls(), [{ markdown: true, text: true, html: true, rawHtml: true, links: true, maxMarkdownChars: 8388608, maxTextChars: 8388608, maxHtmlChars: 8388608, maxRawHtmlChars: LIMITS.MAX_RAW_HTML_CHARS, maxLinks: LIMITS.MAX_LINKS, defuddle: true }]);
	assert.equal(t.sink.count("job.extract_fallback"), 0);
	// What is logged about the extraction: counts, the view and the extractor's name, nothing of the page.
	assert.deepEqual(t.sink.entries.find((e) => e.event === "job.extracted")?.fields, { job: "j_ok", extractor: "defuddle@0.19.4", view: "article", coverage_pct: 80, hidden_removed: 2, fading_kept: 1, elements_inspected: 9, capped: false, defuddle_failed: false, ms: 3 });
	assert.equal(r.render.visibility, "visible");
	assert.equal(r.render.raf_hz, 59.94);
	assert.equal(r.render.settled, true);
	assert.equal(r.render.scrolled_px, 0);
	assert.equal(r.tab_kept_open, false);
	assert.equal(r.detect, null);
	assert.equal(t.jobs.current(), null);
	// The guard is told nothing of the address check before the tab: it asks for itself. It is gone afterwards.
	assert.equal("verifiedHosts" in t.guard().opts, false);
	assert.equal(t.guard().detached, true);
	// Only numbers and booleans are ever turned into injected code.
	assert.equal(t.injected.length, 2);
	for (const { code } of t.injected) assert.match(String(code), /^globalThis\.(__bgwSettle = |__bgwExtract\()\{("[A-Za-z]+":(-?[0-9.]+|true|false),?)+\}\)?;$/);
	// No listeners are left on the navigation events.
	assert.equal(t.nav.onCompleted.listeners.length, 0);
	assert.equal(t.nav.onBeforeNavigate.listeners.length, 0);
	assert.equal(t.nav.onErrorOccurred.listeners.length, 0);
});

test("the result says where the time of the job went - every phase, whole milliseconds, what did not happen is 0", async () => {
	const t = setup({ script: (name) => (name === "settle" ? { ...SETTLED, scrolledPx: 900, scrollSteps: 3, walkMs: 412.4 } : extracted()) });
	t.start("j_time", { wait: { timeout_ms: 2000, settle_ms: 100, dwell_ms: 120, human_wait_ms: 0, scroll: "lazy" } });
	const r = await t.result("j_time");
	assert.equal(r.outcome, "ok");
	const tm = r.render.timings;
	assert.deepEqual(Object.keys(tm), [...TIMING_PHASES]);
	for (const [phase, value] of Object.entries(tm)) assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= LIMITS.MAX_TIMEOUT_MS, `${phase}: ${value}`);
	// What the walk took is the settle script's own count; the dwell is the pause that was asked for.
	assert.equal(tm.scroll_ms, 412);
	assert.ok(tm.dwell_ms >= 100 && tm.dwell_ms < 600, `dwell ${tm.dwell_ms}`);
	// No challenge, nothing parked: those phases did not happen.
	assert.deepEqual([tm.grace_ms, tm.parked_ms, tm.handoff_ms, tm.cleared_settle_ms], [0, 0, 0, 0]);
	// The phases add up to no more than the job took in all.
	const sum = tm.prep_ms + tm.nav_ms + tm.settle_ms + tm.dwell_ms + tm.extract_ms;
	assert.ok(sum <= r.render.elapsed_ms + 5, `${sum} of ${r.render.elapsed_ms}`);
	assert.ok(r.render.elapsed_ms - sum < 400, `little of the time is unaccounted for: ${r.render.elapsed_ms - sum} ms`);
	// A walk whose length the page reports oddly is not taken on trust.
	for (const [reported, expected] of /** @type {[unknown, number][]} */ ([["long", 0], [-5, 0], [NaN, 0], [1e15, LIMITS.MAX_TIMEOUT_MS], [undefined, 0]])) {
		const odd = setup({ script: (name) => (name === "settle" ? { ...SETTLED, walkMs: reported } : extracted()) });
		odd.start("j_odd", { wait: { timeout_ms: 2000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "lazy" } });
		assert.equal((await odd.result("j_odd")).render.timings.scroll_ms, expected, String(reported));
	}
	// A job that never got a tab has them all the same: all 0.
	const refused = setup();
	refused.world.paused = true;
	refused.start("j_refused");
	const none = await refused.result("j_refused");
	assert.equal(none.error.code, "paused");
	assert.deepEqual(none.render.timings, zeroTimings());
});

test("the settle script is given the job's quiet time and a budget, and no stretch for hidden pages", async () => {
	const t = setup();
	t.start("j_args", { wait: { timeout_ms: 2000, settle_ms: 300, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	await t.result("j_args");
	const settle = JSON.parse(String(t.injected[0].code).replace(/^globalThis\.__bgwSettle = /, "").replace(/;$/, ""));
	assert.equal(settle.quietMs, 300);
	assert.equal(settle.capMs, 5000);
	assert.equal("hiddenFactor" in settle, false, "a hidden page is not waited for longer: it is not waited for in the page at all");
	assert.ok(settle.budgetMs > 1500 && settle.budgetMs <= 2300, `budget ${settle.budgetMs}`);
	// A job that does not ask for it is not walked down.
	assert.equal(settle.scroll, false);
	assert.equal((await t.result("j_args")).render.scrolled_px, 0);
});

test("wait.scroll lazy: the settle script is told to walk down the page, within bounds, and how far it got is reported", async () => {
	const t = setup({ script: (name) => (name === "settle" ? { ...SETTLED, scrolledPx: 4321.6, scrollSteps: 7 } : extracted()) });
	t.start("j_scroll", { wait: { timeout_ms: 2000, settle_ms: 300, dwell_ms: 0, human_wait_ms: 0, scroll: "lazy" } });
	const r = await t.result("j_scroll");
	const settle = JSON.parse(String(t.injected[0].code).replace(/^globalThis\.__bgwSettle = /, "").replace(/;$/, ""));
	assert.deepEqual({ scroll: settle.scroll, steps: settle.scrollSteps, ms: settle.scrollMs }, { scroll: true, steps: 24, ms: 6000 });
	// And the wider bounds for a page that grows when its end is reached (a feed): twenty seconds, 120 steps, 60000 px.
	assert.deepEqual({ growMs: settle.growMs, growSteps: settle.growSteps, growMaxPx: settle.growMaxPx }, { growMs: 20000, growSteps: 120, growMaxPx: 60000 });
	assert.equal(r.outcome, "ok");
	assert.equal(r.cookie_scope, "container", "only a tab of the gateway container is walked down");
	assert.equal(r.render.scrolled_px, 4322);
	// A job that asks for no walk is offered no wider bounds either.
	const still = setup();
	still.start("j_still", { wait: { timeout_ms: 2000, settle_ms: 300, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	await still.result("j_still");
	const stillArgs = JSON.parse(String(still.injected[0].code).replace(/^globalThis\.__bgwSettle = /, "").replace(/;$/, ""));
	assert.deepEqual({ scroll: stillArgs.scroll, growMs: stillArgs.growMs }, { scroll: false, growMs: 0 });
	// What the page says about it is not taken on trust.
	for (const [reported, expected] of /** @type {[unknown, number][]} */ ([["far", 0], [-5, 0], [NaN, 0], [1e12, 100000000], [undefined, 0]])) {
		const odd = setup({ script: (name) => (name === "settle" ? { ...SETTLED, scrolledPx: reported } : extracted()) });
		odd.start("j_odd", { wait: { timeout_ms: 2000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "lazy" } });
		assert.equal((await odd.result("j_odd")).render.scrolled_px, expected, String(reported));
	}
});

test("a page that loaded without the guard having heard it is not used: guard_blind, and the guard listens to everything again", async () => {
	const t = setup({ sawTopFrame: false });
	t.start("j_blind");
	const r = await t.result("j_blind");
	assert.deepEqual({ outcome: r.outcome, code: r.error.code, retryable: r.error.retryable }, { outcome: "error", code: "guard_blind", retryable: true });
	assert.equal(r.content, null);
	assert.equal(r.page, null);
	assert.deepEqual(t.calls, ["precheck", `acquire:${STORE}`, `attach:${TAB}:${STORE}`, "navigate:https://example.com/start", "widen:tab_filter_deaf", "seal", `release:${TAB}`, "detach"]);
	assert.deepEqual(t.files, [], "nothing was injected into that page");
});

test("a page whose settle script says hidden takes the hidden path; when the quiet check gets no answer it is reported hidden and not settled", async () => {
	const t = setup({ script: (name) => (name === "settle" ? { ok: true, settled: false, visibility: "hidden", bailed: true, rafHz: 0 } : extracted()) });
	t.start("j_hidden", { wait: { timeout_ms: 2000, settle_ms: 20, dwell_ms: 40, human_wait_ms: 0, scroll: "lazy" } });
	const r = await t.result("j_hidden");
	assert.equal(r.outcome, "ok");
	assert.deepEqual({ v: r.render.visibility, hz: r.render.raf_hz, settled: r.render.settled }, { v: "hidden", hz: null, settled: false });
	assert.deepEqual({ scroll: r.render.scroll, dwell: r.render.dwell, px: r.render.scrolled_px }, { scroll: "skipped_hidden", dwell: "skipped_hidden", px: 0 });
	// The extractor ran all the same.
	assert.equal(r.content.markdown.startsWith("# A title"), true);
	assert.deepEqual(t.sink.entries.find((e) => e.event === "job.hidden_path")?.fields, { job: "j_hidden", quiet_ms: 20, settled: false, scroll: "skipped_hidden" });
});

test("probe: page facts, no content; fetch: only what the job asks for", async () => {
	const t = setup();
	t.start("j_probe", { kind: "probe" });
	const probe = await t.result("j_probe");
	assert.equal(probe.outcome, "ok");
	assert.equal(probe.content, null);
	assert.equal(probe.page.title, "A title");
	assert.equal(probe.page.extractor, "defuddle@0.19.4");
	// What is known about the page all the same: how it would have been read.
	assert.deepEqual(probe.extraction, { view: "article", coverage_pct: 80, hidden_removed: 2, capped: false });
	// Whatever the job's flags say, a probe asks the extractor for no content at all.
	assert.deepEqual(t.extractCalls().map((c) => [c.markdown, c.text, c.html, c.links]), [[false, false, false, false]]);

	for (const flags of [
		{ markdown: true, text: true, html: false, raw_html: false, links: true },
		{ markdown: true, text: false, html: false, raw_html: false, links: true },
		{ markdown: false, text: true, html: true, raw_html: false, links: false },
		{ markdown: false, text: false, html: false, raw_html: false, links: false },
	]) {
		const f = setup({
			script: (name, args) =>
				name === "settle"
					? SETTLED
					: extracted({ content: { markdown: args.markdown ? "md" : null, text: args.text ? "all of it" : null, html: args.html ? "<p>h</p>" : null, links: args.links ? [{ url: "https://example.com/a", text: "a" }] : [] } }),
		});
		f.start("j_flags", { extract: { ...flags, adapter: "auto" } });
		const r = await f.result("j_flags");
		assert.deepEqual(f.extractCalls().map((c) => [c.markdown, c.text, c.html, c.links]), [[flags.markdown, flags.text, flags.html, flags.links]]);
		assert.deepEqual(r.content, { markdown: flags.markdown ? "md" : null, text: flags.text ? "all of it" : null, html: flags.html ? "<p>h</p>" : null, raw_html: null, links: flags.links ? [{ url: "https://example.com/a", text: "a" }] : [], results: [] });
	}
});

test("extraction falls back to the text path when the bundle or the extractor fails", async () => {
	// The bundle cannot be injected.
	const noBundle = setup({
		vendor: () => {
			throw new Error("Unable to load script moz-extension://0f8c2a3e/vendor/defuddle.full.js");
		},
		script: (name, args) => (name === "settle" ? SETTLED : extracted({ page: { ...extracted().page, extractor: args.defuddle === false ? "innertext" : "defuddle@0.19.4" } })),
	});
	noBundle.start("j_nobundle");
	let r = await noBundle.result("j_nobundle");
	assert.equal(r.outcome, "ok");
	assert.equal(r.page.extractor, "innertext");
	assert.deepEqual(noBundle.extractCalls().map((c) => c.defuddle), [false], "the second go is without Defuddle");
	assert.deepEqual(noBundle.files, ["/content/settle.js", "/content/detect-dom.js", "/vendor/defuddle.full.js", "/content/extract.js"], "and does not inject the bundle again");
	assert.equal(noBundle.sink.count("job.extract_fallback"), 1);
	// The reason is logged without the extension's address.
	assert.equal(/moz-extension:\/\//.test(noBundle.sink.text()), false);

	// The extractor throws, hangs or answers nonsense with Defuddle, and works without.
	for (const broken of [
		() => {
			throw new Error("too much recursion");
		},
		() => new Promise(() => {}),
		() => ({ ok: false, error: "extract_threw" }),
		() => "not an object",
		() => null,
	]) {
		const t = setup({ script: (name, args) => (name === "settle" ? SETTLED : args.defuddle === true ? broken() : extracted({ page: { ...extracted().page, extractor: "innertext" } })) });
		t.start("j_fallback", { wait: { timeout_ms: 2000, settle_ms: 20, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
		r = await t.result("j_fallback");
		assert.equal(r.outcome, "ok", JSON.stringify(r.error));
		assert.equal(r.page.extractor, "innertext");
		assert.deepEqual(t.extractCalls().map((c) => c.defuddle), [true, false]);
		// The same flags and limits both times.
		assert.deepEqual({ ...t.extractCalls()[0], defuddle: 0 }, { ...t.extractCalls()[1], defuddle: 0 });
	}
});

test("only when the text path fails too the job ends as extract_failed", async () => {
	const t = setup({
		script: (name) => {
			if (name === "settle") return SETTLED;
			throw new Error("the extractor is broken");
		},
	});
	t.start("j_failed", { wait: { timeout_ms: 2000, settle_ms: 20, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	const r = await t.result("j_failed");
	assert.deepEqual({ outcome: r.outcome, code: r.error.code, retryable: r.error.retryable }, { outcome: "error", code: "extract_failed", retryable: false });
	assert.equal(r.content, null);
	assert.equal(r.page, null);
	assert.equal(r.nav.final_url, null);
	// Twice per document (with and without Defuddle), on at most two documents.
	assert.deepEqual(t.extractCalls().map((c) => c.defuddle), [true, false, true, false]);
	assert.deepEqual(t.calls.slice(-3), ["seal", `release:${TAB}`, "detach"]);
});

test("a download in the gateway container ends the running job as unsupported / download", async () => {
	const t = setup({ onNavigate: () => {} });
	assert.equal(t.jobs.downloadStarted(), false, "no job, nothing to end");
	t.start("j_download", { wait: { timeout_ms: 5000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	await until(() => t.calls.some((c) => c.startsWith("navigate")));
	assert.equal(t.jobs.downloadStarted(), true);
	assert.equal(t.jobs.downloadStarted(), true, "told twice, one result");
	const r = await t.result("j_download");
	assert.deepEqual({ outcome: r.outcome, code: r.error.code, retryable: r.error.retryable }, { outcome: "unsupported", code: "download", retryable: false });
	assert.equal(r.content, null);
	assert.deepEqual(t.calls.slice(-3), ["seal", `release:${TAB}`, "detach"]);
	assert.equal(t.jobs.downloadStarted(), false);
	// The tab was sealed and closed the moment the download was caught, not when the job got round to it:
	// a page that starts one download may be starting a hundred.
	assert.deepEqual(t.calls.slice(t.calls.findIndex((c) => c.startsWith("navigate")) + 1), ["seal", `release:${TAB}`, "seal", `release:${TAB}`, "detach"]);

	// A download nobody can tell the owner of (the operator has the same site open): the job ends as well,
	// with a code of its own, and its tab goes at once.
	const doubt = setup({ onNavigate: () => {} });
	assert.equal(doubt.jobs.downloadAmbiguous(), false, "no job, nothing to end");
	doubt.start("j_doubt", { wait: { timeout_ms: 5000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	await until(() => doubt.calls.some((c) => c.startsWith("navigate")));
	assert.equal(doubt.jobs.downloadAmbiguous(), true);
	assert.equal(doubt.jobs.downloadStarted(), true, "what was said first stands");
	const d = await doubt.result("j_doubt");
	assert.deepEqual({ outcome: d.outcome, code: d.error.code, retryable: d.error.retryable }, { outcome: "error", code: "download_ambiguous", retryable: false });
	assert.equal(d.content, null);
	assert.deepEqual(doubt.calls.slice(doubt.calls.findIndex((c) => c.startsWith("navigate")) + 1), ["seal", `release:${TAB}`, "seal", `release:${TAB}`, "detach"]);

	// A job that has no tab yet cannot have started it.
	/** @type {(v: { windowId: number, tabId: number }) => void} */
	let deliver = () => {};
	const early = setup({ acquire: () => new Promise((resolve) => (deliver = resolve)) });
	early.start("j_notab");
	await until(() => early.calls.some((c) => c.startsWith("acquire")));
	assert.equal(early.jobs.downloadStarted(), false);
	early.jobs.cancel("j_notab", "client_gone");
	await early.result("j_notab");
	deliver({ windowId: WINDOW, tabId: TAB });
});

test("a navigation that turned into a download: the backstop's word is waited for and wins over not_scriptable", async () => {
	// The tab shows no page (it stayed on about:blank), so no script runs in it.
	const blank = { tabUrl: "about:blank", script: () => { throw new Error("Missing host permission for the tab"); } };
	const t = setup(blank);
	t.start("j_navdl");
	await until(() => t.files.includes("/content/settle.js"));
	setTimeout(() => t.jobs.downloadStarted(), 10);
	const r = await t.result("j_navdl");
	assert.deepEqual({ outcome: r.outcome, code: r.error.code }, { outcome: "unsupported", code: "download" });
	// Without a download the answer is what it was, a moment later.
	const plain = setup(blank);
	const started = Date.now();
	plain.start("j_nodl");
	const r2 = await plain.result("j_nodl");
	assert.deepEqual({ outcome: r2.outcome, code: r2.error.code }, { outcome: "unsupported", code: "not_scriptable" });
	assert.ok(Date.now() - started >= 40, "the grace time for the downloads backstop");
});

test("a URL the policy refuses: no container, no window, no request", async () => {
	for (const [url, code] of /** @type {[string, string][]} */ ([
		["http://127.0.0.1:8791/v1/status", "private_address"],
		["https://mail.google.com/", "blocklisted"],
		["file:///etc/passwd", "scheme_not_allowed"],
	])) {
		const t = setup();
		t.start("j_policy", { url });
		const r = await t.result("j_policy");
		assert.equal(r.outcome, "policy_blocked", url);
		assert.equal(r.error.code, code);
		assert.equal(r.error.retryable, false);
		assert.equal(r.cookie_scope, null);
		assert.deepEqual(t.calls, []);
		assert.deepEqual(t.sent.map((m) => m.type), [MSG.JOB_RESULT], "not even accepted");
	}
});

test("fail closed: without the container nothing is opened or loaded", async () => {
	const t = setup({
		ensure: async () => {
			throw new ContainerError("the gateway container is not available: disabled");
		},
	});
	t.start("j_nocontainer");
	const r = await t.result("j_nocontainer");
	assert.equal(r.outcome, "error");
	assert.equal(r.error.code, "container_unavailable");
	assert.equal(r.cookie_scope, null);
	assert.deepEqual(t.calls, [], "no window, no tab, no navigation");
	assert.deepEqual(t.sent.map((m) => m.type), [MSG.JOB_RESULT]);
});

test("the address check before the first navigation ends the job without a tab", async () => {
	const t = setup({ precheck: async () => ({ verdict: { outcome: "policy_blocked", code: "private_address", message: "the host name resolves to a private address" } }) });
	t.start("j_dns");
	const r = await t.result("j_dns");
	assert.equal(r.outcome, "policy_blocked");
	assert.equal(r.error.code, "private_address");
	assert.equal(r.cookie_scope, null);
	assert.deepEqual(t.calls, ["precheck"]);

	const failed = setup({ precheck: async () => ({ verdict: { outcome: "error", code: "dns_failed", message: "the host name could not be resolved" } }) });
	failed.start("j_dnsfail");
	const r2 = await failed.result("j_dnsfail");
	assert.deepEqual({ outcome: r2.outcome, code: r2.error.code, retryable: r2.error.retryable }, { outcome: "error", code: "dns_failed", retryable: true });
});

test("a window that cannot be had fails the job", async () => {
	const t = setup({
		acquire: async () => {
			throw new Error("the new tab is not in the gateway container");
		},
	});
	t.start("j_nowindow");
	const r = await t.result("j_nowindow");
	assert.equal(r.outcome, "error");
	assert.equal(r.error.code, "window_unavailable");
	assert.equal(r.cookie_scope, null);
	assert.equal(t.calls.some((c) => c.startsWith("navigate")), false);
});

test("a guard verdict ends the job at once with the guard's outcome; the tab is closed", async () => {
	/** @type {[import("../../extension/background/guard.js").Verdict, boolean][]} */
	const verdicts = [
		[{ outcome: "policy_blocked", code: "private_address", message: "the page leads to a private or local address" }, false],
		[{ outcome: "unsupported", code: "attachment", message: "the server offers a download, not a page" }, false],
		[{ outcome: "error", code: "auth_required", message: "the page asks for HTTP authentication" }, false],
		[{ outcome: "error", code: "dns_failed", message: "the host name could not be resolved" }, true],
	];
	for (const [verdict, retryable] of verdicts) {
		// The navigation never completes: the request was cancelled.
		const t = setup({ onNavigate: () => {} });
		t.start("j_verdict");
		await until(() => t.calls.some((c) => c.startsWith("navigate")));
		t.guard().nav.redirectOrigins.push("http://10.0.0.1");
		t.guard().nav.httpStatus = 302;
		t.guard().opts.onVerdict(verdict);
		const r = await t.result("j_verdict");
		assert.equal(r.outcome, verdict.outcome);
		assert.deepEqual(r.error, { code: verdict.code, message: verdict.message, retryable, retry_after_s: null });
		assert.equal(r.content, null);
		assert.equal(r.page, null);
		assert.equal(r.cookie_scope, "container");
		assert.deepEqual(r.nav.redirect_origins, ["http://10.0.0.1"]);
		assert.equal(r.nav.final_url, null);
		assert.deepEqual(t.calls.slice(-3), ["seal", `release:${TAB}`, "detach"]);
	}
});

test("a verdict that arrives while the page settles still wins over the content", async () => {
	const t = setup({
		script: (name) => {
			if (name === "settle") return new Promise(() => {});
			throw new Error("never reached");
		},
	});
	t.start("j_late", { wait: { timeout_ms: 2000, settle_ms: 20, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	await until(() => t.sent.some((m) => m.phase === "settling"));
	t.guard().opts.onVerdict({ outcome: "policy_blocked", code: "blocklisted", message: "the page leads to a blocklisted site" });
	const r = await t.result("j_late");
	assert.equal(r.outcome, "policy_blocked");
	assert.equal(r.content, null);
});

test("navigation error: one automatic retry, which may succeed", async () => {
	const t = setup({
		onNavigate: (_tab, url, attempt) => {
			if (attempt === 0) {
				t.nav.onBeforeNavigate.fire({ tabId: TAB, frameId: 0, url });
				t.nav.onErrorOccurred.fire({ tabId: TAB, frameId: 0, url, error: "NS_ERROR_NET_RESET" });
			} else {
				t.load(url);
			}
		},
	});
	t.start("j_retry");
	const r = await t.result("j_retry");
	assert.equal(r.outcome, "ok");
	assert.equal(t.calls.filter((c) => c.startsWith("navigate")).length, 2);
	assert.equal(t.sink.count("job.navigation_retry"), 1);
});

test("navigation error twice: navigation_failed, and no third attempt", async () => {
	const t = setup({
		onNavigate: (_tab, url) => {
			t.nav.onBeforeNavigate.fire({ tabId: TAB, frameId: 0, url });
			t.nav.onErrorOccurred.fire({ tabId: TAB, frameId: 0, url, error: "NS_ERROR_UNKNOWN_HOST <script>" });
		},
	});
	t.start("j_dead");
	const r = await t.result("j_dead");
	assert.equal(r.outcome, "error");
	assert.equal(r.error.code, "navigation_failed");
	assert.equal(r.error.retryable, true);
	assert.match(r.error.message, /NS_ERROR_UNKNOWN_HOST script\)$/, "the browser's error text is cleaned");
	assert.equal(t.calls.filter((c) => c.startsWith("navigate")).length, 2);
	assert.deepEqual(t.calls.slice(-3), ["seal", `release:${TAB}`, "detach"]);
});

test("an error that a new navigation takes over from is not a failure (script redirect)", async () => {
	const t = setup({
		onNavigate: (_tab, url) => {
			t.nav.onBeforeNavigate.fire({ tabId: TAB, frameId: 0, url });
			t.nav.onErrorOccurred.fire({ tabId: TAB, frameId: 0, url, error: "NS_BINDING_ABORTED" });
			setTimeout(() => t.load("https://example.com/moved"), 10);
		},
	});
	t.start("j_takeover");
	const r = await t.result("j_takeover");
	assert.equal(r.outcome, "ok");
	assert.equal(t.calls.filter((c) => c.startsWith("navigate")).length, 1, "no retry was needed");
});

test("events of other tabs, of frames and of the blank start page are ignored", async () => {
	const t = setup({
		onNavigate: (_tab, url) => {
			t.nav.onCompleted.fire({ tabId: TAB + 1, frameId: 0, url });
			t.nav.onCompleted.fire({ tabId: TAB, frameId: 3, url });
			t.nav.onCompleted.fire({ tabId: TAB, frameId: 0, url: "about:blank" });
		},
	});
	t.start("j_ignore", { wait: { timeout_ms: 150, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	const r = await t.result("j_ignore");
	assert.equal(r.outcome, "timeout");
});

test("a page that does not finish loading: timeout at the job's own load timeout", async () => {
	const t = setup({ onNavigate: () => {}, tabStatus: "loading" });
	const started = Date.now();
	t.start("j_slow", { wait: { timeout_ms: 200, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	const r = await t.result("j_slow");
	assert.equal(r.outcome, "timeout");
	assert.equal(r.error.code, "navigation_timeout");
	assert.ok(Date.now() - started >= 190);
	assert.equal(r.cookie_scope, "container");
	assert.deepEqual(t.calls.slice(-3), ["seal", `release:${TAB}`, "detach"]);
	// What stood in the way is written down once, before the tab is closed: where the navigation was, what the
	// browser says of the tab, and what the guard still owed. Counts, times and fixed words - no address, nothing
	// of the page.
	const stalled = t.sink.entries.filter((e) => e.event === "job.navigation_stalled");
	assert.equal(stalled.length, 1);
	const f = /** @type {Record<string, any>} */ (stalled[0].fields);
	assert.deepEqual(
		{ job: f.job, attempt: f.attempt, tab_status: f.tab_status, committed_ms: f.committed_ms, completed_ms: f.completed_ms, error_ms: f.error_ms, nav_error: f.nav_error, answers_owed: f.answers_owed, top_load: f.top_load, lookups_deadline: f.lookups_deadline },
		{ job: "j_slow", attempt: 0, tab_status: "loading", committed_ms: -1, completed_ms: -1, error_ms: -1, nav_error: null, answers_owed: 2, top_load: "passed", lookups_deadline: 1 },
	);
	assert.ok(f.started_ms >= 190 && f.started_ms < 5000, "how long ago the navigation began");
	assert.ok(t.calls.indexOf("diagnose") < t.calls.indexOf("seal"), "asked while the tab is as it was");
	for (const value of Object.values(f)) assert.ok(value === null || ["string", "number", "boolean"].includes(typeof value));
	assert.equal(JSON.stringify(f).includes("example"), false, "no address");
	// The same facts are the message of the result, on one line the daemon hands on whole: fixed words and numbers.
	assert.match(r.error.message, /^stalled try=0 tab=loading nav=\d{3,4}\/-1\/-1\/-1 top=passed\/2\/1\/180 owed=2\/n\/150 dns=9\/1\/3\/0\/0\/1\/200 cut=12:dns\*9,private\*3 file=n dl=n$/);
	assert.equal(r.error.message.includes("example"), false);
	assert.equal(r.error.retryable, true);
});

test("stallLine: one line of fixed words and numbers, whatever it is given - never longer than the daemon prints, never anything of a page", () => {
	const where = { attempt: 0, tab_status: "loading", started_ms: 60012, committed_ms: 59800, completed_ms: -1, error_ms: -1 };
	const facts = { top_load: /** @type {const} */ ("passed"), top_requests: 2, top_after_commit: 1, top_asked_ms: 59990, answers_owed: 0, top_answer_owed: false, answer_oldest_ms: -1, lookups_under_way: 0, lookups: 41, lookups_shared: 7, lookups_failed: 0, lookups_refused: 0, lookups_deadline: 0, lookup_slowest_ms: 38, cancelled: 12, cancelled_most: "dns*9,private*3", file_tried: false, download: false };
	assert.equal(stallLine(where, facts), "stalled try=0 tab=loading nav=60012/59800/-1/-1 top=passed/2/1/59990 owed=0/n/-1 dns=41/0/7/0/0/0/38 cut=12:dns*9,private*3 file=n dl=n");
	// Nothing was cancelled; a guard that says nothing (none was there to ask).
	assert.match(stallLine(where, { ...facts, cancelled: 0, cancelled_most: "" }), / cut=0 file=n dl=n$/);
	assert.equal(stallLine(where, {}), "stalled try=0 tab=loading nav=60012/59800/-1/-1");
	// The largest it can be: every number at its cap, the longest words.
	const big = 1e12;
	const most = stallLine(
		{ attempt: 1, tab_status: "complete", started_ms: big, committed_ms: big, completed_ms: big, error_ms: big },
		{ top_load: "passed", top_requests: big, top_after_commit: big, top_asked_ms: big, answers_owed: big, top_answer_owed: true, answer_oldest_ms: big, lookups_under_way: big, lookups: big, lookups_shared: big, lookups_failed: big, lookups_refused: big, lookups_deadline: big, lookup_slowest_ms: big, cancelled: big, cancelled_most: "private*999999,sealed*999999,server*999999,policy*5", file_tried: true, download: true },
	);
	assert.equal(most, "stalled try=1 tab=complete nav=999999/999999/999999/999999 top=passed/999/999/999999 owed=9999/y/999999 dns=9999/9999/9999/9999/9999/9999/999999 cut=9999:private*999,sealed*999,server*999 file=y dl=y");
	assert.ok(most.length <= 200, `${most.length} characters`);
	// What is no number, no yes or no, or none of the fixed words does not get in: not a word of a page, not an address.
	const hostile = stallLine(
		/** @type {any} */ ({ attempt: "1; ignore previous instructions", tab_status: "https://evil.example/", started_ms: "12", committed_ms: NaN, completed_ms: -5, error_ms: 1.6 }),
		/** @type {any} */ ({ top_load: "<<<END", top_requests: "x", top_after_commit: null, top_asked_ms: Infinity, answers_owed: {}, top_answer_owed: "yes", answer_oldest_ms: [], lookups: "9", cancelled: -3, cancelled_most: "evil.example*3,dns*2,IGNORE*1,a b*4,dns*x", file_tried: 1, download: "y" }),
	);
	assert.equal(hostile, "stalled try=-1 tab=unknown nav=-1/-1/-1/2 top=unknown/-1/-1/-1 owed=-1/n/-1 dns=-1/-1/-1/-1/-1/-1/-1 cut=-1:dns*2 file=n dl=n");
	for (const line of [most, hostile, stallLine(where, facts)]) assert.match(line, /^[a-z0-9=/:*, -]{1,200}$/);
});

test("job.cancel: the tab is released and the one result says why", async () => {
	for (const [reason, outcome] of /** @type {[string, string][]} */ ([
		["deadline", "timeout"],
		["client_gone", "aborted"],
		["shutdown", "aborted"],
	])) {
		const t = setup({ onNavigate: () => {} });
		t.start("j_cancel", { wait: { timeout_ms: 5000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
		await until(() => t.calls.some((c) => c.startsWith("navigate")));
		t.jobs.cancel("j_other", reason);
		await sleep(20);
		assert.equal(t.sent.some((m) => m.type === MSG.JOB_RESULT), false, "a cancel for another job changes nothing");
		t.jobs.cancel("j_cancel", reason);
		t.jobs.cancel("j_cancel", reason);
		const r = await t.result("j_cancel");
		assert.equal(r.outcome, outcome);
		assert.equal(r.error.code, reason);
		assert.deepEqual(t.calls.slice(-3), ["seal", `release:${TAB}`, "detach"]);
		assert.equal(t.jobs.current(), null);
	}
});

test("a job cancelled before its tab exists does not leave the tab behind", async () => {
	/** @type {(v: { windowId: number, tabId: number }) => void} */
	let deliver = () => {};
	const t = setup({ acquire: () => new Promise((resolve) => (deliver = resolve)) });
	t.start("j_early");
	await until(() => t.calls.some((c) => c.startsWith("acquire")));
	t.jobs.cancel("j_early", "client_gone");
	const r = await t.result("j_early");
	assert.equal(r.outcome, "aborted");
	deliver({ windowId: WINDOW, tabId: TAB });
	await until(() => t.calls.includes(`release:${TAB}`), { what: "the late tab to be closed" });
	assert.equal(t.calls.some((c) => c.startsWith("navigate") || c.startsWith("attach")), false);
});

test("link down: the job is dropped without a result, the tab is still closed", async () => {
	const t = setup({ onNavigate: () => {} });
	t.start("j_down", { wait: { timeout_ms: 5000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	await until(() => t.calls.some((c) => c.startsWith("navigate")));
	t.jobs.abortAll("link_down");
	await until(() => t.jobs.current() === null);
	await sleep(30);
	assert.equal(t.sent.some((m) => m.type === MSG.JOB_RESULT), false);
	assert.deepEqual(t.calls.slice(-3), ["seal", `release:${TAB}`, "detach"]);
});

test("pause: the running job is stopped, new ones are refused", async () => {
	const t = setup({ onNavigate: () => {} });
	t.start("j_running", { wait: { timeout_ms: 5000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	await until(() => t.calls.some((c) => c.startsWith("navigate")));
	t.world.paused = true;
	t.jobs.abortAll("paused");
	const stopped = await t.result("j_running");
	assert.deepEqual({ outcome: stopped.outcome, code: stopped.error.code, retryable: stopped.error.retryable }, { outcome: "aborted", code: "paused", retryable: false });
	const before = t.calls.length;
	t.start("j_refused");
	const refused = await t.result("j_refused");
	assert.deepEqual({ outcome: refused.outcome, code: refused.error.code }, { outcome: "error", code: "paused" });
	assert.equal(t.calls.length, before, "nothing was touched for the refused job");
});

test("a closed job tab: tab_closed; a closed window is recognised even after the job ended", async () => {
	const t = setup({ onNavigate: () => {} });
	t.start("j_tab", { wait: { timeout_ms: 5000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	await until(() => t.calls.some((c) => c.startsWith("navigate")));
	assert.equal(t.jobs.tabLost(TAB + 1), false, "another tab is none of its business");
	assert.equal(t.jobs.tabLost(TAB), true);
	const r = await t.result("j_tab");
	assert.deepEqual({ outcome: r.outcome, code: r.error.code, retryable: r.error.retryable }, { outcome: "error", code: "tab_closed", retryable: true });
	assert.equal(t.jobs.tabLost(TAB), false, "only once");
	// The window event follows the tab event, by then the job may be over.
	assert.equal(t.jobs.windowClosed(WINDOW + 1), false);
	const again = setup({ onNavigate: () => {} });
	again.start("j_win", { wait: { timeout_ms: 5000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	await until(() => again.calls.some((c) => c.startsWith("navigate")));
	again.jobs.tabLost(TAB);
	await again.result("j_win");
	assert.equal(again.jobs.windowClosed(WINDOW), true, "the job was lost to that window closing");
	assert.equal(again.jobs.windowClosed(WINDOW), false, "and that is said once");
	// With no job involved a closing window is just a closing window.
	assert.equal(setup().jobs.windowClosed(WINDOW), false);
});

test("a job tab the browser did not close keeps its guard: sealed, not let go, tried again - and let go of only when the tab is gone", async () => {
	const t = setup({ survives: true });
	t.start("j_stays");
	const r = await t.result("j_stays");
	assert.equal(r.outcome, "ok", "the result of the job does not wait for the tab");
	const end = t.calls.slice(t.calls.indexOf("seal"));
	assert.deepEqual(end.slice(0, 3), ["seal", `release:${TAB}`, "retire"], "sealed, asked to close, found still open: kept");
	assert.deepEqual([t.guard().sealed, t.guard().retired, t.guard().detached], [true, true, false]);
	assert.equal(t.sink.count("job.tab_outlived"), 1);
	assert.equal(t.jobs.busy(), true, "a tab of a job is still open");
	assert.equal(t.jobs.current(), null, "the runner is free all the same");
	// Closing is tried again, and for as long as the tab is there its guard stays.
	await until(() => t.calls.filter((c) => c === `release:${TAB}`).length === 2, { timeoutMs: 2000, what: "a second try" });
	assert.equal(t.guard().detached, false);
	// This time the browser closes it.
	t.world.survives = false;
	await until(() => t.guard().detached, { timeoutMs: 2000, what: "the guard to let go" });
	assert.equal(t.calls.filter((c) => c === `release:${TAB}`).length, 3);
	await until(() => !t.jobs.busy(), { timeoutMs: 1000, what: "the job to be over for good" });
	assert.equal(t.sink.count("job.tab_closed_late"), 1);

	// A tab that never goes: the tries end, the guard does not.
	const never = setup({ survives: true });
	never.start("j_never");
	await never.result("j_never");
	await until(() => never.sink.count("job.tab_left_open") === 1, { timeoutMs: 2000, what: "the last try" });
	assert.equal(never.calls.filter((c) => c === `release:${TAB}`).length, 3, "once with the job, twice more");
	assert.deepEqual([never.guard().sealed, never.guard().retired, never.guard().detached], [true, true, false], "still under guard");
	assert.equal(never.jobs.busy(), false);

	// A job that ends without content leaves its tab the same way.
	const failed = setup({ survives: true, onNavigate: () => {} });
	failed.start("j_cancelled", { wait: { timeout_ms: 5000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	await until(() => failed.calls.some((c) => c.startsWith("navigate")));
	failed.jobs.cancel("j_cancelled", "client_gone");
	assert.equal((await failed.result("j_cancelled")).error.code, "client_gone");
	assert.deepEqual([failed.guard().retired, failed.guard().detached], [true, false]);

	// The ordinary end: the tab is gone, and the guard with it.
	const gone = setup();
	gone.start("j_gone");
	await gone.result("j_gone");
	assert.deepEqual([gone.guard().retired, gone.guard().detached, gone.jobs.busy()], [false, true, false]);
	assert.equal(gone.calls.includes("retire"), false);
});

test("slots: 1 - a second job.start while one runs is refused, the first is not disturbed", async () => {
	const t = setup({ onNavigate: (_tab, url) => setTimeout(() => t.load(url), 60) });
	t.start("j_first");
	await until(() => t.calls.some((c) => c.startsWith("navigate")));
	assert.deepEqual(t.jobs.current(), { job: "j_first", host: "example.com", scope: "container" });
	t.start("j_second");
	const second = await t.result("j_second");
	assert.deepEqual({ outcome: second.outcome, code: second.error.code, retryable: second.error.retryable }, { outcome: "error", code: "busy", retryable: true });
	const first = await t.result("j_first");
	assert.equal(first.outcome, "ok");
	assert.equal(t.calls.filter((c) => c.startsWith("acquire")).length, 1);
});

test("a kind of job this extension does not know gets a result that says so", async () => {
	const t = setup();
	// The validator on the link lets no such frame through; the runner would not run it either.
	t.jobs.start({ v: PROTOCOL_VERSION, type: MSG.JOB_START, job: "j_odd", kind: "execute", url: "https://example.com/", session: "auto", wait: { timeout_ms: 400, settle_ms: 20, dwell_ms: 0, human_wait_ms: 0, scroll: "none" }, extract: { markdown: true, text: true, html: false, raw_html: false, links: true, adapter: "auto" }, files: null });
	const r = await t.result("j_odd");
	assert.deepEqual({ outcome: r.outcome, code: r.error.code }, { outcome: "unsupported", code: "kind_not_supported" });
	assert.deepEqual(t.calls, []);
});

// ---------------------------------------------------------------- search

/** What content/search.js hands back for a results page. @param {number} n @param {Record<string, unknown>} [over] */
function searched(n, over = {}) {
	return {
		ok: true,
		url: "https://search.example.com/find?q=wal+mode",
		title: "wal mode - Example Search",
		detector: "generic",
		results: Array.from({ length: n }, (_, i) => ({ rank: i + 1, title: `Result ${i + 1}`, url: `https://site${i + 1}.example.org/page`, snippet: `What result ${i + 1} is about, in a sentence or two.` })),
		hidden_removed: 1,
		capped: false,
		stats: { generic: n, hint: 0, ms: 4 },
		...over,
	};
}

/** @param {string} id @param {Record<string, unknown>} [over] a job.start for a search */
const searchStart = (id, over = {}) =>
	makeMessage(MSG.JOB_START, {
		job: id,
		kind: "search",
		url: "https://search.example.com/find?q=wal+mode",
		engine: "brave",
		limit: 5,
		session: "isolated",
		wait: { timeout_ms: 400, settle_ms: 20, dwell_ms: 0, human_wait_ms: 0, scroll: "none" },
		extract: { markdown: false, text: true, html: false, raw_html: false, links: true, adapter: "auto" },
		files: null,
		...over,
	});

test("a search: one results page, loaded in the container like any job, read by the search script", async () => {
	/** @type {string[]} */
	const asked = [];
	/** @type {Record<string, unknown>[]} */
	const searchArgs = [];
	const t = setup({
		// A rule that would match the engine's own address: a search does not even look.
		match: (url) => {
			asked.push(url);
			return { host: "search.example.com", pathPrefix: "/", subdomains: false };
		},
		tabUrl: "https://search.example.com/find?q=wal+mode",
		script: (name, args) => {
			if (name === "settle") return SETTLED;
			if (name === "search") return searchArgs.push(args), searched(5);
			throw new Error("the extractor was not asked for");
		},
	});
	const msg = searchStart("j_search");
	assert.deepEqual(validateMessage(msg, DIRECTION.TO_EXT), { ok: true });
	t.jobs.start(msg);
	const r = await t.result("j_search");
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	// The container, whatever the operator's rules say and whatever the frame says about the session.
	assert.equal(r.cookie_scope, "container");
	assert.deepEqual(asked, []);
	assert.deepEqual(t.calls, ["precheck", `acquire:${STORE}`, `attach:${TAB}:${STORE}`, "navigate:https://search.example.com/find?q=wal+mode", "seal", `release:${TAB}`, "detach"]);
	assert.deepEqual(t.sent[0], makeMessage(MSG.JOB_ACCEPTED, { job: "j_search", cookie_scope: "container", rule: null }));
	// Settle, the look for a human check, then the search script on top of the extractor's clone. No Defuddle.
	assert.deepEqual(t.files, ["/content/settle.js", "/content/detect-dom.js", "/content/extract.js", "/content/search.js"]);
	// The engine is told by its place in the content script's list of hints, the limit as a number: nothing else becomes code.
	assert.deepEqual(searchArgs, [{ limit: 5, hint: 1 }]);
	// A caller who wants one result gets one - of a page that has a list: the script is asked for enough to tell.
	/** @type {Record<string, unknown>[]} */
	const oneArgs = [];
	const one = setup({ script: (name, a) => (name === "settle" ? SETTLED : name === "search" ? (oneArgs.push(a), searched(Number(a.limit))) : assert.fail("no fallback: the page has a list")) });
	one.jobs.start(searchStart("j_one", { limit: 1 }));
	const single = await one.result("j_one");
	assert.deepEqual(oneArgs, [{ limit: 3, hint: 1 }]);
	assert.deepEqual([single.content.results.length, single.content.text, single.page.extractor], [1, null, "search-generic"]);
	for (const { code } of t.injected) assert.match(String(code), /^globalThis\.(__bgwSettle = |__bgwSearch\()\{("[A-Za-z]+":(-?[0-9.]+|true|false),?)+\}\)?;$/);
	assert.deepEqual(r.content, {
		markdown: null,
		text: null,
		html: null,
		raw_html: null,
		links: [],
		results: [1, 2, 3, 4, 5].map((i) => ({ rank: i, title: `Result ${i}`, url: `https://site${i}.example.org/page`, snippet: `What result ${i} is about, in a sentence or two.` })),
	});
	assert.deepEqual(r.page, { title: "wal mode - Example Search", author: null, published: null, lang: null, site: null, word_count: 0, extractor: "search-generic" });
	assert.deepEqual(r.extraction, { view: "text", coverage_pct: null, hidden_removed: 1, capped: false });
	assert.equal(r.nav.final_url, "https://search.example.com/find?q=wal+mode");
	assert.deepEqual(r.truncated, { markdown: false, text: false, html: false, raw_html: false });
	// What is logged: counts. Not the query, not the address, not a title.
	assert.deepEqual(t.sink.entries.find((e) => e.event === "job.searched")?.fields, { job: "j_search", results: 5, detector: "generic", fallback: false, generic: 5, hint: 0, hidden_removed: 1, ms: 4 });
	assert.equal(/wal|Result|site1/.test(t.sink.text()), false);

	// Session "auto" in the frame changes nothing: a search has no login.
	let lookedUp = 0;
	const auto = setup({
		match: () => {
			lookedUp += 1;
			return { host: "search.example.com", pathPrefix: "/", subdomains: false };
		},
		script: (name) => (name === "settle" ? SETTLED : searched(3)),
	});
	auto.jobs.start(searchStart("j_auto", { session: "auto" }));
	assert.equal((await auto.result("j_auto")).cookie_scope, "container");
	assert.equal(lookedUp, 0);
	// The hints: five engines by name, anything else is none.
	assert.deepEqual(SEARCH_HINTS, ["duckduckgo", "brave", "bing", "google", "startpage"]);
	for (const [engine, hint] of /** @type {[string, number][]} */ ([["duckduckgo", 0], ["google", 3], ["startpage", 4], ["mysearx", -1], ["constructor", -1]])) {
		/** @type {Record<string, unknown>[]} */
		const args = [];
		const e = setup({ script: (name, a) => (name === "settle" ? SETTLED : (args.push(a), searched(3))) });
		e.jobs.start(searchStart("j_hint", { engine, limit: 20 }));
		const hinted = await e.result("j_hint");
		assert.deepEqual(args, [{ limit: 20, hint }], engine);
		assert.equal(hinted.page.extractor, "search-generic");
	}
	// By hint, the result says so.
	const byHint = setup({ script: (name) => (name === "settle" ? SETTLED : searched(4, { detector: "hint" })) });
	byHint.jobs.start(searchStart("j_byhint"));
	assert.equal((await byHint.result("j_byhint")).page.extractor, "search-hint");
});

test("a search that finds fewer than three results hands back the page's text and links as well, and says that it fell back", async () => {
	/** @type {Record<string, unknown>[]} */
	const extractArgs = [];
	const t = setup({
		script: (name, args) => {
			if (name === "settle") return SETTLED;
			if (name === "search") return searched(2);
			extractArgs.push(args);
			return extracted({ url: "https://search.example.com/find?q=wal+mode", page: { ...extracted().page, extractor: "innertext", word_count: 9 }, extraction: { view: "text", coverage_pct: null, hidden_removed: 0, capped: false }, content: { markdown: null, text: "No more results.\nTry other words.", html: null, raw_html: null, links: [{ url: "https://help.example.org/tips", text: "search tips" }] } });
		},
	});
	t.jobs.start(searchStart("j_few"));
	const r = await t.result("j_few");
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.content.results.length, 2);
	assert.equal(r.content.text, "No more results.\nTry other words.");
	assert.deepEqual(r.content.links, [{ url: "https://help.example.org/tips", text: "search tips" }]);
	assert.equal(r.content.markdown, null);
	assert.equal(r.content.html, null);
	assert.equal(r.page.extractor, "search-fallback");
	assert.equal(r.page.word_count, 9);
	// The text and the links of what the page renders: the extractor without Defuddle, asked for exactly that.
	assert.deepEqual(t.files, ["/content/settle.js", "/content/detect-dom.js", "/content/extract.js", "/content/search.js", "/content/extract.js"]);
	assert.deepEqual(extractArgs, [{ markdown: false, text: true, html: false, links: true, maxMarkdownChars: 8388608, maxTextChars: 8388608, maxHtmlChars: 8388608, maxLinks: LIMITS.MAX_LINKS, defuddle: false }]);
	assert.equal(t.sink.entries.find((e) => e.event === "job.searched")?.fields.fallback, true);
	// None at all: the same, with an empty list.
	const none = setup({ script: (name) => (name === "settle" ? SETTLED : name === "search" ? searched(0) : extracted({ content: { markdown: null, text: "Nothing found.", html: null, raw_html: null, links: [] } })) });
	none.jobs.start(searchStart("j_none"));
	const empty = await none.result("j_none");
	assert.deepEqual([empty.outcome, empty.content.results, empty.content.text, empty.page.extractor], ["ok", [], "Nothing found.", "search-fallback"]);
	// Three is a list: no second look at the page.
	const three = setup({ script: (name) => (name === "settle" ? SETTLED : name === "search" ? searched(3) : assert.fail("no fallback for three results")) });
	three.jobs.start(searchStart("j_three"));
	assert.equal((await three.result("j_three")).content.text, null);
	// A search script that fails on the page: the job says so, like an extractor that fails.
	const broken = setup({ script: (name) => (name === "settle" ? SETTLED : { ok: false }) });
	broken.jobs.start(searchStart("j_broken"));
	const failed = await broken.result("j_broken");
	assert.deepEqual([failed.outcome, failed.error.code], ["error", "extract_failed"]);
});

test("cleanSearch: what the search script hands over is taken apart and checked again, piece by piece", () => {
	const dirty = {
		ok: true,
		url: "https://search.example.com/find?q=x",
		title: "x - Example Search",
		detector: "something else",
		hidden_removed: -5,
		capped: "yes",
		results: [
			{ rank: 99, title: "  First\n\tresult  ", url: "https://a.example.org/1", snippet: "line one\nline two\u0000" },
			{ rank: 1, title: "A script", url: "javascript:alert(1)", snippet: "x" },
			{ rank: 1, title: "A file", url: "file:///etc/passwd", snippet: "x" },
			{ rank: 1, title: "A document", url: "data:text/html,x", snippet: "x" },
			{ rank: 1, title: "", url: "https://a.example.org/untitled", snippet: "no title, no result" },
			{ rank: 1, title: "   ", url: "https://a.example.org/blank", snippet: "a blank title is none" },
			{ rank: 1, title: "Twice", url: "https://a.example.org/1", snippet: "the same address again" },
			{ rank: 1, title: "T".repeat(5000), url: "https://a.example.org/long", snippet: "S".repeat(5000) },
			{ rank: 1, title: "Too long an address", url: `https://a.example.org/${"p".repeat(3000)}`, snippet: "x" },
			{ title: 7, url: "https://a.example.org/number", snippet: "x" },
			{ title: "No snippet", url: "https://a.example.org/bare" },
			{ title: "Snippet of another kind", url: "http://a.example.org/plain", snippet: { toString: () => "boom" } },
			null,
			"https://a.example.org/string",
			[{ title: "nested", url: "https://a.example.org/nested" }],
		],
	};
	const clean = cleanSearch(dirty, 20);
	assert.deepEqual(clean.results, [
		{ rank: 1, title: "First result", url: "https://a.example.org/1", snippet: "line one line two" },
		{ rank: 2, title: "T".repeat(300), url: "https://a.example.org/long", snippet: "S".repeat(500) },
		{ rank: 3, title: "No snippet", url: "https://a.example.org/bare", snippet: "" },
		{ rank: 4, title: "Snippet of another kind", url: "http://a.example.org/plain", snippet: "" },
	]);
	assert.deepEqual({ detector: clean.detector, hiddenRemoved: clean.hiddenRemoved, capped: clean.capped, title: clean.title, url: clean.url }, { detector: "generic", hiddenRemoved: 0, capped: false, title: "x - Example Search", url: "https://search.example.com/find?q=x" });
	// The limit of the job, and never more than the protocol's.
	const many = { results: Array.from({ length: 50 }, (_, i) => ({ title: `R${i}`, url: `https://a.example.org/${i}`, snippet: "" })) };
	assert.equal(cleanSearch(many, 5).results.length, 5);
	assert.equal(cleanSearch(many, 1000).results.length, LIMITS.MAX_RESULTS);
	assert.equal(cleanSearch(many, 0).results.length, 1);
	assert.equal(cleanSearch(many, Number.NaN).results.length, 1);
	assert.deepEqual(cleanSearch(many, 3).results.map((r) => r.rank), [1, 2, 3]);
	// No list at all.
	for (const results of [undefined, null, "x", 5, {}, { length: 3 }]) assert.deepEqual(cleanSearch({ results }, 10).results, []);
	// Whatever comes out passes the protocol's check of a result frame.
	const frame = makeMessage(MSG.JOB_RESULT, { ...makeResultFrame(), content: { markdown: null, text: null, html: null, raw_html: null, links: [], results: clean.results } });
	assert.deepEqual(validateMessage(frame, DIRECTION.TO_DAEMON), { ok: true });
});

/** A result frame without content, as the runner builds it. */
function makeResultFrame() {
	return {
		job: "j_x",
		outcome: "ok",
		cookie_scope: "container",
		nav: { requested_url: "https://search.example.com/find?q=x", final_url: "https://search.example.com/find?q=x", redirect_origins: [], http_status: 200, content_type: "text/html", body_bytes: null },
		render: { visibility: "visible", raf_hz: 60, settled: true, scrolled_px: 0, scroll: "off", dwell: "off", elapsed_ms: 10, timings: zeroTimings() },
		detect: null,
		error: null,
		page: { title: null, author: null, published: null, lang: null, site: null, word_count: 0, extractor: "search-generic" },
		extraction: { view: "text", coverage_pct: null, hidden_removed: 0, capped: false },
		truncated: { markdown: false, text: false, html: false, raw_html: false },
		file: null,
		tab_kept_open: false,
	};
}

test("a page the extension may not script: unsupported", async () => {
	const t = setup({
		tabUrl: "about:neterror?e=dnsNotFound",
		script: () => {
			throw new Error("Missing host permission for the tab");
		},
	});
	t.start("j_viewer");
	const r = await t.result("j_viewer");
	assert.deepEqual({ outcome: r.outcome, code: r.error.code }, { outcome: "unsupported", code: "not_scriptable" });
	assert.deepEqual(t.calls.slice(-3), ["seal", `release:${TAB}`, "detach"]);

	// Same when the address is a web address but a viewer took the document over.
	const viewer = setup({
		script: () => {
			throw new Error("Missing host permission for the tab");
		},
	});
	viewer.start("j_viewer2");
	const r2 = await viewer.result("j_viewer2");
	assert.deepEqual({ outcome: r2.outcome, code: r2.error.code }, { outcome: "unsupported", code: "not_scriptable" });
});

test("a document replaced while it settles is settled again in its successor", async () => {
	let settles = 0;
	const t = setup({
		script: (name) => {
			if (name === "settle") {
				settles += 1;
				if (settles === 1) {
					// The script's document goes away: a new navigation starts and completes.
					setTimeout(() => t.load("https://example.com/moved"), 5);
					throw new Error("Script context destroyed");
				}
				return { ok: true, settled: true, visibility: "visible", rafHz: 60 };
			}
			return extracted({ url: "https://example.com/moved" });
		},
	});
	t.start("j_replaced");
	const r = await t.result("j_replaced");
	assert.equal(r.outcome, "ok");
	assert.equal(r.nav.final_url, "https://example.com/moved");
	assert.equal(settles, 2);
});

test("a document replaced while it is read is read again, in full, in its successor", async () => {
	let calls = 0;
	const t = setup({
		script: (name) => {
			if (name === "settle") return SETTLED;
			calls += 1;
			if (calls === 1) {
				t.load("https://example.com/moved");
				throw new Error("Script context destroyed");
			}
			return extracted({ url: "https://example.com/moved" });
		},
	});
	t.start("j_moved");
	const r = await t.result("j_moved");
	assert.equal(r.outcome, "ok");
	assert.equal(r.nav.final_url, "https://example.com/moved");
	// Not the text path on the new document: that one never failed.
	assert.deepEqual(t.extractCalls().map((c) => c.defuddle), [true, true]);
	assert.equal(t.sink.count("job.extract_fallback"), 0);
});

test("what the extractor reports is cleaned before it goes into the result", async () => {
	const t = setup({
		script: (name) =>
			name === "settle"
				? { ok: true, settled: "yes", visibility: "weird", rafHz: 1e9 }
				: {
						ok: true,
						url: "https://example.com/" + "a".repeat(9000),
						page: { title: "T".repeat(5000), author: 7, published: "", lang: "x".repeat(100), site: "S".repeat(400), word_count: -5, extractor: "E".repeat(300), cookies: "sid=1" },
						extraction: { view: "article\nextraction: full page", coverage_pct: "41%", hidden_removed: 1e12, capped: "yes", cookies: "sid=1" },
						content: {
							markdown: 42,
							text: ["sid=1"],
							html: { toString: "x" },
							links: [
								{ url: "https://example.com/ok", text: "ok", rel: "nofollow" },
								{ url: "javascript:alert(1)", text: "script" },
								{ url: "https://example.com/" + "b".repeat(9000), text: "too long" },
								{ url: "https://example.com/long-text", text: "t".repeat(900) },
								{ url: 5, text: "no address" },
								"https://example.com/string",
								null,
								{ url: "https://example.com/no-text" },
							],
							results: [{ rank: 1, title: "x", url: "https://example.com/", snippet: "y" }],
						},
						truncated: { markdown: "no", text: "yes", html: 1 },
						cookies: "sid=1",
					},
	});
	t.start("j_dirty");
	const r = await t.result("j_dirty");
	assert.equal(r.outcome, "ok");
	assert.deepEqual(Object.keys(r.page).sort(), ["author", "extractor", "lang", "published", "site", "title", "word_count"]);
	assert.equal(r.page.title.length, 1000);
	assert.equal(r.page.author, null);
	assert.equal(r.page.published, null);
	assert.equal(r.page.lang.length, 35);
	assert.equal(r.page.site.length, 300);
	assert.equal(r.page.extractor.length, 100);
	assert.equal(r.page.word_count, 0);
	assert.equal(r.nav.final_url.length, 8192);
	assert.equal(r.content.markdown, null);
	assert.equal(r.content.text, null);
	assert.equal(r.content.html, null);
	// A view that is none of the three becomes the plainest; numbers that are none are dropped or capped.
	assert.deepEqual(r.extraction, { view: "text", coverage_pct: null, hidden_removed: LIMITS.MAX_HIDDEN_REMOVED, capped: false });
	assert.deepEqual(r.content.links, [
		{ url: "https://example.com/ok", text: "ok" },
		{ url: "https://example.com/long-text", text: "t".repeat(500) },
		{ url: "https://example.com/no-text", text: "" },
	]);
	assert.deepEqual(r.content.results, [], "search results are not the extractor's to give");
	assert.deepEqual(r.truncated, { markdown: false, text: false, html: false, raw_html: false });
	assert.deepEqual({ v: r.render.visibility, hz: r.render.raf_hz, settled: r.render.settled }, { v: "visible", hz: 1000, settled: false });
	assert.equal(JSON.stringify(r).includes("sid=1"), false, "nothing the protocol does not name gets through");
});

test("cleanExtracted: any shape in, the protocol's shape out", () => {
	for (const junk of [{}, { page: null, content: [], truncated: "x" }, { page: [1], content: { links: "none" } }, { content: { links: [[], 1, undefined] } }]) {
		const c = cleanExtracted(/** @type {Record<string, unknown>} */ (junk));
		assert.deepEqual(c, {
			url: null,
			page: { title: null, author: null, published: null, lang: null, site: null, word_count: 0, extractor: null },
			extraction: { view: "text", coverage_pct: null, hidden_removed: 0, capped: false },
			markdown: null,
			text: null,
			html: null,
			rawHtml: null,
			links: [],
			markdownTruncated: false,
			textTruncated: false,
			htmlTruncated: false,
			rawHtmlTruncated: false,
		});
	}
	for (const view of ["article", "full_page", "text"]) assert.equal(cleanExtracted({ extraction: { view } }).extraction.view, view);
	assert.deepEqual(cleanExtracted({ extraction: { view: "article", coverage_pct: 41.4, hidden_removed: 7, capped: true } }).extraction, { view: "article", coverage_pct: 41, hidden_removed: 7, capped: true });
	assert.deepEqual(cleanExtracted({ extraction: { view: "full_page", coverage_pct: 250, hidden_removed: -3, capped: 1 } }).extraction, { view: "full_page", coverage_pct: 100, hidden_removed: 0, capped: false });
	assert.deepEqual(cleanExtracted({ extraction: { view: "full_page", coverage_pct: -1, hidden_removed: 2.5 } }).extraction, { view: "full_page", coverage_pct: 0, hidden_removed: 0, capped: false });
	assert.equal(cleanExtracted({ content: { text: "visible" }, truncated: { text: true } }).text, "visible");
	assert.equal(cleanExtracted({ content: { text: "visible" }, truncated: { text: true } }).textTruncated, true);
	const many = cleanExtracted({ content: { links: Array.from({ length: LIMITS.MAX_LINKS + 50 }, (_v, i) => ({ url: `https://example.com/${i}`, text: "x" })) } });
	assert.equal(many.links.length, LIMITS.MAX_LINKS);
	assert.deepEqual(cleanExtracted({ truncated: { markdown: true, html: true, raw_html: false } }).markdownTruncated, true);
	assert.equal(cleanExtracted({ content: { markdown: "", html: "" } }).markdown, "", "an empty text is a text");
});

/**
 * Run a job whose extractor returns the given content against a small frame limit.
 * @param {number} maxResultBytes
 * @param {{ markdown: string | null, text?: string | null, html: string | null, raw_html?: string | null, links: { url: string, text: string }[] }} content
 */
async function fitted(maxResultBytes, content) {
	const t = setup({ maxResultBytes, script: (name) => (name === "settle" ? SETTLED : extracted({ content })) });
	t.start("j_fit");
	const r = await t.result("j_fit");
	const frame = t.sent.find((m) => m.type === MSG.JOB_RESULT);
	return { r, bytes: Buffer.byteLength(JSON.stringify(frame), "utf8") };
}

test("a document larger than the frame limit is cut so the whole frame fits", async () => {
	const big = "<p>" + "\u00e9\u0000\"x".repeat(4000) + "</p>";
	const { r, bytes } = await fitted(6000, { markdown: null, html: big, links: [] });
	assert.equal(r.outcome, "ok");
	assert.deepEqual(r.truncated, { markdown: false, text: false, html: true, raw_html: false });
	assert.ok(bytes <= 6000, `frame is ${bytes} bytes`);
	assert.ok(bytes > 5800, `and uses the room there is: ${bytes}`);
	assert.ok(big.startsWith(r.content.html));
});

test("small limits: the Markdown is kept before the document, and the flags say what was cut", async () => {
	const md = "word ".repeat(400);
	const html = "<p>" + "word ".repeat(400) + "</p>";
	// Room for the Markdown and some of the document.
	let f = await fitted(4000, { markdown: md, html, links: [] });
	assert.ok(f.bytes <= 4000, `frame is ${f.bytes} bytes`);
	assert.equal(f.r.content.markdown, md);
	assert.ok(f.r.content.html.length > 500 && f.r.content.html.length < html.length);
	assert.ok(html.startsWith(f.r.content.html));
	assert.deepEqual(f.r.truncated, { markdown: false, text: false, html: true, raw_html: false });
	assert.ok(f.bytes > 3800, `uses the room there is: ${f.bytes}`);

	// Not even room for the Markdown: it is cut, and nothing is left for the document.
	f = await fitted(2000, { markdown: md, html, links: [] });
	assert.ok(f.bytes <= 2000, `frame is ${f.bytes} bytes`);
	assert.ok(f.r.content.markdown.length > 500 && md.startsWith(f.r.content.markdown));
	assert.equal(f.r.content.html, "");
	assert.deepEqual(f.r.truncated, { markdown: true, text: false, html: true, raw_html: false });

	// Room for everything: nothing is flagged.
	f = await fitted(20000, { markdown: md, html, links: [] });
	assert.deepEqual(f.r.truncated, { markdown: false, text: false, html: false, raw_html: false });
	assert.equal(f.r.content.html, html);

	// With the visible text along: the Markdown first, then the text, the document last.
	const text = "seen ".repeat(400);
	f = await fitted(20000, { markdown: md, text, html, links: [] });
	assert.deepEqual([f.r.content.markdown, f.r.content.text, f.r.content.html], [md, text, html]);
	assert.deepEqual(f.r.truncated, { markdown: false, text: false, html: false, raw_html: false });
	f = await fitted(6000, { markdown: md, text, html, links: [] });
	assert.ok(f.bytes <= 6000 && f.bytes > 5800, `frame is ${f.bytes} bytes`);
	assert.deepEqual([f.r.content.markdown, f.r.content.text], [md, text]);
	assert.ok(f.r.content.html.length > 100 && html.startsWith(f.r.content.html), "the document is the first to give");
	assert.deepEqual(f.r.truncated, { markdown: false, text: false, html: true, raw_html: false });
	f = await fitted(4000, { markdown: md, text, html, links: [] });
	assert.ok(f.bytes <= 4000, `frame is ${f.bytes} bytes`);
	assert.equal(f.r.content.markdown, md);
	assert.ok(f.r.content.text.length > 300 && f.r.content.text.length < text.length && text.startsWith(f.r.content.text), "then the text");
	assert.equal(f.r.content.html, "");
	assert.deepEqual(f.r.truncated, { markdown: false, text: true, html: true, raw_html: false });
	f = await fitted(2000, { markdown: md, text, html, links: [] });
	assert.ok(f.bytes <= 2000, `frame is ${f.bytes} bytes`);
	assert.ok(f.r.content.markdown.length > 400 && md.startsWith(f.r.content.markdown));
	assert.deepEqual([f.r.content.text, f.r.content.html], ["", ""]);
	assert.deepEqual(f.r.truncated, { markdown: true, text: true, html: true, raw_html: false });

	// What the extractor itself cut stays flagged, whatever fits.
	const t = setup({ script: (name) => (name === "settle" ? SETTLED : extracted({ truncated: { markdown: true, text: true, html: true, raw_html: false } })) });
	t.start("j_flagged");
	assert.deepEqual((await t.result("j_flagged")).truncated, { markdown: true, text: true, html: true, raw_html: false });
});

test("small limits: the link list takes its share at most, whole entries only", async () => {
	const links = Array.from({ length: 200 }, (_v, i) => ({ url: `https://example.com/page/${String(i).padStart(3, "0")}`, text: `link number ${i}` }));
	const md = "word ".repeat(300);
	const f = await fitted(6000, { markdown: md, html: null, raw_html: null, links });
	assert.ok(f.bytes <= 6000, `frame is ${f.bytes} bytes`);
	assert.ok(f.r.content.links.length > 5 && f.r.content.links.length < 30, `links kept: ${f.r.content.links.length}`);
	assert.deepEqual(f.r.content.links, links.slice(0, f.r.content.links.length), "the first ones, unchanged");
	assert.ok(Buffer.byteLength(JSON.stringify(f.r.content.links)) <= 6000 / 4);
	assert.equal(f.r.content.markdown, md, "the links did not crowd out the text");
	assert.deepEqual(f.r.truncated, { markdown: false, text: false, html: false, raw_html: false });
});

test("fitLinks: the leading entries that fit, counted in bytes", () => {
	const links = [
		{ url: "https://example.com/a", text: "a" },
		{ url: "https://example.com/\u00e9", text: "\u{1F600}" },
		{ url: "https://example.com/c", text: "c" },
	];
	const size = (/** @type {unknown} */ v) => Buffer.byteLength(JSON.stringify(v));
	assert.equal(fitLinks(links, size(links)), links, "all of them: the same array");
	assert.deepEqual(fitLinks(links, size(links) - 1), links.slice(0, 2));
	assert.deepEqual(fitLinks(links, size(links.slice(0, 2))), links.slice(0, 2));
	assert.deepEqual(fitLinks(links, size(links.slice(0, 1))), links.slice(0, 1));
	assert.deepEqual(fitLinks(links, size(links.slice(0, 1)) - 1), []);
	assert.deepEqual(fitLinks(links, 0), []);
	assert.deepEqual(fitLinks([], 0), []);
	for (let max = 0; max < size(links) + 5; max++) assert.ok(size(fitLinks(links, max)) <= Math.max(max, 2), `budget ${max}`);
});

test("a result the protocol would not accept is replaced by a well-formed error", async () => {
	const t = setup();
	t.start("j_invalid");
	await until(() => t.calls.some((c) => c.startsWith("attach")));
	t.guard().nav.httpStatus = 42;
	const r = await t.result("j_invalid");
	assert.deepEqual({ outcome: r.outcome, code: r.error.code }, { outcome: "error", code: "result_invalid" });
	assert.equal(t.sink.count("job.result_invalid"), 1);
});

test("the local backstop ends a job the daemon forgot to cancel", async () => {
	// Loaded, but the settle script never comes back and nobody cancels.
	const t = setup({ script: () => new Promise(() => {}) });
	t.start("j_stuck", { wait: { timeout_ms: 100, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } });
	const r = await t.result("j_stuck");
	assert.equal(r.outcome, "timeout");
	assert.equal(r.error.code, "deadline");
});

test("dwell: the page is kept for the asked time before it is read", async () => {
	const t = setup();
	const started = Date.now();
	t.start("j_dwell", { wait: { timeout_ms: 400, settle_ms: 0, dwell_ms: 150, human_wait_ms: 0, scroll: "none" } });
	const r = await t.result("j_dwell");
	assert.equal(r.outcome, "ok");
	assert.ok(Date.now() - started >= 150);
});

test("fitJsonString: longest prefix whose JSON form fits, never half a surrogate pair", () => {
	assert.deepEqual(fitJsonString("hello", 100), { text: "hello", truncated: false });
	assert.deepEqual(fitJsonString("hello", 7), { text: "hello", truncated: false });
	assert.deepEqual(fitJsonString("hello", 6), { text: "hell", truncated: true });
	assert.deepEqual(fitJsonString("hello", 2), { text: "", truncated: true });
	assert.deepEqual(fitJsonString("hello", 0), { text: "", truncated: true });
	// Each quote costs two bytes, each control character six.
	assert.deepEqual(fitJsonString('""""', 8), { text: '"""', truncated: true });
	assert.deepEqual(fitJsonString("\u0001\u0001", 13), { text: "\u0001", truncated: true });
	// Two bytes for e-acute, four for an emoji that takes two code units.
	assert.deepEqual(fitJsonString("\u00e9\u00e9\u00e9", 7), { text: "\u00e9\u00e9", truncated: true });
	const emoji = "a\u{1F600}b";
	assert.deepEqual(fitJsonString(emoji, 6), { text: "a", truncated: true });
	assert.deepEqual(fitJsonString(emoji, 7), { text: "a\u{1F600}", truncated: true });
	for (const max of [0, 1, 5, 17, 64, 333]) {
		const text = '<a href="x">\u00e9\u{1F600}\n</a>'.repeat(40);
		const fitted = fitJsonString(text, max);
		assert.ok(Buffer.byteLength(JSON.stringify(fitted.text)) <= Math.max(max, 2));
		assert.ok(text.startsWith(fitted.text));
	}
});

// ---------------------------------------------------------------- the operator's cookie store (login opt-in)

const LOGIN_RULE = Object.freeze({ host: "example.com", pathPrefix: "/start", subdomains: false });
/** @param {string} url */
const underRule = (url) => (url === "https://example.com/start" || url.startsWith("https://example.com/start/") || url.startsWith("https://example.com/start?") ? LOGIN_RULE : null);
/** @param {{ code?: unknown }[]} injected @returns {Record<string, unknown>} the arguments the settle script was given */
const settleArgs = (injected) => JSON.parse(/^globalThis\.__bgwSettle = (\{.*\});$/.exec(String(injected.find((i) => String(i.code).startsWith("globalThis.__bgwSettle"))?.code))?.[1] ?? "{}");

test("the cookie store is chosen here: the operator's for a fetch inside one of their rules, the container for everything else", async () => {
	/** @type {string[]} */
	const asked = [];
	const t = setup({
		match: (url) => {
			asked.push(url);
			return underRule(url);
		},
		tabUrl: "https://example.com/start/page",
		script: (name, args) => (name === "settle" ? SETTLED : extracted({ url: "https://example.com/start/page", ...(args.html === true ? {} : {}) })),
	});
	t.start("j_login", { wait: { timeout_ms: 400, settle_ms: 20, dwell_ms: 0, human_wait_ms: 0, scroll: "lazy" } });
	const r = await t.result("j_login");
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.cookie_scope, "default");
	// The rule is asked for a use before anything else happens; the tab is made in the operator's store and
	// put under guard with the rule it must stay inside.
	assert.deepEqual(t.calls, ["admit:example.com/start", "precheck", "acquire:firefox-default", `attach:${TAB}:firefox-default`, "navigate:https://example.com/start", "seal", `release:${TAB}`, "detach"]);
	assert.deepEqual(t.guard().opts.scope, { rule: LOGIN_RULE, policy: {}, url: "https://example.com/start" });
	// The daemon is told the store and the rule - after the fact: it has no say in it.
	assert.deepEqual(t.sent[0], makeMessage(MSG.JOB_ACCEPTED, { job: "j_login", cookie_scope: "default", rule: { host: "example.com", path_prefix: "/start", subdomains: false } }));
	// No walk down the page with the operator's session, whatever the job asks for.
	assert.equal(settleArgs(t.injected).scroll, false);
	assert.equal(r.render.scrolled_px, 0);
	// What is logged: that it happened, and the host of the rule. Nothing of the address.
	assert.deepEqual(t.sink.entries.find((e) => e.event === "job.login_scope")?.fields, { job: "j_login", host: "example.com" });
	assert.equal(t.sink.text().includes("/start"), false);
	assert.deepEqual(asked, ["https://example.com/start"]);

	// The same URL with session "isolated": the rules are not even looked at.
	const iso = setup({ match: (url) => (asked.push(`isolated:${url}`), underRule(url)) });
	iso.start("j_iso", { session: "isolated", wait: { timeout_ms: 400, settle_ms: 20, dwell_ms: 0, human_wait_ms: 0, scroll: "lazy" } });
	const isoResult = await iso.result("j_iso");
	assert.equal(isoResult.cookie_scope, "container");
	assert.deepEqual(iso.calls.slice(0, 3), ["precheck", `acquire:${STORE}`, `attach:${TAB}:${STORE}`]);
	assert.equal(iso.guard().opts.scope, undefined);
	assert.deepEqual(iso.sent[0], makeMessage(MSG.JOB_ACCEPTED, { job: "j_iso", cookie_scope: "container", rule: null }));
	assert.equal(settleArgs(iso.injected).scroll, true, "in the container the page is walked");
	// A probe never runs with the login.
	const probe = setup({ match: (url) => (asked.push(`probe:${url}`), underRule(url)) });
	probe.start("j_probe", { kind: "probe" });
	assert.equal((await probe.result("j_probe")).cookie_scope, "container");
	// A URL outside every rule.
	const out = setup({ match: (url) => (asked.push(`out:${url}`), underRule(url)) });
	out.start("j_out", { url: "https://example.com/other" });
	assert.equal((await out.result("j_out")).cookie_scope, "container");
	assert.deepEqual(asked, ["https://example.com/start", "out:https://example.com/other"]);

	// A frame that got past the validator with a word for the session that does not exist: the container.
	for (const session of ["default", "login", "operator", "AUTO", "", null, undefined, 1, true, { auto: true }]) {
		const odd = setup({ match: underRule });
		odd.jobs.start({ v: PROTOCOL_VERSION, type: MSG.JOB_START, job: "j_odd", kind: "fetch", url: "https://example.com/start", session, wait: { timeout_ms: 400, settle_ms: 20, dwell_ms: 0, human_wait_ms: 0, scroll: "none" }, extract: { markdown: true, text: true, html: false, raw_html: false, links: true, adapter: "auto" }, files: null, rule: LOGIN_RULE, cookie_scope: "default" });
		const oddResult = await odd.result("j_odd");
		assert.equal(oddResult.cookie_scope, "container", `session ${JSON.stringify(session)}`);
		assert.equal(odd.calls.some((c) => c.startsWith("admit") || c.includes("firefox-default")), false);
	}
});

test("the rate limit of a rule: a job that comes too soon is refused before anything is touched, and never moved to the container", async () => {
	const t = setup({ match: underRule, admit: () => 7 });
	t.start("j_soon");
	const r = await t.result("j_soon");
	assert.equal(r.outcome, "error");
	assert.deepEqual(r.error, { code: "login_rate_limit", message: "pages under this login rule were loaded too often; the limit is the operator's protection and cannot be lifted", retryable: true, retry_after_s: 7 });
	assert.equal(r.cookie_scope, null, "no tab was opened");
	assert.equal(r.content, null);
	assert.deepEqual(t.calls, ["admit:example.com/start"], "no address check, no tab, no navigation");
	assert.deepEqual(t.sent.map((m) => m.type), [MSG.JOB_RESULT], "not even accepted");
	assert.equal(t.jobs.current(), null);
	// The next one, when the rule allows it, runs.
	const u = setup({ match: underRule, admit: () => 0, tabUrl: "https://example.com/start", script: (name) => (name === "settle" ? SETTLED : extracted({ url: "https://example.com/start" })) });
	u.start("j_later");
	assert.equal((await u.result("j_later")).cookie_scope, "default");
});

test("a job with the operator's store is held to its rule to the end: where the tab is, where it goes without a request, what the page says its address is", async () => {
	const inside = (/** @type {string} */ url) => underRule(url) !== null;
	// The tab turns out to be somewhere else when it is looked at.
	const moved = setup({ match: underRule, inScope: inside, tabUrl: "https://example.com/messages/inbox" });
	moved.start("j_moved");
	let r = await moved.result("j_moved");
	assert.equal(r.outcome, "policy_blocked");
	assert.equal(r.error.code, "redirect_out_of_scope");
	assert.equal(r.content, null);
	assert.equal(r.page, null);
	assert.equal(r.nav.final_url, null);
	assert.equal(r.cookie_scope, "default");
	assert.equal(moved.files.includes("/content/extract.js"), false, "nothing was read");
	assert.equal(moved.guard().sealed, true);

	// The address changes by script, with no request: every way the browser tells of it is listened to.
	for (const event of /** @type {const} */ (["onHistoryStateUpdated", "onReferenceFragmentUpdated", "onCommitted", "onBeforeNavigate"])) {
		const t = setup({
			match: underRule,
			inScope: inside,
			tabUrl: "https://example.com/start",
			onNavigate: (_tab, url) => {
				t.load(url);
				setTimeout(() => t.nav[event].fire({ tabId: TAB, frameId: 0, url: "https://example.com/private" }), 12);
			},
			script: (name) => (name === "settle" ? new Promise((resolve) => setTimeout(() => resolve(SETTLED), 60)) : extracted({ url: "https://example.com/start" })),
		});
		t.start("j_script");
		r = await t.result("j_script");
		assert.deepEqual([r.outcome, r.error?.code], ["policy_blocked", "redirect_out_of_scope"], event);
		assert.equal(r.content, null, event);
		// The listeners are gone with the job.
		for (const name of /** @type {const} */ (["onHistoryStateUpdated", "onReferenceFragmentUpdated", "onCommitted", "onBeforeNavigate", "onCompleted", "onErrorOccurred"])) assert.equal(t.nav[name].listeners.length, 0, name);
	}
	// What happens in a frame, in another tab, or on the way from the blank page is none of this.
	const calm = setup({
		match: underRule,
		inScope: inside,
		tabUrl: "https://example.com/start",
		onNavigate: (_tab, url) => {
			calm.nav.onCommitted.fire({ tabId: TAB, frameId: 3, url: "https://ads.example.net/frame" });
			calm.nav.onHistoryStateUpdated.fire({ tabId: TAB + 1, frameId: 0, url: "https://example.com/private" });
			calm.nav.onCommitted.fire({ tabId: TAB, frameId: 0, url: "about:blank" });
			calm.load(url);
		},
		script: (name) => (name === "settle" ? SETTLED : extracted({ url: "https://example.com/start" })),
	});
	calm.start("j_calm");
	assert.equal((await calm.result("j_calm")).outcome, "ok");

	// Last of all: the address the page itself reports when it is read.
	const late = setup({ match: underRule, inScope: inside, tabUrl: "https://example.com/start", script: (name) => (name === "settle" ? SETTLED : extracted({ url: "https://example.com/account/secrets" })) });
	late.start("j_late");
	r = await late.result("j_late");
	assert.deepEqual([r.outcome, r.error?.code, r.content, r.page], ["policy_blocked", "redirect_out_of_scope", null, null]);
	const none = setup({ match: underRule, inScope: inside, tabUrl: "https://example.com/start", script: (name) => (name === "settle" ? SETTLED : extracted({ url: 5 })) });
	none.start("j_none");
	r = await none.result("j_none");
	assert.deepEqual([r.outcome, r.error?.code, r.content], ["policy_blocked", "redirect_out_of_scope", null], "a page that reports no address was not read inside the rule");
});

test("the guard's verdict on a login page outside the rule: blocked, login_wall, and the operator is told to log in", async () => {
	const t = setup({
		match: underRule,
		onNavigate: () => {
			setTimeout(() => t.guard().opts.onVerdict({ outcome: "blocked", code: "login_wall", message: "the site sent the browser to a login page", detect: { kind: "login_wall", evidence: "redirect to a login path" } }), 5);
		},
	});
	t.start("j_wall");
	const r = await t.result("j_wall");
	assert.equal(r.outcome, "blocked");
	assert.equal(r.cookie_scope, "default");
	assert.deepEqual(r.error, {
		code: "login_wall",
		message: "the site sent the browser to a login page although the page was loaded with the operator's login: the operator is logged out of this site and has to log in to it in their browser",
		retryable: false,
		retry_after_s: null,
	});
	assert.deepEqual({ kind: r.detect.kind, evidence: r.detect.evidence, resolved: r.detect.resolved }, { kind: "login_wall", evidence: "redirect to a login path", resolved: null });
	// The same verdict for a job in the container keeps the plain sentence: nobody's login was used.
	const c = setup({
		onNavigate: () => {
			setTimeout(() => c.guard().opts.onVerdict({ outcome: "blocked", code: "login_wall", message: "the site sent the browser to a login page" }), 5);
		},
	});
	c.start("j_wall_container");
	assert.equal((await c.result("j_wall_container")).error.message, "the site sent the browser to a login page");
});

test("the running job says which store it uses, for the badge and the popup", async () => {
	const t = setup({ match: underRule, tabUrl: "https://example.com/start", onNavigate: (_tab, url) => setTimeout(() => t.load(url), 60), script: (name) => (name === "settle" ? SETTLED : extracted({ url: "https://example.com/start" })) });
	t.start("j_badge");
	await until(() => t.calls.some((c) => c.startsWith("navigate")));
	assert.deepEqual(t.jobs.current(), { job: "j_badge", host: "example.com", scope: "default" });
	await t.result("j_badge");
	assert.equal(t.jobs.current(), null);
});

test("the page source is asked for in the container whatever the job says, and in the login scope only when the job asks", async () => {
	const url = "https://example.com/start/page";
	const script = (/** @type {string} */ name) => (name === "settle" ? SETTLED : extracted({ url, content: { ...extracted().content, raw_html: "<!DOCTYPE html>\n<html></html>" }, truncated: { markdown: false, text: false, html: false, raw_html: false } }));
	const wait = { timeout_ms: 400, settle_ms: 20, dwell_ms: 0, human_wait_ms: 0, scroll: "none" };
	// The gateway's own container: always, and the job's own flag is not needed.
	const own = setup({ script });
	own.start("j_own", { extract: { markdown: true, text: true, html: true, raw_html: false, links: true, adapter: "auto" } });
	const ownResult = await own.result("j_own");
	assert.equal(ownResult.cookie_scope, "container");
	assert.equal(own.extractCalls()[0].rawHtml, true);
	assert.equal(own.extractCalls()[0].maxRawHtmlChars, LIMITS.MAX_RAW_HTML_CHARS);
	assert.equal(ownResult.content.raw_html, "<!DOCTYPE html>\n<html></html>");
	// The operator's login: not unless asked.
	const quiet = setup({ match: underRule, tabUrl: url, script });
	quiet.start("j_quiet", { wait });
	const quietResult = await quiet.result("j_quiet");
	assert.equal(quietResult.cookie_scope, "default");
	assert.equal(quiet.extractCalls()[0].rawHtml, false);
	const asked = setup({ match: underRule, tabUrl: url, script });
	asked.start("j_asked", { wait, extract: { markdown: true, text: true, html: false, raw_html: true, links: true, adapter: "auto" } });
	const askedResult = await asked.result("j_asked");
	assert.equal(askedResult.cookie_scope, "default");
	assert.equal(asked.extractCalls()[0].rawHtml, true);
	assert.equal(askedResult.content.raw_html, "<!DOCTYPE html>\n<html></html>");
	// A probe reads facts, not content.
	const probe = setup({ script });
	probe.start("j_probe", { kind: "probe" });
	await probe.result("j_probe");
	assert.equal(probe.extractCalls()[0].rawHtml, false);
});

test("when the frame is too big the page source goes first, then the document, then the text, then the Markdown", async () => {
	const md = "word ".repeat(400);
	const text = "seen ".repeat(400);
	const html = "<p>" + "word ".repeat(400) + "</p>";
	const raw = "<html>" + "<b>raw</b> ".repeat(2000) + "</html>";
	let f = await fitted(60000, { markdown: md, text, html, raw_html: raw, links: [] });
	assert.deepEqual([f.r.content.markdown, f.r.content.text, f.r.content.html, f.r.content.raw_html], [md, text, html, raw]);
	assert.deepEqual(f.r.truncated, { markdown: false, text: false, html: false, raw_html: false });
	// Room for all but the end of the source: only the source is cut, at a prefix.
	f = await fitted(8000, { markdown: md, text, html, raw_html: raw, links: [] });
	assert.ok(f.bytes <= 8000 && f.bytes > 7800, `frame is ${f.bytes} bytes`);
	assert.deepEqual([f.r.content.markdown, f.r.content.text, f.r.content.html], [md, text, html]);
	assert.ok(f.r.content.raw_html.length > 100 && f.r.content.raw_html.length < raw.length && raw.startsWith(f.r.content.raw_html));
	assert.deepEqual(f.r.truncated, { markdown: false, text: false, html: false, raw_html: true });
	// Less room: the source is gone before the document is touched.
	f = await fitted(4000, { markdown: md, text, html, raw_html: raw, links: [] });
	assert.ok(f.bytes <= 4000, `frame is ${f.bytes} bytes`);
	assert.equal(f.r.content.markdown, md);
	assert.equal(f.r.content.raw_html, "");
	assert.equal(f.r.truncated.raw_html, true);
	assert.equal(f.r.truncated.text, true, "the text gave before the Markdown");
	assert.equal(f.r.truncated.markdown, false);
	// What the extractor cut stays flagged.
	const t = setup({ script: (name) => (name === "settle" ? SETTLED : extracted({ content: { ...extracted().content, raw_html: "<html>" }, truncated: { markdown: false, text: false, html: false, raw_html: true } })) });
	t.start("j_cut");
	assert.equal((await t.result("j_cut")).truncated.raw_html, true);
});

test("cleanExtracted holds the page source to its cap and to strings", () => {
	assert.equal(cleanExtracted({ content: { raw_html: "<html></html>" } }).rawHtml, "<html></html>");
	assert.equal(cleanExtracted({ content: { raw_html: 5 } }).rawHtml, null);
	assert.equal(cleanExtracted({ content: {} }).rawHtml, null);
	const over = cleanExtracted({ content: { raw_html: "a".repeat(LIMITS.MAX_RAW_HTML_CHARS + 10) } });
	assert.equal(over.rawHtml?.length, LIMITS.MAX_RAW_HTML_CHARS);
	assert.equal(over.rawHtmlTruncated, true);
	assert.equal(cleanExtracted({ content: { raw_html: "x" }, truncated: { raw_html: true } }).rawHtmlTruncated, true);
	assert.equal(cleanExtracted({ content: { raw_html: "x" }, truncated: { raw_html: "yes" } }).rawHtmlTruncated, false);
});

// A service worker that an earlier job left in the container answers a later top-level load
// itself. No response headers pass the guard for it; the tab showed what the worker made, and a page of it was read.
test("a document the guard never saw the response of ends the job the moment it is committed: nothing is settled, looked at or read", async () => {
	/** @type {ReturnType<typeof setup>} */
	const t = setup({ onNavigate: (_tabId, url) => t.loadCommitted(url), guarded: () => false });
	t.start("j_sw");
	const r = await t.result("j_sw");
	assert.equal(r.outcome, "error");
	assert.deepEqual(r.error, { code: "unguarded_response", message: "the page was answered without a response the request guard saw (by a service worker of the site, or from the browser's history)", retryable: true, retry_after_s: null });
	assert.equal(r.content, null);
	assert.equal(r.page, null);
	assert.equal(r.cookie_scope, "container");
	// No script of the page flow ever ran in that document: not the settle script, not the look for a challenge, not the extractor.
	assert.deepEqual(t.files, ["/content/workers.js"]);
	assert.deepEqual(t.injected, []);
	assert.deepEqual(t.extractCalls(), []);
	assert.equal(t.sent.some((m) => m.type === MSG.JOB_PROGRESS && (m.phase === "settling" || m.phase === "extracting")), false);
	// The tab is sealed and closed at once; before it goes, the workers of its page are taken away.
	assert.deepEqual(t.calls, ["precheck", `acquire:${STORE}`, `attach:${TAB}:${STORE}`, "navigate:https://example.com/start", "seal", "workers", `release:${TAB}`, "detach"]);
	assert.ok(r.render.elapsed_ms < 300, `ended at the commit, not at a timeout: ${r.render.elapsed_ms} ms`);
	assert.equal(t.jobs.current(), null);
	assert.equal(t.jobs.busy(), false);

	// The same for a document that takes the place of a page that had loaded properly: the page that was read is not returned.
	let n = 0;
	/** @type {ReturnType<typeof setup>} */
	const later = setup({
		onNavigate: (_tabId, url) => later.loadCommitted(url),
		guarded: () => n++ === 0,
		script: (name) => {
			// While the first page settles, its tab is taken somewhere the guard hears no response of.
			if (name === "settle") later.loadCommitted("https://example.com/from-the-worker");
			return name === "settle" ? SETTLED : extracted();
		},
	});
	later.start("j_later");
	const l = await later.result("j_later");
	assert.deepEqual([l.outcome, l.error.code, l.content], ["error", "unguarded_response", null]);
	assert.deepEqual(later.extractCalls(), []);
	// A load that failed is told to the guard before the browser commits its error page for it: the address, and
	// the browser's own word for the error. (What the guard makes of the two is its matter: see ext-guard.test.js.)
	/** @type {ReturnType<typeof setup>} */
	const broken = setup({
		onNavigate: (_tabId, url) => {
			broken.nav.onBeforeNavigate.fire({ tabId: TAB, frameId: 0, url });
			broken.nav.onErrorOccurred.fire({ tabId: TAB, frameId: 3, url: "https://ads.example.net/frame", error: "Error code 2152398868" });
			broken.nav.onErrorOccurred.fire({ tabId: TAB, frameId: 0, url, error: "Error code 2152398868" });
			broken.nav.onCommitted.fire({ tabId: TAB, frameId: 0, url });
		},
	});
	broken.start("j_broken");
	const b = await broken.result("j_broken");
	assert.deepEqual([b.outcome, b.error.code], ["error", "navigation_failed"]);
	assert.deepEqual(broken.failures, [
		["https://example.com/start", "Error code 2152398868"],
		["https://example.com/start", "Error code 2152398868"],
	], "once for each of the two attempts, top frame only");
	// Frames, other tabs and the blank start page are no documents of the job's top frame.
	/** @type {ReturnType<typeof setup>} */
	const calm = setup({
		onNavigate: (_tabId, url) => {
			calm.nav.onCommitted.fire({ tabId: TAB, frameId: 3, url: "https://ads.example.net/frame" });
			calm.nav.onCommitted.fire({ tabId: TAB + 1, frameId: 0, url: "https://other.example.net/" });
			calm.nav.onCommitted.fire({ tabId: TAB, frameId: 0, url: "about:blank" });
			calm.load(url);
		},
		guarded: () => false,
	});
	calm.start("j_calm");
	assert.equal((await calm.result("j_calm")).outcome, "ok");
});

test("when a job ends, the service workers of its page are taken away before the tab is closed: every frame, the gateway container only, counts only", async () => {
	/** @type {ReturnType<typeof setup>} */
	const t = setup({ onNavigate: (_tabId, url) => t.loadCommitted(url), workers: () => [{ ok: true, found: 2, removed: 2 }, { ok: true, found: 1, removed: 0 }, null, "junk", { ok: true, found: -4, removed: "9" }] });
	t.start("j_w");
	const r = await t.result("j_w");
	assert.equal(r.outcome, "ok");
	// After the page was read and the tab was sealed - nothing the page does now can register one again - and before the tab goes.
	assert.deepEqual(t.calls, ["precheck", `acquire:${STORE}`, `attach:${TAB}:${STORE}`, "navigate:https://example.com/start", "seal", "workers", `release:${TAB}`, "detach"]);
	assert.deepEqual(t.files, ["/content/settle.js", "/content/detect-dom.js", "/vendor/defuddle.full.js", "/content/extract.js", "/content/workers.js"]);
	// One file of the extension, in every frame, without waiting for a load; no code is made up for it.
	assert.deepEqual(t.workerCalls, [{ file: "/content/workers.js", runAt: "document_start", allFrames: true }]);
	// What is written down: how many were found and how many went, over all frames. Odd answers count as nothing.
	assert.deepEqual(t.sink.entries.filter((e) => e.event === "job.workers_removed").map((e) => e.fields), [{ job: "j_w", found: 3, removed: 2 }]);

	// A page without workers: asked, nothing to say.
	/** @type {ReturnType<typeof setup>} */
	const none = setup({ onNavigate: (_tabId, url) => none.loadCommitted(url) });
	none.start("j_none");
	assert.equal((await none.result("j_none")).outcome, "ok");
	assert.equal(none.workerCalls.length, 1);
	assert.equal(none.sink.count("job.workers_removed"), 0);

	// A frame that cannot be asked: the page itself is asked alone.
	/** @type {ReturnType<typeof setup>} */
	const framed = setup({
		onNavigate: (_tabId, url) => framed.loadCommitted(url),
		workers: (details) => {
			if (details.allFrames === true) throw new Error("Missing host permission for the frame");
			return [{ ok: true, found: 1, removed: 1 }];
		},
	});
	framed.start("j_framed");
	assert.equal((await framed.result("j_framed")).outcome, "ok");
	assert.deepEqual(framed.workerCalls, [{ file: "/content/workers.js", runAt: "document_start", allFrames: true }, { file: "/content/workers.js", runAt: "document_start", frameId: 0 }]);
	assert.deepEqual(framed.sink.entries.find((e) => e.event === "job.workers_removed")?.fields, { job: "j_framed", found: 1, removed: 1 });

	// A page that cannot be asked at all, and one that never answers: the job ends all the same, and its tab is closed.
	/** @type {ReturnType<typeof setup>} */
	const mute = setup({
		onNavigate: (_tabId, url) => mute.loadCommitted(url),
		workers: () => {
			throw new Error("no such tab");
		},
	});
	mute.start("j_mute");
	assert.equal((await mute.result("j_mute")).outcome, "ok");
	assert.ok(mute.calls.includes(`release:${TAB}`));
	/** @type {ReturnType<typeof setup>} */
	const hung = setup({ onNavigate: (_tabId, url) => hung.loadCommitted(url), workers: () => new Promise(() => {}) });
	const began = Date.now();
	hung.start("j_hung");
	assert.equal((await hung.result("j_hung")).outcome, "ok");
	assert.ok(Date.now() - began < 2500, "a second at most is waited for the answer");
	assert.deepEqual(hung.calls.slice(-3), ["workers", `release:${TAB}`, "detach"]);

	// In the operator's own cookie store their sites' workers are theirs: never asked for, never touched.
	const rule = { host: "example.com", pathPrefix: "/", subdomains: false };
	/** @type {ReturnType<typeof setup>} */
	const login = setup({ onNavigate: (_tabId, url) => login.loadCommitted(url), match: () => rule });
	login.start("j_login");
	const lr = await login.result("j_login");
	assert.deepEqual([lr.outcome, lr.cookie_scope], ["ok", "default"]);
	assert.deepEqual(login.workerCalls, []);
	assert.equal(login.files.includes("/content/workers.js"), false);

	// A job whose tab never held a document of a site has nothing to take away: no script at all.
	const blind = setup({ precheck: async () => ({ verdict: { outcome: "policy_blocked", code: "private_address", message: "the host name resolves to a private address" } }) });
	blind.start("j_blind");
	assert.equal((await blind.result("j_blind")).outcome, "policy_blocked");
	assert.deepEqual(blind.files, []);
});

test("errorText: what an error says, without anything that could be an address", () => {
	/** @type {[unknown, string][]} */
	const cases = [
		[new Error("Illegal URL: https://forum.example.com/board/private?token=s3cr3t#frag"), "Illegal URL: address"],
		[new Error("Invalid tab ID: 12"), "Invalid tab ID: 12"],
		[new Error("No tab with id: 40."), "No tab with id: 40"],
		[new Error("could not load forum.example.com (10.0.0.5:8443) from about:blank"), "could not load address address from address"],
		[new Error('Script "moz-extension://0f8c2a3e/content/extract.js" failed: x is undefined'), "Script address failed: x is undefined"],
		[new Error("user@example.com said no, path /board/private and C:\\Users\\me"), "address said no path address and address"],
		[new TypeError("can't access property \"x\", y is undefined"), "cant access property x y is undefined"],
		[new Error("the gateway window or job tab could not be opened"), "the gateway window or job tab could not be opened"],
		[new Error(""), "unknown"],
		[new Error("https://only.example/an/address"), "address"],
		["a string, not an error: https://x.example/", "unknown"],
		[{ message: "https://x.example/" }, "unknown"],
		[null, "unknown"],
		[undefined, "unknown"],
	];
	for (const [err, text] of cases) assert.equal(errorText(err), text, String(err));
	const long = errorText(new Error("word ".repeat(400)));
	assert.equal(long.length, 80);
	assert.match(errorText(new Error(`before ${"x".repeat(5000)}.example.com/secret after`)), /^before address$/, "a word that runs past what is read is still one word");
	// Whatever the text: letters, digits, blanks and three signs come out, nothing else.
	assert.match(errorText(new Error("\u0000<script>alert(1)</script> \u202e\u00e9\u4e2d 100% \"quoted\" `x` $y")), /^[A-Za-z0-9 :_-]*$/);
});

test("a call of the browser that fails with the address of the job in its words: nothing of the address reaches the log", async () => {
	const secret = "https://forum.example.com/board/private-thread-4711?session=s3cr3t";
	const leaks = (/** @type {string} */ text) => /forum|example|board|private|thread|4711|session|s3cr3t/i.test(text);
	// The navigation is refused by the browser, in its own words.
	const t = setup({
		onNavigate: (_tabId, url) => {
			throw new Error(`Illegal URL: ${url}`);
		},
	});
	t.start("j_nav", { url: secret });
	const r = await t.result("j_nav");
	assert.deepEqual([r.outcome, r.error.code], ["error", "internal_error"]);
	assert.equal(leaks(JSON.stringify(r.error)), false);
	const failed = t.sink.entries.filter((e) => e.event === "job.failed");
	assert.equal(failed.length, 1);
	assert.equal(failed[0].fields.message, "Illegal URL: address");
	assert.equal(leaks(JSON.stringify(t.sink.entries.filter((e) => e.event !== "job.login_scope"))), false, t.sink.text());

	// The tab cannot be made, and the browser names what it was asked for.
	const w = setup({
		acquire: async () => {
			throw new Error(`cannot open ${secret} in a new tab`);
		},
	});
	w.start("j_tab", { url: secret });
	assert.equal((await w.result("j_tab")).error.code, "window_unavailable");
	assert.equal(w.sink.entries.find((e) => e.event === "job.window_failed")?.fields.message, "cannot open address in a new tab");
	assert.equal(leaks(w.sink.text()), false, w.sink.text());

	// The tab cannot be closed, with the same manners.
	const c = setup({
		onRelease: () => {
			throw new Error(`tab at ${secret} would not close`);
		},
	});
	c.start("j_close", { url: secret });
	await c.result("j_close");
	assert.equal(c.sink.entries.find((e) => e.event === "job.release_failed")?.fields.message, "tab at address would not close");
	assert.equal(leaks(c.sink.text()), false, c.sink.text());
});
