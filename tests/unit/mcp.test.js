import { test } from "node:test";
import assert from "node:assert/strict";
import { BODY_PARSE_ERROR, LEGACY_VERSIONS, MCP_LIMITS, RPC, SUPPORTED_VERSIONS, createMcp } from "../../daemon/src/mcp.js";
import { quietLog } from "../helpers/pages.js";

/** @typedef {import("../../daemon/src/mcp.js").McpTool} McpTool */

const V = "io.modelcontextprotocol/protocolVersion";
const C = "io.modelcontextprotocol/clientCapabilities";
const S = "io.modelcontextprotocol/serverInfo";
const ACCEPT = "application/json, text/event-stream";

/** @param {Partial<McpTool>} [over] @returns {McpTool} */
function tool(over = {}) {
	return {
		name: "echo",
		title: "Echo",
		description: "Echo the text.",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
		handler: async (args) => ({ isError: false, text: `echo:${String(args.text ?? "")}` }),
		...over,
	};
}

/** @param {{ tools?: McpTool[] }} [opts] */
function setup(opts = {}) {
	const log = quietLog();
	const mcp = createMcp({ serverInfo: { name: "browser-gateway", version: "0.0.1" }, tools: opts.tools ?? [tool()], log });
	/** @type {(headers: Record<string, string | string[] | undefined>, body: unknown, method?: string) => ReturnType<typeof mcp.handle>} */
	const post = (headers, body, method = "POST") => mcp.handle({ method, headers: { accept: ACCEPT, ...headers }, body });
	return { mcp, log, post };
}

/** @param {Record<string, unknown>} [extra] */
const meta = (extra = {}) => ({ [V]: "2026-07-28", [C]: {}, "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, ...extra });

/** Headers a modern client sends. @param {string} method @param {string} [name] */
const mh = (method, name) => ({ "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(name === undefined ? {} : { "mcp-name": name }) });

/** @param {number} id @param {string} method @param {Record<string, unknown>} [params] */
const modernReq = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta() } });

/** @param {import("../../daemon/src/mcp.js").McpResponse} r */
const err = (r) => /** @type {{ id: unknown, error: { code: number, message: string, data?: any } }} */ (r.body);
/** @param {import("../../daemon/src/mcp.js").McpResponse} r */
const res = (r) => /** @type {{ id: unknown, result: any }} */ (r.body);

test("legacy handshake as a client does it: initialize, initialized, tools/list, tools/call", async () => {
	const { post } = setup();
	const init = await post({}, {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: "2025-11-25", capabilities: { roots: {} }, clientInfo: { name: "claude-code", version: "9" } },
	});
	assert.equal(init.status, 200);
	assert.equal(init.headers["content-type"], "application/json; charset=utf-8");
	assert.equal(init.headers["mcp-session-id"], undefined);
	const r = res(init).result;
	assert.equal(res(init).id, 1);
	assert.equal(r.protocolVersion, "2025-11-25");
	assert.deepEqual(r.capabilities, { tools: {} });
	assert.deepEqual(r.serverInfo, { name: "browser-gateway", version: "0.0.1" });
	assert.equal(typeof r.instructions, "string");
	assert.ok(r.instructions.length < 400);
	assert.equal(r.resultType, undefined, "legacy results carry no resultType");

	const note = await post({ "mcp-protocol-version": "2025-11-25" }, { jsonrpc: "2.0", method: "notifications/initialized" });
	assert.deepEqual(note, { status: 202, headers: {}, body: null });

	const list = await post({ "mcp-protocol-version": "2025-11-25" }, { jsonrpc: "2.0", id: 2, method: "tools/list" });
	assert.equal(list.status, 200);
	assert.deepEqual(res(list).result, {
		tools: [{ name: "echo", title: "Echo", description: "Echo the text.", inputSchema: tool().inputSchema }],
	});

	const call = await post({ "mcp-protocol-version": "2025-11-25" }, {
		jsonrpc: "2.0",
		id: "abc",
		method: "tools/call",
		params: { name: "echo", arguments: { text: "hi" } },
	});
	assert.equal(res(call).id, "abc");
	assert.deepEqual(res(call).result, { content: [{ type: "text", text: "echo:hi" }], isError: false });
});

