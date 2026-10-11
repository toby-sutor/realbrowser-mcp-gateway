// What a file is, told from its first bytes, and whether a file with a declared
// type may be kept. Shared by both sides: the daemon decides (it holds the
// operator's allowlist and stores the file), the extension runs the same check
// on what it captured so that a body nobody wants is not transferred at all.
// Standard JS only.
//
// Nothing here opens, unpacks, parses or renders a file. A few magic numbers
// at fixed places are compared, and the head is looked at for bytes that no
// text has and for the markup a text begins with.
//
// The rule (decideFile): a file is kept when its declared type is on the
// allowlist, its head is none of the refused classes, it is no HTML, and
// declared and actual type fit together:
//
//   declared                         the head must be
//   application/pdf                  a PDF
//   application/zip, gzip, x-tar     that archive
//   image/png, jpeg, gif, webp       one of those four (which one is not held against it)
//   JSON, XML (SVG is XML), text/*   text: no byte that only binary data has
//   application/octet-stream         something recognised whose own type is on the allowlist
//   anything else on the list        anything that is no HTML
//
// Refused whatever they are declared as: executables (ELF, PE/DOS, Mach-O and
// Java class files, WebAssembly, Android dex), scripts with a shebang, Windows
// shortcuts, installers and packages (MSI and other OLE compound files, CAB,
// deb, rpm) - and HTML, under every declared type, a text type included
// (FILE_CODE.MISMATCH): a web page is fetched as a page, never kept as a file.
//
// What counts as HTML (leadingMarkup). The head is read as text; a byte order
// mark, white space, comments (<!-- -->, and the short forms <!--> and <!--->
// that an HTML parser takes for one) and processing instructions (<? ?>) in
// front are skipped. Then:
//
//   1. <!doctype html ...>, with or without white space before the name: HTML.
//   2. After an XML declaration, another processing instruction or a doctype
//      that is not html, the file is XML and is judged by its root element
//      alone: a root named "html" (with or without a prefix) is HTML (XHTML),
//      a root named "svg" is SVG, every other root is XML. A doctype ends
//      where an XML parser ends it: behind its internal subset, and not at a
//      ">" or "]" inside a quoted literal, a comment or a processing
//      instruction of that subset. Where the head ends before the doctype
//      does, the name the doctype gives the root stands in for the root.
//   3. Without any of those, by the first tag, whatever its case:
//      html head body title base link meta style script noscript template
//      iframe frame frameset object embed applet form     HTML (DOCUMENT_TAGS): what
//                                                         a document or a script begins with
//      svg                                                SVG
//      h1 div font table a b br p img                     HTML too (FLOW_TAGS) - except
//                                                         under a declared text type, where
//                                                         Markdown and plain text begin that
//                                                         way all the time and stay text
//      any other tag                                      XML
//   4. A text that begins with no tag at all is plain text, or JSON when it
//      begins with { or [.
//
// "Script" is what begins with <script (rule 3) or with a shebang (refused
// above). Program text in a language that has no such mark - Python,
// JavaScript, a shell fragment - cannot be told from prose by its first bytes
// and is text. An SVG or other XML is kept as text only, script inside it or
// not: nothing here renders it, and no exported file is named .svg or .html.
//
// What this check does not see. It looks at the first SNIFF_BYTES bytes and
// at what a file BEGINS with. HTML that stands behind other text ("x<html>"),
// behind more white space or a longer comment than the head holds, or inside
// an XML file whose root is something else (an element of the XHTML or SVG
// namespace under any root) is not found here: such a file is kept, as text
// or as XML. So the guarantee of this file is: nothing that begins as an
// HTML document is kept, and nothing whose head is one of the refused classes.
// It is the daemon that has all of a file: before it stores one as
// "application/xml" - the one text type whose exported copy a browser would
// run script from - it reads all of it (daemon/src/files.js, xmlIsPlain) and
// stores it as "text/plain" unless it is plain data. Text in two-byte units
// is told from binary data by the same test as text in bytes, on its units.
//
// The sniffed type of a text file says no more than its declared type allows:
// "application/json" only under a declared JSON type, "application/xml" and
// "image/svg+xml" only under a declared XML type, "text/csv" only under a
// declared text/csv - CSV has no mark of its own, so there it is every text
// that begins with no markup - and "text/plain" for everything else
// (Markdown, source code, an SVG served as text/plain, CSV under another
// type).

/** How much of a file the check looks at: the tar magic lies at offset 257. */
export const SNIFF_BYTES = 4096;

