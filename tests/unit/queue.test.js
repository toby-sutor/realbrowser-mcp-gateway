import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "../../daemon/src/queue.js";
import { siteOf } from "../../daemon/src/site.js";
import { DEFAULT_PACING, JOB_WAIT_MAX, LIMITS } from "../../daemon/src/config.js";
import { DIRECTION, PROTOCOL_VERSION, validateMessage, zeroTimings } from "../../extension/shared/protocol.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { defaultState, makeResult } from "../helpers/fake-extension.js";

/**
 * @typedef {import("../../daemon/src/queue.js").JobSpec} JobSpec
 * @typedef {import("../../daemon/src/queue.js").JobReport} JobReport
 * @typedef {Record<string, any>} Frame
 */

/** Fixed gaps so expected times can be written down: host 10 s, global 2 s, dwell 1 s. */
const PACING = {
	polite: { hostGapMs: /** @type {const} */ ([10000, 10000]), globalGapMs: /** @type {const} */ ([2000, 2000]), dwellMs: /** @type {const} */ ([1000, 1000]) },
	fast: { hostGapMs: /** @type {const} */ ([500, 500]), globalGapMs: /** @type {const} */ ([100, 100]), dwellMs: /** @type {const} */ ([200, 200]) },
};

/**
 * @param {object} [opts]
 * @param {import("../../daemon/src/config.js").Pacing} [opts.pacing]
 * @param {readonly string[]} [opts.fastHosts]
 * @param {"polite" | "fast"} [opts.defaultProfile]
 * @param {() => number} [opts.rng]
 * @param {ConstructorParameters<typeof JobQueue>[0]["limits"]} [opts.limits]
 * @param {boolean} [opts.connected] start with the extension link up (default true)
 * @param {(host: string) => string} [opts.siteOf] another rule for which hosts are one site
 * @param {import("../../daemon/src/queue.js").BlobSink} [opts.blobs] whoever puts the pieces of a file together
 */
function setup(opts = {}) {
	const clock = new FakeClock();
	/** @type {Frame[]} */
	const sent = [];
	/** @type {import("../../daemon/src/audit.js").AuditEntry[]} */
	const audit = [];
	/** @type {{ level: string, event: string, fields: Record<string, unknown> }[]} */
	const logs = [];
	let linkOpen = true;
	/** @param {string} level */
	const at = (level) => (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields = {}) => {
		logs.push({ level, event, fields });
	};
	const queue = new JobQueue({
		clock,
		rng: opts.rng ?? (() => 0.5),
		log: { info: at("info"), warn: at("warn"), error: at("error") },
		audit: { append: (entry) => audit.push(entry) },
		send: (msg) => {
			if (!linkOpen) return false;
			// Everything the queue sends must be a valid frame for the extension.
			assert.deepEqual(validateMessage(msg, DIRECTION.TO_EXT), { ok: true });
			sent.push(msg);
			return true;
		},
		pacing: opts.pacing ?? PACING,
		fastHosts: opts.fastHosts,
		defaultProfile: opts.defaultProfile,
		limits: opts.limits,
		siteOf: opts.siteOf,
		blobs: opts.blobs,
	});
	if (opts.connected !== false) queue.linkUp(defaultState());
	return {
		clock,
		queue,
		sent,
		audit,
		logs,
		/** @param {boolean} open */
		setLinkOpen: (open) => (linkOpen = open),
		/** @param {string} type */
		frames: (type) => sent.filter((f) => f.type === type),
		starts: () => sent.filter((f) => f.type === "job.start"),
	};
}

/**
 * @param {string} url
 * @param {Partial<JobSpec>} [over]
 * @returns {JobSpec}
 */
function spec(url, over = {}) {
	return {
		kind: "fetch",
		url,
		host: new URL(url).hostname,
		session: "auto",
		wait: { timeout_ms: 30000, settle_ms: 1500, dwell_ms: null, human_wait_ms: 0, scroll: "lazy" },
		extract: { markdown: true, text: true, html: false, raw_html: false, links: true, adapter: "auto" },
		dedupeKey: url,
		...over,
	};
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T | "pending">}
 */
async function peek(promise) {
	return Promise.race([promise, new Promise((resolve) => setImmediate(() => resolve("pending")))]);
}

/**
 * @param {Promise<JobReport>} promise
 * @returns {Promise<JobReport>}
 */
async function settled(promise) {
	const r = await peek(promise);
	assert.notEqual(r, "pending", "job should have been resolved");
	return /** @type {JobReport} */ (r);
}

test("a job is dispatched at once and resolves with the extension's result", async () => {
	const t = setup();
	const h = t.queue.submit(spec("https://a.example/1"));
	assert.equal(h.deduped, false);
	assert.match(h.job, /^j_[A-Za-z0-9_-]{12}$/);
	assert.equal(t.starts().length, 1);
	const start = t.starts()[0];
	assert.equal(start.job, h.job);
	assert.equal(start.url, "https://a.example/1");
	assert.equal(start.session, "auto");
	// dwell_ms was left open, so the queue picked it from the pacing profile.
	assert.deepEqual(start.wait, { timeout_ms: 30000, settle_ms: 1500, dwell_ms: 1000, human_wait_ms: 0, scroll: "lazy" });
	assert.deepEqual(t.queue.stats(), { queued: 0, dispatched: 1 });
	assert.equal(await peek(h.promise), "pending");

	t.clock.advance(800);
	t.queue.onResult(makeResult(start));
	const report = await settled(h.promise);
	assert.equal(report.outcome, "ok");
	assert.equal(report.job, h.job);
	assert.equal(report.content?.markdown, "# Fixture page\n\nhello world");
	assert.deepEqual(t.queue.stats(), { queued: 0, dispatched: 0 });
	assert.deepEqual(t.audit, [
		{
			job: h.job,
			kind: "fetch",
			url: "https://a.example/1",
			host: "a.example",
			outcome: "ok",
			code: null,
			cookie_scope: "container",
			dispatched: true,
			duration_ms: 800,
			redirect_origins: [],
			callers: 1,
			// The browser's own account of the job: how long it took there, and where that time went.
			timings: { elapsed_ms: 120, ...zeroTimings() },
		},
	]);
	// The same numbers in the log, flat: one line a job, nothing of the page.
	assert.deepEqual(t.logs.filter((l) => l.event === "job.timings").map((l) => l.fields), [{ job: h.job, elapsed_ms: 120, ...zeroTimings() }]);
});

test("a job whose frame cannot be sent ends with an error of its own, and the queue goes on - from a timer too", async () => {
	const clock = new FakeClock();
	/** @type {Frame[]} */
	const sent = [];
	/** @type {import("../../daemon/src/audit.js").AuditEntry[]} */
	const audit = [];
	/** @type {{ event: string, fields: Record<string, unknown> }[]} */
	const errors = [];
	const queue = new JobQueue({
		clock,
		rng: () => 0.5,
		log: { info: () => {}, warn: () => {}, error: (event, fields = {}) => void errors.push({ event, fields }) },
		audit: { append: (entry) => audit.push(entry) },
		// What the link does with a frame that is not valid: it throws.
		send: (msg) => {
			if (String(msg.url).includes("unsendable")) throw new Error("refusing to send an invalid frame: url");
			sent.push(msg);
			return true;
		},
		pacing: PACING,
	});
	queue.linkUp(defaultState());

	// At once, from submit().
	const bad = queue.submit(spec("https://a.example/unsendable"));
	const report = await settled(bad.promise);
	assert.deepEqual([report.outcome, report.error?.code, report.error?.retryable], ["error", "internal_error", false]);
	assert.equal(sent.length, 0);
	assert.deepEqual(audit.map((e) => [e.job, e.outcome, e.code, e.dispatched]), [[report.job, "error", "internal_error", false]]);
	assert.deepEqual(errors.map((e) => [e.event, e.fields.job]), [["queue.send_failed", report.job]]);
	assert.deepEqual(queue.stats(), { queued: 0, dispatched: 0 });

	// From the timer of the pump: a job goes out, two wait behind it for the gap, the first of them cannot be sent.
	const first = queue.submit(spec("https://b.example/1"));
	const second = queue.submit(spec("https://b.example/unsendable"));
	const third = queue.submit(spec("https://b.example/3"));
	assert.equal(sent.length, 1);
	queue.onResult(makeResult(sent[0]));
	await settled(first.promise);
	// Nothing is thrown out of the timer that fires here.
	clock.advance(10000);
	assert.equal((await settled(second.promise)).error?.code, "internal_error");
	assert.deepEqual(sent.map((f) => f.url), ["https://b.example/1", "https://b.example/3"], "the job behind it was sent in the same go");
	queue.onResult(makeResult(sent[1]));
	assert.equal((await settled(third.promise)).outcome, "ok");
	assert.equal(errors.length, 2);
	assert.equal(clock.pending, 0);
});

