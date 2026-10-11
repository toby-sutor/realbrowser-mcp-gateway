import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_PACING, EXIT, LIMITS, checkPrivateDir, loadSettings } from "./config.js";
import { consoleLogger, createLogThrottle, systemClock } from "./log.js";
import { Secrets } from "./secrets.js";
import { AuditLog } from "./audit.js";
import { JobQueue } from "./queue.js";
import { ExtLink } from "./extlink.js";
import { PageStore } from "./store.js";
import { BlobAssembler } from "./blobs.js";
import { FetchService } from "./fetchsvc.js";
import { createMcp } from "./mcp.js";
import { buildTools } from "./mcptools.js";
import { createNotifier } from "./notify.js";
import { createChallengeNotifier } from "./challenges.js";
import { createHttpHandler } from "./http.js";
import { makeEngines } from "./search.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
// What the daemon calls itself on the wire (/healthz, the MCP server name). Fixed: the clients look for exactly this
// name, and it must not follow the package name.
const DAEMON_NAME = "browser-gateway";
const NOTIFY_HELPER = fileURLToPath(new URL("../helpers/notify_helper.py", import.meta.url));
const DAY_MS = 86400000;

/**
 * @typedef {object} StartOptions
 * @property {string} configDir absolute; holds client.token, admin.token, ext.key and the optional config.json
 * @property {string} dataDir absolute; holds the audit log and the page store
 * @property {number} port 0 picks an ephemeral port
 * @property {number} [listenFd] a listening socket handed over by systemd; it must be bound to 127.0.0.1:<port>
 * @property {import("./log.js").Clock} [clock]
 * @property {() => number} [rng] uniform in [0, 1), jitter only
 * @property {import("./log.js").Logger} [log]
 * @property {import("./config.js").Pacing} [pacing] instead of the defaults and the budgets of config.json
 * @property {readonly string[]} [fastHosts] instead of pacing.fast_hosts of config.json
 * @property {readonly string[]} [blocklist]
 * @property {readonly number[]} [allowLoopbackPorts] tests only: loopback fixture ports that pass URL policy
 * @property {import("./notify.js").SpawnFn} [spawn] tests only: how the notifier starts its helper processes
 * @property {{ hostCooldownMs?: number, maxPerMinute?: number }} [notifyLimits] tests only: other limits for the notifier than its own
 * @property {Partial<import("./config.js").LoginPacing>} [loginPacing] tests only: another pace for pages read with the operator's login
 * @property {number} [challengeDelayMs] tests only: instead of notify.challenge_delay_s of config.json
 */

/**
 * The error of a start on a socket that is not ours to serve on.
 * @param {string} message
 * @returns {Error & { code: "BGW_BAD_SOCKET" }}
 */
function badSocket(message) {
	return Object.assign(new Error(message), { code: /** @type {const} */ ("BGW_BAD_SOCKET") });
}

/**
 * What the process does about an error that nothing caught: one line, then it ends with a code that is not 0, so
 * that whoever started it (the service manager, the operator) sees it and starts it again. Going on is no option:
 * after an exception from the middle of anything, nothing here knows what state the queue or the store is in.
 *
 * The line names the kind of error and where it was thrown, in the daemon's own files. Never the message: that is
 * made by whoever threw, and can quote what was being worked on - an address, a piece of a page.
 * @param {{ on(event: "uncaughtException" | "unhandledRejection", fn: (reason: unknown) => void): unknown }} proc
 * @param {import("./log.js").Logger} log
 * @param {(code: number) => void} exit
 */
export function exitOnFault(proc, log, exit) {
	let fired = false;
	/** @param {"uncaught_exception" | "unhandled_rejection"} kind @returns {(reason: unknown) => void} */
	const handler = (kind) => (reason) => {
		// The first one is the one that matters; a second while the first is being written must not loop.
		if (fired) return;
		fired = true;
		try {
			log.error("daemon.fatal", { kind, ...describeFault(reason) });
		} finally {
			exit(EXIT.FAILED);
		}
	};
	proc.on("uncaughtException", handler("uncaught_exception"));
	proc.on("unhandledRejection", handler("unhandled_rejection"));
}

/**
 * @param {unknown} reason what was thrown, or what a promise was rejected with
 * @returns {{ name: string, code: string | null, at: string | null }} the class of the error, its code when it is one
 *   of the system's or the daemon's own, and file and line of the daemon's code that threw
 */
