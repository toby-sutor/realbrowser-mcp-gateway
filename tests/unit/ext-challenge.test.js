// The job runner and a page that shows a challenge, a block or a wall: the
// grace period, parking, the end of a parked job in each of its ways, the
// hand-off to the operator. The browser is a stand-in; waiting happens on a
// clock that the test moves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEvent, logSink, sleep } from "../helpers/ext-fakes.js";
import { until } from "../helpers/daemon.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { Jobs } from "../../extension/background/jobs.js";
import { EVIDENCE, KIND } from "../../extension/background/detect.js";
import { DEFAULT_BLOCKLIST } from "../../extension/shared/policy.js";
import { DIRECTION, MSG, makeMessage, validateMessage } from "../../extension/shared/protocol.js";

const STORE = "firefox-container-7";
const WINDOW = 5;
const MIN = 60000;

const SETTLED = Object.freeze({ ok: true, settled: true, waitedMs: 12, mutations: 0, visibility: "visible", rafHz: 60 });
const EXTRACTED = Object.freeze({
	ok: true,
	url: "https://example.com/final",
	page: { title: "A title", author: null, published: null, lang: "en", site: null, word_count: 400, extractor: "defuddle@0.19.4" },
	extraction: { view: "article", coverage_pct: 80, hidden_removed: 0, capped: false },
	content: { markdown: "# A title\n\nthe content behind the check", text: "A title the content behind the check", html: null, raw_html: null, links: [] },
	truncated: { markdown: false, text: false, html: false, raw_html: false },
	stats: {},
});

/** What content/detect-dom.js reports. @param {Record<string, unknown>} [over] */
const domOf = (over = {}) => ({ ok: true, title_interstitial: false, cf_challenge: false, turnstile: false, datadome: false, recaptcha: false, hcaptcha: false, reddit_block: false, consent: false, cf_chl_opt: false, text_len: 3000, ...over });

/**
 * A page as the job runner gets to see it: the response headers the guard
 * recorded, where the tab is, what the detection script reports.
 * @typedef {{ status: number | null, cfMitigated: boolean, retryAfterS: number | null, url: string, dom: Record<string, unknown> | null }} Page
 */

/** @type {Page} */
const CONTENT = Object.freeze({ status: 200, cfMitigated: false, retryAfterS: null, url: "https://example.com/final", dom: domOf() });
/** @type {Page} a Cloudflare interstitial: 403, the header, a thin page with its title */
const CF = Object.freeze({ status: 403, cfMitigated: true, retryAfterS: null, url: "https://example.com/start", dom: domOf({ title_interstitial: true, cf_challenge: true, text_len: 180 }) });

/**
 * The arguments the job runner gave the settle script, call by call.
 * @param {{ file?: string, code?: string }[]} scripts
 * @returns {Record<string, any>[]}
 */
const settleArgs = (scripts) =>
	scripts
		.map((s) => s.code ?? "")
		.filter((code) => code.startsWith("globalThis.__bgwSettle = "))
		.map((code) => JSON.parse(code.slice("globalThis.__bgwSettle = ".length, -1)));

/** @param {{ rng?: () => number, tuning?: Record<string, unknown>, popOut?: (tabId: number) => Promise<number>, loading?: boolean }} [opts]
 *   loading: the browser reports every tab as still loading */
