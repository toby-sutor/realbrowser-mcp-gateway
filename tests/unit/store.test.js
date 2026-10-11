import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PAGE_STORE, PageStore, StoreError, buildFtsQuery, cleanExtraction, idTime, isValidPageId, newPageId, PAGE_ID_RE, searchBody } from "../../daemon/src/store.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { counterBytes, makeRecord, openStore, quietLog } from "../helpers/pages.js";
import { zeroTimings } from "../../extension/shared/protocol.js";

const MIN = 60000;

/** @param {string} p */
const mode = (p) => fs.statSync(p).mode & 0o777;

/** @param {string} dir @returns {string[]} every path below dir, relative */
function walk(dir) {
	/** @type {string[]} */
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
		out.push(path.relative(dir, path.join(e.parentPath, e.name)));
	}
	return out.sort();
}

/** @param {string} dir @param {string} id */
const pageDir = (dir, id) => path.join(dir, "pages", id.slice(-2), id);

test("page ids are pg_ + 26 Crockford chars and encode the time", () => {
	const id = newPageId(Date.UTC(2026, 9, 5), counterBytes());
	assert.match(id, PAGE_ID_RE);
	assert.equal(id.length, 29);
	const other = newPageId(Date.UTC(2026, 9, 5, 0, 0, 1), counterBytes());
	assert.ok(other > id, "later time sorts later");
	assert.throws(() => newPageId(-1, counterBytes()), RangeError);
	assert.throws(() => newPageId(2 ** 48, counterBytes()), RangeError);
	assert.throws(() => newPageId(1, () => new Uint8Array(3)), RangeError);
});

test("layout and modes: dirs 0700, files 0600, no temp leftovers", (t) => {
	const { dir, store } = openStore(t);
	const { id, meta } = store.save(makeRecord());
	assert.match(id, PAGE_ID_RE);
	assert.equal(mode(dir), 0o700);
	assert.equal(mode(path.join(dir, "pages")), 0o700);
	assert.equal(mode(path.join(dir, "pages", id.slice(-2))), 0o700);
	const pd = pageDir(dir, id);
	assert.equal(mode(pd), 0o700);
	for (const f of ["content.md", "page.html.gz", "meta.json", "links.json"]) {
		assert.equal(mode(path.join(pd, f)), 0o600, f);
	}
	assert.deepEqual(fs.readdirSync(pd).sort(), ["content.md", "links.json", "meta.json", "page.html.gz"]);
	assert.equal(mode(path.join(dir, "index.db")), 0o600);
	for (const p of walk(dir)) {
		assert.ok(!p.includes(".tmp-"), `leftover ${p}`);
		const st = fs.lstatSync(path.join(dir, p));
		if (st.isFile()) assert.equal(st.mode & 0o777, 0o600, p);
		if (st.isDirectory()) assert.equal(st.mode & 0o777, 0o700, p);
	}
	assert.equal(meta.fetched_at, "2026-10-05T19:44:02Z");
});

test("meta.json carries every field", (t) => {
	const { dir, store } = openStore(t);
	const rec = makeRecord({ url: "HTTPS://Example.COM/a#frag" });
	const { id } = store.save(rec);
	const meta = JSON.parse(fs.readFileSync(path.join(pageDir(dir, id), "meta.json"), "utf8"));
	assert.equal(meta.id, id);
	assert.equal(meta.url, "https://example.com/a#frag");
	assert.equal(meta.host, "example.com");
	assert.equal(meta.final_url, "https://example.com/article/a");
	assert.equal(meta.http_status, 200);
	assert.equal(meta.title, "Example article");
	assert.equal(meta.author, "A. Writer");
	assert.equal(meta.published, "2026-10-01");
	assert.equal(meta.lang, "en");
	assert.equal(meta.site, "Example");
	assert.equal(meta.word_count, 5);
	assert.equal(meta.content_chars, /** @type {string} */ (rec.markdown).length);
	assert.match(meta.content_sha256, /^[0-9a-f]{64}$/);
	assert.equal(meta.extractor, "defuddle@0.19.4");
	assert.equal(meta.cookie_scope, "container");
	assert.equal(meta.outcome, "ok");
	assert.deepEqual(meta.redirect_origins, ["https://example.com"]);
	assert.equal(meta.render.visibility, "visible");
	assert.deepEqual(meta.truncated, { markdown: false, text: false, html: false, raw_html: false });
	// No visible text of its own and nothing known about the extraction: said so, not left out.
	assert.equal(meta.text_chars, null);
	assert.equal(meta.extraction, null);
	assert.equal(meta.stored, true);
	assert.deepEqual(store.getMeta(id), meta);
});

const THREAD = {
	markdown: "# Best way to cache queries?\n\nFORUMOP the question as the article view has it.",
	text: "Forum home\nBest way to cache queries?\nFORUMOP the question as the article view has it.\nFORUMREPLY enable WAL mode, says the first reply.\nFORUMREPLYTWO agreed, says the second.",
};

test("the visible text is stored next to the Markdown, with the facts of the extraction", (t) => {
	const { dir, store } = openStore(t);
	const extraction = { view: /** @type {const} */ ("article"), coverage_pct: 41, hidden_removed: 3, capped: false };
	const { id, meta } = store.save(makeRecord({ ...THREAD, extraction, truncated: { markdown: false, text: true, html: false, raw_html: false } }));
	const pd = pageDir(dir, id);
	assert.deepEqual(fs.readdirSync(pd).sort(), ["content.md", "content.txt", "links.json", "meta.json", "page.html.gz"]);
	assert.equal(mode(path.join(pd, "content.txt")), 0o600);
	assert.equal(fs.readFileSync(path.join(pd, "content.txt"), "utf8"), THREAD.text);
	assert.equal(store.readBody(id, "text"), THREAD.text);
	assert.equal(store.readBody(id, "markdown"), THREAD.markdown);
	const full = /** @type {import("../../daemon/src/store.js").PageMeta} */ (meta);
	assert.equal(full.text_chars, THREAD.text.length);
	assert.equal(full.content_chars, THREAD.markdown.length, "content_chars and the hash stay those of the Markdown");
	assert.deepEqual(full.extraction, extraction);
	assert.deepEqual(full.truncated, { markdown: false, text: true, html: false, raw_html: false });
	assert.deepEqual(store.getMeta(id), meta);

	// A view that is the text itself comes without a second copy.
	const plain = store.save(makeRecord({ markdown: "just the visible text", text: null, extraction: { view: "text", coverage_pct: null, hidden_removed: 0, capped: false } }));
	assert.equal(store.readBody(plain.id, "text"), null);
	assert.equal(fs.existsSync(path.join(pageDir(dir, plain.id), "content.txt")), false);
	assert.equal(/** @type {any} */ (plain.meta).text_chars, null);
	assert.equal(/** @type {any} */ (plain.meta).extraction.view, "text");

	// A page of the operator's own session: no text file, and nothing about the extraction either.
	const priv = store.save(makeRecord({ ...THREAD, extraction, cookie_scope: "default" }));
	assert.deepEqual(fs.readdirSync(pageDir(dir, priv.id)), ["meta.json"]);
	assert.equal(store.readBody(priv.id, "text"), null);
	assert.deepEqual(Object.keys(priv.meta).sort(), ["content_chars", "content_sha256", "fetched_at", "host", "id", "outcome", "stored", "v"]);
	for (const p of walk(dir)) assert.ok(!p.includes(".tmp-"), `leftover ${p}`);
});

