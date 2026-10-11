// A gateway window that really is out of sight. Headless Firefox has no
// virtual desktops, but it minimises a window when asked to, and the tabs of a
// minimised window are hidden as those of the operator's are: the document
// says "hidden", its timers are throttled - and a tab that is made there has
// no viewport until the browser lays that window out, which it does less and
// less often the longer the window is out of sight. A job is then read in a
// window of no size: innerWidth and innerHeight are 0, and the root element
// and everything else that takes its size from the window is a box of 0 by 0.
//
// What is read here is a results page laid out against the window, as many
// pages are (tests/fixtures/search/viewport.html): the root element as high as
// the window and clipping, a shell of the window's height around everything.
// No engine is asked; every engine of this run leads to the fixture server.
//
// The extension is not told that the window is hidden (no tuning.forceHidden,
// see hidden.test.js for that): it finds out the way it does in the
// operator's browser. What this cannot show is a window on another virtual
// desktop, or another browser of the family: that stays with the operator
// (tests/manual/WATERFOX-CHECKLIST.md).
//
// Run with: npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./harness.js";

/** The eight results the made-up pages list, in their order. */
const URLS = [
	"https://sqlite.example.org/wal.html",
	"https://docs.example.com/guides/sqlite-wal-mode",
	"https://blog.example.net/2025/11/wal-checkpoint-starvation/",
	"https://forum.example.io/t/wal-on-network-filesystems/5512",
	"https://en.encyclopedia.example/wiki/Write-ahead_logging",
	"https://stack.example.com/questions/1711631/improve-insert-per-second-performance-of-sqlite",
	"https://www.example.edu/~db/notes/recovery.pdf",
	"https://github.example.com/acme/litestream-clone",
];
const TITLES = [
	"Write-Ahead Logging - SQLite",
	"SQLite WAL mode explained: when to use it and when not",
	"Checkpoint starvation in WAL mode, and how we fixed it",
	"Is WAL safe on a network filesystem? - Database forum",
	"Write-ahead logging - Encyclopedia",
	"Improve INSERT-per-second performance of SQLite - Stack Example",
	"Lecture notes on crash recovery (PDF)",
	"acme/litestream-clone: streaming replication for SQLite",
];

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;
let seq = 0;

before(async () => {
	h = await startHarness({
		config: (fx) => ({
			search: {
				default_engine: "duckduckgo",
				engines: {
					// The name the extension has a hint for, as in the operator's browser; and a page with two results only.
					duckduckgo: `http://ddg.localhost:${fx.port}/search/viewport?q={q}`,
					two: `http://two.localhost:${fx.port}/search/two?q={q}`,
				},
			},
		}),
	});
});

after(async () => {
	if (h !== undefined) await h.stop();
});

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} host @param {string} path */
function fx(host, path) {
	seq += 1;
	return h.fixtures.url(host, `${path}${path.includes("?") ? "&" : "?"}n=${seq}`);
}

/** @param {string} url @param {Record<string, unknown>} [extract] @returns {Promise<any>} the job.result as the extension sent it */
async function job(url, extract = {}) {
	const res = await h.submitJob({ kind: "fetch", url, wait: { timeout_ms: 15000, settle_ms: 1500, dwell_ms: 0, scroll: "lazy" }, extract: { text: true, links: true, ...extract } });
	assert.equal(res.status, 200, res.text.slice(0, 300));
	return res.json.result;
}

/** @param {string} engine @returns {Promise<string>} the rendered answer of a search nobody asked before */
async function search(engine) {
	seq += 1;
	const res = await h.daemon.request("POST", "/v1/search", { body: { query: `sqlite wal mode ${seq}`, engine } });
	assert.equal(res.status, 200, res.text.slice(0, 300));
	assert.equal(res.json.isError, false, String(res.json.text).slice(0, 400));
	return String(res.json.text);
}

/** @param {string} state @returns {Promise<void>} what the operator does to the gateway window from the desktop */
async function setWindow(state) {
	const windowId = (await h.hook("windows")).own.windowId;
	assert.equal(typeof windowId, "number", "the gateway window is open");
	assert.deepEqual(await h.hook("window.state", { windowId, state }), { state });
}

