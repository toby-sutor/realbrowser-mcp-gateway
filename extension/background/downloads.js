// Downloads backstop. The request guard refuses every
// response the browser would save, but three ways of saving a file involve no
// response header at all: a download started by script from a blob, a
// navigation to a data: URL, and a response made up by a service worker.
//
// Whatever a job downloads is therefore cancelled, its file removed and its
// entry erased, and the job is ended at the first of them. Files are only
// ever removed through downloads.removeFile(id), never by path.
//
// Whose download is it? The downloads API says which cookie store a download
// belongs to (DownloadItem.cookieStoreId), and a download that carries the
// gateway container's store id is a job's. That alone is not enough: measured
// in Firefox 156, a download whose frame is gone by the time it starts (a
// page that puts a frame in, lets it save a blob and takes it out again) is
// reported with the default store. So while a job tab is open, and for a few
// seconds after it closed, a download is a job's as well when
//
//   - its address is a blob: URL of an origin the job tab loaded a page or a
//     frame from before the download began, and no tab outside the container
//     shows that origin; or
//   - its address is a data: URL (or a blob of no origin, "blob:null/...") and
//     it began after a download that was certainly that job's.
//
// When a tab of the operator's own shows the origin of such a blob, nobody
// can tell whose download it is. It is not touched then, the job is ended, and
// the log says so. A download that matches none of this is never touched,
// whatever its referrer looks like: not one that began before the job tab had
// loaded anything from that origin, and not a blob of another extension.
//
// A download is looked at when it is created, once more a moment later, and
// whenever it changes: what the browser says about it can come late. Every
// look judges it by the moment it began, so a download that was there before
// a job came to its site never becomes that job's.
//
// Measured in Firefox 156: removeFile only works on a finished download, and a
// download cancelled in its first moments can leave its target file behind.
// Hence the order: give it a moment to finish and remove the finished file;
// only what is still running after that is cancelled, which then cleans up
// after itself.
//
// A job that runs with the operator's own cookie store (login opt-in) cannot be
// told from the operator by the store at all. For as long as such a job tab is
// open, and a few seconds after:
//
//   - a blob: download of an origin the job tab loaded is the job's when no tab
//     of the operator's has shown that origin since the job began, and in
//     doubt otherwise (the rule above, with a longer memory);
//   - a data: download, a blob of no origin, and a file from the web that comes
//     from an origin the job tab loaded or was started by a page of one, is in
//     doubt: the operator may have saved it. It is not touched. The job ends.
//
// Nothing that is in doubt is ever cancelled or removed. So a page under a
// login rule can leave a file in the download directory - by a data: address,
// or by a download that no response header announces - and the gateway will
// say so and end the job, but will not delete what may be the operator's.
//
// Only downloads that begin while this is listening are dealt with. What is
// already in the browser's list is never gone through: a file that was there
// before is not this module's to judge.
//
// It listens from the first statement of the background page, before the
// browser has said which container is the gateway's. A download that begins
// in those first moments in the cookie store of a container - any container:
// the one the settings name need not be the gateway's any more - is noted,
// nothing else, and looked at again the moment the answer is there
// (recheck). Nothing is cancelled or removed on the word of the settings: the
// operator may have made that container theirs.

import { errorText } from "./errtext.js";

