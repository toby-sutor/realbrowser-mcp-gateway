// content/search.js: the decisions that need no page - what a wrapped link
// leads to, what counts as a label, how a list is finished. The look at a
// results page itself runs in real browsers (tests/browser-smoke and
// tests/integration), on pages made up for it. No engine is ever asked.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { SEARCH_HINTS } from "../../extension/background/jobs.js";
import { LIMITS } from "../../extension/shared/protocol.js";
import { siteOf as sharedSiteOf } from "../../extension/shared/site.js";
import { SECOND_LEVEL_LABELS } from "../../extension/shared/suffixes.js";

const SOURCE = fs.readFileSync(fileURLToPath(new URL("../../extension/content/search.js", import.meta.url)), "utf8");
const EXTRACT = fs.readFileSync(fileURLToPath(new URL("../../extension/content/extract.js", import.meta.url)), "utf8");

/** Load the script the way executeScript does: into a world of its own, for its side effect. */
function load() {
	const context = vm.createContext({ URL, atob });
	const completion = vm.runInContext(SOURCE, context);
	const fn = /** @type {any} */ (context).__bgwSearch;
	return { context, completion, fn, internals: fn.internals };
}

test("search.js: loading it defines one function and nothing else", () => {
	const { context, completion, fn } = load();
	assert.equal(completion, undefined, "nothing to hand back to executeScript");
	assert.deepEqual(Object.keys(context).filter((k) => k !== "URL" && k !== "atob"), ["__bgwSearch"]);
	assert.equal(typeof fn, "function");
	vm.runInContext(SOURCE, context);
	assert.deepEqual(Object.keys(context).filter((k) => k !== "URL" && k !== "atob"), ["__bgwSearch"]);
	// Without the extractor's clone there is nothing to look at: it says so instead of reading the live page.
	assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("performance = { now: () => 0 }; __bgwSearch({ limit: 5, hint: 0 })", context))), { ok: false });
	// The extractor offers that clone, and only to a script in its own world.
	// It is the clone the extractor itself reads, without what a page keeps for a browser that runs no scripts.
	assert.match(EXTRACT, /extract\.prepare = \(\/\*\* @type \{unknown\} \*\/ maxElements\) => \{\n\t\tconst prepared = prepare\(intOpt\(maxElements, MAX_ELEMENTS, MAX_ELEMENTS\)\);\n\t\tdropNoscript\(prepared\.clone\);\n\t\treturn prepared;\n\t\};/);
});

