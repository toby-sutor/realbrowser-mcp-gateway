// The gateway window, behind a small strategy interface so the choice can be
// swapped without touching jobs.js.
//
// Strategy "normal": one normal-type browser window holding a
// park tab. Every job gets a fresh, active, muted tab next to it - in the
// gateway container, or, for a fetch under one of the operator's login rules,
// in the operator's own cookie store (the job runner says which); the tab is closed after the job and dropped from the recently
// closed list. Nothing here focuses or raises a window: creating the window is
// the only moment it may come to the front.
//
// More than one job tab can exist: a tab with a challenge stays open for the
// operator while the next job runs in a tab of its own.
//
// Hand-off: to bring a challenge to the operator, its tab is
// moved into a new normal window (popOut). In measurements on a
// KDE Wayland desktop that is the one thing that came to the front; windows.update({ focused: true })
// never did, and is not used. The new window is made only when the operator
// asked for it. When the job ends its tab is closed, and with it the window if
// it holds nothing else.
//
// What a job leaves behind (since 0.1.7). Nothing loads in the gateway
// container outside a job, so a tab of that container that is no job tab is
// nobody's page, and two things follow from that here.
//
// When a job tab is closed, the windows of the browser are compared with
// those that were there when the tab was made. A window that is new and
// holds nothing but tabs of the container is closed: a pop-up of the job's
// page that got a window of its own (measured in Firefox 156: this is what
// closes it, a moment before main.js would close its tab), or whatever else
// the browser opens for a job in a window of its own. The gateway window, a
// window that holds a job tab or a challenge for the operator, and every
// window with a tab of any other cookie store in it are never touched by it.
//
// A tab somebody else makes (see guard.js, which seals such a tab and says
// why). Every tab of the gateway window is made here: the park tab and the job
// tabs. A tab of any other cookie store that the browser reports as made in
// that window while a job tab is open is therefore either one of those two -
// which only this module can say - or the doing of another add-on that opened
// a job's page again in a container of its own. closeForeign answers that for
// one tab and closes it if it is nobody's of the gateway and still in the
// gateway window. It is asked about tabs the request guard reported and about
// no other: a tab in another window, a tab made while no job tab was open and
// a tab that was moved into the gateway window never come here, and for those
// the older rule holds - the window is left to the operator (#disown).
//
// And before a job tab is made, a tab of the container that sits in the
// gateway window without being a job tab is closed instead of being taken
// for the operator moving in. Measured in Firefox 156: a PDF that got past
// the request guard as a download was opened by the browser from its file://
// address in a new tab of the container, in the gateway window; until 0.1.6
// the next job then left that window to the operator and made another one -
// one more window for every such job.

export const ROLE_KEY = "bgw_role";
const ROLE_WINDOW = "gateway";
const ROLE_HANDOFF = "handoff";
const ROLE_JOB = "job";
const ROLE_PARK = "park";
const TITLE_PREFACE = "Browser Gateway - ";
const BLANK = "about:blank";
// The "closed at" of a tab's entry in the recently-closed list is taken by another part of the browser than
// the time of this module's tabs.remove(): both clocks are the machine's, this much is for rounding.
const CLOSED_SLACK_MS = 100;
// A window a job left behind is not closed in the moment it is found: it may have been made in that very moment,
// and of a window that is closed while it is being made a request can get out that no extension is told of
// (measured, see closeStray in main.js). Its tabs are sealed by the request guard meanwhile.
const LEFTOVER_GRACE_MS = 300;
// A tab somebody else made in the gateway window is not closed in the moment it is made either, for the same
// reason; the request guard has sealed it.
const FOREIGN_GRACE_MS = 300;
// Job tabs whose windows-at-the-start are remembered; a job tab is released long before there are that many.
const MAX_REMEMBERED_STARTS = 64;

