// End-to-end tests for blocks, challenges and the hand-off to the operator:
// the real daemon, the real extension in headless Firefox, local fixture pages
// that behave like pages behind a human check.
//
// Nobody ever does anything to a challenge page here. The "human" is a call to
// a control endpoint of the fixture server; the page that waits notices by
// itself and goes on. The pages report every input event they receive, and
// the last test shows that there was none.
//
// The daemon's desktop notifications go to a stand-in (tests/helpers/
// fake-spawn.js), the browser has no session bus and no sound server: nothing
// of this run reaches the operator's desktop.
//
// Run with: npm run test:integration

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COOLDOWN_HOST, COOLDOWN_MS, TEST_TUNING, startHarness, waitFor } from "./harness.js";
import { DEFAULT_SOUND_CANDIDATES } from "../../daemon/src/notify.js";

const CLI = fileURLToPath(new URL("../../cli/bgw", import.meta.url));

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;
let seq = 0;

before(async () => {
	h = await startHarness();
});

after(async () => {
	if (h !== undefined) await h.stop();
});

// A test that fails half-way must not leave a challenge waiting: the next one
// would find its site taken. Whatever is still pending is ended by closing its tab.
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
const newId = () => `t${Date.now().toString(36)}${(seq += 1)}`;

/**
 * Submit a raw job and return its result. The request is answered when the
 * job is over - for a parked job, when its challenge was cleared or given up.
 * @param {string} url
 * @param {{ wait?: Record<string, unknown>, extract?: Record<string, unknown> }} [opts]
 * @returns {Promise<any>}
 */
async function job(url, opts = {}) {
	const res = await h.submitJob({ kind: "fetch", url, wait: { timeout_ms: 15000, settle_ms: 200, dwell_ms: 0, ...opts.wait }, extract: { html: true, ...opts.extract } });
	assert.equal(res.status, 200, res.text.slice(0, 300));
	return res.json.result;
}

/** @param {Record<string, unknown>} args @returns {Promise<{ isError: boolean, text: string, outcome: string, page: string | null }>} */
async function fetchPage(args) {
	const res = await h.daemon.tool("/v1/fetch", args);
	assert.equal(res.status, 200, res.text.slice(0, 300));
	return res.json;
}

/** @returns {Promise<{ own: { windowId: number | null, parkTabId: number | null, jobTabs: number[], handoffWindows: number[] }, containerId: string | null, windows: any[] }>} */
const windows = () => h.hook("windows");

/** @returns {Promise<{ job: string, host: string, kind: string, handedOff: boolean }[]>} what the extension holds for the operator */
const extPending = () => h.hook("pending");

/** @returns {Promise<{ job: string, host: string, kind: string, waiting_s: number, expires_in_s: number, acked: boolean }[]>} the daemon's list, as the operator sees it */
const daemonPending = async () => (await h.status()).pending;

/** @param {number} n */
async function pendingIs(n) {
	await waitFor(async () => (await daemonPending()).length === n && (await extPending()).length === n, { timeoutMs: 15000, what: `${n} pending challenge(s)` });
}

/** The gateway window with no job tab in it, and no window of ours besides. */
async function assertIdle() {
	await waitFor(async () => (await windows()).own.jobTabs.length === 0, { timeoutMs: 8000, what: "every job tab to close" });
	const snap = await windows();
	const gateways = snap.windows.filter((w) => w.role === "gateway");
	assert.equal(gateways.length, 1, "exactly one gateway window");
	assert.equal(gateways[0].tabs.length, 1, `only the park tab is left, found: ${gateways[0].tabs.map((/** @type {any} */ t) => t.url).join(", ")}`);
	assert.deepEqual(snap.windows.filter((w) => w.role === "handoff"), [], "no hand-off window is left");
	assert.deepEqual(snap.own.handoffWindows, []);
	return snap;
}

/** @param {string} event @returns {any[]} */
const daemonLog = (event) => h.daemon.logs.map((l) => JSON.parse(l)).filter((l) => l.event === event);

/** @param {string} id of a challenge page @returns {import("../fixtures/server.js").Seen[]} the input events that page reported */
const inputSeen = (id) => h.fixtures.seen((s) => s.path === "/challenge/event" && s.query.id === id);

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

test("setup: the extension runs with the short waits of a test run, and the daemon's notifications are stand-ins", async () => {
	assert.equal((await h.hook("status")).dev, true);
	assert.deepEqual(TEST_TUNING.graceMs, [1500, 2500]);
	assert.deepEqual(h.daemon.desktop.calls, [], "nothing was started for a notification so far");
	// The guard behind the stand-ins is loaded: a real helper, gdbus or sound player could not be started from here.
	assert.ok(/** @type {any} */ (globalThis).__bgwNoDesktop !== undefined, "tests/helpers/no-desktop.mjs is loaded (npm run test:integration)");
	// The browser: no session bus, no sound server.
	const environ = fs
		.readdirSync("/proc")
		.filter((p) => /^\d+$/.test(p))
		.map((pid) => {
			try {
				return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(h.tmp) && fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("firefox") ? fs.readFileSync(`/proc/${pid}/environ`, "utf8") : null;
			} catch {
				return null;
			}
		})
		.filter((e) => e !== null);
	assert.ok(environ.length > 0, "found the test browser's processes");
	for (const env of environ) {
		const bus = /(?:^|\0)DBUS_SESSION_BUS_ADDRESS=([^\0]*)/.exec(env)?.[1] ?? "";
		assert.ok(bus.startsWith(`unix:path=${h.tmp}`), "the browser's session bus is a socket in the test directory");
		assert.equal(fs.existsSync(bus.slice("unix:path=".length)), false, "and that socket does not exist");
	}
});

