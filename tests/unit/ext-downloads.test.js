// The downloads backstop against a model of browser.downloads. What matters
// most comes first: a download that is not the gateway container's is never
// touched in any way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEvent, logSink, sleep } from "../helpers/ext-fakes.js";
import { until } from "../helpers/daemon.js";
import { DownloadsBackstop, blobOrigin, isGatewayDownload } from "../../extension/background/downloads.js";

const STORE = "firefox-container-7";

/**
 * @typedef {object} Item one download in the model
 * @property {number} id
 * @property {string} state
 * @property {boolean} exists
 * @property {string} [cookieStoreId]
 * @property {string} [url]
 * @property {string} [referrer]
 */

/**
 * @param {{ storeId?: string | null, cancel?: (item: Item) => void, removeFile?: (item: Item) => void, graceMs?: number, tries?: number,
 *   job?: { active?: boolean, origins?: string[], caughtAt?: number | null, login?: boolean }, foreign?: string[] | null }} [opts]
 *   job: what the job tabs of the moment can be recognised by (absent: the backstop is told nothing about jobs).
 *   login: the job tab runs with the operator's own cookie store;
 *   foreign: origins the operator's own tabs show (null: asking fails)
 */
function setup(opts = {}) {
	/** @type {Map<number, Item>} */
	const items = new Map();
	/** @type {string[]} every call made to the API */
	const calls = [];
	const onCreated = new FakeEvent();
	const onChanged = new FakeEvent();
	const api = {
		onCreated,
		onChanged,
		search: async (/** @type {{ id?: number }} */ query) => {
			calls.push(query.id === undefined ? "search" : `search:${query.id}`);
			return [...items.values()].filter((i) => query.id === undefined || i.id === query.id).map((i) => ({ ...i }));
		},
		cancel: async (/** @type {number} */ id) => {
			calls.push(`cancel:${id}`);
			const item = items.get(id);
			if (item === undefined) throw new Error(`Invalid download id ${id}`);
			if (item.state === "complete") throw new Error(`Download ${id} is already complete`);
			if (opts.cancel) opts.cancel(item);
			else {
				item.state = "interrupted";
				item.exists = false;
			}
		},
		removeFile: async (/** @type {number} */ id) => {
			calls.push(`removeFile:${id}`);
			const item = items.get(id);
			if (item === undefined) throw new Error(`Invalid download id ${id}`);
			if (item.state !== "complete") throw new Error(`Cannot remove incomplete download id ${id}`);
			if (opts.removeFile) opts.removeFile(item);
			else item.exists = false;
		},
		erase: async (/** @type {{ id: number }} */ query) => {
			calls.push(`erase:${query.id}`);
			return items.delete(query.id) ? [query.id] : [];
		},
	};
	const sink = logSink();
	let caught = 0;
	let ambiguous = 0;
	let storeId = opts.storeId === undefined ? STORE : opts.storeId;
	// What the guard would say about the job tabs. A test may change it as it goes.
	// The job tab loaded its origins a second ago, unless a test says otherwise.
	const loadedAt = Date.now() - 1000;
	const origins = new Map((opts.job?.origins ?? []).map((origin) => [origin, loadedAt]));
	const login = opts.job?.login === true;
	const job = { active: opts.job?.active ?? true, origins, caughtAt: opts.job?.caughtAt ?? null, loginOrigins: login ? origins : new Map(), loginSince: /** @type {number | null} */ (login ? loadedAt : null) };
	const world = { foreign: opts.foreign === undefined ? /** @type {string[] | null} */ ([]) : opts.foreign, asked: 0 };
	const backstop = new DownloadsBackstop({
		downloads: /** @type {any} */ (api),
		storeId: () => storeId,
		onCaught: () => {
			caught += 1;
			// As main.js does: the job remembers when its first download was caught.
			job.caughtAt ??= Date.now();
		},
		...(opts.job === undefined
			? {}
			: {
					traces: () => job,
					foreignOrigins: async () => {
						world.asked += 1;
						if (world.foreign === null) throw new Error("tabs.query failed");
						return new Set(world.foreign);
					},
					onAmbiguous: () => {
						ambiguous += 1;
					},
				}),
		log: sink.log,
		tuning: { pollMs: 5, graceMs: opts.graceMs ?? 40, tries: opts.tries ?? 40, recheckMs: 25, traceGraceMs: 1000 },
	});
	backstop.start();
	/** @param {Partial<Item> & { id: number }} item */
	const create = (item) => {
		const full = { state: "in_progress", exists: false, ...item };
		items.set(full.id, full);
		onCreated.fire({ ...full });
		return full;
	};
	/** @param {string} prefix */
	const touched = (prefix) => calls.filter((c) => c.startsWith(prefix));
	return { backstop, api, items, calls, sink, create, touched, job, world, caught: () => caught, ambiguous: () => ambiguous, setStore: (/** @type {string | null} */ id) => (storeId = id), onChanged };
}

