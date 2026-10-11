import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import {
	B64URL_32_PATTERN,
	b64urlDecode,
	b64urlEncode,
	computeMacC,
	computeMacS,
	deriveExtKey,
	formatPairingCode,
	generatePairingCode,
	hkdfSha256,
	hmacSha256,
	macMatches,
	pairingKey,
	parsePairingCode,
	randomBytes,
	randomNonce,
	timingSafeEqual,
	utf8,
} from "../../extension/shared/auth.js";

/** @param {string} hex */
const fromHex = (hex) => new Uint8Array(Buffer.from(hex, "hex"));
/** @param {Uint8Array} bytes */
const toHex = (bytes) => Buffer.from(bytes).toString("hex");

test("base64url: RFC 4648 vectors, unpadded", () => {
	/** @type {[string, string][]} */
	const table = [
		["", ""],
		["f", "Zg"],
		["fo", "Zm8"],
		["foo", "Zm9v"],
		["foob", "Zm9vYg"],
		["fooba", "Zm9vYmE"],
		["foobar", "Zm9vYmFy"],
	];
	for (const [text, encoded] of table) {
		assert.equal(b64urlEncode(utf8(text)), encoded);
		assert.deepEqual(b64urlDecode(encoded), utf8(text));
	}
	// The two characters that differ from standard base64.
	assert.equal(b64urlEncode(fromHex("fbff")), "-_8");
	assert.deepEqual(b64urlDecode("-_8"), fromHex("fbff"));
});

test("base64url: round trips for every length and agrees with Node", () => {
	for (let n = 0; n <= 70; n++) {
		const bytes = randomBytes(n);
		const text = b64urlEncode(bytes);
		assert.equal(text, Buffer.from(bytes).toString("base64url"), `length ${n}`);
		assert.deepEqual(b64urlDecode(text), bytes, `length ${n}`);
		assert.doesNotMatch(text, /[=+/]/);
	}
	const all = new Uint8Array(256).map((_, i) => i);
	assert.deepEqual(b64urlDecode(b64urlEncode(all)), all);
});

test("base64url: strict decoding", () => {
	for (const bad of [
		"Zg==",
		"Zm8=",
		"Z",
		"Zm9vY",
		"Zm9v\n",
		" Zm9v",
		"Zm9v ",
		"Zm+v",
		"Zm/v",
		"Zm9é",
		"Zm9v.",
		// Non-zero trailing bits: a second spelling of the same bytes.
		"Zh",
		"Zm9",
		null,
		undefined,
		5,
		["Zg"],
	]) {
		assert.equal(b64urlDecode(bad), null, String(bad));
	}
});

test("randomNonce: 32 bytes of base64url, never repeated", () => {
	const seen = new Set();
	for (let i = 0; i < 200; i++) {
		const n = randomNonce();
		assert.match(n, B64URL_32_PATTERN);
		assert.equal(b64urlDecode(n)?.length, 32);
		seen.add(n);
	}
	assert.equal(seen.size, 200);
	assert.equal(randomBytes(32).length, 32);
	assert.notDeepEqual(randomBytes(32), new Uint8Array(32));
});

test("HMAC-SHA256: RFC 4231 test vectors", async () => {
	/** @type {{ key: string, data: string, mac: string, truncate?: number }[]} */
	const cases = [
		{
			key: "0b".repeat(20),
			data: Buffer.from("Hi There").toString("hex"),
			mac: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
		},
		{
			key: Buffer.from("Jefe").toString("hex"),
			data: Buffer.from("what do ya want for nothing?").toString("hex"),
			mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
		},
		{
			key: "aa".repeat(20),
			data: "dd".repeat(50),
			mac: "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
		},
		{
			key: "0102030405060708090a0b0c0d0e0f10111213141516171819",
			data: "cd".repeat(50),
			mac: "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b",
		},
		{
			key: "0c".repeat(20),
			data: Buffer.from("Test With Truncation").toString("hex"),
			mac: "a3b6167473100ee06e0c796c2955552b",
			truncate: 16,
		},
		{
			key: "aa".repeat(131),
			data: Buffer.from("Test Using Larger Than Block-Size Key - Hash Key First").toString("hex"),
			mac: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
		},
		{
			key: "aa".repeat(131),
			data: Buffer.from(
				"This is a test using a larger than block-size key and a larger than block-size data. " +
					"The key needs to be hashed before being used by the HMAC algorithm.",
			).toString("hex"),
			mac: "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
		},
	];
	for (const [i, c] of cases.entries()) {
		const mac = await hmacSha256(fromHex(c.key), fromHex(c.data));
		assert.equal(mac.length, 32);
		assert.equal(toHex(mac.subarray(0, c.truncate ?? 32)), c.mac, `RFC 4231 test case ${i + 1}`);
	}
});

