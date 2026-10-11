import { JOB_WAIT_MAX, LIMITS } from "./config.js";
import { newJobId, synthReport } from "./queue.js";
import { isProofNonce } from "./secrets.js";
import { BODY_PARSE_ERROR } from "./mcp.js";
import { checkUrl } from "../../extension/shared/policy.js";
import { ADAPTERS, SCROLL_MODES, SESSIONS } from "../../extension/shared/protocol.js";

/**
 * @typedef {import("node:http").IncomingMessage} Req
 * @typedef {import("node:http").ServerResponse} Res
 * @typedef {import("./queue.js").JobSpec} JobSpec
 * @typedef {"client" | "admin"} Role
 */

/**
 * @typedef {object} RouteContext
 * @property {Record<string, unknown>} body parsed JSON object; empty for GET
 * @property {Role | null} role whose token came with the request; null on open routes
 * @property {(fn: () => void) => void} onClientGone called when the client disconnects before the response
 *
 * @typedef {object} Route
 * @property {"GET" | "POST"} method
 * @property {"none" | Role | "either"} auth which bearer token the route takes. "either": both, and the answer
 *   depends on which one came
 * @property {number} [maxBodyBytes] default LIMITS.maxBodyBytes
 * @property {(ctx: RouteContext) => Promise<Record<string, unknown>> | Record<string, unknown>} handler
 */

/**
 * @typedef {object} HttpDeps
 * @property {{ name: string, version: string }} pkg
 * @property {() => number} getPort the bound port, for the Host check
 * @property {import("./secrets.js").Secrets} secrets
 * @property {import("./queue.js").JobQueue} queue
 * @property {Pick<import("./fetchsvc.js").FetchService, "fetchPage" | "readPage" | "searchPages" | "searchWeb" | "exportPage" | "exportFile">} fetchsvc
 * @property {{ handle: (req: import("./mcp.js").McpRequest) => Promise<import("./mcp.js").McpResponse> }} mcp
 * @property {{ agent: () => Record<string, unknown>, admin: () => Record<string, unknown> }} status what GET /v1/status tells each role
 * @property {import("./audit.js").AuditLog} audit
 * @property {import("./log.js").Logger} log
 * @property {import("./log.js").LogThrottle} throttle for the "refused" warnings any local process can provoke
 * @property {{ blocklist?: readonly string[], allowLoopbackPorts?: readonly number[] }} policy
 */

const MCP_PATH = "/mcp";
/** Reach the MCP handler, which serves POST and answers the others itself. */
const MCP_METHODS = Object.freeze(["GET", "POST", "DELETE"]);

class HttpError extends Error {
	/**
	 * @param {number} status
	 * @param {string} code
	 * @param {string} [detail]
	 * @param {Record<string, string>} [headers]
	 */
	constructor(status, code, detail, headers) {
		super(code);
		this.status = status;
		this.code = code;
		this.detail = detail;
		this.headers = headers ?? {};
	}
}

/**
 * @param {Res} res
 * @param {number} status
 * @param {Record<string, unknown> | null} body null: no body
 * @param {Record<string, string>} [headers]
 */
function send(res, status, body, headers = {}) {
	if (res.headersSent) return;
	const text = body === null ? "" : JSON.stringify(body);
	res.writeHead(status, {
		...(body === null ? {} : { "content-type": "application/json; charset=utf-8" }),
		"content-length": Buffer.byteLength(text),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		// An error may leave an unread request body behind; do not reuse the connection.
		...(status >= 400 ? { connection: "close" } : {}),
		...headers,
	});
	res.end(text);
}

/**
 * @param {Req} req
 * @param {string} name lowercase header name
 * @returns {string | null | undefined} undefined: absent, null: sent more than once
 */
function singleHeader(req, name) {
	const values = req.headersDistinct[name];
	if (values === undefined || values.length === 0) return undefined;
	return values.length === 1 ? values[0] : null;
}

/**
 * @param {Req} req
 * @param {number} max
 * @returns {Promise<Buffer>}
 */
