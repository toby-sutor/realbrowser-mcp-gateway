import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Secrets, isProofNonce } from "../../daemon/src/secrets.js";
import { AuditLog, toOrigins } from "../../daemon/src/audit.js";
import {
	ConfigError,
	DEFAULT_PORT,
	LIMITS,
	defaultSettings,
	ensurePrivateDir,
	checkPrivateDir,
	ensurePrivateFile,
	inheritedListenFd,
	loadConfig,
	loadSettings,
	parseSettings,
	readPrivateFile,
	writePrivateFile,
} from "../../daemon/src/config.js";
import { b64urlDecode, parsePairingCode, randomBytes } from "../../extension/shared/auth.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { TMP_ROOT, makeTempDir, removeTempDir } from "../helpers/tmp.js";

// Windows has no mode bits: what they are is checked where there are.
const MODES = process.platform !== "win32";

/** @type {string[]} */
const dirs = [];
after(() => {
	for (const dir of dirs) removeTempDir(dir);
});

/** @param {string} file */
const mode = (file) => fs.statSync(file).mode & 0o777;

function setup() {
	const dir = makeTempDir("secrets");
	dirs.push(dir);
	const configDir = path.join(dir, "config");
	const clock = new FakeClock();
	/** @type {{ level: string, event: string, fields: Record<string, unknown> }[]} */
	const logs = [];
	/** @param {string} level */
	const at = (level) => (/** @type {string} */ event, /** @type {Record<string, unknown>} */ fields = {}) => {
		logs.push({ level, event, fields });
	};
	const log = { info: at("info"), warn: at("warn"), error: at("error") };
	const make = () => new Secrets({ configDir, clock, log });
	return {
		dir,
		configDir,
		clock,
		logs,
		log,
		make,
		tokenFile: path.join(configDir, "client.token"),
		adminFile: path.join(configDir, "admin.token"),
		keyFile: path.join(configDir, "ext.key"),
	};
}

test("test files live under the test temp root, never in the system temp dir", () => {
	const t = setup();
	assert.ok(t.dir.startsWith(TMP_ROOT + path.sep));
	assert.ok(!TMP_ROOT.startsWith(os.tmpdir() + path.sep) && TMP_ROOT !== os.tmpdir(), TMP_ROOT);
	assert.throws(() => removeTempDir(os.homedir()), /outside the test temp root/);
	assert.throws(() => removeTempDir(path.join(TMP_ROOT, "..", "elsewhere")), /outside the test temp root/);
});

test("config: defaults come from the home directory, not from XDG variables", { skip: process.platform === "win32" ? "POSIX paths" : false }, () => {
	const c = loadConfig({ XDG_CONFIG_HOME: "/somewhere/else/config", XDG_DATA_HOME: "/somewhere/else/data" });
	assert.equal(c.port, DEFAULT_PORT);
	assert.equal(c.port, 8791);
	assert.equal(c.configDir, path.join(os.homedir(), ".config", "browser-gateway"));
	assert.equal(c.dataDir, path.join(os.homedir(), ".local", "share", "browser-gateway"));
});

test("config: environment overrides and validation", { skip: process.platform === "win32" ? "POSIX paths" : false }, () => {
	const c = loadConfig({ BGW_PORT: "18080", BGW_CONFIG_DIR: "/srv/bgw/config/", BGW_DATA_DIR: "/srv/bgw/../bgw/data" });
	assert.deepEqual(c, { port: 18080, configDir: "/srv/bgw/config/", dataDir: "/srv/bgw/data" });
	assert.equal(loadConfig({ BGW_PORT: "0" }).port, 0);
	assert.equal(loadConfig({ BGW_PORT: "" }).port, 8791);
	for (const bad of ["abc", "-1", "65536", "80.5", "8791 ", "0x50", "123456"]) {
		assert.throws(() => loadConfig({ BGW_PORT: bad }), /invalid BGW_PORT/, bad);
	}
	assert.throws(() => loadConfig({ BGW_CONFIG_DIR: "relative/dir" }), /BGW_CONFIG_DIR must be an absolute path/);
	assert.throws(() => loadConfig({ BGW_DATA_DIR: "./data" }), /BGW_DATA_DIR must be an absolute path/);
});

test("config: loadConfig touches no files", () => {
	const t = setup();
	loadConfig({ BGW_CONFIG_DIR: t.configDir, BGW_DATA_DIR: path.join(t.dir, "data") });
	assert.equal(fs.existsSync(t.configDir), false);
	assert.equal(fs.existsSync(path.join(t.dir, "data")), false);
});

test("private directories: created 0700, looser ones are tightened", { skip: process.platform === "win32" ? "mode bits" : false }, () => {
	const t = setup();
	const fresh = path.join(t.dir, "a", "b", "c");
	assert.deepEqual(ensurePrivateDir(fresh), { tightened: false });
	assert.equal(mode(fresh), 0o700);

	for (const loose of [0o755, 0o750, 0o777, 0o701]) {
		const dir = path.join(t.dir, `loose-${loose.toString(8)}`);
		fs.mkdirSync(dir);
		fs.chmodSync(dir, loose);
		assert.deepEqual(ensurePrivateDir(dir), { tightened: true }, loose.toString(8));
		assert.equal(mode(dir), 0o700);
		assert.deepEqual(ensurePrivateDir(dir), { tightened: false });
	}

	const file = path.join(t.dir, "plain-file");
	fs.writeFileSync(file, "x");
	assert.throws(() => ensurePrivateDir(file));
	assert.throws(() => ensurePrivateDir("relative/dir"), /absolute/);
});

test("private files: written 0600 atomically, looser ones are tightened, symlinks refused", { skip: process.platform === "win32" ? "mode bits and symlinks" : false }, () => {
	const t = setup();
	fs.mkdirSync(t.configDir, { recursive: true });
	const file = path.join(t.configDir, "secret");

	const oldUmask = process.umask(0);
	try {
		writePrivateFile(file, "one\n");
	} finally {
		process.umask(oldUmask);
	}
	assert.equal(mode(file), 0o600, "0600 even with a umask of 0");
	assert.equal(readPrivateFile(file), "one\n");
	writePrivateFile(file, "two\n");
	assert.equal(readPrivateFile(file), "two\n");
	assert.deepEqual(fs.readdirSync(t.configDir), ["secret"], "no temp file is left behind");

	for (const loose of [0o644, 0o640, 0o666, 0o604]) {
		fs.chmodSync(file, loose);
		assert.deepEqual(ensurePrivateFile(file), { exists: true, tightened: true }, loose.toString(8));
		assert.equal(mode(file), 0o600);
	}
	fs.chmodSync(file, 0o644);
	assert.equal(readPrivateFile(file), "two\n");
	assert.equal(mode(file), 0o600, "reading tightens too");

	assert.deepEqual(ensurePrivateFile(path.join(t.configDir, "missing")), { exists: false, tightened: false });
	assert.equal(readPrivateFile(path.join(t.configDir, "missing")), null);

	const link = path.join(t.configDir, "link");
	fs.symlinkSync(file, link);
	assert.throws(() => ensurePrivateFile(link), /not a regular file/);
	assert.throws(() => readPrivateFile(link), /not a regular file/);
});

