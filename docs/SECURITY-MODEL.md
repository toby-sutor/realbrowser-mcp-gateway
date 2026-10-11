# Security model

This describes what RealBrowser MCP Gateway defends against, how, and what it
leaves exposed. It was written from the code as it is in version 0.1.9. Where a
statement rests on a measurement, the browser it was measured in is named.

Short version: the gateway gives an AI agent a narrow, read-only way to load web
content through your browser. It is built so that a hostile web page, a
prompt-injected agent or another program on the loopback interface cannot use
it to reach more than that. It is not built to stop programs that run as your
own user.

## 1. What is protected, and from whom

Assets:

- Your logins and cookies in the browser, and the pages behind them.
- Your files and local network (what a browser on your machine can reach).
- The gateway's tokens and pairing key.
- The agent's context and the files an agent writes or runs (an agent that
  obeys text from a web page is the main thing to defend).

Actors considered:

- A **web page** or server the agent asked for: it controls content, headers,
  redirects, scripts, service workers, file names and downloads.
- A **prompt-injected or careless agent**: it holds the agent token and can call
  the tools, but it should reach only what the tools offer.
- A **local process that is not you**: another user on the machine, a sandboxed
  app, or a process that grabs the port while the daemon is down. They share the
  loopback interface but cannot read your files.
- **Another browser add-on**: it can open a WebSocket to a loopback port and can
  send an `Origin` that passes the check.

Not defended (out of scope):

- **Any process that runs as your user.** It can read the tokens
  (`~/.config/browser-gateway`), the browser profile, the pairing key and the page
  store, and can talk to the browser directly. The gateway adds nothing such a
  process cannot already do, so the controls below do not try to stop it. An agent
  that has a shell on your account is such a process; the only limits on it are
  the ones you set on the agent.
- A compromised browser, operating system or Node.js.
- Vulnerabilities of the sites you read, or what a PDF, image or other file does
  to the program you open it with.
- Traffic analysis: sites see your IP address and your browser.

## 2. Controls as implemented

### Local interface

- The daemon binds 127.0.0.1 only. Every request must carry `Host:
  127.0.0.1:<port>`, and must not carry `Origin` or `Sec-Fetch-Site` (which a web
  page in a browser would add). A web page cannot call it: it adds those
  headers, or, under DNS rebinding, sends another `Host`, and is refused.
- Two bearer tokens, 256-bit, in files with mode 0600 in a 0700 directory:
  `client.token` for tools (fetch, read, search, status counts) and for the bytes
  of retrieved files (`/v1/files/export`), and `admin.token` for pairing, listing
  pending pages, bringing a page up, the raw debug route and the unrendered
  content of a stored page (`/v1/pages/export`). Roles are separate on every
  route: the agent token cannot pair an extension or read raw, undelimited page
  data. It can read the bytes of every stored file, as retrieved and without
  delimiters, with a plain request to `/v1/files/export`; `file_export` of
  `bgw mcp` needs that route (residual risk 16). No MCP tool returns those bytes.
  A token file that is a symbolic link, short, identical to the other, or not
  readable by its owner stops the daemon at start with an error; one that is
  merely too open is tightened to 0600. A `config.json` that is a link or not
  readable by its owner stops it too, and the owner and mode of the config
  directory are checked before anything in it is believed.
- Request bodies are capped (1 MiB) and auth is checked before the body is read. The status an agent can read is counts and booleans.
- At most 256 connections are open at once; more are turned away.
- There is no brute-force throttling on purpose: the secrets are 256-bit, and a
  lock-out would let any local process lock the real extension out. Handshakes
  have a 2-second timeout, at most 32 may be pending (the oldest is dropped when
  full), and nothing larger than 256 KiB is read before authentication.
- Log lines for refused requests are rate-limited so that noise cannot hide
  real warnings. Page content, cookies and headers never reach the logs or the
  audit log.

### Proving the daemon before sending a token

Anything can listen on a port while the daemon is down. The command line client
and `bgw mcp` therefore never send a token first. They POST a random nonce to
`/v1/prove` and expect `HMAC(token, "bgw1|prove|" + role + "|" + port + "|" + nonce)`.
Only a daemon that holds the token can answer, and the MAC covers the port, so a
second daemon with the same tokens on another port cannot be used to relay a
proof. If the proof fails, nothing is sent (`the process on 127.0.0.1:<port> is
not the gateway daemon - no token and no request was sent to it`). `bgw pair`
prints a code only if the daemon signed it for that port. Reads before the proof
are size- and time-bounded.

What this does not cover: an MCP client that talks HTTP to `/mcp` with a static
header cannot do the proof. That is why `bgw mcp` exists and is the documented
way to register the gateway. The optional systemd socket unit holds the port from
login on for the same reason.

### Starting the daemon on demand

Off unless you switch it on (`sh tools/install.sh on-demand`). With it, the
command line client and `bgw mcp` start the daemon themselves when a command
that needs it finds the connection refused. The order of the proof step does not
change: the daemon that was started is asked to prove itself like any other
listener, and the token is read and sent only after that. What is new, and what
it rests on:

