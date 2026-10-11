// What a file is by its first bytes, whether it may be kept, and the hash that
// is computed while it arrives.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Sha256, sha256Hex } from "../../extension/shared/sha256.js";
import { ALLOW_ENTRY_RE, DEFAULT_ALLOW_TYPES, FILE_CODE, REFUSED_CLASS, SNIFFED_TYPES, SNIFF_BYTES, decideFile, isTextType, sniff, typeAllowed } from "../../extension/shared/sniff.js";

/** @param {string | number[]} head @param {number} [size] @returns {Buffer} */
const bytes = (head, size = 0) => {
	const start = typeof head === "string" ? Buffer.from(head, "latin1") : Buffer.from(head);
	return size > start.length ? Buffer.concat([start, Buffer.alloc(size - start.length, 0)]) : start;
};
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const TAR = Buffer.concat([Buffer.alloc(257, 0x61), Buffer.from("ustar\0" + "00"), Buffer.alloc(240, 0)]);

test("SHA-256 in pieces: the same as the runtime's own, at every length around a block and however it is cut", () => {
	assert.equal(sha256Hex(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	assert.equal(sha256Hex(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 111, 119, 120, 121, 127, 128, 129, 1000, 65535, 65536, 196608, 300001]) {
		const data = crypto.randomBytes(n);
		const want = crypto.createHash("sha256").update(data).digest("hex");
		assert.equal(sha256Hex(data), want, `${n} bytes at once`);
		for (const step of [1, 7, 63, 64, 65, 4096]) {
			if (n > 4096 && step < 63) continue;
			const h = new Sha256();
			for (let i = 0; i < n; i += step) h.update(data.subarray(i, i + step));
			assert.equal(h.digestHex(), want, `${n} bytes in pieces of ${step}`);
		}
	}
	const h = new Sha256().update(Buffer.from("abc"));
	assert.equal(h.digestHex(), h.digestHex(), "asked twice, the same answer");
	assert.throws(() => h.update(Buffer.from("d")), /already taken/);
});

test("sniff: every type that can be kept is told by its magic number", () => {
	/** @type {[string, Buffer, string][]} */
	const table = [
		["a PDF", bytes("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"), "application/pdf"],
		["a zip", bytes([0x50, 0x4b, 0x03, 0x04, 20, 0]), "application/zip"],
		["an empty zip", bytes([0x50, 0x4b, 0x05, 0x06, 0, 0]), "application/zip"],
		["a spanned zip", bytes([0x50, 0x4b, 0x07, 0x08, 0, 0]), "application/zip"],
		["gzip", bytes([0x1f, 0x8b, 8, 0]), "application/gzip"],
		["a tar archive", TAR, "application/x-tar"],
		["a PNG", bytes(PNG, 40), "image/png"],
		["a JPEG", bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16]), "image/jpeg"],
		["a GIF87a", bytes("GIF87a\x01\x00"), "image/gif"],
		["a GIF89a", bytes("GIF89a\x01\x00"), "image/gif"],
		["WebP", bytes("RIFF\x1a\x00\x00\x00WEBPVP8L"), "image/webp"],
		["JSON, an object", bytes('  {"a": 1}'), "application/json"],
		["JSON, a list", bytes("[1, 2]"), "application/json"],
		["XML", bytes('<?xml version="1.0"?><a/>'), "application/xml"],
		["XML without a declaration", bytes("<feed xmlns='x'/>"), "application/xml"],
		["plain text", bytes("just words\nand lines\n"), "text/plain"],
		["text with a UTF-8 mark", bytes([0xef, 0xbb, 0xbf, 0x68, 0x69]), "text/plain"],
		["text in UTF-16", bytes([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), "text/plain"],
		["text in another 8-bit charset", bytes([0x67, 0x72, 0xfc, 0xdf, 0x65]), "text/plain"],
		["CSV", bytes("a,b\n1,2\n"), "text/plain"],
		["nothing at all", bytes(""), "application/x-empty"],
		["bytes of no known kind", bytes([0x00, 0x01, 0x02, 0x03]), "application/octet-stream"],
	];
	for (const [label, head, type] of table) {
		const s = sniff(head);
		assert.equal(s.type, type, label);
		assert.equal(s.refused, null, label);
		assert.ok(SNIFFED_TYPES.includes(s.type), label);
	}
	assert.equal(sniff(bytes("words")).text, true);
	assert.equal(sniff(bytes("%PDF-1.4")).text, false);
	assert.equal(sniff(bytes([0, 1, 2])).text, false);
	assert.ok(SNIFF_BYTES >= 512, "the look reaches the tar magic at offset 257");
});

test("sniff: what is never kept, whatever it is declared as", () => {
	/** @type {[string, Buffer, string][]} */
	const table = [
		["ELF", bytes([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 64), REFUSED_CLASS.EXECUTABLE],
		["a Windows program", bytes([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00], 64), REFUSED_CLASS.EXECUTABLE],
		["Mach-O, 32 bit", bytes([0xfe, 0xed, 0xfa, 0xce], 32), REFUSED_CLASS.EXECUTABLE],
		["Mach-O, 64 bit", bytes([0xfe, 0xed, 0xfa, 0xcf], 32), REFUSED_CLASS.EXECUTABLE],
		["Mach-O, the other byte order", bytes([0xcf, 0xfa, 0xed, 0xfe], 32), REFUSED_CLASS.EXECUTABLE],
		["Mach-O, 32 bit, the other byte order", bytes([0xce, 0xfa, 0xed, 0xfe], 32), REFUSED_CLASS.EXECUTABLE],
		["a universal binary or a Java class", bytes([0xca, 0xfe, 0xba, 0xbe], 32), REFUSED_CLASS.EXECUTABLE],
		["WebAssembly", bytes([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), REFUSED_CLASS.EXECUTABLE],
		["Android dex", bytes("dex\n035\x00"), REFUSED_CLASS.EXECUTABLE],
		["a shell script", bytes("#!/bin/sh\nrm -rf ~\n"), REFUSED_CLASS.SCRIPT],
		["a script behind blank lines", bytes("\n\n  #!/usr/bin/env python3\n"), REFUSED_CLASS.SCRIPT],
		["a script behind a UTF-8 mark", bytes([0xef, 0xbb, 0xbf, 0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e]), REFUSED_CLASS.SCRIPT],
		["a Windows shortcut", bytes([0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00], 76), REFUSED_CLASS.SHORTCUT],
		["an MSI installer (any OLE compound file)", bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 64), REFUSED_CLASS.INSTALLER],
		["a cabinet", bytes("MSCF\x00\x00\x00\x00"), REFUSED_CLASS.INSTALLER],
		["a Debian package", bytes("!<arch>\ndebian-binary"), REFUSED_CLASS.INSTALLER],
		["an RPM", bytes([0xed, 0xab, 0xee, 0xdb, 3, 0]), REFUSED_CLASS.INSTALLER],
	];
	for (const [label, head, refused] of table) {
		assert.equal(sniff(head).refused, refused, label);
		// Declared as anything on the list: refused all the same, with that reason.
		for (const declared of ["application/pdf", "image/png", "text/plain", "application/json", "application/zip", "application/octet-stream"]) {
			assert.deepEqual(decideFile({ declared, head, allow: DEFAULT_ALLOW_TYPES }), { ok: false, code: FILE_CODE.REFUSED, sniffed: sniff(head).type, refused }, `${label} as ${declared}`);
		}
	}
});

test("sniff: look-alikes are not taken for what they resemble", () => {
	// Text that happens to begin with the two letters of a DOS header is text; a header has binary fields behind them.
	assert.deepEqual(sniff(bytes("MZ,first,second\n1,2,3\n")), { type: "text/plain", refused: null, text: true });
	assert.equal(sniff(bytes("MZ")).refused, null);
	assert.equal(sniff(bytes([0x4d, 0x5a, 0x00, 0x01])).refused, REFUSED_CLASS.EXECUTABLE);
	// A PDF, a zip or a PNG marker that is not at the very start is no such file.
	assert.equal(sniff(bytes(" %PDF-1.4")).type, "text/plain");
	assert.equal(sniff(bytes("xPK\x03\x04")).type, "application/octet-stream");
	assert.equal(sniff(bytes([0x00, ...PNG])).type, "application/octet-stream");
	// "RIFF" alone is not WebP (it is also WAV and AVI).
	assert.equal(sniff(bytes("RIFF\x1a\x00\x00\x00WAVEfmt ")).type, "application/octet-stream");
	// "ustar" anywhere but at 257 is not a tar archive.
	assert.equal(sniff(bytes("ustar is a word")).type, "text/plain");
	// A hash sign without the bang is a comment, not a script.
	assert.equal(sniff(bytes("# a heading\n")).refused, null);
	assert.equal(sniff(bytes("#include <stdio.h>\n")).refused, null);
	// HTML is told from XML and from text, also behind white space and in capitals.
	for (const html of ["<!DOCTYPE html><p>", "\n\n <HTML>", "<html lang=en>", "<script>alert(1)</script>", "<body onload=x>", "<!-- c --><p>", "<iframe src=x>", "<a href=x>", "<title>t</title>"]) {
		assert.equal(sniff(bytes(html)).type, "text/html", html);
	}
	// An SVG is XML, and is named as what it is: never taken for a web page, never for a picture of the binary kind.
	assert.deepEqual(sniff(bytes("<svg onload=x>")), { type: "image/svg+xml", refused: null, text: true });
	assert.equal(sniff(bytes("<abbr>")).type, "application/xml", "a tag that only begins like an HTML one");
	// One byte that only binary data has makes it binary; tab, line ends, form feed and escape do not.
	assert.equal(sniff(bytes("text\twith\r\n\x0c\x1b marks")).text, true);
	assert.equal(sniff(bytes("text with a \x01 in it")).text, false);
	assert.equal(sniff(bytes("text with a \x00 in it")).type, "application/octet-stream");
});

test("the allowlist: exact types and suffixes; the default is the documented one", () => {
	assert.deepEqual(
		[...DEFAULT_ALLOW_TYPES],
		["application/pdf", "application/json", "+json", "application/xml", "text/xml", "+xml", "text/plain", "text/csv", "text/markdown", "image/png", "image/jpeg", "image/gif", "image/webp", "application/zip", "application/gzip", "application/x-tar", "application/octet-stream"],
	);
	for (const entry of DEFAULT_ALLOW_TYPES) assert.match(entry, ALLOW_ENTRY_RE);
	for (const bad of ["", "pdf", "Application/PDF", "text/plain; charset=utf-8", "+", "text/*", "*/*", "a/b/c", " text/plain", "+JSON", "text/"]) assert.doesNotMatch(bad, ALLOW_ENTRY_RE, bad);
	for (const type of ["application/pdf", "application/ld+json", "application/vnd.api+json", "image/svg+xml", "application/rss+xml", "text/csv", "application/octet-stream"]) {
		assert.equal(typeAllowed(type, DEFAULT_ALLOW_TYPES), true, type);
	}
	for (const type of ["text/html", "application/javascript", "image/avif", "video/mp4", "application/x-msdownload", "+json", "json", "application/jsonx", "x+jsonp"]) {
		assert.equal(typeAllowed(type, DEFAULT_ALLOW_TYPES), false, type);
	}
	assert.equal(typeAllowed("application/pdf", []), false);
	assert.equal(typeAllowed("application/x+json", ["+json"]), true);
	for (const type of ["text/plain", "text/csv", "text/markdown", "application/json", "application/ld+json", "application/xml", "text/xml", "image/svg+xml"]) assert.equal(isTextType(type), true, type);
	for (const type of ["application/pdf", "image/png", "application/zip", "application/octet-stream"]) assert.equal(isTextType(type), false, type);
});

test("decideFile: declared and actual type must fit together", () => {
	const allow = DEFAULT_ALLOW_TYPES;
	/** @param {string | null} declared @param {Buffer} head */
	const d = (declared, head) => decideFile({ declared, head, allow });
	const pdf = bytes("%PDF-1.4\n");
	const zip = bytes([0x50, 0x4b, 0x03, 0x04]);
	const png = bytes(PNG, 32);
	const jpeg = bytes([0xff, 0xd8, 0xff, 0xdb]);
	const html = bytes("<!doctype html><script>alert(1)</script>");
	const json = bytes('{"a":1}');
	const text = bytes("plain words");
	const unknown = bytes([0, 1, 2, 3, 4]);

	// What fits.
	assert.deepEqual(d("application/pdf", pdf), { ok: true, sniffed: "application/pdf", textLike: false });
	assert.deepEqual(d("application/zip", zip), { ok: true, sniffed: "application/zip", textLike: false });
	assert.deepEqual(d("application/gzip", bytes([0x1f, 0x8b, 8])), { ok: true, sniffed: "application/gzip", textLike: false });
	assert.deepEqual(d("application/x-tar", TAR), { ok: true, sniffed: "application/x-tar", textLike: false });
	assert.deepEqual(d("image/png", png), { ok: true, sniffed: "image/png", textLike: false });
	assert.deepEqual(d("image/png", jpeg), { ok: true, sniffed: "image/jpeg", textLike: false }, "another image than declared is still an image, and is named as what it is");
	assert.deepEqual(d("application/json", json), { ok: true, sniffed: "application/json", textLike: true });
	assert.deepEqual(d("application/ld+json", json), { ok: true, sniffed: "application/json", textLike: true });
	assert.deepEqual(d("application/json", text), { ok: true, sniffed: "text/plain", textLike: true }, "text that is no JSON is still text: it is shown as text, nothing parses it");
	assert.deepEqual(d("application/xml", bytes("<?xml version='1.0'?><a/>")), { ok: true, sniffed: "application/xml", textLike: true });
	assert.deepEqual(d("text/plain", text), { ok: true, sniffed: "text/plain", textLike: true });
	assert.deepEqual(d("text/plain", html), { ok: false, code: FILE_CODE.MISMATCH, sniffed: "text/html", refused: null }, "a web page declared as text is a web page all the same");
	// CSV has no mark of its own: it is told by its declared type, where the text begins like plain text, and by nothing else.
	assert.deepEqual(d("text/csv", bytes("a,b\n")), { ok: true, sniffed: "text/csv", textLike: true });
	assert.deepEqual(d("text/csv", bytes('{"a":1}')), { ok: true, sniffed: "text/plain", textLike: true }, "what begins like JSON is not called CSV");
	assert.deepEqual(d("text/csv", bytes("<rows><row/></rows>")), { ok: true, sniffed: "text/plain", textLike: true }, "nor what begins with markup");
	assert.deepEqual(d("text/plain", bytes("a,b\n1,2\n")), { ok: true, sniffed: "text/plain", textLike: true }, "a table under another type is plain text");
	assert.deepEqual(d("application/octet-stream", bytes("a,b\n1,2\n")), { ok: true, sniffed: "text/plain", textLike: true });
	assert.deepEqual(d("text/csv", zip), { ok: false, code: FILE_CODE.MISMATCH, sniffed: "application/zip", refused: null }, "an archive declared as a table");
	assert.deepEqual(d("text/csv", bytes("#!/bin/sh\na,b\n")), { ok: false, code: FILE_CODE.REFUSED, sniffed: "text/x-script", refused: REFUSED_CLASS.SCRIPT }, "a script declared as a table");
	assert.deepEqual(d("text/csv", html), { ok: false, code: FILE_CODE.MISMATCH, sniffed: "text/html", refused: null }, "a web page declared as a table");
	assert.deepEqual(decideFile({ declared: "text/csv", head: bytes("a,b\n"), allow: ["text/plain"] }), { ok: false, code: FILE_CODE.NOT_ALLOWED, sniffed: null, refused: null });
	assert.ok(SNIFFED_TYPES.includes("text/csv"));
	assert.deepEqual(d("text/markdown", bytes("# title\n")), { ok: true, sniffed: "text/plain", textLike: true });
	assert.deepEqual(d("text/plain", bytes("")), { ok: true, sniffed: "text/plain", textLike: true }, "an empty text file");

	// A mismatch that matters.
	/** @type {[string, Buffer, string][]} */
	const mismatches = [
		["image/png", html, "text/html"],
		["image/jpeg", bytes("<script>fetch('//evil')</script>"), "text/html"],
		["image/gif", text, "text/plain"],
		["image/webp", pdf, "application/pdf"],
		["image/png", unknown, "application/octet-stream"],
		["image/png", bytes(""), "application/x-empty"],
		["application/pdf", html, "text/html"],
		["application/pdf", zip, "application/zip"],
		["application/pdf", unknown, "application/octet-stream"],
		["application/pdf", bytes(""), "application/x-empty"],
		["application/zip", pdf, "application/pdf"],
		["application/gzip", zip, "application/zip"],
		["application/x-tar", bytes("no magic here"), "text/plain"],
		["application/json", pdf, "application/pdf"],
		["application/json", unknown, "application/octet-stream"],
		["text/plain", png, "image/png"],
		["text/plain", html, "text/html"],
		["text/markdown", html, "text/html"],
		["application/json", html, "text/html"],
		["application/xml", html, "text/html"],
		["image/svg+xml", html, "text/html"],
		["text/csv", zip, "application/zip"],
		["application/xml", unknown, "application/octet-stream"],
	];
	for (const [declared, head, sniffed] of mismatches) {
		assert.deepEqual(d(declared, head), { ok: false, code: FILE_CODE.MISMATCH, sniffed, refused: null }, `${declared} that is ${sniffed}`);
	}

	// application/octet-stream says nothing: kept only as what it turns out to be, when that is on the list too.
	assert.deepEqual(d("application/octet-stream", pdf), { ok: true, sniffed: "application/pdf", textLike: false });
	assert.deepEqual(d("application/octet-stream", zip), { ok: true, sniffed: "application/zip", textLike: false });
	assert.deepEqual(d("application/octet-stream", text), { ok: true, sniffed: "text/plain", textLike: true });
	assert.deepEqual(d("application/octet-stream", unknown), { ok: false, code: FILE_CODE.MISMATCH, sniffed: "application/octet-stream", refused: null });
	assert.deepEqual(d("application/octet-stream", html), { ok: false, code: FILE_CODE.MISMATCH, sniffed: "text/html", refused: null });
	assert.deepEqual(d("application/octet-stream", bytes("")), { ok: false, code: FILE_CODE.MISMATCH, sniffed: "application/x-empty", refused: null });
	assert.deepEqual(decideFile({ declared: "application/octet-stream", head: pdf, allow: ["application/octet-stream", "text/plain"] }), { ok: false, code: FILE_CODE.MISMATCH, sniffed: "application/pdf", refused: null }, "a PDF, with PDF taken off the list");

	// Not on the list: refused before the bytes are even looked at.
	for (const declared of ["text/html", "video/mp4", "application/x-msdownload", "image/avif", null]) {
		assert.deepEqual(d(declared, pdf), { ok: false, code: FILE_CODE.NOT_ALLOWED, sniffed: null, refused: null }, String(declared));
	}
	assert.deepEqual(decideFile({ declared: "application/pdf", head: pdf, allow: ["text/plain"] }), { ok: false, code: FILE_CODE.NOT_ALLOWED, sniffed: null, refused: null });

	// A type the operator added themselves: anything but a web page, and never one of the refused kinds.
	const own = [...allow, "application/vnd.example.report"];
	assert.deepEqual(decideFile({ declared: "application/vnd.example.report", head: zip, allow: own }), { ok: true, sniffed: "application/zip", textLike: false });
	assert.deepEqual(decideFile({ declared: "application/vnd.example.report", head: unknown, allow: own }), { ok: true, sniffed: "application/octet-stream", textLike: false });
	assert.deepEqual(decideFile({ declared: "application/vnd.example.report", head: html, allow: own }), { ok: false, code: FILE_CODE.MISMATCH, sniffed: "text/html", refused: null });
	assert.equal(decideFile({ declared: "application/vnd.example.report", head: bytes([0x7f, 0x45, 0x4c, 0x46]), allow: own }).ok, false);

	// Only the head is looked at, however much is handed in.
	const long = Buffer.concat([pdf, Buffer.alloc(SNIFF_BYTES * 4, 0x20)]);
	assert.deepEqual(d("application/pdf", long), { ok: true, sniffed: "application/pdf", textLike: false });
});

// HTML served as text/plain was kept, although HTML behind another type is refused.
test("HTML or script is refused under every declared type, a text type included; plain text, Markdown, JSON, XML and SVG pass", () => {
	const allow = [...DEFAULT_ALLOW_TYPES, "application/vnd.example.report"];
	/** @param {string} declared @param {string | Buffer} head */
	const d = (declared, head) => decideFile({ declared, head: typeof head === "string" ? bytes(head) : head, allow });
	const refused = { ok: false, code: FILE_CODE.MISMATCH, sniffed: "text/html", refused: null };
	// What a document or a script begins with, behind a byte order mark, white space, comments and capitals alike.
	const pages = [
		"<!DOCTYPE html><html><body><script>alert(1)</script>",
		"<!doctype HTML PUBLIC \"-//W3C//DTD HTML 4.01//EN\">",
		"\ufeff".replace("\ufeff", "\xef\xbb\xbf") + "<html>",
		" \r\n\t<HtMl lang=en>",
		"<head><title>x</title>",
		"<body onload=steal()>",
		"<script>fetch('//evil.example')</script>",
		"<SCRIPT src=//evil.example/x.js>",
		"<!-- a comment first --> <script>x</script>",
		"<!-- one --><!-- two -->\n<iframe src=//evil.example>",
		"<!--><html><script>alert(1)</script><!-- -->",
		"<!---><script>alert(1)</script>",
		"<!doctypehtml><script>alert(1)</script>",
		"<style>*{}</style><script>",
		"<title>t</title>",
		"<meta http-equiv=refresh content='0;url=//evil.example'>",
		"<link rel=import href=x>",
		"<base href=//evil.example/>",
		"<form action=//evil.example>",
		"<object data=x>",
		"<embed src=x>",
		"<frameset><frame src=x>",
		"<noscript>",
		"<template>",
		// XHTML: XML whose root is html, with or without a prefix.
		"<?xml version=\"1.0\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\"><script/></html>",
		"<?xml version=\"1.0\"?><!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" \"x\"><html/>",
		"<?xml version=\"1.0\"?><x:html xmlns:x=\"http://www.w3.org/1999/xhtml\"/>",
		// The same behind a doctype whose subset or literals hold what would end it for a careless reader.
		"<?xml version='1.0'?><!DOCTYPE r [<!ENTITY x ']'>]><html xmlns='http://www.w3.org/1999/xhtml'><script/></html>",
		"<?xml version='1.0'?><!DOCTYPE r SYSTEM 'a>b'><html xmlns='http://www.w3.org/1999/xhtml'/>",
	];
	for (const declared of ["text/plain", "text/markdown", "text/csv", "application/json", "application/ld+json", "application/xml", "text/xml", "image/svg+xml", "application/octet-stream", "application/vnd.example.report", "image/png", "application/pdf"]) {
		for (const page of pages) assert.deepEqual(d(declared, page), refused, `${JSON.stringify(page.slice(0, 40))} as ${declared}`);
	}
	// In two-byte units, under its mark, it is the same page.
	for (const wide of [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<html><script>", "utf16le")]), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("<script>x", "utf16le").swap16()])]) {
		assert.deepEqual(d("text/plain", wide), refused);
	}
	assert.deepEqual(d("text/plain", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("plain words", "utf16le")])), { ok: true, sniffed: "text/plain", textLike: true });

	// The mark of two-byte text makes no text of what follows it: the units are held to what text holds.
	const LE = Buffer.from([0xff, 0xfe]);
	const BE = Buffer.from([0xfe, 0xff]);
	/** @param {number[]} units @returns {Buffer} */
	const units = (units) => Buffer.from(units.flatMap((u) => [u & 0xff, u >> 8]));
	const text16 = { ok: true, sniffed: "text/plain", textLike: true };
	const binary = { ok: false, code: FILE_CODE.MISMATCH, sniffed: "application/octet-stream", refused: null };
	for (const [label, body] of /** @type {[string, Buffer][]} */ ([
		["words with a tab, line ends, a form feed and an escape", Buffer.from("col\ta\r\nb\fc\u001b[0m \u00e4 \u65e5\u672c", "utf16le")],
		["a pair", Buffer.from("smile \u{1f600} and on", "utf16le")],
		["a pair cut in two where the head ends", Buffer.concat([Buffer.from("x".repeat(2046), "utf16le"), units([0xd83d])])],
		["an odd byte at the end", Buffer.concat([Buffer.from("words", "utf16le"), Buffer.from([0x41])])],
	])) {
		assert.deepEqual(d("text/plain", Buffer.concat([LE, body])), text16, label);
		assert.deepEqual(d("application/octet-stream", Buffer.concat([LE, body])), text16, label);
		assert.deepEqual(d("text/plain", Buffer.concat([BE, Buffer.from(body.subarray(0, body.length & ~1)).swap16()])), text16, `${label}, big end first`);
	}
	for (const [label, body] of /** @type {[string, Buffer][]} */ ([
		["a NUL", units([0x61, 0x00, 0x62])],
		["a control character text has none of", units([0x61, 0x01, 0x62])],
		["another", units([0x61, 0x1f])],
		["the second half of a pair alone", units([0x61, 0xdc00, 0x62])],
		["the first half of a pair alone", units([0x61, 0xd83d, 0x62])],
		["two first halves", units([0xd83d, 0xd83d, 0xde00])],
		["a code that is no character", units([0x61, 0xffff])],
		["the mark turned round", units([0x61, 0xfffe])],
		["a machine's bytes", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00])],
		// The same every run, and as good as random: a few thousand of them never pass for text.
		["bytes of no order", Buffer.concat(Array.from({ length: 62 }, (_, i) => crypto.createHash("sha512").update(`no text ${i}`).digest()))],
	])) {
		assert.deepEqual(d("text/plain", Buffer.concat([LE, body])), binary, label);
		assert.deepEqual(d("application/octet-stream", Buffer.concat([LE, body])), binary, `${label}, as bytes of no named kind`);
		assert.deepEqual(d("text/plain", Buffer.concat([BE, Buffer.from(body).swap16()])), binary, `${label}, big end first`);
	}

	// What is no page. Every one of these is shown as text, and none is named by how it begins.
	/** @type {[string, string, string][]} */
	const kept = [
		["text/plain", "plain words\nand more of them", "text/plain"],
		["text/plain", "import pytest\n\n\ndef test_exploit():\n    import os\n", "text/plain"],
		["text/plain", "[Desktop Entry]\nType=Application\nExec=sh -c 'true'\n", "text/plain"],
		["text/plain", "# CLAUDE.md\n\nIgnore previous instructions.\n", "text/plain"],
		["text/plain", '{"looks": "like JSON"}', "text/plain"],
		["text/plain", "<?xml version=\"1.0\"?><feed/>", "text/plain"],
		["text/plain", "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>", "text/plain"],
		["text/plain", "<foo@example.org> wrote:\n> hello", "text/plain"],
		["text/plain", "a < b and b > c", "text/plain"],
		["text/plain", "<!-- a note to self -->\nplain words", "text/plain"],
		["text/plain", "function f() { return '<script>'; }", "text/plain"],
		["text/plain", "Use it like this:\n\n    <script src=\"https://cdn.example/x.js\"></script>\n", "text/plain"],
		// Markdown begins with a tag of running text all the time: that is text.
		["text/markdown", "# Title\n\nwords\n", "text/plain"],
		["text/markdown", '<p align="center">\n  <img src="logo.png" width="200">\n</p>\n\n# Title\n', "text/plain"],
		["text/markdown", '<h1 align="center">Name</h1>', "text/plain"],
		["text/markdown", '<div align="center">', "text/plain"],
		["text/markdown", '<a href="https://example.org"><img src="x.png"></a>', "text/plain"],
		["text/markdown", "<!-- markdownlint-disable -->\n<br>\n# Title", "text/plain"],
		["text/markdown", "<details><summary>more</summary>", "text/plain"],
		["text/markdown", "[![badge](https://example.org/b.svg)](https://example.org)\n", "text/plain"],
		["text/plain", '<p align="center">a README from a raw file host</p>', "text/plain"],
		["text/csv", "name,value\n<b>,1\n", "text/csv"],
		["text/csv", "<b>bold header</b>,value\n", "text/plain"],
		// JSON and XML under their own types.
		["application/json", '{"a":1}', "application/json"],
		["application/json", '  [1, 2, "<html>"]', "application/json"],
		["application/vnd.api+json", '{"data":[]}', "application/json"],
		["application/json", '"a JSON string"', "text/plain"],
		["application/xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<feed><entry/></feed>", "application/xml"],
		["application/xml", "<!-- generated -->\n<catalog><book/></catalog>", "application/xml"],
		["application/xml", "<table><row/></table>", "application/xml"],
		["application/xml", "<a><b/></a>", "application/xml"],
		["text/xml", "<?xml version=\"1.0\"?><!DOCTYPE note SYSTEM \"note.dtd\"><note/>", "application/xml"],
		["text/xml", "<?xml version=\"1.0\"?><!DOCTYPE note [<!ENTITY a \"b>\">]><note/>", "application/xml"],
		["application/atom+xml", "<?xml version=\"1.0\"?><feed xmlns=\"http://www.w3.org/2005/Atom\"><title>t</title></feed>", "application/xml"],
		["application/xml", "<?xml version=\"1.0\"?><title>a root that is called like an HTML tag</title>", "application/xml"],
		["application/xml", "no markup at all", "text/plain"],
		// SVG is XML. With a script in it, it is kept as the text it is; nothing here renders it.
		["image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>", "image/svg+xml"],
		["image/svg+xml", "<?xml version=\"1.0\"?>\n<!-- chart -->\n<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"x()\"/>", "image/svg+xml"],
		["image/svg+xml", "<?xml version=\"1.0\"?><!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"><svg/>", "image/svg+xml"],
		["image/svg+xml", "<?xml version=\"1.0\"?><svg:svg xmlns:svg=\"http://www.w3.org/2000/svg\"/>", "image/svg+xml"],
		["application/xml", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "image/svg+xml"],
	];
	for (const [declared, text, sniffed] of kept) assert.deepEqual(d(declared, text), { ok: true, sniffed, textLike: true }, `${JSON.stringify(text.slice(0, 40))} as ${declared}`);

	// Under a type that says nothing about text, what begins with a tag of running text is taken for HTML, as before.
	for (const declared of ["application/octet-stream", "application/vnd.example.report", "image/png", "application/pdf"]) {
		for (const flow of ["<p>hello", "<div><script>x</script></div>", "<a href=x>", "<h1>t</h1>", "<table>", "<b>", "<br>", "<font>", "<img src=x onerror=y>"]) assert.deepEqual(d(declared, flow), refused, `${flow} as ${declared}`);
	}
	// An SVG is no picture of the binary kind: behind an image type it is a mismatch, like any text.
	assert.deepEqual(d("image/png", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), { ok: false, code: FILE_CODE.MISMATCH, sniffed: "image/svg+xml", refused: null });
	assert.deepEqual(d("image/svg+xml", bytes(PNG, 32)), { ok: false, code: FILE_CODE.MISMATCH, sniffed: "image/png", refused: null });
	assert.deepEqual(d("application/octet-stream", "<svg/>"), { ok: true, sniffed: "image/svg+xml", textLike: true });
	// A shebang is refused as before, with its own code, whatever follows it.
	assert.deepEqual(d("text/plain", "#!/bin/sh\n<html>"), { ok: false, code: FILE_CODE.REFUSED, sniffed: "text/x-script", refused: REFUSED_CLASS.SCRIPT });
	assert.ok(SNIFFED_TYPES.includes("image/svg+xml"));
});