test("a directory is checked without being made: missing is said, a looser one is tightened, anything else is refused", { skip: process.platform === "win32" ? "mode bits" : false }, () => {
	const t = setup();
	const missing = path.join(t.dir, "not", "there");
	assert.deepEqual(checkPrivateDir(missing), { exists: false, tightened: false });
	assert.equal(fs.existsSync(path.join(t.dir, "not")), false, "nothing was created");
	const dir = path.join(t.dir, "loose");
	fs.mkdirSync(dir);
	fs.chmodSync(dir, 0o755);
	assert.deepEqual(checkPrivateDir(dir), { exists: true, tightened: true });
	assert.equal(mode(dir), 0o700);
	assert.deepEqual(checkPrivateDir(dir), { exists: true, tightened: false });
	const file = path.join(t.dir, "plain-file");
	fs.writeFileSync(file, "x");
	assert.throws(() => checkPrivateDir(file), /is not a directory/);
	assert.throws(() => checkPrivateDir("relative/dir"), /absolute/);
});

test("private files: checked, tightened and read through one descriptor, never by name a second time", { skip: process.platform === "win32" ? "mode bits" : false }, (t) => {
	const s = setup();
	fs.mkdirSync(s.configDir, { recursive: true, mode: 0o700 });
	const file = path.join(s.configDir, "config.json");
	fs.writeFileSync(file, '{"retention_days": 7}');
	fs.chmodSync(file, 0o644);
	const chmod = t.mock.method(fs, "chmodSync");
	const read = t.mock.method(fs, "readFileSync");
	/** @type {string[]} */
	const fixed = [];
	assert.equal(loadSettings(s.configDir, (f) => fixed.push(f)).retentionDays, 7);
	assert.deepEqual(fixed, [file]);
	assert.equal(mode(file), 0o600);
	assert.equal(chmod.mock.callCount(), 0, "the mode is set on the open file, not on whatever the name points at by then");
	assert.deepEqual(read.mock.calls.map((c) => typeof c.arguments[0]), ["number"], "and the open file is what is read");

	fs.chmodSync(file, 0o640);
	chmod.mock.resetCalls();
	read.mock.resetCalls();
	assert.equal(readPrivateFile(file), '{"retention_days": 7}');
	assert.deepEqual(ensurePrivateFile(file), { exists: true, tightened: false });
	assert.equal(mode(file), 0o600);
	assert.equal(chmod.mock.callCount(), 0);
	assert.deepEqual(read.mock.calls.map((c) => typeof c.arguments[0]), ["number"]);
});

test("private files: a write that cannot be put in place leaves no copy of the secret behind, and one that can is flushed with its directory", (t) => {
	const s = setup();
	fs.mkdirSync(s.configDir, { recursive: true, mode: 0o700 });
	// A directory with something in it stands where the file should go: the rename fails.
	const taken = path.join(s.configDir, "ext.key");
	fs.mkdirSync(taken);
	fs.writeFileSync(path.join(taken, "in-the-way"), "");
	assert.throws(() => writePrivateFile(taken, "SECRETKEY\n"));
	assert.deepEqual(fs.readdirSync(s.configDir), ["ext.key"], "the temporary file is gone");

	const file = path.join(s.configDir, "client.token");
	/** @type {boolean[]} */
	const flushedDirs = [];
	const real = fs.fsyncSync;
	t.mock.method(fs, "fsyncSync", (/** @type {number} */ fd) => {
		flushedDirs.push(fs.fstatSync(fd).isDirectory());
		return real(fd);
	});
	writePrivateFile(file, "one\n");
	assert.deepEqual(flushedDirs, [false, true], "the file, then the directory that now holds its name");
	assert.equal(fs.readFileSync(file, "utf8"), "one\n");
});

test("client.token: created on first start, 0600 in a 0700 directory, stable afterwards", () => {
	const t = setup();
	const s = t.make();
	s.init();
	if (MODES) assert.equal(mode(t.configDir), 0o700);
	if (MODES) assert.equal(mode(t.tokenFile), 0o600);
	const token = fs.readFileSync(t.tokenFile, "utf8");
	assert.match(token, /^[A-Za-z0-9_-]{43}\n$/);
	assert.equal(b64urlDecode(token.trim())?.length, 32);
	assert.equal(s.isPaired(), false);
	assert.equal(fs.existsSync(t.keyFile), false);

	const again = t.make();
	again.init();
	assert.equal(fs.readFileSync(t.tokenFile, "utf8"), token, "a restart keeps the token");
	assert.equal(again.tokenRole(token.trim()) === "client", true);

	const other = setup();
	other.make().init();
	assert.notEqual(fs.readFileSync(other.tokenFile, "utf8"), token);
});

test("client.token: verification", () => {
	const t = setup();
	const s = t.make();
	s.init();
	const token = fs.readFileSync(t.tokenFile, "utf8").trim();
	assert.equal(s.tokenRole(token) === "client", true);
	for (const bad of ["", token.slice(1), token + "A", token.slice(0, 42), token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase(), "A".repeat(43), token + "\n"]) {
		assert.equal(s.tokenRole(bad) === "client", false, `${bad.length} chars`);
	}
	// Before init nothing verifies, not even the empty string.
	const fresh = setup().make();
	assert.equal(fresh.tokenRole("") === "client", false);
});

test("admin.token: created on first start like client.token, and a different token", () => {
	const t = setup();
	const s = t.make();
	s.init();
	if (MODES) assert.equal(mode(t.adminFile), 0o600);
	const admin = fs.readFileSync(t.adminFile, "utf8");
	const client = fs.readFileSync(t.tokenFile, "utf8");
	assert.match(admin, /^[A-Za-z0-9_-]{43}\n$/);
	assert.equal(b64urlDecode(admin.trim())?.length, 32);
	assert.notEqual(admin, client);
	assert.ok(t.logs.some((l) => l.event === "secrets.admin_token_created"));

	const again = t.make();
	again.init();
	assert.equal(fs.readFileSync(t.adminFile, "utf8"), admin, "a restart keeps the admin token");
	assert.equal(fs.readFileSync(t.tokenFile, "utf8"), client);

	// An installation from before the admin token existed gets one on the next start.
	fs.rmSync(t.adminFile);
	const upgraded = t.make();
	upgraded.init();
	if (MODES) assert.equal(mode(t.adminFile), 0o600);
	assert.notEqual(fs.readFileSync(t.adminFile, "utf8"), admin);
	assert.equal(fs.readFileSync(t.tokenFile, "utf8"), client, "the agent token is left alone");
});