- **The switch** is a file in the config directory (`on-demand`, in the 0700
  directory that holds the tokens) or `BGW_ON_DEMAND` in the client's
  environment. Both are in the hands of processes that run as you, and of no one
  else.
- **Only a refused connection starts anything.** Whatever does listen on the
  port is never replaced and nothing is started next to it: it gets the nonce,
  cannot answer unless it holds the token, and is sent nothing. A program that
  takes the port between the refused connection and the start is either found
  by the start, which then starts nothing and leaves it to the same proof, or
  it makes the new daemon end at once, which is reported as a failed start. So
  a program that sits on the port first can still keep the gateway from working
  (residual risk 13), and still learns nothing.
- **The first client to notice starts the daemon.** That can be a tool call of
  an agent through `bgw mcp`. Nothing of the call reaches the daemon's command
  line or environment: the program is `node daemon/src/main.js` of the checkout
  the client sits in, and the port and the two directories come from the
  client's own environment. An agent that holds the agent token can cause this
  one start and nothing else. `bgw status`, `bgw doctor`, the MCP handshake and
  the tool list start nothing.
- **What is started is the plain process of `bgw daemon start`**: no sandbox
  around it, nothing holds its port while it is down, and it is not stopped when
  idle. It inherits the environment of the client that started it, and hands it
  on to the programs it starts itself (the notification helper, your hook
  command). When that client is an agent's helper, whatever its environment
  holds - an API key, say - stays in the environment of a process that outlives
  it. Only you can read that, but know that it is there.
- **One start at a time.** Starts for one data directory wait for each other,
  so two clients that find the daemon down at the same moment start one daemon,
  and the second one finds it running.
- **No new way to a credential.** The file that reads tokens still starts no
  program: the start is done by the module that also serves `bgw daemon`, which
  has no code path to a token. No token is in the daemon's command line or
  environment; the daemon makes or reads its token files itself. The status
  requests with which `fetch`, `search` and `open` wait for the add-on after a
  start go out after the proof, on the same connection, like any other request.

### Installing for all users of a machine

`sudo sh tools/install.sh global` gives every user a daemon of their own, in
their own session, under the same sandbox as the units for one user. Tokens, the
pairing key and the store stay per user, in each home directory; no file with a
secret is shared.

- **The program is shared, and root-owned.** It is copied from the checkout to
  `/opt/browser-gateway` (or another prefix). Only plain files and directories
  are copied: a symbolic link among them or on the way to them (`cli`, `daemon`,
  `node_modules`, `node_modules/ws`, `tools`, `dist`) stops the install, and so
  does a file with more than one hard link, so that nothing from outside the
  checkout can end up readable for everybody. The copy belongs to root and is not
  writable for group or others. Every directory above the prefix, up to `/`, must
  belong to root and not be writable for group or others, and so must the
  directory of `/usr/local/bin/bgw` (or the link is left out with `--no-link`).
  A node named with `--node` must be root-owned, not writable for others, and
  outside every home directory; without it the service finds `node` on each
  user's `PATH`. Whoever controls the checkout at the moment of the install
  decides what every user of the machine runs, and the install script itself
  runs as root from that checkout: install from a source you trust, as with any
  program installed for all users.
- **Root runs nothing else from the checkout**: no `npm`, no `node` on its
  files. The dependency has to be installed by the user beforehand.
