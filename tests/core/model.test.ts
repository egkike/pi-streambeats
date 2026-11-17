/**
 * The card state machine (S3, S11, S13, S15). Every test is pure: no filesystem, no mpv, no clock,
 * no terminal. A state and an event go in; a new state and effects as data come out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	actionFor,
	type CardState,
	footerHints,
	initialState,
	KEY_BINDINGS,
	type KeyAction,
	type ModelDeps,
	type Reduction,
	reduce,
	selectedEntry,
	visibleEntries,
} from "../../lib/core/model.ts";
import type { Folder, LibraryEntry, Track } from "../../lib/types.ts";

const HOME = "/home/kike";
const ROOT = `${HOME}/Music`;
const ALBUM = `${ROOT}/StreamBeats/Chillhop`;

function track(name: string, dir = ALBUM): Track {
	return { id: `${dir}/${name}`, title: name, origin: "local" };
}

function folder(name: string, dir = ALBUM): Folder {
	return { path: `${dir}/${name}`, name };
}

function trackRow(item: Track): LibraryEntry {
	return { kind: "track", track: item };
}

function folderRow(item: Folder): LibraryEntry {
	return { kind: "folder", folder: item };
}

const A = track("01 - A.mp3");
const B = track("02 - B.mp3");
const C = track("03 - C.mp3");
const D = track("04 - D.mp3");

/** Folders first, then tracks, exactly as the scanner hands them over (S5). */
function album(): LibraryEntry[] {
	return [folderRow(folder("Extras")), trackRow(A), trackRow(B), trackRow(C), trackRow(D)];
}

const ROW = { folder: 0, a: 1, b: 2, c: 3, d: 4 } as const;

function start(config = { libraryRoot: ROOT, ceiling: HOME }): CardState {
	return initialState(config);
}

function visible(state: CardState): CardState {
	return reduce(state, { kind: "overlay" }).state;
}

function withFocus(state: CardState): CardState {
	return reduce(state, { kind: "focus" }).state;
}

function loaded(state: CardState, path: string, entries: readonly LibraryEntry[]): CardState {
	return reduce(state, { kind: "folder-loaded", path, entries }).state;
}

function press(state: CardState, id: string, deps?: ModelDeps): Reduction {
	return reduce(state, { kind: "key", id }, deps);
}

function key(state: CardState, id: string, deps?: ModelDeps): CardState {
	return press(state, id, deps).state;
}

/** Move the cursor to a row by pressing the keys the card binds, never by editing the state. */
function at(state: CardState, row: number): CardState {
	let moved = state;
	while (moved.cursor > row) moved = key(moved, "up");
	while (moved.cursor < row) moved = key(moved, "down");
	return moved;
}

/** The card showing the album, on screen and holding the keyboard. */
function browsingAlbum(): CardState {
	return loaded(withFocus(visible(start())), ALBUM, album());
}

function playing(row: number): CardState {
	return press(at(browsingAlbum(), row), "enter").state;
}

function playingB(): CardState {
	return playing(ROW.b);
}

function playingD(): CardState {
	return playing(ROW.d);
}

function ids(tracks: readonly Track[] | undefined): string[] {
	return (tracks ?? []).map((item) => item.id);
}

/** The name a row shows, which is what the filter matches (S18). */
function nameOf(entry: LibraryEntry): string {
	return entry.kind === "folder" ? entry.folder.name : entry.track.title;
}

/** Open the filter and type a term, one key per character, never by editing the state. */
function typing(state: CardState, text: string): CardState {
	let typed = key(state, "/");
	for (const character of text) typed = key(typed, character);
	return typed;
}

/** Deterministic randomness, so a shuffle can be asserted exactly (S11). */
const fixed: ModelDeps = { random: () => 0 };

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
		Object.freeze(value);
	}
	return value;
}