test("HMAC-SHA256: string data is UTF-8, empty key is refused", async () => {
	const key = fromHex("0b".repeat(20));
	assert.deepEqual(await hmacSha256(key, "Hi There"), await hmacSha256(key, utf8("Hi There")));
	assert.equal(
		toHex(await hmacSha256(key, "grüße")),
		nodeCrypto.createHmac("sha256", key).update("grüße", "utf8").digest("hex"),
	);
	await assert.rejects(hmacSha256(new Uint8Array(0), "x"), TypeError);
});

test("HKDF-SHA256: RFC 5869 test vectors", async () => {
	const cases = [
		{
			ikm: "0b".repeat(22),
			salt: "000102030405060708090a0b0c",
			info: "f0f1f2f3f4f5f6f7f8f9",
			length: 42,
			okm: "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
		},
		{
			ikm: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f",
			salt: "606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
			info: "b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff",
			length: 82,
			okm: "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87",
		},
		{
			ikm: "0b".repeat(22),
			salt: "",
			info: "",
			length: 42,
			okm: "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
		},
	];
	for (const [i, c] of cases.entries()) {
		const okm = await hkdfSha256(fromHex(c.ikm), fromHex(c.salt), fromHex(c.info), c.length);
		assert.equal(toHex(okm), c.okm, `RFC 5869 test case ${i + 1}`);
	}
});

test("timingSafeEqual", () => {
	assert.equal(timingSafeEqual(fromHex("00ff10"), fromHex("00ff10")), true);
	assert.equal(timingSafeEqual(fromHex("00ff10"), fromHex("00ff11")), false);
	assert.equal(timingSafeEqual(fromHex("80ff10"), fromHex("00ff10")), false);
	assert.equal(timingSafeEqual(fromHex("00ff10"), fromHex("00ff")), false);
	assert.equal(timingSafeEqual(fromHex(""), fromHex("")), true);
});

/** A transcript's parts that a test is not about: an auth-mode handshake on the default port between two sides of version 5. */
const GOOD = /** @type {Readonly<Omit<import("../../extension/shared/auth.js").Transcript, "nonceC" | "nonceS">>} */ (Object.freeze({ mode: "auth", port: 8791, versionC: 5, versionS: 5, instance: "inst_0123456789ab" }));

test("handshake MACs: exact constructions from the protocol", async () => {
	const key = fromHex("11".repeat(32));
	const nonceC = b64urlEncode(fromHex("c1".repeat(32)));
	const nonceS = b64urlEncode(fromHex("5e".repeat(32)));
	const instance = "inst_0123456789ab";
	/** @param {string} text */
	const reference = (text) => nodeCrypto.createHmac("sha256", key).update(text, "utf8").digest("hex");

	for (const mode of /** @type {const} */ (["auth", "pair"])) {
		for (const port of [1, 80, 8791, 40123, 65535]) {
			for (const [versionC, versionS] of [[5, 5], [5, 6], [6, 5], [12, 345], [5, Number.MAX_SAFE_INTEGER]]) {
				const t = { mode, port, versionC, versionS, instance, nonceC, nonceS };
				assert.equal(toHex(await computeMacS(key, t)), reference(`bgw1|s|${mode}|${port}|${versionC}|${versionS}|${instance}|${nonceC}|${nonceS}`));
				assert.equal(toHex(await computeMacC(key, t)), reference(`bgw1|c|${mode}|${port}|${versionC}|${versionS}|${instance}|${nonceS}|${nonceC}`));
			}
		}
	}
	// The two proofs can never stand in for each other, even with equal nonces and equal versions.
	const same = { ...GOOD, instance, nonceC, nonceS: nonceC };
	assert.notDeepEqual(await computeMacS(key, same), await computeMacC(key, same));
	const t = { ...GOOD, instance, nonceC, nonceS };
	assert.notDeepEqual(await computeMacS(key, t), await computeMacS(key, { ...t, nonceC: nonceS, nonceS: nonceC }));
});