- **One port for everybody.** Users share the loopback interface, so they share
  port 8791 (section 1 counts another user as "a local process that is not
  you"). The first user logged in holds it. A second user's clients then reach
  the first user's daemon, which cannot prove that it holds their token: nothing
  is sent, and their gateway does not work until the port is free or they move
  to another one. Their add-on fails its handshake with that daemon for the
  same reason: the daemon does not hold their key. The second user's socket unit
  stays failed after the first user has logged out: the second user must run
  `systemctl --user restart browser-gateway.socket` or log in again.
- **The unit that makes the two directories** runs `mkdir` outside the sandbox,
  in the user's own session, because the sandboxed service cannot make them:
  they are mounted into it before it runs.

What was checked: the install script is tested in scratch directories with a
stand-in for `systemctl`. That shows which files are written with which
permissions and what `systemctl` is asked. The `user` mode was used on one
desktop. No systemd has loaded the units as this version installs them (with the
directories unit and the port setting), `global` was never run as root, and no two
users were logged in. The ownership
checks are not exercised by the tests: with a stand-in root only the permission
bits can be tested.

### Pairing and the extension link

- The extension dials out to `ws://127.0.0.1:<port>/ext`. Pairing uses a one-time
  code (10 minutes, works once) printed by `bgw pair` and pasted into the options
  page. It is a mutual HMAC handshake in which the daemon proves knowledge of the
  key first; the extension answers only a daemon that proved. A long-lived key is
  derived from the pairing code (HKDF) and stored by the extension. The key is
  kept in the storage of the extension's own pages, which content scripts cannot
  reach, not in `storage.local`, which any script of the extension can read and
  write, content scripts in untrusted pages among them. Once that store holds a
  value, nothing in `storage.local` is taken for a key, whoever put it there. If
  that store cannot be written, the key stays in `storage.local` and is moved at a
  later start. The MACs bind the direction, mode, port, the protocol versions of
  both sides, daemon instance and nonces. The port is in no frame: the daemon uses
  the port it listens on, the extension the port it dialled, so a process on the
  port the extension dials cannot pass the handshake on to a daemon on another
  port. Frames after `ready` carry no MAC; they are taken only on the connection
  whose proof was verified.
- Only one authenticated extension is accepted at a time. The pairing code is
  minted with the admin token, not the agent token.
- Reconnect rules: a close code from the daemon counts only if the daemon's MAC
  was verified on that very connection. A peer that proved nothing - a wrong
  proof, a close code without a proof, silence until the handshake timeout, or
  anything that is no challenge - makes the extension retry with a long backoff (5
  to 60 s) and cannot delete the stored key or force "pair again". A frame that is
  no text, or longer than a challenge can be (4096 characters before the proof,
  64 KiB after), ends the connection when it arrives. What such a peer still gets
  is the hello: add-on version, browser name and version.
  A daemon of another protocol version (5 or later) proves itself in its
  challenge; the extension checks the proof first and then shows "version
  mismatch" without sending anything made from its key. A version number changed
  on the way makes the proof wrong.
- Another add-on or a local process can open the socket with a plausible
  `Origin`; without the key it never gets past the handshake. It can fill pending
  handshake slots; the oldest is evicted so the real extension can still connect.
  It cannot learn whether an extension is paired or whether a pairing code is
  pending: a daemon without a key answers like one with another key.

### URL policy

Applied in the daemon before a job is queued, and again in the extension on every
redirect hop: `http` and `https` only, no userinfo, no private, loopback,
link-local or multicast addresses (including odd spellings, IPv6 mapped forms and
the 198.18.0.0/15 range), no local names or single-label hosts, no `.onion`, and
a short built-in blocklist (webmail, account and identity pages, payment, password
managers). The text policy cannot know where a name resolves, so the extension
guard resolves names (`dns` permission) and checks the server address of every
response as well. For a request that the browser sends to a proxy (HTTP, HTTPS or
SOCKS) neither is done: the guard's own lookup would send every host name of a
job to the local resolver, past the proxy, and the address that answers is the
proxy's. The text rules stay. A public name that leads to a private address at
the proxy's end is then the proxy's to refuse. The add-on's log says so once per
browser session (`guard.proxied`). The first job of a session may still resolve
its own host name once, before the guard has seen a request. A `300 Multiple
Choices` is not a redirect to Firefox even with a `Location` header (measured in
Firefox 156): its response is judged like any other. The address of a job, in the
frame that carries it, must be visible ASCII, and the links of a page that come
back must be web addresses.

### Request guard in the browser

The extension registers blocking `webRequest` listeners for the gateway's own job
tabs, for tab-less requests and for any other tab that appears in the gateway
container. It can only cancel a request. It never changes a URL or a request
header. Cancelled: requests to private addresses by literal, by DNS answer (asked
before every request) or by server address; top-frame hops that fail the URL
policy; everything in the container while no job runs; authentication dialogs.
Tabs and windows a job page opens are sealed (they load nothing) and closed when
the job ends. A tab that anyone else creates in the gateway window while a job
tab is open is sealed and closed as well, and the job ends as
`reassigned_by_addon` (residual risk 18 says what this does not cover). Your
ordinary tabs do not pass through any of these listeners, except in the cases
named under "Residual risks" and for the first moments after the add-on starts
(next section).

If the browser turns out not to select requests by tab - the listener for
tab-less requests heard nothing by the time the link to the daemon came up, or a
job's page loaded without the guard hearing its top frame (that job ends as
`guard_blind`) - the guard registers one set of blocking listeners for every
request of the browser instead, your own tabs included. It decides by tab and
cookie store, answers "no objection" for yours, and stays that way until the
browser or the add-on is restarted (log line `guard.widened`). This did not
happen in Firefox 156.

A listener that fails cancels the request if it belongs to a job tab or the
gateway container and ends that job as `internal_error`; any other request
passes.

### The first moments after the add-on starts

The request guard is in place only when the add-on has read its settings, the
browser has said which container is the gateway's and the tabs open in it are
sealed. Until then one blocking listener stands in for it, registered by the
first script of the background page. A request outside every container passes
unread. A request in a container is held until the browser has said which
container is the gateway's, then cancelled in that one and passed in any other;
nothing is cancelled on the container id in the settings alone. If the answer
takes more than a second, all containers but the one the settings name are let
go. The listener is removed when the guard is in place and the browser has handed
over every request it still owed (log line `startgate.gone`, times and counts
only). While it stands - 0.2 to 0.6 s in the tests, once per start of the add-on
- every request of the browser waits for its answer; a container tab of yours
waited 0.3 to 0.85 s at most on a busy machine. What this does not cover is the
time before the background page runs (residual risk 20).

### Container isolation