/**
 * @typedef {object} DownloadLike the part of a DownloadItem used here
 * @property {number} id
 * @property {string} [state] in_progress | interrupted | complete
 * @property {boolean} [exists]
 * @property {string} [cookieStoreId]
 * @property {string} [url]
 * @property {string} [referrer]
 *
 * @typedef {object} DownloadsApi the part of browser.downloads used here
 * @property {{ addListener: (fn: (item: DownloadLike) => void) => void }} onCreated
 * @property {{ addListener: (fn: (delta: { id: number, state?: { current?: string } }) => void) => void }} onChanged
 * @property {(query: { id?: number }) => Promise<DownloadLike[]>} search
 * @property {(id: number) => Promise<void>} cancel
 * @property {(id: number) => Promise<void>} removeFile
 * @property {(query: { id: number }) => Promise<number[]>} erase
 *
 * @typedef {object} JobTraces what the job tabs of the moment can be recognised by
 * @property {boolean} active a job tab is open, or one closed a moment ago
 * @property {ReadonlyMap<string, number>} origins origins those tabs loaded pages and frames from -> when the first time
 * @property {number | null} caughtAt when the first download of those jobs was caught; null: none yet
 * @property {ReadonlyMap<string, number>} [loginOrigins] the same as origins, of the job tabs that run with the operator's
 *   own cookie store
 * @property {number | null} [loginSince] when the first of those tabs loaded its first page; null or absent: there is none
 *
 * @typedef {object} BackstopTuning
 * @property {number} pollMs
 * @property {number} graceMs how long a running download is left alone before it is cancelled
 * @property {number} tries how often a download is looked at before it is left to the change events
 * @property {number} traceGraceMs how long after a job tab closed a download can still be that job's
 * @property {number} recheckMs when a download that was nobody's at first is looked at once more
 *
 * @typedef {object} BackstopDeps
 * @property {DownloadsApi | undefined} downloads undefined when the permission is missing
 * @property {() => string | null} storeId cookie store of the gateway container, null while it is not known. Call recheck()
 *   when it becomes known
 * @property {() => void} onCaught a download of a job was found
 * @property {(graceMs: number) => JobTraces} [traces] absent: the cookie store is all there is to go by
 * @property {() => Promise<ReadonlySet<string>>} [foreignOrigins] origins that tabs outside the container show right now
 * @property {() => void} [onAmbiguous] a download was found that may be a job's or the operator's own
 * @property {(event: string, fields?: Record<string, string | number | boolean | null>) => void} log
 * @property {Partial<BackstopTuning>} [tuning]
 *
 * @typedef {"store" | "origin" | "after"} By how a download was told to be a job's
 */

/** @type {BackstopTuning} */
const DEFAULT_TUNING = Object.freeze({ pollMs: 100, graceMs: 400, tries: 60, traceGraceMs: 5000, recheckMs: 300 });
// Downloads that were nobody's when they were created and may still turn out to be a job's.
const MAX_WATCHED = 500;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The first attribution rule. A missing or foreign store id means "not by this rule".
 * @param {unknown} item a DownloadItem
 * @param {string | null} storeId cookie store of the gateway container
 * @returns {boolean}
 */
export function isGatewayDownload(item, storeId) {
	if (typeof storeId !== "string" || !/^firefox-container-[0-9]+$/.test(storeId)) return false;
	if (typeof item !== "object" || item === null) return false;
	const d = /** @type {Record<string, unknown>} */ (item);
	return typeof d.id === "number" && d.cookieStoreId === storeId;
}

/**
 * @param {unknown} url the address of a download
 * @returns {string | null} scheme://host[:port] of the page a blob: URL was made by; null for anything else,
 *   and for a blob without an origin
 */
export function blobOrigin(url) {
	if (typeof url !== "string" || !url.startsWith("blob:")) return null;
	try {
		const inner = new URL(url.slice(5));
		return inner.protocol === "http:" || inner.protocol === "https:" ? inner.origin : null;
	} catch {
		return null;
	}
}

/**
 * @param {unknown} url
 * @returns {string | null} scheme://host[:port] of an http(s) address
 */