describe("the starting state (S15, S14, S11)", () => {
	it("is hidden, in the corner, at libraryRoot and playing nothing", () => {
		const state = start();

		assert.equal(state.presence, "hidden");
		assert.equal(state.size, "corner");
		assert.equal(state.focused, false);
		assert.equal(state.path, ROOT);
		assert.deepEqual(state.entries, []);
		assert.equal(state.cursor, 0);
		assert.equal(state.playing, undefined);
		assert.equal(state.paused, false);
		assert.equal(state.queue, undefined);
		assert.equal(state.notice, undefined);
	});

	it("starts at volume 70 with shuffle off", () => {
		const state = start();

		assert.equal(state.volume, 70);
		assert.equal(state.shuffle, false);
	});

	it("takes the ceiling as an input instead of deriving HOME (S14)", () => {
		const state = start({ libraryRoot: "/srv/music", ceiling: "/srv/music" });

		assert.equal(state.ceiling, "/srv/music");
		assert.equal(state.path, "/srv/music");
	});

	it("reserves an empty filter term for S18 and reads the listing through one selector", () => {
		const state = browsingAlbum();

		assert.equal(state.filter, "");
		assert.deepEqual(visibleEntries(state), state.entries);
	});
});

describe("the key table (S13)", () => {
	it("binds every key S13 announces to exactly one action", () => {
		const expected: Record<string, KeyAction> = {
			up: "cursor-up",
			down: "cursor-down",
			k: "cursor-up",
			j: "cursor-down",
			enter: "activate",
			u: "folder-up",
			backspace: "folder-up",
			escape: "hide",
			space: "toggle-pause",
			s: "stop",
			n: "next",
			">": "next",
			p: "previous",
			"<": "previous",
			"+": "volume-up",
			"-": "volume-down",
			z: "toggle-shuffle",
			"/": "start-filter",
		};

		for (const [id, action] of Object.entries(expected)) assert.equal(actionFor(id), action, id);
	});

	it("has one binding per identifier, each with a label and help text", () => {
		const seen = new Set<string>();

		for (const binding of KEY_BINDINGS) {
			assert.equal(seen.has(binding.id), false, `${binding.id} is bound twice`);
			seen.add(binding.id);
			assert.ok(binding.label.length > 0, binding.id);
			assert.ok(binding.help.length > 0, binding.id);
		}
	});

	it("prints the footer from the same table, one hint per action", () => {
		const hints = footerHints();
		const actions = hints.map((hint) => hint.action);

		assert.deepEqual(actions, [...new Set(actions)]);
		for (const hint of hints) {
			const binding = KEY_BINDINGS.find((candidate) => candidate.hint && candidate.action === hint.action);
			assert.equal(binding?.label, hint.key, hint.action);
			assert.equal(binding?.help, hint.help, hint.action);
		}
	});

	it("announces / now that it opens the filter (S18, no dead chrome)", () => {
		const hint = footerHints().find((candidate) => candidate.action === "start-filter");

		assert.equal(actionFor("/"), "start-filter");
		assert.equal(hint?.key, "/");
		assert.equal(hint?.help, "filter");
	});
});

