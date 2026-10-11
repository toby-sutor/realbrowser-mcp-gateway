#!/bin/sh
# Set up how the Browser Gateway daemon gets started on this machine.
#
#   sh tools/install.sh user                      systemd user units for you alone
#   sudo sh tools/install.sh global [--prefix DIR] [--node PATH] [--no-link]
#                                                 systemd user units for every user of
#                                                 the machine (run once, as root)
#   sh tools/install.sh on-demand                 no systemd: bgw and "bgw mcp" start
#                                                 the daemon when it is not running
#   sh tools/install.sh status                    what is installed for you, and what
#                                                 does not fit together (reads only)
#   sh tools/install.sh uninstall user [--purge]
#   sudo sh tools/install.sh uninstall global [--prefix DIR]
#   sh tools/install.sh uninstall on-demand [--purge]
#   sh tools/install.sh --help
#
# user       Three units in ~/.config/systemd/user: browser-gateway.socket holds
#            127.0.0.1:8791 from login on, browser-gateway.service is the daemon,
#            started by the first connection and handed that socket, and
#            browser-gateway-dirs.service makes the daemon's two directories. The
#            port is never free for another process to sit on. The service runs
#            the daemon from this checkout, so the checkout has to stay where it is,
#            with the node that is first on your PATH now: its path is written into
#            the unit. The unit hides the home directories from the daemon, so a
#            node below one of them (nvm, fnm, volta) cannot be used: install node
#            system-wide, or take "on-demand".
# global     The same three units in /etc/systemd/user, enabled for all users. Every
#            user gets a daemon of their own in their own session, with their own
#            tokens in their own home directory. The program is copied to a
#            root-owned directory (default /opt/browser-gateway), because a checkout
#            in a home directory cannot be read by other users, and
#            /usr/local/bin/bgw points at it. Every directory above the copy and
#            above that link has to belong to root and be writable for nobody else;
#            where /usr/local/bin is writable for a group (Debian's "staff"),
#            --no-link leaves the link out. The service finds node on each user's
#            PATH unless --node names one (root-owned, outside every home
#            directory). All users share one port: when two of them are logged in
#            at the same time, the second one's socket unit cannot take it (see
#            README.md).
# on-demand  One file, ~/.config/browser-gateway/on-demand. With it, bgw and
#            "bgw mcp" start the daemon as "bgw daemon start" does when they find
#            nothing on the port. No sandbox, and nothing holds the port while the
#            daemon is down. The daemon is not stopped when idle.
#
# One of the three at a time: "user" and "on-demand" refuse next to each other
# and next to "global", and "user" also while an entry of tools/autostart.sh is
# there. --purge deletes your own config and data directory (tokens, extension
# key, stored pages), never anybody else's, and does not go with "global". It
# deletes a directory only where it finds the gateway's files in it, and never
# a link, the home directory or a directory that is not the gateway's alone.
#
# Running a command without an argument prints this text. "--uninstall" is the
# old spelling of "uninstall user".
#
# Works on the host and from inside a Flatpak sandbox (it then runs itself again
# on the host through flatpak-spawn). "global" needs a terminal on the host.
#
# Exit codes: 0 done, or "status" found nothing wrong; 1 refused or failed, or
# "status" found a problem; 2 wrong usage.
#
# For tests and dry runs - with these set nothing of the real system is touched:
#   BGW_INSTALL_ROOT   a directory that stands in for /: it is put in front of
#                      /etc/systemd/user, the prefix and /usr/local/bin, and it lifts
#                      the must-be-root check. What is written into files stays
#                      without it. Needs BGW_SYSTEMCTL as well.
#   BGW_SYSTEMCTL      a program to call in place of systemctl
#   BGW_UNIT_DIR       in place of ~/.config/systemd/user
#   BGW_CONFIG_DIR, BGW_DATA_DIR, BGW_AUTOSTART_DIR
#                      in place of ~/.config/browser-gateway,
#                      ~/.local/share/browser-gateway and ~/.config/autostart.
#                      The units name the first two themselves, so "user" stops
#                      when one of these variables names another directory.
#   BGW_INSTALL_WAIT_S seconds "user" waits for the daemon to answer, default 10
# And for real use:
#   BGW_PORT           the port, default 8791. It is written into the units; the
#                      clients then need BGW_URL=http://127.0.0.1:<port>.
set -eu

SERVICE=browser-gateway.service
SOCKET=browser-gateway.socket
DIRS=browser-gateway-dirs.service
MARKER=.bgw-install
MARKER_TAG="bgw-install-global=1"
ON_DEMAND=on-demand
DESKTOP_NAME=browser-gateway.desktop
DESKTOP_TAG="X-Browser-Gateway-Autostart=1"
DEFAULT_PREFIX=/opt/browser-gateway

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
SELF="$REPO/tools/install.sh"

# Set by install_global, read by the exit trap.
STAGE=

say() {
	printf '%s\n' "$*"
}

warn() {
	printf 'warning: %s\n' "$*" >&2
}

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

help() {
	sed -n '2,/^set -eu$/p' "$SELF" | sed -e '$d' -e 's/^# \{0,1\}//'
}

# The command lines at the top of this file, and where the rest is.
usage() {
	printf 'error: %s\n\n' "$*" >&2
	sed -n '4,/^#$/p' "$SELF" | sed -e '$d' -e 's/^# \{0,1\}//' >&2
	printf '\nsh tools/install.sh --help says what each of them does.\n' >&2
	exit 2
}

# ---------------------------------------------------------------- command line

COMMAND=
TARGET=
PURGE=no
PREFIX_ARG=
NODE_ARG=
NO_LINK=no
LEGACY=no

parse() {
	if [ $# -eq 0 ]; then
		# The old spelling installed the user units here. Nothing is installed without being named.
		help >&2
		exit 2
	fi
	case $1 in
	-h | --help)
		help
		exit 0
		;;
	user | global | on-demand)
		COMMAND=install
		TARGET=$1
		;;
	status) COMMAND=status ;;
	uninstall)
		COMMAND=uninstall
		shift
		case ${1:-} in
		user | global | on-demand) TARGET=$1 ;;
		*) usage "uninstall needs one of: user, global, on-demand" ;;
		esac
		;;
	--uninstall)
		COMMAND=uninstall
		TARGET=user
		LEGACY=yes
		;;
	*) usage "unknown command: $1" ;;
	esac
	shift
	while [ $# -gt 0 ]; do
		case $1 in
		--purge) PURGE=yes ;;
		--prefix)
			[ $# -ge 2 ] || usage "--prefix needs a directory"
			PREFIX_ARG=$2
			shift
			;;
		--prefix=*) PREFIX_ARG=${1#--prefix=} ;;
		--node)
			[ $# -ge 2 ] || usage "--node needs the path of a node program"
			NODE_ARG=$2
			shift
			;;
		--node=*) NODE_ARG=${1#--node=} ;;
		--no-link) NO_LINK=yes ;;
		-h | --help)
			help
			exit 0
			;;
		*) usage "unknown argument: $1" ;;
		esac
		shift
	done
	if [ "$PURGE" = yes ]; then
		[ "$COMMAND" = uninstall ] || usage "--purge only goes with uninstall"
		# Under sudo the home directory may be root's or the caller's: nobody's data is deleted on a guess.
		[ "$TARGET" != global ] || usage "--purge does not go with global: it deletes the directories of one user. Each user runs: sh tools/install.sh uninstall user --purge"
	fi
	if [ -n "$PREFIX_ARG" ]; then
		[ "$TARGET" = global ] || usage "--prefix only goes with global"
	fi
	if [ -n "$NODE_ARG" ]; then
		[ "$COMMAND $TARGET" = "install global" ] || usage "--node only goes with global"
	fi
	if [ "$NO_LINK" = yes ]; then
		[ "$COMMAND $TARGET" = "install global" ] || usage "--no-link only goes with global"
	fi
}

