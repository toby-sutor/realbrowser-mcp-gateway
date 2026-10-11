// The first moments of the extension in a browser that brings its last
// session back: a job tab that was open when the browser went down is there
// again, in the gateway container, with that container's cookies, and asks
// for things - before the extension has a request guard. The gate at the
// start of the background page (extension/background/startgate.js) is what
// stands in its way from the first statement on.
//
// The real extension in headless Firefox, as in gateway.test.js. The browser
// is ended the hard way and restores its session as after a crash.
//
// Run with: npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, waitFor } from "./harness.js";

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;

// A browser that writes its session down every half second and brings it back whatever happened.
const RESTORING = {
	"browser.startup.page": 3,
	"browser.sessionstore.resume_from_crash": true,
	"browser.sessionstore.restore_on_demand": false,
	"browser.sessionstore.interval": 500,
	"browser.sessionstore.interval.idle": 500,
	"browser.sessionstore.max_resumed_crashes": 1000,
	"toolkit.startup.max_resumed_crashes": -1,
};
// How long the browser may need to take the gate's registration in: what a page asks for in that instant can
// still get out.
const ON_THE_WAY_MS = 40;

before(async () => {
	h = await startHarness({ prefs: RESTORING });
});

after(async () => {
	if (h !== undefined) await h.stop();
});

/** @param {string} who @returns {import("../fixtures/server.js").Seen[]} the requests a ticking page of that name made */
const ticks = (who) => h.fixtures.requests.filter((r) => r.path === "/hit" && r.query.who === who && r.query.tick !== undefined);
/** @returns {Promise<any[]>} every tab the browser has */
const tabs = async () => (await h.hook("windows")).windows.flatMap((/** @type {any} */ w) => w.tabs);
/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The moment the background page of the extension began to run, as the gate's own log line tells it.
 * @returns {Promise<{ t0: number, gate: Record<string, number> }>}
 */
async function started() {
	/** @type {any[]} */
	let gone = [];
	// The gate stays a moment after the guard is in place: until the browser has handed it all it was owed.
	await waitFor(
		async () => {
			gone = (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === "startgate.gone");
			return gone.length > 0;
		},
		{ timeoutMs: 15000, what: "the gate to go" },
	);
	assert.equal(gone.length, 1, "the gate went once");
	return { t0: gone[0].t - gone[0].fields.ms, gate: gone[0].fields };
}

test("an ordinary start: the gate is there, goes when the guard is in place, and is no listener of anybody's requests afterwards", async () => {
	const { gate } = await started();
	assert.ok(gate.ms >= 0 && gate.ms < 5000, `it stood for ${gate.ms} ms`);
	// Registered by the first script of the background page, before the modules of the extension were loaded.
	assert.ok(gate.page_ms >= 0, JSON.stringify(gate));
	assert.ok(gate.stored_ms >= 0 && gate.stored_ms <= gate.known_ms && gate.known_ms <= gate.guarded_ms && gate.guarded_ms <= gate.ms, JSON.stringify(gate));
	assert.deepEqual([gate.cancelled, gate.released], [0, 0]);
	const stats = await h.hook("gate.stats");
	assert.deepEqual([stats.listening, stats.known], [false, true]);
	// The operator loads a page in a tab of their own: no listener of the gate hears it.
	const mine = await h.hook("window.open", { url: h.fixtures.url("a", "/plain?via=after-the-gate") });
	await waitFor(() => h.fixtures.requests.some((r) => r.query.via === "after-the-gate"), { timeoutMs: 15000, what: "the operator's page to load" });
	assert.deepEqual(await h.hook("gate.stats"), stats, "nothing was counted: nothing was heard");
	await h.hook("window.close", { windowId: mine.id });
	// And a job runs as ever.
	const res = await h.submitJob({ kind: "fetch", url: h.fixtures.url("a", "/plain?via=job-after-the-gate"), wait: { timeout_ms: 15000, settle_ms: 200, dwell_ms: 0 }, extract: {} });
	assert.equal(res.json.result.outcome, "ok", res.text.slice(0, 300));
});

