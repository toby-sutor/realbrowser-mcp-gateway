import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createNotifier,
	displayHost,
	safeText,
	isValidHost,
	isValidJobId,
	CLOSE_GRACE_MS,
	HOOK_TIMEOUT_MS,
	HOST_COOLDOWN_MS,
	SOUND_TIMEOUT_MS,
	MAX_HELPERS,
	MAX_LINE_BYTES,
	MAX_PER_MINUTE,
} from "../../daemon/src/notify.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { makeSpawn } from "../helpers/fake-spawn.js";

/**
 * @typedef {import("../../daemon/src/notify.js").ChildLike} ChildLike
 * @typedef {import("../helpers/fake-spawn.js").Call} Call
 */

function makeLog() {
	/** @type {Array<{ level: string, event: string, fields: Record<string, unknown> | undefined }>} */
	const lines = [];
	const at = (/** @type {string} */ level) => (/** @type {string} */ event, /** @type {import("../../daemon/src/log.js").LogFields | undefined} */ fields) => {
		lines.push({ level, event, fields });
	};
	return { lines, log: { info: at("info"), warn: at("warn"), error: at("error") } };
}

const SOUNDS = ["/snd/a.oga", "/snd/b.oga"];

/** @param {Partial<Parameters<typeof createNotifier>[0]> & { existing?: string[] }} [over] */
function setup(over = {}) {
	const sp = makeSpawn();
	const clock = new FakeClock();
	const { lines, log } = makeLog();
	const existing = new Set(over.existing ?? SOUNDS.slice(1));
	const notifier = createNotifier({
		log,
		clock,
		spawn: sp.spawn,
		helperPath: "/h/notify_helper.py",
		fileExists: (f) => existing.has(f),
		soundCandidates: SOUNDS,
		...over,
	});
	const helperCalls = () => sp.calls.filter((c) => c.command === "python3");
	return { ...sp, clock, lines, notifier, helperCalls };
}

const tick = () => new Promise((r) => setImmediate(r));

const BASE = { key: "job:j_1", summary: "Captcha on example.com", body: "Job j_1 needs you", urgency: /** @type {const} */ ("critical"), sound: false };

test("helper path: posted, action with token, closed", async () => {
	const t = setup();
	const h = t.notifier.post({ ...BASE, actions: [{ key: "open", label: "Open" }] });
	/** @type {Array<[string, string | null]>} */
	const actions = [];
	/** @type {number[]} */
	const closed = [];
	h.onAction((k, info) => actions.push([k, info.activationToken]));
	h.onClosed((r) => closed.push(r));
	const [call] = t.helperCalls();
	assert.ok(call);
	assert.deepEqual(call.args, [
		"/h/notify_helper.py",
		"--summary=Captcha on example.com",
		"--body=Job j_1 needs you",
		"--urgency=critical",
		"--timeout-ms=0",
		"--max-wait-s=3600",
		"--app-name=Browser Gateway",
		"--action=open=Open",
	]);
	assert.equal(h.clickable, true);
	call.child.line({ event: "posted", id: 7 });
	call.child.line({ event: "activation_token", token: "xdg-tok" });
	call.child.line({ event: "action", key: "open" });
	call.child.line({ event: "closed", reason: 2 });
	call.child.line({ event: "exit", why: "action" });
	call.child.exit(0);
	const res = await h.done;
	assert.equal(h.id, 7);
	assert.deepEqual(actions, [["open", "xdg-tok"]]);
	assert.deepEqual(closed, [2]);
	assert.deepEqual(res, { why: "action", id: 7, clickable: true });
});

test("lines split across chunks and split multibyte characters are reassembled", async () => {
	const t = setup();
	const h = t.notifier.post(BASE);
	const c = t.helperCalls()[0]?.child;
	assert.ok(c);
	const whole = Buffer.from(JSON.stringify({ event: "posted", id: 9, note: "\u00e9" }) + "\n");
	const cut = whole.indexOf(0xc3) + 1;
	c.raw(whole.subarray(0, cut));
	c.raw(whole.subarray(cut, cut + 3));
	c.raw(whole.subarray(cut + 3));
	assert.equal(h.id, 9);
	c.exit(0);
	await h.done;
});

test("malformed, non-object and oversized lines are ignored, later lines still work", async () => {
	const t = setup();
	const h = t.notifier.post(BASE);
	const c = t.helperCalls()[0]?.child;
	assert.ok(c);
	c.raw("not json\n");
	c.raw("[1,2]\n");
	c.raw("null\n");
	c.raw('{"event":"posted","id":"7"}\n');
	c.raw('{"event":"posted","id":-1}\n');
	assert.equal(h.id, null);
	c.raw(JSON.stringify({ event: "action", key: "x".repeat(MAX_LINE_BYTES + 10) }) + "\n");
	// an endless line with no newline is dropped, and so is its tail
	c.raw("y".repeat(MAX_LINE_BYTES + 5));
	c.raw('tail-of-the-long-line"}\n');
	c.raw('{"event":"posted","id":11}\n');
	assert.equal(h.id, 11);
	assert.ok(t.lines.some((l) => l.event === "notify.helper_bad_line"));
	assert.ok(t.lines.some((l) => l.event === "notify.helper_line_too_long"));
	c.exit(0);
	await h.done;
});

test("action keys that are not plain tokens are not reported", async () => {
	const t = setup();
	const h = t.notifier.post(BASE);
	/** @type {string[]} */
	const got = [];
	h.onAction((k) => got.push(k));
	const c = t.helperCalls()[0]?.child;
	assert.ok(c);
	c.line({ event: "action", key: "a b; rm" });
	c.line({ event: "action", key: 5 });
	c.line({ event: "action", key: "default" });
	assert.deepEqual(got, ["default"]);
	c.exit(0);
	await h.done;
});

test("helper exit 2 before posting falls back to gdbus, no actions, clickable false", async () => {
	const t = setup();
	const h = t.notifier.post({ ...BASE, summary: "It's", body: "a\\b", actions: [{ key: "open", label: "Open" }] });
	t.helperCalls()[0]?.child.line({ event: "error", message: "PyGObject unavailable" });
	t.helperCalls()[0]?.child.exit(2);
	await tick();
	const g = t.calls.find((c) => c.command === "gdbus");
	assert.ok(g);
	assert.deepEqual(g.args, [
		"call", "--session",
		"--dest", "org.freedesktop.Notifications",
		"--object-path", "/org/freedesktop/Notifications",
		"--method", "org.freedesktop.Notifications.Notify",
		"'Browser Gateway'", "0", "''",
		"'It\\'s'", "'a\\\\b'", "[]",
		"{'urgency': <byte 2>}", "int32 0",
	]);
	assert.equal(h.clickable, false);
	g.child.stdout.emit("data", Buffer.from("(uint32 31,)\n"));
	g.child.exit(0);
	const res = await h.done;
	assert.deepEqual(res, { why: "fallback", id: 31, clickable: false });
	assert.equal(h.id, 31);
});

