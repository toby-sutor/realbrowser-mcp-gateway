import { ConfigError, EXIT, inheritedListenFd, loadConfig } from "./config.js";
import { consoleLogger } from "./log.js";
import { exitOnFault, start } from "./server.js";

const log = consoleLogger();
// Before anything else runs: whatever is thrown and not caught from here on is one log line and the end of the process.
exitOnFault(process, log, (code) => process.exit(code));

/** @param {string} line @param {number} code @returns {never} */
function die(line, code) {
	console.error(`browser-gateway: ${line}`);
	process.exit(code);
}

/** @type {import("./config.js").Config} */
let config;
try {
	config = loadConfig(process.env);
} catch (err) {
	die(err instanceof Error ? err.message : String(err), EXIT.CONFIG);
}

/** @type {number | null} */
let listenFd;
try {
	listenFd = inheritedListenFd(process.env, process.pid);
} catch (err) {
	die(err instanceof Error ? err.message : String(err), EXIT.BAD_SOCKET);
}
// Children (the notification helper, the hook) must not take these for theirs.
delete process.env.LISTEN_FDS;
delete process.env.LISTEN_PID;
delete process.env.LISTEN_FDNAMES;

/** @type {Awaited<ReturnType<typeof start>>} */
let daemon;
try {
	daemon = await start({
		port: config.port,
		configDir: config.configDir,
		dataDir: config.dataDir,
		log,
		...(listenFd === null ? {} : { listenFd }),
	});
} catch (err) {
	const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
	const message = err instanceof Error ? err.message : String(err);
	if (err instanceof ConfigError) die(message, EXIT.CONFIG);
	// One clear line and a code of its own: the service unit does not restart
	// on it, so a taken port is reported once instead of every few seconds.
	if (code === "EADDRINUSE") die(`127.0.0.1:${config.port} is already in use by another process - not starting`, EXIT.PORT_IN_USE);
	if (code === "BGW_BAD_SOCKET") die(`${message} - not starting`, EXIT.BAD_SOCKET);
	die(`failed to start: ${message}`, EXIT.FAILED);
}
console.log(`browser-gateway listening on 127.0.0.1:${daemon.port}${listenFd === null ? "" : " (socket handed over by the service manager)"}`);

let stopping = false;
const shutdown = async () => {
	if (stopping) return;
	stopping = true;
	await daemon.close();
	process.exit(EXIT.OK);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