parse "$@"

# Inside a Flatpak sandbox: systemd, node and the real home directory are the
# host's, so the whole command runs there. Environment variables do not cross
# by themselves; the ones this script reads are handed over by name.
if [ -f /.flatpak-info ]; then
	if [ "$TARGET" = global ] && [ -z "${BGW_INSTALL_ROOT:-}" ]; then
		die "\"global\" needs root: run it with sudo in a terminal on the host, not from inside a sandbox"
	fi
	command -v flatpak-spawn >/dev/null 2>&1 || die "flatpak-spawn is needed to reach the host from inside this sandbox"
	flatpak-spawn --host test -f "$SELF" || die "the host does not see this checkout at $REPO"
	set -- sh "$SELF" "$@"
	for name in BGW_INSTALL_ROOT BGW_SYSTEMCTL BGW_UNIT_DIR BGW_CONFIG_DIR BGW_DATA_DIR BGW_AUTOSTART_DIR BGW_INSTALL_WAIT_S BGW_PORT; do
		eval "value=\${$name:-}"
		[ -z "$value" ] || set -- "--env=$name=$value" "$@"
	done
	exec flatpak-spawn --host "$@"
fi

[ "$LEGACY" = no ] || warn "--uninstall is the old spelling of: uninstall user"

# ---------------------------------------------------------------- environment

