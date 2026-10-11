import { FakeClock } from "./fake-clock.js";
import { makeTempDir, removeTempDir } from "./tmp.js";
import { PageStore } from "../../daemon/src/store.js";
import { zeroTimings } from "../../extension/shared/protocol.js";

/**
 * @typedef {import("../../daemon/src/store.js").PageRecord} PageRecord
 */

/** @returns {import("../../daemon/src/log.js").Logger & { events: string[] }} a logger that records warnings and errors */
export function quietLog() {
	/** @type {string[]} */
	const events = [];
	return Object.assign(
		{
			info: () => {},
			warn: (/** @type {string} */ e) => void events.push(e),
			error: (/** @type {string} */ e) => void events.push(e),
		},
		{ events },
	);
}

/**
 * Different bytes on every call, so every page id differs.
 * @param {number} [seed]
 * @returns {(n: number) => Uint8Array}
 */
export function counterBytes(seed = 1) {
	let c = seed;
	return (n) => {
		c++;
		const out = new Uint8Array(n);
		for (let i = 0; i < n; i++) out[i] = (c * 37 + i * 11 + (c >> 8) * 5) & 255;
		return out;
	};
}

/** @param {Partial<PageRecord>} [over] @returns {PageRecord} */
export function makeRecord(over = {}) {
	return {
		url: "https://example.com/a",
		final_url: "https://example.com/article/a",
		http_status: 200,
		title: "Example article",
		author: "A. Writer",
		published: "2026-10-01",
		lang: "en",
		site: "Example",
		word_count: 5,
		extractor: "defuddle@0.19.4",
		cookie_scope: "container",
		outcome: "ok",
		redirect_origins: ["https://example.com"],
		render: { visibility: "visible", raf_hz: 60, settled: true, scrolled_px: 0, scroll: "off", dwell: "off", elapsed_ms: 120, timings: zeroTimings() },
		truncated: { markdown: false, text: false, html: false, raw_html: false },
		markdown: "# Example article\n\nThe quick brown fox is running over the lazy dog.",
		html: "<html><body><p>The quick brown fox</p></body></html>",
		links: [{ url: "https://example.com/next", text: "Next page" }],
		...over,
	};
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{ randomBytes?: (n: number) => Uint8Array }} [opts]
 */
export function openStore(t, opts = {}) {
	const dir = makeTempDir("store");
	const clock = new FakeClock(Date.UTC(2026, 9, 5, 19, 44, 2));
	const log = quietLog();
	const store = new PageStore({ dataDir: dir, clock, log, randomBytes: opts.randomBytes ?? counterBytes() });
	t.after(() => {
		store.close();
		removeTempDir(dir);
	});
	return { dir, clock, log, store };
}