test("modern handshake: no initialize, discover optional, results carry resultType and serverInfo", async () => {
	const { post } = setup();
	const d = await post(mh("server/discover"), modernReq(1, "server/discover"));
	assert.equal(d.status, 200);
	const dr = res(d).result;
	assert.equal(dr.resultType, "complete");
	assert.deepEqual(dr.supportedVersions, [...SUPPORTED_VERSIONS]);
	assert.deepEqual(dr.capabilities, { tools: {} });
	assert.deepEqual(dr._meta[S], { name: "browser-gateway", version: "0.0.1" });
	assert.equal(typeof dr.instructions, "string");
	assert.equal(dr.cacheScope, "public");
	assert.ok(Number.isInteger(dr.ttlMs) && dr.ttlMs >= 0);

	const l = await post(mh("tools/list"), modernReq(2, "tools/list"));
	const lr = res(l).result;
	assert.equal(lr.resultType, "complete");
	assert.equal(lr.tools.length, 1);
	assert.equal(lr.ttlMs, MCP_LIMITS.toolsTtlMs);
	assert.equal(lr.cacheScope, "public");
	assert.equal(lr.nextCursor, undefined);

	const c = await post(mh("tools/call", "echo"), modernReq(3, "tools/call", { name: "echo", arguments: { text: "x" } }));
	assert.equal(c.status, 200);
	assert.deepEqual(res(c).result.content, [{ type: "text", text: "echo:x" }]);
	assert.equal(res(c).result.isError, false);
	assert.equal(res(c).result.resultType, "complete");
	assert.equal(res(c).result.structuredContent, undefined);
});

test("legacy version negotiation: newer, older supported, unsupported", async () => {
	const { post } = setup();
	/** @param {unknown} v */
	const init = async (v) => res(await post({}, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, capabilities: {}, clientInfo: {} } })).result.protocolVersion;
	assert.equal(await init("2026-07-28"), "2025-11-25", "newer than any legacy: our latest legacy");
	assert.equal(await init("2099-01-01"), "2025-11-25");
	for (const v of LEGACY_VERSIONS) assert.equal(await init(v), v, `older supported ${v} is echoed`);
	assert.equal(await init("2024-10-07"), "2025-11-25", "unsupported: another version we support");
	assert.equal(await init("1.0.0"), "2025-11-25");
});

test("initialize with bad params is -32602", async () => {
	const { post } = setup();
	for (const params of [undefined, [], "x", {}, { protocolVersion: 5 }, { protocolVersion: "" }]) {
		const r = await post({}, { jsonrpc: "2.0", id: 1, method: "initialize", params });
		assert.equal(err(r).error.code, RPC.INVALID_PARAMS, JSON.stringify(params));
		assert.equal(err(r).id, 1);
	}
});

test("modern: unsupported version gives -32022 with 400 and the supported list", async () => {
	const { post } = setup();
	const r = await post(
		{ "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" },
		{ jsonrpc: "2.0", id: 7, method: "tools/list", params: { _meta: meta({ [V]: "1900-01-01" }) } },
	);
	assert.equal(r.status, 400);
	assert.equal(err(r).id, 7);
	assert.equal(err(r).error.code, RPC.UNSUPPORTED_PROTOCOL_VERSION);
	assert.deepEqual(err(r).error.data, { supported: [...SUPPORTED_VERSIONS], requested: "1900-01-01" });
});

test("modern: header and _meta rules", async () => {
	const { post } = setup();
	const body = modernReq(1, "tools/list");
	/** @param {import("../../daemon/src/mcp.js").McpResponse} r @param {number} code @param {number} status */
	const expectErr = (r, code, status) => {
		assert.equal(r.status, status);
		assert.equal(err(r).error.code, code);
		assert.equal(err(r).id, 1);
	};
	expectErr(await post({ "mcp-method": "tools/list" }, body), RPC.HEADER_MISMATCH, 400);
	expectErr(await post({ ...mh("tools/list"), "mcp-protocol-version": "2025-11-25" }, body), RPC.HEADER_MISMATCH, 400);
	expectErr(await post({ ...mh("tools/list"), "mcp-protocol-version": ["2026-07-28", "2026-07-28"] }, body), RPC.HEADER_MISMATCH, 400);
	expectErr(await post({ "mcp-protocol-version": "2026-07-28" }, body), RPC.HEADER_MISMATCH, 400);
	expectErr(await post(mh("tools/call"), body), RPC.HEADER_MISMATCH, 400);
	// header present, _meta absent or incomplete
	expectErr(await post(mh("tools/list"), { jsonrpc: "2.0", id: 1, method: "tools/list" }), RPC.INVALID_PARAMS, 400);
	expectErr(await post(mh("tools/list"), { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [V]: "2026-07-28" } } }), RPC.INVALID_PARAMS, 400);
	expectErr(await post(mh("tools/list"), { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [C]: {} } } }), RPC.INVALID_PARAMS, 400);
	expectErr(await post(mh("tools/list"), { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta({ [C]: [] }) } }), RPC.INVALID_PARAMS, 400);
	expectErr(await post(mh("tools/list"), { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta({ [V]: 5 }) } }), RPC.INVALID_PARAMS, 400);
	// extra _meta keys and unknown clientInfo fields are tolerated
	const okRes = await post(mh("tools/list"), { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta({ traceparent: "x", "com.example/k": 1 }), extra: true } });
	assert.equal(okRes.status, 200);
});