Jobs run in a cookie container of their own ("Browser Gateway"), chosen when the
tab is created. If the container is missing the job fails closed; a job never
falls back to your default cookie store. A tab you open in that container by hand
is sealed at once: nothing more loads in it. It is then closed - immediately if it
shows a browser page or a file, after about 1.5 seconds if it is blank - unless it
already shows a web page (one that was open before the add-on started, or whose
first request got out, see residual risk 6): such a tab is left open, sealed. A
job tab the browser does not close (a leave-page prompt answered with "stay")
stays sealed under its guard until it is gone; closing is tried again after 3 and
30 seconds. Leftover container-only windows are closed when a job ends. Service
workers of the visited site are asked to unregister when a job ends, and a
main-frame document that was not answered by a response the guard saw (for
example answered by a worker) ends the job as `unguarded_response` before
anything is read. "Clear the gateway container..."
in the options page removes the container and creates an empty one.

### Downloads safety net

The browser must never save a file because a page said so. The first line of
defence is the response gate (below). Behind it, the `downloads` permission lets
the add-on cancel any download created in the gateway container, delete the
file and erase the entry. Downloads are attributed by cookie store, and during a
job also by the origin of a blob the job tab loaded and by a time window for
`data:` downloads. If a download might be yours (an ordinary tab of yours shows
that origin), nothing is touched and the job fails as `download_ambiguous`. The
first caught download ends the job and closes its tab.

### File capture, and the one place response headers are relabelled

A job tab's top-level response is read by a `filterResponseData` response filter
when it is a type the browser would show in a tab (PDF, JSON, XML, SVG, Markdown,
plain text, PNG, JPEG, GIF, WebP). The filter takes every byte and passes none on.
The daemon sniffs the first bytes again, reads all of a file that begins like XML,
and is the one that decides.

A response the browser would hand to its download manager (attachment, zip, gzip,
tar, octet-stream, CSV, feeds, no type) cannot be filtered. For those, and only
for those, the extension answers the browser with other RESPONSE headers: no
`Content-Disposition`, `Content-Type: text/json`, `X-Content-Type-Options:
nosniff`, and `Cache-Control: no-store` with the validators removed. These are the
only headers the gateway changes, and it is done by one function (`relabelForCapture`)
and one return statement in `extension/background/guard.js`. It happens only when
all of these hold:

- the response is the top-level response of a job tab, at the end of its
  redirects, status 200;
- the tab and the request are in the gateway container (never under a login rule,
  never for a search);
- files are enabled for the job;
- the type the server declared is on `files.allow_types`, it is not HTML, and it is
  not a gzip type (`application/gzip`, `application/x-gzip`,
  `application/x-gunzip`) sent with `Content-Encoding: gzip` or `x-gzip`; such a
  response is refused at the headers as `file_type_mismatch`.

The server sees an ordinary navigation: no request header is changed, and no
extension page fetches anything. `Content-Disposition` and `Content-Type` are read
the way Firefox reads them (measured in Firefox 156, with the measured tables in the code and
a table test of header combinations), so a value the browser treats as a download is not
mistaken for a page. The browser's cache keeps nothing of a relabelled response.
Checked in Firefox 156 and by hand in Waterfox.

After capture the daemon refuses executables, installers, scripts with a shebang
and shortcuts by their first bytes (a Windows program whose first header reads
like text is found by looking where that header points), and under any declared
type a file that begins as an HTML document or with a script tag (after a byte
order mark, white space, comments and processing instructions, within the first
4096 bytes). HTML that does not begin the file is not recognised: such a file is
kept as text and exported as `.txt`. Before a file is stored as XML the daemon
reads all of it (up to 8 MiB) and stores it as plain text unless it is free of the
XHTML, SVG and MathML namespaces (also spelled with character references), of
`<script`, `<html`, `<body`, `<iframe` and `<svg`, of entity and attribute-list
declarations, of stylesheet instructions and of control characters. Files stored
before this check are not checked again. It also checks size, SHA-256 and the
number of pieces, and never unpacks or parses a file. Exports are named by the
gateway (`<file id><ending>`, the ending from the type the file was stored under:
`.xml` only for XML that passed that check, `.csv` for CSV, `.txt` for all other
text) and go to a folder outside any agent's working directory by default,
because an agent's tools pick files up from there (a test runner, nested
instruction files). `file_export` follows no symbolic link and takes no path or
name from the caller. The store has a total size cap and keeps identical content
once.

### Hidden-text pruning

The extractor removes text a user cannot see before an agent reads it: `display`,
`visibility`, unreadably small or blurred text, zero or near-zero opacity,
transparent text or text that cannot be told from its background, boxes moved out
of the viewport, folded to nothing, clipped, masked or rotated away, and
invisible JSON-LD text, on a clone of the page. It is risk reduction and not a
boundary. In the project's probe set it removed 49 of 51 variants; text under an
opaque overlay and text behind a picture mask are not detected, and text at
opacity 0 that is part of a transition is kept because it is how reveal-on-scroll
works, which a page could use to hide text. A box folded to nothing or kept beside
the page is kept as well when something speaks for its opening: a transition on
its size or place, a role such as a menu or dialog, or a control of the page that
points at it (accordions, off-canvas menus). In a gateway window that is
minimised or on another desktop a tab can be read before the browser gave it a
size. A box of no width or height is not taken for hidden then, since every box
that takes its size from the window has none: in the probe set 45 of 51 variants
are removed in that state.

