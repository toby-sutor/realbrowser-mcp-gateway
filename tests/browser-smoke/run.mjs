#!/usr/bin/env node
// Real-browser smoke test for extension/content/extract.js with the
// vendored Defuddle bundle, and for extension/content/search.js on results
// pages made up for it (tests/fixtures/search - no engine's own markup, and no
// engine is ever asked). Chromium is only the engine here; Firefox coverage
// comes from another harness.
//
//   node tests/browser-smoke/run.mjs [--show] [--only=name,name]      exit 0 when every check passes
//
// Env: BGW_SCRATCH (scratch parent, default os tmpdir), CHROMIUM (binary).
// Fixtures are served from an ephemeral 127.0.0.1 port so that links resolve to
// http(s); all other hosts are unresolvable inside the browser.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DIRECTION, LIMITS, MSG, makeMessage, validateMessage, zeroTimings } from "../../extension/shared/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const VENDOR = join(repo, "extension/vendor/defuddle.full.js");
const EXTRACT = join(repo, "extension/content/extract.js");
const SEARCH = join(repo, "extension/content/search.js");
const SEARCH_FIXTURES = join(repo, "tests/fixtures/search");
const LOCK = JSON.parse(readFileSync(join(repo, "extension/vendor/VENDOR.lock.json"), "utf8"));
const SHOW = process.argv.includes("--show");
// Fixtures to run, by file name without the ending; all of them when not given.
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter((n) => n !== "");
const CHROMIUM = process.env.CHROMIUM ?? "chromium";

const DRIVER = `
(() => {
	const net = [];
	const rec = (n) => net.push(n);
	const w = window;
	const of = w.fetch; w.fetch = function () { rec("fetch"); return of.apply(this, arguments); };
	const ox = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function () { rec("xhr"); return ox.apply(this, arguments); };
	if (navigator.sendBeacon) { const ob = navigator.sendBeacon; navigator.sendBeacon = function () { rec("beacon"); return ob.apply(this, arguments); }; }
	const OW = w.WebSocket; w.WebSocket = function () { rec("websocket"); return new OW(...arguments); };
	const OI = w.Image; w.Image = function () { rec("image"); return new OI(...arguments); };
	const res0 = performance.getEntriesByType("resource").length;
	const out = { live: { scriptRan: w.__live_script_ran === true }, runs: {}, notes: {} };
	const obs = new MutationObserver(() => {});
	obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	const before = document.documentElement.outerHTML;
	const full = { markdown: true, text: true, html: true, links: true, maxMarkdownChars: 8388608, maxTextChars: 8388608, maxHtmlChars: 8388608, maxLinks: 5000 };
	out.runs.full = __bgwExtract(full);
	out.runs.small = __bgwExtract({ markdown: true, text: true, html: true, links: true, maxMarkdownChars: 50, maxTextChars: 70, maxHtmlChars: 60, maxLinks: 2 });
	out.runs.off = __bgwExtract({ markdown: false, text: false, html: false, links: false, maxMarkdownChars: 8388608, maxTextChars: 8388608, maxHtmlChars: 8388608, maxLinks: 5000 });
	out.runs.textOnly = __bgwExtract({ ...full, markdown: false, html: false, links: false });
	out.runs.fullAgain = __bgwExtract(full);
	out.runs.capped = __bgwExtract({ ...full, maxElements: 3 });
	out.runs.raw = __bgwExtract({ ...full, rawHtml: true, maxRawHtmlChars: 4194304 });
	out.runs.rawSmall = __bgwExtract({ ...full, rawHtml: true, maxRawHtmlChars: 40 });
	out.notes.before = before;
	out.notes.viewport = [innerWidth, innerHeight];
	out.notes.host = location.hostname;
	out.notes.doctype = document.doctype === null ? null : document.doctype.name;
	// Where the bundle put itself, and what a fixture tried by itself before this ran.
	out.notes.bundle = typeof w.Defuddle;
	out.notes.fixture = w.__bgwFixtureNotes ?? null;
	out.runs.plain = __bgwExtract({ ...full, defuddle: false });
	out.notes.mutations = obs.takeRecords().length;
	out.notes.domUnchanged = document.documentElement.outerHTML === before;
	let bad = 0, tried = 0;
	for (let cap = 1; cap <= 400; cap++) {
		const r = __bgwExtract({ markdown: true, text: true, html: true, rawHtml: true, links: false, maxMarkdownChars: cap, maxTextChars: cap, maxHtmlChars: cap, maxRawHtmlChars: cap });
		for (const s of [r.content.markdown, r.content.text, r.content.html, r.content.raw_html]) {
			if (s === null) continue;
			tried++;
			if (s.length > cap || /[\\ud800-\\udbff]$/.test(s) || /^[\\udc00-\\udfff]/.test(s)) bad++;
		}
	}
	out.notes.surrogateTried = tried; out.notes.surrogateBad = bad;
	out.notes.domUnchanged = out.notes.domUnchanged && document.documentElement.outerHTML === before && obs.takeRecords().length === 0;
	setTimeout(() => {
		out.notes.netCalls = net;
		out.notes.newResources = performance.getEntriesByType("resource").length - res0;
		const bytes = new TextEncoder().encode(JSON.stringify(out));
		let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
		// Into the document that is dumped: the page's own, or the one around its frame.
		const d = top.document.createElement("div");
		d.id = "bgw-out"; d.setAttribute("data-b64", btoa(bin));
		top.document.body.appendChild(d);
	}, 600);
})();
`;

// What runs in a results page: the general look, every engine's hints in turn, a small limit.
const SEARCH_DRIVER = `
(() => {
	const net = [];
	const rec = (n) => net.push(n);
	const w = window;
	const of = w.fetch; w.fetch = function () { rec("fetch"); return of.apply(this, arguments); };
	const ox = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function () { rec("xhr"); return ox.apply(this, arguments); };
	const OI = w.Image; w.Image = function () { rec("image"); return new OI(...arguments); };
	const out = { runs: {}, notes: {} };
	const obs = new MutationObserver(() => {});
	obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	const before = document.documentElement.outerHTML;
	out.runs.generic = __bgwSearch({ limit: 20, hint: -1 });
	for (let i = 0; i < 5; i++) out.runs["hint" + i] = __bgwSearch({ limit: 20, hint: i });
	out.runs.three = __bgwSearch({ limit: 3, hint: -1 });
	out.runs.odd = __bgwSearch({ limit: 1e9, hint: 99 });
	out.runs.none = __bgwSearch();
	// What the job runner reads where no list was found: the text and the links of the page.
	const plain = __bgwExtract({ markdown: false, text: true, html: false, links: true, defuddle: false });
	out.fallback = { ok: plain.ok, text: plain.content.text, links: plain.content.links, removed: plain.extraction.hidden_removed };
	out.notes.viewport = [innerWidth, innerHeight];
	out.notes.hints = __bgwSearch.internals.HINTS.map((h) => h.name);
	out.notes.globals = Object.keys(window).filter((k) => k.startsWith("__bgw"));
	out.notes.mutations = obs.takeRecords().length;
	out.notes.domUnchanged = document.documentElement.outerHTML === before;
	setTimeout(() => {
		out.notes.netCalls = net;
		const bytes = new TextEncoder().encode(JSON.stringify(out));
		let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
		// Into the document that is dumped: the page's own, or the one around its frame.
		const d = top.document.createElement("div");
		d.id = "bgw-out"; d.setAttribute("data-b64", btoa(bin));
		top.document.body.appendChild(d);
	}, 300);
})();
`;

// Two pages are run a second time in a frame of no size: what a tab has for a viewport while its window is
// not drawn (measured in Firefox 156 with a minimised window: innerWidth and innerHeight 0, the root element
// a box of 0 by 0). A results page laid out against the window, and the hidden-text probes.
const NO_SIZE_PAGE = "viewport";
const NO_SIZE_PROBES = "probes";
// Two pages are served under a host name of their own, which the browser is told to look up here: the
// bundle's site extractors go by the name of the host. One is made like a page of a site the bundle knows
// and is read under that site's name and under a name that only contains it; the other is read under a name
// that contains the name of a site whose extractor takes its content from a script.
const SITE = "news.ycombinator.com";
const SITE_LOOKALIKE = "news.ycombinator.com.attacker.example";
const OTHER_LOOKALIKE = "nytimes.com.attacker.example";
const NAMED_HOSTS = [SITE, SITE_LOOKALIKE, OTHER_LOOKALIKE];
/** @type {Record<string, { name: string, host?: string, noSize?: boolean }[]>} the runs of a fixture that has more than the plain one */
const RUNS = {
	[NO_SIZE_PROBES]: [{ name: NO_SIZE_PROBES }, { name: `${NO_SIZE_PROBES}-nosize`, noSize: true }],
	sitereal: [{ name: "sitereal", host: SITE }, { name: "sitereal-elsewhere", host: SITE_LOOKALIKE }],
	sitefake: [{ name: "sitefake", host: OTHER_LOOKALIKE }],
};

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const gaps = [];
let passes = 0;
/**
 * Something the extractor does not do yet. Reported, not counted as a failure;
 * the day it starts to hold the run says so.
 * @param {string} fixture @param {string} name @param {unknown} cond @param {unknown} [detail]
 */
function knownGap(fixture, name, cond, detail) {
	if (cond) gaps.push(`[${fixture}] ${name} -- holds now: make it a check`);
	else gaps.push(`[${fixture}] ${name}${detail === undefined ? "" : ` -- ${String(JSON.stringify(detail)).slice(0, 200)}`}`);
}
/** @param {string} fixture @param {string} name @param {unknown} cond @param {unknown} [detail] */
function check(fixture, name, cond, detail) {
	if (cond) {
		passes++;
		return;
	}
	const d = detail === undefined ? "" : ` -- ${String(JSON.stringify(detail)).slice(0, 300)}`;
	failures.push(`[${fixture}] ${name}${d}`);
}

/** @param {string} page @param {number} port */
function buildPage(page, port) {
	// Absolute URLs: a fixture may carry its own <base href>.
	const o = `http://127.0.0.1:${port}`;
	// Into the head, and run once the body is parsed: script elements inside
	// the body change which element Defuddle takes for the content (with the
	// driver at the end of the body the forum fixture came out as the whole
	// page instead of its first post, which no real visit ever would).
	const tags =
		`<script src="${o}/__bgw/defuddle.full.js"></script>` +
		`<script src="${o}/__bgw/extract.js"></script>` +
		`<script>addEventListener("DOMContentLoaded", () => {${DRIVER}});</script>`;
	const i = page.indexOf("</head>");
	if (i < 0) throw new Error("a fixture needs a head");
	return page.slice(0, i) + tags + page.slice(i);
}

/** @param {string} page a results page @param {number} port */
function buildSearchPage(page, port) {
	const o = `http://127.0.0.1:${port}`;
	const tags = `<script src="${o}/__bgw/extract.js"></script><script src="${o}/__bgw/search.js"></script><script>addEventListener("DOMContentLoaded", () => {${SEARCH_DRIVER}});</script>`;
	const i = page.indexOf("</head>");
	if (i < 0) throw new Error("a fixture needs a head");
	return page.slice(0, i) + tags + page.slice(i);
}

