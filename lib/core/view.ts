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
import { type CardState, footerHints, visibleEntries } from "./model.ts";

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
	bar: { fill: "━", head: "╸", rest: "─" },
};

const ASCII: Glyphs = {
	playing: "*",
	paused: "-",
	cursor: ">",
	expanded: "v",
	caret: "|",
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
	const footerRows = height >= 2 ? 1 : 0;
	const listRows = Math.max(0, height - 1 - footerRows);
	const durationWidth = widestDuration(entries);

	lines.push(headerLine(state, theme, width, options));

	// An empty listing with a term is a state, not a blank card (S18): the row says why it is empty.
	const noResults = state.filter !== "" && entries.length === 0;
	const rows = noResults ? Math.max(0, listRows - 1) : listRows;
	if (noResults && listRows > 0) lines.push(noResultsLine(state, theme, width));

	const start = windowStart(entries.length, rows, state.cursor);
	for (let slot = 0; slot < rows; slot++) {
		const index = start + slot;
		const entry = entries[index];
		if (!entry) {
			lines.push(spaces(width));
			continue;
		}
		hits.set(lines.length, { index, entry });
		lines.push(entryLine(entry, index, state, theme, width, glyphs, durationWidth));
	}

	if (footerRows > 0) {
		// The input takes the footer's row (S18): the key hints would lie while the keys are text.
		lines.push(
			state.filtering ? filterLine(state, theme, width, glyphs) : footerLine(state, theme, width, options, glyphs),
		);
	}
	return { lines, hits };
}

function headerLine(state: CardState, theme: ViewTheme, width: number, options: ViewOptions): string {
	const pad = width >= 4 ? HORIZONTAL_PADDING : 0;
	const inner = width - pad * 2;
	const command = "sb-music";
	const summaryText = truncate(summaryOf(visibleEntries(state)), inner);
	const right = command.length + 1 + summaryText.length + 1 <= inner ? summaryText : "";
	const crumbBudget = inner - command.length - 1 - (right ? right.length + 1 : 0);
	const crumb = crumbBudget >= 1 ? truncateTail(breadcrumb(state.path, options.libraryRoot), crumbBudget) : "";
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

function widestDuration(entries: readonly LibraryEntry[]): number {
	let widest = 0;
	for (const entry of entries) widest = Math.max(widest, durationOf(entry).length);
	return widest;
}

/** A track's duration, or a tabular placeholder until the player knows it. Folders have none. */
function durationOf(entry: LibraryEntry): string {
	if (entry.kind === "folder") return "";
	if (entry.track.durationMs === undefined) return "--:--";
	return clock(entry.track.durationMs);
}

function entryLine(
	entry: LibraryEntry,
	index: number,
	state: CardState,
	theme: ViewTheme,
	width: number,
	glyphs: Glyphs,
	durationWidth: number,
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
	const cursorHere = state.cursor === index;

	const marker = markerCells(cursorHere, playingHere, state.paused, theme, glyphs, markerWidth);
	const name = entryName(entry, nameWidth);
	// The name owns a fixed field, so the duration column never drifts row to row (S3).
	const nameText = paint(theme, playingHere ? "success" : "text", name) + spaces(nameWidth - printableLength(name));
	const durationText = durationOf(entry);
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
	const left = footerText(state, budget);

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
	return state.notice ? "accent" : "muted";
}

/** The notice owns the footer while it is active (S11, S14); otherwise every hint is announced. */
function footerText(state: CardState, budget: number): string {
	if (state.notice) return truncate(printable(state.notice), budget);
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
	if (!playing) return { lines: [], hits: new Map() };

	const cardWidth = Math.min(width, CORNER_WIDTH);
	const pad = cardWidth >= 4 ? HORIZONTAL_PADDING : 0;
	const inner = cardWidth - pad * 2;
	const total = totalOf(playing, options);
	const elapsed = Math.max(0, options.elapsedMs ?? 0);
	const glyph = state.paused ? glyphs.paused : glyphs.playing;
	const time = `${clock(elapsed)} / ${total === undefined ? "--:--" : clock(total)}`;
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
 * Characters that act on the terminal instead of occupying a cell (AGENTS.md). `lib/library/names`
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
 */
function breadcrumb(path: string, libraryRoot: string): string {
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
