#!/usr/bin/env node
// Vendors the Defuddle browser bundle into extension/vendor/ (unmodified
// upstream file, pinned by hash, no bundler).
//
//   node tools/vendor.mjs --pin <version>   fetch, record the registry integrity in the lock, write files
//   node tools/vendor.mjs                   re-fetch the locked version, verify, reproduce the same bytes
//   node tools/vendor.mjs --check           offline: vendored files must match the lock, exit 1 otherwise
//
// Only registry.npmjs.org is contacted. Tarball unpacking uses node:zlib and a
// minimal tar reader below; the tarball is read in memory and nothing of it
// but the bundle and its licence is ever written to disk.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const PACKAGE = "defuddle";
const REGISTRY = "https://registry.npmjs.org";
const BUNDLE_SRC = "package/dist/index.full.js";
const LICENSE_SRC = "package/LICENSE";
const MAX_TARBALL = 32 * 1024 * 1024;
const MAX_METADATA = 4 * 1024 * 1024;
const MAX_UNPACKED = 128 * 1024 * 1024;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(root, "extension", "vendor");
const lockPath = join(vendorDir, "VENDOR.lock.json");
const bundlePath = join(vendorDir, "defuddle.full.js");
const licensePath = join(vendorDir, "LICENSE.defuddle");

/** @param {string} msg @returns {never} */
function die(msg) {
	console.error(`vendor: ${msg}`);
	process.exit(1);
}

/** @param {Buffer | string} data @param {"sha256" | "sha512"} alg @param {"hex" | "base64"} enc */
const digest = (data, alg, enc) => createHash(alg).update(data).digest(enc);
const sha256Hex = (/** @type {Buffer} */ data) => digest(data, "sha256", "hex");
const integrityOf = (/** @type {Buffer} */ data) => `sha512-${digest(data, "sha512", "base64")}`;

/**
 * The body of a response, read piece by piece and given up the moment it is
 * larger than the limit. A Content-Length that says so ends it before the
 * first piece; a body that just goes on is never held whole.
 * @param {Response} res
 * @param {number} max bytes
 * @returns {Promise<Buffer>}
 */
export async function readCapped(res, max) {
	const declared = Number(res.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > max) {
		await res.body?.cancel();
		throw new Error(`the server announces ${declared} bytes, more than the ${max} that are taken`);
	}
	if (res.body === null) return Buffer.alloc(0);
	const reader = res.body.getReader();
	/** @type {Uint8Array[]} */
	const pieces = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			throw new Error(`the body is larger than the ${max} bytes that are taken`);
		}
		pieces.push(value);
	}
	return Buffer.concat(pieces);
}

