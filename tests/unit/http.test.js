import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { startTestDaemon, until } from "../helpers/daemon.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeExtension, makeResult } from "../helpers/fake-extension.js";
import { parsePairingCode } from "../../extension/shared/auth.js";
import { MSG, makeMessage } from "../../extension/shared/protocol.js";
import { JOB_WAIT_MAX, LIMITS, LOAD_TIMEOUT_S } from "../../daemon/src/config.js";
import { FETCH_LIMITS } from "../../daemon/src/fetchsvc.js";

// Windows has no mode bits: what they are is checked where there are.
const MODES = process.platform !== "win32";

/** @type {Awaited<ReturnType<typeof startTestDaemon>>} */
let daemon;

before(async () => {
	daemon = await startTestDaemon();
});
after(async () => {
	await daemon.stop();
});

/**
 * Send bytes exactly as written and collect the whole response. For requests
 * a normal HTTP client refuses to produce.
 * @param {string | Buffer | (string | Buffer)[]} parts written one after another
 * @returns {Promise<{ status: number, head: string, body: string }>}
 */
function raw(parts) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: "127.0.0.1", port: daemon.port });
		/** @type {Buffer[]} */
		const chunks = [];
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("raw request: no response within 3 s"));
		}, 3000);
		socket.on("connect", () => {
			for (const part of Array.isArray(parts) ? parts : [parts]) socket.write(part);
		});
		socket.on("data", (chunk) => chunks.push(chunk));
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(timer);
			const text = Buffer.concat(chunks).toString("utf8");
			const [head, ...rest] = text.split("\r\n\r\n");
			const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
			resolve({ status: m ? Number(m[1]) : 0, head, body: rest.join("\r\n\r\n") });
		});
	});
}

/** @param {string[]} lines request line and headers */
const head = (lines) => lines.join("\r\n") + "\r\n\r\n";
const hostLine = () => `Host: 127.0.0.1:${daemon.port}`;
const authLine = () => `Authorization: Bearer ${daemon.token}`;
const adminLine = () => `Authorization: Bearer ${daemon.adminToken}`;
const ADMIN_ROUTES = ["/v1/pair/start", "/v1/jobs", "/v1/pages/export"];
const AGENT_ROUTES = ["/v1/fetch", "/v1/pages/read", "/v1/pages/search", "/v1/files/export", "/v1/search", "/mcp"];
/** The token a route takes: the admin token for pairing, raw jobs and unrendered page content, the agent token for the rest. @param {string} target */
const authFor = (target) => (ADMIN_ROUTES.includes(target) ? /** @type {const} */ ("admin") : true);
const nonce = () => crypto.randomBytes(32).toString("base64url");
/** @param {string} key @param {string} text */
const hmac = (key, text) => crypto.createHmac("sha256", key).update(text).digest("base64url");
/** @param {string} event */
const logged = (event) => daemon.logs.map((l) => JSON.parse(l)).filter((l) => l.event === event);

test("Host must be exactly 127.0.0.1:<port>, on every route", async () => {
	const routes = /** @type {const} */ ([
		["GET", "/healthz"],
		["GET", "/v1/status"],
		["POST", "/v1/prove"],
		["POST", "/v1/pair/start"],
		["POST", "/v1/jobs"],
		["POST", "/v1/fetch"],
		["POST", "/v1/pages/read"],
		["POST", "/v1/pages/search"],
		["POST", "/v1/pages/export"],
		["POST", "/mcp"],
		["GET", "/mcp"],
		["DELETE", "/mcp"],
		["GET", "/nope"],
	]);
	const hosts = [
		"evil.example",
		`evil.example:${daemon.port}`,
		`localhost:${daemon.port}`,
		"127.0.0.1",
		`127.0.0.1:${daemon.port + 1}`,
		`127.0.0.1:${daemon.port}.`,
		`127.0.0.2:${daemon.port}`,
		`[::1]:${daemon.port}`,
		`0.0.0.0:${daemon.port}`,
		`127.0.0.1:${daemon.port}.evil.example`,
		`2130706433:${daemon.port}`,
	];
	for (const [method, target] of routes) {
		for (const host of hosts) {
			const r = await daemon.request(method, target, { headers: { Host: host }, ...(method === "POST" ? { body: {} } : {}) });
			assert.equal(r.status, 403, `${method} ${target} with Host ${host}`);
			assert.equal(r.json.error, "forbidden");
		}
	}
});

test("missing and repeated Host headers are refused", async () => {
	const noHost = await raw(head(["GET /healthz HTTP/1.0"]));
	assert.equal(noHost.status, 403);
	const twice = await raw(head(["GET /healthz HTTP/1.1", hostLine(), "Host: evil.example", "Connection: close"]));
	assert.ok(twice.status === 400 || twice.status === 403, `status ${twice.status}`);
	const twiceSame = await raw(head(["GET /healthz HTTP/1.1", hostLine(), hostLine(), "Connection: close"]));
	assert.ok(twiceSame.status === 400 || twiceSame.status === 403, `status ${twiceSame.status}`);
});

test("any Origin header is refused, on every route, token or not", async () => {
	const origins = ["https://evil.example", "http://127.0.0.1:" + daemon.port, "http://localhost", "null", "moz-extension://0f8c2a3e-5b1d-4c7a-9e6f-112233445566", ""];
	for (const origin of origins) {
		// An empty header value has to go over a raw socket.
		if (origin === "") {
			const r = await raw(head(["GET /v1/status HTTP/1.1", hostLine(), authLine(), "Origin:", "Connection: close"]));
			assert.equal(r.status, 403, "empty Origin");
			continue;
		}
		assert.equal((await daemon.request("GET", "/healthz", { auth: false, headers: { Origin: origin } })).status, 403, origin);
		assert.equal((await daemon.request("GET", "/v1/status", { headers: { Origin: origin } })).status, 403, origin);
		const pair = await daemon.request("POST", "/v1/pair/start", { auth: "admin", body: {}, headers: { Origin: origin } });
		assert.equal(pair.status, 403, origin);
		assert.equal(pair.json.detail, "browser_request");
		assert.equal((await daemon.submitJob({ url: "https://example.com/" }, { headers: { Origin: origin } })).status, 403, origin);
		// The open proof route and the agent routes are behind the same gate.
		const prove = await daemon.request("POST", "/v1/prove", { auth: false, body: { role: "client", nonce: nonce() }, headers: { Origin: origin } });
		assert.equal(prove.status, 403, origin);
		assert.equal(prove.json.mac, undefined);
		for (const target of AGENT_ROUTES) {
			assert.equal((await daemon.request("POST", target, { body: {}, headers: { Origin: origin } })).status, 403, `${target} ${origin}`);
		}
	}
});

