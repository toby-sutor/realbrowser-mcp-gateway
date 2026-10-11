#!/bin/sh
# Install and update a Browser Gateway on this machine from releases kept side by side (docs/DEPLOY.md).
#
#   tools/deploy.sh prepare <commit-ish> [--install-deps]
#   tools/deploy.sh activate <release-dir> [--from <dir>] [--autostart] [--mcp] [--dry-run]
#   tools/deploy.sh status [--from <dir>]
#   tools/deploy.sh rollback [--from <dir>] [--autostart] [--mcp] [--dry-run]
#   tools/deploy.sh list
#   tools/deploy.sh prune --keep <N> [--yes] [--force] [--dry-run]
#
# For a daemon that runs as a plain process (bgw daemon start, tools/autostart.sh). Where the systemd units of
# tools/install.sh start it, a new release is put in place with "sh tools/install.sh user" (or "global") run from
# that release; "prepare" is of use there, "activate" is not.
#
# A release is a directory <releases root>/<version>-<short commit>/ with a clean copy of one commit, its
# node_modules and its built XPI. "prepare" makes one and changes nothing that is live. "activate" moves the daemon,
# the autostart entry and (with --mcp) the Claude Code registration to it, and then the "current" symlink; where a
# step fails, the previous release is brought back up. The browser add-on is never touched: see docs/DEPLOY.md.
#
# Works on the host and from inside a Flatpak sandbox (node, npm and claude are reached through
# flatpak-spawn --host there; bgw daemon does the same by itself).
#
# Exit codes: 0 done, 1 a step failed (what state things are in has been said), 2 refused or wrong usage
# (nothing was changed).
#
# Environment (all but the last two are the names the other tools already use):
#   BGW_RELEASES_ROOT  where releases live, default $HOME/.local/share/browser-gateway/releases
#   BGW_AUTOSTART_DIR  as tools/autostart.sh reads it, default $HOME/.config/autostart
#   BGW_CONFIG_DIR     as the daemon reads it, default $HOME/.config/browser-gateway
#   BGW_DATA_DIR       as the daemon reads it, default $HOME/.local/share/browser-gateway
#   BGW_URL            http://127.0.0.1:<port>, default port 8791 (the daemon's port is taken from it)
#   BGW_CLAUDE_BIN     the claude binary, default $HOME/.local/bin/claude
#   BGW_NODE_BIN, BGW_NPM_BIN   node and npm, default from the PATH of the host
#   BGW_DEPLOY_WAIT_S  seconds a daemon gets to be reachable and proven, default 30
set -eu

SELF=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(dirname "$SELF")

MARKER=.bgw-release
MARKER_TAG="bgw-deploy-release=1"
DESKTOP_NAME=browser-gateway.desktop
DESKTOP_TAG="X-Browser-Gateway-Autostart=1"
MCP_NAME=browser-gateway

# Set by the commands, read by the exit trap.
LOCK=
STAGING=
ACTIVE=0
DRY=0

say() {
	printf 'deploy: %s\n' "$*"
}

warn() {
	printf 'deploy: %s\n' "$*" >&2
}

die() {
	warn "$*"
	exit 2
}

usage() {
	cat >&2 <<'EOF'
usage: deploy.sh prepare <commit-ish> [--install-deps]
       deploy.sh activate <release-dir> [--from <dir>] [--autostart] [--mcp] [--dry-run]
       deploy.sh status [--from <dir>]
       deploy.sh rollback [--from <dir>] [--autostart] [--mcp] [--dry-run]
       deploy.sh list
       deploy.sh prune --keep <N> [--yes] [--force] [--dry-run]
EOF
	exit 2
}

in_sandbox() {
	[ -f /.flatpak-info ]
}

# A command that needs the host: node, npm, claude.
host() {
	if in_sandbox; then
		flatpak-spawn --host "$@"
	else
		"$@"
	fi
}

bgw() {
	bgw_dir=$1
	shift
	python3 "$bgw_dir/cli/bgw" "$@"
}

# ---------------------------------------------------------------- environment

