import { test } from "node:test";
import assert from "node:assert/strict";
import { FetchService, FETCH_LIMITS } from "../../daemon/src/fetchsvc.js";
import { createMcp } from "../../daemon/src/mcp.js";
import { buildTools, renderStatus } from "../../daemon/src/mcptools.js";
import { FORMATS, RENDER_LIMITS } from "../../daemon/src/render.js";
import { SEARCH_LIMITS } from "../../daemon/src/store.js";
import { openStore, quietLog } from "../helpers/pages.js";
import { zeroTimings } from "../../extension/shared/protocol.js";

/** @typedef {import("../../daemon/src/queue.js").JobSpec} JobSpec */
/** @typedef {import("../../daemon/src/queue.js").JobReport} JobReport */

const NONCE = () => Uint8Array.of(0x11, 0x22, 0x33, 0x44);

/** @returns {JobReport} */
function okReport() {
	return {
		job: "j_test",
		outcome: "ok",
		cookie_scope: "container",
		nav: {
			requested_url: "https://example.com/a",
			final_url: "https://example.com/article/a",
			redirect_origins: ["https://example.com"],
			http_status: 200,
			content_type: "text/html",
			body_bytes: null,
		},
		render: { visibility: "visible", raf_hz: 60, settled: true, scrolled_px: 0, scroll: "off", dwell: "off", elapsed_ms: 100, timings: zeroTimings() },
		detect: null,
		error: null,
		page: { title: "Example article", author: "A. Writer", published: "2026-10-01", lang: "en", site: "Example", word_count: 9, extractor: "defuddle@0.19.4" },
		extraction: null,
		content: {
			markdown: `# Example article\n\nThe quick brown fox is running over the lazy dog.\n\n${"More text about foxes. ".repeat(30)}`,
			text: null,
			html: "<html><body><p>The quick brown fox</p></body></html>",
			raw_html: "<!DOCTYPE html>\n<html><body><!-- note --><p>The quick brown fox</p><script>var a = 1;</script></body></html>",
			links: [{ url: "https://example.com/next", text: "Next page" }],
			results: [],
		},
		truncated: { markdown: false, text: false, html: false, raw_html: false },
		file: null,
		tab_kept_open: false,
		...{},
	};
}

/** Real FetchService on a temp store with a fake submitJob. @param {import("node:test").TestContext} t */
function realSetup(t) {
	const ctx = openStore(t);
	/** @type {JobSpec[]} */
	const calls = [];
	const svc = new FetchService({
		store: ctx.store,
		submitJob: async (spec) => (calls.push(spec), okReport()),
		clock: ctx.clock,
		log: quietLog(),
		options: { randomBytes: NONCE },
	});
	return { ...ctx, svc, calls };
}

const STATUS = { paired: true, extension: { connected: true }, paused: false, pending_actions: 0, queue_depth: 2, store: { pages: 3, bytes: 1024 } };

/** @param {import("../../daemon/src/mcptools.js").StatusFn} [status] */
const toolsFor = (/** @type {any} */ fetchsvc, status = () => STATUS) => buildTools({ fetchsvc, status });