Defuddle's site extractors run only on the hosts they are written for; elsewhere
scripts other than JSON-LD and formula sources are emptied, templates removed and
shadow trees read as rendered. The content of `noscript` elements is dropped, and
every inline SVG is replaced by the text that is drawn.

### Untrusted-content delimiters: the actual boundary for agents

Every page-derived byte reaches the agent between
`<<<BEGIN_UNTRUSTED_WEB_CONTENT nonce>>>` and `<<<END_UNTRUSTED_WEB_CONTENT nonce>>>`
with a fresh random nonce per result. Before that, the text is sanitised:
invisible and format characters and variation selectors are removed, look-alikes
of the marker words (other scripts, full-width forms, escapes) are folded and
defanged, closed HTML comments are replaced by `(comment removed)` so that a
reader cannot skip text hidden in a comment, and the length is paged. A delimiter
with a word more or less (for example `END_OF_UNTRUSTED_WEB_CONTENT`) is replaced
when it stands at the start of a line or behind a bracket and has "begin" or
"end", "untrusted" and "content" in this order with at most ten characters
between one word and the next. That rule is narrower than the problem and has
known false positives (see residual risk 19). The header lines before the block
hold only values made by the daemon and the origins (scheme, host, port) of the
requested and of the final URL; everything a page chose (both URLs in full,
evidence, error detail, file names) is inside the block. The requested URL counts
as page-chosen because a page or a search result may have offered the link. The
`query:` lines of a search (the caller's own text, sanitised and capped) stand in
the header. Tool descriptions and the results say that the content is data and
must not be followed.

The look-alike check is bounded in time and memory. It folds a text in slices of
8192 characters, with the end of each slice's key carried into the next. Lines
made of the few signs that grow more than fourfold when folded are counted; a line
of which more than an eighth is such signs is heavy, a text may hold 4096 such
signs in its heavy lines, and any heavy line beyond that is replaced with `(marker
removed)` without being read. For a text of 8 MiB made of one sign that grows
eighteenfold this took 2.8 to 3.7 seconds per call and a peak of about 2 GB
before; it takes 44 to 50 ms and a peak of about 107 MB now. A test holds the
costliest texts to 2.5 seconds and 512 MB.

None of this stops a model from obeying injected text. The agent and its
permissions are the real boundary: give an agent that reads the web no
permissions you would not give to the web.

### The store and the no-store rule

Pages are stored under the data directory as files with a SQLite (FTS5) index: no
file name comes from page content, files are opened with no-follow, SQL is
parameterised, and old pages are purged (`retention_days`) and the pages together
are capped (`pages.max_total_mb`, oldest first); page and file directories the
index does not know are purged by the time in their id, and an index that is lost
is rebuilt at start. A page read with your
login (inside an opt-in rule) is shown once and not stored: only its id, host,
time and content hash are kept, no title, author, address path or query. The audit
log records what was asked and how it ended, never content; for logged-in loads
only the host. For a request the policy refused it records the origin only, or
nothing when it was no address. Entries are purged after `retention_days`; the
file is rotated at 32 MiB (one older generation is kept). A write that fails stops
new work only until the log can be written again, without a restart. Raw source of
a logged-in page is returned only when asked for, once.

Which cookie store a job ran with is the add-on's word, and the daemon holds it to
its first word: a job the add-on took with your login (`job.accepted`) is handled
as a login page whatever its result says, and the disagreement is logged. The
address a page ended at is run through the daemon's own URL policy (scheme, host
classification, blocklist; text only, no DNS) before the result is rendered or
stored; a result from anywhere else ends the job as `policy_blocked` with nothing
of the page.

### Login opt-in

Rules are set only in the options page. They are kept in `storage.local` and in
the storage of the extension's own pages; they count only while both copies agree,
so a script that could write one ends with no rule in force. When they disagree,
the options page offers to put back only the list from the extension's own copy; a
list found in `storage.local` alone is shown, can only be removed, and is never
written back.

Constraints: HTTPS on the default port, one site, never a blocklisted host
(subdomains cannot reach one either), at most 50 rules. One site means no
wildcard, no IP address and no shared name: the names in
`extension/shared/suffixes.js`, and for a rule with subdomains also any host that
has the form of a registry or hosting name the table does not hold. That is a
host below a cloud provider's zone (`amazonaws.com`, `windows.net`), a name of
two labels under a country code when its first label is shorter than three
characters (`nu.nl`, `ok.ru`) or when the code is one whose registry is not known
to hand out names directly below it (`example.br`), and a country code as the
name under `com`, `net` or `org` (`ba.com`). Such a host can still be added without
subdomains. The table is an approximation of the public suffix list, and unlisted
names that look like ordinary sites pass.