test("a download that is not the gateway container's is never touched", async () => {
	const t = setup();
	/** @type {Partial<Item>[]} */
	const foreign = [
		{ cookieStoreId: "firefox-default" },
		{ cookieStoreId: "firefox-private" },
		{ cookieStoreId: "firefox-container-8" },
		{ cookieStoreId: "firefox-container-77" },
		{ cookieStoreId: "" },
		// No store id at all (a browser that does not report one): not attributable.
		{},
		// Nothing but the store id counts: not the address, not the referrer.
		{ cookieStoreId: "firefox-default", url: "blob:https://job.example/1", referrer: "https://job.example/" },
	];
	let id = 0;
	for (const item of foreign) {
		t.create({ id: ++id, state: "in_progress", ...item });
		t.create({ id: ++id, state: "complete", exists: true, ...item });
	}
	await sleep(120);
	assert.deepEqual(t.calls, [], "no call to the downloads API at all");
	assert.equal(t.caught(), 0);
	assert.equal(t.items.size, foreign.length * 2, "every one of them is still there");
	assert.ok([...t.items.values()].every((i) => i.state === "in_progress" || i.exists === true));
	// Nor when they change later.
	t.onChanged.fire({ id: 2, state: { current: "complete" } });
	t.onChanged.fire({ id: 1, state: { current: "interrupted" } });
	await sleep(30);
	assert.deepEqual(t.touched("cancel"), []);
	assert.deepEqual(t.touched("removeFile"), []);
	assert.deepEqual(t.touched("erase"), []);
});

test("while the container is not known, nothing is attributed to it", async () => {
	const t = setup({ storeId: null });
	t.create({ id: 1, cookieStoreId: STORE });
	t.create({ id: 2, cookieStoreId: "firefox-default" });
	await sleep(80);
	assert.deepEqual(t.calls, []);
	assert.equal(t.caught(), 0);
});

test("a download that began in a container before the gateway's was known is judged the moment it is: removed if it is the gateway's, never touched if it is not", async () => {
	const t = setup({ storeId: null });
	// The first moments of the browser: which container is the gateway's has not been said yet.
	t.create({ id: 1, cookieStoreId: STORE, state: "complete", exists: true });
	t.create({ id: 2, cookieStoreId: "firefox-container-8", state: "complete", exists: true });
	t.create({ id: 3, cookieStoreId: "firefox-default", state: "complete", exists: true });
	t.create({ id: 4, cookieStoreId: "firefox-private", state: "complete", exists: true });
	t.create({ id: 5, state: "complete", exists: true });
	await sleep(60);
	assert.deepEqual(t.calls, [], "nothing is done on a guess");
	t.backstop.recheck();
	await sleep(30);
	assert.deepEqual(t.calls, [], "asked too early, nothing happens");
	// The browser has said.
	t.setStore(STORE);
	t.backstop.recheck();
	await until(() => !t.items.has(1), { timeoutMs: 3000, what: "the gateway's download to go" });
	await sleep(60);
	assert.equal(t.caught(), 1);
	assert.deepEqual(t.touched("removeFile"), ["removeFile:1"]);
	assert.deepEqual(t.touched("erase"), ["erase:1"]);
	assert.deepEqual(t.touched("cancel"), []);
	assert.deepEqual([...t.items.keys()], [2, 3, 4, 5], "the others are where they were");
	// Only the two of a container were looked at again; the rest was never asked about.
	assert.deepEqual([...new Set(t.touched("search"))].sort(), ["search:1", "search:2"]);
	// Asked again, nothing is left to look at.
	const calls = t.calls.length;
	t.backstop.recheck();
	await sleep(30);
	assert.equal(t.calls.length, calls);

	// The container the gateway used last was made the operator's meanwhile, and the gateway's is another: the
	// download that began in the old one is theirs, and stays.
	const renamed = setup({ storeId: null });
	renamed.create({ id: 9, cookieStoreId: STORE, state: "complete", exists: true });
	await sleep(30);
	renamed.setStore("firefox-container-20");
	renamed.backstop.recheck();
	await sleep(80);
	assert.equal(renamed.caught(), 0);
	assert.deepEqual(renamed.touched("removeFile"), []);
	assert.deepEqual(renamed.touched("erase"), []);
	assert.deepEqual(renamed.touched("cancel"), []);
	assert.equal(renamed.items.get(9)?.exists, true);
});

