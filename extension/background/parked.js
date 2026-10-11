// Challenge pages that wait for the operator.
//
// A job whose page still shows a challenge after its grace period is parked:
// its tab stays open, its place in the job runner is free for the next job,
// and this module keeps watch over the tab. A parked job ends in one of four
// ways, and in exactly one of them:
//
//   cleared   the page turned into content (the operator passed the check).
//             The job runner goes on to read it.
//   blocked   the page turned into a refusal or a wall.
//   expired   nobody cleared it in time.
//   stopped   something else ended it: the tab was closed, the daemon
//             cancelled the job, the link went down, the gateway was paused,
//             the request guard refused where the page went.
//
// Limits: a few parked jobs at most, and one per site - a site that shows a
// challenge is not asked again while that challenge waits.
//
// Watching means looking: the caller's probe reads the tab's state. Nothing
// here, and nothing the probe does, acts on the page.
//
// Time comes from an injected clock, so the whole life of a parked job can be
// played through in a test without waiting.

export const PARK_LIMITS = Object.freeze({
	maxParked: 3,
	// Whatever the daemon asks for, no tab waits longer than this.
	maxParkMs: 1800000,
});

/**
 * @typedef {import("./detect.js").Detection} Detection
 *
 * @typedef {object} Clock
 * @property {() => number} now
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 *
 * @typedef {object} ParkStop why a parked job was ended from outside; the shape of the job runner's own
 * @property {import("../shared/protocol.js").Outcome} outcome
 * @property {string} code
 * @property {string} message
 * @property {boolean} retryable
 * @property {boolean} [silent]
 *
 * @typedef {{ state: "loading" } | { state: "challenge" } | { state: "clear", thin: boolean } | { state: "blocked", detection: Detection } | { state: "gone" }} Probe
 *   loading: the tab is on its way somewhere; challenge: still in the way; clear: nothing in the way, thin says
 *   whether the page shows next to nothing; blocked: a refusal or a wall; gone: the tab no longer exists
 *
 * @typedef {{ how: "cleared" } | { how: "blocked", detection: Detection } | { how: "expired" } | { how: "stopped", stop: ParkStop }} ParkEnd
 *
 * @typedef {object} ParkedEntry
 * @property {string} job
 * @property {string} host
 * @property {string} site
 * @property {number} tabId
 * @property {string} kind what was detected, one of detect.js KIND
 * @property {number} since when it was parked
 * @property {number} expiresAt
 * @property {boolean} handedOff the operator was given the tab in a window of its own
 * @property {number | null} clearSince since when the page shows no challenge and next to no content either
 * @property {boolean} looking a probe is under way
 * @property {unknown} lookTimer
 * @property {unknown} expiryTimer
 *
 * @typedef {object} ParkedTuning
 * @property {number} pollMs how often a parked tab is looked at
 * @property {number} handedOffPollMs how often once the operator has the tab: they are at it now, and wait for it to be read
 * @property {number} nudgeMs how soon after a navigation completed
 * @property {number} clearStableMs how long a page without challenge and without content must stay that way to count as cleared
 *
 * @typedef {object} ParkedDeps
 * @property {Clock} clock
 * @property {(entry: ParkedEntry) => Promise<Probe>} probe look at the tab; read-only
 * @property {(entry: ParkedEntry, end: ParkEnd) => void} onEnd called once per parked job, after it left the list
 * @property {() => void} [onChange] the list changed
 * @property {number} [maxParked]
 * @property {Partial<ParkedTuning>} [tuning]
 *
 * @typedef {"challenge_unattended" | "challenge_pending" | "too_many_pending"} ParkRefusal
 */

/** @type {ParkedTuning} */
const DEFAULT_TUNING = Object.freeze({ pollMs: 1500, handedOffPollMs: 500, nudgeMs: 300, clearStableMs: 4000 });

/** @type {ParkStop} */
const TAB_CLOSED = Object.freeze({ outcome: "error", code: "tab_closed", message: "the tab with the human check was closed before the job finished", retryable: true });

export class Parked {
	#d;
	/** @type {ParkedTuning} */
	#tuning;
	#max;
	/** @type {Map<string, ParkedEntry>} by job id, oldest first */
	#entries = new Map();

	/** @param {ParkedDeps} deps */
	constructor(deps) {
		this.#d = deps;
		this.#tuning = { ...DEFAULT_TUNING, ...deps.tuning };
		this.#max = Math.min(deps.maxParked ?? PARK_LIMITS.maxParked, PARK_LIMITS.maxParked);
	}

	/** @param {string} job @returns {ParkedEntry | null} */
	get(job) {
		return this.#entries.get(job) ?? null;
	}