test("modern: Mcp-Method and Mcp-Name must match the body; Base64 sentinel is decoded", async () => {
	const { post } = setup();
	const call = modernReq(4, "tools/call", { name: "echo", arguments: {} });
	let r = await post({ ...mh("tools/call", "echo"), "mcp-method": "tools/list" }, call);
	assert.equal(err(r).error.code, RPC.HEADER_MISMATCH);
	r = await post(mh("tools/call"), call);
	assert.equal(err(r).error.code, RPC.HEADER_MISMATCH);
	r = await post(mh("tools/call", "other"), call);
	assert.equal(r.status, 400);
	assert.equal(err(r).error.code, RPC.HEADER_MISMATCH);
	r = await post(mh("tools/call", `=?base64?${Buffer.from("echo").toString("base64")}?=`), call);
	assert.equal(r.status, 200);
	r = await post(mh("tools/call", "=?base64?!!!?="), call);
	assert.equal(err(r).error.code, RPC.HEADER_MISMATCH);
	// header names are case-insensitive
	r = await post({ "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "MCP-NAME": "echo" }, call);
	assert.equal(r.status, 200);
});

test("modern: ping is removed, unknown methods are 404 -32601; legacy gets 200 -32601 and ping works", async () => {
	const { post } = setup();
	let r = await post(mh("ping"), modernReq(1, "ping"));
	assert.equal(r.status, 404);
	assert.equal(err(r).error.code, RPC.METHOD_NOT_FOUND);
	r = await post(mh("resources/list"), modernReq(2, "resources/list"));
	assert.equal(r.status, 404);
	assert.equal(err(r).error.code, RPC.METHOD_NOT_FOUND);
	assert.equal(err(r).id, 2);

	r = await post({}, { jsonrpc: "2.0", id: 3, method: "ping" });
	assert.equal(r.status, 200);
	assert.deepEqual(res(r), { jsonrpc: "2.0", id: 3, result: {} });
	for (const m of ["resources/list", "prompts/list", "completion/complete", "logging/setLevel", "nope"]) {
		r = await post({}, { jsonrpc: "2.0", id: 4, method: m });
		assert.equal(r.status, 200, m);
		assert.equal(err(r).error.code, RPC.METHOD_NOT_FOUND, m);
	}
});

test("legacy header rules: missing means 2025-03-26, unsupported or repeated is 400", async () => {
	const { post } = setup();
	const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
	assert.equal((await post({}, list)).status, 200);
	for (const v of LEGACY_VERSIONS) assert.equal((await post({ "mcp-protocol-version": v }, list)).status, 200, v);
	for (const v of ["2099-01-01", "garbage", "", ["2025-11-25", "2025-06-18"]]) {
		const r = await post({ "mcp-protocol-version": v }, list);
		assert.equal(r.status, 400, JSON.stringify(v));
		assert.equal(err(r).error.code, RPC.UNSUPPORTED_PROTOCOL_VERSION);
		assert.deepEqual(err(r).error.data.supported, [...SUPPORTED_VERSIONS]);
	}
	// initialize is the first message: a stray header does not block it
	const r = await post({ "mcp-protocol-version": "2099-01-01" }, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
	assert.equal(res(r).result.protocolVersion, "2025-06-18");
	// session headers are ignored and never echoed
	const s = await post({ "mcp-session-id": "abc", "last-event-id": "1" }, list);
	assert.equal(s.status, 200);
	assert.equal(s.headers["mcp-session-id"], undefined);
});

test("GET, DELETE and other methods: 405 with Allow: POST and no body", async () => {
	const { post } = setup();
	for (const m of ["GET", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"]) {
		const r = await post({}, undefined, m);
		assert.deepEqual(r, { status: 405, headers: { allow: "POST" }, body: null }, m);
	}
	const withSession = await post({ "mcp-session-id": "x" }, undefined, "DELETE");
	assert.equal(withSession.status, 405);
});

test("Accept handling: lenient about common clients, 406 when JSON is excluded", async () => {
	const { mcp } = setup();
	const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
	/** @param {string | string[] | undefined} accept */
	const status = async (accept) => (await mcp.handle({ method: "POST", headers: accept === undefined ? {} : { accept }, body })).status;
	for (const a of [undefined, "", "application/json", "application/json, text/event-stream", "text/event-stream, application/json", "*/*", "application/*", "APPLICATION/JSON;q=0.9", "text/html, */*;q=0.1", ["text/event-stream", "application/json"]]) {
		assert.equal(await status(a), 200, JSON.stringify(a));
	}
	for (const a of ["text/event-stream", "text/html", "application/xml", "application/json;q=0", "garbage", "json"]) {
		assert.equal(await status(a), 406, a);
	}
	const r = await mcp.handle({ method: "POST", headers: { accept: "text/html" }, body });
	assert.equal(err(r).error.code, RPC.INVALID_REQUEST);
	assert.equal(err(r).id, null);
});

test("notifications and responses: 202 with no body, nothing executed", async () => {
	let called = 0;
	const { post } = setup({ tools: [tool({ handler: async () => (called++, { isError: false, text: "" }) })] });
	for (const m of ["notifications/initialized", "notifications/cancelled", "notifications/roots/list_changed", "whatever/else", "tools/call", "initialize", "ping"]) {
		const r = await post({}, { jsonrpc: "2.0", method: m, params: { name: "echo" } });
		assert.deepEqual(r, { status: 202, headers: {}, body: null }, m);
	}
	assert.equal(called, 0);
	// notification without params, with odd params, with modern headers
	assert.equal((await post({}, { jsonrpc: "2.0", method: "notifications/initialized", params: 5 })).status, 202);
	assert.equal((await post(mh("notifications/initialized"), { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
	// responses
	assert.deepEqual(await post({}, { jsonrpc: "2.0", id: 1, result: {} }), { status: 202, headers: {}, body: null });
	assert.equal((await post({}, { jsonrpc: "2.0", id: "x", error: { code: -1, message: "no" } })).status, 202);
	assert.equal((await post({}, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "no" } })).status, 202);
});

test("parse error and invalid requests: exact codes, 400, id echoed when readable", async () => {
	const { post } = setup();
	let r = await post({}, BODY_PARSE_ERROR);
	assert.equal(r.status, 400);
	assert.deepEqual(err(r), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });

	/** @type {Array<[string, unknown, unknown]>} */
	const cases = [
		["batch", [{ jsonrpc: "2.0", id: 1, method: "ping" }], null],
		["empty batch", [], null],
		["string body", "hello", null],
		["number body", 5, null],
		["null body", null, null],
		["undefined body", undefined, null],
		["empty object", {}, null],
		["no jsonrpc", { id: 1, method: "ping" }, 1],
		["wrong jsonrpc", { jsonrpc: "1.0", id: 2, method: "ping" }, 2],
		["numeric jsonrpc", { jsonrpc: 2, id: 3, method: "ping" }, 3],
		["method not a string", { jsonrpc: "2.0", id: 4, method: 5 }, 4],
		["empty method", { jsonrpc: "2.0", id: 5, method: "" }, 5],
		["null id", { jsonrpc: "2.0", id: null, method: "ping" }, null],
		["object id", { jsonrpc: "2.0", id: {}, method: "ping" }, null],
		["array id", { jsonrpc: "2.0", id: [1], method: "ping" }, null],
		["boolean id", { jsonrpc: "2.0", id: true, method: "ping" }, null],
		["float id", { jsonrpc: "2.0", id: 1.5, method: "ping" }, null],
		["response with both", { jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } }, 1],
		["response with neither", { jsonrpc: "2.0", id: 1 }, 1],
		["response bad error", { jsonrpc: "2.0", id: 1, error: "boom" }, 1],
		["response without id", { jsonrpc: "2.0", result: {} }, null],
		["notification-shaped wrong jsonrpc", { method: "notifications/initialized" }, null],
	];
	for (const [label, body, id] of cases) {
		r = await post({}, body);
		assert.equal(r.status, 400, label);
		assert.equal(err(r).error.code, RPC.INVALID_REQUEST, label);
		assert.equal(err(r).id, id, label);
		assert.equal(typeof err(r).error.message, "string");
	}
	// a modern-looking but malformed request is checked for shape first
	r = await post(mh("tools/list"), { id: 1, method: "tools/list" });
	assert.equal(err(r).error.code, RPC.INVALID_REQUEST);
});

test("ids: strings, integers and zero are echoed exactly", async () => {
	const { post } = setup();
	for (const id of [0, 1, -5, 2 ** 53 - 1, "", "a-b", "7"]) {
		const r = await post({}, { jsonrpc: "2.0", id, method: "ping" });
		assert.equal(res(r).id, id);
		assert.equal(typeof res(r).id, typeof id);
	}
});

test("tools/list: cursor handling and tolerated params", async () => {
	const { post } = setup();
	const req = (/** @type {unknown} */ params) => post({}, { jsonrpc: "2.0", id: 1, method: "tools/list", params });
	assert.equal((await req(undefined)).status, 200);
	assert.equal(res(await req({})).result.tools.length, 1);
	assert.equal(res(await req({ cursor: null, _meta: { progressToken: 1 }, other: 1 })).result.tools.length, 1);
	for (const bad of [{ cursor: "abc" }, { cursor: 5 }, [], "x", 5]) {
		const r = await req(bad);
		assert.equal(err(r).error.code, RPC.INVALID_PARAMS, JSON.stringify(bad));
	}
});

test("tools/call protocol errors are -32602 JSON-RPC errors", async () => {
	const { post } = setup();
	const call = (/** @type {unknown} */ params) => post({}, { jsonrpc: "2.0", id: 9, method: "tools/call", params });
	/** @type {unknown[]} */
	const bad = [
		undefined,
		null,
		[],
		"echo",
		{},
		{ name: 5 },
		{ name: "" },
		{ name: "x".repeat(MCP_LIMITS.maxNameChars + 1) },
		{ name: "nope" },
		{ name: "__proto__" },
		{ name: "constructor" },
		{ name: "echo", arguments: null },
		{ name: "echo", arguments: [] },
		{ name: "echo", arguments: "text=hi" },
		{ name: "echo", arguments: 5 },
	];
	for (const params of bad) {
		const r = await call(params);
		assert.equal(r.status, 200, JSON.stringify(params));
		assert.equal(err(r).error.code, RPC.INVALID_PARAMS, JSON.stringify(params));
		assert.equal(err(r).id, 9);
	}
	assert.match(err(await call({ name: "nope" })).error.message, /Unknown tool: nope/);
	// arguments omitted is the same as {}
	assert.deepEqual(res(await call({ name: "echo" })).result.content, [{ type: "text", text: "echo:" }]);
});

test("unknown fields are tolerated in params and arguments reach the handler untouched", async () => {
	/** @type {unknown} */
	let seen;
	const { post } = setup({ tools: [tool({ handler: async (a) => ((seen = a), { isError: false, text: "ok" }) })] });
	const r = await post({}, {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: "echo", arguments: { text: "a", extra: [1, { b: 2 }] }, _meta: { progressToken: "p" }, task: { ttl: 1 }, future: true },
		extraTop: 1,
	});
	assert.equal(res(r).result.isError, false);
	assert.deepEqual(seen, { text: "a", extra: [1, { b: 2 }] });
});

test("handler isError true is a successful response with isError and the text", async () => {
	const { post } = setup({ tools: [tool({ handler: async () => ({ isError: true, text: "outcome=needs_human" }) })] });
	const r = await post({}, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } });
	assert.equal(r.status, 200);
	assert.equal(err(r).error, undefined);
	assert.deepEqual(res(r).result, { content: [{ type: "text", text: "outcome=needs_human" }], isError: true });
});

test("handler throwing or returning junk becomes a generic isError result; details only in the log", async () => {
	for (const handler of [
		async () => {
			throw new Error("secret detail at /srv/x/token=abc");
		},
		() => {
			throw "string thrown";
		},
		async () => /** @type {any} */ (null),
		async () => /** @type {any} */ ({ text: 5, isError: false }),
		async () => /** @type {any} */ ({ text: "x" }),
	]) {
		const { post, log } = setup({ tools: [tool({ handler })] });
		const r = await post({}, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } });
		assert.equal(r.status, 200);
		assert.equal(res(r).result.isError, true);
		const text = res(r).result.content[0].text;
		assert.match(text, /failed unexpectedly/);
		assert.ok(!/secret|token|home|abc/.test(JSON.stringify(r.body)));
		assert.equal(log.events.length, 1);
	}
});