test("isGatewayDownload: the store id reported by the browser, and nothing else", () => {
	assert.equal(isGatewayDownload({ id: 1, cookieStoreId: STORE }, STORE), true);
	assert.equal(isGatewayDownload({ id: 1, cookieStoreId: "firefox-default" }, STORE), false);
	assert.equal(isGatewayDownload({ id: 1 }, STORE), false);
	assert.equal(isGatewayDownload({ id: 1, cookieStoreId: null }, STORE), false);
	assert.equal(isGatewayDownload({ cookieStoreId: STORE }, STORE), false, "no id, no handle");
	assert.equal(isGatewayDownload(null, STORE), false);
	assert.equal(isGatewayDownload("download", STORE), false);
	assert.equal(isGatewayDownload({ id: 1, cookieStoreId: STORE }, null), false);
	// The gateway never runs in the default or the private store, whatever it is told.
	assert.equal(isGatewayDownload({ id: 1, cookieStoreId: "firefox-default" }, "firefox-default"), false);
	assert.equal(isGatewayDownload({ id: 1, cookieStoreId: "firefox-private" }, "firefox-private"), false);
	assert.equal(isGatewayDownload({ id: 1, cookieStoreId: "" }, ""), false);
});

test("a finished download of the container: its file is removed by id, its entry erased, the job told", async () => {
	const t = setup();
	t.create({ id: 5, cookieStoreId: STORE, state: "complete", exists: true });
	await until(() => t.items.size === 0, { what: "the entry to be erased" });
	assert.deepEqual(t.calls, ["search:5", "removeFile:5", "erase:5"]);
	assert.equal(t.caught(), 1);
	assert.deepEqual(t.sink.entries.at(-1), { event: "downloads.removed", fields: { cancelled: false, file_removed: true, state: "complete" } });
});

test("a small download is given a moment to finish and then removed, not cancelled", async () => {
	const t = setup({ graceMs: 200 });
	const item = t.create({ id: 6, cookieStoreId: STORE });
	setTimeout(() => {
		item.state = "complete";
		item.exists = true;
	}, 40);
	await until(() => t.items.size === 0, { what: "the entry to be erased" });
	assert.deepEqual(t.touched("cancel"), []);
	assert.deepEqual(t.touched("removeFile"), ["removeFile:6"]);
	assert.deepEqual(t.touched("erase"), ["erase:6"]);
});

test("a download that is still running after the grace time is cancelled and erased", async () => {
	const t = setup({ graceMs: 30 });
	const started = Date.now();
	t.create({ id: 7, cookieStoreId: STORE });
	await until(() => t.items.size === 0, { what: "the entry to be erased" });
	assert.ok(Date.now() - started >= 30, "not before the grace time");
	assert.deepEqual(t.touched("cancel"), ["cancel:7"]);
	assert.deepEqual(t.touched("removeFile"), [], "nothing was finished, there is no file to remove");
	assert.deepEqual(t.sink.entries.at(-1), { event: "downloads.removed", fields: { cancelled: true, file_removed: false, state: "interrupted" } });
	assert.equal(t.caught(), 1);
});

test("a download that finishes just as it is cancelled is removed like a finished one", async () => {
	const t = setup({
		graceMs: 0,
		cancel: (item) => {
			item.state = "complete";
			item.exists = true;
			throw new Error("Download is already complete");
		},
	});
	t.create({ id: 8, cookieStoreId: STORE });
	await until(() => t.items.size === 0, { what: "the entry to be erased" });
	assert.deepEqual(t.touched("removeFile"), ["removeFile:8"]);
	assert.deepEqual(t.sink.entries.at(-1)?.fields, { cancelled: false, file_removed: true, state: "complete" });
});

test("every step looks again: a download no longer reported as the container's is let go", async () => {
	const t = setup({ graceMs: 60 });
	const item = t.create({ id: 9, cookieStoreId: STORE });
	// Whatever the reason: by the second look the browser reports another store.
	setTimeout(() => (item.cookieStoreId = "firefox-default"), 15);
	await sleep(150);
	assert.deepEqual(t.touched("cancel"), []);
	assert.deepEqual(t.touched("removeFile"), []);
	assert.deepEqual(t.touched("erase"), []);
	assert.equal(t.items.size, 1);
	assert.equal(t.sink.count("downloads.not_attributed"), 1);

	// The same when the container itself changes under a running download.
	const moved = setup({ graceMs: 60 });
	moved.create({ id: 10, cookieStoreId: STORE });
	moved.setStore("firefox-container-9");
	await sleep(150);
	assert.deepEqual(moved.touched("cancel"), []);
	assert.equal(moved.items.size, 1);
});

test("a file that cannot be removed: tried again, then the entry is erased and the log says so", async () => {
	const t = setup({
		removeFile: () => {
			throw new Error("Could not remove download id 11 because the file doesn't exist");
		},
	});
	t.create({ id: 11, cookieStoreId: STORE, state: "complete", exists: true });
	await until(() => t.items.size === 0, { what: "the entry to be erased" });
	assert.equal(t.touched("removeFile").length, 3);
	assert.deepEqual(t.sink.entries.at(-1)?.fields, { cancelled: false, file_removed: false, state: "complete" });
});