test("an explicit dwell is passed through unchanged", () => {
	const t = setup();
	t.queue.submit(spec("https://a.example/1", { wait: { timeout_ms: 5000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } }));
	assert.deepEqual(t.starts()[0].wait, { timeout_ms: 5000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" });
});

test("serial dispatch: one job at a time, in submission order", async () => {
	const t = setup({ pacing: { ...PACING, polite: { ...PACING.polite, hostGapMs: [0, 0], globalGapMs: [0, 0] } } });
	const a = t.queue.submit(spec("https://a.example/1"));
	const b = t.queue.submit(spec("https://b.example/1"));
	const c = t.queue.submit(spec("https://c.example/1"));
	assert.deepEqual(t.starts().map((f) => f.job), [a.job]);
	assert.deepEqual(t.queue.stats(), { queued: 2, dispatched: 1 });

	t.queue.onResult(makeResult(t.starts()[0]));
	assert.deepEqual(t.starts().map((f) => f.job), [a.job, b.job]);
	t.queue.onResult(makeResult(t.starts()[1]));
	assert.deepEqual(t.starts().map((f) => f.job), [a.job, b.job, c.job]);
	t.queue.onResult(makeResult(t.starts()[2]));
	for (const h of [a, b, c]) assert.equal((await settled(h.promise)).outcome, "ok");
});

test("slots from the extension state bound the concurrency", () => {
	const noGaps = { ...PACING, polite: { ...PACING.polite, hostGapMs: /** @type {const} */ ([0, 0]), globalGapMs: /** @type {const} */ ([0, 0]) } };
	const t = setup({ pacing: noGaps, connected: false });
	t.queue.linkUp({ ...defaultState(), slots: 2 });
	for (const n of [1, 2, 3, 4]) t.queue.submit(spec(`https://h${n}.example/`));
	assert.equal(t.starts().length, 2);
	t.queue.onResult(makeResult(t.starts()[0]));
	assert.equal(t.starts().length, 3);

	// The extension lowers its slots: nothing new starts until it is below the limit again.
	t.queue.setState({ ...defaultState(), slots: 1 });
	t.queue.onResult(makeResult(t.starts()[1]));
	assert.equal(t.starts().length, 3);
	t.queue.onResult(makeResult(t.starts()[2]));
	assert.equal(t.starts().length, 4);

	// Zero slots: jobs wait.
	const z = setup({ pacing: noGaps, connected: false });
	z.queue.linkUp({ ...defaultState(), slots: 0 });
	z.queue.submit(spec("https://a.example/"));
	assert.equal(z.starts().length, 0);
	z.queue.setState({ ...defaultState(), slots: 1 });
	assert.equal(z.starts().length, 1);
});

test("per-host gap: the next job for the same host waits, measured from completion", () => {
	const t = setup();
	t.queue.submit(spec("https://a.example/1"));
	t.queue.submit(spec("https://a.example/2"));
	t.clock.advance(3000);
	t.queue.onResult(makeResult(t.starts()[0]));
	// Completed at +3 s, host gap 10 s: eligible at +13 s.
	assert.equal(t.starts().length, 1);
	t.clock.advance(9999);
	assert.equal(t.starts().length, 1);
	t.clock.advance(1);
	assert.equal(t.starts().length, 2);
	assert.equal(t.starts()[1].url, "https://a.example/2");
});

test("global gap: another host only waits the short gap, and may overtake", () => {
	const t = setup();
	const a1 = t.queue.submit(spec("https://a.example/1"));
	const a2 = t.queue.submit(spec("https://a.example/2"));
	const b1 = t.queue.submit(spec("https://b.example/1"));
	t.clock.advance(1000);
	t.queue.onResult(makeResult(t.starts()[0]));
	// a.example is gapped until +11 s, everything until +3 s.
	t.clock.advance(1999);
	assert.deepEqual(t.starts().map((f) => f.job), [a1.job]);
	t.clock.advance(1);
	assert.deepEqual(t.starts().map((f) => f.job), [a1.job, b1.job]);

	// b1 completes at +4 s. a2 is still held by its host gap until +11 s.
	t.clock.advance(1000);
	t.queue.onResult(makeResult(t.starts()[1]));
	t.clock.advance(6999);
	assert.equal(t.starts().length, 2);
	t.clock.advance(1);
	assert.deepEqual(t.starts().map((f) => f.job), [a1.job, b1.job, a2.job]);
});

test("jitter: gaps are drawn from the profile range, host gaps skewed low", () => {
	const pacing = {
		...PACING,
		polite: { hostGapMs: /** @type {const} */ ([4000, 12000]), globalGapMs: /** @type {const} */ ([1000, 3000]), dwellMs: /** @type {const} */ ([1500, 5000]) },
	};
	/**
	 * @param {number} u the value the RNG returns
	 * @returns {{ hostGap: number, globalGap: number, dwell: number }} measured gaps
	 */
	const measure = (u) => {
		const t = setup({ pacing, rng: () => u });
		t.queue.submit(spec("https://a.example/1"));
		t.queue.submit(spec("https://a.example/2"));
		t.queue.submit(spec("https://b.example/1"));
		const dwell = t.starts()[0].wait.dwell_ms;
		t.queue.onResult(makeResult(t.starts()[0]));
		const t0 = t.clock.now();
		let globalGap = -1;
		let hostGap = -1;
		for (let ms = 0; ms <= 13000 && hostGap < 0; ms += 1) {
			if (globalGap < 0 && t.starts().length === 2) {
				globalGap = t.clock.now() - t0;
				// Finish b1 at once so only the host gap holds a2 back.
				t.queue.onResult(makeResult(t.starts()[1]));
			}
			if (t.starts().length === 3) hostGap = t.clock.now() - t0;
			t.clock.advance(1);
		}
		return { hostGap, globalGap, dwell };
	};
	assert.deepEqual(measure(0), { hostGap: 4000, globalGap: 1000, dwell: 1500 });
	// Uniform for the global gap and dwell, squared for the host gap.
	assert.deepEqual(measure(0.5), { hostGap: 6000, globalGap: 2000, dwell: 3250 });
	const top = measure(0.999999);
	assert.ok(top.hostGap <= 12000 && top.hostGap >= 11990, `host gap ${top.hostGap}`);
	assert.ok(top.globalGap <= 3000 && top.globalGap >= 2990, `global gap ${top.globalGap}`);
	// An RNG that misbehaves cannot push a gap outside the range.
	assert.deepEqual(measure(7), { hostGap: 12000, globalGap: 3000, dwell: 5000 });
	assert.deepEqual(measure(-3), { hostGap: 4000, globalGap: 1000, dwell: 1500 });
});

test("fast profile applies to listed hosts and their subdomains only", () => {
	const t = setup({ fastHosts: ["docs.example"] });
	t.queue.submit(spec("https://api.docs.example/1"));
	t.queue.submit(spec("https://api.docs.example/2"));
	assert.equal(t.starts()[0].wait.dwell_ms, 200);
	t.queue.onResult(makeResult(t.starts()[0]));
	t.clock.advance(499);
	assert.equal(t.starts().length, 1);
	t.clock.advance(1);
	assert.equal(t.starts().length, 2);

	const p = setup({ fastHosts: ["docs.example"] });
	p.queue.submit(spec("https://notdocs.example/1"));
	assert.equal(p.starts()[0].wait.dwell_ms, 1000);
});

test("dedupe: identical in-flight jobs share one run", async () => {
	const t = setup();
	const first = t.queue.submit(spec("https://a.example/1"));
	const second = t.queue.submit(spec("https://a.example/1"));
	const other = t.queue.submit(spec("https://a.example/1", { session: "isolated", dedupeKey: "https://a.example/1|isolated" }));
	assert.equal(second.deduped, true);
	assert.equal(second.job, first.job);
	assert.equal(other.deduped, false);
	assert.notEqual(other.job, first.job);
	assert.equal(t.starts().length, 1);

	t.queue.onResult(makeResult(t.starts()[0]));
	const [r1, r2] = [await settled(first.promise), await settled(second.promise)];
	assert.equal(r1, r2);
	assert.equal(t.audit.length, 1, "one audit entry per job, not per caller");
	assert.equal(t.audit[0].callers, 2, "and it says how many calls it stands for");

	// Once it is done, the same request is a new job.
	const again = t.queue.submit(spec("https://a.example/1"));
	assert.equal(again.deduped, false);
	assert.notEqual(again.job, first.job);
});

test("dedupe also joins a job that is still queued", async () => {
	const t = setup();
	t.queue.submit(spec("https://a.example/1"));
	const queued = t.queue.submit(spec("https://a.example/2"));
	const joined = t.queue.submit(spec("https://a.example/2"));
	assert.equal(joined.deduped, true);
	assert.equal(joined.job, queued.job);
	assert.deepEqual(t.queue.stats(), { queued: 1, dispatched: 1 });
});

test("run deadline: job.cancel is sent and the job resolves as timeout", async () => {
	const t = setup();
	const h = t.queue.submit(spec("https://a.example/1"));
	// Budget: timeout 30 s + settle 1.5 s + dwell 1 s + human wait 0 + grace 5 s.
	t.clock.advance(37499);
	assert.equal(await peek(h.promise), "pending");
	assert.equal(t.frames("job.cancel").length, 0);
	t.clock.advance(1);
	assert.deepEqual(t.frames("job.cancel"), [{ v: PROTOCOL_VERSION, type: "job.cancel", job: h.job, reason: "deadline" }]);
	const report = await settled(h.promise);
	assert.equal(report.outcome, "timeout");
	assert.deepEqual(report.error, { code: "deadline", message: "the browser did not finish the job in time", retryable: true, retry_after_s: null });
	assert.equal(report.nav.requested_url, "https://a.example/1");
	assert.equal(report.content, null);
	assert.equal(t.audit[0].outcome, "timeout");
	assert.equal(t.audit[0].code, "deadline");
	assert.equal(t.audit[0].duration_ms, 37500);
});

test("waiting for the operator is no part of the run: the run deadline is the page's own", async () => {
	const t = setup();
	const h = t.queue.submit(spec("https://a.example/1", { wait: { timeout_ms: 10000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 60000, scroll: "none" } }));
	// The extension is told how long a challenge may wait, parked ...
	assert.equal(t.starts()[0].wait.human_wait_ms, 60000);
	// ... but a job that is not parked holds its slot no longer than its page takes.
	t.clock.advance(14999);
	assert.equal(await peek(h.promise), "pending");
	t.clock.advance(1);
	assert.equal((await settled(h.promise)).error?.code, "deadline");
});

test("after a cancel the slot stays taken until the extension confirms or the grace ends", async () => {
	const t = setup({ pacing: { ...PACING, polite: { ...PACING.polite, hostGapMs: [0, 0], globalGapMs: [0, 0] } } });
	const a = t.queue.submit(spec("https://a.example/1"));
	const b = t.queue.submit(spec("https://b.example/1"));
	t.clock.advance(37500);
	assert.equal((await settled(a.promise)).outcome, "timeout");
	// b must not start while the extension may still be closing a's tab.
	assert.deepEqual(t.starts().map((f) => f.job), [a.job]);
	t.clock.advance(4999);
	assert.equal(t.starts().length, 1);
	t.clock.advance(1);
	assert.deepEqual(t.starts().map((f) => f.job), [a.job, b.job]);

	// With a confirmation the next job starts at once.
	const u = setup({ pacing: { ...PACING, polite: { ...PACING.polite, hostGapMs: [0, 0], globalGapMs: [0, 0] } } });
	const c = u.queue.submit(spec("https://c.example/1"));
	const d = u.queue.submit(spec("https://d.example/1"));
	u.clock.advance(37500);
	assert.equal(u.starts().length, 1);
	u.queue.onResult(makeResult(u.starts()[0], { outcome: "aborted" }));
	assert.deepEqual(u.starts().map((f) => f.job), [c.job, d.job]);
	assert.equal((await settled(c.promise)).outcome, "timeout", "the late result does not change what the caller got");
	assert.ok(u.logs.some((l) => l.event === "job.result_dropped" && l.fields.reason === "late_after_cancel"));
	assert.equal(u.audit.filter((e) => e.job === c.job).length, 1);
});

test("queue deadline: a job that is never started times out without a cancel", async () => {
	const t = setup();
	t.queue.submit(spec("https://a.example/1", { wait: { timeout_ms: 300000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 0, scroll: "none" } }));
	const waiting = t.queue.submit(spec("https://a.example/2"));
	t.clock.advance(119999);
	assert.equal(await peek(waiting.promise), "pending");
	t.clock.advance(1);
	const report = await settled(waiting.promise);
	assert.equal(report.outcome, "timeout");
	assert.equal(report.error?.code, "queue_timeout");
	assert.equal(t.frames("job.cancel").length, 0);
	assert.deepEqual(t.queue.stats(), { queued: 0, dispatched: 1 });
});

test("exactly one result per job: duplicates and unknown ids are dropped and logged", async () => {
	const t = setup();
	const h = t.queue.submit(spec("https://a.example/1"));
	const start = t.starts()[0];
	t.queue.onResult(makeResult(start));
	t.queue.onResult(makeResult(start, { outcome: "blocked" }));
	t.queue.onResult(makeResult({ ...start, job: "j_never_issued" }));
	assert.equal((await settled(h.promise)).outcome, "ok");
	assert.equal(t.audit.length, 1);
	const dropped = t.logs.filter((l) => l.event === "job.result_dropped");
	assert.deepEqual(dropped.map((l) => [l.level, l.fields.job, l.fields.reason]), [
		["warn", h.job, "unknown_or_duplicate"],
		["warn", "j_never_issued", "unknown_or_duplicate"],
	]);
});

test("a result for a job that is still queued is dropped", async () => {
	const t = setup();
	t.queue.submit(spec("https://a.example/1"));
	const queued = t.queue.submit(spec("https://a.example/2"));
	t.queue.onResult(makeResult({ job: queued.job, url: "https://a.example/2" }));
	assert.equal(await peek(queued.promise), "pending");
	assert.ok(t.logs.some((l) => l.event === "job.result_dropped" && l.fields.job === queued.job));
});

test("link loss: dispatched jobs fail as browser_disconnected, queued jobs wait", async () => {
	const t = setup();
	const running = t.queue.submit(spec("https://a.example/1"));
	const queued = t.queue.submit(spec("https://b.example/1"));
	t.queue.onAccepted({ job: running.job, cookie_scope: "container", rule: null });
	t.clock.advance(500);
	t.queue.linkDown();

	const report = await settled(running.promise);
	assert.equal(report.outcome, "error");
	assert.deepEqual(report.error, {
		code: "browser_disconnected",
		message: "the browser disconnected while the job was running",
		retryable: true,
		retry_after_s: null,
	});
	assert.equal(report.cookie_scope, "container");
	assert.equal(await peek(queued.promise), "pending");
	assert.deepEqual(t.queue.stats(), { queued: 1, dispatched: 0 });

	// The extension comes back before the queued job's deadline: it runs.
	t.clock.advance(60000);
	t.queue.linkUp(defaultState());
	assert.deepEqual(t.starts().map((f) => f.job), [running.job, queued.job]);
	t.queue.onResult(makeResult(t.starts()[1]));
	assert.equal((await settled(queued.promise)).outcome, "ok");
});

test("link cut for a protocol violation: the dispatched job fails as invalid_result, not retryable", async () => {
	const t = setup();
	const running = t.queue.submit(spec("https://a.example/1"));
	const queued = t.queue.submit(spec("https://b.example/1"));
	t.queue.onAccepted({ job: running.job, cookie_scope: "container", rule: null });
	t.queue.linkDown("violation");

	const report = await settled(running.promise);
	assert.equal(report.outcome, "error");
	assert.deepEqual(report.error, {
		code: "invalid_result",
		message: "the extension sent an invalid or oversized message while the job was running",
		retryable: false,
		retry_after_s: null,
	});
	assert.equal(report.content, null);
	assert.equal(report.cookie_scope, "container");
	assert.deepEqual([t.audit[0].outcome, t.audit[0].code], ["error", "invalid_result"]);
	// The job that was never sent did nothing wrong and keeps its place.
	assert.equal(await peek(queued.promise), "pending");
	t.clock.advance(5000);
	t.queue.linkUp(defaultState());
	assert.deepEqual(t.starts().map((f) => f.job), [running.job, queued.job]);

	// Without a stated cause it is a plain loss.
	const u = setup();
	const other = u.queue.submit(spec("https://a.example/1"));
	u.queue.linkDown();
	assert.equal((await settled(other.promise)).error?.code, "browser_disconnected");
	assert.equal((await settled(other.promise)).error?.retryable, true);
});

test("link loss: a queued job still ends at its own deadline", async () => {
	const t = setup();
	t.queue.submit(spec("https://a.example/1"));
	const queued = t.queue.submit(spec("https://b.example/1"));
	t.queue.linkDown();
	t.clock.advance(119999);
	assert.equal(await peek(queued.promise), "pending");
	t.clock.advance(1);
	assert.equal((await settled(queued.promise)).error?.code, "queue_timeout");
});

test("a result that arrives after link loss is dropped", async () => {
	const t = setup();
	const h = t.queue.submit(spec("https://a.example/1"));
	t.queue.linkDown();
	t.queue.linkUp(defaultState());
	t.queue.onResult(makeResult(t.starts()[0]));
	assert.equal((await settled(h.promise)).error?.code, "browser_disconnected");
	assert.equal(t.audit.length, 1);
});

test("no extension: new jobs fail fast", async () => {
	const t = setup({ connected: false });
	const h = t.queue.submit(spec("https://a.example/1"));
	const report = await settled(h.promise);
	assert.equal(report.outcome, "error");
	assert.equal(report.error?.code, "extension_not_connected");
	assert.equal(report.error?.retryable, true);
	assert.equal(t.sent.length, 0);
	assert.equal(t.audit[0].code, "extension_not_connected");
	assert.equal(t.clock.pending, 0, "a refused job leaves no timer behind");
});

test("paused: new jobs fail fast with code paused", async () => {
	const t = setup({ connected: false });
	t.queue.linkUp({ ...defaultState(), paused: true, pause_reason: "operator" });
	const h = t.queue.submit(spec("https://a.example/1"));
	const report = await settled(h.promise);
	assert.equal(report.outcome, "error");
	assert.deepEqual(report.error, { code: "paused", message: "the operator paused the gateway", retryable: false, retry_after_s: null });
	assert.equal(t.sent.length, 0);

	// Resumed: jobs run again.
	t.queue.setState(defaultState());
	t.queue.submit(spec("https://a.example/2"));
	assert.equal(t.starts().length, 1);
});

test("paused: the queue is emptied, the running job is left to the extension", async () => {
	const t = setup();
	const running = t.queue.submit(spec("https://a.example/1"));
	const queued1 = t.queue.submit(spec("https://b.example/1"));
	const queued2 = t.queue.submit(spec("https://c.example/1"));
	t.queue.setState({ ...defaultState(), paused: true, pause_reason: "operator" });

	for (const h of [queued1, queued2]) assert.equal((await settled(h.promise)).error?.code, "paused");
	assert.equal(await peek(running.promise), "pending");
	t.queue.onResult(makeResult(t.starts()[0], { outcome: "aborted" }));
	assert.equal((await settled(running.promise)).outcome, "aborted");

	// Nothing bursts out on resume.
	t.clock.advance(60000);
	t.queue.setState(defaultState());
	assert.equal(t.starts().length, 1);
	assert.equal(t.clock.pending, 0);
});

test("queue limit: further jobs are refused, not buffered", async () => {
	const t = setup({ limits: { maxQueued: 2 } });
	t.queue.submit(spec("https://a.example/1"));
	t.queue.submit(spec("https://a.example/2"));
	t.queue.submit(spec("https://a.example/3"));
	const over = t.queue.submit(spec("https://a.example/4"));
	assert.equal((await settled(over.promise)).error?.code, "queue_full");
	assert.deepEqual(t.queue.stats(), { queued: 2, dispatched: 1 });
});

test("queue limit: callers that join a job in flight count against it too", async () => {
	const t = setup({ limits: { maxQueued: 3 } });
	const running = t.queue.submit(spec("https://a.example/1"));
	// Joining the running job: the first caller holds the slot, the others hold a place.
	const joins = [1, 2, 3].map(() => t.queue.submit(spec("https://a.example/1")));
	assert.ok(joins.every((j) => j.deduped && j.job === running.job));
	const fourth = t.queue.submit(spec("https://a.example/1"));
	assert.equal(fourth.deduped, false, "refused, not joined");
	assert.deepEqual((await settled(fourth.promise)).error, { code: "queue_full", message: "too many jobs are waiting", retryable: true, retry_after_s: null });
	// The same limit covers new jobs: nothing more is queued either.
	const other = t.queue.submit(spec("https://b.example/1"));
	assert.equal((await settled(other.promise)).error?.code, "queue_full");
	assert.deepEqual(t.queue.stats(), { queued: 0, dispatched: 1 });

	// A caller that leaves frees its place.
	joins[0].release();
	const again = t.queue.submit(spec("https://a.example/1"));
	assert.equal(again.deduped, true);
	t.queue.onResult(makeResult(t.starts()[0]));
	for (const h of [running, ...joins.slice(1), again]) assert.equal((await settled(h.promise)).outcome, "ok");
	assert.equal(t.audit.filter((e) => e.outcome === "ok")[0].callers, 5);

	// Joining a queued job counts the same way.
	const q = setup({ limits: { maxQueued: 2 } });
	q.queue.submit(spec("https://a.example/1"));
	const queued = q.queue.submit(spec("https://a.example/2"));
	assert.equal(q.queue.submit(spec("https://a.example/2")).job, queued.job);
	const third = q.queue.submit(spec("https://a.example/2"));
	assert.equal((await settled(third.promise)).error?.code, "queue_full");
	assert.deepEqual(q.queue.stats(), { queued: 1, dispatched: 1 });

	// Hundreds of identical requests cannot pile up behind one job.
	const many = setup();
	const first = many.queue.submit(spec("https://a.example/1"));
	let joined = 0;
	let refused = 0;
	for (let i = 0; i < 500; i++) {
		const h = many.queue.submit(spec("https://a.example/1"));
		if (h.job === first.job) joined++;
		else refused++;
	}
	assert.equal(joined, LIMITS.maxQueued);
	assert.equal(refused, 500 - LIMITS.maxQueued);
});

test("run budget: no wait values keep a slot longer than maxRunMs", async () => {
	// The largest values POST /v1/jobs lets through stay below the cap by themselves.
	// Loading (at the longest limit an operator can set), settling, dwell and both grace periods. Waiting for the
	// operator is no part of a run: such a job is parked and leaves the slot.
	const sum = JOB_WAIT_MAX.timeout_ms + JOB_WAIT_MAX.settle_ms + JOB_WAIT_MAX.dwell_ms + LIMITS.runGraceMs + LIMITS.challengeGraceMs + LIMITS.fileGraceMs;
	assert.ok(sum <= LIMITS.maxRunMs, `${sum} ms`);
	assert.equal(LIMITS.maxQueueMs + LIMITS.maxRunMs, 360000, "the documented maximum life of a job is six minutes");

	// A caller that asks for the maxima the wire format allows (21 minutes before the fix) is cut at the cap.
	const t = setup();
	const greedy = t.queue.submit(spec("https://a.example/1", { wait: { timeout_ms: 300000, settle_ms: 30000, dwell_ms: 30000, human_wait_ms: 900000, scroll: "lazy" } }));
	const next = t.queue.submit(spec("https://b.example/1"));
	t.clock.advance(LIMITS.maxRunMs - 1);
	assert.equal(await peek(greedy.promise), "pending");
	t.clock.advance(1);
	const report = await settled(greedy.promise);
	assert.equal(report.outcome, "timeout");
	assert.equal(report.error?.code, "deadline");
	assert.deepEqual(t.frames("job.cancel"), [{ v: PROTOCOL_VERSION, type: "job.cancel", job: greedy.job, reason: "deadline" }]);
	assert.equal(t.audit.find((e) => e.job === greedy.job)?.duration_ms, LIMITS.maxRunMs);
	// The job behind it timed out in the queue long before: queue time is bounded on its own.
	const waiting = await settled(next.promise);
	assert.equal(waiting.error?.code, "queue_timeout");
	assert.ok(t.audit.every((e) => e.duration_ms <= LIMITS.maxQueueMs + LIMITS.maxRunMs));

	const small = setup({ limits: { maxRunMs: 10000 } });
	const h = small.queue.submit(spec("https://a.example/1"));
	small.clock.advance(9999);
	assert.equal(await peek(h.promise), "pending");
	small.clock.advance(1);
	assert.equal((await settled(h.promise)).outcome, "timeout");
});

test("release: a job nobody waits for is cancelled", async () => {
	const t = setup();
	const running = t.queue.submit(spec("https://a.example/1"));
	const queued = t.queue.submit(spec("https://b.example/1"));

	queued.release();
	queued.release();
	const q = await settled(queued.promise);
	assert.equal(q.outcome, "aborted");
	assert.equal(q.error?.code, "client_gone");
	assert.equal(t.frames("job.cancel").length, 0, "a queued job was never sent, so there is nothing to cancel");

	running.release();
	assert.deepEqual(t.frames("job.cancel"), [{ v: PROTOCOL_VERSION, type: "job.cancel", job: running.job, reason: "client_gone" }]);
	assert.equal((await settled(running.promise)).outcome, "aborted");
	assert.deepEqual(t.queue.stats(), { queued: 0, dispatched: 0 });
});

test("release: a shared job keeps running while one caller still waits", async () => {
	const t = setup();
	const first = t.queue.submit(spec("https://a.example/1"));
	const second = t.queue.submit(spec("https://a.example/1"));
	first.release();
	assert.equal(t.frames("job.cancel").length, 0);
	assert.equal(await peek(second.promise), "pending");
	t.queue.onResult(makeResult(t.starts()[0]));
	assert.equal((await settled(second.promise)).outcome, "ok");
	// Releasing after the end is harmless.
	second.release();
	assert.equal(t.frames("job.cancel").length, 0);
});

test("an isolated job never returns content fetched with the default cookie store", async () => {
	const t = setup();
	const h = t.queue.submit(spec("https://a.example/1", { session: "isolated" }));
	t.queue.onResult(makeResult(t.starts()[0], { cookie_scope: "default" }));
	const report = await settled(h.promise);
	assert.equal(report.outcome, "error");
	assert.equal(report.error?.code, "scope_violation");
	assert.equal(report.content, null);
	assert.equal(report.page, null);
	assert.equal(t.audit[0].cookie_scope, "default");
	assert.ok(t.logs.some((l) => l.level === "error" && l.event === "job.scope_violation"));

	// With session auto the extension may use the default store (login opt-in).
	const a = t.queue.submit(spec("https://b.example/1"));
	t.clock.advance(2000);
	t.queue.onResult(makeResult(t.starts()[1], { cookie_scope: "default" }));
	assert.equal((await settled(a.promise)).outcome, "ok");
});

test("audit: scope from job.accepted is kept when the job ends without a result", async () => {
	const t = setup();
	const h = t.queue.submit(spec("https://a.example/1"));
	t.queue.onAccepted({ job: h.job, cookie_scope: "default", rule: { host: "a.example", path_prefix: "/", subdomains: false } });
	t.queue.onProgress({ job: h.job, phase: "navigating", http_status: null });
	t.clock.advance(37500);
	await settled(h.promise);
	assert.equal(t.audit[0].cookie_scope, "default");
	assert.equal(t.audit[0].dispatched, true);
	assert.equal(t.audit[0].host, "a.example");
	// Messages about jobs that are not running are ignored.
	t.queue.onAccepted({ job: "j_unknown", cookie_scope: "container", rule: null });
	t.queue.onProgress({ job: "j_unknown", phase: "settling", http_status: 200 });
	assert.equal(t.logs.filter((l) => l.event === "job.message_dropped").length, 2);
});

const LOGIN_RULE_A = { host: "a.example", path_prefix: "/", subdomains: false };

test("scope: a job the extension took with the operator's login stays one, whatever its result claims", async () => {
	const t = setup();
	const h = t.queue.submit(spec("https://a.example/inbox"));
	t.queue.onAccepted({ job: h.job, cookie_scope: "default", rule: LOGIN_RULE_A });
	// The result names the container: as a container page it would be stored and indexed in full.
	t.queue.onResult(makeResult(t.starts()[0], { cookie_scope: "container" }));
	const r = await settled(h.promise);
	assert.equal(r.outcome, "ok");
	assert.equal(r.cookie_scope, "default", "it is handed on as what it was taken as");
	assert.equal(r.content?.markdown, "# Fixture page\n\nhello world", "and is shown once, like any page read with the login");
	assert.equal(t.audit[0].cookie_scope, "default");
	assert.deepEqual(t.logs.filter((l) => l.event === "job.scope_mismatch"), [{ level: "error", event: "job.scope_mismatch", fields: { job: h.job, accepted: "default", result: "container" } }]);

	// A result without a scope - no tab was opened - is no claim: the job is still one with the login, and nothing is logged.
	t.clock.advance(60000);
	const none = t.queue.submit(spec("https://a.example/inbox/2"));
	t.queue.onAccepted({ job: none.job, cookie_scope: "default", rule: LOGIN_RULE_A });
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1)), { outcome: "error", cookie_scope: null, content: null, page: null, error: { code: "dns_failed", message: "x", retryable: true, retry_after_s: null } }));
	assert.equal((await settled(none.promise)).cookie_scope, "default");
	assert.equal(t.logs.filter((l) => l.event === "job.scope_mismatch").length, 1);

	// A job that had to run in the container and was taken with the login is refused, whatever its result says.
	t.clock.advance(60000);
	const isolated = t.queue.submit(spec("https://a.example/inbox/3", { session: "isolated" }));
	t.queue.onAccepted({ job: isolated.job, cookie_scope: "default", rule: LOGIN_RULE_A });
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1)), { cookie_scope: "container" }));
	const ri = await settled(isolated.promise);
	assert.equal(ri.error?.code, "scope_violation");
	assert.equal(ri.content, null);

	// The other way round the result is taken at its word, which is the stricter of the two, and the disagreement is logged.
	t.clock.advance(60000);
	const other = t.queue.submit(spec("https://a.example/inbox/4"));
	t.queue.onAccepted({ job: other.job, cookie_scope: "container", rule: null });
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1)), { cookie_scope: "default" }));
	assert.equal((await settled(other.promise)).cookie_scope, "default");
	assert.deepEqual(t.logs.filter((l) => l.event === "job.scope_mismatch").at(-1), { level: "warn", event: "job.scope_mismatch", fields: { job: other.job, accepted: "container", result: "default" } });
	// Where both agree nothing is said.
	t.clock.advance(60000);
	const same = t.queue.submit(spec("https://a.example/5"));
	t.queue.onAccepted({ job: same.job, cookie_scope: "container", rule: null });
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1))));
	assert.equal((await settled(same.promise)).cookie_scope, "container");
	assert.equal(t.logs.filter((l) => l.event === "job.scope_mismatch").length, 3);
});