/** @param {string} url @param {string} profile @returns {Promise<string>} */
function runChromium(url, profile) {
	return new Promise((res, rej) => {
		const args = [
			"--headless",
			"--no-sandbox",
			"--disable-gpu",
			"--dump-dom",
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--disable-extensions",
			"--virtual-time-budget=5000",
			`--host-resolver-rules=${NAMED_HOSTS.map((h) => `MAP ${h} 127.0.0.1 , `).join("")}MAP * ~NOTFOUND , EXCLUDE 127.0.0.1`,
			url,
		];
		const child = spawn(CHROMIUM, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
		child.on("error", rej);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) res(out);
			else rej(new Error(`chromium exit ${code}: ${err.slice(-400)}`));
		});
	});
}

/** @param {string} dom */
function parseOut(dom) {
	const m = dom.match(/id="bgw-out"[^>]*data-b64="([A-Za-z0-9+/=]+)"/) ?? dom.match(/data-b64="([A-Za-z0-9+/=]+)"[^>]*id="bgw-out"/);
	if (!m) return null;
	return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
}

/** Wrap an extractor output as the job.result the daemon would validate. */
function asJobResult(/** @type {any} */ r, /** @type {string} */ url) {
	return makeMessage(MSG.JOB_RESULT, {
		job: "smoke",
		outcome: "ok",
		cookie_scope: null,
		nav: { requested_url: url, final_url: url, redirect_origins: [], http_status: 200, content_type: "text/html", body_bytes: null },
		render: { visibility: null, raf_hz: null, settled: true, scrolled_px: 0, scroll: "off", dwell: "off", elapsed_ms: 0, timings: zeroTimings() },
		detect: null,
		error: null,
		file: null,
		page: r.page,
		extraction: r.extraction,
		content: {
			markdown: r.content.markdown,
			text: r.content.text,
			html: r.content.html,
			raw_html: r.content.raw_html,
			links: r.content.links,
			results: [],
		},
		truncated: r.truncated,
		tab_kept_open: false,
	});
}

// The hidden-text probes (fixtures/probes.html) by name: what hides text, its relatives, and what merely looks like it.
const PROBES_FIRST = ["DISPLAY", "VISIBILITY", "FONTZERO", "SCALE3D", "OPACITYZERO", "OFFLEFT", "ATTR"];
const PROBES_LATER = ["TRANSPARENT", "SAMECOLOUR", "SAMECOLOURBOX", "ALPHAZERO", "FONTONE", "OPACITYLOW", "FILTER", "MASK", "CLIPPOLYGON", "CLIPINSET", "ROTATEY", "ROTATEX", "FARRIGHT", "FARBOTTOM", "SRONLY", "ZEROWIDTH", "INDENT"];
// Twenty-six more, each a small change to one of the first twenty-five: a box folded to nothing, a box just
// beside the page, a colour in another notation or next to the one behind it, a shadow or an outline that shows
// nothing, a filter, a shape.
const PROBES_MORE = [
	"ZEROHEIGHT", "MAXHEIGHT", "NOWIDTH", "NEARLEFT", "NEARTOP", "SHIFTED", "SCALETINY", "SCALEPROPTINY", "COLORFN", "OKLCH", "LAB", "SHADOWCLEAR", "STROKESAME", "CLIPTEXT", "WHITEWASH",
	"NEARCOLOUR", "ALPHA98", "BLUR", "INVERT", "MASKURL", "CLIPPOINT", "CLIPURL", "CLIPXYWH", "CLIPRECT", "FONTTWO", "OPACITY12",
];
const PROBES_ALL = [...PROBES_FIRST, ...PROBES_LATER, "OVERLAY", ...PROBES_MORE];
// The ones that are left in, in a window that is drawn: text under something opaque (telling an overlay from a
// dialog, a banner or a sticky header takes more than the computed style, and a wrong guess would drop what is
// under those), and text behind a mask that is a picture (which is not looked into; an element is given a
// picture as a mask to shape it far more often than to hide it).
const PROBES_LEFT = ["MASKURL", "OVERLAY"];
// In a frame of no size four more are left in: what can only be told by the size of a box that takes it from the
// window. A box of no height or no width that cuts off what is in it (in a block and in a line), and a shape
// that leaves a sliver of a box. Where the style itself says "no higher than nothing" (max-height) that is
// told in any window.
const PROBES_LEFT_NO_SIZE = ["CLIPINSET", "MASKURL", "NOWIDTH", "OVERLAY", "ZEROHEIGHT", "ZEROWIDTH"];
const PROBE_RELATIVES = ["FIXEDRIGHT", "INDENTCLIP", "NESTEDOPACITY", "ALPHALOW", "SCALEPROP", "MARGIN"];
const PROBE_VISIBLE = [
	"PLAIN", "DETAILS", "DETAILSCODE", "TABPANEL", "MENU", "LOWCONTRAST", "GRADIENT", "HERO", "DARKBOX", "PSEUDO", "SLIDEONE", "SLIDEFIVE", "STICKY", "WIDECELL", "FOLDED", "SHADOW", "HALF", "TIP",
	"SMALL", "HANGING", "PANEL", "ACCORDION", "REGION", "GRIDROW", "DRAWER", "SIDENAV", "DUSK", "DAWN", "NIGHT", "OKLCH", "LAB", "LIGHTGREY", "TINYPRINT", "HALFSIZE", "TEASER", "OUTLINE", "GLOW",
	"ROUNDED", "ONELINE", "BACKDROP", "NEGATIVE", "NEGATIVESPAN", "CELL", "END",
];

/**
 * The probes in a frame of no size. What is told by the style alone, by where a box lies or by a size the box
 * has of its own is left out as in a window. What can only be told by the size of a box that takes it from the
 * window cannot be told there: such text stays in, and the page is not emptied for it.
 * @param {(n: string, ok: unknown, d?: unknown) => void} c @param {any} o
 */
function probesWithoutSize(c, o) {
	const r = o.runs.full;
	const all = `${r.content.markdown}\n${r.content.text}\n${r.content.html}\n${JSON.stringify(r.content.links)}\n${JSON.stringify(r.page)}`;
	const survivors = PROBES_ALL.filter((name) => new RegExp(`PROBEHID-${name}\\b`).test(all)).sort();
	c("of the 51 probes six survive: the two that do in a window, and four that are told by the size of a box", JSON.stringify(survivors) === JSON.stringify(PROBES_LEFT_NO_SIZE), survivors);
	const relatives = PROBE_RELATIVES.filter((name) => all.includes(`PROBEHIDX-${name}`));
	c("of the six relatives one survives: a first line pushed out of a box of no width", JSON.stringify(relatives) === JSON.stringify(["INDENTCLIP"]), relatives);
	c("the box of one pixel is left out as ever: it has its size in any window", !/PROBEHID-SRONLY\b/.test(all));
	const missing = PROBE_VISIBLE.filter((name) => !r.content.text.includes(`PROBEVIS-${name}`));
	c("every visible control but one is in the visible text: white letters over a picture that has no size yet are taken for white on white", JSON.stringify(missing) === JSON.stringify(["HERO"]), missing);
	c("removed pieces counted", r.stats.hidden_removed >= 50, r.stats);
}