test("a download that will not stop is finished off when it changes state", async () => {
	const t = setup({ graceMs: 0, tries: 4, cancel: () => {} });
	const item = t.create({ id: 12, cookieStoreId: STORE });
	await until(() => t.sink.count("downloads.not_cancelled") === 1, { what: "the backstop to give up polling" });
	assert.equal(t.items.size, 1);
	// A change of another download wakes nothing.
	t.onChanged.fire({ id: 99, state: { current: "complete" } });
	await sleep(20);
	assert.deepEqual(t.touched("removeFile"), []);
	item.state = "complete";
	item.exists = true;
	t.onChanged.fire({ id: 12, state: { current: "complete" } });
	await until(() => t.items.size === 0, { what: "the entry to be erased" });
	assert.deepEqual(t.touched("removeFile"), ["removeFile:12"]);
});

test("files are only ever removed by the id of a container download", async () => {
	const t = setup({ graceMs: 20 });
	t.create({ id: 20, cookieStoreId: "firefox-default", state: "complete", exists: true });
	t.create({ id: 21, cookieStoreId: STORE, state: "complete", exists: true });
	t.create({ id: 22, cookieStoreId: "firefox-container-8", state: "complete", exists: true });
	t.create({ id: 23, cookieStoreId: STORE });
	t.create({ id: 24, state: "complete", exists: true });
	await until(() => t.items.size === 3, { what: "both container downloads to go" });
	await sleep(30);
	assert.deepEqual(t.touched("removeFile"), ["removeFile:21"]);
	assert.deepEqual(t.touched("cancel"), ["cancel:23"]);
	assert.deepEqual(t.touched("erase").sort(), ["erase:21", "erase:23"]);
	assert.deepEqual([...t.items.keys()].sort(), [20, 22, 24]);
	assert.ok([...t.items.values()].every((i) => i.exists === true), "the others still have their files");
	assert.equal(t.caught(), 2);
});

test("what is already in the browser's list is never gone through, whatever store it names", async () => {
	const t = setup();
	// Put there without the event: downloads from before the extension listened.
	t.items.set(30, { id: 30, state: "complete", exists: true, cookieStoreId: STORE });
	t.items.set(31, { id: 31, state: "complete", exists: true, cookieStoreId: "firefox-default" });
	t.items.set(32, { id: 32, state: "in_progress", exists: false, cookieStoreId: STORE });
	// A new container download is dealt with; the old entries are not even looked up.
	t.create({ id: 33, cookieStoreId: STORE, state: "complete", exists: true });
	await until(() => !t.items.has(33), { what: "the new download to go" });
	// Their own changes of state wake nothing either.
	t.onChanged.fire({ id: 30, state: { current: "complete" } });
	t.onChanged.fire({ id: 32, state: { current: "complete" } });
	await sleep(40);
	assert.deepEqual(t.calls, ["search:33", "removeFile:33", "erase:33"]);
	assert.deepEqual([...t.items.keys()], [30, 31, 32]);
});

test("without the downloads API the backstop reports itself unavailable and does nothing", async () => {
	const backstop = new DownloadsBackstop({ downloads: undefined, storeId: () => STORE, onCaught: () => assert.fail("nothing to catch"), log: () => {} });
	assert.equal(backstop.available, false);
	backstop.start();
	backstop.start();
	assert.equal(setup().backstop.available, true);
});

// ---------------------------------------------------------------- downloads the browser files under the wrong store

const JOB_ORIGIN = "https://job.example";
const BLOB = `blob:${JOB_ORIGIN}/0b6c3f2e-1111-4222-8333-444455556666`;

test("blobOrigin: the page a blob: URL was made by", () => {
	assert.equal(blobOrigin(BLOB), JOB_ORIGIN);
	assert.equal(blobOrigin("blob:http://a.localhost:4711/abc"), "http://a.localhost:4711");
	for (const other of ["blob:null/abc", "blob:", "blob:abc", "blob:file:///tmp/x", "blob:moz-extension://0f8c/abc", "https://job.example/a.bin", "data:text/plain,hi", "", null, undefined, 5]) {
		assert.equal(blobOrigin(other), null, String(other));
	}
});

test("while a job tab is open, a blob of an origin the job loaded is the job's, whatever store the browser names for it", async () => {
	const t = setup({ job: { origins: [JOB_ORIGIN] } });
	// What Firefox reports for a download whose frame is gone by the time it starts.
	t.create({ id: 1, cookieStoreId: "firefox-default", url: BLOB, state: "complete", exists: true });
	t.create({ id: 2, cookieStoreId: "firefox-default", url: `blob:${JOB_ORIGIN}/second`, state: "in_progress" });
	t.create({ id: 3, url: `blob:${JOB_ORIGIN}/no-store-at-all`, state: "complete", exists: true });
	await until(() => t.items.size === 0, { what: "all three to be removed" });
	assert.deepEqual(t.touched("removeFile"), ["removeFile:1", "removeFile:3"]);
	assert.deepEqual(t.touched("cancel"), ["cancel:2"]);
	assert.deepEqual(t.touched("erase").sort(), ["erase:1", "erase:2", "erase:3"]);
	assert.equal(t.caught(), 3, "the job is told of every one; it ends at the first");
	assert.equal(t.ambiguous(), 0);
	assert.equal(t.sink.count("downloads.attributed"), 3);
	assert.deepEqual(t.sink.entries.find((e) => e.event === "downloads.attributed")?.fields, { by: "origin" }, "how it was told is logged, never an address");
	assert.equal(t.sink.count("downloads.removed"), 3);
	assert.equal(JSON.stringify(t.sink.entries).includes("job.example"), false);
});

