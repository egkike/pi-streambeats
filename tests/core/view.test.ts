/**
 * The card renderer (S3, S9, S14, S16, S17). Every assertion is an exact array of lines: the
 * reference widths are 90 and 78 columns, and a line that fits by luck is not a line that fits.
 * The theme is faked, so roles are verified without a terminal and without real escape sequences.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CardState, initialState } from "../../lib/core/model.ts";
import { glyphFamily, renderFrame } from "../../lib/core/view.ts";
import type { LibraryEntry, Track, ViewTheme } from "../../lib/types.ts";

const HOME = "/home/kike";
const ROOT = `${HOME}/Music`;
const ALBUM = `${ROOT}/StreamBeats/Chillhop`;

/** A theme that prints nothing: for layout assertions, where roles would only add noise. */
const plain: ViewTheme = { fg: () => "", bold: (text) => text, dim: (text) => text };

/** A theme that prints the role it was asked for, so an exact line proves which role painted it. */
const marked: ViewTheme = {
	fg: (role) => `{${role}}`,
	bold: (text) => `[b]${text}[/b]`,
	dim: (text) => `[d]${text}[/d]`,
};

function folderEntry(name: string): LibraryEntry {
	return { kind: "folder", folder: { path: `${ALBUM}/${name}`, name } };
}

function trackEntry(title: string, durationMs?: number): LibraryEntry {
	return { kind: "track", track: { id: `${ALBUM}/${title}`, title, origin: "local", durationMs } };
}

function trackAt(entries: readonly LibraryEntry[], index: number): Track {
	const entry = entries[index];
	if (entry?.kind !== "track") throw new Error(`row ${index} is not a track`);
	return entry.track;
}

/** Six rows: one folder and five tracks, durations known before playing (S3). */
const ENTRIES: readonly LibraryEntry[] = [
	folderEntry("Extras"),
	trackEntry("01 - Arcade Dreams.mp3", 222_000),
	trackEntry("02 - Blue Hour.mp3", 245_000),
	trackEntry("03 - Neon Nights.mp3", 198_000),
	trackEntry("04 - Paper Planes.mp3", 177_000),
	trackEntry("05 - Rainy Window.mp3", 271_000),
];

const B = trackAt(ENTRIES, 2);

/** The card as the reducer would leave it: open, expanded, showing the album (S15). */
function card(overrides: Partial<CardState> = {}): CardState {
	return {
		...initialState({ libraryRoot: ROOT, ceiling: HOME }),
		presence: "visible",
		size: "expanded",
		path: ALBUM,
		entries: ENTRIES,
		...overrides,
	};
}

function options(
	overrides: { libraryRoot?: string; elapsedMs?: number; asciiGlyphs?: boolean; totalMs?: number } = {},
) {
	return { libraryRoot: ROOT, ...overrides };
}

function fill(text: string, width: number): string {
	return text.padEnd(width, " ");
}

/** Space-between: the card's left and right edges, which is what "right aligned" means here. */
function between(left: string, right: string, width: number): string {
	return `${left}${" ".repeat(width - [...left].length - [...right].length)}${right}`;
}

/** One listing row, in the column order the card promises (S3): name field, then duration. */
function entryRow(marker: string, name: string, duration: string, width = 90): string {
	return fill(` ${marker} ${name.padEnd(width - 10)} ${duration} `, width);
}

function folderRow(marker: string, name: string, width = 90): string {
	return fill(` ${marker} ${name.padEnd(width - 10)} ${"    "} `, width);
}

const HINTS = "↑ · enter · space · n · p · u · l · s · + · - · z · esc";

function footerLine(hints: string, right: string, width: number): string {
	return between(` ${hints}`, `${right} `, width);
}

function bar(width: number, elapsedMs: number, totalMs: number): string {
	const head = Math.min(width - 1, Math.max(0, Math.round((elapsedMs / totalMs) * (width - 1))));
	return `${"━".repeat(head)}╸${"─".repeat(width - 1 - head)}`;
}

