/**
 * Catalog parsing (S20). Bandcamp embeds its catalog in the HTML: the index lists `/album/<slug>`
 * links inside a grid, and each album page carries a `data-tralbum` attribute whose value is escaped
 * JSON. No API and no selectors — two narrow reads, which is why they are coupling we do not own.
 *
 * Three rules shape this module:
 *
 * 1. **The slug is the identity.** An album is its slug and a track is its slug inside an album; a
 *    title is decoration that the site can change without changing what the row *is*.
 * 2. **A failure is data, never a throw.** A page without a tralbum, or one whose JSON does not parse,
 *    answers `undefined` so the caller can skip that album and keep going.
 * 3. **Nothing here is trusted to reach a renderer unchanged.** Titles come from the network, so they
 *    are neutralized exactly like a file name (S5) before they leave this layer.
 *
 * The audio URL is parsed by `parseTrackUrl` alone: metadata and the ephemeral token are read by two
 * functions, so the cache has no shape in which a token could be stored (S20).
 */
import { neutralizeName } from "../core/names.ts";
import type { CatalogAlbum, CatalogTrack } from "../types.ts";

/** One grid item: the row that carries an album's link and its title. */
const GRID_ITEM = /<li data-item-id="album-[^"]*"[\s\S]*?<\/li>/g;
const ALBUM_LINK = /<a href="\/album\/([a-z0-9-]+)"/;
/** The title is the text before the artist override, which the grid puts after a `<br>`. */
const ALBUM_TITLE = /<p class="title">([\s\S]*?)<br/;
/** The attribute's value holds no raw quote: the payload escapes them, so the first one closes it. */
const TRALBUM_ATTRIBUTE = /data-tralbum="([\s\S]*?)"/;
const TRACK_LINK = /^\/track\/([a-z0-9-]+)$/;
const ALBUM_SLUG = /^[a-z0-9-]+$/;

const ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: " ",
	quot: '"',
};

/** The five named entities Bandcamp uses, plus numeric ones; anything else is left as it arrived. */
function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) return codePoint(whole, Number.parseInt(body.slice(2), 16));
		if (body.startsWith("#")) return codePoint(whole, Number.parseInt(body.slice(1), 10));
		return ENTITIES[body.toLowerCase()] ?? whole;
	});
}

function codePoint(whole: string, value: number): string {
	if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return whole;
	return String.fromCodePoint(value);
}

/** A slug is already a readable name once its dashes are spaces; it is the honest fallback. */
function titleFromSlug(slug: string): string {
	return slug
		.split("-")
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/** A title that survives neutralization and trimming, or the slug's own name when nothing is left. */
function displayTitle(raw: string | undefined, slug: string): string {
	const decoded = neutralizeName(decodeEntities(raw ?? "")).trim();
	return decoded.length > 0 ? decoded : titleFromSlug(slug);
}

/**
 * One index page as the parser saw it (S20): the albums it announced, and how many rows it could not
 * read as an album at all.
 */
export interface AlbumGrid {
	readonly albums: CatalogAlbum[];
	/** Grid rows that were an album item but carried no `/album/<slug>` link. */
	readonly unrecognized: number;
}

/**
 * The albums the index page announces, in page order, one per slug (S20), plus the count of rows that
 * could not be read. An item whose title markup moved keeps its row under a humanized slug: losing the
 * pretty name is a smaller failure than losing an album, and the identity — what the card navigates by —
 * was never the title. A row whose **link** moved is not that case: the album is gone, so the caller is
 * told, and a partly read grid can be raised as the same explicit failure as an empty one instead of
 * shrinking into a list that gets cached.
 */
export function readAlbumGrid(html: string): AlbumGrid {
	const albums: CatalogAlbum[] = [];
	const seen = new Set<string>();
	let unrecognized = 0;

	for (const item of html.match(GRID_ITEM) ?? []) {
		const slug = ALBUM_LINK.exec(item)?.[1];
		if (!slug) {
			unrecognized += 1;
			continue;
		}
		// A repeated slug is the one benign skip: the same album twice is not markup we failed to read.
		if (seen.has(slug)) continue;
		seen.add(slug);
		albums.push({ slug, title: displayTitle(ALBUM_TITLE.exec(item)?.[1], slug) });
	}

	return { albums, unrecognized };
}

type RawTrack = Readonly<Record<string, unknown>>;

/**
 * The `trackinfo` array of the page's tralbum, or `undefined` when the page carries none — a 404, an
 * album page whose markup changed, or JSON that does not parse. Never throws: a page we cannot read
 * is one album skipped by a tolerant refresh, not a card that dies.
 */
function trackinfoOf(html: string): RawTrack[] | undefined {
	const attribute = TRALBUM_ATTRIBUTE.exec(html)?.[1];
	if (attribute === undefined) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeEntities(attribute));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;

	const trackinfo = (parsed as { trackinfo?: unknown }).trackinfo;
	if (!Array.isArray(trackinfo)) return undefined;
	return trackinfo.filter((entry): entry is RawTrack => typeof entry === "object" && entry !== null);
}