function setup(opts = {}) {
	const clock = new FakeClock();
	const nav = { onBeforeNavigate: new FakeEvent(), onCommitted: new FakeEvent(), onCompleted: new FakeEvent(), onErrorOccurred: new FakeEvent() };
	/** @type {string[]} */
	const calls = [];
	/** @type {Record<string, any>[]} */
	const sent = [];
	/** @type {[string, import("../../extension/background/jobs.js").Challenge][]} */
	const challenges = [];
	/** @type {Map<number, Page>} what each tab shows */
	const pages = new Map();
	/** @type {Map<number, { nav: any, sealed: boolean, detached: boolean, opts: any }>} */
	const guards = new Map();
	/** @type {Set<number>} */
	const closedTabs = new Set();
	/** @type {{ file?: string, code?: string }[]} */
	const scripts = [];
	const sink = logSink();
	let nextTab = 40;
	/** From the first parking on, a setup with "loading" reports its tabs as still loading. */
	let parkedOnce = false;
	/** The page the next navigation leads to. */
	const world = { next: /** @type {Page} */ (CONTENT), paused: false, stuck: false };

	/** @param {number} tabId @param {Page} page a navigation of the tab that ends on that page */
	const show = (tabId, page) => {
		pages.set(tabId, page);
		const guard = guards.get(tabId);
		if (guard !== undefined) Object.assign(guard.nav, { httpStatus: page.status, cfMitigated: page.cfMitigated, retryAfterS: page.retryAfterS });
		nav.onBeforeNavigate.fire({ tabId, frameId: 0, url: page.url });
		nav.onCommitted.fire({ tabId, frameId: 0, url: page.url });
		nav.onCompleted.fire({ tabId, frameId: 0, url: page.url });
	};
	/** @param {number} tabId @param {Page} page a navigation to that page begins; nothing of it is there yet */
	const begin = (tabId, page) => {
		nav.onBeforeNavigate.fire({ tabId, frameId: 0, url: page.url });
	};
	/** @param {number} tabId @param {Page} page the document of that navigation is in the tab; its load is not complete */
	const commit = (tabId, page) => {
		pages.set(tabId, page);
		const guard = guards.get(tabId);
		if (guard !== undefined) Object.assign(guard.nav, { httpStatus: page.status, cfMitigated: page.cfMitigated, retryAfterS: page.retryAfterS });
		nav.onCommitted.fire({ tabId, frameId: 0, url: page.url });
	};
	/** @param {number} tabId @param {string} url a navigation of the tab begins and ends in an error */
	const fail = (tabId, url) => {
		nav.onBeforeNavigate.fire({ tabId, frameId: 0, url });
		nav.onErrorOccurred.fire({ tabId, frameId: 0, url, error: "NS_BINDING_ABORTED" });
	};

	/**
	 * What the popup and the options page can see of the jobs at this moment, and what the runner itself says:
	 * taken whenever the runner touches the browser.
	 * @type {{ at: string, current: boolean, pending: number, results: number, busy: unknown }[]}
	 */
	const samples = [];
	/** @param {string} at */
	const sample = (at) => {
		samples.push({ at, current: jobs.current() !== null, pending: jobs.pending().length, results: sent.filter((m) => m.type === MSG.JOB_RESULT).length, busy: /** @type {any} */ (jobs).busy?.() });
	};

	/** @type {Jobs} */
	const jobs = new Jobs({
		send: (msg) => {
			const check = validateMessage(msg, DIRECTION.TO_DAEMON);
			assert.equal(check.ok, true, `every frame is valid: ${check.ok ? "" : check.error}`);
			sample(String(msg.type));
			sent.push(msg);
			return true;
		},
		maxResultBytes: () => 8388608,
		isPaused: () => world.paused,
		container: { ensure: async () => STORE },
		window: {
			name: "fake",
			acquire: async () => {
				const tabId = nextTab++;
				calls.push(`acquire:${tabId}`);
				return { windowId: WINDOW, tabId };
			},
			navigate: async (tabId) => {
				calls.push(`navigate:${tabId}`);
				const page = world.next;
				setTimeout(() => show(tabId, page), 2);
			},
			release: async (tabId) => {
				sample(`release:${tabId}`);
				calls.push(`release:${tabId}`);
				closedTabs.add(tabId);
			},
			popOut: async (tabId) => {
				calls.push(`popOut:${tabId}`);
				return opts.popOut === undefined ? 900 + tabId : opts.popOut(tabId);
			},
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
					nav: { redirectOrigins: /** @type {string[]} */ ([]), httpStatus: /** @type {number | null} */ (null), contentType: "text/html", cfMitigated: false, retryAfterS: /** @type {number | null} */ (null) },
					sealed: false,
					detached: false,
					sawTopFrame: true,
					opts: o,
					topFrameAt: () => true,
					committed: () => true,
					navigationFailed: () => {},
					seal() {
						g.sealed = true;
					},
					detach() {
						g.detached = true;
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
				sample(details.file ?? "code");
				scripts.push(details);
				if (closedTabs.has(tabId)) throw new Error("no such tab");
				if (details.code !== undefined) return [details.code.startsWith("globalThis.__bgwExtract(") ? EXTRACTED : undefined];
				// A page that never lets the settle script answer.
				if (details.file === "/content/settle.js") return world.stuck ? new Promise(() => {}) : [SETTLED];
				if (details.file === "/content/detect-dom.js") return [pages.get(tabId)?.dom ?? undefined];
				return [undefined];
			},
			get: async (/** @type {number} */ tabId) => {
				if (closedTabs.has(tabId)) throw new Error("no such tab");
				return { id: tabId, url: pages.get(tabId)?.url ?? "about:blank", status: opts.loading === true && parkedOnce ? "loading" : "complete" };
			},
		}),
		webNavigation: /** @type {any} */ (nav),
		log: sink.log,
		onActivity: () => {},
		onChallenge: (what, challenge) => challenges.push([what, challenge]),
		clock,
		rng: opts.rng ?? (() => 0),
		tuning: { errorGraceMs: 30, pollMs: 5, backstopMs: 60000, releaseTimeoutMs: 300, extractTimeoutMs: 500, downloadGraceMs: 40, detectTimeoutMs: 500, ...opts.tuning },
	});

	let n = 0;
	/**
	 * @param {string} id
	 * @param {{ url?: string, page?: Page, humanWaitMs?: number, dwellMs?: number, scroll?: "none" | "lazy" }} [o]
	 */
	const start = (id, o = {}) => {
		n += 1;
		world.next = o.page ?? CONTENT;
		const msg = makeMessage(MSG.JOB_START, {
			job: id,
			kind: "fetch",
			url: o.url ?? `https://site${n}.example/start`,
			session: "auto",
			wait: { timeout_ms: 2000, settle_ms: 20, dwell_ms: o.dwellMs ?? 0, human_wait_ms: o.humanWaitMs ?? 15 * MIN, scroll: o.scroll ?? "none" },
			extract: { markdown: true, text: true, html: false, raw_html: false, links: true, adapter: "auto" },
			files: null,
		});
		assert.equal(validateMessage(msg, DIRECTION.TO_EXT).ok, true);
		jobs.start(msg);
	};
	/** @param {string} id */
	const results = (id) => sent.filter((m) => m.type === MSG.JOB_RESULT && m.job === id);
	/** @param {string} id @returns {Promise<Record<string, any>>} the one result of a job */
	const result = async (id) => {
		await until(() => results(id).length > 0, { timeoutMs: 3000, what: `the result of ${id}` });
		await sleep(20);
		assert.equal(results(id).length, 1, "exactly one result");
		return results(id)[0];
	};
	/** @param {string} id @param {string} phase */
	const reached = (id, phase) => until(() => sent.some((m) => m.type === MSG.JOB_PROGRESS && m.job === id && m.phase === phase), { timeoutMs: 3000, what: `${id} to reach ${phase}` });
	/** Move the fake clock in steps, giving the runner real time to act on each. @param {number} ms @param {number} [step] */
	const advance = async (ms, step = 500) => {
		for (let left = ms; left > 0; left -= step) {
			clock.advance(Math.min(step, left));
			await sleep(4);
		}
	};
	/** @param {string} id */
	const phases = (id) => sent.filter((m) => m.job === id).map((m) => (m.type === MSG.JOB_PROGRESS ? m.phase : m.type));
	/** Start a job on a challenge page and wait until it is parked. @param {string} id @param {Parameters<typeof start>[1]} [o] */
	const park = async (id, o = {}) => {
		start(id, { page: CF, ...o });
		await reached(id, "challenge_wait");
		await advance(5000);
		await until(() => jobs.pending().some((p) => p.job === id), { timeoutMs: 3000, what: `${id} to be parked` });
		parkedOnce = true;
		return /** @type {number} */ ([...guards.keys()].at(-1));
	};
	return { jobs, clock, world, calls, sent, sink, challenges, pages, guards, closedTabs, scripts, samples, show, begin, commit, fail, start, result, results, reached, advance, phases, park };
}

