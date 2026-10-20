// "bgw mcp": the gateway's MCP tools over stdin/stdout, with the proof step in
// front of every connection to the daemon. Driven the way a client drives it:
// a child process, one JSON-RPC message per line.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startTestDaemon, until } from "../helpers/daemon.js";
import { FakeExtension, makeResult } from "../helpers/fake-extension.js";
import { startMcp } from "../helpers/mcp-stdio.js";
import { closedPort, rawSquatter, squatter } from "../helpers/squatter.js";
import { buildTools } from "../../daemon/src/mcptools.js";
import { LEGACY_VERSIONS, MCP_LIMITS, MODERN_VERSIONS, SUPPORTED_VERSIONS } from "../../daemon/src/mcp.js";
import { LIMITS } from "../../daemon/src/config.js";
import { FETCH_LIMITS } from "../../daemon/src/fetchsvc.js";
import { makeEngines } from "../../daemon/src/search.js";

const CLI = fileURLToPath(new URL("../../cli/bgw", import.meta.url));
const PYTHON = process.env.PYTHON || "python3";
const SOURCE = fs.readFileSync(CLI, "utf8");
/** Windows sends no SIGTERM or SIGINT to another process: child.kill() ends it at once there. */
const SIGNALS = process.platform === "win32" ? "no signals between processes on Windows" : false;
/** The POSIX registration and a symlink to the script; the Windows one is tried in cli-windows.test.js. */
const POSIX_ONLY = process.platform === "win32" ? "the POSIX registration and a symlink; cli-windows.test.js covers Windows" : false;
/** The version `bgw mcp` reports: the one of the checkout it sits in. */
const CLI_VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const MODERN = "2026-07-28";
/** What a request of the style without a handshake carries. */
const META = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} };
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1" } };

/** @type {Awaited<ReturnType<typeof startTestDaemon>>} */
let daemon;
/** @type {{ tokenFile: string, adminFile: string }} */
let files;
/** @type {Record<string, string>} */
let env;

before(async () => {
	daemon = await startTestDaemon();
	files = { tokenFile: path.join(daemon.configDir, "client.token"), adminFile: path.join(daemon.configDir, "admin.token") };
	env = { BGW_URL: `http://127.0.0.1:${daemon.port}`, BGW_TOKEN_FILE: files.tokenFile, BGW_ADMIN_TOKEN_FILE: files.adminFile };
});
after(async () => {
	await daemon.stop();
});

async function pairedExtension() {
	const ext = new FakeExtension({ port: daemon.port });
	const r = await ext.pair(await daemon.pairCode());
	assert.equal(r.ready, true);
	return ext;
}

/** @param {FakeExtension} ext */
async function unplug(ext) {
	await ext.kill();
	await until(async () => (await daemon.status()).extension.connected === false);
}

/** @param {any} answer @returns {string} the text of a tool result */
const textOf = (answer) => answer.result.content[0].text;

/** @param {ReturnType<typeof startMcp>} mcp nothing but protocol messages on stdout, and no token anywhere */
function assertClean(mcp) {
	assert.deepEqual(mcp.junk, [], "only JSON-RPC lines on stdout");
	for (const line of mcp.stdout().split("\n").filter((l) => l !== "")) assert.equal(JSON.parse(line).jsonrpc, "2.0");
	for (const out of [mcp.stdout(), mcp.stderr()]) {
		assert.ok(!out.includes(daemon.token) && !out.includes(daemon.adminToken), "no token in what it prints");
		assert.ok(!out.includes("Traceback"), out);
	}
}

