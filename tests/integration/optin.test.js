// Login opt-in end to end: the real daemon, the real extension in headless
// Firefox, local fixture pages. "The operator's login" is a cookie in the
// browser's default cookie store; a fixture site shows it back, and shows a
// private page to whoever carries it.
//
// The rules are set through the extension's test hook, which writes them the
// way the options page does, and - in the tests about the options page -
// through that page itself. Every rule has a host of its own (any name under
// .localhost leads to the fixture server), so that one test's use of a rule
// does not count against another's rate limit.
//
// Run with: npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LOGIN_TEST_LIMITS, startHarness, waitFor } from "./harness.js";
import { scriptedDaemon } from "../helpers/ext-fakes.js";
import { b64urlDecode, b64urlEncode, randomBytes } from "../../extension/shared/auth.js";
import { MSG, PROTOCOL_VERSION, makeMessage } from "../../extension/shared/protocol.js";

const CLI = fileURLToPath(new URL("../../cli/bgw", import.meta.url));

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;
let seq = 0;

before(async () => {
	h = await startHarness({
		tuning: { loginGapMs: LOGIN_TEST_LIMITS.minGapMs, loginPerHour: LOGIN_TEST_LIMITS.perHour },
		daemon: { loginPacing: { ...LOGIN_TEST_LIMITS, marginMs: 150 } },
	});
});

after(async () => {
	if (h !== undefined) await h.stop();
});

/**
 * A fixture URL that no earlier job used, so nothing is deduplicated or cached.
 * @param {string} host
 * @param {string} route
 */
function fx(host, route) {
	seq += 1;
	return h.fixtures.url(host, `${route}${route.includes("?") ? "&" : "?"}n=${seq}`);
}

/**
 * Submit a raw job through the daemon and return its result.
 * @param {string} url
 * @param {{ wait?: Record<string, unknown>, extract?: Record<string, unknown>, session?: string }} [opts]
 * @returns {Promise<any>}
 */
async function job(url, opts = {}) {
	const res = await h.submitJob({
		kind: "fetch",
		url,
		...(opts.session === undefined ? {} : { session: opts.session }),
		wait: { timeout_ms: 15000, settle_ms: 200, dwell_ms: 0, ...opts.wait },
		extract: { html: true, ...opts.extract },
	});
	assert.equal(res.status, 200, res.text.slice(0, 300));
	return res.json.result;
}

/**
 * Call one of the agent routes with the agent token.
 * @param {"/v1/fetch" | "/v1/pages/read" | "/v1/pages/search"} route
 * @param {Record<string, unknown>} args
 * @returns {Promise<{ isError: boolean, text: string, outcome: string, page: string | null }>}
 */
async function tool(route, args) {
	const res = await h.daemon.tool(route, args);
	assert.equal(res.status, 200, res.text.slice(0, 300));
	return res.json;
}

/**
 * @param {string} host a name under .localhost
 * @param {string} [pathPrefix]
 * @param {boolean} [subdomains]
 */
const rule = (host, pathPrefix = "/in", subdomains = false) => ({ host: `${host}.localhost`, pathPrefix, subdomains });

/**
 * Set the operator's rules, the way the options page stores them.
 * @param {{ host: string, pathPrefix: string, subdomains: boolean }[]} rules
 */
async function setRules(rules) {
	const set = await h.hook("optin.set", { rules });
	assert.deepEqual(set, { rules, rejected: 0 });
	// The daemon hears of it: the hosts, each once.
	const hosts = [...new Set(rules.map((r) => r.host))];
	await waitFor(async () => JSON.stringify((await h.status()).extension.state.optin_hosts) === JSON.stringify(hosts), { timeoutMs: 5000, what: "the daemon to hear of the rules" });
}

/**
 * Log the operator in to a fixture site: a cookie in the browser's default store.
 * @param {string} host a name under .localhost
 * @param {string} [who]
 */
async function logIn(host, who = "alice") {
	assert.equal(await h.hook("cookies.set", { url: h.fixtures.url(host, "/"), name: "bgwlogin", value: who }), true);
}

/** @returns {Promise<{ own: { windowId: number | null, parkTabId: number | null, jobTabs: number[] }, containerId: string | null, windows: any[] }>} */
const windows = () => h.hook("windows");

/** @param {string} marker a value of the "n" or "via" parameter @returns {import("../fixtures/server.js").Seen[]} */
const seenWith = (marker) => h.fixtures.seen((s) => s.query.via === marker);

/** Every rule of the run, so that a test can add its own without taking the others away. */
/** @type {{ host: string, pathPrefix: string, subdomains: boolean }[]} */
const RULES = [];

/** @param {{ host: string, pathPrefix: string, subdomains: boolean }} r */
async function addRule(r) {
	RULES.push(r);
	await setRules(RULES);
	return r;
}

test("without a rule every job runs in the container: the operator's cookie is not sent", async () => {
	await logIn("m0");
	const status = await h.status();
	assert.deepEqual(status.extension.state.optin_hosts, []);
	assert.equal((await h.daemon.agentStatus()).optin_rules, 0);
	const r = await job(fx("m0", "/in/cookie/echo?via=norule"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.cookie_scope, "container");
	assert.deepEqual(seenWith("norule")[0].cookies, {});
});

test("a URL inside a rule is loaded with the operator's login; another path, another host and a subdomain are not", async () => {
	await logIn("m1");
	await logIn("m1b");
	await logIn("sub.m1.localhost");
	await addRule(rule("m1"));

	const inside = await job(fx("m1", "/in/cookie/echo?via=inside"));
	assert.equal(inside.outcome, "ok", JSON.stringify(inside.error));
	assert.equal(inside.cookie_scope, "default");
	assert.deepEqual(seenWith("inside")[0].cookies, { bgwlogin: "alice" });
	assert.match(inside.content.html, /bgwlogin/);

	// The same site, outside the path of the rule.
	const otherPath = await job(fx("m1", "/cookie/echo?via=otherpath"));
	assert.equal(otherPath.outcome, "ok");
	assert.equal(otherPath.cookie_scope, "container");
	assert.deepEqual(seenWith("otherpath")[0].cookies, {});
	// A path that merely begins with the same letters.
	const lookalike = await job(fx("m1", "/inside?via=lookalike"));
	assert.equal(lookalike.cookie_scope, "container");
	assert.deepEqual(seenWith("lookalike")[0].cookies, {});

	// Another host, with the same path.
	const otherHost = await job(fx("m1b", "/in/cookie/echo?via=otherhost"));
	assert.equal(otherHost.cookie_scope, "container");
	assert.deepEqual(seenWith("otherhost")[0].cookies, {});

	// A subdomain of the rule's host: the rule does not say "and its subdomains".
	const sub = await job(fx("sub.m1.localhost", "/in/cookie/echo?via=subdomain"));
	assert.equal(sub.cookie_scope, "container");
	assert.deepEqual(seenWith("subdomain")[0].cookies, {});

	// What the daemon is told, and what it tells an agent: hosts for the operator, a count for the agent.
	assert.deepEqual((await h.status()).extension.state.optin_hosts, ["m1.localhost"]);
	const agent = await h.daemon.agentStatus();
	assert.equal(agent.optin_rules, 1);
	assert.equal(JSON.stringify(agent).includes("m1.localhost"), false, "an agent is not told which sites");
});

test("a rule that says so covers the subdomains of its host as well", async () => {
	await logIn("deep.s1.localhost", "bob");
	await addRule(rule("s1", "/in", true));
	const r = await job(fx("deep.s1.localhost", "/in/cookie/echo?via=wide"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.cookie_scope, "default");
	assert.deepEqual(seenWith("wide")[0].cookies, { bgwlogin: "bob" });
	// Still held to the path.
	const out = await job(fx("deep.s1.localhost", "/cookie/echo?via=wideout"));
	assert.equal(out.cookie_scope, "container");
	assert.deepEqual(seenWith("wideout")[0].cookies, {});
});

test('session "isolated" forces the container, whatever the rules say', async () => {
	await logIn("i1");
	await addRule(rule("i1"));
	const r = await job(fx("i1", "/in/cookie/echo?via=isolated"), { session: "isolated" });
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.cookie_scope, "container");
	assert.deepEqual(seenWith("isolated")[0].cookies, {});
	// And there is no word for the opposite.
	for (const session of ["default", "login", "operator", "auto "]) {
		const res = await h.submitJob({ kind: "fetch", url: fx("i1", "/in/cookie/echo?via=asked"), session });
		assert.equal(res.status, 400, session);
	}
	assert.deepEqual(seenWith("asked"), []);
});

// ---------------------------------------------------------------- the scope guard

/**
 * A job whose page tried to leave its rule: stopped, with the origin of where it wanted to go and nothing else.
 * @param {any} r
 * @param {string} origin
 */
function assertLeftScope(r, origin) {
	assert.equal(r.outcome, "policy_blocked", JSON.stringify(r.error));
	assert.equal(r.error.code, "redirect_out_of_scope");
	assert.equal(r.error.retryable, false);
	assert.equal(r.error.message, `the page tried to leave the part of the site the operator opted in, for ${origin}`);
	assert.equal(r.cookie_scope, "default");
	assert.equal(r.content, null);
	assert.equal(r.page, null);
	assert.equal(r.nav.final_url, null);
}

test("a redirect out of the rule is cancelled before it is sent: by HTTP, by script, by meta refresh - to another path and to another site", async () => {
	await logIn("g1");
	await logIn("g1x");
	await addRule(rule("g1"));
	const own = `http://g1.localhost:${h.fixtures.port}`;
	const other = `http://g1x.localhost:${h.fixtures.port}`;
	/** @type {[string, string, string][]} how the page leaves, where to, the origin that is reported */
	const ways = [
		["/in/redirect", `${own}/hit`, own],
		["/in/redirect", `${other}/in/cookie/echo`, other],
		["/in/js-redirect", `${own}/cookie/echo`, own],
		["/in/js-redirect", `${other}/in/hit`, other],
		["/in/meta-refresh", `${own}/hit`, own],
		["/in/meta-refresh", `${other}/hit`, other],
	];
	for (const [i, [route, to, origin]] of ways.entries()) {
		const via = `leave${i}`;
		const target = `${to}?via=${via}&secret=bgw-must-not-show`;
		const r = await job(fx("g1", `${route}?to=${encodeURIComponent(target)}`));
		assertLeftScope(r, origin);
		// The address the caller asked for is the caller's own; of the one the page wanted, the origin only.
		assert.equal(JSON.stringify({ ...r, nav: { ...r.nav, requested_url: "" } }).includes("bgw-must-not-show"), false, "nothing of the target address but its origin");
		assert.equal(JSON.stringify({ ...r, nav: { ...r.nav, requested_url: "" } }).includes(via), false);
		// The target never heard of it: no request, with or without the operator's cookie.
		assert.deepEqual(seenWith(via), [], `${route} -> ${to}`);
	}
	// A chain: the first hop stays inside, the second leaves.
	const chained = `${own}/in/redirect?to=${encodeURIComponent(`${own}/hit?via=leavechain`)}`;
	assertLeftScope(await job(fx("g1", `/in/redirect?to=${encodeURIComponent(chained)}`)), own);
	assert.deepEqual(seenWith("leavechain"), []);
	// Control: a redirect that stays inside the rule is followed, with the login.
	const r = await job(fx("g1", `/in/redirect?to=${encodeURIComponent(`${own}/in/cookie/echo?via=stays`)}`));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.cookie_scope, "default");
	assert.deepEqual(seenWith("stays")[0].cookies, { bgwlogin: "alice" });
});

