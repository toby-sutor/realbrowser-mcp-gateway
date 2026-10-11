import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import http from "node:http";
import { startTestDaemon } from "../helpers/daemon.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeExtension, makeResult } from "../helpers/fake-extension.js";
import { counterBytes, makeRecord, quietLog } from "../helpers/pages.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";
import { ConfigError, LIMITS } from "../../daemon/src/config.js";
import { PageStore } from "../../daemon/src/store.js";
import { describeFault, exitOnFault, start } from "../../daemon/src/server.js";

const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 5, 19, 44, 2);

/**
 * Put pages of the given ages into a data directory, as an earlier run of the daemon would have.
 * @param {string} dataDir
 * @param {number[]} agesInDays
 * @returns {string[]} their ids
 */
function seed(dataDir, agesInDays) {
	/** @type {string[]} */
	const ids = [];
	for (const [i, age] of agesInDays.entries()) {
		const store = new PageStore({ dataDir, clock: { now: () => T0 - age * DAY }, log: quietLog(), randomBytes: counterBytes(100 + i) });
		ids.push(store.save(makeRecord({ url: `https://example.com/aged-${age}`, markdown: `page that is ${age} days old` })).id);
		store.close();
	}
	return ids;
}

/** @param {{ logs: string[] }} daemon @param {string} event */
const logged = (daemon, event) => daemon.logs.map((l) => JSON.parse(l)).filter((l) => l.event === event);

/** @param {Awaited<ReturnType<typeof startTestDaemon>>} daemon @param {string} page */
const readable = async (daemon, page) => (await daemon.tool("/v1/pages/read", { page })).json.isError === false;

test("page store: opened at start, purged at start and then daily, closed at shutdown (item 10)", async () => {
	const dataDir = makeTempDir("server-data");
	const clock = new FakeClock(T0);
	try {
		const [ancient, old, recent] = seed(dataDir, [400, 31, 10]);
		const daemon = await startTestDaemon({ clock, dataDir });
		try {
			// Retention is 30 days unless config.json says otherwise.
			assert.deepEqual(logged(daemon, "store.purged").map((l) => [l.rows, l.dirs, l.refused, l.retention_days]), [[2, 2, 0, 30]]);
			assert.deepEqual((await daemon.agentStatus()).store, { pages: 1, stored: 1, files: 0, file_bytes: 0, file_bytes_max: 2147483648 });
			assert.equal(await readable(daemon, ancient), false);
			assert.equal(await readable(daemon, old), false);
			assert.equal(await readable(daemon, recent), true);
			assert.ok((await daemon.tool("/v1/pages/search", { query: "days old" })).json.text.includes("hits=1"));
			for (const id of [ancient, old]) assert.equal(fs.existsSync(path.join(dataDir, "pages", id.slice(-2), id)), false, "the files are gone, not only the index rows");

			// Twenty days on the page is exactly 30 days old: kept. A day later it goes.
			for (let day = 1; day <= 20; day++) clock.advance(DAY);
			assert.equal(await readable(daemon, recent), true);
			assert.equal(logged(daemon, "store.purged").length, 1, "a purge that removes nothing is not worth a line");
			clock.advance(DAY - 1);
			assert.equal(await readable(daemon, recent), true, "the purge runs once a day, not earlier");
			clock.advance(1);
			assert.equal(await readable(daemon, recent), false);
			assert.deepEqual(logged(daemon, "store.purged").map((l) => l.rows), [2, 1]);
			assert.deepEqual((await daemon.agentStatus()).store, { pages: 0, stored: 0, files: 0, file_bytes: 0, file_bytes_max: 2147483648 });
		} finally {
			await daemon.stop();
		}
		assert.equal(clock.pending, 0, "the daily timer does not outlive the daemon");
		// Closed properly: the next owner of the directory opens it without complaint.
		const again = new PageStore({ dataDir, clock, log: quietLog() });
		assert.deepEqual(again.stats(), { pages: 0, stored: 0, files: 0, file_bytes: 0, file_bytes_max: 2147483648 });
		const { id } = again.save(makeRecord());
		again.close();

		// A page whose directory cannot be removed safely does not stop the start.
		fs.rmSync(path.join(dataDir, "pages", id.slice(-2)), { recursive: true });
		fs.writeFileSync(path.join(dataDir, "pages", id.slice(-2)), "not a directory");
		const late = new FakeClock(T0 + 400 * DAY);
		const second = await startTestDaemon({ clock: late, dataDir });
		try {
			assert.equal((await second.request("GET", "/healthz", { auth: false })).status, 200);
			assert.equal(logged(second, "store.purge_refused").length, 1);
		} finally {
			await second.stop();
		}
	} finally {
		removeTempDir(dataDir);
	}
});