test("scope: a file that comes with a result is not kept for a job the extension took with the operator's login", async () => {
	/** @type {string[]} */
	const sink = [];
	const t = setup({
		blobs: {
			accept: (job) => void sink.push(`accept:${job}`),
			complete: (job) => {
				sink.push(`complete:${job}`);
				return { ok: false, code: "file_transfer_failed", reason: "test", sniffed: null };
			},
			discard: (job) => void sink.push(`discard:${job}`),
		},
	});
	const h = t.queue.submit(spec("https://a.example/statement.pdf", { files: { max_bytes: 1048576, types: ["application/pdf"] } }));
	t.queue.onAccepted({ job: h.job, cookie_scope: "default", rule: LOGIN_RULE_A });
	t.queue.onResult(makeResult(t.starts()[0], { cookie_scope: "container", page: null, content: null, file: { name: "statement.pdf", charset: null, size: 4, sha256: "0".repeat(64), chunks: 1 } }));
	const r = await settled(h.promise);
	assert.equal(r.outcome, "error");
	assert.equal(r.error?.code, "file_unexpected");
	assert.equal(r.cookie_scope, "default");
	assert.equal(r.blob, undefined);
	assert.ok(!sink.some((x) => x.startsWith("complete:")), "what arrived is never put together");
	assert.ok(sink.includes(`discard:${h.job}`));
});

test("final address: a result from an address the URL policy does not allow ends the job as a policy refusal, with nothing of the page", async () => {
	/** @type {[string, string, import("../../daemon/src/queue.js").JobSpec["policy"]?][]} */
	const cases = [
		["http://192.168.1.1/admin", "private_address"],
		["http://[::1]:8080/", "private_address"],
		["http://[fd00::1]/", "private_address"],
		["https://169.254.169.254/latest/meta-data/", "private_address"],
		["https://router.local/status", "local_name"],
		["http://fileserver/", "single_label"],
		["https://mail.google.com/mail/u/0/", "blocklisted"],
		["https://www.paypal.com/myaccount", "blocklisted"],
		["https://wiki.corp.example/secret", "blocklisted", { blocklist: ["corp.example"] }],
		["https://user:secret@c.example/", "userinfo_not_allowed"],
		["file:///etc/passwd", "scheme_not_allowed"],
		["about:blank", "scheme_not_allowed"],
		["moz-extension://0d9f7a/page.html", "scheme_not_allowed"],
		["not a url", "invalid_url"],
		// Longer than an agent's URL may be: judged by its origin.
		[`http://10.0.0.7/${"a".repeat(3000)}`, "private_address"],
		[`https://accounts.google.com/signin?continue=${"a".repeat(3000)}`, "blocklisted"],
		[`https://user@c.example/${"a".repeat(3000)}`, "userinfo_not_allowed"],
		// A loopback fixture of a test run is allowed on its own ports and on no other.
		["http://127.0.0.1:9999/page", "private_address", { blocklist: [], allowLoopbackPorts: [8080] }],
	];
	for (const [finalUrl, code, policy] of cases) {
		const t = parkSetup({ pacing: COOL });
		const h = t.queue.submit(spec("https://a.example/1", policy === undefined ? {} : { policy }));
		t.clock.advance(700);
		t.queue.onResult(redirected(t.starts()[0], ["https://hop.example"], finalUrl, { content: { markdown: "SECRETBODY", text: "SECRETBODY", html: "<p>SECRETBODY</p>", raw_html: null, links: [{ url: "https://c.example/SECRETLINK", text: "SECRETLINK" }], results: [] } }));
		const r = await settled(h.promise);
		assert.equal(r.outcome, "policy_blocked", finalUrl.slice(0, 60));
		assert.deepEqual(r.error, { code, message: "the page ended at an address the gateway policy does not allow", retryable: false, retry_after_s: null }, finalUrl.slice(0, 60));
		assert.ok(!JSON.stringify(r).includes("SECRET"), "nothing the page wrote is in the report");
		assert.deepEqual([r.content, r.page, r.render, r.extraction, r.file, r.nav.final_url, r.nav.http_status], [null, null, null, null, null, null, null]);
		assert.equal(r.job, h.job);
		assert.equal(r.cookie_scope, "container");
		// Written down as what it is, with the way the load took.
		assert.deepEqual(t.audit.map((e) => [e.job, e.outcome, e.code, e.dispatched, e.redirect_origins, e.duration_ms]), [[h.job, "policy_blocked", code, true, ["https://hop.example"], 700]]);
		assert.deepEqual(t.logs.filter((l) => l.level === "error"), [{ level: "error", event: "job.final_url_refused", fields: { job: h.job, code } }]);
		// It is no word of the site that was asked: that one is not cooled.
		const next = t.queue.submit(spec("https://a.example/2"));
		assert.equal(t.starts().at(-1)?.job, next.job);
	}
});

test("final address: a result that is no page keeps its outcome and loses the address", async () => {
	const t = parkSetup({ pacing: COOL });
	const h = t.queue.submit(spec("https://a.example/1"));
	t.queue.onResult(redirected(t.starts()[0], [], "http://192.168.1.1/admin", { outcome: "blocked", content: null, page: null, error: { code: "http_403", message: "x", retryable: false, retry_after_s: null } }));
	const r = await settled(h.promise);
	assert.equal(r.outcome, "blocked");
	assert.equal(r.error?.code, "http_403");
	assert.equal(r.nav.final_url, null);
	assert.equal(t.logs.filter((l) => l.event === "job.final_url_refused").length, 1);
	// A block is still the site's word: it is left alone.
	assert.equal((await settled(t.queue.submit(spec("https://a.example/2")).promise)).error?.code, "site_cooldown");
});

test("final address: what the policy allows passes, as does a result that names no address", async () => {
	/** @type {[string | null, import("../../daemon/src/queue.js").JobSpec["policy"]?][]} */
	const cases = [
		["https://a.example/1"],
		["https://cdn.b.example:8443/x?y=1#frag"],
		["http://93.184.216.34/"],
		["https://[2606:2800:220:1:248:1893:25c8:1946]/"],
		[`https://login.b.example/return?state=${"a".repeat(6000)}`],
		["http://127.0.0.1:8080/page", { blocklist: [], allowLoopbackPorts: [8080] }],
		["https://mail.google.com/", { blocklist: [] }],
		// A failed load has no final address; neither has a page whose address the extension could not read.
		[null],
	];
	for (const [finalUrl, policy] of cases) {
		const t = setup();
		const h = t.queue.submit(spec("https://a.example/1", policy === undefined ? {} : { policy }));
		t.queue.onResult(redirected(t.starts()[0], [], finalUrl));
		const r = await settled(h.promise);
		assert.equal(r.outcome, "ok", String(finalUrl).slice(0, 60));
		assert.equal(r.nav.final_url, finalUrl);
		assert.equal(r.content?.markdown, "# Fixture page\n\nhello world");
		assert.equal(t.logs.filter((l) => l.level === "error").length, 0);
	}
});

