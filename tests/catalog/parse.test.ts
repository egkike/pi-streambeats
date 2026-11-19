/**
 * Catalog parsing (S20). The two regexes that read Bandcamp's HTML are coupling to markup we do not
 * own, so these tests run against real captured bytes from `tests/fixtures/catalog/`: a parser change
 * that would break against the live site breaks here first.
 *
 * Everything below is pure: text in, data out, no network and no disk.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAlbumPage, parseTrackUrl, readAlbumGrid } from "../../lib/catalog/parse.ts";

const FIXTURES = join(fileURLToPath(new URL("..", import.meta.url)), "fixtures", "catalog");

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

describe("readAlbumGrid (S20)", () => {
	it("reads the albums of the index page in page order, with the entity escapes decoded", () => {
		const albums = readAlbumGrid(fixture("music-grid.html")).albums;

		assert.deepEqual(albums, [
			{ slug: "better-when-im-high-remix", title: "Better When I'm High (Remix)" },
			{ slug: "electric", title: "Electric" },
			{ slug: "groovy", title: "Groovy" },
		]);
	});

	it("keeps one album per slug, in the order the page first showed it", () => {
		// Bandcamp repeats an album in the grid and in its own JSON-LD block; the slug is the identity.
		const html = [
			'<li data-item-id="album-1"><a href="/album/nocturnal"><p class="title">Nocturnal<br></p></li>',
			'<li data-item-id="album-2"><a href="/album/pulse"><p class="title">Pulse<br></p></li>',
			'<li data-item-id="album-3"><a href="/album/nocturnal"><p class="title">Nocturnal <br></p></li>',
		].join("\n");

		assert.deepEqual(readAlbumGrid(html).albums, [
			{ slug: "nocturnal", title: "Nocturnal" },
			{ slug: "pulse", title: "Pulse" },
		]);
	});

	it("falls back to the slug, humanized, when the grid item carries no title", () => {
		// A grid whose title markup moved is still a usable list: the entry keeps its identity and its
		// name stops being pretty, instead of the album disappearing.
		const html = '<li data-item-id="album-1"><a href="/album/better-when-im-high-remix"></li>';

		assert.deepEqual(readAlbumGrid(html).albums, [
			{ slug: "better-when-im-high-remix", title: "Better When Im High Remix" },
		]);
	});

	it("neutralizes control characters in a title, as a file name would be (S5)", () => {
		// Nothing from the network is trusted to occupy cells: an OSC 52 sequence could write the clipboard.
		const html =
			'<li data-item-id="album-1"><a href="/album/electric"><p class="title">\u001b]52;c;ZWNobw==\u0007Elep\u202ehant<br></p></li>';

		assert.deepEqual(readAlbumGrid(html).albums, [{ slug: "electric", title: "]52;c;ZWNobw==Elephant" }]);
	});

	it("finds nothing in a page without a grid, instead of inventing an album", () => {
		assert.deepEqual(readAlbumGrid(fixture("album-404.html")).albums, []);
	});

	it("names the row whose album link it could not read, instead of shrinking the catalog quietly", () => {
		// The tolerance is per item, and it is about a title: an album that loses its name keeps its row. A
		// row whose link moved is different — the album is gone — so the row is reported by the id the site
		// gave it: a count says "something is off", an id says which row to go look at.
		const html = [
			'<li data-item-id="album-1"><a href="/album/electric"><p class="title">Electric<br></p></li>',
			'<li data-item-id="album-2"><a href="/album/groovy?from=grid"><p class="title">Groovy<br></p></li>',
		].join("\n");

		assert.deepEqual(readAlbumGrid(html), {
			albums: [{ slug: "electric", title: "Electric" }],
			unreadable: ["album-2"],
		});
	});

	it("reports no unreadable row when the skip was a duplicate slug", () => {
		// The one benign skip: the same album shown twice is not markup we failed to read, so it must not
		// reach the caller as a degradation it would then have to explain.
		const html = [
			'<li data-item-id="album-1"><a href="/album/nocturnal"><p class="title">Nocturnal<br></p></li>',
			'<li data-item-id="album-2"><a href="/album/nocturnal"><p class="title">Nocturnal<br></p></li>',
		].join("\n");

		assert.deepEqual(readAlbumGrid(html).unreadable, []);
	});

	it("reads the whole captured grid without an unreadable row", () => {
		assert.deepEqual(readAlbumGrid(fixture("music-grid.html")).unreadable, []);
	});
});

describe("parseAlbumPage (S20)", () => {
	it("reads the tracks of a real album page: title, slug and duration in milliseconds", () => {
		const tracks = parseAlbumPage(fixture("album-tralbum.html"));

		assert.deepEqual(tracks, [
			{ slug: "better-when-im-high-remix", title: "Better When I'm High (Remix)", durationMs: 191520 },
			{
				slug: "better-when-im-high-remix-instrumental",
				title: "StreamBeats Originals, Ryan King, April Fooze - Better When I'm High (Remix, Instrumental)",
				durationMs: 191520,
			},
		]);
	});

	it("returns undefined when the page carries no tralbum, so a 404 is not an empty album", () => {
		assert.equal(parseAlbumPage(fixture("album-404.html")), undefined);
	});

	it("returns undefined when the tralbum is not JSON, instead of throwing", () => {
		assert.equal(parseAlbumPage('<div data-tralbum="{&quot;trackinfo&quot;:[oops}">'), undefined);
		assert.equal(parseAlbumPage('<div data-tralbum="[1,2,3]">'), undefined);
	});

	it("skips a track with no playable file, because nothing could ever resolve it", () => {
		const tralbum = {
			trackinfo: [
				{
					title: "Playable",
					track_num: 1,
					duration: 10,
					title_link: "/track/playable",
					file: { "mp3-128": "https://x/a" },
				},
				{ title: "Unplayable", track_num: 2, duration: 20, title_link: "/track/unplayable", file: null },
			],
		};
		const html = `<div data-tralbum="${escapeAttribute(JSON.stringify(tralbum))}">`;

		assert.deepEqual(parseAlbumPage(html), [{ slug: "playable", title: "Playable", durationMs: 10000 }]);
	});

	it("orders tracks by their own number, not by the order the JSON happened to list them", () => {
		const tralbum = {
			trackinfo: [
				{
					title: "Second",
					track_num: 2,
					duration: 20,
					title_link: "/track/second",
					file: { "mp3-128": "https://x/b" },
				},
				{ title: "First", track_num: 1, duration: 10, title_link: "/track/first", file: { "mp3-128": "https://x/a" } },
			],
		};
		const html = `<div data-tralbum="${escapeAttribute(JSON.stringify(tralbum))}">`;

		assert.deepEqual(
			parseAlbumPage(html)?.map((track) => track.title),
			["First", "Second"],
		);
	});

	it("leaves a track without a number after every numbered one, in the payload's order", () => {
		// Inventing a number either collides with a real one or jumps the queue — and the invented value was
		// the length of the already-filtered rows, starting at 0 while real numbers start at 1, so an unnumbered
		// track could sort *before* track 1. The payload's order is the only ordering fact such a track carries.
		const tralbum = {
			trackinfo: [
				{ title: "Intro", duration: 5, title_link: "/track/intro", file: { "mp3-128": "https://x/i" } },
				{ title: "One", track_num: 1, duration: 10, title_link: "/track/one", file: { "mp3-128": "https://x/a" } },
				{ title: "Outro", duration: 6, title_link: "/track/outro", file: { "mp3-128": "https://x/o" } },
				{ title: "Two", track_num: 2, duration: 20, title_link: "/track/two", file: { "mp3-128": "https://x/b" } },
			],
		};
		const html = `<div data-tralbum="${escapeAttribute(JSON.stringify(tralbum))}">`;

		assert.deepEqual(
			parseAlbumPage(html)?.map((track) => track.title),
			["One", "Two", "Intro", "Outro"],
		);
	});

	it("leaves the duration absent when the payload does not carry one, rather than guessing zero", () => {
		const tralbum = {
			trackinfo: [{ title: "No clock", title_link: "/track/no-clock", file: { "mp3-128": "https://x/a" } }],
		};
		const html = `<div data-tralbum="${escapeAttribute(JSON.stringify(tralbum))}">`;

		assert.deepEqual(parseAlbumPage(html), [{ slug: "no-clock", title: "No clock" }]);
	});
});

describe("parseTrackUrl (S20)", () => {
	it("resolves the signed audio URL of one track by its slug", () => {
		const url = parseTrackUrl(fixture("album-tralbum.html"), "better-when-im-high-remix-instrumental");

		assert.match(url ?? "", /^https:\/\/t4\.bcbits\.com\/stream\//);
	});

	it("answers undefined for a track that is not on the page, so a stale identity fails loudly", () => {
		assert.equal(parseTrackUrl(fixture("album-tralbum.html"), "gone"), undefined);
		assert.equal(parseTrackUrl(fixture("album-404.html"), "better-when-im-high"), undefined);
	});
});

/** The page escapes the JSON attribute the way HTML does: quotes and ampersands become entities. */
function escapeAttribute(json: string): string {
	return json.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