test("handshake style: initialize, tools/list, browser_fetch through the extension, page_read, gateway_status", async () => {
	const ext = await pairedExtension();
	const mcp = startMcp(env);
	try {
		const init = await mcp.request("initialize", INIT);
		assert.deepEqual(init.result.protocolVersion, "2025-06-18");
		assert.deepEqual(init.result.capabilities, { tools: {} });
		assert.deepEqual(init.result.serverInfo, { name: "browser-gateway", version: CLI_VERSION, title: "Browser Gateway" });
		// A notification gets no reply, here as anywhere.
		mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });

		const list = await mcp.request("tools/list");
		assert.deepEqual(list.result.tools.map((/** @type {any} */ t) => t.name), ["browser_fetch", "browser_search", "page_read", "page_search", "gateway_status", "file_export"]);
		assert.equal(list.result.resultType, undefined, "the handshake style has no modern fields");

		const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} about okapis and \u00E4\u00F6\u00FC \u65E5\u672C \u{1f600}.`).join("\n\n");
		ext.onJob = (start) => makeResult(start, { content: { markdown: body, text: null, html: null, raw_html: null, links: [], results: [] } });
		const fetched = await mcp.request("tools/call", { name: "browser_fetch", arguments: { url: "https://example.com/okapis", max_chars: 400 } });
		assert.equal(fetched.result.isError, false, JSON.stringify(fetched));
		const text = textOf(fetched);
		assert.match(text, /^\[browser-gateway\] outcome=ok page=pg_[0-9A-Z]{26} scope=container status=200 visibility=visible$/m);
		assert.ok(text.includes("Paragraph 0 about okapis and \u00E4\u00F6\u00FC \u65E5\u672C \u{1f600}."), "UTF-8 arrives whole");
		assert.match(text, /BEGIN_UNTRUSTED_WEB_CONTENT [0-9a-f]{8}>>>/);
		assert.equal(ext.jobs.length, 1);
		assert.equal(ext.jobs[0].url, "https://example.com/okapis");

		const page = /page=(pg_[0-9A-Z]{26})/.exec(text)?.[1];
		const next = Number(/next: page_read\(page="pg_[0-9A-Z]{26}", offset=(\d+)\)/.exec(text)?.[1]);
		assert.ok(page && next > 0);
		const read = await mcp.request("tools/call", { name: "page_read", arguments: { page, offset: next, max_chars: 300 } });
		assert.equal(read.result.isError, false);
		assert.match(textOf(read), new RegExp(`^chars: ${next}-\\d+ of ${body.length}`, "m"));
		assert.equal(ext.jobs.length, 1, "read from the store");

		const status = await mcp.request("tools/call", { name: "gateway_status", arguments: {} });
		assert.equal(status.result.isError, false);
		assert.match(textOf(status), /^paired: true$/m);
		assert.match(textOf(status), /^extension_connected: true$/m);

		// What the daemon refuses, it refuses in its own words; and what it does not know, it says.
		const unknownTool = await mcp.request("tools/call", { name: "no_such_tool", arguments: {} });
		assert.deepEqual(unknownTool.error, { code: -32602, message: "Unknown tool: no_such_tool" });
		const unknownMethod = await mcp.request("resources/list");
		assert.deepEqual(unknownMethod.error, { code: -32601, message: "Method not found: resources/list" });
		assert.deepEqual((await mcp.request("ping")).result, {});
		// Ids are passed back as they came: strings too.
		assert.equal((await mcp.request("ping", undefined, { id: "abc-1" })).id, "abc-1");

		// Exactly one answer per request, and nothing for the notification.
		assert.equal(mcp.messages.length, 9);
		assert.match(mcp.stderr(), /^bgw mcp: connected to the gateway daemon on 127\.0\.0\.1:\d+ \(it proved that it holds the token\)\n$/);
		assertClean(mcp);
	} finally {
		await mcp.stop();
		await unplug(ext);
	}
	assert.deepEqual(await mcp.exited, { code: 0, signal: null });
});

test("the style without a handshake (2026-07-28): discover, list and call, with the headers the daemon wants made from the body", async () => {
	const ext = await pairedExtension();
	const mcp = startMcp(env);
	try {
		const discover = await mcp.request("server/discover", { _meta: META });
		assert.deepEqual(discover.result.supportedVersions, [...SUPPORTED_VERSIONS]);
		assert.equal(discover.result.resultType, "complete");

		const list = await mcp.request("tools/list", { _meta: META });
		assert.equal(list.result.tools.length, 6);
		// What a client may run where nothing is to change (Claude Code's plan mode): every tool but file_export.
		assert.deepEqual(
			Object.fromEntries(list.result.tools.map((/** @type {any} */ t) => [t.name, t.annotations?.readOnlyHint])),
			{ browser_fetch: true, browser_search: true, page_read: true, page_search: true, gateway_status: true, file_export: false },
		);
		assert.deepEqual([list.result.resultType, list.result.ttlMs, list.result.cacheScope], ["complete", MCP_LIMITS.toolsTtlMs, "public"]);
		assert.deepEqual(list.result._meta, { "io.modelcontextprotocol/serverInfo": { name: "browser-gateway", version: CLI_VERSION, title: "Browser Gateway" } });

		ext.onJob = (start) => makeResult(start, { content: { markdown: "# Modern\n\nfetched without a handshake", text: null, html: null, raw_html: null, links: [], results: [] } });
		const fetched = await mcp.request("tools/call", { name: "browser_fetch", arguments: { url: "https://example.com/modern" }, _meta: META });
		assert.equal(fetched.result.isError, false, JSON.stringify(fetched));
		assert.equal(fetched.result.resultType, "complete");
		assert.ok(textOf(fetched).includes("fetched without a handshake"));

		const status = await mcp.request("tools/call", { name: "gateway_status", arguments: {}, _meta: META });
		assert.match(textOf(status), /^extension_connected: true$/m);

		// The daemon's own checks of this style still answer: a version it does not speak, a missing capability object.
		const old = await mcp.request("tools/list", { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2031-01-01" } });
		assert.equal(old.error.code, -32022);
		const bare = await mcp.request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } });
		assert.equal(bare.error.code, -32602);
		// ping is gone in this style.
		assert.equal((await mcp.request("ping", { _meta: META })).error.code, -32601);
		// A version that could not be a header value is not passed on at all.
		const odd = await mcp.request("tools/list", { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2026-07-28\r\nX-Evil: 1" } });
		assert.equal(odd.error.code, -32600);
		// A tool name that is no plain header value travels in the Base64 form, and the daemon reads it as the same name.
		const named = await mcp.request("tools/call", { name: "gateway status \u00E4", arguments: {}, _meta: META });
		assert.deepEqual(named.error, { code: -32602, message: "Unknown tool: gateway status \u00E4" });
		assertClean(mcp);
	} finally {
		await mcp.stop();
		await unplug(ext);
	}
});

test("no daemon: the handshake and the tool list are answered here, a call says what is wrong, and the next call tries again", async () => {
	const port = await closedPort();
	const mcp = startMcp({ ...env, BGW_URL: `http://127.0.0.1:${port}` });
	/** @type {Awaited<ReturnType<typeof startTestDaemon>> | null} */
	let late = null;
	try {
		const init = await mcp.request("initialize", INIT);
		assert.equal(init.result.protocolVersion, "2025-06-18");
		assert.equal(init.result.serverInfo.name, "browser-gateway");
		const list = await mcp.request("tools/list");
		assert.equal(list.result.tools.length, 6);
		assert.deepEqual((await mcp.request("ping")).result, {});

		for (const [name, args] of /** @type {const} */ ([
			["browser_fetch", { url: "https://example.com/" }],
			["gateway_status", {}],
			["page_read", { page: "pg_" + "0".repeat(26) }],
		])) {
			const r = await mcp.request("tools/call", { name, arguments: args });
			assert.deepEqual(r.result, {
				content: [{ type: "text", text: `Browser Gateway: the gateway daemon is not running on 127.0.0.1:${port} (start it with: bgw daemon start). Nothing was fetched. Tell the user; do not retry in a loop.` }],
				isError: true,
			});
		}
		// Anything else that only the daemon could answer is an error, not silence.
		assert.equal((await mcp.request("resources/list")).error.code, -32603);
		// The modern style gets its own shape back.
		const modern = await mcp.request("tools/call", { name: "gateway_status", arguments: {}, _meta: META });
		assert.deepEqual([modern.result.isError, modern.result.resultType], [true, "complete"]);
		assert.equal((await mcp.request("ping", { _meta: META })).error.code, -32603);
		// Said once on stderr, not with every call.
		assert.equal(mcp.stderr(), `bgw mcp: the gateway daemon is not running on 127.0.0.1:${port} (start it with: bgw daemon start)\n`);

		// A daemon comes up on that port, but not the one whose token this helper was given.
		late = await startTestDaemon({ port });
		const still = await mcp.request("tools/call", { name: "gateway_status", arguments: {} });
		// It holds another token than the one this helper was given: proven wrong, so nothing is sent to it either.
		assert.equal(still.result.isError, true);
		assert.match(textOf(still), new RegExp(`^Browser Gateway: the process on 127\\.0\\.0\\.1:${port} is not the gateway daemon - no token and no request was sent to it\\.`));
		assert.equal(late.logs.filter((l) => l.includes('"http.refused"')).length, 0, "the daemon with the other token never saw this one");
	} finally {
		await mcp.stop();
		if (late !== null) await late.stop();
	}
	assertClean(mcp);
});