/**
 * Run a job and look, while it runs, at the viewport its tab has.
 * @template T
 * @param {Promise<T>} running
 * @returns {Promise<{ value: T, viewport: [number, number] | null }>} viewport: as it was at the last look before the job ended
 */
async function watched(running) {
	let done = false;
	const settled = running.finally(() => {
		done = true;
	});
	settled.catch(() => {});
	/** @type {[number, number] | null} */
	let viewport = null;
	while (!done) {
		try {
			const tabId = (await h.hook("windows")).own.jobTabs[0];
			if (tabId !== undefined) {
				const seen = await h.hook("content.exec", { tabId, code: "[innerWidth, innerHeight]" });
				if (!done && Array.isArray(seen)) viewport = [Number(seen[0]), Number(seen[1])];
			}
		} catch {
			// No page in the tab yet, or the tab is gone already.
		}
		await sleep(50);
	}
	return { value: await settled, viewport };
}

/** @param {string} event @returns {Promise<Record<string, any>[]>} what the extension logged under that name, oldest first */
async function logged(event) {
	return (await h.hook("logs")).filter((/** @type {any} */ l) => l.event === event).map((/** @type {any} */ l) => l.fields);
}

/** @param {string} text a rendered search @returns {string[]} the addresses of its results, in order */
const addresses = (text) => [...text.matchAll(/^\d+\. .*\n {3}(\S+)$/gm)].map((m) => m[1]);

