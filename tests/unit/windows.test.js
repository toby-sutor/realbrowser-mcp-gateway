// What the daemon does differently on Windows, tested on any platform: the
// platform is handed in. Where it lives (%LOCALAPPDATA%), how private files and
// directories are checked without mode bits or O_NOFOLLOW, the retried rename,
// and a notifier that starts nothing but the operator's hook.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkPrivateDir, ensurePrivateDir, loadConfig, openNoFollow, openPrivateFile, outsideUserProfile, removeLeftover, removeWithRetry, renameWithRetry, windowsAbsolute } from "../../daemon/src/config.js";
import { createChallengeNotifier } from "../../daemon/src/challenges.js";
import { createNotifier, desktopNotifications } from "../../daemon/src/notify.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { makeSpawn } from "../helpers/fake-spawn.js";
import { startTestDaemon } from "../helpers/daemon.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

const POSIX_ONLY = process.platform === "win32" ? "needs symlinks or mode bits of a POSIX system" : false;
const LOCAL = "C:\\Users\\op\\AppData\\Local";

/** @type {string[]} */
const dirs = [];
after(() => {
	for (const d of dirs) removeTempDir(d);
});

function tmp() {
	const dir = makeTempDir("win");
	dirs.push(dir);
	return dir;
}

/** @param {() => unknown} fn @returns {string | undefined} */
function codeOf(fn) {
	try {
		fn();
	} catch (err) {
		return /** @type {NodeJS.ErrnoException} */ (err).code;
	}
	return undefined;
}

test("config on win32: both directories under %LOCALAPPDATA%\\browser-gateway", () => {
	assert.deepEqual(loadConfig({ LOCALAPPDATA: LOCAL }, "win32"), {
		port: 8791,
		configDir: `${LOCAL}\\browser-gateway\\config`,
		dataDir: `${LOCAL}\\browser-gateway\\data`,
	});
	assert.equal(loadConfig({ LOCALAPPDATA: "D:/Local/" }, "win32").configDir, "D:\\Local\\browser-gateway\\config");
	assert.equal(loadConfig({ LOCALAPPDATA: "\\\\server\\share\\local" }, "win32").dataDir, "\\\\server\\share\\local\\browser-gateway\\data");
	// The home directory is not asked, and neither are XDG variables.
	assert.equal(loadConfig({ LOCALAPPDATA: LOCAL, HOME: "/home/op", XDG_CONFIG_HOME: "/x" }, "win32").configDir, `${LOCAL}\\browser-gateway\\config`);
});

test("config on win32: no usable LOCALAPPDATA stops the start, unless the overrides name both directories", () => {
	for (const bad of [undefined, "", "AppData\\Local", "C:Local", ".", "\\Users\\op\\Local", "\\\\server"]) {
		assert.throws(() => loadConfig({ LOCALAPPDATA: bad }, "win32"), /LOCALAPPDATA is not set to an absolute path: set it, or BGW_CONFIG_DIR/, String(bad));
	}
	// One override is not enough: the other directory still needs it.
	assert.throws(() => loadConfig({ BGW_CONFIG_DIR: "E:\\bgw\\config" }, "win32"), /LOCALAPPDATA .*BGW_DATA_DIR/);
	assert.throws(() => loadConfig({ BGW_DATA_DIR: "E:\\bgw\\data" }, "win32"), /LOCALAPPDATA .*BGW_CONFIG_DIR/);
	assert.deepEqual(loadConfig({ BGW_CONFIG_DIR: "E:\\bgw\\config\\", BGW_DATA_DIR: "E:\\bgw\\x\\..\\data" }, "win32"), {
		port: 8791,
		configDir: "E:\\bgw\\config\\",
		dataDir: "E:\\bgw\\data",
	});
	// The overrides are checked as before, with the rules of the platform.
	assert.throws(() => loadConfig({ LOCALAPPDATA: LOCAL, BGW_CONFIG_DIR: "bgw\\config" }, "win32"), /BGW_CONFIG_DIR must be an absolute path/);
	assert.throws(() => loadConfig({ LOCALAPPDATA: LOCAL, BGW_DATA_DIR: "D:data" }, "win32"), /BGW_DATA_DIR must be an absolute path/);
	assert.throws(() => loadConfig({ LOCALAPPDATA: LOCAL, BGW_PORT: "x" }, "win32"), /invalid BGW_PORT/);
});

