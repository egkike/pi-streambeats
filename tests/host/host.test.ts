/**
 * The host adapter (S1, S4, S8, S12). Pi is faked at the `ExtensionAPI` seam: the test drives the
 * registered command and shortcut, the overlay factory, the component's input and the player's
 * reports, and observes only what the adapter hands back to the host. No terminal, no mpv, no disk.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { registerSbMusic, STATUS_KEY } from "../../lib/host/host.ts";
import type { ScanResult } from "../../lib/library/scan.ts";
import type { Player, PlayerReport } from "../../lib/player/mpv.ts";
import type { Settings } from "../../lib/settings.ts";
import type { LibraryEntry } from "../../lib/types.ts";

const HOME = "/home/kike";
const ROOT = `${HOME}/Music`;
const ALBUM = `${ROOT}/StreamBeats/Chillhop`;

const ENTRIES: readonly LibraryEntry[] = [
	{ kind: "folder", folder: { path: `${ALBUM}/Extras`, name: "Extras" } },
	{
		kind: "track",
		track: {
			id: `${ALBUM}/01 - Arcade Dreams.mp3`,
			title: "01 - Arcade Dreams.mp3",
			origin: "local",
			durationMs: 222_000,
		},
	},
	{
		kind: "track",
		track: { id: `${ALBUM}/02 - Blue Hour.mp3`, title: "02 - Blue Hour.mp3", origin: "local", durationMs: 245_000 },
	},
];

const SETTINGS: Settings = {
	libraryRoot: ROOT,
	shortcuts: { overlay: "ctrl+alt+m", playPause: "ctrl+alt+space", next: "ctrl+alt+n", prev: "ctrl+alt+p" },
	asciiGlyphs: false,
};

const EDITOR: Component = { render: () => [], invalidate: () => {} };

const THEME = {
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
	bold: (text: string) => text,
} as unknown as Theme;

interface HandleCalls {
	readonly hidden: boolean[];
	readonly unfocus: (Component | null | undefined)[];
	focus: number;
	hide: number;
}

interface OverlayCall {
	readonly component: Component;
	readonly handle: OverlayHandle & { calls: HandleCalls };
	readonly editor: Component | null;
	readonly overlay: boolean | undefined;
	readonly overlayOptions: { nonCapturing?: boolean } | undefined;
}

interface Harness {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionCommandContext;
	readonly commands: Map<
		string,
		{ description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
	>;
	readonly shortcuts: Map<string, { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }>;
	readonly handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>;
	readonly statuses: [string, string | undefined][];
	readonly notices: [string, string | undefined][];
	readonly overlays: OverlayCall[];
	readonly player: Player;
	readonly playerCalls: string[];
	readonly scanCalls: string[];
	readonly report: (report: PlayerReport) => void;
	readonly tick: () => void;
	readonly closed: () => number;
	readonly renders: () => number;
	readonly now: { value: number };
}

function fakePlayer(): {
	player: Player;
	calls: string[];
} {
	const calls: string[] = [];
	return {
		calls,
		player: {
			start: async () => {},
			// The host does not query mpv for anything: the total arrives as a player report (S12).
			command: async () => ({ error: "success" }),
			play: async (track) => {
				calls.push(`play:${track.id}`);
			},
			pause: async () => {
				calls.push("pause");
			},
			resume: async () => {
				calls.push("resume");
			},
			stop: async () => {
				calls.push("stop");
			},
			setVolume: async (level) => {
				calls.push(`volume:${level}`);
			},
			quit: async () => {
				calls.push("quit");
			},
		},
	};
}

function fakeHandle(): OverlayHandle & { calls: HandleCalls } {
	const calls: HandleCalls = { hidden: [], unfocus: [], focus: 0, hide: 0 };
	let hidden = false;
	return {
		calls,
		hide: () => {
			calls.hide += 1;
		},
		setHidden: (value) => {
			hidden = value;
			calls.hidden.push(value);
		},
		isHidden: () => hidden,
		focus: () => {
			calls.focus += 1;
		},
		unfocus: (options) => {
			calls.unfocus.push(options?.target);
		},
		isFocused: () => calls.focus > 0,
		getBounds: () => undefined,
	};
}

/** Overlay creation is serialized behind a promise: let the chain run before asserting. */
async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness(editor: Component | null = EDITOR): Harness {
	const commands = new Map<
		string,
		{ description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
	>();
	const shortcuts = new Map<
		string,
		{ description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void }
	>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
	const statuses: [string, string | undefined][] = [];
	const notices: [string, string | undefined][] = [];
	const overlays: OverlayCall[] = [];
	const scanCalls: string[] = [];
	const now = { value: 1_000 };
	const reportHandler: (report: PlayerReport) => void = () => {};
	let tickFn: (() => void) | undefined;
	let closedCount = 0;
	let renderCount = 0;

	const tui = {
		getFocusedComponent: () => editor,
		requestRender: () => {
			renderCount += 1;
		},
		terminal: { rows: 24, columns: 120 },
	} as unknown as TUI;

	const ui = {
		theme: THEME,
		setStatus: (key: string, text: string | undefined) => {
			statuses.push([key, text]);
		},
		notify: (message: string, type?: string) => {
			notices.push([message, type]);
		},
		custom: (
			factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: unknown) => void) => Component,
			options?: {
				overlay?: boolean;
				overlayOptions?: { nonCapturing?: boolean } | (() => { nonCapturing?: boolean });
				onHandle?: (handle: OverlayHandle) => void;
			},
		) => {
			// The real `custom` returns a promise that settles when `done()` is called; a fake that
			// never settles would make every later overlay wait forever.
			let finishOverlay!: (value: unknown) => void;
			const settled = new Promise<unknown>((resolve) => {
				finishOverlay = resolve;
			});
			const component = factory(tui, THEME, {}, (value) => {
				closedCount += 1;
				finishOverlay(value);
			});
			const overlayOptions =
				typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
			const handle = fakeHandle();
			overlays.push({
				component,
				handle,
				editor,
				overlay: options?.overlay,
				overlayOptions,
			});
			options?.onHandle?.(handle);
			return settled;
		},
	} as unknown as ExtensionUIContext;

	const ctx = {
		ui,
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		shutdown: () => {},
	} as ExtensionCommandContext;

	const { player, calls: playerCalls } = fakePlayer();

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) => {
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand: (
			name: string,
			options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			commands.set(name, options);
		},
		registerShortcut: (
			key: string,
			options: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void },
		) => {
			shortcuts.set(key, options);
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		ctx,
		commands,
		shortcuts,
		handlers,
		statuses,
		notices,
		overlays,
		player,
		playerCalls,
		scanCalls,
		report: (report) => reportHandler(report),
		tick: () => tickFn?.(),
		closed: () => closedCount,
		renders: () => renderCount,
		now,
	};
}

