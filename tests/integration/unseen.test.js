// What no visitor sees, in a real browser: the pages the extractor's smoke
// test reads in Chromium, read here by the add-on in headless Firefox. Styles
// are written differently by each browser (a colour, a shape, the style of an
// element that is in no tree), and only an add-on can look into a closed
// shadow tree; this is where that is shown to hold.
//
// The jobs run in a window that counts as hidden (tuning.forceHidden, absent
// from every release build), so that the quiet check of content/quiet.js is on
// their way as well.
//
// Run with: npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./harness.js";

/** @type {Awaited<ReturnType<typeof startHarness>>} */
let h;
let seq = 0;

before(async () => {
	h = await startHarness({ tuning: { forceHidden: true } });
});

after(async () => {
	if (h !== undefined) await h.stop();
});

/** @param {string} name a page of tests/browser-smoke/fixtures @returns {Promise<any>} the result of reading it */
async function read(name) {
	seq += 1;
	const res = await h.submitJob({ kind: "fetch", url: h.fixtures.url("a", `/smoke/${name}.html?n=${seq}`), wait: { timeout_ms: 15000, settle_ms: 400, dwell_ms: 0 }, extract: { html: true } });
	assert.equal(res.status, 200, res.text.slice(0, 300));
	assert.equal(res.json.result.outcome, "ok", JSON.stringify(res.json.result.error));
	return res.json.result;
}

/** @param {any} r @returns {string} every view of a result, as one text */
const everything = (r) => `${r.content.markdown}\n${r.content.text}\n${r.content.html}\n${JSON.stringify(r.content.links)}\n${JSON.stringify(r.page)}`;

test("hidden-text probes: 49 of 51 ways of hiding text are left out, and 44 things that merely look like one stay", async () => {
	const r = await read("probes");
	const all = everything(r);
	const probes = [
		...["DISPLAY", "VISIBILITY", "FONTZERO", "SCALE3D", "OPACITYZERO", "OFFLEFT", "ATTR"],
		...["TRANSPARENT", "SAMECOLOUR", "SAMECOLOURBOX", "ALPHAZERO", "FONTONE", "OPACITYLOW", "FILTER", "MASK", "CLIPPOLYGON", "CLIPINSET", "ROTATEY", "ROTATEX", "FARRIGHT", "FARBOTTOM", "OVERLAY", "SRONLY", "ZEROWIDTH", "INDENT"],
		...["ZEROHEIGHT", "MAXHEIGHT", "NOWIDTH", "NEARLEFT", "NEARTOP", "SHIFTED", "SCALETINY", "SCALEPROPTINY", "COLORFN", "OKLCH", "LAB", "SHADOWCLEAR", "STROKESAME", "CLIPTEXT", "WHITEWASH"],
		...["NEARCOLOUR", "ALPHA98", "BLUR", "INVERT", "MASKURL", "CLIPPOINT", "CLIPURL", "CLIPXYWH", "CLIPRECT", "FONTTWO", "OPACITY12"],
	];
	assert.equal(new Set(probes).size, 51);
	const survivors = probes.filter((name) => new RegExp(`PROBEHID-${name}\\b`).test(all)).sort();
	// The two that are left: text under an opaque box laid over it, and text behind a mask that is a picture.
	assert.deepEqual(survivors, ["MASKURL", "OVERLAY"]);
	for (const name of ["FIXEDRIGHT", "INDENTCLIP", "NESTEDOPACITY", "ALPHALOW", "SCALEPROP", "MARGIN"]) assert.equal(all.includes(`PROBEHIDX-${name}`), false, `PROBEHIDX-${name}`);
	assert.equal((all.match(/attacker\.example/g) ?? []).length, (all.match(/PROBEHID-(OVERLAY|MASKURL)\b/g) ?? []).length, "the injected sentence occurs with those two only");
	// Content that shares a property with a hiding place, and is none.
	const visible = [
		...["PLAIN", "DETAILS", "DETAILSCODE", "TABPANEL", "MENU", "LOWCONTRAST", "GRADIENT", "HERO", "DARKBOX", "PSEUDO", "SLIDEONE", "SLIDEFIVE", "STICKY", "WIDECELL", "FOLDED", "SHADOW", "HALF", "TIP", "SMALL", "HANGING"],
		...["PANEL", "ACCORDION", "REGION", "GRIDROW", "DRAWER", "SIDENAV", "DUSK", "DAWN", "NIGHT", "OKLCH", "LAB", "LIGHTGREY", "TINYPRINT", "HALFSIZE", "TEASER", "OUTLINE", "GLOW", "ROUNDED", "ONELINE"],
		...["BACKDROP", "NEGATIVE", "NEGATIVESPAN", "CELL", "END"],
	];
	assert.equal(visible.length, 44);
	assert.deepEqual(visible.filter((name) => !r.content.text.includes(`PROBEVIS-${name}`)), [], "all of them in the visible text");
	assert.ok(r.extraction.hidden_removed >= 54, `removed: ${r.extraction.hidden_removed}`);
});

