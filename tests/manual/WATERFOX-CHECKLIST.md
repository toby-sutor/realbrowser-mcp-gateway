# Waterfox checklist

What only you can check: a real Firefox-family browser (written for Waterfox) on
your own desktop, with live sites. Everything else is covered by the automated tests, which run on a
headless Firefox with made-up pages and never reach your desktop or the web.

Work from top to bottom. Each step says what to do, what should happen, and
what to write down. One line per step is enough: `ok`, or what you saw instead.
Where a step says "copy the result", the first six lines of the output will do.

You need: a terminal in this checkout, the browser running, about an hour. Some
steps name KDE tools or Plasma; skip what your desktop does not have.
`bgw` below means `cli/bgw`.

## A. Install and pairing

1. **Daemon.** Either of the two ways, not both.
   With systemd: run `sh tools/install.sh user`. Expect: it prints `browser-gateway is installed for you; systemd holds 127.0.0.1:8791 and starts the daemon on the first connection`, then the three unit files, the checkout it runs from, the `node:` path written into the unit, and the config and data directories; `systemctl --user status browser-gateway.socket` says `active (listening)`; `sh tools/install.sh status` ends with `mode:         user` and exits 0. If your Node is installed below your home directory (nvm, fnm, volta), the script refuses with a sentence that says why and installs nothing: use the other way below. If the daemon does not answer, it removes the three units again and names `journalctl --user -u browser-gateway`. (This route was used on one desktop and otherwise only exercised in scratch directories with a stand-in for `systemctl`: say exactly what you see. `sh tools/install.sh` without a word prints its help and installs nothing.)
   Without: stop a daemon you started by hand first, then run `bgw daemon start`. Expect: `bgw daemon: started, pid ..., 127.0.0.1:8791, log .../daemon.log`; `bgw daemon status` says `running`; `bgw doctor` says `proof: ok`. `bgw daemon start` a second time says `already running - not starting a second one`. `bgw daemon stop` says `stopped, pid ...` and `bgw status` then says the daemon is not running; start it again. (If `bgw daemon stop` ever says `the pid file was empty`, a start was killed in the middle: the file is removed. If it also names a gateway daemon that answers on the port, end that node process by hand.) All of it works the same from a terminal on the host and from one inside a Flatpak sandbox.
   Report: which way you chose; ok, or the error text.

1a. **Start at login (only without systemd).** `sh tools/autostart.sh status` (expect: `not installed`), `sh tools/autostart.sh install` (expect: `wrote /home/<you>/.config/autostart/browser-gateway.desktop`), `status` again (expect: `installed ... starts the daemon of <this checkout>`). Open System Settings, Autostart: one entry "Browser Gateway daemon". Log out and in again.
   Expect: after login `bgw daemon status` says `running` without you having started anything, and the add-on connects by itself. `sh tools/autostart.sh remove` takes the entry away again (the running daemon stays).
   Report: ok; how long after login the daemon was up; or what did not start. Know what this way lacks: no sandbox, and the port is free until the daemon is up (step 1c shows what protects the token then). While the entry exists, `sh tools/install.sh user` refuses and names `sh tools/autostart.sh remove`.

1b. **Claude Code over stdio.** Run `bgw mcp-config` and register the gateway with the command it prints (`claude mcp add --scope user browser-gateway -- python3 <path>/cli/bgw mcp`). If an HTTP entry for the gateway is registered, remove that one (`claude mcp remove ...`): it sends the token to whatever listens. Start a new Claude Code session and run `/mcp`.
   Expect: `browser-gateway` is listed as connected with six tools (`browser_fetch`, `browser_search`, `page_read`, `page_search`, `gateway_status`, and `file_export`, which the helper answers itself). Ask the agent to call `gateway_status`: it reports `paired: true` and `extension_connected: true`.
   Report: ok, or what `/mcp` shows.

1c. **The helper does not trust the port.** With the session of step 1b open: `bgw daemon stop` (or stop your hand-started daemon), then ask the agent for `gateway_status`. Expect: an error result that says `the gateway daemon is not running on 127.0.0.1:8791 (start it with: bgw daemon start)`; the MCP server stays connected. Then put a stand-in on the port: `python3 -m http.server 8791 --bind 127.0.0.1` in a terminal, and ask again. Expect: `the process on 127.0.0.1:8791 is not the gateway daemon - no token and no request was sent to it`; the terminal of the stand-in shows one `POST /v1/prove` (answered 501) and nothing else - no `/mcp`, no `Authorization`. Stop the stand-in (Ctrl+C), `bgw daemon start`, ask a third time.
   Expect: the tool works again, without restarting Claude Code.
   Report: ok for each of the three, or the sentences you got.

