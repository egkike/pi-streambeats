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
const plain: ViewTheme = { fg: () => "", bg: () => "", bgEnd: () => "", bold: (text) => text, dim: (text) => text };

/** A theme that prints the role it was asked for, so an exact line proves which role painted it. */
const marked: ViewTheme = {
	fg: (role) => `{${role}}`,
	bg: (role) => `{bg:${role}}`,
	bgEnd: (role) => `{/bg:${role}}`,
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

/**
 * One hairline dividing the card (S3): the artboard's `.hd`/`.ft borders, full width in the `border`
 * role and with no padding. `fill` and `between` cannot express it because it has no cells to pad.
 */
function ruleLine(width: number, theme: ViewTheme = plain): string {
	return `${theme.fg("border")}${"─".repeat(width)}${theme.fg("text")}`;
}

/**
 * The card's own frame (artboard `.card{border}`), the third border: one column at each side. The
 * edges take the card's outer width; the content between them owns `contentWidth(width)` cells.
 */
function edgeTop(width: number, theme: ViewTheme = plain, asciiGlyphs = false): string {
	const { edge, rule } = glyphFamily(asciiGlyphs);
	return `${theme.fg("border")}${edge.topLeft}${rule.repeat(width - 2)}${edge.topRight}${theme.fg("text")}`;
}

function edgeBottom(width: number, theme: ViewTheme = plain, asciiGlyphs = false): string {
	const { edge, rule } = glyphFamily(asciiGlyphs);
	return `${theme.fg("border")}${edge.bottomLeft}${rule.repeat(width - 2)}${edge.bottomRight}${theme.fg("text")}`;
}

/** The cells the content owns once the frame took one column at each side. */
function contentWidth(width: number): number {
	return width - 2;
}

/** One vertical of the frame: every inner line is wrapped in two of these. */
function frameSide(theme: ViewTheme = plain, asciiGlyphs = false): string {
	const { edge } = glyphFamily(asciiGlyphs);
	return `${theme.fg("border")}${edge.vertical}${theme.fg("text")}`;
}

/** An inner line of the card, wrapped in the family's vertical on both sides. */
function framed(line: string, theme: ViewTheme = plain, asciiGlyphs = false): string {
	const side = frameSide(theme, asciiGlyphs);
	return `${side}${line}${side}`;
}

/** The glyphs only a frame can produce, so a card that drew none can prove it. */
function frameCells(asciiGlyphs = false): readonly string[] {
	const { edge } = glyphFamily(asciiGlyphs);
	return [edge.topLeft, edge.topRight, edge.bottomLeft, edge.bottomRight, edge.vertical];
}

/** One listing row, in the column order the card promises (S3): name field, then duration. */
function entryRow(marker: string, name: string, duration: string, width = 90): string {
	return fill(` ${marker} ${name.padEnd(width - 10)} ${duration} `, width);
}

function folderRow(marker: string, name: string, width = 90): string {
	return fill(` ${marker} ${name.padEnd(width - 10)} ${"    "} `, width);
}

const HINTS = "↑ · enter · space · n · p · u · / · s · + · - · z · esc";

function footerLine(hints: string, right: string, width: number): string {
	return between(` ${hints}`, `${right} `, width);
}

function bar(width: number, elapsedMs: number, totalMs: number): string {
	const head = Math.min(width - 1, Math.max(0, Math.round((elapsedMs / totalMs) * (width - 1))));
	return `${"━".repeat(head)}╸${"─".repeat(width - 1 - head)}`;
}

/** The filter input: the prompt, the term and the caret that makes it read as an input (S18). */
function filterRow(term: string, width: number): string {
	return fill(` /${term}▏`, width);
}

/** The no-results row: it names the active term and offers to clear it (S18). */
function noResultsRow(term: string, width: number): string {
	return fill(` no matches for "${term}" · esc clears`, width);
}

describe("the expanded card at 90 columns (S3, S9)", () => {
	it("renders the header with the command, the breadcrumb and the folder summary", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 10, options({ elapsedMs: 47_000 }));

		assert.equal(
			frame.lines[1],
			framed(between(" sb-music StreamBeats/Chillhop", "5 tracks · 18:33 ", contentWidth(90))),
		);
	});

	it("renders a mixed listing of folders and tracks, one row per entry", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 12, options({ elapsedMs: 47_000 }));

		assert.deepEqual(frame.lines, [
			edgeTop(90),
			framed(between(" sb-music StreamBeats/Chillhop", "5 tracks · 18:33 ", contentWidth(90))),
			framed(ruleLine(contentWidth(90))),
			framed(folderRow("  ", "Extras/", contentWidth(90))),
			framed(entryRow("  ", "01 - Arcade Dreams.mp3", "3:42", contentWidth(90))),
			framed(entryRow(" ●", "02 - Blue Hour.mp3", "4:05", contentWidth(90))),
			framed(entryRow("  ", "03 - Neon Nights.mp3", "3:18", contentWidth(90))),
			framed(entryRow("▸ ", "04 - Paper Planes.mp3", "2:57", contentWidth(90))),
			framed(entryRow("  ", "05 - Rainy Window.mp3", "4:31", contentWidth(90))),
			framed(ruleLine(contentWidth(90))),
			framed(footerLine(HINTS, `0:47 ${bar(20, 47_000, 245_000)} 4:05`, contentWidth(90))),
			edgeBottom(90),
		]);
	});

	it("keeps every line at exactly the requested width", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 10, options({ elapsedMs: 47_000 }));

		for (const line of frame.lines) assert.equal([...line].length, 90);
	});
});