export const REFUSED_CLASS = Object.freeze({
	EXECUTABLE: "executable",
	SCRIPT: "script",
	SHORTCUT: "shortcut",
	INSTALLER: "installer",
});

/** Every type sniff() can name. A fixed vocabulary: none of it comes from a server. */
export const SNIFFED_TYPES = Object.freeze([
	"application/pdf",
	"application/zip",
	"application/gzip",
	"application/x-tar",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"application/json",
	"application/xml",
	"image/svg+xml",
	"text/html",
	"text/plain",
	"text/csv",
	"application/x-empty",
	"application/octet-stream",
	"application/x-executable",
	"text/x-script",
	"application/x-ms-shortcut",
	"application/x-installer",
]);

export const FILE_CODE = Object.freeze({
	NOT_ALLOWED: "file_type_not_allowed",
	REFUSED: "file_content_refused",
	MISMATCH: "file_type_mismatch",
});

/** What files.allow_types of config.json holds unless the operator says otherwise. */
export const DEFAULT_ALLOW_TYPES = Object.freeze([
	"application/pdf",
	"application/json",
	"+json",
	"application/xml",
	"text/xml",
	"+xml",
	"text/plain",
	"text/csv",
	"text/markdown",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"application/zip",
	"application/gzip",
	"application/x-tar",
	"application/octet-stream",
]);

