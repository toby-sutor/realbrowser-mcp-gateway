// The text of an error, in a form that may stand in the log.
//
// The words of an error are not this extension's own. The browser writes
// them, and it says what the failed call was given: tabs.update names the
// address it would not load ("Illegal URL: ..."), a script error names a
// file, a failed fetch names a host. The log holds no address of a job -
// least of all of one that was loaded with the operator's login - so an
// error is written down without every word that could be one or a part of
// one, in a small alphabet, and cut short.

const MAX_CHARS = 80;
// Longest text that is looked at; an error text is a sentence.
const MAX_READ = 2000;
// A word that may be an address or a piece of one: it has a slash, a sign that only stands inside addresses, a
// colon or a dot with something behind it (a scheme, a port, a host name, a file name). "URL:" and "closed." are
// plain words.
const ADDRESS_LIKE = /[/\\@?&=%#]|[:.]\S/;

/**
 * @param {unknown} err what was thrown or rejected with
 * @returns {string} its message for the log: letters, digits, blanks and ":_-" only, at most 80 characters, with
 *   "address" in place of every word that looks like one. "unknown" for what is no Error or says nothing
 */
export function errorText(err) {
	if (!(err instanceof Error) || typeof err.message !== "string") return "unknown";
	const words = err.message.slice(0, MAX_READ).split(/\s+/);
	// A word that was cut in two by the limit may have lost the part that gave it away.
	if (err.message.length > MAX_READ) words[words.length - 1] = "address";
	const text = words
		.map((word) => (ADDRESS_LIKE.test(word) ? "address" : word))
		.join(" ")
		.replace(/[^A-Za-z0-9 :_-]/g, "")
		.trim()
		.slice(0, MAX_CHARS);
	return text === "" ? "unknown" : text;
}