describe("the expanded card at 78 columns (S3, S9)", () => {
	const LONG = "07 - Midnight Commute (extended midnight mix, remastered deluxe edition)";
	const entries = [...ENTRIES, trackEntry(LONG, 372_000)];

	it("still renders every row, truncating the long name with an ellipsis", () => {
		const state = card({ entries, cursor: 0, playing: trackAt(entries, 1) });
		const frame = renderFrame(state, plain, 78, 13, options({ elapsedMs: 47_000 }));

		assert.deepEqual(frame.lines, [
			edgeTop(78),
			framed(between(" sb-music StreamBeats/Chillhop", "6 tracks · 24:45 ", contentWidth(78))),
			framed(ruleLine(contentWidth(78))),
			framed(folderRow("▸ ", "Extras/", contentWidth(78))),
			framed(entryRow(" ●", "01 - Arcade Dreams.mp3", "3:42", contentWidth(78))),
			framed(entryRow("  ", "02 - Blue Hour.mp3", "4:05", contentWidth(78))),
			framed(entryRow("  ", "03 - Neon Nights.mp3", "3:18", contentWidth(78))),
			framed(entryRow("  ", "04 - Paper Planes.mp3", "2:57", contentWidth(78))),
			framed(entryRow("  ", "05 - Rainy Window.mp3", "4:31", contentWidth(78))),
			framed(
				entryRow("  ", "07 - Midnight Commute (extended midnight mix, remastered deluxe e…", "6:12", contentWidth(78)),
			),
			framed(ruleLine(contentWidth(78))),
			framed(footerLine(HINTS, `0:47 ${bar(8, 47_000, 222_000)} 3:42`, contentWidth(78))),
			edgeBottom(78),
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
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 12, options());

		assert.equal(frame.lines[5], framed(entryRow(" ●", "02 - Blue Hour.mp3", "4:05", contentWidth(90))));
	});

	it("marks a row that only holds the cursor in the first cell", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 12, options());

		assert.equal(frame.lines[7], framed(entryRow("▸ ", "04 - Paper Planes.mp3", "2:57", contentWidth(90))));
	});

	it("marks a row that is both playing and under the cursor without moving a column", () => {
		const frame = renderFrame(card({ cursor: 2, playing: B }), plain, 90, 12, options());

		assert.equal(frame.lines[5], framed(entryRow("▸●", "02 - Blue Hour.mp3", "4:05", contentWidth(90))));
	});

	it("keeps the two cells apart for every combination", () => {
		const onlyPlaying = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 12, options()).lines[5] ?? "";
		const onlyCursor = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 12, options()).lines[7] ?? "";
		const both = renderFrame(card({ cursor: 2, playing: B }), plain, 90, 12, options()).lines[5] ?? "";
		// The marker cells sit one padding cell inside the frame's left side, not at column zero.
		const side = frameSide();

		assert.equal(onlyPlaying.slice(0, side.length + 4), `${side}  ● `);
		assert.equal(onlyCursor.slice(0, side.length + 4), `${side} ▸  `);
		assert.equal(both.slice(0, side.length + 4), `${side} ▸● `);
	});
});

