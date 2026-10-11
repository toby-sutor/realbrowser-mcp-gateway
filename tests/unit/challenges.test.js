// The operator's desktop notification for a page that waits for them: when it
// is posted, repeated, replaced and closed. The helper process is a stand-in
// and the clock is moved by hand - nothing is shown, nothing sounds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CHALLENGE_SUMMARY, challengeBody, createChallengeNotifier } from "../../daemon/src/challenges.js";
import { CLOSE_GRACE_MS, createNotifier } from "../../daemon/src/notify.js";
import { LIMITS } from "../../daemon/src/config.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { makeSpawn } from "../helpers/fake-spawn.js";

const tick = () => new Promise((r) => setImmediate(r));
const HELPER = "/h/notify_helper.py";
const SOUND = "/snd/alert.oga";

/** @param {{ hookCommand?: string[], repeatMs?: number, delayMs?: number, attention?: (job: string) => boolean }} [opts] asked: every "focus" the extension was asked for; reminded: every "renotify" */
function setup(opts = {}) {
	const sp = makeSpawn();
	const clock = new FakeClock();
	/** @type {{ level: string, event: string, fields: Record<string, unknown> | undefined }[]} */
	const lines = [];
	const at = (/** @type {string} */ level) => (/** @type {string} */ event, /** @type {import("../../daemon/src/log.js").LogFields | undefined} */ fields) => void lines.push({ level, event, fields });
	const log = { info: at("info"), warn: at("warn"), error: at("error") };
	const notifier = createNotifier({ log, clock, spawn: sp.spawn, helperPath: HELPER, fileExists: (f) => f === SOUND, soundCandidates: [SOUND], hookCommand: opts.hookCommand ?? null });
	/** @type {string[]} */
	const asked = [];
	/** @type {string[]} */
	const reminded = [];
	const challenges = createChallengeNotifier({
		notifier,
		clock,
		log,
		attention: (job, action) => {
			(action === "focus" ? asked : reminded).push(job);
			return opts.attention === undefined ? true : opts.attention(job);
		},
		...(opts.repeatMs === undefined ? {} : { repeatMs: opts.repeatMs }),
		...(opts.delayMs === undefined ? {} : { delayMs: opts.delayMs }),
	});
	const helpers = () => sp.calls.filter((c) => c.command === "python3");
	const sounds = () => sp.calls.filter((c) => c.command === "pw-play");
	const hooks = () => sp.calls.filter((c) => c.command === "/bin/hook");
	/** The helper that was started last reports its notification as shown. @param {number} id */
	const posted = (id) => helpers().at(-1)?.child.line({ event: "posted", id });
	return { ...sp, clock, lines, notifier, challenges, asked, reminded, helpers, sounds, hooks, posted };
}

/** @param {import("../helpers/fake-spawn.js").Call | undefined} call @param {string} name */
const arg = (call, name) => call?.args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

test("pending: one critical notification with an Open action and a sound; fixed words and the host, nothing else", async () => {
	const t = setup();
	t.challenges.pending({ job: "j_abc123", host: "www.shop.example" });
	assert.equal(t.helpers().length, 1);
	const call = t.helpers()[0];
	assert.equal(call.args[0], HELPER);
	assert.equal(arg(call, "summary"), "Browser Gateway: a page needs you");
	assert.equal(arg(call, "summary"), CHALLENGE_SUMMARY);
	assert.equal(arg(call, "body"), "www.shop.example shows a human check. Open it to continue; the gateway reads the page once the check is passed.");
	assert.equal(arg(call, "urgency"), "critical");
	assert.equal(arg(call, "timeout-ms"), "0", "it stays until dismissed");
	assert.deepEqual(call.args.filter((a) => a.startsWith("--action=")), ["--action=open=Open"]);
	assert.equal(call.options.shell, false);
	assert.deepEqual(t.sounds().map((c) => c.args), [[SOUND]]);
	assert.equal(t.calls.length, 2, "the helper and the sound, nothing else");
	assert.equal(t.challenges.size, 1);
	// Told twice about the same job: still one.
	t.challenges.pending({ job: "j_abc123", host: "www.shop.example" });
	assert.equal(t.helpers().length, 1);
});

