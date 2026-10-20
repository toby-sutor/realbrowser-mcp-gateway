// Retrieved files in the store: the bytes, the record, the name they are shown
// under, and that purge, rebuild and search treat them like pages.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FILE_ID_RE, PageStore, StoreError, isValidFileId, isValidPageId, newFileId } from "../../daemon/src/store.js";
import { FILE_LIMITS, decodeText, displayName, exportEnding, isSafeName, xmlIsPlain } from "../../daemon/src/files.js";
import { counterBytes, makeRecord, openStore, quietLog } from "../helpers/pages.js";

// Windows has no mode bits: what they are is checked where there are.
const MODES = process.platform !== "win32";

const MIN = 60000;
// What a store is given when it is told nothing: 2 GiB for all files, and a minute for a reader that stays away
// (store.js FILE_STORE; a test in config-files.test.js holds the first to the documented default).
const FILE_STORE = Object.freeze({ maxTotalBytes: 2147483648, readHoldMs: 60000 });
const PDF = Buffer.from("%PDF-1.4\n% a made-up document with a SECRET-INSIDE-THE-PDF\n");
/** @param {Uint8Array} data */
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
/** @param {string} p */
const mode = (p) => fs.statSync(p).mode & 0o777;
/** @param {string} dir @param {string} id */
const fileDir = (dir, id) => path.join(dir, "files", id.slice(-2), id);

/**
 * Put bytes where the daemon puts a file together, and describe them for saveFile().
 * @param {string} dir the data directory
 * @param {Buffer} bytes
 * @param {Partial<import("../../daemon/src/store.js").FileRecord>} [over]
 * @returns {import("../../daemon/src/store.js").FileRecord}
 */
function arrived(dir, bytes, over = {}) {
	const incoming = path.join(dir, "incoming");
	fs.mkdirSync(incoming, { recursive: true, mode: 0o700 });
	const tempPath = path.join(incoming, `j_${crypto.randomBytes(6).toString("hex")}.part`);
	fs.writeFileSync(tempPath, bytes, { mode: 0o600 });
	return {
		url: "https://example.com/files/report.pdf",
		final_url: "https://cdn.example.com/files/report.pdf",
		http_status: 200,
		suggested_name: null,
		declared_type: "application/pdf",
		sniffed_type: "application/pdf",
		charset: null,
		size: bytes.length,
		sha256: sha256(bytes),
		text_like: false,
		tempPath,
		redirect_origins: ["https://cdn.example.com"],
		...over,
	};
}

test("file ids are fl_ + 26 Crockford chars: their own kind, never taken for a page", () => {
	const id = newFileId(Date.UTC(2026, 9, 6), counterBytes());
	assert.match(id, FILE_ID_RE);
	assert.match(id, /^fl_[0-9A-HJKMNP-TV-Z]{26}$/);
	assert.equal(isValidFileId(id), true);
	assert.equal(isValidPageId(id), false);
	assert.equal(isValidFileId(`pg_${id.slice(3)}`), false);
	for (const bad of ["", "fl_", `fl_${"0".repeat(25)}`, `fl_${"0".repeat(27)}`, `fl_${"I".repeat(26)}`, `fl_${"a".repeat(26)}`, `fl_${"0".repeat(24)}/.`, `../fl_${"0".repeat(26)}`, null, 7, {}]) {
		assert.equal(isValidFileId(bad), false, String(bad));
	}
});

test("the display name: from what the server suggests, else from the address; a label made safe, never a path", () => {
	/** @type {[unknown, unknown, string, string][]} */
	const table = [
		["report.pdf", null, "application/pdf", "report.pdf"],
		["Quarterly Report (final) v2.pdf", null, "application/pdf", "Quarterly Report (final) v2.pdf"],
		[null, "https://example.com/files/data.json?token=abc#frag", "application/json", "data.json"],
		[null, "https://example.com/files/gr%C3%BC%C3%9Fe%20aus.pdf", "application/pdf", "gr\u00fc\u00dfe aus.pdf"],
		["", "https://example.com/dl/report.pdf", "application/pdf", "report.pdf"],
		["   ", "https://example.com/dl/report.pdf", "application/pdf", "report.pdf"],
		// No separators: only what follows the last one.
		["../../etc/passwd", null, "text/plain", "passwd.txt"],
		["..\\..\\windows\\system32\\evil.dll", null, "application/zip", "evil.dll"],
		["/absolute/path/to/file.pdf", null, "application/pdf", "file.pdf"],
		["C:\\Users\\me\\x.pdf", null, "application/pdf", "x.pdf"],
		["a/b/", null, "application/pdf", "b.pdf"],
		[null, "https://example.com/a/%2e%2e%2f%2e%2e%2fetc%2fshadow", "text/plain", "shadow.txt"],
		[null, "https://example.com/files/..%2f..%2fsecret.pdf", "application/pdf", "secret.pdf"],
		// No leading dot or dash, no trailing dot or space.
		[".bashrc", null, "text/plain", "bashrc.txt"],
		["...hidden.pdf", null, "application/pdf", "hidden.pdf"],
		["-rf.pdf", null, "application/pdf", "rf.pdf"],
		["--output=x.pdf", null, "application/pdf", "output=x.pdf"],
		["name.pdf. . .", null, "application/pdf", "name.pdf"],
		["..", null, "application/pdf", "file.pdf"],
		[".", "https://example.com/", "application/zip", "file.zip"],
		// Nothing invisible, no control characters, nothing that turns text around.
		["re\u202eport\u200b.pdf", null, "application/pdf", "report.pdf"],
		["evil\u202efdp.exe", null, "application/zip", "evilfdp.exe"],
		["a\u0000b\u0007c\u001b[31m.pdf", null, "application/pdf", "abc[31m.pdf"],
		["line\nbreak\r\n.pdf", null, "application/pdf", "linebreak.pdf"],
		["tab\tand  spaces.pdf", null, "application/pdf", "tab and spaces.pdf"],
		["\ufeffbom.pdf", null, "application/pdf", "bom.pdf"],
		// Characters with a meaning to a shell or a file system become an underscore.
		['a"b\'c`d$e&f|g;h<i>j*k?l:m.pdf', null, "application/pdf", "a_b_c_d_e_f_g_h_i_j_k_l_m.pdf"],
		["$(reboot).pdf", null, "application/pdf", "(reboot).pdf"],
		["x$(reboot).pdf", null, "application/pdf", "x_(reboot).pdf"],
		["100% {real}.pdf", null, "application/pdf", "100_ _real_.pdf"],
		// Names a Windows program would take for a device.
		["CON", null, "text/plain", "_CON.txt"],
		["nul.txt", null, "text/plain", "_nul.txt"],
		["COM1.pdf", null, "application/pdf", "_COM1.pdf"],
		["console.pdf", null, "application/pdf", "console.pdf"],
		// An ending by what the file is, where the name has none; an ending it has is kept, whatever it says.
		["download", null, "application/pdf", "download.pdf"],
		["archive", null, "application/zip", "archive.zip"],
		["archive", null, "application/gzip", "archive.gz"],
		["archive", null, "application/x-tar", "archive.tar"],
		["picture", null, "image/jpeg", "picture.jpg"],
		["picture", null, "image/webp", "picture.webp"],
		["notes", null, "text/plain", "notes.txt"],
		["thing", null, "application/octet-stream", "thing"],
		["page.html", null, "application/pdf", "page.html"],
		["v1.2", null, "application/pdf", "v1.2"],
		// Nothing to go by.
		[null, null, "application/pdf", "file.pdf"],
		[7, { no: "url" }, "image/png", "file.png"],
		[null, "not a url", "image/gif", "file.gif"],
		[null, "https://example.com/", "application/json", "file.json"],
	];
	for (const [suggested, url, type, expected] of table) {
		const name = displayName(suggested, url, type);
		assert.equal(name, expected, `${JSON.stringify(suggested)} / ${JSON.stringify(url)}`);
		assert.equal(isSafeName(name), true, name);
	}
	// Capped in length, the ending kept.
	const long = displayName(`${"a".repeat(500)}.pdf`, null, "application/pdf");
	assert.equal([...long].length, FILE_LIMITS.maxNameChars);
	assert.ok(long.endsWith(".pdf"));
	const wide = displayName("\u{1f600}".repeat(300), null, "image/png");
	assert.ok([...wide].length <= FILE_LIMITS.maxNameChars);
	assert.equal(isSafeName(wide), true);
	// Whatever goes in: no separator, no leading dot, no control character, never empty.
	for (let i = 0; i < 300; i++) {
		const raw = crypto.randomBytes(40).toString("latin1") + "/..\\" + crypto.randomBytes(8).toString("utf8");
		const name = displayName(raw, `https://example.com/${encodeURIComponent(raw)}`, "application/pdf");
		assert.equal(/[/\\\u0000-\u001f\u007f-\u009f]/.test(name), false, JSON.stringify(name));
		assert.equal(/^[.\-\s]/.test(name), false, JSON.stringify(name));
		assert.ok(name.length > 0 && [...name].length <= FILE_LIMITS.maxNameChars);
		assert.equal(isSafeName(name), true, JSON.stringify(name));
	}
	for (const unsafe of ["", "a/b", "a\\b", ".hidden", "-x", "a\u0000b", "trailing.", " leading", "x".repeat(121), "CON", null, 7]) assert.equal(isSafeName(unsafe), false, String(unsafe));
});