test("final address: a file from an address the policy does not allow is not put together", async () => {
	/** @type {string[]} */
	const sink = [];
	const t = setup({ blobs: { accept: () => {}, complete: (job) => (sink.push(`complete:${job}`), { ok: false, code: "file_transfer_failed", reason: "test", sniffed: null }), discard: (job) => void sink.push(`discard:${job}`) } });
	const h = t.queue.submit(spec("https://a.example/report.pdf", { files: { max_bytes: 1048576, types: ["application/pdf"] } }));
	t.queue.onResult(redirected(t.starts()[0], ["http://10.0.0.7"], "http://10.0.0.7/internal.pdf", { page: null, content: null, file: { name: "internal.pdf", charset: null, size: 4, sha256: "0".repeat(64), chunks: 1 } }));
	const r = await settled(h.promise);
	assert.equal(r.outcome, "policy_blocked");
	assert.equal(r.error?.code, "private_address");
	assert.equal(r.blob, undefined);
	assert.deepEqual(sink, [`discard:${h.job}`]);
});

test("audit: redirect hops are passed on for origin reduction", async () => {
	const t = setup();
	const h = t.queue.submit(spec("https://a.example/1"));
	t.queue.onResult(makeResult(t.starts()[0], {
		nav: { requested_url: "https://a.example/1", final_url: "https://b.example/x?token=1", redirect_origins: ["https://a.example", "https://b.example"], http_status: 200, content_type: "text/html", body_bytes: null },
	}));
	await settled(h.promise);
	assert.deepEqual(t.audit[0].redirect_origins, ["https://a.example", "https://b.example"]);
	assert.equal(t.audit[0].url, "https://a.example/1");
});

test("audit: whether the browser was asked is recorded, for every way a job can end", async () => {
	const t = setup({ limits: { maxQueued: 1 } });
	const ran = t.queue.submit(spec("https://a.example/1"));
	const waited = t.queue.submit(spec("https://b.example/1"));
	const refused = t.queue.submit(spec("https://c.example/1"));
	await settled(refused.promise);
	t.queue.linkDown();
	await settled(ran.promise);
	t.clock.advance(LIMITS.maxQueueMs);
	await settled(waited.promise);
	assert.deepEqual(
		t.audit.map((e) => [e.host, e.code, e.dispatched, e.cookie_scope]),
		[
			["c.example", "queue_full", false, null],
			["a.example", "browser_disconnected", true, null],
			["b.example", "queue_timeout", false, null],
		],
	);
});

test("a frame that cannot be sent leaves the job queued", async () => {
	const t = setup();
	t.setLinkOpen(false);
	const h = t.queue.submit(spec("https://a.example/1"));
	assert.deepEqual(t.queue.stats(), { queued: 1, dispatched: 0 });
	assert.equal(await peek(h.promise), "pending");
	t.setLinkOpen(true);
	t.queue.setState(defaultState());
	assert.equal(t.starts().length, 1);
});

test("shutdown: everything is resolved as aborted and running jobs are cancelled", async () => {
	const t = setup();
	const running = t.queue.submit(spec("https://a.example/1"));
	const queued = t.queue.submit(spec("https://b.example/1"));
	t.queue.shutdown();
	assert.deepEqual(t.frames("job.cancel"), [{ v: PROTOCOL_VERSION, type: "job.cancel", job: running.job, reason: "shutdown" }]);
	for (const h of [running, queued]) {
		const r = await settled(h.promise);
		assert.equal(r.outcome, "aborted");
		assert.equal(r.error?.code, "shutdown");
	}
	const late = t.queue.submit(spec("https://c.example/1"));
	assert.equal((await settled(late.promise)).error?.code, "shutdown");
	assert.equal(t.clock.pending, 0, "no timer survives shutdown");
});

test("siteOf: registrable-domain approximation", () => {
	/** @type {[string, string][]} */
	const table = [
		["example.com", "example.com"],
		["www.example.com", "example.com"],
		["a.b.c.d.example.com", "example.com"],
		["EXAMPLE.com.", "example.com"],
		["s1.evil.example", "evil.example"],
		["s31.evil.example", "evil.example"],
		["example.co.uk", "example.co.uk"],
		["www.example.co.uk", "example.co.uk"],
		["a.b.example.com.au", "example.com.au"],
		["x.example.org.nz", "example.org.nz"],
		["x.example.net.br", "example.net.br"],
		["x.example.gov.uk", "example.gov.uk"],
		["x.example.ac.jp", "example.ac.jp"],
		["x.example.edu.au", "example.edu.au"],
		// Only under a two-letter country code: "co.example.com" is a host of example.com.
		["x.co.example.com", "example.com"],
		["x.com.example.org", "example.org"],
		// A second-level label that is not on the list is taken for the name itself.
		["x.example.de", "example.de"],
		["a.example.blog.fr", "blog.fr"],
		["co.uk", "co.uk"],
		["uk", "uk"],
		["localhost", "localhost"],
		// An IPv4 address is its own site.
		["93.184.216.34", "93.184.216.34"],
		// An IPv6 address is one of 2^64 in its network: the /64 is the site (N3).
		["[2001:db8::1]", "[2001:db8:0:0::/64]"],
		["[2001:db8::2]", "[2001:db8:0:0::/64]"],
		["[2001:db8:0:0:ffff:ffff:ffff:ffff]", "[2001:db8:0:0::/64]"],
		["[2001:DB8:0:1::1]", "[2001:db8:0:1::/64]"],
		["[2a00:1450:4001:82b::200e]", "[2a00:1450:4001:82b::/64]"],
		["[2a00:1450:4001:82b:1:2:3:4]", "[2a00:1450:4001:82b::/64]"],
		["[2a00:1450:4001:82c::200e]", "[2a00:1450:4001:82c::/64]"],
		["2a00:1450:4001:82b::1", "[2a00:1450:4001:82b::/64]"],
		// An IPv4 address written as IPv6 is that IPv4 address.
		["[::ffff:93.184.216.34]", "93.184.216.34"],
		["[::ffff:5db8:d822]", "93.184.216.34"],
		// What does not parse is left as it is: one site.
		["[not:an:address]", "[not:an:address]"],
		["xn--bcher-kva.example", "xn--bcher-kva.example"],
		["a.xn--bcher-kva.example", "xn--bcher-kva.example"],
	];
	for (const [host, site] of table) assert.equal(siteOf(host), site, host);
});

test("pacing is per site: subdomains share one gap", () => {
	const t = setup();
	// Before the fix every sN.evil.example was its own host and only the global gap applied.
	for (let i = 1; i <= 5; i++) t.queue.submit(spec(`https://s${i}.evil.example/`));
	t.queue.submit(spec("https://other.example/"));
	assert.deepEqual(t.starts().map((f) => f.url), ["https://s1.evil.example/"]);
	t.queue.onResult(makeResult(t.starts()[0]));
	// Global gap 2 s: the other site goes next, the same site waits its 10 s.
	t.clock.advance(2000);
	assert.deepEqual(t.starts().map((f) => f.url), ["https://s1.evil.example/", "https://other.example/"]);
	t.queue.onResult(makeResult(t.starts()[1]));
	t.clock.advance(7999);
	assert.equal(t.starts().length, 2);
	t.clock.advance(1);
	assert.deepEqual(t.starts().map((f) => f.url)[2], "https://s2.evil.example/");

	// Over a minute: 60 s / 10 s gap = 6 loads of the site, not 30.
	const m = setup();
	for (let i = 1; i <= 40; i++) m.queue.submit(spec(`https://s${i}.evil.example/`));
	for (let ms = 0; ms < 60000; ms += 100) {
		const running = m.starts().length;
		if (running > 0 && m.queue.stats().dispatched === 1) m.queue.onResult(makeResult(m.starts()[running - 1]));
		m.clock.advance(100);
	}
	assert.ok(m.starts().length <= 7, `${m.starts().length} loads in a minute`);
	assert.ok(m.starts().length >= 5);
});

test("pacing is per site: the addresses of one IPv6 /64 share one gap and one budget (N3)", async () => {
	const t = setup();
	// Before the fix every address was its own site: 61 jobs a minute.
	for (let i = 1; i <= 5; i++) t.queue.submit(spec(`https://[2a00:1450:4001:82b::${i.toString(16)}]/`));
	t.queue.submit(spec("https://[2a00:1450:4001:82c::1]/"));
	assert.deepEqual(t.starts().map((f) => f.url), ["https://[2a00:1450:4001:82b::1]/"]);
	t.queue.onResult(makeResult(t.starts()[0]));
	// Global gap 2 s: the other network goes next, the same one waits its 10 s.
	t.clock.advance(2000);
	assert.deepEqual(t.starts().map((f) => f.url), ["https://[2a00:1450:4001:82b::1]/", "https://[2a00:1450:4001:82c::1]/"]);
	t.queue.onResult(makeResult(t.starts()[1]));
	t.clock.advance(7999);
	assert.equal(t.starts().length, 2);
	t.clock.advance(1);
	assert.equal(t.starts()[2].url, "https://[2a00:1450:4001:82b::2]/");

	const m = setup();
	for (let i = 1; i <= 40; i++) m.queue.submit(spec(`https://[2a00:1450:4001:82b:${i.toString(16)}::1]/`));
	for (let ms = 0; ms < 60000; ms += 100) {
		const running = m.starts().length;
		if (running > 0 && m.queue.stats().dispatched === 1) m.queue.onResult(makeResult(m.starts()[running - 1]));
		m.clock.advance(100);
	}
	assert.ok(m.starts().length <= 7, `${m.starts().length} loads in a minute`);

	// The hourly budget is the network's too.
	const b = setup({ pacing: { polite: { hostGapMs: [0, 0], globalGapMs: [0, 0], dwellMs: [0, 0], hourlyBudget: 3 }, fast: PACING.fast } });
	for (let i = 1; i <= 3; i++) {
		b.queue.submit(spec(`https://[2a00:1450:4001:82b::${i}]/`));
		b.queue.onResult(makeResult(b.starts()[i - 1]));
	}
	assert.equal((await settled(b.queue.submit(spec("https://[2a00:1450:4001:82b::9]/")).promise)).error?.code, "site_budget");
	assert.equal(await peek(b.queue.submit(spec("https://[2a00:1450:4001:82c::9]/")).promise), "pending");
});

test("hourly budget per site: over it, a job is refused with the time until it frees", async () => {
	const pacing = {
		polite: { ...PACING.polite, hostGapMs: /** @type {const} */ ([0, 0]), globalGapMs: /** @type {const} */ ([0, 0]), hourlyBudget: 3 },
		fast: { ...PACING.fast, hostGapMs: /** @type {const} */ ([0, 0]), globalGapMs: /** @type {const} */ ([0, 0]), hourlyBudget: 5 },
	};
	const t = setup({ pacing, fastHosts: ["docs.example"] });
	/** @param {string} url */
	const run = async (url) => {
		const h = t.queue.submit(spec(url));
		const before = t.starts().length;
		if (t.queue.stats().dispatched === 1) t.queue.onResult(makeResult(t.starts()[before - 1]));
		return settled(h.promise);
	};
	// Three loads of the site, spread over its subdomains, ten minutes apart.
	for (const host of ["a.shop.example", "b.shop.example", "shop.example"]) {
		assert.equal((await run(`https://${host}/`)).outcome, "ok");
		t.clock.advance(600000);
	}
	// 30 minutes after the first load: the fourth is refused, and says for how long.
	const refused = await run("https://c.shop.example/");
	assert.equal(refused.outcome, "error");
	assert.deepEqual(refused.error, { code: "site_budget", message: "the hourly budget for this site is used up", retryable: false, retry_after_s: 1800 });
	assert.equal(refused.content, null);
	assert.equal(t.starts().length, 3, "nothing was sent to the browser");
	assert.deepEqual(
		t.audit.slice(-1).map((e) => [e.host, e.outcome, e.code, e.dispatched]),
		[["c.shop.example", "error", "site_budget", false]],
	);
	// Other sites are not affected.
	assert.equal((await run("https://elsewhere.example/")).outcome, "ok");
	// One second before the hour is up it is still refused; then one place frees.
	t.clock.advance(1799000);
	assert.equal((await run("https://shop.example/x")).error?.retry_after_s, 1);
	t.clock.advance(1000);
	assert.equal((await run("https://shop.example/x")).outcome, "ok");
	const next = await run("https://shop.example/y");
	assert.equal(next.error?.code, "site_budget");
	assert.equal(next.error?.retry_after_s, 600, "until the second load of the hour leaves the window");

	// The fast profile has its own, larger budget.
	for (let i = 0; i < 5; i++) assert.equal((await run(`https://api.docs.example/${i}`)).outcome, "ok");
	assert.equal((await run("https://docs.example/6")).error?.code, "site_budget");

	// Jobs that wait in the queue count: the budget cannot be overbooked while the site is slow.
	const q = setup({ pacing });
	const handles = [1, 2, 3, 4].map((i) => q.queue.submit(spec(`https://shop.example/${i}`)));
	assert.deepEqual(q.queue.stats(), { queued: 2, dispatched: 1 });
	assert.equal((await settled(handles[3].promise)).error?.code, "site_budget");
	assert.equal((await settled(handles[3].promise)).error?.retry_after_s, 3600);
	// Joining a job in flight costs no load and no budget.
	assert.equal(q.queue.submit(spec("https://shop.example/1")).deduped, true);
});

test("hourly budget: defaults are set, no budget means no limit, and the bookkeeping stays small", async () => {
	assert.equal(DEFAULT_PACING.polite.hourlyBudget, 120);
	assert.equal(DEFAULT_PACING.fast.hourlyBudget, 1200);
	const t = setup({ pacing: { polite: { ...PACING.polite, hostGapMs: /** @type {const} */ ([0, 0]), globalGapMs: /** @type {const} */ ([0, 0]) }, fast: PACING.fast } });
	for (let i = 0; i < 2000; i++) {
		const h = t.queue.submit(spec(`https://site${i}.example/`));
		t.queue.onResult(makeResult(t.starts()[i]));
		assert.equal((await settled(h.promise)).outcome, "ok");
		t.clock.advance(4000);
	}
	// No profile budget: the same site any number of times.
	for (let i = 0; i < 300; i++) {
		const h = t.queue.submit(spec(`https://one.example/${i}`));
		t.queue.onResult(makeResult(t.starts()[2000 + i]));
		assert.equal((await settled(h.promise)).outcome, "ok");
	}
});

test("default profile: fast for every host when the operator says so", () => {
	const t = setup({ defaultProfile: "fast" });
	t.queue.submit(spec("https://a.example/1"));
	t.queue.submit(spec("https://a.example/2"));
	assert.equal(t.starts()[0].wait.dwell_ms, 200);
	t.queue.onResult(makeResult(t.starts()[0]));
	t.clock.advance(500);
	assert.equal(t.starts().length, 2);
	const p = setup({ defaultProfile: /** @type {any} */ ("turbo") });
	p.queue.submit(spec("https://a.example/1"));
	assert.equal(p.starts()[0].wait.dwell_ms, 1000, "anything else is polite");
});

// ---------------------------------------------------------------- parked jobs

const DETECT = Object.freeze({ kind: "cloudflare_challenge", evidence: "header cf-mitigated=challenge", waited_ms: 8000, resolved: null });
const MIN = 60000;
/** A job that may wait for the operator for a quarter of an hour. @param {string} url */
const parkable = (url) => spec(url, { wait: { timeout_ms: 30000, settle_ms: 1500, dwell_ms: null, human_wait_ms: 15 * MIN, scroll: "lazy" } });
const NO_GAPS = { polite: { hostGapMs: /** @type {const} */ ([0, 0]), globalGapMs: /** @type {const} */ ([0, 0]), dwellMs: /** @type {const} */ ([0, 0]) }, fast: PACING.fast };