export function describeFault(reason) {
	if (typeof reason !== "object" || reason === null) return { name: typeof reason, code: null, at: null };
	const o = /** @type {{ name?: unknown, code?: unknown, stack?: unknown }} */ (reason);
	const name = typeof o.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(o.name) ? o.name : "Error";
	const code = typeof o.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(o.code) ? o.code : null;
	/** @type {string | null} */
	let at = null;
	if (typeof o.stack === "string") {
		// The first frame inside this source tree, as "file.js:line". The rest of the stack stays out of the log.
		const m = /[/\\]daemon[/\\]src[/\\]([A-Za-z0-9_.-]{1,64}\.js):([0-9]{1,7}):[0-9]{1,7}\)?$/m.exec(o.stack);
		if (m !== null) at = `${m[1]}:${m[2]}`;
	}
	return { name, code, at };
}

/**
 * Start the daemon bound to 127.0.0.1 only.
 *
 * Port and directories are required on purpose: nothing here falls back to
 * the operator's real port or config, so a test can never touch them by
 * accident. main.js resolves the real values through config.js.
 *
 * Failures the caller may want to tell apart: a ConfigError for a config.json
 * that cannot be used, code "EADDRINUSE" when the port is taken, code
 * "BGW_BAD_SOCKET" when the inherited socket is not 127.0.0.1:<port>.
 * @param {StartOptions} opts
 * @returns {Promise<{ port: number, configDir: string, dataDir: string, close: () => Promise<void> }>}
 */