test("the text names the host and nothing a page could have written", () => {
	assert.equal(challengeBody("example.com"), "example.com shows a human check. Open it to continue; the gateway reads the page once the check is passed.");
	const t = setup();
	// A long name is shown by its right end: the part that names the site.
	const spoof = "accounts.google.com.signin." + "x".repeat(40) + ".session." + "y".repeat(60) + ".evil-site.example";
	t.challenges.pending({ job: "j_1", host: spoof });
	assert.equal(arg(t.helpers()[0], "body"), "...evil-site.example shows a human check. Open it to continue; the gateway reads the page once the check is passed.");
	assert.ok(!t.helpers()[0].args.join(" ").includes("google"));
	// The URL parser keeps capitals out and a trailing dot in: shown as a plain name.
	t.clock.advance(60000);
	t.challenges.pending({ job: "j_2", host: "Docs.Example.ORG." });
	assert.match(String(arg(t.helpers()[1], "body")), /^docs\.example\.org shows a human check\./);
	// What is no host name gets no notification at all: no text could be made for it that is known to be safe.
	for (const [i, host] of ["[2001:db8::1", "exa mple.com", "<b>bold</b>.example", "example.com\nBODY", "", "-oProxy"].entries()) {
		t.clock.advance(60000);
		t.challenges.pending({ job: `j_bad${i}`, host });
	}
	t.challenges.pending({ job: "--help", host: "example.com" });
	assert.equal(t.helpers().length, 2);
	assert.equal(t.challenges.size, 2);
	assert.equal(t.lines.filter((l) => l.event === "challenge.not_notified").length, 7);
});

test("a page on an IPv6 address is notified like any other: the address is shown as the browser writes it", async () => {
	const t = setup({ hookCommand: ["/bin/hook"] });
	t.challenges.pending({ job: "j_v6", host: "[2001:DB8:1:2::9]" });
	assert.equal(t.helpers().length, 1);
	assert.equal(arg(t.helpers()[0], "body"), "[2001:db8:1:2::9] shows a human check. Open it to continue; the gateway reads the page once the check is passed.");
	assert.deepEqual(t.hooks().map((c) => c.args), [["[2001:db8:1:2::9]", "j_v6"]]);
	assert.equal(t.lines.filter((l) => l.event === "challenge.not_notified").length, 0);
	assert.equal(t.challenges.size, 1);
	for (const c of t.calls) for (const a of c.args) assert.ok(!/[<>&\n]/.test(a));
});

test("the hook hears of a challenge with the first notification that was posted for it, not with one that was not", async () => {
	const t = setup({ hookCommand: ["/bin/hook"] });
	// Two pages of one site wait: the second is parked a moment after the site was notified about, so its
	// first notification is not made.
	t.challenges.pending({ job: "j_1", host: "www.shop.example" });
	t.posted(41);
	t.clock.advance(5000);
	t.challenges.pending({ job: "j_2", host: "forum.shop.example" });
	assert.equal(t.helpers().length, 1, "one notification per site and minute");
	assert.deepEqual(t.hooks().map((c) => c.args), [["www.shop.example", "j_1"]]);
	assert.deepEqual(t.reminded, ["j_1", "j_2"]);
	// The first page is over; the second still waits. Its next notification is the first one made for it.
	t.challenges.ended({ job: "j_1", host: "www.shop.example" });
	t.helpers()[0].child.exit(0);
	await tick();
	t.clock.advance(120000);
	await tick();
	assert.equal(t.helpers().length, 2);
	assert.ok(String(arg(t.helpers()[1], "body")).startsWith("forum.shop.example shows a human check."));
	assert.deepEqual(t.hooks().map((c) => c.args), [["www.shop.example", "j_1"], ["forum.shop.example", "j_2"]], "the hook runs with it");
	t.posted(42);
	// And once: the repeats that follow do not run it again.
	for (let i = 0; i < 2; i++) {
		t.clock.advance(120000);
		await tick();
		t.helpers().at(-1)?.child.exit(0);
		await tick();
		t.posted(42);
	}
	assert.equal(t.helpers().length, 4);
	assert.equal(t.hooks().length, 2);
});