/** @param {Parameters<typeof setup>[0]} [opts] the queue plus a record of what the challenge listener was told */
function parkSetup(opts = {}) {
	/** @type {string[]} */
	const told = [];
	const clock = new FakeClock();
	/** @type {Frame[]} */
	const sent = [];
	/** @type {import("../../daemon/src/audit.js").AuditEntry[]} */
	const audit = [];
	/** @type {{ level: string, event: string, fields: Record<string, unknown> }[]} */
	const logs = [];
	/** @param {string} level */
	const at = (level) => (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields = {}) => void logs.push({ level, event, fields });
	const queue = new JobQueue({
		clock,
		rng: opts.rng ?? (() => 0),
		log: { info: at("info"), warn: at("warn"), error: at("error") },
		audit: { append: (entry) => audit.push(entry) },
		send: (msg) => {
			assert.deepEqual(validateMessage(msg, DIRECTION.TO_EXT), { ok: true });
			sent.push(msg);
			return true;
		},
		pacing: opts.pacing ?? NO_GAPS,
		fastHosts: opts.fastHosts,
		limits: opts.limits,
		siteOf: opts.siteOf,
		onChallenge: {
			pending: (j) => told.push(`pending:${j.job}:${j.host}`),
			acked: (j) => told.push(`acked:${j.job}:${j.host}`),
			cleared: (j) => told.push(`cleared:${j.job}:${j.host}`),
			ended: (j) => told.push(`ended:${j.job}:${j.host}`),
		},
	});
	queue.linkUp(defaultState());
	const starts = () => sent.filter((f) => f.type === "job.start");
	/** Submit a job and have the extension park it. @param {string} url */
	const park = (url) => {
		const handle = queue.submit(parkable(url));
		const start = /** @type {Frame} */ (starts().find((f) => f.job === handle.job));
		assert.ok(start, "the job was dispatched");
		queue.onAccepted({ job: handle.job, cookie_scope: "container", rule: null });
		queue.onProgress({ job: handle.job, phase: "challenge_wait", http_status: 403 });
		queue.onEvent({ name: "challenge.pending", job: handle.job, detect: DETECT });
		return { handle, start };
	};
	return { clock, queue, sent, audit, logs, told, starts, park, frames: (/** @type {string} */ type) => sent.filter((f) => f.type === type) };
}

test("parked: challenge.pending takes the job out of its slot, the next job runs, and the job is not over", async () => {
	const t = parkSetup();
	const a = t.queue.submit(parkable("https://www.shop.example/item/1"));
	const b = t.queue.submit(spec("https://other.example/1"));
	assert.deepEqual(t.starts().map((f) => f.job), [a.job], "one slot");
	assert.equal(t.starts()[0].wait.human_wait_ms, 15 * MIN, "the extension is told how long the page may wait");
	t.queue.onAccepted({ job: a.job, cookie_scope: "container", rule: null });
	t.queue.onProgress({ job: a.job, phase: "challenge_wait", http_status: 403 });
	assert.equal(await peek(a.parked), "pending");
	t.clock.advance(8000);
	t.queue.onEvent({ name: "challenge.pending", job: a.job, detect: DETECT });

	// Whoever waits on the job is told at once what it waits for.
	assert.deepEqual(await a.parked, { job: a.job, host: "www.shop.example", cookie_scope: "container", http_status: 403, detect: DETECT, retry_after_s: 60, expires_in_s: 900 });
	assert.equal(await peek(a.promise), "pending", "its report is still to come");
	assert.deepEqual(t.queue.stats(), { queued: 0, dispatched: 1 }, "the slot went to the next job");
	assert.deepEqual(t.starts().map((f) => f.job), [a.job, b.job]);
	assert.equal(t.queue.pendingCount(), 1);
	assert.deepEqual(t.queue.pending(), [{ job: a.job, host: "www.shop.example", kind: "cloudflare_challenge", waiting_s: 0, expires_in_s: 900, acked: false }]);
	assert.deepEqual(t.told, [`pending:${a.job}:www.shop.example`]);
	assert.equal(t.audit.length, 0, "nothing is written down before a job is over");
	assert.equal(t.frames("job.cancel").length, 0);

	// The other job comes and goes; the parked one is untouched.
	t.queue.onResult(makeResult(t.starts()[1]));
	assert.equal((await settled(b.promise)).outcome, "ok");
	assert.equal(await peek(a.promise), "pending");
	t.clock.advance(5 * MIN);
	assert.deepEqual(t.queue.pending().map((p) => [p.waiting_s, p.expires_in_s]), [[300, 600]]);
	// A job that ends without ever being parked says so to whoever asked.
	assert.equal(await b.parked, null);
});

test("parked: the result of a parked job ends it - cleared and read, the page is the report", async () => {
	const t = parkSetup();
	const { handle, start } = t.park("https://www.shop.example/item/1");
	t.clock.advance(4 * MIN);
	const cleared = makeResult(start, { detect: { ...DETECT, waited_ms: 248000, resolved: "cleared_by_operator" } });
	t.queue.onResult(cleared);
	const report = await settled(handle.promise);
	assert.equal(report, cleared, "the extension's result, as it came");
	assert.equal(t.queue.pendingCount(), 0);
	assert.deepEqual(t.told, [`pending:${handle.job}:www.shop.example`, `ended:${handle.job}:www.shop.example`]);
	assert.deepEqual(t.audit.map((e) => [e.job, e.outcome, e.code, e.dispatched, e.duration_ms]), [[handle.job, "ok", null, true, 4 * MIN]]);
	assert.equal(t.clock.pending, 0, "the park deadline is gone");
	// A second result for it is dropped like any other.
	t.queue.onResult(cleared);
	assert.ok(t.logs.some((l) => l.event === "job.result_dropped" && l.fields.reason === "unknown_or_duplicate"));
	// The site is asked again without delay: the operator cleared it.
	const next = t.queue.submit(spec("https://www.shop.example/item/2"));
	assert.equal(t.starts().at(-1)?.job, next.job);
});

test("parked: the extension owns the expiry; the daemon's own deadline runs a minute longer and only fires if nothing came", async () => {
	assert.equal(LIMITS.parkGraceMs, 60000);
	const t = parkSetup();
	// The normal case: the extension reports the expiry itself.
	const a = t.park("https://a.example/1");
	t.clock.advance(15 * MIN);
	t.queue.onResult(makeResult(a.start, { outcome: "timeout", content: null, page: null, detect: { ...DETECT, waited_ms: 900000 }, error: { code: "challenge_expired", message: "nobody cleared the human check in time", retryable: true, retry_after_s: null } }));
	const ra = await settled(a.handle.promise);
	assert.equal(ra.outcome, "timeout");
	assert.equal(ra.error?.code, "challenge_expired");
	assert.equal(t.frames("job.cancel").length, 0, "no cancel was needed");

	// The backstop: an extension that says nothing.
	const b = t.park("https://b.example/1");
	t.clock.advance(15 * MIN + LIMITS.parkGraceMs - 1);
	assert.equal(await peek(b.handle.promise), "pending");
	assert.equal(t.queue.pendingCount(), 1);
	t.clock.advance(1);
	const rb = await settled(b.handle.promise);
	assert.equal(rb.outcome, "timeout");
	assert.deepEqual(rb.error, { code: "challenge_expired", message: "nobody cleared the human check in time", retryable: true, retry_after_s: null });
	assert.deepEqual(rb.detect, DETECT, "what was detected is in the daemon's own report too");
	assert.equal(rb.nav.http_status, 403);
	assert.equal(rb.cookie_scope, "container");
	assert.equal(rb.render, null, "made by the daemon");
	assert.deepEqual(t.frames("job.cancel").map((f) => [f.job, f.reason]), [[b.handle.job, "deadline"]]);
	assert.equal(t.queue.pendingCount(), 0);
	assert.equal(t.told.at(-1), `ended:${b.handle.job}:b.example`);
	// Its late result is dropped; no slot was held for it, so nothing waits for that.
	t.queue.onResult(makeResult(b.start));
	assert.equal(t.clock.pending, 0);
});

test("parked: a parked job is outside the run budget - no run deadline fires while it waits", async () => {
	const t = parkSetup();
	const { handle } = t.park("https://a.example/1");
	// Far beyond anything a running job may take.
	assert.ok(LIMITS.maxRunMs < 10 * MIN);
	t.clock.advance(10 * MIN);
	assert.equal(await peek(handle.promise), "pending");
	assert.equal(t.frames("job.cancel").length, 0);
	assert.equal(t.queue.pendingCount(), 1);
});

test("parked: the grace period of a challenge is granted once, on top of what the job has left", async () => {
	assert.equal(LIMITS.challengeGraceMs, 45000);
	const t = parkSetup();
	const a = t.queue.submit(parkable("https://a.example/1"));
	// Run budget without a challenge: 30 s + 1.5 s + 0 + 5 s.
	t.clock.advance(20000);
	t.queue.onProgress({ job: a.job, phase: "challenge_wait", http_status: 403 });
	t.clock.advance(16500 + 45000 - 1);
	assert.equal(await peek(a.promise), "pending", "36.5 s have long passed: the grace period was added");
	// Asking again changes nothing.
	t.queue.onProgress({ job: a.job, phase: "challenge_wait", http_status: 403 });
	t.clock.advance(1);
	assert.equal((await settled(a.promise)).error?.code, "deadline");
	// Never beyond the longest a job may run.
	const u = parkSetup({ limits: { maxRunMs: 50000 } });
	const b = u.queue.submit(parkable("https://b.example/1"));
	u.clock.advance(30000);
	u.queue.onProgress({ job: b.job, phase: "challenge_wait", http_status: 403 });
	u.clock.advance(19999);
	assert.equal(await peek(b.promise), "pending");
	u.clock.advance(1);
	assert.equal((await settled(b.promise)).error?.code, "deadline");
	// A job that never met a challenge keeps the deadline it had.
	const v = parkSetup();
	const c = v.queue.submit(parkable("https://c.example/1"));
	v.queue.onProgress({ job: c.job, phase: "settling", http_status: 200 });
	v.clock.advance(36500);
	assert.equal((await settled(c.promise)).error?.code, "deadline");
});

test("a file gets time for its bytes to come over: granted once, only to a job that may bring one, never beyond the cap", async () => {
	assert.equal(LIMITS.fileGraceMs, 20000);
	const files = { max_bytes: 1048576, types: ["application/pdf"] };
	const t = parkSetup();
	const a = t.queue.submit(spec("https://a.example/1", { files }));
	// Run budget of this job: 30 s + 1.5 s + 0 + 5 s. The response ended shortly before that.
	t.clock.advance(36000);
	t.queue.onProgress({ job: a.job, phase: "receiving_file", http_status: 200 });
	t.clock.advance(500 + 20000 - 1);
	assert.equal(await peek(a.promise), "pending", "the time for the transfer was added");
	t.queue.onProgress({ job: a.job, phase: "receiving_file", http_status: 200 });
	t.clock.advance(1);
	assert.equal((await settled(a.promise)).error?.code, "deadline");
	// A job that was not allowed a file gains nothing by saying it receives one.
	const u = parkSetup();
	const b = u.queue.submit(spec("https://b.example/1", { files: null }));
	u.clock.advance(36000);
	u.queue.onProgress({ job: b.job, phase: "receiving_file", http_status: 200 });
	u.clock.advance(500);
	assert.equal((await settled(b.promise)).error?.code, "deadline");
	// Never beyond the longest a job may run.
	const v = parkSetup({ limits: { maxRunMs: 40000 } });
	const c = v.queue.submit(spec("https://c.example/1", { files }));
	v.clock.advance(36000);
	v.queue.onProgress({ job: c.job, phase: "receiving_file", http_status: 200 });
	v.clock.advance(3999);
	assert.equal(await peek(c.promise), "pending");
	v.clock.advance(1);
	assert.equal((await settled(c.promise)).error?.code, "deadline");
});

test("parked: at most three, one per site - what the extension parks beyond that is ended", async () => {
	assert.equal(LIMITS.maxParked, 3);
	const t = parkSetup();
	const kept = [t.park("https://a.example/1"), t.park("https://b.example/1"), t.park("https://c.example/1")];
	assert.equal(t.queue.pendingCount(), 3);
	// The extension keeps to the same limit and would report needs_human itself. If it parked a fourth all the same:
	const d = t.queue.submit(parkable("https://d.example/1"));
	t.queue.onEvent({ name: "challenge.pending", job: d.job, detect: DETECT });
	const rd = await settled(d.promise);
	assert.equal(rd.outcome, "needs_human");
	assert.equal(rd.error?.code, "too_many_pending");
	assert.deepEqual(rd.detect, DETECT);
	assert.deepEqual(t.frames("job.cancel").map((f) => f.job), [d.job], "and the extension is told to let go of it");
	assert.equal(await d.parked, null, "it was never parked");
	assert.equal(t.queue.pendingCount(), 3);
	assert.equal(t.told.filter((x) => x.startsWith("pending:")).length, 3, "nobody is called for it");
	// Its slot is held until the extension confirms, like after any cancel.
	const e = t.queue.submit(spec("https://e.example/1"));
	assert.equal(t.starts().some((f) => f.job === e.job), false);
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().find((f) => f.job === d.job)), { outcome: "aborted" }));
	assert.equal(t.starts().at(-1)?.job, e.job);
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1))));
	// One of the three ends: the next challenge is kept again.
	t.queue.onResult(makeResult(kept[1].start));
	const f = t.park("https://f.example/1");
	assert.deepEqual(t.queue.pending().map((p) => p.host), ["a.example", "c.example", "f.example"]);
	assert.equal(await peek(f.handle.promise), "pending");
	// A job that may not wait for the operator at all is not kept either.
	const u = parkSetup();
	const g = u.queue.submit(spec("https://g.example/1"));
	u.queue.onEvent({ name: "challenge.pending", job: g.job, detect: DETECT });
	assert.equal((await settled(g.promise)).outcome, "needs_human");
	assert.equal(u.queue.pendingCount(), 0);
});

test("parked: a new job for a site whose challenge waits is not dispatched and is pointed at the job that waits", async () => {
	const t = parkSetup();
	const { handle } = t.park("https://www.shop.example/item/1");
	const dispatched = t.starts().length;
	// Another host of the same site, another URL.
	const second = t.queue.submit(spec("https://forum.shop.example/thread/9"));
	const r = await settled(second.promise);
	assert.equal(r.outcome, "needs_human");
	assert.equal(r.job, handle.job, "the report names the job that waits");
	assert.notEqual(second.job, handle.job);
	assert.deepEqual(r.error, { code: "challenge_pending", message: "a human check of this site is waiting for the operator", retryable: true, retry_after_s: 60 });
	assert.deepEqual(r.detect, DETECT);
	assert.equal(r.render, null);
	assert.equal(await second.parked, null);
	assert.equal(t.starts().length, dispatched, "nothing was sent to the browser");
	assert.deepEqual(t.audit.map((e) => [e.job, e.outcome, e.code, e.dispatched, e.host]), [[second.job, "needs_human", "challenge_pending", false, "forum.shop.example"]]);
	// Shortly before the wait is over, "come back when it is".
	t.clock.advance(15 * MIN - 20000);
	assert.equal((await settled(t.queue.submit(spec("https://shop.example/x")).promise)).error?.retry_after_s, 20);
	// Another site is served.
	const other = t.queue.submit(spec("https://elsewhere.example/1"));
	assert.equal(t.starts().at(-1)?.job, other.job);
	// The same URL again joins the job that waits: no second load, and it is told how things stand now.
	const joined = t.queue.submit(parkable("https://www.shop.example/item/1"));
	assert.equal(joined.deduped, true);
	assert.equal(joined.job, handle.job);
	const info = await joined.parked;
	assert.equal(info?.job, handle.job);
	assert.equal(info?.expires_in_s, 20);
	// The extension parking a second job of a site (it should not) is ended the same way.
	const u = parkSetup();
	u.park("https://www.shop.example/1");
	const racing = u.queue.submit(parkable("https://www.other.example/1"));
	// (made to look like the same site by the time it parks: two jobs that were both running cannot exist with one slot,
	// so this is the defensive path only)
	u.queue.onEvent({ name: "challenge.pending", job: racing.job, detect: DETECT });
	assert.equal(u.queue.pendingCount(), 2, "another site: kept");
});

