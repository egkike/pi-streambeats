/**
 * The card's state machine (S3, S11, S13, S15). Pure and synchronous: it reads nothing from the
 * world, never awaits, and never mutates the state it is handed. Everything it wants done comes back
 * as data (S8) — the shell loads folders, drives mpv and renders the footer — so this module is
 * testable without a terminal, a socket or a music library.
 *
 * Two facts are deliberately kept apart: the listing the user is browsing and the queue that is
 * playing. Changing folders swaps the first and leaves the second alone (S11).
 */
import { posix, win32 } from "node:path";
import type { LibraryEntry, Track } from "../types.ts";

/** Volume range, step and starting point (S11). The card owns it for the session and never persists it. */
export const MIN_VOLUME = 0;
export const MAX_VOLUME = 100;
export const DEFAULT_VOLUME = 70;
export const VOLUME_STEP = 5;

/**
 * Presence and size are separate on purpose (S15): the overlay shortcut flips presence without
 * needing the card's focus, while `l` changes size only when the card has it.
 */
export type Presence = "hidden" | "visible";
export type CardSize = "corner" | "expanded";

/**
 * The queue (S11). It holds every track of the folder the playback started in plus the order they
 * will be played in, because shuffle permutes only what is left and turning it off has to be able
 * to put the rest back. It lives in the state, not in the listing: browsing away never stops music.
 */
export interface Queue {
	/** All tracks of the folder, in folder order. Never permuted. */
	readonly tracks: readonly Track[];
	/** The order they play in: `tracks` until shuffle permutes the part that has not played yet. */
	readonly playOrder: readonly Track[];
	/** Index in `playOrder` of the track that is playing. */
	readonly position: number;
}

export interface CardState {
	/** The configured root (S14): the card starts here and the breadcrumb is relative to it. */
	readonly libraryRoot: string;
	/** The highest folder navigation may reach (S14). An input, never derived from HOME in here. */
	readonly ceiling: string;
	/** The folder on screen (S14). */
	readonly path: string;
	readonly entries: readonly LibraryEntry[];
	readonly cursor: number;
	readonly presence: Presence;
	readonly size: CardSize;
	/** True only while the card owns the keyboard: `l` requires it (S15). */
	readonly focused: boolean;
	/** The track mpv has loaded, if any (S12): the status bar and the footer speak about it. */
	readonly playing?: Track;
	readonly paused: boolean;
	/** Present while a queue exists (S11); gone after stop and after the playlist ended. */
	readonly queue?: Queue;
	readonly volume: number;
	readonly shuffle: boolean;
	/** The footer's message (S11, S14): "at home", "playlist ended", a failure, the shuffle state. */
	readonly notice?: string;
	/**
	 * The folder a scan is reading right now (S21). While it is set the footer says `reading <path>`:
	 * a folder that is still arriving and a folder that is empty must not look the same, and the scan
	 * happens on the input path, so the card paints before the answer exists.
	 */
	readonly reading?: string;
	/**
	 * The filter over the current folder (S18): the term the listing is narrowed by, empty when there
	 * is none. The listing is read through `visibleEntries`, so the narrowing lives in one function.
	 */
	readonly filter: string;
	/** True only while the card is taking the filter term (S18): keys are text, not transport. */
	readonly filtering: boolean;
	/**
	 * The row the pointer is over (S17), as an index into `visibleEntries`, or absent when the pointer
	 * is not on a row. It lives in the state for one reason: the frame is cached by state identity, so
	 * a highlight that did not reach the state could never repaint. It is not a selection — the cursor
	 * stays the keyboard's, and a click selects before it activates.
	 */
	readonly hover?: number;
}

/**
 * Mouse input, as data (S17). The host resolves a pointer position to the row the renderer said is
 * under it — `index` is an index into `visibleEntries`, never a screen coordinate — and the reducer
 * decides what that means. Kept apart from `CardEvent` only so the adapter can name the subset it
 * produces.
 */
