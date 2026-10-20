import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { LOGIN_LIMITS } from "../../extension/shared/optin.js";
import { BUILTIN_ENGINES, DEFAULT_ENGINE, ENGINE_NAME_RE, WEB_SEARCH_LIMITS, templateProblem } from "./search.js";
import { LIMITS as WIRE } from "../../extension/shared/protocol.js";
import { ALLOW_ENTRY_RE, DEFAULT_ALLOW_TYPES } from "../../extension/shared/sniff.js";

export const DEFAULT_PORT = 8791;

export const LIMITS = Object.freeze({
	maxBodyBytes: 1048576,
	wsMaxPayload: 16777216,
	maxResultBytes: 8388608,
	// A hello or auth frame is small; nothing larger is parsed before auth.
	maxHandshakeFrameBytes: 131072,
	// All a peer may send before it is ready (two such frames). The connection
	// is cut beyond that, so a pending handshake cannot make the WebSocket
	// parser buffer megabytes.
	maxPreAuthBytes: 262144,
	// How long a challenge page waits, parked, for the operator (the fetch
	// route's value for wait.human_wait_ms). The extension reports the expiry;
	// the daemon's own timer runs parkGraceMs longer and only fires if it does not.
	challengeTtlMs: 900000,
	parkGraceMs: 60000,
	// Challenge pages that may wait at the same time. One per site.
	maxParked: 3,
	// What a challenge may add to the run of a job: the longest grace period in
	// which it may clear by itself, and the settling of the page behind it.
	challengeGraceMs: 45000,
	// What a file may add to the run of a job: the time its bytes take from the extension to the daemon once the
	// response has ended (200 MiB over the loopback, with room).
	fileGraceMs: 20000,
	// The desktop notification of a pending challenge is posted again this often
	// until the operator has the page.
	challengeRepeatMs: 120000,
	pingIntervalMs: 20000,
	maxMissedPongs: 2,
	// Key and pairing code are 256-bit secrets: nothing throttles or counts
	// failed handshakes. A handshake is two small frames, so it is quick
	// or it is dropped, and enough may be pending that a few stalled peers
	// cannot keep the real extension out.
	handshakeTimeoutMs: 2000,
	maxPendingHandshakes: 32,
	pairingTtlMs: 600000,
	maxQueued: 64,
	maxQueueMs: 120000,
	// Longest a dispatched job may hold its slot, whatever its wait values add
	// up to: room for the longest page-load limit an operator can set
	// (fetch.load_timeout_s), settling, dwell and a challenge's grace period.
	// With maxQueueMs this bounds the life of any job: 6 minutes.
	maxRunMs: 240000,
	runGraceMs: 5000,
	cancelGraceMs: 5000,
	headersTimeoutMs: 10000,
	requestTimeoutMs: 30000,
	// Connections that may be open at once. Far more than agents, the command line and the extension ever hold; a
	// process that opens connections without end is turned away at this number instead of using up descriptors.
	maxConnections: 256,
	maxConfigBytes: 65536,
	// Refusals logged per minute and reason before they are only counted.
	refusalLogBurst: 5,
	refusalLogIntervalMs: 60000,
});

/**
 * Upper bounds for the wait values of one job. The fetch service stays inside
 * them, POST /v1/jobs is clamped to them. Together with the two grace periods
 * (runGraceMs, challengeGraceMs) the first three stay below LIMITS.maxRunMs;
 * waiting for the operator (human_wait_ms) is no part of a run.
 */
export const JOB_WAIT_MAX = Object.freeze({ timeout_ms: 120000, settle_ms: 5000, dwell_ms: 10000, human_wait_ms: 120000 });

export const EXIT = Object.freeze({
	OK: 0,
	FAILED: 1,
	/** Bad environment variable or config file. */
	CONFIG: 2,
	/** Another process holds the port. */
	PORT_IN_USE: 3,
	/** The socket handed over by systemd is not 127.0.0.1:<port>. */
	BAD_SOCKET: 4,
});

/**
 * Gaps in milliseconds as [min, max]. Host gaps are skewed towards the lower
 * end; see queue.js. Gaps and the hourly budget are kept per site (site.js),
 * not per host name. No hourlyBudget means no budget.
 *
 * cooldownMs is [first, longest]: how long a site is left alone after it
 * blocked or challenged a job. Every further time in a row doubles it, up to
 * the longest; some jitter is added; a Retry-After of the site is honoured
 * where it asks for more. No cooldownMs means no cooldown.
 * @typedef {readonly [number, number]} Range
 * @typedef {{ readonly hostGapMs: Range, readonly globalGapMs: Range, readonly dwellMs: Range, readonly hourlyBudget?: number,
 *   readonly cooldownMs?: Range }} PacingProfile
 * @typedef {{ readonly polite: PacingProfile, readonly fast: PacingProfile }} Pacing
 * @typedef {"polite" | "fast"} ProfileName
 */

