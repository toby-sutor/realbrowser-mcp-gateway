// Login opt-in rules: how they are kept (two copies that must agree), how the
// background page reads them without ever writing one, the rate limit of a
// rule, what the operator may type into the options page - and that nothing
// in the extension but the options page holds code that writes a rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeEvent, logSink, sleep } from "../helpers/ext-fakes.js";
import { until } from "../helpers/daemon.js";
import { DEFAULT_STORE_ID, LOGIN_LIMITS, LoginLimiter, OptIn } from "../../extension/background/optin.js";
import {
	LOGIN_LIMITS as SHARED_LIMITS,
	OPTIN_SHADOW_KEY,
	OPTIN_STORAGE_KEY,
	describeOptInRule,
	optInMessage,
	optInRuleFromInput,
	packOptInRules,
	readOptInRules,
	reviewOptInRules,
	serializeOptInRules,
	unpackOptInRules,
	withOptInRule,
} from "../../extension/shared/optin.js";
import { OPTIN_LIMITS, OPTIN_REASON } from "../../extension/shared/policy.js";
import { LOGIN_PACING } from "../../daemon/src/config.js";

const EXT = fileURLToPath(new URL("../../extension/", import.meta.url));
const A = Object.freeze({ host: "forum.example.com", pathPrefix: "/board", subdomains: false });
const B = Object.freeze({ host: "example.org", pathPrefix: "/", subdomains: true });

test("the two copies: rules are in force only while storage.local and the extension's own copy agree", () => {
	const stored = packOptInRules([A, B]);
	const shadow = serializeOptInRules([A, B]);
	assert.deepEqual(stored, { v: 1, rules: [A, B] });
	assert.equal(shadow, JSON.stringify({ v: 1, rules: [A, B] }));
	assert.deepEqual(readOptInRules(stored, shadow), { rules: [A, B], state: "ok", rejected: 0 });
	// Nothing in either place: no rules, and nothing wrong.
	assert.deepEqual(readOptInRules(undefined, null), { rules: [], state: "empty", rejected: 0 });
	assert.deepEqual(readOptInRules(null, ""), { rules: [], state: "empty", rejected: 0 });
	assert.deepEqual(readOptInRules(packOptInRules([]), serializeOptInRules([])), { rules: [], state: "empty", rejected: 0 });

	// One copy alone decides nothing - whichever it is.
	/** @type {[unknown, unknown, string][]} */
	const disagree = [
		[stored, null, "only storage.local"],
		[stored, "", "only storage.local"],
		[undefined, shadow, "only the own copy"],
		[packOptInRules([A, B, { host: "evil.example.net", pathPrefix: "/", subdomains: true }]), shadow, "a rule added to storage.local"],
		[packOptInRules([{ ...A, pathPrefix: "/" }, B]), shadow, "a rule widened in storage.local: the path"],
		[packOptInRules([{ ...A, subdomains: true }, B]), shadow, "a rule widened in storage.local: subdomains"],
		[packOptInRules([{ ...A, host: "example.com" }, B]), shadow, "a rule moved to another host"],
		[packOptInRules([A]), shadow, "a rule removed from storage.local"],
		[packOptInRules([B, A]), shadow, "another order"],
		[packOptInRules([]), shadow, "an empty list in storage.local"],
		[stored, serializeOptInRules([A]), "the own copy holds less"],
		[stored, "not json", "an own copy that is no JSON"],
		[stored, JSON.stringify([A, B]), "an own copy of another shape"],
		[stored, JSON.stringify({ v: 2, rules: [A, B] }), "an own copy of another format"],
		[stored, JSON.stringify({ v: 1, rules: [A, B], more: true }), "an own copy with more in it"],
		[[A, B], shadow, "storage.local of another shape"],
		[{ v: 1, rules: "x" }, shadow, "storage.local without a list"],
		["junk", shadow, "junk in storage.local"],
		[stored, 5, "an own copy that is no text"],
		[stored, "x".repeat(60000), "an own copy that is too long"],
	];
	for (const [s, sh, what] of disagree) {
		const read = readOptInRules(s, sh);
		assert.deepEqual([read.state, read.rules], ["mismatch", []], what);
	}
	// A rule that no longer passes the check (an update of the extension tightened it) is out of force by
	// itself, in both copies alike: the others stand.
	const stale = { host: "paypal.com", pathPrefix: "/", subdomains: false };
	assert.deepEqual(readOptInRules({ v: 1, rules: [A, stale] }, JSON.stringify({ v: 1, rules: [A, stale] })), { rules: [A], state: "ok", rejected: 1 });
	// The check is the caller's: a fixture name passes only where fixture ports are listed.
	const fixture = { host: "a.localhost", pathPrefix: "/in", subdomains: false };
	assert.deepEqual(readOptInRules(packOptInRules([fixture]), serializeOptInRules([fixture])), { rules: [], state: "empty", rejected: 1 });
	assert.deepEqual(readOptInRules(packOptInRules([fixture]), serializeOptInRules([fixture]), { fixturePorts: [4711] }).rules, [fixture]);
	assert.deepEqual(unpackOptInRules(stored), { rules: [A, B], rejected: 0 });
	assert.equal(unpackOptInRules([A]), null);
	assert.equal(OPTIN_STORAGE_KEY, "optinRules");
	assert.equal(OPTIN_SHADOW_KEY, "optinRules");
});