test("an address changed without a request - pushState, replaceState, a document the page made up - ends the job; nothing is returned", async () => {
	await logIn("g2");
	await addRule(rule("g2"));
	const own = `http://g2.localhost:${h.fixtures.port}`;
	for (const how of ["push", "replace"]) {
		const r = await job(fx("g2", `/in/push?how=${how}&to=${encodeURIComponent(`/elsewhere?via=history${how}`)}`), { wait: { settle_ms: 600 } });
		assertLeftScope(r, own);
		assert.deepEqual(seenWith(`history${how}`), [], "nothing was loaded: there was nothing to cancel, and nothing is read either");
	}
	// Inside the rule the address may change as it likes.
	const stays = await job(fx("g2", `/in/push?to=${encodeURIComponent("/in/next/page")}`), { wait: { settle_ms: 600 } });
	assert.equal(stays.outcome, "ok", JSON.stringify(stays.error));
	assert.equal(stays.nav.final_url, `${own}/in/next/page`);
	// A document made up by the page has no address inside any rule.
	const made = await job(fx("g2", "/in/blob-nav"), { wait: { settle_ms: 600 } });
	assert.equal(made.outcome, "policy_blocked", JSON.stringify(made.error));
	assert.equal(made.error.code, "redirect_out_of_scope");
	assert.equal(made.content, null);
	assert.equal(JSON.stringify(made).includes("bgw-fixture-made-up"), false);
});

test("what such a page loads by itself may come from anywhere public, never from a private address - whatever way the page tries", async () => {
	await logIn("q1");
	await addRule(rule("q1"));
	const enc = encodeURIComponent;
	// The control: aimed at another fixture host, the page's requests are made (frames, images, fetch, a worker ...).
	const pub = await job(fx("q1", `/in/sink?base=${enc(h.fixtures.url("q1x", "/").slice(0, -1))}&tag=loginpub&shared=0`), { wait: { settle_ms: 2500 } });
	assert.equal(pub.outcome, "ok", JSON.stringify(pub.error));
	assert.equal(pub.cookie_scope, "default");
	const made = new Set(h.fixtures.seen((s) => /^loginpub-/.test(s.query.via ?? "")).map((s) => s.query.via));
	for (const way of ["img", "fetch", "xhr", "frame", "script", "css", "workerfetch", "beacon"]) assert.ok(made.has(`loginpub-${way}`), `the control: ${way} was requested`);
	// The same page aimed at a loopback port outside the policy: nothing arrives there.
	const priv = await job(fx("q1", `/in/sink?base=${enc(h.fixtures.forbiddenUrl("/").slice(0, -1))}&tag=loginpriv&shared=0`), { wait: { settle_ms: 2500 } });
	assert.equal(priv.outcome, "ok", JSON.stringify(priv.error));
	assert.equal(priv.cookie_scope, "default");
	assert.match(priv.content.markdown, /bgw-fixture-sink-marker/);
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.deepEqual(h.fixtures.seen((s) => s.listener === "forbidden").map((s) => s.query.via), [], "nothing arrived at the private port");
	assert.deepEqual(h.fixtures.seen((s) => /^loginpriv-/.test(s.query.via ?? "") && s.path !== "/redirect").map((s) => s.query.via), []);
});

// ---------------------------------------------------------------- pop-ups

test("a window or tab that such a page opens is sealed, loads nothing in the operator's store and is closed", async () => {
	await logIn("p1");
	await logIn("p1x");
	await addRule(rule("p1"));
	const own = `http://p1.localhost:${h.fixtures.port}`;
	const other = `http://p1x.localhost:${h.fixtures.port}`;
	const size = encodeURIComponent("width=300,height=200");
	/** @type {[string, string][]} */
	const kinds = [
		["tab", `to=${encodeURIComponent(`${own}/hit?via=pop-tab`)}`],
		["tabin", `to=${encodeURIComponent(`${own}/in/hit?via=pop-tabin`)}`],
		["win", `features=${size}&to=${encodeURIComponent(`${own}/hit?via=pop-win`)}`],
		["winother", `features=${size}&to=${encodeURIComponent(`${other}/in/hit?via=pop-winother`)}`],
		["noopener", `features=${encodeURIComponent("noopener,width=300,height=200")}&to=${encodeURIComponent(`${own}/hit?via=pop-noopener`)}`],
		["write", `write=${encodeURIComponent(`${own}/pixel?via=pop-write`)}`],
		["writewin", `features=${size}&write=${encodeURIComponent(`${own}/pixel?via=pop-writewin`)}`],
	];
	const before = (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === "guard.login_popup_sealed").length;
	for (const [name, query] of kinds) {
		const r = await job(fx("p1", `/in/opener?${query}`), { wait: { settle_ms: 700 } });
		// The page itself is read as usual: opening a window is not leaving the rule.
		assert.equal(r.outcome, "ok", `${name}: ${JSON.stringify(r.error)}`);
		assert.equal(r.cookie_scope, "default");
		assert.match(r.content.markdown, /bgw-fixture-opener-marker/);
	}
	await new Promise((resolve) => setTimeout(resolve, 2500));
	// Not one of them was ever asked for - not even inside the rule: only the job tab runs with the login.
	assert.deepEqual(h.fixtures.seen((s) => (s.query.via ?? "").startsWith("pop-")).map((s) => s.query.via), []);
	const sealed = (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === "guard.login_popup_sealed").length - before;
	assert.equal(sealed, kinds.length, "every one of them was recognised by the tab that opened it");
	// And they are gone, with their windows.
	await waitFor(async () => (await windows()).windows.every((w) => w.gateway || w.tabs.every((/** @type {any} */ t) => !/pop-/.test(t.url ?? ""))), { timeoutMs: 5000, what: "the pop-ups to be closed" });
	const snap = await windows();
	const gw = snap.windows.find((w) => w.gateway);
	assert.equal(gw.tabs.length, 1, "the gateway window holds its park tab only");
});

// ---------------------------------------------------------------- the operator's own tabs

test("the operator's own tabs on the same site are not touched: their address, their cookies, their requests, their windows", async () => {
	await logIn("o1", "carol");
	await addRule(rule("o1"));
	const own = `http://o1.localhost:${h.fixtures.port}`;
	// The operator has the site open themselves: a page inside the rule and one outside of it.
	const op = await h.hook("window.open", { url: `${own}/in/plain?via=op-inside` });
	const second = await h.hook("tab.open", { windowId: op.id, url: `${own}/plain?via=op-outside` });
	try {
		await waitFor(() => seenWith("op-inside").length === 1 && seenWith("op-outside").length === 1, { timeoutMs: 10000, what: "the operator's pages to load" });
		assert.deepEqual(seenWith("op-inside")[0].cookies, { bgwlogin: "carol" });
		const stats0 = await h.hook("guard.stats");

		// Jobs under the rule: one that behaves, three that try to leave, one that opens a window.
		assert.equal((await job(fx("o1", "/in/cookie/echo?via=o1-job"))).outcome, "ok");
		for (const route of ["/in/redirect", "/in/js-redirect", "/in/meta-refresh"]) {
			const r = await job(fx("o1", `${route}?to=${encodeURIComponent(`${own}/hit?via=o1-leave`)}`));
			assert.equal(r.error?.code, "redirect_out_of_scope", route);
		}
		// While a job runs with the login, the operator goes where they like in a tab of their own:
		// out of the rule, and to another site. Nothing of that is the gateway's business.
		const slow = job(fx("o1", "/in/slow?ms=2500"), { wait: { settle_ms: 200 } });
		await new Promise((resolve) => setTimeout(resolve, 800));
		const third = await h.hook("tab.open", { windowId: op.id, url: `${own}/hit?via=op-during` });
		const fourth = await h.hook("tab.open", { windowId: op.id, url: `http://o1x.localhost:${h.fixtures.port}/hit?via=op-elsewhere` });
		await waitFor(() => seenWith("op-during").length === 1 && seenWith("op-elsewhere").length === 1, { timeoutMs: 10000, what: "the operator's navigations during the job" });
		assert.deepEqual(seenWith("op-during")[0].cookies, { bgwlogin: "carol" });
		assert.equal((await slow).outcome, "ok");
		assert.deepEqual(seenWith("o1-leave"), []);

		// Their tabs: all four still there, each where the operator put it.
		const snap = await windows();
		const theirs = snap.windows.find((w) => w.id === op.id);
		assert.ok(theirs, "the operator's window is open");
		assert.equal(theirs.gateway, false);
		assert.deepEqual(
			theirs.tabs.map((/** @type {any} */ t) => [t.id, t.url.replace(/^http:\/\/[^/]+/, ""), t.cookieStoreId, t.role]),
			[
				[op.tabs[0], "/in/plain?via=op-inside", "firefox-default", null],
				[second.id, "/plain?via=op-outside", "firefox-default", null],
				[third.id, "/hit?via=op-during", "firefox-default", null],
				[fourth.id, "/hit?via=op-elsewhere", "firefox-default", null],
			],
		);
		// Their cookie: as it was.
		assert.deepEqual(await h.hook("cookies.get", { url: `${own}/` }), [{ name: "bgwlogin", value: "carol" }]);
		// Their requests: heard for a moment by the one listener that looks for windows a job page opens,
		// never held, never cancelled, and by no other listener of the guard at all.
		const stats = await h.hook("guard.stats");
		assert.equal(stats.held, stats0.held, "no request of the operator's was held");
		assert.equal(stats.heldCancelled, stats0.heldCancelled);
		assert.equal(stats.wide, false);
		assert.equal(stats.dropped, stats0.dropped);
	} finally {
		await h.hook("window.close", { windowId: op.id }).catch(() => {});
	}
});

