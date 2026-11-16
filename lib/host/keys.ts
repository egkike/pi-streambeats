/**
 * Terminal input → the key identifiers the model speaks (S13).
 *
 * The host owns key interpretation and exports `matchesKey`, so we ask it instead of re-deriving
 * ANSI sequences by hand: the hand-rolled table matched keys the card never received and missed the
 * ones it did (that is why `esc` did nothing while `j`/`k` worked). A printable character is passed
 * through as itself; everything else is matched against the keys the card binds.
 */
import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

/** Host key id → model key id, in match order: a modified key is tested before its base key. */
const BOUND: ReadonlyArray<readonly [KeyId, string]> = [
	["ctrl+c", "interrupt"],
	["escape", "escape"],
	["enter", "enter"],
	["return", "enter"],
	["space", "space"],
	["tab", "tab"],
	["backspace", "backspace"],
	["up", "up"],
	["down", "down"],
	["left", "left"],
	["right", "right"],
	["pageUp", "page-up"],
	["pageDown", "page-down"],
	["home", "home"],
	["end", "end"],
];

/**
 * Raw control bytes, matched before the host: the terminal sends these for the plain keys, and
 * `matchesKey` answers for the key ids the host emits, not for the bytes themselves.
 */
const RAW: Readonly<Record<string, string>> = {
	"\r": "enter",
	"\n": "enter",
	"\t": "tab",
	"\u007f": "backspace",
	"\b": "backspace",
	"\u0003": "interrupt",
	" ": "space",
};

/** Characters that act on the terminal instead of being typed into the filter (AGENTS.md). */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/** The model key id for one terminal chunk, or undefined when the card does not bind it. */
export function translateKey(data: string): string | undefined {
	const keys = translateKeys(data);
	return keys.length === 1 ? keys[0] : undefined;
}

/**
 * Every key a chunk carries. Pi hands the component the raw chunk, so a paste or a fast burst holds
 * several characters and dropping it whole loses what the user typed (R4-003).
 */
export function translateKeys(data: string): readonly string[] {
	if (data === "") return [];

	const raw = RAW[data];
	if (raw !== undefined) return [raw];

	const keys: string[] = [];
	let rest = data;

	while (rest !== "") {
		const escaped = rest.indexOf("\u001b");
		if (escaped === -1) {
			keys.push(...printable(rest));
			break;
		}

		keys.push(...printable(rest.slice(0, escaped)));

		const tail = rest.slice(escaped);
		const matched = BOUND.find(([hostKey]) => matchesKey(tail, hostKey));
		// An escape sequence the card does not bind ends the chunk: swallowing one byte of it and
		// typing the rest would put garbage in the filter (R4-003).
		if (!matched) break;
		keys.push(matched[1]);
		// A chunk is one key for the host, so the matched sequence takes the remainder with it.
		rest = "";
	}

	return keys;
}

function printable(text: string): readonly string[] {
	return [...text].filter((character) => !UNSAFE.test(character));
}

/**
 * Whether a chunk is the configured overlay shortcut. The card owns the keyboard while it is open,
 * so the global shortcut arrives here as input instead of reaching the host's own handler.
 */
export function matchesOverlayKey(data: string, shortcut: string): boolean {
	return shortcut !== "" && matchesKey(data, shortcut as KeyId);
}