setup() {
	[ -n "${HOME:-}" ] || die "HOME is not set"
	case $HOME in
		/*) ;;
		*) die "HOME must be an absolute path" ;;
	esac
	# Literal home, never XDG: a sandbox remaps those.
	RELEASES=${BGW_RELEASES_ROOT:-$HOME/.local/share/browser-gateway/releases}
	AUTOSTART_DIR=${BGW_AUTOSTART_DIR:-$HOME/.config/autostart}
	DATA_DIR=${BGW_DATA_DIR:-$HOME/.local/share/browser-gateway}
	CONFIG_DIR=${BGW_CONFIG_DIR:-$HOME/.config/browser-gateway}
	CLAUDE_BIN=${BGW_CLAUDE_BIN:-$HOME/.local/bin/claude}
	NODE_BIN=${BGW_NODE_BIN:-node}
	NPM_BIN=${BGW_NPM_BIN:-npm}
	WAIT_S=${BGW_DEPLOY_WAIT_S:-30}
	for setup_pair in "BGW_RELEASES_ROOT:$RELEASES" "BGW_AUTOSTART_DIR:$AUTOSTART_DIR" "BGW_DATA_DIR:$DATA_DIR" "BGW_CONFIG_DIR:$CONFIG_DIR"; do
		setup_value=${setup_pair#*:}
		case $setup_value in
			/*) ;;
			*) die "${setup_pair%%:*} must be an absolute path" ;;
		esac
		case $setup_value in
			*[[:cntrl:]]*) die "${setup_pair%%:*} holds a control character" ;;
		esac
	done
	case $WAIT_S in
		'' | *[!0-9]*) die "BGW_DEPLOY_WAIT_S must be a number of seconds" ;;
	esac
	case $CLAUDE_BIN in
		/*) ;;
		*) die "BGW_CLAUDE_BIN must be an absolute path" ;;
	esac
	DESKTOP_FILE=$AUTOSTART_DIR/$DESKTOP_NAME

	setup_url=${BGW_URL:-http://127.0.0.1:8791}
	setup_url=${setup_url%/}
	case $setup_url in
		http://127.0.0.1:[0-9]*) PORT=${setup_url#http://127.0.0.1:} ;;
		*) die "BGW_URL must look like http://127.0.0.1:<port>" ;;
	esac
	case $PORT in
		*[!0-9]*) die "BGW_URL must look like http://127.0.0.1:<port>" ;;
	esac
	BGW_URL=http://127.0.0.1:$PORT
	export BGW_URL
	# Where the daemon makes its tokens, so that bgw doctor finds the ones of the daemon that is asked about.
	if [ -n "${BGW_CONFIG_DIR:-}" ]; then
		BGW_TOKEN_FILE=${BGW_TOKEN_FILE:-$BGW_CONFIG_DIR/client.token}
		BGW_ADMIN_TOKEN_FILE=${BGW_ADMIN_TOKEN_FILE:-$BGW_CONFIG_DIR/admin.token}
		export BGW_TOKEN_FILE BGW_ADMIN_TOKEN_FILE
	fi
	command -v python3 >/dev/null 2>&1 || die "python3 is needed"
}

# The releases root must exist; its real path is what releases are compared with.
need_root() {
	[ -d "$RELEASES" ] || die "$RELEASES does not exist: nothing has been prepared yet (deploy.sh prepare <commit>)"
	RELEASES=$(cd "$RELEASES" && pwd -P)
}

# ---------------------------------------------------------------- small helpers

json_field() {
	python3 -c '
import json, sys
try:
    v = json.load(sys.stdin)
    for k in sys.argv[1].split("."):
        v = v[k]
except Exception:
    sys.exit(0)
if v is True:
    print("true")
elif v is False:
    print("false")
elif v is not None:
    print(v)
' "$1"
}

# Atomic: rename(2) of a new symlink over the old one.
set_link() {
	link_tmp=$RELEASES/.link.$$.$1
	rm -f "$link_tmp"
	ln -s "$2" "$link_tmp"
	python3 -c 'import os, sys; os.replace(sys.argv[1], sys.argv[2])' "$link_tmp" "$RELEASES/$1" || {
		rm -f "$link_tmp"
		return 1
	}
}

# The target of a symlink of the releases root; empty if there is none.
link_of() {
	if [ -L "$RELEASES/$1" ]; then
		readlink "$RELEASES/$1"
	elif [ -e "$RELEASES/$1" ]; then
		die "$RELEASES/$1 is not a symlink - not touching it"
	fi
}

has_marker() {
	[ -f "$1/$MARKER" ] && [ ! -L "$1/$MARKER" ] && grep -qxF "$MARKER_TAG" "$1/$MARKER"
}

marker_get() {
	sed -n "s/^$2=//p" "$1/$MARKER" | head -n 1
}

# A release named on the command line: a path, or a name inside the releases root. Prints its real path.
resolve_dir() {
	case $1 in
		*/*) resolve_cand=$1 ;;
		*) resolve_cand=$RELEASES/$1 ;;
	esac
	[ -d "$resolve_cand" ] || return 1
	(cd "$resolve_cand" && pwd -P)
}

# What a directory needs to run as a release: nothing is changed before this is known.
check_release_files() {
	for check_f in cli/bgw cli/bgw_daemonctl.py daemon/src/main.js tools/autostart.sh package.json; do
		[ -f "$1/$check_f" ] || die "$1 is not a usable release: $check_f is missing"
	done
	[ -d "$1/node_modules" ] || die "$1 is not a usable release: node_modules is missing"
}

xpi_of() {
	xpi_version=$(marker_get "$1" version)
	[ -n "$xpi_version" ] || xpi_version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/extension/manifest.json" | head -n 1)
	printf '%s/dist/browser-gateway-%s.xpi' "$1" "$xpi_version"
}

lock() {
	if mkdir "$RELEASES/.deploy.lock" 2>/dev/null; then
		LOCK=$RELEASES/.deploy.lock
		printf '%s\n' "$$" >"$LOCK/pid"
	else
		die "$RELEASES/.deploy.lock exists: another deploy.sh runs, or one was killed. If none runs, remove that directory"
	fi
}

# The pid file of the daemon: pid, directory it was started from, port - tab separated. Empty if there is none.
pidrec() {
	python3 -c '
import json, sys
try:
    with open(sys.argv[1] + "/daemon.pid", encoding="utf-8") as f:
        r = json.loads(f.read(4096))
    print("%d\t%s\t%d" % (r["pid"], r["cwd"], r["port"]))
except Exception:
    pass
' "$DATA_DIR"
}

# 0: ours, 1: no entry, 2: a file that is not ours
autostart_state() {
	[ -e "$DESKTOP_FILE" ] || [ -L "$DESKTOP_FILE" ] || return 1
	[ -f "$DESKTOP_FILE" ] && [ ! -L "$DESKTOP_FILE" ] && grep -qxF "$DESKTOP_TAG" "$DESKTOP_FILE" || return 2
	return 0
}

# The directory of the checkout an autostart entry of ours starts the daemon of.
autostart_dir() {
	python3 -c '
import re, sys
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    if line.startswith("Exec="):
        m = re.match(r"Exec=python3 \"(.*)\" daemon start$", line.rstrip("\n"))
        if m:
            s = m.group(1)
            s = re.sub(r"\\\\", lambda x: "\\", s)
            s = re.sub(r"\\(.)", lambda x: x.group(1), s)
            s = s.replace("%%", "%")
            if s.endswith("/cli/bgw"):
                print(s[:-8])
        break
' "$DESKTOP_FILE"
}

# ---------------------------------------------------------------- Claude Code registration

