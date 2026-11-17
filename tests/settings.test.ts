/**
 * Settings contract (S2, S10, S19). One test per rule the spec names: defaults when the file is
 * missing, the permission and atomicity of what we write, and the two ways a broken file must fail
 * soft instead of crashing. Every test runs against a temporary directory: never the user's config.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	DEFAULT_SETTINGS,
	editShortcuts,
	loadSettings,
	mergeSettings,
	musicDirFromUserDirs,
	type Settings,
	saveSettings,
	settingsPath,
} from "../lib/settings.ts";

let root: string;
let home: string;
let configHome: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sb-settings-"));
	home = join(root, "home");
	configHome = join(root, "config");
	mkdirSync(home, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function ctx(overrides: Record<string, unknown> = {}) {
	return { platform: "linux" as const, env: { XDG_CONFIG_HOME: configHome }, home, ...overrides };
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
		assert.equal(settingsPath(ctx()), filePath());
		assert.equal(settingsPath(ctx({ platform: "darwin" })), filePath());
	});

	it("falls back to ~/.config when XDG_CONFIG_HOME is relative or missing", () => {
		const expected = join(home, ".config", "pi-streambeats", "settings.json");
		assert.equal(settingsPath(ctx({ env: {} })), expected);
		assert.equal(settingsPath(ctx({ env: { XDG_CONFIG_HOME: "" } })), expected);
		assert.equal(settingsPath(ctx({ env: { XDG_CONFIG_HOME: "relative/dir" } })), expected);
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

	it("creates the config directory 0750 and the file 0600", () => {
		loadSettings(ctx());

		assert.equal(statSync(join(configHome, "pi-streambeats")).mode & 0o777, 0o750);
		assert.equal(statSync(filePath()).mode & 0o777, 0o600);
	});

	it("leaves no temporary file behind after the atomic write", () => {
		loadSettings(ctx());

		assert.deepEqual(readdirSync(join(configHome, "pi-streambeats")), ["settings.json"]);
	});

	it("reads the music directory from user-dirs.dirs", () => {
		mkdirSync(configHome, { recursive: true });
		writeFileSync(join(configHome, "user-dirs.dirs"), 'XDG_MUSIC_DIR="$HOME/Audio"\n');

		assert.equal(loadSettings(ctx()).settings.libraryRoot, join(home, "Audio"));
	});

	it("parses $HOME in user-dirs.dirs and rejects a disabled entry", () => {
		assert.equal(musicDirFromUserDirs('XDG_MUSIC_DIR="$HOME/Music"\n', home), join(home, "Music"));
		assert.equal(musicDirFromUserDirs('XDG_MUSIC_DIR="$HOME/"\n', home), undefined);
		assert.equal(musicDirFromUserDirs("# nothing here\n", home), undefined);
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
		assert.equal(statSync(filePath()).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(join(configHome, "pi-streambeats")), ["settings.json"]);

		// A config directory that cannot be created: the caller gets data, never an exception.
		rmSync(join(configHome, "pi-streambeats"), { recursive: true, force: true });
		writeFileSync(join(configHome, "pi-streambeats"), "not a directory");
		const failed = saveSettings(ctx(), next);

		assert.equal(failed.ok, false);
		assert.match(failed.ok === false ? failed.error : "", /settings\.json/);
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
