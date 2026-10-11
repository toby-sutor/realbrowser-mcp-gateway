import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestDaemon } from "../helpers/daemon.js";

/** @type {Awaited<ReturnType<typeof startTestDaemon>>} */
let daemon;

before(async () => {
	daemon = await startTestDaemon();
});
after(async () => {
	await daemon.stop();
});

/**
 * @param {string} path
 * @param {Record<string, string>} [headers]
 */
function get(path, headers = {}) {
	return daemon.request("GET", path, { auth: false, headers });
}

test("healthz returns ok", async () => {
	const r = await get("/healthz");
	assert.equal(r.status, 200);
	assert.equal(r.json.ok, true);
	assert.equal(r.json.name, "browser-gateway");
	assert.equal(typeof r.json.version, "string");
});

test("healthz says nothing beyond name and version", async () => {
	const r = await get("/healthz");
	assert.deepEqual(Object.keys(r.json).sort(), ["name", "ok", "version"]);
});

test("unknown path is 404", async () => {
	assert.equal((await get("/nope")).status, 404);
});

test("request with Origin is rejected", async () => {
	assert.equal((await get("/healthz", { Origin: "http://evil.example" })).status, 403);
});

test("request with wrong Host is rejected", async () => {
	assert.equal((await get("/healthz", { Host: "evil.example" })).status, 403);
	assert.equal((await get("/healthz", { Host: "localhost:" + daemon.port })).status, 403);
});
