// Test control channel. Loaded only when dev-config.json names a hookPort, and
// that file exists only in the temp copy of the extension that the
// integration harness builds. tools/build-xpi.sh leaves this module out of the
// release XPI altogether.
//
// The harness listens on 127.0.0.1:<hookPort>; this side dials out and answers
// { id, cmd, args } with { id, ok, result | error }.

/**
 * @typedef {object} HookDeps
 * @property {number} port
 * @property {import("./main.js").App} app
 * @property {() => import("./main.js").PublicStatus} publicStatus
 * @property {(paused: boolean, reason?: "operator" | "window_closed") => Promise<void>} setPause
 * @property {{ t: number, event: string, fields: Record<string, string | number | boolean | null> }[]} recentLog
 * @property {(job: string) => Promise<boolean>} openChallenge what a click of the operator on a pending challenge does
 */

import { parseOptInRules } from "../shared/policy.js";
import { OPTIN_SHADOW_KEY, OPTIN_STORAGE_KEY, packOptInRules, serializeOptInRules } from "../shared/optin.js";
import { PAIRING_SLOT, ownGet, ownRemove, ownSet } from "../shared/ownstore.js";

const ROLE_KEY = "bgw_role";

/** @param {HookDeps} deps */
export function startDevHook(deps) {
	const { app } = deps;

	/** @type {Record<string, (args: Record<string, unknown>) => Promise<unknown>>} */
	const commands = {
		status: async () => deps.publicStatus(),
		badge: async () => ({ text: await browser.browserAction.getBadgeText({}), title: await browser.browserAction.getTitle({}) }),
		logs: async () => deps.recentLog.slice(-200),
		pair: async (args) => app.link.pair(args.code),
		reconnect: async () => {
			await app.link.reconnect();
			return true;
		},
		pause: async () => {
			await deps.setPause(true);
			return deps.publicStatus();
		},
		resume: async () => {
			await deps.setPause(false);
			return deps.publicStatus();
		},
		sweep: async () => app.win.adoptOrSweep(),
		"container.clear": async () => app.container.clear(),
		// Every window and tab the browser has, with the roles the gateway gave them.
		windows: async () => {
			const own = app.win.snapshot();
			const windows = [];
			for (const w of await browser.windows.getAll({ populate: true })) {
				if (w.id === undefined) continue;
				const tabs = [];
				for (const t of w.tabs ?? []) {
					if (t.id === undefined) continue;
					tabs.push({
						id: t.id,
						url: t.url ?? null,
						title: t.title ?? null,
						status: t.status ?? null,
						active: t.active,
						muted: t.mutedInfo?.muted === true,
						cookieStoreId: t.cookieStoreId ?? null,
						role: (await browser.sessions.getTabValue(t.id, ROLE_KEY).catch(() => null)) ?? null,
					});
				}
				windows.push({
					id: w.id,
					type: w.type ?? null,
					focused: w.focused,
					state: w.state ?? null,
					role: (await browser.sessions.getWindowValue(w.id, ROLE_KEY).catch(() => null)) ?? null,
					gateway: w.id === own.windowId,
					tabs,
				});
			}
			return { own, containerId: app.container.cookieStoreId, windows };
		},
		// A window the "operator" opened: the gateway must leave it alone.
		"window.open": async (args) => {
			const w = await browser.windows.create({ url: args.url === "park" ? browser.runtime.getURL("park/park.html") : String(args.url) });
			return { id: w.id ?? null, tabs: (w.tabs ?? []).map((t) => t.id ?? null) };
		},
		"window.close": async (args) => {
			await browser.windows.remove(Number(args.windowId));
			return true;
		},
		// What the operator does to a window from the desktop: minimise it, or bring it back.
		"window.state": async (args) => {
			const w = await browser.windows.update(Number(args.windowId), { state: args.state === "minimized" ? "minimized" : "normal" });
			return { state: w.state ?? null };
		},
		// cookieStoreId: a tab the "operator" opens in a container of their choosing - the gateway's own, for one.
		// Without a windowId the browser chooses the window, as it does for an add-on that names none. In the
		// background unless "active" says otherwise: a tab in front runs its timers at full speed.
		"tab.open": async (args) => {
			const t = await browser.tabs.create({ ...(args.windowId === undefined ? {} : { windowId: Number(args.windowId) }), url: String(args.url), active: args.active === true, ...(typeof args.cookieStoreId === "string" ? { cookieStoreId: args.cookieStoreId } : {}) });
			return { id: t.id ?? null, windowId: t.windowId ?? null };
		},
		// What the browser says of the document in the top frame of a tab: its address, and whether the load that led
		// to it failed (its own error page stands there then).
		"tab.frame": async (args) => {
			const frame = await browser.webNavigation.getFrame({ tabId: Number(args.tabId), frameId: 0 });
			return frame === null ? null : { url: frame.url, errorOccurred: frame.errorOccurred === true };
		},
		// Make a window or tab look like one the gateway left behind in an earlier session.
		"window.tag": async (args) => {
			await browser.sessions.setWindowValue(Number(args.windowId), ROLE_KEY, String(args.role));
			return true;
		},
		"tab.tag": async (args) => {
			await browser.sessions.setTabValue(Number(args.tabId), ROLE_KEY, String(args.role));
			return true;
		},
		"tab.close": async (args) => {
			await browser.tabs.remove(Number(args.tabId));
			return true;
		},
		// A container of the "operator's" own, next to the gateway's.
		"identity.create": async (args) => {
			const made = await browser.contextualIdentities.create({ name: String(args.name), color: "blue", icon: "circle" });
			return { cookieStoreId: made.cookieStoreId, name: made.name };
		},
		"identity.list": async () => (await browser.contextualIdentities.query({})).map((i) => ({ cookieStoreId: i.cookieStoreId, name: i.name })),
		"cookies.set": async (args) => {
			const cookie = await browser.cookies.set({
				url: String(args.url),
				name: String(args.name),
				value: String(args.value),
				storeId: typeof args.storeId === "string" ? args.storeId : "firefox-default",
			});
			return cookie !== null;
		},
		"cookies.get": async (args) => {
			const cookies = await browser.cookies.getAll({
				url: String(args.url),
				storeId: typeof args.storeId === "string" ? args.storeId : "firefox-default",
			});
			return cookies.map((c) => ({ name: c.name, value: c.value }));
		},
		"recently.closed": async () => {
			const closed = await browser.sessions.getRecentlyClosed({ maxResults: 25 });
			return closed.filter((s) => s.tab !== undefined).map((s) => ({ windowId: s.tab?.windowId ?? null, url: s.tab?.url ?? null, cookieStoreId: s.tab?.cookieStoreId ?? null, lastModified: s.lastModified ?? null }));
		},
		// Windows in the recently-closed list, each with the addresses of its tabs.
		"recently.closed.windows": async () => {
			const closed = await browser.sessions.getRecentlyClosed({ maxResults: 25 });
			return closed.filter((s) => s.window !== undefined).map((s) => ({ urls: (s.window?.tabs ?? []).map((t) => t.url ?? null), lastModified: s.lastModified ?? null }));
		},
		// The challenges that wait for the operator, as the job runner lists them.
		pending: async () => app.jobs.pending(),
		// The operator asks for the page of a pending challenge: what a click on the
		// extension's notification or on the popup's button does.
		"challenge.open": async (args) => deps.openChallenge(String(args.job)),
		// The notifications of the extension that are showing, by id.
		"notifications.list": async () => {
			const all = await browser.notifications.getAll();
			return Object.entries(all).map(([id, n]) => ({ id, title: /** @type {{ title?: string }} */ (n).title ?? null, message: /** @type {{ message?: string }} */ (n).message ?? null }));
		},
		"guard.stats": async () => app.guard.stats,
		// The gate of the first moments: whether it still listens, and what it did, in numbers.
		"gate.stats": async () => app.gate.stats,
		// The browser's download list as the downloads API reports it.
		"downloads.list": async () =>
			(await browser.downloads.search({})).map((d) => ({
				id: d.id,
				url: d.url.slice(0, 300),
				filename: d.filename,
				state: d.state,
				exists: d.exists,
				error: d.error ?? null,
				cookieStoreId: d.cookieStoreId ?? null,
				referrer: d.referrer ?? null,
				incognito: d.incognito,
				byExtensionId: d.byExtensionId ?? null,
				mime: d.mime ?? null,
				bytesReceived: d.bytesReceived,
			})),
		// What the operator can do with a download of their own, by its id.
		"downloads.act": async (args) => {
			const id = Number(args.id);
			if (args.action === "cancel") await browser.downloads.cancel(id);
			else if (args.action === "removeFile") await browser.downloads.removeFile(id);
			else if (args.action === "erase") await browser.downloads.erase({ id });
			else throw new Error("unknown action");
			return true;
		},
		// Every request the browser starts during the next "ms" milliseconds, as webRequest describes it.
		"net.watch": async (args) => {
			const ms = Math.min(Math.max(Number(args.ms) || 1000, 0), 15000);
			/** @type {Record<string, unknown>[]} */
			const seen = [];
			/** @param {browser.webRequest._OnBeforeRequestDetails} d */
			const onRequest = (d) => {
				seen.push({ url: d.url.slice(0, 300), tabId: d.tabId, type: d.type, method: d.method, cookieStoreId: d.cookieStoreId ?? null, originUrl: d.originUrl ?? null, documentUrl: d.documentUrl ?? null });
			};
			browser.webRequest.onBeforeRequest.addListener(onRequest, { urls: ["<all_urls>"] });
			await new Promise((resolve) => setTimeout(resolve, ms));
			browser.webRequest.onBeforeRequest.removeListener(onRequest);
			return seen;
		},
	};

	// How long the browser's resolver takes to answer one question "count" times - one after the other, or all at
	// once: what the request guard's lookup before every request costs.
	commands["dns.time"] = async (args) => {
		const host = String(args.host);
		const count = Math.min(Math.max(Number(args.count) || 1, 1), 2000);
		let failed = 0;
		const ask = () =>
			browser.dns.resolve(host).then(
				(record) => {
					if (!Array.isArray(record.addresses) || record.addresses.length === 0) failed += 1;
				},
				() => {
					failed += 1;
				},
			);
		const began = performance.now();
		if (args.together === true) await Promise.all(Array.from({ length: count }, ask));
		else for (let i = 0; i < count; i++) await ask();
		return { ms: performance.now() - began, failed };
	};

	// The response headers the browser goes on with, for every response that begins during the next "ms"
	// milliseconds: what is left of them after every listener of every extension had its say. Looked at, never answered.
	commands["headers.watch"] = async (args) => {
		const ms = Math.min(Math.max(Number(args.ms) || 1000, 0), 15000);
		/** @type {Record<string, unknown>[]} */
		const seen = [];
		/** @param {any} d */
		const onStarted = (d) => {
			/** @param {string} name */
			const value = (name) => (d.responseHeaders ?? []).find((/** @type {{ name: string }} */ h) => h.name.toLowerCase() === name)?.value ?? null;
			/** @param {string} name @returns {string[]} every line of that name, in order */
			const values = (name) => (d.responseHeaders ?? []).filter((/** @type {{ name: string }} */ h) => h.name.toLowerCase() === name).map((/** @type {{ value?: string }} */ h) => h.value ?? "");
			seen.push({ url: String(d.url).slice(0, 300), tabId: d.tabId, type: d.type, status: d.statusCode, fromCache: d.fromCache === true, cookieStoreId: d.cookieStoreId ?? null, contentType: value("content-type"), disposition: value("content-disposition"), nosniff: value("x-content-type-options"), contentTypes: values("content-type"), dispositions: values("content-disposition"), cacheControl: values("cache-control"), validators: [...values("etag"), ...values("last-modified"), ...values("expires"), ...values("pragma")] });
		};
		browser.webRequest.onResponseStarted.addListener(onStarted, { urls: ["<all_urls>"] }, ["responseHeaders"]);
		await new Promise((resolve) => setTimeout(resolve, ms));
		browser.webRequest.onResponseStarted.removeListener(onStarted);
		return seen;
	};

	// What the browser tells an extension about the loads of the next "ms" milliseconds, in the order it tells it:
	// the request events and the navigation events of top frames, by name. Looked at, never answered.
	commands["events.watch"] = async (args) => {
		const ms = Math.min(Math.max(Number(args.ms) || 1000, 0), 15000);
		/** @type {Record<string, unknown>[]} */
		const seen = [];
		/** @type {[{ addListener: Function, removeListener: Function }, Function][]} */
		const listening = [];
		for (const name of /** @type {const} */ (["onBeforeRequest", "onHeadersReceived", "onResponseStarted", "onCompleted", "onErrorOccurred"])) {
			/** @param {any} d */
			const fn = (d) => {
				if (d.type !== "main_frame") return;
				seen.push({ api: "webRequest", event: name, tabId: d.tabId, url: String(d.url).slice(0, 300), requestId: d.requestId, status: d.statusCode ?? null, fromCache: d.fromCache ?? null, error: d.error ?? null });
			};
			browser.webRequest[name].addListener(fn, { urls: ["<all_urls>"] });
			listening.push([browser.webRequest[name], fn]);
		}
		for (const name of /** @type {const} */ (["onBeforeNavigate", "onCommitted", "onCompleted", "onErrorOccurred"])) {
			/** @param {any} d */
			const fn = (d) => {
				if (d.frameId !== 0) return;
				seen.push({ api: "webNavigation", event: name, tabId: d.tabId, url: String(d.url).slice(0, 300), transition: d.transitionType ?? null, qualifiers: d.transitionQualifiers ?? null, error: d.error ?? null });
			};
			browser.webNavigation[name].addListener(fn);
			listening.push([browser.webNavigation[name], fn]);
		}
		await new Promise((resolve) => setTimeout(resolve, ms));
		for (const [event, fn] of listening) event.removeListener(fn);
		return seen;
	};

	// The operator's login rules, set without the options page. This is the test
	// hook: it writes both copies the way the options page does, after the same
	// check. A release build has no such way in - this module is not part of it.
	commands["optin.set"] = async (args) => {
		const dev = app.dev;
		const { rules, rejected } = parseOptInRules(Array.isArray(args.rules) ? args.rules : [], { fixturePorts: dev === null ? [] : dev.allowLoopbackPorts });
		if (rules.length === 0) {
			await ownRemove(OPTIN_SHADOW_KEY);
			await browser.storage.local.remove(OPTIN_STORAGE_KEY);
		} else {
			await ownSet(OPTIN_SHADOW_KEY, serializeOptInRules(rules));
			await browser.storage.local.set({ [OPTIN_STORAGE_KEY]: packOptInRules(rules) });
		}
		await app.optin.load();
		return { rules: app.optin.rules, rejected };
	};
	// What the background page holds, and what lies in the two places it reads.
	commands["optin.get"] = async () => ({
		state: app.optin.state,
		rules: app.optin.rules,
		rev: app.optin.rev,
		hosts: app.optin.hosts(),
		stored: (await browser.storage.local.get([OPTIN_STORAGE_KEY]))[OPTIN_STORAGE_KEY] ?? null,
		shadow: await ownGet(OPTIN_SHADOW_KEY),
	});
	// Somebody who is not the options page writes to storage.local: one of the two
	// copies only, as a script outside the extension's own pages could at most.
	commands["optin.forge"] = async (args) => {
		if (args.value === null) await browser.storage.local.remove(OPTIN_STORAGE_KEY);
		else await browser.storage.local.set({ [OPTIN_STORAGE_KEY]: args.value });
		await app.optin.load();
		await new Promise((resolve) => setTimeout(resolve, 100));
		return { state: app.optin.state, rules: app.optin.rules };
	};
	// The copy in the extension's own page storage is lost or replaced, as when a browser clears it.
	commands["optin.shadow"] = async (args) => {
		if (args.value === null) await ownRemove(OPTIN_SHADOW_KEY);
		else await ownSet(OPTIN_SHADOW_KEY, String(args.value));
		await app.optin.load();
		return { state: app.optin.state, rules: app.optin.rules };
	};
	// Where the pairing key lies - never the key itself. local: something stands under the old name in storage.local;
	// moved: storage.local says the key is kept elsewhere; own: what the extension's own store holds.
	commands["key.where"] = async () => {
		const st = await browser.storage.local.get(["extKey", "keyMoved"]);
		const own = await ownGet(PAIRING_SLOT);
		return { local: "extKey" in st, moved: st.keyMoved === true, own: own === null ? "never" : own === "" ? "none" : "key" };
	};
	// Put both stores into the state an earlier build leaves behind: the key in storage.local, and an own store
	// that has never held it. The background page of this session keeps the key it has in memory.
	commands["key.as-before"] = async () => {
		const own = await ownGet(PAIRING_SLOT);
		if (own === null || own === "") return false;
		await browser.storage.local.set({ extKey: own });
		await browser.storage.local.remove("keyMoved");
		await ownRemove(PAIRING_SLOT);
		return true;
	};
	// Somebody who is not the background page writes a key under the old name, as a script outside the extension's
	// own pages could.
	commands["key.plant"] = async (args) => {
		await browser.storage.local.set({ extKey: String(args.value) });
		return true;
	};
	// Run a piece of script in a tab the way a content script of the extension
	// runs there (its isolated world), and hand back what it evaluates to.
	commands["content.exec"] = async (args) => {
		const [result] = await browser.tabs.executeScript(Number(args.tabId), { code: String(args.code) });
		return result ?? null;
	};
	// Every tab the browser reports as new during the next "ms" milliseconds, and what it says about where it came from.
	commands["tabs.watch"] = async (args) => {
		const ms = Math.min(Math.max(Number(args.ms) || 1000, 0), 15000);
		/** @type {Record<string, unknown>[]} */
		const seen = [];
		/** @param {browser.tabs.Tab} t */
		const onCreated = (t) => {
			seen.push({ event: "tabs.onCreated", tabId: t.id ?? null, windowId: t.windowId ?? null, openerTabId: t.openerTabId ?? null, cookieStoreId: t.cookieStoreId ?? null, url: (t.url ?? "").slice(0, 200) });
		};
		/** @param {{ sourceTabId: number, tabId: number, url: string }} d */
		const onTarget = (d) => {
			seen.push({ event: "onCreatedNavigationTarget", tabId: d.tabId, sourceTabId: d.sourceTabId, url: d.url.slice(0, 200) });
		};
		browser.tabs.onCreated.addListener(onCreated);
		browser.webNavigation.onCreatedNavigationTarget.addListener(onTarget);
		await new Promise((resolve) => setTimeout(resolve, ms));
		browser.tabs.onCreated.removeListener(onCreated);
		browser.webNavigation.onCreatedNavigationTarget.removeListener(onTarget);
		return seen;
	};

	// Run the extractor in a tab the way a job does and watch what it does to
	// the page: every DOM mutation and every request the browser starts
	// meanwhile. The page is only read, as in a job.
	commands["extract.check"] = async (args) => {
		const tabId = Number(args.tabId);
		/** @type {Record<string, number | boolean>} */
		const options = {};
		for (const [name, value] of Object.entries(typeof args.options === "object" && args.options !== null ? args.options : {})) {
			if (/^[A-Za-z]+$/.test(name) && (typeof value === "number" || typeof value === "boolean")) options[name] = value;
		}
		/** @type {{ url: string, tabId: number, type: string }[]} */
		const requests = [];
		/** @param {browser.webRequest._OnBeforeRequestDetails} d */
		const onRequest = (d) => {
			requests.push({ url: d.url.slice(0, 300), tabId: d.tabId, type: d.type });
		};
		browser.webRequest.onBeforeRequest.addListener(onRequest, { urls: ["<all_urls>"] });
		try {
			await browser.tabs.executeScript(tabId, {
				code: `(() => { const obs = new MutationObserver(() => {}); obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); globalThis.__bgwCheck = { obs, before: document.documentElement.outerHTML, resources: performance.getEntriesByType("resource").length, scroll: [scrollX, scrollY] }; })();`,
			});
			requests.length = 0;
			await browser.tabs.executeScript(tabId, { file: "/vendor/defuddle.full.js" });
			await browser.tabs.executeScript(tabId, { file: "/content/extract.js" });
			const call = `globalThis.__bgwExtract(${JSON.stringify(options)});`;
			const [result] = await browser.tabs.executeScript(tabId, { code: call });
			const [again] = await browser.tabs.executeScript(tabId, { code: call });
			await new Promise((resolve) => setTimeout(resolve, 600));
			const [page] = await browser.tabs.executeScript(tabId, {
				code: `(() => { const c = globalThis.__bgwCheck; const mutations = c.obs.takeRecords().length; c.obs.disconnect(); delete globalThis.__bgwCheck; const w = window.wrappedJSObject; return { mutations, domUnchanged: document.documentElement.outerHTML === c.before, newResources: performance.getEntriesByType("resource").length - c.resources, scrollUnchanged: scrollX === c.scroll[0] && scrollY === c.scroll[1], pageSeesDefuddle: typeof w.Defuddle, pageSeesExtract: typeof w.__bgwExtract, webdriver: w.navigator.webdriver }; })();`,
			});
			return { result, again, page, requests: [...requests] };
		} finally {
			browser.webRequest.onBeforeRequest.removeListener(onRequest);
		}
	};

	/** @type {Record<string, string>} */
	const PAGES = { options: "/options/options.html", popup: "/popup/popup.html" };
	/**
	 * The window object of one of the extension's own pages that is open in a tab.
	 * @param {unknown} page
	 */
	const view = (page) => {
		const found = browser.extension.getViews().find((v) => v.location.pathname === PAGES[String(page)]);
		if (found === undefined) throw new Error("that page is not open");
		return found;
	};
	// Drive the extension's own pages the way the operator would. These act on
	// extension pages only, never on a web page.
	commands["ui.open"] = async (args) => {
		const path = PAGES[String(args.page)];
		if (path === undefined) throw new Error("unknown page");
		const w = await browser.windows.create({ url: browser.runtime.getURL(path.slice(1)) });
		return { windowId: w.id ?? null };
	};
	commands["ui.read"] = async (args) => {
		const doc = view(args.page).document;
		/** @type {Record<string, string | null>} */
		const out = {};
		for (const id of Array.isArray(args.ids) ? args.ids : []) {
			const el = doc.getElementById(String(id));
			out[String(id)] = el === null ? null : el.tagName === "INPUT" && "value" in el ? String(el.value) : el.textContent;
		}
		return out;
	};
	commands["ui.set"] = async (args) => {
		const el = view(args.page).document.getElementById(String(args.id));
		if (el === null || !("value" in el)) throw new Error("no such field");
		el.value = String(args.value);
		return true;
	};
	// Whether an element of one of those pages is hidden: what a confirmation step shows only when asked.
	commands["ui.hidden"] = async (args) => {
		const el = view(args.page).document.getElementById(String(args.id));
		if (el === null) throw new Error("no such element");
		return el.hidden === true;
	};
	commands["ui.check"] = async (args) => {
		const el = view(args.page).document.getElementById(String(args.id));
		if (el === null || !("checked" in el)) throw new Error("no such checkbox");
		el.checked = args.checked === true;
		return true;
	};
	commands["ui.click"] = async (args) => {
		const el = view(args.page).document.getElementById(String(args.id));
		if (el === null) throw new Error("no such element");
		el.click();
		return true;
	};

	const connect = () => {
		const ws = new WebSocket(`ws://127.0.0.1:${deps.port}/hook`);
		ws.onmessage = (ev) => {
			/** @type {{ id?: unknown, cmd?: unknown, args?: unknown }} */
			let msg;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			const id = msg.id;
			const run = typeof msg.cmd === "string" && Object.hasOwn(commands, msg.cmd) ? commands[msg.cmd] : null;
			const args = typeof msg.args === "object" && msg.args !== null ? /** @type {Record<string, unknown>} */ (msg.args) : {};
			Promise.resolve()
				.then(() => {
					if (run === null) throw new Error("unknown command");
					return run(args);
				})
				.then(
					(result) => ws.send(JSON.stringify({ id, ok: true, result: result ?? null })),
					(err) => ws.send(JSON.stringify({ id, ok: false, error: err instanceof Error ? err.message : "failed" })),
				);
		};
		ws.onclose = () => setTimeout(connect, 1000);
	};
	connect();
}
