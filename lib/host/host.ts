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
import {
	type Component,
	Key,
	type KeyId,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	type CardEvent,
	type CardSize,
	type CardState,
	type Effect,
	footerHints,
	initialState,
	reduce,
	type TransportAction,
} from "../core/model.ts";
import { statusSegment } from "../core/now-playing.ts";
import type { ScanResult } from "../library/scan.ts";
import type { Player, PlayerReport } from "../player/mpv.ts";
import { editShortcuts, type SaveResult, type Settings, SHORTCUT_NAMES, type ShortcutName } from "../settings.ts";
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

/** The widget key of the `--keys` report: one block above the editor, replaced on every run (S22). */
const REPORT_KEY = "sb-music-keys";

/**
 * The base keys Pi can produce (S22). It is the host's own vocabulary: `Key` is the table the host
 * builds its key-id schema from, plus the single letters and digits that schema adds. `lib/settings.ts`
 * receives this list as a parameter, because only `lib/host/` may import a host package (S8).
 */
const HOST_KEYS: readonly string[] = [
	..."abcdefghijklmnopqrstuvwxyz",
	..."0123456789",
	...Object.values(Key)
		.filter((value) => typeof value === "string")
		.map((value) => String(value)),
];

type CommandArgs =
	| { readonly kind: "open" }
	| { readonly kind: "keys"; readonly assignments: readonly string[] }
	| { readonly kind: "help" }
	| { readonly kind: "unknown"; readonly argument: string };

/** `/sb-music` with no argument opens the card; `--keys` and `--help` are the two text modes (S22). */
function parseCommandArgs(raw: string): CommandArgs {
	const [first, ...rest] = raw
		.trim()
		.split(/\s+/)
		.filter((token) => token !== "");
	if (first === undefined) return { kind: "open" };
	if (first === "--help") return { kind: "help" };
	if (first === "--keys") return { kind: "keys", assignments: rest };
	return { kind: "unknown", argument: first };
}

/** Everything the adapter needs from the process, injected so tests never touch mpv or disk. */
export interface SbMusicDeps {
	readonly settings: Settings;
	/** The highest folder `u` may reach (S14), resolved by the entry point. */
	readonly ceiling: string;
	/** The resolved `settings.json` path, printed by `--keys` (S22). */
	readonly settingsFile: string;
	/** The atomic writer `--keys` saves through (S22), injected like every other side effect here. */
	readonly saveSettings: (settings: Settings) => SaveResult;
	/**
	 * The folder scanner (S5, S21). Asynchronous by contract: it runs on the host's input path, so it
	 * returns before the listing exists. A failure is data, never a rejection.
	 */
	readonly scan: (path: string) => Promise<ScanResult>;
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
	/** What this session actually bound, with the words the host prints: the `--keys` report reads it (S22). */
	const registeredShortcuts = new Map<ShortcutName, { readonly key: string; readonly help: string }>();
	/** The last save of this session, so `--keys` can show what the file holds and the session does not. */
	let savedSettings: Settings | undefined;

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
	/**
	 * Which request may write state (S21). With an asynchronous scan two reads can overlap, and the one
	 * that answers last would otherwise win even when it is the folder the card already left. Only the
	 * newest token is allowed through, and `readingPath` keeps one folder from being read twice.
	 */
	let loadToken = 0;
	let readingPath: string | undefined;
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