test("a daemon that appears after the helper started is used from the next call on, and one that goes away is said to be gone", async () => {
	const port = await closedPort();
	const configDir = path.join(daemon.dir, "late-config");
	const tokenFile = path.join(configDir, "client.token");
	const mcp = startMcp({ BGW_URL: `http://127.0.0.1:${port}`, BGW_TOKEN_FILE: tokenFile, BGW_ADMIN_TOKEN_FILE: path.join(configDir, "admin.token") });
	/** @type {Awaited<ReturnType<typeof startTestDaemon>> | null} */
	let late = null;
	try {
		await mcp.request("initialize", INIT);
		const down = await mcp.request("tools/call", { name: "gateway_status", arguments: {} });
		assert.match(textOf(down), /the gateway daemon is not running/);

		late = await startTestDaemon({ port, configDir });
		const up = await mcp.request("tools/call", { name: "gateway_status", arguments: {} });
		assert.equal(up.result.isError, false, JSON.stringify(up));
		assert.match(textOf(up), /^extension_connected: false$/m);
		// The browser is not there: the daemon's own sentence for it.
		const fetched = await mcp.request("tools/call", { name: "browser_fetch", arguments: { url: "https://example.com/" } });
		assert.equal(fetched.result.isError, true);
		assert.ok(textOf(fetched).includes("The browser extension is not connected; the browser may be closed."), textOf(fetched));
		// The tool list is the daemon's now, and it is what this run falls back to later.
		assert.equal((await mcp.request("tools/list")).result.tools.length, 6);

		await late.close();
		const gone = await mcp.request("tools/call", { name: "gateway_status", arguments: {} });
		assert.match(textOf(gone), /the gateway daemon is not running/);
		assert.equal((await mcp.request("tools/list")).result.tools.length, 6);
		const lines = mcp.stderr().trimEnd().split("\n");
		assert.equal(lines.length, 3, mcp.stderr());
		assert.match(lines[0], /not running/);
		assert.match(lines[1], /connected to the gateway daemon/);
		assert.match(lines[2], /not running/);
		assert.ok(!mcp.stdout().includes(late.token) && !mcp.stderr().includes(late.token));
	} finally {
		await mcp.stop();
		if (late !== null) await late.stop();
	}
});

