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
	readonly shortcuts: Shortcuts;
	/** Swaps the geometric glyph family for ASCII on terminals where the former is double width (S16). */
	readonly asciiGlyphs: boolean;
}

/** The constant half of the defaults. `libraryRoot` is derived per user, so it is not here (S14). */
export const DEFAULT_SETTINGS: Omit<Settings, "libraryRoot"> = {
	shortcuts: {
		overlay: "ctrl+alt+z",
		playPause: "ctrl+alt+space",
		next: "ctrl+alt+n",
		prev: "ctrl+alt+p",
	},
	asciiGlyphs: false,
};

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