function readBody(req, max) {
	return new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		const chunks = [];
		let size = 0;
		let settled = false;
		req.on("data", (/** @type {Buffer} */ chunk) => {
			if (settled) return;
			size += chunk.length;
			if (size > max) {
				settled = true;
				reject(new HttpError(413, "body_too_large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			resolve(Buffer.concat(chunks));
		});
		// "close" without "end": the client went away mid-body. Settle, so nothing waits forever.
		const fail = () => {
			if (settled) return;
			settled = true;
			reject(new HttpError(400, "bad_request"));
		};
		req.on("error", fail);
		req.on("close", fail);
	});
}

/**
 * The request body of a POST: application/json, within the size limit.
 * @param {Req} req
 * @param {number} max
 * @returns {Promise<Buffer>}
 */
async function readJsonBody(req, max) {
	const type = singleHeader(req, "content-type");
	if (typeof type !== "string" || type.split(";")[0].trim().toLowerCase() !== "application/json") {
		throw new HttpError(415, "unsupported_media_type", "content-type must be application/json");
	}
	const declared = singleHeader(req, "content-length");
	if (typeof declared === "string" && Number(declared) > max) throw new HttpError(413, "body_too_large");
	return readBody(req, max);
}

/**
 * @param {Buffer} raw
 * @returns {unknown} the decoded JSON value
 * @throws {SyntaxError | TypeError} when it is not UTF-8 or not JSON
 */
function decodeJson(raw) {
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isPlainObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {readonly string[]} allowed
 * @returns {string | null} the first key that is not allowed
 */
function extraKey(obj, allowed) {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) return key.slice(0, 40);
	}
	return null;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {number} min
 * @param {number} max
 * @param {number | null} fallback
 * @returns {number | null}
 */
function intField(obj, key, min, max, fallback) {
	const v = obj[key];
	if (v === undefined) return fallback;
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
		throw new HttpError(400, "invalid_request", `wait.${key} must be an integer ${min}..${max}`);
	}
	return v;
}

/**
 * @template {string} T
 * @param {unknown} v
 * @param {readonly T[]} values
 * @param {T} fallback
 * @param {string} name
 * @returns {T}
 */
function enumField(v, values, fallback, name) {
	if (v === undefined) return fallback;
	const hit = values.find((x) => x === v);
	if (hit === undefined) throw new HttpError(400, "invalid_request", `${name} must be one of ${values.join(", ")}`);
	return hit;
}

/**
 * @param {unknown} v
 * @param {boolean} fallback
 * @param {string} name
 * @returns {boolean}
 */
function boolField(v, fallback, name) {
	if (v === undefined) return fallback;
	if (typeof v !== "boolean") throw new HttpError(400, "invalid_request", `${name} must be a boolean`);
	return v;
}

/**
 * Check the body of POST /v1/jobs and fill in defaults. The URL is returned
 * as given; policy runs on it next. Wait values above what the fetch service
 * itself would ask for are cut down to JOB_WAIT_MAX, so no caller of this
 * route can hold the browser longer than a fetch can.
 * @param {Record<string, unknown>} body
 * @returns {Omit<JobSpec, "host" | "dedupeKey">}
 */
