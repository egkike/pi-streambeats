/**
 * The card state machine (S3, S11, S13, S15). Every test is pure: no filesystem, no mpv, no clock,
 * no terminal. A state and an event go in; a new state and effects as data come out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	actionFor,
	type CardState,
	catalogTrackId,
	currentView,
	DEFAULT_SOURCE,
	footerHints,
	initialState,
	KEY_BINDINGS,
	type KeyAction,
	type ModelDeps,
	parseCatalogTrackId,
	type Reduction,
	reduce,
	type SourceView,
	selectedEntry,
	TOP_OF_CATALOG,
	visibleEntries,
} from "../../lib/core/model.ts";
import type { CatalogAlbum, CatalogAlbumListing, Folder, LibraryEntry, Track } from "../../lib/types.ts";

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

/** The listing on screen, which the model reads through exactly one selector (S20). */
function view(state: CardState): SourceView {
	return currentView(state);
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
	while (view(moved).cursor > row) moved = key(moved, "up");
	while (view(moved).cursor < row) moved = key(moved, "down");
	return moved;
}

/** The card showing the album, on screen and holding the keyboard. */
function browsingAlbum(): CardState {
	return loaded(withFocus(local(visible(start()))), ALBUM, album());
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

/** The local library, which is one `l` away from the catalog the card opens on (S20, L74). */
function local(state: CardState): CardState {
	return key(state, "l");
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
		Object.freeze(value);
	}
	return value;
}