test("a squatter on the port gets no token from bgw mcp, whatever it answers", async () => {
	const token = daemon.token;
	const admin = daemon.adminToken;
	/** @param {string} key @param {string} text */
	const hmac = (key, text) => crypto.createHmac("sha256", key).update(text).digest("base64url");
	/** @type {[string, Parameters<typeof squatter>[0]][]} */
	const squatters = [
		["answers everything with ok", () => ({ json: { ok: true } })],
		["answers with a made-up MAC", () => ({ json: { ok: true, mac: "A".repeat(43) } })],
		["echoes the nonce", ({ body }) => ({ json: { ok: true, mac: body?.nonce } })],
		["a MAC under a key of its own", ({ body, port }) => ({ json: { ok: true, mac: hmac("squatter", `bgw1|prove|${body?.role}|${port}|${body?.nonce}`) } })],
		["the right MAC for the other role", ({ body, port }) => ({ json: { ok: true, mac: hmac(admin, `bgw1|prove|${body?.role}|${port}|${body?.nonce}`) } })],
		["the right key over the daemon's own port", ({ body }) => ({ json: { ok: true, mac: hmac(token, `bgw1|prove|${body?.role}|${daemon.port}|${body?.nonce}`) } })],
		["answers like an MCP server", ({ body }) => ({ json: { jsonrpc: "2.0", id: body?.id ?? 1, result: { tools: [{ name: "evil", inputSchema: { type: "object" } }], content: [{ type: "text", text: "squatted" }], isError: false } } })],
		["demands the token", () => ({ status: 401, json: { ok: false, error: "unauthorized" }, headers: { "www-authenticate": "Bearer" } })],
		["redirects elsewhere", () => ({ status: 302, headers: { location: `http://127.0.0.1:${daemon.port}/mcp` } })],
		["answers with no JSON", () => ({ raw: "<html>hello</html>" })],
	];
	for (const [label, answer] of squatters) {
		const s = await squatter(answer, files);
		const mcp = startMcp(s.env);
		try {
			const init = await mcp.request("initialize", INIT);
			assert.equal(init.result.serverInfo.name, "browser-gateway", label);
			const list = await mcp.request("tools/list");
			// The list it hands out is its own copy: nothing a squatter says ends up in it.
			assert.deepEqual(list.result.tools.map((/** @type {any} */ t) => t.name), ["browser_fetch", "browser_search", "page_read", "page_search", "gateway_status", "file_export"], label);
			for (const params of [{ name: "browser_fetch", arguments: { url: "https://example.com/secret-path" } }, { name: "gateway_status", arguments: {}, _meta: META }]) {
				const r = await mcp.request("tools/call", params);
				assert.equal(r.result.isError, true, label);
				assert.equal(textOf(r), `Browser Gateway: the process on 127.0.0.1:${s.port} is not the gateway daemon - no token and no request was sent to it. Nothing was fetched. Tell the user; do not retry in a loop.`, label);
			}
			assert.equal(mcp.stderr(), `bgw mcp: the process on 127.0.0.1:${s.port} is not the gateway daemon - no token and no request was sent to it\n`, label);
			// What reached the squatter: one proof request per message, each on a connection of its own, and nothing else.
			assert.equal(s.requests.length, 4, label);
			assert.equal(s.connections(), 4, label);
			for (const req of s.requests) {
				assert.deepEqual([req.method, req.url, req.headers.authorization], ["POST", "/v1/prove", undefined], label);
				assert.deepEqual(Object.keys(JSON.parse(req.body)).sort(), ["nonce", "role"], label);
				assert.equal(JSON.parse(req.body).role, "client", label);
			}
			assert.equal(new Set(s.requests.map((q) => JSON.parse(q.body).nonce)).size, 4, "a fresh nonce every time");
			assert.ok(!s.seen().includes(token) && !s.seen().includes(admin), `${label}: a token reached the squatter`);
			assert.ok(!s.seen().toLowerCase().includes("bearer"), label);
			// Neither the URL that was asked for nor the tool call itself got there.
			assert.ok(!s.seen().includes("secret-path") && !s.seen().includes("tools/call") && !s.seen().includes("/mcp"), label);
			assertClean(mcp);
		} finally {
			await mcp.stop();
			await s.stop();
		}
	}
});

test("a listener that never answers does not hold the handshake: the tool list comes from here within seconds", async () => {
	const s = await rawSquatter(() => {}, files);
	const mcp = startMcp(s.env);
	try {
		const started = Date.now();
		const [init, list] = await Promise.all([mcp.request("initialize", INIT), mcp.request("tools/list")]);
		const took = Date.now() - started;
		assert.equal(init.result.protocolVersion, "2025-06-18");
		assert.equal(list.result.tools.length, 6);
		assert.ok(took >= 2500 && took < 6000, `took ${took} ms`);
		assert.match(mcp.stderr(), /^bgw mcp: the gateway daemon on 127\.0\.0\.1:\d+ did not answer in time\n$/);
		assert.ok(!s.seen().includes(daemon.token) && !s.seen().toLowerCase().includes("bearer"));
	} finally {
		await mcp.stop();
		await s.stop();
	}
});

test("no token file: said in the call's result, nothing sent; the handshake works all the same", async () => {
	const mcp = startMcp({ ...env, BGW_TOKEN_FILE: path.join(daemon.dir, "no-such.token") });
	const refused = daemon.logs.filter((l) => l.includes('"http.refused"')).length;
	try {
		assert.equal((await mcp.request("initialize", INIT)).result.protocolVersion, "2025-06-18");
		assert.equal((await mcp.request("tools/list")).result.tools.length, 6);
		const r = await mcp.request("tools/call", { name: "gateway_status", arguments: {} });
		assert.equal(r.result.isError, true);
		assert.match(textOf(r), /^Browser Gateway: token file not found: .*no-such\.token \(start the daemon once to create it\) - nothing was sent\./);
		assert.equal(daemon.logs.filter((l) => l.includes('"http.refused"')).length, refused);
	} finally {
		await mcp.stop();
	}
});

