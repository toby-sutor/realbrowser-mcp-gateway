// What the daemon makes of a retrieved file besides storing it: the label it is
// shown under, the ending an exported copy gets, and its text where it is one.
// Nothing here opens, unpacks or renders a file.

export const FILE_LIMITS = Object.freeze({
	maxNameChars: 120,
	// A text file larger than this is not decoded: it is described like a binary one and fetched as a file.
	maxTextBytes: 8388608,
	// Bytes of a file in one answer of the export route (4 MiB as base64).
	exportChunkBytes: 3145728,
});

/**
 * The ending of an exported file, by what the file was stored as - and by nothing else. That is the sniffer's word
 * for its first bytes, with one correction made when the file is stored, with all of it at hand: what begins like
 * XML is "application/xml", and so ".xml", only when xmlIsPlain() says so, and "text/plain" otherwise. An exported file
 * is named "<file id><ending>" by whoever writes it (cli/bgw carries a copy of this table; a test compares the
 * two). Nothing a server said - a name, a path - has a part in it, and a declared type only in one case: text
 * that was declared and found to be CSV (the sniffer's "text/csv") gets ".csv". Every other text gets ".txt",
 * whatever kind of text: no export is ever named .html, .svg, .py, .md, .desktop or the like. An archive is
 * named for what its first bytes say it is; nothing unpacks it.
 * @type {Readonly<Record<string, string>>}
 */
export const EXPORT_ENDINGS = Object.freeze({
	"application/pdf": ".pdf",
	"application/zip": ".zip",
	"application/gzip": ".gz",
	"application/x-tar": ".tar",
	"application/json": ".json",
	"application/xml": ".xml",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"text/plain": ".txt",
	"text/csv": ".csv",
	"image/svg+xml": ".txt",
	"text/html": ".txt",
});
/** The ending of everything that is not in the table: bytes of no known kind. */
export const EXPORT_ENDING_OTHER = ".bin";

/**
 * @param {string} sniffedType one of the sniffer's words, as the file was stored under it
 * @returns {string} the ending of an exported copy of such a file
 */
export function exportEnding(sniffedType) {
	return Object.hasOwn(EXPORT_ENDINGS, sniffedType) ? EXPORT_ENDINGS[sniffedType] : EXPORT_ENDING_OTHER;
}

/** @type {Readonly<Record<string, string>>} the ending a label gets when it has none, by what the file is */
const LABEL_ENDINGS = Object.freeze({
	"application/pdf": ".pdf",
	"application/zip": ".zip",
	"application/gzip": ".gz",
	"application/x-tar": ".tar",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"application/json": ".json",
	"application/xml": ".xml",
	"text/plain": ".txt",
	"text/csv": ".csv",
});

// Names a Windows program would take for a device, whatever follows the dot.
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

/**
 * @param {string} raw
 * @returns {string} what is left of a name a server chose: the part after the last separator, without anything
 *   invisible, with only letters, digits and a few plain marks; "" when nothing is left
 */
function cleanName(raw) {
	let s = raw.normalize("NFC");
	// Lone halves of a pair, controls, format characters (the ones that turn text around), odd separators.
	s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
	// A tab is a space; every other control character is nothing.
	s = s.replace(/\t/g, " ");
	s = s.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, "");
	// Once more: a letter and its accent that stood apart with something invisible between them are one letter
	// now. Before the letters are looked at, because a mark can turn a plain sign into one that is not kept.
	s = s.normalize("NFC");
	const parts = s.split(/[/\\]/).filter((part) => part.trim() !== "");
	s = parts.length === 0 ? "" : parts[parts.length - 1];
	s = s.replace(/\s+/gu, " ").replace(/[^\p{L}\p{N}\p{M} ._()+,@=~[\]-]/gu, "_");
	// No leading dot (a hidden file), no leading dash (an option to whatever is handed the name), none of either at the end.
	s = s.replace(/^[\s._-]+/u, "").replace(/[\s.]+$/u, "");
	if (DEVICE_NAME.test(s)) s = `_${s}`;
	return s;
}

/**
 * The name a file is shown under: a label, made from what the server suggests (Content-Disposition) or, without
 * that, from the last part of the address. It is a server's word and is shown as one, between the markers of a
 * tool result. No path is ever built from it, on the daemon's disk or anywhere else, and no file is ever named
 * after it: a stored file lies under its id, and an exported one is called "<file id><ending>" (exportEnding).
 * @param {unknown} suggested
 * @param {unknown} finalUrl
 * @param {string} sniffedType what the file is, in the sniffer's words: a label without an ending gets one from it
 * @returns {string} 1 to FILE_LIMITS.maxNameChars code points, no separator, no leading dot, nothing invisible
 */
export function displayName(suggested, finalUrl, sniffedType) {
	let name = typeof suggested === "string" ? cleanName(suggested.slice(0, 1024)) : "";
	if (name === "" && typeof finalUrl === "string") {
		try {
			const segment = new URL(finalUrl).pathname.split("/").filter((part) => part !== "").pop() ?? "";
			let decoded = segment;
			try {
				decoded = decodeURIComponent(segment);
			} catch {
				// not percent-encoded text: taken as it stands
			}
			name = cleanName(decoded.slice(0, 1024));
		} catch {
			// no address to take a name from
		}
	}
	if (name === "") name = "file";
	const ending = Object.hasOwn(LABEL_ENDINGS, sniffedType) ? LABEL_ENDINGS[sniffedType] : "";
	if (ending !== "" && !/\.[\p{L}\p{N}]{1,10}$/u.test(name)) name += ending;
	const points = [...name];
	if (points.length <= FILE_LIMITS.maxNameChars) return name;
	// Too long: the ending stays, the stem is cut.
	const dot = name.lastIndexOf(".");
	const tail = dot > 0 && name.length - dot <= 11 ? [...name.slice(dot)] : [];
	return [...points.slice(0, FILE_LIMITS.maxNameChars - tail.length), ...tail].join("").replace(/[\s.]+$/u, "") || "file";
}