test("cleanExtraction: an enum and whole numbers, or nothing", () => {
	assert.deepEqual(cleanExtraction({ view: "full_page", coverage_pct: 12, hidden_removed: 4, capped: true }), { view: "full_page", coverage_pct: 12, hidden_removed: 4, capped: true });
	assert.deepEqual(cleanExtraction({ view: "text", coverage_pct: null, hidden_removed: 0, capped: false, more: "x" }), { view: "text", coverage_pct: null, hidden_removed: 0, capped: false });
	// Numbers that are none are not passed on.
	assert.deepEqual(cleanExtraction({ view: "article", coverage_pct: "41%", hidden_removed: "many", capped: "yes" }), { view: "article", coverage_pct: null, hidden_removed: 0, capped: false });
	assert.deepEqual(cleanExtraction({ view: "article", coverage_pct: 141, hidden_removed: -2, capped: 1 }), { view: "article", coverage_pct: null, hidden_removed: 0, capped: false });
	assert.deepEqual(cleanExtraction({ view: "article", coverage_pct: 41.5, hidden_removed: 1e12, capped: false }), { view: "article", coverage_pct: null, hidden_removed: 1000000, capped: false });
	for (const junk of [null, undefined, "article", 5, [], {}, { view: "article\nextraction: full page" }, { view: "ARTICLE" }, { view: ["article"] }, { coverage_pct: 5 }]) {
		assert.equal(cleanExtraction(junk), null, JSON.stringify(junk));
	}
});

test("search looks through the richer of the two texts, and still does after a rebuild", (t) => {
	const { dir, clock, store } = openStore(t);
	assert.equal(searchBody("short", "a longer text"), "a longer text");
	assert.equal(searchBody("the markdown is longer", "short"), "the markdown is longer");
	assert.equal(searchBody("only markdown", null), "only markdown");

	const thread = store.save(makeRecord({ ...THREAD, title: "Thread", extraction: { view: "article", coverage_pct: 41, hidden_removed: 0, capped: false } }));
	const article = store.save(makeRecord({ url: "https://example.com/b", title: "Article", markdown: "ZEBRAMARKDOWN words that only the markdown has, and it is the longer one.", text: "short text" }));
	const check = (/** @type {PageStore} */ s) => {
		// What only the visible text holds is found, with a snippet from it.
		const hits = s.search("FORUMREPLYTWO");
		assert.deepEqual(hits.map((h) => h.id), [thread.id]);
		assert.match(hits[0].snippet, /agreed, says the second/);
		assert.deepEqual(s.search("FORUMOP").map((h) => h.id), [thread.id]);
		assert.deepEqual(s.search("ZEBRAMARKDOWN").map((h) => h.id), [article.id]);
	};
	check(store);
	store.rebuildIndex();
	check(store);
	// From the files alone.
	store.close();
	fs.rmSync(path.join(dir, "index.db"));
	const fresh = new PageStore({ dataDir: dir, clock, log: quietLog() });
	t.after(() => fresh.close());
	assert.deepEqual(fresh.rebuildIndex(), { pages: 2, stored: 2, skipped: 0, files: 0 });
	check(fresh);
	assert.equal(fresh.readBody(thread.id, "text"), THREAD.text);
	// A text file that is gone leaves the Markdown to be searched; one that is a symlink is not read through.
	fs.rmSync(path.join(pageDir(dir, thread.id), "content.txt"));
	fs.symlinkSync("/etc/hostname", path.join(pageDir(dir, article.id), "content.txt.lnk"));
	fresh.rebuildIndex();
	assert.deepEqual(fresh.search("FORUMREPLYTWO"), []);
	assert.deepEqual(fresh.search("FORUMOP").map((h) => h.id), [thread.id]);
	assert.equal(fresh.readBody(thread.id, "text"), null);
	const outside = path.join(dir, "outside.txt");
	fs.writeFileSync(outside, "SECRETOUTSIDE");
	fs.symlinkSync(outside, path.join(pageDir(dir, thread.id), "content.txt"));
	assert.equal(fresh.readBody(thread.id, "text"), null, "never through a symlink");
	fresh.rebuildIndex();
	assert.deepEqual(fresh.search("SECRETOUTSIDE"), []);
});

test("bodies round-trip: markdown with multi-byte text, html, links", (t) => {
	const { store } = openStore(t);
	const md = "# Gruesse\n\nUeberschrift: \u00e4\u00f6\u00fc \u65e5\u672c\u8a9e \u{1f600}\n";
	const { id } = store.save(makeRecord({ markdown: md, html: "<p>\u00e4</p>" }));
	assert.equal(store.readBody(id, "markdown"), md);
	assert.equal(store.readBody(id, "html"), "<p>\u00e4</p>");
	assert.deepEqual(store.readLinks(id), [{ url: "https://example.com/next", text: "Next page" }]);
	assert.equal(store.readBody(id, "text"), null, "no visible text of its own was saved");
	assert.throws(() => store.readBody(id, /** @type {any} */ ("pdf")), StoreError);
});

test("a page without html or links has no such files", (t) => {
	const { dir, store } = openStore(t);
	const { id } = store.save(makeRecord({ html: null, raw_html: null, links: [] }));
	assert.deepEqual(fs.readdirSync(pageDir(dir, id)).sort(), ["content.md", "meta.json"]);
	assert.equal(store.readBody(id, "html"), null);
	assert.equal(store.readLinks(id), null);
});

test("atomic: an id collision fails cleanly and leaves the first page intact", (t) => {
	const { dir, store } = openStore(t, { randomBytes: () => new Uint8Array(10).fill(7) });
	const first = store.save(makeRecord());
	assert.throws(() => store.save(makeRecord({ markdown: "second" })), StoreError);
	assert.equal(store.readBody(first.id, "markdown"), makeRecord().markdown);
	for (const p of walk(dir)) assert.ok(!p.includes(".tmp-"), `leftover ${p}`);
	assert.equal(store.stats().pages, 1);
});

test("atomic: a page directory only appears complete", (t) => {
	const { dir, store } = openStore(t);
	const realRename = fs.renameSync;
	/** @type {string[][]} */
	const seen = [];
	t.mock.method(fs, "renameSync", (/** @type {fs.PathLike} */ from, /** @type {fs.PathLike} */ to) => {
		// Right before the page becomes visible, the final directory does not exist yet.
		assert.equal(fs.existsSync(String(to)), false);
		assert.ok(path.basename(String(from)).startsWith(".tmp-"));
		seen.push(fs.readdirSync(String(from)).sort());
		return realRename(from, to);
	});
	store.save(makeRecord());
	assert.deepEqual(seen, [["content.md", "links.json", "meta.json", "page.html.gz"]]);
	assert.ok(!walk(dir).some((p) => p.includes(".tmp-")));
});

test("atomic: a write failure leaves nothing behind and no index row", (t) => {
	const { dir, store } = openStore(t);
	t.mock.method(fs, "fsyncSync", () => {
		throw new Error("disk full");
	});
	assert.throws(() => store.save(makeRecord()), /disk full/);
	t.mock.restoreAll();
	assert.ok(!walk(path.join(dir, "pages")).some((p) => p.includes(".tmp-") || p.includes("pg_")));
	assert.equal(store.stats().pages, 0);
});

