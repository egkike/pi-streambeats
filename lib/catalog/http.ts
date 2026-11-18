/**
 * The catalog's HTTP port (S20). `fetch` is injected, never imported: no socket is opened by this
 * module, tests drive it with a fake, and the composition root is the only place that knows the
 * network exists. That is the project's contract standing over the reference implementation's, which
 * owns an HTTP client inside the module.
 *
 * Three rules, all from S20:
 *
 * 1. **One retry, 150 ms later**, for a transport failure — that is the blip it covers, and a second
 *    one would only make a broken network slower.
 * 2. **A 404 is an answer, not a blip**: one request, `not-found`, and the caller skips that album.
 * 3. **A timeout really aborts** the request instead of waiting for a promise nobody will resolve.
 *
 * Everything comes back as `CatalogResult`: the card renders a sentence, and no exception reaches it.
 */

import type { CatalogAlbum, CatalogResult, CatalogTrack } from "../types.ts";
import { isAlbumSlug, parseAlbumIndex, parseAlbumPage, parseTrackUrl } from "./parse.ts";

/** The catalog's origin. One constant, so a fixture-driven test and the real read agree on the URL. */
export const CATALOG_ORIGIN = "https://streambeats.bandcamp.com";

/**
 * The narrowest network a catalog needs: a URL in, a status and a body out. `AbortSignal` is part of
 * the signature because the timeout rule is the module's, not the caller's.
 */
export type CatalogFetch = (
	url: string,
	init: { readonly signal: AbortSignal },
) => Promise<{ readonly status: number; readonly text: string }>;

export interface CatalogHttpOptions {
	readonly fetch: CatalogFetch;
	/** Budget for one request. S20 asks for 30 s, which is a page nobody is waiting for either way. */
	readonly timeoutMs?: number;
	readonly retryDelayMs?: number;
	/** Injected so a test does not have to wait 150 ms to prove the retry happens after the wait. */
	readonly sleep?: (ms: number) => Promise<void>;
}

export interface CatalogHttp {
	readIndex(): Promise<CatalogResult<readonly CatalogAlbum[]>>;
	readAlbum(slug: string): Promise<CatalogResult<readonly CatalogTrack[]>>;
	/** Resolved immediately before a play and never stored (S20): a cached URL is an expired URL. */
	readTrackUrl(albumSlug: string, trackSlug: string): Promise<CatalogResult<string>>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 150;
const ATTEMPTS = 2;

/** A status that is the server having a bad minute, not the page having changed. */
const TRANSIENT_STATUS = /^(408|425|429|5\d\d)$/;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

type Page =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly failure: "network" | "not-found" | "scrape" };

export function createCatalogHttp(options: CatalogHttpOptions): CatalogHttp {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const sleep = options.sleep ?? defaultSleep;

	/**
	 * One request and its one retry. Three different things answer "the page did not arrive", and only one of
	 * them deserves the retry:
	 *
	 * - **Our own timeout is final.** The timeout *is* the ceiling on how long the card waits; retrying it
	 *   doubles the ceiling and hands the reader twice the wait for the same nothing.
	 * - **A transient status is the blip the retry exists for** (429, 5xx). Calling it `scrape` would send the
	 *   reader to "the site changed its markup", which is the wrong cause and skips the retry.
	 * - **A transport failure** is retried once, because that is the blip in its purest form.
	 */
	async function readPage(url: string): Promise<Page> {
		for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
			if (attempt > 0) await sleep(retryDelayMs);
			const signal = AbortSignal.timeout(timeoutMs);
			try {
				const response = await options.fetch(url, { signal });
				if (response.status === 404) return { ok: false, failure: "not-found" };
				if (TRANSIENT_STATUS.test(String(response.status))) continue;
				if (response.status !== 200) return { ok: false, failure: "scrape" };
				return { ok: true, text: response.text };
			} catch {
				// Our own abort is a decision, not a blip: do not spend the retry on it.
				if (signal.aborted) return { ok: false, failure: "network" };
			}
		}
		return { ok: false, failure: "network" };
	}

	function albumPage(slug: string): Promise<Page> {
		if (!isAlbumSlug(slug)) return Promise.resolve({ ok: false, failure: "not-found" });
		return readPage(`${CATALOG_ORIGIN}/album/${slug}`);
	}

	return {
		async readIndex(): Promise<CatalogResult<readonly CatalogAlbum[]>> {
			const page = await readPage(`${CATALOG_ORIGIN}/music`);
			if (!page.ok) return { ok: false, failure: page.failure };

			const albums = parseAlbumIndex(page.text);
			// The explicit failure S20 asks for: an empty grid is markup we no longer read, never a catalog
			// with nothing in it. A list that silently renders zero rows is the failure this replaces.
			if (albums.length === 0) return { ok: false, failure: "scrape" };
			return { ok: true, value: albums };
		},

		async readAlbum(slug: string): Promise<CatalogResult<readonly CatalogTrack[]>> {
			const page = await albumPage(slug);
			if (!page.ok) return { ok: false, failure: page.failure };

			const tracks = parseAlbumPage(page.text);
			if (!tracks) return { ok: false, failure: "scrape" };
			// An album page whose every track is unplayable did not have "no tracks": it had tracks we could not
			// read. An empty array is truthy, so without this rule the failure is never raised and a hole gets
			// cached for 24 h.
			if (tracks.length === 0) return { ok: false, failure: "scrape" };
			return { ok: true, value: tracks };
		},

		async readTrackUrl(albumSlug: string, trackSlug: string): Promise<CatalogResult<string>> {
			const page = await albumPage(albumSlug);
			if (!page.ok) return { ok: false, failure: page.failure };

			const url = parseTrackUrl(page.text, trackSlug);
			if (!url) return { ok: false, failure: "not-found" };
			return { ok: true, value: url };
		},
	};
}
