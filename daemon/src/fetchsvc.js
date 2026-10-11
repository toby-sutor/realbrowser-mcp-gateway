import crypto from "node:crypto";
import { checkUrl } from "../../extension/shared/policy.js";
import { DETECT_RESOLUTIONS, ERROR_CODE } from "../../extension/shared/protocol.js";
import { JOB_WAIT_MAX, LIMITS } from "./config.js";
import { cleanExtraction, isFullMeta, isValidFileId, isValidPageId, SEARCH_LIMITS, StoreError } from "./store.js";
import { FILE_LIMITS } from "./files.js";
import { FILE_CODE } from "../../extension/shared/sniff.js";
import { FORMATS, RENDER_LIMITS, preparedBody, renderFailure, renderFile, renderPage, renderSearchHits, renderToolError, renderWebSearch } from "./render.js";
import { WEB_SEARCH_LIMITS, buildSearchUrl, makeEngines } from "./search.js";

/**
 * @typedef {import("../../extension/shared/protocol.js").JobResultBody} JobResultBody
 * @typedef {import("./render.js").Format} Format
 * @typedef {import("./render.js").PageView} PageView
 * @typedef {import("./store.js").PageStore} PageStore
 * @typedef {import("./store.js").PageMeta} PageMeta
 * @typedef {import("./store.js").BareMeta} BareMeta
 * @typedef {import("./store.js").FileMeta} FileMeta
 * @typedef {import("./audit.js").AuditEntry} AuditEntry
 * @typedef {import("./queue.js").JobSpec} JobSpec
 * @typedef {import("./log.js").Clock} Clock
 * @typedef {import("./log.js").Logger} Logger
 */

/**
 * What a route or MCP tool returns to the agent.
 * @typedef {object} ToolResult
 * @property {boolean} isError
 * @property {string} text
 * @property {string} outcome ok, or the job outcome, or "error" for tool-level errors
 * @property {string | null} page the page id when one was stored or served
 * @property {string | null} code error or policy reason code
 */

export const FETCH_LIMITS = Object.freeze({
	cacheTtlMs: 600000,
	// Longest a caller is held while its page waits for the operator.
	maxWaitForHumanS: 120,
	// The page-load limit of a job unless the operator sets another (fetch.load_timeout_s).
	jobTimeoutMs: 30000,
	settleMs: 1500,
	// How long a page with a human check is kept open for the operator. The
	// caller is answered long before that (wait_for_human_s); the page, once
	// cleared, is stored for the next fetch of its URL.
	parkMs: LIMITS.challengeTtlMs,
});

/**
 * @typedef {object} FetchServiceOptions
 * @property {number} [cacheTtlMs] default 10 minutes
 * @property {{ blocklist?: readonly string[], allowLoopbackPorts?: readonly number[] }} [policy] passed to checkUrl
 * @property {(n: number) => Uint8Array} [randomBytes] nonce source
 * @property {number} [parkMs] how long a challenge page waits for the operator, default 15 minutes
 * @property {number} [loadTimeoutMs] how long a page may take to load, default 30 seconds (fetch.load_timeout_s)
 * @property {ReturnType<typeof makeEngines>} [engines] the search engines; the built-in ones when absent
 * @property {{ maxBytes: number, allowTypes: readonly string[] } | null} [files] what a fetch may bring back when its
 *   response is a file: how large, and of which types (files.max_mb, files.allow_types). Absent or null: no file
 */

/**
 * @typedef {Pick<PageStore, "save" | "getMeta" | "readBody" | "readLinks" | "findFresh" | "search"> &
 *   Partial<Pick<PageStore, "saveFile" | "getFileMeta" | "readFileText" | "readFileChunk" | "findFreshFile" | "holdFile" | "holdPage">>} StoreLike
 *   the file methods are absent in a store that keeps pages only: no file is stored or served then
 */

/**
 * What a caller can tell the service about itself.
 * @typedef {object} CallContext
 * @property {(fn: () => void) => void} [onClientGone] register a function to run when the caller stops waiting
 *
 * What the service hands to submitJob on top of that.
 * @typedef {CallContext & { onParked: (info: import("./queue.js").ParkedInfo, stopWaiting: () => void) => void }} SubmitContext
 *   onParked: the job was parked for the operator and its report follows whenever it ends. stopWaiting says that
 *   this caller is answered and no longer waits for the report (the job lives on)
 */

/**
 * How many sanitised bodies are kept in memory for the next call. Sanitising looks at a whole body, and a
 * reader takes a large page or file in many pieces: without this every piece would pay for all of it again.
 * Two, so that a reader who goes back and forth between two texts is served as well. Each is at most the
 * largest body the gateway handles, a few megabytes.
 */
const KEPT_BODIES = 2;

/** The formats that export knows: stored content, so no "links". */
export const EXPORT_FORMATS = Object.freeze(/** @type {const} */ (["markdown", "text", "html", "raw_html"]));
/** @typedef {typeof EXPORT_FORMATS[number]} ExportFormat */

const AUDIT_DOWN = "The audit log cannot be written (a full disk is the usual reason), so the gateway refuses work until it can be written again. Tell the user.";

/**
 * @typedef {object} ArgSpec
 * @property {"string" | "boolean" | "int" | "enum"} type
 * @property {number} [min]
 * @property {number} [max]
 * @property {readonly string[]} [values]
 * @property {unknown} [fallback]
 * @property {boolean} [required]
 */

/**
 * Strict argument check: plain object, known names only, exact types.
 * @param {unknown} args
 * @param {Record<string, ArgSpec>} spec
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, message: string }}
 */
function validate(args, spec) {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return { ok: false, message: "Arguments must be an object." };
	for (const key of Object.keys(args)) {
		if (!Object.hasOwn(spec, key)) return { ok: false, message: `Unknown argument: ${key}.` };
	}
	const input = /** @type {Record<string, unknown>} */ (args);
	/** @type {Record<string, unknown>} */
	const value = {};
	for (const [name, s] of Object.entries(spec)) {
		const v = Object.hasOwn(input, name) ? input[name] : undefined;
		if (v === undefined) {
			if (s.required === true) return { ok: false, message: `Missing argument: ${name}.` };
			value[name] = s.fallback;
			continue;
		}
		switch (s.type) {
			case "string":
				if (typeof v !== "string" || v.length < (s.min ?? 0) || v.length > (s.max ?? Infinity)) {
					return { ok: false, message: `${name} must be a string of ${s.min ?? 0} to ${s.max} characters.` };
				}
				break;
			case "boolean":
				if (typeof v !== "boolean") return { ok: false, message: `${name} must be true or false.` };
				break;
			case "int":
				if (typeof v !== "number" || !Number.isSafeInteger(v) || v < (s.min ?? -Infinity) || v > (s.max ?? Infinity)) {
					return { ok: false, message: `${name} must be an integer from ${s.min} to ${s.max}.` };
				}
				break;
			case "enum":
				if (typeof v !== "string" || !(s.values ?? []).includes(v)) {
					return { ok: false, message: `${name} must be one of: ${(s.values ?? []).join(", ")}.` };
				}
				break;
		}
		value[name] = v;
	}
	return { ok: true, value };
}

