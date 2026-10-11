// Background page entry point: builds the parts, wires them together and
// answers the toolbar popup and the options page.

import { DEFAULT_BLOCKLIST } from "../shared/policy.js";
import { MSG, makeMessage } from "../shared/protocol.js";
import { Settings, loadDevConfig } from "./settings.js";
import { Link, PHASE, TERMINAL_PHASES } from "./link.js";
import { Container, clearRefusal } from "./container.js";
import { createWindowStrategy } from "./window.js";
import { Guard } from "./guard.js";
import { Jobs } from "./jobs.js";
import { DownloadsBackstop } from "./downloads.js";
import { OptIn } from "./optin.js";
import { OPTIN_SHADOW_KEY } from "../shared/optin.js";
import { ownGet, pairingStore } from "../shared/ownstore.js";
import { errorText } from "./errtext.js";
import { StartGate } from "./startgate.js";

/**
 * @typedef {import("../shared/protocol.js").ExtState} ExtState
 * @typedef {import("./link.js").SocketLike} SocketLike
 *
 * @typedef {object} PublicStatus what the popup and the options page may see; no secrets
 * @property {boolean} starting
 * @property {string} version
 * @property {import("./link.js").LinkStatus | null} link
 * @property {boolean} paused
 * @property {string | null} pauseReason
 * @property {boolean} containerReady
 * @property {boolean} windowOpen
 * @property {{ job: string, host: string, scope: "container" | "default" | null } | null} job scope "default": the page is
 *   loaded with the operator's own login
 * @property {{ state: "ok" | "empty" | "mismatch", rules: import("../shared/policy.js").OptInRule[], fixturePorts: number[] }} optin
 *   the login rules in force, for the options page. fixturePorts: empty outside a test build
 * @property {{ job: string, host: string, since: number, handedOff: boolean }[]} pending pages with a human check that wait
 *   for the operator, oldest first
 * @property {boolean} dev a dev-config.json is in effect
 * @property {boolean} proxied requests of jobs were seen to go through a proxy in this session: the request guard then
 *   looks up no names and does not look at the address that answered (guard.js). The daemon is not told: its picture
 *   of the extension's state has no place for it
 *
 * @typedef {object} App everything that exists once boot() is through
 * @property {Settings} settings
 * @property {Link} link
 * @property {Container} container
 * @property {import("./window.js").WindowStrategy} win
 * @property {Jobs} jobs
 * @property {Guard} guard
 * @property {DownloadsBackstop} downloads
 * @property {StartGate} gate
 * @property {OptIn} optin
 * @property {import("./settings.js").DevConfig | null} dev
 */

const WINDOW_STRATEGY = "normal";
const VERSION = browser.runtime.getManifest().version;
const EXTENSION_BASE = browser.runtime.getURL("");
const PARK_URL = browser.runtime.getURL("park/park.html");
// How long one look at the operator's tabs answers the question "who else shows this site".
const FOREIGN_ORIGINS_REUSE_MS = 200;
// The extension's own notification for a challenge is named after its job.
const NOTIFICATION_PREFIX = "bgw-challenge-";
// A pop-up of a page that waits for the operator is not closed in the moment it is made (see closeStray).
const STRAY_CLOSE_DELAY_MS = 1500;
const MAX_HOST_SHOWN = 64;
// How long after a job with the operator's cookie store ended their tabs are still remembered for the downloads backstop.
const LOGIN_TRACE_MS = 10000;

/** @type {{ t: number, event: string, fields: Record<string, string | number | boolean | null> }[]} */
const recentLog = [];

/**
 * Event name plus plain fields. Callers never pass keys, codes, MACs or tokens.
 * @param {string} event
 * @param {Record<string, string | number | boolean | null>} [fields]
 */
function log(event, fields = {}) {
	recentLog.push({ t: Date.now(), event, fields });
	if (recentLog.length > 300) recentLog.shift();
	console.info("[bgw]", event, JSON.stringify(fields));
}