test("a name made here is one the store takes back: whatever a server or an address spells", () => {
	// A letter and its accent with something invisible between them: what is left once that is gone must be put together again.
	for (const raw of ["e\u200B\u0301.pdf", "a\u00AD\u0308b.pdf", "=\u200D\u0338.pdf", "\u1100\u200B\u1161.pdf", "x\u0327\u2060\u0301"]) {
		const name = displayName(raw, null, "application/pdf");
		assert.equal(isSafeName(name), true, JSON.stringify([raw, name]));
		assert.equal(name, name.normalize("NFC"), JSON.stringify(name));
	}
	const fromPath = displayName(null, "https://example.com/e%E2%80%8B%CC%81.pdf", "application/pdf");
	assert.equal(fromPath, "\u00E9.pdf");
	assert.equal(isSafeName(fromPath), true);

	// The same pieces every run: letters, marks, things nobody sees, separators, and names with a meaning of their own.
	const pieces = ["a", "B", "e", "9", ".", "-", "_", " ", "/", "\\", "(", "~", "=", "<", "\t", "\n", "con", "nul", ".pdf", "\u0301", "\u0300", "\u0308", "\u0323", "\u0338", "\u0327", "\u200B", "\u200D", "\u00AD", "\u2060", "\uFEFF", "\u202E", "\u034F", "\uFE0F", "\u00E9", "\u00DF", "\u01C6", "\u1E9B\u0323", "\u03A9", "\u2126", "\uFB01", "\u0958", "\u0F71\u0F72", "\u1100", "\u1161", "\u11A8", "\uAC00", "\u3099", "\u304B", "\uFF19", "\u{1F600}", "\u{1D15E}", "\uD83D", "\uDC00", "\u0000", "\u0085", "\u2028"];
	let seed = 20261011;
	const next = () => {
		seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
		return seed / 0x80000000;
	};
	for (let i = 0; i < 40000; i++) {
		const length = 1 + Math.floor(next() * (next() < 0.15 ? 160 : 10));
		let raw = "";
		for (let j = 0; j < length; j++) raw += pieces[Math.floor(next() * pieces.length)];
		for (const type of ["application/pdf", "application/octet-stream"]) {
			const name = displayName(raw, null, type);
			if (!isSafeName(name)) assert.fail(`not taken back: ${JSON.stringify(raw)} as ${type} gives ${JSON.stringify(name)}`);
		}
		// An address cannot spell half a pair.
		const url = `https://example.com/dl/${encodeURIComponent(raw.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD"))}`;
		const name = displayName(null, url, "text/plain");
		if (!isSafeName(name)) assert.fail(`not taken back: the address of ${JSON.stringify(raw)} gives ${JSON.stringify(name)}`);
	}
});

test("decodeText: a byte order mark first, then the declared charset where it is known, then UTF-8; never an error", () => {
	assert.equal(decodeText(Buffer.from("gr\u00fc\u00dfe", "utf8"), null), "gr\u00fc\u00dfe");
	assert.equal(decodeText(Buffer.from("gr\u00fc\u00dfe", "latin1"), "iso-8859-1"), "gr\u00fc\u00dfe");
	assert.equal(decodeText(Buffer.from("gr\u00fc\u00dfe", "latin1"), "windows-1252"), "gr\u00fc\u00dfe");
	assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("with a mark")]), "iso-8859-1"), "with a mark", "the mark wins over what the server says");
	assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]), null), "hi");
	assert.equal(decodeText(Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]), null), "hi");
	assert.equal(decodeText(Buffer.from("plain"), "no-such-charset"), "plain");
	assert.equal(decodeText(Buffer.from("plain"), "UTF-8; DROP"), "plain");
	assert.equal(decodeText(Buffer.from([0x61, 0xff, 0x62]), null), "a\ufffdb", "bytes that are no text become the replacement character");
	assert.equal(decodeText(Buffer.alloc(0), null), "");
});

test("saveFile: the bytes are moved under a path made of the id alone, next to a record; both private", (t) => {
	const { store, dir } = openStore(t);
	const rec = arrived(dir, PDF, { suggested_name: "../../../srv/.ssh/authorized_keys" });
	const { id, meta } = store.saveFile(rec);
	assert.match(id, FILE_ID_RE);
	assert.deepEqual(meta, {
		v: 1,
		kind: "file",
		id,
		url: "https://example.com/files/report.pdf",
		final_url: "https://cdn.example.com/files/report.pdf",
		host: "example.com",
		fetched_at: "2026-10-05T19:44:02Z",
		http_status: 200,
		name: "authorized_keys.pdf",
		declared_type: "application/pdf",
		sniffed_type: "application/pdf",
		charset: null,
		size: PDF.length,
		sha256: sha256(PDF),
		text: false,
		cookie_scope: "container",
		redirect_origins: ["https://cdn.example.com"],
	});
	const d = fileDir(dir, id);
	assert.deepEqual(fs.readdirSync(d).sort(), ["data", "meta.json"]);
	assert.equal(fs.readFileSync(path.join(d, "data")).equals(PDF), true, "byte for byte");
	if (MODES) assert.deepEqual([mode(path.join(d, "data")), mode(path.join(d, "meta.json")), mode(d), mode(path.dirname(d)), mode(path.join(dir, "files"))], [0o600, 0o600, 0o700, 0o700, 0o700]);
	assert.equal(fs.existsSync(rec.tempPath), false, "moved, not copied");
	// The name is a field of the record. Nowhere on disk is anything called by it.
	const everything = fs.readdirSync(dir, { recursive: true }).map(String);
	assert.equal(everything.some((p) => /authorized_keys|\.ssh|home/.test(p)), false, everything.join(", "));
	assert.deepEqual(fs.readdirSync(path.dirname(d)).filter((n) => n.startsWith(".tmp-")), [], "no temporary directory is left");
	assert.deepEqual(store.getFileMeta(id), meta);
	assert.deepEqual(store.stats(), { pages: 0, stored: 0, files: 1, file_bytes: PDF.length, file_bytes_max: 2147483648 });
	assert.equal(store.readFileText(id), null, "a binary file has no text");
});