/** A spawn function that records what it is asked to start and starts nothing. */
function recordingSpawn() {
	/** @type {{ command: string, args: readonly string[] }[]} */
	const calls = [];
	return {
		calls,
		/** @type {import("../../daemon/src/notify.js").SpawnFn} */
		spawn: (command, args) => {
			calls.push({ command, args });
			const child = /** @type {any} */ (new EventEmitter());
			child.kill = () => true;
			return child;
		},
	};
}

test("an index that was lost is rebuilt at the start, before retention and the limits are applied; directories it never knew go with the daily purge", async () => {
	const dataDir = makeTempDir("server-lost-index");
	const clock = new FakeClock(T0);
	try {
		const [ancient, recent, newest] = seed(dataDir, [400, 10, 1]);
		fs.rmSync(path.join(dataDir, "index.db"));
		const daemon = await startTestDaemon({ clock, dataDir });
		try {
			assert.deepEqual(logged(daemon, "store.index_rebuilt").map((l) => [l.level, l.pages, l.stored, l.files, l.skipped]), [["warn", 3, 3, 0, 0]]);
			// Rebuilt first, then purged like any index: the page of 400 days ago went by its row.
			assert.deepEqual(logged(daemon, "store.purged").map((l) => [l.rows, l.dirs, l.unknown]), [[1, 1, 0]]);
			assert.deepEqual((await daemon.agentStatus()).store, { pages: 2, stored: 2, files: 0, file_bytes: 0, file_bytes_max: 2147483648 });
			assert.equal(await readable(daemon, ancient), false);
			assert.equal(await readable(daemon, recent), true);
			assert.ok((await daemon.tool("/v1/pages/search", { query: "days old" })).json.text.includes("hits=2"));
			assert.equal((await daemon.status()).settings.pages.max_total_mb, 2048);
		} finally {
			await daemon.stop();
		}

		// A page whose row never made it into the index (the process ended in between): the index does not count or
		// find it, and it goes when it is older than the retention by the time in its id.
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(path.join(dataDir, "index.db"));
		db.prepare("DELETE FROM pages_fts WHERE rowid IN (SELECT rowid FROM pages WHERE id = ?)").run(recent);
		db.prepare("DELETE FROM pages WHERE id = ?").run(recent);
		db.close();
		const dirOf = (/** @type {string} */ id) => path.join(dataDir, "pages", id.slice(-2), id);
		const next = await startTestDaemon({ clock, dataDir });
		try {
			assert.equal(logged(next, "store.index_rebuilt").length, 0, "an index that knows a page is not rebuilt");
			assert.equal((await next.agentStatus()).store.pages, 1, "not counted");
			assert.ok((await next.tool("/v1/pages/search", { query: "days old" })).json.text.includes("hits=1"), "not found");
			assert.equal(fs.existsSync(dirOf(recent)), true);
			for (let day = 1; day <= 20; day++) clock.advance(DAY);
			assert.equal(fs.existsSync(dirOf(recent)), true, "thirty days old: kept");
			clock.advance(DAY);
			assert.equal(fs.existsSync(dirOf(recent)), false);
			assert.deepEqual(logged(next, "store.purged").map((l) => [l.rows, l.unknown]), [[0, 1]]);
			assert.equal(await readable(next, newest), true);
		} finally {
			await next.stop();
		}
	} finally {
		removeTempDir(dataDir);
	}
});