test("ended: what the notifier remembered of the job is dropped with it", async () => {
	const t = setup();
	t.challenges.pending({ job: "j_1", host: "shop.example" });
	t.posted(41);
	t.challenges.ended({ job: "j_1", host: "shop.example" });
	t.helpers()[0].child.exit(0);
	await tick();
	// Seen from outside: a post under the job's key replaces nothing any more.
	t.clock.advance(120000);
	t.notifier.post({ key: "challenge:j_1", summary: "x", sound: false });
	assert.ok(!t.helpers()[1].args.some((a) => a.startsWith("--replaces-id")));
	// A job that ended before its notification was on screen: the same, once the helper has reported and gone.
	const u = setup();
	u.challenges.pending({ job: "j_2", host: "shop.example" });
	u.challenges.ended({ job: "j_2", host: "shop.example" });
	u.posted(42);
	u.helpers()[0].child.exit(0);
	await tick();
	u.clock.advance(120000);
	u.notifier.post({ key: "challenge:j_2", summary: "x", sound: false });
	assert.ok(!u.helpers()[1].args.some((a) => a.startsWith("--replaces-id")));
});

test("repeat: every two minutes, replacing itself, until the operator has the page", async () => {
	assert.equal(LIMITS.challengeRepeatMs, 120000);
	const t = setup({ hookCommand: ["/bin/hook"] });
	t.challenges.pending({ job: "j_1", host: "shop.example" });
	t.posted(41);
	assert.deepEqual(t.hooks().map((c) => c.args), [["shop.example", "j_1"]], "the hook hears of it");
	t.clock.advance(119999);
	await tick();
	assert.equal(t.helpers().length, 1);
	t.clock.advance(1);
	await tick();
	// The one on screen is asked to leave; its place is taken, not a second place.
	assert.equal(t.helpers()[0].child.stdinEnded, true);
	assert.equal(t.helpers().length, 1, "the new helper starts when the old one has gone");
	t.helpers()[0].child.exit(0);
	await tick();
	assert.equal(t.helpers().length, 2);
	assert.equal(arg(t.helpers()[1], "replaces-id"), "41", "the same notification, posted again");
	assert.equal(arg(t.helpers()[1], "summary"), CHALLENGE_SUMMARY);
	assert.equal(t.sounds().length, 2, "a repeat is meant to be noticed: it sounds again");
	assert.equal(t.hooks().length, 1, "the hook is not run again");
	assert.deepEqual(t.reminded, ["j_1", "j_1"], "the extension is asked to show its own notification with every post: it shows none by itself");
	assert.deepEqual(t.asked, [], "and never, by a repeat, for the page itself");
	t.posted(41);
	// And again, for as long as nobody comes.
	for (let i = 0; i < 3; i++) {
		t.clock.advance(120000);
		await tick();
		t.helpers().at(-1)?.child.exit(0);
		await tick();
		t.posted(41);
	}
	assert.equal(t.helpers().length, 5);
	assert.equal(t.reminded.length, 5);
	assert.ok(t.helpers().slice(1).every((c) => arg(c, "replaces-id") === "41"));
	assert.equal(t.helpers().filter((c) => !c.child.exited).length, 1, "never more than one at a time");

	// Acknowledged: no more repeats. What is on screen stays until the job is over.
	t.challenges.acked({ job: "j_1", host: "shop.example" });
	t.challenges.acked({ job: "j_1", host: "shop.example" });
	t.clock.advance(10 * 120000);
	await tick();
	assert.equal(t.helpers().length, 5);
	assert.equal(t.reminded.length, 5, "no more reminders of either kind");
	assert.equal(t.helpers()[4].child.exited, false);
	assert.deepEqual(t.helpers()[4].child.written, []);
	assert.equal(t.clock.pending, 0, "no timer is left");
});