export type PointerEvent =
	/** The pointer moved onto a row, or off every row when `index` is absent (S17: the hover). */
	| { readonly kind: "hover"; readonly index?: number }
	/** A click on a row (S17): the row is selected first, then activated, as `enter` would. */
	| { readonly kind: "click"; readonly index: number }
	/** The wheel moved `delta` rows through the listing; positive is further down (S17). */
	| { readonly kind: "wheel"; readonly delta: number };

/** Everything the card needs to exist: where it starts and how far up it may go (S14). */
export interface CardConfig {
	readonly libraryRoot: string;
	readonly ceiling: string;
}

/** What a key does, independent of the physical key that carries it (S13). */
export type KeyAction =
	| "cursor-up"
	| "cursor-down"
	| "activate"
	| "folder-up"
	| "hide"
	| "start-filter"
	| "toggle-pause"
	| "stop"
	| "next"
	| "previous"
	| "volume-up"
	| "volume-down"
	| "toggle-shuffle";

/**
 * The transport a global shortcut can ask for (S22). It borrows the key table's own identifiers, so
 * "pause", "next" and "previous" mean one thing in this module and not two.
 */
export type TransportAction = Extract<KeyAction, "toggle-pause" | "next" | "previous">;

export interface KeyBinding {
	/** Identifier the host adapter maps a physical key to (S13). */
	readonly id: string;
	/** How the key prints in the footer: `escape` shows as `esc`, `backspace` as `⌫`. */
	readonly label: string;
	readonly action: KeyAction;
	/** Help text the footer prints next to the label (S13). */
	readonly help: string;
	/** One binding per action is the hint the footer prints; the rest are only dispatchable. */
	readonly hint: boolean;
}

/** A footer hint derived from the same table as the input handling, so the two cannot drift (S13). */
export interface FooterHint {
	readonly key: string;
	readonly help: string;
	readonly action: KeyAction;
}

/** The only key table (S13): the footer renders from it and the reducer dispatches from it. */
export const KEY_BINDINGS: readonly KeyBinding[] = [
	{ id: "up", label: "↑", action: "cursor-up", help: "move", hint: true },
	{ id: "k", label: "k", action: "cursor-up", help: "move", hint: false },
	{ id: "down", label: "↓", action: "cursor-down", help: "move", hint: false },
	{ id: "j", label: "j", action: "cursor-down", help: "move", hint: false },
	{ id: "enter", label: "enter", action: "activate", help: "open", hint: true },
	{ id: "space", label: "space", action: "toggle-pause", help: "pause", hint: true },
	{ id: "n", label: "n", action: "next", help: "next", hint: true },
	{ id: ">", label: ">", action: "next", help: "next", hint: false },
	{ id: "p", label: "p", action: "previous", help: "prev", hint: true },
	{ id: "<", label: "<", action: "previous", help: "prev", hint: false },
	{ id: "u", label: "u", action: "folder-up", help: "up a folder", hint: true },
	{ id: "backspace", label: "⌫", action: "folder-up", help: "up a folder", hint: false },
	{ id: "/", label: "/", action: "start-filter", help: "filter", hint: true },
	{ id: "s", label: "s", action: "stop", help: "stop", hint: true },
	{ id: "+", label: "+", action: "volume-up", help: "vol", hint: true },
	{ id: "-", label: "-", action: "volume-down", help: "vol", hint: true },
	{ id: "z", label: "z", action: "toggle-shuffle", help: "shuffle", hint: true },
	{ id: "escape", label: "esc", action: "hide", help: "hide", hint: true },
	// The host adapter maps ctrl-c to `interrupt`; it shares the one hide action, and it is not a
	// footer hint because `esc` already announces that action (S13).
	{ id: "interrupt", label: "ctrl+c", action: "hide", help: "hide", hint: false },
];

/** The action a key identifier carries, or undefined when the card does not bind it. */
export function actionFor(id: string): KeyAction | undefined {
	return KEY_BINDINGS.find((binding) => binding.id === id)?.action;
}