test("XML is XML only when all of it is plain data: what a browser would do more with than show is found wherever it stands", () => {
	const enc = (/** @type {string} */ s) => Buffer.from(s, "latin1");
	const plain = [
		'<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>News &amp; notes</title><item><title>One &lt;b&gt;</title></item></channel></rss>',
		'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>caf\u00e9 &#8217;quoted&#8217; &#x2014; &#39;x&#39; &#169;</title></entry></feed>',
		'<?xml version="1.0"?>\n<!DOCTYPE catalog SYSTEM "catalog.dtd">\n<catalog>\t<book id="b1">A scripted bodywork of htmlish svgs</book>\r\n</catalog>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><url><loc>https://example.com/</loc></url></urlset>',
		'<x xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>script, html, body, iframe and svg as words</dc:title><scripts/><htmlx/></x>',
		"",
	];
	for (const text of plain) assert.equal(xmlIsPlain(enc(text)), true, text.slice(0, 60));
	/** @type {[string, string][]} */
	const active = [
		["a script of the XHTML namespace under a root of its own", '<?xml version="1.0"?><r><script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script></r>'],
		["the same with a prefix", '<r xmlns:h="http://www.w3.org/1999/xhtml"><h:img src="x" onerror="alert(1)"/></r>'],
		["an SVG inside a wrapper", '<r><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/></r>'],
		["an SVG element by prefix, no tag that says so", '<r xmlns:s="http://www.w3.org/2000/svg"><s:a onclick="x()"/></r>'],
		["MathML", '<r><math xmlns="http://www.w3.org/1998/Math/MathML"><mtext href="javascript:alert(1)">x</mtext></math></r>'],
		["the namespace in capitals", '<r xmlns:h="HTTP://WWW.W3.ORG/1999/XHTML"/>'],
		["the namespace with one letter as a character reference", '<r xmlns:h="http://www.w3.org/1999/xhtm&#x6c;"><h:script>alert(1)</h:script></r>'],
		["the same in decimal", '<r xmlns:h="http://www.w3.org/1999/xhtm&#108;"><h:script/></r>'],
		["a slash as a character reference", '<r xmlns:h="http:&#47;&#x2F;www.w3.org/1999/xhtml"/>'],
		["zeros before the number", '<r xmlns:h="http://www.w3.org/1999/xhtm&#x00006c;"/>'],
		["zeros without end before the number", `<r xmlns:h="http://www.w3.org/1999/xhtm&#x${"0".repeat(300)}6c;"/>`],
		["the namespace put together from entities", '<!DOCTYPE r [<!ENTITY a "http://www.w3.org/1999/xht"><!ENTITY b "ml">]><r xmlns:h="&a;&b;"><h:script/></r>'],
		["the namespace as the default of an attribute", '<!DOCTYPE r [<!ATTLIST x xmlns CDATA #FIXED "http://www.w3.org/1999/xhtm&#x6c;">]><r><x/></r>'],
		["a stylesheet instruction", '<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="#s"?><r/>'],
		["a tag a page is made of, without any namespace", "<span></span><script>alert(1)</script>"],
		["another", "<r><IFRAME src='x'/></r>"],
		["a page quoted in an entry", "<rss><item><description><![CDATA[<html><body>hello</body></html>]]></description></item></rss>"],
		["a control character", "<r>a\u001b(Jb</r>"],
		["a NUL", "<r>a\u0000b</r>"],
	];
	for (const [label, text] of active) assert.equal(xmlIsPlain(enc(text)), false, label);
	// Wherever it stands: the file is read in pieces, and what lies across two of them is found as well.
	for (const needle of ['<script xmlns="http://www.w3.org/1999/xhtml">', "http://www.w3.org/2000/svg", "&#x6c;", "&#0000108;", "<!ENTITY", "<?xml-stylesheet", "\u0001"]) {
		for (let lead = 65536 - needle.length - 2; lead <= 65536 + 2; lead++) {
			const text = `<r>${"a".repeat(lead - 3)}${needle}${"b".repeat(100)}</r>`;
			if (xmlIsPlain(enc(text))) assert.fail(`${JSON.stringify(needle)} after ${lead} bytes`);
		}
		assert.equal(xmlIsPlain(enc(`<r>${"a".repeat(300000)}${needle}</r>`)), false, needle);
	}
	assert.equal(xmlIsPlain(enc(`<r>${"<i>a &amp; b</i>\n".repeat(20000)}</r>`)), true);
});

test("saveFile settles what a file is with all of it at hand: XML that is no plain data is stored and named as text, a Windows program not at all", (t) => {
	const { store, dir } = openStore(t);
	const xml = (/** @type {string} */ text, over = {}) => arrived(dir, Buffer.from(text, "utf8"), { url: "https://example.com/data/feed", final_url: "https://example.com/data/feed", declared_type: "application/xml", sniffed_type: "application/xml", text_like: true, ...over });
	// Plain data: XML, and exported as such.
	const feed = store.saveFile(xml('<?xml version="1.0"?><rss><channel><title>t</title></channel></rss>')).meta;
	assert.deepEqual([feed.sniffed_type, feed.name, exportEnding(feed.sniffed_type), feed.text], ["application/xml", "feed.xml", ".xml", true]);
	// What a browser would run: the same bytes are kept, shown and searched - as text, under a name that says text.
	for (const [label, text] of /** @type {[string, string][]} */ ([
		["a script of the XHTML namespace", '<?xml version="1.0"?><r><script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script></r>'],
		["an SVG in a wrapper", '<r><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/></r>'],
		["XHTML behind a subset longer than the first bytes", `<?xml version="1.0"?><!DOCTYPE r [${"<!-- p -->".repeat(500)}]><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>`],
		["a first tag that says nothing", "<span></span><script>alert(1)</script>"],
		["the namespace spelled with a character reference", '<r xmlns:h="http://www.w3.org/1999/xhtm&#x6c;"><h:script>alert(1)</h:script></r>'],
		["a script far behind the first bytes", `<r>${"<i/>".repeat(40000)}<script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script></r>`],
	])) {
		for (const declared of ["application/xml", "application/octet-stream", "application/atom+xml"]) {
			const rec = xml(text, { declared_type: declared });
			const { id, meta } = store.saveFile(rec);
			assert.deepEqual([meta.sniffed_type, meta.name, exportEnding(meta.sniffed_type), meta.text], ["text/plain", "feed.txt", ".txt", true], `${label} as ${declared}`);
			assert.equal(store.getFileMeta(id)?.sniffed_type, "text/plain");
			assert.equal(store.readFileText(id), text, "its bytes are what they were");
		}
	}
	// A label that came with an ending keeps it: a label is a server's word and names no file.
	assert.equal(store.saveFile(xml("<r><script/></r>", { suggested_name: "data.xml" })).meta.name, "data.xml");
	// XML too large to be read whole here is not called XML either.
	const large = store.saveFile(xml(`<r>${"<i>plain</i>".repeat(Math.ceil(FILE_LIMITS.maxTextBytes / 12))}</r>`)).meta;
	assert.ok(large.size > FILE_LIMITS.maxTextBytes);
	assert.deepEqual([large.sniffed_type, exportEnding(large.sniffed_type), large.text], ["text/plain", ".txt", false]);
	// Every other kind is what its first bytes say: nothing else is read.
	const json = store.saveFile(arrived(dir, Buffer.from('{"a": "<script xmlns=\\"http://www.w3.org/1999/xhtml\\">"}'), { declared_type: "application/json", sniffed_type: "application/json", text_like: true })).meta;
	assert.equal(json.sniffed_type, "application/json");

	// A Windows program is told by two letters and by binary data right behind them. One whose first header is
	// made of printable bytes has its second header far into the file - where the first says, and there it is looked for.
	const program = (/** @type {boolean} */ signed) => {
		const header = Buffer.alloc(64, 0x20);
		header.write("MZ", 0, "latin1");
		header.writeUInt32LE(0x09090909, 60);
		const incoming = path.join(dir, "incoming");
		fs.mkdirSync(incoming, { recursive: true, mode: 0o700 });
		const tempPath = path.join(incoming, `j_${crypto.randomBytes(6).toString("hex")}.part`);
		const fd = fs.openSync(tempPath, "wx", 0o600);
		// Everything between is a hole: the file takes no room.
		fs.writeSync(fd, header, 0, 64, 0);
		fs.writeSync(fd, Buffer.from(signed ? [0x50, 0x45, 0, 0, 0x4c, 0x01] : [0x50, 0x45, 0x20, 0x20, 0x4c, 0x01]), 0, 6, 0x09090909);
		fs.closeSync(fd);
		const size = 0x09090909 + 6;
		return { url: `https://example.com/files/tool-${signed}`, final_url: null, http_status: 200, suggested_name: "notes.txt", declared_type: "text/plain", sniffed_type: "text/plain", charset: null, size, sha256: "0".repeat(64), text_like: true, tempPath, redirect_origins: [] };
	};
	const before = store.stats().files;
	const exe = program(true);
	assert.throws(() => store.saveFile(exe), (err) => err instanceof StoreError && err.code === "file_refused");
	assert.equal(store.stats().files, before, "nothing of it is stored");
	assert.equal(fs.existsSync(exe.tempPath), true, "and its bytes are left to whoever brought them, to remove");
	fs.rmSync(exe.tempPath);
	// The same two letters before text are text: no second header where the first would have it.
	const notes = store.saveFile(program(false));
	assert.equal(notes.meta.sniffed_type, "text/plain");
	assert.equal(store.saveFile(arrived(dir, Buffer.from("MZ is the country code of Mozambique.\n"), { declared_type: "text/plain", sniffed_type: "text/plain", text_like: true })).meta.sniffed_type, "text/plain");
});

