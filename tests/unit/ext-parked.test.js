// The watch over challenge tabs that wait for the operator, played through
// on a clock that only moves when the test says so.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PARK_LIMITS, Parked } from "../../extension/background/parked.js";
import { EVIDENCE, KIND } from "../../extension/background/detect.js";
import { FakeClock } from "../helpers/fake-clock.js";

/**
 * @typedef {import("../../extension/background/parked.js").Probe} Probe
 * @typedef {import("../../extension/background/parked.js").ParkEnd} ParkEnd
 * @typedef {import("../../extension/background/parked.js").ParkedEntry} ParkedEntry
 */

const MIN = 60000;
/** @type {Probe} */
const CHALLENGE = { state: "challenge" };
/** @type {Probe} */
const CONTENT = { state: "clear", thin: false };
/** @type {Probe} */
const SHORT = { state: "clear", thin: true };

/** Let the promise of a probe that just ran settle. */
const settle = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** @param {{ maxParked?: number, tuning?: Partial<import("../../extension/background/parked.js").ParkedTuning> }} [opts] */
function setup(opts = {}) {
	const clock = new FakeClock();
	/** @type {Map<string, Probe | (() => Probe | Promise<Probe>)>} what each job's tab shows; the default is the challenge */
	const pages = new Map();
	/** @type {string[]} */
	const probes = [];
	/** @type {{ job: string, end: ParkEnd, at: number }[]} */
	const ends = [];
	let changes = 0;
	const parked = new Parked({
		clock,
		probe: async (entry) => {
			probes.push(entry.job);
			const page = pages.get(entry.job) ?? CHALLENGE;
			return typeof page === "function" ? page() : page;
		},
		onEnd: (entry, end) => ends.push({ job: entry.job, end, at: clock.now() }),
		onChange: () => changes++,
		...opts,
	});
	let n = 0;
	/** @param {string} job @param {Partial<{ host: string, site: string, tabId: number, kind: string, parkMs: number }>} [over] */
	const park = (job, over = {}) => {
		n += 1;
		const host = over.host ?? `site${n}.example`;
		return parked.park({ job, host, site: over.site ?? host, tabId: 40 + n, kind: KIND.CLOUDFLARE, parkMs: 15 * MIN, ...over });
	};
	/** Move the clock in steps, letting every probe that falls due finish. @param {number} ms @param {number} [step] */
	const advance = async (ms, step = 100) => {
		for (let left = ms; left > 0; left -= step) {
			clock.advance(Math.min(step, left));
			await settle();
		}
	};
	return { clock, parked, pages, probes, ends, park, advance, changes: () => changes };
}

test("a parked tab is looked at every now and then; while the challenge stays, nothing happens", async () => {
	const t = setup();
	const start = t.clock.now();
	const entry = t.park("j_1", { host: "www.shop.example", site: "shop.example" });
	assert.equal(t.parked.list().length, 1);
	assert.notEqual(t.parked.get("j_1"), null);
	assert.deepEqual(t.parked.list(), [{ job: "j_1", host: "www.shop.example", kind: KIND.CLOUDFLARE, since: start, expiresAt: start + 15 * MIN, handedOff: false }]);
	assert.equal(t.parked.get("j_1"), entry);
	assert.equal(t.parked.get("j_2"), null);
	assert.equal(t.probes.length, 0, "not at once: the job runner just looked");
	await t.advance(1499);
	assert.equal(t.probes.length, 0);
	await t.advance(1);
	assert.equal(t.probes.length, 1);
	await t.advance(60000);
	assert.equal(t.probes.length, 41, "every 1.5 s");
	assert.deepEqual(t.ends, []);
	assert.equal(t.parked.list().length, 1);
});

test("cleared: the page turned into content, and the job goes on to be read", async () => {
	const t = setup();
	t.park("j_1");
	await t.advance(30000);
	t.pages.set("j_1", CONTENT);
	await t.advance(1500);
	assert.deepEqual(t.ends.map((e) => [e.job, e.end]), [["j_1", { how: "cleared" }]]);
	assert.equal(t.parked.list().length, 0);
	assert.equal(t.parked.get("j_1"), null);
	// It is gone: no more looks, no expiry later, nothing left on the clock.
	const looks = t.probes.length;
	await t.advance(20 * MIN, 10000);
	assert.equal(t.probes.length, looks);
	assert.equal(t.ends.length, 1, "exactly one end");
	assert.equal(t.clock.pending, 0);
});

