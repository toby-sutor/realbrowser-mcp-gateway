import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_BLOCKLIST,
	MAX_URL_LENGTH,
	REASON,
	checkUrl,
	classifyHost,
	isPrivateAddress,
	OPTIN_LIMITS,
	OPTIN_REASON,
	checkOptInRule,
	isWithinRule,
	optInRuleKey,
	parseOptInRules,
	matchBlocklist,
	matchOptInRule,
	normalizeOptInRule,
	normalizeUrl,
	parseIp,
} from "../../extension/shared/policy.js";

/**
 * @param {unknown} input
 * @returns {string} the normalised URL, or "!<reason>"
 */
function norm(input) {
	const r = normalizeUrl(input);
	return r.ok ? r.url : "!" + r.reason;
}

/**
 * @param {unknown} input
 * @param {Parameters<typeof checkUrl>[1]} [opts]
 * @returns {string} "ok" or the refusal reason
 */
function verdict(input, opts) {
	const r = checkUrl(input, opts);
	return r.allowed ? "ok" : r.reason;
}

test("normalizeUrl: accepts http and https and canonicalises", () => {
	/** @type {[string, string][]} */
	const table = [
		["https://example.com", "https://example.com/"],
		["HTTP://EXAMPLE.COM/Path?Q=1#Frag", "http://example.com/Path?Q=1#Frag"],
		["https://example.com:443/x", "https://example.com/x"],
		["http://example.com:80/", "http://example.com/"],
		["https://example.com:8443/x", "https://example.com:8443/x"],
		["https://example.com./a", "https://example.com/a"],
		["https://bücher.example/", "https://xn--bcher-kva.example/"],
		["https://example.com/a/../b/./c", "https://example.com/b/c"],
		["https://example.com/a/%2e%2e/b", "https://example.com/b"],
		["http:\\\\example.com\\x", "http://example.com/x"],
		["https://ex%41mple.com/", "https://example.com/"],
	];
	for (const [input, expected] of table) assert.equal(norm(input), expected, input);
});

test("normalizeUrl: reports host, scheme and effective port", () => {
	assert.deepEqual(normalizeUrl("https://Example.com/x"), {
		ok: true,
		url: "https://example.com/x",
		host: "example.com",
		scheme: "https",
		port: 443,
	});
	assert.deepEqual(normalizeUrl("http://[2606:4700::1111]:8080/"), {
		ok: true,
		url: "http://[2606:4700::1111]:8080/",
		host: "[2606:4700::1111]",
		scheme: "http",
		port: 8080,
	});
});

test("normalizeUrl: numeric IPv4 spellings collapse to dotted decimal", () => {
	for (const input of [
		"http://2130706433/",
		"http://0x7f.1/",
		"http://127.1/",
		"http://017700000001/",
		"http://0x7f000001/",
		"http://127.0.0.1./",
		"http://0177.0.0.1/",
		"http://127.0.1/",
		"http://①②⑦.0.0.1/",
		"http://127。0。0。1/",
	]) {
		assert.equal(norm(input), "http://127.0.0.1/", input);
	}
	assert.equal(norm("http://0/"), "http://0.0.0.0/");
});

test("normalizeUrl: refusals", () => {
	/** @type {[unknown, string][]} */
	const table = [
		[undefined, REASON.INVALID_URL],
		[null, REASON.INVALID_URL],
		[42, REASON.INVALID_URL],
		[{}, REASON.INVALID_URL],
		["", REASON.INVALID_URL],
		["example.com", REASON.INVALID_URL],
		["/relative/path", REASON.INVALID_URL],
		["//example.com/", REASON.INVALID_URL],
		["http://", REASON.INVALID_URL],
		["http://exa mple.com/", REASON.INVALID_URL],
		[" https://example.com/", REASON.INVALID_URL],
		["https://example.com/ ", REASON.INVALID_URL],
		["https://example.com/a b", REASON.INVALID_URL],
		["https://exam\tple.com/", REASON.INVALID_URL],
		["https://example.com/\n", REASON.INVALID_URL],
		["https://example.com/\u0000", REASON.INVALID_URL],
		["http://999.1.1.1/", REASON.INVALID_URL],
		["http://1.2.3.4.5/", REASON.INVALID_URL],
		["http://a.1/", REASON.INVALID_URL],
		["http://[::1/", REASON.INVALID_URL],
		["http://[fe80::1%25eth0]/", REASON.INVALID_URL],
		["https://example.com:99999/", REASON.INVALID_URL],
		["ftp://example.com/", REASON.SCHEME],
		["file:///etc/passwd", REASON.SCHEME],
		["javascript:alert(1)", REASON.SCHEME],
		["data:text/html,hi", REASON.SCHEME],
		["about:blank", REASON.SCHEME],
		["moz-extension://0f8c2a3e-5b1d-4c7a-9e6f-112233445566/x.html", REASON.SCHEME],
		["view-source:https://example.com/", REASON.SCHEME],
		["ws://example.com/", REASON.SCHEME],
		["blob:https://example.com/0f8c2a3e", REASON.SCHEME],
		["https://user@example.com/", REASON.USERINFO],
		["https://user:pw@example.com/", REASON.USERINFO],
		["https://:pw@example.com/", REASON.USERINFO],
		["https://example.com@evil.example/", REASON.USERINFO],
		["https://example.com../", REASON.INVALID_HOST],
		["https://a..b/", REASON.INVALID_HOST],
		["https://./", REASON.INVALID_HOST],
	];
	for (const [input, reason] of table) assert.equal(norm(input), "!" + reason, String(input));
});

test("normalizeUrl: length cap is 2048", () => {
	const base = "https://example.com/";
	const fits = base + "a".repeat(MAX_URL_LENGTH - base.length);
	assert.equal(fits.length, 2048);
	assert.equal(norm(fits), fits);
	assert.equal(norm(fits + "a"), "!" + REASON.URL_TOO_LONG);
	// Short on input, too long once the parser has percent-encoded it.
	const grows = base + "é".repeat(700);
	assert.ok(grows.length < MAX_URL_LENGTH);
	assert.equal(norm(grows), "!" + REASON.URL_TOO_LONG);
});

test("parseIp: strict literals only", () => {
	assert.deepEqual(parseIp("1.2.3.4")?.version, 4);
	assert.deepEqual([...(parseIp("1.2.3.4")?.bytes ?? [])], [1, 2, 3, 4]);
	assert.equal(parseIp("[::1]")?.version, 6);
	assert.equal(parseIp("::ffff:1.2.3.4")?.bytes.length, 16);
	assert.equal(parseIp("fe80::1%eth0")?.zone, true);
	for (const bad of [
		"",
		"1.2.3",
		"1.2.3.4.5",
		"01.2.3.4",
		"1.2.3.256",
		"1.2.3.-4",
		"0x7f.0.0.1",
		"127.1",
		"2130706433",
		"1.2.3.4 ",
		"example.com",
		":",
		":::",
		"1::2::3",
		"1:2:3:4:5:6:7",
		"1:2:3:4:5:6:7:8:9",
		"1:2:3:4:5:6:7:8::",
		"::1:2:3:4:5:6:7:8",
		"12345::1",
		"g::1",
		"1.2.3.4::",
		"::1.2.3.4:5",
		"::1.2.3",
		":1:2:3:4:5:6:7",
		"1:2:3:4:5:6:7:",
		"[::1",
		null,
		7,
	]) {
		assert.equal(parseIp(bad), null, String(bad));
	}
});

