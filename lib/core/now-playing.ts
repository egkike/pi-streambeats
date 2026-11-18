/**
 * The status line's now-playing formatter (S12). A `CardState`-shaped view goes in; one segment
 * comes out, or nothing at all when no track is playing. Pure and synchronous (S8): no clock, no
 * terminal, no filesystem — the elapsed time arrives as data and colour is the host's job.
 *
 * The segment is the status bar's whole claim on the title (S12): `● 03 - Song.mp3` becomes
 * `● Song · Album 0:12/3:42`. The card never repeats it, so this string is the only place where
 * the playing track is named.
 */
import { posix, win32 } from "node:path";
import type { Track } from "../types.ts";
import { glyphFamily } from "./view.ts";

/**
 * The nine audio extensions of the repo (S5), with the leading dot, matched case-insensitively
 * because files copied from a case-insensitive filesystem arrive upper-cased. The list is repeated
 * here because `lib/core` sits below `lib/library` in the dependency direction (S8) and may not
 * import it; `lib/core/names.ts` owns the same nine for scanning.
 */
const AUDIO_EXTENSIONS = "mp3|flac|ogg|oga|opus|m4a|aac|wav|wma";

/**
 * The one shape that gets cleaned (S12): a track number, the exact `" - "` separator, a title and a
 * known audio extension. Anything else — a date such as `2024-11-10 - live set.mp3`, a name without
 * the prefix, a suffix that is not audio — is shown as it is, extension included, with no guessing.
 */
const TRACK_FILE = new RegExp(`^\\d+ - (.+?)\\.(?:${AUDIO_EXTENSIONS})$`, "i");

const ELLIPSIS = "…";
const SEPARATOR = " · ";
const UNKNOWN_TIME = "--:--";

/** What the formatter reads from the card: the playing track and whether it is paused (S12). */
export interface NowPlayingState {
	/** The track mpv has loaded, if any. Absent means silence: there is no segment at all. */
	readonly playing?: Track;
	readonly paused: boolean;
}

/** Inputs that come from the player, not from the track's metadata (S12). */
export interface SegmentOptions {
	/** Position reported by the player. The formatter owns no clock, so the caller freezes it on pause. */
	readonly elapsedMs?: number;
	/** Duration the player knows better than the track; falls back to `track.durationMs`. */
	readonly totalMs?: number;
	/** The S16 escape hatch for terminals where the geometric glyphs occupy two cells. */
	readonly asciiGlyphs?: boolean;
}

/**
 * The clean title (S12). The prefix and the extension are removed only when the name matches the
 * exact shape; otherwise the name comes back untouched, so a date or a foreign format is never
 * mangled into something the user did not ask for.
 */
export function cleanTitle(name: string): string {
	return TRACK_FILE.exec(name)?.[1] ?? name;
}

/**
 * The folder label (S12): the name of the directory that contains the track. The path arrives in
 * the flavour it already speaks, so a POSIX and a Windows track are both read without a filesystem.
 * Where the directory has no name of its own (a file at the root) the root is the label, because a
 * blank is not a label.
 */
export function folderLabel(path: string): string {
	const flavour = posix.isAbsolute(path) ? posix : win32;
	const parent = flavour.dirname(path);
	return flavour.basename(parent) || flavour.parse(parent).root || parent;
}

/**
 * The status line's music segment (S12), at most `width` cells and never wrapped:
 *
 *   playing  `● <title> · <folder> <m:ss>/<m:ss>`
 *   paused   `○ <title> · <folder> <m:ss>/<m:ss>`
 *   silence  no segment at all (undefined), which is also the state after the queue ends
 *
 * When the width is short the title is the first to give way, truncated with `…`; then the folder
 * is dropped whole; the time is the last to go, and the glyph never does, because the glyph is what
 * tells playing from paused when colour is not an option.
 */
export function statusSegment(state: NowPlayingState, width: number, options: SegmentOptions = {}): string | undefined {
	const track = state.playing;
	// S12: nothing playing, or the model already cleared it at the end of the queue.
	if (!track) return undefined;

	const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	const glyphs = glyphFamily(options.asciiGlyphs === true);
	const glyph = state.paused ? glyphs.paused : glyphs.playing;
	const total = options.totalMs ?? track.durationMs;
	const time = `${clock(options.elapsedMs ?? 0)}/${total === undefined ? UNKNOWN_TIME : clock(total)}`;
	const title = cleanTitle(track.title);
	const folder = folderLabel(track.id);

	const whole = `${glyph} ${title}${SEPARATOR}${folder} ${time}`;
	if (lengthOf(whole) <= columns) return whole;

	// The title collapses first, and it is the only part that truncates with an ellipsis (S12).
	const titleBudget = columns - lengthOf(`${glyph} ${SEPARATOR}${folder} ${time}`);
	if (titleBudget >= 1) return `${glyph} ${truncate(title, titleBudget)}${SEPARATOR}${folder} ${time}`;

	// The title is already at its smallest: the folder goes whole before the time yields.
	const condensed = `${glyph} ${ELLIPSIS} ${time}`;
	if (lengthOf(condensed) <= columns) return condensed;

	// Last resort: the time shrinks, the glyph does not. A segment of zero cells is empty, not absent.
	if (columns <= lengthOf(glyph)) return columns <= 0 ? "" : glyph;
	const text = truncate(time, columns - lengthOf(glyph) - 1);
	return text === "" ? glyph : `${glyph} ${text}`;
}

/** Minutes and seconds (S12): no hours and no padded minutes, so 3:42 and 62:03 are both the shape. */
function clock(milliseconds: number): string {
	const safe = Number.isFinite(milliseconds) ? milliseconds : 0;
	const seconds = Math.max(0, Math.floor(safe / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Cell budget, counted in code points so a truncation never splits a surrogate pair. */
function lengthOf(text: string): number {
	return [...text].length;
}

/** The same rule the card's renderer uses: keep the head, spend the last cell on the ellipsis. */
function truncate(text: string, budget: number): string {
	if (budget <= 0) return "";
	const characters = [...text];
	if (characters.length <= budget) return text;
	if (budget === 1) return ELLIPSIS;
	return `${characters.slice(0, budget - 1).join("")}${ELLIPSIS}`;
}