test("any Sec-Fetch-Site header is refused", async () => {
	for (const value of ["cross-site", "same-site", "same-origin", "none"]) {
		assert.equal((await daemon.request("GET", "/healthz", { auth: false, headers: { "Sec-Fetch-Site": value } })).status, 403, value);
		assert.equal((await daemon.request("GET", "/v1/status", { headers: { "Sec-Fetch-Site": value } })).status, 403, value);
		const pair = await daemon.request("POST", "/v1/pair/start", { auth: "admin", body: {}, headers: { "Sec-Fetch-Site": value } });
		assert.equal(pair.status, 403, value);
		assert.equal(pair.json.detail, "browser_request");
		const prove = await daemon.request("POST", "/v1/prove", { auth: false, body: { role: "admin", nonce: nonce() }, headers: { "Sec-Fetch-Site": value } });
		assert.equal(prove.status, 403, value);
		assert.equal(prove.json.mac, undefined);
		for (const target of AGENT_ROUTES) {
			assert.equal((await daemon.request("POST", target, { body: {}, headers: { "Sec-Fetch-Site": value } })).status, 403, `${target} ${value}`);
		}
	}
});

test("a request shaped like a web page's fetch() gets nothing, even with the token", async () => {
	const r = await daemon.submitJob(
		{ url: "https://example.com/" },
		{
			headers: {
				Origin: "https://evil.example",
				Referer: "https://evil.example/page",
				"Sec-Fetch-Site": "cross-site",
				"Sec-Fetch-Mode": "cors",
				"Sec-Fetch-Dest": "empty",
				"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0",
			},
		},
	);
	assert.equal(r.status, 403);
	assert.deepEqual(Object.keys(r.json).sort(), ["detail", "error", "ok"]);
	assert.equal(r.headers["access-control-allow-origin"], undefined);
	// The CORS preflight a browser would send first fares no better.
	const preflight = await daemon.request("OPTIONS", "/v1/jobs", {
		auth: false,
		headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
	});
	assert.equal(preflight.status, 403);
	assert.equal(preflight.headers["access-control-allow-origin"], undefined);
	assert.equal(preflight.headers["access-control-allow-headers"], undefined);
});

test("unknown paths are 404, query strings are refused", async () => {
	for (const target of ["/", "/nope", "/v1", "/v1/", "/v1/status/", "/v1/jobs/x", "/healthz/", "/HEALTHZ", "/v1//status", "/ext", "/mcp/", "/MCP", "/mcp/sse", "/v1/prove/", "/v1/pages", "/v1/pages/", "/v1/fetch/x", "/v1/job"]) {
		assert.equal((await daemon.request("GET", target)).status, 404, target);
	}
	for (const target of ["/healthz?", "/healthz?x=1", "/v1/status?verbose=1", `/v1/status?token=${daemon.token}`, `/v1/status?access_token=${daemon.token}`, "/mcp?session=1", "/v1/prove?role=client"]) {
		const r = await daemon.request("GET", target, { auth: false });
		assert.equal(r.status, 400, target);
		assert.equal(r.json.error, "query_not_allowed");
	}
});

test("the token is never accepted from the query string or the body", async () => {
	const inQuery = await daemon.request("GET", `/v1/status?token=${daemon.token}`, { auth: false });
	assert.equal(inQuery.status, 400);
	const inBody = await daemon.request("POST", "/v1/pair/start", { auth: false, body: { token: daemon.token, authorization: `Bearer ${daemon.token}` } });
	assert.equal(inBody.status, 401);
	const inCookie = await daemon.request("GET", "/v1/status", { auth: false, headers: { Cookie: `token=${daemon.token}` } });
	assert.equal(inCookie.status, 401);
});

test("absolute-form and malformed request targets are refused", async () => {
	const absolute = await raw(head([`GET http://127.0.0.1:${daemon.port}/healthz HTTP/1.1`, hostLine(), "Connection: close"]));
	assert.equal(absolute.status, 400);
	const star = await raw(head(["OPTIONS * HTTP/1.1", hostLine(), "Connection: close"]));
	assert.equal(star.status, 400);
});

test("wrong method is 405 with an Allow header", async () => {
	/** @type {[string, string, string][]} */
	const table = [
		["POST", "/healthz", "GET"],
		["PUT", "/healthz", "GET"],
		["DELETE", "/v1/status", "GET"],
		["POST", "/v1/status", "GET"],
		["GET", "/v1/pair/start", "POST"],
		["PUT", "/v1/pair/start", "POST"],
		["GET", "/v1/jobs", "POST"],
		["DELETE", "/v1/jobs", "POST"],
		["PATCH", "/v1/jobs", "POST"],
		["OPTIONS", "/v1/jobs", "POST"],
		["GET", "/v1/prove", "POST"],
		["PUT", "/v1/prove", "POST"],
		["GET", "/v1/fetch", "POST"],
		["DELETE", "/v1/pages/read", "POST"],
		["PUT", "/v1/pages/search", "POST"],
		["GET", "/v1/pages/export", "POST"],
		["DELETE", "/v1/pages/export", "POST"],
		// The MCP handler serves POST and is the one to say so for GET and DELETE; nothing else reaches it.
		["GET", "/mcp", "POST"],
		["DELETE", "/mcp", "POST"],
		["PUT", "/mcp", "POST"],
		["PATCH", "/mcp", "POST"],
		["OPTIONS", "/mcp", "POST"],
	];
	for (const [method, target, allow] of table) {
		const r = await daemon.request(method, target, method === "GET" || method === "DELETE" || method === "OPTIONS" ? {} : { body: {} });
		assert.equal(r.status, 405, `${method} ${target}`);
		assert.equal(r.headers.allow, allow);
	}
	const headReq = await daemon.request("HEAD", "/healthz", { auth: false });
	assert.equal(headReq.status, 405);
	// A state-changing route cannot be reached with a plain GET (link, img, redirect).
	assert.equal(daemon.logs.filter((l) => l.includes("pairing.code_issued")).length, 0);
});

