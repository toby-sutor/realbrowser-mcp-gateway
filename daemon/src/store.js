import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDir, openNoFollow, removeLeftover, renameWithRetry } from "./config.js";
import { normalizeUrl } from "../../extension/shared/policy.js";
import { EXTRACTION_VIEWS, LIMITS as WIRE } from "../../extension/shared/protocol.js";
import { SNIFFED_TYPES } from "../../extension/shared/sniff.js";
import { FILE_LIMITS, PE_SIGNATURE, decodeText, displayName, isSafeName, peHeaderOffset, xmlIsPlain } from "./files.js";

/**
 * @typedef {import("../../extension/shared/protocol.js").CookieScope} CookieScope
 * @typedef {import("../../extension/shared/protocol.js").Outcome} Outcome
 * @typedef {import("../../extension/shared/protocol.js").JobRender} JobRender
 * @typedef {import("../../extension/shared/protocol.js").JobExtraction} JobExtraction
 * @typedef {import("./log.js").Logger} Logger
 * @typedef {import("./log.js").Clock} Clock
 */

/**
 * What the fetch service hands to save(): the request and the extension's result.
 * @typedef {object} PageRecord
 * @property {string} url requested URL; normalised by save()
 * @property {string | null} final_url
 * @property {number | null} http_status
 * @property {string | null} title
 * @property {string | null} author
 * @property {string | null} published
 * @property {string | null} lang
 * @property {string | null} site
 * @property {number | null} word_count
 * @property {string | null} extractor
 * @property {CookieScope | null} cookie_scope only "container" pages are stored; null is treated like "default"
 * @property {Outcome} outcome
 * @property {readonly string[]} redirect_origins
 * @property {JobRender | null} render
 * @property {JobExtraction | null} [extraction] which view the Markdown is, and what the extractor left out
 * @property {{ markdown: boolean, html: boolean, text?: boolean, raw_html?: boolean }} truncated
 * @property {string | null} markdown
 * @property {string | null} [text] the full visible text; null when the Markdown is that text already
 * @property {string | null} html
 * @property {string | null} [raw_html] the page source as the browser held it; kept as raw.html.gz
 * @property {readonly { url: string, text: string }[]} [links]
 */

/**
 * @typedef {object} PageMeta
 * @property {1} v
 * @property {string} id
 * @property {string} url requested, normalised
 * @property {string | null} final_url
 * @property {string} host
 * @property {string} fetched_at ISO 8601 UTC, whole seconds
 * @property {number | null} http_status
 * @property {string | null} title
 * @property {string | null} author
 * @property {string | null} published
 * @property {string | null} lang
 * @property {string | null} site
 * @property {number | null} word_count
 * @property {number} content_chars length of the markdown in UTF-16 code units
 * @property {string | null} content_sha256 hex SHA-256 of the markdown (UTF-8), kept even when the body is not
 * @property {number | null} [text_chars] length of the stored visible text; null when content.txt was not written
 * @property {JobExtraction | null} [extraction] absent on pages stored before the visible text was
 * @property {string | null} extractor
 * @property {CookieScope | null} cookie_scope
 * @property {Outcome} outcome
 * @property {string[]} redirect_origins
 * @property {JobRender | null} render
 * @property {{ markdown: boolean, html: boolean, text?: boolean, raw_html?: boolean }} truncated
 * @property {boolean} stored whether content.md is on disk
 */

/**
 * All that is kept of a page that was not fetched in the container:
 * where, when, how it ended and a hash. No URL path or query, no title,
 * author or site, no redirect list, no render details.
 * @typedef {object} BareMeta
 * @property {1} v
 * @property {string} id
 * @property {string} host host of the requested URL
 * @property {string} fetched_at ISO 8601 UTC, whole seconds
 * @property {number} content_chars
 * @property {string | null} content_sha256
 * @property {Outcome} outcome
 * @property {false} stored
 */

/**
 * What the fetch service hands to saveFile(): a file that arrived whole and passed the type check.
 * @typedef {object} FileRecord
 * @property {string} url requested URL; normalised by saveFile()
 * @property {string | null} final_url
 * @property {number | null} http_status
 * @property {string | null} suggested_name what the server suggests as a name; the stored name is made from it here
 * @property {string | null} declared_type the media type the server named
 * @property {string} sniffed_type what the first bytes say it is: one of the sniffer's words
 * @property {string | null} charset
 * @property {number} size
 * @property {string} sha256
 * @property {boolean} text_like it may be shown as text
 * @property {string} tempPath where the bytes lie: inside the data directory; moved from there
 * @property {readonly string[]} [redirect_origins]
 *
 * @typedef {object} FileMeta
 * @property {1} v
 * @property {"file"} kind
 * @property {string} id
 * @property {string} url requested, normalised
 * @property {string | null} final_url
 * @property {string} host
 * @property {string} fetched_at ISO 8601 UTC, whole seconds
 * @property {number | null} http_status
 * @property {string} name the display name: a label, never a path (files.js)
 * @property {string | null} declared_type
 * @property {string} sniffed_type what the file is stored as: the sniffer's word for its first bytes, as settledType() left it
 * @property {string | null} charset
 * @property {number} size bytes
 * @property {string} sha256 hex, of those bytes
 * @property {boolean} text shown and searched as text: text-like and not larger than FILE_LIMITS.maxTextBytes
 * @property {"container"} cookie_scope files are only ever kept from the gateway container
 * @property {string[]} redirect_origins
 *
 * @typedef {object} SearchHit
 * @property {string} id a page id, or a file id
 * @property {string} title of a page; the name of a file
 * @property {string} url
 * @property {string} fetched_at
 * @property {string} snippet plain page text, untrusted
 */

export const PAGE_ID_RE = /^pg_[0-9A-HJKMNP-TV-Z]{26}$/;
export const FILE_ID_RE = /^fl_[0-9A-HJKMNP-TV-Z]{26}$/;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHARD_RE = /^[0-9A-HJKMNP-TV-Z]{2}$/;
const MAX_FILE_BYTES = 33554432;
const MAX_HTML_CHARS = 67108864;
const SCHEMA_VERSION = 1;

/**
 * How much the retrieved files may take on disk in all (files.max_total_mb), in bytes, unless the store is told
 * otherwise, and how long a file that is being read in pieces is kept out of the way of eviction after its last piece.
 */
export const FILE_STORE = Object.freeze({
	maxTotalBytes: 2147483648,
	readHoldMs: 60000,
});

/**
 * How much the stored pages may take in all (pages.max_total_mb), in bytes, unless the store is told otherwise.
 * Counted for every page: its files on disk, and what the index holds to search it - a copy of its text and the
 * list of its words, taken together as indexShare times the bytes of that text. Measured, the index takes 1.5
 * times the text it was given for prose and 1.7 times where hardly a word comes twice: the count errs on the side
 * of room.
 */
export const PAGE_STORE = Object.freeze({
	maxTotalBytes: 2147483648,
	indexShare: 2,
});

export const SEARCH_LIMITS = Object.freeze({
	maxQueryChars: 500,
	maxTerms: 12,
	maxTermChars: 64,
	maxHits: 50,
	defaultHits: 10,
});

export class StoreError extends Error {
	/** @param {string} code @param {string} message */
	constructor(code, message) {
		super(message);
		this.name = "StoreError";
		this.code = code;
	}
}

/** @param {unknown} id @returns {id is string} */
export function isValidPageId(id) {
	return typeof id === "string" && PAGE_ID_RE.test(id);
}

/** @param {unknown} id @returns {id is string} */
export function isValidFileId(id) {
	return typeof id === "string" && FILE_ID_RE.test(id);
}

/**
 * @param {number} nowMs
 * @param {(n: number) => Uint8Array} randomBytes
 * @returns {string} "fl_" + 26-char Crockford base32 ULID
 */
export function newFileId(nowMs, randomBytes) {
	return `fl_${newPageId(nowMs, randomBytes).slice(3)}`;
}

/**
 * @param {number} nowMs
 * @param {(n: number) => Uint8Array} randomBytes
 * @returns {string} "pg_" + 26-char Crockford base32 ULID
 */