test("a navigation that completes is looked at at once, not at the next round", async () => {
	const t = setup();
	t.park("j_1");
	await t.advance(1600);
	assert.equal(t.probes.length, 1);
	t.pages.set("j_1", CONTENT);
	t.parked.nudge("j_1");
	await t.advance(299);
	assert.equal(t.ends.length, 0);
	await t.advance(1);
	assert.deepEqual(t.ends.map((e) => e.end), [{ how: "cleared" }]);
	t.parked.nudge("j_1");
	t.parked.nudge("j_unknown");
	await t.advance(5000);
	assert.equal(t.ends.length, 1);
});

test("a page without a challenge and with next to no content must stay that way before it counts as cleared", async () => {
	const t = setup();
	t.park("j_1");
	await t.advance(1500);
	// Between two steps of a check a page can look like this for a moment ...
	t.pages.set("j_1", SHORT);
	await t.advance(1500);
	assert.equal(t.ends.length, 0, "seen once: not yet");
	t.pages.set("j_1", CHALLENGE);
	await t.advance(6000);
	assert.equal(t.ends.length, 0, "it was only a moment: the count starts over");
	// ... a page that simply is short looks like this for good.
	t.pages.set("j_1", SHORT);
	await t.advance(1500);
	const firstSeen = t.clock.now();
	await t.advance(3000);
	assert.equal(t.ends.length, 0);
	await t.advance(1500);
	assert.deepEqual(t.ends.map((e) => e.end), [{ how: "cleared" }]);
	assert.ok(t.ends[0].at - firstSeen >= 4000, "stable for four seconds");

	// A page on its way somewhere starts the count over as well.
	const u = setup();
	u.park("j_2");
	u.pages.set("j_2", SHORT);
	await u.advance(4500);
	u.pages.set("j_2", { state: "loading" });
	await u.advance(1500);
	u.pages.set("j_2", SHORT);
	await u.advance(4400);
	assert.equal(u.ends.length, 0);
	await u.advance(1600);
	assert.equal(u.ends.length, 1);
});

test("blocked: the page turned into a refusal or a wall", async () => {
	const t = setup();
	t.park("j_1");
	const detection = { kind: KIND.HTTP_403, evidence: EVIDENCE.STATUS_403, action: /** @type {const} */ ("blocked"), retryAfterS: null };
	t.pages.set("j_1", { state: "blocked", detection });
	await t.advance(1500);
	assert.deepEqual(t.ends.map((e) => e.end), [{ how: "blocked", detection }]);
	assert.equal(t.parked.list().length, 0);
	assert.equal(t.clock.pending, 0);
});

test("expired: nobody came in time", async () => {
	const t = setup();
	const start = t.clock.now();
	t.park("j_1", { parkMs: 15 * MIN });
	await t.advance(15 * MIN - 100, 5000);
	assert.equal(t.ends.length, 0);
	await t.advance(100);
	assert.deepEqual(t.ends.map((e) => [e.end, e.at - start]), [[{ how: "expired" }, 15 * MIN]]);
	assert.equal(t.parked.list().length, 0);
	assert.equal(t.clock.pending, 0);

	// Whatever the daemon asks for, no tab waits longer than the extension's own cap.
	assert.equal(PARK_LIMITS.maxParkMs, 30 * MIN);
	const u = setup();
	const entry = u.park("j_2", { parkMs: 24 * 60 * MIN });
	assert.equal(entry.expiresAt - entry.since, 30 * MIN);
	await u.advance(30 * MIN, 10000);
	assert.deepEqual(u.ends.map((e) => e.end), [{ how: "expired" }]);
});

test("the tab is gone: the job ends as tab_closed", async () => {
	const t = setup();
	t.park("j_1");
	t.pages.set("j_1", { state: "gone" });
	await t.advance(1500);
	assert.equal(t.ends.length, 1);
	const end = t.ends[0].end;
	assert.equal(end.how, "stopped");
	assert.deepEqual(end.how === "stopped" ? [end.stop.outcome, end.stop.code, end.stop.retryable] : null, ["error", "tab_closed", true]);
});

