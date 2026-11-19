/**
 * Library scanning (S5, S14). Every test runs against a temporary directory created with mkdtemp:
 * never the user's music folder, never a fixed path. No mpv, no network, no settings file.
 */
import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AUDIO_EXTENSIONS } from "../../lib/core/names.ts";
import { scanFolder } from "../../lib/library/scan.ts";

/** Symlinks need extra privileges on Windows; the rules they cover are the same on every POSIX host. */
const symlinks = process.platform === "win32" ? "symlink creation needs extra privileges on Windows" : false;

/**
 * Windows forbids control characters (`0x00`-`0x1F`) in a file name, so the fixture cannot exist there. The rule
 * those two tests cover — a name is neutralized on its way to the frame and kept raw on its way to the disk — is
 * stated purely in `tests/core/names.test.ts`, where it runs on every host (L101).
 */
const controlNames = process.platform === "win32" ? "Windows forbids control characters in file names" : false;

/**
 * `chmod` is a POSIX call: on Windows it quietly does nothing, so a directory cannot be made unreadable to its own
 * owner and the failure state this test fabricates cannot be built (L101).
 */
const chmod = process.platform === "win32" ? "chmod cannot make a directory unreadable on Windows" : false;

/**
 * Why the unreadable-directory test cannot run here, or `false` when it can. Both reasons are returned as the same
 * shape on purpose: a bare `true` would skip with no reason (root can read a `000` directory), and mixing a boolean
 * with a reason string is the subtlety this helper exists to remove (L103).
 */
function unreadableReason(): false | string {
	if (process.getuid?.() === 0) return "root can read a directory whose mode is 000";
	return chmod;
}

let root: string;
let music: string;

