import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensurePrivateDir, openNoFollow } from "./config.js";
import { ERROR_CODE, LIMITS as WIRE } from "../../extension/shared/protocol.js";
import { SNIFF_BYTES, decideFile } from "../../extension/shared/sniff.js";

/**
 * @typedef {import("../../extension/shared/protocol.js").JobBlobMsg} JobBlobMsg
 * @typedef {import("../../extension/shared/protocol.js").JobFile} JobFile
 *
 * @typedef {object} Blob a file that arrived whole and may be kept
 * @property {string} path where it lies, inside the data directory; whoever stores it moves it from there
 * @property {number} size
 * @property {string} sha256 hex, as computed here from the bytes that arrived
 * @property {string} sniffed what its first bytes say it is: one of the sniffer's own words
 * @property {boolean} textLike it may be shown as text
 * @property {() => void} release nobody will store it (any more): remove what is left of it. Safe to call twice
 *
 * @typedef {{ ok: true, blob: Blob } | { ok: false, code: string, reason: string, sniffed: string | null }} BlobEnd
 *   code: too_large, file_transfer_failed, or one of the sniffer's refusals; reason: a word for the log
 *
 * @typedef {object} Transfer
 * @property {string} file
 * @property {number | null} fd null once it failed
 * @property {number} seq frames taken so far
 * @property {number} bytes
 * @property {import("node:crypto").Hash} hash
 * @property {number} maxBytes
 * @property {boolean} short the last frame was not a full one: none may follow
 * @property {string | null} failed why nothing of this transfer is kept
 */

const JOB_ID_RE = /^j_[A-Za-z0-9_-]{1,64}$/;
// Transfers whose end is remembered so that their late frames are told apart from new ones.
const MAX_TRACKED = 64;

/** @param {string} file */
function removeQuietly(file) {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// nothing more can be done about a file that will not go
	}
}

/**
 * Puts the pieces of a file together as its job.blob frames arrive, in a
 * directory of its own inside the data directory (0700, files 0600), and says
 * at the end whether the file may be kept.
 *
 * Kept is only what adds up: frames in order from 0 with no gap and none
 * twice, each but the last full, never more bytes than the job was allowed,
 * and at the end the frame count, the size and the SHA-256 the extension
 * names - then the look at the first bytes (shared/sniff.js) against the
 * operator's allowlist. Anything else leaves no file behind: not a transfer
 * that failed, not one that never ended (link lost, job cancelled or timed
 * out - whoever ends the job calls discard), not one nobody stored in time,
 * and nothing a crashed daemon left (sweep at the start).
 */
export class BlobAssembler {
	#log;
	#clock;
	#unclaimedMs;
	/** @type {Map<string, Transfer>} */
	#open = new Map();
	/** @type {Map<string, { file: string, timer: unknown }>} whole files that wait to be stored */
	#done = new Map();

	/**
	 * @param {object} opts
	 * @param {string} opts.dataDir absolute
	 * @param {import("./log.js").Logger} opts.log
	 * @param {import("./log.js").Clock} opts.clock
	 * @param {number} [opts.unclaimedMs] how long a whole file waits to be stored before it is removed
	 */
	constructor({ dataDir, log, clock, unclaimedMs = 120000 }) {
		this.#log = log;
		this.#clock = clock;
		this.#unclaimedMs = unclaimedMs;
		this.dir = path.join(dataDir, "incoming");
		ensurePrivateDir(dataDir);
		ensurePrivateDir(this.dir);
	}

	/** @returns {{ open: number, waiting: number }} transfers under way, and whole files not stored yet */
	stats() {
		return { open: [...this.#open.values()].filter((t) => t.fd !== null).length, waiting: this.#done.size };
	}

	/**
	 * Remove whatever lies in the directory: nothing in it outlives the daemon that wrote it.
	 * @returns {number} files removed
	 */
	sweep() {
		let removed = 0;
		for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			removeQuietly(path.join(this.dir, entry.name));
			removed++;
		}
		if (removed > 0) this.#log.warn("blobs.swept", { files: removed });
		return removed;
	}

	/**
	 * @param {Transfer} t
	 * @param {string} reason
	 */
	#fail(t, reason) {
		if (t.failed !== null) return;
		t.failed = reason;
		if (t.fd !== null) {
			try {
				fs.closeSync(t.fd);
			} catch {
				// closed already
			}
			t.fd = null;
		}
		removeQuietly(t.file);
		if (reason === "discarded") this.#log.info("blobs.discarded", {});
		else this.#log.warn("blobs.transfer_failed", { reason });
	}