test("delay: the first notification waits; a page that clears, or that the operator opens, before it notifies nobody", async () => {
	// Cleared by itself within the delay: no notification, no sound, no hook, nothing asked of the extension.
	const t = setup({ delayMs: 30000, hookCommand: ["/bin/hook"] });
	t.challenges.pending({ job: "j_1", host: "shop.example" });
	assert.equal(t.challenges.size, 1, "it is watched from the moment it is parked");
	assert.equal(t.calls.length, 0);
	t.clock.advance(29999);
	await tick();
	assert.equal(t.calls.length, 0);
	t.challenges.ended({ job: "j_1", host: "shop.example" });
	t.clock.advance(10 * 120000);
	await tick();
	assert.deepEqual([t.calls.length, t.reminded.length, t.asked.length, t.challenges.size, t.clock.pending], [0, 0, 0, 0, 0]);

	// Nobody came and nothing cleared: notified when the delay is over, with everything a notification has.
	const u = setup({ delayMs: 30000, hookCommand: ["/bin/hook"] });
	u.challenges.pending({ job: "j_2", host: "shop.example" });
	u.clock.advance(29999);
	await tick();
	assert.equal(u.helpers().length, 0);
	u.clock.advance(1);
	await tick();
	assert.equal(u.helpers().length, 1);
	assert.equal(arg(u.helpers()[0], "urgency"), "critical");
	assert.deepEqual([u.sounds().length, u.hooks().length], [1, 1]);
	assert.deepEqual(u.reminded, ["j_2"], "the extension shows its own notification now, not before");
	u.posted(5);
	// Repeats count from that first notification, every two minutes.
	u.clock.advance(119999);
	await tick();
	assert.equal(u.helpers()[0].child.stdinEnded, false);
	u.clock.advance(1);
	await tick();
	assert.equal(u.helpers()[0].child.stdinEnded, true, "the first repeat, two minutes after the first notification");
	u.helpers()[0].child.exit(0);
	await tick();
	assert.equal(u.helpers().length, 2);
	assert.deepEqual(u.reminded, ["j_2", "j_2"]);
	u.challenges.ended({ job: "j_2", host: "shop.example" });

	// The operator opened the page within the delay (bgw open, the toolbar popup): they have it, nothing to tell them.
	const v = setup({ delayMs: 30000 });
	v.challenges.pending({ job: "j_3", host: "shop.example" });
	v.clock.advance(5000);
	v.challenges.acked({ job: "j_3", host: "shop.example" });
	v.clock.advance(10 * 120000);
	await tick();
	assert.deepEqual([v.calls.length, v.reminded.length, v.clock.pending], [0, 0, 0]);
	assert.equal(v.challenges.size, 1, "still watched: its end is still to come");
	v.challenges.ended({ job: "j_3", host: "shop.example" });
	assert.equal(v.challenges.size, 0);

	// The extension saw the check gone and reads the page - which can take longer than the rest of the delay.
	// Nobody is called for a check that is gone, and a notification that is on screen is closed.
	const x = setup({ delayMs: 30000 });
	x.challenges.pending({ job: "j_5", host: "shop.example" });
	x.clock.advance(25000);
	x.challenges.cleared({ job: "j_5", host: "shop.example" });
	x.clock.advance(10 * 120000);
	await tick();
	assert.deepEqual([x.calls.length, x.reminded.length, x.clock.pending, x.challenges.size], [0, 0, 0, 1]);
	x.challenges.ended({ job: "j_5", host: "shop.example" });
	const y = setup({ delayMs: 30000 });
	y.challenges.pending({ job: "j_6", host: "shop.example" });
	y.clock.advance(30000);
	await tick();
	y.posted(9);
	y.challenges.cleared({ job: "j_6", host: "shop.example" });
	assert.deepEqual(y.helpers()[0].child.written, ['{"cmd":"close"}\n'], "what was on screen goes when the check is gone");
	y.clock.advance(10 * 120000);
	await tick();
	assert.equal(y.helpers().length, 1, "and nothing is posted again");
	y.challenges.cleared({ job: "j_unknown", host: "x.example" });
	y.challenges.ended({ job: "j_6", host: "shop.example" });
	assert.equal(y.clock.pending, 0);

	// The daemon stops within the delay: no timer fires into the shutdown.
	const w = setup({ delayMs: 30000 });
	w.challenges.pending({ job: "j_4", host: "shop.example" });
	w.challenges.closeAll();
	w.clock.advance(60000);
	await tick();
	assert.deepEqual([w.calls.length, w.clock.pending], [0, 0]);
});