/** @param {number} min @param {number} max @returns {Range} */
const range = (min, max) => Object.freeze(/** @type {[number, number]} */ ([min, max]));

/** @type {Pacing} */
export const DEFAULT_PACING = Object.freeze({
	polite: Object.freeze({ hostGapMs: range(4000, 12000), globalGapMs: range(1000, 3000), dwellMs: range(1500, 5000), hourlyBudget: 120, cooldownMs: range(60000, 1800000) }),
	fast: Object.freeze({ hostGapMs: range(250, 1000), globalGapMs: range(100, 300), dwellMs: range(200, 600), hourlyBudget: 1200, cooldownMs: range(10000, 300000) }),
});

/** How a site's cooldown grows and when it is forgotten. */
export const COOLDOWN = Object.freeze({
	// Added on top, as a share of the cooldown: 0 up to this.
	jitter: 0.25,
	// A site that did not block for this long starts from the first step again.
	forgetMs: 3600000,
	// Longest Retry-After that is honoured.
	maxRetryAfterMs: 3600000,
});

/**
 * Pages that are loaded with the operator's own login (a URL inside one of
 * their opt-in rules): the extension allows one per minGapMs and perHour an
 * hour for each rule, and refuses the rest. The queue paces to the same
 * numbers per opt-in host, with a little room, so that it rarely comes to
 * that.
 * @typedef {{ readonly minGapMs: number, readonly perHour: number, readonly marginMs: number }} LoginPacing
 */
/** @type {LoginPacing} */
export const LOGIN_PACING = Object.freeze({ minGapMs: LOGIN_LIMITS.minGapMs, perHour: LOGIN_LIMITS.perHour, marginMs: 250 });

export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_CACHE_TTL_S = 600;
/**
 * How long a page may take to load (fetch.load_timeout_s), in seconds. The
 * longest is JOB_WAIT_MAX.timeout_ms: what a slow VPN exit may need, and still
 * inside LIMITS.maxRunMs with everything a job can add to it.
 */
export const LOAD_TIMEOUT_S = Object.freeze({ fallback: 30, min: 5, max: 120 });
/**
 * How long after a challenge page was parked the operator is first notified
 * (notify.challenge_delay_s), in seconds. A check that clears by itself within
 * that time notifies nobody.
 */
export const CHALLENGE_DELAY_S = Object.freeze({ fallback: 30, min: 0, max: 300 });

/**
 * The largest file a job may bring back (files.max_mb), in MiB. The longest is what the wire carries at all
 * (the protocol's MAX_FILE_BYTES).
 */
export const FILE_MAX_MB = Object.freeze({ fallback: 25, min: 1, max: WIRE.MAX_FILE_BYTES / 1048576 });
/**
 * What all retrieved files together may take on disk (files.max_total_mb), in MiB. Never less than one file may
 * have (files.max_mb): a file that is allowed must also fit.
 */
export const FILE_TOTAL_MB = Object.freeze({ fallback: 2048, min: 1, max: 1048576 });

/**
 * What all stored pages together may take (pages.max_total_mb), in MiB: their files, and what the index holds to
 * search them. The least is room for the largest page there can be.
 */
export const PAGE_TOTAL_MB = Object.freeze({ fallback: 2048, min: 32, max: 1048576 });

/** A start that fails because of what the operator configured. */
export class ConfigError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "ConfigError";
	}
}

/**
 * @typedef {object} Config
 * @property {number} port
 * @property {string} configDir
 * @property {string} dataDir
 */

/**
 * An absolute Windows path as the gateway takes it: a drive letter and a separator, or a share (two separators, a
 * server, a share). Never one that hangs on a current drive or directory: "\\foo" counts as absolute to Node but not
 * to every Python, and the daemon, cli/bgw and the daemon controller must agree (the same rule is in both).
 */
export const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;

/** @param {string | undefined} p @returns {boolean} */
export function windowsAbsolute(p) {
	return typeof p === "string" && WINDOWS_ABSOLUTE.test(p);
}

