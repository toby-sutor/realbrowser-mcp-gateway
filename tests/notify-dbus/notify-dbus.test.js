import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNotifier } from "../../daemon/src/notify.js";
import { systemClock } from "../../daemon/src/log.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

/**
 * The real helper against a fake Notifications service on a private socket
 * (never the operator's session bus). Skipped unless BGW_TEST_DBUS=1; run it
 * with tests/notify-dbus/run.mjs.
 *
 * @typedef {Record<string, any>} Evt
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const HELPER = path.join(root, "daemon/helpers/notify_helper.py");
const SERVER = path.join(root, "tests/helpers/fake-notify-server.py");
const enabled = process.env.BGW_TEST_DBUS === "1";

/** Line-oriented reader over a child's stdout with waitFor(). */
class Lines {
	/** @type {Evt[]} */
	events = [];
	#buf = "";
	/** @type {Array<() => void>} */
	#waiters = [];

	/** @param {import("node:child_process").ChildProcess} child */
	constructor(child) {
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (/** @type {string} */ d) => {
			this.#buf += d;
			for (;;) {
				const nl = this.#buf.indexOf("\n");
				if (nl < 0) break;
				const line = this.#buf.slice(0, nl);
				this.#buf = this.#buf.slice(nl + 1);
				this.events.push(JSON.parse(line));
			}
			for (const w of this.#waiters.splice(0)) w();
		});
	}

	/**
	 * @param {(e: Evt) => boolean} pred
	 * @param {number} [ms]
	 * @returns {Promise<Evt>}
	 */
	waitFor(pred, ms = 8000) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timeout; saw " + JSON.stringify(this.events))), ms);
			const check = () => {
				const hit = this.events.find(pred);
				if (hit) {
					clearTimeout(timer);
					resolve(hit);
				} else this.#waiters.push(check);
			};
			check();
		});
	}
}

/** @type {import("node:child_process").ChildProcess} */
let server;
/** @type {Lines} */
let serverLines;
/** @type {string} */
let address = "";
/** @type {string} */
let dir = "";
/** @type {Array<import("node:child_process").ChildProcess>} */
const spawned = [];

/** @param {Record<string, unknown>} cmd */
function serverCmd(cmd) {
	server.stdin?.write(JSON.stringify(cmd) + "\n");
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function runHelper(args, env = {}) {
	const child = spawn("python3", [HELPER, ...args], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address, ...env },
	});
	spawned.push(child);
	const lines = new Lines(child);
	/** @type {Promise<number | null>} */
	const exited = new Promise((r) => child.on("close", (code) => r(code)));
	return { child, lines, exited };
}

/** @param {string} s */
const nextNotify = (s) => serverLines.waitFor((e) => e.event === "notify" && e.summary === s);

