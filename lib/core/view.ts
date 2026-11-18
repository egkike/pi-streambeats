/**
 * The card renderer (S3, S9, S14, S15, S16, S17). A `CardState` goes in; exact lines and a click
 * map come out. Pure and synchronous (S8): no filesystem, no clock, no terminal, no host import.
 *
 * Everything the renderer needs from the world arrives as data: the theme arrives as roles, the
 * root the breadcrumb is relative to arrives in `options`, and the elapsed time arrives from the
 * player. Colour is never a literal: it is a role the host maps to its own palette.
 */
import { posix, win32 } from "node:path";
import type { LibraryEntry, Role, Track, ViewTheme } from "../types.ts";
import { type CardState, currentView, footerHints, visibleEntries } from "./model.ts";

/** The whole glyph family (S16). One family per frame: geometric or ASCII, never a mix. */
export interface Glyphs {
	/** Playing (S12): `●` geometric, `*` ASCII. */
	readonly playing: string;
	/** Paused (S12): `○` geometric, `-` ASCII. */
	readonly paused: string;
	/** The cursor in the first marker cell (S3): `▸` geometric, `>` ASCII. */
	readonly cursor: string;
	/** Expanded (S15): `▾` geometric, `v` ASCII. */
	readonly expanded: string;
	/** The filter input's caret (S18): `▏` geometric, `|` ASCII. */
	readonly caret: string;
	/** The hairlines that divide the card (artboard `.hd`/`.ft` borders): `─` geometric, `-` ASCII. */
	readonly rule: string;
	/** The card's own frame (artboard `.card{border}`). The sides reuse `rule`. */
	readonly edge: {
		readonly topLeft: string;
		readonly topRight: string;
		readonly bottomLeft: string;
		readonly bottomRight: string;
		readonly vertical: string;
	};
	readonly bar: {
		/** The part already played (S3). */
		readonly fill: string;
		/** The head of the progress bar: one cell between fill and rest. */
		readonly head: string;
		/** The part still to play. */
		readonly rest: string;
	};
}

