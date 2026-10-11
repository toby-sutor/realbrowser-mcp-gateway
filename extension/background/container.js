// The "Browser Gateway" contextual identity: the only cookie store a job may
// use. Fails closed - when it is not available there is no fallback store.

export const CONTAINER_NAME = "Browser Gateway";
const CONTAINER_COLOR = "turquoise";
const CONTAINER_ICON = "fence";

export class ContainerError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "ContainerError";
	}
}

/**
 * @typedef {object} Identity
 * @property {string} cookieStoreId
 * @property {string} name
 *
 * @typedef {object} IdentitiesApi the part of browser.contextualIdentities used here
 * @property {(cookieStoreId: string) => Promise<Identity>} get
 * @property {(details: { name?: string }) => Promise<Identity[]>} query
 * @property {(details: { name: string, color: string, icon: string }) => Promise<Identity>} create
 * @property {(cookieStoreId: string) => Promise<Identity>} remove
 * @property {{ addListener: (fn: (change: { contextualIdentity: Identity }) => void) => void }} onRemoved
 *
 * @typedef {object} ContainerDeps
 * @property {IdentitiesApi | undefined} identities undefined when the browser has no container support
 * @property {{ containerId: string | null, setContainerId: (id: string | null) => Promise<void> }} settings
 * @property {(event: string, fields?: Record<string, string | number | boolean | null>) => void} log
 * @property {() => void} onChange readiness changed
 */

/**
 * Why the container cannot be cleared right now: tabs of jobs live in it and would be closed under them.
 * Asked of every job that is alive, not only of what the popup shows - a job whose human check was just cleared
 * is neither running nor waiting, and still has its tab open until its result is out.
 * @param {{ current: () => unknown, pending: () => unknown[], busy: () => boolean }} jobs the job runner
 * @returns {string | null} a sentence for the operator; null: nothing stands in the way
 */
export function clearRefusal(jobs) {
	if (jobs.current() !== null) return "A page is being loaded right now. Try again when it is done, or pause the gateway first.";
	const waiting = jobs.pending().length;
	if (waiting > 0) {
		return `${waiting === 1 ? "A page with a human check waits" : `${waiting} pages with a human check wait`} for you in this container. Open or close ${waiting === 1 ? "it" : "them"} first (toolbar button).`;
	}
	if (jobs.busy()) return "A page whose human check was just passed is still being read. Try again in a moment.";
	return null;
}

/** @param {unknown} id */
function isContainerStoreId(id) {
	// Never the default store, never a private one.
	return typeof id === "string" && /^firefox-container-[0-9]+$/.test(id);
}

export class Container {
	#deps;
	/** @type {string | null} */
	#id = null;
	/** @type {Promise<string> | null} */
	#pending = null;
	/** @type {Promise<string> | null} a clear that is under way; whoever asks for the container meanwhile gets the new one */
	#clearing = null;

	/** @param {ContainerDeps} deps */
	constructor(deps) {
		this.#deps = deps;
		deps.identities?.onRemoved.addListener((change) => {
			if (this.#id === null || change.contextualIdentity.cookieStoreId !== this.#id) return;
			// Firefox closes the tabs of a removed identity itself. Make a new one
			// so the next job has a store; the cookies are gone either way.
			this.#id = null;
			deps.log("container.removed", {});
			deps.onChange();
			this.ensure().catch(() => {});
		});
	}

	/** True once the container is known to exist. */
	get ready() {
		return this.#id !== null;
	}

	/** @returns {string | null} */
	get cookieStoreId() {
		return this.#id;
	}

	/**
	 * Find or create the container: stored id, else by name, else new.
	 * @returns {Promise<string>} its cookieStoreId
	 * @throws {ContainerError} when no container can be had; the caller must not load anything then
	 */
	ensure() {
		if (this.#clearing !== null) return this.#clearing;
		if (this.#id !== null) return Promise.resolve(this.#id);
		if (this.#pending === null) {
			this.#pending = this.#findOrCreate().finally(() => {
				this.#pending = null;
			});
		}
		return this.#pending;
	}

	/**
	 * Remove the container with everything in it (cookies, storage, open tabs)
	 * and make a fresh one. Only ever the gateway's own container: an identity
	 * that is no container, or that no longer carries the gateway's name (the
	 * operator made it theirs), is left as it is and merely forgotten.
	 * @returns {Promise<string>} the new cookieStoreId
	 */
	clear() {
		if (this.#clearing === null) {
			this.#clearing = this.#replace().finally(() => {
				this.#clearing = null;
			});
		}
		return this.#clearing;
	}

	/** @returns {Promise<string>} */
	async #replace() {
		const api = this.#deps.identities;
		if (api === undefined) throw new ContainerError("this browser has no container support");
		// A look-up that is under way ends first, so that it cannot bring the old container back.
		if (this.#pending !== null) await this.#pending.catch(() => {});
		const old = this.#id ?? (await this.#findOrCreate().catch(() => null));
		this.#id = null;
		this.#deps.onChange();
		if (old !== null && isContainerStoreId(old)) {
			const identity = await api.get(old).catch(() => null);
			if (identity !== null && identity.cookieStoreId === old && identity.name === CONTAINER_NAME) {
				try {
					await api.remove(old);
				} catch (err) {
					throw new ContainerError(`the container could not be removed: ${err instanceof Error ? err.message : "unknown error"}`);
				}
			}
		}
		await this.#deps.settings.setContainerId(null);
		// The next container is found by its name: one of that name that is still there would be taken for it, with
		// whatever it holds. What carries the gateway's name is the gateway's, and goes.
		try {
			for (const other of (await api.query({ name: CONTAINER_NAME })).slice(0, 8)) {
				if (other.name === CONTAINER_NAME && isContainerStoreId(other.cookieStoreId)) await api.remove(other.cookieStoreId);
			}
		} catch (err) {
			throw new ContainerError(`the container could not be removed: ${err instanceof Error ? err.message : "unknown error"}`);
		}
		return this.#findOrCreate();
	}

	/** @returns {Promise<string>} */
	async #findOrCreate() {
		const api = this.#deps.identities;
		if (api === undefined) throw new ContainerError("this browser has no container support");
		/** @type {Identity | null} */
		let found = null;
		try {
			const stored = this.#deps.settings.containerId;
			if (stored !== null && isContainerStoreId(stored)) {
				found = await api.get(stored).catch(() => null);
				// An identity the operator renamed is theirs now.
				if (found !== null && found.name !== CONTAINER_NAME) found = null;
			}
			if (found === null) found = (await api.query({ name: CONTAINER_NAME }))[0] ?? null;
			if (found === null) {
				found = await api.create({ name: CONTAINER_NAME, color: CONTAINER_COLOR, icon: CONTAINER_ICON });
				this.#deps.log("container.created", {});
			}
		} catch (err) {
			throw new ContainerError(`the gateway container is not available: ${err instanceof Error ? err.message : "unknown error"}`);
		}
		if (found === null || !isContainerStoreId(found.cookieStoreId)) {
			throw new ContainerError("the browser returned an unusable container");
		}
		this.#id = found.cookieStoreId;
		if (this.#deps.settings.containerId !== this.#id) await this.#deps.settings.setContainerId(this.#id).catch(() => {});
		this.#deps.onChange();
		return this.#id;
	}
}
