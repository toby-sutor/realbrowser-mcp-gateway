// Injected into a job tab by the background page (tabs.executeScript). Waits
// until the DOM has been quiet for a while and measures how the page is being
// rendered.
//
// When asked to (wait.scroll "lazy", and only for a tab in the gateway
// container) it also walks down the page once and returns to the top, so that
// what a page loads or reveals when it is scrolled to is there to be read. The
// walk is bounded in steps and in time, its steps and pauses vary, and it is
// the browser's own scrolling of the window. That is all this script ever does
// to a page: no clicks, no typing, no focus changes, no synthetic events.
//
// A page that gets longer as it is walked down (a feed that loads more) is
// followed further, when asked to: for as long as it keeps growing, within
// wider bounds of its own - a longer time, more steps, a depth in pixels.
// "Keeps growing" means that it got longer a moment ago; a page that grew once
// and then no more falls back to the ordinary bounds. A page that does not
// grow is walked exactly as before and costs no extra time: whether it grew is
// seen at the steps of the walk and during the quiet check that follows the
// walk anyway.
//
// Progress is driven by timers and timestamps, never by animation frames:
// frames are only counted, over a time-bounded window.
//
// A hidden document (a gateway window on another virtual desktop or minimised)
// is not waited for here: its timers fire about once a second and it gets
// almost no frames, so every timer hop costs a second. The script looks at the
// visibility when it starts and before every timer hop it makes; the moment the
// document is hidden it puts the page back at its top and answers at once with
// visibility "hidden" and bailed true. The background page then does the rest
// of the waiting with timers of its own, which are not throttled (content/quiet.js).
//
// The value of the last expression is what executeScript hands back.
(() => {
	const scope = /** @type {{ __bgwSettle?: unknown }} */ (globalThis);
	// Only what was put on the global of this world itself: behind it stands the page's window, where a frame is
	// found under the name the page gave it.
	const raw = Object.hasOwn(scope, "__bgwSettle") ? scope.__bgwSettle : undefined;
	delete scope.__bgwSettle;
	if (typeof raw !== "object" || raw === null) return { ok: false, error: "no_args" };
	const args = /** @type {Record<string, unknown>} */ (raw);

	/**
	 * @param {unknown} v
	 * @param {number} lo
	 * @param {number} hi
	 * @param {number} fallback
	 */
	const num = (v, lo, hi, fallback) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : fallback);
	const quietMs = num(args.quietMs, 0, 30000, 1500);
	const capMs = num(args.capMs, 0, 120000, 7500);
	// Never run past this: the job's remaining time.
	const budgetMs = num(args.budgetMs, 0, 3600000, capMs);
	// Shortest time to count frames over, so a page that is quiet at once still yields a rate.
	const probeMs = Math.min(num(args.probeMs, 0, 2000, 250), budgetMs);
	// The walk down the page: off unless asked for, and bounded both ways.
	const walkSteps = args.scroll === true ? Math.floor(num(args.scrollSteps, 0, 200, 24)) : 0;
	const walkMs = num(args.scrollMs, 0, 60000, 6000);
	// The wider bounds for a page that grows under the walk. growMs 0, the default: such a page is not followed.
	const growMs = walkSteps > 0 ? num(args.growMs, 0, 120000, 0) : 0;
	const growSteps = Math.max(Math.floor(num(args.growSteps, 0, 1000, 120)), walkSteps);
	const growMaxPx = num(args.growMaxPx, 0, 10000000, 60000);
	// How long a growing page gets, at its end, to grow again.
	const growWaitMs = num(args.growWaitMs, 0, 10000, 2500);
	// Less than this is a layout that shifted, not content that was added.
	const GROW_MIN_PX = 200;
	// A page counts as growing for this long after it last got longer: long enough to walk through what a feed
	// loads in one go, short enough that a page which grew once is not taken for one that keeps growing.
	const growRecentMs = num(args.growRecentMs, 0, 60000, 8000);
	// How long after the walk a page gets to react to it, at least.
	const afterWalkMs = Math.min(quietMs, 300);
	// Longest pause after one step of the walk, when no frame comes by.
	const STEP_WAIT_MS = 1500;

	return new Promise((resolve) => {
		const t0 = performance.now();
		const isHidden = () => document.visibilityState === "hidden";
		if (isHidden()) {
			// Not one timer, not one frame: nothing of this script is left running.
			resolve({ ok: true, settled: false, waitedMs: 0, mutations: 0, visibility: "hidden", bailed: true, rafHz: 0, scrolledPx: 0, scrollSteps: 0, walkMs: 0, grew: false });
			return;
		}
		let lastChange = t0;
		let mutations = 0;
		let frames = 0;
		let counting = true;
		/** @type {"due" | "walking" | "done"} */
		let walk = walkSteps > 0 ? "due" : "done";
		let steps = 0;
		let scrolledPx = 0;
		/** Time the walk took: it has a bound of its own and does not count against the cap. */
		let walkSpent = 0;
		let walkEndedAt = t0;
		/** When the walk first set off: its bounds in time count from here, pauses between its stretches included. */
		let walkBegan = t0;
		/** When the page last got longer under the walk; 0: it never did. */
		let grewAt = 0;
		/** The walk ran into one of its bounds: it is not taken up again. */
		let over = false;
		/** Where the page ended when the walk last looked, and where the walk stood when it last stopped. */
		let endBottom = 0;
		let reached = 0;
		/** Since when the walk waits at the end of a page that grew before; 0: it does not. */
		let endSince = 0;
		const onFrame = () => {
			frames += 1;
			if (counting) requestAnimationFrame(onFrame);
		};
		requestAnimationFrame(onFrame);

		const observer = new MutationObserver((list) => {
			mutations += list.length;
			lastChange = performance.now();
		});
		if (document.documentElement) {
			observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
		}

		/** @param {number} top */
		const jump = (top) => window.scrollTo({ top, left: window.scrollX, behavior: "instant" });

		/**
		 * The document went out of sight: back to the top, and hand over.
		 * @returns {true} for the caller to return
		 */
		const bail = () => {
			if (steps > 0) jump(0);
			counting = false;
			observer.disconnect();
			const elapsed = performance.now() - t0;
			resolve({
				ok: true,
				settled: false,
				waitedMs: Math.round(elapsed),
				mutations,
				visibility: "hidden",
				bailed: true,
				rafHz: elapsed > 0 ? Math.round((frames / elapsed) * 10000) / 10 : 0,
				scrolledPx,
				scrollSteps: steps,
				walkMs: Math.round(walkSpent),
				grew: grewAt > 0,
			});
			return true;
		};

		/**
		 * This stretch of the walk is over: back to the top, and on to the quiet check.
		 * @param {number} startedAt when the stretch began
		 * @param {boolean} final a bound was reached: the walk is not taken up again
		 */
		const endWalk = (startedAt, final) => {
			reached = window.scrollY;
			if (steps > 0) jump(0);
			walk = "done";
			over = over || final;
			endSince = 0;
			walkEndedAt = performance.now();
			walkSpent += walkEndedAt - startedAt;
			setTimeout(check, 50);
		};

		/**
		 * One step down, then a pause in which the page may load what came into
		 * view. Ends at the bottom, after the last step allowed, or when its time
		 * is up - whichever comes first - and goes back to the top. A page that
		 * keeps growing has wider bounds, and a moment at every new end to grow
		 * again.
		 * @param {number} startedAt when this stretch of the walk began
		 */
		const step = (startedAt) => {
			if (isHidden()) return bail();
			const now = performance.now();
			const root = document.scrollingElement;
			if (root === null) return endWalk(startedAt, true);
			const bottom = root.scrollHeight - window.innerHeight;
			// The page ends further down than a step ago: something was added to it. Feeds do that at their end, or
			// some screens before it.
			if (growMs > 0 && steps > 0 && bottom >= endBottom + GROW_MIN_PX) grewAt = now;
			endBottom = bottom;
			const growing = grewAt > 0 && now - grewAt <= growRecentMs;
			const walked = now - walkBegan;
			const ordinary = steps < walkSteps && walked < Math.min(walkMs, budgetMs * 0.4);
			const wider = growing && steps < growSteps && walked < Math.min(growMs, budgetMs * 0.6) && window.scrollY < growMaxPx;
			if (!(ordinary || wider) || now - t0 >= budgetMs) return endWalk(startedAt, true);
			if (window.scrollY >= bottom - 1) {
				if (!growing) return endWalk(startedAt, false);
				if (endSince === 0) endSince = now;
				if (now - endSince >= growWaitMs) return endWalk(startedAt, false);
				setTimeout(() => step(startedAt), 100);
				return;
			}
			endSince = 0;
			// Most of a screen, and never the same step twice.
			jump(Math.min(window.scrollY + Math.max(50, Math.round(window.innerHeight * (0.6 + Math.random() * 0.35))), bottom));
			steps += 1;
			scrolledPx = Math.max(scrolledPx, Math.round(window.scrollY));
			// What a page loads when something comes into view it decides when it is
			// next drawn. A window that is out of sight is drawn about once a second:
			// the pause lasts until a frame came by, within limits.
			const jumpedAt = performance.now();
			const drawn = frames;
			const rest = () => {
				if (isHidden()) return bail();
				if (frames !== drawn || performance.now() - jumpedAt >= STEP_WAIT_MS) step(startedAt);
				else setTimeout(rest, 100);
			};
			setTimeout(rest, 120 + Math.random() * 160);
		};

		const check = () => {
			if (isHidden()) return bail();
			const now = performance.now();
			const elapsed = now - t0;
			if (growMs > 0 && walk === "done" && steps > 0 && !over) {
				// The walk ended where the page ended, and the page ends further down now: what it began to load
				// when its end came into view has arrived. The walk is taken up where it stood.
				const root = document.scrollingElement;
				if (root !== null && root.scrollHeight - window.innerHeight >= endBottom + GROW_MIN_PX) {
					grewAt = now;
					walk = "walking";
					jump(reached);
					step(now);
					return;
				}
			}
			const quiet = now - lastChange >= quietMs && (steps === 0 || now - walkEndedAt >= afterWalkMs);
			const capped = elapsed - walkSpent >= Math.min(capMs, budgetMs) || elapsed >= budgetMs;
			if ((quiet || capped) && elapsed >= probeMs) {
				if (walk === "due") {
					walk = "walking";
					walkBegan = now;
					step(now);
					return;
				}
				counting = false;
				observer.disconnect();
				resolve({
					ok: true,
					settled: quiet,
					waitedMs: Math.round(elapsed),
					mutations,
					visibility: "visible",
					rafHz: elapsed > 0 ? Math.round((frames / elapsed) * 10000) / 10 : 0,
					scrolledPx,
					scrollSteps: steps,
					walkMs: Math.round(walkSpent),
					grew: grewAt > 0,
				});
				return;
			}
			setTimeout(check, 100);
		};
		setTimeout(check, Math.min(100, probeMs));
	});
})();
