/**
 * Settings (S2, S10, S19). This module is one of the four I/O owners: it reads and writes exactly
 * one file, in the user's config directory, and it never throws at its caller.
 *
 * The two rules that shape everything below are about failure: a missing file produces working
 * defaults, and a broken file produces defaults plus a warning. Neither may crash `/sb-music`,
 * and a broken file is left on disk untouched instead of being silently rewritten — the user is
 * probably looking at it when it breaks.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { posix, win32 } from "node:path";

/** The three platforms the extension promises (S19). Every path function takes it as a parameter. */
export type Platform = "linux" | "darwin" | "win32";

/** Everything a path depends on, passed in instead of read from the ambient process (S19, S10). */
export interface SettingsContext {
	readonly platform: Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly home: string;
}

export interface Shortcuts {
	readonly overlay: string;
	readonly playPause: string;
	readonly next: string;
	readonly prev: string;
}

export interface Settings {
	/** Absolute path of the music library (S14). The only value without a constant default. */
	readonly libraryRoot: string;
	/**
	 * An absolute path to the mpv binary (S6). Empty or absent means "find it": PATH first, then the places
	 * each platform's installer really uses. A value here wins over both, because it is the user's own answer.
	 * Optional because a file written before this key existed has no field for it, and "absent" and "empty"
	 * must both mean the same thing rather than becoming two defaults.
	 */
	readonly mpvPath?: string;
	readonly shortcuts: Shortcuts;
	/** Swaps the geometric glyph family for ASCII on terminals where the former is double width (S16). */
	readonly asciiGlyphs: boolean;
}

/** The constant half of the defaults. `libraryRoot` is derived per user, so it is not here (S14). */
export const DEFAULT_SETTINGS: Omit<Settings, "libraryRoot"> = {
	mpvPath: "",
	shortcuts: {
		overlay: "ctrl+alt+z",
		playPause: "ctrl+alt+space",
		next: "ctrl+alt+n",
		prev: "ctrl+alt+p",
	},
	asciiGlyphs: false,
};

/** The four shortcut names, in the order the file and the `--keys` table present them (S2, S22). */
export const SHORTCUT_NAMES = ["overlay", "playPause", "next", "prev"] as const;

export type ShortcutName = (typeof SHORTCUT_NAMES)[number];

export interface SettingsLoad {
	readonly settings: Settings;
	/** A human-readable reason why the file could not be used verbatim (S2). */
	readonly warning?: string;
	/** True only when the file was missing and the defaults were written to disk. */
	readonly wroteDefaults: boolean;
}

function pathFor(platform: Platform) {
	return platform === "win32" ? win32 : posix;
}

/**
 * The XDG config directory: `$XDG_CONFIG_HOME` when it is absolute, `~/.config` otherwise;
 * `%APPDATA%` on Windows. The XDG spec ignores a relative base, and so do we.
 */
function configHome(ctx: SettingsContext): string {
	const path = pathFor(ctx.platform);
	if (ctx.platform === "win32") {
		const appData = ctx.env.APPDATA?.trim();
		if (appData) return appData;
		return path.join(ctx.home, "AppData", "Roaming");
	}
	const xdg = ctx.env.XDG_CONFIG_HOME?.trim();
	if (xdg && path.isAbsolute(xdg)) return xdg;
	return path.join(ctx.home, ".config");
}

/** The extension's own directory inside the config home. */
export function configDir(ctx: SettingsContext): string {
	return pathFor(ctx.platform).join(configHome(ctx), "pi-streambeats");
}

export function settingsPath(ctx: SettingsContext): string {
	return pathFor(ctx.platform).join(configDir(ctx), "settings.json");
}

/**
 * `XDG_MUSIC_DIR` from a `user-dirs.dirs` file (S14). Pure: the file's content and the home
 * directory come in as arguments. A disabled entry (`"$HOME/"`) is a missing default, not a path.
 */
