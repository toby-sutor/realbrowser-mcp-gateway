import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ATTENTION_ACTIONS,
	CLOSE,
	CLOSE_REASON,
	DETECT_RESOLUTIONS,
	DIRECTION,
	ERROR_CODE,
	EVENT_NAMES,
	EXTRACTION_VIEWS,
	HANDSHAKE_CORE_SINCE,
	LIMITS,
	MSG,
	OUTCOMES,
	PROTOCOL_VERSION,
	coreFrameVersion,
	makeMessage,
	validateMessage,
	zeroTimings,
} from "../../extension/shared/protocol.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { B64URL_32_PATTERN, INSTANCE_PATTERN, randomNonce } from "../../extension/shared/auth.js";
import { checkUrl, normalizeUrl } from "../../extension/shared/policy.js";
import { ALLOW_ENTRY_RE } from "../../extension/shared/sniff.js";
import { defaultState, makeResult } from "../helpers/fake-extension.js";

const { TO_DAEMON, TO_EXT } = DIRECTION;
const nonce = randomNonce();

const wait = { timeout_ms: 30000, settle_ms: 1500, dwell_ms: 2000, human_wait_ms: 0, scroll: "lazy" };
const extract = { markdown: true, text: true, html: false, raw_html: false, links: true, adapter: "auto" };
const extraction = { view: /** @type {const} */ ("article"), coverage_pct: 41, hidden_removed: 3, capped: false };
const jobStart = { job: "j_abc123", kind: "fetch", url: "https://example.com/a", session: "auto", wait, extract, files: null };

/**
 * One valid sample per message type, with the direction it travels.
 * @type {Record<string, { dir: string, fields: Record<string, any> }>}
 */
const SAMPLES = {
	[MSG.HELLO]: {
		dir: TO_DAEMON,
		fields: { mode: "auth", ext_version: "0.1.0", browser: { name: "Waterfox", version: "6.7.5" }, nonce_c: nonce },
	},
	[MSG.CHALLENGE]: { dir: TO_EXT, fields: { instance: "inst_0123456789ab", nonce_s: nonce, mac_s: nonce } },
	[MSG.AUTH]: { dir: TO_DAEMON, fields: { mac_c: nonce, state: defaultState() } },
	[MSG.READY]: { dir: TO_EXT, fields: { limits: { max_result_bytes: 8388608, ping_s: 20 } } },
	[MSG.JOB_START]: { dir: TO_EXT, fields: jobStart },
	[MSG.JOB_ACCEPTED]: { dir: TO_DAEMON, fields: { job: "j_abc123", cookie_scope: "container", rule: null } },
	[MSG.JOB_PROGRESS]: { dir: TO_DAEMON, fields: { job: "j_abc123", phase: "navigating", http_status: null } },
	[MSG.JOB_CANCEL]: { dir: TO_EXT, fields: { job: "j_abc123", reason: "deadline" } },
	[MSG.JOB_BLOB]: { dir: TO_DAEMON, fields: { job: "j_abc123", seq: 0, offset: 0, data: "JVBERi0xLjQK" } },
	[MSG.JOB_RESULT]: { dir: TO_DAEMON, fields: makeResult(jobStart, { extraction }) },
	[MSG.EVENT]: { dir: TO_DAEMON, fields: { name: "paused", host: null, job: null, state: defaultState(), detect: null } },
	[MSG.ATTENTION]: { dir: TO_EXT, fields: { job: "j_abc123", action: "focus" } },
	[MSG.PING]: { dir: TO_DAEMON, fields: { t: 1760000000000 } },
	[MSG.PONG]: { dir: TO_EXT, fields: { t: 1760000000000 } },
};

/**
 * @param {string} type
 * @param {(fields: Record<string, any>) => void} [mutate] applied to a deep copy of the sample
 * @returns {{ ok: boolean, error?: string }}
 */
function check(type, mutate) {
	const sample = SAMPLES[type];
	const fields = structuredClone(sample.fields);
	if (mutate) mutate(fields);
	return validateMessage(makeMessage(type, fields), sample.dir);
}

/**
 * @param {string} type
 * @param {(fields: Record<string, any>) => void} mutate
 * @param {string} label
 */
function rejects(type, mutate, label) {
	const r = check(type, mutate);
	assert.equal(r.ok, false, `${type}: ${label} should be rejected`);
	assert.equal(typeof r.error, "string");
}

