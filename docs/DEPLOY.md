# Updating a running gateway

`tools/deploy.sh` keeps every installed version of the gateway as a release: a clean copy of one commit,
side by side, and moves the running setup from one release to the next. Nothing here replaces your
judgement about when to restart: the daemon is stopped and started again, so any agent session that is using the
gateway at that moment loses its connection.

All commands are run from the repository (your checkout), with `sh tools/deploy.sh ...`. They work on the host
and from inside a Flatpak sandbox (node, npm and claude are then reached through `flatpak-spawn --host`).

This tool is for a daemon that runs as a plain process (`bgw daemon start`, `tools/autostart.sh`). Where the
systemd units of `tools/install.sh` start the daemon, an update is `sh tools/deploy.sh prepare <commit> --install-deps`
and then `sh <release>/tools/install.sh user` (or `sudo sh <release>/tools/install.sh global`) from the new
release; `activate` is not used.

## What a release is

A release is the directory `<releases root>/<version>-<short commit>/`, for example `0.1.9-1a2b3c4/`:

- the commit as `git archive` makes it, so no uncommitted change of the working tree is in it;
- `node_modules` - a symlink to the repository's `node_modules` (or, with `--install-deps`, a real
  `npm ci --omit=dev` of its own);
- `dist/browser-gateway-<version>.xpi` (the add-on file), built there;
- a file `.bgw-release` that marks the directory as made by this tool.

The releases root is `~/.local/share/browser-gateway/releases/` unless `BGW_RELEASES_ROOT` says otherwise.
Two symlinks in it say where the setup stands: `current` (the release that runs) and `previous` (the one
before; `rollback` goes there). Only this tool should move them.

## The update, step by step

### 1. Prepare

    sh tools/deploy.sh prepare HEAD

Any commit-ish will do. This makes the release directory, links or installs `node_modules`, builds the XPI and
checks the vendored bundle (`node tools/vendor.mjs --check`, on the host). It prints the path of the XPI.

It touches nothing that is live: not the daemon, not the autostart entry, not Claude Code, not the browser.
It only creates the new directory (and the releases root, the first time). It refuses when the directory
exists already. An interrupted or failed prepare removes its half-made directory; if it was killed hard, a
directory `.prepare-...` may stay in the releases root and can be deleted by hand.

### 2. Pick a moment

Choose a time when no agent session is using the gateway, and when you can reach the browser to finish the
update. The tool cannot tell whether a session is in use.

Optional: see what step 3 would do.

    sh tools/deploy.sh activate <release-dir> --autostart --mcp --dry-run

A dry run reads the state (it asks the daemon and Claude Code) and prints every step; it changes nothing.

### 3. Activate

    sh tools/deploy.sh activate <release-dir> --mcp

`<release-dir>` is the path printed by `prepare`, or just its name. The steps, in this order:

1. Stop the running daemon, using the `bgw daemon stop` of the release that is `current` (or of the
   directory named with `--from`).
2. Start the daemon from the new release (`bgw daemon start`).
3. Wait until `bgw doctor` of the new release says the daemon is reachable and proven (it holds the agent
   token). It does not wait for the browser: pairing and the extension connection are not needed for this.
4. If the autostart entry `~/.config/autostart/browser-gateway.desktop` exists and is the one
   `tools/autostart.sh` wrote - or when `--autostart` is given - replace it with the new release's. An entry of
   ours whose `Exec` line was changed by hand is not replaced: the command ends with exit code 2 and nothing is
   changed.
5. With `--mcp`: remove and add the Claude Code registration `browser-gateway` (user scope) so it runs
   `python3 <new release>/cli/bgw mcp`. Without `--mcp`, Claude Code is not touched. A registration that is not
   the plain user-scope one - another scope, environment variables such as `BGW_URL` or `BGW_DOWNLOAD_DIR`, another
   command, or output that cannot be read - is not replaced: the command ends with exit code 2 before anything is
   changed and prints what it found (names of variables, never values) and the two `claude mcp` commands to move
   it by hand.
