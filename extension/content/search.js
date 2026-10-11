// Search results. Injected into the job tab of a search after
// content/extract.js, into the same isolated world. It defines one function
// and does nothing else; the background page then calls it:
//
//   __bgwSearch({ limit, hint, maxElements })
//
// What it looks for is the shape every results page has, whatever the engine:
// a run of blocks that repeat, each with one link that reads like a heading
// and some text next to it. It does not know any engine's markup. The "hints"
// below are a few selectors per engine that are tried as well; they are
// guesses that nobody has checked against a live page, so they only ever
// count when they find results - and at least most of what the general look
// finds. Otherwise the general look stands.
//
// Rules this file keeps, as content/extract.js does:
// - The live page is only read. Everything is taken from the pruned clone that
//   extract.js makes: what the page does not render is not in it, so text a
//   visitor cannot see makes no result.
// - No network, no eval, nothing written to the page.
// - What comes back is plain data: numbers, strings, a list. The background
//   page checks every piece of it again.
(() => {
	const CAP = { title: 300, snippet: 500, url: 2048, results: 20 };
	// Fewer characters than this is no title: a page number, an arrow, "Next".
	const MIN_TITLE_CHARS = 3;
	// Text next to a title that is shorter than this is not worth calling a snippet.
	const MIN_SNIPPET_CHARS = 20;
	// Anchors looked at, at most. A results page has a few hundred.
	const MAX_ANCHORS = 4000;
	// How far up from a title link its surroundings are compared and searched for labels.
	const SIGNATURE_DEPTH = 3;
	const LABEL_DEPTH = 4;
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	const HEADING = "h1,h2,h3,h4,h5,h6,[role=heading]";
	// Parts of a page that hold no results, whatever is in them.
	const CHROME = "nav,footer,aside,menu,[role=navigation],[role=contentinfo],[role=complementary],[role=banner],[role=search],[role=dialog]";

	// Words in an id, a class or a label that say "this is an advertisement" or
	// "this is not a result": whole words between spaces, hyphens and underscores.
	const AD_WORDS = new Set(["ad", "ads", "adv", "advert", "adverts", "advertisement", "advertising", "sponsor", "sponsored", "promoted"]);
	const NOISE_WORDS = new Set(["related", "pagination", "pager", "paging", "sitelink", "sitelinks", "paa", "suggestion", "suggestions"]);
	// A short text that stands alone in a block and marks it as an advertisement.
	const AD_BADGE = /^(ad|ads|sponsored|promoted|advertisement|anzeige|anzeigen|gesponsert|werbung|annonce|sponsorisé|publicité|anuncio|patrocinado)\s*[·:.-]?$/i;
	// The heading of a section that holds questions and other searches, not results.
	const SECTION_LABEL = /^(people also ask|people also search(ed)? for|related (searches|queries|questions|topics)|searches related to\b.*|others (also )?search(ed)? for|also try|more to ask|ähnliche (suchanfragen|fragen)|weitere fragen|andere suchten auch|recherches associées|autres questions posées|búsquedas relacionadas)\s*:?$/i;
	// What a link of a pager says.
	const PAGER = /^(\d{1,3}|next|previous|prev|more|more results|next page|previous page|weiter|zurück|suivant|précédent|siguiente|anterior|[‹›«»<>]+|←|→)$/i;
	// Text that is an address, or a trail of one ("example.com > docs > api"): what stands above a snippet, not the snippet.
	const URL_LIKE = /^(https?:\/\/\S+|[a-z0-9-]+(\.[a-z0-9-]+)+(\s*[›>\/·|].*)?)$/i;

	// Second-level labels under a two-letter country code. A short copy of what shared/suffixes.js holds: this
	// script cannot import. Where the two differ this one takes the larger site (a unit test compares them).
	const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

	/**
	 * Selectors that may fit an engine's results page. Unchecked guesses: see the head of this file.
	 * The background page names an engine by its place in this list.
	 * @type {readonly { name: string, block: string, title: string, snippet: string }[]}
	 */
	const HINTS = Object.freeze([
		{ name: "duckduckgo", block: ".result, .web-result, [data-testid='result']", title: "a.result__a, h2 a, a.result-link", snippet: ".result__snippet, [data-result='snippet'], .result-snippet" },
		{ name: "brave", block: "[data-type='web'], .snippet", title: "a[href]", snippet: ".snippet-description, .snippet-content" },
		{ name: "bing", block: "li.b_algo", title: "h2 a", snippet: ".b_caption p, .b_lineclamp2, p" },
		{ name: "google", block: "div.g, div[data-sokoban-container]", title: "a[href]", snippet: "[data-sncf], .VwiC3b, span.st" },
		{ name: "startpage", block: ".result, .w-gl__result", title: "a.result-title, a.w-gl__result-title, h2 a", snippet: ".description, .w-gl__description, p" },
	]);

	/** @param {unknown} v @param {number} fallback @param {number} min @param {number} max */
	function intOpt(v, fallback, min, max) {
		if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
		return Math.max(min, Math.min(max, Math.floor(v)));
	}

	/**
	 * One line of text: white space folded, trimmed, cut without leaving half a surrogate pair.
	 * @param {unknown} v @param {number} max
	 * @returns {string}
	 */
	function line(v, max) {
		if (typeof v !== "string") return "";
		const flat = v.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
		if (flat.length <= max) return flat;
		let end = max;
		const c = flat.charCodeAt(end - 1);
		if (c >= 0xd800 && c <= 0xdbff) end--;
		return flat.slice(0, end).trim();
	}

	/**
	 * @param {string} host
	 * @returns {string} the site a host belongs to: its last two labels, or three under a country code's second level
	 */
	function siteOf(host) {
		const h = String(host).toLowerCase().replace(/\.$/, "");
		if (/^[0-9.]+$/.test(h) || h.includes(":")) return h;
		const labels = h.split(".");
		if (labels.length <= 2) return h;
		const keep = labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
		return labels.slice(-keep).join(".");
	}

	/**
	 * @param {string} value
	 * @returns {URL | null} an absolute http(s) address
	 */
	function webUrl(value) {
		try {
			const u = new URL(value);
			return (u.protocol === "http:" || u.protocol === "https:") && u.username === "" && u.password === "" ? u : null;
		} catch {
			return null;
		}
	}

	/**
	 * @param {string} text base64 or base64url, with or without padding
	 * @returns {string | null} the bytes as text, when they are plain ASCII
	 */
	function fromBase64(text) {
		if (!/^[A-Za-z0-9_+/-]{8,2800}={0,2}$/.test(text)) return null;
		try {
			const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, ""));
			return /^[ -~]+$/.test(bin) ? bin : null;
		} catch {
			return null;
		}
	}

	/**
	 * Engines wrap the links of their results in an address of their own that
	 * sends the browser on. The real target is in a parameter of that address:
	 * written out ("uddg", "q", "url") or in base64 ("u"). Only a link to the
	 * results page's own site is ever taken apart this way - a result that
	 * happens to carry an address in its query is a result.
	 * @param {URL} u the link as the page has it
	 * @param {string} pageSite site of the results page
	 * @returns {URL | null} the target, or null when the link is no such wrapper
	 */
	function unwrapRedirect(u, pageSite) {
		if (siteOf(u.hostname) !== pageSite) return null;
		const path = u.pathname.toLowerCase().replace(/\/+$/, "");
		const p = u.searchParams;
		/** @param {string | null} v @returns {URL | null} */
		const plain = (v) => (v === null || v.length > CAP.url * 2 ? null : webUrl(v));
		// duckduckgo.com/l/?uddg=<address>, and any other "/l/" style hop that names its target outright.
		if (path === "/l" || path.endsWith("/l")) return plain(p.get("uddg")) ?? plain(p.get("u")) ?? plain(p.get("url")) ?? plain(p.get("q"));
		if (p.has("uddg")) return plain(p.get("uddg"));
		// google.com/url?q=<address> (also "url=").
		if (path === "/url" || path.endsWith("/url")) return plain(p.get("q")) ?? plain(p.get("url"));
		// bing.com/ck/a?...&u=a1<base64url of the address>
		const packed = p.get("u");
		if (packed !== null && (path.endsWith("/ck/a") || path.endsWith("/ck") || path === "/r" || path === "/redirect" || path === "/link" || path === "/out")) {
			const decoded = fromBase64(/^a1/.test(packed) ? packed.slice(2) : packed);
			return (decoded === null ? null : webUrl(decoded)) ?? plain(packed);
		}
		return null;
	}

	/**
	 * @param {string} value an id, a class list or a label
	 * @param {ReadonlySet<string>} words
	 * @returns {boolean} true when one of the words stands in it as a word of its own
	 */
	function hasWord(value, words) {
		if (value.length > 400) return false;
		for (const word of value.toLowerCase().split(/[^a-z0-9]+/)) {
			if (words.has(word)) return true;
		}
		return false;
	}

	/** @param {Element} el @returns {string} lowercase tag of an HTML element, "" for anything else */
	function tagOf(el) {
		return el.namespaceURI === HTML_NS ? el.localName : "";
	}

	/** @param {Element} el @returns {string} */
	function textOf(el) {
		return (el.textContent || "").replace(/\s+/g, " ").trim();
	}

	/**
	 * @param {Element} el
	 * @returns {"ad" | "noise" | null} what the element's own names and labels say it is
	 */
	function labelOf(el) {
		const names = `${el.getAttribute("id") ?? ""} ${el.getAttribute("class") ?? ""} ${el.getAttribute("data-testid") ?? ""} ${el.getAttribute("data-type") ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
		if (hasWord(names, AD_WORDS)) return "ad";
		if (hasWord(names, NOISE_WORDS)) return "noise";
		return null;
	}

	/**
	 * @param {Element} el
	 * @returns {boolean} true for what can be the label of a section: a heading, or a short piece of text without a link
	 */
	function labelLike(el) {
		if (el.matches(HEADING)) return true;
		const text = textOf(el);
		return text !== "" && text.length <= 80 && el.querySelector("a[href]") === null;
	}

	/** @param {Element} el @returns {string} what kind of thing an element is among its siblings: its tag and its classes */
	function kindOf(el) {
		return `${tagOf(el)}.${el.getAttribute("class") ?? ""}`;
	}

	/**
	 * Does the element stand under the label of a section that holds no
	 * results ("People also ask", "Related searches")? Either the container it
	 * is in begins with such a label, or the nearest label before it among its
	 * siblings is one - and everything between that label and the element is
	 * of the element's own kind, so that the label is theirs and not that of
	 * some other block further up the list.
	 * @param {Element} el
	 * @returns {boolean}
	 */
	function underSectionLabel(el) {
		const parent = el.parentElement;
		if (parent === null) return false;
		const first = parent.firstElementChild;
		if (first !== null && first !== el && labelLike(first) && SECTION_LABEL.test(textOf(first))) return true;
		const kind = kindOf(el);
		for (let s = el.previousElementSibling, n = 0; s !== null && n < 40; s = s.previousElementSibling, n++) {
			if (labelLike(s)) return SECTION_LABEL.test(textOf(s));
			if (textOf(s) !== "" && kindOf(s) !== kind) return false;
		}
		return false;
	}

	/**
	 * Why a link is no result, by where it stands and what its surroundings
	 * are called: looked at from the link itself up to its block, and a few
	 * levels beyond.
	 * @param {Element} anchor the title link
	 * @param {Element} block what was taken for the result around it
	 * @param {Element} root the body of the clone
	 * @returns {string | null} "chrome", "ad", "noise", "section" - or null: nothing speaks against it
	 */
	function excluded(anchor, block, root) {
		if (anchor.closest(CHROME) !== null) return "chrome";
		// A header that is the page's own, not the head of an article or a result.
		const header = anchor.closest("header");
		if (header !== null && header.closest("article,li,section,main") === null) return "chrome";
		let beyond = -1;
		for (let el = /** @type {Element | null} */ (anchor); el !== null && el !== root; el = el.parentElement) {
			const label = labelOf(el);
			if (label !== null) return label;
			if (underSectionLabel(el)) return "section";
			if (el === block) beyond = 0;
			else if (beyond >= 0 && ++beyond >= LABEL_DEPTH) break;
		}
		// A badge inside the block: a short text of its own that says "Ad".
		let looked = 0;
		for (const el of Array.from(block.querySelectorAll("span,div,small,b,strong,em,label,p,i"))) {
			if (++looked > 60) break;
			if (el.childElementCount === 0 && (el.textContent || "").length <= 16 && AD_BADGE.test(textOf(el))) return "ad";
		}
		return null;
	}

	/**
	 * The text next to a title: of everything in the block that is not the
	 * title, the piece where most of the text is, without an address that
	 * stands in front of it.
	 * @param {Element} block
	 * @param {Element} title the title link, or the heading around it
	 * @returns {string}
	 */
	function snippetIn(block, title) {
		/** @type {Element | null} */
		let best = null;
		let bestLen = 0;
		// The subtrees beside the path from the block down to the title.
		for (let on = /** @type {Element | null} */ (title); on !== null && on !== block.parentElement; on = on.parentElement) {
			const parent = on === block ? null : on.parentElement;
			if (parent === null) break;
			for (const side of Array.from(parent.children)) {
				if (side === on || side.contains(title)) continue;
				const tag = tagOf(side);
				if (tag === "script" || tag === "style" || tag === "cite" || tag === "button" || tag === "select" || tag === "nav") continue;
				const text = textOf(side);
				if (URL_LIKE.test(text)) continue;
				if (text.length > bestLen) {
					best = side;
					bestLen = text.length;
				}
			}
		}
		// Text of the block that is in no element of its own, beside the title.
		if (best === null) {
			if (block === title || title.contains(block)) return "";
			let own = "";
			for (const node of Array.from(block.childNodes)) {
				if (node.nodeType === 3) own += ` ${node.nodeValue ?? ""}`;
			}
			return line(own, CAP.snippet).length >= MIN_SNIPPET_CHARS ? line(own, CAP.snippet) : "";
		}
		// Down to where the text is: a wrapper whose longest child holds most of it is not the place -
		// what else is in it (links under a result, a date, an address) is not the snippet.
		for (let depth = 0; depth < 8; depth++) {
			/** @type {Element | null} */
			let inner = null;
			let innerLen = 0;
			for (const child of Array.from(best.children)) {
				const len = textOf(child).length;
				if (len > innerLen && !URL_LIKE.test(textOf(child))) {
					inner = child;
					innerLen = len;
				}
			}
			if (inner === null || innerLen < bestLen * 0.55 || innerLen < MIN_SNIPPET_CHARS) break;
			best = inner;
			bestLen = innerLen;
		}
		const text = line(textOf(best), CAP.snippet);
		return text.length >= MIN_SNIPPET_CHARS && !URL_LIKE.test(text) ? text : "";
	}

	/**
	 * A snippet that stands after the block, not in it: the next row of a
	 * table, the description after a term.
	 * @param {Element} block
	 * @param {(el: Element) => boolean} isOther true for an element that holds another result's title
	 * @returns {string}
	 */
	function snippetAfter(block, isOther) {
		let best = "";
		for (let s = block.nextElementSibling, n = 0; s !== null && n < 3; s = s.nextElementSibling, n++) {
			if (isOther(s) || s.matches(HEADING)) break;
			const text = line(textOf(s), CAP.snippet);
			if (text.length > best.length && !URL_LIKE.test(text)) best = text;
		}
		return best.length >= MIN_SNIPPET_CHARS ? best : "";
	}

	/**
	 * @typedef {object} Candidate a link that may be the title of a result
	 * @property {Element} anchor
	 * @property {Element} title the heading around or inside the link, else the link
	 * @property {string} text
	 * @property {URL} target where the link leads, redirects of the engine taken off
	 * @property {boolean} outward the target is another site than the results page, or was wrapped by it
	 * @property {boolean} heading the link is, holds or stands in a heading
	 * @property {string} signature what stands around the link, a few levels up
	 * @property {number} order place in the document
	 *
	 * @typedef {{ title: string, url: string, snippet: string }} Found
	 */

	/**
	 * The title a link holds. A link can wrap more than that - a site's name,
	 * its address, a picture: then the title is the heading in it, or the
	 * longest piece of its text that is no address.
	 * @param {Element} anchor
	 * @returns {{ el: Element, text: string }} the element that holds the title, and the title
	 */
	function titleIn(anchor) {
		const inner = anchor.querySelector(HEADING);
		if (inner !== null) return { el: inner, text: line(textOf(inner), CAP.title) };
		const ownText = Array.from(anchor.childNodes).some((n) => n.nodeType === 3 && /\S/.test(n.nodeValue || ""));
		if (!ownText && anchor.childElementCount > 0) {
			/** @type {Element | null} */
			let best = null;
			let pieces = 0;
			for (const el of Array.from(anchor.querySelectorAll("*")).slice(0, 80)) {
				if (el.childElementCount > 0) continue;
				const text = textOf(el);
				if (text === "") continue;
				pieces += 1;
				if (tagOf(el) === "cite" || URL_LIKE.test(text)) continue;
				if (best === null || text.length > textOf(best).length) best = el;
			}
			if (pieces >= 2 && best !== null) return { el: best, text: line(textOf(best), CAP.title) };
		}
		return { el: anchor, text: line(textOf(anchor), CAP.title) };
	}

	/**
	 * @param {Element} anchor
	 * @param {string} base
	 * @param {string} pageSite
	 * @returns {{ target: URL, outward: boolean } | null}
	 */
	function targetOf(anchor, base, pageSite) {
		const href = anchor.getAttribute("href");
		if (href === null || href.length > CAP.url * 3) return null;
		/** @type {URL} */
		let u;
		try {
			u = new URL(href.trim(), base);
		} catch {
			return null;
		}
		if (u.protocol !== "http:" && u.protocol !== "https:") return null;
		const unwrapped = unwrapRedirect(u, pageSite);
		const target = unwrapped ?? u;
		if (target.username !== "" || target.password !== "" || target.href.length > CAP.url) return null;
		return { target, outward: unwrapped !== null || siteOf(target.hostname) !== pageSite };
	}

	/**
	 * Every link of the page that could be the title of a result.
	 * @param {Element} root
	 * @param {string} base
	 * @param {string} pageSite
	 * @returns {Candidate[]}
	 */
	function candidates(root, base, pageSite) {
		/** @type {Candidate[]} */
		const out = [];
		let order = 0;
		for (const anchor of Array.from(root.querySelectorAll("a[href]")).slice(0, MAX_ANCHORS)) {
			order += 1;
			const where = targetOf(anchor, base, pageSite);
			if (where === null) continue;
			const inner = anchor.querySelector(HEADING);
			const outer = anchor.closest(HEADING);
			const title = inner ?? outer ?? anchor;
			const text = titleIn(anchor).text;
			if (text.length < MIN_TITLE_CHARS || PAGER.test(text)) continue;
			/** @type {string[]} */
			const path = [];
			for (let el = anchor.parentElement, depth = 0; el !== null && el !== root && depth < SIGNATURE_DEPTH; el = el.parentElement, depth++) path.push(tagOf(el));
			const heading = inner !== null || outer !== null;
			out.push({ anchor, title, text, target: where.target, outward: where.outward, heading, signature: `${heading ? "h" : "-"}:${path.join(">")}`, order });
		}
		return out;
	}

	/**
	 * For each link of a group, the largest piece of the page around it that
	 * holds no other link of the group: its block.
	 * @param {Candidate[]} group
	 * @param {Element} root
	 * @returns {Map<Candidate, Element>}
	 */
	function blocksOf(group, root) {
		/** @type {Map<Element, number>} how many of the group's links an element holds */
		const holds = new Map();
		for (const c of group) {
			for (let el = /** @type {Element | null} */ (c.anchor); el !== null && el !== root; el = el.parentElement) holds.set(el, (holds.get(el) ?? 0) + 1);
		}
		/** @type {Map<Candidate, Element>} */
		const blocks = new Map();
		for (const c of group) {
			let block = c.anchor;
			for (let el = c.anchor.parentElement; el !== null && el !== root && holds.get(el) === 1; el = el.parentElement) block = el;
			blocks.set(c, block);
		}
		return blocks;
	}

	/**
	 * The general look: the group of like links that reads most like a list
	 * of results, each with its block and its snippet.
	 * @param {Element} root body of the pruned clone
	 * @param {string} base
	 * @param {string} pageSite
	 * @returns {Found[]} in document order
	 */
	function detectGeneric(root, base, pageSite) {
		const all = candidates(root, base, pageSite);
		/** @type {Map<string, Candidate[]>} */
		const groups = new Map();
		for (const c of all) {
			// A link to the results page's own site is the engine's own business: a tab, a setting, another search.
			if (!c.outward) continue;
			const group = groups.get(c.signature);
			if (group === undefined) groups.set(c.signature, [c]);
			else group.push(c);
		}
		/** @type {{ score: number, kept: { c: Candidate, snippet: string, block: Element }[] } | null} */
		let best = null;
		for (const group of groups.values()) {
			const blocks = blocksOf(group, root);
			const anchors = new Set(group.map((c) => c.anchor));
			/** @param {Element} el */
			const isOther = (el) => anchors.has(el) || Array.from(anchors).some((a) => el.contains(a));
			/** @type {{ c: Candidate, snippet: string, block: Element }[]} */
			const kept = [];
			for (const c of group) {
				const block = /** @type {Element} */ (blocks.get(c));
				if (excluded(c.anchor, block, root) !== null) continue;
				kept.push({ c, block, snippet: snippetIn(block, c.title) || snippetAfter(block, isOther) });
			}
			if (kept.length === 0) continue;
			const withSnippet = kept.filter((k) => k.snippet !== "").length;
			const hosts = new Set(kept.map((k) => k.c.target.hostname)).size;
			// Results have text next to them, read like headings and lead to many places.
			// A menu has none of the three.
			const score = withSnippet * 4 + (kept[0].c.heading ? kept.length * 2 : 0) + Math.min(hosts, kept.length);
			if (best === null || score > best.score) best = { score, kept };
		}
		if (best === null) return [];
		// A results page can lay some of its results out differently (the first one,
		// one with a picture). What stands among the chosen ones, reads like a
		// heading and has text next to it belongs to the list as well.
		const first = best.kept[0].c.order;
		const last = best.kept[best.kept.length - 1].c.order;
		const chosen = new Set(best.kept.map((k) => k.c));
		const merged = [...best.kept];
		for (const group of groups.values()) {
			if (group.every((c) => chosen.has(c))) continue;
			const blocks = blocksOf(group, root);
			const anchors = new Set(group.map((c) => c.anchor));
			for (const c of group) {
				if (chosen.has(c) || !c.heading || c.order < first || c.order > last) continue;
				const block = /** @type {Element} */ (blocks.get(c));
				if (excluded(c.anchor, block, root) !== null) continue;
				// Not a link inside a result that is on the list already (a sub-link under a result).
				if (best.kept.some((k) => k.block.contains(c.anchor))) continue;
				const snippet = snippetIn(block, c.title) || snippetAfter(block, (el) => anchors.has(el));
				if (snippet !== "") merged.push({ c, block, snippet });
			}
		}
		merged.sort((a, b) => a.c.order - b.c.order);
		return merged.map((k) => ({ title: k.c.text, url: k.c.target.href, snippet: k.snippet }));
	}

	/**
	 * The look by an engine's selectors. Every block it finds goes through the
	 * same checks as the general look's.
	 * @param {Element} root
	 * @param {{ block: string, title: string, snippet: string }} hint
	 * @param {string} base
	 * @param {string} pageSite
	 * @returns {Found[]}
	 */
	function detectByHint(root, hint, base, pageSite) {
		/** @type {Found[]} */
		const out = [];
		/** @type {Element[]} */
		let blocks;
		try {
			blocks = Array.from(root.querySelectorAll(hint.block));
		} catch {
			return [];
		}
		for (const block of blocks.slice(0, 200)) {
			// The outermost match is the block: a result inside a result is the same result.
			if (blocks.some((other) => other !== block && other.contains(block))) continue;
			/** @type {Element | null} */
			let anchor = null;
			/** @type {{ target: URL, outward: boolean } | null} */
			let where = null;
			try {
				for (const a of Array.from(block.querySelectorAll(hint.title)).slice(0, 20)) {
					if (tagOf(a) !== "a") continue;
					const w = targetOf(a, base, pageSite);
					if (w === null || !w.outward) continue;
					anchor = a;
					where = w;
					break;
				}
			} catch {
				return [];
			}
			if (anchor === null || where === null) continue;
			const inner = anchor.querySelector(HEADING);
			const text = titleIn(anchor).text;
			if (text.length < MIN_TITLE_CHARS || PAGER.test(text)) continue;
			if (excluded(anchor, block, root) !== null) continue;
			let snippet = "";
			try {
				const el = block.querySelector(hint.snippet);
				if (el !== null && !el.contains(anchor)) snippet = line(textOf(el), CAP.snippet);
			} catch {
				// a selector this browser does not know: the general way of finding the text
			}
			if (snippet.length < MIN_SNIPPET_CHARS || URL_LIKE.test(snippet)) snippet = snippetIn(block, inner ?? anchor.closest(HEADING) ?? anchor);
			out.push({ title: text, url: where.target.href, snippet });
		}
		return out;
	}

	/**
	 * @param {Found[]} found in document order
	 * @param {number} limit
	 * @returns {{ rank: number, title: string, url: string, snippet: string }[]} each address once, numbered from 1
	 */
	function finish(found, limit) {
		/** @type {Set<string>} */
		const seen = new Set();
		/** @type {{ rank: number, title: string, url: string, snippet: string }[]} */
		const out = [];
		for (const f of found) {
			if (out.length >= limit) break;
			const key = f.url.split("#")[0].replace(/\/$/, "");
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ rank: out.length + 1, title: f.title, url: f.url, snippet: f.snippet });
		}
		return out;
	}

	/** @param {unknown} options */
	function search(options) {
		const t0 = performance.now();
		const o = /** @type {Record<string, unknown>} */ (typeof options === "object" && options !== null ? options : {});
		const limit = intOpt(o.limit, 10, 1, CAP.results);
		const hint = typeof o.hint === "number" && Number.isInteger(o.hint) && o.hint >= 0 && o.hint < HINTS.length ? HINTS[o.hint] : null;
		const extract = /** @type {any} */ (globalThis).__bgwExtract;
		if (typeof extract !== "function" || typeof extract.prepare !== "function") return { ok: false };
		const prepared = extract.prepare(o.maxElements);
		const root = prepared.clone.body;
		const base = document.baseURI;
		const pageSite = siteOf(location.hostname);
		/** @type {Found[]} */
		let generic = [];
		/** @type {Found[]} */
		let hinted = [];
		if (root !== null) {
			generic = detectGeneric(root, base, pageSite);
			if (hint !== null) hinted = detectByHint(root, hint, base, pageSite);
		}
		const general = finish(generic, CAP.results);
		const byHint = finish(hinted, CAP.results);
		// The hint counts when it found a list, and not much less of one than the general look.
		const useHint = byHint.length >= 3 && byHint.length * 10 >= general.length * 6;
		const results = (useHint ? byHint : general).slice(0, limit);
		return {
			ok: true,
			url: location.href,
			title: line(document.title, 300),
			detector: useHint ? "hint" : "generic",
			results,
			hidden_removed: prepared.pruned.removed,
			capped: prepared.pruned.capped,
			stats: { generic: general.length, hint: byHint.length, ms: Math.round(performance.now() - t0) },
		};
	}

	// The decisions that need no page, for the unit tests.
	search.internals = { HINTS, unwrapRedirect, siteOf, hasWord, line, fromBase64, AD_WORDS, NOISE_WORDS, AD_BADGE, SECTION_LABEL, PAGER, URL_LIKE, finish };
	/** @type {any} */ (globalThis).__bgwSearch = search;
})();
