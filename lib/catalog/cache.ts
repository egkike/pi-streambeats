/**
 * The catalog's cache (S20, L75): metadata only, redownloadable, atomic and private.
 *
 * It is one of the extension's own files and nothing else: `catalog.json` never holds an audio URL
 * (the parser keeps tokens in a separate function for exactly this reason), it is written `0600` in a
 * `0750` directory by tmp+rename, and a file that cannot be read is a **missing** cache. The card has
 * to be able to open, so nothing here throws at its caller.
 *
 * The TTL lives here as one constant and one predicate because L75 decided it once: a warm cache does
 * not touch the network, and 24 h is when it stops being warm. A degraded entry is the one exception and it
 * is still this module's rule: it gets a short window and is not trusted while it is young (R4-001).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, posix, win32 } from "node:path";
import type { SettingsContext } from "../settings.ts";
import type { CatalogAlbumListing, CatalogCache, CatalogTrack } from "../types.ts";

/** L75: revalidated in the background after a day. The catalog changes when StreamBeats publishes. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * R4-001: a degraded entry lives 45 minutes, not a day. Long enough to save the repeat download across the
 * opens of a working session, short enough that a shrunken list cannot survive a working day if the network
 * never comes back. A whole entry that replaced it is back on the rule above the moment it is written.
 */
export const CATALOG_PARTIAL_TTL_MS = 45 * 60 * 1000;

function pathFor(platform: SettingsContext["platform"]) {
	return platform === "win32" ? win32 : posix;
}

/**
 * The XDG cache directory: `$XDG_CACHE_HOME` when it is absolute, the platform's own cache directory
 * otherwise. The XDG spec ignores a relative base, and so do we — the same rule `configHome` applies.
 */
function cacheHome(ctx: SettingsContext): string {
	const path = pathFor(ctx.platform);
	if (ctx.platform === "win32") {
		const local = ctx.env.LOCALAPPDATA?.trim();
		if (local) return local;
		return path.join(ctx.home, "AppData", "Local");
	}
	if (ctx.platform === "darwin") return path.join(ctx.home, "Library", "Caches");
	const xdg = ctx.env.XDG_CACHE_HOME?.trim();
	if (xdg && path.isAbsolute(xdg)) return xdg;
	return path.join(ctx.home, ".cache");
}

/** Where the catalog's metadata lives (S20): the extension's own name inside the cache home. */
export function catalogCachePath(ctx: SettingsContext): string {
	return pathFor(ctx.platform).join(cacheHome(ctx), "pi-streambeats", "catalog.json");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}

function albumOf(value: unknown): CatalogAlbumListing | undefined {
	if (!isRecord(value)) return undefined;
	const { slug, title, tracks } = value;
	if (typeof slug !== "string" || typeof title !== "string" || !Array.isArray(tracks)) return undefined;

	const parsed: CatalogTrack[] = [];
	for (const track of tracks) {
		if (!isRecord(track)) return undefined;
		const { slug: trackSlug, title: trackTitle, durationMs } = track;
		if (typeof trackSlug !== "string" || typeof trackTitle !== "string") return undefined;
		// Only a finite, positive duration is a duration. The parser admits nothing else, so anything else here
		// is a file someone else edited, and the whole cache is treated as missing rather than half trusted:
		// a zero would render as `0:00` and a negative as nonsense, with nothing to say where it came from.
		if (
			durationMs !== undefined &&
			(typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0)
		) {
			return undefined;
		}
		parsed.push(
			durationMs === undefined
				? { slug: trackSlug, title: trackTitle }
				: { slug: trackSlug, title: trackTitle, durationMs },
		);
	}

	return { slug, title, tracks: parsed };
}

/**
 * A cache read strictly, because it is a file another program's crash could have half-written: a wrong
 * version, a missing stamp or one malformed album makes the whole file a missing cache.
 */
function cacheOf(value: unknown): CatalogCache | undefined {
	if (!isRecord(value)) return undefined;
	const { version, fetchedAt, albums, partial } = value;
	if (version !== 1) return undefined;
	if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) return undefined;
	if (!Array.isArray(albums)) return undefined;
	// A degradation is the only thing this field may say, and it says it by being `true`: anything else — a
	// `false` claiming a whole read, a `1`, a string — is a file edited to a shape the writer never produced,
	// and an entry whose TTL depends on the answer is not one to half trust.
	if (partial !== undefined && partial !== true) return undefined;

	const parsed: CatalogAlbumListing[] = [];
	for (const album of albums) {
		const listing = albumOf(album);
		if (!listing) return undefined;
		parsed.push(listing);
	}

	// The key is omitted rather than set to `false`, so what a whole pass wrote reads back as what it wrote.
	return partial === true
		? { version: 1, fetchedAt, albums: parsed, partial: true }
		: { version: 1, fetchedAt, albums: parsed };
}

/** The cached catalog, or `undefined` when it is absent, unreadable, malformed or from another version. */
export function readCatalogCache(path: string): CatalogCache | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}

	return cacheOf(parsed);
}

/**
 * Write the cache atomically: a temporary file in the same directory, then a rename, so a reader never
 * sees half a catalog. Answers `false` instead of throwing — a cache that could not be written is a
 * cache that is not there, and the card still opens.
 */
export function writeCatalogCache(path: string, cache: CatalogCache): boolean {
	// Writing a cache that cannot be read back is a promise broken one start later: `JSON.stringify` turns a
	// non-finite number into `null`, and the reader rejects it. Refusing here is cheap and honest.
	if (!cacheOf(cache)) return false;

	// The temporary is named after a random value, not the pid: `catalog.json.<pid>.tmp` is a name anyone who
	// can write in this directory could pre-create as a symlink, and the write would follow it.
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
		writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
		renameSync(temporary, path);
		return true;
	} catch {
		// A failed write must not leave its temporary behind: a stray `.tmp` in the user's cache directory is
		// litter we created, and the next read would ignore it anyway. The cleanup itself can fail — there is no
		// directory to remove it from — and that is still the same answer: the cache is not there.
		try {
			rmSync(temporary, { force: true });
		} catch {
			// Nothing left to clean.
		}
		return false;
	}
}

/**
 * Whether the cache is still worth trusting (L75, R4-001). A stamp in the future is stale: a clock that went
 * backwards is not evidence that the catalog is fresh.
 *
 * The TTL is chosen here and nowhere else, because it is a policy about the file and not about a caller: a
 * degraded entry gets the short window, a whole one the full day. An explicit TTL still wins, so the window
 * stays one rule the tests can move instead of a constant they would have to wait for.
 */
export function isCatalogFresh(cache: CatalogCache, now: number, ttlMs?: number): boolean {
	const ttl = ttlMs ?? (cache.partial === true ? CATALOG_PARTIAL_TTL_MS : CATALOG_TTL_MS);
	const age = now - cache.fetchedAt;
	return age >= 0 && age < ttl;
}