beforeEach(() => {
	// realpath first: on macOS the temporary directory is reached through a symlink.
	root = realpathSync(mkdtempSync(join(tmpdir(), "sb-scan-")));
	music = join(root, "music");
	mkdirSync(music, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function ctx() {
	return { libraryRoot: music, settingsPath: join(root, "config", "pi-streambeats", "settings.json") };
}

function files(dir: string, ...names: string[]): void {
	for (const name of names) writeFileSync(join(dir, name), "");
}

function folders(dir: string, ...names: string[]): void {
	for (const name of names) mkdirSync(join(dir, name), { recursive: true });
}

function listing(result: Awaited<ReturnType<typeof scanFolder>>) {
	if (!result.ok) assert.fail(`expected a listing, got ${JSON.stringify(result.failure)}`);
	return result;
}

function rejection(result: Awaited<ReturnType<typeof scanFolder>>) {
	if (result.ok) assert.fail("expected a failure, got a listing");
	return result;
}

/** Entry names in the exact order the card will render them. */
function entryNames(result: Awaited<ReturnType<typeof scanFolder>>): string[] {
	return listing(result).entries.map((entry) => (entry.kind === "folder" ? entry.folder.name : entry.track.title));
}

describe("listing the current folder (S5)", () => {
	it("lists folders first, then audio files, each group alphabetical", async () => {
		folders(music, "Synthwave", "ambient", "Chillhop");
		files(music, "10 - J.mp3", "02 - B.flac", "01 - A.ogg");

		const result = listing(await scanFolder(music, ctx()));

		assert.deepEqual(entryNames(result), [
			"ambient",
			"Chillhop",
			"Synthwave",
			"01 - A.ogg",
			"02 - B.flac",
			"10 - J.mp3",
		]);
		assert.deepEqual(
			result.entries.map((entry) => entry.kind),
			["folder", "folder", "folder", "track", "track", "track"],
		);
	});

	it("ignores files that are not one of the nine extensions", async () => {
		files(music, "cover.jpg", "notes.txt", "01 - track.mp3.txt", "playlist", "03 - song.flac.bak");

		assert.deepEqual(entryNames(await scanFolder(music, ctx())), []);
	});

	it("accepts each of the nine audio extensions", async () => {
		for (const extension of AUDIO_EXTENSIONS) files(music, `track${extension}`);

		const result = listing(await scanFolder(music, ctx()));

		assert.equal(result.entries.length, 9);
		assert.equal(result.noAudio, undefined);
	});

	it("skips hidden entries, including the macOS dot-underscore files", async () => {
		folders(music, ".cache");
		files(music, ".DS_Store", "._01 - A.mp3", ".hidden.mp3", "visible.mp3");

		assert.deepEqual(entryNames(await scanFolder(music, ctx())), ["visible.mp3"]);
	});

	it("lists direct children only, never the subtree", async () => {
		folders(music, "Album");
		files(join(music, "Album"), "nested.mp3");
		files(music, "top.mp3");

		assert.deepEqual(entryNames(await scanFolder(music, ctx())), ["Album", "top.mp3"]);
	});

	it("maps a file to a track whose identity is the absolute path", async () => {
		files(music, "03 - Song.mp3");

		const [entry] = listing(await scanFolder(music, ctx())).entries;

		assert.deepEqual(entry, {
			kind: "track",
			track: { id: join(music, "03 - Song.mp3"), title: "03 - Song.mp3", origin: "local" },
		});
	});

	it("gives folders and tracks absolute paths under the current folder", async () => {
		folders(music, "Album");
		files(music, "a.mp3");

		const result = listing(await scanFolder(music, ctx()));
		const folder = result.entries.find((entry) => entry.kind === "folder");
		const track = result.entries.find((entry) => entry.kind === "track");

		assert.equal(result.path, music);
		assert.equal(folder?.kind === "folder" ? folder.folder.path : undefined, join(music, "Album"));
		assert.equal(track?.kind === "track" ? track.track.id : undefined, join(music, "a.mp3"));
	});

	it("never writes, renames or deletes inside the library", async () => {
		folders(music, "Chillhop");
		files(music, "01 - A.mp3", "cover.jpg");
		const before = readdirSync(root, { recursive: true, encoding: "utf8" }).sort();

		await scanFolder(music, ctx());

		assert.deepEqual(readdirSync(root, { recursive: true, encoding: "utf8" }).sort(), before);
	});
});

describe("a folder with no audio (S5)", () => {
	it("reports what is missing plus the current path, the root and the settings file", async () => {
		const result = listing(await scanFolder(music, ctx()));

		assert.deepEqual(result.entries, []);
		assert.deepEqual(result.noAudio, {
			path: music,
			libraryRoot: music,
			settingsPath: join(root, "config", "pi-streambeats", "settings.json"),
			extensions: [...AUDIO_EXTENSIONS],
		});
	});

	it("still reports no audio when the folder only contains subfolders", async () => {
		folders(music, "Chillhop");

		const result = listing(await scanFolder(music, ctx()));

		assert.deepEqual(entryNames(result), ["Chillhop"]);
		assert.equal(result.noAudio?.path, music);
	});

	it("does not report no audio when the folder has a track", async () => {
		files(music, "01 - A.mp3");

		assert.equal(listing(await scanFolder(music, ctx())).noAudio, undefined);
	});
});

describe("failure states (S5)", () => {
	it("returns a nonexistent path as data instead of throwing", async () => {
		const missing = join(music, "gone");

		assert.deepEqual(rejection(await scanFolder(missing, ctx())), {
			ok: false,
			path: missing,
			failure: { kind: "missing", path: missing },
		});
	});

	it("treats a file path as a missing folder instead of listing it", async () => {
		files(music, "01 - A.mp3");
		const file = join(music, "01 - A.mp3");

		assert.deepEqual(rejection(await scanFolder(file, ctx())).failure, { kind: "missing", path: file });
	});

	it("returns an unreadable path as data instead of throwing", { skip: unreadableReason() }, async () => {
		const locked = join(root, "locked");
		mkdirSync(locked);
		files(locked, "01 - A.mp3");

		let result: Awaited<ReturnType<typeof scanFolder>>;
		chmodSync(locked, 0o000);
		try {
			result = await scanFolder(locked, ctx());
		} finally {
			chmodSync(locked, 0o700);
		}

		assert.equal(rejection(result).failure.kind, "unreadable");
	});
});

describe("symlinks (S5, S14)", { skip: symlinks }, () => {
	it("canonicalizes the current folder so navigation cannot loop", async () => {
		const real = join(root, "real");
		mkdirSync(real);
		files(real, "01 - A.mp3");
		const link = join(root, "link");
		symlinkSync(real, link, "dir");

		const result = listing(await scanFolder(link, ctx()));

		assert.equal(result.path, real);
		assert.deepEqual(entryNames(result), ["01 - A.mp3"]);
	});

	it("canonicalizes a folder entry and keeps the name the user sees", async () => {
		const real = join(root, "real");
		mkdirSync(real);
		const link = join(music, "Alias");
		symlinkSync(real, link, "dir");

		const [entry] = listing(await scanFolder(music, ctx())).entries;

		assert.equal(entry?.kind === "folder" ? entry.folder.path : undefined, real);
		assert.equal(entry?.kind === "folder" ? entry.folder.name : undefined, "Alias");
	});

	it("skips a symlink that points nowhere", async () => {
		symlinkSync(join(root, "gone"), join(music, "Broken"), "dir");

		assert.deepEqual(entryNames(await scanFolder(music, ctx())), []);
	});
});

describe("untrusted names (S5)", { skip: controlNames }, () => {
	it("neutralizes control characters in names that leave the module", async () => {
		folders(music, "\u001b]52;c;QQ==\u0007folder");
		files(music, "\u001b[31mred\u001b[0m.mp3");

		const names = entryNames(await scanFolder(music, ctx()));

		assert.deepEqual(names, ["]52;c;QQ==folder", "[31mred[0m.mp3"]);
		for (const name of names) assert.equal(name.includes("\u001b"), false, name);
	});

	it("keeps the path raw so it still names the file on disk", async () => {
		const evil = "\u001b[31mred\u001b[0m.mp3";
		files(music, evil);

		const [entry] = listing(await scanFolder(music, ctx())).entries;

		assert.equal(entry?.kind === "track" ? entry.track.id : undefined, join(music, evil));
	});
});

describe("the scan keeps the loop free (S21)", () => {
	// The scan runs inside the host's input path: `handleInput` and `show()` are synchronous by contract,
	// so a synchronous scan of a big folder or a network mount froze the editor. The contract is now a
	// promise, and a failure is still data rather than something to catch.
	it("returns a promise instead of the listing itself", async () => {
		files(music, "01 - A.mp3");

		const pending = scanFolder(music, ctx());

		assert.ok(pending instanceof Promise, "a synchronous return would block the caller that cannot wait");
		assert.deepEqual(entryNames(await pending), ["01 - A.mp3"]);
	});

	it("reports a missing folder through the promise, without throwing", async () => {
		const missing = join(root, "nope");

		const pending = scanFolder(missing, ctx());

		assert.ok(pending instanceof Promise);
		assert.deepEqual(rejection(await pending).failure, { kind: "missing", path: missing });
	});
});