test("an index that cannot be rebuilt does not stop the start: said once, and the next start tries again", async () => {
	const dataDir = makeTempDir("server-rebuild-fails");
	try {
		const [id] = seed(dataDir, [1]);
		fs.rmSync(path.join(dataDir, "index.db"));
		const metaFile = path.join(dataDir, "pages", id.slice(-2), id, "meta.json");
		// Not readable, by its owner either: reading it is an error, not a missing file.
		fs.chmodSync(metaFile, 0o000);
		const daemon = await startTestDaemon({ clock: new FakeClock(T0), dataDir });
		try {
			assert.deepEqual(logged(daemon, "store.index_rebuild_failed").map((l) => l.level), ["error"]);
			assert.equal(logged(daemon, "store.index_rebuilt").length, 0);
			assert.equal((await daemon.agentStatus()).store.pages, 0);
			assert.equal((await daemon.request("GET", "/healthz", { auth: false })).status, 200);
		} finally {
			await daemon.stop();
		}
		fs.chmodSync(metaFile, 0o600);
		const next = await startTestDaemon({ clock: new FakeClock(T0), dataDir });
		try {
			assert.equal(logged(next, "store.index_rebuilt").length, 1);
			assert.equal(await readable(next, id), true);
			assert.equal((await next.agentStatus()).store.pages, 1);
		} finally {
			await next.stop();
		}
	} finally {
		removeTempDir(dataDir);
	}
});

test("pages.max_total_mb: read from config.json, shown to the operator, and a value out of range stops the start", async () => {
	const dir = makeTempDir("server-pages-cap");
	try {
		const configDir = path.join(dir, "config");
		fs.mkdirSync(configDir, { mode: 0o700 });
		fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ pages: { max_total_mb: 64 } }), { mode: 0o600 });
		const daemon = await startTestDaemon({ configDir, dataDir: path.join(dir, "data") });
		try {
			assert.deepEqual((await daemon.status()).settings.pages, { max_total_mb: 64 });
		} finally {
			await daemon.stop();
		}
		fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ pages: { max_total_mb: 8 } }), { mode: 0o600 });
		await assert.rejects(startTestDaemon({ configDir, dataDir: path.join(dir, "data-2") }), (err) => err instanceof ConfigError && /pages\.max_total_mb must be an integer from 32 to 1048576/.test(err.message));
		assert.equal(fs.existsSync(path.join(dir, "data-2")), false);
	} finally {
		removeTempDir(dir);
	}
});