# check_dir <name> <value>: an absolute path without control characters.
check_dir() {
	case $2 in
	/*) ;;
	*) die "$1 must be an absolute path" ;;
	esac
	case $2 in
	*[[:cntrl:]]*) die "$1 holds a control character" ;;
	esac
}

ROOT=${BGW_INSTALL_ROOT:-}
if [ -n "$ROOT" ]; then
	check_dir BGW_INSTALL_ROOT "$ROOT"
	ROOT=${ROOT%/}
	# A stand-in root with the real systemctl would write below it and then change the real session.
	[ -n "${BGW_SYSTEMCTL:-}" ] || die "BGW_INSTALL_ROOT needs BGW_SYSTEMCTL as well, so that the systemctl of this machine is not called"
fi
SYSTEMCTL=${BGW_SYSTEMCTL:-systemctl}
# Where the stand-in root really is: what is found below it is named without it.
ROOT_REAL=
if [ -n "$ROOT" ]; then
	ROOT_REAL=$(cd "$ROOT" 2>/dev/null && pwd -P) || ROOT_REAL=$ROOT
fi

[ -n "${HOME:-}" ] || die "HOME is not set"
check_dir HOME "$HOME"
# The literal home directory, never XDG: a sandbox remaps those.
CONFIG_DIR=${BGW_CONFIG_DIR:-$HOME/.config/browser-gateway}
DATA_DIR=${BGW_DATA_DIR:-$HOME/.local/share/browser-gateway}
UNIT_DIR=${BGW_UNIT_DIR:-$HOME/.config/systemd/user}
AUTOSTART_DIR=${BGW_AUTOSTART_DIR:-$HOME/.config/autostart}
check_dir BGW_CONFIG_DIR "$CONFIG_DIR"
check_dir BGW_DATA_DIR "$DATA_DIR"
check_dir BGW_UNIT_DIR "$UNIT_DIR"
check_dir BGW_AUTOSTART_DIR "$AUTOSTART_DIR"
# What the units name (%h/...). The two variables above do not reach a unit.
HOME_REAL=$(cd "$HOME" 2>/dev/null && pwd -P) || HOME_REAL=$HOME
UNIT_CONFIG_DIR=$HOME/.config/browser-gateway
UNIT_DATA_DIR=$HOME/.local/share/browser-gateway
SYS_UNIT_DIR=$ROOT/etc/systemd/user
BIN_LINK=$ROOT/usr/local/bin/bgw

PORT=${BGW_PORT:-8791}
case $PORT in
'' | *[!0-9]* | 0* | ??????*) die "BGW_PORT must be a port number" ;;
esac
[ "$PORT" -le 65535 ] || die "BGW_PORT must be a port number"
WAIT_S=${BGW_INSTALL_WAIT_S:-10}
case $WAIT_S in
'' | *[!0-9]*) die "BGW_INSTALL_WAIT_S must be a number of seconds" ;;
esac

sc() {
	"$SYSTEMCTL" "$@"
}

have_systemctl() {
	command -v "$SYSTEMCTL" >/dev/null 2>&1
}

need_systemctl() {
	have_systemctl || die "systemctl not found (this mode needs systemd; without it: sh tools/install.sh on-demand)"
}

# ---------------------------------------------------------------- paths

# real_path <path>: where something that exists really is, every link followed.
# Prints nothing and fails when the path leads nowhere.
real_path() {
	real_at=$1
	real_n=0
	while [ -L "$real_at" ]; do
		real_n=$((real_n + 1))
		[ "$real_n" -le 40 ] || return 1
		real_to=$(readlink "$real_at") || return 1
		case $real_to in
		/*) real_at=$real_to ;;
		*) real_at=$(dirname "$real_at")/$real_to ;;
		esac
	done
	[ -e "$real_at" ] || return 1
	if [ -d "$real_at" ]; then
		(cd "$real_at" && pwd -P)
	else
		real_dir=$(cd "$(dirname "$real_at")" && pwd -P) || return 1
		printf '%s/%s\n' "${real_dir%/}" "$(basename "$real_at")"
	fi
}

# same_dir <a> <b>: one directory - by name, or, when both are there, by where they really are.
same_dir() {
	[ "${1%/}" != "${2%/}" ] || return 0
	[ -d "$1" ] && [ -d "$2" ] || return 1
	[ "$(cd "$1" && pwd -P)" = "$(cd "$2" && pwd -P)" ]
}

# below <path> <directory>: is the path that directory or something in it?
below() {
	case "$1/" in
	"${2%/}"/*) return 0 ;;
	esac
	return 1
}

# hidden_from_unit <path>: does the path lie where browser-gateway.service cannot
# see it? ProtectHome=tmpfs empties /home, /root and /run/user, PrivateTmp the two
# temporary directories, InaccessiblePaths the rest. A home directory elsewhere is
# hidden as well: the unit mounts an empty one over it.
hidden_from_unit() {
	for hidden_dir in "$HOME" "$HOME_REAL" /home /root /run/user /var/home /tmp /var/tmp /mnt /media /run/media /srv /boot /lost+found; do
		if below "$1" "$hidden_dir"; then
			return 0
		fi
	done
	return 1
}

# In "user" mode the daemon gets its two directories from the unit files. A
# variable that names another one would have this script make, print and (with
# --purge) delete a directory the daemon never used.
need_unit_dirs() {
	same_dir "$CONFIG_DIR" "$UNIT_CONFIG_DIR" || die "BGW_CONFIG_DIR names $CONFIG_DIR, but the systemd units always use $UNIT_CONFIG_DIR - the variable does not reach them. Nothing was changed. Run this again without BGW_CONFIG_DIR."
	same_dir "$DATA_DIR" "$UNIT_DATA_DIR" || die "BGW_DATA_DIR names $DATA_DIR, but the systemd units always use $UNIT_DATA_DIR - the variable does not reach them. Nothing was changed. Run this again without BGW_DATA_DIR."
}

# ---------------------------------------------------------------- what is there

# units_in <dir>: is any of the three units there?
units_in() {
	for units_name in "$SOCKET" "$SERVICE" "$DIRS"; do
		if [ -e "$1/$units_name" ] || [ -L "$1/$units_name" ]; then
			return 0
		fi
	done
	return 1
}

# missing_in <dir>: the names of the units that are not there, on one line.
missing_in() {
	missing_list=
	for missing_name in "$SOCKET" "$SERVICE" "$DIRS"; do
		[ -f "$1/$missing_name" ] || missing_list="$missing_list $missing_name"
	done
	printf '%s' "${missing_list# }"
}

# program_of <dir>: the directory the service unit in <dir> runs the daemon from.
program_of() {
	sed -n 's/^WorkingDirectory=//p' "$1/$SERVICE" 2>/dev/null | head -n 1
}

# port_of <dir>: the port the socket unit in <dir> listens on.
port_of() {
	sed -n 's/^ListenStream=127\.0\.0\.1://p' "$1/$SOCKET" 2>/dev/null | head -n 1
}

has_on_demand() {
	[ -e "$CONFIG_DIR/$ON_DEMAND" ] || [ -L "$CONFIG_DIR/$ON_DEMAND" ]
}

# An entry that tools/autostart.sh wrote. A file of that name that is somebody else's is not looked at.
has_autostart() {
	[ -f "$AUTOSTART_DIR/$DESKTOP_NAME" ] && [ ! -L "$AUTOSTART_DIR/$DESKTOP_NAME" ] && grep -qxF "$DESKTOP_TAG" "$AUTOSTART_DIR/$DESKTOP_NAME"
}

# is_ours <dir>: did "global" make this directory?
is_ours() {
	[ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/$MARKER" ] && [ ! -L "$1/$MARKER" ] && grep -qxF "$MARKER_TAG" "$1/$MARKER"
}

# ---------------------------------------------------------------- node and the port

have_node() {
	command -v node >/dev/null 2>&1
}

node_major() {
	node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

need_node() {
	have_node || die "node not found (Node 24 or newer is needed)"
	need_node_major=$(node_major)
	[ "$need_node_major" -ge 24 ] 2>/dev/null || die "Node 24 or newer is needed, found major version $need_node_major"
}

# The node the service unit of "user" runs: the one that is first on the PATH
# now, by its full path. The PATH of the systemd user manager is not the one of
# this shell, so a bare "node" in the unit could be another one, or none.
# Three places are looked at: where the PATH finds it, where that really is,
# and what node itself says it runs from (a version manager's shim is a small
# program somewhere else). Sets NODE_BIN.
resolve_node() {
	need_node
	node_cmd=$(command -v node)
	case $node_cmd in
	/*) ;;
	*) die "node is not a program on the PATH here (found: $node_cmd)" ;;
	esac
	node_real=$(real_path "$node_cmd") || die "$node_cmd leads nowhere"
	node_exec=$(node -p 'process.execPath' 2>/dev/null) || node_exec=
	for node_at in "$node_cmd" "$node_real" "$node_exec"; do
		if [ -n "$node_at" ] && hidden_from_unit "$node_at"; then
			die "node is at $node_at, and the service unit cannot run it from there: it hides the home directories, /tmp, /mnt, /media and /srv from the daemon. Nothing was installed. Install Node 24 or newer system-wide (the package of your distribution, or below /usr/local or /opt) and run this again, or use the mode without systemd: sh tools/install.sh on-demand"
		fi
	done
	check_unit_path "the path of node" "$node_cmd"
	NODE_BIN=$node_cmd
}

# Does the gateway daemon answer on the port? With a socket unit in place the question starts the daemon.
answers() {
	node -e 'fetch("http://127.0.0.1:" + process.argv[1] + "/healthz", { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).then((j) => process.exit(j && j.name === "browser-gateway" ? 0 : 1), () => process.exit(1))' "$PORT"
}

# Can the port be taken? If not, somebody has it.
port_is_free() {
	node -e 'const s = require("node:net").createServer(); s.once("error", () => process.exit(1)); s.listen(Number(process.argv[1]), "127.0.0.1", () => s.close(() => process.exit(0)))' "$PORT"
}

# Does anything accept a connection on the port? Nothing is sent.
port_listens() {
	node -e 'const s = require("node:net").connect(Number(process.argv[1]), "127.0.0.1"); s.setTimeout(2000, () => { s.destroy(); process.exit(0); }); s.once("connect", () => { s.destroy(); process.exit(0); }); s.once("error", () => process.exit(1))' "$PORT"
}

# ---------------------------------------------------------------- the units

# A path that goes into a unit file: only characters that need no quoting there.
check_unit_path() {
	case $2 in
	*[!A-Za-z0-9/._+-]*) die "$1 contains characters a unit file cannot take as they are: $2" ;;
	esac
}

check_templates() {
	for check_name in "$SERVICE" "$SOCKET" "$DIRS"; do
		[ -f "$REPO/tools/$check_name" ] || die "$REPO/tools/$check_name is missing"
	done
	grep -q '^ListenStream=127\.0\.0\.1:@PORT@$' "$REPO/tools/$SOCKET" || die "$REPO/tools/$SOCKET does not listen on 127.0.0.1:@PORT@"
	grep -q '^ExecStart=@NODE@ @REPO@/daemon/src/main\.js$' "$REPO/tools/$SERVICE" || die "$REPO/tools/$SERVICE does not start @NODE@ @REPO@/daemon/src/main.js"
}

# render_units <directory to write to> <directory the daemon runs from> <what runs node>
# Each unit is written next to its final place and moved over in one step.
render_units() {
	mkdir -p "$1"
	for render_name in "$SERVICE" "$SOCKET" "$DIRS"; do
		render_tmp="$1/$render_name.tmp.$$"
		sed -e "s|@REPO@|$2|g" -e "s|@NODE@|$3|g" -e "s|@PORT@|$PORT|g" "$REPO/tools/$render_name" >"$render_tmp"
		chmod 644 "$render_tmp"
		mv -f "$render_tmp" "$1/$render_name"
		if grep -q '@[A-Z][A-Z_]*@' "$1/$render_name"; then
			die "$1/$render_name was not rendered completely"
		fi
	done
}

port_note() {
	if [ "$PORT" != 8791 ]; then
		say
		say "The port is $PORT, not 8791: the clients need BGW_URL=http://127.0.0.1:$PORT in their"
		say "environment, also where \"bgw mcp\" is registered. Pairing tells the add-on the port."
	fi
}

# ---------------------------------------------------------------- user

install_user() {
	need_unit_dirs
	need_systemctl
	if units_in "$SYS_UNIT_DIR"; then
		die "the units are installed for all users ($SYS_UNIT_DIR): you have a daemon of your own already. To use this checkout instead, remove them first: sudo sh tools/install.sh uninstall global"
	fi
	if has_autostart; then
		die "an autostart entry starts a daemon at login ($AUTOSTART_DIR/$DESKTOP_NAME); it would fight the socket unit for the port. Remove it first: sh tools/autostart.sh remove"
	fi
	if has_on_demand; then
		die "starting on demand is switched on ($CONFIG_DIR/$ON_DEMAND); with a socket unit it would never take effect. Remove it first: sh tools/install.sh uninstall on-demand"
	fi
	check_unit_path "the checkout path" "$REPO"
	check_templates
	[ -f "$REPO/daemon/src/main.js" ] || die "$REPO/daemon/src/main.js is missing"
	resolve_node
	if [ ! -d "$REPO/node_modules/ws" ]; then
		say "installing the daemon's one dependency (ws)..."
		(cd "$REPO" && npm ci --omit=dev --no-audit --no-fund)
	fi
	# The unit shows the daemon this checkout and nothing else of the home
	# directory: a dependency that is a link to somewhere else is not there for it.
	user_ws=$(real_path "$REPO/node_modules/ws") || die "$REPO/node_modules/ws leads nowhere"
	below "$user_ws" "$REPO" || die "$REPO/node_modules/ws is a link to $user_ws, and the service unit shows the daemon nothing outside this checkout. Nothing was installed. Put the dependency into the checkout itself: remove the link and run \"npm ci --omit=dev\" there (for a release made by tools/deploy.sh: prepare it with --install-deps)."

	# Without an active socket unit the port has to be free for it: a daemon of
	# an earlier install without one, or one started as a plain process, holds
	# it itself and has to let go first.
	if ! sc --user is-active --quiet "$SOCKET"; then
		sc --user stop "$SERVICE" 2>/dev/null || true
		if ! port_is_free; then
			if answers; then
				die "a gateway daemon that runs as a plain process holds 127.0.0.1:$PORT. Stop it first: cli/bgw daemon stop"
			fi
			die "another program holds 127.0.0.1:$PORT. Stop it first, or choose another port with BGW_PORT."
		fi
	fi

	# browser-gateway-dirs.service makes these two before every start. They are
	# made here as well, so that a directory that is there with wider
	# permissions is put right now and not left to the daemon.
	mkdir -p "$CONFIG_DIR" "$DATA_DIR"
	chmod 700 "$CONFIG_DIR" "$DATA_DIR"

	# Units of an earlier run are replaced; only units this run brought are its to take away again.
	user_had_units=no
	if units_in "$UNIT_DIR"; then
		user_had_units=yes
	fi
	render_units "$UNIT_DIR" "$REPO" "$NODE_BIN"

	sc --user daemon-reload
	# The service has no [Install] section; an enablement left by an early
	# install would start it at login without its socket.
	sc --user disable "$SERVICE" 2>/dev/null || true
	sc --user enable --now "$SOCKET"
	# A daemon that is already running keeps the old code until it is restarted.
	sc --user try-restart "$SERVICE" 2>/dev/null || true

	# The first request starts the daemon.
	tries=$((WAIT_S * 2))
	i=0
	while :; do
		if answers; then
			break
		fi
		i=$((i + 1))
		if [ "$i" -ge "$tries" ]; then
			if [ "$user_had_units" = yes ]; then
				echo "error: the daemon does not answer on 127.0.0.1:$PORT. The units were there before this run and were replaced by it; they are left in place ($UNIT_DIR)." >&2
				echo "look at: systemctl --user status $SOCKET $SERVICE" >&2
			else
				# The socket first: with it gone nothing starts the daemon again.
				sc --user disable --now "$SOCKET" 2>/dev/null || true
				sc --user stop "$SERVICE" 2>/dev/null || true
				rm -f "$UNIT_DIR/$SOCKET" "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$DIRS"
				sc --user daemon-reload 2>/dev/null || true
				sc --user reset-failed "$SOCKET" "$SERVICE" "$DIRS" 2>/dev/null || true
				echo "error: the daemon does not answer on 127.0.0.1:$PORT. The three units were removed again ($UNIT_DIR): nothing is installed." >&2
			fi
			echo "what the daemon said is in the journal: journalctl --user -u $SERVICE -n 50" >&2
			exit 1
		fi
		sleep 0.5
	done
	say "browser-gateway is installed for you; systemd holds 127.0.0.1:$PORT and starts the daemon on the first connection"
	say "units:  $UNIT_DIR/$SOCKET"
	say "        $UNIT_DIR/$SERVICE"
	say "        $UNIT_DIR/$DIRS"
	say "runs:   $REPO (keep this checkout where it is)"
	say "node:   $NODE_BIN"
	say "config: $CONFIG_DIR"
	say "data:   $DATA_DIR"
	say
	say "Next:"
	say "  1. sh tools/build-xpi.sh, then in the browser: about:addons -> Install Add-on From File -> dist/browser-gateway-<version>.xpi"
	say "  2. cli/bgw pair, and paste the code into the add-on's options page"
	say "  3. cli/bgw doctor"
	say "  4. cli/bgw mcp-config, to register the gateway with your agent"
	port_note
}

uninstall_user() {
	# Before anything is taken away: --purge would delete what the variables name.
	[ "$PURGE" != yes ] || need_unit_dirs
	if units_in "$UNIT_DIR"; then
		need_systemctl
		# The socket first: with it gone nothing starts the daemon again.
		sc --user disable --now "$SOCKET" 2>/dev/null || true
		sc --user disable --now "$SERVICE" 2>/dev/null || true
		rm -f "$UNIT_DIR/$SOCKET" "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$DIRS"
		sc --user daemon-reload
		sc --user reset-failed "$SOCKET" "$SERVICE" "$DIRS" 2>/dev/null || true
		say "removed $SOCKET, $SERVICE and $DIRS from $UNIT_DIR"
	else
		say "the user units are not installed ($UNIT_DIR): nothing to remove"
	fi
	if units_in "$SYS_UNIT_DIR"; then
		say "The units for all users are still installed ($SYS_UNIT_DIR): at your next login they start a daemon for you again."
	fi
	purge_or_keep
}

# ---------------------------------------------------------------- on-demand

install_on_demand() {
	# A socket unit holds the port, so a client never finds it closed and the marker would do nothing.
	if units_in "$UNIT_DIR"; then
		die "the systemd user units are installed ($UNIT_DIR): they start the daemon already, and with the port held nothing is ever started on demand. To switch, remove them first: sh tools/install.sh uninstall user"
	fi
	if units_in "$SYS_UNIT_DIR"; then
		die "the units are installed for all users ($SYS_UNIT_DIR): they start the daemon already, and with the port held nothing is ever started on demand. To switch, remove them first: sudo sh tools/install.sh uninstall global"
	fi
	[ -f "$REPO/cli/bgw" ] || die "$REPO/cli/bgw is missing"
	[ -f "$REPO/daemon/src/main.js" ] || die "$REPO/daemon/src/main.js is missing"
	need_node
	[ -d "$REPO/node_modules/ws" ] || die "the daemon's one dependency is missing ($REPO/node_modules/ws). Run this in the checkout first: npm ci --omit=dev"

	mkdir -p "$CONFIG_DIR"
	chmod 700 "$CONFIG_DIR"
	marker_tmp="$CONFIG_DIR/$ON_DEMAND.tmp.$$"
	(
		umask 077
		printf '%s\n' "# Browser Gateway: with this file here, bgw and \"bgw mcp\" start the daemon when they find it not running." "# Written by tools/install.sh on-demand. Remove it with: sh tools/install.sh uninstall on-demand" >"$marker_tmp"
	)
	chmod 600 "$marker_tmp"
	mv -f "$marker_tmp" "$CONFIG_DIR/$ON_DEMAND"

	say "starting on demand is switched on: $CONFIG_DIR/$ON_DEMAND"
	say "Nothing was started. From now on fetch, search, read, pages, export, pair, pending and open,"
	say "and a tool call through \"bgw mcp\", start the daemon when nothing listens on 127.0.0.1:$PORT -"
	say "each bgw from the checkout it sits in (this one: $REPO)."
	say "The daemon is not stopped when idle: it runs until \"cli/bgw daemon stop\" or until your session ends it."
	say "There is no sandbox around it, and nothing holds the port while it is down. The clients make whatever"
	say "listens there prove that it holds the token before they send anything."
	if has_autostart; then
		say
		say "An autostart entry is there as well ($AUTOSTART_DIR/$DESKTOP_NAME): it starts the daemon at login,"
		say "and this covers the time after the daemon was stopped."
	fi
	say
	say "Next, if not done yet:"
	say "  1. sh tools/build-xpi.sh, then in the browser: about:addons -> Install Add-on From File -> dist/browser-gateway-<version>.xpi"
	say "  2. cli/bgw pair, and paste the code into the add-on's options page"
	say "  3. cli/bgw mcp-config, to register the gateway with your agent"
	port_note
}

uninstall_on_demand() {
	if has_on_demand; then
		rm -f "$CONFIG_DIR/$ON_DEMAND"
		say "removed $CONFIG_DIR/$ON_DEMAND: bgw no longer starts the daemon by itself"
		say "A daemon that runs now is not stopped: cli/bgw daemon stop"
	else
		say "starting on demand is not switched on ($CONFIG_DIR/$ON_DEMAND is not there): nothing to remove"
	fi
	purge_or_keep
}

# ---------------------------------------------------------------- --purge

# purge_check <directory> <what the gateway keeps in it...>
# Is this a directory --purge may delete? Sets PURGE_REAL to where it really is
# and PURGE_HOW to "tree" or "empty", or leaves PURGE_REAL empty when nothing is
# there. Ends the run where the directory is not the gateway's to delete: the
# name comes from the environment, and rm -rf takes whatever it is given.
purge_check() {
	PURGE_REAL=
	PURGE_HOW=
	purge_dir=$1
	shift
	# A name that ends in a slash is looked through, not at: a link would not be seen.
	while [ "$purge_dir" != / ] && [ "${purge_dir%/}" != "$purge_dir" ]; do
		purge_dir=${purge_dir%/}
	done
	[ ! -L "$purge_dir" ] || die "$purge_dir is a symbolic link - nothing was deleted. --purge deletes a directory of the gateway, never what a link points at."
	[ -e "$purge_dir" ] || return 0
	[ -d "$purge_dir" ] || die "$purge_dir is not a directory - nothing was deleted"
	purge_real=$(cd "$purge_dir" && pwd -P) || die "cannot enter $purge_dir - nothing was deleted"
	purge_home=$(cd "$HOME" && pwd -P) || die "cannot enter the home directory $HOME - nothing was deleted"
	# /, the home directory and everything above it. Written as it is, in ., .. or through a link: all the same here.
	if below "$purge_home" "$purge_real"; then
		die "refusing to delete $purge_real: it is the home directory or lies above it - nothing was deleted"
	fi
	if below "$REPO" "$purge_real"; then
		die "refusing to delete $purge_real: this script runs from inside it ($REPO) - nothing was deleted. Run --purge from a checkout that lies elsewhere."
	fi
	case $purge_real in
	/*/*) ;;
	*) die "refusing to delete $purge_real: a directory directly below / is not the gateway's - nothing was deleted" ;;
	esac
	# Directories that hold other programs' things as well.
	for purge_shared in .config .local .local/share .local/state .local/bin .local/lib .cache .var .var/app .ssh .gnupg .mozilla .claude .config/systemd .config/autostart Desktop Documents Downloads Music Pictures Public Templates Videos; do
		[ "$purge_real" != "$purge_home/$purge_shared" ] || die "refusing to delete $purge_real: it is not the gateway's alone - nothing was deleted"
	done
	case $purge_real in
	/usr/* | /etc/* | /boot/* | /proc/* | /sys/* | /dev/* | /var/lib | /var/log | /var/tmp | /var/cache | /var/home | /var/opt) die "refusing to delete $purge_real: it is the system's - nothing was deleted" ;;
	esac
	# Something of the gateway has to be in it.
	for purge_file in "$@"; do
		case $purge_file in
		*/) [ ! -d "$purge_real/$purge_file" ] || PURGE_HOW=tree ;;
		*) [ ! -f "$purge_real/$purge_file" ] || PURGE_HOW=tree ;;
		esac
	done
	if [ -z "$PURGE_HOW" ]; then
		# An empty directory is taken away with rmdir, which cannot take anything with it.
		[ -z "$(ls -A "$purge_real")" ] || die "refusing to delete $purge_real: none of the gateway's files is in it (looked for: $*) - nothing was deleted. If it is the gateway's, delete it by hand."
		PURGE_HOW=empty
	fi
	PURGE_REAL=$purge_real
}

