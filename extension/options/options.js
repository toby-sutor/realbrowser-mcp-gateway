// Options page: pairing, connection state, daemon port, clearing the gateway
// container, and the login rules.
// Text goes into the page through textContent only. The pairing code is handed
// to the background page and cleared from the field; it is never stored or
// logged here.
//
// The login rules are written here and nowhere else: this page puts them into
// storage.local and keeps the copy in the extension's own page storage that
// the background page compares them with (shared/optin.js). The background
// page only reads.

import { DEFAULT_BLOCKLIST, checkOptInRule, optInRuleKey } from "../shared/policy.js";
import {
	OPTIN_SHADOW_KEY,
	OPTIN_STORAGE_KEY,
	describeOptInRule,
	optInMessage,
	optInRuleFromInput,
	packOptInRules,
	reviewOptInRules,
	serializeOptInRules,
	withOptInRule,
} from "../shared/optin.js";
import { ownGet, ownRemove, ownSet } from "../shared/ownstore.js";

/**
 * @typedef {import("../shared/policy.js").OptInRule} OptInRule
 */

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id */
const input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

/**
 * @param {string} id
 * @param {string} text
 * @param {"ok" | "bad" | ""} [tone]
 */
function show(id, text, tone = "") {
	const node = el(id);
	node.textContent = text;
	node.className = tone;
}

let portShown = false;
/** @type {number[]} fixture ports of a test build; empty in a release build */
let fixturePorts = [];
/** @type {string} the rules the background page says are in force, as one text */
let inForce = "";

/** @param {Record<string, any>} s the background page's public status */
function render(s) {
	el("version").textContent = s.version ? `v${s.version}` : "";
	const link = s.link;
	if (s.starting || !link) {
		show("paired", "...");
		show("link", "starting...");
		return;
	}
	show("paired", link.paired ? "yes" : "no", link.paired ? "ok" : "bad");
	/** @type {Record<string, string>} */
	const phases = {
		unpaired: "not paired",
		connecting: "connecting...",
		handshake: "connecting...",
		ready: `connected on port ${link.port}`,
		waiting: "not connected, retrying",
		daemon_unverified: "daemon not verified, retrying (the key is kept)",
		auth_failed: "the daemon refused this extension's key - pair again",
		not_paired: "the daemon has no key for this extension - pair again",
		protocol_version: "version mismatch",
		stopped: "stopped",
	};
	show("link", phases[link.phase] || link.phase, link.phase === "ready" ? "ok" : "bad");
	show("error", link.lastError || "-");
	if (!portShown) {
		input("port").value = String(link.port);
		portShown = true;
	}
	const optin = s.optin;
	if (optin && Array.isArray(optin.rules)) {
		const ports = Array.isArray(optin.fixturePorts) ? optin.fixturePorts.filter((/** @type {unknown} */ p) => typeof p === "number") : [];
		const now = JSON.stringify([optin.state, optin.rules, ports]);
		if (now !== inForce) {
			inForce = now;
			fixturePorts = ports;
			showRules().catch(() => {});
		}
	}
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<any>}
 */
async function ask(message) {
	try {
		return await browser.runtime.sendMessage(message);
	} catch {
		show("link", "the background page does not answer", "bad");
		return null;
	}
}

async function refresh() {
	const status = await ask({ bgw: "status" });
	if (status) render(status);
}

async function pair() {
	const field = input("code");
	const code = field.value;
	field.value = "";
	if (code.trim() === "") {
		show("pair-result", "Paste a code first.", "bad");
		return;
	}
	show("pair-result", "Pairing...");
	const result = await ask({ bgw: "pair", code });
	if (result && result.ok === true) show("pair-result", "Paired. The extension is connected.", "ok");
	else show("pair-result", result && typeof result.error === "string" ? result.error : "Pairing failed.", "bad");
	portShown = false;
	refresh();
}

el("pair").addEventListener("click", pair);
input("code").addEventListener("keydown", (ev) => {
	if (ev.key === "Enter") pair();
});
el("reconnect").addEventListener("click", async () => {
	await ask({ bgw: "reconnect" });
	refresh();
});
el("forget").addEventListener("click", async () => {
	await ask({ bgw: "forget" });
	show("pair-result", "The stored key was removed. Pair again to use the gateway.");
	refresh();
});
el("save-port").addEventListener("click", async () => {
	const port = Number(input("port").value);
	const result = await ask({ bgw: "set_port", port });
	if (result && result.ok === true) show("port-result", "Saved.", "ok");
	else show("port-result", result && typeof result.error === "string" ? result.error : "The port could not be saved.", "bad");
	refresh();
});