test("what a page sets while it is read with the login lands in the operator's store: the site sees the visit as theirs", async () => {
	await logIn("o2");
	await addRule(rule("o2"));
	const r = await job(fx("o2", "/in/cookie/set?name=bgw_from_job&value=j1"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.cookie_scope, "default");
	const cookies = await h.hook("cookies.get", { url: h.fixtures.url("o2", "/") });
	assert.deepEqual(cookies.sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name)), [{ name: "bgw_from_job", value: "j1" }, { name: "bgwlogin", value: "alice" }]);
	// The container never hears of it.
	const snap = await windows();
	assert.deepEqual(await h.hook("cookies.get", { url: h.fixtures.url("o2", "/"), storeId: snap.containerId }), []);
});

// ---------------------------------------------------------------- what such a job is, and is not, allowed

test("no walk down the page with the operator's login; in the container the same page is walked", async () => {
	await logIn("w1");
	await addRule(rule("w1"));
	const wait = { settle_ms: 300, scroll: "lazy" };
	const loggedIn = await job(fx("w1", "/in/smoke/reveal.html"), { wait });
	assert.equal(loggedIn.outcome, "ok", JSON.stringify(loggedIn.error));
	assert.equal(loggedIn.cookie_scope, "default");
	assert.equal(loggedIn.render.scrolled_px, 0, "the page was loaded and read, nothing more");
	assert.equal(loggedIn.content.markdown.includes("REVEAL-LAZY"), false, "what only scrolling loads is not there");
	const contained = await job(fx("w1", "/smoke/reveal.html"), { wait });
	assert.equal(contained.cookie_scope, "container");
	assert.ok(contained.render.scrolled_px > 0, `scrolled ${contained.render.scrolled_px}`);
});

test("while a page is read with the login the toolbar says so, and the popup names the site", async () => {
	await logIn("b1");
	await addRule(rule("b1"));
	const opened = await h.hook("ui.open", { page: "popup" });
	try {
		const running = job(fx("b1", "/in/slow?ms=2500"));
		await waitFor(async () => (await h.hook("badge")).text === "ID", { timeoutMs: 8000, intervalMs: 50, what: "the badge of a job with the login" });
		assert.equal((await h.hook("badge")).title, "Browser Gateway: using your login on b1.localhost");
		await waitFor(async () => (await h.hook("ui.read", { page: "popup", ids: ["job"] })).job === "using your login on b1.localhost", { timeoutMs: 5000, what: "the popup to name the site" });
		const st = await h.hook("status");
		assert.deepEqual({ host: st.job.host, scope: st.job.scope }, { host: "b1.localhost", scope: "default" });
		assert.equal((await running).outcome, "ok");
		await waitFor(async () => (await h.hook("badge")).text === "", { timeoutMs: 5000, what: "the badge to clear" });
		await waitFor(async () => (await h.hook("ui.read", { page: "popup", ids: ["job"] })).job === "-", { timeoutMs: 5000, what: "the popup to show that nothing runs" });
		// A job in the container shows no such badge.
		const plain = job(fx("b1", "/slow?ms=1500"));
		await waitFor(async () => (await h.hook("status")).job?.scope === "container", { timeoutMs: 8000, intervalMs: 50, what: "the container job to run" });
		assert.equal((await h.hook("badge")).text, "");
		await waitFor(async () => (await h.hook("ui.read", { page: "popup", ids: ["job"] })).job === "b1.localhost", { timeoutMs: 5000, what: "the popup to name the host of a container job, and no more" });
		assert.equal((await plain).outcome, "ok");
	} finally {
		await h.hook("window.close", { windowId: opened.windowId });
	}
});

test("the operator is logged out: a login page inside the rule, or a redirect to one outside of it, is reported as login_wall with what to do", async () => {
	await addRule(rule("l1"));
	// No cookie: the site sends the visitor to its login page, inside the rule.
	const inside = await job(fx("l1", "/in/private?id=wall1"));
	assert.equal(inside.outcome, "blocked", JSON.stringify(inside.error));
	assert.equal(inside.error.code, "login_wall");
	assert.equal(inside.cookie_scope, "default");
	assert.match(inside.error.message, /the operator is logged out of this site and has to log in to it in their browser/);
	assert.equal(inside.content, null);
	// The login page is outside the rule: not loaded at all, and still called what it is.
	const outside = await job(fx("l1", "/in/members?via=wall2"));
	assert.equal(outside.outcome, "blocked", JSON.stringify(outside.error));
	assert.equal(outside.error.code, "login_wall");
	assert.deepEqual(outside.detect, { kind: "login_wall", evidence: "redirect to a login path", waited_ms: 0, resolved: null });
	assert.deepEqual(h.fixtures.seen((s) => s.path === "/login" && s.host.startsWith("l1.")), [], "the login page outside the rule was never asked for");
	// What an agent is told.
	const told = await tool("/v1/fetch", { url: fx("l1", "/in/private?id=wall3") });
	assert.equal(told.isError, true);
	assert.equal(told.outcome, "blocked");
	assert.match(told.text, /^\[browser-gateway\] outcome=blocked job=j_[0-9A-Za-z_-]+ scope=default status=200$/m);
	assert.match(told.text, /^code: login_wall$/m);
	assert.match(told.text, /so the operator is logged out of that site\. Tell the user to log in to it in their browser, then fetch again\./);
});

// ---------------------------------------------------------------- not stored

/** @param {string} dir @returns {string[]} every file below it */
function filesBelow(dir) {
	return fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => path.join(e.parentPath, e.name));
}

test("a page read with the login is handed over once and kept nowhere: not in the store, the index, the audit log or any log", async () => {
	await logIn("n1", "dora");
	await addRule(rule("n1"));
	const before = (await h.daemon.agentStatus()).store;
	const url = fx("n1", "/in/private?id=nostore1&q=bgwQUERYSECRET");
	const r = await tool("/v1/fetch", { url, max_chars: 60000 });
	assert.equal(r.isError, false, r.text);
	const lines = r.text.split("\n");
	// The header: scope=default, said in words as well, and that nothing is kept.
	assert.match(lines[0], /^\[browser-gateway\] outcome=ok page=pg_[0-9A-HJKMNP-TV-Z]{26} scope=default status=200 visibility=(visible|hidden)$/);
	assert.ok(lines.includes("login: this page was read with the operator's own login on that site (scope=default). It is not stored."), r.text.slice(0, 900));
	assert.ok(lines.includes("stored: no - this content is not kept; page_read and page_search cannot return it"));
	assert.equal(lines.some((l) => l.includes("next: page_read")), false, "no continuation is offered");
	// The whole page is in this one answer: its first line and its last.
	assert.match(r.text, /bgw-fixture-private-nostore1 for dora/);
	assert.match(r.text, /bgw-fixture-private-tail-nostore1/);
	assert.match(r.text, /^title: Private inbox of dora SECRETTITLEnostore1$/m);
	const chars = /^chars: 0-(\d+) of (\d+)$/m.exec(r.text);
	assert.ok(chars !== null && chars[1] === chars[2], "from the first character to the last");

	// Afterwards it cannot be had again: not by its id, not by a search, not from a cache.
	assert.ok(r.page);
	const read = await tool("/v1/pages/read", { page: r.page });
	assert.equal(read.isError, true);
	assert.match(read.text, /^\[browser-gateway\] outcome=error code=not_stored$/m);
	assert.equal(read.text.includes("nostore1"), false);
	for (const query of ["bgw-fixture-private-nostore1", "SECRETTITLEnostore1", "dora", "Inbox"]) {
		const found = await tool("/v1/pages/search", { query });
		assert.equal(found.isError, false);
		assert.match(found.text, /hits=0/, query);
	}
	const after = (await h.daemon.agentStatus()).store;
	assert.deepEqual(after, { ...before, pages: before.pages + 1, stored: before.stored }, "a record that it happened, no content");

	// On disk: the record holds the host, the time, the length and a hash. Nothing the page said, nothing of its address.
	const dataDir = h.daemon.dataDir;
	const record = JSON.parse(fs.readFileSync(path.join(dataDir, "pages", r.page.slice(-2), r.page, "meta.json"), "utf8"));
	assert.deepEqual(Object.keys(record).sort(), ["content_chars", "content_sha256", "fetched_at", "host", "id", "outcome", "stored", "v"]);
	assert.equal(record.host, "n1.localhost");
	assert.equal(record.stored, false);
	assert.deepEqual(fs.readdirSync(path.join(dataDir, "pages", r.page.slice(-2), r.page)), ["meta.json"]);
	for (const file of [...filesBelow(dataDir), ...filesBelow(h.daemon.configDir)]) {
		const bytes = fs.readFileSync(file).toString("latin1");
		for (const secret of ["nostore1", "SECRETTITLE", "bgwQUERYSECRET", "dora", "/in/private", "Inbox of"]) assert.equal(bytes.includes(secret), false, `${secret} in ${path.relative(dataDir, file)}`);
	}
	// The audit log: that a page of this host was loaded with the login, and how it ended.
	const entry = h.daemon.auditEntries().filter((e) => e.host === "n1.localhost" && e.kind === "fetch").at(-1);
	assert.deepEqual({ kind: entry.kind, url: entry.url, host: entry.host, outcome: entry.outcome, cookie_scope: entry.cookie_scope, redirect_origins: entry.redirect_origins }, { kind: "fetch", url: null, host: "n1.localhost", outcome: "ok", cookie_scope: "default", redirect_origins: [] });
	// The daemon's log and the extension's console: the host at most.
	for (const text of [h.daemon.logs.join("\n"), h.browserLog()]) {
		for (const secret of ["nostore1", "SECRETTITLE", "bgwQUERYSECRET", "dora", "/in/private"]) assert.equal(text.includes(secret), false, secret);
	}
	assert.match(h.browserLog(), /job\.login_scope/);

	// A second fetch goes to the browser again (there is nothing to serve it from), and waits for the rule's gap.
	const again = await tool("/v1/fetch", { url });
	assert.equal(again.isError, false, again.text);
	assert.match(again.text, /cache=miss/);
	assert.equal(h.fixtures.seen((s) => s.query.id === "nostore1").length, 2);
	// A page that is longer than what was asked for says how to get the rest - by fetching again, never by page_read.
	const short = await tool("/v1/fetch", { url: fx("n1", "/in/private?id=nostore2"), max_chars: 500 });
	assert.match(short.text, /^note: more content remains\. Call browser_fetch again with a larger max_chars \(up to 60000\) to see it\.$/m);
	assert.equal(/next: page_read/.test(short.text), false);
});