test("audit log: entries older than the retention go at start and then daily, like the pages they are about", async () => {
	const dataDir = makeTempDir("server-audit");
	const clock = new FakeClock(T0);
	try {
		// What earlier runs of the daemon wrote.
		const entry = (/** @type {number} */ ageDays) => JSON.stringify({ ts: new Date(T0 - ageDays * DAY).toISOString(), job: `j_${ageDays}`, kind: "fetch", url: `https://example.com/aged-${ageDays}`, host: "example.com", outcome: "ok", code: null, cookie_scope: "container", duration_ms: 5, redirect_origins: [] });
		fs.writeFileSync(path.join(dataDir, "audit.jsonl"), [400, 31, 30, 10].map((age) => `${entry(age)}\n`).join(""), { mode: 0o600 });
		const daemon = await startTestDaemon({ clock, dataDir });
		try {
			assert.deepEqual(logged(daemon, "audit.purged").map((l) => [l.entries, l.retention_days]), [[2, 30]]);
			assert.deepEqual(daemon.auditEntries().map((e) => e.job), ["j_30", "j_10"]);
			assert.equal(fs.statSync(path.join(dataDir, "audit.jsonl")).mode & 0o777, 0o600);
			// What the daemon writes from here on lands in the file that took the place of the old one.
			await daemon.tool("/v1/pages/search", { query: "zebras" });
			assert.deepEqual(daemon.auditEntries().map((e) => e.kind), ["fetch", "fetch", "search"]);
			clock.advance(DAY);
			assert.deepEqual(daemon.auditEntries().map((e) => e.job), ["j_10", null]);
			clock.advance(19 * DAY);
			assert.equal(daemon.auditEntries().length, 2, "ten days old at the start, thirty now: kept");
			clock.advance(DAY);
			assert.deepEqual(daemon.auditEntries().map((e) => e.kind), ["search"]);
			assert.deepEqual(logged(daemon, "audit.purged").map((l) => l.entries), [2, 1, 1]);
			assert.equal((await daemon.agentStatus()).audit_ok, true);
		} finally {
			await daemon.stop();
		}
	} finally {
		removeTempDir(dataDir);
	}
});

test("audit log that cannot be written: work is refused while that lasts, and goes on without a restart when it ends", async (t) => {
	const daemon = await startTestDaemon();
	try {
		const auditFile = path.join(daemon.dataDir, "audit.jsonl");
		await daemon.tool("/v1/pages/search", { query: "one" });
		assert.equal(daemon.auditEntries().length, 1);

		// No room on the disk for the audit log (and only for it, as far as this test goes).
		let full = true;
		const realWrite = fs.writeSync;
		t.mock.method(fs, "writeSync", (/** @type {any[]} */ ...args) => {
			if (full && fs.fstatSync(args[0]).ino === fs.statSync(auditFile).ino) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
			return /** @type {any} */ (realWrite)(...args);
		});
		// The call under way when it happens is answered; its entry waits.
		assert.equal((await daemon.tool("/v1/pages/search", { query: "two" })).json.isError, false);
		assert.equal((await daemon.agentStatus()).audit_ok, false);
		for (const query of ["three", "four"]) {
			const refused = await daemon.tool("/v1/pages/search", { query });
			assert.equal(refused.json.isError, true);
			assert.match(refused.json.text, /^\[browser-gateway\] outcome=error code=audit_unavailable\naction: .* until it can be written again/);
		}
		assert.match((await daemon.tool("/v1/fetch", { url: "https://example.com/a" })).json.text, /code=audit_unavailable/);
		assert.equal(daemon.auditEntries().length, 1);
		assert.equal(logged(daemon, "audit.write_failed").length, 1);

		full = false;
		assert.equal((await daemon.tool("/v1/pages/search", { query: "five" })).json.isError, false);
		assert.equal((await daemon.agentStatus()).audit_ok, true);
		assert.deepEqual(daemon.auditEntries().map((e) => [e.kind, e.outcome]), [["search", "ok"], ["search", "ok"], ["search", "ok"]], "the call that was answered left its entry after all");
		assert.equal(logged(daemon, "audit.write_recovered").length, 1);
	} finally {
		await daemon.stop();
	}
});