test("leadingMarkup: what a text begins with, and nothing beyond its first tag", async () => {
	const { leadingMarkup } = await import("../../extension/shared/sniff.js");
	/** @type {[string, ReturnType<typeof leadingMarkup>][]} */
	const table = [
		["", null],
		["words", null],
		["   \n\t", null],
		["<", null],
		["< p>", null],
		["<3", null],
		["<p", "fragment"],
		["<p>", "fragment"],
		["<P CLASS=x>", "fragment"],
		["<pre>", "xml"],
		["<html", "html"],
		["<html5>", "xml"],
		["<script/>", "html"],
		["<scripted>", "xml"],
		["<svg>", "svg"],
		["<svg:svg>", "xml"],
		["<!---->x", null],
		// The two short forms an HTML parser takes for a whole comment: what follows them is what the text begins with.
		["<!--><html><script>alert(1)</script><!-- -->", "html"],
		["<!---><body onload=x>", "html"],
		["<!-->plain words", null],
		["<!-- never closed <script>", null],
		["<!-- a --><!-- b --><p>", "fragment"],
		["<?xml version='1.0'?>", "xml"],
		["<?xml version='1.0'", "xml"],
		["<?xml version='1.0'?><html>", "html"],
		["<?xml version='1.0'?><script>", "xml"],
		["<?php echo 1; ?><html>", "html"],
		["<!doctype html>", "html"],
		["<!DOCTYPE html", "html"],
		// No white space before the name: an HTML parser takes it for the doctype all the same.
		["<!doctypehtml>", "html"],
		["<!DOCTYPEhtml><script>alert(1)</script>", "html"],
		["<!doctypehtmlx>", null],
		["<!DOCTYPE svg PUBLIC 'x' 'y'><svg>", "svg"],
		["<!DOCTYPE svg PUBLIC 'x'", "svg"],
		["<!DOCTYPE note><html>", "html"],
		["<!DOCTYPE note [ <!ELEMENT note (#PCDATA)> ]><note>", "xml"],
		// A doctype ends where an XML parser ends it: not at a "]" or ">" in a literal, a comment or an instruction.
		["<?xml version='1.0'?><!DOCTYPE r [<!ENTITY x ']'>]><html/>", "html"],
		["<?xml version='1.0'?><!DOCTYPE r SYSTEM 'a>b'><html/>", "html"],
		['<!DOCTYPE r PUBLIC "-//x//>" "y[z"><svg/>', "svg"],
		["<!DOCTYPE r [<!-- ]> --><!ENTITY y \"]>\">]><h:html xmlns:h='http://www.w3.org/1999/xhtml'/>", "html"],
		["<!DOCTYPE r [<?pi ]> ?>]><svg/>", "svg"],
		["<!DOCTYPE r [<!ENTITY x ']'>]><r/>", "xml"],
		["<!DOCTYPE r [<!ELEMENT r (a|b)*> <!ATTLIST r x CDATA 'v>w'>] ><html>", "html"],
		// It does not end within the head: the name it gives the root is all there is to go by.
		[`<!DOCTYPE r [${"<!-- p -->".repeat(500)}`, "xml"],
		[`<!DOCTYPE html [${"<!-- p -->".repeat(500)}`, "html"],
		["<!DOCTYPE r SYSTEM 'never closed><html>", "xml"],
	];
	for (const [text, want] of table) assert.equal(leadingMarkup(text), want, JSON.stringify(text));
	// Only the head counts: a page behind four thousand bytes of anything else is not seen, and is text.
	assert.equal(sniff(bytes(`${"x".repeat(SNIFF_BYTES)}<html><script>`)).type, "text/plain");
});
