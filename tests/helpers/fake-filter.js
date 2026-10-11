// A stand-in for the browser's StreamFilter (webRequest.filterResponseData):
// the test plays the network, and can see everything that was done to it.

export class FakeFilter {
	/** @type {((event: { data: ArrayBuffer }) => void) | null} */
	ondata = null;
	/** @type {(() => void) | null} */
	onstop = null;
	/** @type {(() => void) | null} */
	onerror = null;
	/** @type {string} what the browser would say went wrong */
	error = "";
	/** How often each thing was done to the filter. Only "close" may ever be other than 0. */
	calls = { close: 0, write: 0, disconnect: 0, suspend: 0, resume: 0 };
	/** Bytes the filter handed on to the tab: must stay 0. */
	passedOn = 0;
	/** @type {string} */
	requestId;

	/** @param {string} requestId */
	constructor(requestId) {
		this.requestId = requestId;
	}

	get closed() {
		return this.calls.close > 0;
	}

	close() {
		this.calls.close += 1;
	}

	/** @param {ArrayBuffer | Uint8Array} data */
	write(data) {
		this.calls.write += 1;
		this.passedOn += data.byteLength;
	}

	disconnect() {
		this.calls.disconnect += 1;
	}

	suspend() {
		this.calls.suspend += 1;
	}

	resume() {
		this.calls.resume += 1;
	}

	/**
	 * A piece of the response body arrives. After close() the browser delivers nothing more.
	 * @param {Uint8Array | string} bytes
	 */
	feed(bytes) {
		if (this.closed) return;
		const view = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
		// As the browser does: a buffer of its own for every event, holding those bytes and no others.
		this.ondata?.({ data: new Uint8Array(view).buffer });
	}

	/** The response ended. */
	end() {
		if (!this.closed) this.onstop?.();
	}

	/** @param {string} [message] the request failed under the filter */
	fail(message = "Invalid request ID") {
		this.error = message;
		if (!this.closed) this.onerror?.();
	}
}

/** A filterResponseData that hands out FakeFilters and remembers them. */
export function filterFactory() {
	/** @type {FakeFilter[]} */
	const made = [];
	return {
		made,
		/** @param {string} requestId */
		filterResponseData: (requestId) => {
			const f = new FakeFilter(requestId);
			made.push(f);
			return f;
		},
	};
}
