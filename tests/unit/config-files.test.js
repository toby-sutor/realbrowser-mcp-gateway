// The operator's settings for file retrieval (config.json, "files"): safe
// defaults, and nothing that is not exactly right is taken.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as config from "../../daemon/src/config.js";
import * as storeModule from "../../daemon/src/store.js";

const { ConfigError, FILE_MAX_MB, defaultSettings, parseSettings } = config;
const { FILE_TOTAL_MB } = /** @type {{ FILE_TOTAL_MB: { fallback: number, min: number, max: number } }} */ (config);
const { FILE_STORE } = /** @type {{ FILE_STORE: { maxTotalBytes: number, readHoldMs: number } }} */ (storeModule);
const { PAGE_TOTAL_MB } = config;
const { PAGE_STORE } = storeModule;
import { LIMITS } from "../../extension/shared/protocol.js";
import { DEFAULT_ALLOW_TYPES } from "../../extension/shared/sniff.js";

test("files: on by default, 25 MiB a file and 2 GiB in all, the documented list of types", () => {
	const d = defaultSettings().files;
	assert.deepEqual(d, { enabled: true, maxMb: 25, maxTotalMb: 2048, allowTypes: [...DEFAULT_ALLOW_TYPES] });
	assert.deepEqual(parseSettings({}).files, d);
	assert.deepEqual(parseSettings({ files: {} }).files, d);
	assert.deepEqual({ ...FILE_MAX_MB }, { fallback: 25, min: 1, max: 200 });
	assert.equal(FILE_MAX_MB.max * 1048576, LIMITS.MAX_FILE_BYTES, "the most an operator can allow is what the wire carries");
	assert.deepEqual({ ...FILE_TOTAL_MB }, { fallback: 2048, min: 1, max: 1048576 });
	assert.equal(FILE_TOTAL_MB.fallback * 1048576, FILE_STORE.maxTotalBytes, "a store that is told nothing has the documented room");
	assert.deepEqual({ ...FILE_STORE }, { maxTotalBytes: 2147483648, readHoldMs: 60000 });
	// The default list can be handed to the extension as it is.
	assert.ok(DEFAULT_ALLOW_TYPES.length <= LIMITS.MAX_FILE_TYPES);
	// Defaults are not shared between two readings.
	parseSettings({ files: { max_mb: 7 } });
	assert.equal(defaultSettings().files.maxMb, 25);
});

test("files: every key is taken as written, the bounds included", () => {
	assert.deepEqual(parseSettings({ files: { enabled: false, max_mb: 1, max_total_mb: 1, allow_types: [] } }).files, { enabled: false, maxMb: 1, maxTotalMb: 1, allowTypes: [] });
	assert.equal(parseSettings({ files: { max_total_mb: 1048576 } }).files.maxTotalMb, 1048576);
	assert.equal(parseSettings({ files: { max_mb: 200, max_total_mb: 200 } }).files.maxTotalMb, 200, "room for exactly one file of the largest kind");
	assert.deepEqual(parseSettings({ files: { max_mb: 200, allow_types: ["application/pdf", "+json", "application/vnd.example.report+xml", "text/x-log"] } }).files, {
		enabled: true,
		maxMb: 200,
		maxTotalMb: 2048,
		allowTypes: ["application/pdf", "+json", "application/vnd.example.report+xml", "text/x-log"],
	});
	assert.deepEqual(parseSettings({ files: { enabled: true } }).files.allowTypes, [...DEFAULT_ALLOW_TYPES]);
	const many = Array.from({ length: LIMITS.MAX_FILE_TYPES }, (_, i) => `application/x-type-${i}`);
	assert.deepEqual(parseSettings({ files: { allow_types: many } }).files.allowTypes, many);
	assert.equal(Object.isFrozen(parseSettings({ files: { allow_types: ["text/plain"] } }).files.allowTypes), true);
});

