/**
 * The component the host draws (S3, S4, S8). It owns no state and makes no decisions: it renders
 * the current model state for the width the host asks for, translates input back into key
 * identifiers, and caches the last frame so a redraw is not a recomputation.
 *
 * The frame's height is chosen here because Pi does not give a component a measure callback: the
 * array of lines a component returns is its height. The corner card is two rows (S15); the expanded
 * list gets the terminal's usable rows, clamped so a tiny terminal still shows a valid frame.
 */
import type { Component } from "@earendil-works/pi-tui";
import type { CardSize, CardState } from "../core/model.ts";
import { renderFrame, type ViewOptions } from "../core/view.ts";
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
}

/** The rows an expanded card asks for, leaving room for the editor and the footer. */
export function overlayHeight(size: CardSize, terminalRows: number): number {
	if (size === "corner") return 2;
	const rows = Number.isFinite(terminalRows) ? Math.floor(terminalRows) : 0;
	return Math.min(30, Math.max(4, rows - 6));
}

export function createCardComponent(deps: CardComponentDeps): Component {
	let cachedState: CardState | undefined;
	let cachedWidth = -1;
	let cachedHeight = -1;
	let cachedElapsed = Number.NaN;
	let cachedLines: string[] | undefined;

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
			return cachedLines;
		},
		handleInput(data: string): void {
			for (const id of translateKeys(data)) deps.onKey(id);
		},
		invalidate(): void {
			cachedState = undefined;
			cachedWidth = -1;
			cachedHeight = -1;
			cachedElapsed = Number.NaN;
			cachedLines = undefined;
		},
	};
}
