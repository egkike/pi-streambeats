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
import type { Component, OverlayHandle, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
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

/** The resolved file `--keys` prints (S22); a fake path, like everything else the adapter receives. */
const SETTINGS_FILE = `${HOME}/.config/pi-streambeats/settings.json`;

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
	readonly overlayOptions: { nonCapturing?: boolean; width?: unknown; minWidth?: number } | undefined;
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
	/** Every `setWidget` call, in order: the multi-line surface `--keys` prints into (S22). */
	readonly widgets: [string, string[] | undefined][];
	/** Every settings object the adapter asked to write (S22). */
	readonly saved: Settings[];
	readonly overlays: OverlayCall[];
	readonly player: Player;
	readonly playerCalls: string[];
	/** How many players the adapter built: the session is the only thing that creates one (S6). */
	readonly created: { players: number };
	readonly scanCalls: string[];
	/** Knobs a test sets before `register` runs, for the paths that only start from a broken file. */
	readonly options: { warning?: string };
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
	const widgets: [string, string[] | undefined][] = [];
	const saved: Settings[] = [];
	const overlays: OverlayCall[] = [];
	const scanCalls: string[] = [];
	const created = { players: 0 };
	const now = { value: 1_000 };
	const options: { warning?: string } = {};
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
		setWidget: (key: string, content: string[] | undefined) => {
			widgets.push([key, content]);
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
		widgets,
		saved,
		overlays,
		player,
		playerCalls,
		created,
		scanCalls,
		options,
		report: (report) => reportHandler(report),
		tick: () => tickFn?.(),
		closed: () => closedCount,
		renders: () => renderCount,
		now,
	};
}