function register(
	h: Harness,
	scan: (path: string) => ScanResult = (path) => ({ ok: true, path, entries: ENTRIES }),
): void {
	registerSbMusic(h.pi, {
		settings: SETTINGS,
		ceiling: HOME,
		scan: (path) => {
			h.scanCalls.push(path);
			return scan(path);
		},
		createPlayer: (report) => {
			// The harness needs the callback, so it is captured here and used by `report`.
			Object.assign(h, { report });
			return h.player;
		},
		now: () => h.now.value,
		tick: (fn) => {
			// The adapter starts one ticker per session; the harness invokes it by hand.
			Object.assign(h, { tick: () => fn() });
			return () => {};
		},
		statusWidth: 80,
	});
}

/** The adapter registers the report callback through `createPlayer`; wire it into the harness. */
function playerReport(h: Harness, report: PlayerReport): void {
	h.report(report);
}

async function start(h: Harness): Promise<void> {
	await h.handlers.get("session_start")?.(undefined, h.ctx);
}

async function open(h: Harness): Promise<void> {
	await h.commands.get("sb-music")?.handler("", h.ctx);
}

function lastStatus(h: Harness): string | undefined {
	return h.statuses.at(-1)?.[1];
}

describe("extension registration (S1)", () => {
	it("registers /sb-music and the overlay shortcut from settings", () => {
		const h = harness();
		register(h);

		assert.ok(h.commands.has("sb-music"));
		assert.ok(h.shortcuts.has("ctrl+alt+m"));
		assert.ok(h.handlers.has("session_start"));
		assert.ok(h.handlers.has("session_shutdown"));
	});
});

