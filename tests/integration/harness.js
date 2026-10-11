import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { NO_PACING, startTestDaemon } from "../helpers/daemon.js";
import { daemonPairCode, daemonStatus, daemonSubmitJob } from "../helpers/ext-fakes.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";
import { startFixtureServer } from "../fixtures/server.js";
import { b64urlEncode, randomBytes } from "../../extension/shared/auth.js";

// Exact version: what loads the extension must not change under the tests.
export const WEB_EXT = "web-ext@10.7.0";
// A public-looking name the test profile resolves to loopback (network.dns.localDomains).
export const LOOPBACK_NAME = "resolves-to-loopback.bgw-fixture.example";
// A host on the fixture port that the test build of the extension blocklists.
export const BLOCKLISTED_HOST = "blocked.localhost";
// A host on the fixture port whose site gets a cooldown after a block: every other fixture host has none.
export const COOLDOWN_HOST = "cool.localhost";
export const COOLDOWN_MS = 4000;
// Hosts that fixture pages name in the src of a frame, to look like a page with a human check. The browser
// never asks for them (the frames have a srcdoc); should it ever, the names lead to the loopback, where the
// request guard stops them. No test run reaches those sites.
const MARKER_HOSTS = ["challenges.cloudflare.com", "geo.captcha-delivery.com", "www.google.com", "newassets.hcaptcha.com"];
// Shorter waits than an operator's browser has: a challenge gets 1.5 to 2.5 s to clear by itself.
export const TEST_TUNING = Object.freeze({ graceMs: [1500, 2500], gracePollMs: 250, parkPollMs: 400, clearStableMs: 1500 });
// The rate limit of a login rule in a test run: one page per 1.5 s and twelve an hour, in place of one per 10 s
// and thirty an hour. Both ends are told (the extension through its dev config, the daemon through its options).
export const LOGIN_TEST_LIMITS = Object.freeze({ minGapMs: 1500, perHour: 12 });

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Every process below a pid, read from /proc. Used to end exactly the tree
 * this harness started and nothing else.
 * @param {number} root
 * @returns {{ pid: number, start: string }[]} start: the kernel's start time, to tell a reused pid apart
 */
function processTree(root) {
	/** @type {{ pid: number, start: string }[]} */
	const out = [];
	/** @param {number} pid */
	const visit = (pid) => {
		/** @type {string} */
		let stat;
		try {
			stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		} catch {
			return;
		}
		// Field 22, counted after the command name, which may contain spaces.
		out.push({ pid, start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "" });
		/** @type {string[]} */
		let tasks = [];
		try {
			tasks = fs.readdirSync(`/proc/${pid}/task`);
		} catch {
			return;
		}
		for (const task of tasks) {
			try {
				for (const child of fs.readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").split(" ")) {
					if (child !== "") visit(Number(child));
				}
			} catch {
				// the task ended meanwhile
			}
		}
	};
	visit(root);
	return out;
}

/**
 * Poll at a pace that suits a browser starting up.
 * @param {() => boolean | Promise<boolean>} condition
 * @param {{ timeoutMs: number, what: string, intervalMs?: number }} opts
 */