test("no-store rule: a page fetched outside the container leaves a bare record and a bare index row", (t) => {
	const { dir, store } = openStore(t);
	const md = "secret zebra token page";
	const rec = makeRecord({
		url: "https://private.example.com/inbox/thread-4711?session=SECRETQUERY#frag",
		final_url: "https://private.example.com/inbox/thread-4711/view?token=FINALSECRET",
		title: "Re: Offer for Mr PRIVATETITLE",
		author: "PRIVATEAUTHOR",
		published: "2026-10-01T12:34:56Z",
		lang: "x-PRIVATELANG",
		site: "PRIVATESITE",
		word_count: 987654321,
		extractor: "defuddle@0.19.4+PRIVATEEXTRACTOR",
		redirect_origins: ["https://sso.PRIVATEREDIRECT.example"],
		render: { visibility: "hidden", raf_hz: 47.11, settled: true, scrolled_px: 876543219, scroll: "off", dwell: "off", elapsed_ms: 765432198, timings: zeroTimings() },
		truncated: { markdown: true, text: false, html: true },
		http_status: 203,
		cookie_scope: "default",
		markdown: md,
		html: "<p>zebra</p>",
		links: [{ url: "https://private.example.com/PRIVATELINK", text: "PRIVATELINKTEXT" }],
	});
	const { id, meta } = store.save(rec);
	const expected = {
		v: 1,
		id,
		host: "private.example.com",
		fetched_at: "2026-10-05T19:44:02Z",
		content_chars: md.length,
		content_sha256: String(meta.content_sha256),
		outcome: "ok",
		stored: false,
	};
	assert.match(expected.content_sha256, /^[0-9a-f]{64}$/);
	assert.deepEqual(meta, expected, "id, host, time, hash, length, outcome and stored: false - nothing else");
	assert.deepEqual(fs.readdirSync(pageDir(dir, id)), ["meta.json"]);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pageDir(dir, id), "meta.json"), "utf8")), expected);
	assert.deepEqual(store.getMeta(id), expected);
	assert.equal(store.readBody(id, "markdown"), null);
	assert.equal(store.readBody(id, "html"), null);
	assert.equal(store.readLinks(id), null);
	assert.deepEqual(store.search("zebra"), []);
	assert.deepEqual(store.search("PRIVATETITLE"), [], "the title is not searchable either");
	assert.equal(store.findFresh(rec.url, { maxAgeMs: MIN }), null);
	assert.deepEqual(store.stats(), { pages: 1, stored: 0, files: 0, file_bytes: 0, file_bytes_max: 2147483648 });

	// The index row holds the same and no more.
	store.close();
	const db = new DatabaseSync(path.join(dir, "index.db"));
	const rows = db.prepare("SELECT * FROM pages").all();
	const fts = db.prepare("SELECT COUNT(*) AS n FROM pages_fts").get();
	db.close();
	assert.equal(rows.length, 1);
	assert.deepEqual({ ...rows[0] }, {
		id,
		url: "",
		host: "private.example.com",
		fetched_at: "2026-10-05T19:44:02Z",
		fetched_ms: Date.UTC(2026, 9, 5, 19, 44, 2),
		title: "",
		outcome: "ok",
		cookie_scope: null,
		stored: 0,
		content_chars: md.length,
		content_sha256: expected.content_sha256,
		// What the record takes: its meta.json, and nothing in the index.
		bytes: fs.statSync(path.join(pageDir(dir, id), "meta.json")).size,
	});
	assert.equal(fts?.n, 0);

	// Nothing of the body, the path, the query, the title, the author, the site,
	// the redirects or the render details anywhere under the data dir.
	const needles = ["zebra", "thread-4711", "SECRETQUERY", "FINALSECRET", "PRIVATE", "987654321", "876543219", "765432198", "sso.", "defuddle"];
	for (const f of walk(dir)) {
		const full = path.join(dir, f);
		if (!fs.statSync(full).isFile()) continue;
		const bytes = fs.readFileSync(full);
		for (const needle of needles) assert.ok(!bytes.includes(needle), `${needle} in ${f}`);
	}
});

test("no-store rule fails closed: a null scope leaves a bare record too", (t) => {
	const { store } = openStore(t);
	const { meta } = store.save(makeRecord({ cookie_scope: null }));
	assert.equal(meta.stored, false);
	assert.deepEqual(Object.keys(meta).sort(), ["content_chars", "content_sha256", "fetched_at", "host", "id", "outcome", "stored", "v"]);
	assert.equal(store.readBody(meta.id, "markdown"), null);
});

test("no-store rule: rebuild and purge treat bare records like any other page", (t) => {
	const { dir, clock, store } = openStore(t);
	const kept = store.save(makeRecord({ markdown: "public words" }));
	const bare = store.save(makeRecord({ url: "https://private.example.com/x?y=SECRETQUERY", cookie_scope: "default", title: "PRIVATETITLE", markdown: "private words" }));
	// A full record written before the no-store rule for a page outside the container: indexed as bare.
	const oldId = "pg_" + "0".repeat(24) + "ZZ";
	fs.mkdirSync(pageDir(dir, oldId), { recursive: true });
	fs.writeFileSync(
		path.join(pageDir(dir, oldId), "meta.json"),
		JSON.stringify({ v: 1, id: oldId, url: "https://old.example.com/p?q=OLDSECRET", host: "old.example.com", fetched_at: "2026-10-05T19:44:02Z", title: "OLDTITLE", content_chars: 3, content_sha256: null, cookie_scope: "default", outcome: "ok", stored: false }),
	);
	assert.deepEqual(store.rebuildIndex(), { pages: 3, stored: 1, skipped: 0, files: 0 });
	assert.deepEqual(store.search("private"), []);
	assert.deepEqual(store.stats(), { pages: 3, stored: 1, files: 0, file_bytes: 0, file_bytes_max: 2147483648 });
	store.close();
	const db = new DatabaseSync(path.join(dir, "index.db"));
	const rows = db.prepare("SELECT id, url, title, cookie_scope, stored FROM pages ORDER BY id").all().map((r) => ({ ...r }));
	db.close();
	assert.deepEqual(rows.find((r) => r.id === bare.id), { id: bare.id, url: "", title: "", cookie_scope: null, stored: 0 });
	assert.deepEqual(rows.find((r) => r.id === oldId), { id: oldId, url: "", title: "", cookie_scope: null, stored: 0 });
	assert.equal(rows.find((r) => r.id === kept.id)?.url, "https://example.com/a");
	const bytes = fs.readFileSync(path.join(dir, "index.db"));
	for (const needle of ["SECRETQUERY", "PRIVATETITLE", "OLDSECRET", "OLDTITLE"]) assert.ok(!bytes.includes(needle), needle);

	const again = new PageStore({ dataDir: dir, clock, log: quietLog() });
	t.after(() => again.close());
	clock.advance(10 * MIN);
	assert.deepEqual(again.purge({ maxAgeMs: MIN }), { rows: 3, dirs: 3, refused: 0, files: 0, unknown: 0 });
	assert.equal(again.getMeta(bare.id), null);
});

test("a damaged bare record is not read", (t) => {
	const { dir, store, log } = openStore(t);
	const { id } = store.save(makeRecord({ cookie_scope: "default" }));
	const file = path.join(pageDir(dir, id), "meta.json");
	const good = JSON.parse(fs.readFileSync(file, "utf8"));
	for (const bad of [{ ...good, host: 5 }, { ...good, stored: true }, { ...good, url: null }, { ...good, fetched_at: "never" }, { ...good, id: "pg_" + "1".repeat(26) }]) {
		fs.writeFileSync(file, JSON.stringify(bad));
		assert.equal(store.getMeta(id), null, JSON.stringify(bad).slice(0, 80));
	}
	assert.ok(log.events.includes("store.bad_meta"));
});

test("a full record with a field of another kind is not read; one that lacks a field from a later version is, with that field empty", (t) => {
	const { dir, store, log } = openStore(t);
	const { id } = store.save(makeRecord());
	const file = path.join(pageDir(dir, id), "meta.json");
	const good = JSON.parse(fs.readFileSync(file, "utf8"));
	const damaged = [
		{ ...good, truncated: "no" },
		{ ...good, truncated: { markdown: "no", html: false } },
		{ ...good, truncated: { markdown: false, html: false, raw_html: 1 } },
		{ ...good, truncated: [] },
		{ ...good, render: "visible" },
		{ ...good, render: [] },
		{ ...good, title: 7 },
		{ ...good, final_url: {} },
		{ ...good, http_status: "200" },
		{ ...good, text_chars: "12" },
		{ ...good, redirect_origins: "https://example.com" },
		{ ...good, redirect_origins: [5] },
		{ ...good, content_chars: -1 },
		{ ...good, content_sha256: 5 },
		{ ...good, cookie_scope: true },
		{ ...good, outcome: null },
		{ ...good, host: null },
	];
	for (const bad of damaged) {
		fs.writeFileSync(file, JSON.stringify(bad));
		assert.equal(store.getMeta(id), null, JSON.stringify(bad).slice(0, 120));
	}
	assert.equal(log.events.filter((e) => e === "store.bad_meta").length, damaged.length);

	// What an earlier version wrote: fewer fields. Every one of them is there afterwards, in its own shape.
	const { truncated: _t, render: _r, redirect_origins: _o, extraction: _e, text_chars: _c, lang: _l, ...older } = good;
	fs.writeFileSync(file, JSON.stringify(older));
	assert.deepEqual(store.getMeta(id), { ...older, lang: null, text_chars: null, redirect_origins: [], extraction: null, render: null, truncated: { markdown: false, html: false } });
	fs.writeFileSync(file, JSON.stringify(good));
	assert.deepEqual(store.getMeta(id), good, "a record as it is written today is handed out as it is");
});