test("fallback id is reused as replaces id on the next post for the same key", async () => {
	const t = setup();
	t.failNext("throw");
	const h1 = t.notifier.post(BASE);
	await tick();
	const g1 = t.calls.find((c) => c.command === "gdbus");
	assert.ok(g1);
	g1.child.stdout.emit("data", "(uint32 55,)\n");
	g1.child.exit(0);
	await h1.done;
	t.failNext("throw");
	t.notifier.post(BASE);
	await tick();
	const g2 = t.calls.filter((c) => c.command === "gdbus")[1];
	assert.ok(g2);
	assert.equal(g2.args[9], "55");
});

test("spawn error event (python missing) also falls back", async () => {
	const t = setup();
	t.failNext(new Error("ENOENT"));
	const h = t.notifier.post(BASE);
	await new Promise((r) => setTimeout(r, 5));
	const g = t.calls.find((c) => c.command === "gdbus");
	assert.ok(g);
	// the child may still emit close after its error; that must not end the handle early
	t.helperCalls()[0]?.child.emit("close", -2, null);
	assert.equal(h.finished, false);
	g.child.stdout.emit("data", "(uint32 3,)");
	g.child.exit(0);
	assert.equal((await h.done).why, "fallback");
});

test("gdbus failing too ends the handle with why=error and does not throw", async () => {
	const t = setup();
	t.failNext("throw");
	t.failNext("throw");
	const h = t.notifier.post(BASE);
	const res = await h.done;
	assert.equal(res.why, "error");
	assert.equal(res.id, null);
	assert.ok(t.lines.some((l) => l.event === "notify.fallback_spawn_failed"));
});

test("gdbus exit non-zero ends with why=error", async () => {
	const t = setup();
	t.failNext("throw");
	const h = t.notifier.post(BASE);
	await tick();
	const g = t.calls.find((c) => c.command === "gdbus");
	g?.child.exit(1);
	assert.equal((await h.done).why, "error");
});

test("exit 2 after the helper already posted is not a fallback", async () => {
	const t = setup();
	const h = t.notifier.post(BASE);
	const c = t.helperCalls()[0]?.child;
	c?.line({ event: "posted", id: 5 });
	c?.exit(2);
	const res = await h.done;
	assert.equal(res.id, 5);
	assert.equal(t.calls.some((x) => x.command === "gdbus"), false);
});

test("posting the same key replaces: --replaces-id, old helper released, old callbacks silent", async () => {
	const t = setup();
	const h1 = t.notifier.post(BASE);
	let fired = 0;
	h1.onAction(() => fired++);
	const c1 = t.helperCalls()[0]?.child;
	assert.ok(c1);
	c1.line({ event: "posted", id: 100 });
	const h2 = t.notifier.post({ ...BASE, body: "Job j_1 still needs you" });
	await tick();
	assert.equal(c1.stdinEnded, true);
	assert.equal(t.helperCalls().length, 1, "the replacement starts when the replaced helper has gone");
	c1.line({ event: "action", key: "default" });
	assert.equal(fired, 0);
	c1.exit(0);
	assert.equal((await h1.done).why, "replaced");
	await tick();
	assert.equal(t.clock.pending, 0, "no kill timer is left for a helper that went by itself");
	const second = t.helperCalls()[1];
	assert.ok(second);
	assert.ok(second.args.includes("--replaces-id=100"));
	second.child.line({ event: "posted", id: 100 });
	assert.equal(h2.id, 100);
	second.child.exit(0);
	await h2.done;
});

test("a post for another key does not touch the first; a later post after its end does not need the old helper", async () => {
	const t = setup();
	const a = t.notifier.post({ ...BASE, key: "a" });
	t.helperCalls()[0]?.child.line({ event: "posted", id: 1 });
	t.notifier.post({ ...BASE, key: "b" });
	assert.equal(t.helperCalls()[0]?.child.stdinEnded, false);
	assert.ok(!t.helperCalls()[1]?.args.some((x) => x.startsWith("--replaces-id")));
	t.helperCalls()[0]?.child.exit(0);
	await a.done;
});

test("posts for a key that is not on screen yet coalesce into one", async () => {
	const t = setup({ hookCommand: ["/bin/hook"], existing: ["/snd/a.oga"] });
	const first = t.notifier.post({ ...BASE, sound: undefined, host: "example.com", jobId: "j_1" });
	const again = [1, 2, 3, 4, 5].map(() => t.notifier.post({ ...BASE, sound: undefined, host: "example.com", jobId: "j_1" }));
	await tick();
	assert.ok(again.every((h) => h === first), "the same handle, not a queue of replacements");
	assert.equal(t.helperCalls().length, 1, "one helper");
	assert.equal(t.calls.filter((c) => c.command === "pw-play").length, 1, "one sound");
	assert.equal(t.calls.filter((c) => c.command === "/bin/hook").length, 1, "one hook run");
	const c1 = t.helperCalls()[0]?.child;
	assert.ok(c1);
	c1.line({ event: "posted", id: 20 });
	// Once it is on screen, a post for the key is a replacement again.
	const next = t.notifier.post({ ...BASE, body: "still waiting" });
	assert.notEqual(next, first);
	c1.exit(0);
	await tick();
	assert.equal(t.helperCalls().length, 2);
	assert.ok(t.helperCalls()[1]?.args.includes("--replaces-id=20"));
});

test("an update for a key that is still on its way out is not lost: the newest waits, one at a time", async () => {
	const t = setup();
	const h1 = t.notifier.post({ ...BASE, body: "one" });
	// Three updates before the first is even on screen: only the last one matters.
	const h2 = t.notifier.post({ ...BASE, body: "two" });
	const h3 = t.notifier.post({ ...BASE, body: "three" });
	const h4 = t.notifier.post({ ...BASE, body: "four" });
	const again = t.notifier.post({ ...BASE, body: "four" });
	assert.equal(again, h4, "the same update again is the same post");
	assert.deepEqual([await h2.done, await h3.done], [{ why: "replaced", id: null, clickable: true }, { why: "replaced", id: null, clickable: true }]);
	await tick();
	assert.equal(t.helperCalls().length, 1, "nothing starts before the first one is on screen");
	const c1 = t.helperCalls()[0]?.child;
	assert.ok(c1);
	assert.equal(c1.stdinEnded, false, "and the first is not hurried off before its id is known");
	c1.line({ event: "posted", id: 30 });
	await tick();
	assert.equal(c1.stdinEnded, true);
	c1.exit(0);
	assert.equal((await h1.done).why, "replaced");
	await tick();
	assert.equal(t.helperCalls().length, 2);
	const second = t.helperCalls()[1];
	assert.ok(second?.args.includes("--body=four") && second.args.includes("--replaces-id=30"));
	second.child.line({ event: "posted", id: 30 });
	second.child.exit(0);
	assert.equal((await h4.done).id, 30);
	assert.equal(t.clock.pending, 0);
	// The line never grows: at most one helper and one waiting post per key, however many updates come.
	const u = setup({ maxPerMinute: 1000 });
	u.notifier.post({ ...BASE, body: "0" });
	const handles = Array.from({ length: 200 }, (_, i) => u.notifier.post({ ...BASE, body: `update ${i}` }));
	await tick();
	assert.equal(u.helperCalls().length, 1);
	assert.equal(handles.filter((h) => !h.finished).length, 1);
	// Other keys are not crowded out by them.
	u.notifier.post({ ...BASE, key: "job:j_2" });
	assert.equal(u.helperCalls().length, 2);
});