test("a job tab and a container tab of the operator's, both brought back by the browser at its start: from the moment the gate has hold nothing of the job tab gets out, and it is closed; the operator's is held for a moment, never cancelled, and goes on", async () => {
	// The operator's own container, with a page in front in a window of theirs that asks for something every 5 ms.
	const theirs = await h.hook("identity.create", { name: "Work" });
	let t0 = 0;
	/** @type {Record<string, number>} */
	let gate = {};
	/** @type {import("../fixtures/server.js").Seen[]} */
	let job = [];
	/** @type {import("../fixtures/server.js").Seen[]} */
	let operator = [];
	// Which of the two the browser brings back first, the tabs or the extension, is its own business. What is to be
	// seen here needs the operator's page to be asking when the extension starts: tried until it was.
	for (let attempt = 1; ; attempt++) {
		// Their page, in front in a window of its own - made anew for every round, so that it is in front for sure.
		for (const old of (await tabs()).filter((t) => String(t.url).includes("who=operator"))) await h.hook("tab.close", { tabId: old.id });
		await pause(200);
		const seenBefore = { job: ticks("job").length, operator: ticks("operator").length };
		const mine = await h.hook("window.open", { url: "about:blank" });
		await h.hook("tab.open", { windowId: mine.id, url: h.fixtures.url("b", "/ticker?ms=5&who=operator"), cookieStoreId: theirs.cookieStoreId, active: true });
		// A job whose tab stays open for a while, with a page that asks like the operator's.
		const running = h.submitJob({ kind: "fetch", url: h.fixtures.url("a", `/ticker?ms=5&who=job&n=${attempt}`), wait: { timeout_ms: 30000, settle_ms: 200, dwell_ms: 20000 }, extract: {} }).catch(() => null);
		await waitFor(() => ticks("job").length > seenBefore.job + 20 && ticks("operator").length > seenBefore.operator + 20, { timeoutMs: 20000, what: "both pages to ask for things" });
		const jobTab = (await tabs()).find((t) => String(t.url).includes("who=job"));
		assert.equal(jobTab?.cookieStoreId, (await h.hook("windows")).containerId, "a tab of the gateway container");
		// Long enough for the browser to have written both tabs down; then it goes down without a word to anybody.
		await pause(2500);
		const downAt = Date.now();
		await h.restartBrowser();
		await running;
		({ t0, gate } = await started());
		await pause(1500);
		job = ticks("job").filter((r) => r.t > downAt + 500);
		operator = ticks("operator").filter((r) => r.t > downAt + 500);
		if (operator.some((r) => Number(r.query.at) < t0)) break;
		assert.ok(attempt < 5, "in five starts the browser never had the operator's tab back before the extension ran");
		// The job tab of this round is closed by the extension, as every leftover is; the next round makes another.
		await waitFor(async () => !(await tabs()).some((t) => String(t.url).includes("who=job")), { timeoutMs: 10000, what: "the leftover job tab to be closed" });
	}

	// The browser brought the operator's page back and it went on asking, before the extension ran at all. Whether
	// the job tab got as far in that time is the browser's order of doing things: where it did, it asked for things
	// with nobody to stop it, and nothing in the extension reaches that time.
	// When a page asked is what counts, by its own word: a request can be on its way to the server for a while.
	const askedAt = (/** @type {import("../fixtures/server.js").Seen} */ r) => Number(r.query.at);
	const early = job.filter((r) => askedAt(r) < t0);
	const late = job.filter((r) => askedAt(r) >= t0);
	// How long the operator's requests were kept waiting around the start: from the asking to the arrival.
	const waits = operator.filter((r) => askedAt(r) > t0 - 100 && askedAt(r) < t0 + gate.guarded_ms + 300).map((r) => r.t - askedAt(r));
	const longest = Math.max(0, ...waits);
	console.log(
		`start with a restored session: the job tab asked ${early.length} times${early.length === 0 ? "" : ` in the ${t0 - askedAt(early[0])} ms`} before the gate was registered and got an answer; ` +
			`${late.length} of what it asked after that got out${late.length === 0 ? "" : ` (asked up to ${Math.max(...late.map(askedAt)) - t0} ms after)`}; ` +
			`the operator's container tab waited ${longest} ms at most; gate ${JSON.stringify(gate)}`,
	);
	// From the moment the gate was registered, nothing the job tab asked for reached the server - but for what it
	// asked in the instant the browser needed to take the registration in.
	assert.deepEqual(late.filter((r) => askedAt(r) > t0 + ON_THE_WAY_MS).map((r) => askedAt(r) - t0), [], "nothing the job tab asked for once the gate stood got out");
	assert.equal((await h.hook("gate.stats")).listening, false);

	// The operator's tab: kept waiting for a moment, nothing cancelled, nothing lost, and it goes on.
	const after = operator.filter((r) => askedAt(r) >= t0);
	assert.ok(after.length > 50, `${after.length} requests of the operator's tab after the extension began to run`);
	assert.ok(longest < 2000, `the operator's tab was kept waiting for ${longest} ms`);
	const numbers = after.map((r) => Number(r.query.tick)).sort((a, b) => a - b);
	assert.equal(numbers[numbers.length - 1] - numbers[0] + 1, numbers.length, "every request the operator's page made was answered");
	const still = (await tabs()).find((t) => String(t.url).includes("who=operator"));
	assert.equal(still?.cookieStoreId, theirs.cookieStoreId, "their tab is where it was, in their container");

	// The job tab is gone, and so is its asking; the window it sat in is the gateway's again, with its park tab alone.
	await waitFor(async () => !(await tabs()).some((t) => String(t.url).includes("who=job")), { timeoutMs: 10000, what: "the leftover job tab to be closed" });
	const quietFrom = Date.now();
	await pause(1000);
	assert.equal(ticks("job").filter((r) => r.t > quietFrom).length, 0);
	assert.ok(ticks("operator").filter((r) => r.t > quietFrom).length > 20, "the operator's page is still at it");
	const snap = await h.hook("windows");
	const gw = snap.windows.filter((/** @type {any} */ w) => w.gateway);
	assert.equal(gw.length, 1);
	assert.deepEqual(gw[0].tabs.map((/** @type {any} */ t) => t.role), ["park"]);
	await h.hook("tab.close", { tabId: still.id });
	const res = await h.submitJob({ kind: "fetch", url: h.fixtures.url("a", "/plain?via=job-after-restore"), wait: { timeout_ms: 15000, settle_ms: 200, dwell_ms: 0 }, extract: {} });
	assert.equal(res.json.result.outcome, "ok", res.text.slice(0, 300));
});

test("nothing was left behind, and no listener of the request guard failed", async () => {
	assert.deepEqual((await h.hook("windows")).own.jobTabs, []);
	assert.deepEqual(await h.hook("pending"), []);
	for (const event of ["guard.listener_failed", "job.crashed", "boot.failed"]) assert.equal(h.browserLog().includes(event), false, event);
});