function register(
	h: Harness,
	scan: (path: string) => ScanResult | Promise<ScanResult> = (path) => ({ ok: true, path, entries: ENTRIES }),
	terminalColumns?: () => number,
): void {
	registerSbMusic(h.pi, {
		settings: SETTINGS,
		ceiling: HOME,
		settingsFile: SETTINGS_FILE,
		warning: h.options.warning,
		saveSettings: (next) => {
			h.saved.push(next);
			return { ok: true };
		},
		scan: (path) => {
			h.scanCalls.push(path);
			return Promise.resolve(scan(path));
		},
		createPlayer: (report) => {
			// The harness needs the callback, so it is captured here and used by `report`.
			Object.assign(h, { report });
			h.created.players += 1;
			return h.player;
		},
		now: () => h.now.value,
		tick: (fn) => {
			// The adapter starts one ticker per session; the harness invokes it by hand.
			Object.assign(h, { tick: () => fn() });
			return () => {};
		},
		statusWidth: 80,
		terminalColumns,
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
		// The frame's first line is the card's top border now (issue #36): the header is the line under it.
		const frame = call?.component.render(90) ?? [];
		assert.match(frame[0] ?? "", /^┌─+┐$/);
		assert.match(frame[1] ?? "", /sb-music/);
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
	// Something has to be PLAYING for the cycle to pass through the corner at all (S15, L39), so the
	// seed drives the cursor to the second track and plays it: `j j` then `enter`.
	h.overlays[0]?.component.handleInput?.("j");
	h.overlays[0]?.component.handleInput?.("j");
	h.overlays[0]?.component.handleInput?.("\r");
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
	it("opens the list directly when nothing is playing, and hides on the next press (S15)", async () => {
		// The corner is a readout of what plays (S12, S15). With silence it would show `nothing playing`
		// and make the first press useless, so the cycle starts at the list instead.
		const h = harness();
		register(h);
		await start(h);
		const press = async (): Promise<void> => {
			await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
			await flush();
		};

		await press();
		assert.equal(h.overlays.length, 1);
		assert.ok((h.overlays[0]?.handle.calls.focus ?? 0) >= 1, "the list is the state that takes the keys");

		await press();
		assert.equal(h.closed(), 1, "hiding finishes the overlay instead of parking it hidden");
	});

	it("cycles hidden -> corner -> expanded -> hidden while a track plays (S4, S15)", async () => {
		// One command, because the size was reachable only with the keyboard the corner never holds
		// (L38): collapsing handed the keys back and the old `l` could not be pressed again.
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;
		// Silence skips the corner, so a track must be playing for this test to see the corner state.
		component?.handleInput?.("j");
		component?.handleInput?.("j");
		component?.handleInput?.("\r");
		await flush();
		const press = async (): Promise<void> => {
			await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
			await flush();
		};

		await press();
		assert.equal(h.closed(), 1, "the expanded card hides");

		await press();
		assert.equal(h.overlays.length, 2, "with something playing the cycle reads the corner first");
		assert.equal(h.overlays[1]?.handle.calls.focus, 0, "the corner is a passive readout");

		await press();
		assert.equal(h.overlays.length, 3, "expanding builds a fresh overlay for the new geometry");
		assert.ok((h.overlays[2]?.handle.calls.focus ?? 0) >= 1, "the expanded card takes the keyboard");

		await press();
		assert.equal(h.closed(), 3, "the third press hides again");
	});
});

describe("the transport shortcuts are registered and alive (S22)", () => {
	it("registers the overlay and the three transport keys", () => {
		const h = harness();
		register(h);

		assert.deepEqual([...h.shortcuts.keys()], ["ctrl+alt+m", "ctrl+alt+space", "ctrl+alt+n", "ctrl+alt+p"]);
	});

	it("tells the truth about the command and the cycle (S22 requirement 8)", () => {
		// The command keeps opening the card, but the cycle key is what rescues the user who has no
		// card on screen; and the overlay shortcut cycles three states, it does not show and hide.
		const h = harness();
		register(h);

		assert.equal(h.commands.get("sb-music")?.description, "Open the music card · ctrl+alt+m cycles it");
		assert.match(h.shortcuts.get("ctrl+alt+m")?.description ?? "", /hidden → corner → expanded/);
		assert.equal(h.shortcuts.get("ctrl+alt+space")?.description, "Music card: pause or resume");
		assert.equal(h.shortcuts.get("ctrl+alt+n")?.description, "Music card: next track");
		assert.equal(h.shortcuts.get("ctrl+alt+p")?.description, "Music card: previous track");
	});

	it("starts the session on a transport key pressed before the card ever opened", async () => {
		// No `session_start` and no `/sb-music`: the shortcut has to build the model, the player and mpv
		// itself, or the key would answer to a session that does not exist yet.
		const h = harness();
		register(h);

		await h.shortcuts.get("ctrl+alt+n")?.handler(h.ctx);
		await flush();

		assert.equal(h.created.players, 1, "the session was built by the shortcut");
		assert.deepEqual(h.overlays, [], "and it did not open a card the user never asked for");
		assert.ok(h.statuses.length > 0, "the adapter has a session context to paint into");
	});

	it("pauses and resumes from the editor while the card is hidden", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;
		component?.handleInput?.("j");
		component?.handleInput?.("\r");
		component?.handleInput?.("\u001b");
		await flush();
		assert.equal(h.closed(), 1, "the card is hidden, not parked: this is the case that matters");

		await h.shortcuts.get("ctrl+alt+space")?.handler(h.ctx);
		assert.equal(h.playerCalls.at(-1), "pause");
		assert.equal(lastStatus(h), "○ Arcade Dreams · Chillhop 0:00/3:42");

		await h.shortcuts.get("ctrl+alt+space")?.handler(h.ctx);
		assert.equal(h.playerCalls.at(-1), "resume");
		assert.equal(h.overlays.length, 1, "a transport key never rebuilds the card");
	});

	it("plays the next and the previous track from the editor while the card is hidden", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;
		component?.handleInput?.("j");
		component?.handleInput?.("\r");
		component?.handleInput?.("\u001b");
		await flush();

		await h.shortcuts.get("ctrl+alt+n")?.handler(h.ctx);
		assert.equal(h.playerCalls.at(-1), `play:${ALBUM}/02 - Blue Hour.mp3`);
		assert.match(lastStatus(h) ?? "", /Blue Hour/);

		await h.shortcuts.get("ctrl+alt+p")?.handler(h.ctx);
		assert.equal(h.playerCalls.at(-1), `play:${ALBUM}/01 - Arcade Dreams.mp3`);
		assert.match(lastStatus(h) ?? "", /Arcade Dreams/);
	});

	it("ends the queue on the last track instead of wrapping around", async () => {
		// `next` from the editor is `advance`, not a second "skip": the same rule that stops at the end
		// of the queue (S11) applies, so the status bar goes quiet instead of looping the album.
		const h = harness();
		const last = ENTRIES.slice(2, 3);
		register(h, (path) => ({ ok: true, path, entries: last }));
		await start(h);
		await open(h);
		h.overlays[0]?.component.handleInput?.("j");
		h.overlays[0]?.component.handleInput?.("\r");
		h.overlays[0]?.component.handleInput?.("\u001b");
		await flush();

		await h.shortcuts.get("ctrl+alt+n")?.handler(h.ctx);

		assert.equal(h.playerCalls.at(-1), "stop");
		assert.deepEqual(h.statuses.at(-1), [STATUS_KEY, undefined]);
	});

	it("does nothing in a mode that cannot host the card", async () => {
		const h = harness();
		register(h);
		const printCtx = { ...h.ctx, mode: "print", hasUI: false } as ExtensionContext;

		for (const key of ["ctrl+alt+m", "ctrl+alt+space", "ctrl+alt+n", "ctrl+alt+p"]) {
			await h.shortcuts.get(key)?.handler(printCtx);
		}
		await flush();

		assert.equal(h.created.players, 0, "no session, no player");
		assert.deepEqual(h.overlays, []);
		assert.deepEqual(h.statuses, []);
	});
});