/**
 * Resolve settings from the environment. Pure: touches no files.
 * The defaults are built from the home directory on purpose - XDG variables are
 * remapped inside Flatpak sandboxes and would point the CLI and the daemon at
 * different places. On Windows they lie under %LOCALAPPDATA%, which must then be
 * set to an absolute path; the command line follows the same rule.
 * @param {Record<string, string | undefined>} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {Config}
 */
export function loadConfig(env = process.env, platform = process.platform) {
	const rawPort = env.BGW_PORT;
	let port = DEFAULT_PORT;
	if (rawPort !== undefined && rawPort !== "") {
		if (!/^[0-9]{1,5}$/.test(rawPort) || Number(rawPort) > 65535) throw new Error(`invalid BGW_PORT: ${rawPort}`);
		port = Number(rawPort);
	}
	const windows = platform === "win32";
	const p = windows ? path.win32 : path;
	/** @param {"config" | "data"} what @returns {string} */
	const fallback = (what) => {
		if (!windows) {
			const home = os.homedir();
			return what === "config" ? path.join(home, ".config", "browser-gateway") : path.join(home, ".local", "share", "browser-gateway");
		}
		// Asked for only where no override names the directory.
		const base = env.LOCALAPPDATA;
		if (!windowsAbsolute(base)) {
			throw new Error(`LOCALAPPDATA is not set to an absolute path: set it, or BGW_${what === "config" ? "CONFIG" : "DATA"}_DIR`);
		}
		return p.join(/** @type {string} */ (base), "browser-gateway", what);
	};
	const configDir = env.BGW_CONFIG_DIR || fallback("config");
	const dataDir = env.BGW_DATA_DIR || fallback("data");
	for (const [name, dir] of [
		["BGW_CONFIG_DIR", configDir],
		["BGW_DATA_DIR", dataDir],
	]) {
		// Windows: a drive or a share, as for LOCALAPPDATA.
		if (windows ? !windowsAbsolute(dir) : !p.isAbsolute(dir)) throw new Error(`${name} must be an absolute path`);
	}
	return { port, configDir: p.normalize(configDir), dataDir: p.normalize(dataDir) };
}

/**
 * Windows: does a directory of the gateway lie outside the user profile (%USERPROFILE%)? Its permissions are not
 * checked there (no mode bits): what keeps others out is the ACL of the profile, which a directory elsewhere may not
 * have. Compared without regard to case, normalised, at a separator. Also true where USERPROFILE is not a drive or a
 * share. Never true off Windows.
 * @param {string} dir
 * @param {Record<string, string | undefined>} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function outsideUserProfile(dir, env = process.env, platform = process.platform) {
	if (platform !== "win32") return false;
	const profile = env.USERPROFILE;
	if (!windowsAbsolute(profile)) return true;
	const norm = (/** @type {string} */ p) => path.win32.normalize(p).replace(/[\\]+$/, "").toLowerCase();
	const base = norm(/** @type {string} */ (profile));
	const target = norm(dir);
	return target !== base && !target.startsWith(`${base}\\`);
}

/** @param {fs.Stats} st @param {string} what */
function assertOwned(st, what) {
	if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
		throw new Error(`${what} is not owned by the current user`);
	}
}

/**
 * Check a directory that may not be there: it must be one of the current user's, and is tightened to 0700 if it
 * is looser. Nothing is created. Looked at and changed through one descriptor, so that both are about the same
 * directory. Windows opens no directory and has no mode bits: there it must be a real directory, not a link or a
 * junction, and what keeps others out is the ACL of the user profile it lies in. Nothing is tightened there.
 * @param {string} dir absolute path
 * @param {NodeJS.Platform} [platform]
 * @returns {{ exists: boolean, tightened: boolean }}
 */