test("parked: callers come and go without touching the job - it lives until its own end", async () => {
	const t = parkSetup();
	const { handle, start } = t.park("https://a.example/1");
	// The first caller was answered and stops waiting.
	handle.release();
	handle.release();
	assert.equal(t.frames("job.cancel").length, 0, "a parked job is not cancelled because nobody waits");
	assert.equal(t.queue.pendingCount(), 1);
	// Many more ask for the same URL, are answered, and leave again.
	for (let i = 0; i < 200; i++) {
		const again = t.queue.submit(parkable("https://a.example/1"));
		assert.equal(again.deduped, true);
		assert.equal((await again.parked)?.job, handle.job);
		again.release();
	}
	// None of them left a trace that could fill the queue.
	const other = t.queue.submit(spec("https://b.example/1"));
	assert.equal(t.starts().at(-1)?.job, other.job);
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1))));
	// Callers that do hold on to a parked job count against the same limit as everyone who waits.
	const u = parkSetup({ limits: { maxQueued: 3 } });
	const p = u.park("https://a.example/1");
	const held = [u.queue.submit(parkable("https://a.example/1")), u.queue.submit(parkable("https://a.example/1"))];
	assert.equal(held.every((h) => h.deduped), true);
	const over = u.queue.submit(parkable("https://a.example/1"));
	assert.equal((await settled(over.promise)).error?.code, "queue_full");
	held[0].release();
	assert.equal(u.queue.submit(parkable("https://a.example/1")).deduped, true);
	// The job ends when the extension says so, and everyone still waiting gets the page.
	t.queue.onResult(makeResult(start));
	assert.equal((await settled(handle.promise)).outcome, "ok");
	assert.equal(t.audit.find((e) => e.job === handle.job)?.callers, 201);
	u.queue.onResult(makeResult(p.start));
	assert.equal((await settled(held[1].promise)).outcome, "ok");
});

test("parked: acknowledged once; attention goes to the extension for parked jobs only", async () => {
	const t = parkSetup();
	const { handle } = t.park("https://a.example/1");
	assert.equal(t.queue.attention(handle.job), true);
	assert.equal(t.queue.attention(handle.job, "renotify"), true);
	assert.deepEqual(t.frames("attention").map((f) => [f.job, f.action]), [[handle.job, "focus"], [handle.job, "renotify"]]);
	// Not for a job that merely runs, is unknown, or is over.
	const running = t.queue.submit(spec("https://b.example/1"));
	assert.equal(t.queue.attention(running.job), false);
	assert.equal(t.queue.attention("j_nobody"), false);
	assert.equal(t.frames("attention").length, 2);

	t.queue.onEvent({ name: "challenge.acked", job: handle.job, detect: null });
	t.queue.onEvent({ name: "challenge.acked", job: handle.job, detect: null });
	t.queue.onEvent({ name: "challenge.acked", job: "j_nobody", detect: null });
	t.queue.onEvent({ name: "challenge.acked", job: running.job, detect: null });
	t.queue.onEvent({ name: "challenge.acked", job: null, detect: null });
	assert.deepEqual(t.told.filter((x) => x.startsWith("acked")), [`acked:${handle.job}:a.example`]);
	assert.equal(t.queue.pending()[0].acked, true);
	// Events about jobs the daemon does not have running count for nothing.
	t.queue.onEvent({ name: "challenge.pending", job: "j_made_up", detect: DETECT });
	t.queue.onEvent({ name: "challenge.pending", job: handle.job, detect: DETECT });
	assert.equal(t.queue.pendingCount(), 1);
	assert.equal(t.told.filter((x) => x.startsWith("pending")).length, 1);
	assert.ok(t.logs.some((l) => l.event === "job.message_dropped" && l.fields.type === "challenge.pending"));
	// The host in what the listener is told is the daemon's own, not something an event said.
	assert.equal(t.told[0], `pending:${handle.job}:a.example`);

	// The extension saw the challenge gone and reads the page: said once to whoever notifies the operator. The job
	// is still the parked one until its result is in.
	t.queue.onEvent({ name: "challenge.cleared", job: handle.job, detect: null });
	t.queue.onEvent({ name: "challenge.cleared", job: handle.job, detect: null });
	t.queue.onEvent({ name: "challenge.cleared", job: "j_nobody", detect: null });
	t.queue.onEvent({ name: "challenge.cleared", job: running.job, detect: null });
	assert.deepEqual(t.told.filter((x) => x.startsWith("cleared")), [`cleared:${handle.job}:a.example`]);
	assert.equal(t.queue.pendingCount(), 1);
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().find((f) => f.job === handle.job))));
	assert.deepEqual(t.told.slice(-2), [`cleared:${handle.job}:a.example`, `ended:${handle.job}:a.example`]);
	assert.equal(t.queue.pendingCount(), 0);
});

test("parked jobs survive nothing: the link going down ends them, and so does the daemon stopping", async () => {
	const t = parkSetup();
	const a = t.park("https://a.example/1");
	const b = t.park("https://b.example/1");
	const queued = t.queue.submit(spec("https://c.example/1"));
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1))));
	await settled(queued.promise);
	t.queue.linkDown("lost");
	for (const p of [a, b]) {
		const r = await settled(p.handle.promise);
		assert.equal(r.outcome, "error");
		assert.equal(r.error?.code, "browser_disconnected");
		assert.equal(r.error?.retryable, true);
		assert.deepEqual(r.detect, DETECT);
	}
	assert.equal(t.queue.pendingCount(), 0);
	assert.deepEqual(t.told.filter((x) => x.startsWith("ended")), [`ended:${a.handle.job}:a.example`, `ended:${b.handle.job}:b.example`]);
	assert.equal(t.clock.pending, 0, "no deadline of a parked job is left");
	// A new link starts with nothing pending; the sites can be asked again.
	t.queue.linkUp(defaultState());
	const again = t.queue.submit(parkable("https://a.example/1"));
	assert.equal(again.deduped, false);
	assert.equal(t.starts().at(-1)?.job, again.job);

	const u = parkSetup();
	const c = u.park("https://a.example/1");
	u.queue.shutdown();
	const rc = await settled(c.handle.promise);
	assert.equal(rc.outcome, "aborted");
	assert.equal(rc.error?.code, "shutdown");
	assert.deepEqual(u.frames("job.cancel").map((f) => [f.job, f.reason]), [[c.handle.job, "shutdown"]]);
	assert.equal(u.told.at(-1), `ended:${c.handle.job}:a.example`);
	assert.equal(u.clock.pending, 0);
});

// ---------------------------------------------------------------- cooldown

const COOL = { polite: { ...NO_GAPS.polite, cooldownMs: /** @type {const} */ ([60000, 1800000]) }, fast: { ...PACING.fast, cooldownMs: /** @type {const} */ ([10000, 300000]) } };
/** @param {Frame} start @param {number | null} [retryAfter] @param {string} [code] */
const blockedBy = (start, retryAfter = null, code = "http_403") =>
	makeResult(start, { outcome: "blocked", content: null, page: null, detect: { kind: code, evidence: "status 403", waited_ms: 0, resolved: null }, error: { code, message: "the site refused the request", retryable: false, retry_after_s: retryAfter } });

test("cooldown: after a block the site is left alone; jobs for it are not dispatched and say when to come back", async () => {
	const t = parkSetup({ pacing: COOL });
	const a = t.queue.submit(spec("https://www.shop.example/1"));
	t.queue.onResult(blockedBy(t.starts()[0]));
	const ra = await settled(a.promise);
	assert.equal(ra.outcome, "blocked");
	assert.equal(ra.error?.code, "http_403");
	assert.equal(ra.error?.retry_after_s, 60, "the report says how long the site is left alone");
	// Any host of the site, right away and for the next minute.
	for (const [ms, left] of /** @type {[number, number][]} */ ([[0, 60], [1, 60], [29999, 30], [29000, 1]])) {
		t.clock.advance(ms);
		const refused = t.queue.submit(spec("https://forum.shop.example/x"));
		const r = await settled(refused.promise);
		assert.equal(r.outcome, "blocked");
		assert.deepEqual(r.error, { code: "site_cooldown", message: "the site blocked or challenged a moment ago and is left alone for a while", retryable: true, retry_after_s: left });
		assert.equal(r.render, null);
	}
	assert.equal(t.starts().length, 1, "none of them reached the browser");
	assert.deepEqual(t.audit.slice(1).map((e) => [e.outcome, e.code, e.dispatched]), Array(4).fill(["blocked", "site_cooldown", false]));
	// Another site is not held back.
	const other = t.queue.submit(spec("https://elsewhere.example/1"));
	assert.equal(t.starts().at(-1)?.job, other.job);
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1))));
	// When the minute is over the site is asked again.
	t.clock.advance(1000);
	const again = t.queue.submit(spec("https://www.shop.example/2"));
	assert.equal(t.starts().at(-1)?.job, again.job);
});

test("cooldown: longer every time in a row, with jitter, capped; forgotten after an hour of good behaviour", async () => {
	/** @param {number} u the jitter draw @param {number} blocks how many blocks in a row @returns {Promise<number[]>} the cooldown after each, in seconds */
	const series = async (u, blocks) => {
		const t = parkSetup({ pacing: COOL, rng: () => u });
		/** @type {number[]} */
		const out = [];
		for (let i = 0; i < blocks; i++) {
			const h = t.queue.submit(spec(`https://shop.example/${i}`));
			t.queue.onResult(blockedBy(/** @type {Frame} */ (t.starts().at(-1))));
			const s = (await settled(h.promise)).error?.retry_after_s ?? 0;
			out.push(s);
			t.clock.advance(s * 1000);
		}
		return out;
	};
	// Doubling from one minute, capped at half an hour.
	assert.deepEqual(await series(0, 8), [60, 120, 240, 480, 960, 1800, 1800, 1800]);
	// Jitter adds up to a quarter on top.
	assert.deepEqual(await series(1, 7), [75, 150, 300, 600, 1200, 2250, 2250]);
	assert.deepEqual(await series(0.5, 3), [68, 135, 270]);
	// The fast profile starts at ten seconds and stops at five minutes.
	const f = parkSetup({ pacing: COOL, fastHosts: ["docs.example"] });
	const fa = f.queue.submit(spec("https://docs.example/1"));
	f.queue.onResult(blockedBy(f.starts()[0]));
	assert.equal((await settled(fa.promise)).error?.retry_after_s, 10);

	// A site that did not block for an hour starts from the first step again.
	const t = parkSetup({ pacing: COOL });
	for (let i = 0; i < 3; i++) {
		const h = t.queue.submit(spec(`https://shop.example/${i}`));
		t.queue.onResult(blockedBy(/** @type {Frame} */ (t.starts().at(-1))));
		t.clock.advance(((await settled(h.promise)).error?.retry_after_s ?? 0) * 1000);
	}
	t.clock.advance(3600000);
	const fresh = t.queue.submit(spec("https://shop.example/later"));
	t.queue.onResult(blockedBy(/** @type {Frame} */ (t.starts().at(-1))));
	assert.equal((await settled(fresh.promise)).error?.retry_after_s, 60);
	// Without a cooldown in the pacing profile there is none (the tests' default).
	const none = parkSetup();
	const n = none.queue.submit(spec("https://shop.example/1"));
	none.queue.onResult(blockedBy(none.starts()[0]));
	assert.equal((await settled(n.promise)).error?.retry_after_s, null);
	assert.equal(none.queue.submit(spec("https://shop.example/2")).deduped, false);
	assert.equal(none.starts().length, 2);
});

test("cooldown: Retry-After is honoured where the site asks for more, up to an hour", async () => {
	/** @param {number | null} retryAfter @returns {Promise<number | null | undefined>} */
	const after = async (retryAfter) => {
		const t = parkSetup({ pacing: COOL });
		const h = t.queue.submit(spec("https://shop.example/1"));
		t.queue.onResult(blockedBy(t.starts()[0], retryAfter, "http_429"));
		const s = (await settled(h.promise)).error?.retry_after_s;
		// And that is how long the next job is refused for.
		assert.equal((await settled(t.queue.submit(spec("https://shop.example/2")).promise)).error?.retry_after_s, s);
		return s;
	};
	assert.equal(await after(null), 60);
	assert.equal(await after(5), 60, "less than the gateway's own cooldown: the cooldown");
	assert.equal(await after(300), 300);
	assert.equal(await after(3600), 3600);
	assert.equal(await after(86400), 3600, "no site can lock itself out for a day");
});

test("cooldown: a challenge that nobody cleared cools the site; one the operator cleared does not", async () => {
	const t = parkSetup({ pacing: COOL });
	// Not parked (the extension had no room): the site challenges, so it is left alone.
	const a = t.queue.submit(spec("https://a.example/1"));
	t.queue.onResult(makeResult(t.starts()[0], { outcome: "needs_human", content: null, page: null, detect: DETECT, error: { code: "too_many_pending", message: "x", retryable: true, retry_after_s: null } }));
	assert.equal((await settled(a.promise)).error?.retry_after_s, 60);
	assert.equal((await settled(t.queue.submit(spec("https://a.example/2")).promise)).error?.code, "site_cooldown");

	// Parked and expired: "just expired" is a block for the moment.
	const b = t.park("https://b.example/1");
	// While it waits the answer is "pending", not "cooldown".
	assert.equal((await settled(t.queue.submit(spec("https://b.example/2")).promise)).error?.code, "challenge_pending");
	t.clock.advance(15 * MIN);
	t.queue.onResult(makeResult(b.start, { outcome: "timeout", content: null, page: null, detect: DETECT, error: { code: "challenge_expired", message: "x", retryable: true, retry_after_s: null } }));
	const rb = await settled(b.handle.promise);
	assert.equal(rb.error?.code, "challenge_expired");
	assert.equal(rb.error?.retry_after_s, 60);
	assert.equal((await settled(t.queue.submit(spec("https://b.example/3")).promise)).error?.code, "site_cooldown");

	// Parked and closed by the operator: the challenge is still there for the next one.
	const c = t.park("https://c.example/1");
	t.queue.onResult(makeResult(c.start, { outcome: "error", content: null, page: null, detect: DETECT, error: { code: "tab_closed", message: "x", retryable: true, retry_after_s: null } }));
	assert.equal((await settled(c.handle.promise)).error?.retry_after_s, 60);
	assert.equal((await settled(t.queue.submit(spec("https://c.example/2")).promise)).error?.code, "site_cooldown");

	// Parked and cleared: the site let the browser in. Nothing to wait for - and an earlier cooldown is over.
	const d = t.park("https://d.example/1");
	t.queue.onResult(makeResult(d.start, { detect: { ...DETECT, resolved: "cleared_by_operator" } }));
	assert.equal((await settled(d.handle.promise)).outcome, "ok");
	const next = t.queue.submit(spec("https://d.example/2"));
	assert.equal(t.starts().at(-1)?.job, next.job);
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1))));

	// What is no word of the site does not cool it: a timeout, an error, a caller that left.
	const e = t.queue.submit(spec("https://e.example/1"));
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1)), { outcome: "timeout", content: null, page: null, error: { code: "navigation_timeout", message: "x", retryable: true, retry_after_s: null } }));
	assert.equal((await settled(e.promise)).error?.retry_after_s, null);
	const e2 = t.queue.submit(spec("https://e.example/2"));
	assert.equal(t.starts().at(-1)?.job, e2.job);
	e2.release();
	assert.equal((await settled(e2.promise)).error?.code, "client_gone");
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1))));
	assert.equal(t.queue.submit(spec("https://e.example/3")).deduped, false);
	assert.equal(t.starts().at(-1)?.url, "https://e.example/3");
});