test("each token has exactly one role", () => {
	const t = setup();
	const s = t.make();
	assert.equal(s.tokenRole(""), null, "nothing verifies before init");
	s.init();
	const client = fs.readFileSync(t.tokenFile, "utf8").trim();
	const admin = fs.readFileSync(t.adminFile, "utf8").trim();

	assert.equal(s.tokenRole(client), "client");
	assert.equal(s.tokenRole(admin), "admin");
	assert.equal(s.tokenRole(client) === "client", true);
	assert.equal(s.tokenRole(admin) === "client", false, "the admin token is not an agent token");
	assert.equal(s.tokenRole(admin) === "admin", true);
	assert.equal(s.tokenRole(client) === "admin", false, "the agent token is not an admin token");
	for (const bad of ["", admin.slice(1), admin + "A", admin.slice(0, 42), "A".repeat(43), client + admin, admin + "\n"]) {
		assert.equal(s.tokenRole(bad), null, `${bad.length} chars`);
	}
});

test("the same token in both files is refused: it would give every agent the pairing right", () => {
	const t = setup();
	t.make().init();
	fs.copyFileSync(t.tokenFile, t.adminFile);
	assert.throws(() => t.make().init(), /hold the same token/);
	// Nothing was overwritten behind the operator's back.
	assert.equal(fs.readFileSync(t.adminFile, "utf8"), fs.readFileSync(t.tokenFile, "utf8"));
});

test("a damaged admin.token stops the start", () => {
	const t = setup();
	t.make().init();
	for (const bad of ["", "short\n", "A".repeat(42) + "=\n"]) {
		fs.writeFileSync(t.adminFile, bad, { mode: 0o600 });
		assert.throws(() => t.make().init(), /admin\.token is damaged/, JSON.stringify(bad));
		assert.equal(fs.readFileSync(t.adminFile, "utf8"), bad);
	}
});

test("existing loose modes are fixed on start, and logged", { skip: process.platform === "win32" ? "mode bits" : false }, () => {
	const t = setup();
	t.make().init();
	fs.chmodSync(t.configDir, 0o755);
	fs.chmodSync(t.tokenFile, 0o644);
	fs.chmodSync(t.adminFile, 0o640);
	t.logs.length = 0;
	t.make().init();
	assert.equal(mode(t.configDir), 0o700);
	assert.equal(mode(t.tokenFile), 0o600);
	assert.equal(mode(t.adminFile), 0o600);
	assert.ok(t.logs.some((l) => l.level === "warn" && l.event === "config.dir_mode_fixed"));
});

test("a token or key file with loose permissions is fixed and the warning names the file", { skip: process.platform === "win32" ? "mode bits" : false }, () => {
	const t = setup();
	const s = t.make();
	s.init();
	s.setExtKey(randomBytes(32));
	const fixed = () => t.logs.filter((l) => l.event === "secrets.file_mode_fixed").map((l) => [l.level, l.fields.file]);
	// Nothing to say while the modes are right.
	t.logs.length = 0;
	t.make().init();
	assert.deepEqual(fixed(), []);

	for (const [file, loose] of /** @type {[string, number][]} */ ([
		[t.tokenFile, 0o644],
		[t.adminFile, 0o640],
		[t.keyFile, 0o604],
		[t.tokenFile, 0o660],
		[t.keyFile, 0o400],
	])) {
		fs.chmodSync(file, loose);
		t.logs.length = 0;
		t.make().init();
		assert.equal(mode(file), 0o600, `${path.basename(file)} ${loose.toString(8)}`);
		assert.deepEqual(fixed(), [["warn", file]], `${path.basename(file)} ${loose.toString(8)}`);
	}
	// All three at once: three warnings, one per file.
	for (const file of [t.tokenFile, t.adminFile, t.keyFile]) fs.chmodSync(file, 0o666);
	t.logs.length = 0;
	const again = t.make();
	again.init();
	assert.deepEqual(fixed().map(([, file]) => file).sort(), [t.adminFile, t.tokenFile, t.keyFile].sort());
	assert.equal(again.isPaired(), true, "and the files are used as before");
	// The warning carries the path and nothing of the content.
	const text = JSON.stringify(t.logs);
	for (const file of [t.tokenFile, t.adminFile, t.keyFile]) assert.ok(!text.includes(fs.readFileSync(file, "utf8").trim()));
});

test("a damaged client.token stops the start instead of being replaced silently", () => {
	const t = setup();
	fs.mkdirSync(t.configDir, { recursive: true });
	for (const bad of ["", "short\n", "A".repeat(42) + "=\n", "two words\n"]) {
		fs.writeFileSync(t.tokenFile, bad, { mode: 0o600 });
		assert.throws(() => t.make().init(), /is damaged/, JSON.stringify(bad));
		assert.equal(fs.readFileSync(t.tokenFile, "utf8"), bad);
	}
});

test("ext.key: written at pairing 0600, survives a restart, replacement is logged", () => {
	const t = setup();
	const s = t.make();
	s.init();
	const key1 = randomBytes(32);
	s.setExtKey(key1);
	assert.equal(s.isPaired(), true);
	assert.deepEqual(s.extKey(), key1);
	if (MODES) assert.equal(mode(t.keyFile), 0o600);
	assert.match(fs.readFileSync(t.keyFile, "utf8"), /^[A-Za-z0-9_-]{43}\n$/);
	assert.ok(t.logs.some((l) => l.level === "info" && l.event === "pairing.ext_key_created"));
	assert.ok(!t.logs.some((l) => l.event === "pairing.ext_key_replaced"));

	const restarted = t.make();
	restarted.init();
	assert.equal(restarted.isPaired(), true);
	assert.deepEqual(restarted.extKey(), key1);

	const key2 = randomBytes(32);
	restarted.setExtKey(key2);
	assert.deepEqual(restarted.extKey(), key2);
	if (MODES) assert.equal(mode(t.keyFile), 0o600);
	const replaced = t.logs.filter((l) => l.event === "pairing.ext_key_replaced");
	assert.equal(replaced.length, 1);
	assert.equal(replaced[0].level, "warn");

	assert.throws(() => s.setExtKey(randomBytes(31)), /32 bytes/);
	assert.throws(() => s.setExtKey(/** @type {any} */ ("x".repeat(32))), /32 bytes/);
});