test("stopped from outside: once, with the reason given, and the watch is over", async () => {
	const t = setup();
	t.park("j_1");
	t.park("j_2");
	t.park("j_3");
	const cancel = { outcome: /** @type {const} */ ("aborted"), code: "client_gone", message: "the daemon cancelled the job", retryable: true };
	assert.equal(t.parked.stop("j_2", cancel), true);
	assert.equal(t.parked.stop("j_2", cancel), false, "only the first end counts");
	assert.equal(t.parked.stop("j_nope", cancel), false);
	assert.deepEqual(t.ends.map((e) => [e.job, e.end]), [["j_2", { how: "stopped", stop: cancel }]]);
	assert.deepEqual(t.parked.list().map((p) => p.job), ["j_1", "j_3"]);
	// The link goes down, or the operator pauses: every one of them ends.
	const down = { outcome: /** @type {const} */ ("aborted"), code: "link_down", message: "the link to the daemon was lost", retryable: true, silent: true };
	for (const waiting of t.parked.list()) t.parked.stop(waiting.job, down);
	assert.deepEqual(t.ends.slice(1).map((e) => [e.job, e.end]), [["j_1", { how: "stopped", stop: down }], ["j_3", { how: "stopped", stop: down }]]);
	assert.equal(t.parked.list().length, 0);
	assert.equal(t.clock.pending, 0, "no timer survives");
	await t.advance(20 * MIN, 10000);
	assert.equal(t.ends.length, 3);
	assert.equal(t.probes.length, 0);
});

test("an end while a look is under way: the look's answer is about a tab that is no longer watched", async () => {
	const t = setup();
	t.park("j_1");
	/** @type {(p: Probe) => void} */
	let answer = () => {};
	t.pages.set("j_1", () => new Promise((resolve) => (answer = resolve)));
	await t.advance(1500);
	assert.equal(t.probes.length, 1);
	// The operator closes the tab while the script is still running in it.
	const closed = { outcome: /** @type {const} */ ("error"), code: "tab_closed", message: "closed", retryable: true };
	t.parked.stop("j_1", closed);
	answer(CONTENT);
	await settle();
	assert.deepEqual(t.ends.map((e) => e.end), [{ how: "stopped", stop: closed }], "not also cleared");

	// A slow look is never doubled: the next round waits for it.
	const u = setup();
	u.park("j_2");
	u.pages.set("j_2", () => new Promise((resolve) => (answer = resolve)));
	await u.advance(1500);
	await u.advance(9000);
	assert.equal(u.probes.length, 1, "one look at a time");
	answer(CHALLENGE);
	await settle();
	await u.advance(1500);
	assert.equal(u.probes.length, 2);
	// A look that fails is a look that saw nothing: the watch goes on.
	u.pages.set("j_2", () => {
		throw new Error("the tab would not answer");
	});
	await u.advance(4500);
	assert.equal(u.ends.length, 0);
	assert.equal(u.parked.list().length, 1);
});

