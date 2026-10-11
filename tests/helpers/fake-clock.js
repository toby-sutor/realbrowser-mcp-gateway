/**
 * A hand-driven clock with the same shape as the daemon's Clock: time only
 * moves in advance(), and timers fire in order while it moves.
 */
export class FakeClock {
	#now;
	#seq = 0;
	/** @type {Map<number, { at: number, fn: () => void }>} */
	#timers = new Map();

	/** @param {number} [start] milliseconds since the epoch */
	constructor(start = 1760000000000) {
		this.#now = start;
	}

	/** @returns {number} */
	now() {
		return this.#now;
	}

	/**
	 * @param {() => void} fn
	 * @param {number} ms
	 * @returns {unknown}
	 */
	setTimeout(fn, ms) {
		const id = ++this.#seq;
		this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn });
		return id;
	}

	/** @param {unknown} handle */
	clearTimeout(handle) {
		if (typeof handle === "number") this.#timers.delete(handle);
	}

	/** Number of timers that have not fired or been cleared. */
	get pending() {
		return this.#timers.size;
	}

	/**
	 * Move time forward, firing every timer that falls due, including ones
	 * armed by the timers that fire.
	 * @param {number} ms
	 */
	advance(ms) {
		const target = this.#now + ms;
		for (;;) {
			/** @type {number | null} */
			let nextId = null;
			let nextAt = Infinity;
			for (const [id, timer] of this.#timers) {
				if (timer.at <= target && timer.at < nextAt) {
					nextId = id;
					nextAt = timer.at;
				}
			}
			if (nextId === null) break;
			const timer = this.#timers.get(nextId);
			this.#timers.delete(nextId);
			this.#now = Math.max(this.#now, nextAt);
			timer?.fn();
		}
		this.#now = target;
	}
}