/**
 * The background page's reader over fake storage.
 * @param {{ stored?: unknown, shadow?: string | null, shadowThrows?: boolean, retryMs?: number[], now?: () => number, limits?: { minGapMs?: number, perHour?: number }, fixturePorts?: number[] }} [o]
 */
function setup(o = {}) {
	const world = { stored: o.stored, shadow: o.shadow ?? null, shadowThrows: o.shadowThrows === true, reads: 0, changes: 0 };
	/** @type {string[]} every method of the storage area that was called */
	const storageCalls = [];
	const onChanged = new FakeEvent();
	const sink = logSink();
	const storage = new Proxy(
		{},
		{
			get: (_target, name) => {
				if (name === "get") {
					return async (/** @type {string[]} */ keys) => {
						storageCalls.push("get");
						world.reads += 1;
						assert.deepEqual(keys, [OPTIN_STORAGE_KEY]);
						return world.stored === undefined ? {} : { [OPTIN_STORAGE_KEY]: world.stored };
					};
				}
				return () => {
					storageCalls.push(String(name));
					throw new Error(`the background page called storage.${String(name)}`);
				};
			},
		},
	);
	const optin = new OptIn({
		storage: /** @type {any} */ (storage),
		shadow: async () => {
			if (world.shadowThrows) throw new Error("no page storage");
			return world.shadow;
		},
		onChanged: /** @type {any} */ (onChanged),
		policy: { fixturePorts: o.fixturePorts ?? [] },
		log: sink.log,
		onChange: () => {
			world.changes += 1;
		},
		...(o.now === undefined ? {} : { now: o.now }),
		...(o.limits === undefined ? {} : { limits: o.limits }),
		retryMs: o.retryMs ?? [],
	});
	/** What the options page does: its own copy first, then storage.local, which tells the background page. */
	const operatorSaves = (/** @type {import("../../extension/shared/policy.js").OptInRule[]} */ rules) => {
		world.shadow = rules.length === 0 ? null : serializeOptInRules(rules);
		world.stored = rules.length === 0 ? undefined : packOptInRules(rules);
		onChanged.fire({ [OPTIN_STORAGE_KEY]: {} }, "local");
	};
	return { optin, world, storageCalls, onChanged, sink, operatorSaves };
}