test("config on win32: an override is a drive or a share too, as LOCALAPPDATA and as cli/bgw take it", () => {
	for (const bad of ["\\bgw\\config", "/bgw/config", "C:bgw", "bgw", "\\\\\\x", "\\\\server"]) {
		assert.throws(() => loadConfig({ LOCALAPPDATA: LOCAL, BGW_CONFIG_DIR: bad }, "win32"), /BGW_CONFIG_DIR must be an absolute path/, bad);
		assert.throws(() => loadConfig({ LOCALAPPDATA: LOCAL, BGW_DATA_DIR: bad }, "win32"), /BGW_DATA_DIR must be an absolute path/, bad);
	}
	assert.equal(loadConfig({ LOCALAPPDATA: LOCAL, BGW_CONFIG_DIR: "\\\\server\\share\\gw" }, "win32").configDir, "\\\\server\\share\\gw");
	assert.equal(loadConfig({ BGW_CONFIG_DIR: "d:/gw/config", BGW_DATA_DIR: "E:\\gw\\data" }, "win32").configDir, "d:\\gw\\config");
	// The cases of cli/bgw's test (cli-windows.test.js): the same answers.
	const cases = ["C:\\x", "c:/x", "\\\\server\\share", "//server/share", "\\\\server", "//server/", "\\\\?\\C:\\x", "\\x", "/x", "C:", "C:x", "x", "", "\\\\\\x", "1:\\x", "\u00e9:\\x"];
	assert.deepEqual(
		cases.filter((c) => windowsAbsolute(c)),
		["C:\\x", "c:/x", "\\\\server\\share", "//server/share", "\\\\?\\C:\\x"],
	);
	assert.equal(windowsAbsolute(undefined), false);
});

test("config elsewhere: an override is checked as before", { skip: process.platform === "win32" ? "POSIX paths" : false }, () => {
	assert.equal(loadConfig({ BGW_CONFIG_DIR: "/x/config", BGW_DATA_DIR: "/x/data" }, "linux").configDir, "/x/config");
	assert.throws(() => loadConfig({ BGW_CONFIG_DIR: "x/config" }, "linux"), /BGW_CONFIG_DIR must be an absolute path/);
});

test("outside the user profile on win32: below %USERPROFILE% is inside, whatever the case, the slashes and a trailing separator; next to it is not", () => {
	const env = { USERPROFILE: "C:\\Users\\Op\\" };
	const inside = ["C:\\Users\\Op", "c:\\users\\op\\AppData\\Local\\browser-gateway\\config", "C:/Users/OP/x", "C:\\Users\\Op\\a\\..\\b"];
	const outside = ["C:\\Users\\Opal\\x", "C:\\Users", "D:\\Users\\Op\\x", "C:\\Users\\Op\\..\\other", "\\\\server\\share\\x"];
	for (const dir of inside) assert.equal(outsideUserProfile(dir, env, "win32"), false, dir);
	for (const dir of outside) assert.equal(outsideUserProfile(dir, env, "win32"), true, dir);
	assert.equal(outsideUserProfile("\\\\srv\\home\\op\\x", { USERPROFILE: "\\\\SRV\\home\\op" }, "win32"), false);
	assert.equal(outsideUserProfile("C:\\x", { USERPROFILE: "C:\\" }, "win32"), false);
	// No usable profile: nothing is known to be inside.
	for (const profile of [undefined, "", "Users\\op", "\\Users\\op"]) assert.equal(outsideUserProfile("C:\\Users\\op\\x", { USERPROFILE: profile }, "win32"), true, String(profile));
	// Never said elsewhere.
	assert.equal(outsideUserProfile("/srv/x", {}, "linux"), false);
});

