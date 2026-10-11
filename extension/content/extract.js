// Content extraction. Injected into a job tab after vendor/defuddle.full.js,
// into the same isolated world. It defines one function and does nothing else;
// the background page then calls it:
//
//   __bgwExtract({ markdown, text, html, rawHtml, links, defuddle,
//                  maxMarkdownChars, maxTextChars, maxHtmlChars, maxRawHtmlChars, maxLinks, maxElements })
//
// Two views of a page come out of it. The article view is
// what Defuddle takes for the main content. The full visible text is all the
// page renders. Where the article view holds only a small share of that text
// (a forum thread of which it kept the first post) the Markdown is made from
// the whole page instead, and the result says which view it is.
//
// Runs on untrusted pages. Rules this file keeps:
// - The live page is only read: computed styles, geometry, attributes. Nothing
//   is written to it, no event is fired, nothing is clicked or scrolled.
// - Defuddle only ever sees a clone of the document. A clone has no styles, so
//   before anything is parsed every element that the live page does not render
//   is taken out of the clone (pruneHidden). Text a visitor cannot see is a
//   classic place for instructions aimed at an AI agent.
// - What the bundle would read without a visitor ever seeing it is taken out of
//   the clone as well: templates, the text of scripts that are no metadata, the
//   schema.org members it takes for content, the markup of drawings. A shadow
//   tree is put in the place of its host as the page shows it. The bundle's
//   extractors for single sites run on the hosts of those sites and nowhere else.
// - Only Defuddle's synchronous parse() and its Markdown converter are used.
//   Every network path in the bundle sits in async extractor methods
//   (parseAsync), and the fetch option is replaced with a rejecting stub as a
//   second barrier.
// - Output is scrubbed through DOMParser (inert document: nothing loads or runs).
//   The Markdown is text: what it says about tags is left as the page wrote it
//   (a code sample may hold any tag), only link targets are held to web addresses.
// - No eval.
(() => {
	// Must match extension/vendor/VENDOR.lock.json (checked by the smoke test).
	const DEFUDDLE_VERSION = "0.19.4";

	// Caps mirror extension/shared/protocol.js.
	const CAP = {
		title: 1000,
		author: 500,
		published: 100,
		lang: 35,
		site: 300,
		extractor: 100,
		linkText: 500,
		linkUrl: 8192,
		links: 5000,
		resultChars: 8388608,
		rawHtmlChars: 4194304,
	};
	// Fewer characters than this in Defuddle's content counts as "almost nothing".
	const MIN_CONTENT_CHARS = 40;
	// The article view stands for the page when it holds at least this share of
	// the visible text ...
	const FULL_PAGE_BELOW = 0.5;
	// ... or when the page shows too little for a second view to be worth it.
	const MIN_FULL_PAGE_CHARS = 600;
	// Markdown of a whole page that holds less than this share of its visible
	// text has lost something on the way: the text itself is returned then.
	const MIN_CONVERTED_SHARE = 0.6;
	// Defuddle's run time grows faster than the page: two megabytes of text take
	// about two seconds, nine take twenty. Beyond this the rendered text is
	// returned as it is.
	const MAX_DEFUDDLE_CHARS = 3000000;
	// Elements whose live counterpart is looked at, at most. What lies beyond is dropped, not trusted.
	const MAX_ELEMENTS = 60000;
	// "Far outside the page": the whole box lies this many pixels beyond an edge of it.
	const OFFSCREEN_PX = 1000;
	// At or below this the element and everything in it cannot be seen. For the
	// opacity of an element (its ancestors' included) and for the alpha of a text colour.
	const MIN_OPACITY = 0.11;
	// Letters this high or lower, in pixels as they are drawn, cannot be read.
	const MIN_FONT_PX = 4;
	// A box that cuts off what is in it shows no line of text when it is lower than half a letter, and at most this.
	const MIN_CLIP_PX = 8;
	// Letters are read on a background when the lighter of the two colours is at least this many times as light
	// as the darker (the ratio accessibility rules use, which begins at 1 for the same colour). A grey of #ddd
	// on white is just above it and stays; the greys between that and white are taken for the white.
	const MIN_CONTRAST = 1.35;
	// Texts that have the colour of what is behind them are looked at a second
	// time, which costs; beyond this many on one page the rest is taken for hidden.
	const MAX_BACKDROP_CHECKS = 2000;
	// The canvas of a page that asks for a dark one, as Firefox paints it. Chromium's is no further from it
	// than letters must be from their background to be read.
	const DARK_CANVAS = Object.freeze([28, 27, 34, 1]);
	// The kinds of box that cut off what does not fit: not a piece of a line, not a row of a table.
	const CLIPPING = /^(?:block|flow-root|inline-block|flex|inline-flex|grid|inline-grid|list-item|table-cell|table-caption)$/;
	// Sites the vendored bundle has an extractor of its own for: the host names in its registry
	// (ExtractorRegistry in extension/vendor/defuddle.full.js). A page is on one of them when its host is the
	// name itself or ends with a dot and the name. The bundle is less strict: it looks for the name anywhere in
	// the host, and three of its extractors go by the path alone or by nothing at all, so that any page could
	// pick the extractor that reads what the page wants read. Everywhere else those extractors are off.
	// Not in the list: wiki.c2.com, whose extractor only works over the network, which it does not get here.
	const SITE_HOSTS = [
		"bilibili.com", "bsky.app", "chatgpt.com", "claude.ai", "gemini.google.com", "github.com", "grok.com", "leetcode.com", "linkedin.com", "lwn.net",
		"mail.google.com", "medium.com", "news.ycombinator.com", "nytimes.com", "reddit.com", "substack.com", "threads.com", "threads.net", "twitter.com",
		"wikipedia.org", "x.com", "youtu.be", "youtube.com",
	];
	// Attributes the bundle takes whole pieces of content from, on any page. No visitor sees an attribute.
	const CONTENT_ATTRS = ["data-partnereventstore", "data-groupvanityinfo", "data-defuddle-shadow"];
	// Scripts that are data the bundle reads on every page: metadata, and the source of a formula.
	const SCRIPT_KEEP = 'script[type="application/ld+json"], script[type^="math/"]';
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	const SVG_NS = "http://www.w3.org/2000/svg";
	// Parts of a drawing that are never drawn where they stand: its name and description, and what is only
	// there to be used by something else (a pattern, a clip, a marker).
	const SVG_UNSEEN = new Set(["title", "desc", "metadata", "defs", "clipPath", "mask", "pattern", "marker", "symbol", "style", "script", "linearGradient", "radialGradient", "filter"]);
	// What the page keeps for a browser without scripts is among them: this one runs them, so no visitor sees it.
	const DROP_TAGS = "script,style,iframe,object,embed,form,link,meta,base,template,noscript";
	const URL_ATTRS = ["href", "src", "xlink:href", "poster", "data", "action", "formaction", "background"];
	const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);
	// Never rendered as text whatever the styles say, and needed further down
	// (metadata, lazy-image fallbacks) or dropped there anyway: left alone.
	const PRUNE_SKIP = new Set(["script", "style", "meta", "link", "base", "template", "noscript", "source", "track", "param", "area"]);
	// Shown as a picture or a player: what stands between their tags is only for browsers that cannot.
	const REPLACED = new Set(["canvas", "video", "audio"]);
	// What a document's head may hold in the clone.
	const HEAD_KEEP = new Set(["title", "meta", "link", "script", "style", "base", "noscript"]);
	// The elements a page can give a shadow tree of its own, besides the ones it names itself (with a hyphen).
	// A browser has shadow trees of its own in others (a player's controls, a details element); those are not a page's.
	const SHADOW_HOSTS = new Set(["article", "aside", "blockquote", "body", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "main", "nav", "p", "section", "span"]);
	const TEXT_SKIP = new Set(["script", "style", "noscript", "template", "head", "title", "meta", "link", "base", "iframe", "object", "embed", "select", "textarea", "datalist"]);
	const TEXT_PARA = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "ul", "ol", "dl", "table", "figure", "hr"]);
	const TEXT_BLOCK = new Set([
		"address", "article", "aside", "body", "caption", "dd", "details", "div", "dt", "fieldset", "figcaption", "footer", "form", "header", "li",
		"main", "nav", "section", "summary", "tbody", "tfoot", "thead", "tr",
	]);

	/** @param {unknown} v @param {number} fallback @param {number} max */
	function intOpt(v, fallback, max) {
		if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
		return Math.max(0, Math.min(max, Math.floor(v)));
	}

	/**
	 * Cut to at most `max` UTF-16 units without leaving half a surrogate pair.
	 * @param {string} s @param {number} max
	 * @returns {[string, boolean]}
	 */
	function cut(s, max) {
		if (s.length <= max) return [s, false];
		let end = max;
		if (end > 0) {
			const c = s.charCodeAt(end - 1);
			if (c >= 0xd800 && c <= 0xdbff) end--;
		}
		return [s.slice(0, end), true];
	}

	/** Single line, trimmed, capped. Empty becomes null. @param {unknown} v @param {number} max */
	function meta(v, max) {
		if (typeof v !== "string") return null;
		const flat = v.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
		return flat === "" ? null : cut(flat, max)[0].trim() || null;
	}

	/** @param {unknown} v */
	function dateOrNull(v) {
		const s = meta(v, CAP.published);
		if (s === null || !/\d{4}/.test(s) || !Number.isFinite(Date.parse(s))) return null;
		return s;
	}

	/** @param {string} s */
	function countWords(s) {
		const m = s.match(/\S+/g);
		return m === null ? 0 : m.length;
	}

	/** @param {string} s @returns {number} length with every run of white space counted once */
	function textLength(s) {
		return s.replace(/\s+/g, " ").trim().length;
	}

	/** @param {Element} el @returns {string} lowercase tag of an HTML element, "" for SVG, MathML and the rest */
	function htmlTag(el) {
		return el.namespaceURI === HTML_NS ? el.localName : "";
	}

	/**
	 * @param {unknown} hostname
	 * @returns {boolean} true for a host the bundle's own site extractors may be used on
	 */
	function siteHost(hostname) {
		if (typeof hostname !== "string") return false;
		const host = hostname.toLowerCase().replace(/\.$/, "");
		return SITE_HOSTS.some((site) => host === site || host.endsWith(`.${site}`));
	}

	/**
	 * @param {string} value
	 * @param {string} base
	 * @returns {URL | null} the parsed URL when its scheme is allowed
	 */
	function safeUrl(value, base) {
		try {
			const u = new URL(value, base);
			return ALLOWED_SCHEMES.has(u.protocol) ? u : null;
		} catch {
			return null;
		}
	}

	/**
	 * Drop dangerous attributes in place. With rewrite, safe URLs are also made absolute.
	 * @param {Document} doc @param {string} base @param {boolean} rewrite
	 */
	function cleanAttributes(doc, base, rewrite) {
		for (const el of Array.from(doc.querySelectorAll("*"))) {
			for (const attr of Array.from(el.attributes)) {
				const name = attr.name.toLowerCase();
				if (name.startsWith("on") || name === "srcdoc" || name === "srcset" || name === "style") {
					el.removeAttribute(attr.name);
				} else if (URL_ATTRS.includes(name)) {
					const raw = attr.value.trim();
					if (name === "href" && raw.startsWith("#")) continue;
					const u = safeUrl(raw, base);
					if (u === null) el.removeAttribute(attr.name);
					else if (rewrite && u.protocol !== "mailto:") el.setAttribute(attr.name, u.href);
				}
			}
		}
	}

	/**
	 * Comments are text nobody sees.
	 * @param {Document} doc
	 */
	function dropComments(doc) {
		const walker = doc.createTreeWalker(doc, 0x80);
		/** @type {Node[]} */
		const found = [];
		while (walker.nextNode()) found.push(walker.currentNode);
		for (const node of found) node.parentNode?.removeChild(node);
	}

	/**
	 * Parse html into an inert document (nothing loads or runs) and scrub it.
	 * @param {string} html @param {string} base
	 * @param {boolean} [wholePage] the html is a page's body, not an article: a form is replaced by what is
	 *   in it (whole pages sit in one), and controls whose text is no content go
	 * @returns {Document}
	 */
	function scrub(html, base, wholePage = false) {
		const doc = new DOMParser().parseFromString(html, "text/html");
		if (wholePage) {
			for (const form of Array.from(doc.querySelectorAll("form"))) {
				// One node at a time: handed over as arguments, the children of a very large form are more
				// than a call takes.
				const inside = doc.createDocumentFragment();
				while (form.firstChild !== null) inside.appendChild(form.firstChild);
				form.replaceWith(inside);
			}
			for (const el of Array.from(doc.querySelectorAll("select,textarea,datalist"))) el.remove();
		}
		for (const el of Array.from(doc.querySelectorAll(DROP_TAGS))) el.remove();
		dropComments(doc);
		cleanAttributes(doc, base, true);
		return doc;
	}

	// A character reference that can stand for a character of a scheme, its colon, or white space inside it.
	const CHAR_REFERENCE = /&(?:#x([0-9a-f]{1,6})|#([0-9]{1,7})|(colon|tab|newline));?/iy;

	/**
	 * The scheme a link target names, read the way the readers of Markdown and a browser read it: a backslash
	 * before punctuation is that punctuation, a character reference is its character, and white space and
	 * control characters do not count. Looks no further than a scheme can reach.
	 * @param {string} md
	 * @param {number} from where the target begins
	 * @returns {string | null} the scheme in lower case with its colon; null when the target names none
	 */
	function schemeOf(md, from) {
		const reference = CHAR_REFERENCE;
		let name = "";
		for (let k = from, steps = 0; k < md.length && steps < 512; steps++) {
			let ch = md[k];
			let width = 1;
			if (ch === "\\" && /[!-/:-@[-`{-~]/.test(md[k + 1] ?? "")) {
				ch = md[k + 1];
				width = 2;
			} else if (ch === "&") {
				reference.lastIndex = k;
				const m = reference.exec(md);
				if (m !== null) {
					const code = m[3] !== undefined ? (m[3].toLowerCase() === "colon" ? 58 : 9) : parseInt(m[1] ?? m[2], m[1] === undefined ? 10 : 16);
					ch = code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
					width = m[0].length;
				}
			}
			k += width;
			const code = ch.charCodeAt(0);
			if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
			if (ch === ":") return name === "" ? null : `${name.toLowerCase()}:`;
			if (!(name === "" ? /^[a-z]$/i : /^[a-z0-9+.-]$/i).test(ch)) return null;
			// Longer than any scheme in use, and still going: not one of the allowed ones whatever follows.
			if (name.length >= 40) return "?:";
			name += ch;
		}
		return null;
	}

	/**
	 * Defuddle's Markdown converter keeps any link scheme, so the clone is
	 * neutralised before Defuddle sees it, and link targets that are no web
	 * addresses lose the link here once more: in a link or a picture written
	 * out in place, in an address between angle brackets, and in a definition
	 * that links refer to by a label. Nothing else is touched: a tag that
	 * stands in the Markdown is text the page shows (a code sample, a sentence
	 * about HTML), since the elements themselves were taken out of the clone
	 * before anything was converted.
	 *
	 * One pass over the text. The looks ahead it needs (to the end of a link,
	 * to the end of a piece of code) draw on a budget that grows with the text;
	 * when that is used up a link is broken where it stands instead of being
	 * taken apart, so that no text makes this take longer than its length allows.
	 * @param {string} md
	 */
	function cleanMarkdown(md) {
		const n = md.length;
		/** @type {[number, number, string][]} what to replace: from, to, by */
		const edits = [];
		/** @type {number[]} the opening brackets that have no closing one yet */
		const open = [];
		let budget = 2 * n + 65536;
		const fenceAt = /( {0,3})(`{3,}|~{3,})([^\n]*)/y;
		const blankAt = /[ \t]*(?:\n|$)/y;
		const definitionAt = /( {0,3})\[(?:\\.|[^\\[\]\n]){1,999}\]:[ \t]*(?:\n[ \t]*)?(<?)/y;
		const addressAt = /<([a-z][a-z0-9+.-]{1,31}):[^<>\s]*>/iy;
		/** @type {{ mark: string, length: number } | null} the block of code the pass is in */
		let fence = null;
		// Length of the run of backticks that opened the piece of code the pass is in; 0 outside one.
		let span = 0;

		/**
		 * @param {number} from where a link target begins @param {boolean} angle it is written between angle brackets
		 * @returns {number} the place after the closing parenthesis of the link; -1 when it is not found
		 */
		const linkEnd = (from, angle) => {
			const limit = from + 16384;
			let k = from;
			if (angle) {
				while (k < n && k < limit && md[k] !== ">" && md[k] !== "\n" && budget-- > 0) k += md[k] === "\\" ? 2 : 1;
				if (md[k] !== ">") return -1;
				k += 1;
			} else {
				let depth = 0;
				for (; k < n && k < limit && budget-- > 0; k++) {
					const c = md.charCodeAt(k);
					if (c === 92) k += 1;
					else if (c <= 32) break;
					else if (c === 40) depth += 1;
					else if (c === 41 && depth-- === 0) break;
				}
			}
			const space = () => {
				while (k < n && (md[k] === " " || md[k] === "\t" || md[k] === "\n") && budget-- > 0) k += 1;
			};
			space();
			// A title in quotes or parentheses may follow.
			const quote = md[k] === "(" ? ")" : md[k] === '"' || md[k] === "'" ? md[k] : null;
			if (quote !== null) {
				k += 1;
				while (k < n && k < limit && md[k] !== quote && budget-- > 0) k += md[k] === "\\" ? 2 : 1;
				if (md[k] !== quote) return -1;
				k += 1;
				space();
			}
			return md[k] === ")" ? k + 1 : -1;
		};
		/**
		 * @param {number} from the place after a run of backticks @param {number} length of that run
		 * @returns {boolean} true when a run of the same length follows before the paragraph ends: code between them
		 */
		const closes = (from, length) => {
			for (let k = from; k < n && budget-- > 0; k++) {
				const c = md.charCodeAt(k);
				if (c === 10) {
					blankAt.lastIndex = k + 1;
					if (blankAt.test(md)) return false;
				} else if (c === 96) {
					let e = k;
					while (md.charCodeAt(e) === 96) e += 1;
					if (e - k === length) return true;
					k = e - 1;
				}
			}
			return false;
		};

		let lineStart = true;
		for (let i = 0; i < n; i++) {
			if (lineStart) {
				lineStart = false;
				fenceAt.lastIndex = i;
				const f = fenceAt.exec(md);
				if (fence !== null) {
					if (f !== null && f[2][0] === fence.mark && f[2].length >= fence.length && f[3].trim() === "") fence = null;
				} else if (f !== null && !(f[2][0] === "`" && f[3].includes("`"))) {
					fence = { mark: f[2][0], length: f[2].length };
					span = 0;
					open.length = 0;
				} else {
					blankAt.lastIndex = i;
					if (blankAt.test(md)) {
						// A paragraph ends: no link and no piece of code reaches across.
						span = 0;
						open.length = 0;
					} else if (span === 0) {
						// "[label]: target" - what links that only give a label point to.
						definitionAt.lastIndex = i;
						const d = definitionAt.exec(md);
						if (d !== null) {
							const target = definitionAt.lastIndex;
							const scheme = schemeOf(md, target);
							if (scheme !== null && !ALLOWED_SCHEMES.has(scheme)) {
								let k = target;
								if (d[2] === "<") while (k < n && md[k] !== ">" && md[k] !== "\n") k += 1;
								else while (k < n && md.charCodeAt(k) > 32) k += 1;
								let rest = d[2] === "<" && md[k] === ">" ? k + 1 : k;
								const gap = rest;
								while (md[rest] === " " || md[rest] === "\t") rest += 1;
								// A definition ends with its line, or goes on with a title. Anything else is a sentence that begins with a bracket.
								if (rest >= n || md[rest] === "\n" || (rest > gap && (md[rest] === '"' || md[rest] === "'" || md[rest] === "("))) edits.push([i + d[1].length, i + d[1].length, "\\"]);
							}
						}
					}
				}
			}
			const c = md.charCodeAt(i);
			if (c === 10) {
				lineStart = true;
			} else if (c === 96 && fence === null) {
				let e = i;
				while (md.charCodeAt(e) === 96) e += 1;
				if (span === 0) {
					if (closes(e, e - i)) span = e - i;
				} else if (e - i === span) span = 0;
				i = e - 1;
			} else if (c === 92 && span === 0 && fence === null) {
				// The character after a backslash is that character and nothing else.
				if (md.charCodeAt(i + 1) !== 10) i += 1;
			} else if (c === 91) {
				open.push(i);
			} else if (c === 93) {
				const start = open.pop();
				if (start === undefined || md.charCodeAt(i + 1) !== 40) continue;
				// "[text](target)" and "![text](target)", in code as well: better a changed sample than a link that was taken for one.
				let from = i + 2;
				while (from < n && (md[from] === " " || md[from] === "\t" || md[from] === "\n") && budget-- > 0) from += 1;
				const angle = md[from] === "<";
				if (angle) from += 1;
				const scheme = schemeOf(md, from);
				if (scheme === null || ALLOWED_SCHEMES.has(scheme)) continue;
				const end = linkEnd(from, angle);
				if (end === -1) {
					// No end in reach: the parenthesis is made an ordinary one, and nothing is a link.
					edits.push([i + 1, i + 1, "\\"]);
				} else {
					edits.push([md[start - 1] === "!" ? start - 1 : start, start + 1, ""]);
					edits.push([i, end, ""]);
					i = end - 1;
				}
			} else if (c === 60 && span === 0 && fence === null) {
				// "<scheme:...>" is a link by itself. Not in code, where it is a tag with a prefix as often as not.
				addressAt.lastIndex = i;
				const a = addressAt.exec(md);
				if (a !== null) {
					if (!ALLOWED_SCHEMES.has(`${a[1].toLowerCase()}:`)) {
						edits.push([i, i + 1, ""]);
						edits.push([i + a[0].length - 1, i + a[0].length, ""]);
					}
					i += a[0].length - 1;
				}
			}
		}
		if (edits.length === 0) return md;
		edits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		/** @type {string[]} */
		const out = [];
		let at = 0;
		for (const [from, to, by] of edits) {
			if (from < at) continue;
			out.push(md.slice(at, from), by);
			at = to;
		}
		out.push(md.slice(at));
		return out.join("");
	}

	/**
	 * Markdown from scrubbed html, by the converter the vendored bundle uses for
	 * its own result. It works on a document of its own that loads nothing.
	 * @param {string} html
	 * @returns {string | null} null when the converter is not there or fails
	 */
	function toMarkdown(html) {
		try {
			const Ctor = /** @type {any} */ (globalThis).Defuddle;
			if (typeof Ctor !== "function" || typeof Ctor.createMarkdownContent !== "function") return null;
			const md = Ctor.createMarkdownContent(html, document.URL);
			return typeof md === "string" ? md : null;
		} catch {
			return null;
		}
	}

	/**
	 * @param {Document} doc scrubbed document
	 * @param {number} max
	 * @returns {{ url: string, text: string }[]}
	 */
	function collectLinks(doc, max) {
		/** @type {Map<string, { url: string, text: string }>} */
		const seen = new Map();
		if (max === 0) return [];
		const self = document.URL.split("#")[0];
		for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
			const u = safeUrl(a.getAttribute("href") || "", document.baseURI);
			if (u === null || (u.protocol !== "http:" && u.protocol !== "https:")) continue;
			const url = u.href;
			if (url.length > CAP.linkUrl || seen.has(url) || url.split("#")[0] === self) continue;
			let text = meta(a.textContent, CAP.linkText);
			if (text === null) text = meta(a.querySelector("img")?.getAttribute("alt"), CAP.linkText);
			seen.set(url, { url, text: text ?? "" });
			if (seen.size >= max) break;
		}
		return Array.from(seen.values());
	}

	/** @param {Element} el @returns {boolean} true for an element of a drawing (SVG) */
	function inDrawing(el) {
		return el.namespaceURI === SVG_NS;
	}

	/** @param {string} value a computed length @returns {number} pixels, 0 when it is not a plain length */
	function px(value) {
		const n = parseFloat(value);
		return Number.isFinite(n) ? n : 0;
	}

	/**
	 * @param {string} clip computed value of the legacy clip property
	 * @returns {boolean} true when the rectangle has no area
	 */
	function clipIsEmpty(clip) {
		const m = /^rect\(\s*([^,\s]+)[,\s]+([^,\s]+)[,\s]+([^,\s]+)[,\s]+([^,\s)]+)\s*\)$/.exec(clip);
		if (m === null || m.slice(1).some((v) => v === "auto")) return false;
		const [top, right, bottom, left] = m.slice(1).map(px);
		return right - left <= 1 || bottom - top <= 1;
	}

	/**
	 * One length of a shape, in pixels.
	 * @param {string} value "12px", "40%", or the sum of the two as a browser writes it: "calc(40% - 12px)"
	 * @param {number | null} whole what a percentage is of; null when the box is not known
	 * @returns {number | null} null when it cannot be told
	 */
	function shapeLength(value, whole) {
		const sum = /^calc\(\s*(-?[0-9.]+(?:e-?[0-9]+)?(?:px|%))\s*([+-])\s*(-?[0-9.]+(?:e-?[0-9]+)?(?:px|%))\s*\)$/.exec(value);
		if (sum !== null) {
			const a = shapeLength(sum[1], whole);
			const b = shapeLength(sum[3], whole);
			return a === null || b === null ? null : sum[2] === "+" ? a + b : a - b;
		}
		const m = /^(-?[0-9.]+(?:e-?[0-9]+)?)(px|%)?$/.exec(value);
		if (m === null) return null;
		const n = parseFloat(m[1]);
		if (!Number.isFinite(n)) return null;
		if (n === 0) return 0;
		if (m[2] === "%") return whole === null ? null : (n / 100) * whole;
		return m[2] === "px" ? n : null;
	}

	/**
	 * The box around the points of an SVG path, the points that only steer a curve included: never smaller
	 * than the path itself.
	 * @param {string} d path data
	 * @returns {[number, number, number, number] | null} left, top, right, bottom; null for a path that cannot be read
	 */
	function pathBox(d) {
		const tokens = d.match(/[a-z]|-?(?:[0-9]*\.[0-9]+|[0-9]+\.?)(?:e[-+]?[0-9]+)?/gi);
		if (tokens === null || tokens.length > 4000) return null;
		/** @type {Record<string, number>} */
		const counts = { m: 2, l: 2, t: 2, h: 1, v: 1, c: 6, s: 4, q: 4, a: 7, z: 0 };
		/** @type {[number, number, number, number] | null} */
		let box = null;
		/** @param {number} x @param {number} y */
		const add = (x, y) => {
			box = box === null ? [x, y, x, y] : [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
		};
		let [x, y, startX, startY] = [0, 0, 0, 0];
		let command = "";
		for (let i = 0; i < tokens.length; ) {
			if (/^[a-z]$/i.test(tokens[i])) command = tokens[i++];
			else if (command === "" || command.toLowerCase() === "z") return null;
			const name = command.toLowerCase();
			const count = counts[name];
			if (count === undefined) return null;
			if (count === 0) {
				[x, y] = [startX, startY];
				continue;
			}
			const args = tokens.slice(i, i + count).map(Number);
			if (args.length < count || !args.every(Number.isFinite)) return null;
			i += count;
			const relative = command === name;
			if (name === "h") x = relative ? x + args[0] : args[0];
			else if (name === "v") y = relative ? y + args[0] : args[0];
			else if (name === "a") {
				// An arc stays within its radii of its two ends.
				const [rx, ry] = [Math.abs(args[0]), Math.abs(args[1])];
				add(x - rx, y - ry);
				add(x + rx, y + ry);
				[x, y] = relative ? [x + args[5], y + args[6]] : [args[5], args[6]];
				add(x - rx, y - ry);
				add(x + rx, y + ry);
			} else {
				const [fromX, fromY] = [x, y];
				for (let k = 0; k < count; k += 2) {
					[x, y] = relative ? [fromX + args[k], fromY + args[k + 1]] : [args[k], args[k + 1]];
					add(x, y);
				}
			}
			add(x, y);
			if (name === "m") {
				[startX, startY] = [x, y];
				// Further pairs after a move are lines.
				command = relative ? "l" : "L";
			}
		}
		return box;
	}

	/**
	 * @param {string} path computed value of clip-path
	 * @param {{ width: number, height: number } | null} [box] the box of the element, where it is known. Without
	 *   it only what is plain from the shape alone can be told
	 * @param {((id: string) => Element | null) | null} [lookup] finds the element of the page that has an id, for a
	 *   shape that is kept in a drawing
	 * @returns {boolean} true for the shapes that leave nothing of the element, or no more than a pixel: one
	 *   without an area (inset(50%) and more, a circle without a radius, a polygon or a path that is a point or
	 *   a line), one that lies beside the element, and a shape of a drawing that has nothing in it
	 */
	function clipPathIsEmpty(path, box = null, lookup = null) {
		if (typeof path !== "string" || path === "none" || path === "") return false;
		const w = box === null ? null : box.width;
		const h = box === null ? null : box.height;
		/** @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @returns {boolean} nothing of a shape inside these bounds shows */
		const misses = (x0, y0, x1, y1) => x1 - x0 <= 1 || y1 - y0 <= 1 || (w !== null && h !== null && (Math.min(x1, w) - Math.max(x0, 0) <= 1 || Math.min(y1, h) - Math.max(y0, 0) <= 1));
		const kept = /^url\(\s*["']?#([^"')\s]+)["']?\s*\)$/.exec(path);
		if (kept !== null) {
			const shape = lookup === null ? null : lookup(kept[1]);
			if (shape === null || shape.localName !== "clipPath") return false;
			const parts = Array.from(shape.children);
			/** @param {Element} part @param {string} name @returns {boolean} the attribute says "nothing": present and not above zero */
			const none = (part, name) => part.hasAttribute(name) && !(parseFloat(part.getAttribute(name) ?? "") > 0);
			// Nothing in it, or only shapes that say of themselves that they have no size. A size that is not
			// written there may come from a style sheet, and is not judged.
			return (
				parts.length <= 20 &&
				parts.every((part) => {
					if (part.localName === "rect") return none(part, "width") || none(part, "height");
					if (part.localName === "circle") return none(part, "r");
					if (part.localName === "ellipse") return none(part, "rx") || none(part, "ry");
					if (part.localName === "path" && part.hasAttribute("d")) {
						const bounds = pathBox(part.getAttribute("d") ?? "");
						return bounds === null ? (part.getAttribute("d") ?? "").trim() === "" : bounds[2] - bounds[0] <= 0 || bounds[3] - bounds[1] <= 0;
					}
					return false;
				})
			);
		}
		const drawn = /^path\(\s*(?:(?:nonzero|evenodd)\s*,\s*)?["']([^"']*)["']\s*\)$/.exec(path);
		if (drawn !== null) {
			const bounds = pathBox(drawn[1]);
			return bounds === null ? drawn[1].trim() === "" : misses(...bounds);
		}
		const shape = /^(inset|rect|xywh|circle|ellipse|polygon)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/.exec(path);
		if (shape === null) return false;
		const args = shape[2].trim();
		// Lengths, each of which may be a sum in parentheses.
		const lengths = (/** @type {string} */ text) => text.trim().match(/calc\([^)]*\)|\S+/g) ?? [];
		if (shape[1] === "inset") {
			const parts = lengths(args.split(/\bround\b/)[0]);
			if (parts.length === 0 || parts.length > 4) return false;
			// One value is for all four sides, two for top and bottom and for the sides, three leave the left to the right.
			const top = parts[0] ?? "";
			const right = parts[1] ?? top;
			const bottom = parts[2] ?? top;
			const left = parts[3] ?? right;
			/**
			 * @param {string} a @param {string} b the insets from two opposite sides @param {number | null} whole the length between those sides
			 * @returns {boolean} true when the two meet: with the length known, to a pixel; without it, when they take the whole of any length
			 */
			const meet = (a, b, whole) => {
				if (whole !== null) {
					const [x, y] = [shapeLength(a, whole), shapeLength(b, whole)];
					return x !== null && y !== null && whole - x - y <= 1;
				}
				// A length is so many pixels and such a share: what it is of a length of nothing, and of a length of a thousand.
				const [x0, y0, x1, y1] = [shapeLength(a, 0), shapeLength(b, 0), shapeLength(a, 1000), shapeLength(b, 1000)];
				return x0 !== null && y0 !== null && x1 !== null && y1 !== null && x0 + y0 >= 0 && x1 + y1 - x0 - y0 >= 1000;
			};
			return meet(top, bottom, h) || meet(left, right, w);
		}
		if (shape[1] === "rect" || shape[1] === "xywh") {
			const parts = lengths(args.split(/\bround\b/)[0]);
			if (parts.length !== 4) return false;
			// rect(): the four edges, each from the top or the left. xywh(): a corner and a size.
			const [a, b, c, d] = shape[1] === "rect" ? [shapeLength(parts[3], w), shapeLength(parts[0], h), shapeLength(parts[1], w), shapeLength(parts[2], h)] : [shapeLength(parts[0], w), shapeLength(parts[1], h), shapeLength(parts[2], w), shapeLength(parts[3], h)];
			if (a === null || b === null || c === null || d === null) return false;
			return shape[1] === "rect" ? misses(a, b, c, d) : misses(a, b, a + c, b + d);
		}
		if (shape[1] === "circle" || shape[1] === "ellipse") {
			const [size, place = ""] = args.split(/\bat\b/);
			const radii = lengths(size);
			// A percentage of a circle's radius is of a length between the two sides: the smaller one will do.
			const whole = w === null || h === null ? null : Math.min(w, h);
			const r = radii.map((v) => shapeLength(v, whole));
			if (r.some((n) => n !== null && n <= 0.5)) return true;
			// Somewhere beside the element.
			const at = lengths(place);
			const [cx, cy] = at.length === 2 ? [shapeLength(at[0], w), shapeLength(at[1], h)] : [null, null];
			const [rx, ry = rx] = r;
			return cx !== null && cy !== null && rx !== null && rx !== undefined && ry !== null && ry !== undefined && misses(cx - rx, cy - ry, cx + rx, cy + ry);
		}
		// polygon([fill-rule,] x y, x y, ...)
		const points = args.split(",").map((v) => v.trim());
		if (/^(nonzero|evenodd)$/.test(points[0])) points.shift();
		/** @type {[number, number][]} */
		const xy = [];
		for (const point of points) {
			const pair = lengths(point);
			const x = pair.length === 2 ? shapeLength(pair[0], w) : null;
			const y = pair.length === 2 ? shapeLength(pair[1], h) : null;
			if (x === null || y === null) return false;
			xy.push([x, y]);
		}
		if (xy.length === 0) return false;
		let twice = 0;
		for (let k = 0; k < xy.length; k++) {
			const [x1, y1] = xy[k];
			const [x2, y2] = xy[(k + 1) % xy.length];
			twice += x1 * y2 - x2 * y1;
		}
		// Points given in percent of a box that is not known: only "no area at all" can be told.
		if (Math.abs(twice) / 2 <= (box === null ? 0 : 1)) return true;
		// With the box: a polygon that lies beside it.
		return box !== null && misses(Math.min(...xy.map((p) => p[0])), Math.min(...xy.map((p) => p[1])), Math.max(...xy.map((p) => p[0])), Math.max(...xy.map((p) => p[1])));
	}

	// A colour as a browser writes one in a computed style, in any notation.
	const COLOUR = /(?:rgba?|color|lab|lch|oklab|oklch)\([^()]*\)|\btransparent\b/gi;

	/**
	 * @param {string | undefined} mask computed value of mask-image
	 * @returns {boolean} true for a mask made of gradients whose every colour is fully transparent: nothing
	 *   shows through it
	 */
	function maskIsEmpty(mask) {
		if (typeof mask !== "string" || mask === "none" || mask === "" || !/gradient\(/.test(mask) || /url\(|image\(|element\(/.test(mask)) return false;
		const colours = mask.match(COLOUR);
		if (colours === null) return false;
		// Anything else that could be a colour (a name, a hash): not judged.
		const rest = mask.replace(COLOUR, "");
		if (/#[0-9a-f]{3,8}\b|\b(?!(?:repeating|linear|radial|conic|gradient|to|top|bottom|left|right|at|center|circle|ellipse|closest|farthest|side|corner|from|in|srgb|oklch|oklab|lab|lch|hsl|hwb|xyz|display|rec2020|prophoto|rgb|longer|shorter|increasing|decreasing|hue|deg|turn|rad|grad|px|em|rem|vw|vh|transparent)\b)[a-z]{3,}/i.test(rest)) return false;
		return colours.every((c) => {
			const parsed = rgba(c);
			return parsed !== null && parsed[3] <= 0.01;
		});
	}

	/**
	 * @param {string} transform computed value
	 * @returns {boolean} true when the transform squeezes the box to a line or a point: scale(0), and in three
	 *   dimensions a box turned edge-on (rotateX or rotateY by a quarter turn)
	 */
	function transformIsFlat(transform) {
		const m = /^matrix(3d)?\(([^)]+)\)$/.exec(transform);
		if (m === null) return false;
		const v = m[2].split(",").map((n) => parseFloat(n));
		// What a square of the page plane becomes on the screen: the upper left two by two.
		const [a, b, c, d] = m[1] === undefined ? v : [v[0], v[1], v[4], v[5]];
		return [a, b, c, d].every(Number.isFinite) && Math.abs(a * d - b * c) < 1e-6;
	}

	/**
	 * The transform properties that stand next to "transform".
	 * @param {string | undefined} scale computed value of scale
	 * @param {string | undefined} rotate computed value of rotate
	 * @returns {boolean} true when they squeeze the box to nothing
	 */
	function squeezed(scale, rotate) {
		if (typeof scale === "string" && scale !== "none" && scale.split(/\s+/).slice(0, 2).some((n) => Math.abs(parseFloat(n)) < 1e-3)) return true;
		if (typeof rotate !== "string" || rotate === "none") return false;
		const m = /^(?:(x|y)|(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+))\s+(-?[0-9.]+)deg$/.exec(rotate.trim());
		if (m === null) return false;
		// About an axis that lies in the page, by a quarter turn: seen edge-on.
		const inPlane = m[1] !== undefined || (parseFloat(m[4]) === 0 && (parseFloat(m[2]) !== 0 || parseFloat(m[3]) !== 0));
		return inPlane && Math.abs((((parseFloat(m[5]) % 180) + 180) % 180) - 90) < 0.5;
	}

	/**
	 * @param {string | undefined} transform computed value of transform
	 * @param {string | undefined} scale computed value of scale
	 * @param {string | undefined} zoom computed value of zoom
	 * @returns {number} how much smaller than written an element with these and what is in it are drawn: the
	 *   smaller of the two factors of its transform and of its scale, times its zoom. 1 for an element that is
	 *   drawn as it is written
	 */
	function shrinkage(transform, scale, zoom) {
		let factor = 1;
		const m = typeof transform !== "string" || transform === "none" ? null : /^matrix(3d)?\(([^)]+)\)$/.exec(transform);
		if (m !== null) {
			const v = m[2].split(",").map((n) => parseFloat(n));
			const [a, b, c, d] = m[1] === undefined ? v : [v[0], v[1], v[4], v[5]];
			if ([a, b, c, d].every(Number.isFinite)) factor *= Math.min(Math.hypot(a, b), Math.hypot(c, d));
		}
		if (typeof scale === "string" && scale !== "none" && scale !== "") {
			const parts = scale.split(/\s+/).slice(0, 2).map((n) => Math.abs(parseFloat(n))).filter(Number.isFinite);
			if (parts.length > 0) factor *= Math.min(...parts);
		}
		const zoomed = parseFloat(String(zoom));
		if (Number.isFinite(zoomed) && zoomed > 0) factor *= zoomed;
		return factor;
	}

	/** @param {string} value a computed time @returns {number} seconds, 0 when it is none */
	function seconds(value) {
		const n = parseFloat(value);
		if (!Number.isFinite(n)) return 0;
		return /ms\s*$/i.test(value) ? n / 1000 : n;
	}

	/**
	 * @param {CSSStyleDeclaration} cs
	 * @param {(property: string) => boolean} about which transitions count
	 * @returns {boolean} true when the element has an animation, or a transition of one of those properties that takes time
	 */
	function inMotion(cs, about) {
		if (String(cs.animationName || "none").split(",").some((name) => name.trim() !== "" && name.trim() !== "none")) return true;
		const properties = String(cs.transitionProperty || "").split(",").map((v) => v.trim());
		const durations = String(cs.transitionDuration || "").split(",").map(seconds);
		return properties.some((property, i) => about(property) && durations[i % durations.length] > 0);
	}

	/**
	 * @param {CSSStyleDeclaration} cs
	 * @returns {boolean} true when the opacity of the element is set up to change by itself: an animation,
	 *   or a transition that covers opacity (or the filter that fades it) and takes time. Content that fades
	 *   in when it is scrolled to waits like this.
	 */
	function opacityInMotion(cs) {
		return inMotion(cs, (property) => property === "all" || property === "opacity" || property === "filter");
	}

	// What a box that is folded away or kept beside the page is opened or brought in by.
	const PLACE = /^(?:all|transform|translate|scale|(?:max-|min-)?(?:height|width|block-size|inline-size)|flex(?:-basis|-grow|-shrink)?|grid-template-(?:rows|columns)|left|right|top|bottom|inset(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|clip-path)$/;
	const OPENING_ROLES = new Set(["region", "tabpanel", "navigation", "dialog", "alertdialog", "menu", "menubar", "listbox", "tooltip", "complementary"]);

	/**
	 * @param {CSSStyleDeclaration} cs
	 * @returns {boolean} true when the size or the place of the element is set up to change by itself
	 */
	function placeInMotion(cs) {
		// Nearly every element has neither: two short reads before anything is taken apart.
		if ((cs.animationName === "none" || cs.animationName === undefined) && (cs.transitionDuration === "0s" || cs.transitionDuration === undefined)) return false;
		return inMotion(cs, (property) => PLACE.test(property));
	}

	/**
	 * A box that shows nothing now - folded to no height, kept beside the page - is a part of the page that a
	 * visitor opens, or it is a place to keep text from them. What speaks for the first: its size or place
	 * (or its parent's) is set up to move, as a panel slides open and a drawer slides in; it is a part of the
	 * page that opens by its kind or says so of itself; or a control of the page points at it.
	 * @param {Element} el live element
	 * @param {CSSStyleDeclaration} cs
	 * @param {Around} ctx
	 * @returns {boolean}
	 */
	function opens(el, cs, ctx) {
		if (placeInMotion(cs) || ctx.moving === true || (ctx.parentStyle !== undefined && placeInMotion(ctx.parentStyle))) return true;
		// What is in a closed <details> opens with it.
		if (typeof el.closest === "function" && el.closest("details:not([open])") !== null) return true;
		const tag = htmlTag(el);
		if (tag === "nav" || tag === "dialog" || tag === "menu") return true;
		if (typeof el.getAttribute === "function") {
			if (OPENING_ROLES.has((el.getAttribute("role") ?? "").trim().toLowerCase())) return true;
			if (el.hasAttribute("aria-labelledby") || el.hasAttribute("aria-expanded") || el.hasAttribute("aria-modal")) return true;
		}
		return ctx.wired !== undefined && ctx.wired(el);
	}

	/**
	 * @param {string | undefined} filter computed value of filter
	 * @returns {number} what the opacity() functions in it leave of the element, 0 to 1
	 */
	function filterOpacity(filter) {
		if (typeof filter !== "string" || filter === "none") return 1;
		let left = 1;
		for (const m of filter.matchAll(/\bopacity\(\s*([0-9.]+)(%?)\s*\)/g)) {
			const n = parseFloat(m[1]) / (m[2] === "%" ? 100 : 1);
			if (Number.isFinite(n)) left *= Math.min(Math.max(n, 0), 1);
		}
		return left;
	}

	/**
	 * @param {string | undefined} filter computed value of filter
	 * @returns {number} the radius its blur() functions smear the element by, in pixels
	 */
	function filterBlur(filter) {
		if (typeof filter !== "string" || filter === "none") return 0;
		let radius = 0;
		for (const m of filter.matchAll(/\bblur\(\s*([0-9.]+)px\s*\)/g)) radius += px(m[1]);
		return radius;
	}

	/**
	 * What the filters of an element that change colours do to one colour: brightness, contrast, invert,
	 * grayscale, sepia, saturate and hue-rotate, in the order they are written. With them black letters can be
	 * made white, and two colours one grey.
	 * @param {string | undefined} filter computed value of filter
	 * @returns {((colour: readonly number[]) => number[]) | null} null when there is none of them
	 */
	function filterTint(filter) {
		if (typeof filter !== "string" || filter === "none" || filter === "") return null;
		/** @type {((rgb: number[]) => number[])[]} each works on red, green and blue from 0 to 1 */
		const steps = [];
		/** @param {number[]} m nine numbers, row by row */
		const matrix = (m) => (/** @type {number[]} */ [r, g, b]) => [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];
		for (const f of filter.matchAll(/\b(brightness|contrast|invert|grayscale|sepia|saturate|hue-rotate)\(\s*(-?[0-9.]+(?:e-?[0-9]+)?)(%|deg|rad|grad|turn)?\s*\)/g)) {
			const n = parseFloat(f[2]) / (f[3] === "%" ? 100 : 1);
			if (!Number.isFinite(n)) continue;
			if (f[1] === "brightness") steps.push((rgb) => rgb.map((c) => c * n));
			else if (f[1] === "contrast") steps.push((rgb) => rgb.map((c) => (c - 0.5) * n + 0.5));
			else if (f[1] === "invert") steps.push((rgb) => rgb.map((c) => c + Math.min(n, 1) * (1 - 2 * c)));
			else if (f[1] === "grayscale" || f[1] === "sepia" || f[1] === "saturate") {
				// How much of the colour is left: all of it at 1.
				const s = f[1] === "saturate" ? n : 1 - Math.min(Math.max(n, 0), 1);
				if (f[1] === "sepia") steps.push(matrix([0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s, 0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s, 0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s]));
				else steps.push(matrix([0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s, 0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s, 0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s]));
			} else {
				const turn = f[3] === "rad" ? n : f[3] === "grad" ? (n * Math.PI) / 200 : f[3] === "turn" ? n * 2 * Math.PI : (n * Math.PI) / 180;
				const [c, s] = [Math.cos(turn), Math.sin(turn)];
				steps.push(matrix([0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]));
			}
		}
		if (steps.length === 0) return null;
		return (colour) => {
			let rgb = [colour[0] / 255, colour[1] / 255, colour[2] / 255];
			for (const step of steps) rgb = step(rgb).map((c) => Math.min(Math.max(c, 0), 1));
			return [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, colour[3]];
		};
	}

	/** @param {number} c a share of light, 0 to 1 @returns {number} the value a screen is given for it, 0 to 255 */
	function toScreen(c) {
		const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
		return Math.min(Math.max(v, 0), 1) * 255;
	}

	/** @param {number} v a value a screen is given, 0 to 255 @returns {number} the share of light it stands for, 0 to 1 */
	function toLight(v) {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	}

	/**
	 * @param {string | undefined} value a computed colour, in any notation a browser writes one in: rgb() and
	 *   rgba(), color() with a colour space, lab(), lch(), oklab(), oklch()
	 * @returns {[number, number, number, number] | null} red, green, blue as a screen is given them (0 to 255)
	 *   and alpha (0 to 1); null for what is none of these. The wide colour spaces of color() other than the
	 *   ones for light itself are read as if they were the ordinary one: near enough to tell whether letters
	 *   stand out from what is behind them.
	 */
	function rgba(value) {
		if (typeof value !== "string") return null;
		if (value === "transparent") return [0, 0, 0, 0];
		const m = /^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)(?:\s*[,/]\s*([0-9.]+)(%?))?\s*\)$/.exec(value);
		if (m !== null) {
			const alpha = m[4] === undefined ? 1 : parseFloat(m[4]) / (m[5] === "%" ? 100 : 1);
			return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), alpha];
		}
		const f = /^(color|lab|lch|oklab|oklch)\(\s*([^()/]*?)\s*(?:\/\s*([^()\s]+)\s*)?\)$/i.exec(value);
		if (f === null) return null;
		const parts = f[2].split(/\s+/);
		const space = f[1].toLowerCase() === "color" ? (parts.shift() ?? "").toLowerCase() : f[1].toLowerCase();
		if (parts.length !== 3) return null;
		/** @param {string} part @param {number} whole what 100% stands for @returns {number} */
		const number = (part, whole) => (part === "none" ? 0 : part.endsWith("%") ? (parseFloat(part) / 100) * whole : parseFloat(part));
		const alpha = f[3] === undefined ? 1 : Math.min(Math.max(number(f[3], 1), 0), 1);
		/** @param {number} r @param {number} g @param {number} b shares of light @returns {[number, number, number, number] | null} */
		const fromLight = (r, g, b) => ([r, g, b, alpha].every(Number.isFinite) ? [toScreen(r), toScreen(g), toScreen(b), alpha] : null);
		if (space === "lab" || space === "lch") {
			const L = number(parts[0], 100);
			const [a, b] = space === "lab" ? [number(parts[1], 125), number(parts[2], 125)] : [number(parts[1], 150) * Math.cos((number(parts[2], 360) * Math.PI) / 180), number(parts[1], 150) * Math.sin((number(parts[2], 360) * Math.PI) / 180)];
			const fy = (L + 16) / 116;
			const [fx, fz] = [fy + a / 500, fy - b / 200];
			/** @param {number} t */
			const cube = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
			const [x, y, z] = [cube(fx) * 0.96422, L > 8 ? fy ** 3 : L / (24389 / 27), cube(fz) * 0.82521];
			return fromLight(3.1338561 * x - 1.6168667 * y - 0.4906146 * z, -0.9787684 * x + 1.9161415 * y + 0.033454 * z, 0.0719453 * x - 0.2289914 * y + 1.4052427 * z);
		}
		if (space === "oklab" || space === "oklch") {
			const L = number(parts[0], 1);
			const [a, b] = space === "oklab" ? [number(parts[1], 0.4), number(parts[2], 0.4)] : [number(parts[1], 0.4) * Math.cos((number(parts[2], 360) * Math.PI) / 180), number(parts[1], 0.4) * Math.sin((number(parts[2], 360) * Math.PI) / 180)];
			const [l, m2, s] = [(L + 0.3963377774 * a + 0.2158037573 * b) ** 3, (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, (L - 0.0894841775 * a - 1.291485548 * b) ** 3];
			return fromLight(4.0767416621 * l - 3.3077115913 * m2 + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m2 - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m2 + 1.707614701 * s);
		}
		const [c1, c2, c3] = parts.map((part) => number(part, 1));
		if (![c1, c2, c3, alpha].every(Number.isFinite)) return null;
		if (space === "srgb-linear") return fromLight(c1, c2, c3);
		if (space === "xyz" || space === "xyz-d65") return fromLight(3.2404542 * c1 - 1.5371385 * c2 - 0.4985314 * c3, -0.969266 * c1 + 1.8760108 * c2 + 0.041556 * c3, 0.0556434 * c1 - 0.2040259 * c2 + 1.0572252 * c3);
		if (space === "xyz-d50") return fromLight(3.1338561 * c1 - 1.6168667 * c2 - 0.4906146 * c3, -0.9787684 * c1 + 1.9161415 * c2 + 0.033454 * c3, 0.0719453 * c1 - 0.2289914 * c2 + 1.4052427 * c3);
		if (!/^(srgb|display-p3|a98-rgb|prophoto-rgb|rec2020)$/.test(space)) return null;
		const clamp = (/** @type {number} */ c) => Math.min(Math.max(c, 0), 1) * 255;
		return [clamp(c1), clamp(c2), clamp(c3), alpha];
	}

	/** @param {readonly number[]} c @returns {number} how light a colour is, 0 for black to 1 for white */
	function lightness(c) {
		return 0.2126 * toLight(c[0]) + 0.7152 * toLight(c[1]) + 0.0722 * toLight(c[2]);
	}

	/**
	 * @param {readonly number[]} a @param {readonly number[]} b two opaque colours
	 * @returns {boolean} true when letters in one cannot be read on the other: nearly as light as each other,
	 *   and of nearly the same hue. Grey on white is read down to a very light grey; that is not this.
	 */
	function alike(a, b) {
		const [la, lb] = [lightness(a), lightness(b)];
		return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05) < MIN_CONTRAST && Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) <= 64;
	}

	/**
	 * @param {readonly number[]} top a colour that may be see-through @param {readonly number[]} under what it is painted on
	 * @returns {[number, number, number, number]} what is seen
	 */
	function over(top, under) {
		const a = Math.min(Math.max(top[3], 0), 1);
		const rest = under[3] * (1 - a);
		const alpha = a + rest;
		if (alpha <= 0) return [0, 0, 0, 0];
		return [(top[0] * a + under[0] * rest) / alpha, (top[1] * a + under[1] * rest) / alpha, (top[2] * a + under[2] * rest) / alpha, alpha];
	}

	/**
	 * @param {string} mode a computed mix-blend-mode other than "normal"
	 * @param {readonly number[]} top the colour that is mixed in @param {readonly number[]} under the colour behind it
	 * @returns {number[] | null} what the two give; null for the modes that are not worked out here
	 */
	function mix(mode, top, under) {
		/** @type {Record<string, (s: number, b: number) => number>} */
		const modes = {
			multiply: (s, b) => (s * b) / 255,
			screen: (s, b) => 255 - ((255 - s) * (255 - b)) / 255,
			darken: (s, b) => Math.min(s, b),
			lighten: (s, b) => Math.max(s, b),
			difference: (s, b) => Math.abs(s - b),
			exclusion: (s, b) => s + b - (2 * s * b) / 255,
		};
		const f = Object.hasOwn(modes, mode) ? modes[mode] : null;
		return f === null ? null : [f(top[0], under[0]), f(top[1], under[1]), f(top[2], under[2]), top[3]];
	}

	/**
	 * A background image as one colour, where it is one: a gradient (or several, one on the other) between
	 * colours that are alike and opaque.
	 * @param {string} image computed value of background-image, not "none"
	 * @returns {[number, number, number, number] | "clear" | null} "clear" for gradients that paint nothing at
	 *   all; null for everything that cannot be told (a picture, a gradient between different colours)
	 */
	function plainImage(image) {
		if (!/gradient\(/.test(image) || /url\(|image\(|image-set\(|element\(|cross-fade\(|paint\(|currentcolor/i.test(image)) return null;
		const colours = (image.match(COLOUR) ?? []).map(rgba);
		if (colours.length === 0 || /#[0-9a-f]{3,8}\b/i.test(image)) return null;
		const [first] = colours;
		if (first === null) return null;
		if (colours.every((c) => c !== null && c[3] <= 0.01)) return "clear";
		return colours.every((c) => c !== null && c[3] >= 0.99 && alike(c, first)) ? first : null;
	}

	/**
	 * @param {string} list a computed value that is a list with commas, some of them inside parentheses
	 * @returns {string[]} the items of the list
	 */
	function items(list) {
		/** @type {string[]} */
		const out = [];
		let depth = 0;
		let from = 0;
		for (let i = 0; i < list.length; i++) {
			if (list[i] === "(") depth += 1;
			else if (list[i] === ")") depth -= 1;
			else if (list[i] === "," && depth === 0) {
				out.push(list.slice(from, i));
				from = i + 1;
			}
		}
		out.push(list.slice(from));
		return out;
	}

	/**
	 * Letters that have the colour of what is behind them still show when they have a shadow or an outline
	 * that does not: one with a colour of its own that stands out, near the letters.
	 * @param {CSSStyleDeclaration} cs
	 * @param {(colour: readonly number[] | null) => boolean} stands whether a colour is seen where the letters are
	 * @returns {boolean}
	 */
	function outlined(cs, stands) {
		const style = /** @type {any} */ (cs);
		// Without a colour of its own a shadow or an outline has that of the letters.
		const letters = rgba(style.webkitTextFillColor) ?? rgba(cs.color);
		if (typeof cs.textShadow === "string" && cs.textShadow !== "none" && cs.textShadow !== "") {
			for (const shadow of items(cs.textShadow)) {
				const colour = shadow.match(COLOUR);
				const [x = 0, y = 0] = (shadow.replace(COLOUR, "").match(/-?[0-9.]+(?:e-?[0-9]+)?px/g) ?? []).map(px);
				// A shadow that is cast a long way off is not where the letters are.
				if (Math.abs(x) >= OFFSCREEN_PX || Math.abs(y) >= OFFSCREEN_PX) continue;
				if (stands(colour === null ? letters : rgba(colour[0]))) return true;
			}
		}
		return px(style.webkitTextStrokeWidth) > 0 && stands(rgba(style.webkitTextStrokeColor) ?? rgba(cs.color));
	}

	/**
	 * The colour the letters of a drawing are painted in, when that can hide them: they are filled, not coloured.
	 * @param {CSSStyleDeclaration} cs
	 * @returns {[number, number, number, number] | null} null when they show whatever the fill: they have an
	 *   outline, or are filled with a pattern
	 */
	function drawnInk(cs) {
		const style = /** @type {any} */ (cs);
		const share = (/** @type {unknown} */ v) => (Number.isFinite(parseFloat(String(v))) ? Math.min(Math.max(parseFloat(String(v)), 0), 1) : 1);
		const line = style.stroke === "none" || style.stroke === undefined ? null : rgba(style.stroke);
		if (style.stroke !== "none" && style.stroke !== undefined && px(style.strokeWidth) > 0 && (line === null || line[3] * share(style.strokeOpacity) > MIN_OPACITY)) return null;
		// No fill and no outline is no letters.
		if (style.fill === "none") return [0, 0, 0, 0];
		const fill = rgba(style.fill);
		return fill === null ? null : [fill[0], fill[1], fill[2], fill[3] * share(style.fillOpacity)];
	}

	/**
	 * @param {CSSStyleDeclaration} cs
	 * @returns {boolean} true for a box that was moved a long way from where it would lie, or taken out of the flow
	 */
	function displaced(cs) {
		const position = cs.position;
		if (position === "absolute" || position === "fixed") return true;
		if (Math.abs(px(cs.marginLeft)) >= OFFSCREEN_PX || Math.abs(px(cs.marginTop)) >= OFFSCREEN_PX) return true;
		if (position === "relative" && [cs.left, cs.top, cs.right, cs.bottom].some((v) => Math.abs(px(v)) >= OFFSCREEN_PX)) return true;
		const m = /^matrix\(([^)]+)\)$/.exec(cs.transform);
		if (m === null) return cs.transform !== "none" && cs.transform !== "" && cs.transform !== undefined;
		const v = m[1].split(",").map((n) => parseFloat(n));
		return Math.abs(v[4]) >= OFFSCREEN_PX || Math.abs(v[5]) >= OFFSCREEN_PX;
	}

	/**
	 * @typedef {object} Inherit what an element hands down to the elements in it, as far as showing goes
	 * @property {number} opacity what its own and its ancestors' opacity leave, 0 to 1
	 * @property {readonly number[] | null} bg the colour behind what is in it, as it is seen: the nearest opaque
	 *   background up the tree. null when it cannot be told (a picture, a gradient between colours)
	 * @property {boolean} clipText it or an ancestor paints its background through the letters
	 * @property {readonly number[] | null} [clipInk] what is painted through them, where that is one colour
	 * @property {boolean} boxed it or an ancestor other than the page itself clips or scrolls what is in it
	 * @property {number} [scale] how much smaller than written it and its ancestors draw what is in them
	 * @property {number} [blur] the radius it and its ancestors smear what is in them by, in pixels
	 * @property {((colour: readonly number[]) => number[]) | null} [tint] what its and its ancestors' filters make of a colour
	 * @property {CSSStyleDeclaration} [parentStyle] its computed style, for the elements in it to ask whether its size or place is set up to change
	 * @property {boolean} [moving] the same as a plain answer, where that is known without asking
	 * @property {boolean} [halo] it or an ancestor casts a shadow around everything in it that stands out
	 * @property {boolean} [cut] it is folded to nothing and cuts off what lies in it, or lies in such a box
	 */

	/**
	 * @typedef {object} Page what the walk knows of the page as a whole, and can ask it
	 * @property {Window} view
	 * @property {boolean} ltr
	 * @property {boolean} parentOutside
	 * @property {boolean} [ownText] false when the element has no text of its own to hide
	 * @property {boolean} [styled] the page's root element has a computed style: an element without one is not drawn
	 * @property {() => { left?: number, right: number, bottom: number }} [flow] where the page's own content ends, in page coordinates
	 * @property {(el: Element) => { left: number, right: number, top?: number, bottom?: number }[]} [textBoxes] the boxes the element's own text lies in
	 * @property {(el: Element, ink: readonly number[]) => boolean} [confirmHidden] a second look at text that has the
	 *   colour of what is behind it: false when something else may be drawn there
	 * @property {(el: Element) => boolean} [wired] whether a control of the page points at the element
	 * @property {(id: string) => Element | null} [lookup] the element of the page that has an id
	 */

	/** @typedef {Page & Partial<Inherit>} Around what an element is judged with: the page, and what the elements around it hand down */

	/**
	 * What the live page does with one element, from its computed style.
	 *   "tree"  the element and everything inside it is not rendered
	 *   "box"   its own box and text are not rendered, descendants may be
	 *   "text"  only its own text is not rendered
	 *   null    it is rendered
	 * What a visitor opens is "rendered": the content of a closed <details>, a
	 * panel folded to no height that is set up to slide open or that a control
	 * points at, a drawer kept beside the page that is set up to slide in. So is
	 * what a box with hidden overflow cuts off of a row of things (a carousel),
	 * and what a page scrolls to. A box folded to nothing with none of that
	 * about it is a place to keep text from a visitor.
	 * @param {Element} el live element
	 * @param {CSSStyleDeclaration} cs its computed style
	 * @param {Around} ctx
	 * @returns {{ kind: "tree" | "box" | "text" | null, outside: boolean, fading?: true } & Inherit}
	 *   fading: transparent now, but kept because its opacity is in motion; the rest is for its children
	 */
	function rendering(el, cs, ctx) {
		/** @type {{ kind: "tree", outside: boolean } & Inherit} */
		const gone = { kind: "tree", outside: false, opacity: 0, bg: null, clipText: false, boxed: false };
		// Each of these is asked of the page once: a style is a live object, and every look at it costs.
		const display = cs.display;
		if (el.hasAttribute("hidden") || display === "none" || cs.contentVisibility === "hidden") return gone;
		// No style at all in a page that has styles: a child of a shadow host that none of its slots shows.
		if (display === "" && ctx.styled === true) return gone;
		const filter = cs.filter;
		const transform = cs.transform;
		const ownScale = cs.scale;
		const overflowX = cs.overflowX;
		const overflowY = cs.overflowY;
		// Opacity multiplies down the tree, and a filter can do what the property does.
		const own = parseFloat(cs.opacity);
		const through = (ctx.opacity ?? 1) * (Number.isFinite(own) ? own : 1) * filterOpacity(filter);
		const transparent = through <= MIN_OPACITY;
		// Transparent for good is hidden. Transparent on the way to being shown is not.
		const fading = transparent && opacityInMotion(cs);
		if (transparent && !fading) return gone;
		if (maskIsEmpty(cs.maskImage ?? /** @type {any} */ (cs).webkitMaskImage) || transformIsFlat(transform) || squeezed(ownScale, cs.rotate)) return gone;

		const position = cs.position;
		const anchored = position === "absolute" || position === "fixed";
		const transformed = transform !== "none" && transform !== undefined && transform !== "";
		if (ctx.cut === true && !anchored) {
			// In a box that is folded to nothing and cuts off what lies in it. Only what is placed by something
			// further out reaches beyond such a box, and whatever is placed by an element in here is in here.
			if (position === "relative" || position === "sticky" || transformed) return gone;
			return { kind: "box", outside: false, opacity: through, bg: ctx.bg ?? null, clipText: ctx.clipText === true, clipInk: ctx.clipInk, boxed: true, scale: ctx.scale, blur: ctx.blur, tint: ctx.tint, halo: ctx.halo, cut: true };
		}

		// What the children inherit. Colours first: as they are seen, through the filters of this element and of those around it.
		const ownTint = filterTint(filter);
		const outerTint = ctx.tint ?? null;
		const tint = ownTint === null ? outerTint : outerTint === null ? ownTint : (/** @type {readonly number[]} */ c) => outerTint(ownTint(c));
		/** @param {readonly number[]} c */
		const seen = (c) => (tint === null ? c : tint(c));
		const clipsText = /text/.test(`${cs.backgroundClip || ""} ${/** @type {any} */ (cs).webkitBackgroundClip || ""}`);
		const fill = rgba(cs.backgroundColor);
		const image = typeof cs.backgroundImage === "string" && cs.backgroundImage !== "none" && cs.backgroundImage !== "" ? plainImage(cs.backgroundImage) : "clear";
		/** @type {readonly number[] | null} */
		let bg = ctx.bg ?? null;
		// What is painted through the letters of this element and of those in it: undefined for nothing.
		/** @type {readonly number[] | null | undefined} */
		let clipInk = ctx.clipText === true ? (ctx.clipInk ?? null) : undefined;
		if (clipsText) {
			// The background is painted where the letters are, and nowhere else: what is behind stays what it was.
			if (image !== "clear") clipInk = image === null ? null : seen(image);
			else if (fill === null) clipInk = null;
			else if (fill[3] > 0.01) clipInk = seen(fill);
		} else if (image !== "clear") bg = image === null ? null : seen(image);
		else if (fill === null) bg = null;
		else if (fill[3] >= 0.99) bg = seen(fill);
		else if (fill[3] > 0.01) bg = bg === null ? null : over(seen(fill), bg);
		const page = el === el.ownerDocument?.documentElement || el === el.ownerDocument?.body;
		const boxed = ctx.boxed === true || (!page && (overflowX !== "visible" || overflowY !== "visible"));
		const scale = (ctx.scale ?? 1) * shrinkage(transform, ownScale, /** @type {any} */ (cs).zoom);
		// A blur that is on its way out does not count, like an opacity on its way up.
		const ownBlur = filterBlur(filter);
		const blur = (ctx.blur ?? 0) + (ownBlur > 0 && opacityInMotion(cs) ? 0 : ownBlur);
		/** @param {readonly number[] | null} c @returns {boolean} whether something painted in this colour is seen where the letters are */
		const stands = (c) => {
			if (c === null) return false;
			const alpha = c[3] * (fading ? 1 : through);
			if (alpha <= MIN_OPACITY) return false;
			const shown = seen(c);
			return bg === null || !alike(over([shown[0], shown[1], shown[2], alpha], bg), bg);
		};
		let halo = ctx.halo === true;
		if (!halo && typeof filter === "string" && filter.includes("drop-shadow(")) {
			for (const shadow of filter.matchAll(/drop-shadow\(((?:[^()]|\([^()]*\))*)\)/g)) {
				const colour = shadow[1].match(COLOUR);
				if (stands(colour === null ? rgba(cs.color) : rgba(colour[0]))) halo = true;
			}
		}
		/** @type {Inherit} */
		const next = { opacity: fading ? 1 : through, bg, clipText: clipInk !== undefined, clipInk, boxed, scale, blur, tint, halo, parentStyle: cs };

		const far = displaced(cs);
		const moved = far || position === "relative" || position === "sticky" || transformed;
		const clipsX = overflowX !== "visible";
		const clipsY = overflowY !== "visible";
		const clipsBoth = clipsX && clipsY;
		const narrow = clipsX && /^inline-/.test(display);
		const shaped = typeof cs.clipPath === "string" && cs.clipPath !== "none" && cs.clipPath !== "";
		const indent = ctx.ownText === false ? 0 : parseFloat(cs.textIndent);
		const indented = Number.isFinite(indent) && indent !== 0;
		/** @type {DOMRect | null} */
		const rect = moved || ctx.parentOutside || clipsBoth || narrow || shaped || indented || ((clipsX || clipsY) && (overflowX === "clip" || overflowY === "clip")) ? el.getBoundingClientRect() : null;
		// A tab that is made in a window the browser does not draw (minimised, on another desktop) has a viewport
		// of no size until the browser lays that window out, and that can be after the page was read. Every box
		// that takes its size from the viewport has none then, the root element first of all: a width or a height
		// of zero says nothing there. A box with a size of its own - the pixel of "visually hidden" - is judged as ever.
		const windowed = (ctx.view.innerWidth || 0) > 0 && (ctx.view.innerHeight || 0) > 0;
		const sized = rect !== null && (windowed || (rect.width > 0 && rect.height > 0));
		if (shaped && clipPathIsEmpty(cs.clipPath, sized ? rect : null, ctx.lookup ?? null)) return gone;
		// A box that cuts off what is in it and leaves no room for it. Not an element that has no box at all:
		// that is what the content of a closed <details> looks like.
		if (rect !== null && (clipsX || clipsY) && (sized || cs.maxHeight === "0px") && (typeof el.getClientRects !== "function" || el.getClientRects().length > 0)) {
			// A box of a pixel ("visually hidden"), a box in a line without any width: whatever is said about it.
			if (sized && clipsBoth && rect.width <= 1 && rect.height <= 1) return gone;
			if (sized && narrow && rect.width <= 1) return gone;
			// Lower or narrower than half a letter: nothing in it can be read. A panel that is folded away
			// looks the same, and is told from it by what speaks for its opening.
			const letter = Math.max(1, Math.min(MIN_CLIP_PX, px(cs.fontSize) / 2));
			// Without a window a box that takes its size from it is as low as this: only where the style
			// itself says "no higher than nothing", which no window changes. (The same about the width is
			// what a table is told to make a cell cut its text short, and says nothing.)
			const low = clipsY && rect.height < letter && (windowed || cs.maxHeight === "0px");
			const thin = clipsX && rect.width < letter && windowed;
			if (!page && CLIPPING.test(display) && (low || thin) && !opens(el, cs, ctx)) {
				// What is placed by an element further out reaches beyond a box that is in the flow itself.
				if (position !== "static" || transformed) return gone;
				return { kind: "box", outside: false, ...next, cut: true };
			}
		}
		let outside = false;
		if (rect !== null && (moved || ctx.parentOutside)) {
			if (anchored && clipIsEmpty(cs.clip)) return gone;
			// A fixed box does not move with the page.
			const fixed = position === "fixed";
			const scrollX = fixed ? 0 : ctx.view.scrollX;
			const scrollY = fixed ? 0 : ctx.view.scrollY;
			const [vw, vh] = [ctx.view.innerWidth || 0, ctx.view.innerHeight || 0];
			// Along the lines of the page, from the side it begins at: where the box begins and where it ends.
			// A page that runs from right to left begins at the right edge of its window and scrolls to the left.
			const along = ctx.ltr ? [rect.left + scrollX, rect.right + scrollX] : vw > 0 ? [vw - rect.right - scrollX, vw - rect.left - scrollX] : null;
			const [top, bottom] = [rect.top + scrollY, rect.bottom + scrollY];
			// Beyond the top edge nothing can be scrolled to, and nothing beyond the side a page begins at. A
			// box that lies there with no part of it on the page is not seen - unless it is one that comes in:
			// then only when it lies a long way off, as no drawer and no slide does.
			const wayOff = bottom < -OFFSCREEN_PX || (along !== null && along[1] < -OFFSCREEN_PX);
			if (wayOff) outside = true;
			else if (((rect.height > 0 && bottom <= 0) || (along !== null && rect.width > 0 && along[1] <= 0)) && ctx.boxed !== true && !opens(el, cs, ctx)) {
				// Its own text may reach back onto the page where the box does not hold it.
				const boxes = ctx.ownText === false || ctx.textBoxes === undefined || !ctx.ltr ? [] : ctx.textBoxes(el);
				outside = !boxes.some((b) => b.right + scrollX > 0 && (b.bottom === undefined || b.bottom + scrollY > 0));
			}
			// The other two edges. A fixed box beyond them is never seen. A box that was moved there is, if
			// the page scrolls that far - which it does for the sake of that box alone when the box lies
			// far beyond the end of everything else. Inside a box that clips or scrolls it is that box's
			// business (a slide of a carousel, a row of a long list).
			if (!outside && fixed) outside = (along !== null && along[0] > vw + OFFSCREEN_PX) || rect.top > vh + OFFSCREEN_PX;
			else if (!outside && along !== null && (far || ctx.parentOutside) && ctx.boxed !== true && ctx.flow !== undefined) {
				if (along[0] > vw + OFFSCREEN_PX || top > vh + OFFSCREEN_PX) {
					const flow = ctx.flow();
					const end = ctx.ltr ? flow.right : vw - (flow.left ?? 0);
					outside = along[0] > end + OFFSCREEN_PX || top > flow.bottom + OFFSCREEN_PX;
				}
			}
		}
		if (outside || cs.visibility === "hidden" || cs.visibility === "collapse") return { kind: "box", outside, ...next };
		if (ctx.ownText === false) return fading ? { kind: null, outside: false, fading: true, ...next } : { kind: null, outside: false, ...next };

		// The element's own text: too small to read, smeared, pushed out of sight, or painted so that it cannot be seen.
		const drawing = inDrawing(el);
		if (drawing) {
			// In a drawing sizes are in its own units and places are its own business: by where the letters end
			// up. Outside the frame of the drawing, where that cuts off what is beyond it, they are not seen.
			const frame = /** @type {SVGElement} */ (el).ownerSVGElement ?? null;
			const frameStyle = frame === null || typeof ctx.view.getComputedStyle !== "function" ? null : ctx.view.getComputedStyle(frame);
			const box = frame === null ? null : el.getBoundingClientRect();
			if (box !== null && box.width > 0) {
				// As high as letters of a pixel or two.
				if (box.height <= MIN_FONT_PX * 1.2) return { kind: "text", outside: false, ...next };
				const f = /** @type {SVGElement} */ (frame).getBoundingClientRect();
				const cut = frameStyle !== null && frameStyle.overflowX !== "visible" && frameStyle.overflowY !== "visible";
				if (cut && f.width > 0 && f.height > 0 && (box.right <= f.left || box.left >= f.right || box.bottom <= f.top || box.top >= f.bottom)) return { kind: "text", outside: false, ...next };
			}
		} else {
			const size = px(cs.fontSize) * scale;
			if (size <= MIN_FONT_PX) return { kind: "text", outside: false, ...next };
			// Smeared over half the height of a letter and more, nothing of a letter is left.
			if (blur > 0 && blur >= size / 2) return { kind: "text", outside: false, ...next };
		}
		if (indented && rect !== null) {
			if (px(cs.textIndent) <= -OFFSCREEN_PX) return { kind: "text", outside: false, ...next };
			const shift = /%\s*$/.test(cs.textIndent) ? (indent / 100) * rect.width : indent;
			// A box of no width in a viewport of no size cuts nothing off that could be told.
			const cut = sized && overflowX !== "visible";
			const scrollX = position === "fixed" ? 0 : ctx.view.scrollX;
			const boxes = ctx.textBoxes === undefined ? null : ctx.textBoxes(el);
			if (boxes !== null && boxes.length > 0) {
				// Where the text really lies: every line of it left of the page, or beyond the box that cuts it off.
				if (boxes.every((b) => (ctx.ltr && b.right + scrollX < 0) || (cut && (b.right <= rect.left || b.left >= rect.right)) || (shift >= OFFSCREEN_PX && b.left - rect.right >= OFFSCREEN_PX))) {
					return { kind: "text", outside: false, ...next };
				}
			} else if (boxes === null) {
				// No way to measure the text: by its box, which it cannot be wider than on one line.
				if ((cut && rect.width > 0 && Math.abs(shift) >= rect.width) || (ctx.ltr && shift < 0 && rect.right + scrollX + shift < 0) || shift >= OFFSCREEN_PX) return { kind: "text", outside: false, ...next };
			}
		}
		// What the letters are painted in: their fill, and where that is see-through and a background is
		// painted through them, that background. null for a picture there: letters that show whatever their colour.
		const style = /** @type {any} */ (cs);
		/** @type {readonly number[] | null} */
		let ink;
		let known = true;
		if (drawing) ink = drawnInk(cs);
		else {
			const letters = style.webkitTextFillColor === undefined || /^currentcolor$/i.test(style.webkitTextFillColor) ? rgba(cs.color) : rgba(style.webkitTextFillColor);
			// A colour that cannot be read is not taken for one that shows.
			known = letters !== null;
			if (letters === null) ink = [0, 0, 0, 0];
			else if (clipInk === undefined || letters[3] >= 0.99) ink = letters;
			else ink = clipInk === null ? null : over(letters, clipInk);
		}
		if (ink !== null) {
			const alpha = ink[3] * (fading ? 1 : through);
			const shown = seen(ink);
			// What is seen where the letters are: their colour on what is behind them, or the two mixed in the
			// way the element asks for (white letters can be the negative of a white page). Asked only here,
			// where it can matter; what an element further out asks for is for the second look to find.
			const mode = bg === null ? undefined : cs.mixBlendMode;
			const blend = typeof mode === "string" && mode !== "normal" && mode !== "" ? mode : null;
			const blent = bg === null || blend === null ? shown : mix(blend, shown, bg);
			const mixed = bg === null || blent === null ? null : over([blent[0], blent[1], blent[2], alpha], bg);
			const faint = alpha <= MIN_OPACITY;
			if ((faint || (mixed !== null && bg !== null && alike(mixed, bg))) && !halo && !outlined(cs, stands)) {
				// The colour of what is behind them: looked at once more, for what may be drawn in between.
				if (faint || !known || mixed === null || ctx.confirmHidden === undefined || ctx.confirmHidden(el, mixed)) return { kind: "text", outside: false, ...next };
			}
		}
		return fading ? { kind: null, outside: false, fading: true, ...next } : { kind: null, outside: false, ...next };
	}

	/** @param {Node} node @returns {boolean} true when the node holds text other than white space */
	function hasText(node) {
		return /\S/.test(node.textContent || "");
	}

	/**
	 * Remove the text nodes that are direct children of an element.
	 * @param {Element} el clone element
	 * @returns {boolean} true when visible characters went with them
	 */
	function stripOwnText(el) {
		let found = false;
		for (const node of Array.from(el.childNodes)) {
			if (node.nodeType !== 3 && node.nodeType !== 4) continue;
			if (/\S/.test(node.nodeValue || "")) found = true;
			el.removeChild(node);
		}
		return found;
	}

	// What is a picture to a visitor, whatever is written between its tags.
	const MEDIA = "img,picture,video,canvas,svg,iframe,object,embed";

	/**
	 * The colour of the canvas, which is behind everything on a page: white, or the dark one of a page that
	 * says it is made for a dark one - for that alone, or for both where the visitor's system asks for dark.
	 * @param {Document} live
	 * @param {Window} view
	 * @param {CSSStyleDeclaration} rootStyle the computed style of the root element
	 * @returns {readonly number[]}
	 */
	function canvasColour(live, view, rootStyle) {
		let schemes = String(rootStyle.colorScheme || "normal").toLowerCase();
		// Said in the head instead of a style sheet.
		if (schemes === "normal" && typeof live.querySelector === "function") schemes = String(live.querySelector('meta[name="color-scheme" i]')?.getAttribute("content") || "").toLowerCase();
		const white = [255, 255, 255, 1];
		if (!/\bdark\b/.test(schemes)) return white;
		if (!/\blight\b/.test(schemes)) return DARK_CANVAS;
		try {
			return view.matchMedia("(prefers-color-scheme: dark)").matches ? DARK_CANVAS : white;
		} catch {
			return white;
		}
	}

	/**
	 * Text in the colour of the background behind it is invisible - unless
	 * something else is drawn between the two: a picture that lies under a
	 * headline, a pseudo-element, a box of another colour. This makes the
	 * second look at such text, with what the page says is at that spot where
	 * it is in view. It costs, so what it learns of an element is kept, and
	 * after a number of looks no more are made: text that would need one is
	 * taken for hidden then, as its colours say, not kept unseen.
	 * @param {Document} live
	 * @param {Window} view
	 * @param {number} most how many looks are made
	 * @returns {(el: Element, colour: readonly number[]) => boolean} for an element and the colour its text is
	 *   seen in: true when nothing speaks against "hidden"
	 */
	function secondLook(live, view, most) {
		let looks = 0;
		/** @type {Map<Element, { extra: boolean, blend: boolean, image: boolean, fill: readonly number[] | null }>} */
		const known = new Map();
		/** @type {Map<Element, { left: number, right: number, top: number, bottom: number }[]>} */
		const pictures = new Map();
		/** @param {CSSStyleDeclaration} style @returns {boolean} mixed with what is behind it in another way than by being painted on it */
		const blends = (style) => typeof style.mixBlendMode === "string" && style.mixBlendMode !== "normal" && style.mixBlendMode !== "";
		/** @param {CSSStyleDeclaration} style @returns {{ image: boolean, fill: readonly number[] | null }} what a background is: a picture, or a colour */
		const painted = (style) => {
			const image = style.backgroundImage !== "none" && style.backgroundImage !== "" ? plainImage(style.backgroundImage) : "clear";
			return { image: image === null, fill: image === null || image === "clear" ? rgba(style.backgroundColor) : image };
		};
		/**
		 * @param {Element} a
		 * @returns {{ extra: boolean, blend: boolean, image: boolean, fill: readonly number[] | null }} extra: a pseudo-element
		 *   of it paints something; blend: it is mixed with what is behind it; image: it has a background that is no
		 *   plain colour; fill: its background colour
		 */
		const facts = (a) => {
			let f = known.get(a);
			if (f === undefined) {
				const extra = ["::before", "::after"].some((pseudo) => {
					const style = view.getComputedStyle(a, pseudo);
					if (style.content === "none" || style.content === "normal") return false;
					const { image, fill } = painted(style);
					return image || fill === null || fill[3] > 0.01;
				});
				const style = view.getComputedStyle(a);
				f = { extra, blend: blends(style), ...painted(style) };
				if (known.size < 20000) known.set(a, f);
			}
			return f;
		};
		/** @param {{ image: boolean, fill: readonly number[] | null }} f @param {readonly number[]} colour @returns {boolean | null} true: an opaque box of the text's colour; false: something else; null: see-through */
		const paints = (f, colour) => {
			if (f.image || f.fill === null) return false;
			if (f.fill[3] <= 0.01) return null;
			return f.fill[3] >= 0.99 && alike(f.fill, colour);
		};
		return (el, colour) => {
			if (++looks > most) return true;
			const rect = el.getBoundingClientRect();
			// Up the tree to the box that gives the background: a pseudo-element on the way may draw anything.
			for (let a = /** @type {Element | null} */ (el), depth = 0; a !== null && depth < 40; a = a.parentElement, depth++) {
				const f = facts(a);
				if (f.extra) return false;
				// What an element around the text is mixed by is not worked out: the colour may be another one.
				if (f.blend && a !== el) return false;
				const own = paints(f, colour);
				if (own === false) return false;
				// Beside it, on the way up: a layer that lies under the text without being around it, as a
				// picture behind a headline is often made.
				const beside = own === true || depth >= 12 ? null : a.parentElement?.children;
				for (let i = 0; beside !== null && beside !== undefined && i < beside.length && i < 30; i++) {
					const layer = beside[i];
					if (layer === a) continue;
					const g = facts(layer);
					if (!g.extra && !g.image && !layer.matches(MEDIA) && (g.fill === null || g.fill[3] <= 0.01 || alike(g.fill, colour))) continue;
					const m = layer.getBoundingClientRect();
					if (m.width > 0 && m.height > 0 && m.left < rect.right && m.right > rect.left && m.top < rect.bottom && m.bottom > rect.top) return false;
				}
				if (own === true) {
					// A picture inside that box which reaches under the text.
					let boxes = pictures.get(a);
					if (boxes === undefined) {
						boxes = Array.from(a.querySelectorAll(MEDIA)).slice(0, 50).map((media) => media.getBoundingClientRect()).filter((m) => m.width > 0 && m.height > 0);
						if (pictures.size < 2000) pictures.set(a, boxes);
					}
					if (boxes.some((m) => m.left < rect.right && m.right > rect.left && m.top < rect.bottom && m.bottom > rect.top)) return false;
					break;
				}
			}
			// In view: what the page itself says lies at the middle of the text, top to bottom.
			const x = rect.left + rect.width / 2;
			const y = rect.top + rect.height / 2;
			if (rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 && x < (view.innerWidth || 0) && y < (view.innerHeight || 0) && typeof live.elementsFromPoint === "function") {
				for (const hit of live.elementsFromPoint(x, y).slice(0, 30)) {
					if (hit === el || el.contains(hit)) continue;
					if (hit.matches(MEDIA)) return false;
					const own = paints(facts(hit), colour);
					if (own !== null) return own;
				}
			}
			return true;
		};
	}

	/**
	 * Walk the live document and its clone side by side and take out of the
	 * clone whatever the live page does not render. Reads the live page, writes
	 * only to the clone. Work is bounded: once maxElements live elements were
	 * looked at, the rest of the clone is dropped unseen rather than kept unseen.
	 * @param {Document} live
	 * @param {Document} clone a fresh document.cloneNode(true): same structure
	 * @param {number} maxElements
	 * @returns {{ inspected: number, removed: number, dropped: number, capped: boolean, fading: number }}
	 *   removed: hidden pieces that carried text; dropped: elements cut off by the cap or by a structure mismatch;
	 *   fading: transparent elements with text that were kept because their opacity is in motion
	 */
	function pruneHidden(live, clone, maxElements) {
		const stats = { inspected: 0, removed: 0, dropped: 0, capped: false, fading: 0 };
		const view = live.defaultView;
		const liveRoot = live.documentElement;
		const cloneRoot = clone.documentElement;
		if (liveRoot === null || cloneRoot === null) return stats;
		/**
		 * Take an element out of the clone. A document needs its root and its
		 * body: those are emptied instead (the root keeps its head).
		 * @param {Element} el clone element
		 */
		const take = (el) => {
			if (el === cloneRoot) {
				for (const child of Array.from(cloneRoot.children)) {
					if (htmlTag(child) !== "head") take(child);
				}
			} else if (el === clone.body) {
				el.textContent = "";
			} else {
				el.remove();
			}
		};
		if (view === null) {
			// No styles to ask: nothing can be shown to be rendered.
			take(cloneRoot);
			stats.capped = true;
			return stats;
		}
		const rootStyle = view.getComputedStyle(liveRoot);
		const ltr = rootStyle.direction !== "rtl" && (live.body === null || view.getComputedStyle(live.body).direction !== "rtl");
		const styled = rootStyle.display !== "" && rootStyle.display !== undefined;

		/** @type {{ left: number, right: number, bottom: number } | null} */
		let flowEnd = null;
		/**
		 * Where the page's own content ends: the far edges of what lies in the
		 * flow, a few levels down from the body. Boxes that were moved a long way
		 * do not count, or the one that is being judged would vouch for itself.
		 * Nor does a box with nothing in it: space that is there to be scrolled
		 * past is no content.
		 */
		const flow = () => {
			if (flowEnd !== null) return flowEnd;
			let left = 0;
			let right = view.innerWidth || 0;
			let bottom = view.innerHeight || 0;
			/** @type {Element[]} */
			let level = [live.body ?? liveRoot];
			let seen = 0;
			for (let depth = 0; depth < 6 && level.length > 0 && seen < 2000; depth++) {
				/** @type {Element[]} */
				const below = [];
				for (const parent of level) {
					for (const child of Array.from(parent.children)) {
						if (++seen > 2000) break;
						const style = view.getComputedStyle(child);
						if (style.display === "none" || displaced(style)) continue;
						if (child.firstElementChild === null && !hasText(child) && !child.matches(MEDIA)) continue;
						const r = child.getBoundingClientRect();
						left = Math.min(left, r.left + view.scrollX);
						right = Math.max(right, r.right + view.scrollX);
						bottom = Math.max(bottom, r.bottom + view.scrollY);
						// What a box clips or scrolls does not make the page any longer.
						if (style.overflowX === "visible" && style.overflowY === "visible") below.push(child);
					}
				}
				level = below;
			}
			flowEnd = { left, right, bottom };
			return flowEnd;
		};

		/** @param {Element} el @returns {{ left: number, right: number, top: number, bottom: number }[]} the boxes of the text that is the element's own */
		const textBoxes = (el) => {
			/** @type {{ left: number, right: number, top: number, bottom: number }[]} */
			const out = [];
			const range = live.createRange();
			for (const node of Array.from(el.childNodes)) {
				if (node.nodeType !== 3 || !/\S/.test(node.nodeValue || "")) continue;
				range.selectNodeContents(node);
				for (const r of Array.from(range.getClientRects())) out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
				if (out.length > 200) break;
			}
			return out;
		};

		const confirmHidden = secondLook(live, view, MAX_BACKDROP_CHECKS);
		/** @type {Set<string> | null} the ids the controls of the page point at; made when first asked for */
		let pointedAt = null;
		/**
		 * @param {Element} el live element
		 * @returns {boolean} true when a control of the page says it is for this element: it names it as what it
		 *   controls, or is a link to it. That is how a button is tied to the panel it opens.
		 */
		const wired = (el) => {
			const id = el.id;
			if (typeof id !== "string" || id === "") return false;
			if (pointedAt === null) {
				// Read into a set, not asked for by a selector each time: an id may hold any character, and a page any number of boxes.
				pointedAt = new Set();
				for (const control of Array.from(live.querySelectorAll("[aria-controls], [aria-owns], a[href^='#'], [data-target], [data-bs-target]")).slice(0, 20000)) {
					for (const name of `${control.getAttribute("aria-controls") ?? ""} ${control.getAttribute("aria-owns") ?? ""}`.split(/\s+/)) pointedAt.add(name);
					for (const target of [control.getAttribute("href"), control.getAttribute("data-target"), control.getAttribute("data-bs-target")]) {
						if (typeof target === "string" && target.startsWith("#")) pointedAt.add(target.slice(1));
					}
				}
				pointedAt.delete("");
			}
			return pointedAt.has(id);
		};
		/** @param {string} id @returns {Element | null} */
		const lookup = (id) => live.getElementById(id);

		/**
		 * @typedef {object} Pair
		 * @property {Element} live
		 * @property {Element} clone
		 * @property {boolean} parentOutside
		 * @property {Inherit} from what the element around it hands down
		 */
		/**
		 * @param {Element} el live element
		 * @returns {ShadowRoot | null} the shadow tree a page gave the element: an open one, and a closed one where
		 *   the browser shows it to an add-on
		 */
		const shadowOf = (el) => {
			const tag = htmlTag(el);
			if (!SHADOW_HOSTS.has(tag) && !tag.includes("-")) return null;
			try {
				const root = /** @type {any} */ (el).openOrClosedShadowRoot ?? el.shadowRoot;
				return typeof root === "object" && root !== null && typeof root.childNodes === "object" ? root : null;
			} catch {
				return null;
			}
		};
		// A page shows a shadow tree in the place of its host, and the host's own children where the slots of
		// that tree are, or nowhere. The clone is given the same shape as the walk comes by: the host gets a
		// copy of its tree, and each slot the copies of the children that are shown in it.
		/** @type {Map<Node, Node>} a host's own children, live, and what stands for them in the clone */
		const twins = new Map();
		/** @type {Set<Node>} the ones of them a slot has taken */
		const claimed = new Set();
		/** @type {Node[][]} per host */
		const lightOf = [];
		/** @param {Element} live a host @param {ShadowRoot} root @param {Element} copy what stands for the host in the clone */
		const unfold = (live, root, copy) => {
			const own = Array.from(copy.childNodes);
			const liveOwn = live.childNodes;
			for (let i = 0; i < own.length; i++) {
				// Same structure, or the children are shown nowhere.
				if (own.length === liveOwn.length && own[i].nodeType === liveOwn[i].nodeType) twins.set(liveOwn[i], own[i]);
				copy.removeChild(own[i]);
			}
			lightOf.push(own);
			for (const node of Array.from(root.childNodes)) copy.appendChild(clone.importNode(node, true));
		};
		/**
		 * @param {Element} live a slot @param {Element} copy what stands for it in the clone
		 * @returns {Element[] | null} the elements shown in the slot, now in the clone as well; null when the slot
		 *   shows what it holds itself
		 */
		const fill = (live, copy) => {
			const assigned = typeof (/** @type {any} */ (live).assignedNodes) === "function" ? /** @type {HTMLSlotElement} */ (live).assignedNodes() : [];
			if (assigned.length === 0) return null;
			copy.textContent = "";
			/** @type {Element[]} */
			const shown = [];
			for (const node of assigned) {
				const twin = twins.get(node);
				if (twin === undefined || claimed.has(twin)) continue;
				claimed.add(twin);
				copy.appendChild(twin);
				if (node.nodeType === 1) shown.push(/** @type {Element} */ (node));
			}
			return shown;
		};

		/** @type {Element[]} clone elements whose own box is not rendered; removed at the end when nothing is left in them */
		const hollow = [];
		// Behind everything there is the canvas: white, unless the page asks for a dark one.
		/** @type {Pair[]} */
		const stack = [{ live: liveRoot, clone: cloneRoot, parentOutside: false, from: { opacity: 1, bg: canvasColour(live, view, rootStyle), clipText: false, boxed: false } }];
		while (stack.length > 0) {
			const pair = /** @type {Pair} */ (stack.pop());
			const tag = htmlTag(pair.live);
			if (pair.live.localName !== pair.clone.localName) {
				stats.dropped += 1;
				take(pair.clone);
				continue;
			}
			if (PRUNE_SKIP.has(tag) || tag === "head") continue;
			if (stats.inspected >= maxElements) {
				stats.capped = true;
				stats.dropped += 1;
				take(pair.clone);
				continue;
			}
			stats.inspected += 1;
			const root = shadowOf(pair.live);
			if (root !== null) unfold(pair.live, root, pair.clone);
			const shown = root === null && tag === "slot" ? fill(pair.live, pair.clone) : null;
			const r = rendering(pair.live, view.getComputedStyle(pair.live), {
				...pair.from,
				view,
				ltr,
				parentOutside: pair.parentOutside,
				ownText: Array.from(pair.clone.childNodes).some((n) => (n.nodeType === 3 || n.nodeType === 4) && /\S/.test(n.nodeValue || "")),
				styled,
				flow,
				textBoxes,
				confirmHidden,
				wired,
				lookup,
			});
			if (r.kind === "tree") {
				if (hasText(pair.clone)) stats.removed += 1;
				take(pair.clone);
				continue;
			}
			if (r.kind !== null) {
				if (stripOwnText(pair.clone)) stats.removed += 1;
				if (r.kind === "box" && pair.clone !== cloneRoot && pair.clone !== clone.body) hollow.push(pair.clone);
			}
			if (r.fading === true && hasText(pair.clone)) stats.fading += 1;
			if (REPLACED.has(tag)) {
				// Fallback content: in the document, never on the screen. The sources of a player stay.
				let text = false;
				for (const node of Array.from(pair.clone.childNodes)) {
					if (node.nodeType === 1 && PRUNE_SKIP.has(htmlTag(/** @type {Element} */ (node)))) continue;
					if (hasText(node)) text = true;
					pair.clone.removeChild(node);
				}
				if (text) stats.removed += 1;
				continue;
			}
			const liveKids = root !== null ? root.children : (shown ?? pair.live.children);
			const cloneKids = Array.from(pair.clone.children);
			// Pushed in reverse so that elements are looked at in document order:
			// what the cap cuts off is the end of the page, not its middle.
			for (let i = cloneKids.length - 1; i >= 0; i--) {
				const liveKid = liveKids[i];
				if (liveKid === undefined) {
					stats.dropped += 1;
					take(cloneKids[i]);
				} else {
					stack.push({ live: liveKid, clone: cloneKids[i], parentOutside: r.outside, from: r });
				}
			}
		}
		// Deepest first: a hidden box that holds nothing rendered goes too.
		for (let i = hollow.length - 1; i >= 0; i--) {
			const el = hollow[i];
			if (el.firstElementChild === null && !hasText(el)) el.remove();
		}
		// What a host holds and no slot shows.
		for (const own of lightOf) {
			if (own.some((node) => !claimed.has(node) && hasText(node))) stats.removed += 1;
		}
		return stats;
	}

	/**
	 * The schema.org data of one script, as it may be passed on: parsed, the two members Defuddle takes for
	 * content ("text", "articleBody") taken out at every depth, and written out again in a form that reads the
	 * same to every parser. Defuddle strips comments from the text before it parses it, so a member that is
	 * named "text" with a comment in the middle here would be plain "text" there. Written out without a star,
	 * an angle bracket or a line break, there is nothing left for that to work on.
	 * @param {string} text what stands in the script
	 * @returns {string | null} null when the text is not JSON as it stands
	 */
	function schemaJson(text) {
		/** @param {unknown} v @param {number} depth */
		const strip = (v, depth) => {
			if (typeof v !== "object" || v === null) return;
			if (depth > 24) throw new Error("too deep");
			if (Array.isArray(v)) {
				for (const item of v) strip(item, depth + 1);
				return;
			}
			const o = /** @type {Record<string, unknown>} */ (v);
			for (const key of Object.keys(o)) {
				if (key === "text" || key === "articleBody") delete o[key];
				else strip(o[key], depth + 1);
			}
		};
		try {
			const data = JSON.parse(text);
			strip(data, 0);
			return JSON.stringify(data).replace(/[*<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
		} catch {
			return null;
		}
	}

	/**
	 * Defuddle replaces thin content with the "text" or "articleBody" of the
	 * page's schema.org data, which no visitor sees. Take those two out of the
	 * clone's JSON-LD; the rest (author, dates, publisher) stays.
	 * @param {Document} clone
	 */
	function defuseSchemaText(clone) {
		for (const script of Array.from(clone.querySelectorAll('script[type="application/ld+json"]'))) {
			const json = schemaJson(script.textContent || "");
			// Not plain JSON: nothing of it is passed on.
			if (json === null) script.remove();
			else script.textContent = json;
		}
	}

	/**
	 * Replace every element of a clone that has a shadow tree by one that has none. A clone takes over the
	 * shadow trees a page marked as clonable, and Defuddle would put what is in them in the place of their
	 * hosts, unseen by the walk that takes out what is not rendered.
	 * @param {Document} clone
	 */
	function unshadow(clone) {
		for (const el of Array.from(clone.querySelectorAll("*"))) {
			const root = /** @type {any} */ (el).openOrClosedShadowRoot ?? el.shadowRoot;
			if (root === null || root === undefined) continue;
			const bare = clone.createElementNS(el.namespaceURI, el.localName);
			for (const attr of Array.from(el.attributes)) bare.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
			while (el.firstChild !== null) bare.appendChild(el.firstChild);
			el.replaceWith(bare);
		}
	}

	/**
	 * Put the letters of every drawing of a clone in the place of the drawing. The Markdown converter passes a
	 * drawing on as it is written, with every attribute and every part that is never drawn; what a visitor
	 * reads in a drawing is its letters. Called once what is not rendered has been taken out.
	 * @param {Document} clone
	 */
	function flattenDrawings(clone) {
		for (const svg of Array.from(clone.querySelectorAll("svg"))) {
			// One that was inside another is gone with it.
			if (!clone.contains(svg) || !inDrawing(svg)) continue;
			const text = visibleText(svg);
			if (text === "") {
				svg.remove();
				continue;
			}
			const span = clone.createElement("span");
			span.textContent = text;
			svg.replaceWith(span);
		}
	}

	/**
	 * A clone of the document with everything taken out that is not rendered,
	 * cannot be trusted or could make the browser load something.
	 * @param {number} maxElements
	 */
	function prepare(maxElements) {
		const clone = /** @type {Document} */ (document.cloneNode(true));
		// First, while the clone still has the structure of the live document.
		const pruned = pruneHidden(document, clone, maxElements);
		if (clone.head) {
			for (const el of Array.from(clone.head.children)) {
				if (!HEAD_KEEP.has(htmlTag(el))) el.remove();
			}
		}
		// A template is never rendered, and the bundle would unpack the ones that look like shadow trees.
		for (const el of Array.from(clone.querySelectorAll("iframe,object,embed,template"))) el.remove();
		for (const name of CONTENT_ATTRS) {
			for (const el of Array.from(clone.querySelectorAll(`[${name}]`))) el.removeAttribute(name);
		}
		// What a script holds is for the site's own extractor to read, where there is one.
		const site = siteHost(location.hostname);
		if (!site) {
			for (const script of Array.from(clone.querySelectorAll("script"))) {
				if (!script.matches(SCRIPT_KEEP)) script.textContent = "";
			}
		}
		unshadow(clone);
		flattenDrawings(clone);
		dropComments(clone);
		cleanAttributes(clone, document.baseURI, false);
		defuseSchemaText(clone);
		return { clone, pruned, site };
	}

	/**
	 * Take what a page keeps for a browser without scripts out of a clone. In a document that runs scripts
	 * it is one piece of text; written out and parsed again it would become elements, and could close the
	 * boxes around it. Defuddle looks there for the pictures of lazy loaders and gets a copy made before this.
	 * @param {Document} clone
	 */
	function dropNoscript(clone) {
		for (const el of Array.from(clone.querySelectorAll("noscript"))) el.remove();
	}

	/**
	 * The text of a pruned clone, with line breaks where blocks begin and end.
	 * A clone has no layout, so this goes by tag name.
	 * @param {Element | null} root
	 */
	function visibleText(root) {
		if (root === null) return "";
		/** @type {string[]} */
		const out = [];
		/** @type {({ node: Node } | { close: string })[]} */
		const stack = [{ node: root }];
		let pre = 0;
		// Line breaks owed before the next piece of text: 1 after a block, 2
		// (a blank line) around a paragraph. Owed, not written, so that blocks
		// that end and begin at the same place give one break, not several.
		let owed = 0;
		/** @param {string} text */
		const write = (text) => {
			if (owed > 0 && out.length > 0) out.push("\n".repeat(owed));
			owed = 0;
			out.push(text);
		};
		while (stack.length > 0) {
			const item = /** @type {{ node: Node } | { close: string }} */ (stack.pop());
			if ("close" in item) {
				if (item.close === "pre") pre -= 1;
				if (item.close === "td" || item.close === "th") out.push("\t");
				else owed = Math.max(owed, TEXT_PARA.has(item.close) ? 2 : 1);
				continue;
			}
			const node = item.node;
			if (node.nodeType === 3 || node.nodeType === 4) {
				let text = node.nodeValue || "";
				if (pre === 0) {
					text = text.replace(/\s+/g, " ");
					// One space between two pieces of running text, none at the start of a line.
					if (text.startsWith(" ") && (owed > 0 || /(?:^|\s)$/.test(out[out.length - 1] ?? ""))) text = text.slice(1);
				}
				if (text !== "") write(text);
				continue;
			}
			if (node.nodeType !== 1) continue;
			const el = /** @type {Element} */ (node);
			const tag = htmlTag(el);
			if (TEXT_SKIP.has(tag)) continue;
			if (tag === "" && inDrawing(el)) {
				if (SVG_UNSEEN.has(el.localName)) continue;
				// Each run of letters in a drawing is placed by itself: a line of its own here.
				if (el.localName === "text") {
					owed = Math.max(owed, 1);
					stack.push({ close: "text" });
				}
			}
			if (tag === "br") {
				write("\n");
				continue;
			}
			if (TEXT_PARA.has(tag) || TEXT_BLOCK.has(tag) || tag === "td" || tag === "th") {
				if (tag !== "td" && tag !== "th") owed = Math.max(owed, TEXT_PARA.has(tag) ? 2 : 1);
				if (tag === "pre") pre += 1;
				stack.push({ close: tag });
			}
			for (let child = el.lastChild; child !== null; child = child.previousSibling) stack.push({ node: child });
		}
		return out
			.join("")
			.replace(/\r\n?/g, "\n")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	/**
	 * The name a page gives its site. Never the author: Defuddle falls back to
	 * that, which is why its own "site" is not used.
	 * @param {Document} doc
	 * @param {unknown} schema Defuddle's schemaOrgData
	 * @returns {string | null}
	 */
	function declaredSite(doc, schema) {
		/** @param {string} selector */
		const fromMeta = (selector) => meta(doc.querySelector(selector)?.getAttribute("content"), CAP.site);
		/** @param {unknown} v @param {number} depth @param {boolean} webSite @returns {string | null} */
		const fromSchema = (v, depth, webSite) => {
			if (typeof v !== "object" || v === null || depth > 6) return null;
			const items = Array.isArray(v) ? v : [v];
			for (const item of items.slice(0, 50)) {
				if (typeof item !== "object" || item === null) continue;
				if (Array.isArray(item)) {
					const nested = fromSchema(item, depth + 1, webSite);
					if (nested !== null) return nested;
					continue;
				}
				const o = /** @type {Record<string, unknown>} */ (item);
				const type = o["@type"];
				const isWebSite = type === "WebSite" || (Array.isArray(type) && type.includes("WebSite"));
				const holder = webSite ? (isWebSite ? o : null) : o.publisher;
				const name = typeof holder === "object" && holder !== null ? meta(/** @type {Record<string, unknown>} */ (holder).name, CAP.site) : null;
				if (name !== null) return name;
				const nested = fromSchema(o["@graph"], depth + 1, webSite);
				if (nested !== null) return nested;
			}
			return null;
		};
		return (
			fromMeta('meta[property="og:site_name"]') ??
			fromMeta('meta[name="og:site_name"]') ??
			fromSchema(schema, 0, false) ??
			fromSchema(schema, 0, true) ??
			fromMeta('meta[name="application-name"]')
		);
	}

	/**
	 * @param {any} res Defuddle's result, or null
	 * @param {Document} doc the prepared clone
	 * @param {string} extractor
	 * @param {unknown} words
	 */
	function pageInfo(res, doc, extractor, words) {
		const r = res || {};
		const wc = typeof words === "number" && Number.isSafeInteger(words) && words >= 0 ? words : 0;
		return {
			title: meta(r.title, CAP.title) ?? meta(document.title, CAP.title),
			author: meta(r.author, CAP.author),
			published: dateOrNull(r.published),
			// A page can take its root element away: then there is no language to read.
			lang: meta(r.language, CAP.lang) ?? meta(document.documentElement?.lang, CAP.lang),
			site: declaredSite(doc, r.schemaOrgData) ?? meta(location.hostname, CAP.site),
			word_count: wc,
			extractor: meta(extractor, CAP.extractor),
		};
	}

	/**
	 * The page source as the live document holds it now: doctype and the root element, scripts, comments and
	 * hidden elements included. Read only; the document is not touched.
	 * @returns {string}
	 */
	function pageSource() {
		const dt = document.doctype;
		let head = "";
		if (dt) {
			head = `<!DOCTYPE ${dt.name}`;
			if (dt.publicId) head += ` PUBLIC "${dt.publicId}"${dt.systemId ? ` "${dt.systemId}"` : ""}`;
			else if (dt.systemId) head += ` SYSTEM "${dt.systemId}"`;
			head += ">\n";
		}
		// Without a root element the source is the doctype, or nothing.
		return head + (document.documentElement?.outerHTML ?? "");
	}

	/** @param {string} text */
	function escapeHtml(text) {
		return text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
	}

	/** @param {unknown} options */
	function extract(options) {
		const t0 = performance.now();
		const o = /** @type {Record<string, unknown>} */ (typeof options === "object" && options !== null ? options : {});
		const wantMd = o.markdown !== false;
		const wantText = o.text !== false;
		const wantHtml = o.html === true;
		const wantRaw = o.rawHtml === true;
		const wantLinks = o.links !== false;
		const useDefuddle = o.defuddle !== false;
		const maxMd = intOpt(o.maxMarkdownChars, CAP.resultChars, CAP.resultChars);
		const maxText = intOpt(o.maxTextChars, CAP.resultChars, CAP.resultChars);
		const maxHtml = intOpt(o.maxHtmlChars, CAP.resultChars, CAP.resultChars);
		const maxRaw = intOpt(o.maxRawHtmlChars, CAP.rawHtmlChars, CAP.rawHtmlChars);
		const maxLinks = intOpt(o.maxLinks, CAP.links, CAP.links);
		const maxElements = intOpt(o.maxElements, MAX_ELEMENTS, MAX_ELEMENTS);

		/** @type {string} */ let markdown;
		/** @type {string} everything the page shows, as plain text */ let visible;
		/** @type {string | null} */ let html = null;
		/** @type {Document | null} */ let linkDoc = null;
		/** @type {ReturnType<typeof pageInfo>} */ let page;
		/** @type {"article" | "full_page" | "text"} */ let view = "text";
		/** @type {number | null} share of the visible text that the article view holds, in percent */ let coverage = null;
		let pruned = { inspected: 0, removed: 0, dropped: 0, capped: false, fading: 0 };
		// The bundle was asked and did not answer: it is not there, or it threw. The result is then made
		// without it, and says so.
		let defuddleFailed = false;

		if (document.contentType === "text/plain") {
			// The browser shows a text file as one <pre>. There is nothing hidden in it and nothing to parse.
			const pre = document.querySelector("pre");
			markdown = ((pre ?? document.body ?? document.documentElement)?.textContent || "").replace(/\r\n?/g, "\n");
			visible = markdown;
			if (wantHtml) html = `<pre>${escapeHtml(markdown)}</pre>`;
			page = { title: null, author: null, published: null, lang: null, site: meta(location.hostname, CAP.site), word_count: countWords(markdown), extractor: "plaintext" };
		} else {
			const prepared = prepare(maxElements);
			pruned = prepared.pruned;
			const body = prepared.clone.body;
			visible = visibleText(body);
			const visibleLen = textLength(visible);
			const parse = useDefuddle && (body?.textContent || "").length <= MAX_DEFUDDLE_CHARS;
			// A copy: the pruned clone stays as it is for the views made from it below.
			const copy = parse ? prepared.clone.cloneNode(true) : null;
			dropNoscript(prepared.clone);
			/** @type {any} */
			let res = null;
			if (copy !== null) {
				try {
					// A function, or it is not the bundle's: a frame the page named "Defuddle" would be found
					// under that name too, and is an object.
					const Ctor = /** @type {any} */ (globalThis).Defuddle;
					if (typeof Ctor !== "function") throw new Error("defuddle missing");
					const defuddle = new Ctor(copy, {
						url: document.URL,
						separateMarkdown: wantMd,
						fetch: () => Promise.reject(new Error("network disabled")),
					});
					// The bundle has no option that turns its site extractors off. It skips them while it is
					// inside one, and says so in a field of the parser: set, on every host but theirs.
					const parser = defuddle.defuddle;
					if (!prepared.site && typeof parser === "object" && parser !== null && "_inExtractorPipelineRun" in parser) parser._inExtractorPipelineRun = true;
					res = defuddle.parse();
					// Should an extractor have run all the same, what it made is not used.
					if (!prepared.site && res !== null && typeof res === "object" && res.extractorType !== undefined && res.extractorType !== null) res = null;
				} catch {
					res = null;
					defuddleFailed = true;
				}
			}
			const html0 = res && typeof res.content === "string" ? res.content : "";
			const cleanDoc = html0 === "" ? null : scrub(html0, document.baseURI);
			const cleanText = cleanDoc?.body ? cleanDoc.body.textContent || "" : "";
			const article = res !== null && cleanText.trim().length >= MIN_CONTENT_CHARS;
			const type = article ? meta(res.extractorType, 40) : null;
			if (article && visibleLen > 0) coverage = Math.min(100, Math.round((textLength(cleanText) * 100) / visibleLen));
			// An extractor written for the site knows what the content of its pages
			// is. The general one guesses, and on a thread it guesses the first post.
			const whole = article && type === null && coverage !== null && coverage < FULL_PAGE_BELOW * 100 && visibleLen >= MIN_FULL_PAGE_CHARS;
			if (article && !whole) {
				const md = typeof res.contentMarkdown === "string" ? res.contentMarkdown : cleanText;
				markdown = cleanMarkdown(md).trim();
				if (wantHtml) html = cleanDoc?.body ? cleanDoc.body.innerHTML : "";
				linkDoc = cleanDoc;
				view = "article";
				page = pageInfo(res, prepared.clone, `defuddle@${DEFUDDLE_VERSION}${type ? `+${type}` : ""}`, res.wordCount);
			} else {
				// Everything that is rendered: as Markdown where the article view left
				// most of the page out, as plain text where there was next to nothing
				// to begin with (or nothing ran).
				const fullDoc = body && ((whole && wantMd) || wantHtml || wantLinks) ? scrub(body.innerHTML, document.baseURI, whole) : null;
				const convert = whole && wantMd && fullDoc?.body;
				const converted = convert ? toMarkdown(fullDoc.body.innerHTML) : null;
				if (convert && converted === null) defuddleFailed = true;
				const md = converted === null ? "" : cleanMarkdown(converted).trim();
				if (whole && (!wantMd || textLength(md) >= visibleLen * MIN_CONVERTED_SHARE)) {
					markdown = md;
					view = "full_page";
					page = pageInfo(res, prepared.clone, `defuddle@${DEFUDDLE_VERSION}+fullpage`, countWords(visible));
				} else {
					markdown = visible;
					page = pageInfo(res, prepared.clone, "innertext", countWords(visible));
				}
				linkDoc = fullDoc;
				if (wantHtml) html = fullDoc?.body ? fullDoc.body.innerHTML : "";
			}
		}

		const [mdOut, mdCut] = cut(markdown, maxMd);
		// Where the Markdown is the visible text itself, the text is not sent a second time.
		const sendText = wantText && !(view === "text" && wantMd);
		const [textOut, textCut] = sendText ? cut(visible, maxText) : [null, false];
		const [htmlOut, htmlCut] = html === null ? [null, false] : cut(html, maxHtml);
		const [rawOut, rawCut] = wantRaw ? cut(pageSource(), maxRaw) : [null, false];
		return {
			ok: true,
			url: location.href,
			page,
			extraction: { view, coverage_pct: coverage, hidden_removed: pruned.removed, capped: pruned.capped },
			content: {
				markdown: wantMd ? mdOut : null,
				text: textOut,
				html: wantHtml ? htmlOut : null,
				raw_html: rawOut,
				links: wantLinks && linkDoc ? collectLinks(linkDoc, maxLinks) : [],
			},
			// Content the element cap cut off is missing from all of them.
			truncated: { markdown: wantMd && (mdCut || pruned.capped), text: sendText && (textCut || pruned.capped), html: wantHtml && (htmlCut || pruned.capped), raw_html: wantRaw && rawCut },
			stats: {
				text_len: markdown.length,
				visible_len: visible.length,
				html_len: html === null ? 0 : html.length,
				ms: Math.round(performance.now() - t0),
				elements_inspected: pruned.inspected,
				elements_cap: maxElements,
				capped: pruned.capped,
				hidden_removed: pruned.removed,
				fading_kept: pruned.fading,
				dropped: pruned.dropped,
				defuddle_failed: defuddleFailed,
			},
		};
	}

	// For content/search.js: the same pruned clone, so that a results page is read the way every page is.
	extract.prepare = (/** @type {unknown} */ maxElements) => {
		const prepared = prepare(intOpt(maxElements, MAX_ELEMENTS, MAX_ELEMENTS));
		dropNoscript(prepared.clone);
		return prepared;
	};
	// The decisions that need no page, for the unit tests.
	extract.internals = {
		rendering, opacityInMotion, filterOpacity, filterBlur, filterTint, clipIsEmpty, clipPathIsEmpty, pathBox, maskIsEmpty, transformIsFlat, squeezed, shrinkage, rgba, alike, over, plainImage,
		canvasColour, secondLook, visibleText, cleanMarkdown, cut, meta, scrub, siteHost, schemaJson, SITE_HOSTS, CONTENT_ATTRS, SCRIPT_KEEP, DROP_TAGS, MAX_BACKDROP_CHECKS,
	};
	/** @type {any} */ (globalThis).__bgwExtract = extract;
})();
