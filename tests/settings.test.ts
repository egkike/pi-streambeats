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
import { DEFAULT_SETTINGS, loadSettings, mergeSettings, musicDirFromUserDirs, settingsPath } from "../lib/settings.ts";

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