/** @param {string} url @param {number} max bytes */
async function download(url, max) {
	if (!url.startsWith(`${REGISTRY}/`)) die(`refusing to fetch outside ${REGISTRY}: ${url}`);
	const res = await fetch(url, { redirect: "error" });
	if (!res.ok) die(`GET ${url} -> HTTP ${res.status}`);
	try {
		return await readCapped(res, max);
	} catch (e) {
		return die(`GET ${url}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Minimal ustar/pax reader: regular files only. Names come from the pax "path"
 * record or the GNU long-name block when present.
 * @param {Buffer} tar
 * @returns {Map<string, Buffer>}
 */
export function readTar(tar) {
	/** @type {Map<string, Buffer>} */
	const files = new Map();
	let off = 0;
	let total = 0;
	/** @type {string | null} */
	let nextName = null;
	const cstr = (/** @type {number} */ s, /** @type {number} */ n) => {
		const slice = tar.subarray(s, s + n);
		const z = slice.indexOf(0);
		return slice.subarray(0, z < 0 ? n : z).toString("utf8");
	};
	while (off + 512 <= tar.length) {
		const hdr = tar.subarray(off, off + 512);
		if (hdr.every((b) => b === 0)) break;
		const sizeField = cstr(off + 124, 12).trim();
		const size = Number.parseInt(sizeField, 8);
		if (!Number.isSafeInteger(size) || size < 0) die("bad tar size field");
		const type = String.fromCharCode(hdr[156] || 48);
		let name = cstr(off, 100);
		const prefix = cstr(off + 345, 155);
		if (prefix !== "" && cstr(off + 257, 5) === "ustar") name = `${prefix}/${name}`;
		const body = tar.subarray(off + 512, off + 512 + size);
		if (body.length !== size) die("truncated tar");
		off += 512 + Math.ceil(size / 512) * 512;
		if (type === "x") {
			for (const m of body.toString("utf8").matchAll(/(\d+) path=([^\n]*)\n/g)) nextName = m[2];
			continue;
		}
		if (type === "L") {
			nextName = body.toString("utf8").replace(/\0[\s\S]*$/, "");
			continue;
		}
		if (type === "g") continue;
		if (nextName !== null) {
			name = nextName;
			nextName = null;
		}
		if (type !== "0") continue;
		total += size;
		if (total > MAX_UNPACKED) die("tarball unpacks too large");
		files.set(name, Buffer.from(body));
	}
	return files;
}

/** @returns {Record<string, any> | null} */
function readLock() {
	if (!existsSync(lockPath)) return null;
	try {
		return JSON.parse(readFileSync(lockPath, "utf8"));
	} catch {
		return die("lock file is not valid JSON");
	}
}

function check() {
	const lock = readLock();
	if (lock === null) die("no lock file");
	let bad = 0;
	for (const [path, want, label] of /** @type {const} */ ([
		[bundlePath, lock.sha256, "defuddle.full.js"],
		[licensePath, lock.license_sha256, "LICENSE.defuddle"],
	])) {
		if (!existsSync(path)) {
			console.error(`MISSING ${label}`);
			bad++;
			continue;
		}
		const got = sha256Hex(readFileSync(path));
		if (got !== want) {
			console.error(`MISMATCH ${label}: lock ${want} actual ${got}`);
			bad++;
		} else console.log(`ok ${label} sha256 ${got}`);
	}
	if (bad > 0) process.exit(1);
	console.log(`vendor check passed: ${lock.package}@${lock.version}`);
}

/** @param {string} version */
async function fetchVersion(version) {
	/** @type {any} */
	let meta;
	try {
		meta = JSON.parse((await download(`${REGISTRY}/${PACKAGE}/${encodeURIComponent(version)}`, MAX_METADATA)).toString("utf8"));
	} catch {
		return die(`registry metadata for ${PACKAGE}@${version} is not valid JSON`);
	}
	if (meta === null || typeof meta !== "object") die(`registry metadata for ${PACKAGE}@${version} is not an object`);
	if (meta.name !== PACKAGE || meta.version !== version) die("registry returned a different package or version");
	const url = meta.dist?.tarball;
	const registryIntegrity = meta.dist?.integrity;
	if (typeof url !== "string" || typeof registryIntegrity !== "string") die("registry metadata lacks dist.tarball or dist.integrity");
	if (meta.license !== "MIT") die(`registry license is ${meta.license}, expected MIT`);
	const tgz = await download(url, MAX_TARBALL);
	if (integrityOf(tgz) !== registryIntegrity) die("tarball does not match the registry integrity");
	return { url, registryIntegrity, tgz };
}

/** @param {string | undefined} pin */
async function run(pin) {
	const lock = readLock();
	const version = pin ?? lock?.version;
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) die("need --pin <x.y.z> or an existing lock");
	const { url, registryIntegrity, tgz } = await fetchVersion(version);
	if (lock !== null && lock.version === version && lock.integrity !== registryIntegrity) {
		die(`INTEGRITY MISMATCH for ${version}: lock ${lock.integrity}, registry ${registryIntegrity}`);
	}

	const files = readTar(gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED }));
	const bundle = files.get(BUNDLE_SRC);
	const licence = files.get(LICENSE_SRC);
	const pkgJson = files.get("package/package.json");
	if (!bundle || !licence || !pkgJson) die("tarball lacks the bundle, LICENSE or package.json");
	const pkg = JSON.parse(pkgJson.toString("utf8"));
	if (pkg.name !== PACKAGE || pkg.version !== version) die("package.json inside the tarball disagrees");
	if (pkg.license !== "MIT" || !/^MIT License/.test(licence.toString("utf8"))) die("licence is not MIT");

	const bundleHash = sha256Hex(bundle);
	const licenceHash = sha256Hex(licence);
	if (lock !== null && lock.version === version) {
		if (lock.sha256 !== bundleHash) die("bundle bytes differ from the lock for the same version");
		if (lock.license_sha256 !== licenceHash) die("licence bytes differ from the lock for the same version");
	}
	mkdirSync(vendorDir, { recursive: true });
	writeFileSync(bundlePath, bundle);
	writeFileSync(licensePath, licence);
	const unchanged = lock !== null && lock.version === version;
	const out = {
		package: PACKAGE,
		version,
		tarball: url,
		integrity: registryIntegrity,
		source_path: BUNDLE_SRC,
		sha256: bundleHash,
		license: "MIT",
		license_source_path: LICENSE_SRC,
		license_sha256: licenceHash,
		global: "Defuddle",
		date: unchanged ? lock.date : new Date().toISOString().slice(0, 10),
	};
	writeFileSync(lockPath, `${JSON.stringify(out, null, "\t")}\n`);
	console.log(`${unchanged ? "verified" : "pinned"} ${PACKAGE}@${version} sha256 ${bundleHash} (${bundle.length} bytes)`);
}

/** @returns {boolean} started as a program, not imported (by a test of the two readers above) */
function isMain() {
	if (process.argv[1] === undefined) return false;
	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isMain()) {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--check") check();
	else if (args.length === 0) await run(undefined);
	else if (args.length === 2 && args[0] === "--pin") await run(args[1]);
	else die("usage: vendor.mjs [--check | --pin <version>]");
}