test("config.json: retention, cache lifetime, pacing and notifier settings are applied (item 11)", async () => {
	const dir = makeTempDir("server-config");
	const configDir = path.join(dir, "config");
	const dataDir = path.join(dir, "data");
	fs.mkdirSync(configDir, { mode: 0o700 });
	fs.mkdirSync(dataDir, { mode: 0o700 });
	fs.writeFileSync(
		path.join(configDir, "config.json"),
		JSON.stringify({
			retention_days: 7,
			cache_ttl_s: 0,
			notify: { sound: false, hook_command: ["/usr/local/bin/bgw-hook", "--topic", "gateway"], challenge_delay_s: 45 },
			fetch: { load_timeout_s: 75 },
			pacing: { default_profile: "fast", fast_hosts: ["docs.example.com"], hourly_budget: { polite: 5, fast: 1 } },
			files: { max_mb: 3, allow_types: ["application/pdf", "text/plain"] },
		}),
		{ mode: 0o644 },
	);
	const [eightDays, sixDays] = seed(dataDir, [8, 6]);
	const clock = new FakeClock(T0);
	const sp = recordingSpawn();
	// No pacing override: gaps and budgets come from the defaults and the file.
	// Nor of the notification delay: the file's applies.
	const daemon = await startTestDaemon({ clock, configDir, dataDir, pacing: undefined, challengeDelayMs: undefined, spawn: sp.spawn });
	const ext = new FakeExtension({ port: daemon.port });
	try {
		// retention_days: 7
		assert.deepEqual(logged(daemon, "store.purged").map((l) => [l.rows, l.retention_days]), [[1, 7]]);
		assert.equal(await readable(daemon, eightDays), false);
		assert.equal(await readable(daemon, sixDays), true);
		// The file was readable by others: fixed, and said so.
		assert.equal(fs.statSync(path.join(configDir, "config.json")).mode & 0o777, 0o600);
		assert.deepEqual(logged(daemon, "config.file_mode_fixed").map((l) => [l.level, l.file]), [["warn", path.join(configDir, "config.json")]]);
		// The operator can see what applies.
		assert.deepEqual((await daemon.status()).settings, {
			retention_days: 7,
			cache_ttl_s: 0,
			notify: { sound: false, hook: true, challenge_delay_s: 45 },
			fetch: { load_timeout_s: 75 },
			pacing: { default_profile: "fast", fast_hosts: ["docs.example.com"], hourly_budget: { polite: 5, fast: 1 } },
			search: { default_engine: "duckduckgo", engines: ["duckduckgo", "brave", "bing", "google", "startpage"] },
			pages: { max_total_mb: 2048 },
			files: { enabled: true, max_mb: 3, max_total_mb: 2048, allow_types: ["application/pdf", "text/plain"] },
		});
		assert.ok(!JSON.stringify(await daemon.status()).includes("bgw-hook"), "the hook's command line stays in its file");

		assert.equal((await ext.pair(await daemon.pairCode())).ready, true);
		// default_profile: fast - a host that is on no list gets the fast dwell (200..600 ms, the middle here).
		const first = await daemon.tool("/v1/fetch", { url: "https://example.org/page" });
		assert.equal(first.json.outcome, "ok");
		assert.equal(ext.jobs[0].wait.dwell_ms, 400);
		// fetch.load_timeout_s: 75 - the page of a fetch gets that long to load, and a search's results page too.
		assert.equal(ext.jobs[0].wait.timeout_ms, 75000);
		// cache_ttl_s: 0 - the same URL again is not answered from the store ...
		const second = await daemon.tool("/v1/fetch", { url: "https://example.org/page" });
		assert.ok(!second.json.text.includes("cache=hit"));
		// ... and hourly_budget.fast: 1 - so it is refused: the site had its one load this hour.
		assert.deepEqual([second.json.isError, second.json.outcome], [true, "error"]);
		assert.ok(second.json.text.includes("\ncode: site_budget\n") && second.json.text.includes(" retry_after_s=3600\n"));
		assert.equal(ext.jobs.length, 1);

		// The notifier exists with these settings, and nothing has been posted: no helper, no sound, no hook.
		assert.deepEqual(sp.calls, []);
	} finally {
		await ext.kill();
		await daemon.stop();
		removeTempDir(dir);
	}
	assert.deepEqual(sp.calls, [], "shutdown closes what the notifier started - nothing");
	assert.equal(clock.pending, 0);
});