	/**
	 * Begin the file of a job: empty, private, under a name made of the daemon's own job id.
	 * @param {string} job checked against JOB_ID_RE by the caller
	 * @param {number} maxBytes
	 * @returns {Transfer}
	 */
	#begin(job, maxBytes) {
		const file = path.join(this.dir, `${job}.part`);
		/** @type {Transfer} */
		const t = { file, fd: null, seq: 0, bytes: 0, hash: crypto.createHash("sha256"), maxBytes: Math.min(maxBytes, WIRE.MAX_FILE_BYTES), short: false, failed: null };
		if (this.#open.size >= MAX_TRACKED) this.discard(/** @type {string} */ (this.#open.keys().next().value));
		this.#open.set(job, t);
		try {
			// Exclusive: a file of that name is nobody's to append to.
			t.fd = openNoFollow(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
			fs.fchmodSync(t.fd, 0o600);
		} catch (err) {
			this.#log.error("blobs.open_failed", { message: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
			this.#fail(t, "write");
		}
		return t;
	}

	/**
	 * One job.blob frame of a job that may bring a file back.
	 * @param {string} job the daemon's own id of the job
	 * @param {Pick<JobBlobMsg, "seq" | "offset" | "data">} msg a validated frame
	 * @param {number} maxBytes the most bytes this job's file may have
	 */
	accept(job, msg, maxBytes) {
		if (!JOB_ID_RE.test(job) || this.#done.has(job)) return;
		const t = this.#open.get(job) ?? this.#begin(job, maxBytes);
		if (t.failed !== null || t.fd === null) return;
		const data = Buffer.from(msg.data, "base64");
		// The frame says where its bytes belong, and that must be where the file ends: no gap, nothing twice, nothing out of order.
		if (msg.seq !== t.seq || msg.offset !== t.bytes || t.short) return this.#fail(t, "order");
		// The text was checked to be base64; what it decodes to must be what its length says.
		const padding = msg.data.endsWith("==") ? 2 : msg.data.endsWith("=") ? 1 : 0;
		if (data.length !== (msg.data.length / 4) * 3 - padding || data.length === 0 || data.length > WIRE.BLOB_CHUNK_BYTES) return this.#fail(t, "frame");
		if (t.bytes + data.length > t.maxBytes) return this.#fail(t, "too_large");
		try {
			fs.writeSync(t.fd, data);
		} catch (err) {
			this.#log.error("blobs.write_failed", { message: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
			return this.#fail(t, "write");
		}
		t.hash.update(data);
		t.seq += 1;
		t.bytes += data.length;
		t.short = data.length < WIRE.BLOB_CHUNK_BYTES;
	}

	/**
	 * The job.result of the job arrived with a file's description: does what came add up, and may it be kept?
	 * @param {string} job
	 * @param {JobFile} file what the extension says it sent
	 * @param {{ max_bytes: number, types: readonly string[] }} policy what the job was allowed
	 * @param {string | null} declared the media type the server named
	 * @returns {BlobEnd}
	 */
	complete(job, file, policy, declared) {
		/** @param {string} code @param {string} reason @param {string | null} [sniffed] @returns {BlobEnd} */
		const refuse = (code, reason, sniffed = null) => ({ ok: false, code, reason, sniffed });
		if (!JOB_ID_RE.test(job)) return refuse(ERROR_CODE.FILE_TRANSFER_FAILED, "job");
		// A file of no bytes takes no frame: it begins and ends here.
		const t = this.#open.get(job) ?? (file.size === 0 && file.chunks === 0 && !this.#done.has(job) ? this.#begin(job, policy.max_bytes) : undefined);
		this.#open.delete(job);
		if (t === undefined) return refuse(ERROR_CODE.FILE_TRANSFER_FAILED, "missing");
		if (t.failed !== null) return refuse(t.failed === "too_large" ? ERROR_CODE.TOO_LARGE : ERROR_CODE.FILE_TRANSFER_FAILED, t.failed);
		/** @param {string} code @param {string} reason @param {string | null} [sniffed] */
		const drop = (code, reason, sniffed = null) => {
			this.#fail(t, reason);
			return refuse(code, reason, sniffed);
		};
		if (t.seq !== file.chunks) return drop(ERROR_CODE.FILE_TRANSFER_FAILED, "count");
		if (t.bytes !== file.size) return drop(ERROR_CODE.FILE_TRANSFER_FAILED, "size");
		if (t.bytes > policy.max_bytes) return drop(ERROR_CODE.TOO_LARGE, "too_large");
		const sha256 = t.hash.digest("hex");
		if (sha256 !== file.sha256) return drop(ERROR_CODE.FILE_TRANSFER_FAILED, "hash");
		/** @type {Buffer} */
		let head;
		try {
			if (t.fd !== null) {
				fs.fsyncSync(t.fd);
				fs.closeSync(t.fd);
				t.fd = null;
			}
			const fd = openNoFollow(t.file, fs.constants.O_RDONLY);
			try {
				head = Buffer.alloc(Math.min(t.bytes, SNIFF_BYTES));
				fs.readSync(fd, head, 0, head.length, 0);
			} finally {
				fs.closeSync(fd);
			}
		} catch (err) {
			this.#log.error("blobs.read_failed", { message: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
			return drop(ERROR_CODE.FILE_TRANSFER_FAILED, "write");
		}
		// The check that counts: the extension ran the same one, but it is this side that keeps the file.
		const verdict = decideFile({ declared, head, allow: policy.types });
		if (!verdict.ok) return drop(verdict.code, verdict.refused ?? "type", verdict.sniffed);
		const file_ = t.file;
		const release = () => {
			const waiting = this.#done.get(job);
			if (waiting === undefined || waiting.file !== file_) return;
			this.#clock.clearTimeout(waiting.timer);
			this.#done.delete(job);
			removeQuietly(file_);
		};
		const timer = this.#clock.setTimeout(() => {
			this.#log.warn("blobs.unclaimed", {});
			release();
		}, this.#unclaimedMs);
		if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref();
		this.#done.set(job, { file: file_, timer });
		return { ok: true, blob: { path: file_, size: t.bytes, sha256, sniffed: verdict.sniffed, textLike: verdict.textLike, release } };
	}

	/**
	 * The job ended without a file: nothing of what arrived for it is kept.
	 * @param {string} job
	 */
	discard(job) {
		const t = this.#open.get(job);
		if (t === undefined) return;
		this.#open.delete(job);
		this.#fail(t, "discarded");
	}

	/** Everything goes: transfers under way and whole files nobody stored. Used when the daemon stops. */
	discardAll() {
		for (const job of [...this.#open.keys()]) this.discard(job);
		for (const [job, waiting] of [...this.#done]) {
			this.#clock.clearTimeout(waiting.timer);
			this.#done.delete(job);
			removeQuietly(waiting.file);
		}
	}
}