describe("roles (S3, S16)", () => {
	it("paints the command in bold text, the breadcrumb in dim and the summary in dim", () => {
		const frame = renderFrame(card({ cursor: 0 }), marked, 90, 10, options());

		assert.equal(
			frame.lines[1],
			framed(` [b]sb-music[/b] {dim}StreamBeats/Chillhop{text}${" ".repeat(41)}{dim}5 tracks · 18:33{text} `, marked),
		);
	});

	it("paints the playing row's name in the success role", () => {
		const frame = renderFrame(card({ cursor: 4, playing: trackAt(ENTRIES, 1) }), marked, 90, 12, options());

		assert.equal(
			frame.lines[4],
			framed(`  {success}●{text} {success}01 - Arcade Dreams.mp3{text}${" ".repeat(56)} {muted}3:42{text} `, marked),
		);
	});

	it("paints the cursor row's background on the surface role", () => {
		const frame = renderFrame(card({ cursor: 0, playing: B }), marked, 90, 10, options());

		assert.equal(
			frame.lines[3],
			framed(`{bg:surface} {accent}▸{text}  Extras/${" ".repeat(71)} ${"    "} {/bg:surface}`, marked),
		);
	});

	it("closes the background it opened, so it cannot leak into the next row (R4-004)", () => {
		const frame = renderFrame(card({ cursor: 0, playing: B }), marked, 90, 10, options());
		const side = frameSide(marked);

		const line = frame.lines[3] ?? "";
		assert.ok(line.startsWith(`${side}{bg:surface}`), "the row opens the elevated surface inside the frame");
		assert.ok(line.endsWith(`{/bg:surface}${side}`), "and closes it before the frame's right side");
	});

	it("asks for no background on the rows that are not under the cursor", () => {
		const frame = renderFrame(card({ cursor: 0, playing: B }), marked, 90, 10, options());

		assert.equal((frame.lines[4] ?? "").includes("{bg:"), false);
	});

	it("distinguishes paused by the hollow glyph, not by dropping the success role", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B, paused: true }), marked, 90, 12, options());

		assert.equal(
			frame.lines[5],
			framed(`  {success}○{text} {success}02 - Blue Hour.mp3{text}${" ".repeat(60)} {muted}4:05{text} `, marked),
		);
	});
});