test("a challenge that clears within its grace period: the job goes on, and the result says so", async () => {
	const t = setup({ rng: () => 0.5 });
	t.start("j_1", { url: "https://example.com/start", page: CF });
	await t.reached("j_1", "challenge_wait");
	const tab = /** @type {number} */ ([...t.guards.keys()][0]);
	assert.deepEqual(t.sink.entries.find((e) => e.event === "job.challenge_wait")?.fields, { job: "j_1", kind: KIND.CLOUDFLARE, grace_ms: 12500 });
	// The page is looked at once a second; for three seconds it stays what it is.
	await t.advance(3000);
	assert.equal(t.results("j_1").length, 0);
	assert.equal(t.jobs.current()?.job, "j_1", "it still holds the runner");
	// Then the browser check passes: the page reloads into the content.
	t.show(tab, CONTENT);
	await t.advance(1000);
	const r = await t.result("j_1");
	assert.equal(r.outcome, "ok");
	assert.equal(r.error, null);
	assert.equal(r.detect.kind, KIND.CLOUDFLARE);
	assert.equal(r.detect.evidence, EVIDENCE.CF_HEADER);
	assert.equal(r.detect.resolved, "cleared_by_waiting");
	assert.ok(r.detect.waited_ms >= 3000 && r.detect.waited_ms <= 4500, `waited ${r.detect.waited_ms}`);
	assert.equal(r.content.markdown, "# A title\n\nthe content behind the check");
	assert.equal(r.nav.http_status, 200);
	assert.equal(r.tab_kept_open, false);
	// Settled, waited, settled again behind the challenge, then read.
	assert.deepEqual(t.phases("j_1"), [MSG.JOB_ACCEPTED, "navigating", "settling", "challenge_wait", "settling", "extracting", MSG.JOB_RESULT]);
	assert.equal(t.sent.find((m) => m.type === MSG.JOB_PROGRESS && m.phase === "challenge_wait")?.http_status, 403);
	assert.deepEqual(t.calls, [`acquire:${tab}`, `navigate:${tab}`, `release:${tab}`]);
	assert.equal(t.guards.get(tab)?.detached, true);
	assert.deepEqual(t.challenges, [], "never parked: nobody is told to come");
	assert.equal(t.jobs.pending().length, 0);
	assert.equal(t.clock.pending, 0);
});

test("the grace period is random within 5 to 20 seconds", async () => {
	for (const [u, expected] of /** @type {[number, number][]} */ ([[0, 5000], [0.25, 8750], [0.999999, 20000], [1, 20000], [-3, 5000], [7, 20000]])) {
		const t = setup({ rng: () => u });
		t.start("j_1", { page: CF });
		await t.reached("j_1", "challenge_wait");
		assert.equal(t.sink.entries.find((e) => e.event === "job.challenge_wait")?.fields.grace_ms, expected, String(u));
		// Not parked a moment before the grace period is over, parked right after it.
		await t.advance(expected - 600);
		assert.equal(t.jobs.pending().length, 0, `${u}: still waiting`);
		assert.equal(t.jobs.current()?.job, "j_1");
		await t.advance(700, 100);
		await until(() => t.jobs.pending().length === 1, { what: "the job to be parked" });
		assert.equal(t.jobs.current(), null);
		t.jobs.abortAll("link_down");
		await sleep(30);
	}
});

test("still a challenge after the grace period: the job is parked - tab open, runner free, no result yet", async () => {
	const t = setup();
	const tab = await t.park("j_1", { url: "https://www.shop.example/item/1" });
	assert.equal(t.results("j_1").length, 0, "the job is not finished");
	assert.equal(t.jobs.current(), null, "the runner is free");
	assert.deepEqual(t.jobs.pending().map((p) => [p.job, p.host, p.kind, p.handedOff]), [["j_1", "www.shop.example", KIND.CLOUDFLARE, false]]);
	assert.deepEqual(t.calls, [`acquire:${tab}`, `navigate:${tab}`], "the tab is not closed");
	assert.equal(t.guards.get(tab)?.sealed, false, "and stays under the guard, open");
	assert.equal(t.guards.get(tab)?.detached, false);
	// The rest of the extension is told once, with what was found.
	assert.equal(t.challenges.length, 1);
	assert.equal(t.challenges[0][0], "pending");
	assert.equal(t.challenges[0][1].job, "j_1");
	assert.equal(t.challenges[0][1].host, "www.shop.example");
	assert.deepEqual({ ...t.challenges[0][1].detect, waited_ms: 0 }, { kind: KIND.CLOUDFLARE, evidence: EVIDENCE.CF_HEADER, waited_ms: 0, resolved: null });
	assert.ok(t.challenges[0][1].detect.waited_ms >= 5000);
	assert.deepEqual(t.phases("j_1"), [MSG.JOB_ACCEPTED, "navigating", "settling", "challenge_wait"]);
	assert.ok(t.sink.entries.some((e) => e.event === "job.parked" && e.fields.job === "j_1"));

	// Another job runs meanwhile, from start to result, in a tab of its own.
	t.start("j_2", { url: "https://other.example/page" });
	const r2 = await t.result("j_2");
	assert.equal(r2.outcome, "ok");
	assert.equal(r2.detect, null);
	assert.equal(t.results("j_1").length, 0);
	assert.equal(t.closedTabs.has(tab), false, "the parked tab was left alone");
	assert.equal(t.jobs.pending().length, 1);
});