# What Claude Code has registered under the name of the gateway, read from "claude mcp get". Sets
#   MCP_RC         0: registered, 1: not registered, 2: claude cannot be run
#   MCP_DIR        the checkout the registration starts; empty where that could not be read
#   MCP_SCOPE      the scope as claude names it ("User config ...", "Local config ...")
#   MCP_COMMAND    the command
#   MCP_ENV        the names of the environment variables the registration carries, never their values
#   MCP_SAID_NONE  1: claude said in words that there is no such server (and did not just fail)
#   MCP_PLAIN      1: it is the registration this tool makes - user scope, python3 <dir>/cli/bgw mcp, no environment
#   MCP_WHY        what is in the way of that, for a message
# What is not recognised counts as not plain: a registration is only replaced where it is known what gets lost.
mcp_read() {
	MCP_DIR=
	MCP_SCOPE=
	MCP_COMMAND=
	MCP_ENV=
	MCP_SAID_NONE=0
	MCP_PLAIN=0
	MCP_WHY=
	mcp_out=$(host "$CLAUDE_BIN" mcp get "$MCP_NAME" 2>&1) && MCP_RC=0 || MCP_RC=$?
	case $MCP_RC in
		0) ;;
		126 | 127)
			MCP_RC=2
			return 0
			;;
		*)
			MCP_RC=1
			if printf '%s\n' "$mcp_out" | grep -qi 'no mcp server'; then
				MCP_SAID_NONE=1
			fi
			return 0
			;;
	esac
	mcp_parsed=$(printf '%s\n' "$mcp_out" | python3 -c '
import re, sys
target = scope = command = None
env = []
env_indent = None
for line in sys.stdin:
    line = line.rstrip("\n")
    if env_indent is not None:
        # The lines of the environment are indented deeper than its heading.
        m = re.match(r"(\s*)(\S.*)$", line)
        if m and len(m.group(1)) > env_indent:
            env.append(re.sub(r"[^A-Za-z0-9_]", "?", re.split(r"[=:]", m.group(2), maxsplit=1)[0].strip()) or "?")
            continue
        env_indent = None
    m = re.match(r"(\s*)Environment:\s*(.*?)\s*$", line)
    if m:
        env_indent = len(m.group(1))
        if m.group(2):
            env.append(re.sub(r"[^A-Za-z0-9_]", "?", re.split(r"[=:]", m.group(2), maxsplit=1)[0].strip()) or "?")
        continue
    m = re.match(r"\s*Scope:\s*(.*?)\s*$", line)
    if m and scope is None:
        scope = m.group(1)
        continue
    m = re.match(r"\s*Command:\s*(.*?)\s*$", line)
    if m and command is None:
        command = m.group(1)
        continue
    m = re.match(r"\s*Args:\s*(.*?)\s*$", line)
    if m and target is None:
        a = m.group(1)
        target = ""
        if a.endswith(" mcp"):
            a = a[:-4]
            if a.endswith("/cli/bgw"):
                target = a[:-8]
clean = lambda v: re.sub(r"[\x00-\x1f\x7f]", "?", v or "")
print(clean(target))
print(clean(scope))
print(clean(command))
print(" ".join(env))
')
	MCP_DIR=$(printf '%s\n' "$mcp_parsed" | sed -n 1p)
	MCP_SCOPE=$(printf '%s\n' "$mcp_parsed" | sed -n 2p)
	MCP_COMMAND=$(printf '%s\n' "$mcp_parsed" | sed -n 3p)
	MCP_ENV=$(printf '%s\n' "$mcp_parsed" | sed -n 4p)
	case $MCP_SCOPE in
		[Uu]ser | [Uu]ser[!A-Za-z0-9]*) ;;
		'') MCP_WHY="its scope could not be read" ;;
		*) MCP_WHY="it is not in the user scope" ;;
	esac
	if [ -n "$MCP_COMMAND" ] && [ "$MCP_COMMAND" != python3 ]; then
		MCP_WHY="${MCP_WHY:+$MCP_WHY, }its command is not python3"
	fi
	[ -n "$MCP_DIR" ] || MCP_WHY="${MCP_WHY:+$MCP_WHY, }its arguments are not <release>/cli/bgw mcp"
	[ -z "$MCP_ENV" ] || MCP_WHY="${MCP_WHY:+$MCP_WHY, }it carries environment variables"
	[ -n "$MCP_WHY" ] || MCP_PLAIN=1
	return 0
}

# What mcp_read found, on one line.
mcp_found() {
	found_starts="not readable"
	[ -z "$MCP_DIR" ] || found_starts="$MCP_DIR/cli/bgw mcp"
	printf 'scope: %s; command: %s; starts: %s; environment: %s' "${MCP_SCOPE:-not readable}" "${MCP_COMMAND:-not readable}" "$found_starts" "${MCP_ENV:-none}"
}

# --mcp removes the registration and adds a plain one in the user scope. One that is more than that - another
# scope, variables such as BGW_URL or BGW_DOWNLOAD_DIR - would lose it, and one in another scope cannot even
# be removed from here. It is left alone and the run ends before anything is changed. $1: the release to register.
mcp_refuse() {
	case $MCP_SCOPE in
		[Ll]ocal*) refuse_scope=local ;;
		[Pp]roject*) refuse_scope=project ;;
		[Uu]ser*) refuse_scope=user ;;
		*) refuse_scope="<its scope>" ;;
	esac
	refuse_env=
	for refuse_name in $MCP_ENV; do
		refuse_env="$refuse_env --env $refuse_name=<value>"
	done
	warn "the Claude Code registration $MCP_NAME is not the plain one this tool makes ($MCP_WHY), and --mcp would replace it by a plain one in the user scope. Nothing was changed."
	warn "  found: $(mcp_found)"
	warn "  To move it by hand, with what it carries:"
	warn "    claude mcp remove --scope $refuse_scope $MCP_NAME"
	warn "    claude mcp add --scope $refuse_scope$refuse_env $MCP_NAME -- python3 $1/cli/bgw mcp"
	warn "  and run this again without --mcp."
	exit 2
}

# Replace the registration, or make it if there is none ($2 = 1: there is one to remove first).
mcp_set() {
	if [ "$2" = 1 ]; then
		host "$CLAUDE_BIN" mcp remove --scope user "$MCP_NAME" || return 1
	fi
	host "$CLAUDE_BIN" mcp add --scope user "$MCP_NAME" -- python3 "$1/cli/bgw" mcp
}

# ---------------------------------------------------------------- the daemon

# Reachable and proven (the daemon holds the agent token) - not paired or connected: no extension is needed to be up.
wait_ready() {
	ready_n=0
	while :; do
		ready_out=$(bgw "$1" doctor --json 2>/dev/null) || true
		if [ "$(printf '%s' "$ready_out" | json_field reachable)" = true ] && [ "$(printf '%s' "$ready_out" | json_field proof)" = true ]; then
			say "bgw doctor: reachable and proven, daemon version $(printf '%s' "$ready_out" | json_field versions.daemon)"
			return 0
		fi
		ready_n=$((ready_n + 1))
		[ "$ready_n" -lt "$WAIT_S" ] || {
			warn "bgw doctor: the daemon is not reachable and proven after $WAIT_S s: $(printf '%s' "$ready_out" | json_field problem)"
			return 1
		}
		sleep 1
	done
}

# ---------------------------------------------------------------- exit handling

cleanup() {
	if [ -n "$STAGING" ]; then
		rm -rf "$STAGING" "$STAGING.tar"
		STAGING=
	fi
	if [ -n "$LOCK" ]; then
		rm -rf "$LOCK"
		LOCK=
	fi
	[ -z "${AS_BACKUP:-}" ] || rm -f "$AS_BACKUP"
	# A link that was being made when the run was cut short.
	[ -z "${RELEASES:-}" ] || rm -f "$RELEASES/.link.$$.current" "$RELEASES/.link.$$.previous"
}

