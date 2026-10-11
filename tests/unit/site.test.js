// The site a host belongs to (extension/shared/site.js) and the table of
// shared names behind it (extension/shared/suffixes.js), which the login
// rules use as well (tests/unit/policy.test.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { siteOf } from "../../extension/shared/site.js";
import {
	ALL_SECOND_LEVEL_COUNTRIES,
	COUNTRY_SECOND_LEVELS,
	PROVIDER_ZONES,
	SECOND_LEVEL_LABELS,
	SHARED_SUFFIXES,
	inProviderZone,
	isSharedSuffix,
	sharedSuffixOf,
} from "../../extension/shared/suffixes.js";

test("siteOf: under a name that many owners share, each of them is a site of its own", () => {
	/** @type {[string, string][]} */
	const table = [
		// Hosting names: one page there cannot use up its neighbours' budget, or put them on a cooldown.
		["a.github.io", "a.github.io"],
		["b.github.io", "b.github.io"],
		["docs.a.github.io", "a.github.io"],
		["x.gitlab.io", "x.gitlab.io"],
		["shop.myshopify.com", "shop.myshopify.com"],
		["someone.wordpress.com", "someone.wordpress.com"],
		["www.someone.wordpress.com", "someone.wordpress.com"],
		["x.blogspot.com", "x.blogspot.com"],
		["x.blogspot.de", "x.blogspot.de"],
		["x.blogspot.co.uk", "x.blogspot.co.uk"],
		["app.herokuapp.com", "app.herokuapp.com"],
		["x.pages.dev", "x.pages.dev"],
		["pub-1.r2.dev", "pub-1.r2.dev"],
		["x.ngrok-free.app", "x.ngrok-free.app"],
		["example-com.translate.goog", "example-com.translate.goog"],
		["d111.cloudfront.net", "d111.cloudfront.net"],
		["svc.up.railway.app", "svc.up.railway.app"],
		// Registries under a generic ending.
		["shop.uk.com", "shop.uk.com"],
		["www.shop.uk.com", "shop.uk.com"],
		["x.us.com", "x.us.com"],
		["x.eu.org", "x.eu.org"],
		// Second levels of country registries.
		["x.ne.jp", "x.ne.jp"],
		["www.x.or.jp", "x.or.jp"],
		["b.gv.at", "b.gv.at"],
		["x.id.au", "x.id.au"],
		["www.england.nhs.uk", "england.nhs.uk"],
		["www.x.gouv.fr", "x.gouv.fr"],
		["x.pp.ua", "x.pp.ua"],
		["www.metro.tokyo.jp", "metro.tokyo.jp"],
		["x.on.ca", "x.on.ca"],
		["a.b.example.com.np", "example.com.np"],
		["x.y.pg", "x.y.pg"],
		["www.ci.sf.ca.us", "sf.ca.us"],
		["www.school.k12.ca.us", "school.k12.ca.us"],
		// A provider's zone: hosts at any depth, each a customer's.
		["x.s3.amazonaws.com", "x.s3.amazonaws.com"],
		["bucket.s3.eu-west-1.amazonaws.com", "bucket.s3.eu-west-1.amazonaws.com"],
		["abc.execute-api.us-east-1.amazonaws.com", "abc.execute-api.us-east-1.amazonaws.com"],
		["acct.blob.core.windows.net", "acct.blob.core.windows.net"],
		["acct.z6.web.core.windows.net", "acct.z6.web.core.windows.net"],
		["vm.westeurope.cloudapp.azure.com", "vm.westeurope.cloudapp.azure.com"],
		["svc-abc-uc.a.run.app", "svc-abc-uc.a.run.app"],
		// The shared name itself, should it ever be a host.
		["github.io", "github.io"],
		["co.uk", "co.uk"],
		["s3.amazonaws.com", "s3.amazonaws.com"],
		["blogspot.co.uk", "blogspot.co.uk"],
		// Everything else is as it was: the last two labels, or three under a country's second level.
		["example.com", "example.com"],
		["www.example.com", "example.com"],
		["a.b.c.example.org", "example.org"],
		["www.example.co.uk", "example.co.uk"],
		["a.b.example.com.au", "example.com.au"],
		["www.heise.de", "heise.de"],
		["x.co.example.com", "example.com"],
		["github.com", "github.com"],
		["gist.github.com", "github.com"],
		["portal.azure.com", "azure.com"],
		["console.aws.amazon.com", "amazon.com"],
		["a.example.blog.fr", "blog.fr"],
		["EXAMPLE.co.uk.", "example.co.uk"],
		["localhost", "localhost"],
		["a.localhost", "a.localhost"],
		["93.184.216.34", "93.184.216.34"],
		["[2001:db8::1]", "[2001:db8:0:0::/64]"],
		["[::ffff:93.184.216.34]", "93.184.216.34"],
	];
	for (const [host, site] of table) assert.equal(siteOf(host), site, host);
	// Two hosts of different owners no longer share a key; two hosts of one owner still do.
	assert.notEqual(siteOf("a.github.io"), siteOf("b.github.io"));
	assert.notEqual(siteOf("x.s3.amazonaws.com"), siteOf("y.s3.amazonaws.com"));
	assert.equal(siteOf("s1.evil.example"), siteOf("s2.evil.example"));
	assert.equal(siteOf("a.shop.co.uk"), siteOf("b.shop.co.uk"));
	// Whatever the input, the answer is a string, and a host without a label left over is returned whole.
	for (const odd of ["", ".", "a..b", "a.b.", "..", "com", "x.github.io.", "[not:an:address]"]) assert.equal(typeof siteOf(odd), "string", odd);
	assert.equal(siteOf("a..github.io"), "a..github.io");
});

