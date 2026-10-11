// A gateway window that is out of sight (another virtual desktop, minimised):
// its pages get timers that fire about once a second, no animation frames and
// no IntersectionObserver callbacks. These tests run the real settle.js and
// quiet.js against a page model with exactly that, driven by a fake clock that
// is shared with the job runner, and count what the hidden path costs.
//
// What they cannot show: that a real hidden Waterfox window behaves like the
// model. That is for the operator (tests/manual/WATERFOX-CHECKLIST.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { FakeEvent, logSink, sleep } from "../helpers/ext-fakes.js";
import { until } from "../helpers/daemon.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { Jobs } from "../../extension/background/jobs.js";
import { DEFAULT_BLOCKLIST } from "../../extension/shared/policy.js";
import { DIRECTION, MSG, makeMessage, validateMessage } from "../../extension/shared/protocol.js";

const SETTLE = fs.readFileSync(new URL("../../extension/content/settle.js", import.meta.url), "utf8");
const QUIET = fs.readFileSync(new URL("../../extension/content/quiet.js", import.meta.url), "utf8");

const STORE = "firefox-container-7";
const TAB = 40;
const WINDOW = 5;
const MIN = 60000;

/**
 * The cost of the hidden path, as designed (see Jobs#settle): timer hops inside
 * the page, waits of the background page, and tabs.executeScript round trips
 * between the end of the load and the end of settling.
 */
const HIDDEN_PATH = Object.freeze({ pageTimerHops: 0, backgroundWaits: 1, settleScripts: 6 });

/** What content/detect-dom.js reports for a page with content, and for a Cloudflare interstitial. */
const DOM_CONTENT = Object.freeze({ ok: true, title_interstitial: false, cf_challenge: false, turnstile: false, datadome: false, recaptcha: false, hcaptcha: false, reddit_block: false, consent: false, cf_chl_opt: false, text_len: 3000 });
const DOM_CF = Object.freeze({ ...DOM_CONTENT, title_interstitial: true, cf_challenge: true, text_len: 180 });

const EXTRACTED = Object.freeze({
	ok: true,
	url: "https://example.com/final",
	page: { title: "A title", author: null, published: null, lang: "en", site: "Example", word_count: 4, extractor: "defuddle@0.19.4" },
	extraction: { view: "article", coverage_pct: 80, hidden_removed: 0, capped: false },
	content: { markdown: "# A title\n\nhello", text: "A title\nhello", html: null, raw_html: null, links: [] },
	truncated: { markdown: false, text: false, html: false, raw_html: false },
	stats: { text_len: 20, visible_len: 30, html_len: 0, ms: 3, elements_inspected: 9, elements_cap: 60000, capped: false, hidden_removed: 0, fading_kept: 0, dropped: 0 },
});

/**
 * A page as the content scripts see it, on a clock of the test's own.
 * Hidden: timers are quantised up to whole seconds, no frame ever comes, and
 * there is no IntersectionObserver at all (using it would throw).
 * @param {FakeClock} clock
 * @param {(fn: () => void, ms: number) => unknown} arm the clock's own setTimeout, not the counting one
 * @param {{ hidden?: boolean, height?: number, viewport?: number }} [opts]
 */