/** @param {string} code @param {string} message @returns {ToolResult} */
function toolError(code, message) {
	return { isError: true, text: renderToolError(code, message), outcome: "error", page: null, code };
}

/**
 * @param {{ markdown: boolean, html: boolean, text?: boolean, raw_html?: boolean }} t
 * @param {Format} format
 * @param {string | null} [view] which view the Markdown is
 * @returns {boolean}
 */
function truncatedFor(t, format, view = null) {
	if (format === "html") return t.html;
	if (format === "raw_html") return t.raw_html === true;
	if (format === "markdown") return t.markdown;
	// Where the Markdown is the visible text, its flag is the text's.
	if (format === "text") return view === "text" ? t.markdown : t.text === true;
	return false;
}

/**
 * What a result says about a challenge that stood in the way and went away.
 * @param {import("./queue.js").JobReport["detect"]} detect
 * @returns {import("./render.js").PageView["cleared"]}
 */
function clearedChallenge(detect) {
	if (detect === null || typeof detect !== "object") return null;
	const how = DETECT_RESOLUTIONS.find((r) => r === detect.resolved);
	return how === undefined ? null : { kind: detect.kind, how, waited_ms: detect.waited_ms };
}

/**
 * Fetch, read and search, built from injected parts so it knows nothing of the
 * HTTP layer or the queue.
 *
 * Audit: every call leaves one entry. A call that becomes a browser job (or
 * joins one in flight) is recorded by whoever runs the job - submitJob's side.
 * Every other call (bad arguments, policy refusal, cache hit, read, search) is
 * recorded here.
 */
export class FetchService {
	#store;
	#submitJob;
	#clock;
	#log;
	#audit;
	#cacheTtlMs;
	#parkMs;
	#loadTimeoutMs;
	#policy;
	#randomBytes;
	#engines;
	/** @type {{ max_bytes: number, types: string[] } | null} */
	#files;
	/** @type {WeakMap<object, PageMeta | BareMeta>} what a job report was saved as */
	#saved = new WeakMap();
	/** @type {WeakMap<object, FileMeta | "full" | "refused" | null>} the same for a report that brought a file; null: it could not be kept; "full": the store had no room for it; "refused": with all of it at hand it is of a kind that is never kept */
	#savedFiles = new WeakMap();
	/** @type {Map<string, import("./render.js").PreparedBody>} the sanitised bodies of what was read last, by id and format; the oldest first */
	#bodies = new Map();

	/**
	 * @param {object} deps
	 * @param {StoreLike} deps.store
	 * @param {(spec: JobSpec, ctx: SubmitContext) => Promise<import("./queue.js").JobReport>} deps.submitJob resolves with the job
	 *   report; a rejection is treated as a failed submit. A job that is parked for the operator is announced through
	 *   ctx.onParked, long before its report
	 * @param {Clock} deps.clock
	 * @param {Logger} deps.log
	 * @param {{ append(entry: AuditEntry): void, readonly ok?: boolean }} [deps.audit] ok false: nothing is fetched, read or searched
	 * @param {FetchServiceOptions} [deps.options]
	 */
	constructor({ store, submitJob, clock, log, audit, options = {} }) {
		this.#store = store;
		this.#submitJob = submitJob;
		this.#clock = clock;
		this.#log = log;
		this.#audit = audit ?? { append: () => {} };
		this.#cacheTtlMs = options.cacheTtlMs ?? FETCH_LIMITS.cacheTtlMs;
		this.#parkMs = options.parkMs ?? FETCH_LIMITS.parkMs;
		this.#loadTimeoutMs = Math.min(Math.max(options.loadTimeoutMs ?? FETCH_LIMITS.jobTimeoutMs, 1000), JOB_WAIT_MAX.timeout_ms);
		this.#policy = options.policy ?? {};
		this.#randomBytes = options.randomBytes ?? crypto.randomBytes;
		this.#engines = options.engines ?? makeEngines();
		const files = options.files ?? null;
		this.#files = files === null || typeof store.saveFile !== "function" ? null : { max_bytes: files.maxBytes, types: [...files.allowTypes] };
	}