describe("presence and size (S15)", () => {
	it("shows a hidden card in the corner", () => {
		const state = visible(start());

		assert.equal(state.presence, "visible");
		assert.equal(state.size, "corner");
	});

	it("lands in the corner even after being hidden while expanded", () => {
		const expanded = reduce(withFocus(visible(start())), { kind: "open" }).state;
		assert.equal(expanded.size, "expanded");

		const hidden = key(expanded, "escape");
		assert.equal(hidden.presence, "hidden");

		const shownAgain = visible(hidden);
		assert.equal(shownAgain.presence, "visible");
		assert.equal(shownAgain.size, "corner");
	});

	it("opens expanded from the command (S15)", () => {
		const state = reduce(start(), { kind: "open" }).state;

		assert.equal(state.presence, "visible");
		assert.equal(state.size, "expanded");
	});

	it("ignores the retired `l` key: one key owns presence and size (L38)", () => {
		// `l` disappeared because the size was reachable only while the card held the keyboard, and
		// the corner never holds it. The card must not answer it at any size.
		const expanded = reduce(withFocus(visible(start())), { kind: "open" }).state;
		const afterL = key(expanded, "l");

		assert.equal(afterL.size, "expanded", "`l` no longer resizes the card");
		assert.equal(afterL.presence, "visible");
	});

	it("hides with esc from either size and gives the keyboard back", () => {
		const expanded = reduce(withFocus(visible(start())), { kind: "open" }).state;
		const hidden = key(expanded, "escape");

		assert.equal(hidden.presence, "hidden");
		assert.equal(hidden.size, "corner");
		assert.equal(hidden.focused, false);
	});

	it("hides on the `interrupt` identifier ctrl-c arrives as (L49)", () => {
		// The host adapter maps ctrl-c to `interrupt`, and a Kitty-encoding terminal sends it as a
		// CSI-u sequence instead of the raw `\u0003` byte. An identifier the table does not bind is
		// a key the card silently ignores, which is exactly what the host showed (L49).
		const expanded = reduce(withFocus(visible(start())), { kind: "open" }).state;
		const hidden = key(expanded, "interrupt");

		assert.equal(hidden.presence, "hidden");
		assert.equal(hidden.size, "corner");
	});

	it("toggles with the overlay key and does not take the keyboard from the editor (S4)", () => {
		const shown = visible(start());
		assert.equal(shown.focused, false);

		assert.equal(visible(shown).presence, "hidden");
	});

	it("ignores keys while hidden", () => {
		const state = loaded(start(), ALBUM, album());

		assert.equal(press(state, "down").state, state);
		assert.equal(press(state, "enter").state, state);
	});

	it("ignores focus while hidden", () => {
		assert.equal(reduce(start(), { kind: "focus" }).state.focused, false);
	});
});

describe("the cursor (S13)", () => {
	it("moves with the arrows and with j/k", () => {
		const state = browsingAlbum();

		assert.equal(key(state, "down").cursor, 1);
		assert.equal(key(state, "j").cursor, 1);
		assert.equal(key(state, "up").cursor, 0);
		assert.equal(key(key(state, "down"), "k").cursor, 0);
	});

	it("stops at both ends instead of wrapping", () => {
		const state = browsingAlbum();
		let end = state;
		for (let step = 0; step < album().length + 3; step++) end = key(end, "down");

		assert.equal(key(state, "up").cursor, 0);
		assert.equal(end.cursor, album().length - 1);
	});

	it("selects the row under it, folder or track", () => {
		const state = browsingAlbum();

		assert.equal(selectedEntry(state)?.kind, "folder");
		assert.equal(selectedEntry(key(state, "down"))?.kind, "track");
	});

	it("resets to the first row of the folder it loads", () => {
		const moved = at(browsingAlbum(), ROW.c);
		assert.equal(moved.cursor, ROW.c);

		assert.equal(loaded(moved, `${ROOT}/StreamBeats`, []).cursor, 0);
	});
});

describe("enter (S11)", () => {
	it("loads the folder under the cursor and leaves playback alone", () => {
		const reduction = press(at(playingB(), ROW.folder), "enter");

		assert.deepEqual(reduction.effects, [{ kind: "load-folder", path: `${ALBUM}/Extras` }]);
		assert.equal(reduction.state.playing?.id, B.id);
	});

	it("builds the queue from every track of the folder, in folder order, from the selected one", () => {
		const reduction = press(at(browsingAlbum(), ROW.b), "enter");

		assert.deepEqual(ids(reduction.state.queue?.tracks), ids([A, B, C, D]));
		assert.deepEqual(ids(reduction.state.queue?.playOrder), ids([A, B, C, D]));
		assert.equal(reduction.state.queue?.position, 1);
		assert.equal(reduction.state.playing?.id, B.id);
		assert.equal(reduction.state.paused, false);
		assert.deepEqual(reduction.effects, [{ kind: "play", trackId: B.id }]);
	});

	it("plays the last track as the last of the queue", () => {
		const reduction = press(at(browsingAlbum(), ROW.d), "enter");

		assert.equal(reduction.state.queue?.position, 3);
		assert.equal(reduction.state.playing?.id, D.id);
	});

	it("does nothing on a folder with no rows", () => {
		const empty = loaded(withFocus(visible(start())), ALBUM, []);

		assert.deepEqual(press(empty, "enter"), { state: empty, effects: [] });
	});
});