on_exit() {
	exit_rc=$?
	trap '' INT TERM HUP
	trap - EXIT
	set +e
	if [ "$ACTIVE" = 1 ] && [ "$exit_rc" -ne 0 ]; then
		warn "activate ended early (exit code $exit_rc)"
		restore
		exit_rc=1
	fi
	cleanup
	exit "$exit_rc"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ---------------------------------------------------------------- prepare

cmd_prepare() {
	prep_commit=
	prep_deps=0
	while [ $# -gt 0 ]; do
		case $1 in
			--install-deps) prep_deps=1 ;;
			-*) usage ;;
			*)
				[ -z "$prep_commit" ] || usage
				prep_commit=$1
				;;
		esac
		shift
	done
	[ -n "$prep_commit" ] || usage
	setup
	command -v git >/dev/null 2>&1 || die "git is needed"
	command -v tar >/dev/null 2>&1 || die "tar is needed"
	git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "prepare needs the git repository this script is in ($REPO)"
	prep_full=$(git -C "$REPO" rev-parse --verify --quiet "$prep_commit^{commit}") || die "no such commit: $prep_commit"
	prep_short=$(printf '%s' "$prep_full" | cut -c1-7)
	prep_version=$(git -C "$REPO" show "$prep_full:extension/manifest.json" | python3 -c '
import json, re, sys
v = json.load(sys.stdin).get("version")
if isinstance(v, str) and re.fullmatch(r"[0-9]+(\.[0-9]+){1,3}", v):
    print(v)
') || prep_version=
	[ -n "$prep_version" ] || die "extension/manifest.json of $prep_short has no usable version"
	prep_name=$prep_version-$prep_short
	if [ -e "$RELEASES/$prep_name" ] || [ -L "$RELEASES/$prep_name" ]; then
		die "$RELEASES/$prep_name exists already - refusing to prepare into it"
	fi
	if [ "$prep_deps" = 1 ]; then
		host "$NPM_BIN" --version >/dev/null 2>&1 || die "npm cannot be run on the host ($NPM_BIN)"
	else
		[ -d "$REPO/node_modules" ] || die "$REPO/node_modules is missing: run npm ci there, or use --install-deps"
	fi
	host "$NODE_BIN" --version >/dev/null 2>&1 || die "node cannot be run on the host ($NODE_BIN)"

	say "making the releases root $RELEASES if it is not there"
	mkdir -p "$RELEASES"
	RELEASES=$(cd "$RELEASES" && pwd -P)
	prep_dest=$RELEASES/$prep_name
	STAGING=$RELEASES/.prepare-$prep_name.$$
	mkdir "$STAGING"

	say "copying commit $prep_short with git archive into $prep_dest"
	git -C "$REPO" archive --format=tar -o "$STAGING.tar" "$prep_full"
	tar -xf "$STAGING.tar" -C "$STAGING"
	rm -f "$STAGING.tar"
	check_release_files_prep "$STAGING"
	printf '%s\n' "$MARKER_TAG" "version=$prep_version" "commit=$prep_full" "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STAGING/$MARKER"

	if [ "$prep_deps" = 1 ]; then
		say "installing the dependencies: npm ci --omit=dev"
		(cd "$STAGING" && host "$NPM_BIN" ci --omit=dev)
	else
		say "linking node_modules to $(cd "$REPO" && pwd -P)/node_modules"
		ln -s "$(cd "$REPO" && pwd -P)/node_modules" "$STAGING/node_modules"
	fi
	check_release_files "$STAGING"

	say "building the XPI: sh tools/build-xpi.sh"
	# The build names the staging directory in its first line; only the sizes and the hash are of use.
	prep_build=$(cd "$STAGING" && sh tools/build-xpi.sh) || {
		printf '%s\n' "$prep_build" >&2
		die "tools/build-xpi.sh failed"
	}
	say "$(printf '%s\n' "$prep_build" | tail -n 1)"
	[ -f "$STAGING/dist/browser-gateway-$prep_version.xpi" ] || die "the build did not make dist/browser-gateway-$prep_version.xpi"
	say "checking the vendored bundle: node tools/vendor.mjs --check"
	(cd "$STAGING" && host "$NODE_BIN" tools/vendor.mjs --check)

	# The name is free until this moment: the check and the rename are the only two steps that make it appear.
	[ ! -e "$prep_dest" ] && [ ! -L "$prep_dest" ] || die "$prep_dest appeared meanwhile - refusing"
	python3 -c 'import os, sys; os.rename(sys.argv[1], sys.argv[2])' "$STAGING" "$prep_dest"
	STAGING=
	say "release ready: $prep_dest"
	say "xpi: $prep_dest/dist/browser-gateway-$prep_version.xpi"
	say "nothing that is live was changed; next: deploy.sh activate $prep_dest"
}

# Before node_modules is there: only what the archive itself must hold.
check_release_files_prep() {
	for prep_f in cli/bgw cli/bgw_daemonctl.py daemon/src/main.js tools/autostart.sh tools/build-xpi.sh tools/vendor.mjs package.json extension/manifest.json; do
		[ -f "$1/$prep_f" ] || die "commit $prep_short has no $prep_f - not a release this tool can make"
	done
}

# ---------------------------------------------------------------- activate

# The pre-change state is kept in these; restore reads them.
OLD=
NEW=
OLD_KNOWN=0
OLD_WAS_RUNNING=0
OLD_BACK=0
STOPPED_OLD=0
STARTED_NEW=0
AS_ORIG=none
AS_BACKUP=
AS_CHANGED=0
MCP_ORIG=none
MCP_ORIG_DIR=
MCP_CHANGED=0
CUR_BEFORE=
CUR_RAW=
CUR_MOVED=0
PREV_RAW=
PREV_MOVED=0

# put_back <current|previous> <what the link named before, empty: there was none>
put_back() {
	if [ -n "$2" ]; then
		say "putting the $1 symlink back: $2"
		set_link "$1" "$2" || warn "the $1 symlink could not be put back: it should name $2"
	else
		say "removing the $1 symlink that activate made"
		rm -f "$RELEASES/$1"
	fi
}