/**
 * @typedef {object} JobTab
 * @property {number} windowId
 * @property {number} tabId a blank tab in the requested cookie store, ready for navigate()
 *
 * @typedef {object} SweepReport
 * @property {boolean} adopted a leftover window became the gateway window
 * @property {number} closedWindows extra gateway windows that were closed
 * @property {number} closedTabs leftover job and park tabs that were closed
 * @property {number} disowned gateway windows left to the operator because they hold foreign tabs
 *
 * @typedef {object} WindowStrategy
 * @property {string} name
 * @property {(cookieStoreId: string) => Promise<JobTab>} acquire
 * @property {(tabId: number, url: string) => Promise<void>} navigate
 * @property {(tabId: number) => Promise<void>} release close the job tab; safe to call twice. A tab the browser did not
 *   close stays a job tab (it is in snapshot().jobTabs) and can be released again
 * @property {(tabId: number) => Promise<number>} popOut move a job tab into a new normal window of its own, for the
 *   operator; resolves with the id of that window
 * @property {(tabId: number, onForeign?: () => void) => Promise<"job" | "park" | "closed" | "gone" | "kept">} closeForeign
 *   for a tab the request guard reported as made in the gateway window by somebody else: say whose it is, and
 *   close it if it is not the gateway's. "job", "park": the gateway's own, untouched. onForeign is called as soon as
 *   it is known not to be, before it is closed. "kept": it could not be closed, or is in another window by now
 * @property {() => Promise<void>} releaseAll close every job tab that is still open
 * @property {() => Promise<SweepReport>} adoptOrSweep
 * @property {() => Promise<void>} idle resolves once the window operations asked for so far are through
 * @property {() => boolean} isOpen
 * @property {() => Promise<void>} close
 * @property {() => { windowId: number | null, parkTabId: number | null, jobTabs: number[], handoffWindows: number[] }} snapshot
 *
 * @typedef {object} WindowDeps
 * @property {typeof browser.windows} windows
 * @property {typeof browser.tabs} tabs
 * @property {typeof browser.sessions} sessions
 * @property {string} parkUrl
 * @property {(event: string, fields?: Record<string, string | number | boolean | null>) => void} log
 * @property {(tabId: number) => void} onTabLost a job tab was closed by someone else
 * @property {(windowId: number) => void} onWindowClosed the gateway window was closed by someone else
 * @property {() => void} onChange isOpen() changed
 * @property {() => string | null} [containerId] the cookie store of the gateway container, null while it is not known.
 *   Absent or null: no window is ever taken for one a job left behind
 *
 * @typedef {{ park: browser.tabs.Tab[], job: browser.tabs.Tab[], foreign: browser.tabs.Tab[] }} Roles
 */

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @implements {WindowStrategy} */
export class NormalWindow {
	name = "normal";
	#d;
	/** @type {number | null} */
	#windowId = null;
	/** @type {number | null} */
	#parkTabId = null;
	/** @type {Set<number>} */
	#jobTabs = new Set();
	/** @type {Set<number>} tabs this module is closing itself */
	#closingTabs = new Set();
	/** @type {Set<number>} windows this module is closing itself */
	#closingWindows = new Set();
	/** @type {Set<number>} windows made by popOut that are still open */
	#handoffWindows = new Set();
	/** @type {Map<number, Set<number>>} job tab -> the windows the browser had when the tab was made */
	#windowsAtStart = new Map();
	/** @type {Map<number, number>} tabs somebody else made in the gateway window that are still to be closed (closeForeign) -> since when */
	#foreignPending = new Map();
	/** @type {Promise<unknown>} window operations run one at a time */
	#chain = Promise.resolve();