/** An entry of an allowlist: a media type, or "+suffix" for every type that ends with it. */
export const ALLOW_ENTRY_RE = /^(?:\+[a-z0-9.-]{1,40}|[a-z0-9!#$&^_.-]{1,60}\/[a-z0-9!#$&^_.+-]{1,120})$/;

/**
 * @typedef {object} Sniffed
 * @property {string} type one of SNIFFED_TYPES
 * @property {string | null} refused one of REFUSED_CLASS when the head is something that is never kept
 * @property {boolean} text the head holds no byte that only binary data has
 * @property {boolean} [fragment] with type "text/html" only: the head begins with a tag that Markdown and plain text
 *   begin with as well (FLOW_TAGS), not with one that only a document or a script begins with
 *
 * @typedef {{ ok: true, sniffed: string, textLike: boolean } | { ok: false, code: string, sniffed: string | null, refused: string | null }} FileVerdict
 *   textLike: the file may be shown as text. code: one of FILE_CODE
 */

/**
 * @param {Uint8Array} head
 * @param {number} at
 * @param {readonly number[]} bytes
 * @returns {boolean}
 */
function has(head, at, bytes) {
	if (head.length < at + bytes.length) return false;
	for (let i = 0; i < bytes.length; i++) {
		if (head[at + i] !== bytes[i]) return false;
	}
	return true;
}

/** @param {string} s @returns {number[]} */
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** @type {readonly { at: number, bytes: number[], type: string, refused: string | null }[]} */
const MAGIC = Object.freeze([
	{ at: 0, bytes: [0x7f, ...ascii("ELF")], type: "application/x-executable", refused: REFUSED_CLASS.EXECUTABLE },
	{ at: 0, bytes: ascii("MZ"), type: "application/x-executable", refused: REFUSED_CLASS.EXECUTABLE },
	{ at: 0, bytes: [0xfe, 0xed, 0xfa, 0xce], type: "application/x-executable", refused: REFUSED_CLASS.EXECUTABLE },
	{ at: 0, bytes: [0xfe, 0xed, 0xfa, 0xcf], type: "application/x-executable", refused: REFUSED_CLASS.EXECUTABLE },
	{ at: 0, bytes: [0xce, 0xfa, 0xed, 0xfe], type: "application/x-executable", refused: REFUSED_CLASS.EXECUTABLE },
	{ at: 0, bytes: [0xcf, 0xfa, 0xed, 0xfe], type: "application/x-executable", refused: REFUSED_CLASS.EXECUTABLE },
	// Mach-O universal binaries and Java class files share this one.
	{ at: 0, bytes: [0xca, 0xfe, 0xba, 0xbe], type: "application/x-executable", refused: REFUSED_CLASS.EXECUTABLE },
	{ at: 0, bytes: [0x00, ...ascii("asm")], type: "application/x-executable", refused: REFUSED_CLASS.EXECUTABLE },
	{ at: 0, bytes: [...ascii("dex"), 0x0a], type: "application/x-executable", refused: REFUSED_CLASS.EXECUTABLE },
	{ at: 0, bytes: ascii("#!"), type: "text/x-script", refused: REFUSED_CLASS.SCRIPT },
	{ at: 0, bytes: [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00], type: "application/x-ms-shortcut", refused: REFUSED_CLASS.SHORTCUT },
	{ at: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], type: "application/x-installer", refused: REFUSED_CLASS.INSTALLER },
	{ at: 0, bytes: ascii("MSCF"), type: "application/x-installer", refused: REFUSED_CLASS.INSTALLER },
	{ at: 0, bytes: [...ascii("!<arch>"), 0x0a], type: "application/x-installer", refused: REFUSED_CLASS.INSTALLER },
	{ at: 0, bytes: [0xed, 0xab, 0xee, 0xdb], type: "application/x-installer", refused: REFUSED_CLASS.INSTALLER },
	{ at: 0, bytes: ascii("%PDF-"), type: "application/pdf", refused: null },
	{ at: 0, bytes: [...ascii("PK"), 0x03, 0x04], type: "application/zip", refused: null },
	{ at: 0, bytes: [...ascii("PK"), 0x05, 0x06], type: "application/zip", refused: null },
	{ at: 0, bytes: [...ascii("PK"), 0x07, 0x08], type: "application/zip", refused: null },
	{ at: 0, bytes: [0x1f, 0x8b], type: "application/gzip", refused: null },
	{ at: 257, bytes: ascii("ustar"), type: "application/x-tar", refused: null },
	{ at: 0, bytes: [0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a], type: "image/png", refused: null },
	{ at: 0, bytes: [0xff, 0xd8, 0xff], type: "image/jpeg", refused: null },
	{ at: 0, bytes: ascii("GIF87a"), type: "image/gif", refused: null },
	{ at: 0, bytes: ascii("GIF89a"), type: "image/gif", refused: null },
]);

// Tags that only an HTML document, or something in it that runs or loads, begins with.
const DOCUMENT_TAGS = new Set(["html", "head", "body", "title", "base", "link", "meta", "style", "script", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "applet", "form"]);
// Tags a browser also takes for the start of HTML, and with which Markdown and plain text begin just as well.
const FLOW_TAGS = new Set(["h1", "div", "font", "table", "a", "b", "br", "p", "img"]);
const WHITE = /[ \t\n\r\f]/;

/**
 * Where a doctype declaration ends, as an XML parser reads it: at the first ">" that stands neither in a quoted
 * literal nor in the internal subset. Inside the subset, quoted literals, comments and processing instructions
 * are passed over whole, so that a "]" or ">" in one of them ends nothing.
 * @param {string} text
 * @param {number} from behind "<!doctype"
 * @returns {number} the index of that ">"; -1 when the text ends first
 */
function doctypeEnd(text, from) {
	let subset = false;
	for (let j = from; j < text.length; j++) {
		const c = text[j];
		if (c === '"' || c === "'") {
			j = text.indexOf(c, j + 1);
			if (j === -1) return -1;
		} else if (subset && text.startsWith("<!--", j)) {
			j = text.indexOf("-->", j + 4);
			if (j === -1) return -1;
			j += 2;
		} else if (subset && text.startsWith("<?", j)) {
			j = text.indexOf("?>", j + 2);
			if (j === -1) return -1;
			j += 1;
		} else if (c === "[") subset = true;
		else if (c === "]") subset = false;
		else if (c === ">" && !subset) return j;
	}
	return -1;
}

/**
 * The markup a text begins with (the rule at the top of this file).
 * @param {string} text the head of a file, one character per byte, without a byte order mark
 * @returns {"html" | "fragment" | "svg" | "xml" | null} null: it begins with no markup
 */
export function leadingMarkup(text) {
	let i = 0;
	const skipWhite = () => {
		while (i < text.length && WHITE.test(text[i])) i++;
	};
	// An XML declaration, a processing instruction or a doctype other than html came first: what follows is XML.
	let xml = false;
	/** @type {string | null} the name a doctype gave the root, when the head ends before the root itself */
	let named = null;
	for (;;) {
		skipWhite();
		if (text.startsWith("<!--", i)) {
			// The two short forms: to an HTML parser each is a whole comment, and what follows it is the document.
			const short = text.startsWith(">", i + 4) ? 5 : text.startsWith("->", i + 4) ? 6 : 0;
			const end = short > 0 ? i + short - 3 : text.indexOf("-->", i + 4);
			// A comment that does not end within the head: nothing is known of what follows it.
			if (end === -1) return xml ? "xml" : null;
			i = end + 3;
		} else if (text.startsWith("<?", i)) {
			xml = true;
			const end = text.indexOf("?>", i + 2);
			if (end === -1) return "xml";
			i = end + 2;
		} else if (/^<!doctypehtml(?![A-Za-z0-9_.:-])/i.test(text.slice(i, i + 14))) {
			// No white space before the name: an error to an HTML parser, and a doctype all the same.
			return "html";
		} else if (/^<!doctype(?![A-Za-z0-9])/i.test(text.slice(i, i + 10))) {
			const name = /^<!doctype[ \t\n\r\f]+([A-Za-z_][A-Za-z0-9_.:-]*)/i.exec(text.slice(i, i + 200))?.[1].toLowerCase() ?? "";
			if (name === "html" || name.endsWith(":html")) return "html";
			xml = true;
			named = name;
			const end = doctypeEnd(text, i + 9);
			if (end === -1) break;
			i = end + 1;
		} else {
			named = null;
			break;
		}
	}
	const tag = named ?? /^<([A-Za-z_][A-Za-z0-9_.:-]*)(?=[ \t\n\r\f>/]|$)/.exec(text.slice(i, i + 200))?.[1].toLowerCase() ?? null;
	if (tag === null) return xml ? "xml" : null;
	if (xml) {
		const local = tag.slice(tag.lastIndexOf(":") + 1);
		return local === "html" ? "html" : local === "svg" ? "svg" : "xml";
	}
	if (DOCUMENT_TAGS.has(tag)) return "html";
	if (tag === "svg") return "svg";
	return FLOW_TAGS.has(tag) ? "fragment" : "xml";
}

/**
 * A byte that text does not hold (the definition browsers sniff by): the C0
 * controls without tab, line feed, form feed, carriage return and escape.
 * @param {number} b
 * @returns {boolean}
 */
function isBinaryByte(b) {
	return b <= 0x08 || b === 0x0b || (b >= 0x0e && b <= 0x1a) || (b >= 0x1c && b <= 0x1f);
}

/**
 * @param {Uint8Array} head the first bytes of a file, SNIFF_BYTES of them or the whole file when it is shorter
 * @returns {Sniffed}
 */
export function sniff(head) {
	if (head.length === 0) return { type: "application/x-empty", refused: null, text: true };
	for (const m of MAGIC) {
		if (!has(head, m.at, m.bytes)) continue;
		// Two letters are not much to go by: a DOS or PE header has binary fields right behind them, a text that happens to begin with "MZ" has not.
		if (m.bytes.length === 2 && m.type === "application/x-executable" && !head.subarray(0, 64).some(isBinaryByte)) continue;
		return { type: m.type, refused: m.refused, text: m.refused === REFUSED_CLASS.SCRIPT };
	}
	if (has(head, 0, ascii("RIFF")) && has(head, 8, ascii("WEBP"))) return { type: "image/webp", refused: null, text: false };
	// Text in two-byte units is told by its mark; without one it reads as binary.
	const utf16 = has(head, 0, [0xff, 0xfe]) || has(head, 0, [0xfe, 0xff]);
	const start = has(head, 0, [0xef, 0xbb, 0xbf]) ? 3 : 0;
	if (utf16) {
		// Its markup is looked at like any text's; beyond "HTML or not" it is plain text.
		const low = head[0] === 0xff ? 0 : 1;
		let wide = "";
		// The first half of a pair that waits for its second.
		let open = false;
		for (let i = 2; i + 1 < head.length; i += 2) {
			const unit = (head[i + 1 - low] << 8) | head[i + low];
			const second = unit >= 0xdc00 && unit <= 0xdfff;
			// What text in two-byte units does not hold either: the controls that text in bytes does not hold, half a
			// pair without the other, and the two codes that are no character. The mark alone makes no text of bytes.
			if ((unit < 0x20 && isBinaryByte(unit)) || second !== open || unit === 0xfffe || unit === 0xffff) return { type: "application/octet-stream", refused: null, text: false };
			open = unit >= 0xd800 && unit <= 0xdbff;
			wide += unit < 0x100 ? String.fromCharCode(unit) : "\ufffd";
		}
		const markup = leadingMarkup(wide);
		if (markup === "html") return { type: "text/html", refused: null, text: true };
		if (markup === "fragment") return { type: "text/html", refused: null, text: true, fragment: true };
		return { type: "text/plain", refused: null, text: true };
	}
	for (let i = start; i < head.length; i++) {
		if (isBinaryByte(head[i])) return { type: "application/octet-stream", refused: null, text: false };
	}
	let lead = "";
	for (let i = start; i < head.length; i++) lead += String.fromCharCode(head[i]);
	const trimmed = lead.replace(/^[ \t\n\r]+/, "");
	if (trimmed.startsWith("#!")) return { type: "text/x-script", refused: REFUSED_CLASS.SCRIPT, text: true };
	const markup = leadingMarkup(lead);
	if (markup === "html") return { type: "text/html", refused: null, text: true };
	if (markup === "fragment") return { type: "text/html", refused: null, text: true, fragment: true };
	if (markup === "svg") return { type: "image/svg+xml", refused: null, text: true };
	if (markup === "xml") return { type: "application/xml", refused: null, text: true };
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return { type: "application/json", refused: null, text: true };
	return { type: "text/plain", refused: null, text: true };
}

/**
 * @param {string} type lowercase media type without parameters
 * @param {readonly string[]} allow entries as ALLOW_ENTRY_RE describes them
 * @returns {boolean}
 */
export function typeAllowed(type, allow) {
	// A type has two parts; a suffix entry by itself is no type.
	if (!type.includes("/")) return false;
	for (const entry of allow) {
		if (entry === type) return true;
		if (entry.startsWith("+") && type.length > entry.length && type.endsWith(entry)) return true;
	}
	return false;
}

/**
 * @param {string} type lowercase media type without parameters
 * @returns {boolean} true for the types whose content is text: JSON, XML and text/*
 */
export function isTextType(type) {
	return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type === "application/xml" || type.endsWith("+xml");
}

/**
 * @param {string} type lowercase media type without parameters
 * @returns {"json" | "xml" | "plain" | null} which kind of text a declared text type is; null: it is no text type
 */
function textFamily(type) {
	if (type === "application/json" || type === "text/json" || type.endsWith("+json")) return "json";
	if (type === "application/xml" || type === "text/xml" || type.endsWith("+xml")) return "xml";
	return type.startsWith("text/") ? "plain" : null;
}

const ARCHIVES = new Set(["application/pdf", "application/zip", "application/gzip", "application/x-tar"]);
// The images that are binary files. An SVG is text, and is kept under a text type or not at all.
const RASTER_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * May a file with this declared type and these first bytes be kept?
 * @param {{ declared: string | null, head: Uint8Array, allow: readonly string[] }} file declared: the media type the
 *   server named, lowercase, without parameters
 * @returns {FileVerdict}
 */
export function decideFile({ declared, head, allow }) {
	if (typeof declared !== "string" || !typeAllowed(declared, allow)) return { ok: false, code: FILE_CODE.NOT_ALLOWED, sniffed: null, refused: null };
	const s = sniff(head.length > SNIFF_BYTES ? head.subarray(0, SNIFF_BYTES) : head);
	if (s.refused !== null) return { ok: false, code: FILE_CODE.REFUSED, sniffed: s.type, refused: s.refused };
	/** @type {FileVerdict} */
	const mismatch = { ok: false, code: FILE_CODE.MISMATCH, sniffed: s.type, refused: null };
	const family = textFamily(declared);
	if (family !== null) {
		if (!s.text) return mismatch;
		// A web page behind a text type is a web page all the same. What merely begins like Markdown does is text.
		if (s.type === "text/html" && s.fragment !== true) return mismatch;
		// What begins with a tag of running text is XML where XML was declared, and plain text everywhere else.
		const content = s.type === "text/html" ? (family === "xml" ? "application/xml" : "text/plain") : s.type;
		// CSV is told by its declared type alone, and only where the text begins like plain text.
		if (declared === "text/csv" && s.type === "text/plain") return { ok: true, sniffed: "text/csv", textLike: true };
		// No more than the declared type allows: nothing becomes JSON or XML by how it begins.
		const agrees = family === "json" ? content === "application/json" : family === "xml" ? content === "application/xml" || content === "image/svg+xml" : false;
		return { ok: true, sniffed: agrees ? content : "text/plain", textLike: true };
	}
	if (declared.startsWith("image/")) {
		return RASTER_IMAGES.has(s.type) && typeAllowed(s.type, allow) ? { ok: true, sniffed: s.type, textLike: false } : mismatch;
	}
	if (ARCHIVES.has(declared)) return s.type === declared ? { ok: true, sniffed: s.type, textLike: false } : mismatch;
	// Under a type that says nothing about text, whatever begins with an HTML tag is taken for HTML.
	if (s.type === "text/html") return mismatch;
	if (declared === "application/octet-stream") {
		// Kept only as what it turns out to be, and only when that is on the list too.
		if (s.type === "application/octet-stream" || s.type === "application/x-empty" || !typeAllowed(s.type, allow)) return mismatch;
		return { ok: true, sniffed: s.type, textLike: s.text };
	}
	// A type the operator added: nothing is known about what it looks like, except that it is no web page.
	return { ok: true, sniffed: s.type === "application/x-empty" ? "application/octet-stream" : s.type, textLike: false };
}