test("search.js only reads: no input to the page, no network, no storage, no eval", () => {
	const code = SOURCE.replace(/\/\/.*$/gm, "");
	const banned = [".click(", "dispatchEvent", "new MouseEvent", "new KeyboardEvent", "new InputEvent", "new PointerEvent", ".focus(", ".blur(", ".submit(", "scrollBy", "scrollTo", "scrollIntoView", "scrollTop", "execCommand", ".value =", "innerHTML", "outerHTML", "document.write", "document.cookie", "localStorage", "sessionStorage", "indexedDB", "eval(", "new Function", "wrappedJSObject", "fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "import(", "browser.", "chrome.", "setTimeout", "setInterval", "postMessage", "addEventListener", ".remove(", "appendChild", ".append(", "setAttribute", "createElement"];
	for (const word of banned) assert.equal(code.includes(word), false, `search.js must not use ${word}`);
	// The live document is asked for three things: its address, its base address, its title.
	assert.deepEqual([...new Set([...code.matchAll(/\bdocument\.([A-Za-z]+)/g)].map((m) => m[1]))].sort(), ["baseURI", "title"]);
	assert.deepEqual([...new Set([...code.matchAll(/\blocation\.([A-Za-z]+)/g)].map((m) => m[1]))].sort(), ["hostname", "href"]);
});

test("the hints are the engines the background page knows, in the same order - and nothing but selectors", () => {
	const { internals } = load();
	const hints = JSON.parse(JSON.stringify(internals.HINTS));
	assert.deepEqual(hints.map((/** @type {any} */ h) => h.name), [...SEARCH_HINTS]);
	for (const hint of hints) {
		assert.deepEqual(Object.keys(hint).sort(), ["block", "name", "snippet", "title"]);
		for (const key of ["block", "title", "snippet"]) {
			assert.equal(typeof hint[key], "string");
			assert.ok(hint[key].length > 0 && hint[key].length < 200, `${hint.name}.${key}`);
			assert.equal(/[<>{};]|url\(|javascript:/i.test(hint[key]), false, `${hint.name}.${key} is a selector and nothing else`);
		}
	}
});

test("unwrapRedirect: the target of a link the results page wrapped - and only of such a link", () => {
	const { internals } = load();
	/** @param {string} href @param {string} [site] @returns {string | null} */
	const unwrap = (href, site = "duckduckgo.com") => {
		const out = internals.unwrapRedirect(new URL(href), site);
		return out === null ? null : out.href;
	};
	// uddg=: the address written out, percent-encoded.
	assert.equal(unwrap("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa%3Fb%3Dc%26d%3De&rut=abc"), "https://example.org/a?b=c&d=e");
	assert.equal(unwrap("https://html.duckduckgo.com/l/?kh=-1&uddg=https%3A%2F%2Fexample.org%2F"), "https://example.org/");
	assert.equal(unwrap("https://duckduckgo.com/l?uddg=http%3A%2F%2Fexample.org%2Fplain"), "http://example.org/plain");
	assert.equal(unwrap("https://duckduckgo.com/anything?uddg=https%3A%2F%2Fexample.org%2Fx"), "https://example.org/x");
	// /url?q= and /url?url=
	assert.equal(unwrap("https://www.google.com/url?q=https://example.org/page%3Fid%3D7&sa=U&ved=2ah", "google.com"), "https://example.org/page?id=7");
	assert.equal(unwrap("https://www.google.com/url?url=https%3A%2F%2Fexample.org%2F&rct=j", "google.com"), "https://example.org/");
	assert.equal(unwrap("https://www.google.co.uk/url?q=https://example.org/", "google.co.uk"), "https://example.org/");
	// u= with the address in base64, with and without the "a1" in front, with and without padding.
	const b64 = Buffer.from("https://example.org/path?x=1&y=2").toString("base64url");
	assert.equal(unwrap(`https://www.bing.com/ck/a?!&&p=abc&u=a1${b64}&ntb=1`, "bing.com"), "https://example.org/path?x=1&y=2");
	assert.equal(unwrap(`https://www.bing.com/ck/a?u=${Buffer.from("https://example.org/").toString("base64")}`, "bing.com"), "https://example.org/");
	assert.equal(unwrap("https://www.bing.com/ck/a?u=https%3A%2F%2Fexample.org%2Fwritten-out", "bing.com"), "https://example.org/written-out");
	// A "/l/" hop of any engine that names its target outright.
	assert.equal(unwrap("https://search.example.com/l/?u=https%3A%2F%2Fexample.org%2Fz", "example.com"), "https://example.org/z");

	// What is no web address is no target.
	for (const target of ["javascript:alert(1)", "data:text/html,x", "ftp://example.org/f", "file:///etc/passwd", "//example.org/x", "/relative", "example.org", "", "https://user:pw@example.org/"]) {
		assert.equal(unwrap(`https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`), null, target);
		assert.equal(unwrap(`https://www.google.com/url?q=${encodeURIComponent(target)}`, "google.com"), null, target);
	}
	for (const packed of ["a1!!!", "a1", `a1${Buffer.from("javascript:alert(1)").toString("base64url")}`, `a1${Buffer.from("not an address").toString("base64url")}`, `a1${Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]).toString("base64url")}`]) {
		assert.equal(unwrap(`https://www.bing.com/ck/a?u=${packed}`, "bing.com"), null, packed);
	}
	// A link that is not the results page's own is a result as it stands, whatever it carries.
	assert.equal(unwrap("https://tracker.example.net/l/?uddg=https%3A%2F%2Fexample.org%2F"), null);
	assert.equal(unwrap("https://example.org/login?url=https%3A%2F%2Fevil.example.net%2F", "duckduckgo.com"), null);
	assert.equal(unwrap("https://www.google.com/url?q=https://example.org/", "duckduckgo.com"), null);
	// And a link of the results page that wraps nothing is just one of its own links.
	for (const own of ["https://duckduckgo.com/?q=next+page", "https://duckduckgo.com/settings", "https://duckduckgo.com/y.js?ad_domain=example.com&u3=aHR0cHM6Ly9hZHMuZXhhbXBsZS5jb20v", "https://duckduckgo.com/search?u=https%3A%2F%2Fexample.org%2F", "https://duckduckgo.com/l/", "https://duckduckgo.com/l/?uddg="]) {
		assert.equal(unwrap(own), null, own);
	}
});

test("siteOf agrees with the gateway's own notion of a site", () => {
	const { internals } = load();
	// The content script cannot import the shared code and keeps a short copy. For the hosts results pages
	// are on, and for ordinary sites, the two must give the same answer.
	const same = [
		"duckduckgo.com", "html.duckduckgo.com", "lite.duckduckgo.com", "www.google.com", "www.google.co.uk", "www.google.com.au", "www.google.de", "search.brave.com", "www.bing.com",
		"www.startpage.com", "search.yahoo.co.jp", "a.b.c.example.org", "example.com.au", "x.example.net.br", "x.example.gov.uk", "x.example.ac.jp", "x.example.edu.au", "x.co.example.com",
		"example.de", "www.example.de", "a.example.blog.fr", "co.uk", "uk", "localhost", "search.localhost", "127.0.0.1", "93.184.216.34", "EXAMPLE.org.", "WWW.Example.CO.UK.",
	];
	for (const host of same) assert.equal(internals.siteOf(host), sharedSiteOf(host), host);
	// Where the shared table knows a name that many owners share, the copy does not: there it may only
	// answer with the larger site - the shared answer, or a name above it. A copy that drifts any other
	// way (another label kept, another spelling) fails here.
	const coarser = [
		"a.github.io", "x.y.github.io", "shop.myshopify.com", "x.blogspot.de", "x.uk.com", "x.ne.jp", "www.x.or.jp", "b.gv.at", "x.id.au", "www.x.gouv.fr", "www.metro.tokyo.jp",
		"x.s3.amazonaws.com", "bucket.s3.eu-west-1.amazonaws.com", "acct.blob.core.windows.net", "a.b.example.sport.np", "www.ci.sf.ca.us",
	];
	for (const host of coarser) {
		const copy = internals.siteOf(host);
		const shared = sharedSiteOf(host);
		assert.notEqual(copy, shared, `${host}: once the copy knows this name it belongs in the list above`);
		assert.ok(shared.endsWith(`.${copy}`), `${host}: ${copy} is not above ${shared}`);
		assert.ok(host.endsWith(copy), host);
	}
	// An address is no name. IPv4: itself, in both. IPv6: the copy takes the address, the shared code its
	// network - which is the same thing to a results page, since both differ from every other host.
	assert.equal(internals.siteOf("[2001:db8::1]"), "[2001:db8::1]");
	assert.equal(sharedSiteOf("[2001:db8::1]"), "[2001:db8:0:0::/64]");
	// The copy's labels are all in the shared table.
	const labels = /const SECOND_LEVEL = new Set\(\[([^\]]*)\]\)/.exec(SOURCE);
	assert.ok(labels !== null, "the copy's list of second-level labels was found");
	for (const label of [...labels[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1])) assert.equal(SECOND_LEVEL_LABELS.has(label), true, label);
});

test("labels: what marks an advertisement, a block that is no result, a pager, an address", () => {
	const { internals } = load();
	const { hasWord, AD_WORDS, NOISE_WORDS, AD_BADGE, SECTION_LABEL, PAGER, URL_LIKE } = internals;
	// A word of its own between spaces, hyphens and underscores - not a part of another word.
	for (const names of ["ad", "result--ad", "b_ad", "ads", "top-ads", "sponsored", "result result-sponsored", "js-sponsored-link", "Ads", "ad_block", "promoted item", "tads ads-container"]) assert.equal(hasWord(names, AD_WORDS), true, names);
	for (const names of ["result", "header", "shadow", "badge", "loaded", "download", "adaptive", "masthead", "padding", "readmore", "tads", "thread", "upload-address", ""]) assert.equal(hasWord(names, AD_WORDS), false, names);
	for (const names of ["related", "related-searches", "pagination", "b_pag pager", "sitelinks", "result__sitelink", "paa"]) assert.equal(hasWord(names, NOISE_WORDS), true, names);
	for (const names of ["result", "unrelated", "pagecontent", "site", "links_main", "web-result"]) assert.equal(hasWord(names, NOISE_WORDS), false, names);
	assert.equal(hasWord("ad ".repeat(200), AD_WORDS), false, "a value too long to be a name is not looked at");
	for (const text of ["Ad", "Ads", "AD", "Sponsored", "Anzeige", "Promoted", "Ad ·", "Sponsored:", "Werbung"]) assert.equal(AD_BADGE.test(text), true, text);
	for (const text of ["Add", "Adobe", "Ad blockers explained", "Sponsored by the foundation", "Advertising standards", ""]) assert.equal(AD_BADGE.test(text), false, text);
	for (const text of ["People also ask", "people also search for", "Related searches", "Related searches:", "Searches related to sqlite wal", "Others also searched for", "Ähnliche Suchanfragen", "Recherches associées"]) assert.equal(SECTION_LABEL.test(text), true, text);
	for (const text of ["Related work on write-ahead logging", "People also ask why WAL is faster - a survey", "Web results", "Results", "Search", ""]) assert.equal(SECTION_LABEL.test(text), false, text);
	for (const text of ["1", "2", "10", "Next", "next", "Previous", "More results", "›", "»", ">", "Weiter"]) assert.equal(PAGER.test(text), true, text);
	for (const text of ["Next.js documentation", "1984 (novel)", "More than you wanted to know", "2001: A Space Odyssey", "C"]) assert.equal(PAGER.test(text), false, text);
	for (const text of ["https://example.org/a/b", "example.org", "www.example.org › docs › api", "example.co.uk/path", "docs.example.com > guides"]) assert.equal(URL_LIKE.test(text), true, text);
	for (const text of ["The default method by which SQLite implements atomic commit.", "Version 3.7.0 added it.", "example", "A sentence about example.org and others."]) assert.equal(URL_LIKE.test(text), false, text);
});

test("finishing a list: each address once, numbered from one, no more than asked for; text on one line within the caps", () => {
	const { internals } = load();
	const found = [
		{ title: "First", url: "https://example.org/a", snippet: "one" },
		{ title: "The same again", url: "https://example.org/a", snippet: "dup" },
		{ title: "With a fragment", url: "https://example.org/a#section", snippet: "dup" },
		{ title: "With a slash", url: "https://example.org/a/", snippet: "dup" },
		{ title: "Second", url: "https://example.org/b", snippet: "two" },
		{ title: "Third", url: "https://example.net/a", snippet: "three" },
	];
	assert.deepEqual(JSON.parse(JSON.stringify(internals.finish(found, 20))), [
		{ rank: 1, title: "First", url: "https://example.org/a", snippet: "one" },
		{ rank: 2, title: "Second", url: "https://example.org/b", snippet: "two" },
		{ rank: 3, title: "Third", url: "https://example.net/a", snippet: "three" },
	]);
	assert.equal(internals.finish(found, 2).length, 2);
	assert.equal(internals.finish([], 10).length, 0);
	assert.equal(internals.line("  a\n\tb\u0000 c  ", 100), "a b c");
	assert.equal(internals.line("x".repeat(1000), LIMITS.MAX_RESULT_TITLE).length, LIMITS.MAX_RESULT_TITLE);
	assert.equal(internals.line(`${"x".repeat(299)}\u{1F600}`, 300), "x".repeat(299), "no half of a pair at the cut");
	assert.equal(internals.line(5, 10), "");
	assert.equal(internals.fromBase64("aHR0cHM6Ly9leGFtcGxlLm9yZy8"), "https://example.org/");
	assert.equal(internals.fromBase64("short"), null);
	assert.equal(internals.fromBase64("!!!!!!!!!!"), null);
});