1d. **Start on demand (only without systemd).** `bgw daemon stop`, then `sh tools/install.sh on-demand`. Expect: `starting on demand is switched on: /home/<you>/.config/browser-gateway/on-demand`, and `bgw daemon status` still says `not running`. `bgw status` says `daemon is not running on 127.0.0.1:8791 (connection refused) - it is started on demand by the next command that needs it (...)` and starts nothing. With the browser open, run `bgw fetch https://example.com/`.
   Expect: on stderr `bgw: the daemon was not running on 127.0.0.1:8791 - started it on demand (pid ..., log ...)`, then `bgw: waiting up to 45 s for the browser extension to connect to the daemon`, then within 45 seconds the page (`[browser-gateway] outcome=ok`). `bgw daemon status` says `running`. A second fetch prints neither line. Then `bgw daemon stop`, and in the Claude Code session of step 1b ask for `gateway_status`.
   Expect: the tool answers (the helper started the daemon); `bgw daemon status` says `running` again. Put the stand-in of step 1c on the port with the daemon stopped and ask once more: `the process on 127.0.0.1:8791 is not the gateway daemon - no token and no request was sent to it`, and `bgw daemon status` says `not running`: no daemon was started next to the stand-in. `sh tools/install.sh uninstall on-demand` switches it off again (the running daemon stays).
   Report: ok; how many seconds the first fetch waited for the add-on; or the lines you got.

2. **Add-on.** In Waterfox open `about:addons`, the gear menu, "Install Add-on From File", and pick `dist/browser-gateway-<version>.xpi` (built with `npm run xpi`).
   Expect: a permission prompt that lists, among others, "Download files and read and modify the browser's download history"; after "Add" the toolbar button appears with the badge `pair`. A container named "Browser Gateway" exists (the containers menu shows it). The add-on needs Firefox 140 or later, and its manifest does not allow it in private windows. Over an installed older version of the add-on it asks for nothing new when the release adds no permission, and stays paired.
   Report: ok, the full list of permissions as the prompt words them, your browser's version, and whether you accept the downloads permission.
   Add-on and daemon must come from the same release (restart the daemon after an update). With a mismatch the add-on's options page says (from protocol version 5 on) "Version mismatch: this extension speaks protocol version N and the daemon another one. Update the daemon and the extension to the same release." and does not connect; `bgw doctor` names it too. An add-on from before protocol version 5 cannot say so: it shows "Daemon not verified ... reports another protocol version". Nothing is lost by it: the pairing stays. After the update press Reconnect in the options (or restart the browser).

3. **Pairing.** Run `bgw pair`, open the add-on's options (toolbar button, "Options"), paste the code, press "Pair".
   Expect: "Paired. The extension is connected." The badge is empty. `bgw doctor` ends with `result:    ready`.
   Report: ok, or the line of `bgw doctor` that is not as expected.

4. **Restart.** Quit Waterfox completely and start it again.
   Expect: within a few seconds `bgw status` says `extension: connected`. No pairing is asked for.
   Report: ok, and how long it took.

5. **Update in place.** Install the same XPI file again over the installed one (step 2).
   Expect: still paired, still connected.
   Report: ok.

## B. The gateway window

6. **First fetch.** With the Waterfox window in front, run `bgw fetch https://example.com/`.
   Expect: a second Waterfox window titled "Browser Gateway - ..." is created with a park tab; a tab opens in it, loads, closes. The result on the terminal starts with `[browser-gateway] outcome=ok` and `scope=container`.
   Report: ok; whether the new window came to the front; whether it took the keyboard focus (type a few letters into a text field elsewhere while it appears and say where they went).

7. **Second fetch, window covered.** Put another window fully over the gateway window. Run `bgw fetch https://www.wikipedia.org/ --fresh`.
   Expect: the gateway window does not come to the front and does not take focus. Result `outcome=ok`.
   Report: ok, or what moved.

8. **Other desktop.** Move the gateway window to another virtual desktop. Run `bgw fetch https://en.wikipedia.org/wiki/Write-ahead_logging --fresh` and time it.
   Expect: `outcome=ok`; the first line says `visibility=hidden`; the next lines include `window: hidden - lazy content may be missing; keep the gateway window on the current desktop`; it takes a few seconds, not tens of seconds (the page loads, one quiet check of about a second, no scroll, no dwell). The same for `bgw fetch https://example.com/ --fresh`: about 3 to 5 seconds after the page loaded at the most.
   Report: ok, the `visibility=` value and roughly how long each of the two took.

9. **Minimised.** Minimise the gateway window and repeat step 8 with another article. Then, with the window still minimised, run `bgw search "sqlite write-ahead logging"` three times, a few seconds apart.
   Expect: the same as step 8, including the `window: hidden` line. The window stays minimised. Each search prints a numbered list of results, not `results=0` with `(the page shows nothing)`.
   Report: ok, or what happened; for the searches the `results=` value of each.

10. **Lazy content while hidden.** With the window still on another desktop: `bgw fetch <a long page whose images or comments load as you scroll> --fresh --format text`.
    Expect: the `window: hidden` line says so; the page is not scrolled, so what only a scroll loads (the lower part of a lazy page) may be missing. That is the known cost of a hidden window; step 11 shows the way round it.
    Report: ok, or what was missing.