test("in a window that is drawn the page is read as ever; minimised, a job finds its tab hidden and takes the hidden path by itself", async () => {
	const text = await search("duckduckgo");
	assert.match(text.split("\n")[0], /kind=search engine=duckduckgo results=8 /);
	assert.deepEqual(addresses(text), URLS);
	assert.equal((await logged("job.hidden_path")).length, 0);

	await setWindow("minimized");
	const r = await job(fx("a", "/smoke/reveal.html"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.deepEqual({ v: r.render.visibility, scroll: r.render.scroll, px: r.render.scrolled_px }, { v: "hidden", scroll: "skipped_hidden", px: 0 });
	assert.ok(r.content.markdown.includes("REVEAL-INTRO"));
	assert.deepEqual((await logged("job.hidden_path")).map((f) => f.job), [r.job]);
});

test("a page laid out against the window, read in a tab that has no viewport yet: the results of a search and the content of a fetch, as in a window that is drawn", async () => {
	// The longer a window is out of sight the less often the browser lays it out: after a few seconds a new tab
	// mostly stays without a viewport for longer than a job takes.
	await sleep(8000);
	const page = h.fixtures.url("ddg", "/search/viewport");
	let withoutViewport = 0;
	let jobs = 0;
	for (let round = 0; round < 3; round++) {
		const s = await watched(search("duckduckgo"));
		jobs += 1;
		if (s.viewport !== null && (s.viewport[0] === 0 || s.viewport[1] === 0)) withoutViewport += 1;
		const where = `search ${round}, viewport ${JSON.stringify(s.viewport)}`;
		assert.match(s.value.split("\n")[0], /^\[browser-gateway\] outcome=ok kind=search engine=duckduckgo results=8 scope=container status=200$/, where);
		assert.match(s.value, /^fetched_at: \S+ detector=search-hint$/m, where);
		assert.deepEqual(addresses(s.value), URLS, where);
		for (const title of TITLES) assert.ok(s.value.includes(title), `${where}: ${title}`);
		assert.equal(s.value.includes("(the page shows nothing)"), false, where);
		// What the page hides is hidden in a window of any size, and of none.
		assert.equal(/VIEWPORT-HIDDEN|hidden\.example\.net/.test(s.value), false, where);

		const f = await watched(job(`${page}?q=fetch+${round}`, { raw_html: true }));
		jobs += 1;
		if (f.viewport !== null && (f.viewport[0] === 0 || f.viewport[1] === 0)) withoutViewport += 1;
		const r = f.value;
		const at = `fetch ${round}, viewport ${JSON.stringify(f.viewport)}`;
		assert.equal(r.outcome, "ok", `${at}: ${JSON.stringify(r.error)}`);
		assert.equal(r.render.visibility, "hidden", at);
		const shown = String(r.content.text ?? r.content.markdown);
		for (const title of TITLES) assert.ok(shown.includes(title), `${at}: ${title}`);
		assert.ok(shown.includes("sqlite.example.org/wal.html"), `${at}: the address under a result`);
		assert.ok(r.content.links.some((/** @type {any} */ l) => l.url === "https://about.example.org/privacy" && l.text === "Privacy"), `${at}: ${r.content.links.length} links`);
		assert.equal(/VIEWPORT-HIDDEN/.test(`${r.content.markdown}\n${r.content.text}\n${JSON.stringify(r.content.links)}`), false, at);
		assert.ok(r.extraction.hidden_removed >= 2, `${at}: removed ${r.extraction.hidden_removed}`);
		// The page source is the page's own, hidden parts and all.
		assert.ok(r.content.raw_html.includes('<div class="shell">') && r.content.raw_html.includes("VIEWPORT-HIDDEN-PIXEL"), at);
	}
	// Every one of them on the hidden path, and each search read as a list.
	const hidden = (await logged("job.hidden_path")).map((f) => f.job);
	const searched = (await logged("job.searched")).slice(-3);
	assert.deepEqual(searched.map((f) => [hidden.includes(f.job), f.results, f.fallback, f.detector]), [[true, 8, false, "hint"], [true, 8, false, "hint"], [true, 8, false, "hint"]]);
	// Whether the browser withheld the viewport is its own timing: said, not demanded.
	console.log(`minimised window: ${withoutViewport} of ${jobs} jobs were read in a tab without a viewport`);
});

test("a search that falls back to the page, and a file, in the minimised window: the text and the links, and the bytes", async () => {
	const text = await search("two");
	assert.match(text.split("\n")[0], /kind=search engine=two results=2 /);
	assert.match(text, /^fetched_at: \S+ detector=search-fallback$/m);
	assert.match(text, /^note: fewer than 3 results were recognised on the page\./m);
	assert.match(text, /^--- page text \(\d+ of \d+ characters\) ---$/m);
	assert.match(text, /^--- page links \(\d+ of \d+\) ---$/m);
	assert.ok(text.includes("TWO-PAGE"), "the page's own text is in the fallback");
	const last = (await logged("job.searched")).at(-1);
	assert.deepEqual([last?.results, last?.fallback, (await logged("job.hidden_path")).some((f) => f.job === last?.job)], [2, true, true]);

	const { FILES } = await import("../fixtures/server.js");
	const res = await h.daemon.tool("/v1/fetch", { url: fx("files", "/file/report.pdf") });
	assert.equal(res.status, 200, res.text.slice(0, 300));
	assert.equal(res.json.isError, false, String(res.json.text).slice(0, 400));
	assert.match(String(res.json.text), new RegExp(`^file: type=application/pdf size=${FILES.pdf.length} sha256=[0-9a-f]{16}$`, "m"));
	const exported = await h.daemon.request("POST", "/v1/files/export", { body: { file: res.json.page } });
	assert.equal(Buffer.from(exported.json.data, "base64").equals(FILES.pdf), true);
	assert.deepEqual(h.downloads(), []);
});

test("the window is brought back: the next job is read in a tab that is drawn", async () => {
	await setWindow("normal");
	const r = await job(fx("a", "/smoke/reveal.html"));
	assert.equal(r.outcome, "ok", JSON.stringify(r.error));
	assert.deepEqual({ v: r.render.visibility, scroll: r.render.scroll }, { v: "visible", scroll: "done" });
	assert.ok(r.content.markdown.includes("REVEAL-LAZY"), "the walk down the page brought the lazy part in");
	assert.equal((await logged("job.hidden_path")).some((f) => f.job === r.job), false);
});