test("a challenge that clears by itself within the grace period: ok, and the result says cleared_by_waiting", async () => {
	const id = newId();
	const url = fx("a", `/challenge?mode=auto&ms=700&id=${id}`);
	const r = await job(url);
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.match(r.content.html, new RegExp(`bgw-fixture-cleared-${id}`));
	assert.equal(r.nav.http_status, 200, "the status of the page behind the check");
	assert.equal(r.detect.kind, "cloudflare_challenge");
	assert.equal(r.detect.resolved, "cleared_by_waiting");
	// Seen by its header, or - when the page was already on its way out - by what it still showed.
	assert.match(r.detect.evidence, /^(header cf-mitigated=challenge|interstitial title|cloudflare challenge element)$/);
	assert.ok(r.detect.waited_ms >= 200 && r.detect.waited_ms < 3000, `waited ${r.detect.waited_ms} ms`);
	// Two loads of the address: the interstitial, then the content.
	const loads = h.fixtures.seen((s) => s.path === "/challenge" && s.query.id === id);
	assert.equal(loads.length, 2);
	assert.equal(loads[1].cookies[`bgwclear${id}`], "1");
	assert.deepEqual(await extPending(), [], "it was never parked");
	assert.deepEqual(h.daemon.desktop.calls, [], "and nobody was called");
	await assertIdle();
	assert.deepEqual(inputSeen(id), []);
});

test("blocks and walls: 403, 429 with Retry-After, the network security page, a login redirect, a consent page - blocked, and the tab closes", async () => {
	/** @type {[string, string, string, string, number | null, boolean][]} */
	const cases = [
		["403", fx("a", "/blocked?kind=403"), "http_403", "status 403", 403, false],
		["429", fx("a", "/blocked?kind=429&retry=120"), "http_429", "status 429", 429, true],
		["reddit", fx("a", "/blocked?kind=reddit"), "reddit_block", "reddit network security page", 403, false],
		["login", fx("a", "/members"), "login_wall", "redirect to a login path", 200, false],
		["consent", fx("a", "/consent-wall"), "consent_wall", "consent dialog with little else on the page", 200, false],
	];
	for (const [name, url, kind, evidence, status, retryable] of cases) {
		const started = Date.now();
		const r = await job(url);
		assert.equal(r.outcome, "blocked", `${name}: ${JSON.stringify(r.error)}`);
		assert.equal(r.error.code, kind, name);
		assert.equal(r.error.retryable, retryable, name);
		assert.deepEqual(r.detect, { kind, evidence, waited_ms: 0, resolved: null }, name);
		assert.equal(r.nav.http_status, status, name);
		assert.equal(r.content, null, `${name}: nothing of a block page is handed on as content`);
		assert.equal(r.page, null, name);
		assert.equal(r.tab_kept_open, false, name);
		assert.ok(Date.now() - started < 8000, `${name}: no grace period for a refusal`);
	}
	// Retry-After is what the site asked for.
	const limited = await job(fx("b", "/blocked?kind=429&retry=77"));
	assert.equal(limited.error.retry_after_s, 77);
	assert.deepEqual(await extPending(), []);
	assert.deepEqual(h.daemon.desktop.calls, [], "a block is no reason to call the operator");
	await assertIdle();
	// The login form was never filled in or sent.
	assert.deepEqual(h.fixtures.seen((s) => s.path === "/login" && s.method === "POST"), []);
});