	/** @param {WindowDeps} deps */
	constructor(deps) {
		this.#d = deps;
		deps.tabs.onRemoved.addListener((tabId) => {
			const own = this.#closingTabs.delete(tabId);
			if (tabId === this.#parkTabId) this.#parkTabId = null;
			if (this.#jobTabs.delete(tabId) && !own) deps.onTabLost(tabId);
		});
		deps.windows.onRemoved.addListener((windowId) => {
			const own = this.#closingWindows.delete(windowId);
			this.#handoffWindows.delete(windowId);
			if (windowId === this.#windowId) {
				this.#windowId = null;
				this.#parkTabId = null;
				deps.onChange();
				if (!own) deps.onWindowClosed(windowId);
				return;
			}
			if (!own) this.#followLastWindow().catch(() => {});
		});
	}

	isOpen() {
		return this.#windowId !== null;
	}

	snapshot() {
		return { windowId: this.#windowId, parkTabId: this.#parkTabId, jobTabs: [...this.#jobTabs], handoffWindows: [...this.#handoffWindows] };
	}

	/**
	 * @param {string} cookieStoreId
	 * @returns {Promise<JobTab>}
	 */
	acquire(cookieStoreId) {
		return this.#serial(async () => {
			const windowId = await this.#ensureWindow();
			// What is there before the job has loaded anything: at its end, nothing more may be.
			const atStart = await this.#d.windows.getAll().then(
				(wins) => new Set(wins.flatMap((w) => (w.id === undefined ? [] : [w.id]))),
				() => null,
			);
			const tabId = await this.#createJobTab(windowId, cookieStoreId);
			if (atStart !== null) {
				if (this.#windowsAtStart.size >= MAX_REMEMBERED_STARTS) this.#windowsAtStart.delete(/** @type {number} */ (this.#windowsAtStart.keys().next().value));
				this.#windowsAtStart.set(tabId, atStart);
			}
			return { windowId, tabId };
		});
	}

	/**
	 * @param {number} tabId
	 * @param {string} url
	 */
	async navigate(tabId, url) {
		await this.#d.tabs.update(tabId, { url, loadReplace: true });
	}

	/** @param {number} tabId */
	release(tabId) {
		return this.#serial(async () => {
			await this.#releaseTab(tabId);
			await this.#closeLeftovers(tabId);
		});
	}

	releaseAll() {
		return this.#serial(async () => {
			for (const tabId of [...this.#jobTabs]) {
				await this.#releaseTab(tabId);
				await this.#closeLeftovers(tabId);
			}
		});
	}

	/**
	 * Bring a job tab to the operator: move it into a new normal window. The
	 * tab keeps its id, its cookie store and its place among the job tabs. No
	 * window is ever told to take the focus; a new window simply is in front.
	 * @param {number} tabId
	 * @returns {Promise<number>}
	 */
	popOut(tabId) {
		return this.#serial(async () => {
			if (!this.#jobTabs.has(tabId)) throw new Error("not a job tab");
			const from = await this.#d.tabs.get(tabId);
			// The gateway window must not close because its last tab left.
			if (from.windowId !== undefined && from.windowId === this.#windowId && this.#parkTabId === null) {
				const win = await this.#d.windows.get(from.windowId, { populate: true }).catch(() => null);
				if (win !== null && win.id !== undefined) await this.#ensureParkTab(win.id, (await this.#classify(win)).park).catch(() => {});
			}
			const left = from.windowId;
			// A window that held nothing else closes when its tab moves on. That is this module's doing.
			const alone = left !== undefined && left !== this.#windowId && (await this.#d.tabs.query({ windowId: left }).catch(() => [])).length === 1;
			if (alone && left !== undefined) this.#closingWindows.add(left);
			/** @type {browser.windows.Window} */
			let win;
			try {
				win = await this.#d.windows.create({ tabId, type: "normal", titlePreface: TITLE_PREFACE });
			} catch (err) {
				if (alone && left !== undefined) this.#closingWindows.delete(left);
				throw err;
			}
			if (win.id === undefined) throw new Error("the browser did not return a window id");
			this.#handoffWindows.add(win.id);
			await this.#d.sessions.setWindowValue(win.id, ROLE_KEY, ROLE_HANDOFF).catch(() => {});
			this.#d.log("window.handed_off", {});
			return win.id;
		});
	}

	/**
	 * @param {number} tabId
	 * @param {() => void} [onForeign]
	 * @returns {Promise<"job" | "park" | "closed" | "gone" | "kept">}
	 */
	async closeForeign(tabId, onForeign) {
		/** @returns {"job" | "park" | null} */
		const own = () => (this.#jobTabs.has(tabId) ? "job" : tabId === this.#parkTabId ? "park" : null);
		// Known from this moment on: a job that begins before the tab is closed must not take it for the operator's
		// and give the window up for it (#ensureWindow).
		this.#foreignPending.set(tabId, Date.now());
		try {
			// In line behind what this module is doing: it may be making that very tab, and knows it only when it has it.
			const first = await this.#serial(async () => own());
			if (first !== null) return first;
			onForeign?.();
			await sleep(FOREIGN_GRACE_MS);
			return await this.#serial(async () => {
				const mine = own();
				if (mine !== null) return mine;
				const tab = await this.#d.tabs.get(tabId).catch(() => null);
				if (tab === null) return "gone";
				// Only where it was made. In another window by now it is among the operator's tabs, and stays there, sealed.
				if (this.#windowId === null || tab.windowId !== this.#windowId) return "kept";
				const closed = await this.#removeTab(tabId);
				this.#d.log("window.foreign_tab_closed", { closed });
				return closed ? "closed" : "kept";
			});
		} finally {
			this.#foreignPending.delete(tabId);
		}
	}

	adoptOrSweep() {
		return this.#serial(() => this.#sweep());
	}

	idle() {
		return this.#chain.then(() => undefined);
	}

	close() {
		return this.#serial(async () => {
			const id = this.#windowId;
			if (id === null) return;
			this.#closingWindows.add(id);
			await this.#d.windows.remove(id).catch(() => {});
		});
	}

	/**
	 * @template T
	 * @param {() => Promise<T>} fn
	 * @returns {Promise<T>}
	 */
	#serial(fn) {
		const run = this.#chain.then(fn);
		this.#chain = run.catch(() => undefined);
		return run;
	}

	/**
	 * Which tabs of a window are ours. A job tab carries a session value, so it
	 * is still recognised after a browser restart.
	 * @param {browser.windows.Window} win
	 * @returns {Promise<Roles>}
	 */
	async #classify(win) {
		/** @type {Roles} */
		const roles = { park: [], job: [], foreign: [] };
		for (const tab of win.tabs ?? []) {
			if (tab.id === undefined) continue;
			if (this.#jobTabs.has(tab.id)) {
				roles.job.push(tab);
				continue;
			}
			const tag = await this.#d.sessions.getTabValue(tab.id, ROLE_KEY).catch(() => undefined);
			if (tag === ROLE_JOB) roles.job.push(tab);
			else if (tab.id === this.#parkTabId || tag === ROLE_PARK || (tab.url ?? "").startsWith(this.#d.parkUrl)) roles.park.push(tab);
			else roles.foreign.push(tab);
		}
		return roles;
	}

	/**
	 * Close a tab. It is forgotten when the browser no longer knows it, not when it was asked to close it: a tab
	 * can still be there afterwards (its page asked whether to leave it, and the answer was to stay; the browser
	 * would not close it). A job tab that stayed is still a job tab - closed again when asked, and never taken for
	 * a tab of the operator's.
	 * @param {number} tabId
	 * @returns {Promise<boolean>} true when the tab is gone
	 */
	async #removeTab(tabId) {
		this.#closingTabs.add(tabId);
		try {
			await this.#d.tabs.remove(tabId);
		} catch {
			// already gone, or not to be closed: the browser is asked below which
		}
		const gone = await this.#d.tabs.get(tabId).then(
			() => false,
			() => true,
		);
		if (gone) {
			// Usually done by the browser's own word (onRemoved); a tab that was gone before leaves nothing to say.
			this.#closingTabs.delete(tabId);
			this.#jobTabs.delete(tabId);
		}
		return gone;
	}

	/** @returns {Promise<number>} id of a clean gateway window */
	async #ensureWindow() {
		if (this.#windowId !== null) {
			const win = await this.#d.windows.get(this.#windowId, { populate: true }).catch(() => null);
			if (win === null || win.id === undefined || win.type !== "normal") {
				this.#windowId = null;
				this.#parkTabId = null;
			} else {
				const roles = await this.#classify(win);
				// A tab of the gateway container that is no job tab is not the operator moving in (see the top of
				// this file): it goes, and the window stays the gateway's.
				const containerId = this.#d.containerId?.() ?? null;
				const strays = containerId === null ? [] : roles.foreign.filter((t) => t.cookieStoreId === containerId);
				for (const tab of strays) {
					if (tab.id !== undefined) await this.#removeTab(tab.id);
				}
				if (strays.length > 0) this.#d.log("window.container_tabs_closed", { tabs: strays.length });
				// Nor is a tab that somebody else made here during the last job, and that is still to be closed
				// (closeForeign): it goes now, once it has been there for a moment.
				const pending = roles.foreign.filter((t) => t.id !== undefined && this.#foreignPending.has(t.id) && !strays.includes(t));
				for (const tab of pending) {
					const id = /** @type {number} */ (tab.id);
					const since = this.#foreignPending.get(id) ?? 0;
					if (Date.now() - since < FOREIGN_GRACE_MS) await sleep(FOREIGN_GRACE_MS - (Date.now() - since));
					if (await this.#removeTab(id)) strays.push(tab);
				}
				if (pending.length > 0) this.#d.log("window.foreign_tabs_closed", { tabs: pending.length });
				if (roles.foreign.length === strays.length) {
					await this.#ensureParkTab(win.id, roles.park);
					return win.id;
				}
				await this.#disown(win.id, roles);
			}
		}
		// A window that session restore brought back is reused, not duplicated.
		await this.#sweep();
		if (this.#windowId !== null) return this.#windowId;
		return this.#create();
	}

	/** @returns {Promise<number>} */
	async #create() {
		/** @type {browser.windows._CreateCreateData} */
		const base = { type: "normal", url: this.#d.parkUrl, width: 1100, height: 820, titlePreface: TITLE_PREFACE };
		/** @type {browser.windows.Window} */
		let win;
		try {
			win = await this.#d.windows.create({ ...base, focused: false });
		} catch {
			win = await this.#d.windows.create(base);
		}
		if (win.id === undefined) throw new Error("the browser did not return a window id");
		const tabs = win.tabs !== undefined && win.tabs.length > 0 ? win.tabs : await this.#d.tabs.query({ windowId: win.id });
		const park = tabs[0];
		if (park === undefined || park.id === undefined) throw new Error("the new gateway window has no tab");
		this.#windowId = win.id;
		this.#parkTabId = park.id;
		await this.#tag(win.id, park.id);
		this.#d.log("window.created", {});
		this.#d.onChange();
		return win.id;
	}

	/**
	 * @param {number} windowId
	 * @param {number} parkTabId
	 */
	async #tag(windowId, parkTabId) {
		await this.#d.sessions.setWindowValue(windowId, ROLE_KEY, ROLE_WINDOW).catch(() => {});
		await this.#d.sessions.setTabValue(parkTabId, ROLE_KEY, ROLE_PARK).catch(() => {});
	}

	/**
	 * Exactly one park tab, so that closing a job tab can never close the window.
	 * @param {number} windowId
	 * @param {browser.tabs.Tab[]} parks
	 */
	async #ensureParkTab(windowId, parks) {
		const keep = parks.find((t) => t.id !== undefined);
		if (keep === undefined || keep.id === undefined) {
			const tab = await this.#d.tabs.create({ windowId, url: this.#d.parkUrl, active: false, index: 0 });
			if (tab.id === undefined) throw new Error("the park tab could not be created");
			this.#parkTabId = tab.id;
		} else {
			this.#parkTabId = keep.id;
			for (const extra of parks) {
				if (extra.id !== undefined && extra.id !== keep.id) await this.#removeTab(extra.id);
			}
		}
		await this.#tag(windowId, this.#parkTabId);
	}

	/**
	 * The operator opened tabs of their own in the gateway window: it is theirs
	 * now. Take our park tab and leftovers out and stop using it. Job tabs that
	 * are still tracked stay until their own release.
	 * @param {number} windowId
	 * @param {Roles} roles
	 */
	async #disown(windowId, roles) {
		for (const tab of [...roles.park, ...roles.job]) {
			if (tab.id !== undefined && !this.#jobTabs.has(tab.id)) await this.#removeTab(tab.id);
		}
		await this.#d.sessions.removeWindowValue(windowId, ROLE_KEY).catch(() => {});
		if (this.#windowId === windowId) {
			this.#windowId = null;
			this.#parkTabId = null;
			this.#d.onChange();
		}
		this.#d.log("window.disowned", {});
	}

	/**
	 * @param {number} windowId
	 * @param {string} cookieStoreId
	 * @returns {Promise<number>}
	 */
	async #createJobTab(windowId, cookieStoreId) {
		// Blank first: the caller arms its request guard on the tab id before
		// anything is loaded.
		const props = { windowId, cookieStoreId, active: true, url: BLANK };
		/** @type {browser.tabs.Tab} */
		let tab;
		try {
			tab = await this.#d.tabs.create({ ...props, muted: true });
		} catch {
			tab = await this.#d.tabs.create(props);
		}
		const tabId = tab.id;
		if (tabId === undefined) throw new Error("the browser did not return a tab id");
		this.#jobTabs.add(tabId);
		try {
			// Fail closed: a tab that is not in the asked-for store is never used.
			if (tab.cookieStoreId !== cookieStoreId) throw new Error("the new tab is not in the cookie store that was asked for");
			if (tab.mutedInfo?.muted !== true) await this.#d.tabs.update(tabId, { muted: true });
			await this.#d.sessions.setTabValue(tabId, ROLE_KEY, ROLE_JOB);
		} catch (err) {
			await this.#removeTab(tabId);
			throw err;
		}
		return tabId;
	}

	/** @param {number} tabId */
	async #releaseTab(tabId) {
		if (!this.#jobTabs.has(tabId)) return;
		const last = await this.#d.tabs.get(tabId).catch(() => null);
		if (last !== null && last.windowId !== undefined && last.windowId === this.#windowId && this.#parkTabId === null) {
			const win = await this.#d.windows.get(last.windowId, { populate: true }).catch(() => null);
			if (win !== null && win.id !== undefined) await this.#ensureParkTab(win.id, (await this.#classify(win)).park).catch(() => {});
		}
		// A tab that was handed to the operator sits in a window of its own. If it
		// is still alone there, the window goes with it - and that is our doing,
		// not the operator's.
		const elsewhere = last !== null && last.windowId !== undefined && last.windowId !== this.#windowId ? last.windowId : null;
		const alone = elsewhere !== null && (await this.#d.tabs.query({ windowId: elsewhere }).catch(() => [])).length === 1;
		if (alone && elsewhere !== null) this.#closingWindows.add(elsewhere);
		const removedAt = Date.now();
		if (!(await this.#removeTab(tabId))) {
			// Still open: its window was not closed by this module after all, and no closed tab is to be looked for.
			if (alone && elsewhere !== null) this.#closingWindows.delete(elsewhere);
			this.#d.log("window.job_tab_not_closed", {});
			return;
		}
		if (last === null) return;
		if (alone) {
			await this.#forgetClosedWindow(last, removedAt, Date.now()).catch(() => {});
			// With that window gone the operator may have none left: then ours goes
			// too. Not awaited: closing is a window operation of its own, in line behind this one.
			this.#followLastWindow().catch(() => {});
		} else {
			await this.#forgetClosed(last, removedAt, Date.now()).catch(() => {});
		}
	}

	/**
	 * The windows a job left behind: new since its tab was made, and holding nothing but tabs of the gateway
	 * container, none of them a job tab. Never the gateway window, a window with a challenge for the operator, or
	 * one this module is closing.
	 * @param {Set<number>} atStart
	 * @param {string} containerId
	 * @returns {Promise<browser.windows.Window[]>}
	 */
	async #leftovers(atStart, containerId) {
		const found = [];
		for (const win of await this.#d.windows.getAll({ populate: true })) {
			const id = win.id;
			if (id === undefined || atStart.has(id) || id === this.#windowId || this.#handoffWindows.has(id) || this.#closingWindows.has(id)) continue;
			const tabs = win.tabs ?? [];
			// A tab of any other cookie store makes it the operator's, whatever else is in it.
			if (tabs.length === 0 || tabs.some((t) => t.cookieStoreId !== containerId || (t.id !== undefined && this.#jobTabs.has(t.id)))) continue;
			found.push(win);
		}
		return found;
	}

	/**
	 * The end-of-job check: the browser's windows must be those it had when the job's tab was made. What the job
	 * left behind is closed (see the top of this file). Safe to call for a tab that was never a job tab.
	 * @param {number} tabId the job tab that was just released
	 */
	async #closeLeftovers(tabId) {
		const atStart = this.#windowsAtStart.get(tabId);
		this.#windowsAtStart.delete(tabId);
		const containerId = this.#d.containerId?.() ?? null;
		if (atStart === undefined || containerId === null) return;
		try {
			if ((await this.#leftovers(atStart, containerId)).length === 0) return;
			await sleep(LEFTOVER_GRACE_MS);
			// Looked at again: only what is still there, and still nothing but the container's.
			for (const win of await this.#leftovers(atStart, containerId)) {
				const id = /** @type {number} */ (win.id);
				const tabs = win.tabs ?? [];
				this.#closingWindows.add(id);
				const removedAt = Date.now();
				const closed = await this.#d.windows.remove(id).then(
					() => true,
					() => false,
				);
				if (!closed) {
					this.#closingWindows.delete(id);
					continue;
				}
				this.#d.log("window.leftover_closed", { tabs: tabs.length });
				// It showed something of a job: not left in the operator's list of closed windows either.
				if (tabs.length === 1) await this.#forgetClosedWindow(tabs[0], removedAt, Date.now()).catch(() => {});
			}
		} catch {
			// The browser would not say what windows it has: nothing is closed on a guess.
		}
	}

	/**
	 * Take the window that closed with a handed-over job tab out of the
	 * recently-closed list: a window with one tab, closed while this module's
	 * own tabs.remove() ran. Only that entry is touched.
	 * @param {browser.tabs.Tab} last the tab as it was just before it was closed
	 * @param {number} removedAt when the closing began
	 * @param {number} removedBy when the browser said it was done
	 */
	async #forgetClosedWindow(last, removedAt, removedBy) {
		if (last.url === undefined || last.url === BLANK) return;
		for (let i = 0; i < 6; i++) {
			if (i > 0) await sleep(150);
			const closed = await this.#d.sessions.getRecentlyClosed({ maxResults: 25 });
			/** @type {{ sessionId: string, at: number } | null} */
			let found = null;
			for (const entry of closed) {
				const win = entry.window;
				if (win === undefined || win.sessionId === undefined || (win.tabs ?? []).length !== 1) continue;
				const tab = (win.tabs ?? [])[0];
				if (tab.cookieStoreId !== undefined && tab.cookieStoreId !== last.cookieStoreId) continue;
				const at = entry.lastModified;
				if (typeof at !== "number" || at < removedAt - CLOSED_SLACK_MS || at > removedBy + CLOSED_SLACK_MS) continue;
				if (found === null || at < found.at) found = { sessionId: win.sessionId, at };
			}
			if (found !== null) {
				await this.#d.sessions.forgetClosedWindow(found.sessionId);
				this.#d.log("window.closed_window_forgotten", {});
				return;
			}
		}
		this.#d.log("window.closed_window_not_forgotten", {});
	}

	/**
	 * Take the closed job tab out of the recently-closed list. Only the entry
	 * of that tab is touched: in a normal window the list is also the
	 * operator's own undo history.
	 *
	 * The entry is not known by its address alone: a page can change that at
	 * the very moment it is closed (history.replaceState in "pagehide"). It is
	 * known by where and when: a tab of the gateway window that was closed
	 * while this module's own tabs.remove() ran. Of several such entries the
	 * one with the tab's address is taken, else the one closed first. The list
	 * does not say which cookie store a closed tab was in (Firefox 156); where
	 * an entry does, it must be the job tab's.
	 * @param {browser.tabs.Tab} last the tab as it was just before it was closed
	 * @param {number} removedAt when the closing began
	 * @param {number} removedBy when the browser said it was done
	 */
	async #forgetClosed(last, removedAt, removedBy) {
		// A tab that never left about:blank is not recorded.
		if (last.windowId === undefined || last.url === undefined || last.url === BLANK) return;
		// The record can show up a moment after tabs.remove() resolves.
		for (let i = 0; i < 6; i++) {
			if (i > 0) await sleep(150);
			const closed = await this.#d.sessions.getRecentlyClosed({ maxResults: 25 });
			/** @type {{ sessionId: string, at: number, sameUrl: boolean } | null} */
			let found = null;
			for (const entry of closed) {
				const tab = entry.tab;
				if (tab === undefined || tab.sessionId === undefined || tab.windowId !== last.windowId) continue;
				if (tab.cookieStoreId !== undefined && tab.cookieStoreId !== last.cookieStoreId) continue;
				const at = entry.lastModified;
				if (typeof at !== "number" || at < removedAt - CLOSED_SLACK_MS || at > removedBy + CLOSED_SLACK_MS) continue;
				const sameUrl = tab.url === last.url;
				if (found === null || (sameUrl && !found.sameUrl) || (sameUrl === found.sameUrl && at < found.at)) found = { sessionId: tab.sessionId, at, sameUrl };
			}
			if (found !== null) {
				await this.#d.sessions.forgetClosedTab(last.windowId, found.sessionId);
				this.#d.log("window.closed_tab_forgotten", {});
				return;
			}
		}
		this.#d.log("window.closed_tab_not_forgotten", {});
	}

	/**
	 * Find gateway windows this instance does not track (left over from the
	 * last browser session): adopt one, close the others. Leftover job tabs
	 * are always closed. A window in which the operator opened tabs of their
	 * own is handed over to them instead.
	 * @returns {Promise<SweepReport>}
	 */
	async #sweep() {
		/** @type {SweepReport} */
		const report = { adopted: false, closedWindows: 0, closedTabs: 0, disowned: 0 };
		const wins = await this.#d.windows.getAll({ populate: true });
		for (const win of wins) {
			const id = win.id;
			if (id === undefined || id === this.#windowId) continue;
			const role = await this.#d.sessions.getWindowValue(id, ROLE_KEY).catch(() => undefined);
			const tagged = role === ROLE_WINDOW;
			const roles = await this.#classify(win);
			const leftovers = roles.job.filter((t) => t.id !== undefined && !this.#jobTabs.has(t.id));
			if (role === ROLE_HANDOFF && !this.#handoffWindows.has(id)) {
				// A window that held a challenge for the operator in an earlier session.
				// Its job is long over: the tab goes, and with it the window unless the
				// operator put tabs of their own into it.
				if (roles.foreign.length === 0 && roles.park.length === 0) this.#closingWindows.add(id);
				else await this.#d.sessions.removeWindowValue(id, ROLE_KEY).catch(() => {});
				for (const tab of leftovers) {
					if (tab.id !== undefined) await this.#removeTab(tab.id);
				}
				report.closedTabs += leftovers.length;
				if (roles.foreign.length === 0 && roles.park.length === 0) report.closedWindows += 1;
				continue;
			}
			if (!tagged && roles.park.length === 0) continue;
			if (roles.foreign.length > 0) {
				await this.#disown(id, roles);
				report.disowned += 1;
				report.closedTabs += roles.park.length + leftovers.length;
				continue;
			}
			if (this.#windowId === null && win.type === "normal" && !win.incognito) {
				this.#windowId = id;
				this.#parkTabId = null;
				// The park tab first, so the window survives losing its job tabs.
				await this.#ensureParkTab(id, roles.park);
				for (const tab of leftovers) {
					if (tab.id !== undefined) await this.#removeTab(tab.id);
				}
				report.adopted = true;
				report.closedTabs += leftovers.length;
				this.#d.log("window.adopted", {});
				this.#d.onChange();
				continue;
			}
			this.#closingWindows.add(id);
			await this.#d.windows.remove(id).catch(() => this.#closingWindows.delete(id));
			report.closedWindows += 1;
		}
		return report;
	}

	/**
	 * The operator closed a window. When none of their normal windows is left,
	 * close ours too, so the browser can quit instead of lingering behind a
	 * window nobody looks at.
	 */
	async #followLastWindow() {
		if (this.#windowId === null) return;
		const normals = await this.#d.windows.getAll({ windowTypes: ["normal"] });
		if (normals.some((w) => w.id !== this.#windowId)) return;
		this.#d.log("window.following_last_window", {});
		await this.close();
	}
}

/**
 * @param {string} name
 * @param {WindowDeps} deps
 * @returns {WindowStrategy}
 */
export function createWindowStrategy(name, deps) {
	if (name === "normal") return new NormalWindow(deps);
	throw new Error(`unknown gateway window strategy: ${name}`);
}