function fakePage(clock, arm, opts = {}) {
	const base = clock.now();
	const viewport = opts.viewport ?? 800;
	const scrolling = { scrollHeight: opts.height ?? viewport };
	const doc = { visibilityState: opts.hidden === true ? "hidden" : "visible", documentElement: {}, scrollingElement: scrolling };
	/** @type {((list: unknown[]) => void)[]} */
	const observers = [];
	const stats = { timerHops: 0, timerHopsSinceSwitch: 0, frameRequests: 0, scrollCalls: 0, switched: false };
	const win = {
		innerHeight: viewport,
		scrollX: 0,
		scrollY: 0,
		/** @param {{ top: number }} to */
		scrollTo: (to) => {
			stats.scrollCalls += 1;
			win.scrollY = Math.max(0, Math.min(to.top, scrolling.scrollHeight - viewport));
		},
	};
	const context = vm.createContext({
		document: doc,
		window: win,
		Math,
		performance: { now: () => clock.now() - base },
		MutationObserver: class {
			/** @param {(list: unknown[]) => void} cb */
			constructor(cb) {
				this.cb = cb;
			}
			observe() {
				observers.push(this.cb);
			}
			disconnect() {
				const i = observers.indexOf(this.cb);
				if (i >= 0) observers.splice(i, 1);
			}
		},
		requestAnimationFrame: (/** @type {() => void} */ cb) => {
			stats.frameRequests += 1;
			if (doc.visibilityState !== "hidden") arm(cb, 16);
		},
		setTimeout: (/** @type {() => void} */ cb, /** @type {number} */ ms) => {
			stats.timerHops += 1;
			if (stats.switched) stats.timerHopsSinceSwitch += 1;
			const hidden = doc.visibilityState === "hidden";
			return arm(cb, hidden ? Math.max(1, Math.ceil(ms / 1000)) * 1000 : ms);
		},
	});
	return {
		stats,
		win,
		doc,
		context,
		/** @param {boolean} hidden */
		setHidden(hidden) {
			doc.visibilityState = hidden ? "hidden" : "visible";
			stats.switched = true;
		},
		mutate: () => observers.forEach((cb) => cb([{}])),
		/** @param {string} source */
		run: (source) => vm.runInContext(source, context),
	};
}

/**
 * The job runner over a fake browser and one page model.
 * @param {{ hidden?: boolean, height?: number, dom?: Record<string, unknown>, status?: number, cfMitigated?: boolean, rng?: () => number }} [opts]
 */