// ---------------------------------------------------------------- gateway container

// Two steps: the first button only shows what clearing means; nothing happens before the second.
el("container-clear").addEventListener("click", () => {
	el("container-confirm").hidden = false;
	show("container-result", "");
});
el("container-clear-no").addEventListener("click", () => {
	el("container-confirm").hidden = true;
	show("container-result", "Nothing was cleared.");
});
el("container-clear-yes").addEventListener("click", async () => {
	el("container-confirm").hidden = true;
	show("container-result", "Clearing...");
	const result = await ask({ bgw: "clear_container" });
	if (result && result.ok === true) show("container-result", "The gateway container was cleared: its cookies and site data are gone, and a new, empty container is in place.", "ok");
	else show("container-result", result && typeof result.error === "string" ? result.error : "The container could not be cleared.", "bad");
	refresh();
});

// ---------------------------------------------------------------- login rules

const NO_PAGE_STORAGE = "This browser does not let the extension keep data of its own pages, so login rules cannot be used.";

/** How rules are checked here: the same way the background page checks them when it reads them. */
const ruleOptions = () => ({ blocklist: DEFAULT_BLOCKLIST, fixturePorts });

/** @type {string | null} key of the rule that is being changed in the form; null: the form adds a rule */
let editing = null;
/** @type {string} what the list shows; it is rebuilt only when this changes, so a button is not replaced under a click */
let listShown = "";
/** @type {OptInRule[]} the rules the list shows */
let shownRules = [];

/**
 * @returns {Promise<{ ok: true, text: string | null } | { ok: false }>} the copy of the rules in this page's own storage
 */
async function readShadow() {
	try {
		return { ok: true, text: await ownGet(OPTIN_SHADOW_KEY) };
	} catch {
		return { ok: false };
	}
}

/**
 * What is stored, and what of it is in force.
 * @returns {Promise<{ state: "ok" | "empty" | "mismatch" | "unusable", rules: OptInRule[], restorable: boolean }>}
 *   mismatch: the two copies do not agree, no rule is in force - rules holds what the operator may look at:
 *   this page's own copy when it has one (restorable: only this page writes it, so it is what was last saved
 *   here), else what lies in storage.local, which anything in the extension can write and which is therefore
 *   shown and never offered;
 *   unusable: this page cannot keep its copy at all
 */
async function readRules() {
	const shadow = await readShadow();
	const stored = (await browser.storage.local.get([OPTIN_STORAGE_KEY]))[OPTIN_STORAGE_KEY];
	if (!shadow.ok) return { state: "unusable", rules: [], restorable: false };
	return reviewOptInRules(stored, shadow.text, ruleOptions());
}

/**
 * Write the list: this page's own copy first, then storage.local, so that the
 * background page, which looks when storage.local changes, finds the two in
 * agreement. Every rule is checked once more on the way.
 * @param {readonly OptInRule[]} rules
 * @returns {Promise<boolean>} false when the list could not be written
 */
async function writeRules(rules) {
	/** @type {OptInRule[]} */
	const checked = [];
	for (const rule of rules) {
		const c = checkOptInRule(rule, ruleOptions());
		if (!c.ok) return false;
		checked.push(c.rule);
	}
	try {
		if (checked.length === 0) await ownRemove(OPTIN_SHADOW_KEY);
		else await ownSet(OPTIN_SHADOW_KEY, serializeOptInRules(checked));
	} catch {
		return false;
	}
	if (checked.length === 0) await browser.storage.local.remove(OPTIN_STORAGE_KEY);
	else await browser.storage.local.set({ [OPTIN_STORAGE_KEY]: packOptInRules(checked) });
	return true;
}

function resetForm() {
	editing = null;
	input("optin-host").value = "";
	input("optin-path").value = "/";
	input("optin-subdomains").checked = false;
	el("optin-form-title").textContent = "Add a rule";
	el("optin-add").textContent = "Add rule";
	el("optin-cancel").hidden = true;
}