# purge_one <where it really is> <tree or empty>
purge_one() {
	case $2 in
	tree) rm -rf -- "${1:?}" ;;
	*) rmdir -- "$1" ;;
	esac
}

# The directories of whoever runs this, and nobody else's.
purge_or_keep() {
	if [ "$PURGE" != yes ]; then
		if [ -d "$CONFIG_DIR" ] || [ -d "$DATA_DIR" ]; then
			say "kept $CONFIG_DIR (tokens, extension key, config.json) and $DATA_DIR (audit log, stored pages)."
			say "Delete them with: sh tools/install.sh uninstall $TARGET --purge"
		fi
		return 0
	fi
	# Both are judged before either is deleted.
	purge_check "$CONFIG_DIR" client.token admin.token config.json
	purge_config=$PURGE_REAL
	purge_config_how=$PURGE_HOW
	purge_check "$DATA_DIR" audit.jsonl index.db daemon.log pages/ files/
	purge_data=$PURGE_REAL
	purge_data_how=$PURGE_HOW
	if [ -z "$purge_config" ] && [ -z "$purge_data" ]; then
		say "neither $CONFIG_DIR nor $DATA_DIR is there: nothing to delete"
		return 0
	fi
	# Nothing is deleted from under a daemon that runs. The socket unit is asked
	# first: asking the port would start the daemon it stands for.
	if have_systemctl && sc --user is-active --quiet "$SOCKET" 2>/dev/null; then
		die "a socket unit of the gateway is active in your session - nothing was deleted. Stop it first: systemctl --user stop $SOCKET $SERVICE"
	fi
	if have_node && answers; then
		die "a gateway daemon answers on 127.0.0.1:$PORT - nothing was deleted. Stop it first: cli/bgw daemon stop"
	fi
	# By the path that was judged, not by the name it was given under.
	purge_done=
	if [ -n "$purge_config" ]; then
		purge_one "$purge_config" "$purge_config_how"
		purge_done=$purge_config
	fi
	if [ -n "$purge_data" ]; then
		purge_one "$purge_data" "$purge_data_how"
		purge_done="${purge_done:+$purge_done and }$purge_data"
	fi
	say "deleted $purge_done"
	say "The browser add-on still holds its key: use \"Forget pairing\" in its options."
}