test("saveFile refuses what it cannot trust: bytes from outside the data directory, a link, another size, a type that is no sniffer's word", (t) => {
	const { store, dir } = openStore(t);
	const outside = path.join(path.dirname(dir), `outside-${crypto.randomBytes(4).toString("hex")}`);
	fs.writeFileSync(outside, PDF);
	t.after(() => fs.rmSync(outside, { force: true }));
	assert.throws(() => store.saveFile(arrived(dir, PDF, { tempPath: outside })), StoreError);
	assert.equal(fs.readFileSync(outside).equals(PDF), true, "left where it was");
	// Windows makes no symlink without a privilege.
	if (process.platform !== "win32") {
		const link = path.join(dir, "incoming", "j_link.part");
		fs.mkdirSync(path.dirname(link), { recursive: true });
		fs.symlinkSync(outside, link);
		assert.throws(() => store.saveFile(arrived(dir, PDF, { tempPath: link })), StoreError);
	}
	assert.throws(() => store.saveFile(arrived(dir, PDF, { size: PDF.length + 1 })), StoreError);
	assert.throws(() => store.saveFile(arrived(dir, PDF, { sha256: "nope" })), StoreError);
	assert.throws(() => store.saveFile(arrived(dir, PDF, { sniffed_type: "application/x-made-up" })), StoreError);
	assert.throws(() => store.saveFile(arrived(dir, PDF, { url: "ftp://example.com/x" })), StoreError);
	assert.throws(() => store.saveFile(arrived(dir, PDF, { tempPath: path.join(dir, "incoming", "missing.part") })), StoreError);
	assert.deepEqual(store.stats(), { pages: 0, stored: 0, files: 0, file_bytes: 0, file_bytes_max: 2147483648 });
	assert.deepEqual(fs.readdirSync(path.join(dir, "files")).flatMap((s) => fs.readdirSync(path.join(dir, "files", s))), [], "nothing was stored, and no temporary directory is left");
});

test("text files are read back as text and in pieces as bytes; a text file too large to show is kept as bytes only", (t) => {
	const { store, dir } = openStore(t);
	const text = "first line\nzweite Zeile mit gr\u00fc\u00dfen\n";
	const latin = store.saveFile(arrived(dir, Buffer.from(text, "latin1"), { url: "https://example.com/notes.txt", final_url: null, declared_type: "text/plain", sniffed_type: "text/plain", charset: "iso-8859-1", text_like: true }));
	assert.equal(latin.meta.text, true);
	assert.equal(latin.meta.name, "notes.txt");
	assert.equal(store.readFileText(latin.id), text);
	assert.equal(store.readFileChunk(latin.id, 0, 1000)?.equals(Buffer.from(text, "latin1")), true, "the bytes stay as they came");
	// Pieces: any offset, short at the end, empty beyond it.
	const bytes = crypto.randomBytes(10000);
	const bin = store.saveFile(arrived(dir, bytes, { sniffed_type: "application/octet-stream", declared_type: "application/vnd.example" }));
	assert.equal(store.readFileChunk(bin.id, 0, 4096)?.equals(bytes.subarray(0, 4096)), true);
	assert.equal(store.readFileChunk(bin.id, 9000, 4096)?.equals(bytes.subarray(9000)), true);
	assert.equal(store.readFileChunk(bin.id, 10000, 4096)?.length, 0);
	assert.equal(store.readFileChunk(bin.id, 20000, 4096)?.length, 0);
	assert.throws(() => store.readFileChunk(bin.id, -1, 10), StoreError);
	assert.throws(() => store.readFileChunk(bin.id, 0, FILE_LIMITS.exportChunkBytes + 1), StoreError);
	assert.throws(() => store.readFileChunk("../../etc/passwd", 0, 10), StoreError);
	assert.equal(store.readFileChunk(`fl_${"0".repeat(26)}`, 0, 10), null);
	// Larger than is shown as text: stored, exportable, not decoded and not searched by content.
	const huge = Buffer.alloc(FILE_LIMITS.maxTextBytes + 1, 0x61);
	const big = store.saveFile(arrived(dir, huge, { url: "https://example.com/huge.txt", declared_type: "text/plain", sniffed_type: "text/plain", text_like: true }));
	assert.equal(big.meta.text, false);
	assert.equal(store.readFileText(big.id), null);
	assert.equal(store.readFileChunk(big.id, huge.length - 3, 100)?.toString(), "aaa");
});

test("a record or bytes that were tampered with are not trusted", (t) => {
	const { store, dir, log } = openStore(t);
	const { id } = store.saveFile(arrived(dir, PDF));
	const metaFile = path.join(fileDir(dir, id), "meta.json");
	const good = JSON.parse(fs.readFileSync(metaFile, "utf8"));
	for (const bend of [
		{ name: "../../etc/passwd" },
		{ name: ".hidden" },
		{ name: "" },
		{ name: "x".repeat(200) },
		{ sniffed_type: "text/html; evil" },
		{ sha256: "short" },
		{ size: -1 },
		{ size: "303" },
		{ kind: "page" },
		{ id: `fl_${"1".repeat(26)}` },
		{ cookie_scope: "default" },
		{ text: "yes" },
		{ fetched_at: "never" },
	]) {
		fs.writeFileSync(metaFile, JSON.stringify({ ...good, ...bend }));
		assert.equal(store.getFileMeta(id), null, JSON.stringify(bend));
		assert.equal(store.readFileChunk(id, 0, 10), null, JSON.stringify(bend));
	}
	fs.writeFileSync(metaFile, "{ not json");
	assert.equal(store.getFileMeta(id), null);
	assert.ok(log.events.includes("store.bad_meta"));
	fs.writeFileSync(metaFile, JSON.stringify(good));
	assert.notEqual(store.getFileMeta(id), null);
	// Bytes of another size than the record says, or a link in their place: not handed out.
	const data = path.join(fileDir(dir, id), "data");
	fs.appendFileSync(data, "x");
	assert.equal(store.readFileChunk(id, 0, 10), null);
	fs.rmSync(data);
	// Windows makes no symlink without a privilege.
	if (process.platform !== "win32") {
		fs.symlinkSync("/etc/hostname", data);
		assert.equal(store.readFileChunk(id, 0, 10), null);
		fs.rmSync(data);
	}
	assert.equal(store.readFileChunk(id, 0, 10), null);
});