11. **Gateway window on the current desktop.** Move the gateway window back to the desktop you work on, covered by your other windows, and repeat step 8.
    Expect: `visibility=visible`, `outcome=ok`, and a fetch of a long page takes its usual 10 to 20 seconds, with the lazy content in it. Covered counts as visible; minimised or on another desktop does not.
    Report: the `visibility=` value and the time.

12. **Session restore.** Quit Waterfox with the gateway window open, start it again.
    Expect: at most one gateway window comes back; no leftover job tabs; `bgw fetch https://example.com/ --fresh` works.
    Report: ok, or how many gateway windows you see.

13. **Closing your last window.** Close every Waterfox window of your own, leaving only the gateway window.
    Expect: the gateway window closes too and Waterfox quits. Start it again with "Open previous windows and tabs" set: the gateway window may come back as the last window of the session, and your own windows are then under History, Recently Closed Windows (known, not yet seen in a real session).
    Report: ok, or "Waterfox stayed open"; what came back at the next start.

14. **History.** After a few fetches open Waterfox's history (Ctrl+H).
    Expect: the fetched addresses are listed there (known: the add-on does not request the `history` permission). "Recently closed tabs" does not list them.
    Report: what you see in both places.

## C. Downloads

15. **A download link.** `bgw fetch https://www.sqlite.org/2024/sqlite-autoconf-3460000.tar.gz` (or any direct link to a file).
    Expect: `outcome=unsupported`; no file appears in your download directory; no save dialog.
    Report: ok, or what appeared.

16. **With "always ask where to save".** In Waterfox settings turn on "Always ask you where to save files". Repeat step 15 with another file link.
    Expect: still `outcome=unsupported` and no dialog.
    Report: ok, or "a save dialog came up" (and whether it had the gateway window as its parent).

17. **Your own downloads.** While a slow fetch runs (`bgw fetch <a slow page> --fresh`), download a file yourself in your own window.
    Expect: your download finishes and stays; the fetch is not disturbed.
    Report: ok.

18. Turn "Always ask you where to save files" back to what it was.

## D. A page that needs you

19. **A human check.** With a VPN on (or any network a site distrusts), run `bgw fetch <a page of a site that shows you a human check> --fresh`.
    Expect: after up to 20 seconds the terminal shows `outcome=needs_human` with a job id, and the toolbar badge shows `1`; `bgw pending` lists the page. No notification yet. If the check is one that needs you, then 30 seconds after the page was parked a desktop notification "Browser Gateway: a page needs you" appears with a sound and an "Open" button, and the browser shows its own.
    Report: ok; how long after the `needs_human` answer the notification came; whether you heard the sound; the exact text of the notification.

19a. **A check that needs nobody.** Fetch a page whose check clears by itself after a while - a Cloudflare interstitial may, some 20 seconds in. Do nothing.
    Expect: `outcome=needs_human` on the terminal as before, the badge shows `1` for a moment - and no notification, no sound. A little later the badge is empty again and `bgw fetch` of the same address returns the page (`cache=hit`) with a line `challenge: cloudflare_challenge cleared_by_waiting, waited ... ms`.
    Report: ok, or "I was notified" with the time between the `needs_human` answer and the notification. If your checks need longer than half a minute to clear by themselves, set `"notify": {"challenge_delay_s": 60}` in `~/.config/browser-gateway/config.json`, restart the daemon and say so.

20. **Open from the notification.** Click "Open" on the desktop notification.
    Expect: a new Waterfox window comes to the front with the page that shows the check. No other window moves.
    Report: ok, or "nothing came up" / "it came up behind".

21. **Pass it.** Solve the check in that window. Touch nothing else, and count the seconds from the moment the real page shows.
    Expect: within about 3 seconds the window closes by itself - the page is not scrolled first - and the notification goes away. `bgw fetch` of the same address now returns the page (`cache=hit`) with `challenge: ... cleared_by_operator`.
    Report: ok and the seconds you counted, or what stayed open. Was the page muted while you had it?

21a. **Where the time went.** Right after step 21: `grep job.timings ~/.local/share/browser-gateway/daemon.log | tail -1` (with `bgw daemon`; with systemd: `journalctl --user -u browser-gateway -n 50 | grep job.timings`).
    Expect: one line of numbers for that job, in milliseconds: `grace_ms` (the grace period), `parked_ms` (parked in all), `handoff_ms` (from parking until you clicked Open), `cleared_settle_ms` (from "check gone" to "page settled"), `extract_ms`. `parked_ms` minus `handoff_ms` is the time you needed for the check plus what the gateway needed to notice; `cleared_settle_ms` plus `extract_ms` should be a few seconds at most.
    Report: copy the line. If something other than your own solving time is long, say which number.

