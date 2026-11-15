/**
 * Name rules (S5). Names come from disk and are untrusted, so two things are pinned here before
 * anything reaches a renderer: which nine extensions count as audio, and the neutralization of
 * control characters (AGENTS.md security rule: a file name can carry ANSI/OSC escapes).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUDIO_EXTENSIONS, isAudioFile, neutralizeName } from "../../lib/library/names.ts";

describe("audio extensions (S5)", () => {
	it("accepts exactly the nine extensions of the Go repo", () => {
		assert.deepEqual([...AUDIO_EXTENSIONS], [".mp3", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".wav", ".wma"]);
		for (const extension of AUDIO_EXTENSIONS) {
			assert.equal(isAudioFile(`01 - track${extension}`), true, extension);
		}
	});

	it("ignores everything else", () => {
		const ignored = ["cover.jpg", "notes.txt", "01 - track.mp3.txt", "playlist", "03 - song.flac.bak", ""];
		for (const name of ignored) {
			assert.equal(isAudioFile(name), false, name);
		}
	});

	it("matches the extension case-insensitively", () => {
		assert.equal(isAudioFile("01 - TRACK.MP3"), true);
		assert.equal(isAudioFile("01 - track.Flac"), true);
	});

	it("does not mistake a dotfile for an audio extension", () => {
		assert.equal(isAudioFile(".mp3"), false);
		assert.equal(isAudioFile("."), false);
		assert.equal(isAudioFile(".."), false);
	});
});

describe("untrusted names (S5)", () => {
	it("keeps ordinary names verbatim", () => {
		assert.equal(neutralizeName("03 - Canción.flac"), "03 - Canción.flac");
		assert.equal(neutralizeName("Lo-fi Beats (2019)"), "Lo-fi Beats (2019)");
	});

	it("strips CSI escape sequences that would repaint the row", () => {
		assert.equal(neutralizeName("\u001b[31mred\u001b[0m.mp3"), "[31mred[0m.mp3");
	});

	it("strips an OSC 52 sequence that could write the clipboard", () => {
		assert.equal(neutralizeName("\u001b]52;c;ZWNobw==\u0007evil.mp3"), "]52;c;ZWNobw==evil.mp3");
	});

	it("strips a carriage return that would overwrite the line", () => {
		assert.equal(neutralizeName("a\rb.mp3"), "ab.mp3");
	});

	it("strips bidi overrides and zero-width format characters", () => {
		assert.equal(neutralizeName("a\u202eb\u200bc\ufeff.mp3"), "abc.mp3");
	});
});
