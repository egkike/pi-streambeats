/**
 * Settings contract (S2, S10, S19). One test per rule the spec names: defaults when the file is
 * missing, the permission and atomicity of what we write, and the two ways a broken file must fail
 * soft instead of crashing. Every test runs against a temporary directory: never the user's config.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	DEFAULT_SETTINGS,
	editShortcuts,
	loadSettings,
	mergeSettings,
	musicDirFromUserDirs,
	type Platform,
	type Settings,
	saveSettings,
	settingsPath,
} from "../lib/settings.ts";

/**
 * The platform this suite runs its real files on, and the flavour of path that platform speaks (S19). The
 * fixture below is a real directory on the host, so it has to be described the way the host describes it: a
 * `linux` world spelled with `C:\...` strings is a world `posix.isAbsolute` rejects, and the module is right
 * to reject it. Mixing the two flavours is what made this suite pass only on the machine that wrote it (L101).
 * The three platforms' own path rules are pinned by the pure tests below, which create nothing.
 */
const hostPlatform: Platform =
	process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const hostPath = hostPlatform === "win32" ? win32 : posix;

let root: string;
let home: string;
let configHome: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sb-settings-"));
	home = hostPath.join(root, "home");
	configHome = hostPath.join(root, "config");
	mkdirSync(home, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function ctx(overrides: Record<string, unknown> = {}) {
	// The variable that decides the config directory is the host platform's own (S19): on win32 the loader
	// reads `%APPDATA%` and never looks at the XDG one, so a fixture that only set XDG would send the write
	// to the real AppData of whoever ran the suite.
	const env = hostPlatform === "win32" ? { APPDATA: configHome } : { XDG_CONFIG_HOME: configHome };
	return { platform: hostPlatform, env, home, ...overrides };
}

function filePath(): string {
	return join(configHome, "pi-streambeats", "settings.json");
}

function writeSettings(raw: string): void {
	mkdirSync(join(configHome, "pi-streambeats"), { recursive: true });
	writeFileSync(filePath(), raw);
}

describe("settings paths (S10, S19)", () => {
	it("puts the file under XDG_CONFIG_HOME on Linux and macOS", () => {
		// A pure linux world written in its own flavour: no directory is created, and the host's separators
		// never enter the assertion (S19).
		const linux = { platform: "linux" as const, env: { XDG_CONFIG_HOME: "/run/user/1000/config" }, home: "/home/kike" };

		assert.equal(settingsPath(linux), "/run/user/1000/config/pi-streambeats/settings.json");
		assert.equal(settingsPath({ ...linux, platform: "darwin" }), "/run/user/1000/config/pi-streambeats/settings.json");
	});

	it("falls back to ~/.config when XDG_CONFIG_HOME is relative or missing", () => {
		const expected = "/home/kike/.config/pi-streambeats/settings.json";
		const linux = { platform: "linux" as const, home: "/home/kike" };

		assert.equal(settingsPath({ ...linux, env: {} }), expected);
		assert.equal(settingsPath({ ...linux, env: { XDG_CONFIG_HOME: "" } }), expected);
		assert.equal(settingsPath({ ...linux, env: { XDG_CONFIG_HOME: "relative/dir" } }), expected);
	});

	it("puts the file under %APPDATA% on Windows", () => {
		const path = settingsPath(ctx({ platform: "win32", env: { APPDATA: "C:\\Users\\kike\\AppData\\Roaming" } }));
		assert.equal(path, win32.join("C:\\Users\\kike\\AppData\\Roaming", "pi-streambeats", "settings.json"));
	});
});

describe("defaults (S2, S14)", () => {
	it("writes the default file once when it is missing", () => {
		const result = loadSettings(ctx());

		assert.deepEqual(result.settings, { ...DEFAULT_SETTINGS, libraryRoot: join(home, "Music") });
		assert.equal(result.wroteDefaults, true);
		assert.equal(result.warning, undefined);
		assert.deepEqual(JSON.parse(readFileSync(filePath(), "utf8")), result.settings);
	});

	// Windows has no POSIX permission bits: it reports ACLs, so `mode` there is 0o666 for anything its owner
	// created. The mode is a promise only where the OS has one to keep, and claiming it where it does not
	// would be a green test that proves nothing (L101). That the directory and the file are created is
	// asserted by the neighbouring tests, on every platform.
	it("creates the config directory 0750 and the file 0600", {
		skip: process.platform === "win32" ? "Windows reports ACLs, not POSIX permission bits" : false,
	}, () => {
		loadSettings(ctx());

		assert.equal(statSync(join(configHome, "pi-streambeats")).mode & 0o777, 0o750);
		assert.equal(statSync(filePath()).mode & 0o777, 0o600);
	});

	it("leaves no temporary file behind after the atomic write", () => {
		loadSettings(ctx());

		assert.deepEqual(readdirSync(join(configHome, "pi-streambeats")), ["settings.json"]);
	});

	// `user-dirs.dirs` is an XDG convention. Windows has no such file and the loader never reads one there, so
	// there is nothing to assert about it on win32.
	it("reads the music directory from user-dirs.dirs", {
		skip: process.platform === "win32" ? "user-dirs.dirs is an XDG convention, absent on Windows" : false,
	}, () => {
		mkdirSync(configHome, { recursive: true });
		writeFileSync(join(configHome, "user-dirs.dirs"), 'XDG_MUSIC_DIR="$HOME/Audio"\n');

		assert.equal(loadSettings(ctx()).settings.libraryRoot, join(home, "Audio"));
	});

	it("parses $HOME in user-dirs.dirs and rejects a disabled entry", () => {
		// Pure, so it is stated in the POSIX flavour the file itself is written in, on every host — including the
		// entry that has no `$HOME` to substitute, which would otherwise still carry the fixture's host flavour.
		assert.equal(musicDirFromUserDirs('XDG_MUSIC_DIR="$HOME/Music"\n', "/home/kike"), "/home/kike/Music");
		assert.equal(musicDirFromUserDirs('XDG_MUSIC_DIR="$HOME/"\n', "/home/kike"), undefined);
		assert.equal(musicDirFromUserDirs("# nothing here\n", "/home/kike"), undefined);
	});
});

describe("shortcut edits (S22)", () => {
	// The vocabulary is the host's, injected by the adapter: `lib/settings.ts` must not import a host
	// package (S8), so the pure layer receives the names instead of knowing them.
	const KNOWN = ["a", "j", "k", "m", "n", "p", "z", "space"];
	const base: Settings = { ...DEFAULT_SETTINGS, libraryRoot: "/music" };

	function errorOf(assignments: readonly string[]): string {
		const result = editShortcuts(base, assignments, KNOWN);
		assert.equal(result.ok, false, `expected ${assignments.join(" ")} to be refused`);
		return result.ok === false ? result.error : "";
	}

	it("applies several pairs and says what changed", () => {
		const result = editShortcuts(base, ["overlay=ctrl+alt+m", "next=alt+ctrl+k"], KNOWN);

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.settings.shortcuts, {
			...DEFAULT_SETTINGS.shortcuts,
			overlay: "ctrl+alt+m",
			next: "alt+ctrl+k",
		});
		assert.deepEqual(result.changes, [
			{ key: "overlay", from: "ctrl+alt+z", to: "ctrl+alt+m" },
			{ key: "next", from: "ctrl+alt+n", to: "alt+ctrl+k" },
		]);
		assert.equal(result.settings.libraryRoot, "/music", "only the shortcuts are touched");
	});

	it("refuses a bare key, which would take that key away from the editor", () => {
		const error = errorOf(["overlay=j"]);

		assert.match(error, /overlay=j/);
		assert.match(error, /modifier/);
	});

	it("refuses two keys that would become the same, including the overlay key", () => {
		// `alt+ctrl+n` is the same key as `ctrl+alt+n` for the host: the comparison is by identity.
		assert.match(errorOf(["playPause=ctrl+alt+n"]), /playPause and next would both be ctrl\+alt\+n/);
		assert.match(errorOf(["overlay=ctrl+alt+space"]), /overlay and playPause/);
		assert.match(errorOf(["prev=alt+ctrl+z"]), /overlay and prev/);
	});

	it("normalizes a shortcut the settings file carried, because the loader does not validate it", () => {
		// `loadSettings` keeps any non-empty string a file holds instead of rewriting it (L19): a broken file
		// is reported and left alone. So a repeated modifier can arrive from disk, and for the host
		// `ctrl+ctrl+n` IS `ctrl+n`. Without the de-duplication inside `identityOf` these two would look
		// like different keys and the pair would be accepted as two distinct shortcuts.
		// This is the test that keeps that guard alive: delete the `Set` and this fails, nothing else does.
		const fromDisk: Settings = {
			...base,
			shortcuts: { ...base.shortcuts, next: "ctrl+ctrl+n", prev: "ctrl+n" },
		};

		const result = editShortcuts(fromDisk, ["overlay=ctrl+alt+m"], KNOWN);

		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /next and prev would both be/);
	});

	it("refuses a name that is not one of the four and lists the ones it knows", () => {
		const error = errorOf(["volume=ctrl+alt+v"]);

		assert.match(error, /"volume" is not a shortcut name/);
		assert.match(error, /overlay, playPause, next, prev/);
	});

	it("refuses a key name the host cannot produce and lists the valid ones", () => {
		const error = errorOf(["overlay=ctrl+alt+f13"]);

		assert.match(error, /"f13" is not a key Pi can produce/);
		assert.match(error, /valid names/);
		assert.match(error, /a–z/, "the letters are named as a range, not eighty times");
		assert.match(error, /space/);
		// The unknown key is named before the missing modifier: `f13` is not a key at all, and a message
		// about modifiers would send the user to fix the wrong half of the value.
		assert.match(errorOf(["overlay=f13"]), /"f13" is not a key Pi can produce/);
	});

	it("refuses an unusable value: a repeated modifier, an unknown one, or no key at all", () => {
		assert.match(errorOf(["overlay=ctrl+ctrl+z"]), /repeats a modifier/);
		assert.match(errorOf(["overlay=hyper+z"]), /"hyper" is not a modifier/);
		assert.match(errorOf(["overlay=ctrl+alt+"]), /no key/);
		assert.match(errorOf(["overlay="]), /empty/);
	});

	it("restores the documented default with =default", () => {
		const custom: Settings = { ...base, shortcuts: { ...base.shortcuts, overlay: "ctrl+alt+m" } };
		const result = editShortcuts(custom, ["overlay=default"], KNOWN);

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.settings.shortcuts.overlay, DEFAULT_SETTINGS.shortcuts.overlay);
		assert.deepEqual(result.changes, [{ key: "overlay", from: "ctrl+alt+m", to: DEFAULT_SETTINGS.shortcuts.overlay }]);
	});

	it("changes nothing when one pair of several is refused", () => {
		const result = editShortcuts(base, ["overlay=ctrl+alt+m", "next=j"], KNOWN);

		assert.equal(result.ok, false);
		// No settings come back at all: the caller has nothing it could write by mistake.
		assert.equal("settings" in result, false);
		assert.match(result.ok === false ? result.error : "", /^"next=j"/);
	});

	it("reads without writing: no assignments mean no changes and no write", () => {
		const result = editShortcuts(base, [], KNOWN);

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.changes, []);
		assert.deepEqual(result.settings, base);
		assert.equal(readdirSync(root).includes("config"), false, "reading touched no directory");
	});

	it("writes the saved file atomically, and reports a failure instead of throwing", () => {
		const next: Settings = { ...base, shortcuts: { ...base.shortcuts, overlay: "ctrl+alt+m" } };

		assert.deepEqual(saveSettings(ctx(), next), { ok: true });
		assert.deepEqual(JSON.parse(readFileSync(filePath(), "utf8")), next);
		// The mode is a promise only where the OS has POSIX permission bits to keep: win32 reports ACLs and
		// shows 0o666 for a file its owner created (L101).
		if (process.platform !== "win32") assert.equal(statSync(filePath()).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(join(configHome, "pi-streambeats")), ["settings.json"]);

		// A config directory that cannot be created: the caller gets data, never an exception.
		rmSync(join(configHome, "pi-streambeats"), { recursive: true, force: true });
		writeFileSync(join(configHome, "pi-streambeats"), "not a directory");
		const failed = saveSettings(ctx(), next);

		assert.equal(failed.ok, false);
		assert.match(failed.ok === false ? failed.error : "", /settings\.json/);
	});
});

