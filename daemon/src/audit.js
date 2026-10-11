import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensurePrivateDir, openPrivateFile, syncDir } from "./config.js";
import { SNIFFED_TYPES } from "../../extension/shared/sniff.js";

/**
 * @typedef {object} AuditEntry
 * @property {string | null} job null for a call that never became a job (cache hit, page read, search, refusal by the fetch service)
 * @property {string} kind fetch, probe, read or search
 * @property {string | null} url the URL that was asked for
 * @property {string | null} [host] its host, when it has one
 * @property {string} outcome
 * @property {string | null} code error or policy reason code
 * @property {"container" | "default" | null} cookie_scope
 * @property {boolean} [dispatched] the browser was asked to load the URL
 * @property {number} duration_ms
 * @property {readonly string[]} [redirect_origins]
 * @property {number} [callers] calls that shared this job (more than one when identical requests were joined)
 * @property {"hit"} [cache] the call was answered from the page store
 * @property {string | null} [page] page id that was served or read
 * @property {number} [hits] search results returned
 * @property {Readonly<Record<string, number>>} [timings] where the time of a browser job went, in milliseconds by
 *   phase (the extension's render.timings, and elapsed_ms): numbers only
 * @property {string | null} [file_type] of a retrieved or refused file: what its first bytes say it is, in the
 *   sniffer's own words. Never the type or the name a server gave it
 * @property {number} [file_size] its size in bytes
 */

const MAX_URL = 2048;
const MAX_TIMINGS = 16;

/** How large the audit log may grow, and what is held back while it cannot be written. */
export const AUDIT_LIMITS = Object.freeze({
	// Before a line would take audit.jsonl past this many bytes, the file is set aside as audit.jsonl.1 and a new
	// one begun; the one set aside before that goes. The log takes twice this at most, whatever is asked how often.
	maxBytes: 33554432,
	// Entries kept in memory while the file cannot be written, and written once it can be. Work is refused
	// meanwhile, so only what was under way at that moment comes here; beyond this number they are counted.
	maxPending: 256,
	// A line longer than this is no entry of this log.
	maxLineBytes: 65536,
});

