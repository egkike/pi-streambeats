/**
 * The overlay component (S3, S4, S8). It is a thin shell around `renderFrame`: render for a width,
 * translate input for the model, and cache by the state/width/height tuple. The host is faked, so
 * the test verifies the seam without a terminal.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	type CardState,
	currentView,
	initialState,
	type PointerEvent,
	reduce,
	type SourceView,
} from "../../lib/core/model.ts";
import { renderFrame, type ViewOptions } from "../../lib/core/view.ts";
import { createCardComponent, overlayHeight } from "../../lib/host/component.ts";
import type { LibraryEntry, Track, ViewTheme } from "../../lib/types.ts";

const ROOT = "/home/kike/Music";
const ALBUM = `${ROOT}/StreamBeats/Chillhop`;

const plain: ViewTheme = { fg: () => "", bg: () => "", bgEnd: () => "", bold: (text) => text, dim: (text) => text };

/** A theme whose weight is visible in the string, which is how a hover can be asserted. */
const weighted: ViewTheme = { ...plain, bold: (text) => `[b]${text}[/b]` };

const BLUE: Track = {
	id: `${ALBUM}/01 - Blue Hour.mp3`,
	title: "01 - Blue Hour.mp3",
	origin: "local",
	durationMs: 245_000,
};

const entries: readonly LibraryEntry[] = [
	{ kind: "folder", folder: { path: `${ALBUM}/Extras`, name: "Extras" } },
	{ kind: "track", track: BLUE },
];

/**
 * The card showing the local album: the three listing fields travel flat and land on the library's own
 * view, because the card is two sources now and the row tests are about the local one (S20).
 */
function card(overrides: Partial<CardState> & Partial<SourceView> = {}): CardState {
	const { path = ALBUM, entries: rows = entries, cursor = 0, ...rest } = overrides;
	const base = initialState({ libraryRoot: ROOT, ceiling: "/home/kike" });
	return {
		...base,
		presence: "visible",
		size: "expanded",
		...rest,
		source: "library",
		sources: { ...base.sources, library: { path, entries: rows, cursor } },
	};
}

const options: ViewOptions = { libraryRoot: ROOT, elapsedMs: 47_000 };

describe("the overlay component (S3)", () => {
	it("renders exactly the frame the core returns for the current state", () => {
		const state = card();
		const component = createCardComponent({
			state: () => state,
			theme: () => plain,
			options: () => options,
			height: () => 8,
			onKey: () => {},
		});

		assert.deepEqual(component.render(90), renderFrame(state, plain, 90, 8, options).lines);
	});

	it("renders nothing while the card is hidden (S15)", () => {
		const state = card({ presence: "hidden" });
		const component = createCardComponent({
			state: () => state,
			theme: () => plain,
			options: () => options,
			height: () => 8,
			onKey: () => {},
		});

		assert.deepEqual(component.render(90), []);
	});
});

describe("the overlay component's input (S13)", () => {
	it("translates raw terminal input into the model's key identifiers", () => {
		const keys: string[] = [];
		const component = createCardComponent({
			state: () => card(),
			theme: () => plain,
			options: () => options,
			height: () => 8,
			onKey: (id) => keys.push(id),
		});

		component.handleInput?.("j");
		component.handleInput?.("\x1b[B");
		component.handleInput?.("\r");
		component.handleInput?.("x");

		assert.deepEqual(keys, ["j", "down", "enter", "x"]);
	});

	it("does not ask the model to act on an unbound sequence", () => {
		const keys: string[] = [];
		const component = createCardComponent({
			state: () => card(),
			theme: () => plain,
			options: () => options,
			height: () => 8,
			onKey: (id) => keys.push(id),
		});

		component.handleInput?.("\x1b[Z");

		assert.deepEqual(keys, []);
	});
});

