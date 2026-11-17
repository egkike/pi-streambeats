/**
 * The host adapter (S1, S4, S8, S12). It is the only module that knows both halves: the pure model
 * and the Pi surface. Everything the model wants done comes back as effects, and every effect is
 * executed here — folder scans, the player, the overlay and the status line.
 *
 * The overlay is non-capturing on purpose (S4): it never steals the editor's keyboard by itself.
 * The editor is captured BEFORE the overlay is shown, and focus is released back to it. `/sb-music`
 * then focuses the card once so it can be navigated; the overlay shortcut only toggles presence,
 * which is why it works from the editor (S15). A track starting releases the keyboard again, so the
 * card stays visible while the user keeps typing.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeyId, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { type CardEvent, type CardSize, type CardState, type Effect, initialState, reduce } from "../core/model.ts";
import { statusSegment } from "../core/now-playing.ts";
import type { ScanResult } from "../library/scan.ts";
import type { Player, PlayerReport } from "../player/mpv.ts";
import type { Settings } from "../settings.ts";
import type { Track } from "../types.ts";
import { createCardComponent, overlayHeight } from "./component.ts";
import { matchesOverlayKey } from "./keys.ts";
import { toViewTheme } from "./theme.ts";

/** The single status key. Pi sorts statuses by key, so a stable one keeps the line in place. */
export const STATUS_KEY = "sb-music";

/** The widest a status segment may be: the host's footer panel is narrower than the terminal. */
const STATUS_MAX_WIDTH = 44;

/** The artboard's corner card is 46 cells wide (S15). */
const CORNER_WIDTH = 46;

/** The narrowest the expanded card is allowed to be; the terminal still gets the last word (issue #42). */
const EXPANDED_MIN_WIDTH = 60;

/** The overlay's own margin, in cells on each side. */
const OVERLAY_MARGIN = 1;

/** Everything the adapter needs from the process, injected so tests never touch mpv or disk. */
export interface SbMusicDeps {
	readonly settings: Settings;
	/** The highest folder `u` may reach (S14), resolved by the entry point. */
	readonly ceiling: string;
	/** The folder scanner (S5). Synchronous by contract; a failure is data, never an exception. */
	readonly scan: (path: string) => ScanResult;
	/** The player for one session (S6), created on `session_start`, never in the factory. */
	readonly createPlayer: (report: (report: PlayerReport) => void) => Player;
	/** Time source for the elapsed clock; defaults to `Date.now`. */
	readonly now?: () => number;
	/** Schedules the one-second status refresh; defaults to `setInterval`. Returns its cancel. */
	readonly tick?: (refresh: () => void) => () => void;
	/** Budget for the status segment when the host reports no terminal width (S12). */
	readonly statusWidth?: number;
	/** Terminal width source; defaults to the live overlay's terminal, then `process.stdout`. */
	readonly terminalColumns?: () => number;
	/** A settings problem worth telling the user about once the session exists (S2). */
	readonly warning?: string;
}

interface Overlay {
	readonly handle: OverlayHandle;
	readonly component: Component;
	readonly tui: TUI;
	/** The component that owned the keyboard before the overlay was shown (S4). Null = fallback. */
	readonly editor: Component | null;
	/** Finishes the `ctx.ui.custom` interaction. Never `handle.hide()`. */
	readonly finish: () => void;
	/** The geometry it was built for: corner and expanded are different overlays (S15). */
	readonly size: CardSize;
}

interface PlaybackClock {
	readonly trackId: string;
	/** Epoch milliseconds when the current playing stretch started. */
	readonly startedAt: number;
	/** Elapsed milliseconds frozen at pause; undefined while playing. */
	readonly frozen?: number;
	/** Total reported by the player (S12, S15); undefined until mpv answers, or when it cannot. */
	readonly durationMs?: number;
}