/** The footer's hints (S13), one per action, in table order. */
export function footerHints(): readonly FooterHint[] {
	return KEY_BINDINGS.filter((binding) => binding.hint).map((binding) => ({
		key: binding.label,
		help: binding.help,
		action: binding.action,
	}));
}

/** What the shell must do (S8). Data only: the reducer asks, the shell acts. */
export type Effect =
	| { readonly kind: "load-folder"; readonly path: string }
	| { readonly kind: "play"; readonly trackId: string }
	| { readonly kind: "pause" }
	| { readonly kind: "resume" }
	| { readonly kind: "stop" }
	| { readonly kind: "volume"; readonly level: number }
	| { readonly kind: "quit" };

/**
 * Inputs: keys the card received, presence and focus changes owned by the host, and the facts the
 * I/O layer brings back. A result names the track it is about so a late report about a track that
 * already gave way cannot skip the wrong one.
 */
export type CardEvent =
	| { readonly kind: "key"; readonly id: string }
	/** The overlay shortcut (S15): toggles presence and works without the card's focus. */
	| { readonly kind: "overlay" }
	/**
	 * A transport shortcut registered with the host (S22): pause/resume, next or previous while the
	 * card may be hidden. It is a separate event because it is NOT a card key — see `transport`.
	 */
	| { readonly kind: "transport"; readonly action: TransportAction }
	/** A message that has to survive the toast: the footer keeps it until something else happens (S5). */
	| { readonly kind: "notice"; readonly text: string }
	/** A scan for this folder has started (S21): the footer says what the card is reading. */
	| { readonly kind: "folder-reading"; readonly path: string }
	/** `/sb-music` (S15): opens the card expanded. */
	| { readonly kind: "open" }
	| { readonly kind: "focus" }
	| { readonly kind: "blur" }
	| { readonly kind: "folder-loaded"; readonly path: string; readonly entries: readonly LibraryEntry[] }
	| { readonly kind: "track-ended"; readonly trackId: string }
	| { readonly kind: "track-failed"; readonly trackId: string }
	/** The session is shutting down (S6): the shell sends `quit` to mpv. */
	| { readonly kind: "quit" }
	| PointerEvent;

export interface ModelDeps {
	/**
	 * Randomness for shuffle (S11), injected so the reducer stays a function: same state, same event,
	 * same answer. The shell omits it and gets `Math.random`.
	 */
	readonly random?: () => number;
}

export interface Reduction {
	readonly state: CardState;
	readonly effects: readonly Effect[];
}

export function initialState(config: CardConfig): CardState {
	return {
		libraryRoot: config.libraryRoot,
		ceiling: config.ceiling,
		path: config.libraryRoot,
		entries: [],
		cursor: 0,
		presence: "hidden",
		size: "corner",
		focused: false,
		paused: false,
		volume: DEFAULT_VOLUME,
		shuffle: false,
		filter: "",
		filtering: false,
	};
}

/**
 * The rows the card shows (S3): the folder's listing narrowed by the active filter term (S18). Both
 * the cursor and the view read the listing through here, so there is one answer to "what is on
 * screen" and no second copy to keep in sync.
 */
export function visibleEntries(state: CardState): readonly LibraryEntry[] {
	const term = state.filter.toLowerCase();
	if (term === "") return state.entries;
	return state.entries.filter((entry) => rowName(entry).toLowerCase().includes(term));
}

/** What a row is called on screen, which is what the filter matches: never the path behind it. */
function rowName(entry: LibraryEntry): string {
	return entry.kind === "folder" ? entry.folder.name : entry.track.title;
}

/** The row under the cursor, if the listing has one. */
export function selectedEntry(state: CardState): LibraryEntry | undefined {
	return visibleEntries(state)[state.cursor];
}

