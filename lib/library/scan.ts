/**
 * Library scanning (S5, S14). One of the four I/O owners: it reads the current folder, one level
 * only, and it never writes anything inside the library.
 *
 * The module never throws at its caller. A folder that does not exist, one we cannot read and one
 * with nothing playable are all *data*: the card decides how to say it, this layer decides what is
 * true. Every name that leaves here has been neutralized (S5), and the path is left raw because it
 * is identity, not display.
 */
import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Folder, Track } from "../types.ts";
import { AUDIO_EXTENSIONS, isAudioFile, neutralizeName } from "./names.ts";

/** What the caller knows about the configured library (S2, S14), echoed in the no-audio state. */
export interface LibraryContext {
	/** The root the card starts at, from settings. */
	readonly libraryRoot: string;
	/** The settings file the root came from; the no-audio message names it. */
	readonly settingsPath: string;
}

/**
 * One row of the list. A folder can be entered, a track can be played; the two never share a shape,
 * so the card cannot confuse them.
 */
export type LibraryEntry =
	| { readonly kind: "folder"; readonly folder: Folder }
	| { readonly kind: "track"; readonly track: Track };

/** Why the current folder cannot be shown at all (S5). Both carry the path the user asked for. */
export type ScanFailure =
	/** The path does not exist, or it is a file rather than a folder. */
	| { readonly kind: "missing"; readonly path: string }
	/** The path exists but the process may not read it. */
	| { readonly kind: "unreadable"; readonly path: string };

/**
 * A folder with nothing playable (S5): it says what is missing, where the user is, which root is
 * configured and which file that root came from. It accompanies the listing instead of replacing
 * it, so a folder that only holds subfolders can still be navigated.
 */
export interface NoAudio {
	readonly path: string;
	readonly libraryRoot: string;
	readonly settingsPath: string;
	readonly extensions: readonly string[];
}

export type ScanResult =
	| {
			readonly ok: true;
			/** Canonical path of the folder that was listed (S14). */
			readonly path: string;
			readonly entries: readonly LibraryEntry[];
			/** Present only when the folder has no audio at all. */
			readonly noAudio?: NoAudio;
	  }
	| { readonly ok: false; readonly path: string; readonly failure: ScanFailure };

/** Alphabetical for a human, deterministic for a test: fixed locale, no environment lookup. */
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function compareNames(left: string, right: string): number {
	const collated = collator.compare(left, right);
	if (collated !== 0) return collated;
	// A stable tie-break for names that differ only in case or in accents.
	return left < right ? -1 : left > right ? 1 : 0;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** `ENOENT`/`ENOTDIR` mean "nothing to list here"; everything else means "we are not allowed". */
function failureOf(error: unknown, path: string): ScanFailure {
	const code = errorCode(error);
	return { kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable", path };
}

/** Canonical form of a path, best effort: a folder we cannot resolve is kept as it was found. */
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Whether a path names a directory, following symlinks. A broken link answers false. */
function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** A symlink is listed as whatever it points at, so the entry is not skipped for being a link. */
function isFolder(dirent: Dirent, path: string): boolean {
	return dirent.isDirectory() || (dirent.isSymbolicLink() && isDirectory(path));
}

/**
 * List the current folder: direct children only, folders first, then audio files, each group
 * alphabetical (S5). Hidden entries are skipped, every name is neutralized, and no failure escapes
 * as an exception.
 */
export function scanFolder(dir: string, ctx: LibraryContext): ScanResult {
	let path: string;
	try {
		// Canonical first: a symlinked folder is listed under its real path, so `u` and the ceiling
		// both compare real paths and navigation cannot loop (S14).
		path = realpathSync(dir);
	} catch (error) {
		return { ok: false, path: dir, failure: failureOf(error, dir) };
	}

	let dirents: Dirent[];
	try {
		dirents = readdirSync(path, { withFileTypes: true });
	} catch (error) {
		return { ok: false, path, failure: failureOf(error, path) };
	}

	const folders: Folder[] = [];
	const tracks: Track[] = [];

	for (const dirent of dirents) {
		const name = dirent.name;
		// Hidden: dotfiles, .DS_Store and the macOS ._* twins (S5). The Go repo's issue #88 was a queue
		// poisoned by these; the rule is a prefix, so it needs no list of known offenders.
		if (name.startsWith(".")) continue;

		const full = join(path, name);
		const display = neutralizeName(name);

		if (isFolder(dirent, full)) {
			folders.push({ path: canonical(full), name: display });
			continue;
		}
		// Sockets, fifos and devices are neither enterable nor playable.
		if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
		if (!isAudioFile(name)) continue;
		// The track number prefix and the extension are removed later, by the now-playing formatter
		// (S12, T7): this layer has no business guessing what a file is called.
		tracks.push({ id: full, title: display, origin: "local" });
	}

	folders.sort((left, right) => compareNames(left.name, right.name));
	tracks.sort((left, right) => compareNames(left.title, right.title));

	const entries: LibraryEntry[] = [
		...folders.map((folder): LibraryEntry => ({ kind: "folder", folder })),
		...tracks.map((track): LibraryEntry => ({ kind: "track", track })),
	];

	if (tracks.length > 0) return { ok: true, path, entries };

	const noAudio: NoAudio = {
		path,
		libraryRoot: ctx.libraryRoot,
		settingsPath: ctx.settingsPath,
		extensions: AUDIO_EXTENSIONS,
	};
	return { ok: true, path, entries, noAudio };
}