test("the built-in tool list, the handshake answer and the versions are the daemon's own (sync test)", async () => {
	// The tools as the daemon registers them with its default search engine.
	const engines = makeEngines();
	const expected = buildTools({ fetchsvc: /** @type {any} */ ({ engines: { names: [...engines.names], fallback: engines.fallback } }), status: () => ({}) }).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }));
	const withDaemon = startMcp(env);
	const without = startMcp({ ...env, BGW_URL: `http://127.0.0.1:${await closedPort()}` });
	try {
		for (const [method, params] of /** @type {[string, any][]} */ ([
			["initialize", INIT],
			["initialize", { protocolVersion: "1999-01-01" }],
			["initialize", { protocolVersion: "2024-11-05" }],
			["initialize", {}],
			["tools/list", undefined],
			["tools/list", { _meta: META }],
			["server/discover", { _meta: META }],
			["ping", undefined],
		])) {
			const a = await withDaemon.request(method, params, { id: 77 });
			const b = await without.request(method, params, { id: 77 });
			assert.deepEqual(b, a, `${method} ${JSON.stringify(params)}: answered here as the daemon answers it`);
		}
		const list = await without.request("tools/list");
		// The daemon's five, and behind them the one tool this helper answers itself.
		assert.deepEqual(list.result.tools.slice(0, 5), JSON.parse(JSON.stringify(expected)));
		assert.deepEqual(list.result.tools.slice(5).map((/** @type {any} */ t) => t.name), ["file_export"]);
		assert.equal(expected.some((t) => t.name === "file_export"), false, "the daemon has no such tool: it would have to write where an agent says");
	} finally {
		await withDaemon.stop();
		await without.stop();
	}
	// And the constants the helper carries are the daemon's.
	/** @param {string} name */
	const tuple = (name) => JSON.parse(`[${new RegExp(`^${name} = \\(([^)]*)\\)$`, "m").exec(SOURCE)?.[1].replace(/,\s*$/, "")}]`);
	assert.deepEqual(tuple("MCP_LEGACY_VERSIONS"), [...LEGACY_VERSIONS]);
	assert.deepEqual(tuple("MCP_MODERN_VERSIONS"), [...MODERN_VERSIONS]);
	/** @param {string} name */
	const number = (name) => Number(new RegExp(`^${name} = ([0-9]+)$`, "m").exec(SOURCE)?.[1]);
	assert.equal(number("MCP_TOOLS_TTL_MS"), MCP_LIMITS.toolsTtlMs);
	assert.equal(number("MCP_MAX_LINE_BYTES"), LIMITS.maxBodyBytes);
	// How long a call may take: the daemon's queue time, run time and caller hold.
	assert.equal(number("DAEMON_QUEUE_S") * 1000, LIMITS.maxQueueMs);
	assert.equal(number("DAEMON_RUN_S") * 1000, LIMITS.maxRunMs);
	assert.equal(number("DAEMON_HOLD_S"), FETCH_LIMITS.maxWaitForHumanS);
	assert.match(SOURCE, /^JOB_TIMEOUT_S = float\(DAEMON_QUEUE_S \+ DAEMON_RUN_S \+ DAEMON_HOLD_S \+ 15\)$/m);
	// A tool call gets that long; everything else is quick.
	assert.match(SOURCE, /timeout = MCP_HANDSHAKE_TIMEOUT_S if handshake else QUICK_TIMEOUT_S if quick else JOB_TIMEOUT_S/);
});