test("a page made for a dark canvas, and the edges of a page that runs from right to left", async () => {
	const dark = await read("dark");
	const allDark = everything(dark);
	assert.deepEqual(["CANVAS", "NEARBLACK", "OTHERBLACK", "WHITEINBOX"].filter((name) => allDark.includes(`DARKHID-${name}`)), [], "letters in the colour of the dark canvas, or of the box they are in");
	assert.deepEqual(["MAIN", "DIM", "NOTE", "END"].filter((name) => !dark.content.text.includes(`DARKVIS-${name}`)), []);
	const edges = await read("edges");
	const allEdges = everything(edges);
	assert.deepEqual(["FARLEFT", "BEYONDSTART", "SPACER"].filter((name) => allEdges.includes(`EDGEHID-${name}`)), []);
	assert.deepEqual(["MAIN", "NOTE", "END"].filter((name) => !edges.content.text.includes(`EDGEVIS-${name}`)), []);
	assert.equal(/attacker\.example/.test(allDark + allEdges), false);
});

test("shadow trees are read as the page shows them - closed ones too, which the add-on can look into", async () => {
	const r = await read("shadow");
	const all = everything(r);
	const hidden = ["LEGACY", "TEMPLATE", "ODDMODE", "INNER", "INNERPLAIN", "BARE", "UNSLOTTED", "SLOTHIDDEN", "SLOTFAINT", "WRONGNAME", "NESTED", "ATTR", "CLOSEDBARE", "CLOSEDUNSLOTTED"];
	assert.deepEqual(hidden.filter((name) => new RegExp(`SHADOWHID-${name}\\b`).test(all)), []);
	const shown = ["MAIN", "LEGACYHOST", "INNER", "INNERPLAIN", "NOSLOT", "NAMED", "SLOTTEDTEXT", "SLOTTED", "FALLBACK", "NESTED", "ATTRHOST", "CLOSED", "END"];
	assert.deepEqual(shown.filter((name) => !new RegExp(`SHADOWVIS-${name}\\b`).test(r.content.markdown)), [], r.content.markdown);
	assert.equal(/attacker\.example/.test(all), false);
	assert.equal(r.extraction.view, "article");
});

test("data a page keeps where no visitor looks: an attribute and scripts of the bundle's site extractors, schema.org text, the parts of a drawing, a noscript element", async () => {
	const store = await read("store");
	assert.equal(/STOREHID|attacker\.example/.test(everything(store)), false);
	assert.deepEqual([store.page.extractor.includes("+"), store.page.title, store.extraction.view], [false, "How tea is made", "article"]);
	assert.ok(store.content.markdown.includes("STOREVIS-MAIN") && store.content.markdown.includes("STOREVIS-END"));

	const schema = await read("schema");
	assert.equal(/SCHEMAHID|attacker\.example/.test(everything(schema)), false);
	assert.ok(schema.content.markdown.includes("SCHEMAVIS-MAIN"));
	assert.deepEqual([schema.page.author, schema.page.site], ["Rosa Lindqvist", "Mill Street Library"], "the rest of the data is used");

	const drawing = await read("drawing");
	const allDrawing = everything(drawing);
	assert.deepEqual([...allDrawing.matchAll(/DRAWHID-([A-Z]+)/g)].map((m) => m[1]).filter((name) => name !== "FORMULA"), []);
	assert.deepEqual(["MAIN", "ONBAR", "JANUARY", "FEBRUARY", "OUTLINED", "UNITS", "END"].filter((name) => !drawing.content.markdown.includes(`DRAWVIS-${name}`)), [], drawing.content.markdown);
	assert.equal(/<svg/i.test(drawing.content.markdown + drawing.content.html), false);

	const forum = await read("forum");
	assert.equal(forum.extraction.view, "full_page");
	assert.equal(/FORUMNOSCRIPT|attacker\.example|<noscript/i.test(everything(forum)), false);
	assert.ok(forum.content.markdown.includes("FORUMREPLY2-MAIN"));
});

test("a page that names its frames like the things the content scripts keep: read all the same, quiet check and all", async () => {
	const r = await read("frames");
	assert.equal(r.render.visibility, "hidden", "the path with the quiet check");
	assert.equal(r.render.settled, true);
	assert.deepEqual([r.extraction.view, r.page.extractor.startsWith("defuddle@")], ["article", true]);
	assert.ok(r.content.markdown.includes("FRAMESVIS-MAIN") && r.content.markdown.includes("FRAMESVIS-END"));
	assert.doesNotMatch(h.browserLog(), /job\.extract_fallback/);
});