test("isPrivateAddress: IPv4 special ranges are private", () => {
	for (const ip of [
		"0.0.0.0",
		"0.1.2.3",
		"10.0.0.1",
		"10.255.255.255",
		"100.64.0.0",
		"100.64.0.1",
		"100.127.255.255",
		"127.0.0.1",
		"127.0.0.53",
		"127.255.255.255",
		"169.254.0.1",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.255",
		"192.0.0.1",
		"192.0.0.170",
		"192.0.2.1",
		"192.88.99.1",
		"192.168.0.1",
		"192.168.255.255",
		"198.18.0.1",
		"198.19.255.255",
		"198.51.100.7",
		"203.0.113.7",
		"224.0.0.1",
		"239.255.255.250",
		"240.0.0.1",
		"255.255.255.255",
	]) {
		assert.equal(isPrivateAddress(ip), true, ip);
	}
});

test("isPrivateAddress: public IPv4, including the edges of each range", () => {
	for (const ip of [
		"1.1.1.1",
		"8.8.8.8",
		"9.255.255.255",
		"11.0.0.0",
		"100.63.255.255",
		"100.128.0.0",
		"126.255.255.255",
		"128.0.0.0",
		"169.253.255.255",
		"169.255.0.0",
		"172.15.255.255",
		"172.32.0.0",
		"192.0.1.1",
		"192.0.3.1",
		"192.167.255.255",
		"192.169.0.0",
		"198.17.255.255",
		"198.20.0.0",
		"198.51.99.1",
		"198.51.101.1",
		"203.0.112.1",
		"203.0.114.1",
		"223.255.255.255",
	]) {
		assert.equal(isPrivateAddress(ip), false, ip);
	}
});

test("isPrivateAddress: IPv6 special ranges are private", () => {
	for (const ip of [
		"::",
		"::1",
		"[::1]",
		"0:0:0:0:0:0:0:1",
		"0000:0000:0000:0000:0000:0000:0000:0001",
		"::2",
		"fc00::1",
		"fd12:3456:789a::1",
		"fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		"fe80::1",
		"fe80::1%eth0",
		"[fe80::1%25wlan0]",
		"febf::1",
		"fec0::1",
		"ff02::1",
		"ff05::fb",
		"100::1",
		"64:ff9b:1::1",
		"2001::1",
		"2001:0:4136:e378:8000:63bf:3fff:fdd2",
		"2001:2::1",
		"2001:10::1",
		"2001:1ff::1",
		"2001:db8::1",
		"3fff::1",
		"3fff:fff:ffff::1",
		"4000::1",
		"e000::1",
		// IPv4-compatible and other forms inside ::/8
		"::127.0.0.1",
		"::7f00:1",
		"::8.8.8.8",
		"::ffff:0:8.8.8.8",
		// IPv4-mapped private addresses, in every spelling
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::FFFF:7F00:0001",
		"0:0:0:0:0:ffff:7f00:1",
		"::ffff:10.0.0.1",
		"::ffff:a00:1",
		"::ffff:192.168.1.1",
		"::ffff:c0a8:101",
		"::ffff:169.254.169.254",
		"::ffff:100.64.0.1",
		"::ffff:0.0.0.0",
		"::ffff:255.255.255.255",
		"[::ffff:7f00:1]",
		// NAT64 forms of private addresses
		"64:ff9b::7f00:1",
		"64:ff9b::127.0.0.1",
		"64:ff9b::10.0.0.1",
		"64:ff9b::c0a8:101",
		"64:ff9b::a9fe:a9fe",
		// 6to4 with an embedded private address
		"2002:7f00:1::1",
		"2002:a00:1::1",
		"2002:c0a8:101::1",
	]) {
		assert.equal(isPrivateAddress(ip), true, ip);
	}
});

test("isPrivateAddress: public IPv6", () => {
	for (const ip of [
		"2606:4700:4700::1111",
		"2001:4860:4860::8888",
		"[2001:4860:4860::8888]",
		"2001:200::1",
		"2a00:1450:4001:81b::200e",
		"2000::1",
		"3ffe::1",
		"3fff:1000::1",
		"::ffff:8.8.8.8",
		"::ffff:808:808",
		"64:ff9b::8.8.8.8",
		"64:ff9b::808:808",
		"2002:808:808::1",
	]) {
		assert.equal(isPrivateAddress(ip), false, ip);
	}
});

test("isPrivateAddress: fails closed on anything that is not an IP literal", () => {
	for (const bad of ["", "localhost", "example.com", "1.2.3", "01.1.1.1", "8.8.8.8 ", "8.8.8.8/32", "::g", null, undefined, 8]) {
		assert.equal(isPrivateAddress(bad), true, String(bad));
	}
});

test("classifyHost: public names and addresses pass", () => {
	for (const host of ["example.com", "www.example.co.uk", "xn--bcher-kva.example", "a-b.example.com", "sub_domain.example.com", "8.8.8.8", "[2606:4700::1111]", "example.com.", "EXAMPLE.COM", "localhost.example.com", "mylocal.example", "notlocalhost.com", "internal.example.com", "onion.example.com"]) {
		assert.equal(classifyHost(host).allowed, true, host);
	}
	assert.deepEqual(classifyHost("example.com"), { allowed: true, kind: "domain" });
	assert.deepEqual(classifyHost("8.8.8.8"), { allowed: true, kind: "ip" });
});

test("classifyHost: refusals", () => {
	/** @type {[unknown, string][]} */
	const table = [
		["127.0.0.1", REASON.PRIVATE_ADDRESS],
		["10.1.2.3", REASON.PRIVATE_ADDRESS],
		["192.168.1.1", REASON.PRIVATE_ADDRESS],
		["169.254.169.254", REASON.PRIVATE_ADDRESS],
		["100.64.0.1", REASON.PRIVATE_ADDRESS],
		["0.0.0.0", REASON.PRIVATE_ADDRESS],
		["255.255.255.255", REASON.PRIVATE_ADDRESS],
		["224.0.0.1", REASON.PRIVATE_ADDRESS],
		["[::1]", REASON.PRIVATE_ADDRESS],
		["[::]", REASON.PRIVATE_ADDRESS],
		["[::ffff:7f00:1]", REASON.PRIVATE_ADDRESS],
		["[::7f00:1]", REASON.PRIVATE_ADDRESS],
		["[64:ff9b::7f00:1]", REASON.PRIVATE_ADDRESS],
		["[fd00::1]", REASON.PRIVATE_ADDRESS],
		["[fe80::1]", REASON.PRIVATE_ADDRESS],
		["[ff02::1]", REASON.PRIVATE_ADDRESS],
		["::1", REASON.PRIVATE_ADDRESS],
		["localhost", REASON.LOCAL_NAME],
		["LOCALHOST", REASON.LOCAL_NAME],
		["localhost.", REASON.LOCAL_NAME],
		["a.localhost", REASON.LOCAL_NAME],
		["a.b.localhost.", REASON.LOCAL_NAME],
		["printer.local", REASON.LOCAL_NAME],
		["local", REASON.LOCAL_NAME],
		["host.localdomain", REASON.LOCAL_NAME],
		["db.internal", REASON.LOCAL_NAME],
		["wiki.intranet", REASON.LOCAL_NAME],
		["nas.lan", REASON.LOCAL_NAME],
		["router.home", REASON.LOCAL_NAME],
		["router.home.arpa", REASON.LOCAL_NAME],
		["home.arpa", REASON.LOCAL_NAME],
		["build.corp", REASON.LOCAL_NAME],
		["x.private", REASON.LOCAL_NAME],
		["site.test", REASON.LOCAL_NAME],
		["site.invalid", REASON.LOCAL_NAME],
		["abcdefghijklmnop.onion", REASON.ONION],
		["www.abcdefghijklmnop.onion.", REASON.ONION],
		["onion", REASON.ONION],
		["intranet-box", REASON.SINGLE_LABEL],
		["router", REASON.SINGLE_LABEL],
		["com", REASON.SINGLE_LABEL],
		["com.", REASON.SINGLE_LABEL],
		["", REASON.INVALID_HOST],
		[".", REASON.INVALID_HOST],
		["a..b", REASON.INVALID_HOST],
		[".example.com", REASON.INVALID_HOST],
		["example.com..", REASON.INVALID_HOST],
		["exa mple.com", REASON.INVALID_HOST],
		["bücher.example", REASON.INVALID_HOST],
		["example.com/path", REASON.INVALID_HOST],
		["user@example.com", REASON.INVALID_HOST],
		["[::1", REASON.INVALID_HOST],
		["[not-an-ip]", REASON.INVALID_HOST],
		["1.2.3", REASON.INVALID_HOST],
		["example.123", REASON.INVALID_HOST],
		["example.0x1f", REASON.INVALID_HOST],
		["2130706433", REASON.INVALID_HOST],
		["a".repeat(256), REASON.INVALID_HOST],
		[null, REASON.INVALID_HOST],
		[undefined, REASON.INVALID_HOST],
		[5, REASON.INVALID_HOST],
	];
	for (const [host, reason] of table) {
		assert.deepEqual(classifyHost(host), { allowed: false, reason }, String(host));
	}
});