test("authenticated routes: missing, malformed and wrong credentials are 401", async () => {
	const token = daemon.token;
	const flipped = (token[0] === "A" ? "B" : "A") + token.slice(1);
	/** @type {[string, string | null][]} */
	const table = [
		["no header", null],
		["empty", ""],
		["scheme only", "Bearer"],
		["scheme and space", "Bearer "],
		["bare token", token],
		["wrong token", `Bearer ${flipped}`],
		["truncated", `Bearer ${token.slice(0, 42)}`],
		["extended", `Bearer ${token}A`],
		["lower-case scheme", `bearer ${token}`],
		["upper-case scheme", `BEARER ${token}`],
		["Basic scheme", `Basic ${Buffer.from(`bgw:${token}`).toString("base64")}`],
		["Token scheme", `Token ${token}`],
		["two spaces", `Bearer  ${token}`],
		["trailing junk", `Bearer ${token} extra`],
		["comma list", `Bearer ${flipped}, Bearer ${token}`],
		["quoted", `Bearer "${token}"`],
		["all zero", `Bearer ${"A".repeat(43)}`],
	];
	for (const [target, method] of /** @type {const} */ ([
		["/v1/status", "GET"],
		["/v1/pair/start", "POST"],
		["/v1/jobs", "POST"],
		["/v1/fetch", "POST"],
		["/v1/pages/read", "POST"],
		["/v1/pages/search", "POST"],
		["/v1/pages/export", "POST"],
		["/mcp", "POST"],
	])) {
		for (const [label, value] of table) {
			/** @type {Record<string, string>} */
			const headers = value === null || value === "" ? {} : { Authorization: value };
			const r =
				value === ""
					? await raw([
							head([`${method} ${target} HTTP/1.1`, hostLine(), "Authorization:", "Content-Type: application/json", "Content-Length: 2", "Connection: close"]),
							"{}",
						])
					: await daemon.request(method, target, { auth: false, headers, ...(method === "POST" ? { body: {} } : {}) });
			assert.equal(r.status, 401, `${method} ${target}: ${label}`);
			if ("headers" in r) {
				assert.equal(r.headers["www-authenticate"], "Bearer");
				assert.deepEqual(r.json, { ok: false, error: "unauthorized" });
			}
		}
	}
	assert.equal(daemon.logs.filter((l) => l.includes("pairing.code_issued")).length, 0, "no refused request minted a code");

	// Whitespace around a header value is not part of the value (RFC 9110), so
	// the HTTP parser removes it before the token is compared.
	const padded = await daemon.request("GET", "/v1/status", { auth: false, headers: { Authorization: `Bearer ${token} ` } });
	assert.equal(padded.status, 200);
});

test("a repeated Authorization header is refused", async () => {
	const flipped = (daemon.token[0] === "A" ? "B" : "A") + daemon.token.slice(1);
	for (const lines of [
		[authLine(), `Authorization: Bearer ${flipped}`],
		[`Authorization: Bearer ${flipped}`, authLine()],
		[authLine(), authLine()],
	]) {
		const r = await raw(head(["GET /v1/status HTTP/1.1", hostLine(), ...lines, "Connection: close"]));
		assert.equal(r.status, 401, lines.join(" | "));
	}
});

test("authentication comes before the body is read", async () => {
	// Announces a huge body, sends none: the answer must not wait for it.
	const r = await raw(head(["POST /v1/jobs HTTP/1.1", hostLine(), "Content-Type: application/json", "Content-Length: 999999999"]));
	assert.equal(r.status, 401);
	const wrongType = await raw(head(["POST /v1/jobs HTTP/1.1", hostLine(), "Content-Type: text/plain", "Content-Length: 5"]));
	assert.equal(wrongType.status, 401);
});

test("healthz needs no token and gives name and version only", async () => {
	const r = await daemon.request("GET", "/healthz", { auth: false });
	assert.equal(r.status, 200);
	assert.deepEqual(r.json, { ok: true, name: "browser-gateway", version: JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version });
	assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
	assert.equal(r.headers["cache-control"], "no-store");
	assert.equal(r.headers["x-content-type-options"], "nosniff");
	assert.equal(r.headers["access-control-allow-origin"], undefined);
	// A wrong token on the open route changes nothing.
	assert.equal((await daemon.request("GET", "/healthz", { auth: false, headers: { Authorization: "Bearer nope" } })).status, 200);
});