test("a job tab that is open changes nothing for downloads that are not its own", async () => {
	const t = setup({ job: { origins: [JOB_ORIGIN] } });
	/** @type {Partial<Item>[]} */
	const theirs = [
		// A blob of a site the job never loaded: the operator's own tab on another site.
		{ cookieStoreId: "firefox-default", url: "blob:https://operator.example/1" },
		// An ordinary download, of the job's very site even: only the store counts for those.
		{ cookieStoreId: "firefox-default", url: `${JOB_ORIGIN}/file.zip`, referrer: `${JOB_ORIGIN}/` },
		// Blobs and data: URLs nothing ties to the job: no download of it was caught so far.
		{ cookieStoreId: "firefox-default", url: "blob:null/abc" },
		{ cookieStoreId: "firefox-default", url: "data:application/octet-stream;base64,AAAA" },
		// Look-alikes of the job's origin.
		{ cookieStoreId: "firefox-default", url: "blob:https://job.example.evil.test/1" },
		{ cookieStoreId: "firefox-default", url: "blob:http://job.example/1" },
		{ cookieStoreId: "firefox-default", url: "blob:https://job.example:8443/1" },
		{ cookieStoreId: "firefox-container-8", url: "https://elsewhere.example/a.bin" },
		{},
	];
	let id = 0;
	for (const item of theirs) {
		t.create({ id: ++id, state: "in_progress", ...item });
		t.create({ id: ++id, state: "complete", exists: true, ...item });
	}
	await sleep(150);
	// Each is looked at once more a moment later, by a read of the list; that is all.
	assert.deepEqual([...new Set(t.calls.map((c) => c.split(":")[0]))], ["search"]);
	assert.equal(t.touched("search").length, theirs.length * 2, "one second look each");
	assert.deepEqual(t.touched("cancel"), []);
	assert.deepEqual(t.touched("removeFile"), []);
	assert.deepEqual(t.touched("erase"), []);
	assert.equal(t.caught(), 0);
	assert.equal(t.ambiguous(), 0);
	assert.equal(t.items.size, theirs.length * 2, "every one of them is still there");
	assert.deepEqual(t.sink.entries, []);
	// Nor when they change.
	for (let n = 1; n <= id; n++) t.onChanged.fire({ id: n, state: { current: "complete" } });
	await sleep(60);
	assert.deepEqual(t.touched("cancel").concat(t.touched("removeFile"), t.touched("erase")), []);
});

test("no job tab about: the store the browser names is all that counts, and nothing else is even looked at twice", async () => {
	const t = setup({ job: { active: false, origins: [JOB_ORIGIN] } });
	t.create({ id: 1, cookieStoreId: "firefox-default", url: BLOB, state: "complete", exists: true });
	t.create({ id: 2, cookieStoreId: "firefox-default", url: "data:text/plain,hi", state: "complete", exists: true });
	await sleep(100);
	assert.deepEqual(t.calls, [], "no call to the downloads API at all");
	assert.equal(t.world.asked, 0);
	t.create({ id: 3, cookieStoreId: STORE, state: "complete", exists: true });
	await until(() => !t.items.has(3), { what: "the container's own download to go" });
	assert.equal(t.items.size, 2);
});