	/** @returns {{ names: string[], fallback: string }} the search engines a caller can name, and the one used when none is named */
	get engines() {
		return { names: [...this.#engines.names], fallback: this.#engines.fallback };
	}

	/**
	 * Search the web: load an engine's results page for the query in the
	 * browser and hand back what it lists. A job like any other - policy,
	 * pacing, cooldown, human checks - except that it always runs in the
	 * gateway container and that nothing of it is stored.
	 * @param {unknown} args query, engine, limit
	 * @param {CallContext} [ctx]
	 * @returns {Promise<ToolResult>}
	 */
	async searchWeb(args, ctx = {}) {
		if (this.#audit.ok === false) return toolError("audit_unavailable", AUDIT_DOWN);
		const v = validate(args, {
			query: { type: "string", required: true, min: 1, max: WEB_SEARCH_LIMITS.maxQueryChars },
			engine: { type: "enum", values: this.#engines.names, fallback: this.#engines.fallback },
			limit: { type: "int", min: 1, max: WEB_SEARCH_LIMITS.maxResults, fallback: WEB_SEARCH_LIMITS.defaultResults },
		});
		const startedAt = this.#clock.now();
		if (!v.ok) return this.#record("search", toolError("invalid_argument", v.message), startedAt);
		const query = /** @type {string} */ (v.value.query).trim();
		const engine = /** @type {string} */ (v.value.engine);
		const limit = /** @type {number} */ (v.value.limit);
		const template = this.#engines.template(engine);
		const url = template === null || !/[\p{L}\p{N}]/u.test(query) ? null : buildSearchUrl(template, query);
		if (url === null) return this.#record("search", toolError("invalid_argument", "query must hold something to search for."), startedAt);
		// The engine's address is the daemon's or the operator's own, but it is checked like every URL all the same.
		const verdict = checkUrl(url, this.#policy);
		if (!verdict.allowed) {
			this.#log.info("search.policy_blocked", { code: verdict.reason });
			return this.#record("search", this.#failure("policy_blocked", null, url, { code: verdict.reason, message: "", retryable: false, retry_after_s: null }), startedAt, { url });
		}
		/** @type {JobSpec} */
		const spec = {
			kind: "search",
			url: verdict.url,
			host: verdict.host,
			search: { engine, limit },
			// Never the operator's login, whatever rules they have set.
			session: "isolated",
			wait: { timeout_ms: this.#loadTimeoutMs, settle_ms: FETCH_LIMITS.settleMs, dwell_ms: null, human_wait_ms: this.#parkMs, scroll: "none" },
			extract: { markdown: false, text: true, html: false, raw_html: false, links: true, adapter: "auto" },
			dedupeKey: "",
			// Where the results page ends is held to the policy its address passed.
			policy: this.#policy,
		};
		// Identical searches that are in flight at the same time share one page load. Nothing outlives that.
		spec.dedupeKey = JSON.stringify(["search", spec.url, engine, limit, spec.wait.human_wait_ms]);

		/** @type {{ info: import("./queue.js").ParkedInfo, stopWaiting: () => void } | null} */
		let parked = null;
		/** @type {(p: "parked") => void} */
		let wake = () => {};
		/** @type {Promise<"parked">} */
		const onParked = new Promise((resolve) => {
			wake = resolve;
		});
		/** @type {import("./queue.js").JobReport | "parked"} */
		let first;
		try {
			first = await Promise.race([
				this.#submitJob(spec, {
					...ctx,
					onParked: (info, stopWaiting) => {
						if (parked !== null) return;
						parked = { info, stopWaiting };
						wake("parked");
					},
				}),
				onParked,
			]);
		} catch (err) {
			this.#log.error("search.submit_failed", { message: err instanceof Error ? err.message : "unknown" });
			return this.#record("search", this.#failure("error", null, spec.url, null, { code: "submit_failed", message: "", retryable: true, retry_after_s: null }), startedAt, { url: spec.url, host: spec.host });
		}
		// The results page shows a human check and waits for the operator. Once they have passed it the
		// container holds the engine's clearance: the caller searches again.
		if (first === "parked") return this.#needsHuman(/** @type {NonNullable<typeof parked>} */ (/** @type {unknown} */ (parked)), spec.url, true);
		const report = first;
		if (report.outcome !== "ok") return this.#failure(report.outcome, report, spec.url, report.error, null, true);
		if (report.cookie_scope !== "container") {
			this.#log.warn("search.scope_violation", { job: report.job });
			return this.#failure("error", report, spec.url, null, { code: ERROR_CODE.SCOPE_VIOLATION, message: "", retryable: false, retry_after_s: null });
		}
		const content = report.content;
		if (content === null) return this.#failure("error", report, spec.url, null, { code: "no_content", message: "", retryable: true, retry_after_s: null });
		const results = content.results.slice(0, limit);
		const text = renderWebSearch(
			{
				engine,
				query,
				requested_url: spec.url,
				final_url: report.nav.final_url,
				fetched_at: new Date(this.#clock.now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
				http_status: report.nav.http_status,
				cookie_scope: report.cookie_scope,
				detector: report.page?.extractor ?? null,
				results,
				// The extension says whether it found a list; a caller who asked for one result got one of a list.
				fallback: report.page?.extractor === "search-fallback",
				text: content.text,
				links: content.links,
				maxTextChars: WEB_SEARCH_LIMITS.fallbackTextChars,
				maxLinks: WEB_SEARCH_LIMITS.fallbackLinks,
			},
			this.#randomBytes,
		);
		this.#log.info("search.done", { job: report.job, engine, results: results.length });
		return { isError: false, text, outcome: "ok", page: null, code: null };
	}

	/**
	 * Record a call that did not become a browser job.
	 * @param {"fetch" | "read" | "search" | "export"} kind
	 * @param {ToolResult} result
	 * @param {number} startedAt
	 * @param {Partial<AuditEntry>} [more]
	 * @returns {ToolResult} the result, for returning in one step
	 */
	#record(kind, result, startedAt, more = {}) {
		if (this.#audit.ok === false) return result;
		this.#audit.append({
			job: null,
			kind,
			url: null,
			host: null,
			outcome: result.outcome,
			code: result.code,
			cookie_scope: null,
			dispatched: false,
			duration_ms: this.#clock.now() - startedAt,
			...more,
		});
		return result;
	}

	/**
	 * @param {unknown} args url, format, max_chars, fresh, session, wait_for_human_s
	 * @param {CallContext} [ctx]
	 * @returns {Promise<ToolResult>}
	 */
	async fetchPage(args, ctx = {}) {
		// No audit trail, no work.
		if (this.#audit.ok === false) return toolError("audit_unavailable", AUDIT_DOWN);
		const v = validate(args, {
			url: { type: "string", required: true, min: 1, max: 8192 },
			format: { type: "enum", values: FORMATS, fallback: "markdown" },
			max_chars: { type: "int", min: RENDER_LIMITS.minMaxChars, max: RENDER_LIMITS.hardMaxChars, fallback: RENDER_LIMITS.defaultMaxChars },
			fresh: { type: "boolean", fallback: false },
			session: { type: "enum", values: ["auto", "isolated"], fallback: "auto" },
			wait_for_human_s: { type: "int", min: 0, max: FETCH_LIMITS.maxWaitForHumanS, fallback: 0 },
		});
		const startedAt = this.#clock.now();
		if (!v.ok) return this.#record("fetch", toolError("invalid_argument", v.message), startedAt);
		const a = v.value;
		const format = /** @type {Format} */ (a.format);
		const maxChars = /** @type {number} */ (a.max_chars);
		const session = /** @type {"auto" | "isolated"} */ (a.session);

		const verdict = checkUrl(a.url, this.#policy);
		if (!verdict.allowed) {
			this.#log.info("fetch.policy_blocked", { code: verdict.reason });
			return this.#record(
				"fetch",
				{
					isError: true,
					text: renderFailure(
						{
							outcome: "policy_blocked",
							job: null,
							cookie_scope: null,
							http_status: null,
							requested_url: String(a.url).slice(0, RENDER_LIMITS.url),
							detect: null,
							error: { code: verdict.reason, message: "", retryable: false, retry_after_s: null },
						},
						this.#randomBytes,
					),
					outcome: "policy_blocked",
					page: null,
					code: verdict.reason,
				},
				startedAt,
				{ url: String(a.url) },
			);
		}

		// A cache lifetime of zero means no cache, not "pages of this very millisecond".
		if (a.fresh !== true && this.#cacheTtlMs > 0) {
			const hit = this.#serveFromCache(verdict.url, format, maxChars);
			if (hit !== null) {
				return this.#record("fetch", hit, startedAt, { url: verdict.url, host: verdict.host, cookie_scope: "container", cache: "hit", page: hit.page });
			}
		}

		/** @type {JobSpec} */
		const spec = {
			kind: "fetch",
			url: verdict.url,
			host: verdict.host,
			session,
			wait: {
				timeout_ms: this.#loadTimeoutMs,
				settle_ms: FETCH_LIMITS.settleMs,
				dwell_ms: null,
				// How long a challenge page is kept for the operator. How long this
				// caller waits for that (wait_for_human_s) is no part of the job:
				// callers with different patience share one.
				human_wait_ms: this.#parkMs,
				scroll: "lazy",
			},
			// The container always returns the page source; the login scope only for a caller who asks for it, and then never stores it.
			extract: { markdown: true, text: true, html: true, raw_html: format === "raw_html", links: true, adapter: "auto" },
			// Where the URL turns out to be a file: what of it may come back. The extension captures none in the
			// operator's login scope, whatever is asked here.
			files: this.#files,
			dedupeKey: "",
			// Where the page ends is held to the policy its address passed: the queue ends a job whose result is from anywhere else.
			policy: this.#policy,
		};
		spec.dedupeKey = JSON.stringify([
			spec.kind,
			spec.url,
			spec.session,
			[spec.wait.timeout_ms, spec.wait.settle_ms, spec.wait.dwell_ms, spec.wait.human_wait_ms, spec.wait.scroll],
			[spec.extract.markdown, spec.extract.text, spec.extract.html, spec.extract.raw_html, spec.extract.links, spec.extract.adapter],
		]);

		/** @type {{ info: import("./queue.js").ParkedInfo, stopWaiting: () => void } | null} */
		let parked = null;
		/** @type {(p: "parked") => void} */
		let wake = () => {};
		/** @type {Promise<"parked">} */
		const onParked = new Promise((resolve) => {
			wake = resolve;
		});
		/** @type {Promise<import("./queue.js").JobReport>} */
		let pending;
		try {
			pending = this.#submitJob(spec, {
				...ctx,
				onParked: (info, stopWaiting) => {
					if (parked !== null) return;
					parked = { info, stopWaiting };
					wake("parked");
				},
			});
		} catch (err) {
			pending = Promise.reject(err);
		}
		/** @type {import("./queue.js").JobReport | "parked"} */
		let first;
		try {
			first = await Promise.race([pending, onParked]);
			if (first === "parked") {
				// Whenever the page is cleared, it is stored: the next fetch of the
				// URL finds it, whether or not anyone is still waiting here.
				pending.then(
					(late) => {
						if (late.outcome === "ok" && late.file != null) this.#keepFile(late, spec.url);
						else if (late.outcome === "ok") this.#keep(late, spec.url);
					},
					() => {},
				);
				const holdMs = /** @type {number} */ (a.wait_for_human_s) * 1000;
				if (holdMs > 0) {
					// The operator may be quick: wait a little for the page itself.
					/** @type {unknown} */
					let timer = null;
					/** @type {Promise<"parked">} */
					const held = new Promise((resolve) => {
						timer = this.#clock.setTimeout(() => resolve("parked"), holdMs);
					});
					try {
						first = await Promise.race([pending, held]);
					} finally {
						// Also when the job ends in a rejection: the timer must not outlive the call.
						this.#clock.clearTimeout(timer);
					}
				}
			}
		} catch (err) {
			this.#log.error("fetch.submit_failed", { message: err instanceof Error ? err.message : "unknown" });
			const failed = this.#failure("error", null, spec.url, null, {
				code: "submit_failed",
				message: "",
				retryable: true,
				retry_after_s: null,
			});
			return this.#record("fetch", failed, startedAt, { url: spec.url, host: spec.host });
		}
		if (first === "parked") return this.#needsHuman(/** @type {NonNullable<typeof parked>} */ (/** @type {unknown} */ (parked)), spec.url);
		const report = first;
		if (report.outcome !== "ok") {
			return this.#failure(report.outcome, report, spec.url, report.error);
		}
		if (report.file != null) return this.#renderFetchedFile(report, spec.url, maxChars);
		return this.#renderFetched(report, spec.url, format, maxChars, session);
	}

