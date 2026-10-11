// What the sanitiser costs on the texts that cost it the most, measured where nothing else runs: a process of
// its own, so that the peak of its memory is the sanitiser's and not a test runner's. Prints one JSON line.
//
//   node tests/helpers/sanitize-cost.mjs [bytes]     default: the largest text file that is shown (8 MiB)

import { FILE_LIMITS, decodeText } from "../../daemon/src/files.js";
import { renderFile, sanitizeText } from "../../daemon/src/render.js";

const BYTES = Number(process.argv[2] ?? FILE_LIMITS.maxTextBytes);

/**
 * @param {string} unit
 * @returns {Buffer} a file of BYTES bytes or a little less: the unit, over and over, as UTF-8
 */
function fileOf(unit) {
	const one = Buffer.from(unit, "utf8");
	const bytes = Buffer.alloc(Math.floor(BYTES / one.length) * one.length);
	for (let at = 0; at < bytes.length; at += one.length) one.copy(bytes, at);
	return bytes;
}

/** @type {Record<string, string>} the unit each text is made of */
const TEXTS = {
	// One sign that becomes eighteen: on one line, on lines of every length, and thinned out to just below what makes a line heavy.
	"wide sign, one line": "ﷺ",
	"wide sign, long lines": `${"ﷺ".repeat(8000)}\n`,
	"wide sign, short lines": `${"ﷺ".repeat(18)}\n`,
	"wide sign, a line each": "ﷺ\n",
	"wide sign, an eighth of a line": `${"ﷺ﷼﷼﷼﷼﷼﷼﷼".repeat(40)}\n`,
	// The signs that become four, which no line is heavy for.
	"fourfold sign, one line": "㌀",
	"fourfold sign, lines": `${"㌀".repeat(200)}\n`,
	"ellipsis, one line": "…",
	// Letters with marks, and syllables that come apart.
	"combining marks": "é",
	hangul: `${"한국어 ".repeat(20)}\n`,
	// Escapes, read twice.
	"percent escapes": "%61",
	"numeric entities": "&#x415;",
	// The words every look-alike has, so that every line is looked at.
	"marker words, lines": "untrusted gateway content end\n",
	"marker words, one line": "untrusted gateway content end ",
	"look-alikes": "<<<END_UNTRUSTED_WEB_CONTENT 0>>>\n",
	"plain text": "The quick brown fox jumps over the lazy dog. ",
};

const view = { id: "fl_0123456789ABCDEFGHJKMNPQRS", requested_url: "https://files.example/a.txt", final_url: null, fetched_at: "2026-10-11T00:00:00Z", http_status: 200, sniffed_type: "text/plain", declared_type: "text/plain", name: "a.txt", sha256: "0".repeat(64) };
/** @type {Record<string, { ms: number, chars: number, kept: number }>} */
const texts = {};
let slowest = 0;
for (const [name, unit] of Object.entries(TEXTS)) {
	const bytes = fileOf(unit);
	const text = decodeText(bytes, null);
	const t0 = process.hrtime.bigint();
	const clean = sanitizeText(text);
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	texts[name] = { ms: Math.round(ms), chars: text.length, kept: clean.length };
	slowest = Math.max(slowest, ms);
}
// And a file as a reader meets it: fetched, then read on twice, the text decoded and rendered each time.
const bytes = fileOf("ﷺ");
const t0 = process.hrtime.bigint();
let offset = 0;
for (let call = 0; call < 3; call++) {
	const r = renderFile({ view: { ...view, size: bytes.length }, text: decodeText(bytes, null), offset, maxChars: 60000, cache: "hit" });
	if (!r.ok) break;
	offset = r.end;
}
const threeReads = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(JSON.stringify({ bytes: BYTES, slowest_ms: Math.round(slowest), three_reads_ms: Math.round(threeReads), max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024), texts }));