test("at most three helper processes live at once; a post that finds them all taken replaces the oldest", async () => {
	assert.equal(MAX_HELPERS, 3);
	const t = setup({ hookCommand: ["/bin/hook"], existing: ["/snd/a.oga"], maxPerMinute: 1000 });
	// The reported case: 500 posts, each for another job on another site.
	const handles = [];
	for (let i = 0; i < 500; i++) {
		handles.push(t.notifier.post({ ...BASE, key: `job:j_${i}`, sound: undefined, host: `site${i}.example`, jobId: `j_${i}` }));
	}
	await tick();
	assert.equal(t.helperCalls().length, 3, "helpers");
	// Three were posted, and each of the next three was given the place of one of those: it waits for it to go.
	assert.equal(t.calls.filter((c) => c.command === "pw-play").length, 6, "sounds");
	assert.equal(t.calls.filter((c) => c.command === "/bin/hook").length, 6, "hook runs");
	assert.equal(t.calls.length, 15, "nothing else was started");
	const refused = await Promise.all(handles.slice(6).map((h) => h.done));
	assert.ok(refused.every((r) => r.why === "busy" && r.id === null && r.clickable === false));
	assert.equal(t.lines.filter((l) => l.event === "notify.not_posted").length, 1, "one log line, not 494");
	// The three that were on their helpers were asked to close their notifications ...
	const first = t.helperCalls().map((c) => c.child);
	for (const child of first) assert.deepEqual(child.written, ['{"cmd":"close"}\n']);
	assert.equal(handles.slice(0, 6).every((h) => !h.finished), true);
	// ... and as each one goes, the post that took its place starts. Never four processes.
	first[0].exit(0);
	assert.equal((await handles[0].done).why, "replaced");
	await tick();
	assert.equal(t.helperCalls().length, 4);
	assert.ok(t.helperCalls()[3]?.args.includes("--summary=Captcha on example.com"));
	// One that does not go by itself is ended after the grace period.
	t.clock.advance(CLOSE_GRACE_MS);
	assert.deepEqual(first[1].signals, ["SIGTERM"]);
	assert.deepEqual(first[2].signals, ["SIGTERM"]);
	first[1].exit(null);
	first[2].exit(null);
	await tick();
	assert.equal(t.helperCalls().length, 6);
	assert.equal(handles.slice(3, 6).every((h) => !h.finished), true);

	// Replacing a notification that is on screen needs no extra room: the new
	// helper starts when the replaced one has gone, so there are never four.
	const ended = new Set(first);
	const alive = () => t.helperCalls().filter((c) => c.child.listenerCount("close") > 0 && !ended.has(c.child)).length;
	assert.equal(alive(), 3);
	const old = t.helperCalls()[4]?.child;
	assert.ok(old);
	old.line({ event: "posted", id: 2 });
	const replacement = t.notifier.post({ ...BASE, key: "job:j_4", body: "still waiting" });
	await tick();
	assert.equal(old.stdinEnded, true, "the replaced helper was asked to leave");
	assert.equal(t.helperCalls().length, 6, "and the next one waits for it");
	// It does not leave by itself: it is ended after the grace period.
	t.clock.advance(CLOSE_GRACE_MS);
	assert.deepEqual(old.signals, ["SIGTERM"]);
	old.exit(null);
	ended.add(old);
	await tick();
	assert.equal(t.helperCalls().length, 7);
	assert.ok(t.helperCalls()[6]?.args.includes("--replaces-id=2"));
	assert.equal(replacement.finished, false);
	assert.equal(alive(), 3);
});

test("three notifications nobody dismisses do not block the fourth: it takes the place of the oldest", async () => {
	const t = setup({ existing: ["/snd/a.oga"] });
	// Three challenges, minutes apart, none of them looked at.
	const old = [];
	for (let i = 0; i < 3; i++) {
		old.push(t.notifier.post({ ...BASE, key: `job:j_${i}`, host: `site${i}.example`, jobId: `j_${i}` }));
		t.helperCalls()[i]?.child.line({ event: "posted", id: 10 + i });
		t.clock.advance(120000);
	}
	let clicks = 0;
	old[0].onAction(() => clicks++);
	// Before the fix this one, and every other one for up to an hour, was dropped as "busy".
	const fourth = t.notifier.post({ ...BASE, key: "job:j_3", sound: undefined, host: "site3.example", jobId: "j_3" });
	assert.equal(fourth.finished, false, "accepted");
	assert.equal(t.calls.filter((c) => c.command === "pw-play").length, 1, "and it sounds");
	await tick();
	const oldest = t.helperCalls()[0]?.child;
	assert.ok(oldest);
	assert.deepEqual(oldest.written, ['{"cmd":"close"}\n'], "the oldest notification is closed");
	assert.deepEqual(t.helperCalls().slice(1, 3).map((c) => c.child.written), [[], []], "the other two are left alone");
	assert.equal(t.helperCalls().length, 3, "the new helper starts when the old one has gone");
	// A click that was already on its way is not reported for a notification that was given up.
	oldest.line({ event: "action", key: "open" });
	assert.equal(clicks, 0);
	oldest.line({ event: "closed", reason: 3 });
	oldest.exit(0);
	assert.deepEqual(await old[0].done, { why: "replaced", id: 10, clickable: true });
	await tick();
	assert.equal(t.helperCalls().length, 4);
	assert.ok(t.helperCalls()[3]?.args.includes("--summary=Captcha on example.com"));
	assert.ok(!t.helperCalls()[3]?.args.some((a) => a.startsWith("--replaces-id")), "a notification of its own, not an update of the closed one");
	t.helperCalls()[3]?.child.line({ event: "posted", id: 14 });
	assert.equal(fourth.id, 14);
	assert.ok(t.lines.some((l) => l.event === "notify.oldest_replaced" && l.fields?.key === "job:j_0"));
	assert.equal(t.lines.filter((l) => l.event === "notify.not_posted").length, 0);
	// The next one takes the place of what is now the oldest.
	t.clock.advance(120000);
	t.notifier.post({ ...BASE, key: "job:j_4", host: "site4.example", jobId: "j_4" });
	await tick();
	assert.deepEqual(t.helperCalls()[1]?.child.written, ['{"cmd":"close"}\n']);
	assert.deepEqual(t.helperCalls()[2]?.child.written, []);
});