test("daemon start on win32: one warning for each directory outside the user profile, none inside it and none elsewhere", async () => {
	/** @param {Partial<import("../../daemon/src/server.js").StartOptions>} opts */
	const warned = async (opts) => {
		const d = await startTestDaemon(opts);
		try {
			return d.logs.map((l) => JSON.parse(l)).filter((l) => l.event === "config.dir_outside_profile").map((l) => [l.level, l.note === `${l.dir} is outside the user profile: its permissions are not checked on Windows`, l.dir]);
		} finally {
			await d.stop();
		}
	};
	const win = await warned({ platform: "win32", env: { USERPROFILE: "Q:\\nobody" } });
	assert.deepEqual(win.map((w) => w.slice(0, 2)), [["warn", true], ["warn", true]]);
	assert.notEqual(win[0][2], win[1][2]);
	assert.deepEqual(await warned({ platform: "linux", env: { USERPROFILE: "Q:\\nobody" } }), []);
	if (process.platform === "win32") {
		const d = tmp();
		assert.deepEqual(await warned({ platform: "win32", env: { USERPROFILE: d }, configDir: path.join(d, "config"), dataDir: path.join(d, "data") }), []);
	}
});

test("config elsewhere: LOCALAPPDATA means nothing", { skip: process.platform === "win32" ? "POSIX paths" : false }, () => {
	const c = loadConfig({ LOCALAPPDATA: LOCAL }, "linux");
	assert.ok(!c.configDir.includes("AppData") && !c.dataDir.includes("AppData"));
	assert.deepEqual(loadConfig({ LOCALAPPDATA: "relative" }, "linux"), loadConfig({}, "linux"));
});

test("private directories on win32: a real directory, never tightened, nothing changed", () => {
	const dir = tmp();
	const sub = path.join(dir, "loose");
	assert.deepEqual(checkPrivateDir(sub, "win32"), { exists: false, tightened: false });
	fs.mkdirSync(sub, { mode: 0o755 });
	fs.chmodSync(sub, 0o755);
	assert.deepEqual(checkPrivateDir(sub, "win32"), { exists: true, tightened: false });
	if (process.platform !== "win32") assert.equal(fs.statSync(sub).mode & 0o777, 0o755, "no mode bits are touched");
	assert.deepEqual(ensurePrivateDir(path.join(dir, "a", "b"), "win32"), { tightened: false });
	assert.ok(fs.statSync(path.join(dir, "a", "b")).isDirectory());
	fs.writeFileSync(path.join(dir, "file"), "x");
	assert.throws(() => checkPrivateDir(path.join(dir, "file"), "win32"), /is not a directory/);
	assert.throws(() => ensurePrivateDir(path.join(dir, "file"), "win32"));
});

test("private directories on win32: a link to a directory is refused", { skip: POSIX_ONLY }, () => {
	const dir = tmp();
	fs.mkdirSync(path.join(dir, "real"));
	fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
	assert.throws(() => checkPrivateDir(path.join(dir, "link"), "win32"), /is not a directory/);
	assert.throws(() => ensurePrivateDir(path.join(dir, "link"), "win32"), /is not a directory/);
});

test("openNoFollow on win32: plain files are opened, read and created; other names are ELOOP", () => {
	const dir = tmp();
	const file = path.join(dir, "plain");
	fs.writeFileSync(file, "hello");
	const fd = openNoFollow(file, fs.constants.O_RDONLY, 0o600, "win32");
	try {
		assert.equal(fs.readFileSync(fd, "utf8"), "hello");
	} finally {
		fs.closeSync(fd);
	}
	const made = path.join(dir, "made");
	const wfd = openNoFollow(made, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600, "win32");
	fs.writeSync(wfd, "new");
	fs.closeSync(wfd);
	assert.equal(fs.readFileSync(made, "utf8"), "new");
	assert.equal(codeOf(() => openNoFollow(made, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600, "win32")), "EEXIST");
	assert.equal(codeOf(() => openNoFollow(path.join(dir, "missing"), fs.constants.O_RDONLY, 0o600, "win32")), "ENOENT");
	assert.equal(codeOf(() => openNoFollow(dir, fs.constants.O_RDONLY, 0o600, "win32")), "ELOOP", "a directory is no plain file");
});

