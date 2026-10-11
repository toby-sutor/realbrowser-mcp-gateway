"use strict";
// Toolbar popup: shows the state and holds the pause switch. Text goes into
// the page through textContent only.

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * @param {string} id
 * @param {string} text
 * @param {"ok" | "bad" | "warn" | ""} [tone]
 */
function show(id, text, tone = "") {
	const node = el(id);
	node.textContent = text;
	node.className = tone;
}

/** @type {boolean} */
let paused = false;

/** @param {Record<string, any>} s the background page's public status */
function render(s) {
	el("version").textContent = s.version ? `v${s.version}` : "";
	const link = s.link;
	if (s.starting || !link) {
		show("link", "starting...");
	} else if (!link.paired) {
		show("link", "not paired - open the options", "bad");
	} else if (link.phase === "ready") {
		show("link", `connected (port ${link.port})`, "ok");
	} else if (link.phase === "waiting" || link.phase === "daemon_unverified") {
		const seconds = link.retryAt ? Math.max(0, Math.round((link.retryAt - Date.now()) / 1000)) : 0;
		show("link", `${link.phase === "waiting" ? "not connected" : "daemon not verified"}, next try in ${seconds} s`, link.phase === "waiting" ? "bad" : "warn");
	} else if (link.phase === "protocol_version") {
		show("link", "version mismatch", "bad");
	} else if (["auth_failed", "not_paired"].includes(link.phase)) {
		show("link", "refused by the daemon - pair again", "bad");
	} else {
		show("link", "connecting...", "warn");
	}
	const error = el("error");
	error.textContent = link && link.lastError ? link.lastError : "";
	error.hidden = error.textContent === "";

	paused = s.paused === true;
	if (paused) show("paused", s.pauseReason === "window_closed" ? "paused - the gateway window was closed during a job" : "paused", "warn");
	else show("paused", "running", "ok");
	el("pause").textContent = paused ? "Resume" : "Pause";
	// A page that is read with the operator's own login is said to be, for as long as it is read.
	if (s.job && s.job.scope === "default") show("job", `using your login on ${s.job.host}`, "warn");
	else show("job", s.job ? s.job.host || "starting" : "-");
	renderPending(Array.isArray(s.pending) ? s.pending : []);
}

/** @type {string} what the list shows now; it is rebuilt only when this changes, so a button is not replaced under a click */
let pendingShown = "";

/** @param {{ job: string, host: string, handedOff: boolean }[]} pending pages that wait for the operator */
function renderPending(pending) {
	const key = JSON.stringify(pending.map((p) => [p.job, p.host, p.handedOff]));
	el("pending").hidden = pending.length === 0;
	if (key === pendingShown) return;
	pendingShown = key;
	const list = el("pending-list");
	list.textContent = "";
	for (const p of pending) {
		const item = document.createElement("li");
		const host = document.createElement("span");
		host.className = "host";
		host.textContent = String(p.host);
		const button = document.createElement("button");
		button.type = "button";
		button.id = `open-${String(p.job).replace(/[^A-Za-z0-9_-]/g, "")}`;
		button.textContent = p.handedOff ? "Open again" : "Open";
		// The page comes up in a window of its own: the operator asked for it here.
		button.addEventListener("click", () => ask({ bgw: "open_challenge", job: String(p.job) }));
		item.append(host);
		if (p.handedOff) {
			const note = document.createElement("span");
			note.className = "note";
			note.textContent = "opened";
			item.append(note);
		}
		item.append(button);
		list.append(item);
	}
}

/** @param {Record<string, unknown>} message */
async function ask(message) {
	try {
		const answer = await browser.runtime.sendMessage(message);
		if (answer && typeof answer === "object" && "version" in answer) render(answer);
	} catch {
		show("link", "the background page does not answer", "bad");
	}
}

el("pause").addEventListener("click", () => ask({ bgw: paused ? "resume" : "pause" }));
el("reconnect").addEventListener("click", () => ask({ bgw: "reconnect" }));
el("options").addEventListener("click", () => {
	browser.runtime.openOptionsPage().catch(() => {});
});

ask({ bgw: "status" });
setInterval(() => ask({ bgw: "status" }), 1000);