test("matchBlocklist: suffix match on label boundaries only", () => {
	const list = ["example.com", "mail.site.org"];
	/** @type {[string, string | null][]} */
	const table = [
		["example.com", "example.com"],
		["www.example.com", "example.com"],
		["a.b.example.com", "example.com"],
		["EXAMPLE.com", "example.com"],
		["example.com.", "example.com"],
		["mail.site.org", "mail.site.org"],
		["eu.mail.site.org", "mail.site.org"],
		["badexample.com", null],
		["example.com.evil.org", null],
		["example.co", null],
		["xample.com", null],
		["com", null],
		["site.org", null],
		["webmail.site.org", null],
		["notmail.site.org", null],
		["", null],
	];
	for (const [host, expected] of table) assert.equal(matchBlocklist(host, list), expected, host);
});

test("matchBlocklist: tolerates untidy lists and odd input", () => {
	assert.equal(matchBlocklist("www.example.com", ["Example.COM."]), "Example.COM.");
	assert.equal(matchBlocklist("www.example.com", [" example.com "]), " example.com ");
	assert.equal(matchBlocklist("www.example.com", [""]), null);
	assert.equal(matchBlocklist("www.example.com", []), null);
	assert.equal(matchBlocklist(null, ["example.com"]), null);
	assert.equal(matchBlocklist("www.example.com", /** @type {any} */ ([null, 5, "example.com"])), "example.com");
});

test("default blocklist: covers the sensitive categories, entries are tidy", () => {
	for (const host of [
		"mail.google.com",
		"gmail.com",
		"outlook.live.com",
		"mail.proton.me",
		"accounts.google.com",
		"myaccount.google.com",
		"login.microsoftonline.com",
		"appleid.apple.com",
		"www.paypal.com",
		"paypal.com",
		"dashboard.stripe.com",
		"vault.bitwarden.com",
		"my.1password.com",
		"lastpass.com",
		"passwords.google.com",
	]) {
		assert.notEqual(matchBlocklist(host, DEFAULT_BLOCKLIST), null, host);
	}
	for (const host of ["google.com", "www.google.com", "docs.stripe.com", "proton.me", "apple.com", "developer.mozilla.org", "bitwarden.com", "reddit.com"]) {
		assert.equal(matchBlocklist(host, DEFAULT_BLOCKLIST), null, host);
	}
	assert.ok(DEFAULT_BLOCKLIST.length <= 60);
	assert.equal(new Set(DEFAULT_BLOCKLIST).size, DEFAULT_BLOCKLIST.length);
	for (const entry of DEFAULT_BLOCKLIST) {
		assert.match(entry, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, entry);
		assert.equal(classifyHost(entry).allowed, true, entry);
	}
	assert.ok(Object.isFrozen(DEFAULT_BLOCKLIST));
});