test("the handshake core: hello and challenge keep their members from version 5 on, and are recognised across versions", () => {
	// Fixed since version 5. A later version that changes one of these lines has
	// cut itself off from every other: neither side could prove a mismatch to the other.
	assert.equal(HANDSHAKE_CORE_SINCE, 5);
	assert.ok(PROTOCOL_VERSION >= HANDSHAKE_CORE_SINCE);
	const hello = makeMessage(MSG.HELLO, SAMPLES[MSG.HELLO].fields);
	const challenge = makeMessage(MSG.CHALLENGE, SAMPLES[MSG.CHALLENGE].fields);
	assert.deepEqual(Object.keys(hello).sort(), ["browser", "ext_version", "mode", "nonce_c", "type", "v"]);
	assert.deepEqual(Object.keys(/** @type {Record<string, unknown>} */ (hello.browser)).sort(), ["name", "version"]);
	assert.deepEqual(Object.keys(challenge).sort(), ["instance", "mac_s", "nonce_s", "type", "v"]);
	assert.equal(hello.type, "hello");
	assert.equal(challenge.type, "challenge");

	// Of this version and of any later one: the version the frame states.
	for (const v of [PROTOCOL_VERSION, PROTOCOL_VERSION + 1, 6, 99, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
		assert.equal(coreFrameVersion({ ...hello, v }, MSG.HELLO, TO_DAEMON), v);
		assert.equal(coreFrameVersion({ ...challenge, v }, MSG.CHALLENGE, TO_EXT), v);
		// The strict check of a frame knows this version only, as before.
		assert.equal(validateMessage({ ...hello, v }, TO_DAEMON).ok, v === PROTOCOL_VERSION);
	}
	// From before the core, or no version at all.
	for (const v of [HANDSHAKE_CORE_SINCE - 1, 1, 0, -5, 5.5, 1e300, NaN, Infinity, "5", "6", null, undefined, true, [6]]) {
		assert.equal(coreFrameVersion({ ...hello, v }, MSG.HELLO, TO_DAEMON), null, String(v));
		assert.equal(coreFrameVersion({ ...challenge, v }, MSG.CHALLENGE, TO_EXT), null, String(v));
	}
	// Anything but the frame of the core, exactly: another type, the wrong direction, a member missing, added or malformed.
	const later = PROTOCOL_VERSION + 1;
	assert.equal(coreFrameVersion({ ...hello, v: later }, MSG.CHALLENGE, TO_EXT), null);
	assert.equal(coreFrameVersion({ ...challenge, v: later }, MSG.HELLO, TO_DAEMON), null);
	assert.equal(coreFrameVersion({ ...hello, v: later }, MSG.HELLO, TO_EXT), null);
	assert.equal(coreFrameVersion({ ...challenge, v: later }, MSG.CHALLENGE, TO_DAEMON), null);
	assert.equal(coreFrameVersion({ ...hello, v: later, versions: [5, 6] }, MSG.HELLO, TO_DAEMON), null);
	assert.equal(coreFrameVersion({ ...challenge, v: later, port: 8791 }, MSG.CHALLENGE, TO_EXT), null);
	assert.equal(coreFrameVersion({ ...hello, v: later, mode: "admin" }, MSG.HELLO, TO_DAEMON), null);
	assert.equal(coreFrameVersion({ ...hello, v: later, nonce_c: "short" }, MSG.HELLO, TO_DAEMON), null);
	assert.equal(coreFrameVersion({ ...challenge, v: later, mac_s: undefined }, MSG.CHALLENGE, TO_EXT), null);
	for (const other of [null, undefined, "hello", 5, [], [hello]]) assert.equal(coreFrameVersion(other, MSG.HELLO, TO_DAEMON), null);
	// It is for these two frames only: no other frame of another version is ever looked at.
	const ping = makeMessage(MSG.PING, { t: 1 });
	assert.equal(coreFrameVersion({ ...ping, v: later }, MSG.PING, TO_DAEMON), null);
	assert.equal(coreFrameVersion(makeMessage(MSG.AUTH, SAMPLES[MSG.AUTH].fields), MSG.AUTH, TO_DAEMON), null);
});

test("constants match appendix A", () => {
	assert.equal(PROTOCOL_VERSION, 5);
	assert.equal(CLOSE.AUTH_FAILED, 4001);
	assert.equal(CLOSE.ALREADY_CONNECTED, 4002);
	assert.equal(CLOSE.PROTOCOL_VERSION, 4003);
	assert.equal(CLOSE.NOT_PAIRED, 4004);
	assert.deepEqual(CLOSE_REASON, { 4001: "auth_failed", 4002: "already_connected", 4003: "protocol_version", 4004: "not_paired" });
	assert.deepEqual([...OUTCOMES], ["ok", "blocked", "needs_human", "timeout", "policy_blocked", "unsupported", "aborted", "error"]);
	assert.deepEqual(Object.values(MSG).sort(), Object.keys(SAMPLES).sort());
	assert.equal(LIMITS.MAX_RESULT_BYTES, 8388608);
	assert.equal(LIMITS.PING_S, 20);
	assert.deepEqual([...EXTRACTION_VIEWS], ["article", "full_page", "text"]);
	// The daemon throttles nothing: there is no "try again later" close code to act on.
	assert.equal(/** @type {number[]} */ (Object.values(CLOSE)).includes(1013), false);
	assert.equal("TRY_AGAIN_LATER" in CLOSE, false);
});

test("job.result: the visible text and the facts of the extraction", () => {
	// The text travels next to the Markdown, or not at all.
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.content.text = "everything the page shows")).ok, true);
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.content.text = "")).ok, true);
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.content.text = null)).ok, true);
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.content.text = "a".repeat(LIMITS.MAX_RESULT_BYTES))).ok, true);
	rejects(MSG.JOB_RESULT, (f) => (f.content.text = "a".repeat(LIMITS.MAX_RESULT_BYTES + 1)), "text over cap");
	for (const wrong of [5, true, {}, ["text"]]) rejects(MSG.JOB_RESULT, (f) => (f.content.text = wrong), `text=${JSON.stringify(wrong)}`);
	rejects(MSG.JOB_RESULT, (f) => delete f.content.text, "content without text");
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.truncated.text = true)).ok, true);
	for (const wrong of [null, "true", 0, 1, {}, []]) rejects(MSG.JOB_RESULT, (f) => (f.truncated.text = wrong), `truncated.text=${String(wrong)}`);
	rejects(MSG.JOB_RESULT, (f) => delete f.truncated.text, "truncated without text");

	// How the content was taken: one of three views, whole numbers in range, a flag. Nothing a page could write.
	for (const view of EXTRACTION_VIEWS) assert.equal(check(MSG.JOB_RESULT, (f) => (f.extraction.view = view)).ok, true, view);
	for (const wrong of ["Article", "full page", "fullpage", "raw", "", "article\nextraction: x", null, 1, ["article"]]) {
		rejects(MSG.JOB_RESULT, (f) => (f.extraction.view = wrong), `view=${JSON.stringify(wrong)}`);
	}
	for (const ok of [null, 0, 1, 50, 100]) assert.equal(check(MSG.JOB_RESULT, (f) => (f.extraction.coverage_pct = ok)).ok, true, String(ok));
	for (const wrong of [-1, 101, 41.5, 0.41, "41", "41%", NaN, Infinity, true, {}, []]) {
		rejects(MSG.JOB_RESULT, (f) => (f.extraction.coverage_pct = wrong), `coverage_pct=${String(wrong)}`);
	}
	for (const ok of [0, 17, LIMITS.MAX_HIDDEN_REMOVED]) assert.equal(check(MSG.JOB_RESULT, (f) => (f.extraction.hidden_removed = ok)).ok, true, String(ok));
	for (const wrong of [null, -1, 1.5, LIMITS.MAX_HIDDEN_REMOVED + 1, "3", NaN, {}, []]) {
		rejects(MSG.JOB_RESULT, (f) => (f.extraction.hidden_removed = wrong), `hidden_removed=${String(wrong)}`);
	}
	for (const wrong of [null, "false", 0, 1, {}, []]) rejects(MSG.JOB_RESULT, (f) => (f.extraction.capped = wrong), `capped=${String(wrong)}`);
	rejects(MSG.JOB_RESULT, (f) => (f.extraction.note = "from the page"), "extra member in extraction");
	rejects(MSG.JOB_RESULT, (f) => (f.extraction = {}), "empty extraction");
	for (const wrong of ["article", 5, []]) rejects(MSG.JOB_RESULT, (f) => (f.extraction = wrong), `extraction=${JSON.stringify(wrong)}`);
	rejects(MSG.JOB_RESULT, (f) => delete f.extraction, "result without extraction");
	// A result without a page has none.
	assert.equal(check(MSG.JOB_RESULT, (f) => Object.assign(f, { outcome: "error", page: null, content: null, extraction: null })).ok, true);
	assert.equal(LIMITS.MAX_HIDDEN_REMOVED, 1000000);

	// What a job asks for.
	assert.equal(check(MSG.JOB_START, (f) => (f.extract.text = false)).ok, true);
	rejects(MSG.JOB_START, (f) => delete f.extract.text, "extract without text");
	for (const wrong of [null, "true", 0, 1, {}, []]) rejects(MSG.JOB_START, (f) => (f.extract.text = wrong), `extract.text=${String(wrong)}`);
});

test("job.result: the page source, capped, and the job flag that asks for it", () => {
	assert.equal(LIMITS.MAX_RAW_HTML_CHARS, 4194304);
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.content.raw_html = "<!DOCTYPE html>\n<html></html>")).ok, true);
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.content.raw_html = null)).ok, true);
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.content.raw_html = "a".repeat(LIMITS.MAX_RAW_HTML_CHARS))).ok, true);
	rejects(MSG.JOB_RESULT, (f) => (f.content.raw_html = "a".repeat(LIMITS.MAX_RAW_HTML_CHARS + 1)), "raw_html over cap");
	for (const wrong of [5, true, {}, ["x"]]) rejects(MSG.JOB_RESULT, (f) => (f.content.raw_html = wrong), `raw_html=${JSON.stringify(wrong)}`);
	rejects(MSG.JOB_RESULT, (f) => delete f.content.raw_html, "content without raw_html");
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.truncated.raw_html = true)).ok, true);
	for (const wrong of [null, "true", 0, 1, {}, []]) rejects(MSG.JOB_RESULT, (f) => (f.truncated.raw_html = wrong), `truncated.raw_html=${String(wrong)}`);
	rejects(MSG.JOB_RESULT, (f) => delete f.truncated.raw_html, "truncated without raw_html");
	assert.equal(check(MSG.JOB_START, (f) => (f.extract.raw_html = true)).ok, true);
	rejects(MSG.JOB_START, (f) => delete f.extract.raw_html, "extract without raw_html");
	for (const wrong of [null, "true", 0, 1, {}, []]) rejects(MSG.JOB_START, (f) => (f.extract.raw_html = wrong), `extract.raw_html=${String(wrong)}`);
	// The page source is as big as the page: a frame of that size has to be fitted by the sender.
	assert.ok(LIMITS.MAX_RAW_HTML_CHARS < LIMITS.MAX_RESULT_BYTES);
});