test("a full page that merely carries _cf_chl_opt, a widget frame and a consent banner is read like any other", async () => {
	const r = await job(fx("a", "/cfopt-full"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.detect, null);
	assert.match(r.content.html, /bgw-fixture-cfopt-marker/);
	assert.ok(r.content.markdown.length > 3000);
	// The frame's address was never asked for: no test run reaches the sites the fixtures name.
	assert.deepEqual(h.fixtures.seen((s) => /cloudflare|captcha|google|hcaptcha/.test(s.host)), []);
	await assertIdle();
});

test("a challenge that does not clear: the job is parked, the slot is free, the operator is told - and when the check is passed the page is read", async () => {
	const id = newId();
	const url = fx("a", `/challenge?mode=human&id=${id}`);
	const before = h.daemon.desktop.calls.length;
	const pending = job(url, { wait: { human_wait_ms: 120000 } });
	await pendingIs(1);

	// The daemon: one pending job, out of the slot.
	const [listed] = await daemonPending();
	assert.match(listed.job, /^j_[A-Za-z0-9_-]+$/);
	assert.equal(listed.host, "a.localhost");
	assert.equal(listed.kind, "cloudflare_challenge");
	assert.equal(listed.acked, false);
	assert.ok(listed.expires_in_s > 100 && listed.expires_in_s <= 120);
	assert.deepEqual((await h.status()).queue, { queued: 0, dispatched: 0 }, "the parked job holds no slot");
	// An agent learns that something waits, not what.
	const agent = await h.daemon.request("GET", "/v1/status");
	assert.equal(agent.json.pending_operator_actions, 1);
	assert.equal("pending" in agent.json, false);
	assert.ok(!agent.text.includes(listed.job) && !agent.text.includes("a.localhost"));
	const mcp = await h.daemon.request("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gateway_status", arguments: {} } }, headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" } });
	assert.match(mcp.text, /pending_operator_actions: 1/);
	assert.ok(!mcp.text.includes(listed.job) && !mcp.text.includes("a.localhost"));

	// The extension: the tab is open in the gateway window, next to the park tab; the badge counts it.
	const snap = await windows();
	assert.equal(snap.own.jobTabs.length, 1);
	const gw = snap.windows.find((w) => w.gateway);
	assert.deepEqual(gw.tabs.map((/** @type {any} */ t) => t.role), ["park", "job"]);
	const tab = gw.tabs[1];
	assert.equal(tab.cookieStoreId, snap.containerId);
	assert.ok(tab.url.includes(`id=${id}`));
	assert.deepEqual(await extPending().then((p) => p.map((x) => [x.job, x.host, x.kind, x.handedOff])), [[listed.job, "a.localhost", "cloudflare_challenge", false]]);
	const badge = await h.hook("badge");
	assert.equal(badge.text, "1");
	assert.match(badge.title, /a page from a\.localhost needs you/);
	// Its own notification: fixed words and the host. It is shown when the daemon posts its own - at once in this
	// run; an operator's daemon waits half a minute first (tests/integration/livefixes.test.js).
	await waitFor(async () => (await h.hook("notifications.list")).length === 1, { timeoutMs: 5000, what: "the extension's notification" });
	const shown = await h.hook("notifications.list");
	assert.deepEqual(shown, [{ id: `bgw-challenge-${listed.job}`, title: "Browser Gateway: a page needs you", message: "a.localhost shows a human check. Click to open the page." }]);

	// The desktop notification, as the stand-in for the helper got it: critical, with "Open", nothing of the page in it.
	await waitFor(() => h.daemon.desktop.notifications().length === 1, { timeoutMs: 5000, what: "the desktop notification" });
	const [note] = h.daemon.desktop.notifications();
	assert.equal(note.summary, "Browser Gateway: a page needs you");
	assert.equal(note.body, "a.localhost shows a human check. Open it to continue; the gateway reads the page once the check is passed.");
	assert.equal(note.urgency, "critical");
	assert.deepEqual(note.actions, ["open=Open"]);
	assert.ok(!note.call.args.join(" ").includes("Verifying you are human"), "no text of the page");
	// A sound goes with it where the machine has one of the sound files - asked of the stand-in, which plays nothing.
	const sounds = h.daemon.desktop.calls.slice(before).filter((c) => c.command === "pw-play");
	assert.equal(sounds.length, DEFAULT_SOUND_CANDIDATES.some((f) => fs.existsSync(f)) ? 1 : 0);
	assert.deepEqual(h.daemon.desktop.calls.slice(before).map((c) => c.command).filter((c) => c !== "pw-play"), ["python3"], "the helper, and nothing else");

	// Meanwhile another job runs from start to end.
	const other = await job(fx("b", "/plain"));
	assert.equal(other.outcome, "ok");
	assert.equal((await windows()).own.jobTabs.length, 1, "the parked tab is still there, the other one is gone");
	assert.equal((await daemonPending()).length, 1);

	// The check is passed. The page notices, reloads into the content, and the job goes on by itself. Nobody was
	// given the tab in a window of their own, so as far as the gateway can tell the check cleared by being waited for.
	await h.fixtures.clearChallenge(id);
	const r = await pending;
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.job, listed.job);
	assert.match(r.content.html, new RegExp(`bgw-fixture-cleared-${id}`));
	assert.deepEqual({ ...r.detect, waited_ms: 0 }, { kind: "cloudflare_challenge", evidence: "header cf-mitigated=challenge", waited_ms: 0, resolved: "cleared_by_waiting" });
	assert.equal(r.nav.http_status, 200);
	assert.equal(r.tab_kept_open, false);
	await pendingIs(0);
	assert.equal((await h.daemon.agentStatus()).pending_operator_actions, 0);
	assert.equal((await h.hook("badge")).text, "");
	assert.deepEqual(await h.hook("notifications.list"), []);
	// The desktop notification was closed with the job.
	await waitFor(() => note.call.child.exited, { timeoutMs: 5000, what: "the notification to be closed" });
	assert.ok(note.call.child.written.some((w) => w.includes('"close"')));
	await assertIdle();
	assert.deepEqual(inputSeen(id), [], "nobody clicked, typed or focused anything in the challenge page");
	assert.equal(daemonLog("job.parked").at(-1)?.job, listed.job);
});

/**
 * Start a job on a challenge page that only the "human" clears, and wait until it is parked.
 * @param {string} host
 * @param {{ kind?: string, humanWaitMs?: number, then?: string }} [opts]
 */
async function parkOne(host, opts = {}) {
	const id = newId();
	const url = fx(host, `/challenge?mode=human&id=${id}${opts.kind === undefined ? "" : `&kind=${opts.kind}`}${opts.then === undefined ? "" : `&then=${opts.then}`}`);
	const before = (await daemonPending()).map((p) => p.job);
	const result = job(url, { wait: { human_wait_ms: opts.humanWaitMs ?? 120000 } });
	await waitFor(async () => (await daemonPending()).some((p) => !before.includes(p.job)), { timeoutMs: 15000, what: `the challenge on ${host} to be parked` });
	const entry = /** @type {NonNullable<Awaited<ReturnType<typeof daemonPending>>[number]>} */ ((await daemonPending()).find((p) => !before.includes(p.job)));
	return { id, url, result, job: entry.job };
}

/**
 * Wait until the tab of a challenge page sits in a hand-off window (other than "not").
 * @param {string} id of the challenge page
 * @param {number | null} [not] a window it must have left
 */
async function handedOver(id, not = null) {
	try {
		await waitFor(
			async () => {
				const now = await findTab(`id=${id}`);
				return now !== null && now.window.role === "handoff" && now.window.id !== not;
			},
			{ timeoutMs: 10000, what: "the tab to come up in a window of its own" },
		);
	} catch (err) {
		// What the extension did instead, for the failure message.
		const logs = (await h.hook("logs").catch(() => [])).slice(-25).map((/** @type {any} */ l) => `${l.event} ${JSON.stringify(l.fields)}`);
		const snap = await windows().catch(() => null);
		throw new Error(`${err instanceof Error ? err.message : err}\n--- extension log ---\n${logs.join("\n")}\n--- windows ---\n${JSON.stringify(snap?.windows.map((w) => ({ id: w.id, role: w.role, tabs: w.tabs.map((/** @type {any} */ t) => `${t.id}:${t.role}:${String(t.url).slice(0, 60)}`) })))}`);
	}
	return /** @type {NonNullable<Awaited<ReturnType<typeof findTab>>>} */ (await findTab(`id=${id}`));
}