test("handshake MACs: fixed vectors", async () => {
	// Worked out with another HMAC implementation (Python's hmac), not with this
	// code: key 32 bytes of 0x11, nonce_c 32 bytes of 0xc1, nonce_s 32 bytes of
	// 0x5e. From protocol version 5 on this form is part of the handshake core:
	// a change to the MAC input - the order of the parts, the separator, the
	// spelling of a number - shows here, and it would cut every other version
	// off from telling a version mismatch.
	const key = fromHex("11".repeat(32));
	const t = { instance: "inst_0123456789ab", nonceC: b64urlEncode(fromHex("c1".repeat(32))), nonceS: b64urlEncode(fromHex("5e".repeat(32))) };
	assert.equal(t.nonceC, "wcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcE");
	assert.equal(t.nonceS, "Xl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl4");
	const same = { versionC: 5, versionS: 5 };
	assert.equal(toHex(await computeMacS(key, { ...t, ...same, mode: "auth", port: 8791 })), "425184e4aaaa2ba805d210440063a0ada5f0d692e321e0d46a2ddfac8c99ea68");
	assert.equal(toHex(await computeMacC(key, { ...t, ...same, mode: "auth", port: 8791 })), "4e1edda6c6ed438594a619c47300827d89318dd2825ccf80867b6bc6652461ab");
	assert.equal(toHex(await computeMacS(key, { ...t, ...same, mode: "pair", port: 8791 })), "87bb255914f2d1380859a7270a31d0098b19921e463803c2468f507036f68a3b");
	assert.equal(toHex(await computeMacC(key, { ...t, ...same, mode: "pair", port: 8791 })), "87bd6c1e20b70cd345da59d87dce14da08f549d8355153c59edd290702c3f3fb");
	assert.equal(toHex(await computeMacS(key, { ...t, ...same, mode: "auth", port: 8792 })), "45832cb27ca05db36cb6ff53523125bac4ef335387a0e9fb30101cdbd4a2ccf9");
	assert.equal(toHex(await computeMacC(key, { ...t, ...same, mode: "auth", port: 8792 })), "cd6dfbf33165829a8eb5cbe568a48016d71a535e03972c656f456a2212008df5");
	// What a daemon of version 6 proves to an extension of version 5, and a daemon of version 5 to an extension of version 6.
	assert.equal(toHex(await computeMacS(key, { ...t, versionC: 5, versionS: 6, mode: "auth", port: 8791 })), "18df70f4cd234f085644f008e895ee954cc8326a8649e360e8c646cfb438feea");
	assert.equal(toHex(await computeMacS(key, { ...t, versionC: 6, versionS: 5, mode: "auth", port: 8791 })), "fe1fac5b1f8259b70c0bdb6af54c8ec6c9b251ce574f813a2c306d5e7cc50ad8");
});

test("handshake MACs: bound to the mode - a pair-mode MAC does not verify in auth mode", async () => {
	// Same key, same port, same versions, same instance, same nonces: only the mode differs.
	const key = fromHex("11".repeat(32));
	const base = { ...GOOD, nonceC: randomNonce(), nonceS: randomNonce() };
	const pair = { ...base, mode: /** @type {const} */ ("pair") };
	const auth = { ...base, mode: /** @type {const} */ ("auth") };

	const pairMacS = await computeMacS(key, pair);
	const pairMacC = await computeMacC(key, pair);
	assert.equal(macMatches(await computeMacS(key, pair), b64urlEncode(pairMacS)), true);
	assert.equal(macMatches(await computeMacS(key, auth), b64urlEncode(pairMacS)), false, "daemon proof for pair presented in auth mode");
	assert.equal(macMatches(await computeMacC(key, auth), b64urlEncode(pairMacC)), false, "extension proof for pair presented in auth mode");
	assert.equal(macMatches(await computeMacC(key, pair), b64urlEncode(await computeMacC(key, auth))), false, "and the other way round");
});

