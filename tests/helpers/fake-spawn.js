import { EventEmitter } from "node:events";

/**
 * Stand-ins for the processes the notifier starts (the notification helper,
 * gdbus, pw-play, the operator's hook). Nothing in a test run may reach the
 * operator's desktop: every daemon a test starts gets one of these instead of
 * the real spawn.
 *
 * @typedef {import("../../daemon/src/notify.js").SpawnFn} SpawnFn
 * @typedef {{ command: string, args: readonly string[], options: import("node:child_process").SpawnOptions, child: FakeChild }} Call
 */

export class FakeChild extends EventEmitter {
	pid = 4242;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	/** @type {string[]} */
	written = [];
	stdinEnded = false;
	/** @type {string[]} */
	signals = [];
	exited = false;
	/** @type {((line: string) => void) | null} called for every line written to stdin */
	onWrite = null;
	/** @type {(() => void) | null} */
	onStdinEnd = null;
	/** @type {((signal: string) => void) | null} */
	onKill = null;
	stdin = {
		/** @param {string} c */
		write: (c) => {
			this.written.push(c);
			this.onWrite?.(c);
			return true;
		},
		end: () => {
			this.stdinEnded = true;
			this.onStdinEnd?.();
		},
		/** @param {"error"} _e @param {(err: Error) => void} _cb */
		on: (_e, _cb) => undefined,
	};

	/** @param {NodeJS.Signals} [sig] */
	kill(sig = "SIGTERM") {
		this.signals.push(sig);
		this.onKill?.(sig);
		return true;
	}

	/** @param {unknown} obj */
	line(obj) {
		this.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
	}

	/** @param {string | Buffer} raw */
	raw(raw) {
		this.stdout.emit("data", raw);
	}

	/** @param {number | null} code */
	exit(code) {
		if (this.exited) return;
		this.exited = true;
		this.emit("exit", code, null);
		this.emit("close", code, null);
	}
}

/**
 * A spawn that only records: every child is a FakeChild the test drives by hand.
 * @returns {{ calls: Call[], spawn: SpawnFn, failNext: (err: Error | "throw") => void }}
 */
export function makeSpawn() {
	/** @type {Call[]} */
	const calls = [];
	/** @type {Array<Error | "throw">} */
	const failures = [];
	return {
		calls,
		failNext: (e) => failures.push(e),
		spawn: (command, args, options) => {
			const child = new FakeChild();
			calls.push({ command, args, options, child });
			const f = failures.shift();
			if (f === "throw") throw new Error("spawn exploded");
			if (f) setImmediate(() => child.emit("error", f));
			return child;
		},
	};
}

/**
 * A spawn whose children behave like the real ones, without anything real
 * behind them: the helper "posts" (a made-up id), closes when asked over
 * stdin, leaves on stdin EOF and on a signal; every other program ends at
 * once with success. For daemons in tests that are not about the notifier.
 *
 * A test can still look at what was started (calls, helpers()) and play the
 * operator: click(call, "open") reports an action the way the helper would.
 * @returns {{ calls: Call[], spawn: SpawnFn, helpers: () => Call[], notifications: () => { call: Call, summary: string, body: string, urgency: string, actions: string[], replaces: number | null }[], click: (call: Call, key?: string) => void }}
 */
export function makeDesktopFake() {
	/** @type {Call[]} */
	const calls = [];
	let nextId = 100;
	/** @param {Call} call */
	const isHelper = (call) => call.args.some((a) => a.endsWith("notify_helper.py"));
	/** @param {Call} call @param {string} name */
	const arg = (call, name) => {
		const hit = call.args.find((a) => a.startsWith(`--${name}=`));
		return hit === undefined ? null : hit.slice(name.length + 3);
	};
	return {
		calls,
		helpers: () => calls.filter(isHelper),
		notifications: () =>
			calls.filter(isHelper).map((call) => ({
				call,
				summary: arg(call, "summary") ?? "",
				body: arg(call, "body") ?? "",
				urgency: arg(call, "urgency") ?? "",
				actions: call.args.filter((a) => a.startsWith("--action=")).map((a) => a.slice(9)),
				replaces: arg(call, "replaces-id") === null ? null : Number(arg(call, "replaces-id")),
			})),
		click: (call, key = "open") => {
			if (call.child.exited) throw new Error("that notification is gone");
			call.child.line({ event: "action", key });
			call.child.line({ event: "exit", why: "action" });
			call.child.exit(0);
		},
		spawn: (command, args, options) => {
			const child = new FakeChild();
			const call = { command, args, options, child };
			calls.push(call);
			if (!isHelper(call)) {
				setImmediate(() => child.exit(0));
				return child;
			}
			const replaces = Number(arg(call, "replaces-id") ?? "0");
			const id = replaces > 0 ? replaces : nextId++;
			setImmediate(() => {
				if (!child.exited) child.line({ event: "posted", id });
			});
			const leave = (/** @type {string} */ why, /** @type {number | null} */ code) => {
				setImmediate(() => {
					if (child.exited) return;
					if (why === "closed") child.line({ event: "closed", reason: 3 });
					child.line({ event: "exit", why });
					child.exit(code);
				});
			};
			child.onWrite = (line) => {
				if (line.includes('"close"')) leave("closed", 0);
			};
			child.onStdinEnd = () => leave("stdin_eof", 0);
			child.onKill = () => leave("signal", 0);
			return child;
		},
	};
}
