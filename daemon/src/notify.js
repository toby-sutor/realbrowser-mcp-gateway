import fs from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { siteOf } from "./site.js";
import { parseIp } from "../../extension/shared/policy.js";

/**
 * Desktop notifications, the operator's third layer. The primary path runs the Python
 * helper, which keeps one D-Bus connection so the click reaches us. When the
 * helper cannot run, a plain `gdbus call` posts without actions.
 *
 * Every external command is an argv array handed to spawn without a shell.
 * Notification text is built by callers from fixed strings plus a host name and
 * a job id, passed through safeText(); page-controlled text never gets here.
 *
 * What triggers a notification is, in the end, a web page. So posting is
 * bounded however often it is asked for: a post for a key that is still on its
 * way out is the same post (coalesced), a site gets one notification per
 * cooldown, a few per minute go out in total, and no more than a few helper
 * processes live at once. A post over a limit is answered with a finished
 * handle and neither sounds nor runs the hook. So is a post that names a host
 * which is neither a plain host name nor an IPv6 address as the URL parser
 * writes it: the rules above are kept per site, and a name they cannot be
 * applied to is not shown at all.
 *
 * Nothing that is started here is left to itself. The helper is asked to
 * leave and signalled after a grace period; the sound and the operator's hook
 * are ended at their limit, and killed when they are still there after that.
 * What is remembered of a key - the id of its notification, for replacing it
 * - is dropped when whoever posted says that the key is over (forget).
 *
 * Notifications that nobody dismisses must not keep later ones out. When the
 * places for helper processes are all taken, the oldest notification is
 * closed and the new one takes its place.
 *
 * Windows has none of this: no D-Bus, no helper, no sound player. There a post
 * that passes the limits runs the operator's hook as everywhere, and ends at
 * once as "unsupported", without starting anything else.
 *
 * @typedef {import("./log.js").Logger} Logger
 * @typedef {import("./log.js").Clock} Clock
 *
 * @typedef {import("node:events").EventEmitter & {
 *   pid?: number,
 *   stdin?: { write: (chunk: string) => unknown, end: () => unknown, on: (event: "error", cb: (err: Error) => void) => unknown } | null,
 *   stdout?: { on: (event: "data", cb: (chunk: Buffer | string) => void) => unknown } | null,
 *   stderr?: { on: (event: "data", cb: (chunk: Buffer | string) => void) => unknown } | null,
 *   kill: (signal?: NodeJS.Signals) => boolean,
 * }} ChildLike a child process; "close" (code, signal) ends it, "error" is a spawn failure
 *
 * @typedef {(command: string, args: readonly string[], options: import("node:child_process").SpawnOptions) => ChildLike} SpawnFn
 *
 * @typedef {"low" | "normal" | "critical"} Urgency
 *
 * @typedef {object} NotifyAction
 * @property {string} key letters, digits, "_" or "-"
 * @property {string} label
 *
 * @typedef {object} PostOptions
 * @property {string} key identifies the thing notified about; posting again replaces the earlier one
 * @property {string} summary
 * @property {string} [body]
 * @property {Urgency} [urgency] default "normal"
 * @property {readonly NotifyAction[]} [actions] the default (body click) action is always added
 * @property {boolean | string} [sound] false skips; a string is a file; otherwise the configured or first existing candidate
 * @property {number} [timeoutMs] 0 = no expiry; default 0 for critical, 10000 otherwise
 * @property {number} [maxWaitS] helper lifetime cap, default 3600
 * @property {string} [host] the host the notification is about: its site gets the cooldown, a long name is shown by
 *   its right end; with jobId, enables the operator hook. A value that is neither a plain host name nor a
 *   bracketed IPv6 address: no post
 * @property {string} [jobId]
 * @property {boolean} [hook] false: do not run the operator hook for this post (a repeat of one that ran it)
 *
 * @typedef {object} NotifyResult
 * @property {string} why closed | action | max_wait | stdin_eof | signal | replaced | fallback | error | unsupported (the
 *   platform shows no desktop notifications: only the hook ran), or for a post that was not made: cooldown (the site
 *   was notified about a moment ago) | busy (too many at once or per minute) | bad_host (the host named is neither a
 *   plain host name nor a bracketed IPv6 address)
 * @property {number | null} id notification id when one was posted
 * @property {boolean} clickable
 *
 * @typedef {object} NotifierOptions
 * @property {Logger} log
 * @property {Clock} clock
 * @property {SpawnFn} [spawn]
 * @property {string} helperPath
 * @property {boolean} [sound] false: no post plays a sound unless it names a file itself; default true
 * @property {number} [maxHelpers] helper processes alive at once, default 3
 * @property {number} [hostCooldownMs] one notification per site in this time, default 60 s
 * @property {number} [maxPerMinute] notifications in any minute, default 6
 * @property {string | null} [soundFile] configured sound; null or undefined picks a candidate
 * @property {readonly string[] | null} [hookCommand] argv array, never a shell string
 * @property {(file: string) => boolean} [fileExists]
 * @property {readonly string[]} [soundCandidates]
 * @property {string} [python]
 * @property {string} [gdbus]
 * @property {string} [pwPlay]
 * @property {NodeJS.Platform} [platform] default process.platform; on win32 nothing but the hook is started
 */