test("a parked check clears while nobody has the page: it is read, the one result is ok and says it cleared by waiting, the tab goes", async () => {
	const t = setup();
	const tab = await t.park("j_1", { url: "https://example.com/start", scroll: "lazy" });
	await t.advance(4 * MIN, 5000);
	assert.equal(t.results("j_1").length, 0);
	// The page navigates to the content by itself, as it does once a check is passed.
	const scriptsBefore = t.scripts.length;
	t.show(tab, CONTENT);
	await t.advance(300, 100);
	const r = await t.result("j_1");
	assert.equal(r.outcome, "ok");
	assert.equal(r.detect.kind, KIND.CLOUDFLARE);
	// The operator was never given the tab: whatever cleared it, it was not their doing as far as anyone can tell.
	assert.equal(r.detect.resolved, "cleared_by_waiting");
	// In the gateway window, with nobody in front of it, the page behind the check settles like any other: walk and all.
	assert.deepEqual(settleArgs(t.scripts.slice(scriptsBefore)).map((a) => [a.scroll, a.capMs, a.growMs]), [[true, 5000, 20000]]);
	assert.equal(r.render.scroll, "done");
	assert.ok(r.render.timings.parked_ms >= 4 * MIN && r.render.timings.parked_ms < 4 * MIN + 2000, `parked ${r.render.timings.parked_ms}`);
	assert.equal(r.render.timings.handoff_ms, 0);
	assert.ok(r.detect.waited_ms >= 4 * MIN && r.detect.waited_ms < 5 * MIN, `waited ${r.detect.waited_ms}`);
	assert.equal(r.content.markdown, "# A title\n\nthe content behind the check");
	assert.equal(r.nav.http_status, 200);
	assert.equal(r.tab_kept_open, false);
	assert.deepEqual(t.phases("j_1"), [MSG.JOB_ACCEPTED, "navigating", "settling", "challenge_wait", "settling", "extracting", MSG.JOB_RESULT]);
	assert.deepEqual(t.calls.slice(-1), [`release:${tab}`]);
	assert.equal(t.guards.get(tab)?.sealed, true);
	assert.equal(t.guards.get(tab)?.detached, true);
	// Said to be gone before it is read, and over when the result is out.
	assert.deepEqual(t.challenges.map((c) => c[0]), ["pending", "cleared", "ended"]);
	assert.equal(t.challenges[2][1].detect.resolved, "cleared_by_waiting");
	assert.equal(t.jobs.pending().length, 0);
	assert.equal(t.clock.pending, 0, "no timer of the watch is left");
});

test("the operator clears the check in the window they were given: read at once - short cap, no walk - and the result says who, and where the time went", async () => {
	const t = setup();
	const tab = await t.park("j_1", { url: "https://example.com/start", scroll: "lazy" });
	// What the job asked of the page before it was parked: the walk, with the wider bounds for a page that grows.
	assert.deepEqual(settleArgs(t.scripts).map((a) => ({ scroll: a.scroll, scrollSteps: a.scrollSteps, scrollMs: a.scrollMs, growMs: a.growMs, growSteps: a.growSteps, growMaxPx: a.growMaxPx })), [
		{ scroll: true, scrollSteps: 24, scrollMs: 6000, growMs: 20000, growSteps: 120, growMaxPx: 60000 },
	]);
	await t.advance(40000, 5000);
	assert.equal(await t.jobs.handoff("j_1"), true);
	await t.advance(20000, 5000);
	assert.equal(t.results("j_1").length, 0);
	const scriptsBefore = t.scripts.length;
	t.show(tab, CONTENT);
	await t.advance(600, 100);
	const r = await t.result("j_1");
	assert.equal(r.outcome, "ok");
	assert.equal(r.detect.resolved, "cleared_by_operator");
	assert.equal(r.content.markdown, "# A title\n\nthe content behind the check");
	// The operator sits in front of that window: no walk down the page, and the quiet check ends soon either way.
	assert.deepEqual(settleArgs(t.scripts.slice(scriptsBefore)).map((a) => ({ scroll: a.scroll, quietMs: a.quietMs, capMs: a.capMs, growMs: a.growMs })), [{ scroll: false, quietMs: 20, capMs: 1000, growMs: 0 }]);
	assert.equal(r.render.scroll, "skipped_handoff", "and the result says that the walk was left out");
	// Where the time went: every phase is there, whole milliseconds; the long ones are the waiting.
	const tm = r.render.timings;
	assert.deepEqual(Object.keys(tm).sort(), ["cleared_settle_ms", "dwell_ms", "extract_ms", "grace_ms", "handoff_ms", "nav_ms", "parked_ms", "prep_ms", "scroll_ms", "settle_ms"]);
	for (const [phase, value] of Object.entries(tm)) assert.ok(Number.isSafeInteger(value) && value >= 0, `${phase}: ${value}`);
	assert.ok(tm.grace_ms >= 5000 && tm.grace_ms < 6500, `grace ${tm.grace_ms}`);
	assert.ok(tm.handoff_ms >= 40000 && tm.handoff_ms < 41000, `until the operator had the tab: ${tm.handoff_ms}`);
	assert.ok(tm.parked_ms >= 60000 && tm.parked_ms < 61500, `parked: ${tm.parked_ms}`);
	assert.ok(tm.nav_ms < 1000 && tm.settle_ms < 1000 && tm.cleared_settle_ms < 1000 && tm.extract_ms < 1000, JSON.stringify(tm));
	assert.equal(tm.dwell_ms, 0);
	assert.deepEqual(t.challenges.map((c) => c[0]), ["pending", "acked", "cleared", "ended"]);
	assert.equal(t.challenges[3][1].detect.resolved, "cleared_by_operator");
	assert.equal(t.clock.pending, 0);
});

test("a parked tab whose page is there but never finishes loading is looked at all the same; one that is on its way is not", async () => {
	// The browser reports the tab as loading for as long as one slow frame or tracker keeps the load event away.
	const t = setup({ tuning: { loadPatienceMs: 400 }, loading: true });
	const tab = await t.park("j_1", { url: "https://example.com/start" });
	await t.jobs.handoff("j_1");
	// The check is passed: the content page begins to load, its document is committed, and the load never completes.
	t.begin(tab, CONTENT);
	await t.advance(1500, 100);
	assert.equal(t.results("j_1").length, 0, "not committed yet: a page on its way is not looked at");
	t.commit(tab, CONTENT);
	await sleep(150);
	await t.advance(600, 100);
	assert.equal(t.results("j_1").length, 0, "the document has only just arrived");
	await sleep(350);
	await t.advance(1200, 100);
	const r = await t.result("j_1");
	assert.equal(r.outcome, "ok");
	assert.equal(r.detect.resolved, "cleared_by_operator");

	// A navigation that ended in an error while the tab shows a complete document is not waited for either.
	const u = setup();
	const tab2 = await u.park("j_2", { url: "https://example.com/start" });
	u.pages.set(tab2, CONTENT);
	Object.assign(u.guards.get(tab2)?.nav ?? {}, { httpStatus: 200, cfMitigated: false });
	u.fail(tab2, CONTENT.url);
	await u.advance(2000, 100);
	assert.equal((await u.result("j_2")).outcome, "ok");
});