test("ext.key: an unreadable key file means not paired", () => {
	const t = setup();
	t.make().init();
	for (const bad of ["", "garbage\n", "A".repeat(42) + "\n"]) {
		fs.writeFileSync(t.keyFile, bad, { mode: 0o600 });
		t.logs.length = 0;
		const s = t.make();
		s.init();
		assert.equal(s.isPaired(), false, JSON.stringify(bad));
		assert.equal(s.extKey(), null);
		assert.ok(t.logs.some((l) => l.level === "warn" && l.event === "secrets.ext_key_unreadable"));
	}
});

test("pairing code: format, in memory only, ten minutes", () => {
	const t = setup();
	const s = t.make();
	s.init();
	assert.equal(s.activePairing(), null);

	const { code, expiresInS } = s.startPairing(8791);
	assert.equal(expiresInS, 600);
	const parsed = parsePairingCode(code);
	assert.ok(parsed.ok);
	assert.equal(parsed.port, 8791);
	const active = s.activePairing();
	assert.equal(active?.code, code);
	assert.equal(active?.expiresAt, t.clock.now() + 600000);

	// Nothing about the code reaches the disk.
	for (const name of fs.readdirSync(t.configDir)) {
		assert.ok(!fs.readFileSync(path.join(t.configDir, name), "utf8").includes(code.split(".")[2]), name);
	}
	assert.deepEqual(fs.readdirSync(t.configDir).sort(), ["admin.token", "client.token"]);

	t.clock.advance(LIMITS.pairingTtlMs - 1);
	assert.equal(s.activePairing(), active);
	t.clock.advance(1);
	assert.equal(s.activePairing(), null);
	assert.equal(active && s.consumePairing(active), false, "an expired code cannot be used");

	// A restart forgets the code.
	const before = s.startPairing(8791);
	const restarted = t.make();
	restarted.init();
	assert.equal(restarted.activePairing(), null);
	assert.ok(before.code);
});

test("pairing code: single use", () => {
	const t = setup();
	const s = t.make();
	s.init();
	s.startPairing(8791);
	const p = s.activePairing();
	assert.ok(p);
	assert.equal(s.consumePairing(p), true);
	assert.equal(s.activePairing(), null);
	assert.equal(s.consumePairing(p), false);
});

test("pairing code: a new code replaces the old one", () => {
	const t = setup();
	const s = t.make();
	s.init();
	const first = s.startPairing(8791);
	const old = s.activePairing();
	const second = s.startPairing(8791);
	assert.notEqual(first.code, second.code);
	assert.equal(s.activePairing()?.code, second.code);
	assert.ok(old);
	assert.equal(s.consumePairing(old), false);
	assert.equal(s.activePairing()?.code, second.code, "a refused use of the old code leaves the new one alone");
});

test("pairing code: nothing counts wrong guesses; it ends by use or by time", () => {
	const t = setup();
	const s = t.make();
	s.init();
	s.startPairing(8791);
	const p = s.activePairing();
	assert.ok(p);
	assert.deepEqual(Object.keys(p).sort(), ["code", "expiresAt", "key"], "no attempt counter on a code");
	assert.equal(/** @type {any} */ (s).pairingFailed, undefined, "and no way to report a failure against it");
	assert.equal(/** @type {any} */ (LIMITS).pairingMaxAttempts, undefined);
	assert.equal(/** @type {any} */ (LIMITS).authBackoffBaseMs, undefined);
	t.clock.advance(LIMITS.pairingTtlMs - 1);
	assert.equal(s.activePairing(), p);
	assert.equal(s.consumePairing(p), true);
	assert.ok(!t.logs.some((l) => l.event === "pairing.code_invalidated"));
});

test("throwaway pairing key: the same kind of key as a code's, different every time, and no code becomes active", () => {
	const t = setup();
	const s = t.make();
	s.init();
	const a = s.throwawayPairingKey(8791);
	const b = s.throwawayPairingKey(8791);
	s.startPairing(8791);
	const real = s.activePairing();
	assert.ok(real);
	assert.equal(a.length, real.key.length);
	assert.notDeepEqual(a, b);
	assert.notDeepEqual(a, real.key);
	const fresh = t.make();
	fresh.init();
	fresh.throwawayPairingKey(8791);
	assert.equal(fresh.activePairing(), null);
});

test("throwaway extension key: the same kind of key as a stored one, different every time, and nothing is stored", () => {
	const t = setup();
	const s = t.make();
	s.init();
	const a = s.throwawayExtKey();
	const b = s.throwawayExtKey();
	assert.ok(a instanceof Uint8Array);
	assert.equal(a.length, 32);
	assert.notDeepEqual(a, b);
	assert.notDeepEqual(a, new Uint8Array(32));
	assert.equal(s.extKey(), null);
	assert.equal(s.isPaired(), false);
	// With a key stored it is still its own thing.
	const stored = new Uint8Array(crypto.randomBytes(32));
	s.setExtKey(stored);
	assert.notDeepEqual(s.throwawayExtKey(), stored);
	assert.equal(s.extKey(), stored);
});

test("prove: HMAC-SHA256 under the token of the role, over bgw1|prove|role|port|nonce", () => {
	const t = setup();
	const s = t.make();
	s.init();
	const token = fs.readFileSync(t.tokenFile, "utf8").trim();
	const admin = fs.readFileSync(t.adminFile, "utf8").trim();
	const nonce = crypto.randomBytes(32).toString("base64url");
	/** @param {string} key @param {string} text */
	const hmac = (key, text) => crypto.createHmac("sha256", key).update(text).digest("base64url");

	assert.equal(s.prove("client", 8791, nonce), hmac(token, `bgw1|prove|client|8791|${nonce}`));
	assert.equal(s.prove("admin", 8791, nonce), hmac(admin, `bgw1|prove|admin|8791|${nonce}`));
	assert.match(s.prove("client", 8791, nonce), /^[A-Za-z0-9_-]{43}$/);
	// Bound to the role and to the nonce: neither proof stands in for the other.
	assert.notEqual(s.prove("client", 8791, nonce), s.prove("admin", 8791, nonce));
	assert.notEqual(s.prove("client", 8791, nonce), hmac(admin, `bgw1|prove|client|8791|${nonce}`));
	assert.notEqual(s.prove("client", 8791, nonce), s.prove("client", 8791, crypto.randomBytes(32).toString("base64url")));
	assert.equal(s.prove("client", 8791, nonce), s.prove("client", 8791, nonce), "deterministic");
	// Bound to the port: the same tokens on another port give another proof, and the old text gives none.
	assert.notEqual(s.prove("client", 8791, nonce), s.prove("client", 8792, nonce));
	assert.notEqual(s.prove("client", 8791, nonce), s.prove("client", 18791, nonce));
	assert.notEqual(s.prove("client", 8791, nonce), hmac(token, `bgw1|prove|client|${nonce}`));
	// The same after a restart: it is the token in the file that signs.
	const again = t.make();
	again.init();
	assert.equal(again.prove("admin", 8791, nonce), s.prove("admin", 8791, nonce));

	for (const role of ["", "root", "Client", "ext", null, undefined, 1]) {
		assert.throws(() => s.prove(/** @type {any} */ (role), 8791, nonce), TypeError, String(role));
	}
	for (const port of [0, -1, 65536, 1.5, NaN, "8791", "8791|x", null, undefined]) {
		assert.throws(() => s.prove("client", /** @type {any} */ (port), nonce), TypeError, String(port));
		assert.throws(() => s.pairProof(/** @type {any} */ (port), nonce, "bgw1.8791." + "A".repeat(43)), TypeError, String(port));
	}
	for (const bad of [undefined, null, 5, "", "short", "A".repeat(21), "A".repeat(87), "*".repeat(43), nonce + "=", nonce.slice(0, 42) + "+", "B".repeat(22).slice(0, 21) + "B"]) {
		if (isProofNonce(bad)) continue;
		assert.throws(() => s.prove("client", 8791, /** @type {any} */ (bad)), TypeError, String(bad));
	}
	assert.throws(() => t.make().prove("client", 8791, nonce), /not loaded/, "nothing is signed before the tokens are read");
});