test("a result without markdown is saved as meta only", (t) => {
	const { store } = openStore(t);
	const { id, meta } = store.save(makeRecord({ outcome: "blocked", markdown: null, html: null }));
	assert.equal(meta.stored, false);
	assert.equal(meta.content_sha256, null);
	assert.equal(store.findFresh("https://example.com/a", { maxAgeMs: MIN }), null);
	assert.equal(store.readBody(id, "markdown"), null);
});

test("save rejects a record whose url is not http(s)", (t) => {
	const { store } = openStore(t);
	assert.throws(() => store.save(makeRecord({ url: "file:///etc/passwd" })), StoreError);
	assert.throws(() => store.save(makeRecord({ url: "not a url" })), StoreError);
	assert.equal(store.stats().pages, 0);
});

test("findFresh: hit, newest wins, expiry boundary, other urls, normalisation", (t) => {
	const { clock, store } = openStore(t);
	const a1 = store.save(makeRecord({ markdown: "first" }));
	clock.advance(5 * MIN);
	const a2 = store.save(makeRecord({ markdown: "second" }));
	store.save(makeRecord({ url: "https://example.com/other", markdown: "other" }));
	const hit = store.findFresh("https://example.com/a", { maxAgeMs: 10 * MIN });
	assert.equal(hit?.id, a2.id);
	assert.notEqual(hit?.id, a1.id);
	assert.equal(store.findFresh("HTTPS://EXAMPLE.com/a", { maxAgeMs: 10 * MIN })?.id, a2.id);
	assert.equal(store.findFresh("https://example.com/b", { maxAgeMs: 10 * MIN }), null);
	assert.equal(store.findFresh("not a url", { maxAgeMs: 10 * MIN }), null);
	// a2 was saved at t+5min; exactly maxAge old still counts, one ms older does not
	clock.advance(10 * MIN);
	assert.equal(store.findFresh("https://example.com/a", { maxAgeMs: 10 * MIN })?.id, a2.id);
	clock.advance(1000);
	assert.equal(store.findFresh("https://example.com/a", { maxAgeMs: 10 * MIN }), null);
	assert.equal(store.findFresh("https://example.com/a", { maxAgeMs: 11 * MIN })?.id, a2.id);
	assert.throws(() => store.findFresh("https://example.com/a", { maxAgeMs: -1 }), StoreError);
	assert.throws(() => store.findFresh("https://example.com/a", { maxAgeMs: NaN }), StoreError);
});

test("findFresh ignores a final url: it is keyed on the requested url", (t) => {
	const { store } = openStore(t);
	const { id } = store.save(makeRecord({ url: "https://example.com/short", final_url: "https://example.com/long" }));
	assert.equal(store.findFresh("https://example.com/short", { maxAgeMs: MIN })?.id, id);
	assert.equal(store.findFresh("https://example.com/long", { maxAgeMs: MIN }), null);
});

test("search: terms, stemming, title, limit, snippet", (t) => {
	const { store } = openStore(t);
	const a = store.save(makeRecord({ title: "Foxes", markdown: "The quick brown fox is running over the lazy dog" }));
	store.save(makeRecord({ url: "https://example.com/b", title: "Other", markdown: "Nothing about animals here, only gardening and tulips" }));
	store.save(makeRecord({ url: "https://example.com/c", title: "Tulips", markdown: "Spring flowers" }));
	const hits = store.search("run fox");
	assert.equal(hits.length, 1);
	assert.equal(hits[0].id, a.id);
	assert.equal(hits[0].title, "Foxes");
	assert.equal(hits[0].url, "https://example.com/a");
	assert.equal(hits[0].fetched_at, "2026-10-05T19:44:02Z");
	assert.match(hits[0].snippet, /fox/);
	assert.equal(store.search("tulips").length, 2, "title and body both match");
	assert.equal(store.search("tulips", { limit: 1 }).length, 1);
	assert.equal(store.search("quick tulips").length, 0, "terms are ANDed");
	assert.deepEqual(store.search(""), []);
	assert.deepEqual(store.search("!!! ..."), []);
});

test("search: hostile queries never throw and never act as operators", (t) => {
	const { store } = openStore(t);
	store.save(makeRecord({ title: "Alpha", markdown: "alpha beta gamma NEAR title column" }));
	const hostile = [
		'"',
		'""',
		'"unbalanced',
		"*",
		"alp*",
		"NEAR(alpha beta)",
		"alpha NEAR beta",
		"title:alpha",
		"{title body}: alpha",
		"body : beta",
		"(",
		")",
		"((alpha)",
		"alpha OR beta",
		"alpha AND NOT beta",
		"-alpha",
		"^alpha",
		"alpha + beta",
		"'; DROP TABLE pages; --",
		"alpha\u0000beta",
		"\ud800",
		"a ".repeat(5000),
		"x".repeat(100000),
		"\u202e alpha",
	];
	for (const q of hostile) {
		assert.ok(Array.isArray(store.search(q)), JSON.stringify(q.slice(0, 20)));
	}
	// prefix and column filters are not available
	assert.equal(store.search("alp*").length, 0);
	assert.equal(store.search("alp").length, 0);
	// "title:" is just two words, and the page has both "title" and "alpha" in its text/title
	assert.equal(store.search("title:alpha").length, 1);
	assert.equal(store.search("title:nonexistentword").length, 0);
	// the index still works after the injection attempt
	assert.equal(store.stats().pages, 1);
	assert.equal(store.search("gamma").length, 1);
});

test("buildFtsQuery quotes every term, drops empties, caps terms and length", () => {
	assert.equal(buildFtsQuery("title:foo"), '"title" "foo"');
	assert.equal(buildFtsQuery("NEAR(a b)"), '"NEAR" "a" "b"');
	assert.equal(buildFtsQuery('a" OR "b'), '"a" "OR" "b"');
	assert.equal(buildFtsQuery("*"), null);
	assert.equal(buildFtsQuery(""), null);
	assert.equal(buildFtsQuery(/** @type {any} */ (42)), null);
	assert.equal(buildFtsQuery("dup dup"), '"dup"');
	const many = buildFtsQuery(Array.from({ length: 100 }, (_, i) => `w${i}`).join(" "));
	assert.equal(many?.split(" ").length, 12);
	const long = buildFtsQuery("x".repeat(100000));
	assert.ok(long !== null && long.length <= 64 + 2);
	// only quotes, letters, digits and spaces ever come out
	assert.match(String(buildFtsQuery("\u202e a\"b'c;d(e)f*g^h-i:j")), /^("[\p{L}\p{N}\p{M}]+"( |$))+$/u);
});