/** What a leftover of an interrupted rewrite is called. */
const TEMP_RE = /^audit\.jsonl(?:\.1)?\.[0-9a-f]{12}\.tmp$/;
/** The time of an entry, where every line of this log begins. */
const LINE_TS_RE = /^\{"ts":"([0-9TZ:.+-]{20,35})"/;

/**
 * @param {number} fd
 * @param {Buffer} data all of it is written, or the call throws
 */
function writeAll(fd, data) {
	let done = 0;
	while (done < data.length) done += fs.writeSync(fd, data, done, data.length - done);
}

/**
 * Phase timings as they are written down: plain names and whole, non-negative numbers. Anything else is left out.
 * @param {unknown} timings
 * @returns {Record<string, number>}
 */
function cleanTimings(timings) {
	/** @type {Record<string, number>} */
	const out = {};
	if (typeof timings !== "object" || timings === null || Array.isArray(timings)) return out;
	for (const [name, value] of Object.entries(timings)) {
		if (Object.keys(out).length >= MAX_TIMINGS) break;
		if (/^[a-z][a-z_]{0,31}$/.test(name) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out[name] = value;
	}
	return out;
}

/**
 * The asked-for URL as it is written down: no user name or password.
 * @param {string} url
 * @returns {string}
 */
function withoutUserinfo(url) {
	const text = url.slice(0, MAX_URL);
	if (!text.includes("@")) return text;
	try {
		const u = new URL(text);
		if (u.username === "" && u.password === "") return text;
		u.username = "";
		u.password = "";
		return u.href.slice(0, MAX_URL);
	} catch {
		// Not a URL: cut at the last "@" of the authority-looking part.
		return text.replace(/\/\/[^/?#]*@/, "//");
	}
}

/**
 * @param {readonly unknown[]} hops
 * @returns {string[]} scheme://host[:port] only - never a path or query
 */
export function toOrigins(hops) {
	/** @type {string[]} */
	const out = [];
	for (const hop of hops) {
		if (typeof hop !== "string") continue;
		try {
			const u = new URL(hop);
			if (u.protocol === "http:" || u.protocol === "https:") out.push(u.origin);
		} catch {
			// not a URL: dropped rather than logged verbatim
		}
	}
	return out;
}

/**
 * JSONL record of every job and every tool call: what was asked
 * for and how it ended. Page content, cookies and headers never reach this
 * file, and of a retrieved file only what it is and how large. A load that used the operator's own
 * session, or whose cookie store is not known, leaves its host only: no path,
 * no query, no redirect origins. A request the policy refused leaves the origin
 * of what was asked for, and nothing where that is no address.
 *
 * Entries are only ever added at the end. Two things take entries away again:
 * purge() those older than the retention of the store, by writing the rest to a
 * new file that takes the place of the old one in one step; and the size limit,
 * by setting the whole file aside as audit.jsonl.1 (one such file, replaced the
 * next time).
 *
 * A write that fails does not end the log. The entry stays in memory, the file
 * is opened again on the next occasion, and "ok" is false - the daemon refuses
 * new work - exactly as long as there is something that could not be written.
 * Should more entries wait than are kept in memory (AUDIT_LIMITS.maxPending),
 * the rest is counted, and the count is written down as an entry of its own:
 * kind "audit", outcome "entries_lost", and how many in "lost".
 */
export class AuditLog {
	#clock;
	#log;
	#maxBytes;
	/** @type {number | null} */
	#fd = null;
	/** Bytes in audit.jsonl, as far as this process wrote or found them. */
	#size = 0;
	/** Between open() and close(). */
	#opened = false;
	/** @type {string[]} lines that are not in the file yet */
	#pending = [];
	/** Entries that were not even kept in memory. */
	#lost = 0;
	/** A write failed and none succeeded since: said once, not on every try. */
	#down = false;

	/**
	 * @param {{ dataDir: string, clock: import("./log.js").Clock, log: import("./log.js").Logger, maxBytes?: number }} opts
	 *   maxBytes: tests only, another size limit than AUDIT_LIMITS.maxBytes
	 */
	constructor({ dataDir, clock, log, maxBytes = AUDIT_LIMITS.maxBytes }) {
		this.dataDir = dataDir;
		this.file = path.join(dataDir, "audit.jsonl");
		this.rotated = `${this.file}.1`;
		this.#clock = clock;
		this.#log = log;
		this.#maxBytes = maxBytes;
	}

	open() {
		if (ensurePrivateDir(this.dataDir).tightened) this.#log.warn("config.dir_mode_fixed", { dir: this.dataDir });
		// What a rewrite left behind when the process ended in the middle of it: the file it was meant to replace is whole.
		for (const name of fs.readdirSync(this.dataDir)) {
			if (TEMP_RE.test(name)) fs.rmSync(path.join(this.dataDir, name), { force: true });
		}
		this.#openFile();
		try {
			// A log from before there was a limit can be any size: it is set aside now, and purge() cuts it down.
			if (this.#size > this.#maxBytes) this.#rotate();
		} catch (err) {
			this.#closeFile();
			throw err;
		}
		this.#opened = true;
	}

	/** Open audit.jsonl for appending: a plain file of the current user, 0600, never through a link. */
	#openFile() {
		const opened = openPrivateFile(this.file, { append: true });
		if (opened === null) throw new Error("audit log cannot be opened");
		if (opened.tightened) this.#log.warn("audit.file_mode_fixed", { file: this.file });
		this.#fd = opened.fd;
		this.#size = opened.size;
	}

	#closeFile() {
		if (this.#fd === null) return;
		const fd = this.#fd;
		this.#fd = null;
		try {
			fs.closeSync(fd);
		} catch {
			// nothing more to do with it
		}
	}

	/** Set the file aside as audit.jsonl.1, in place of the one that was there, and begin a new one. */
	#rotate() {
		const bytes = this.#size;
		this.#closeFile();
		fs.renameSync(this.file, this.rotated);
		syncDir(this.dataDir);
		this.#openFile();
		this.#log.info("audit.rotated", { bytes });
	}

	/**
	 * Write what is waiting. After a failure the file is opened anew, so a disk that has room again, or a file
	 * that was moved away, is found out here.
	 * @returns {boolean} true when nothing is waiting any more
	 */
	#flush() {
		try {
			if (this.#fd === null) this.#openFile();
			const lines = this.#pending.length;
			let text = this.#pending.join("");
			if (this.#lost > 0) {
				text += `${JSON.stringify({ ts: new Date(this.#clock.now()).toISOString(), job: null, kind: "audit", url: null, host: null, outcome: "entries_lost", code: null, cookie_scope: null, duration_ms: 0, redirect_origins: [], lost: this.#lost })}\n`;
			}
			const data = Buffer.from(text, "utf8");
			if (this.#size > 0 && this.#size + data.length > this.#maxBytes) this.#rotate();
			if (data.length > 0) writeAll(/** @type {number} */ (this.#fd), data);
			this.#size += data.length;
			this.#pending.length = 0;
			this.#lost = 0;
			if (this.#down) {
				this.#down = false;
				this.#log.info("audit.write_recovered", { entries: lines });
			}
			return true;
		} catch (err) {
			if (this.#fd !== null) {
				try {
					// Whatever part of the lines got there is taken back: they are written whole or not at all.
					fs.ftruncateSync(this.#fd, this.#size);
				} catch {
					// the next line begins after a torn one, then
				}
				this.#closeFile();
			}
			if (!this.#down) {
				this.#down = true;
				this.#log.error("audit.write_failed", { message: err instanceof Error ? err.message : "unknown" });
			}
			return false;
		}
	}

	/**
	 * False while the log cannot be written; the daemon then refuses new jobs. Asking is trying: an entry that is
	 * waiting is written here if it can be.
	 */
	get ok() {
		if (!this.#opened) return false;
		if (this.#fd !== null && this.#pending.length === 0 && this.#lost === 0) return true;
		return this.#flush();
	}

	/** @param {AuditEntry} entry */
	append(entry) {
		const inContainer = entry.cookie_scope === "container";
		// A request that was refused before the browser saw it is no page load:
		// what was asked for is the whole record.
		const hostOnly = !inContainer && (entry.cookie_scope === "default" || entry.dispatched === true);
		// Refused by the policy, it can be anything a caller made up, as long and as often as it likes: of that the
		// origin is the record, and nothing where it has none.
		const refused = entry.outcome === "policy_blocked";
		/** @type {string | null} */
		let url = null;
		if (!hostOnly && typeof entry.url === "string") url = refused ? (toOrigins([entry.url.slice(0, MAX_URL)])[0] ?? null) : withoutUserinfo(entry.url);
		const line = JSON.stringify({
			ts: new Date(this.#clock.now()).toISOString(),
			job: entry.job,
			kind: entry.kind,
			url,
			host: typeof entry.host === "string" ? entry.host.slice(0, 255) : null,
			outcome: entry.outcome,
			code: entry.code,
			cookie_scope: entry.cookie_scope,
			duration_ms: Math.max(0, Math.round(entry.duration_ms)),
			redirect_origins: inContainer ? toOrigins(entry.redirect_origins ?? []) : [],
			...(entry.callers !== undefined && entry.callers > 1 ? { callers: entry.callers } : {}),
			...(entry.cache === undefined ? {} : { cache: entry.cache }),
			...(entry.page === undefined ? {} : { page: entry.page }),
			...(entry.hits === undefined ? {} : { hits: entry.hits }),
			...(entry.timings === undefined ? {} : { timings: cleanTimings(entry.timings) }),
			...(entry.file_type === undefined ? {} : { file_type: typeof entry.file_type === "string" && SNIFFED_TYPES.includes(entry.file_type) ? entry.file_type : null }),
			...(typeof entry.file_size === "number" && Number.isSafeInteger(entry.file_size) && entry.file_size >= 0 ? { file_size: entry.file_size } : {}),
		});
		if (!this.#opened) {
			// Before open() and after close() there is no log to write to, and none will come.
			this.#log.error("audit.write_failed", { message: "audit log is not open" });
			return;
		}
		if (this.#pending.length < AUDIT_LIMITS.maxPending) this.#pending.push(line + "\n");
		else this.#lost += 1;
		this.#flush();
	}

	/**
	 * Drop the entries that are older than maxAgeMs, from audit.jsonl and from audit.jsonl.1. The entries that stay
	 * are written to a new file in the same directory, flushed, and put in the place of the old one by a rename:
	 * whenever the process ends, the log is either as it was or as it should be. A file nothing is dropped from is
	 * not touched.
	 * @param {{ maxAgeMs: number }} opts
	 * @returns {{ entries: number }} how many were dropped
	 */
	purge({ maxAgeMs }) {
		if (!this.#opened) return { entries: 0 };
		if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new RangeError("maxAgeMs must be a non-negative number");
		const cutoff = this.#clock.now() - maxAgeMs;
		const entries = this.#purgeFile(this.rotated, cutoff, false) + this.#purgeFile(this.file, cutoff, true);
		return { entries };
	}

	/**
	 * @param {string} file
	 * @param {number} cutoff entries from before this moment go
	 * @param {boolean} live the file is the one that is being written to
	 * @returns {number} entries dropped
	 */
	#purgeFile(file, cutoff, live) {
		const source = openPrivateFile(file);
		if (source === null) return 0;
		const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
		/** @type {{ fd: number | null }} where the entries that stay are written, from the first one that goes on */
		const out = { fd: null };
		let dropped = 0;
		let keptBytes = 0;
		// Up to here the file stays as it is: as long as nothing was dropped, nothing is written.
		let sameUpTo = 0;
		// A line that tells no time is as old as the one before it.
		let keeping = false;
		/** @param {Buffer} line without its line end */
		const take = (line) => {
			const entry = line.length > 0 && line.length <= AUDIT_LIMITS.maxLineBytes;
			const m = entry ? LINE_TS_RE.exec(line.subarray(0, 64).toString("latin1")) : null;
			const at = m === null ? NaN : Date.parse(m[1]);
			if (Number.isFinite(at)) keeping = at >= cutoff;
			if (entry && keeping) {
				if (out.fd === null) {
					sameUpTo += line.length + 1;
					return;
				}
				writeAll(out.fd, line);
				writeAll(out.fd, Buffer.from("\n"));
				keptBytes += line.length + 1;
				return;
			}
			if (out.fd === null) {
				out.fd = fs.openSync(tmp, "wx", 0o600);
				fs.fchmodSync(out.fd, 0o600);
				this.#copy(source.fd, out.fd, sameUpTo);
				keptBytes = sameUpTo;
			}
			// An empty line is no entry, and a line too long to be one neither: not counted, not kept.
			if (entry) dropped += 1;
		};
		try {
			const chunk = Buffer.allocUnsafe(1048576);
			/** @type {Buffer} the beginning of a line whose end was not read yet */
			let rest = Buffer.alloc(0);
			// Inside a line that is too long to be an entry: passed over up to its end.
			let skipping = false;
			let position = 0;
			for (;;) {
				const n = fs.readSync(source.fd, chunk, 0, chunk.length, position);
				if (n === 0) break;
				position += n;
				let from = 0;
				for (;;) {
					const nl = chunk.subarray(0, n).indexOf(10, from);
					if (nl === -1) break;
					const line = Buffer.concat([rest, chunk.subarray(from, nl)]);
					rest = Buffer.alloc(0);
					from = nl + 1;
					if (skipping) skipping = false;
					else take(line);
				}
				if (skipping) continue;
				rest = Buffer.concat([rest, chunk.subarray(from, n)]);
				if (rest.length > AUDIT_LIMITS.maxLineBytes) {
					take(rest);
					rest = Buffer.alloc(0);
					skipping = true;
				}
			}
			// A last line without its end is what a write left that was cut off: it is kept or dropped like any other.
			if (rest.length > 0) take(rest);
			if (out.fd === null) return 0;
			if (keptBytes === 0 && !live) {
				// Nothing of the file that was set aside is young enough: it goes as a whole.
				fs.rmSync(file, { force: true });
				syncDir(this.dataDir);
				return dropped;
			}
			fs.fsyncSync(out.fd);
			fs.closeSync(out.fd);
			out.fd = null;
			fs.renameSync(tmp, file);
			syncDir(this.dataDir);
			if (live) {
				// The descriptor still names the file that was replaced: from here on the new one is written.
				this.#closeFile();
				this.#openFile();
			}
			return dropped;
		} finally {
			if (out.fd !== null) fs.closeSync(out.fd);
			// Gone already where it took the place of the file; a leftover of anything that went wrong otherwise.
			fs.rmSync(tmp, { force: true });
			fs.closeSync(source.fd);
		}
	}

	/**
	 * @param {number} from descriptor to read
	 * @param {number} to descriptor to write
	 * @param {number} bytes how many, from the beginning of the first
	 */
	#copy(from, to, bytes) {
		const buf = Buffer.allocUnsafe(Math.min(1048576, Math.max(bytes, 1)));
		let done = 0;
		while (done < bytes) {
			const n = fs.readSync(from, buf, 0, Math.min(buf.length, bytes - done), done);
			if (n === 0) throw new Error("audit log is shorter than it was");
			writeAll(to, buf.subarray(0, n));
			done += n;
		}
	}

	close() {
		this.#opened = false;
		this.#pending.length = 0;
		this.#closeFile();
	}
}