# ---------------------------------------------------------------- global

# check_prefix <path>: a directory this script may make, replace and delete.
check_prefix() {
	check_dir "--prefix" "$1"
	check_unit_path "--prefix" "$1"
	case "$1/" in
	*/../* | */./* | *//*) die "write --prefix without ., .. or empty components: $1" ;;
	esac
	case $1 in
	/ | /opt | /usr | /usr/local | /etc | /home | /var | /root) die "--prefix must be a directory of its own, not $1" ;;
	esac
}

need_root() {
	# With a stand-in root nothing of the system is written to.
	[ -n "$ROOT" ] || [ "$(id -u)" -eq 0 ] || die "\"$1\" changes the system for all users and must be run as root: sudo sh tools/install.sh $1"
}

# chain_walk <directory> <where to stop> <what could be replaced> <way out>
# The directory and every one above it, up to the stop. Whoever can write to
# one of them can move what lies below aside and put something else at the same
# path, so each has to belong to root and be writable for nobody else. What is
# not there yet is passed over: this run makes it, as root, with 0755.
chain_walk() {
	chain_at=$1
	while :; do
		if [ -L "$chain_at" ]; then
			# The permission bits of a link say nothing. Its owner does, and so does the directory it lies in: the next round.
			chain_bad=$(find "$chain_at" -prune ! -user 0) || die "cannot look at $chain_at"
			[ -n "$ROOT" ] || [ -z "$chain_bad" ] || die "$chain_at does not belong to root: its owner could replace $3. $4"
		elif [ -d "$chain_at" ]; then
			chain_bad=$(find "$chain_at" -prune \( -perm -0020 -o -perm -0002 \)) || die "cannot look at $chain_at"
			[ -z "$chain_bad" ] || die "$chain_at is writable for its group or for everybody: whoever can write there could replace $3. $4"
			# With a stand-in root there is no root to own it.
			chain_bad=$(find "$chain_at" -prune ! -user 0) || die "cannot look at $chain_at"
			[ -n "$ROOT" ] || [ -z "$chain_bad" ] || die "$chain_at does not belong to root: its owner could replace $3. $4"
		elif [ -e "$chain_at" ]; then
			die "$chain_at is in the way and is not a directory"
		fi
		[ "$chain_at" != "$2" ] || return 0
		[ "$chain_at" != / ] || return 0
		chain_at=$(dirname "$chain_at")
	done
}

# check_chain <directory> <what could be replaced> <way out>
# chain_walk for the path as it is written, and for where it really leads when
# a link is on the way.
check_chain() {
	chain_stop=${ROOT:-/}
	chain_walk "$1" "$chain_stop" "$2" "$3"
	chain_dir=$1
	while [ ! -d "$chain_dir" ]; do
		chain_dir=$(dirname "$chain_dir")
	done
	chain_real=$(cd "$chain_dir" && pwd -P) || die "cannot enter $chain_dir"
	chain_stop_real=$(cd "$chain_stop" && pwd -P) || die "cannot enter $chain_stop"
	if [ "$chain_real" != "$chain_dir" ]; then
		below "$chain_real" "$chain_stop_real" || die "$chain_dir leads out of the stand-in root, to $chain_real"
		chain_walk "$chain_real" "$chain_stop_real" "$2" "$3"
	fi
}

# The directories on the way to what "global" copies. find and cp look at what
# they are given, not at the path to it: where one of these is a link, every
# file below it comes from outside the checkout, and none of them is a link.
no_link_dirs() {
	for link_dir in cli daemon node_modules node_modules/ws tools "$@"; do
		[ -L "$REPO/$link_dir" ] || continue
		case $link_dir in
		node_modules*) link_hint="Put the dependency into the checkout itself: remove the link and run \"npm ci --omit=dev\" there as yourself. A release made by tools/deploy.sh has such a link unless it was prepared with --install-deps." ;;
		*) link_hint="Run this from a checkout that holds the directory itself." ;;
		esac
		die "$REPO/$link_dir is a symbolic link - nothing was copied. Root copies only what lies in the checkout itself: what a link leads to would end up readable for everybody below the prefix. $link_hint"
	done
}

# check_global_node <path>: a node that root writes into every user's service unit.
check_global_node() {
	check_dir "--node" "$1"
	check_unit_path "--node" "$1"
	case "$1/" in
	*/../* | */./* | *//*) die "write --node without ., .. or empty components: $1" ;;
	esac
	if hidden_from_unit "$1"; then
		die "--node $1 lies in a home directory or another place the service unit hides from the daemon. Name a node that is installed system-wide."
	fi
	[ -f "$ROOT$1" ] && [ -x "$ROOT$1" ] || die "--node $1 is not a program"
	gnode_real=$(real_path "$ROOT$1") || die "--node $1 leads nowhere"
	gnode_shown=${gnode_real#"$ROOT_REAL"}
	if hidden_from_unit "${gnode_shown#"$ROOT"}"; then
		die "--node $1 is a link to $gnode_real, which the service unit hides from the daemon. Name a node that is installed system-wide."
	fi
	# Every user's daemon is this program: nobody but root may be able to change or replace it.
	gnode_bad=$(find "$gnode_real" -prune \( -perm -0020 -o -perm -0002 \)) || die "cannot look at $gnode_real"
	[ -z "$gnode_bad" ] || die "--node $gnode_real is writable for its group or for everybody: whoever can write to it runs code as every user of the gateway"
	gnode_bad=$(find "$gnode_real" -prune ! -user 0) || die "cannot look at $gnode_real"
	[ -n "$ROOT" ] || [ -z "$gnode_bad" ] || die "--node $gnode_real does not belong to root: its owner runs code as every user of the gateway"
	check_chain "$(dirname "$ROOT$1")" "the node every user's daemon runs" "Name a node in a directory that only root can write to."
	check_chain "$(dirname "$gnode_real")" "the node every user's daemon runs" "Name a node in a directory that only root can write to."
	gnode_major=$("$ROOT$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || gnode_major=
	[ "$gnode_major" -ge 24 ] 2>/dev/null || die "--node $1 is not Node 24 or newer (it says: ${gnode_major:-nothing})"
}

cleanup_stage() {
	if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then
		rm -rf "$STAGE"
	fi
}

install_global() {
	need_root global
	need_systemctl
	PREFIX=${PREFIX_ARG:-$DEFAULT_PREFIX}
	PREFIX=${PREFIX%/}
	check_prefix "$PREFIX"
	DEST=$ROOT$PREFIX
	check_templates
	GLOBAL_NODE="/usr/bin/env node"
	if [ -n "$NODE_ARG" ]; then
		check_global_node "$NODE_ARG"
		GLOBAL_NODE=$NODE_ARG
	fi

	# ---- everything is checked before anything is written
	case "$DEST/" in
	"$REPO"/*) die "the prefix lies inside this checkout: $DEST" ;;
	esac
	case "$REPO/" in
	"$DEST"/*) die "this script runs from the installed copy ($DEST). Run \"global\" from a checkout." ;;
	esac
	global_was=$(program_of "$SYS_UNIT_DIR")
	if [ -n "$global_was" ] && [ "$global_was" != "$PREFIX" ]; then
		die "the units in $SYS_UNIT_DIR run the daemon from $global_was, not from $PREFIX. Give that directory with --prefix, or remove the installation first: sudo sh tools/install.sh uninstall global"
	fi
	for global_dir in "$DEST" "$DEST.previous"; do
		if [ -e "$global_dir" ] || [ -L "$global_dir" ]; then
			is_ours "$global_dir" || die "$global_dir exists and was not made by this tool (no $MARKER in it) - not touching it"
		fi
	done
	# With --no-link nothing is made there, so what is there is nobody's business.
	if [ "$NO_LINK" = no ] && { [ -e "$BIN_LINK" ] || [ -L "$BIN_LINK" ]; }; then
		if [ ! -L "$BIN_LINK" ] || [ "$(readlink "$BIN_LINK")" != "$PREFIX/cli/bgw" ]; then
			die "$BIN_LINK exists and is not the link to $PREFIX/cli/bgw that this tool makes - not touching it"
		fi
	fi
	# The directories above the prefix decide who can swap the program for another
	# one, each of them. What is there now is looked at here; what this run makes
	# is looked at again once it is made.
	global_parent=$(dirname "$DEST")
	global_bin_dir=$(dirname "$BIN_LINK")
	global_link_out="Run this again with --no-link: the link is left out then, and the command is $PREFIX/cli/bgw."
	check_chain "$global_parent" "the program every user runs" "Choose another --prefix."
	# The same for the directory of the bgw command, also when the link is there from an earlier run.
	[ "$NO_LINK" = yes ] || check_chain "$global_bin_dir" "the bgw command every user runs" "$global_link_out"

	# Root runs nothing from the checkout: no npm, no node on its files.
	no_link_dirs
	[ -d "$REPO/node_modules/ws" ] || die "the daemon's one dependency is missing ($REPO/node_modules/ws). Root does not run npm in a checkout: run \"npm ci --omit=dev\" there as yourself, then this again."
	for global_file in cli/bgw cli/bgw_daemonctl.py daemon/src/main.js package.json LICENSE THIRD-PARTY-NOTICES.md README.md; do
		[ -f "$REPO/$global_file" ] || die "$REPO/$global_file is missing"
	done
	global_version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO/package.json" | head -n 1)
	case $global_version in
	'' | *[!0-9A-Za-z.+_-]*) die "$REPO/package.json has no usable version" ;;
	esac
	global_xpi=dist/browser-gateway-$global_version.xpi
	[ -f "$REPO/$global_xpi" ] || global_xpi=
	no_link_dirs ${global_xpi:+dist}
	# Only plain files and directories are copied. A symlink could lead out of the
	# checkout, to a file that then lay readable for everybody below the prefix.
	global_odd=$(cd "$REPO" && find cli daemon node_modules/ws package.json LICENSE THIRD-PARTY-NOTICES.md README.md tools/install.sh "tools/$SOCKET" "tools/$SERVICE" "tools/$DIRS" ${global_xpi:+"$global_xpi"} ! -type f ! -type d | head -n 5)
	[ -z "$global_odd" ] || die "the checkout holds something that is neither a file nor a directory (a symlink?) - nothing was copied: $(printf '%s' "$global_odd" | tr '\n' ' ')"
	# A file with a second name may be one that whoever made the link cannot read:
	# a hard link needs no permission on the file. Copied by root, its content
	# would be everybody's. Nothing in a checkout has two names.
	global_odd=$(cd "$REPO" && find cli daemon node_modules/ws package.json LICENSE THIRD-PARTY-NOTICES.md README.md tools/install.sh "tools/$SOCKET" "tools/$SERVICE" "tools/$DIRS" ${global_xpi:+"$global_xpi"} -type f -links +1 | head -n 5)
	[ -z "$global_odd" ] || die "the checkout holds files that have a second name somewhere (hard links) - nothing was copied: $(printf '%s' "$global_odd" | tr '\n' ' '). Make a fresh copy of the checkout (git clone, or cp -R) and run this from there."
	if [ -n "$NODE_ARG" ]; then
		:
	elif have_node; then
		global_major=$(node_major)
		[ "$global_major" -ge 24 ] 2>/dev/null || warn "node on root's PATH is version $global_major; the daemon needs Node 24 or newer on the PATH of every user's session (or name one with --node)"
	else
		warn "node is not on root's PATH; the daemon needs Node 24 or newer on the PATH of every user's session (or name one with --node)"
	fi

	# ---- the copy, in a directory next to its final place
	umask 022
	mkdir -p "$global_parent"
	# Again, now that every directory above the prefix is there.
	check_chain "$global_parent" "the program every user runs" "Choose another --prefix."
	trap cleanup_stage EXIT
	trap 'exit 1' HUP INT TERM
	# Made here and by nobody else: only then is it this run's to remove again.
	mkdir "$DEST.new.$$"
	STAGE=$DEST.new.$$
	mkdir "$STAGE/node_modules" "$STAGE/tools"
	# -P: a link is never followed, whatever changed since the check above.
	cp -R -P "$REPO/cli" "$REPO/daemon" "$STAGE/"
	cp -R -P "$REPO/node_modules/ws" "$STAGE/node_modules/"
	cp -P "$REPO/package.json" "$REPO/LICENSE" "$REPO/THIRD-PARTY-NOTICES.md" "$REPO/README.md" "$STAGE/"
	cp -P "$REPO/tools/install.sh" "$REPO/tools/$SOCKET" "$REPO/tools/$SERVICE" "$REPO/tools/$DIRS" "$STAGE/tools/"
	if [ -n "$global_xpi" ]; then
		mkdir "$STAGE/dist"
		cp -P "$REPO/$global_xpi" "$STAGE/dist/"
	fi
	# The checkout is not root's: had one of its directories become a link while it was copied, the copy is not kept.
	no_link_dirs ${global_xpi:+dist}
	find "$STAGE" -type d -name __pycache__ -prune -exec rm -rf {} +
	global_odd=$(find "$STAGE" ! -type f ! -type d | head -n 5)
	[ -z "$global_odd" ] || die "the copy holds something that is neither a file nor a directory - it was thrown away: $(printf '%s' "$global_odd" | tr '\n' ' ')"
	# Owned by whoever runs this (root), readable for everybody, writable for the owner alone.
	chown -R -P "$(id -u):$(id -g)" "$STAGE"
	chmod -R u=rwX,go=rX "$STAGE"
	# /usr/local/bin/bgw points at it: it has to be executable whatever the checkout said.
	chmod 755 "$STAGE/cli/bgw"
	printf '%s\n' "$MARKER_TAG" "version=$global_version" "installed=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STAGE/$MARKER"
	chmod 644 "$STAGE/$MARKER"

	# ---- into place. A daemon that runs keeps the tree it was started from:
	# that one is moved aside whole (and removed by the next update), never
	# emptied under it.
	global_update=no
	if [ -d "$DEST" ]; then
		global_update=yes
		rm -rf "$DEST.previous"
		mv "$DEST" "$DEST.previous"
		if ! mv "$STAGE" "$DEST"; then
			mv "$DEST.previous" "$DEST"
			die "could not put the new copy in place; $DEST is as it was"
		fi
	else
		mv "$STAGE" "$DEST"
	fi
	STAGE=

	render_units "$SYS_UNIT_DIR" "$PREFIX" "$GLOBAL_NODE"
	sc --global enable "$SOCKET"
	if [ "$NO_LINK" = no ] && [ ! -L "$BIN_LINK" ]; then
		mkdir -p "$global_bin_dir"
		check_chain "$global_bin_dir" "the bgw command every user runs" "$global_link_out"
		ln -s "$PREFIX/cli/bgw" "$BIN_LINK"
	fi

	say "browser-gateway $global_version is installed for all users"
	say "program: $DEST (root-owned copy of $REPO)"
	say "units:   $SYS_UNIT_DIR/$SOCKET, $SERVICE, $DIRS - the socket unit is enabled for every user"
	if [ "$NO_LINK" = no ]; then
		say "command: $BIN_LINK -> $PREFIX/cli/bgw"
	elif [ -L "$BIN_LINK" ] && [ "$(readlink "$BIN_LINK")" = "$PREFIX/cli/bgw" ]; then
		say "command: $PREFIX/cli/bgw (--no-link: no link was made; $BIN_LINK from an earlier run was left where it is)"
	else
		say "command: $PREFIX/cli/bgw (--no-link: no link was made; where this text says \"bgw\", users call it by that path)"
	fi
	if [ -n "$NODE_ARG" ]; then
		say "node:    $NODE_ARG, written into the service unit"
	else
		say "node:    the one on each user's PATH (--node PATH names one for all)"
	fi
	if [ "$global_update" = yes ]; then
		say "update:  the copy before this one is in $DEST.previous until the next update. A daemon that"
		say "         runs now keeps it until it is restarted: systemctl --user daemon-reload, then"
		say "         systemctl --user restart $SERVICE (each user), or log out and in."
	fi
	say
	say "Each user, once:"
	say "  1. log out and in again, or: systemctl --user daemon-reload && systemctl --user start $SOCKET"
	if [ -n "$global_xpi" ]; then
		say "  2. in the browser: about:addons -> Install Add-on From File -> $PREFIX/$global_xpi"
	else
		say "  2. install the add-on in the browser. No add-on file was copied: dist/browser-gateway-$global_version.xpi is not"
		say "     in the checkout. Build it there as yourself (npm run xpi) and run this again, or take it from the Releases page."
	fi
	say "  3. bgw pair, and paste the code into the add-on's options page"
	say "  4. bgw mcp-config, to register the gateway with their agent; then bgw doctor"
	say
	say "Every user's daemon listens on the same port, 127.0.0.1:$PORT. When two users are logged in at the"
	say "same time, the second one's socket unit cannot take it and their gateway does not work. That unit"
	say "stays failed after the first one logged out: the second one then runs"
	say "systemctl --user restart $SOCKET, or logs in again. Or one of them moves to another port"
	say "(README.md says how)."
	say "Tokens, the extension key and stored pages are each user's own, in their home directory."
	port_note
}

uninstall_global() {
	need_root "uninstall global"
	need_systemctl
	PREFIX=${PREFIX_ARG:-$(program_of "$SYS_UNIT_DIR")}
	PREFIX=${PREFIX:-$DEFAULT_PREFIX}
	PREFIX=${PREFIX%/}
	check_prefix "$PREFIX"
	DEST=$ROOT$PREFIX

	if units_in "$SYS_UNIT_DIR"; then
		sc --global disable "$SOCKET" 2>/dev/null || true
		rm -f "$SYS_UNIT_DIR/$SOCKET" "$SYS_UNIT_DIR/$SERVICE" "$SYS_UNIT_DIR/$DIRS"
		say "removed $SOCKET, $SERVICE and $DIRS from $SYS_UNIT_DIR"
	else
		say "the units for all users are not installed ($SYS_UNIT_DIR): nothing to remove there"
	fi
	if [ -L "$BIN_LINK" ] && [ "$(readlink "$BIN_LINK")" = "$PREFIX/cli/bgw" ]; then
		rm -f "$BIN_LINK"
		say "removed $BIN_LINK"
	elif [ -e "$BIN_LINK" ] || [ -L "$BIN_LINK" ]; then
		say "left alone: $BIN_LINK is not the link to $PREFIX/cli/bgw that this tool makes"
	fi
	for global_dir in "$DEST" "$DEST.previous"; do
		if is_ours "$global_dir"; then
			rm -rf "${global_dir:?}"
			say "removed $global_dir"
		elif [ -e "$global_dir" ] || [ -L "$global_dir" ]; then
			say "left alone: $global_dir was not made by this tool (no $MARKER in it)"
		fi
	done
	say
	say "A daemon that runs in somebody's session is not stopped by this. It ends when they log out,"
	say "or with: systemctl --user stop $SOCKET $SERVICE"
	say "Nobody's config or data directory was touched. Each user deletes their own with:"
	say "  sh tools/install.sh uninstall user --purge   (from a checkout), or by hand:"
	say "  ~/.config/browser-gateway and ~/.local/share/browser-gateway"
}

# ---------------------------------------------------------------- status

STATUS_PROBLEMS=0

problem() {
	STATUS_PROBLEMS=$((STATUS_PROBLEMS + 1))
	say "problem:      $*"
}

# status_units <label> <unit directory> <prefix in front of the program directory>
# Prints one line about the units in a directory and notes what is wrong with them.
status_units() {
	if ! units_in "$2"; then
		say "$1 not installed"
		return 1
	fi
	status_program=$(program_of "$2")
	status_port=$(port_of "$2")
	say "$1 installed in $2, daemon from ${status_program:-?}, port ${status_port:-?}"
	status_missing=$(missing_in "$2")
	[ -z "$status_missing" ] || problem "the units in $2 are not complete (missing: $status_missing)"
	if [ -n "$status_program" ] && [ ! -f "$3$status_program/daemon/src/main.js" ]; then
		problem "the units in $2 run the daemon from $status_program, and there is no daemon there (moved or deleted?)"
	fi
	return 0
}

status() {
	st_user=no
	st_global=no
	st_marker=no
	st_auto=no
	if status_units "user units:  " "$UNIT_DIR" ""; then
		st_user=yes
	fi
	if status_units "global units:" "$SYS_UNIT_DIR" "$ROOT"; then
		st_global=yes
		st_prefix=$(program_of "$SYS_UNIT_DIR")
		if [ -n "$st_prefix" ] && [ -d "$ROOT$st_prefix" ] && ! is_ours "$ROOT$st_prefix"; then
			problem "$ROOT$st_prefix was not made by this tool (no $MARKER in it)"
		fi
		if [ ! -L "$SYS_UNIT_DIR/sockets.target.wants/$SOCKET" ] && [ ! -e "$SYS_UNIT_DIR/sockets.target.wants/$SOCKET" ]; then
			problem "the socket unit in $SYS_UNIT_DIR is not enabled for all users: sudo sh tools/install.sh global"
		fi
	fi
	if has_on_demand; then
		st_marker=yes
		say "on-demand:    switched on ($CONFIG_DIR/$ON_DEMAND): each bgw starts the daemon of the checkout it sits in"
	else
		say "on-demand:    not switched on"
	fi
	if has_autostart; then
		st_auto=yes
		say "autostart:    an entry of tools/autostart.sh is there ($AUTOSTART_DIR/$DESKTOP_NAME)"
	else
		say "autostart:    no entry"
	fi

	# With an active socket unit the port is not asked: a connection would start the daemon.
	st_socket=no
	if [ "$st_user" = yes ] || [ "$st_global" = yes ]; then
		if have_systemctl && sc --user is-active --quiet "$SOCKET" 2>/dev/null; then
			st_socket=yes
			if sc --user is-active --quiet "$SERVICE" 2>/dev/null; then
				say "daemon:       running; the socket unit is active and systemd holds the port"
			else
				say "daemon:       not running; the socket unit is active, systemd holds the port and starts the daemon on the first connection"
			fi
		else
			say "socket unit:  not active in this session. Log out and in again, or: systemctl --user daemon-reload && systemctl --user start $SOCKET"
		fi
	fi
	if [ "$st_socket" = no ]; then
		if ! have_node; then
			say "daemon:       not asked (node not found)"
		elif answers; then
			say "daemon:       a gateway daemon answers on 127.0.0.1:$PORT"
		elif port_listens; then
			say "daemon:       something listens on 127.0.0.1:$PORT, and it is not the gateway daemon"
		elif [ "$st_marker" = yes ]; then
			say "daemon:       not running; nothing listens on 127.0.0.1:$PORT. It is started on demand."
		else
			say "daemon:       not running; nothing listens on 127.0.0.1:$PORT"
		fi
	fi

	if [ "$st_user" = yes ] && [ "$st_global" = yes ]; then
		problem "the units are installed twice, for you and for all users. Yours win in your session. Remove one: sh tools/install.sh uninstall user, or sudo sh tools/install.sh uninstall global"
	fi
	if [ "$st_marker" = yes ] && { [ "$st_user" = yes ] || [ "$st_global" = yes ]; }; then
		problem "starting on demand is switched on, but a socket unit holds the port: it never takes effect. Remove it: sh tools/install.sh uninstall on-demand"
	fi
	if [ "$st_auto" = yes ] && { [ "$st_user" = yes ] || [ "$st_global" = yes ]; }; then
		problem "an autostart entry and a socket unit both want the port at login. Remove the entry: sh tools/autostart.sh remove"
	fi
	if [ "$st_marker" = yes ] && [ "$st_user" = no ] && [ "$st_global" = no ]; then
		if [ ! -f "$REPO/daemon/src/main.js" ] || [ ! -d "$REPO/node_modules/ws" ]; then
			problem "starting on demand is switched on, but this checkout cannot run a daemon (node_modules/ws or daemon/src/main.js is missing in $REPO): npm ci --omit=dev"
		fi
	fi

	case "$st_user$st_global$st_marker" in
	nonono)
		if [ "$st_auto" = yes ]; then
			say "mode:         none of the three; the autostart entry starts the daemon at login"
		else
			say "mode:         none of the three; the daemon runs when you start it: cli/bgw daemon start"
		fi
		;;
	yesnono) say "mode:         user" ;;
	noyesno) say "mode:         global" ;;
	nonoyes) say "mode:         on-demand" ;;
	*) say "mode:         more than one - see the problems above" ;;
	esac
	if [ "$STATUS_PROBLEMS" -gt 0 ]; then
		exit 1
	fi
}

# ---------------------------------------------------------------- run

case "$COMMAND $TARGET" in
"install user") install_user ;;
"install global") install_global ;;
"install on-demand") install_on_demand ;;
"uninstall user") uninstall_user ;;
"uninstall global") uninstall_global ;;
"uninstall on-demand") uninstall_on_demand ;;
"status ") status ;;
esac