test("mutating routes require application/json", async () => {
	for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", "text/json", "application/json5", "json", "*/*", "application/json, text/plain"]) {
		for (const target of [...ADMIN_ROUTES, ...AGENT_ROUTES, "/v1/prove"]) {
			const r = await daemon.request("POST", target, { auth: authFor(target), rawBody: "{}", headers: { "Content-Type": type } });
			assert.equal(r.status, 415, `${target} ${type}`);
			assert.equal(r.json.error, "unsupported_media_type");
		}
	}
	const none = await daemon.request("POST", "/v1/pair/start", { auth: "admin", rawBody: "{}", headers: { "Content-Type": "" } });
	assert.equal(none.status, 415);
	const twice = await raw([
		head(["POST /v1/pair/start HTTP/1.1", hostLine(), adminLine(), "Content-Type: application/json", "Content-Type: text/plain", "Content-Length: 2", "Connection: close"]),
		"{}",
	]);
	assert.equal(twice.status, 415);
	assert.equal(daemon.logs.filter((l) => l.includes("pairing.code_issued")).length, 0);

	// Parameters and case do not matter.
	for (const type of ["application/json", "application/json; charset=utf-8", "Application/JSON", "application/json;charset=UTF-8"]) {
		const r = await daemon.request("POST", "/v1/jobs", { auth: "admin", rawBody: "{}", headers: { "Content-Type": type } });
		assert.equal(r.status, 400, type);
		assert.equal(r.json.error, "invalid_request", "got past the media type check");
	}
	// On /mcp the check is for POST only: GET and DELETE carry no body.
	for (const method of ["GET", "DELETE"]) {
		assert.equal((await daemon.request(method, "/mcp", { headers: { "Content-Type": "text/plain" } })).status, 405, method);
	}
});

test("body cap is 1 MiB: declared, streamed, and the exact boundary", async () => {
	const declared = await raw(head(["POST /v1/jobs HTTP/1.1", hostLine(), adminLine(), "Content-Type: application/json", "Content-Length: 1048577"]));
	assert.equal(declared.status, 413);
	assert.match(declared.body, /"body_too_large"/);

	const chunk = "a".repeat(65536);
	const frame = `${chunk.length.toString(16)}\r\n${chunk}\r\n`;
	const streamed = await raw([
		head(["POST /v1/jobs HTTP/1.1", hostLine(), adminLine(), "Content-Type: application/json", "Transfer-Encoding: chunked"]),
		...new Array(17).fill(frame),
	]);
	assert.equal(streamed.status, 413);

	// Exactly 1 MiB is read and parsed (and then refused for its content, not its size).
	const prefix = '{"url":"https://example.com/","pad":"';
	const exact = prefix + "a".repeat(1048576 - prefix.length - 2) + '"}';
	assert.equal(Buffer.byteLength(exact), 1048576);
	const atCap = await daemon.request("POST", "/v1/jobs", { auth: "admin", rawBody: exact });
	assert.equal(atCap.status, 400);
	assert.equal(atCap.json.error, "invalid_request");
	const overCap = await raw([
		head(["POST /v1/jobs HTTP/1.1", hostLine(), adminLine(), "Content-Type: application/json", `Content-Length: ${exact.length + 1}`]),
	]);
	assert.equal(overCap.status, 413);
	// The agent routes and /mcp have the same cap.
	for (const target of AGENT_ROUTES) {
		const r = await raw(head([`POST ${target} HTTP/1.1`, hostLine(), authLine(), "Content-Type: application/json", "Content-Length: 1048577"]));
		assert.equal(r.status, 413, target);
	}
	// The two routes whose body is a nonce and little else take a kilobyte: one of them is open to anyone.
	const pad = JSON.stringify({ role: "client", nonce: nonce(), pad: "x".repeat(1024) });
	assert.equal((await daemon.request("POST", "/v1/prove", { auth: false, rawBody: pad })).status, 413);
	assert.equal((await raw(head(["POST /v1/prove HTTP/1.1", hostLine(), "Content-Type: application/json", "Content-Length: 1025"]))).status, 413);
	assert.equal((await daemon.request("POST", "/v1/pair/start", { auth: "admin", rawBody: pad })).status, 413);
	const chunked = await raw([head(["POST /v1/prove HTTP/1.1", hostLine(), "Content-Type: application/json", "Transfer-Encoding: chunked"]), `800\r\n${"a".repeat(2048)}\r\n`]);
	assert.equal(chunked.status, 413);
});

test("malformed JSON and non-object bodies are 400", async () => {
	/** @type {[string, string | Buffer][]} */
	const table = [
		["empty", ""],
		["whitespace", "  "],
		["truncated", '{"url":'],
		["trailing comma", '{"url":"https://example.com/",}'],
		["single quotes", "{'url':'https://example.com/'}"],
		["two documents", "{}{}"],
		["array", "[]"],
		["array of objects", '[{"url":"https://example.com/"}]'],
		["string", '"https://example.com/"'],
		["number", "5"],
		["null", "null"],
		["true", "true"],
		["invalid UTF-8", Buffer.from([0x7b, 0x22, 0x75, 0x72, 0x6c, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d])],
		["UTF-16", Buffer.from('{"url":"https://example.com/"}', "utf16le")],
		["deep nesting", "[".repeat(200000) + "]".repeat(200000)],
	];
	for (const [label, body] of table) {
		for (const target of [...ADMIN_ROUTES, "/v1/prove", "/v1/fetch", "/v1/pages/read", "/v1/pages/search"]) {
			// Beyond the kilobyte of the nonce routes the answer is about the size, before any parsing.
			if (label === "deep nesting" && ["/v1/pair/start", "/v1/prove", "/v1/pages/export"].includes(target)) continue;
			const r = await daemon.request("POST", target, { auth: authFor(target), rawBody: body });
			assert.equal(r.status, 400, `${target}: ${label}`);
			assert.equal(r.json.error, "invalid_json", `${target}: ${label}`);
		}
	}
	assert.equal(daemon.logs.filter((l) => l.includes("pairing.code_issued")).length, 0);
});

test("POST /v1/jobs: request shape is checked strictly", async () => {
	/** @type {[string, unknown][]} */
	const table = [
		["no url", {}],
		["url not a string", { url: 5 }],
		["url null", { url: null }],
		["url empty", { url: "" }],
		["url as list", { url: ["https://example.com/"] }],
		["unknown field", { url: "https://example.com/", headers: { "User-Agent": "x" } }],
		["unknown field: script", { url: "https://example.com/", script: "document.cookie" }],
		["unknown field: cookies", { url: "https://example.com/", cookies: true }],
		["unknown field: job", { url: "https://example.com/", job: "j_mine" }],
		["kind search", { kind: "search", url: "https://example.com/" }],
		["kind click", { kind: "click", url: "https://example.com/" }],
		["kind number", { kind: 1, url: "https://example.com/" }],
		["session default", { url: "https://example.com/", session: "default" }],
		["session logged_in", { url: "https://example.com/", session: "logged_in" }],
		["wait not an object", { url: "https://example.com/", wait: 5 }],
		["wait as list", { url: "https://example.com/", wait: [] }],
		["wait unknown field", { url: "https://example.com/", wait: { clicks: 3 } }],
		["timeout too small", { url: "https://example.com/", wait: { timeout_ms: 999 } }],
		["timeout too large", { url: "https://example.com/", wait: { timeout_ms: 300001 } }],
		["timeout fractional", { url: "https://example.com/", wait: { timeout_ms: 1500.5 } }],
		["timeout as string", { url: "https://example.com/", wait: { timeout_ms: "5000" } }],
		["settle negative", { url: "https://example.com/", wait: { settle_ms: -1 } }],
		["dwell too large", { url: "https://example.com/", wait: { dwell_ms: 30001 } }],
		["human wait too large", { url: "https://example.com/", wait: { human_wait_ms: 900001 } }],
		["scroll full", { url: "https://example.com/", wait: { scroll: "full" } }],
		["extract not an object", { url: "https://example.com/", extract: "markdown" }],
		["extract unknown field", { url: "https://example.com/", extract: { screenshot: true } }],
		["markdown as string", { url: "https://example.com/", extract: { markdown: "yes" } }],
		["adapter custom", { url: "https://example.com/", extract: { adapter: "custom" } }],
		["raw_html as string", { url: "https://example.com/", extract: { raw_html: "yes" } }],
		["raw_html as number", { url: "https://example.com/", extract: { raw_html: 1 } }],
	];
	for (const [label, body] of table) {
		const r = await daemon.submitJob(/** @type {Record<string, unknown>} */ (body));
		assert.equal(r.status, 400, label);
		assert.equal(r.json.error, "invalid_request", label);
		assert.equal(typeof r.json.detail, "string", label);
	}
	assert.deepEqual(daemon.auditEntries(), [], "a malformed request is not a job");
});

