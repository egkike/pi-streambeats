/**
 * The component the host draws (S3, S4, S8). It owns no state and makes no decisions: it renders
 * the current model state for the width the host asks for, translates input back into key
 * identifiers, and caches the last frame so a redraw is not a recomputation.
 *
 * The frame's height is chosen here because Pi does not give a component a measure callback: the
 * array of lines a component returns is its height. The corner card is two rows (S15); the expanded
 * list gets the terminal's usable rows, clamped so a tiny terminal still shows a valid frame.
 */
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { CardSize, CardState, PointerEvent } from "../core/model.ts";
import { type HitMap, renderFrame, type ViewOptions } from "../core/view.ts";
import type { ViewTheme } from "../types.ts";
import { translateKeys } from "./keys.ts";

export interface CardComponentDeps {
	/** The current model state. Read on every render so the component never holds a stale copy. */
	readonly state: () => CardState;
	/** The role vocabulary, already translated from the host theme. */
	readonly theme: () => ViewTheme;
	/** What the renderer may read from the world: root, glyph family, elapsed time. */
	readonly options: () => ViewOptions;
	/** The frame height the host can afford. */
	readonly height: () => number;
	/** A translated key identifier; the host reduces it into the model. */
	readonly onKey: (id: string) => void;
	/**
	 * Pointer input already resolved to a row of the listing (S17). It is optional because a component
	 * with no model to reduce into has nothing to decide, and the corner never reports any.
	 */
	readonly onPointer?: (event: PointerEvent) => void;
	/**
	 * Close the surface without going through the model. Pi hands the component raw input, so this
	 * is the guaranteed exit: a key that the model mishandles must not leave a terminal with no
	 * keyboard (that is exactly what the first smoke produced).
	 */
	readonly dismiss?: () => void;
	/** Whether this chunk is the configured overlay shortcut; the card owns the keys while it is open. */
	readonly isOverlayKey?: (data: string) => boolean;
	/** Show or hide the card, the same thing the host's own shortcut handler does. */
	readonly togglePresence?: () => void;
	/**
	 * A trace of the raw chunk, when the host has tracing on. The card cannot be opened from a test
	 * or from CI, so this is the only way to learn what the terminal actually sent.
	 */
	readonly trace?: (data: string) => void;
	/**
	 * A trace of the pointer event as the host dispatched it, under the same flag. Mouse input exists
	 * only in Pi's fullscreen TUI, so "nothing happened" has two very different causes and the log is
	 * the only thing that tells them apart: no line means the event never arrived.
	 */
	readonly tracePointer?: (event: TuiMouseEvent) => void;
}

/** The rows an expanded card asks for, leaving room for the editor and the footer. */
/** Rows a framed card needs at minimum: both frame rows, header, rules, one list row, footer (S15). */
const FRAME_MIN_ROWS = 7;

export function overlayHeight(size: CardSize, terminalRows: number): number {
	if (size === "corner") return 2;
	const rows = Number.isFinite(terminalRows) ? Math.floor(terminalRows) : 0;
	// The expanded card spends two rows on its own frame (S15, issue #36). The card grows instead of
	// handing those cells to the list: it exists to be distinguishable from the background, so shrinking
	// its content to pay for the outline would defeat the point. The floor of 7 is what still fits a
	// frame, header, rules, one list row and a footer -- but it can never exceed the terminal, or the
	// overlay would be taller than the screen it lives in (R3-001).
	const wanted = Math.max(FRAME_MIN_ROWS, rows - 4);
	return Math.max(1, Math.min(30, rows, wanted));
}