test("every message type has a valid sample that passes", () => {
	for (const [type, sample] of Object.entries(SAMPLES)) {
		assert.deepEqual(validateMessage(makeMessage(type, sample.fields), sample.dir), { ok: true }, type);
	}
});

test("valid variants pass", () => {
	assert.equal(check(MSG.HELLO, (f) => (f.mode = "pair")).ok, true);
	assert.equal(check(MSG.JOB_START, (f) => (f.kind = "probe")).ok, true);
	assert.equal(check(MSG.JOB_START, (f) => (f.session = "isolated")).ok, true);
	assert.equal(
		check(MSG.JOB_START, (f) => {
			Object.assign(f, { kind: "search", url: "https://html.duckduckgo.com/html/?q=what+is+hkdf", engine: "duckduckgo", limit: 10 });
		}).ok,
		true,
	);
	assert.equal(check(MSG.JOB_ACCEPTED, (f) => Object.assign(f, { cookie_scope: "default", rule: { host: "reddit.com", path_prefix: "/r/", subdomains: false } })).ok, true);
	assert.equal(check(MSG.JOB_ACCEPTED, (f) => Object.assign(f, { cookie_scope: "default", rule: { host: "reddit.com", path_prefix: "/", subdomains: true } })).ok, true);
	assert.equal(check(MSG.JOB_PROGRESS, (f) => Object.assign(f, { phase: "challenge_wait", http_status: 403 })).ok, true);
	assert.equal(check(MSG.AUTH, (f) => Object.assign(f.state, { paused: true, pause_reason: "operator", slots: 0, optin_hosts: ["reddit.com"] })).ok, true);
	for (const name of EVENT_NAMES) {
		assert.equal(check(MSG.EVENT, (f) => Object.assign(f, { name, host: "example.com", job: "j_1" })).ok, true, name);
	}
	for (const outcome of OUTCOMES) assert.equal(check(MSG.JOB_RESULT, (f) => (f.outcome = outcome)).ok, true, outcome);
	// A job that never opened a tab reports nulls rather than made-up values.
	assert.equal(
		check(MSG.JOB_RESULT, (f) =>
			Object.assign(f, {
				outcome: "error",
				cookie_scope: null,
				nav: { requested_url: "https://example.com/a", final_url: null, redirect_origins: [], http_status: null, content_type: null, body_bytes: null },
				render: { visibility: null, raf_hz: null, settled: false, scrolled_px: 0, scroll: "off", dwell: "off", elapsed_ms: 0, timings: zeroTimings() },
				detect: { kind: "cloudflare_challenge", evidence: "cf-mitigated: challenge", waited_ms: 8000, resolved: null },
				error: { code: "nav_failed", message: "navigation failed", retryable: true, retry_after_s: 60 },
				page: null,
				content: null,
			}),
		).ok,
		true,
	);
	assert.equal(
		check(MSG.JOB_RESULT, (f) => {
			f.content.links = [{ url: "https://example.com/b", text: "b" }];
			f.content.results = [{ rank: 1, title: "t", url: "https://example.com/c", snippet: "s" }];
			f.nav.redirect_origins = ["https://example.com", "https://www.example.com"];
		}).ok,
		true,
	);
	// ping and pong travel both ways.
	assert.deepEqual(validateMessage(makeMessage(MSG.PING, { t: 1 }), TO_EXT), { ok: true });
	assert.deepEqual(validateMessage(makeMessage(MSG.PONG, { t: 1 }), TO_DAEMON), { ok: true });
});

test("the frame itself: version, type, shape, direction", () => {
	const hello = SAMPLES[MSG.HELLO].fields;
	/** @type {[unknown, string][]} */
	const bad = [
		[null, "null"],
		[undefined, "undefined"],
		["hello", "string"],
		[42, "number"],
		[[makeMessage(MSG.HELLO, hello)], "array"],
		[{ type: MSG.HELLO, ...hello }, "no version"],
		[{ ...makeMessage(MSG.HELLO, hello), v: PROTOCOL_VERSION + 1 }, "newer version"],
		[{ ...makeMessage(MSG.HELLO, hello), v: 0 }, "version 0"],
		[{ ...makeMessage(MSG.HELLO, hello), v: "1" }, "version as string"],
		[{ v: PROTOCOL_VERSION, ...hello }, "no type"],
		[{ ...makeMessage(MSG.HELLO, hello), type: 5 }, "numeric type"],
		[{ ...makeMessage(MSG.HELLO, hello), type: "hello2" }, "unknown type"],
		[{ ...makeMessage(MSG.HELLO, hello), type: "HELLO" }, "wrong case"],
		[{ ...makeMessage(MSG.HELLO, hello), type: "toString" }, "prototype member as type"],
		[{ ...makeMessage(MSG.HELLO, hello), type: "__proto__" }, "__proto__ as type"],
		[{ ...makeMessage(MSG.HELLO, hello), extra: 1 }, "extra top-level field"],
		[{ ...makeMessage(MSG.HELLO, hello), token: "x" }, "extra top-level junk"],
		[JSON.parse(`{"v":1,"type":"ping","t":1,"__proto__":{"x":1}}`), "__proto__ key"],
	];
	for (const [msg, label] of bad) assert.equal(validateMessage(msg, TO_DAEMON).ok, false, label);
	assert.equal(validateMessage(makeMessage(MSG.HELLO, hello), "sideways").ok, false);
	assert.equal(validateMessage(makeMessage(MSG.HELLO, hello), /** @type {any} */ (undefined)).ok, false);
});

test("a message is only valid in the direction it belongs to", () => {
	for (const [type, sample] of Object.entries(SAMPLES)) {
		if (type === MSG.PING || type === MSG.PONG) continue;
		const wrong = sample.dir === TO_DAEMON ? TO_EXT : TO_DAEMON;
		assert.equal(validateMessage(makeMessage(type, sample.fields), wrong).ok, false, type);
	}
});

test("every required field is required, at every level", () => {
	/**
	 * @param {any} node
	 * @param {string[]} path
	 * @returns {string[][]} paths of all object members
	 */
	const paths = (node, path = []) => {
		if (typeof node !== "object" || node === null || Array.isArray(node)) return [];
		return Object.keys(node).flatMap((key) => [[...path, key], ...paths(node[key], [...path, key])]);
	};
	let checked = 0;
	for (const [type, sample] of Object.entries(SAMPLES)) {
		for (const path of paths(sample.fields)) {
			rejects(
				type,
				(f) => {
					let node = f;
					for (const key of path.slice(0, -1)) node = node[key];
					delete node[path[path.length - 1]];
				},
				`missing ${path.join(".")}`,
			);
			rejects(
				type,
				(f) => {
					// Next to the field, in the object that holds it.
					let node = f;
					for (const key of path.slice(0, -1)) node = node[key];
					node.unexpected_member = 1;
				},
				`extra member next to ${path.join(".")}`,
			);
			checked += 1;
		}
	}
	assert.ok(checked > 80, `only ${checked} field paths were exercised`);
});