function setup(opts = {}) {
	const clock = new FakeClock();
	const arm = clock.setTimeout.bind(clock);
	/** @type {number[]} every wait the job runner and the watch over parked jobs asked the clock for */
	const backgroundWaits = [];
	clock.setTimeout = (fn, ms) => {
		backgroundWaits.push(ms);
		return arm(fn, ms);
	};
	const page = fakePage(clock, arm, opts);
	const nav = { onBeforeNavigate: new FakeEvent(), onCompleted: new FakeEvent(), onErrorOccurred: new FakeEvent() };
	/** @type {Record<string, any>[]} */
	const sent = [];
	/** @type {{ file?: string, code?: string }[]} */
	const scripts = [];
	/** @type {[string, any][]} */
	const challenges = [];
	const sink = logSink();
	const world = { dom: /** @type {Record<string, unknown>} */ (opts.dom ?? DOM_CONTENT), status: opts.status ?? 200, cfMitigated: opts.cfMitigated === true };
	/** @type {Record<string, any> | null} */
	let guard = null;
	/** The job tab was released: the browser no longer knows it. */
	let released = false;

	/** The page's answer changes: what the guard heard and what the detection script sees. @param {Record<string, unknown>} dom @param {number} status @param {boolean} cf */
	const showPage = (dom, status, cf) => {
		world.dom = dom;
		world.status = status;
		world.cfMitigated = cf;
		if (guard !== null) Object.assign(guard.nav, { httpStatus: status, cfMitigated: cf });
	};

	const jobs = new Jobs({
		send: (msg) => {
			const check = validateMessage(msg, DIRECTION.TO_DAEMON);
			assert.equal(check.ok, true, `every frame is valid: ${check.ok ? "" : check.error}`);
			sent.push(msg);
			return true;
		},
		maxResultBytes: () => 8388608,
		isPaused: () => false,
		container: { ensure: async () => STORE },
		window: {
			name: "fake",
			acquire: async () => ({ windowId: WINDOW, tabId: TAB }),
			navigate: async (_tabId, url) => {
				setTimeout(() => {
					nav.onBeforeNavigate.fire({ tabId: TAB, frameId: 0, url });
					nav.onCompleted.fire({ tabId: TAB, frameId: 0, url });
				}, 3);
			},
			release: async () => {
				released = true;
			},
			popOut: async () => WINDOW + 1,
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
			attach: () => {
				guard = {
					nav: { redirectOrigins: [], httpStatus: world.status, contentType: "text/html", cfMitigated: world.cfMitigated, retryAfterS: null },
					sealed: false,
					detached: false,
					sawTopFrame: true,
					topFrameAt: () => true,
					committed: () => true,
					navigationFailed: () => {},
					seal() {},
					detach() {},
				};
				return guard;
			},
		}),
		policy: { blocklist: DEFAULT_BLOCKLIST, allowLoopbackPorts: [] },
		optin: { match: () => null, admit: () => 0 },
		optinPolicy: {},
		tabs: /** @type {any} */ ({
			executeScript: async (/** @type {number} */ _tabId, /** @type {{ code?: string, file?: string }} */ details) => {
				scripts.push(details);
				if (details.code !== undefined) {
					const args = /^globalThis\.(__bgwSettle|__bgwQuietArgs) = (\{.*\});$/.exec(details.code);
					if (args !== null) {
						/** @type {Record<string, unknown>} */ (page.context)[args[1]] = JSON.parse(args[2]);
						return [undefined];
					}
					return [details.code.startsWith("globalThis.__bgwExtract(") ? EXTRACTED : undefined];
				}
				if (details.file === "/content/settle.js") return [await page.run(SETTLE)];
				if (details.file === "/content/quiet.js") return [page.run(QUIET)];
				if (details.file === "/content/detect-dom.js") return [world.dom];
				return [undefined];
			},
			get: async () => {
				if (released) throw new Error("Invalid tab ID");
				return { id: TAB, url: "https://example.com/final", status: "complete" };
			},
		}),
		webNavigation: /** @type {any} */ (nav),
		log: sink.log,
		onActivity: () => {},
		onChallenge: (what, challenge) => challenges.push([what, challenge]),
		clock,
		rng: opts.rng ?? (() => 0),
		tuning: { errorGraceMs: 30, pollMs: 5, backstopMs: 600000, releaseTimeoutMs: 300, extractTimeoutMs: 2000, downloadGraceMs: 40, detectTimeoutMs: 2000, hiddenScriptMs: 2000 },
	});

	/** @param {string} id @param {{ settleMs?: number, dwellMs?: number, scroll?: "none" | "lazy", humanWaitMs?: number }} [o] */
	const start = (id, o = {}) => {
		const msg = makeMessage(MSG.JOB_START, {
			job: id,
			kind: "fetch",
			url: "https://example.com/start",
			session: "auto",
			wait: { timeout_ms: 30000, settle_ms: o.settleMs ?? 1500, dwell_ms: o.dwellMs ?? 0, human_wait_ms: o.humanWaitMs ?? 0, scroll: o.scroll ?? "none" },
			extract: { markdown: true, text: true, html: false, raw_html: false, links: true, adapter: "auto" },
			files: null,
		});
		assert.equal(validateMessage(msg, DIRECTION.TO_EXT).ok, true);
		jobs.start(msg);
	};
	/** @param {string} id */
	const results = (id) => sent.filter((m) => m.type === MSG.JOB_RESULT && m.job === id);
	/**
	 * Let fake time pass in steps, giving the runner real time to act on each,
	 * until the job has its result.
	 * @param {string} id
	 * @param {{ limitMs?: number, each?: (elapsedMs: number) => void }} [o]
	 * @returns {Promise<{ result: Record<string, any>, fakeMs: number }>}
	 */
	const finish = async (id, o = {}) => {
		const t0 = clock.now();
		const limit = o.limitMs ?? 120000;
		while (results(id).length === 0 && clock.now() - t0 < limit) {
			clock.advance(100);
			o.each?.(clock.now() - t0);
			await sleep(2);
		}
		await until(() => results(id).length > 0, { timeoutMs: 3000, what: `the result of ${id}` });
		const fakeMs = clock.now() - t0;
		await sleep(20);
		assert.equal(results(id).length, 1, "exactly one result");
		return { result: results(id)[0], fakeMs };
	};
	/** Move fake time on until a condition holds. @param {() => boolean} cond @param {string} what @param {number} [limitMs] */
	const advanceUntil = async (cond, what, limitMs = 120000) => {
		const t0 = clock.now();
		while (!cond() && clock.now() - t0 < limitMs) {
			clock.advance(100);
			await sleep(2);
		}
		assert.equal(cond(), true, what);
	};
	/** @returns {string[]} what the job runner injected into the tab, files and the kind of code, oldest first */
	const injected = () => scripts.map((s) => s.file ?? (s.code?.startsWith("globalThis.__bgwSettle") ? "args:settle" : s.code?.startsWith("globalThis.__bgwQuietArgs") ? `args:quiet:${/"end":(true|false)/.exec(s.code)?.[1]}` : "code:extract"));
	return { jobs, clock, page, sent, scripts, sink, challenges, backgroundWaits, start, finish, advanceUntil, injected, showPage, results };
}

