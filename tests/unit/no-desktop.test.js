// The guard that keeps a test run off the operator's desktop
// (tests/helpers/no-desktop.mjs): what it refuses, what it lets through, and
// that a refusal fails the run even when the code under test swallows it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startTestDaemon, until } from "../helpers/daemon.js";
import { FakeExtension } from "../helpers/fake-extension.js";
import { TMP_ROOT } from "../helpers/tmp.js";

const GUARD = fileURLToPath(new URL("../helpers/no-desktop.mjs", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Run a script in a process of its own, with the guard loaded the way the npm scripts load it.
 * @param {string} script an ES module
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function guarded(script, env = {}) {
	return new Promise((resolve) => {
		execFile(process.execPath, ["--import", GUARD, "--input-type=module", "-e", script], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", BGW_TEST_TMPDIR: TMP_ROOT, ...env }, timeout: 20000 }, (err, stdout, stderr) => {
			resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : -1, stdout, stderr });
		});
	});
}

test("the npm scripts load the guard into every test process", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	for (const name of ["test", "test:integration"]) assert.match(pkg.scripts[name], /--import \.\/tests\/helpers\/no-desktop\.mjs --test /, name);
	assert.match(fs.readFileSync(path.join(root, "tests/notify-dbus/run.mjs"), "utf8"), /no-desktop\.mjs/);
	// When this very run was started through one of them, the guard is here.
	if (process.env.npm_lifecycle_event === "test" || process.env.npm_lifecycle_event === "test:integration") {
		assert.ok(/** @type {any} */ (globalThis).__bgwNoDesktop !== undefined, "this test process runs under the guard");
	}
});

test("a sound player, the real helper or gdbus on the session bus: refused, and the process fails even if the error is swallowed", async () => {
	/** @type {[string, string][]} */
	const attempts = [
		["a sound", `spawn("pw-play", ["/usr/share/sounds/freedesktop/stereo/bell.oga"], { stdio: "ignore" })`],
		["a sound by path", `spawn("/usr/bin/paplay", ["x.oga"])`],
		["the helper", `spawn("python3", ["daemon/helpers/notify_helper.py", "--summary=x"])`],
		["the helper on the session bus by name", `spawn("python3", ["/somewhere/notify_helper.py", "--summary=x"], { env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" } })`],
		["the helper on a bus outside the test directory", `spawn("python3", ["daemon/helpers/notify_helper.py"], { env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/some-bus" } })`],
		["gdbus", `spawn("gdbus", ["call", "--session", "--dest", "org.freedesktop.Notifications"])`],
		["notify-send, synchronously", `spawnSync("notify-send", ["hello"])`],
		["through execFile", `execFile("gdbus", ["call", "--session"], () => {})`],
		["through a shell", `exec("pw-play /usr/share/sounds/x.oga")`],
		["through a shell, synchronously", `execSync("true && notify-send hi")`],
	];
	for (const [name, call] of attempts) {
		const r = await guarded(`import { spawn, spawnSync, execFile, exec, execSync } from "node:child_process";\ntry { ${call}; console.log("STARTED"); } catch (err) { console.log("caught: " + err.message); }\nprocess.exitCode = 0;`);
		assert.match(r.stdout, /^caught: no-desktop guard: /, `${name}: ${r.stdout}${r.stderr}`);
		assert.ok(!r.stdout.includes("STARTED"), name);
		assert.match(r.stderr, /no-desktop guard: refused to start a process/, name);
		assert.equal(r.code, 1, `${name}: the run fails although the error was caught and the exit code reset`);
	}
});

test("the notifier with its real spawn, under the guard: nothing is started, and the run fails", async () => {
	// What would happen if a test started a daemon without a stand-in: the
	// notifier catches the refusal (helper, then the gdbus fallback, then the
	// sound) and carries on - the guard fails the run all the same.
	const script = `
import { createNotifier } from "./daemon/src/notify.js";
import { systemClock } from "./daemon/src/log.js";
const events = [];
const log = { info: (e) => events.push(e), warn: (e) => events.push(e), error: (e) => events.push(e) };
const notifier = createNotifier({ log, clock: systemClock, helperPath: "daemon/helpers/notify_helper.py" });
const handle = notifier.post({ key: "challenge:j_1", summary: "Browser Gateway: a page needs you", body: "example.com shows a human check.", urgency: "critical", actions: [{ key: "open", label: "Open" }], sound: true, host: "example.com", jobId: "j_1" });
const result = await handle.done;
console.log(JSON.stringify({ why: result.why, id: result.id, events }));
`;
	const r = await guarded(script);
	assert.equal(r.code, 1, r.stderr);
	const out = JSON.parse(r.stdout);
	assert.equal(out.why, "error");
	assert.equal(out.id, null, "nothing was posted");
	assert.ok(out.events.includes("notify.helper_spawn_failed") && out.events.includes("notify.fallback_spawn_failed"), out.events.join(","));
	assert.equal((r.stderr.match(/no-desktop guard: refused/g) ?? []).length >= 2, true);
});

test("what the guard lets through: ordinary programs, and the helper against a private bus in the test directory", async () => {
	const bus = path.join(TMP_ROOT, "bgw-guard-test", "no-such-bus.sock");
	const r = await guarded(
		`import { spawnSync } from "node:child_process";
const a = spawnSync("python3", ["-c", "print('fine')"], { encoding: "utf8" });
const b = spawnSync("python3", ["daemon/helpers/notify_helper.py", "--summary=x", "--max-wait-s=2"], { encoding: "utf8", env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: ${JSON.stringify(`unix:path=${bus}`)} } });
console.log(JSON.stringify({ a: a.stdout.trim(), b: b.status, out: b.stdout }));`,
	);
	assert.equal(r.code, 0, r.stderr);
	const out = JSON.parse(r.stdout);
	assert.equal(out.a, "fine");
	// The helper ran, found no bus at that address, and said so: it never looked anywhere else.
	assert.equal(out.b, 2);
	assert.match(out.out, /"event":"error"/);
	assert.ok(!out.out.includes('"posted"'));
	assert.equal(r.stderr.includes("no-desktop guard"), false);
});

test("a daemon started by the test helpers has stand-ins for everything it would start: a challenge reaches no real program", async () => {
	const daemon = await startTestDaemon();
	const ext = new FakeExtension({ port: daemon.port });
	try {
		assert.equal((await ext.pair(await daemon.pairCode())).ready, true);
		ext.onJob = () => null;
		const fetching = daemon.tool("/v1/fetch", { url: "https://www.shop.example/item" });
		await until(() => ext.jobs.length === 1);
		ext.park(ext.jobs[0]);
		assert.equal((await fetching).json.outcome, "needs_human");
		await until(() => daemon.desktop.notifications().length === 1);
		// Everything that was "started" is in the stand-in's list, and nothing reached the guard.
		assert.ok(daemon.desktop.calls.length >= 1);
		assert.ok(daemon.desktop.calls.every((c) => c.child.constructor.name === "FakeChild"));
		const guard = /** @type {any} */ (globalThis).__bgwNoDesktop;
		if (guard !== undefined) assert.deepEqual(guard.refused, []);
	} finally {
		await ext.kill();
		await daemon.stop();
	}
});