The path check refuses encoded separators and dots, and dot segments followed by
a path parameter (`/..;/`), in a rule's prefix and in every address matched
against it. Doubly encoded dots (`%252e`) are refused too. A tab under a rule must
stay inside it: requests that would take the top frame out are cancelled before
they are sent; address changes that send no request (`pushState`, fragment
changes, `blob:`/`data:` documents) are noticed afterwards and end the job with no
content. Pop-up loads and sub-requests to private addresses are cancelled.
Limits: no scrolling, one page per rule every 10 seconds and 30 an hour, a toolbar
badge while it runs, no files, no search.

### Resource limits and pacing

One job at a time; a job waits at most 2 minutes in the queue and runs at most 4;
the number of queued callers is capped. At most 256 connections are open at once.
An exception nothing catches ends the daemon with one log line (kind, class, code
and place of the error, never its message) and exit code 1, so the service manager
restarts it.

Per-site pacing and an hourly budget slow down repeated loads. A site is the last two labels of the host, or one
label more under a name that many owners share (`co.uk`, `github.io`:
`extension/shared/suffixes.js`); below a cloud provider's zone (`amazonaws.com`,
`windows.net`) every host is its own site; an IPv6 address counts by its /64. Under
a shared name the table does not hold, all hosts are one site and share gap,
budget and cooldown. Hosts under a listed hosting name are cheap to make, so the
per-site limits do not bound a party that keeps making new ones there. A site that
refused a job gets a cooldown (for the default profile one minute at first,
doubling up to half an hour), at least as long as its `Retry-After`, which is kept
up to one hour; jobs already queued for it, or for a site whose challenge waits for
you, are ended and not sent. A redirect is charged to the site it leads to after
the fact: gap and budget for every site passed, cooldown for the site asked and
the site that refused. These protect sites and your IP address as much as the
machine.

### Notifications

The challenge notification text is fixed wording plus a host that has passed a
host-name pattern, or is an IPv6 address in brackets that parses as one (long
names are shown by their right end). Live helper processes, per-site notifications
and total posts per minute are capped. An optional hook command is run as an argv
array without a shell, with only the host and a job id. The sound player and the
hook are ended at a limit (15 and 10 seconds) and killed 2 seconds later. The hook
runs with the first notification that is posted for a page.

### Add-on permissions

| Permission | Why |
|---|---|
| `tabs`, `webNavigation` | open, track and close job tabs, see top-frame navigation |
| `webRequest`, `webRequestBlocking`, `<all_urls>` | the request guard and the response gate and file capture |
| `contextualIdentities`, `cookies` | the gateway container (Firefox needs `cookies` for `cookieStoreId` and containers) |
| `storage` | settings, and one of the two copies of the login rules (the pairing key is not kept there) |
| `notifications` | the add-on's own notice when a page needs you |
| `dns` | resolve names to refuse private addresses |
| `sessions` | tag the gateway's own windows and tabs (found again after a browser restart) and keep closed job tabs out of the recently-closed list |
| `downloads` | the downloads safety net |

The extension page CSP is `default-src 'none'; connect-src 'self'
ws://127.0.0.1:*`: extension pages cannot talk to the web. There is no
`externally_connectable` and no `web_accessible_resources`. The manifest declares
no data collection. The add-on does not request the `history` or `browsingData`
permissions. It does not run in private windows (`incognito` is `not_allowed`),
and the manifest asks for Firefox 140 or later.

## 3. What the reviews found

The code went through four security reviews (daemon, extension, file retrieval and
the header exception). They were done by AI review agents reading the source and
running scripted attacks against test builds (a fake extension, headless Firefox
156). They are not a third-party audit, and the real Waterfox profile was not part
of them.

Found sound: the HTTP gate against about 60 raw-socket cases, token files and
atomic writes, the handshake MACs (no reflection or replay; relay across ports
and rewritten protocol versions are covered since protocol 5), the URL policy against
over 100 spellings, the store paths, the renderer against hostile shapes, the
extractor's isolation (it parses a clone, its fetch is stubbed), container
isolation for pop-ups, the guard against private targets on every hop, and the
`bgw mcp` token flow against 13 hostile listener behaviours.

Found and fixed before release: a port squatter could collect tokens and take over
pairing (now proof first); page-chosen text sat in the trusted header zone;
`/v1/jobs` returned raw content to the agent token; a lock-out lever in
authentication throttling; a literal `<!--` hid page text; a blob-download burst
could leave files in your downloads folder; many hidden-text variants passed;
exported files were named by the server and written into the agent's working
directory; the file store had no total size limit; "clear container" did not cover
a job that had just cleared a check; a service worker could answer a load itself;
`Content-Disposition` and comma-list `Content-Type` were not read the way the
browser reads them; the browser's cache kept a relabelled response.

A further review before the release found the items of this round, and they
were fixed: the handshake proofs did not name the port
or the protocol versions, so a relay between ports was not ruled out and a
version mismatch could be made up or hidden; an unpaired daemon told a local
program that no extension was paired; a name was resolved once per job, so a
changed record could lead requests to a private address; a failing listener of
the request guard let the request through; a tab that another add-on opened in the
gateway window, and a job tab the browser did not close, were not guarded; a gzip
file sent with `Content-Encoding: gzip` was read under other headers; the address
that a page or a search result had offered stood among the daemon's own header
lines; the unrendered content of a page could be exported with the agent token; a
very long text could cost seconds and gigabytes in the sanitiser; XML with script
in it could be stored and exported as XML; and many more ways of hiding text
passed, among them text in `noscript` elements, templates, shadow trees and SVG,
and site extractors that ran on every host. What is left of these is listed
below (residual risks 2, 3, 16, 17, 18 and 19).