6. Move `previous` to the old release and `current` to the new one. Both moves are atomic.

If the daemon was already running from the new release (a second run of the same command), steps 1 to 3 are
skipped and the rest is made sure of again, so the command can be repeated.

If a step fails or the command is interrupted (Ctrl-C), before the symlinks moved or also between the two
symlink moves, the tool undoes what it did: stops the new daemon, puts the autostart entry and the registration
back as they were, puts `previous` and `current` back to what they named before, and starts the
old daemon again if it was running before. It then prints the state: which release `current` names (not
moved), whether a daemon runs and from where, what the autostart entry and the registration point at. If the
old daemon cannot be started again it says so in capitals and gives the command.

It ends by printing the one step it cannot do:

### 4. Update the add-on, by hand

Install the XPI that `activate` printed over the add-on that is in the browser (about:addons, install from
file, or however the add-on was installed before). **Do not remove the old add-on first**: that deletes the
pairing and you would have to pair again.

This tool never touches the browser.

Daemon and add-on have to be of the same protocol version. Between `activate` and
the add-on update the options page of the add-on shows "Version mismatch" (an
add-on from before protocol version 5 shows "Daemon not verified ... reports
another protocol version" instead), and `bgw doctor` says "an extension that
speaks protocol version N was turned away, this daemon speaks protocol version M:
update the daemon and the extension to the same release". The pairing stays; no
new code is needed. After the add-on is updated, or after a change of the daemon
alone, press Reconnect in the add-on's options (or restart the browser).

### 5. Verify

    sh tools/deploy.sh status
    python3 <release>/cli/bgw doctor

`status` shows the releases root, `current` and `previous`, the running daemon (pid, where it was started
from, port, version as the daemon reports it - this is the version of `package.json`, not that of the
extension), the autostart entry's target and the Claude Code registration's target. Whatever does not point
at `current` is flagged with `DOES NOT POINT AT CURRENT`, and the exit code is 1. `bgw doctor` also says
whether the extension is paired and connected, which only the browser step can make true.

`status` asks Claude Code with `claude mcp get browser-gateway`, which makes Claude Code start the helper to
check on it; that takes a moment. If the output of that command cannot be read, `status` says so instead of
guessing.

### 6. Roll back, if needed

    sh tools/deploy.sh rollback --mcp

This is `activate` for the release that `previous` names, with the same steps, the same undo on failure and
the same switches (`--autostart`, `--mcp`, `--from`, `--dry-run`). Afterwards `previous` names the release you
came from, so a second `rollback` goes forward again. The browser add-on stays as it is: if the older daemon
needs the older add-on, install that release's XPI by hand (the browser may refuse to install an older
version over a newer one; that is the browser's rule, not this tool's). Until the
add-on matches the daemon again the link does not come up (from protocol version
5 on, the options page says "Version mismatch"); press Reconnect afterwards.

Use the same switches as for the activation you undo: an entry or registration that was moved with
`--autostart` or `--mcp` is only moved back when asked. An autostart entry of ours is moved along without
the switch, as in `activate`.

## Other commands

    sh tools/deploy.sh list
    sh tools/deploy.sh prune --keep 3
    sh tools/deploy.sh prune --keep 3 --yes
    sh tools/deploy.sh prune --keep 3 --yes --force

`list` shows the releases, newest first, marking `current` and `previous`.

`prune` removes old releases: it keeps the `N` newest, and never touches `current`, `previous`, the release the
running daemon was started from, the one the autostart entry names, the one Claude Code is registered to, a
directory without the marker file, or a symlink. Where Claude Code cannot be asked (no claude binary at
`BGW_CLAUDE_BIN`, `claude mcp get` fails without saying that there is no such server, or its output cannot be
read), nothing is removed unless `--force` is given. Without `--yes` (or with `--dry-run`) it only prints what it
would remove. A removed release is gone: `rm -r` does not follow the `node_modules` link, so the repository is
not affected.

## What each command touches