test("config.json that cannot be used stops the start before anything is created or bound", async () => {
	const dir = makeTempDir("server-badconfig");
	try {
		/** @type {[string, RegExp][]} */
		const cases = [
			['{"retention_days": 0}', /retention_days must be an integer from 1 to 3650/],
			['{"retention": 30}', /unknown key "retention"/],
			['{"notify": {"hook_command": "rm -rf /"}}', /notify\.hook_command must be an array/],
			['{"fetch": {"load_timeout_s": 600}}', /fetch\.load_timeout_s must be an integer from 5 to 120/],
			['{"notify": {"challenge_delay_s": 3600}}', /notify\.challenge_delay_s must be an integer from 0 to 300/],
			["{broken", /not valid JSON/],
		];
		for (const [i, [text, message]] of cases.entries()) {
			const configDir = path.join(dir, `config-${i}`);
			const dataDir = path.join(dir, `data-${i}`);
			fs.mkdirSync(configDir, { mode: 0o700 });
			fs.writeFileSync(path.join(configDir, "config.json"), text, { mode: 0o600 });
			await assert.rejects(
				start({ port: 0, configDir, dataDir, log: quietLog() }),
				(err) => err instanceof ConfigError && message.test(err.message),
				text,
			);
			assert.deepEqual(fs.readdirSync(configDir), ["config.json"], "no token was created");
			assert.equal(fs.existsSync(dataDir), false, "no data directory either");
		}
	} finally {
		removeTempDir(dir);
	}
});

test("start: the config directory is checked before config.json in it is read", async (t) => {
	const dir = makeTempDir("server-dircheck");
	try {
		// Open to everyone, and holding a config.json that cannot be used: the directory is closed first.
		const loose = path.join(dir, "loose");
		fs.mkdirSync(loose);
		fs.chmodSync(loose, 0o777);
		fs.writeFileSync(path.join(loose, "config.json"), "{broken", { mode: 0o600 });
		/** @type {string[]} */
		const events = [];
		const log = { info: () => {}, warn: (/** @type {string} */ e) => void events.push(e), error: () => {} };
		await assert.rejects(start({ port: 0, configDir: loose, dataDir: path.join(dir, "data-loose"), log }), ConfigError);
		assert.equal(fs.statSync(loose).mode & 0o777, 0o700);
		assert.deepEqual(events, ["config.dir_mode_fixed"]);
		assert.deepEqual(fs.readdirSync(loose), ["config.json"], "and still nothing was created");

		// Somebody else's directory: nothing in it is read, however well it is made. Its config.json would start a program.
		const foreign = path.join(dir, "foreign");
		fs.mkdirSync(foreign, { mode: 0o700 });
		fs.writeFileSync(path.join(foreign, "config.json"), JSON.stringify({ notify: { hook_command: ["/bin/true"] } }), { mode: 0o600 });
		const uid = typeof process.getuid === "function" ? process.getuid() : 0;
		t.mock.method(/** @type {{ getuid: () => number }} */ (process), "getuid", () => uid + 1);
		const read = t.mock.method(fs, "readFileSync");
		await assert.rejects(
			start({ port: 0, configDir: foreign, dataDir: path.join(dir, "data-foreign"), log: quietLog() }),
			(err) => err instanceof Error && !(err instanceof ConfigError) && err.message === `${foreign} is not owned by the current user`,
		);
		assert.equal(read.mock.callCount(), 0, "config.json was not opened");
		assert.equal(fs.existsSync(path.join(dir, "data-foreign")), false);
	} finally {
		removeTempDir(dir);
	}
});

