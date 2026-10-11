// Loaded into every test process before anything else (node --import, see the
// npm scripts). A test run must never reach the operator's desktop: no
// notification on the session bus, no sound. Tests give the daemon stand-ins
// for the programs that would do that; this is the guard behind them. Should
// anything in a test process try to start one of those programs for real, the
// attempt fails and so does the test run - also when the code under test
// catches the error, as the notifier does.
//
// The one thing allowed: the notification helper and gdbus against a private
// bus whose socket lies in the tests' own temp directory (tests/notify-dbus).

import cp from "node:child_process";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
// The same rule as tests/helpers/tmp.js.
const TMP_ROOT = path.resolve(process.env.BGW_TEST_TMPDIR || path.join(repoRoot, ".test-tmp"));

// Programs that play a sound or post to the session bus, whatever their arguments.
const NEVER = new Set(["pw-play", "pw-cat", "paplay", "aplay", "canberra-gtk-play", "notify-send", "kdialog", "dbus-send", "busctl", "qdbus", "qdbus6"]);

/** @type {string[]} */
const refused = [];

/**
 * @param {unknown} env the environment the child would get
 * @returns {boolean} true when its session bus is a socket in the tests' temp directory
 */
function privateBus(env) {
	const e = typeof env === "object" && env !== null ? /** @type {Record<string, unknown>} */ (env) : process.env;
	const address = e.DBUS_SESSION_BUS_ADDRESS;
	if (typeof address !== "string" || !address.startsWith("unix:path=")) return false;
	const socket = path.resolve(address.slice("unix:path=".length).split(",")[0]);
	return socket.startsWith(TMP_ROOT + path.sep);
}

/**
 * @param {unknown} command
 * @param {unknown} args
 * @param {unknown} options
 * @returns {string | null} why this must not be started, or null
 */
function objection(command, args, options) {
	const name = path.basename(String(command));
	const list = Array.isArray(args) ? args.map(String) : [];
	const opts = Array.isArray(args) ? options : args;
	const env = typeof opts === "object" && opts !== null ? /** @type {{ env?: unknown }} */ (opts).env : undefined;
	if (NEVER.has(name)) return `${name} would reach the desktop`;
	const helper = list.some((a) => a.endsWith("notify_helper.py"));
	if ((name === "gdbus" || helper) && !privateBus(env)) return `${helper ? "the notification helper" : "gdbus"} would talk to the real session bus`;
	return null;
}

/**
 * @param {string} why
 * @returns {never}
 */
function refuse(why) {
	refused.push(why);
	process.exitCode = 1;
	process.stderr.write(`\nno-desktop guard: refused to start a process - ${why}. Give the daemon a fake spawn (tests/helpers/fake-spawn.js).\n`);
	throw new Error(`no-desktop guard: ${why}`);
}

for (const fn of /** @type {const} */ (["spawn", "spawnSync", "execFile", "execFileSync"])) {
	const real = /** @type {(...a: any[]) => any} */ (cp[fn]);
	/** @type {any} */ (cp)[fn] = function (/** @type {any[]} */ ...a) {
		const why = objection(a[0], a[1], a[2]);
		if (why !== null) refuse(why);
		return real.apply(this, a);
	};
}
for (const fn of /** @type {const} */ (["exec", "execSync"])) {
	const real = /** @type {(...a: any[]) => any} */ (cp[fn]);
	/** @type {any} */ (cp)[fn] = function (/** @type {any[]} */ ...a) {
		const line = String(a[0]);
		for (const word of line.split(/[\s;|&()]+/)) {
			const name = path.basename(word);
			if (NEVER.has(name) || name === "gdbus" || name === "notify_helper.py") refuse(`"${name}" in a shell command`);
		}
		return real.apply(this, a);
	};
}
syncBuiltinESMExports();

// Even if every error was swallowed and the exit code reset: say so at the end.
process.on("exit", () => {
	if (refused.length > 0 && (process.exitCode === undefined || process.exitCode === 0)) process.exitCode = 1;
});

/** For the tests that show the guard is there, and for the test of the guard itself. */
/** @type {any} */ (globalThis).__bgwNoDesktop = { refused, tmpRoot: TMP_ROOT };