test("openNoFollow on win32: a link is refused before it is opened, its target left alone", { skip: POSIX_ONLY }, () => {
	const dir = tmp();
	const target = path.join(dir, "target");
	fs.writeFileSync(target, "secret");
	fs.symlinkSync(target, path.join(dir, "link"));
	assert.equal(codeOf(() => openNoFollow(path.join(dir, "link"), fs.constants.O_RDONLY, 0o600, "win32")), "ELOOP");
	assert.equal(codeOf(() => openNoFollow(path.join(dir, "link"), fs.constants.O_WRONLY | fs.constants.O_APPEND, 0o600, "win32")), "ELOOP");
	// A dangling link is not followed to create its target either.
	fs.symlinkSync(path.join(dir, "nowhere"), path.join(dir, "dangling"));
	assert.equal(codeOf(() => openNoFollow(path.join(dir, "dangling"), fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o600, "win32")), "ELOOP");
	assert.equal(fs.existsSync(path.join(dir, "nowhere")), false);
	assert.equal(fs.readFileSync(target, "utf8"), "secret");
	// And where there is O_NOFOLLOW, the open itself says so.
	assert.equal(codeOf(() => openNoFollow(path.join(dir, "link"), fs.constants.O_RDONLY)), "ELOOP");
});

test("private files on win32: never tightened, links and directories are no regular files", () => {
	const dir = tmp();
	const file = path.join(dir, "config.json");
	fs.writeFileSync(file, "{}", { mode: 0o644 });
	fs.chmodSync(file, 0o644);
	const opened = openPrivateFile(file, { platform: "win32" });
	assert.ok(opened);
	fs.closeSync(opened.fd);
	assert.deepEqual({ size: opened.size, tightened: opened.tightened }, { size: 2, tightened: false });
	if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o644);
	assert.equal(openPrivateFile(path.join(dir, "missing"), { platform: "win32" }), null);
	const log = openPrivateFile(path.join(dir, "audit.jsonl"), { append: true, platform: "win32" });
	assert.ok(log);
	fs.writeSync(log.fd, "line\n");
	fs.closeSync(log.fd);
	assert.equal(fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8"), "line\n");
	assert.throws(() => openPrivateFile(dir, { platform: "win32" }), /is not a regular file/);
	assert.throws(() => openPrivateFile(dir, { append: true, platform: "win32" }), /is not a regular file/);
	if (process.platform !== "win32") {
		fs.symlinkSync(file, path.join(dir, "link.json"));
		assert.throws(() => openPrivateFile(path.join(dir, "link.json"), { platform: "win32" }), /is not a regular file/);
	}
});

test("renameWithRetry on win32: a file held for a moment is tried again, with growing waits", () => {
	/** @param {string} code */
	const busy = (code) => Object.assign(new Error(code), { code });
	/** @type {number[]} */
	const slept = [];
	const sleep = (/** @type {number} */ ms) => void slept.push(ms);
	let calls = 0;
	renameWithRetry("a", "b", {
		platform: "win32",
		sleep,
		rename: () => {
			calls++;
			if (calls === 1) throw busy("EBUSY");
			if (calls === 2) throw busy("EACCES");
		},
	});
	assert.equal(calls, 3);
	assert.deepEqual(slept, [25, 50]);

	// Held for good: six tries, then the last error.
	slept.length = 0;
	calls = 0;
	assert.throws(
		() =>
			renameWithRetry("a", "b", {
				platform: "win32",
				sleep,
				rename: () => {
					calls++;
					throw busy("EPERM");
				},
			}),
		{ code: "EPERM" },
	);
	assert.equal(calls, 6);
	assert.deepEqual(slept, [25, 50, 100, 200, 400]);

	// Anything else is no file that is held: not tried again.
	for (const code of ["ENOENT", "EXDEV", "ENOTEMPTY", undefined]) {
		calls = 0;
		slept.length = 0;
		assert.throws(() =>
			renameWithRetry("a", "b", {
				platform: "win32",
				sleep,
				rename: () => {
					calls++;
					throw code === undefined ? new Error("plain") : busy(code);
				},
			}),
		);
		assert.deepEqual([calls, slept.length], [1, 0], String(code));
	}
});