test("a store that cannot be asked shows as zeros in the status, and the reason is in the log", async () => {
	const daemon = await startTestDaemon();
	try {
		assert.equal((await daemon.agentStatus()).store.pages, 0);
		assert.equal(logged(daemon, "store.stats_failed").length, 0);
		// The index is overwritten under the running daemon: no longer a database.
		fs.writeFileSync(path.join(daemon.dataDir, "index.db"), Buffer.alloc(65536, 0x5a));
		assert.deepEqual((await daemon.agentStatus()).store, { pages: 0, stored: 0, files: 0, file_bytes: 0, file_bytes_max: 2147483648 });
		const lines = logged(daemon, "store.stats_failed");
		assert.equal(lines.length, 1);
		assert.equal(lines[0].level, "warn");
		assert.equal(typeof lines[0].message, "string");
		// Asked every second by a status display: a few lines a minute, the rest counted.
		for (let i = 0; i < 20; i++) await daemon.agentStatus();
		assert.equal(logged(daemon, "store.stats_failed").length, 5);
	} finally {
		await daemon.stop();
	}
});

test("the listening socket: a cap on open connections, and an error after the start is a log line, not an exception", async (t) => {
	/** @type {import("node:http").Server[]} */
	const servers = [];
	const create = http.createServer;
	t.mock.method(http, "createServer", (/** @type {any[]} */ ...args) => {
		const server = /** @type {any} */ (create)(...args);
		servers.push(server);
		return server;
	});
	const daemon = await startTestDaemon();
	try {
		assert.equal(servers.length, 1);
		const server = servers[0];
		assert.equal(LIMITS.maxConnections, 256);
		assert.equal(server.maxConnections, 256);
		// What accept() says when the process has no descriptor left. With no listener this would throw right here.
		server.emit("error", Object.assign(new Error("accept EMFILE"), { code: "EMFILE" }));
		server.emit("error", new Error("something else"));
		assert.deepEqual(logged(daemon, "server.error").map((l) => [l.level, l.code, l.message]), [["error", "EMFILE", "accept EMFILE"], ["error", null, "something else"]]);
		assert.equal((await daemon.request("GET", "/healthz", { auth: false })).status, 200, "and it serves on");
		// A connection that was turned away at the cap is said, a few times a minute.
		for (let i = 0; i < 12; i++) server.emit("drop", {});
		assert.deepEqual(logged(daemon, "server.connection_dropped").map((l) => [l.level, l.max]), Array(5).fill(["warn", 256]));
	} finally {
		await daemon.stop();
	}
});

test("an error nothing caught: one line that names its kind and place and never its message, then the process ends with a code", () => {
	for (const [event, kind] of /** @type {const} */ ([["uncaughtException", "uncaught_exception"], ["unhandledRejection", "unhandled_rejection"]])) {
		const proc = new EventEmitter();
		/** @type {{ level: string, event: string, fields: Record<string, unknown> }[]} */
		const lines = [];
		/** @param {string} level */
		const at = (level) => (/** @type {string} */ e, /** @type {Record<string, unknown>} */ fields = {}) => void lines.push({ level, event: e, fields });
		/** @type {number[]} */
		const exits = [];
		exitOnFault(proc, { info: at("info"), warn: at("warn"), error: at("error") }, (code) => void exits.push(code));
		const err = Object.assign(new TypeError('Unexpected token in "<html>PAGETEXT</html>" from https://private.example/inbox?token=SECRET'), { code: "ERR_INVALID_ARG_TYPE" });
		proc.emit(event, err);
		assert.deepEqual(exits, [1], event);
		assert.equal(lines.length, 1);
		assert.deepEqual([lines[0].level, lines[0].event, lines[0].fields.kind, lines[0].fields.name, lines[0].fields.code], ["error", "daemon.fatal", kind, "TypeError", "ERR_INVALID_ARG_TYPE"]);
		for (const needle of ["PAGETEXT", "SECRET", "private.example", "Unexpected"]) assert.ok(!JSON.stringify(lines).includes(needle), needle);
		// A second one while the process is on its way out adds nothing.
		proc.emit(event, new Error("again"));
		assert.deepEqual(exits, [1]);
		assert.equal(lines.length, 1);
	}

	// Where it was thrown: the first line of the stack that lies in the daemon's sources, as file and line.
	const thrown = new RangeError("PAGETEXT");
	thrown.stack = "RangeError: PAGETEXT\n    at Object.parse (node:internal/x:1:2)\n    at JobQueue.pump (file:///opt/gateway/daemon/src/queue.js:1172:9)\n    at file:///opt/gateway/daemon/src/server.js:300:5";
	assert.deepEqual(describeFault(thrown), { name: "RangeError", code: null, at: "queue.js:1172" });
	// Anything can be thrown, and a code or a name can be anything.
	assert.deepEqual(describeFault("a string with PAGETEXT"), { name: "string", code: null, at: null });
	assert.deepEqual(describeFault(null), { name: "object", code: null, at: null });
	assert.deepEqual(describeFault({ name: "Evil\nname", code: "lower case PAGETEXT", stack: 5 }), { name: "Error", code: null, at: null });
	assert.deepEqual(describeFault(Object.assign(new Error("x"), { code: "ENOSPC", stack: "" })), { name: "Error", code: "ENOSPC", at: null });
});