describe("auto-advance and the end of the queue (S11)", () => {
	it("plays the next track when one ends", () => {
		const reduction = reduce(playingB(), { kind: "track-ended", trackId: B.id });

		assert.equal(reduction.state.playing?.id, C.id);
		assert.equal(reduction.state.queue?.position, 2);
		assert.equal(reduction.state.paused, false);
		assert.deepEqual(reduction.effects, [{ kind: "play", trackId: C.id }]);
	});

	it("stops after the last track and says playlist ended", () => {
		const reduction = reduce(playingD(), { kind: "track-ended", trackId: D.id });

		assert.equal(reduction.state.playing, undefined);
		assert.equal(reduction.state.queue, undefined);
		assert.equal(reduction.state.notice, "playlist ended");
		assert.deepEqual(reduction.effects, [{ kind: "stop" }]);
	});

	it("never loops back to the first track", () => {
		const ended = reduce(playingD(), { kind: "track-ended", trackId: D.id }).state;

		assert.deepEqual(reduce(ended, { kind: "track-ended", trackId: D.id }), { state: ended, effects: [] });
	});

	it("ignores a report about a track that is not the one playing", () => {
		const state = playingB();

		assert.equal(reduce(state, { kind: "track-ended", trackId: D.id }).state, state);
	});
});

describe("moving inside the queue (S13, S11)", () => {
	it("plays the next and the previous track without ending the queue in the middle", () => {
		const next = press(playingB(), "n");
		assert.equal(next.state.playing?.id, C.id);
		assert.deepEqual(next.effects, [{ kind: "play", trackId: C.id }]);

		const previous = press(next.state, "p");
		assert.equal(previous.state.playing?.id, B.id);
		assert.deepEqual(previous.effects, [{ kind: "play", trackId: B.id }]);
	});

	it("binds > and < to the same movement", () => {
		assert.deepEqual(press(playingB(), ">"), press(playingB(), "n"));
		assert.equal(press(playing(ROW.c), "<").state.playing?.id, B.id);
	});

	it("stays on the first track when asked for the previous one", () => {
		const state = playing(ROW.a);

		assert.equal(press(state, "p").state, state);
	});

	it("ends the queue when asked for the next one after the last", () => {
		const reduction = press(playingD(), "n");

		assert.equal(reduction.state.playing, undefined);
		assert.equal(reduction.state.queue, undefined);
		assert.equal(reduction.state.notice, "playlist ended");
		assert.deepEqual(reduction.effects, [{ kind: "stop" }]);
	});

	it("does nothing when nothing is playing", () => {
		const browsing = browsingAlbum();

		assert.equal(press(browsing, "n").state, browsing);
		assert.equal(press(browsing, "p").state, browsing);
	});
});