/** @param {string} needle part of the URL @returns {Promise<{ window: any, tab: any } | null>} where a tab is right now */
async function findTab(needle) {
	for (const w of (await windows()).windows) {
		for (const t of w.tabs) if (typeof t.url === "string" && t.url.includes(needle)) return { window: w, tab: t };
	}
	return null;
}

test("hand-off: asked for on the command line, the tab moves into a new normal window of its own - and goes, window and all, once the page was read", async () => {
	const p = await parkOne("a");
	const inGateway = await findTab(`id=${p.id}`);
	assert.ok(inGateway !== null && inGateway.window.gateway, "parked in the gateway window");
	const windowsBefore = (await windows()).windows.map((w) => w.id);

	// The operator's list, and their command to bring one up.
	const listed = await bgw(["pending"]);
	assert.equal(listed.code, 0, listed.stderr);
	assert.match(listed.stdout, new RegExp(`^${p.job}  a\\.localhost  cloudflare_challenge  waiting \\d+ s, kept for another \\d+ s, not opened yet$`, "m"));
	const opened = await bgw(["open", p.job]);
	assert.equal(opened.code, 0, opened.stderr);
	assert.equal(opened.stdout, "asked the browser to bring the page up in a window of its own\n");

	const moved = await handedOver(p.id);
	assert.equal(moved.tab.id, inGateway.tab.id, "the same tab, moved - not a copy, not a reload");
	assert.equal(moved.window.type, "normal");
	assert.equal(moved.window.gateway, false);
	assert.equal(windowsBefore.includes(moved.window.id), false, "a new window");
	assert.equal(moved.window.tabs.length, 1, "holding nothing else");
	assert.equal(moved.tab.cookieStoreId, (await windows()).containerId, "still in the gateway container");
	assert.equal(moved.tab.role, "job");
	assert.equal(h.fixtures.seen((s) => s.path === "/challenge" && s.query.id === p.id).length, 1, "the page was loaded once: moving a tab does not reload it");
	// The gateway window keeps its park tab and stays where it was.
	const snap = await windows();
	assert.deepEqual(snap.windows.find((w) => w.gateway).tabs.map((/** @type {any} */ t) => t.role), ["park"]);
	assert.deepEqual(snap.own.handoffWindows, [moved.window.id]);
	assert.deepEqual(snap.own.jobTabs, [moved.tab.id], "still a job tab, still watched");
	// Acknowledged: the daemon knows the operator has the page; the extension's own notification is gone.
	await waitFor(async () => (await daemonPending())[0]?.acked === true, { timeoutMs: 5000, what: "challenge.acked" });
	assert.match((await bgw(["pending"])).stdout, /, opened$/m);
	assert.deepEqual(await extPending().then((x) => x.map((e) => e.handedOff)), [true]);
	assert.deepEqual(await h.hook("notifications.list"), []);
	assert.equal((await h.hook("badge")).text, "1", "it still waits");
	// The extension never asked a window for the focus: a new window simply is in front.
	const logs = await h.hook("logs");
	assert.equal(logs.filter((/** @type {any} */ l) => l.event === "window.handed_off").length, 1);

	// A job runs in the gateway window meanwhile, as if nothing had happened.
	assert.equal((await job(fx("b", "/plain"))).outcome, "ok");

	// The check is passed in the window the operator has in front of them.
	await h.fixtures.clearChallenge(p.id);
	const r = await p.result;
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.detect.resolved, "cleared_by_operator");
	assert.match(r.content.html, new RegExp(`bgw-fixture-cleared-${p.id}`));
	await pendingIs(0);
	const after = await assertIdle();
	assert.equal(after.windows.some((w) => w.id === moved.window.id), false, "the hand-off window went with its tab");
	assert.deepEqual(after.windows.map((w) => w.id).sort(), windowsBefore.sort(), "and nothing else changed");
	// Neither the tab nor its window is left in the recently-closed list.
	await waitFor(async () => (await h.hook("recently.closed.windows")).every((/** @type {any} */ w) => !w.urls.some((/** @type {string} */ u) => u.includes(`id=${p.id}`))), { timeoutMs: 5000, what: "the closed window to be forgotten" });
	assert.deepEqual((await h.hook("recently.closed")).filter((/** @type {any} */ c) => String(c.url).includes(`id=${p.id}`)), []);
	assert.equal((await bgw(["pending"])).stdout, "no page is waiting for you\n");
	// Nothing to open any more.
	const late = await bgw(["open", p.job]);
	assert.equal(late.code, 2);
	assert.match(late.stderr, /no such page is waiting/);
	assert.deepEqual(inputSeen(p.id), []);
});

