// The gate at the start of the background page: one listener that stands in
// for the request guard until the guard is in place, driven by hand with the
// details Firefox would pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { FakeEvent, logSink, sleep } from "../helpers/ext-fakes.js";
import { StartGate } from "../../extension/background/startgate.js";

const BASE = "moz-extension://0f8c2a3e-5b1d-4c7a-9e6f-112233445566/";
const OURS = "firefox-container-7";
const THEIRS = "firefox-container-3";
const OTHER = "firefox-container-12";

/** @param {{ holdMs?: number, lastMs?: number, quietMs?: number, lingerMs?: number }} [opts] */
function setup(opts = {}) {
	const onBeforeRequest = new FakeEvent();
	const others = { onHeadersReceived: new FakeEvent(), onAuthRequired: new FakeEvent(), onResponseStarted: new FakeEvent(), onErrorOccurred: new FakeEvent() };
	const sink = logSink();
	const gate = new StartGate({ webRequest: /** @type {any} */ ({ onBeforeRequest, ...others }), extensionBase: BASE, log: sink.log, holdMs: opts.holdMs ?? 60000, lastMs: opts.lastMs ?? 60000, quietMs: opts.quietMs ?? 40, lingerMs: opts.lingerMs ?? 60000 });
	/** How often the address of a request was read. */
	let urlReads = 0;
	/**
	 * A request as the browser reports it to the one listener there is.
	 * @param {string | undefined} cookieStoreId
	 * @param {string} [url]
	 * @returns {unknown} what the listener returned: an answer, or the promise of one
	 */
	const ask = (cookieStoreId, url = "https://example.com/secret?x=1", timeStamp = Date.now()) => {
		assert.equal(onBeforeRequest.listeners.length, 1, "the gate is listening");
		const details = { tabId: 4, type: "main_frame", requestId: "1", timeStamp, ...(cookieStoreId === undefined ? {} : { cookieStoreId }) };
		Object.defineProperty(details, "url", {
			enumerable: true,
			get() {
				urlReads += 1;
				return url;
			},
		});
		return onBeforeRequest.listeners[0].fn(details);
	};
	/** @param {unknown} answer @returns {Promise<"pending" | unknown>} what a held request has come to by now */
	const state = async (answer) => Promise.race([answer, sleep(15).then(() => "pending")]);
	return { gate, onBeforeRequest, others, sink, ask, state, urlReads: () => urlReads };
}

test("the gate is one blocking listener for every request, registered at once and by nothing but listen()", async () => {
	const t = setup();
	assert.equal(t.onBeforeRequest.listeners.length, 0);
	assert.deepEqual(t.gate.stats, { listening: false, known: false, held: 0, cancelled: 0, released: 0, outside: 0 });
	t.gate.listen();
	// Synchronously: the browser has the listener before the background page awaits anything.
	assert.deepEqual(t.onBeforeRequest.listeners.map((l) => l.args), [[{ urls: ["<all_urls>"] }, ["blocking"]]]);
	t.gate.listen();
	assert.equal(t.onBeforeRequest.listeners.length, 1, "once");
	for (const event of Object.values(t.others)) assert.equal(event.listeners.length, 0, "no other event is listened to");
	assert.equal(t.gate.stats.listening, true);
	t.gate.known(null);
	assert.equal(await t.gate.leave(), true);
});

test("the operator's requests outside every container pass at once, unread: the default store, a private window, a request that names no store", async () => {
	const t = setup();
	t.gate.listen();
	for (const store of ["firefox-default", "firefox-private", undefined, "", "firefox-container-", "firefox-container-x", "container-7"]) {
		const answer = t.ask(store);
		assert.equal(answer instanceof Promise, false, `${store}: answered in the call itself`);
		assert.deepEqual(answer, {}, String(store));
	}
	assert.equal(t.urlReads(), 0, "the address of such a request is not looked at");
	assert.equal(t.gate.stats.outside, 7);
	assert.equal(t.gate.stats.held, 0);
	// The same once the container is known, and for as long as the gate stands.
	t.gate.stored(OURS);
	t.gate.known(OURS);
	assert.deepEqual(t.ask("firefox-default"), {});
	assert.equal(t.urlReads(), 0);
	assert.equal(await t.gate.leave(), true);
});