describe("a track that cannot be opened (S11)", () => {
	it("reports it with the file name and skips to the next one", () => {
		const reduction = reduce(playingB(), { kind: "track-failed", trackId: B.id });

		assert.equal(reduction.state.notice, `${B.title}: cannot open, skipping`);
		assert.equal(reduction.state.playing?.id, C.id);
		assert.deepEqual(reduction.effects, [{ kind: "play", trackId: C.id }]);
	});

	it("treats a failing last track as the end of the queue", () => {
		const reduction = reduce(playingD(), { kind: "track-failed", trackId: D.id });

		assert.equal(reduction.state.playing, undefined);
		assert.equal(reduction.state.queue, undefined);
		assert.equal(reduction.state.notice, `${D.title}: cannot open, skipping`);
		assert.deepEqual(reduction.effects, [{ kind: "stop" }]);
	});

	it("keeps the rest of the album after a broken file", () => {
		const failed = reduce(playingB(), { kind: "track-failed", trackId: B.id }).state;
		const next = reduce(failed, { kind: "track-ended", trackId: C.id });

		assert.equal(next.state.playing?.id, D.id);
		assert.equal(next.state.notice, undefined);
	});

	it("ignores a failure reported for a track that is not the one playing", () => {
		const state = playingB();

		assert.equal(reduce(state, { kind: "track-failed", trackId: D.id }).state, state);
	});
});

describe("stop (S11)", () => {
	it("cuts playback and empties the queue", () => {
		const reduction = press(playingB(), "s");

		assert.equal(reduction.state.playing, undefined);
		assert.equal(reduction.state.paused, false);
		assert.equal(reduction.state.queue, undefined);
		assert.deepEqual(reduction.effects, [{ kind: "stop" }]);
	});

	it("leaves the folder and the cursor where they were", () => {
		const state = at(playingB(), ROW.b);
		const stopped = key(state, "s");

		assert.equal(stopped.path, state.path);
		assert.equal(stopped.cursor, state.cursor);
		assert.equal(stopped.entries.length, state.entries.length);
	});

	it("does nothing when there is nothing to stop", () => {
		const browsing = browsingAlbum();

		assert.deepEqual(press(browsing, "s"), { state: browsing, effects: [] });
	});
});

describe("pausing (S13)", () => {
	it("pauses and resumes the track that is playing", () => {
		const paused = press(playingB(), "space");
		assert.equal(paused.state.paused, true);
		assert.equal(paused.state.playing?.id, B.id);
		assert.deepEqual(paused.effects, [{ kind: "pause" }]);

		const resumed = press(paused.state, "space");
		assert.equal(resumed.state.paused, false);
		assert.deepEqual(resumed.effects, [{ kind: "resume" }]);
	});

	it("starts the next track unpaused", () => {
		const paused = key(playingB(), "space");

		assert.equal(reduce(paused, { kind: "track-ended", trackId: B.id }).state.paused, false);
	});

	it("does nothing when nothing is playing", () => {
		const browsing = browsingAlbum();

		assert.deepEqual(press(browsing, "space"), { state: browsing, effects: [] });
	});
});

describe("shuffle (S11)", () => {
	it("permutes only what is left, keeps the current track playing and the cursor still", () => {
		const state = playingB();
		const reduction = press(state, "z", fixed);

		assert.equal(reduction.state.shuffle, true);
		assert.equal(reduction.state.notice, "shuffle on");
		assert.equal(reduction.state.playing?.id, B.id);
		assert.equal(reduction.state.cursor, state.cursor);
		assert.equal(reduction.state.queue?.position, 1);
		assert.deepEqual(ids(reduction.state.queue?.playOrder), ids([A, B, D, C]));
		assert.deepEqual(reduction.effects, []);
	});

	it("restores the folder order when turned off", () => {
		const shuffled = press(playingB(), "z", fixed).state;
		const restored = press(shuffled, "z", fixed).state;

		assert.equal(restored.shuffle, false);
		assert.equal(restored.notice, "shuffle off");
		assert.equal(restored.playing?.id, B.id);
		assert.deepEqual(ids(restored.queue?.playOrder), ids([A, B, C, D]));
	});

	it("plays the shuffled remainder in its new order", () => {
		const shuffled = key(playingB(), "z", fixed);

		assert.equal(key(shuffled, "n").playing?.id, D.id);
	});

	it("toggles the flag with no queue and still reports the state", () => {
		const reduction = press(browsingAlbum(), "z", fixed);

		assert.equal(reduction.state.shuffle, true);
		assert.equal(reduction.state.notice, "shuffle on");
		assert.equal(reduction.state.queue, undefined);
		assert.deepEqual(reduction.effects, []);
	});

	it("shuffles the remainder of a queue built while it is on", () => {
		const browsing = key(browsingAlbum(), "z", fixed);
		const reduction = press(at(browsing, ROW.a), "enter", fixed);

		assert.equal(reduction.state.playing?.id, A.id);
		assert.deepEqual(ids(reduction.state.queue?.playOrder), ids([A, C, D, B]));
	});
});