test("hand-off: the 'Open' action of the desktop notification, the toolbar popup and the extension's own notification all do the same thing", async () => {
	// 1. The desktop notification's action: the daemon sends "attention", the extension moves the tab.
	const a = await parkOne("a");
	await waitFor(() => h.daemon.desktop.notifications().some((n) => !n.call.child.exited), { timeoutMs: 5000, what: "the desktop notification" });
	const note = /** @type {NonNullable<ReturnType<typeof h.daemon.desktop.notifications>[number]>} */ (h.daemon.desktop.notifications().findLast((n) => !n.call.child.exited));
	assert.equal((await findTab(`id=${a.id}`))?.window.gateway, true, "nothing moves before the operator asks");
	h.daemon.desktop.click(note.call, "open");
	await handedOver(a.id);
	assert.equal(daemonLog("challenge.open_requested").at(-1)?.job, a.job);
	await waitFor(async () => (await daemonPending()).find((p) => p.job === a.job)?.acked === true, { timeoutMs: 5000, what: "the acknowledgement" });

	// 2. The toolbar popup: lists what waits, one button each.
	const b = await parkOne("b");
	const popup = await h.hook("ui.open", { page: "popup" });
	await waitFor(async () => {
		try {
			return (await h.hook("ui.read", { page: "popup", ids: [`open-${b.job}`] }))[`open-${b.job}`] !== null;
		} catch {
			return false;
		}
	}, { timeoutMs: 8000, what: "the popup to list the pending page" });
	const shown = await h.hook("ui.read", { page: "popup", ids: ["pending-list", `open-${a.job}`, `open-${b.job}`] });
	assert.match(shown["pending-list"], /a\.localhost/);
	assert.match(shown["pending-list"], /b\.localhost/);
	assert.equal(shown[`open-${a.job}`], "Open again", "the one that was opened already says so");
	assert.equal(shown[`open-${b.job}`], "Open");
	assert.equal((await findTab(`id=${b.id}`))?.window.gateway, true);
	await h.hook("ui.click", { page: "popup", id: `open-${b.job}` });
	await handedOver(b.id);
	await h.hook("window.close", { windowId: popup.windowId });

	// 3. The extension's own notification: a click on it (played through the same handler) moves the third.
	const c = await parkOne("c");
	assert.ok((await h.hook("notifications.list")).some((/** @type {any} */ n) => n.id === `bgw-challenge-${c.job}`));
	assert.equal(await h.hook("challenge.open", { job: c.job }), true);
	await handedOver(c.id);

	// Three windows, one tab each; asking again for one brings it up again in a fresh window, acknowledged once.
	const snap = await windows();
	assert.equal(snap.windows.filter((w) => w.role === "handoff").length, 3);
	assert.equal(snap.own.handoffWindows.length, 3);
	const first = /** @type {NonNullable<Awaited<ReturnType<typeof findTab>>>} */ (await findTab(`id=${a.id}`));
	assert.equal((await bgw(["open", a.job])).code, 0);
	await handedOver(a.id, first.window.id);
	const again = await windows();
	assert.equal(again.windows.filter((w) => w.role === "handoff").length, 3, "the window it left is gone: still three");
	assert.equal(again.windows.some((w) => w.id === first.window.id), false);
	assert.equal(daemonLog("job.challenge_acked").filter((l) => l.job === a.job).length, 1);
	// The job tab it moved is the same one all along.
	assert.equal((await findTab(`id=${a.id}`))?.tab.id, first.tab.id);

	for (const p of [a, b, c]) await h.fixtures.clearChallenge(p.id);
	for (const p of [a, b, c]) assert.equal((await p.result).outcome, "ok");
	await pendingIs(0);
	await assertIdle();
	for (const p of [a, b, c]) assert.deepEqual(inputSeen(p.id), []);
});

test("nobody comes: the parked job expires as a timeout with what was detected, its tab closes, and the site is free again", async () => {
	const p = await parkOne("a", { humanWaitMs: 3000 });
	const started = Date.now();
	const r = await p.result;
	assert.equal(r.outcome, "timeout");
	assert.equal(r.error.code, "challenge_expired");
	assert.equal(r.error.retryable, true);
	assert.deepEqual({ ...r.detect, waited_ms: 0 }, { kind: "cloudflare_challenge", evidence: "header cf-mitigated=challenge", waited_ms: 0, resolved: null });
	assert.ok(r.detect.waited_ms >= 3000, `waited ${r.detect.waited_ms}`);
	assert.ok(Date.now() - started < 6000, "the extension reported the expiry itself, in time");
	assert.equal(r.render !== null, true, "the extension's own report, not the daemon's backstop");
	await pendingIs(0);
	await assertIdle();
	assert.deepEqual(await h.hook("notifications.list"), []);
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
});

test("the operator closes the tab of a pending challenge: the job ends as tab_closed", async () => {
	const p = await parkOne("a");
	const where = /** @type {NonNullable<Awaited<ReturnType<typeof findTab>>>} */ (await findTab(`id=${p.id}`));
	await h.hook("tab.close", { tabId: where.tab.id });
	const r = await p.result;
	assert.equal(r.outcome, "error");
	assert.equal(r.error.code, "tab_closed");
	assert.equal(r.detect.kind, "cloudflare_challenge");
	await pendingIs(0);
	await assertIdle();
	assert.equal((await h.status()).extension.state.paused, false, "a closed tab is no reason to pause");

	// The same when they close the window it was handed over in.
	const q = await parkOne("b");
	assert.equal((await bgw(["open", q.job])).code, 0);
	const handed = await handedOver(q.id);
	await h.hook("window.close", { windowId: handed.window.id });
	const r2 = await q.result;
	assert.equal(r2.error.code, "tab_closed");
	await pendingIs(0);
	await assertIdle();
	assert.equal((await h.status()).extension.state.paused, false);
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
});

test("three challenges may wait; the fourth is reported as needs_human and not kept", async () => {
	const parked = [await parkOne("a"), await parkOne("b"), await parkOne("c")];
	await pendingIs(3);
	assert.equal((await h.hook("badge")).text, "3");
	assert.match((await h.hook("badge")).title, /3 pages need you/);
	assert.equal((await h.daemon.agentStatus()).pending_operator_actions, 3);
	const id = newId();
	const r = await job(fx("d", `/challenge?mode=human&id=${id}`), { wait: { human_wait_ms: 120000 } });
	assert.equal(r.outcome, "needs_human");
	assert.equal(r.error.code, "too_many_pending");
	assert.equal(r.detect.kind, "cloudflare_challenge");
	assert.equal(r.tab_kept_open, false);
	assert.equal(await findTab(`id=${id}`), null, "its tab was closed");
	await pendingIs(3);
	// A fourth site's ordinary page is no trouble at all.
	assert.equal((await job(fx("d", "/plain"))).outcome, "ok");
	// All three end when the daemon goes away (next test); here they are cleared.
	for (const p of parked) await h.fixtures.clearChallenge(p.id);
	for (const p of parked) assert.equal((await p.result).outcome, "ok");
	await pendingIs(0);
	await assertIdle();
});

