import crypto from "node:crypto";
import { COOLDOWN, DEFAULT_PACING, LIMITS, LOGIN_PACING } from "./config.js";
import { ERROR_CODE, LIMITS as WIRE, MSG, makeMessage } from "../../extension/shared/protocol.js";
import { REASON, checkUrl, matchBlocklist } from "../../extension/shared/policy.js";
import { siteOf } from "./site.js";

/**
 * @typedef {import("../../extension/shared/protocol.js").ExtState} ExtState
 * @typedef {import("../../extension/shared/protocol.js").JobResultBody} JobResultBody
 * @typedef {import("../../extension/shared/protocol.js").JobError} JobError
 * @typedef {import("../../extension/shared/protocol.js").JobExtract} JobExtract
 * @typedef {import("../../extension/shared/protocol.js").Outcome} Outcome
 * @typedef {import("../../extension/shared/protocol.js").CookieScope} CookieScope
 * @typedef {import("../../extension/shared/protocol.js").JobAcceptedMsg} JobAcceptedMsg
 * @typedef {import("../../extension/shared/protocol.js").JobProgressMsg} JobProgressMsg
 */

/**
 * A checked job, ready to queue. The URL has passed policy and is normalised.
 * @typedef {object} JobSpec
 * @property {"fetch" | "probe" | "search"} kind
 * @property {string} url for a search: the results page, made by the daemon from the engine's template and the query
 * @property {{ engine: string, limit: number }} [search] of a search: the engine's name (it tells the extension which
 *   of its hints to try) and how many results are wanted
 * @property {string} host
 * @property {"auto" | "isolated"} session a search is always "isolated"
 * @property {{ timeout_ms: number, settle_ms: number, dwell_ms: number | null, human_wait_ms: number, scroll: "none" | "lazy" }} wait
 *   dwell_ms null: the queue picks a randomised dwell from the host's pacing profile.
 *   human_wait_ms: how long a challenge page may wait, parked, for the operator; 0: it is not kept
 * @property {JobExtract} extract
 * @property {{ max_bytes: number, types: string[] } | null} [files] what the job may bring back when its response is a
 *   file instead of a page: how many bytes at most, and of which types. Absent or null: no file
 * @property {string} dedupeKey identical in-flight jobs share one run
 * @property {{ blocklist?: readonly string[], allowLoopbackPorts?: readonly number[] }} [policy] the URL policy the
 *   job's address has passed, as given to checkUrl. The address the browser says the page ended at is held to the
 *   same. Absent: the default policy
 */

/**
 * What a caller gets back for a job: the extension's job.result body, or a
 * record of the same shape made by the daemon (render is null then).
 * @typedef {Omit<JobResultBody, "render"> & { render: JobResultBody["render"] | null, blob?: import("./blobs.js").Blob,
 *   file_info?: { type: string | null, size: number } }} JobReport
 *   blob: the file of a result that brought one, whole and checked, where it lies until it is stored.
 *   file_info: what is written down about a file, kept or refused: the sniffer's word for it and its size
 *
 * What the queue asks of whoever puts the pieces of a file together (blobs.js).
 * @typedef {Pick<import("./blobs.js").BlobAssembler, "accept" | "complete" | "discard">} BlobSink
 */

/**
 * What a caller is told about a job that waits for the operator.
 * @typedef {object} ParkedInfo
 * @property {string} job
 * @property {string} host
 * @property {CookieScope | null} cookie_scope
 * @property {number | null} http_status
 * @property {JobResultBody["detect"]} detect what the extension found; evidence is the extension's wording
 * @property {number} retry_after_s when asking for the URL again makes sense
 * @property {number} expires_in_s how long the page is kept open for the operator
 *
 * @typedef {object} PendingJob a parked job, for the operator's view
 * @property {string} job
 * @property {string} host
 * @property {string} kind what was detected
 * @property {number} waiting_s
 * @property {number} expires_in_s
 * @property {boolean} acked the operator has the page
 *
 * @typedef {object} ChallengeListener told when a job is parked, acknowledged, cleared and over
 * @property {(job: { job: string, host: string }) => void} pending
 * @property {(job: { job: string, host: string }) => void} acked
 * @property {(job: { job: string, host: string }) => void} [cleared] the challenge is gone and the page is being read: its
 *   result follows, and nobody is needed any more
 * @property {(job: { job: string, host: string }) => void} ended
 *
 * @typedef {object} JobHandle
 * @property {string} job
 * @property {Promise<JobReport>} promise always resolves, never rejects
 * @property {Promise<ParkedInfo | null>} parked resolves when the job is parked for the operator - its report follows
 *   whenever the job ends - or with null when the job ends without ever having been parked
 * @property {boolean} deduped true when this call joined a job already in flight
 * @property {() => void} release the caller stopped waiting; a job that is queued or running is cancelled once nobody
 *   waits, a parked one lives on
 */

/**
 * @typedef {object} Entry
 * @property {string} id
 * @property {JobSpec} spec
 * @property {"queued" | "dispatched" | "parked" | "done"} status
 * @property {number} submittedAt
 * @property {number} waiters callers still waiting
 * @property {number} callers callers that ever joined, for the audit entry
 * @property {string} site what gaps and the hourly budget are kept for
 * @property {unknown} timer queue deadline while queued, run deadline once dispatched, park deadline once parked
 * @property {number} deadlineAt when that timer fires
 * @property {number} dispatchedAt
 * @property {boolean} graceGranted the run deadline was moved once for a challenge's grace period
 * @property {boolean} fileGranted the run deadline was moved once for the transfer of a file
 * @property {Promise<JobReport>} promise
 * @property {(report: JobReport) => void} resolve
 * @property {Promise<ParkedInfo | null>} parkedPromise
 * @property {(info: ParkedInfo | null) => void} resolveParked
 * @property {CookieScope | null} cookieScope from job.accepted
 * @property {number | null} httpStatus from job.progress
 * @property {{ since: number, expiresAt: number, detect: JobResultBody["detect"], acked: boolean, cleared: boolean } | null} park set while and after
 *   the job is parked. cleared: the extension saw the challenge gone and is reading the page
 * @property {number} hostGapMs
 * @property {number} globalGapMs
 * @property {string | null} loginKey the opt-in host the job may run under with the operator's login; null: it cannot
 */

const HOUR_MS = 3600000;

/** @returns {string} */
export function newJobId() {
	return "j_" + crypto.randomBytes(9).toString("base64url");
}

/**
 * A daemon-made record in the shape of a job.result.
 * @param {string} job
 * @param {string} url
 * @param {Outcome} outcome
 * @param {JobError | null} error
 * @param {CookieScope | null} [cookieScope]
 * @returns {JobReport}
 */
export function synthReport(job, url, outcome, error, cookieScope = null) {
	return {
		job,
		outcome,
		cookie_scope: cookieScope,
		nav: { requested_url: url, final_url: null, redirect_origins: [], http_status: null, content_type: null, body_bytes: null },
		render: null,
		detect: null,
		error,
		page: null,
		extraction: null,
		content: null,
		truncated: { markdown: false, text: false, html: false, raw_html: false },
		file: null,
		tab_kept_open: false,
	};
}

/**
 * The URL policy, for the address a page ended at. The same rules as for the
 * address a job asks for - scheme, host classification, blocklist; text only,
 * nothing is resolved - with the one difference the extension makes for a
 * redirect hop: such an address may be longer than an agent's URL, and is
 * then judged by its origin, which is what the rules look at anyway.
 * @param {string} url
 * @param {NonNullable<JobSpec["policy"]>} policy
 * @returns {string | null} the reason it is not allowed; null: it is
 */