async function showRules() {
	const { state, rules, restorable } = await readRules();
	shownRules = rules;
	const off = state === "mismatch";
	if (state === "unusable") show("optin-state", NO_PAGE_STORAGE, "bad");
	else if (state === "empty") show("optin-state", "No rule is set. Every page is loaded in the gateway container, without your login.");
	else if (off && restorable) show("optin-state", "The stored list of rules did not pass its check (the two copies the extension keeps do not agree), so no rule is in force. This is the list as it was last saved on this page - read each rule before you put it in force.", "bad");
	else if (off && rules.length > 0) show("optin-state", "The stored list of rules did not pass its check (the copy that only this page can write is missing), so no rule is in force. What is shown here is what was found without it: it may hold rules you never set and cannot be put in force. Remove all rules, then add again the ones you want.", "bad");
	else if (off) show("optin-state", "The stored list of rules did not pass its check and cannot be read, so no rule is in force. Remove all rules, then add again the ones you want.", "bad");
	else show("optin-state", rules.length === 1 ? "1 rule is in force." : `${rules.length} rules are in force.`, "ok");
	el("optin-trouble").hidden = !off;
	el("optin-restore").hidden = !(off && restorable);
	const key = JSON.stringify([state, restorable, rules]);
	if (key === listShown) return;
	listShown = key;
	const list = el("optin-list");
	list.textContent = "";
	rules.forEach((rule, i) => {
		const item = document.createElement("li");
		const text = document.createElement("span");
		text.className = off ? "rule off" : "rule";
		text.id = `optin-rule-${i}`;
		text.textContent = describeOptInRule(rule);
		item.append(text);
		if (!off) {
			const edit = document.createElement("button");
			edit.type = "button";
			edit.id = `optin-edit-${i}`;
			edit.textContent = "Change";
			edit.addEventListener("click", () => {
				editing = optInRuleKey(rule);
				input("optin-host").value = rule.host;
				input("optin-path").value = rule.pathPrefix;
				input("optin-subdomains").checked = rule.subdomains;
				el("optin-form-title").textContent = "Change the rule";
				el("optin-add").textContent = "Save the change";
				el("optin-cancel").hidden = false;
				show("optin-result", "");
			});
			const remove = document.createElement("button");
			remove.type = "button";
			remove.id = `optin-remove-${i}`;
			remove.textContent = "Remove";
			remove.addEventListener("click", async () => {
				const now = await readRules();
				if (now.state !== "ok") return showRules();
				const ok = await writeRules(now.rules.filter((r) => optInRuleKey(r) !== optInRuleKey(rule)));
				show("optin-result", ok ? "Removed." : "The rule could not be removed.", ok ? "ok" : "bad");
				if (editing === optInRuleKey(rule)) resetForm();
				await showRules();
			});
			item.append(edit, remove);
		}
		list.append(item);
	});
}

async function saveRule() {
	show("optin-result", "");
	const made = optInRuleFromInput(input("optin-host").value, input("optin-path").value, input("optin-subdomains").checked, ruleOptions());
	if (!made.ok) return show("optin-result", optInMessage(made.reason), "bad");
	const now = await readRules();
	if (now.state === "unusable") return show("optin-result", NO_PAGE_STORAGE, "bad");
	if (now.state === "mismatch") return show("optin-result", "Deal with the stored list above first.", "bad");
	const next = withOptInRule(now.rules, made.rule, editing);
	if (!next.ok) return show("optin-result", optInMessage(next.reason), "bad");
	if (!(await writeRules(next.rules))) return show("optin-result", "The rule could not be saved.", "bad");
	show("optin-result", `Saved: ${describeOptInRule(made.rule)}`, "ok");
	resetForm();
	await showRules();
}

el("optin-add").addEventListener("click", () => {
	saveRule().catch(() => show("optin-result", "The rule could not be saved.", "bad"));
});
el("optin-cancel").addEventListener("click", () => {
	resetForm();
	show("optin-result", "");
});
el("optin-restore").addEventListener("click", async () => {
	// The operator has read the list that is shown and wants exactly it. It is read again here, and it
	// must still be this page's own copy, and the one that is shown: a list that came from storage.local
	// alone is never written, whatever state the button is in.
	const now = await readRules();
	if (now.state !== "mismatch" || !now.restorable || JSON.stringify(now.rules) !== JSON.stringify(shownRules)) {
		show("optin-result", "Nothing was put in force: the stored list is not what was shown. Read it again.", "bad");
		listShown = "";
		await showRules();
		return;
	}
	const ok = await writeRules(now.rules);
	show("optin-result", ok ? "The rules shown are in force." : "The rules could not be saved.", ok ? "ok" : "bad");
	await showRules();
});
el("optin-clear").addEventListener("click", async () => {
	const ok = await writeRules([]);
	show("optin-result", ok ? "All rules were removed." : "The rules could not be removed.", ok ? "ok" : "bad");
	await showRules();
});
// Another options tab changed the list.
browser.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && Object.hasOwn(changes, OPTIN_STORAGE_KEY)) showRules().catch(() => {});
});

showRules().catch(() => {});
refresh();
setInterval(refresh, 1000);