test("the table of shared names: what it answers", () => {
	/** @type {[string, string | null][]} */
	const table = [
		["example.com", null],
		["www.example.com", null],
		["example.de", null],
		["co.uk", "co.uk"],
		["example.co.uk", "co.uk"],
		["a.b.example.co.uk", "co.uk"],
		["github.io", "github.io"],
		["x.github.io", "github.io"],
		["s3.amazonaws.com", "s3.amazonaws.com"],
		["x.s3.amazonaws.com", "s3.amazonaws.com"],
		["x.s3.eu-west-1.amazonaws.com", "amazonaws.com"],
		["amazonaws.com", "amazonaws.com"],
		["amazon.com", null],
		["blogspot.com", "blogspot.com"],
		["x.blogspot.com.au", "blogspot.com.au"],
		["blogspot.example.com", null],
		["nhs.uk", "nhs.uk"],
		["x.tokyo.jp", "tokyo.jp"],
		["x.ca.us", "ca.us"],
		["x.k12.ca.us", "k12.ca.us"],
		["x.cc.ny.us", "cc.ny.us"],
		["example.us", null],
		["x.y.np", "y.np"],
		// Only under a two-letter country code: "co.example.com" and "com.com" are nobody's registry.
		["co.com", "co.com"],
		["x.co.example.com", null],
		["com.example", null],
		["org.info", null],
		["constructor.constructor", null],
		["x.__proto__", null],
		// Not names at all.
		["com", null],
		["", null],
		["a..b", null],
		["[2001:db8::1]", null],
	];
	for (const [host, suffix] of table) {
		assert.equal(sharedSuffixOf(host), suffix, host);
		assert.equal(isSharedSuffix(host), suffix === host && suffix !== null, host);
	}
	// Below a zone, and only below.
	for (const host of ["x.amazonaws.com", "bucket.s3.eu-west-1.amazonaws.com", "a.blob.core.windows.net", "vm.westeurope.cloudapp.azure.com", "x.lambda-url.eu-west-1.on.aws"]) assert.equal(inProviderZone(host), true, host);
	for (const host of ["amazonaws.com", "amazon.com", "aws.amazon.com", "portal.azure.com", "azure.com", "example.com", "notamazonaws.com", "amazonaws.com.example.org", "com", ""]) assert.equal(inProviderZone(host), false, host);
});

test("the table of shared names: tidy, and nothing that was known before is missing", () => {
	const name = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
	for (const entry of [...SHARED_SUFFIXES, ...PROVIDER_ZONES]) assert.match(entry, name, entry);
	for (const label of SECOND_LEVEL_LABELS) assert.match(label, /^[a-z0-9]{2,5}$/, label);
	for (const code of ALL_SECOND_LEVEL_COUNTRIES) assert.match(code, /^[a-z]{2}$/, code);
	for (const [code, labels] of Object.entries(COUNTRY_SECOND_LEVELS)) {
		assert.match(code, /^[a-z]{2}$/, code);
		assert.ok(labels.size > 0, code);
		for (const label of labels) {
			assert.match(label, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, `${label}.${code}`);
			assert.equal(SECOND_LEVEL_LABELS.has(label), false, `${label}.${code} is covered by the general labels already`);
		}
	}
	assert.equal(Object.isFrozen(COUNTRY_SECOND_LEVELS), true);
	// What the two older lists held, the one of the pacing and the one of the login rules.
	for (const label of ["co", "com", "org", "net", "gov", "ac", "edu", "or", "ne", "go", "gob", "mil", "nom", "sch", "ltd", "plc", "me", "info", "biz"]) {
		assert.equal(SECOND_LEVEL_LABELS.has(label), true, label);
		assert.equal(isSharedSuffix(`${label}.uk`), true, label);
	}
	for (const host of [
		"github.io", "gitlab.io", "pages.dev", "workers.dev", "netlify.app", "vercel.app", "herokuapp.com", "web.app", "firebaseapp.com", "appspot.com", "blogspot.com",
		"cloudfront.net", "azurewebsites.net", "amazonaws.com", "s3.amazonaws.com", "onrender.com", "fly.dev", "glitch.me", "neocities.org", "readthedocs.io",
	]) {
		assert.equal(isSharedSuffix(host), true, host);
	}
	// The file is loaded by the daemon and by the extension's pages alike: nothing of Node, nothing of a page.
	const source = fs.readFileSync(fileURLToPath(new URL("../../extension/shared/suffixes.js", import.meta.url)), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
	assert.equal(/\bimport\b|\brequire\(|\bprocess\b|\bdocument\b|\bwindow\b|\bbrowser\b|\bfetch\(/.test(source), false);
});