test("search: a text file by its content, every file by its name and its address; pages and files in one answer", (t) => {
	const { store, dir } = openStore(t);
	const page = store.save(makeRecord({ markdown: "# Fox\n\nThe quick brown fox mentions zebracorn once." }));
	const json = store.saveFile(arrived(dir, Buffer.from('{"animal": "zebracorn", "count": 3}'), { url: "https://api.example.com/v2/animals.json", final_url: null, declared_type: "application/json", sniffed_type: "application/json", text_like: true }));
	const pdf = store.saveFile(arrived(dir, PDF, { url: "https://example.com/go?id=7", final_url: "https://cdn.example.com/reports/annual-summary-2025.pdf", suggested_name: "Annual Summary 2025.pdf" }));
	const ids = (/** @type {string} */ q) => store.search(q).map((h) => h.id);
	assert.deepEqual(ids("zebracorn").sort(), [json.id, page.id].sort(), "the page and the file that hold the word");
	assert.deepEqual(ids("animals"), [json.id], "by its address");
	assert.deepEqual(ids("annual summary"), [pdf.id], "by its name");
	assert.deepEqual(ids("cdn reports"), [pdf.id], "by where it came from in the end");
	assert.deepEqual(ids("SECRET-INSIDE-THE-PDF"), [], "what is inside a binary file is not searched");
	const hit = store.search("annual")[0];
	assert.deepEqual({ id: hit.id, title: hit.title, url: hit.url, fetched_at: hit.fetched_at }, { id: pdf.id, title: "Annual Summary 2025.pdf", url: "https://example.com/go?id=7", fetched_at: "2026-10-05T19:44:02Z" });
	assert.equal(store.search("zebracorn", { limit: 1 }).length, 1);
	assert.deepEqual(store.search('" OR 1=1 --'), []);
});

test("findFreshFile: the newest file of a URL within the cache lifetime", (t) => {
	const { store, dir, clock } = openStore(t);
	const a = store.saveFile(arrived(dir, PDF, { url: "HTTPS://Example.com/files/report.pdf" }));
	assert.equal(store.findFreshFile("https://example.com/files/report.pdf", { maxAgeMs: 10 * MIN })?.id, a.id);
	assert.equal(store.findFreshFile("https://example.com/other.pdf", { maxAgeMs: 10 * MIN }), null);
	clock.advance(5 * MIN);
	const b = store.saveFile(arrived(dir, PDF));
	assert.equal(store.findFreshFile("https://example.com/files/report.pdf", { maxAgeMs: 10 * MIN })?.id, b.id, "the newer one");
	clock.advance(11 * MIN);
	assert.equal(store.findFreshFile("https://example.com/files/report.pdf", { maxAgeMs: 10 * MIN }), null);
	assert.equal(store.findFreshFile("not a url", { maxAgeMs: MIN }), null);
	assert.throws(() => store.findFreshFile("https://example.com/", { maxAgeMs: -1 }), StoreError);
});

test("purge removes old files like old pages: bytes, record, row and search entry", (t) => {
	const { store, dir, clock } = openStore(t);
	const old = store.saveFile(arrived(dir, PDF, { suggested_name: "old-one.pdf" }));
	const oldPage = store.save(makeRecord());
	clock.advance(20 * MIN);
	const young = store.saveFile(arrived(dir, PDF, { suggested_name: "young-one.pdf" }));
	assert.deepEqual(store.purge({ maxAgeMs: 30 * MIN }), { rows: 0, dirs: 0, refused: 0, files: 0, unknown: 0 });
	assert.deepEqual(store.purge({ maxAgeMs: 10 * MIN }), { rows: 1, dirs: 1, refused: 0, files: 1, unknown: 0 });
	assert.equal(fs.existsSync(fileDir(dir, old.id)), false);
	assert.equal(store.getFileMeta(old.id), null);
	assert.equal(store.getMeta(oldPage.id), null);
	assert.deepEqual(store.search("old one"), []);
	assert.equal(store.search("young one")[0].id, young.id);
	assert.deepEqual(store.stats(), { pages: 0, stored: 0, files: 1, file_bytes: PDF.length, file_bytes_max: 2147483648 });
	// A row whose directory is gone goes too; a link in the place of a directory is left alone, and said.
	fs.rmSync(fileDir(dir, young.id), { recursive: true });
	const linked = store.saveFile(arrived(dir, PDF));
	// Windows makes no symlink without a privilege.
	if (process.platform !== "win32") {
		const elsewhere = path.join(dir, "elsewhere");
		fs.mkdirSync(elsewhere);
		fs.writeFileSync(path.join(elsewhere, "keep"), "x");
		fs.rmSync(fileDir(dir, linked.id), { recursive: true });
		fs.symlinkSync(elsewhere, fileDir(dir, linked.id));
		assert.deepEqual(store.purge({ maxAgeMs: 0 }), { rows: 0, dirs: 0, refused: 0, files: 0, unknown: 0 }, "nothing is strictly older than now");
		clock.advance(1000);
		assert.deepEqual(store.purge({ maxAgeMs: 0 }), { rows: 0, dirs: 0, refused: 1, files: 1, unknown: 0 });
		assert.equal(fs.readFileSync(path.join(elsewhere, "keep"), "utf8"), "x", "what the link points at is untouched");
	}
});

test("rebuildIndex brings files back from their directories: rows, search and stats; what is damaged is skipped", (t) => {
	const { store, dir, clock } = openStore(t);
	const json = store.saveFile(arrived(dir, Buffer.from('{"word": "zebracorn"}'), { url: "https://example.com/a.json", final_url: null, declared_type: "application/json", sniffed_type: "application/json", text_like: true }));
	const pdf = store.saveFile(arrived(dir, PDF, { suggested_name: "kept.pdf" }));
	const page = store.save(makeRecord());
	const broken = store.saveFile(arrived(dir, PDF, { suggested_name: "broken.pdf" }));
	// Other bytes in the place of this record's (the same bytes are kept once: writing into them would change every record that holds them).
	fs.rmSync(path.join(fileDir(dir, broken.id), "data"));
	fs.writeFileSync(path.join(fileDir(dir, broken.id), "data"), Buffer.concat([PDF, Buffer.from("tampered")]), { mode: 0o600 });
	const noBytes = store.saveFile(arrived(dir, PDF, { suggested_name: "nobytes.pdf" }));
	fs.rmSync(path.join(fileDir(dir, noBytes.id), "data"));
	fs.mkdirSync(path.join(dir, "files", pdf.id.slice(-2), ".tmp-leftover"));
	fs.mkdirSync(path.join(dir, "files", pdf.id.slice(-2), "not-an-id"));
	store.close();
	fs.rmSync(path.join(dir, "index.db"));
	const fresh = new PageStore({ dataDir: dir, clock, log: quietLog(), randomBytes: counterBytes(900) });
	t.after(() => fresh.close());
	assert.deepEqual(fresh.stats(), { pages: 0, stored: 0, files: 0, file_bytes: 0, file_bytes_max: 2147483648 });
	assert.deepEqual(fresh.rebuildIndex(), { pages: 1, stored: 1, skipped: 3, files: 2 });
	assert.deepEqual(fresh.stats(), { pages: 1, stored: 1, files: 2, file_bytes: PDF.length + 21, file_bytes_max: 2147483648 });
	assert.deepEqual(fresh.search("zebracorn").map((h) => h.id), [json.id]);
	assert.deepEqual(fresh.search("kept").map((h) => h.id), [pdf.id]);
	assert.deepEqual(fresh.search("broken"), []);
	assert.equal(fresh.findFreshFile("https://example.com/a.json", { maxAgeMs: MIN })?.id, json.id);
	assert.notEqual(fresh.getMeta(page.id), null);
	assert.equal(fs.existsSync(path.join(dir, "files", pdf.id.slice(-2), ".tmp-leftover")), false, "leftovers of an interrupted save are swept");
	// Twice gives the same.
	assert.deepEqual(fresh.rebuildIndex(), { pages: 1, stored: 1, skipped: 3, files: 2 });
	assert.deepEqual(fresh.stats(), { pages: 1, stored: 1, files: 2, file_bytes: PDF.length + 21, file_bytes_max: 2147483648 });
});