test("handshake MACs: bound to the port, in both directions and both modes", async () => {
	// Same key, same mode, same versions, same instance, same nonces: only the port differs.
	const key = fromHex("11".repeat(32));
	for (const mode of /** @type {const} */ (["auth", "pair"])) {
		const dialled = { ...GOOD, mode, port: 8791, nonceC: randomNonce(), nonceS: randomNonce() };
		assert.equal(macMatches(await computeMacS(key, dialled), b64urlEncode(await computeMacS(key, dialled))), true);
		assert.equal(macMatches(await computeMacC(key, dialled), b64urlEncode(await computeMacC(key, dialled))), true);
		for (const port of [8792, 8790, 879, 18791, 1, 65535]) {
			const elsewhere = { ...dialled, port };
			assert.equal(macMatches(await computeMacS(key, dialled), b64urlEncode(await computeMacS(key, elsewhere))), false, `daemon proof for port ${port} presented on 8791 (${mode})`);
			assert.equal(macMatches(await computeMacC(key, elsewhere), b64urlEncode(await computeMacC(key, dialled))), false, `extension proof for 8791 presented on port ${port} (${mode})`);
		}
	}
});

test("handshake MACs: bound to the versions of both sides - a version changed on the way makes the proof wrong", async () => {
	const key = fromHex("11".repeat(32));
	for (const mode of /** @type {const} */ (["auth", "pair"])) {
		// What was said: a hello of version 5, a challenge of version 5.
		const said = { ...GOOD, mode, versionC: 5, versionS: 5, nonceC: randomNonce(), nonceS: randomNonce() };
		// What one side would reckon with had a version field been rewritten between them.
		for (const [versionC, versionS] of [[6, 5], [5, 6], [6, 6], [4, 5], [5, 4], [55, 5], [5, 55]]) {
			const seen = { ...said, versionC, versionS };
			assert.equal(macMatches(await computeMacS(key, seen), b64urlEncode(await computeMacS(key, said))), false, `daemon proof, ${versionC}/${versionS} (${mode})`);
			assert.equal(macMatches(await computeMacC(key, seen), b64urlEncode(await computeMacC(key, said))), false, `extension proof, ${versionC}/${versionS} (${mode})`);
		}
		// Which side has which version is part of it: 5 answered by 6 is not 6 answered by 5.
		assert.notDeepEqual(await computeMacS(key, { ...said, versionC: 5, versionS: 6 }), await computeMacS(key, { ...said, versionC: 6, versionS: 5 }));
	}
});

test("handshake MACs: no digit can move from one part to the next", async () => {
	// The numbers stand next to each other and next to the instance id. Each is set
	// off by the separator, so "879|15|5" is never "8791|5|5", nor "5|5|1abc" "5|51|abc".
	const key = fromHex("11".repeat(32));
	const t = { ...GOOD, nonceC: randomNonce(), nonceS: randomNonce() };
	/** @type {[Partial<import("../../extension/shared/auth.js").Transcript>, Partial<import("../../extension/shared/auth.js").Transcript>][]} */
	const pairs = [
		[{ port: 879, versionC: 15 }, { port: 8791, versionC: 5 }],
		[{ versionC: 5, versionS: 15 }, { versionC: 51, versionS: 5 }],
		[{ versionS: 5, instance: "1abc" }, { versionS: 51, instance: "abc" }],
		[{ versionC: 1, versionS: 23 }, { versionC: 12, versionS: 3 }],
	];
	for (const [a, b] of pairs) {
		assert.notDeepEqual(await computeMacS(key, { ...t, ...a }), await computeMacS(key, { ...t, ...b }), JSON.stringify([a, b]));
		assert.notDeepEqual(await computeMacC(key, { ...t, ...a }), await computeMacC(key, { ...t, ...b }), JSON.stringify([a, b]));
	}
});