// Before anything else, and before anything is awaited: until the request guard is in place, this stands in for
// it (startgate.js). The browser has had its listener since the first script of the page ran, before this module
// and those it needs were loaded (gatefront.js); from this statement on the gate answers.
const gate = new StartGate({ webRequest: browser.webRequest, extensionBase: EXTENSION_BASE, log, front: /** @type {any} */ (globalThis).bgwGateFront ?? null });
gate.listen();
// The container the settings name is asked for at once, by itself: it says how long the operator's other containers
// may have to wait, and nothing else of the settings is needed for that.
browser.storage.local.get(["containerId"]).then(
	(st) => gate.stored(st.containerId),
	() => gate.stored(null),
);

/** @type {App | null} */
let app = null;
/** A pause the extension set by itself; unlike the operator's it does not outlive the session. */
/** @type {string | null} */
let autoPause = null;
/** @type {string | null} JSON of the state the daemon last got */
let reportedState = null;

/** @returns {ExtState} */
function extState() {
	const a = app;
	const paused = a !== null && (a.settings.paused || autoPause !== null);
	return {
		paused,
		pause_reason: !paused || a === null ? null : a.settings.paused ? (a.settings.pauseReason ?? "operator") : autoPause,
		slots: 1,
		container: { ready: a !== null && a.container.ready },
		window: { open: a !== null && a.win.isOpen() },
		policy_rev: a === null ? 1 : a.optin.rev,
		// The hosts only: the list of rules is never sent with its path prefixes, and the daemon tells agents no more
		// than how many rules there are. One rule at a time does leave the browser whole - host, path prefix and the
		// subdomains switch - for a job that runs under it (job.accepted, jobs.js): the protocol names all three, and
		// the daemon reads the host, to pace by it.
		optin_hosts: a === null ? [] : a.optin.hosts(),
	};
}

/** @returns {PublicStatus} */
function publicStatus() {
	const state = extState();
	return {
		starting: app === null,
		version: VERSION,
		link: app === null ? null : app.link.status(),
		paused: state.paused,
		pauseReason: state.pause_reason,
		containerReady: state.container.ready,
		windowOpen: state.window.open,
		job: app === null ? null : app.jobs.current(),
		pending: app === null ? [] : app.jobs.pending().map((p) => ({ job: p.job, host: p.host, since: p.since, handedOff: p.handedOff })),
		optin: {
			state: app === null ? "empty" : app.optin.state,
			rules: app === null ? [] : app.optin.rules.map((r) => ({ ...r })),
			fixturePorts: app === null || app.dev === null ? [] : [...app.dev.allowLoopbackPorts],
		},
		dev: app !== null && app.dev !== null,
		proxied: app !== null && app.guard.stats.proxied,
	};
}

/**
 * A host name short enough to show. The right end names the site, so a long
 * name loses labels on the left.
 * @param {string} host
 * @returns {string}
 */
function shownHost(host) {
	if (host.length <= MAX_HOST_SHOWN) return host;
	const labels = host.split(".");
	let kept = "";
	for (let i = labels.length - 1; i >= 0; i--) {
		const next = kept === "" ? labels[i] : `${labels[i]}.${kept}`;
		if (next.length > MAX_HOST_SHOWN - 3) break;
		kept = next;
	}
	return `...${kept === "" ? host.slice(-(MAX_HOST_SHOWN - 3)) : kept}`;
}

/**
 * The extension's own notification for a parked challenge: secondary to the
 * daemon's (the browser's are held back under Do Not Disturb). Its text is two
 * fixed sentences and the host name of the job - nothing of the page. It is
 * shown when the daemon asks for it (attention "renotify"), never by itself:
 * the daemon holds its own notification back for a while after a page was
 * parked, and a check that clears in that time notifies nobody, here as there.
 * @param {string} job
 * @param {string} host
 */
function notifyChallenge(job, host) {
	// Absent when the browser withholds the permission.
	if (browser.notifications === undefined) return;
	browser.notifications
		.create(NOTIFICATION_PREFIX + job, {
			type: "basic",
			title: "Browser Gateway: a page needs you",
			message: `${shownHost(host)} shows a human check. Click to open the page.`,
		})
		.catch(() => {});
}

/** @param {string} job */
function clearChallengeNotification(job) {
	if (browser.notifications === undefined) return;
	browser.notifications.clear(NOTIFICATION_PREFIX + job).catch(() => {});
}