describe("the session life cycle (S4, S8)", () => {
	it("creates the player only on session_start and opens nothing by itself", async () => {
		const h = harness();
		register(h);
		await start(h);

		assert.deepEqual(h.statuses.at(-1), [STATUS_KEY, undefined]);
		assert.deepEqual(h.overlays, []);
	});

	it("shuts the player down, closes the overlay and clears the status", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);

		await h.handlers.get("session_shutdown")?.(undefined, h.ctx);

		assert.ok(h.playerCalls.includes("quit"));
		assert.equal(h.closed(), 1);
		assert.deepEqual(h.statuses.at(-1), [STATUS_KEY, undefined]);
	});
});

describe("the /sb-music command (S1, S4)", () => {
	it("answers clearly in a mode that cannot host an overlay", async () => {
		const h = harness();
		register(h);
		const printCtx = { ...h.ctx, mode: "print", hasUI: false } as ExtensionCommandContext;

		await h.commands.get("sb-music")?.handler("", printCtx);

		assert.equal(h.notices.length, 1);
		assert.match(h.notices[0]?.[0] ?? "", /interactive/i);
		assert.deepEqual(h.overlays, []);
	});

	it("opens the card expanded, focused, and releasable to the editor", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);

		const call = h.overlays[0];
		assert.equal(h.overlays.length, 1);
		assert.equal(call?.overlay, true);
		assert.equal(call?.overlayOptions?.nonCapturing, true);
		assert.equal(call?.handle.calls.unfocus[0], EDITOR);
		// The command focuses the card so its keys reach it; `esc` then closes it and `done()` hands
		// the keyboard back to Pi's own pre-focus.
		assert.ok((call?.handle.calls.focus ?? 0) >= 1);
		assert.deepEqual(h.scanCalls, [ROOT]);
		assert.match(call?.component.render(90)[0] ?? "", /sb-music/);
	});

	it("never takes the keyboard even when no editor can be captured (S4)", async () => {
		// The first smoke showed the cost of the old fallback: a modal card that released focus to
		// `null` left the terminal with no keyboard at all. Non-capturing is unconditional now.
		const h = harness(null);
		register(h);
		await start(h);
		await open(h);

		const call = h.overlays[0];
		assert.equal(call?.overlayOptions?.nonCapturing, true);
		// It still focuses, because a card that cannot receive `esc` is a card you cannot close; the
		// difference is that nothing is released to `null`: `done()` restores Pi's own pre-focus.
		assert.ok((call?.handle.calls.focus ?? 0) >= 1);
		assert.deepEqual(call?.handle.calls.unfocus, [], "nothing known was taken, so nothing is handed back");
	});
});

it("rebuilds the overlay when the cycle changes the size (S15)", async () => {
	// An overlay keeps the geometry it was created with, so reaching the corner from an expanded card
	// has to build a new one. With the cycle (L38) that path is expanded -> hidden -> corner.
	const h = harness();
	register(h);
	await start(h);
	await open(h);
	await flush();
	assert.equal(h.overlays.length, 1);

	await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
	await flush();
	await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
	await flush();

	assert.equal(h.overlays.length, 2, "a new overlay was built for the other size");
	assert.equal(
		h.overlays[1]?.overlayOptions?.nonCapturing,
		true,
		"the rebuilt corner does not grab the keyboard either",
	);
});

it("dismissing with escape leaves the model hidden, so the shortcut can show it again (R4-001)", async () => {
	// Closing the overlay behind the model's back left `presence` on "visible": the next shortcut
	// press then "hid" nothing and the card looked dead.
	const h = harness();
	register(h);
	await start(h);
	await open(h);
	await flush();
	assert.equal(h.overlays.length, 1);

	h.overlays[0]?.component.handleInput?.("\u001b");
	await flush();

	await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
	await flush();

	assert.equal(h.overlays.length, 2, "the first press after an escape shows the card again");
});