test("proof nonces: canonical base64url of 16 to 64 bytes", () => {
	for (const n of [16, 17, 24, 32, 48, 64]) assert.ok(isProofNonce(crypto.randomBytes(n).toString("base64url")), `${n} bytes`);
	for (const n of [0, 1, 8, 15, 65, 128]) assert.ok(!isProofNonce(crypto.randomBytes(n).toString("base64url")), `${n} bytes`);
	const good = crypto.randomBytes(32).toString("base64url");
	for (const bad of [good + "=", good.replace(/.$/, "+"), good.replace(/.$/, "/"), ` ${good}`, `${good}\n`, good + "|x", `${good.slice(0, 20)}|${good.slice(21)}`, 5, null, undefined, {}, [good]]) {
		assert.ok(!isProofNonce(bad), String(bad));
	}
	// 16 bytes are 22 characters whose last one carries four zero bits: other endings are not canonical.
	assert.ok(isProofNonce("A".repeat(21) + "A"));
	assert.ok(!isProofNonce("A".repeat(21) + "B"));
});

test("pairProof: HMAC under the admin token over bgw1|pair|port|nonce|code", () => {
	const t = setup();
	const s = t.make();
	s.init();
	const token = fs.readFileSync(t.tokenFile, "utf8").trim();
	const admin = fs.readFileSync(t.adminFile, "utf8").trim();
	const nonce = crypto.randomBytes(32).toString("base64url");
	const { code } = s.startPairing(8791);
	const mac = s.pairProof(8791, nonce, code);
	assert.equal(mac, crypto.createHmac("sha256", admin).update(`bgw1|pair|8791|${nonce}|${code}`).digest("base64url"));
	assert.notEqual(mac, crypto.createHmac("sha256", token).update(`bgw1|pair|8791|${nonce}|${code}`).digest("base64url"), "not the agent token");
	assert.notEqual(mac, s.pairProof(8791, nonce, s.startPairing(8791).code), "bound to the code");
	assert.notEqual(mac, s.pairProof(8792, nonce, code), "bound to the port");
	assert.notEqual(mac, s.prove("admin", 8791, nonce), "and not a proof of another kind");
	assert.throws(() => s.pairProof(8791, "short", code), TypeError);
});

test("secrets never reach the log", () => {
	const t = setup();
	const s = t.make();
	s.init();
	const token = fs.readFileSync(t.tokenFile, "utf8").trim();
	const admin = fs.readFileSync(t.adminFile, "utf8").trim();
	const { code } = s.startPairing(8791);
	const key = randomBytes(32);
	s.setExtKey(key);
	s.setExtKey(randomBytes(32));
	const nonce = crypto.randomBytes(32).toString("base64url");
	const proofs = [s.prove("client", 8791, nonce), s.prove("admin", 8791, nonce), s.pairProof(8791, nonce, code)];
	fs.chmodSync(t.tokenFile, 0o644);
	fs.chmodSync(t.keyFile, 0o644);
	t.make().init();
	const text = JSON.stringify(t.logs);
	assert.ok(t.logs.length >= 5);
	assert.ok(!text.includes(token));
	assert.ok(!text.includes(admin));
	for (const mac of proofs) assert.ok(!text.includes(mac), "a proof is an answer, not a log line");
	assert.ok(!text.includes(nonce));
	assert.ok(!text.includes(code));
	assert.ok(!text.includes(code.split(".")[2]));
	assert.ok(!text.includes(fs.readFileSync(t.keyFile, "utf8").trim()));
});

test("audit log: JSONL, 0600, origins only", () => {
	const t = setup();
	const dataDir = path.join(t.dir, "data");
	const audit = new AuditLog({ dataDir, clock: t.clock, log: t.log });
	assert.equal(audit.ok, false, "not usable before open()");
	audit.open();
	assert.equal(audit.ok, true);
	if (MODES) assert.equal(mode(dataDir), 0o700);
	if (MODES) assert.equal(mode(audit.file), 0o600);

	audit.append({
		job: "j_1",
		kind: "fetch",
		url: "https://example.com/a?q=1",
		host: "example.com",
		outcome: "ok",
		code: null,
		cookie_scope: "container",
		dispatched: true,
		duration_ms: 1234.6,
		redirect_origins: ["https://example.com/login?next=/a&token=SECRET", "https://sso.example.org:8443/cb#frag", "not a url", "javascript:alert(1)"],
		callers: 1,
	});
	t.clock.advance(1000);
	audit.append({ job: "j_2", kind: "probe", url: `https://example.com/${"x".repeat(5000)}`, outcome: "error", code: "queue_full", cookie_scope: null, duration_ms: -5, redirect_origins: [] });

	const lines = fs.readFileSync(audit.file, "utf8").split("\n");
	assert.equal(lines.length, 3);
	assert.equal(lines[2], "");
	const [a, b] = [JSON.parse(lines[0]), JSON.parse(lines[1])];
	assert.deepEqual(a, {
		ts: new Date(t.clock.now() - 1000).toISOString(),
		job: "j_1",
		kind: "fetch",
		url: "https://example.com/a?q=1",
		host: "example.com",
		outcome: "ok",
		code: null,
		cookie_scope: "container",
		duration_ms: 1235,
		redirect_origins: ["https://example.com", "https://sso.example.org:8443"],
	});
	assert.ok(!lines[0].includes("SECRET"));
	assert.equal(b.url.length, 2048);
	assert.equal(b.host, null);
	assert.equal(b.duration_ms, 0);
	assert.deepEqual(Object.keys(a).sort(), ["code", "cookie_scope", "duration_ms", "host", "job", "kind", "outcome", "redirect_origins", "ts", "url"]);

	// Appends across restarts, and tightens a file that was made readable.
	audit.close();
	assert.equal(audit.ok, false);
	fs.chmodSync(audit.file, 0o644);
	const reopened = new AuditLog({ dataDir, clock: t.clock, log: t.log });
	reopened.open();
	if (MODES) assert.equal(mode(audit.file), 0o600);
	// Windows has no mode bits to loosen or tighten.
	if (process.platform !== "win32") {
		assert.ok(t.logs.some((l) => l.level === "warn" && l.event === "audit.file_mode_fixed" && l.fields.file === audit.file));
	}
	reopened.append({ job: "j_3", kind: "fetch", url: "https://example.com/", outcome: "ok", code: null, cookie_scope: "container", duration_ms: 1, redirect_origins: [] });
	reopened.close();
	assert.equal(fs.readFileSync(audit.file, "utf8").split("\n").filter(Boolean).length, 3);
});