restore() {
	ACTIVE=0
	set +e
	say "something failed - going back to the state before activate"
	if [ "$STARTED_NEW" = 1 ]; then
		say "stopping the daemon of $NEW"
		bgw "$NEW" daemon stop
	fi
	if [ "$AS_CHANGED" = 1 ]; then
		if [ "$AS_ORIG" = ours ]; then
			say "putting the autostart entry back as it was"
			cp -p "$AS_BACKUP" "$DESKTOP_FILE.bgw-tmp.$$" && mv -f "$DESKTOP_FILE.bgw-tmp.$$" "$DESKTOP_FILE"
		else
			say "removing the autostart entry that activate made"
			sh "$NEW/tools/autostart.sh" remove
		fi
	fi
	if [ "$MCP_CHANGED" = 1 ]; then
		if [ "$MCP_ORIG" = none ]; then
			say "removing the Claude Code registration that activate made"
			host "$CLAUDE_BIN" mcp remove --scope user "$MCP_NAME"
		elif [ -n "$MCP_ORIG_DIR" ]; then
			say "registering $MCP_ORIG_DIR again in Claude Code"
			host "$CLAUDE_BIN" mcp remove --scope user "$MCP_NAME" >/dev/null 2>&1
			host "$CLAUDE_BIN" mcp add --scope user "$MCP_NAME" -- python3 "$MCP_ORIG_DIR/cli/bgw" mcp
		else
			warn "the Claude Code registration was replaced and its old target could not be read"
		fi
	fi
	if [ "$STOPPED_OLD" = 1 ] && [ "$OLD_WAS_RUNNING" = 1 ] && [ "$OLD_KNOWN" = 1 ]; then
		say "starting the daemon of $OLD again"
		if bgw "$OLD" daemon start && wait_ready "$OLD"; then
			OLD_BACK=1
		fi
	fi
	# The two links are moved last, one after the other: a run that ends between them has moved "previous" alone.
	[ "$CUR_MOVED" = 0 ] || put_back current "$CUR_RAW"
	[ "$PREV_MOVED" = 0 ] || put_back previous "$PREV_RAW"

	say "state now:"
	if [ "$CUR_MOVED" = 1 ]; then
		say "  current symlink: $(link_of current) (put back)"
	else
		say "  current symlink: ${CUR_BEFORE:-none} (not moved)"
	fi
	if [ "$PREV_MOVED" = 1 ]; then
		restore_prev=$(link_of previous)
		say "  previous symlink: ${restore_prev:-none} (put back)"
	fi
	restore_asker=$OLD
	[ "$OLD_KNOWN" = 1 ] || restore_asker=$NEW
	restore_pid=$(pidrec)
	if [ -n "$restore_pid" ]; then
		say "  pid file: pid $(printf '%s' "$restore_pid" | cut -f1), started from $(printf '%s' "$restore_pid" | cut -f2)"
	else
		say "  pid file: none"
	fi
	say "  $(bgw "$restore_asker" daemon status 2>&1 | head -n 1)"
	if [ "$OLD_WAS_RUNNING" = 1 ] && [ "$OLD_KNOWN" = 1 ] && [ "$OLD_BACK" = 0 ]; then
		say "  THE DAEMON IS NOT RUNNING. To start it by hand: python3 $OLD/cli/bgw daemon start"
	fi
	if autostart_state; then
		say "  autostart: entry of ours for $(autostart_dir)"
	else
		say "  autostart: no entry of ours"
	fi
	if [ "$MCP_CHANGED" = 1 ] || [ "${A_MCP:-0}" = 1 ]; then
		mcp_read
		if [ "$MCP_RC" = 0 ] && [ -n "$MCP_DIR" ]; then
			say "  claude mcp: starts $MCP_DIR/cli/bgw mcp"
		elif [ "$MCP_RC" = 0 ]; then
			say "  claude mcp: registered, target not readable"
		else
			say "  claude mcp: not registered or not readable"
		fi
	fi
}

cmd_activate() {
	A_FROM=
	A_AUTOSTART=0
	A_MCP=0
	A_UNMARKED=0
	act_target=
	while [ $# -gt 0 ]; do
		case $1 in
			--from)
				[ $# -ge 2 ] || usage
				A_FROM=$2
				shift
				;;
			--autostart) A_AUTOSTART=1 ;;
			--mcp) A_MCP=1 ;;
			--dry-run) DRY=1 ;;
			-*) usage ;;
			*)
				[ -z "$act_target" ] || usage
				act_target=$1
				;;
		esac
		shift
	done
	[ -n "$act_target" ] || usage
	setup
	need_root
	NEW=$(resolve_dir "$act_target") || die "$act_target is not a directory"
	activate_release
}

