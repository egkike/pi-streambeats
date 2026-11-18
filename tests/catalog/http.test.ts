/**
 * The catalog's HTTP port (S20). The network is injected, never imported: these tests run the real
 * timeout and retry rules against a fake `fetch`, with no socket in sight.
 *
 * The rules being pinned are the ones that keep a broken network from becoming a broken card: one
 * retry for a blip, no retry for a 404, a timeout that really aborts, and an explicit `scrape`
 * failure instead of an empty album list.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { type CatalogFetch, createCatalogHttp } from "../../lib/catalog/http.ts";

const MUSIC = readFileSync(new URL("../fixtures/catalog/music-grid.html", import.meta.url), "utf8");
const ALBUM = readFileSync(new URL("../fixtures/catalog/album-tralbum.html", import.meta.url), "utf8");
const NOT_FOUND = readFileSync(new URL("../fixtures/catalog/album-404.html", import.meta.url), "utf8");

interface Call {
	readonly url: string;
	readonly signal: AbortSignal;
}

/** A fetch that answers from a table and records what it was asked, so the retry rules are observable. */
function fakeFetch(answers: readonly (() => Promise<{ status: number; text: string }>)[]): {
	fetch: CatalogFetch;
	calls: Call[];
} {
	const calls: Call[] = [];
	let next = 0;
	return {
		calls,
		fetch: (url, init) => {
			calls.push({ url, signal: init.signal });
			const answer = answers[Math.min(next, answers.length - 1)];
			next += 1;
			if (!answer) throw new Error("the test table ran out of answers");
			return answer();
		},
	};
}

const ok = (text: string) => () => Promise.resolve({ status: 200, text });

describe("createCatalogHttp (S20)", () => {
	it("reads the album index from the real page bytes", async () => {
		const http = createCatalogHttp({ fetch: fakeFetch([ok(MUSIC)]).fetch });

		const result = await http.readIndex();

		assert.equal(result.ok, true);
		assert.deepEqual(result.ok ? result.value.map((album) => album.slug) : [], [
			"better-when-im-high-remix",
			"electric",
			"groovy",
		]);
	});

	it("says the scrape failed when the page arrived but carried no albums", async () => {
		// The documented mitigation for regex coupling (S20): `no albums found`, never an empty list that
		// looks like a catalog nobody filled.
		const http = createCatalogHttp({ fetch: fakeFetch([ok(NOT_FOUND)]).fetch });

		assert.deepEqual(await http.readIndex(), { failure: "scrape", ok: false });
	});

	it("reads one album page into tracks", async () => {
		const http = createCatalogHttp({ fetch: fakeFetch([ok(ALBUM)]).fetch });

		const result = await http.readAlbum("better-when-im-high-remix");

		assert.equal(result.ok, true);
		assert.deepEqual(result.ok ? result.value.map((track) => track.slug) : [], [
			"better-when-im-high-remix",
			"better-when-im-high-remix-instrumental",
		]);
	});

	it("reports a missing album as not-found, after exactly one request", async () => {
		// A 404 is an answer, not a blip: retrying it would double the requests of a catalog that lost an album.
		const fake = fakeFetch([() => Promise.resolve({ status: 404, text: NOT_FOUND })]);
		const http = createCatalogHttp({ fetch: fake.fetch });

		assert.deepEqual(await http.readAlbum("gone"), { failure: "not-found", ok: false });
		assert.equal(fake.calls.length, 1);
	});

	it("retries a transport failure once, 150 ms later, because that is the blip it covers", async () => {
		const slept: number[] = [];
		const fake = fakeFetch([
			() => Promise.reject(new Error("ECONNRESET")),
			() => Promise.resolve({ status: 200, text: MUSIC }),
		]);
		const http = createCatalogHttp({
			fetch: fake.fetch,
			sleep: (ms) => {
				slept.push(ms);
				return Promise.resolve();
			},
		});

		const result = await http.readIndex();

		assert.equal(result.ok, true);
		assert.deepEqual(slept, [150]);
		assert.equal(fake.calls.length, 2);
	});

	it("gives up after the one retry, with network as the reason", async () => {
		const fake = fakeFetch([() => Promise.reject(new Error("ECONNRESET"))]);
		const http = createCatalogHttp({ fetch: fake.fetch, sleep: () => Promise.resolve() });

		assert.deepEqual(await http.readIndex(), { failure: "network", ok: false });
		assert.equal(fake.calls.length, 2);
	});

	it("aborts a request that outlives its timeout, and calls it a network failure", async () => {
		// The fake never answers on its own: only the abort ends it, so a timeout that did not really abort
		// would hang this test instead of passing it.
		const fake: CatalogFetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const http = createCatalogHttp({ fetch: fake, retryDelayMs: 0, timeoutMs: 5, sleep: () => Promise.resolve() });

		assert.deepEqual(await http.readIndex(), { failure: "network", ok: false });
	});

	it("resolves the signed URL of one track by slug, on demand", async () => {
		const http = createCatalogHttp({ fetch: fakeFetch([ok(ALBUM)]).fetch });

		const result = await http.readTrackUrl("better-when-im-high-remix", "better-when-im-high-remix-instrumental");

		assert.equal(result.ok, true);
		assert.match(result.ok ? result.value : "", /^https:\/\/t4\.bcbits\.com\/stream\//);
	});

	it("reports a track that is no longer on its album page as not-found", async () => {
		const http = createCatalogHttp({ fetch: fakeFetch([ok(ALBUM)]).fetch });

		assert.deepEqual(await http.readTrackUrl("better-when-im-high-remix", "gone"), { failure: "not-found", ok: false });
	});
});