describe("the mpv path (S6)", () => {
	// A binary outside PATH is a real Windows case (L15): the installer leaves mpv in Program Files and out of
	// PATH, so the settings key is the way the user points at it.
	it("defaults to empty, which means 'find it', never a bare command", () => {
		assert.equal(DEFAULT_SETTINGS.mpvPath, "");
	});

	it("reads the path a user set", () => {
		writeSettings(JSON.stringify({ mpvPath: "/opt/mpv/bin/mpv" }));

		assert.equal(loadSettings(ctx()).settings.mpvPath, "/opt/mpv/bin/mpv");
	});

	it("falls back to the default for a value that is not a path, and names the key it ignored", () => {
		writeSettings(JSON.stringify({ mpvPath: 42 }));

		const result = loadSettings(ctx());

		assert.equal(result.settings.mpvPath, "");
		assert.match(result.warning ?? "", /mpvPath/);
	});

	it("does not warn about the empty default it wrote itself", () => {
		// What a user does: start once, which writes the default file, and start again. The second start must
		// not report our own "not set" as something it ignored — that warning arrived in the Windows 11 VM
		// the first time the product ran the way a user runs it (L112).
		loadSettings(ctx());
		const again = loadSettings(ctx());

		assert.equal(again.settings.mpvPath, "");
		assert.equal(again.warning, undefined, `the file this module wrote must load cleanly, got: ${again.warning}`);
	});

	it("treats a value made only of spaces as not set, without calling it ignored", () => {
		writeSettings(JSON.stringify({ mpvPath: "   " }));

		const result = loadSettings(ctx());

		assert.equal(result.settings.mpvPath, "");
		assert.equal(result.warning, undefined);
	});

	it("writes the key into the file it creates, so it is discoverable without the docs", () => {
		loadSettings(ctx());

		assert.equal(JSON.parse(readFileSync(filePath(), "utf8")).mpvPath, "");
	});
});