/**
 * The operator asked for the tab of a parked job: by the daemon's
 * notification or command line (an "attention" frame), by the toolbar popup,
 * or by a click on the extension's notification. Nothing else ever calls this:
 * no window comes up by itself.
 * @param {string} job
 * @returns {Promise<boolean>}
 */
async function openChallenge(job) {
	if (app === null) return false;
	const opened = await app.jobs.handoff(job);
	if (opened) clearChallengeNotification(job);
	return opened;
}

function updateBadge() {
	const status = publicStatus();
	let text = "";
	let title = "Browser Gateway: connected";
	let color = "#5f6368";
	const link = status.link;
	if (link === null) {
		text = "...";
		title = "Browser Gateway: starting";
	} else if (!link.paired) {
		text = "pair";
		color = "#b3261e";
		title = "Browser Gateway: not paired. Open the options and paste a code from 'bgw pair'.";
	} else if (TERMINAL_PHASES.includes(link.phase)) {
		text = "err";
		color = "#b3261e";
		title = `Browser Gateway: ${link.lastError ?? "the daemon refused the connection"}`;
	} else if (link.phase === PHASE.UNVERIFIED) {
		// Not an error the operator must act on at once: the key is kept and the link keeps trying.
		text = "?";
		color = "#b06000";
		title = `Browser Gateway: ${link.lastError ?? "daemon not verified"}`;
	} else if (status.paused) {
		text = "II";
		color = "#b06000";
		title = status.pauseReason === "window_closed" ? "Browser Gateway: paused because the gateway window was closed during a job" : "Browser Gateway: paused";
	} else if (link.phase !== PHASE.READY) {
		text = "off";
		title = `Browser Gateway: not connected. ${link.lastError ?? ""}`.trim();
	} else if (status.job !== null && status.job.scope === "default") {
		// A page is being read with the operator's own login: said for as long as it lasts.
		text = "ID";
		color = "#6a3fb5";
		title = `Browser Gateway: using your login on ${shownHost(status.job.host)}`;
	} else if (status.pending.length > 0) {
		// Pages that wait for the operator outrank a job that happens to run.
		text = String(status.pending.length);
		color = "#b3261e";
		title = status.pending.length === 1 ? `Browser Gateway: a page from ${shownHost(status.pending[0].host)} needs you` : `Browser Gateway: ${status.pending.length} pages need you`;
	} else if (status.job !== null) {
		title = `Browser Gateway: loading a page from ${status.job.host}`;
	}
	browser.browserAction.setBadgeText({ text }).catch(() => {});
	browser.browserAction.setBadgeBackgroundColor({ color }).catch(() => {});
	browser.browserAction.setTitle({ title }).catch(() => {});
}

/**
 * Tell the daemon about a change. The state always rides along.
 * @param {string} name one of the protocol's event names
 * @param {import("./jobs.js").Challenge} [challenge] the parked job the event is about
 */
function sendEvent(name, challenge) {
	if (app === null) return;
	const state = extState();
	const about = challenge === undefined ? { host: null, job: null, detect: null } : { host: challenge.host === "" ? null : challenge.host, job: challenge.job, detect: challenge.detect };
	if (app.link.send(makeMessage(MSG.EVENT, { name, ...about, state }))) reportedState = JSON.stringify(state);
}

/** Container or window changed: report it, unless the daemon already has that picture. */
function stateChanged() {
	updateBadge();
	if (app === null || !app.link.isReady()) return;
	if (JSON.stringify(extState()) !== reportedState) sendEvent("state.changed");
}

/**
 * The kill switch. Pausing stops the running job at once.
 * @param {boolean} paused
 * @param {"operator" | "window_closed"} [reason]
 */
async function setPause(paused, reason = "operator") {
	if (app === null) return;
	if (paused) {
		if (reason === "operator") await app.settings.setPaused(true, "operator");
		else autoPause = reason;
		app.jobs.abortAll("paused");
		log("gateway.paused", { reason });
		sendEvent(reason === "window_closed" ? "window.closed" : "paused");
	} else {
		autoPause = null;
		await app.settings.setPaused(false, null);
		log("gateway.resumed", {});
		sendEvent("resumed");
	}
	updateBadge();
}

/**
 * The real WebSocket behind the small surface the link needs.
 * @param {string} url
 * @returns {SocketLike}
 */