test("field types are enforced", () => {
	for (const wrong of [null, 5, true, {}, []]) {
		rejects(MSG.HELLO, (f) => (f.mode = wrong), `mode=${JSON.stringify(wrong)}`);
		rejects(MSG.HELLO, (f) => (f.nonce_c = wrong), `nonce_c=${JSON.stringify(wrong)}`);
		rejects(MSG.JOB_START, (f) => (f.url = wrong), `url=${JSON.stringify(wrong)}`);
		rejects(MSG.JOB_START, (f) => (f.job = wrong), `job=${JSON.stringify(wrong)}`);
	}
	for (const wrong of [null, "1", 1.5, -1, NaN, Infinity, {}, []]) {
		rejects(MSG.PING, (f) => (f.t = wrong), `t=${String(wrong)}`);
		rejects(MSG.AUTH, (f) => (f.state.slots = wrong), `slots=${String(wrong)}`);
		rejects(MSG.JOB_START, (f) => (f.wait.timeout_ms = wrong), `timeout_ms=${String(wrong)}`);
	}
	for (const wrong of [null, "true", 0, 1, {}, []]) {
		rejects(MSG.AUTH, (f) => (f.state.paused = wrong), `paused=${String(wrong)}`);
		rejects(MSG.JOB_START, (f) => (f.extract.markdown = wrong), `markdown=${String(wrong)}`);
		rejects(MSG.JOB_RESULT, (f) => (f.tab_kept_open = wrong), `tab_kept_open=${String(wrong)}`);
		rejects(MSG.JOB_RESULT, (f) => (f.truncated.html = wrong), `truncated.html=${String(wrong)}`);
	}
	for (const wrong of [null, "x", 5, []]) {
		rejects(MSG.HELLO, (f) => (f.browser = wrong), `browser=${String(wrong)}`);
		rejects(MSG.AUTH, (f) => (f.state = wrong), `state=${String(wrong)}`);
		rejects(MSG.AUTH, (f) => (f.state.container = wrong), `container=${String(wrong)}`);
		rejects(MSG.JOB_START, (f) => (f.wait = wrong), `wait=${String(wrong)}`);
		rejects(MSG.JOB_RESULT, (f) => (f.nav = wrong), `nav=${String(wrong)}`);
		rejects(MSG.JOB_RESULT, (f) => (f.render = wrong), `render=${String(wrong)}`);
		rejects(MSG.JOB_RESULT, (f) => (f.truncated = wrong), `truncated=${String(wrong)}`);
	}
	rejects(MSG.AUTH, (f) => (f.state.optin_hosts = "reddit.com"), "optin_hosts as string");
	rejects(MSG.AUTH, (f) => (f.state.optin_hosts = [5]), "optin_hosts with a number");
	rejects(MSG.JOB_RESULT, (f) => (f.nav.redirect_origins = "https://example.com"), "redirect_origins as string");
	rejects(MSG.JOB_RESULT, (f) => (f.content.links = [{ url: "https://example.com" }]), "link without text");
	rejects(MSG.JOB_RESULT, (f) => (f.content.links = ["https://example.com"]), "link as string");
	rejects(MSG.JOB_RESULT, (f) => (f.content.results = [{ rank: 0, title: "t", url: "u", snippet: "s" }]), "rank 0");
	rejects(MSG.JOB_RESULT, (f) => (f.render.raf_hz = "60"), "raf_hz as string");
	rejects(MSG.JOB_RESULT, (f) => (f.render.raf_hz = -1), "negative raf_hz");
	rejects(MSG.JOB_RESULT, (f) => (f.error = "boom"), "error as string");
	rejects(MSG.JOB_RESULT, (f) => (f.error = { code: "x" }), "incomplete error");
	rejects(MSG.JOB_RESULT, (f) => (f.detect = {}), "empty detect");
	rejects(MSG.JOB_RESULT, (f) => (f.detect = { kind: "cloudflare_challenge", evidence: "", waited_ms: 0 }), "detect without resolved");
});

test("enum values are enforced", () => {
	rejects(MSG.HELLO, (f) => (f.mode = "admin"), "mode");
	rejects(MSG.HELLO, (f) => (f.mode = "AUTH"), "mode case");
	rejects(MSG.JOB_START, (f) => (f.kind = "click"), "kind");
	rejects(MSG.JOB_START, (f) => (f.kind = "eval"), "kind");
	rejects(MSG.JOB_START, (f) => (f.session = "default"), "session");
	rejects(MSG.JOB_START, (f) => (f.session = "logged_in"), "session");
	rejects(MSG.JOB_START, (f) => (f.wait.scroll = "full"), "scroll");
	rejects(MSG.JOB_START, (f) => (f.extract.adapter = "custom"), "adapter");
	rejects(MSG.JOB_ACCEPTED, (f) => (f.cookie_scope = "none"), "cookie_scope");
	rejects(MSG.JOB_ACCEPTED, (f) => (f.cookie_scope = null), "cookie_scope null in accepted");
	rejects(MSG.JOB_PROGRESS, (f) => (f.phase = "clicking"), "phase");
	rejects(MSG.JOB_CANCEL, (f) => (f.reason = "bored"), "cancel reason");
	rejects(MSG.JOB_RESULT, (f) => (f.outcome = "success"), "outcome");
	rejects(MSG.JOB_RESULT, (f) => (f.outcome = "OK"), "outcome case");
	rejects(MSG.JOB_RESULT, (f) => (f.cookie_scope = "private"), "result cookie_scope");
	rejects(MSG.JOB_RESULT, (f) => (f.render.visibility = "prerender"), "visibility");
	rejects(MSG.EVENT, (f) => (f.name = "challenge.solved"), "event name");
	rejects(MSG.ATTENTION, (f) => (f.action = "click"), "attention action");
});