/** The signed URL of a track, when the payload carries one: without it the track could never play. */
function audioUrl(entry: RawTrack): string | undefined {
	const file = entry.file;
	if (typeof file !== "object" || file === null) return undefined;
	const url = (file as Record<string, unknown>)["mp3-128"];
	return typeof url === "string" && url.length > 0 ? url : undefined;
}

/** The track's own slug, from its link: `/track/<slug>`, and nothing else. */
function trackSlug(entry: RawTrack): string | undefined {
	const link = entry.title_link;
	return typeof link === "string" ? TRACK_LINK.exec(link)?.[1] : undefined;
}

/**
 * The tracks of one album page, ordered by their own track number (S20): the payload's order is an
 * implementation detail of the site, while an album's order is what a listener expects.
 */
export function parseAlbumPage(html: string): CatalogTrack[] | undefined {
	const trackinfo = trackinfoOf(html);
	if (!trackinfo) return undefined;

	// A track without a number has no ordering fact of its own, so it carries the payload's position and
	// sorts after every numbered track. Inventing a number instead — the length of the rows accepted so far —
	// both collided with a real number and jumped the queue, because it started at 0 while real numbers
	// start at 1. Payload order as an explicit rule, not as the stable sort's accident.
	const rows: { readonly number: number; readonly position: number; readonly track: CatalogTrack }[] = [];

	for (const [position, entry] of trackinfo.entries()) {
		const slug = trackSlug(entry);
		if (!slug || !audioUrl(entry)) continue;
		const title = displayTitle(typeof entry.title === "string" ? entry.title : undefined, slug);
		if (title.length === 0) continue;

		const seconds = entry.duration;
		const durationMs =
			typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
		const number = typeof entry.track_num === "number" ? entry.track_num : Number.POSITIVE_INFINITY;

		// The duration key is omitted when unknown: a `durationMs: undefined` would print as absent anyway,
		// and the cache is a file where "absent" and "undefined" must not be two different shapes.
		rows.push({ number, position, track: durationMs === undefined ? { slug, title } : { slug, title, durationMs } });
	}

	rows.sort((left, right) =>
		left.number === right.number ? left.position - right.position : left.number - right.number,
	);
	return rows.map((row) => row.track);
}

/**
 * The signed URL of one track of an album page, resolved **on demand** and never stored (S20): a
 * cached URL is an expired URL, and a token on disk outlives the play that paid for it.
 */
export function parseTrackUrl(html: string, trackSlugToFind: string): string | undefined {
	for (const entry of trackinfoOf(html) ?? []) {
		if (trackSlug(entry) !== trackSlugToFind) continue;
		const url = audioUrl(entry);
		if (url) return url;
	}
	return undefined;
}

/** Whether a string is the shape of an album slug, so a URL is never built out of nonsense. */
export function isAlbumSlug(value: string): boolean {
	return ALBUM_SLUG.test(value);
}