test("with the login the page source is returned only when the job asks for it, once, and is kept nowhere", async () => {
	await logIn("n3", "zorbax9");
	await addRule(rule("n3"));
	// Not asked for: not taken (in the gateway's own container it is always taken).
	const quiet = await job(fx("n3", "/in/private?id=rawquiet"));
	assert.equal(quiet.outcome, "ok", JSON.stringify(quiet.error));
	assert.equal(quiet.cookie_scope, "default");
	assert.equal(quiet.content.raw_html, null);
	assert.equal(quiet.truncated.raw_html, false);
	// Asked for: the source of the page the operator's login got.
	const asked = await job(fx("n3", "/in/private?id=rawasked"), { extract: { raw_html: true } });
	assert.equal(asked.outcome, "ok", JSON.stringify(asked.error));
	assert.equal(asked.cookie_scope, "default");
	assert.ok(asked.content.raw_html.startsWith("<!DOCTYPE html>\n<html"), asked.content.raw_html.slice(0, 60));
	assert.ok(asked.content.raw_html.includes("bgw-fixture-private-rawasked for zorbax9"));
	assert.equal(asked.truncated.raw_html, false);

	// Through the agent route: shown once, in full, and nowhere afterwards.
	const url = fx("n3", "/in/private?id=rawfetch&q=RAWQUERYSECRET");
	const before = (await h.daemon.agentStatus()).store;
	const r = await tool("/v1/fetch", { url, format: "raw_html", max_chars: 60000 });
	assert.equal(r.isError, false, r.text);
	const lines = r.text.split("\n");
	assert.match(lines[0], /^\[browser-gateway\] outcome=ok page=pg_[0-9A-HJKMNP-TV-Z]{26} scope=default status=200 visibility=(visible|hidden)$/);
	assert.ok(lines.includes("stored: no - this content is not kept; page_read and page_search cannot return it"));
	assert.ok(lines.includes("extraction: none - the page source as the browser held it"));
	assert.match(r.text, /<!DOCTYPE html>/);
	assert.match(r.text, /bgw-fixture-private-rawfetch for zorbax9/);
	assert.ok(r.page);
	const page = String(r.page);
	assert.equal((await tool("/v1/pages/read", { page, format: "raw_html" })).text.includes("code=not_stored"), true);
	const exp = await h.daemon.exportPage({ page, format: "raw_html" });
	assert.deepEqual([exp.status, exp.json.error], [404, "not_stored"]);
	assert.deepEqual((await h.daemon.agentStatus()).store, { ...before, pages: before.pages + 1, stored: before.stored });
	const dataDir = h.daemon.dataDir;
	assert.deepEqual(fs.readdirSync(path.join(dataDir, "pages", page.slice(-2), page)), ["meta.json"]);
	for (const file of [...filesBelow(dataDir), ...filesBelow(h.daemon.configDir)]) {
		const bytes = fs.readFileSync(file);
		const latin = bytes.toString("latin1");
		for (const secret of ["rawfetch", "rawasked", "rawquiet", "zorbax9", "RAWQUERYSECRET", "Inbox of"]) assert.equal(latin.includes(secret), false, `${secret} in ${path.relative(dataDir, file)}`);
		if (file.endsWith(".gz")) assert.equal(zlib.gunzipSync(bytes).toString("latin1").includes("zorbax9"), false, path.relative(dataDir, file));
	}
	for (const text of [h.daemon.logs.join("\n"), h.browserLog()]) {
		for (const secret of ["rawfetch", "rawasked", "zorbax9", "RAWQUERYSECRET"]) assert.equal(text.includes(secret), false, secret);
	}
});

// ---------------------------------------------------------------- challenges

test("a human check on an opted-in site is parked like any other, in the operator's store, and read once it is passed", async () => {
	await logIn("c1", "erin");
	await addRule(rule("c1"));
	const url = fx("c1", "/in/challenge?mode=human&id=optin1");
	const res = h.submitJob({ kind: "fetch", url, wait: { timeout_ms: 15000, settle_ms: 200, dwell_ms: 0, human_wait_ms: 60000 }, extract: { html: true } });
	await waitFor(async () => (await h.hook("pending")).length === 1, { timeoutMs: 20000, what: "the job to be parked" });
	const [pending] = await h.hook("pending");
	assert.equal(pending.host, "c1.localhost");
	// The tab that waits is in the operator's store, and still held to its rule.
	const snap = await windows();
	const tab = snap.windows.flatMap((w) => w.tabs).find((/** @type {any} */ t) => t.role === "job");
	assert.equal(tab.cookieStoreId, "firefox-default");
	assert.equal((await h.status()).pending[0].host, "c1.localhost");
	// The check is passed; the page finds out by itself. (Nobody was given the tab: for the result it cleared by waiting.)
	await h.fixtures.clearChallenge("optin1");
	const r = (await res).json.result;
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.equal(r.cookie_scope, "default");
	assert.equal(r.detect.resolved, "cleared_by_waiting");
	assert.match(r.content.markdown, /bgw-fixture-cleared-optin1/);
	assert.deepEqual(await h.hook("pending"), []);
});

// ---------------------------------------------------------------- downloads

const pause = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @returns {Promise<any[]>} the browser's own list of downloads */
const downloadList = () => h.hook("downloads.list");
/** @param {number} since @param {string} event @returns {Promise<any[]>} what the extension logged since then under that name */
const logged = async (since, event) => (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === event && l.t >= since);

/** Take away what a test left in the download directory, the way the operator would. */
async function clearDownloads() {
	for (const d of await downloadList()) {
		await h.hook("downloads.act", { id: d.id, action: "cancel" }).catch(() => {});
		await h.hook("downloads.act", { id: d.id, action: "removeFile" }).catch(() => {});
		await h.hook("downloads.act", { id: d.id, action: "erase" }).catch(() => {});
	}
	for (const name of h.downloads()) fs.rmSync(path.join(h.downloadsDir, name), { force: true });
}

test("downloads with the login: a blob of the job's site is removed when the operator has that site nowhere open; attachments are refused by their headers", async () => {
	await logIn("d1");
	await addRule(rule("d1"));
	assert.deepEqual(h.downloads(), []);
	const began = Date.now();
	const r = await job(fx("d1", "/in/blob-download?name=bgw-login-blob"), { wait: { settle_ms: 1200 } });
	assert.equal(r.outcome, "unsupported", JSON.stringify(r.error));
	assert.equal(r.error.code, "download");
	assert.equal(r.cookie_scope, "default");
	await pause(1500);
	assert.deepEqual(h.downloads(), [], "the file is gone");
	assert.deepEqual(await downloadList(), [], "and its entry");
	// Told to be the job's by where the blob came from - the cookie store says nothing here.
	assert.equal((await logged(began, "downloads.attributed")).filter((l) => l.fields.by === "origin").length, 1);
	assert.deepEqual(await logged(began, "downloads.ambiguous"), []);
	// What a server offers as a download is refused before anything is saved, as in the container.
	const attachment = await job(fx("d1", "/in/attachment"));
	assert.equal(attachment.outcome, "unsupported");
	assert.equal(attachment.error.code, "attachment");
	assert.equal(attachment.cookie_scope, "default");
	// A download link that leads out of the rule is a navigation out of the rule: cancelled, nothing saved.
	const linkOut = await job(fx("d1", `/in/link-download?name=bgw-login-linkout&to=${encodeURIComponent("/hit?via=dl-linkout")}`), { wait: { settle_ms: 800 } });
	assert.equal(linkOut.error?.code, "redirect_out_of_scope", JSON.stringify(linkOut.error));
	assert.deepEqual(seenWith("dl-linkout"), []);
	await pause(800);
	assert.deepEqual(h.downloads(), []);
});

test("downloads with the login: where it may be the operator's, nothing is touched and the job ends - the site open in a tab of theirs, now or a moment ago", async () => {
	await logIn("d2");
	await addRule(rule("d2"));
	const own = `http://d2.localhost:${h.fixtures.port}`;
	assert.deepEqual(h.downloads(), []);
	try {
		// The operator has the site open.
		let began = Date.now();
		const op = await h.hook("window.open", { url: `${own}/plain?via=d2-op` });
		await waitFor(() => seenWith("d2-op").length === 1, { timeoutMs: 10000, what: "the operator's page" });
		let r = await job(fx("d2", "/in/blob-download?name=bgw-login-doubt"), { wait: { settle_ms: 1200 } });
		assert.equal(r.outcome, "error", JSON.stringify(r.error));
		assert.equal(r.error.code, "download_ambiguous");
		assert.equal(r.content, null);
		await pause(1500);
		assert.deepEqual(h.downloads(), ["bgw-login-doubt.bin"], "the file is where the browser put it");
		assert.equal(fs.readFileSync(path.join(h.downloadsDir, "bgw-login-doubt.bin"), "utf8"), "bgw fixture blob");
		assert.equal((await logged(began, "downloads.ambiguous")).length, 1);
		assert.deepEqual(await logged(began, "downloads.attributed"), []);
		assert.deepEqual(await logged(began, "downloads.removed"), []);
		await clearDownloads();

		// The operator had the site open while the job ran, and closed it before the page saved its file:
		// at the moment of the download no tab of theirs shows the site any more. Still theirs to keep.
		await h.hook("window.close", { windowId: op.id });
		await pause(300);
		began = Date.now();
		const running = job(fx("d2", "/in/blob-download?name=bgw-login-closed&delay=3000"), { wait: { settle_ms: 4000 } });
		await waitFor(async () => (await h.hook("status")).job?.scope === "default", { timeoutMs: 8000, intervalMs: 50, what: "the job to run" });
		const brief = await h.hook("window.open", { url: `${own}/plain?via=d2-brief` });
		await waitFor(() => seenWith("d2-brief").length === 1, { timeoutMs: 10000, what: "the operator's page" });
		await h.hook("window.close", { windowId: brief.id });
		r = await running;
		assert.equal(r.error?.code, "download_ambiguous", JSON.stringify(r.error));
		await pause(1500);
		assert.deepEqual(h.downloads(), ["bgw-login-closed.bin"]);
		assert.deepEqual(await logged(began, "downloads.removed"), []);
		await clearDownloads();
	} finally {
		await clearDownloads();
	}
});