export const MAX_LINE_BYTES = 8192;
export const HOOK_TIMEOUT_MS = 10_000;
// A sound is an alert of a second or two. A player that hangs on the audio server is not waited for.
export const SOUND_TIMEOUT_MS = 15_000;
export const CLOSE_GRACE_MS = 2_000;
export const MAX_HELPERS = 3;
export const HOST_COOLDOWN_MS = 60_000;
export const MAX_PER_MINUTE = 6;
const MAX_TEXT = 200;
const MAX_LABEL = 60;
const MAX_TOKEN = 512;
const MAX_HOST_SHOWN = 64;
const APP_NAME = "Browser Gateway";

export const DEFAULT_SOUND_CANDIDATES = Object.freeze([
	"/usr/share/sounds/freedesktop/stereo/dialog-warning.oga",
	"/usr/share/sounds/freedesktop/stereo/bell.oga",
	"/usr/share/sounds/ocean/stereo/dialog-warning.oga",
]);

// Underscores occur in real host names. First and last character stay letters or
// digits: a host is also an argument of the hook and must never read as an option.
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
// An IPv6 address the way the URL parser writes a host: in brackets, lower case. Hex digits, colons and dots are no
// markup, and the bracket in front keeps it from reading as an option. Whether it is an address is for parseIp.
const HOST6_RE = /^\[[0-9a-f:.]{2,45}\]$/;
// The shape the daemon gives its job ids. The fixed prefix also keeps an id
// from ever reading as an option ("--help") where it becomes an argument.
const JOB_RE = /^j_[0-9A-Za-z_-]{1,64}$/;
const ACTION_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
const URGENCIES = ["low", "normal", "critical"];

/**
 * Text for a notification body or summary. The server renders body markup, so
 * markup characters go, along with control and format characters.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function safeText(value, max = MAX_TEXT) {
	if (typeof value !== "string") return "";
	const cleaned = value
		.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/[<>&]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= max) return cleaned;
	return cleaned.slice(0, Math.max(0, max - 3)).trimEnd() + "...";
}

/**
 * A host that can be shown, and handed to the hook, as it is: a plain host
 * name, or an IPv6 address in brackets. A job on such an address waits for the
 * operator like any other.
 * @param {unknown} host
 * @returns {host is string}
 */
export function isValidHost(host) {
	if (typeof host !== "string") return false;
	if (HOST_RE.test(host)) return true;
	return HOST6_RE.test(host) && parseIp(host)?.version === 6;
}

/**
 * A host name short enough to show. The right end is what names the site, so
 * a long name loses labels on the left: the operator must never be shown a
 * name that stops before the registrable part ("accounts.example.com.x1..."
 * for a host under some other domain).
 * @param {string} host
 * @param {number} [max]
 * @returns {string}
 */