	/**
	 * The player resolves by contract, but a throwing socket write or a serialization failure still
	 * rejects. Leaving that to the default unhandled-rejection policy turned one bad write into a dead
	 * session, and the caller never learned (T16).
	 */
	function guard(action: Promise<void> | undefined, what: string, onFailure?: () => void): void {
		void action?.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			ctx?.ui.notify(`${what}: ${message}`, "error");
			onFailure?.();
			refresh();
		});
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
		// The same read is already in flight: showing the card again must not ask twice.
		if (readingPath === path) return;
		const token = ++loadToken;
		readingPath = path;
		// Say what is being read before it arrives: an empty folder and one still arriving look the same
		// otherwise, and this is painted from the input path, which returns here (S21, L62).
		dispatch({ kind: "folder-reading", path });
		let scan: Promise<ScanResult>;
		try {
			scan = deps.scan(path);
		} catch {
			// A dep that throws instead of answering would escape into the editor with `readingPath` already
			// set, locking this folder for the rest of the session. The contract says it does not throw;
			// this keeps a broken one local instead of silently disabling every later read of the folder.
			readingPath = undefined;
			const message = `cannot show ${path}: reader failed`;
			dispatch({ kind: "notice", text: message });
			ctx?.ui.notify(message, "warning");
			return;
		}
		void scan.then(
			(result) => {
				if (token !== loadToken) return;
				readingPath = undefined;
				if (!result.ok) {
					// S5 asks for the failure as a state, not as a toast that fades: the footer keeps saying it,
					// with the path, until the card loads something else.
					const message = `cannot show ${result.path}: ${result.failure.kind}`;
					dispatch({ kind: "notice", text: message });
					ctx?.ui.notify(message, "warning");
					return;
				}
				// The latch is set only by a read that worked (L46): a failure leaves it false and the next
				// show asks again, instead of leaving the card empty for the whole session.
				loaded = true;
				dispatch({ kind: "folder-loaded", path: result.path, entries: result.entries });
			},
			// `scan` never rejects (S21). If it ever does, that is a bug, and a bug must not become an
			// unhandled rejection that takes the session down.
			() => {
				if (token !== loadToken) return;
				readingPath = undefined;
				const message = `cannot show ${path}: reader failed`;
				dispatch({ kind: "notice", text: message });
				ctx?.ui.notify(message, "warning");
			},
		);
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
					guard(player?.play(track), `cannot play ${track.title}`, () => {
						// A play that never loaded must not leave a clock ticking for it.
						playback = undefined;
						dispatch({ kind: "track-failed", trackId: effect.trackId });
					});
					// The card keeps the keyboard while it is being driven. Releasing it on every play
					// left the card undriveable after the first `enter` (space, n and p went to the
					// editor). S4 asks that the card not be MODAL: the editor gets the keys back when
					// the card is dismissed or hidden, not on every action.
					break;
				}
				case "pause":
					if (playback && playback.frozen === undefined) playback = { ...playback, frozen: elapsedMs() };
					guard(player?.pause(), "cannot pause");
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
					guard(player?.resume(), "cannot resume");
					break;
				case "stop":
					playback = undefined;
					guard(player?.stop(), "cannot stop");
					break;
				case "volume":
					guard(player?.setVolume(effect.level), "cannot set the volume");
					break;
				case "quit":
					playback = undefined;
					guard(player?.quit(), "cannot quit mpv");
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
							// The pointer arrives already resolved to a row of this frame's hit map (S17): the core
							// never learns a screen coordinate, and the adapter never guesses a row.
							onPointer: (event) => dispatch(event),
							// The exit goes through the model, not around it: closing the overlay without
							// reducing `presence` left the model saying "visible", so the next overlay
							// shortcut hid nothing and the card looked dead (R4-001).
							dismiss: () => dispatch({ kind: "key", id: "escape" }),
							// A focused overlay swallows the global shortcut, so the card answers it too.
							isOverlayKey: (data) => matchesOverlayKey(data, deps.settings.shortcuts.overlay),
							togglePresence: () => cyclePresence(),
							// What the terminal actually sent, so the next host round diagnoses instead of guessing:
							// ctrl-c is `\u0003` on a terminal that ignores the Kitty protocol and CSI-u on one
							// that answers it (L49). Writes nothing unless SB_MUSIC_DEBUG is set.
							trace: (data) => debug("input", JSON.stringify(data)),
							// `pointer` with no line at all is the answer to "the mouse does nothing": the event never
							// reached the card, which is what Pi's regular (non-fullscreen) TUI does with it.
							tracePointer: (event) => debug("pointer", event.type, event.button, event.x, event.y, event.wheelDelta),
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
			// Latch only a load that worked. Latching first meant a library that was not ready when the
			// card opened left it empty for the whole session, with no key to try again (S5, T16).
			// The latch now lives inside the read, because the answer arrives after this returns (S21).
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
		// A read that started in the previous session must not land in this one (S21).
		loadToken += 1;
		readingPath = undefined;
		wantsFocus = false;
		player = deps.createPlayer(onReport);
		stopTick = schedule(() => {
			// A full repaint every second for a hidden card with nothing playing is pure cost (T16).
			if (overlay !== undefined || state.playing !== undefined) refresh();
		});
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

	/* --- the keys report (S22) ---------------------------------------------------------------- */

	function shortcutRow(name: ShortcutName): string {
		const registered = registeredShortcuts.get(name);
		const onFile = (savedSettings ?? deps.settings).shortcuts[name];
		const key = registered?.key ?? onFile;
		const help = registered === undefined ? "" : `${registered.help} · `;
		const where = registered === undefined ? "not registered" : "registered";
		// A saved change is on disk while this session still answers to the old key: Pi binds shortcuts
		// when the session starts, so both truths are printed instead of pretending they are one (S22).
		const pending = onFile === key ? "" : ` · file ${onFile}, next session`;
		return `  ${name.padEnd(9)} ${key.padEnd(16)}${help}${where}${pending}`;
	}

	function insideCardKeys(): string {
		// The card's own keys, from the one table its footer renders (S13): a second list could lie.
		return footerHints()
			.map((hint) => `${hint.key} ${hint.help}`)
			.join(" · ");
	}

	function keysLines(notes: readonly string[] = []): string[] {
		return [
			`sb-music keys · ${deps.settingsFile}`,
			...notes,
			...SHORTCUT_NAMES.map(shortcutRow),
			`inside the card · ${insideCardKeys()}`,
			"change · /sb-music --keys overlay=ctrl+alt+m (or =default) · /sb-music --help",
		];
	}

	function helpLines(): string[] {
		return [
			"sb-music · keys and syntax",
			"  /sb-music                        open the card",
			"  /sb-music --keys                 print the keys in effect; writes nothing",
			"  /sb-music --keys overlay=<key>   change one or more keys; all or nothing, =default restores",
			"  /sb-music --help                 this text",
			...SHORTCUT_NAMES.map(shortcutRow),
			`inside the card · ${insideCardKeys()}`,
		];
	}

	/**
	 * The only multi-line, non-interactive surface `ExtensionUIContext` has is a widget above the editor.
	 * `notify` is one status line and would mangle a table; `custom` is an interactive overlay, which is
	 * exactly what `--keys` must not build. Print and JSON modes install a no-op UI context — no surface
	 * for several lines at all — so the closest thing there is a single notify (S22).
	 */
	function printLines(commandCtx: ExtensionCommandContext, lines: readonly string[]): void {
		if (commandCtx.hasUI) {
			commandCtx.ui.setWidget(REPORT_KEY, [...lines], { placement: "aboveEditor" });
			return;
		}
		commandCtx.ui.notify(lines.join(" · "), "info");
	}

	/** `/sb-music --keys` with no pairs reads; with pairs it validates and saves all of them or none (S22). */
	function reportKeys(commandCtx: ExtensionCommandContext, assignments: readonly string[]): void {
		if (assignments.length === 0) {
			// A file the loader could not read leaves the defaults in memory (S2), and the read report is
			// exactly where the user asks "what keys do I have" — usually because a change will not save.
			// Staying silent here hid the reason, while the save path refuses for the same warning (R3-001).
			printLines(
				commandCtx,
				keysLines(
					deps.warning === undefined
						? []
						: [deps.warning, "these are the defaults in memory: the file above could not be used"],
				),
			);
			return;
		}

		const edit = editShortcuts(deps.settings, assignments, HOST_KEYS);
		if (!edit.ok) {
			// Nothing was written and nothing will be: the offending pair is the whole message.
			printLines(commandCtx, ["sb-music keys · nothing written", `  ${edit.error}`, "syntax · /sb-music --help"]);
			return;
		}
		if (edit.changes.length === 0) {
			printLines(commandCtx, keysLines(["nothing to change"]));
			return;
		}
		if (deps.warning !== undefined) {
			// The loader leaves a file it could not use untouched on purpose (S2); an explicit save must not
			// be the way around that, or the broken text the user was about to fix disappears under them.
			printLines(commandCtx, ["sb-music keys · nothing written", `  ${deps.warning}`, "syntax · /sb-music --help"]);
			return;
		}

		const saved = deps.saveSettings(edit.settings);
		if (!saved.ok) {
			printLines(commandCtx, ["sb-music keys · nothing written", `  ${saved.error}`, "syntax · /sb-music --help"]);
			return;
		}

		savedSettings = edit.settings;
		printLines(commandCtx, [
			`sb-music keys saved · ${deps.settingsFile}`,
			...edit.changes.map((change) => `  ${change.key.padEnd(9)} ${change.from} → ${change.to}`),
			"takes effect at the next session: Pi binds shortcuts when the session starts",
			"read them back · /sb-music --keys",
		]);
	}

	/* --- the Pi registrations (S1) ----------------------------------------------------------- */

	/**
	 * One shape for the four global keys: register it and record it, so the `--keys` report prints what
	 * this session actually bound instead of a second hand-written list that could drift (S22).
	 */
	function registerShortcut(
		name: ShortcutName,
		description: string,
		handler: (shortcutCtx: ExtensionContext) => Promise<void>,
	): void {
		const key = deps.settings.shortcuts[name];
		registeredShortcuts.set(name, { key, help: description.replace(/^Music card: /, "") });
		pi.registerShortcut(key as KeyId, { description, handler });
	}

	pi.registerCommand("sb-music", {
		// The command still opens the card (S22 requirement 2): it is the rescue path for a terminal
		// where the shortcut is unavailable, so it announces the key that owns the cycle instead of
		// describing itself as the only way in.
		description: `Open the music card · ${deps.settings.shortcuts.overlay} cycles it`,
		handler: async (args: string, commandCtx: ExtensionCommandContext) => {
			const parsed = parseCommandArgs(args);
			if (parsed.kind === "help") {
				printLines(commandCtx, helpLines());
				return;
			}
			if (parsed.kind === "keys") {
				// No `mode !== "tui"` guard here: this path is text, and text is all a print mode has (S22).
				reportKeys(commandCtx, parsed.assignments);
				return;
			}
			if (parsed.kind === "unknown") {
				// Quietly opening the card would ignore what the user typed, and silently ignoring an
				// argument is the same defect as silently ignoring a key.
				printLines(commandCtx, [
					`"${parsed.argument}" is not a /sb-music argument`,
					"  /sb-music           open the card",
					"  /sb-music --keys    read or change the keys",
					"  /sb-music --help    the syntax and the table",
				]);
				return;
			}
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

	registerShortcut("overlay", "Music card: cycle hidden → corner → expanded", async (shortcutCtx) => {
		if (shortcutCtx.mode !== "tui") return;
		startSession(shortcutCtx);
		cyclePresence();
	});

	/**
	 * The three transport shortcuts (S22 requirement 1). One shape for all of them, so none can
	 * forget the session: a shortcut pressed before `/sb-music` ever ran has to build the model and
	 * the player itself, or the key would answer to nothing.
	 */
	function registerTransport(name: ShortcutName, action: TransportAction, description: string): void {
		registerShortcut(name, description, async (shortcutCtx) => {
			if (shortcutCtx.mode !== "tui") return;
			startSession(shortcutCtx);
			// Through the model, never around it: the reducer returns the effects the card already
			// uses, so a global key and the card's own `space`/`n`/`p` cannot drift apart (S22).
			dispatch({ kind: "transport", action });
		});
	}

	registerTransport("playPause", "toggle-pause", "Music card: pause or resume");
	registerTransport("next", "next", "Music card: next track");
	registerTransport("prev", "previous", "Music card: previous track");

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