test("downloads with the login: a data: address and a download link inside the rule leave their file - never removed, the job ends (a known limit)", async () => {
	await logIn("d3");
	await addRule(rule("d3"));
	assert.deepEqual(h.downloads(), []);
	try {
		// A page that sends itself to a data: address: that is leaving the rule, and the browser saves the file all the same.
		let began = Date.now();
		let r = await job(fx("d3", "/in/data-download"), { wait: { settle_ms: 1200 } });
		assert.notEqual(r.outcome, "ok");
		assert.ok(["redirect_out_of_scope", "download_ambiguous"].includes(r.error.code), JSON.stringify(r.error));
		assert.equal(r.content, null);
		await pause(1500);
		let list = await downloadList();
		assert.equal(list.length, 1);
		assert.equal(list[0].url.startsWith("data:"), true);
		assert.deepEqual([list[0].state, list[0].exists, list[0].cookieStoreId], ["complete", true, "firefox-default"], "left as the browser saved it");
		assert.equal((await logged(began, "downloads.ambiguous")).length, 1);
		assert.deepEqual(await logged(began, "downloads.removed"), []);
		await clearDownloads();

		// A link with a download attribute to a page inside the rule, clicked by the page itself: an ordinary
		// request with an ordinary answer, and the browser saves it.
		began = Date.now();
		r = await job(fx("d3", `/in/link-download?name=bgw-login-link&to=${encodeURIComponent("/in/hit?via=dl-linkin")}`), { wait: { settle_ms: 1200 } });
		assert.equal(r.outcome, "error", JSON.stringify(r.error));
		assert.equal(r.error.code, "download_ambiguous");
		assert.equal(r.content, null);
		await pause(1500);
		list = await downloadList();
		assert.deepEqual(list.map((d) => [d.url.replace(/^http:\/\/[^/]+/, ""), d.state, d.exists]), [["/in/hit?via=dl-linkin", "complete", true]]);
		assert.deepEqual(h.downloads(), ["bgw-login-link.html"]);
		assert.deepEqual(await logged(began, "downloads.removed"), []);
	} finally {
		await clearDownloads();
	}
	// The same two pages in the container: both files are removed, as ever.
	for (const route of ["/data-download", `/link-download?name=bgw-container-link&to=${encodeURIComponent("/hit")}`]) {
		const r = await job(fx("d3", route), { wait: { settle_ms: 1200 } });
		assert.equal(r.cookie_scope, "container");
		assert.equal(r.error?.code, "download", `${route}: ${JSON.stringify(r.error)}`);
	}
	await pause(1500);
	assert.deepEqual(h.downloads(), []);
});

// ---------------------------------------------------------------- the options page

/** @param {string[]} ids @returns {Promise<Record<string, string | null>>} what the options page shows */
const ui = (ids) => h.hook("ui.read", { page: "options", ids });
/** @param {string} id @param {string} value */
const type = (id, value) => h.hook("ui.set", { page: "options", id, value });
/** @param {string} id */
const click = (id) => h.hook("ui.click", { page: "options", id });

/**
 * Fill in the rule form of the options page and press its button.
 * @param {string} host @param {string} pathPrefix @param {boolean} subdomains
 * @returns {Promise<string>} what the page answers
 */
async function enterRule(host, pathPrefix, subdomains) {
	await type("optin-host", host);
	await type("optin-path", pathPrefix);
	await h.hook("ui.check", { page: "options", id: "optin-subdomains", checked: subdomains });
	// The page empties its answer line when the button is pressed, and fills it when it is done.
	await click("optin-add");
	await waitFor(async () => (await ui(["optin-result"]))["optin-result"] !== "", { timeoutMs: 5000, what: "the options page to answer" });
	return String((await ui(["optin-result"]))["optin-result"]);
}

test("the options page: what a rule means is said in plain words; rules are added, changed and removed there, and bad ones refused", async () => {
	await addRule(rule("ui0"));
	const start = await h.hook("optin.get");
	/** @param {number} n */
	const inForce = (n) => (n === 1 ? "1 rule is in force." : `${n} rules are in force.`);
	const opened = await h.hook("ui.open", { page: "options" });
	try {
		await waitFor(async () => /rules? (is|are) in force\.$/.test((await ui(["optin-state"]).catch(() => /** @type {Record<string, string | null>} */ ({})))["optin-state"] ?? ""), { timeoutMs: 10000, what: "the options page to show the rules" });
		assert.equal((await ui(["optin-state"]))["optin-state"], inForce(start.rules.length));
		// The warning: every point the operator must know, as text of the page.
		const text = (await ui(["optin"])).optin ?? "";
		for (const said of [
			"Pages under a rule are loaded with your own login",
			"The agent can read whatever you can see there",
			"Loading a page can have side effects",
			"marks something as read, casts a vote, unsubscribes or logs you out",
			"are not stored on this computer",
			"A page that tries to go outside its rule is stopped",
			"at most one page every 10 seconds and 30 pages an hour",
			"Rules can be changed on this page only",
		]) {
			assert.ok(text.includes(said), said);
		}

		// What is refused, each with its reason. Nothing of it reaches the list.
		/** @type {[string, string, boolean, RegExp][]} */
		const refused = [
			["", "/", false, /Enter the host name of one site/],
			["https://reddit.com", "/", false, /no https:\/\//],
			["reddit.com/r/all", "/", false, /Enter the host name of one site/],
			["reddit.com:8443", "/", false, /Enter the host name of one site/],
			["*.reddit.com", "/", false, /no wildcard/],
			["*", "/", true, /no wildcard/],
			["com", "/", true, /Enter the host name of one site/],
			["co.uk", "/", true, /stands for many sites/],
			["github.io", "/", true, /stands for many sites/],
			["uk.com", "/", true, /stands for many sites/],
			["wordpress.com", "/", false, /stands for many sites/],
			["mi.it", "/", true, /one at a time, without subdomains/],
			["s3.eu-west-1.amazonaws.com", "/", true, /one at a time, without subdomains/],
			["192.168.1.1", "/", false, /IP address/],
			["router.local", "/", false, /Local and special-use names/],
			["mail.google.com", "/", false, /blocklist/],
			["paypal.com", "/", false, /blocklist/],
			["google.com", "/", true, /would cover a site on the gateway's blocklist/],
			["reddit.com", "r/all", false, /must start with \//],
			["reddit.com", "/r/all?sort=new", false, /no \? or #/],
			["reddit.com", "/r/../settings", false, /no \.\./],
			["reddit.com", "/r/..;/settings", false, /no \.\./],
			["reddit.com", "/r//all", false, /no empty parts/],
		];
		for (const [host, pathPrefix, sub, why] of refused) assert.match(await enterRule(host, pathPrefix, sub), why, `${host} ${pathPrefix}`);
		assert.deepEqual((await h.hook("optin.get")).rules, start.rules, "nothing was added");

		// A rule is added: shown, in force, and told to the daemon as a host.
		const added = { host: "ui1.localhost", pathPrefix: "/in", subdomains: false };
		assert.equal(await enterRule("UI1.localhost.", "/in", false), "Saved: https://ui1.localhost/in");
		await waitFor(async () => (await h.hook("optin.get")).rules.length === start.rules.length + 1, { timeoutMs: 5000, what: "the background page to take the rule" });
		let now = await h.hook("optin.get");
		assert.deepEqual(now.rules.at(-1), added);
		assert.equal(now.state, "ok");
		assert.equal(now.rev, start.rev + 1);
		const at = now.rules.length - 1;
		assert.equal((await ui([`optin-rule-${at}`]))[`optin-rule-${at}`], "https://ui1.localhost/in");
		assert.equal((await ui(["optin-state"]))["optin-state"], inForce(now.rules.length));
		await waitFor(async () => (await h.status()).extension.state.optin_hosts.includes("ui1.localhost"), { timeoutMs: 5000, what: "the daemon to hear of it" });
		await logIn("ui1", "frank");
		let r = await job(fx("ui1", "/in/cookie/echo?via=ui-added"));
		assert.equal(r.cookie_scope, "default");
		assert.deepEqual(seenWith("ui-added")[0].cookies, { bgwlogin: "frank" });
		// The same rule twice: refused.
		assert.match(await enterRule("ui1.localhost", "/in", false), /on the list already/);

		// Changed: a narrower path, and its subdomains. The old rule is gone, the new one is in its place.
		await click(`optin-edit-${at}`);
		assert.deepEqual(await ui(["optin-host", "optin-path", "optin-add"]), { "optin-host": "ui1.localhost", "optin-path": "/in", "optin-add": "Save the change" });
		assert.equal(await enterRule("ui1.localhost", "/in/cookie", true), "Saved: https://ui1.localhost/in/cookie  (and every subdomain of ui1.localhost)");
		await waitFor(async () => (await h.hook("optin.get")).rules.at(-1)?.pathPrefix === "/in/cookie", { timeoutMs: 5000, what: "the change to be in force" });
		now = await h.hook("optin.get");
		assert.equal(now.rules.length, start.rules.length + 1);
		assert.deepEqual(now.rules.at(-1), { host: "ui1.localhost", pathPrefix: "/in/cookie", subdomains: true });
		r = await job(fx("ui1", "/in/plain?via=ui-narrowed"));
		assert.equal(r.cookie_scope, "container", "what the old rule covered and the new one does not");
		assert.deepEqual(seenWith("ui-narrowed")[0].cookies, {});

		// Removed: gone from the list, from the background page and from what the daemon is told.
		await click(`optin-remove-${at}`);
		await waitFor(async () => (await h.hook("optin.get")).rules.length === start.rules.length, { timeoutMs: 5000, what: "the rule to be removed" });
		assert.deepEqual((await h.hook("optin.get")).rules, start.rules);
		assert.equal((await ui([`optin-rule-${at}`]))[`optin-rule-${at}`], null);
		await waitFor(async () => !(await h.status()).extension.state.optin_hosts.includes("ui1.localhost"), { timeoutMs: 5000, what: "the daemon to hear of it" });
		r = await job(fx("ui1", "/in/cookie/echo?via=ui-removed"));
		assert.equal(r.cookie_scope, "container");
		assert.deepEqual(seenWith("ui-removed")[0].cookies, {});
	} finally {
		await h.hook("window.close", { windowId: opened.windowId });
	}
});

// ---------------------------------------------------------------- who cannot change a rule

/** @returns {Promise<{ state: string, rules: any[], rev: number, hosts: string[], stored: unknown, shadow: string | null }>} */
const optinNow = () => h.hook("optin.get");

/**
 * @param {Record<string, unknown>} body a JSON-RPC request
 * @returns {Promise<{ status: number, json: any }>}
 */
async function rpc(body) {
	const res = await h.daemon.request("POST", "/mcp", { body, headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" } });
	return { status: res.status, json: res.json };
}

/**
 * Run cli/bgw against the harness daemon.
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
		execFile(process.env.PYTHON || "python3", [CLI, ...args], { env, timeout: 90000, maxBuffer: 16 * 1048576 }, (err, stdout, stderr) => {
			resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr });
		});
	});
}

test("no agent-facing way changes a rule or asks for the login: not the HTTP API, not an MCP tool, not the command line", async () => {
	await logIn("x1", "grace");
	const before = await optinNow();
	const target = () => fx("x1", "/in/cookie/echo?via=x1-asked");

	// The HTTP API, with either token: no route, and no field of a route that exists.
	for (const route of ["/v1/optin", "/v1/rules", "/v1/optin/rules", "/v1/policy", "/v1/settings", "/v1/login"]) {
		for (const auth of /** @type {const} */ ([true, "admin"])) {
			const res = await h.daemon.request("POST", route, { auth, body: { rules: [rule("x1")] } });
			assert.equal(res.status, 404, `${route} ${auth}`);
		}
	}
	for (const extra of [{ session: "default" }, { session: "login" }, { rule: { host: "x1.localhost", path_prefix: "/", subdomains: true } }, { optin: true }, { cookie_scope: "default" }, { login: true }, { rules: [rule("x1")] }]) {
		const fetched = await tool("/v1/fetch", { url: target(), ...extra });
		assert.equal(fetched.isError, true, JSON.stringify(extra));
		assert.match(fetched.text, /^\[browser-gateway\] outcome=error code=invalid_argument$/m, JSON.stringify(extra));
		const raw = await h.submitJob({ kind: "fetch", url: target(), ...extra });
		assert.equal(raw.status, 400, JSON.stringify(extra));
	}

	// MCP: the tools there are, and what the one that fetches takes.
	const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
	const tools = list.json.result.tools;
	for (const t of tools) {
		assert.equal(/optin|opt_in|rule|login|cookie|setting|config/i.test(t.name), false, t.name);
		for (const name of Object.keys(t.inputSchema.properties)) assert.equal(/optin|rule|login|cookie|scope/i.test(name), false, `${t.name}.${name}`);
	}
	const fetchTool = tools.find((/** @type {any} */ t) => t.name === "browser_fetch");
	assert.deepEqual(fetchTool.inputSchema.properties.session.enum, ["auto", "isolated"]);
	assert.equal(fetchTool.inputSchema.additionalProperties, false);
	for (const args of [{ url: target(), session: "default" }, { url: target(), rule: rule("x1") }, { url: target(), optin: true }]) {
		const called = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_fetch", arguments: args } });
		assert.equal(called.json.result.isError, true, JSON.stringify(args));
		assert.match(called.json.result.content[0].text, /invalid_argument/);
	}
	for (const name of ["optin_set", "browser_optin", "gateway_optin", "gateway_configure", "set_rule"]) {
		const called = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: { rules: [rule("x1")] } } });
		assert.ok(called.json.error !== undefined || called.json.result?.isError === true, name);
	}
	// gateway_status tells an agent how many rules there are, and takes no argument.
	const status = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "gateway_status", arguments: {} } });
	assert.match(status.json.result.content[0].text, new RegExp(`^optin_rules: ${before.hosts.length}$`, "m"));
	for (const host of before.hosts) assert.equal(status.json.result.content[0].text.includes(host), false);
	assert.equal((await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "gateway_status", arguments: { optin_rules: 5 } } })).json.result.isError, true);

	// The command line: no such command, no such option, no such value.
	for (const args of [["optin"], ["optin", "add", "x1.localhost"], ["rules"], ["login", "x1.localhost"], ["fetch", target(), "--session", "default"], ["fetch", target(), "--login"], ["fetch", target(), "--optin"], ["debug-job", target(), "--session", "default"]]) {
		const run = await bgw(args);
		assert.equal(run.code, 1, `bgw ${args.join(" ")}: ${run.stderr}`);
		assert.match(run.stderr, /error: (argument|unrecognized|invalid choice)/, args.join(" "));
	}
	const help = await bgw(["--help"]);
	assert.equal(/optin|opt-in rule|login rule/i.test(help.stdout.replace(/opt-in hosts/g, "")), false, "no command about rules");

	// Nothing of all that reached the browser, and the rules are what they were.
	assert.deepEqual(seenWith("x1-asked"), []);
	assert.deepEqual(await optinNow(), before);
});