describe("notify helper against a private fake Notifications service", { skip: !enabled && "set BGW_TEST_DBUS=1 (tests/notify-dbus/run.mjs)" }, () => {
	before(async () => {
		dir = makeTempDir("notify-dbus");
		const sock = path.join(dir, "bus.sock");
		server = spawn("python3", [SERVER, sock], { stdio: ["pipe", "pipe", "inherit"] });
		spawned.push(server);
		serverLines = new Lines(server);
		address = String((await serverLines.waitFor((e) => e.event === "ready")).address);
		assert.ok(address.startsWith("unix:path=" + dir), "private socket, not the session bus");
		assert.notEqual(address, process.env.DBUS_SESSION_BUS_ADDRESS);
	});

	after(async () => {
		for (const c of spawned) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
		removeTempDir(dir);
	});

	test("posts, and an action click arrives on the same connection", async () => {
		const h = runHelper(["--summary=click me", "--body=b", "--urgency=critical", "--action=open=Open", "--timeout-ms=0", "--max-wait-s=30"]);
		const posted = await h.lines.waitFor((e) => e.event === "posted");
		const seen = await nextNotify("click me");
		assert.equal(seen.id, posted.id);
		assert.equal(seen.urgency, 2);
		assert.equal(seen.timeout, 0);
		assert.equal(seen.app_name, "Browser Gateway");
		assert.deepEqual(seen.actions, ["default", "Default", "open", "Open"]);
		serverCmd({ emit: "action", id: posted.id, key: "open", token: "tok-123" });
		const code = await h.exited;
		assert.deepEqual(h.lines.events.map((e) => e.event), ["posted", "activation_token", "action", "exit"]);
		assert.equal(h.lines.events[1]?.token, "tok-123");
		assert.equal(h.lines.events[2]?.key, "open");
		assert.equal(h.lines.events[3]?.why, "action");
		assert.equal(code, 0);
	});

	test("a click on the notification body reports the default action", async () => {
		const h = runHelper(["--summary=body click", "--max-wait-s=30"]);
		const posted = await h.lines.waitFor((e) => e.event === "posted");
		serverCmd({ emit: "action", id: posted.id, key: "default" });
		assert.equal(await h.exited, 0);
		assert.ok(h.lines.events.some((e) => e.event === "action" && e.key === "default"));
	});

	test("signals for other notification ids are ignored; NotificationClosed ends it", async () => {
		const h = runHelper(["--summary=ids", "--max-wait-s=30"]);
		const posted = await h.lines.waitFor((e) => e.event === "posted");
		serverCmd({ emit: "action", id: posted.id + 1000, key: "default" });
		serverCmd({ emit: "closed", id: posted.id + 1000, reason: 1 });
		serverCmd({ emit: "closed", id: posted.id, reason: 2 });
		assert.equal(await h.exited, 0);
		assert.deepEqual(h.lines.events.map((e) => e.event), ["posted", "closed", "exit"]);
		assert.equal(h.lines.events[1]?.reason, 2);
		assert.equal(h.lines.events[2]?.why, "closed");
	});

	test("stdin close command calls CloseNotification and exits after the closed signal", async () => {
		const h = runHelper(["--summary=close me", "--max-wait-s=30"]);
		const posted = await h.lines.waitFor((e) => e.event === "posted");
		h.child.stdin?.write("garbage\n" + JSON.stringify({ cmd: "close" }) + "\n");
		const called = await serverLines.waitFor((e) => e.event === "close_called" && e.id === posted.id);
		assert.ok(called);
		assert.equal(await h.exited, 0);
		const closed = h.lines.events.find((e) => e.event === "closed");
		assert.equal(closed?.reason, 3);
		assert.equal(h.lines.events.at(-1)?.why, "closed");
	});

	test("stdin EOF exits and leaves the notification alone", async () => {
		const h = runHelper(["--summary=eof", "--max-wait-s=30"]);
		const posted = await h.lines.waitFor((e) => e.event === "posted");
		const before = serverLines.events.length;
		h.child.stdin?.end();
		assert.equal(await h.exited, 0);
		assert.equal(h.lines.events.at(-1)?.why, "stdin_eof");
		assert.ok(!serverLines.events.slice(before).some((e) => e.event === "close_called" && e.id === posted.id));
	});

	test("max-wait ends it", async () => {
		const h = runHelper(["--summary=wait", "--max-wait-s=1"]);
		assert.equal(await h.exited, 0);
		assert.equal(h.lines.events.at(-1)?.why, "max_wait");
	});

	test("SIGTERM and SIGINT end it cleanly", async () => {
		for (const sig of /** @type {const} */ (["SIGTERM", "SIGINT"])) {
			const h = runHelper(["--summary=sig " + sig, "--max-wait-s=30"]);
			await h.lines.waitFor((e) => e.event === "posted");
			h.child.kill(sig);
			assert.equal(await h.exited, 0, sig);
			assert.equal(h.lines.events.at(-1)?.why, "signal");
		}
	});

	test("replaces-id is passed through and reused", async () => {
		const a = runHelper(["--summary=r1", "--max-wait-s=30"]);
		const first = await a.lines.waitFor((e) => e.event === "posted");
		a.child.stdin?.end();
		await a.exited;
		const b = runHelper(["--summary=r2", `--replaces-id=${first.id}`, "--max-wait-s=30"]);
		const second = await b.lines.waitFor((e) => e.event === "posted");
		assert.equal(second.id, first.id);
		assert.equal((await nextNotify("r2")).replaces_id, first.id);
		b.child.stdin?.end();
		await b.exited;
	});

	test("bad arguments exit 3 with one error event", async () => {
		for (const args of [[], ["--summary=x", "--urgency=loud"], ["--summary=x", "--action=nolabel"], ["--summary=x", "--bogus"]]) {
			const h = runHelper(args);
			assert.equal(await h.exited, 3, args.join(" "));
			assert.equal(h.lines.events[0]?.event, "error");
		}
	});

	test("no bus exits 2 with an error event", async () => {
		const h = runHelper(["--summary=x"], { DBUS_SESSION_BUS_ADDRESS: "unix:path=" + path.join(dir, "nothing-here.sock") });
		assert.equal(await h.exited, 2);
		assert.equal(h.lines.events[0]?.event, "error");
		assert.equal(h.lines.events.some((e) => e.event === "posted"), false);
	});

	test("missing PyGObject prints one error event and exits 2", async () => {
		const fake = path.join(dir, "nogi");
		fs.mkdirSync(path.join(fake, "gi"), { recursive: true });
		fs.writeFileSync(path.join(fake, "gi", "__init__.py"), 'raise ImportError("no gi here")\n');
		const h = runHelper(["--summary=x"], { PYTHONPATH: fake });
		assert.equal(await h.exited, 2);
		assert.equal(h.lines.events.filter((e) => e.event === "error").length, 1);
	});

	test("notify.js end to end: real spawn, click reaches onAction, same key replaces", async () => {
		const prev = process.env.DBUS_SESSION_BUS_ADDRESS;
		process.env.DBUS_SESSION_BUS_ADDRESS = address;
		try {
			const notifier = createNotifier({
				log: { info() {}, warn() {}, error() {} },
				clock: systemClock,
				helperPath: HELPER,
			});
			const h1 = notifier.post({ key: "job:1", summary: "E2E one", body: "b", urgency: "critical", sound: false, actions: [{ key: "open", label: "Open" }] });
			const first = await serverLines.waitFor((e) => e.event === "notify" && e.summary === "E2E one");
			const h2 = notifier.post({ key: "job:1", summary: "E2E two", body: "b", urgency: "critical", sound: false, actions: [{ key: "open", label: "Open" }] });
			const second = await nextNotify("E2E two");
			assert.equal(second.replaces_id, first.id);
			assert.equal((await h1.done).why, "replaced");
			/** @type {Array<[string, string | null]>} */
			const clicks = [];
			h2.onAction((k, info) => clicks.push([k, info.activationToken]));
			serverCmd({ emit: "action", id: second.id, key: "open", token: "t9" });
			const res = await h2.done;
			assert.deepEqual(clicks, [["open", "t9"]]);
			assert.equal(res.why, "action");
			assert.equal(res.clickable, true);

			const h3 = notifier.post({ key: "job:2", summary: "E2E three", urgency: "normal", sound: false });
			const third = await nextNotify("E2E three");
			await notifier.closeAll();
			const done3 = await h3.done;
			assert.equal(done3.id, third.id);
			assert.ok(serverLines.events.some((e) => e.event === "close_called" && e.id === third.id));
		} finally {
			if (prev === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
			else process.env.DBUS_SESSION_BUS_ADDRESS = prev;
		}
	});
});
