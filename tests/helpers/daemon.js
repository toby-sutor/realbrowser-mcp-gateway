import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../../daemon/src/server.js";
import { createLogger } from "../../daemon/src/log.js";
import { makeTempDir, removeTempDir } from "./tmp.js";
import { makeDesktopFake } from "./fake-spawn.js";

/**
 * @typedef {object} Response
 * @property {number} status
 * @property {import("node:http").IncomingHttpHeaders} headers
 * @property {string} text
 * @property {any} json parsed body, or null when it is not JSON
 */

/**
 * @typedef {object} RequestOptions
 * @property {Record<string, string | string[]>} [headers] merged over the defaults; a default is dropped with ""
 * @property {unknown} [body] sent as JSON
 * @property {string | Buffer} [rawBody] sent as is (instead of body)
 * @property {boolean | "admin"} [auth] true (default): the agent token; "admin": the admin token; false: none
 * @property {AbortSignal} [signal]
 */

/** Gaps of zero, so tests that are not about pacing never wait. */
export const NO_PACING = Object.freeze({
	polite: Object.freeze({ hostGapMs: /** @type {const} */ ([0, 0]), globalGapMs: /** @type {const} */ ([0, 0]), dwellMs: /** @type {const} */ ([0, 0]) }),
	fast: Object.freeze({ hostGapMs: /** @type {const} */ ([0, 0]), globalGapMs: /** @type {const} */ ([0, 0]), dwellMs: /** @type {const} */ ([0, 0]) }),
});

/**
 * Start a daemon on an ephemeral port with its own temp directories and an
 * in-memory log. stop() closes it and removes the directories.
 *
 * The daemon never gets the real spawn: what it would start for a
 * notification (the helper, a sound, the operator's hook) is a stand-in that
 * the test can look at through "desktop". Nothing of a test reaches the
 * operator's desktop. A test that passes its own spawn takes that over.
 * @param {Partial<import("../../daemon/src/server.js").StartOptions>} [opts]
 */
export async function startTestDaemon(opts = {}) {
	const dir = makeTempDir("daemon");
	const configDir = opts.configDir ?? path.join(dir, "config");
	const dataDir = opts.dataDir ?? path.join(dir, "data");
	/** @type {string[]} */
	const logs = [];
	const log = createLogger((line) => logs.push(line), () => (opts.clock ? opts.clock.now() : Date.now()));
	const desktop = makeDesktopFake();
	// A pending challenge is notified at once here; the tests of the delay ask for one (challengeDelayMs).
	const daemon = await start({ port: 0, rng: () => 0.5, pacing: NO_PACING, log, spawn: desktop.spawn, challengeDelayMs: 0, ...opts, configDir, dataDir });
	const token = fs.readFileSync(path.join(configDir, "client.token"), "utf8").trim();
	const adminToken = fs.readFileSync(path.join(configDir, "admin.token"), "utf8").trim();

	/**
	 * @param {string} method
	 * @param {string} target
	 * @param {RequestOptions} [ro]
	 * @returns {Promise<Response>}
	 */
	function request(method, target, ro = {}) {
		/** @type {Record<string, string | string[]>} */
		const headers = {};
		if (ro.auth !== false) headers.authorization = `Bearer ${ro.auth === "admin" ? adminToken : token}`;
		/** @type {string | Buffer | undefined} */
		let payload = ro.rawBody;
		if (ro.body !== undefined) payload = JSON.stringify(ro.body);
		if (payload !== undefined) headers["content-type"] = "application/json";
		for (const [name, value] of Object.entries(ro.headers ?? {})) {
			if (value === "") delete headers[name.toLowerCase()];
			else headers[name.toLowerCase()] = value;
		}
		return new Promise((resolve, reject) => {
			const req = http.request(
				{ host: "127.0.0.1", port: daemon.port, method, path: target, headers, agent: false, signal: ro.signal },
				(res) => {
					let text = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => (text += chunk));
					res.on("end", () => {
						/** @type {any} */
						let json = null;
						try {
							json = JSON.parse(text);
						} catch {
							// left as null
						}
						resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
					});
				},
			);
			req.on("error", reject);
			req.end(payload);
		});
	}

	return {
		...daemon,
		dir,
		token,
		adminToken,
		logs,
		/** What the daemon started for its notifications: stand-ins, see fake-spawn.js. */
		desktop,
		request,
		/** @returns {Promise<any>} the operator's view of the status (admin token): extension details and state */
		status: async () => (await request("GET", "/v1/status", { auth: "admin" })).json,
		/** @returns {Promise<any>} what an agent is told (agent token): booleans and counts */
		agentStatus: async () => (await request("GET", "/v1/status")).json,
		/** @returns {Promise<string>} a fresh one-time pairing code, minted with the admin token */
		pairCode: async () => (await request("POST", "/v1/pair/start", { auth: "admin", body: { nonce: crypto.randomBytes(32).toString("base64url") } })).json.code,
		/**
		 * Submit a raw job. The route takes the admin token only, so that
		 * is the default here.
		 * @param {Record<string, unknown>} job
		 * @param {RequestOptions} [ro]
		 */
		submitJob: (job, ro = {}) => request("POST", "/v1/jobs", { auth: "admin", ...ro, body: job }),
		/**
		 * Call one of the agent routes that answer with a rendered tool result.
		 * @param {"/v1/fetch" | "/v1/pages/read" | "/v1/pages/search"} route
		 * @param {Record<string, unknown>} args
		 * @param {RequestOptions} [ro]
		 */
		tool: (route, args, ro = {}) => request("POST", route, { ...ro, body: args }),
		/**
		 * The stored content of a page, unrendered. The route takes the admin token only, so that is the default here.
		 * @param {Record<string, unknown>} args
		 * @param {RequestOptions} [ro]
		 */
		exportPage: (args, ro = {}) => request("POST", "/v1/pages/export", { auth: "admin", ...ro, body: args }),
		/** @returns {any[]} audit log entries */
		auditEntries: () => {
			const file = path.join(dataDir, "audit.jsonl");
			if (!fs.existsSync(file)) return [];
			return fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line));
		},
		stop: async () => {
			await daemon.close();
			removeTempDir(dir);
		},
	};
}

/**
 * Poll until the condition holds. For state that changes on real I/O.
 * @param {() => boolean | Promise<boolean>} condition
 * @param {{ timeoutMs?: number, what?: string }} [opts]
 */
export async function until(condition, opts = {}) {
	const deadline = Date.now() + (opts.timeoutMs ?? 3000);
	for (;;) {
		if (await condition()) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.what ?? "condition"}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