A second round of fixes followed the last review. It covered the store and the
audit log, the queue and the notifier, the start of the add-on and the storage of
the pairing key, the login rules and the site rule, the command line client, and
the install and deploy tools. The controls in section 2 are described as they are
after it, and residual risks 20 to 25 were added with it.

## 4. Residual risks

These are known and not fixed. Numbers are what was measured.

1. **Same-user processes** can read everything (section 1).
2. **Names that resolve to private addresses** pass the text URL policy by design.
   The extension guard asks the browser's resolver before every request it lets
   through and refuses a name with any private address; no answer is kept, only
   requests for one name at the same moment share a lookup. For a request that goes
   through a proxy set in the browser there is no lookup of its own (see URL
   policy). The browser resolves again when it connects, and the two
   answers are not tied to each other: a name server that changes its answer in
   the milliseconds between them can still get one request sent to a private
   address. Its response is cancelled at the headers, so this is at most a blind
   request. Whether both lookups use the same cache entry was not measured.
3. **Prompt injection** is only reduced. Hidden-text pruning misses text under an
   opaque overlay, text over or behind a picture, and formula sources; raw HTML,
   files and the full-page view carry more of the page
   (hidden elements, attribute text, script strings) into the agent's context than
   the article view.
4. **Logged-in jobs.** Shared and service workers of an opted-in site have no tab
   behind them in your own cookie store and are not guarded (a probe reached a
   loopback port). A `data:` download or `<a download>` to an in-rule address can
   leave a file in your downloads folder (never deleted, the job fails). A path
   prefix limits addresses, not content. Cookies the page sets land in your own
   store. While a logged-in job tab is open, one blocking listener hears the
   top-frame requests of all your tabs (it lets yours pass).
5. **Your own tab-less requests** (your sites' service and shared workers, other
   extensions) reach the guard's tab-less listener; it decides by cookie store and
   answers "no objection" for yours. A request filter cannot select a cookie store.
6. **A tab created in the gateway container outside a job** gets its first
   request out before it is sealed. It is then closed, or, if it already shows a
   web page, left open and sealed.
7. **Download attribution** is a heuristic: a `data:` download of yours inside the
   5-second window after a caught job download can be removed; a blob download of
   yours whose tab closed before the download surfaced can be taken for the job's.
8. **Header exception.** Another add-on that adds `Content-Disposition` back after
   the gateway's listener turns a captured file into a download (the downloads
   safety net removes it). The behaviour for duplicate headers was measured in
   Firefox 156 only. A job page that clicks its own download link relies on the
   downloads safety net alone.
9. **Service workers** are removed only for origins with a scriptable document at
   job end; otherwise the commit check (`unguarded_response`) is what holds. The
   `browsingData` permission would be the complete answer and is not requested.
10. **History.** Job addresses stay in the browser's history; the `history`
    permission is not requested.
11. **Notifications can be provoked.** A page that imitates a human check can cause
    a notification and sound, bounded by three parked pages, one per site, and the
    cooldown. The detection markers were tested on fixtures and a few sites.
12. **No sandbox around a daemon started with `bgw daemon start`**, by the
    autostart entry or on demand, and nothing holds the port while it is down
    (clients do not trust the port, but a static-header HTTP client would). A
    daemon that was started on demand also carries the environment of the client
    that started it and is not stopped when idle. The optional systemd unit
    limits file and network reach, but is not a boundary against code execution
    in the daemon, because the notification helper needs the session bus.
13. **Local denial of service.** A local process can fill pending handshake slots
    (the oldest is dropped), open connections up to the cap of 256, keep the one job
    slot busy through the agent token,
    or hold the port while the daemon is down - also where the daemon is started
    on demand, since nothing is started while the port is taken. With the units
    installed for all users, the user who logged in first holds the one port and
    the others have no working gateway meanwhile; after the first user logs out, a
    second user's socket unit stays failed until they restart it or log in again.
14. **Fake-IP DNS.** A VPN or other resolver that answers with addresses in
    198.18.0.0/15 has every lookup refused. With a proxy set in the browser the
    guard makes no lookup (see URL policy).
15. **An exported file is untrusted.** The gateway keeps scripts, executables and
    web pages out of the file path, and names files itself, but cannot say what a
    PDF, an image, a spreadsheet formula in a CSV or an XML file does in the
    program that opens it.
16. **The agent token reads file bytes.** Whoever holds `client.token` can fetch the
    bytes of any stored file from `/v1/files/export`, unsanitised. They stay out of
    a model's context only because no tool returns them.