test("a list that did not pass its check: only the extension's own copy can be offered again, never what stands in storage.local alone", () => {
	const forged = { host: "bank.example.com", pathPrefix: "/", subdomains: true };
	// In agreement, or nothing at all: what is in force, and nothing to offer.
	assert.deepEqual(reviewOptInRules(packOptInRules([A, B]), serializeOptInRules([A, B])), { state: "ok", rules: [A, B], restorable: false });
	assert.deepEqual(reviewOptInRules(undefined, null), { state: "empty", rules: [], restorable: false });
	// The own copy holds rules: it is what the operator saved, whatever storage.local says now.
	for (const stored of [packOptInRules([A, forged]), packOptInRules([forged]), packOptInRules([{ ...A, pathPrefix: "/", subdomains: true }]), undefined, null, "junk", { v: 1, rules: [] }]) {
		assert.deepEqual(reviewOptInRules(stored, serializeOptInRules([A])), { state: "mismatch", rules: [A], restorable: true }, JSON.stringify(stored));
	}
	// The own copy is lost, empty or no list: what storage.local holds is shown, each rule checked, and is not restorable.
	const lost = [null, undefined, "", "not json", "null", "[]", JSON.stringify({ v: 1, rules: [] }), JSON.stringify({ v: 2, rules: [A] }), JSON.stringify({ v: 1, rules: [{ host: "com", pathPrefix: "/", subdomains: true }] }), 5, {}, "x".repeat(200000)];
	for (const shadow of lost) {
		assert.deepEqual(reviewOptInRules(packOptInRules([A, forged]), shadow), { state: "mismatch", rules: [A, forged], restorable: false }, String(shadow).slice(0, 40));
		assert.deepEqual(reviewOptInRules({ v: 1, rules: [forged, { host: "com", pathPrefix: "/", subdomains: true }] }, shadow), { state: "mismatch", rules: [forged], restorable: false });
	}
	// An own copy too long to be one is no copy.
	const many = Array.from({ length: OPTIN_LIMITS.maxRules }, (_, i) => ({ host: `site${i}.example.com`, pathPrefix: "/", subdomains: false }));
	assert.equal(reviewOptInRules(packOptInRules([forged]), serializeOptInRules(many)).restorable, true);
	assert.deepEqual(reviewOptInRules(packOptInRules([forged]), `${serializeOptInRules(many)}${" ".repeat(40000)}`), { state: "mismatch", rules: [forged], restorable: false });
	// Neither can be read: nothing to show.
	assert.deepEqual(reviewOptInRules("junk", "junk"), { state: "mismatch", rules: [], restorable: false });
	// The options page decides nothing of this by itself.
	const page = fs.readFileSync(path.join(EXT, "options/options.js"), "utf8");
	assert.equal(/\bunpackOptInRules\b|\breadOptInRules\b|JSON\.parse/.test(page), false, "the page reads the two copies through reviewOptInRules only");
	assert.match(page, /if \(now\.state !== "mismatch" \|\| !now\.restorable \|\|/);
});

test("the background page reads the rules at start and when storage.local changes - and never writes", async () => {
	const t = setup({ stored: packOptInRules([A]), shadow: serializeOptInRules([A]) });
	assert.deepEqual([t.optin.state, t.optin.rules, t.optin.rev], ["empty", [], 1], "nothing is in force before the first read");
	await t.optin.load();
	assert.deepEqual([t.optin.state, t.optin.rules, t.optin.rev, t.world.changes], ["ok", [A], 2, 1]);
	assert.deepEqual(t.optin.hosts(), ["forum.example.com"]);
	// Which rule a URL lies in.
	assert.deepEqual(t.optin.match("https://forum.example.com/board/thread/1?x=1"), A);
	assert.equal(t.optin.match("https://forum.example.com/messages"), null);
	assert.equal(t.optin.match("https://www.forum.example.com/board/x"), null);
	assert.equal(t.optin.match("http://forum.example.com/board/x"), null);

	// The operator saves another list: taken at once, the revision goes up, the listener is told.
	t.operatorSaves([A, B, { ...A, pathPrefix: "/wiki" }]);
	await until(() => t.optin.rules.length === 3);
	assert.deepEqual([t.optin.rev, t.world.changes], [3, 2]);
	assert.deepEqual(t.optin.hosts(), ["forum.example.com", "example.org"], "each host once");
	assert.deepEqual(t.optin.match("https://docs.example.org/anything"), B);
	// A change of something else in storage, or in another area, is none of its business.
	const reads = t.world.reads;
	t.onChanged.fire({ extKey: {} }, "local");
	t.onChanged.fire({ [OPTIN_STORAGE_KEY]: {} }, "sync");
	t.onChanged.fire({ [OPTIN_STORAGE_KEY]: {} }, "managed");
	await sleep(20);
	assert.equal(t.world.reads, reads);
	// The same list again changes nothing and tells nobody.
	t.operatorSaves([A, B, { ...A, pathPrefix: "/wiki" }]);
	await until(() => t.world.reads > reads);
	await sleep(10);
	assert.deepEqual([t.optin.rev, t.world.changes], [3, 2]);
	// Removed: gone.
	t.operatorSaves([]);
	await until(() => t.optin.rules.length === 0);
	assert.deepEqual([t.optin.state, t.optin.hosts(), t.optin.match("https://forum.example.com/board/x")], ["empty", [], null]);

	// In all of this the background page only ever read.
	assert.deepEqual([...new Set(t.storageCalls)], ["get"]);
	// It has no way of its own to set a rule either: what it offers is reading, matching and counting.
	const api = Object.getOwnPropertyNames(OptIn.prototype).sort();
	assert.deepEqual(api, ["admit", "constructor", "hosts", "load", "match", "rev", "rules", "state"]);
	assert.equal(Object.isFrozen(t.optin.rules) || Array.isArray(t.optin.rules), true);
});

test("storage.local written by someone else: nothing is in force - not the forged list, not the old one", async () => {
	const t = setup({ stored: packOptInRules([A]), shadow: serializeOptInRules([A]) });
	await t.optin.load();
	assert.deepEqual(t.optin.rules, [A]);
	// A script that can reach storage.local, and nothing else of the extension, adds a rule of its own.
	t.world.stored = packOptInRules([A, { host: "bank.example.com", pathPrefix: "/", subdomains: true }]);
	t.onChanged.fire({ [OPTIN_STORAGE_KEY]: {} }, "local");
	await until(() => t.optin.state === "mismatch");
	assert.deepEqual([t.optin.rules, t.optin.hosts(), t.world.changes], [[], [], 2]);
	assert.equal(t.optin.match("https://bank.example.com/account"), null);
	assert.equal(t.optin.match("https://forum.example.com/board/x"), null, "fail closed: everything runs in the container");
	assert.equal(t.sink.count("optin.not_in_force"), 1);
	// It widens the operator's rule instead: the same.
	t.world.stored = packOptInRules([{ ...A, pathPrefix: "/", subdomains: true }]);
	t.onChanged.fire({ [OPTIN_STORAGE_KEY]: {} }, "local");
	await sleep(20);
	assert.deepEqual([t.optin.state, t.optin.rules], ["mismatch", []]);
	// Only when the two agree again - the operator saved in the options page - are rules back.
	t.operatorSaves([A]);
	await until(() => t.optin.state === "ok");
	assert.deepEqual(t.optin.rules, [A]);
	assert.deepEqual([...new Set(t.storageCalls)], ["get"]);

	// The extension's own copy cannot be read at all (a browser that withholds it): nothing is in force.
	const u = setup({ stored: packOptInRules([A]), shadow: serializeOptInRules([A]), shadowThrows: true });
	await u.optin.load();
	assert.deepEqual([u.optin.state, u.optin.rules], ["mismatch", []]);
	// Stored rules that do not pass the check are left out, and said to be.
	const v = setup({ stored: { v: 1, rules: [A, { host: "com", pathPrefix: "/", subdomains: true }] }, shadow: JSON.stringify({ v: 1, rules: [A, { host: "com", pathPrefix: "/", subdomains: true }] }) });
	await v.optin.load();
	assert.deepEqual(v.optin.rules, [A]);
	assert.deepEqual(v.sink.entries.find((e) => e.event === "optin.rules_ignored")?.fields, { count: 1 });
	// Nothing of a rule is written to the log: counts only.
	assert.equal(/forum|example|board/.test(t.sink.text() + u.sink.text() + v.sink.text()), false);
});

test("the options page writes one copy after the other: a look in between is repeated before it counts", async () => {
	const t = setup({ retryMs: [20, 40] });
	await t.optin.load();
	// storage.local is there already, the own copy a moment later.
	t.world.stored = packOptInRules([A]);
	t.onChanged.fire({ [OPTIN_STORAGE_KEY]: {} }, "local");
	await until(() => t.optin.state === "mismatch");
	t.world.shadow = serializeOptInRules([A]);
	await until(() => t.optin.state === "ok", { timeoutMs: 1000 });
	assert.deepEqual(t.optin.rules, [A]);
	// It does not keep looking for ever: two more looks, then the mismatch stands.
	const u = setup({ stored: packOptInRules([A]), retryMs: [10, 10] });
	await u.optin.load();
	await sleep(120);
	assert.equal(u.world.reads, 3);
	assert.equal(u.optin.state, "mismatch");
});

test("the rate limit of a rule: one page per ten seconds and thirty an hour, counted per rule", () => {
	assert.deepEqual(LOGIN_LIMITS, { minGapMs: 10000, perHour: 30 });
	assert.equal(LOGIN_LIMITS, SHARED_LIMITS);
	assert.equal(Object.isFrozen(LOGIN_LIMITS), true);
	// The daemon paces to the same numbers, with a little room.
	assert.deepEqual(LOGIN_PACING, { minGapMs: 10000, perHour: 30, marginMs: 250 });
	assert.equal(DEFAULT_STORE_ID, "firefox-default");

	let now = 1000000;
	const limiter = new LoginLimiter({ now: () => now });
	assert.equal(limiter.admit("a"), 0);
	assert.equal(limiter.admit("a"), 10, "the second at once: wait the whole gap");
	now += 4200;
	assert.equal(limiter.admit("a"), 6);
	now += 5799;
	assert.equal(limiter.admit("a"), 1);
	// Another rule is not held up by this one.
	assert.equal(limiter.admit("b"), 0);
	now += 1;
	assert.equal(limiter.admit("a"), 0, "exactly ten seconds after the last one that was granted");
	// A refusal does not count: asking again and again changes nothing about when the next one may be.
	for (let i = 0; i < 50; i++) assert.equal(limiter.admit("a"), 10);
	now += 10000;
	assert.equal(limiter.admit("a"), 0);

	// Thirty an hour: at a steady pace of one a minute the thirty-first is refused until the first is an hour old.
	now = 5000000;
	const hourly = new LoginLimiter({ now: () => now });
	const first = now;
	for (let i = 0; i < 30; i++) {
		assert.equal(hourly.admit("a"), 0, `page ${i + 1}`);
		now += 60000;
	}
	assert.equal(now - first, 1800000);
	assert.equal(hourly.admit("a"), 1800, "half an hour until the first of them is an hour old");
	assert.equal(hourly.admit("b"), 0, "per rule");
	now = first + 3600000 - 1;
	assert.equal(hourly.admit("a"), 1);
	now = first + 3600000;
	assert.equal(hourly.admit("a"), 0);
	assert.equal(hourly.admit("a"), 60, "thirty again: until the second of the old ones is an hour old");
	now += 59000;
	assert.equal(hourly.admit("a"), 1);
	now += 1000;
	assert.equal(hourly.admit("a"), 0);
	// A clock that jumps back does not open the gate.
	now -= 86400000;
	assert.ok(hourly.admit("b") >= 0);

	// Many rules are remembered; the count of one is not lost by the use of others.
	now = 9000000;
	const many = new LoginLimiter({ now: () => now });
	assert.equal(many.admit("kept"), 0);
	for (let i = 0; i < 150; i++) assert.equal(many.admit(`rule${i}`), 0);
	assert.equal(many.admit("kept"), 10);
});

test("the store hands out uses of a rule through the limiter: the same rule under the same key, another path another key", async () => {
	let now = 1000;
	const t = setup({ stored: packOptInRules([A, { ...A, pathPrefix: "/wiki" }]), shadow: serializeOptInRules([A, { ...A, pathPrefix: "/wiki" }]), now: () => now });
	await t.optin.load();
	assert.equal(t.optin.admit(A), 0);
	assert.equal(t.optin.admit({ ...A }), 10);
	assert.equal(t.optin.admit({ ...A, pathPrefix: "/wiki" }), 0);
	assert.equal(t.optin.admit({ ...A, subdomains: true }), 0, "a rule that covers more is another rule");
	// Taking a rule off the list and putting it back does not reset its count.
	t.operatorSaves([]);
	await until(() => t.optin.rules.length === 0);
	t.operatorSaves([A]);
	await until(() => t.optin.rules.length === 1);
	assert.equal(t.optin.admit(A), 10);
	now += 10000;
	assert.equal(t.optin.admit(A), 0);
	// A test build may shorten the limit; nothing else can.
	const quick = setup({ limits: { minGapMs: 200, perHour: 2 }, now: () => now });
	assert.equal(quick.optin.admit(A), 0);
	assert.equal(quick.optin.admit(A), 1);
	now += 200;
	assert.equal(quick.optin.admit(A), 0);
	now += 200;
	assert.ok(quick.optin.admit(A) > 3500);
});

test("what the operator types: taken as typed, refused when it needs guessing", () => {
	/** @param {string} host @param {string} p @param {boolean} sub */
	const typed = (host, p, sub) => optInRuleFromInput(host, p, sub);
	assert.deepEqual(typed("  Old.Reddit.COM. ", " /r/programming ", false), { ok: true, rule: { host: "old.reddit.com", pathPrefix: "/r/programming", subdomains: false } });
	assert.deepEqual(typed("example.org", "", true), { ok: true, rule: { host: "example.org", pathPrefix: "/", subdomains: true } });
	// A name in another script is kept the way the browser sends it.
	assert.deepEqual(typed("bücher.example", "/", false), { ok: true, rule: { host: "xn--bcher-kva.example", pathPrefix: "/", subdomains: false } });
	/** @type {[string, string, boolean, string][]} */
	const refused = [
		["", "/", false, OPTIN_REASON.HOST],
		["   ", "/", false, OPTIN_REASON.HOST],
		["https://reddit.com", "/", false, OPTIN_REASON.HOST],
		["http://reddit.com/r/all", "/", false, OPTIN_REASON.HOST],
		["reddit.com/r/all", "/", false, OPTIN_REASON.HOST],
		["reddit.com:443", "/", false, OPTIN_REASON.HOST],
		["user@reddit.com", "/", false, OPTIN_REASON.HOST],
		["*.reddit.com", "/", false, OPTIN_REASON.HOST],
		["reddit.*", "/", false, OPTIN_REASON.HOST],
		["*", "/", true, OPTIN_REASON.HOST],
		["reddit com", "/", false, OPTIN_REASON.HOST],
		["reddit.com?x", "/", false, OPTIN_REASON.HOST],
		["reddit.com#x", "/", false, OPTIN_REASON.HOST],
		["%72eddit.com", "/", false, OPTIN_REASON.HOST],
		["[::1]", "/", false, OPTIN_REASON.HOST],
		["com", "/", true, OPTIN_REASON.HOST],
		["localhost", "/", false, OPTIN_REASON.HOST],
		["10.0.0.1", "/", false, OPTIN_REASON.IP],
		["2130706433", "/", false, OPTIN_REASON.HOST],
		["router.local", "/", false, OPTIN_REASON.LOCAL],
		["co.uk", "/", true, OPTIN_REASON.PUBLIC_SUFFIX],
		["github.io", "/", false, OPTIN_REASON.PUBLIC_SUFFIX],
		["uk.com", "/", true, OPTIN_REASON.PUBLIC_SUFFIX],
		["WordPress.com", "/", false, OPTIN_REASON.PUBLIC_SUFFIX],
		// With subdomains a name that only has the form of a shared one is refused as well; alone it is a host like any other.
		["s3.eu-west-1.amazonaws.com", "/", true, OPTIN_REASON.SUFFIX_LIKE],
		["mi.it", "/", true, OPTIN_REASON.SUFFIX_LIKE],
		["example.br", "/", true, OPTIN_REASON.SUFFIX_LIKE],
		["mail.google.com", "/", false, OPTIN_REASON.BLOCKLISTED],
		["google.com", "/", true, OPTIN_REASON.COVERS_BLOCKLISTED],
		["reddit.com", "r/all", false, OPTIN_REASON.PATH],
		["reddit.com", "/r/all?sort=new", false, OPTIN_REASON.PATH],
		["reddit.com", "/r/all#top", false, OPTIN_REASON.PATH],
		["reddit.com", "/r/../settings", false, OPTIN_REASON.PATH],
		["reddit.com", "/r//all", false, OPTIN_REASON.PATH],
		["reddit.com", "/r all", false, OPTIN_REASON.PATH],
		["reddit.com", "/Zürich", false, OPTIN_REASON.PATH],
	];
	for (const [host, p, sub, reason] of refused) assert.deepEqual(typed(host, p, sub), { ok: false, reason }, `${host} ${p}`);
	// Not text, not a boolean: no rule.
	assert.deepEqual(optInRuleFromInput(5, "/", false), { ok: false, reason: OPTIN_REASON.SHAPE });
	assert.deepEqual(optInRuleFromInput("reddit.com", "/", "on"), { ok: false, reason: OPTIN_REASON.SHAPE });
	assert.deepEqual(optInRuleFromInput("reddit.com", "/", undefined), { ok: false, reason: OPTIN_REASON.SHAPE }, "the box for subdomains has no default here: it is ticked or it is not");
	// Every reason has a sentence for the operator, and an unknown one a harmless one.
	for (const reason of [...Object.values(OPTIN_REASON), "duplicate", "too_many"]) assert.ok(optInMessage(reason).length > 20, reason);
	assert.equal(optInMessage("no_such_reason"), optInMessage(OPTIN_REASON.SHAPE));
	assert.equal(optInMessage("__proto__"), optInMessage(OPTIN_REASON.SHAPE));
	assert.match(optInMessage(OPTIN_REASON.HOST), /no wildcard/);
	assert.deepEqual(typed("mi.it", "/", false), { ok: true, rule: { host: "mi.it", pathPrefix: "/", subdomains: false } });
	assert.match(optInMessage(OPTIN_REASON.SUFFIX_LIKE), /one at a time, without subdomains/);
	assert.notEqual(optInMessage(OPTIN_REASON.SUFFIX_LIKE), optInMessage(OPTIN_REASON.PUBLIC_SUFFIX));
});

test("the list the options page keeps: added at the end, changed in place, no rule twice, no more than the cap", () => {
	assert.deepEqual(withOptInRule([], A), { ok: true, rules: [A] });
	assert.deepEqual(withOptInRule([A], B), { ok: true, rules: [A, B] });
	assert.deepEqual(withOptInRule([A, B], { ...A }), { ok: false, reason: "duplicate" });
	// Changing a rule: the new one takes the place of the old.
	const C = { host: "forum.example.com", pathPrefix: "/board/public", subdomains: false };
	assert.deepEqual(withOptInRule([A, B], C, "forum.example.com/board"), { ok: true, rules: [C, B] });
	assert.deepEqual(withOptInRule([A, B], B, "forum.example.com/board"), { ok: false, reason: "duplicate" }, "into a rule that is there already");
	assert.deepEqual(withOptInRule([A, B], { ...A }, "forum.example.com/board"), { ok: true, rules: [A, B] }, "saved unchanged");
	// The rule that was being changed is gone meanwhile: the new one is added.
	assert.deepEqual(withOptInRule([B], C, "forum.example.com/board"), { ok: true, rules: [B, C] });
	const full = Array.from({ length: OPTIN_LIMITS.maxRules }, (_, i) => ({ host: `site${i}.example.com`, pathPrefix: "/", subdomains: false }));
	assert.deepEqual(withOptInRule(full, A), { ok: false, reason: "too_many" });
	assert.equal(withOptInRule(full, A, "site3.example.com/").ok, true, "one out, one in");
	assert.equal(describeOptInRule(A), "https://forum.example.com/board");
	assert.equal(describeOptInRule(B), "https://example.org/  (and every subdomain of example.org)");
	assert.ok(serializeOptInRules(full).length < 60000, "a full list fits what either copy may hold");
});

/** @param {string} dir @returns {string[]} every .js and .html file of the extension below it, vendor aside */
function sources(dir) {
	return fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile() && /\.(js|html)$/.test(e.name))
		.map((e) => path.relative(EXT, path.join(e.parentPath, e.name)).replaceAll(path.sep, "/"))
		.filter((f) => !f.startsWith("vendor/"))
		.sort();
}