test("oversized and deeply nested arguments are rejected before the handler", async () => {
	let called = 0;
	const { post } = setup({ tools: [tool({ handler: async () => (called++, { isError: false, text: "" }) })] });
	const call = (/** @type {unknown} */ args) => post({}, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: args } });
	/** @type {any} */
	let deep = {};
	for (let i = 0; i < 5000; i++) deep = { a: deep };
	/** @type {any} */
	let arr = [];
	for (let i = 0; i < 5000; i++) arr = [arr];
	const wide = Object.fromEntries(Array.from({ length: MCP_LIMITS.maxArgNodes + 5 }, (_, i) => [`k${i}`, [i]]));
	for (const args of [deep, { x: arr }, { a: { b: { c: { d: { e: { f: { g: { h: {} } } } } } } } }, wide]) {
		const r = await call(args);
		assert.equal(err(r).error.code, RPC.INVALID_PARAMS);
		assert.match(err(r).error.message, /too large or too deeply nested/);
	}
	assert.equal(called, 0);
	// at the limits it still works
	assert.equal(res(await call({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } })).result.isError, false);
	assert.equal(called, 1);
	// a long string is fine as far as this layer is concerned
	assert.equal(res(await call({ text: "x".repeat(100000) })).result.isError, false);
});

test("hostile object keys do not break anything", async () => {
	const { post } = setup();
	const body = JSON.parse('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"__proto__":{"x":1},"constructor":2}}}');
	const r = await post({}, body);
	assert.equal(res(r).result.isError, false);
	assert.equal(/** @type {any} */ ({}).x, undefined);
});

