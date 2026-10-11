/**
 * Structured log lines. Callers pass event names and plain fields; secrets
 * (tokens, keys, pairing codes, MACs) must never be passed in.
 * @typedef {Record<string, string | number | boolean | null | undefined>} LogFields
 * @typedef {object} Logger
 * @property {(event: string, fields?: LogFields) => void} info
 * @property {(event: string, fields?: LogFields) => void} warn
 * @property {(event: string, fields?: LogFields) => void} error
 */

/**
 * Wall clock plus timers, injectable so tests can drive time by hand.
 * @typedef {object} Clock
 * @property {() => number} now milliseconds since the epoch
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 */

/** @type {Clock} */
export const systemClock = Object.freeze({
	now: () => Date.now(),
	setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms),
	clearTimeout: (/** @type {unknown} */ handle) => clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
});

/**
 * @param {(line: string, level: "info" | "warn" | "error") => void} sink
 * @param {() => number} [now]
 * @returns {Logger}
 */
export function createLogger(sink, now = Date.now) {
	/** @param {"info" | "warn" | "error"} level @returns {(event: string, fields?: LogFields) => void} */
	const at = (level) => (event, fields = {}) => {
		sink(JSON.stringify({ t: new Date(now()).toISOString(), level, event, ...fields }), level);
	};
	return { info: at("info"), warn: at("warn"), error: at("error") };
}

/** @returns {Logger} JSON lines on stdout (info) and stderr (warn, error) */
export function consoleLogger() {
	return createLogger((line, level) => (level === "info" ? console.log(line) : console.error(line)));
}

/**
 * @typedef {object} LogThrottle
 * @property {(event: string, fields?: LogFields, key?: string) => void} warn
 * @property {() => void} close write any pending summary and stop the timers
 */

/**
 * Warnings that any process on the loopback can provoke at will (a refused
 * request, a refused upgrade, a failed handshake) must not flood the journal:
 * its own rate limit would then drop the lines that matter. Per event and key
 * the first `burst` lines of an interval are written; the rest are counted and
 * reported in one "log.suppressed" line when the interval ends.
 * @param {object} opts
 * @param {Logger} opts.log
 * @param {Clock} opts.clock
 * @param {number} opts.burst
 * @param {number} opts.intervalMs
 * @returns {LogThrottle}
 */
export function createLogThrottle({ log, clock, burst, intervalMs }) {
	/** @type {Map<string, { event: string, key: string, shown: number, dropped: number, timer: unknown }>} */
	const windows = new Map();
	const MAX_WINDOWS = 64;

	/** @param {string} id */
	const end = (id) => {
		const w = windows.get(id);
		if (w === undefined) return;
		windows.delete(id);
		clock.clearTimeout(w.timer);
		if (w.dropped > 0) {
			log.warn("log.suppressed", { suppressed_event: w.event, ...(w.key === "" ? {} : { key: w.key }), count: w.dropped, interval_s: Math.round(intervalMs / 1000) });
		}
	};

	return {
		warn(event, fields = {}, key = "") {
			// Keys come from fixed sets; should one ever not, it shares a window.
			let id = `${event}|${key}`;
			if (!windows.has(id) && windows.size >= MAX_WINDOWS) id = "overflow|";
			let w = windows.get(id);
			if (w === undefined) {
				const timer = clock.setTimeout(() => end(id), intervalMs);
				// Never the reason the process stays alive.
				if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref();
				w = { event: id === "overflow|" ? "various" : event, key: id === "overflow|" ? "" : key, shown: 0, dropped: 0, timer };
				windows.set(id, w);
			}
			if (w.shown < burst) {
				w.shown += 1;
				log.warn(event, fields);
			} else {
				w.dropped += 1;
			}
		},
		close() {
			for (const id of [...windows.keys()]) end(id);
		},
	};
}