describe("volume (S11)", () => {
	it("steps up and down and tells the player", () => {
		const up = press(browsingAlbum(), "+");
		assert.equal(up.state.volume, 75);
		assert.deepEqual(up.effects, [{ kind: "volume", level: 75 }]);

		const down = press(up.state, "-");
		assert.equal(down.state.volume, 70);
		assert.deepEqual(down.effects, [{ kind: "volume", level: 70 }]);
	});

	it("clamps at 100 and at 0", () => {
		let loud = browsingAlbum();
		for (let step = 0; step < 20; step++) loud = key(loud, "+");
		assert.equal(loud.volume, 100);
		assert.deepEqual(press(loud, "+"), { state: loud, effects: [] });

		let quiet = loud;
		for (let step = 0; step < 30; step++) quiet = key(quiet, "-");
		assert.equal(quiet.volume, 0);
		assert.deepEqual(press(quiet, "-"), { state: quiet, effects: [] });
	});
});

describe("navigating up (S14)", () => {
	it("moves to the parent folder below the ceiling", () => {
		const reduction = press(browsingAlbum(), "u");

		assert.equal(reduction.state.path, `${ROOT}/StreamBeats`);
		assert.deepEqual(reduction.state.entries, []);
		assert.equal(reduction.state.cursor, 0);
		assert.deepEqual(reduction.effects, [{ kind: "load-folder", path: `${ROOT}/StreamBeats` }]);
	});

	it("binds backspace to the same move", () => {
		assert.deepEqual(press(browsingAlbum(), "backspace"), press(browsingAlbum(), "u"));
	});

	it("walks up to the ceiling and stops there with at home", () => {
		let state = browsingAlbum();
		for (let step = 0; step < 3; step++) state = press(state, "u").state;
		assert.equal(state.path, HOME);

		const reduction = press(state, "u");
		assert.equal(reduction.state.path, HOME);
		assert.equal(reduction.state.notice, "at home");
		assert.deepEqual(reduction.effects, []);
	});

	it("reads a Windows path in its own flavour", () => {
		const state = loaded(
			withFocus(visible(initialState({ libraryRoot: "C:\\Users\\kike\\Music", ceiling: "C:\\Users\\kike" }))),
			"C:\\Users\\kike\\Music",
			[],
		);

		assert.deepEqual(press(state, "u").effects, [{ kind: "load-folder", path: "C:\\Users\\kike" }]);
	});

	it("never interrupts playback when the folder changes", () => {
		const moved = press(playingB(), "u").state;

		assert.equal(moved.playing?.id, B.id);
		assert.equal(moved.queue?.position, 1);
		assert.deepEqual(ids(moved.queue?.playOrder), ids([A, B, C, D]));
	});

	it("clears the notice once a folder loads", () => {
		let atHome = playingB();
		for (let step = 0; step < 4; step++) atHome = press(atHome, "u").state;
		assert.equal(atHome.notice, "at home");

		assert.equal(loaded(atHome, `${ROOT}/StreamBeats`, []).notice, undefined);
	});
});