test("cooldown: jobs that were queued for the site when it blocked are not dispatched; each ends with what a new job is told", async () => {
	const t = parkSetup({ pacing: COOL });
	// Ten pages of one site at once, and one of another: one slot, so nine of them wait.
	const shop = Array.from({ length: 10 }, (_, i) => t.queue.submit(spec(`https://${i % 2 === 0 ? "www" : "forum"}.shop.example/${i}`)));
	const other = t.queue.submit(spec("https://elsewhere.example/1"));
	assert.deepEqual(t.queue.stats(), { queued: 10, dispatched: 1 });
	t.clock.advance(2000);
	t.queue.onResult(blockedBy(t.starts()[0]));
	assert.equal((await settled(shop[0].promise)).error?.retry_after_s, 60);
	for (const h of shop.slice(1)) {
		const r = await settled(h.promise);
		assert.equal(r.outcome, "blocked");
		assert.equal(r.job, h.job);
		assert.deepEqual(r.error, { code: "site_cooldown", message: "the site blocked or challenged a moment ago and is left alone for a while", retryable: true, retry_after_s: 60 });
		assert.equal(r.render, null);
		assert.equal(await h.parked, null);
	}
	// The browser was asked for the first of them and for the other site, and for nothing else.
	assert.deepEqual(t.starts().map((f) => f.job), [shop[0].job, other.job]);
	assert.deepEqual(t.queue.stats(), { queued: 0, dispatched: 1 });
	assert.deepEqual(t.audit.map((e) => [e.job, e.outcome, e.code, e.dispatched, e.duration_ms]), [
		[shop[0].job, "blocked", "http_403", true, 2000],
		...shop.slice(1).map((h) => [h.job, "blocked", "site_cooldown", false, 2000]),
	]);
	assert.equal(t.clock.pending, 1, "their queue deadlines are gone: the run deadline of the other job is all that is left");
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1))));
	// One block is one step of the cooldown, however many jobs it answered.
	t.clock.advance(60000);
	const again = t.queue.submit(spec("https://www.shop.example/again"));
	assert.equal(t.starts().at(-1)?.job, again.job);
	t.queue.onResult(blockedBy(/** @type {Frame} */ (t.starts().at(-1))));
	assert.equal((await settled(again.promise)).error?.retry_after_s, 120);
});

test("cooldown: a job that waits for a gap is ended as soon as its site blocks, not when its turn would have come", async () => {
	const t = parkSetup({ pacing: { polite: { ...PACING.polite, cooldownMs: /** @type {const} */ ([60000, 1800000]) }, fast: PACING.fast } });
	const a = t.queue.submit(spec("https://shop.example/1"));
	const b = t.queue.submit(spec("https://shop.example/2"));
	t.clock.advance(500);
	t.queue.onResult(blockedBy(t.starts()[0], 300, "http_429"));
	assert.equal((await settled(a.promise)).error?.retry_after_s, 300);
	const rb = await settled(b.promise);
	assert.equal(rb.error?.code, "site_cooldown");
	assert.equal(rb.error?.retry_after_s, 300, "what the site asked for is passed on to those that waited as well");
	// The host gap is over long before the cooldown: nothing is sent when it ends.
	t.clock.advance(20000);
	assert.equal(t.starts().length, 1);
	// Callers that joined a waiting job get its answer.
	t.clock.advance(300000);
	const c = t.queue.submit(spec("https://shop.example/3"));
	const d = t.queue.submit(spec("https://shop.example/4"));
	const d2 = t.queue.submit(spec("https://shop.example/4"));
	assert.equal(d2.deduped, true);
	t.queue.onResult(blockedBy(/** @type {Frame} */ (t.starts().at(-1))));
	await settled(c.promise);
	assert.equal((await settled(d.promise)).error?.code, "site_cooldown");
	assert.equal(await settled(d2.promise), await settled(d.promise));
	assert.equal(t.audit.at(-1)?.callers, 2);
});

test("parked: jobs that were queued for the site when its challenge came up are not dispatched; each is pointed at the job that waits", async () => {
	const t = parkSetup();
	const first = t.queue.submit(parkable("https://www.shop.example/item/1"));
	const waiting = [t.queue.submit(parkable("https://www.shop.example/item/2")), t.queue.submit(spec("https://forum.shop.example/thread/9"))];
	const other = t.queue.submit(spec("https://elsewhere.example/1"));
	t.queue.onAccepted({ job: first.job, cookie_scope: "container", rule: null });
	t.clock.advance(8000);
	t.queue.onEvent({ name: "challenge.pending", job: first.job, detect: DETECT });
	for (const h of waiting) {
		const r = await settled(h.promise);
		assert.equal(r.outcome, "needs_human");
		assert.equal(r.job, first.job, "the report names the job that waits");
		assert.deepEqual(r.error, { code: "challenge_pending", message: "a human check of this site is waiting for the operator", retryable: true, retry_after_s: 60 });
		assert.deepEqual(r.detect, DETECT);
		assert.equal(r.render, null);
		assert.equal(await h.parked, null, "they are not parked themselves");
	}
	assert.deepEqual(t.starts().map((f) => f.job), [first.job, other.job], "the slot went to the other site");
	assert.deepEqual(t.audit.map((e) => [e.job, e.outcome, e.code, e.dispatched]), waiting.map((h) => [h.job, "needs_human", "challenge_pending", false]));
	assert.equal(t.queue.pendingCount(), 1);
	assert.deepEqual(t.told, [`pending:${first.job}:www.shop.example`], "the operator is called for one page");
	// Ending them is no word of the site: when the operator has cleared the page, the site is asked again at once.
	t.queue.onResult(makeResult(t.starts()[0], { detect: { ...DETECT, resolved: "cleared_by_operator" } }));
	t.queue.onResult(makeResult(t.starts()[1]));
	const next = t.queue.submit(spec("https://forum.shop.example/thread/9"));
	assert.equal(t.starts().at(-1)?.job, next.job);
});

test("cooldown: the link going down while a page waits is no word of the site - it is not cooled, and an earlier cooldown stays", async () => {
	for (const cause of /** @type {const} */ (["lost", "violation"])) {
		const t = parkSetup({ pacing: COOL });
		// One site blocks and is cooling; the pages of two others wait for the operator when the browser goes away.
		const blocked = t.queue.submit(spec("https://cold.example/1"));
		t.queue.onResult(blockedBy(t.starts()[0]));
		await settled(blocked.promise);
		const a = t.park("https://a.example/1");
		const b = t.park("https://b.example/1");
		t.clock.advance(5000);
		t.queue.linkDown(cause);
		for (const p of [a, b]) {
			const r = await settled(p.handle.promise);
			assert.equal(r.outcome, "error");
			assert.equal(r.error?.code, cause === "lost" ? "browser_disconnected" : "invalid_result");
			assert.equal(r.error?.retry_after_s, null, "no cooldown to wait for");
		}
		t.queue.linkUp(defaultState());
		// Both sites are asked again at once.
		const again = t.queue.submit(parkable("https://a.example/1"));
		assert.equal(t.starts().at(-1)?.job, again.job, cause);
		t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1))));
		const other = t.queue.submit(spec("https://www.b.example/2"));
		assert.equal(t.starts().at(-1)?.job, other.job, cause);
		// The site that did block is still left alone.
		assert.deepEqual((await settled(t.queue.submit(spec("https://cold.example/2")).promise)).error, { code: "site_cooldown", message: "the site blocked or challenged a moment ago and is left alone for a while", retryable: true, retry_after_s: 55 });
	}
});

// ---------------------------------------------------------------- loads that are redirected to another site

/**
 * What the extension reports for a load that was sent on: the origin of every hop that left the one before, and - for
 * a page that was read - where it ended.
 * @param {Frame} start @param {string[]} hops origins @param {string | null} finalUrl @param {Record<string, unknown>} [over]
 */
const redirected = (start, hops, finalUrl, over = {}) =>
	makeResult(start, { nav: { requested_url: start.url, final_url: finalUrl, redirect_origins: hops, http_status: 200, content_type: "text/html", body_bytes: null }, ...over });

test("redirect: the site a load ended at is held to its own gap from then on, and so is every site it passed", async () => {
	const t = setup({ fastHosts: ["quick.example"] });
	// Two links of two shorteners, both leading to the same site; and that site asked for directly.
	const viaOne = t.queue.submit(spec("https://one.example/abc"));
	t.clock.advance(500);
	t.queue.onResult(redirected(t.starts()[0], ["https://hop.example", "https://www.target.example"], "https://www.target.example/article"));
	assert.equal((await settled(viaOne.promise)).outcome, "ok");
	t.queue.submit(spec("https://target.example/direct"));
	t.queue.submit(spec("https://hop.example/direct"));
	t.queue.submit(spec("https://unrelated.example/1"));
	// After the gap between any two jobs it is the unrelated site that runs: the other two were loaded a moment ago.
	t.clock.advance(2000);
	assert.deepEqual(t.starts().slice(1).map((f) => f.url), ["https://unrelated.example/1"]);
	t.queue.onResult(makeResult(t.starts()[1]));
	t.clock.advance(7999);
	assert.equal(t.starts().length, 2, "ten seconds from the end of the redirected load, not two");
	t.clock.advance(1);
	assert.equal(t.starts()[2].url, "https://target.example/direct");
	t.queue.onResult(makeResult(t.starts()[2]));
	t.clock.advance(2000);
	assert.equal(t.starts()[3].url, "https://hop.example/direct");
	t.queue.onResult(makeResult(t.starts()[3]));
	// The gap is the one of the site's own profile, not of the site that was asked.
	t.clock.advance(10000);
	t.queue.submit(spec("https://two.example/xyz"));
	t.clock.advance(300);
	t.queue.onResult(redirected(/** @type {Frame} */ (t.starts().at(-1)), ["https://quick.example"], "https://quick.example/page"));
	t.queue.submit(spec("https://quick.example/next"));
	t.clock.advance(1999);
	assert.equal(t.starts().at(-1)?.url, "https://two.example/xyz");
	t.clock.advance(1);
	assert.equal(t.starts().at(-1)?.url, "https://quick.example/next", "half a second for a fast host: over before the gap between any two jobs");
	// A load that stays on its site, or comes back to it, changes nothing for anyone else.
	const u = setup();
	u.queue.submit(spec("https://www.shop.example/1"));
	u.queue.onResult(redirected(u.starts()[0], ["https://login.shop.example", "https://www.shop.example"], "https://www.shop.example/1?ok"));
	u.queue.submit(spec("https://elsewhere.example/1"));
	u.clock.advance(2000);
	assert.equal(u.starts().at(-1)?.url, "https://elsewhere.example/1");
});

test("redirect: a load that ended at another site counts in that site's hour; the next job for it is refused, queued or not", async () => {
	const pacing = { polite: { ...NO_GAPS.polite, hourlyBudget: 2 }, fast: PACING.fast };
	const t = parkSetup({ pacing });
	// Three links through three other sites: nobody knows where they lead until they ran, so all three run.
	for (let i = 0; i < 3; i++) {
		const h = t.queue.submit(spec(`https://short${i}.example/x`));
		assert.equal(t.starts().at(-1)?.job, h.job);
		if (i === 2) {
			// The target has had two loads and is asked for directly while the third is on its way: refused at once.
			const direct = await settled(t.queue.submit(spec("https://target.example/direct")).promise);
			assert.equal(direct.outcome, "error");
			assert.deepEqual(direct.error, { code: "site_budget", message: "the hourly budget for this site is used up", retryable: false, retry_after_s: 3599 });
		}
		t.clock.advance(1000);
		t.queue.onResult(redirected(/** @type {Frame} */ (t.starts().at(-1)), ["https://target.example"], `https://target.example/p${i}`));
		assert.equal((await settled(h.promise)).outcome, "ok", "a load that ran is not taken back");
	}
	assert.equal(t.starts().length, 3);
	// Each of the sites that were asked has one load of its own in its hour: one more each is fine.
	const own = t.queue.submit(spec("https://short0.example/y"));
	assert.equal(t.starts().at(-1)?.job, own.job);

	// A job that was queued for the target while it had room is ended when a redirected load takes the room.
	const u = parkSetup({ pacing });
	const first = u.queue.submit(spec("https://short0.example/x"));
	u.queue.onResult(redirected(u.starts()[0], ["https://target.example"], "https://target.example/p0"));
	await settled(first.promise);
	const second = u.queue.submit(spec("https://short1.example/x"));
	const waiting = u.queue.submit(spec("https://target.example/direct"));
	assert.equal(await peek(waiting.promise), "pending", "one load in its hour, room for one more");
	u.clock.advance(4000);
	u.queue.onResult(redirected(u.starts()[1], ["https://target.example"], "https://target.example/p1"));
	await settled(second.promise);
	const r = await settled(waiting.promise);
	assert.equal(r.outcome, "error");
	assert.deepEqual(r.error, { code: "site_budget", message: "the hourly budget for this site is used up", retryable: false, retry_after_s: 3596 });
	assert.equal(u.starts().length, 2, "it never reached the browser");
	assert.deepEqual(u.audit.at(-1) && [u.audit.at(-1)?.job, u.audit.at(-1)?.code, u.audit.at(-1)?.dispatched], [waiting.job, "site_budget", false]);
	// When the first of the two leaves the hour, the target has room again.
	u.clock.advance(3596000);
	const later = u.queue.submit(spec("https://target.example/later"));
	assert.equal(u.starts().at(-1)?.job, later.job);
});

test("redirect: a block cools the site that was asked and the site that blocked; Retry-After holds the one that sent it", async () => {
	const t = parkSetup({ pacing: COOL });
	const via = t.queue.submit(spec("https://short.example/abc"));
	const queuedTarget = t.queue.submit(spec("https://www.target.example/other"));
	// A block has no final address: the last hop is where the load stood.
	t.queue.onResult(redirected(t.starts()[0], ["https://hop.example", "https://target.example"], null, { outcome: "blocked", content: null, page: null, error: { code: "http_429", message: "x", retryable: true, retry_after_s: 600 } }));
	assert.equal((await settled(via.promise)).error?.retry_after_s, 600, "the address leads there: come back when both may be asked");
	// The site that blocked: left alone for what it asked, for the job that waited and for new ones.
	for (const h of [queuedTarget, t.queue.submit(spec("https://target.example/direct"))]) {
		assert.deepEqual((await settled(h.promise)).error, { code: "site_cooldown", message: "the site blocked or challenged a moment ago and is left alone for a while", retryable: true, retry_after_s: 600 });
	}
	// The site that was asked: the ordinary first step, not ten minutes on another site's word.
	assert.equal((await settled(t.queue.submit(spec("https://short.example/def")).promise)).error?.retry_after_s, 60);
	// The hop in between passed the browser on and is not cooled.
	const hop = t.queue.submit(spec("https://hop.example/1"));
	assert.equal(t.starts().at(-1)?.job, hop.job);
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1))));
	t.clock.advance(60000);
	const again = t.queue.submit(spec("https://short.example/def"));
	assert.equal(t.starts().at(-1)?.job, again.job, "the site that was asked is free after its minute");
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1))));
	assert.equal((await settled(t.queue.submit(spec("https://target.example/direct")).promise)).error?.retry_after_s, 540);

	// A block on the site that was asked itself: its Retry-After is its own, as before.
	const u = parkSetup({ pacing: COOL });
	const own = u.queue.submit(spec("https://www.shop.example/1"));
	u.queue.onResult(redirected(u.starts()[0], ["https://elsewhere.example", "https://shop.example"], null, { outcome: "blocked", content: null, page: null, error: { code: "http_429", message: "x", retryable: true, retry_after_s: 600 } }));
	assert.equal((await settled(own.promise)).error?.retry_after_s, 600);
	assert.equal((await settled(u.queue.submit(spec("https://shop.example/2")).promise)).error?.retry_after_s, 600);
	const passed = u.queue.submit(spec("https://elsewhere.example/1"));
	assert.equal(u.starts().at(-1)?.job, passed.job);

	// A challenge that nobody cleared, on a page the load was redirected to: both sites, the same way.
	const v = parkSetup({ pacing: COOL });
	const parked = v.park("https://short.example/abc");
	v.clock.advance(15 * MIN);
	v.queue.onResult(redirected(parked.start, ["https://target.example"], null, { outcome: "timeout", content: null, page: null, detect: DETECT, error: { code: "challenge_expired", message: "x", retryable: true, retry_after_s: null } }));
	assert.equal((await settled(parked.handle.promise)).error?.retry_after_s, 60);
	assert.equal((await settled(v.queue.submit(spec("https://target.example/1")).promise)).error?.code, "site_cooldown");
	assert.equal((await settled(v.queue.submit(spec("https://short.example/2")).promise)).error?.code, "site_cooldown");
});

