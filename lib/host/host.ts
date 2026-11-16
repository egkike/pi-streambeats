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
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeyId, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { type CardEvent, type CardSize, type CardState, type Effect, initialState, reduce } from "../core/model.ts";
import { statusSegment } from "../core/now-playing.ts";
import type { ScanResult } from "../library/scan.ts";
import type { Player, PlayerReport } from "../player/mpv.ts";
import type { Settings } from "../settings.ts";
import type { Track } from "../types.ts";
import { createCardComponent, overlayHeight } from "./component.ts";
import { toViewTheme } from "./theme.ts";

/** The single status key. Pi sorts statuses by key, so a stable one keeps the line in place. */
export const STATUS_KEY = "sb-music";

/** The artboard's corner card is 46 cells wide (S15). */
const CORNER_WIDTH = 46;

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
}

interface PlaybackClock {
	readonly trackId: string;
	/** Epoch milliseconds when the current playing stretch started. */
	readonly startedAt: number;
	/** Elapsed milliseconds frozen at pause; undefined while playing. */
	readonly frozen?: number;
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
	let playback: PlaybackClock | undefined;
	let loaded = false;
	let wantsFocus = false;
	let closing = false;

	/* --- the status line (S12) ---------------------------------------------------------------- */

	function statusWidth(): number {
		if (deps.statusWidth !== undefined) return deps.statusWidth;
		const columns = overlay?.tui.terminal.columns ?? 120;
		return Math.max(20, Math.floor(columns) - 2);
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
			asciiGlyphs: deps.settings.asciiGlyphs,
		});
		ctx.ui.setStatus(STATUS_KEY, segment === undefined ? undefined : paintStatus(segment, state.paused, ctx.ui.theme));
		overlay?.tui.requestRender();
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

	/** Execute the model's requests. Returns true when the keyboard must go back to the editor. */
	function applyEffects(effects: readonly Effect[]): boolean {
		let releaseKeyboard = false;

		for (const effect of effects) {
			switch (effect.kind) {
				case "load-folder":
					loadFolder(effect.path);
					break;
				case "play": {
					const track = trackById(effect.trackId);
					if (!track) break;
					playback = { trackId: effect.trackId, startedAt: clock() };
					void player?.play(track);
					// The user picked a track: the editor gets the keyboard back (S4, README).
					releaseKeyboard = true;
					break;
				}
				case "pause":
					if (playback && playback.frozen === undefined) playback = { ...playback, frozen: elapsedMs() };
					void player?.pause();
					break;
				case "resume":
					if (playback) {
						playback = { trackId: playback.trackId, startedAt: clock() - (playback.frozen ?? 0) };
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
		return releaseKeyboard;
	}

	/** One reduction, its effects, and one refresh. Nested loads are safe: they emit no effects. */
	function dispatch(event: CardEvent): void {
		const reduction = reduce(state, event);
		state = reduction.state;
		const release = applyEffects(reduction.effects);
		if (release) releaseToEditor();
		if (state.presence === "hidden") hideOverlay();
		refresh();
	}

	/* --- the overlay (S4, S15) ---------------------------------------------------------------- */

	function overlayOptions(size: CardSize): OverlayOptions {
		const corner = size === "corner";
		return {
			anchor: corner ? "bottom-right" : "center",
			width: corner ? CORNER_WIDTH : "80%",
			minWidth: corner ? CORNER_WIDTH : 60,
			maxHeight: corner ? 2 : "80%",
			margin: 1,
			// Never capture the keyboard: S4 wants the editor to keep typing while the card is
			// visible, and a capture we cannot release to a known component leaves the terminal
			// with no focus at all (that is the dead keyboard the first smoke produced).
			nonCapturing: true,
		};
	}

	/** The keyboard goes back to the component that had it before the overlay existed (S4). */
	function releaseToEditor(): void {
		if (!overlay) return;
		if (!overlay.editor) return;
		overlay.handle.unfocus({ target: overlay.editor });
		state = reduce(state, { kind: "blur" }).state;
	}

	function hideOverlay(): void {
		if (!overlay) return;
		const gone = overlay;
		overlay = undefined;
		wantsFocus = false;
		if (gone.editor) gone.handle.unfocus({ target: gone.editor });
		// `done()` is the documented way out of `ctx.ui.custom`. A handle that is only `setHidden(true)`
		// never came back in the real smoke, and it kept a dead surface around: every show now builds a
		// fresh overlay instead of reviving a stale one.
		gone.finish();
	}

	function applyFocus(): void {
		if (!overlay || !wantsFocus) return;
		wantsFocus = false;
		overlay.handle.focus();
		state = reduce(state, { kind: "focus" }).state;
	}

	function createOverlay(): void {
		const sessionCtx = ctx;
		if (!sessionCtx) return;

		let capturedEditor: Component | null = null;
		let capturedTui: TUI | undefined;
		let component: Component | undefined;
		let finish: (() => void) | undefined;

		void sessionCtx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				// Captured BEFORE the overlay is shown: this is the editor the handle releases to when
				// the card has to leave the way it came. `TUI.getFocusedComponent` is part of the
				// installed interface, so no runtime probe is needed.
				// `TUI` (the exported interface) has no `getFocusedComponent`; the concrete renderer
				// does, so the runtime probe is the only typed-honest way to ask for it.
				capturedEditor = focusedComponent(tui);
				capturedTui = tui;
				finish = () => done(undefined);
				component = createCardComponent({
					state: () => state,
					theme: () => toViewTheme(theme),
					options: () => ({
						libraryRoot: deps.settings.libraryRoot,
						asciiGlyphs: deps.settings.asciiGlyphs,
						elapsedMs: elapsedMs(),
					}),
					height: () => overlayHeight(state.size, tui.terminal.rows),
					onKey: (id) => dispatch({ kind: "key", id }),
					// A last-resort exit: if the model ever mishandles the key, the overlay still
					// closes instead of holding a terminal hostage.
					dismiss: () => hideOverlay(),
				});
				return component;
			},
			{
				overlay: true,
				overlayOptions: () => overlayOptions(state.size),
				onHandle: (handle) => {
					if (!component || !capturedTui || !finish) return;
					overlay = { handle, component, tui: capturedTui, editor: capturedEditor, finish };
					// Nothing was captured from the editor, so there is nothing to hand back: asking to
					// focus `null` is what left a terminal with no keyboard at all.
					if (capturedEditor) handle.unfocus({ target: capturedEditor });
					applyFocus();
					refresh();
				},
			},
		);
	}

	function show(size: CardSize, focus: boolean): void {
		if (!ctx) return;
		state = reduce(state, { kind: size === "expanded" ? "open" : "overlay" }).state;
		wantsFocus ||= focus;
		if (!loaded) {
			loaded = true;
			loadFolder(state.path);
		}

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

	function togglePresence(): void {
		if (!ctx) return;
		if (state.presence === "visible") {
			dispatch({ kind: "overlay" });
			return;
		}
		show("corner", false);
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
			togglePresence();
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