test("at most three parked jobs, and one per site", async () => {
	assert.equal(PARK_LIMITS.maxParked, 3);
	const t = setup();
	assert.equal(t.parked.refusal("a.example", 15 * MIN), null);
	t.park("j_1", { host: "www.a.example", site: "a.example" });
	// A second challenge of the same site is not kept: the answer points at the one that waits.
	assert.equal(t.parked.refusal("a.example", 15 * MIN), "challenge_pending");
	assert.equal(t.parked.pendingFor("a.example")?.job, "j_1");
	assert.equal(t.parked.pendingFor("b.example"), null);
	assert.throws(() => t.park("j_x", { host: "forum.a.example", site: "a.example" }), /challenge_pending/);
	t.park("j_2", { site: "b.example" });
	t.park("j_3", { site: "c.example" });
	assert.equal(t.parked.list().length, 3);
	// The fourth is reported without being kept.
	assert.equal(t.parked.refusal("d.example", 15 * MIN), "too_many_pending");
	assert.throws(() => t.park("j_4", { site: "d.example" }), /too_many_pending/);
	assert.equal(t.parked.refusal("a.example", 15 * MIN), "challenge_pending", "the more specific answer wins");
	assert.equal(t.parked.list().length, 3);
	// A place frees when one ends, in whatever way.
	t.pages.set("j_2", CONTENT);
	await t.advance(1500);
	assert.equal(t.parked.refusal("d.example", 15 * MIN), null);
	assert.equal(t.parked.refusal("b.example", 15 * MIN), null, "and its site may show a challenge again");
	t.park("j_4", { site: "d.example" });
	assert.deepEqual(t.parked.list().map((p) => p.job), ["j_1", "j_3", "j_4"], "oldest first");
	// A job that does not wait for the operator is never parked.
	assert.equal(t.parked.refusal("e.example", 0), "challenge_unattended");
	assert.equal(t.parked.refusal("e.example", -1), "challenge_unattended");
	assert.equal(t.parked.refusal("e.example", NaN), "challenge_unattended");
	assert.throws(() => t.park("j_1", { site: "z.example" }), /cannot park/, "the same job twice");
	// The cap can be lowered, never raised.
	assert.equal(new Parked({ clock: new FakeClock(), probe: async () => CHALLENGE, onEnd: () => {}, maxParked: 50 }).refusal("x.example", MIN), null);
	const one = setup({ maxParked: 1 });
	one.park("j_1");
	assert.equal(one.parked.refusal("other.example", MIN), "too_many_pending");
});

test("handing the tab to the operator is acknowledged once; from then on the tab is looked at more often", async () => {
	const t = setup();
	t.park("j_1");
	const before = t.changes();
	assert.equal(t.parked.markHandedOff("j_1"), true, "the first time is the acknowledgement");
	assert.equal(t.parked.markHandedOff("j_1"), false, "asking again brings the window up again, nothing more");
	assert.equal(t.parked.markHandedOff("j_nope"), false);
	assert.equal(t.changes(), before + 1);
	assert.equal(t.parked.list()[0].handedOff, true);
	// Still watched, still expiring, still cleared like before - but the operator is at the page now and waits for
	// it to be read: a look every half second instead of every second and a half.
	await t.advance(3000);
	assert.equal(t.probes.length, 6);
	t.pages.set("j_1", CONTENT);
	await t.advance(500);
	assert.deepEqual(t.ends.map((e) => e.end), [{ how: "cleared" }]);
	// A page nobody was given keeps the slower pace.
	const u = setup();
	u.park("j_2");
	await u.advance(3000);
	assert.equal(u.probes.length, 2);
	// A faster pace that is asked for by a test build is never slowed down by the hand-off.
	const v = setup({ tuning: { pollMs: 200, handedOffPollMs: 500 } });
	v.park("j_3");
	v.parked.markHandedOff("j_3");
	await v.advance(1000, 100);
	assert.equal(v.probes.length, 5);
});

test("every way a parked job can go ends it exactly once", async () => {
	/** @type {[string, (t: ReturnType<typeof setup>) => void | Promise<void>][]} */
	const ways = [
		["cleared", (t) => void t.pages.set("j_1", CONTENT)],
		["blocked", (t) => void t.pages.set("j_1", { state: "blocked", detection: { kind: KIND.LOGIN_WALL, evidence: EVIDENCE.LOGIN_PATH, action: "blocked", retryAfterS: null } })],
		["gone", (t) => void t.pages.set("j_1", { state: "gone" })],
		["stopped", (t) => void t.parked.stop("j_1", { outcome: "aborted", code: "paused", message: "paused", retryable: false })],
		["expired", (t) => t.advance(16 * MIN, 10000)],
	];
	for (const [name, go] of ways) {
		const t = setup();
		t.park("j_1");
		await go(t);
		await t.advance(2000);
		// Everything else that could end it happens afterwards, and counts for nothing.
		t.pages.set("j_1", CONTENT);
		t.parked.stop("j_1", { outcome: "aborted", code: "late", message: "late", retryable: false });
		t.parked.nudge("j_1");
		await t.advance(31 * MIN, 10000);
		assert.equal(t.ends.length, 1, name);
		assert.equal(t.parked.list().length, 0, name);
		assert.equal(t.clock.pending, 0, name);
	}
});