describe("the expanded card at 90 columns (S3, S9)", () => {
	it("renders the header with the command, the breadcrumb and the folder summary", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 8, options({ elapsedMs: 47_000 }));

		assert.equal(frame.lines[0], between(" sb-music StreamBeats/Chillhop", "5 tracks · 18:33 ", 90));
	});

	it("renders a mixed listing of folders and tracks, one row per entry", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 8, options({ elapsedMs: 47_000 }));

		assert.deepEqual(frame.lines, [
			between(" sb-music StreamBeats/Chillhop", "5 tracks · 18:33 ", 90),
			folderRow("  ", "Extras/"),
			entryRow("  ", "01 - Arcade Dreams.mp3", "3:42"),
			entryRow(" ●", "02 - Blue Hour.mp3", "4:05"),
			entryRow("  ", "03 - Neon Nights.mp3", "3:18"),
			entryRow("▸ ", "04 - Paper Planes.mp3", "2:57"),
			entryRow("  ", "05 - Rainy Window.mp3", "4:31"),
			footerLine(HINTS, `0:47 ${bar(20, 47_000, 245_000)} 4:05`, 90),
		]);
	});

	it("keeps every line at exactly the requested width", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 8, options({ elapsedMs: 47_000 }));

		for (const line of frame.lines) assert.equal([...line].length, 90);
	});
});

describe("the expanded card at 78 columns (S3, S9)", () => {
	const LONG = "07 - Midnight Commute (extended midnight mix, remastered deluxe edition)";
	const entries = [...ENTRIES, trackEntry(LONG, 372_000)];

	it("still renders every row, truncating the long name with an ellipsis", () => {
		const state = card({ entries, cursor: 0, playing: trackAt(entries, 1) });
		const frame = renderFrame(state, plain, 78, 9, options({ elapsedMs: 47_000 }));

		assert.deepEqual(frame.lines, [
			between(" sb-music StreamBeats/Chillhop", "6 tracks · 24:45 ", 78),
			folderRow("▸ ", "Extras/", 78),
			entryRow(" ●", "01 - Arcade Dreams.mp3", "3:42", 78),
			entryRow("  ", "02 - Blue Hour.mp3", "4:05", 78),
			entryRow("  ", "03 - Neon Nights.mp3", "3:18", 78),
			entryRow("  ", "04 - Paper Planes.mp3", "2:57", 78),
			entryRow("  ", "05 - Rainy Window.mp3", "4:31", 78),
			entryRow("  ", "07 - Midnight Commute (extended midnight mix, remastered deluxe edi…", "6:12", 78),
			footerLine(HINTS, `0:47 ${bar(10, 47_000, 222_000)} 3:42`, 78),
		]);
	});

	it("never lets a line exceed the budget", () => {
		const state = card({ entries, cursor: 0, playing: trackAt(entries, 1) });
		const frame = renderFrame(state, plain, 78, 9, options({ elapsedMs: 47_000 }));

		for (const line of frame.lines) assert.equal([...line].length, 78);
	});
});

describe("the two marker cells (S3, S16)", () => {
	it("marks a row that is only playing in the second cell", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 8, options());

		assert.equal(frame.lines[3], entryRow(" ●", "02 - Blue Hour.mp3", "4:05"));
	});

	it("marks a row that only holds the cursor in the first cell", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 8, options());

		assert.equal(frame.lines[5], entryRow("▸ ", "04 - Paper Planes.mp3", "2:57"));
	});

	it("marks a row that is both playing and under the cursor without moving a column", () => {
		const frame = renderFrame(card({ cursor: 2, playing: B }), plain, 90, 8, options());

		assert.equal(frame.lines[3], entryRow("▸●", "02 - Blue Hour.mp3", "4:05"));
	});

	it("keeps the two cells apart for every combination", () => {
		const onlyPlaying = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 8, options()).lines[3] ?? "";
		const onlyCursor = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 8, options()).lines[5] ?? "";
		const both = renderFrame(card({ cursor: 2, playing: B }), plain, 90, 8, options()).lines[3] ?? "";

		assert.equal(onlyPlaying.slice(0, 4), "  ● ");
		assert.equal(onlyCursor.slice(0, 4), " ▸  ");
		assert.equal(both.slice(0, 4), " ▸● ");
	});
});

describe("roles (S3, S16)", () => {
	it("paints the command in bold text, the breadcrumb in dim and the summary in dim", () => {
		const frame = renderFrame(card({ cursor: 0 }), marked, 90, 8, options());

		assert.equal(
			frame.lines[0],
			` [b]sb-music[/b] {dim}StreamBeats/Chillhop{text}${" ".repeat(43)}{dim}5 tracks · 18:33{text} `,
		);
	});

	it("paints the playing row's name in the success role", () => {
		const frame = renderFrame(card({ cursor: 4, playing: trackAt(ENTRIES, 1) }), marked, 90, 8, options());

		assert.equal(
			frame.lines[2],
			`  {success}●{text} {success}01 - Arcade Dreams.mp3{text}${" ".repeat(58)} {muted}3:42{text} `,
		);
	});

	it("paints the cursor row on the surface role and gives the default role back at the end", () => {
		const frame = renderFrame(card({ cursor: 0, playing: B }), marked, 90, 8, options());

		assert.equal(
			frame.lines[1],
			`{surface} {accent}▸{surface}  {text}Extras/{surface}${" ".repeat(73)} ${"    "} {text}`,
		);
	});

	it("distinguishes paused by the hollow glyph, not by dropping the success role", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B, paused: true }), marked, 90, 8, options());

		assert.equal(
			frame.lines[3],
			`  {success}○{text} {success}02 - Blue Hour.mp3{text}${" ".repeat(62)} {muted}4:05{text} `,
		);
	});
});