describe("/sb-music --keys reads and edits the keys (S22)", () => {
	/** The multi-line surface `--keys` prints into, reduced to its lines. */
	function report(h: Harness): string[] {
		const last = h.widgets.at(-1);
		assert.equal(last?.[0], "sb-music-keys", "the report goes to the multi-line widget surface");
		return last?.[1] ?? [];
	}

	it("prints the effective keys, the resolved file and the card's own keys, and opens nothing", async () => {
		const h = harness();
		register(h);

		await h.commands.get("sb-music")?.handler("--keys", h.ctx);

		const lines = report(h);
		const text = lines.join("\n");
		assert.equal(lines[0], `sb-music keys · ${SETTINGS_FILE}`);
		assert.match(text, /overlay\s+ctrl\+alt\+m .*cycle hidden → corner → expanded · registered/);
		assert.match(text, /playPause\s+ctrl\+alt\+space .*pause or resume · registered/);
		assert.match(text, /next\s+ctrl\+alt\+n .*next track · registered/);
		assert.match(text, /prev\s+ctrl\+alt\+p .*previous track · registered/);
		// The card's own keys come from the one table the footer renders (S13), not from a second list.
		assert.match(text, /inside the card · ↑ move · enter open · space pause/);
		assert.deepEqual(h.overlays, [], "reading opens no card");
		assert.equal(h.created.players, 0, "and builds no session");
		assert.deepEqual(h.saved, [], "reading writes nothing");
		// The host caps a string widget at ten lines and appends "… truncated"; this stays under it.
		assert.ok(lines.length <= 10, `the report is ${lines.length} lines, which the host would truncate`);
	});

	it("says the file could not be read, instead of presenting defaults as the keys (R3-001)", async () => {
		// The one moment a user asks "what keys do I have?" is exactly when a broken file is the reason
		// their change will not save. The save path already refuses; the read path used to stay silent,
		// so the table looked like the truth on disk while it was the loader's fallback (S2).
		const h = harness();
		h.options.warning = `${SETTINGS_FILE} is not valid JSON, using defaults`;
		register(h);

		await h.commands.get("sb-music")?.handler("--keys", h.ctx);

		const lines = report(h);
		const text = lines.join("\n");
		assert.match(text, /is not valid JSON/, "the loader's own warning is printed");
		assert.match(text, /defaults in memory/i, "and it says what the table is showing");
		assert.ok(lines.length <= 10, `the report is ${lines.length} lines, which the host would truncate`);
		assert.deepEqual(h.saved, [], "reading still writes nothing");
		assert.deepEqual(h.overlays, [], "and opens no card");
	});

	it("prints the syntax with --help", async () => {
		const h = harness();
		register(h);

		await h.commands.get("sb-music")?.handler("--help", h.ctx);

		const text = report(h).join("\n");
		assert.match(text, /\/sb-music\s+open the card/);
		assert.match(text, /\/sb-music --keys\s+print the keys in effect; writes nothing/);
		assert.match(text, /--keys overlay=<key>/);
		assert.match(text, /=default/);
		assert.match(text, /overlay\s+ctrl\+alt\+m/, "the table travels with the syntax");
		assert.deepEqual(h.overlays, []);
		assert.deepEqual(h.saved, []);
	});

	it("saves once with the expected settings and says where and when it applies", async () => {
		const h = harness();
		register(h);

		await h.commands.get("sb-music")?.handler("--keys overlay=ctrl+alt+k", h.ctx);

		assert.equal(h.saved.length, 1, "exactly one write");
		assert.deepEqual(h.saved[0]?.shortcuts, { ...SETTINGS.shortcuts, overlay: "ctrl+alt+k" });
		assert.equal(h.saved[0]?.libraryRoot, ROOT, "the rest of the settings travels with it");
		const text = report(h).join("\n");
		assert.match(text, /saved · .*settings\.json/, "the resolved path is printed");
		assert.match(text, /overlay\s+ctrl\+alt\+m → ctrl\+alt\+k/, "what changed is printed");
		assert.match(text, /next session/);
		assert.deepEqual(h.overlays, [], "editing keys never opens the card");

		// The card keeps the key it was bound to at session start, so a second read must not claim otherwise.
		await h.commands.get("sb-music")?.handler("--keys", h.ctx);
		assert.match(report(h).join("\n"), /overlay\s+ctrl\+alt\+m .*file ctrl\+alt\+k, next session/);
	});

	it("writes nothing when one pair is refused, and names the pair", async () => {
		const h = harness();
		register(h);

		await h.commands.get("sb-music")?.handler("--keys overlay=ctrl+alt+k next=j", h.ctx);

		assert.deepEqual(h.saved, [], "all or nothing");
		const text = report(h).join("\n");
		assert.match(text, /nothing written/);
		assert.match(text, /"next=j"/);
		assert.match(text, /modifier/);
	});

	it("prints instead of refusing in a mode that cannot host the card", async () => {
		const h = harness();
		register(h);
		const printCtx = { ...h.ctx, mode: "print", hasUI: false } as ExtensionCommandContext;

		await h.commands.get("sb-music")?.handler("--keys", printCtx);

		assert.deepEqual(h.widgets, [], "a mode without a UI has no widget to set");
		assert.equal(h.notices.length, 1);
		assert.match(h.notices[0]?.[0] ?? "", /overlay\s+ctrl\+alt\+m/);
		assert.match(h.notices[0]?.[0] ?? "", /inside the card/);
		assert.deepEqual(h.saved, []);
	});

	it("will not overwrite a settings file it could not read", async () => {
		// S2 leaves a broken file on disk untouched so the user can fix it; a save must not be the way
		// around that rule, or the text they were about to repair is gone.
		const h = harness();
		h.options.warning = "/home/kike/.config/pi-streambeats/settings.json is not valid JSON, using defaults";
		register(h);

		await h.commands.get("sb-music")?.handler("--keys", h.ctx);
		assert.deepEqual(h.saved, [], "reading never writes");

		await h.commands.get("sb-music")?.handler("--keys overlay=ctrl+alt+k", h.ctx);

		assert.deepEqual(h.saved, []);
		assert.match(report(h).join("\n"), /not valid JSON/);
	});

	it("refuses an argument it does not know instead of opening the card", async () => {
		const h = harness();
		register(h);

		await h.commands.get("sb-music")?.handler("--key", h.ctx);

		assert.deepEqual(h.overlays, [], "an unknown argument does not open the card");
		assert.match(report(h).join("\n"), /"--key" is not a \/sb-music argument/);
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

	it("comes back from the input path while the folder is still being read (S21)", async () => {
		// `scan` used to be synchronous by contract, so the read happened inside `handleInput` and `show()`.
		// A big folder or a network mount froze the editor; now the request leaves and the answer returns.
		const h = harness();
		const answers = new Map<string, (result: ScanResult) => void>();
		register(h, (path) =>
			path === ROOT
				? { ok: true, path, entries: ENTRIES }
				: new Promise<ScanResult>((resolve) => answers.set(path, resolve)),
		);
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		clickAt(component, lineOf(component, "Extras"));

		// The click already returned with the folder unread, so the card says so instead of painting an
		// empty folder -- which is exactly what a synchronous scan never had to say.
		assert.match(frameOf(h), /reading /);
		assert.equal(h.playerCalls.length, 0, "and the input path touched no playback");

		answers.get(`${ALBUM}/Extras`)?.({ ok: true, path: `${ALBUM}/Extras`, entries: [] });
		await flush();

		assert.doesNotMatch(frameOf(h), /reading /, "the footer goes back to the hints once the answer lands");
	});

	it("drops an answer for a folder the card already left (S21)", async () => {
		// With an asynchronous read two of them overlap, and the one that answers last is not necessarily
		// the one the card asked for last. Without a token the older read would paint over the newer one.
		const h = harness();
		const answers = new Map<string, (result: ScanResult) => void>();
		register(h, (path) =>
			path === ROOT
				? { ok: true, path, entries: ENTRIES }
				: new Promise<ScanResult>((resolve) => answers.set(path, resolve)),
		);
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		// Into `Extras`, then back up before it answers, then answer the stale one last.
		clickAt(component, lineOf(component, "Extras"));
		component?.handleInput?.("u");

		answers.get(ALBUM)?.({ ok: true, path: ALBUM, entries: [trackRow(ALBUM, "Kept.mp3")] });
		answers.get(`${ALBUM}/Extras`)?.({
			ok: true,
			path: `${ALBUM}/Extras`,
			entries: [trackRow(`${ALBUM}/Extras`, "Stale.mp3")],
		});
		await flush();

		assert.match(frameOf(h), /Kept/, "the card keeps the folder it asked for last");
		assert.doesNotMatch(frameOf(h), /Stale/, "and the folder it already left cannot paint over it");
	});

	it("does not ask the scanner twice for the folder it is already reading (S21)", async () => {
		const h = harness();
		register(h, () => new Promise<ScanResult>(() => {}));
		await start(h);
		await open(h);

		// Hide and show again while the first read is still in flight.
		await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
		await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
		await flush();

		assert.equal(h.scanCalls.length, 1, "one read, not one per show");
	});

	it("survives a scanner that throws instead of answering, and does not lock the folder (S21)", async () => {
		// The typed contract is a promise that never rejects, so a synchronous throw is a dep that lies.
		// It must not escape into the editor, and it must not leave the folder unreadable for the session.
		const h = harness();
		let calls = 0;
		register(h, (path) => {
			calls += 1;
			if (calls === 1) throw new Error("boom");
			return { ok: true, path, entries: ENTRIES };
		});
		await start(h);
		await open(h);
		await flush();

		assert.match(frameOf(h), /cannot show/, "the failure is said, not thrown at the editor");

		// Not locked: showing the card again asks the scanner again and the listing arrives.
		await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
		await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
		await flush();

		assert.equal(h.scanCalls.length, 2, "the folder is asked for again");
		assert.match(frameOf(h), /Arcade Dreams/, "and the listing lands");
	});
});

describe("the card never asks for more room than the terminal has (issue #42)", () => {
	it("clamps the expanded card's minimum width to the terminal it lives in", async () => {
		// A fixed `minWidth: 60` on a 40-column terminal built a card wider than its area, and the
		// terminal wrapped every line: that is what put the row's name on two lines in the host.
		const h = harness();
		register(h, undefined, () => 40);
		await start(h);
		await open(h);

		assert.equal(h.overlays[0]?.overlayOptions?.minWidth, 38, "two cells of margin, never more");
	});

	it("keeps the configured minimum when the terminal is wide enough", async () => {
		const h = harness();
		register(h, undefined, () => 120);
		await start(h);
		await open(h);

		assert.equal(h.overlays[0]?.overlayOptions?.minWidth, 60);
	});
});

describe("rows learn the duration the player reported (issue #42)", () => {
	it("fills a row from what the player said, even for a track that is not playing", async () => {
		// The scanner reads names, not tags: the player's answer is the only source. It used to be spent on
		// the status line and forgotten, so the row stayed `--:--` after the track had played.
		const h = harness();
		register(h);
		await start(h);
		await open(h);

		playerReport(h, { kind: "duration", trackId: `${ALBUM}/02 - Blue Hour.mp3`, durationMs: 245_000 });
		await flush();

		const frame = h.overlays[0]?.component.render(90).join("\n") ?? "";
		assert.match(frame, /4:05/, "the row shows what the player reported");
	});

	it("prints no placeholder when nothing is known yet", async () => {
		const h = harness();
		const unknown = ENTRIES.map((entry) =>
			entry.kind === "track" ? { kind: "track" as const, track: { ...entry.track, durationMs: undefined } } : entry,
		);
		register(h, (path) => ({ ok: true, path, entries: unknown }));
		await start(h);
		await open(h);

		const frame = h.overlays[0]?.component.render(90).join("\n") ?? "";
		assert.equal(frame.includes("--:--"), false, "a column of placeholders is dead chrome");
	});
});

describe("a folder that could not be read is a state, not a dead card (S5, T16)", () => {
	it("retries the scan on the next show instead of latching the failure", async () => {
		// The latch used to be set before the scan, so a missing or unreadable library left the card empty
		// for the whole session with a toast that had already faded. S5 wants a state with its path.
		const h = harness();
		let attempts = 0;
		register(h, (path) => {
			attempts += 1;
			return attempts === 1
				? { ok: false, path, failure: { kind: "missing", path } }
				: { ok: true, path, entries: ENTRIES };
		});
		await start(h);

		await open(h);
		await flush();
		assert.equal(h.scanCalls.length, 1, "the first show tried and failed");

		await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
		await flush();
		await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
		await flush();

		assert.equal(h.scanCalls.length, 2, "showing again asks the scanner again");
		const frame = h.overlays.at(-1)?.component.render(90).join("\n") ?? "";
		assert.match(frame, /Arcade Dreams/, "and the listing is there once the folder answers");
	});

	it("names the failure in the footer, with its path", async () => {
		const h = harness();
		register(h, (path) => ({ ok: false, path, failure: { kind: "missing", path } }));
		await start(h);
		await open(h);
		await flush();

		const frame = h.overlays.at(-1)?.component.render(90).join("\n") ?? "";
		assert.match(frame, /cannot show/, "the footer keeps saying what is wrong");
		assert.match(frame, /missing/, "and why, not just that something failed");
	});
});

describe("a player that rejects never escapes the adapter (T16)", () => {
	it("reports the failure and does not start a clock for a play that did not happen", async () => {
		// `void player.play(track)` left the rejection to Node's default policy: one throwing socket write
		// could take the session down, and the clock ticked for a track that never loaded.
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		h.player.play = async () => {
			throw new Error("socket is gone");
		};

		h.overlays[0]?.component.handleInput?.("j");
		h.overlays[0]?.component.handleInput?.("\r");
		await flush();

		assert.equal(
			h.notices.some(([message]) => /socket is gone/.test(message)),
			true,
			"the user is told, instead of the process dying",
		);
		assert.equal(lastStatus(h), undefined, "nothing is playing, so the status line says nothing");
	});
});

describe("the one-second tick only repaints when there is something to show (T16)", () => {
	it("does not force a frame when the card is hidden and nothing plays", async () => {
		// `refresh()` forced a full repaint every second for the whole session, even with the card hidden
		// and no music: the tick had nothing to update and paid for it anyway.
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		await flush();
		await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
		await flush();
		const before = h.renders();

		h.tick();
		h.tick();

		assert.equal(h.renders(), before, "a silent, hidden card costs nothing per second");
	});
});

/**
 * A normalized mouse event as Pi dispatches it to an overlay component: `y` is local to the card, so
 * it is a line index of the frame the card returned (pi-tui `TuiMouseEvent`).
 */
function mouseAt(y: number, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type: "move",
		button: "none",
		x: 4,
		y,
		screenX: 24,
		screenY: 20 + y,
		width: 90,
		height: 20,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	};
}

/** The line the card draws the named row on, asked of the card's own frame instead of geometry. */
function lineOf(component: Component | undefined, name: string): number {
	const lines = component?.render(90) ?? [];
	const index = lines.findIndex((line) => line.includes(name));
	assert.ok(index >= 0, `${name} is on the card`);
	return index;
}

/** The frame the newest overlay is drawing: the card is rebuilt on size changes, so never hold one. */
function frameOf(h: Harness): string {
	return h.overlays.at(-1)?.component.render(90).join("\n") ?? "";
}

/** One row of a listing, for a fake scan that has to be told apart from another folder's answer. */
function trackRow(dir: string, name: string): LibraryEntry {
	return { kind: "track", track: { id: `${dir}/${name}`, title: name, origin: "local" } };
}

/** One press-and-release on the same cell: what the host turns into the `click` the card reduces. */
function clickAt(component: Component | undefined, y: number): void {
	component?.handleMouse?.(mouseAt(y, { type: "press", button: "left" }));
	component?.handleMouse?.(mouseAt(y, { type: "click", button: "left" }));
}

describe("the mouse on the card (S17)", () => {
	it("enters the folder under the click", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		clickAt(component, lineOf(component, "Extras"));

		assert.equal(h.scanCalls.at(-1), `${ALBUM}/Extras`, "the click loaded the folder it landed on");
		assert.equal(h.playerCalls.length, 0, "and touched no playback");
	});

	it("plays the track under the click", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		clickAt(component, lineOf(component, "02 - Blue Hour.mp3"));

		assert.ok(h.playerCalls.includes(`play:${ALBUM}/02 - Blue Hour.mp3`));
	});

	it("walks the listing with the wheel", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;
		// The host only dispatches mouse events against a frame it has already painted, and the hit
		// map comes from that frame: the card is rendered first, exactly as the overlay does.
		component?.render(90);

		component?.handleMouse?.(mouseAt(0, { type: "wheel", wheelDelta: 1 }));

		const moved = component?.render(90)[lineOf(component, "01 - Arcade Dreams.mp3")] ?? "";
		assert.match(moved, /│ ▸ /, "the cursor went one row down the listing");
	});

	it("leaves the keyboard exactly where it was, whatever the pointer did", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		const component = h.overlays[0]?.component;

		// The pointer rests on the second track, and then the keyboard is driven as it always was.
		component?.handleMouse?.(mouseAt(lineOf(component, "02 - Blue Hour.mp3")));
		component?.handleInput?.("j");
		component?.handleInput?.("\r");

		assert.ok(h.playerCalls.includes(`play:${ALBUM}/01 - Arcade Dreams.mp3`), "enter plays what the cursor selects");
		assert.equal(
			h.playerCalls.some((call) => call.includes("Blue Hour")),
			false,
			"the row under the pointer was never activated by a key",
		);
	});

	it("ignores a click on the corner card, which is a passive readout with no rows (S15)", async () => {
		const h = harness();
		register(h);
		await start(h);
		await open(h);
		// The cycle only passes through the corner while something plays (S15, L39).
		h.overlays[0]?.component.handleInput?.("j");
		h.overlays[0]?.component.handleInput?.("\r");
		await flush();
		await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
		await flush();
		await h.shortcuts.get("ctrl+alt+m")?.handler(h.ctx);
		await flush();

		const corner = h.overlays[1]?.component;
		const scans = h.scanCalls.length;
		const plays = h.playerCalls.length;
		clickAt(corner, 0);

		assert.equal(h.overlays[1]?.handle.calls.focus, 0, "the corner still holds no keyboard");
		assert.equal(h.scanCalls.length, scans, "a click there loads nothing");
		assert.equal(h.playerCalls.length, plays, "and plays nothing");
	});
});