test("the operator has the job's site open themselves: nobody can tell whose blob it is - not touched, the job ended, said once", async () => {
	const t = setup({ job: { origins: [JOB_ORIGIN] }, foreign: ["https://news.example", JOB_ORIGIN] });
	t.create({ id: 1, cookieStoreId: "firefox-default", url: BLOB, state: "complete", exists: true });
	t.create({ id: 2, cookieStoreId: "firefox-default", url: `blob:${JOB_ORIGIN}/running`, state: "in_progress" });
	await sleep(120);
	assert.deepEqual(t.calls, [], "neither of them is read again, cancelled, removed or erased");
	assert.equal(t.items.size, 2);
	assert.equal(t.caught(), 0);
	assert.equal(t.ambiguous(), 2, "the job is ended");
	assert.equal(t.sink.count("downloads.ambiguous"), 2);
	// Changes to them later change nothing.
	t.onChanged.fire({ id: 2, state: { current: "complete" } });
	await sleep(40);
	assert.deepEqual(t.calls, []);
	assert.equal(t.sink.count("downloads.ambiguous"), 2, "once per download");
	// What the browser itself files under the container is the job's all the same.
	t.create({ id: 3, cookieStoreId: STORE, url: `blob:${JOB_ORIGIN}/third`, state: "complete", exists: true });
	await until(() => !t.items.has(3), { what: "the container's download to go" });
	assert.equal(t.items.size, 2);
	// A blob of a site the operator does not have open is not in doubt.
	const clear = setup({ job: { origins: [JOB_ORIGIN] }, foreign: ["https://news.example"] });
	clear.create({ id: 1, cookieStoreId: "firefox-default", url: BLOB, state: "complete", exists: true });
	await until(() => clear.items.size === 0, { what: "the job's blob to go" });
	assert.equal(clear.world.asked, 1);
	// When the tabs cannot be asked, the answer is "in doubt".
	const blind = setup({ job: { origins: [JOB_ORIGIN] }, foreign: null });
	blind.create({ id: 1, cookieStoreId: "firefox-default", url: BLOB, state: "complete", exists: true });
	await sleep(80);
	assert.deepEqual(blind.calls, []);
	assert.equal(blind.ambiguous(), 1);
});

test("a data: download, or a blob without an origin, is the job's when it follows a download that certainly was", async () => {
	const t = setup({ job: { origins: [JOB_ORIGIN] } });
	const data = "data:application/octet-stream;base64,YmdnIGZpeHR1cmU=";
	// Before anything of the job was caught: nobody's.
	t.create({ id: 1, cookieStoreId: "firefox-default", url: data, state: "complete", exists: true });
	await sleep(60);
	assert.equal(t.items.has(1), true);
	// The job downloads something the browser files correctly.
	t.create({ id: 2, cookieStoreId: STORE, url: `${JOB_ORIGIN}/a.bin`, state: "complete", exists: true });
	await until(() => !t.items.has(2), { what: "the job's download to go" });
	assert.equal(t.caught(), 1);
	await sleep(5);
	// What comes after it, from the same job: its own too, whatever store is named.
	t.create({ id: 3, cookieStoreId: "firefox-default", url: data, state: "complete", exists: true });
	t.create({ id: 4, cookieStoreId: "firefox-default", url: "blob:null/7d54e114", state: "complete", exists: true });
	await until(() => !t.items.has(3) && !t.items.has(4), { what: "the two that followed to go" });
	assert.deepEqual(t.sink.entries.filter((e) => e.event === "downloads.attributed").map((e) => e.fields), [{ by: "after" }, { by: "after" }]);
	// The one from before stays what it was, also when it changes now.
	t.onChanged.fire({ id: 1, state: { current: "complete" } });
	await sleep(60);
	assert.equal(t.items.has(1), true, "created before the job was known to download: not the job's");
	// An ordinary download is never tied to the job this way.
	t.create({ id: 5, cookieStoreId: "firefox-default", url: "https://operator.example/report.pdf", state: "complete", exists: true });
	await sleep(60);
	assert.equal(t.items.has(5), true);
	assert.deepEqual(t.touched("removeFile").sort(), ["removeFile:2", "removeFile:3", "removeFile:4"]);
});

test("a download is looked at again a moment after it was created, and when it changes: what the browser says can come late", async () => {
	const t = setup({ job: { origins: [JOB_ORIGIN] } });
	// Reported without a store at first, with the container's a moment later.
	const late = t.create({ id: 1, url: `${JOB_ORIGIN}/late.bin`, state: "in_progress" });
	late.cookieStoreId = STORE;
	late.state = "complete";
	late.exists = true;
	await until(() => t.items.size === 0, { what: "the late one to be caught on the second look" });
	assert.equal(t.caught(), 1);
	assert.deepEqual(t.calls.slice(0, 1), ["search:1"]);
	// Told only when it changes, long after the second look.
	const later = t.create({ id: 2, url: `${JOB_ORIGIN}/later.bin`, state: "in_progress" });
	await sleep(80);
	assert.equal(t.items.has(2), true);
	later.cookieStoreId = STORE;
	later.state = "complete";
	later.exists = true;
	t.onChanged.fire({ id: 2, state: { current: "complete" } });
	await until(() => t.items.size === 0, { what: "the later one to be caught on its change" });
	assert.equal(t.caught(), 2);
	// A download that is gone by the second look is simply gone.
	t.create({ id: 3, url: "https://operator.example/x", state: "in_progress" });
	t.items.delete(3);
	await sleep(60);
	t.onChanged.fire({ id: 3, state: { current: "complete" } });
	await sleep(20);
	assert.equal(t.caught(), 2);
});