describe("the footer (S3, S13)", () => {
	it("announces every key from the model's table and the progress at 90 columns", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 10, options({ elapsedMs: 47_000 }));

		assert.equal(frame.lines[8], framed(footerLine(HINTS, `0:47 ${bar(20, 47_000, 245_000)} 4:05`, contentWidth(90))));
	});

	it("shrinks the progress bar instead of dropping a key at 78 columns", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 78, 10, options({ elapsedMs: 47_000 }));

		assert.equal(frame.lines[8], framed(footerLine(HINTS, `0:47 ${bar(8, 47_000, 245_000)} 4:05`, contentWidth(78))));
	});

	it("drops the progress when the total is not known yet instead of inventing one", () => {
		const unknown = trackEntry("06 - Untitled.mp3");
		const entries = [...ENTRIES, unknown];
		const frame = renderFrame(card({ entries, cursor: 0, playing: trackAt(entries, 6) }), plain, 90, 11, options());

		assert.equal(frame.lines[9], framed(fill(` ${HINTS} `, contentWidth(90))));
	});

	it("shows the notice in the footer instead of the hints while it is active", () => {
		const frame = renderFrame(card({ notice: "playlist ended" }), plain, 90, 10, options());

		assert.equal(frame.lines[8], framed(fill(" playlist ended ", contentWidth(90))));
	});

	it("drops the hairlines before it drops the content on a very short frame (S3)", () => {
		// `overlayHeight` bottoms out at 4 rows. Two hairlines there would leave no list row between
		// them and stack one separator over the other, so the separators give way first.
		const frame = renderFrame(card(), plain, 90, 4, options());

		assert.equal(frame.lines.length, 4);
		assert.equal(
			frame.lines.some((line) => line.includes("─")),
			false,
			"no hairline fits without content",
		);
	});

	it("pins the footer to the last row and fills the spare rows of a taller frame", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 14, options({ elapsedMs: 47_000 }));

		assert.equal(frame.lines.length, 14);
		assert.deepEqual(frame.lines.slice(9, 11), [
			framed(" ".repeat(contentWidth(90))),
			framed(" ".repeat(contentWidth(90))),
		]);
		assert.equal(frame.lines[12], framed(footerLine(HINTS, `0:47 ${bar(20, 47_000, 245_000)} 4:05`, contentWidth(90))));
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

	it("still says something with no track loaded, so the shortcut does not look dead", () => {
		// An empty frame is indistinguishable from a card that never opened, which is how the real
		// smoke read three times in a row (S15).
		const frame = renderFrame(card({ size: "corner" }), plain, 46, 7, options());

		assert.equal(frame.lines.length, 1);
		assert.match(frame.lines[0] ?? "", /nothing playing/);
		assert.equal((frame.lines[0] ?? "").length, 46, "and it still fills its own width");
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

		assert.deepEqual(
			[geometric.playing, geometric.paused, geometric.cursor, geometric.expanded, geometric.caret],
			["●", "○", "▸", "▾", "▏"],
		);
		assert.equal(geometric.rule, "─", "the hairline is part of the same family");
		assert.deepEqual(
			[
				geometric.edge.topLeft,
				geometric.edge.topRight,
				geometric.edge.bottomLeft,
				geometric.edge.bottomRight,
				geometric.edge.vertical,
			],
			["┌", "┐", "└", "┘", "│"],
		);
		assert.deepEqual([geometric.bar.fill, geometric.bar.head, geometric.bar.rest], ["━", "╸", "─"]);
		assert.deepEqual(
			[ascii.playing, ascii.paused, ascii.cursor, ascii.expanded, ascii.caret],
			["*", "-", ">", "v", "|"],
		);
		assert.equal(ascii.rule, "-", "the hairline is part of the same family");
		assert.deepEqual(
			[ascii.edge.topLeft, ascii.edge.topRight, ascii.edge.bottomLeft, ascii.edge.bottomRight, ascii.edge.vertical],
			["+", "+", "+", "+", "|"],
		);
		assert.deepEqual([ascii.bar.fill, ascii.bar.head, ascii.bar.rest], ["=", "=", "-"]);
	});

	it("draws the filter caret in ASCII too", () => {
		const frame = renderFrame(card({ filter: "Blue", filtering: true }), plain, 90, 4, options({ asciiGlyphs: true }));

		assert.equal(frame.lines[3], fill(" /Blue|", 90));
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
			10,
			options({ elapsedMs: 47_000, asciiGlyphs: true }),
		);

		assert.equal(frame.lines[5], framed(entryRow(">*", "02 - Blue Hour.mp3", "4:05", contentWidth(90)), plain, true));
	});
});

