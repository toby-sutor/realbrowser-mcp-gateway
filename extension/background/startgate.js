// The gate at the start. The request guard (guard.js) is in place only once
// the extension has read its settings, the browser has said which container
// is the gateway's and every tab that is open in it has been sealed. Until
// then - some tens to hundreds of milliseconds after the background page
// begins to run - nothing stood between a page in that container and the
// network: a job tab or a tab that waited for the operator, left over when
// the browser quit or crashed and brought back by session restore, loaded
// again with the container's cookies and asked for whatever it liked.
//
// So the first script of the background page registers one blocking listener
// for every request (gatefront.js, before the modules are even loaded), and
// that listener stands in for the guard until the guard is there. It is this
// module's from the first statement of main.js on, and removed by it at the
// end. What it does with a request:
//
//   no container (the operator's   passes at once. Its address is not looked
//   default store, a private one)  at
//   a container, and the browser   cancelled if it is the gateway's - nothing
//   has said which is ours         loads there outside a job, and no job runs
//                                  this early. Passes if it is any other
//   a container, not yet known     held. Not cancelled: nobody knows whose it
//                                  is. It is answered the moment the browser
//                                  says which container is the gateway's
//
// Holding instead of guessing. The settings name the container the gateway
// used last, and almost always that is still the one. But the operator can
// rename it and make it theirs, and the gateway then makes another: cancelled
// on the word of the settings, a request of the operator's own would be lost
// to a guess. A request that is held is lost to nobody; it is late by the time
// the browser needs to answer one question.
//
// What the id in the settings is used for is the other side of that: how
// long the operator's other containers wait if the answer does not come. The
// requests of every container but the one the settings name are let go after
// HOLD_MS at the latest, known or not (LAST_MS while not even the settings
// could be read) - so a browser that is slow to start does not keep the
// operator's container tabs waiting. Those of the container the settings name
// wait for the browser's word, however long it takes: they are the ones this
// gate is for. With no id in the settings at all, any container may turn out
// to be the gateway's, and all of them wait for HOLD_MS.
//
// The listener is registered for all requests because a request filter cannot
// name a cookie store, and it cannot be narrowed to a tab or a window: none is
// known yet. It lives for the first moments of the background page and hears
// the operator's requests of those moments, to which it answers "no
// objection" without reading them. That costs each of them the time the
// browser takes to hand it over and to have the answer back (see "How the
// gate goes"): measured for a container tab of the operator's on a busy
// machine, 0.3 to 0.85 s at the most, once, while the gate stood.
//
// What this does not reach: the time before the background page runs, and
// the moment the browser needs to take the registration in. A browser that
// starts brings its windows back first and starts the background pages of
// its add-ons after that; a page it restored can have asked for things by
// then (measured in Firefox 156 with the add-on loaded after the start: for
// 0.4 to 2 s). Firefox holds requests back for an add-on only when a
// blocking listener of that add-on was still registered when the browser last
// went down - and this one is removed, by design: it would hear every request
// of the operator's for as long as the browser runs.
//
// How the gate goes. The browser does not hand a request to a listener in the
// moment it is made: it collects the requests of a moment and hands them over
// together when it has time, a quarter of a second later at the most
// (measured in Firefox 156, and read in its source: ConduitsParent, 250 ms).
// A request that is handed to a listener that was removed meanwhile goes on
// as if nobody had objected. So the gate does not go the moment the guard is
// in place - the requests it was still owed would all get out at that moment
// (measured: 37 and 42 requests of a restored job tab in two of six starts).
// It stays, answering as before, until the browser has handed it a request
// that was made after the guard was in place - everything older came before
// that one - or until nothing has come for QUIET_MS. A job gets its container
// only then.
//
// Like the guard, the gate only ever cancels. It changes nothing of a request.

/**
 * @typedef {{ cancel?: true }} GateAnswer
 *
 * @typedef {object} GateRequest the part of a webRequest event the gate reads
 * @property {string} [cookieStoreId]
 * @property {string} url
 * @property {number} [timeStamp] epoch ms at which the browser made the event
 *
 * @typedef {object} GateFront what gatefront.js leaves for the gate: the listener it registered, and the way to take it over
 * @property {(details: any) => unknown} listener
 * @property {number} since epoch ms of the registration
 * @property {number} pageMs milliseconds between the beginning of the background page and the registration
 * @property {(decide: (details: any) => unknown) => void} take
 *
 * @typedef {object} GateDeps
 * @property {Pick<typeof browser.webRequest, "onBeforeRequest">} webRequest
 * @property {GateFront | null} [front] the listener is registered already (gatefront.js); absent: the gate registers it
 * @property {string} extensionBase moz-extension://<uuid>/
 * @property {(event: string, fields?: Record<string, string | number | boolean | null>) => void} log
 * @property {number} [holdMs] how long the requests of a container the settings do not name wait at most
 * @property {number} [lastMs] the same while the settings could not be read
 * @property {number} [quietMs] how long nothing must have come before the gate takes itself for owed nothing more
 * @property {number} [lingerMs] how long it stays at the most once the guard is in place
 *
 * @typedef {object} GateStats counts only
 * @property {boolean} listening the listener is registered
 * @property {boolean} known the browser has said which container is the gateway's
 * @property {number} held requests of a container that waited for that answer
 * @property {number} cancelled requests in the gateway container that were cancelled
 * @property {number} released requests that were let go because the answer took too long
 * @property {number} outside requests of no container: the operator's own, answered at once
 */