test("start: a port that is taken is an error with its own code, and the directories are released", async () => {
	const first = await startTestDaemon();
	const dir = makeTempDir("server-inuse");
	const configDir = path.join(dir, "config");
	const dataDir = path.join(dir, "data");
	try {
		await assert.rejects(start({ port: first.port, configDir, dataDir, log: quietLog() }), (err) => /** @type {NodeJS.ErrnoException} */ (err).code === "EADDRINUSE");
		// The one that holds the port is not disturbed.
		assert.equal((await first.request("GET", "/healthz", { auth: false })).status, 200);
		// Store and audit log of the failed start were closed: the same directories work on another port.
		const second = await start({ port: 0, configDir, dataDir, log: quietLog() });
		assert.notEqual(second.port, first.port);
		await second.close();
		await second.close();
	} finally {
		await first.stop();
		removeTempDir(dir);
	}
});

test("start: a descriptor to listen on needs the port it is expected to be bound to", async () => {
	const dir = makeTempDir("server-fd");
	try {
		const base = { configDir: path.join(dir, "config"), dataDir: path.join(dir, "data"), log: quietLog() };
		await assert.rejects(start({ ...base, port: 0, listenFd: 3 }), /listenFd/);
		await assert.rejects(start({ ...base, port: 18791, listenFd: 2 }), /listenFd/);
		await assert.rejects(start({ ...base, port: 18791, listenFd: 3.5 }), /listenFd/);
		assert.equal(fs.existsSync(base.configDir), false);
	} finally {
		removeTempDir(dir);
	}
});

test("shutdown with work in flight: callers are answered, nothing is left open", async () => {
	const clock = new FakeClock(T0);
	const daemon = await startTestDaemon({ clock });
	const ext = new FakeExtension({ port: daemon.port });
	try {
		assert.equal((await ext.pair(await daemon.pairCode())).ready, true);
		ext.onJob = (startFrame) => (startFrame.url.endsWith("/held") ? null : makeResult(startFrame));
		assert.equal((await daemon.tool("/v1/fetch", { url: "https://example.com/stored" })).json.outcome, "ok");
		const pending = daemon.tool("/v1/fetch", { url: "https://example.com/held" }).catch(() => null);
		await ext.waitFor("job.start", { match: (f) => f.url.endsWith("/held") });
		await daemon.close();
		const answer = await pending;
		if (answer !== null) assert.equal(answer.json.outcome, "aborted");
		await assert.rejects(daemon.request("GET", "/healthz", { auth: false }));
		assert.equal(clock.pending, 0, "no timer survives shutdown");
		// What was stored is on disk, and the index can be opened by the next start.
		const store = new PageStore({ dataDir: daemon.dataDir, clock, log: quietLog() });
		assert.deepEqual(store.stats(), { pages: 1, stored: 1, files: 0, file_bytes: 0, file_bytes_max: 2147483648 });
		store.close();
	} finally {
		await ext.kill();
		await daemon.stop();
	}
});