const GEOMETRIC: Glyphs = {
	playing: "●",
	paused: "○",
	cursor: "▸",
	expanded: "▾",
	caret: "▏",
	rule: "─",
	edge: { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", vertical: "│" },
	bar: { fill: "━", head: "╸", rest: "─" },
};

const ASCII: Glyphs = {
	playing: "*",
	paused: "-",
	cursor: ">",
	expanded: "v",
	caret: "|",
	rule: "-",
	edge: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", vertical: "|" },
	bar: { fill: "=", head: "=", rest: "-" },
};

/**
 * The family the frame is drawn with (S16). `asciiGlyphs` is a user decision, never a detection:
 * there is no terminal sniffing in here, so the same state always renders the same way.
 */
export function glyphFamily(asciiGlyphs: boolean): Glyphs {
	return asciiGlyphs ? ASCII : GEOMETRIC;
}

/** What the renderer may read from the world (S8). `libraryRoot` is here on purpose, not in state. */
export interface ViewOptions {
	/** The configured root the breadcrumb is relative to (S14). */
	readonly libraryRoot: string;
	/** The S16 escape hatch for terminals where the geometric glyphs occupy two cells. */
	readonly asciiGlyphs?: boolean;
	/** Position reported by the player (S12). The view owns no clock. */
	readonly elapsedMs?: number;
	/** Duration the player knows better than the track metadata; falls back to `durationMs`. */
	readonly totalMs?: number;
	/**
	 * Durations the player reported for tracks during this session (S12, issue #42). The scanner reads
	 * names, not tags, so this is the only way a row learns its length without playing the track again.
	 */
	readonly knownDurations?: ReadonlyMap<string, number>;
}

/** A rendered row and the entry it stands for (S17): a click resolves without screen coordinates. */
export interface EntryHit {
	/** Index into `visibleEntries(state)`, not into the raw listing. */
	readonly index: number;
	readonly entry: LibraryEntry;
}

/** Row index in the frame → the entry that row represents (S17). */
export type HitMap = ReadonlyMap<number, EntryHit>;

export interface Frame {
	readonly lines: readonly string[];
	readonly hits: HitMap;
}

const HORIZONTAL_PADDING = 1;
const MARKER_WIDTH = 2;
const COLUMN_GAP = 1;
const MIN_BAR = 3;
const MAX_BAR = 20;
/** The artboard's corner card is 46 cells wide; a wider frame never stretches it (S15). */
const CORNER_WIDTH = 46;
const ELLIPSIS = "…";
const SEPARATOR = " · ";
/** The catalog names itself in the header (S20): it is where you are, not a breadcrumb of a disk. */
const CATALOG_TITLE = "StreamBeats";

/** Render one frame of the card, exactly `width` cells per line (S3). */
export function renderFrame(
	state: CardState,
	theme: ViewTheme,
	width: number,
	height: number,
	options: ViewOptions,
): Frame {
	const columns = Math.max(0, Math.floor(width));
	const rows = Math.max(0, Math.floor(height));
	if (state.presence === "hidden" || columns === 0 || rows === 0) {
		return { lines: [], hits: new Map() };
	}

	const glyphs = glyphFamily(options.asciiGlyphs === true);
	if (state.size === "corner") return cornerFrame(state, theme, columns, rows, options, glyphs);
	return expandedFrame(state, theme, columns, rows, options, glyphs);
}

/* --- the expanded card (S3) ------------------------------------------------------------------ */

function expandedFrame(
	state: CardState,
	theme: ViewTheme,
	width: number,
	height: number,
	options: ViewOptions,
	glyphs: Glyphs,
): Frame {
	const lines: string[] = [];
	const hits = new Map<number, EntryHit>();
	const entries = visibleEntries(state);
	// The artboard's third border (`.card{border:1px solid}`): without an outline the card reads as the
	// terminal background. It sits OUTSIDE the padding, exactly as the artboard nests `.hd{padding:0 1ch}`
	// inside the card's border, so the content loses two columns and the rows lose two -- the card grows
	// for the rows (`overlayHeight`) rather than handing them to the list.
	//
	// The minimum comes from the same invariant the hairlines use, not from a taste for round numbers:
	// two cells of frame, and enough rows for header + both hairlines + one list row + footer. Too small
	// to frame means NO frame, never a frame stacked on the content.
	const MIN_FRAMED_WIDTH = 2 + 4; // frame cells + one padding cell, a marker cell and a name cell
	const MIN_FRAMED_ROWS = 2 + 1 + 2 + 1 + 1; // both frame rows, header, both hairlines, a list row, footer
	const edged = width >= MIN_FRAMED_WIDTH && height >= MIN_FRAMED_ROWS;
	const contentWidth = edged ? width - 2 : width;
	const contentRows = edged ? height - 2 : height;
	const footerRows = contentRows >= 2 ? 1 : 0;
	// The artboard divides the header from the list and the list from the footer (`01-lista-unica.html`:
	// `.hd{border-bottom}` and `.ft{border-top}`). Without them the footer read as one more list row.
	// They come as a pair and only when a list row fits between them: `contentRows - 1 - footerRows - 2 >= 1`,
	// i.e. five rows. Below that the two hairlines would sit one over the other and the card would lose
	// the row that explains an empty listing (S18).
	const listRowFits = contentRows - 1 - footerRows - 2 >= 1;
	const ruleRows = listRowFits ? 2 : 0;
	const listRows = Math.max(0, contentRows - 1 - footerRows - ruleRows);
	const durationWidth = widestDuration(entries, options);

	lines.push(headerLine(state, theme, contentWidth, options));
	// Top and bottom hairline, decided together by `ruleRows`: they exist as a pair or not at all.
	if (ruleRows > 0) lines.push(ruleLine(theme, contentWidth, glyphs));

	// An empty listing with a term is a state, not a blank card (S18): the row says why it is empty.
	const noResults = state.filter !== "" && entries.length === 0;
	const rows = noResults ? Math.max(0, listRows - 1) : listRows;
	if (noResults && listRows > 0) lines.push(noResultsLine(state, theme, contentWidth));

	const start = windowStart(entries.length, rows, currentView(state).cursor);
	for (let slot = 0; slot < rows; slot++) {
		const index = start + slot;
		const entry = entries[index];
		if (!entry) {
			lines.push(spaces(contentWidth));
			continue;
		}
		hits.set(lines.length, { index, entry });
		lines.push(entryLine(entry, index, state, theme, contentWidth, glyphs, durationWidth, options));
	}

	// Same pair decision as above, spelled as `=== 2` so it cannot be read as a spacing rule.
	if (ruleRows === 2) lines.push(ruleLine(theme, contentWidth, glyphs));
	if (footerRows > 0) {
		// The input takes the footer's row (S18): the key hints would lie while the keys are text.
		lines.push(
			state.filtering
				? filterLine(state, theme, contentWidth, glyphs)
				: footerLine(state, theme, contentWidth, options, glyphs),
		);
	}

	if (!edged) return { lines, hits };

	// The frame is added last so the inside keeps the geometry it always had. `hits` are line indexes,
	// so they move down by the one row the top border occupies.
	const side = paint(theme, "border", glyphs.edge.vertical);
	const top = paint(
		theme,
		"border",
		`${glyphs.edge.topLeft}${glyphs.rule.repeat(contentWidth)}${glyphs.edge.topRight}`,
	);
	const bottom = paint(
		theme,
		"border",
		`${glyphs.edge.bottomLeft}${glyphs.rule.repeat(contentWidth)}${glyphs.edge.bottomRight}`,
	);
	const shifted = new Map<number, EntryHit>();
	for (const [line, hit] of hits) shifted.set(line + 1, hit);
	return { lines: [top, ...lines.map((line) => side + line + side), bottom], hits: shifted };
}

/** One hairline across the card in the `border` role; no padding, so it meets both edges. */
function ruleLine(theme: ViewTheme, width: number, glyphs: Glyphs): string {
	return width > 0 ? paint(theme, "border", glyphs.rule.repeat(width)) : "";
}

function headerLine(state: CardState, theme: ViewTheme, width: number, options: ViewOptions): string {
	const pad = width >= 4 ? HORIZONTAL_PADDING : 0;
	const inner = width - pad * 2;
	const command = "sb-music";
	const summaryText = truncate(summaryOf(visibleEntries(state)), inner);
	const right = command.length + 1 + summaryText.length + 1 <= inner ? summaryText : "";
	const crumbBudget = inner - command.length - 1 - (right ? right.length + 1 : 0);
	const crumb = crumbBudget >= 1 ? truncateTail(headerCrumb(state, options), crumbBudget) : "";
	const left = `${command}${crumb ? ` ${crumb}` : ""}`;

	if (left.length > inner) {
		// Absurdly narrow frame: the command yields, the breadcrumb and the summary are already gone.
		const text = truncate(left, inner);
		return spaces(pad) + theme.bold(text) + spaces(width - pad - text.length);
	}

	const filler = spaces(inner - left.length - right.length);
	return (
		spaces(pad) +
		`${theme.bold(command)}${crumb ? ` ${paint(theme, "dim", crumb)}` : ""}` +
		`${filler}${paint(theme, "dim", right)}` +
		spaces(pad)
	);
}

/**
 * Where you are (S20, L74). The catalog names itself and, inside an album, which album; the library is
 * its breadcrumb, so no absolute home path can reach the card (S14, S15). One header, two sources.
 */
function headerCrumb(state: CardState, options: ViewOptions): string {
	const view = currentView(state);
	if (state.source === "library") return breadcrumb(view.path, options.libraryRoot);
	if (view.path === "") return CATALOG_TITLE;

	const album = state.catalogAlbums.find((candidate) => candidate.slug === view.path);
	return `${CATALOG_TITLE}/${printable(album?.title ?? view.path)}`;
}

/** `N tracks · M:SS` (S3). The total appears only when every track's duration is known. */
function summaryOf(entries: readonly LibraryEntry[]): string {
	const tracks = entries.flatMap((entry) => (entry.kind === "track" ? [entry.track] : []));
	const count = `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`;
	if (tracks.length === 0) return count;

	let total = 0;
	for (const track of tracks) {
		if (track.durationMs === undefined) return count;
		total += track.durationMs;
	}
	return `${count}${SEPARATOR}${clock(total)}`;
}

function widestDuration(entries: readonly LibraryEntry[], options: ViewOptions): number {
	let widest = 0;
	for (const entry of entries) widest = Math.max(widest, durationOf(entry, options).length);
	return widest;
}

/**
 * A track's duration, or nothing. `--:--` used to stand in for "not known yet", but a column of placeholders is
 * dead chrome and it never filled in: the player's answer was spent on the status line and forgotten. Now the
 * column only exists when some visible row knows its length, and only those rows say something (issue #42).
 */
function durationOf(entry: LibraryEntry, options: ViewOptions): string {
	if (entry.kind === "folder") return "";
	const known = entry.track.durationMs ?? options.knownDurations?.get(entry.track.id);
	return known === undefined ? "" : clock(known);
}

function entryLine(
	entry: LibraryEntry,
	index: number,
	state: CardState,
	theme: ViewTheme,
	width: number,
	glyphs: Glyphs,
	durationWidth: number,
	options: ViewOptions,
): string {
	const pad = width >= 6 ? HORIZONTAL_PADDING : 0;
	const inner = width - pad * 2;
	const markerWidth = Math.min(MARKER_WIDTH, inner);
	const rest = inner - markerWidth;

	// Priority when the row is short: the marker cells stay, the duration column goes first (S3).
	let durationWidthHere = durationWidth;
	if (durationWidthHere > 0 && rest < durationWidthHere + 2 * COLUMN_GAP + 1) durationWidthHere = 0;

	const gap = rest >= 2 ? COLUMN_GAP : 0;
	const nameWidth = Math.max(0, rest - gap - (durationWidthHere > 0 ? COLUMN_GAP + durationWidthHere : 0));
	const playingHere = entry.kind === "track" && state.playing?.id === entry.track.id;
	const cursorHere = currentView(state).cursor === index;
	// The pointer's row (S17). It is deliberately NOT the cursor's elevated surface: two identical
	// highlights would make "what would enter open" the less predictable of the two, and the cursor is
	// the one that has to stay unmistakable. Weight is a signal the family of roles already owns
	// (`bold`), it adds no cells, and it never touches the marker cells, so the three combinations of
	// cursor and playback keep their shapes.
	const hoveredHere = state.hover === index;

	const marker = markerCells(cursorHere, playingHere, state.paused, theme, glyphs, markerWidth);
	const name = entryName(entry, nameWidth);
	// The name owns a fixed field, so the duration column never drifts row to row (S3).
	const paintedName = paint(theme, playingHere ? "success" : "text", name);
	const nameText = (hoveredHere ? theme.bold(paintedName) : paintedName) + spaces(nameWidth - printableLength(name));
	const durationText = durationOf(entry, options);
	const duration =
		durationWidthHere > 0
			? `${spaces(COLUMN_GAP)}${durationText ? paint(theme, "muted", durationText) : spaces(durationWidthHere)}`
			: "";

	const line = spaces(pad) + marker + spaces(gap) + nameText + duration + spaces(pad);

	// The host maps the `surface` role to its elevated background: the core names the job, not a colour.
	return cursorHere ? `${theme.bg("surface")}${line}${theme.bgEnd("surface")}` : line;
}

/**
 * The two fixed marker cells (S3): the cursor on the left, playback on the right. A row that is
 * both is `▸●`, so the three combinations never share a shape.
 */
function markerCells(
	cursor: boolean,
	playing: boolean,
	paused: boolean,
	theme: ViewTheme,
	glyphs: Glyphs,
	width: number,
): string {
	const cursorCell = () => (cursor ? paint(theme, "accent", glyphs.cursor) : " ");
	const playingCell = () => (playing ? paint(theme, "success", paused ? glyphs.paused : glyphs.playing) : " ");

	if (width >= 2) return cursorCell() + playingCell();
	// One cell left: the cursor wins, otherwise the row would lose its selection.
	if (width === 1) return cursor ? paint(theme, "accent", glyphs.cursor) : playingCell();
	return "";
}

function entryName(entry: LibraryEntry, budget: number): string {
	if (budget <= 0) return "";
	if (entry.kind === "folder") return `${truncate(printable(entry.folder.name), budget - 1)}/`;
	return truncate(printable(entry.track.title), budget);
}

function windowStart(total: number, visible: number, cursor: number): number {
	if (visible <= 0 || total <= visible) return 0;
	const centered = cursor - Math.floor(visible / 2);
	return Math.min(Math.max(0, centered), total - visible);
}

/* --- the footer (S3, S11, S13) --------------------------------------------------------------- */

function footerLine(state: CardState, theme: ViewTheme, width: number, options: ViewOptions, glyphs: Glyphs): string {
	const pad = width >= 4 ? HORIZONTAL_PADDING : 0;
	const inner = width - pad * 2;
	const total = totalOf(state.playing, options);
	const progress =
		state.playing && total !== undefined
			? { elapsedMs: Math.max(0, options.elapsedMs ?? 0), totalMs: total }
			: undefined;
	const overhead = progress ? clock(progress.elapsedMs).length + clock(progress.totalMs).length + 2 : 0;
	const canProgress = progress !== undefined && inner >= overhead + MIN_BAR + 1;
	const budget = canProgress ? inner - overhead - MIN_BAR - 1 : inner;
	const left = footerText(state, budget, options);

	if (!canProgress || !progress) {
		return spaces(pad) + paint(theme, footerRole(state), left) + spaces(inner - left.length) + spaces(pad);
	}

	const barWidth = Math.min(MAX_BAR, Math.max(MIN_BAR, inner - left.length - overhead - 1));
	const elapsed = clock(progress.elapsedMs);
	const totalText = clock(progress.totalMs);
	const right =
		paint(theme, "dim", elapsed) +
		" " +
		progressBar(theme, progress.elapsedMs, progress.totalMs, barWidth, glyphs) +
		" " +
		paint(theme, "dim", totalText);
	return (
		spaces(pad) +
		paint(theme, footerRole(state), left) +
		spaces(inner - left.length - overhead - barWidth) +
		right +
		spaces(pad)
	);
}

function footerRole(state: CardState): Role {
	return state.notice || state.failure ? "accent" : "muted";
}

/**
 * Who speaks in the footer: a notice (S11, S14), then a folder that could not be shown (S5), then the
 * read in flight (S21); with nothing to report, every key is announced (S13).
 */
function footerText(state: CardState, budget: number, options: ViewOptions): string {
	if (state.notice) return truncate(printable(state.notice), budget);
	// A folder that could not be shown names it the way the header does (S5): the failure arrived as
	// data, so the breadcrumb is formatted here and one rule covers both lines — no absolute home
	// path can reach the card (S14, S15).
	if (state.failure) {
		const folder = breadcrumb(state.failure.path, options.libraryRoot);
		return truncate(printable(`cannot show ${folder}: ${state.failure.reason}`), budget);
	}
	// A read in flight says what it is reading (S21). The library's read names a folder, so it is repeated as
	// the header's breadcrumb and no absolute home path can reach the card (S15); the catalog's read is
	// already a label the shell composed (`catalog · 3 of 12 albums`, L75) and is printed as it arrived.
	if (state.reading) {
		const what = state.source === "library" ? breadcrumb(state.reading, options.libraryRoot) : printable(state.reading);
		return truncate(printable(`reading ${what}`), budget);
	}
	return hintText(budget);
}

/**
 * Hints come from the model's only key table (S13), never from a second list. The row first tries
 * `key help`, then falls back to keys alone, so it drops help before it drops a key.
 */
function hintText(budget: number): string {
	const hints = footerHints();
	const full = hints.map((hint) => `${hint.key} ${hint.help}`).join(SEPARATOR);
	const compact = hints.map((hint) => hint.key).join(SEPARATOR);
	const text = [...full].length <= budget ? full : compact;
	return truncate(text, budget);
}

function progressBar(theme: ViewTheme, elapsedMs: number, totalMs: number, width: number, glyphs: Glyphs): string {
	const head = totalMs > 0 ? Math.min(width - 1, Math.max(0, Math.round((elapsedMs / totalMs) * (width - 1)))) : 0;
	const filled = `${glyphs.bar.fill.repeat(head)}${glyphs.bar.head}`;
	const rest = glyphs.bar.rest.repeat(width - 1 - head);
	return `${paint(theme, "success", filled)}${paint(theme, "dim", rest)}`;
}

/* --- the filter over the current folder (S18) ------------------------------------------------ */

/**
 * The filter input (S18): a prompt, the term and a caret that says "this is an input". It takes the
 * footer's row, so the card keeps its height and the key hints stop claiming keys that now type.
 */
function filterLine(state: CardState, theme: ViewTheme, width: number, glyphs: Glyphs): string {
	const pad = width >= 2 ? HORIZONTAL_PADDING : 0;
	const inner = width - pad * 2;
	if (inner <= 0) return spaces(width);

	const caret = glyphs.caret;
	const prompt = inner >= 2 ? "/" : "";
	const room = Math.max(0, inner - printableLength(prompt) - printableLength(caret));
	const term = truncateHead(printable(state.filter), room);
	const content = (prompt ? paint(theme, "accent", prompt) : "") + term + paint(theme, "accent", caret);
	const contentWidth = printableLength(prompt) + printableLength(term) + printableLength(caret);
	return spaces(pad) + content + spaces(inner - contentWidth) + spaces(pad);
}

/**
 * The no-results row (S18): an empty listing with a term is a state that explains itself, never a
 * blank card. It names the term and offers the key that clears it, both from the only key table.
 * A term too long for the row is shortened itself, so the offer to clear it never falls off the end.
 */
function noResultsLine(state: CardState, theme: ViewTheme, width: number): string {
	const pad = width >= 2 ? HORIZONTAL_PADDING : 0;
	const inner = width - pad * 2;
	const clear = footerHints().find((hint) => hint.action === "hide")?.key ?? "esc";
	const head = "no matches for ";
	const tail = ` · ${clear} clears`;
	const budget = inner - printableLength(head) - printableLength(tail) - 2;
	const term = printable(state.filter);
	const text =
		budget > 0 ? `${head}"${truncate(term, budget)}"${tail}` : truncate(printable(`${head}"${term}"${tail}`), inner);
	return spaces(pad) + paint(theme, "muted", text) + spaces(inner - printableLength(text)) + spaces(pad);
}

/* --- the corner card (S15) ------------------------------------------------------------------- */

function cornerFrame(
	state: CardState,
	theme: ViewTheme,
	width: number,
	height: number,
	options: ViewOptions,
	glyphs: Glyphs,
): Frame {
	const playing = state.playing;
	if (!playing) {
		// An idle corner still has to be visible: an empty frame is indistinguishable from a
		// shortcut that did nothing, which is exactly how the first real smokes read (S15).
		const idleWidth = Math.min(width, CORNER_WIDTH);
		const idlePad = idleWidth >= 4 ? HORIZONTAL_PADDING : 0;
		const idleInner = idleWidth - idlePad * 2;
		if (idleInner <= 0) return { lines: [], hits: new Map() };
		const label = truncate("nothing playing", Math.max(0, idleInner - printableLength(glyphs.paused) - 1));
		const content = paint(theme, "muted", glyphs.paused) + (label ? ` ${label}` : "");
		return {
			lines: [spaces(idlePad) + content + spaces(idleInner - printableLength(content)) + spaces(idlePad)],
			hits: new Map(),
		};
	}

	const cardWidth = Math.min(width, CORNER_WIDTH);
	const pad = cardWidth >= 4 ? HORIZONTAL_PADDING : 0;
	const inner = cardWidth - pad * 2;
	const total = totalOf(playing, options);
	const elapsed = Math.max(0, options.elapsedMs ?? 0);
	const glyph = state.paused ? glyphs.paused : glyphs.playing;
	// Only the elapsed time when the total is unknown: `1:20 / --:--` reads like a broken card, and
	// the bar it belongs to cannot be drawn either (S15).
	const time = total === undefined ? clock(elapsed) : `${clock(elapsed)} / ${clock(total)}`;
	const lines = [cornerStateLine(theme, glyph, time, inner, pad)];

	if (total !== undefined && height >= 2 && inner > 0) {
		lines.push(spaces(pad) + progressBar(theme, elapsed, total, inner, glyphs) + spaces(pad));
	}
	return { lines, hits: new Map() };
}

function cornerStateLine(theme: ViewTheme, glyph: string, time: string, inner: number, pad: number): string {
	const glyphWidth = printableLength(glyph);
	const timeWidth = printableLength(time);
	if (glyphWidth + timeWidth + 1 <= inner) {
		return (
			spaces(pad) +
			paint(theme, "success", glyph) +
			spaces(inner - glyphWidth - timeWidth) +
			paint(theme, "dim", time) +
			spaces(pad)
		);
	}
	// Too narrow for both: the state glyph survives, the time is what gives way.
	const text = truncate(time, Math.max(0, inner - glyphWidth - 1));
	const content = paint(theme, "success", glyph) + (text ? ` ${paint(theme, "dim", text)}` : "");
	const contentWidth = glyphWidth + (text ? text.length + 1 : 0);
	return spaces(pad) + content + spaces(inner - contentWidth) + spaces(pad);
}

/* --- shared helpers -------------------------------------------------------------------------- */

/** The role prefix theory: `fg(role)` paints the cells that follow it; the view restores the text role. */
function paint(theme: ViewTheme, role: Role, text: string): string {
	if (text === "") return "";
	if (role === "text") return text;
	return `${theme.fg(role)}${text}${theme.fg("text")}`;
}

function totalOf(track: Track | undefined, options: ViewOptions): number | undefined {
	if (!track) return undefined;
	return options.totalMs ?? track.durationMs;
}

/** Minutes and seconds (S3, S12): no hours, 41:20 and 3:42 are the shapes the artboard uses. */
function clock(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function spaces(count: number): string {
	return " ".repeat(Math.max(0, count));
}

/**
 * Cell budget, counted in code points so a truncation never splits a surrogate pair. Wide (CJK)
 * characters count as one here: a full wcwidth needs a table and this module ships no dependency.
 */
function printableLength(text: string): number {
	return [...text].length;
}

function truncate(text: string, budget: number): string {
	if (budget <= 0) return "";
	const characters = [...text];
	if (characters.length <= budget) return text;
	if (budget === 1) return ELLIPSIS;
	return `${characters.slice(0, budget - 1).join("")}${ELLIPSIS}`;
}

/** Truncation for a breadcrumb: keep its tail, which is the folder you are actually in. */
function truncateTail(text: string, budget: number): string {
	if (budget <= 0) return "";
	const characters = [...text];
	if (characters.length <= budget) return text;
	if (budget === 1) return ELLIPSIS;
	const tail = characters.slice(characters.length - (budget - 1)).join("");
	const slash = tail.indexOf("/");
	return `${ELLIPSIS}${slash > 0 ? tail.slice(slash) : tail}`;
}

/** Truncation for an input: keep its end, which is what the user just typed and is looking at. */
function truncateHead(text: string, budget: number): string {
	if (budget <= 0) return "";
	const characters = [...text];
	if (characters.length <= budget) return text;
	if (budget === 1) return ELLIPSIS;
	return `${ELLIPSIS}${characters.slice(characters.length - (budget - 1)).join("")}`;
}

/**
 * Characters that act on the terminal instead of occupying a cell (AGENTS.md). `lib/core/names`
 * neutralizes names at the source; a renderer that trusts its input is one refactor away from an
 * escape sequence in the chrome, so the rule is applied here too — the core cannot import library.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

function printable(text: string): string {
	return text.replace(UNSAFE, "");
}

/**
 * The breadcrumb (S14): relative to `libraryRoot` while the folder is inside it, `~/…` above it.
 * Never an absolute home path. Pure string arithmetic in the path's own flavour (S19).
 *
 * Exported because the rule is one rule: the header and the footer both name a folder, and the host
 * formats its own warning with it too, so no surface can print an absolute home path (S15).
 */
export function breadcrumb(path: string, libraryRoot: string): string {
	const flavour = posix.isAbsolute(path) ? posix : win32;
	const relative = flavour.relative(libraryRoot, path);
	if (relative === "") {
		const root = flavour.parse(libraryRoot).root;
		return printable(flavour.basename(libraryRoot) || root || libraryRoot);
	}
	if (flavour.isAbsolute(relative)) return "~/…";

	const segments = relative.split(flavour.sep).filter((segment) => segment.length > 0);
	if (segments.length === 0 || segments[0] === "..") return "~/…";
	return printable(segments.join("/"));
}