test("string formats and length caps are enforced", () => {
	// Nonces and MACs are exactly 43 base64url characters.
	for (const bad of ["", nonce.slice(1), nonce + "A", nonce.slice(0, 42) + "=", nonce.slice(0, 42) + "|", nonce.slice(0, 42) + "+"]) {
		rejects(MSG.HELLO, (f) => (f.nonce_c = bad), `nonce_c ${bad.length} chars`);
		rejects(MSG.CHALLENGE, (f) => (f.nonce_s = bad), `nonce_s ${bad.length} chars`);
		rejects(MSG.CHALLENGE, (f) => (f.mac_s = bad), `mac_s ${bad.length} chars`);
		rejects(MSG.AUTH, (f) => (f.mac_c = bad), `mac_c ${bad.length} chars`);
	}
	for (const bad of ["", "a".repeat(65), "has space", "semi;colon", "new\nline", "j/1", "j.1"]) {
		rejects(MSG.JOB_START, (f) => (f.job = bad), `job id ${JSON.stringify(bad).slice(0, 20)}`);
		rejects(MSG.JOB_RESULT, (f) => (f.job = bad), `result job id ${JSON.stringify(bad).slice(0, 20)}`);
	}
	assert.equal(check(MSG.JOB_START, (f) => (f.job = "a".repeat(64))).ok, true);

	const base = "https://example.com/";
	assert.equal(check(MSG.JOB_START, (f) => (f.url = base + "a".repeat(LIMITS.MAX_URL - base.length))).ok, true);
	rejects(MSG.JOB_START, (f) => (f.url = base + "a".repeat(LIMITS.MAX_URL - base.length + 1)), "url over 2048");
	rejects(MSG.JOB_START, (f) => (f.url = ""), "empty url");
	rejects(MSG.JOB_RESULT, (f) => (f.nav.requested_url = "a".repeat(LIMITS.MAX_URL + 1)), "requested_url over cap");
	rejects(MSG.JOB_RESULT, (f) => (f.nav.final_url = "a".repeat(LIMITS.MAX_FINAL_URL + 1)), "final_url over cap");
	rejects(MSG.JOB_RESULT, (f) => (f.nav.content_type = "a".repeat(201)), "content_type over cap");
	rejects(MSG.JOB_RESULT, (f) => (f.page.title = "a".repeat(1001)), "title over cap");
	rejects(MSG.JOB_RESULT, (f) => (f.error = { code: "Bad Code", message: "", retryable: false, retry_after_s: null }), "error code format");
	rejects(MSG.JOB_RESULT, (f) => (f.error = { code: "x", message: "m".repeat(501), retryable: false, retry_after_s: null }), "error message over cap");
	rejects(MSG.JOB_RESULT, (f) => (f.content.markdown = "a".repeat(LIMITS.MAX_RESULT_BYTES + 1)), "markdown over cap");

	rejects(MSG.HELLO, (f) => (f.ext_version = ""), "empty ext_version");
	rejects(MSG.HELLO, (f) => (f.ext_version = "1".repeat(33)), "ext_version over cap");
	rejects(MSG.HELLO, (f) => (f.ext_version = "1.0 beta"), "ext_version with a space");
	rejects(MSG.HELLO, (f) => (f.browser.name = "W".repeat(65)), "browser name over cap");
	rejects(MSG.AUTH, (f) => (f.state.pause_reason = "r".repeat(201)), "pause_reason over cap");
	rejects(MSG.AUTH, (f) => (f.state.optin_hosts = ["Reddit.com"]), "upper-case host");
	rejects(MSG.AUTH, (f) => (f.state.optin_hosts = ["reddit.com/r"]), "host with a path");
	rejects(MSG.EVENT, (f) => (f.host = "h".repeat(256)), "event host over cap");
	rejects(MSG.JOB_ACCEPTED, (f) => (f.rule = { host: "reddit.com", path_prefix: "r/", subdomains: false }), "rule path without a slash");
	rejects(MSG.JOB_ACCEPTED, (f) => (f.rule = { host: "reddit.com", path_prefix: "/r/" }), "rule that does not say whether subdomains are meant");
	rejects(MSG.JOB_ACCEPTED, (f) => (f.rule = { host: "reddit.com", path_prefix: "/r/", subdomains: "yes" }), "subdomains that is no boolean");
	rejects(MSG.JOB_ACCEPTED, (f) => (f.rule = { host: "reddit.com", path_prefix: `/${"a".repeat(256)}`, subdomains: false }), "rule path longer than a rule's may be");
});

test("the parts of the handshake MACs cannot contain the separator", () => {
	// mode, instance and both nonces are joined with "|" inside the MAC input.
	for (const bad of ["a|b", "|", "inst|auth", "abc|", "", "has space", "x".repeat(65), "caf\u00e9"]) {
		rejects(MSG.CHALLENGE, (f) => (f.instance = bad), `instance ${JSON.stringify(bad).slice(0, 20)}`);
	}
	assert.equal(check(MSG.CHALLENGE, (f) => (f.instance = "A-Za-z0-9_-")).ok, true);
	assert.equal(check(MSG.CHALLENGE, (f) => (f.instance = "x".repeat(64))).ok, true);
	const withPipe = nonce.slice(0, 20) + "|" + nonce.slice(21);
	assert.equal(withPipe.length, 43);
	rejects(MSG.HELLO, (f) => (f.nonce_c = withPipe), "nonce_c with a separator");
	rejects(MSG.CHALLENGE, (f) => (f.nonce_s = withPipe), "nonce_s with a separator");
	for (const bad of ["auth|pair", "pair|", "|auth"]) rejects(MSG.HELLO, (f) => (f.mode = bad), `mode ${bad}`);
});

test("number ranges and list sizes are enforced", () => {
	rejects(MSG.AUTH, (f) => (f.state.slots = LIMITS.MAX_SLOTS + 1), "slots over cap");
	rejects(MSG.AUTH, (f) => (f.state.policy_rev = -1), "negative policy_rev");
	rejects(MSG.AUTH, (f) => (f.state.optin_hosts = new Array(LIMITS.MAX_OPTIN_HOSTS + 1).fill("a.example")), "too many opt-in hosts");
	rejects(MSG.JOB_START, (f) => (f.wait.timeout_ms = 0), "timeout 0");
	rejects(MSG.JOB_START, (f) => (f.wait.timeout_ms = LIMITS.MAX_TIMEOUT_MS + 1), "timeout over cap");
	rejects(MSG.JOB_START, (f) => (f.wait.dwell_ms = -1), "negative dwell");
	rejects(MSG.JOB_PROGRESS, (f) => (f.http_status = 99), "http status 99");
	rejects(MSG.JOB_PROGRESS, (f) => (f.http_status = 600), "http status 600");
	rejects(MSG.JOB_RESULT, (f) => (f.nav.http_status = 0), "nav http status 0");
	rejects(MSG.JOB_RESULT, (f) => (f.render.scrolled_px = -5), "negative scroll");
	rejects(MSG.JOB_RESULT, (f) => (f.render.scroll = "skipped"), "a scroll result that is none of the enum");
	rejects(MSG.JOB_RESULT, (f) => (f.render.dwell = "cut_short_hidden"), "a dwell result that is none of the enum");
	rejects(MSG.JOB_RESULT, (f) => delete f.render.scroll, "no scroll result");
	rejects(MSG.JOB_RESULT, (f) => (f.render.dwell = null), "a null dwell result");
	for (const scroll of ["off", "done", "skipped_hidden", "cut_short_hidden"]) assert.equal(check(MSG.JOB_RESULT, (f) => (f.render.scroll = scroll)).ok, true, scroll);
	for (const dwell of ["off", "done", "skipped_hidden"]) assert.equal(check(MSG.JOB_RESULT, (f) => (f.render.dwell = dwell)).ok, true, dwell);
	rejects(MSG.JOB_RESULT, (f) => (f.nav.redirect_origins = new Array(LIMITS.MAX_REDIRECTS + 1).fill("https://example.com")), "too many redirects");
	rejects(MSG.JOB_RESULT, (f) => (f.content.links = new Array(LIMITS.MAX_LINKS + 1).fill({ url: "u", text: "t" })), "too many links");
	rejects(MSG.JOB_RESULT, (f) => (f.error = { code: "x", message: "", retryable: true, retry_after_s: -1 }), "negative retry_after_s");
	rejects(MSG.READY, (f) => (f.limits.ping_s = 0), "ping_s 0");
});

test("job.start carries either a URL or a search, never a mix", () => {
	const search = { engine: "duckduckgo", query: "q", limit: 5 };
	rejects(MSG.JOB_START, (f) => Object.assign(f, search), "fetch with search fields");
	rejects(MSG.JOB_START, (f) => Object.assign(f, { kind: "search", ...search }), "search with a url");
	rejects(MSG.JOB_START, (f) => (f.kind = "search"), "search without engine and query");
	rejects(
		MSG.JOB_START,
		(f) => {
			delete f.url;
			Object.assign(f, { kind: "search", ...search, limit: 0 });
		},
		"search limit 0",
	);
	rejects(
		MSG.JOB_START,
		(f) => {
			delete f.url;
			Object.assign(f, { kind: "search", ...search, engine: "Duck Duck" });
		},
		"engine format",
	);
});

test("validator errors name fields, never values", () => {
	const secretLooking = "S3CRET-" + "x".repeat(60);
	const r = check(MSG.HELLO, (f) => (f.nonce_c = secretLooking));
	assert.equal(r.ok, false);
	assert.ok(r.error && !r.error.includes("S3CRET"));
	const r2 = validateMessage({ ...makeMessage(MSG.PING, { t: 1 }), [secretLooking]: 1 }, TO_DAEMON);
	assert.equal(r2.ok, false);
	assert.ok(!r2.ok && !r2.error.includes("S3CRET"));
});