# NEW, A_FROM, A_AUTOSTART, A_MCP, A_UNMARKED and DRY are set; the releases root exists.
activate_release() {
	# Only a rollback may name a release that is not one of ours: the copy outside the releases root that a first activate came from.
	if [ "$A_UNMARKED" = 0 ]; then
		[ "$(dirname "$NEW")" = "$RELEASES" ] || die "$NEW is not directly inside the releases root $RELEASES"
		has_marker "$NEW" || die "$NEW has no $MARKER: it was not made by deploy.sh prepare - not activating it"
	fi
	check_release_files "$NEW"
	[ -f "$(xpi_of "$NEW")" ] || warn "no XPI at $(xpi_of "$NEW") - the add-on cannot be updated from this release"

	CUR_RAW=$(link_of current)
	CUR_BEFORE=
	if [ -n "$CUR_RAW" ]; then
		[ -d "$CUR_RAW" ] || die "current points at $CUR_RAW, which is not there: name the release that runs with --from"
		CUR_BEFORE=$(cd "$CUR_RAW" && pwd -P)
	fi
	if [ -n "$A_FROM" ]; then
		OLD=$(resolve_dir "$A_FROM") || die "--from $A_FROM is not a directory"
		OLD_KNOWN=1
	elif [ -n "$CUR_BEFORE" ]; then
		OLD=$CUR_BEFORE
		OLD_KNOWN=1
	else
		OLD=$NEW
		OLD_KNOWN=0
	fi
	[ "$OLD_KNOWN" = 0 ] || [ -f "$OLD/cli/bgw" ] || die "$OLD has no cli/bgw: it cannot stop its daemon"
	# What "previous" names now, to put it back should the run end after it was moved.
	PREV_RAW=$(link_of previous)

	if [ "$DRY" = 0 ]; then
		lock
	fi

	if bgw "$NEW" daemon status >/dev/null 2>&1; then
		NEW_RUNNING=1
	else
		NEW_RUNNING=0
	fi
	if [ "$NEW_RUNNING" = 0 ] && bgw "$OLD" daemon status >/dev/null 2>&1; then
		OLD_WAS_RUNNING=1
	fi
	if [ "$OLD_KNOWN" = 0 ]; then
		say "no current release and no --from: the daemon of a release can only be stopped by that release; assuming none runs from elsewhere"
	fi

	AS_STATE_RC=0
	autostart_state || AS_STATE_RC=$?
	[ "$AS_STATE_RC" != 0 ] || AS_ORIG=ours
	AS_DO=0
	if [ "$AS_ORIG" = ours ]; then
		# An entry of ours with something added to its command (a variable in front, say) would lose that.
		[ -n "$(autostart_dir)" ] || die "the autostart entry $DESKTOP_FILE is one of tools/autostart.sh, but its Exec line is not as that tool writes it (changed by hand?). Replacing it would drop the change. Nothing was changed. Remove the entry (sh tools/autostart.sh remove) or put its Exec line back, activate, and make the change again."
		AS_DO=1
	elif [ "$AS_STATE_RC" = 2 ]; then
		[ "$A_AUTOSTART" = 0 ] || die "$DESKTOP_FILE exists and was not written by autostart.sh - not touching it"
		say "autostart: $DESKTOP_FILE is not ours - left alone"
	elif [ "$A_AUTOSTART" = 1 ]; then
		AS_DO=1
	else
		say "autostart: no entry of ours exists - none is made (--autostart makes one)"
	fi

	MCP_REG=0
	if [ "$A_MCP" = 1 ]; then
		[ -x "$CLAUDE_BIN" ] || die "the claude binary $CLAUDE_BIN is not there (BGW_CLAUDE_BIN)"
		mcp_read
		case $MCP_RC in
			0)
				[ "$MCP_PLAIN" = 1 ] || mcp_refuse "$NEW"
				MCP_REG=1
				MCP_ORIG=registered
				MCP_ORIG_DIR=$MCP_DIR
				;;
			1) MCP_ORIG=none ;;
			*) die "claude cannot be run ($CLAUDE_BIN)" ;;
		esac
	fi

	if [ "$DRY" = 1 ]; then
		say "(dry run) nothing below is done"
	fi
	[ "$DRY" = 1 ] || ACTIVE=1

	if [ "$NEW_RUNNING" = 1 ]; then
		say "the daemon of $NEW runs already - not restarting it"
	else
		if [ "$DRY" = 1 ]; then
			say "(dry run) stopping the daemon of $OLD, if one runs: bgw daemon stop"
			say "(dry run) starting the daemon of $NEW: bgw daemon start"
			say "(dry run) waiting until bgw doctor says reachable and proven"
		else
			say "stopping the daemon of $OLD, if one runs: bgw daemon stop"
			STOPPED_OLD=1
			bgw "$OLD" daemon stop || fail "bgw daemon stop of $OLD failed$([ "$OLD_KNOWN" = 1 ] || printf ' (name the release the running daemon was started from with --from)')"
			say "starting the daemon of $NEW: bgw daemon start"
			STARTED_NEW=1
			bgw "$NEW" daemon start || fail "bgw daemon start of $NEW failed"
			say "waiting until bgw doctor says reachable and proven (up to $WAIT_S s)"
			wait_ready "$NEW" || fail "the daemon of $NEW does not answer"
		fi
	fi

	if [ "$AS_DO" = 1 ]; then
		if [ "$DRY" = 1 ]; then
			say "(dry run) replacing the autostart entry $DESKTOP_FILE by one for $NEW"
		else
			say "replacing the autostart entry $DESKTOP_FILE by one for $NEW"
			if [ "$AS_ORIG" = ours ]; then
				AS_BACKUP=$RELEASES/.autostart-backup.$$
				cp -p "$DESKTOP_FILE" "$AS_BACKUP" || fail "cannot keep a copy of $DESKTOP_FILE"
			fi
			AS_CHANGED=1
			sh "$NEW/tools/autostart.sh" install || fail "tools/autostart.sh install of $NEW failed"
		fi
	fi

	if [ "$A_MCP" = 1 ]; then
		if [ "$DRY" = 1 ]; then
			say "(dry run) registering $NEW as the Claude Code MCP server $MCP_NAME (user scope)"
		else
			say "registering $NEW as the Claude Code MCP server $MCP_NAME (user scope)"
			MCP_CHANGED=1
			mcp_set "$NEW" "$MCP_REG" || fail "claude mcp remove or add failed"
		fi
	fi

	if [ "$DRY" = 1 ]; then
		if [ -n "$CUR_BEFORE" ] && [ "$CUR_BEFORE" != "$NEW" ]; then
			say "(dry run) previous -> $CUR_BEFORE"
		elif [ -z "$CUR_BEFORE" ] && [ "$OLD_KNOWN" = 1 ] && [ "$OLD" != "$NEW" ]; then
			say "(dry run) previous -> $OLD"
		fi
		say "(dry run) current -> $NEW"
		say "(dry run) nothing was changed"
		return 0
	fi

	if [ -n "$CUR_BEFORE" ] && [ "$CUR_BEFORE" != "$NEW" ]; then
		say "previous -> $CUR_BEFORE"
		PREV_MOVED=1
		set_link previous "$CUR_BEFORE" || fail "cannot move the previous symlink"
	elif [ -z "$CUR_BEFORE" ] && [ "$OLD_KNOWN" = 1 ] && [ "$OLD" != "$NEW" ]; then
		say "previous -> $OLD"
		PREV_MOVED=1
		set_link previous "$OLD" || fail "cannot move the previous symlink"
	fi
	say "current -> $NEW"
	CUR_MOVED=1
	set_link current "$NEW" || fail "cannot move the current symlink"
	ACTIVE=0

	say "activated $NEW"
	if [ "$A_MCP" = 0 ]; then
		say "the Claude Code registration was not changed (--mcp changes it); deploy.sh status shows where it points"
	fi
	activate_manual_step
}

fail() {
	warn "FAILED: $1"
	restore
	exit 1
}

activate_manual_step() {
	say "one step is left, by hand: install the XPI over the existing add-on in the browser."
	say "  Do NOT remove the add-on first: that deletes the pairing."
	say "  XPI: $(xpi_of "$NEW")"
	say "  then check: python3 $NEW/cli/bgw doctor"
}

# ---------------------------------------------------------------- rollback