describe("the breadcrumb (S14)", () => {
	it("is relative to libraryRoot while the folder is inside it", () => {
		const frame = renderFrame(card(), plain, 90, 10, options());

		assert.equal(
			frame.lines[1],
			framed(between(" sb-music StreamBeats/Chillhop", "5 tracks · 18:33 ", contentWidth(90))),
		);
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
		const frame = renderFrame(state, plain, 90, 10, options());

		assert.equal(
			frame.lines[1],
			framed(between(" sb-music StreamBeats/Chillhop", "5 tracks · 18:33 ", contentWidth(90))),
		);
	});
});

describe("the filter (S18)", () => {
	it("shows the term and the caret in the footer while the mode is on", () => {
		const frame = renderFrame(card({ filter: "Blue", filtering: true }), plain, 90, 4, options());

		assert.equal(frame.lines[3], filterRow("Blue", 90));
	});

	it("shows an empty input with its caret before anything is typed", () => {
		const frame = renderFrame(card({ filter: "", filtering: true }), plain, 90, 4, options());

		assert.equal(frame.lines[3], filterRow("", 90));
	});

	it("narrows the listing and the header summary to what the term matches", () => {
		const frame = renderFrame(card({ filter: "Blue", filtering: true }), plain, 90, 6, options());

		assert.deepEqual(frame.lines, [
			between(" sb-music StreamBeats/Chillhop", "1 track · 4:05 ", 90),
			ruleLine(90),
			entryRow("▸ ", "02 - Blue Hour.mp3", "4:05"),
			" ".repeat(90),
			ruleLine(90),
			filterRow("Blue", 90),
		]);
	});

	it("keeps the click map on the filtered indexes", () => {
		const frame = renderFrame(card({ filter: "Blue", filtering: true }), plain, 90, 6, options());

		assert.deepEqual(frame.hits.get(2), { index: 0, entry: ENTRIES[2] });
		assert.equal(frame.hits.size, 1);
	});

	it("names the active term and offers to clear it when nothing matches", () => {
		const frame = renderFrame(card({ filter: "zzz", filtering: true }), plain, 90, 6, options());

		assert.deepEqual(frame.lines, [
			between(" sb-music StreamBeats/Chillhop", "0 tracks ", 90),
			ruleLine(90),
			noResultsRow("zzz", 90),
			" ".repeat(90),
			ruleLine(90),
			filterRow("zzz", 90),
		]);
	});

	it("keeps explaining the empty listing after the mode is confirmed", () => {
		const frame = renderFrame(card({ filter: "zzz", filtering: false }), plain, 90, 6, options());

		assert.equal(frame.lines[2], noResultsRow("zzz", 90));
		assert.equal(frame.lines[5], fill(` ${HINTS} `, 90));
	});

	it("takes the footer's row so no key hint lies while the keys are text", () => {
		const playing = card({ filter: "Blue", filtering: true, playing: B });
		const frame = renderFrame(playing, plain, 90, 10, options({ elapsedMs: 47_000 }));

		assert.equal(frame.lines[8], framed(filterRow("Blue", contentWidth(90))));
		assert.equal(frame.lines.join("\n").includes("━"), false);
	});

	it("renders the filter and the no-results rows at 78 columns too", () => {
		const frame = renderFrame(card({ filter: "zzz", filtering: true }), plain, 78, 6, options());

		assert.deepEqual(frame.lines, [
			between(" sb-music StreamBeats/Chillhop", "0 tracks ", 78),
			ruleLine(78),
			noResultsRow("zzz", 78),
			" ".repeat(78),
			ruleLine(78),
			filterRow("zzz", 78),
		]);
		for (const line of frame.lines) assert.equal([...line].length, 78);
	});

	it("scrolls a term that does not fit, keeping its end and the caret", () => {
		const term = "0123456789".repeat(9);
		const shown = `…${term.slice(term.length - 73)}`;
		const frame = renderFrame(card({ filter: term, filtering: true }), plain, 78, 4, options());

		assert.equal(frame.lines[3], ` /${shown}▏ `);
	});

	it("shortens a long term instead of dropping the offer to clear it", () => {
		const term = "0123456789".repeat(5);
		const frame = renderFrame(card({ filter: term, filtering: false }), plain, 78, 6, options());

		assert.equal(frame.lines[2], fill(` no matches for "${term.slice(0, 45)}…" · esc clears`, 78));
	});

	it("neutralizes control characters in the term, as everywhere else", () => {
		const frame = renderFrame(card({ filter: "a\u0007b", filtering: true }), plain, 90, 4, options());

		assert.equal(frame.lines[3], filterRow("ab", 90));
	});

	it("paints the input on the accent role and the no-results row on muted", () => {
		const input = renderFrame(card({ filter: "Blue", filtering: true }), marked, 90, 4, options());
		const empty = renderFrame(card({ filter: "zzz", filtering: true }), marked, 90, 6, options());

		assert.equal(input.lines[3], ` {accent}/{text}Blue{accent}▏{text}${" ".repeat(83)}`);
		assert.equal(empty.lines[2], ` {muted}no matches for "zzz" · esc clears{text}${" ".repeat(56)}`);
	});
});

