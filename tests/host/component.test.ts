/**
 * The overlay component (S3, S4, S8). It is a thin shell around `renderFrame`: render for a width,
 * translate input for the model, and cache by the state/width/height tuple. The host is faked, so
 * the test verifies the seam without a terminal.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CardState, initialState } from "../../lib/core/model.ts";
import { renderFrame, type ViewOptions } from "../../lib/core/view.ts";
import { createCardComponent, overlayHeight } from "../../lib/host/component.ts";
import type { LibraryEntry, ViewTheme } from "../../lib/types.ts";

const ROOT = "/home/kike/Music";
const ALBUM = `${ROOT}/StreamBeats/Chillhop`;

const plain: ViewTheme = { fg: () => "", bg: () => "", bgEnd: () => "", bold: (text) => text, dim: (text) => text };

const entries: readonly LibraryEntry[] = [
	{ kind: "folder", folder: { path: `${ALBUM}/Extras`, name: "Extras" } },
	{
		kind: "track",
		track: { id: `${ALBUM}/01 - Blue Hour.mp3`, title: "01 - Blue Hour.mp3", origin: "local", durationMs: 245_000 },
	},
];

function card(overrides: Partial<CardState> = {}): CardState {
	return {
		...initialState({ libraryRoot: ROOT, ceiling: "/home/kike" }),
		presence: "visible",
		size: "expanded",
		path: ALBUM,
		entries,
		...overrides,
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
		assert.equal(overlayHeight("expanded", 24), 18);
		assert.equal(overlayHeight("expanded", 5), 4);
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
