// End-to-end tests for problems found in real-browser use, in
// headless Firefox with the real daemon:
//   - "Clear the gateway container" in the options page
//   - the first notification of a parked challenge waits; a check that clears
//     by itself in that time notifies nobody
//   - every result says where its time went (render.timings), and a page the
//     operator has just cleared is read at once
//   - a feed that loads more as it is scrolled is followed while it grows
//   - the page-load limit comes from config.json (fetch.load_timeout_s)
//
// The daemon of this run reads its settings from a config.json, as the
// operator's does: a notification delay of 6 s and a page-load limit of 6 s.
//
// Run with: npm run test:integration

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startHarness, waitFor } from "./harness.js";
import { TIMING_PHASES } from "../../extension/shared/protocol.js";

const CLI = fileURLToPath(new URL("../../cli/bgw", import.meta.url));
const DELAY_S = 6;
const LOAD_S = 6;
// How long a feed that never ends is followed in this run, in place of twenty seconds.
const GROW_MS = 12000;

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;
let seq = 0;

before(async () => {
	h = await startHarness({
		// The delay of config.json applies, not the test daemon's "at once".
		daemon: { challengeDelayMs: undefined },
		tuning: { scrollGrowMs: GROW_MS },
		config: () => ({ notify: { sound: false, challenge_delay_s: DELAY_S }, fetch: { load_timeout_s: LOAD_S } }),
	});
});

after(async () => {
	if (h !== undefined) await h.stop();
});

// A test that fails half-way must not leave a challenge waiting or an options page open.
afterEach(async () => {
	if (h === undefined) return;
	const snap = await h.hook("windows").catch(() => null);
	if (snap === null) return;
	for (const tabId of snap.own.jobTabs) await h.hook("tab.close", { tabId }).catch(() => {});
	await waitFor(async () => (await h.status()).pending.length === 0 && (await h.hook("pending")).length === 0, { timeoutMs: 10000, what: "leftover challenges to end" }).catch(() => {});
});

/** @param {string} host @param {string} path a fixture URL that no earlier job used */
function fx(host, path) {
	seq += 1;
	return h.fixtures.url(host, `${path}${path.includes("?") ? "&" : "?"}n=${seq}`);
}

/** @returns {string} an id for a challenge page of its own */
const newId = () => `l${Date.now().toString(36)}${(seq += 1)}`;

/**
 * Submit a raw job and return its result.
 * @param {string} url
 * @param {Record<string, unknown>} [wait]
 * @returns {Promise<any>}
 */