test("handshake MACs: port and versions have exactly one spelling, anything else is refused", async () => {
	const key = fromHex("11".repeat(32));
	const good = { ...GOOD, nonceC: randomNonce(), nonceS: randomNonce() };
	for (const bad of [0, -1, 65536, 8791.5, NaN, Infinity, 1e21, "8791", "08791", " 8791", "8791|x", "", null, undefined, true, [8791], 8791n]) {
		await assert.rejects(computeMacS(key, { ...good, port: /** @type {any} */ (bad) }), TypeError, String(bad));
		await assert.rejects(computeMacC(key, { ...good, port: /** @type {any} */ (bad) }), TypeError, String(bad));
	}
	for (const bad of [0, -5, 5.5, NaN, Infinity, 1e21, Number.MAX_SAFE_INTEGER + 1, "5", "05", "5|5", "", null, undefined, true, [5], 5n]) {
		for (const which of /** @type {const} */ (["versionC", "versionS"])) {
			await assert.rejects(computeMacS(key, { ...good, [which]: /** @type {any} */ (bad) }), TypeError, `${which} ${String(bad)}`);
			await assert.rejects(computeMacC(key, { ...good, [which]: /** @type {any} */ (bad) }), TypeError, `${which} ${String(bad)}`);
		}
	}
	// A proof without one of them cannot be made by leaving it out.
	for (const part of /** @type {const} */ (["port", "versionC", "versionS"])) {
		const without = /** @type {Record<string, unknown>} */ ({ ...good });
		delete without[part];
		await assert.rejects(computeMacS(key, /** @type {any} */ (without)), TypeError, part);
		await assert.rejects(computeMacC(key, /** @type {any} */ (without)), TypeError, part);
	}
	// The same number however it is written in the source is the same input.
	assert.deepEqual(await computeMacS(key, { ...good, port: 8791.0, versionC: 5.0 }), await computeMacS(key, good));
	assert.deepEqual(await computeMacS(key, { ...good, port: 0x2257, versionS: 0x5 }), await computeMacS(key, good));
});

test("handshake MACs: bound to the daemon instance", async () => {
	const key = fromHex("11".repeat(32));
	const t = { ...GOOD, instance: "aaaaaaaaaaaaaaaa", nonceC: randomNonce(), nonceS: randomNonce() };
	const other = { ...t, instance: "aaaaaaaaaaaaaaab" };
	assert.equal(macMatches(await computeMacS(key, other), b64urlEncode(await computeMacS(key, t))), false);
	assert.equal(macMatches(await computeMacC(key, other), b64urlEncode(await computeMacC(key, t))), false);
	// Parts cannot be shifted across the separators: instance "ab" + ... is not instance "a" + ...
	assert.notDeepEqual(await computeMacS(key, { ...t, instance: "a" }), await computeMacS(key, { ...t, instance: "ab" }));
});

test("handshake MACs: malformed parts are refused, so the input stays unambiguous", async () => {
	const key = fromHex("11".repeat(32));
	const good = { ...GOOD, nonceC: randomNonce(), nonceS: randomNonce() };
	const nonce = good.nonceC;
	for (const bad of ["", "short", nonce + "A", nonce.slice(1), nonce.slice(0, 42) + "|", nonce.slice(0, 42) + "=", /** @type {any} */ (null)]) {
		await assert.rejects(computeMacS(key, { ...good, nonceC: bad }), TypeError);
		await assert.rejects(computeMacS(key, { ...good, nonceS: bad }), TypeError);
		await assert.rejects(computeMacC(key, { ...good, nonceC: bad }), TypeError);
		await assert.rejects(computeMacC(key, { ...good, nonceS: bad }), TypeError);
		await assert.rejects(deriveExtKey(key, nonce, bad), TypeError);
	}
	for (const bad of ["", "a|b", "inst|auth", "|", "has space", "a".repeat(65), "caf\u00e9", /** @type {any} */ (null), /** @type {any} */ (5)]) {
		await assert.rejects(computeMacS(key, { ...good, instance: bad }), TypeError, String(bad));
		await assert.rejects(computeMacC(key, { ...good, instance: bad }), TypeError, String(bad));
	}
	for (const bad of ["", "AUTH", "auth|x", "admin", "pair ", null, undefined]) {
		await assert.rejects(computeMacS(key, { ...good, mode: /** @type {any} */ (bad) }), TypeError, String(bad));
		await assert.rejects(computeMacC(key, { ...good, mode: /** @type {any} */ (bad) }), TypeError, String(bad));
	}
	assert.equal((await computeMacS(key, { ...good, instance: "a".repeat(64) })).length, 32);
});

test("macMatches: compares against base64url text from the peer", async () => {
	const mac = await computeMacS(fromHex("11".repeat(32)), { ...GOOD, instance: "i", nonceC: randomNonce(), nonceS: randomNonce() });
	assert.equal(macMatches(mac, b64urlEncode(mac)), true);
	const other = mac.slice();
	other[31] ^= 1;
	assert.equal(macMatches(mac, b64urlEncode(other)), false);
	assert.equal(macMatches(mac, b64urlEncode(mac.subarray(0, 31))), false);
	assert.equal(macMatches(mac, b64urlEncode(mac) + "="), false);
	assert.equal(macMatches(mac, ""), false);
	assert.equal(macMatches(mac, null), false);
	assert.equal(macMatches(mac, mac), false);
});

