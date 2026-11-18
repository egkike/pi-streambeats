/**
 * The status line's now-playing formatter (S12). Every assertion is an exact string: the segment
 * has a column budget, so a line that fits by luck is not a line that fits. The glyph is asserted
 * on its own, because the glyph — never the colour — is what tells playing from paused.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanTitle, folderLabel, statusSegment } from "../../lib/core/now-playing.ts";
import type { Track } from "../../lib/types.ts";

const ALBUM = "/library/StreamBeats/Chillhop";
const ELAPSED = 62_000;
const TOTAL = 198_000;
const TIME = "1:02/3:18";

function track(name: string, durationMs?: number, id = `${ALBUM}/${name}`): Track {
	return { id, title: name, origin: "local", durationMs };
}

const NEON = track("01 - Neon Nights.mp3", TOTAL);
const LONG_TRACK = track(`01 - ${"A".repeat(80)}.mp3`, TOTAL);

describe("cleanTitle (S12)", () => {
	it("strips a track number prefix and the audio extension", () => {
		assert.equal(cleanTitle("01 - Neon Nights.mp3"), "Neon Nights");
	});

	it("keeps a name that has no track number prefix, extension included", () => {
		assert.equal(cleanTitle("Neon Nights.mp3"), "Neon Nights.mp3");
	});

	it("leaves a date that only looks like a track number alone", () => {
		assert.equal(cleanTitle("2024-11-10 - live set.mp3"), "2024-11-10 - live set.mp3");
	});

	it("keeps a name with dots but no known extension", () => {
		assert.equal(cleanTitle("Neon.Nights.m4b"), "Neon.Nights.m4b");
		assert.equal(cleanTitle("01 - Neon.Nights.m4b"), "01 - Neon.Nights.m4b");
		assert.equal(cleanTitle("01 - Neon Nights.flac.txt"), "01 - Neon Nights.flac.txt");
	});

	it("strips an upper-case extension", () => {
		assert.equal(cleanTitle("01 - Neon Nights.MP3"), "Neon Nights");
		assert.equal(cleanTitle("01 - Neon Nights.FlAc"), "Neon Nights");
	});

	it("strips each of the nine audio extensions", () => {
		const extensions = [".mp3", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".wav", ".wma"];
		for (const extension of extensions) {
			assert.equal(cleanTitle(`03 - Arcade Dreams${extension}`), "Arcade Dreams", extension);
		}
	});

	it("keeps the name when the number is not followed by the exact separator", () => {
		assert.equal(cleanTitle("01.Neon Nights.mp3"), "01.Neon Nights.mp3");
		assert.equal(cleanTitle("01-Neon Nights.mp3"), "01-Neon Nights.mp3");
		assert.equal(cleanTitle("01  -  Neon Nights.mp3"), "01  -  Neon Nights.mp3");
	});

	it("keeps the name when the prefix leaves no title", () => {
		assert.equal(cleanTitle("01 - .mp3"), "01 - .mp3");
	});
});

describe("folderLabel (S12)", () => {
	it("names the containing directory", () => {
		assert.equal(folderLabel(`${ALBUM}/01 - Neon Nights.mp3`), "Chillhop");
	});

	it("reads a Windows path in its own flavour", () => {
		assert.equal(folderLabel("C:\\Music\\StreamBeats\\Chillhop\\01 - Neon Nights.mp3"), "Chillhop");
	});

	it("falls back to the root when the containing directory has no name", () => {
		assert.equal(folderLabel("/01 - Neon Nights.mp3"), "/");
	});
});

describe("statusSegment (S12)", () => {
	it("playing: filled glyph, clean title, folder and time", () => {
		const line = statusSegment({ playing: NEON, paused: false }, 90, { elapsedMs: ELAPSED });
		assert.equal(line, `● Neon Nights · Chillhop ${TIME}`);
	});

	it("paused: hollow glyph and the frozen time", () => {
		const line = statusSegment({ playing: NEON, paused: true }, 90, { elapsedMs: ELAPSED });
		assert.equal(line, `○ Neon Nights · Chillhop ${TIME}`);
	});

	it("has no segment when nothing is playing, which is also the end of the queue", () => {
		assert.equal(statusSegment({ paused: false }, 90, { elapsedMs: ELAPSED }), undefined);
		assert.equal(statusSegment({ playing: undefined, paused: false }, 90), undefined);
	});

	it("cleans the raw file name the track carries", () => {
		const line = statusSegment({ playing: track("03 - Arcade Dreams.flac", TOTAL), paused: false }, 90, {
			elapsedMs: ELAPSED,
		});
		assert.equal(line, `● Arcade Dreams · Chillhop ${TIME}`);
	});

	it("shows an unmatched name exactly as it is, extension included", () => {
		const name = "2024-11-10 - live set.mp3";
		const line = statusSegment({ playing: track(name, TOTAL), paused: false }, 90, { elapsedMs: ELAPSED });
		assert.equal(line, `● ${name} · Chillhop ${TIME}`);
	});

	it("uses the ASCII family when the user asks for it", () => {
		const playing = statusSegment({ playing: NEON, paused: false }, 90, { elapsedMs: ELAPSED, asciiGlyphs: true });
		const paused = statusSegment({ playing: NEON, paused: true }, 90, { elapsedMs: ELAPSED, asciiGlyphs: true });
		assert.equal(playing, `* Neon Nights · Chillhop ${TIME}`);
		assert.equal(paused, `- Neon Nights · Chillhop ${TIME}`);
	});

	it("prefers the duration the player reports over the track metadata", () => {
		const line = statusSegment({ playing: NEON, paused: false }, 90, { elapsedMs: ELAPSED, totalMs: 222_000 });
		assert.equal(line, "● Neon Nights · Chillhop 1:02/3:42");
	});

	it("prints --:-- when the total duration is unknown", () => {
		const line = statusSegment({ playing: track("01 - Neon Nights.mp3"), paused: false }, 90, { elapsedMs: ELAPSED });
		assert.equal(line, "● Neon Nights · Chillhop 1:02/--:--");
	});

	it("formats m:ss without hours and without padding the minutes", () => {
		const long = track("01 - Neon Nights.mp3", 3_723_000);
		assert.equal(
			statusSegment({ playing: long, paused: false }, 90, { elapsedMs: 0 }),
			"● Neon Nights · Chillhop 0:00/62:03",
		);
	});

	it("floors the elapsed time and clamps a negative report to zero", () => {
		const floored = statusSegment({ playing: NEON, paused: false }, 90, { elapsedMs: 61_999 });
		const negative = statusSegment({ playing: NEON, paused: false }, 90, { elapsedMs: -5_000 });
		assert.equal(floored, `● Neon Nights · Chillhop 1:01/3:18`);
		assert.equal(negative, `● Neon Nights · Chillhop 0:00/3:18`);
	});

	it("truncates the title at 90 columns and keeps the time", () => {
		const line = statusSegment({ playing: LONG_TRACK, paused: false }, 90, { elapsedMs: ELAPSED });
		assert.equal(line, `● ${"A".repeat(66)}… · Chillhop ${TIME}`);
		assert.equal([...(line ?? "")].length, 90);
	});

	it("truncates the title at 78 columns and keeps the time", () => {
		const line = statusSegment({ playing: LONG_TRACK, paused: false }, 78, { elapsedMs: ELAPSED });
		assert.equal(line, `● ${"A".repeat(54)}… · Chillhop ${TIME}`);
		assert.equal([...(line ?? "")].length, 78);
	});

	it("never wraps: the segment fits every width it is given", () => {
		for (let width = 0; width <= 140; width++) {
			const line = statusSegment({ playing: LONG_TRACK, paused: false }, width, { elapsedMs: ELAPSED });
			assert.equal(typeof line, "string", `width ${width} produced no segment`);
			if (line === undefined) continue;
			assert.ok(!line.includes("\n"), `width ${width} wrapped`);
			assert.ok([...line].length <= width, `width ${width} overflowed: ${line}`);
		}
	});

	it("gives the folder up whole after the title, before the time", () => {
		const withFolder = statusSegment({ playing: LONG_TRACK, paused: false }, 24, { elapsedMs: ELAPSED });
		const withoutFolder = statusSegment({ playing: LONG_TRACK, paused: false }, 23, { elapsedMs: ELAPSED });
		assert.equal(withFolder, `● … · Chillhop ${TIME}`);
		assert.equal(withoutFolder, `● … ${TIME}`);
	});

	it("leaves only the ellipsis and the time when the title cannot shrink", () => {
		const line = statusSegment({ playing: LONG_TRACK, paused: false }, 20, { elapsedMs: ELAPSED });
		assert.equal(line, `● … ${TIME}`);
	});

	it("is the last to give way: the time shrinks only after everything else is gone", () => {
		assert.equal(statusSegment({ playing: LONG_TRACK, paused: false }, 12, { elapsedMs: ELAPSED }), `● ${TIME}`);
		assert.equal(statusSegment({ playing: LONG_TRACK, paused: false }, 1, { elapsedMs: ELAPSED }), "●");
		assert.equal(statusSegment({ playing: LONG_TRACK, paused: false }, 0, { elapsedMs: ELAPSED }), "");
	});
	it("labels a catalog track with its album, because `catalog:<slug>` is not a name (S20)", () => {
		// A local track is labelled by the directory that holds it; a catalog one has no directory, so the
		// album comes with the row. Without it the segment would print `catalog:better-when-im-high-remix`.
		const catalogTrack = {
			id: "catalog:better-when-im-high-remix/better-when-im-high-remix",
			title: "Better When I'm High (Remix)",
			origin: "catalog" as const,
			album: "Better When I'm High (Remix)",
		};

		const line = statusSegment({ playing: catalogTrack, paused: false }, 90, { elapsedMs: 1000, totalMs: 191520 });

		assert.equal(line, `● Better When I'm High (Remix) · Better When I'm High (Remix) 0:01/3:11`);
	});
});