	/** @returns {{ job: string, host: string, kind: string, since: number, expiresAt: number, handedOff: boolean }[]} oldest first */
	list() {
		return [...this.#entries.values()].map((e) => ({ job: e.job, host: e.host, kind: e.kind, since: e.since, expiresAt: e.expiresAt, handedOff: e.handedOff }));
	}

	/**
	 * @param {string} site
	 * @returns {ParkedEntry | null} the challenge of that site that waits for the operator
	 */
	pendingFor(site) {
		for (const entry of this.#entries.values()) {
			if (entry.site === site) return entry;
		}
		return null;
	}

	/**
	 * May a job with a challenge on this site be parked?
	 * @param {string} site
	 * @param {number} parkMs how long the daemon lets it wait; 0: not at all
	 * @returns {ParkRefusal | null} null: yes
	 */
	refusal(site, parkMs) {
		if (!(parkMs > 0)) return "challenge_unattended";
		if (this.pendingFor(site) !== null) return "challenge_pending";
		if (this.#entries.size >= this.#max) return "too_many_pending";
		return null;
	}

	/**
	 * Start watching a challenge tab. Ask refusal() first.
	 * @param {{ job: string, host: string, site: string, tabId: number, kind: string, parkMs: number }} p
	 * @returns {ParkedEntry}
	 */
	park(p) {
		const reason = this.refusal(p.site, p.parkMs);
		if (reason !== null || this.#entries.has(p.job)) throw new Error(`cannot park: ${reason ?? "already parked"}`);
		const now = this.#d.clock.now();
		/** @type {ParkedEntry} */
		const entry = {
			job: p.job,
			host: p.host,
			site: p.site,
			tabId: p.tabId,
			kind: p.kind,
			since: now,
			expiresAt: now + Math.min(p.parkMs, PARK_LIMITS.maxParkMs),
			handedOff: false,
			clearSince: null,
			looking: false,
			lookTimer: null,
			expiryTimer: null,
		};
		this.#entries.set(entry.job, entry);
		entry.expiryTimer = this.#d.clock.setTimeout(() => this.#end(entry, { how: "expired" }), entry.expiresAt - now);
		this.#lookIn(entry, this.#tuning.pollMs);
		this.#d.onChange?.();
		return entry;
	}

	/**
	 * Something happened in the tab (a navigation completed): look soon.
	 * @param {string} job
	 */
	nudge(job) {
		const entry = this.#entries.get(job);
		if (entry !== undefined) this.#lookIn(entry, this.#tuning.nudgeMs);
	}

	/**
	 * The operator was given the tab.
	 * @param {string} job
	 * @returns {boolean} true the first time: that is the acknowledgement
	 */
	markHandedOff(job) {
		const entry = this.#entries.get(job);
		if (entry === undefined || entry.handedOff) return false;
		entry.handedOff = true;
		// From here on the tab is looked at more often.
		this.#lookIn(entry, this.#pollMs(entry));
		this.#d.onChange?.();
		return true;
	}

	/**
	 * End a parked job from outside.
	 * @param {string} job
	 * @param {ParkStop} stop
	 * @returns {boolean} false when no such job is parked
	 */
	stop(job, stop) {
		const entry = this.#entries.get(job);
		if (entry === undefined) return false;
		this.#end(entry, { how: "stopped", stop });
		return true;
	}

	/**
	 * The page left its challenge behind for certain, and the caller knows without looking: the tab's response
	 * is being read as a file. Ends the watch as cleared.
	 * @param {string} job
	 * @returns {boolean} false when no such job is parked
	 */
	cleared(job) {
		const entry = this.#entries.get(job);
		if (entry === undefined) return false;
		this.#end(entry, { how: "cleared" });
		return true;
	}

	/** @param {ParkedEntry} entry @returns {number} how long until the next look at its tab */
	#pollMs(entry) {
		return entry.handedOff ? Math.min(this.#tuning.handedOffPollMs, this.#tuning.pollMs) : this.#tuning.pollMs;
	}

	/**
	 * @param {ParkedEntry} entry
	 * @param {number} ms
	 */
	#lookIn(entry, ms) {
		this.#d.clock.clearTimeout(entry.lookTimer);
		entry.lookTimer = this.#d.clock.setTimeout(() => {
			entry.lookTimer = null;
			this.#look(entry).catch(() => {});
		}, ms);
	}

	/** @param {ParkedEntry} entry */
	async #look(entry) {
		if (this.#entries.get(entry.job) !== entry) return;
		if (entry.looking) return this.#lookIn(entry, this.#pollMs(entry));
		entry.looking = true;
		/** @type {Probe} */
		let probe;
		try {
			probe = await this.#d.probe(entry);
		} catch {
			probe = { state: "loading" };
		}
		entry.looking = false;
		// Ended while the probe ran: its answer is about a tab that is no longer watched.
		if (this.#entries.get(entry.job) !== entry) return;
		const now = this.#d.clock.now();
		if (probe.state === "gone") return this.#end(entry, { how: "stopped", stop: TAB_CLOSED });
		if (probe.state === "blocked") return this.#end(entry, { how: "blocked", detection: probe.detection });
		if (probe.state === "clear") {
			if (!probe.thin) return this.#end(entry, { how: "cleared" });
			// Nothing in the way, but hardly anything there either. A page between
			// two steps of a check looks like that for a moment; a page that
			// simply is short looks like that for good.
			entry.clearSince ??= now;
			if (now - entry.clearSince >= this.#tuning.clearStableMs) return this.#end(entry, { how: "cleared" });
		} else {
			entry.clearSince = null;
		}
		// A look that was asked for meanwhile (nudge) keeps its earlier time.
		if (entry.lookTimer === null) this.#lookIn(entry, this.#pollMs(entry));
	}

	/**
	 * @param {ParkedEntry} entry
	 * @param {ParkEnd} end only the first end of an entry counts
	 */
	#end(entry, end) {
		if (this.#entries.get(entry.job) !== entry) return;
		this.#entries.delete(entry.job);
		this.#d.clock.clearTimeout(entry.lookTimer);
		this.#d.clock.clearTimeout(entry.expiryTimer);
		entry.lookTimer = null;
		entry.expiryTimer = null;
		this.#d.onChange?.();
		this.#d.onEnd(entry, end);
	}
}