export function checkPrivateDir(dir, platform = process.platform) {
	if (!path.isAbsolute(dir)) throw new Error("directory path must be absolute");
	if (platform === "win32") {
		/** @type {fs.Stats} */
		let st;
		try {
			st = fs.lstatSync(dir);
		} catch (err) {
			const code = /** @type {NodeJS.ErrnoException} */ (err).code;
			if (code === "ENOENT") return { exists: false, tightened: false };
			if (code === "ENOTDIR") throw new Error(`${dir} is not a directory`);
			throw err;
		}
		if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a directory`);
		return { exists: true, tightened: false };
	}
	/** @type {number} */
	let fd;
	try {
		fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
	} catch (err) {
		const code = /** @type {NodeJS.ErrnoException} */ (err).code;
		if (code === "ENOENT") return { exists: false, tightened: false };
		if (code === "ENOTDIR") throw new Error(`${dir} is not a directory`);
		throw err;
	}
	try {
		const st = fs.fstatSync(fd);
		if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
		assertOwned(st, dir);
		if ((st.mode & 0o777) === 0o700) return { exists: true, tightened: false };
		fs.fchmodSync(fd, 0o700);
		return { exists: true, tightened: true };
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Create the directory if needed (0700) and tighten it if it is looser.
 * @param {string} dir absolute path
 * @param {NodeJS.Platform} [platform]
 * @returns {{ tightened: boolean }}
 */
export function ensurePrivateDir(dir, platform = process.platform) {
	if (!path.isAbsolute(dir)) throw new Error("directory path must be absolute");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const { exists, tightened } = checkPrivateDir(dir, platform);
	if (!exists) throw new Error(`${dir} is not a directory`);
	return { tightened };
}

/**
 * Flush a directory, so that a rename inside it is on disk. Not every file system can; the rename stands either way.
 * @param {string} dir
 */
export function syncDir(dir) {
	/** @type {number | null} */
	let fd = null;
	try {
		fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
		fs.fsyncSync(fd);
	} catch {
		// best effort
	} finally {
		if (fd !== null) fs.closeSync(fd);
	}
}

/**
 * How often a rename is tried on Windows, and how long is waited before each further try. A scanner that opens a
 * file which was just written holds it for a moment, and the rename fails meanwhile (EPERM, EBUSY, EACCES).
 */
const RENAME_RETRY = Object.freeze({ attempts: 6, delayMs: 25 });
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** @param {number} ms */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * fs.renameSync, tried again a few times on Windows when the file is held for a moment. Elsewhere one plain rename.
 * The waits block: at most about 0.8 s in all, and only when something holds the file.
 * @param {string} from
 * @param {string} to
 * @param {{ platform?: NodeJS.Platform, rename?: (from: string, to: string) => void, sleep?: (ms: number) => void }} [opts]
 *   rename, sleep: tests only
 */
export function renameWithRetry(from, to, { platform = process.platform, rename = fs.renameSync, sleep = sleepSync } = {}) {
	if (platform !== "win32") return rename(from, to);
	return retryHeld(() => rename(from, to), sleep);
}

/**
 * fn, tried again while what it works on is held (EPERM, EBUSY, EACCES), with the waits of RENAME_RETRY.
 * @template T
 * @param {() => T} fn
 * @param {(ms: number) => void} sleep
 * @returns {T}
 */
function retryHeld(fn, sleep) {
	for (let attempt = 1; ; attempt++) {
		try {
			return fn();
		} catch (err) {
			const code = /** @type {NodeJS.ErrnoException} */ (err).code;
			if (attempt >= RENAME_RETRY.attempts || code === undefined || !RENAME_RETRY_CODES.has(code)) throw err;
			// 25, 50, 100, 200, 400 ms
			sleep(RENAME_RETRY.delayMs * 2 ** (attempt - 1));
		}
	}
}

/** What fs.rmSync is given for a tree on Windows: Node itself tries again while a file in it is held. */
const RM_RETRY = Object.freeze({ maxRetries: 5, retryDelay: 25 });

/**
 * @typedef {object} RemoveHow tests only
 * @property {NodeJS.Platform} [platform]
 * @property {(target: string, opts: fs.RmOptions) => void} [rm]
 * @property {(ms: number) => void} [sleep]
 */

/**
 * fs.rmSync, tried again on Windows while something holds what is removed: a tree with Node's own retries (RM_RETRY),
 * a single file as renameWithRetry does (Node retries only where recursive is set). Elsewhere one plain fs.rmSync.
 * @param {string} target
 * @param {fs.RmOptions} [opts]
 * @param {RemoveHow} [how]
 */
export function removeWithRetry(target, opts = {}, { platform = process.platform, rm = fs.rmSync, sleep = sleepSync } = {}) {
	if (platform !== "win32") return rm(target, opts);
	if (opts.recursive === true) return rm(target, { ...opts, ...RM_RETRY });
	return retryHeld(() => rm(target, opts), sleep);
}

/**
 * Remove what a step that failed left behind, from its catch or finally. On Windows with removeWithRetry, and a
 * failure of it is swallowed there, so that the error of the step is the one that is thrown. Elsewhere one plain
 * fs.rmSync, as before.
 * @param {string} target
 * @param {fs.RmOptions} [opts]
 * @param {RemoveHow} [how]
 */
export function removeLeftover(target, opts = {}, how = {}) {
	if ((how.platform ?? process.platform) !== "win32") return (how.rm ?? fs.rmSync)(target, opts);
	try {
		removeWithRetry(target, opts, how);
	} catch {
		// The step's own error is the one that counts; what stays has a temporary name.
	}
}

/**
 * Open a file, never through a link at its last component. Where there is O_NOFOLLOW the open itself refuses a link
 * (ELOOP). Windows has none: there the name is looked at first - no link or junction, a plain file - and the
 * descriptor is checked afterwards to be the file that was looked at (same dev and ino), so that a name swapped in
 * between is not taken either. Both are refused as ELOOP, which every caller already takes for "no usable file".
 * @param {string} file
 * @param {number} flags open flags, without O_NOFOLLOW
 * @param {number} [mode] for a file that is created
 * @param {NodeJS.Platform} [platform]
 * @returns {number} the descriptor; the caller closes it
 * @throws {NodeJS.ErrnoException} ELOOP for a link, for anything but a plain file on Windows, and for a name that
 *   changed under the open; whatever else the open throws (ENOENT, ...)
 */
export function openNoFollow(file, flags, mode = 0o600, platform = process.platform) {
	if (platform !== "win32") return fs.openSync(file, flags | fs.constants.O_NOFOLLOW, mode);
	const refused = () => Object.assign(new Error(`${file} is a link or not a regular file`), { code: "ELOOP" });
	/** @type {fs.BigIntStats | null} */
	let before = null;
	try {
		before = fs.lstatSync(file, { bigint: true });
	} catch (err) {
		// Not there: a file that is created is looked at once it is.
		if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err;
	}
	if (before !== null && (before.isSymbolicLink() || !before.isFile())) throw refused();
	const fd = fs.openSync(file, flags, mode);
	try {
		const st = fs.fstatSync(fd, { bigint: true });
		const named = before ?? fs.lstatSync(file, { bigint: true });
		if (named.isSymbolicLink() || !st.isFile() || st.dev !== named.dev || st.ino !== named.ino) throw refused();
		return fd;
	} catch (err) {
		fs.closeSync(fd);
		throw err;
	}
}

/**
 * Open a private file: never through a link at its last component, and checked on the open descriptor - a plain
 * file of the current user, tightened to 0600 if it is looser. What is checked is what is read or written
 * afterwards, whatever happens to the name in between. Windows has no mode bits to tighten: nothing is, there.
 * @param {string} file
 * @param {{ append?: boolean, platform?: NodeJS.Platform }} [opts] append: for writing at its end, and created (0600)
 *   if it is not there; otherwise for reading
 * @returns {{ fd: number, size: number, tightened: boolean } | null} null when the file does not exist; the caller closes fd
 */
export function openPrivateFile(file, { append = false, platform = process.platform } = {}) {
	const how = append ? fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT : fs.constants.O_RDONLY;
	/** @type {number} */
	let fd;
	try {
		// Not blocking: a name that is no file (a FIFO) must not hold the start until somebody writes to it.
		// Windows has no O_NONBLOCK (it adds nothing there), and refuses such a name before the open.
		fd = openNoFollow(file, how | fs.constants.O_NONBLOCK, 0o600, platform);
	} catch (err) {
		const code = /** @type {NodeJS.ErrnoException} */ (err).code;
		if (code === "ENOENT" && !append) return null;
		// A link (ELOOP), a socket or a FIFO nobody reads (ENXIO), a directory opened for writing (EISDIR).
		if (code === "ELOOP" || code === "ENXIO" || code === "EISDIR") throw new Error(`${file} is not a regular file`);
		throw err;
	}
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile()) throw new Error(`${file} is not a regular file`);
		assertOwned(st, file);
		const tightened = platform !== "win32" && (st.mode & 0o777) !== 0o600;
		if (tightened) fs.fchmodSync(fd, 0o600);
		return { fd, size: st.size, tightened };
	} catch (err) {
		fs.closeSync(fd);
		throw err;
	}
}

/**
 * Tighten an existing file to 0600.
 * @param {string} file
 * @returns {{ exists: boolean, tightened: boolean }}
 */
export function ensurePrivateFile(file) {
	const opened = openPrivateFile(file);
	if (opened === null) return { exists: false, tightened: false };
	fs.closeSync(opened.fd);
	return { exists: true, tightened: opened.tightened };
}

/**
 * Atomic replace with mode 0600: the content is never visible half-written
 * and never readable by group or others. Whatever goes wrong, no copy of the
 * content is left under a temporary name.
 * @param {string} file
 * @param {string} content
 */
export function writePrivateFile(file, content) {
	const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
	const fd = fs.openSync(tmp, "wx", 0o600);
	try {
		try {
			fs.fchmodSync(fd, 0o600);
			fs.writeSync(fd, content);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		renameWithRetry(tmp, file);
	} catch (err) {
		removeLeftover(tmp, { force: true });
		throw err;
	}
	syncDir(path.dirname(file));
}

/**
 * @param {string} file
 * @param {(file: string) => void} [onTightened] called when the file was readable or writable by others and has been fixed
 * @param {number} [maxBytes] a larger file is not read
 * @returns {string | null} null when the file does not exist
 * @throws {Error} "is too large" for a file over maxBytes
 */
export function readPrivateFile(file, onTightened, maxBytes = Infinity) {
	const opened = openPrivateFile(file);
	if (opened === null) return null;
	try {
		if (opened.tightened && onTightened !== undefined) onTightened(file);
		if (opened.size > maxBytes) throw new Error("is too large");
		return fs.readFileSync(opened.fd, "utf8");
	} finally {
		fs.closeSync(opened.fd);
	}
}

/**
 * What <configDir>/config.json may set. Everything is optional.
 * @typedef {object} Settings
 * @property {number} retentionDays stored pages older than this are purged
 * @property {number} cacheTtlS how long a stored page answers a repeated fetch
 * @property {{ sound: boolean | string, hookCommand: readonly string[] | null, challengeDelayS: number }} notify challengeDelayS:
 *   seconds between the parking of a challenge page and the first notification of the operator
 * @property {{ loadTimeoutS: number }} fetch how long a page of a fetch or a search may take to load
 * @property {{ defaultProfile: ProfileName, fastHosts: readonly string[], hourlyBudget: { polite: number, fast: number } }} pacing
 * @property {{ defaultEngine: string, engines: Readonly<Record<string, string>> }} search the engine of a search that names
 *   none, and the operator's own engines: URL templates by name, on top of the built-in ones
 * @property {{ maxTotalMb: number }} pages how much all stored pages may take together; the oldest go first
 * @property {{ enabled: boolean, maxMb: number, maxTotalMb: number, allowTypes: readonly string[] }} files whether a fetch may
 *   bring back a file instead of a page, how large it may be, how much all stored files may take together, and of which
 *   types: media types, and "+suffix" for every type that ends so
 */

/** @returns {Settings} */
export function defaultSettings() {
	return {
		retentionDays: DEFAULT_RETENTION_DAYS,
		cacheTtlS: DEFAULT_CACHE_TTL_S,
		notify: { sound: true, hookCommand: null, challengeDelayS: CHALLENGE_DELAY_S.fallback },
		fetch: { loadTimeoutS: LOAD_TIMEOUT_S.fallback },
		pacing: {
			defaultProfile: "polite",
			fastHosts: [],
			hourlyBudget: { polite: DEFAULT_PACING.polite.hourlyBudget ?? 0, fast: DEFAULT_PACING.fast.hourlyBudget ?? 0 },
		},
		search: { defaultEngine: DEFAULT_ENGINE, engines: {} },
		pages: { maxTotalMb: PAGE_TOTAL_MB.fallback },
		files: { enabled: true, maxMb: FILE_MAX_MB.fallback, maxTotalMb: FILE_TOTAL_MB.fallback, allowTypes: DEFAULT_ALLOW_TYPES },
	};
}

const HOST_NAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Check the parsed content of config.json. Strict: unknown keys, wrong types
 * and values out of range are errors, never ignored - a typo must not leave
 * the operator with a setting that silently does not apply.
 * @param {unknown} raw
 * @param {{ blocklist?: readonly string[], allowLoopbackPorts?: readonly number[] }} [policy] the URL policy a search
 *   template must pass, as every URL a job loads
 * @returns {Settings}
 */
export function parseSettings(raw, policy = {}) {
	const out = defaultSettings();
	/** @param {string} what @returns {never} */
	const bad = (what) => {
		throw new ConfigError(`config.json: ${what}`);
	};
	/** @param {unknown} v @param {string} name @param {readonly string[]} keys @returns {Record<string, unknown>} */
	const object = (v, name, keys) => {
		if (typeof v !== "object" || v === null || Array.isArray(v)) return bad(`${name} must be an object`);
		for (const key of Object.keys(v)) {
			if (!keys.includes(key)) return bad(`unknown key ${JSON.stringify(key.slice(0, 40))} in ${name}`);
		}
		return /** @type {Record<string, unknown>} */ (v);
	};
	/** @param {unknown} v @param {string} name @param {number} min @param {number} max @returns {number} */
	const integer = (v, name, min, max) => {
		if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) return bad(`${name} must be an integer from ${min} to ${max}`);
		return v;
	};

	const top = object(raw, "the top level", ["retention_days", "cache_ttl_s", "notify", "fetch", "pacing", "search", "pages", "files"]);
	if (top.retention_days !== undefined) out.retentionDays = integer(top.retention_days, "retention_days", 1, 3650);
	if (top.cache_ttl_s !== undefined) out.cacheTtlS = integer(top.cache_ttl_s, "cache_ttl_s", 0, 86400);

	if (top.notify !== undefined) {
		const n = object(top.notify, "notify", ["sound", "hook_command", "challenge_delay_s"]);
		if (n.challenge_delay_s !== undefined) out.notify.challengeDelayS = integer(n.challenge_delay_s, "notify.challenge_delay_s", CHALLENGE_DELAY_S.min, CHALLENGE_DELAY_S.max);
		if (n.sound !== undefined) {
			const ok = typeof n.sound === "boolean" || (typeof n.sound === "string" && path.isAbsolute(n.sound) && n.sound.length <= 4096 && !n.sound.includes("\0"));
			if (!ok) bad("notify.sound must be true, false or the absolute path of a sound file");
			out.notify.sound = /** @type {boolean | string} */ (n.sound);
		}
		if (n.hook_command !== undefined) {
			const cmd = n.hook_command;
			const ok =
				Array.isArray(cmd) &&
				cmd.length >= 1 &&
				cmd.length <= 32 &&
				cmd.every((a) => typeof a === "string" && a.length > 0 && a.length <= 4096 && !a.includes("\0")) &&
				path.isAbsolute(cmd[0]);
			// An argv array, started without a shell; the program by absolute path so PATH cannot choose it.
			if (!ok) bad("notify.hook_command must be an array of 1 to 32 non-empty strings, the first an absolute path");
			out.notify.hookCommand = Object.freeze([.../** @type {string[]} */ (cmd)]);
		}
	}

	if (top.fetch !== undefined) {
		const f = object(top.fetch, "fetch", ["load_timeout_s"]);
		if (f.load_timeout_s !== undefined) out.fetch.loadTimeoutS = integer(f.load_timeout_s, "fetch.load_timeout_s", LOAD_TIMEOUT_S.min, LOAD_TIMEOUT_S.max);
	}

	if (top.pacing !== undefined) {
		const p = object(top.pacing, "pacing", ["default_profile", "fast_hosts", "hourly_budget"]);
		if (p.default_profile !== undefined) {
			if (p.default_profile !== "polite" && p.default_profile !== "fast") bad('pacing.default_profile must be "polite" or "fast"');
			out.pacing.defaultProfile = /** @type {ProfileName} */ (p.default_profile);
		}
		if (p.fast_hosts !== undefined) {
			const hosts = p.fast_hosts;
			if (!Array.isArray(hosts) || hosts.length > 256 || !hosts.every((h) => typeof h === "string" && HOST_NAME_RE.test(h))) {
				bad("pacing.fast_hosts must be an array of at most 256 lower-case host names with at least two labels");
			}
			out.pacing.fastHosts = Object.freeze([.../** @type {string[]} */ (hosts)]);
		}
		if (p.hourly_budget !== undefined) {
			const b = object(p.hourly_budget, "pacing.hourly_budget", ["polite", "fast"]);
			if (b.polite !== undefined) out.pacing.hourlyBudget.polite = integer(b.polite, "pacing.hourly_budget.polite", 1, 100000);
			if (b.fast !== undefined) out.pacing.hourlyBudget.fast = integer(b.fast, "pacing.hourly_budget.fast", 1, 100000);
		}
	}

	if (top.pages !== undefined) {
		const p = object(top.pages, "pages", ["max_total_mb"]);
		if (p.max_total_mb !== undefined) out.pages.maxTotalMb = integer(p.max_total_mb, "pages.max_total_mb", PAGE_TOTAL_MB.min, PAGE_TOTAL_MB.max);
	}

	if (top.files !== undefined) {
		const f = object(top.files, "files", ["enabled", "max_mb", "max_total_mb", "allow_types"]);
		if (f.enabled !== undefined) {
			if (typeof f.enabled !== "boolean") bad("files.enabled must be true or false");
			out.files.enabled = /** @type {boolean} */ (f.enabled);
		}
		if (f.max_mb !== undefined) out.files.maxMb = integer(f.max_mb, "files.max_mb", FILE_MAX_MB.min, FILE_MAX_MB.max);
		if (f.max_total_mb !== undefined) out.files.maxTotalMb = integer(f.max_total_mb, "files.max_total_mb", FILE_TOTAL_MB.min, FILE_TOTAL_MB.max);
		// A file that may be retrieved must be one that can be stored.
		if (out.files.maxTotalMb < out.files.maxMb) bad(`files.max_total_mb (${out.files.maxTotalMb}) must not be smaller than files.max_mb (${out.files.maxMb})`);
		if (f.allow_types !== undefined) {
			const types = f.allow_types;
			// Lower case, no parameters: what a declared type is compared with after it was cut down to that.
			const ok = Array.isArray(types) && types.length <= WIRE.MAX_FILE_TYPES && types.every((t) => typeof t === "string" && ALLOW_ENTRY_RE.test(t)) && new Set(types).size === types.length;
			if (!ok) bad(`files.allow_types must be an array of at most ${WIRE.MAX_FILE_TYPES} different lower-case media types ("application/pdf") or suffixes ("+json")`);
			// Web pages are pages: listing them here would not make them files, so it is refused instead of ignored.
			if (/** @type {string[]} */ (types).some((t) => t === "text/html" || t === "application/xhtml+xml")) bad("files.allow_types cannot hold text/html or application/xhtml+xml: those are pages");
			out.files.allowTypes = Object.freeze([.../** @type {string[]} */ (types)]);
		}
	}

	if (top.search !== undefined) {
		const s = object(top.search, "search", ["default_engine", "engines"]);
		/** @type {Record<string, string>} */
		const engines = {};
		if (s.engines !== undefined) {
			const e = object(s.engines, "search.engines", Object.keys(typeof s.engines === "object" && s.engines !== null ? s.engines : {}));
			const names = Object.keys(e);
			if (names.length > WEB_SEARCH_LIMITS.maxEngines) bad(`search.engines may hold at most ${WEB_SEARCH_LIMITS.maxEngines} engines`);
			for (const name of names) {
				if (!ENGINE_NAME_RE.test(name)) bad("search.engines: an engine name is 1 to 32 characters of a-z, 0-9, - and _, beginning with a letter or digit");
				const problem = templateProblem(e[name], policy);
				if (problem !== null) bad(`search.engines.${name} ${problem}`);
				engines[name] = /** @type {string} */ (e[name]);
			}
		}
		out.search.engines = Object.freeze(engines);
		if (s.default_engine !== undefined) {
			const name = s.default_engine;
			if (typeof name !== "string" || !(Object.hasOwn(BUILTIN_ENGINES, name) || Object.hasOwn(engines, name))) {
				bad(`search.default_engine must be one of: ${[...new Set([...Object.keys(BUILTIN_ENGINES), ...Object.keys(engines)])].join(", ")}`);
			}
			out.search.defaultEngine = /** @type {string} */ (name);
		}
	}
	return out;
}

/**
 * Read <configDir>/config.json. No file means defaults; a file that cannot be
 * used stops the start.
 * @param {string} configDir
 * @param {(file: string) => void} [onTightened]
 * @param {{ blocklist?: readonly string[], allowLoopbackPorts?: readonly number[] }} [policy] for the search templates
 * @returns {Settings}
 */
export function loadSettings(configDir, onTightened, policy = {}) {
	const file = path.join(configDir, "config.json");
	/** @type {string | null} */
	let text;
	try {
		text = readPrivateFile(file, onTightened, LIMITS.maxConfigBytes);
	} catch (err) {
		throw new ConfigError(`config.json: ${err instanceof Error ? err.message : "cannot be read"}`);
	}
	if (text === null) return defaultSettings();
	/** @type {unknown} */
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new ConfigError("config.json: not valid JSON");
	}
	return parseSettings(raw, policy);
}

/**
 * systemd socket activation (sd_listen_fds): the descriptors a service
 * manager passes start at 3, their number is in LISTEN_FDS, and they are meant
 * for the process whose id is in LISTEN_PID - anyone else who merely inherited
 * the variables must ignore them.
 * @param {Record<string, string | undefined>} env
 * @param {number} pid
 * @returns {number | null} the descriptor to listen on, or null when no socket was handed to this process
 * @throws {Error} when sockets were handed over, but not exactly one
 */
export function inheritedListenFd(env, pid) {
	const count = env.LISTEN_FDS;
	if (count === undefined || count === "" || env.LISTEN_PID !== String(pid)) return null;
	if (count !== "1") throw new Error(`expected exactly one socket from the service manager, LISTEN_FDS is ${JSON.stringify(count.slice(0, 20))}`);
	return 3;
}