22. **Do Not Disturb.** Turn on Do Not Disturb on your desktop. Repeat step 19 with another page that shows a check.
    Expect: the notification still comes through (it is marked critical) and the sound plays.
    Report: what got through: notification, sound, both, neither.

23. **The other ways to open it.** Right after the `needs_human` answer, before any notification: run `bgw pending`, then `bgw open <job>`. Next time, use the toolbar popup's "Open" button instead.
    Expect: each lists the page at once and brings it up in a window of its own. Having opened it within the first half minute, you get no notification for it at all.
    Report: ok for each, or which did not work; whether a notification came all the same.

24. **Nobody comes.** Cause one more check that does not clear by itself, and ignore it.
    Expect: the first notification after 30 seconds, then a repeat every two minutes; after 15 minutes the tab closes, the notification goes away, and a new fetch of that site says `site_cooldown` for a while.
    Report: ok, and whether the repeats were bearable.

25. **A page that pretends.** (Optional.) Fetch a page of your own that only imitates a "Just a moment..." page.
    Expect: it is treated like a real check (notification and sound). This is known.
    Report: nothing, unless it did something else.

26. Turn Do Not Disturb back off.

## D2. Feeds, slow pages, the container

26a. **A feed.** With the gateway window on the current desktop: `bgw fetch https://www.reddit.com/r/<a busy subreddit>/ --fresh --format text --max-chars 60000 | wc -c`, and look at the gateway window while it runs.
    Expect: the page is walked down for up to 20 seconds while more posts keep loading, then goes back to its top; the result holds many more posts than the first handful that a page shows before any scrolling. An ordinary article is walked as before, in a few seconds.
    Report: the character count, roughly how many posts, how long the fetch took; and the count for the same address with the window on another desktop (hidden: no walk, so the short version is expected there).

26b. **The page-load limit.** Put `"fetch": {"load_timeout_s": 60}` into `~/.config/browser-gateway/config.json` (create the file with `{ ... }` around it if there is none), restart the daemon, and run `bgw status --admin --json | grep -A1 '"fetch"'`.
    Expect: `"load_timeout_s": 60`. A page that needed more than 30 seconds over your slowest VPN exit now loads instead of ending as `timeout` / `navigation_timeout`. A value outside 5..120 stops the daemon at start with a sentence that names the key.
    Report: ok, the value you settled on, or the page that still times out.

26c. **Clear the gateway container.** Open the add-on's options, section "Gateway container". Press "Clear the gateway container...".
    Expect: nothing is cleared yet; a paragraph explains what will happen, with "Yes, clear it" and "Cancel". "Cancel" says "Nothing was cleared." Press the first button again and "Yes, clear it": "The gateway container was cleared ...". The containers menu still shows exactly one "Browser Gateway"; your other containers, your open tabs and your logins are as they were. A site that had stopped showing its consent page or its check to the gateway shows it again on the next `bgw fetch --fresh`. While a fetch is running, or while a page with a human check waits (badge shows a number), "Yes, clear it" answers with a sentence that says why not, and clears nothing.
    Report: ok for each; and anything of yours that was gone afterwards (there should be nothing).