describe("the frame height the host gives the component (S15)", () => {
	it("uses two rows for the corner and a clamped window for the expanded list", () => {
		assert.equal(overlayHeight("corner", 24), 2);
		// The expanded card pays two rows for its own frame (issue #36) and grows for them instead of
		// squeezing the list.
		assert.equal(overlayHeight("expanded", 24), 20);
		// ...but it never asks for more rows than the terminal has (R3-001): on a five-row screen the
		// seven-row floor would put the overlay outside the screen.
		assert.equal(overlayHeight("expanded", 8), 7, "eight rows is the smallest framed card");
		assert.equal(overlayHeight("expanded", 6), 6);
		assert.equal(overlayHeight("expanded", 5), 5);
		assert.equal(overlayHeight("expanded", 100), 30);
	});
	it("misses the cache when only the clock moved (R4-001)", () => {
		let elapsed = 0;
		const state = card();
		const component = createCardComponent({
			state: () => state,
			theme: () => plain,
			options: () => ({ ...options, elapsedMs: elapsed }),
			height: () => 8,
			onKey: () => {},
		});

		const first = component.render(90);
		assert.strictEqual(component.render(90), first, "same state and same clock reuse the cached lines");

		elapsed = 5_000;
		assert.notStrictEqual(component.render(90), first, "a tick that only advances the clock re-renders");
	});
	it("closes itself on escape and ctrl-c, whatever the model does with them", () => {
		let dismissed = 0;
		let keys = 0;
		const component = createCardComponent({
			state: () => card(),
			theme: () => plain,
			options: () => options,
			height: () => 8,
			onKey: () => {
				keys += 1;
			},
			dismiss: () => {
				dismissed += 1;
			},
		});

		component.handleInput?.("\u001b");
		assert.equal(dismissed, 1, "a lone escape always closes");
		assert.equal(keys, 0, "and the model is not asked to interpret it");

		component.handleInput?.("\u0003");
		assert.equal(dismissed, 2, "ctrl-c is the terminal's panic button and also closes");
	});

	it("closes on the ctrl-c a Kitty-encoding terminal sends, which is not the raw byte (L49)", () => {
		let dismissed = 0;
		const keys: string[] = [];
		const component = createCardComponent({
			state: () => card(),
			theme: () => plain,
			options: () => options,
			height: () => 8,
			onKey: (id) => keys.push(id),
			dismiss: () => {
				dismissed += 1;
			},
		});

		// Pi negotiates the Kitty keyboard protocol, so ctrl-c arrives as CSI-u on a terminal that
		// answers it. Comparing the chunk to the raw byte made the key vanish with the card still on
		// screen (L49): the host asks `matchesKey`, which knows every encoding the terminal may send.
		component.handleInput?.("\u001b[99;5u");

		assert.equal(dismissed, 1, "the CSI-u ctrl-c closes the card too");
		assert.deepEqual(keys, [], "and it is never handed to the model as a key");
	});
});

describe("the overlay component's cache (S3, S8)", () => {
	it("reuses the cached lines until the state or the width changes", () => {
		let state = card();
		const component = createCardComponent({
			state: () => state,
			theme: () => plain,
			options: () => options,
			height: () => 8,
			onKey: () => {},
		});

		const first = component.render(90);
		const again = component.render(90);
		state = card({ cursor: 1 });
		const changed = component.render(90);

		assert.equal(first, again);
		assert.notEqual(changed, first);
	});

	it("drops the cache when the host invalidates it", () => {
		const component = createCardComponent({
			state: () => card(),
			theme: () => plain,
			options: () => options,
			height: () => 8,
			onKey: () => {},
		});

		const first = component.render(90);
		component.invalidate();
		const second = component.render(90);

		assert.notEqual(second, first);
		assert.deepEqual(second, first);
	});
});

/**
 * A normalized mouse event as the host hands it to a component: `x`/`y` are local to the component,
 * so `y` is a line index of the frame this component returned (pi-tui `TuiMouseEvent`). `screenX`/
 * `screenY` exist to prove the component never reads them for a hit.
 */
function mouse(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type: "move",
		button: "none",
		x: 2,
		y: 0,
		screenX: 2,
		screenY: 14,
		width: 90,
		height: 8,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	};
}

/** A component wired the way the host wires it: the model is reduced synchronously by the callback. */
function interactive(
	start: CardState,
	theme: ViewTheme = plain,
): { component: Component; seen: PointerEvent[]; state: () => CardState } {
	let state = start;
	const seen: PointerEvent[] = [];
	const component = createCardComponent({
		state: () => state,
		theme: () => theme,
		options: () => options,
		height: () => 8,
		onKey: () => {},
		onPointer: (event) => {
			seen.push(event);
			state = reduce(state, event).state;
		},
	});
	return { component, seen, state: () => state };
}

/** The line the frame puts a given row on, straight from the render's own hit map. */
function rowLine(state: CardState, name: string): number {
	const frame = renderFrame(state, plain, 90, 8, options);
	const hit = [...frame.hits].find(([, row]) =>
		row.entry.kind === "folder" ? row.entry.folder.name === name : row.entry.track.title === name,
	);
	assert.ok(hit, `${name} is on screen`);
	return hit[0];
}