test("id validation rejects anything but pg_ + 26 Crockford chars", (t) => {
	const { dir, store } = openStore(t);
	const { id } = store.save(makeRecord());
	assert.equal(isValidPageId(id), true);
	const bad = [
		"",
		"pg_",
		"pg_../..",
		"pg_../../../etc/passwd",
		"../pages",
		"/etc/passwd",
		"/srv/user",
		id.toLowerCase(),
		id + "0",
		id.slice(0, -1),
		id.slice(0, -1) + "U",
		id.slice(0, -1) + "I",
		id.slice(0, -1) + "L",
		id.slice(0, -1) + "O",
		id.slice(0, -1) + "/",
		id.slice(0, -2) + "\n" + id.slice(-1),
		`${id}\n`,
		" " + id,
		"pg_" + "0".repeat(25) + "\u0000",
		"PG_" + id.slice(3),
		"pg_0000000000000000000000000.",
	];
	for (const b of bad) {
		assert.equal(isValidPageId(b), false, JSON.stringify(b));
		assert.throws(() => store.getMeta(b), (e) => e instanceof StoreError && e.code === "invalid_id", `getMeta ${JSON.stringify(b)}`);
		assert.throws(() => store.readBody(b, "markdown"), StoreError);
		assert.throws(() => store.readLinks(b), StoreError);
	}
	for (const b of [null, undefined, 5, {}, ["x"]]) assert.equal(isValidPageId(b), false);
	assert.equal(store.getMeta("pg_" + "0".repeat(26)), null, "valid format, unknown page");
	assert.equal(store.readBody("pg_" + "0".repeat(26), "markdown"), null);
	assert.ok(fs.existsSync(pageDir(dir, id)));
});

test("a symlinked page dir or file is never read through", (t) => {
	const { dir, store } = openStore(t);
	const { id } = store.save(makeRecord());
	const outside = makeTempDir("outside");
	t.after(() => removeTempDir(outside));
	fs.writeFileSync(path.join(outside, "content.md"), "stolen");
	const pd = pageDir(dir, id);
	fs.rmSync(path.join(pd, "content.md"));
	fs.symlinkSync(path.join(outside, "content.md"), path.join(pd, "content.md"));
	assert.equal(store.readBody(id, "markdown"), null, "symlinked file");
	fs.rmSync(pd, { recursive: true });
	fs.symlinkSync(outside, pd);
	assert.equal(store.getMeta(id), null, "symlinked directory");
	assert.equal(store.readBody(id, "markdown"), null);
});

test("purge: strictly older pages only, counts, rows and search entries go", (t) => {
	const { dir, clock, store } = openStore(t);
	const old = store.save(makeRecord({ url: "https://example.com/old", markdown: "ancient zebra" }));
	clock.advance(10 * MIN);
	const edge = store.save(makeRecord({ url: "https://example.com/edge", markdown: "edge zebra" }));
	clock.advance(10 * MIN);
	const fresh = store.save(makeRecord({ url: "https://example.com/new", markdown: "new zebra" }));
	const noStore = store.save(makeRecord({ url: "https://example.com/ns", cookie_scope: "default" }));
	// now: old is 20 min, edge 10 min, fresh and noStore 0 min
	assert.deepEqual(store.purge({ maxAgeMs: 25 * MIN }), { rows: 0, dirs: 0, refused: 0, files: 0, unknown: 0 });
	assert.equal(store.stats().pages, 4);
	assert.deepEqual(store.purge({ maxAgeMs: 20 * MIN }), { rows: 0, dirs: 0, refused: 0, files: 0, unknown: 0 }, "exactly at the limit stays");
	assert.deepEqual(store.purge({ maxAgeMs: 20 * MIN - 1000 }), { rows: 1, dirs: 1, refused: 0, files: 0, unknown: 0 });
	assert.equal(store.getMeta(old.id), null);
	assert.ok(!fs.existsSync(pageDir(dir, old.id)));
	assert.deepEqual(store.search("ancient"), []);
	assert.equal(store.search("zebra").length, 2);
	clock.advance(1);
	assert.deepEqual(store.purge({ maxAgeMs: 10 * MIN }), { rows: 1, dirs: 1, refused: 0, files: 0, unknown: 0 }, "edge is now older than 10 min");
	assert.equal(store.getMeta(edge.id), null);
	assert.notEqual(store.getMeta(fresh.id), null);
	clock.advance(2000);
	assert.deepEqual(store.purge({ maxAgeMs: 0 }), { rows: 2, dirs: 2, refused: 0, files: 0, unknown: 0 });
	assert.equal(store.getMeta(noStore.id), null);
	assert.deepEqual(store.stats(), { pages: 0, stored: 0, files: 0, file_bytes: 0, file_bytes_max: 2147483648 });
	assert.throws(() => store.purge({ maxAgeMs: -5 }), StoreError);
	assert.throws(() => store.purge({ maxAgeMs: Infinity }), StoreError);
});

test("purge removes the row when the directory is already gone", (t) => {
	const { dir, clock, store } = openStore(t);
	const { id } = store.save(makeRecord());
	fs.rmSync(pageDir(dir, id), { recursive: true });
	clock.advance(MIN);
	assert.deepEqual(store.purge({ maxAgeMs: 0 }), { rows: 1, dirs: 0, refused: 0, files: 0, unknown: 0 });
	assert.equal(store.stats().pages, 0);
});

test("purge never follows symlinks: page dir, shard dir, entries inside", (t) => {
	const { dir, clock, store, log } = openStore(t);
	const outside = makeTempDir("outside");
	t.after(() => removeTempDir(outside));
	const victim = path.join(outside, "victim.txt");
	fs.writeFileSync(victim, "keep me");

	const linkedPage = store.save(makeRecord({ url: "https://example.com/p1" }));
	const linkedShard = store.save(makeRecord({ url: "https://example.com/p2" }));
	const inner = store.save(makeRecord({ url: "https://example.com/p3" }));

	// 1: the page directory is replaced by a symlink to a directory outside
	const pd1 = pageDir(dir, linkedPage.id);
	fs.rmSync(pd1, { recursive: true });
	fs.symlinkSync(outside, pd1);

	// 2: the shard directory is a symlink (only when it holds no other page)
	const shard2 = path.join(dir, "pages", linkedShard.id.slice(-2));
	const holder = makeTempDir("shard");
	t.after(() => removeTempDir(holder));
	fs.cpSync(shard2, path.join(holder, "s"), { recursive: true });
	fs.writeFileSync(path.join(holder, "s", linkedShard.id, "marker"), "m");
	fs.rmSync(shard2, { recursive: true });
	fs.symlinkSync(path.join(holder, "s"), shard2);

	// 3: a symlink inside a page directory points at an outside file
	fs.symlinkSync(victim, path.join(pageDir(dir, inner.id), "evil-link"));

	clock.advance(MIN);
	const res = store.purge({ maxAgeMs: 0 });
	assert.equal(res.refused, 2);
	assert.equal(res.dirs, 1);
	assert.equal(res.rows, 1);
	assert.equal(fs.readFileSync(victim, "utf8"), "keep me");
	assert.ok(fs.existsSync(path.join(outside, "victim.txt")));
	assert.ok(fs.existsSync(path.join(holder, "s", linkedShard.id, "marker")), "shard link target untouched");
	assert.ok(fs.lstatSync(pd1).isSymbolicLink(), "refused link is left in place");
	assert.ok(!fs.existsSync(pageDir(dir, inner.id)));
	assert.equal(log.events.filter((e) => e === "store.purge_refused").length, 2);
	// refused rows stay, so the operator can see them
	assert.equal(store.stats().pages, 2);
});

