#!/bin/sh
# Run a development daemon on the host as a transient systemd user unit.
#
# It is a second, separate gateway: its own port (8792) and its own tokens,
# key and data, so it neither fights the installed socket unit for 8791 nor
# shares tokens with it. Two daemons with the same tokens on different ports
# would let whoever sits on one port borrow the other's proof.
#
#   BGW_PORT        default 8792
#   BGW_CONFIG_DIR  default ~/.config/browser-gateway-dev
#   BGW_DATA_DIR    default ~/.local/share/browser-gateway-dev
#
# No sandbox here: the hardened unit is tools/browser-gateway.service.
set -eu

UNIT=browser-gateway-dev
REPO=$(cd "$(dirname "$0")/.." && pwd)
PORT=${BGW_PORT:-8792}

if [ -f /.flatpak-info ]; then
	host() { flatpak-spawn --host "$@"; }
else
	host() { "$@"; }
fi

# The literal home directory of the host user, not what a sandbox calls home.
# The single quotes are meant: $HOME is for the shell on the host to fill in.
# shellcheck disable=SC2016
HOST_HOME=$(host sh -c 'printf %s "$HOME"')
CONFIG_DIR=${BGW_CONFIG_DIR:-$HOST_HOME/.config/browser-gateway-dev}
DATA_DIR=${BGW_DATA_DIR:-$HOST_HOME/.local/share/browser-gateway-dev}

case "${1:-}" in
start)
	host systemd-run --user --unit="$UNIT" --collect \
		--working-directory="$REPO" \
		--setenv=BGW_PORT="$PORT" \
		--setenv=BGW_CONFIG_DIR="$CONFIG_DIR" \
		--setenv=BGW_DATA_DIR="$DATA_DIR" \
		-p UMask=0077 \
		node daemon/src/main.js
	echo "for cli/bgw: BGW_URL=http://127.0.0.1:$PORT BGW_TOKEN_FILE=$CONFIG_DIR/client.token BGW_ADMIN_TOKEN_FILE=$CONFIG_DIR/admin.token"
	;;
stop)
	host systemctl --user stop "$UNIT" || true
	;;
restart)
	"$0" stop
	"$0" start
	;;
status)
	host systemctl --user is-active "$UNIT" || true
	curl -s "http://127.0.0.1:$PORT/healthz" || echo "healthz: no response"
	echo
	;;
logs)
	host journalctl --user -u "$UNIT" --no-pager -n 100
	;;
*)
	echo "usage: $0 start|stop|restart|status|logs" >&2
	exit 2
	;;
esac
