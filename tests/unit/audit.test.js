import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AUDIT_LIMITS, AuditLog } from "../../daemon/src/audit.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

// Windows has no mode bits: what they are is checked where there are.
const MODES = process.platform !== "win32";

const DAY = 86400000;

/** @type {string[]} */
const dirs = [];
after(() => {
	for (const dir of dirs) removeTempDir(dir);
});

/** @param {string} file */
const mode = (file) => fs.statSync(file).mode & 0o777;

/** @param {{ maxBytes?: number }} [opts] */
function setup(opts = {}) {
	const dir = makeTempDir("audit");
	dirs.push(dir);
	const dataDir = path.join(dir, "data");
	const clock = new FakeClock();
	/** @type {{ level: string, event: string, fields: Record<string, unknown> }[]} */
	const logs = [];
	/** @param {string} level */
	const at = (level) => (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields = {}) => void logs.push({ level, event, fields });
	const log = { info: at("info"), warn: at("warn"), error: at("error") };
	const audit = new AuditLog({ dataDir, clock, log, ...opts });
	/** @param {string} file @returns {any[]} */
	const entries = (file = audit.file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
	/** @param {string} job @param {Partial<import("../../daemon/src/audit.js").AuditEntry>} [over] */
	const add = (job, over = {}) => audit.append({ job, kind: "fetch", url: `https://example.com/${job}`, host: "example.com", outcome: "ok", code: null, cookie_scope: "container", dispatched: true, duration_ms: 1, redirect_origins: [], ...over });
	/** @param {string} event */
	const logged = (event) => logs.filter((l) => l.event === event);
	return { dir, dataDir, clock, logs, log, audit, entries, add, logged };
}

test("purge drops the entries that are older than the retention and keeps every other, in a file of the same mode", () => {
	const t = setup();
	t.audit.open();
	t.add("j_old1");
	t.add("j_old2");
	t.clock.advance(10 * DAY);
	t.add("j_mid");
	t.clock.advance(20 * DAY);
	t.add("j_edge");
	t.clock.advance(1);
	// j_old* are 30 days and 1 ms old, j_mid 20 days and 1 ms, j_edge 1 ms.
	assert.deepEqual(t.audit.purge({ maxAgeMs: 31 * DAY }), { entries: 0 });
	const untouched = fs.statSync(t.audit.file);
	assert.deepEqual(t.audit.purge({ maxAgeMs: 30 * DAY + 1 }), { entries: 0 }, "exactly at the limit stays");
	assert.equal(fs.statSync(t.audit.file).ino, untouched.ino, "a log nothing is dropped from is not written again");

	assert.deepEqual(t.audit.purge({ maxAgeMs: 30 * DAY }), { entries: 2 });
	assert.deepEqual(t.entries().map((e) => e.job), ["j_mid", "j_edge"]);
	if (MODES) assert.equal(mode(t.audit.file), 0o600);
	assert.deepEqual(fs.readdirSync(t.dataDir), ["audit.jsonl"], "nothing else is left in the directory");

	// The log goes on in the new file, not in the one that was replaced.
	t.add("j_after");
	assert.equal(t.audit.ok, true);
	assert.deepEqual(t.entries().map((e) => e.job), ["j_mid", "j_edge", "j_after"]);
	assert.deepEqual(t.audit.purge({ maxAgeMs: 0 }), { entries: 2 }, "the entry of this very millisecond is not older than now");
	assert.deepEqual(t.entries().map((e) => e.job), ["j_after"]);
	t.clock.advance(1);
	assert.deepEqual(t.audit.purge({ maxAgeMs: 0 }), { entries: 1 });
	assert.equal(fs.readFileSync(t.audit.file, "utf8"), "");
	t.add("j_last");
	assert.deepEqual(t.entries().map((e) => e.job), ["j_last"]);
	assert.throws(() => t.audit.purge({ maxAgeMs: -1 }), RangeError);
	t.audit.close();
	assert.deepEqual(t.audit.purge({ maxAgeMs: 0 }), { entries: 0 }, "a closed log is left alone");
});

test("purge reads a log of any size piece by piece, and treats what is no entry as part of what came before it", () => {
	const t = setup();
	t.audit.open();
	t.audit.close();
	const at = (/** @type {number} */ daysAgo) => new Date(t.clock.now() - daysAgo * DAY).toISOString();
	const line = (/** @type {number} */ daysAgo, /** @type {string} */ job) => JSON.stringify({ ts: at(daysAgo), job, kind: "fetch", url: `https://example.com/${"p".repeat(700)}`, outcome: "ok" });
	/** @type {string[]} */
	const lines = [];
	// More than the megabyte that is read at a time, so lines lie across the pieces.
	for (let i = 0; i < 1500; i++) lines.push(line(40, `j_old${i}`));
	lines.push("this line tells no time and follows old ones");
	for (let i = 0; i < 1500; i++) lines.push(line(5, `j_new${i}`));
	lines.push("{not json, after young ones");
	lines.push("");
	lines.push("z".repeat(AUDIT_LIMITS.maxLineBytes * 3));
	lines.push(line(1, "j_newest"));
	// The last write was cut off.
	fs.writeFileSync(t.audit.file, lines.join("\n") + "\n" + line(0, "j_torn").slice(0, 60), { mode: 0o600 });
	assert.ok(fs.statSync(t.audit.file).size > 2 * 1048576);

	t.audit.open();
	assert.deepEqual(t.audit.purge({ maxAgeMs: 30 * DAY }), { entries: 1501 });
	const kept = fs.readFileSync(t.audit.file, "utf8").split("\n");
	assert.equal(kept.pop(), "", "every line that is kept has its end");
	assert.equal(kept.length, 1503);
	assert.deepEqual(kept.slice(0, 1500), lines.slice(1501, 3001), "byte for byte");
	assert.deepEqual(kept.slice(1500), ["{not json, after young ones", line(1, "j_newest"), line(0, "j_torn").slice(0, 60)]);
	t.add("j_next");
	assert.equal(JSON.parse(fs.readFileSync(t.audit.file, "utf8").trimEnd().split("\n").at(-1) ?? "").job, "j_next");
	t.audit.close();
});

test("purge: whenever the process ends, the log is whole - the old one or the new one - and a leftover is cleared at the next start", (t) => {
	const s = setup();
	s.audit.open();
	s.add("j_old");
	s.clock.advance(40 * DAY);
	s.add("j_new");
	const before = fs.readFileSync(s.audit.file, "utf8");

	// The rename never happens: as if the process had ended just before it.
	const rename = t.mock.method(fs, "renameSync", () => {
		throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
	});
	assert.throws(() => s.audit.purge({ maxAgeMs: 30 * DAY }), /EIO/);
	rename.mock.restore();
	assert.equal(fs.readFileSync(s.audit.file, "utf8"), before, "nothing was lost");
	assert.deepEqual(fs.readdirSync(s.dataDir), ["audit.jsonl"]);
	s.add("j_more");
	assert.equal(s.audit.ok, true);
	assert.deepEqual(s.entries().map((e) => e.job), ["j_old", "j_new", "j_more"]);

	// The new file is written and flushed before it takes the place of the old one.
	/** @type {string[]} */
	const order = [];
	const realSync = fs.fsyncSync;
	const realRename = fs.renameSync;
	t.mock.method(fs, "fsyncSync", (/** @type {number} */ fd) => {
		order.push(fs.fstatSync(fd).isDirectory() ? "flush directory" : "flush file");
		return realSync(fd);
	});
	t.mock.method(fs, "renameSync", (/** @type {string} */ from, /** @type {string} */ to) => {
		order.push(`rename ${path.basename(from).replace(/[0-9a-f]{12}/, "X")} ${path.basename(to)}`);
		if (MODES) assert.equal(mode(from), 0o600);
		assert.equal(path.dirname(from), s.dataDir, "in the same directory, so the rename is one step");
		return realRename(from, to);
	});
	assert.deepEqual(s.audit.purge({ maxAgeMs: 30 * DAY }), { entries: 1 });
	assert.deepEqual(order, ["flush file", "rename audit.jsonl.X.tmp audit.jsonl", "flush directory"]);
	t.mock.restoreAll();
	s.audit.close();

	// What a rewrite left behind when the process did end in the middle.
	fs.writeFileSync(path.join(s.dataDir, "audit.jsonl.0123456789ab.tmp"), "half");
	fs.writeFileSync(path.join(s.dataDir, "audit.jsonl.1.0123456789ab.tmp"), "half");
	fs.writeFileSync(path.join(s.dataDir, "audit.jsonl.notes"), "not ours");
	const again = new AuditLog({ dataDir: s.dataDir, clock: s.clock, log: s.log });
	again.open();
	assert.deepEqual(fs.readdirSync(s.dataDir).sort(), ["audit.jsonl", "audit.jsonl.notes"]);
	assert.deepEqual(s.entries().map((e) => e.job), ["j_new", "j_more"]);
	again.close();
});

test("size limit: a full log is set aside as audit.jsonl.1, one generation, and purge reaches into that one too", () => {
	assert.equal(AUDIT_LIMITS.maxBytes, 32 * 1048576);
	const t = setup({ maxBytes: 1000 });
	t.audit.open();
	const lineBytes = () => fs.statSync(t.audit.file).size;
	t.add("j_0");
	const one = lineBytes();
	assert.ok(one > 150 && one < 400, String(one));
	let n = 1;
	while (!fs.existsSync(t.audit.rotated)) t.add(`j_${n++}`);
	// The line that would have taken the file past the limit is the first of the new file.
	assert.deepEqual(t.entries().map((e) => e.job), [`j_${n - 1}`]);
	assert.deepEqual(t.entries(t.audit.rotated).map((e) => e.job), Array.from({ length: n - 1 }, (_, i) => `j_${i}`));
	assert.ok(fs.statSync(t.audit.rotated).size <= 1000);
	if (MODES) assert.equal(mode(t.audit.rotated), 0o600);
	if (MODES) assert.equal(mode(t.audit.file), 0o600);
	assert.deepEqual(t.logged("audit.rotated").length, 1);

	// The next time, the file set aside before is replaced: never more than two.
	const firstOfSecond = n - 1;
	t.clock.advance(10 * DAY);
	while (t.logged("audit.rotated").length < 2) t.add(`j_${n++}`);
	assert.equal(t.entries(t.audit.rotated)[0].job, `j_${firstOfSecond}`);
	assert.deepEqual(fs.readdirSync(t.dataDir).sort(), ["audit.jsonl", "audit.jsonl.1"]);
	assert.ok(fs.statSync(t.audit.file).size + fs.statSync(t.audit.rotated).size <= 2000);

	// Retention: the first entry of the file set aside is ten days older than its others.
	const inRotated = t.entries(t.audit.rotated).length;
	assert.deepEqual(t.audit.purge({ maxAgeMs: 5 * DAY }), { entries: 1 });
	assert.equal(t.entries(t.audit.rotated).length, inRotated - 1);
	if (MODES) assert.equal(mode(t.audit.rotated), 0o600);
	t.clock.advance(6 * DAY);
	t.add("j_young");
	assert.equal(t.logged("audit.rotated").length, 2);
	// Everything but that last entry is older now: the file set aside goes as a whole.
	const inLive = t.entries().length;
	assert.deepEqual(t.audit.purge({ maxAgeMs: 5 * DAY }), { entries: inRotated - 1 + inLive - 1 });
	assert.deepEqual(fs.readdirSync(t.dataDir), ["audit.jsonl"]);
	assert.deepEqual(t.entries().map((e) => e.job), ["j_young"]);
	t.audit.close();

	// A log from before there was a limit: set aside at the start, whatever its size.
	const big = setup({ maxBytes: 1000 });
	fs.mkdirSync(big.dataDir, { mode: 0o700 });
	fs.writeFileSync(big.audit.file, `${JSON.stringify({ ts: new Date(big.clock.now()).toISOString(), job: "j_legacy", pad: "x".repeat(5000) })}\n`, { mode: 0o600 });
	big.audit.open();
	assert.equal(fs.statSync(big.audit.file).size, 0);
	assert.equal(big.entries(big.audit.rotated)[0].job, "j_legacy");
	big.add("j_now");
	assert.deepEqual(big.entries().map((e) => e.job), ["j_now"]);
	big.audit.close();
});

test("a write that fails: the entry waits, work is refused while it does, and the log goes on by itself once it can be written", (t) => {
	const s = setup();
	s.audit.open();
	s.add("j_1");
	assert.equal(s.audit.ok, true);

	// The disk is full: every write fails, some after a part of the line got there.
	let full = true;
	const realWrite = fs.writeSync;
	t.mock.method(fs, "writeSync", (/** @type {any[]} */ ...args) => {
		if (!full) return /** @type {any} */ (realWrite)(...args);
		/** @type {any} */ (realWrite)(args[0], /** @type {Buffer} */ (args[1]).subarray(0, 7));
		throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
	});
	s.add("j_2");
	assert.equal(s.audit.ok, false);
	s.add("j_3");
	assert.equal(s.audit.ok, false);
	assert.equal(s.audit.ok, false);
	assert.deepEqual(s.logged("audit.write_failed").map((l) => l.level), ["error"], "said once, not on every try");
	assert.deepEqual(s.entries().map((e) => e.job), ["j_1"], "no torn line is left in the file");
	assert.ok(fs.readFileSync(s.audit.file, "utf8").endsWith("}\n"));

	// Room again. Nothing is restarted: the next look at the log writes what was waiting, in order.
	full = false;
	assert.equal(s.audit.ok, true);
	assert.deepEqual(s.entries().map((e) => e.job), ["j_1", "j_2", "j_3"]);
	assert.deepEqual(s.logged("audit.write_recovered").map((l) => [l.level, l.fields.entries]), [["info", 2]]);
	s.add("j_4");
	assert.deepEqual(s.entries().map((e) => e.job), ["j_1", "j_2", "j_3", "j_4"]);
	if (MODES) assert.equal(mode(s.audit.file), 0o600);

	// An append is a try as well, and a second failure is said again.
	full = true;
	s.add("j_5");
	full = false;
	s.add("j_6");
	assert.equal(s.audit.ok, true);
	assert.deepEqual(s.entries().map((e) => e.job), ["j_1", "j_2", "j_3", "j_4", "j_5", "j_6"]);
	assert.equal(s.logged("audit.write_failed").length, 2);

	// What does not even fit into memory is counted, and the count is written down.
	full = true;
	for (let i = 0; i < AUDIT_LIMITS.maxPending + 3; i++) s.add(`j_p${i}`);
	full = false;
	assert.equal(s.audit.ok, true);
	const all = s.entries();
	assert.equal(all.length, 6 + AUDIT_LIMITS.maxPending + 1);
	assert.deepEqual([all.at(-1).kind, all.at(-1).outcome, all.at(-1).lost], ["audit", "entries_lost", 3]);
	assert.equal(all.at(-2).job, `j_p${AUDIT_LIMITS.maxPending - 1}`);

	// The file was taken away under the open log (moved, or its directory emptied): found out at the next failure.
	full = true;
	s.add("j_7");
	fs.rmSync(s.audit.file);
	full = false;
	assert.equal(s.audit.ok, true);
	assert.deepEqual(s.entries().map((e) => e.job), ["j_7"]);
	if (MODES) assert.equal(mode(s.audit.file), 0o600);

	// Closed is closed: nothing is opened again, and nothing waits.
	s.audit.close();
	s.add("j_8");
	assert.equal(s.audit.ok, false);
	assert.deepEqual(s.entries().map((e) => e.job), ["j_7"]);
});

test("the audit file is opened as a plain file of its own: a link in its place is refused", { skip: process.platform === "win32" ? "symlinks" : false }, () => {
	const t = setup();
	fs.mkdirSync(t.dataDir, { mode: 0o700 });
	const elsewhere = path.join(t.dir, "elsewhere");
	fs.writeFileSync(elsewhere, "");
	fs.symlinkSync(elsewhere, t.audit.file);
	assert.throws(() => t.audit.open(), /not a regular file/);
	assert.equal(t.audit.ok, false);
	assert.equal(fs.readFileSync(elsewhere, "utf8"), "");
});