export function reduce(state: CardState, event: CardEvent, deps: ModelDeps = {}): Reduction {
	switch (event.kind) {
		case "key":
			// The keyboard takes over from the pointer (S17): a highlight marks what a click would hit,
			// and a key is not a click, so the row stops being marked as soon as the user types.
			return pressKey(forgetHover(state), event.id, deps);
		case "notice":
			// The failure owns the footer alone: a read that ended badly is not still reading (S21).
			return { state: { ...state, notice: event.text, reading: undefined }, effects: [] };
		case "folder-reading":
			return { state: { ...state, reading: event.path }, effects: [] };
		case "overlay":
			return { state: state.presence === "visible" ? hidden(state) : shown(state, "corner"), effects: [] };
		case "transport":
			return transport(state, event.action);
		case "open":
			return { state: shown(state, "expanded"), effects: [] };
		case "focus":
			// A hidden card cannot hold the keyboard, so focus on nothing is not a state.
			return {
				state: state.presence === "visible" && !state.focused ? { ...state, focused: true } : state,
				effects: [],
			};
		case "blur":
			// An input nobody can type into is dead chrome: losing the keyboard ends the mode, not the term.
			return {
				state: state.focused || state.filtering ? { ...state, focused: false, filtering: false } : state,
				effects: [],
			};
		case "folder-loaded":
			// The filter is scoped to one folder (S18): another listing arrives unfiltered. The highlight
			// goes with it, because its index meant a row of the listing that just went away (S17).
			return {
				state: {
					...state,
					path: event.path,
					entries: event.entries,
					cursor: 0,
					filter: "",
					filtering: false,
					hover: undefined,
					notice: undefined,
					reading: undefined,
				},
				effects: [],
			};
		case "track-ended":
			if (state.playing?.id !== event.trackId) return unchanged(state);
			return advance(state);
		case "track-failed":
			if (state.playing?.id !== event.trackId) return unchanged(state);
			return advance(state, cannotOpen(state.playing.title));
		case "hover":
			return hoverRow(state, event.index);
		case "click":
			return clickRow(state, event.index, deps);
		case "wheel":
			return wheelRows(state, event.delta);
		case "quit":
			return { state, effects: [{ kind: "quit" }] };
	}
}

/** Notices the card prints in its footer (S11, S14). Copy lives here so it cannot drift per view. */
const AT_HOME = "at home";
const PLAYLIST_ENDED = "playlist ended";
const SHUFFLE_ON = "shuffle on";
const SHUFFLE_OFF = "shuffle off";

function cannotOpen(title: string): string {
	return `${title}: cannot open, skipping`;
}

function unchanged(state: CardState): Reduction {
	return { state, effects: [] };
}

/** Hiding forgets the size, the keyboard and the filter: a hidden card is in none of those states (S15, S18). */
function hidden(state: CardState): CardState {
	return {
		...state,
		presence: "hidden",
		size: "corner",
		focused: false,
		filter: "",
		filtering: false,
		hover: undefined,
	};
}

/** Showing always lands in the corner, even when the card was hidden expanded (S15). */
function shown(state: CardState, size: CardSize): CardState {
	return { ...state, presence: "visible", size };
}

function pressKey(state: CardState, id: string, deps: ModelDeps): Reduction {
	// Keys only reach a card that is on screen; the host routes them, and this is the model's guard.
	if (state.presence !== "visible") return unchanged(state);
	// The innermost mode takes the keyboard first (S18): while filtering, keys are text, not transport.
	if (state.filtering) return filterKey(state, id);

	const action = actionFor(id);
	if (!action) return unchanged(state);

	switch (action) {
		case "cursor-up":
			return moveCursor(state, -1);
		case "cursor-down":
			return moveCursor(state, 1);
		case "activate":
			return activate(state, deps);
		case "folder-up":
			return folderUp(state);
		case "hide":
			return clearFilterOrHide(state);
		case "start-filter":
			return startFilter(state);
		case "toggle-pause":
			return togglePause(state);
		case "stop":
			return stop(state);
		case "next":
			return advance(state);
		case "previous":
			return previous(state);
		case "volume-up":
			return setVolume(state, state.volume + VOLUME_STEP);
		case "volume-down":
			return setVolume(state, state.volume - VOLUME_STEP);
		case "toggle-shuffle":
			return toggleShuffle(state, deps);
	}
}