test("audit log: a load outside the container leaves its host and nothing else of the page", () => {
	const t = setup();
	const audit = new AuditLog({ dataDir: path.join(t.dir, "data"), clock: t.clock, log: t.log });
	audit.open();
	const url = "https://private.example.com/inbox/thread-4711?session=SECRETQUERY#frag";
	const hops = ["https://sso.PRIVATEREDIRECT.example/cb?code=1", "https://private.example.com"];
	/** @param {Partial<import("../../daemon/src/audit.js").AuditEntry>} over */
	const write = (over) => {
		audit.append({ job: "j_1", kind: "fetch", url, host: "private.example.com", outcome: "ok", code: null, cookie_scope: null, dispatched: false, duration_ms: 5, redirect_origins: hops, ...over });
		const lines = fs.readFileSync(audit.file, "utf8").trimEnd().split("\n");
		return { line: lines[lines.length - 1], entry: JSON.parse(lines[lines.length - 1]) };
	};

	// The operator's own session: host only.
	const own = write({ cookie_scope: "default", dispatched: true });
	assert.deepEqual({ ...own.entry, ts: "" }, { ts: "", job: "j_1", kind: "fetch", url: null, host: "private.example.com", outcome: "ok", code: null, cookie_scope: "default", duration_ms: 5, redirect_origins: [] });
	for (const needle of ["thread-4711", "SECRETQUERY", "frag", "PRIVATEREDIRECT", "sso."]) assert.ok(!own.line.includes(needle), needle);
	// "default" without the flag is treated the same: the scope alone decides.
	assert.equal(write({ cookie_scope: "default", dispatched: false }).entry.url, null);

	// The browser was asked, and which cookie store it used never became known: host only.
	const unknown = write({ cookie_scope: null, dispatched: true, outcome: "timeout", code: "deadline" });
	assert.equal(unknown.entry.url, null);
	assert.deepEqual(unknown.entry.redirect_origins, []);
	assert.equal(unknown.entry.host, "private.example.com");
	assert.ok(!unknown.line.includes("thread-4711"));

	// The container: the request as asked, redirect hops as origins.
	const contained = write({ cookie_scope: "container", dispatched: true });
	assert.equal(contained.entry.url, url);
	assert.deepEqual(contained.entry.redirect_origins, ["https://sso.privateredirect.example", "https://private.example.com"]);

	// Turned away before the browser saw it (the queue was full, say): no page was loaded, so what was asked for is the record.
	const turnedAway = write({ cookie_scope: null, dispatched: false, outcome: "error", code: "queue_full" });
	assert.equal(turnedAway.entry.url, url);
	assert.deepEqual(turnedAway.entry.redirect_origins, []);

	// Refused by the policy: where it would have gone, and no more of what a caller made up.
	const refused = write({ cookie_scope: null, dispatched: false, outcome: "policy_blocked", code: "blocklisted", host: null });
	assert.equal(refused.entry.url, "https://private.example.com");
	assert.equal(refused.entry.host, null);
	assert.deepEqual(refused.entry.redirect_origins, []);
	for (const needle of ["thread-4711", "SECRETQUERY", "frag"]) assert.ok(!refused.line.includes(needle), needle);
	// What is no address leaves none.
	for (const asked of ["x".repeat(5000), "javascript:alert(document.cookie)", "file:///etc/passwd", "http://exa mple/not a url", ""]) {
		assert.equal(write({ url: asked, cookie_scope: null, dispatched: false, outcome: "policy_blocked", code: "invalid_url", host: null }).entry.url, null, asked.slice(0, 40));
	}
	// However long it is, the line it leaves is short.
	const long = write({ url: `http://10.1.2.3:8080/${"p".repeat(1500)}?${"q".repeat(500)}`, cookie_scope: null, dispatched: false, outcome: "policy_blocked", code: "private_address", host: null });
	assert.equal(long.entry.url, "http://10.1.2.3:8080");
	assert.ok(long.line.length < 300, String(long.line.length));
	audit.close();
});