const HOLD_MS = 1000;
const LAST_MS = 10000;
// Well beyond the quarter of a second the browser may keep a request before it hands it over.
const QUIET_MS = 600;
const LINGER_MS = 5000;

/** @type {GateAnswer} */
const PASS = Object.freeze({});
/** @type {GateAnswer} */
const CANCEL = Object.freeze({ cancel: true });

/** @param {unknown} id @returns {id is string} true for the cookie store of a container: never the default store, never a private one */
function isContainerStore(id) {
	return typeof id === "string" && /^firefox-container-[0-9]+$/.test(id);
}

export class StartGate {
	#d;
	#holdMs;
	#lastMs;
	#quietMs;
	#lingerMs;
	/** When the guard was in place, epoch ms; 0: not yet. From then on the gate waits to be owed nothing more. */
	#guardedAt = 0;
	/** @type {Promise<boolean> | null} resolves when the listener is removed */
	#leaving = null;
	/** @type {(gone: boolean) => void} */
	#gone = () => {};
	/** @type {ReturnType<typeof setTimeout> | null} */
	#quiet = null;
	/** @type {ReturnType<typeof setTimeout> | null} */
	#linger = null;
	/** @type {((details: any) => unknown) | null} the function the browser has as the listener, while it is registered */
	#listener = null;
	/** Milliseconds between the beginning of the background page and the registration; -1: not told. */
	#pageMs = -1;
	/** When the listener was registered; 0: never. */
	#since = 0;
	/** @type {string | null | undefined} the container the settings name; null: none; undefined: not read yet */
	#stored = undefined;
	/** @type {string | null | undefined} the gateway's container as the browser confirmed it; null: there is none; undefined: not known yet */
	#ours = undefined;
	/** @type {(ours: string | null) => void} */
	#tell = () => {};
	/** @type {Promise<string | null>} resolves with the gateway's container once the browser has said */
	#whenKnown;
	/** @type {() => void} */
	#letGo = () => {};
	/** @type {Promise<void>} resolves when the other containers have waited long enough */
	#patience;
	/** The other containers wait no more: said, or their time was up. */
	#impatient = false;
	/** @type {ReturnType<typeof setTimeout> | null} */
	#timer = null;
	#storedMs = -1;
	#knownMs = -1;
	#held = 0;
	#cancelled = 0;
	#released = 0;
	#outside = 0;