26d. **Service workers do not stay.** `bgw fetch <a page of a site that installs a service worker - most installable web apps do> --fresh`, twice in a row, then once more after a minute.
    Expect: every time `outcome=ok`, never `code: unguarded_response`. (When a job ends the add-on asks the page's own service workers to unregister before it closes the tab. One that stayed would answer the next load of its site itself; the add-on ends such a load at once as `unguarded_response` instead of reading what the worker made.) If you do see `unguarded_response` for a site: fetch another page of that site, or use "Clear the gateway container" (26c), and say which site it was.
    Report: ok, or the site and the `code:` lines.

26e. **A tab you open in the gateway container by hand.** Open a new tab in the "Browser Gateway" container yourself (the containers menu) and type the address of a web page.
    Expect: nothing more loads in that tab. A blank tab is closed after about 1.5 seconds; one that already shows a web page (its first request got out before it was sealed) stays open, sealed: links and reloads do nothing.
    Report: which of the two happened.

26f. **An add-on that moves sites into containers.** (Only if you run Multi-Account Containers, Facebook Container or Temporary Containers; the project advises against combining them with the gateway, and none of them was tried by the author.) Make a rule that opens a site in a container of its own, then `bgw fetch` that site.
    Expect: `outcome=error` with `code: reassigned_by_addon` and no content, and the tab the add-on made is closed. Known gap: a tab that the add-on makes in another window (Multi-Account Containers names none, so the window in front gets it) is not seen; the job then ends as `tab_closed` or runs on, and the address loads in your container.
    Report: what the result said, in which window the add-on's tab appeared, and whether the page loaded in your container. Remove the rule afterwards.

## E. Blocks

27. **A refusal.** Fetch a page that answers 403 or 429 to you (old.reddit.com without login on a VPN is one).
    Expect: `outcome=blocked` with `code: http_403`, `http_429`, `reddit_block` or `login_wall`, and a `retry_after_s`. A second fetch of the same site right away says `site_cooldown` and no tab opens.
    Report: the first three lines of both results.

## F. Using your login on a site

Pick a site where you are logged in in Waterfox and that you do not mind an agent reading - a forum, old.reddit.com.

28. **The options page.** Open the add-on's options and read the section "Use my login on these sites".
    Expect: the warning is clear to you: what the agent can read, that loading a page can have side effects, that such pages are not stored.
    Report: ok, or which sentence is unclear.

29. **Rules that must be refused.** Try to add each of: `com`, `co.uk`, `uk.com`, `github.io`, `wordpress.com`, `*.reddit.com`, `192.168.1.1`, `mail.google.com`, `paypal.com`, `google.com` with the subdomains box ticked, `reddit.com` with the path `r/all` (no slash in front), `reddit.com` with the path `/r/..;/admin`.
    Expect: each is refused with a sentence that says why; the shared names (`co.uk`, `uk.com`, `github.io`, `wordpress.com`) are refused as names that many owners share. Nothing is added to the list. Also try `nu.nl` with the subdomains box ticked: it is refused because it has the form of a shared name (the reason is `suffix_like`), and accepted without subdomains; remove it again if you add it.
    Report: ok, or which one was accepted.

30. **Add a rule.** Add the host of your site (for Reddit: `old.reddit.com`) with a narrow path (for Reddit: `/r/` plus one subreddit), subdomains box not ticked.
    Expect: "Saved: https://...", the rule is listed, "1 rule is in force." `bgw status --admin` lists the host under "logged-in session allowed on".
    Report: ok.

31. **A fetch with your login.** `bgw fetch <an address inside the rule that looks different when logged in>`.
    Expect: the first line says `scope=default`; a line `login: this page was read with the operator's own login ...`; a line `stored: no ...`. The content shows that you were logged in (your user name, members-only content). While it ran, the toolbar badge showed `ID` and the popup said "using your login on <host>".
    Report: ok for each of the four things; copy the result's first six lines.

32. **Outside the rule.** Fetch an address of the same site that is outside the rule's path, and one on another subdomain of it.
    Expect: `scope=container` for both: the logged-out view.
    Report: ok, or the address that came back with `scope=default`.

33. **Isolated.** `bgw fetch <the address of step 31> --session isolated --fresh`.
    Expect: `scope=container`, the logged-out view.
    Report: ok.

34. **Not stored.** Take the page id from step 31 (`page=pg_...`) and run `bgw read <page id>`, then `bgw pages <a word that was on the page>`.
    Expect: `code=not_stored`; the word is not found.
    Report: ok.

35. **Your own tab stays yours.** Open the same site in a tab of your own, scroll somewhere, start typing a comment. Run two fetches with your login as in step 31 (the second waits 10 seconds by itself).
    Expect: your tab is not reloaded, not closed, your text is still there, you are still logged in.
    Report: ok, or what changed in your tab.

36. **The rate limit.** Run step 31's command five times in a row with different addresses inside the rule.
    Expect: each waits about 10 seconds for the one before; none fails.
    Report: ok, or the error.

37. **Leaving the rule.** Fetch an address inside the rule that redirects elsewhere - for Reddit, a `/r/<subreddit>/random` link, or any share link that leads off the site.
    Expect: `outcome=policy_blocked`, `code: redirect_out_of_scope`, and a `detail:` line naming only the site it wanted to go to. Or, if the redirect stays inside the rule, an ordinary result.
    Report: the first six lines.

38. **Logged out.** Log out of the site in Waterfox, then repeat step 31 with `--fresh`.
    Expect: `outcome=blocked`, `code: login_wall`, and the advice to log in in your browser - or simply the logged-out page, if the site shows one.
    Report: the first six lines. Log in again afterwards.

39. **The rules survive.** Quit Waterfox, start it again, open the options page.
    Expect: the rule is still listed and "in force".
    Report: ok. If it says the list "did not pass its check", say so - and whether Waterfox is set to clear site data when it closes. The rules are kept in two copies; when one is missing no rule is in force.

40. **Clearing data.** In Waterfox: History, "Clear Recent History", everything, all boxes ticked. Open the options page again.
    Expect: the rule is still in force - or the page says the list did not pass its check. If the copy that only the options page can write is still there, it shows the list for you to confirm and one click puts it back. If that copy is gone, no rule is in force: the page shows what it found in the other copy, offers only "Remove all rules", and you add the rules again.
    Report: which of the three happened.

41. **Pop-ups (only if you allow pop-ups for that site).** If the site is on your pop-up exceptions list, fetch a page of it that opens a window by itself.
    Expect: no new window stays open.
    Report: ok, or "a window stayed". Skip if you allow no pop-ups.

42. **Remove the rule** unless you want to keep it: options page, "Remove".
    Expect: "No rule is set." and `scope=container` for step 31's address.
    Report: ok.

## G. Search

Only DuckDuckGo was checked by hand by the author; the others were developed against made-up results pages. Expect surprises and write them down.

For each engine in turn - `duckduckgo`, `brave`, `bing`, `google`, `startpage`:

43. **A search.** `bgw search "sqlite wal mode" --engine <name>`.
    Expect: `outcome=ok kind=search engine=<name> results=10` (or close to ten), `scope=container`, and a numbered list: a title, the address of the page itself (not an address of the search engine), a snippet.
    Report, per engine: the `results=` number; the `detector=` value (`search-hint`, `search-generic` or `search-fallback`); whether result 1 to 3 are what the engine's own page shows as its first three results (open the same search in your own tab to compare); whether an advertisement, a "People also ask" entry or a "related searches" entry is in the list; whether any address still points at the search engine.

44. **A human check or a refusal on a search.** If step 43 answered `needs_human` or `blocked` for an engine: say which. For `needs_human`, open the page (`bgw pending`, `bgw open <job>`), pass the check, and search again.
    Expect: the second search goes through.
    Report: which engines asked for a check, on which network (VPN or not).

45. **A second page of results is not asked for.** Run two different searches on one engine right after each other.
    Expect: the second waits a few seconds (pacing) and works.
    Report: ok.

46. **Fallback.** Search for something with hardly any results (a long random string in quotes).
    Expect: `detector=search-fallback`, a `note:` line, and the page's text after the (few or no) results.
    Report: ok, or the first six lines.

47. **From an agent.** In a Claude Code session with the gateway registered over stdio (step 1b), ask it to use `browser_search` and then `browser_fetch` on the first result. While a long fetch runs, press Esc.
    Expect: both tools are listed (`browser_fetch`, `browser_search`, `page_read`, `page_search`, `gateway_status`) and work. After Esc the job tab in the gateway window closes within a few seconds: the interrupted call frees the browser.
    Report: ok, or what the agent said; whether the tab closed.

## G2. The page source

47a. **Raw HTML and export.** `bgw fetch <a page with an inline script and an HTML comment in its source - view-source: shows both> --format raw_html --fresh`, then `bgw export <page id> --format raw_html -o ~/bgw-source.html`, then open the file in an editor.
    Expect: the first command prints `format=raw_html` and `extraction: none - the page source as the browser held it`; the source is between the markers, a comment shows as `(comment removed)` there. The second needs `admin.token` (an agent's token is refused for a page) and prints `wrote N bytes ... to <file>` and nothing of the page. The file starts with `<!DOCTYPE html>`, holds the script and the comment as written, and `ls -l` shows `-rw-------`. Running the second command again refuses (`exists; use --force`). Reading the same page with your login (a rule from section F, `--format raw_html`) prints it once, `stored: no`, and `bgw export` of that page id says it is not stored.
    Report: ok, or what differs from view-source: (first lines) and the file's mode.

## G3. Files

Needs the add-on and the daemon of the same release (step 2). For every step: afterwards look at Waterfox's downloads panel (Ctrl+Shift+Y) and at your Downloads folder. Nothing may appear in either, at any moment, and no tab may be left in the gateway window besides the park tab. Take the links from pages you know; none is given here on purpose.

47b. **A PDF that Waterfox shows in its viewer.** `bgw fetch <a direct link to a PDF that opens in the built-in viewer when you click it>`. Watch the gateway window while it runs.
    Expect: `[browser-gateway] outcome=ok kind=file file=fl_... scope=container status=200`, a `file: type=application/pdf size=... sha256=...` line, `content: not shown - a binary file`, a `bytes:` line that names the export as `<file id>.pdf` in the gateway's export directory, a `file_warning:` line (untrusted content: never execute, import or follow it), and between the markers `requested_url`, `final_url`, `name` and `declared_type` (the lines before the markers hold only `requested_origin` and `final_origin`). In the gateway window a job tab opens and closes; it may show the frame of the PDF viewer for a moment, never a page of the document. Then `bgw export <file id> -o ~/bgw-test.pdf`: `wrote N bytes` and the same warning line, the file has mode 0600, and `sha256sum ~/bgw-test.pdf` begins with the 16 characters of the `sha256=` in the result. Compare with the same file fetched by `curl -L -o` if the site lets you: identical. Then `bgw export <file id>` without `-o`: it writes `~/.local/share/browser-gateway/exports/<file id>.pdf` (directory 0700, file 0600); once more names the same file and writes no copy, because the bytes are the same.
    Report: ok; what the job tab showed and for how long; whether the downloads panel or the Downloads folder showed anything at any moment.

47c. **JSON, XML, text, an image.** `bgw fetch` each of: a JSON address (an API that answers `application/json`), an XML file (`application/xml` or `text/xml`, not a feed), a `.txt` that is served with `X-Content-Type-Options: nosniff` (raw files of a code host usually are), a PNG or JPEG.
    Expect: all `kind=file`. For JSON, XML and text the content follows between the markers and long ones continue with `bgw read <file id> --offset N`; the image says `content: not shown - a binary file`. `bgw pages <a word from the JSON>` finds the JSON file; `bgw pages <part of the image's file name>` finds the image. The export of the plain XML file is `<file id>.xml`; an XML file that holds a `<script` or an XHTML or SVG namespace (if you have one) comes back as `type=text/plain` and exports as `<file id>.txt`.
    Report: ok for each, or the first eight lines of the one that differs. For each: did the JSON viewer, an image or anything else show in the job tab?

47d. **What Waterfox would download is retrieved too.** `bgw fetch` each of: a link that downloads when you click it in Waterfox (an "attachment" - a release archive of a code host, an "export" link), a direct `.zip`, a `.tar.gz`, a `.csv`, an RSS or Atom feed, a `.txt` from a server that does not send `nosniff`, a PDF that is offered as a download. Watch the gateway window, the downloads panel (Ctrl+Shift+Y) and your Downloads folder while each runs.
    Expect: all `outcome=ok kind=file`. The `file:` line names what the daemon found: `application/zip`, `application/gzip` (a `.tar.gz` is a gzip file; nothing unpacks it), `text/csv` (content between the markers), `application/xml` for a feed (content between the markers; `text/plain` and a `.txt` export if the feed carries XHTML content), `text/plain`, `application/pdf`. `declared_type` and `name` between the markers are what the server sent (`name` from its `Content-Disposition`). The `bytes:` line names the export `<file id>.zip`, `.gz`, `.csv`, `.xml`, `.txt`, `.pdf`. `bgw export <file id> -o ~/bgw-test.zip` and `sha256sum` against the same file fetched with `curl -L -o`: identical. In the gateway window a job tab opens, stays EMPTY (a blank text page; no viewer, no text, no "what should Firefox do with this file" dialog) and closes. Nothing appears in the downloads panel or the Downloads folder, at any moment, not even a `.part` file.
    How it works, so you know what to look for: Waterfox hands such a response to its download manager, where no add-on can read it. For that one response - the job tab's own, in the gateway container, of a type on `files.allow_types` - the add-on tells Waterfox other response headers than the server sent (no `Content-Disposition`, `Content-Type: text/json`, `nosniff`), so Waterfox gives it to the tab, where the add-on reads it and passes nothing on. The server sees an ordinary page load. Nothing of the request is changed, and no other tab's responses are touched.
    Report: ok for each, or: which one was saved or listed in the downloads panel (name and place of the file), which one opened a dialog or showed anything in the tab, which one came back with other bytes than `curl`. The measurements behind this were made in Firefox 156; this step checks your browser.

47d2. **Your own downloads still work, also while a job runs.** Start `bgw fetch <a large archive, 20 MB or more>` and, while it runs, click a download link in one of your own Waterfox windows.
    Expect: your download appears in the downloads panel and completes in your Downloads folder under its usual name; the job ends `kind=file`. `bgw status` shows no `download` or `download_ambiguous` error.
    Report: ok, or what happened to your download.

47d3. **What stays refused.** `bgw fetch` each of: a link to an installer or program (`.exe`, `.msi`, `.deb`, `.AppImage`), a video file, a web page that a server offers as a download (rare: an "export as HTML" link).
    Expect: `outcome=unsupported` with `code: file_type_not_allowed` (the type is not on your list; nothing was read) or `file_content_refused` (the type was allowed, the first bytes are an executable or installer; nothing was kept), and `code: attachment` for the page. A `.tar.gz` from a server that sends it with `Content-Encoding: gzip` on top of a gzip type comes back as `file_type_mismatch`. Nothing in the downloads panel or the Downloads folder.
    Report: ok, or which of them was kept or saved.

47d4. **The same address twice (the browser's own cache).** `bgw fetch <a JSON address of an API that sends an ETag, for example a repository address of a code host's API>`, wait a moment, then the same with `--fresh`. Then the same two steps with an ordinary article page.
    Expect: both times `outcome=ok` with `status=200` (a file both times `kind=file` with the same `sha256=`).
    Report: ok, or the first three lines of the second result.

47d5. **A download is asked for anew every time, and leaves no window.** `bgw fetch <an address whose server offers a file as a download: a "Download" link of a release page, an export link>`, wait a moment, then the same with `--fresh`. Watch the Waterfox windows while both run.
    Expect: both times `kind=file` with the same `sha256=` and the same `name:` line between the markers. No window or tab appears besides the job tab in the gateway window, nothing shows a PDF or another file, and the downloads panel and the Downloads folder stay as they were.
    Report: ok, or what appeared, and the `name:` lines of both results.

47e. **The size limit.** `bgw fetch <a PDF larger than 25 MB>` (or set `"files": {"max_mb": 1}` in `config.json`, restart the daemon, and fetch any PDF above 1 MB).
    Expect: `outcome=unsupported`, `code: too_large`, and either no `bytes_read:` line (the server announced the size: refused before a byte) or `bytes_read:` just above the limit. It ends within seconds, not after the whole file. `bgw status` counts no new file.
    Report: ok, the `bytes_read` line if there was one, and how long it took.

47f. **The window out of sight.** Move the gateway window to another virtual desktop and repeat step 47b with another PDF (`--fresh`).
    Expect: the same result in about the same time: reading a file needs nothing to be drawn.
    Report: ok and the seconds, or what differs.

47g. **From an agent.** In a Claude Code session (step 1b): ask it to fetch the PDF of step 47b with `browser_fetch` and then to save it with `file_export`.
    Expect: `browser_fetch` returns the file result; `file_export` returns `outcome=ok kind=file_export`, a `path:` line with `~/.local/share/browser-gateway/exports/<file id>.pdf` (or inside `BGW_DOWNLOAD_DIR` if you set that for the MCP server), a `file_warning:` line, and between the markers only `name:` - what the server called the file. The file is there, mode 0600, the directory 0700. Nothing was written into the directory Claude Code runs in. A second `file_export` of the same file names the same path and writes no copy. No tool result contained bytes of the PDF.
    Report: ok and the path, or what the agent was told.

47g2. **A name a server chose is never a file name.** Fetch a raw text file of a code host whose address ends in a name a tool would act on (a `conftest.py`, a `CLAUDE.md`, a `.desktop` file, an `.svg`), then `bgw export <file id>` and, from an agent, `file_export`.
    Expect: the result shows the name between the markers (`name: conftest.py`) and `type=text/plain` (`image/svg+xml` for an SVG); both exports are `<file id>.txt` in the export directory. No file of that name exists anywhere. A raw `.html` file of a code host (HTML served as `text/plain`) is refused: `outcome=unsupported`, `code: file_type_mismatch`.
    Report: ok, or the name and place of any file that was written under another name.

47g3. **The file store has a size.** `bgw status` after the steps above.
    Expect: the `store:` line ends with `N file(s) (X.Y of 2048 MiB)`. Fetch the PDF of step 47b once more with another query string appended (`?x=1`, `--fresh`): the file count goes up by one, the MiB do not (the same bytes are kept once). With `"files": {"max_mb": 1, "max_total_mb": 2}` in `config.json` (daemon restarted), fetching three different files of nearly 1 MB keeps the two newest: the oldest is gone (`bgw read <its id>` says it may have expired).
    Report: ok and the `store:` lines, or what differs.

47h. **Under a login rule.** With a rule from section F in place: `bgw fetch <a PDF or JSON address inside the rule>`, and `bgw fetch <a download link inside the rule>`.
    Expect: `outcome=policy_blocked`, `code: file_login_scope`, `scope=default`; with `--session isolated` the same address is retrieved (if the site serves it without the login).
    Report: ok, or what came back.

47i. **A file behind a human check.** (Only if you have a site at hand that shows a check before a file.) Fetch it, pass the check as in section D.
    Expect: `needs_human` first; after you passed the check the job ends by itself and the next `bgw fetch` of the address is `kind=file ... cache=hit`. The window you were given closes by itself, and nothing was saved.
    Report: ok, or what happened after you passed the check.

47j. **Other settings for PDF in Waterfox.** In Settings, General, Applications set "Portable Document Format (PDF)" to "Save File". `bgw fetch <a PDF> --fresh`. Then set it to "Always ask" and fetch once more. Set it back to "Open in Waterfox".
    Expect (not covered by the automated tests - a fresh test profile resets this setting): either the fetch still returns the file, or it ends as `outcome=unsupported` with `code: download` after the add-on removed the download again. A question on your screen is the bad case.
    Report: for each of the two settings what the fetch answered, whether a file appeared in the Downloads folder even for a moment, and whether a dialog came up. If one did: set `"files": {"enabled": false}` until this is fixed.

## H. After all of it

48. **Pause.** Press "Pause" in the toolbar popup, run a fetch, press "Resume".
    Expect: the fetch fails at once with `code: paused`; after "Resume" fetches work.
    Report: ok.

49. **Leftovers.** Look at your Waterfox windows, your download directory and your desktop's notification history.
    Expect: one gateway window with one park tab; no files you did not download; no notification left open.
    Report: ok, or what is left.

50. **Uninstall check (only if you want to stop here).** `sh tools/install.sh status` says what is set up. Then the one that fits: `sh tools/install.sh uninstall user`, `sh tools/install.sh uninstall on-demand`, or `sh tools/autostart.sh remove` and `bgw daemon stop`; and remove the add-on in `about:addons`.
    Expect: the "Browser Gateway" container and the gateway window are gone after a restart of Waterfox.
    Report: ok, or what stayed.
