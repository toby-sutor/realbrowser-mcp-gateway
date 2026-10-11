import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestDaemon, until } from "../helpers/daemon.js";
import { FakeExtension, makeResult } from "../helpers/fake-extension.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";
import { MSG, makeMessage } from "../../extension/shared/protocol.js";

/**
 * The whole notification path of a pending challenge, without the real
 * desktop: the real daemon, the real helper process, a fake Notifications
 * service on a private bus (a socket in the tests' temp directory), and a fake
 * extension on the other end of the daemon's link.
 *
 *   extension: challenge.pending  ->  daemon posts through the helper
 *   fake service: ActionInvoked("open")  ->  extension receives "attention"
 *   job over  ->  the helper is told to close the notification
 *
 * The operator's session bus is never used: the helper is started with the
 * private address and nothing else can be started at all (no sound player, no
 * gdbus). Skipped unless BGW_TEST_DBUS=1; run it with tests/notify-dbus/run.mjs.
 *
 * @typedef {Record<string, any>} Evt
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const HELPER = path.join(root, "daemon/helpers/notify_helper.py");
const SERVER = path.join(root, "tests/helpers/fake-notify-server.py");
const enabled = process.env.BGW_TEST_DBUS === "1";

/** @type {import("node:child_process").ChildProcess} */
let server;
/** @type {Evt[]} what the fake service reported */
const seen = [];
let address = "";
let dir = "";
/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
/** @type {string[]} programs the daemon tried to start that are not the helper */
const others = [];
/** @type {Awaited<ReturnType<typeof startTestDaemon>>} */
let daemon;
/** @type {FakeExtension} */
let ext;

/** @param {Record<string, unknown>} cmd */
const serverCmd = (cmd) => void server.stdin?.write(JSON.stringify(cmd) + "\n");
/** @param {(e: Evt) => boolean} pred @param {string} what @returns {Promise<Evt>} */
const serverSaw = async (pred, what) => {
	await until(() => seen.some(pred), { timeoutMs: 10000, what });
	return /** @type {Evt} */ (seen.find(pred));
};

/**
 * The daemon's spawn for this test: the real helper, on the private bus.
 * Anything else it asks for is written down and refused.
 * @type {import("../../daemon/src/notify.js").SpawnFn}
 */
const privateSpawn = (command, args, options) => {
	if (command !== "python3" || args[0] !== HELPER) {
		others.push(command);
		throw new Error(`not started in this test: ${command}`);
	}
	const child = spawn(command, [...args], { ...options, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DBUS_SESSION_BUS_ADDRESS: address } });
	children.push(child);
	return child;
};

/** Have the fake extension park the next job. @returns {Promise<Evt>} its job.start frame */
async function parkNext() {
	const before = ext.jobs.length;
	ext.onJob = () => null;
	await until(() => ext.jobs.length > before, { what: "the job to be dispatched" });
	const start = ext.jobs[before];
	ext.send(makeMessage(MSG.JOB_ACCEPTED, { job: start.job, cookie_scope: "container", rule: null }));
	ext.send(makeMessage(MSG.JOB_PROGRESS, { job: start.job, phase: "challenge_wait", http_status: 403 }));
	ext.park(start);
	return start;
}