test("a request of a container is held until the browser has said which container is the gateway's: then cancelled in that one, passed in every other", async () => {
	const t = setup();
	t.gate.listen();
	// Nothing is known yet, not even what the settings say.
	const early = [t.ask(OURS), t.ask(THEIRS)];
	assert.deepEqual(await Promise.all(early.map(t.state)), ["pending", "pending"]);
	t.gate.stored(OURS);
	// The settings name a container: a guess, and nothing is cancelled or let go on it.
	const later = [t.ask(OURS), t.ask(THEIRS), t.ask(OTHER)];
	assert.deepEqual(await Promise.all([...early, ...later].map(t.state)), ["pending", "pending", "pending", "pending", "pending"]);
	assert.equal(t.gate.stats.cancelled, 0);
	t.gate.known(OURS);
	assert.deepEqual(await Promise.all([...early, ...later]), [{ cancel: true }, {}, { cancel: true }, {}, {}]);
	// From here on in the call itself.
	assert.deepEqual(t.ask(OURS), { cancel: true });
	assert.deepEqual(t.ask(THEIRS), {});
	assert.deepEqual(t.gate.stats, { listening: true, known: true, held: 5, cancelled: 3, released: 0, outside: 0 });
});

test("the settings can be wrong: the container they name was made the operator's, the gateway's is another - nothing of theirs was cancelled on the guess", async () => {
	const t = setup();
	t.gate.listen();
	t.gate.stored(THEIRS);
	const held = [t.ask(THEIRS), t.ask(THEIRS), t.ask(OURS)];
	assert.deepEqual(await Promise.all(held.map(t.state)), ["pending", "pending", "pending"]);
	// The browser: the stored identity carries another name now; the gateway's container is this one.
	t.gate.known(OURS);
	assert.deepEqual(await Promise.all(held), [{}, {}, { cancel: true }]);
	assert.deepEqual(t.ask(THEIRS), {});

	// No container can be had at all: nothing is the gateway's, and everything that waited goes.
	const none = setup();
	none.gate.listen();
	none.gate.stored(OURS);
	const waiting = [none.ask(OURS), none.ask(THEIRS)];
	none.gate.known(null);
	assert.deepEqual(await Promise.all(waiting), [{}, {}]);
	assert.deepEqual(none.ask(OURS), {});
	assert.equal(none.gate.stats.cancelled, 0);
});

test("the operator's other containers do not wait for long: after a moment they are let go, known or not - the one the settings name waits for the browser's word", async () => {
	const t = setup({ holdMs: 60 });
	t.gate.listen();
	t.gate.stored(OURS);
	const theirs = t.ask(THEIRS);
	const ours = t.ask(OURS);
	assert.deepEqual(await Promise.all([theirs, ours].map(t.state)), ["pending", "pending"]);
	await sleep(90);
	assert.deepEqual(await t.state(theirs), {}, "let go, not cancelled");
	assert.equal(await t.state(ours), "pending", "still held");
	// The others pass in the call itself now; the one that may be ours is held as before.
	assert.deepEqual(t.ask(OTHER), {});
	const second = t.ask(OURS);
	assert.equal(await t.state(second), "pending");
	assert.deepEqual(t.gate.stats, { listening: true, known: false, held: 3, cancelled: 0, released: 1, outside: 0 });
	// The gate does not go while they wait.
	assert.equal(await t.gate.leave(), false);
	await sleep(80);
	assert.equal(t.gate.stats.listening, true);
	t.gate.known(OURS);
	assert.deepEqual(await Promise.all([ours, second]), [{ cancel: true }, { cancel: true }]);
	assert.equal(await t.gate.leave(), true);
});

