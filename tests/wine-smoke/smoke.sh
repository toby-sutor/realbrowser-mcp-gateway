#!/bin/sh
# shellcheck disable=SC2329  # rc0, rc0_and_port, data_ok are called through chk
# Phase B: smoke steps for the Windows port, run inside the container by run.sh.
# Each step prints PASS/FAIL with a reason; exit code = number of failures.
export WINEPATH='Z:\opt\node;Z:\opt\python'
PORT=${SMOKE_PORT:-18791}
LOGS=/logs
mkdir -p "$LOGS"
fails=0

# Writable copy of the repo (the mount is read-only) at Z:\work\repo, as the python ._pth expects.
rm -rf /work; mkdir -p /work
cp -R /repo /work/repo
rm -rf /work/repo/.git /work/repo/node_modules
cp -R /nm/node_modules /work/repo/node_modules

LA_UNIX=/opt/wineprefix/drive_c/bgw-localappdata
rm -rf "$LA_UNIX"; mkdir -p "$LA_UNIX"
export LOCALAPPDATA='C:\bgw-localappdata'
# Wine sets LOCALAPPDATA from its own profile for Windows programs, so the place is named outright.
export BGW_CONFIG_DIR='C:\bgw-localappdata\browser-gateway\config'
export BGW_DATA_DIR='C:\bgw-localappdata\browser-gateway\data'
# bgw finds its tokens by these, not by BGW_CONFIG_DIR (as on Linux).
export BGW_TOKEN_FILE='C:\bgw-localappdata\browser-gateway\config\client.token'
export BGW_ADMIN_TOKEN_FILE='C:\bgw-localappdata\browser-gateway\config\admin.token'
export BGW_PORT="$PORT"
export BGW_URL="http://127.0.0.1:$PORT"
export BGW_ON_DEMAND=0
BGW='Z:\work\repo\cli\bgw'
DATA="$LA_UNIX/browser-gateway/data"

pass() { printf "PASS %s: %s\n" "$1" "$2"; }
fail() { printf "FAIL %s: %s\n" "$1" "$2"; fails=$((fails + 1)); }
# chk LABEL PASSMSG FAILMSG cmd...: PASS if cmd succeeds, else FAIL
chk() { l=$1; p=$2; f=$3; shift 3; if "$@"; then pass "$l" "$p"; else fail "$l" "$f"; fi; }
rc0() { [ "$RC" = 0 ]; }
rc0_and_port() { [ "$RC" = 0 ] && wait_port "$1"; }
data_ok() { [ -s "$DATA/index.db" ]; }
tail3() { printf '%s' "$OUT" | tail -n 3 | tr '\n' ' '; }

# bgw <logname> args... : run python.exe cli\bgw; sets OUT (CR stripped) and RC; writes $LOGS/<logname>.log
bgw() {
	name=$1; shift
	# Through a file, not $(...): under Wine a detached node.exe keeps the Unix stderr of wine, and a pipe there never ends.
	timeout 90 wine /opt/python/python.exe "$BGW" "$@" >"$LOGS/$name.raw" 2>&1 </dev/null; RC=$?
	OUT=$(tr -d '\r' <"$LOGS/$name.raw")
	{ echo "\$ bgw $*"; echo "$OUT"; echo "[exit $RC]"; } > "$LOGS/$name.log"
}

# Any HTTP answer (or an empty reply) counts as open; only "connection refused" (7) is closed.
port_open() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; [ $? -ne 7 ]; }
wait_port() { # state: open|closed
	i=0
	while [ $i -lt 30 ]; do
		if [ "$1" = open ] && port_open; then return 0; fi
		if [ "$1" = closed ] && ! port_open; then return 0; fi
		sleep 1; i=$((i + 1))
	done
	return 1
}
node_running() { pgrep -f 'node.exe' >/dev/null 2>&1; }

# One virtual display for the whole run.
Xvfb :99 -screen 0 800x600x16 >"$LOGS/xvfb.log" 2>&1 &
export DISPLAY=:99
sleep 1

echo "== a. daemon start/status"
bgw a-start daemon start
chk a1-start "exit 0" "exit $RC: $(tail3)" rc0
bgw a-status daemon status
chk a2-status "exit 0" "exit $RC: $(tail3)" rc0
chk a3-port "port $PORT answers" "port $PORT closed" wait_port open
chk a4-pidfile "present" "no $DATA/daemon.pid" test -f "$DATA/daemon.pid"

echo "== b. doctor"
bgw b-doctor doctor
if echo "$OUT" | grep -q '^reachable: yes' && echo "$OUT" | grep -q '^proof:     ok'; then
	pass b-doctor "reachable and proven (exit $RC, expected non-zero while unpaired)"
else
	fail b-doctor "exit $RC: $(echo "$OUT" | head -n 4 | tr '\n' ' ')"
fi

echo "== c. mcp over stdin"
# Feed requests, keep stdin open a few seconds, then close it: bgw mcp must exit by itself.
{
	printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
	printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
	printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
	sleep 5
} | timeout 60 wine /opt/python/python.exe "$BGW" mcp >"$LOGS/c-mcp.out" 2>"$LOGS/c-mcp.err"
RC=$?
tr -d '\r' <"$LOGS/c-mcp.out" >"$LOGS/c-mcp.out.clean"
if [ "$RC" = 0 ]; then pass c-exit "exited with 0 after stdin closed"; else fail c-exit "bgw mcp exit $RC after stdin closed (124: timeout)"; fi
if grep -q '"id":2' "$LOGS/c-mcp.out.clean" && grep -q browser_fetch "$LOGS/c-mcp.out.clean" && grep -q browser_search "$LOGS/c-mcp.out.clean"; then
	pass c-tools "tools/list reply with browser_fetch, browser_search"
else
	fail c-tools "no valid tools/list reply; out: $(head -c 300 "$LOGS/c-mcp.out.clean" | tr '\n' ' ') err: $(tail -n 3 "$LOGS/c-mcp.err" | tr '\n' ' ')"
fi

echo "== d. stop, restart, stop"
bgw d-stop1 daemon stop
chk d1-stop "exit 0" "exit $RC: $(tail3)" rc0
chk d2-port-closed "port closed" "port $PORT still open" wait_port closed
sleep 1
if node_running; then fail d3-gone "node.exe still running"; else pass d3-gone "no node.exe process"; fi
bgw d-start2 daemon start
chk d4-restart "daemon back up" "exit $RC: $(tail3)" rc0_and_port open
bgw d-stop2 daemon stop
chk d5-stop2 "stopped again" "exit $RC: $(tail3)" rc0_and_port closed
ls "$DATA" >"$LOGS/d-datadir.txt" 2>&1
listing=$(tr '\n' ' ' <"$LOGS/d-datadir.txt")
chk d6-data "data dir survives: $listing" "no database in $DATA: $listing" data_ok

echo "== e. start on demand"
export BGW_ON_DEMAND=1
bgw e-pages pages smoke
if wait_port open; then
	pass e-ondemand "daemon came up on demand (bgw exit $RC: $(echo "$OUT" | head -n 2 | tr '\n' ' '))"
else
	fail e-ondemand "daemon not up after on-demand command (exit $RC): $(echo "$OUT" | head -n 4 | tr '\n' ' ')"
fi
export BGW_ON_DEMAND=0
bgw e-stop daemon stop
chk e-stop "stopped" "port still open: $(tail3)" wait_port closed

cp "$DATA/daemon.log" "$LOGS/daemon.log" 2>/dev/null
echo "failures: $fails"
exit "$fails"