test("in the extension only the options page holds code that writes a rule; the test hook is the one other, and it does not ship", () => {
	/** @type {Record<string, string>} */
	const code = {};
	for (const file of sources(EXT)) code[file] = fs.readFileSync(path.join(EXT, file), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

	// Who can write the copy that content scripts cannot reach.
	const ownWriters = Object.keys(code).filter((f) => /\bown(Set|Remove)\b/.test(code[f]) && f !== "shared/ownstore.js");
	assert.deepEqual(ownWriters, ["background/devhook.js", "options/options.js"]);
	// Who writes the rules into storage.local.
	const storageWriters = Object.keys(code).filter((f) => /OPTIN_STORAGE_KEY/.test(code[f]) && /storage\.local\.(set|remove)\(/.test(code[f]));
	assert.deepEqual(storageWriters, ["background/devhook.js", "options/options.js"]);
	// The literal name of the key appears in one place, so nobody writes it under another spelling.
	assert.deepEqual(Object.keys(code).filter((f) => /["'`]optinRules["'`]/.test(code[f])), ["shared/optin.js"]);
	// Who can even build the stored form of a list.
	const packers = Object.keys(code).filter((f) => /\b(packOptInRules|serializeOptInRules)\b/.test(code[f]) && f !== "shared/optin.js");
	assert.deepEqual(packers, ["background/devhook.js", "options/options.js"]);

	// The background page: reads, compares, matches. No write of a rule, in any of its modules.
	for (const file of Object.keys(code).filter((f) => f.startsWith("background/") && f !== "background/devhook.js")) {
		assert.equal(/\bown(Set|Remove)\b|packOptInRules|serializeOptInRules|withOptInRule|optInRuleFromInput/.test(code[file]), false, file);
	}
	// What the background page does for a message of another page of the extension: nothing about rules.
	const main = code["background/main.js"];
	const cases = [...main.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]).sort();
	assert.deepEqual(cases, ["clear_container", "forget", "open_challenge", "pair", "pause", "reconnect", "resume", "set_port"]);
	assert.equal(/onMessageExternal|onConnectExternal|externally_connectable/.test(Object.values(code).join("\n")), false, "no way in from outside the extension");
	// What arrives over the link to the daemon reaches the job runner and nothing else.
	assert.equal(/optin/i.test(code["background/link.js"]), false);
	const jobs = code["background/jobs.js"];
	assert.equal(/optin\.(load|set|add|write)|storage\./.test(jobs), false);
	assert.deepEqual([...new Set([...jobs.matchAll(/\.optin\.([a-z]+)\(/g)].map((m) => m[1]))].sort(), ["admit", "match"]);
	// The content scripts know nothing of rules or of the extension's storage.
	for (const file of Object.keys(code).filter((f) => f.startsWith("content/"))) {
		assert.equal(/optin|storage\.|indexedDB|runtime\.sendMessage|browser\./i.test(code[file]), false, file);
	}
	// The options page shows what it shows through textContent, and loads no script but its own module.
	const page = fs.readFileSync(path.join(EXT, "options/options.html"), "utf8");
	assert.deepEqual([...page.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]), ['<script type="module" src="options.js">']);
	assert.equal(/\son[a-z]+\s*=|javascript:|<script[^>]*>[^<]/i.test(page), false, "no inline script");
	assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(code["options/options.js"]), false);
	// The manifest: the same permissions as before, and nothing a page could use to talk to the extension.
	const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
	assert.deepEqual(manifest.permissions, ["tabs", "webNavigation", "webRequest", "webRequestBlocking", "<all_urls>", "contextualIdentities", "cookies", "storage", "notifications", "dns", "sessions", "downloads"]);
	assert.equal(manifest.web_accessible_resources, undefined);
	assert.equal(manifest.content_scripts, undefined);
	// And the build leaves the test hook out by name.
	assert.match(fs.readFileSync(path.join(EXT, "../tools/build-xpi.sh"), "utf8"), /EXCLUDED = \{"dev-config\.json", "background\/devhook\.js"\}/);
});

test("the options page says what a rule means: every risk, in the page itself", () => {
	const page = fs.readFileSync(path.join(EXT, "options/options.html"), "utf8").replace(/\s+/g, " ");
	for (const said of [
		"Use my login on these sites",
		"where you are not logged in to anything",
		"Pages under a rule are loaded with your own login: your cookies and your session",
		"The agent can read whatever you can see there - private messages, account pages, anything behind the login that lies under the rule.",
		"Loading a page can have side effects. On some sites opening an address marks something as read, casts a vote, unsubscribes or logs you out.",
		"The site sees these visits as yours.",
		"Such pages are handed to the agent once and are not stored on this computer.",
		"keep the path as narrow as you can",
		"A page that tries to go outside its rule is stopped.",
		"at most one page every 10 seconds and 30 pages an hour",
		"Accounts, webmail, payment and password-manager sites cannot be added.",
		"Rules can be changed on this page only.",
		'<input id="optin-subdomains" type="checkbox">',
	]) {
		assert.ok(page.includes(said), said);
	}
	// The box for subdomains is not ticked unless the operator ticks it.
	assert.equal(/id="optin-subdomains"[^>]*checked/.test(page), false);
	assert.equal(LOGIN_LIMITS.minGapMs === 10000 && LOGIN_LIMITS.perHour === 30, true, "the numbers the page names are the ones in force");
});