test("a parked page that turns into a refusal ends as blocked", async () => {
	const t = setup();
	const tab = await t.park("j_1");
	t.show(tab, { status: 403, cfMitigated: false, retryAfterS: null, url: "https://site1.example/start", dom: domOf({ text_len: 90 }) });
	await t.advance(300, 100);
	const r = await t.result("j_1");
	assert.equal(r.outcome, "blocked");
	assert.deepEqual(r.error, { code: KIND.HTTP_403, message: "the site refused the request (HTTP 403)", retryable: false, retry_after_s: null });
	assert.deepEqual({ ...r.detect, waited_ms: 0 }, { kind: KIND.HTTP_403, evidence: EVIDENCE.STATUS_403, waited_ms: 0, resolved: null });
	assert.equal(r.content, null);
	assert.ok(t.closedTabs.has(tab));
	assert.deepEqual(t.challenges.map((c) => c[0]), ["pending", "ended"]);
});

test("nobody comes: the parked job expires as a timeout, with what was detected, and the tab goes", async () => {
	const t = setup();
	const tab = await t.park("j_1", { humanWaitMs: 15 * MIN });
	await t.advance(15 * MIN - 2000, 10000);
	assert.equal(t.results("j_1").length, 0);
	assert.equal(t.closedTabs.has(tab), false);
	await t.advance(2000, 500);
	const r = await t.result("j_1");
	assert.equal(r.outcome, "timeout");
	assert.deepEqual(r.error, { code: "challenge_expired", message: "nobody cleared the human check in time", retryable: true, retry_after_s: null });
	assert.equal(r.detect.kind, KIND.CLOUDFLARE);
	assert.equal(r.detect.evidence, EVIDENCE.CF_HEADER);
	assert.equal(r.detect.resolved, null);
	assert.ok(r.detect.waited_ms >= 15 * MIN, `waited ${r.detect.waited_ms}`);
	assert.equal(r.content, null);
	assert.equal(r.tab_kept_open, false);
	assert.ok(t.closedTabs.has(tab));
	assert.deepEqual(t.challenges.map((c) => c[0]), ["pending", "ended"]);
	assert.equal(t.jobs.pending().length, 0);
	assert.equal(t.clock.pending, 0);
});

test("the operator closes the tab of a parked job: tab_closed", async () => {
	const t = setup();
	const tab = await t.park("j_1");
	t.closedTabs.add(tab);
	assert.equal(t.jobs.tabLost(tab), true);
	const r = await t.result("j_1");
	assert.equal(r.outcome, "error");
	assert.equal(r.error.code, "tab_closed");
	assert.equal(r.detect.kind, KIND.CLOUDFLARE);
	assert.equal(t.jobs.pending().length, 0);
	assert.equal(t.jobs.tabLost(tab), false, "only once");
	assert.deepEqual(t.challenges.map((c) => c[0]), ["pending", "ended"]);
	// A window that closes with a parked tab in it counts as closed under a job.
	const u = setup();
	const tab2 = await u.park("j_2");
	u.closedTabs.add(tab2);
	assert.equal(u.jobs.windowClosed(WINDOW), true);
	assert.equal((await u.result("j_2")).error.code, "tab_closed");
});

test("at most three parked jobs: the fourth challenge is reported as needs_human and its tab is closed", async () => {
	const t = setup();
	const tabs = [];
	for (const id of ["j_1", "j_2", "j_3"]) tabs.push(await t.park(id));
	assert.equal(t.jobs.pending().length, 3);
	t.start("j_4", { page: CF });
	await t.reached("j_4", "challenge_wait");
	await t.advance(5000);
	const r = await t.result("j_4");
	assert.equal(r.outcome, "needs_human");
	assert.deepEqual(r.error, { code: "too_many_pending", message: "the page shows a human check, and too many others are already waiting for the operator", retryable: true, retry_after_s: null });
	assert.equal(r.detect.kind, KIND.CLOUDFLARE);
	assert.equal(r.tab_kept_open, false);
	const fourth = /** @type {number} */ ([...t.guards.keys()].at(-1));
	assert.ok(t.closedTabs.has(fourth), "not kept");
	assert.deepEqual(t.jobs.pending().map((p) => p.job), ["j_1", "j_2", "j_3"]);
	assert.deepEqual(t.challenges.map((c) => `${c[0]}:${c[1].job}`), ["pending:j_1", "pending:j_2", "pending:j_3"], "nobody is called for the fourth");
	for (const tab of tabs) assert.equal(t.closedTabs.has(tab), false);
	// One ends: the next challenge is kept again.
	t.show(tabs[1], CONTENT);
	await t.advance(300, 100);
	assert.equal((await t.result("j_2")).outcome, "ok");
	await t.park("j_5");
	assert.deepEqual(t.jobs.pending().map((p) => p.job), ["j_1", "j_3", "j_5"]);
});

test("one parked job per site: a new job for that site opens no tab and points at the one that waits", async () => {
	const t = setup();
	await t.park("j_1", { url: "https://www.shop.example/item/1" });
	const before = t.calls.length;
	// Another host of the same site, while its challenge waits.
	t.start("j_2", { url: "https://forum.shop.example/thread/9" });
	const r = await t.result("j_2");
	assert.equal(r.outcome, "needs_human");
	assert.equal(r.error.code, "challenge_pending");
	assert.equal(r.error.retryable, true);
	assert.equal(r.cookie_scope, null, "no tab was ever opened");
	assert.equal(r.detect.kind, KIND.CLOUDFLARE);
	assert.equal(t.calls.length, before, "nothing was acquired, nothing navigated");
	assert.deepEqual(t.phases("j_2"), [MSG.JOB_RESULT]);
	// Another site is served as usual.
	t.start("j_3", { url: "https://elsewhere.example/" });
	assert.equal((await t.result("j_3")).outcome, "ok");
	assert.equal(t.results("j_1").length, 0);
});