/** @param {ReturnType<typeof toolsFor>} tools */
function client(tools) {
	const mcp = createMcp({ serverInfo: { name: "browser-gateway", version: "0.0.1" }, tools, log: quietLog() });
	let id = 0;
	return {
		/** @param {string} name @param {unknown} args */
		async call(name, args) {
			const r = await mcp.handle({
				method: "POST",
				headers: { accept: "application/json, text/event-stream" },
				body: { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } },
			});
			return /** @type {{ result: { isError: boolean, content: Array<{ type: string, text: string }> } }} */ (r.body).result;
		},
		async list() {
			return mcp.handle({ method: "POST", headers: {}, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
		},
	};
}

/** @param {string} name */
const byName = (name) => /** @type {any} */ (toolsFor({}).find((t) => t.name === name));

const BASE = /** @type {Record<string, Record<string, unknown>>} */ ({
	browser_fetch: { url: "https://example.com/a" },
	page_read: { page: "pg_00000000000000000000000000" },
	page_search: { query: "fox" },
});

/**
 * Values at and just past every bound of every property.
 * @param {any} schema
 * @param {Record<string, unknown>} base
 */
function boundaryCases(schema, base) {
	/** @type {Array<{ label: string, args: Record<string, unknown> }>} */
	const valid = [{ label: "base only", args: base }];
	/** @type {Array<{ label: string, args: Record<string, unknown> }>} */
	const invalid = [];
	for (const [name, p] of Object.entries(schema.properties)) {
		/** @type {any} */
		const s = p;
		/** @type {unknown[]} */
		const ok = [];
		/** @type {unknown[]} */
		const bad = [];
		if (s.type === "integer") {
			ok.push(s.minimum, s.maximum, s.default);
			bad.push(s.minimum - 1, s.maximum + 1, 1.5, "5", null, true);
		} else if (s.type === "string" && s.enum) {
			ok.push(...s.enum, s.default);
			bad.push("nope", "", 5, null);
		} else if (s.type === "string") {
			ok.push("a".repeat(s.minLength), "a".repeat(s.maxLength));
			bad.push("a".repeat(s.maxLength + 1), 5, null);
			if (s.minLength > 0) bad.push("");
		} else if (s.type === "boolean") {
			ok.push(true, false, s.default);
			bad.push("true", 1, null);
		}
		for (const v of ok) valid.push({ label: `${name}=${JSON.stringify(v).slice(0, 30)}`, args: { ...base, [name]: v } });
		for (const v of bad) invalid.push({ label: `${name}=${JSON.stringify(v)?.slice(0, 30)}`, args: { ...base, [name]: v } });
	}
	return { valid, invalid };
}

test("buildTools returns the five tools in a stable order with strict object schemas", () => {
	const tools = toolsFor({});
	assert.deepEqual(tools.map((t) => t.name), ["browser_fetch", "browser_search", "page_read", "page_search", "gateway_status"]);
	for (const t of tools) {
		assert.equal(t.inputSchema.type, "object");
		assert.equal(t.inputSchema.additionalProperties, false, t.name);
		assert.equal(typeof t.title, "string");
		assert.equal(typeof t.handler, "function");
		const props = /** @type {Record<string, any>} */ (t.inputSchema.properties);
		for (const [k, p] of Object.entries(props)) {
			assert.ok(p.type, `${t.name}.${k} has a type`);
			assert.equal(typeof p.description === "string" || k === "format", true, `${t.name}.${k}`);
		}
	}
	assert.deepEqual(byName("browser_fetch").inputSchema.required, ["url"]);
	assert.deepEqual(byName("page_read").inputSchema.required, ["page"]);
	assert.deepEqual(byName("page_search").inputSchema.required, ["query"]);
	assert.equal(byName("gateway_status").inputSchema.required, undefined);
});

test("schema literals match the fetchsvc bounds exactly", () => {
	const f = byName("browser_fetch").inputSchema.properties;
	assert.deepEqual(f.url, { type: "string", minLength: 1, maxLength: 8192, description: f.url.description });
	assert.deepEqual(f.format.enum, ["markdown", "text", "html", "raw_html", "links"]);
	assert.deepEqual(f.format.enum, [...FORMATS]);
	assert.equal(f.format.default, "markdown");
	assert.match(f.format.description, /full page/);
	assert.match(f.format.description, /extraction:/);
	assert.match(f.format.description, /text: all visible text/);
	assert.match(f.format.description, /raw_html: the page source, large \(continue with page_read offsets\)/);
	assert.deepEqual([f.max_chars.minimum, f.max_chars.maximum, f.max_chars.default], [100, 60000, 20000]);
	assert.equal(f.fresh.default, false);
	assert.deepEqual(f.session.enum, ["auto", "isolated"]);
	assert.equal(f.session.default, "auto");
	assert.deepEqual([f.wait_for_human_s.minimum, f.wait_for_human_s.maximum, f.wait_for_human_s.default], [0, 120, 0]);
	assert.equal(FETCH_LIMITS.maxWaitForHumanS, 120);
	const r = byName("page_read").inputSchema.properties;
	assert.deepEqual([r.page.minLength, r.page.maxLength], [1, 64]);
	assert.deepEqual([r.offset.minimum, r.offset.maximum, r.offset.default], [0, Number.MAX_SAFE_INTEGER, 0]);
	assert.deepEqual(r.max_chars, f.max_chars);
	assert.deepEqual([r.format.enum, r.format.default], [f.format.enum, f.format.default]);
	assert.match(r.format.description, /call being continued/);
	const s = byName("page_search").inputSchema.properties;
	assert.deepEqual([s.query.minLength, s.query.maxLength], [1, 500]);
	assert.deepEqual([s.limit.minimum, s.limit.maximum, s.limit.default], [1, 50, 10]);
	assert.equal(SEARCH_LIMITS.maxHits, 50);
	assert.equal(RENDER_LIMITS.hardMaxChars, 60000);
});

test("descriptions: guidance for an agent, short, no marketing", () => {
	const d = (/** @type {string} */ n) => /** @type {string} */ (byName(n).description);
	const fetchDesc = d("browser_fetch");
	// The gateway is the preferred way to read the web, and the descriptions say so: an agent that reads them as
	// "only when something else failed" does not pick the tools up.
	assert.match(fetchDesc, /Preferred over a built-in web fetch/);
	assert.match(fetchDesc, /what a real browser shows/);
	assert.match(d("browser_search"), /Preferred over a built-in web search/);
	assert.match(fetchDesc, /needs_human/);
	assert.match(fetchDesc, /blocked/);
	assert.match(fetchDesc, /do not retry in a loop/);
	for (const n of ["browser_fetch", "page_read", "page_search"]) {
		assert.match(d(n), /untrusted web content/, n);
		assert.match(d(n), /data/, n);
		assert.match(d(n), /BEGIN\/END_UNTRUSTED_WEB_CONTENT/, n);
	}
	assert.match(d("page_read"), /offset/);
	assert.match(d("page_read"), /without fetching again/);
	for (const n of ["browser_fetch", "browser_search", "page_read", "page_search", "gateway_status"]) {
		assert.ok(d(n).length < 450, `${n} description is ${d(n).length} chars`);
		assert.doesNotMatch(d(n), /powerful|seamless|best|cutting-edge|revolutionary|easily|robust/i);
	}
});

test("annotations: every tool reads only, the two that load pages reach the open web; tools/list carries them", async () => {
	const r = await client(toolsFor({})).list();
	const tools = /** @type {any} */ (r.body).result.tools;
	assert.deepEqual(Object.fromEntries(tools.map((/** @type {any} */ t) => [t.name, t.annotations])), {
		browser_fetch: { readOnlyHint: true, openWorldHint: true },
		browser_search: { readOnlyHint: true, openWorldHint: true },
		page_read: { readOnlyHint: true, openWorldHint: false },
		page_search: { readOnlyHint: true, openWorldHint: false },
		gateway_status: { readOnlyHint: true, openWorldHint: false },
	});
});

test("tools/list result stays under about 1200 tokens", async () => {
	const c = client(toolsFor({}));
	const r = await c.list();
	const text = JSON.stringify(/** @type {any} */ (r.body).result);
	// 4 characters per token is the usual rule of thumb for English plus JSON. Five tools, with their annotations.
	assert.ok(text.length < 4700, `serialised tools/list is ${text.length} characters`);
	assert.ok(text.length > 1500);
	console.log(`tools/list serialised size: ${text.length} characters`);
});

test("fake fetchsvc: arguments at the schema bounds reach the service unchanged", async () => {
	/** @type {Array<[string, unknown]>} */
	const seen = [];
	const fake = {
		fetchPage: async (/** @type {unknown} */ a) => (seen.push(["fetch", a]), { isError: false, text: "F", outcome: "ok", page: null, code: null }),
		readPage: async (/** @type {unknown} */ a) => (seen.push(["read", a]), { isError: true, text: "R", outcome: "error", page: null, code: "x" }),
		searchPages: async (/** @type {unknown} */ a) => (seen.push(["search", a]), { isError: false, text: "S", outcome: "ok", page: null, code: null }),
	};
	const c = client(toolsFor(fake));
	const expected = /** @type {Record<string, [string, string, boolean]>} */ ({
		browser_fetch: ["fetch", "F", false],
		page_read: ["read", "R", true],
		page_search: ["search", "S", false],
	});
	for (const name of Object.keys(expected)) {
		const { valid } = boundaryCases(byName(name).inputSchema, BASE[name]);
		for (const { label, args } of valid) {
			seen.length = 0;
			const r = await c.call(name, args);
			assert.equal(seen.length, 1, `${name} ${label}`);
			assert.deepEqual(seen[0], [expected[name][0], args], `${name} ${label}`);
			assert.deepEqual(r, { isError: expected[name][2], content: [{ type: "text", text: expected[name][1] }] });
		}
	}
	// extra fields of the service result (outcome, page, code) never leak into the MCP result
	const r = await c.call("browser_fetch", BASE.browser_fetch);
	assert.deepEqual(Object.keys(r).sort(), ["content", "isError"]);
});

test("real FetchService: every in-bound value is accepted, every out-of-bound value is rejected", async (t) => {
	const { svc } = realSetup(t);
	const c = client(toolsFor(svc));
	for (const name of Object.keys(BASE)) {
		const { valid, invalid } = boundaryCases(byName(name).inputSchema, BASE[name]);
		for (const { label, args } of valid) {
			const r = await c.call(name, args);
			assert.ok(!r.content[0].text.includes("code=invalid_argument"), `${name} ${label}: ${r.content[0].text.split("\n")[0]}`);
		}
		for (const { label, args } of invalid) {
			const r = await c.call(name, args);
			assert.equal(r.isError, true, `${name} ${label}`);
			assert.match(r.content[0].text, /code=invalid_argument/, `${name} ${label}`);
		}
		// schema says additionalProperties:false, the service agrees
		const extra = await c.call(name, { ...BASE[name], surprise: 1 });
		assert.match(extra.content[0].text, /code=invalid_argument/);
		// and so does a missing required argument
		const missing = await c.call(name, {});
		assert.match(missing.content[0].text, /code=invalid_argument/);
	}
});

test("real FetchService: defaults in the schema equal the service defaults", async (t) => {
	const a = realSetup(t);
	const b = realSetup(t);
	const ca = client(toolsFor(a.svc));
	const cb = client(toolsFor(b.svc));
	await ca.call("browser_fetch", { url: "https://example.com/a" });
	/** @type {Record<string, unknown>} */
	const defaults = { url: "https://example.com/a" };
	for (const [k, p] of Object.entries(byName("browser_fetch").inputSchema.properties)) if ("default" in /** @type {object} */ (p)) defaults[k] = /** @type {any} */ (p).default;
	await cb.call("browser_fetch", defaults);
	assert.deepEqual(a.calls, b.calls, "same job spec");

	const page = /** @type {string} */ (/(pg_[0-9A-HJKMNP-TV-Z]{26})/.exec((await ca.call("browser_fetch", { url: "https://example.com/a", fresh: true })).content[0].text)?.[1]);
	const rd = byName("page_read").inputSchema.properties;
	/** @type {Record<string, unknown>} */
	const readDefaults = { page };
	for (const [k, p] of Object.entries(rd)) if ("default" in /** @type {object} */ (p)) readDefaults[k] = /** @type {any} */ (p).default;
	assert.equal((await ca.call("page_read", { page })).content[0].text, (await ca.call("page_read", readDefaults)).content[0].text);
	const sd = byName("page_search").inputSchema.properties;
	assert.equal((await ca.call("page_search", { query: "fox" })).content[0].text, (await ca.call("page_search", { query: "fox", limit: sd.limit.default })).content[0].text);
});

test("real FetchService end to end: fetch, continue with page_read, search, status", async (t) => {
	const { svc, calls } = realSetup(t);
	const c = client(toolsFor(svc));
	const f = await c.call("browser_fetch", { url: "https://example.com/a", max_chars: 200 });
	assert.equal(f.isError, false);
	assert.equal(calls.length, 1);
	const text = f.content[0].text;
	assert.match(text, /^\[browser-gateway\] outcome=ok page=pg_/);
	assert.match(text, /<<<BEGIN_UNTRUSTED_WEB_CONTENT 11223344>>>/);
	const page = /page=(pg_[0-9A-HJKMNP-TV-Z]{26})/.exec(text)?.[1];
	const next = /next: page_read\(page="[^"]+", offset=(\d+)\)/.exec(text)?.[1];
	assert.ok(page && next, "result tells how to continue");
	const more = await c.call("page_read", { page, offset: Number(next), max_chars: 300 });
	assert.equal(more.isError, false);
	assert.equal(calls.length, 1, "page_read never navigates");
	const hits = await c.call("page_search", { query: "foxes" });
	assert.equal(hits.isError, false);
	assert.ok(hits.content[0].text.includes(String(page)));
	const gone = await c.call("page_read", { page: "pg_00000000000000000000000000" });
	assert.equal(gone.isError, true);
	assert.match(gone.content[0].text, /code=unknown_page/);
	const st = await c.call("gateway_status", {});
	assert.equal(st.isError, false);
});

test("raw_html through the tools, and no tool exports content", async (t) => {
	const { svc, calls } = realSetup(t);
	const tools = toolsFor(svc);
	assert.equal(tools.some((x) => /export/i.test(x.name)), false, "export is not an MCP tool: its answer would be undelimited page content");
	const c = client(tools);
	const f = await c.call("browser_fetch", { url: "https://example.com/a", format: "raw_html" });
	assert.equal(f.isError, false);
	assert.equal(calls[0].extract.raw_html, true);
	const text = f.content[0].text;
	assert.match(text, /format=raw_html/);
	assert.match(text, /<script>var a = 1;<\/script>/);
	assert.match(text, /\(comment removed\)/);
	const page = /page=(pg_[0-9A-HJKMNP-TV-Z]{26})/.exec(text)?.[1];
	const more = await c.call("page_read", { page, format: "raw_html", offset: 20, max_chars: 100 });
	assert.equal(more.isError, false);
	assert.match(more.content[0].text, /chars: 20-/);
	assert.equal(calls.length, 1);
	const bad = await c.call("page_read", { page, format: "export" });
	assert.equal(bad.isError, true);
	const unknown = await c.call("browser_fetch", { url: "https://example.com/a", raw_html: true });
	assert.equal(unknown.isError, true);
});

test("real FetchService: a needs_human outcome is an isError result with the action text", async (t) => {
	const ctx = openStore(t);
	const svc = new FetchService({
		store: ctx.store,
		submitJob: async () => ({
			...okReport(),
			outcome: "needs_human",
			content: null,
			error: { code: "challenge", message: "", retryable: false, retry_after_s: 60 },
		}),
		clock: ctx.clock,
		log: quietLog(),
		options: { randomBytes: NONCE },
	});
	const r = await client(toolsFor(svc)).call("browser_fetch", { url: "https://example.com/a" });
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /outcome=needs_human/);
	assert.match(r.content[0].text, /Do not retry in a loop/);
});

