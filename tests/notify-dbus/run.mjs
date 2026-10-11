#!/usr/bin/env node
// Entry point for the helper-versus-fake-Notifications-service test. Not part
// of `npm test`: needs python3 with PyGObject. Usage: node tests/notify-dbus/run.mjs
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probe = spawnSync("python3", ["-c", "import gi; gi.require_version('Gio','2.0'); from gi.repository import Gio, GLib"], { encoding: "utf8" });
if (probe.status !== 0) {
	console.error("notify-dbus: python3 with PyGObject (gi.repository.Gio) is required: " + (probe.stderr || "python3 not found").trim());
	process.exit(1);
}
const tests = ["./notify-dbus.test.js", "./challenge-e2e.test.js"].map((file) => fileURLToPath(new URL(file, import.meta.url)));
// The same guard as for every other test run: the helper may only be started
// against a private bus in the tests' own temp directory, never the session bus.
const guard = fileURLToPath(new URL("../helpers/no-desktop.mjs", import.meta.url));
const r = spawnSync(process.execPath, ["--import", guard, "--test", "--test-timeout=60000", ...tests], {
	stdio: "inherit",
	env: { ...process.env, BGW_TEST_DBUS: "1" },
});
process.exit(r.status ?? 1);