test("POST /v1/jobs: URL policy runs first and the refusal is audited", async () => {
	// No extension is connected. A refusal by policy (rather than
	// extension_not_connected) shows that policy was checked before anything else.
	/** @type {[string, string][]} */
	const table = [
		["http://127.0.0.1:8791/v1/status", "private_address"],
		["http://2130706433/", "private_address"],
		["http://0x7f.1/", "private_address"],
		["http://[::ffff:127.0.0.1]/", "private_address"],
		["http://192.168.1.1/", "private_address"],
		["http://169.254.169.254/latest/meta-data/", "private_address"],
		["http://localhost:8791/", "local_name"],
		["http://printer.local/", "local_name"],
		["http://router/", "single_label"],
		["http://abcdefghijklmnop.onion/", "onion"],
		["https://mail.google.com/mail/u/0/", "blocklisted"],
		["https://www.paypal.com/", "blocklisted"],
		["file:///etc/passwd", "scheme_not_allowed"],
		["javascript:alert(1)", "scheme_not_allowed"],
		["https://user:pw@example.com/", "userinfo_not_allowed"],
		["not a url", "invalid_url"],
		["https://example.com/" + "a".repeat(2048), "url_too_long"],
	];
	const before = daemon.auditEntries().length;
	for (const [url, reason] of table) {
		const r = await daemon.submitJob({ url });
		assert.equal(r.status, 200, url);
		assert.equal(r.json.ok, true);
		const result = r.json.result;
		assert.equal(result.outcome, "policy_blocked", url);
		assert.deepEqual(result.error, { code: reason, message: "the URL is not allowed by the gateway policy", retryable: false, retry_after_s: null }, url);
		assert.equal(result.content, null);
		assert.equal(result.cookie_scope, null);
		assert.match(result.job, /^j_/);
		assert.ok(result.nav.requested_url.length <= 2048);
	}
	const entries = daemon.auditEntries().slice(before);
	assert.equal(entries.length, table.length);
	assert.deepEqual(entries.map((e) => [e.outcome, e.code]), table.map(([, reason]) => ["policy_blocked", reason]));
	// Of an address the policy refused, the origin is the record - and nothing where it has none.
	assert.deepEqual(entries.map((e) => e.url), [
		"http://127.0.0.1:8791",
		"http://127.0.0.1",
		"http://127.0.0.1",
		"http://[::ffff:7f00:1]",
		"http://192.168.1.1",
		"http://169.254.169.254",
		"http://localhost:8791",
		"http://printer.local",
		"http://router",
		"http://abcdefghijklmnop.onion",
		"https://mail.google.com",
		"https://www.paypal.com",
		null,
		null,
		"https://example.com",
		null,
		"https://example.com",
	]);
	assert.ok(!fs.readFileSync(path.join(daemon.dataDir, "audit.jsonl"), "utf8").includes("user:pw"));
});

test("POST /v1/jobs: an allowed URL without an extension fails fast", async () => {
	const r = await daemon.submitJob({ url: "https://example.com/a" });
	assert.equal(r.status, 200);
	assert.equal(r.json.result.outcome, "error");
	assert.equal(r.json.result.error.code, "extension_not_connected");
	assert.equal(r.json.result.error.retryable, true);
});

test("GET /v1/status with the agent token: booleans and counts only", async () => {
	const r = await daemon.request("GET", "/v1/status");
	assert.equal(r.status, 200);
	assert.deepEqual(Object.keys(r.json).sort(), ["audit_ok", "extension_connected", "name", "ok", "optin_rules", "paired", "paused", "pending_operator_actions", "queue", "store", "uptime_s", "version"]);
	assert.deepEqual(
		{ ...r.json, uptime_s: 0, version: "" },
		{
			ok: true,
			name: "browser-gateway",
			version: "",
			uptime_s: 0,
			paired: false,
			extension_connected: false,
			paused: false,
			queue: { queued: 0, dispatched: 0 },
			pending_operator_actions: 0,
			optin_rules: 0,
			store: { pages: 0, stored: 0, files: 0, file_bytes: 0, file_bytes_max: 2147483648 },
			audit_ok: true,
		},
	);
	assert.ok(Number.isInteger(r.json.uptime_s) && r.json.uptime_s >= 0);
	assert.ok(!r.text.includes(daemon.token));
	assert.ok(!r.text.includes(daemon.adminToken));
});

test("GET /v1/status with the admin token: the operator's view", async () => {
	const r = await daemon.request("GET", "/v1/status", { auth: "admin" });
	assert.equal(r.status, 200);
	assert.deepEqual(Object.keys(r.json).sort(), ["audit_ok", "extension", "extension_connected", "name", "ok", "optin_rules", "paired", "pairing_pending", "paused", "pending", "pending_operator_actions", "queue", "settings", "store", "uptime_s", "version"]);
	assert.deepEqual(r.json.extension, { connected: false });
	assert.equal(typeof r.json.pairing_pending, "boolean");
	assert.deepEqual(r.json.settings, {
		retention_days: 30,
		cache_ttl_s: 600,
		// The test daemon notifies at once (challengeDelayMs 0); an operator's waits 30 s unless config.json says otherwise.
		notify: { sound: true, hook: false, challenge_delay_s: 0 },
		fetch: { load_timeout_s: 30 },
		pacing: { default_profile: "polite", fast_hosts: [], hourly_budget: { polite: 120, fast: 1200 } },
		search: { default_engine: "duckduckgo", engines: ["duckduckgo", "brave", "bing", "google", "startpage"] },
		pages: { max_total_mb: 2048 },
		files: { enabled: true, max_mb: 25, max_total_mb: 2048, allow_types: ["application/pdf", "application/json", "+json", "application/xml", "text/xml", "+xml", "text/plain", "text/csv", "text/markdown", "image/png", "image/jpeg", "image/gif", "image/webp", "application/zip", "application/gzip", "application/x-tar", "application/octet-stream"] },
	});
	assert.ok(!r.text.includes(daemon.token) && !r.text.includes(daemon.adminToken));
});