cmd_rollback() {
	A_FROM=
	A_AUTOSTART=0
	A_MCP=0
	while [ $# -gt 0 ]; do
		case $1 in
			--from)
				[ $# -ge 2 ] || usage
				A_FROM=$2
				shift
				;;
			--autostart) A_AUTOSTART=1 ;;
			--mcp) A_MCP=1 ;;
			--dry-run) DRY=1 ;;
			*) usage ;;
		esac
		shift
	done
	setup
	need_root
	rb_prev=$(link_of previous)
	[ -n "$rb_prev" ] || die "there is no previous release (no $RELEASES/previous)"
	[ -d "$rb_prev" ] || die "previous points at $rb_prev, which is not there"
	NEW=$(cd "$rb_prev" && pwd -P)
	rb_cur=$(link_of current)
	if [ -n "$rb_cur" ] && [ "$(cd "$rb_cur" 2>/dev/null && pwd -P)" = "$NEW" ]; then
		die "previous and current are the same release ($NEW) - nothing to go back to"
	fi
	# What was current before was accepted when it was activated; a copy outside the root has no marker.
	A_UNMARKED=1
	activate_release
}

# ---------------------------------------------------------------- status

cmd_status() {
	st_from=
	while [ $# -gt 0 ]; do
		case $1 in
			--from)
				[ $# -ge 2 ] || usage
				st_from=$2
				shift
				;;
			*) usage ;;
		esac
		shift
	done
	setup
	st_bad=0
	say "releases root: $RELEASES"
	if [ -d "$RELEASES" ]; then
		RELEASES=$(cd "$RELEASES" && pwd -P)
	else
		say "  (it does not exist yet)"
	fi
	st_cur=
	st_prev=
	if [ -d "$RELEASES" ]; then
		st_cur=$(link_of current)
		st_prev=$(link_of previous)
	fi
	st_curdir=
	if [ -n "$st_cur" ]; then
		if [ -d "$st_cur" ]; then
			st_curdir=$(cd "$st_cur" && pwd -P)
			say "current:  $st_curdir"
		else
			say "current:  $st_cur (MISSING)"
			st_bad=$((st_bad + 1))
		fi
	else
		say "current:  none"
	fi
	if [ -n "$st_prev" ]; then say "previous: $st_prev"; else say "previous: none"; fi
	# The release to ask, and the one everything is compared with.
	st_ask_dir=$st_curdir
	if [ -n "$st_from" ]; then
		st_ask_dir=$(resolve_dir "$st_from") || die "--from $st_from is not a directory"
		if [ -z "$st_curdir" ]; then
			st_curdir=$st_ask_dir
			say "there is no current release: everything below is compared with --from $st_ask_dir"
		fi
	fi

	# The daemon: the pid file says where it was started from; that checkout is the one to ask.
	st_rec=$(pidrec)
	st_runs_from=
	st_pid=
	if [ -n "$st_rec" ]; then
		st_pid=$(printf '%s' "$st_rec" | cut -f1)
		st_runs_from=$(printf '%s' "$st_rec" | cut -f2)
	fi
	st_ask=
	if [ -n "$st_runs_from" ] && [ -f "$st_runs_from/cli/bgw" ]; then
		st_ask=$st_runs_from
	elif [ -n "$st_ask_dir" ] && [ -f "$st_ask_dir/cli/bgw" ]; then
		st_ask=$st_ask_dir
	fi
	if [ -z "$st_ask" ]; then
		say "daemon:   cannot ask: there is no release to ask with (no current, and --from was not given)"
	else
		st_dstat=$(bgw "$st_ask" daemon status --json 2>/dev/null) || true
		st_doc=$(bgw "$st_ask" doctor --json 2>/dev/null) || true
		if [ "$(printf '%s' "$st_dstat" | json_field running)" = true ]; then
			st_line="running, pid $(printf '%s' "$st_dstat" | json_field pid), 127.0.0.1:$PORT, from $st_runs_from"
			if [ "$(printf '%s' "$st_doc" | json_field proof)" = true ]; then
				st_line="$st_line, daemon version $(printf '%s' "$st_doc" | json_field versions.daemon) (proven)"
			else
				st_line="$st_line, NOT proven: $(printf '%s' "$st_doc" | json_field problem)"
				st_bad=$((st_bad + 1))
			fi
			say "daemon:   $st_line"
			if [ -n "$st_curdir" ] && [ "$st_runs_from" != "$st_curdir" ]; then
				say "  DOES NOT POINT AT CURRENT: the daemon runs from $st_runs_from"
				st_bad=$((st_bad + 1))
			fi
		elif [ "$(printf '%s' "$st_doc" | json_field reachable)" = true ]; then
			say "daemon:   a gateway answers on 127.0.0.1:$PORT but not one started by bgw daemon from a known release (pid file: ${st_pid:-none})"
			st_bad=$((st_bad + 1))
		else
			say "daemon:   not running (127.0.0.1:$PORT)"
		fi
	fi

	if autostart_state; then
		st_as=$(autostart_dir)
		say "autostart: $DESKTOP_FILE starts the daemon of ${st_as:-an unreadable path}"
		if [ -n "$st_curdir" ] && [ "$st_as" != "$st_curdir" ]; then
			say "  DOES NOT POINT AT CURRENT"
			st_bad=$((st_bad + 1))
		fi
	else
		st_rc=$?
		if [ "$st_rc" = 2 ]; then say "autostart: $DESKTOP_FILE exists but is not ours"; else say "autostart: no entry ($DESKTOP_FILE)"; fi
	fi

	if [ -x "$CLAUDE_BIN" ]; then
		mcp_read
		case $MCP_RC in
			0)
				if [ -n "$MCP_DIR" ]; then
					say "mcp:      Claude Code starts $MCP_DIR/cli/bgw mcp"
					if [ -n "$st_curdir" ] && [ "$MCP_DIR" != "$st_curdir" ]; then
						say "  DOES NOT POINT AT CURRENT"
						st_bad=$((st_bad + 1))
					fi
				else
					say "mcp:      registered, but its target could not be read from claude mcp get"
				fi
				if [ "$MCP_PLAIN" = 0 ]; then
					say "  not the plain registration this tool makes ($MCP_WHY): activate --mcp will not replace it"
					say "  found: $(mcp_found)"
				fi
				;;
			1) say "mcp:      not registered in Claude Code" ;;
			*) say "mcp:      claude cannot be run ($CLAUDE_BIN)" ;;
		esac
	else
		say "mcp:      claude binary not found ($CLAUDE_BIN)"
	fi

	if [ "$st_bad" = 0 ]; then
		say "result: everything that is set points at current"
	else
		say "result: $st_bad item(s) do not point at current or are not healthy"
		return 1
	fi
}

# ---------------------------------------------------------------- list, prune