describe("the overlay shortcut cycles the three states (S4, S15)", () => {
	it("cycles hidden -> corner -> expanded -> hidden, and only the expanded card wants the keys", async () => {
		// One command, because the size was reachable only with the keyboard the corner never holds
		// (L38): collapsing handed the keys back and the old `l` could not be pressed again.
		const h = harness();
		register(h);
		await start(h);
		const press = async (): Promise<void> => {
			await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
			await flush();
		};

		await press();
		assert.equal(h.overlays.length, 1);
		assert.equal(h.overlays[0]?.handle.calls.focus, 0, "the corner is a passive readout");

		await press();
		assert.equal(h.overlays.length, 2, "expanding builds a fresh overlay for the new geometry");
		assert.ok((h.overlays[1]?.handle.calls.focus ?? 0) >= 1, "the expanded card takes the keyboard");

		// Hiding finishes the overlay instead of parking it hidden: a parked handle never came back
		// in the real smoke, and finishing is the documented exit from `custom`.
		await press();
		assert.equal(h.closed(), 2, "expanding and hiding both finished their overlay");

		await press();
		assert.equal(h.overlays.length, 3, "the cycle restarts at the corner");
		assert.equal(h.overlays[2]?.handle.calls.focus, 0);
	});
});

describe("key routing and the status line (S12, S13)", () => {
	it("plays the selected track and names it in the status line", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		component?.handleInput?.("j");
		component?.handleInput?.("j");
		component?.handleInput?.("\r");

		assert.ok(h.playerCalls.includes(`play:${ALBUM}/02 - Blue Hour.mp3`));
		assert.equal(h.overlays[0]?.handle.calls.unfocus.at(-1), EDITOR);
		assert.equal(lastStatus(h), "● Blue Hour · Chillhop 0:00/4:05");
	});

	it("freezes the time while paused and keeps the hollow glyph", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		component?.handleInput?.("j");
		component?.handleInput?.("\r");
		h.now.value = 5_000;
		component?.handleInput?.(" ");
		const paused = lastStatus(h);

		h.now.value = 9_000;
		h.tick();

		assert.equal(paused, "○ Arcade Dreams · Chillhop 0:04/3:42");
		assert.equal(lastStatus(h), paused);
	});

	it("clears the music segment on stop", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		component?.handleInput?.("j");
		component?.handleInput?.("\r");
		component?.handleInput?.("s");

		assert.ok(h.playerCalls.includes("stop"));
		assert.deepEqual(h.statuses.at(-1), [STATUS_KEY, undefined]);
	});
});

/**
 * The total belongs to the player: `Track.durationMs` is metadata the scanner never produces (S5 reads
 * names, not tags), so without the total the card cannot draw the progress S15 asks for nor the
 * `m:ss/m:ss` S12 asks for. These entries deliberately carry no duration.
 */
const NO_METADATA: readonly LibraryEntry[] = [
	{ kind: "folder", folder: { path: `${ALBUM}/Extras`, name: "Extras" } },
	{ kind: "track", track: { id: `${ALBUM}/01 - Arcade Dreams.mp3`, title: "01 - Arcade Dreams.mp3", origin: "local" } },
	{ kind: "track", track: { id: `${ALBUM}/02 - Blue Hour.mp3`, title: "02 - Blue Hour.mp3", origin: "local" } },
];

/** The identity the player reports the total for: the same path the model uses as `Track.id` (S7). */
const ARCADE = `${ALBUM}/01 - Arcade Dreams.mp3`;
const BLUE = `${ALBUM}/02 - Blue Hour.mp3`;

