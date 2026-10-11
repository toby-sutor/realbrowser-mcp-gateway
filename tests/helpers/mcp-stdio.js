import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../cli/bgw", import.meta.url));
const PYTHON = process.env.PYTHON || "python3";

/**
 * Run "bgw mcp" as a client would: a child process, JSON-RPC lines on its
 * stdin, its answers read from stdout line by line.
 * @param {Record<string, string>} env BGW_URL and the token files; nothing else of this process's environment goes along
 * @param {{ cwd?: string }} [opts] cwd: the working directory of the helper (where file_export writes by default)
 */
export function startMcp(env, opts = {}) {
	const child = spawn(PYTHON, [CLI, "mcp"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", ...env }, stdio: ["pipe", "pipe", "pipe"], ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }) });
	/** @type {any[]} every message it wrote, in order */
	const messages = [];
	/** @type {string[]} lines on stdout that are no JSON: there must never be one */
	const junk = [];
	let stdout = "";
	let stderr = "";
	let pending = "";
	/** @type {{ match: (m: any) => boolean, resolve: (m: any) => void, reject: (err: Error) => void, timer: NodeJS.Timeout }[]} */
	const waiters = [];
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		pending += chunk;
		for (;;) {
			const end = pending.indexOf("\n");
			if (end === -1) break;
			const line = pending.slice(0, end);
			pending = pending.slice(end + 1);
			/** @type {any} */
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				junk.push(line);
				continue;
			}
			messages.push(message);
			const i = waiters.findIndex((w) => w.match(message));
			if (i !== -1) {
				const [w] = waiters.splice(i, 1);
				clearTimeout(w.timer);
				w.resolve(message);
			}
		}
	});
	child.stderr.on("data", (chunk) => (stderr += chunk));
	/** @type {Promise<{ code: number | null, signal: NodeJS.Signals | null }>} */
	const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
	exited.then(() => {
		for (const w of waiters.splice(0)) {
			clearTimeout(w.timer);
			w.reject(new Error(`bgw mcp exited while an answer was awaited; stderr: ${stderr}`));
		}
	});
	let nextId = 1;

	/**
	 * @param {(m: any) => boolean} match
	 * @param {number} timeoutMs
	 * @returns {Promise<any>}
	 */
	const waitFor = (match, timeoutMs) => {
		const found = messages.find(match);
		if (found !== undefined) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const w = {
				match,
				resolve,
				reject,
				timer: setTimeout(() => {
					waiters.splice(waiters.indexOf(w), 1);
					reject(new Error(`bgw mcp: no such answer within ${timeoutMs} ms; stderr: ${stderr}`));
				}, timeoutMs),
			};
			waiters.push(w);
		});
	};

	return {
		pid: child.pid,
		messages,
		junk,
		exited,
		/** @returns {string} everything it wrote to stdout, as it came */
		stdout: () => stdout,
		/** @returns {string} */
		stderr: () => stderr,
		/** @param {string | Buffer} text sent as it is */
		writeRaw: (text) => child.stdin.write(text),
		/** @param {unknown} message one JSON-RPC message, on a line of its own */
		send: (message) => child.stdin.write(JSON.stringify(message) + "\n"),
		/**
		 * Send a request and wait for its answer.
		 * @param {string} method
		 * @param {unknown} [params]
		 * @param {{ timeoutMs?: number, id?: string | number }} [opts]
		 * @returns {Promise<any>} the whole JSON-RPC answer
		 */
		request: (method, params, opts = {}) => {
			const id = opts.id ?? nextId++;
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
			const from = messages.length;
			return waitFor((m) => messages.indexOf(m) >= from && m.id === id, opts.timeoutMs ?? 15000);
		},
		/** @returns {number} an id no request made here has used */
		newId: () => nextId++,
		waitFor,
		/** Close its stdin, as a client that is done does. */
		end: () => child.stdin.end(),
		/** @param {NodeJS.Signals} signal */
		signal: (signal) => child.kill(signal),
		/** Whatever state it is in: gone when this returns. */
		stop: async () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.stdin.end();
				const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
				await exited;
				clearTimeout(timer);
			}
		},
	};
}