test("audit log: optional fields, and no credentials from the URL", () => {
	const t = setup();
	const audit = new AuditLog({ dataDir: path.join(t.dir, "data"), clock: t.clock, log: t.log });
	audit.open();
	const base = { job: null, kind: "fetch", url: null, host: null, outcome: "ok", code: null, cookie_scope: null, dispatched: false, duration_ms: 0 };
	audit.append({ ...base, url: "https://example.com/a", host: "example.com", cookie_scope: "container", cache: "hit", page: "pg_" + "0".repeat(26) });
	audit.append({ ...base, kind: "search", hits: 3 });
	audit.append({ ...base, job: "j_1", callers: 4, cookie_scope: "container", url: "https://example.com/b", host: "example.com", dispatched: true, redirect_origins: [] });
	audit.append({ ...base, job: "j_2", outcome: "error", code: "queue_full", url: "https://alice:hunter2@example.com/path?x=1" });
	audit.append({ ...base, job: "j_3", outcome: "error", code: "queue_full", url: "http://bob:hunter2@exa mple/not a url" });
	audit.append({ ...base, host: "h".repeat(400) });
	audit.append({ ...base, job: "j_4", outcome: "policy_blocked", code: "userinfo_not_allowed", url: "https://alice:hunter2@example.com/path?x=1" });
	audit.append({ ...base, job: "j_5", outcome: "policy_blocked", code: "invalid_url", url: "http://bob:hunter2@exa mple/not a url" });
	audit.close();
	const entries = fs.readFileSync(audit.file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual([entries[0].cache, entries[0].page, entries[0].url, entries[0].job], ["hit", "pg_" + "0".repeat(26), "https://example.com/a", null]);
	assert.deepEqual([entries[1].kind, entries[1].hits, entries[1].url, entries[1].host], ["search", 3, null, null]);
	assert.equal(entries[2].callers, 4);
	assert.equal(entries[0].callers, undefined, "one caller is not worth a field");
	assert.equal(entries[3].url, "https://example.com/path?x=1");
	assert.equal(entries[4].url, "http://exa mple/not a url");
	assert.ok(!fs.readFileSync(audit.file, "utf8").includes("hunter2"));
	assert.equal(entries[5].host.length, 255);
	assert.deepEqual([entries[6].url, entries[7].url], ["https://example.com", null], "refused by the policy: the origin, or nothing");
});

test("audit log: a failed write is reported and marks the log unusable", () => {
	const t = setup();
	const audit = new AuditLog({ dataDir: path.join(t.dir, "data"), clock: t.clock, log: t.log });
	audit.open();
	audit.close();
	audit.append({ job: "j_1", kind: "fetch", url: "https://example.com/", outcome: "ok", code: null, cookie_scope: null, duration_ms: 1, redirect_origins: [] });
	assert.equal(audit.ok, false);
	assert.ok(t.logs.some((l) => l.level === "error" && l.event === "audit.write_failed"));
});

test("toOrigins", () => {
	assert.deepEqual(toOrigins(["https://a.example/x?y=1", "http://b.example:8080/", "HTTPS://C.EXAMPLE", 5, null, "", "ftp://d.example/", "about:blank"]), [
		"https://a.example",
		"http://b.example:8080",
		"https://c.example",
	]);
	assert.deepEqual(toOrigins([]), []);
});

test("config.json: absent means defaults", () => {
	const t = setup();
	assert.deepEqual(loadSettings(t.configDir), defaultSettings());
	assert.deepEqual(defaultSettings(), {
		retentionDays: 30,
		cacheTtlS: 600,
		// A parked challenge is announced after half a minute, unless it cleared by then.
		notify: { sound: true, hookCommand: null, challengeDelayS: 30 },
		// A page gets half a minute to load.
		fetch: { loadTimeoutS: 30 },
		pacing: { defaultProfile: "polite", fastHosts: [], hourlyBudget: { polite: 120, fast: 1200 } },
		search: { defaultEngine: "duckduckgo", engines: {} },
		pages: { maxTotalMb: 2048 },
		// A fetch may bring back a file of up to 25 MiB, of the types the gateway knows how to keep.
		files: { enabled: true, maxMb: 25, maxTotalMb: 2048, allowTypes: ["application/pdf", "application/json", "+json", "application/xml", "text/xml", "+xml", "text/plain", "text/csv", "text/markdown", "image/png", "image/jpeg", "image/gif", "image/webp", "application/zip", "application/gzip", "application/x-tar", "application/octet-stream"] },
	});
	assert.deepEqual(parseSettings({}), defaultSettings());
	assert.equal(fs.existsSync(t.configDir), false, "reading settings creates nothing");
});

test("config.json: every key, read from the file", () => {
	const t = setup();
	fs.mkdirSync(t.configDir, { mode: 0o700 });
	const file = path.join(t.configDir, "config.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			retention_days: 7,
			cache_ttl_s: 0,
			notify: { sound: "/usr/share/sounds/x.oga", hook_command: ["/usr/local/bin/bgw-hook", "--topic", "gateway"], challenge_delay_s: 90 },
			fetch: { load_timeout_s: 75 },
			pacing: { default_profile: "fast", fast_hosts: ["docs.example.com", "example.org"], hourly_budget: { polite: 30, fast: 300 } },
			search: { default_engine: "mysearx", engines: { mysearx: "https://searx.example.org/search?q={q}" } },
			pages: { max_total_mb: 512 },
			files: { enabled: false, max_mb: 200, max_total_mb: 4096, allow_types: ["application/pdf", "+json", "application/vnd.example.report"] },
		}),
		{ mode: 0o600 },
	);
	assert.deepEqual(loadSettings(t.configDir), {
		retentionDays: 7,
		cacheTtlS: 0,
		notify: { sound: "/usr/share/sounds/x.oga", hookCommand: ["/usr/local/bin/bgw-hook", "--topic", "gateway"], challengeDelayS: 90 },
		fetch: { loadTimeoutS: 75 },
		pacing: { defaultProfile: "fast", fastHosts: ["docs.example.com", "example.org"], hourlyBudget: { polite: 30, fast: 300 } },
		search: { defaultEngine: "mysearx", engines: { mysearx: "https://searx.example.org/search?q={q}" } },
		pages: { maxTotalMb: 512 },
		files: { enabled: false, maxMb: 200, maxTotalMb: 4096, allowTypes: ["application/pdf", "+json", "application/vnd.example.report"] },
	});
	// Partial files keep the other defaults.
	assert.deepEqual(parseSettings({ notify: { sound: false } }).notify, { sound: false, hookCommand: null, challengeDelayS: 30 });
	// The bounds of the two limits an operator sets in seconds, both ends included.
	assert.deepEqual([0, 300].map((s) => parseSettings({ notify: { challenge_delay_s: s } }).notify.challengeDelayS), [0, 300]);
	assert.deepEqual([5, 120].map((s) => parseSettings({ fetch: { load_timeout_s: s } }).fetch.loadTimeoutS), [5, 120]);
	assert.deepEqual(parseSettings({ fetch: {} }).fetch, { loadTimeoutS: 30 });
	assert.deepEqual(parseSettings({ pacing: { hourly_budget: { fast: 5 } } }).pacing.hourlyBudget, { polite: 120, fast: 5 });
	assert.equal(parseSettings({ retention_days: 3650 }).retentionDays, 3650);

	// A file others could read or write is fixed, and the caller is told which.
	// Windows has no mode bits to loosen or tighten.
	if (process.platform !== "win32") {
		fs.chmodSync(file, 0o664);
		/** @type {string[]} */
		const fixed = [];
		loadSettings(t.configDir, (f) => fixed.push(f));
		assert.deepEqual(fixed, [file]);
		if (MODES) assert.equal(mode(file), 0o600);
	}
});

