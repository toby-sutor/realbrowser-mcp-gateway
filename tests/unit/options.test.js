// The options page (extension/options/options.js) and a list of login rules
// that did not pass its check: what the page shows, and what it writes when
// its buttons are pressed. The page's script runs here against a stand-in for
// the document, for storage.local and for the page's own IndexedDB; the real
// page in a real browser is covered by tests/integration/optin.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { OPTIN_SHADOW_KEY, OPTIN_STORAGE_KEY, packOptInRules, serializeOptInRules } from "../../extension/shared/optin.js";

const A = Object.freeze({ host: "forum.example.com", pathPrefix: "/board", subdomains: false });
const B = Object.freeze({ host: "example.org", pathPrefix: "/", subdomains: true });
const FORGED = Object.freeze({ host: "bank.example.com", pathPrefix: "/", subdomains: true });

/** One element, as much of it as the page's script uses. */
class FakeElement {
	/** @param {string} id */
	constructor(id = "") {
		this.id = id;
		this.className = "";
		this.hidden = false;
		this.value = "";
		this.checked = false;
		this.type = "";
		/** @type {FakeElement[]} */
		this.children = [];
		/** @type {Record<string, (() => unknown)[]>} */
		this.listeners = {};
		this.text = "";
	}
	/** @returns {string} */
	get textContent() {
		return this.text + this.children.map((/** @type {FakeElement} */ c) => c.textContent).join("");
	}
	/** @param {string} value */
	set textContent(value) {
		this.text = String(value);
		this.children = [];
	}
	/** @param {string} kind @param {() => unknown} fn */
	addEventListener(kind, fn) {
		(this.listeners[kind] ??= []).push(fn);
	}
	/** @param {FakeElement[]} nodes */
	append(...nodes) {
		this.children.push(...nodes);
	}
	/** @param {string} id @returns {FakeElement | null} */
	find(id) {
		if (this.id === id) return this;
		for (const child of this.children) {
			const found = child.find(id);
			if (found !== null) return found;
		}
		return null;
	}
}

let instance = 0;

/**
 * Load the page's script into a world of its own.
 * @param {{ stored?: unknown, shadow?: string | null }} world what lies in storage.local and in the page's own storage
 */