test("a daemon that turned hostile cannot add a rule, widen one or ask for the login, whatever it sends", async () => {
	await logIn("x2", "heidi");
	const before = await optinNow();
	assert.equal(before.hosts.includes("x2.localhost"), false, "no rule for this site");
	const key = /** @type {import("../../extension/shared/auth.js").Bytes} */ (b64urlDecode(h.presharedKey));
	const url = (/** @type {string} */ via) => h.fixtures.url("x2", `/in/cookie/echo?via=${via}`);
	const evilRule = { host: "x2.localhost", path_prefix: "/", subdomains: true };
	const state = { paused: false, pause_reason: null, slots: 1, container: { ready: true }, window: { open: true }, policy_rev: 99, optin_hosts: ["x2.localhost"] };
	/** @param {string} via @param {Record<string, unknown>} over */
	const start = (via, over) => makeMessage(MSG.JOB_START, { job: `j_${via}`, kind: "fetch", url: url(via), session: "auto", wait: { timeout_ms: 8000, settle_ms: 200, dwell_ms: 0, human_wait_ms: 0, scroll: "none" }, extract: { markdown: true, text: false, html: false, raw_html: false, links: false, adapter: "auto" }, files: null, ...over });
	/** @type {Record<string, unknown>[]} one per connection: each of them ends the link */
	const hostile = [
		{ v: PROTOCOL_VERSION, type: "optin.set", rules: [{ host: "x2.localhost", pathPrefix: "/", subdomains: true }] },
		{ v: PROTOCOL_VERSION, type: "policy.set", optin_hosts: ["x2.localhost"] },
		{ v: PROTOCOL_VERSION, type: "settings", optinRules: { v: 1, rules: [{ host: "x2.localhost", pathPrefix: "/", subdomains: true }] } },
		makeMessage(MSG.EVENT, { name: "policy.changed", host: null, job: null, state, detect: null }),
		makeMessage(MSG.JOB_ACCEPTED, { job: "j_evil", cookie_scope: "default", rule: evilRule }),
		makeMessage(MSG.READY, { limits: { max_result_bytes: 8388608, ping_s: 20 }, optin_hosts: ["x2.localhost"] }),
		start("evil-default", { session: "default" }),
		start("evil-login", { session: "login" }),
		start("evil-rule", { rule: evilRule }),
		start("evil-scope", { cookie_scope: "default" }),
		start("evil-optin", { optin: [evilRule] }),
		start("evil-wait", { wait: { timeout_ms: 8000, settle_ms: 200, dwell_ms: 0, human_wait_ms: 0, scroll: "none", session: "default" } }),
	];
	const total = hostile.length;
	await h.stopDaemon();
	/** @type {{ code: number }[]} how the extension ended each connection */
	const closes = [];
	/** @type {Record<string, any>[]} what the extension sent for the one job that is well-formed */
	const honest = [];
	const fake = await scriptedDaemon(
		async (conn) => {
			await conn.handshake(key);
			const frame = hostile.shift();
			if (frame !== undefined) {
				conn.send(frame);
				closes.push(await conn.closed);
				return;
			}
			// Last: a job that is as it should be, for a site without a rule. It runs - in the container.
			conn.send(start("honest", {}));
			for (;;) {
				const msg = await conn.next();
				honest.push(msg);
				if (msg.type === MSG.JOB_RESULT) return;
			}
		},
		{ port: h.daemonPort },
	);
	try {
		for (let i = 0; i < total; i++) {
			await waitFor(() => closes.length > i, { timeoutMs: 30000, intervalMs: 50, what: `the extension to drop the link over hostile frame ${i}` });
			// The extension would come back by itself, a little later every time: asked to, it comes at once.
			await h.hook("reconnect").catch(() => {});
		}
		await waitFor(() => honest.some((m) => m.type === MSG.JOB_RESULT), { timeoutMs: 30000, what: "the honest job to finish" });
	} finally {
		await fake.stop();
	}
	// Every hostile frame was answered by ending the link, and by nothing else.
	assert.equal(closes.length, total);
	assert.ok(closes.every((c) => c.code === 4400), JSON.stringify(closes));
	// None of those jobs ran: no tab, no request - with the login or without.
	assert.deepEqual(h.fixtures.seen((s) => (s.query.via ?? "").startsWith("evil-")), []);
	// The one that did run was told to run in the container, and did.
	assert.deepEqual(honest.find((m) => m.type === MSG.JOB_ACCEPTED), makeMessage(MSG.JOB_ACCEPTED, { job: "j_honest", cookie_scope: "container", rule: null }));
	assert.equal(honest.find((m) => m.type === MSG.JOB_RESULT)?.cookie_scope, "container");
	assert.deepEqual(seenWith("honest").map((s) => s.cookies), [{}]);
	// The rules: exactly as before, in the background page and in both places they are kept.
	assert.deepEqual(await optinNow(), before);
	await h.restartDaemon();
	await h.connected(60000);
	assert.deepEqual((await h.status()).extension.state.optin_hosts, before.hosts);
});

