// tools/build-xpi.sh in a scratch copy of what it reads: the script, extension/, package.json and the two legal
// files, below the tests' temp root. The real dist/ is never written. What goes into the archive is read back
// from the archive.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

const REPO = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "extension", "manifest.json"), "utf8")).version;

/** @returns {string | false} why the tests cannot run here */
function skipReason() {
	if (process.platform === "win32") return "a POSIX shell script";
	for (const tool of ["sh", "python3", "git"]) {
		if (spawnSync(tool, ["--version"], { stdio: "ignore" }).error !== undefined) return `${tool} is not available`;
	}
	return false;
}
const SKIP = skipReason();

/** @type {string} */
let tmp;
before(() => {
	tmp = makeTempDir("xpi");
});
after(() => {
	removeTempDir(tmp);
});

/** @param {string} name @param {() => void} fn */
function t(name, fn) {
	test(name, { skip: SKIP }, fn);
}

/** @returns {string} a copy of what the build reads, without a dev config and without a .git */
function copy() {
	const dir = fs.mkdtempSync(path.join(tmp, "c-"));
	fs.mkdirSync(path.join(dir, "tools"));
	fs.copyFileSync(path.join(REPO, "tools", "build-xpi.sh"), path.join(dir, "tools", "build-xpi.sh"));
	for (const name of ["package.json", "LICENSE", "THIRD-PARTY-NOTICES.md"]) fs.copyFileSync(path.join(REPO, name), path.join(dir, name));
	fs.cpSync(path.join(REPO, "extension"), path.join(dir, "extension"), { recursive: true, filter: (src) => path.basename(src) !== "dev-config.json" });
	return dir;
}

/** @param {string} dir @returns {{ code: number | null, stdout: string, stderr: string }} */
function build(dir) {
	assert.ok(path.resolve(dir).startsWith(tmp + path.sep), "only a scratch copy is ever built");
	const r = spawnSync("sh", [path.join(dir, "tools", "build-xpi.sh")], { cwd: dir, encoding: "utf8" });
	return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** @param {string} dir @param {string[]} args */
function git(dir, args) {
	const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

/** @param {string} dir @returns {string[]} the names in the archive the build made */
function packaged(dir) {
	const r = spawnSync("python3", ["-c", "import json, sys, zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))", path.join(dir, "dist", `browser-gateway-${VERSION}.xpi`)], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout);
}

/** @param {string} dir @returns {string[]} what lies in dist/ */
const dist = (dir) => (fs.existsSync(path.join(dir, "dist")) ? fs.readdirSync(path.join(dir, "dist")) : []);

t("outside a repository everything that lies in extension/ is packaged, and the output says so", () => {
	const dir = copy();
	fs.writeFileSync(path.join(dir, "extension", "extra.js"), "// lies there\n");
	const r = build(dir);
	assert.equal(r.code, 0, r.stderr);
	const lines = r.stdout.split("\n");
	assert.equal(lines[0], "packaging what lies in extension/ (this is not a git repository)");
	assert.equal(lines[1], `built ${path.join(dir, "dist", `browser-gateway-${VERSION}.xpi`)}`);
	assert.match(lines[2], /^\d+ files, \d+ bytes, sha256 [0-9a-f]{64}$/);
	const names = packaged(dir);
	for (const name of ["manifest.json", "extra.js", "background/main.js", "vendor/defuddle.full.js", "LICENSE", "THIRD-PARTY-NOTICES.md"]) assert.ok(names.includes(name), name);
	assert.equal(names.includes("background/devhook.js"), false);
});

t("in a repository only what git tracks is packaged: a file that lies there by accident is named and left out", () => {
	const dir = copy();
	git(dir, ["init", "-q"]);
	// A repository in which nothing was added yet (the public tree before its first commit): the files on the disk.
	const bare = build(dir);
	assert.equal(bare.code, 0, bare.stderr);
	assert.equal(bare.stdout.split("\n")[0], "packaging what lies in extension/ (git tracks nothing below extension/ yet)");
	fs.rmSync(path.join(dir, "dist"), { recursive: true });

	git(dir, ["add", "extension"]);
	fs.writeFileSync(path.join(dir, "extension", "notes-to-self.txt"), "not for the add-on\n");
	fs.mkdirSync(path.join(dir, "extension", "scratch"));
	fs.writeFileSync(path.join(dir, "extension", "scratch", "try.js"), "// an experiment\n");
	// A tracked file that was changed and not committed is packaged as it is now.
	fs.appendFileSync(path.join(dir, "extension", "background", "main.js"), "\n// edited\n");
	const r = build(dir);
	assert.equal(r.code, 0, r.stderr);
	const lines = r.stdout.split("\n");
	assert.equal(lines[0], "packaging the files of extension/ that git tracks, as they are in the working tree");
	assert.deepEqual(lines.slice(1, 3), ["not packaged, git does not track it: extension/notes-to-self.txt", "not packaged, git does not track it: extension/scratch/try.js"]);
	assert.match(lines[3], /^built /);
	const names = packaged(dir);
	assert.deepEqual(names.filter((n) => /notes-to-self|scratch/.test(n)), []);
	for (const name of ["manifest.json", "background/main.js", "content/extract.js", "vendor/defuddle.full.js", "LICENSE"]) assert.ok(names.includes(name), name);
	// The same set as a build of the tracked files alone: what git lists, less the two that never ship, plus the legal files.
	const tracked = spawnSync("git", ["-C", dir, "ls-files", "extension"], { encoding: "utf8" }).stdout.split("\n").filter((l) => l !== "").map((l) => l.slice("extension/".length));
	assert.deepEqual([...names].sort(), [...tracked.filter((n) => n !== "background/devhook.js" && n !== "dev-config.json"), "LICENSE", "THIRD-PARTY-NOTICES.md"].sort());
	const edited = spawnSync("python3", ["-c", "import sys, zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read('background/main.js').decode()[-10:])", path.join(dir, "dist", `browser-gateway-${VERSION}.xpi`)], { encoding: "utf8" });
	assert.equal(edited.stdout, "// edited\n");

	// A tracked file that is gone is an error, not a smaller add-on.
	fs.rmSync(path.join(dir, "dist"), { recursive: true });
	fs.rmSync(path.join(dir, "extension", "shared", "site.js"));
	const gone = build(dir);
	assert.equal(gone.code, 1);
	assert.equal(gone.stderr, "error: extension/shared/site.js is tracked by git and is not there: restore it, or remove it with git rm\n");
	assert.deepEqual(dist(dir), [], "no file and no half-made one");
});

t("the build stops when extension/manifest.json and package.json name different versions", () => {
	const dir = copy();
	const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ ...pkg, version: "99.0.0" }));
	const r = build(dir);
	assert.equal(r.code, 1);
	assert.equal(r.stderr, `error: extension/manifest.json says version ${VERSION} and package.json says 99.0.0. The add-on file is named by the first and looked for by the second: make them the same.\n`);
	assert.deepEqual(dist(dir), []);
	fs.rmSync(path.join(dir, "package.json"));
	const none = build(dir);
	assert.equal(none.code, 1);
	assert.match(none.stderr, /^error: package\.json cannot be read: /);
	assert.deepEqual(dist(dir), []);
});