test("detect: what stood in the way, and how it went away", () => {
	const detect = { kind: "cloudflare_challenge", evidence: "header cf-mitigated=challenge", waited_ms: 8000, resolved: null };
	assert.deepEqual([...DETECT_RESOLUTIONS], ["cleared_by_waiting", "cleared_by_operator"]);
	for (const resolved of [null, ...DETECT_RESOLUTIONS]) assert.equal(check(MSG.JOB_RESULT, (f) => (f.detect = { ...detect, resolved })).ok, true, String(resolved));
	for (const wrong of ["solved", "cleared", "", 1, true, undefined]) rejects(MSG.JOB_RESULT, (f) => (f.detect = { ...detect, resolved: wrong }), `resolved=${String(wrong)}`);
	rejects(MSG.JOB_RESULT, (f) => (f.detect = { ...detect, solver: "x" }), "an extra field in detect");
	// challenge.pending says what the parked job ran into; every other event carries null.
	assert.equal(check(MSG.EVENT, (f) => Object.assign(f, { name: "challenge.pending", host: "example.com", job: "j_1", detect })).ok, true);
	assert.equal(check(MSG.EVENT, (f) => Object.assign(f, { name: "challenge.acked", host: "example.com", job: "j_1" })).ok, true);
	rejects(MSG.EVENT, (f) => delete f.detect, "an event without detect");
	rejects(MSG.EVENT, (f) => (f.detect = { kind: "x" }), "a partial detect on an event");
	rejects(MSG.EVENT, (f) => (f.detect = { ...detect, kind: "Not An Ident" }), "detect kind that is no identifier");
	rejects(MSG.EVENT, (f) => (f.detect = { ...detect, evidence: "e".repeat(501) }), "evidence over cap");
	// The daemon asks for the page of a parked job, or for another notification.
	for (const action of ATTENTION_ACTIONS) assert.equal(check(MSG.ATTENTION, (f) => (f.action = action)).ok, true, action);
	rejects(MSG.ATTENTION, (f) => (f.action = "click"), "an attention action that does something to a page");
	assert.equal(validateMessage(makeMessage(MSG.ATTENTION, { job: "j_1", action: "focus" }), DIRECTION.TO_DAEMON).ok, false, "attention only travels to the extension");
	assert.equal(validateMessage(makeMessage(MSG.EVENT, { name: "challenge.pending", host: null, job: "j_1", state: defaultState(), detect }), DIRECTION.TO_EXT).ok, false);
	// The daemon's own error codes for these jobs.
	for (const code of ["site_cooldown", "challenge_pending", "too_many_pending", "challenge_expired"]) assert.ok(/** @type {string[]} */ (Object.values(ERROR_CODE)).includes(code), code);
});

test("job.blob: a piece of a file - numbered, with its offset, whole groups of base64, bounded", () => {
	const full = Buffer.alloc(LIMITS.BLOB_CHUNK_BYTES, 0x61).toString("base64");
	assert.equal(full.length, LIMITS.MAX_BLOB_CHARS, "a full piece is exactly the longest text a frame may carry");
	assert.equal(LIMITS.MAX_BLOB_FRAMES, Math.ceil(LIMITS.MAX_FILE_BYTES / LIMITS.BLOB_CHUNK_BYTES), "enough frames for the largest file, and no more");
	assert.equal(LIMITS.MAX_FILE_BYTES, 200 * 1048576);
	assert.equal(check(MSG.JOB_BLOB).ok, true);
	assert.equal(check(MSG.JOB_BLOB, (f) => (f.data = full)).ok, true);
	assert.equal(check(MSG.JOB_BLOB, (f) => Object.assign(f, { seq: LIMITS.MAX_BLOB_FRAMES - 1, offset: LIMITS.MAX_FILE_BYTES })).ok, true);
	for (const data of ["QQ==", "QUI=", "QUJD", "+/+/", "QUJDRA=="]) assert.equal(check(MSG.JOB_BLOB, (f) => (f.data = data)).ok, true, data);
	/** @type {[string, (f: Record<string, any>) => void][]} */
	const bad = [
		["no data", (f) => delete f.data],
		["empty data", (f) => (f.data = "")],
		["data that is no string", (f) => (f.data = [1, 2, 3])],
		["a binary value", (f) => (f.data = { type: "Buffer", data: [1] })],
		["a group cut short", (f) => (f.data = "QUJ")],
		["five characters", (f) => (f.data = "QUJDR")],
		["padding in the middle", (f) => (f.data = "QQ==QQ==")],
		["three padding characters", (f) => (f.data = "Q===")],
		["only padding", (f) => (f.data = "====")],
		["the URL alphabet", (f) => (f.data = "QU-_")],
		["white space", (f) => (f.data = "QUJD\nQUJD")],
		["a character that is none", (f) => (f.data = "QUJ\u00e4")],
		["one group over the limit", (f) => (f.data = full + "QUJD")],
		["seq below 0", (f) => (f.seq = -1)],
		["seq beyond the last frame", (f) => (f.seq = LIMITS.MAX_BLOB_FRAMES)],
		["seq that is no integer", (f) => (f.seq = 1.5)],
		["seq as text", (f) => (f.seq = "0")],
		["offset below 0", (f) => (f.offset = -1)],
		["offset beyond the largest file", (f) => (f.offset = LIMITS.MAX_FILE_BYTES + 1)],
		["offset missing", (f) => delete f.offset],
		["no job", (f) => delete f.job],
		["a job id with a path in it", (f) => (f.job = "../j_1")],
		["an extra field", (f) => (f.name = "x.pdf")],
		["a path", (f) => (f.path = "/tmp/x")],
	];
	for (const [label, mutate] of bad) rejects(MSG.JOB_BLOB, mutate, label);
	// Only the extension sends one.
	assert.equal(validateMessage(makeMessage(MSG.JOB_BLOB, structuredClone(SAMPLES[MSG.JOB_BLOB].fields)), TO_EXT).ok, false);
});

test("job.start.files: what a job may bring back - a size and an allowlist, or nothing", () => {
	assert.equal(check(MSG.JOB_START, (f) => (f.files = { max_bytes: 26214400, types: ["application/pdf", "+json", "text/plain"] })).ok, true);
	assert.equal(check(MSG.JOB_START, (f) => (f.files = { max_bytes: 1, types: [] })).ok, true);
	assert.equal(check(MSG.JOB_START, (f) => (f.files = { max_bytes: LIMITS.MAX_FILE_BYTES, types: Array.from({ length: LIMITS.MAX_FILE_TYPES }, (_, i) => `application/x-type-${i}`) })).ok, true);
	assert.equal(check(MSG.JOB_START, (f) => (f.files = null)).ok, true);
	/** @type {[string, (f: Record<string, any>) => void][]} */
	const bad = [
		["files missing", (f) => delete f.files],
		["files true", (f) => (f.files = true)],
		["no size", (f) => (f.files = { types: [] })],
		["no types", (f) => (f.files = { max_bytes: 1000 })],
		["size 0", (f) => (f.files = { max_bytes: 0, types: [] })],
		["size beyond what the wire carries", (f) => (f.files = { max_bytes: LIMITS.MAX_FILE_BYTES + 1, types: [] })],
		["too many types", (f) => (f.files = { max_bytes: 1000, types: Array.from({ length: LIMITS.MAX_FILE_TYPES + 1 }, (_, i) => `application/x-type-${i}`) })],
		["a type in capitals", (f) => (f.files = { max_bytes: 1000, types: ["Application/PDF"] })],
		["a type with parameters", (f) => (f.files = { max_bytes: 1000, types: ["text/plain; charset=utf-8"] })],
		["a wildcard", (f) => (f.files = { max_bytes: 1000, types: ["*/*"] })],
		["a type that is none", (f) => (f.files = { max_bytes: 1000, types: ["pdf"] })],
		["a type that is no string", (f) => (f.files = { max_bytes: 1000, types: [null] })],
		["a directory to write to", (f) => (f.files = { max_bytes: 1000, types: [], dir: "/srv/x" })],
	];
	for (const [label, mutate] of bad) rejects(MSG.JOB_START, mutate, label);
	// A search carries the field too, and is held to the same shape.
	const search = { kind: "search", engine: "duckduckgo", limit: 5 };
	assert.equal(check(MSG.JOB_START, (f) => Object.assign(f, search)).ok, true);
	rejects(MSG.JOB_START, (f) => Object.assign(f, search, { files: "yes" }), "a search with files that are none");
});