describe("a pending challenge, end to end on a private notification bus", { skip: !enabled && "set BGW_TEST_DBUS=1 (tests/notify-dbus/run.mjs)" }, () => {
	before(async () => {
		dir = makeTempDir("challenge-dbus");
		server = spawn("python3", [SERVER, path.join(dir, "bus.sock")], { stdio: ["pipe", "pipe", "inherit"] });
		children.push(server);
		let buf = "";
		server.stdout?.setEncoding("utf8");
		server.stdout?.on("data", (/** @type {string} */ d) => {
			buf += d;
			for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
				seen.push(JSON.parse(buf.slice(0, nl)));
				buf = buf.slice(nl + 1);
			}
		});
		address = String((await serverSaw((e) => e.event === "ready", "the fake notification service")).address);
		assert.ok(address.startsWith("unix:path=" + dir), "a private socket in the test directory");
		assert.notEqual(address, process.env.DBUS_SESSION_BUS_ADDRESS, "not the session bus");

		// The daemon as the operator would run it, but for two things: no sound, and the helper on the private bus.
		const configDir = path.join(dir, "config");
		fs.mkdirSync(configDir, { mode: 0o700 });
		fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ notify: { sound: false } }), { mode: 0o600 });
		daemon = await startTestDaemon({ configDir, dataDir: path.join(dir, "data"), spawn: privateSpawn });
		ext = new FakeExtension({ port: daemon.port });
		assert.equal((await ext.pair(await daemon.pairCode())).ready, true);
	});

	after(async () => {
		await ext?.kill();
		await daemon?.stop();
		for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
		removeTempDir(dir);
	});

	test("challenge.pending posts a critical notification with Open; the click reaches the extension as attention", async () => {
		const fetching = daemon.tool("/v1/fetch", { url: "https://www.shop.example/item/1" });
		const start = await parkNext();
		const answer = await fetching;
		assert.equal(answer.json.outcome, "needs_human");
		assert.match(answer.json.text, new RegExp(`job=${start.job} `));

		// What arrived at the notification service.
		const note = await serverSaw((e) => e.event === "notify", "the notification on the private bus");
		assert.equal(note.app_name, "Browser Gateway");
		assert.equal(note.summary, "Browser Gateway: a page needs you");
		assert.equal(note.body, "www.shop.example shows a human check. Open it to continue; the gateway reads the page once the check is passed.");
		assert.equal(note.urgency, 2, "critical: it gets through Do Not Disturb and stays");
		assert.equal(note.timeout, 0);
		assert.deepEqual(note.actions, ["default", "Default", "open", "Open"]);
		assert.equal(note.replaces_id, 0);
		// With its own notification the daemon asks the browser to show the extension's - and for nothing else
		// before the operator acts: no window comes up by itself.
		assert.deepEqual(await ext.waitFor(MSG.ATTENTION, { timeoutMs: 10000 }), makeMessage(MSG.ATTENTION, { job: start.job, action: "renotify" }));
		assert.equal(ext.received.filter((f) => f.type === MSG.ATTENTION && f.action === "focus").length, 0, "the page is not asked for before the operator acts");

		// The operator clicks "Open".
		serverCmd({ emit: "action", id: note.id, key: "open", token: "activation-1" });
		assert.deepEqual(await ext.waitFor(MSG.ATTENTION, { timeoutMs: 10000 }), makeMessage(MSG.ATTENTION, { job: start.job, action: "focus" }));
		assert.deepEqual(ext.invalidFrames, []);
		// The extension has given the operator the page.
		ext.sendEvent("challenge.acked", { job: start.job, host: "www.shop.example" });
		await until(async () => (await daemon.status()).pending[0]?.acked === true, { what: "the acknowledgement" });
		// The check is passed: the job ends, the page is stored.
		ext.sendResult(makeResult(start));
		await until(async () => (await daemon.status()).pending.length === 0, { what: "the job to end" });
		assert.equal((await daemon.tool("/v1/fetch", { url: "https://www.shop.example/item/1" })).json.outcome, "ok");
		assert.equal(seen.filter((e) => e.event === "notify").length, 1, "one notification for one challenge");
	});

	test("a click on the notification body counts the same; a job that ends closes its notification", async () => {
		const posted = seen.filter((e) => e.event === "notify").length;
		const fetching = daemon.tool("/v1/fetch", { url: "https://other.example/page" });
		const start = await parkNext();
		await fetching;
		await until(() => seen.filter((e) => e.event === "notify").length === posted + 1, { timeoutMs: 10000, what: "the second notification" });
		const note = /** @type {Evt} */ (seen.filter((e) => e.event === "notify").at(-1));
		assert.equal(note.body, "other.example shows a human check. Open it to continue; the gateway reads the page once the check is passed.");
		serverCmd({ emit: "action", id: note.id, key: "default" });
		assert.deepEqual(await ext.waitFor(MSG.ATTENTION, { timeoutMs: 10000, match: (f) => f.action === "focus" }), makeMessage(MSG.ATTENTION, { job: start.job, action: "focus" }));
		ext.sendResult(makeResult(start));
		await until(async () => (await daemon.status()).pending.length === 0, { what: "the job to end" });

		// One nobody looked at: when its job is over, the service is asked to close it.
		const third = daemon.tool("/v1/fetch", { url: "https://third.example/page" });
		const start3 = await parkNext();
		await third;
		await until(() => seen.filter((e) => e.event === "notify").length === posted + 2, { timeoutMs: 10000, what: "the third notification" });
		const open = /** @type {Evt} */ (seen.filter((e) => e.event === "notify").at(-1));
		ext.sendResult(makeResult(start3, { outcome: "timeout", content: null, page: null, error: { code: "challenge_expired", message: "nobody cleared the human check in time", retryable: true, retry_after_s: null } }));
		await serverSaw((e) => e.event === "close_called" && e.id === open.id, "the notification to be closed");
		assert.equal((await daemon.status()).pending.length, 0);
	});

	test("nothing but the helper was started: no sound, no gdbus, and every helper is gone at the end", async () => {
		assert.deepEqual(others, [], "the daemon asked for no other program");
		await daemon.stop();
		const helpers = children.filter((c) => c !== server);
		assert.equal(helpers.length, 3);
		await until(() => helpers.every((c) => c.exitCode !== null || c.signalCode !== null), { timeoutMs: 8000, what: "the helpers to exit" });
		// Each one ran on the private bus.
		for (const c of helpers) assert.ok(c.spawnargs.includes(HELPER));
		assert.equal(seen.filter((e) => e.event === "connected").length >= 3, true);
	});
});
