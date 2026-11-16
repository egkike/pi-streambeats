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
