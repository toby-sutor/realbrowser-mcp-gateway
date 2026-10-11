// Injected into a job tab by the background page (tabs.executeScript). Looks
// for the marks of a challenge, block or consent page and reports them as
// flags, plus how much text the page shows. What the flags mean is decided in
// background/detect.js.
//
// This script only reads: the title, a few selectors, the addresses of the
// frames, the text of the body. It touches nothing, clicks nothing, changes
// nothing, and hands back no text of the page - a page cannot put words into
// the result through here.
//
// The value of the last expression is what executeScript hands back.
(() => {
	const doc = document;
	const MAX_FRAMES = 200;
	const MAX_SCRIPTS = 100;
	const MAX_SCRIPT_CHARS = 200000;
	const MAX_TEXT_CHARS = 2000000;

	/** @param {string} selector */
	const has = (selector) => {
		try {
			return doc.querySelector(selector) !== null;
		} catch {
			return false;
		}
	};
	/** @param {string} host @param {string} domain */
	const under = (host, domain) => host === domain || host.endsWith("." + domain);

	// The titles Cloudflare gives its interstitial, without the dots.
	const TITLES = ["just a moment", "nur einen moment", "einen moment", "un instant", "un momento", "um momento"];
	const title = String(doc.title ?? "")
		.toLowerCase()
		.replace(/[.…\s]+$/u, "")
		.trim();

	let turnstile = false;
	let datadome = false;
	let recaptcha = false;
	let hcaptcha = false;
	let consentFrame = false;
	const frames = doc.querySelectorAll("iframe[src]");
	for (let i = 0; i < frames.length && i < MAX_FRAMES; i++) {
		/** @type {URL} */
		let u;
		try {
			u = new URL(frames[i].getAttribute("src") ?? "", doc.baseURI);
		} catch {
			continue;
		}
		if (u.protocol !== "https:" && u.protocol !== "http:") continue;
		const host = u.hostname.toLowerCase();
		if (host === "challenges.cloudflare.com") turnstile = true;
		else if (under(host, "captcha-delivery.com")) datadome = true;
		else if ((under(host, "google.com") || under(host, "recaptcha.net")) && u.pathname.startsWith("/recaptcha/")) recaptcha = true;
		else if (under(host, "hcaptcha.com")) hcaptcha = true;
		else if (host === "consent.google.com" || host === "consent.youtube.com" || under(host, "privacy-mgmt.com") || under(host, "consensu.org")) consentFrame = true;
	}

	// Elements of the challenge page itself. The script of the passive check
	// that Cloudflare adds to ordinary pages (".../scripts/jsd/...") is not one.
	const cfChallenge =
		has("#challenge-form, #challenge-stage, #challenge-running, #cf-challenge-running, #challenge-error-text, #challenge-success-text, #cf-please-wait, .cf-browser-verification") ||
		has('script[src*="/cdn-cgi/challenge-platform/"][src*="/orchestrate/chl_page"]');

	const consent =
		consentFrame ||
		has(
			"#onetrust-banner-sdk, #onetrust-consent-sdk, #CybotCookiebotDialog, #didomi-popup, #didomi-notice, .qc-cmp2-container, #qc-cmp2-container, " +
				'#usercentrics-root, #usercentrics-cmp-ui, [id^="sp_message_container_"], .fc-consent-root, #cmpbox, #truste-consent-track, ' +
				'form[action*="//consent.google."], form[action*="//consent.youtube."]',
		);

	// Recorded so that the rule "this alone means nothing" is a rule about a fact, not about a blind spot.
	let cfChlOpt = false;
	const scripts = doc.scripts;
	for (let i = 0; i < scripts.length && i < MAX_SCRIPTS && !cfChlOpt; i++) {
		const s = scripts[i];
		if (s.src !== "") continue;
		const code = s.textContent ?? "";
		if (code.length <= MAX_SCRIPT_CHARS && code.includes("_cf_chl_opt")) cfChlOpt = true;
	}

	// innerText is the text as rendered: what a reader would see.
	let text = "";
	try {
		text = doc.body === null ? "" : String(doc.body.innerText ?? "");
	} catch {
		text = "";
	}
	if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
	const shown = text.replace(/\s+/g, " ").trim();

	return {
		ok: true,
		title_interstitial: TITLES.includes(title),
		cf_challenge: cfChallenge,
		turnstile,
		datadome,
		recaptcha,
		hcaptcha,
		reddit_block: shown.length < 5000 && shown.toLowerCase().includes("blocked by network security"),
		consent,
		cf_chl_opt: cfChlOpt,
		text_len: shown.length,
	};
})();