export async function waitFor(condition, opts) {
	const deadline = Date.now() + opts.timeoutMs;
	for (;;) {
		if (await condition()) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.what}`);
		await new Promise((resolve) => setTimeout(resolve, opts.intervalMs ?? 100));
	}
}

/** @param {{ pid: number, start: string }} proc */
function sameProcessAlive(proc) {
	try {
		const stat = fs.readFileSync(`/proc/${proc.pid}/stat`, "utf8");
		return (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "") === proc.start;
	} catch {
		return false;
	}
}

/**
 * Run headless Firefox with an unpacked extension through web-ext, in its own
 * process group, with a throwaway profile below the given temp directory.
 * @param {{ tmp: string, extDir: string, prefs?: Record<string, string | number | boolean> }} opts
 */
export function launchFirefox(opts) {
	const { tmp, extDir } = opts;
	const profileDir = path.join(tmp, "profile");
	const downloadsDir = path.join(tmp, "downloads");
	const sysTmp = path.join(tmp, "systmp");
	for (const dir of [profileDir, downloadsDir, sysTmp]) fs.mkdirSync(dir, { recursive: true });
	const prefs = {
		// A download that is not prevented lands here without a dialog, where a test can see it.
		"browser.download.dir": downloadsDir,
		"browser.download.folderList": 2,
		"browser.download.useDownloadDir": true,
		"browser.download.always_ask_before_handling_new_types": false,
		"browser.download.start_downloads_in_tmp_dir": false,
		"alerts.useSystemBackend": false,
		"browser.sessionstore.resume_from_crash": false,
		// The test browser stays off the internet: no start page, no new-tab
		// tiles, no page thumbnails fetched in the background.
		"browser.startup.homepage": "about:blank",
		"browser.startup.page": 0,
		"browser.newtabpage.enabled": false,
		"browser.newtabpage.activity-stream.feeds.topsites": false,
		"browser.pagethumbnails.capturing_disabled": true,
		// The extension's console goes to the runner's output, for the log file.
		"devtools.console.stdout.content": true,
		// A test ends its browser the hard way, sometimes a moment after it started. The browser counts such ends,
		// and after three in a row it would ask - in a dialog nobody sees - whether to start in its safe mode.
		"toolkit.startup.max_resumed_crashes": -1,
		...opts.prefs,
	};
	const args = [
		"--yes",
		WEB_EXT,
		"run",
		// Passes the browser's own output on, and with it the extension's console.
		"--verbose",
		"--no-config-discovery",
		"--source-dir",
		extDir,
		"--firefox",
		process.env.BGW_FIREFOX || "/usr/bin/firefox",
		"--no-input",
		"--no-reload",
		"--firefox-profile",
		profileDir,
		"--profile-create-if-missing",
		"--keep-profile-changes",
		...Object.entries(prefs).flatMap(([name, value]) => ["--pref", `${name}=${value}`]),
	];
	const logFile = path.join(tmp, "browser.log");
	const logFd = fs.openSync(logFile, "a", 0o600);
	// Its own process group, so the whole tree can be signalled as one.
	// The test browser has no way to the operator's desktop: its session bus
	// and its sound servers are sockets that do not exist. Whatever a page or
	// the extension asks for, no notification is shown and nothing is played.
	const nowhere = path.join(tmp, "no-such-socket");
	const child = spawn("npx", args, {
		cwd: tmp,
		env: {
			...process.env,
			MOZ_HEADLESS: "1",
			TMPDIR: sysTmp,
			DBUS_SESSION_BUS_ADDRESS: `unix:path=${nowhere}-bus`,
			PULSE_SERVER: `unix:${nowhere}-pulse`,
			PIPEWIRE_REMOTE: `${nowhere}-pipewire`,
		},
		detached: true,
		stdio: ["ignore", logFd, logFd],
	});
	fs.closeSync(logFd);
	const state = { exited: false };
	/** @type {Promise<void>} */
	const exit = new Promise((resolve) => {
		const done = () => {
			state.exited = true;
			resolve();
		};
		child.once("exit", done);
		child.once("error", done);
	});

	/** End the browser: only the process tree started here. */
	const kill = async () => {
		const pid = child.pid;
		if (pid === undefined) return;
		const tree = processTree(pid);
		if (!state.exited) {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				// the group is gone
			}
			await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 8000))]);
		}
		// Whatever is left of the tree, and only that.
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && tree.some(sameProcessAlive)) await new Promise((resolve) => setTimeout(resolve, 100));
		for (const proc of tree) {
			if (!sameProcessAlive(proc)) continue;
			try {
				process.kill(proc.pid, "SIGKILL");
			} catch {
				// gone
			}
		}
	};
	// A test run that dies must not leave a browser behind.
	const onExit = () => {
		if (child.pid !== undefined && !state.exited) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// gone
			}
		}
	};
	/** @param {NodeJS.Signals} signal */
	const onSignal = (signal) => {
		onExit();
		process.exit(signal === "SIGINT" ? 130 : 143);
	};
	process.on("exit", onExit);
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	return {
		downloadsDir,
		logFile,
		exit,
		get exited() {
			return state.exited;
		},
		/** @returns {string} what the browser and the extension printed so far */
		log: () => {
			try {
				return fs.readFileSync(logFile, "utf8");
			} catch {
				return "";
			}
		},
		stop: async () => {
			process.off("exit", onExit);
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
			await kill();
		},
	};
}

/**
 * Start everything an integration test needs: the fixture server, the real
 * daemon with a pre-shared extension key, and headless Firefox with a temp
 * copy of the extension that carries a dev-config.json.
 * @param {{ daemon?: Partial<import("../../daemon/src/server.js").StartOptions>, tuning?: Record<string, unknown>,
 *   config?: (fixtures: Awaited<ReturnType<typeof startFixtureServer>>) => Record<string, unknown>,
 *   prefs?: Record<string, string | number | boolean> }} [opts]
 *   daemon: start options on top of the harness's own; tuning: on top of TEST_TUNING in the extension's dev config;
 *   config: the daemon's config.json, made once the fixture server's port is known;
 *   prefs: browser preferences on top of the harness's own (a browser that brings its last session back, say)
 */
export async function startHarness(opts = {}) {
	const tmp = makeTempDir("it");
	const extDir = path.join(tmp, "ext");
	const configDir = path.join(tmp, "config");
	const dataDir = path.join(tmp, "data");

	const fixtures = await startFixtureServer();

	const extKey = b64urlEncode(randomBytes(32));
	fs.mkdirSync(configDir, { mode: 0o700 });
	fs.writeFileSync(path.join(configDir, "ext.key"), extKey + "\n", { mode: 0o600 });
	if (opts.config !== undefined) fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(opts.config(fixtures), null, "\t"), { mode: 0o600 });
	const daemonOpts = {
		configDir,
		dataDir,
		allowLoopbackPorts: [fixtures.port],
		// No pacing, except that one host's site is left alone for a moment after it blocked.
		pacing: { polite: NO_PACING.polite, fast: { ...NO_PACING.fast, cooldownMs: /** @type {const} */ ([COOLDOWN_MS, COOLDOWN_MS]) } },
		fastHosts: [COOLDOWN_HOST],
		// Many challenges on few fixture hosts within a minute: the notifier's own
		// limits (one notification per site and minute, six a minute in all) are
		// for the unit tests. Here every pending challenge gets its stand-in notification.
		notifyLimits: { hostCooldownMs: 0, maxPerMinute: 10000 },
		...opts.daemon,
	};
	let daemon = await startTestDaemon(daemonOpts);
	const daemonPort = daemon.port;

	// Control channel into the extension (extension/background/devhook.js).
	const hookServer = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/hook" });
	await new Promise((resolve) => hookServer.once("listening", resolve));
	const hookAddr = hookServer.address();
	if (hookAddr === null || typeof hookAddr === "string") throw new Error("hook server has no port");
	/** @type {import("ws").WebSocket | null} */
	let hookSocket = null;
	let hookSeq = 0;
	/** @type {Map<number, { resolve: (v: any) => void, reject: (err: Error) => void }>} */
	const hookCalls = new Map();
	hookServer.on("connection", (ws) => {
		hookSocket = ws;
		ws.on("message", (data) => {
			const msg = JSON.parse(data.toString());
			const call = hookCalls.get(msg.id);
			if (call === undefined) return;
			hookCalls.delete(msg.id);
			if (msg.ok) call.resolve(msg.result);
			else call.reject(new Error(`hook: ${msg.error}`));
		});
		ws.on("close", () => {
			if (hookSocket === ws) hookSocket = null;
		});
	});
	/**
	 * Run a command inside the extension.
	 * @param {string} cmd
	 * @param {Record<string, unknown>} [args]
	 * @returns {Promise<any>}
	 */
	const hook = (cmd, args = {}) =>
		new Promise((resolve, reject) => {
			const ws = hookSocket;
			if (ws === null) return reject(new Error("hook: the extension is not connected"));
			const id = ++hookSeq;
			const timer = setTimeout(() => {
				hookCalls.delete(id);
				reject(new Error(`hook: no answer to "${cmd}"`));
			}, 20000);
			hookCalls.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});
			ws.send(JSON.stringify({ id, cmd, args }));
		});

	// The extension under test: a copy, so the dev config never touches the source tree.
	fs.cpSync(path.join(repoRoot, "extension"), extDir, { recursive: true });
	fs.writeFileSync(
		path.join(extDir, "dev-config.json"),
		JSON.stringify({
			port: daemonPort,
			extKey,
			allowLoopbackPorts: [fixtures.port],
			blocklistExtra: [BLOCKLISTED_HOST],
			hookPort: hookAddr.port,
			tuning: { ...TEST_TUNING, ...opts.tuning },
		}),
		{ mode: 0o600 },
	);

	const prefs = {
		"network.dns.localDomains": [LOOPBACK_NAME, ...MARKER_HOSTS].join(","),
		// Pop-ups allowed, so that a page opening a tab by itself can be tested.
		"dom.disable_open_during_load": false,
		...opts.prefs,
	};
	let firefox = launchFirefox({ tmp, extDir, prefs });

	const harness = {
		tmp,
		downloadsDir: firefox.downloadsDir,
		/** @returns {string} what the browser and the extension printed so far */
		browserLog: () => firefox.log(),
		fixtures,
		hook,
		daemonPort,
		/** The pre-shared key the run started with (in dev-config.json). Never print it. */
		presharedKey: extKey,
		/** The daemon of the moment; it is replaced by restartDaemon(). */
		get daemon() {
			return daemon;
		},
		get browserExited() {
			return firefox.exited;
		},
		/** Where the copy of the extension lies that the browser runs. */
		extDir,
		/**
		 * Close the browser and start it again with the same profile, as the
		 * operator's browser is closed and opened again. With "version" the
		 * extension is a newer one when it comes back: an update in place.
		 * @param {{ version?: string }} [ro]
		 */
		restartBrowser: async (ro = {}) => {
			await firefox.stop();
			for (const call of hookCalls.values()) call.reject(new Error("hook: the browser was restarted"));
			hookCalls.clear();
			if (ro.version !== undefined) {
				const file = path.join(extDir, "manifest.json");
				const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
				manifest.version = ro.version;
				fs.writeFileSync(file, JSON.stringify(manifest, null, "\t"));
			}
			await waitFor(async () => hookSocket === null && (await daemonStatus(daemon)).extension?.connected !== true, { timeoutMs: 15000, what: "the old browser to be gone" });
			firefox = launchFirefox({ tmp, extDir, prefs });
			await waitFor(
				async () => {
					if (firefox.exited) throw new Error("the browser runner exited early");
					return hookSocket !== null && (await daemonStatus(daemon)).extension?.connected === true;
				},
				{ timeoutMs: 120000, intervalMs: 250, what: "the restarted browser to load the extension and connect" },
			);
		},
		/**
		 * Submit a raw job. /v1/jobs takes the admin token.
		 * @param {Record<string, unknown>} job
		 * @param {{ signal?: AbortSignal }} [ro]
		 */
		submitJob: (job, ro = {}) => daemonSubmitJob(daemon, job, ro),
		/** @returns {Promise<any>} the daemon's status as the operator sees it */
		status: () => daemonStatus(daemon),
		/** @returns {Promise<string>} a fresh one-time pairing code */
		pairCode: () => daemonPairCode(daemon),
		get browserExit() {
			return firefox.exit;
		},
		/** @returns {string[]} files a download would have left behind */
		downloads: () => fs.readdirSync(firefox.downloadsDir),
		/** Stop the daemon and start it again on the same port with the same key. */
		/** @param {Partial<import("../../daemon/src/server.js").StartOptions>} [more] start options for the new daemon, on top of the old ones */
		restartDaemon: async (more = {}) => {
			const old = daemon;
			await old.close();
			removeTempDir(old.dir);
			daemon = await startTestDaemon({ ...daemonOpts, ...more, port: daemonPort });
		},
		stopDaemon: async () => {
			await daemon.close();
		},
		/**
		 * Wait until the extension holds a ready link to the daemon.
		 * @param {number} [timeoutMs]
		 */
		connected: async (timeoutMs = 30000) => {
			await waitFor(async () => (await daemonStatus(daemon)).extension.connected === true, { timeoutMs, what: "the extension to connect" });
		},
		stop: async () => {
			await firefox.stop();
			for (const call of hookCalls.values()) call.reject(new Error("hook: harness stopped"));
			hookCalls.clear();
			for (const ws of hookServer.clients) ws.terminate();
			await new Promise((resolve) => hookServer.close(() => resolve(undefined)));
			await daemon.close().catch(() => {});
			removeTempDir(daemon.dir);
			await fixtures.stop();
			// BGW_KEEP_TMP=1 keeps the profile and the browser log for a post-mortem.
			if (process.env.BGW_KEEP_TMP !== "1") removeTempDir(tmp);
		},
	};

	try {
		// The first run may have to fetch web-ext.
		await waitFor(
			async () => {
				if (firefox.exited) throw new Error("the browser runner exited early");
				return hookSocket !== null && (await daemonStatus(daemon)).extension?.connected === true;
			},
			{ timeoutMs: 240000, intervalMs: 250, what: "headless Firefox to load the extension and connect" },
		);
	} catch (err) {
		const tail = firefox.log().slice(-3000);
		await harness.stop();
		throw new Error(`${err instanceof Error ? err.message : err}\n--- browser log tail ---\n${tail}`);
	}
	return harness;
}

/**
 * The release artefact on its own: build the XPI, unpack it, load it. No dev
 * config, no test hook, no daemon - what the operator installs, before pairing.
 */
export async function startReleaseBrowser() {
	const tmp = makeTempDir("release");
	const extDir = path.join(tmp, "ext");
	const build = spawnSync("sh", [path.join(repoRoot, "tools", "build-xpi.sh")], { cwd: repoRoot, encoding: "utf8" });
	if (build.status !== 0) throw new Error(`build-xpi.sh failed: ${build.stderr}`);
	const built = /^built (.+\.xpi)$/m.exec(build.stdout);
	if (built === null) throw new Error("build-xpi.sh did not name the file it built");
	const xpi = built[1];
	const unpack = spawnSync("python3", ["-m", "zipfile", "-e", xpi, extDir], { encoding: "utf8" });
	if (unpack.status !== 0) throw new Error(`could not unpack the XPI: ${unpack.stderr}`);
	const firefox = launchFirefox({ tmp, extDir });
	return {
		xpi,
		extDir,
		firefox,
		/** @returns {string[]} names of the files in the package */
		files: () =>
			fs
				.readdirSync(extDir, { recursive: true, withFileTypes: true })
				.filter((e) => e.isFile())
				.map((e) => path.relative(extDir, path.join(e.parentPath, e.name)))
				.sort(),
		stop: async () => {
			await firefox.stop();
			if (process.env.BGW_KEEP_TMP !== "1") removeTempDir(tmp);
		},
	};
}