function finalUrlRefusal(url, policy) {
	let verdict = checkUrl(url, policy);
	if (!verdict.allowed && verdict.reason === REASON.URL_TOO_LONG) {
		/** @type {URL} */
		let u;
		try {
			u = new URL(url);
		} catch {
			return REASON.INVALID_URL;
		}
		if (u.username !== "" || u.password !== "") return REASON.USERINFO;
		verdict = checkUrl(u.origin + "/", policy);
	}
	return verdict.allowed ? null : verdict.reason;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {boolean} retryable
 * @param {number | null} [retryAfterS]
 * @returns {JobError}
 */
function jobError(code, message, retryable, retryAfterS = null) {
	return { code, message, retryable, retry_after_s: retryAfterS };
}

/**
 * Serial job dispatch to the extension with pacing, dedupe and deadlines.
 *
 * A job is queued, then dispatched (job.start sent), then done. The daemon
 * owns both deadlines: the time a job may wait in the queue (maxQueueMs), and
 * the time it may run once dispatched (its wait values plus a grace period,
 * never more than maxRunMs). So no job, whoever submits it, lives longer than
 * maxQueueMs + maxRunMs. Callers always get exactly one report per job.
 *
 * Pacing is kept per site, not per host name: the gap after a job, and an
 * hourly budget of dispatched jobs. A job over the budget is refused at once
 * with the number of seconds until the budget frees.
 *
 * Redirects. A load that the browser was sent on from, to another site, is a
 * load of that site as well. When a job ends, every other site its top frame
 * was at - the hops the extension reports, and where it ended - gets the gap
 * of its own profile and one load in its hourly budget; the site that was
 * asked keeps what it was charged at dispatch. None of that is known before
 * the job ran, so it is the next job for such a site that waits for the gap,
 * or is refused for the budget, whether it comes in or is queued already.
 * A block cools the site that was asked and the site the load ended at. The
 * hops in between are not cooled: they passed the browser on.
 *
 * Parked jobs. When the extension reports challenge.pending for a running
 * job, the page shows a challenge that only the operator can clear. The job
 * then leaves the slot - the next one runs - and waits outside the run budget
 * until the extension sends its one result: the page was cleared and read,
 * turned into a refusal, was closed, or nobody came in time. The extension
 * owns that expiry; the daemon's own timer runs a little longer and only
 * fires if the extension says nothing. A few jobs may be parked at once, one
 * per site. Parked jobs survive nothing: when the link goes down, or the
 * daemon stops, they end.
 *
 * Login pacing. The extension reports the hosts the operator opted in to
 * their logged-in session (the hosts only; the rules stay in the browser, and
 * so does the decision which job runs with the login). A fetch that may run
 * that way - session "auto", on such a host or below it - is held to the pace
 * the extension enforces per rule: one page per gap, so many an hour. The
 * count is of the jobs the extension said it ran with the login; the gap is
 * kept from the last of those. The extension's own limit is the one that
 * counts, and it is per rule; this one, per host, only keeps the daemon from
 * running into it.
 *
 * Cooldown. A site that blocked a job, or whose challenge nobody cleared, is
 * left alone for a while: longer every time in a row, with jitter, at least
 * as long as its Retry-After asks, within maxRetryAfterMs. A Retry-After is
 * the word of the site that sent it and holds that site only: where a load
 * was redirected and blocked elsewhere, the site that was asked gets the
 * ordinary step. While a challenge of a site waits for the
 * operator the site is not asked again at all. Jobs that are refused for
 * either reason are never dispatched and say when to try again: the ones that
 * come in, and the ones that were waiting in the queue for that site when it
 * said no.
 *
 * The extension's word. Which cookie store a job ran with, and where its page
 * ended, is what the extension says. Two things of it are checked here before
 * a result goes anywhere. A job the extension took with the operator's login
 * (job.accepted) stays one: a result that claims the container for it is
 * handled as a login page - shown once, never stored. And the address a page
 * ended at must pass the URL policy the job's own address passed; a result
 * from anywhere else ends the job as a policy refusal, and nothing of the
 * page is passed on.
 *
 * Files. A job whose spec says so may end with a file instead of a page: its
 * bytes arrive in job.blob frames before the result and are put together by
 * the blob sink. Frames for any other job are dropped. Whatever ends a job
 * without a whole, checked file - a deadline, a cancel, the loss of the link,
 * a result that does not match what arrived - also removes what arrived.
 */
export class JobQueue {
	#clock;
	#rng;
	#log;
	#audit;
	#send;
	#pacing;
	#fastHosts;
	/** @type {import("./config.js").ProfileName} */
	#defaultProfile;
	#limits;
	/** @type {(host: string) => string} */
	#siteOf;
	/** @type {Entry[]} */
	#queued = [];
	/** @type {Map<string, Entry>} */
	#dispatched = new Map();
	/**
	 * Cancelled jobs whose slot is still held until the extension confirms with
	 * its (late) result or the grace period ends. Keeps tabs from overlapping.
	 * @type {Map<string, unknown>}
	 */
	#draining = new Map();
	/** @type {Map<string, Entry>} jobs whose challenge page waits for the operator; they hold no slot */
	#parked = new Map();
	/** @type {Map<string, { until: number, step: number, at: number }>} by site: left alone until, how often in a row, since when */
	#cooldown = new Map();
	/** @type {ChallengeListener | null} */
	#onChallenge;
	/** @type {Map<string, Entry>} */
	#byKey = new Map();
	/** @type {Map<string, number>} by site */
	#siteReadyAt = new Map();
	/** @type {Map<string, number[]>} dispatch times of the last hour by site, oldest first */
	#siteLog = new Map();
	/** @type {import("./config.js").LoginPacing} */
	#loginPacing;
	/** @type {Map<string, number>} by opt-in host: when the next page with the operator's login may be asked for */
	#loginReadyAt = new Map();
	/** @type {Map<string, number[]>} by opt-in host: pages of the last hour that ran with the operator's login, oldest first */
	#loginLog = new Map();
	#globalReadyAt = 0;
	/** @type {ExtState | null} null while no extension is connected */
	#state = null;
	/** @type {unknown} */
	#pumpTimer = null;
	#closed = false;
	/** @type {BlobSink | null} */
	#blobs;
	/** @type {Set<string>} jobs whose stray job.blob frames were written to the log once */
	#strayBlobs = new Set();

	/**
	 * @param {object} opts
	 * @param {import("./log.js").Clock} opts.clock
	 * @param {() => number} opts.rng uniform in [0, 1), used for jitter only
	 * @param {import("./log.js").Logger} opts.log
	 * @param {{ append(entry: import("./audit.js").AuditEntry): void }} opts.audit
	 * @param {(msg: Record<string, unknown>) => boolean} opts.send deliver a frame to the extension; false when the link is down
	 * @param {import("./config.js").Pacing} [opts.pacing]
	 * @param {readonly string[]} [opts.fastHosts] domain suffixes that use the fast profile
	 * @param {import("./config.js").ProfileName} [opts.defaultProfile] profile of every other host
	 * @param {{ maxQueued?: number, maxQueueMs?: number, maxRunMs?: number, runGraceMs?: number, cancelGraceMs?: number,
	 *   maxParked?: number, parkGraceMs?: number, challengeGraceMs?: number, fileGraceMs?: number }} [opts.limits]
	 * @param {ChallengeListener} [opts.onChallenge] whoever notifies the operator
	 * @param {Partial<import("./config.js").LoginPacing>} [opts.loginPacing] tests only: other numbers than the extension's own
	 * @param {BlobSink} [opts.blobs] puts the pieces of a file together; without it no job brings a file back
	 * @param {(host: string) => string} [opts.siteOf] tests only: another rule for which hosts are one site. Everything
	 *   that is kept per site - gap, hourly budget, cooldown, the one challenge that may wait - is kept by this key
	 *   and by nothing else, so a rule that tells more sites apart needs no change here
	 */
	constructor({ clock, rng, log, audit, send, pacing, fastHosts, defaultProfile, limits, onChallenge, loginPacing, blobs, siteOf: siteRule }) {
		this.#clock = clock;
		this.#rng = rng;
		this.#log = log;
		this.#audit = audit;
		this.#send = send;
		this.#pacing = pacing ?? DEFAULT_PACING;
		this.#fastHosts = fastHosts ?? [];
		this.#defaultProfile = defaultProfile === "fast" ? "fast" : "polite";
		this.#limits = {
			maxQueued: limits?.maxQueued ?? LIMITS.maxQueued,
			maxQueueMs: limits?.maxQueueMs ?? LIMITS.maxQueueMs,
			maxRunMs: limits?.maxRunMs ?? LIMITS.maxRunMs,
			runGraceMs: limits?.runGraceMs ?? LIMITS.runGraceMs,
			cancelGraceMs: limits?.cancelGraceMs ?? LIMITS.cancelGraceMs,
			maxParked: limits?.maxParked ?? LIMITS.maxParked,
			parkGraceMs: limits?.parkGraceMs ?? LIMITS.parkGraceMs,
			challengeGraceMs: limits?.challengeGraceMs ?? LIMITS.challengeGraceMs,
			fileGraceMs: limits?.fileGraceMs ?? LIMITS.fileGraceMs,
		};
		this.#onChallenge = onChallenge ?? null;
		this.#loginPacing = { ...LOGIN_PACING, ...loginPacing };
		this.#blobs = blobs ?? null;
		this.#siteOf = siteRule ?? siteOf;
	}

	/**
	 * A job.blob frame: a piece of the file a running job brings back.
	 * @param {import("../../extension/shared/protocol.js").JobBlobMsg} msg validated
	 */
	onBlob(msg) {
		const entry = this.#dispatched.get(msg.job) ?? this.#parked.get(msg.job);
		const files = entry?.spec.files ?? null;
		if (entry === undefined || files === null || this.#blobs === null) {
			// A job that is over (cancelled a moment ago), or one that was never allowed a file: not kept, said once.
			if (!this.#strayBlobs.has(msg.job)) {
				if (this.#strayBlobs.size >= 64) this.#strayBlobs.clear();
				this.#strayBlobs.add(msg.job);
				this.#log.warn("job.message_dropped", { type: MSG.JOB_BLOB, job: msg.job });
			}
			return;
		}
		this.#blobs.accept(entry.id, msg, files.max_bytes);
	}

	/**
	 * The result of a job says that its response was a file. What arrived for it is checked here, and the
	 * report is made of that: the file, or the reason why there is none.
	 * @param {Entry} entry
	 * @param {JobResultBody} body
	 * @returns {JobReport}
	 */
	#fileReport(entry, body) {
		const file = /** @type {NonNullable<JobResultBody["file"]>} */ (body.file);
		const files = entry.spec.files ?? null;
		if (files === null || this.#blobs === null || body.outcome !== "ok" || body.cookie_scope !== "container") {
			// Never asked for, or not from the container: nothing of it is kept.
			this.#blobs?.discard(entry.id);
			this.#log.error("job.file_unexpected", { job: entry.id });
			return synthReport(entry.id, entry.spec.url, "error", jobError(ERROR_CODE.FILE_UNEXPECTED, "the extension returned a file for a job that may not bring one back", false), body.cookie_scope);
		}
		const done = this.#blobs.complete(entry.id, file, files, body.nav.content_type);
		if (done.ok) return { ...body, blob: done.blob, file_info: { type: done.blob.sniffed, size: done.blob.size } };
		this.#log.warn("job.file_refused", { job: entry.id, code: done.code, reason: done.reason });
		const transfer = done.code === ERROR_CODE.FILE_TRANSFER_FAILED;
		const report = synthReport(
			entry.id,
			entry.spec.url,
			transfer ? "error" : "unsupported",
			jobError(done.code, transfer ? "the pieces of the file did not add up" : "the file is not one the gateway keeps", transfer),
			body.cookie_scope,
		);
		report.nav.http_status = body.nav.http_status;
		report.nav.redirect_origins = body.nav.redirect_origins;
		report.nav.body_bytes = file.size;
		report.detect = body.detect;
		report.file_info = { type: done.sniffed, size: file.size };
		return report;
	}

	/**
	 * @param {JobSpec} spec
	 * @returns {string | null} the opt-in host a job may run under with the operator's login: the closest one that
	 *   is the job's host or above it. null for a job that cannot (a search, a probe, session "isolated")
	 */
	#loginKey(spec) {
		if (spec.kind !== "fetch" || spec.session !== "auto" || this.#state === null) return null;
		/** @type {string | null} */
		let best = null;
		for (const host of this.#state.optin_hosts) {
			if ((spec.host === host || spec.host.endsWith("." + host)) && (best === null || host.length > best.length)) best = host;
		}
		return best;
	}

	/**
	 * @param {string} key an opt-in host
	 * @param {number} now
	 * @returns {number} seconds until the hour's count of pages with the operator's login frees a place; 0: there is one
	 */
	#loginBudgetWaitS(key, now) {
		const log = this.#loginLog.get(key);
		if (log === undefined) return 0;
		let old = 0;
		while (old < log.length && log[old] <= now - HOUR_MS) old++;
		if (old > 0) log.splice(0, old);
		if (log.length === 0) this.#loginLog.delete(key);
		if (log.length < this.#loginPacing.perHour) return 0;
		return Math.max(1, Math.ceil((log[log.length - this.#loginPacing.perHour] + HOUR_MS - now) / 1000));
	}

	/**
	 * A job ran, or was refused, under the operator's login: keep the next one away for as long as the extension would.
	 * @param {string} key an opt-in host
	 * @param {number} until
	 */
	#holdLogin(key, until) {
		this.#loginReadyAt.set(key, Math.max(this.#loginReadyAt.get(key) ?? 0, until));
		if (this.#loginReadyAt.size > 512) {
			const now = this.#clock.now();
			for (const [k, at] of this.#loginReadyAt) {
				if (at <= now) this.#loginReadyAt.delete(k);
			}
		}
	}

	/**
	 * @param {string} host
	 * @returns {import("./config.js").PacingProfile}
	 */
	#profileFor(host) {
		return matchBlocklist(host, this.#fastHosts) !== null ? this.#pacing.fast : this.#pacing[this.#defaultProfile];
	}

	/**
	 * Callers that hold a place without holding the slot: everyone waiting on a
	 * queued job, and everyone but the first on a running one.
	 * @returns {number}
	 */
	#waitingCallers() {
		let n = 0;
		for (const entry of this.#queued) n += entry.waiters;
		for (const entry of this.#dispatched.values()) n += Math.max(0, entry.waiters - 1);
		// A parked job holds no slot: everyone who waits on one only holds a place.
		for (const entry of this.#parked.values()) n += entry.waiters;
		return n;
	}

	/**
	 * Leave a site alone for a while: it blocked a job, or its challenge was not cleared.
	 * @param {string} site
	 * @param {string} host the host it was seen under: its pacing profile says how long
	 * @param {number} now
	 * @param {number | null} retryAfterS what the site asked for; null: nothing, or it was not this site that answered
	 */
	#coolSite(site, host, now, retryAfterS) {
		const range = this.#profileFor(host).cooldownMs;
		if (range === undefined) return;
		const prev = this.#cooldown.get(site);
		// Every time in a row doubles the wait; a site that behaved for a while starts over.
		const step = prev !== undefined && now - prev.at < COOLDOWN.forgetMs ? Math.min(prev.step + 1, 32) : 1;
		let ms = Math.min(range[0] * 2 ** (step - 1), range[1]);
		ms += Math.round(ms * COOLDOWN.jitter * Math.min(Math.max(this.#rng(), 0), 1));
		if (retryAfterS !== null && Number.isFinite(retryAfterS) && retryAfterS > 0) ms = Math.max(ms, Math.min(retryAfterS * 1000, COOLDOWN.maxRetryAfterMs));
		this.#cooldown.set(site, { until: Math.max(prev?.until ?? 0, now + ms), step, at: now });
		if (this.#cooldown.size > 512) {
			for (const [key, c] of this.#cooldown) {
				if (c.until <= now && now - c.at >= COOLDOWN.forgetMs) this.#cooldown.delete(key);
			}
		}
	}

	/**
	 * @param {string} site
	 * @param {number} now
	 * @returns {number} seconds until the site may be asked again; 0: now
	 */
	#cooldownLeftS(site, now) {
		const c = this.#cooldown.get(site);
		return c === undefined || c.until <= now ? 0 : Math.ceil((c.until - now) / 1000);
	}

	/**
	 * When to ask again for a URL whose site has a challenge waiting for the
	 * operator: after the site's first cooldown step, or when the wait is over.
	 * @param {Entry} parked
	 * @param {number} now
	 * @returns {number} seconds
	 */
	#pendingRetryS(parked, now) {
		const first = this.#profileFor(parked.spec.host).cooldownMs?.[0] ?? 60000;
		const left = parked.park === null ? first : Math.max(0, parked.park.expiresAt - now);
		return Math.max(1, Math.ceil(Math.min(first, left) / 1000));
	}

	/**
	 * Why a site is not asked right now, as a job for it is told: a challenge of
	 * it waits for the operator - the answer names the job that waits - or it
	 * blocked a job a moment ago and is left alone.
	 * @param {string} site
	 * @param {number} now
	 * @returns {{ outcome: Outcome, error: JobError, about: { pendingJob?: string, detect?: JobResultBody["detect"] } } | null} null: it may be asked
	 */
	#siteHeld(site, now) {
		for (const parked of this.#parked.values()) {
			if (parked.site !== site) continue;
			return {
				outcome: "needs_human",
				error: jobError(ERROR_CODE.CHALLENGE_PENDING, "a human check of this site is waiting for the operator", true, this.#pendingRetryS(parked, now)),
				about: { pendingJob: parked.id, detect: parked.park?.detect ?? null },
			};
		}
		const cooling = this.#cooldownLeftS(site, now);
		if (cooling === 0) return null;
		return {
			outcome: "blocked",
			error: jobError(ERROR_CODE.SITE_COOLDOWN, "the site blocked or challenged a moment ago and is left alone for a while", true, cooling),
			about: {},
		};
	}

	/**
	 * Jobs that were queued before their site stopped being asked end here,
	 * with what a new job for the site is told: the block or the challenge of
	 * one job is the answer for all that wait behind it. Not one of them is
	 * sent to a site that has just said no.
	 *
	 * The same for the hourly budget. A job is only queued while its site has
	 * room for it, but loads that were redirected to the site are counted when
	 * they end, and can use the room up while the job waits.
	 * @param {number} now
	 */
	#endHeld(now) {
		for (const entry of [...this.#queued]) {
			const held = this.#siteHeld(entry.site, now);
			const over = held === null ? this.#overBudget(entry.spec, entry.site, now, false) : null;
			if (held === null && over === null) continue;
			this.#queued.splice(this.#queued.indexOf(entry), 1);
			if (held === null) {
				this.#log.warn("job.site_budget", { retry_after_s: over?.retry_after_s ?? null });
				this.#finish(entry, synthReport(entry.id, entry.spec.url, "error", /** @type {JobError} */ (over)));
				continue;
			}
			// As for a refused job: the report names the job that waits; the audit entry keeps this job's own id.
			const report = synthReport(held.about.pendingJob ?? entry.id, entry.spec.url, held.outcome, held.error);
			if (held.about.detect !== undefined) report.detect = held.about.detect;
			this.#finish(entry, report);
		}
	}

	/**
	 * Where a load went besides the site it was asked of. The extension reports
	 * the origin of every hop of the top frame that left the one before, and
	 * for a page that was read the address it ended at.
	 * @param {Entry} entry
	 * @param {JobResultBody["nav"]} nav
	 * @returns {{ passed: Map<string, string>, end: string | null }} passed: every other site the load was at, each
	 *   once, with the host it was seen under. end: the one of them it ended at; null when it ended at the site that
	 *   was asked, or went nowhere else
	 */
	#elsewhere(entry, nav) {
		/** @type {Map<string, string>} */
		const passed = new Map();
		let last = entry.site;
		for (const address of nav.final_url === null ? nav.redirect_origins : [...nav.redirect_origins, nav.final_url]) {
			let host = "";
			try {
				host = new URL(address).hostname;
			} catch {
				// not an address: nothing to keep a site by
			}
			if (host === "") continue;
			last = this.#siteOf(host);
			if (last !== entry.site && !passed.has(last)) passed.set(last, host);
		}
		return { passed, end: last === entry.site ? null : last };
	}

	/** @returns {number} jobs whose page waits for the operator */
	pendingCount() {
		return this.#parked.size;
	}

	/** @returns {PendingJob[]} the same, with job ids and hosts: for the operator only */
	pending() {
		const now = this.#clock.now();
		return [...this.#parked.values()].map((entry) => ({
			job: entry.id,
			host: entry.spec.host,
			kind: typeof entry.park?.detect?.kind === "string" ? entry.park.detect.kind : "unknown",
			waiting_s: Math.max(0, Math.floor((now - (entry.park?.since ?? now)) / 1000)),
			expires_in_s: Math.max(0, Math.ceil(((entry.park?.expiresAt ?? now) - now) / 1000)),
			acked: entry.park?.acked === true,
		}));
	}

	/**
	 * Ask the extension to bring the page of a parked job to the operator.
	 * @param {string} job
	 * @param {"focus" | "renotify"} [action]
	 * @returns {boolean} false when no such job waits, or the link is down
	 */
	attention(job, action = "focus") {
		if (!this.#parked.has(job)) return false;
		return this.#send(makeMessage(MSG.ATTENTION, { job, action }));
	}

	/**
	 * @param {string} site
	 * @param {number} now
	 * @returns {number[]} dispatch times of the last hour, oldest first
	 */
	#recent(site, now) {
		const log = this.#siteLog.get(site);
		if (log === undefined) return [];
		let old = 0;
		while (old < log.length && log[old] <= now - HOUR_MS) old++;
		if (old > 0) log.splice(0, old);
		if (log.length === 0) this.#siteLog.delete(site);
		return log;
	}

	/**
	 * A load of a site, for its hourly budget.
	 * @param {string} site
	 * @param {number} now
	 */
	#logLoad(site, now) {
		const log = this.#siteLog.get(site);
		if (log === undefined) this.#siteLog.set(site, [now]);
		else log.push(now);
		if (this.#siteLog.size > 512) {
			for (const s of [...this.#siteLog.keys()]) this.#recent(s, now);
		}
	}

	/**
	 * @param {JobSpec} spec
	 * @param {string} site
	 * @param {number} now
	 * @param {boolean} [queuedToo] count the jobs that wait for the site as loads to come: for a job that asks to
	 *   join them. false for one of those that wait
	 * @returns {JobError | null} the refusal when the site's hourly budget is used up
	 */
	#overBudget(spec, site, now, queuedToo = true) {
		const budget = this.#profileFor(spec.host).hourlyBudget;
		if (budget === undefined || !Number.isFinite(budget)) return null;
		const recent = this.#recent(site, now);
		let waiting = 0;
		if (queuedToo) for (const entry of this.#queued) if (entry.site === site) waiting++;
		if (recent.length + waiting < budget) return null;
		// The budget frees when the oldest load of the hour leaves the window.
		const retryAfterS = recent.length > 0 ? Math.max(1, Math.ceil((recent[0] + HOUR_MS - now) / 1000)) : 60;
		return jobError(ERROR_CODE.SITE_BUDGET, "the hourly budget for this site is used up", false, retryAfterS);
	}

	/** @returns {{ queued: number, dispatched: number }} */
	stats() {
		return { queued: this.#queued.length, dispatched: this.#dispatched.size };
	}

	/**
	 * @param {JobSpec} spec
	 * @returns {JobHandle}
	 */
	submit(spec) {
		if (this.#closed) {
			return this.#refuse(spec, "aborted", jobError(ERROR_CODE.SHUTDOWN, "the daemon is shutting down", true));
		}
		const existing = this.#byKey.get(spec.dedupeKey);
		if (existing !== undefined) {
			// Joining costs no browser load, but every caller is a held request:
			// they count against the same limit as queued jobs.
			if (this.#waitingCallers() >= this.#limits.maxQueued) {
				return this.#refuse(spec, "error", jobError(ERROR_CODE.QUEUE_FULL, "too many jobs are waiting", true));
			}
			existing.waiters += 1;
			existing.callers += 1;
			return this.#handle(existing, true);
		}
		if (this.#state === null) {
			return this.#refuse(
				spec,
				"error",
				jobError(ERROR_CODE.EXTENSION_NOT_CONNECTED, "the browser extension is not connected", true),
			);
		}
		if (this.#state.paused) {
			return this.#refuse(spec, "error", jobError(ERROR_CODE.PAUSED, "the operator paused the gateway", false));
		}
		if (this.#waitingCallers() >= this.#limits.maxQueued) {
			return this.#refuse(spec, "error", jobError(ERROR_CODE.QUEUE_FULL, "too many jobs are waiting", true));
		}
		const now = this.#clock.now();
		const site = this.#siteOf(spec.host);
		const held = this.#siteHeld(site, now);
		if (held !== null) return this.#refuse(spec, held.outcome, held.error, held.about);
		const over = this.#overBudget(spec, site, now);
		if (over !== null) {
			this.#log.warn("job.site_budget", { retry_after_s: over.retry_after_s });
			return this.#refuse(spec, "error", over);
		}
		const loginKey = this.#loginKey(spec);
		let loginWaitS = loginKey === null ? 0 : this.#loginBudgetWaitS(loginKey, now);
		// The ordinary gap is waited for in the queue. A longer hold - the extension said that the hour's
		// pages of a rule are used up - is said at once: no caller is kept waiting for what cannot come.
		const heldMs = loginKey === null ? 0 : (this.#loginReadyAt.get(loginKey) ?? 0) - now;
		if (heldMs > 2 * (this.#loginPacing.minGapMs + this.#loginPacing.marginMs)) loginWaitS = Math.max(loginWaitS, Math.ceil(heldMs / 1000));
		if (loginWaitS > 0) {
			this.#log.warn("job.login_rate_limit", { retry_after_s: loginWaitS });
			return this.#refuse(spec, "error", jobError(ERROR_CODE.LOGIN_RATE_LIMIT, "pages read with the operator's login are limited per hour", true, loginWaitS));
		}

		/** @type {(report: JobReport) => void} */
		let resolve = () => {};
		/** @type {Promise<JobReport>} */
		const promise = new Promise((res) => {
			resolve = res;
		});
		/** @type {(info: ParkedInfo | null) => void} */
		let resolveParked = () => {};
		/** @type {Promise<ParkedInfo | null>} */
		const parkedPromise = new Promise((res) => {
			resolveParked = res;
		});
		/** @type {Entry} */
		const entry = {
			id: newJobId(),
			spec,
			status: "queued",
			submittedAt: now,
			waiters: 1,
			callers: 1,
			site,
			timer: null,
			deadlineAt: now + this.#limits.maxQueueMs,
			dispatchedAt: 0,
			graceGranted: false,
			fileGranted: false,
			promise,
			resolve,
			parkedPromise,
			resolveParked,
			cookieScope: null,
			httpStatus: null,
			park: null,
			hostGapMs: 0,
			globalGapMs: 0,
			loginKey,
		};
		entry.timer = this.#clock.setTimeout(() => this.#onQueueDeadline(entry), this.#limits.maxQueueMs);
		this.#queued.push(entry);
		this.#byKey.set(spec.dedupeKey, entry);
		this.#pump();
		return this.#handle(entry, false);
	}

	/**
	 * The extension finished its handshake.
	 * @param {ExtState} state
	 */
	linkUp(state) {
		this.#state = state;
		if (state.paused) this.#flushPaused();
		this.#pump();
	}

	/**
	 * The extension link is gone: dispatched jobs fail, queued jobs keep waiting.
	 *
	 * A lost connection may be retried. A link the daemon cut because the
	 * extension sent something invalid (for one, a result that is malformed or
	 * too large) may not: the same job would most likely end the same way.
	 * @param {import("./extlink.js").DownCause} [cause]
	 */
	linkDown(cause = "lost") {
		this.#state = null;
		this.#clearPumpTimer();
		for (const grace of this.#draining.values()) this.#clock.clearTimeout(grace);
		this.#draining.clear();
		const error =
			cause === "violation"
				? jobError(ERROR_CODE.INVALID_RESULT, "the extension sent an invalid or oversized message while the job was running", false)
				: jobError(ERROR_CODE.BROWSER_DISCONNECTED, "the browser disconnected while the job was running", true);
		for (const entry of [...this.#dispatched.values()]) {
			this.#dispatched.delete(entry.id);
			this.#finish(entry, synthReport(entry.id, entry.spec.url, "error", error, entry.cookieScope));
		}
		// Parked jobs survive nothing: the extension closes their tabs when it
		// loses the link, and a new link starts without them.
		for (const entry of [...this.#parked.values()]) {
			this.#finish(entry, this.#parkedReport(entry, "error", error));
		}
	}

	/**
	 * The extension reported new state (event message).
	 * @param {ExtState} state
	 */
	setState(state) {
		if (this.#state === null) return;
		this.#state = state;
		if (state.paused) this.#flushPaused();
		this.#pump();
	}

	/** @param {JobAcceptedMsg} msg */
	onAccepted(msg) {
		const entry = this.#dispatched.get(msg.job);
		if (entry === undefined) {
			this.#log.warn("job.message_dropped", { type: MSG.JOB_ACCEPTED, job: msg.job });
			return;
		}
		entry.cookieScope = msg.cookie_scope;
		if (msg.cookie_scope !== "default") return;
		// The extension ran it with the operator's login: counted, and the next one is kept away for the gap.
		const now = this.#clock.now();
		const key = entry.loginKey ?? msg.rule?.host ?? entry.spec.host;
		entry.loginKey = key;
		const log = this.#loginLog.get(key);
		if (log === undefined) this.#loginLog.set(key, [now]);
		else log.push(now);
		if (this.#loginLog.size > 512) this.#loginLog.delete(/** @type {string} */ (this.#loginLog.keys().next().value));
		this.#holdLogin(key, now + this.#loginPacing.minGapMs + this.#loginPacing.marginMs);
	}

	/** @param {JobProgressMsg} msg */
	onProgress(msg) {
		const entry = this.#dispatched.get(msg.job) ?? this.#parked.get(msg.job);
		if (entry === undefined) {
			this.#log.warn("job.message_dropped", { type: MSG.JOB_PROGRESS, job: msg.job });
			return;
		}
		if (msg.http_status !== null) entry.httpStatus = msg.http_status;
		if (msg.phase === "receiving_file" && entry.status === "dispatched" && !entry.fileGranted && (entry.spec.files ?? null) !== null) {
			// The response is a file: the job gets the time its bytes take to come over on top of what it has
			// left, once, and never more than a job may run in all.
			entry.fileGranted = true;
			this.#extend(entry, this.#limits.fileGraceMs);
		}
		if (msg.phase === "challenge_wait" && entry.status === "dispatched" && !entry.graceGranted) {
			// The page shows a challenge that may clear by itself: the job gets the
			// grace period on top of what it has left, once, and never more than a
			// job may run in all.
			entry.graceGranted = true;
			this.#extend(entry, this.#limits.challengeGraceMs);
		}
	}

	/**
	 * Move the run deadline of a dispatched job further out, within what a job may run in all.
	 * @param {Entry} entry
	 * @param {number} ms
	 */
	#extend(entry, ms) {
		const now = this.#clock.now();
		const deadlineAt = Math.min(Math.max(entry.deadlineAt, now) + ms, entry.dispatchedAt + this.#limits.maxRunMs);
		if (deadlineAt > entry.deadlineAt) {
			this.#clock.clearTimeout(entry.timer);
			entry.deadlineAt = deadlineAt;
			entry.timer = this.#clock.setTimeout(() => this.#onRunDeadline(entry), deadlineAt - now);
		}
	}

	/**
	 * A challenge event of the extension: a running job was parked, the operator
	 * was given the page of a parked one, or its challenge is gone and its page
	 * is being read. The host is the job's own,
	 * as the daemon knows it; what the event says about it is not used.
	 * @param {{ name: string, job: string | null, detect: JobResultBody["detect"] }} event
	 */
	onEvent(event) {
		if (event.job === null) return;
		if (event.name === "challenge.pending") {
			const entry = this.#dispatched.get(event.job);
			if (entry === undefined) {
				this.#log.warn("job.message_dropped", { type: "challenge.pending", job: event.job });
				return;
			}
			this.#park(entry, event.detect);
		} else if (event.name === "challenge.acked") {
			const entry = this.#parked.get(event.job);
			if (entry === undefined || entry.park === null || entry.park.acked) return;
			entry.park.acked = true;
			this.#log.info("job.challenge_acked", { job: entry.id });
			this.#onChallenge?.acked({ job: entry.id, host: entry.spec.host });
		} else if (event.name === "challenge.cleared") {
			// The page behind the challenge is there and is being read; that can take a while. The operator is not
			// called for a check that is gone.
			const entry = this.#parked.get(event.job);
			if (entry === undefined || entry.park === null || entry.park.cleared) return;
			entry.park.cleared = true;
			this.#log.info("job.challenge_gone", { job: entry.id });
			this.#onChallenge?.cleared?.({ job: entry.id, host: entry.spec.host });
		}
	}

	/**
	 * @param {Entry} entry a dispatched job whose page waits for the operator
	 * @param {JobResultBody["detect"]} detect
	 */
	#park(entry, detect) {
		const now = this.#clock.now();
		const parkMs = entry.spec.wait.human_wait_ms;
		/** @type {string | null} */
		let refusal = null;
		if (parkMs <= 0 || this.#parked.size >= this.#limits.maxParked) refusal = ERROR_CODE.TOO_MANY_PENDING;
		for (const other of this.#parked.values()) if (other.site === entry.site) refusal = ERROR_CODE.CHALLENGE_PENDING;
		if (refusal !== null) {
			// The extension keeps to the same limits; a job it parks beyond them is ended here.
			this.#log.warn("job.park_refused", { job: entry.id, code: refusal });
			this.#cancelDispatched(entry, "deadline");
			const report = synthReport(entry.id, entry.spec.url, "needs_human", jobError(refusal, "the page shows a human check and cannot be kept for the operator", true), entry.cookieScope);
			report.detect = detect;
			this.#finish(entry, report);
			this.#pump();
			return;
		}
		this.#dispatched.delete(entry.id);
		this.#clock.clearTimeout(entry.timer);
		// The slot is free from here on; the site's gap counts from this moment.
		this.#applyGaps(entry, now);
		entry.status = "parked";
		entry.park = { since: now, expiresAt: now + parkMs, detect, acked: false, cleared: false };
		entry.deadlineAt = now + parkMs + this.#limits.parkGraceMs;
		entry.timer = this.#clock.setTimeout(() => this.#onParkDeadline(entry), parkMs + this.#limits.parkGraceMs);
		this.#parked.set(entry.id, entry);
		this.#log.info("job.parked", { job: entry.id, kind: typeof detect?.kind === "string" ? detect.kind.slice(0, 64) : null });
		entry.resolveParked(this.#parkedInfo(entry, now));
		this.#onChallenge?.pending({ job: entry.id, host: entry.spec.host });
		this.#pump();
	}

	/**
	 * @param {Entry} entry
	 * @param {number} now
	 * @returns {ParkedInfo}
	 */
	#parkedInfo(entry, now) {
		return {
			job: entry.id,
			host: entry.spec.host,
			cookie_scope: entry.cookieScope,
			http_status: entry.httpStatus,
			detect: entry.park?.detect ?? null,
			retry_after_s: this.#pendingRetryS(entry, now),
			expires_in_s: Math.max(0, Math.ceil(((entry.park?.expiresAt ?? now) - now) / 1000)),
		};
	}

	/**
	 * A report the daemon makes for a parked job, with what is known of the page.
	 * @param {Entry} entry
	 * @param {Outcome} outcome
	 * @param {JobError} error
	 * @returns {JobReport}
	 */
	#parkedReport(entry, outcome, error) {
		const report = synthReport(entry.id, entry.spec.url, outcome, error, entry.cookieScope);
		report.nav.http_status = entry.httpStatus;
		report.detect = entry.park?.detect ?? null;
		return report;
	}

	/**
	 * The extension did not report the end of a parked job in time.
	 * @param {Entry} entry
	 */
	#onParkDeadline(entry) {
		if (entry.status !== "parked") return;
		this.#send(makeMessage(MSG.JOB_CANCEL, { job: entry.id, reason: "deadline" }));
		this.#finish(entry, this.#parkedReport(entry, "timeout", jobError(ERROR_CODE.CHALLENGE_EXPIRED, "nobody cleared the human check in time", true)));
		this.#pump();
	}

	/**
	 * The one job.result for a dispatched job. Anything else is dropped.
	 * @param {JobResultBody} claimed the validated message without "v" and "type"
	 */
	onResult(claimed) {
		let body = claimed;
		const entry = this.#dispatched.get(body.job) ?? this.#parked.get(body.job);
		if (entry === undefined) {
			const grace = this.#draining.get(body.job);
			if (grace !== undefined) {
				this.#clock.clearTimeout(grace);
				this.#draining.delete(body.job);
				this.#log.info("job.result_dropped", { job: body.job, reason: "late_after_cancel" });
				this.#pump();
			} else {
				this.#log.warn("job.result_dropped", { job: body.job, reason: "unknown_or_duplicate" });
			}
			return;
		}
		this.#dispatched.delete(entry.id);
		if (entry.cookieScope === "default" && body.cookie_scope !== "default") {
			// Taken with the operator's login: it is a login page whatever the result says, and is never stored.
			// A result without a scope (no tab was opened) is no claim; one that names the container is.
			if (body.cookie_scope === "container") this.#log.error("job.scope_mismatch", { job: entry.id, accepted: "default", result: "container" });
			body = { ...body, cookie_scope: "default" };
		} else if (entry.cookieScope === "container" && body.cookie_scope === "default") {
			// The other way round the result is taken at its word: the stricter of the two.
			this.#log.warn("job.scope_mismatch", { job: entry.id, accepted: "container", result: "default" });
		}
		const refusal = body.nav.final_url === null ? null : finalUrlRefusal(body.nav.final_url, entry.spec.policy ?? {});
		if (refusal !== null) {
			// The extension holds every hop to the same policy and should never get here.
			this.#log.error("job.final_url_refused", { job: entry.id, code: refusal });
			// A result that is no page stays what it is - a block is still a block of the site - without the address.
			if (body.outcome !== "ok") body = { ...body, nav: { ...body.nav, final_url: null } };
		}
		/** @type {JobReport} */
		let report = body;
		if (entry.spec.session === "isolated" && body.cookie_scope === "default") {
			// The caller asked for the container and must not get logged-in content.
			this.#log.error("job.scope_violation", { job: entry.id });
			report = synthReport(
				entry.id,
				entry.spec.url,
				"error",
				jobError(ERROR_CODE.SCOPE_VIOLATION, "the extension used the default cookie store for an isolated job", false),
				"default",
			);
		} else if (refusal !== null && body.outcome === "ok") {
			// Nothing of the page is kept: not its text, not its file, not its address. The hops stay, for the audit log.
			report = synthReport(entry.id, entry.spec.url, "policy_blocked", jobError(refusal, "the page ended at an address the gateway policy does not allow", false), body.cookie_scope);
			report.nav.redirect_origins = body.nav.redirect_origins;
		} else if (body.file !== null) {
			report = this.#fileReport(entry, body);
		}
		if (body.error?.code === ERROR_CODE.LOGIN_RATE_LIMIT && typeof body.error.retry_after_s === "number") {
			// The extension's own limit said no: it knows better than the pace kept here.
			this.#holdLogin(entry.loginKey ?? entry.spec.host, this.#clock.now() + body.error.retry_after_s * 1000);
		}
		// Whatever the report was made into: where the load went is what the extension saw.
		this.#finish(entry, report, body.nav);
		this.#pump();
	}

	/** Fail everything; used when the daemon stops. */
	shutdown() {
		this.#closed = true;
		this.#clearPumpTimer();
		for (const grace of this.#draining.values()) this.#clock.clearTimeout(grace);
		this.#draining.clear();
		const error = jobError(ERROR_CODE.SHUTDOWN, "the daemon is shutting down", true);
		for (const entry of this.#queued.splice(0)) {
			this.#finish(entry, synthReport(entry.id, entry.spec.url, "aborted", error));
		}
		for (const entry of [...this.#dispatched.values()]) {
			this.#dispatched.delete(entry.id);
			this.#send(makeMessage(MSG.JOB_CANCEL, { job: entry.id, reason: "shutdown" }));
			this.#finish(entry, synthReport(entry.id, entry.spec.url, "aborted", error, entry.cookieScope));
		}
		for (const entry of [...this.#parked.values()]) {
			this.#send(makeMessage(MSG.JOB_CANCEL, { job: entry.id, reason: "shutdown" }));
			this.#finish(entry, this.#parkedReport(entry, "aborted", error));
		}
	}

	/**
	 * @param {Entry} entry
	 * @param {boolean} deduped
	 * @returns {JobHandle}
	 */
	#handle(entry, deduped) {
		let released = false;
		return {
			job: entry.id,
			promise: entry.promise,
			// Whoever joins a job that is parked already is told how things stand now.
			parked: entry.status === "parked" ? Promise.resolve(this.#parkedInfo(entry, this.#clock.now())) : entry.parkedPromise,
			deduped,
			release: () => {
				if (released) return;
				released = true;
				this.#release(entry);
			},
		};
	}

	/**
	 * A job that never enters the queue: reported and audited at once.
	 * @param {JobSpec} spec
	 * @param {Outcome} outcome
	 * @param {JobError} error
	 * @param {{ pendingJob?: string, detect?: JobResultBody["detect"] }} [about] the parked job the refusal points at:
	 *   the report carries its id, so that the caller can name it; the audit entry keeps an id of its own
	 * @returns {JobHandle}
	 */
	#refuse(spec, outcome, error, about = {}) {
		const job = newJobId();
		this.#audit.append({
			job,
			kind: spec.kind,
			url: spec.url,
			host: spec.host,
			outcome,
			code: error.code,
			cookie_scope: null,
			dispatched: false,
			duration_ms: 0,
			redirect_origins: [],
		});
		const report = synthReport(about.pendingJob ?? job, spec.url, outcome, error);
		if (about.detect !== undefined) report.detect = about.detect;
		return {
			job,
			promise: Promise.resolve(report),
			parked: Promise.resolve(null),
			deduped: false,
			release: () => {},
		};
	}

	/** @param {Entry} entry */
	#release(entry) {
		entry.waiters -= 1;
		// A parked job is the operator's now: it lives on whether or not anyone waits.
		if (entry.waiters > 0 || entry.status === "done" || entry.status === "parked") return;
		const error = jobError(ERROR_CODE.CLIENT_GONE, "the caller stopped waiting", true);
		if (entry.status === "queued") {
			this.#queued.splice(this.#queued.indexOf(entry), 1);
			this.#finish(entry, synthReport(entry.id, entry.spec.url, "aborted", error));
		} else {
			this.#cancelDispatched(entry, "client_gone");
			this.#finish(entry, synthReport(entry.id, entry.spec.url, "aborted", error, entry.cookieScope));
		}
		this.#pump();
	}

	/**
	 * Tell the extension to stop and keep the slot until it confirms.
	 * @param {Entry} entry
	 * @param {"deadline" | "client_gone"} reason
	 */
	#cancelDispatched(entry, reason) {
		this.#dispatched.delete(entry.id);
		this.#send(makeMessage(MSG.JOB_CANCEL, { job: entry.id, reason }));
		const grace = this.#clock.setTimeout(() => {
			this.#draining.delete(entry.id);
			this.#pump();
		}, this.#limits.cancelGraceMs);
		this.#draining.set(entry.id, grace);
	}

	/** @param {Entry} entry */
	#onQueueDeadline(entry) {
		if (entry.status !== "queued") return;
		this.#queued.splice(this.#queued.indexOf(entry), 1);
		this.#finish(
			entry,
			synthReport(
				entry.id,
				entry.spec.url,
				"timeout",
				jobError(ERROR_CODE.QUEUE_TIMEOUT, "the job was not started in time", true),
			),
		);
		this.#pump();
	}

	/** @param {Entry} entry */
	#onRunDeadline(entry) {
		if (entry.status !== "dispatched") return;
		this.#cancelDispatched(entry, "deadline");
		this.#finish(
			entry,
			synthReport(
				entry.id,
				entry.spec.url,
				"timeout",
				jobError(ERROR_CODE.DEADLINE, "the browser did not finish the job in time", true),
				entry.cookieScope,
			),
		);
		this.#pump();
	}

	/** The kill switch empties the queue; nothing is left to burst out on resume. */
	#flushPaused() {
		const error = jobError(ERROR_CODE.PAUSED, "the operator paused the gateway", false);
		for (const entry of this.#queued.splice(0)) {
			this.#finish(entry, synthReport(entry.id, entry.spec.url, "error", error));
		}
	}

	/**
	 * @param {Entry} entry
	 * @param {JobReport} report
	 * @param {JobResultBody["nav"]} [nav] where the load went, as the extension reported it: for a report the daemon
	 *   made in place of the extension's
	 */
	#finish(entry, report, nav = report.nav) {
		if (entry.status === "done") return;
		const now = this.#clock.now();
		const wasParked = entry.status === "parked";
		const dispatched = entry.status === "dispatched" || wasParked;
		const went = dispatched ? this.#elsewhere(entry, nav) : { passed: new Map(), end: null };
		if (dispatched) {
			this.#applyGaps(entry, now);
			// A redirect is a load of where it led: each of those sites is held to its own gap from here on, and
			// has one load more in its hour.
			for (const [site, host] of went.passed) {
				this.#holdSite(site, now + this.#sample(this.#profileFor(host).hostGapMs, true), now);
				this.#logLoad(site, now);
			}
		}
		if (wasParked) this.#parked.delete(entry.id);
		// Whatever arrived of a file and is not part of this report is not kept: a transfer that was cut short by a
		// deadline, a cancel or the loss of the link, or pieces that came with a result that is no file.
		if (dispatched && report.blob === undefined) this.#blobs?.discard(entry.id);
		entry.status = "done";
		this.#clock.clearTimeout(entry.timer);
		entry.timer = null;
		this.#byKey.delete(entry.spec.dedupeKey);
		// A job that never reached the browser says nothing about its site, whatever it is ended with.
		if (dispatched) report = this.#withCooldown(entry, report, now, wasParked, went);
		// The audit log decides what of this is written down: for a load outside
		// the container, or one whose cookie store is not known, the host only.
		this.#audit.append({
			job: entry.id,
			kind: entry.spec.kind,
			url: entry.spec.url,
			host: entry.spec.host,
			outcome: report.outcome,
			code: report.error?.code ?? null,
			cookie_scope: report.cookie_scope ?? entry.cookieScope,
			dispatched,
			duration_ms: now - entry.submittedAt,
			redirect_origins: report.nav.redirect_origins,
			callers: entry.callers,
			// Of a file: what its first bytes say it is, and its size. Never a name, never content.
			...(report.file_info === undefined ? {} : { file_type: report.file_info.type, file_size: report.file_info.size }),
			// Where the browser spent the time of the job, as the extension measured it: numbers only.
			...(report.render === null ? {} : { timings: { elapsed_ms: report.render.elapsed_ms, ...report.render.timings } }),
		});
		this.#log.info("job.done", { job: entry.id, outcome: report.outcome, code: report.error?.code ?? null });
		if (report.render !== null) this.#log.info("job.timings", { job: entry.id, elapsed_ms: report.render.elapsed_ms, ...report.render.timings });
		entry.resolveParked(null);
		entry.resolve(report);
		if (wasParked) this.#onChallenge?.ended({ job: entry.id, host: entry.spec.host });
	}

	/**
	 * What the end of a job means for its site: a block, or a challenge that
	 * was not cleared, starts or lengthens the site's cooldown; a challenge
	 * that the operator cleared ends it. A report that tells the caller to come
	 * back later says how much later.
	 *
	 * A load that was redirected and refused elsewhere: both sites are left
	 * alone. The one that was asked, because the same address leads to the
	 * same refusal; the one the load ended at, because it is the one that
	 * refused - and only that one is held to what a Retry-After asks.
	 * @param {Entry} entry
	 * @param {JobReport} report
	 * @param {number} now
	 * @param {boolean} wasParked
	 * @param {{ passed: Map<string, string>, end: string | null }} went where the load went besides the job's own site
	 * @returns {JobReport} the report, with retry_after_s set from the cooldown where there is one
	 */
	#withCooldown(entry, report, now, wasParked, went) {
		if (report.outcome === "ok") {
			if (wasParked) this.#cooldown.delete(entry.site);
			return report;
		}
		const code = report.error?.code ?? null;
		// The daemon's own endings say nothing about the site: the caller left, the daemon stops. Nor does the
		// loss of the link: a browser that was closed or restarted while a page waited is no refusal of the site.
		const linkEnding = report.outcome === "error" && (code === ERROR_CODE.BROWSER_DISCONNECTED || code === ERROR_CODE.INVALID_RESULT);
		const ownEnding = linkEnding || code === ERROR_CODE.CLIENT_GONE || code === ERROR_CODE.SHUTDOWN || code === ERROR_CODE.QUEUE_TIMEOUT || code === ERROR_CODE.PAUSED;
		const refused = report.outcome === "blocked" || report.outcome === "needs_human";
		if (ownEnding || !(refused || wasParked)) return report;
		const asked = report.error?.retry_after_s ?? null;
		const { end } = went;
		this.#coolSite(entry.site, entry.spec.host, now, end === null ? asked : null);
		if (end !== null) this.#coolSite(end, went.passed.get(end) ?? entry.spec.host, now, asked);
		const left = Math.max(this.#cooldownLeftS(entry.site, now), end === null ? 0 : this.#cooldownLeftS(end, now));
		if (left === 0 || report.error === null) return report;
		// The cooldown is what the next job for the site will be held to: it
		// includes what the site asked for, as far as that is honoured. For an
		// address that leads elsewhere it is the longer of the two.
		return { ...report, error: { ...report.error, retry_after_s: left } };
	}

	/**
	 * The next job for this site, and the next job at all, wait at least this
	 * long. Applied at dispatch and again, from the later moment, at completion.
	 * @param {Entry} entry
	 * @param {number} now
	 */
	#applyGaps(entry, now) {
		this.#holdSite(entry.site, now + entry.hostGapMs, now);
		this.#globalReadyAt = Math.max(this.#globalReadyAt, now + entry.globalGapMs);
	}

	/**
	 * No job for this site before then.
	 * @param {string} site
	 * @param {number} until
	 * @param {number} now
	 */
	#holdSite(site, until, now) {
		this.#siteReadyAt.set(site, Math.max(this.#siteReadyAt.get(site) ?? 0, until));
		if (this.#siteReadyAt.size > 512) {
			for (const [s, at] of this.#siteReadyAt) {
				if (at <= now) this.#siteReadyAt.delete(s);
			}
		}
	}

	/**
	 * @param {readonly [number, number]} range
	 * @param {boolean} skewed bias towards the lower end, with a tail to the maximum
	 * @returns {number}
	 */
	#sample(range, skewed) {
		const u = Math.min(Math.max(this.#rng(), 0), 1);
		return Math.round(range[0] + (range[1] - range[0]) * (skewed ? u * u : u));
	}

	#clearPumpTimer() {
		if (this.#pumpTimer !== null) {
			this.#clock.clearTimeout(this.#pumpTimer);
			this.#pumpTimer = null;
		}
	}

	/** Dispatch whatever may run now; otherwise arm a timer for the next moment something can. */
	#pump() {
		this.#clearPumpTimer();
		if (this.#closed) return;
		// Whether or not anything can run: what waits for a site that is not asked any more is answered now.
		this.#endHeld(this.#clock.now());
		const state = this.#state;
		if (state === null || state.paused) return;
		const slots = Math.min(state.slots, WIRE.MAX_SLOTS);
		for (;;) {
			if (this.#dispatched.size + this.#draining.size >= slots) return;
			/** @type {Entry | null} */
			let next = null;
			let nextAt = Infinity;
			for (const entry of this.#queued) {
				const at = Math.max(this.#globalReadyAt, this.#siteReadyAt.get(entry.site) ?? 0, entry.loginKey === null ? 0 : (this.#loginReadyAt.get(entry.loginKey) ?? 0));
				// Strictly earlier only: among equals the oldest job goes first.
				if (at < nextAt) {
					next = entry;
					nextAt = at;
				}
			}
			if (next === null) return;
			const now = this.#clock.now();
			if (nextAt > now) {
				this.#pumpTimer = this.#clock.setTimeout(() => {
					this.#pumpTimer = null;
					this.#pump();
				}, nextAt - now);
				return;
			}
			if (!this.#dispatch(next, now)) return;
		}
	}

	/**
	 * @param {Entry} entry
	 * @param {number} now
	 * @returns {boolean} false when the frame could not be sent; the job stays queued. True also for a job that
	 *   ended here because its frame was refused: the queue is one shorter either way
	 */
	#dispatch(entry, now) {
		const { spec } = entry;
		const profile = this.#profileFor(spec.host);
		const wait = { ...spec.wait, dwell_ms: spec.wait.dwell_ms ?? this.#sample(profile.dwellMs, false) };
		/** @type {boolean} */
		let sent;
		try {
			sent = this.#send(
				makeMessage(MSG.JOB_START, {
					job: entry.id,
					kind: spec.kind,
					url: spec.url,
					...(spec.kind === "search" ? { engine: spec.search?.engine ?? "none", limit: spec.search?.limit ?? 10 } : {}),
					// A search never runs with the operator's login, whoever submitted it.
					session: spec.kind === "search" ? "isolated" : spec.session,
					wait,
					extract: spec.extract,
					// Only a fetch brings a file back; the extension holds itself to the same.
					files: spec.kind === "fetch" && spec.files != null ? { max_bytes: spec.files.max_bytes, types: [...spec.files.types] } : null,
				}),
			);
		} catch (err) {
			// A frame that is refused as it is will be refused on every later try. This runs from a timer, where
			// nobody catches: the job ends here with an error of its own, and the queue goes on with the next.
			this.#log.error("queue.send_failed", { job: entry.id, message: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
			this.#queued.splice(this.#queued.indexOf(entry), 1);
			this.#finish(entry, synthReport(entry.id, spec.url, "error", jobError("internal_error", "the job could not be sent to the browser", false)));
			return true;
		}
		if (!sent) return false;
		this.#queued.splice(this.#queued.indexOf(entry), 1);
		this.#clock.clearTimeout(entry.timer);
		entry.status = "dispatched";
		this.#dispatched.set(entry.id, entry);
		entry.hostGapMs = this.#sample(profile.hostGapMs, true);
		entry.globalGapMs = this.#sample(profile.globalGapMs, false);
		this.#applyGaps(entry, now);
		this.#logLoad(entry.site, now);
		// Waiting for the operator (human_wait_ms) is no part of the run: a job
		// that comes to that is parked and leaves the slot.
		const budget = Math.min(wait.timeout_ms + wait.settle_ms + wait.dwell_ms + this.#limits.runGraceMs, this.#limits.maxRunMs);
		entry.dispatchedAt = now;
		entry.deadlineAt = now + budget;
		entry.timer = this.#clock.setTimeout(() => this.#onRunDeadline(entry), budget);
		return true;
	}
}