/** Register the command, the overlay shortcut and the session life cycle. */
export function registerSbMusic(pi: ExtensionAPI, deps: SbMusicDeps): void {
	const clock = deps.now ?? (() => Date.now());
	const schedule = deps.tick ?? defaultTick;

	let state: CardState = initialState({ libraryRoot: deps.settings.libraryRoot, ceiling: deps.ceiling });
	let ctx: ExtensionContext | undefined;
	let player: Player | undefined;
	let stopTick: (() => void) | undefined;
	let overlay: Overlay | undefined;
	/** One `custom` at a time: a new screen is only requested once the previous one finished. */
	let overlayChain: Promise<unknown> = Promise.resolve();
	/** The session's TUI, kept so the status line can force a repaint with no card on screen. */
	let sessionTui: TUI | undefined;
	let playback: PlaybackClock | undefined;
	/** What the player has told us about each track this session (issue #42). */
	const knownDurations = new Map<string, number>();
	let loaded = false;
	let wantsFocus = false;
	let closing = false;

	/* --- the status line (S12) ---------------------------------------------------------------- */

	function columns(): number {
		if (deps.terminalColumns !== undefined) return deps.terminalColumns();
		return overlay?.tui.terminal.columns ?? process.stdout.columns ?? 120;
	}

	function statusWidth(): number {
		if (deps.statusWidth !== undefined) return deps.statusWidth;
		// The host draws statuses in its own footer panel and wraps what does not fit, so the budget
		// is the narrow panel and not the terminal: a full-width segment became a two-line bullet.
		return Math.max(20, Math.min(STATUS_MAX_WIDTH, Math.floor(columns()) - 2));
	}

	function elapsedMs(): number {
		if (!playback) return 0;
		if (playback.frozen !== undefined) return playback.frozen;
		return Math.max(0, clock() - playback.startedAt);
	}

	/**
	 * Pi's status line is a finished string, not a render callback (types.d.ts:95). The formatter
	 * already truncates the title; the glyph is the one part this adapter colours, because the host
	 * theme owns the palette and S12 forbids colour as the only signal.
	 */
	function paintStatus(segment: string, paused: boolean, theme: Theme): string {
		const [glyph, ...rest] = [...segment];
		if (glyph === undefined) return segment;
		return `${theme.fg(paused ? "muted" : "success", glyph)}${rest.join("")}`;
	}

	function refresh(): void {
		if (!ctx || closing) return;
		const segment = statusSegment(state, statusWidth(), {
			elapsedMs: elapsedMs(),
			totalMs: playback?.durationMs,
			asciiGlyphs: deps.settings.asciiGlyphs,
		});
		debug("status", "segment=", segment === undefined ? "undefined" : JSON.stringify(segment), "width=", statusWidth());
		ctx.ui.setStatus(STATUS_KEY, segment === undefined ? undefined : paintStatus(segment, state.paused, ctx.ui.theme));
		// A plain requestRender only repaints what is dirty, and the footer does not consider itself
		// dirty when a status segment changes: the title and the clock stayed invisible until
		// something else forced a full frame (hiding the card did). Force it.
		sessionTui?.requestRender(true);
	}

	/* --- the model's effects (S8) ------------------------------------------------------------- */

	function trackById(trackId: string): Track | undefined {
		const queued = state.queue?.tracks.find((track) => track.id === trackId);
		if (queued) return queued;
		for (const entry of state.entries) {
			if (entry.kind === "track" && entry.track.id === trackId) return entry.track;
		}
		return undefined;
	}

	function loadFolder(path: string): void {
		const result = deps.scan(path);
		if (!result.ok) {
			ctx?.ui.notify(`cannot show ${result.path}: ${result.failure.kind}`, "warning");
			return;
		}
		dispatch({ kind: "folder-loaded", path: result.path, entries: result.entries });
	}

	/** Execute the model's requests. The keyboard is handed back only when the card is dismissed. */
	function applyEffects(effects: readonly Effect[]): void {
		for (const effect of effects) {
			switch (effect.kind) {
				case "load-folder":
					loadFolder(effect.path);
					break;
				case "play": {
					const track = trackById(effect.trackId);
					if (!track) break;
					playback = { trackId: effect.trackId, startedAt: clock() };
					// The total is not asked for here: the `loadfile` reply is not a load fact, and the player
					// reports `duration` once mpv says the file is loaded (S12). Nothing in this adapter queries mpv.
					void player?.play(track);
					// The card keeps the keyboard while it is being driven. Releasing it on every play
					// left the card undriveable after the first `enter` (space, n and p went to the
					// editor). S4 asks that the card not be MODAL: the editor gets the keys back when
					// the card is dismissed or hidden, not on every action.
					break;
				}
				case "pause":
					if (playback && playback.frozen === undefined) playback = { ...playback, frozen: elapsedMs() };
					void player?.pause();
					break;
				case "resume":
					if (playback) {
						// The total survives pause and resume: it describes the track, not the stretch.
						playback = {
							trackId: playback.trackId,
							startedAt: clock() - (playback.frozen ?? 0),
							durationMs: playback.durationMs,
						};
					}
					void player?.resume();
					break;
				case "stop":
					playback = undefined;
					void player?.stop();
					break;
				case "volume":
					void player?.setVolume(effect.level);
					break;
				case "quit":
					playback = undefined;
					void player?.quit();
					break;
			}
		}
	}

	/** One reduction, its effects, and one refresh. Nested loads are safe: they emit no effects. */
	function dispatch(event: CardEvent): void {
		const reduction = reduce(state, event);
		state = reduction.state;
		applyEffects(reduction.effects);
		if (state.presence === "hidden") {
			hideOverlay();
		} else if (overlay && overlay.size !== state.size) {
			// A card key changed the size: geometry is fixed at creation, so the overlay is rebuilt.
			// Doing this only in `show()` left `l` with an expanded frame asked to draw a corner.
			debug("rebuild after key", overlay.size, "->", state.size);
			// Only the expanded card owns the keyboard: the corner is a passive readout (S15), so
			// collapsing to it hands the keys back to the editor instead of holding them hostage.
			const hadFocus = state.size === "expanded" && (wantsFocus || overlay.handle.isFocused());
			hideOverlay();
			wantsFocus = hadFocus;
			createOverlay();
		}
		refresh();
	}

	/* --- the overlay (S4, S15) ---------------------------------------------------------------- */

	function overlayOptions(size: CardSize): OverlayOptions {
		const corner = size === "corner";
		// Never request more columns than the terminal has: a fixed `minWidth: 60` on a narrower screen built
		// a card wider than its area, and the terminal wrapped every line -- the row's name broke in two and
		// the host's own text showed in the columns the card never covered (issue #42).
		const available = Math.max(20, Math.floor(columns()) - 2 * OVERLAY_MARGIN);
		return {
			anchor: corner ? "bottom-right" : "center",
			width: corner ? Math.min(CORNER_WIDTH, available) : "80%",
			minWidth: corner ? Math.min(CORNER_WIDTH, available) : Math.min(EXPANDED_MIN_WIDTH, available),
			maxHeight: corner ? 2 : "80%",
			margin: 1,
			// Never capture the keyboard: S4 wants the editor to keep typing while the card is
			// visible, and a capture we cannot release to a known component leaves the terminal
			// with no focus at all (that is the dead keyboard the first smoke produced).
			nonCapturing: true,
		};
	}

	/** The keyboard goes back to the component that had it before the overlay existed (S4). */
	function hideOverlay(): void {
		debug("hide", "overlay=", Boolean(overlay), "presence=", state.presence, "size=", state.size);
		if (!overlay) return;
		const gone = overlay;
		overlay = undefined;
		wantsFocus = false;
		if (gone.editor) gone.handle.unfocus({ target: gone.editor });
		// `done()` is the documented way out of `ctx.ui.custom`. A handle that is only `setHidden(true)`
		// never came back in the real smoke, and it kept a dead surface around: every show now builds a
		// fresh overlay instead of reviving a stale one.
		gone.finish();
		debug("hid", "finished size=", gone.size, "editor=", Boolean(gone.editor));
	}

	function applyFocus(): void {
		debug("applyFocus", "overlay=", Boolean(overlay), "wantsFocus=", wantsFocus);
		if (!overlay || !wantsFocus) return;
		wantsFocus = false;
		overlay.handle.focus();
		state = reduce(state, { kind: "focus" }).state;
	}

	function createOverlay(): void {
		const sessionCtx = ctx;
		debug("create", "ctx=", Boolean(sessionCtx), "size=", state.size);
		if (!sessionCtx) return;
		const size = state.size;

		let capturedEditor: Component | null = null;
		let capturedTui: TUI | undefined;
		let component: Component | undefined;
		let finish: (() => void) | undefined;

		overlayChain = overlayChain.then(() =>
			sessionCtx.ui
				.custom<void>(
					(tui, theme, _keybindings, done) => {
						// Captured BEFORE the overlay is shown: this is the editor the handle releases to when
						// the card has to leave the way it came. `TUI.getFocusedComponent` is part of the
						// installed interface, so no runtime probe is needed.
						// `TUI` (the exported interface) has no `getFocusedComponent`; the concrete renderer
						// does, so the runtime probe is the only typed-honest way to ask for it.
						capturedEditor = focusedComponent(tui);
						debug("factory", "editor=", Boolean(capturedEditor), "rows=", tui.terminal.rows);
						capturedTui = tui;
						sessionTui = tui;
						finish = () => done(undefined);
						component = createCardComponent({
							state: () => state,
							theme: () => toViewTheme(theme),
							options: () => ({
								libraryRoot: deps.settings.libraryRoot,
								asciiGlyphs: deps.settings.asciiGlyphs,
								elapsedMs: elapsedMs(),
								totalMs: playback?.durationMs,
								// The listing learns from the player as the session goes (issue #42).
								knownDurations,
							}),
							height: () => overlayHeight(state.size, tui.terminal.rows),
							onKey: (id) => dispatch({ kind: "key", id }),
							// The exit goes through the model, not around it: closing the overlay without
							// reducing `presence` left the model saying "visible", so the next overlay
							// shortcut hid nothing and the card looked dead (R4-001).
							dismiss: () => dispatch({ kind: "key", id: "escape" }),
							// A focused overlay swallows the global shortcut, so the card answers it too.
							isOverlayKey: (data) => matchesOverlayKey(data, deps.settings.shortcuts.overlay),
							togglePresence: () => cyclePresence(),
						});
						return component;
					},
					{
						overlay: true,
						overlayOptions: () => overlayOptions(state.size),
						onHandle: (handle) => {
							if (!component || !capturedTui || !finish) return;
							overlay = { handle, component, tui: capturedTui, editor: capturedEditor, finish, size };
							// Nothing was captured from the editor, so there is nothing to hand back: asking to
							// focus `null` is what left a terminal with no keyboard at all.
							if (capturedEditor) handle.unfocus({ target: capturedEditor });
							applyFocus();
							refresh();
						},
					},
				)
				.catch(() => undefined),
		);
	}

	function show(size: CardSize, focus: boolean): void {
		debug(
			"show",
			size,
			"focus=",
			focus,
			"ctx=",
			Boolean(ctx),
			"overlay=",
			Boolean(overlay),
			"presence=",
			state.presence,
		);
		if (!ctx) return;
		state = reduce(state, { kind: size === "expanded" ? "open" : "overlay" }).state;
		// The focus intent is recorded after any rebuild below: `hideOverlay` clears `wantsFocus`, and
		// it used to wipe the request that the caller had just made (the card opened unfocused).
		if (!loaded) {
			loaded = true;
			loadFolder(state.path);
		}

		if (overlay && overlay.size !== state.size) {
			// Geometry is fixed when the overlay is created, so corner -> expanded is a new overlay.
			hideOverlay();
		}

		wantsFocus ||= focus;

		if (overlay) {
			overlay.handle.setHidden(false);
			overlay.component.invalidate();
			overlay.tui.requestRender();
			applyFocus();
		} else {
			createOverlay();
		}
		refresh();
	}

	/**
	 * The overlay key cycles the three states in a fixed order (S15, L38): hidden -> corner -> expanded ->
	 * hidden. One command, so the size never depends on a focus the corner does not have: collapsing handed
	 * the keyboard back to the editor, and the old `l` could not be pressed again from there.
	 */
	function cyclePresence(): void {
		debug("cycle", "presence=", state.presence, "size=", state.size, "ctx=", Boolean(ctx));
		if (!ctx) return;
		// Two ways out of a state, and they are not interchangeable: `show(size, focus)` builds (or
		// rebuilds) the overlay for a size and records the focus intent, while dispatching `overlay`
		// runs the reducer, which finds the card visible and hides it -- and hiding is what finishes
		// the overlay. So the two visible targets go through `show`, and only hiding goes through the
		// model event.
		if (state.presence === "hidden") {
			// Nothing playing means the corner has nothing to read: it would sit there saying
			// `nothing playing` and need a second press to be useful. Go straight to the list.
			show(state.playing === undefined ? "expanded" : "corner", state.playing === undefined);
			return;
		}
		if (state.size === "corner") {
			// The expanded card is the one that wants the keyboard; the corner is a passive readout.
			show("expanded", true);
			return;
		}
		dispatch({ kind: "overlay" });
	}

	/* --- the session (S6) -------------------------------------------------------------------- */

	function onReport(report: PlayerReport): void {
		if (closing) return;
		switch (report.kind) {
			case "ended":
				dispatch({ kind: "track-ended", trackId: report.trackId });
				break;
			case "failed":
				dispatch({ kind: "track-failed", trackId: report.trackId });
				break;
			case "duration":
				// What the player says about a track is true for that track, so it is remembered for the
				// session and the listing can fill the row in (issue #42) -- even when it arrives for a
				// track that is no longer playing.
				knownDurations.set(report.trackId, report.durationMs);
				// The clock on screen, though, belongs only to the track that is still playing (S12, S15).
				if (playback === undefined || playback.trackId !== report.trackId) {
					refresh();
					break;
				}
				playback = { ...playback, durationMs: report.durationMs };
				refresh();
				break;
			case "unavailable":
				// S6's guided state is a later slice; for now the host reports it without crashing.
				ctx?.ui.notify(report.message, "warning");
				break;
			case "ready":
				break;
		}
	}

	function startSession(sessionCtx: ExtensionContext): void {
		ctx = sessionCtx;
		closing = false;
		if (player) return;

		state = initialState({ libraryRoot: deps.settings.libraryRoot, ceiling: deps.ceiling });
		playback = undefined;
		loaded = false;
		wantsFocus = false;
		player = deps.createPlayer(onReport);
		stopTick = schedule(() => refresh());
		if (deps.warning) sessionCtx.ui.notify(deps.warning, "warning");
		refresh();
	}

	async function stopSession(): Promise<void> {
		closing = true;
		stopTick?.();
		stopTick = undefined;

		const current = player;
		player = undefined;
		playback = undefined;

		const open = overlay;
		overlay = undefined;
		open?.finish();

		ctx?.ui.setStatus(STATUS_KEY, undefined);
		await current?.quit();
	}

	/* --- the Pi registrations (S1) ----------------------------------------------------------- */

	pi.registerCommand("sb-music", {
		description: "Open the StreamBeats music card",
		handler: async (_args: string, commandCtx: ExtensionCommandContext) => {
			if (commandCtx.mode !== "tui") {
				commandCtx.ui.notify("/sb-music needs Pi's interactive TUI, not print or JSON mode", "error");
				return;
			}
			startSession(commandCtx);
			// Focused, because a card that never takes input cannot answer a single key — the smoke
			// proved it: with `nonCapturing` the overlay received nothing, `esc` included.
			show("expanded", true);
		},
	});

	pi.registerShortcut(deps.settings.shortcuts.overlay as KeyId, {
		description: "Show or hide the music card",
		handler: async (shortcutCtx: ExtensionContext) => {
			if (shortcutCtx.mode !== "tui") return;
			startSession(shortcutCtx);
			cyclePresence();
		},
	});

	pi.on("session_start", (_event, sessionCtx) => {
		startSession(sessionCtx);
	});

	pi.on("session_shutdown", async (_event, _sessionCtx) => {
		await stopSession();
	});
}