| command | creates or changes | stops or starts |
| --- | --- | --- |
| `prepare` | a new release directory in the releases root (and the root itself) | nothing |
| `activate` | the autostart entry, the Claude Code registration (with `--mcp`), the two symlinks; a short-lived lock directory `.deploy.lock` and, while it runs, a backup of the autostart entry in the root | stops the old daemon, starts the new one |
| `rollback` | the same as `activate` | the same |
| `status`, `list` | nothing | nothing (it asks the daemon and Claude Code) |
| `prune --yes` | removes release directories | nothing (it asks Claude Code) |

The daemon's own data (`~/.local/share/browser-gateway/` apart from `releases/`) and config
(`~/.config/browser-gateway/`) are never written by this tool; the daemon keeps using them across releases.
The releases root lies inside the data directory, so `sh tools/install.sh uninstall user --purge` (which deletes
the data directory) removes the releases kept there as well.

## What is not done automatically

- The browser add-on: step 4, always by hand.
- Claude Code is only re-registered with `--mcp`. Otherwise `status` will flag a registration that points at an
  older release.
- No agent session is checked for; the daemon restart cuts connections.
- Nothing is deleted unless you run `prune --yes`.

## First time: moving from a copy outside the releases root

If the gateway runs from a plain checkout or a copy you made by hand (a directory that is not under the releases
root), the first activation has to be told where the running daemon comes from:

    sh tools/deploy.sh prepare HEAD
    sh tools/deploy.sh status --from /path/to/the/old/copy
    sh tools/deploy.sh activate <new release> --from /path/to/the/old/copy --autostart --mcp --dry-run
    sh tools/deploy.sh activate <new release> --from /path/to/the/old/copy --autostart --mcp

There is no `current` yet, so `--from` names the copy whose daemon is stopped, whose autostart entry is replaced
and whose registration is replaced. Without it the tool cannot stop that daemon (a daemon is only stopped by the
copy it was started from) and the activation stops at the first step, with nothing changed. The old copy becomes
`previous`, so `rollback` can go back to it. Then do steps 4 and 5 as above. When the new setup has proved itself,
the old copy can be deleted by hand; `prune` does not know it.

## Where things can go wrong

- `another deploy.sh runs, or one was killed`: `activate`, `rollback` and `prune --yes` take the lock
  directory `<releases root>/.deploy.lock`. If no deploy runs, delete that directory.
- `current is not a symlink`: something else made it. The tool does not replace what it did not make.
- `... was not written by autostart.sh`: a desktop entry of that name exists that this tool family did not write.
  With `--autostart` the activation is refused before anything changes; without it, the file is left alone.
- `claude mcp get` output that cannot be read: `status` prints "target could not be read" and `activate --mcp`
  refuses with exit code 2, nothing changed.
- A daemon that was started another way than `bgw daemon start`, or by another program, holds the port: the
  start step fails and the previous release is started again.

## For tests and other setups

Every external location can be overridden; the tests in `tests/unit/deploy.test.js` set all of them to scratch
places, with a fake `claude`:

| variable | meaning | default |
| --- | --- | --- |
| `BGW_RELEASES_ROOT` | the releases root | `$HOME/.local/share/browser-gateway/releases` (literal home, never XDG) |
| `BGW_AUTOSTART_DIR` | as `tools/autostart.sh` | `$HOME/.config/autostart` |
| `BGW_CONFIG_DIR`, `BGW_DATA_DIR` | as the daemon and `bgw daemon` | `~/.config/browser-gateway`, `~/.local/share/browser-gateway` |
| `BGW_URL` | `http://127.0.0.1:<port>`; the port of the daemon | port 8791 |
| `BGW_CLAUDE_BIN` | absolute path of the claude binary | `$HOME/.local/bin/claude` |
| `BGW_NODE_BIN`, `BGW_NPM_BIN` | node and npm on the host | from the host's `PATH` |
| `BGW_DEPLOY_WAIT_S` | seconds a daemon gets to be reachable and proven | 30 |

Exit codes: 0 done, 1 a step failed (the state has been printed), 2 refused or wrong usage (nothing changed).