test("renameWithRetry elsewhere: one plain rename, never tried again", () => {
	let calls = 0;
	/** @type {number[]} */
	const slept = [];
	assert.throws(
		() =>
			renameWithRetry("a", "b", {
				platform: "linux",
				sleep: (ms) => void slept.push(ms),
				rename: () => {
					calls++;
					throw Object.assign(new Error("busy"), { code: "EBUSY" });
				},
			}),
		{ code: "EBUSY" },
	);
	assert.deepEqual([calls, slept.length], [1, 0]);
	// The real one, on both paths.
	const dir = tmp();
	fs.writeFileSync(path.join(dir, "a"), "1");
	renameWithRetry(path.join(dir, "a"), path.join(dir, "b"));
	renameWithRetry(path.join(dir, "b"), path.join(dir, "c"), { platform: "win32" });
	assert.equal(fs.readFileSync(path.join(dir, "c"), "utf8"), "1");
	// The real sleep waits, and briefly.
	const started = Date.now();
	assert.throws(() => renameWithRetry(path.join(dir, "gone"), path.join(dir, "d"), { platform: "win32", rename: () => {
		if (Date.now() - started < 20) throw Object.assign(new Error("busy"), { code: "EBUSY" });
		throw Object.assign(new Error("gone"), { code: "ENOENT" });
	} }), { code: "ENOENT" });
	assert.ok(Date.now() - started >= 20);
});

test("removal on win32: a tree with Node's own retries, a file tried again while held; a leftover that will not go does not hide the error of the step", () => {
	/** @type {any[]} */
	const seen = [];
	/** @type {number[]} */
	const slept = [];
	const sleep = (/** @type {number} */ ms) => void slept.push(ms);
	removeWithRetry("tree", { recursive: true, force: true }, { platform: "win32", sleep, rm: (t, o) => void seen.push([t, o]) });
	assert.deepEqual(seen.slice(), [["tree", { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }]]);
	let fails = 2;
	seen.length = 0;
	removeWithRetry("file", { force: true }, {
		platform: "win32",
		sleep,
		rm: (t, o) => {
			seen.push([t, o]);
			if (fails-- > 0) throw Object.assign(new Error("held"), { code: "EBUSY" });
		},
	});
	assert.deepEqual([seen.length, seen[0], slept], [3, ["file", { force: true }], [25, 50]]);
	const held = (/** @type {string} */ _t, /** @type {any} */ _o) => {
		throw Object.assign(new Error("held"), { code: "EPERM" });
	};
	assert.throws(() => removeWithRetry("file", { force: true }, { platform: "win32", sleep, rm: held }), { code: "EPERM" });
	assert.doesNotThrow(() => removeLeftover("tmp", { recursive: true, force: true }, { platform: "win32", sleep, rm: held }));
	// Elsewhere: one plain fs.rmSync with the options as given, and its error as before.
	seen.length = 0;
	removeWithRetry("tree", { recursive: true, force: true }, { platform: "linux", rm: (t, o) => void seen.push([t, o]) });
	removeLeftover("tmp", { force: true }, { platform: "linux", rm: (t, o) => void seen.push([t, o]) });
	assert.deepEqual(seen.slice(), [["tree", { recursive: true, force: true }], ["tmp", { force: true }]]);
	assert.throws(() => removeLeftover("tmp", { force: true }, { platform: "linux", rm: held }), { code: "EPERM" });
	// The real one.
	const dir = tmp();
	fs.mkdirSync(path.join(dir, "t", "u"), { recursive: true });
	fs.writeFileSync(path.join(dir, "t", "u", "f"), "x");
	removeLeftover(path.join(dir, "t"), { recursive: true, force: true }, { platform: "win32" });
	removeWithRetry(path.join(dir, "gone"), { force: true }, { platform: "win32" });
	assert.equal(fs.existsSync(path.join(dir, "t")), false);
});

function makeLog() {
	/** @type {Array<{ level: string, event: string, fields: Record<string, unknown> | undefined }>} */
	const lines = [];
	const at = (/** @type {string} */ level) => (/** @type {string} */ event, /** @type {import("../../daemon/src/log.js").LogFields | undefined} */ fields) => {
		lines.push({ level, event, fields });
	};
	return { lines, log: { info: at("info"), warn: at("warn"), error: at("error") } };
}