describe("the overlay component's pointer (S17)", () => {
	it("resolves a click from the line the host reports, never from the cursor or the screen", () => {
		const { component, seen, state } = interactive(card({ cursor: 0 }));
		const line = rowLine(card({ cursor: 0 }), BLUE.title);

		component.render(90);
		component.handleMouse?.(mouse({ type: "press", button: "left", y: line }));
		component.handleMouse?.(mouse({ type: "click", button: "left", y: line, screenY: 999 }));

		// Row 1 of the listing, resolved from the frame's hit map: the cursor sat on the folder, and the
		// screen coordinate was nonsense on purpose.
		assert.deepEqual(seen, [{ kind: "click", index: 1 }]);
		assert.equal(currentView(state()).cursor, 1);
		assert.equal(state().playing?.id, BLUE.id);
	});

	it("accepts the press, because the host only delivers the click it synthesizes to a handler", () => {
		const { component } = interactive(card());
		const line = rowLine(card(), BLUE.title);

		component.render(90);

		assert.equal(component.handleMouse?.(mouse({ type: "press", button: "left", y: line }))?.handled, true);
		assert.equal(
			component.handleMouse?.(mouse({ type: "press", button: "left", y: 1 })),
			undefined,
			"the header is not a row and takes no press",
		);
	});

	it("reports the row under a moving pointer and repaints only when the row changes", () => {
		const { component, seen, state } = interactive(card());
		const line = rowLine(card(), BLUE.title);

		component.render(90);
		const first = component.handleMouse?.(mouse({ y: line }));
		const again = component.handleMouse?.(mouse({ y: line }));

		assert.deepEqual(seen[0], { kind: "hover", index: 1 }, "the model is asked with a row, not a coordinate");
		assert.equal(state().hover, 1);
		assert.equal(first?.render, true, "a new row is a new frame");
		assert.equal(again?.render, false, "the same row is not");
	});

	it("clears the highlight when the pointer leaves the rows", () => {
		const { component, seen, state } = interactive(card());
		const line = rowLine(card(), BLUE.title);

		component.render(90);
		component.handleMouse?.(mouse({ y: line }));
		assert.equal(state().hover, 1);

		component.handleMouse?.(mouse({ y: 1 }));

		assert.deepEqual(seen.at(-1), { kind: "hover", index: undefined });
		assert.equal(state().hover, undefined);
	});

	it("scrolls one row per wheel notch, in the direction of the wheel", () => {
		const { component, seen, state } = interactive(card());

		component.render(90);
		component.handleMouse?.(mouse({ type: "wheel", wheelDelta: -3 }));
		assert.deepEqual(seen.at(-1), { kind: "wheel", delta: -1 });
		assert.equal(currentView(state()).cursor, 0, "an upward notch at the first row stays there");

		component.handleMouse?.(mouse({ type: "wheel", wheelDelta: 4 }));
		assert.deepEqual(seen.at(-1), { kind: "wheel", delta: 1 });
		assert.equal(currentView(state()).cursor, 1);
	});

	it("consumes a repeated click, so a folder that just opened cannot receive the second one", () => {
		const { component, seen } = interactive(card());
		const line = rowLine(card(), "Extras");

		component.render(90);
		component.handleMouse?.(mouse({ type: "press", button: "left", y: line }));
		const second = component.handleMouse?.(mouse({ type: "click", button: "left", y: line, clickCount: 2 }));

		assert.equal(second?.handled, true, "the host's repeat is answered, not left to fall through");
		assert.deepEqual(seen, [], "and it never reaches the model");
	});

	it("ignores the pointer entirely on the corner card, which has no rows to hit (S15)", () => {
		const { component, seen } = interactive(card({ size: "corner", playing: BLUE }));
		component.render(46);

		assert.equal(component.handleMouse?.(mouse({ type: "press", button: "left", y: 0 })), undefined);
		assert.equal(component.handleMouse?.(mouse({ type: "click", button: "left", y: 0 })), undefined);
		assert.equal(component.handleMouse?.(mouse({ type: "wheel", wheelDelta: 1, y: 0 })), undefined);
		assert.deepEqual(seen, []);
	});

	it("repaints when only the highlight changed, because the cache follows the state", () => {
		const { component } = interactive(card({ cursor: 0 }), weighted);
		const line = rowLine(card({ cursor: 0 }), BLUE.title);

		const before = component.render(90);
		component.handleMouse?.(mouse({ y: line }));
		const after = component.render(90);

		assert.notEqual(after, before, "a hover is a new state and therefore a new frame");
		assert.match(after[line] ?? "", /\[b\]/);
	});
});