describe("the footer (S3, S13)", () => {
	it("announces every key from the model's table and the progress at 90 columns", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 8, options({ elapsedMs: 47_000 }));

		assert.equal(frame.lines[7], footerLine(HINTS, `0:47 ${bar(20, 47_000, 245_000)} 4:05`, 90));
	});

	it("shrinks the progress bar instead of dropping a key at 78 columns", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 78, 8, options({ elapsedMs: 47_000 }));

		assert.equal(frame.lines[7], footerLine(HINTS, `0:47 ${bar(10, 47_000, 245_000)} 4:05`, 78));
	});

	it("drops the progress when the total is not known yet instead of inventing one", () => {
		const unknown = trackEntry("06 - Untitled.mp3");
		const entries = [...ENTRIES, unknown];
		const frame = renderFrame(card({ entries, cursor: 0, playing: trackAt(entries, 6) }), plain, 90, 9, options());

		assert.equal(frame.lines[8], fill(` ${HINTS} `, 90));
	});

	it("shows the notice in the footer instead of the hints while it is active", () => {
		const frame = renderFrame(card({ notice: "playlist ended" }), plain, 90, 8, options());

		assert.equal(frame.lines[7], fill(" playlist ended ", 90));
	});

	it("pins the footer to the last row and fills the spare rows of a taller frame", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 10, options({ elapsedMs: 47_000 }));

		assert.equal(frame.lines.length, 10);
		assert.deepEqual(frame.lines.slice(7, 9), [" ".repeat(90), " ".repeat(90)]);
		assert.equal(frame.lines[9], footerLine(HINTS, `0:47 ${bar(20, 47_000, 245_000)} 4:05`, 90));
	});
});

describe("the corner card (S15, S16)", () => {
	it("shows only the state glyph, the time and the progress bar", () => {
		const state = card({ size: "corner", playing: B });
		const frame = renderFrame(state, plain, 46, 7, options({ elapsedMs: 47_000 }));

		assert.deepEqual(frame.lines, [between(" ●", "0:47 / 4:05 ", 46), fill(` ${bar(44, 47_000, 245_000)} `, 46)]);
	});

	it("does not repeat the title, which the status bar owns (S12)", () => {
		const state = card({ size: "corner", playing: B });
		const frame = renderFrame(state, plain, 46, 7, options({ elapsedMs: 47_000 }));

		assert.equal(frame.lines.join("\n").includes("Blue Hour"), false);
	});

	it("shows the hollow glyph and the frozen time while paused", () => {
		const state = card({ size: "corner", playing: B, paused: true });
		const frame = renderFrame(state, plain, 46, 7, options({ elapsedMs: 47_000 }));

		assert.deepEqual(frame.lines, [between(" ○", "0:47 / 4:05 ", 46), fill(` ${bar(44, 47_000, 245_000)} `, 46)]);
	});

	it("renders nothing when no track is loaded", () => {
		const frame = renderFrame(card({ size: "corner" }), plain, 46, 7, options());

		assert.deepEqual(frame.lines, []);
	});

	it("shrinks to the available width but never past the artboard's 46 cells", () => {
		const wide = renderFrame(card({ size: "corner", playing: B }), plain, 120, 2, options({ elapsedMs: 47_000 }));

		for (const line of wide.lines) assert.equal([...line].length, 46);
	});
});

describe("the ASCII glyph family (S16)", () => {
	it("swaps every glyph of the family as a set, with no automatic detection", () => {
		const geometric = glyphFamily(false);
		const ascii = glyphFamily(true);

		assert.deepEqual([geometric.playing, geometric.paused, geometric.cursor, geometric.expanded], ["●", "○", "▸", "▾"]);
		assert.deepEqual([geometric.bar.fill, geometric.bar.head, geometric.bar.rest], ["━", "╸", "─"]);
		assert.deepEqual([ascii.playing, ascii.paused, ascii.cursor, ascii.expanded], ["*", "-", ">", "v"]);
		assert.deepEqual([ascii.bar.fill, ascii.bar.head, ascii.bar.rest], ["=", "=", "-"]);
	});

	it("renders the markers and the progress in ASCII when the setting asks for it", () => {
		const state = card({ size: "corner", playing: B });
		const frame = renderFrame(state, plain, 46, 7, options({ elapsedMs: 47_000, asciiGlyphs: true }));

		assert.deepEqual(frame.lines, [between(" *", "0:47 / 4:05 ", 46), fill(` ${"=".repeat(9)}${"-".repeat(35)} `, 46)]);
	});

	it("keeps the ASCII family in the expanded listing too", () => {
		const frame = renderFrame(
			card({ cursor: 2, playing: B }),
			plain,
			90,
			8,
			options({ elapsedMs: 47_000, asciiGlyphs: true }),
		);

		assert.equal(frame.lines[3], entryRow(">*", "02 - Blue Hour.mp3", "4:05"));
	});
});