# Name lines of the releases of this tool, newest first: "created<TAB>name".
releases_newest_first() {
	for rel_d in "$RELEASES"/*/; do
		rel_d=${rel_d%/}
		[ -d "$rel_d" ] && [ ! -L "$rel_d" ] || continue
		has_marker "$rel_d" || continue
		rel_n=$(basename "$rel_d")
		case $rel_n in
			*[[:cntrl:]]*) continue ;;
		esac
		rel_c=$(marker_get "$rel_d" created)
		printf '%s\t%s\n' "${rel_c:-0}" "$rel_n"
	done | sort -r
}

cmd_list() {
	[ $# -eq 0 ] || usage
	setup
	need_root
	ls_cur=$(link_of current)
	ls_prev=$(link_of previous)
	say "releases in $RELEASES (newest first)"
	releases_newest_first | while IFS="$(printf '\t')" read -r ls_created ls_name; do
		ls_flags=
		[ "$RELEASES/$ls_name" != "$ls_cur" ] || ls_flags="$ls_flags current"
		[ "$RELEASES/$ls_name" != "$ls_prev" ] || ls_flags="$ls_flags previous"
		[ -f "$(xpi_of "$RELEASES/$ls_name")" ] || ls_flags="$ls_flags no-xpi"
		printf 'deploy:   %-28s %s%s\n' "$ls_name" "$ls_created" "$ls_flags"
	done
	for ls_d in "$RELEASES"/*/; do
		ls_d=${ls_d%/}
		[ -d "$ls_d" ] && [ ! -L "$ls_d" ] || continue
		has_marker "$ls_d" || printf 'deploy:   %-28s (no marker: not made by this tool, never pruned)\n' "$(basename "$ls_d")"
	done
}

cmd_prune() {
	pr_keep=
	pr_yes=0
	pr_force=0
	while [ $# -gt 0 ]; do
		case $1 in
			--keep)
				[ $# -ge 2 ] || usage
				pr_keep=$2
				shift
				;;
			--yes) pr_yes=1 ;;
			--force) pr_force=1 ;;
			--dry-run) DRY=1 ;;
			*) usage ;;
		esac
		shift
	done
	case $pr_keep in
		'' | *[!0-9]*) die "prune needs --keep <N>, a number" ;;
	esac
	setup
	need_root
	[ "$DRY" = 1 ] || [ "$pr_yes" = 0 ] || lock

	# What is never removed: the two links, the checkout the daemon runs from, the one the autostart entry names
	# and the one Claude Code is registered to.
	pr_cur=$(link_of current)
	pr_prev=$(link_of previous)
	pr_daemon=$(pidrec | cut -f2)
	pr_auto=
	if autostart_state; then pr_auto=$(autostart_dir); fi
	# Where Claude Code cannot say which release it starts, any of them might be the one: nothing is removed
	# then, unless --force says that none of them is.
	pr_mcp=
	pr_unknown=
	if [ -x "$CLAUDE_BIN" ]; then
		mcp_read
		case $MCP_RC in
			0)
				if [ -z "$MCP_DIR" ]; then
					pr_unknown="what claude mcp get says about $MCP_NAME could not be read"
				elif [ -d "$MCP_DIR" ]; then
					pr_mcp=$(cd "$MCP_DIR" && pwd -P) || pr_mcp=$MCP_DIR
				else
					pr_mcp=$MCP_DIR
				fi
				;;
			1) [ "$MCP_SAID_NONE" = 1 ] || pr_unknown="claude mcp get $MCP_NAME failed without saying that there is no such server" ;;
			*) pr_unknown="claude cannot be run ($CLAUDE_BIN)" ;;
		esac
	else
		pr_unknown="the claude binary is not there ($CLAUDE_BIN, BGW_CLAUDE_BIN)"
	fi
	if [ -n "$pr_unknown" ]; then
		if [ "$pr_force" = 1 ]; then
			say "Claude Code was not asked which release it starts ($pr_unknown): --force, so none is kept for that"
		else
			say "Claude Code could not be asked which release it starts: $pr_unknown"
		fi
	fi
	pr_n=0
	pr_list=$(releases_newest_first | cut -f2)
	[ -n "$pr_list" ] || {
		say "no releases of this tool in $RELEASES"
		return 0
	}
	# A name with a line break was left out of the list.
	printf '%s\n' "$pr_list" | while IFS= read -r pr_name; do
		pr_n=$((pr_n + 1))
		pr_dir=$RELEASES/$pr_name
		if [ "$pr_n" -le "$pr_keep" ]; then
			say "keeping $pr_name (among the newest $pr_keep)"
			continue
		fi
		pr_why=
		[ "$pr_dir" != "$pr_cur" ] || pr_why=current
		[ "$pr_dir" != "$pr_prev" ] || pr_why=previous
		[ "$pr_dir" != "$pr_daemon" ] || pr_why="the daemon runs from it"
		[ "$pr_dir" != "$pr_auto" ] || pr_why="the autostart entry starts it"
		[ "$pr_dir" != "$pr_mcp" ] || pr_why="Claude Code is registered to it"
		if [ -z "$pr_why" ] && [ -n "$pr_unknown" ] && [ "$pr_force" = 0 ]; then
			pr_why="Claude Code may be registered to it; --force removes it all the same"
		fi
		if [ -n "$pr_why" ]; then
			say "keeping $pr_name ($pr_why)"
			continue
		fi
		if ! safe_to_remove "$pr_dir"; then
			say "keeping $pr_name (not safe to remove: not a plain directory of this tool in the root)"
			continue
		fi
		if [ "$DRY" = 1 ] || [ "$pr_yes" = 0 ]; then
			say "would remove $pr_name"
		else
			say "removing $pr_name"
			rm -rf -- "$pr_dir"
		fi
	done
	if [ "$DRY" = 1 ]; then
		say "(dry run) nothing was removed"
	elif [ "$pr_yes" = 0 ]; then
		say "nothing was removed: add --yes to remove what is listed above"
	fi
}

safe_to_remove() {
	[ ! -L "$1" ] && [ -d "$1" ] || return 1
	[ "$(dirname "$1")" = "$RELEASES" ] || return 1
	case $(basename "$1") in
		.* | '') return 1 ;;
	esac
	has_marker "$1"
}

# ---------------------------------------------------------------- main

[ $# -ge 1 ] || usage
sub=$1
shift
case $sub in
	prepare) cmd_prepare "$@" ;;
	activate) cmd_activate "$@" ;;
	status) cmd_status "$@" ;;
	rollback) cmd_rollback "$@" ;;
	list) cmd_list "$@" ;;
	prune) cmd_prune "$@" ;;
	*) usage ;;
esac