test("POST /v1/prove: the daemon proves that it holds a token, to anyone, without telling anything else", async () => {
	for (const role of /** @type {const} */ (["client", "admin"])) {
		const n = nonce();
		const r = await daemon.request("POST", "/v1/prove", { auth: false, body: { role, nonce: n } });
		assert.equal(r.status, 200);
		assert.deepEqual(Object.keys(r.json).sort(), ["mac", "ok"]);
		const token = role === "admin" ? daemon.adminToken : daemon.token;
		assert.equal(r.json.mac, hmac(token, `bgw1|prove|${role}|${daemon.port}|${n}`));
		assert.notEqual(r.json.mac, hmac(token, `bgw1|prove|${role}|${n}`), "the port is part of what is signed");
		assert.notEqual(r.json.mac, hmac(token, `bgw1|prove|${role}|${daemon.port + 1}|${n}`));
		assert.match(r.json.mac, /^[A-Za-z0-9_-]{43}$/);
		// Same shape and size for every valid request.
		const again = await daemon.request("POST", "/v1/prove", { auth: false, body: { role, nonce: nonce() } });
		assert.equal(again.text.length, r.text.length);
		assert.notEqual(again.json.mac, r.json.mac);
		assert.deepEqual(Object.keys(again.headers).sort(), Object.keys(r.headers).sort());
		// Nonces of every allowed length.
		for (const bytes of [16, 24, 48, 64]) {
			const sized = crypto.randomBytes(bytes).toString("base64url");
			const s = await daemon.request("POST", "/v1/prove", { auth: false, body: { role, nonce: sized } });
			assert.equal(s.json.mac, hmac(token, `bgw1|prove|${role}|${daemon.port}|${sized}`), `${bytes} bytes`);
		}
	}
	// A token sent along changes nothing: the route does not look at it.
	const n = nonce();
	const withToken = await daemon.request("POST", "/v1/prove", { body: { role: "admin", nonce: n } });
	const withJunk = await daemon.request("POST", "/v1/prove", { auth: false, headers: { Authorization: "Bearer nope" }, body: { role: "admin", nonce: n } });
	assert.equal(withToken.json.mac, hmac(daemon.adminToken, `bgw1|prove|admin|${daemon.port}|${n}`));
	assert.equal(withJunk.json.mac, withToken.json.mac);

	/** @type {[string, unknown][]} */
	const bad = [
		["empty", {}],
		["no nonce", { role: "client" }],
		["no role", { nonce: nonce() }],
		["unknown role", { role: "ext", nonce: nonce() }],
		["role with case", { role: "Admin", nonce: nonce() }],
		["role as list", { role: ["client"], nonce: nonce() }],
		["nonce too short", { role: "client", nonce: crypto.randomBytes(15).toString("base64url") }],
		["nonce too long", { role: "client", nonce: crypto.randomBytes(65).toString("base64url") }],
		["nonce not base64url", { role: "client", nonce: "!".repeat(43) }],
		["nonce padded", { role: "client", nonce: nonce() + "=" }],
		["nonce with a separator", { role: "client", nonce: `${nonce().slice(0, 20)}|${nonce().slice(0, 20)}` }],
		["nonce as number", { role: "client", nonce: 12345678901234567890 }],
		["extra field", { role: "client", nonce: nonce(), token: "x" }],
		["a message to sign", { role: "client", nonce: nonce(), text: "bgw1|pair|x|y" }],
	];
	for (const [label, body] of bad) {
		const r = await daemon.request("POST", "/v1/prove", { auth: false, body });
		assert.equal(r.status, 400, label);
		assert.equal(r.json.error, "invalid_request", label);
		assert.equal(r.json.mac, undefined, label);
	}
	// Neither a token nor a proof nor a nonce is written to the log.
	const logText = daemon.logs.join("\n");
	assert.ok(!logText.includes(daemon.token) && !logText.includes(daemon.adminToken));
	assert.ok(!logText.includes(withToken.json.mac) && !logText.includes(n));
});

test("POST /v1/pair/start: the admin token mints a code for this port, signed for the caller's nonce", async () => {
	for (const body of [{}, { ttl_s: 86400 }, { nonce: "short" }, { nonce: nonce(), ttl_s: 1 }, { nonce: 5 }]) {
		const refused = await daemon.request("POST", "/v1/pair/start", { auth: "admin", body });
		assert.equal(refused.status, 400, JSON.stringify(body));
		assert.equal(refused.json.code, undefined);
	}
	assert.equal(logged("pairing.code_issued").length, 0, "a refused request mints nothing");

	const n = nonce();
	const r = await daemon.request("POST", "/v1/pair/start", { auth: "admin", body: { nonce: n } });
	assert.equal(r.status, 200);
	assert.deepEqual(Object.keys(r.json).sort(), ["code", "expires_in_s", "mac", "ok"]);
	assert.equal(r.json.expires_in_s, 600);
	const parsed = parsePairingCode(r.json.code);
	assert.ok(parsed.ok);
	assert.equal(parsed.port, daemon.port);
	assert.equal(r.json.mac, hmac(daemon.adminToken, `bgw1|pair|${daemon.port}|${n}|${r.json.code}`));
	assert.notEqual(r.json.mac, hmac(daemon.token, `bgw1|pair|${daemon.port}|${n}|${r.json.code}`), "under the admin token, not the agent's");
	assert.notEqual(r.json.mac, hmac(daemon.adminToken, `bgw1|pair|${n}|${r.json.code}`), "the port is part of what is signed");

	const second = await daemon.request("POST", "/v1/pair/start", { auth: "admin", body: { nonce: n } });
	assert.notEqual(second.json.code, r.json.code);
	assert.notEqual(second.json.mac, r.json.mac);
	assert.equal((await daemon.request("GET", "/v1/status", { auth: "admin" })).json.pairing_pending, true);

	// The code appears in the one response that is meant to carry it and nowhere else.
	const secret = parsed.code.split(".")[2];
	assert.ok(!daemon.logs.join("\n").includes(secret));
	for (const name of fs.readdirSync(daemon.configDir)) {
		assert.ok(!fs.readFileSync(path.join(daemon.configDir, name), "utf8").includes(secret), name);
	}
	assert.ok(!daemon.logs.join("\n").includes(daemon.token));
	assert.ok(!daemon.logs.join("\n").includes(daemon.adminToken));
	assert.ok(!daemon.logs.join("\n").includes(r.json.mac));
});