test("job.result.file: the description of a file, and how much of a response was read", () => {
	const file = { name: "report.pdf", charset: null, size: 303, sha256: "a".repeat(64), chunks: 1 };
	/** @param {Record<string, any>} f */
	const asFile = (f) => Object.assign(f, { page: null, extraction: null, content: null, file: structuredClone(file) }, { nav: { ...f.nav, content_type: "application/pdf", body_bytes: 303 } });
	assert.equal(check(MSG.JOB_RESULT, asFile).ok, true);
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.file = null)).ok, true);
	assert.equal(check(MSG.JOB_RESULT, (f) => Object.assign(asFile(f).file, { name: null, charset: "iso-8859-1", size: 0, chunks: 0 })).ok, true);
	assert.equal(check(MSG.JOB_RESULT, (f) => Object.assign(asFile(f).file, { size: LIMITS.MAX_FILE_BYTES, chunks: LIMITS.MAX_BLOB_FRAMES, name: "n".repeat(LIMITS.MAX_FILE_NAME) })).ok, true);
	/** @type {[string, (file: Record<string, any>) => void][]} */
	const bad = [
		["no hash", (x) => delete x.sha256],
		["a short hash", (x) => (x.sha256 = "ab12")],
		["a hash in capitals", (x) => (x.sha256 = "A".repeat(64))],
		["a hash with other characters", (x) => (x.sha256 = "g".repeat(64))],
		["a negative size", (x) => (x.size = -1)],
		["a size beyond what the wire carries", (x) => (x.size = LIMITS.MAX_FILE_BYTES + 1)],
		["a size that is no integer", (x) => (x.size = 1.5)],
		["more frames than a file can take", (x) => (x.chunks = LIMITS.MAX_BLOB_FRAMES + 1)],
		["a name that is too long", (x) => (x.name = "n".repeat(LIMITS.MAX_FILE_NAME + 1))],
		["a name that is no string", (x) => (x.name = 7)],
		["a charset with a space", (x) => (x.charset = "utf 8")],
		["a charset in capitals", (x) => (x.charset = "UTF-8")],
		["an empty charset", (x) => (x.charset = "")],
		["a path to write to", (x) => (x.path = "/srv/x/report.pdf")],
		["the bytes themselves", (x) => (x.data = "JVBERi0=")],
		["a type of its own", (x) => (x.type = "application/pdf")],
	];
	for (const [label, mutate] of bad) rejects(MSG.JOB_RESULT, (f) => mutate(asFile(f).file), label);
	rejects(MSG.JOB_RESULT, (f) => delete f.file, "file missing");
	rejects(MSG.JOB_RESULT, (f) => (f.file = "report.pdf"), "file as text");
	// How much was read: a count, or null where nothing was captured.
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.nav.body_bytes = 0)).ok, true);
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.nav.body_bytes = LIMITS.MAX_FILE_BYTES + 131072)).ok, true, "the piece that crossed the limit is counted");
	rejects(MSG.JOB_RESULT, (f) => delete f.nav.body_bytes, "body_bytes missing");
	rejects(MSG.JOB_RESULT, (f) => (f.nav.body_bytes = -1), "negative body_bytes");
	rejects(MSG.JOB_RESULT, (f) => (f.nav.body_bytes = "303"), "body_bytes as text");
	rejects(MSG.JOB_RESULT, (f) => (f.nav.body_bytes = 2 ** 40), "body_bytes beyond any file");
	// The phase that says a file is arriving.
	assert.equal(check(MSG.JOB_PROGRESS, (f) => (f.phase = "receiving_file")).ok, true);
	rejects(MSG.JOB_PROGRESS, (f) => (f.phase = "downloading"), "a phase that is none");
});

test("job.start.url: what the URL check writes out, and nothing with a control character, a space or a letter outside ASCII", () => {
	// Whatever the daemon's check lets through, it hands on in this form.
	const asked = [
		"https://example.com/",
		"HTTPS://Example.COM./a/../b?q=1#frag",
		"http://example.org:8080/a%20b?x=%00",
		"https://example.com/Zürich/straße?stadt=Köln#über",
		"https://bücher.example/",
		"https://example.com/a b",
		"https://example.com/?q=a b&r=\"quoted\"",
		"https://example.com/#a b`c<d>",
		"https://example.com/\u00a0\u2028\ufeff",
		"https://example.com/%",
		"https://[2606:4700:4700::1111]/",
		`https://example.com/${"a".repeat(1900)}`,
	];
	let fit = 0;
	for (const url of asked) {
		const n = normalizeUrl(url);
		// The check refuses spaces and control characters as they are asked for; what it passes it writes out encoded.
		if (!n.ok) continue;
		fit += 1;
		assert.match(n.url, /^https?:\/\/[!-~]+$/, url);
		assert.equal(check(MSG.JOB_START, (f) => (f.url = n.url)).ok, true, url);
		assert.equal(check(MSG.JOB_START, (f) => Object.assign(f, { kind: "search", engine: "duckduckgo", limit: 5, url: n.url })).ok, true, url);
		assert.equal(checkUrl(url).allowed ? checkUrl(n.url).allowed : true, true);
	}
	assert.ok(fit >= 8, "most of these are let through");
	/** @type {[string, string][]} */
	const bad = [
		["a newline", "https://example.com/a\nb"],
		["a carriage return", "https://example.com/a\rb"],
		["a tab", "https://example.com/a\tb"],
		["a NUL", "https://example.com/\u0000"],
		["an escape character", "https://example.com/\u001b[2J"],
		["a DEL", "https://example.com/\u007f"],
		["a space", "https://example.com/a b"],
		["a space in front", " https://example.com/"],
		["a line break at the end", "https://example.com/\n"],
		["a C1 control", "https://example.com/\u0085"],
		["a no-break space", "https://example.com/\u00a0"],
		["a line separator", "https://example.com/\u2028"],
		["a letter outside ASCII", "https://example.com/Zürich"],
		["a right-to-left override", "https://example.com/\u202egnp.exe"],
		["nothing", ""],
	];
	for (const [label, url] of bad) {
		rejects(MSG.JOB_START, (f) => (f.url = url), label);
		rejects(MSG.JOB_START, (f) => Object.assign(f, { kind: "search", engine: "duckduckgo", limit: 5, url }), `a search with ${label}`);
	}
	// Which addresses a job may load is the URL check's matter, not the frame's: the extension answers
	// these with a result that names the reason.
	for (const url of ["file:///etc/passwd", "about:config", "http://127.0.0.1:8791/v1/status", "https://mail.google.com/"]) assert.equal(check(MSG.JOB_START, (f) => (f.url = url)).ok, true, url);
	// The error names the field, never the address.
	const r = check(MSG.JOB_START, (f) => (f.url = "https://example.com/secret\npath"));
	assert.equal(r.error, "job.start.url: bad format");
});

