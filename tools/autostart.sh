#!/bin/sh
# Start the gateway daemon at login, without a systemd unit.
#
#   tools/autostart.sh install   write ~/.config/autostart/browser-gateway.desktop
#   tools/autostart.sh remove    take exactly that file away again
#   tools/autostart.sh status    say whether it is there, and whether it is as this tool writes it
#
# The one file this tool writes is a desktop entry that runs
# "python3 <this checkout>/cli/bgw daemon start" when the desktop session
# begins. Nothing else is touched, nothing is started now, and a file of that
# name that this tool did not write is neither overwritten nor removed.
#
# A daemon started this way is a plain process of yours: no sandbox around it,
# and nothing holds its port while it is not running (the systemd units in this
# directory give both). Until it is up, and whenever it is down, any local
# program can listen on the port. The gateway's own clients do not mind: the
# CLI and "bgw mcp" make the listener prove that it holds the token before
# they send anything. A client that sends a static Authorization header to
# the HTTP endpoint has no such protection - register "bgw mcp" instead
# (cli/bgw mcp-config says how).
#
# The sandbox and the host see the same home directory, so this works from
# inside a Flatpak sandbox as well; the sandbox's own XDG_CONFIG_HOME is
# never used.
#
# For tests: BGW_AUTOSTART_DIR=<directory> is used instead of ~/.config/autostart.
set -eu

NAME=browser-gateway.desktop
TAG="X-Browser-Gateway-Autostart=1"

die() {
	echo "autostart: $*" >&2
	exit 2
}

if [ -n "${BGW_AUTOSTART_DIR:-}" ]; then
	case $BGW_AUTOSTART_DIR in
		/*) DIR=$BGW_AUTOSTART_DIR ;;
		*) die "BGW_AUTOSTART_DIR must be an absolute path" ;;
	esac
else
	[ -n "${HOME:-}" ] || die "HOME is not set"
	DIR="$HOME/.config/autostart"
fi
FILE="$DIR/$NAME"

# With a mark behind it, so that a line break at the very end of the path is
# not lost to the command substitution: it must be seen, to be refused below.
ROOT=$(cd "$(dirname "$0")/.." && pwd -P && printf x)
ROOT=${ROOT%?x}
BGW="$ROOT/cli/bgw"

# The Exec line of a desktop entry: an argument in double quotes, in which
# backslash, double quote, backtick and dollar are escaped; then every
# backslash once more, as in any string value of such a file; a percent sign
# is doubled. A path with a line break or another control character in it
# cannot be written at all: a desktop entry is made of lines.
#
# Prints the quoted argument and returns 0, or prints nothing and returns 1.
# It is called in a command substitution, where an exit would only end the
# substitution: the caller looks at what it returns.
exec_quote() {
	case $1 in
		*[[:cntrl:]]*) return 1 ;;
	esac
	quoted=$(printf '%s' "$1" | sed -e 's/[\\"`$]/\\&/g' -e 's/\\/\\\\/g' -e 's/%/%%/g') || return 1
	# One line went in, one line must have come out.
	case $quoted in
		*[[:cntrl:]]*) return 1 ;;
	esac
	[ -n "$quoted" ] || return 1
	printf '"%s"' "$quoted"
}

# The quoted command, worked out before anything is written. Empty: the path
# of this checkout cannot stand in a desktop entry.
EXEC_ARG=$(exec_quote "$BGW") || EXEC_ARG=

# The entry as this checkout writes it. Only called while EXEC_ARG is set.
entry() {
	cat <<EOF
[Desktop Entry]
Type=Application
Name=Browser Gateway daemon
Comment=Starts the Browser Gateway daemon at login (written by tools/autostart.sh)
Exec=python3 $EXEC_ARG daemon start
Terminal=false
NoDisplay=true
$TAG
EOF
}

# 0: the file is there and is one of this tool's; 1: no file; 2: a file that is not ours.
ours() {
	[ -e "$FILE" ] || [ -L "$FILE" ] || return 1
	[ -f "$FILE" ] && [ ! -L "$FILE" ] && grep -qxF "$TAG" "$FILE" || return 2
	return 0
}

case "${1:-}" in
install)
	# Before anything is made or written.
	[ -n "$EXEC_ARG" ] || die "the path of this checkout holds a line break or another control character and cannot be written into a desktop entry - nothing was written"
	[ -f "$BGW" ] || die "$BGW is missing"
	state=0
	ours || state=$?
	[ "$state" -ne 2 ] || die "$FILE exists and was not written by this tool - not touching it"
	content=$(entry) || die "the desktop entry could not be made - nothing was written"
	# Exactly the eight lines of an entry, the command among them: anything else is not written.
	[ "$(printf '%s\n' "$content" | wc -l)" -eq 8 ] || die "the desktop entry did not come out as eight lines - nothing was written"
	mkdir -p "$DIR"
	tmp="$FILE.bgw-tmp.$$"
	printf '%s\n' "$content" > "$tmp" || {
		rm -f "$tmp"
		die "cannot write $tmp"
	}
	mv -f "$tmp" "$FILE"
	echo "autostart: wrote $FILE"
	echo "autostart: at the next login it runs: python3 $BGW daemon start"
	;;
remove)
	state=0
	ours || state=$?
	case $state in
		1) echo "autostart: not installed ($FILE is not there)" ;;
		2) die "$FILE was not written by this tool - not removing it" ;;
		*)
			rm -f "$FILE"
			echo "autostart: removed $FILE (a daemon that runs now is not stopped: bgw daemon stop)"
			;;
	esac
	;;
status)
	state=0
	ours || state=$?
	case $state in
		1)
			echo "autostart: not installed"
			exit 1
			;;
		2)
			echo "autostart: $FILE exists, but was not written by this tool"
			exit 1
			;;
	esac
	if [ -z "$EXEC_ARG" ]; then
		# No entry could start a daemon from this path, so the one that is there does not.
		echo "autostart: installed ($FILE), but it cannot be one of this checkout: its path holds a line break or another control character"
		exit 1
	fi
	if [ "$(cat "$FILE")" = "$(entry)" ] && [ "$(grep -c '^Exec=' "$FILE")" -eq 1 ] && [ "$(wc -l < "$FILE")" -eq 8 ]; then
		echo "autostart: installed ($FILE), starts the daemon of $ROOT"
	else
		echo "autostart: installed ($FILE), but not as this checkout would write it - run install again"
		exit 1
	fi
	;;
*)
	echo "usage: $0 install|remove|status" >&2
	exit 2
	;;
esac