test("a job that does not wait for the operator is never parked", async () => {
	const t = setup();
	t.start("j_1", { page: CF, humanWaitMs: 0 });
	await t.reached("j_1", "challenge_wait");
	await t.advance(5000);
	const r = await t.result("j_1");
	assert.equal(r.outcome, "needs_human");
	assert.equal(r.error.code, "challenge_unattended");
	assert.equal(r.detect.kind, KIND.CLOUDFLARE);
	assert.equal(r.detect.resolved, null);
	assert.ok(r.detect.waited_ms >= 5000);
	assert.equal(t.jobs.pending().length, 0);
	assert.deepEqual(t.challenges, []);
	assert.ok(t.closedTabs.has(/** @type {number} */ ([...t.guards.keys()][0])));
});

test("blocks and walls end the job at once: no grace period, no parking, the tab closes", async () => {
	/** @type {[string, Page, string, string, boolean, number | null][]} */
	const cases = [
		["403", { status: 403, cfMitigated: false, retryAfterS: null, url: "https://example.com/start", dom: domOf({ text_len: 60 }) }, KIND.HTTP_403, EVIDENCE.STATUS_403, false, null],
		["429 with Retry-After", { status: 429, cfMitigated: false, retryAfterS: 120, url: "https://example.com/start", dom: domOf({ text_len: 60 }) }, KIND.HTTP_429, EVIDENCE.STATUS_429, true, 120],
		["Reddit's block page", { status: 403, cfMitigated: false, retryAfterS: null, url: "https://example.com/start", dom: domOf({ reddit_block: true, text_len: 280 }) }, KIND.REDDIT_BLOCK, EVIDENCE.REDDIT_TEXT, false, null],
		["a redirect to a login page", { status: 200, cfMitigated: false, retryAfterS: null, url: "https://example.com/login?dest=%2Fstart", dom: domOf({ text_len: 400 }) }, KIND.LOGIN_WALL, EVIDENCE.LOGIN_PATH, false, null],
		["a consent page", { status: 200, cfMitigated: false, retryAfterS: null, url: "https://example.com/start", dom: domOf({ consent: true, text_len: 300 }) }, KIND.CONSENT_WALL, EVIDENCE.CONSENT_ELEMENT, false, null],
	];
	for (const [name, page, kind, evidence, retryable, retryAfter] of cases) {
		const t = setup();
		t.start("j_1", { url: "https://example.com/start", page });
		const r = await t.result("j_1");
		assert.equal(r.outcome, "blocked", name);
		assert.equal(r.error.code, kind, name);
		assert.equal(r.error.retryable, retryable, name);
		assert.equal(r.error.retry_after_s, retryAfter, name);
		assert.deepEqual(r.detect, { kind, evidence, waited_ms: 0, resolved: null }, name);
		assert.equal(r.content, null, name);
		assert.equal(r.page, null, name);
		assert.deepEqual(t.phases("j_1"), [MSG.JOB_ACCEPTED, "navigating", "settling", MSG.JOB_RESULT], name);
		assert.equal(t.calls.at(-1)?.startsWith("release:"), true, name);
		assert.deepEqual(t.challenges, [], name);
		assert.equal(t.clock.pending, 0, name);
	}
});

test("a full page that merely carries _cf_chl_opt is read like any other", async () => {
	const t = setup();
	t.start("j_1", { page: { ...CONTENT, dom: domOf({ cf_chl_opt: true, turnstile: true, text_len: 18000 }) } });
	const r = await t.result("j_1");
	assert.equal(r.outcome, "ok");
	assert.equal(r.detect, null);
	assert.deepEqual(t.phases("j_1"), [MSG.JOB_ACCEPTED, "navigating", "settling", "extracting", MSG.JOB_RESULT]);
});

test("a challenge that turns into a refusal during the grace period is not waited out", async () => {
	const t = setup({ rng: () => 1 });
	t.start("j_1", { page: CF });
	await t.reached("j_1", "challenge_wait");
	const tab = /** @type {number} */ ([...t.guards.keys()][0]);
	await t.advance(2000);
	t.show(tab, { status: 403, cfMitigated: false, retryAfterS: null, url: "https://site1.example/start", dom: domOf({ text_len: 40 }) });
	await t.advance(1000);
	const r = await t.result("j_1");
	assert.equal(r.outcome, "blocked");
	assert.equal(r.error.code, KIND.HTTP_403);
	assert.ok(r.detect.waited_ms < 5000, "well before the 20 seconds were up");
});

test("hand-off: the tab goes into a window of its own because the operator asked, and that is acknowledged once", async () => {
	const t = setup();
	const tab = await t.park("j_1");
	assert.equal(t.calls.some((c) => c.startsWith("popOut")), false, "no window comes up by itself");
	assert.equal(await t.jobs.handoff("j_1"), true);
	assert.deepEqual(t.calls.slice(-1), [`popOut:${tab}`]);
	assert.deepEqual(t.challenges.map((c) => c[0]), ["pending", "acked"]);
	assert.equal(t.jobs.pending()[0].handedOff, true);
	// Asked again (another click): the tab is brought up again, nobody is told twice.
	assert.equal(await t.jobs.handoff("j_1"), true);
	assert.deepEqual(t.calls.filter((c) => c.startsWith("popOut")), [`popOut:${tab}`, `popOut:${tab}`]);
	assert.deepEqual(t.challenges.map((c) => c[0]), ["pending", "acked"]);
	assert.equal(await t.jobs.handoff("j_unknown"), false);
	// The watch goes on in the new window: cleared, read, closed.
	t.show(tab, CONTENT);
	await t.advance(300, 100);
	assert.equal((await t.result("j_1")).outcome, "ok");
	assert.deepEqual(t.challenges.map((c) => c[0]), ["pending", "acked", "cleared", "ended"]);
	assert.equal(await t.jobs.handoff("j_1"), false, "nothing to hand over any more");

	// A window that cannot be made: said so, not acknowledged, the job still waits.
	const u = setup({
		popOut: async () => {
			throw new Error("no window for you");
		},
	});
	await u.park("j_2");
	assert.equal(await u.jobs.handoff("j_2"), false);
	assert.deepEqual(u.challenges.map((c) => c[0]), ["pending"]);
	assert.equal(u.jobs.pending()[0].handedOff, false);
	assert.ok(u.sink.entries.some((e) => e.event === "job.handoff_failed"));
});