function webOrigin(url) {
	if (typeof url !== "string" || !/^https?:/i.test(url)) return null;
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

export class DownloadsBackstop {
	#d;
	/** @type {BackstopTuning} */
	#tuning;
	/** @type {Set<number>} downloads being dealt with */
	#busy = new Set();
	/** @type {Set<number>} downloads of a job that could not be finished off yet */
	#pending = new Set();
	/** @type {Map<number, { by: By, url: string }>} downloads that were told to be a job's, and by what */
	#ours = new Map();
	/** @type {Map<number, number>} downloads that were nobody's when they were created -> when that was */
	#watched = new Map();
	/** @type {Set<number>} downloads nobody can tell the owner of: said once, never touched */
	#ambiguous = new Set();
	/** @type {Map<number, number>} downloads in a container's cookie store that began while the gateway's container was not known -> when */
	#early = new Map();
	#started = false;

	/** @param {BackstopDeps} deps */
	constructor(deps) {
		this.#d = deps;
		this.#tuning = { ...DEFAULT_TUNING, ...deps.tuning };
	}

	/** True when the browser offers the downloads API to this extension. */
	get available() {
		return this.#d.downloads !== undefined;
	}

	/** Begin watching. Safe to call twice. */
	start() {
		const api = this.#d.downloads;
		if (api === undefined || this.#started) return;
		this.#started = true;
		api.onCreated.addListener((item) => {
			this.#consider(item, Date.now()).catch(() => {});
		});
		api.onChanged.addListener((delta) => {
			if (this.#pending.has(delta.id)) {
				// One of a job's that would not go: finish it off now that it changed.
				if (delta.state?.current !== "in_progress") this.#remove(delta.id).catch(() => {});
				return;
			}
			const seenAt = this.#watched.get(delta.id);
			if (seenAt !== undefined) this.#lookAgain(delta.id, seenAt).catch(() => {});
		});
	}

	/**
	 * Whose download is it?
	 * @param {DownloadLike} item
	 * @param {number} seenAt when the download was created
	 * @returns {Promise<By | "ambiguous" | null>} null: nothing says it is a job's
	 */
	async #attribute(item, seenAt) {
		if (isGatewayDownload(item, this.#d.storeId())) return "store";
		if (typeof item !== "object" || item === null || typeof item.id !== "number" || this.#d.traces === undefined) return null;
		const traces = this.#d.traces(this.#tuning.traceGraceMs);
		if (!traces.active) return null;
		const url = typeof item.url === "string" ? item.url : "";
		const origin = blobOrigin(url);
		if (origin !== null) {
			// A blob is made by a document. A download that began before the job tab
			// had one from that origin was made by someone else's.
			const loadedAt = traces.origins.get(origin);
			if (loadedAt === undefined || seenAt < loadedAt) return null;
			// A tab of the operator's own on that site could have made the very same download.
			const foreign = this.#d.foreignOrigins === undefined ? null : await this.#d.foreignOrigins().catch(() => null);
			return foreign === null || foreign.has(origin) ? "ambiguous" : "origin";
		}
		// A job with the operator's own cookie store is about: from here on nothing
		// tells its downloads from theirs, so nothing is taken for the job's.
		const loginSince = traces.loginSince ?? null;
		const login = loginSince !== null && seenAt >= loginSince;
		// No origin to go by: only what follows a download that was certainly the job's.
		// A blob of any other origin (an extension's, say) is not a page's at all.
		const noOrigin = url.startsWith("data:") || url.startsWith("blob:null/");
		if (noOrigin) {
			if (login) return "ambiguous";
			return traces.caughtAt !== null && seenAt >= traces.caughtAt ? "after" : null;
		}
		if (login && traces.loginOrigins !== undefined) {
			// A file from the web. The request guard refuses what a job tab would
			// save, so this is most likely the operator's own - but if it comes from
			// where the job's page is, or was started by a page from there, the job
			// may have found a way. In doubt: left alone, and the job ends.
			for (const from of [webOrigin(url), webOrigin(item.referrer)]) {
				const loadedAt = from === null ? undefined : traces.loginOrigins.get(from);
				if (loadedAt !== undefined && seenAt >= loadedAt) return "ambiguous";
			}
		}
		return null;
	}

	/**
	 * A download was created, or one that was nobody's is looked at again.
	 * @param {DownloadLike} item
	 * @param {number} seenAt
	 */
	async #consider(item, seenAt) {
		if (typeof item !== "object" || item === null || typeof item.id !== "number") return;
		const id = item.id;
		if (this.#ours.has(id) || this.#ambiguous.has(id)) return;
		const unknown = this.#d.storeId() === null;
		const by = await this.#attribute(item, seenAt);
		if (this.#ours.has(id) || this.#ambiguous.has(id)) return;
		if (by === "ambiguous") {
			this.#ambiguous.add(id);
			this.#watched.delete(id);
			this.#d.log("downloads.ambiguous", {});
			this.#d.onAmbiguous?.();
			return;
		}
		if (by !== null) {
			this.#watched.delete(id);
			this.#ours.set(id, { by, url: typeof item.url === "string" ? item.url : "" });
			if (by !== "store") this.#d.log("downloads.attributed", { by });
			this.#d.onCaught();
			await this.#remove(id);
			return;
		}
		// Whose container it is in was not known when it was looked at: asked again when it is - or now, if it is by now.
		if (unknown && typeof item.cookieStoreId === "string" && /^firefox-container-[0-9]+$/.test(item.cookieStoreId)) {
			if (this.#d.storeId() !== null) return this.#lookAgain(id, seenAt);
			if (this.#early.size >= MAX_WATCHED) this.#early.delete(/** @type {number} */ (this.#early.keys().next().value));
			this.#early.set(id, seenAt);
		}
		// Nobody's for now. While a job is about, what the browser says may still change.
		const first = !this.#watched.has(id);
		if (!first || this.#d.traces === undefined || !this.#d.traces(this.#tuning.traceGraceMs).active) return;
		if (this.#watched.size >= MAX_WATCHED) this.#watched.delete(/** @type {number} */ (this.#watched.keys().next().value));
		this.#watched.set(id, seenAt);
		await sleep(this.#tuning.recheckMs);
		await this.#lookAgain(id, seenAt);
	}

	/**
	 * The gateway's container is known now: the downloads that began before that, in the cookie store of a
	 * container, are looked at again and judged by the moment they began. Safe to call at any time.
	 */
	recheck() {
		if (this.#d.storeId() === null) return;
		const early = [...this.#early];
		this.#early.clear();
		for (const [id, seenAt] of early) this.#lookAgain(id, seenAt).catch(() => {});
	}

	/**
	 * @param {number} id a download that was nobody's when it was created
	 * @param {number} seenAt
	 */
	async #lookAgain(id, seenAt) {
		const api = this.#d.downloads;
		if (api === undefined || this.#ours.has(id) || this.#ambiguous.has(id)) return;
		const item = (await api.search({ id }))[0];
		if (item === undefined) {
			this.#watched.delete(id);
			return;
		}
		await this.#consider(item, seenAt);
	}

	/**
	 * @param {DownloadLike} item as the browser reports it now
	 * @returns {boolean} true while it is still the download that was told to be a job's
	 */
	#stillOurs(item) {
		const ours = this.#ours.get(item.id);
		if (ours === undefined) return false;
		return ours.by === "store" ? isGatewayDownload(item, this.#d.storeId()) : item.url === ours.url;
	}

	/**
	 * Cancel, remove the file, erase the entry. Every step looks the download
	 * up again and checks that it is still the one that was told to be a job's.
	 * @param {number} id
	 */
	async #remove(id) {
		const api = this.#d.downloads;
		if (api === undefined || this.#busy.has(id)) return;
		this.#busy.add(id);
		let cancelled = false;
		let fileRemoved = false;
		let removeTries = 0;
		const caughtAt = Date.now();
		try {
			for (let i = 0; i < this.#tuning.tries; i++) {
				const item = (await api.search({ id }))[0];
				// Gone already, or not (or no longer) what it was taken for: hands off.
				if (item === undefined || !this.#stillOurs(item)) {
					this.#pending.delete(id);
					this.#ours.delete(id);
					if (item !== undefined) this.#d.log("downloads.not_attributed", {});
					return;
				}
				if (item.state === "in_progress") {
					// Not at once. A small file is complete within a moment and can
					// then be removed by its id, which is the only way the API
					// offers to remove a file. And a download cancelled in its
					// first moments leaves its target file behind in Firefox.
					if (Date.now() - caughtAt >= this.#tuning.graceMs) {
						// Fails when the download finished meanwhile: the next look tells.
						await api.cancel(id).then(
							() => {
								cancelled = true;
							},
							() => {},
						);
					}
					await sleep(this.#tuning.pollMs);
					continue;
				}
				if (item.state === "complete" && item.exists !== false) {
					// By id: the browser removes the file it saved for this download and no other.
					fileRemoved = await api.removeFile(id).then(
						() => true,
						() => false,
					);
					removeTries += 1;
					if (!fileRemoved && removeTries < 3) {
						await sleep(this.#tuning.pollMs);
						continue;
					}
				}
				await api.erase({ id });
				this.#pending.delete(id);
				this.#ours.delete(id);
				this.#d.log("downloads.removed", { cancelled, file_removed: fileRemoved, state: String(item.state) });
				return;
			}
			// Still running after every cancel: finish the job when it changes state.
			this.#pending.add(id);
			this.#d.log("downloads.not_cancelled", {});
		} catch (err) {
			this.#pending.add(id);
			this.#d.log("downloads.remove_failed", { message: errorText(err) });
		} finally {
			this.#busy.delete(id);
		}
	}
}