export function parseJobRequest(body) {
	const extra = extraKey(body, ["kind", "url", "session", "wait", "extract"]);
	if (extra !== null) throw new HttpError(400, "invalid_request", `unknown field: ${extra}`);
	// This raw route takes fetch and probe jobs only; web searches go through POST /v1/search.
	const kind = enumField(body.kind, /** @type {const} */ (["fetch", "probe"]), "fetch", "kind");
	if (typeof body.url !== "string" || body.url === "") throw new HttpError(400, "invalid_request", "url must be a string");
	const session = enumField(body.session, SESSIONS, "auto", "session");

	const w = body.wait ?? {};
	if (!isPlainObject(w)) throw new HttpError(400, "invalid_request", "wait must be an object");
	const extraWait = extraKey(w, ["timeout_ms", "settle_ms", "dwell_ms", "human_wait_ms", "scroll"]);
	if (extraWait !== null) throw new HttpError(400, "invalid_request", `unknown field: wait.${extraWait}`);
	const dwell = intField(w, "dwell_ms", 0, 30000, null);
	const wait = {
		timeout_ms: Math.min(intField(w, "timeout_ms", 1000, 300000, 30000) ?? 30000, JOB_WAIT_MAX.timeout_ms),
		settle_ms: Math.min(intField(w, "settle_ms", 0, 30000, 1500) ?? 1500, JOB_WAIT_MAX.settle_ms),
		dwell_ms: dwell === null ? null : Math.min(dwell, JOB_WAIT_MAX.dwell_ms),
		human_wait_ms: Math.min(intField(w, "human_wait_ms", 0, 900000, 0) ?? 0, JOB_WAIT_MAX.human_wait_ms),
		scroll: enumField(w.scroll, SCROLL_MODES, "lazy", "wait.scroll"),
	};

	const e = body.extract ?? {};
	if (!isPlainObject(e)) throw new HttpError(400, "invalid_request", "extract must be an object");
	const extraExtract = extraKey(e, ["markdown", "text", "html", "raw_html", "links", "adapter"]);
	if (extraExtract !== null) throw new HttpError(400, "invalid_request", `unknown field: extract.${extraExtract}`);
	const extract = {
		markdown: boolField(e.markdown, true, "extract.markdown"),
		text: boolField(e.text, true, "extract.text"),
		html: boolField(e.html, false, "extract.html"),
		raw_html: boolField(e.raw_html, false, "extract.raw_html"),
		links: boolField(e.links, true, "extract.links"),
		adapter: enumField(e.adapter, ADAPTERS, "auto", "extract.adapter"),
	};
	return { kind, url: body.url, session, wait, extract };
}

/**
 * What a route hands back for a tool call: the tool's own verdict (isError)
 * inside a transport-level success.
 * @param {import("./fetchsvc.js").ToolResult} r
 * @returns {Record<string, unknown>}
 */
function toolAnswer(r) {
	return { ok: true, isError: r.isError, text: r.text, outcome: r.outcome, page: r.page };
}

/**
 * Build the request listener. Every request passes the same gate before any
 * route code runs:
 *   1. Host is exactly 127.0.0.1:<port> (DNS rebinding).
 *   2. No Origin and no Sec-Fetch-Site header (anything sent by a web page).
 *   3. Known path, no query string, right method.
 *   4. Bearer token in the Authorization header (all routes but /healthz and
 *      /v1/prove): the agent token for the agent routes and /mcp, the admin
 *      token for pairing, raw jobs and unrendered page content. A valid token of the other kind is
 *      refused with 403, so neither credential ever carries the other's
 *      rights. /v1/status takes either and answers each differently.
 *   5. POST only: application/json, within the size limit; a JSON object
 *      everywhere but on /mcp, whose handler answers malformed bodies itself.
 *
 * Routes:
 *   GET  /healthz           open    name and version
 *   POST /v1/prove          open    the daemon proves that it holds a token, on this port
 *   GET  /v1/status         either  agent: booleans and counts; admin: details
 *   POST /v1/fetch          agent   fetch a page, rendered tool result
 *   POST /v1/pages/read     agent   continue a stored page
 *   POST /v1/pages/search   agent   search stored pages
 *   POST /v1/files/export   agent   a part of the bytes of a retrieved file, as base64 (for a file; not an MCP tool
 *                                   of the daemon: file_export of "bgw mcp" writes them to a file and returns the path)
 *   POST /v1/search         agent   search the web through the browser, rendered tool result
 *   *    /mcp               agent   MCP endpoint (POST; GET and DELETE answer 405)
 *   POST /v1/pair/start     admin   mint a pairing code
 *   POST /v1/attention      admin   ask the extension to bring the page of a pending challenge to the operator
 *   POST /v1/pages/export   admin   the stored content of a page as it is, unrendered (for a file; not an MCP tool)
 *   POST /v1/jobs           admin   raw job, raw result: unsanitised page data
 * @param {HttpDeps} deps
 * @returns {(req: Req, res: Res) => void}
 */