test("redirect: what the extension reports is used as far as it names a host, and nothing else of it", async () => {
	const t = parkSetup({ pacing: COOL });
	const h = t.queue.submit(spec("https://a.example/1"));
	t.queue.onResult(redirected(t.starts()[0], ["not an origin", "about:blank", "https://[2001:db8:1:2::9]:8443", ""], null, { outcome: "blocked", content: null, page: null, error: { code: "http_403", message: "x", retryable: false, retry_after_s: null } }));
	assert.equal((await settled(h.promise)).error?.retry_after_s, 60);
	// The last hop that names a host is where the load stood: an address of that network is not asked either.
	assert.equal((await settled(t.queue.submit(spec("https://[2001:db8:1:2::77]/x")).promise)).error?.code, "site_cooldown");
	assert.equal((await settled(t.queue.submit(spec("https://a.example/2")).promise)).error?.code, "site_cooldown");
	assert.equal(t.starts().length, 1);
});

// ---------------------------------------------------------------- hosts of different owners under one shared suffix

/**
 * A rule that tells the names below a shared suffix apart: "evil.github.io" and "good.github.io" are two sites,
 * "x.evil.github.io" belongs to the first. Everything else as the gateway's own rule has it.
 * @param {string} host
 */
const finerSite = (host) => (host.endsWith(".github.io") ? host.split(".").slice(-3).join(".") : siteOf(host));

test("shared suffix: the cooldown one host earns is its own - a neighbour under the same suffix is asked as before", async () => {
	const t = parkSetup({ pacing: COOL, siteOf: finerSite });
	const evil = t.queue.submit(spec("https://evil.github.io/1"));
	const queuedGood = t.queue.submit(spec("https://good.github.io/1"));
	const queuedEvil = t.queue.submit(spec("https://x.evil.github.io/1"));
	// The most one answer can do: an hour, and only to the site that gave it.
	t.queue.onResult(blockedBy(t.starts()[0], 86400, "http_429"));
	assert.equal((await settled(evil.promise)).error?.retry_after_s, 3600);
	assert.deepEqual((await settled(queuedEvil.promise)).error, { code: "site_cooldown", message: "the site blocked or challenged a moment ago and is left alone for a while", retryable: true, retry_after_s: 3600 });
	assert.equal(t.starts().at(-1)?.job, queuedGood.job, "the neighbour that waited is dispatched");
	t.queue.onResult(makeResult(/** @type {Frame} */ (t.starts().at(-1))));
	assert.equal((await settled(queuedGood.promise)).outcome, "ok");
	t.clock.advance(3599000);
	assert.equal((await settled(t.queue.submit(spec("https://evil.github.io/2")).promise)).error?.retry_after_s, 1);
	const good = t.queue.submit(spec("https://good.github.io/2"));
	assert.equal(t.starts().at(-1)?.job, good.job);
	// Under the gateway's own rule of today the two are one site; the rule is all that differs.
	const coarse = parkSetup({ pacing: COOL, siteOf: (host) => host.split(".").slice(-2).join(".") });
	coarse.queue.submit(spec("https://evil.github.io/1"));
	coarse.queue.onResult(blockedBy(coarse.starts()[0], 86400, "http_429"));
	assert.equal((await settled(coarse.queue.submit(spec("https://good.github.io/1")).promise)).error?.code, "site_cooldown");
});

test("shared suffix: a challenge of one host that waits for the operator holds back that host only, and each may have one", async () => {
	const t = parkSetup({ siteOf: finerSite });
	const evil = t.park("https://evil.github.io/1");
	const refused = await settled(t.queue.submit(spec("https://x.evil.github.io/2")).promise);
	assert.equal(refused.error?.code, "challenge_pending");
	assert.equal(refused.job, evil.handle.job);
	// The neighbour is loaded, and its own challenge may wait as well: one per site.
	const good = t.park("https://good.github.io/1");
	assert.equal(t.queue.pendingCount(), 2);
	assert.deepEqual(t.queue.pending().map((p) => p.host), ["evil.github.io", "good.github.io"]);
	assert.equal(await peek(good.handle.promise), "pending");
	// A second page of a host whose challenge waits is ended, whoever parks it.
	const u = parkSetup({ siteOf: finerSite });
	u.park("https://evil.github.io/1");
	u.park("https://good.github.io/1");
	u.park("https://other.github.io/1");
	assert.equal(u.queue.pendingCount(), 3, "and no more than three wait at once, however many sites there are");
	const fourth = u.queue.submit(parkable("https://fourth.github.io/1"));
	u.queue.onEvent({ name: "challenge.pending", job: fourth.job, detect: DETECT });
	assert.equal((await settled(fourth.promise)).error?.code, "too_many_pending");
});

test("shared suffix: gap and hourly budget are kept per host below it; the gap between any two jobs stays", async () => {
	const pacing = { polite: { ...PACING.polite, hourlyBudget: 2 }, fast: PACING.fast };
	const t = setup({ pacing, siteOf: finerSite });
	t.queue.submit(spec("https://evil.github.io/1"));
	t.queue.submit(spec("https://evil.github.io/2"));
	t.queue.submit(spec("https://good.github.io/1"));
	t.queue.onResult(makeResult(t.starts()[0]));
	// After the gap between any two jobs (2 s) the neighbour runs; the same host again waits its own 10 s.
	t.clock.advance(1999);
	assert.equal(t.starts().length, 1);
	t.clock.advance(1);
	assert.deepEqual(t.starts().map((f) => f.url), ["https://evil.github.io/1", "https://good.github.io/1"]);
	t.queue.onResult(makeResult(t.starts()[1]));
	t.clock.advance(7999);
	assert.equal(t.starts().length, 2);
	t.clock.advance(1);
	assert.equal(t.starts().at(-1)?.url, "https://evil.github.io/2");
	t.queue.onResult(makeResult(t.starts()[2]));
	// Two loads an hour each: the first host has had its two, the second has one left.
	const over = await settled(t.queue.submit(spec("https://x.evil.github.io/3")).promise);
	assert.equal(over.error?.code, "site_budget");
	const left = t.queue.submit(spec("https://good.github.io/2"));
	assert.equal(await peek(left.promise), "pending");
	assert.equal((await settled(t.queue.submit(spec("https://good.github.io/3")).promise)).error?.code, "site_budget");
});

// ---------------------------------------------------------------- pages read with the operator's login

/** No gaps of the ordinary kind, so that what is seen here is the login pacing alone. */
const LOGIN_ONLY = {
	polite: { hostGapMs: /** @type {const} */ ([0, 0]), globalGapMs: /** @type {const} */ ([0, 0]), dwellMs: /** @type {const} */ ([0, 0]) },
	fast: { hostGapMs: /** @type {const} */ ([0, 0]), globalGapMs: /** @type {const} */ ([0, 0]), dwellMs: /** @type {const} */ ([0, 0]) },
};
const LOGIN_RULE = { host: "forum.example.com", path_prefix: "/board", subdomains: false };

/**
 * A queue whose extension reports opt-in hosts.
 * @param {string[]} hosts
 */
function loginSetup(hosts) {
	const t = setup({ pacing: LOGIN_ONLY, connected: false });
	t.queue.linkUp({ ...defaultState(), optin_hosts: hosts });
	/** Play the extension for the job that was started last: it ran with the login (or in the container), and ended ok. */
	const run = (/** @type {"default" | "container"} */ scope) => {
		const start = t.starts().at(-1);
		assert.ok(start);
		t.queue.onAccepted({ job: start.job, cookie_scope: scope, rule: scope === "default" ? LOGIN_RULE : null });
		t.queue.onResult(makeResult(start, { cookie_scope: scope }));
	};
	return { ...t, run };
}

test("login pacing: after a page that ran with the operator's login the next one for that opt-in host waits ten seconds and a little", async () => {
	const t = loginSetup(["forum.example.com"]);
	const a = t.queue.submit(spec("https://forum.example.com/board/1"));
	assert.equal(t.starts().length, 1);
	t.run("default");
	assert.equal((await settled(a.promise)).outcome, "ok");
	// The next page of that host: held back, whatever its path - the daemon knows hosts, not rules.
	const b = t.queue.submit(spec("https://forum.example.com/board/2"));
	const c = t.queue.submit(spec("https://www.forum.example.com/x"));
	assert.equal(t.starts().length, 1);
	// Another site, and the same site with session "isolated", go at once: they cannot run with the login.
	const other = t.queue.submit(spec("https://news.example.org/1"));
	assert.equal(t.starts().length, 2);
	t.run("container");
	const isolated = t.queue.submit(spec("https://forum.example.com/board/3", { session: "isolated" }));
	assert.equal(t.starts().length, 3);
	assert.equal(t.starts()[2].session, "isolated");
	t.run("container");
	await settled(other.promise);
	await settled(isolated.promise);
	const probe = t.queue.submit(spec("https://forum.example.com/board/4", { kind: "probe" }));
	assert.equal(t.starts().length, 4);
	t.run("container");
	await settled(probe.promise);

	t.clock.advance(10000);
	assert.equal(t.starts().length, 4, "ten seconds are not enough: the extension counts from its own clock");
	t.clock.advance(250);
	assert.equal(t.starts().length, 5);
	assert.equal(t.starts()[4].url, "https://forum.example.com/board/2");
	// That one turns out to run in the container (its path lies outside the operator's rule): no new wait.
	t.run("container");
	assert.equal((await settled(b.promise)).cookie_scope, "container");
	assert.equal(t.starts().length, 6);
	t.run("container");
	await settled(c.promise);
	// Nothing was refused on the way, and no job.start ever carried more than the URL and the session.
	assert.equal(t.audit.every((e) => e.outcome === "ok"), true);
	for (const start of t.starts()) assert.deepEqual(Object.keys(start).sort(), ["extract", "files", "job", "kind", "session", "type", "url", "v", "wait"]);
});

test("login pacing: thirty pages an hour with the login for one opt-in host; the thirty-first is refused at once and told when", async () => {
	const t = loginSetup(["forum.example.com", "wiki.example.org"]);
	const first = t.clock.now();
	for (let i = 0; i < 30; i++) {
		const h = t.queue.submit(spec(`https://forum.example.com/board/${i}`));
		assert.equal(t.starts().length, i + 1, `page ${i + 1}`);
		t.run("default");
		assert.equal((await settled(h.promise)).outcome, "ok");
		t.clock.advance(60000);
	}
	const over = await settled(t.queue.submit(spec("https://forum.example.com/board/31")).promise);
	assert.equal(over.outcome, "error");
	assert.deepEqual(over.error, { code: "login_rate_limit", message: "pages read with the operator's login are limited per hour", retryable: true, retry_after_s: 1800 });
	assert.equal(t.starts().length, 30, "it never reached the browser");
	assert.equal(t.audit.at(-1)?.dispatched, false);
	// Pages that ran in the container do not count, and neither does another opt-in host.
	const wiki = t.queue.submit(spec("https://wiki.example.org/a"));
	assert.equal(t.starts().length, 31);
	t.run("default");
	await settled(wiki.promise);
	const isolated = t.queue.submit(spec("https://forum.example.com/board/x", { session: "isolated" }));
	assert.equal(t.starts().length, 32);
	t.run("container");
	await settled(isolated.promise);
	// When the first page of the thirty is an hour old there is room for one.
	t.clock.advance(first + 3600000 - t.clock.now());
	const again = t.queue.submit(spec("https://forum.example.com/board/32"));
	assert.equal(t.starts().length, 33);
	t.run("default");
	assert.equal((await settled(again.promise)).outcome, "ok");
});

test("login pacing: the extension's own limit is the one that counts - its refusal is passed on, and the daemon keeps away for as long as it said", async () => {
	const t = loginSetup(["forum.example.com"]);
	const a = t.queue.submit(spec("https://forum.example.com/board/1"));
	const start = t.starts()[0];
	// The extension refuses before it opens a tab: no job.accepted, a result with the time to wait.
	t.queue.onResult(makeResult(start, { outcome: "error", cookie_scope: null, error: { code: "login_rate_limit", message: "too often", retryable: true, retry_after_s: 7 }, page: null, content: null, extraction: null }));
	const refused = await settled(a.promise);
	assert.deepEqual([refused.outcome, refused.error?.code, refused.error?.retry_after_s], ["error", "login_rate_limit", 7]);
	// No cooldown of the site comes of that: the site did nothing.
	const b = t.queue.submit(spec("https://forum.example.com/board/2"));
	assert.equal(t.starts().length, 1, "held back");
	t.clock.advance(6999);
	assert.equal(t.starts().length, 1);
	t.clock.advance(1);
	assert.equal(t.starts().length, 2);
	t.run("default");
	assert.equal((await settled(b.promise)).outcome, "ok");

	// A long wait (the hour's pages of a rule are used up) is said at once: nobody is kept in the queue for it.
	const u = loginSetup(["forum.example.com"]);
	const c = u.queue.submit(spec("https://forum.example.com/board/1"));
	u.queue.onResult(makeResult(u.starts()[0], { outcome: "error", cookie_scope: null, error: { code: "login_rate_limit", message: "too often", retryable: true, retry_after_s: 1740 }, page: null, content: null, extraction: null }));
	await settled(c.promise);
	const later = await settled(u.queue.submit(spec("https://forum.example.com/board/2")).promise);
	assert.deepEqual([later.outcome, later.error?.code, later.error?.retry_after_s], ["error", "login_rate_limit", 1740]);
	assert.equal(u.starts().length, 1);
	u.clock.advance(600000);
	const stillLater = await settled(u.queue.submit(spec("https://forum.example.com/board/3")).promise);
	assert.equal(stillLater.error?.retry_after_s, 1140);
	// The way out is always there.
	u.queue.submit(spec("https://forum.example.com/board/4", { session: "isolated" }));
	assert.equal(u.starts().length, 2);
});

test("login pacing: without opt-in hosts nothing is held; a rule the daemon had not heard of is paced from the first job that used it", async () => {
	const t = loginSetup([]);
	for (let i = 0; i < 3; i++) {
		const h = t.queue.submit(spec(`https://forum.example.com/board/${i}`));
		assert.equal(t.starts().length, i + 1);
		t.run("container");
		await settled(h.promise);
	}
	// The extension ran a job with the login although the daemon knew of no opt-in host (the rule was set a
	// moment ago). The daemon learns the host from job.accepted; once the state says so too, it paces.
	const a = t.queue.submit(spec("https://forum.example.com/board/a"));
	t.run("default");
	await settled(a.promise);
	t.queue.setState({ ...defaultState(), optin_hosts: ["forum.example.com"], policy_rev: 2 });
	t.queue.submit(spec("https://forum.example.com/board/b"));
	assert.equal(t.starts().length, 4, "held for the gap");
	t.clock.advance(10250);
	assert.equal(t.starts().length, 5);
	// A test may give the queue another pace; the default is the extension's.
	const quick = setup({ pacing: LOGIN_ONLY, connected: false });
	assert.ok(quick.queue);
});