/** @param {Partial<Parameters<typeof createNotifier>[0]>} [over] */
function winNotifier(over = {}) {
	const sp = makeSpawn();
	const clock = new FakeClock();
	const { lines, log } = makeLog();
	const notifier = createNotifier({
		log,
		clock,
		spawn: sp.spawn,
		helperPath: "/h/notify_helper.py",
		fileExists: () => true,
		soundCandidates: ["/snd/a.oga"],
		hookCommand: ["C:\\hooks\\hook.exe", "--topic", "bgw"],
		platform: "win32",
		...over,
	});
	return { ...sp, clock, lines, notifier };
}

const POST = { key: "challenge:j_1", summary: "Browser Gateway: a page needs you", urgency: /** @type {const} */ ("critical"), host: "www.shop.example", jobId: "j_1" };

test("notifier on win32: no helper, no gdbus, no sound - the hook runs, the post ends as unsupported", async () => {
	assert.equal(desktopNotifications("win32"), false);
	assert.equal(desktopNotifications("linux"), true);
	const t = winNotifier();
	const h = t.notifier.post({ ...POST, sound: true, actions: [{ key: "open", label: "Open" }] });
	assert.deepEqual(await h.done, { why: "unsupported", id: null, clickable: false });
	assert.equal(h.finished, true);
	assert.deepEqual(
		t.calls.map((c) => [c.command, c.args, c.options.shell]),
		[["C:\\hooks\\hook.exe", ["--topic", "bgw", "www.shop.example", "j_1"], false]],
	);
	// Said once, not for every post.
	const second = t.notifier.post({ ...POST, key: "challenge:j_2", host: "other.example", jobId: "j_2" });
	assert.equal((await second.done).why, "unsupported");
	assert.equal(t.calls.length, 2);
	assert.deepEqual(
		t.lines.filter((l) => l.event === "notify.unsupported").map((l) => [l.level, l.fields]),
		[["info", { platform: "win32" }]],
	);
	// What is closed or forgotten was never anything on screen.
	await h.close();
	t.notifier.forget(POST.key);
	await t.notifier.closeAll();
	assert.equal(t.calls.length, 2);
});

test("notifier on win32: the limits still hold, and hook: false runs nothing", async () => {
	const t = winNotifier();
	assert.equal((await t.notifier.post(POST).done).why, "unsupported");
	// The same site a moment later: not made, no hook.
	assert.equal((await t.notifier.post({ ...POST, key: "challenge:j_3", host: "shop.example", jobId: "j_3" }).done).why, "cooldown");
	assert.equal((await t.notifier.post({ ...POST, key: "challenge:j_4", host: "bad host" }).done).why, "bad_host");
	assert.equal((await t.notifier.post({ ...POST, key: "challenge:j_5", host: "five.example", jobId: "j_5", hook: false }).done).why, "unsupported");
	assert.equal(t.calls.length, 1);
	// No hook configured: nothing is started at all.
	const quiet = winNotifier({ hookCommand: null });
	assert.equal((await quiet.notifier.post(POST).done).why, "unsupported");
	assert.equal(quiet.calls.length, 0);
});

test("challenges on win32: the hook hears of a challenge once, however often it is repeated", async () => {
	const t = winNotifier({ hookCommand: ["C:\\hooks\\hook.exe"] });
	const { log } = makeLog();
	const challenges = createChallengeNotifier({ notifier: t.notifier, clock: t.clock, log, attention: () => true, repeatMs: 120000 });
	challenges.pending({ job: "j_abc", host: "www.shop.example" });
	await new Promise((r) => setImmediate(r));
	t.clock.advance(120000);
	await new Promise((r) => setImmediate(r));
	t.clock.advance(120000);
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(
		t.calls.map((c) => c.args),
		[["www.shop.example", "j_abc"]],
	);
	challenges.ended({ job: "j_abc", host: "www.shop.example" });
	challenges.closeAll();
});

test("status on win32: an agent and the operator learn that notifications are unavailable; elsewhere nothing is said", async () => {
	const win = await startTestDaemon({ platform: "win32" });
	try {
		assert.equal((await win.agentStatus()).notifications, "unavailable");
		assert.equal((await win.status()).notifications, "unavailable");
	} finally {
		await win.stop();
	}
	const other = await startTestDaemon({ platform: "linux" });
	try {
		assert.equal("notifications" in (await other.agentStatus()), false);
	} finally {
		await other.stop();
	}
});