async function openPage(world) {
	/** @type {Map<string, FakeElement>} the elements of options.html, made when first asked for */
	const fixed = new Map();
	/** @type {{ stored: unknown, shadow: string | null, writes: string[] }} */
	const state = { stored: world.stored, shadow: world.shadow ?? null, writes: [] };
	const document = {
		/** @param {string} id */
		getElementById(id) {
			for (const el of fixed.values()) {
				const found = el.find(id);
				if (found !== null) return found;
			}
			const el = new FakeElement(id);
			fixed.set(id, el);
			return el;
		},
		createElement: () => new FakeElement(),
	};
	const browser = {
		runtime: { sendMessage: async () => null },
		storage: {
			local: {
				get: async () => (state.stored === undefined ? {} : { [OPTIN_STORAGE_KEY]: state.stored }),
				set: async (/** @type {Record<string, unknown>} */ items) => {
					state.stored = items[OPTIN_STORAGE_KEY];
					state.writes.push("storage.set");
				},
				remove: async () => {
					state.stored = undefined;
					state.writes.push("storage.remove");
				},
			},
			onChanged: { addListener: () => {} },
		},
	};
	// The page's own storage: one value under one key, handed out the way IndexedDB does - by events.
	const indexedDB = {
		open() {
			const tx = () => {
				/** @type {{ oncomplete: null | (() => void) }} */
				const t = { oncomplete: null };
				const done = (/** @type {unknown} */ result) => {
					queueMicrotask(() => t.oncomplete?.());
					return { result };
				};
				return Object.assign(t, {
					objectStore: () => ({
						get: (/** @type {string} */ key) => done(key === OPTIN_SHADOW_KEY && state.shadow !== null ? state.shadow : undefined),
						put: (/** @type {string} */ value, /** @type {string} */ key) => {
							if (key === OPTIN_SHADOW_KEY) state.shadow = value;
							state.writes.push("own.put");
							return done(undefined);
						},
						delete: (/** @type {string} */ key) => {
							if (key === OPTIN_SHADOW_KEY) state.shadow = null;
							state.writes.push("own.delete");
							return done(undefined);
						},
					}),
				});
			};
			/** @type {{ result: unknown, onsuccess: null | (() => void) }} */
			const request = { result: { objectStoreNames: { contains: () => true }, transaction: tx, close: () => {} }, onsuccess: null };
			queueMicrotask(() => request.onsuccess?.());
			return request;
		},
	};
	const g = /** @type {any} */ (globalThis);
	const before = { document: g.document, browser: g.browser, indexedDB: g.indexedDB, setInterval: g.setInterval };
	Object.assign(g, { document, browser, indexedDB, setInterval: () => 0 });
	instance += 1;
	await import(`../../extension/options/options.js?page=${instance}`);
	g.setInterval = before.setInterval;
	/** @param {string} id */
	const el = (id) => document.getElementById(id);
	/** Let the page finish what a click or its start set going. */
	const settle = async () => {
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	};
	await settle();
	return {
		state,
		el,
		settle,
		/** @param {string} id */
		click: async (id) => {
			for (const fn of el(id).listeners.click ?? []) fn();
			await settle();
		},
		/** @returns {string[]} the rules the list shows, one line each */
		shown: () => el("optin-list").children.map((item) => item.children[0].textContent),
		/** @param {string} id @returns {boolean} whether the operator can see and press it */
		offered: (id) => !el(id).hidden && !el("optin-trouble").hidden,
		close: () => Object.assign(g, { document: before.document, browser: before.browser, indexedDB: before.indexedDB }),
	};
}

test("the options page: with both copies in agreement the rules are in force and nothing is offered", async () => {
	const page = await openPage({ stored: packOptInRules([A, B]), shadow: serializeOptInRules([A, B]) });
	try {
		assert.equal(page.el("optin-state").textContent, "2 rules are in force.");
		assert.deepEqual(page.shown(), ["https://forum.example.com/board", "https://example.org/  (and every subdomain of example.org)"]);
		assert.equal(page.offered("optin-restore"), false);
		assert.equal(page.offered("optin-clear"), false);
		assert.deepEqual(page.state.writes, []);
	} finally {
		page.close();
	}
});

test("the options page: storage.local was changed - the list last saved here is shown and can be put back, without what was added", async () => {
	const page = await openPage({ stored: packOptInRules([A, FORGED]), shadow: serializeOptInRules([A]) });
	try {
		assert.match(page.el("optin-state").textContent, /no rule is in force\. This is the list as it was last saved on this page/);
		assert.deepEqual(page.shown(), ["https://forum.example.com/board"]);
		assert.equal(page.offered("optin-restore"), true);
		assert.equal(page.offered("optin-clear"), true);
		await page.click("optin-restore");
		assert.equal(page.el("optin-result").textContent, "The rules shown are in force.");
		assert.deepEqual(page.state.stored, packOptInRules([A]));
		assert.equal(page.state.shadow, serializeOptInRules([A]));
		assert.equal(page.el("optin-state").textContent, "1 rule is in force.");
		assert.equal(page.offered("optin-restore"), false);
	} finally {
		page.close();
	}
});

