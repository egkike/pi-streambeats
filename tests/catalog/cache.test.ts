/**
 * The catalog cache (S20): metadata only, redownloadable, atomic and private.
 *
 * Two rules are pinned here because they are promises, not preferences: **no audio URL is ever
 * persisted** (a signed URL in a file is a token on disk), and a cache that cannot be read is a
 * missing cache, never a crash — the card has to open either way.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	CATALOG_TTL_MS,
	catalogCachePath,
	isCatalogFresh,
	readCatalogCache,
	writeCatalogCache,
} from "../../lib/catalog/cache.ts";
import { parseAlbumIndex, parseAlbumPage } from "../../lib/catalog/parse.ts";
import type { CatalogCache } from "../../lib/types.ts";

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "sb-catalog-"));
}

function sampleCache(fetchedAt: number): CatalogCache {
	return {
		version: 1,
		fetchedAt,
		albums: [
			{ slug: "electric", title: "Electric", tracks: [{ slug: "electric", title: "Electric", durationMs: 1000 }] },
		],
	};
}

describe("catalogCachePath (S20)", () => {
	it("lives under XDG_CACHE_HOME when it is absolute", () => {
		const path = catalogCachePath({ platform: "linux", env: { XDG_CACHE_HOME: "/var/cache/me" }, home: "/home/me" });

		assert.equal(path, "/var/cache/me/pi-streambeats/catalog.json");
	});

	it("ignores a relative XDG_CACHE_HOME, as the XDG spec does, and falls back to ~/.cache", () => {
		const path = catalogCachePath({ platform: "linux", env: { XDG_CACHE_HOME: "relative/cache" }, home: "/home/me" });

		assert.equal(path, "/home/me/.cache/pi-streambeats/catalog.json");
	});

	it("uses the platform cache directory on macOS and Windows", () => {
		assert.equal(
			catalogCachePath({ platform: "darwin", env: {}, home: "/Users/me" }),
			"/Users/me/Library/Caches/pi-streambeats/catalog.json",
		);
		assert.equal(
			catalogCachePath({
				platform: "win32",
				env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
				home: "C:\\Users\\me",
			}),
			"C:\\Users\\me\\AppData\\Local\\pi-streambeats\\catalog.json",
		);
		assert.equal(
			catalogCachePath({ platform: "win32", env: {}, home: "C:\\Users\\me" }),
			"C:\\Users\\me\\AppData\\Local\\pi-streambeats\\catalog.json",
		);
	});
});

describe("writeCatalogCache and readCatalogCache (S20)", () => {
	it("round-trips the metadata and leaves a private file in a private directory", () => {
		const dir = scratch();
		try {
			const path = join(dir, "pi-streambeats", "catalog.json");
			const cache = sampleCache(1_700_000_000_000);

			assert.equal(writeCatalogCache(path, cache), true);
			assert.deepEqual(readCatalogCache(path), cache);
			assert.equal(statSync(path).mode & 0o777, 0o600, "the cache must not be world readable");
			assert.equal(statSync(join(dir, "pi-streambeats")).mode & 0o777, 0o750);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists no audio URL at all, because a signed URL is a token and tokens never touch the disk", () => {
		// Built from the real page on purpose: the URL is there in the payload the parser read, and it
		// must not survive the trip to the cache.
		const albumPage = readFileSync(new URL("../fixtures/catalog/album-tralbum.html", import.meta.url), "utf8");
		const tracks = parseAlbumPage(albumPage) ?? [];
		const cache: CatalogCache = { version: 1, fetchedAt: 5, albums: [{ slug: "a", title: "A", tracks }] };
		const dir = scratch();
		try {
			const path = join(dir, "catalog.json");
			assert.equal(writeCatalogCache(path, cache), true);

			const written = readFileSync(path, "utf8");
			assert.equal(/bcbits\.com/.test(written), false, "no Bandcamp audio host may be persisted");
			assert.equal(/"uri"/.test(written), false);
			assert.deepEqual(readCatalogCache(path), cache);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("answers undefined for a cache that is missing, malformed or from another version", () => {
		const dir = scratch();
		try {
			assert.equal(readCatalogCache(join(dir, "nope.json")), undefined);

			const malformed = join(dir, "malformed.json");
			writeFileSync(malformed, "{ not json");
			assert.equal(readCatalogCache(malformed), undefined);

			const foreign = join(dir, "foreign.json");
			writeFileSync(foreign, JSON.stringify({ version: 2, fetchedAt: 1, albums: [] }));
			assert.equal(readCatalogCache(foreign), undefined);

			const halfAlbums = join(dir, "half.json");
			writeFileSync(halfAlbums, JSON.stringify({ version: 1, fetchedAt: 1, albums: [{ title: "no slug" }] }));
			assert.equal(readCatalogCache(halfAlbums), undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a cache it cannot write as false, instead of throwing at the card", () => {
		// The parent is a file, so the directory cannot be created: a cache that is not there, and a card that
		// still opens. (`/proc` and friends would spin: a virtual filesystem is not a fast failure.)
		const dir = scratch();
		try {
			const blocker = join(dir, "not-a-directory");
			writeFileSync(blocker, "");

			assert.equal(writeCatalogCache(join(blocker, "catalog.json"), sampleCache(1)), false);
			assert.equal(readCatalogCache(join(blocker, "catalog.json")), undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("isCatalogFresh (S20, L75)", () => {
	const fetched = 1_000_000_000_000;

	it("is fresh until the TTL runs out, and 24 hours is the TTL", () => {
		assert.equal(CATALOG_TTL_MS, 24 * 60 * 60 * 1000);
		assert.equal(isCatalogFresh(sampleCache(fetched), fetched + CATALOG_TTL_MS - 1), true);
		assert.equal(isCatalogFresh(sampleCache(fetched), fetched + CATALOG_TTL_MS), false);
	});

	it("treats a cache stamped in the future as stale, because a clock that went back is not evidence", () => {
		assert.equal(isCatalogFresh(sampleCache(fetched + 60_000), fetched), false);
	});
});

describe("the index and the cache agree on the album shape (S20)", () => {
	it("an album read from the index can carry the tracks read from its page", () => {
		const index = readFileSync(new URL("../fixtures/catalog/music-grid.html", import.meta.url), "utf8");
		const [album] = parseAlbumIndex(index);
		assert.ok(album, "the fixture index must announce at least one album");
		const page = readFileSync(new URL("../fixtures/catalog/album-tralbum.html", import.meta.url), "utf8");
		const tracks = parseAlbumPage(page) ?? [];

		const cache: CatalogCache = { version: 1, fetchedAt: 1, albums: [{ ...album, tracks }] };

		assert.equal(cache.albums[0]?.slug, "better-when-im-high-remix");
		assert.equal(cache.albums[0]?.tracks.length, 2);
	});
});