test("a page cannot reach the rules, and a script that got into the extension's part of a page cannot put one in force", async () => {
	await logIn("x3", "ivan");
	await addRule(rule("x3ok"));
	const before = await optinNow();
	const base = (await windows()).windows.flatMap((w) => w.tabs).find((/** @type {any} */ t) => t.role === "park").url.replace(/park\/park\.html$/, "");
	assert.match(base, /^moz-extension:\/\/[0-9a-f-]+\/$/);
	// A page tries what a page can: the extension's API, messages, its own storage under the extension's
	// names, the options page in a frame, by fetch and in a window.
	const r = await job(fx("x3", `/hostile-optin?ext=${encodeURIComponent(base)}`), { wait: { settle_ms: 1500 } });
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	const report = JSON.parse(/REPORT (\{.*\})/.exec(r.content.markdown.replace(/\\/g, ""))?.[1] ?? "{}");
	assert.equal(report.browser, "undefined");
	assert.equal(report.runtime, "undefined");
	assert.equal(report.fetch, "refused");
	assert.notEqual(String(report.frame).startsWith("readable"), true, JSON.stringify(report));
	assert.deepEqual(await optinNow(), before);

	// One step further than any page gets: script running where the extension's content scripts run, in a
	// tab of the operator's. It can write to storage.local - that is why storage.local alone decides nothing.
	const op = await h.hook("window.open", { url: h.fixtures.url("x3", "/plain?via=x3-op") });
	try {
		await waitFor(() => seenWith("x3-op").length === 1, { timeoutMs: 10000, what: "the operator's page" });
		await waitFor(async () => (await windows()).windows.flatMap((w) => w.tabs).some((/** @type {any} */ t) => t.id === op.tabs[0] && t.status === "complete" && /via=x3-op/.test(t.url ?? "")), { timeoutMs: 10000, what: "the operator's page to be loaded" });
		const forged = { v: 1, rules: [...before.rules, { host: "x3.localhost", pathPrefix: "/", subdomains: true }] };
		const wrote = await h.hook("content.exec", {
			tabId: op.tabs[0],
			code: `(async () => {
				const out = {};
				try { await browser.storage.local.set({ optinRules: ${JSON.stringify(forged)} }); out.storage = "written"; } catch (e) { out.storage = "refused"; }
				try {
					await new Promise((resolve, reject) => {
						const open = indexedDB.open("bgw-own", 1);
						open.onupgradeneeded = () => open.result.createObjectStore("kv");
						open.onsuccess = () => { const tx = open.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(${JSON.stringify(JSON.stringify(forged))}, "optinRules"); tx.oncomplete = resolve; tx.onerror = reject; };
						open.onerror = reject;
					});
					out.indexedDB = "written to the page's own";
				} catch (e) { out.indexedDB = "refused"; }
				try { out.message = String(await browser.runtime.sendMessage({ bgw: "optin_set", rules: ${JSON.stringify(forged.rules)} })); } catch (e) { out.message = "refused"; }
				try { out.messageStatus = Object.keys((await browser.runtime.sendMessage({ bgw: "status" })) ?? {}).length; } catch (e) { out.messageStatus = "refused"; }
				return out;
			})()`,
		});
		assert.equal(wrote.storage, "written", "storage.local is open to every script of the extension");
		assert.equal(wrote.messageStatus === "refused" || wrote.messageStatus === 0, true, `the background page does not talk to a content script: ${JSON.stringify(wrote)}`);
		// The two copies no longer agree: no rule is in force - not the forged one, and for now none of the operator's.
		await waitFor(async () => (await optinNow()).state === "mismatch", { timeoutMs: 8000, what: "the background page to notice" });
		await pause(3500);
		const broken = await optinNow();
		assert.deepEqual({ state: broken.state, rules: broken.rules, hosts: broken.hosts }, { state: "mismatch", rules: [], hosts: [] });
		assert.equal(broken.shadow, before.shadow, "the copy in the extension's own storage was out of reach");
		const forgedJob = await job(fx("x3", "/in/cookie/echo?via=x3-forged"));
		assert.equal(forgedJob.cookie_scope, "container");
		assert.deepEqual(seenWith("x3-forged")[0].cookies, {});
		await waitFor(async () => (await h.status()).extension.state.optin_hosts.length === 0, { timeoutMs: 5000, what: "the daemon to hear that no rule is in force" });

		// The operator opens the options page: it says so, shows what they had saved - without the forged
		// rule - and puts exactly that back in force when asked to.
		const opened = await h.hook("ui.open", { page: "options" });
		try {
			await waitFor(async () => /did not pass its check/.test((await ui(["optin-state"]).catch(() => /** @type {Record<string, string | null>} */ ({})))["optin-state"] ?? ""), { timeoutMs: 10000, what: "the options page to say that the list is not in force" });
			const shown = await ui(before.rules.map((_, i) => `optin-rule-${i}`).concat([`optin-rule-${before.rules.length}`]));
			assert.equal(shown[`optin-rule-${before.rules.length}`], null, "the forged rule is not among them");
			assert.equal(Object.values(shown).some((line) => (line ?? "").includes("x3.localhost")), false);
			await click("optin-restore");
			await waitFor(async () => (await optinNow()).state === "ok", { timeoutMs: 8000, what: "the rules to be in force again" });
		} finally {
			await h.hook("window.close", { windowId: opened.windowId });
		}
		const restored = await optinNow();
		assert.deepEqual(restored.rules, before.rules);
		assert.deepEqual(restored.stored, before.stored);
		assert.equal(restored.shadow, before.shadow);
	} finally {
		await h.hook("window.close", { windowId: op.id }).catch(() => {});
	}
	await waitFor(async () => (await h.status()).extension.state.optin_hosts.length === before.hosts.length, { timeoutMs: 5000, what: "the daemon to hear of the rules again" });
});

test("the extension's own copy of the rules is lost (a browser that clears it): no rule is in force, and what is left in storage.local can be read and removed, not put in force", async () => {
	const before = await optinNow();
	assert.equal(before.state, "ok");
	const lost = await h.hook("optin.shadow", { value: null });
	assert.deepEqual(lost, { state: "mismatch", rules: [] });
	const opened = await h.hook("ui.open", { page: "options" });
	try {
		await waitFor(async () => /did not pass its check/.test((await ui(["optin-state"]).catch(() => /** @type {Record<string, string | null>} */ ({})))["optin-state"] ?? ""), { timeoutMs: 10000, what: "the options page to say that the list is not in force" });
		// What lies in storage.local is shown, to be read - and that is all: without the copy that only the
		// options page can write, nobody can say that this list is the operator's. It is not offered.
		assert.equal((await ui(["optin-rule-0"]))["optin-rule-0"], `https://${before.rules[0].host}${before.rules[0].pathPrefix}`);
		assert.match((await ui(["optin-state"]))["optin-state"] ?? "", /may hold rules you never set and cannot be put in force\. Remove all rules, then add again the ones you want\./);
		assert.equal(await h.hook("ui.hidden", { page: "options", id: "optin-trouble" }), false);
		assert.equal(await h.hook("ui.hidden", { page: "options", id: "optin-restore" }), true);
		assert.equal(await h.hook("ui.hidden", { page: "options", id: "optin-clear" }), false);
		// Nothing can be added until that is dealt with.
		assert.equal(await enterRule("late.localhost", "/in", false), "Deal with the stored list above first.");
		// The hidden button, pressed all the same: nothing is written, nothing is in force.
		await click("optin-restore");
		await waitFor(async () => /^Nothing was put in force/.test((await ui(["optin-result"]))["optin-result"] ?? ""), { timeoutMs: 5000, what: "the options page to refuse" });
		await pause(500);
		const still = await optinNow();
		assert.deepEqual({ state: still.state, rules: still.rules, stored: still.stored, shadow: still.shadow }, { state: "mismatch", rules: [], stored: before.stored, shadow: null });
		// What is offered: remove everything.
		await click("optin-clear");
		await waitFor(async () => (await optinNow()).state === "empty", { timeoutMs: 8000, what: "the list to be removed" });
		const cleared = await optinNow();
		assert.deepEqual({ rules: cleared.rules, stored: cleared.stored, shadow: cleared.shadow }, { rules: [], stored: null, shadow: null });
		await waitFor(async () => /^No rule is set\./.test((await ui(["optin-state"]))["optin-state"] ?? ""), { timeoutMs: 5000, what: "the options page to show an empty list" });
		assert.equal(await h.hook("ui.hidden", { page: "options", id: "optin-trouble" }), true);
	} finally {
		await h.hook("window.close", { windowId: opened.windowId });
	}
	// The operator enters the rules again; from here on they are what they were.
	await setRules(before.rules);
	const again = await optinNow();
	assert.deepEqual({ state: again.state, rules: again.rules, stored: again.stored, shadow: again.shadow }, { state: "ok", rules: before.rules, stored: before.stored, shadow: before.shadow });
	// A copy that is not a list at all, or holds a rule the other does not: the same answer.
	for (const value of ["not json", JSON.stringify({ v: 1, rules: [] }), JSON.stringify({ v: 1, rules: [...before.rules, { host: "more.localhost", pathPrefix: "/", subdomains: true }] }), JSON.stringify({ v: 2, rules: before.rules })]) {
		assert.deepEqual(await h.hook("optin.shadow", { value }), { state: "mismatch", rules: [] }, value.slice(0, 40));
	}
	assert.deepEqual(await h.hook("optin.shadow", { value: before.shadow }), { state: "ok", rules: before.rules });
	// And the other way round: whoever writes storage.local alone - more rules, wider rules, fewer rules - ends with none in force.
	const wider = before.rules.map((/** @type {any} */ r, /** @type {number} */ i) => (i === 0 ? { ...r, pathPrefix: "/", subdomains: true } : r));
	for (const value of [{ v: 1, rules: [...before.rules, { host: "more.localhost", pathPrefix: "/", subdomains: true }] }, { v: 1, rules: wider }, { v: 1, rules: before.rules.slice(1) }, { v: 1, rules: [] }, "junk", null]) {
		const forged = await h.hook("optin.forge", { value });
		assert.deepEqual(forged, { state: "mismatch", rules: [] }, JSON.stringify(value).slice(0, 60));
	}
	assert.deepEqual(await h.hook("optin.forge", { value: before.stored }), { state: "ok", rules: before.rules });
	await waitFor(async () => (await h.status()).extension.state.optin_hosts.length === before.hosts.length, { timeoutMs: 8000, what: "the daemon to hear of the rules again" });
});

// ---------------------------------------------------------------- the rate limit