test("job.result: the links of a page are web addresses, like the results of a search", () => {
	/** @param {string} url */
	const withLink = (url) => check(MSG.JOB_RESULT, (f) => (f.content.links = [{ url, text: "a link" }]));
	for (const url of ["https://example.com/", "http://example.org/a?b#c", "HTTPS://EXAMPLE.COM/", `https://example.com/${"a".repeat(LIMITS.MAX_FINAL_URL - 20)}`]) assert.equal(withLink(url).ok, true, url.slice(0, 40));
	for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "mailto:someone", "ftp://example.com/", "//example.com/", "/relative", "example.com", " https://example.com/", "", "about:blank", "blob:https://example.com/1"]) {
		const r = withLink(url);
		assert.equal(r.ok, false, url);
		assert.equal(r.error, "job.result.content.links[0].url: bad format");
	}
	rejects(MSG.JOB_RESULT, (f) => (f.content.links = [{ url: `https://example.com/${"a".repeat(LIMITS.MAX_FINAL_URL)}`, text: "" }]), "a link longer than the cap");
	// The same holds for a result of a search, as before.
	rejects(MSG.JOB_RESULT, (f) => (f.content.results = [{ rank: 1, title: "A script", url: "javascript:alert(1)", snippet: "" }]), "a result that is no web address");
	// The extension passes on no other link: what its content script hands it is filtered by this very test.
	const jobs = fs.readFileSync(fileURLToPath(new URL("../../extension/background/jobs.js", import.meta.url)), "utf8");
	assert.match(jobs, /function isWebUrl\(url\) \{\n\treturn typeof url === "string" && \/\^https\?:\\\/\\\/\/i\.test\(url\);\n\}/);
	assert.match(jobs, /link\.url\.length > LIMITS\.MAX_FINAL_URL \|\| !isWebUrl\(link\.url\)\) continue;/);
});

// Tables that are written out in more than one file, because a content script cannot import and because
// the handshake has a file of its own. Each copy is compared with the one the frames are checked by.
test("copies of the protocol's numbers and patterns in other files say the same", () => {
	/** @param {string} file @returns {string} */
	const source = (file) => fs.readFileSync(fileURLToPath(new URL(`../../extension/${file}`, import.meta.url)), "utf8");
	/** @param {string} text @param {RegExp} head @returns {Record<string, number>} the numbers of an object literal */
	const numbers = (text, head) => {
		const m = head.exec(text);
		assert.ok(m !== null, String(head));
		return Object.fromEntries([...m[1].matchAll(/([A-Za-z]+):\s*([0-9]+)/g)].map((x) => [x[1], Number(x[2])]));
	};

	// The extractor: how long each part of a result may be.
	const cap = numbers(source("content/extract.js"), /\n\tconst CAP = \{([^}]*)\};/);
	assert.deepEqual(Object.keys(cap).sort(), ["author", "extractor", "lang", "linkText", "linkUrl", "links", "published", "rawHtmlChars", "resultChars", "site", "title"]);
	assert.deepEqual([cap.linkUrl, cap.links, cap.resultChars, cap.rawHtmlChars], [LIMITS.MAX_FINAL_URL, LIMITS.MAX_LINKS, LIMITS.MAX_RESULT_BYTES, LIMITS.MAX_RAW_HTML_CHARS]);
	// The parts of "page" have no named limit: each is as long as the frame check takes it, and not one character longer.
	for (const field of ["title", "author", "published", "lang", "site", "extractor"]) {
		assert.equal(check(MSG.JOB_RESULT, (f) => (f.page[field] = "x".repeat(cap[field]))).ok, true, field);
		assert.equal(check(MSG.JOB_RESULT, (f) => (f.page[field] = "x".repeat(cap[field] + 1))).ok, false, field);
	}
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.content.links = [{ url: "https://example.com/", text: "x".repeat(cap.linkText) }])).ok, true);
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.content.links = [{ url: "https://example.com/", text: "x".repeat(cap.linkText + 1) }])).ok, false);
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.content.links = [{ url: `https://example.com/${"a".repeat(cap.linkUrl - 20)}`, text: "" }])).ok, true);
	assert.equal(check(MSG.JOB_RESULT, (f) => (f.content.links = [{ url: `https://example.com/${"a".repeat(cap.linkUrl - 19)}`, text: "" }])).ok, false);

	// The reader of results pages.
	const searchCap = numbers(source("content/search.js"), /\n\tconst CAP = \{([^}]*)\};/);
	assert.deepEqual(searchCap, { title: LIMITS.MAX_RESULT_TITLE, snippet: LIMITS.MAX_RESULT_SNIPPET, url: LIMITS.MAX_URL, results: LIMITS.MAX_RESULTS });

	// An entry of the allowlist of file types: one pattern in sniff.js, which config.json is held to, one in the frame check.
	const protocol = source("shared/protocol.js");
	const entry = /const fileTypeEntry = str\((\d+), \{ min: (\d+), pattern: \/(.+)\/ \}\);/.exec(protocol);
	assert.ok(entry !== null, "the frame check's pattern for a type was found");
	assert.equal(entry[3], ALLOW_ENTRY_RE.source);
	const longest = [`+${"a".repeat(40)}`, `${"a".repeat(60)}/${"b".repeat(120)}`];
	for (const type of ["application/pdf", "+json", "text/plain", "a/b", "+x", "image/svg+xml", "application/vnd.ms-excel", ...longest, "", "pdf", "+", "text/", "/plain", "Text/plain", "text/plain; charset=utf-8", "*/*", "a/b/c", `+${"a".repeat(41)}`, `${"a".repeat(61)}/b`, `a/${"b".repeat(121)}`]) {
		assert.equal(check(MSG.JOB_START, (f) => (f.files = { max_bytes: 1000, types: [type] })).ok, ALLOW_ENTRY_RE.test(type), JSON.stringify(type));
	}
	assert.ok(longest.every((type) => type.length <= Number(entry[1]) && type.length >= Number(entry[2])), "the length the frame check allows holds the longest entry the pattern takes");

	// The handshake: a nonce or a MAC, and the daemon's instance id, as auth.js takes them and as the frames are checked.
	const b64 = /const b64u32 = str\(43, \{ min: 43, pattern: \/(.+)\/ \}\);/.exec(protocol);
	assert.ok(b64 !== null, "the frame check's pattern for 32 bytes was found");
	assert.equal(b64[1], B64URL_32_PATTERN.source);
	const instance = /fields: obj\(\{ instance: str\((\d+), \{ min: (\d+), pattern: \/(.+?)\/ \}\), nonce_s: b64u32, mac_s: b64u32 \}\)/.exec(protocol);
	assert.ok(instance !== null, "the frame check's pattern for the instance id was found");
	const same = "A".repeat(43);
	for (const value of [same, nonce, "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}+`, `${"a".repeat(42)}/`, `${"a".repeat(42)}|`, `${"a".repeat(42)}\n`, ""]) {
		assert.equal(check(MSG.HELLO, (f) => (f.nonce_c = value)).ok, B64URL_32_PATTERN.test(value), JSON.stringify(value));
		assert.equal(check(MSG.CHALLENGE, (f) => (f.mac_s = value)).ok, B64URL_32_PATTERN.test(value), JSON.stringify(value));
	}
	for (const value of ["a", "inst_0123456789ab", "A-b_9", "a".repeat(64), "a".repeat(65), "", "a|b", "a b", "a.b", "a\n", "ä"]) {
		assert.equal(check(MSG.CHALLENGE, (f) => (f.instance = value)).ok, INSTANCE_PATTERN.test(value), JSON.stringify(value));
	}
});