test("the agent token cannot mint pairing codes", async () => {
	const issued = () => daemon.logs.filter((l) => l.includes("pairing.code_issued")).length;
	const before = issued();
	const r = await daemon.request("POST", "/v1/pair/start", { body: {} });
	assert.equal(r.status, 403);
	assert.deepEqual(r.json, { ok: false, error: "forbidden", detail: "wrong_token_for_route" });
	assert.ok(!r.text.includes("bgw1."), "no code in the refusal");
	// Not with other bodies or content types either: the answer is the same before anything is read.
	for (const ro of [{ rawBody: "not json" }, { rawBody: "{}", headers: { "Content-Type": "text/plain" } }, { body: { admin: true } }]) {
		assert.equal((await daemon.request("POST", "/v1/pair/start", ro)).status, 403);
	}
	// Sending both tokens does not help.
	const both = await raw([
		head(["POST /v1/pair/start HTTP/1.1", hostLine(), authLine(), adminLine(), "Content-Type: application/json", "Content-Length: 2", "Connection: close"]),
		"{}",
	]);
	assert.equal(both.status, 401);
	const joined = await daemon.request("POST", "/v1/pair/start", { auth: false, body: {}, headers: { Authorization: `Bearer ${daemon.token}, Bearer ${daemon.adminToken}` } });
	assert.equal(joined.status, 401);
	assert.equal(issued(), before, "no code was minted");
});

test("each token has its own routes: raw jobs and pairing for the operator, tools for the agent", async () => {
	assert.notEqual(daemon.adminToken, daemon.token);
	if (MODES) assert.equal(fs.statSync(path.join(daemon.configDir, "admin.token")).mode & 0o777, 0o600);

	// The agent token gets nothing from the raw job route: no result, no job, no audit entry.
	const before = daemon.auditEntries().length;
	for (const body of [{ url: "https://example.com/raw" }, { url: "https://mail.google.com/" }, {}, { url: "https://example.com/raw", kind: "probe" }]) {
		const r = await daemon.request("POST", "/v1/jobs", { body });
		assert.equal(r.status, 403, JSON.stringify(body));
		assert.deepEqual(r.json, { ok: false, error: "forbidden", detail: "wrong_token_for_route" });
	}
	assert.equal(daemon.auditEntries().length, before);
	// Nor from the page export, whose answer is page content without markers: not a page, not a word about whether there is one.
	for (const body of [{ page: `pg_${"0".repeat(26)}`, format: "raw_html" }, { page: `pg_${"0".repeat(26)}`, format: "markdown" }, {}, { page: "x" }]) {
		const r = await daemon.request("POST", "/v1/pages/export", { body });
		assert.equal(r.status, 403, JSON.stringify(body));
		assert.deepEqual(r.json, { ok: false, error: "forbidden", detail: "wrong_token_for_route" });
	}
	assert.equal(daemon.auditEntries().length, before);
	// The admin token does: here the answer is a job result (no extension is connected).
	const job = await daemon.request("POST", "/v1/jobs", { auth: "admin", body: { url: "https://example.com/raw" } });
	assert.equal(job.status, 200);
	assert.equal(job.json.result.error.code, "extension_not_connected");

	// The admin token is not an agent token.
	for (const target of AGENT_ROUTES) {
		const r = await daemon.request("POST", target, { auth: "admin", body: { url: "https://example.com/" } });
		assert.equal(r.status, 403, target);
		assert.deepEqual(r.json, { ok: false, error: "forbidden", detail: "wrong_token_for_route" });
	}
	for (const method of ["GET", "DELETE"]) assert.equal((await daemon.request(method, "/mcp", { auth: "admin" })).status, 403, method);
	// The open routes stay open, whatever is sent along.
	assert.equal((await daemon.request("GET", "/healthz", { auth: "admin" })).status, 200);
	// The status route takes both and answers each its own way.
	assert.equal((await daemon.request("GET", "/v1/status", { auth: "admin" })).json.settings.retention_days, 30);
	assert.equal((await daemon.request("GET", "/v1/status")).json.settings, undefined);
});

test("POST /v1/jobs: wait values are cut to what a fetch may ask for", async () => {
	const { parseJobRequest } = await import("../../daemon/src/http.js");
	// Before the fix these maxima went through as they were: 21 minutes for one job.
	const greedy = parseJobRequest({ url: "https://example.com/", wait: { timeout_ms: 300000, settle_ms: 30000, dwell_ms: 30000, human_wait_ms: 900000 } });
	assert.deepEqual(greedy.wait, { timeout_ms: 120000, settle_ms: 5000, dwell_ms: 10000, human_wait_ms: 120000, scroll: "lazy" });
	assert.deepEqual(greedy.wait, { ...JOB_WAIT_MAX, scroll: "lazy" });
	// What a job can hold the browser for: loading, settling, dwell, and the two grace periods. Waiting for the
	// operator is no part of it - a job that comes to that is parked and leaves the slot.
	const total = greedy.wait.timeout_ms + greedy.wait.settle_ms + Number(greedy.wait.dwell_ms) + LIMITS.runGraceMs + LIMITS.challengeGraceMs;
	assert.ok(total <= LIMITS.maxRunMs, `${total} ms`);
	// Values inside the limits are kept, defaults are the fetch service's.
	assert.deepEqual(parseJobRequest({ url: "https://example.com/", wait: { timeout_ms: 5000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 60000, scroll: "none" } }).wait, { timeout_ms: 5000, settle_ms: 0, dwell_ms: 0, human_wait_ms: 60000, scroll: "none" });
	assert.deepEqual(parseJobRequest({ url: "https://example.com/" }).wait, { timeout_ms: 30000, settle_ms: 1500, dwell_ms: null, human_wait_ms: 0, scroll: "lazy" });
	assert.deepEqual(parseJobRequest({ url: "https://example.com/" }).extract, { markdown: true, text: true, html: false, raw_html: false, links: true, adapter: "auto" });
	assert.equal(parseJobRequest({ url: "https://example.com/", extract: { raw_html: true } }).extract.raw_html, true);
	// The fetch service stays inside the same limits: its own default, and the longest an operator can set.
	assert.ok(FETCH_LIMITS.jobTimeoutMs <= JOB_WAIT_MAX.timeout_ms);
	assert.equal(LOAD_TIMEOUT_S.fallback * 1000, FETCH_LIMITS.jobTimeoutMs);
	assert.equal(LOAD_TIMEOUT_S.max * 1000, JOB_WAIT_MAX.timeout_ms);
	assert.ok(FETCH_LIMITS.settleMs <= JOB_WAIT_MAX.settle_ms);
	assert.equal(FETCH_LIMITS.maxWaitForHumanS * 1000, JOB_WAIT_MAX.human_wait_ms);
});