test("opt-in rules: the canonical form, and everything that is no usable rule", () => {
	assert.deepEqual(normalizeOptInRule({ host: "Reddit.COM.", pathPrefix: "/r/", subdomains: false }), { host: "reddit.com", pathPrefix: "/r/", subdomains: false });
	assert.deepEqual(normalizeOptInRule({ host: "old.reddit.com", pathPrefix: "/", subdomains: true }), { host: "old.reddit.com", pathPrefix: "/", subdomains: true });
	assert.deepEqual(checkOptInRule({ host: "xn--bcher-kva.de", pathPrefix: "/wiki/Z%C3%BCrich", subdomains: false }), { ok: true, rule: { host: "xn--bcher-kva.de", pathPrefix: "/wiki/Z%C3%BCrich", subdomains: false } });
	/** @type {[unknown, string][]} */
	const bad = [
		[null, "shape"],
		[undefined, "shape"],
		["reddit.com", "shape"],
		[[], "shape"],
		[{}, "shape"],
		[{ host: "reddit.com" }, "shape"],
		[{ pathPrefix: "/" }, "shape"],
		// The flag for subdomains has no default: a rule that does not say is no rule.
		[{ host: "reddit.com", pathPrefix: "/" }, "shape"],
		[{ host: "reddit.com", pathPrefix: "/", subdomains: "yes" }, "shape"],
		[{ host: "reddit.com", pathPrefix: "/", subdomains: 1 }, "shape"],
		[{ host: 5, pathPrefix: "/", subdomains: false }, "shape"],
		// Nothing a rule does not have: no way to slip an extra meaning in.
		[{ host: "reddit.com", pathPrefix: "/", subdomains: false, scheme: "http" }, "shape"],
		[{ host: "reddit.com", pathPrefix: "/", subdomains: false, enabled: true }, "shape"],
		[{ host: "reddit.com", pathPrefix: "", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "r/", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r/?x=1", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r/#x", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r x/", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r\\x", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r/../settings", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r/./x", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "//r", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r//x", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r%2Fx", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r%2e%2e/x", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r%5cx", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r%252fx", subdomains: false }, "path_prefix"],
		// A dot segment with a path parameter: the parser keeps it, a server that knows parameters walks up.
		[{ host: "reddit.com", pathPrefix: "/r/..;/", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r/..;/admin", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/..;/admin", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r/..;x=1/admin", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r/..;", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r/.;/admin", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r/..%3b/admin", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r/..%3B/admin", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r/.%3bx/admin", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/Zürich", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: "/r\u0000", subdomains: false }, "path_prefix"],
		[{ host: "reddit.com", pathPrefix: `/${"a".repeat(OPTIN_LIMITS.maxPathPrefix)}`, subdomains: false }, "path_prefix"],
		// One label is a registry's name, or a name of the local network.
		[{ host: "com", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "localhost", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "*.reddit.com", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "*", pathPrefix: "/", subdomains: true }, "host"],
		[{ host: "reddit.*", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "https://reddit.com", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "reddit.com/r", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "reddit.com:443", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "user@reddit.com", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "reddit..com", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: ".reddit.com", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "-reddit.com", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "reddit-.com", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "red dit.com", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "bücher.de", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: "reddit.c", pathPrefix: "/", subdomains: false }, "host"],
		[{ host: `${"a".repeat(64)}.com`, pathPrefix: "/", subdomains: false }, "host"],
		[{ host: `${"a.".repeat(130)}com`, pathPrefix: "/", subdomains: false }, "host"],
		// Addresses, in every spelling.
		[{ host: "10.0.0.1", pathPrefix: "/", subdomains: false }, "ip_literal"],
		[{ host: "8.8.8.8", pathPrefix: "/", subdomains: false }, "ip_literal"],
		[{ host: "[::1]", pathPrefix: "/", subdomains: false }, "ip_literal"],
		[{ host: "[2606:4700::1111]", pathPrefix: "/", subdomains: false }, "ip_literal"],
		[{ host: "example.123", pathPrefix: "/", subdomains: false }, "ip_literal"],
		// Local and special-use names.
		[{ host: "a.localhost", pathPrefix: "/", subdomains: false }, "local_name"],
		[{ host: "router.local", pathPrefix: "/", subdomains: false }, "local_name"],
		[{ host: "wiki.internal", pathPrefix: "/", subdomains: false }, "local_name"],
		[{ host: "nas.home.arpa", pathPrefix: "/", subdomains: false }, "local_name"],
		[{ host: "abcdefghij234567.onion", pathPrefix: "/", subdomains: false }, "local_name"],
		// Names that stand for many sites of different owners.
		[{ host: "co.uk", pathPrefix: "/", subdomains: true }, "public_suffix"],
		[{ host: "com.au", pathPrefix: "/", subdomains: false }, "public_suffix"],
		[{ host: "or.jp", pathPrefix: "/", subdomains: true }, "public_suffix"],
		[{ host: "github.io", pathPrefix: "/", subdomains: true }, "public_suffix"],
		[{ host: "blogspot.com", pathPrefix: "/", subdomains: true }, "public_suffix"],
		[{ host: "herokuapp.com", pathPrefix: "/", subdomains: false }, "public_suffix"],
		// The blocklist: the host itself, a host below an entry, and a rule whose subdomains would reach an entry.
		[{ host: "mail.google.com", pathPrefix: "/", subdomains: false }, "blocklisted"],
		[{ host: "paypal.com", pathPrefix: "/", subdomains: false }, "blocklisted"],
		[{ host: "www.paypal.com", pathPrefix: "/", subdomains: false }, "blocklisted"],
		[{ host: "accounts.google.com", pathPrefix: "/signin", subdomains: false }, "blocklisted"],
		[{ host: "google.com", pathPrefix: "/", subdomains: true }, "covers_blocklisted"],
		[{ host: "proton.me", pathPrefix: "/", subdomains: true }, "covers_blocklisted"],
		[{ host: "live.com", pathPrefix: "/", subdomains: true }, "covers_blocklisted"],
	];
	for (const [rule, reason] of bad) {
		assert.deepEqual(checkOptInRule(rule), { ok: false, reason }, JSON.stringify(rule));
		assert.equal(normalizeOptInRule(rule), null, JSON.stringify(rule));
	}
	// What is close to those and fine.
	for (const good of [
		{ host: "google.com", pathPrefix: "/", subdomains: false },
		{ host: "docs.google.com", pathPrefix: "/document", subdomains: false },
		{ host: "x.github.io", pathPrefix: "/", subdomains: false },
		{ host: "example.co.uk", pathPrefix: "/", subdomains: true },
		{ host: "bbc.co.uk", pathPrefix: "/news", subdomains: false },
		{ host: "t.co", pathPrefix: "/", subdomains: false },
		{ host: "news.ycombinator.com", pathPrefix: "/", subdomains: false },
		{ host: "reddit.com", pathPrefix: `/${"a".repeat(OPTIN_LIMITS.maxPathPrefix - 1)}`, subdomains: false },
		// A path parameter on a name is a name with a semicolon in it, and so are three dots.
		{ host: "reddit.com", pathPrefix: "/r/all;sort=new", subdomains: false },
		{ host: "reddit.com", pathPrefix: "/r/...;x/", subdomains: false },
		{ host: "reddit.com", pathPrefix: "/r/a..;x/", subdomains: false },
		{ host: "reddit.com", pathPrefix: "/r/..a;x/", subdomains: false },
		{ host: "reddit.com", pathPrefix: "/r/a%3Bb", subdomains: false },
	]) {
		assert.deepEqual(checkOptInRule(good), { ok: true, rule: good }, JSON.stringify(good));
	}
	// Another blocklist than the default one is honoured too.
	assert.deepEqual(checkOptInRule({ host: "intranet.example.com", pathPrefix: "/", subdomains: false }, { blocklist: ["example.com"] }), { ok: false, reason: "blocklisted" });
	assert.equal(Object.isFrozen(OPTIN_LIMITS) && Object.isFrozen(OPTIN_REASON), true);
});

// Sites of every kind and country, as an operator would name them: what a rule must go on taking.
const ORDINARY = `
	example.co.uk bbc.co.uk github.com news.ycombinator.com heise.de lemonde.fr abc.net.au u-tokyo.ac.jp
	google.com youtube.com facebook.com wikipedia.org en.wikipedia.org reddit.com old.reddit.com amazon.com amazon.de amazon.co.uk amazon.co.jp
	twitter.com x.com instagram.com linkedin.com netflix.com microsoft.com apple.com stackoverflow.com stackexchange.com superuser.com
	mozilla.org developer.mozilla.org nytimes.com theguardian.com washingtonpost.com wsj.com ft.com economist.com bloomberg.com reuters.com
	cnn.com bbc.com npr.org pbs.org nbcnews.com cbsnews.com foxnews.com usatoday.com latimes.com theatlantic.com newyorker.com wired.com
	arstechnica.com theverge.com techcrunch.com engadget.com slashdot.org lwn.net phoronix.com golem.de spiegel.de zeit.de faz.net sueddeutsche.de
	tagesschau.de welt.de taz.de n-tv.de bild.de focus.de stern.de handelsblatt.com ard.de zdf.de dw.com gmx.de web.de t-online.de chip.de
	computerbase.de derstandard.at orf.at diepresse.com krone.at nzz.ch srf.ch tagesanzeiger.ch 20min.ch blick.ch admin.ch ethz.ch
	lefigaro.fr liberation.fr leparisien.fr mediapart.fr francetvinfo.fr orange.fr free.fr laposte.net sncf.com service-public.fr
	elpais.com elmundo.es abc.es marca.com lavanguardia.com rtve.es repubblica.it corriere.it lastampa.it ansa.it rai.it ilsole24ore.com
	nos.nl nu.nl volkskrant.nl telegraaf.nl tweakers.net bol.com marktplaats.nl dr.dk politiken.dk svt.se dn.se aftonbladet.se nrk.no vg.no
	aftenposten.no finn.no yle.fi hs.fi wp.pl onet.pl interia.pl allegro.pl gazeta.pl seznam.cz idnes.cz novinky.cz index.hu origo.hu 444.hu
	telex.hu yandex.ru mail.ru vk.com ok.ru habr.com lenta.ru rbc.ru ukr.net pravda.com.ua rozetka.com.ua
	yahoo.co.jp rakuten.co.jp nikkei.com asahi.com nhk.or.jp mainichi.jp yomiuri.co.jp mercari.com pixiv.net nicovideo.jp
	naver.com daum.net chosun.com joins.com baidu.com qq.com taobao.com jd.com weibo.com zhihu.com bilibili.com sina.com.cn 163.com
	timesofindia.indiatimes.com thehindu.com ndtv.com flipkart.com irctc.co.in iitb.ac.in
	smh.com.au theage.com.au news.com.au unimelb.edu.au stuff.co.nz nzherald.co.nz rnz.co.nz
	globo.com uol.com.br folha.uol.com.br mercadolivre.com.br estadao.com.br clarin.com lanacion.com.ar mercadolibre.com.ar eluniversal.com.mx
	unam.mx emol.com latercera.com eltiempo.com news24.com iol.co.za dailymaverick.co.za takealot.com
	telegraph.co.uk independent.co.uk dailymail.co.uk service.gov.uk www.gov.uk www.nhs.uk england.nhs.uk
	ox.ac.uk cam.ac.uk imperial.ac.uk ucl.ac.uk mit.edu stanford.edu harvard.edu berkeley.edu cmu.edu epfl.ch tum.de kit.edu
	lmu.de tu-berlin.de uni-heidelberg.de sorbonne-universite.fr utoronto.ca ubc.ca mcgill.ca cbc.ca theglobeandmail.com canada.ca
	nih.gov cdc.gov nasa.gov irs.gov whitehouse.gov europa.eu ec.europa.eu un.org who.int w3.org ietf.org iana.org icann.org
	arxiv.org acm.org ieee.org nature.com science.org sciencedirect.com springer.com wiley.com jstor.org pubmed.ncbi.nlm.nih.gov
	gitlab.com bitbucket.org sourceforge.net codeberg.org npmjs.com pypi.org crates.io rubygems.org packagist.org docker.com hub.docker.com
	kernel.org debian.org ubuntu.com archlinux.org fedoraproject.org opensuse.org gnu.org python.org nodejs.org rust-lang.org go.dev
	docs.python.org docs.rs pkg.go.dev learn.microsoft.com docs.github.com support.google.com cloud.google.com aws.amazon.com
	console.aws.amazon.com portal.azure.com azure.microsoft.com digitalocean.com hetzner.com ovh.com cloudflare.com dash.cloudflare.com
	discord.com slack.com zoom.us notion.so trello.com atlassian.net atlassian.com jira.com asana.com figma.com canva.com dropbox.com
	box.com medium.com dev.to hashnode.com quora.com pinterest.com twitch.tv tiktok.com snapchat.com telegram.org
	t.me whatsapp.com signal.org mastodon.social bsky.app threads.net imdb.com rottentomatoes.com spotify.com open.spotify.com soundcloud.com
	bandcamp.com last.fm goodreads.com ebay.com ebay.de ebay.co.uk etsy.com aliexpress.com walmart.com target.com bestbuy.com ikea.com
	booking.com airbnb.com tripadvisor.com expedia.com kayak.com bahn.de sbb.ch oebb.at ns.nl sncf-connect.com ryanair.com lufthansa.com
	ba.com hp.com ge.com ibm.com intel.com amd.com nvidia.com dell.com lenovo.com samsung.com sony.com lg.com bmw.de vw.de
	steampowered.com store.steampowered.com steamcommunity.com epicgames.com gog.com itch.io nexusmods.com ign.com gamespot.com
	duckduckgo.com bing.com search.brave.com startpage.com ecosia.org kagi.com perplexity.ai openai.com chat.openai.com anthropic.com claude.ai
	huggingface.co kaggle.com leetcode.com hackerrank.com coursera.org edx.org udemy.com khanacademy.org duolingo.com
	archive.org web.archive.org gutenberg.org openstreetmap.org wikimedia.org commons.wikimedia.org wiktionary.org fandom.com
	letterboxd.com myanimelist.net anilist.co crunchyroll.com patreon.com ko-fi.com kickstarter.com gofundme.com change.org
	craigslist.org nextdoor.com yelp.com zillow.com indeed.com glassdoor.com xing.com stepstone.de immobilienscout24.de kleinanzeigen.de
	idealo.de otto.de zalando.de mediamarkt.de check24.de dhl.de post.ch royalmail.com ups.com fedex.com
	example.io example.co example.me example.tv example.ai example.app example.dev example.xyz example.info example.online example.berlin
	forum.example.com intranet.example.co.uk shop.example.com.au blog.example.fr www.example.it app.example.io me.com go.com info.cern.ch
	someone.github.io someone.wordpress.com shop.myshopify.com project.readthedocs.io blog.tumblr.com name.substack.com
`
	.split(/\s+/)
	.filter((name) => name !== "");

test("opt-in rules: a name that many owners share is no site, with subdomains or without", () => {
	/** @param {string} host @param {boolean} subdomains @returns {string} "ok" or the reason */
	const rule = (host, subdomains) => {
		const checked = checkOptInRule({ host, pathPrefix: "/", subdomains }, { blocklist: [] });
		return checked.ok ? "ok" : checked.reason;
	};
	// The table knows them: registries under a generic ending, second levels of countries, hosting names.
	const shared = [
		"uk.com", "us.com", "eu.org", "gouv.fr", "gv.at", "nhs.uk", "id.au", "pp.ua", "tokyo.jp", "k12.ca.us", "blogspot.de", "blogspot.co.uk", "wordpress.com", "myshopify.com",
		"ngrok-free.app", "r2.dev", "translate.goog", "cloudapp.azure.com", "web.core.windows.net", "amazonaws.com", "s3.amazonaws.com", "co.uk", "com.au", "or.jp", "ne.jp", "ac.be",
		"gov.ie", "govt.nz", "gub.uy", "k12.tr", "police.uk", "asn.au", "nsw.au", "school.nz", "law.za", "ed.jp", "osaka.jp", "kobe.jp", "re.kr", "seoul.kr", "bj.cn", "idv.tw",
		"idv.hk", "nic.in", "asso.fr", "tm.fr", "toscana.it", "priv.no", "pp.se", "waw.pl", "priv.hu", "tm.ro", "msk.ru", "kiev.ua", "on.ca", "ca.us", "ny.us", "cc.ny.us", "lib.wa.us",
		"com.np", "anything.np", "what.ck", "x.pg", "com.de", "gb.net", "co.com", "hk.com", "github.io", "gitlab.io", "pages.dev", "workers.dev", "netlify.app", "vercel.app",
		"herokuapp.com", "web.app", "firebaseapp.com", "appspot.com", "blogspot.com", "blogspot.com.au", "cloudfront.net", "azurewebsites.net", "onrender.com", "fly.dev", "glitch.me",
		"neocities.org", "readthedocs.io", "tumblr.com", "substack.com", "wixsite.com", "webflow.io", "ngrok.io", "trycloudflare.com", "duckdns.org", "windows.net", "run.app",
	];
	for (const host of shared) {
		assert.equal(rule(host, true), "public_suffix", host);
		assert.equal(rule(host, false), "public_suffix", host);
	}
	// The table does not know them, and they have the form: refused with subdomains, the safe mistake.
	// Named alone - one host, one owner - they pass.
	const formOnly = [
		// below a provider's zone
		"s3.eu-west-1.amazonaws.com", "bucket.s3.eu-west-1.amazonaws.com", "execute-api.us-east-1.amazonaws.com", "x.blob.core.windows.net", "core.windows.net",
		"westeurope.cloudapp.azure.com", "vm.westeurope.cloudapp.azure.com", "lambda-url.eu-west-1.on.aws", "x.a.run.app",
		// two labels under a country code: one or two characters, or a code nothing is known of
		"mi.it", "rm.it", "ab.se", "xy.fr", "zz.de", "q.at", "zz.pl", "example.br", "example.za", "example.th", "example.tr", "example.il", "example.eg", "example.bd", "name.ve",
		// a country code as the name under com, net or org
		"fr.com", "nl.com", "au.com", "es.net", "ca.org", "gb.com",
		// a registry's label on top of a shared name
		"ltd.co.im", "plc.co.uk", "edu.eu.org", "com.github.io", "ac.id.au",
	];
	for (const host of formOnly) {
		assert.equal(rule(host, true), "suffix_like", host);
		assert.equal(rule(host, false), "ok", host);
	}
	assert.equal(OPTIN_REASON.SUFFIX_LIKE, "suffix_like");
	// A site under a shared name is a site.
	for (const host of ["someone.github.io", "shop.myshopify.com", "example.uk.com", "example.eu.org", "example.gv.at", "england.nhs.uk", "x.id.au", "metro.tokyo.jp", "school.k12.ca.us", "x.blogspot.de", "d111.cloudfront.net", "example.com.np"]) {
		assert.equal(rule(host, true), "ok", host);
		assert.equal(rule(host, false), "ok", host);
	}
	// Fixture names of a test build are outside all of this, as they are outside the check for local names.
	assert.deepEqual(checkOptInRule({ host: "co.localhost", pathPrefix: "/", subdomains: true }, { fixturePorts: [8080] }).ok, true);
});

test("opt-in rules: ordinary sites pass, alone and with their subdomains - but for a known few", () => {
	assert.ok(new Set(ORDINARY).size >= 400, "a list long enough to mean something");
	/** @type {Record<string, string>} */
	const refused = {};
	for (const host of new Set(ORDINARY)) {
		// One host can always be named.
		assert.deepEqual(checkOptInRule({ host, pathPrefix: "/", subdomains: false }, { blocklist: [] }), { ok: true, rule: { host, pathPrefix: "/", subdomains: false } }, host);
		const wide = checkOptInRule({ host, pathPrefix: "/", subdomains: true }, { blocklist: [] });
		if (!wide.ok) refused[host] = wide.reason;
	}
	// What the cautious rule for subdomains costs: sites with a name of one or two characters under a
	// country code, and companies whose name under com is a country's code. Each can be named host by host.
	assert.deepEqual(Object.keys(refused).sort(), ["ba.com", "dn.se", "dr.dk", "ge.com", "hs.fi", "me.com", "ns.nl", "nu.nl", "ok.ru", "t.me", "vg.no", "vw.de", "wp.pl"]);
	assert.deepEqual([...new Set(Object.values(refused))], ["suffix_like"]);
});

test("opt-in rules: fixture names pass only where a test build lists fixture ports", () => {
	const rule = { host: "a.localhost", pathPrefix: "/in", subdomains: false };
	assert.equal(normalizeOptInRule(rule), null);
	assert.equal(normalizeOptInRule(rule, { fixturePorts: [] }), null);
	assert.deepEqual(normalizeOptInRule(rule, { fixturePorts: [8080] }), rule);
	// The escape hatch is for loopback names and nothing else.
	assert.equal(normalizeOptInRule({ host: "router.local", pathPrefix: "/", subdomains: false }, { fixturePorts: [8080] }), null);
	assert.equal(normalizeOptInRule({ host: "127.0.0.1", pathPrefix: "/", subdomains: false }, { fixturePorts: [8080] }), null);
	assert.equal(normalizeOptInRule({ host: "blocked.localhost", pathPrefix: "/", subdomains: false }, { fixturePorts: [8080], blocklist: ["blocked.localhost"] }), null);
});

test("opt-in rules: a stored list is checked rule by rule, and can only shrink", () => {
	const a = { host: "reddit.com", pathPrefix: "/r", subdomains: false };
	const b = { host: "example.org", pathPrefix: "/", subdomains: true };
	assert.deepEqual(parseOptInRules([a, b]), { rules: [a, b], rejected: 0 });
	assert.deepEqual(parseOptInRules([a, { host: "com", pathPrefix: "/", subdomains: true }, b, null, "x", { ...a }]), { rules: [a, b], rejected: 4 });
	assert.deepEqual(parseOptInRules(undefined), { rules: [], rejected: 0 });
	assert.deepEqual(parseOptInRules(null), { rules: [], rejected: 0 });
	for (const junk of ["reddit.com", 5, {}, { rules: [a] }, true]) assert.deepEqual(parseOptInRules(junk), { rules: [], rejected: 1 }, JSON.stringify(junk));
	// The cap on the number of rules.
	const many = Array.from({ length: OPTIN_LIMITS.maxRules + 5 }, (_, i) => ({ host: `site${i}.example.com`, pathPrefix: "/", subdomains: false }));
	const capped = parseOptInRules(many);
	assert.equal(capped.rules.length, OPTIN_LIMITS.maxRules);
	assert.equal(capped.rejected, 5);
	assert.equal(optInRuleKey(a), "reddit.com/r");
	assert.equal(optInRuleKey(b), "*.example.org/");
});

test("isWithinRule: the host itself, and the names below it only when the rule says so", () => {
	const exact = { host: "reddit.com", pathPrefix: "/", subdomains: false };
	const wide = { host: "reddit.com", pathPrefix: "/", subdomains: true };
	/** @type {[string, boolean, boolean][]} url, inside the exact rule, inside the rule with subdomains */
	const table = [
		["https://reddit.com/", true, true],
		["https://REDDIT.com/", true, true],
		["https://reddit.com./", true, true],
		["https://reddit.com:443/", true, true],
		["https://www.reddit.com/r/x", false, true],
		["https://old.reddit.com/", false, true],
		["https://a.b.reddit.com/", false, true],
		["https://notreddit.com/", false, false],
		["https://reddit.com.evil.example/", false, false],
		["https://reddit.co/", false, false],
		["https://evil.example/reddit.com/", false, false],
		["https://evil.example/?u=https://reddit.com/", false, false],
		["https://reddit.com@evil.example/", false, false],
		["https://user@reddit.com/", false, false],
		["https://user:pw@www.reddit.com/", false, false],
		// Another port is another server.
		["https://reddit.com:8443/", false, false],
		["https://www.reddit.com:8443/", false, false],
		["http://reddit.com/", false, false],
		["http://reddit.com:443/", false, false],
		["ftp://reddit.com/", false, false],
		["wss://reddit.com/", false, false],
		["blob:https://reddit.com/0b9c7b7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", false, false],
		["data:text/html,<p>x</p>", false, false],
		["about:blank", false, false],
		["not a url", false, false],
		["", false, false],
	];
	for (const [url, inExact, inWide] of table) {
		assert.equal(isWithinRule(url, exact), inExact, `exact: ${url}`);
		assert.equal(isWithinRule(url, wide), inWide, `with subdomains: ${url}`);
	}
	assert.equal(isWithinRule(new URL("https://www.reddit.com/r/x"), wide), true);
	assert.equal(isWithinRule(new URL("https://www.reddit.com/r/x"), exact), false);
	// A rule for a subdomain says nothing about the name above it.
	assert.equal(isWithinRule("https://reddit.com/", { host: "old.reddit.com", pathPrefix: "/", subdomains: true }), false);
});

test("isWithinRule: path prefix on segment boundaries", () => {
	/** @type {[string, string, boolean][]} */
	const table = [
		["/r/", "https://reddit.com/r/", true],
		["/r/", "https://reddit.com/r/programming", true],
		["/r/", "https://reddit.com/r/programming/comments/1?x=1#y", true],
		["/r/", "https://reddit.com/r", true],
		["/r/", "https://reddit.com/rss", false],
		["/r/", "https://reddit.com/rss/feed", false],
		["/r/", "https://reddit.com/r-x/", false],
		["/r/", "https://reddit.com/", false],
		["/r/", "https://reddit.com/user/r/", false],
		["/r/", "https://reddit.com/R/x", false],
		["/r/", "https://reddit.com//r/x", false],
		["/r", "https://reddit.com/r", true],
		["/r", "https://reddit.com/r/x", true],
		["/r", "https://reddit.com/rss", false],
		["/r", "https://reddit.com/r.json", false],
		["/r/programming", "https://reddit.com/r/programming", true],
		["/r/programming", "https://reddit.com/r/programming/top", true],
		["/r/programming", "https://reddit.com/r/programminghumor", false],
		["/r/programming", "https://reddit.com/r/", false],
		["/", "https://reddit.com/", true],
		["/", "https://reddit.com/anything/at/all", true],
		// The query and the fragment are no part of the path.
		["/r/", "https://reddit.com/settings?next=/r/x", false],
		["/r/", "https://reddit.com/settings#/r/x", false],
		// Dot segments are resolved by the parser before matching.
		["/r/", "https://reddit.com/r/../settings", false],
		["/r/", "https://reddit.com/r/%2e%2e/settings", false],
		["/r/", "https://reddit.com/r/x/../../settings", false],
		["/r/", "https://reddit.com/settings/../r/x", true],
		// Encoded separators and dots could be decoded differently by a server.
		["/r/", "https://reddit.com/r/..%2fsettings", false],
		["/r/", "https://reddit.com/r/%2E%2E%2Fsettings", false],
		["/r/", "https://reddit.com/r/x%5c..%5csettings", false],
		["/r/", "https://reddit.com/r/x%2ey", false],
		["/r/", "https://reddit.com/r/x%252fy", false],
		["/r/", "https://reddit.com/r/%252e%252e/settings", false],
		["/r/", "https://reddit.com/r\\..\\settings", false],
		// A dot segment with a path parameter is no dot segment to the parser, and one to a server that
		// takes the parameter off first: "/r/..;/admin" is "/admin" there.
		["/r/", "https://reddit.com/r/..;/admin", false],
		["/r/", "https://reddit.com/r/..;", false],
		["/r/", "https://reddit.com/r/..;x=1/admin", false],
		["/r/", "https://reddit.com/r/..;jsessionid=1/admin?next=/r/", false],
		["/r/", "https://reddit.com/r/.;/admin", false],
		["/r/", "https://reddit.com/r/x/..;/..;/admin", false],
		["/r/", "https://reddit.com/r/..%3b/admin", false],
		["/r/", "https://reddit.com/r/..%3B/admin", false],
		["/r/", "https://reddit.com/r/.%3Bx/admin", false],
		["/r/", "https://reddit.com/r/..%253b/admin", false],
		["/r/", "https://reddit.com/r/..%25253B/admin", false],
		["/r/", "https://reddit.com/r/%2e%2e;/admin", false],
		["/r/", "https://reddit.com/r/.%2E;/admin", false],
		["/r/", "https://reddit.com/r\\..;\\admin", false],
		["/r/", "https://reddit.com/r/x/..;/y", false],
		["/", "https://reddit.com/..;/admin", false],
		["/", "https://reddit.com/a/..;/b", false],
		// A parameter on a name, and names that only begin or end like a dot segment, are names.
		["/r/", "https://reddit.com/r/all;sort=new/top", true],
		["/r/", "https://reddit.com/r/x;a=1;b=2", true],
		["/r/", "https://reddit.com/r/...;/x", true],
		["/r/", "https://reddit.com/r/a..;/x", true],
		["/r/", "https://reddit.com/r/..a;/x", true],
		["/r/", "https://reddit.com/r/;/x", true],
		["/r/", "https://reddit.com/r/x?next=/..;/admin", true],
		["/r/", "https://reddit.com/r/x#/..;/admin", true],
	];
	for (const [pathPrefix, url, expected] of table) {
		assert.equal(isWithinRule(url, { host: "reddit.com", pathPrefix, subdomains: false }), expected, `${pathPrefix} vs ${url}`);
	}
});

test("isWithinRule: http and a port only for the fixtures of a test build; bad rules never match", () => {
	const rule = { host: "a.localhost", pathPrefix: "/app/", subdomains: false };
	const fixture = { fixturePorts: [8080] };
	assert.equal(isWithinRule("http://a.localhost:8080/app/x", rule), false);
	assert.equal(isWithinRule("http://a.localhost:8080/app/x", rule, fixture), true);
	assert.equal(isWithinRule("http://a.localhost:8080/other", rule, fixture), false);
	assert.equal(isWithinRule("http://b.localhost:8080/app/x", rule, fixture), false);
	assert.equal(isWithinRule("http://x.a.localhost:8080/app/x", rule, fixture), false);
	assert.equal(isWithinRule("http://x.a.localhost:8080/app/x", { ...rule, subdomains: true }, fixture), true);
	// Another port of the loopback is not the fixture server.
	assert.equal(isWithinRule("http://a.localhost:8081/app/x", rule, fixture), false);
	assert.equal(isWithinRule("http://a.localhost/app/x", rule, fixture), false);
	assert.equal(isWithinRule("https://a.localhost:8080/app/x", rule, fixture), false);
	assert.equal(isWithinRule("ftp://a.localhost:8080/app/x", rule, fixture), false);
	// With fixture ports listed, a real site is still https on its default port and nothing else.
	const real = { host: "reddit.com", pathPrefix: "/", subdomains: false };
	assert.equal(isWithinRule("https://reddit.com/x", real, fixture), true);
	assert.equal(isWithinRule("http://reddit.com:8080/x", real, fixture), false);
	assert.equal(isWithinRule("http://reddit.com/x", real, fixture), false);
	assert.equal(isWithinRule("https://reddit.com/", null), false);
	assert.equal(isWithinRule("https://reddit.com/", { host: "com", pathPrefix: "/", subdomains: false }), false);
	assert.equal(isWithinRule("https://reddit.com/", { host: "reddit.com", pathPrefix: "", subdomains: false }), false);
	assert.equal(isWithinRule("https://reddit.com/", { host: "reddit.com", pathPrefix: "/" }), false, "a rule without the subdomains flag is no rule");
});

test("matchOptInRule: most specific rule wins, regardless of order", () => {
	const broad = { host: "example.com", pathPrefix: "/", subdomains: true };
	const sub = { host: "forum.example.com", pathPrefix: "/", subdomains: false };
	const deep = { host: "example.com", pathPrefix: "/docs/api", subdomains: false };
	const mid = { host: "example.com", pathPrefix: "/docs", subdomains: false };
	const rules = [broad, deep, sub, mid, { host: "bogus", pathPrefix: "x", subdomains: false }, null];
	assert.deepEqual(matchOptInRule("https://example.com/", rules), broad);
	assert.deepEqual(matchOptInRule("https://example.com/docs/api/v1", rules), deep);
	assert.deepEqual(matchOptInRule("https://example.com/docs/guide", rules), mid);
	assert.deepEqual(matchOptInRule("https://forum.example.com/docs/api/v1", rules), sub);
	assert.deepEqual(matchOptInRule("https://wiki.example.com/docs/api/v1", rules), broad);
	assert.deepEqual(matchOptInRule("https://example.com/docs/api/v1", [...rules].reverse()), deep);
	assert.equal(matchOptInRule("https://other.example/", rules), null);
	assert.equal(matchOptInRule("http://example.com/", rules), null);
	assert.equal(matchOptInRule("https://example.com/", []), null);
});

test("checkUrl: allows ordinary pages and returns the normalised URL", () => {
	assert.deepEqual(checkUrl("HTTPS://Example.COM./a/../b?q=1"), { allowed: true, url: "https://example.com/b?q=1", host: "example.com" });
	for (const url of ["https://www.reddit.com/r/programming/", "http://example.org/", "https://8.8.8.8/", "https://[2606:4700:4700::1111]/", "https://example.com:8443/x"]) {
		assert.equal(verdict(url), "ok", url);
	}
});

test("checkUrl: query strings and fragments in target URLs are fine and kept as written", () => {
	for (const url of [
		"https://www.reddit.com/search/?q=browser+gateway&sort=new&t=week",
		"https://duckduckgo.com/html/?q=hkdf%20rfc&kl=us-en",
		"https://example.com/path?a=1&b=two&c=%C3%A9&empty=&flag",
		"https://example.com/?redirect=https%3A%2F%2Fother.example%2Fx%3Fy%3D1",
		"https://example.com/docs?page=2#section-3",
		"https://example.com/?",
		"https://example.com/?q=a%2Fb%2F..%2Fc",
	]) {
		assert.deepEqual(checkUrl(url), { allowed: true, url, host: new URL(url).hostname }, url);
	}
	// A private or blocklisted host named only inside the query is not what gets fetched.
	assert.equal(verdict("https://example.com/?next=http://127.0.0.1/"), "ok");
	assert.equal(verdict("https://example.com/?u=https://mail.google.com/"), "ok");
});

test("checkUrl: every address trick ends up refused as a private address", () => {
	for (const url of [
		"http://127.0.0.1/",
		"http://127.0.0.1:8791/v1/status",
		"http://2130706433/",
		"http://0x7f.1/",
		"http://0x7f000001/",
		"http://127.1/",
		"http://017700000001/",
		"http://127.0.0.1./",
		"http://0/",
		"http://0.0.0.0:8791/",
		"http://10.0.0.1/",
		"http://172.16.0.1/",
		"http://192.168.1.1/admin",
		"http://3232235777/",
		"http://169.254.169.254/latest/meta-data/",
		"http://100.100.100.100/",
		"http://[::1]/",
		"http://[::1]:8791/",
		"http://[0:0:0:0:0:0:0:1]/",
		"http://[::]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[::FFFF:7F00:1]/",
		"http://[::127.0.0.1]/",
		"http://[64:ff9b::127.0.0.1]/",
		"http://[64:ff9b::a00:1]/",
		"http://[fd00::1]/",
		"http://[fe80::1]/",
		"http://[2002:7f00:1::]/",
		"http://①②⑦.0.0.1/",
		"https://127.0.0.1/",
	]) {
		assert.equal(verdict(url), REASON.PRIVATE_ADDRESS, url);
	}
});

test("checkUrl: local names, onion, single labels, blocklist", () => {
	/** @type {[string, string][]} */
	const table = [
		["http://localhost/", REASON.LOCAL_NAME],
		["http://LOCALHOST:8791/", REASON.LOCAL_NAME],
		["http://localhost./", REASON.LOCAL_NAME],
		["http://app.localhost/", REASON.LOCAL_NAME],
		["http://printer.local/", REASON.LOCAL_NAME],
		["http://db.internal/", REASON.LOCAL_NAME],
		["http://nas.lan/", REASON.LOCAL_NAME],
		["http://router.home.arpa/", REASON.LOCAL_NAME],
		["http://expyuzz4wqqyqhjn.onion/", REASON.ONION],
		["http://router/", REASON.SINGLE_LABEL],
		["https://wiki/page", REASON.SINGLE_LABEL],
		["https://intranet/wiki", REASON.LOCAL_NAME],
		["https://mail.google.com/mail/u/0/", REASON.BLOCKLISTED],
		["https://MAIL.GOOGLE.COM./", REASON.BLOCKLISTED],
		["https://www.paypal.com/", REASON.BLOCKLISTED],
		["https://accounts.google.com/signin", REASON.BLOCKLISTED],
		["ftp://example.com/", REASON.SCHEME],
		["https://user:pw@example.com/", REASON.USERINFO],
		["not a url", REASON.INVALID_URL],
	];
	for (const [url, reason] of table) assert.equal(verdict(url), reason, url);
});

test("checkUrl: a custom blocklist replaces the default", () => {
	assert.equal(verdict("https://mail.google.com/", { blocklist: [] }), "ok");
	assert.equal(verdict("https://docs.example.com/", { blocklist: ["example.com"] }), REASON.BLOCKLISTED);
	assert.equal(verdict("https://badexample.com/", { blocklist: ["example.com"] }), "ok");
	// The blocklist cannot be used to open up private targets.
	assert.equal(verdict("http://127.0.0.1/", { blocklist: [] }), REASON.PRIVATE_ADDRESS);
});

test("checkUrl: loopback escape hatch is off by default and exact when on", () => {
	assert.equal(verdict("http://127.0.0.1:18080/"), REASON.PRIVATE_ADDRESS);
	assert.equal(verdict("http://127.0.0.1:18080/", {}), REASON.PRIVATE_ADDRESS);
	assert.equal(verdict("http://127.0.0.1:18080/", { allowLoopbackPorts: [] }), REASON.PRIVATE_ADDRESS);

	const opts = { allowLoopbackPorts: [18080] };
	assert.equal(verdict("http://127.0.0.1:18080/x", opts), "ok");
	assert.equal(verdict("http://a.localhost:18080/x", opts), "ok");
	assert.equal(verdict("http://localhost:18080/", opts), "ok");
	assert.equal(verdict("http://[::1]:18080/", opts), "ok");
	// Other ports, other private hosts and look-alikes stay closed.
	assert.equal(verdict("http://127.0.0.1:18081/", opts), REASON.PRIVATE_ADDRESS);
	assert.equal(verdict("http://127.0.0.1/", opts), REASON.PRIVATE_ADDRESS);
	assert.equal(verdict("http://127.0.0.2:18080/", opts), REASON.PRIVATE_ADDRESS);
	assert.equal(verdict("http://10.0.0.1:18080/", opts), REASON.PRIVATE_ADDRESS);
	assert.equal(verdict("http://192.168.1.1:18080/", opts), REASON.PRIVATE_ADDRESS);
	assert.equal(verdict("http://printer.local:18080/", opts), REASON.LOCAL_NAME);
	assert.equal(verdict("http://localhost:18081/", opts), REASON.LOCAL_NAME);
	assert.equal(verdict("http://notlocalhost:18080/", opts), REASON.SINGLE_LABEL);
	// Port 80 only counts when it is listed.
	assert.equal(verdict("http://127.0.0.1/", { allowLoopbackPorts: [80] }), "ok");
	assert.equal(verdict("https://127.0.0.1/", { allowLoopbackPorts: [80] }), REASON.PRIVATE_ADDRESS);
	// The blocklist still applies to fixture hosts.
	assert.equal(verdict("http://a.localhost:18080/", { allowLoopbackPorts: [18080], blocklist: ["a.localhost"] }), REASON.BLOCKLISTED);
});