test("only text content is ever returned", async () => {
	const { post } = setup();
	const r = await post({}, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "a" } } });
	assert.deepEqual(Object.keys(res(r).result).sort(), ["content", "isError"]);
	assert.deepEqual(Object.keys(res(r).result.content[0]).sort(), ["text", "type"]);
});

test("registry is validated at construction and tools/list keeps registration order", async () => {
	const log = quietLog();
	const info = { name: "x", version: "1" };
	assert.throws(() => createMcp({ serverInfo: info, tools: [tool(), tool()], log }), /duplicate/);
	assert.throws(() => createMcp({ serverInfo: info, tools: [tool({ name: "bad name" })], log }), /invalid tool name/);
	assert.throws(() => createMcp({ serverInfo: info, tools: [tool({ inputSchema: { type: "string" } })], log }), /invalid tool definition/);
	assert.throws(() => createMcp({ serverInfo: info, tools: [tool({ handler: /** @type {any} */ (null) })], log }), /invalid tool definition/);
	const { post } = setup({ tools: [tool({ name: "b" }), tool({ name: "a" }), tool({ name: "c.d-e_1" })] });
	const r = await post({}, { jsonrpc: "2.0", id: 1, method: "tools/list" });
	assert.deepEqual(res(r).result.tools.map((/** @type {{ name: string }} */ t) => t.name), ["b", "a", "c.d-e_1"]);
});

test("a tool added to the registry array before createMcp is served (browser_search extension point)", async () => {
	const tools = [tool({ name: "one" })];
	tools.push(tool({ name: "two" }));
	const { post } = setup({ tools });
	const r = await post({}, { jsonrpc: "2.0", id: 1, method: "tools/list" });
	assert.equal(res(r).result.tools.length, 2);
});

test("handle never throws: a hostile header bag or getter becomes a 500 -32603 without detail", async () => {
	const { mcp, log } = setup();
	const bomb = /** @type {Record<string, string>} */ ({});
	Object.defineProperty(bomb, "accept", {
		enumerable: true,
		get() {
			throw new Error("boom at /secret/path");
		},
	});
	const r = await mcp.handle({ method: "POST", headers: bomb, body: {} });
	assert.equal(r.status, 500);
	assert.equal(err(r).error.code, RPC.INTERNAL_ERROR);
	assert.ok(!JSON.stringify(r.body).includes("secret"));
	assert.deepEqual(log.events, ["mcp.internal_error"]);
});