describe("the frame a pointer is resolved against (T24)", () => {
	it("ignores a pointer event that arrives after the model changed and before the next frame", () => {
		// `hits` describes the listing the host is painting. If the model already moved on (a click
		// entered a folder, a key reloaded a listing) the map answers for rows that are no longer in
		// the state, and the same index means a different entry. The screen is stale, so the stale
		// frame decides nothing; the next render brings a new map.
		let state = card();
		const seen: PointerEvent[] = [];
		const component = createCardComponent({
			state: () => state,
			theme: () => plain,
			options: () => options,
			height: () => 8,
			onKey: () => {},
			onPointer: (event) => seen.push(event),
		});

		component.render(90);
		const line = rowLine(state, BLUE.title);
		state = reduce(state, { kind: "folder-loaded", path: `${ROOT}/Other`, entries: [] }).state;

		assert.equal(
			component.handleMouse?.(mouse({ type: "click", button: "left", y: line })),
			undefined,
			"a frame of the previous listing cannot be resolved against the new one",
		);
		assert.deepEqual(seen, [], "and nothing is handed to the model");

		component.render(90);
		component.handleMouse?.(mouse({ type: "click", button: "left", y: line }));
		assert.deepEqual(seen, [], "the new listing is empty, so that line has no row either");
	});

	it("stays live while the rows stay put: a highlight does not make the frame stale", () => {
		// The narrowing is the point (T24): only what MOVES the rows invalidates the map. Hovering
		// changes the state without moving anything, so the next gesture on the same frame must still
		// resolve -- otherwise the pointer would answer one event per repaint.
		const { component, seen, state } = interactive(card());
		component.render(90);
		const line = rowLine(card(), BLUE.title);

		component.handleMouse?.(mouse({ type: "move", y: line }));
		component.handleMouse?.(mouse({ type: "click", button: "left", y: line }));

		assert.deepEqual(
			seen.map((event) => event.kind),
			["hover", "click"],
			"the click resolves even though the hover already changed the state",
		);
		assert.equal(state().playing?.id, BLUE.id);
	});

	it("decides whether a row was hit once, before the repeat-click rule", () => {
		const { component, seen } = interactive(card());
		component.render(90);
		const line = rowLine(card(), BLUE.title);

		// No row on that line: the answer is "not mine", never "handled".
		assert.equal(
			component.handleMouse?.(mouse({ type: "click", button: "left", y: 99 })),
			undefined,
			"a click that hit no row is not handled",
		);
		assert.deepEqual(seen, []);

		// A repeat click on a painted row is answered so the host stops, and never reduced twice.
		assert.deepEqual(component.handleMouse?.(mouse({ type: "click", button: "left", y: line, clickCount: 2 })), {
			handled: true,
			render: false,
		});
		assert.deepEqual(seen, [], "the hit map is consulted before the repeat rule, and the repeat decodes to nothing");
	});
});

describe("the pointer trace (S17)", () => {
	it("reports every dispatched pointer event before deciding anything, so an absent line means it never arrived", () => {
		// Mouse input exists only in Pi's fullscreen TUI. When the card ignores a click, the difference
		// between "the host never sent it" and "we dropped it" lives in this trace and nowhere else.
		const seen: string[] = [];
		const component = createCardComponent({
			state: () => card(),
			theme: () => plain,
			options: () => options,
			height: () => 8,
			onKey: () => {},
			tracePointer: (event) => seen.push(`${event.type}:${event.y}`),
		});

		component.render(90);
		component.handleMouse?.(mouse({ type: "move", y: 1 }));
		component.handleMouse?.(mouse({ type: "wheel", y: 1, wheelDelta: -1 }));

		assert.deepEqual(seen, ["move:1", "wheel:1"], "every event is traced, including the ones the card ignores");
	});

	it("does not trace when no trace was given", () => {
		const component = createCardComponent({
			state: () => card(),
			theme: () => plain,
			options: () => options,
			height: () => 8,
			onKey: () => {},
		});

		component.render(90);
		assert.doesNotThrow(() => component.handleMouse?.(mouse({ type: "move", y: 1 })));
	});
});
