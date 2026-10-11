// Processes that sit on a port in place of the daemon, for the tests of the
// proof step: whatever they answer, no token may ever reach them.

import http from "node:http";
import net from "node:net";

/**
 * @typedef {{ tokenFile: string, adminFile: string }} TokenFiles where the client under test finds its tokens
 */

/** @returns {Promise<number>} a port nothing listens on */
export function closedPort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = addr !== null && typeof addr !== "string" ? addr.port : 0;
			server.close(() => resolve(port));
		});
	});
}

/**
 * A process that sits on a port and answers HTTP its own way, recording every
 * byte it is sent.
 * @param {(req: { method: string, url: string, body: any, port: number }) => { status?: number, json?: unknown, raw?: string, headers?: Record<string, string> }} answer
 *   port: the port the squatter itself listens on
 * @param {TokenFiles} files
 */
export async function squatter(answer, files) {
	/** @type {{ method: string, url: string, headers: http.IncomingHttpHeaders, body: string }[]} */
	const requests = [];
	let connections = 0;
	const server = http.createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
			/** @type {any} */
			let parsed = null;
			try {
				parsed = JSON.parse(body);
			} catch {
				// not JSON
			}
			const a = answer({ method: req.method ?? "", url: req.url ?? "", body: parsed, port: /** @type {import("node:net").AddressInfo} */ (server.address()).port });
			const text = a.raw ?? JSON.stringify(a.json ?? {});
			res.writeHead(a.status ?? 200, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...a.headers });
			res.end(text);
		});
	});
	server.on("connection", () => connections++);
	await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
	const addr = server.address();
	const port = addr !== null && typeof addr !== "string" ? addr.port : 0;
	return {
		port,
		requests,
		connections: () => connections,
		env: { BGW_URL: `http://127.0.0.1:${port}`, BGW_TOKEN_FILE: files.tokenFile, BGW_ADMIN_TOKEN_FILE: files.adminFile },
		/** Everything it was sent, as one text: no token must ever be in here. */
		seen: () => JSON.stringify(requests),
		stop: () =>
			/** @type {Promise<void>} */ (
				new Promise((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				})
			),
	};
}

/**
 * A process on a port that answers each connection byte by byte, its own way.
 * @param {(socket: import("node:net").Socket, request: string) => void} respond called once the request head has arrived
 * @param {TokenFiles} files
 */
export async function rawSquatter(respond, files) {
	/** @type {Set<import("node:net").Socket>} */
	const sockets = new Set();
	let received = "";
	const server = net.createServer((socket) => {
		sockets.add(socket);
		let head = "";
		let answered = false;
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		socket.on("data", (chunk) => {
			received += chunk.toString("latin1");
			if (answered) return;
			head += chunk.toString("latin1");
			if (!head.includes("\r\n\r\n")) return;
			answered = true;
			respond(socket, head);
		});
	});
	await /** @type {Promise<void>} */ (new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve())));
	const addr = server.address();
	const port = addr !== null && typeof addr !== "string" ? addr.port : 0;
	return {
		port,
		env: { BGW_URL: `http://127.0.0.1:${port}`, BGW_TOKEN_FILE: files.tokenFile, BGW_ADMIN_TOKEN_FILE: files.adminFile },
		/** Everything it was sent: no token must ever be in here. */
		seen: () => received,
		stop: () =>
			/** @type {Promise<void>} */ (
				new Promise((resolve) => {
					for (const socket of sockets) socket.destroy();
					server.close(() => resolve());
				})
			),
	};
}