test("a host name with an underscore is a host name: cooldown and the right-end rule apply", async () => {
	assert.ok(isValidHost("my_shop.example.com"));
	assert.ok(isValidHost("a_b.c_d.example"));
	const t = setup({ hookCommand: ["/bin/hook"], existing: ["/snd/a.oga"] });
	t.notifier.post({ ...BASE, key: "job:j_1", sound: undefined, host: "my_shop.example.com", jobId: "j_1" });
	// Before the fix the name failed the host pattern, and with it the site
	// rules were skipped: every one of these went out, with sound and hook.
	for (const host of ["my_shop.example.com", "other_shop.example.com", "example.com"]) {
		assert.equal((await t.notifier.post({ ...BASE, key: `job:${host}`, sound: undefined, host, jobId: "j_2" }).done).why, "cooldown", host);
	}
	assert.equal(t.helperCalls().length, 1);
	assert.equal(t.calls.filter((c) => c.command === "pw-play").length, 1);
	assert.deepEqual(t.calls.filter((c) => c.command === "/bin/hook").map((c) => c.args), [["my_shop.example.com", "j_1"]]);

	const spoof = "accounts.google.com.sign_in." + "x".repeat(40) + ".session_" + "y".repeat(60) + ".evil_site.example";
	assert.ok(spoof.length > 150 && isValidHost(spoof));
	const u = setup();
	u.notifier.post({ key: "job:j_1", summary: `Human check needed on ${spoof}`, body: `${spoof} is waiting for you.`, urgency: "critical", sound: false, host: spoof, jobId: "j_1" });
	const args = u.helperCalls()[0]?.args ?? [];
	assert.equal(args[1], "--summary=Human check needed on ...evil_site.example");
	assert.equal(args[2], "--body=...evil_site.example is waiting for you.");
	assert.ok(!args.join(" ").includes("google"));
});

test("a post for a host that is neither a plain host name nor an IPv6 address in brackets is not made at all", async () => {
	const t = setup({ hookCommand: ["/bin/hook"], existing: ["/snd/a.oga"] });
	const bad = ["example.com.", "exa mple.com", "example.com:8080", "_dmarc.example.com", "example.com_", "-oProxy", "a".repeat(254), "",
		// What looks like an address and is none, or is not written the way the URL parser writes one.
		"[2001:db8::1", "2001:db8::1", "[2001:db8::1]:8443", "[gggg::1]", "[fe80::1%eth0]", "[2001:DB8::1]", "[1.2.3.4]", "[]", "[::1]x", "[:]", "[2001:db8::1::2]", "[<b>::1]"];
	for (const [i, host] of bad.entries()) {
		const h = t.notifier.post({ ...BASE, key: `job:j_${i}`, sound: undefined, host, jobId: `j_${i}` });
		assert.deepEqual(await h.done, { why: "bad_host", id: null, clickable: false }, host);
		// Again at once: with the site rules skipped, nothing would hold these back.
		assert.equal((await t.notifier.post({ ...BASE, key: `job:j_${i}`, sound: undefined, host, jobId: `j_${i}` }).done).why, "bad_host");
	}
	assert.equal((await t.notifier.post({ ...BASE, key: "job:n", host: /** @type {any} */ (5) }).done).why, "bad_host");
	assert.equal((await t.notifier.post({ ...BASE, key: "job:n", host: /** @type {any} */ (null) }).done).why, "bad_host");
	assert.equal(t.calls.length, 0, "no helper, no sound, no hook");
	assert.equal(t.lines.filter((l) => l.event === "notify.not_posted").length, 1);
	// A post that names no host is something else: a notice of the daemon's own.
	assert.equal(t.notifier.post({ ...BASE, key: "daemon:notice" }).finished, false);
});

test("one notification per site and cooldown; subdomains are the same site", async () => {
	assert.equal(HOST_COOLDOWN_MS, 60000);
	const t = setup({ hookCommand: ["/bin/hook"], existing: ["/snd/a.oga"] });
	const first = t.notifier.post({ ...BASE, key: "job:j_1", sound: undefined, host: "a.shop.example", jobId: "j_1" });
	t.helperCalls()[0]?.child.line({ event: "posted", id: 5 });
	for (const [i, host] of ["a.shop.example", "b.shop.example", "shop.example", "x.y.z.shop.example"].entries()) {
		const h = t.notifier.post({ ...BASE, key: `job:j_c${i}`, sound: undefined, host, jobId: `j_c${i}` });
		assert.deepEqual(await h.done, { why: "cooldown", id: null, clickable: false }, host);
	}
	// Not even as a replacement of the notification that is on screen.
	assert.equal((await t.notifier.post({ ...BASE, key: "job:j_1", host: "a.shop.example", jobId: "j_1" }).done).why, "cooldown");
	assert.equal(t.helperCalls().length, 1);
	assert.equal(t.calls.filter((c) => c.command === "pw-play").length, 1);
	assert.equal(t.calls.filter((c) => c.command === "/bin/hook").length, 1);
	assert.equal(first.finished, false, "the first one is untouched");

	// Another site is not held back, and neither is a post that names no host.
	t.notifier.post({ ...BASE, key: "job:j_other", host: "other.example", jobId: "j_other" });
	t.notifier.post({ ...BASE, key: "daemon:notice" });
	assert.equal(t.helperCalls().length, 3);

	t.clock.advance(HOST_COOLDOWN_MS - 1);
	assert.equal((await t.notifier.post({ ...BASE, key: "job:j_late", host: "shop.example", jobId: "j_late" }).done).why, "cooldown");
	t.clock.advance(1);
	// (two of the three helpers have to end first: the cap still holds)
	t.helperCalls()[1]?.child.exit(0);
	t.helperCalls()[2]?.child.exit(0);
	await tick();
	const again = t.notifier.post({ ...BASE, key: "job:j_late", host: "b.shop.example", jobId: "j_late" });
	await tick();
	assert.equal(again.finished, false);
	assert.equal(t.helperCalls().length, 4);

	const custom = setup({ hostCooldownMs: 5000 });
	custom.notifier.post({ ...BASE, key: "a", host: "example.com", jobId: "j_1" });
	custom.clock.advance(5000);
	custom.notifier.post({ ...BASE, key: "b", host: "example.com", jobId: "j_2" });
	assert.equal(custom.helperCalls().length, 2);
});