17. **A relay with the same port number on both ends.** The port is in the
    handshake proofs but in no frame. A pipe that leads from the port the
    extension dials to the same port number elsewhere (another network namespace,
    or another host, that holds a copy of the key) is not stopped by it, and can
    inject frames after `ready`, which carry no MAC. That is outside the
    single-machine loopback model; closing it would take a session layer on every
    frame.
18. **Add-ons that move sites into containers** (Multi-Account Containers "always
    open in", Facebook Container, Temporary Containers) cancel a navigation and
    open its address in a tab of their own container, with your session there.
    While a job tab is open the gateway seals and closes any tab created in the
    gateway window that it did not make, and the job ends as
    `reassigned_by_addon`. Tested with a stand-in tab, not with those add-ons (45
    of 45 times no request of the tab reached the server). Not covered: a tab such
    an add-on creates in another window. Multi-Account Containers names no window,
    so its tab lands in the window that is in front, which is the gateway window
    only while that one is in front; then the address loads in your container and
    the job fails as `tab_closed` or runs on. A tab you open yourself in the
    gateway window while a job tab is open is closed too.
19. **Look-alikes of the markers that the sanitiser does not know.** The real
    markers carry a random nonce that a page cannot know, so such text cannot end
    the block, but a model may take it for a marker. Not recognised: some
    look-alike alphabets (Lisu, Cherokee, small capitals), digits for letters, a
    marker split over two lines, words in reversed order, and a near-delimiter in
    the middle of a line that does not follow a bracket. The near-delimiter rule
    also replaces some ordinary text.
20. **The start of the browser.** A job tab, or a tab with a human check that
    waited for you, that was open when the browser quit or crashed is brought back
    by session restore in the gateway container. From the moment the add-on's
    background page loads, its requests are cancelled and the tab is closed. Before
    that moment nothing stops them: Firefox starts background pages after it has
    restored its windows (read in the Firefox 156 source; in the tests, with the
    add-on loaded after the start, such a tab made requests for 0.4 to 2 s).
    Firefox would hold requests for the add-on from the very start only if a
    listener for all requests stayed registered for good, which would put every
    request of yours through a listener of the add-on. That is not done.
21. **What the request guard never sees.** `webRequest` reports HTTP(S) and
    WebSocket requests. Three things a page can start are not reported, and the
    gateway injects nothing into pages to take them away. (1) WebRTC: a job page
    can create an `RTCPeerConnection` with STUN or TURN servers of its choosing,
    private addresses included. The browser then sends STUN or TURN packets (UDP,
    or TCP for TURN) to that address and port. The page cannot choose the bytes
    beyond the TURN user name and cannot read an answer, but it learns whether
    something answered and how fast, from the candidates and `icecandidateerror`
    events - enough to probe hosts and ports of your network. It can also learn the
    public address the browser has outside a proxy. It cannot read an HTTP service
    on a private address this way, and data channels reach only a peer that speaks
    ICE and DTLS. Your local addresses are hidden behind mDNS names by default.
    (2) WebTransport: `new WebTransport("https://host:port/")` opens a QUIC
    connection (UDP). The page controls host and port, not the packets; it learns
    whether a handshake succeeded. It can exchange data only with a server that
    speaks HTTP/3 WebTransport with a certificate the browser accepts (or whose
    hash the page names). (3) External-protocol links (`mailto:`, `tel:`,
    `magnet:`, application schemes): a page can navigate to one. If your profile
    opens that scheme without asking, the application starts with an address the
    page wrote, for example a mail draft; otherwise the browser's question appears
    in the job tab and goes away with it. Nothing of this returns content to the
    agent. Unverified: none of the three was measured here; whether Firefox reports
    WebTransport sessions to `webRequest`, which ports it refuses for STUN and TURN,
    and the LibreWolf and Waterfox defaults for WebRTC were not checked.
22. **Side effects in your browser.** (1) When you close your last own window the
    add-on closes the gateway window too, so that the browser can quit. The gateway
    window is then the last window of the session: with "open previous windows and
    tabs" the next start brings back the gateway window, and yours is under
    History, Recently Closed Windows (not verified in a real session). (2) A tab
    that is opened from a job tab is sealed and closed as a pop-up of the job. That
    includes a link you open in a new tab yourself from a page that was handed to
    you for a human check, in the container and under a login rule. Work in the
    tab you were given. (3) After a job the add-on removes the job tab's entry from
    the recently-closed list. The entry is found by window and time (100 ms around
    the closing), not by an id: a tab of yours closed in the gateway window, or a
    one-tab window of yours closed, in that same instant can be removed from the
    list instead.
23. **Redirects are charged afterwards.** The first load through each redirecting
    address reaches its target whatever the target's gap, budget, cooldown or
    pending challenge; a page can also send the browser to a third site and spend
    that site's gap and budget, or its cooldown if it refuses.
24. **One response can lock a site for an hour.** A `Retry-After` is kept up to one
    hour for the whole site as the site rule defines it; hosts of that site share
    it. Restarting the daemon clears it.
25. **The daemon's second look at a result is limited.** A result without a final
    address is not checked, a name that resolves to a private address passes the
    text rules, and an add-on that reports the container from the start is
    believed.
