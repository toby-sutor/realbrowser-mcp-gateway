import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Where tests keep their files. Never the system temp directory: set
 * BGW_TEST_TMPDIR (npm test reads it from an optional .env.test), otherwise a
 * git-ignored folder inside the repo is used.
 */
export const TMP_ROOT = path.resolve(process.env.BGW_TEST_TMPDIR || path.join(repoRoot, ".test-tmp"));

/** @type {Set<string>} directories made here and not yet removed */
const live = new Set();

// Safety net: a test that fails before its own cleanup must not leave files
// (they hold test tokens and keys) behind.
process.on("exit", () => {
	for (const dir of live) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// nothing more can be done at exit
		}
	}
});

/**
 * @param {string} label
 * @returns {string} a fresh private directory
 */
export function makeTempDir(label) {
	fs.mkdirSync(TMP_ROOT, { recursive: true });
	const dir = fs.mkdtempSync(path.join(TMP_ROOT, `bgw-${label}-`));
	live.add(dir);
	return dir;
}

/** @param {string} dir a directory made by makeTempDir */
export function removeTempDir(dir) {
	const resolved = path.resolve(dir);
	if (!resolved.startsWith(TMP_ROOT + path.sep)) throw new Error(`refusing to remove ${resolved}: outside the test temp root`);
	fs.rmSync(resolved, { recursive: true, force: true });
	live.delete(resolved);
}