async function job(url, wait = {}) {
	const res = await h.submitJob({ kind: "fetch", url, wait: { timeout_ms: 15000, settle_ms: 300, dwell_ms: 0, ...wait }, extract: { html: true } });
	assert.equal(res.status, 200, res.text.slice(0, 300));
	return res.json.result;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @returns {Promise<any>} */
const windows = () => h.hook("windows");
/** @returns {Promise<{ job: string, host: string, acked: boolean }[]>} */
const daemonPending = async () => (await h.status()).pending;
/** @returns {Promise<{ id: string }[]>} the extension's own notifications that are showing */
const extNotifications = () => h.hook("notifications.list");
/** @param {string} event @returns {any[]} */
const daemonLog = (event) => h.daemon.logs.map((l) => JSON.parse(l)).filter((l) => l.event === event);

/**
 * Run cli/bgw against the harness's daemon.
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function bgw(args) {
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: path.join(h.tmp, "no-such-home"),
		BGW_URL: `http://127.0.0.1:${h.daemon.port}`,
		BGW_TOKEN_FILE: path.join(h.daemon.configDir, "client.token"),
		BGW_ADMIN_TOKEN_FILE: path.join(h.daemon.configDir, "admin.token"),
	};
	return new Promise((resolve) => {
		execFile(process.env.PYTHON || "python3", [CLI, ...args], { env, timeout: 60000 }, (err, stdout, stderr) => {
			resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr });
		});
	});
}

/**
 * Start a job on a challenge page and wait until it is parked.
 * @param {string} host
 * @param {string} query what kind of challenge: "mode=human", or "mode=auto&ms=..."
 * @param {Record<string, unknown>} [wait]
 */
async function park(host, query, wait = {}) {
	const id = newId();
	const url = fx(host, `/challenge?${query}&id=${id}`);
	const before = (await daemonPending()).map((p) => p.job);
	const startedAt = Date.now();
	const result = job(url, { human_wait_ms: 120000, ...wait });
	await waitFor(async () => (await daemonPending()).some((p) => !before.includes(p.job)), { timeoutMs: 15000, intervalMs: 50, what: `the challenge on ${host} to be parked` });
	const entry = /** @type {{ job: string }} */ ((await daemonPending()).find((p) => !before.includes(p.job)));
	return { id, url, result, job: entry.job, parkedAt: Date.now(), startedAt };
}

test("setup: the daemon runs with the settings of its config.json, the extension is 0.1.9 on protocol 5", async () => {
	const status = await h.status();
	assert.equal(status.extension.ext_version, "0.1.9");
	assert.deepEqual(status.settings.notify, { sound: false, hook: false, challenge_delay_s: DELAY_S });
	assert.deepEqual(status.settings.fetch, { load_timeout_s: LOAD_S });
	assert.deepEqual(h.daemon.desktop.calls, []);
});

test("timings: every result says where its time went, and the daemon writes the numbers to its log and its audit entry", async () => {
	const url = fx("a", "/slow?ms=1200");
	const r = await job(url, { settle_ms: 400, dwell_ms: 500, scroll: "lazy" });
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	const tm = r.render.timings;
	assert.deepEqual(Object.keys(tm), [...TIMING_PHASES]);
	for (const [phase, value] of Object.entries(tm)) assert.ok(Number.isSafeInteger(value) && value >= 0, `${phase}: ${value}`);
	console.log(`timings of a plain job: elapsed_ms=${r.render.elapsed_ms} ${JSON.stringify(tm)}`);
	assert.ok(tm.nav_ms >= 1200 && tm.nav_ms < 6000, `the server held the page back for 1200 ms: nav ${tm.nav_ms}`);
	assert.ok(tm.settle_ms >= 400 && tm.settle_ms < 6000, `settle ${tm.settle_ms}`);
	assert.ok(tm.dwell_ms >= 480 && tm.dwell_ms < 1500, `dwell ${tm.dwell_ms}`);
	assert.ok(tm.extract_ms > 0 && tm.extract_ms < 5000, `extract ${tm.extract_ms}`);
	assert.deepEqual([tm.grace_ms, tm.parked_ms, tm.handoff_ms, tm.cleared_settle_ms], [0, 0, 0, 0], "no challenge, nothing parked");
	const sum = tm.prep_ms + tm.nav_ms + tm.settle_ms + tm.dwell_ms + tm.extract_ms;
	assert.ok(sum <= r.render.elapsed_ms + 20, `the phases are part of the whole: ${sum} of ${r.render.elapsed_ms}`);
	assert.ok(r.render.elapsed_ms - sum < 2500, `and leave little of it unexplained: ${r.render.elapsed_ms - sum} ms`);
	// The daemon: one log line and the audit entry, numbers only.
	const logged = daemonLog("job.timings").find((l) => l.job === r.job);
	assert.deepEqual({ ...logged, t: "", level: "" }, { t: "", level: "", event: "job.timings", job: r.job, elapsed_ms: r.render.elapsed_ms, ...tm });
	const entry = h.daemon.auditEntries().find((e) => e.job === r.job);
	assert.deepEqual(entry.timings, { elapsed_ms: r.render.elapsed_ms, ...tm });
	assert.ok(Object.values(entry.timings).every((v) => Number.isSafeInteger(v)));
});

/** @param {string} id of a job @returns {Promise<Record<string, any>>} what the extension logged about its walk down the page: counts only */
const walk = async (id) => (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === "job.walked" && l.fields.job === id).at(-1)?.fields ?? {};

test("feeds: a listing that loads more as it is scrolled comes back whole, not just its first posts", async () => {
	/** @param {any} r @returns {number[]} the numbers of the posts in a result's text */
	const posts = (r) => [...String(r.content.text).matchAll(/FEED-POST-(\d+) /g)].map((m) => Number(m[1]));
	// Without the walk: the ten posts the page starts with. That is all a long feed gave without the walk.
	const still = await job(fx("a", "/feed?batches=4&delay=250"), { timeout_ms: 30000, scroll: "none" });
	assert.equal(still.outcome, "ok", JSON.stringify(still.error));
	assert.deepEqual(posts(still), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

	// With it: the walk follows the page while it grows - four batches of ten, each a quarter of a second in coming.
	const r = await job(fx("a", "/feed?batches=4&delay=250"), { timeout_ms: 30000, scroll: "lazy" });
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.deepEqual(posts(r), Array.from({ length: 50 }, (_, i) => i + 1), "every post that could be loaded is there, in order");
	assert.equal(r.render.scroll, "done");
	assert.ok(r.render.scrolled_px > 6000, `walked down ${r.render.scrolled_px} px`);
	const walked = await walk(r.job);
	assert.equal(walked.grew, true, "the extension's log says that the page grew under the walk");
	console.log(`feed of 50 posts: elapsed_ms=${r.render.elapsed_ms} scroll_ms=${r.render.timings.scroll_ms} scrolled_px=${r.render.scrolled_px} steps=${walked.steps}`);
	assert.ok(r.render.timings.scroll_ms > 1000 && r.render.timings.scroll_ms < 15000, `the walk took ${r.render.timings.scroll_ms} ms`);
	assert.ok(r.content.markdown.includes("FEED-POST-50 "), "in the Markdown too");

	// A feed that asks for more three thousand pixels before its end (as many do): the walk never stands at the
	// end when the page gets longer, and it takes more steps than an ordinary page is given. All of it is there.
	const early = await job(fx("a", "/feed?batches=9&delay=150&margin=3000"), { timeout_ms: 30000, scroll: "lazy" });
	assert.equal(early.outcome, "ok", JSON.stringify(early.error));
	assert.deepEqual(posts(early), Array.from({ length: 100 }, (_, i) => i + 1));
	const earlyWalk = await walk(early.job);
	console.log(`feed that loads early, 100 posts: elapsed_ms=${early.render.elapsed_ms} scroll_ms=${early.render.timings.scroll_ms} steps=${earlyWalk.steps}`);
	assert.equal(earlyWalk.grew, true);
	assert.ok(earlyWalk.steps > 24, `more than the 24 steps of an ordinary page: ${earlyWalk.steps}`);

	// A feed that never ends is followed for a bounded time (twelve seconds in this run, twenty in the operator's browser).
	const endless = await job(fx("a", "/feed?batches=100000&delay=150"), { timeout_ms: 30000, scroll: "lazy" });
	assert.equal(endless.outcome, "ok", JSON.stringify(endless.error));
	const got = posts(endless);
	console.log(`endless feed: ${got.length} posts, elapsed_ms=${endless.render.elapsed_ms} scroll_ms=${endless.render.timings.scroll_ms} scrolled_px=${endless.render.scrolled_px}`);
	assert.ok(got.length >= 60 && got.length < 2000, `${got.length} posts`);
	assert.ok(endless.render.timings.scroll_ms >= GROW_MS - 1000 && endless.render.timings.scroll_ms < GROW_MS + 3000, `walked for ${endless.render.timings.scroll_ms} ms`);
	assert.ok(endless.render.scrolled_px <= 60000 + 2000);

	// An ordinary page is walked as before: to its end and back, without waiting there for more.
	const article = await job(fx("a", "/smoke/reveal.html"), { scroll: "lazy" });
	assert.equal(article.outcome, "ok", JSON.stringify(article.error));
	assert.match(article.content.markdown, /REVEAL-LAZY/);
	assert.ok(article.render.timings.scroll_ms < 4000, `walk ${article.render.timings.scroll_ms} ms`);
	assert.equal((await walk(article.job)).grew, false);
});

test("page-load limit: fetch.load_timeout_s of config.json bounds a fetch and a search, not the built-in 30 s", async () => {
	// A page that never arrives. With the built-in limit this would take half a minute.
	const started = Date.now();
	const res = await h.daemon.tool("/v1/fetch", { url: fx("b", "/slow") });
	const took = Date.now() - started;
	assert.equal(res.json.outcome, "timeout", res.json.text);
	assert.match(res.json.text, /\ncode: navigation_timeout\n/);
	assert.ok(took >= LOAD_S * 1000 - 200 && took < LOAD_S * 1000 + 6000, `gave up after ${took} ms`);
	// The job the extension was sent carried that limit.
	const logged = h.daemon.auditEntries().filter((e) => e.outcome === "timeout" && e.code === "navigation_timeout").at(-1);
	assert.ok(logged.duration_ms >= LOAD_S * 1000 - 200 && logged.duration_ms < LOAD_S * 1000 + 6000, `audit: ${logged.duration_ms} ms`);
	// A page that takes a little less than the limit is fetched.
	const ok = await h.daemon.tool("/v1/fetch", { url: fx("b", `/slow?ms=${LOAD_S * 1000 - 2500}`) });
	assert.equal(ok.json.outcome, "ok", ok.json.text);
});

test("notification delay: a check that clears by itself after it was parked, within the delay, notifies nobody", async () => {
	const desktopBefore = h.daemon.desktop.calls.length;
	// A browser check that takes 4.5 s: longer than the grace period of this run (1.5 to 2.5 s), so the job is parked.
	const p = await park("a", "mode=auto&ms=4500");
	// Parked: listed everywhere from this moment on.
	assert.equal((await h.daemon.agentStatus()).pending_operator_actions, 1);
	assert.deepEqual((await h.hook("pending")).map((/** @type {any} */ x) => [x.job, x.handedOff]), [[p.job, false]]);
	assert.equal((await h.hook("badge")).text, "1");
	const listed = await bgw(["pending"]);
	assert.match(listed.stdout, new RegExp(`^${p.job}  a\\.localhost  cloudflare_challenge  waiting \\d+ s, kept for another \\d+ s, not opened yet$`, "m"));
	// And nobody has been told: not the desktop, not the browser's own notifications.
	assert.equal(h.daemon.desktop.calls.length, desktopBefore);
	assert.deepEqual(await extNotifications(), []);

	const r = await p.result;
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.match(r.content.html, new RegExp(`bgw-fixture-cleared-${p.id}`));
	assert.deepEqual({ kind: r.detect.kind, resolved: r.detect.resolved }, { kind: "cloudflare_challenge", resolved: "cleared_by_waiting" });
	const tm = r.render.timings;
	console.log(`self-clearing check after parking: elapsed_ms=${r.render.elapsed_ms} ${JSON.stringify(tm)}`);
	assert.ok(tm.grace_ms >= 1400 && tm.grace_ms < 4000, `grace ${tm.grace_ms}`);
	assert.ok(tm.parked_ms > 300 && tm.parked_ms < 5000, `parked ${tm.parked_ms}`);
	assert.equal(tm.handoff_ms, 0, "nobody was given the tab");
	assert.ok(tm.cleared_settle_ms > 0 && tm.cleared_settle_ms < 8000, `from cleared to settled: ${tm.cleared_settle_ms}`);
	// The daemon heard that the check was gone before the page was read.
	assert.equal(daemonLog("job.challenge_gone").filter((l) => l.job === p.job).length, 1);
	// Well past the moment the notification would have been due: there never was one.
	await sleep(Math.max(0, p.parkedAt + DELAY_S * 1000 + 1500 - Date.now()));
	assert.equal(h.daemon.desktop.calls.length, desktopBefore, "no helper, no sound, no hook");
	assert.deepEqual(await extNotifications(), []);
	assert.equal((await h.daemon.agentStatus()).pending_operator_actions, 0);
});

test("notification delay: a check that needs the operator is announced when the delay is over - and read at once when they have passed it", async () => {
	const desktopBefore = h.daemon.desktop.calls.length;
	const p = await park("b", "mode=human", { scroll: "lazy" });
	// Within the delay: pending, and silent.
	await sleep(1500);
	assert.equal(h.daemon.desktop.calls.length, desktopBefore);
	assert.deepEqual(await extNotifications(), []);
	assert.equal((await daemonPending()).length, 1);
	// When it is over: the desktop notification (a stand-in here) and the extension's own.
	await waitFor(() => h.daemon.desktop.notifications().length > 0 && h.daemon.desktop.calls.length > desktopBefore, { timeoutMs: DELAY_S * 1000 + 4000, intervalMs: 50, what: "the notification" });
	const notifiedAfter = Date.now() - p.parkedAt;
	assert.ok(notifiedAfter >= DELAY_S * 1000 - 1500 && notifiedAfter < DELAY_S * 1000 + 3000, `notified ${notifiedAfter} ms after parking`);
	const note = h.daemon.desktop.notifications().at(-1);
	assert.equal(note?.body, "b.localhost shows a human check. Open it to continue; the gateway reads the page once the check is passed.");
	await waitFor(async () => (await extNotifications()).some((n) => n.id === `bgw-challenge-${p.job}`), { timeoutMs: 5000, what: "the extension's own notification" });

	// The operator opens the page and passes the check.
	assert.equal(await h.hook("challenge.open", { job: p.job }), true);
	await waitFor(async () => (await daemonPending())[0]?.acked === true, { timeoutMs: 5000, what: "the hand-off to be acknowledged" });
	await sleep(700);
	const clearedAt = Date.now();
	await h.fixtures.clearChallenge(p.id);
	const r = await p.result;
	const wallMs = Date.now() - clearedAt;
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.match(r.content.html, new RegExp(`bgw-fixture-cleared-${p.id}`));
	assert.equal(r.detect.resolved, "cleared_by_operator");
	// Read at once: no walk down the page in the window the operator has in front of them, a short quiet check.
	assert.equal(r.render.scroll, "skipped_handoff");
	const tm = r.render.timings;
	console.log(`operator-cleared check: from the clearance to the result ${wallMs} ms; elapsed_ms=${r.render.elapsed_ms} ${JSON.stringify(tm)}`);
	assert.ok(wallMs < 5000, `from the passed check to the page in hand: ${wallMs} ms`);
	assert.ok(tm.cleared_settle_ms < 3500, `cleared to settled: ${tm.cleared_settle_ms}`);
	assert.ok(tm.handoff_ms >= DELAY_S * 1000 - 1500 && tm.handoff_ms <= tm.parked_ms, `given to the operator after ${tm.handoff_ms} ms of ${tm.parked_ms} parked`);
	assert.ok(tm.parked_ms - tm.handoff_ms >= 700 && tm.parked_ms - tm.handoff_ms < 6000, `from the hand-off to the cleared page: ${tm.parked_ms - tm.handoff_ms} ms`);
	// Both notifications are gone with the job.
	await waitFor(() => note?.call.child.exited === true, { timeoutMs: 5000, what: "the desktop notification to be closed" });
	assert.deepEqual(await extNotifications(), []);
	assert.equal((await h.daemon.agentStatus()).pending_operator_actions, 0);
});

test("notification delay: bgw open works from the moment of parking, and an operator who has the page is not notified", async () => {
	const desktopBefore = h.daemon.desktop.calls.length;
	const p = await park("c", "mode=human");
	const opened = await bgw(["open", p.job]);
	assert.deepEqual([opened.code, opened.stdout], [0, "asked the browser to bring the page up in a window of its own\n"]);
	await waitFor(async () => (await daemonPending())[0]?.acked === true, { timeoutMs: 8000, what: "the hand-off to be acknowledged" });
	assert.ok(Date.now() - p.parkedAt < DELAY_S * 1000 - 1000, "well within the delay");
	// Past the delay: nothing was posted, by either side.
	await sleep(Math.max(0, p.parkedAt + DELAY_S * 1000 + 1500 - Date.now()));
	assert.equal(h.daemon.desktop.calls.length, desktopBefore);
	assert.deepEqual(await extNotifications(), []);
	await h.fixtures.clearChallenge(p.id);
	const r = await p.result;
	assert.deepEqual([r.outcome, r.detect.resolved], ["ok", "cleared_by_operator"]);
	assert.ok(r.render.timings.handoff_ms < DELAY_S * 1000, `opened after ${r.render.timings.handoff_ms} ms`);
});

/** @param {string} page @param {string[]} ids */
const ui = (page, ids) => h.hook("ui.read", { page, ids });

test("options page: 'Clear the gateway container' asks first, is refused while a page loads or waits, and clears that container alone", async () => {
	const site = h.fixtures.url("d", "/");
	const gateway = (await windows()).containerId;
	assert.match(gateway, /^firefox-container-\d+$/);
	// What must survive: a cookie of the operator's own session, and one in a container of their own.
	const work = await h.hook("identity.create", { name: "Operator's own" });
	/** @type {{ cookieStoreId: string, name: string }[]} every container the browser has: the profile's own, that one, the gateway's */
	const before = await h.hook("identity.list");
	assert.equal(before.filter((i) => i.name === "Browser Gateway").length, 1);
	assert.equal(await h.hook("cookies.set", { url: site, name: "mine", value: "keep" }), true);
	assert.equal(await h.hook("cookies.set", { url: site, name: "work", value: "keeptoo", storeId: work.cookieStoreId }), true);
	// What must go: whatever the gateway's container holds - a cookie a page set there, a passed check.
	assert.equal((await job(h.fixtures.url("d", `/cookie/set?name=gwjar&value=full&n=${(seq += 1)}`))).outcome, "ok");
	assert.deepEqual(await h.hook("cookies.get", { url: site, storeId: gateway }), [{ name: "gwjar", value: "full" }]);
	// (A page this short has no article view: its Markdown is its text.)
	const seenBefore = await job(fx("d", "/cookie/echo"));
	assert.match(seenBefore.content.markdown, /"gwjar":"full"/);
	assert.doesNotMatch(seenBefore.content.markdown, /mine|work/);

	const opened = await h.hook("ui.open", { page: "options" });
	const page = "options";
	const click = (/** @type {string} */ id) => h.hook("ui.click", { page, id });
	const hidden = (/** @type {string} */ id) => h.hook("ui.hidden", { page, id });
	const result = async () => (await ui(page, ["container-result"]))["container-result"];
	try {
		await waitFor(async () => (await ui(page, ["paired"]).catch(() => ({ paired: "" }))).paired === "yes", { timeoutMs: 10000, what: "the options page to show the state" });
		// The first button only asks: it says in plain words what will happen, and nothing has happened.
		assert.equal(await hidden("container-confirm"), true);
		await click("container-clear");
		assert.equal(await hidden("container-confirm"), false);
		const warning = (await ui(page, ["container-warning"]))["container-warning"];
		assert.match(warning, /removes the container "Browser Gateway" with all its cookies and site data/);
		assert.match(warning, /Your own tabs, your logins and your other containers are not touched/);
		assert.equal((await windows()).containerId, gateway);
		// Cancel: nothing happens.
		await click("container-clear-no");
		assert.equal(await hidden("container-confirm"), true);
		assert.equal(await result(), "Nothing was cleared.");
		assert.equal((await windows()).containerId, gateway);
		assert.deepEqual(await h.hook("cookies.get", { url: site, storeId: gateway }), [{ name: "gwjar", value: "full" }]);

		// While a page is being loaded: refused, and the job is not disturbed.
		const running = job(fx("d", "/slow?ms=3500"));
		await waitFor(async () => (await h.hook("status")).job !== null, { timeoutMs: 5000, intervalMs: 50, what: "the job to run" });
		await click("container-clear");
		await click("container-clear-yes");
		await waitFor(async () => (await result()) !== "Clearing..." && (await result()) !== "", { timeoutMs: 5000, what: "the answer" });
		assert.equal(await result(), "A page is being loaded right now. Try again when it is done, or pause the gateway first.");
		assert.equal((await windows()).containerId, gateway);
		assert.equal((await running).outcome, "ok");

		// While a page with a human check waits for the operator: refused, and the page still waits.
		const p = await park("d", "mode=human");
		await click("container-clear");
		await click("container-clear-yes");
		await waitFor(async () => /waits for you/.test(await result()), { timeoutMs: 5000, what: "the answer" });
		assert.equal(await result(), "A page with a human check waits for you in this container. Open or close it first (toolbar button).");
		assert.equal((await windows()).containerId, gateway);
		assert.equal((await h.hook("pending")).length, 1);
		await h.fixtures.clearChallenge(p.id);
		assert.equal((await p.result).outcome, "ok");
		await waitFor(async () => (await h.hook("pending")).length === 0 && (await h.hook("status")).job === null, { timeoutMs: 8000, what: "the gateway to be idle" });
		// The passed check left its mark in the container: the same address is content now.
		assert.equal((await job(p.url)).outcome, "ok");

		// Now it is cleared.
		await click("container-clear");
		await click("container-clear-yes");
		await waitFor(async () => /was cleared/.test(await result()), { timeoutMs: 10000, what: "the container to be cleared" });
		assert.equal(await result(), "The gateway container was cleared: its cookies and site data are gone, and a new, empty container is in place.");
		assert.equal(await hidden("container-confirm"), true);
	} finally {
		await h.hook("window.close", { windowId: opened.windowId }).catch(() => {});
	}

	// A new container, and one only; the operator's own is still there.
	const fresh = (await windows()).containerId;
	assert.match(fresh, /^firefox-container-\d+$/);
	assert.notEqual(fresh, gateway);
	/** @type {{ cookieStoreId: string, name: string }[]} */
	const identities = await h.hook("identity.list");
	assert.deepEqual(identities.filter((i) => i.name === "Browser Gateway"), [{ cookieStoreId: fresh, name: "Browser Gateway" }]);
	assert.equal(identities.some((i) => i.cookieStoreId === gateway), false, "the old one is gone");
	// Every other container the browser had is still there, the same as before.
	assert.deepEqual(identities.filter((i) => i.cookieStoreId !== fresh), before.filter((i) => i.cookieStoreId !== gateway));
	assert.ok(identities.some((i) => i.cookieStoreId === work.cookieStoreId && i.name === "Operator's own"));
	// The operator's cookies: untouched, in the default store and in their own container.
	assert.deepEqual(await h.hook("cookies.get", { url: site }), [{ name: "mine", value: "keep" }]);
	assert.deepEqual(await h.hook("cookies.get", { url: site, storeId: work.cookieStoreId }), [{ name: "work", value: "keeptoo" }]);
	// The gateway's: gone. The new container is empty, and the old one holds nothing any more.
	assert.deepEqual(await h.hook("cookies.get", { url: site, storeId: fresh }), []);
	assert.deepEqual(await h.hook("cookies.get", { url: site, storeId: gateway }).catch(() => []), []);
	// The state is reported, and the gateway works on: the next page is loaded in the new container, without the old cookie.
	await waitFor(async () => (await h.status()).extension.state.container.ready === true, { timeoutMs: 5000, what: "the container to be reported ready" });
	const seenAfter = await job(fx("d", "/cookie/echo"));
	assert.equal(seenAfter.outcome, "ok", JSON.stringify(seenAfter.error));
	assert.match(seenAfter.content.markdown, /\{\}/);
	assert.doesNotMatch(seenAfter.content.markdown, /gwjar|mine|work/);
	assert.match(h.browserLog(), /container\.cleared/);
});