export function newPageId(nowMs, randomBytes) {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= 2 ** 48) throw new RangeError("time out of ULID range");
	let t = nowMs;
	let time = "";
	for (let i = 0; i < 10; i++) {
		time = CROCKFORD[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const bytes = randomBytes(10);
	if (bytes.length !== 10) throw new RangeError("randomBytes must return 10 bytes");
	let r = 0n;
	for (const b of bytes) r = (r << 8n) | BigInt(b);
	let rand = "";
	for (let i = 0; i < 16; i++) {
		rand = CROCKFORD[Number(r & 31n)] + rand;
		r >>= 5n;
	}
	return `pg_${time}${rand}`;
}

/**
 * @param {string} id a valid page or file id
 * @returns {number} the time it was made at, in milliseconds: the first ten characters of its ULID
 */
export function idTime(id) {
	let t = 0;
	for (const c of id.slice(3, 13)) t = t * 32 + CROCKFORD.indexOf(c);
	return t;
}

/**
 * Turn untrusted text into an FTS5 expression that cannot raise a syntax
 * error and cannot use operators, column filters, prefixes or NEAR: every term
 * is a quoted phrase made only of letters, digits and marks.
 * @param {string} query
 * @returns {string | null} null when nothing searchable is left
 */
export function buildFtsQuery(query) {
	if (typeof query !== "string") return null;
	const terms = new Set();
	for (const m of query.slice(0, SEARCH_LIMITS.maxQueryChars).matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
		terms.add(m[0].slice(0, SEARCH_LIMITS.maxTermChars));
		if (terms.size >= SEARCH_LIMITS.maxTerms) break;
	}
	if (terms.size === 0) return null;
	return [...terms].map((t) => `"${t}"`).join(" ");
}

/** @param {string} p @returns {fs.Stats | null} */
function lstatOrNull(p) {
	try {
		return fs.lstatSync(p);
	} catch (err) {
		if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null;
		throw err;
	}
}

/** @param {fs.Stats | null} st @returns {st is fs.Stats} */
function isRealDir(st) {
	return st !== null && st.isDirectory() && !st.isSymbolicLink();
}

/**
 * What a file is stored as, settled with all of its bytes at hand. The sniffer saw the first of them, on both
 * sides of the link, and what it says stands - but for two things it could not see from there:
 *   - What begins like XML is stored as "application/xml" only when all of it is plain data (files.js,
 *     xmlIsPlain) and it is small enough to be read whole here; otherwise as "text/plain". The type decides
 *     the ending of an exported copy, and an ".xml" is a document to a browser.
 *   - A Windows program whose first bytes read like text is one all the same when its second header stands
 *     where the first says. It is not stored at all.
 * @param {string} file the bytes, a plain file of that size
 * @param {string} sniffed the sniffer's word for its first bytes
 * @param {number} size
 * @returns {string} one of the sniffer's words
 * @throws {StoreError} "file_refused" for such a program; "invalid_record" when the bytes cannot be read
 */
function settledType(file, sniffed, size) {
	/** @type {number} */
	let fd;
	try {
		fd = openNoFollow(file, fs.constants.O_RDONLY);
	} catch {
		throw new StoreError("invalid_record", "the bytes of the file cannot be read");
	}
	/** @param {number} length @param {number} position @returns {Buffer} */
	const read = (length, position) => {
		const out = Buffer.alloc(length);
		let got = 0;
		while (got < length) {
			const n = fs.readSync(fd, out, got, length - got, position + got);
			if (n === 0) throw new StoreError("invalid_record", "the bytes of the file end before its size");
			got += n;
		}
		return out;
	};
	try {
		const header = peHeaderOffset(read(Math.min(size, 64), 0));
		if (header !== null && header + PE_SIGNATURE.length <= size && read(PE_SIGNATURE.length, header).equals(Buffer.from(PE_SIGNATURE))) {
			throw new StoreError("file_refused", "the file is a Windows program");
		}
		if (sniffed !== "application/xml") return sniffed;
		return size <= FILE_LIMITS.maxTextBytes && xmlIsPlain(read(size, 0)) ? sniffed : "text/plain";
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Read a regular file without following a symlink at the final component.
 * @param {string} file
 * @returns {Buffer | null} null when missing or not a regular file
 */
function readRegularFile(file) {
	/** @type {number} */
	let fd;
	try {
		fd = openNoFollow(file, fs.constants.O_RDONLY);
	} catch (err) {
		const code = /** @type {NodeJS.ErrnoException} */ (err).code;
		if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return null;
		throw err;
	}
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
		return fs.readFileSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * New file, 0600, flushed to disk. Fails when it exists.
 * @param {string} file
 * @param {string | Uint8Array} data
 */
function writeNewFile(file, data) {
	const fd = fs.openSync(file, "wx", 0o600);
	try {
		fs.fchmodSync(fd, 0o600);
		fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * The SHA-256 of a stored file, read without following a link.
 * @param {string} file
 * @param {number} size what the file must measure
 * @returns {string | null} hex; null when it is no plain file of that size, or cannot be read
 */
function sha256OfFile(file, size) {
	/** @type {number} */
	let fd;
	try {
		fd = openNoFollow(file, fs.constants.O_RDONLY);
	} catch {
		return null;
	}
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile() || st.size !== size) return null;
		const hash = crypto.createHash("sha256");
		const buf = Buffer.allocUnsafe(1048576);
		let total = 0;
		for (;;) {
			const n = fs.readSync(fd, buf, 0, buf.length, null);
			if (n === 0) break;
			hash.update(buf.subarray(0, n));
			total += n;
		}
		return total === size ? hash.digest("hex") : null;
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}
}

/** @param {unknown} v @returns {string} */
function asString(v) {
	return typeof v === "string" ? v : "";
}

/** @param {unknown} v @returns {number} */
function asNumber(v) {
	return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0;
}

/** @param {number} ms @returns {string} ISO 8601 UTC, whole seconds */
function isoSeconds(ms) {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** @param {unknown} v @returns {boolean} absent, null or a string */
function isOptString(v) {
	return v === undefined || v === null || typeof v === "string";
}

/** @param {unknown} v @returns {boolean} absent, null or a number */
function isOptNumber(v) {
	return v === undefined || v === null || (typeof v === "number" && Number.isFinite(v));
}

/**
 * Parse and check a meta.json. What comes back has every field in the shape the typedef names, so that whoever
 * reads a record never has to ask again: a record with a field of another kind (damaged, or written by hand) is
 * no record. A field that is missing (a record from before the field existed) is null, or empty where it is a list
 * or a set of flags.
 * @param {string} text
 * @param {string} id
 * @returns {PageMeta | BareMeta | null}
 */
function parseMeta(text, id) {
	/** @type {unknown} */
	let m;
	try {
		m = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof m !== "object" || m === null || Array.isArray(m)) return null;
	const o = /** @type {Record<string, unknown>} */ (m);
	if (o.id !== id || typeof o.fetched_at !== "string" || typeof o.stored !== "boolean") return null;
	if (!Number.isFinite(Date.parse(o.fetched_at))) return null;
	if (typeof o.host !== "string" || typeof o.outcome !== "string") return null;
	if (typeof o.content_chars !== "number" || !Number.isSafeInteger(o.content_chars) || o.content_chars < 0) return null;
	if (!isOptString(o.content_sha256)) return null;
	o.content_sha256 ??= null;
	if (typeof o.url !== "string") {
		// A bare record has no URL; anything else without one is damaged.
		if (o.url !== undefined || o.stored !== false) return null;
		return /** @type {BareMeta} */ (m);
	}
	for (const name of ["final_url", "title", "author", "published", "lang", "site", "extractor", "cookie_scope"]) {
		if (!isOptString(o[name])) return null;
		o[name] ??= null;
	}
	for (const name of ["http_status", "word_count", "text_chars"]) {
		if (!isOptNumber(o[name])) return null;
		o[name] ??= null;
	}
	o.redirect_origins ??= [];
	if (!Array.isArray(o.redirect_origins) || !o.redirect_origins.every((hop) => typeof hop === "string")) return null;
	// Looked at again where it is used (cleanExtraction); here only that it is there to be looked at.
	o.extraction ??= null;
	o.render ??= null;
	if (o.render !== null && (typeof o.render !== "object" || Array.isArray(o.render))) return null;
	const t = (o.truncated ??= { markdown: false, html: false });
	if (typeof t !== "object" || t === null || Array.isArray(t)) return null;
	const flags = /** @type {Record<string, unknown>} */ (t);
	if (typeof flags.markdown !== "boolean" || typeof flags.html !== "boolean") return null;
	if ((flags.text !== undefined && typeof flags.text !== "boolean") || (flags.raw_html !== undefined && typeof flags.raw_html !== "boolean")) return null;
	return /** @type {PageMeta} */ (m);
}

/**
 * Parse and check the meta.json of a file. Stricter than a page's: every value that ends up in a header line or
 * decides how the file is handed out is checked again when it is read back.
 * @param {string} text
 * @param {string} id
 * @returns {FileMeta | null}
 */
function parseFileMeta(text, id) {
	/** @type {unknown} */
	let m;
	try {
		m = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof m !== "object" || m === null || Array.isArray(m)) return null;
	const o = /** @type {Record<string, unknown>} */ (m);
	if (o.id !== id || o.kind !== "file" || typeof o.url !== "string" || typeof o.host !== "string") return null;
	if (typeof o.fetched_at !== "string" || !Number.isFinite(Date.parse(o.fetched_at))) return null;
	if (!isSafeName(o.name) || typeof o.sniffed_type !== "string" || !SNIFFED_TYPES.includes(o.sniffed_type)) return null;
	if (typeof o.size !== "number" || !Number.isSafeInteger(o.size) || o.size < 0 || o.size > WIRE.MAX_FILE_BYTES) return null;
	if (typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.sha256) || typeof o.text !== "boolean" || o.cookie_scope !== "container") return null;
	if (o.final_url !== null && typeof o.final_url !== "string") return null;
	if (o.declared_type !== null && typeof o.declared_type !== "string") return null;
	if (o.charset !== null && typeof o.charset !== "string") return null;
	return /** @type {FileMeta} */ (m);
}

/**
 * @param {PageMeta | BareMeta} meta
 * @returns {meta is PageMeta} false for a bare record, and for a full one
 *   from before the no-store rule, which must now be treated like one
 */
export function isFullMeta(meta) {
	return "url" in meta && meta.cookie_scope === "container";
}

/**
 * What full-text search looks through for a page: the richer of its two
 * texts. The visible text holds what an article view left out (the replies of
 * a thread); the Markdown is all there is when no separate text was stored.
 * @param {string} markdown
 * @param {string | null} text
 * @returns {string}
 */
export function searchBody(markdown, text) {
	return text !== null && text.length > markdown.length ? text : markdown;
}

/**
 * The extraction facts of a result, checked once more: they end up in a header.
 * @param {unknown} v
 * @returns {JobExtraction | null}
 */
export function cleanExtraction(v) {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	const o = /** @type {Record<string, unknown>} */ (v);
	const view = EXTRACTION_VIEWS.find((name) => name === o.view);
	if (view === undefined) return null;
	const pct = o.coverage_pct;
	const removed = o.hidden_removed;
	return {
		view,
		coverage_pct: typeof pct === "number" && Number.isInteger(pct) && pct >= 0 && pct <= 100 ? pct : null,
		hidden_removed: typeof removed === "number" && Number.isSafeInteger(removed) && removed >= 0 ? Math.min(removed, WIRE.MAX_HIDDEN_REMOVED) : 0,
		capped: o.capped === true,
	};
}

/**
 * Page store: files are the truth, index.db is a rebuildable index.
 *
 * Layout under the data dir (dirs 0700, files 0600):
 *   pages/<last two id chars>/<id>/{meta.json, content.md, content.txt, page.html.gz, raw.html.gz, links.json}
 *   files/<last two id chars>/<id>/{meta.json, data}
 *   index.db
 *
 * A retrieved file (FileMeta) is its bytes, untouched, under the fixed name
 * "data", and a meta record. Its path is made of its id and of nothing else:
 * the name a server gave it is a field of the record. Files whose bytes are
 * text are searched by that text; every file is found by its name and address.
 *
 * The files together take no more room than the store was given
 * (maxFileBytes). Before a file is kept, the oldest files go until it fits -
 * never one that is being read in pieces at that moment - and a file that
 * cannot be made room for is refused (StoreError "store_full"). The same
 * bytes are kept once: a file whose SHA-256 and size are those of a stored
 * one becomes a second name (a hard link) for the bytes of that one, after
 * they were read and found to be what its record says. The file system
 * counts the names, so the bytes go when the last record that holds them
 * goes, however that happens: purge, eviction, a directory removed by hand.
 * What the index holds for each record is under which key its bytes are
 * counted (files.content): "<sha256>:<size>" for every record that shares
 * the bytes of that content, the record's own id where a link could not be
 * made and the bytes lie there a second time. rebuildIndex() finds the
 * links again from the file system and makes the ones that are missing.
 *
 * The text of a file is in the index once for every content: with the newest
 * record that holds those bytes. The others are found by name and address.
 * So the text of files in the index grows with the bytes that are stored, not
 * with the number of records.
 *
 * content.md is the Markdown view of the page, content.txt its full visible
 * text (not written when the Markdown is that text already, see meta.extraction).
 *
 * A page directory is built under a temporary name in its shard and renamed
 * into place, so a reader never sees a half-written page. Pages fetched with
 * the operator's own session (cookie_scope other than "container") leave a
 * bare record and a bare index row only (BareMeta): no body, no html, no
 * full-text entry, and nothing the page or its URL could tell.
 *
 * The pages together take no more room than the store was given
 * (maxPageBytes) either. What a page takes is written down in the index when
 * it is saved (pages.bytes): its files, and what the index holds to search it
 * (PAGE_STORE.indexShare). Before a page is kept, the oldest pages go until it fits -
 * never one that is being read in pieces at that moment - and a page that
 * cannot be made room for is not kept (StoreError "store_full").
 *
 * The index can be lost, and a save can end between the directory and its
 * row. recoverIndex() rebuilds an index that is empty over directories that
 * hold records; purge() also removes directories the index does not know,
 * by the time in their id.
 */
export class PageStore {
	#clock;
	#log;
	#randomBytes;
	#db;
	/** @type {string} */
	#pagesDir;
	/** @type {string} */
	#pagesReal;
	/** @type {string} */
	#filesDir;
	/** @type {string} */
	#filesReal;
	#closed = false;
	/** @type {Record<string, import("node:sqlite").StatementSync>} */
	#sql;
	/** @type {number} what the bytes of all files may come to */
	#maxFileBytes;
	/** @type {number} what all pages may come to: their files and the text the index holds of them */
	#maxPageBytes;
	/** @type {Map<string, number>} pages and files that are being read in pieces -> until when they are kept out of the way of eviction */
	#reading = new Map();

	/**
	 * @param {object} opts
	 * @param {string} opts.dataDir absolute
	 * @param {Pick<Clock, "now">} opts.clock
	 * @param {Logger} opts.log
	 * @param {(n: number) => Uint8Array} [opts.randomBytes]
	 * @param {number} [opts.maxFileBytes] what the retrieved files may take on disk in all (files.max_total_mb)
	 * @param {number} [opts.maxPageBytes] what the stored pages may take in all (pages.max_total_mb)
	 */
	constructor({ dataDir, clock, log, randomBytes = crypto.randomBytes, maxFileBytes = FILE_STORE.maxTotalBytes, maxPageBytes = PAGE_STORE.maxTotalBytes }) {
		if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0) throw new RangeError("maxFileBytes must be a whole number of bytes");
		if (!Number.isSafeInteger(maxPageBytes) || maxPageBytes < 0) throw new RangeError("maxPageBytes must be a whole number of bytes");
		this.#maxPageBytes = maxPageBytes;
		this.#clock = clock;
		this.#log = log;
		this.#randomBytes = randomBytes;
		this.#maxFileBytes = maxFileBytes;
		ensurePrivateDir(dataDir);
		this.dataDir = dataDir;
		this.#pagesDir = path.join(dataDir, "pages");
		ensurePrivateDir(this.#pagesDir);
		this.#pagesReal = fs.realpathSync(this.#pagesDir);
		this.#filesDir = path.join(dataDir, "files");
		ensurePrivateDir(this.#filesDir);
		this.#filesReal = fs.realpathSync(this.#filesDir);
		this.indexFile = path.join(dataDir, "index.db");
		// Create the file first so SQLite (and its journal) inherit 0600.
		const fd = fs.openSync(this.indexFile, "a", 0o600);
		fs.fchmodSync(fd, 0o600);
		fs.closeSync(fd);
		this.#db = new DatabaseSync(this.indexFile);
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS pages (
				id TEXT PRIMARY KEY,
				url TEXT NOT NULL,
				host TEXT NOT NULL,
				fetched_at TEXT NOT NULL,
				fetched_ms INTEGER NOT NULL,
				title TEXT NOT NULL,
				outcome TEXT NOT NULL,
				cookie_scope TEXT,
				stored INTEGER NOT NULL,
				content_chars INTEGER NOT NULL,
				content_sha256 TEXT,
				bytes INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS pages_url ON pages (url, fetched_ms);
			CREATE INDEX IF NOT EXISTS pages_fetched ON pages (fetched_ms);
			CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(title, body, tokenize='porter unicode61');
			CREATE TABLE IF NOT EXISTS files (
				id TEXT PRIMARY KEY,
				url TEXT NOT NULL,
				host TEXT NOT NULL,
				fetched_at TEXT NOT NULL,
				fetched_ms INTEGER NOT NULL,
				name TEXT NOT NULL,
				sniffed_type TEXT NOT NULL,
				size INTEGER NOT NULL,
				sha256 TEXT NOT NULL,
				text INTEGER NOT NULL,
				content TEXT NOT NULL DEFAULT ''
			);
			CREATE INDEX IF NOT EXISTS files_url ON files (url, fetched_ms);
			CREATE INDEX IF NOT EXISTS files_fetched ON files (fetched_ms);
			CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(name, url, body, tokenize='porter unicode61');
			PRAGMA user_version = ${SCHEMA_VERSION};
		`);
		// An index from before identical bytes were kept once: every file counts on its own until the index is rebuilt.
		if (!this.#db.prepare("PRAGMA table_info(files)").all().some((column) => column.name === "content")) {
			this.#db.exec("ALTER TABLE files ADD COLUMN content TEXT NOT NULL DEFAULT ''");
		}
		this.#db.exec("UPDATE files SET content = id WHERE content = ''; CREATE INDEX IF NOT EXISTS files_content ON files (content);");
		// An index from before the pages had a limit: what each page takes is not written down in it yet.
		const uncounted = !this.#db.prepare("PRAGMA table_info(pages)").all().some((column) => column.name === "bytes");
		if (uncounted) this.#db.exec("ALTER TABLE pages ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0");
		const p = (/** @type {string} */ sql) => this.#db.prepare(sql);
		this.#sql = {
			insertPage: p(
				`INSERT INTO pages (id, url, host, fetched_at, fetched_ms, title, outcome, cookie_scope, stored, content_chars, content_sha256, bytes)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			),
			insertFts: p("INSERT INTO pages_fts (rowid, title, body) VALUES (?, ?, ?)"),
			fresh: p(
				`SELECT id FROM pages
				 WHERE url = ? AND stored = 1 AND outcome = 'ok' AND cookie_scope = 'container' AND fetched_ms >= ?
				 ORDER BY fetched_ms DESC, id DESC LIMIT 1`,
			),
			search: p(
				`SELECT p.id AS id, p.title AS title, p.url AS url, p.fetched_at AS fetched_at,
				        snippet(pages_fts, -1, '', '', ' ... ', 24) AS snippet, pages_fts.rank AS rank
				 FROM pages_fts JOIN pages p ON p.rowid = pages_fts.rowid
				 WHERE pages_fts MATCH ? AND p.stored = 1
				 ORDER BY pages_fts.rank LIMIT ?`,
			),
			older: p("SELECT id FROM pages WHERE fetched_ms < ? ORDER BY fetched_ms"),
			deleteFts: p("DELETE FROM pages_fts WHERE rowid IN (SELECT rowid FROM pages WHERE id = ?)"),
			deletePage: p("DELETE FROM pages WHERE id = ?"),
			clearFts: p("DELETE FROM pages_fts"),
			clearPages: p("DELETE FROM pages"),
			count: p("SELECT COUNT(*) AS n, COALESCE(SUM(stored), 0) AS stored FROM pages"),
			pageBytes: p("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM pages"),
			oldestPages: p("SELECT id, bytes FROM pages ORDER BY fetched_ms, id LIMIT ? OFFSET ?"),
			allPages: p("SELECT id FROM pages"),
			setPageBytes: p("UPDATE pages SET bytes = ? WHERE id = ?"),
			knownPage: p("SELECT 1 AS known FROM pages WHERE id = ?"),
			knownFile: p("SELECT 1 AS known FROM files WHERE id = ?"),
			// The text of a content is searched in one place: taken out of the entries of the records that hold it so far.
			dropSharedText: p("UPDATE files_fts SET body = '' WHERE rowid IN (SELECT rowid FROM files WHERE content = ?)"),
			// The same for an index that has it more than once: every record but the newest of its content.
			dropOlderText: p(
				`UPDATE files_fts SET body = '' WHERE rowid IN (
					SELECT f.rowid FROM files f WHERE EXISTS (
						SELECT 1 FROM files g WHERE g.content = f.content AND (g.fetched_ms > f.fetched_ms OR (g.fetched_ms = f.fetched_ms AND g.id > f.id))))`,
			),
			insertFile: p("INSERT INTO files (id, url, host, fetched_at, fetched_ms, name, sniffed_type, size, sha256, text, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
			insertFileFts: p("INSERT INTO files_fts (rowid, name, url, body) VALUES (?, ?, ?, ?)"),
			freshFile: p("SELECT id FROM files WHERE url = ? AND fetched_ms >= ? ORDER BY fetched_ms DESC, id DESC LIMIT 1"),
			searchFiles: p(
				`SELECT f.id AS id, f.name AS title, f.url AS url, f.fetched_at AS fetched_at,
				        snippet(files_fts, 2, '', '', ' ... ', 24) AS snippet, files_fts.rank AS rank
				 FROM files_fts JOIN files f ON f.rowid = files_fts.rowid
				 WHERE files_fts MATCH ?
				 ORDER BY files_fts.rank LIMIT ?`,
			),
			olderFiles: p("SELECT id FROM files WHERE fetched_ms < ? ORDER BY fetched_ms"),
			deleteFileFts: p("DELETE FROM files_fts WHERE rowid IN (SELECT rowid FROM files WHERE id = ?)"),
			deleteFile: p("DELETE FROM files WHERE id = ?"),
			clearFileFts: p("DELETE FROM files_fts"),
			clearFiles: p("DELETE FROM files"),
			countFiles: p("SELECT COUNT(*) AS n FROM files"),
			// Bytes on disk: every content once, however many records hold it.
			fileBytes: p("SELECT COALESCE(SUM(size), 0) AS bytes FROM (SELECT MAX(size) AS size FROM files GROUP BY content)"),
			sharers: p("SELECT id FROM files WHERE content = ? ORDER BY fetched_ms DESC, id DESC"),
			holders: p("SELECT COUNT(*) AS n FROM files WHERE content = ?"),
			rekey: p("UPDATE files SET content = ? WHERE id = ?"),
			oldestFiles: p("SELECT id, size, content FROM files ORDER BY fetched_ms, id LIMIT ? OFFSET ?"),
		};
		if (uncounted) this.#countPages();
	}

	/**
	 * What the files of a page take on disk, and how many bytes of its text the index was given - as near as their
	 * sizes tell.
	 * @param {string} id validated
	 * @returns {{ disk: number, text: number }} zeros for a page that is gone
	 */
	#pageSizes(id) {
		const dir = this.#existingPageDir(id);
		if (dir === null) return { disk: 0, text: 0 };
		let disk = 0;
		let text = 0;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const st = lstatOrNull(path.join(dir, entry.name));
			if (st === null || !st.isFile()) continue;
			disk += st.size;
			// Search looks through the richer of the two texts (searchBody): the larger file, near enough.
			if (entry.name === "content.md" || entry.name === "content.txt") text = Math.max(text, st.size);
		}
		return { disk, text };
	}

	/**
	 * Once, for an index from before the pages had a limit: write down what every page takes, from the sizes of its
	 * files (nothing is read), and take the text of files that share their bytes out of all entries but the newest.
	 */
	#countPages() {
		const started = this.#clock.now();
		let pages = 0;
		let bytes = 0;
		this.#tx(() => {
			for (const id of this.#sql.allPages.all().map((r) => asString(r.id))) {
				if (!isValidPageId(id)) continue;
				const { disk, text } = this.#pageSizes(id);
				const all = disk + PAGE_STORE.indexShare * text;
				this.#sql.setPageBytes.run(all, id);
				pages += 1;
				bytes += all;
			}
			this.#sql.dropOlderText.run();
		});
		this.#log.info("store.index_upgraded", { pages, bytes, ms: this.#clock.now() - started });
	}

	/**
	 * @param {string} id
	 * @returns {string} shard directory path
	 */
	#shardDir(id) {
		return path.join(this.#pagesDir, id.slice(-2));
	}

	/**
	 * @param {string} id validated
	 * @returns {string | null} the page directory when it and its shard are real directories
	 */
	#existingPageDir(id) {
		const shard = this.#shardDir(id);
		if (!isRealDir(lstatOrNull(shard))) return null;
		const dir = path.join(shard, id);
		if (!isRealDir(lstatOrNull(dir))) return null;
		return dir;
	}

	/** @param {string} id @returns {void} */
	#assertId(id) {
		if (!isValidPageId(id)) throw new StoreError("invalid_id", "not a valid page id");
	}

	#assertOpen() {
		if (this.#closed) throw new StoreError("closed", "the store is closed");
	}

	/** @param {() => void} fn */
	#tx(fn) {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			fn();
			this.#db.exec("COMMIT");
		} catch (err) {
			this.#db.exec("ROLLBACK");
			throw err;
		}
	}

	/**
	 * @param {PageMeta | BareMeta} meta
	 * @param {string | null} body null when not stored
	 * @param {number} bytes what the page takes: its files, and that body in the index
	 */
	#indexPage(meta, body, bytes) {
		const full = isFullMeta(meta);
		const info = this.#sql.insertPage.run(
			meta.id,
			full ? meta.url : "",
			asString(meta.host),
			meta.fetched_at,
			Date.parse(meta.fetched_at),
			full ? (meta.title ?? "") : "",
			asString(meta.outcome),
			full ? meta.cookie_scope : null,
			full && meta.stored ? 1 : 0,
			asNumber(meta.content_chars),
			typeof meta.content_sha256 === "string" ? meta.content_sha256 : null,
			bytes,
		);
		if (full && meta.stored && body !== null) this.#sql.insertFts.run(info.lastInsertRowid, meta.title ?? "", body);
	}

	/**
	 * Write a page and index it. A page that was not fetched in the container
	 * leaves a bare record instead. Room is made first (see the class comment);
	 * a page there is no room for throws StoreError "store_full" and leaves nothing.
	 * @param {PageRecord} record
	 * @returns {{ id: string, meta: PageMeta | BareMeta }}
	 */
	save(record) {
		this.#assertOpen();
		const n = normalizeUrl(record.url);
		if (!n.ok) throw new StoreError("invalid_record", "url is not a valid http(s) URL");
		const markdown = record.markdown;
		const inContainer = record.cookie_scope === "container";
		const stored = inContainer && typeof markdown === "string";
		const text = stored && typeof record.text === "string" ? record.text : null;
		const now = this.#clock.now();
		const fetchedAt = isoSeconds(now);
		const contentChars = typeof markdown === "string" ? markdown.length : 0;
		const contentHash = typeof markdown === "string" ? crypto.createHash("sha256").update(markdown, "utf8").digest("hex") : null;
		/** @param {string} id @returns {PageMeta | BareMeta} */
		const makeMeta = (id) =>
			inContainer
				? {
						v: 1,
						id,
						url: n.url,
						final_url: record.final_url,
						host: n.host,
						fetched_at: fetchedAt,
						http_status: record.http_status,
						title: record.title,
						author: record.author,
						published: record.published,
						lang: record.lang,
						site: record.site,
						word_count: record.word_count,
						content_chars: contentChars,
						content_sha256: contentHash,
						text_chars: text === null ? null : text.length,
						extraction: cleanExtraction(record.extraction),
						extractor: record.extractor,
						cookie_scope: record.cookie_scope,
						outcome: record.outcome,
						redirect_origins: [...record.redirect_origins],
						render: record.render,
						truncated: { markdown: record.truncated.markdown, text: record.truncated.text === true, html: record.truncated.html, raw_html: record.truncated.raw_html === true },
						stored,
					}
				: { v: 1, id, host: n.host, fetched_at: fetchedAt, content_chars: contentChars, content_sha256: contentHash, outcome: record.outcome, stored: false };

		// Everything that will lie in the directory, made before anything is put in place: what the page takes is
		// known then, and room is made for exactly that.
		/** @type {[string, Buffer][]} */
		const parts = [];
		if (stored) {
			parts.push(["content.md", Buffer.from(/** @type {string} */ (markdown), "utf8")]);
			if (text !== null) parts.push(["content.txt", Buffer.from(text, "utf8")]);
			if (typeof record.html === "string") parts.push(["page.html.gz", zlib.gzipSync(record.html)]);
			if (typeof record.raw_html === "string") parts.push(["raw.html.gz", zlib.gzipSync(record.raw_html)]);
			if (record.links !== undefined && record.links.length > 0) parts.push(["links.json", Buffer.from(JSON.stringify(record.links), "utf8")]);
		}
		const body = stored ? searchBody(/** @type {string} */ (markdown), text) : null;
		const partBytes = parts.reduce((sum, [, data]) => sum + data.length, 0) + (body === null ? 0 : PAGE_STORE.indexShare * Buffer.byteLength(body, "utf8"));

		let lastErr = null;
		for (let attempt = 0; attempt < 4; attempt++) {
			const id = newPageId(now, this.#randomBytes);
			const meta = makeMeta(id);
			const metaData = Buffer.from(JSON.stringify(meta, null, "\t") + "\n", "utf8");
			const bytes = partBytes + metaData.length;
			this.#makePageRoom(bytes);
			const shard = this.#shardDir(id);
			fs.mkdirSync(shard, { recursive: true, mode: 0o700 });
			if (!isRealDir(lstatOrNull(shard))) throw new StoreError("unsafe_path", "shard is not a directory");
			const finalDir = path.join(shard, id);
			if (lstatOrNull(finalDir) !== null) {
				lastErr = new StoreError("id_collision", "page id already exists");
				continue;
			}
			const tmp = path.join(shard, `.tmp-${crypto.randomBytes(6).toString("hex")}`);
			fs.mkdirSync(tmp, { mode: 0o700 });
			try {
				for (const [name, data] of parts) writeNewFile(path.join(tmp, name), data);
				writeNewFile(path.join(tmp, "meta.json"), metaData);
				renameWithRetry(tmp, finalDir);
			} catch (err) {
				removeLeftover(tmp, { recursive: true, force: true });
				const code = /** @type {NodeJS.ErrnoException} */ (err).code;
				if (code === "EEXIST" || code === "ENOTEMPTY") {
					lastErr = err;
					continue;
				}
				throw err;
			}
			try {
				this.#tx(() => this.#indexPage(meta, body, bytes));
			} catch (err) {
				this.#removePageDir(id);
				throw err;
			}
			return { id, meta };
		}
		throw lastErr instanceof Error ? lastErr : new StoreError("id_collision", "could not allocate a page id");
	}

	/**
	 * @param {string} id
	 * @returns {PageMeta | BareMeta | null} null when the page does not exist
	 */
	getMeta(id) {
		this.#assertOpen();
		this.#assertId(id);
		const dir = this.#existingPageDir(id);
		if (dir === null) return null;
		const raw = readRegularFile(path.join(dir, "meta.json"));
		if (raw === null) return null;
		const meta = parseMeta(raw.toString("utf8"), id);
		if (meta === null) this.#log.warn("store.bad_meta", { id });
		return meta;
	}

	/**
	 * @param {string} id
	 * @param {"markdown" | "text" | "html" | "raw_html"} format
	 * @returns {string | null} null when there is no such body (not stored, no html captured, or no
	 *   visible text of its own: the caller knows from the meta whether the Markdown is that text)
	 */
	readBody(id, format) {
		this.#assertOpen();
		this.#assertId(id);
		if (format !== "markdown" && format !== "text" && format !== "html" && format !== "raw_html") {
			throw new StoreError("invalid_format", "format must be markdown, text, html or raw_html");
		}
		const dir = this.#existingPageDir(id);
		if (dir === null) return null;
		if (format !== "html" && format !== "raw_html") {
			const raw = readRegularFile(path.join(dir, format === "markdown" ? "content.md" : "content.txt"));
			return raw === null ? null : raw.toString("utf8");
		}
		const gz = readRegularFile(path.join(dir, format === "html" ? "page.html.gz" : "raw.html.gz"));
		if (gz === null) return null;
		try {
			return zlib.gunzipSync(gz, { maxOutputLength: MAX_HTML_CHARS }).toString("utf8");
		} catch {
			this.#log.warn("store.bad_html", { id, format });
			return null;
		}
	}

	/**
	 * @param {string} id
	 * @returns {{ url: string, text: string }[] | null} null when none were stored
	 */
	readLinks(id) {
		this.#assertOpen();
		this.#assertId(id);
		const dir = this.#existingPageDir(id);
		if (dir === null) return null;
		const raw = readRegularFile(path.join(dir, "links.json"));
		if (raw === null) return null;
		try {
			const v = /** @type {unknown} */ (JSON.parse(raw.toString("utf8")));
			if (!Array.isArray(v)) return null;
			/** @type {{ url: string, text: string }[]} */
			const out = [];
			for (const item of v) {
				if (typeof item === "object" && item !== null && typeof item.url === "string" && typeof item.text === "string") {
					out.push({ url: item.url, text: item.text });
				}
			}
			return out;
		} catch {
			return null;
		}
	}

	/**
	 * Newest stored ok page for this requested URL, fetched in the container
	 * scope within maxAgeMs.
	 * @param {string} url normalised or not; it is normalised here
	 * @param {{ maxAgeMs: number }} opts
	 * @returns {{ id: string, meta: PageMeta } | null}
	 */
	findFresh(url, { maxAgeMs }) {
		this.#assertOpen();
		if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new StoreError("invalid_argument", "maxAgeMs must be a non-negative number");
		const n = normalizeUrl(url);
		if (!n.ok) return null;
		const row = this.#sql.fresh.get(n.url, this.#clock.now() - maxAgeMs);
		if (row === undefined) return null;
		const id = asString(row.id);
		const meta = this.getMeta(id);
		if (meta === null || !isFullMeta(meta) || !meta.stored || meta.outcome !== "ok") return null;
		return { id, meta };
	}

	/**
	 * Full-text search over stored pages. The query is untrusted.
	 * @param {string} query
	 * @param {{ limit?: number }} [opts]
	 * @returns {SearchHit[]}
	 */
	search(query, { limit = SEARCH_LIMITS.defaultHits } = {}) {
		this.#assertOpen();
		const expr = buildFtsQuery(query);
		if (expr === null) return [];
		const lim = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), SEARCH_LIMITS.maxHits) : SEARCH_LIMITS.defaultHits;
		// Pages and files are two indexes: the best of both, by the rank each gives (smaller is better).
		const rows = [...this.#sql.search.all(expr, lim), ...this.#sql.searchFiles.all(expr, lim)];
		rows.sort((a, b) => asNumber(a.rank) - asNumber(b.rank));
		return rows.slice(0, lim).map((r) => ({
			id: asString(r.id),
			title: asString(r.title),
			url: asString(r.url),
			fetched_at: asString(r.fetched_at),
			snippet: asString(r.snippet),
		}));
	}

	/**
	 * @param {string} id validated file id
	 * @returns {string | null} the directory of the file when it and its shard are real directories
	 */
	#existingFileDir(id) {
		const shard = path.join(this.#filesDir, id.slice(-2));
		if (!isRealDir(lstatOrNull(shard))) return null;
		const dir = path.join(shard, id);
		if (!isRealDir(lstatOrNull(dir))) return null;
		return dir;
	}

	/** @param {string} id @returns {void} */
	#assertFileId(id) {
		if (!isValidFileId(id)) throw new StoreError("invalid_id", "not a valid file id");
	}

	/**
	 * @param {FileMeta} meta
	 * @param {string} body the text of a file that is one; "" for every other
	 * @param {string} content the key its bytes are counted under: contentKey(meta), or its own id
	 */
	#indexFile(meta, body, content) {
		const info = this.#sql.insertFile.run(meta.id, meta.url, meta.host, meta.fetched_at, Date.parse(meta.fetched_at), meta.name, meta.sniffed_type, meta.size, meta.sha256, meta.text ? 1 : 0, content);
		// Found by name and by address (the requested one, and where it came from in the end); by content only if that is text.
		const addresses = meta.final_url !== null && meta.final_url !== meta.url ? `${meta.url} ${meta.final_url}` : meta.url;
		this.#sql.insertFileFts.run(info.lastInsertRowid, meta.name, addresses, body);
	}

	/**
	 * @param {string} dir the directory of a stored file
	 * @param {FileMeta} meta
	 * @returns {string} what full-text search looks through: its text, or nothing
	 */
	#fileBody(dir, meta) {
		if (!meta.text || meta.size > FILE_LIMITS.maxTextBytes) return "";
		const raw = readRegularFile(path.join(dir, "data"));
		return raw === null ? "" : decodeText(raw, meta.charset);
	}

	/** @returns {number} bytes the retrieved files take on disk: every content once */
	#fileBytes() {
		return asNumber(this.#sql.fileBytes.get()?.bytes);
	}

	/** @returns {number} bytes the stored pages take: their files and the text the index holds of them */
	#pageBytes() {
		return asNumber(this.#sql.pageBytes.get()?.bytes);
	}

	/**
	 * Make room for a page that takes that many bytes: the oldest pages go, directory and index entry, until it
	 * fits. A page that is being read in pieces stays. Called before anything of the new page is put in place;
	 * with 0, it brings a store that is over its limit (the limit was lowered, or is new) back under it.
	 * @param {number} size bytes the new page adds
	 */
	#makePageRoom(size) {
		const full = () => new StoreError("store_full", "the page store has no room for the page");
		if (size > this.#maxPageBytes) throw full();
		let used = this.#pageBytes();
		if (used + size <= this.#maxPageBytes) return;
		let evicted = 0;
		let freed = 0;
		// Past the pages that are kept, on to the next oldest.
		let skip = 0;
		while (used + size > this.#maxPageBytes) {
			const rows = this.#sql.oldestPages.all(32, skip);
			if (rows.length === 0) break;
			for (const row of rows) {
				if (used + size <= this.#maxPageBytes) break;
				const id = asString(row.id);
				if (!isValidPageId(id) || this.#beingRead(id) || this.#removePageDir(id) === "refused") {
					skip++;
					continue;
				}
				this.#tx(() => {
					this.#sql.deleteFts.run(id);
					this.#sql.deletePage.run(id);
				});
				evicted++;
				used -= asNumber(row.bytes);
				freed += asNumber(row.bytes);
			}
		}
		if (evicted > 0) this.#log.info("store.pages_evicted", { pages: evicted, bytes: freed });
		if (used + size > this.#maxPageBytes) throw full();
	}

	/**
	 * @param {string} id
	 * @returns {boolean} true while the page or file is being read in pieces: it is not evicted
	 */
	#beingRead(id) {
		const until = this.#reading.get(id);
		if (until === undefined) return false;
		if (until > this.#clock.now()) return true;
		this.#reading.delete(id);
		return false;
	}

	/**
	 * A reader has taken a part of a file and will come back for more: for a while, the file is not evicted.
	 * @param {string} id
	 * @param {boolean} [done] the reader has all of it: the file is like any other again
	 */
	holdFile(id, done = false) {
		if (isValidFileId(id)) this.#hold(id, done);
	}

	/**
	 * The same for a page: a reader has taken a part of it and will come back for more.
	 * @param {string} id
	 * @param {boolean} [done] the reader has all of it
	 */
	holdPage(id, done = false) {
		if (isValidPageId(id)) this.#hold(id, done);
	}

	/** @param {string} id validated @param {boolean} done */
	#hold(id, done) {
		if (done) {
			this.#reading.delete(id);
			return;
		}
		// Not without end: readers that never come back are forgotten.
		if (this.#reading.size >= 1024 && !this.#reading.has(id)) {
			const now = this.#clock.now();
			for (const [other, until] of this.#reading) {
				if (until <= now) this.#reading.delete(other);
			}
			if (this.#reading.size >= 1024) return;
		}
		this.#reading.set(id, this.#clock.now() + FILE_STORE.readHoldMs);
	}

	/**
	 * Make room for a file of that many bytes: the oldest files go, bytes and record, until it fits. A file that
	 * is being read in pieces stays. Called before anything of the new file is put in place.
	 * @param {number} size bytes the new file adds
	 */
	#makeRoom(size) {
		const full = () => new StoreError("store_full", "the file store has no room for the file");
		if (size > this.#maxFileBytes) throw full();
		let used = this.#fileBytes();
		if (used + size <= this.#maxFileBytes) return;
		let evicted = 0;
		let freed = 0;
		// Past the files that are kept, on to the next oldest.
		let skip = 0;
		while (used + size > this.#maxFileBytes) {
			const rows = this.#sql.oldestFiles.all(32, skip);
			if (rows.length === 0) break;
			for (const row of rows) {
				if (used + size <= this.#maxFileBytes) break;
				const id = asString(row.id);
				if (!isValidFileId(id) || this.#beingRead(id) || this.#removeDir(this.#filesDir, this.#filesReal, id) === "refused") {
					skip++;
					continue;
				}
				this.#tx(() => {
					this.#sql.deleteFileFts.run(id);
					this.#sql.deleteFile.run(id);
				});
				evicted++;
				// The bytes are gone only with the last record that held them.
				if (asNumber(this.#sql.holders.get(asString(row.content))?.n) === 0) {
					used -= asNumber(row.size);
					freed += asNumber(row.size);
				}
			}
		}
		if (evicted > 0) this.#log.info("store.files_evicted", { files: evicted, bytes: freed });
		if (used + size > this.#maxFileBytes) throw full();
	}

	/**
	 * The stored bytes a new file can share: those of a record with the same SHA-256 and size whose bytes, read
	 * now, are what that record says. A record whose bytes turn out to be others is no longer counted with that
	 * content, but on its own.
	 * @param {string} key the content key of the new file
	 * @param {number} size
	 * @param {string} sha256
	 * @returns {string | null} the bytes to make a second name for; null: no stored file holds them
	 */
	#sharedBytes(key, size, sha256) {
		for (const id of this.#sql.sharers.all(key).map((r) => asString(r.id))) {
			const dir = isValidFileId(id) ? this.#existingFileDir(id) : null;
			const data = dir === null ? null : path.join(dir, "data");
			if (data !== null && sha256OfFile(data, size) === sha256) return data;
			this.#sql.rekey.run(id, id);
			this.#log.warn("store.bytes_differ", { id });
		}
		return null;
	}

	/**
	 * Keep a retrieved file: its bytes are moved from where they were put together into a directory named by a
	 * fresh id, next to a meta record, and indexed. Nothing of the record is ever part of a path. Bytes that are
	 * stored already are not stored again: the new record gets a second name for them. Room is made first
	 * (see the class comment); a file there is no room for throws StoreError "store_full" and leaves nothing.
	 * The type it is stored under is the sniffer's word as settledType() corrects it; a file that turns out to
	 * be a program throws StoreError "file_refused" and leaves nothing either.
	 * @param {FileRecord} record
	 * @returns {{ id: string, meta: FileMeta }}
	 */
	saveFile(record) {
		this.#assertOpen();
		const n = normalizeUrl(record.url);
		if (!n.ok) throw new StoreError("invalid_record", "url is not a valid http(s) URL");
		if (!SNIFFED_TYPES.includes(record.sniffed_type)) throw new StoreError("invalid_record", "sniffed_type is not one of the sniffer's");
		if (!Number.isSafeInteger(record.size) || record.size < 0 || record.size > WIRE.MAX_FILE_BYTES || !/^[0-9a-f]{64}$/.test(record.sha256)) {
			throw new StoreError("invalid_record", "size or hash is not usable");
		}
		// The bytes must lie inside the data directory, as a plain file of the size that was announced.
		const source = path.resolve(record.tempPath);
		const st = lstatOrNull(source);
		if (!source.startsWith(path.resolve(this.dataDir) + path.sep) || st === null || !st.isFile() || st.size !== record.size) {
			throw new StoreError("invalid_record", "the bytes of the file are not where they should be");
		}
		// Before room is made for it: what it is, now that all of it is here.
		const sniffedType = settledType(source, record.sniffed_type, record.size);
		const key = `${record.sha256}:${record.size}`;
		const shared = this.#sharedBytes(key, record.size, record.sha256);
		// Bytes that are there already take no room.
		if (shared === null) this.#makeRoom(record.size);
		const now = this.#clock.now();
		/** @param {string} id @returns {FileMeta} */
		const makeMeta = (id) => ({
			v: 1,
			kind: "file",
			id,
			url: n.url,
			final_url: typeof record.final_url === "string" ? record.final_url.slice(0, WIRE.MAX_FINAL_URL) : null,
			host: n.host,
			fetched_at: isoSeconds(now),
			http_status: record.http_status,
			name: displayName(record.suggested_name, record.final_url ?? n.url, sniffedType),
			declared_type: typeof record.declared_type === "string" ? record.declared_type.slice(0, 200) : null,
			sniffed_type: sniffedType,
			charset: typeof record.charset === "string" ? record.charset.slice(0, 40) : null,
			size: record.size,
			sha256: record.sha256,
			text: record.text_like && record.size <= FILE_LIMITS.maxTextBytes,
			cookie_scope: "container",
			redirect_origins: [...(record.redirect_origins ?? [])],
		});
		let lastErr = null;
		for (let attempt = 0; attempt < 4; attempt++) {
			const id = newFileId(now, this.#randomBytes);
			const meta = makeMeta(id);
			const shard = path.join(this.#filesDir, id.slice(-2));
			fs.mkdirSync(shard, { recursive: true, mode: 0o700 });
			if (!isRealDir(lstatOrNull(shard))) throw new StoreError("unsafe_path", "shard is not a directory");
			const finalDir = path.join(shard, id);
			if (lstatOrNull(finalDir) !== null) {
				lastErr = new StoreError("id_collision", "file id already exists");
				continue;
			}
			const tmp = path.join(shard, `.tmp-${crypto.randomBytes(6).toString("hex")}`);
			fs.mkdirSync(tmp, { mode: 0o700 });
			const data = path.join(tmp, "data");
			let linked = false;
			try {
				if (shared !== null) {
					try {
						// A second name for bytes that are stored already. Where the file system gives none, they are stored again.
						fs.linkSync(shared, data);
						linked = true;
					} catch {
						this.#makeRoom(record.size);
					}
				}
				// Same file system (both lie in the data directory): the bytes are moved, not copied, and never half there.
				if (!linked) renameWithRetry(source, data);
				fs.chmodSync(data, 0o600);
				writeNewFile(path.join(tmp, "meta.json"), JSON.stringify(meta, null, "\t") + "\n");
				renameWithRetry(tmp, finalDir);
			} catch (err) {
				removeLeftover(tmp, { recursive: true, force: true });
				const code = /** @type {NodeJS.ErrnoException} */ (err).code;
				if ((code === "EEXIST" || code === "ENOTEMPTY") && lstatOrNull(source) !== null) {
					lastErr = err;
					continue;
				}
				throw err;
			}
			// Counted with the content it shares; on its own where the same bytes lie there a second time.
			const content = linked || shared === null ? key : id;
			try {
				const body = this.#fileBody(finalDir, meta);
				this.#tx(() => {
					// Its text is searched with this record from now on, and no longer with the older ones of the same bytes.
					if (linked && body !== "") this.#sql.dropSharedText.run(key);
					this.#indexFile(meta, body, content);
				});
			} catch (err) {
				this.#removeDir(this.#filesDir, this.#filesReal, id);
				throw err;
			}
			// The bytes have their place: what was put together for them is not needed.
			if (linked) fs.rmSync(source, { force: true });
			return { id, meta };
		}
		throw lastErr instanceof Error ? lastErr : new StoreError("id_collision", "could not allocate a file id");
	}

	/**
	 * @param {string} id
	 * @returns {FileMeta | null} null when the file does not exist, or its record cannot be trusted
	 */
	getFileMeta(id) {
		this.#assertOpen();
		this.#assertFileId(id);
		const dir = this.#existingFileDir(id);
		if (dir === null) return null;
		const raw = readRegularFile(path.join(dir, "meta.json"));
		if (raw === null) return null;
		const meta = parseFileMeta(raw.toString("utf8"), id);
		if (meta === null) this.#log.warn("store.bad_meta", { id });
		return meta;
	}

	/**
	 * @param {string} id
	 * @returns {string | null} the text of a file that is shown as text; null for every other, and when it is gone
	 */
	readFileText(id) {
		const meta = this.getFileMeta(id);
		if (meta === null || !meta.text || meta.size > FILE_LIMITS.maxTextBytes) return null;
		const dir = this.#existingFileDir(id);
		const raw = dir === null ? null : readRegularFile(path.join(dir, "data"));
		return raw === null ? null : decodeText(raw, meta.charset);
	}

	/**
	 * A part of the bytes of a file, exactly as they were retrieved.
	 * @param {string} id
	 * @param {number} offset
	 * @param {number} length at most FILE_LIMITS.exportChunkBytes
	 * @returns {Buffer | null} fewer bytes than asked for at the end of the file; null when the file is gone or is
	 *   not the one its record describes
	 */
	readFileChunk(id, offset, length) {
		const meta = this.getFileMeta(id);
		const dir = meta === null ? null : this.#existingFileDir(id);
		if (meta === null || dir === null) return null;
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > FILE_LIMITS.exportChunkBytes) {
			throw new StoreError("invalid_argument", "offset or length out of range");
		}
		/** @type {number} */
		let fd;
		try {
			fd = openNoFollow(path.join(dir, "data"), fs.constants.O_RDONLY);
		} catch (err) {
			const code = /** @type {NodeJS.ErrnoException} */ (err).code;
			if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return null;
			throw err;
		}
		try {
			const st = fs.fstatSync(fd);
			if (!st.isFile() || st.size !== meta.size) return null;
			const want = Math.max(0, Math.min(length, meta.size - offset));
			const out = Buffer.alloc(want);
			let got = 0;
			while (got < want) {
				const n = fs.readSync(fd, out, got, want - got, offset + got);
				if (n === 0) return null;
				got += n;
			}
			// A reader that has not got all of it yet comes back for the rest: the file is not evicted under it.
			this.holdFile(id, offset + want >= meta.size);
			return out;
		} finally {
			fs.closeSync(fd);
		}
	}

	/**
	 * Newest stored file for this requested URL, retrieved within maxAgeMs.
	 * @param {string} url normalised or not; it is normalised here
	 * @param {{ maxAgeMs: number }} opts
	 * @returns {{ id: string, meta: FileMeta } | null}
	 */
	findFreshFile(url, { maxAgeMs }) {
		this.#assertOpen();
		if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new StoreError("invalid_argument", "maxAgeMs must be a non-negative number");
		const n = normalizeUrl(url);
		if (!n.ok) return null;
		const row = this.#sql.freshFile.get(n.url, this.#clock.now() - maxAgeMs);
		if (row === undefined) return null;
		const id = asString(row.id);
		const meta = this.getFileMeta(id);
		return meta === null ? null : { id, meta };
	}

	/**
	 * Remove one page directory, only ever inside <dataDir>/pages and never
	 * through a symlink.
	 * @param {string} id validated
	 * @returns {"removed" | "missing" | "refused"}
	 */
	#removePageDir(id) {
		return this.#removeDir(this.#pagesDir, this.#pagesReal, id);
	}

	/**
	 * Remove the directory of one page or file, only ever inside its own root and never through a symlink.
	 * @param {string} root <dataDir>/pages or <dataDir>/files
	 * @param {string} rootReal the same, resolved
	 * @param {string} id validated
	 * @returns {"removed" | "missing" | "refused"}
	 */
	#removeDir(root, rootReal, id) {
		const shard = path.join(root, id.slice(-2));
		const dir = path.join(shard, id);
		if (path.dirname(path.dirname(dir)) !== root) return "refused";
		const shardStat = lstatOrNull(shard);
		if (shardStat === null) return "missing";
		if (!isRealDir(shardStat)) return "refused";
		const dirStat = lstatOrNull(dir);
		if (dirStat === null) return "missing";
		if (!isRealDir(dirStat)) return "refused";
		if (fs.realpathSync(dir) !== path.join(rootReal, id.slice(-2), id)) return "refused";
		fs.rmSync(dir, { recursive: true, force: true });
		return "removed";
	}

	/** Remove leftovers of interrupted saves. */
	#sweepTemp() {
		for (const root of [this.#pagesDir, this.#filesDir]) {
			for (const shard of fs.readdirSync(root, { withFileTypes: true })) {
				if (!shard.isDirectory() || !SHARD_RE.test(shard.name)) continue;
				const shardPath = path.join(root, shard.name);
				for (const entry of fs.readdirSync(shardPath, { withFileTypes: true })) {
					if (entry.isDirectory() && entry.name.startsWith(".tmp-")) {
						fs.rmSync(path.join(shardPath, entry.name), { recursive: true, force: true });
					}
				}
			}
		}
	}

	/**
	 * The record directories of one root, by shard: every directory whose name is an id of that kind and lies in
	 * the shard its id says. Anything else in there is passed over.
	 * @param {string} root <dataDir>/pages or <dataDir>/files
	 * @param {(id: unknown) => id is string} valid
	 * @returns {Generator<{ id: string, dir: string }, void, void>}
	 */
	*#records(root, valid) {
		for (const shard of fs.readdirSync(root, { withFileTypes: true })) {
			if (!shard.isDirectory() || !SHARD_RE.test(shard.name)) continue;
			const shardPath = path.join(root, shard.name);
			for (const entry of fs.readdirSync(shardPath, { withFileTypes: true })) {
				if (entry.isDirectory() && valid(entry.name) && entry.name.endsWith(shard.name)) yield { id: entry.name, dir: path.join(shardPath, entry.name) };
			}
		}
	}

	/**
	 * Remove the directories of pages and files that the index does not know and whose id was made before the
	 * cutoff. The index is where purge and the limits look: a directory that never got its row (the process ended
	 * between the two) or lost it (the index was lost) would otherwise stay for good. Only names are read here,
	 * the age is the time in the id; a younger one is left alone.
	 * @param {number} cutoff
	 * @returns {{ unknown: number, refused: number }}
	 */
	#purgeUnknown(cutoff) {
		let unknown = 0;
		let refused = 0;
		for (const [root, rootReal, valid, known] of /** @type {const} */ ([
			[this.#pagesDir, this.#pagesReal, isValidPageId, this.#sql.knownPage],
			[this.#filesDir, this.#filesReal, isValidFileId, this.#sql.knownFile],
		])) {
			for (const { id } of this.#records(root, valid)) {
				if (idTime(id) >= cutoff || known.get(id) !== undefined) continue;
				if (this.#removeDir(root, rootReal, id) === "refused") {
					refused++;
					this.#log.warn("store.purge_refused", { id });
				} else unknown++;
			}
		}
		return { unknown, refused };
	}

	/**
	 * Remove pages fetched more than maxAgeMs ago (strictly older), and bring the pages back under their limit
	 * should they be over it.
	 * @param {{ maxAgeMs: number }} opts
	 * @returns {{ rows: number, dirs: number, refused: number, files: number, unknown: number }}
	 *   rows, dirs: pages. files: retrieved files that went, bytes and record. unknown: directories of either that
	 *   the index did not know and that were older than that by their id. refused: directories of any of them that
	 *   were symlinks or resolved outside their root; they and their rows are left alone
	 */
	purge({ maxAgeMs }) {
		this.#assertOpen();
		if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new StoreError("invalid_argument", "maxAgeMs must be a non-negative number");
		this.#sweepTemp();
		const cutoff = this.#clock.now() - maxAgeMs;
		const ids = this.#sql.older
			.all(cutoff)
			.map((r) => asString(r.id))
			.filter(isValidPageId);
		let dirs = 0;
		let refused = 0;
		/** @type {string[]} */
		const drop = [];
		for (const id of ids) {
			const res = this.#removePageDir(id);
			if (res === "refused") {
				refused++;
				this.#log.warn("store.purge_refused", { id });
				continue;
			}
			if (res === "removed") dirs++;
			drop.push(id);
		}
		/** @type {string[]} */
		const dropFiles = [];
		for (const id of this.#sql.olderFiles.all(cutoff).map((r) => asString(r.id)).filter(isValidFileId)) {
			if (this.#removeDir(this.#filesDir, this.#filesReal, id) === "refused") {
				refused++;
				this.#log.warn("store.purge_refused", { id });
				continue;
			}
			dropFiles.push(id);
		}
		this.#tx(() => {
			for (const id of drop) {
				this.#sql.deleteFts.run(id);
				this.#sql.deletePage.run(id);
			}
			for (const id of dropFiles) {
				this.#sql.deleteFileFts.run(id);
				this.#sql.deleteFile.run(id);
			}
		});
		// After the rows of what just went are gone: what is still unknown then never had one.
		const strays = this.#purgeUnknown(cutoff);
		// A limit that is new or was lowered is met here, at the start and once a day, and not in the middle of a fetch.
		try {
			this.#makePageRoom(0);
		} catch (err) {
			// Everything that is left is held by a reader or cannot be removed: nothing to do about it now.
			if (!(err instanceof StoreError && err.code === "store_full")) throw err;
		}
		return { rows: drop.length, dirs, refused: refused + strays.refused, files: dropFiles.length, unknown: strays.unknown };
	}

	/**
	 * @returns {boolean} true when a directory of a page or a file lies in the store. Stops at the first one.
	 */
	#holdsRecords() {
		for (const _ of this.#records(this.#pagesDir, isValidPageId)) return true;
		for (const _ of this.#records(this.#filesDir, isValidFileId)) return true;
		return false;
	}

	/**
	 * For the start: an index without a single row over directories that hold records is one that was lost, or
	 * made anew after the old one could not be used. It is rebuilt from the directories, so that retention, the
	 * limits and search see what is there. An index that knows anything is left alone: that costs two counts.
	 * How long a rebuild takes depends on what is stored - every stored text is read and indexed again.
	 * @returns {{ pages: number, stored: number, skipped: number, files: number, ms: number } | null} null: nothing to do
	 */
	recoverIndex() {
		this.#assertOpen();
		if (asNumber(this.#sql.count.get()?.n) > 0 || asNumber(this.#sql.countFiles.get()?.n) > 0) return null;
		if (!this.#holdsRecords()) return null;
		const started = this.#clock.now();
		const rebuilt = { ...this.rebuildIndex(), ms: 0 };
		rebuilt.ms = this.#clock.now() - started;
		this.#log.warn("store.index_rebuilt", rebuilt);
		return rebuilt;
	}

	/**
	 * Throw the index away and rebuild it from the page and file directories. One page at a time: no more of the
	 * store is in memory than the text of one page or file. The old index stands until the new one is complete.
	 * @returns {{ pages: number, stored: number, skipped: number, files: number }}
	 */
	rebuildIndex() {
		this.#assertOpen();
		this.#sweepTemp();
		let skipped = 0;
		// What lies in the shards and is no record: counted, as before.
		for (const [root, valid] of /** @type {const} */ ([[this.#pagesDir, isValidPageId], [this.#filesDir, isValidFileId]])) {
			for (const shard of fs.readdirSync(root, { withFileTypes: true })) {
				if (!shard.isDirectory() || !SHARD_RE.test(shard.name)) continue;
				for (const entry of fs.readdirSync(path.join(root, shard.name), { withFileTypes: true })) {
					if ((!entry.isDirectory() || !valid(entry.name) || !entry.name.endsWith(shard.name)) && !entry.name.startsWith(".tmp-")) skipped++;
				}
			}
		}
		/** @type {{ meta: FileMeta, dir: string, dev: number, ino: number, content: string }[]} */
		const files = [];
		for (const { id, dir } of this.#records(this.#filesDir, isValidFileId)) {
			const rawMeta = readRegularFile(path.join(dir, "meta.json"));
			const meta = rawMeta === null ? null : parseFileMeta(rawMeta.toString("utf8"), id);
			// A record without its bytes, or with other bytes than it describes, is no file.
			const st = meta === null ? null : lstatOrNull(path.join(dir, "data"));
			if (meta === null || st === null || !st.isFile() || st.size !== meta.size) {
				skipped++;
				continue;
			}
			files.push({ meta, dir, dev: st.dev, ino: st.ino, content: meta.id });
		}
		this.#restoreLinks(files);
		// The text of a content is indexed with its newest record only.
		/** @type {Map<string, FileMeta>} */
		const newest = new Map();
		for (const { meta, content } of files) {
			const seen = newest.get(content);
			if (seen === undefined || meta.fetched_at > seen.fetched_at || (meta.fetched_at === seen.fetched_at && meta.id > seen.id)) newest.set(content, meta);
		}
		let pages = 0;
		let stored = 0;
		this.#tx(() => {
			this.#sql.clearFts.run();
			this.#sql.clearPages.run();
			this.#sql.clearFileFts.run();
			this.#sql.clearFiles.run();
			for (const { id, dir } of this.#records(this.#pagesDir, isValidPageId)) {
				const rawMeta = readRegularFile(path.join(dir, "meta.json"));
				const meta = rawMeta === null ? null : parseMeta(rawMeta.toString("utf8"), id);
				if (meta === null) {
					skipped++;
					continue;
				}
				/** @type {string | null} */
				let body = null;
				if (isFullMeta(meta) && meta.stored) {
					const raw = readRegularFile(path.join(dir, "content.md"));
					if (raw === null) {
						this.#log.warn("store.body_missing", { id: meta.id });
						meta.stored = false;
					} else {
						const text = readRegularFile(path.join(dir, "content.txt"));
						body = searchBody(raw.toString("utf8"), text === null ? null : text.toString("utf8"));
					}
				}
				this.#indexPage(meta, body, this.#pageSizes(id).disk + (body === null ? 0 : PAGE_STORE.indexShare * Buffer.byteLength(body, "utf8")));
				pages++;
				if (isFullMeta(meta) && meta.stored) stored++;
			}
			for (const { meta, dir, content } of files) this.#indexFile(meta, newest.get(content) === meta ? this.#fileBody(dir, meta) : "", content);
		});
		return { pages, stored, skipped, files: files.length };
	}

	/**
	 * Find out which stored files hold the same bytes, and under which key each is counted. Records with the same
	 * SHA-256 and size that are names of one file already share its key. Where they are files of their own - an
	 * index from before identical bytes were kept once, a copy of the data directory that did not keep the links -
	 * the later ones become names of the first, once both were read and found to be what their records say.
	 * @param {{ meta: FileMeta, dir: string, dev: number, ino: number, content: string }[]} files content is set here
	 */
	#restoreLinks(files) {
		/** @type {Map<string, typeof files>} */
		const groups = new Map();
		for (const file of files) {
			const key = `${file.meta.sha256}:${file.meta.size}`;
			const group = groups.get(key);
			if (group === undefined) groups.set(key, [file]);
			else group.push(file);
		}
		let relinked = 0;
		for (const [key, group] of groups) {
			if (group.length === 1) {
				group[0].content = key;
				continue;
			}
			group.sort((a, b) => (a.meta.id < b.meta.id ? -1 : 1));
			/** @type {(typeof files)[number] | null} the record whose bytes the others share */
			let first = null;
			for (const file of group) {
				const data = path.join(file.dir, "data");
				if (first !== null && file.dev === first.dev && file.ino === first.ino) {
					file.content = key;
					continue;
				}
				// Bytes that are not what their record says are left alone, and counted on their own.
				if (sha256OfFile(data, file.meta.size) !== file.meta.sha256) continue;
				if (first === null) {
					first = file;
					file.content = key;
					continue;
				}
				const tmp = path.join(file.dir, `.link-${crypto.randomBytes(6).toString("hex")}`);
				try {
					fs.linkSync(path.join(first.dir, "data"), tmp);
					renameWithRetry(tmp, data);
					file.content = key;
					relinked++;
				} catch {
					removeLeftover(tmp, { force: true });
				}
			}
		}
		if (relinked > 0) this.#log.info("store.links_restored", { files: relinked });
	}

	/**
	 * @returns {{ pages: number, stored: number, files: number, file_bytes: number, file_bytes_max: number }}
	 *   file_bytes: what the retrieved files take on disk, identical ones counted once; file_bytes_max: what they may take
	 */
	stats() {
		this.#assertOpen();
		const row = this.#sql.count.get();
		const files = this.#sql.countFiles.get();
		return { pages: asNumber(row?.n), stored: asNumber(row?.stored), files: asNumber(files?.n), file_bytes: this.#fileBytes(), file_bytes_max: this.#maxFileBytes };
	}

	/**
	 * @returns {{ bytes: number, bytes_max: number }} what the stored pages take - their files and the text the index
	 *   holds of them - and what they may take
	 */
	pageUsage() {
		this.#assertOpen();
		return { bytes: this.#pageBytes(), bytes_max: this.#maxPageBytes };
	}

	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}
}