test("a blob that began before the job tab loaded anything from its origin is never the job's, however often it is looked at", async () => {
	// A job is about, on another site so far. The operator saves a blob from a site of their own.
	const t = setup({ job: { origins: ["https://elsewhere.example"] }, foreign: [] });
	t.create({ id: 1, cookieStoreId: "firefox-default", url: BLOB, state: "in_progress" });
	await sleep(5);
	// Now the job tab loads that very site - and the operator's tab on it is closed already.
	t.job.origins.set(JOB_ORIGIN, Date.now());
	const theirs = /** @type {Item} */ (t.items.get(1));
	theirs.state = "complete";
	theirs.exists = true;
	// The second look, and a change, and another.
	await sleep(60);
	t.onChanged.fire({ id: 1, state: { current: "complete" } });
	await sleep(30);
	t.onChanged.fire({ id: 1 });
	await sleep(30);
	assert.equal(t.items.has(1), true, "the operator's file is where it was");
	assert.deepEqual([...new Set(t.calls.map((c) => c.split(":")[0]))], ["search"], "looked at, never touched");
	assert.deepEqual([t.caught(), t.ambiguous()], [0, 0], "and the job goes on: it is not even in doubt");
	assert.equal(t.world.asked, 0);
	// A blob that begins after that moment is the job's.
	await sleep(5);
	t.create({ id: 2, cookieStoreId: "firefox-default", url: `blob:${JOB_ORIGIN}/after`, state: "complete", exists: true });
	await until(() => !t.items.has(2), { what: "the job's own blob to go" });
	assert.equal(t.items.has(1), true);
	assert.equal(t.caught(), 1);
});

test("a blob of another extension is no page's: never the job's, not even after a download that certainly was", async () => {
	const t = setup({ job: { origins: [JOB_ORIGIN], caughtAt: Date.now() - 50 }, foreign: [] });
	t.create({ id: 1, cookieStoreId: "firefox-default", url: "blob:moz-extension://0f8c2a3e-5b1d-4c7a-9e6f-112233445566/7d54e114", state: "complete", exists: true });
	t.create({ id: 2, cookieStoreId: "firefox-default", url: "blob:file:///srv/someone/page.html", state: "complete", exists: true });
	t.create({ id: 3, cookieStoreId: "firefox-default", url: "blob:", state: "complete", exists: true });
	await sleep(100);
	assert.equal(t.items.size, 3);
	assert.deepEqual(t.touched("removeFile").concat(t.touched("cancel"), t.touched("erase")), []);
	assert.deepEqual([t.caught(), t.ambiguous()], [0, 0]);
	// The control: a blob of no origin at all, at the same moment, is taken for the job's.
	t.create({ id: 4, cookieStoreId: "firefox-default", url: "blob:null/7d54e114", state: "complete", exists: true });
	await until(() => !t.items.has(4), { what: "the blob without an origin to go" });
	assert.equal(t.items.size, 3);
});

test("a job tab that closed a moment ago still answers for its downloads; a job long gone does not", async () => {
	const t = setup({ job: { origins: [JOB_ORIGIN] } });
	// The guard decides how long "a moment ago" is; the backstop asks it with its own grace time.
	/** @type {number[]} */
	const asked = [];
	const real = t.job;
	const backstop = new DownloadsBackstop({
		downloads: /** @type {any} */ (t.api),
		storeId: () => STORE,
		onCaught: () => {},
		traces: (graceMs) => {
			asked.push(graceMs);
			return real;
		},
		foreignOrigins: async () => new Set(),
		log: () => {},
	});
	backstop.start();
	real.active = false;
	t.create({ id: 1, cookieStoreId: "firefox-default", url: BLOB, state: "complete", exists: true });
	await sleep(60);
	assert.equal(t.items.has(1), true, "no job about: not touched");
	assert.ok(asked.length >= 1 && asked.every((ms) => ms === 5000), `asked with the grace time: ${asked.join(",")}`);
});

// ---------------------------------------------------------------- a job with the operator's own cookie store

test("a job with the operator's store: a blob of its site is its own only when the operator has that site nowhere open", async () => {
	const t = setup({ job: { origins: ["https://forum.example.com"], login: true }, foreign: ["https://news.example.org"] });
	// The store says nothing here: the job's downloads carry the same one as the operator's.
	t.create({ id: 1, state: "complete", exists: true, cookieStoreId: "firefox-default", url: "blob:https://forum.example.com/0b9c7b7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b" });
	await until(() => !t.items.has(1));
	assert.deepEqual(t.calls.filter((c) => !c.startsWith("search")), ["removeFile:1", "erase:1"]);
	assert.equal(t.caught(), 1);
	assert.deepEqual(t.sink.entries.find((e) => e.event === "downloads.attributed")?.fields, { by: "origin" });
	// The operator has the site open: in doubt, not touched, the job told.
	t.world.foreign = ["https://forum.example.com"];
	t.create({ id: 2, state: "complete", exists: true, cookieStoreId: "firefox-default", url: "blob:https://forum.example.com/1" });
	await until(() => t.ambiguous() === 1);
	await sleep(80);
	assert.deepEqual(t.items.get(2), { id: 2, state: "complete", exists: true, cookieStoreId: "firefox-default", url: "blob:https://forum.example.com/1" });
	assert.deepEqual(t.touched("removeFile:2").concat(t.touched("cancel:2"), t.touched("erase:2")), []);
	// Asking what the operator has open fails: in doubt as well.
	t.world.foreign = null;
	t.create({ id: 3, state: "complete", exists: true, cookieStoreId: "firefox-default", url: "blob:https://forum.example.com/2" });
	await until(() => t.ambiguous() === 2);
	assert.equal(t.items.has(3), true);
});

