// The first script of the background page, and the only one that is no
// module: it runs the moment the page is read, before the modules of the
// extension are loaded. That loading takes a tenth of a second and more
// (measured in Firefox 156: 137 to 310 ms, 1.3 s on a cold start), and it is
// time in which a page the browser brought back in the gateway container
// asks for what it likes. So the one listener of the gate at the start
// (startgate.js) is registered here, at once, and does the only thing that
// needs no knowledge: a request of no container passes, a request of a
// container waits. The gate takes the listener over when its module is
// there, and answers what has waited.
//
// Nothing is decided in this file. Should the gate never come - the modules
// do not load - the requests of containers are let go after a while: this
// extension is not running then, and holds nobody's requests.

"use strict";

(() => {
	// How long requests of a container wait for the gate before they are let go.
	const GIVE_UP_MS = 15000;
	/** @type {{ details: unknown, answer: (value: unknown) => void }[]} */
	const waiting = [];
	/** @type {((details: unknown) => unknown) | null} the gate, once it is there */
	let gate = null;
	let gaveUp = false;

	/** @param {{ cookieStoreId?: unknown }} details */
	const listener = (details) => {
		if (gate !== null) return gate(details);
		const store = details.cookieStoreId;
		// Not a container's: the operator's own. No objection, and nothing of it is looked at.
		if (gaveUp || typeof store !== "string" || !/^firefox-container-[0-9]+$/.test(store)) return {};
		return new Promise((resolve) => {
			waiting.push({ details, answer: resolve });
		});
	};
	browser.webRequest.onBeforeRequest.addListener(/** @type {any} */ (listener), { urls: ["<all_urls>"] }, ["blocking"]);

	const timer = setTimeout(() => {
		gaveUp = true;
		for (const w of waiting.splice(0)) w.answer({});
	}, GIVE_UP_MS);

	/** @type {any} */ (globalThis).bgwGateFront = {
		// The function the browser knows: what the gate removes when it goes.
		listener,
		// When it was registered: on the clock of the day, and in milliseconds since the page began to load.
		since: Date.now(),
		pageMs: Math.round(performance.now()),
		/**
		 * The gate is there: from now on it answers, beginning with what has waited.
		 * @param {(details: unknown) => unknown} decide
		 */
		take(decide) {
			if (gate !== null) return;
			gate = decide;
			clearTimeout(timer);
			for (const w of waiting.splice(0)) {
				Promise.resolve()
					.then(() => decide(w.details))
					.then(w.answer, () => w.answer({}));
			}
		},
	};
})();