test("a few notifications per minute in total, also when the helper cannot run", async () => {
	assert.equal(MAX_PER_MINUTE, 6);
	const t = setup({ hookCommand: ["/bin/hook"], existing: ["/snd/a.oga"] });
	// Without PyGObject every post falls back to a short-lived gdbus call, so
	// nothing stays alive that the helper cap could count.
	const results = [];
	for (let i = 0; i < 500; i++) {
		const h = t.notifier.post({ ...BASE, key: `job:j_${i}`, sound: undefined, host: `site${i}.example`, jobId: `j_${i}` });
		const helper = t.helperCalls()[i];
		if (helper !== undefined) {
			helper.child.exit(2);
			await tick();
			t.calls.filter((c) => c.command === "gdbus").at(-1)?.child.stdout.emit("data", Buffer.from(`(uint32 ${i + 1},)\n`));
			t.calls.filter((c) => c.command === "gdbus").at(-1)?.child.exit(0);
		}
		results.push(await h.done);
	}
	assert.deepEqual(results.slice(0, 6).map((r) => r.why), ["fallback", "fallback", "fallback", "fallback", "fallback", "fallback"]);
	assert.ok(results.slice(6).every((r) => r.why === "busy"));
	for (const command of ["python3", "gdbus", "pw-play", "/bin/hook"]) {
		assert.equal(t.calls.filter((c) => c.command === command).length, 6, command);
	}
	// The window moves on.
	t.clock.advance(60000);
	const later = t.notifier.post({ ...BASE, key: "job:j_later", host: "later.example", jobId: "j_later" });
	assert.equal(later.finished, false);
});

test("close() asks the helper over stdin, then SIGTERMs by pid after the grace period", async () => {
	const t = setup();
	const h = t.notifier.post(BASE);
	const c = t.helperCalls()[0]?.child;
	assert.ok(c);
	c.line({ event: "posted", id: 4 });
	const p = h.close();
	assert.deepEqual(c.written, ['{"cmd":"close"}\n']);
	assert.deepEqual(c.signals, []);
	t.clock.advance(CLOSE_GRACE_MS);
	assert.deepEqual(c.signals, ["SIGTERM"]);
	c.exit(0);
	assert.equal((await p).id, 4);
});

test("close() on a helper that exits promptly sends no signal", async () => {
	const t = setup();
	const h = t.notifier.post(BASE);
	const c = t.helperCalls()[0]?.child;
	assert.ok(c);
	const p = h.close();
	c.line({ event: "closed", reason: 3 });
	c.line({ event: "exit", why: "closed" });
	c.exit(0);
	assert.equal((await p).why, "closed");
	t.clock.advance(CLOSE_GRACE_MS * 2);
	assert.deepEqual(c.signals, []);
	assert.equal(t.clock.pending, 0);
});

test("closeAll closes only helper children, sound and hook children are left alone", async () => {
	const t = setup({ hookCommand: ["/bin/hook", "--flag"] });
	const a = t.notifier.post({ ...BASE, key: "a", host: "example.com", jobId: "j_a", sound: undefined });
	const b = t.notifier.post({ ...BASE, key: "b" });
	const [ca, cb] = t.helperCalls().map((x) => x.child);
	assert.ok(ca && cb);
	const p = t.notifier.closeAll();
	assert.deepEqual(ca.written, ['{"cmd":"close"}\n']);
	assert.deepEqual(cb.written, ['{"cmd":"close"}\n']);
	ca.exit(0);
	t.clock.advance(CLOSE_GRACE_MS);
	assert.deepEqual(ca.signals, []);
	assert.deepEqual(cb.signals, ["SIGTERM"]);
	cb.exit(null);
	await p;
	await Promise.all([a.done, b.done]);
	for (const c of t.calls.filter((x) => x.command !== "python3")) assert.deepEqual(c.child.signals, [], c.command);
});

test("closeAll ends a post that others were coalesced into, once", async () => {
	const t = setup();
	const h1 = t.notifier.post(BASE);
	const h2 = t.notifier.post(BASE);
	assert.equal(h2, h1);
	const p = t.notifier.closeAll();
	assert.deepEqual(t.helperCalls()[0]?.child.written, ['{"cmd":"close"}\n']);
	t.helperCalls()[0]?.child.exit(0);
	await p;
	assert.equal((await h2.done).why, "closed");
	assert.equal(t.helperCalls().length, 1);
});

test("the notifier can be set up without sound; a post that names a file still plays it", async () => {
	const t = setup({ sound: false, existing: ["/snd/a.oga", "/mine/ping.oga"] });
	t.notifier.post({ ...BASE, key: "a", sound: undefined });
	t.notifier.post({ ...BASE, key: "b", sound: true });
	assert.equal(t.calls.filter((c) => c.command === "pw-play").length, 0);
	t.notifier.post({ ...BASE, key: "c", sound: "/mine/ping.oga" });
	assert.deepEqual(t.calls.filter((c) => c.command === "pw-play").map((c) => c.args), [["/mine/ping.oga"]]);
	assert.equal(t.lines.filter((l) => l.event === "notify.sound_missing").length, 0);
});

test("sound: first existing candidate, pw-play argv array, false skips, missing is logged", async () => {
	const t = setup({ existing: ["/snd/b.oga"] });
	t.notifier.post({ ...BASE, sound: undefined });
	const s = t.calls.find((c) => c.command === "pw-play");
	assert.deepEqual(s?.args, ["/snd/b.oga"]);
	assert.equal(s?.options.shell, false);
	const n = t.calls.length;
	t.notifier.post({ ...BASE, key: "x", sound: false });
	assert.equal(t.calls.filter((c) => c.command === "pw-play").length, 1);
	assert.equal(t.calls.length, n + 1); // only the helper

	const none = setup({ existing: [] });
	none.notifier.post({ ...BASE, sound: undefined });
	assert.equal(none.calls.some((c) => c.command === "pw-play"), false);
	assert.ok(none.lines.some((l) => l.event === "notify.sound_missing"));
	assert.equal(none.helperCalls().length, 1, "notification still posted");
});

