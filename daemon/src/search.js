import { checkUrl } from "../../extension/shared/policy.js";
import { LIMITS as WIRE } from "../../extension/shared/protocol.js";

/**
 * Web search through the browser: which results page to load for a query.
 *
 * An engine is a URL template with one placeholder, "{q}", in its query
 * string. A search fills in the caller's query, percent-encoded, and nothing
 * else: scheme, host, path and every other parameter are the template's. The
 * resulting URL is a job URL like any other - same policy, same pacing, same
 * cooldowns, same handling of human checks - and is always loaded in the
 * gateway container, never with the operator's login.
 *
 * The built-in templates are the engines' public search addresses as they
 * are commonly written. Nothing here was tried against a live engine.
 */

export const WEB_SEARCH_LIMITS = Object.freeze({
	maxQueryChars: 400,
	defaultResults: 10,
	maxResults: WIRE.MAX_RESULTS,
	maxEngines: 16,
	maxTemplateChars: 512,
	// What a result with too few recognised results carries of the page itself.
	fallbackTextChars: 12000,
	fallbackLinks: 60,
});

export const DEFAULT_ENGINE = "duckduckgo";

/** @type {Readonly<Record<string, string>>} */
export const BUILTIN_ENGINES = Object.freeze({
	duckduckgo: "https://html.duckduckgo.com/html/?q={q}",
	brave: "https://search.brave.com/search?q={q}",
	bing: "https://www.bing.com/search?q={q}",
	google: "https://www.google.com/search?q={q}",
	startpage: "https://www.startpage.com/sp/search?query={q}",
});

const PLACEHOLDER = "{q}";
export const ENGINE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Check a template. The placeholder stands exactly once, as the whole value
 * of one parameter of the query string; with a sample query filled in, the
 * URL passes the gateway's URL policy.
 * @param {unknown} template
 * @param {{ blocklist?: readonly string[], allowLoopbackPorts?: readonly number[] }} [policy]
 * @returns {string | null} what is wrong with it, or null
 */
export function templateProblem(template, policy = {}) {
	if (typeof template !== "string" || template === "" || template.length > WEB_SEARCH_LIMITS.maxTemplateChars) return `must be a string of at most ${WEB_SEARCH_LIMITS.maxTemplateChars} characters`;
	if (/[\u0000- \u007f-\uffff]/.test(template)) return "must be plain ASCII without spaces";
	if (template.split(PLACEHOLDER).length !== 2) return "must contain {q} exactly once";
	if (template.includes("#")) return "must not contain #";
	const at = template.indexOf(PLACEHOLDER);
	const query = template.indexOf("?");
	// As the value of a parameter: "name={q}", closed by "&" or the end.
	if (query === -1 || at < query || !/[?&][A-Za-z0-9_.~-]{1,40}=$/.test(template.slice(0, at)) || !/^(&|$)/.test(template.slice(at + PLACEHOLDER.length))) {
		return "must have {q} as the value of one query parameter, as in https://search.example/find?q={q}";
	}
	if (/[{}]/.test(template.replace(PLACEHOLDER, ""))) return "must not contain other braces";
	const verdict = checkUrl(template.replace(PLACEHOLDER, "sample"), policy);
	if (!verdict.allowed) return `is not a URL the gateway may load (${verdict.reason})`;
	return null;
}

/**
 * The results page for a query.
 * @param {string} template a checked template
 * @param {string} query
 * @returns {string | null} null when the URL would not be the template's with the query in it
 */
export function buildSearchUrl(template, query) {
	if (typeof query !== "string" || query === "" || query.length > WEB_SEARCH_LIMITS.maxQueryChars) return null;
	/** @type {string} */
	let encoded;
	try {
		// Spaces as "+", the way a search form sends them; everything else that is not plain is percent-encoded.
		encoded = encodeURIComponent(query).replace(/%20/g, "+").replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	} catch {
		// A lone surrogate: no text an engine could be asked for.
		return null;
	}
	const url = template.replace(PLACEHOLDER, () => encoded);
	// Whatever the query was, it changed nothing but its own parameter.
	try {
		const made = new URL(url);
		const base = new URL(template.replace(PLACEHOLDER, "x"));
		if (made.origin !== base.origin || made.pathname !== base.pathname || made.hash !== "" || made.username !== "" || made.password !== "") return null;
		if ([...made.searchParams.keys()].join("&") !== [...base.searchParams.keys()].join("&")) return null;
	} catch {
		return null;
	}
	return url;
}

/**
 * The engines of this daemon: the built-in ones and the operator's own.
 * @param {Readonly<Record<string, string>>} [custom] checked templates from config.json; one may replace a built-in name
 * @param {string} [fallback] the engine of a search that names none
 * @returns {{ names: string[], fallback: string, template: (name: string) => string | null }}
 */
export function makeEngines(custom = {}, fallback = DEFAULT_ENGINE) {
	/** @type {Map<string, string>} */
	const all = new Map(Object.entries(BUILTIN_ENGINES));
	for (const [name, template] of Object.entries(custom)) all.set(name, template);
	return {
		names: [...all.keys()],
		fallback: all.has(fallback) ? fallback : DEFAULT_ENGINE,
		template: (name) => all.get(name) ?? null,
	};
}