describe("broken files fail soft (S2)", () => {
	it("returns defaults plus a warning on malformed JSON and does not overwrite the file", () => {
		writeSettings("{ this is not json");

		const result = loadSettings(ctx());

		assert.deepEqual(result.settings, { ...DEFAULT_SETTINGS, libraryRoot: join(home, "Music") });
		assert.ok(result.warning, "a malformed file must warn");
		assert.equal(result.wroteDefaults, false);
		assert.equal(readFileSync(filePath(), "utf8"), "{ this is not json");
	});

	it("keeps the values it can read and defaults a value of the wrong type", () => {
		writeSettings(JSON.stringify({ libraryRoot: 42, asciiGlyphs: true, colour: "purple" }));

		const result = loadSettings(ctx());

		assert.equal(result.settings.libraryRoot, join(home, "Music"));
		assert.equal(result.settings.asciiGlyphs, true);
		assert.ok(result.warning, "a rejected value must warn");
		assert.equal("colour" in result.settings, false, "unknown keys are ignored");
	});

	it("keeps a user's own shortcuts and fills the rest from defaults", () => {
		writeSettings(JSON.stringify({ shortcuts: { overlay: "F2" } }));

		const result = loadSettings(ctx());

		assert.deepEqual(result.settings.shortcuts, { ...DEFAULT_SETTINGS.shortcuts, overlay: "F2" });
		assert.equal(result.warning, undefined);
	});

	it("treats a JSON array as malformed instead of reading it as an object", () => {
		const merged = mergeSettings([], { ...DEFAULT_SETTINGS, libraryRoot: "/music" });

		assert.equal(merged.settings.libraryRoot, "/music");
		assert.ok(merged.problem);
	});
});
