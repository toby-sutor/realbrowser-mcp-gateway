// The site a host belongs to. Shared by the daemon (pacing, budgets, cooldowns,
// notifications) and the extension (one pending challenge per site).
// Standard JS only.

import { parseIp } from "./policy.js";
import { inProviderZone, sharedSuffixOf } from "./suffixes.js";

/**
 * The site a host belongs to, for pacing and budgets: the registrable domain,
 * approximated. Subdomains cost nothing to make, so gaps and budgets must not
 * be keyed by the full host name.
 *
 * - Under a name that many owners share (suffixes.js: "co.uk", "github.io",
 *   "s3.amazonaws.com") the site is that name and one label more:
 *   "example.co.uk", "x.github.io". One host there must not be able to use up
 *   the budget of its neighbours, or put all of them on a cooldown.
 * - Below a provider's zone, where hosts are handed out at several depths
 *   ("bucket.s3.eu-west-1.amazonaws.com"), every host is its own site.
 * - Everything else is the last two labels.
 *
 * The table is short. A shared name it does not hold is one site, as before:
 * there the approximation errs towards the larger site.
 *
 * Addresses: an IPv4 address is its own site. An IPv6 address is not - whoever
 * has one has the 2^64 of its network - so the /64 is the site. An IPv4
 * address written as IPv6 is that IPv4 address.
 * @param {string} host as the URL parser gives it; IPv6 literals in brackets
 * @returns {string}
 */
export function siteOf(host) {
	const h = String(host).toLowerCase().replace(/\.$/, "");
	if (h.startsWith("[") || h.includes(":")) {
		const ip = parseIp(h);
		if (ip === null || ip.version !== 6) return h;
		const b = ip.bytes;
		if (b.subarray(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return b.subarray(12).join(".");
		/** @type {string[]} */
		const groups = [];
		for (let i = 0; i < 8; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
		return `[${groups.join(":")}::/64]`;
	}
	if (/^[0-9.]+$/.test(h)) return h;
	const labels = h.split(".");
	if (labels.length <= 2 || labels.includes("")) return h;
	if (inProviderZone(h)) return h;
	const shared = sharedSuffixOf(h);
	const keep = shared === null ? 2 : Math.min(labels.length, shared.split(".").length + 1);
	return labels.slice(-keep).join(".");
}