function openSocket(url) {
	const ws = new WebSocket(url);
	/** @type {SocketLike} */
	const sock = {
		send: (data) => ws.send(data),
		close: (code, reason) => ws.close(code, reason),
		buffered: () => ws.bufferedAmount,
		onopen: null,
		onmessage: null,
		onclose: null,
	};
	ws.onopen = () => sock.onopen?.();
	ws.onmessage = (ev) => sock.onmessage?.({ data: ev.data });
	ws.onclose = (ev) => sock.onclose?.({ code: ev.code });
	return sock;
}

async function boot() {
	// Made further down. What is made before the first await below is asked for by events of the first moments, when
	// some of these are not there yet: every use of them in such a place asks first.
	/** @type {Container} */
	let container;
	/** @type {Guard} */
	let guard;
	/** @type {Jobs} */
	let jobs;
	/** @type {() => Promise<Set<string>>} what the operator has open themselves; nothing, until the tabs can be asked */
	let foreignOrigins = async () => new Set();

	// The downloads safety net listens from here on too. A download that begins in a container before the browser has
	// said which one is the gateway's is noted and judged when that is known (downloads.js).
	const downloads = new DownloadsBackstop({
		// Absent when the browser withholds the permission.
		downloads: browser.downloads,
		storeId: () => container?.cookieStoreId ?? null,
		onCaught: () => {
			guard?.noteDownload();
			jobs?.downloadStarted();
		},
		traces: (graceMs) => guard?.jobTraces(graceMs) ?? { active: false, origins: new Map(), caughtAt: null },
		foreignOrigins: () => foreignOrigins(),
		onAmbiguous: () => {
			jobs?.downloadAmbiguous();
		},
		log,
	});
	downloads.start();
	if (!downloads.available) log("downloads.unavailable", {});

	// And what an earlier session left behind goes first: a job tab, a tab that waited for the operator, a second
	// gateway window. They are known by the marks the gateway put on them, which the browser kept; nothing else is
	// needed to find them, so this begins before the settings are read. A window is adopted on the way.
	const win = createWindowStrategy(WINDOW_STRATEGY, {
		windows: browser.windows,
		tabs: browser.tabs,
		sessions: browser.sessions,
		parkUrl: PARK_URL,
		// What a job may leave behind is a window of this cookie store and no other (window.js).
		containerId: () => container?.cookieStoreId ?? null,
		log,
		onTabLost: (tabId) => {
			jobs?.tabLost(tabId);
		},
		onWindowClosed: (windowId) => {
			// Closed under a running job: the operator wants it gone. Stop
			// until they say otherwise instead of opening it again.
			if (jobs?.windowClosed(windowId)) setPause(true, "window_closed").catch(() => {});
			else sendEvent("window.closed");
			updateBadge();
		},
		onChange: () => {
			guard?.watchWindow(win.snapshot().windowId);
			stateChanged();
		},
	});
	const sweeping = win.adoptOrSweep();
	sweeping.catch(() => {});
	// Session restore can bring windows back a moment after the extension
	// starts: look again whenever a window appears during the first minute.
	/** @type {ReturnType<typeof setTimeout> | null} */
	let sweepTimer = null;
	const onCreated = () => {
		if (sweepTimer !== null) clearTimeout(sweepTimer);
		sweepTimer = setTimeout(() => win.adoptOrSweep().catch(() => {}), 500);
	};
	browser.windows.onCreated.addListener(onCreated);
	setTimeout(() => browser.windows.onCreated.removeListener(onCreated), 60000);

	const devFile = await loadDevConfig(browser.runtime.getURL("dev-config.json"));
	if (devFile.present && devFile.config === null) log("dev.config_invalid", {});
	const dev = devFile.config;
	if (dev !== null) log("dev.config_loaded", { loopback_ports: dev.allowLoopbackPorts.length, hook: dev.hookPort !== null });

	// The pairing key is kept where content scripts cannot reach (settings.js).
	const settings = new Settings(browser.storage.local, pairingStore, log);
	await settings.load(dev);

	container = new Container({
		// Absent when the browser was built without containers.
		identities: browser.contextualIdentities,
		settings,
		log,
		onChange: () => {
			// Tabs that are open in a container the guard only now knows of, and downloads that began in one.
			guard?.rescan().catch(() => {});
			downloads.recheck();
			stateChanged();
		},
	});
	// Which container is the gateway's: asked now, ahead of the rest of the start. The gate answers what it held
	// the moment the browser has said - or that there is none.
	const ensuring = container.ensure();
	ensuring.then(
		(id) => gate.known(id),
		() => gate.known(null),
	);
	// The only loopback exception there is. Without the file the list is empty.
	const policy = {
		blocklist: dev === null ? DEFAULT_BLOCKLIST : [...DEFAULT_BLOCKLIST, ...dev.blocklistExtra],
		allowLoopbackPorts: dev === null ? [] : dev.allowLoopbackPorts,
	};

	// The operator's login rules: read here, written by the options page alone.
	const optinPolicy = { blocklist: policy.blocklist, fixturePorts: policy.allowLoopbackPorts };
	const optin = new OptIn({
		storage: browser.storage.local,
		// The storage of the extension's own pages. A browser that withholds it leaves no rule in force.
		shadow: () => ownGet(OPTIN_SHADOW_KEY),
		onChanged: browser.storage.onChanged,
		policy: optinPolicy,
		log,
		onChange: () => {
			updateBadge();
			if (app !== null && app.link.isReady()) sendEvent("policy.changed");
		},
		...(dev === null || dev.tuning === null ? {} : { limits: dev.tuning.login }),
	});
	await optin.load().catch(() => {});

	let info = { name: "unknown", version: "" };
	try {
		const b = await browser.runtime.getBrowserInfo();
		info = { name: b.name, version: b.version };
	} catch {
		// keep the placeholder
	}

	/**
	 * A tab appeared in the gateway container that no job made. The guard has
	 * sealed it: nothing loads in it. A pop-up of a job page is closed as well.
	 * Pop-ups only happen where the operator allows them.
	 * @param {import("./guard.js").Stray} stray
	 */
	const closeStray = async (stray) => {
		if (stray.foreign === true) {
			// A tab of another cookie store that appeared in the gateway window while a job tab was open. The window
			// module says whose it is: the gateway's own stays, any other is closed - and the job whose page was
			// opened again in it ends, as soon as that is known and before the tab is closed.
			const from = stray.reopenedFrom;
			const whose = await win.closeForeign(stray.tabId, () => {
				if (typeof from === "number") guard.reassigned(from);
			});
			// The park tab was sealed with the rest; a job tab is claimed by its job.
			if (whose === "park") guard.release(stray.tabId);
			else if (whose !== "job") log("window.foreign_tab", { outcome: whose, took_over: typeof from === "number" });
			return;
		}
		// A job tab of our own is reported the same way, while window.js is still making it.
		await win.idle();
		const own = win.snapshot();
		if (own.jobTabs.includes(stray.tabId)) return;
		const login = stray.ofLoginJob === true;
		const windowId = stray.windowId ?? (await browser.tabs.get(stray.tabId).catch(() => null))?.windowId ?? null;
		const inGatewayWindow = windowId !== null && windowId === own.windowId;
		// A tab that a job tab with the operator's cookie store opened is known by its opener alone, and for certain.
		let popup = login || (stray.openerTabId !== null && own.jobTabs.includes(stray.openerTabId));
		if (!popup && stray.duringJob && windowId !== null) {
			// A pop-up that got a window of its own names no opener: it is alone in its window.
			popup = inGatewayWindow || (await browser.tabs.query({ windowId })).length === 1;
		}
		if (!popup) {
			// Sealed: no request of it goes out, so what it shows now is all it will ever show. Where that is no
			// web page there is nothing in it for anybody - a blank tab, a page of the browser's own, or a file
			// the browser saved for a job and then opened by itself. Measured in Firefox 156 (2026-10-07): a PDF
			// that got past the guard as a download was shown from its file:// address in a new tab of the
			// container, in the gateway window, after the job was over; sealed and kept there, it made the next
			// job take that window for one the operator had moved into, leave it to them and make another - one
			// more window for every such job. Such a tab is closed, not kept: as soon as something other than a
			// web page or a blank stands in it, and a blank one after the moment a pop-up gets below (it may be
			// on its way to an address, and is not closed while that request can still get out unheard).
			const until = Date.now() + STRAY_CLOSE_DELAY_MS;
			/** @type {browser.tabs.Tab | null} */
			let now = null;
			for (;;) {
				now = await browser.tabs.get(stray.tabId).catch(() => null);
				if (now === null || win.snapshot().jobTabs.includes(stray.tabId)) return;
				if (Date.now() >= until || (typeof now.url === "string" && !/^(https?:|about:blank$)/i.test(now.url))) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (typeof now.url === "string" && /^https?:/i.test(now.url)) {
				// A page that was there before the guard was: it stays where it is, and loads nothing more.
				log("guard.container_tab_sealed", {});
				return;
			}
			log("window.stray_tab_closed", { off_web: true });
			await browser.tabs.remove(stray.tabId).catch(() => {});
			return;
		}
		// In the operator's cookie store no listener of the gateway window stands behind the tab's own: it
		// stays sealed until its job is over, wherever it is.
		if (!inGatewayWindow || login) {
			// A window of its own is closed once the job that opened it is over, not
			// before. Measured in Firefox 156: of a window that is closed in the
			// moment it is made, a request of its first document can get out that
			// no extension is told of - about one in fifteen did. Sealed and open, all
			// its requests are heard and cancelled.
			const opener = jobs.current()?.job;
			while (opener !== undefined && jobs.current()?.job === opener) await new Promise((resolve) => setTimeout(resolve, 100));
			// No job runs: the pop-up is that of a page that waits for the operator,
			// and that job may go on for minutes. Not at once, for the same reason.
			if (opener === undefined) await new Promise((resolve) => setTimeout(resolve, STRAY_CLOSE_DELAY_MS));
		}
		log("window.stray_tab_closed", {});
		await browser.tabs.remove(stray.tabId).catch(() => {});
	};

	guard = new Guard({
		webRequest: browser.webRequest,
		tabs: browser.tabs,
		webNavigation: browser.webNavigation,
		resolve: (host) => browser.dns.resolve(host),
		policy,
		extensionBase: EXTENSION_BASE,
		storeId: () => container.cookieStoreId,
		// With its viewer off the browser saves PDFs instead of showing them: none is captured then.
		pdfViewer: () => navigator.pdfViewerEnabled === true,
		onStray: (stray) => {
			closeStray(stray).catch(() => {});
		},
		// What the operator has open at the moment a job begins to run with their cookie store.
		onLoginTab: () => {
			foreignOrigins().catch(() => {});
		},
		log,
	});
	// The window may have been adopted before there was a guard to tell.
	guard.watchWindow(win.snapshot().windowId);
	// From here on nothing loads in the gateway container outside a job.
	guard.start();
	// The guard can do all of its work when the container is known, every tab that is open in it is sealed, and the
	// browser has taken in the listeners that were made for that. It has when it answers a question that was asked
	// after them: the tabs of the container are asked for a second time, which also seals what appeared meanwhile.
	const sealed = ensuring
		.then(
			() => guard.rescan(),
			() => {},
		)
		.then(() => guard.rescan())
		.catch(() => {});
	// Then the gate goes - once it is owed no request any more (startgate.js). A job gets its container after that
	// and not before: until then every request in it is cancelled.
	const gateGone = sealed.then(() => gate.leave());

	/** @type {Link} */
	let link;
	jobs = new Jobs({
		send: (msg) => link.send(msg),
		backlog: () => link.backlog(),
		maxResultBytes: () => link.maxResultBytes,
		isPaused: () => extState().paused,
		container: {
			ensure: async () => {
				const id = await container.ensure();
				await gateGone;
				return id;
			},
		},
		window: win,
		guard,
		policy,
		optin,
		optinPolicy,
		tabs: browser.tabs,
		webNavigation: browser.webNavigation,
		log,
		onActivity: updateBadge,
		onChallenge: (what, challenge) => {
			if (what === "pending") {
				// Listed from this moment on (badge, popup, the daemon's status); the notification comes later, if at all.
				sendEvent("challenge.pending", challenge);
			} else if (what === "acked") {
				sendEvent("challenge.acked", challenge);
			} else if (what === "cleared") {
				// The check is gone and the page is being read: nothing left to call the operator for.
				sendEvent("challenge.cleared", challenge);
				clearChallengeNotification(challenge.job);
			} else {
				// Its end is told by the job's result; here only the notification goes.
				clearChallengeNotification(challenge.job);
			}
			updateBadge();
		},
		...(dev === null || dev.tuning === null ? {} : { tuning: dev.tuning.jobs, parkTuning: dev.tuning.park }),
	});

	link = new Link({
		createSocket: openSocket,
		settings,
		getState: () => {
			const state = extState();
			reportedState = JSON.stringify(state);
			return state;
		},
		identity: { extVersion: VERSION, browser: info },
		handlers: {
			onReady: () => {
				// The dial that made this link was a request without a tab: the
				// guard's listener for those must have heard it.
				guard.confirmTabless();
				// The daemon never replays a job: whatever was running is void.
				jobs.abortAll("link_reset");
				win.releaseAll().catch(() => {});
				stateChanged();
			},
			onDown: () => {
				reportedState = null;
				jobs.abortAll("link_down");
			},
			onMessage: (msg) => {
				if (msg.type === MSG.JOB_START) jobs.start(msg);
				else if (msg.type === MSG.JOB_CANCEL) jobs.cancel(String(msg.job), String(msg.reason));
				else if (msg.type === MSG.ATTENTION) {
					// The operator answered the daemon's notification, or asked on the command line.
					const job = String(msg.job);
					if (msg.action === "focus") openChallenge(job).catch(() => {});
					else {
						const waiting = jobs.pending().find((p) => p.job === job && !p.handedOff);
						if (waiting !== undefined) notifyChallenge(waiting.job, waiting.host);
					}
				}
			},
			onStatus: updateBadge,
		},
		log,
	});

	/** @type {{ at: number, origins: Promise<Set<string>> } | null} */
	let foreign = null;
	/**
	 * Origins the operator's own tabs showed while a job ran with their cookie
	 * store, and a moment before and after. Such a job cannot be told from the
	 * operator by its store, so what counts is whether they had the site open
	 * at any time during it - not only at the moment a download turns up.
	 * Kept in memory for as long as such a job is about, origins only.
	 * @type {Set<string>}
	 */
	const seenDuringLogin = new Set();
	/** @param {unknown} url @returns {string | null} */
	const originOfTab = (url) => {
		if (typeof url !== "string" || !/^https?:/i.test(url)) return null;
		try {
			return new URL(url).origin;
		} catch {
			// not an address: nothing to compare with
			return null;
		}
	};
	/** @param {number | undefined} tabId @returns {boolean} true for a tab the gateway made or sealed, not the operator */
	const ours = (tabId) => tabId !== undefined && win.snapshot().jobTabs.includes(tabId);
	// Hears where documents are committed, in every tab. It keeps nothing unless a
	// job runs with the operator's cookie store, and then the origin alone.
	browser.webNavigation.onCommitted.addListener((details) => {
		if (!guard.loginActive(LOGIN_TRACE_MS)) {
			seenDuringLogin.clear();
			return;
		}
		const origin = ours(details.tabId) ? null : originOfTab(details.url);
		if (origin !== null && seenDuringLogin.size < 2000) seenDuringLogin.add(origin);
	});
	/**
	 * What the operator has open themselves, anywhere outside the gateway
	 * container: the pages of their tabs and the frames in those pages (a page
	 * of one site can show another in a frame, and a frame can save a blob).
	 * The gateway's own job tabs are not the operator's, whatever store they use.
	 * @returns {Promise<Set<string>>}
	 */
	foreignOrigins = () => {
		// A burst of downloads asks many times within a moment: one look serves them all.
		if (foreign !== null && Date.now() - foreign.at < FOREIGN_ORIGINS_REUSE_MS) return foreign.origins;
		const origins = (async () => {
			const login = guard.loginActive(LOGIN_TRACE_MS);
			if (!login) seenDuringLogin.clear();
			/** @type {Set<string>} */
			const out = new Set(seenDuringLogin);
			/** @param {unknown} url */
			const add = (url) => {
				const origin = originOfTab(url);
				if (origin === null) return;
				out.add(origin);
				if (login && seenDuringLogin.size < 2000) seenDuringLogin.add(origin);
			};
			const theirs = (await browser.tabs.query({})).filter((tab) => tab.cookieStoreId !== container.cookieStoreId && !ours(tab.id));
			for (const tab of theirs) add(tab.url);
			await Promise.all(
				theirs.map(async (tab) => {
					// A tab the browser has unloaded holds no document that could save anything.
					if (tab.id === undefined || tab.discarded === true) return;
					for (const frame of (await browser.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => null)) ?? []) add(frame.url);
				}),
			);
			return out;
		})();
		foreign = { at: Date.now(), origins };
		return origins;
	};

	app = { settings, link, container, win, jobs, guard, downloads, gate, optin, dev };

	// A click on the extension's own notification is the operator asking for the page.
	if (browser.notifications !== undefined) {
		browser.notifications.onClicked.addListener((id) => {
			if (id.startsWith(NOTIFICATION_PREFIX)) openChallenge(id.slice(NOTIFICATION_PREFIX.length)).catch(() => {});
		});
	}

	// Know the container, have its tabs sealed and a window from the last session adopted before the first state
	// report goes out. None of it may hold up the link for long; a job waits for the first two by itself.
	await Promise.race([Promise.allSettled([sealed, sweeping]), new Promise((resolve) => setTimeout(resolve, 5000))]);

	link.start();
	updateBadge();
	log("boot.done", { version: VERSION, paired: settings.key !== null, dev: dev !== null, container: container.ready, window: win.isOpen(), login_rules: optin.rules.length });

	if (dev !== null && dev.hookPort !== null) {
		// Test control channel. The module is not part of a release XPI.
		const { startDevHook } = await import("./devhook.js");
		startDevHook({ port: dev.hookPort, app, publicStatus, setPause, recentLog, openChallenge });
	}
}