test("config.json: strict - unknown keys, wrong types and values out of range stop the start", () => {
	/** @type {[unknown, RegExp][]} */
	const bad = [
		[null, /top level must be an object/],
		[[], /top level must be an object/],
		["x", /top level must be an object/],
		[{ retention: 30 }, /unknown key "retention" in the top level/],
		[{ retention_days: 30, port: 8791 }, /unknown key "port"/],
		[{ retention_days: "30" }, /retention_days must be an integer from 1 to 3650/],
		[{ retention_days: 0 }, /retention_days/],
		[{ retention_days: 3651 }, /retention_days/],
		[{ retention_days: 1.5 }, /retention_days/],
		[{ cache_ttl_s: -1 }, /cache_ttl_s must be an integer from 0 to 86400/],
		[{ cache_ttl_s: 86401 }, /cache_ttl_s/],
		[{ notify: "on" }, /notify must be an object/],
		[{ notify: { sounds: true } }, /unknown key "sounds" in notify/],
		[{ notify: { sound: "ping.oga" } }, /notify\.sound must be true, false or the absolute path/],
		[{ notify: { sound: 1 } }, /notify\.sound/],
		[{ notify: { sound: "/a\u0000b" } }, /notify\.sound/],
		[{ notify: { hook_command: "/bin/hook --flag" } }, /notify\.hook_command must be an array/],
		[{ notify: { hook_command: [] } }, /notify\.hook_command/],
		[{ notify: { hook_command: ["hook"] } }, /the first an absolute path/],
		[{ notify: { hook_command: ["/bin/hook", ""] } }, /notify\.hook_command/],
		[{ notify: { hook_command: ["/bin/hook", 5] } }, /notify\.hook_command/],
		[{ notify: { hook_command: ["/bin/hook", "a\u0000b"] } }, /notify\.hook_command/],
		[{ notify: { hook_command: ["/bin/hook", ...new Array(32).fill("x")] } }, /notify\.hook_command/],
		[{ notify: { challenge_delay_s: -1 } }, /notify\.challenge_delay_s must be an integer from 0 to 300/],
		[{ notify: { challenge_delay_s: 301 } }, /notify\.challenge_delay_s/],
		[{ notify: { challenge_delay_s: "30" } }, /notify\.challenge_delay_s/],
		[{ notify: { challenge_delay_s: 1.5 } }, /notify\.challenge_delay_s/],
		[{ fetch: 30 }, /fetch must be an object/],
		[{ fetch: { timeout_s: 30 } }, /unknown key "timeout_s" in fetch/],
		[{ fetch: { load_timeout_s: 4 } }, /fetch\.load_timeout_s must be an integer from 5 to 120/],
		[{ fetch: { load_timeout_s: 121 } }, /fetch\.load_timeout_s/],
		[{ fetch: { load_timeout_s: "60" } }, /fetch\.load_timeout_s/],
		[{ fetch: { load_timeout_s: null } }, /fetch\.load_timeout_s/],
		[{ pacing: [] }, /pacing must be an object/],
		[{ pacing: { profile: "fast" } }, /unknown key "profile" in pacing/],
		[{ pacing: { default_profile: "turbo" } }, /default_profile must be "polite" or "fast"/],
		[{ pacing: { fast_hosts: "docs.example.com" } }, /pacing\.fast_hosts must be an array/],
		[{ pacing: { fast_hosts: ["com"] } }, /pacing\.fast_hosts/],
		[{ pacing: { fast_hosts: ["Docs.Example.com"] } }, /pacing\.fast_hosts/],
		[{ pacing: { fast_hosts: ["https://docs.example.com/"] } }, /pacing\.fast_hosts/],
		[{ pacing: { fast_hosts: ["*.example.com"] } }, /pacing\.fast_hosts/],
		[{ pacing: { fast_hosts: [5] } }, /pacing\.fast_hosts/],
		[{ pacing: { fast_hosts: new Array(257).fill("a.example") } }, /pacing\.fast_hosts/],
		[{ pacing: { hourly_budget: 100 } }, /pacing\.hourly_budget must be an object/],
		[{ pacing: { hourly_budget: { slow: 1 } } }, /unknown key "slow" in pacing\.hourly_budget/],
		[{ pacing: { hourly_budget: { polite: 0 } } }, /pacing\.hourly_budget\.polite must be an integer from 1 to 100000/],
		[{ pacing: { hourly_budget: { fast: 1e9 } } }, /pacing\.hourly_budget\.fast/],
		[{ __proto__: null, constructor: 1 }, /unknown key "constructor"/],
	];
	for (const [raw, message] of bad) {
		assert.throws(() => parseSettings(raw), (err) => err instanceof ConfigError && message.test(err.message), JSON.stringify(raw)?.slice(0, 80));
	}

	const t = setup();
	fs.mkdirSync(t.configDir, { mode: 0o700 });
	const file = path.join(t.configDir, "config.json");
	for (const [text, message] of /** @type {[string, RegExp][]} */ ([
		["", /not valid JSON/],
		["{", /not valid JSON/],
		["{'retention_days': 7}", /not valid JSON/],
		['{"retention_days": 7,}', /not valid JSON/],
		['{"retention_days": 7} trailing', /not valid JSON/],
		[`{"pad": "${"x".repeat(70000)}"}`, /too large/],
	])) {
		fs.writeFileSync(file, text, { mode: 0o600 });
		assert.throws(() => loadSettings(t.configDir), (err) => err instanceof ConfigError && message.test(err.message), text.slice(0, 40));
	}
	fs.rmSync(file);
	fs.mkdirSync(file);
	assert.throws(() => loadSettings(t.configDir), (err) => err instanceof ConfigError && /not a regular file/.test(err.message));
	fs.rmdirSync(file);
	// Windows makes no symlink without a privilege.
	if (process.platform !== "win32") {
		fs.symlinkSync(t.tokenFile, file);
		assert.throws(() => loadSettings(t.configDir), ConfigError, "a symlink is not followed");
	}
});

test("socket activation: a descriptor is taken only when it was handed to this process", () => {
	assert.equal(inheritedListenFd({}, 100), null);
	assert.equal(inheritedListenFd({ LISTEN_FDS: "1", LISTEN_PID: "100" }, 100), 3);
	// Inherited variables that were meant for another process are ignored.
	assert.equal(inheritedListenFd({ LISTEN_FDS: "1", LISTEN_PID: "99" }, 100), null);
	assert.equal(inheritedListenFd({ LISTEN_FDS: "1" }, 100), null);
	assert.equal(inheritedListenFd({ LISTEN_FDS: "", LISTEN_PID: "100" }, 100), null);
	assert.equal(inheritedListenFd({ LISTEN_PID: "100" }, 100), null);
	assert.equal(inheritedListenFd({ LISTEN_FDS: "1", LISTEN_PID: "0100" }, 100), null);
	// Exactly one socket, or none is used.
	for (const count of ["0", "2", "3", "-1", "one", "1 ", "01"]) {
		assert.throws(() => inheritedListenFd({ LISTEN_FDS: count, LISTEN_PID: "100" }, 100), /exactly one socket/, count);
	}
});