test("deriveExtKey: HKDF over the code with salt nonce_c || nonce_s", async () => {
	const code = formatPairingCode(8791, fromHex("ab".repeat(32)));
	const nonceC = b64urlEncode(fromHex("c1".repeat(32)));
	const nonceS = b64urlEncode(fromHex("5e".repeat(32)));
	const key = await deriveExtKey(pairingKey(code), nonceC, nonceS);
	assert.equal(key.length, 32);

	const reference = nodeCrypto.hkdfSync(
		"sha256",
		Buffer.from(code, "utf8"),
		Buffer.concat([Buffer.from("c1".repeat(32), "hex"), Buffer.from("5e".repeat(32), "hex")]),
		Buffer.from("bgw1 ext key", "utf8"),
		32,
	);
	assert.equal(toHex(key), Buffer.from(reference).toString("hex"));

	// Every input matters: other nonces, swapped nonces or another code give another key.
	assert.notDeepEqual(await deriveExtKey(pairingKey(code), nonceS, nonceC), key);
	assert.notDeepEqual(await deriveExtKey(pairingKey(code), nonceC, randomNonce()), key);
	const otherCode = formatPairingCode(8791, fromHex("ac".repeat(32)));
	assert.notDeepEqual(await deriveExtKey(pairingKey(otherCode), nonceC, nonceS), key);
});

test("pairing code: format, generate, parse", () => {
	const secret = fromHex("00".repeat(31) + "01");
	const code = formatPairingCode(8791, secret);
	assert.equal(code, "bgw1.8791.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE");
	assert.deepEqual(parsePairingCode(code), { ok: true, code, port: 8791, secret });
	// Pasted by hand: surrounding whitespace is fine.
	assert.deepEqual(parsePairingCode(`  ${code}\n`), { ok: true, code, port: 8791, secret });

	const a = generatePairingCode(40123);
	const b = generatePairingCode(40123);
	assert.match(a, /^bgw1\.40123\.[A-Za-z0-9_-]{43}$/);
	assert.notEqual(a, b);
	const parsed = parsePairingCode(a);
	assert.ok(parsed.ok);
	assert.equal(parsed.port, 40123);
	assert.equal(parsed.secret.length, 32);
	assert.deepEqual(pairingKey(a), utf8(a));
});

test("pairing code: parser refusals", () => {
	const secret = b64urlEncode(fromHex("ab".repeat(32)));
	for (const bad of [
		"",
		"bgw1",
		`bgw1.8791`,
		`bgw1.8791.${secret}.extra`,
		`bgw2.8791.${secret}`,
		`BGW1.8791.${secret}`,
		`bgw1.0.${secret}`,
		`bgw1.08791.${secret}`,
		`bgw1.65536.${secret}`,
		`bgw1.99999.${secret}`,
		`bgw1.123456.${secret}`,
		`bgw1.-1.${secret}`,
		`bgw1.87 91.${secret}`,
		`bgw1..${secret}`,
		`bgw1.8791.${secret.slice(1)}`,
		`bgw1.8791.${secret}A`,
		`bgw1.8791.${secret.slice(0, 42)}=`,
		`bgw1.8791.${secret.slice(0, 42)}+`,
		// 43 characters whose trailing bits are not zero: not canonical.
		`bgw1.8791.${"A".repeat(42)}B`,
		`bgw1 8791 ${secret}`,
		`bgw1.8791.${secret} trailing words`,
		"x".repeat(500),
		null,
		undefined,
		8791,
	]) {
		assert.equal(parsePairingCode(bad).ok, false, String(bad));
	}
	assert.throws(() => pairingKey("bgw1.8791.nope"), TypeError);
	assert.throws(() => pairingKey(` bgw1.8791.${secret}`), TypeError);
	assert.throws(() => formatPairingCode(0, fromHex("ab".repeat(32))), RangeError);
	assert.throws(() => formatPairingCode(70000, fromHex("ab".repeat(32))), RangeError);
	assert.throws(() => formatPairingCode(8791, fromHex("ab".repeat(31))), RangeError);
});