export function createCardComponent(deps: CardComponentDeps): Component {
	let cachedState: CardState | undefined;
	let cachedWidth = -1;
	let cachedHeight = -1;
	let cachedElapsed = Number.NaN;
	let cachedLines: string[] | undefined;
	/**
	 * The click map of the frame that is on screen (S17): line index inside the overlay → the row it
	 * draws. It is the renderer's own answer, so no coordinate reaches the core and no geometry is
	 * re-derived here.
	 */
	let cachedHits: HitMap | undefined;
	/**
	 * What moves the rows of the cached frame (T24): the listing, the filter, the scroll the cursor
	 * implies and the size. `hits` is geometry of one particular arrangement of those, so once any of
	 * them changes the same line index names a different entry, and a hit resolved against the new
	 * state could activate a row nobody clicked. Everything else -- the playing track, the clock, the
	 * highlight itself -- leaves the rows where they are, and dropping those events would make the
	 * pointer go deaf for a frame every time it hovered.
	 */
	let paintedRows: readonly [CardState["entries"], string, number, CardSize] | undefined;

	return {
		render(width: number): string[] {
			const state = deps.state();
			const height = deps.height();
			const options = deps.options();
			// The clock is part of the frame: a tick that leaves the state untouched still changes
			// elapsedMs, and reusing the cached lines froze the time while a track played (R4-001).
			const elapsed = options.elapsedMs ?? 0;
			if (
				cachedLines &&
				cachedState === state &&
				cachedWidth === width &&
				cachedHeight === height &&
				cachedElapsed === elapsed
			) {
				return cachedLines;
			}

			const frame = renderFrame(state, deps.theme(), width, height, options);
			cachedState = state;
			cachedWidth = width;
			cachedHeight = height;
			cachedElapsed = elapsed;
			cachedLines = [...frame.lines];
			// Stored with the lines: a hit is only meaningful for the frame the host is painting.
			cachedHits = frame.hits;
			paintedRows = [state.entries, state.filter, state.cursor, state.size];
			return cachedLines;
		},
		handleInput(data: string): void {
			deps.trace?.(data);
			// Ctrl-C is the terminal's own panic button and ESC is the card's: either one always
			// closes, whatever the model decides to do with them. The question goes to the host, never
			// to a raw byte: Pi negotiates the Kitty keyboard protocol, and a terminal that answers with
			// it sends ctrl-c as CSI-u (`\u001b[99;5u`), so comparing the chunk to `\u0003` left the key
			// doing nothing at all with the card still on screen (L49).
			if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
				deps.dismiss?.();
				return;
			}
			// A focused overlay swallows the global shortcut, so the card answers it here.
			if (deps.isOverlayKey?.(data)) {
				deps.togglePresence?.();
				return;
			}
			for (const id of translateKeys(data)) deps.onKey(id);
		},
		invalidate(): void {
			cachedState = undefined;
			cachedWidth = -1;
			cachedHeight = -1;
			cachedElapsed = Number.NaN;
			cachedLines = undefined;
			cachedHits = undefined;
			paintedRows = undefined;
		},
		handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			deps.tracePointer?.(event);
			if (!deps.onPointer) return undefined;
			const state = deps.state();
			// Only the expanded card draws rows (S17): the corner is a passive readout with no list, no
			// hit zones and no keyboard, so a click there has nothing to mean. It is ignored on purpose
			// rather than given a rule S17 never wrote.
			if (state.size !== "expanded") return undefined;
			const hits = cachedHits;
			// No painted frame means no row on screen to point at: the host dispatches pointer events
			// against what it rendered, so this is the seam saying "nothing to hit yet".
			if (!hits) return undefined;
			// The hit map belongs to the rows the last render laid out, and the screen is only as fresh
			// as that render (T24): a frame of the previous listing cannot be resolved against a new one.
			const rows = paintedRows;
			if (
				!rows ||
				rows[0] !== state.entries ||
				rows[1] !== state.filter ||
				rows[2] !== state.cursor ||
				rows[3] !== state.size
			) {
				return undefined;
			}

			// `y` is local to this component, which is the line index of the frame it returned: the
			// overlay is positioned by the host and never by us, so screen coordinates are not read.
			const hit = hits.get(event.y);

			switch (event.type) {
				case "move": {
					// Hover (S17). Every row change is a new frame, and the frame is cached by state
					// identity, so the highlight is compared against the model instead of a local copy.
					const render = hit?.index !== deps.state().hover;
					deps.onPointer({ kind: "hover", index: hit?.index });
					return { handled: true, render };
				}
				case "press":
					// The host only hands the synthesized `click` to the component that handled the press
					// (pi-tui `handleMouseEvent`), so accepting it is what makes a click arrive at all.
					return hit ? { handled: true, render: false } : undefined;
				case "click":
					// One guard decides whether a row was hit; the repeat rule only applies after it (R3-002).
					// A click that landed on no row is not ours to answer.
					if (!hit) return undefined;
					// A repeat is the same click again, and by then the listing may already be another one
					// (a folder was entered): it is answered so the host stops, and never reduced twice.
					if ((event.clickCount ?? 1) > 1) return { handled: true, render: false };
					deps.onPointer({ kind: "click", index: hit.index });
					return { handled: true };
				case "wheel":
					// One notch, one row: the same step the arrows take, and the sign is the wheel's.
					deps.onPointer({ kind: "wheel", delta: (event.wheelDelta ?? 0) < 0 ? -1 : 1 });
					return { handled: true };
				default:
					// `release` and `drag` belong to the host's gesture bookkeeping, not to the card.
					return undefined;
			}
		},
	};
}