test("a tab the browser does not know for a moment (it is changing windows) is not taken for closed", async () => {
	// Seen in Firefox: tabs.get() fails for a tab while windows.create({ tabId }) moves it.
	const t = setup();
	const tab = await t.park("j_1");
	t.closedTabs.add(tab);
	await t.advance(1600, 100);
	t.closedTabs.delete(tab);
	await t.advance(1500, 100);
	assert.equal(t.results("j_1").length, 0, "one look that found no tab ends nothing");
	assert.equal(t.jobs.pending().length, 1);
	// And while a hand-off is under way the tab is not looked at at all.
	/** @type {() => void} */
	let arrive = () => {};
	const slow = setup({ popOut: (tabId) => new Promise((resolve) => (arrive = () => resolve(900 + tabId))) });
	const moving = await slow.park("j_2");
	const looksBefore = slow.scripts.length;
	const handing = slow.jobs.handoff("j_2");
	slow.closedTabs.add(moving);
	await slow.advance(9000, 100);
	assert.equal(slow.scripts.length, looksBefore, "no script ran in the tab while it moved");
	assert.equal(slow.results("j_2").length, 0);
	slow.closedTabs.delete(moving);
	arrive();
	assert.equal(await handing, true);
	await slow.advance(3000, 100);
	assert.equal(slow.results("j_2").length, 0);
	assert.equal(slow.jobs.pending()[0].handedOff, true);
	// A tab that stays unknown is gone, also when the browser never said so.
	const gone = setup();
	const lost = await gone.park("j_3");
	gone.closedTabs.add(lost);
	await gone.advance(3100, 100);
	assert.equal(gone.results("j_3").length, 0, "two looks: not yet");
	await gone.advance(1500, 100);
	assert.equal((await gone.result("j_3")).error.code, "tab_closed");
});

test("a parked job is ended by the daemon's cancel, by a pause, by the loss of the link and by the guard", async () => {
	// job.cancel: one result, the tab goes.
	const a = setup();
	const tabA = await a.park("j_1");
	a.jobs.cancel("j_1", "deadline");
	const ra = await a.result("j_1");
	assert.deepEqual([ra.outcome, ra.error.code], ["timeout", "deadline"]);
	assert.ok(a.closedTabs.has(tabA));
	assert.equal(a.jobs.pending().length, 0);

	// The kill switch stops parked jobs too.
	const b = setup();
	const tabB = await b.park("j_1");
	b.jobs.abortAll("paused");
	const rb = await b.result("j_1");
	assert.deepEqual([rb.outcome, rb.error.code], ["aborted", "paused"]);
	assert.ok(b.closedTabs.has(tabB));

	// Link loss: parked jobs survive nothing. The daemon has ended them itself, so no result is sent.
	const c = setup();
	const tabs = [await c.park("j_1"), await c.park("j_2")];
	c.jobs.abortAll("link_down");
	await until(() => tabs.every((tab) => c.closedTabs.has(tab)), { what: "the parked tabs to close" });
	await sleep(30);
	assert.equal(c.sent.filter((m) => m.type === MSG.JOB_RESULT).length, 0);
	assert.equal(c.jobs.pending().length, 0);
	assert.deepEqual(c.challenges.map((x) => `${x[0]}:${x[1].job}`).sort(), ["ended:j_1", "ended:j_2", "pending:j_1", "pending:j_2"]);
	assert.equal(c.clock.pending, 0);

	// The page of a parked job goes somewhere the policy does not allow: the guard's verdict ends it.
	const d = setup();
	const tabD = await d.park("j_1");
	d.guards.get(tabD)?.opts.onVerdict({ outcome: "policy_blocked", code: "private_address", message: "the page leads to a private or local address" });
	const rd = await d.result("j_1");
	assert.deepEqual([rd.outcome, rd.error.code], ["policy_blocked", "private_address"]);
	assert.ok(d.closedTabs.has(tabD));

	// A download caught while a challenge is parked: nobody can tell whose it is, so every job tab goes.
	const e = setup();
	const tabE = await e.park("j_1");
	assert.equal(e.jobs.downloadStarted(), true);
	const re = await e.result("j_1");
	assert.deepEqual([re.outcome, re.error.code], ["unsupported", "download"]);
	assert.ok(e.closedTabs.has(tabE));
});

test("an end from outside wins over a page that was being read after its challenge cleared", async () => {
	const t = setup();
	const tab = await t.park("j_1");
	t.show(tab, CONTENT);
	await t.advance(300, 100);
	// The tab closes in the middle of the reading.
	t.jobs.tabLost(tab);
	const r = await t.result("j_1");
	assert.ok(r.outcome === "error" || r.outcome === "ok");
	if (r.outcome === "error") assert.equal(r.error.code, "tab_closed");
	assert.equal(t.results("j_1").length, 1, "exactly one result either way");
});

test("reading a page whose check was cleared is bounded as a whole: when its time is up the job ends as a timeout, whatever the page does", async () => {
	// The time the reading gets, and how long past it the runner waits before it ends the job itself.
	const t = setup({ tuning: { finishMs: 80, backstopMs: 40 } });
	const tab = await t.park("j_1", { url: "https://example.com/start" });
	t.world.stuck = true;
	const clearedAt = Date.now();
	t.show(tab, CONTENT);
	await t.advance(300, 100);
	const r = await t.result("j_1");
	assert.deepEqual([r.outcome, r.error.code], ["timeout", "deadline"]);
	assert.ok(Date.now() - clearedAt < 2000, "ended by the bound, not by whatever the script's own patience is");
	assert.deepEqual(t.calls.slice(-1), [`release:${tab}`]);
	assert.deepEqual(t.challenges.map((c) => c[0]), ["pending", "cleared", "ended"]);
	assert.equal(t.jobs.busy(), false);
});