export function displayHost(host, max = MAX_HOST_SHOWN) {
	if (host.length <= max) return host;
	const room = Math.max(1, max - 3);
	const labels = host.split(".");
	let kept = "";
	for (let i = labels.length - 1; i >= 0; i--) {
		const next = kept === "" ? labels[i] : `${labels[i]}.${kept}`;
		if (next.length > room) break;
		kept = next;
	}
	// Not even the last label fits: keep its end.
	return `...${kept === "" ? host.slice(-room) : kept}`;
}

/** @param {unknown} job @returns {job is string} */
export function isValidJobId(job) {
	return typeof job === "string" && JOB_RE.test(job);
}

/** @type {SpawnFn} */
const defaultSpawn = (command, args, options) => nodeSpawn(command, [...args], options);

/**
 * GVariant text literal for a string argument of `gdbus call`.
 * @param {string} s
 * @returns {string}
 */
function gvString(s) {
	return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/** Result of one notification, and its event hooks. */
export class NotifyHandle {
	/** @type {boolean} false once the fallback path was used: no click can be reported */
	clickable = true;
	/** @type {number | null} */
	id = null;
	/** @type {Promise<NotifyResult>} never rejects */
	done;
	/** @type {Promise<void>} settles once the id is known or the notification ended */
	ready;
	/** @type {ChildLike | null} */
	child = null;
	released = false;
	cancelled = false;
	/** True once a newer notification was given this one's place: its helper is on its way out. */
	evicted = false;
	/** @type {string} what was asked for, to tell a repeat from an update */
	content = "";
	/** @type {NotifyHandle | null} the notification this one waits to replace */
	waitsFor = null;
	/** @type {string | null} */
	token = null;
	/** @type {Array<(key: string, info: { activationToken: string | null }) => void>} */
	#onAction = [];
	/** @type {Array<(reason: number) => void>} */
	#onClosed = [];
	/** @type {(r: NotifyResult) => void} */
	#resolveDone = () => {};
	/** @type {() => void} */
	#resolveReady = () => {};
	#finished = false;

	/** @param {string} key */
	constructor(key) {
		this.key = key;
		this.done = new Promise((resolve) => {
			this.#resolveDone = resolve;
		});
		this.ready = new Promise((resolve) => {
			this.#resolveReady = resolve;
		});
		/** @type {null | (() => Promise<NotifyResult>)} */
		this.closer = null;
	}

	/** @param {(key: string, info: { activationToken: string | null }) => void} cb */
	onAction(cb) {
		this.#onAction.push(cb);
	}

	/** @param {(reason: number) => void} cb */
	onClosed(cb) {
		this.#onClosed.push(cb);
	}

	/** @returns {Promise<NotifyResult>} resolves once the notification is closed or the helper has ended */
	close() {
		if (this.#finished) return this.done;
		this.cancelled = true;
		return this.closer ? this.closer() : this.done;
	}

	/** @param {string} key @param {string | null} token */
	emitAction(key, token) {
		if (this.released) return;
		for (const cb of this.#onAction) cb(key, { activationToken: token });
	}

	/** @param {number} reason */
	emitClosed(reason) {
		if (this.released) return;
		for (const cb of this.#onClosed) cb(reason);
	}

	/** @param {number} id */
	setId(id) {
		this.id = id;
		this.#resolveReady();
	}

	/** @param {string} why */
	finish(why) {
		if (this.#finished) return;
		this.#finished = true;
		this.#resolveReady();
		this.#resolveDone({ why: this.released ? "replaced" : why, id: this.id, clickable: this.clickable });
	}

	get finished() {
		return this.#finished;
	}
}

/**
 * @param {NotifierOptions} options
 */
export function createNotifier(options) {
	const { log, clock } = options;
	const spawn = options.spawn ?? defaultSpawn;
	const fileExists = options.fileExists ?? ((/** @type {string} */ f) => fs.existsSync(f));
	const python = options.python ?? "python3";
	const gdbus = options.gdbus ?? "gdbus";
	const pwPlay = options.pwPlay ?? "pw-play";
	const candidates = options.soundCandidates ?? DEFAULT_SOUND_CANDIDATES;
	const hookCommand = validateHook(options.hookCommand);
	const soundOn = options.sound !== false;
	const maxHelpers = options.maxHelpers ?? MAX_HELPERS;
	const hostCooldownMs = options.hostCooldownMs ?? HOST_COOLDOWN_MS;
	const maxPerMinute = options.maxPerMinute ?? MAX_PER_MINUTE;
	const desktop = desktopNotifications(options.platform);
	let unsupportedLogged = false;

	/** @type {Set<NotifyHandle>} posts that were accepted and have not ended */
	const active = new Set();
	/** @type {Map<string, number>} time of the last accepted post by site */
	const lastBySite = new Map();
	/** @type {number[]} times of the posts accepted in the last minute */
	const recent = [];
	let notPosted = 0;
	let notPostedLoggedAt = -Infinity;

	/** @type {Map<string, NotifyHandle>} live handles by key */
	const live = new Map();
	/** @type {Map<string, number>} last known notification id by key, for replace */
	const lastId = new Map();
	/** @type {Set<NotifyHandle>} */
	const helpers = new Set();

	/** @param {readonly string[] | null | undefined} cmd @returns {readonly string[] | null} */
	function validateHook(cmd) {
		if (cmd == null) return null;
		if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((a) => typeof a === "string" && a.length > 0 && !a.includes("\0"))) {
			throw new TypeError("hookCommand must be a non-empty array of non-empty strings");
		}
		return Object.freeze([...cmd]);
	}

	/**
	 * A program that is started and not waited for must not stay for good:
	 * SIGTERM at its limit, SIGKILL when it is still there after the grace
	 * period. The timers are never the reason the process stays alive.
	 * @param {ChildLike} child
	 * @param {number} ms
	 * @param {string} event the log line for a child that reached its limit
	 * @returns {() => void} to be called when the child has ended
	 */
	function limit(child, ms, event) {
		/** @param {unknown} t @returns {unknown} */
		const quiet = (t) => {
			if (typeof t === "object" && t !== null && "unref" in t && typeof t.unref === "function") t.unref();
			return t;
		};
		/** @type {unknown} */
		let timer = quiet(
			clock.setTimeout(() => {
				log.warn(event);
				child.kill("SIGTERM");
				timer = quiet(
					clock.setTimeout(() => {
						timer = null;
						child.kill("SIGKILL");
					}, CLOSE_GRACE_MS),
				);
			}, ms),
		);
		return () => {
			if (timer !== null) clock.clearTimeout(timer);
			timer = null;
		};
	}

	/**
	 * Detached, non-blocking, failures logged and ignored.
	 * @param {boolean | string | undefined} sound
	 */
	function playSound(sound) {
		if (sound === false || (!soundOn && typeof sound !== "string")) return;
		const wanted = typeof sound === "string" && sound ? sound : options.soundFile || null;
		// A configured file that is gone must not leave the alert silent.
		const file = wanted && fileExists(wanted) ? wanted : (candidates.find((c) => fileExists(c)) ?? null);
		if (!file) {
			log.warn("notify.sound_missing");
			return;
		}
		try {
			const child = spawn(pwPlay, [file], { stdio: "ignore", shell: false });
			const ended = limit(child, SOUND_TIMEOUT_MS, "notify.sound_timeout");
			child.on("error", (err) => {
				ended();
				log.warn("notify.sound_failed", { error: errText(err) });
			});
			child.on("close", ended);
		} catch (err) {
			log.warn("notify.sound_failed", { error: errText(err) });
		}
	}

	/**
	 * @param {unknown} host
	 * @param {unknown} jobId
	 */
	function runHook(host, jobId) {
		if (!hookCommand) return;
		if (!isValidHost(host) || !isValidJobId(jobId)) {
			log.warn("notify.hook_rejected");
			return;
		}
		try {
			const [cmd, ...rest] = hookCommand;
			const child = spawn(/** @type {string} */ (cmd), [...rest, host, jobId], { stdio: "ignore", shell: false });
			// A hook that ignores SIGTERM is killed: the operator's command is not left behind for every challenge.
			const ended = limit(child, HOOK_TIMEOUT_MS, "notify.hook_timeout");
			child.on("error", (err) => {
				ended();
				log.warn("notify.hook_failed", { error: errText(err) });
			});
			child.on("close", (code) => {
				ended();
				if (code !== 0) log.warn("notify.hook_exit", { code: typeof code === "number" ? code : null });
			});
		} catch (err) {
			log.warn("notify.hook_failed", { error: errText(err) });
		}
	}

	/**
	 * Post with the helper. Resolves "fallback" when the helper cannot run.
	 * @param {NotifyHandle} handle
	 * @param {Required<Pick<PostOptions, "summary" | "body" | "urgency" | "timeoutMs" | "maxWaitS">> & { actions: readonly NotifyAction[] }} p
	 * @param {number} replacesId
	 * @returns {Promise<"done" | "fallback">}
	 */
	function runHelper(handle, p, replacesId) {
		return new Promise((resolve) => {
			const args = [
				options.helperPath,
				`--summary=${p.summary}`,
				`--body=${p.body}`,
				`--urgency=${p.urgency}`,
				`--timeout-ms=${p.timeoutMs}`,
				`--max-wait-s=${p.maxWaitS}`,
				`--app-name=${APP_NAME}`,
				...p.actions.map((a) => `--action=${a.key}=${a.label}`),
			];
			if (replacesId > 0) args.push(`--replaces-id=${replacesId}`);

			let posted = false;
			let settled = false;
			let exitWhy = "";
			/** @param {"done" | "fallback"} how */
			const settle = (how) => {
				if (settled) return;
				settled = true;
				helpers.delete(handle);
				resolve(how);
			};

			/** @type {ChildLike} */
			let child;
			try {
				child = spawn(python, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
			} catch (err) {
				log.warn("notify.helper_spawn_failed", { error: errText(err) });
				settle("fallback");
				return;
			}
			handle.child = child;
			helpers.add(handle);
			/** @type {unknown} */
			let killTimer = null;
			const sendCmd = (/** @type {string} */ cmd) => {
				try {
					child.stdin?.write(JSON.stringify({ cmd }) + "\n");
				} catch (err) {
					log.warn("notify.helper_stdin_failed", { error: errText(err) });
				}
			};
			const hardKillLater = () => {
				if (killTimer) return;
				killTimer = clock.setTimeout(() => {
					if (!settled) child.kill("SIGTERM");
				}, CLOSE_GRACE_MS);
			};
			handle.closer = () => {
				sendCmd("close");
				hardKillLater();
				return handle.done;
			};
			child.stdin?.on("error", () => {});
			child.stderr?.on("data", () => {});

			const decoder = new StringDecoder("utf8");
			let buf = "";
			let discarding = false;
			/** @param {string} line */
			const onLine = (line) => {
				/** @type {unknown} */
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					log.warn("notify.helper_bad_line");
					return;
				}
				if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
				const ev = /** @type {Record<string, unknown>} */ (msg);
				switch (ev.event) {
					case "posted":
						if (typeof ev.id === "number" && Number.isSafeInteger(ev.id) && ev.id > 0) {
							posted = true;
							lastId.set(handle.key, ev.id);
							handle.setId(ev.id);
							log.info("notify.posted", { key: handle.key, id: ev.id });
						}
						break;
					case "activation_token":
						if (typeof ev.token === "string" && ev.token.length <= MAX_TOKEN) handle.token = ev.token;
						break;
					case "action":
						if (typeof ev.key === "string" && ACTION_KEY_RE.test(ev.key)) {
							handle.emitAction(ev.key, handle.token);
						}
						break;
					case "closed":
						handle.emitClosed(typeof ev.reason === "number" ? ev.reason : 0);
						break;
					case "error":
						log.warn("notify.helper_error", { message: safeText(ev.message, 200) });
						break;
					case "exit":
						if (typeof ev.why === "string") exitWhy = ev.why;
						break;
					default:
						break;
				}
			};
			child.stdout?.on("data", (chunk) => {
				buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
				for (;;) {
					const nl = buf.indexOf("\n");
					if (nl < 0) break;
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (discarding) discarding = false;
					else if (Buffer.byteLength(line) <= MAX_LINE_BYTES) onLine(line);
					else log.warn("notify.helper_line_too_long");
				}
				if (buf.length > MAX_LINE_BYTES) {
					// An endless line: drop it up to the next newline.
					buf = "";
					discarding = true;
					log.warn("notify.helper_line_too_long");
				}
			});

			child.on("error", (err) => {
				if (killTimer) clock.clearTimeout(killTimer);
				if (settled) return;
				log.warn("notify.helper_error_event", { error: errText(err) });
				if (!posted) settle("fallback");
				else {
					handle.finish("error");
					settle("done");
				}
			});
			child.on("close", (code) => {
				if (killTimer) clock.clearTimeout(killTimer);
				if (settled) return;
				if (code === 2 && !posted) {
					log.warn("notify.helper_unavailable");
					settle("fallback");
					return;
				}
				if (!posted && code !== 0) log.warn("notify.helper_failed", { code: typeof code === "number" ? code : null });
				handle.finish(exitWhy || (code === 0 ? "closed" : "error"));
				settle("done");
			});
		});
	}

	/**
	 * Plain gdbus call: no actions, no click.
	 * @param {NotifyHandle} handle
	 * @param {{ summary: string, body: string, urgency: Urgency, timeoutMs: number }} p
	 * @param {number} replacesId
	 * @returns {Promise<void>}
	 */
	function runFallback(handle, p, replacesId) {
		handle.clickable = false;
		return new Promise((resolve) => {
			const level = URGENCIES.indexOf(p.urgency);
			const args = [
				"call", "--session",
				"--dest", "org.freedesktop.Notifications",
				"--object-path", "/org/freedesktop/Notifications",
				"--method", "org.freedesktop.Notifications.Notify",
				gvString(APP_NAME), String(replacesId), "''",
				gvString(p.summary), gvString(p.body), "[]",
				`{'urgency': <byte ${level}>}`, `int32 ${p.timeoutMs}`,
			];
			let out = "";
			let ended = false;
			const end = (/** @type {string} */ why) => {
				if (ended) return;
				ended = true;
				handle.finish(why);
				resolve();
			};
			/** @type {ChildLike} */
			let child;
			try {
				child = spawn(gdbus, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
			} catch (err) {
				log.error("notify.fallback_spawn_failed", { error: errText(err) });
				end("error");
				return;
			}
			child.stdout?.on("data", (c) => {
				if (out.length < 512) out += c.toString();
			});
			child.stderr?.on("data", () => {});
			child.on("error", (err) => {
				log.error("notify.fallback_failed", { error: errText(err) });
				end("error");
			});
			child.on("close", (code) => {
				const m = /uint32\s+(\d+)/.exec(out);
				if (code === 0 && m) {
					const id = Number(m[1]);
					lastId.set(handle.key, id);
					handle.setId(id);
					log.info("notify.posted_fallback", { key: handle.key, id });
					end("fallback");
				} else {
					log.error("notify.fallback_failed", { code: typeof code === "number" ? code : null });
					end("error");
				}
			});
		});
	}

	/**
	 * @param {NotifyHandle} handle
	 * @param {NonNullable<ReturnType<typeof normalize>>} p
	 * @param {NotifyHandle | undefined} prior the notification of the same key that this one replaces
	 * @param {NotifyHandle | null} victim the oldest notification, when this one takes its place
	 */
	async function run(handle, p, prior, victim) {
		if (victim !== null) {
			// Closed on screen as well: a notification without a helper could not
			// report its click. A helper that does not answer is ended by signal.
			await victim.close();
		}
		if (prior) {
			// Its id first: without it the replacement would be a second
			// notification. Then the helper has to be gone before the next one
			// starts - the limit is on processes.
			await prior.ready;
			release(prior);
			await prior.done;
		}
		handle.waitsFor = null;
		// Superseded while it waited: a newer post took its place.
		if (handle.finished) return;
		if (handle.cancelled) {
			handle.finish("closed");
			return;
		}
		const replacesId = lastId.get(handle.key) ?? 0;
		const how = await runHelper(handle, p, replacesId);
		if (how === "fallback") await runFallback(handle, p, lastId.get(handle.key) ?? replacesId);
		if (live.get(handle.key) === handle) live.delete(handle.key);
	}

	/**
	 * Ask a superseded helper to leave: stdin EOF leaves the notification on
	 * screen, where the replacement takes its place. A helper that does not
	 * leave is ended by signal after the grace period.
	 * @param {NotifyHandle} prior
	 */
	function release(prior) {
		const child = prior.child;
		try {
			child?.stdin?.end();
		} catch {
			// already gone
		}
		if (child === null || prior.finished) return;
		const timer = clock.setTimeout(() => {
			if (!prior.finished) child.kill("SIGTERM");
		}, CLOSE_GRACE_MS);
		prior.done.then(() => clock.clearTimeout(timer));
	}

	/**
	 * A post that is not made. One log line per minute says how many.
	 * @param {string} key
	 * @param {"cooldown" | "busy" | "bad_host"} why
	 * @param {number} now
	 * @returns {NotifyHandle}
	 */
	function notMade(key, why, now) {
		notPosted += 1;
		if (now - notPostedLoggedAt >= 60_000) {
			log.warn("notify.not_posted", { why, count: notPosted });
			notPosted = 0;
			notPostedLoggedAt = now;
		}
		const handle = new NotifyHandle(key);
		handle.clickable = false;
		handle.finish(why);
		return handle;
	}

	/** @param {PostOptions} o */
	function normalize(o) {
		if (!o || typeof o.key !== "string" || !o.key) throw new TypeError("post: key is required");
		// Where the text names the host, a long name is shown by its right end.
		const shown = (/** @type {string} */ text) =>
			isValidHost(o.host) && o.host.length > MAX_HOST_SHOWN && typeof text === "string" ? text.split(o.host).join(displayHost(o.host)) : text;
		const urgency = o.urgency ?? "normal";
		if (!URGENCIES.includes(urgency)) throw new TypeError("post: bad urgency");
		const actions = (o.actions ?? []).map((a) => {
			if (!ACTION_KEY_RE.test(a.key)) throw new TypeError("post: bad action key");
			const label = safeText(a.label, MAX_LABEL);
			if (!label) throw new TypeError("post: empty action label");
			return { key: a.key, label };
		});
		const summary = safeText(shown(o.summary));
		if (!summary) throw new TypeError("post: empty summary");
		const timeoutMs = o.timeoutMs ?? (urgency === "critical" ? 0 : 10_000);
		const maxWaitS = o.maxWaitS ?? 3600;
		if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || !Number.isInteger(maxWaitS) || maxWaitS < 0) {
			throw new TypeError("post: bad timeout");
		}
		return { summary, body: safeText(shown(o.body ?? "")), urgency, actions, timeoutMs, maxWaitS };
	}

	return {
		/**
		 * @param {PostOptions} opts
		 * @returns {NotifyHandle}
		 */
		post(opts) {
			const p = normalize(opts);
			// Fail closed: the cooldown and the right-end rule are kept by host
			// name. A name they cannot be applied to gets no notification.
			if (opts.host !== undefined && !isValidHost(opts.host)) return notMade(opts.key, "bad_host", clock.now());
			const content = JSON.stringify(p);
			let prior = live.get(opts.key);
			const pending = prior !== undefined && !prior.finished && prior.id === null;
			// The same thing asked for again before it is even on screen: one post.
			if (prior !== undefined && pending && prior.content === content) return prior;

			const now = clock.now();
			const site = isValidHost(opts.host) ? siteOf(opts.host) : null;
			if (site !== null) {
				const last = lastBySite.get(site);
				if (last !== undefined && now - last < hostCooldownMs) return notMade(opts.key, "cooldown", now);
			}
			while (recent.length > 0 && recent[0] <= now - 60_000) recent.shift();
			if (recent.length >= maxPerMinute) return notMade(opts.key, "busy", now);
			// A replacement takes the place of the notification it replaces: its
			// helper starts when the replaced one has ended. So does a post that
			// finds every place taken: it takes the place of the oldest
			// notification that is on its own helper and not on its way out yet.
			let others = 0;
			/** @type {NotifyHandle | null} */
			let victim = null;
			for (const h of active) {
				if (h.finished || h === prior || h.evicted) continue;
				others++;
				if (victim === null && h.child !== null) victim = h;
			}
			if (others < maxHelpers) victim = null;
			else if (victim === null) return notMade(opts.key, "busy", now);

			if (prior !== undefined && pending && prior.waitsFor !== null) {
				// An update of an update that has not started yet: the newest one
				// takes its place in the line. So a key never has more than one
				// notification on its way out and one waiting behind it.
				const superseded = prior;
				prior = superseded.waitsFor ?? undefined;
				superseded.released = true;
				superseded.finish("replaced");
			}

			recent.push(now);
			if (site !== null) {
				lastBySite.set(site, now);
				if (lastBySite.size > 256) {
					for (const [s, at] of lastBySite) if (now - at >= hostCooldownMs) lastBySite.delete(s);
				}
			}
			const handle = new NotifyHandle(opts.key);
			handle.content = content;
			handle.waitsFor = prior !== undefined && !prior.finished ? prior : null;
			// The replaced one stops reporting at once; its helper is asked to leave in run().
			if (prior !== undefined) prior.released = true;
			if (victim !== null) {
				victim.evicted = true;
				victim.released = true;
				log.info("notify.oldest_replaced", { key: victim.key });
			}
			active.add(handle);
			handle.done.then(() => active.delete(handle));
			if (!desktop) {
				if (opts.hook !== false) runHook(opts.host, opts.jobId);
				if (!unsupportedLogged) {
					unsupportedLogged = true;
					log.info("notify.unsupported", { platform: options.platform ?? process.platform });
				}
				// A post that was made, and ended: so the caller counts its hook as run. Finished once the caller
				// has it, as any post that went out.
				handle.clickable = false;
				queueMicrotask(() => handle.finish("unsupported"));
				return handle;
			}
			live.set(opts.key, handle);
			playSound(opts.sound === true ? undefined : opts.sound);
			if (opts.hook !== false) runHook(opts.host, opts.jobId);
			run(handle, p, prior, victim).catch((err) => {
				log.error("notify.post_failed", { error: errText(err) });
				handle.finish("error");
			});
			return handle;
		},

		/**
		 * The thing a key stood for is over: nothing will be posted for it again,
		 * so the id of its notification is not kept for a replacement. A
		 * notification of the key that is still on its way out may yet report its
		 * id; that one is dropped when it has ended.
		 * @param {string} key
		 */
		forget(key) {
			lastId.delete(key);
			const last = live.get(key);
			if (last === undefined || last.finished) return;
			last.done.then(() => {
				// Unless the key was posted again in the meantime: then it is in use.
				if ((live.get(key) ?? last) === last) lastId.delete(key);
			});
		},

		/**
		 * Shutdown: ask each helper we started to close its notification, then
		 * SIGTERM by pid after a grace period. Nothing else is touched.
		 * @returns {Promise<void>}
		 */
		async closeAll() {
			for (const h of live.values()) h.cancelled = true;
			const mine = [...helpers];
			await Promise.all(mine.map((h) => h.close()));
		},
	};
}

/**
 * Whether the platform shows desktop notifications at all: not Windows.
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function desktopNotifications(platform = process.platform) {
	return platform !== "win32";
}

/** @param {unknown} err @returns {string} */
function errText(err) {
	return err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
}