test("with no container in the settings any of them may be the gateway's: all are held for that moment, and none is cancelled before the browser has spoken", async () => {
	const t = setup({ holdMs: 60 });
	t.gate.listen();
	t.gate.stored(null);
	const held = [t.ask(OURS), t.ask(THEIRS)];
	assert.deepEqual(await Promise.all(held.map(t.state)), ["pending", "pending"]);
	await sleep(90);
	assert.deepEqual(await Promise.all(held), [{}, {}]);
	assert.equal(t.gate.stats.released, 2);

	// What the settings hold that is no container's id is "none" as well.
	for (const odd of ["firefox-default", "firefox-private", 7, undefined, "nope"]) {
		const o = setup({ holdMs: 30 });
		o.gate.listen();
		o.gate.stored(odd);
		const a = o.ask(OURS);
		await sleep(60);
		assert.deepEqual(await o.state(a), {}, String(odd));
	}

	// Known in time, it is as ever.
	const k = setup({ holdMs: 5000 });
	k.gate.listen();
	k.gate.stored(null);
	const waiting = [k.ask(OURS), k.ask(THEIRS)];
	k.gate.known(OURS);
	assert.deepEqual(await Promise.all(waiting), [{ cancel: true }, {}]);
});

test("while not even the settings are read, everything of a container waits, longer; settings that arrive late and name a container keep that one waiting", async () => {
	const t = setup({ holdMs: 40, lastMs: 200 });
	t.gate.listen();
	const ours = t.ask(OURS);
	const theirs = t.ask(THEIRS);
	await sleep(80);
	assert.deepEqual(await Promise.all([ours, theirs].map(t.state)), ["pending", "pending"], "the short time has passed, and nobody was let go on nothing");
	// The settings are read: the short time is over for the others, the one they name waits on.
	t.gate.stored(OURS);
	await sleep(10);
	assert.deepEqual(await t.state(theirs), {});
	assert.equal(await t.state(ours), "pending");
	t.gate.known(OURS);
	assert.deepEqual(await ours, { cancel: true });

	// Settings that never come: everything goes at the end of the long time.
	const never = setup({ holdMs: 20, lastMs: 80 });
	never.gate.listen();
	const a = never.ask(OURS);
	await sleep(40);
	assert.equal(await never.state(a), "pending");
	await sleep(70);
	assert.deepEqual(await never.state(a), {});
	assert.deepEqual(never.ask(THEIRS), {});
});