test("hidden at the start: no in-page timer hop, one background wait, no scroll, no dwell, and it says so", async () => {
	const t = setup({ hidden: true, height: 6000 });
	t.start("j_h", { scroll: "lazy", dwellMs: 3000, settleMs: 1500 });
	const { result: r, fakeMs } = await t.finish("j_h");
	assert.equal(r.outcome, "ok");
	assert.equal(r.content.markdown, "# A title\n\nhello", "the page was read all the same");
	// The cost, counted: hops inside the page, waits of the background page, scripts.
	assert.equal(t.page.stats.timerHops, HIDDEN_PATH.pageTimerHops, "no timer of the hidden page was used");
	assert.deepEqual(t.backgroundWaits, [1200], "one wait, on the clock of the background page");
	assert.deepEqual(t.injected().slice(0, HIDDEN_PATH.settleScripts), ["args:settle", "/content/settle.js", "args:quiet:false", "/content/quiet.js", "args:quiet:true", "/content/quiet.js"]);
	// Hidden: each timer of the page would have cost a second. Here the whole job costs the one wait.
	assert.ok(fakeMs >= 1200 && fakeMs <= 1400, `fake time ${fakeMs}`);
	// Nothing was scrolled, and the frames of the hidden page were only counted, never waited for.
	assert.equal(t.page.stats.scrollCalls, 0);
	assert.equal(t.page.win.scrollY, 0);
	assert.equal(t.page.stats.frameRequests, 1, "the quiet check asked for one frame to count; none came");
	assert.deepEqual(
		{ v: r.render.visibility, scroll: r.render.scroll, dwell: r.render.dwell, px: r.render.scrolled_px, settled: r.render.settled, hz: r.render.raf_hz },
		{ v: "hidden", scroll: "skipped_hidden", dwell: "skipped_hidden", px: 0, settled: true, hz: 0 },
	);
	assert.deepEqual(t.sink.entries.find((e) => e.event === "job.hidden_path")?.fields, { job: "j_h", quiet_ms: 1200, settled: true, scroll: "skipped_hidden" });
});

test("hidden: the one quiet check sees a page that is still changing, and says not settled; it does not wait on", async () => {
	const t = setup({ hidden: true });
	t.start("j_busy");
	let mutated = false;
	const { result: r, fakeMs } = await t.finish("j_busy", {
		each: () => {
			// While the quiet check is under way: after its start, before its end.
			const began = t.injected().filter((f) => f === "/content/quiet.js").length === 1;
			if (began && !mutated) {
				mutated = true;
				t.page.mutate();
			}
		},
	});
	assert.equal(mutated, true);
	assert.equal(r.outcome, "ok");
	assert.deepEqual({ v: r.render.visibility, settled: r.render.settled, scroll: r.render.scroll, dwell: r.render.dwell }, { v: "hidden", settled: false, scroll: "off", dwell: "off" });
	// (Fake time also runs on while the runner does its real, asynchronous work between two waits.)
	assert.ok(fakeMs <= 2500, `fake time ${fakeMs}`);
	assert.deepEqual(t.backgroundWaits, [1200]);
	assert.equal(t.page.stats.timerHops, 0);
});

test("hidden with no settle time asked for: no wait at all", async () => {
	const t = setup({ hidden: true });
	t.start("j_zero", { settleMs: 0 });
	const { result: r, fakeMs } = await t.finish("j_zero");
	assert.equal(r.outcome, "ok");
	assert.deepEqual(t.backgroundWaits, []);
	assert.ok(fakeMs <= 1000, `fake time ${fakeMs}`);
	assert.deepEqual({ v: r.render.visibility, settled: r.render.settled, hz: r.render.raf_hz }, { v: "hidden", settled: true, hz: null });
	assert.equal(t.page.stats.frameRequests, 0);
});