test("malformed and oversized input: each line gets its error or its silence, and the helper goes on", async () => {
	const mcp = startMcp(env);
	try {
		/** @param {string | Buffer} line @returns {Promise<any>} the next message after sending it */
		const after = async (line) => {
			const from = mcp.messages.length;
			mcp.writeRaw(line);
			mcp.writeRaw("\n");
			return mcp.waitFor((m) => mcp.messages.indexOf(m) >= from, 5000);
		};
		assert.deepEqual(await after("this is not JSON"), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		assert.deepEqual(await after('{"jsonrpc":"2.0","id":1,"method":'), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		assert.deepEqual(await after(Buffer.from([0x7b, 0xff, 0xfe, 0xc3, 0x28, 0x7d])), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		assert.equal((await after("[".repeat(100000))).error.code, -32700, "nesting without end is a parse error, not a crash");
		assert.deepEqual(await after('[{"jsonrpc":"2.0","id":1,"method":"ping"}]'), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch requests are not supported" } });
		assert.deepEqual(await after('"text"'), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
		assert.deepEqual(await after('{"jsonrpc":"1.0","id":5,"method":"ping"}'), { jsonrpc: "2.0", id: 5, error: { code: -32600, message: 'Invalid request: jsonrpc must be "2.0"' } });
		assert.deepEqual(await after('{"jsonrpc":"2.0","id":6,"method":7}'), { jsonrpc: "2.0", id: 6, error: { code: -32600, message: "Invalid request: method must be a string" } });
		for (const id of ["null", "1.5", "true", "{}", "9007199254740993"]) {
			assert.deepEqual(await after(`{"jsonrpc":"2.0","id":${id},"method":"ping"}`), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request: id must be a string or an integer" } }, id);
		}
		// A line with a carriage return, as some clients end theirs.
		assert.deepEqual(await after('{"jsonrpc":"2.0","id":8,"method":"ping"}\r'), { jsonrpc: "2.0", id: 8, result: {} });

		// Silence: empty lines, notifications of any kind, answers to questions never asked.
		const count = mcp.messages.length;
		mcp.writeRaw("\n   \n\r\n");
		mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		mcp.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 12345, reason: "nothing to cancel" } });
		mcp.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: "odd" });
		mcp.send({ jsonrpc: "2.0", method: "some/notification", params: { x: 1 } });
		mcp.send({ jsonrpc: "2.0", id: 3, result: {} });
		mcp.send({ jsonrpc: "2.0", id: 3, error: { code: 1, message: "x" } });
		assert.deepEqual((await mcp.request("ping")).result, {});
		assert.equal(mcp.messages.length, count + 1);

		// A line larger than any message the daemon takes: refused once, skipped to its end, nothing kept.
		const big = mcp.messages.length;
		mcp.writeRaw(`{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"browser_fetch","arguments":{"url":"https://example.com/${"a".repeat(3 * 1048576)}`);
		mcp.writeRaw('"}}}\n');
		const tooBig = await mcp.waitFor((m) => mcp.messages.indexOf(m) >= big, 10000);
		assert.deepEqual(tooBig, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request: a message is larger than 1048576 bytes" } });
		assert.deepEqual((await mcp.request("ping")).result, {});
		assert.equal(mcp.messages.length, big + 2, "one error for the whole line");
		// A line just under the limit goes to the daemon, which refuses its arguments in its own words.
		const fits = await mcp.request("tools/call", { name: "browser_fetch", arguments: { url: "https://example.com/" + "a".repeat(900000) } });
		assert.equal(fits.result.isError, true);
		assert.match(textOf(fits), /url must be a string of 1 to 8192 characters/);
		assertClean(mcp);
	} finally {
		await mcp.stop();
	}
	assert.deepEqual(await mcp.exited, { code: 0, signal: null });
});

test("stdin EOF: a last message without a line end is answered, then the helper leaves with exit code 0", async () => {
	const mcp = startMcp(env);
	mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
	mcp.writeRaw('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"gateway_status","arguments":{}}}');
	const started = Date.now();
	mcp.end();
	assert.deepEqual(await mcp.exited, { code: 0, signal: null });
	assert.ok(Date.now() - started < 3000, `left ${Date.now() - started} ms after EOF`);
	assert.deepEqual(mcp.messages.map((m) => m.id).sort(), [1, 2]);
	assert.equal(mcp.messages.find((m) => m.id === 2).result.isError, false);
	assertClean(mcp);
});

test("stdin EOF and SIGTERM with a call under way: the helper leaves at once, and the daemon cancels the job nobody waits for", { skip: SIGNALS }, async () => {
	const ext = await pairedExtension();
	try {
		for (const how of /** @type {const} */ (["eof", "SIGTERM", "SIGINT"])) {
			ext.onJob = () => null;
			const mcp = startMcp(env);
			const jobs = ext.jobs.length;
			mcp.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_fetch", arguments: { url: `https://example.com/never-${how}`, fresh: true } } });
			await until(() => ext.jobs.length === jobs + 1, { what: "the job to reach the extension" });
			const started = Date.now();
			if (how === "eof") mcp.end();
			else mcp.signal(how);
			assert.deepEqual(await mcp.exited, { code: 0, signal: null }, how);
			const took = Date.now() - started;
			// EOF gives a call that is nearly done a second; a signal gives it nothing.
			assert.ok(how === "eof" ? took >= 900 && took < 3000 : took < 1500, `${how}: left after ${took} ms`);
			assert.deepEqual(mcp.messages, [], `${how}: no answer to a call that was given up`);
			const cancel = await ext.waitFor("job.cancel", { match: (f) => f.job === ext.jobs[jobs].job });
			assert.equal(cancel.reason, "client_gone", how);
			ext.sendResult(makeResult(ext.jobs[jobs]));
			assertClean(mcp);
		}
	} finally {
		await unplug(ext);
	}
});

test("the Windows way of waiting for stdin (a reader thread and a queue; select() and the wake-up pipe made to fail), on any system: the same answers, framing, limits, EOF and signals", async () => {
	const mcp = startMcp(env, { threaded: true });
	try {
		const init = await mcp.request("initialize", INIT);
		assert.equal(init.result.protocolVersion, "2025-06-18");
		assert.equal((await mcp.request("tools/list")).result.tools.length, 6);
		// A call through the daemon, after its proof.
		const status = await mcp.request("tools/call", { name: "gateway_status", arguments: {} });
		assert.equal(status.result.isError, false);
		/** @param {string} line @returns {Promise<any>} the next message after sending it */
		const after = async (line) => {
			const from = mcp.messages.length;
			mcp.writeRaw(line);
			return mcp.waitFor((m) => mcp.messages.indexOf(m) >= from, 5000);
		};
		assert.deepEqual(await after('{"jsonrpc":"2.0","id":8,"method":"ping"}\r\n'), { jsonrpc: "2.0", id: 8, result: {} });
		assert.deepEqual(await after("not JSON\n"), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		// One message in two writes, and two messages in one.
		// Two answers in one go may come in either order: JSON-RPC promises none.
		mcp.writeRaw('{"jsonrpc":"2.0","id":9,');
		mcp.writeRaw('"method":"ping"}\n{"jsonrpc":"2.0","id":10,"method":"ping"}\n');
		assert.deepEqual(await mcp.waitFor((m) => m.id === 9, 5000), { jsonrpc: "2.0", id: 9, result: {} });
		assert.deepEqual(await mcp.waitFor((m) => m.id === 10, 5000), { jsonrpc: "2.0", id: 10, result: {} });
		// Larger than any message: refused once, skipped to its end.
		const big = mcp.messages.length;
		mcp.writeRaw(`{"jsonrpc":"2.0","id":11,"method":"ping","params":{"x":"${"a".repeat(3 * 1048576)}`);
		mcp.writeRaw('"}}\n');
		assert.deepEqual(await mcp.waitFor((m) => mcp.messages.indexOf(m) >= big, 10000), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request: a message is larger than 1048576 bytes" } });
		assert.deepEqual((await mcp.request("ping")).result, {});
		assert.equal(mcp.messages.length, big + 2, "one error for the whole line");
		// The end of stdin, with a last message that has no line end.
		mcp.writeRaw('{"jsonrpc":"2.0","id":12,"method":"ping"}');
		const started = Date.now();
		mcp.end();
		assert.deepEqual(await mcp.exited, { code: 0, signal: null });
		assert.ok(Date.now() - started < 3000, `left ${Date.now() - started} ms after EOF`);
		assert.deepEqual(mcp.messages.at(-1), { jsonrpc: "2.0", id: 12, result: {} });
		assertClean(mcp);
	} finally {
		await mcp.stop();
	}
	if (process.platform === "win32") return;
	// A signal only sets the flag there: it is seen within the second the wait on the queue lasts.
	for (const how of /** @type {const} */ (["SIGTERM", "SIGINT"])) {
		const signalled = startMcp(env, { threaded: true });
		assert.deepEqual((await signalled.request("ping")).result, {});
		const started = Date.now();
		signalled.signal(how);
		assert.deepEqual(await signalled.exited, { code: 0, signal: null }, how);
		assert.ok(Date.now() - started < 2500, `${how}: left after ${Date.now() - started} ms`);
		assertClean(signalled);
	}
});

test("a client that stops reading does not hold the helper: it still leaves on SIGTERM, and gives up by itself when answers pile up", { skip: SIGNALS }, async () => {
	const port = await closedPort();
	/** Start the helper with nobody reading its stdout, and send it "count" requests that it answers by itself. @param {number} count */
	const stalled = (count) => {
		const child = spawn(PYTHON, [CLI, "mcp"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", ...env, BGW_URL: `http://127.0.0.1:${port}` }, stdio: ["pipe", "pipe", "pipe"] });
		// Never read: the pipe fills up and the helper's writes stop going through.
		child.stdout.pause();
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
		/** @type {Promise<{ code: number | null, signal: NodeJS.Signals | null }>} */
		const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
		child.stdin.on("error", () => {});
		for (let i = 1; i <= count; i++) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list" }) + "\n");
		return { child, exited, stderr: () => stderr };
	};
	// About 5 kB an answer: a hundred of them are more than the pipe takes, and fewer than the helper lets wait.
	const a = stalled(100);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.equal(a.child.exitCode, null, "it waits for its client");
	const started = Date.now();
	a.child.kill("SIGTERM");
	assert.deepEqual(await a.exited, { code: 0, signal: null });
	assert.ok(Date.now() - started < 2500, `left ${Date.now() - started} ms after the signal`);
	assert.ok(!a.stderr().includes("Traceback"), a.stderr());
	// And without a signal: answers that nobody takes are not kept without bound.
	const b = stalled(2000);
	const timer = setTimeout(() => b.child.kill("SIGKILL"), 15000);
	assert.deepEqual(await b.exited, { code: 0, signal: null });
	clearTimeout(timer);
	assert.ok(!b.stderr().includes("Traceback"), b.stderr());
});

test("calls run side by side, and notifications/cancelled ends the one it names without an answer", async () => {
	const ext = await pairedExtension();
	const mcp = startMcp(env);
	try {
		ext.onJob = () => null;
		const slowId = mcp.newId();
		mcp.send({ jsonrpc: "2.0", id: slowId, method: "tools/call", params: { name: "browser_fetch", arguments: { url: "https://example.com/slow-one", fresh: true } } });
		await until(() => ext.jobs.length === 1, { what: "the job to reach the extension" });
		// While that one waits for the browser, others are answered.
		const status = await mcp.request("tools/call", { name: "gateway_status", arguments: {} });
		assert.match(textOf(status), /^queue\.dispatched: 1$/m);
		assert.equal((await mcp.request("tools/list")).result.tools.length, 6);

		mcp.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: slowId, reason: "the user interrupted" } });
		const cancel = await ext.waitFor("job.cancel", { match: (f) => f.job === ext.jobs[0].job });
		assert.equal(cancel.reason, "client_gone");
		ext.sendResult(makeResult(ext.jobs[0]));
		// The helper is still there, and the cancelled call got no answer.
		assert.deepEqual((await mcp.request("ping")).result, {});
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(mcp.messages.some((m) => m.id === slowId), false);

		// More calls at once than it lets through: the rest is told so at once, nothing queues without bound.
		ext.onJob = () => null;
		const before = ext.jobs.length;
		const ids = Array.from({ length: 10 }, () => mcp.newId());
		for (const [i, id] of ids.entries()) mcp.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_fetch", arguments: { url: `https://example.com/many-${i}`, fresh: true } } });
		const busy = await Promise.all(ids.slice(8).map((id) => mcp.waitFor((m) => m.id === id, 5000)));
		for (const b of busy) assert.equal(textOf(b), "Browser Gateway: too many calls are still running (8). Try again when one has ended.");
		await until(() => ext.jobs.length === before + 1, { what: "the first of them to reach the extension" });
		for (const id of ids.slice(0, 8)) mcp.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
		await until(async () => (await daemon.agentStatus()).queue.queued === 0, { what: "the queue to empty" });
		assert.deepEqual((await mcp.request("ping")).result, {});
		assertClean(mcp);
	} finally {
		await mcp.stop();
		ext.onJob = (start) => makeResult(start);
		await unplug(ext);
	}
});

test("bgw mcp: a BGW_URL that is not the loopback daemon ends it before anything is read or sent", async () => {
	for (const url of ["http://localhost:8791", "https://127.0.0.1:8791", "http://example.com:80", "http://127.0.0.1:8791/x"]) {
		const mcp = startMcp({ ...env, BGW_URL: url });
		mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT });
		assert.deepEqual(await mcp.exited, { code: 1, signal: null }, url);
		assert.equal(mcp.stderr(), "bgw: BGW_URL must look like http://127.0.0.1:<port>\n");
		assert.equal(mcp.stdout(), "");
	}
});

test("bgw mcp-config prints the registration command and the config entry with the real path of the script, and changes nothing", { skip: POSIX_ONLY }, async () => {
	const home = path.join(daemon.dir, "mcp-config-home");
	fs.mkdirSync(home);
	/** @param {string[]} args @returns {Promise<{ code: number, stdout: string, stderr: string }>} */
	const run = (args) =>
		new Promise((resolve) => {
			execFile(PYTHON, [CLI, ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }, timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr }));
		});
	const real = fs.realpathSync(CLI);
	const r = await run(["mcp-config"]);
	assert.equal(r.code, 0, r.stderr);
	assert.equal(r.stderr, "");
	assert.ok(r.stdout.includes(`\n  claude mcp add --scope user browser-gateway -- python3 ${real} mcp\n`), r.stdout);
	assert.ok(r.stdout.includes(`\n  {"type": "stdio", "command": "python3", "args": ["${real}", "mcp"]}\n`), r.stdout);
	const asJson = JSON.parse((await run(["mcp-config", "--json"])).stdout);
	assert.deepEqual(asJson, { name: "browser-gateway", command: `claude mcp add --scope user browser-gateway -- python3 ${real} mcp`, config: { type: "stdio", command: "python3", args: [real, "mcp"] } });
	// It only prints: no file appears anywhere in the home it was given, and it never runs the client.
	assert.deepEqual(fs.readdirSync(home), []);
	assert.ok(!/claude\.json|\.claude\b/.test(SOURCE.replace(/~\/\.claude\.json/g, "")), "the script never touches Claude's configuration");
	// Through a symlink it names the real file, so that a registration survives the link.
	const link = path.join(home, "bgw-link");
	fs.symlinkSync(CLI, link);
	const viaLink = await new Promise((resolve) => execFile(PYTHON, [link, "mcp-config", "--json"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home } }, (_err, stdout) => resolve(stdout)));
	assert.deepEqual(JSON.parse(String(viaLink)).config.args, [real, "mcp"]);
	fs.rmSync(link);
});