test("ended: the notification is closed and nothing is repeated", async () => {
	const t = setup();
	t.challenges.pending({ job: "j_1", host: "shop.example" });
	t.posted(7);
	t.challenges.ended({ job: "j_1", host: "shop.example" });
	assert.deepEqual(t.helpers()[0].child.written, ['{"cmd":"close"}\n'], "the helper is asked to close it");
	assert.equal(t.challenges.size, 0);
	t.helpers()[0].child.line({ event: "closed", reason: 3 });
	t.helpers()[0].child.exit(0);
	await tick();
	t.clock.advance(10 * 120000);
	await tick();
	assert.equal(t.helpers().length, 1);
	assert.equal(t.clock.pending, 0);
	// Ended twice, or without ever having been pending: nothing happens.
	t.challenges.ended({ job: "j_1", host: "shop.example" });
	t.challenges.ended({ job: "j_other", host: "x.example" });
	t.challenges.acked({ job: "j_other", host: "x.example" });
	assert.equal(t.calls.length, 2);

	// A helper that does not go by itself is ended after the grace period.
	const u = setup();
	u.challenges.pending({ job: "j_2", host: "shop.example" });
	u.posted(8);
	u.challenges.ended({ job: "j_2", host: "shop.example" });
	u.clock.advance(CLOSE_GRACE_MS);
	assert.deepEqual(u.helpers()[0].child.signals, ["SIGTERM"]);

	// Ended before it was even shown: it is closed as soon as it is.
	const v = setup();
	v.challenges.pending({ job: "j_3", host: "shop.example" });
	v.challenges.ended({ job: "j_3", host: "shop.example" });
	assert.deepEqual(v.helpers()[0].child.written, ['{"cmd":"close"}\n']);
});

test("Open: a click asks the extension for the page - an attention frame, nothing else", async () => {
	const t = setup();
	t.challenges.pending({ job: "j_1", host: "shop.example" });
	t.posted(5);
	assert.deepEqual(t.asked, [], "nothing is asked for before the operator clicks");
	t.helpers()[0].child.line({ event: "activation_token", token: "tok" });
	t.helpers()[0].child.line({ event: "action", key: "open" });
	assert.deepEqual(t.asked, ["j_1"]);
	assert.deepEqual(t.lines.filter((l) => l.event === "challenge.open_requested").map((l) => l.fields), [{ job: "j_1", sent: true }]);
	// The helper leaves after a click; the notification is gone from the screen.
	t.helpers()[0].child.line({ event: "exit", why: "action" });
	t.helpers()[0].child.exit(0);
	await tick();
	assert.equal(t.calls.filter((c) => c.command !== "pw-play").length, 1, "no program was started because of the click");
	// Until the extension says that the operator has the page, the reminder goes on.
	t.clock.advance(120000);
	await tick();
	assert.equal(t.helpers().length, 2);
	// A click on the notification itself counts the same; any other action key does not.
	t.posted(6);
	t.helpers()[1].child.line({ event: "action", key: "default" });
	assert.deepEqual(t.asked, ["j_1", "j_1"]);
	const u = setup();
	u.challenges.pending({ job: "j_2", host: "shop.example" });
	u.posted(9);
	u.helpers()[0].child.line({ event: "action", key: "dismiss" });
	u.helpers()[0].child.line({ event: "action", key: "open; rm -rf" });
	assert.deepEqual(u.asked, []);
	// A click that arrives for a job that is over asks for nothing.
	u.challenges.ended({ job: "j_2", host: "shop.example" });
	u.helpers()[0].child.line({ event: "action", key: "open" });
	assert.deepEqual(u.asked, []);
	// The extension is not there: said so in the log, nothing else to do.
	const v = setup({ attention: () => false });
	v.challenges.pending({ job: "j_3", host: "shop.example" });
	v.posted(4);
	v.helpers()[0].child.line({ event: "action", key: "open" });
	assert.deepEqual(v.lines.filter((l) => l.event === "challenge.open_requested").map((l) => l.fields), [{ job: "j_3", sent: false }]);
});