export async function start(opts) {
	const { configDir, dataDir } = opts ?? {};
	if (typeof configDir !== "string" || !path.isAbsolute(configDir)) throw new Error("start: configDir must be an absolute path");
	if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) throw new Error("start: dataDir must be an absolute path");
	const requested = opts.port;
	if (!Number.isInteger(requested) || requested < 0 || requested > 65535) throw new Error("start: port must be 0..65535");
	const listenFd = opts.listenFd;
	if (listenFd !== undefined && (!Number.isInteger(listenFd) || listenFd < 3 || requested === 0)) {
		throw new Error("start: listenFd needs a descriptor from 3 up and the port it is expected to be bound to");
	}
	const clock = opts.clock ?? systemClock;
	const rng = opts.rng ?? Math.random;
	const log = opts.log ?? consoleLogger();
	const name = DAEMON_NAME;
	const version = String(pkg.version);

	// The directory before anything in it is believed: config.json can name a program to run, so it is read only
	// from a directory that is the current user's and closed to everyone else. Nothing is created here.
	if (checkPrivateDir(configDir).tightened) log.warn("config.dir_mode_fixed", { dir: configDir });
	// Then the settings, so that a config.json that cannot be used stops the start before anything is created.
	const policy = { blocklist: opts.blocklist, allowLoopbackPorts: opts.allowLoopbackPorts ?? [] };
	const settings = loadSettings(configDir, (file) => log.warn("config.file_mode_fixed", { file }), policy);
	const secrets = new Secrets({ configDir, clock, log });
	secrets.init();
	const audit = new AuditLog({ dataDir, clock, log });
	audit.open();
	/** @type {PageStore} */
	let store;
	try {
		store = new PageStore({ dataDir, clock, log, maxFileBytes: settings.files.maxTotalMb * 1048576, maxPageBytes: settings.pages.maxTotalMb * 1048576 });
	} catch (err) {
		audit.close();
		throw err;
	}
	// An index that was lost is made again from the directories before anything asks it: retention and the limits
	// go by the index. Nothing happens here when the index knows a single page or file. A rebuild that fails leaves
	// the index as it was, and the daemon serves without what it could not read; the next start tries again.
	try {
		store.recoverIndex();
	} catch (err) {
		log.error("store.index_rebuild_failed", { message: err instanceof Error ? err.message : "unknown" });
	}
	// Where the pieces of a retrieved file are put together. Whatever lies there from an earlier run is nobody's.
	const blobs = new BlobAssembler({ dataDir, clock, log });
	blobs.sweep();
	const files = settings.files.enabled ? { maxBytes: settings.files.maxMb * 1048576, allowTypes: settings.files.allowTypes } : null;
	const throttle = createLogThrottle({ log, clock, burst: LIMITS.refusalLogBurst, intervalMs: LIMITS.refusalLogIntervalMs });
	const engines = makeEngines(settings.search.engines, settings.search.defaultEngine);

	/** @type {number} */
	let boundPort = requested;
	const getPort = () => boundPort;

	// Its helpers end with the daemon. In a test, spawn is a stand-in: nothing
	// of a test run may reach the desktop.
	const notifier = createNotifier({
		log,
		clock,
		helperPath: NOTIFY_HELPER,
		sound: settings.notify.sound !== false,
		soundFile: typeof settings.notify.sound === "string" ? settings.notify.sound : null,
		hookCommand: settings.notify.hookCommand,
		...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
		...opts.notifyLimits,
	});

	/** @type {ExtLink} */
	let link;
	/** @type {JobQueue} */
	let queue;
	// A page that waits for the operator: desktop notification with an "Open"
	// action, repeated until they have the page, closed when the job is over.
	const challengeDelayMs = opts.challengeDelayMs ?? settings.notify.challengeDelayS * 1000;
	const challenges = createChallengeNotifier({ notifier, clock, log, attention: (job, action) => queue.attention(job, action), delayMs: challengeDelayMs });
	queue = new JobQueue({
		clock,
		rng,
		log,
		audit,
		send: (msg) => link.send(msg),
		onChallenge: {
			pending: (job) => challenges.pending(job),
			acked: (job) => challenges.acked(job),
			cleared: (job) => challenges.cleared(job),
			ended: (job) => challenges.ended(job),
		},
		pacing: opts.pacing ?? {
			polite: { ...DEFAULT_PACING.polite, hourlyBudget: settings.pacing.hourlyBudget.polite },
			fast: { ...DEFAULT_PACING.fast, hourlyBudget: settings.pacing.hourlyBudget.fast },
		},
		fastHosts: opts.fastHosts ?? settings.pacing.fastHosts,
		defaultProfile: settings.pacing.defaultProfile,
		...(opts.loginPacing === undefined ? {} : { loginPacing: opts.loginPacing }),
		blobs,
	});
	link = new ExtLink({
		getPort,
		secrets,
		clock,
		log,
		throttle,
		handlers: {
			onUp: (state) => queue.linkUp(state),
			onDown: (cause) => queue.linkDown(cause),
			onState: (state) => queue.setState(state),
			onEvent: (event) => queue.onEvent(event),
			onAccepted: (msg) => queue.onAccepted(msg),
			onProgress: (msg) => queue.onProgress(msg),
			onBlob: (msg) => queue.onBlob(msg),
			onResult: (body) => queue.onResult(body),
		},
	});

	const fetchsvc = new FetchService({
		store,
		// The queue writes the audit entry of every job, and counts the calls
		// that joined it.
		submitJob: (spec, ctx) => {
			const handle = queue.submit(spec);
			if (ctx.onClientGone !== undefined) ctx.onClientGone(() => handle.release());
			handle.parked.then((info) => {
				if (info !== null) ctx.onParked(info, () => handle.release());
			});
			return handle.promise;
		},
		clock,
		log,
		audit,
		options: { cacheTtlMs: settings.cacheTtlS * 1000, policy, engines, loadTimeoutMs: settings.fetch.loadTimeoutS * 1000, files },
	});

	const startedAt = clock.now();
	const storeStats = () => {
		try {
			return store.stats();
		} catch (err) {
			// Zeros in the status are an answer, not the reason: that goes to the log, a few times a minute at most.
			throttle.warn("store.stats_failed", { message: err instanceof Error ? err.message : "unknown" });
			return { pages: 0, stored: 0, files: 0, file_bytes: 0, file_bytes_max: settings.files.maxTotalMb * 1048576 };
		}
	};
	/**
	 * For agents: booleans and counts. No host names, no reasons, no versions
	 * of the operator's browser. Of the pages that wait for the operator an
	 * agent learns how many there are, not which.
	 */
	const agentStatus = () => {
		const info = link.info();
		const state = info.connected ? info.state : null;
		return {
			ok: true,
			name,
			version,
			uptime_s: Math.floor((clock.now() - startedAt) / 1000),
			paired: secrets.isPaired(),
			extension_connected: info.connected,
			paused: state !== null && state.paused,
			queue: queue.stats(),
			pending_operator_actions: queue.pendingCount(),
			optin_rules: state === null ? 0 : state.optin_hosts.length,
			store: storeStats(),
			audit_ok: audit.ok,
		};
	};
	/** For the operator. */
	const adminStatus = () => ({
		...agentStatus(),
		pairing_pending: secrets.activePairing() !== null,
		// Job ids and hosts of the pages that wait: "bgw pending" lists them, "bgw open <job>" brings one up.
		pending: queue.pending(),
		extension: link.info(),
		settings: {
			retention_days: settings.retentionDays,
			cache_ttl_s: settings.cacheTtlS,
			notify: { sound: settings.notify.sound !== false, hook: settings.notify.hookCommand !== null, challenge_delay_s: Math.round(challengeDelayMs / 1000) },
			fetch: { load_timeout_s: settings.fetch.loadTimeoutS },
			pacing: {
				default_profile: settings.pacing.defaultProfile,
				fast_hosts: [...(opts.fastHosts ?? settings.pacing.fastHosts)],
				hourly_budget: { ...settings.pacing.hourlyBudget },
			},
			search: { default_engine: engines.fallback, engines: [...engines.names] },
			pages: { max_total_mb: settings.pages.maxTotalMb },
			files: { enabled: settings.files.enabled, max_mb: settings.files.maxMb, max_total_mb: settings.files.maxTotalMb, allow_types: [...settings.files.allowTypes] },
		},
	});

	const mcp = createMcp({
		serverInfo: { name, version, title: "Browser Gateway" },
		tools: buildTools({ fetchsvc, status: agentStatus }),
		log,
	});

	const server = http.createServer(
		createHttpHandler({ pkg: { name, version }, getPort, secrets, queue, fetchsvc, mcp, status: { agent: agentStatus, admin: adminStatus }, audit, log, throttle, policy }),
	);
	server.headersTimeout = LIMITS.headersTimeoutMs;
	server.requestTimeout = LIMITS.requestTimeoutMs;
	server.maxConnections = LIMITS.maxConnections;
	// A connection over that number is closed at once. Anyone on the loopback can make that happen at will.
	server.on("drop", () => throttle.warn("server.connection_dropped", { max: LIMITS.maxConnections }));
	server.on("upgrade", (req, socket, head) => link.handleUpgrade(req, socket, head));

	const release = () => {
		throttle.close();
		// Nothing of a file that was on its way, or was never stored, outlives the daemon.
		blobs.discardAll();
		store.close();
		audit.close();
	};
	try {
		await /** @type {Promise<void>} */ (
			new Promise((resolve, reject) => {
				server.once("error", reject);
				const listening = () => {
					server.off("error", reject);
					// From here on an error of the listening socket (no descriptors left to accept with, say) is
					// written down. Without a listener it would be an exception nobody catches.
					server.on("error", (err) => {
						const code = /** @type {NodeJS.ErrnoException} */ (err).code;
						log.error("server.error", { code: typeof code === "string" ? code : null, message: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
					});
					resolve();
				};
				if (listenFd === undefined) server.listen(requested, "127.0.0.1", listening);
				else server.listen({ fd: listenFd }, listening);
			})
		);
	} catch (err) {
		release();
		if (listenFd !== undefined) throw badSocket(`the socket handed over as descriptor ${listenFd} cannot be used: ${err instanceof Error ? err.message : "unknown"}`);
		throw err;
	}
	const addr = server.address();
	// The check that matters for an inherited socket: whatever its unit file
	// says, this daemon serves on the loopback and on the port its clients
	// were told, or not at all.
	const loopback = addr !== null && typeof addr !== "string" && addr.address === "127.0.0.1" && addr.family === "IPv4";
	if (!loopback || (listenFd !== undefined && addr.port !== requested)) {
		await /** @type {Promise<void>} */ (new Promise((resolve) => server.close(() => resolve())));
		release();
		const found = addr === null ? "nothing" : typeof addr === "string" ? "a unix socket" : `${addr.address}:${addr.port}`;
		throw badSocket(`the listening socket is bound to ${found}, expected 127.0.0.1:${requested === 0 ? "<port>" : requested}`);
	}
	boundPort = addr.port;
	log.info("daemon.listening", { port: boundPort, paired: secrets.isPaired(), socket_activated: listenFd !== undefined });

	// Retention, of the store and of the audit log: once now, then daily.
	/** @type {unknown} */
	let purgeTimer = null;
	const purge = () => {
		try {
			const r = store.purge({ maxAgeMs: settings.retentionDays * DAY_MS });
			if (r.rows > 0 || r.refused > 0 || r.files > 0 || r.unknown > 0) {
				log.info("store.purged", { rows: r.rows, dirs: r.dirs, files: r.files, unknown: r.unknown, refused: r.refused, retention_days: settings.retentionDays });
			}
		} catch (err) {
			log.error("store.purge_failed", { message: err instanceof Error ? err.message : "unknown" });
		}
		// What was asked for is kept as long as what came back, and no longer.
		try {
			const a = audit.purge({ maxAgeMs: settings.retentionDays * DAY_MS });
			if (a.entries > 0) log.info("audit.purged", { entries: a.entries, retention_days: settings.retentionDays });
		} catch (err) {
			log.error("audit.purge_failed", { message: err instanceof Error ? err.message : "unknown" });
		}
	};
	const schedulePurge = () => {
		purgeTimer = clock.setTimeout(() => {
			purge();
			schedulePurge();
		}, DAY_MS);
		// Never the reason the process stays alive.
		if (typeof purgeTimer === "object" && purgeTimer !== null && "unref" in purgeTimer && typeof purgeTimer.unref === "function") purgeTimer.unref();
	};
	purge();
	schedulePurge();

	let closing = false;
	return {
		port: boundPort,
		configDir,
		dataDir,
		close: async () => {
			if (closing) return;
			closing = true;
			clock.clearTimeout(purgeTimer);
			queue.shutdown();
			challenges.closeAll();
			await link.close();
			await notifier.closeAll();
			await /** @type {Promise<void>} */ (
				new Promise((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				})
			);
			release();
		},
	};
}