test("sound: configured file wins, a missing configured file falls back, spawn failures are ignored", async () => {
	const t = setup({ soundFile: "/cfg/x.oga", existing: ["/cfg/x.oga", "/snd/a.oga"] });
	t.notifier.post({ ...BASE, sound: undefined });
	assert.deepEqual(t.calls.find((c) => c.command === "pw-play")?.args, ["/cfg/x.oga"]);

	const gone = setup({ soundFile: "/cfg/gone.oga", existing: ["/snd/a.oga"] });
	gone.notifier.post({ ...BASE, sound: undefined });
	assert.deepEqual(gone.calls.find((c) => c.command === "pw-play")?.args, ["/snd/a.oga"]);

	const bad = setup({ existing: ["/snd/a.oga"] });
	bad.failNext("throw");
	const h = bad.notifier.post({ ...BASE, sound: undefined });
	assert.ok(bad.lines.some((l) => l.event === "notify.sound_failed"));
	assert.equal(bad.helperCalls().length, 1);
	bad.helperCalls()[0]?.child.exit(0);
	await h.done;

	const err = setup({ existing: ["/snd/a.oga"] });
	err.notifier.post({ ...BASE, sound: undefined });
	err.calls.find((c) => c.command === "pw-play")?.child.emit("error", new Error("ENOENT"));
	assert.ok(err.lines.some((l) => l.event === "notify.sound_failed"));
});

test("sound: a player that does not end is ended - SIGTERM at its limit, SIGKILL after the grace period", async () => {
	assert.ok(SOUND_TIMEOUT_MS >= 5000 && SOUND_TIMEOUT_MS <= 60000);
	const t = setup();
	t.notifier.post({ ...BASE, sound: undefined });
	const player = t.calls.find((c) => c.command === "pw-play");
	assert.ok(player);
	t.clock.advance(SOUND_TIMEOUT_MS - 1);
	assert.deepEqual(player.child.signals, []);
	t.clock.advance(1);
	assert.deepEqual(player.child.signals, ["SIGTERM"]);
	assert.deepEqual(t.lines.filter((l) => l.event === "notify.sound_timeout").map((l) => l.level), ["warn"]);
	t.clock.advance(CLOSE_GRACE_MS);
	assert.deepEqual(player.child.signals, ["SIGTERM", "SIGKILL"]);
	player.child.exit(null);
	t.clock.advance(10 * SOUND_TIMEOUT_MS);
	assert.deepEqual(player.child.signals, ["SIGTERM", "SIGKILL"]);

	// The ordinary case: the sound ends by itself, and nothing waits for it any more.
	const u = setup();
	u.notifier.post({ ...BASE, sound: undefined });
	const done = u.calls.find((c) => c.command === "pw-play");
	assert.ok(done);
	assert.equal(u.clock.pending, 1);
	u.clock.advance(1200);
	done.child.exit(0);
	assert.equal(u.clock.pending, 0);
	u.clock.advance(10 * SOUND_TIMEOUT_MS);
	assert.deepEqual(done.child.signals, []);
	// One that could not be started at all: the same.
	const f = setup();
	f.failNext(new Error("ENOENT"));
	f.notifier.post({ ...BASE, sound: undefined });
	await tick();
	// The helper is the first spawn here and takes the failure; the player's own failure is the next test's.
	const failing = setup();
	failing.notifier.post({ ...BASE, sound: undefined });
	failing.calls.find((c) => c.command === "pw-play")?.child.emit("error", new Error("ENOENT"));
	assert.equal(failing.clock.pending, 0);
	// A player that ends after SIGTERM is not killed.
	const v = setup();
	v.notifier.post({ ...BASE, sound: undefined });
	const slow = v.calls.find((c) => c.command === "pw-play");
	assert.ok(slow);
	v.clock.advance(SOUND_TIMEOUT_MS);
	slow.child.exit(null);
	v.clock.advance(CLOSE_GRACE_MS);
	assert.deepEqual(slow.child.signals, ["SIGTERM"]);
});

test("an IPv6 address is a host like any other: shown as it is, its /64 is the site, and the hook gets it as one argument", async () => {
	const t = setup({ hookCommand: ["/bin/hook"] });
	const h = t.notifier.post({ key: "job:j_1", summary: "Human check needed on [2001:db8:1:2::9]", body: "[2001:db8:1:2::9] is waiting for you.", urgency: "critical", sound: false, host: "[2001:db8:1:2::9]", jobId: "j_1" });
	assert.equal(h.finished, false);
	const args = t.helperCalls()[0]?.args ?? [];
	assert.equal(args[1], "--summary=Human check needed on [2001:db8:1:2::9]");
	assert.equal(args[2], "--body=[2001:db8:1:2::9] is waiting for you.");
	assert.deepEqual(t.calls.find((c) => c.command === "/bin/hook")?.args, ["[2001:db8:1:2::9]", "j_1"]);
	// Another address of the same network within the cooldown: the same site, not notified again.
	assert.equal((await t.notifier.post({ ...BASE, key: "job:j_2", host: "[2001:db8:1:2:ffff::1]", jobId: "j_2" }).done).why, "cooldown");
	// Another network is another site.
	assert.equal(t.notifier.post({ ...BASE, key: "job:j_3", host: "[2001:db8:1:3::9]", jobId: "j_3" }).finished, false);
	assert.equal(t.helperCalls().length, 2);
});

test("forget: the id of a notification is kept for replacing it, and no longer than its key is in use", async () => {
	const t = setup({ hostCooldownMs: 0, maxPerMinute: 100 });
	const first = t.notifier.post({ ...BASE, key: "challenge:j_1" });
	t.helperCalls()[0].child.line({ event: "posted", id: 41 });
	t.helperCalls()[0].child.exit(0);
	await first.done;
	await tick();
	// As long as the key is in use, the next post replaces what is on screen.
	const second = t.notifier.post({ ...BASE, key: "challenge:j_1", body: "again" });
	assert.ok(t.helperCalls()[1].args.includes("--replaces-id=41"));
	t.helperCalls()[1].child.line({ event: "posted", id: 41 });
	t.helperCalls()[1].child.exit(0);
	await second.done;
	await tick();
	t.notifier.forget("challenge:j_1");
	t.notifier.post({ ...BASE, key: "challenge:j_1", body: "a new one" });
	assert.ok(!t.helperCalls()[2].args.some((a) => a.startsWith("--replaces-id")), "nothing is remembered of a key that is over");

	// Forgotten while its notification is still on the way to the screen: the id that arrives later is dropped as well.
	const u = setup({ hostCooldownMs: 0, maxPerMinute: 100 });
	const late = u.notifier.post({ ...BASE, key: "challenge:j_2" });
	u.notifier.forget("challenge:j_2");
	u.helperCalls()[0].child.line({ event: "posted", id: 77 });
	u.helperCalls()[0].child.exit(0);
	await late.done;
	await tick();
	u.notifier.post({ ...BASE, key: "challenge:j_2", body: "a new one" });
	assert.ok(!u.helperCalls()[1].args.some((a) => a.startsWith("--replaces-id")));
	// The same when the helper could not run and the plain call posted it.
	const w = setup({ hostCooldownMs: 0, maxPerMinute: 100 });
	const plain = w.notifier.post({ ...BASE, key: "challenge:j_3" });
	w.notifier.forget("challenge:j_3");
	w.helperCalls()[0].child.exit(2);
	await tick();
	const gdbus = w.calls.find((c) => c.command === "gdbus");
	assert.ok(gdbus);
	gdbus.child.stdout.emit("data", Buffer.from("(uint32 55,)\n"));
	gdbus.child.exit(0);
	assert.equal((await plain.done).id, 55);
	await tick();
	w.notifier.post({ ...BASE, key: "challenge:j_3", body: "a new one" });
	assert.ok(!w.helperCalls()[1].args.some((a) => a.startsWith("--replaces-id")));
	// A key that was posted again after it was forgotten is in use: its id stays.
	const x = setup({ hostCooldownMs: 0, maxPerMinute: 100 });
	const old = x.notifier.post({ ...BASE, key: "k" });
	x.notifier.forget("k");
	x.helperCalls()[0].child.line({ event: "posted", id: 5 });
	const newer = x.notifier.post({ ...BASE, key: "k", body: "newer" });
	x.helperCalls()[0].child.exit(0);
	await old.done;
	await tick();
	assert.ok(x.helperCalls()[1].args.includes("--replaces-id=5"));
	x.helperCalls()[1].child.line({ event: "posted", id: 5 });
	x.helperCalls()[1].child.exit(0);
	await newer.done;
	await tick();
	x.notifier.post({ ...BASE, key: "k", body: "newest" });
	assert.ok(x.helperCalls()[2].args.includes("--replaces-id=5"));
	// Forgetting what was never posted, or twice, is nothing.
	x.notifier.forget("never");
	x.notifier.forget("never");
});