test("one challenge per site: a second job for the site opens no tab and is pointed at the job that waits", async () => {
	const p = await parkOne("a");
	const seenBefore = h.fixtures.requests.length;
	const url = fx("a", "/plain?second=1");
	// Raw job: refused by the daemon before it reaches the browser.
	const r = await job(url);
	assert.equal(r.outcome, "needs_human");
	assert.equal(r.error.code, "challenge_pending");
	assert.equal(r.job, p.job, "the answer names the job that waits");
	assert.equal(r.detect.kind, "cloudflare_challenge");
	assert.ok(r.error.retry_after_s >= 1 && r.error.retry_after_s <= 60);
	// The agent's view of the same.
	const f = await fetchPage({ url: fx("a", "/plain?second=2") });
	assert.equal(f.outcome, "needs_human");
	assert.equal(f.isError, true);
	assert.match(f.text, new RegExp(`^\\[browser-gateway\\] outcome=needs_human job=${p.job} scope=none status=none\\n`));
	assert.match(f.text, /\ncode: challenge_pending\n/);
	assert.match(f.text, /the operator is notified unless it clears by itself/);
	assert.match(f.text, /do not retry in a loop\. retry_after_s=\d+/);
	assert.equal((await windows()).own.jobTabs.length, 1, "no second tab");
	assert.deepEqual(h.fixtures.requests.slice(seenBefore).filter((s) => s.query.second !== undefined), [], "the site was not asked again");
	// Another site is served.
	assert.equal((await job(fx("b", "/plain"))).outcome, "ok");
	await h.fixtures.clearChallenge(p.id);
	assert.equal((await p.result).outcome, "ok");
	await pendingIs(0);
	// And now the site answers again.
	assert.equal((await job(url)).outcome, "ok");
	await assertIdle();
});

test("an agent's fetch of a page behind a check: needs_human at once with the pending job; once the operator passed it, the next fetch is a cache hit", async () => {
	const id = newId();
	const url = fx("a", `/challenge?mode=human&id=${id}`);
	const started = Date.now();
	const first = await fetchPage({ url });
	const took = Date.now() - started;
	assert.equal(first.outcome, "needs_human");
	assert.equal(first.isError, true);
	assert.equal(first.page, null);
	assert.ok(took < 12000, `answered after the grace period, not after the operator: ${took} ms`);
	const [waiting] = await daemonPending();
	const lines = first.text.split("\n");
	assert.equal(lines[0], `[browser-gateway] outcome=needs_human job=${waiting.job} scope=container status=403`);
	assert.equal(lines[1], `requested_origin: ${new URL(url).origin}`);
	assert.ok(lines.includes(`requested_url: ${url}`) && lines.indexOf(`requested_url: ${url}`) > lines.findIndex((l) => l.startsWith("<<<BEGIN_UNTRUSTED_WEB_CONTENT ")), "the URL in full, between the markers");
	assert.match(lines[2], /^detect: cloudflare_challenge, waited \d+ ms$/);
	assert.equal(lines[3], "code: challenge_pending");
	assert.match(lines[4], /^action: The page shows a human check\. It is kept open in the browser as the pending job named above and is stored once the check is passed; the operator is notified unless it clears by itself\. .* Retrying later may work, but do not retry in a loop\. retry_after_s=60$/);
	assert.ok(waiting.expires_in_s > 800, "kept for the operator for a quarter of an hour");
	// The job lives on without its caller.
	assert.equal((await windows()).own.jobTabs.length, 1);
	// Asking again while it waits: the same job, the same answer, no second load.
	const again = await fetchPage({ url });
	assert.equal(again.outcome, "needs_human");
	assert.match(again.text, new RegExp(`job=${waiting.job} `));
	assert.equal(h.fixtures.seen((s) => s.path === "/challenge" && s.query.id === id).length, 1);

	// The operator passes the check a while later. Nobody is waiting; the page is stored all the same.
	await h.fixtures.clearChallenge(id);
	await pendingIs(0);
	await waitFor(async () => (await h.daemon.agentStatus()).store.stored >= 1 && daemonLog("job.done").some((l) => l.job === waiting.job), { timeoutMs: 8000, what: "the cleared page to be stored" });
	const loads = h.fixtures.seen((s) => s.path === "/challenge" && s.query.id === id).length;
	const hit = await fetchPage({ url });
	assert.equal(hit.outcome, "ok", hit.text.slice(0, 300));
	assert.equal(hit.isError, false);
	assert.match(hit.text, / cache=hit /);
	assert.match(hit.text, new RegExp(`bgw-fixture-cleared-${id}`));
	assert.match(String(hit.page), /^pg_/);
	assert.equal(h.fixtures.seen((s) => s.path === "/challenge" && s.query.id === id).length, loads, "answered from the store: the browser was not asked again");
	await assertIdle();
	assert.deepEqual(inputSeen(id), []);
});

test("wait_for_human_s holds the caller: a quick operator gets the agent its page in the same call, a slow one gets it needs_human when the wait is over", async () => {
	// Quick: cleared while the caller is held.
	const id = newId();
	const url = fx("a", `/challenge?mode=human&id=${id}`);
	const started = Date.now();
	const held = fetchPage({ url, wait_for_human_s: 60 });
	await pendingIs(1);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	await h.fixtures.clearChallenge(id);
	const page = await held;
	assert.equal(page.outcome, "ok", page.text.slice(0, 300));
	assert.equal(page.isError, false);
	assert.match(page.text, / cache=miss /);
	// Cleared while it was parked, in the gateway window: nobody had asked for the page in a window of their own.
	assert.match(page.text, /\nchallenge: cloudflare_challenge cleared_by_waiting, waited \d+ ms\n/);
	assert.match(page.text, new RegExp(`bgw-fixture-cleared-${id}`));
	assert.ok(Date.now() - started < 30000, "released when the page was there, not when the wait was over");
	await pendingIs(0);

	// Slow: the caller is held for as long as it asked, then told; the job goes on.
	const id2 = newId();
	const url2 = fx("b", `/challenge?mode=human&id=${id2}`);
	const t0 = Date.now();
	const slow = await fetchPage({ url: url2, wait_for_human_s: 5 });
	const took = Date.now() - t0;
	assert.equal(slow.outcome, "needs_human");
	assert.ok(took >= 5000 && took < 15000, `held for the grace period plus five seconds: ${took} ms`);
	await pendingIs(1);
	await h.fixtures.clearChallenge(id2);
	await pendingIs(0);
	await waitFor(async () => (await fetchPage({ url: url2 })).outcome === "ok", { timeoutMs: 8000, what: "the late page in the store" });
	await assertIdle();
});