describe("the filter over the current folder (S18)", () => {
	it("opens with / and keeps browsing the very same folder and listing", () => {
		const state = browsingAlbum();
		const opened = key(state, "/");

		assert.equal(opened.filtering, true);
		assert.equal(opened.filter, "");
		assert.equal(opened.path, state.path);
		assert.deepEqual(visibleEntries(opened), visibleEntries(state));
	});

	it("narrows the listing incrementally and case-insensitively", () => {
		const first = typing(browsingAlbum(), "0");
		assert.equal(visibleEntries(first).length, 4);

		const narrowed = key(first, "4");
		assert.deepEqual(visibleEntries(narrowed).map(nameOf), ["04 - D.mp3"]);

		assert.deepEqual(visibleEntries(typing(browsingAlbum(), "EXTRAS")).map(nameOf), ["Extras"]);
		assert.deepEqual(visibleEntries(typing(browsingAlbum(), "extras")).map(nameOf), ["Extras"]);
	});

	it("matches row names, not the folder path behind them", () => {
		// Every row lives under .../Chillhop; none of their own names starts with it (S18).
		const state = typing(browsingAlbum(), "Chillhop");

		assert.deepEqual(visibleEntries(state), []);
	});

	it("keeps the cursor in range while the listing narrows under it", () => {
		const moved = at(browsingAlbum(), ROW.d);
		assert.equal(moved.cursor, 4);

		const narrowed = typing(moved, "0");
		assert.equal(visibleEntries(narrowed).length, 4);
		assert.equal(narrowed.cursor, 3);

		const single = key(narrowed, "4");
		assert.equal(visibleEntries(single).length, 1);
		assert.equal(single.cursor, 0);
	});

	it("leaves the mode with enter and puts the cursor on the first result", () => {
		const narrowed = typing(at(browsingAlbum(), ROW.d), "0");
		const reduction = press(narrowed, "enter");

		assert.equal(reduction.state.filtering, false);
		assert.equal(reduction.state.filter, "0");
		assert.equal(reduction.state.cursor, 0);
		assert.equal(selectedEntry(reduction.state)?.kind, "track");
		assert.deepEqual(reduction.effects, []);
	});

	it("clears the term and leaves the mode with esc, without hiding the card", () => {
		const narrowed = typing(browsingAlbum(), "0");
		const cleared = key(narrowed, "escape");

		assert.equal(cleared.filter, "");
		assert.equal(cleared.filtering, false);
		assert.equal(cleared.presence, "visible");
		assert.deepEqual(visibleEntries(cleared), cleared.entries);
	});

	it("hides the card when esc finds nothing to clear (S13, S18)", () => {
		const hidden = key(key(browsingAlbum(), "/"), "escape");

		assert.equal(hidden.presence, "hidden");
		assert.equal(hidden.filtering, false);
	});

	it("clears a confirmed filter with esc before hiding the card", () => {
		const confirmed = key(typing(browsingAlbum(), "0"), "enter");
		assert.equal(confirmed.presence, "visible");

		const cleared = key(confirmed, "escape");
		assert.equal(cleared.filter, "");
		assert.equal(cleared.presence, "visible");

		assert.equal(key(cleared, "escape").presence, "hidden");
	});

	it("deletes the last typed character with backspace instead of going up a folder", () => {
		const narrowed = typing(browsingAlbum(), "04");
		const reduction = press(narrowed, "backspace");

		assert.equal(reduction.state.filter, "0");
		assert.equal(reduction.state.filtering, true);
		assert.equal(reduction.state.path, ALBUM);
		assert.deepEqual(reduction.effects, []);
	});

	it("still goes up a folder with backspace and u outside the mode", () => {
		const state = browsingAlbum();

		assert.equal(press(state, "backspace").state.path, `${ROOT}/StreamBeats`);
		assert.deepEqual(press(state, "backspace"), press(state, "u"));
	});

	it("types the transport letters instead of acting on playback while the mode is on", () => {
		const opened = key(playing(ROW.b), "/");

		assert.equal(key(opened, "s").filter, "s");
		assert.equal(key(opened, "s").playing?.id, B.id);
		assert.deepEqual(press(opened, "s").effects, []);
		assert.equal(key(opened, "z").shuffle, false);
		assert.equal(key(opened, "+").volume, 70);
		assert.equal(key(opened, "space").filter, " ");
	});

	it("keeps the arrows moving the cursor inside the narrowed listing", () => {
		const narrowed = typing(browsingAlbum(), "0");

		assert.equal(key(narrowed, "down").cursor, 1);
		assert.equal(key(key(narrowed, "down"), "up").cursor, 0);
	});

	it("reports no results as a state that keeps and names the term", () => {
		const empty = typing(browsingAlbum(), "zzz");

		assert.equal(empty.filter, "zzz");
		assert.equal(empty.filtering, true);
		assert.deepEqual(visibleEntries(empty), []);
		assert.equal(selectedEntry(empty), undefined);
		assert.equal(key(empty, "enter").filter, "zzz");
	});

	it("ignores / while the mode is already on", () => {
		const opened = key(browsingAlbum(), "/");

		assert.equal(press(opened, "/").state, opened);
	});

	it("drops the filter when the card moves to another folder", () => {
		const narrowed = typing(browsingAlbum(), "Ext");
		const confirmed = key(narrowed, "enter");
		const entered = press(confirmed, "enter");

		assert.deepEqual(entered.effects, [{ kind: "load-folder", path: `${ALBUM}/Extras` }]);
		assert.equal(entered.state.filter, "");
		assert.equal(entered.state.filtering, false);

		const reloaded = loaded(typing(browsingAlbum(), "0"), ROOT, []);
		assert.equal(reloaded.filter, "");
		assert.equal(reloaded.filtering, false);

		const up = press(key(typing(browsingAlbum(), "0"), "enter"), "u");
		assert.equal(up.state.filter, "");
	});

	it("gives up the mode when the card loses the keyboard, keeping the term", () => {
		const narrowed = typing(browsingAlbum(), "0");
		const blurred = reduce(narrowed, { kind: "blur" }).state;

		assert.equal(blurred.filtering, false);
		assert.equal(blurred.filter, "0");
	});

	it("forgets the filter when the card hides", () => {
		const hidden = reduce(typing(playing(ROW.b), "0"), { kind: "overlay" }).state;

		assert.equal(hidden.presence, "hidden");
		assert.equal(hidden.filter, "");
		assert.equal(hidden.filtering, false);
	});

	it("does not mutate the state it filters and answers the same input the same way", () => {
		const state = deepFreeze(typing(browsingAlbum(), "0"));
		const snapshot = structuredClone(state);

		press(state, "4");
		press(state, "backspace");
		press(state, "enter");
		press(state, "escape");

		assert.deepEqual(state, snapshot);
		assert.deepEqual(press(state, "4"), press(state, "4"));
	});
});

describe("the reducer stays pure (S8, AGENTS.md)", () => {
	it("does not mutate the state it receives", () => {
		const state = deepFreeze(playingB());
		const snapshot = structuredClone(state);

		press(state, "down");
		press(state, "z", fixed);
		press(state, "u");
		reduce(state, { kind: "track-ended", trackId: B.id });
		reduce(state, { kind: "track-failed", trackId: B.id });

		assert.deepEqual(state, snapshot);
	});

	it("answers the same input with the same output", () => {
		const state = playingB();

		assert.deepEqual(press(state, "n"), press(state, "n"));
		assert.deepEqual(press(state, "z", fixed), press(state, "z", fixed));
		assert.deepEqual(reduce(state, { kind: "track-ended", trackId: B.id }), press(state, "n"));
	});

	it("returns the same state object when an event changes nothing", () => {
		const state = playingB();
		const unfocused = reduce(state, { kind: "blur" }).state;

		assert.equal(press(unfocused, "l").state, unfocused);
		assert.equal(press(state, "q").state, state);
		assert.equal(reduce(state, { kind: "focus" }).state, state);
	});
});