test("visible: unchanged - the quiet wait in the page, the walk down and back, the dwell; reported visible, done, done", async () => {
	const t = setup({ height: 5000 });
	t.start("j_v", { scroll: "lazy", dwellMs: 2000, settleMs: 1500 });
	const { result: r, fakeMs } = await t.finish("j_v");
	assert.equal(r.outcome, "ok");
	assert.deepEqual(t.injected().slice(0, 3), ["args:settle", "/content/settle.js", "/content/detect-dom.js"], "no script of the hidden path");
	assert.deepEqual({ v: r.render.visibility, scroll: r.render.scroll, dwell: r.render.dwell, settled: r.render.settled }, { v: "visible", scroll: "done", dwell: "done", settled: true });
	assert.ok(r.render.scrolled_px >= 4000, `walked ${r.render.scrolled_px}`);
	assert.equal(t.page.win.scrollY, 0, "back at the top");
	// The waits are in the page; the one wait of the background page is the dwell.
	assert.ok(t.page.stats.timerHops > 10, `hops ${t.page.stats.timerHops}`);
	assert.deepEqual(t.backgroundWaits, [2000]);
	assert.ok(fakeMs >= 1500 + 2000 && fakeMs < 15000, `fake time ${fakeMs}`);
	assert.equal(t.sink.count("job.hidden_path"), 0);
});

test("the same page, hidden or not: what the hidden path saves against the visible path's hops at a second each", async () => {
	const visible = setup({ height: 5000 });
	visible.start("j_a", { scroll: "lazy", dwellMs: 2500 });
	await visible.finish("j_a");
	// What the visible path's timer hops would cost if the page were hidden: a second each.
	const hopsPaid = visible.page.stats.timerHops * 1000;
	const hidden = setup({ hidden: true, height: 5000 });
	hidden.start("j_b", { scroll: "lazy", dwellMs: 2500 });
	const b = await hidden.finish("j_b");
	assert.ok(b.fakeMs * 5 < hopsPaid, `hidden ${b.fakeMs} ms against ${hopsPaid} ms of throttled hops`);
});

test("it goes out of sight in the middle of the walk: the walk ends at once, the page is back at its top, the hidden path finishes the job", async () => {
	const t = setup({ height: 40000 });
	t.start("j_mid", { scroll: "lazy", dwellMs: 3000, settleMs: 1500 });
	/** @type {number | null} */
	let switchedAt = null;
	const { result: r, fakeMs } = await t.finish("j_mid", {
		each: (ms) => {
			if (switchedAt === null && ms >= 2000 && t.page.stats.scrollCalls >= 2) {
				switchedAt = ms;
				t.page.setHidden(true);
			}
		},
	});
	assert.notEqual(switchedAt, null, "the window went out of sight while the walk was going");
	assert.equal(r.outcome, "ok");
	assert.deepEqual({ v: r.render.visibility, scroll: r.render.scroll, dwell: r.render.dwell }, { v: "hidden", scroll: "cut_short_hidden", dwell: "skipped_hidden" });
	assert.ok(r.render.scrolled_px > 0, "how far the walk got is reported");
	assert.equal(t.page.win.scrollY, 0);
	// The settle script made no timer hop after the switch (the one pending fired and gave up), the quiet check made none.
	assert.equal(t.page.stats.timerHopsSinceSwitch, 0);
	assert.ok(fakeMs - (switchedAt ?? 0) <= 1200 + 600, `from the switch to the result: ${fakeMs - (switchedAt ?? 0)} ms`);
	assert.deepEqual(t.injected().filter((f) => f === "/content/quiet.js").length, 2);
});

test("hidden at the start, in sight again during the quiet check: the job still says hidden", async () => {
	const t = setup({ hidden: true });
	t.start("j_back", { dwellMs: 2000 });
	let shown = false;
	const { result: r } = await t.finish("j_back", {
		each: () => {
			if (!shown && t.injected().includes("/content/quiet.js")) {
				shown = true;
				t.page.setHidden(false);
			}
		},
	});
	assert.equal(shown, true);
	assert.deepEqual({ v: r.render.visibility, dwell: r.render.dwell }, { v: "hidden", dwell: "skipped_hidden" });
});