/**
 * The operator asked, in the options page, to clear the gateway container: it
 * is removed with its cookies and site data, and an empty one takes its place.
 * Not while any job is alive (container.js, clearRefusal) - their tabs live in
 * that container and would be closed under them.
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function clearContainer() {
	const a = app;
	if (a === null) return { ok: false, error: "The extension is still starting. Try again in a moment." };
	const refusal = clearRefusal(a.jobs);
	if (refusal !== null) return { ok: false, error: refusal };
	try {
		// From this call on a job that starts waits for the new container.
		await a.container.clear();
	} catch (err) {
		log("container.clear_failed", { message: errorText(err) });
		return { ok: false, error: "The container could not be cleared: the browser did not remove it." };
	}
	log("container.cleared", {});
	stateChanged();
	return { ok: true };
}

/**
 * Only the extension's own pages may talk to the background page.
 * @param {browser.runtime.MessageSender} sender
 */
function isOwnPage(sender) {
	return sender.id === browser.runtime.id && typeof sender.url === "string" && sender.url.startsWith(EXTENSION_BASE);
}

browser.runtime.onMessage.addListener((message, sender) => {
	if (!isOwnPage(sender) || typeof message !== "object" || message === null) return undefined;
	const request = /** @type {Record<string, unknown>} */ (message);
	const a = app;
	if (request.bgw === "status" || a === null) return Promise.resolve(publicStatus());
	switch (request.bgw) {
		case "pause":
			return setPause(true).then(publicStatus);
		case "resume":
			return setPause(false).then(publicStatus);
		case "reconnect":
			return a.link.reconnect().then(publicStatus);
		case "open_challenge":
			// The toolbar popup's list of pages that wait for the operator.
			return typeof request.job === "string" ? openChallenge(request.job).then(publicStatus) : Promise.resolve(publicStatus());
		case "pair":
			// Not while a pairing could not be kept: the daemon would hold a key that this extension has lost by the next start.
			if (a.settings.keyStoreDown) return Promise.resolve({ ok: false, error: "The browser does not let the extension reach its own storage right now, where the pairing is kept. Restart the browser and try again; nothing was changed." });
			return a.link.pair(request.code);
		case "forget":
			return a.link.forget().then(publicStatus);
		case "clear_container":
			return clearContainer();
		case "set_port": {
			const port = request.port;
			if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
				return Promise.resolve({ ok: false, error: "The port must be a number from 1 to 65535." });
			}
			return a.settings
				.setPort(port)
				.then(() => a.link.reconnect())
				.then(() => ({ ok: true }));
		}
		default:
			return undefined;
	}
});

updateBadge();
boot().catch((err) => {
	log("boot.failed", { message: errorText(err) });
});