test("three pages wait at most: three notifications, each with its own repeat, each closed with its job", async () => {
	const t = setup();
	for (const [i, host] of ["a.example", "b.example", "c.example"].entries()) {
		t.challenges.pending({ job: `j_${i}`, host });
		t.posted(10 + i);
		t.clock.advance(10000);
	}
	assert.equal(t.helpers().length, 3);
	assert.equal(t.challenges.size, 3);
	// One is acknowledged, one ends, one is left: only that one repeats.
	t.challenges.acked({ job: "j_0", host: "a.example" });
	t.challenges.ended({ job: "j_1", host: "b.example" });
	t.helpers()[1].child.exit(0);
	await tick();
	t.clock.advance(120000);
	await tick();
	assert.equal(t.helpers()[2].child.stdinEnded, true, "the third is being replaced by its repeat");
	assert.equal(t.helpers()[0].child.stdinEnded, false);
	t.helpers()[2].child.exit(0);
	await tick();
	assert.equal(t.helpers().length, 4);
	assert.match(String(arg(t.helpers()[3], "body")), /^c\.example /);
	assert.equal(arg(t.helpers()[3], "replaces-id"), "12");
	// The daemon stops: no repeat fires into the shutdown. (The sounds have ended; a player that has not is
	// the notifier's to end, at its own limit.)
	for (const sound of t.sounds()) sound.child.exit(0);
	t.challenges.closeAll();
	assert.equal(t.challenges.size, 0);
	assert.equal(t.clock.pending, 0);
	t.clock.advance(10 * 120000);
	await tick();
	assert.equal(t.helpers().length, 4);
});

test("a notification the notifier does not make leaves the watch as it is; the repeat tries again", async () => {
	// Two jobs of one site within a minute cannot be (one challenge per site), but two sites of a burst can hit the
	// notifier's limits. A post that is refused is no reason to give up on the job.
	const t = setup();
	t.challenges.pending({ job: "j_1", host: "a.shop.example" });
	t.posted(1);
	t.challenges.ended({ job: "j_1", host: "a.shop.example" });
	t.helpers()[0].child.exit(0);
	await tick();
	// The site's next challenge, seconds later: the notifier holds it back (one per site and minute).
	t.clock.advance(5000);
	t.challenges.pending({ job: "j_2", host: "b.shop.example" });
	assert.equal(t.helpers().length, 1, "not posted");
	assert.equal(t.challenges.size, 1, "but watched");
	t.clock.advance(120000);
	await tick();
	assert.equal(t.helpers().length, 2, "the repeat gets through");
	assert.match(String(arg(t.helpers()[1], "body")), /^b\.shop\.example /);
	// Its end closes what is there.
	t.posted(2);
	t.challenges.ended({ job: "j_2", host: "b.shop.example" });
	assert.deepEqual(t.helpers()[1].child.written, ['{"cmd":"close"}\n']);
});
