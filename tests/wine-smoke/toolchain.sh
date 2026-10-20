#!/bin/sh
# Phase A: prove the Wine toolchain. Runs inside the container.
fail=0
export WINEPATH='Z:\opt\node;Z:\opt\python'
t() { # label cmd...
	label=$1; shift
	# Output goes to a file: under Wine, node's console.log to a pipe fails with EBADF.
	xvfb-run -a "$@" >/tmp/t.out 2>&1
	rc=$?
	out=$(tr -d '\r' </tmp/t.out | grep -v '^X connection to' | tail -n 4 | tr '\n' ' ')
	if [ "$rc" = 0 ]; then echo "PASS $label: $out"; else echo "FAIL $label (exit $rc): $out"; fail=$((fail + 1)); fi
}
t node-version wine /opt/node/node.exe --version
t python-version wine /opt/python/python.exe --version
t node-sqlite-fts5 wine /opt/node/node.exe -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('CREATE VIRTUAL TABLE t USING fts5(a)');d.exec(\"INSERT INTO t VALUES('hello world')\");console.log(JSON.stringify(d.prepare(\"SELECT a FROM t WHERE t MATCH 'hello'\").all()))"
t python-imports wine /opt/python/python.exe -c "import ctypes, msvcrt, socket, threading, queue; print('imports ok')"
exit "$fail"