test("the same through MCP and the CLI: needs_human with isError, and the page once it is there", async () => {
	const id = newId();
	const url = fx("a", `/challenge?mode=human&id=${id}`);
	const call = (/** @type {Record<string, unknown>} */ args) =>
		h.daemon.request("POST", "/mcp", { body: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "browser_fetch", arguments: args } }, headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" } });
	const first = await call({ url });
	assert.equal(first.status, 200);
	assert.equal(first.json.result.isError, true);
	assert.match(first.json.result.content[0].text, /^\[browser-gateway\] outcome=needs_human job=j_[A-Za-z0-9_-]+ scope=container status=403\n/);
	const cli = await bgw(["fetch", url]);
	assert.equal(cli.code, 2, "the gateway answered, and the answer is an error");
	assert.match(cli.stdout, /outcome=needs_human/);
	const status = await bgw(["status"]);
	assert.match(status.stdout, /^operator:  1 page\(s\) waiting for you \(bgw pending lists them\)$/m);
	// The agent's token cannot list or open what waits.
	const asAgent = await h.daemon.request("POST", "/v1/attention", { body: { job: (await daemonPending())[0].job } });
	assert.equal(asAgent.status, 403);
	assert.equal((await findTab(`id=${id}`))?.window.gateway, true, "and nothing moved");

	// Held through the CLI while the operator passes the check.
	await h.fixtures.clearChallenge(id);
	await pendingIs(0);
	await waitFor(async () => daemonLog("job.done").some((l) => l.outcome === "ok" && l.job !== undefined) && (await call({ url })).json.result.isError === false, { timeoutMs: 8000, what: "the page through MCP" });
	const read = await bgw(["fetch", url, "--wait-for-human", "30"]);
	assert.equal(read.code, 0, read.stderr);
	assert.match(read.stdout, new RegExp(`bgw-fixture-cleared-${id}`));
	await assertIdle();
});

test("challenges that only the page shows (a widget frame on an otherwise empty page, loaded with 200) are parked like the others", async () => {
	/** @type {[string, string, string][]} */
	const kinds = [
		["turnstile", "cloudflare_challenge", "frame challenges.cloudflare.com"],
		["datadome", "datadome_challenge", "frame captcha-delivery.com"],
		["recaptcha", "captcha_challenge", "frame recaptcha"],
		["hcaptcha", "captcha_challenge", "frame hcaptcha.com"],
	];
	for (const [kind, expected, evidence] of kinds) {
		const p = await parkOne("a", { kind });
		const [listed] = await daemonPending();
		assert.equal(listed.kind, expected, kind);
		await h.fixtures.clearChallenge(p.id);
		const r = await p.result;
		assert.equal(r.outcome, "ok", `${kind}: ${JSON.stringify(r.error)}`);
		assert.deepEqual({ ...r.detect, waited_ms: 0 }, { kind: expected, evidence, waited_ms: 0, resolved: "cleared_by_waiting" }, kind);
		await pendingIs(0);
		assert.deepEqual(inputSeen(p.id), [], kind);
	}
	// The addresses the frames name were never asked for, by name or by the loopback they would resolve to here.
	assert.deepEqual(h.fixtures.seen((s) => /cloudflare|captcha|google|hcaptcha/.test(s.host)), []);
	const guard = await h.hook("guard.stats");
	assert.equal(guard.wide, false);
	await assertIdle();
});

test("a check that is passed and leads to a refusal: the parked job ends as blocked", async () => {
	const p = await parkOne("a", { then: "403" });
	await h.fixtures.clearChallenge(p.id);
	const r = await p.result;
	assert.equal(r.outcome, "blocked");
	assert.equal(r.error.code, "http_403");
	assert.deepEqual({ ...r.detect, waited_ms: 0 }, { kind: "http_403", evidence: "status 403", waited_ms: 0, resolved: null });
	assert.equal(r.content, null);
	await pendingIs(0);
	await assertIdle();
});

