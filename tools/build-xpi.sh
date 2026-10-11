#!/bin/sh
# Package extension/ into dist/browser-gateway-<version>.xpi
#
# Never packaged: dev-config.json (test key and loopback exceptions; the build
# refuses to run while one lies in extension/) and background/devhook.js (the
# test control channel, loaded only when a dev config names it).
# Always packaged, and checked: the extractor and the vendored Defuddle bundle
# with the hash its lock file pins.
#
# In a git repository the files of extension/ that git tracks are packaged, as
# they lie in the working tree: a file that is there by accident and was never
# added does not ship. Outside one (a release directory, an unpacked archive)
# everything that lies in extension/ is packaged. The output says which it was.
#
# The file is named by the version of extension/manifest.json. Others look for
# it by the version of package.json (tools/install.sh global), so the build
# stops when the two differ.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ ! -f extension/manifest.json ]; then
	echo "error: extension/manifest.json is missing" >&2
	exit 1
fi
if [ -e extension/dev-config.json ]; then
	echo "error: extension/dev-config.json exists; remove it before building a release XPI" >&2
	exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
	echo "error: python3 is needed to build the XPI" >&2
	exit 1
fi

mkdir -p dist
python3 - "$ROOT" <<'PY'
import hashlib
import json
import os
import re
import subprocess
import sys
import zipfile

root = sys.argv[1]
src = os.path.join(root, "extension")
# Left out by path (relative to extension/, forward slashes).
EXCLUDED = {"dev-config.json", "background/devhook.js"}
# Taken from the repository root into the root of the archive.
LEGAL = ("LICENSE", "THIRD-PARTY-NOTICES.md")


def fail(message):
	print("error: " + message, file=sys.stderr)
	sys.exit(1)


try:
	with open(os.path.join(src, "manifest.json"), encoding="utf-8") as f:
		manifest = json.load(f)
except (OSError, ValueError) as e:
	fail("extension/manifest.json is not valid JSON: %s" % e)
version = manifest.get("version")
if not isinstance(version, str) or not re.fullmatch(r"[0-9]+(\.[0-9]+){1,3}", version):
	fail("extension/manifest.json has no usable version")
try:
	with open(os.path.join(root, "package.json"), encoding="utf-8") as f:
		package_version = json.load(f).get("version")
except (OSError, ValueError) as e:
	fail("package.json cannot be read: %s" % e)
if package_version != version:
	fail(
		"extension/manifest.json says version %s and package.json says %s. The add-on file is named by the first and "
		"looked for by the second: make them the same." % (version, package_version)
	)


def wanted(rel):
	"""Is a file of extension/ one that is packaged at all? rel has forward slashes."""
	parts = rel.split("/")
	if any(p.startswith(".") for p in parts) or parts[-1].endswith((".swp", "~")):
		return False
	return rel not in EXCLUDED and parts[-1] != "dev-config.json"


def lying_there():
	"""Everything in extension/ that would be packaged, as it lies on the disk."""
	found = []
	for folder, dirs, names in os.walk(src):
		dirs[:] = sorted(d for d in dirs if not d.startswith("."))
		for d in dirs:
			# os.walk lists a link to a directory and does not go into it: its files would be missing without a word.
			if os.path.islink(os.path.join(folder, d)):
				fail("refusing to package: extension/%s is a symbolic link to a directory" % os.path.relpath(os.path.join(folder, d), src).replace(os.sep, "/"))
		for name in sorted(names):
			rel = os.path.relpath(os.path.join(folder, name), src).replace(os.sep, "/")
			if wanted(rel):
				found.append(rel)
	return sorted(found)