describe("the click map (S17)", () => {
	it("maps each rendered row to the entry it stands for", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 12, options());

		assert.deepEqual(frame.hits.get(3), { index: 0, entry: ENTRIES[0] });
		assert.deepEqual(frame.hits.get(8), { index: 5, entry: ENTRIES[5] });
		assert.equal(frame.hits.size, ENTRIES.length);
	});

	it("leaves the header and the footer without a click zone", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 10, options());

		assert.equal(frame.hits.get(1), undefined);
		assert.equal(frame.hits.get(8), undefined);
	});

	it("maps windowed rows to their real entry index when the listing does not fit", () => {
		const frame = renderFrame(card({ cursor: 4 }), plain, 90, 6, options());

		assert.equal(frame.hits.size, 2);
		assert.deepEqual(frame.hits.get(2), { index: 3, entry: ENTRIES[3] });
		assert.deepEqual(frame.hits.get(3), { index: 4, entry: ENTRIES[4] });
	});
});

describe("the highlight under the pointer (S17)", () => {
	it("marks the row under the pointer with weight instead of a second background", () => {
		// The cursor already owns the elevated surface and `▸`; a hover that used it too would put two
		// identical highlights on screen and make the click target the less predictable of the two. So
		// the pointer changes the row's weight and nothing else -- a signal that is not another colour.
		const frame = renderFrame(card({ cursor: 4, playing: B, hover: 2 }), marked, 90, 12, options());

		assert.equal(
			frame.lines[5],
			framed(
				`  {success}●{text} [b]{success}02 - Blue Hour.mp3{text}[/b]${" ".repeat(78 - "02 - Blue Hour.mp3".length)} {muted}4:05{text} `,
				marked,
			),
		);
	});

	it("does not move a single cell of the row it highlights", () => {
		const plainRow = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 12, options());
		const hovered = renderFrame(card({ cursor: 4, playing: B, hover: 2 }), plain, 90, 12, options());

		assert.deepEqual(hovered.lines, plainRow.lines, "same lines, same width: the highlight adds no cell");
		for (const line of hovered.lines) assert.equal([...line].length, 90);
	});

	it("highlights exactly one row, and never the cursor row's own marker", () => {
		const frame = renderFrame(card({ cursor: 0, playing: B, hover: 2 }), marked, 90, 12, options());
		const weighted = frame.lines.filter((line) => line.includes("[b]"));

		assert.equal(weighted.length, 2, "the command in the header plus the row under the pointer");
		assert.match(frame.lines[3] ?? "", /▸/, "the cursor keeps its own marker untouched");
	});

	it("keeps the cursor's surface when the pointer is on the cursor's own row", () => {
		const frame = renderFrame(card({ cursor: 2, playing: B, hover: 2 }), marked, 90, 12, options());
		const line = frame.lines[5] ?? "";

		assert.ok(line.startsWith(`${frameSide(marked)}{bg:surface}`), "the elevated surface is still there");
		assert.ok(line.endsWith(`{/bg:surface}${frameSide(marked)}`), "and it still closes inside the frame");
		assert.ok(line.includes("[b]"), "with the pointer's weight on top of it");
	});

	it("highlights a row in the windowed listing, not its slot on screen", () => {
		// `hover` is an index into the listing, not a line: a card that fits two of six rows starts the
		// window at index 3, so row 4 is drawn on line 3 and row 3 on line 2.
		const frame = renderFrame(card({ cursor: 4, hover: 4 }), marked, 90, 6, options());

		assert.match(frame.lines[3] ?? "", /\[b\].*04 - Paper Planes\.mp3/);
		assert.equal((frame.lines[2] ?? "").includes("[b]"), false);
	});
});