test("cooldown: a site that blocked is left alone for a while - the next job is not dispatched and says when to come back", async () => {
	const host = COOLDOWN_HOST.replace(/\.localhost$/, "");
	const first = await job(fx(host, "/blocked?kind=403"));
	assert.equal(first.outcome, "blocked");
	assert.equal(first.error.code, "http_403");
	// The daemon put the site's cooldown into the answer: retry_after_s reflects it.
	assert.ok(first.error.retry_after_s >= 1 && first.error.retry_after_s <= Math.ceil((COOLDOWN_MS * 1.25) / 1000), `retry_after_s ${first.error.retry_after_s}`);

	const seenBefore = h.fixtures.requests.length;
	const url = fx(host, "/plain?cooling=1");
	const refused = await job(url);
	assert.equal(refused.outcome, "blocked");
	assert.equal(refused.error.code, "site_cooldown");
	assert.equal(refused.error.retryable, true);
	assert.ok(refused.error.retry_after_s >= 1 && refused.error.retry_after_s <= Math.ceil((COOLDOWN_MS * 1.25) / 1000));
	assert.equal(refused.render, null, "the daemon's own answer: the browser was never asked");
	assert.equal(refused.cookie_scope, null);
	// The agent is told the same, with the number.
	const agent = await fetchPage({ url: fx(host, "/plain?cooling=2") });
	assert.equal(agent.outcome, "blocked");
	assert.match(agent.text, /\ncode: site_cooldown\naction: The site blocked or challenged a request a moment ago; the gateway leaves it alone for a while\. Retrying later may work, but do not retry in a loop\. retry_after_s=\d+$/m);
	assert.deepEqual(h.fixtures.requests.slice(seenBefore).filter((s) => s.query.cooling !== undefined), [], "nothing reached the site");
	// Both refusals are in the audit log: no cookie store, no time spent - the browser never saw them.
	assert.deepEqual(h.daemon.auditEntries().filter((e) => e.code === "site_cooldown").map((e) => [e.outcome, e.host, e.cookie_scope, e.duration_ms]), [["blocked", COOLDOWN_HOST, null, 0], ["blocked", COOLDOWN_HOST, null, 0]]);
	// Other sites are not held back.
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
	// When it is over the site is asked again.
	await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS * 1.25 + 300));
	const later = await job(url);
	assert.equal(later.outcome, "ok", JSON.stringify(later.error));
	assert.equal(h.fixtures.seen((s) => s.query.cooling === "1").length, 1);

	// A 429 names its own wait, and the cooldown honours it.
	const limited = await job(fx(host, "/blocked?kind=429&retry=9"));
	assert.equal(limited.error.code, "http_429");
	assert.ok(limited.error.retry_after_s >= 9, `retry_after_s ${limited.error.retry_after_s}`);
	const again = await job(fx(host, "/plain?cooling=3"));
	assert.equal(again.error.code, "site_cooldown");
	assert.ok(again.error.retry_after_s >= 7 && again.error.retry_after_s <= 10, `retry_after_s ${again.error.retry_after_s}`);
	await assertIdle();
});

test("pause is a kill switch for what waits as well: parked jobs end, their tabs close", async () => {
	const p = await parkOne("a");
	const q = await parkOne("b");
	assert.equal((await bgw(["open", q.job])).code, 0);
	await handedOver(q.id);
	await h.hook("pause");
	const [r1, r2] = await Promise.all([p.result, q.result]);
	for (const r of [r1, r2]) {
		assert.equal(r.outcome, "aborted");
		assert.equal(r.error.code, "paused");
	}
	await pendingIs(0);
	await assertIdle();
	assert.deepEqual(await h.hook("notifications.list"), []);
	await h.hook("resume");
	await waitFor(async () => (await h.status()).extension.state.paused === false, { timeoutMs: 5000, what: "the resume to reach the daemon" });
	assert.equal((await job(fx("c", "/plain"))).outcome, "ok");
});

test("parked jobs survive nothing: when the daemon goes away their tabs are closed, and a new daemon starts without them", async () => {
	const p = await parkOne("a");
	const q = await parkOne("b");
	assert.equal((await bgw(["open", q.job])).code, 0);
	await handedOver(q.id);
	const notes = h.daemon.desktop.notifications().filter((n) => !n.call.child.exited);
	assert.equal(notes.length, 2);
	// Whoever waits is answered by the daemon that stops.
	const [r1, r2] = await Promise.all([p.result.catch((e) => e), q.result.catch((e) => e), h.restartDaemon()]);
	for (const r of [r1, r2]) {
		// Answered as cancelled by the shutdown, or the connection went first: either way not a page.
		if (!(r instanceof Error)) assert.equal(r.outcome, "aborted");
	}
	// The old daemon closed its notifications on the way out.
	for (const n of notes) assert.equal(n.call.child.exited, true);
	await h.connected();
	// The extension dropped what it held when the link went: no tab, no hand-off window, nothing pending.
	await waitFor(async () => (await extPending()).length === 0, { timeoutMs: 10000, what: "the extension to drop its parked jobs" });
	await assertIdle();
	assert.deepEqual(await daemonPending(), []);
	assert.deepEqual(await h.hook("notifications.list"), []);
	assert.equal((await h.hook("badge")).text, "");
	assert.deepEqual(h.daemon.desktop.calls, [], "the new daemon has called nobody");
	// The pages were not cleared, so nothing of them was stored; asking again starts over.
	assert.equal(await findTab(`id=${p.id}`), null);
	assert.equal((await job(fx("a", "/plain"))).outcome, "ok");
});

test("nothing was ever done to a challenge page, and nothing of this run reached the desktop", async () => {
	// Every challenge page of this run reports each input event it gets. There were none.
	assert.ok(h.fixtures.seen((s) => s.path === "/challenge").length > 30, "many challenge pages were shown");
	assert.deepEqual(h.fixtures.seen((s) => s.path === "/challenge/event").map((s) => `${s.query.type} trusted=${s.query.trusted}`), []);
	// No form of a fixture page was ever sent.
	assert.deepEqual(h.fixtures.seen((s) => s.method === "POST"), []);
	// No request header was added or changed by the extension on the way to a challenge page.
	const first = h.fixtures.seen((s) => s.path === "/challenge")[0];
	assert.equal(Object.keys(first.headers).some((name) => /^x-|bgw|gateway/i.test(name)), false, Object.keys(first.headers).join(", "));
	assert.match(first.headers["user-agent"], /Firefox\/\d+/);
	// The request guard still only listens where it should, and never widened.
	assert.equal((await h.hook("guard.stats")).wide, false);
	// Over the whole run: no listener of the request guard ever failed on a request, and no job tab outlived its job.
	for (const event of ["guard.listener_failed", "job.tab_outlived", "window.job_tab_not_closed"]) assert.equal(h.browserLog().includes(event), false, event);
	// What the daemons of this run started for their notifications were stand-ins: the guard refused nothing real.
	assert.deepEqual(/** @type {any} */ (globalThis).__bgwNoDesktop.refused, []);
	// The extension asked no window for the focus, in any test.
	const source = fs.readFileSync(new URL("../../extension/background/window.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	assert.equal(/focused:\s*true/.test(source), false, "window.js never passes focused: true");
	assert.equal(/windows\.update\(/.test(source), false, "and never updates a window at all");
});