/**
 * A transport shortcut registered with the host (S22). It deliberately does NOT go through
 * `pressKey`: that guard — "keys only reach a card that is on screen" — is exactly right for a card
 * key, because nobody is looking at a hidden card, and exactly wrong here, because the shortcut is
 * registered with Pi and arrives with the card hidden. That is its whole job. What it does share is
 * the actions themselves (`togglePause`, `advance`, `previous`), so there is one playback path and
 * the effects still come out as data for the shell to execute (S8).
 */
function transport(state: CardState, action: TransportAction): Reduction {
	switch (action) {
		case "toggle-pause":
			return togglePause(state);
		case "next":
			return advance(state);
		case "previous":
			return previous(state);
	}
}

function moveCursor(state: CardState, delta: number): Reduction {
	const rows = visibleEntries(state);
	if (rows.length === 0) return unchanged(state);

	const cursor = Math.min(rows.length - 1, Math.max(0, state.cursor + delta));
	return cursor === state.cursor ? unchanged(state) : { state: { ...state, cursor }, effects: [] };
}

/* --- the pointer (S17) ----------------------------------------------------------------------- */

/** The keyboard owns the cursor (S17): after a key, the pointer marks nothing until it moves again. */
function forgetHover(state: CardState): CardState {
	return state.hover === undefined ? state : { ...state, hover: undefined };
}

/**
 * The highlight under the pointer (S17). It is a row of the listing, so a row that is no longer there
 * cannot be highlighted: the host may point at a row the card has never seen, and that is a hover off
 * the rows, not an out-of-range selection.
 */
function hoverRow(state: CardState, index: number | undefined): Reduction {
	if (state.presence !== "visible") return unchanged(state);
	const hover = index !== undefined && visibleEntries(state)[index] !== undefined ? index : undefined;
	return hover === state.hover ? unchanged(state) : { state: { ...state, hover }, effects: [] };
}

/**
 * A click selects before it activates (S17), which is exactly the pair the keyboard does with a cursor
 * move plus `enter`: one reduction, so a folder opens and a track plays with the same rules as ever
 * (S11), queue included.
 */
function clickRow(state: CardState, index: number, deps: ModelDeps): Reduction {
	if (state.presence !== "visible") return unchanged(state);
	if (visibleEntries(state)[index] === undefined) return unchanged(state);
	return activate({ ...state, cursor: index }, deps);
}

/**
 * The wheel walks the listing exactly like the arrows do (S17), and never past either end. The
 * highlight is dropped on the way: the wheel moves the rows under a pointer that did not move, so the
 * row the highlight named is no longer the row under it.
 */
function wheelRows(state: CardState, delta: number): Reduction {
	if (state.presence !== "visible") return unchanged(state);
	if (!Number.isFinite(delta)) return unchanged(state);
	return moveCursor(forgetHover(state), Math.trunc(delta));
}

/* --- the filter over the current folder (S18) ------------------------------------------------ */

/** `/` opens the filter over the folder on screen (S18). */
function startFilter(state: CardState): Reduction {
	return { state: { ...state, filtering: true }, effects: [] };
}

/**
 * The keyboard belongs to the input while the mode is on (S18). `enter` confirms, `esc` resolves the
 * innermost mode, `backspace` edits the term instead of navigating, and the arrows still walk the
 * narrowed listing. Everything else that is a character is typed; the transport keys wait.
 */
function filterKey(state: CardState, id: string): Reduction {
	switch (id) {
		case "enter":
			// Confirming keeps the term and puts the cursor on the first result (S18).
			return { state: { ...state, filtering: false, cursor: 0 }, effects: [] };
		case "escape":
			return clearFilterOrHide(state);
		case "backspace":
			return setFilter(state, dropLastCharacter(state.filter));
		case "space":
			return setFilter(state, `${state.filter} `);
		case "up":
			return moveCursor(state, -1);
		case "down":
			return moveCursor(state, 1);
		case "/":
			// The key that opened the mode is the mode's own key: it never becomes part of the term.
			return unchanged(state);
	}

	const typed = typedCharacter(id);
	return typed === undefined ? unchanged(state) : setFilter(state, state.filter + typed);
}