test("the options page: rules that stand in storage.local alone are shown, never offered and never written back", async () => {
	// The page's own copy is gone, or was never there: anything in the extension could have put this list
	// into storage.local. One click must not make it the operator's.
	for (const shadow of [null, "", "not json", JSON.stringify({ v: 1, rules: [] }), JSON.stringify({ v: 2, rules: [A] }), JSON.stringify({ v: 1, rules: [{ host: "com", pathPrefix: "/", subdomains: true }] })]) {
		const page = await openPage({ stored: packOptInRules([A, FORGED]), shadow });
		try {
			const said = page.el("optin-state").textContent;
			assert.match(said, /no rule is in force/, String(shadow));
			assert.match(said, /may hold rules you never set and cannot be put in force\. Remove all rules, then add again the ones you want\./, String(shadow));
			assert.deepEqual(page.shown(), ["https://forum.example.com/board", "https://bank.example.com/  (and every subdomain of bank.example.com)"]);
			assert.equal(page.offered("optin-restore"), false, String(shadow));
			assert.equal(page.offered("optin-clear"), true, String(shadow));
			// The button is not shown. Pressed all the same - by a script, by a page that kept an old state - it writes nothing.
			await page.click("optin-restore");
			assert.deepEqual(page.state.writes, [], String(shadow));
			assert.deepEqual(page.state.stored, packOptInRules([A, FORGED]));
			assert.equal(page.state.shadow, shadow);
			assert.match(page.el("optin-result").textContent, /^Nothing was put in force/);
			// Nothing can be added on top of it either.
			page.el("optin-host").value = "late.example.com";
			page.el("optin-path").value = "/";
			await page.click("optin-add");
			assert.equal(page.el("optin-result").textContent, "Deal with the stored list above first.");
			assert.deepEqual(page.state.writes, []);
			// What is left to do: remove everything, in both places.
			await page.click("optin-clear");
			assert.equal(page.el("optin-result").textContent, "All rules were removed.");
			assert.deepEqual([page.state.stored, page.state.shadow], [undefined, null]);
			assert.match(page.el("optin-state").textContent, /^No rule is set\./);
			assert.deepEqual(page.shown(), []);
			assert.equal(page.offered("optin-clear"), false);
		} finally {
			page.close();
		}
	}
});

test("the options page: the list changed after it was shown - the button puts nothing in force that was not read", async () => {
	const page = await openPage({ stored: packOptInRules([A, FORGED]), shadow: serializeOptInRules([A]) });
	try {
		assert.deepEqual(page.shown(), ["https://forum.example.com/board"]);
		// Another tab of the options page saved a different list in the meantime.
		page.state.shadow = serializeOptInRules([A, B]);
		await page.click("optin-restore");
		assert.match(page.el("optin-result").textContent, /^Nothing was put in force/);
		assert.deepEqual(page.state.writes, []);
		assert.deepEqual(page.shown(), ["https://forum.example.com/board", "https://example.org/  (and every subdomain of example.org)"]);
		// Read again, it can be put in force.
		await page.click("optin-restore");
		assert.deepEqual(page.state.stored, packOptInRules([A, B]));
		assert.equal(page.el("optin-state").textContent, "2 rules are in force.");
	} finally {
		page.close();
	}
});

test("the options page: the own copy holds rules and storage.local nothing - what was saved here can be put back", async () => {
	const page = await openPage({ stored: undefined, shadow: serializeOptInRules([A]) });
	try {
		assert.deepEqual(page.shown(), ["https://forum.example.com/board"]);
		assert.equal(page.offered("optin-restore"), true);
		await page.click("optin-restore");
		assert.deepEqual(page.state.stored, packOptInRules([A]));
		assert.deepEqual(page.state.writes, ["own.put", "storage.set"]);
	} finally {
		page.close();
	}
	// Neither copy can be read: nothing to show, nothing to offer but removing it.
	const junk = await openPage({ stored: "junk", shadow: "junk" });
	try {
		assert.match(junk.el("optin-state").textContent, /cannot be read, so no rule is in force/);
		assert.deepEqual(junk.shown(), []);
		assert.equal(junk.offered("optin-restore"), false);
		assert.equal(junk.offered("optin-clear"), true);
		assert.equal(OPTIN_SHADOW_KEY, OPTIN_STORAGE_KEY);
	} finally {
		junk.close();
	}
});