/** @param {number} size @param {number} seed @returns {Buffer} a made-up PDF of that size; another seed, other bytes */
const sized = (size, seed) => Buffer.concat([Buffer.from("%PDF-1.4\n"), crypto.createHash("sha256").update(String(seed)).digest(), Buffer.alloc(size, seed % 251)]).subarray(0, size);
/** @param {string} dir @param {string} id @returns {fs.Stats} of the bytes of a stored file */
const bytesOf = (dir, id) => fs.statSync(path.join(fileDir(dir, id), "data"));
/** @param {string} dir @returns {string[]} ids of the files that lie in the store's directories */
const onDisk = (dir) => fs.readdirSync(path.join(dir, "files")).flatMap((shard) => fs.readdirSync(path.join(dir, "files", shard))).sort();
/**
 * A store with room for so many bytes of files, and a log that can be read.
 * @param {import("node:test").TestContext} t
 * @param {number} maxFileBytes
 */
function roomFor(t, maxFileBytes) {
	const made = openStore(t);
	made.store.close();
	/** @type {{ event: string, fields: Record<string, unknown> }[]} */
	const logged = [];
	/** @param {string} event @param {Record<string, unknown>} [fields] */
	const note = (event, fields = {}) => {
		logged.push({ event, fields });
	};
	const store = new PageStore({ dataDir: made.dir, clock: made.clock, log: { info: note, warn: note, error: note }, randomBytes: counterBytes(5000), maxFileBytes });
	t.after(() => store.close());
	/** @param {Buffer} bytes @param {string} name the last part of the address: every file its own */
	const save = (bytes, name) => {
		made.clock.advance(1000);
		return store.saveFile(arrived(made.dir, bytes, { url: `https://example.com/files/${name}`, final_url: null }));
	};
	return { store, dir: made.dir, clock: made.clock, logged, save, events: (/** @type {string} */ event) => logged.filter((l) => l.event === event).map((l) => l.fields) };
}

// The file store had no limit as a whole, and the same bytes were kept once per fetch.
test("the same bytes are kept once: every record that holds them is a name for one file, counted once, gone with the last of them", (t) => {
	const { store, dir, clock, save, events } = roomFor(t, FILE_STORE.maxTotalBytes);
	const a = save(PDF, "a.pdf?cb=1");
	const b = save(PDF, "a.pdf?cb=2");
	const c = save(PDF, "elsewhere/other-name.pdf");
	assert.equal(new Set([a.id, b.id, c.id]).size, 3, "three records");
	for (const id of [a.id, b.id, c.id]) {
		assert.deepEqual(fs.readdirSync(fileDir(dir, id)).sort(), ["data", "meta.json"]);
		assert.equal(fs.readFileSync(path.join(fileDir(dir, id), "data")).equals(PDF), true);
		assert.equal(store.readFileChunk(id, 0, FILE_LIMITS.exportChunkBytes)?.equals(PDF), true);
		if (MODES) assert.equal(bytesOf(dir, id).mode & 0o777, 0o600);
	}
	assert.deepEqual([bytesOf(dir, b.id).ino, bytesOf(dir, c.id).ino], [bytesOf(dir, a.id).ino, bytesOf(dir, a.id).ino], "one file under three names");
	assert.equal(bytesOf(dir, a.id).nlink, 3);
	assert.deepEqual(store.stats(), { pages: 0, stored: 0, files: 3, file_bytes: PDF.length, file_bytes_max: FILE_STORE.maxTotalBytes });
	assert.deepEqual(fs.readdirSync(path.join(dir, "incoming")), [], "what was put together for the second and third is gone");
	// Other bytes of the same size are another file.
	const other = save(Buffer.from(PDF).fill(0x41, 20, 30), "b.pdf");
	assert.notEqual(bytesOf(dir, other.id).ino, bytesOf(dir, a.id).ino);
	assert.equal(store.stats().file_bytes, 2 * PDF.length);
	// The records are their own: each has its address and name, and is found by them.
	assert.deepEqual([store.getFileMeta(a.id)?.url, store.getFileMeta(c.id)?.url], ["https://example.com/files/a.pdf?cb=1", "https://example.com/files/elsewhere/other-name.pdf"]);
	assert.deepEqual(store.search("other name").map((h) => h.id), [c.id]);

	// Purge takes the oldest record: the bytes stay for the others, and go with the last.
	clock.advance(60 * MIN);
	const late = save(PDF, "late.pdf");
	assert.equal(bytesOf(dir, late.id).ino, bytesOf(dir, a.id).ino);
	assert.deepEqual(store.purge({ maxAgeMs: 30 * MIN }), { rows: 0, dirs: 0, refused: 0, files: 4, unknown: 0 });
	assert.deepEqual(onDisk(dir), [late.id]);
	assert.equal(bytesOf(dir, late.id).nlink, 1);
	assert.equal(store.readFileChunk(late.id, 0, FILE_LIMITS.exportChunkBytes)?.equals(PDF), true);
	assert.deepEqual(store.stats(), { pages: 0, stored: 0, files: 1, file_bytes: PDF.length, file_bytes_max: FILE_STORE.maxTotalBytes });
	clock.advance(60 * MIN);
	assert.equal(store.purge({ maxAgeMs: 30 * MIN }).files, 1);
	assert.deepEqual([onDisk(dir), store.stats().file_bytes], [[], 0]);

	// Bytes are shared only after they were read and found to be what their record says: a record whose
	// bytes are others (of the same size) is not linked to, and that is written down.
	const first = save(PDF, "first.pdf");
	fs.rmSync(path.join(fileDir(dir, first.id), "data"));
	fs.writeFileSync(path.join(fileDir(dir, first.id), "data"), Buffer.from(PDF).fill(0x58, 12, 40), { mode: 0o600 });
	const second = save(PDF, "second.pdf");
	assert.notEqual(bytesOf(dir, second.id).ino, bytesOf(dir, first.id).ino);
	assert.equal(fs.readFileSync(path.join(fileDir(dir, second.id), "data")).equals(PDF), true, "the new record holds the bytes that arrived");
	assert.deepEqual(events("store.bytes_differ"), [{ id: first.id }]);
	assert.equal(store.stats().file_bytes, 2 * PDF.length, "two files lie there, and two are counted");
	const third = save(PDF, "third.pdf");
	assert.equal(bytesOf(dir, third.id).ino, bytesOf(dir, second.id).ino, "the next one shares the good bytes");
	assert.equal(store.stats().file_bytes, 2 * PDF.length);
});