test("a hidden tab with a challenge: grace period, watch and cleared-detection run on the background page's clock; the page's timers are never used", async () => {
	const t = setup({ hidden: true, dom: DOM_CF, status: 403, cfMitigated: true });
	t.start("j_c", { humanWaitMs: 5000, settleMs: 100 });
	// Hidden path, then the grace period of 5 s (rng 0), then the park, which expires after 5 s.
	const { result: r, fakeMs } = await t.finish("j_c", { limitMs: 60000 });
	assert.equal(r.outcome, "timeout");
	assert.equal(r.error.code, "challenge_expired");
	assert.equal(r.render.visibility, "hidden");
	assert.equal(t.page.stats.timerHops, 0, "not one timer of the hidden page, in grace, watch or park");
	assert.deepEqual(t.challenges.map((c) => c[0]), ["pending", "ended"]);
	// Bounded: the settle wait, the grace period, the park - nothing hung on past them.
	assert.ok(fakeMs <= 100 + 5000 + 5000 + 3000, `fake time ${fakeMs}`);
	assert.equal(t.clock.pending, 0, "no timer is left");
	// After the first settle only the read-only detection script was injected, until the job ended.
	const after = t.injected().slice(t.injected().lastIndexOf("/content/quiet.js") + 1);
	assert.ok(after.length > 3 && after.every((f) => f === "/content/detect-dom.js"), after.join(","));
});

test("a hidden tab whose challenge clears during the grace period: read, ok, cleared by waiting, no page timer", async () => {
	const t = setup({ hidden: true, dom: DOM_CF, status: 403, cfMitigated: true, rng: () => 0.5 });
	t.start("j_g", { humanWaitMs: 5000, settleMs: 100 });
	const { result: r } = await t.finish("j_g", { each: (ms) => ms === 3000 && t.showPage(DOM_CONTENT, 200, false) });
	assert.equal(r.outcome, "ok");
	assert.equal(r.detect.resolved, "cleared_by_waiting");
	assert.equal(r.render.visibility, "hidden");
	assert.equal(t.page.stats.timerHops, 0);
	assert.equal(t.sink.count("job.hidden_path"), 2, "the page behind the challenge was settled on the hidden path too");
	assert.equal(t.challenges.length, 0, "never parked");
});

test("a hidden tab whose parked challenge the operator clears: read, ok, cleared by the operator, no page timer", async () => {
	const t = setup({ hidden: true, dom: DOM_CF, status: 403, cfMitigated: true });
	t.start("j_p", { humanWaitMs: 5 * MIN, settleMs: 100 });
	await t.advanceUntil(() => t.jobs.pending().length === 1, "the job is parked", 60000);
	assert.equal(t.results("j_p").length, 0);
	// The operator asks for the page and passes the check.
	assert.equal(await t.jobs.handoff("j_p"), true);
	t.showPage(DOM_CONTENT, 200, false);
	const { result: r } = await t.finish("j_p", { limitMs: 60000 });
	assert.equal(r.outcome, "ok");
	assert.equal(r.detect.resolved, "cleared_by_operator");
	assert.deepEqual({ v: r.render.visibility, scroll: r.render.scroll }, { v: "hidden", scroll: "off" });
	assert.equal(t.page.stats.timerHops, 0);
	assert.equal(t.jobs.pending().length, 0);
});

test("a hidden tab that never answers the quiet script: the background page's own limit ends the wait for it and the job goes on", async () => {
	const t = setup({ hidden: true });
	const original = t.page.run;
	t.page.run = (source) => (source === QUIET ? new Promise(() => {}) : original(source));
	t.start("j_hang", { settleMs: 100 });
	const { result: r } = await t.finish("j_hang", { limitMs: 600000 });
	assert.equal(r.outcome, "ok");
	assert.equal(r.render.settled, false, "not known to be quiet");
	assert.equal(r.render.visibility, "hidden");
});

test("a hidden tab that answers the start of the quiet check and never the end: the job goes on, not known to be quiet", async () => {
	const t = setup({ hidden: true });
	const original = t.page.run;
	let quietCalls = 0;
	t.page.run = (source) => (source === QUIET && ++quietCalls === 2 ? new Promise(() => {}) : original(source));
	t.start("j_half", { settleMs: 100 });
	const { result: r } = await t.finish("j_half", { limitMs: 600000 });
	assert.equal(r.outcome, "ok");
	assert.deepEqual({ settled: r.render.settled, v: r.render.visibility, hz: r.render.raf_hz }, { settled: false, v: "hidden", hz: null });
});