/** One printable character, or undefined for a key name the terminal sends as a word (`home`, `f1`). */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}]/u;

function typedCharacter(id: string): string | undefined {
	const characters = [...id];
	if (characters.length !== 1) return undefined;
	return UNPRINTABLE.test(id) ? undefined : id;
}

/** Set the term and keep the cursor inside whatever the listing is now (S18). */
function setFilter(state: CardState, filter: string): Reduction {
	const rows = visibleEntries({ ...state, filter }).length;
	const cursor = Math.min(state.cursor, Math.max(0, rows - 1));
	return { state: { ...state, filter, cursor }, effects: [] };
}

/** Backspace edits code points, never half a surrogate pair. */
function dropLastCharacter(text: string): string {
	return [...text].slice(0, -1).join("");
}

/**
 * `esc` resolves the innermost thing first (S13, S18): a filter term is cleared before the card
 * hides, whether or not the mode is still open, and clearing ends the mode. With nothing to clear
 * there is nothing left to resolve, so the card hides.
 */
function clearFilterOrHide(state: CardState): Reduction {
	if (state.filter !== "") return { state: { ...state, filter: "", filtering: false }, effects: [] };
	return { state: hidden(state), effects: [] };
}

function activate(state: CardState, deps: ModelDeps): Reduction {
	const entry = selectedEntry(state);
	if (!entry) return unchanged(state);
	if (entry.kind === "folder") return loadFolder(state, entry.folder.path);
	return playFrom(state, entry.track, deps);
}

/**
 * Ask for a folder and move the card there at once (S14): the rows arrive with the scan result, so
 * the breadcrumb follows the key instead of the round trip. Playback is untouched (S11), and the
 * filter does not travel to a folder it was never typed in (S18).
 */
function loadFolder(state: CardState, path: string): Reduction {
	return {
		state: { ...state, path, entries: [], cursor: 0, filter: "", filtering: false, notice: undefined },
		effects: [{ kind: "load-folder", path }],
	};
}

/** `enter` on a track (S11): the whole folder becomes the queue, in folder order, from this track. */
function playFrom(state: CardState, track: Track, deps: ModelDeps): Reduction {
	const tracks = state.entries.flatMap((entry) => (entry.kind === "track" ? [entry.track] : []));
	const position = tracks.findIndex((candidate) => candidate.id === track.id);
	if (position < 0) return unchanged(state);

	const playOrder = state.shuffle ? shuffleFrom(tracks, position, deps) : tracks;
	return {
		state: { ...state, playing: track, paused: false, queue: { tracks, playOrder, position }, notice: undefined },
		effects: [{ kind: "play", trackId: track.id }],
	};
}

/**
 * The one way a track gives way to the next (S11): auto-advance, `n` and a file that cannot be
 * opened all come through here, so a broken file cannot cut the album and the last track cannot
 * loop. `notice` replaces the footer's message, which is how a failure survives the skip.
 */
function advance(state: CardState, notice?: string): Reduction {
	const queue = state.queue;
	if (!queue) return unchanged(state);

	const position = queue.position + 1;
	const track = queue.playOrder[position];
	if (!track) {
		return {
			state: { ...state, playing: undefined, paused: false, queue: undefined, notice: notice ?? PLAYLIST_ENDED },
			effects: [{ kind: "stop" }],
		};
	}

	return {
		state: { ...state, playing: track, paused: false, queue: { ...queue, position }, notice },
		effects: [{ kind: "play", trackId: track.id }],
	};
}