test("hook: argv is the configured array plus host and job id, nothing else", async () => {
	const t = setup({ hookCommand: ["/usr/bin/ntfy-hook", "--topic", "bgw"] });
	t.notifier.post({ ...BASE, host: "www.example.com", jobId: "j_AbC-9_x" });
	const hook = t.calls.find((c) => c.command === "/usr/bin/ntfy-hook");
	assert.deepEqual(hook?.args, ["--topic", "bgw", "www.example.com", "j_AbC-9_x"]);
	assert.deepEqual(hook?.options.stdio, "ignore");
	assert.equal(hook?.options.shell, false);
	hook?.child.exit(0);
	assert.equal(t.clock.pending, 0, "hook timer cleared when the hook ends");
});

test("hook: bad host or job id is rejected, nothing runs; absent host/job skips; none configured skips", async () => {
	// The posting limits are out of the way here: this is about what reaches the hook's argv.
	const t = setup({ hookCommand: ["/bin/hook"], maxHelpers: 100, maxPerMinute: 100, hostCooldownMs: 0 });
	for (const [host, jobId] of [
		["example.com; rm -rf /", "j_1"],
		["$(id).example.com", "j_1"],
		["exa mple.com", "j_1"],
		["-oProxy", "j_1"],
		["a".repeat(300), "j_1"],
		["example.com", "j_1\n"],
		["example.com", "j 1"],
		["example.com", "../etc"],
		["example.com", ""],
		["", "j_1"],
		["example.com", "j".repeat(65)],
		// An id that would read as an option of the hook program (the reported case).
		["example.com", "--help"],
		["example.com", "-v"],
		["example.com", "--topic=attacker"],
		["example.com", "j_"],
		["example.com", "J_1"],
		["example.com", "job_1"],
		["example.com", "j_" + "x".repeat(65)],
	]) {
		t.notifier.post({ ...BASE, key: host + jobId, host, jobId });
	}
	t.notifier.post({ ...BASE, key: "nohost" });
	assert.equal(t.calls.filter((c) => c.command === "/bin/hook").length, 0);
	// A host that is no host name gets no post at all (six of the cases); the
	// others are posted, with the hook left out.
	assert.equal(t.helperCalls().length, 13);
	assert.equal(t.lines.filter((l) => l.event === "notify.hook_rejected").length, 13);
	assert.ok(!t.calls.some((c) => c.args.includes("--help") || c.args.includes("-v")), "no id reached any argv");

	const nohook = setup();
	nohook.notifier.post({ ...BASE, host: "example.com", jobId: "j_1" });
	assert.equal(nohook.calls.length, 1);
});

test("hook: 10 s timeout kills it; spawn failure is logged and the notification still goes out", async () => {
	const t = setup({ hookCommand: ["/bin/hook"] });
	t.notifier.post({ ...BASE, host: "example.com", jobId: "j_1" });
	const hook = t.calls.find((c) => c.command === "/bin/hook");
	assert.ok(hook);
	t.clock.advance(HOOK_TIMEOUT_MS - 1);
	assert.deepEqual(hook.child.signals, []);
	t.clock.advance(1);
	assert.deepEqual(hook.child.signals, ["SIGTERM"]);
	assert.ok(t.lines.some((l) => l.event === "notify.hook_timeout"));
	// A hook that does not go on SIGTERM is not left behind: killed after the grace period.
	t.clock.advance(CLOSE_GRACE_MS - 1);
	assert.deepEqual(hook.child.signals, ["SIGTERM"]);
	t.clock.advance(1);
	assert.deepEqual(hook.child.signals, ["SIGTERM", "SIGKILL"]);
	hook.child.exit(null);
	t.clock.advance(60000);
	assert.deepEqual(hook.child.signals, ["SIGTERM", "SIGKILL"], "and that is the end of it");
	assert.equal(t.lines.filter((l) => l.event === "notify.hook_timeout").length, 1);

	// One that goes when asked is not signalled again.
	const g = setup({ hookCommand: ["/bin/hook"] });
	g.notifier.post({ ...BASE, host: "example.com", jobId: "j_1" });
	const polite = g.calls.find((c) => c.command === "/bin/hook");
	assert.ok(polite);
	g.clock.advance(HOOK_TIMEOUT_MS);
	polite.child.exit(null);
	assert.equal(g.clock.pending, 0, "no kill is waiting for a hook that has ended");
	g.clock.advance(CLOSE_GRACE_MS);
	assert.deepEqual(polite.child.signals, ["SIGTERM"]);

	const f = setup({ hookCommand: ["/bin/hook"] });
	f.failNext("throw");
	f.notifier.post({ ...BASE, host: "example.com", jobId: "j_1" });
	assert.ok(f.lines.some((l) => l.event === "notify.hook_failed"));
	assert.equal(f.helperCalls().length, 1);
});

test("hookCommand must be an argv array of non-empty strings", () => {
	const { log } = makeLog();
	const base = { log, clock: new FakeClock(), helperPath: "/h" };
	assert.throws(() => createNotifier({ ...base, hookCommand: /** @type {any} */ ("notify-send hi") }), TypeError);
	assert.throws(() => createNotifier({ ...base, hookCommand: [] }), TypeError);
	assert.throws(() => createNotifier({ ...base, hookCommand: ["a", ""] }), TypeError);
	assert.doesNotThrow(() => createNotifier({ ...base, hookCommand: null }));
});