test("the dwell before a page is read runs on the injected clock", async () => {
	const t = setup();
	t.start("j_1", { dwellMs: 3000 });
	await t.reached("j_1", "settling");
	await sleep(120);
	assert.equal(t.results("j_1").length, 0, "dwelling: nothing moves while the clock stands still");
	assert.equal(t.phases("j_1").includes("extracting"), false);
	await t.advance(2900, 100);
	assert.equal(t.phases("j_1").includes("extracting"), false);
	await t.advance(100, 100);
	assert.equal((await t.result("j_1")).outcome, "ok");
});

test("nothing is ever done to a challenge page: three read-only scripts, numbers as arguments, no other call", async () => {
	const t = setup();
	const tab = await t.park("j_1");
	await t.jobs.handoff("j_1");
	await t.advance(2 * MIN, 5000);
	t.show(tab, CONTENT);
	await t.advance(300, 100);
	await t.result("j_1");
	const files = new Set(t.scripts.map((s) => s.file).filter((f) => f !== undefined));
	assert.deepEqual([...files].sort(), ["/content/detect-dom.js", "/content/extract.js", "/content/settle.js", "/content/workers.js", "/vendor/defuddle.full.js"]);
	// The fourth is not about the page: when the job is over and its tab is sealed, the service workers of the
	// site are taken away, once, as the last thing before the tab is closed. It reads and touches nothing of the page.
	assert.deepEqual(t.scripts.map((s) => s.file).filter((f) => f === "/content/workers.js").length, 1);
	assert.equal(t.scripts.at(-1)?.file, "/content/workers.js");
	for (const s of t.scripts) {
		if (s.code !== undefined) assert.match(s.code, /^globalThis\.(__bgwSettle = |__bgwExtract\()\{("[A-Za-z]+":(-?[0-9.]+|true|false),?)+\}\)?;$/);
	}
	// While the challenge was up, only the detection script ran in the tab.
	const first = t.scripts.findIndex((s) => s.file === "/content/detect-dom.js");
	const last = t.scripts.findLastIndex((s) => s.file === "/content/detect-dom.js");
	const during = t.scripts.slice(first, last + 1).filter((s) => s.file !== "/content/detect-dom.js");
	assert.deepEqual(during, [], "between the first and the last look at the challenge nothing else touched the page");
	assert.ok(t.scripts.filter((s) => s.file === "/content/detect-dom.js").length > 20, "it was looked at many times");
	// The window strategy was asked for exactly these things.
	assert.deepEqual([...new Set(t.calls.map((c) => c.split(":")[0]))].sort(), ["acquire", "navigate", "popOut", "release"]);
});

// "Clear the gateway container" looked at the running job and at the jobs that wait for the
// operator. A job whose check was just cleared is neither: it has left the list of those that wait, it never
// went back into the runner, and its tab is open until its page was read and its result is out. Sampled the
// way the reviewer did: what is visible of the jobs whenever the runner touches the browser.
test("between a check that cleared and the result of its job the job is alive: busy() says so at every moment, and the container is not cleared under it", async () => {
	const { clearRefusal } = await import("../../extension/background/container.js");
	const t = setup();
	assert.equal(t.jobs.busy(), false);
	assert.equal(clearRefusal(t.jobs), null);
	const tab = await t.park("j_1");
	assert.equal(t.jobs.busy(), true);
	assert.match(String(clearRefusal(t.jobs)), /^A page with a human check waits for you in this container\./);
	const before = t.samples.length;
	// The check is passed; the page behind it is settled and read, its tab is closed, its result is sent.
	t.show(tab, CONTENT);
	await t.advance(300, 100);
	const r = await t.result("j_1");
	assert.equal(r.outcome, "ok");

	// Every moment at which nothing ran and nothing waited, and the result was not out yet.
	const during = t.samples.slice(before).filter((s) => !s.current && s.pending === 0 && s.results === 0);
	assert.ok(during.length >= 5, `the gap exists and is not short: ${during.map((s) => s.at).join(", ")}`);
	for (const at of ["/content/settle.js", "/content/extract.js", `release:${tab}`, MSG.JOB_RESULT]) assert.ok(during.some((s) => s.at === at), `${at} lies in it`);
	assert.deepEqual(during.filter((s) => s.busy !== true).map((s) => s.at), [], "and at every one of them the job counts as alive");
	// Before the gap it was running or waiting, and busy too; after its result nothing is left.
	assert.deepEqual(t.samples.filter((s) => (s.current || s.pending > 0) && s.busy !== true).map((s) => s.at), []);
	assert.equal(t.jobs.busy(), false);
	assert.equal(clearRefusal(t.jobs), null);
	assert.deepEqual([t.jobs.current(), t.jobs.pending()], [null, []]);
});

test("clearRefusal: the container is cleared only when no job is alive - a running one, one that waits, or one in between", async () => {
	const { clearRefusal } = await import("../../extension/background/container.js");
	/** @param {{ current?: unknown, pending?: unknown[], busy?: boolean }} state */
	const jobs = (state) => ({ current: () => state.current ?? null, pending: () => state.pending ?? [], busy: () => state.busy ?? false });
	assert.equal(clearRefusal(jobs({})), null);
	assert.equal(clearRefusal(jobs({ current: { job: "j_1" }, busy: true })), "A page is being loaded right now. Try again when it is done, or pause the gateway first.");
	assert.equal(clearRefusal(jobs({ pending: [{}], busy: true })), "A page with a human check waits for you in this container. Open or close it first (toolbar button).");
	assert.equal(clearRefusal(jobs({ pending: [{}, {}, {}], busy: true })), "3 pages with a human check wait for you in this container. Open or close them first (toolbar button).");
	// What the two lists do not show.
	assert.equal(clearRefusal(jobs({ busy: true })), "A page whose human check was just passed is still being read. Try again in a moment.");
	// It is asked of the real runner: a job that is cancelled before its tab exists leaves a tab on its way, and that counts.
	const t = setup();
	t.start("j_gone", { page: CONTENT });
	assert.equal(t.jobs.busy(), true);
	await t.result("j_gone");
	assert.equal(t.jobs.busy(), false);
});