/**
 * Opt-in trace for the one thing tests cannot reach: what the real host does with our overlay.
 * `SB_MUSIC_DEBUG=/tmp/sb-music.log` makes every decision append a line there; unset, this is a
 * no-op and nothing is written.
 */
function debug(...parts: readonly unknown[]): void {
	const path = process.env.SB_MUSIC_DEBUG;
	if (!path) return;
	try {
		appendFileSync(path, `${new Date().toISOString()} ${parts.map(String).join(" ")}\n`);
	} catch {
		// A trace that breaks the host would be worse than no trace.
	}
}

/**
 * The component that had the keyboard before the overlay existed (S4).
 *
 * `TUI` declares focus setters but not the getter (pi-tui/dist/tui.d.ts:223-249); the concrete
 * renderer has `getFocusedComponent()` (same file, line 315). The probe asks for it when present
 * and answers null otherwise, and the host then releases nothing instead of asking for focus of
 * `null`, which is what left the terminal with no keyboard at all.
 */
function focusedComponent(tui: TUI): Component | null {
	const focused = (tui as TUI & { getFocusedComponent?: () => Component | null }).getFocusedComponent;
	return focused?.call(tui) ?? null;
}

/** The production ticker: the status line's clock advances while the card is out of the way. */
function defaultTick(refresh: () => void): () => void {
	const timer = setInterval(refresh, 1000);
	return () => clearInterval(timer);
}