describe("the breadcrumb (S14)", () => {
	it("is relative to libraryRoot while the folder is inside it", () => {
		const frame = renderFrame(card(), plain, 90, 8, options());

		assert.equal(frame.lines[0], between(" sb-music StreamBeats/Chillhop", "5 tracks · 18:33 ", 90));
	});

	it("names the root itself when the card is at libraryRoot", () => {
		const state = card({ path: ROOT, entries: [] });
		const frame = renderFrame(state, plain, 90, 3, options());

		assert.equal(frame.lines[0], between(" sb-music Music", "0 tracks ", 90));
	});

	it("collapses to ~/… above libraryRoot and never prints an absolute home path", () => {
		const state = card({ path: HOME, entries: [] });
		const frame = renderFrame(state, plain, 90, 3, options());

		assert.equal(frame.lines[0], between(" sb-music ~/…", "0 tracks ", 90));
		assert.equal(frame.lines.join("\n").includes("/home/kike"), false);
	});

	it("reads a Windows path in its own flavour and shows forward slashes", () => {
		const windowsRoot = "C:\\Users\\kike\\Music";
		const state = card({ path: `${windowsRoot}\\StreamBeats\\Chillhop`, entries: [] });
		const frame = renderFrame(state, plain, 90, 3, options({ libraryRoot: windowsRoot }));

		assert.equal(frame.lines[0], between(" sb-music StreamBeats/Chillhop", "0 tracks ", 90));
		assert.equal(frame.lines.join("\n").includes("C:\\"), false);
	});

	it("takes libraryRoot from the options and not from the state", () => {
		const state = card({ libraryRoot: "/srv/elsewhere" });
		const frame = renderFrame(state, plain, 90, 8, options());

		assert.equal(frame.lines[0], between(" sb-music StreamBeats/Chillhop", "5 tracks · 18:33 ", 90));
	});
});

describe("the click map (S17)", () => {
	it("maps each rendered row to the entry it stands for", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 8, options());

		assert.deepEqual(frame.hits.get(1), { index: 0, entry: ENTRIES[0] });
		assert.deepEqual(frame.hits.get(6), { index: 5, entry: ENTRIES[5] });
		assert.equal(frame.hits.size, ENTRIES.length);
	});

	it("leaves the header and the footer without a click zone", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 8, options());

		assert.equal(frame.hits.get(0), undefined);
		assert.equal(frame.hits.get(7), undefined);
	});

	it("maps windowed rows to their real entry index when the listing does not fit", () => {
		const frame = renderFrame(card({ cursor: 4 }), plain, 90, 4, options());

		assert.equal(frame.hits.size, 2);
		assert.deepEqual(frame.hits.get(1), { index: 3, entry: ENTRIES[3] });
		assert.deepEqual(frame.hits.get(2), { index: 4, entry: ENTRIES[4] });
	});
});

describe("the frame budget (S3, S9)", () => {
	it("renders nothing while the card is hidden (S15)", () => {
		const frame = renderFrame(card({ presence: "hidden" }), plain, 90, 8, options());

		assert.deepEqual(frame.lines, []);
		assert.equal(frame.hits.size, 0);
	});

	it("drops the duration column before it drops the marker cells", () => {
		const frame = renderFrame(card({ cursor: 1 }), plain, 10, 3, options());

		assert.equal(frame.lines[1], " ▸  01 -… ");
	});

	it("keeps the marker cells and truncates the name to its last cell", () => {
		const frame = renderFrame(card({ cursor: 1 }), plain, 4, 3, options());

		assert.equal(frame.lines[1], "▸  …");
	});

	it("truncates the header and the footer instead of wrapping at absurd widths", () => {
		const frame = renderFrame(card({ cursor: 0 }), plain, 2, 3, options());

		for (const line of frame.lines) assert.ok([...line].length <= 2, line);
	});
});