export function createHttpHandler(deps) {
	const { pkg, getPort, secrets, queue, fetchsvc, mcp, status, audit, log, throttle, policy } = deps;

	/** @type {Map<string, Route>} */
	const routes = new Map();

	routes.set("/healthz", {
		method: "GET",
		auth: "none",
		handler: () => ({ ok: true, name: pkg.name, version: pkg.version }),
	});

	// Open on purpose: its caller holds a token and wants to know, before
	// sending it, whether this process holds it too. Every well-formed request
	// costs one HMAC and gets an answer of the same shape; a wrong guess of the
	// token learns nothing from a MAC it cannot check.
	routes.set("/v1/prove", {
		method: "POST",
		auth: "none",
		maxBodyBytes: 1024,
		handler: ({ body }) => {
			const extra = extraKey(body, ["role", "nonce"]);
			if (extra !== null) throw new HttpError(400, "invalid_request", `unknown field: ${extra}`);
			const role = body.role;
			if (role !== "client" && role !== "admin") throw new HttpError(400, "invalid_request", "role must be client or admin");
			if (!isProofNonce(body.nonce)) throw new HttpError(400, "invalid_request", "nonce must be base64url of 16 to 64 bytes");
			return { ok: true, mac: secrets.prove(role, getPort(), body.nonce) };
		},
	});

	routes.set("/v1/status", {
		method: "GET",
		auth: "either",
		// The agent gets booleans and counts. Host lists, the pause reason and
		// versions of the operator's browser are for the operator.
		handler: ({ role }) => (role === "admin" ? status.admin() : status.agent()),
	});

	routes.set("/v1/pair/start", {
		method: "POST",
		auth: "admin",
		maxBodyBytes: 1024,
		handler: ({ body }) => {
			const extra = extraKey(body, ["nonce"]);
			if (extra !== null) throw new HttpError(400, "invalid_request", `unknown field: ${extra}`);
			if (!isProofNonce(body.nonce)) throw new HttpError(400, "invalid_request", "nonce must be base64url of 16 to 64 bytes");
			const { code, expiresInS } = secrets.startPairing(getPort());
			// The MAC lets the caller tell this code from one a port squatter made up.
			return { ok: true, code, expires_in_s: expiresInS, mac: secrets.pairProof(getPort(), body.nonce, code) };
		},
	});

	// What a click on "Open" in the desktop notification does, for the command
	// line ("bgw open <job>"). The operator's token only: this makes a window
	// come up on their desktop.
	routes.set("/v1/attention", {
		method: "POST",
		auth: "admin",
		maxBodyBytes: 1024,
		handler: ({ body }) => {
			const extra = extraKey(body, ["job"]);
			if (extra !== null) throw new HttpError(400, "invalid_request", `unknown field: ${extra}`);
			if (typeof body.job !== "string" || !/^j_[0-9A-Za-z_-]{1,64}$/.test(body.job)) throw new HttpError(400, "invalid_request", "job must be a job id");
			// false: no such job waits (any more), or the extension is not connected.
			return { ok: true, sent: queue.attention(body.job, "focus") };
		},
	});

	routes.set("/v1/fetch", {
		method: "POST",
		auth: "client",
		handler: async ({ body, onClientGone }) => toolAnswer(await fetchsvc.fetchPage(body, { onClientGone })),
	});

	routes.set("/v1/pages/read", {
		method: "POST",
		auth: "client",
		handler: ({ body }) => toolAnswer(fetchsvc.readPage(body)),
	});

	routes.set("/v1/pages/search", {
		method: "POST",
		auth: "client",
		handler: ({ body }) => toolAnswer(fetchsvc.searchPages(body)),
	});

	// Unrendered page content: no delimiters, no sanitising. For the operator at
	// the command line (bgw export writes a file) and for nobody else: it takes
	// the admin token only, like the raw job route, so that the token an agent
	// holds never reads page text without its markers. There is no MCP tool for it.
	routes.set("/v1/pages/export", {
		method: "POST",
		auth: "admin",
		maxBodyBytes: 1024,
		handler: ({ body }) => {
			const r = fetchsvc.exportPage(body);
			if (!r.ok) throw new HttpError(r.status, r.result.code ?? "export_failed", r.result.text);
			return { ok: true, page: r.page, format: r.format, encoding: r.encoding, content: r.content };
		},
	});

	// The bytes of a retrieved file, a few megabytes per call, exactly as they came: no delimiters, no sanitising.
	// This one takes the agent token, because it is the agent's side that writes them to a file - the command
	// line, or the file_export tool of the stdio helper, which returns a path and never the bytes. So whoever
	// holds the agent token can read the bytes of every stored file with a plain request to this route; what
	// keeps them out of a model's context is that no MCP tool returns them, not this gate. The daemon itself
	// writes nowhere an agent names.
	routes.set("/v1/files/export", {
		method: "POST",
		auth: "client",
		maxBodyBytes: 1024,
		handler: ({ body }) => {
			const r = fetchsvc.exportFile(body);
			if (!r.ok) throw new HttpError(r.status, r.result.code ?? "export_failed", r.result.text);
			return { ...r };
		},
	});

	routes.set("/v1/search", {
		method: "POST",
		auth: "client",
		maxBodyBytes: 8192,
		handler: async ({ body, onClientGone }) => toolAnswer(await fetchsvc.searchWeb(body, { onClientGone })),
	});

	// The result of this route is what the extension sent: page text without
	// delimiters or sanitising. It is a debugging tool for the operator and
	// takes the admin token only; agents get rendered text from
	// /v1/fetch and /mcp.
	routes.set("/v1/jobs", {
		method: "POST",
		auth: "admin",
		handler: async ({ body, onClientGone }) => {
			// No audit trail, no jobs.
			if (!audit.ok) throw new HttpError(503, "audit_unavailable");
			const request = parseJobRequest(body);
			const verdict = checkUrl(request.url, policy);
			if (!verdict.allowed) {
				const job = newJobId();
				const asked = request.url.slice(0, 2048);
				audit.append({
					job,
					kind: request.kind,
					url: asked,
					host: null,
					outcome: "policy_blocked",
					code: verdict.reason,
					cookie_scope: null,
					dispatched: false,
					duration_ms: 0,
					redirect_origins: [],
				});
				log.info("job.done", { job, outcome: "policy_blocked", code: verdict.reason });
				return {
					ok: true,
					result: synthReport(job, asked, "policy_blocked", {
						code: verdict.reason,
						message: "the URL is not allowed by the gateway policy",
						retryable: false,
						retry_after_s: null,
					}),
				};
			}
			const { wait, extract } = request;
			const handle = queue.submit({
				...request,
				url: verdict.url,
				host: verdict.host,
				// Where the page ends is held to the policy its address passed.
				policy,
				dedupeKey: JSON.stringify([
					request.kind,
					verdict.url,
					request.session,
					[wait.timeout_ms, wait.settle_ms, wait.dwell_ms, wait.human_wait_ms, wait.scroll],
					[extract.markdown, extract.text, extract.html, extract.raw_html, extract.links, extract.adapter],
				]),
			});
			onClientGone(() => handle.release());
			return { ok: true, result: await handle.promise };
		},
	});

	/**
	 * @param {Req} req
	 * @returns {Role | null} the role of the presented token
	 */
	function authenticate(req) {
		const header = singleHeader(req, "authorization");
		const m = typeof header === "string" ? /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header) : null;
		const role = m === null ? null : secrets.tokenRole(m[1]);
		if (role === null) throw new HttpError(401, "unauthorized", undefined, { "www-authenticate": "Bearer" });
		return role;
	}

	/**
	 * The MCP endpoint. Same gate as every route, then the handler decides:
	 * it answers GET and DELETE with 405, and a body that is not JSON, or is a
	 * JSON array, with the JSON-RPC error its clients expect.
	 * @param {Req} req
	 * @param {Res} res
	 */
	async function handleMcp(req, res) {
		const method = req.method ?? "";
		if (!MCP_METHODS.includes(method)) throw new HttpError(405, "method_not_allowed", undefined, { allow: "POST" });
		if (authenticate(req) !== "client") throw new HttpError(403, "forbidden", "wrong_token_for_route");
		/** @type {unknown} */
		let body;
		if (method === "POST") {
			const raw = await readJsonBody(req, LIMITS.maxBodyBytes);
			try {
				body = decodeJson(raw);
			} catch {
				body = BODY_PARSE_ERROR;
			}
		}
		// A caller that hangs up while a tool call waits for the browser no longer holds its job.
		/** @type {(() => void)[]} */
		const goneHandlers = [];
		res.on("close", () => {
			if (!res.writableFinished) for (const fn of goneHandlers) fn();
		});
		// Every header line on its own: a header that was sent twice is seen as that, not as one joined value.
		const answer = await mcp.handle({ method, headers: req.headersDistinct, body, onClientGone: (fn) => goneHandlers.push(fn) });
		send(res, answer.status, answer.body, answer.headers);
	}

	/**
	 * @param {Req} req
	 * @param {Res} res
	 */
	async function handle(req, res) {
		if (singleHeader(req, "host") !== `127.0.0.1:${getPort()}`) throw new HttpError(403, "forbidden", "host");
		if (req.headersDistinct.origin !== undefined || req.headersDistinct["sec-fetch-site"] !== undefined) {
			throw new HttpError(403, "forbidden", "browser_request");
		}

		const target = req.url ?? "";
		if (!target.startsWith("/")) throw new HttpError(400, "bad_request", "request target");
		// Nothing takes parameters in the URL, least of all a token.
		if (target.includes("?")) throw new HttpError(400, "query_not_allowed");
		if (target === MCP_PATH) return handleMcp(req, res);
		const route = routes.get(target);
		if (route === undefined) throw new HttpError(404, "not_found");
		if (req.method !== route.method) throw new HttpError(405, "method_not_allowed", undefined, { allow: route.method });

		/** @type {Role | null} */
		let role = null;
		if (route.auth !== "none") {
			role = authenticate(req);
			if (route.auth !== "either" && role !== route.auth) throw new HttpError(403, "forbidden", "wrong_token_for_route");
		}

		/** @type {Record<string, unknown>} */
		let body = {};
		if (route.method === "POST") {
			const raw = await readJsonBody(req, route.maxBodyBytes ?? LIMITS.maxBodyBytes);
			/** @type {unknown} */
			let parsed;
			try {
				parsed = decodeJson(raw);
			} catch {
				throw new HttpError(400, "invalid_json");
			}
			if (!isPlainObject(parsed)) throw new HttpError(400, "invalid_json", "expected a JSON object");
			body = parsed;
		}

		/** @type {(() => void)[]} */
		const goneHandlers = [];
		res.on("close", () => {
			if (!res.writableFinished) for (const fn of goneHandlers) fn();
		});
		const result = await route.handler({ body, role, onClientGone: (fn) => goneHandlers.push(fn) });
		send(res, 200, result);
	}

	return (req, res) => {
		handle(req, res).catch((err) => {
			if (err instanceof HttpError) {
				if (err.status === 401 || err.status === 403) {
					// Any local process, and any web page through a blind request,
					// can cause these: a few are written, the rest counted.
					const reason = err.detail ?? err.code;
					throttle.warn("http.refused", { status: err.status, reason }, `${err.status} ${reason}`);
				}
				send(res, err.status, { ok: false, error: err.code, ...(err.detail ? { detail: err.detail } : {}) }, err.headers);
				return;
			}
			log.error("http.handler_failed", { message: err instanceof Error ? err.message : "unknown" });
			send(res, 500, { ok: false, error: "internal_error" });
		});
	};
}