	/**
	 * Put the file of an ok report into the store. The bytes are moved from where the daemon put them together;
	 * if that fails, what is left of them is removed. Callers that shared one job get the same report: it is
	 * stored once.
	 * @param {import("./queue.js").JobReport} report an ok report with a file
	 * @param {string} url normalised requested URL
	 * @returns {FileMeta | "full" | "refused" | null} null when the file could not be kept; "full" when the store had
	 *   no room for it; "refused" when the store, with all of the file at hand, found it to be a program
	 */
	#keepFile(report, url) {
		if (this.#savedFiles.has(report)) return this.#savedFiles.get(report) ?? null;
		const blob = report.blob;
		const file = report.file;
		/** @type {FileMeta | "full" | "refused" | null} */
		let meta = null;
		if (blob !== undefined && file != null && report.cookie_scope === "container" && typeof this.#store.saveFile === "function") {
			try {
				meta = this.#store.saveFile({
					url,
					final_url: report.nav.final_url,
					http_status: report.nav.http_status,
					suggested_name: file.name,
					declared_type: report.nav.content_type,
					sniffed_type: blob.sniffed,
					charset: file.charset,
					size: blob.size,
					sha256: blob.sha256,
					text_like: blob.textLike,
					tempPath: blob.path,
					redirect_origins: report.nav.redirect_origins,
				}).meta;
			} catch (err) {
				if (err instanceof StoreError && err.code === "store_full") {
					meta = "full";
					this.#log.warn("fetch.store_full", { job: report.job, bytes: blob.size });
				} else if (err instanceof StoreError && err.code === "file_refused") {
					meta = "refused";
					this.#log.warn("fetch.file_refused", { job: report.job, bytes: blob.size });
				} else this.#log.error("fetch.save_failed", { message: err instanceof Error ? err.message : "unknown" });
			}
		}
		// Stored or not: nothing of it stays where it was put together.
		blob?.release();
		this.#savedFiles.set(report, meta);
		return meta;
	}

	/**
	 * The sanitised body of a stored page or file: from memory when it was read a moment ago, else read from the
	 * store and sanitised, and kept for the next call. The store is asked about the id before this is: what is
	 * kept here is only ever handed out for a page or a file that is still stored. An id names one content for
	 * good, so nothing kept here goes stale.
	 * @param {string} key the id, and for a page the format
	 * @param {() => import("./render.js").PreparedBody | null} read reads and sanitises; null: there is nothing to read
	 * @returns {import("./render.js").PreparedBody | null}
	 */
	#body(key, read) {
		const kept = this.#bodies.get(key);
		if (kept !== undefined) {
			// The one read last is the one kept longest.
			this.#bodies.delete(key);
			this.#bodies.set(key, kept);
			return kept;
		}
		const body = read();
		if (body === null) return null;
		this.#bodies.set(key, body);
		for (const oldest of this.#bodies.keys()) {
			if (this.#bodies.size <= KEPT_BODIES) break;
			this.#bodies.delete(oldest);
		}
		return body;
	}

	/**
	 * @param {PageMeta} meta
	 * @param {Format} format
	 * @returns {import("./render.js").PreparedBody | null} null when the page has no content in this format
	 */
	#pageBody(meta, format) {
		return this.#body(`${meta.id} ${format}`, () => {
			const content = this.#readContent(meta, format);
			return content === null ? null : preparedBody(format, content);
		});
	}

	/**
	 * @param {FileMeta} meta
	 * @param {number} offset
	 * @param {number} maxChars
	 * @param {"hit" | "miss"} cache
	 * @param {import("./queue.js").JobReport["detect"]} [detect]
	 * @returns {ReturnType<typeof renderFile>}
	 */
	#renderStoredFile(meta, offset, maxChars, cache, detect = null) {
		/** @type {import("./render.js").PreparedBody | null} */
		let text = null;
		/** @type {"binary" | "large" | "missing"} */
		let why = "binary";
		if (meta.text) {
			try {
				text = this.#body(meta.id, () => {
					const raw = this.#store.readFileText?.(meta.id) ?? null;
					return raw === null ? null : preparedBody("text", raw);
				});
			} catch (err) {
				this.#log.error("read.store_failed", { message: err instanceof Error ? err.message : "unknown" });
			}
			if (text === null) why = "missing";
		} else if (meta.size > FILE_LIMITS.maxTextBytes && (meta.sniffed_type.startsWith("text/") || meta.sniffed_type === "application/json" || meta.sniffed_type === "application/xml")) {
			why = "large";
		}
		const rendered = renderFile({
			view: {
				id: meta.id,
				requested_url: meta.url,
				final_url: meta.final_url,
				fetched_at: meta.fetched_at,
				http_status: meta.http_status,
				sniffed_type: meta.sniffed_type,
				declared_type: meta.declared_type,
				name: meta.name,
				size: meta.size,
				sha256: meta.sha256,
				cleared: clearedChallenge(detect),
			},
			text,
			why,
			offset,
			maxChars,
			cache,
			randomBytes: this.#randomBytes,
		});
		// Shown in part: the reader comes back for the rest, and the file is not evicted under them meanwhile.
		if (rendered.ok && text !== null) {
			try {
				this.#store.holdFile?.(meta.id, rendered.end >= rendered.total);
			} catch {
				// a store that is closing: nothing to hold
			}
		}
		return rendered;
	}

	/**
	 * The answer for a fetch whose URL turned out to be a file.
	 * @param {import("./queue.js").JobReport} report an ok report with a file
	 * @param {string} url normalised requested URL
	 * @param {number} maxChars
	 * @returns {ToolResult}
	 */
	#renderFetchedFile(report, url, maxChars) {
		const meta = this.#keepFile(report, url);
		if (meta === "full") {
			return this.#failure("error", report, url, null, { code: "file_store_full", message: "", retryable: false, retry_after_s: null });
		}
		if (meta === "refused") {
			return this.#failure("unsupported", report, url, null, { code: FILE_CODE.REFUSED, message: "", retryable: false, retry_after_s: null });
		}
		if (meta === null) {
			return this.#failure("error", report, url, null, { code: "no_content", message: "", retryable: true, retry_after_s: null });
		}
		const r = this.#renderStoredFile(meta, 0, maxChars, "miss", report.detect);
		if (!r.ok) return toolError("internal_error", "Could not render the file.");
		this.#log.info("fetch.file", { job: report.job, file: meta.id, type: meta.sniffed_type, bytes: meta.size });
		return { isError: false, text: r.text, outcome: "ok", page: meta.id, code: null };
	}

	/**
	 * The answer for a caller whose page waits for the operator: the job is
	 * named, the caller is told not to ask again before the site's cooldown is
	 * over, and stops waiting. The job itself goes on.
	 * @param {{ info: import("./queue.js").ParkedInfo, stopWaiting: () => void }} parked
	 * @param {string} url normalised requested URL
	 * @param {boolean} [search] the job is a web search
	 * @returns {ToolResult}
	 */
	#needsHuman(parked, url, search = false) {
		const { info } = parked;
		parked.stopWaiting();
		this.#log.info("fetch.needs_human", { job: info.job });
		return {
			isError: true,
			text: renderFailure(
				{
					outcome: "needs_human",
					job: info.job,
					cookie_scope: info.cookie_scope,
					http_status: info.http_status,
					requested_url: url,
					detect: info.detect,
					error: { code: ERROR_CODE.CHALLENGE_PENDING, message: "", retryable: true, retry_after_s: info.retry_after_s },
					search,
				},
				this.#randomBytes,
			),
			outcome: "needs_human",
			page: null,
			code: ERROR_CODE.CHALLENGE_PENDING,
		};
	}

	/**
	 * @param {string} outcome
	 * @param {import("./queue.js").JobReport | null} report
	 * @param {string} url
	 * @param {import("../../extension/shared/protocol.js").JobError | null} error
	 * @param {import("../../extension/shared/protocol.js").JobError | null} [override]
	 * @param {boolean} [search] the job is a web search
	 * @returns {ToolResult}
	 */
	#failure(outcome, report, url, error, override = null, search = false) {
		// A report the daemon made itself (no render data) carries the daemon's
		// own words; the sentence for its code says the same and needs no
		// delimiters. Only what came from the browser is shown as detail.
		const ownReport = report !== null && report.render === null;
		const err = override ?? (ownReport && error !== null ? { ...error, message: "" } : error);
		return {
			isError: true,
			text: renderFailure(
				{
					outcome,
					job: report?.job ?? null,
					cookie_scope: report?.cookie_scope ?? null,
					http_status: report?.nav.http_status ?? null,
					requested_url: url,
					detect: report?.detect ?? null,
					error: err,
					search,
					body_bytes: report?.nav.body_bytes ?? null,
				},
				this.#randomBytes,
			),
			outcome,
			page: null,
			code: err?.code ?? null,
		};
	}

	/**
	 * @param {string} url normalised
	 * @param {Format} format
	 * @param {number} maxChars
	 * @returns {ToolResult | null} null when nothing usable is cached
	 */
	#serveFromCache(url, format, maxChars) {
		/** @type {ReturnType<StoreLike["findFresh"]>} */
		let found;
		try {
			found = this.#store.findFresh(url, { maxAgeMs: this.#cacheTtlMs });
		} catch (err) {
			this.#log.warn("fetch.cache_failed", { message: err instanceof Error ? err.message : "unknown" });
			return null;
		}
		// A URL that was a file a moment ago is served as that file, unless a page of it is newer.
		/** @type {{ id: string, meta: FileMeta } | null} */
		let file = null;
		try {
			file = this.#files === null ? null : (this.#store.findFreshFile?.(url, { maxAgeMs: this.#cacheTtlMs }) ?? null);
		} catch (err) {
			this.#log.warn("fetch.cache_failed", { message: err instanceof Error ? err.message : "unknown" });
		}
		if (file !== null && (found === null || Date.parse(file.meta.fetched_at) >= Date.parse(found.meta.fetched_at))) {
			const rf = this.#renderStoredFile(file.meta, 0, maxChars, "hit");
			if (rf.ok) {
				this.#log.info("fetch.cache_hit", { page: file.id });
				return { isError: false, text: rf.text, outcome: "ok", page: file.id, code: null };
			}
		}
		if (found === null) return null;
		/** @type {import("./render.js").PreparedBody | null} */
		let content;
		try {
			content = this.#pageBody(found.meta, format);
		} catch (err) {
			// A stored body that cannot be read is no cache hit: the page is loaded again.
			this.#log.warn("fetch.cache_failed", { message: err instanceof Error ? err.message : "unknown" });
			return null;
		}
		if (content === null) return null;
		const r = renderPage({
			view: this.#viewFromMeta(found.meta, format),
			format,
			content,
			maxChars,
			cache: "hit",
			stored: true,
			randomBytes: this.#randomBytes,
		});
		if (!r.ok) return null;
		this.#holdPage(found.id, r);
		this.#log.info("fetch.cache_hit", { page: found.id });
		return { isError: false, text: r.text, outcome: "ok", page: found.id, code: null };
	}

	/**
	 * @param {PageMeta} meta
	 * @param {Format} format
	 * @returns {string | import("./render.js").Link[] | null}
	 */
	#readContent(meta, format) {
		if (format === "links") return this.#store.readLinks(meta.id) ?? [];
		if (format === "text" && !this.#hasOwnText(meta)) {
			// No text file of its own: the Markdown is the visible text, or the page is from before texts were kept.
			return cleanExtraction(meta.extraction)?.view === "text" ? this.#store.readBody(meta.id, "markdown") : null;
		}
		return this.#store.readBody(meta.id, format);
	}

	/**
	 * A stored page was shown: in part, and the reader comes back for the rest - the page is not evicted under them
	 * meanwhile - or to its end.
	 * @param {string} id
	 * @param {{ end: number, total: number }} shown
	 */
	#holdPage(id, shown) {
		try {
			this.#store.holdPage?.(id, shown.end >= shown.total);
		} catch {
			// a store that is closing: nothing to hold
		}
	}

	/** @param {PageMeta} meta @returns {boolean} true when the page has a visible text stored next to its Markdown */
	#hasOwnText(meta) {
		return typeof meta.text_chars === "number";
	}

	/**
	 * @param {PageMeta} meta
	 * @param {Format} format
	 * @returns {PageView}
	 */
	#viewFromMeta(meta, format) {
		const vis = meta.render?.visibility;
		const extraction = cleanExtraction(meta.extraction);
		return {
			id: meta.id,
			requested_url: meta.url,
			final_url: meta.final_url,
			fetched_at: meta.fetched_at,
			http_status: meta.http_status,
			visibility: vis === "visible" || vis === "hidden" ? vis : null,
			extractor: meta.extractor,
			cookie_scope: meta.cookie_scope,
			title: meta.title,
			author: meta.author,
			published: meta.published,
			truncated: truncatedFor(meta.truncated, format, extraction?.view ?? null),
			extraction,
			textAvailable: this.#hasOwnText(meta) || extraction?.view === "text",
		};
	}

	/**
	 * Put the page of an ok report into the store. Only container pages are
	 * stored; anything else leaves a bare record and is shown once, in
	 * full, from the report in memory. Callers that shared one job get the same
	 * report: it is saved once.
	 * @param {import("./queue.js").JobReport} report an ok report
	 * @param {string} url normalised requested URL
	 * @returns {PageMeta | BareMeta | null} null when there is nothing to save, or saving failed
	 */
	#keep(report, url) {
		const content = report.content;
		if (content === null || content.markdown === null) return null;
		const known = this.#saved.get(report);
		if (known !== undefined) return known;
		const page = report.page;
		try {
			const meta = this.#store.save({
				url,
				final_url: report.nav.final_url,
				http_status: report.nav.http_status,
				title: page?.title ?? null,
				author: page?.author ?? null,
				published: page?.published ?? null,
				lang: page?.lang ?? null,
				site: page?.site ?? null,
				word_count: page?.word_count ?? null,
				extractor: page?.extractor ?? null,
				cookie_scope: report.cookie_scope,
				outcome: "ok",
				redirect_origins: report.nav.redirect_origins,
				render: report.render,
				extraction: cleanExtraction(report.extraction),
				truncated: report.truncated,
				markdown: content.markdown,
				text: content.text,
				html: content.html,
				raw_html: content.raw_html,
				links: content.links,
			}).meta;
			this.#saved.set(report, meta);
			return meta;
		} catch (err) {
			// No room for it, even with every older page gone: it is shown this once, like a page that is never kept.
			if (err instanceof StoreError && err.code === "store_full") this.#log.warn("fetch.store_full", { job: report.job });
			else this.#log.error("fetch.save_failed", { message: err instanceof Error ? err.message : "unknown" });
			return null;
		}
	}

	/**
	 * @param {import("./queue.js").JobReport} report an ok report
	 * @param {string} url normalised requested URL
	 * @param {Format} format
	 * @param {number} maxChars
	 * @param {"auto" | "isolated"} session
	 * @returns {ToolResult}
	 */
	#renderFetched(report, url, format, maxChars, session) {
		if (session === "isolated" && report.cookie_scope !== "container") {
			// The extension must never use the logged-in session for an isolated request.
			this.#log.warn("fetch.scope_violation", { job: report.job });
			return this.#failure("error", report, url, null, {
				code: ERROR_CODE.SCOPE_VIOLATION,
				message: "",
				retryable: false,
				retry_after_s: null,
			});
		}
		const content = report.content;
		if (content === null || content.markdown === null) {
			return this.#failure("error", report, url, null, { code: "no_content", message: "", retryable: true, retry_after_s: null });
		}
		const page = report.page;
		const extraction = cleanExtraction(report.extraction);
		const scope = report.cookie_scope;
		const meta = this.#keep(report, url);
		const stored = meta !== null && meta.stored;

		// The visible text travels on its own unless the Markdown is that text.
		const text = content.text ?? (extraction?.view === "text" ? content.markdown : null);
		/** @type {string | import("./render.js").Link[] | null} */
		const body = format === "markdown" ? content.markdown : format === "text" ? text : format === "html" ? content.html : format === "raw_html" ? content.raw_html : content.links;
		if (body === null && format === "raw_html") {
			return {
				isError: true,
				text: renderToolError(
					"format_unavailable",
					"The browser returned no page source: it did not fit into the result, or the extension is older than the feature. Fetch the URL again with fresh true and format raw_html, or use format html.",
				),
				outcome: "error",
				page: meta?.id ?? null,
				code: "format_unavailable",
			};
		}
		if (body === null) {
			return {
				isError: true,
				text: renderToolError(
					"format_unavailable",
					`The browser did not capture ${format} for this page${meta === null ? "" : `; page ${meta.id} was saved, read it with format markdown`}.`,
				),
				outcome: "error",
				page: meta?.id ?? null,
				code: "format_unavailable",
			};
		}
		const vis = report.render?.visibility;
		const r = renderPage({
			view: {
				id: meta?.id ?? null,
				requested_url: url,
				final_url: report.nav.final_url,
				fetched_at: meta?.fetched_at ?? new Date(this.#clock.now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
				http_status: report.nav.http_status,
				visibility: vis === "visible" || vis === "hidden" ? vis : null,
				extractor: page?.extractor ?? null,
				cookie_scope: scope,
				title: page?.title ?? null,
				author: page?.author ?? null,
				published: page?.published ?? null,
				truncated: truncatedFor(report.truncated, format, extraction?.view ?? null),
				extraction,
				textAvailable: text !== null,
				cleared: clearedChallenge(report.detect),
			},
			format,
			content: body,
			maxChars,
			cache: "miss",
			stored,
			randomBytes: this.#randomBytes,
		});
		if (!r.ok) return toolError("internal_error", "Could not render the page.");
		if (meta !== null && stored) this.#holdPage(meta.id, r);
		return { isError: false, text: r.text, outcome: "ok", page: meta?.id ?? null, code: null };
	}

	/**
	 * Continue reading a stored page. Never navigates.
	 * @param {unknown} args page, offset, max_chars, format
	 * @returns {ToolResult}
	 */
	readPage(args) {
		if (this.#audit.ok === false) return toolError("audit_unavailable", AUDIT_DOWN);
		const startedAt = this.#clock.now();
		const v = validate(args, {
			page: { type: "string", required: true, min: 1, max: 64 },
			offset: { type: "int", min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 },
			max_chars: { type: "int", min: RENDER_LIMITS.minMaxChars, max: RENDER_LIMITS.hardMaxChars, fallback: RENDER_LIMITS.defaultMaxChars },
			format: { type: "enum", values: FORMATS, fallback: "markdown" },
		});
		if (!v.ok) return this.#record("read", toolError("invalid_argument", v.message), startedAt);
		const a = v.value;
		const id = /** @type {string} */ (a.page);
		const format = /** @type {Format} */ (a.format);
		if (isValidFileId(id)) return this.#readFile(id, /** @type {number} */ (a.offset), /** @type {number} */ (a.max_chars), startedAt);
		if (!isValidPageId(id)) {
			return this.#record("read", toolError("invalid_page_id", "page is not a valid page or file id. Use the id from a browser_fetch result."), startedAt);
		}
		/** @type {PageMeta | BareMeta | null} */
		let found;
		try {
			found = this.#store.getMeta(id);
		} catch (err) {
			this.#log.error("read.store_failed", { message: err instanceof Error ? err.message : "unknown" });
			return this.#record("read", toolError("internal_error", "The page store could not be read."), startedAt, { page: id });
		}
		if (found === null) {
			return this.#record("read", toolError("unknown_page", "No stored page has this id. It may have expired; fetch the URL again."), startedAt, { page: id });
		}
		const meta = found;
		/** @param {ToolResult} result */
		const done = (result) =>
			this.#record("read", result, startedAt, { page: id, host: typeof meta.host === "string" ? meta.host : null, cookie_scope: isFullMeta(meta) ? meta.cookie_scope : null });
		if (!isFullMeta(meta) || !meta.stored) {
			return done(
				toolError(
					"not_stored",
					`The content of this page is not stored (fetched with the operator's logged-in session). Call browser_fetch again with a larger max_chars (up to ${RENDER_LIMITS.hardMaxChars}).`,
				),
			);
		}
		/** @type {import("./render.js").PreparedBody | null} */
		let content;
		try {
			content = this.#pageBody(meta, format);
		} catch (err) {
			this.#log.error("read.store_failed", { message: err instanceof Error ? err.message : "unknown" });
			return done(toolError("internal_error", "The page store could not be read."));
		}
		if (content === null) {
			return done(
				toolError(
					"format_unavailable",
					format === "raw_html"
						? "No raw HTML is stored for this page (fetched before raw_html existed, too large to be kept, or read with the operator's login). Fetch the URL again with fresh true and format raw_html."
						: format === "html" || format === "text"
							? `No ${format} was captured for this page. Use format markdown.`
							: "The stored content is missing. Fetch the URL again.",
				),
			);
		}
		const offset = /** @type {number} */ (a.offset);
		const r = renderPage({
			view: this.#viewFromMeta(meta, format),
			format,
			content,
			offset,
			maxChars: /** @type {number} */ (a.max_chars),
			cache: "hit",
			stored: true,
			randomBytes: this.#randomBytes,
		});
		if (!r.ok) {
			return done(toolError("offset_out_of_range", `offset ${offset} is beyond the end of the content (${r.total} characters).`));
		}
		this.#holdPage(id, r);
		return done({ isError: false, text: r.text, outcome: "ok", page: id, code: null });
	}

	/**
	 * Continue reading a stored file whose content is text. The format of a page does not apply: a file has one text.
	 * @param {string} id a valid file id
	 * @param {number} offset
	 * @param {number} maxChars
	 * @param {number} startedAt
	 * @returns {ToolResult}
	 */
	#readFile(id, offset, maxChars, startedAt) {
		/** @type {FileMeta | null} */
		let meta = null;
		try {
			meta = this.#store.getFileMeta?.(id) ?? null;
		} catch (err) {
			this.#log.error("read.store_failed", { message: err instanceof Error ? err.message : "unknown" });
			return this.#record("read", toolError("internal_error", "The file store could not be read."), startedAt, { page: id });
		}
		if (meta === null) return this.#record("read", toolError("unknown_page", "No stored file has this id. It may have expired; fetch the URL again."), startedAt, { page: id });
		const more = { page: id, host: meta.host, cookie_scope: meta.cookie_scope, file_type: meta.sniffed_type, file_size: meta.size };
		const r = this.#renderStoredFile(meta, offset, maxChars, "hit");
		if (!r.ok) return this.#record("read", toolError("offset_out_of_range", `offset ${offset} is beyond the end of the text (${r.total} characters).`), startedAt, more);
		return this.#record("read", { isError: false, text: r.text, outcome: "ok", page: id, code: null }, startedAt, more);
	}

	/**
	 * A part of the bytes of a stored file, as base64, exactly as they were retrieved: not rendered either. For
	 * whoever writes them to a file (bgw export, the file_export tool of bgw mcp), and so behind the agent token:
	 * no MCP tool of the daemon returns this, and nothing here writes anywhere.
	 * @param {unknown} args file, offset, length
	 * @returns {{ ok: true, file: string, name: string, type: string, size: number, sha256: string, offset: number, length: number,
	 *   encoding: "base64", data: string, eof: boolean } | { ok: false, status: number, result: ToolResult }}
	 */
	exportFile(args) {
		const startedAt = this.#clock.now();
		/** @param {number} status @param {ToolResult} result @param {Partial<AuditEntry>} [more] @returns {{ ok: false, status: number, result: ToolResult }} */
		const fail = (status, result, more = {}) => ({ ok: false, status, result: this.#record("export", result, startedAt, more) });
		if (this.#audit.ok === false) return { ok: false, status: 503, result: toolError("audit_unavailable", AUDIT_DOWN) };
		const v = validate(args, {
			file: { type: "string", required: true, min: 1, max: 64 },
			offset: { type: "int", min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 },
			length: { type: "int", min: 1, max: FILE_LIMITS.exportChunkBytes, fallback: FILE_LIMITS.exportChunkBytes },
		});
		if (!v.ok) return fail(400, toolError("invalid_argument", v.message));
		const id = /** @type {string} */ (v.value.file);
		const offset = /** @type {number} */ (v.value.offset);
		if (!isValidFileId(id)) return fail(400, toolError("invalid_file_id", "file is not a valid file id."));
		/** @type {FileMeta | null} */
		let meta;
		/** @type {Buffer | null} */
		let bytes = null;
		try {
			meta = this.#store.getFileMeta?.(id) ?? null;
			if (meta !== null && offset <= meta.size) bytes = this.#store.readFileChunk?.(id, offset, /** @type {number} */ (v.value.length)) ?? null;
		} catch (err) {
			this.#log.error("export.store_failed", { message: err instanceof Error ? err.message : "unknown" });
			return fail(500, toolError("internal_error", "The file store could not be read."), { page: id });
		}
		if (meta === null) return fail(404, toolError("unknown_file", "No stored file has this id. It may have expired."), { page: id });
		const more = { page: id, host: meta.host, cookie_scope: meta.cookie_scope, file_type: meta.sniffed_type, file_size: meta.size };
		if (offset > meta.size) return fail(400, toolError("offset_out_of_range", `offset ${offset} is beyond the end of the file (${meta.size} bytes).`), more);
		if (bytes === null) return fail(500, toolError("internal_error", "The stored bytes of the file could not be read."), more);
		// One entry per export, not one per piece: written when the first piece is asked for.
		if (offset === 0) this.#record("export", { isError: false, text: "", outcome: "ok", page: id, code: null }, startedAt, more);
		return { ok: true, file: id, name: meta.name, type: meta.sniffed_type, size: meta.size, sha256: meta.sha256, offset, length: bytes.length, encoding: "base64", data: bytes.toString("base64"), eof: offset + bytes.length >= meta.size };
	}

	/**
	 * The stored content of a page, exactly as it was stored and NOT rendered: no delimiters, no sanitising. The
	 * route that serves this takes the operator's token only and is for the command line (bgw export) writing a
	 * file; no MCP tool has it, because its answer would put undelimited page content into the model's context.
	 * @param {unknown} args page, format
	 * @returns {{ ok: true, page: string, format: ExportFormat, encoding: "utf-8", content: string } | { ok: false, status: number, result: ToolResult }}
	 */
	exportPage(args) {
		const startedAt = this.#clock.now();
		/** @param {number} status @param {ToolResult} result @param {Partial<AuditEntry>} [more] @returns {{ ok: false, status: number, result: ToolResult }} */
		const fail = (status, result, more = {}) => ({ ok: false, status, result: this.#record("export", result, startedAt, more) });
		if (this.#audit.ok === false) return { ok: false, status: 503, result: toolError("audit_unavailable", AUDIT_DOWN) };
		const v = validate(args, {
			page: { type: "string", required: true, min: 1, max: 64 },
			format: { type: "enum", values: EXPORT_FORMATS, required: true },
		});
		if (!v.ok) return fail(400, toolError("invalid_argument", v.message));
		const id = /** @type {string} */ (v.value.page);
		const format = /** @type {ExportFormat} */ (v.value.format);
		if (isValidFileId(id)) return fail(400, toolError("is_a_file", "This id names a file, not a page: its bytes are exported by POST /v1/files/export (bgw export does that by itself)."));
		if (!isValidPageId(id)) return fail(400, toolError("invalid_page_id", "page is not a valid page id."));
		/** @type {PageMeta | BareMeta | null} */
		let found;
		try {
			found = this.#store.getMeta(id);
		} catch (err) {
			this.#log.error("export.store_failed", { message: err instanceof Error ? err.message : "unknown" });
			return fail(500, toolError("internal_error", "The page store could not be read."), { page: id });
		}
		if (found === null) return fail(404, toolError("unknown_page", "No stored page has this id. It may have expired."), { page: id });
		const meta = found;
		const more = { page: id, host: typeof meta.host === "string" ? meta.host : null, cookie_scope: isFullMeta(meta) ? meta.cookie_scope : null };
		if (!isFullMeta(meta) || !meta.stored) {
			return fail(404, toolError("not_stored", "The content of this page is not stored (fetched with the operator's logged-in session), so it cannot be exported."), more);
		}
		/** @type {string | null} */
		let content;
		try {
			content = /** @type {string | null} */ (this.#readContent(meta, format));
		} catch (err) {
			this.#log.error("export.store_failed", { message: err instanceof Error ? err.message : "unknown" });
			return fail(500, toolError("internal_error", "The page store could not be read."), more);
		}
		if (content === null) {
			return fail(404, toolError("format_unavailable", format === "raw_html" ? "No raw HTML is stored for this page. Fetch the URL again with fresh true and format raw_html." : `No ${format} is stored for this page. Export markdown instead.`), more);
		}
		// The limit is one of bytes: a text of other than ASCII letters takes more of them than it has characters.
		if (Buffer.byteLength(content, "utf8") > LIMITS.maxResultBytes) return fail(413, toolError("too_large", "The stored content is larger than the gateway returns."), more);
		this.#record("export", { isError: false, text: "", outcome: "ok", page: id, code: null }, startedAt, more);
		return { ok: true, page: id, format, encoding: "utf-8", content };
	}

	/**
	 * Full-text search over stored pages.
	 * @param {unknown} args query, limit
	 * @returns {ToolResult}
	 */
	searchPages(args) {
		if (this.#audit.ok === false) return toolError("audit_unavailable", AUDIT_DOWN);
		const startedAt = this.#clock.now();
		const v = validate(args, {
			query: { type: "string", required: true, min: 1, max: SEARCH_LIMITS.maxQueryChars },
			limit: { type: "int", min: 1, max: SEARCH_LIMITS.maxHits, fallback: SEARCH_LIMITS.defaultHits },
		});
		if (!v.ok) return this.#record("search", toolError("invalid_argument", v.message), startedAt);
		const query = /** @type {string} */ (v.value.query);
		if (!/[\p{L}\p{N}]/u.test(query)) return this.#record("search", toolError("invalid_argument", "query contains no searchable words."), startedAt);
		let hits;
		try {
			hits = this.#store.search(query, { limit: /** @type {number} */ (v.value.limit) });
		} catch (err) {
			this.#log.error("search.failed", { message: err instanceof Error ? err.message : "unknown" });
			return this.#record("search", toolError("internal_error", "The page index could not be searched."), startedAt);
		}
		// The query is free text from the caller; the audit log holds the count only.
		const result = { isError: false, text: renderSearchHits(query, hits, this.#randomBytes), outcome: "ok", page: null, code: null };
		return this.#record("search", result, startedAt, { hits: hits.length });
	}
}