// The note "it proved that it holds the token" was written for every reply that was not an
// error of the connection - also for replies that were made here, without any connection at all.
test("bgw mcp says that the daemon proved itself only when it did, in that very call", async () => {
	const PROVED = /it proved that it holds the token/;
	/** Calls that are answered by the helper itself: nothing is connected to, nothing is asked. */
	const answeredHere = async (/** @type {ReturnType<typeof startMcp>} */ mcp) => {
		const bad = await mcp.request("tools/call", { name: "file_export", arguments: { file: "not-a-file-id" } });
		assert.match(textOf(bad), /code=invalid_argument/);
		const none = await mcp.request("tools/call", { name: "file_export", arguments: {} });
		assert.match(textOf(none), /code=invalid_argument/);
		// A request that cannot be put into the headers the daemon wants is refused before anything is dialled.
		const unsendable = await mcp.request("tools/call", { name: "gateway_status", arguments: {}, _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "no such version!" } });
		assert.equal(unsendable.error.code, -32600);
	};

	// Nothing listens on the port at all.
	const down = startMcp({ ...env, BGW_URL: `http://127.0.0.1:${await closedPort()}`, BGW_DOWNLOAD_DIR: path.join(daemon.dir, "never-made") });
	try {
		await answeredHere(down);
		assert.equal(down.stderr(), "", "three answers, no connection: nothing is said about who listens");
		// A relative export directory is refused before the daemon is asked as well.
		const relative = startMcp({ ...env, BGW_URL: env.BGW_URL.replace(/\d+$/, String(await closedPort())), BGW_DOWNLOAD_DIR: "relative" });
		try {
			const r = await relative.request("tools/call", { name: "file_export", arguments: { file: `fl_${"7".repeat(26)}` } });
			assert.match(textOf(r), /code=download_dir_unusable/);
			assert.equal(relative.stderr(), "");
		} finally {
			await relative.stop();
		}
		// A call that does go out says what it found - that nothing is there.
		const status = await down.request("tools/call", { name: "gateway_status", arguments: {} });
		assert.equal(status.result.isError, true);
		assert.match(down.stderr(), /^bgw mcp: the gateway daemon is not running on 127\.0\.0\.1:\d+ \(start it with: bgw daemon start\)\n$/);
		assert.doesNotMatch(down.stderr(), PROVED);
		assertClean(down);
	} finally {
		await down.stop();
	}

	// Something listens that does not hold the token: no reply of any kind makes the helper vouch for it.
	const stranger = await squatter(() => ({ json: { ok: true, mac: "AAAA" } }), files);
	const fooled = startMcp(stranger.env);
	try {
		await answeredHere(fooled);
		assert.equal(fooled.stderr(), "");
		assert.equal(stranger.requests.length, 0, "it was not even asked");
		await fooled.request("tools/call", { name: "gateway_status", arguments: {} });
		await answeredHere(fooled);
		assert.match(fooled.stderr(), /^bgw mcp: the process on 127\.0\.0\.1:\d+ is not the gateway daemon - no token and no request was sent to it\n$/);
		assert.doesNotMatch(fooled.stderr(), PROVED);
		assert.equal(stranger.seen().includes(daemon.token), false);
	} finally {
		await fooled.stop();
		await stranger.stop();
	}

	// The real daemon: said once, after the first call in which it proved itself - not before, and not for the answers made here.
	const real = startMcp(env);
	try {
		await answeredHere(real);
		assert.equal(real.stderr(), "", "nothing was asked of it yet");
		assert.equal((await real.request("tools/call", { name: "gateway_status", arguments: {} })).result.isError, false);
		assert.match(real.stderr(), /^bgw mcp: connected to the gateway daemon on 127\.0\.0\.1:\d+ \(it proved that it holds the token\)\n$/);
		await answeredHere(real);
		assert.equal(real.stderr().split("\n").filter((l) => l !== "").length, 1);
		assertClean(real);
	} finally {
		await real.stop();
	}
});
