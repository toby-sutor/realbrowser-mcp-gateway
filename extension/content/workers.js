// Takes away the service workers of the page it runs in: every registration of
// the page's own origin is asked to unregister. Injected into the tab of a job
// that has ended, just before the tab is closed (background/jobs.js), and only
// in the gateway container. A worker that stayed would answer later loads of
// its site itself, where the request guard hears no response.
//
// Runs in the isolated world, on the browser's own navigator.serviceWorker:
// nothing the page defined is called. It reads nothing of the page, touches
// nothing in it, and reaches no registration but those of this origin. What it
// hands back is two counts.

(async () => {
	try {
		const container = navigator.serviceWorker;
		// No workers in this kind of document (not a secure context).
		if (container === undefined) return { ok: true, found: 0, removed: 0 };
		const registrations = await container.getRegistrations();
		let removed = 0;
		for (const registration of registrations) {
			try {
				if (await registration.unregister()) removed += 1;
			} catch {
				// that one stays
			}
		}
		return { ok: true, found: registrations.length, removed };
	} catch {
		return { ok: false, found: 0, removed: 0 };
	}
})();