	/** @param {GateDeps} deps */
	constructor(deps) {
		this.#d = deps;
		this.#holdMs = deps.holdMs ?? HOLD_MS;
		this.#lastMs = deps.lastMs ?? LAST_MS;
		this.#quietMs = deps.quietMs ?? QUIET_MS;
		this.#lingerMs = deps.lingerMs ?? LINGER_MS;
		this.#whenKnown = new Promise((resolve) => {
			this.#tell = resolve;
		});
		this.#patience = new Promise((resolve) => {
			this.#letGo = resolve;
		});
	}

	/**
	 * Register the listener - or take over the one the first script of the page registered, with what has waited
	 * there. To be called before the background page awaits anything; once.
	 */
	listen() {
		if (this.#since !== 0) return;
		const decide = (/** @type {GateRequest} */ details) => {
			try {
				return this.#decide(details);
			} catch {
				// Nothing is known of the request: not taken for the gateway's.
				return PASS;
			}
		};
		const front = this.#d.front ?? null;
		if (front === null) {
			this.#since = Date.now();
			this.#listener = decide;
			this.#d.webRequest.onBeforeRequest.addListener(/** @type {any} */ (decide), { urls: ["<all_urls>"] }, ["blocking"]);
		} else {
			this.#since = front.since;
			this.#pageMs = front.pageMs;
			this.#listener = front.listener;
			front.take(decide);
		}
		this.#arm(this.#lastMs);
	}

	/**
	 * The container the settings name, as soon as they are read.
	 * @param {unknown} id anything but the cookie store of a container counts as "none"
	 */
	stored(id) {
		if (this.#stored !== undefined) return;
		this.#stored = isContainerStore(id) ? id : null;
		this.#storedMs = this.#age();
		// From here on the others wait for the shorter time, counted from the start.
		if (!this.#impatient && this.#ours === undefined) this.#arm(this.#holdMs);
	}

	/**
	 * The browser has said which container is the gateway's. Every request that waited is answered now.
	 * @param {unknown} id null (or anything that is no container's cookie store): the gateway has no container
	 */
	known(id) {
		if (this.#ours !== undefined) return;
		const ours = isContainerStore(id) ? id : null;
		this.#ours = ours;
		this.#knownMs = this.#age();
		this.#disarm();
		this.#tell(ours);
	}

	/**
	 * The guard is in place: every request that is made from now on is the guard's as well. The gate goes once it
	 * is owed nothing more (see the top of this file) - and not at all before the browser has said which container
	 * is the gateway's: the requests that wait for that would be answered by nobody.
	 * @returns {Promise<boolean>} resolves when the listener is removed; with false, at once, when the gate stays
	 *   because the container is not known
	 */
	leave() {
		if (this.#ours === undefined) return Promise.resolve(false);
		if (this.#leaving !== null) return this.#leaving;
		this.#leaving = new Promise((resolve) => {
			this.#gone = resolve;
		});
		if (this.#listener === null) {
			this.#gone(true);
			return this.#leaving;
		}
		this.#guardedAt = Date.now();
		this.#linger = setTimeout(() => this.#remove(), this.#lingerMs);
		this.#quiet = setTimeout(() => this.#remove(), this.#quietMs);
		return this.#leaving;
	}

	/** Take the listener away. From here on the gate is no part of anything. */
	#remove() {
		const listener = this.#listener;
		if (listener === null) return;
		this.#listener = null;
		if (this.#quiet !== null) clearTimeout(this.#quiet);
		if (this.#linger !== null) clearTimeout(this.#linger);
		this.#quiet = null;
		this.#linger = null;
		this.#d.webRequest.onBeforeRequest.removeListener(/** @type {any} */ (listener));
		// Times and counts. No container's id and nothing of a request.
		this.#d.log("startgate.gone", {
			page_ms: this.#pageMs,
			ms: this.#age(),
			stored_ms: this.#storedMs,
			known_ms: this.#knownMs,
			guarded_ms: this.#guardedAt - this.#since,
			held: this.#held,
			cancelled: this.#cancelled,
			released: this.#released,
		});
		this.#gone(true);
	}

	/**
	 * A request was handed over while the gate waits to go. One that the browser made after the guard was in
	 * place says that nothing older is on its way; anything else says that the browser is still handing over.
	 * @param {GateRequest} details
	 */
	#owed(details) {
		if (typeof details.timeStamp === "number" && details.timeStamp > this.#guardedAt) {
			// Not in this call: the answer to this request is still to be given.
			if (this.#quiet !== null) clearTimeout(this.#quiet);
			this.#quiet = setTimeout(() => this.#remove(), 0);
			return;
		}
		if (this.#quiet !== null) clearTimeout(this.#quiet);
		this.#quiet = setTimeout(() => this.#remove(), this.#quietMs);
	}

	/** @returns {GateStats} */
	get stats() {
		return { listening: this.#listener !== null, known: this.#ours !== undefined, held: this.#held, cancelled: this.#cancelled, released: this.#released, outside: this.#outside };
	}

	/** @returns {number} milliseconds since the listener was registered */
	#age() {
		return this.#since === 0 ? 0 : Date.now() - this.#since;
	}

	/** @param {number} afterMs let the other containers go that long after the start */
	#arm(afterMs) {
		this.#disarm();
		this.#timer = setTimeout(
			() => {
				this.#timer = null;
				this.#impatient = true;
				this.#letGo();
			},
			Math.max(0, afterMs - this.#age()),
		);
	}

	#disarm() {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
	}

	/**
	 * @param {string} store the cookie store of a container
	 * @param {string | null} ours the gateway's container
	 * @returns {GateAnswer}
	 */
	#judge(store, ours) {
		if (store !== ours) return PASS;
		this.#cancelled += 1;
		return CANCEL;
	}

	/**
	 * @param {GateRequest} details
	 * @returns {GateAnswer | Promise<GateAnswer>}
	 */
	#decide(details) {
		if (this.#guardedAt !== 0 && this.#listener !== null) this.#owed(details);
		const store = details.cookieStoreId;
		if (!isContainerStore(store)) {
			this.#outside += 1;
			return PASS;
		}
		// The extension's own pages are nobody's business, in whatever store they are shown.
		if (typeof details.url === "string" && details.url.startsWith(this.#d.extensionBase)) return PASS;
		if (this.#ours !== undefined) return this.#judge(store, this.#ours);
		// The others' time is up, and this is one of them: not the container the settings name.
		if (this.#impatient && this.#stored !== store) return PASS;
		this.#held += 1;
		const verdict = this.#whenKnown.then((ours) => this.#judge(store, ours));
		// The one the settings name waits for the browser's word and for nothing else.
		if (this.#stored === store) return verdict;
		return Promise.race([
			verdict,
			this.#patience.then(() => {
				// The settings may have been read meanwhile and name this very container; or the browser has spoken.
				if (this.#stored === store || this.#ours !== undefined) return verdict;
				this.#released += 1;
				return PASS;
			}),
		]);
	}
}