t("a link in extension/ stops the build: to a file, and to a directory, which would be left out without a word", () => {
	for (const repository of [false, true]) {
		const dir = copy();
		const outside = path.join(dir, "outside");
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, "more.js"), "// from elsewhere\n");
		if (repository) {
			git(dir, ["init", "-q"]);
			git(dir, ["add", "extension"]);
		}
		fs.symlinkSync(outside, path.join(dir, "extension", "shared", "more"));
		const linkedDir = build(dir);
		assert.equal(linkedDir.code, 1, String(repository));
		assert.equal(linkedDir.stderr, "error: refusing to package: extension/shared/more is a symbolic link to a directory\n");
		fs.rmSync(path.join(dir, "extension", "shared", "more"));

		// A file that is a link, among what is packaged.
		fs.rmSync(path.join(dir, "extension", "shared", "site.js"));
		fs.symlinkSync(path.join(outside, "more.js"), path.join(dir, "extension", "shared", "site.js"));
		const linkedFile = build(dir);
		assert.equal(linkedFile.code, 1, String(repository));
		assert.equal(linkedFile.stderr, "error: refusing to package a symbolic link: extension/shared/site.js\n");
		assert.deepEqual(dist(dir), []);
	}
	// extension/ itself.
	const dir = copy();
	fs.renameSync(path.join(dir, "extension"), path.join(dir, "extension.real"));
	fs.symlinkSync(path.join(dir, "extension.real"), path.join(dir, "extension"));
	const r = build(dir);
	assert.equal(r.code, 1);
	assert.equal(r.stderr, "error: refusing to package: extension is a symbolic link\n");
});

t("the two versions of this repository agree", () => {
	assert.equal(JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version, VERSION);
});