def tracked():
	"""The files of extension/ that git tracks, and why not where there are none to go by."""
	if not os.path.exists(os.path.join(root, ".git")):
		return None, "this is not a git repository"
	try:
		done = subprocess.run(["git", "-C", root, "ls-files", "-z", "--", "extension"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
	except OSError as e:
		return None, "git could not be run: %s" % e
	except subprocess.CalledProcessError as e:
		return None, "git could not list the tracked files: %s" % e.stderr.decode("utf-8", "replace").strip()
	names = [os.fsdecode(n) for n in done.stdout.split(b"\0") if n]
	if not names:
		return None, "git tracks nothing below extension/ yet"
	return sorted(n[len("extension/"):] for n in names if n.startswith("extension/")), None


if os.path.islink(src):
	fail("refusing to package: extension is a symbolic link")
there = lying_there()
in_git, why_not = tracked()
if in_git is None:
	files = there
	print("packaging what lies in extension/ (%s)" % why_not)
else:
	files = [rel for rel in in_git if wanted(rel)]
	print("packaging the files of extension/ that git tracks, as they are in the working tree")
	for rel in there:
		if rel not in files:
			print("not packaged, git does not track it: extension/" + rel)
for rel in files:
	full = os.path.join(src, rel)
	if os.path.islink(full):
		fail("refusing to package a symbolic link: extension/" + rel)
	if not os.path.isfile(full):
		fail("extension/%s is tracked by git and is not there: restore it, or remove it with git rm" % rel)

out = os.path.join(root, "dist", "browser-gateway-%s.xpi" % version)
tmp = out + ".tmp"
# Fixed timestamps and order: the same sources give the same file.
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
	for rel in files:
		info = zipfile.ZipInfo(rel, date_time=(2020, 1, 1, 0, 0, 0))
		info.compress_type = zipfile.ZIP_DEFLATED
		info.external_attr = 0o644 << 16
		with open(os.path.join(src, rel), "rb") as f:
			z.writestr(info, f.read())
	# The license of the project and the notices of what is bundled go with every copy of the add-on.
	for rel in LEGAL:
		if rel in files:
			fail("extension/%s would be overwritten by the repository's %s" % (rel, rel))
		info = zipfile.ZipInfo(rel, date_time=(2020, 1, 1, 0, 0, 0))
		info.compress_type = zipfile.ZIP_DEFLATED
		info.external_attr = 0o644 << 16
		try:
			with open(os.path.join(root, rel), "rb") as f:
				z.writestr(info, f.read())
		except OSError as e:
			fail("%s is missing: %s" % (rel, e))

# Look at what was written, not at what was meant.
with zipfile.ZipFile(tmp) as z:
	names = z.namelist()
	if z.testzip() is not None:
		fail("the archive is damaged")
	if "manifest.json" not in names:
		fail("manifest.json is not at the root of the archive")
	bad = [n for n in names if n.split("/")[-1] == "dev-config.json" or n in EXCLUDED]
	if bad:
		fail("the archive contains files that must not ship: " + ", ".join(bad))
	if json.loads(z.read("manifest.json").decode("utf-8")).get("version") != version:
		fail("the packaged manifest does not match")
	background = manifest.get("background", {}).get("page")
	if background and background not in names:
		fail("the background page named in the manifest is not in the archive")
	# The extractor needs the vendored bundle, unchanged: the one the lock file pins.
	for needed in ("content/extract.js", "vendor/defuddle.full.js", "vendor/VENDOR.lock.json", "vendor/LICENSE.defuddle") + LEGAL:
		if needed not in names:
			fail("the archive lacks " + needed)
	try:
		lock = json.loads(z.read("vendor/VENDOR.lock.json").decode("utf-8"))
	except ValueError as e:
		fail("vendor/VENDOR.lock.json is not valid JSON: %s" % e)
	if hashlib.sha256(z.read("vendor/defuddle.full.js")).hexdigest() != lock.get("sha256"):
		fail("vendor/defuddle.full.js is not the file VENDOR.lock.json pins (run tools/vendor.mjs)")
os.replace(tmp, out)

with open(out, "rb") as f:
	digest = hashlib.sha256(f.read()).hexdigest()
print("built %s" % out)
print("%d files, %d bytes, sha256 %s" % (len(names), os.path.getsize(out), digest))
PY