test("the file store has a size: the oldest files go until a new one fits, a file that cannot fit is refused, and the same bytes again need no room", (t) => {
	const { store, dir, save, events } = roomFor(t, 1000);
	assert.equal(store.stats().file_bytes_max, 1000);
	const f1 = save(sized(300, 1), "1.pdf");
	const f2 = save(sized(300, 2), "2.pdf");
	const f3 = save(sized(300, 3), "3.pdf");
	assert.deepEqual([store.stats().files, store.stats().file_bytes, events("store.files_evicted")], [3, 900, []]);
	// One more: the oldest goes, bytes, record, row and search entry.
	const f4 = save(sized(300, 4), "4.pdf");
	assert.deepEqual(onDisk(dir), [f2.id, f3.id, f4.id].sort());
	assert.equal(store.getFileMeta(f1.id), null);
	assert.deepEqual(store.search("1 pdf").map((h) => h.id).includes(f1.id), false);
	assert.deepEqual(events("store.files_evicted"), [{ files: 1, bytes: 300 }]);
	assert.deepEqual([store.stats().files, store.stats().file_bytes], [3, 900]);
	// A large one takes the place of as many as it needs, oldest first - and of no more.
	const f5 = save(sized(500, 5), "5.pdf");
	assert.deepEqual(onDisk(dir), [f4.id, f5.id].sort(), "the two oldest went; the newest of the three stayed");
	assert.equal(store.stats().file_bytes, 800);
	// Exactly the size of the store: everything else goes.
	const whole = save(sized(1000, 6), "6.pdf");
	assert.deepEqual([onDisk(dir), store.stats().file_bytes], [[whole.id], 1000]);

	// One byte more than the store has room for in all: refused, and nothing was given up for it.
	const tooLarge = arrived(dir, sized(1001, 7), { url: "https://example.com/files/7.pdf" });
	assert.throws(() => store.saveFile(tooLarge), (err) => err instanceof StoreError && err.code === "store_full");
	assert.deepEqual([onDisk(dir), store.stats().file_bytes], [[whole.id], 1000], "the file that was there is still there");
	assert.equal(fs.existsSync(tooLarge.tempPath), true, "the bytes are where they were: whoever brought them removes them");
	assert.equal(fs.readdirSync(path.dirname(fileDir(dir, whole.id))).some((n) => n.startsWith(".tmp-")), false);

	// The reviewer's loop: the same content under a new address every time. One file, however often.
	for (let i = 0; i < 12; i++) save(sized(1000, 6), `6.pdf?cb=${i}`);
	assert.deepEqual([store.stats().files, store.stats().file_bytes], [13, 1000]);
	assert.equal(bytesOf(dir, whole.id).nlink, 13);
	assert.equal(events("store.files_evicted").length, 3, "nothing went for any of the twelve");
	// A record that shares its bytes frees nothing when it goes: the bytes go with the last one that holds them.
	const next = save(sized(400, 8), "8.pdf");
	assert.deepEqual([onDisk(dir), store.stats().file_bytes], [[next.id], 400]);
	assert.deepEqual(events("store.files_evicted").at(-1), { files: 13, bytes: 1000 });
});

test("a file that is being read in pieces is not evicted under its reader; once it was read to its end, or the reader stays away, it is a file like any other", (t) => {
	const { store, dir, clock, save } = roomFor(t, 1000);
	const old = save(sized(400, 1), "old.pdf");
	const mid = save(sized(400, 2), "mid.pdf");
	// A reader takes the first piece of the oldest file ...
	assert.equal(store.readFileChunk(old.id, 0, 100)?.length, 100);
	// ... and a new file needs room: the next oldest goes instead.
	const young = save(sized(400, 3), "young.pdf");
	assert.deepEqual(onDisk(dir), [old.id, young.id].sort());
	assert.equal(store.readFileChunk(old.id, 100, 100)?.equals(sized(400, 1).subarray(100, 200)), true, "the reader goes on where it was");
	// Both are being read: there is nothing that may go, and the new file is refused rather than a reader cut off.
	assert.equal(store.readFileChunk(young.id, 0, 399)?.length, 399);
	const blocked = arrived(dir, sized(400, 4), { url: "https://example.com/files/blocked.pdf" });
	assert.throws(() => store.saveFile(blocked), (err) => err instanceof StoreError && err.code === "store_full");
	assert.deepEqual(onDisk(dir), [old.id, young.id].sort());
	// The same bytes as a file that is there need no room, readers or not.
	const twin = save(sized(400, 1), "twin.pdf");
	assert.equal(bytesOf(dir, twin.id).ino, bytesOf(dir, old.id).ino);
	// The reader of the old file takes its last piece: from then on it can go again. (Its twin holds the same bytes, and goes with it.)
	assert.equal(store.readFileChunk(old.id, 200, 200)?.length, 200);
	const after = save(sized(400, 5), "after.pdf");
	assert.deepEqual(onDisk(dir), [young.id, after.id].sort(), "the oldest went with its twin; the one still being read stayed");
	// A reader that does not come back is not waited for longer than a minute.
	clock.advance(FILE_STORE.readHoldMs + 1000);
	const last = save(sized(400, 6), "last.pdf");
	assert.deepEqual(onDisk(dir), [after.id, last.id].sort());
	// holdFile is what a reader of the text of a file is given (the fetch service calls it): the same rule.
	store.holdFile(after.id);
	const more = save(sized(400, 7), "more.pdf");
	assert.deepEqual(onDisk(dir), [after.id, more.id].sort());
	store.holdFile(after.id, true);
	const end = save(sized(400, 8), "end.pdf");
	assert.deepEqual(onDisk(dir), [more.id, end.id].sort());
	store.holdFile("not an id");
	assert.throws(() => new PageStore({ dataDir: dir, clock, log: quietLog(), maxFileBytes: -1 }), RangeError);
});

test("rebuildIndex finds out again which files share their bytes, and makes the links that are missing; an index from before that counts every file on its own", (t) => {
	const { store, dir, clock, save } = roomFor(t, FILE_STORE.maxTotalBytes);
	const a = save(PDF, "a.pdf");
	const b = save(PDF, "b.pdf");
	const c = save(PDF, "c.pdf");
	const other = save(sized(PDF.length, 9), "other.pdf");
	assert.equal(store.stats().file_bytes, 2 * PDF.length);
	// As after a copy of the data directory that did not keep the links: the bytes of b are a file of their own.
	fs.rmSync(path.join(fileDir(dir, b.id), "data"));
	fs.writeFileSync(path.join(fileDir(dir, b.id), "data"), PDF, { mode: 0o600 });
	// And c holds other bytes of the same size than its record says: that is not put right by linking.
	fs.rmSync(path.join(fileDir(dir, c.id), "data"));
	fs.writeFileSync(path.join(fileDir(dir, c.id), "data"), Buffer.from(PDF).fill(0x5a, 15, 25), { mode: 0o600 });
	assert.equal(new Set([a.id, b.id, c.id].map((id) => bytesOf(dir, id).ino)).size, 3);
	store.close();
	fs.rmSync(path.join(dir, "index.db"));

	/** @type {{ event: string, fields: Record<string, unknown> }[]} */
	const logged = [];
	/** @param {string} event @param {Record<string, unknown>} [fields] */
	const note = (event, fields = {}) => {
		logged.push({ event, fields });
	};
	const fresh = new PageStore({ dataDir: dir, clock, log: { info: note, warn: note, error: note }, randomBytes: counterBytes(7000) });
	assert.equal(fresh.rebuildIndex().files, 4);
	assert.equal(bytesOf(dir, b.id).ino, bytesOf(dir, a.id).ino, "b is a name for the bytes of a again");
	assert.equal(bytesOf(dir, a.id).nlink, 2);
	assert.notEqual(bytesOf(dir, c.id).ino, bytesOf(dir, a.id).ino, "c was left as it is");
	assert.deepEqual(logged.filter((l) => l.event === "store.links_restored").map((l) => l.fields), [{ files: 1 }]);
	assert.deepEqual(fs.readdirSync(fileDir(dir, b.id)).sort(), ["data", "meta.json"], "no temporary name is left");
	// a and b once, c on its own, the other file: three files' worth of bytes.
	assert.equal(fresh.stats().file_bytes, 3 * PDF.length);
	// Twice gives the same, and makes no link again.
	assert.equal(fresh.rebuildIndex().files, 4);
	assert.equal(fresh.stats().file_bytes, 3 * PDF.length);
	assert.equal(logged.filter((l) => l.event === "store.links_restored").length, 1);
	// A new file with those bytes shares them, as before the index was lost.
	const d = fresh.saveFile(arrived(dir, PDF, { url: "https://example.com/files/d.pdf" }));
	assert.equal(bytesOf(dir, d.id).ino, bytesOf(dir, a.id).ino);
	assert.equal(fresh.stats().file_bytes, 3 * PDF.length);
	assert.notEqual(other.id, d.id);
	fresh.close();

	// An index from before the same bytes were kept once has no word for what a file's bytes are counted under.
	const db = new DatabaseSync(path.join(dir, "index.db"));
	db.exec("DROP INDEX files_content; ALTER TABLE files DROP COLUMN content;");
	db.close();
	const upgraded = new PageStore({ dataDir: dir, clock, log: quietLog(), randomBytes: counterBytes(8000) });
	t.after(() => upgraded.close());
	// Until it is rebuilt every file counts on its own: more than lies there, never less.
	assert.deepEqual([upgraded.stats().files, upgraded.stats().file_bytes], [5, 5 * PDF.length]);
	assert.equal(upgraded.rebuildIndex().files, 5);
	assert.equal(upgraded.stats().file_bytes, 3 * PDF.length);
});

