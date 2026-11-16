/**
 * Raw terminal input to the model's key identifiers (S13). Pi gives a focused component the bytes
 * the terminal sent; the model's only key table speaks `up`, `enter`, `backspace` and printable
 * characters. The translation lives here so the core keeps no terminal vocabulary (S8).
 *
 * Only the sequences the card binds are translated. Anything else comes back as `undefined` and the
 * model is not asked to act on it; an arrow with an unknown modifier is not silently read as a bare
 * arrow. Printable characters pass through because the filter mode (S18) types them.
 */

/** Arrow keys arrive in two shapes: CSI (`\x1b[A`) in normal mode and SS3 (`\x1bOA`) in application mode. */
const ARROWS: Readonly<Record<string, string>> = {
	"\x1b[A": "up",
	"\x1b[B": "down",
	"\x1b[C": "right",
	"\x1b[D": "left",
	"\x1bOA": "up",
	"\x1bOB": "down",
	"\x1bOC": "right",
	"\x1bOD": "left",
};

/** Control keys whose byte has one meaning the card binds. */
const CONTROL: Readonly<Record<string, string>> = {
	"\x1b": "escape",
	"\r": "enter",
	"\n": "enter",
	"\x7f": "backspace",
	"\b": "backspace",
	"\t": "tab",
	" ": "space",
};

/** Characters that act on the terminal instead of being typed into the filter (AGENTS.md). */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/** One terminal input chunk as a key identifier, or undefined when the card does not bind it. */
export function translateKey(data: string): string | undefined {
	if (data === "") return undefined;

	const arrow = ARROWS[data];
	if (arrow) return arrow;

	const control = CONTROL[data];
	if (control) return control;

	const characters = [...data];
	if (characters.length !== 1) return undefined;
	return UNSAFE.test(data) ? undefined : data;
}

/** Every known sequence with its key id, longest first so a sequence is not split into characters. */
const KNOWN: ReadonlyArray<readonly [string, string]> = [...Object.entries(ARROWS), ...Object.entries(CONTROL)].sort(
	(left, right) => right[0].length - left[0].length,
);

/**
 * Every key a terminal chunk carries. A paste or a fast burst arrives as one chunk, and dropping it
 * whole would silently lose typed characters in the filter (R4-003). Known sequences are matched
 * longest-first wherever they appear; an escape sequence we do not know ends the chunk, because
 * consuming one byte of it and typing the rest would type garbage into the filter.
 */
export function translateKeys(data: string): readonly string[] {
	const keys: string[] = [];
	let rest = data;

	while (rest !== "") {
		// A bare ESC is a key on its own; anything longer that starts with ESC is a sequence, and an
		// unknown one ends the chunk instead of being typed character by character.
		const known = KNOWN.find(([sequence]) => sequence !== "\u001b" && rest.startsWith(sequence));
		if (known) {
			keys.push(known[1]);
			rest = rest.slice(known[0].length);
			continue;
		}
		if (rest === "\u001b") {
			keys.push("escape");
			break;
		}
		if (rest.startsWith("\u001b")) break;

		const [first] = [...rest];
		if (first === undefined) break;
		const key = translateKey(first);
		if (key !== undefined) keys.push(key);
		rest = rest.slice(first.length);
	}

	return keys;
}