function previous(state: CardState): Reduction {
	const queue = state.queue;
	if (!queue || !state.playing) return unchanged(state);

	const position = queue.position - 1;
	const track = queue.playOrder[position];
	if (!track) return unchanged(state);

	return {
		state: { ...state, playing: track, paused: false, queue: { ...queue, position }, notice: undefined },
		effects: [{ kind: "play", trackId: track.id }],
	};
}

function togglePause(state: CardState): Reduction {
	if (!state.playing) return unchanged(state);
	if (state.paused) return { state: { ...state, paused: false, notice: undefined }, effects: [{ kind: "resume" }] };
	return { state: { ...state, paused: true, notice: undefined }, effects: [{ kind: "pause" }] };
}

/** Stop cuts the sound and empties the queue (S11): there is nothing left to advance into. */
function stop(state: CardState): Reduction {
	if (!state.playing && !state.queue) return unchanged(state);
	return {
		state: { ...state, playing: undefined, paused: false, queue: undefined, notice: undefined },
		effects: [{ kind: "stop" }],
	};
}

function setVolume(state: CardState, level: number): Reduction {
	const volume = Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, level));
	if (volume === state.volume) return unchanged(state);
	return { state: { ...state, volume }, effects: [{ kind: "volume", level: volume }] };
}

/**
 * Shuffle over the remaining queue only (S11): the track that is playing keeps playing and the
 * cursor stays where the user left it. Turning it off puts the part that has not played yet back
 * into folder order.
 */
function toggleShuffle(state: CardState, deps: ModelDeps): Reduction {
	const shuffle = !state.shuffle;
	const notice = shuffle ? SHUFFLE_ON : SHUFFLE_OFF;
	const queue = state.queue;
	if (!queue) return { state: { ...state, shuffle, notice }, effects: [] };

	const playOrder = shuffle ? shuffleFrom(queue.playOrder, queue.position, deps) : inFolderOrder(queue);
	return { state: { ...state, shuffle, queue: { ...queue, playOrder }, notice }, effects: [] };
}

/** Fisher–Yates over what has not played yet (S11): the prefix and the position never move. */
function shuffleFrom(order: readonly Track[], position: number, deps: ModelDeps): readonly Track[] {
	const random = deps.random ?? Math.random;
	const shuffled = [...order];

	for (let index = shuffled.length - 1; index > position; index--) {
		const target = position + 1 + Math.floor(random() * (index - position));
		swapTracks(shuffled, index, target);
	}
	return shuffled;
}

/** Undo shuffle (S11): what has not played yet returns to the order the folder gave it. */
function inFolderOrder(queue: Queue): readonly Track[] {
	const rank = new Map(queue.tracks.map((track, index) => [track.id, index]));
	const played = queue.playOrder.slice(0, queue.position + 1);
	const left = queue.playOrder
		.slice(queue.position + 1)
		.toSorted((first, second) => (rank.get(first.id) ?? 0) - (rank.get(second.id) ?? 0));
	return [...played, ...left];
}

function swapTracks(tracks: Track[], left: number, right: number): void {
	const leftTrack = tracks[left];
	const rightTrack = tracks[right];
	if (!leftTrack || !rightTrack) return;
	tracks[left] = rightTrack;
	tracks[right] = leftTrack;
}

/** `u` and backspace (S14): up one folder, never above the ceiling, which arrived as an input. */
function folderUp(state: CardState): Reduction {
	if (state.path === state.ceiling) return { state: { ...state, notice: AT_HOME }, effects: [] };

	const parent = parentOf(state.path);
	if (!parent) return { state: { ...state, notice: AT_HOME }, effects: [] };
	return loadFolder(state, parent);
}

/**
 * The folder above this one, in the flavour the path already speaks (S19): every path the card
 * holds is canonical and absolute, so `/…` is POSIX and a drive or UNC path is Win32. Pure string
 * arithmetic from `node:path`; no filesystem, and both flavours are testable from one host.
 */
function parentOf(path: string): string | undefined {
	const flavour = posix.isAbsolute(path) ? posix : win32;
	const parent = flavour.dirname(path);
	return parent === path ? undefined : parent;
}