test("gateway_status renders key: value lines and accepts no arguments", async () => {
	const c = client(toolsFor({}));
	const r = await c.call("gateway_status", {});
	assert.equal(r.isError, false);
	assert.equal(
		r.content[0].text,
		["paired: true", "extension.connected: true", "paused: false", "pending_actions: 0", "queue_depth: 2", "store.pages: 3", "store.bytes: 1024"].join("\n"),
	);
	const bad = await c.call("gateway_status", { verbose: true });
	assert.equal(bad.isError, true);
	assert.match(bad.content[0].text, /Unknown argument: verbose/);
});

test("renderStatus: scalars, arrays, null, multi-line values, depth and length caps", () => {
	assert.equal(renderStatus({ a: 1, b: null, c: [1, "x"], d: "l1\nl2\r\nl3", e: undefined }), 'a: 1\nb: null\nc: [1,"x"]\nd: l1 l2 l3\ne: undefined');
	assert.equal(renderStatus({}), "");
	const deep = renderStatus({ a: { b: { c: { d: { e: 1 } } } } });
	assert.equal(deep.split("\n").length, 1);
	assert.ok(deep.startsWith("a.b.c.d: "));
	assert.ok(renderStatus({ s: "x".repeat(5000) }).length < 210);
});

test("gateway_status: a throwing status function becomes a generic tool error", async () => {
	const c = client(toolsFor({}, () => {
		throw new Error("db path /srv/x/secret");
	}));
	const r = await c.call("gateway_status", {});
	assert.equal(r.isError, true);
	assert.ok(!r.content[0].text.includes("secret"));
});

test("a sixth tool can be appended through the same registry", async () => {
	const tools = toolsFor({});
	tools.push({
		name: "browser_extra",
		title: "One more",
		description: "Search.",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
		handler: async () => ({ isError: false, text: "hits" }),
	});
	const c = client(tools);
	const names = /** @type {any} */ ((await c.list()).body).result.tools.map((/** @type {{ name: string }} */ t) => t.name);
	assert.deepEqual(names, ["browser_fetch", "browser_search", "page_read", "page_search", "gateway_status", "browser_extra"]);
	assert.equal((await c.call("browser_extra", { query: "x" })).content[0].text, "hits");
});
