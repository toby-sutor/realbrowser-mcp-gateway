// tools/vendor.mjs without the network: the reader that takes a download piece by piece, the offline check
// of what is vendored, and that nothing of a tarball is written anywhere but the two vendored files.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readCapped, readTar } from "../../tools/vendor.mjs";

const REPO = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const VENDOR = path.join(REPO, "tools", "vendor.mjs");

/**
 * A response whose body never ends by itself: one piece of this size after the other.
 * @param {number} piece bytes
 * @param {Record<string, string>} [headers]
 */
function endless(piece, headers = {}) {
	const seen = { pulled: 0, cancelled: false };
	const body = new ReadableStream({
		pull(controller) {
			seen.pulled += piece;
			controller.enqueue(new Uint8Array(piece));
		},
		cancel() {
			seen.cancelled = true;
		},
	});
	return { res: new Response(body, { headers }), seen };
}

test("a download is given up at the limit, not after it was taken whole: by what the server announces, and by what arrives", async () => {
	// The announced size is over the limit: not a piece of the body is asked for beyond what the stream had ready.
	const announced = endless(1024, { "content-length": String(64 * 1024 * 1024) });
	await assert.rejects(readCapped(announced.res, 32 * 1024), /^Error: the server announces 67108864 bytes, more than the 32768 that are taken$/);
	assert.ok(announced.seen.pulled <= 1024, `pulled ${announced.seen.pulled}`);
	assert.equal(announced.seen.cancelled, true);

	// No size announced, or a small one that is not true: reading stops with the piece that crosses the limit.
	for (const headers of /** @type {Record<string, string>[]} */ ([{}, { "content-length": "10" }])) {
		const lying = endless(1024, headers);
		await assert.rejects(readCapped(lying.res, 32 * 1024), /^Error: the body is larger than the 32768 bytes that are taken$/);
		assert.ok(lying.seen.pulled <= 32 * 1024 + 3 * 1024, `pulled ${lying.seen.pulled}`);
		assert.equal(lying.seen.cancelled, true);
	}

	// What fits comes back whole, and exactly the limit still fits.
	assert.deepEqual(await readCapped(new Response("abc"), 3), Buffer.from("abc"));
	assert.deepEqual(await readCapped(new Response(new Uint8Array(4096).fill(7)), 4096), Buffer.alloc(4096, 7));
	await assert.rejects(readCapped(new Response("abcd"), 3), /larger than the 3 bytes/);
	assert.deepEqual(await readCapped(new Response(null), 3), Buffer.alloc(0));
});

test("importing the script runs nothing; started as a program it checks the vendored files offline, and says how it is used", () => {
	// This file imported it: had the import run the program, the process would have ended with "usage".
	assert.equal(typeof readTar, "function");
	const check = spawnSync(process.execPath, [VENDOR, "--check"], { encoding: "utf8" });
	assert.equal(check.status, 0, check.stderr);
	assert.match(check.stdout, /^ok defuddle\.full\.js sha256 [0-9a-f]{64}\nok LICENSE\.defuddle sha256 [0-9a-f]{64}\nvendor check passed: defuddle@\d+\.\d+\.\d+\n$/);
	const usage = spawnSync(process.execPath, [VENDOR, "--no-such-switch"], { encoding: "utf8" });
	assert.deepEqual([usage.status, usage.stdout, usage.stderr], [1, "", "vendor: usage: vendor.mjs [--check | --pin <version>]\n"]);
});

test("nothing of a tarball goes to a scratch directory: the script makes no temporary directory and writes three files", () => {
	const code = fs
		.readFileSync(VENDOR, "utf8")
		.split("\n")
		.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
		.join("\n");
	assert.doesNotMatch(code, /mkdtemp|tmpdir|BGW_SCRATCH|rmSync/);
	assert.deepEqual([...code.matchAll(/writeFileSync\((\w+)/g)].map((m) => m[1]), ["bundlePath", "licensePath", "lockPath"]);
	// The reader of the archive holds on to regular files only, each under the name the archive gives it.
	const header = Buffer.alloc(512);
	header.write("package/x.txt");
	header.write("0000005\0", 124);
	header.write("0", 156);
	const tar = Buffer.concat([header, Buffer.from("hello").subarray(0, 5), Buffer.alloc(507), Buffer.alloc(1024)]);
	assert.deepEqual([...readTar(tar)], [["package/x.txt", Buffer.from("hello")]]);
});
