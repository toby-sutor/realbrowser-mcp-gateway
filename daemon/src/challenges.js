import { LIMITS } from "./config.js";
import { isValidHost, isValidJobId, safeText } from "./notify.js";

/**
 * The operator's desktop notification for a page that waits for them:
 * critical urgency, so that it gets through Do Not Disturb and stays until dismissed, with a sound and an "Open" action.
 *
 * It is not posted the moment a page is parked: many checks clear by
 * themselves a little later, and a page that does needs nobody. The first
 * notification waits for a configurable time (notify.challenge_delay_s); a job
 * that is over by then, or whose page the operator already has, notifies
 * nobody. The page is listed as pending from the moment it is parked all the
 * same (status, the toolbar popup, bgw pending), and can be opened at once.
 * The extension says when it sees a challenge gone (challenge.cleared), before
 * it reads the page: from then on nothing is posted either, and what is on
 * screen is closed.
 *
 * From the first notification on it is posted again every two minutes -
 * replacing itself, never piling up - until the operator has the page
 * (challenge.acked) or the job is over, and closed when the job is over.
 *
 * "Open" does one thing: it asks the extension to bring the page to the
 * operator (an attention frame). Nothing is opened from here. With every
 * post, the first one included, the extension is asked to show its own
 * notification as well: it shows none by itself.
 *
 * The text is made of fixed sentences and the host of the job, which the
 * daemon knows from the URL it was asked for: a host name, or an IPv6 address
 * in brackets. Nothing a page wrote is shown.
 *
 * The operator's hook hears of a challenge once: with the first notification
 * that was posted for it. A post the notifier did not make - its site was
 * notified a moment ago, or too many went out in the minute - ran no hook, so
 * the next one that is made runs it.
 *
 * @typedef {import("./log.js").Logger} Logger
 * @typedef {import("./log.js").Clock} Clock
 * @typedef {ReturnType<typeof import("./notify.js").createNotifier>} Notifier
 *
 * @typedef {object} Watch one pending challenge
 * @property {string} host
 * @property {import("./notify.js").NotifyHandle | null} handle the notification that is on screen, or on its way there
 * @property {unknown} timer the next repeat
 * @property {boolean} acked the operator has the page: no more repeats
 * @property {boolean} hooked a notification of it was posted, and with it the operator's hook was run
 */

export const CHALLENGE_SUMMARY = "Browser Gateway: a page needs you";
const OPEN_LABEL = "Open";

/**
 * @param {string} host a valid host: a name, or an IPv6 address in brackets
 * @returns {string}
 */
export function challengeBody(host) {
	return `${safeText(host, 253)} shows a human check. Open it to continue; the gateway reads the page once the check is passed.`;
}

/**
 * @param {object} deps
 * @param {Notifier} deps.notifier
 * @param {Clock} deps.clock
 * @param {Logger} deps.log
 * @param {(job: string, action: "focus" | "renotify") => boolean} deps.attention ask the extension to bring the page of a
 *   parked job to the operator (focus), or to show its own notification for it again (renotify)
 * @param {number} [deps.repeatMs]
 * @param {number} [deps.delayMs] how long after parking the first notification is posted; 0: at once
 * @returns {Required<import("./queue.js").ChallengeListener> & { closeAll: () => void, readonly size: number }}
 */
export function createChallengeNotifier({ notifier, clock, log, attention, repeatMs = LIMITS.challengeRepeatMs, delayMs = 0 }) {
	/** @type {Map<string, Watch>} by job id */
	const watches = new Map();

	/**
	 * @param {string} job
	 * @param {Watch} watch
	 */
	function post(job, watch) {
		const handle = notifier.post({
			key: `challenge:${job}`,
			summary: CHALLENGE_SUMMARY,
			body: challengeBody(watch.host),
			urgency: "critical",
			actions: [{ key: "open", label: OPEN_LABEL }],
			// The configured sound, every time: a repeat is meant to be noticed.
			sound: true,
			host: watch.host,
			jobId: job,
			// The operator's hook hears of a challenge once.
			hook: !watch.hooked,
		});
		// A click on the action or on the notification itself: the operator wants the page.
		handle.onAction((key) => {
			if (key !== "open" && key !== "default") return;
			if (watches.get(job) !== watch) return;
			const sent = attention(job, "focus");
			log.info("challenge.open_requested", { job, sent });
		});
		// A post that was not made (the site was notified a moment ago, or too many at once) leaves what is on
		// screen as it is, and has not run the hook: that is still to come.
		if (handle.finished) return;
		watch.handle = handle;
		watch.hooked = true;
	}

	/**
	 * Post now, and again after every repeat interval for as long as the challenge waits unattended.
	 * @param {string} job
	 * @param {Watch} watch
	 */
	function notify(job, watch) {
		post(job, watch);
		// The browser's own notification is the second channel: shown along with the first.
		attention(job, "renotify");
		arm(job, watch, repeatMs);
	}

	/**
	 * @param {string} job
	 * @param {Watch} watch
	 * @param {number} ms until the next notification
	 */
	function arm(job, watch, ms) {
		watch.timer = clock.setTimeout(() => {
			watch.timer = null;
			if (watches.get(job) !== watch || watch.acked) return;
			notify(job, watch);
		}, ms);
		// Never the reason the process stays alive.
		const timer = watch.timer;
		if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref();
	}

	return {
		get size() {
			return watches.size;
		},

		/** A job was parked: its page waits for the operator. */
		pending({ job, host }) {
			if (watches.has(job)) return;
			// The URL parser keeps a trailing dot; a host name is shown without it.
			const name = String(host).toLowerCase().replace(/\.$/, "");
			if (!isValidJobId(job) || !isValidHost(name)) {
				// No text can be made for it that is known to be safe to show. The job
				// is still listed in the status and in the browser.
				log.warn("challenge.not_notified", { job: isValidJobId(job) ? job : null });
				return;
			}
			/** @type {Watch} */
			const watch = { host: name, handle: null, timer: null, acked: false, hooked: false };
			watches.set(job, watch);
			// A check that clears by itself in the meantime, or a page the operator opened already, notifies nobody.
			if (delayMs > 0) arm(job, watch, delayMs);
			else notify(job, watch);
		},

		/** The operator was given the page: nothing more to repeat. */
		acked({ job }) {
			const watch = watches.get(job);
			if (watch === undefined || watch.acked) return;
			watch.acked = true;
			clock.clearTimeout(watch.timer);
			watch.timer = null;
		},

		/**
		 * The challenge is gone and the page behind it is being read, which can take a while: nobody is needed
		 * any more. Nothing is posted from here on, and what is on screen goes.
		 */
		cleared({ job }) {
			const watch = watches.get(job);
			if (watch === undefined) return;
			watch.acked = true;
			clock.clearTimeout(watch.timer);
			watch.timer = null;
			watch.handle?.close().catch(() => {});
			watch.handle = null;
		},

		/** The job is over, however it ended: its notification goes. */
		ended({ job }) {
			const watch = watches.get(job);
			if (watch === undefined) return;
			watches.delete(job);
			clock.clearTimeout(watch.timer);
			watch.timer = null;
			watch.handle?.close().catch(() => {});
			// Nothing is posted for this job again: what the notifier remembers of it can go.
			notifier.forget(`challenge:${job}`);
		},

		/** The daemon stops: no repeat may fire into the shutdown. The notifier closes what is on screen. */
		closeAll() {
			for (const watch of watches.values()) {
				clock.clearTimeout(watch.timer);
				watch.timer = null;
			}
			watches.clear();
		},
	};
}