/**
 * @param {unknown} name
 * @returns {boolean} true for a name displayName() could have made
 */
export function isSafeName(name) {
	return typeof name === "string" && name !== "" && [...name].length <= FILE_LIMITS.maxNameChars && cleanName(name) === name;
}

/**
 * The text of a file whose bytes are text. A byte order mark decides first,
 * then the charset the server declared where this runtime knows it, then UTF-8.
 * Bytes that are no text in that encoding become the replacement character.
 * @param {Uint8Array} bytes
 * @param {string | null} charset lowercase label from the Content-Type header
 * @returns {string}
 */
export function decodeText(bytes, charset) {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
	let label = "utf-8";
	if (typeof charset === "string" && /^[a-z0-9._:-]{1,40}$/.test(charset)) {
		try {
			new TextDecoder(charset);
			label = charset;
		} catch {
			// a label this runtime does not know
		}
	}
	return new TextDecoder(label).decode(bytes);
}

// What an XML file must not hold to be handed out as ".xml", looked for in its bytes read as one character each,
// in lower case. An exported ".xml" is a file a browser opens as a document, and these are the ways such a document
// gets to run script or to be something else than it looks like:
//   - an element of the XHTML, SVG or MathML namespace, under whatever root and prefix: the namespace has to be
//     spelled somewhere. Spelled plainly it is found as it stands. Spelled with character references it is found
//     by them: a reference to a letter, a digit, ".", "/" or ":" has no other use. Built from entities or given
//     by an attribute default it needs a declaration in the doctype, and those are found.
//   - a stylesheet instruction, which can turn any XML into a page.
//   - the tags a page is made of, under any namespace or none: what looks like a page is not called data.
//   - a control character, which XML has none of and which some encodings change their meaning with.
const XML_ACTIVE = new RegExp(
	[
		"http://www\\.w3\\.org/1999/xhtml",
		"http://www\\.w3\\.org/2000/svg",
		"http://www\\.w3\\.org/1998/math/mathml",
		"<(?:script|html|body|iframe|svg)(?![a-z0-9_.-])",
		"<\\?xml-stylesheet",
		"<!entity",
		"<!attlist",
		// A reference with more zeros in front than anybody writes: the next rule would have to count them.
		"&#x?0{8}",
		"&#x0{0,7}(?:2[ef]|3[0-9a]|[46][1-9a-f]|[57][0-9a]);",
		"&#0{0,7}(?:4[6-9]|5[0-8]|6[5-9]|[78][0-9]|9[07-9]|1[01][0-9]|12[0-2]);",
		"[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]",
	].join("|"),
);
// The file is looked at in pieces of this size, each with the end of the one before it in front: longer than
// anything XML_ACTIVE can match.
const XML_PIECE = 65536;
const XML_OVERLAP = 64;

/**
 * Is a file that begins like XML plain data, all of it? Its first bytes say what it begins with (shared/sniff.js)
 * and no more: a root element of its own with a script of the XHTML namespace inside it passes there. This reads
 * every byte. Nothing is parsed: the bytes are searched for the few things listed at XML_ACTIVE, and a file that
 * holds one of them - in a comment, in a text, anywhere - is not plain. That errs to one side only: a feed that
 * quotes HTML in its entries is stored and exported as text, not as XML.
 * @param {Uint8Array} bytes the whole file
 * @returns {boolean}
 */
export function xmlIsPlain(bytes) {
	let carry = "";
	for (let at = 0; at < bytes.length; at += XML_PIECE) {
		let piece = carry;
		const end = Math.min(bytes.length, at + XML_PIECE);
		for (let i = at; i < end; i += 8192) piece += String.fromCharCode.apply(null, /** @type {number[]} */ (/** @type {unknown} */ (bytes.subarray(i, Math.min(end, i + 8192)))));
		piece = piece.toLowerCase();
		if (XML_ACTIVE.test(piece)) return false;
		carry = piece.slice(-XML_OVERLAP);
	}
	return true;
}

/**
 * Where a Windows program has its second header, if these are the first bytes of one. Two letters, "MZ", are
 * all the sniffer has to go by, and it takes them for a program only when binary data follows at once; the
 * rest of the answer lies deeper in the file than the sniffer looks.
 * @param {Uint8Array} head the first 64 bytes of a file, or all of it when it is shorter
 * @returns {number | null} the offset at which "PE\0\0" stands if the file is such a program; null when it cannot be one
 */
export function peHeaderOffset(head) {
	if (head.length < 64 || head[0] !== 0x4d || head[1] !== 0x5a) return null;
	return (head[60] | (head[61] << 8) | (head[62] << 16) | (head[63] << 24)) >>> 0;
}

/** What stands at peHeaderOffset() in a Windows program. */
export const PE_SIGNATURE = Object.freeze([0x50, 0x45, 0x00, 0x00]);