test("files: strict - a typo, a wrong type or a value out of range stops the start", () => {
	/** @type {[unknown, RegExp][]} */
	const bad = [
		[{ files: null }, /files must be an object/],
		[{ files: [] }, /files must be an object/],
		[{ files: true }, /files must be an object/],
		[{ files: { enable: false } }, /unknown key "enable" in files/],
		[{ files: { max_bytes: 1000 } }, /unknown key "max_bytes" in files/],
		[{ files: { dir: "/srv/x" } }, /unknown key "dir" in files/],
		[{ files: { enabled: "no" } }, /files\.enabled must be true or false/],
		[{ files: { enabled: 0 } }, /files\.enabled must be true or false/],
		[{ files: { max_mb: 0 } }, /files\.max_mb must be an integer from 1 to 200/],
		[{ files: { max_mb: 201 } }, /files\.max_mb must be an integer from 1 to 200/],
		[{ files: { max_mb: 2.5 } }, /files\.max_mb must be an integer from 1 to 200/],
		[{ files: { max_mb: "25" } }, /files\.max_mb must be an integer from 1 to 200/],
		[{ files: { max_mb: -1 } }, /files\.max_mb/],
		[{ files: { max_total_mb: 0 } }, /files\.max_total_mb must be an integer from 1 to 1048576/],
		[{ files: { max_total_mb: 1048577 } }, /files\.max_total_mb must be an integer from 1 to 1048576/],
		[{ files: { max_total_mb: 10.5 } }, /files\.max_total_mb must be an integer from 1 to 1048576/],
		[{ files: { max_total_mb: "2048" } }, /files\.max_total_mb must be an integer/],
		[{ files: { max_total_mb: null } }, /files\.max_total_mb must be an integer/],
		// A file that may be retrieved must be one that can be stored: the whole is never smaller than one file.
		[{ files: { max_total_mb: 24 } }, /files\.max_total_mb \(24\) must not be smaller than files\.max_mb \(25\)/],
		[{ files: { max_mb: 100, max_total_mb: 99 } }, /files\.max_total_mb \(99\) must not be smaller than files\.max_mb \(100\)/],
		[{ files: { max_total: 100 } }, /unknown key "max_total" in files/],
		[{ files: { allow_types: "application/pdf" } }, /files\.allow_types must be an array/],
		[{ files: { allow_types: [1] } }, /files\.allow_types must be an array/],
		[{ files: { allow_types: ["Application/PDF"] } }, /lower-case media types/],
		[{ files: { allow_types: ["application/pdf; q=1"] } }, /files\.allow_types/],
		[{ files: { allow_types: ["*/*"] } }, /files\.allow_types/],
		[{ files: { allow_types: ["application/*"] } }, /files\.allow_types/],
		[{ files: { allow_types: ["pdf"] } }, /files\.allow_types/],
		[{ files: { allow_types: [".pdf"] } }, /files\.allow_types/],
		[{ files: { allow_types: ["+"] } }, /files\.allow_types/],
		[{ files: { allow_types: [""] } }, /files\.allow_types/],
		[{ files: { allow_types: ["application/pdf", "application/pdf"] } }, /different/],
		[{ files: { allow_types: Array.from({ length: LIMITS.MAX_FILE_TYPES + 1 }, (_, i) => `application/x-type-${i}`) } }, /at most 64/],
		// Pages are pages: listing them would not make them files, so it is said instead of ignored.
		[{ files: { allow_types: ["text/html"] } }, /cannot hold text\/html/],
		[{ files: { allow_types: ["application/pdf", "application/xhtml+xml"] } }, /those are pages/],
	];
	for (const [raw, pattern] of bad) {
		assert.throws(() => parseSettings(raw), (err) => err instanceof ConfigError && pattern.test(err.message), JSON.stringify(raw).slice(0, 80));
	}
});

test("pages: 2 GiB in all by default; the key is taken as written within its bounds, and nothing else is", () => {
	assert.deepEqual(defaultSettings().pages, { maxTotalMb: 2048 });
	assert.deepEqual(parseSettings({}).pages, { maxTotalMb: 2048 });
	assert.deepEqual(parseSettings({ pages: {} }).pages, { maxTotalMb: 2048 });
	assert.deepEqual({ ...PAGE_TOTAL_MB }, { fallback: 2048, min: 32, max: 1048576 });
	assert.equal(PAGE_TOTAL_MB.fallback * 1048576, PAGE_STORE.maxTotalBytes, "a store that is told nothing has the documented room");
	// The least: room for the largest page there can be, its files and its text in the index.
	assert.ok(PAGE_TOTAL_MB.min * 1048576 >= (1 + PAGE_STORE.indexShare) * LIMITS.MAX_RESULT_BYTES);
	for (const mb of [32, 500, 1048576]) assert.equal(parseSettings({ pages: { max_total_mb: mb } }).pages.maxTotalMb, mb);
	// It does not touch what the files may take, nor the other way round.
	assert.equal(parseSettings({ pages: { max_total_mb: 64 } }).files.maxTotalMb, 2048);
	assert.equal(parseSettings({ files: { max_total_mb: 64 } }).pages.maxTotalMb, 2048);

	/** @type {[unknown, RegExp][]} */
	const bad = [
		[{ pages: null }, /pages must be an object/],
		[{ pages: [] }, /pages must be an object/],
		[{ pages: 2048 }, /pages must be an object/],
		[{ pages: { max_mb: 100 } }, /unknown key "max_mb" in pages/],
		[{ pages: { max_total: 100 } }, /unknown key "max_total" in pages/],
		[{ pages: { max_total_mb: 31 } }, /pages\.max_total_mb must be an integer from 32 to 1048576/],
		[{ pages: { max_total_mb: 0 } }, /pages\.max_total_mb must be an integer from 32 to 1048576/],
		[{ pages: { max_total_mb: 1048577 } }, /pages\.max_total_mb must be an integer from 32 to 1048576/],
		[{ pages: { max_total_mb: 100.5 } }, /pages\.max_total_mb must be an integer from 32 to 1048576/],
		[{ pages: { max_total_mb: "2048" } }, /pages\.max_total_mb must be an integer/],
		[{ pages: { max_total_mb: null } }, /pages\.max_total_mb must be an integer/],
		[{ page: { max_total_mb: 100 } }, /unknown key "page" in the top level/],
		[{ store: { max_total_mb: 100 } }, /unknown key "store" in the top level/],
	];
	for (const [raw, message] of bad) {
		assert.throws(() => parseSettings(raw), (err) => err instanceof ConfigError && message.test(err.message), JSON.stringify(raw));
	}
});