describe("the starting state (S15, S14, S11, S20)", () => {
	it("is hidden, in the corner, on the catalog, and playing nothing", () => {
		const state = start();

		assert.equal(state.presence, "hidden");
		assert.equal(state.size, "corner");
		assert.equal(state.focused, false);
		// The card opens in the catalog (S20, L74); the library waits at its own root, unread.
		assert.equal(state.source, DEFAULT_SOURCE);
		assert.equal(state.source, "catalog");
		assert.equal(view(state).path, "", "the catalog's root is the album list");
		assert.deepEqual(view(state).entries, []);
		assert.equal(view(state).cursor, 0);
		assert.deepEqual(state.sources.library, { path: ROOT, entries: [], cursor: 0, loaded: false });
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
		assert.equal(state.sources.library.path, "/srv/music");
	});

	it("reserves an empty filter term for S18 and reads the listing through one selector", () => {
		const state = browsingAlbum();

		assert.equal(state.filter, "");
		assert.deepEqual(visibleEntries(state), view(state).entries);
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

	it("prints each hinted label once, so a merged hint cannot be duplicated back into the row (L117, R2-001)", () => {
		// `+/- vol` lives on the `volume-up` binding and `-` stays dispatch-only. Nothing in the type stops a
		// later edit from re-flagging `-`, so the printed labels are what this pins: one glyph set, one cell.
		const labels = footerHints().map((hint) => hint.key);

		assert.deepEqual(labels, [...new Set(labels)]);
		assert.equal(labels.includes("+/-"), true);
	});

	it("announces both volume directions with one hint and still dispatches both (S13, L117)", () => {
		const keys = footerHints().map((hint) => hint.key);

		// Two hints of the same word (`+ vol · - vol`) spent six cells the row did not have; one `+/- vol`
		// buys them back. The table keeps both bindings, so only what the footer prints merged.
		assert.equal(keys.includes("+/-"), true);
		assert.equal(keys.includes("+"), false);
		assert.equal(keys.includes("-"), false);
		assert.equal(actionFor("+"), "volume-up");
		assert.equal(actionFor("-"), "volume-down");
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

		assert.equal(view(key(state, "down")).cursor, 1);
		assert.equal(view(key(state, "j")).cursor, 1);
		assert.equal(view(key(state, "up")).cursor, 0);
		assert.equal(view(key(key(state, "down"), "k")).cursor, 0);
	});

	it("stops at both ends instead of wrapping", () => {
		const state = browsingAlbum();
		let end = state;
		for (let step = 0; step < album().length + 3; step++) end = key(end, "down");

		assert.equal(view(key(state, "up")).cursor, 0);
		assert.equal(view(end).cursor, album().length - 1);
	});

	it("selects the row under it, folder or track", () => {
		const state = browsingAlbum();

		assert.equal(selectedEntry(state)?.kind, "folder");
		assert.equal(selectedEntry(key(state, "down"))?.kind, "track");
	});

	it("resets to the first row of the folder it loads", () => {
		const moved = at(browsingAlbum(), ROW.c);
		assert.equal(view(moved).cursor, ROW.c);

		assert.equal(view(loaded(moved, `${ROOT}/StreamBeats`, [])).cursor, 0);
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

		assert.equal(view(stopped).path, view(state).path);
		assert.equal(view(stopped).cursor, view(state).cursor);
		assert.equal(view(stopped).entries.length, view(state).entries.length);
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

/**
 * The transport shortcuts (S22): the keys are registered with the host, so they arrive while the card
 * is HIDDEN — the presence guard that makes card keys honest would turn every one of them into a
 * no-op. The event is separate on purpose, and these tests pin both halves of that decision.
 */
describe("the transport shortcuts (S22)", () => {
	it("pauses and resumes a playing track while the card is hidden", () => {
		const hidden = key(playingB(), "escape");
		assert.equal(hidden.presence, "hidden");
		assert.equal(hidden.playing?.id, B.id);

		const paused = reduce(hidden, { kind: "transport", action: "toggle-pause" });
		assert.equal(paused.state.paused, true);
		assert.equal(paused.state.playing?.id, B.id, "the same track keeps playing");
		assert.deepEqual(paused.effects, [{ kind: "pause" }]);

		const resumed = reduce(paused.state, { kind: "transport", action: "toggle-pause" });
		assert.equal(resumed.state.paused, false);
		assert.deepEqual(resumed.effects, [{ kind: "resume" }]);
	});

	it("moves the queue forward and back while the card is hidden", () => {
		const hidden = key(playingB(), "escape");

		const next = reduce(hidden, { kind: "transport", action: "next" });
		assert.equal(next.state.playing?.id, C.id);
		assert.deepEqual(next.effects, [{ kind: "play", trackId: C.id }]);

		const previous = reduce(next.state, { kind: "transport", action: "previous" });
		assert.equal(previous.state.playing?.id, B.id);
		assert.deepEqual(previous.effects, [{ kind: "play", trackId: B.id }]);
	});

	it("keeps the presence guard on the key path, so a hidden card still ignores those keys", () => {
		// The transport event must not become a back door for card keys: the same three actions, asked
		// for as keys on a hidden card, stay no-ops.
		const hidden = key(playingB(), "escape");

		assert.equal(press(hidden, "space").state, hidden);
		assert.equal(press(hidden, "n").state, hidden);
		assert.equal(press(hidden, "p").state, hidden);
	});

	it("does nothing when the queue is empty", () => {
		// Nothing playing, nothing queued: a shortcut pressed from the editor has nothing to act on.
		const browsing = key(browsingAlbum(), "escape");

		assert.deepEqual(reduce(browsing, { kind: "transport", action: "toggle-pause" }), {
			state: browsing,
			effects: [],
		});
		assert.deepEqual(reduce(browsing, { kind: "transport", action: "next" }), { state: browsing, effects: [] });
		assert.deepEqual(reduce(browsing, { kind: "transport", action: "previous" }), {
			state: browsing,
			effects: [],
		});
	});
});

describe("shuffle (S11)", () => {
	it("permutes only what is left, keeps the current track playing and the cursor still", () => {
		const state = playingB();
		const reduction = press(state, "z", fixed);

		assert.equal(reduction.state.shuffle, true);
		assert.equal(reduction.state.notice, "shuffle on");
		assert.equal(reduction.state.playing?.id, B.id);
		assert.equal(view(reduction.state).cursor, view(state).cursor);
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

		assert.equal(view(reduction.state).path, `${ROOT}/StreamBeats`);
		assert.deepEqual(view(reduction.state).entries, []);
		assert.equal(view(reduction.state).cursor, 0);
		assert.deepEqual(reduction.effects, [{ kind: "load-folder", path: `${ROOT}/StreamBeats` }]);
	});

	it("binds backspace to the same move", () => {
		assert.deepEqual(press(browsingAlbum(), "backspace"), press(browsingAlbum(), "u"));
	});

	it("walks up to the ceiling and stops there with at home", () => {
		let state = browsingAlbum();
		for (let step = 0; step < 3; step++) state = press(state, "u").state;
		assert.equal(view(state).path, HOME);

		const reduction = press(state, "u");
		assert.equal(view(reduction.state).path, HOME);
		assert.equal(reduction.state.notice, "at home");
		assert.deepEqual(reduction.effects, []);
	});

	it("reads a Windows path in its own flavour", () => {
		const state = loaded(
			withFocus(local(visible(initialState({ libraryRoot: "C:\\Users\\kike\\Music", ceiling: "C:\\Users\\kike" })))),
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

describe("the card says what it is reading (S21, L62)", () => {
	// The scan runs on the input path, so the card paints before the listing exists. Without this state
	// an empty folder and a folder that has not arrived yet look exactly the same.
	it("records the folder the host started to read", () => {
		const reading = reduce(playingB(), { kind: "folder-reading", path: ALBUM }).state;

		assert.equal(reading.reading, ALBUM);
	});

	it("clears it when the listing arrives", () => {
		const reading = reduce(playingB(), { kind: "folder-reading", path: ALBUM }).state;

		assert.equal(loaded(reading, ALBUM, []).reading, undefined);
	});

	it("clears it when the read fails, so the failure owns the footer alone", () => {
		const reading = reduce(playingB(), { kind: "folder-reading", path: ALBUM }).state;
		const failed = reduce(reading, { kind: "notice", text: "cannot show /x: missing" }).state;

		assert.equal(failed.reading, undefined);
		assert.equal(failed.notice, "cannot show /x: missing");
	});
});

describe("a folder that could not be shown (S5, S15)", () => {
	// The failure travels as data, not as a sentence: the host owns no path formatter, and the footer
	// has to name the folder the way the header does (a breadcrumb, never an absolute home path).
	it("records the folder and why as data, replacing an older notice", () => {
		const noticed = reduce(playingB(), { kind: "notice", text: "playlist ended" }).state;
		const failed = reduce(noticed, { kind: "folder-failed", path: ALBUM, reason: "missing" }).state;

		assert.deepEqual(failed.failure, { path: ALBUM, reason: "missing" });
		assert.equal(failed.notice, undefined, "the failure is not squeezed into a notice");
		assert.equal(failed.reading, undefined, "a read that ended badly is not still reading");
	});

	it("is cleared by a folder that loads", () => {
		const failed = reduce(playingB(), { kind: "folder-failed", path: ALBUM, reason: "missing" }).state;

		assert.equal(loaded(failed, ALBUM, []).failure, undefined);
	});

	it("gives way to a later notice, so a stale failure cannot outlive its folder", () => {
		const failed = reduce(playingB(), { kind: "folder-failed", path: ALBUM, reason: "missing" }).state;
		const replaced = reduce(failed, { kind: "notice", text: "playlist ended" }).state;

		assert.equal(replaced.failure, undefined);
		assert.equal(replaced.notice, "playlist ended");
	});
});

describe("the filter over the current folder (S18)", () => {
	it("opens with / and keeps browsing the very same folder and listing", () => {
		const state = browsingAlbum();
		const opened = key(state, "/");

		assert.equal(opened.filtering, true);
		assert.equal(opened.filter, "");
		assert.equal(view(opened).path, view(state).path);
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
		assert.equal(view(moved).cursor, 4);

		const narrowed = typing(moved, "0");
		assert.equal(visibleEntries(narrowed).length, 4);
		assert.equal(view(narrowed).cursor, 3);

		const single = key(narrowed, "4");
		assert.equal(visibleEntries(single).length, 1);
		assert.equal(view(single).cursor, 0);
	});

	it("leaves the mode with enter and puts the cursor on the first result", () => {
		const narrowed = typing(at(browsingAlbum(), ROW.d), "0");
		const reduction = press(narrowed, "enter");

		assert.equal(reduction.state.filtering, false);
		assert.equal(reduction.state.filter, "0");
		assert.equal(view(reduction.state).cursor, 0);
		assert.equal(selectedEntry(reduction.state)?.kind, "track");
		assert.deepEqual(reduction.effects, []);
	});

	it("clears the term and leaves the mode with esc, without hiding the card", () => {
		const narrowed = typing(browsingAlbum(), "0");
		const cleared = key(narrowed, "escape");

		assert.equal(cleared.filter, "");
		assert.equal(cleared.filtering, false);
		assert.equal(cleared.presence, "visible");
		assert.deepEqual(visibleEntries(cleared), view(cleared).entries);
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
		assert.equal(view(reduction.state).path, ALBUM);
		assert.deepEqual(reduction.effects, []);
	});

	it("still goes up a folder with backspace and u outside the mode", () => {
		const state = browsingAlbum();

		assert.equal(view(press(state, "backspace").state).path, `${ROOT}/StreamBeats`);
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

		assert.equal(view(key(narrowed, "down")).cursor, 1);
		assert.equal(view(key(key(narrowed, "down"), "up")).cursor, 0);
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

describe("the mouse (S17)", () => {
	/** A click on a row the renderer reported, carrying the row index its hit map gave it. */
	function click(state: CardState, index: number): Reduction {
		return reduce(state, { kind: "click", index });
	}

	/** Rows down the listing (positive) or up it (negative), as the wheel reports them. */
	function wheel(state: CardState, delta: number): Reduction {
		return reduce(state, { kind: "wheel", delta });
	}

	function hover(state: CardState, index?: number): CardState {
		return reduce(state, { kind: "hover", index }).state;
	}

	it("selects the row a click lands on and plays the track under it", () => {
		const clicked = click(browsingAlbum(), ROW.c);

		assert.equal(view(clicked.state).cursor, ROW.c, "the click selects before it activates");
		assert.equal(clicked.state.playing?.id, C.id);
		assert.deepEqual(clicked.effects, [{ kind: "play", trackId: C.id }]);
		assert.deepEqual(ids(clicked.state.queue?.tracks), [A.id, B.id, C.id, D.id], "the folder is still the queue");
	});

	it("enters the folder a click lands on", () => {
		const clicked = click(browsingAlbum(), ROW.folder);

		assert.deepEqual(clicked.effects, [{ kind: "load-folder", path: `${ALBUM}/Extras` }]);
		assert.equal(view(clicked.state).path, `${ALBUM}/Extras`);
		assert.equal(view(clicked.state).cursor, 0, "a new folder starts at its first row");
	});

	it("ignores a click on a row the card is not showing", () => {
		const state = browsingAlbum();

		assert.equal(click(state, 99).state, state);
		assert.deepEqual(click(state, 99).effects, []);
		assert.deepEqual(click(state, -1).effects, []);
	});

	it("scrolls the listing with the wheel", () => {
		assert.equal(view(wheel(browsingAlbum(), 1).state).cursor, ROW.a);
		assert.equal(view(wheel(at(browsingAlbum(), ROW.c), -1).state).cursor, ROW.b);
	});

	it("stops the wheel at both ends instead of wrapping", () => {
		assert.equal(view(wheel(browsingAlbum(), -3).state).cursor, ROW.folder);
		assert.equal(view(wheel(at(browsingAlbum(), ROW.d), 4).state).cursor, ROW.d);

		const state = browsingAlbum();
		assert.equal(wheel(state, 0).state, state, "no movement is not a new state");
	});

	it("never scrolls playback, only the listing", () => {
		const scrolled = wheel(playingB(), 1);

		assert.deepEqual(scrolled.effects, []);
		assert.equal(scrolled.state.playing?.id, B.id);
	});

	it("highlights the row under the pointer", () => {
		assert.equal(hover(browsingAlbum(), ROW.c).hover, ROW.c);
	});

	it("clears the highlight when the pointer leaves the rows or points at none", () => {
		const highlighted = hover(browsingAlbum(), ROW.c);

		assert.equal(hover(highlighted).hover, undefined);
		assert.equal(hover(highlighted, 99).hover, undefined, "a row that is not on screen cannot be highlighted");
	});

	it("leaves the keyboard where it was: hovering never moves the cursor", () => {
		const state = hover(at(browsingAlbum(), ROW.b), ROW.d);

		assert.equal(view(state).cursor, ROW.b);
		assert.equal(press(state, "enter").state.playing?.id, B.id, "enter still opens what the keyboard selected");
	});

	it("drops the highlight as soon as a key arrives, because the keyboard takes over", () => {
		const pressed = press(hover(browsingAlbum(), ROW.d), "down").state;

		assert.equal(pressed.hover, undefined);
		assert.equal(view(pressed).cursor, ROW.a, "and the key still does exactly what it did before");
	});

	it("forgets the highlight when the listing changes under it or the card hides", () => {
		const highlighted = hover(browsingAlbum(), ROW.d);

		assert.equal(loaded(highlighted, ROOT, []).hover, undefined);
		assert.equal(reduce(highlighted, { kind: "overlay" }).state.hover, undefined);
	});

	it("ignores the pointer while the card is not on screen", () => {
		const hidden = start();

		assert.equal(click(hidden, ROW.a).state, hidden);
		assert.equal(reduce(hidden, { kind: "hover", index: ROW.a }).state, hidden);
		assert.equal(wheel(hidden, 1).state, hidden);
	});

	it("activates the clicked row while the filter is open, exactly as it does otherwise", () => {
		// S17 does not carve the filter mode out, so the literal rule applies: a click selects and
		// activates the row it lands on, which here is the only visible result (S18).
		const clicked = click(typing(browsingAlbum(), "B"), 0);

		assert.equal(clicked.state.playing?.id, B.id);
	});
});

describe("the reducer stays pure (S8, AGENTS.md)", () => {
	it("does not mutate the state it receives", () => {
		const state = deepFreeze(playingB());
		const snapshot = structuredClone(state);

		press(state, "down");
		press(state, "z", fixed);
		press(state, "u");
		press(state, "l");
		reduce(state, { kind: "track-ended", trackId: B.id });
		reduce(state, { kind: "track-failed", trackId: B.id });
		reduce(state, { kind: "hover", index: ROW.c });
		reduce(state, { kind: "click", index: ROW.a });
		reduce(state, { kind: "wheel", delta: 1 });
		reduce(state, { kind: "catalog-albums", albums: [CHILLHOP] });
		reduce(state, { kind: "catalog-album", album: albumListing("chillhop", ["First"]) });
		reduce(state, { kind: "catalog-reading", label: "catalog" });
		reduce(state, { kind: "catalog-failed", reason: "network" });

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

		assert.equal(press(unfocused, "x").state, unfocused);
		assert.equal(press(state, "q").state, state);
		assert.equal(reduce(state, { kind: "focus" }).state, state);
	});
});

/* --- the second source (S20) ----------------------------------------------------------------- */

const CHILLHOP: CatalogAlbum = { slug: "chillhop", title: "Chillhop" };
const LOFI: CatalogAlbum = { slug: "lofi", title: "LoFi" };
/** A new album that lands ON TOP of the list: the case L75's rule exists for. */
const SUNSET: CatalogAlbum = { slug: "sunset", title: "Sunset" };

function albumListing(slug: string, titles: readonly string[]): CatalogAlbumListing {
	return {
		slug,
		title: slug,
		tracks: titles.map((title) => ({ slug: title.toLowerCase().replaceAll(" ", "-"), title })),
	};
}

/** The catalog's album list arrived. */
function catalogAlbums(state: CardState, list: readonly CatalogAlbum[] = [CHILLHOP, LOFI]): CardState {
	return reduce(state, { kind: "catalog-albums", albums: list }).state;
}

/** One album page arrived. */
function albumPage(state: CardState, album: CatalogAlbumListing): CardState {
	return reduce(state, { kind: "catalog-album", album }).state;
}

/** The card on the catalog, open and holding the keyboard, showing the album list. */
function browsingCatalog(): CardState {
	return withFocus(visible(catalogAlbums(start())));
}

/** The card inside `Chillhop`, its three tracks on screen. */
function insideAlbum(): CardState {
	const entered = press(at(browsingCatalog(), 0), "enter").state;
	return albumPage(entered, albumListing("chillhop", ["First", "Second", "Third"]));
}

function switchSource(state: CardState): Reduction {
	return press(state, "l");
}

describe("the key that switches sources (S13, S20)", () => {
	it("is one action for both directions, announced once in the footer from the same table", () => {
		assert.equal(actionFor("l"), "switch-source");

		const hints = footerHints().filter((hint) => hint.action === "switch-source");
		assert.deepEqual(hints, [{ key: "l", help: "source", action: "switch-source" }]);
	});
});

describe("reading a source only when it was never read (T34)", () => {
	it("does not re-read a library folder that was read and is legitimately empty", () => {
		// An empty array means two different things: "nobody looked" and "there is nothing there". Asking
		// again on every round trip spends a disk scan on an answer the card already has.
		const emptyFolder = loaded(local(visible(start())), `${ROOT}/Empty`, []);
		assert.deepEqual(view(emptyFolder).entries, [], "the folder really is empty");
		assert.equal(emptyFolder.source, "library");

		// The assertion has to be on the trip *back*: pressing `l` reports the effects of the switch it
		// performs, and measuring the trip away would only prove that the catalog asks for nothing.
		const back = press(local(emptyFolder), "l");

		assert.equal(back.state.source, "library");
		assert.deepEqual(back.effects, [], "a folder that was read is not read again");
	});

	it("still reads a view nobody has read", () => {
		const reduction = press(visible(start()), "l");

		assert.equal(reduction.state.source, "library");
		assert.deepEqual(reduction.effects, [{ kind: "load-folder", path: ROOT }]);
	});

	it("still retries a folder whose read failed, because a failure is not an answer", () => {
		// A latch that only looked at `entries` would look right here by accident; one that remembered the
		// request instead of the answer would leave the card empty for the session after one bad mount.
		const failed = reduce(local(visible(start())), { kind: "folder-failed", path: ROOT, reason: "missing" }).state;

		const back = press(local(failed), "l");

		assert.equal(back.state.source, "library");
		assert.deepEqual(back.effects, [{ kind: "load-folder", path: ROOT }]);
	});
});

describe("switching sources (S20, L79)", () => {
	it("moves to the other source and asks for it when it has never been read", () => {
		const reduction = switchSource(visible(start()));

		assert.equal(reduction.state.source, "library");
		// The library's own path, which is where it left off — `libraryRoot` until it is asked for once.
		assert.deepEqual(reduction.effects, [{ kind: "load-folder", path: ROOT }]);
	});

	it("asks the filesystem for nothing when it goes back to a catalog no one has read", () => {
		// The catalog's read is the network's and arrives with its own effect; a `load-folder` here would hand the
		// scanner an album slug — or the empty string — and answer with a folder failure that is not one.
		const reduction = switchSource(browsingAlbum());

		assert.equal(reduction.state.source, "catalog");
		assert.deepEqual(reduction.effects, []);
	});

	it("brings each source back exactly where it was, never to the top", () => {
		// The library is left on row `ROW.c`, the catalog on its second album; both must survive the trip.
		const library = at(browsingAlbum(), ROW.c);
		const catalog = at(catalogAlbums(switchSource(library).state), 1);
		assert.equal(view(catalog).cursor, 1);

		const backToLibrary = switchSource(catalog).state;
		assert.equal(backToLibrary.source, "library");
		assert.equal(view(backToLibrary).path, ALBUM);
		assert.equal(view(backToLibrary).cursor, ROW.c, "the library's cursor comes back too");

		const backToCatalog = switchSource(backToLibrary).state;
		assert.equal(backToCatalog.source, "catalog");
		assert.equal(view(backToCatalog).cursor, 1, "and the catalog's did not move either");
	});

	it("does not ask again for a source that already has its listing", () => {
		const library = at(browsingAlbum(), ROW.c);
		const reduction = switchSource({ ...library, source: "catalog" });

		assert.equal(reduction.state.source, "library");
		assert.deepEqual(reduction.effects, [], "the listing is already there: nothing to read");
	});

	it("drops the filter, because a term belongs to the listing it was typed in (S18)", () => {
		// While the mode is open the key is text, like every other letter (S18): it is the same `l`,
		// resolved by the innermost mode first.
		const typing_l = key(typing(browsingAlbum(), "0"), "l");
		assert.equal(typing_l.filtering, true);
		assert.equal(typing_l.filter, "0l");

		const confirmed = key(typing(browsingAlbum(), "04"), "enter");
		const switched = switchSource(confirmed).state;
		assert.equal(switched.source, "catalog");
		assert.equal(switched.filter, "", "the term does not travel to a listing it was not typed in");
		assert.equal(switched.filtering, false);
	});

	it("leaves the queue alone: what is playing is not what is being looked at (S11)", () => {
		const playing = playingB();
		const switched = switchSource(playing).state;

		assert.equal(switched.playing?.id, B.id);
		assert.equal(switched.queue?.source, "library");
		assert.deepEqual(ids(switched.queue?.playOrder), ids([A, B, C, D]));
	});
});

describe("the catalog's two levels (S20, L76)", () => {
	it("lists an album as a folder whose path is its slug, so enter and u work the same as on disk", () => {
		const rows = visibleEntries(browsingCatalog());

		assert.deepEqual(rows, [
			{ kind: "folder", folder: { path: "chillhop", name: "Chillhop" } },
			{ kind: "folder", folder: { path: "lofi", name: "LoFi" } },
		]);
	});

	it("enters an album and asks for its page, then shows its tracks", () => {
		const entered = press(browsingCatalog(), "enter");

		assert.equal(view(entered.state).path, "chillhop");
		assert.deepEqual(entered.effects, [{ kind: "load-folder", path: "chillhop" }]);

		const loaded = albumPage(entered.state, albumListing("chillhop", ["First", "Second"]));
		assert.deepEqual(visibleEntries(loaded).map(nameOf), ["First", "Second"]);
	});

	it("says `top of the catalog` at the album list instead of staying silent", () => {
		const reduction = press(browsingCatalog(), "u");

		assert.equal(reduction.state.notice, TOP_OF_CATALOG);
		assert.equal(reduction.state.notice, "top of the catalog");
		assert.deepEqual(reduction.effects, [], "there is nothing above it, and nothing is broken");
		assert.equal(view(reduction.state).path, "", "and the list did not move");
	});

	it("goes back from an album to the album list, with the cursor on the album it left", () => {
		const inAlbum = at(insideAlbum(), 2);
		const reduction = press(inAlbum, "u");

		assert.equal(view(reduction.state).path, "");
		assert.deepEqual(reduction.effects, [], "the index is already here: going up reads nothing");
		assert.equal(view(reduction.state).cursor, 0, "the album it came from owns the cursor");
		assert.equal(selectedEntry(reduction.state)?.kind, "folder");
	});
});

describe("the catalog's identity (S3, S20)", () => {
	it("names a track `origin + id`, never the signed URL that expires", () => {
		const entered = press(at(browsingCatalog(), 0), "enter").state;
		const [row] = visibleEntries(albumPage(entered, albumListing("chillhop", ["First"])));

		assert.ok(row?.kind === "track", "the album lists its tracks as track rows");
		assert.equal(row.track.id, catalogTrackId("chillhop", "first"));
		assert.equal(row.track.id, "catalog:chillhop/first");
		assert.equal(row.track.origin, "catalog");
	});

	it("takes an id apart into the album and track it names, and refuses anything else", () => {
		assert.deepEqual(parseCatalogTrackId(catalogTrackId("chillhop", "first")), {
			albumSlug: "chillhop",
			trackSlug: "first",
		});
		assert.equal(parseCatalogTrackId("catalog:chillhop"), undefined, "no track slug");
		assert.equal(parseCatalogTrackId("catalog:a/b/c"), undefined, "more than one separator");
		assert.equal(parseCatalogTrackId(`${ALBUM}/01 - A.mp3`), undefined, "a local path is not a catalog id");
	});
});

describe("the catalog's listings arrive (S20, L75)", () => {
	it("keeps the cursor on the album it was looking at when a new one lands on top", () => {
		const onLofi = at(browsingCatalog(), 1);
		const updated = catalogAlbums(onLofi, [SUNSET, CHILLHOP, LOFI]);

		assert.deepEqual(updated.sources.catalog.entries.map(nameOf), ["Sunset", "Chillhop", "LoFi"]);
		assert.equal(updated.sources.catalog.cursor, 2, "the cursor follows LoFi, not the index it had");
		assert.deepEqual(visibleEntries(updated)[updated.sources.catalog.cursor], {
			kind: "folder",
			folder: { path: "lofi", name: "LoFi" },
		});
	});

	it("clips the cursor when the album it was on disappeared", () => {
		const onLofi = at(browsingCatalog(), 1);
		const updated = catalogAlbums(onLofi, [CHILLHOP]);

		assert.equal(updated.sources.catalog.cursor, 0, "the list is shorter than the cursor it had");
		assert.deepEqual(updated.sources.catalog.entries.map(nameOf), ["Chillhop"]);
	});

	it("does not move the user when the update lands while an album is open", () => {
		const inAlbum = insideAlbum();
		const updated = catalogAlbums(inAlbum, [SUNSET, CHILLHOP, LOFI]);

		assert.deepEqual(visibleEntries(updated).map(nameOf), ["First", "Second", "Third"]);
		assert.equal(view(updated).path, "chillhop", "the album did not close");
		assert.deepEqual(
			updated.catalogAlbums.map((album) => album.slug),
			["sunset", "chillhop", "lofi"],
		);
	});

	it("only lands an album's tracks on the album the card is showing", () => {
		const inAlbum = insideAlbum();
		const late = albumPage(inAlbum, albumListing("lofi", ["Other"]));

		assert.deepEqual(visibleEntries(late).map(nameOf), ["First", "Second", "Third"]);
	});
});

describe("the catalog says what it is doing (S20, L75)", () => {
	it("repeats the label while the read is in flight, and stops when the list arrives", () => {
		const reading = reduce(browsingCatalog(), { kind: "catalog-reading", label: "catalog · 3 of 12 albums" }).state;
		assert.equal(reading.reading, "catalog · 3 of 12 albums");

		assert.equal(catalogAlbums(reading).reading, undefined);
	});

	it("says why the catalog is not there, naming the gesture that retries it", () => {
		const failed = reduce(browsingCatalog(), { kind: "catalog-failed", reason: "network" }).state;

		assert.equal(failed.notice, "catalog unavailable · reopen to retry");
		assert.equal(failed.reading, undefined);
	});

	it("keeps the reason in the words, because one album gone is not the whole catalog gone", () => {
		const failed = reduce(browsingCatalog(), { kind: "catalog-failed", reason: "not-found" }).state;

		assert.equal(failed.notice, "album missing · reopen to retry");
	});

	it("says the catalog was only partly read, and names the gesture that retries it (S20)", () => {
		// The list is up and usable, so this is not a failure: one sentence says the index had a hole, and it
		// names the same retry a failure names, because the card has only one gesture either way (L75, L90).
		const partial = reduce(browsingCatalog(), { kind: "catalog-partial" }).state;

		assert.equal(partial.notice, "catalog partly read · reopen to retry");
		assert.equal(partial.reading, undefined, "a finished read stops claiming to be reading");
	});
});

describe("a queue belongs to its source (S20)", () => {
	it("carries the source its tracks came from", () => {
		assert.equal(playingB().queue?.source, "library");

		const catalog = press(insideAlbum(), "enter").state;
		assert.equal(catalog.queue?.source, "catalog");
	});

	it("advances through the library's album while the catalog is on screen", () => {
		const hiddenLibrary = switchSource(playingB()).state;
		assert.equal(hiddenLibrary.source, "catalog");

		const next = reduce(hiddenLibrary, { kind: "track-ended", trackId: B.id });

		assert.equal(next.state.playing?.id, C.id, "the queue's own next track, not a row of the album list");
		assert.deepEqual(next.effects, [{ kind: "play", trackId: C.id }]);
	});

	it("advances through the catalog's album while the library is on screen", () => {
		const playing = press(insideAlbum(), "enter").state;
		const first = playing.playing;
		assert.equal(playing.queue?.source, "catalog");

		const moved = switchSource(playing).state;
		assert.equal(moved.source, "library");

		const next = reduce(moved, { kind: "track-ended", trackId: first?.id ?? "" });
		const second = albumListing("chillhop", ["First", "Second", "Third"]).tracks[1];
		assert.equal(next.state.playing?.id, catalogTrackId("chillhop", second?.slug ?? ""));
	});

	it("never mixes the two: the end of a catalog album does not fall back to the library", () => {
		const playing = press(at(insideAlbum(), 2), "enter").state;
		const last = catalogTrackId("chillhop", "third");
		assert.equal(playing.playing?.id, last);
		assert.equal(playing.queue?.position, 2);

		const moved = switchSource(playing).state;
		const ended = reduce(moved, { kind: "track-ended", trackId: last });

		assert.equal(ended.state.queue, undefined, "the queue ends; the library's album is not its next");
		assert.equal(ended.state.playing, undefined);
		assert.deepEqual(ended.effects, [{ kind: "stop" }]);
	});
});

describe("a read that lands while the other source is on screen (S20)", () => {
	it("fills the library without touching the catalog's footer", () => {
		const catalog = browsingCatalog();
		const withNotice = reduce(catalog, { kind: "catalog-failed", reason: "network" }).state;
		const landed = loaded(withNotice, ALBUM, album());

		assert.deepEqual(landed.sources.library, { path: ALBUM, entries: album(), cursor: 0, loaded: true });
		assert.equal(landed.notice, "catalog unavailable · reopen to retry", "the catalog keeps its own message");
		assert.equal(landed.source, "catalog", "and the user stays where they were");
	});

	it("does not let a library failure speak for the catalog", () => {
		const failed = reduce(browsingCatalog(), { kind: "folder-failed", path: ALBUM, reason: "missing" }).state;

		assert.equal(failed.failure, undefined);
	});
});