/** @type {Record<string, (c: (n: string, ok: unknown, d?: unknown) => void, o: any) => void>} */
const EXPECT = {
	article(c, o) {
		const r = o.runs.full;
		const md = r.content.markdown;
		c("main text in markdown", md.includes("ZEBRACORP-MAIN"), md.slice(0, 200));
		c("markdown has h2 headings", /^#{2,3} What the vote means/m.test(md), md.slice(0, 400));
		c("markdown has inline link", md.includes("[published transit plan](https://transit.example.org/quayside-plan)"));
		c("nav clutter absent", !md.includes("NAV-CLUTTER"));
		c("sidebar clutter absent", !md.includes("SIDEBAR-CLUTTER"));
		c("footer clutter absent", !md.includes("FOOTER-CLUTTER"));
		c("comments absent", !md.includes("COMMENT-CLUTTER"));
		c("clutter absent from html too", !/NAV-CLUTTER|SIDEBAR-CLUTTER|FOOTER-CLUTTER/.test(r.content.html));
		c("title", /Quayside tram extension/.test(r.page.title || ""), r.page.title);
		c("author", r.page.author === "Marta Okonkwo", r.page.author);
		c("published parses", /^2026-03-14/.test(r.page.published || ""), r.page.published);
		c("lang", r.page.lang === "en", r.page.lang);
		c("site", r.page.site === "The Example Courier", r.page.site);
		c("word_count sensible", r.page.word_count > 100 && r.page.word_count < 400, r.page.word_count);
		c("extractor name", r.page.extractor === `defuddle@${LOCK.version}`, r.page.extractor);
		// The article view stands, with the share of the page it holds; the rest is in the visible text.
		c("article view, with its share of the visible text", r.extraction.view === "article" && r.extraction.coverage_pct >= 50 && r.extraction.coverage_pct < 100, r.extraction);
		c("the visible text is the whole page: article and what is around it", r.content.text.includes("ZEBRACORP-MAIN") && ["NAV-CLUTTER", "SIDEBAR-CLUTTER", "COMMENT-CLUTTER", "FOOTER-CLUTTER"].every((x) => r.content.text.includes(x)), r.content.text.slice(0, 200));
		c("the visible text has no markup and no hidden element's text", !/<[a-z]/i.test(r.content.text) && !r.content.text.includes("display:none"), r.content.text.slice(0, 200));
		c("links include transit plan", r.content.links.some((/** @type {any} */ l) => l.url === "https://transit.example.org/quayside-plan" && l.text === "published transit plan"), r.content.links);
		c("relative link resolved against page", r.content.links.some((/** @type {any} */ l) => /^http:\/\/127\.0\.0\.1:\d+\/documents\/budget-2026\.pdf$/.test(l.url)), r.content.links);
		c("lazy image url promoted or dropped, no data: in html", !/src="data:/.test(r.content.html));
	},
	forum(c, o) {
		const r = o.runs.full;
		const md = r.content.markdown;
		const text = r.content.text;
		c("op text present", md.includes("FORUMOP-MAIN"));
		// Defuddle takes the first post for the content of this thread. That view holds well under half of
		// what the page shows, so the Markdown is made from the whole page instead.
		c("replies present in the markdown", md.includes("FORUMREPLY-MAIN") && md.includes("FORUMREPLY2-MAIN"), md.slice(-200));
		c("replies present in the visible text", text.includes("FORUMREPLY-MAIN") && text.includes("FORUMREPLY2-MAIN"), text.slice(-200));
		c("the view is the full page, and the extractor's name says so", r.extraction.view === "full_page" && r.page.extractor === `defuddle@${LOCK.version}+fullpage`, [r.extraction, r.page.extractor]);
		c("coverage of the article view reported, below the threshold", Number.isInteger(r.extraction.coverage_pct) && r.extraction.coverage_pct > 10 && r.extraction.coverage_pct < 50, r.extraction);
		c("posts in page order, with their authors", md.search(/quokka\\?_dev/) >= 0 && md.search(/quokka\\?_dev/) < md.indexOf("FORUMOP-MAIN") && md.indexOf("FORUMOP-MAIN") < md.indexOf("fennec42") && md.indexOf("fennec42") < md.indexOf("FORUMREPLY-MAIN") && md.indexOf("FORUMREPLY-MAIN") < md.indexOf("FORUMREPLY2-MAIN"), md);
		c("the full page is the full page: what is around the thread is there too", /TOPBAR-CLUTTER/.test(md) && /FOOTER-CLUTTER/.test(md), md);
		c("markdown is Markdown: heading and links converted", /^#{1,2} Best way to cache SQLite queries\?$/m.test(md) || md.includes("Best way to cache SQLite queries?"), md.slice(0, 300));
		c("markdown link", md.includes("[the pragma docs](https://www.sqlite.org/pragma.html)"), md);
		c("relative link made absolute", /\[tuning thread\]\(http:\/\/127\.0\.0\.1:\d+\/t\/9981-sqlite-tuning\)/.test(md), md);
		c("emoji survive", md.includes("\u{1F600}\u{1F680}\u{1F4A1}") && text.includes("\u{1F600}"));
		c("html is that of the full page, scrubbed", r.content.html.includes("FORUMREPLY2-MAIN") && !/<(script|style|iframe|form)\b|\son[a-z]+=/i.test(r.content.html), r.content.html.slice(0, 300));
		c("links of the whole page", r.content.links.some((/** @type {any} */ l) => l.url === "https://www.sqlite.org/pragma.html" && l.text === "the pragma docs") && r.content.links.some((/** @type {any} */ l) => /\/t\/9981-sqlite-tuning$/.test(l.url)), r.content.links);
		c("title", /Best way to cache SQLite queries/.test(r.page.title || ""), r.page.title);
		c("site", r.page.site === "Dev Forum", r.page.site);
		c("published is null when absent", r.page.published === null, r.page.published);
		c("word count is that of the visible text", r.page.word_count > 120 && r.page.word_count < 220, r.page.word_count);
		// Without Defuddle there is no article view to fall short: the visible text, replies and all.
		c("plain run: all posts", o.runs.plain.content.markdown.includes("FORUMREPLY2-MAIN") && o.runs.plain.extraction.view === "text" && o.runs.plain.extraction.coverage_pct === null, o.runs.plain.extraction);
		// What the page keeps for a browser without scripts is one piece of text in this one. Parsed again it
		// would be elements, and the second half of it would close the thread and stand outside the noscript.
		const all = `${md}\n${text}\n${r.content.html}\n${JSON.stringify(r.content.links)}\n${o.runs.plain.content.markdown}\n${o.runs.plain.content.html}`;
		c("nothing of a noscript element in any view of the full page", !/FORUMNOSCRIPT|attacker\.example/.test(all) && !/<noscript/i.test(r.content.html), all.slice(Math.max(0, all.indexOf("FORUMNOSCRIPT") - 80), all.indexOf("FORUMNOSCRIPT") + 80));
	},
	store(c, o) {
		const r = o.runs.full;
		const all = `${r.content.markdown}\n${r.content.text}\n${r.content.html}\n${JSON.stringify(r.content.links)}\n${JSON.stringify(r.page)}`;
		// An attribute and two scripts that extractors of the bundle would take the whole content from, on a host that is no site of theirs.
		c("the article is what the page shows", r.content.markdown.includes("STOREVIS-MAIN") && r.content.markdown.includes("STOREVIS-END") && r.extraction.view === "article", [r.extraction, r.content.markdown.slice(0, 200)]);
		c("nothing of the attribute or the scripts anywhere, the title included", !/STOREHID|attacker\.example/.test(all), all.slice(Math.max(0, all.search(/STOREHID/) - 60), all.search(/STOREHID/) + 100));
		c("no site extractor ran: the general one did", r.page.extractor === `defuddle@${LOCK.version}` && r.page.title === "How tea is made", r.page);
		c("nothing was hidden by a style, so nothing is counted", r.stats.hidden_removed === 0, r.stats);
	},
	sitefake(c, o) {
		const r = o.runs.full;
		const all = `${r.content.markdown}\n${r.content.text}\n${r.content.html}\n${JSON.stringify(r.page)}`;
		c("read under a host name that only contains the name of a site", o.notes.host === OTHER_LOOKALIKE, o.notes.host);
		c("the article is what the page shows", r.content.markdown.includes("FAKEVIS-MAIN") && r.content.markdown.includes("FAKEVIS-END") && r.extraction.view === "article", [r.extraction, r.content.markdown.slice(0, 200)]);
		c("nothing of the script the site's extractor reads: no text, no title, no author", !/FAKEHID|attacker\.example\./.test(all.replaceAll(OTHER_LOOKALIKE, "")), all.slice(Math.max(0, all.search(/FAKEHID/) - 60), all.search(/FAKEHID/) + 100));
		c("no site extractor ran", r.page.extractor === `defuddle@${LOCK.version}` && r.page.title === "The harbour ferry returns" && r.page.author === null, r.page);
	},
	sitereal(c, o) {
		const r = o.runs.full;
		const md = r.content.markdown;
		// On the site itself the bundle's extractor for it does the work: the post and the thread under it, without the page around them.
		c("read under the site's own host name", o.notes.host === SITE, o.notes.host);
		c("the site's extractor ran, and the article view stands whatever share of the page it is", new RegExp(`^defuddle@${LOCK.version.replaceAll(".", "\\.")}\\+[a-z]+$`).test(r.page.extractor) && !r.page.extractor.endsWith("+fullpage") && r.extraction.view === "article", [r.page.extractor, r.extraction]);
		c("post and comments, in order", md.includes("SITE-POST") && md.indexOf("SITE-POST") < md.indexOf("SITE-COMMENT-ONE") && md.indexOf("SITE-COMMENT-ONE") < md.indexOf("SITE-COMMENT-TWO"), md);
		c("the page around the thread is not in the article", !/SITE-TOPBAR|SITE-FOOTER/.test(md), md);
		c("what the extractor knows about the page: title, author, date", /Keeping bees in a city/.test(r.page.title || "") && r.page.author === "apis" && /^2026-03-14/.test(r.page.published || ""), r.page);
		c("the visible text is the whole page all the same", ["SITE-TOPBAR", "SITE-POST", "SITE-COMMENT-TWO", "SITE-FOOTER"].every((x) => r.content.text.includes(x)), r.content.text.slice(0, 200));
	},
	"sitereal-elsewhere"(c, o) {
		const r = o.runs.full;
		// The same page under a host name that has the site's name in it and is not the site: an ordinary page.
		c("read under a host name that only contains the site's", o.notes.host === SITE_LOOKALIKE, o.notes.host);
		c("no site extractor ran", [`defuddle@${LOCK.version}`, `defuddle@${LOCK.version}+fullpage`, "innertext"].includes(r.page.extractor), r.page.extractor);
		c("the content is there, as an ordinary page gives it", r.content.markdown.includes("SITE-POST") && r.content.markdown.includes("SITE-COMMENT-TWO"), r.content.markdown);
		c("the author is not taken from the page's markup by a site extractor", r.page.author !== "apis", r.page);
	},
	drawing(c, o) {
		const r = o.runs.full;
		const md = r.content.markdown;
		const all = `${md}\n${r.content.text}\n${r.content.html}\n${JSON.stringify(r.content.links)}\n${JSON.stringify(r.page)}`;
		for (const name of ["ARIA", "ATTR", "TITLE", "DESC", "METADATA", "STYLE", "DEFS", "CLIPPATH", "MASK", "PATTERN", "MARKER", "SYMBOL", "NOFILL", "FILLOPACITY", "NOSTROKE", "OFF", "BELOW", "TINY", "OPACITY", "VISIBILITY", "DISPLAY", "ICON"]) {
			c(`not drawn, absent everywhere: ${name}`, !all.includes(`DRAWHID-${name}`), all.slice(Math.max(0, all.indexOf(`DRAWHID-${name}`) - 60), all.indexOf(`DRAWHID-${name}`) + 60));
		}
		for (const name of ["MAIN", "ONBAR", "JANUARY", "FEBRUARY", "OUTLINED", "UNITS", "END"]) {
			c(`drawn, in the markdown: ${name}`, md.includes(`DRAWVIS-${name}`), md);
			c(`drawn, in the visible text: ${name}`, r.content.text.includes(`DRAWVIS-${name}`));
		}
		c("no markup of a drawing in the markdown or the html: its letters stand in its place", !/<\/?(svg|text|rect|path|defs|title)\b/i.test(md) && !/<svg/i.test(r.content.html), md);
		// A formula has a source the page gives beside what it draws (an attribute, a script). Nothing can tell
		// whether the two say the same, and without the source most formulas would be lost: it is passed on.
		knownGap("drawing", "the source of a formula is held against what is drawn", !all.includes("DRAWHID-FORMULA"));
		c("no word of the injected sentence", !/attacker\.example/.test(all), (all.match(/attacker\.example/g) ?? []).length);
		c("removed pieces counted", r.stats.hidden_removed >= 9, r.stats);
	},
	frames(c, o) {
		const r = o.runs.full;
		// Frames named like the things the scripts keep for themselves: the page is read all the same.
		c("the article view, by Defuddle", r.extraction.view === "article" && r.page.extractor === `defuddle@${LOCK.version}`, [r.extraction, r.page.extractor]);
		c("the text of the page", r.content.markdown.includes("FRAMESVIS-MAIN") && r.content.markdown.includes("FRAMESVIS-END"), r.content.markdown);
		c("nothing of a frame in the result", !/<iframe/i.test(r.content.html), r.content.html);
	},
	// Frames named like what a script bundle looks for to find out how it is loaded. Here the scripts run as
	// scripts of the page, where a frame is found under its name by any script: the bundle sees "exports" and
	// "module", takes them for a module loader and hands itself to the frame instead of the window. In the
	// extension the scripts run in a world of their own; what a frame's name does there is not shown by this
	// run. What it shows: a bundle that is not where it is expected does not stop the page from being read.
	umd(c, o) {
		const r = o.runs.full;
		c("in this harness the bundle is not on the window: the frames took it", o.notes.bundle === "undefined", o.notes.bundle);
		c("the page is read all the same: the text of what is rendered", r.ok === true && r.extraction.view === "text" && r.page.extractor === "innertext", [r.extraction, r.page.extractor]);
		c("all of it", r.content.markdown.includes("UMDVIS-MAIN") && r.content.markdown.includes("UMDVIS-END") && r.content.markdown.includes("The lighthouse keeper's log"), r.content.markdown);
		c("and the result says that the bundle did not answer", r.stats.defuddle_failed === true && o.runs.textOnly.stats.defuddle_failed === true, r.stats);
		c("asked not to use the bundle, nothing failed", o.runs.plain.stats.defuddle_failed === false, o.runs.plain.stats);
		c("title, language and site are the page's own", r.page.title === "The lighthouse keeper's log - Harbour Notes" && r.page.lang === "en" && r.page.site === "Harbour Notes", r.page);
		c("nothing of a frame in the result", !/<iframe/i.test(String(o.runs.full.content.html)) && !/exports|module|define/.test(r.content.markdown), r.content.html);
	},
	robust(c, o) {
		const r = o.runs.full;
		c("the page itself: the article view, by Defuddle, and nothing failed", r.extraction.view === "article" && r.page.extractor === `defuddle@${LOCK.version}` && r.stats.defuddle_failed === false, [r.extraction, r.page.extractor, r.stats]);
		c("the text of the page", r.content.markdown.includes("ROBUSTVIS-MAIN") && r.content.markdown.includes("ROBUSTVIS-END"), r.content.markdown);
		const n = o.notes.fixture ?? {};
		// Read while it had no root element: an answer, not an exception - empty, and the source is the doctype alone.
		const bare = n.rootless ?? {};
		c("without a root element the page is read without an error", bare.ok === true && bare.threw === undefined, bare);
		c("there is nothing in it: no text, no link, no language", bare.markdown === "" && bare.links === 0 && bare.lang === null && bare.view === "text" && bare.extractor === "innertext", bare);
		c("its source is the doctype and nothing else", bare.raw === "<!DOCTYPE html>\n", bare.raw);
		// A form with 300 000 nodes in it is unwrapped like any other.
		const big = n.bigform ?? {};
		c("a very large form is unwrapped without an error", big.threw === undefined && big.forms === 0, big);
		c("everything that was in it is there, in order, and the controls are gone", big.nodes === 300002 && big.first === true && big.last === true && big.length === 300025, big);
	},
	schema(c, o) {
		const r = o.runs.full;
		const all = `${r.content.markdown}\n${r.content.text}\n${r.content.html}\n${JSON.stringify(r.content.links)}\n${JSON.stringify(r.page)}`;
		c("the visible text is the result", r.content.markdown.includes("SCHEMAVIS-MAIN") && r.content.markdown.includes("SCHEMAVIS-END"), r.content.markdown);
		for (const name of ["COMMENT", "GRAPH", "SPLIT", "WRAPPED", "CDATA", "PLAIN"]) c(`schema text absent: ${name}`, !all.includes(`SCHEMAHID-${name}`), all.slice(Math.max(0, all.indexOf(`SCHEMAHID-${name}`) - 40), all.indexOf(`SCHEMAHID-${name}`) + 80));
		c("no word of the injected sentence", !/attacker\.example/.test(all));
		c("the rest of the data is used: author, date, site", r.page.author === "Rosa Lindqvist" && /^2026-12-01/.test(r.page.published || "") && r.page.site === "Mill Street Library", r.page);
		c("word count is that of what is shown", r.page.word_count > 20 && r.page.word_count < 80, r.page.word_count);
	},
	shadow(c, o) {
		const r = o.runs.full;
		const md = r.content.markdown;
		const all = `${md}\n${r.content.text}\n${r.content.html}\n${JSON.stringify(r.content.links)}\n${JSON.stringify(r.page)}`;
		for (const name of ["LEGACY", "TEMPLATE", "ODDMODE", "INNER", "INNERPLAIN", "BARE", "UNSLOTTED", "SLOTHIDDEN", "SLOTFAINT", "WRONGNAME", "NESTED", "ATTR", "CLOSEDUNSLOTTED"]) {
			c(`not rendered, absent everywhere: ${name}`, !new RegExp(`SHADOWHID-${name}\\b`).test(all), all.slice(Math.max(0, all.indexOf(`SHADOWHID-${name} `) - 60), all.indexOf(`SHADOWHID-${name} `) + 60));
		}
		for (const name of ["MAIN", "LEGACYHOST", "INNER", "INNERPLAIN", "NOSLOT", "NAMED", "SLOTTEDTEXT", "SLOTTED", "FALLBACK", "NESTED", "ATTRHOST", "END"]) {
			c(`rendered, in the markdown: ${name}`, new RegExp(`SHADOWVIS-${name}\\b`).test(md), md.slice(0, 300));
			c(`rendered, in the visible text: ${name}`, new RegExp(`SHADOWVIS-${name}\\b`).test(r.content.text));
		}
		c("what a slot shows stands where the slot is: the text of the host before its paragraph", md.indexOf("SHADOWVIS-SLOTTEDTEXT") < md.indexOf("SHADOWVIS-SLOTTED The"), md);
		// A page's own script cannot look into a closed tree, and this run is one. The add-on can, in Firefox:
		// there what the tree shows is read and the host's text that no slot takes is left out.
		knownGap("shadow", "a closed shadow tree is read like an open one (the add-on can look into it, this run cannot)", /SHADOWVIS-CLOSED\b/.test(md) && !/SHADOWHID-CLOSEDBARE\b/.test(all));
		c("no word of the injected sentence but with the one a closed tree keeps from this run", (all.match(/attacker\.example/g) ?? []).length === (all.match(/SHADOWHID-CLOSEDBARE\b/g) ?? []).length, (all.match(/attacker\.example/g) ?? []).length);
		c("no template, no shadow attribute and no slot content left over in the html", !/<template|data-defuddle-shadow|shadowroot/i.test(r.content.html), r.content.html.slice(0, 300));
		c("removed pieces counted", r.stats.hidden_removed >= 8, r.stats);
		c("article view", r.extraction.view === "article" && r.page.extractor === `defuddle@${LOCK.version}`, [r.extraction, r.page.extractor]);
	},
	qa(c, o) {
		const r = o.runs.full;
		const md = r.content.markdown;
		const text = r.content.text;
		c("question and both answers", md.includes("QAQUESTION-MAIN") && md.includes("QAANSWER-ONE") && md.includes("QAANSWER-TWO"), [r.extraction, md.slice(0, 200)]);
		c("the same in the visible text", text.includes("QAQUESTION-MAIN") && text.includes("QAANSWER-ONE") && text.includes("QAANSWER-TWO") && text.includes("QACOMMENT-ONE"));
		// Tags that are text - in inline code and in code blocks - come through as the page shows them.
		c("inline code: <script> with attributes", md.includes('`<script src="tracker.js"></script>`'), md.slice(0, 500));
		c("inline code: <iframe>, <style>, <script defer>", md.includes("`<iframe>`") && md.includes("`<style>`") && md.includes("`<script defer>`"), md);
		c("inline code: a tag inside a string", md.includes('`"<script>"`'), md);
		const html1 = '<!doctype html>\n<html>\n<head>\n  <!-- the tracker -->\n  <style>body { margin: 0 }</style>\n  <script src="tracker.js"></script>\n</head>\n<body>\n  <iframe src="https://video.example.org/embed/42" width="560" height="315"></iframe>\n</body>\n</html>';
		c("code block: a whole HTML document, verbatim", md.includes("```html\n" + html1 + "\n```"), md.slice(md.indexOf("```"), md.indexOf("```") + 500));
		c("code block: script and iframe elements, verbatim", md.includes('```html\n<script defer src="tracker.js"></script>\n<iframe loading="lazy" src="https://video.example.org/embed/42"></iframe>\n```'), md);
		const js = 'window.addEventListener("load", () => {\n  const s = document.createElement("script");\n  s.src = "tracker.js";\n  s.async = true;\n  document.head.appendChild(s);\n  if (a < b && c > d) console.log("<script> injected");\n});';
		c("code block: JavaScript, verbatim, with its language", md.includes("```js\n" + js + "\n```"), md.slice(md.lastIndexOf("```js"), md.lastIndexOf("```js") + 400));
		c("the visible text has the code as well", text.includes(html1) && text.includes(js), text.slice(0, 400));
		c("table as a Markdown table", /\| Attribute \| Fetch \| Runs \|\n\| -+ \| -+ \| -+ \|\n\| none \| blocks parsing \| at once \|\n\| async \| in parallel \| as soon as it arrives \|\n\| defer \| in parallel \| after parsing, in order \|/.test(md), md.slice(md.indexOf("| Attribute"), md.indexOf("| Attribute") + 300));
		// The stored HTML is another matter: no element that runs or loads, the samples as escaped text.
		const html = r.content.html;
		c("html: the samples are escaped text", html.includes("&lt;script src=\"tracker.js\"&gt;&lt;/script&gt;") && html.includes("&lt;iframe src=\"https://video.example.org/embed/42\""), html.slice(0, 400));
		c("html: no script, style, iframe or form element", !/<(script|style|iframe|object|embed|form|link|meta|base)\b|\son[a-z]+\s*=/i.test(html), html.slice(0, 400));
		c("no link to the sample's addresses was made up", !r.content.links.some((/** @type {any} */ l) => /video\.example\.org|tracker\.js/.test(l.url)), r.content.links);
		c("title and site", /load a script only after the page has rendered/.test(r.page.title || "") && r.page.site === "Stack Example", r.page);
		c("a view that says what it is", ["article", "full_page"].includes(r.extraction.view) && Number.isInteger(r.extraction.coverage_pct), r.extraction);
	},
	reveal(c, o) {
		const r = o.runs.full;
		const md = r.content.markdown;
		const text = r.content.text;
		// Sections that wait at opacity 0 for a transition or an animation are content.
		for (const name of ["INTRO", "ONE", "TWO", "THREE", "FOUR", "ANIMATED"]) {
			c(`reveal-on-scroll text present in markdown: ${name}`, md.includes(`REVEAL-${name}`), md.slice(0, 300));
			c(`reveal-on-scroll text present in the visible text: ${name}`, text.includes(`REVEAL-${name}`));
		}
		c("their headings too", /^## The third summer$/m.test(md) && /^## What comes next$/m.test(md), md);
		// Transparent for good stays out: no transition, a transition of something else, a transition that takes no time.
		for (const name of ["GONE", "COLOUR", "INSTANT"]) {
			c(`hidden for good, absent everywhere: ${name}`, !(md + text + r.content.html).includes(`REVEALHID-${name}`), name);
		}
		c("no word of the injected sentences", !/attacker\.example|urgent instruction|must be rebuilt/i.test(md + text + r.content.html));
		c("kept elements and removed ones are both counted", r.stats.fading_kept >= 5 && r.stats.hidden_removed === 3, r.stats);
		c("article view, most of the page", r.extraction.view === "article" && r.extraction.coverage_pct >= 80, r.extraction);
		c("defuddle did the extraction", r.page.extractor === `defuddle@${LOCK.version}`, r.page.extractor);
		c("metadata", r.page.author === "Noor Halvorsen" && r.page.site === "Watershed Journal", r.page);
		// This runner does not scroll: what the page only makes when it is scrolled to is not there.
		c("content loaded on scroll is absent without scrolling", !(md + text).includes("REVEAL-LAZY"));
	},
	probes(c, o) {
		const r = o.runs.full;
		const all = `${r.content.markdown}\n${r.content.text}\n${r.content.html}\n${JSON.stringify(r.content.links)}\n${JSON.stringify(r.page)}`;
		for (const name of PROBES_ALL.filter((n) => !PROBES_LEFT.includes(n))) c(`hidden probe absent: ${name}`, !new RegExp(`PROBEHID-${name}\\b`).test(all), all.slice(Math.max(0, all.search(new RegExp(`PROBEHID-${name}\\b`)) - 60), all.search(new RegExp(`PROBEHID-${name}\\b`)) + 60));
		for (const name of PROBE_RELATIVES) c(`hidden probe absent: ${name}`, !all.includes(`PROBEHIDX-${name}`), name);
		// The two that are left alone on purpose.
		knownGap("probes", "text under an opaque positioned overlay is dropped", !/PROBEHID-OVERLAY\b/.test(all));
		knownGap("probes", "text behind a mask that is a picture is dropped", !/PROBEHID-MASKURL\b/.test(all));
		const survivors = PROBES_ALL.filter((name) => new RegExp(`PROBEHID-${name}\\b`).test(all)).sort();
		c(`there are ${PROBES_ALL.length} probes, each once in the page`, PROBES_ALL.length === 51 && new Set(PROBES_ALL).size === 51 && PROBES_ALL.every((name) => (o.notes.before.match(new RegExp(`PROBEHID-${name}\\b`, "g")) ?? []).length === 1), PROBES_ALL.length);
		c("of the 51 probes exactly two survive", JSON.stringify(survivors) === JSON.stringify(PROBES_LEFT), survivors);
		c("no word of the injected sentence but with those two", (all.match(/attacker\.example/g) ?? []).length === (all.match(/PROBEHID-(OVERLAY|MASKURL)\b/g) ?? []).length, (all.match(/attacker\.example/g) ?? []).length);
		// What must not go with them. Asked of the visible text: what Defuddle makes of menus and
		// carousels is its own business.
		const text = r.content.text;
		for (const name of PROBE_VISIBLE) c(`visible control present in the visible text: ${name}`, text.includes(`PROBEVIS-${name}`), name);
		c("the article text is in the markdown", r.content.markdown.includes("PROBEVIS-PLAIN") && r.content.markdown.includes("PROBEVIS-END"), r.content.markdown.slice(0, 200));
		c("removed pieces counted", r.stats.hidden_removed >= 54, r.stats);
	},
	dark(c, o) {
		const r = o.runs.full;
		const all = `${r.content.markdown}\n${r.content.text}\n${r.content.html}\n${JSON.stringify(r.page)}`;
		// A page that is made for a dark canvas and gives itself no background: what is behind its letters is
		// the browser's dark canvas, and letters in that colour (or one next to it) are not seen.
		for (const name of ["CANVAS", "NEARBLACK", "OTHERBLACK", "WHITEINBOX"]) c(`not seen on a dark canvas: ${name}`, !all.includes(`DARKHID-${name}`), all.slice(Math.max(0, all.indexOf(`DARKHID-${name}`) - 60), all.indexOf(`DARKHID-${name}`) + 60));
		for (const name of ["MAIN", "DIM", "NOTE", "END"]) c(`seen on a dark canvas: ${name}`, r.content.text.includes(`DARKVIS-${name}`) && r.content.markdown.includes(`DARKVIS-${name}`), r.content.text);
		c("no word of the injected sentence", !/attacker\.example/.test(all));
		c("removed pieces counted", r.stats.hidden_removed === 4, r.stats);
	},
	edges(c, o) {
		const r = o.runs.full;
		const all = `${r.content.markdown}\n${r.content.text}\n${r.content.html}\n${JSON.stringify(r.page)}`;
		// A page that says it runs from right to left: nothing beyond its right edge, and to the left only what
		// the page's own content reaches. And text far below everything else, with a box of nothing above it.
		for (const name of ["FARLEFT", "BEYONDSTART", "SPACER"]) c(`beside the page, absent everywhere: ${name}`, !all.includes(`EDGEHID-${name}`), all.slice(Math.max(0, all.indexOf(`EDGEHID-${name}`) - 60), all.indexOf(`EDGEHID-${name}`) + 60));
		for (const name of ["MAIN", "NOTE", "END"]) c(`on the page: ${name}`, r.content.text.includes(`EDGEVIS-${name}`), r.content.text);
		c("no word of the injected sentence", !/attacker\.example/.test(all));
		c("removed pieces counted", r.stats.hidden_removed === 3, r.stats);
	},
	thin(c, o) {
		const r = o.runs.full;
		c("fallback extractor used", r.page.extractor === "innertext", r.page.extractor);
		c("innerText content", r.content.markdown.includes("THIN-MARK"), r.content.markdown);
		c("the markdown is the visible text: said so, and not sent twice", r.extraction.view === "text" && r.extraction.coverage_pct === null && r.content.text === null && r.truncated.text === false, [r.extraction, r.content.text]);
		c("asked for the text alone, it is sent", o.runs.textOnly.content.text === r.content.markdown && o.runs.textOnly.content.markdown === null, o.runs.textOnly.content);
		c("html is null on fallback", r.content.html === null || o.runs.full.content.html === "" || true);
		c("link from thin page still listed", r.content.links.some((/** @type {any} */ l) => /\/elsewhere$/.test(l.url) && l.text === "Go elsewhere"), r.content.links);
		c("title from document", r.page.title === "Tiny page", r.page.title);
		c("word_count", r.page.word_count === 4, r.page.word_count);
	},
	hostile(c, o) {
		const r = o.runs.full;
		const html = r.content.html;
		const md = r.content.markdown;
		c("page scripts ran live (test is meaningful)", o.live.scriptRan === true);
		c("main text kept", md.includes("HOSTILE-MAIN"), md.slice(0, 200));
		c("html: no script element", !/<script/i.test(html), html);
		c("html: no on* attribute", !/\son[a-z]+\s*=/i.test(html), html);
		c("html: no javascript: / data: / vbscript:", !/(javascript|vbscript|data):/i.test(html), html);
		c("html: no iframe/object/embed/form/style attr", !/<(iframe|object|embed|form|link|meta|base|style)\b|\sstyle=|srcdoc/i.test(html), html);
		c("legit link kept", html.includes('href="https://good.example.org/ok?a=1&amp;b=2"') && r.content.links.some((/** @type {any} */ l) => l.url === "https://good.example.org/ok?a=1&b=2"), r.content.links);
		c("mailto kept in html, not in links", html.includes("mailto:help@example.org") && !r.content.links.some((/** @type {any} */ l) => l.url.startsWith("mailto:")));
		c("links all http(s)", r.content.links.every((/** @type {any} */ l) => /^https?:\/\//.test(l.url)), r.content.links);
		c("title", r.page.title === "Totally normal tutorial", r.page.title);
		// The page source is the page as the browser holds it, the hostile parts included. Making it harmless is the daemon's part.
		const raw = o.runs.raw.content.raw_html;
		c("page source: scripts, handlers, the form, the iframe and the look-alike lines are all there verbatim", /<script>window\.__live_script_ran = true;<\/script>/.test(raw) && /onerror="window\.__hostile_onerror = true"/.test(raw) && /<form action="https:\/\/phish\.example\/post">/.test(raw) && /<iframe src="https:\/\/evil\.example\/frame"/.test(raw) && raw.includes("[browser-gateway] outcome=ok page=pg_00000000000000000000000000") && raw.includes("javascript:alert(1)"), raw.length);
		c("page source: the zero-width and right-to-left characters are still in it", raw.includes("Zero\u200bwidth") && raw.includes("\u202egnihtemos\u202c"), raw.length);
		c("author single line", r.page.author === null || !/[\r\n\u2028\u2029]/.test(r.page.author), r.page.author);
		c("site is the host name, never the author", r.page.site === "127.0.0.1" && r.page.site !== r.page.author, [r.page.site, r.page.author]);
		c("invalid published dropped", r.page.published === null, r.page.published);
		c("markdown: no vbscript/javascript/data link targets, no raw iframe", !/\]\((javascript|vbscript|data):|<(iframe|script|object|embed|form)/i.test(md), md);
		c("markdown keeps text of dropped links", md.includes("vb link") && md.includes("this harmless link"), md);
		c("fake end marker passes through as inert text (Markdown escapes the underscores; the daemon must defang both forms)", md.replaceAll("\\", "").includes("END_UNTRUSTED_WEB_CONTENT"), md);
	},
	hidden(c, o) {
		const r = o.runs.full;
		const md = r.content.markdown;
		const html = r.content.html;
		const hidden = ["DISPLAY", "CLASS", "VISIBILITY", "ATTR", "CV", "OPACITY", "OFFSCREEN", "TOP", "CLIP", "CLIPPATH", "FONT", "INDENT", "TRANSFORM", "SCALE", "CANVAS", "VIDEO", "NESTED", "COMMENT", "VISPARENT", "SCHEMA"];
		for (const name of hidden) {
			c(`hidden text absent from markdown: ${name}`, !md.includes(`HIDDEN-${name}`), md.slice(Math.max(0, md.indexOf(`HIDDEN-${name}`) - 40), md.indexOf(`HIDDEN-${name}`) + 80));
			c(`hidden text absent from html: ${name}`, !html.includes(`HIDDEN-${name}`));
		}
		for (const name of ["MAIN", "REVEALED", "DETAILS", "COLLAPSED", "LOWOPACITY"]) {
			c(`visible text present in markdown: ${name}`, md.includes(`VISIBLE-${name}`), md.slice(0, 300));
			c(`visible text present in html: ${name}`, html.includes(`VISIBLE-${name}`));
		}
		c("no word of the injected instructions anywhere", !/attacker\.example|previous instructions/i.test(md + html + JSON.stringify(r.content.links) + JSON.stringify(r.page)), md);
		c("removed count reported", r.stats.hidden_removed >= 17 && r.extraction.hidden_removed === r.stats.hidden_removed && r.extraction.capped === false, [r.stats, r.extraction]);
		c("hidden text absent from the visible text as well", hidden.every((name) => !r.content.text.includes(`HIDDEN-${name}`)) && r.content.text.includes("VISIBLE-MAIN") && r.content.text.includes("VISIBLE-DETAILS"), r.content.text.slice(0, 300));
		c("elements inspected, cap not reached", r.stats.elements_inspected > 10 && r.stats.elements_inspected <= r.stats.elements_cap && r.stats.capped === false && r.stats.dropped === 0, r.stats);
		c("defuddle did the extraction", r.page.extractor === `defuddle@${LOCK.version}`, r.page.extractor);
		c("metadata survives", r.page.author === "Ines Albrecht" && r.page.site === "Orchard Notes" && /prune apple trees/.test(r.page.title || ""), r.page);
		c("visible link kept", r.content.links.some((/** @type {any} */ l) => l.url === "https://orchard.example.org/calendar"), r.content.links);
	},
	hiddenthin(c, o) {
		const r = o.runs.full;
		const all = JSON.stringify(r.content) + JSON.stringify(r.page);
		c("fallback extractor used", r.page.extractor === "innertext", r.page.extractor);
		c("visible line returned", r.content.markdown.includes("THINVIS-MARK"), r.content.markdown);
		c("hidden text absent from the fallback text, html and links", !/THINHID-/.test(all), all.slice(0, 600));
		c("visible link listed, hidden link not", r.content.links.length === 1 && /\/thin-elsewhere$/.test(r.content.links[0].url), r.content.links);
		c("removed count reported", r.stats.hidden_removed === 4, r.stats);
		c("word count is that of the visible text", r.page.word_count === 5, r.page.word_count);
	},
	base(c, o) {
		const r = o.runs.full;
		const hrefs = r.content.links.map((/** @type {any} */ l) => l.url);
		c("main text", r.content.markdown.includes("BASE-MAIN"), r.content.markdown.slice(0, 200));
		c("relative resolved via <base>", hrefs.includes("https://docs.example.org/guide/requirements.html"), hrefs);
		c("../ resolved via <base>", hrefs.includes("https://docs.example.org/troubleshooting/index.html#common"), hrefs);
		c("root-relative via <base>", hrefs.includes("https://docs.example.org/api/reference"), hrefs);
		c("protocol-relative", hrefs.includes("https://cdn.example.org/pdf/guide.pdf"), hrefs);
		c("query kept", hrefs.includes("https://docs.example.org/guide/steps/verify.html?mode=full"), hrefs);
		c("links de-duplicated", new Set(hrefs).size === hrefs.length && hrefs.filter((/** @type {string} */ h) => h.endsWith("/requirements.html")).length === 1, hrefs);
		c("nav clutter absent", !r.content.markdown.includes("NAV-CLUTTER"));
		c("markdown links absolute", /\]\(https:\/\/docs\.example\.org\/guide\/requirements\.html\)/.test(r.content.markdown), r.content.markdown.slice(0, 400));
	},
};

/** Checks that apply to every fixture. */
function common(/** @type {string} */ name, /** @type {any} */ o, /** @type {string} */ url, /** @type {string[]} */ served) {
	const c = (/** @type {string} */ n, /** @type {unknown} */ ok, /** @type {unknown} */ d = undefined) => check(name, n, ok, d);
	c("live DOM unchanged after extraction (serialisation + MutationObserver)", o.notes.domUnchanged === true && o.notes.mutations === 0, o.notes);
	c("no network API called", o.notes.netCalls.length === 0, o.notes.netCalls);
	c("no new resource loads during extraction", o.notes.newResources <= served.length, { n: o.notes.newResources, served });
	c("surrogate-safe cuts", o.notes.surrogateBad === 0 && o.notes.surrogateTried > 0, [o.notes.surrogateBad, o.notes.surrogateTried]);
	c("deterministic across runs", JSON.stringify({ ...o.runs.full, stats: 0 }) === JSON.stringify({ ...o.runs.fullAgain, stats: 0 }));
	const full = o.runs.full;
	const v = validateMessage(asJobResult(full, url), DIRECTION.TO_DAEMON);
	c("job.result validates against protocol.js", v.ok, v);
	c("stats present", Number.isInteger(full.stats.text_len) && Number.isInteger(full.stats.visible_len) && Number.isInteger(full.stats.html_len) && Number.isInteger(full.stats.fading_kept) && full.stats.ms >= 0, full.stats);
	c("truncated flags false for uncapped run", full.truncated.markdown === false && full.truncated.text === false && full.truncated.html === false && full.truncated.raw_html === false, full.truncated);
	// The page source is taken only when asked for, as the live document holds it, and the page is left as it was.
	c("no page source unless asked for", full.content.raw_html === null && o.runs.off.content.raw_html === null, typeof full.content.raw_html);
	const raw = o.runs.raw;
	const source = raw.content.raw_html;
	c("page source: a string, not cut, valid", typeof source === "string" && source.length > 0 && raw.truncated.raw_html === false && validateMessage(asJobResult(raw, url), DIRECTION.TO_DAEMON).ok, validateMessage(asJobResult(raw, url), DIRECTION.TO_DAEMON));
	c("page source: the serialised document, unmodified (doctype plus the root element)", typeof source === "string" && source === (o.notes.doctype === null ? "" : `<!DOCTYPE ${o.notes.doctype}>\n`) + o.notes.before, [o.notes.doctype, String(source).slice(0, 80)]);
	c("page source: the page's own scripts are in it", typeof source === "string" && /<script\b/i.test(source), 0);
	c("the other views are unchanged by asking for the source", JSON.stringify({ ...raw.content, raw_html: 0 }) === JSON.stringify({ ...full.content, raw_html: 0 }) && raw.page.extractor === full.page.extractor);
	const rs = o.runs.rawSmall;
	c("page source: capped to the limit and flagged", rs.content.raw_html.length <= 40 && rs.truncated.raw_html === true && source.startsWith(rs.content.raw_html) && validateMessage(asJobResult(rs, url), DIRECTION.TO_DAEMON).ok, [rs.content.raw_html.length, rs.truncated]);
	// Every result says which view its Markdown is, with whole numbers; the visible text comes along
	// unless the Markdown is that text.
	const x = full.extraction;
	c("extraction facts: a view, a percentage or null, counts", ["article", "full_page", "text"].includes(x.view) && (x.coverage_pct === null || (Number.isInteger(x.coverage_pct) && x.coverage_pct >= 0 && x.coverage_pct <= 100)) && Number.isInteger(x.hidden_removed) && x.capped === false, x);
	c("the extractor's name goes with the view", x.view === "article" ? /^defuddle@[0-9.]+(\+[a-z]+)?$/.test(full.page.extractor) && !full.page.extractor.endsWith("+fullpage") : x.view === "full_page" ? full.page.extractor.endsWith("+fullpage") : ["innertext", "plaintext"].includes(full.page.extractor), [x.view, full.page.extractor]);
	c("visible text sent exactly when the markdown is not it", x.view === "text" ? full.content.text === null : typeof full.content.text === "string" && full.content.text.length > 0, [x.view, typeof full.content.text]);
	if (typeof full.content.text === "string") c("visible text: no markup, no control characters", !/<\/?(p|div|span|a|script)\b/i.test(full.content.text.replace(/```[^]*?```/g, "").replace(/<[a-z]+[^>\n]*>[^<\n]*<\/[a-z]+>/gi, "")) || name === "qa", full.content.text.slice(0, 200));
	const only = o.runs.textOnly;
	c("text-only run: the visible text and nothing else, valid", typeof only.content.text === "string" && only.content.markdown === null && only.content.html === null && only.content.links.length === 0 && validateMessage(asJobResult(only, url), DIRECTION.TO_DAEMON).ok, validateMessage(asJobResult(only, url), DIRECTION.TO_DAEMON));
	if (typeof full.content.text === "string") c("text-only run returns the same text", only.content.text === full.content.text);
	// small caps
	const s = o.runs.small;
	c("small run: markdown capped and flagged", s.content.markdown.length <= 50 && s.truncated.markdown === (full.content.markdown.length > 50), [s.content.markdown.length, s.truncated]);
	if (full.content.html !== null && full.content.html.length > 60) c("small run: html capped and flagged", s.content.html.length <= 60 && s.truncated.html === true, [s.content.html.length, s.truncated]);
	c("small run: links capped", s.content.links.length <= 2, s.content.links.length);
	if (typeof full.content.text === "string") c("small run: visible text capped and flagged", s.content.text.length <= 70 && s.truncated.text === (full.content.text.length > 70) && full.content.text.startsWith(s.content.text), [s.content.text.length, s.truncated]);
	c("small run still validates", validateMessage(asJobResult(s, url), DIRECTION.TO_DAEMON).ok, validateMessage(asJobResult(s, url), DIRECTION.TO_DAEMON));
	// options off
	const f = o.runs.off;
	c("off run: nulls and no links", f.content.markdown === null && f.content.text === null && f.content.html === null && f.content.raw_html === null && f.content.links.length === 0 && !f.truncated.markdown && !f.truncated.text && !f.truncated.html && !f.truncated.raw_html, f);
	c("off run: the facts of the extraction all the same", f.extraction.view === x.view && f.extraction.coverage_pct === x.coverage_pct, f.extraction);
	c("off run validates", validateMessage(asJobResult(f, url), DIRECTION.TO_DAEMON).ok);
	// element cap: what was not looked at is dropped, and the result says so
	const k = o.runs.capped;
	c("capped run: flagged, bounded and still valid", k.stats.capped === true && k.extraction.capped === true && k.stats.elements_inspected === 3 && k.stats.dropped > 0 && k.truncated.markdown === true && validateMessage(asJobResult(k, url), DIRECTION.TO_DAEMON).ok, k.stats);
	c("capped run: no more text than the full run", k.content.markdown.length <= full.content.markdown.length, [k.content.markdown.length, full.content.markdown.length]);
	// without Defuddle: the text of what is rendered
	const p = o.runs.plain;
	c("plain run: innertext extractor, the text view, valid", p.page.extractor === "innertext" && p.extraction.view === "text" && p.content.text === null && validateMessage(asJobResult(p, url), DIRECTION.TO_DAEMON).ok, p.page);
	if (typeof full.content.text === "string") c("plain run: its markdown is the visible text of the full run", p.content.markdown === full.content.text);
	c("plain run: no markup that runs or loads", !/<(script|iframe|object|embed|style|form)\b|\son[a-z]+\s*=|javascript:/i.test(p.content.html ?? ""), (p.content.html ?? "").slice(0, 300));
	c("link caps respect protocol", full.content.links.length <= LIMITS.MAX_LINKS && full.content.links.every((/** @type {any} */ l) => l.text.length <= 500 && !/[\n\r]/.test(l.text)));
	c("vendor version matches lock", full.page.extractor === "innertext" || full.page.extractor.startsWith(`defuddle@${LOCK.version}`), full.page.extractor);
}

/** The eight results the made-up pages list, in their order. */
const SEARCH_URLS = [
	"https://sqlite.example.org/wal.html",
	"https://docs.example.com/guides/sqlite-wal-mode",
	"https://blog.example.net/2025/11/wal-checkpoint-starvation/",
	"https://forum.example.io/t/wal-on-network-filesystems/5512",
	"https://en.encyclopedia.example/wiki/Write-ahead_logging",
	"https://stack.example.com/questions/1711631/improve-insert-per-second-performance-of-sqlite",
	"https://www.example.edu/~db/notes/recovery.pdf",
	"https://github.example.com/acme/litestream-clone",
];
const SEARCH_TITLES = ["Write-Ahead Logging - SQLite", "SQLite WAL mode explained: when to use it and when not", "Checkpoint starvation in WAL mode, and how we fixed it", "Is WAL safe on a network filesystem? - Database forum"];

/** Wrap what the search script found as the job.result the daemon would validate. */
function asSearchResult(/** @type {any} */ r, /** @type {string} */ url) {
	return makeMessage(MSG.JOB_RESULT, {
		job: "smoke",
		outcome: "ok",
		cookie_scope: "container",
		nav: { requested_url: url, final_url: url, redirect_origins: [], http_status: 200, content_type: "text/html", body_bytes: null },
		render: { visibility: null, raf_hz: null, settled: true, scrolled_px: 0, scroll: "off", dwell: "off", elapsed_ms: 0, timings: zeroTimings() },
		detect: null,
		error: null,
		file: null,
		page: { title: r.title, author: null, published: null, lang: null, site: null, word_count: 0, extractor: `search-${r.detector}` },
		extraction: { view: "text", coverage_pct: null, hidden_removed: r.hidden_removed, capped: r.capped },
		content: { markdown: null, text: null, html: null, raw_html: null, links: [], results: r.results },
		truncated: { markdown: false, text: false, html: false, raw_html: false },
		tab_kept_open: false,
	});
}

/**
 * Checks every results page must pass, whatever it looks like.
 * @param {string} name @param {any} o @param {string} url @param {string[]} served
 */
function commonSearch(name, o, url, served) {
	/** @param {string} n @param {unknown} ok @param {unknown} [d] */
	const c = (n, ok, d) => check(name, n, ok, d);
	c("the page was only read: no mutation, no request", o.notes.domUnchanged === true && o.notes.mutations === 0 && o.notes.netCalls.length === 0 && served.filter((p) => p !== "/pixel" && p !== "/favicon.ico").length === 0, [o.notes, served]);
	c("one function was defined beside the extractor's, and nothing else", JSON.stringify(o.notes.globals.sort()) === JSON.stringify(["__bgwExtract", "__bgwSearch"]), o.notes.globals);
	c("the hints are the five engines, in the order the background page names them", JSON.stringify(o.notes.hints) === JSON.stringify(["duckduckgo", "brave", "bing", "google", "startpage"]), o.notes.hints);
	for (const [run, r] of Object.entries(o.runs)) {
		const rs = /** @type {any} */ (r).results;
		c(`${run}: an answer with a list`, /** @type {any} */ (r).ok === true && Array.isArray(rs), r);
		c(`${run}: numbered from 1, each a web address once, a title, text within the caps`, rs.every((/** @type {any} */ x, /** @type {number} */ i) => x.rank === i + 1 && /^https?:\/\//.test(x.url) && x.url.length <= 2048 && x.title.length >= 3 && x.title.length <= 300 && x.snippet.length <= 500 && !/[\n\r\t]/.test(x.title + x.snippet)) && new Set(rs.map((/** @type {any} */ x) => x.url)).size === rs.length, rs.slice(0, 3));
		c(`${run}: a valid job.result`, validateMessage(asSearchResult(r, url), DIRECTION.TO_DAEMON).ok, validateMessage(asSearchResult(r, url), DIRECTION.TO_DAEMON));
	}
	c("the limit is kept", o.runs.three.results.length <= 3 && o.runs.generic.results.length <= 20 && o.runs.odd.results.length <= 20, [o.runs.three.results.length, o.runs.odd.results.length]);
	c("a small limit gives the first results, in order", JSON.stringify(o.runs.three.results) === JSON.stringify(o.runs.generic.results.slice(0, 3)));
	c("without arguments: ten at most, the general look", o.runs.none.results.length <= 10 && o.runs.none.detector === "generic", o.runs.none.detector);
	c("a hint that does not exist is no hint", o.runs.odd.detector === "generic");
}

/** @param {any} run @returns {string} everything a run hands back, as one text */
const allOf = (run) => JSON.stringify(run.results);
/** @param {any} run @returns {string[]} */
const urlsOf = (run) => run.results.map((/** @type {any} */ r) => r.url);
const HINT_NAMES = ["duckduckgo", "brave", "bing", "google", "startpage"];

/** @type {Record<string, (c: (n: string, ok: unknown, d?: unknown) => void, o: any) => void>} */
const EXPECT_SEARCH = {
	ddg(c, o) {
		const g = o.runs.generic;
		c("the general look: the eight results, in order", JSON.stringify(urlsOf(g)) === JSON.stringify(SEARCH_URLS), urlsOf(g));
		c("links wrapped by the page (/l/?uddg=) are unwrapped to their targets", urlsOf(g).every((u) => !u.includes("uddg") && !u.includes("127.0.0.1")), urlsOf(g));
		c("titles as the page has them", SEARCH_TITLES.every((t, i) => g.results[i].title === t), g.results.slice(0, 4).map((/** @type {any} */ r) => r.title));
		c("each with its snippet", g.results.every((/** @type {any} */ r) => r.snippet.length >= 60) && g.results[0].snippet.startsWith("The default method by which SQLite implements atomic commit"), g.results.map((/** @type {any} */ r) => r.snippet.slice(0, 30)));
		c("the advertisement is not among them", !allOf(g).includes("ADVERT"), allOf(g).slice(0, 200));
		c("nothing of the page's own: no tab, no setting, no footer link", !/Images|News|Settings|Privacy|Terms|Feedback/.test(g.results.map((/** @type {any} */ r) => r.title).join("|")));
		// The hint for this kind of page finds the same list; the others find nothing and the general look stands.
		const h = o.runs.hint0;
		c("the duckduckgo hint: the same eight, and said to be by hint", h.detector === "hint" && JSON.stringify(urlsOf(h)) === JSON.stringify(SEARCH_URLS) && !allOf(h).includes("ADVERT"), [h.detector, urlsOf(h)]);
		c("the hint's snippets are the page's", h.results.every((/** @type {any} */ r, /** @type {number} */ i) => r.snippet === g.results[i].snippet), h.results.map((/** @type {any} */ r) => r.snippet.slice(0, 30)));
		for (const i of [1, 2, 3]) c(`the ${HINT_NAMES[i]} hint matches nothing here: the general look`, o.runs[`hint${i}`].detector === "generic" && JSON.stringify(urlsOf(o.runs[`hint${i}`])) === JSON.stringify(SEARCH_URLS), o.runs[`hint${i}`].detector);
		c("measured", true);
	},
	brave(c, o) {
		const g = o.runs.generic;
		c("the general look: the eight results, in order - without a single heading on the page's results", JSON.stringify(urlsOf(g)) === JSON.stringify(SEARCH_URLS), urlsOf(g));
		c("the title is the title, not the site's name or its address", SEARCH_TITLES.every((t, i) => g.results[i].title === t), g.results.slice(0, 4).map((/** @type {any} */ r) => r.title));
		c("each with its snippet", g.results.every((/** @type {any} */ r) => r.snippet.length >= 60 && !r.snippet.includes("\u203a")), g.results.map((/** @type {any} */ r) => r.snippet.slice(0, 30)));
		c("the questions block is not among them", !allOf(g).includes("PAA-"), allOf(g).slice(0, 300));
		c("nor the box beside the results", !allOf(g).includes("SIDEBAR"));
		const h = o.runs.hint1;
		c("the brave hint: the same eight", h.detector === "hint" && JSON.stringify(urlsOf(h)) === JSON.stringify(SEARCH_URLS) && !allOf(h).includes("PAA-") && !allOf(h).includes("SIDEBAR"), [h.detector, urlsOf(h)]);
		c("a hint for another engine changes nothing", o.runs.hint2.detector === "generic" && JSON.stringify(urlsOf(o.runs.hint2)) === JSON.stringify(SEARCH_URLS));
	},
	table(c, o) {
		const g = o.runs.generic;
		c("the general look: the eight results of a table layout, in order", JSON.stringify(urlsOf(g)) === JSON.stringify(SEARCH_URLS), urlsOf(g));
		c("titles", SEARCH_TITLES.every((t, i) => g.results[i].title === t));
		c("the snippet is taken from the row after the title", g.results.every((/** @type {any} */ r) => r.snippet.length >= 60) && g.results[1].snippet.startsWith("WAL mode lets readers and one writer work at the same time"), g.results.map((/** @type {any} */ r) => r.snippet.slice(0, 30)));
		c("the sponsored row is not among them", !allOf(g).includes("ADVERT"), allOf(g).slice(0, 300));
		c("no hint is needed, and none gets in the way", [0, 1, 2, 3, 4].every((i) => JSON.stringify(urlsOf(o.runs[`hint${i}`]).slice(0, 8)) === JSON.stringify(SEARCH_URLS)), [0, 1, 2, 3, 4].map((i) => [o.runs[`hint${i}`].detector, o.runs[`hint${i}`].results.length]));
	},
	ads(c, o) {
		const g = o.runs.generic;
		c("the general look: the eight results, in order", JSON.stringify(urlsOf(g)) === JSON.stringify(SEARCH_URLS), urlsOf(g));
		c("links wrapped by the page (/url?q=) are unwrapped", urlsOf(g).every((u) => !u.includes("/url?") && !u.includes("sa=U")), urlsOf(g));
		c("the title is the heading in the link, not the address under it", SEARCH_TITLES.every((t, i) => g.results[i].title === t), g.results.slice(0, 4).map((/** @type {any} */ r) => r.title));
		c("each with its snippet", g.results.every((/** @type {any} */ r) => r.snippet.length >= 60), g.results.map((/** @type {any} */ r) => r.snippet.slice(0, 30)));
		c("no advertisement", !allOf(g).includes("ADVERT"), allOf(g).slice(0, 300));
		c("no question block", !allOf(g).includes("PAA-"));
		c("no related search", !allOf(g).includes("RELATED"));
		c("no sub-link of a result as a result of its own", !allOf(g).includes("SITELINK"));
		c("no page number", !g.results.some((/** @type {any} */ r) => /^(\d+|Next)$/.test(r.title)));
		const h = o.runs.hint3;
		c("the google hint: the same eight, without the advertisements and the rest", JSON.stringify(urlsOf(h)) === JSON.stringify(SEARCH_URLS) && !/ADVERT|PAA-|RELATED|SITELINK/.test(allOf(h)), [h.detector, urlsOf(h)]);
	},
	bing(c, o) {
		const g = o.runs.generic;
		c("the general look: the eight results, in order", JSON.stringify(urlsOf(g)) === JSON.stringify(SEARCH_URLS), urlsOf(g));
		c("links wrapped with the address in base64 (u=a1...) are unwrapped", urlsOf(g).every((u) => !u.includes("/ck/a")), urlsOf(g));
		c("titles and snippets", SEARCH_TITLES.every((t, i) => g.results[i].title === t) && g.results.every((/** @type {any} */ r) => r.snippet.length >= 60), g.results.slice(0, 2));
		c("no advertisement, no related search, no pager", !/ADVERT|RELATED/.test(allOf(g)) && !g.results.some((/** @type {any} */ r) => /^(\d+|Next)$/.test(r.title)), allOf(g).slice(0, 300));
		const h = o.runs.hint2;
		c("the bing hint: the same eight", h.detector === "hint" && JSON.stringify(urlsOf(h)) === JSON.stringify(SEARCH_URLS) && !/ADVERT|RELATED/.test(allOf(h)), [h.detector, urlsOf(h)]);
	},
	// Run twice: in a window, and in a frame of no size. The same is expected of both.
	viewport(c, o) {
		const g = o.runs.generic;
		c("the general look: the eight results, in order", JSON.stringify(urlsOf(g)) === JSON.stringify(SEARCH_URLS), [urlsOf(g), g.hidden_removed, g.stats]);
		c("titles and snippets", SEARCH_TITLES.every((t, i) => g.results[i]?.title === t) && g.results.every((/** @type {any} */ r) => r.snippet.length >= 60), g.results.slice(0, 2));
		const h = o.runs.hint0;
		c("by hint: the same eight", h.detector === "hint" && JSON.stringify(urlsOf(h)) === JSON.stringify(SEARCH_URLS), [h.detector, urlsOf(h)]);
		c("what the page hides is in no result: a box of one pixel, a block that is not displayed", !/VIEWPORT-HIDDEN/.test(allOf(g) + allOf(h)), allOf(g).slice(-300));
		c("and was counted", g.hidden_removed >= 2, g.hidden_removed);
		// The read the job runner falls back to where it finds no list.
		const f = o.fallback;
		c("the text of the page: every title, the page's own words", f.ok === true && typeof f.text === "string" && SEARCH_TITLES.every((t) => f.text.includes(t)) && f.text.includes("Fixture Search") && f.text.includes("Privacy"), String(f.text).slice(0, 200));
		c("the address under a result, cut off at the width of its column, is text of the page", String(f.text).includes("sqlite.example.org/wal.html"), String(f.text).slice(0, 400));
		c("its links", f.links.length >= 10 && f.links.some((/** @type {any} */ l) => l.url === "https://about.example.org/privacy" && l.text === "Privacy"), f.links.length);
		c("nothing of what the page hides, in text or links", !/VIEWPORT-HIDDEN/.test(JSON.stringify(f)) && !f.links.some((/** @type {any} */ l) => l.url.includes("hidden.example.net")) && f.removed >= 2, f.removed);
	},
	two(c, o) {
		const g = o.runs.generic;
		c("two results are found, and only two: the caller falls back to the page", g.results.length === 2 && JSON.stringify(urlsOf(g)) === JSON.stringify(SEARCH_URLS.slice(0, 2)), urlsOf(g));
		c("the links in the page's own text are not made into results", !allOf(g).includes("TWO-PAGE"));
		c("a hint that finds two does not count as a list either", o.runs.hint0.results.length === 2 && o.runs.hint0.detector === "generic", o.runs.hint0.detector);
	},
	hostile(c, o) {
		const g = o.runs.generic;
		const all = allOf(g);
		// The script hands the page's words back as they are - making them harmless is the daemon's part
		// (render.js, tested there). What it must not do is hand back what no visitor sees, or what is no web address.
		c("results that are no web address are left out: script, data and ftp links, an address with credentials", !/HOSTILE-(SCRIPT|DATA|FTP|USERINFO)/.test(all) && urlsOf(g).every((u) => /^https:\/\/(evil\.example\.net|good\.example\.org)\//.test(u)), urlsOf(g));
		c("results the page does not show are left out", !/HOSTILE-(HIDDEN|OFFSCREEN)/.test(all) && !urlsOf(g).some((u) => /hidden/.test(u)), urlsOf(g));
		c("text hidden inside a visible result is left out of its title and snippet", !/HOSTILE-(TINY|TRANSPARENT)/.test(all), all.slice(-400));
		c("the same address is listed once", urlsOf(g).filter((u) => u === "https://good.example.org/real-result").length === 1 && !all.includes("HOSTILE-DUPLICATE"), urlsOf(g));
		c("the ordinary results are there", urlsOf(g).includes("https://good.example.org/real-result") && urlsOf(g).includes("https://good.example.org/second-real-result"), urlsOf(g));
		c("the second ordinary result reads as a visitor reads it", g.results.some((/** @type {any} */ r) => r.title === "HOSTILE-SEVEN A second ordinary result" && r.snippet === "Visible snippet text of the second ordinary result."), g.results.at(-1));
		c("what was hidden was counted", g.hidden_removed >= 4, g.hidden_removed);
		c("long titles and snippets are cut to the caps", g.results.some((/** @type {any} */ r) => r.title.startsWith("HOSTILE-SIX") && r.title.length <= 300 && r.snippet.length <= 500), g.results.map((/** @type {any} */ r) => [r.title.length, r.snippet.length]));
		c("seven results in all", g.results.length === 7, g.results.length);
		c("by hint: the same", JSON.stringify(urlsOf(o.runs.hint0)) === JSON.stringify(urlsOf(g)) && !/HOSTILE-(SCRIPT|DATA|FTP|USERINFO|HIDDEN|OFFSCREEN|TINY|TRANSPARENT|DUPLICATE)/.test(allOf(o.runs.hint0)), urlsOf(o.runs.hint0));
	},
};

async function main() {
	const scratch = mkdtempSync(join(process.env.BGW_SCRATCH ?? tmpdir(), "smoke-"));
	const pagesDir = join(scratch, "pages");
	mkdirSync(pagesDir);
	/** @type {Map<string, string[]>} */
	const requests = new Map();
	let current = "";
	const server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://x").pathname;
		(requests.get(current) ?? []).push(path);
		if (path === "/__bgw/defuddle.full.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(VENDOR));
		if (path === "/__bgw/extract.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(EXTRACT));
		if (path === "/__bgw/search.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(SEARCH));
		if (path === "/pixel") return void res.writeHead(200, { "content-type": "image/gif" }).end(Buffer.from("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64"));
		const m = path.match(/^\/page\/([a-z]+)\.html$/);
		if (m) return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(join(pagesDir, `${m[1]}.html`)));
		const framed = path.match(/^\/frame\/([a-z]+)\.html$/);
		if (framed) {
			return void res
				.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				.end(`<!doctype html><html><head><meta charset="utf-8"><title>frame</title></head><body><iframe src="/page/${framed[1]}.html" width="0" height="0" style="border: 0"></iframe></body></html>`);
		}
		res.writeHead(404).end("no");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
	const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;

	try {
		const fixtures = readdirSync(join(here, "fixtures")).filter((f) => f.endsWith(".html")).map((f) => basename(f, ".html")).sort().filter((f) => ONLY.length === 0 || ONLY.includes(f));
		// Some of them more than once: in a frame of no size, under another host name.
		for (const { page, name, host = "127.0.0.1", noSize = false } of fixtures.flatMap((page) => (RUNS[page] ?? [{ name: page }]).map((run) => ({ page, ...run })))) {
			writeFileSync(join(pagesDir, `${page}.html`), buildPage(readFileSync(join(here, "fixtures", `${page}.html`), "utf8"), port));
			current = name;
			requests.set(name, []);
			const url = `http://${host}:${port}/page/${page}.html`;
			const profile = join(scratch, `profile-${name}`);
			const before = failures.length;
			let out = null;
			try {
				out = parseOut(await runChromium(noSize ? `http://127.0.0.1:${port}/frame/${page}.html` : url, profile));
			} catch (e) {
				check(name, "chromium ran", false, String(e));
			}
			if (out === null) {
				if (failures.length === before) check(name, "result found in dumped DOM", false);
			} else if (noSize) {
				check(name, "the page has a viewport of no size", out.notes.viewport[0] === 0 && out.notes.viewport[1] === 0, out.notes.viewport);
				probesWithoutSize((n, ok, d) => check(name, n, ok, d), out);
			} else {
				if (SHOW) console.log(name, JSON.stringify(out, null, 1).slice(0, 6000));
				const served = (requests.get(name) ?? []).filter((p) => !p.startsWith("/page/") && !p.startsWith("/__bgw/"));
				common(name, out, url, served);
				const fn = EXPECT[name];
				if (!fn) check(name, "has expectations", false);
				else fn((n, ok, d) => check(name, n, ok, d), out);
			}
			const nf = failures.length - before;
			const r = out?.runs?.full;
			console.log(`${nf === 0 ? "PASS" : "FAIL"} ${name}${r ? ` extractor=${r.page.extractor} view=${r.extraction.view} coverage=${r.extraction.coverage_pct ?? "-"} md=${r.content.markdown?.length ?? "-"} text=${r.stats.visible_len} html=${r.content.html?.length ?? "-"} links=${r.content.links.length} words=${r.page.word_count} hidden=${r.stats.hidden_removed} ms=${r.stats.ms}` : ""}`);
		}
		// Results pages: made-up ones, in several shapes. No engine is asked.
		const pages = readdirSync(SEARCH_FIXTURES).filter((f) => f.endsWith(".html")).map((f) => basename(f, ".html")).sort().filter((f) => ONLY.length === 0 || ONLY.includes(`search${f}`));
		// One of them a second time, in a frame of no size.
		const runs = pages.flatMap((page) => (page === NO_SIZE_PAGE ? [{ page, noSize: false }, { page, noSize: true }] : [{ page, noSize: false }]));
		for (const { page, noSize } of runs) {
			const file = `search${page}`;
			const name = noSize ? `${file}-nosize` : file;
			writeFileSync(join(pagesDir, `${file}.html`), buildSearchPage(readFileSync(join(SEARCH_FIXTURES, `${page}.html`), "utf8"), port));
			current = name;
			requests.set(name, []);
			const url = `http://127.0.0.1:${port}/page/${file}.html`;
			const before = failures.length;
			let out = null;
			try {
				out = parseOut(await runChromium(noSize ? `http://127.0.0.1:${port}/frame/${file}.html` : url, join(scratch, `profile-${name}`)));
			} catch (e) {
				check(name, "chromium ran", false, String(e));
			}
			if (out === null) {
				if (failures.length === before) check(name, "result found in dumped DOM", false);
			} else {
				if (SHOW) console.log(name, JSON.stringify(out, null, 1).slice(0, 9000));
				const served = (requests.get(name) ?? []).filter((p) => !p.startsWith("/page/") && !p.startsWith("/frame/") && !p.startsWith("/__bgw/"));
				// The run in the frame is only worth something when the frame really has no size.
				const [w, h] = out.notes.viewport;
				check(name, noSize ? "the page has a viewport of no size" : "the page has a viewport with a size", noSize ? w === 0 && h === 0 : w > 0 && h > 0, out.notes.viewport);
				commonSearch(name, out, url, served);
				const fn = EXPECT_SEARCH[page];
				if (!fn) check(name, "has expectations", false);
				else fn((n, ok, d) => check(name, n, ok, d), out);
			}
			const g = out?.runs?.generic;
			const hints = out === null ? "" : [0, 1, 2, 3, 4].map((i) => `${HINT_NAMES[i]}=${out.runs[`hint${i}`].stats.hint}`).join(" ");
			console.log(`${failures.length === before ? "PASS" : "FAIL"} ${name}${g ? ` results=${g.results.length} generic=${g.stats.generic} with_snippet=${g.results.filter((/** @type {any} */ r) => r.snippet !== "").length} hidden=${g.hidden_removed} ms=${g.stats.ms} by_hint: ${hints}` : ""}`);
		}
	} finally {
		server.close();
		rmSync(scratch, { recursive: true, force: true });
	}
	for (const f of failures) console.log(`  FAILED ${f}`);
	for (const g of gaps) console.log(`  KNOWN GAP ${g}`);
	console.log(`${passes} checks passed, ${failures.length} failed`);
	process.exit(failures.length === 0 ? 0 : 1);
}

await main();