test("a job with the operator's store: a data: download or a blob of no origin is never taken for the job's - not even after one that was", async () => {
	const t = setup({ job: { origins: ["https://forum.example.com"], login: true } });
	// One that is certainly the job's is caught and removed ...
	t.create({ id: 1, state: "complete", exists: true, cookieStoreId: "firefox-default", url: "blob:https://forum.example.com/1" });
	await until(() => !t.items.has(1));
	assert.ok(t.job.caughtAt !== null);
	// ... and what follows without an origin stays where it is: in the container such a download would be
	// removed, here it may be the operator's own.
	for (const [id, url] of /** @type {[number, string][]} */ ([[2, "data:application/octet-stream;base64,QUJD"], [3, "blob:null/0b9c7b7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b"]])) {
		t.create({ id, state: "complete", exists: true, cookieStoreId: "firefox-default", url });
	}
	await until(() => t.ambiguous() === 2);
	await sleep(80);
	assert.equal(t.items.has(2) && t.items.has(3), true);
	assert.equal(t.items.get(2)?.exists, true);
	assert.deepEqual(t.calls.filter((c) => /^(cancel|removeFile|erase):[23]$/.test(c)), [], "not touched in any way");
	assert.equal(t.sink.count("downloads.ambiguous"), 2);
	assert.equal(t.sink.entries.some((e) => e.event === "downloads.attributed" && e.fields.by === "after"), false);
	// One that began before the job's tab loaded anything is nobody's business at all.
	const early = setup({ job: { origins: ["https://forum.example.com"], login: true } });
	early.job.loginSince = Date.now() + 5000;
	early.create({ id: 9, state: "complete", exists: true, cookieStoreId: "firefox-default", url: "data:text/plain,hello" });
	await sleep(120);
	assert.equal(early.ambiguous(), 0);
	assert.equal(early.items.has(9), true);
});

test("a job with the operator's store: a file from the web that comes from the job's site, or was started by a page of it, is in doubt - left alone, the job ended", async () => {
	const t = setup({ job: { origins: ["https://forum.example.com"], login: true } });
	// By the address of the file, and by the page that started it.
	t.create({ id: 1, state: "complete", exists: true, cookieStoreId: "firefox-default", url: "https://forum.example.com/board/export.html" });
	await until(() => t.ambiguous() === 1);
	t.create({ id: 2, state: "in_progress", exists: false, cookieStoreId: "firefox-default", url: "https://cdn.example.net/big.iso", referrer: "https://forum.example.com/board/thread/1" });
	await until(() => t.ambiguous() === 2);
	await sleep(80);
	assert.deepEqual(t.calls.filter((c) => /^(cancel|removeFile|erase)/.test(c)), [], "neither is cancelled, removed or erased");
	assert.equal(t.items.get(2)?.state, "in_progress", "a running download of that kind runs on");
	assert.equal(t.caught(), 0);
	// The operator's downloads from anywhere else, while the job runs: nobody's business.
	t.create({ id: 3, state: "complete", exists: true, cookieStoreId: "firefox-default", url: "https://downloads.example.org/tool.zip", referrer: "https://downloads.example.org/" });
	t.create({ id: 4, state: "complete", exists: true, cookieStoreId: "firefox-default", url: "https://downloads.example.org/tool.zip" });
	t.create({ id: 5, state: "complete", exists: true, cookieStoreId: "firefox-private", url: "ftp://forum.example.com/x" });
	await sleep(150);
	assert.equal(t.ambiguous(), 2);
	assert.equal([3, 4, 5].every((id) => t.items.get(id)?.exists === true), true);

	// In the container the same two downloads carry the container's store and are removed by that; ones that
	// carry the operator's store are the operator's, whatever site they come from.
	const c = setup({ job: { origins: ["https://forum.example.com"] } });
	c.create({ id: 1, state: "complete", exists: true, cookieStoreId: "firefox-default", url: "https://forum.example.com/board/export.html", referrer: "https://forum.example.com/board/" });
	await sleep(120);
	assert.equal(c.ambiguous(), 0);
	assert.equal(c.items.get(1)?.exists, true);
	assert.deepEqual(c.calls.filter((x) => /^(cancel|removeFile|erase)/.test(x)), []);
});
