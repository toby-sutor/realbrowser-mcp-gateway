// The release artefact: the XPI as tools/build-xpi.sh makes it, unpacked and
// loaded into headless Firefox with nothing else around - no dev config, no
// test hook, no daemon. What can be seen from outside is the extension's
// console; that is enough to tell that it starts and stays quiet.
//
// Run with: npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { startReleaseBrowser, waitFor } from "./harness.js";

/** @type {Awaited<ReturnType<typeof startReleaseBrowser>>} */
let r;

before(async () => {
	r = await startReleaseBrowser();
});

after(async () => {
	if (r !== undefined) await r.stop();
});

/** @param {string} event @returns {Record<string, unknown>[]} fields of the extension's log lines with that name */
function logged(event) {
	/** @type {Record<string, unknown>[]} */
	const out = [];
	// console.info("[bgw]", event, JSON) as Firefox prints it to stdout.
	for (const line of r.firefox.log().split("\n")) {
		if (!line.includes("[bgw]") || !line.includes(`"${event}"`)) continue;
		const json = /"(\{.*\})"\s*$/.exec(line);
		try {
			out.push(json === null ? {} : JSON.parse(JSON.parse(`"${json[1]}"`)));
		} catch {
			out.push({});
		}
	}
	return out;
}

test("the package holds the extension and nothing that is for tests only", () => {
	const files = r.files();
	assert.ok(files.includes("manifest.json"));
	assert.ok(files.includes("background/main.js"));
	assert.ok(files.includes("shared/policy.js"));
	assert.ok(files.includes("background/downloads.js"));
	// The extractor and the bundle it runs on, with the bundle's licence and lock file.
	for (const file of ["content/extract.js", "content/settle.js", "vendor/defuddle.full.js", "vendor/LICENSE.defuddle", "vendor/VENDOR.lock.json"]) assert.ok(files.includes(file), file);
	assert.equal(files.includes("content/extract-defuddle.js"), false, "one extractor file");
	// The license and the third-party notices go with every copy of the add-on.
	for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.md"]) assert.ok(files.includes(file), file);
	// The gate of the first moments: its listener is registered by the first script of the background page, a plain
	// script that the page loads before the modules, and the gate itself is the first thing the modules make.
	for (const file of ["background/gatefront.js", "background/startgate.js", "background/errtext.js"]) assert.ok(files.includes(file), file);
	assert.deepEqual([...fs.readFileSync(`${r.extDir}/background/background.html`, "utf8").matchAll(/<script\b[^>]*>/g)].map((m) => m[0]), ['<script src="gatefront.js">', '<script type="module" src="main.js">']);
	// What looks for blocks and human checks, and keeps their tabs for the operator.
	for (const file of ["background/detect.js", "background/parked.js", "content/detect-dom.js", "shared/site.js"]) assert.ok(files.includes(file), file);
	// What reads a response that is a file, and what both sides judge and hash it with.
	for (const file of ["background/capture.js", "shared/sniff.js", "shared/sha256.js"]) assert.ok(files.includes(file), file);
	// What takes the service workers of a job's page away when the job is over. It asks the page's own registrations
	// to unregister and does nothing else: no request, no message, nothing of the page read or changed.
	assert.ok(files.includes("content/workers.js"));
	const workers = fs.readFileSync(`${r.extDir}/content/workers.js`, "utf8").replace(/^\s*\/\/.*$/gm, "");
	assert.match(workers, /navigator\.serviceWorker/);
	assert.match(workers, /\.getRegistrations\(\)/);
	assert.match(workers, /\.unregister\(\)/);
	assert.equal(/fetch\(|XMLHttpRequest|postMessage|document\.|window\.|location|\.register\(|browser\.|chrome\./.test(workers), false);
	// The login rules: read by the background page, written by the options page, and what reads a results page.
	for (const file of ["background/optin.js", "shared/optin.js", "shared/ownstore.js", "options/options.js", "options/options.html", "content/search.js"]) assert.ok(files.includes(file), file);
	const lock = JSON.parse(fs.readFileSync(`${r.extDir}/vendor/VENDOR.lock.json`, "utf8"));
	const bundle = fs.readFileSync(`${r.extDir}/vendor/defuddle.full.js`);
	assert.equal(createHash("sha256").update(bundle).digest("hex"), lock.sha256, "the packaged bundle is the pinned one, byte for byte");
	assert.ok(fs.readFileSync(`${r.extDir}/content/extract.js`, "utf8").includes(`DEFUDDLE_VERSION = "${lock.version}"`));
	assert.equal(files.some((f) => f.endsWith("dev-config.json")), false);
	assert.equal(files.includes("background/devhook.js"), false);
	// Nothing in the package can reach the test hook: the one place that loads it sits behind the dev config.
	for (const file of files.filter((f) => f.endsWith(".js") && !f.startsWith("vendor/"))) {
		const source = fs.readFileSync(`${r.extDir}/${file}`, "utf8");
		if (file !== "background/main.js") assert.equal(/["'][^"']*devhook\.js["']/.test(source), false, `${file} must not load the test hook`);
	}
	// With the test hook gone, one file of the package is left that can write a login rule: the options page.
	// (The hook's own command for it, "optin.set", exists in no packaged file.)
	const sources = Object.fromEntries(files.filter((f) => f.endsWith(".js") && !f.startsWith("vendor/")).map((f) => [f, fs.readFileSync(`${r.extDir}/${f}`, "utf8").replace(/^\s*\/\/.*$/gm, "")]));
	assert.deepEqual(Object.keys(sources).filter((f) => /\bown(Set|Remove)\b/.test(sources[f]) && f !== "shared/ownstore.js"), ["options/options.js"]);
	assert.deepEqual(Object.keys(sources).filter((f) => /OPTIN_STORAGE_KEY/.test(sources[f]) && /storage\.local\.(set|remove)\(/.test(sources[f])), ["options/options.js"]);
	assert.deepEqual(Object.keys(sources).filter((f) => /\b(packOptInRules|serializeOptInRules)\b/.test(sources[f]) && f !== "shared/optin.js"), ["options/options.js"]);
	// The test switch that makes every job tab count as hidden is read from the dev config alone: named only where
	// that file is parsed and where the job runner takes its tuning, and a package has no dev config to set it from.
	assert.deepEqual(Object.keys(sources).filter((f) => /forceHidden/.test(sources[f])).sort(), ["background/jobs.js", "background/settings.js"]);
	// One file of the package runs that script, and only for a job in the gateway container.
	assert.deepEqual(Object.keys(sources).filter((f) => /content\/workers\.js/.test(sources[f])), ["background/jobs.js"]);
	assert.match(sources["background/jobs.js"], /if \(run\.scope !== "container" \|\| run\.capture !== null \|\| run\.nav\.committedAt === 0\) return;/);
	for (const [file, source] of Object.entries(sources)) assert.equal(/optin\.(set|forge|shadow)|content\.exec|fixturePorts: \[[0-9]/.test(source), false, `${file} holds nothing of the test hook`);
	const manifest = JSON.parse(fs.readFileSync(`${r.extDir}/manifest.json`, "utf8"));
	assert.equal(manifest.manifest_version, 2);
	assert.equal(manifest.version, "0.1.9");
	assert.equal(manifest.name, "RealBrowser MCP Gateway");
	assert.equal(manifest.browser_specific_settings.gecko.id, "browser-gateway@localhost");
	assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions, { required: ["none"] });
	// The oldest browser it installs in: the first that knows every key of this manifest. And never in a private window.
	assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "140.0");
	assert.equal(manifest.incognito, "not_allowed");
	assert.deepEqual(manifest.background, { page: "background/background.html", persistent: true });
	assert.deepEqual(manifest.permissions, ["tabs", "webNavigation", "webRequest", "webRequestBlocking", "<all_urls>", "contextualIdentities", "cookies", "storage", "notifications", "dns", "sessions", "downloads"]);
	// File capture came without a new permission, and the extension's own pages still cannot talk to the web.
	assert.equal(manifest.content_security_policy, "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'");
	// A response filter is made in one file, and the module that handles it never writes to one.
	assert.deepEqual(Object.keys(sources).filter((f) => /filterResponseData/.test(sources[f].replace(/\/\*[\s\S]*?\*\//g, ""))), ["background/guard.js"]);
	assert.equal(/\.write\(|\.disconnect\(|\.suspend\(/.test(sources["background/capture.js"].replace(/\/\*[\s\S]*?\*\//g, "")), false);
	// Reading download-type files (0.1.6) came without a new permission too. One file answers a request with response
	// headers, one function makes them, and nothing in the package asks for, makes or changes a request header.
	/** @param {string} source @returns {string} without its comments */
	const bare = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
	assert.deepEqual(Object.keys(sources).filter((f) => /responseHeaders:/.test(bare(sources[f]))), ["background/guard.js"]);
	assert.deepEqual(Object.keys(sources).filter((f) => /relabelForCapture/.test(bare(sources[f]))).sort(), ["background/capture.js", "background/guard.js"]);
	assert.deepEqual(Object.keys(sources).filter((f) => !f.startsWith("vendor/") && /requestHeaders|onBeforeSendHeaders|onSendHeaders|redirectUrl/.test(bare(sources[f]))), []);
	assert.match(r.xpi, /dist\/browser-gateway-0\.1\.9\.xpi$/);
});

test("it starts in the browser: unpaired, no dev config, container ready, no window yet, nothing dialled", async () => {
	await waitFor(() => logged("boot.done").length > 0 || logged("boot.failed").length > 0 || r.firefox.exited, {
		timeoutMs: 90000,
		intervalMs: 250,
		what: `the extension to start; log tail: ${r.firefox.log().slice(-1500)}`,
	});
	assert.deepEqual(logged("boot.failed"), [], r.firefox.log().slice(-2000));
	// The gate of the first moments stood and went: registered by the first script of the page, with nothing to hold in an empty browser.
	await waitFor(() => logged("startgate.gone").length > 0, { timeoutMs: 15000, intervalMs: 250, what: "the gate to go" });
	const gates = logged("startgate.gone");
	assert.equal(gates.length, 1);
	const gate = /** @type {Record<string, number>} */ (gates[0]);
	assert.ok(gate.page_ms >= 0 && gate.ms >= 0 && gate.ms < 10000, JSON.stringify(gate));
	assert.deepEqual([gate.held, gate.cancelled, gate.released], [0, 0, 0]);
	// No login rule is in force in a fresh install, and none can be until the operator sets one in the options page.
	assert.deepEqual(logged("boot.done"), [{ version: "0.1.9", paired: false, dev: false, container: true, window: false, login_rules: 0 }]);
	assert.deepEqual(logged("optin.rules_loaded"), []);
	assert.deepEqual(logged("optin.not_in_force"), []);
	assert.deepEqual(logged("dev.config_loaded"), []);
	assert.deepEqual(logged("dev.config_invalid"), []);
	// Unpaired means silent: no connection attempt, no window, no job.
	await new Promise((resolve) => setTimeout(resolve, 2500));
	for (const event of ["link.ready", "link.down", "link.daemon_unverified", "link.unverified", "window.created", "job.done", "downloads.unavailable", "downloads.removed"]) assert.deepEqual(logged(event), [], event);
	assert.equal(/Content Security Policy|SyntaxError|TypeError|ReferenceError/.test(r.firefox.log().split("\n").filter((l) => l.includes("moz-extension://")).join("\n")), false);
});