test("purge and rebuild sweep leftover temp directories, only inside pages", (t) => {
	const { dir, clock, store } = openStore(t);
	const { id } = store.save(makeRecord());
	const shard = path.join(dir, "pages", id.slice(-2));
	fs.mkdirSync(path.join(shard, ".tmp-dead"));
	fs.writeFileSync(path.join(shard, ".tmp-dead", "content.md"), "partial");
	fs.writeFileSync(path.join(dir, "audit.jsonl"), "keep\n");
	clock.advance(MIN);
	store.purge({ maxAgeMs: 10 * MIN });
	assert.ok(!fs.existsSync(path.join(shard, ".tmp-dead")));
	assert.equal(fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8"), "keep\n");
	fs.mkdirSync(path.join(shard, ".tmp-dead2"));
	store.rebuildIndex();
	assert.ok(!fs.existsSync(path.join(shard, ".tmp-dead2")));
});

/**
 * @param {string} dir
 * @returns {{ pages: unknown[], fts: unknown[] }}
 */
function dumpIndex(dir) {
	const db = new DatabaseSync(path.join(dir, "index.db"), { readOnly: true });
	try {
		const pages = db.prepare("SELECT * FROM pages ORDER BY id").all().map((r) => ({ ...r }));
		const fts = db
			.prepare("SELECT p.id AS id, f.title AS title, f.body AS body FROM pages_fts f JOIN pages p ON p.rowid = f.rowid ORDER BY p.id")
			.all()
			.map((r) => ({ ...r }));
		return { pages, fts };
	} finally {
		db.close();
	}
}

test("rebuildIndex reproduces the original index from the files", (t) => {
	const { dir, clock, store } = openStore(t);
	store.save(makeRecord({ title: "One", markdown: "alpha beta \u00e4\u00f6 \u{1f600}" }));
	clock.advance(3000);
	store.save(makeRecord({ url: "https://example.com/two", title: "Two", markdown: "gamma delta" }));
	clock.advance(3000);
	store.save(makeRecord({ url: "https://example.com/three", cookie_scope: "default", title: "Three", markdown: "secret epsilon" }));
	store.save(makeRecord({ url: "https://example.com/four", outcome: "blocked", markdown: null, html: null, title: null }));
	const before = dumpIndex(dir);
	assert.equal(before.pages.length, 4);
	assert.equal(before.fts.length, 2);
	const searchBefore = ["alpha", "gamma", "delta", "secret", "one"].map((q) => store.search(q).map((h) => h.id));
	assert.deepEqual(/** @type {any[]} */ (before.pages).filter((r) => r.url === "").map((r) => [r.title, r.cookie_scope, r.stored]), [["", null, 0]], "the default-scope page is a bare row");

	// damage the index in place, then rebuild
	store.close();
	const db = new DatabaseSync(path.join(dir, "index.db"));
	db.exec("DELETE FROM pages_fts; DELETE FROM pages WHERE url LIKE '%two'");
	db.close();
	const reopened = new PageStore({ dataDir: dir, clock, log: quietLog(), randomBytes: counterBytes(99) });
	t.after(() => reopened.close());
	assert.deepEqual(reopened.rebuildIndex(), { pages: 4, stored: 2, skipped: 0, files: 0 });
	reopened.close();
	assert.deepEqual(dumpIndex(dir), before);
	const again = new PageStore({ dataDir: dir, clock, log: quietLog() });
	t.after(() => again.close());
	assert.deepEqual(
		["alpha", "gamma", "delta", "secret", "one"].map((q) => again.search(q).map((h) => h.id)),
		searchBefore,
	);
	assert.ok(again.findFresh("https://example.com/two", { maxAgeMs: MIN }) !== null);
});

test("rebuildIndex from nothing but the page files, and it skips junk", (t) => {
	const { dir, clock, store } = openStore(t);
	const keep = store.save(makeRecord({ markdown: "findable words" }));
	store.close();
	fs.rmSync(path.join(dir, "index.db"));
	const shard = path.join(dir, "pages", keep.id.slice(-2));
	fs.mkdirSync(path.join(shard, "not-an-id"));
	fs.mkdirSync(path.join(dir, "pages", "zz"), { recursive: true });
	fs.mkdirSync(path.join(dir, "pages", "01", "pg_00000000000000000000000001"), { recursive: true });
	fs.writeFileSync(path.join(dir, "pages", "01", "pg_00000000000000000000000001", "meta.json"), "{not json");
	const other = path.join(dir, "pages", "02", "pg_00000000000000000000000001");
	fs.mkdirSync(other, { recursive: true });
	fs.writeFileSync(path.join(other, "meta.json"), JSON.stringify({ id: "pg_00000000000000000000000001", url: "https://x.test/", fetched_at: "2026-01-01T00:00:00Z", stored: false }));
	const fresh = new PageStore({ dataDir: dir, clock, log: quietLog() });
	t.after(() => fresh.close());
	const res = fresh.rebuildIndex();
	assert.equal(res.pages, 1);
	assert.equal(res.skipped, 3, "bad name, bad json, wrong shard");
	assert.equal(fresh.search("findable")[0]?.id, keep.id);
});

test("rebuild marks a page whose body file vanished as not stored in the index", (t) => {
	const { dir, store, log } = openStore(t);
	const { id } = store.save(makeRecord({ markdown: "vanishing text" }));
	fs.rmSync(path.join(pageDir(dir, id), "content.md"));
	store.rebuildIndex();
	assert.deepEqual(store.search("vanishing"), []);
	assert.equal(store.findFresh("https://example.com/a", { maxAgeMs: MIN }), null);
	assert.ok(log.events.includes("store.body_missing"));
});

test("a closed store refuses work; close is idempotent", (t) => {
	const { store } = openStore(t);
	store.close();
	store.close();
	assert.throws(() => store.save(makeRecord()), (e) => e instanceof StoreError && e.code === "closed");
	assert.throws(() => store.search("x"), StoreError);
});

test("reopening an existing data dir keeps pages and tightens nothing it should not", (t) => {
	const dir = makeTempDir("reopen");
	t.after(() => removeTempDir(dir));
	const clock = new FakeClock();
	const a = new PageStore({ dataDir: dir, clock, log: quietLog(), randomBytes: counterBytes() });
	const { id } = a.save(makeRecord({ markdown: "persisted text" }));
	a.close();
	fs.chmodSync(path.join(dir, "index.db"), 0o644);
	const b = new PageStore({ dataDir: dir, clock, log: quietLog() });
	t.after(() => b.close());
	assert.equal(b.search("persisted")[0]?.id, id);
	assert.equal(b.readBody(id, "markdown"), "persisted text");
	assert.equal(mode(path.join(dir, "index.db")), 0o600);
});

test("raw HTML: raw.html.gz next to the other files, read back exactly, not indexed", (t) => {
	const { dir, store } = openStore(t);
	const raw = "<!DOCTYPE html>\n<html><head><script>var k = \"RAWSECRETWORD\";</script></head><body><!-- RAWCOMMENT -->\u00e4\u00f6\u00fc \u65e5\u672c\u8a9e \u{1f600}\u200b<p hidden>hid</p>\r\n</body></html>";
	const { id, meta } = store.save(makeRecord({ raw_html: raw, truncated: { markdown: false, text: false, html: false, raw_html: true } }));
	assert.deepEqual(fs.readdirSync(pageDir(dir, id)).sort(), ["content.md", "links.json", "meta.json", "page.html.gz", "raw.html.gz"]);
	assert.equal(mode(path.join(pageDir(dir, id), "raw.html.gz")), 0o600);
	assert.equal(store.readBody(id, "raw_html"), raw, "every character, the zero-width one and the CRLF included");
	assert.equal(store.readBody(id, "html"), makeRecord().html, "the cleaned document is a file of its own");
	assert.equal(/** @type {any} */ (meta).truncated.raw_html, true);
	assert.deepEqual(store.search("RAWSECRETWORD"), [], "the source is not in the index");
	assert.deepEqual(store.search("RAWCOMMENT"), []);
});

test("raw HTML: a page without it, a bare record and a damaged file answer null; rebuild and purge are unaffected", (t) => {
	const { dir, store, clock } = openStore(t);
	const none = store.save(makeRecord());
	assert.equal(store.readBody(none.id, "raw_html"), null);
	assert.equal(/** @type {any} */ (none.meta).truncated.raw_html, false);
	const bare = store.save(makeRecord({ cookie_scope: "default", raw_html: "<html>PRIVATE</html>" }));
	assert.equal(store.readBody(bare.id, "raw_html"), null, "a page read with the login keeps no source");
	assert.deepEqual(fs.readdirSync(pageDir(dir, bare.id)), ["meta.json"]);
	const kept = store.save(makeRecord({ url: "https://example.com/kept", raw_html: "<html>kept</html>" }));
	fs.writeFileSync(path.join(pageDir(dir, none.id), "raw.html.gz"), "not gzip");
	assert.equal(store.readBody(none.id, "raw_html"), null, "damaged: no content, no throw");
	fs.rmSync(path.join(pageDir(dir, none.id), "raw.html.gz"));
	assert.deepEqual(store.rebuildIndex(), { pages: 3, stored: 2, skipped: 0, files: 0 });
	assert.equal(store.readBody(kept.id, "raw_html"), "<html>kept</html>");
	clock.advance(2 * 60 * MIN);
	assert.deepEqual(store.purge({ maxAgeMs: MIN }), { rows: 3, dirs: 3, refused: 0, files: 0, unknown: 0 });
	assert.equal(fs.existsSync(pageDir(dir, kept.id)), false, "the source goes with the page directory");
	assert.equal(store.readBody(kept.id, "raw_html"), null);
});

// ---------------------------------------------------------------- what the pages may take in all

/** @param {string} dir @returns {number} bytes of every file below dir */
const bytesBelow = (dir) => walk(dir).reduce((sum, rel) => sum + (fs.statSync(path.join(dir, rel)).isFile() ? fs.statSync(path.join(dir, rel)).size : 0), 0);

/**
 * A store with room for so many bytes of pages.
 * @param {import("node:test").TestContext} t
 * @param {number} maxPageBytes
 */
function smallStore(t, maxPageBytes) {
	const dir = makeTempDir("store-small");
	const clock = new FakeClock(Date.UTC(2026, 9, 5, 19, 44, 2));
	/** @type {{ event: string, fields: Record<string, unknown> }[]} */
	const lines = [];
	const say = (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields = {}) => void lines.push({ event, fields });
	const log = { info: say, warn: say, error: say };
	const store = new PageStore({ dataDir: dir, clock, log, randomBytes: counterBytes(), maxPageBytes });
	t.after(() => {
		store.close();
		removeTempDir(dir);
	});
	return { dir, clock, log, lines, store };
}

/** A page of about a thousand bytes of text, each one different. @param {number} n */
const pageOf = (n) => makeRecord({ url: `https://example.com/p${n}`, title: `Page ${n}`, markdown: `page number ${n} ${"word ".repeat(190)}`, html: null, links: [] });

test("pages: what a page takes is its files and the text the index holds of it, and a store that is told nothing has 2 GiB for them", (t) => {
	const { dir, clock, store } = openStore(t);
	assert.deepEqual(store.pageUsage(), { bytes: 0, bytes_max: 2147483648 });
	assert.equal(PAGE_STORE.maxTotalBytes, 2147483648);
	const a = store.save(makeRecord({ markdown: "short view", text: "the full visible text, which is longer than the view \u00e9\u00e8" }));
	// Search looks through the richer of the two texts: the index holds that one and its words, counted as twice its bytes.
	assert.equal(PAGE_STORE.indexShare, 2);
	const indexed = 2 * Buffer.byteLength("the full visible text, which is longer than the view \u00e9\u00e8", "utf8");
	assert.equal(store.pageUsage().bytes, bytesBelow(pageDir(dir, a.id)) + indexed);
	// A bare record takes its meta.json.
	const bare = store.save(makeRecord({ url: "https://private.example.com/x", cookie_scope: "default" }));
	assert.equal(store.pageUsage().bytes, bytesBelow(pageDir(dir, a.id)) + indexed + fs.statSync(path.join(pageDir(dir, bare.id), "meta.json")).size);
	assert.equal(store.pageUsage().bytes, bytesBelow(path.join(dir, "pages")) + indexed);
	// What goes is no longer counted.
	clock.advance(1000);
	store.purge({ maxAgeMs: 0 });
	assert.equal(store.pageUsage().bytes, 0);
	assert.throws(() => new PageStore({ dataDir: dir, clock: { now: () => 0 }, log: quietLog(), maxPageBytes: -1 }), RangeError);
	assert.throws(() => new PageStore({ dataDir: dir, clock: { now: () => 0 }, log: quietLog(), maxPageBytes: 1.5 }), RangeError);
});

test("pages: the oldest go to make room for a new one, never one that is being read in pieces, and what cannot fit is not kept", (t) => {
	const one = (() => {
		const probe = openStore(t);
		probe.store.save(pageOf(0));
		return probe.store.pageUsage().bytes;
	})();
	assert.ok(one > 3500 && one < 4500, String(one));
	// Room for three such pages and a little.
	const { dir, clock, store, lines } = smallStore(t, 3 * one + 100);
	/** @type {string[]} */
	const ids = [];
	for (let n = 1; n <= 3; n++) {
		ids.push(store.save(pageOf(n)).id);
		clock.advance(1000);
	}
	assert.equal(store.stats().pages, 3);
	assert.equal(lines.filter((l) => l.event === "store.pages_evicted").length, 0);

	// A fourth: the oldest goes, directory, row and search entry.
	ids.push(store.save(pageOf(4)).id);
	clock.advance(1000);
	assert.equal(store.getMeta(ids[0]), null);
	assert.equal(fs.existsSync(pageDir(dir, ids[0])), false);
	assert.ok(!store.search("number").some((h) => h.id === ids[0]), "nor is it found any more");
	assert.equal(store.search("number").length, 3);
	assert.deepEqual([2, 3, 4].map((n) => store.getMeta(ids[n - 1]) !== null), [true, true, true]);
	assert.deepEqual(lines.filter((l) => l.event === "store.pages_evicted").map((l) => l.fields), [{ pages: 1, bytes: one }]);
	assert.ok(store.pageUsage().bytes <= 3 * one + 100);
	assert.equal(store.pageUsage().bytes, bytesBelow(path.join(dir, "pages")) + [2, 3, 4].reduce((sum, n) => sum + 2 * Buffer.byteLength(/** @type {string} */ (pageOf(n).markdown)), 0));

	// A reader has a part of page 2 and comes back for more: page 3 goes in its place.
	store.holdPage(ids[1]);
	ids.push(store.save(pageOf(5)).id);
	assert.deepEqual([2, 3, 4, 5].map((n) => store.getMeta(ids[n - 1]) !== null), [true, false, true, true]);
	// The reader has all of it, or stayed away for a minute: it is the oldest again.
	store.holdPage(ids[1], true);
	ids.push(store.save(pageOf(6)).id);
	assert.deepEqual([2, 4, 5, 6].map((n) => store.getMeta(ids[n - 1]) !== null), [false, true, true, true]);
	store.holdPage(ids[3]);
	clock.advance(60001);
	ids.push(store.save(pageOf(7)).id);
	assert.equal(store.getMeta(ids[3]), null, "a hold ends by itself");
	store.holdPage("not an id");
	store.holdPage(`fl_${"0".repeat(26)}`);

	// Everything that is there is being read: there is no room, and the page is not kept. Nothing of it is left.
	for (const id of [ids[4], ids[5], ids[6]]) store.holdPage(id);
	const before = walk(dir).filter((p) => p.startsWith("pages"));
	assert.throws(() => store.save(pageOf(8)), (err) => err instanceof StoreError && err.code === "store_full");
	assert.deepEqual(walk(dir).filter((p) => p.startsWith("pages")), before);
	assert.equal(store.stats().pages, 3);

	// Larger than everything the store has: not kept either, and nothing goes for it.
	for (const id of [ids[4], ids[5], ids[6]]) store.holdPage(id, true);
	assert.throws(() => store.save(makeRecord({ markdown: "x".repeat(2 * one) })), (err) => err instanceof StoreError && err.code === "store_full");
	assert.equal(store.stats().pages, 3);
	assert.deepEqual(walk(dir).filter((p) => p.startsWith("pages")), before);
});

test("pages: a limit that is new or was lowered is met by purge, oldest first; an index from before the limit is counted once, from the sizes of the files", (t) => {
	const { dir, clock, store } = openStore(t);
	/** @type {string[]} */
	const ids = [];
	for (let n = 1; n <= 6; n++) {
		ids.push(store.save(pageOf(n)).id);
		clock.advance(1000);
	}
	const used = store.pageUsage().bytes;
	const one = used / 6;
	store.close();

	// The index of a version that did not count: no such column.
	const db = new DatabaseSync(path.join(dir, "index.db"));
	db.exec("ALTER TABLE pages DROP COLUMN bytes");
	db.close();
	/** @type {{ event: string, fields: Record<string, unknown> }[]} */
	const lines = [];
	const say = (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields = {}) => void lines.push({ event, fields });
	const upgraded = new PageStore({ dataDir: dir, clock, log: { info: say, warn: say, error: say }, maxPageBytes: 4 * one + 10 });
	t.after(() => upgraded.close());
	assert.deepEqual(upgraded.pageUsage(), { bytes: used, bytes_max: 4 * one + 10 }, "the same number as when each was counted at its save");
	assert.deepEqual(lines.map((l) => [l.event, l.fields.pages, l.fields.bytes]), [["store.index_upgraded", 6, used]]);
	assert.equal(upgraded.stats().pages, 6, "opening removes nothing");

	// Purge: nothing is old enough to go by age, two are over the limit.
	assert.deepEqual(upgraded.purge({ maxAgeMs: 3600000 }), { rows: 0, dirs: 0, refused: 0, files: 0, unknown: 0 });
	assert.deepEqual(ids.map((id) => upgraded.getMeta(id) !== null), [false, false, true, true, true, true]);
	assert.deepEqual(lines.filter((l) => l.event === "store.pages_evicted").map((l) => l.fields), [{ pages: 2, bytes: 2 * one }]);
	upgraded.close();

	// Counted once: the next start finds the column and does not go through the pages again.
	lines.length = 0;
	const again = new PageStore({ dataDir: dir, clock, log: { info: say, warn: say, error: say } });
	t.after(() => again.close());
	assert.deepEqual(lines, []);
	assert.equal(again.pageUsage().bytes, 4 * one);
});

// ---------------------------------------------------------------- an index that was lost, and directories it never knew

test("the time in an id is read back from it", () => {
	const at = Date.UTC(2026, 9, 5, 19, 44, 2, 123);
	assert.equal(idTime(newPageId(at, counterBytes())), at);
	assert.equal(idTime(`pg_${"0".repeat(26)}`), 0);
	assert.equal(idTime(`fl_7ZZZZZZZZZ${"0".repeat(16)}`), 2 ** 48 - 1);
});

test("recoverIndex: an index without a row over directories that hold pages is rebuilt; any other is left alone", (t) => {
	const { dir, clock, store, log } = openStore(t);
	assert.equal(store.recoverIndex(), null, "an empty store has nothing to recover");
	const kept = store.save(makeRecord({ markdown: "findable words" }));
	const bare = store.save(makeRecord({ url: "https://private.example.com/x", cookie_scope: "default" }));
	assert.equal(store.recoverIndex(), null, "the index knows its pages");
	const used = store.pageUsage().bytes;
	store.close();

	// The index is gone. A new one is made when the store is opened, and it is empty.
	fs.rmSync(path.join(dir, "index.db"));
	/** @type {{ event: string, fields: Record<string, unknown> }[]} */
	const lines = [];
	const say = (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields = {}) => void lines.push({ event, fields });
	const fresh = new PageStore({ dataDir: dir, clock, log: { info: say, warn: say, error: say } });
	t.after(() => fresh.close());
	assert.deepEqual(fresh.stats(), { pages: 0, stored: 0, files: 0, file_bytes: 0, file_bytes_max: 2147483648 });
	assert.deepEqual(fresh.recoverIndex(), { pages: 2, stored: 1, skipped: 0, files: 0, ms: 0 });
	assert.deepEqual(lines.filter((l) => l.event === "store.index_rebuilt").map((l) => l.fields), [{ pages: 2, stored: 1, skipped: 0, files: 0, ms: 0 }], "one line with the counts");
	assert.equal(fresh.search("findable")[0]?.id, kept.id);
	assert.equal(fresh.findFresh("https://example.com/a", { maxAgeMs: MIN })?.id, kept.id);
	assert.equal(fresh.pageUsage().bytes, used, "what the pages take is counted again");
	assert.equal(fresh.recoverIndex(), null, "once");

	// An index that knows one page is not rebuilt for a directory it does not know.
	const db = new DatabaseSync(path.join(dir, "index.db"));
	db.prepare("DELETE FROM pages WHERE id = ?").run(bare.id);
	db.close();
	assert.equal(fresh.recoverIndex(), null);
	assert.equal(fresh.stats().pages, 1);
	assert.ok(!log.events.includes("store.bad_meta"));
});

test("purge removes directories the index does not know once they are older than the retention by their id, and leaves younger ones", (t) => {
	const { dir, clock, store, log } = openStore(t);
	const old = store.save(makeRecord({ url: "https://example.com/old" }));
	const oldLinked = store.save(makeRecord({ url: "https://example.com/old-linked" }));
	clock.advance(20 * MIN);
	const young = store.save(makeRecord({ url: "https://example.com/young" }));
	const known = store.save(makeRecord({ url: "https://example.com/known" }));
	store.close();
	// As if the process had ended between putting each directory in place and writing its row.
	const db = new DatabaseSync(path.join(dir, "index.db"));
	for (const id of [old.id, oldLinked.id, young.id]) {
		db.prepare("DELETE FROM pages_fts WHERE rowid IN (SELECT rowid FROM pages WHERE id = ?)").run(id);
		db.prepare("DELETE FROM pages WHERE id = ?").run(id);
	}
	db.close();
	// One of them is not what it seems: a link to somewhere else. That one is never followed.
	const outside = path.join(dir, "outside");
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "keep"), "x");
	fs.rmSync(pageDir(dir, oldLinked.id), { recursive: true });
	fs.symlinkSync(outside, pageDir(dir, oldLinked.id));
	// And things in the shards that are no records at all.
	fs.mkdirSync(path.join(dir, "pages", old.id.slice(-2), "not-an-id"));
	fs.writeFileSync(path.join(dir, "pages", "stray-file"), "x");

	const again = new PageStore({ dataDir: dir, clock, log });
	t.after(() => again.close());
	assert.equal(again.stats().pages, 1);
	clock.advance(15 * MIN);
	// old: 35 minutes by its id. young: 15.
	assert.deepEqual(again.purge({ maxAgeMs: 40 * MIN }), { rows: 0, dirs: 0, refused: 0, files: 0, unknown: 0 });
	assert.equal(fs.existsSync(pageDir(dir, old.id)), true);
	assert.deepEqual(again.purge({ maxAgeMs: 30 * MIN }), { rows: 0, dirs: 0, refused: 0, files: 0, unknown: 1 });
	assert.equal(fs.existsSync(pageDir(dir, old.id)), false);
	assert.equal(fs.existsSync(pageDir(dir, young.id)), true, "not old enough yet");
	assert.equal(fs.existsSync(path.join(outside, "keep")), true);
	assert.equal(fs.existsSync(path.join(dir, "pages", old.id.slice(-2), "not-an-id")), true, "what is no record is not this purge's to remove");
	assert.deepEqual(again.purge({ maxAgeMs: 30 * MIN }), { rows: 0, dirs: 0, refused: 0, files: 0, unknown: 0 });

	// The page the index knows goes with its row, the young stray by its id, at the same moment.
	clock.advance(16 * MIN);
	assert.deepEqual(again.purge({ maxAgeMs: 30 * MIN }), { rows: 1, dirs: 1, refused: 0, files: 0, unknown: 1 });
	assert.equal(fs.existsSync(pageDir(dir, young.id)), false);
	assert.equal(fs.existsSync(pageDir(dir, known.id)), false);
	assert.equal(again.stats().pages, 0);
});