describe("the total duration comes from the player (S12, S15)", () => {
	it("prints the total the player reports in the status line", async () => {
		const h = harness();
		register(h, (path) => ({ ok: true, path, entries: NO_METADATA }));
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		component?.handleInput?.("j");
		component?.handleInput?.("j");
		component?.handleInput?.("\r");
		playerReport(h, { kind: "duration", trackId: BLUE, durationMs: 245_400 });

		assert.equal(lastStatus(h), "● Blue Hour · Chillhop 0:00/4:05");
	});

	it("draws the progress bar in the corner once the total is reported", async () => {
		const h = harness();
		register(h, (path) => ({ ok: true, path, entries: NO_METADATA }));
		await start(h);
		await open(h);
		h.overlays[0]?.component.handleInput?.("j");
		h.overlays[0]?.component.handleInput?.("j");
		h.overlays[0]?.component.handleInput?.("\r");
		playerReport(h, { kind: "duration", trackId: BLUE, durationMs: 245_000 });
		await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
		await flush();
		await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
		await flush();

		const frame = h.overlays.at(-1)?.component.render(46).join("\n") ?? "";

		assert.match(frame, /0:00 \/ 4:05/);
		// The bar's head and track (S16): the corner draws it only when the total is known.
		assert.match(frame, /╸─/);
	});

	it("keeps the unknown-total fallback until the player reports a total", async () => {
		const h = harness();
		register(h, (path) => ({ ok: true, path, entries: NO_METADATA }));
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		component?.handleInput?.("j");
		component?.handleInput?.("j");
		component?.handleInput?.("\r");

		assert.equal(lastStatus(h), "● Blue Hour · Chillhop 0:00/--:--");
	});

	it("ignores a total reported for another track", async () => {
		const h = harness();
		register(h, (path) => ({ ok: true, path, entries: NO_METADATA }));
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		component?.handleInput?.("j");
		component?.handleInput?.("\r");
		component?.handleInput?.("n");
		// The total of the track that was playing before: it must not become the new track's total.
		playerReport(h, { kind: "duration", trackId: ARCADE, durationMs: 222_000 });

		assert.equal(lastStatus(h), "● Blue Hour · Chillhop 0:00/--:--");
	});

	it("keeps the reported total across pause and resume", async () => {
		const h = harness();
		register(h, (path) => ({ ok: true, path, entries: NO_METADATA }));
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		component?.handleInput?.("j");
		component?.handleInput?.("j");
		component?.handleInput?.("\r");
		playerReport(h, { kind: "duration", trackId: BLUE, durationMs: 245_000 });
		component?.handleInput?.(" ");
		component?.handleInput?.(" ");

		assert.equal(lastStatus(h), "● Blue Hour · Chillhop 0:00/4:05");
	});
});

describe("player reports (S11, S12)", () => {
	it("advances the queue and updates the title when a track ends", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		component?.handleInput?.("j");
		component?.handleInput?.("\r");
		playerReport(h, { kind: "ended", trackId: `${ALBUM}/01 - Arcade Dreams.mp3` });

		assert.ok(h.playerCalls.includes(`play:${ALBUM}/02 - Blue Hour.mp3`));
		assert.equal(lastStatus(h), "● Blue Hour · Chillhop 0:00/4:05");
	});

	it("drops the segment when the last track of the queue ends", async () => {
		const h = harness();
		const single = ENTRIES.slice(1, 2);
		register(h, (path) => ({ ok: true, path, entries: single }));
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		component?.handleInput?.("\r");
		playerReport(h, { kind: "ended", trackId: `${ALBUM}/01 - Arcade Dreams.mp3` });

		assert.deepEqual(h.statuses.at(-1), [STATUS_KEY, undefined]);
		assert.equal(component?.render(90).join("\n").includes("playlist ended"), true);
	});
});

describe("the card's state is owned by the model (S8)", () => {
	it("loads the current folder through the injected scanner when the card opens", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);

		// The scanner received the configured root, not the process's working directory.
		assert.deepEqual(h.scanCalls, [ROOT]);
	});

	it("turns an activate effect on a folder into a scan and a folder-loaded event", async () => {
		const h = harness();
		register(h, (path) =>
			path.endsWith("Extras") ? { ok: true, path, entries: [] } : { ok: true, path, entries: ENTRIES },
		);
		await start(h);
		await open(h);

		h.overlays[0]?.component.handleInput?.("\r");

		assert.deepEqual(h.scanCalls, [ROOT, `${ALBUM}/Extras`]);
	});
});