export function musicDirFromUserDirs(content: string, home: string): string | undefined {
	const match = /^\s*XDG_MUSIC_DIR\s*=\s*"(.*)"\s*$/m.exec(content);
	const raw = match?.[1];
	if (!raw) return undefined;
	const expanded = raw.replace(/^\$\{?HOME\}?/, home).replace(/[\\/]+$/, "");
	if (!expanded || expanded === home) return undefined;
	return expanded;
}

/** The default library root: the XDG music directory, falling back to `~/Music` (S14). */
function musicDir(ctx: SettingsContext): string {
	if (ctx.platform !== "win32") {
		try {
			const content = readFileSync(pathFor(ctx.platform).join(configHome(ctx), "user-dirs.dirs"), "utf8");
			const parsed = musicDirFromUserDirs(content, ctx.home);
			if (parsed) return parsed;
		} catch {
			// No user-dirs.dirs, or it is unreadable: the fallback below is the answer, not an error.
		}
	}
	return pathFor(ctx.platform).join(ctx.home, "Music");
}

/** The settings in effect when no usable file exists. */
export function defaultSettings(ctx: SettingsContext): Settings {
	return { libraryRoot: musicDir(ctx), ...DEFAULT_SETTINGS };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Merge a parsed file into the defaults (S2). Valid values win, unusable ones fall back to their
 * default, unknown keys are ignored, and every rejected value is named in `problem` so the caller
 * can warn about it instead of guessing.
 */
export function mergeSettings(raw: unknown, defaults: Settings): { settings: Settings; problem?: string } {
	if (!isRecord(raw)) return { settings: defaults, problem: "must contain a JSON object" };

	const ignored: string[] = [];

	const root = text(raw.libraryRoot);
	if (!root && raw.libraryRoot !== undefined) ignored.push("libraryRoot");
	const libraryRoot = root ?? defaults.libraryRoot;

	// An empty string is "not set", not "ignored" — and it is the value this module writes as its own default, so
	// reporting it warned about our own file on every start after the first (L112). A value of another type is still
	// named, because that user did type something. `libraryRoot` keeps the stricter rule: its default is never
	// empty, so an empty one was written by hand and is worth saying out loud.
	const mpvPath = text(raw.mpvPath);
	if (raw.mpvPath !== undefined && typeof raw.mpvPath !== "string") ignored.push("mpvPath");

	let asciiGlyphs = defaults.asciiGlyphs;
	if (typeof raw.asciiGlyphs === "boolean") asciiGlyphs = raw.asciiGlyphs;
	else if (raw.asciiGlyphs !== undefined) ignored.push("asciiGlyphs");

	const shortcuts: Record<string, string> = { ...defaults.shortcuts };
	const rawShortcuts = raw.shortcuts;
	if (rawShortcuts !== undefined) {
		if (isRecord(rawShortcuts)) {
			for (const key of Object.keys(defaults.shortcuts)) {
				const value = text(rawShortcuts[key]);
				if (value) shortcuts[key] = value;
				else if (rawShortcuts[key] !== undefined) ignored.push(`shortcuts.${key}`);
			}
		} else {
			ignored.push("shortcuts");
		}
	}

	const settings: Settings = {
		libraryRoot,
		mpvPath: mpvPath ?? defaults.mpvPath,
		shortcuts: shortcuts as unknown as Shortcuts,
		asciiGlyphs,
	};
	return ignored.length > 0 ? { settings, problem: `ignored ${ignored.join(", ")}` } : { settings };
}

/** Write the file atomically: same directory, `0600`, `0750` directory, tmp + rename (S2). */
function writeSettings(ctx: SettingsContext, settings: Settings): void {
	const dir = configDir(ctx);
	mkdirSync(dir, { recursive: true, mode: 0o750 });
	const temp = pathFor(ctx.platform).join(dir, `settings.json.${process.pid}.tmp`);
	writeFileSync(temp, `${JSON.stringify(settings, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temp, settingsPath(ctx));
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Read the settings, never throwing. A missing file is written once with the defaults so the user
 * has something to edit; a file we cannot read or parse yields the defaults and a warning.
 */
export function loadSettings(ctx: SettingsContext): SettingsLoad {
	const defaults = defaultSettings(ctx);
	const path = settingsPath(ctx);

	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return {
				settings: defaults,
				wroteDefaults: false,
				warning: `cannot read ${path}: ${reasonOf(error)}`,
			};
		}
		try {
			writeSettings(ctx, defaults);
			return { settings: defaults, wroteDefaults: true };
		} catch (writeError) {
			return {
				settings: defaults,
				wroteDefaults: false,
				warning: `cannot write ${path}: ${reasonOf(writeError)}`,
			};
		}
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			settings: defaults,
			wroteDefaults: false,
			warning: `${path} is not valid JSON, using defaults: ${reasonOf(error)}`,
		};
	}

	const { settings, problem } = mergeSettings(parsed, defaults);
	return problem
		? { settings, wroteDefaults: false, warning: `${path}: ${problem}` }
		: { settings, wroteDefaults: false };
}

/** The result of a write the user asked for (S22): a failure is data, never a throw. */
export type SaveResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Write `settings.json` atomically (S2): the one way `/sb-music --keys` saves (S22). */
export function saveSettings(ctx: SettingsContext, settings: Settings): SaveResult {
	try {
		writeSettings(ctx, settings);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: `${settingsPath(ctx)}: ${reasonOf(error)}` };
	}
}

/* --- shortcut edits (S22) ----------------------------------------------------------------------- */

/** The modifiers this project accepts. `super` is valid for the host and is not promised here (S22). */
const MODIFIERS: readonly string[] = ["ctrl", "shift", "alt"];

/** One shortcut a set of assignments would change, and what it was before. */
export interface ShortcutChange {
	readonly key: ShortcutName;
	readonly from: string;
	readonly to: string;
}

/**
 * The outcome of `/sb-music --keys name=value ...` as data. A refusal carries no settings at all, so a
 * caller cannot write half an edit by mistake: that is what makes several pairs atomic (S22).
 */
export type ShortcutEdit =
	| { readonly ok: true; readonly settings: Settings; readonly changes: readonly ShortcutChange[] }
	| { readonly ok: false; readonly error: string };

type ValueCheck = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * The valid base keys, grouped for a message a human reads instead of a list of eighty names. It is
 * derived from the vocabulary it is given, so the adapter stays the only owner of what Pi can produce.
 */
function describeKeys(knownKeys: readonly string[]): string {
	const isFunction = (key: string) => /^f(?:[1-9]|1[0-2])$/.test(key);
	const functions = knownKeys.filter(isFunction);
	const named = knownKeys.filter((key) => key.length > 1 && !isFunction(key));
	const symbols = knownKeys.filter((key) => key.length === 1 && !/[a-z0-9]/.test(key));
	const groups = [
		knownKeys.some((key) => /^[a-z]$/.test(key)) ? "a–z" : "",
		knownKeys.some((key) => /^[0-9]$/.test(key)) ? "0–9" : "",
		functions.length > 0 ? "f1–f12" : "",
		named.join(", "),
		symbols.join(" "),
	];
	return groups.filter((group) => group !== "").join(" · ");
}

/**
 * The value grammar (S22): `modifier+…+key`, at least one modifier, none repeated, all lowercase. It
 * is a grammar of our own and not the host's parser — `@earendil-works/pi-tui` exports no way to
 * validate a key id string — but the base-key vocabulary is the host's own and arrives as a parameter,
 * because only `lib/host/` may import a host package (S8).
 */
function checkValue(value: string, knownKeys: readonly string[]): ValueCheck {
	const trimmed = value.trim();
	if (trimmed === "") return { ok: false, error: "it is empty" };

	const parts = trimmed.split("+");
	const key = parts.at(-1) ?? "";
	const modifiers = parts.slice(0, -1);

	if (key === "") return { ok: false, error: `"${trimmed}" has modifiers and no key` };
	// The vocabulary comes before the modifier rule: telling the user `f13` "has no modifier" would send
	// them to fix the wrong half of the value.
	if (!knownKeys.includes(key)) {
		return {
			ok: false,
			error: `"${key}" is not a key Pi can produce; valid names: ${describeKeys(knownKeys)}`,
		};
	}
	if (modifiers.length === 0) {
		return { ok: false, error: `"${trimmed}" has no modifier: a bare key would take that key away from the editor` };
	}
	for (const modifier of modifiers) {
		if (!MODIFIERS.includes(modifier)) {
			return { ok: false, error: `"${modifier}" is not a modifier; use ${MODIFIERS.join(", ")}` };
		}
	}
	if (new Set(modifiers).size !== modifiers.length) return { ok: false, error: `"${trimmed}" repeats a modifier` };
	return { ok: true };
}

/**
 * What makes two values THE SAME key for the host: modifier order does not matter, nor does the case
 * of what the user typed, so `alt+ctrl+n` collides with `ctrl+alt+n` (S22, no duplicates).
 */
function identityOf(value: string): string {
	const parts = value.trim().toLowerCase().split("+");
	const key = parts.at(-1) ?? "";
	const modifiers = [...new Set(parts.slice(0, -1))].sort();
	return [...modifiers, key].join("+");
}

/**
 * Edit the four shortcuts as one pure step (S22): `settings` in, the would-be `settings` or an error
 * out, plus what changed. Every rule the command enforces lives here, so it is testable without a
 * terminal: the names must exist, the values must be producible, nothing may collide, at least one
 * modifier is required, and `=default` restores the documented default.
 */
export function editShortcuts(
	settings: Settings,
	assignments: readonly string[],
	knownKeys: readonly string[],
): ShortcutEdit {
	const working: Record<string, string> = { ...settings.shortcuts };

	for (const assignment of assignments) {
		const at = assignment.indexOf("=");
		if (at === -1) {
			return {
				ok: false,
				error: `"${assignment}" is not name=value; names are ${SHORTCUT_NAMES.join(", ")}`,
			};
		}

		const name = assignment.slice(0, at).trim();
		const raw = assignment.slice(at + 1).trim();
		if (!SHORTCUT_NAMES.includes(name as ShortcutName)) {
			return {
				ok: false,
				error: `"${name}" is not a shortcut name; names are ${SHORTCUT_NAMES.join(", ")}`,
			};
		}
		const shortcut = name as ShortcutName;
		const value = raw === "default" ? DEFAULT_SETTINGS.shortcuts[shortcut] : raw;
		const checked = checkValue(value, knownKeys);
		if (!checked.ok) return { ok: false, error: `"${assignment}": ${checked.error}` };
		working[shortcut] = value;
	}

	// Collisions are checked on the FINAL four values, so a pair can also collide with one nobody edited.
	const seen = new Map<string, ShortcutName>();
	for (const shortcut of SHORTCUT_NAMES) {
		const value = working[shortcut] ?? "";
		const identity = identityOf(value);
		const other = seen.get(identity);
		if (other !== undefined) {
			return { ok: false, error: `${other} and ${shortcut} would both be ${value}` };
		}
		seen.set(identity, shortcut);
	}

	const changes: ShortcutChange[] = [];
	for (const shortcut of SHORTCUT_NAMES) {
		const from = settings.shortcuts[shortcut];
		const to = working[shortcut] ?? from;
		if (from !== to) changes.push({ key: shortcut, from, to });
	}

	return { ok: true, settings: { ...settings, shortcuts: working as unknown as Shortcuts }, changes };
}