test("each rule has its rate limit: the daemon paces to it, and the extension holds it against a daemon that does not", async () => {
	await logIn("r1");
	await logIn("r2");
	await addRule(rule("r1"));
	await addRule(rule("r2"));
	const { minGapMs, perHour } = LOGIN_TEST_LIMITS;
	// The daemon's pace: three pages asked for at once are loaded a gap apart, and none is refused.
	const paced = await Promise.all([1, 2, 3].map((i) => job(fx("r1", `/in/cookie/echo?via=pace${i}`))));
	for (const r of paced) assert.deepEqual([r.outcome, r.cookie_scope], ["ok", "default"], JSON.stringify(r.error));
	const at = [1, 2, 3].map((i) => seenWith(`pace${i}`)[0].t).sort((a, b) => a - b);
	assert.ok(at[1] - at[0] >= minGapMs && at[2] - at[1] >= minGapMs, `gaps of ${at[1] - at[0]} and ${at[2] - at[1]} ms`);

	// A daemon that keeps no such pace - as one that was tampered with would not.
	await h.restartDaemon({ loginPacing: { minGapMs: 0, perHour: 1000000, marginMs: 0 } });
	await h.connected(60000);
	// Two pages right after each other. Should the first take longer than the gap (a slow machine), the
	// second is no burst: then the pair is tried again. Every page that is loaded is counted for the hour.
	let used = 3;
	let secondsLoaded = 0;
	/** @type {any} */
	let second = null;
	for (let attempt = 0; attempt < 3 && (second === null || second.outcome === "ok"); attempt++) {
		await pause(minGapMs + 100);
		const first = await job(fx("r1", `/in/cookie/echo?via=burst-first${attempt}`), { wait: { settle_ms: 50 } });
		assert.deepEqual([first.outcome, first.cookie_scope], ["ok", "default"], JSON.stringify(first.error));
		used += 1;
		second = await job(fx("r1", "/in/cookie/echo?via=burst2"), { wait: { settle_ms: 50 } });
		if (second.outcome === "ok") {
			used += 1;
			secondsLoaded += 1;
		}
	}
	// The second came too soon: refused by the extension, before any tab was opened.
	assert.equal(second.outcome, "error", "two pages within the gap");
	assert.equal(second.error.code, "login_rate_limit");
	assert.equal(second.error.retryable, true);
	assert.ok(second.error.retry_after_s >= 1 && second.error.retry_after_s <= Math.ceil(minGapMs / 1000), `retry after ${second.error.retry_after_s} s`);
	assert.equal(second.cookie_scope, null, "no tab was opened");
	// Only the seconds that were let through (a slow machine, see above) reached the site.
	assert.equal(seenWith("burst2").length, secondsLoaded, "and nothing was asked of the site");
	// It is not turned into a container job behind the caller's back, and it does not count against the rule.
	// Another rule has a limit of its own; so has the container, which has none of this kind.
	const other = await job(fx("r2", "/in/cookie/echo?via=burst-other"));
	assert.deepEqual([other.outcome, other.cookie_scope], ["ok", "default"], JSON.stringify(other.error));
	const isolated = await job(fx("r1", "/in/cookie/echo?via=burst-isolated"), { session: "isolated" });
	assert.deepEqual([isolated.outcome, isolated.cookie_scope], ["ok", "container"]);

	// The hourly limit: the rest of the hour's pages follow, a gap apart.
	for (; used < perHour; used++) {
		await pause(minGapMs + 100);
		const r = await job(fx("r1", `/in/cookie/echo?via=hour${used}`));
		assert.deepEqual([r.outcome, r.cookie_scope], ["ok", "default"], `page ${used + 1}: ${JSON.stringify(r.error)}`);
	}
	await pause(minGapMs + 100);
	const over = await job(fx("r1", "/in/cookie/echo?via=hour-over"));
	assert.equal(over.error?.code, "login_rate_limit", JSON.stringify(over.error));
	assert.ok(over.error.retry_after_s > 3000 && over.error.retry_after_s <= 3600, `retry after ${over.error.retry_after_s} s`);
	assert.deepEqual(seenWith("hour-over"), []);
	// What an agent is told, and that the way out is the container.
	const told = await tool("/v1/fetch", { url: fx("r1", "/in/cookie/echo?via=hour-agent") });
	assert.equal(told.isError, true);
	assert.match(told.text, /^code: login_rate_limit$/m);
	assert.match(told.text, /limited for each of their rules \(one every ten seconds, thirty an hour\)\. Wait, or pass session isolated to read the page without the login\./);
	assert.match(told.text, /retry_after_s=\d+$/m);
	assert.equal((await tool("/v1/fetch", { url: fx("r1", "/in/cookie/echo?via=hour-agent-isolated"), session: "isolated" })).isError, false);

	// Back to a daemon that paces.
	await h.restartDaemon();
	await h.connected(60000);
});

// ---------------------------------------------------------------- restart and update

test("the rules survive a restart of the browser and an update of the extension, and are in force afterwards", async () => {
	await addRule(rule("k1"));
	await addRule(rule("k2", "/in/cookie", true));
	const before = await optinNow();
	assert.equal(before.state, "ok");
	/** What must be the same afterwards. The revision counter starts over with the background page. */
	const kept = (/** @type {any} */ o) => ({ state: o.state, rules: o.rules, hosts: o.hosts, stored: o.stored, shadow: o.shadow });

	// The browser is closed and opened again.
	await h.restartBrowser();
	assert.deepEqual(kept(await optinNow()), kept(before));
	let status = await h.status();
	assert.equal(status.extension.ext_version, "0.1.9");
	assert.deepEqual(status.extension.state.optin_hosts, before.hosts);
	// The "login" of the fixtures is a session cookie and went with the old session; the rule did not.
	await logIn("k1", "judy");
	let r = await job(fx("k1", "/in/cookie/echo?via=after-restart"));
	assert.deepEqual([r.outcome, r.cookie_scope], ["ok", "default"], JSON.stringify(r.error));
	assert.deepEqual(seenWith("after-restart")[0].cookies, { bgwlogin: "judy" });

	// A newer version of the extension takes the place of the old one, in the same profile.
	await h.restartBrowser({ version: "0.1.9" });
	status = await h.status();
	assert.equal(status.extension.ext_version, "0.1.9");
	assert.deepEqual(kept(await optinNow()), kept(before));
	assert.deepEqual(status.extension.state.optin_hosts, before.hosts);
	await logIn("deep.k2.localhost", "judy");
	r = await job(fx("deep.k2.localhost", "/in/cookie/echo?via=after-update"));
	assert.deepEqual([r.outcome, r.cookie_scope], ["ok", "default"], JSON.stringify(r.error));
	assert.deepEqual(seenWith("after-update")[0].cookies, { bgwlogin: "judy" });
	// And still exactly as narrow as it was.
	r = await job(fx("deep.k2.localhost", "/in/plain?via=after-update-out"));
	assert.equal(r.cookie_scope, "container");
	assert.deepEqual(seenWith("after-update-out")[0].cookies, {});
});

test("an update from a build that kept the pairing key in storage.local: the key moves to the extension's own store and the pairing holds; what is put into storage.local afterwards is never the key", async () => {
	/** @param {string} event */
	const connects = (event) => h.daemon.logs.map((l) => JSON.parse(l)).filter((l) => l.event === event);
	// A pairing of the operator's own: a key no dev config can bring back. Were it lost, the test build would seed
	// its pre-shared key - which the daemon no longer holds - and never connect.
	assert.deepEqual(await h.hook("pair", { code: await h.pairCode() }), { ok: true });
	await h.connected(15000);
	const keyFile = path.join(h.daemon.configDir, "ext.key");
	const paired = fs.readFileSync(keyFile, "utf8");
	assert.notEqual(paired.trim(), h.presharedKey);
	assert.deepEqual(await h.hook("key.where"), { local: false, moved: true, own: "key" }, "this build keeps the key out of storage.local from the start");

	// The state the older build leaves: the key in storage.local, nothing in the own store.
	assert.equal(await h.hook("key.as-before"), true);
	assert.deepEqual(await h.hook("key.where"), { local: true, moved: false, own: "never" });
	// The update in place. restartBrowser waits for the link: it comes up only with the key of the pairing.
	await h.restartBrowser({ version: "0.1.9" });
	assert.equal(connects("ext.connected").at(-1).mode, "auth");
	assert.deepEqual(await h.hook("key.where"), { local: false, moved: true, own: "key" });
	assert.equal(fs.readFileSync(keyFile, "utf8"), paired, "the daemon's key is the one it had");
	assert.match(h.browserLog(), /settings\.key_moved/);
	let r = await job(fx("k1", "/in/plain?via=after-key-move"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	// And at every start after that, with nothing to move.
	await h.restartBrowser();
	assert.equal(connects("ext.connected").at(-1).mode, "auth");
	assert.deepEqual(await h.hook("key.where"), { local: false, moved: true, own: "key" });

	// A key that somebody writes under the old name is not taken at the next start, and does not stay.
	const planted = b64urlEncode(randomBytes(32));
	assert.equal(await h.hook("key.plant", { value: planted }), true);
	assert.deepEqual(await h.hook("key.where"), { local: true, moved: true, own: "key" });
	await h.restartBrowser();
	assert.equal(connects("ext.connected").at(-1).mode, "auth");
	assert.deepEqual(await h.hook("key.where"), { local: false, moved: true, own: "key" });
	assert.match(h.browserLog(), /settings\.key_in_storage_local_ignored/);
	assert.equal(fs.readFileSync(keyFile, "utf8"), paired);
	r = await job(fx("k1", "/in/plain?via=after-planted-key"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	// Nothing of any key in what the extension or the daemon wrote down.
	for (const text of [h.browserLog(), h.daemon.logs.join("\n")]) {
		for (const secret of [paired.trim(), planted, h.presharedKey]) assert.equal(text.includes(secret), false);
	}
});

test("nothing was left behind: one gateway window with its park tab, no job tab, no file", async () => {
	const snap = await windows();
	assert.deepEqual(snap.own.jobTabs, []);
	const gw = snap.windows.filter((w) => w.gateway);
	assert.equal(gw.length, 1);
	assert.equal(gw[0].tabs.length, 1);
	assert.deepEqual(h.downloads(), []);
	assert.deepEqual(await h.hook("pending"), []);
	// Over the whole run: no listener of the request guard ever failed on a request, and no job tab outlived its job.
	for (const event of ["guard.listener_failed", "job.tab_outlived", "window.job_tab_not_closed"]) assert.equal(h.browserLog().includes(event), false, event);
});
