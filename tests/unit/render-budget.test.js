// What the sanitiser may cost on the largest text the gateway shows, whatever that text is made of.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FILE_LIMITS } from "../../daemon/src/files.js";

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "helpers", "sanitize-cost.mjs");

// Sanitising runs in the daemon's one thread, on a text a server chose: this long it may hold everything else
// up, at the very most and on a machine that is busy with other tests. An idle one needs a fifth of it.
const MAX_MS = 2500;
// The daemon's unit caps its memory at 1 GiB. All the texts of the helper, one after the other in one process,
// stay below half of that, the process itself included.
const MAX_RSS_MB = 512;

/**
 * @param {number} bytes the size of each text
 * @returns {Promise<{ bytes: number, slowest_ms: number, three_reads_ms: number, max_rss_mb: number, texts: Record<string, { ms: number, chars: number, kept: number }> }>}
 */
function cost(bytes) {
	return new Promise((resolve, reject) => {
		execFile(process.execPath, [HELPER, String(bytes)], { timeout: 50000, maxBuffer: 1048576 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`${err.message}\n${stderr}`));
			else resolve(JSON.parse(stdout));
		});
	});
}

test("the sanitiser stays within its budget of time and memory on the costliest texts of 8 MiB", async () => {
	assert.equal(FILE_LIMITS.maxTextBytes, 8388608);
	const c = await cost(FILE_LIMITS.maxTextBytes);
	assert.equal(c.bytes, 8388608);
	const report = JSON.stringify(c);
	assert.ok(Object.keys(c.texts).length >= 12, report);
	for (const [name, t] of Object.entries(c.texts)) {
		assert.ok(t.chars >= 2000000, `${name}: a text of the full size`);
		assert.ok(t.kept <= t.chars, `${name}: no text gets longer by being sanitised`);
		assert.ok(t.ms <= MAX_MS, `${name} took ${t.ms} ms: ${report}`);
	}
	assert.ok(c.slowest_ms <= MAX_MS, report);
	// A file fetched and then read on twice, decoded and rendered each time.
	assert.ok(c.three_reads_ms <= MAX_MS, report);
	assert.ok(c.max_rss_mb <= MAX_RSS_MB, `peak memory ${c.max_rss_mb} MB: ${report}`);
});