test("the extension's own pages pass in any container, and the gate only ever cancels: {} or { cancel: true }, nothing else", async () => {
	const t = setup();
	t.gate.listen();
	assert.deepEqual(t.ask(OURS, `${BASE}park/park.html`), {});
	t.gate.stored(OURS);
	t.gate.known(OURS);
	assert.deepEqual(t.ask(OURS, `${BASE}options/options.html`), {});
	assert.deepEqual(t.ask(OURS, "https://example.com/"), { cancel: true });
	assert.deepEqual(t.ask(OURS, `https://example.com/?next=${BASE}`), { cancel: true }, "by where the address begins");
	for (const answer of [t.ask(OURS), t.ask(THEIRS), t.ask("firefox-default")]) {
		const keys = Object.keys(/** @type {object} */ (answer));
		assert.ok(keys.length === 0 || (keys.length === 1 && keys[0] === "cancel"), JSON.stringify(answer));
	}
	const source = fs.readFileSync(new URL("../../extension/background/startgate.js", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
	for (const banned of ["redirectUrl", "requestHeaders", "responseHeaders", "upgradeToSecure", "authCredentials", "filterResponseData", "onBeforeSendHeaders", "onHeadersReceived"]) assert.equal(source.includes(banned), false, banned);
});

test("the gate goes when the guard is in place and it is owed nothing more: after a moment in which nothing came, and the log says how long it stood and what it did - in numbers", async () => {
	const t = setup({ quietMs: 60 });
	t.gate.listen();
	assert.equal(await t.gate.leave(), false, "not before the browser has said which container is ours");
	assert.equal(t.onBeforeRequest.listeners.length, 1);
	t.gate.stored(OURS);
	const held = [t.ask(OURS, "https://leftover.example.com/page?token=1"), t.ask(THEIRS, "https://bank.example.com/")];
	t.ask("firefox-default");
	await sleep(20);
	t.gate.known(OURS);
	await Promise.all(held);
	const leaving = t.gate.leave();
	assert.equal(t.gate.leave(), leaving, "asked twice, it leaves once");
	// Not at once: what the browser has collected for it may still be on its way.
	assert.equal(t.onBeforeRequest.listeners.length, 1);
	assert.equal(t.sink.entries.length, 0);
	assert.equal(await leaving, true);
	assert.equal(t.onBeforeRequest.listeners.length, 0, "no listener of the gate is left");
	assert.deepEqual(t.gate.stats, { listening: false, known: true, held: 2, cancelled: 1, released: 0, outside: 1 });
	assert.equal(t.sink.entries.length, 1, "said once");
	const { event, fields } = t.sink.entries[0];
	assert.equal(event, "startgate.gone");
	assert.deepEqual(Object.keys(fields).sort(), ["cancelled", "guarded_ms", "held", "known_ms", "ms", "page_ms", "released", "stored_ms"]);
	assert.equal(fields.page_ms, -1, "registered by the gate itself: nobody said how long after the page began");
	assert.deepEqual([fields.held, fields.cancelled, fields.released], [2, 1, 0]);
	for (const ms of [fields.ms, fields.stored_ms, fields.known_ms, fields.guarded_ms]) assert.ok(typeof ms === "number" && ms >= 0 && ms < 5000, String(ms));
	assert.ok(Number(fields.stored_ms) <= Number(fields.known_ms) && Number(fields.known_ms) <= Number(fields.guarded_ms) && Number(fields.guarded_ms) + 50 <= Number(fields.ms), JSON.stringify(fields));
	assert.equal(/example|token|container|firefox/.test(t.sink.text()), false, t.sink.text());
	// What the settings or the browser say afterwards changes nothing.
	t.gate.stored(THEIRS);
	t.gate.known(THEIRS);
	assert.equal(t.onBeforeRequest.listeners.length, 0);
	assert.equal(await t.gate.leave(), true);
});

test("while the gate waits to go it answers as before: a request of the gateway's container that the browser made before the guard was in place is cancelled, however late it is handed over", async () => {
	const t = setup({ quietMs: 80 });
	t.gate.listen();
	t.gate.stored(OURS);
	t.gate.known(OURS);
	const before = Date.now() - 5;
	const leaving = t.gate.leave();
	// The browser hands over, in pieces, what it collected before the guard was there. Each piece says that it is
	// still at it: the gate stays.
	for (let i = 0; i < 6; i++) {
		await sleep(30);
		assert.deepEqual(t.ask(OURS, "https://leftover.example.com/x", before), { cancel: true }, `piece ${i}`);
		assert.deepEqual(t.ask(THEIRS, "https://bank.example.com/", before), {});
		assert.deepEqual(t.ask("firefox-default", "https://example.org/", before), {});
	}
	assert.equal(t.gate.stats.listening, true, "180 ms on, and it has not gone: something came every 30");
	assert.equal(t.gate.stats.cancelled, 6);
	// Then nothing comes for the quiet time, and it goes.
	assert.equal(await leaving, true);
	assert.equal(t.onBeforeRequest.listeners.length, 0);

	// A request the browser made after the guard was in place says that nothing older is on its way: answered, and
	// then the gate goes without waiting for the quiet time.
	const quick = setup({ quietMs: 60000 });
	quick.gate.listen();
	quick.gate.stored(OURS);
	quick.gate.known(OURS);
	const going = quick.gate.leave();
	await sleep(5);
	assert.deepEqual(quick.ask(OURS, "https://leftover.example.com/x", Date.now() - 1000), { cancel: true });
	await sleep(20);
	assert.equal(quick.gate.stats.listening, true, "an old one: the browser is still handing over");
	assert.deepEqual(quick.ask("firefox-default", "https://example.org/", Date.now() + 5), {}, "answered like any other");
	assert.equal(await going, true);
	assert.equal(quick.onBeforeRequest.listeners.length, 0);

	// And however much keeps coming that looks old: it does not stay for ever.
	const long = setup({ quietMs: 50, lingerMs: 120 });
	long.gate.listen();
	long.gate.known(OURS);
	const out = long.gate.leave();
	const started = Date.now();
	const feed = setInterval(() => {
		if (long.onBeforeRequest.listeners.length === 1) long.ask(THEIRS, "https://bank.example.com/", started - 1000);
	}, 10);
	assert.equal(await out, true);
	clearInterval(feed);
	assert.ok(Date.now() - started >= 100 && Date.now() - started < 1000, `gone after ${Date.now() - started} ms`);
});

// ---------------------------------------------------------------- the first script of the background page

/** @param {unknown} value what a script of another realm handed over @returns {unknown} the same as plain data of this one */
const plain = (value) => JSON.parse(JSON.stringify(value));

const FRONT = fs.readFileSync(new URL("../../extension/background/gatefront.js", import.meta.url), "utf8");

/**
 * Run gatefront.js the way the background page does: as a script of its own, with the browser's API in reach.
 * @returns {{ onBeforeRequest: FakeEvent<any>, front: any, timers: (() => void)[], ask: (cookieStoreId?: string) => unknown }}
 */
function loadFront() {
	const onBeforeRequest = new FakeEvent();
	/** @type {(() => void)[]} what the script asked to be called later */
	const timers = [];
	const sandbox = {
		browser: { webRequest: { onBeforeRequest } },
		performance: { now: () => 12.4 },
		setTimeout: (/** @type {() => void} */ fn) => timers.push(fn),
		clearTimeout: (/** @type {number} */ handle) => {
			timers[handle - 1] = () => {};
		},
		Date,
		Promise,
	};
	const context = vm.createContext(sandbox);
	vm.runInContext(FRONT, context);
	const ask = (/** @type {string | undefined} */ cookieStoreId) => onBeforeRequest.listeners[0].fn({ tabId: 4, type: "main_frame", url: "https://example.com/", ...(cookieStoreId === undefined ? {} : { cookieStoreId }) });
	return { onBeforeRequest, front: /** @type {any} */ (context).bgwGateFront, timers, ask };
}

test("the first script of the background page registers the gate's listener at once, and decides nothing: no container passes, a container waits for the gate", async () => {
	const f = loadFront();
	// Registered while the script ran: before any module of the extension is loaded.
	assert.deepEqual(plain(f.onBeforeRequest.listeners.map((l) => l.args)), [[{ urls: ["<all_urls>"] }, ["blocking"]]]);
	assert.equal(f.front.listener, f.onBeforeRequest.listeners[0].fn);
	assert.equal(f.front.pageMs, 12);
	assert.ok(Math.abs(f.front.since - Date.now()) < 2000);
	for (const store of ["firefox-default", "firefox-private", undefined, "", "firefox-container-x"]) {
		const answer = f.ask(store);
		assert.equal(typeof (/** @type {any} */ (answer).then), "undefined", `${store}: answered in the call itself`);
		assert.deepEqual(plain(answer), {}, String(store));
	}
	const held = [f.ask(OURS), f.ask(THEIRS)];
	const state = (/** @type {unknown} */ answer) => Promise.race([answer, sleep(15).then(() => "pending")]);
	assert.deepEqual(await Promise.all(held.map(state)), ["pending", "pending"], "nothing is cancelled and nothing let go by a script that knows nothing");

	// The gate takes over: what waited is asked of it, and so is everything from then on.
	/** @type {string[]} */
	const asked = [];
	f.front.take((/** @type {{ cookieStoreId: string }} */ details) => {
		asked.push(details.cookieStoreId);
		return details.cookieStoreId === OURS ? { cancel: true } : {};
	});
	assert.deepEqual(await Promise.all(held), [{ cancel: true }, {}]);
	assert.deepEqual(asked, [OURS, THEIRS]);
	assert.deepEqual(f.ask(OURS), { cancel: true });
	assert.deepEqual(f.ask("firefox-default"), {});
	assert.deepEqual(asked, [OURS, THEIRS, OURS, "firefox-default"]);
	// A second taker is nobody.
	f.front.take(() => ({ cancel: true }));
	assert.deepEqual(f.ask(THEIRS), {});

	// A gate that fails on a request it is handed leaves it to pass: nothing is known of it.
	const broken = loadFront();
	const waiting = broken.ask(OURS);
	broken.front.take(() => {
		throw new Error("no");
	});
	assert.deepEqual(plain(await waiting), {});

	// And a gate that never comes - the modules of the extension did not load - holds nobody for good.
	const alone = loadFront();
	const stuck = [alone.ask(OURS), alone.ask(THEIRS)];
	assert.equal(alone.timers.length, 1);
	alone.timers[0]();
	assert.deepEqual(plain(await Promise.all(stuck)), [{}, {}]);
	assert.deepEqual(plain(alone.ask(OURS)), {});
	const source = FRONT.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
	for (const banned of ["cancel", "redirectUrl", "requestHeaders", "responseHeaders", "details.url", "storage", "fetch("]) assert.equal(source.includes(banned), false, `the first script has no ${banned}`);
});

test("the gate takes the first script's listener over: what waited there is held on, answered when the browser has spoken, and the same function is removed at the end", async () => {
	const f = loadFront();
	const early = [f.ask(OURS), f.ask(THEIRS)];
	const sink = logSink();
	const gate = new StartGate({ webRequest: /** @type {any} */ ({ onBeforeRequest: f.onBeforeRequest }), extensionBase: BASE, log: sink.log, front: f.front, holdMs: 60000, lastMs: 60000, quietMs: 30 });
	gate.listen();
	assert.equal(f.onBeforeRequest.listeners.length, 1, "no second listener");
	gate.stored(OURS);
	const later = f.ask(OURS);
	await sleep(15);
	assert.equal(gate.stats.held, 3, "the two that waited in the first script and the one after");
	assert.equal(gate.stats.cancelled, 0);
	gate.known(OURS);
	assert.deepEqual(await Promise.all([...early, later]), [{ cancel: true }, {}, { cancel: true }]);
	assert.deepEqual(f.ask(OURS), { cancel: true });
	assert.equal(await gate.leave(), true);
	assert.equal(f.onBeforeRequest.listeners.length, 0, "the listener the browser had from the first script is gone");
	const { fields } = sink.entries[0];
	assert.equal(fields.page_ms, 12, "how long after the page began the listener was registered");
	assert.deepEqual([fields.held, fields.cancelled], [3, 3]);
});

test("the background page loads the first script before its modules, and nothing else", () => {
	const page = fs.readFileSync(new URL("../../extension/background/background.html", import.meta.url), "utf8");
	assert.deepEqual([...page.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]), ['<script src="gatefront.js">', '<script type="module" src="main.js">']);
	assert.equal(/\son[a-z]+\s*=|javascript:|<script[^>]*>[^<]/i.test(page), false, "no inline script");
});