describe("the card's own frame (S3, S16)", () => {
	it("paints the frame in the border role", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), marked, 90, 10, options({ elapsedMs: 47_000 }));

		assert.equal(frame.lines[0], edgeTop(90, marked));
		assert.equal(frame.lines[frame.lines.length - 1], edgeBottom(90, marked));
	});

	it("frames with the ASCII family when the setting asks for it", () => {
		const frame = renderFrame(card({ cursor: 4, playing: B }), plain, 90, 10, options({ asciiGlyphs: true }));

		assert.equal(frame.lines[0], edgeTop(90, plain, true));
		assert.equal(
			frame.lines[1],
			framed(between(" sb-music StreamBeats/Chillhop", "5 tracks · 18:33 ", contentWidth(90)), plain, true),
		);
	});

	it("keeps every emitted line at exactly the requested width, frame included (R3-002)", () => {
		// The smallest frame the renderer draws (6 x 7): one list row fits between the hairlines. Every
		// line must still be exactly six cells, or the card bleeds outside its own box.
		const frame = renderFrame(card({ cursor: 1 }), plain, 6, 7, options());

		assert.equal(frame.lines.length, 7);
		for (const line of frame.lines) assert.equal([...line].length, 6, JSON.stringify(line));
		assert.match(frame.lines[0] ?? "", /^┌─+┐$/);
	});

	it("never draws a frame on a card too small to hold one (R3-rule-width-empty)", () => {
		const narrow = renderFrame(card({ cursor: 1 }), plain, 4, 12, options());
		const empty = renderFrame(card(), plain, 0, 12, options());

		assert.equal(narrow.lines.length, 12);
		assert.equal(
			narrow.lines.some((line) => frameCells().some((cell) => line.includes(cell))),
			false,
			"no border cell without room for a frame",
		);
		assert.deepEqual(empty.lines, []);
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
		// At 4 columns the markers take the whole budget, so the name gives up its last cell. The old
		// expectation is back on purpose: this is the width where the padding threshold matters, and a
		// unified threshold silently ate the name here.
		const frame = renderFrame(card({ cursor: 1 }), plain, 4, 3, options());

		assert.equal(frame.lines[1], "▸  …");
	});

	it("truncates the header and the footer instead of wrapping at absurd widths", () => {
		const frame = renderFrame(card({ cursor: 0 }), plain, 2, 3, options());

		for (const line of frame.lines) assert.ok([...line].length <= 2, line);
	});

	it("keeps the filter rows inside the same budget at absurd widths", () => {
		for (const width of [2, 4, 10]) {
			for (const state of [card({ filter: "Blue", filtering: true }), card({ filter: "zzz", filtering: false })]) {
				const frame = renderFrame(state, plain, width, 3, options());

				for (const line of frame.lines) assert.equal([...line].length, width, `${width}: ${line}`);
			}
		}
	});
});