test("no spawn uses a shell and hostile text stays inside single argv elements", async () => {
	const t = setup({ hookCommand: ["/bin/hook"], existing: ["/snd/a.oga"] });
	const evil = "x'; rm -rf / #$(id)`id`<b>&amp;\u0007\n";
	const h = t.notifier.post({
		key: "evil",
		summary: evil,
		body: evil,
		urgency: "critical",
		actions: [{ key: "open", label: evil }],
		host: "example.com",
		jobId: "j_1",
	});
	t.helperCalls()[0]?.child.exit(2);
	await tick();
	assert.ok(t.calls.length >= 4);
	for (const c of t.calls) {
		assert.ok(["python3", "gdbus", "pw-play", "/bin/hook"].includes(c.command), c.command);
		assert.ok(Array.isArray(c.args));
		assert.ok(!c.options.shell, "shell must not be enabled for " + c.command);
		for (const a of c.args) assert.equal(typeof a, "string");
		for (const a of c.args.filter((x) => !x.startsWith("{'urgency'"))) assert.ok(!/[<>&\u0007\n]/.test(a), "markup or control char in " + c.command + ": " + a);
	}
	const helper = t.helperCalls()[0];
	assert.equal(helper?.args[1], "--summary=x'; rm -rf / #$(id)`id`bamp;");
	assert.equal(helper?.args.length, 8);
	t.calls.find((c) => c.command === "gdbus")?.child.exit(1);
	await h.done;
});

test("safeText strips markup and control characters, collapses space, caps length", () => {
	assert.equal(safeText("<b>Hi</b> & \u0000bye\u001b[31m\r\n x"), "bHi/b bye [31m x");
	assert.equal(safeText("a\u202eb\u200bc\u2028d"), "a b c d");
	assert.equal(safeText(42), "");
	assert.equal(safeText(null), "");
	assert.equal(safeText("x".repeat(500)).length, 200);
	assert.ok(safeText("x".repeat(500)).endsWith("..."));
	assert.equal(safeText("x".repeat(20), 10), "xxxxxxx...");
	assert.equal(safeText("  plain text  "), "plain text");
});

test("isValidHost and isValidJobId are strict", () => {
	for (const h of ["example.com", "a.b-c.example.co.uk", "localhost", "127.0.0.1", "xn--e1afmkfd.xn--p1ai"]) assert.ok(isValidHost(h), h);
	// An IPv6 address as the URL parser writes a host: brackets, lower case.
	for (const h of ["[::1]", "[2001:db8::1]", "[2606:4700:4700::1111]", "[::ffff:102:304]", "[2001:db8:1:2:3:4:5:6]"]) assert.ok(isValidHost(h), h);
	for (const h of ["", "-a.com", "a.com-", "a b", "a.com/x", "a.com:80", "a;b", "a\nb", 5, null, "a".repeat(254), "_a.com", "a.com_", "a.com."]) assert.ok(!isValidHost(h), String(h));
	for (const h of ["::1", "[::1", "::1]", "[::1]:80", "[::1] ", "[2001:DB8::1]", "[fe80::1%eth0]", "[fe80::1%25eth0]", "[1.2.3.4]", "[example.com]", "[]", "[:]", "[:::]", "[1::2::3]", "[12345::1]", "[--help]", "[2001:db8::1]\n", `[${"1:".repeat(30)}1]`]) assert.ok(!isValidHost(h), h);
	for (const j of ["j_abc", "j_AbC-9_x", "j_0", "j_--help", "j_" + "x".repeat(64)]) assert.ok(isValidJobId(j), j);
	for (const j of ["", "j 1", "j_1\n", "j/1", "j".repeat(65), 1, undefined, "A", "--help", "-h", "j_", "j", "J_1", "_j_1", "j_" + "x".repeat(65), "j_a b", "j_a/b", "j_a=b"]) {
		assert.ok(!isValidJobId(j), String(j));
	}
});

test("a long host name is shown by its right end, never cut before the site", () => {
	assert.equal(displayHost("example.com"), "example.com");
	assert.equal(displayHost("a".repeat(60) + ".com"), "a".repeat(60) + ".com");
	const spoof = "accounts.google.com.signin." + "x".repeat(40) + ".session." + "y".repeat(60) + ".evil-site.example";
	assert.ok(spoof.length > 150 && isValidHost(spoof));
	const shown = displayHost(spoof);
	assert.equal(shown, "...evil-site.example", "the part the attacker chose freely is what goes");
	assert.equal(displayHost("a.b.c.example.com", 14), "...example.com");
	assert.equal(displayHost("a.b.c.example.com", 16), "...c.example.com");
	assert.equal(displayHost("x".repeat(100), 10), "..." + "x".repeat(7));

	// In a notification: the text names the host, and what the operator reads ends with the site.
	const t = setup();
	t.notifier.post({ key: "job:j_1", summary: `Human check needed on ${spoof}`, body: `${spoof} is waiting for you (job j_1).`, urgency: "critical", sound: false, host: spoof, jobId: "j_1" });
	const args = t.helperCalls()[0]?.args ?? [];
	assert.equal(args[1], `--summary=Human check needed on ${shown}`);
	assert.equal(args[2], `--body=${shown} is waiting for you (job j_1).`);
	assert.ok(!args.join(" ").includes("google"));
	// Before the fix the 200-character cut fell inside the name and the site was lost.
	assert.ok(safeText(`Human check needed on ${"z".repeat(40)}.${spoof}`).endsWith("..."));
});

test("post validates its input before spawning anything", () => {
	const t = setup();
	assert.throws(() => t.notifier.post({ ...BASE, key: "" }), TypeError);
	assert.throws(() => t.notifier.post({ ...BASE, summary: "<>" }), TypeError);
	assert.throws(() => t.notifier.post({ ...BASE, urgency: /** @type {any} */ ("loud") }), TypeError);
	assert.throws(() => t.notifier.post({ ...BASE, actions: [{ key: "a b", label: "x" }] }), TypeError);
	assert.throws(() => t.notifier.post({ ...BASE, actions: [{ key: "ok", label: "" }] }), TypeError);
	assert.throws(() => t.notifier.post({ ...BASE, timeoutMs: -1 }), TypeError);
	assert.equal(t.calls.length, 0);
});

test("non-critical default timeout is finite, critical is sticky", () => {
	const t = setup();
	t.notifier.post({ ...BASE, key: "n", urgency: "normal" });
	t.notifier.post({ ...BASE, key: "c", urgency: "critical" });
	assert.ok(t.helperCalls()[0]?.args.includes("--timeout-ms=10000"));
	assert.ok(t.helperCalls()[1]?.args.includes("--timeout-ms=0"));
});
