#!/bin/sh
# Wine-in-podman smoke test for the Windows port.
# Usage: tests/wine-smoke/run.sh [smoke|toolchain|shell]   (default: smoke)
# Weak signal: Wine is not Windows. The windows-latest CI job is the real check.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
work=${WINE_SMOKE_WORK:-/home/toby/Documents/Dev/claude-tmp/realbrowser-mcp-gateway/2026-10-20/wine}
image=${WINE_SMOKE_IMAGE:-localhost/bgw-wine-smoke:latest}
mode=${1:-smoke}

if [ -f /.flatpak-info ]; then
	pm() { flatpak-spawn --host podman "$@"; }
	npm_host() { flatpak-spawn --host npm "$@"; }
else
	pm() { podman "$@"; }
	npm_host() { npm "$@"; }
fi

mkdir -p "$work/logs" "$work/nm"

if ! pm image exists "$image"; then
	echo "building $image" >&2
	pm build -t "$image" -f "$here/Containerfile" "$here"
fi

# ws is pure JS: install the production dependencies on the host and mount them read-only.
if [ ! -d "$work/nm/node_modules/ws" ]; then
	cp "$repo/package.json" "$repo/package-lock.json" "$work/nm/"
	(cd "$work/nm" && npm_host ci --omit=dev --ignore-scripts)
fi

case $mode in
	smoke) cmd="sh /repo/tests/wine-smoke/smoke.sh" ;;
	toolchain) cmd="sh /repo/tests/wine-smoke/toolchain.sh" ;;
	shell) cmd="sh" ;;
	*) echo "unknown mode: $mode" >&2; exit 64 ;;
esac

# shellcheck disable=SC2086
exec_flags="--rm"
[ "$mode" = shell ] && exec_flags="--rm -it"
# shellcheck disable=SC2086
pm run $exec_flags \
	-v "$repo:/repo:ro,z" \
	-v "$work/nm/node_modules:/nm/node_modules:ro,z" \
	-v "$work/logs:/logs:rw,z" \
	"$image" $cmd
