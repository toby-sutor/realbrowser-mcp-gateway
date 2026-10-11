// A few values kept in the IndexedDB of the extension's own pages (the
// background page, the options page). Used for what must be out of reach of
// the extension's content scripts: a content script can use storage.local,
// but the IndexedDB it sees is that of the web page it runs in, never the
// extension's.
//
// IndexedDB rather than localStorage: a write is on disk when it is reported
// done, as a write to storage.local is. (Measured in Firefox 156: a
// localStorage write of an extension page was lost when the browser was
// killed within a few seconds of it, while storage.local had kept its part.)
//
// Only to be loaded in an extension page. There is no fallback: a browser
// that withholds IndexedDB from extension pages makes every call fail, and
// the callers treat that as "nothing can be vouched for".
//
// Two things are kept here: the copy of the operator's login rules that the
// options page writes (shared/optin.js), and the key the extension proves
// itself to the daemon with (pairingStore below, written by the background
// page). The second has a door of its own that leads to its one value and to
// nothing else, so the code that keeps the key cannot write a rule.

const DB_NAME = "bgw-own";
const STORE = "kv";
// Longest value that is kept or handed back.
const MAX_VALUE_CHARS = 262144;

/** @returns {Promise<IDBDatabase>} */
function open() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("the extension's own storage cannot be opened"));
		request.onblocked = () => reject(new Error("the extension's own storage is blocked"));
	});
}

/**
 * @template T
 * @param {"readonly" | "readwrite"} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>} work
 * @returns {Promise<T>} the result of the request, once its transaction is complete
 */
async function run(mode, work) {
	const db = await open();
	try {
		return await new Promise((resolve, reject) => {
			const tx = db.transaction(STORE, mode, { durability: "strict" });
			const request = work(tx.objectStore(STORE));
			tx.oncomplete = () => resolve(request.result);
			tx.onerror = () => reject(tx.error ?? new Error("the extension's own storage failed"));
			tx.onabort = () => reject(tx.error ?? new Error("the extension's own storage gave up"));
		});
	} finally {
		db.close();
	}
}

/**
 * @param {string} key
 * @returns {Promise<string | null>} null when there is no such value
 */
export async function ownGet(key) {
	const value = await run("readonly", (store) => store.get(key));
	return typeof value === "string" && value.length <= MAX_VALUE_CHARS ? value : null;
}

/**
 * @param {string} key
 * @param {string} value
 */
export async function ownSet(key, value) {
	if (typeof value !== "string" || value.length > MAX_VALUE_CHARS) throw new RangeError("value too large");
	await run("readwrite", (store) => store.put(value, key));
}

/** @param {string} key */
export async function ownRemove(key) {
	await run("readwrite", (store) => store.delete(key));
}

// Under this name the pairing key is kept: base64url of its 32 bytes, or the empty text for "this extension
// keeps its key here, and has none" (never paired, or the operator had it forgotten). No value at all: nothing
// was ever kept here - a build from before the key moved here kept it in storage.local.
export const PAIRING_SLOT = "pairingKey";

/**
 * The pairing key's place in this store, and nothing else of it.
 * @type {Readonly<{ get: () => Promise<string | null>, set: (value: string) => Promise<void> }>}
 */
export const pairingStore = Object.freeze({
	get: () => ownGet(PAIRING_SLOT),
	set: (value) => ownSet(PAIRING_SLOT, value),
});