test("refused requests cannot flood the log: a few lines per reason, then one summary", async () => {
	const clock = new FakeClock();
	const d = await startTestDaemon({ clock });
	const lines = (/** @type {string} */ event) => d.logs.map((l) => JSON.parse(l)).filter((l) => l.event === event);
	try {
		// What a web page can do with a blind request: one warning each before the fix.
		for (let i = 0; i < 100; i++) {
			const r = await d.request("POST", "/v1/fetch", { auth: false, rawBody: "{}", headers: { Origin: "https://evil.example", "Content-Type": "text/plain" } });
			assert.equal(r.status, 403);
		}
		for (let i = 0; i < 30; i++) assert.equal((await d.request("GET", "/v1/status", { auth: false })).status, 401);
		for (let i = 0; i < 3; i++) assert.equal((await d.request("POST", "/v1/jobs", { body: {} })).status, 403);
		const refused = lines("http.refused");
		assert.equal(refused.filter((l) => l.reason === "browser_request").length, LIMITS.refusalLogBurst);
		assert.equal(refused.filter((l) => l.reason === "unauthorized").length, LIMITS.refusalLogBurst);
		assert.equal(refused.filter((l) => l.reason === "wrong_token_for_route").length, 3, "a rare reason is not drowned by a frequent one");
		assert.equal(d.logs.length < 40, true, `${d.logs.length} log lines for 133 refusals`);
		assert.equal(lines("log.suppressed").length, 0);
		clock.advance(LIMITS.refusalLogIntervalMs);
		assert.deepEqual(
			lines("log.suppressed")
				.map((l) => [l.level, l.suppressed_event, l.key, l.count, l.interval_s])
				.sort(),
			[
				["warn", "http.refused", "401 unauthorized", 30 - LIMITS.refusalLogBurst, 60],
				["warn", "http.refused", "403 browser_request", 100 - LIMITS.refusalLogBurst, 60],
			],
		);
		// The next interval starts over.
		await d.request("GET", "/v1/status", { auth: false });
		assert.equal(lines("http.refused").filter((l) => l.reason === "unauthorized").length, LIMITS.refusalLogBurst + 1);
		// Nothing of the request itself is in those lines.
		assert.ok(!d.logs.join("\n").includes("evil.example"));
	} finally {
		await d.stop();
	}
	assert.equal(clock.pending, 0, "no timer survives shutdown");
});

test("status tells the agent whether the gateway is paired, and nothing about pairing codes", async () => {
	await daemon.request("POST", "/v1/pair/start", { auth: "admin", body: {} });
	const r = await daemon.request("GET", "/v1/status");
	assert.equal(r.status, 200);
	assert.equal(r.json.paired, false, "minting a code does not pair anything");
	assert.equal(typeof r.json.paired, "boolean");
	assert.equal(r.json.pairing, undefined);
	assert.ok(!/pairing|expires|code/i.test(r.text), r.text);
	assert.ok(!r.text.includes(daemon.token) && !r.text.includes(daemon.adminToken));
});

test("a plain GET on /ext and upgrades on other paths get nowhere", async () => {
	assert.equal((await daemon.request("GET", "/ext")).status, 404);
	const upgrade = ["Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="];
	const origin = "Origin: moz-extension://0f8c2a3e-5b1d-4c7a-9e6f-112233445566";
	for (const target of ["/v1/status", "/v1/jobs", "/", "/ext/", "/ext?x=1", "/EXT", "/ext/../ext"]) {
		const r = await raw(head([`GET ${target} HTTP/1.1`, hostLine(), authLine(), origin, ...upgrade]));
		assert.equal(r.status, 404, target);
	}
	const post = await raw(head(["POST /ext HTTP/1.1", hostLine(), origin, ...upgrade, "Content-Length: 0"]));
	assert.ok(post.status === 404 || post.status === 405 || post.status === 403, `status ${post.status}`);
});

test("start() refuses to run without explicit port and directories", async () => {
	const { start } = await import("../../daemon/src/server.js");
	await assert.rejects(start(/** @type {any} */ ({ port: 0 })), /configDir/);
	await assert.rejects(start(/** @type {any} */ ({ port: 0, configDir: path.join(daemon.dir, "c2") })), /dataDir/);
	await assert.rejects(start(/** @type {any} */ ({ port: 0, configDir: "relative", dataDir: "relative" })), /configDir/);
	await assert.rejects(start(/** @type {any} */ ({ configDir: path.join(daemon.dir, "c2"), dataDir: path.join(daemon.dir, "d2") })), /port/);
	assert.equal(fs.existsSync(path.join(daemon.dir, "c2")), false);
});

test("the listener is bound to loopback only", async () => {
	const { networkInterfaces } = await import("node:os");
	const external = Object.values(networkInterfaces())
		.flat()
		.filter((i) => i && !i.internal && i.family === "IPv4")
		.map((i) => i?.address);
	for (const address of external) {
		if (!address) continue;
		/** @type {string} */
		const outcome = await new Promise((resolve) => {
			const s = net.connect({ host: address, port: daemon.port });
			s.setTimeout(1000, () => {
				s.destroy();
				resolve("timeout");
			});
			s.on("connect", () => {
				s.destroy();
				resolve("connected");
			});
			s.on("error", () => resolve("refused"));
		});
		assert.notEqual(outcome, "connected", `reachable on ${address}`);
	}
});