// ---------------------------------------------------------------- the text of a file in the index, and files the index does not know

/** @param {string} dir @returns {{ id: string, chars: number }[]} how much text of each file the index holds, oldest first */
function indexedText(dir) {
	const db = new DatabaseSync(path.join(dir, "index.db"));
	try {
		return db.prepare("SELECT f.id AS id, length(t.body) AS chars FROM files f JOIN files_fts t ON t.rowid = f.rowid ORDER BY f.fetched_ms, f.id").all().map((r) => ({ id: String(r.id), chars: Number(r.chars) }));
	} finally {
		db.close();
	}
}

test("the text of a file is in the index once however often the same bytes are fetched: with the newest record, the others are found by name and address", (t) => {
	const { store, dir, clock } = openStore(t);
	const text = `quarterly numbers ${"zebracorn ".repeat(500)}`;
	const bytes = Buffer.from(text, "utf8");
	const notes = (/** @type {number} */ n) => arrived(dir, bytes, { url: `https://example.com/dl/notes.txt?v=${n}`, final_url: null, suggested_name: `notes-${n}.txt`, declared_type: "text/plain", sniffed_type: "text/plain", text_like: true });
	/** @type {string[]} */
	const ids = [];
	for (let n = 1; n <= 4; n++) {
		ids.push(store.saveFile(notes(n)).id);
		clock.advance(1000);
	}
	// Another text of its own, to see that it is left alone.
	const other = store.saveFile(arrived(dir, Buffer.from("another text about okapis"), { url: "https://example.com/dl/other.txt", final_url: null, declared_type: "text/plain", sniffed_type: "text/plain", text_like: true }));
	assert.equal(store.stats().file_bytes, bytes.length + 25, "the bytes are there once");
	assert.deepEqual(indexedText(dir), [...ids.slice(0, 3).map((id) => ({ id, chars: 0 })), { id: ids[3], chars: text.length }, { id: other.id, chars: 25 }]);
	assert.deepEqual(store.search("zebracorn").map((h) => h.id), [ids[3]], "found by its text: the newest record of it");
	assert.deepEqual(store.search("notes").map((h) => h.id).sort(), [...ids].sort(), "every record is found by its name");
	assert.deepEqual(store.search("okapis").map((h) => h.id), [other.id]);
	for (const id of ids) assert.equal(store.readFileText(id), text, "and every one of them is read as before");

	// A rebuild comes to the same.
	store.rebuildIndex();
	assert.deepEqual(indexedText(dir), [...ids.slice(0, 3).map((id) => ({ id, chars: 0 })), { id: ids[3], chars: text.length }, { id: other.id, chars: 25 }]);
	assert.deepEqual(store.search("zebracorn").map((h) => h.id), [ids[3]]);
	store.close();

	// An index from before: the text with every record. Cleared when such an index is opened, once.
	const db = new DatabaseSync(path.join(dir, "index.db"));
	db.prepare("UPDATE files_fts SET body = ? WHERE rowid IN (SELECT rowid FROM files WHERE id != ?)").run(text, other.id);
	db.exec("ALTER TABLE pages DROP COLUMN bytes");
	db.close();
	assert.deepEqual(indexedText(dir).map((r) => r.chars), [text.length, text.length, text.length, text.length, 25]);
	const upgraded = new PageStore({ dataDir: dir, clock, log: quietLog(), randomBytes: counterBytes(700) });
	t.after(() => upgraded.close());
	assert.deepEqual(indexedText(dir).map((r) => r.chars), [0, 0, 0, text.length, 25]);
	assert.deepEqual(upgraded.search("zebracorn").map((h) => h.id), [ids[3]]);
});

test("files the index does not know: purge removes them by the time in their id, and an index that was lost is rebuilt with them", (t) => {
	const { store, dir, clock, log } = openStore(t);
	const old = store.saveFile(arrived(dir, PDF, { url: "https://example.com/old.pdf", suggested_name: "old.pdf" }));
	clock.advance(20 * MIN);
	const young = store.saveFile(arrived(dir, Buffer.from("young text file"), { url: "https://example.com/young.txt", final_url: null, declared_type: "text/plain", sniffed_type: "text/plain", text_like: true }));
	const page = store.save(makeRecord());
	assert.equal(store.recoverIndex(), null);
	store.close();

	// The index is lost.
	fs.rmSync(path.join(dir, "index.db"));
	const fresh = new PageStore({ dataDir: dir, clock, log, randomBytes: counterBytes(800) });
	t.after(() => fresh.close());
	assert.deepEqual(fresh.recoverIndex(), { pages: 1, stored: 1, skipped: 0, files: 2, ms: 0 });
	assert.deepEqual(fresh.stats(), { pages: 1, stored: 1, files: 2, file_bytes: PDF.length + 15, file_bytes_max: 2147483648 });
	assert.deepEqual(fresh.search("young").map((h) => h.id), [young.id]);
	assert.notEqual(fresh.getMeta(page.id), null);
	fresh.close();

	// Only files, no page: that is a store with records as well.
	fs.rmSync(path.join(dir, "index.db"));
	fs.rmSync(path.join(dir, "pages"), { recursive: true });
	const filesOnly = new PageStore({ dataDir: dir, clock, log, randomBytes: counterBytes(850) });
	t.after(() => filesOnly.close());
	assert.deepEqual(filesOnly.recoverIndex(), { pages: 0, stored: 0, skipped: 0, files: 2, ms: 0 });
	filesOnly.close();

	// The rows of both files are gone, the index is not empty (a page is saved): the files are unknown to it.
	const db = new DatabaseSync(path.join(dir, "index.db"));
	db.exec("DELETE FROM files_fts; DELETE FROM files;");
	db.close();
	const again = new PageStore({ dataDir: dir, clock, log, randomBytes: counterBytes(900) });
	t.after(() => again.close());
	again.save(makeRecord());
	assert.equal(again.recoverIndex(), null);
	assert.equal(again.stats().files, 0);
	clock.advance(15 * MIN);
	assert.deepEqual(again.purge({ maxAgeMs: 30 * MIN }), { rows: 0, dirs: 0, refused: 0, files: 0, unknown: 1 });
	assert.equal(fs.existsSync(fileDir(dir, old.id)), false);
	assert.equal(fs.existsSync(fileDir(dir, young.id)), true);
	clock.advance(16 * MIN);
	// The page that was saved a moment ago is as old by now, and goes with its row.
	assert.deepEqual(again.purge({ maxAgeMs: 30 * MIN }), { rows: 1, dirs: 1, refused: 0, files: 0, unknown: 1 });
	assert.equal(fs.existsSync(fileDir(dir, young.id)), false);
});
