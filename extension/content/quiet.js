// Injected into a job tab by the background page (tabs.executeScript), twice,
// for a tab that is hidden: once to start watching (end false), once to read
// what was seen (end true). The waiting in between is done by the background
// page with timers of its own, which are not throttled. Nothing here uses a
// timer: a hidden document runs its own about once a second.
//
// What is watched: DOM mutations (a MutationObserver delivers in microtasks,
// not on a timer) and animation frames, counted only. Nothing on the page is
// touched, scrolled or clicked.
//
// The value of the last expression is what executeScript hands back.
(() => {
	const scope = /** @type {{ __bgwQuietArgs?: unknown, __bgwQuiet?: any }} */ (globalThis);
	// Only what was put on the global of this world itself. Behind that global stands the page's window, where a
	// frame is found under the name the page gave it: a frame with one of these names is not what was put here.
	const raw = Object.hasOwn(scope, "__bgwQuietArgs") ? scope.__bgwQuietArgs : undefined;
	delete scope.__bgwQuietArgs;
	const end = typeof raw === "object" && raw !== null && /** @type {{ end?: unknown }} */ (raw).end === true;
	const kept = Object.hasOwn(scope, "__bgwQuiet") ? scope.__bgwQuiet : undefined;
	delete scope.__bgwQuiet;
	const old = typeof kept === "object" && kept !== null && typeof kept.mutations === "number" && typeof kept.frames === "number" && typeof kept.t0 === "number" ? kept : undefined;
	if (old !== undefined) {
		old.on = false;
		if (typeof old.observer === "object" && old.observer !== null && typeof old.observer.disconnect === "function") old.observer.disconnect();
	}
	if (end) {
		// A document that was replaced between the two calls has no state: the answer is "do not know".
		if (old === undefined) return { ok: true, phase: "end", known: false, mutations: 0, frames: 0, ms: 0, visibility: document.visibilityState === "hidden" ? "hidden" : "visible" };
		return {
			ok: true,
			phase: "end",
			known: true,
			mutations: old.mutations,
			frames: old.frames,
			ms: Math.round(performance.now() - old.t0),
			visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
		};
	}
	const state = { on: true, mutations: 0, frames: 0, t0: performance.now(), observer: /** @type {MutationObserver | null} */ (null) };
	const onFrame = () => {
		state.frames += 1;
		if (state.on) requestAnimationFrame(onFrame);
	};
	requestAnimationFrame(onFrame);
	state.observer = new MutationObserver((list) => {
		state.mutations += list.length;
	});
	if (document.documentElement) state.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
	scope.__bgwQuiet = state;
	return { ok: true, phase: "begin", known: true, mutations: 0, frames: 0, ms: 0, visibility: document.visibilityState === "hidden" ? "hidden" : "visible" };
})();
